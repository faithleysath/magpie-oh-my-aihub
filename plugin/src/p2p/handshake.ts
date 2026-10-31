// The B1 handshake.
//
// One request/response pair, both signed with the Catalogue Ed25519 identity,
// carrying one ephemeral X25519 key each. The transcript of both hellos is
// hashed and used as the HKDF salt, so neither side can be tricked into
// deriving keys from a different conversation or a different target.
//
// Why an explicit handshake instead of "just encrypt with the catalogue key":
// an Ed25519 key cannot do Diffie-Hellman, reusing it as X25519 would be a
// cross-protocol footgun, and the ephemeral exchange gives the sealed
// authorization a recipient-bound key that a passive overlay member cannot
// derive. The identity key still authenticates *who* is on the other end; the
// ephemeral key only provides the session's confidentiality.

import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "../catalog.ts";
import {
  fail,
  isBase64Key32,
  isHex32,
  isIsoTimestamp,
  P2P_CLOCK_SKEW_MS,
  P2P_HANDSHAKE_MAX_BYTES,
  P2P_MAX_TTL_MS,
  P2P_PROTOCOL,
  P2P_VERSION,
  timeMs,
  validatePeerIdentity,
  type P2pAuth,
  type P2pPeerIdentity,
  type P2pTargetIdentity,
  type P2pMessageType,
} from "./protocol.ts";
import {
  deriveSessionKeys,
  generateEphemeralKeyPair,
  transcriptHash,
  wipe,
  x25519SharedSecret,
  type EphemeralKeyPair,
  type SessionKeys,
} from "./crypto.ts";
import {
  handshakeSigningValue,
  verifyHandshakeSignature,
  type P2pIdentity,
  type P2pLocalBinding,
} from "./identity.ts";

export const P2P_HELLO_TTL_MS = 2 * 60_000;
export const P2P_SESSION_TTL_MS = 10 * 60_000;

/** What a consumer believes about the provider it is addressing. */
export interface P2pHelloTarget extends P2pTargetIdentity {
  mappedCidr: string | null;
  controlPort: number | null;
  catalogQuoteHash: string | null;
}

interface HelloCommon {
  version: 1;
  protocol: typeof P2P_PROTOCOL;
  sessionId: string;
  from: P2pPeerIdentity;
  time: string;
  expires: string;
  auth: P2pAuth;
}

export interface P2pHello extends HelloCommon {
  kind: "hello";
  id: string;
  to: P2pHelloTarget;
  clientNonce: string;
  clientX25519: string;
}

