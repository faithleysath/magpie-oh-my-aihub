// B1 transport cryptography.
//
// Only standard primitives from the runtime's own crypto module:
//
//   X25519            — ephemeral key agreement (RFC 7748)
//   HKDF-SHA256       — key separation (RFC 5869)
//   AES-256-GCM       — authenticated encryption (NIST SP 800-38D)
//   Ed25519           — identity signatures, through protocol.ts
//   SHA-256           — transcripts and content hashes
//
// There is no hand-written curve, no hand-written AEAD, no "custom" KDF and no
// long-term X25519 key. Session keys are 32-byte Buffers that exist only in
// memory; `wipe` overwrites them when a session closes. Nothing in this file
// touches the filesystem, the network or the plugin state, which is what makes
// the crypto testable without a second node.
//
// Deliberate non-goals: forward secrecy across a restart (there is none — a
// restart loses the ephemeral key and the peer must re-handshake; that is the
// documented failure mode, not a bug), post-compromise security, and
// deniability. This is a transport for a local-network overlay, not a
// messenger protocol.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { canonicalJson, sha256Hex } from "../catalog.ts";
import {
  fail,
  P2P_MAX_FRAME_BYTES,
  P2P_PROTOCOL,
  P2P_TYPE_BY_CODE,
  P2P_TYPE_CODES,
  type P2pAuthorizationDocument,
  type P2pMessageType,
  type P2pSealedAuthorization,
  authorizationHashOf,
  keyHashOf,
  validateAuthorizationDocument,
} from "./protocol.ts";

/** The wire magic. A frame without it is not ours and is dropped. */
const FRAME_MAGIC = Buffer.from("OMA1", "ascii");
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 4 + 1 + 1 + 8 + 16 + 2;
const GCM_TAG_BYTES = 16;
const GCM_NONCE_BYTES = 12;

export type P2pDirection = "c2s" | "s2c";

export interface EphemeralKeyPair {
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
  publicKeyBase64: string;
}

/** A fresh X25519 key pair for exactly one handshake. Never persisted. */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) fail("internal", "the runtime did not export the X25519 public key");
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) fail("internal", "the runtime exported a non-32-byte X25519 key");
  return { privateKey, publicKeyRaw: raw, publicKeyBase64: raw.toString("base64") };
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  // 302a300506032b656e032100 is the DER SPKI prefix for X25519.
  const prefix = Buffer.from("302a300506032b656e032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

/**
 * X25519 agreement with explicit low-order/identity rejection. OpenSSL already
 * refuses the known low-order points, but the check is repeated on the raw key
 * and on the result so the guarantee does not depend on an OpenSSL detail.
 */
export function x25519SharedSecret(privateKey: KeyObject, peerPublicBase64: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(peerPublicBase64, "base64");
  } catch {
    return fail("bad_identity", "the peer X25519 key is not base64");
  }
  if (raw.length !== 32) fail("bad_identity", "the peer X25519 key is not 32 bytes");
  if (isZero(raw)) fail("bad_identity", "the peer X25519 key is the identity point");
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(raw) });
  } catch {
    return fail("bad_identity", "the peer X25519 key is invalid or low order");
  }
  if (shared.length !== 32) fail("bad_identity", "the X25519 agreement returned a non-32-byte secret");
  if (isZero(shared)) fail("bad_identity", "the X25519 agreement produced an all-zero secret");
  return shared;
}

function isZero(buf: Buffer): boolean {
  let acc = 0;
  for (const byte of buf) acc |= byte;
  return acc === 0;
}

/** Overwrites a key Buffer. Best effort: JS strings/GC copies are out of reach. */
export function wipe(buffer: Buffer | undefined): void {
  if (buffer) buffer.fill(0);
}

export interface SessionKeys {
  /** consumer → provider */
  c2s: Buffer;
  /** provider → consumer */
  s2c: Buffer;
  /** separate key that seals an authorization inside the session */
  authorization: Buffer;
}

/**
 * HKDF-SHA256 with the handshake transcript as salt and a distinct `info` per
 * purpose. Three independent keys, never one key used for two jobs.
 */
export function deriveSessionKeys(sharedSecret: Buffer, transcriptHash: Buffer): SessionKeys {
  const info = (purpose: string) => Buffer.from(`${P2P_PROTOCOL}/${purpose}`, "utf8");
  const c2s = Buffer.from(hkdfSync("sha256", sharedSecret, transcriptHash, info("c2s"), 32));
  const s2c = Buffer.from(hkdfSync("sha256", sharedSecret, transcriptHash, info("s2c"), 32));
  const authorization = Buffer.from(hkdfSync("sha256", sharedSecret, transcriptHash, info("authorization-seal"), 32));
  if (c2s.length !== 32 || s2c.length !== 32 || authorization.length !== 32) fail("internal", "HKDF returned a short key");
  if (c2s.equals(s2c) || c2s.equals(authorization) || s2c.equals(authorization)) fail("internal", "HKDF output was not domain separated");
  return { c2s, s2c, authorization };
}