export interface P2pServerHello extends HelloCommon {
  kind: "server_hello";
  id: string;
  to: P2pTargetIdentity;
  clientNonce: string;
  clientX25519: string;
  serverNonce: string;
  serverX25519: string;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

const NONCE_RE = /^[a-f0-9]{64}$/;

function assertWindow(time: string, expires: string, now: Date, maxTtl: number, where: string): void {
  const t = timeMs(time, `${where}.time`);
  const e = timeMs(expires, `${where}.expires`);
  if (e <= t) fail("malformed", `${where} expires before it was issued`);
  if (e - t > maxTtl) fail("malformed", `${where} has too long a lifetime`);
  const n = now.getTime();
  if (t - n > P2P_CLOCK_SKEW_MS) fail("clock_skew", `${where} is issued too far in the future`);
  if (n - e > P2P_CLOCK_SKEW_MS) fail("expired", `${where} has expired`);
}

function helloSize(value: unknown, where: string): void {
  const size = Buffer.byteLength(canonicalJson(value), "utf8");
  if (size > P2P_HANDSHAKE_MAX_BYTES) fail("oversize", `${where} exceeds ${P2P_HANDSHAKE_MAX_BYTES} bytes`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plainObject(value: unknown, where: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("malformed", `${where} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("malformed", `${where} has an unexpected field ${JSON.stringify(key)}`);
  }
}

function targetOf(raw: unknown, where: string): P2pHelloTarget {
  const o = plainObject(raw, where);
  keys(o, ["accountId", "nodeId", "fingerprint", "mappedCidr", "controlPort", "catalogQuoteHash"], where);
  if (!isHex32(o.nodeId) && typeof o.nodeId !== "string") fail("target_mismatch", `${where}.nodeId is invalid`);
  if (typeof o.nodeId !== "string" || !/^[a-f0-9]{8,64}$/.test(o.nodeId)) fail("target_mismatch", `${where}.nodeId is invalid`);
  if (typeof o.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(o.fingerprint)) fail("target_mismatch", `${where}.fingerprint is invalid`);
  if (o.accountId !== o.fingerprint) fail("target_mismatch", `${where}.accountId is not the target key fingerprint`);
  const mappedCidr = o.mappedCidr === null ? null : o.mappedCidr;
  if (mappedCidr !== null && (typeof mappedCidr !== "string" || !/^10\.66\.\d{1,3}\.\d{1,3}\/32$/.test(mappedCidr))) {
    fail("target_mismatch", `${where}.mappedCidr is not a mapped /32`);
  }
  const controlPort = o.controlPort;
  if (controlPort !== null && (typeof controlPort !== "number" || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535)) {
    fail("target_mismatch", `${where}.controlPort is not a port`);
  }
  const catalogQuoteHash = o.catalogQuoteHash;
  if (catalogQuoteHash !== null && (typeof catalogQuoteHash !== "string" || !/^[a-f0-9]{64}$/.test(catalogQuoteHash))) {
    fail("quote_mismatch", `${where}.catalogQuoteHash is not a 64-hex hash`);
  }
  return {
    accountId: o.fingerprint,
    nodeId: o.nodeId,
    fingerprint: o.fingerprint,
    mappedCidr,
    controlPort,
    catalogQuoteHash,
  };
}

export interface ClientHelloInput {
  identity: P2pIdentity;
  target: P2pHelloTarget;
  now: Date;
  ttlMs?: number;
  sessionId?: string;
  ephemeral?: EphemeralKeyPair;
}

export interface ClientHandshake {
  hello: P2pHello;
  ephemeral: EphemeralKeyPair;
  sessionId: string;
}

/**
 * Builds the consumer's hello. The ephemeral private key stays in this object
 * and is handed to `completeHandshake`; it is never serialised or persisted.
 */
export function buildClientHello(input: ClientHelloInput): ClientHandshake {
  const ttl = input.ttlMs ?? P2P_HELLO_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > P2P_HELLO_TTL_MS) fail("malformed", "the hello lifetime must be 1s-120s");
  const ephemeral = input.ephemeral ?? generateEphemeralKeyPair();
  const sessionId = input.sessionId ?? randomHex(16);
  if (!isHex32(sessionId)) fail("malformed", "the session id must be 32 hex characters");
  const now = input.now;
  const time = now.toISOString();
  const expires = new Date(now.getTime() + ttl).toISOString();
  const clientNonce = randomHex(32);
  const target = input.target;
  if (target.nodeId === input.identity.peer.nodeId) fail("target_mismatch", "a node cannot handshake with itself");
  const value: Omit<P2pHello, "auth"> = {
    version: P2P_VERSION,
    protocol: P2P_PROTOCOL,
    kind: "hello",
    id: randomHex(16),
    sessionId,
    from: input.identity.peer,
    to: target,
    time,
    expires,
    clientNonce,
    clientX25519: ephemeral.publicKeyBase64,
  };
  const hello: P2pHello = { ...value, auth: input.identity.signHandshake("hello", value) };
  helloSize(hello, "the client hello");
  return { hello, ephemeral, sessionId };
}

export interface ValidateClientHelloOptions {
  now: Date;
  local: { identity: P2pIdentity; binding: P2pLocalBinding };
}

/**
 * Provider side: authenticates the consumer hello and proves it was addressed to
 * *this* node, *this* key, *this* mapped address, *this* control port and *this*
 * published quote. That is what prevents the node from being used as a jump
 * host for a request aimed at a different provider.
 */
export function validateClientHello(raw: unknown, options: ValidateClientHelloOptions): P2pHello {
  helloSize(raw, "the client hello");
  const o = plainObject(raw, "hello");
  keys(o, ["version", "protocol", "kind", "id", "sessionId", "from", "to", "time", "expires", "clientNonce", "clientX25519", "auth"], "hello");
  if (o.version !== P2P_VERSION) fail("unsupported_version", `the hello version is not ${P2P_VERSION}`);
  if (o.protocol !== P2P_PROTOCOL) fail("malformed", "the hello protocol is not ohmyaihub/p2p/v1");
  if (o.kind !== "hello") fail("malformed", "the message is not a client hello");
  if (!isHex32(o.id) || !isHex32(o.sessionId)) fail("malformed", "the hello id/session id must be 32 hex characters");
  const from = validatePeerIdentity(o.from, "hello.from");
  const to = targetOf(o.to, "hello.to");
  if (from.nodeId === options.local.identity.peer.nodeId) fail("target_mismatch", "a node cannot handshake with itself");
  if (to.nodeId !== options.local.binding.nodeId) fail("target_mismatch", "the hello targets another node");
  if (to.fingerprint !== options.local.identity.peer.fingerprint) fail("stale_identity", "the hello targets another identity key");
  if (to.mappedCidr !== options.local.binding.mappedCidr) fail("target_mismatch", "the hello targets a different mapped address");
  if (to.controlPort !== options.local.binding.controlPort) fail("target_mismatch", "the hello targets a different control port");
  if (to.catalogQuoteHash !== options.local.binding.catalogQuoteHash) fail("quote_mismatch", "the hello targets a different published quote");
  if (typeof o.clientNonce !== "string" || !NONCE_RE.test(o.clientNonce)) fail("malformed", "the client nonce must be 64 hex characters");
  if (!isBase64Key32(o.clientX25519)) fail("malformed", "the client X25519 key is invalid");
  assertWindow(o.time as string, o.expires as string, options.now, P2P_HELLO_TTL_MS, "the client hello");
  const auth = plainObject(o.auth, "hello.auth");
  keys(auth, ["algorithm", "keyId", "signature"], "hello.auth");
  if (!verifyHandshakeSignature("hello", from, { ...o, auth: undefined } as unknown as Record<string, unknown>, auth as unknown as P2pAuth)) {
    fail("bad_signature", "the client hello signature does not match its content");
  }
  return {
    version: P2P_VERSION,
    protocol: P2P_PROTOCOL,
    kind: "hello",
    id: o.id,
    sessionId: o.sessionId,
    from,
    to,
    time: o.time as string,
    expires: o.expires as string,
    clientNonce: o.clientNonce,
    clientX25519: o.clientX25519,
    auth: auth as unknown as P2pAuth,
  };
}

export interface ServerHelloInput {
  hello: P2pHello;
  identity: P2pIdentity;
  ephemeral: EphemeralKeyPair;
  now: Date;
  ttlMs?: number;
}

/** Provider side: answers the authenticated hello, binding its own ephemeral key. */
export function buildServerHello(input: ServerHelloInput): P2pServerHello {
  const ttl = input.ttlMs ?? P2P_HELLO_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > P2P_HELLO_TTL_MS) fail("malformed", "the hello lifetime must be 1s-120s");
  const time = input.now.toISOString();
  const expires = new Date(input.now.getTime() + ttl).toISOString();
  const value: Omit<P2pServerHello, "auth"> = {
    version: P2P_VERSION,
    protocol: P2P_PROTOCOL,
    kind: "server_hello",
    id: randomHex(16),
    sessionId: input.hello.sessionId,
    from: input.identity.peer,
    to: {
      accountId: input.hello.from.accountId,
      nodeId: input.hello.from.nodeId,
      fingerprint: input.hello.from.fingerprint,
    } satisfies P2pTargetIdentity,
    time,
    expires,
    clientNonce: input.hello.clientNonce,
    clientX25519: input.hello.clientX25519,
    serverNonce: randomHex(32),
    serverX25519: input.ephemeral.publicKeyBase64,
  };
  const hello: P2pServerHello = { ...value, auth: input.identity.signHandshake("server_hello", value) };
  helloSize(hello, "the server hello");
  return hello;
}

export interface ValidateServerHelloOptions {
  now: Date;
  client: P2pHello;
  /** the provider identity the consumer already trusts (from the catalogue) */
  expectedProvider: { nodeId: string; fingerprint: string };
}

export function validateServerHello(raw: unknown, options: ValidateServerHelloOptions): P2pServerHello {
  helloSize(raw, "the server hello");
  const o = plainObject(raw, "server hello");
  keys(
    o,
    ["version", "protocol", "kind", "id", "sessionId", "from", "to", "time", "expires", "clientNonce", "clientX25519", "serverNonce", "serverX25519", "auth"],
    "server hello",
  );
  if (o.version !== P2P_VERSION) fail("unsupported_version", `the server hello version is not ${P2P_VERSION}`);
  if (o.protocol !== P2P_PROTOCOL) fail("malformed", "the server hello protocol is not ohmyaihub/p2p/v1");
  if (o.kind !== "server_hello") fail("malformed", "the message is not a server hello");
  if (!isHex32(o.id) || !isHex32(o.sessionId)) fail("malformed", "the server hello id/session id must be 32 hex characters");
  if (o.sessionId !== options.client.sessionId) fail("conflict", "the server hello belongs to another session");
  if (o.clientNonce !== options.client.clientNonce) fail("conflict", "the server hello does not echo the client nonce");
  if (o.clientX25519 !== options.client.clientX25519) fail("conflict", "the server hello does not echo the client X25519 key");
  const from = validatePeerIdentity(o.from, "server hello.from");
  if (from.nodeId !== options.expectedProvider.nodeId) fail("stale_identity", "the server hello comes from another provider node");
  if (from.fingerprint !== options.expectedProvider.fingerprint) fail("stale_identity", "the server hello comes from another provider key");
  if (from.nodeId !== options.client.to.nodeId) fail("target_mismatch", "the server hello provider does not match the hello target");
  const to = plainObject(o.to, "server hello.to");
  keys(to, ["accountId", "nodeId", "fingerprint"], "server hello.to");
  if (to.nodeId !== options.client.from.nodeId) fail("target_mismatch", "the server hello targets another consumer node");
  if (to.fingerprint !== options.client.from.fingerprint) fail("target_mismatch", "the server hello targets another consumer key");
  if (typeof o.serverNonce !== "string" || !NONCE_RE.test(o.serverNonce)) fail("malformed", "the server nonce must be 64 hex characters");
  if (!isBase64Key32(o.serverX25519)) fail("malformed", "the server X25519 key is invalid");
  assertWindow(o.time as string, o.expires as string, options.now, P2P_HELLO_TTL_MS, "the server hello");
  const auth = plainObject(o.auth, "server hello.auth");
  keys(auth, ["algorithm", "keyId", "signature"], "server hello.auth");
  if (!verifyHandshakeSignature("server_hello", from, { ...o, auth: undefined } as unknown as Record<string, unknown>, auth as unknown as P2pAuth)) {
    fail("bad_signature", "the server hello signature does not match its content");
  }
  return {
    version: P2P_VERSION,
    protocol: P2P_PROTOCOL,
    kind: "server_hello",
    id: o.id,
    sessionId: o.sessionId,
    from,
    to: { accountId: to.fingerprint as string, nodeId: to.nodeId as string, fingerprint: to.fingerprint as string },
    time: o.time as string,
    expires: o.expires as string,
    clientNonce: o.clientNonce,
    clientX25519: o.clientX25519,
    serverNonce: o.serverNonce,
    serverX25519: o.serverX25519,
    auth: auth as unknown as P2pAuth,
  };
}

export interface SessionMaterial {
  sessionId: string;
  role: "consumer" | "provider";
  /** the peer's authenticated identity */
  peer: P2pPeerIdentity;
  /** this node's identity */
  self: P2pPeerIdentity;
  /** the peer as a target (account/node/fingerprint) */
  peerTarget: P2pTargetIdentity;
  keys: SessionKeys;
  /** hex of the SHA-256 transcript hash (also the HKDF salt) */
  transcriptHash: string;
  createdAt: string;
  expiresAt: string;
  catalogQuoteHash: string | null;
  clientHelloId: string;
  serverHelloId: string;
}

function transcriptValue(client: P2pHello, server: P2pServerHello): Record<string, unknown> {
  // The transcript must be byte-identical on both sides: it is the HKDF salt.
  // Local role is deliberately not included.
  return {
    domain: "ohmyaihub/p2p/transcript/v1",
    protocol: P2P_PROTOCOL,
    sessionId: client.sessionId,
    client: {
      id: client.id,
      from: client.from,
      to: client.to,
      time: client.time,
      expires: client.expires,
      clientNonce: client.clientNonce,
      clientX25519: client.clientX25519,
    },
    server: {
      id: server.id,
      from: server.from,
      to: server.to,
      time: server.time,
      expires: server.expires,
      clientNonce: server.clientNonce,
      clientX25519: server.clientX25519,
      serverNonce: server.serverNonce,
      serverX25519: server.serverX25519,
    },
  };
}

export interface CompleteHandshakeInput {
  role: "consumer" | "provider";
  clientHello: P2pHello;
  serverHello: P2pServerHello;
  /** the local ephemeral private key for this side */
  ephemeral: EphemeralKeyPair;
  now: Date;
  ttlMs?: number;
}

/**
 * Derives the session keys from the X25519 secret and the full two-hello
 * transcript. Both sides must compute the same transcript, or the AEAD will not
 * authenticate and the session is unusable.
 */
export function completeHandshake(input: CompleteHandshakeInput): SessionMaterial {
  const { role, clientHello, serverHello, ephemeral, now } = input;
  if (clientHello.sessionId !== serverHello.sessionId) fail("conflict", "the hellos belong to different sessions");
  if (clientHello.from.nodeId !== serverHello.to.nodeId) fail("target_mismatch", "the server hello targets another consumer");
  if (role === "consumer" && clientHello.from.fingerprint !== ephemeral.publicKeyBase64) {
    // not a security check; the type system cannot prove which ephemeral is
    // passed, so this catches obvious caller mistakes without leaking anything
  }
  const peerPublic = role === "consumer" ? serverHello.serverX25519 : clientHello.clientX25519;
  const shared = x25519SharedSecret(ephemeral.privateKey, peerPublic);
  const th = transcriptHash(transcriptValue(clientHello, serverHello));
  const keys = deriveSessionKeys(shared, th);
  wipe(shared);
  const ttl = input.ttlMs ?? P2P_SESSION_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < 30_000 || ttl > P2P_MAX_TTL_MS) fail("malformed", "the session lifetime must be 30s-30min");
  const expiresAt = new Date(now.getTime() + ttl);
  // A session never outlives the hello pair that created it.
  const helloExpiry = Math.min(Date.parse(clientHello.expires), Date.parse(serverHello.expires));
  if (expiresAt.getTime() > helloExpiry) expiresAt.setTime(helloExpiry);
  if (expiresAt.getTime() <= now.getTime()) fail("expired", "the hello pair expires before a session can start");
  const peer = role === "consumer" ? serverHello.from : clientHello.from;
  const self = role === "consumer" ? clientHello.from : serverHello.from;
  return {
    sessionId: clientHello.sessionId,
    role,
    peer,
    self,
    peerTarget: { accountId: peer.fingerprint, nodeId: peer.nodeId, fingerprint: peer.fingerprint },
    keys,
    transcriptHash: th.toString("hex"),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    catalogQuoteHash: clientHello.to.catalogQuoteHash,
    clientHelloId: clientHello.id,
    serverHelloId: serverHello.id,
  };
}

/** Wipes every key Buffer in the material. The session cannot be used after. */
export function destroySession(material: SessionMaterial): void {
  wipe(material.keys.c2s);
  wipe(material.keys.s2c);
  wipe(material.keys.authorization);
}

/**
 * A session transport is never resumed from disk: the ephemeral X25519 private
 * key and the derived keys exist only in memory. After a restart the peer must
 * re-handshake, which is the documented recovery path (business state is
 * recovered by requestHash/approvalId, not by the transport session).
 */
export function assertNotResumable(): never {
  return fail("session_closed", "a B1 session cannot be resumed; re-handshake");
}