export function sendKey(keys: SessionKeys, role: "consumer" | "provider"): Buffer {
  return role === "consumer" ? keys.c2s : keys.s2c;
}

export function receiveKey(keys: SessionKeys, role: "consumer" | "provider"): Buffer {
  return role === "consumer" ? keys.s2c : keys.c2s;
}

/** SHA-256 over a canonical JSON transcript (the exact value used as HKDF salt). */
export function transcriptHash(transcript: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(transcript), "utf8").digest();
}

export function frameAad(input: { sessionId: string; direction: P2pDirection; seq: number; msgId: string; type: P2pMessageType }): Buffer {
  return Buffer.from(
    canonicalJson({
      domain: "ohmyaihub/p2p/frame/v1",
      protocol: P2P_PROTOCOL,
      sessionId: input.sessionId,
      direction: input.direction,
      seq: input.seq,
      msgId: input.msgId,
      type: input.type,
    }),
    "utf8",
  );
}

function frameNonce(seq: number): Buffer {
  if (!Number.isSafeInteger(seq) || seq < 1) fail("malformed", "the frame sequence must be a positive safe integer");
  const nonce = Buffer.alloc(GCM_NONCE_BYTES);
  nonce.writeUInt32BE(0, 0);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

export interface SealedFrame {
  ciphertext: Buffer;
}

/** AES-256-GCM seal. The tag is appended to the ciphertext. */
export function sealFrame(key: Buffer, input: { sessionId: string; direction: P2pDirection; seq: number; msgId: string; type: P2pMessageType; plaintext: Buffer }): SealedFrame {
  if (key.length !== 32) fail("internal", "an AES-256 key is 32 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, frameNonce(input.seq), { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(frameAad(input));
  const body = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

/** AES-256-GCM open. Any authentication failure is a hard rejection. */
export function openFrame(key: Buffer, input: { sessionId: string; direction: P2pDirection; seq: number; msgId: string; type: P2pMessageType; ciphertext: Buffer }): Buffer {
  if (key.length !== 32) fail("internal", "an AES-256 key is 32 bytes");
  if (input.ciphertext.length < GCM_TAG_BYTES) fail("bad_ciphertext", "the frame is too short to carry a GCM tag");
  const body = input.ciphertext.subarray(0, input.ciphertext.length - GCM_TAG_BYTES);
  const tag = input.ciphertext.subarray(input.ciphertext.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, frameNonce(input.seq), { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(frameAad(input));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return fail("bad_ciphertext", "the frame did not authenticate");
  }
}

export interface P2pFrame {
  type: P2pMessageType;
  seq: number;
  /** 16-byte message id, the same id the envelope carries */
  msgId: Buffer;
  ciphertext: Buffer;
}

/** Binary wire frame: magic|version|type|seq|msgId|cipherLen|ciphertext. */
export function encodeFrame(frame: P2pFrame): Buffer {
  if (frame.ciphertext.length > P2P_MAX_FRAME_BYTES - FRAME_HEADER_BYTES) fail("oversize", "the frame payload is too large");
  if (frame.msgId.length !== 16) fail("malformed", "a frame message id is 16 bytes");
  const code = P2P_TYPE_CODES[frame.type];
  if (!code) fail("unsupported_type", "the frame type is not in the allow-list");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt8(FRAME_VERSION, 4);
  header.writeUInt8(code, 5);
  header.writeBigUInt64BE(BigInt(frame.seq), 6);
  frame.msgId.copy(header, 14);
  header.writeUInt16BE(frame.ciphertext.length, 30);
  return Buffer.concat([header, frame.ciphertext]);
}

export function decodeFrame(raw: Buffer, maxBytes = P2P_MAX_FRAME_BYTES): P2pFrame {
  if (raw.length > maxBytes) fail("oversize", "the frame exceeds the maximum size");
  if (raw.length < FRAME_HEADER_BYTES) fail("malformed", "the frame is shorter than its header");
  if (!raw.subarray(0, 4).equals(FRAME_MAGIC)) fail("malformed", "the frame magic is not OMA1");
  if (raw.readUInt8(4) !== FRAME_VERSION) fail("unsupported_version", "the frame version is not 1");
  const type = P2P_TYPE_BY_CODE[raw.readUInt8(5)];
  if (!type) fail("unsupported_type", "the frame type is not in the allow-list");
  const seqBig = raw.readBigUInt64BE(6);
  if (seqBig > BigInt(Number.MAX_SAFE_INTEGER)) fail("malformed", "the frame sequence is out of range");
  const seq = Number(seqBig);
  if (seq < 1) fail("malformed", "the frame sequence must start at 1");
  const msgId = Buffer.from(raw.subarray(14, 30));
  const length = raw.readUInt16BE(30);
  if (length !== raw.length - FRAME_HEADER_BYTES) fail("malformed", "the frame length does not match its header");
  if (length < GCM_TAG_BYTES) fail("malformed", "the frame carries no GCM tag");
  return { type, seq, msgId, ciphertext: Buffer.from(raw.subarray(FRAME_HEADER_BYTES)) };
}

// --- authorization sealing ---------------------------------------------------

export interface AuthorizationSealContext {
  sessionId: string;
  approvalId: string;
  requestHash: string;
  authorizationHash: string;
  /** the consumer fingerprint the seal is addressed to */
  recipientFingerprint: string;
}

function authorizationAad(ctx: AuthorizationSealContext): Buffer {
  return Buffer.from(
    canonicalJson({
      domain: "ohmyaihub/p2p/authorization-seal/v1",
      protocol: P2P_PROTOCOL,
      sessionId: ctx.sessionId,
      approvalId: ctx.approvalId,
      requestHash: ctx.requestHash,
      authorizationHash: ctx.authorizationHash,
      recipientFingerprint: ctx.recipientFingerprint,
    }),
    "utf8",
  );
}

/**
 * Seals the authorization document to the session's `authorization` key. The
 * AAD pins session, approval, request, authorization hash and recipient, so a
 * sealed blob cannot be moved to another approval or replayed at another peer.
 */
export function sealAuthorization(key: Buffer, ctx: AuthorizationSealContext, document: P2pAuthorizationDocument): P2pSealedAuthorization {
  if (key.length !== 32) fail("internal", "the authorization key is 32 bytes");
  const plaintext = Buffer.from(
    canonicalJson({
      schema: document.schema,
      createdAt: document.createdAt,
      provider: document.provider,
      consumer: document.consumer,
      approvalId: document.approvalId,
      requestHash: document.requestHash,
      models: document.models,
      capUsd: document.capUsd,
      quote: document.quote,
      keyId: document.keyId,
      keyName: document.keyName,
      keyHash: document.keyHash,
      key: document.key,
    }),
    "utf8",
  );
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(authorizationAad(ctx));
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  plaintext.fill(0);
  if (sealed.length > 6 * 1024) fail("oversize", "the sealed authorization exceeds 6 KiB");
  return { algorithm: "aes-256-gcm", keyDerivation: "hkdf-sha256", nonce: nonce.toString("base64"), ciphertext: sealed.toString("base64") };
}

export interface OpenedAuthorization {
  document: P2pAuthorizationDocument;
  authorizationHash: string;
}

/**
 * Opens and validates a sealed authorization. The caller passes the envelope's
 * claimed bindings; every one of them is checked against the decrypted document
 * and against the recipient's own identity. A failure means "do not import".
 */
export function openAuthorization(
  key: Buffer,
  ctx: AuthorizationSealContext,
  sealed: P2pSealedAuthorization,
  expected: { providerNodeId: string; consumerNodeId: string; consumerFingerprint: string },
): OpenedAuthorization {
  if (key.length !== 32) fail("internal", "the authorization key is 32 bytes");
  const nonce = Buffer.from(sealed.nonce, "base64");
  if (nonce.length !== GCM_NONCE_BYTES) fail("malformed", "the sealed nonce is not 12 bytes");
  const blob = Buffer.from(sealed.ciphertext, "base64");
  if (blob.length < GCM_TAG_BYTES) fail("malformed", "the sealed authorization is too short");
  const body = blob.subarray(0, blob.length - GCM_TAG_BYTES);
  const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(authorizationAad(ctx));
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return fail("bad_ciphertext", "the sealed authorization did not authenticate for this session");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    return fail("malformed", "the sealed authorization is not JSON");
  } finally {
    plaintext.fill(0);
  }
  const document = validateAuthorizationDocument(parsed);
  if (document.approvalId !== ctx.approvalId) fail("conflict", "the sealed authorization belongs to another approval");
  if (document.requestHash !== ctx.requestHash) fail("conflict", "the sealed authorization belongs to another request");
  if (document.consumer.nodeId !== expected.consumerNodeId) fail("target_mismatch", "the authorization is for another consumer node");
  if (document.consumer.fingerprint !== expected.consumerFingerprint) fail("stale_identity", "the authorization is for another consumer identity");
  if (document.consumer.fingerprint !== ctx.recipientFingerprint) fail("target_mismatch", "the authorization seal recipient does not match");
  if (document.provider.nodeId !== expected.providerNodeId) fail("target_mismatch", "the authorization names another provider");
  const hash = authorizationHashOf(
    {
      schema: document.schema,
      createdAt: document.createdAt,
      provider: document.provider,
      consumer: document.consumer,
      approvalId: document.approvalId,
      requestHash: document.requestHash,
      models: document.models,
      capUsd: document.capUsd,
      quote: document.quote,
      keyId: document.keyId,
      keyName: document.keyName,
      keyHash: document.keyHash,
    },
    document.keyHash,
  );
  if (hash !== ctx.authorizationHash) fail("conflict", "the authorization hash does not match the delivered metadata");
  if (keyHashOf(document.key) !== document.keyHash) fail("malformed", "the authorization key does not match its hash");
  return { document, authorizationHash: hash };
}

/** A stable hex digest of arbitrary bytes; used for tombstone keys. */
export function digestHex(value: Buffer | string): string {
  return sha256Hex(value);
}
