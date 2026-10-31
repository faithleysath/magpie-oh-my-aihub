// The Phase 10 B1 wire protocol: versioned, signed, allow-listed messages
// between two Oh My AIHub nodes over the EasyTier overlay.
//
// This module is deliberately self-contained. It does not import Service,
// Ledger, Wallet, the Console or the Magpie admin client, and it has no
// filesystem, network or process side effects. The only thing it shares with
// the rest of the plugin is the **identity root**: the persisted Catalogue
// Ed25519 key (`catalog-identity.json`) is the account identity here too. B1
// does not introduce a second identity, a second trust store or a new
// signature algorithm.
//
// Two independent layers exist on purpose:
//
//  1. the **envelope** (this file): who sent what to whom, when it expires,
//     which business operation it belongs to (correlation/idempotency) and the
//     Ed25519 signature that covers every one of those fields;
//  2. the **session** (handshake.ts/session.ts): an ephemeral X25519 exchange
//     that authenticates the same Ed25519 identity on both sides and encrypts
//     the envelope with AES-256-GCM.
//
// A signature that verifies proves the message came from the holder of the
// Catalogue key. It does not prove a real-world identity, funding or intent,
// and it is never a substitute for the human TOFU decision or human approval.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  canonicalJson,
  fingerprintOf,
  isValidMappedCidr,
  isValidModelId,
  isValidNodeId,
  isValidOverlayHostname,
  keyIdOf,
  sha256Hex,
} from "../catalog.ts";

export const P2P_PROTOCOL = "ohmyaihub/p2p/v1";
export const P2P_VERSION = 1;

/**
 * The only message types this protocol accepts. Anything else is rejected
 * before any handler, database row or port call. The list is a closed set so a
 * remote peer can never reach an unlisted action by naming it.
 */
export const P2P_MESSAGE_TYPES = [
  "connection_request",
  "approved",
  "rejected",
  "authorization_delivery",
  "ack",
  "revoked",
  "quote_changed",
  "payment_request",
  "status",
  "credit_updated",
] as const;
export type P2pMessageType = (typeof P2P_MESSAGE_TYPES)[number];

/**
 * One-byte frame code per type. The code must match the signed envelope type;
 * a frame whose code and envelope disagree is rejected.
 */
export const P2P_TYPE_CODES: Readonly<Record<P2pMessageType, number>> = Object.freeze({
  connection_request: 1,
  approved: 2,
  rejected: 3,
  authorization_delivery: 4,
  ack: 5,
  revoked: 6,
  quote_changed: 7,
  payment_request: 8,
  status: 9,
  credit_updated: 10,
});

export const P2P_TYPE_BY_CODE: Readonly<Record<number, P2pMessageType>> = Object.freeze(
  Object.fromEntries(Object.entries(P2P_TYPE_CODES).map(([type, code]) => [code, type as P2pMessageType])),
);

/**
 * Types whose business effect B1 refuses. They are in the allow-list so the
 * envelope is versioned and testable, but the B1 business layer answers them
 * with `unsupported` and performs no state change at all: no ledger write, no
 * cap change, no wallet access. Those effects belong to PR C/D and need their
 * own review.
 */
export const P2P_B1_UNSUPPORTED: readonly P2pMessageType[] = Object.freeze(["payment_request", "credit_updated"]);

/** Hard size caps. The body cap is enforced after canonicalisation. */
export const P2P_MAX_JSON_BYTES = 16 * 1024;
export const P2P_MAX_BODY_BYTES = 12 * 1024;
export const P2P_MAX_FRAME_BYTES = 32 * 1024;
export const P2P_HANDSHAKE_MAX_BYTES = 8 * 1024;
export const P2P_MAX_MODELS = 200;
export const P2P_MAX_CAP_USD = 1_000_000;
/** Envelopes are short-lived; a session is not a long-term inbox. */
export const P2P_MAX_TTL_MS = 30 * 60_000;
/** Accepted clock difference between two operator machines. */
export const P2P_CLOCK_SKEW_MS = 2 * 60_000;

const HEX32_RE = /^[a-f0-9]{32}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const BASE64_32_RE = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_64_RE = /^[A-Za-z0-9+/]{86}==$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MEMO_RE = /^[ -~]{0,200}$/;

export type P2pErrorCode =
  | "malformed"
  | "unsupported_version"
  | "unsupported_type"
  | "unsupported_in_b1"
  | "oversize"
  | "bad_identity"
  | "stale_identity"
  | "bad_signature"
  | "bad_ciphertext"
  | "expired"
  | "clock_skew"
  | "replay"
  | "target_mismatch"
  | "quote_mismatch"
  | "untrusted_peer"
  | "policy"
  | "no_shared_models"
  | "not_found"
  | "conflict"
  | "session_closed"
  | "internal";

/** A protocol failure with a stable, remote-safe code. No free text is sent. */
export class P2pError extends Error {
  constructor(
    readonly code: P2pErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "P2pError";
  }
}

export function fail(code: P2pErrorCode, message: string): never {
  throw new P2pError(code, message);
}

// --- primitive validators ----------------------------------------------------

export function isHex32(value: unknown): value is string {
  return typeof value === "string" && HEX32_RE.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64_RE.test(value);
}

export function isBase64Key32(value: unknown): value is string {
  return typeof value === "string" && BASE64_32_RE.test(value);
}

export function isBase64Nonce64(value: unknown): value is string {
  return typeof value === "string" && BASE64_64_RE.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** JSON objects only, never arrays, never class instances, never null. */
// `any` on read, strict on write: every field is validated below; this keeps the
// validators readable without hundreds of casts at each property access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function objectOf(value: unknown, where: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("malformed", `${where} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("malformed", `${where} must be a plain object`);
  return value as Record<string, unknown>;
}

/** Exact field allow-list. Extra or misspelled fields are rejected. */
function assertKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("malformed", `${where} has an unexpected field ${JSON.stringify(key)}`);
  }
}

function textOf(value: unknown, where: string, min: number, max: number, pattern?: RegExp): string {
  if (typeof value !== "string") fail("malformed", `${where} must be a string`);
  if (value.length < min || value.length > max) fail("malformed", `${where} must be ${min}-${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail("malformed", `${where} contains a control character`);
  if (pattern && !pattern.test(value)) fail("malformed", `${where} has an invalid format`);
  return value;
}

function numberInRange(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("malformed", `${where} must be a finite number`);
  if (value < min || value > max) fail("malformed", `${where} must be between ${min} and ${max}`);
  return value;
}

function integerInRange(value: unknown, where: string, min: number, max: number): number {
  const n = numberInRange(value, where, min, max);
  if (!Number.isInteger(n)) fail("malformed", `${where} must be an integer`);
  return n;
}

export function timeMs(value: unknown, where: string): number {
  if (!isIsoTimestamp(value)) fail("malformed", `${where} must be an ISO-8601 timestamp`);
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) fail("malformed", `${where} is outside 2000-2100`);
  return Date.parse(value);
}

export function modelListOf(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > P2P_MAX_MODELS) {
    fail("malformed", `${where} must be a non-empty list of at most ${P2P_MAX_MODELS} model ids`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (!isValidModelId(item)) fail("malformed", `${where} contains an invalid model id`);
    if (out.includes(item)) fail("malformed", `${where} contains a duplicate model id`);
    out.push(item);
  }
  return out;
}

/** Magpie caps live on a $0.0001 grid and must be strictly positive. */
export function capOnGridOf(value: unknown, where: string): number {
  const n = numberInRange(value, where, 0.0001, P2P_MAX_CAP_USD);
  if (Math.abs(Math.round(n * 1e4) / 1e4 - n) > 1e-9) fail("malformed", `${where} must be on the $0.0001 cap grid`);
  return n;
}

/**
 * Storage/response guard. Every JSON document written to `p2p.sqlite` (and every
 * generic response cache entry) passes through this: a Gateway Key, private key
 * or mnemonic must never be persisted or cached. The check is on field names
 * and on credential-looking values, so it also catches a future caller that
 * nests a secret under a new name.
 */
const FORBIDDEN_FIELDS = new Set([
  "key",
  "secret",
  "gatewaykey",
  "privatekey",
  "privatekeypem",
  "mnemonic",
  "seedphrase",
  "password",
  "token",
  "authorization",
  "bearer",
]);

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9._-]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/,
];

export function assertNoSecretMaterial(value: unknown, where = "document", depth = 0): void {
  if (depth > 12) fail("malformed", `${where} is nested too deeply`);
  if (typeof value === "string") {
    for (const re of SECRET_VALUE_PATTERNS) {
      if (re.test(value)) fail("conflict", `${where} appears to contain credential material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2000) fail("malformed", `${where} has too many entries`);
    for (const item of value) assertNoSecretMaterial(item, where, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 2000) fail("malformed", `${where} has too many fields`);
    for (const [key, item] of entries) {
      const normalised = key.toLowerCase().replace(/[_-]/g, "");
      if (FORBIDDEN_FIELDS.has(normalised)) fail("conflict", `${where} must not carry a ${JSON.stringify(key)} field`);
      assertNoSecretMaterial(item, `${where}.${key}`, depth + 1);
    }
  }
}

// --- identity ----------------------------------------------------------------

/** The full identity a peer asserts. `accountId` is the Catalogue key fingerprint. */
export interface P2pPeerIdentity {
  /** = fingerprint: B1 reuses the Catalogue Ed25519 key as the account identity. */
  accountId: string;
  nodeId: string;
  hostname: string;
  /** base64 raw 32-byte Ed25519 public key, the same encoding the Catalogue uses. */
  publicKey: string;
  fingerprint: string;
}

export interface P2pTargetIdentity {
  accountId: string;
  nodeId: string;
  fingerprint: string;
}

export function validatePeerIdentity(raw: unknown, where: string): P2pPeerIdentity {
  const o = objectOf(raw, where);
  assertKeys(o, ["accountId", "nodeId", "hostname", "publicKey", "fingerprint"], where);
  const nodeId = textOf(o.nodeId, `${where}.nodeId`, 8, 64);
  if (!isValidNodeId(nodeId)) fail("bad_identity", `${where}.nodeId is not a valid node id`);
  const hostname = textOf(o.hostname, `${where}.hostname`, 3, 72);
  if (!isValidOverlayHostname(hostname, nodeId)) fail("bad_identity", `${where}.hostname does not match the node id`);
  if (!isBase64Key32(o.publicKey)) fail("bad_identity", `${where}.publicKey is not a base64 Ed25519 key`);
  const fingerprint = fingerprintOf(o.publicKey);
  if (o.fingerprint !== fingerprint) fail("bad_identity", `${where}.fingerprint does not match its public key`);
  // No second identity: the account and the node share the Catalogue key.
  if (o.accountId !== fingerprint) fail("bad_identity", `${where}.accountId is not the Catalogue key fingerprint`);
  return { accountId: fingerprint, nodeId, hostname, publicKey: o.publicKey, fingerprint };
}

export function validateTargetIdentity(raw: unknown, where: string): P2pTargetIdentity {
  const o = objectOf(raw, where);
  assertKeys(o, ["accountId", "nodeId", "fingerprint"], where);
  const nodeId = textOf(o.nodeId, `${where}.nodeId`, 8, 64);
  if (!isValidNodeId(nodeId)) fail("target_mismatch", `${where}.nodeId is not a valid node id`);
  if (!isHex64(o.fingerprint)) fail("target_mismatch", `${where}.fingerprint must be a 64-hex fingerprint`);
  if (o.accountId !== o.fingerprint) fail("target_mismatch", `${where}.accountId is not the target key fingerprint`);
  return { accountId: o.accountId, nodeId, fingerprint: o.fingerprint };
}

export function peerIdentityOf(summary: { publicKey: string; fingerprint: string }, nodeId: string, hostname: string): P2pPeerIdentity {
  if (fingerprintOf(summary.publicKey) !== summary.fingerprint) fail("bad_identity", "the Catalogue identity is inconsistent");
  if (!isValidNodeId(nodeId)) fail("bad_identity", "the local node id is invalid");
  if (!isValidOverlayHostname(hostname, nodeId)) fail("bad_identity", "the local hostname does not match the node id");
  return { accountId: summary.fingerprint, nodeId, hostname, publicKey: summary.publicKey, fingerprint: summary.fingerprint };
}

// --- envelope ----------------------------------------------------------------

export interface P2pAuth {
  algorithm: "ed25519";
  keyId: string;
  signature: string;
}

export interface P2pEnvelope<B = unknown> {
  version: 1;
  protocol: typeof P2P_PROTOCOL;
  type: P2pMessageType;
  id: string;
  from: P2pPeerIdentity;
  to: P2pTargetIdentity;
  /** when the sender signed it */
  time: string;
  /** after this instant the message must not be acted on */
  expires: string;
  /** the request/approval this message belongs to, or null */
  correlation: string | null;
  /** stable business operation key; retries reuse it */
  idempotency: string;
  body: B;
  auth: P2pAuth;
}

/** The exact bytes covered by the envelope signature. */
export function envelopeSigningValue(envelope: P2pEnvelope): Record<string, unknown> {
  return {
    domain: signatureDomain(envelope.type),
    protocol: envelope.protocol,
    version: envelope.version,
    type: envelope.type,
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    time: envelope.time,
    expires: envelope.expires,
    correlation: envelope.correlation,
    idempotency: envelope.idempotency,
    body: envelope.body,
  };
}

export function signatureDomain(type: P2pMessageType): string {
  return `ohmyaihub/p2p/${type}/v1`;
}

export function signingBytesFor(type: P2pMessageType, unsigned: Record<string, unknown>): Buffer {
  // Never let a caller-supplied "domain" override the type's domain.
  const { domain: _ignored, ...rest } = unsigned;
  void _ignored;
  return Buffer.from(canonicalJson({ domain: signatureDomain(type), ...rest }), "utf8");
}

/** DER SPKI wrapper for a raw Ed25519 key. The Catalogue has the same helper. */
export function ed25519PublicKey(raw: Buffer) {
  if (raw.length !== 32) fail("bad_identity", "an Ed25519 public key is 32 bytes");
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

export function verifyEd25519(publicKeyBase64: string, payload: Buffer, signatureBase64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64, "base64");
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64) return false;
    return cryptoVerify(null, payload, ed25519PublicKey(raw), signature);
  } catch {
    return false;
  }
}

export interface VerifyEnvelopeOptions {
  now: Date;
  /** the identity pinned by the session/TOFU record; any other key is stale */
  expectedFrom?: { nodeId: string; fingerprint: string } | undefined;
  /** the local identity this message must target */
  expectedTo?: { nodeId: string; fingerprint: string } | undefined;
  /** raw JSON byte budget; defaults to the envelope cap */
  maxBytes?: number;
}

export interface VerifiedEnvelope<B = unknown> {
  envelope: P2pEnvelope<B>;
  /** SHA-256 of the canonical signed body (sensitivity-free) */
  bodyHash: string;
  /** the content-addressed business handle, when the type has one */
  requestHash: string | null;
  /** whether the envelope is inside its validity window now */
  expiresAt: string;
}

/**
 * Validates a signed envelope from an untrusted peer. Order matters: shape and
 * size first (cheap), identity second, time third, signature last (expensive).
 * Every failure throws `P2pError` with a code; nothing partially processed is
 * returned.
 */
export function validateEnvelope<B = unknown>(raw: unknown, options: VerifyEnvelopeOptions): VerifiedEnvelope<B> {
  const maxBytes = options.maxBytes ?? P2P_MAX_JSON_BYTES;
  const encoded = typeof raw === "string" ? raw : canonicalJsonUnsafe(raw);
  if (encoded === null) return fail("malformed", "the envelope is not JSON");
  if (Buffer.byteLength(encoded) > maxBytes) fail("oversize", `the envelope exceeds ${maxBytes} bytes`);
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return fail("malformed", "the envelope is not JSON");
    }
  }

  const o = objectOf(raw, "envelope");
  assertKeys(
    o,
    ["version", "protocol", "type", "id", "from", "to", "time", "expires", "correlation", "idempotency", "body", "auth"],
    "envelope",
  );
  if (o.version !== P2P_VERSION) fail("unsupported_version", `the envelope version is not ${P2P_VERSION}`);
  if (o.protocol !== P2P_PROTOCOL) fail("malformed", "the envelope protocol is not ohmyaihub/p2p/v1");
  if (typeof o.type !== "string" || !(P2P_MESSAGE_TYPES as readonly string[]).includes(o.type)) {
    fail("unsupported_type", "the envelope type is not in the allow-list");
  }
  const type = o.type as P2pMessageType;
  if (!isHex32(o.id)) fail("malformed", "the envelope id must be 32 hex characters");
  if (!isHex32(o.idempotency)) fail("malformed", "the envelope idempotency key must be 32 hex characters");
  if (o.correlation !== null && !isHex32(o.correlation)) fail("malformed", "the envelope correlation must be 32 hex or null");

  const from = validatePeerIdentity(o.from, "envelope.from");
  const to = validateTargetIdentity(o.to, "envelope.to");

  if (options.expectedFrom) {
    if (from.nodeId !== options.expectedFrom.nodeId || from.fingerprint !== options.expectedFrom.fingerprint) {
      fail("stale_identity", "the message comes from a different identity than the one pinned for this session");
    }
  }
  if (options.expectedTo) {
    if (to.nodeId !== options.expectedTo.nodeId || to.fingerprint !== options.expectedTo.fingerprint) {
      fail("target_mismatch", "the message targets a different node or key");
    }
  }
  if (from.nodeId === to.nodeId) fail("target_mismatch", "a message cannot target its own sender");

  const time = timeMs(o.time, "envelope.time");
  const expires = timeMs(o.expires, "envelope.expires");
  if (expires <= time) fail("malformed", "the envelope expires before it was issued");
  if (expires - time > P2P_MAX_TTL_MS) fail("malformed", "the envelope lifetime exceeds 30 minutes");
  const now = options.now.getTime();
  if (time - now > P2P_CLOCK_SKEW_MS) fail("clock_skew", "the envelope is issued too far in the future");
  if (now - expires > P2P_CLOCK_SKEW_MS) fail("expired", "the envelope has expired");

  const auth = objectOf(o.auth, "envelope.auth");
  assertKeys(auth, ["algorithm", "keyId", "signature"], "envelope.auth");
  if (auth.algorithm !== "ed25519") fail("bad_signature", "only Ed25519 envelope signatures are accepted");
  if (auth.keyId !== keyIdOf(from.publicKey)) fail("bad_signature", "the signing key id does not match the sender identity");
  if (typeof auth.signature !== "string" || auth.signature.length < 64 || auth.signature.length > 128) {
    fail("bad_signature", "the envelope signature is missing or malformed");
  }

  const body = validateBody(type, o.body, { from, to });
  const unsigned: P2pEnvelope = {
    version: 1,
    protocol: P2P_PROTOCOL,
    type,
    id: o.id,
    from,
    to,
    time: o.time,
    expires: o.expires,
    correlation: o.correlation as string | null,
    idempotency: o.idempotency,
    body,
    auth: { algorithm: "ed25519", keyId: auth.keyId, signature: auth.signature },
  };
  assertNoSecretMaterial({ body }, "envelope.body");
  if (!verifyEd25519(from.publicKey, signingBytesFor(type, envelopeSigningValue(unsigned)), auth.signature)) {
    fail("bad_signature", "the envelope signature does not match its content");
  }
  if (Buffer.byteLength(canonicalJson(body)) > P2P_MAX_BODY_BYTES) fail("oversize", "the envelope body is too large");

  return {
    envelope: unsigned as unknown as P2pEnvelope<B>,
    bodyHash: sha256Hex(canonicalJson(body)),
    requestHash: businessRequestHash(type, body),
    expiresAt: unsigned.expires,
  };
}

/** canonicalJson with a non-throwing wrapper for size accounting. */
function canonicalJsonUnsafe(value: unknown): string | null {
  try {
    return canonicalJson(value);
  } catch {
    return null;
  }
}

/** The content hash that makes a business operation idempotent, or null. */
export function businessRequestHash(type: P2pMessageType, body: unknown): string | null {
  const b = body as Record<string, unknown>;
  if (type === "connection_request" && typeof b.requestHash === "string") return b.requestHash;
  if (type === "approved" || type === "rejected" || type === "ack" || type === "authorization_delivery") {
    return typeof b.requestHash === "string" ? b.requestHash : null;
  }
  return null;
}

// --- bodies ------------------------------------------------------------------

export interface P2pRequestDocument {
  consumer: { nodeId: string; hostname: string };
  provider: { nodeId: string; hostname: string; mappedCidr: string; gatewayPort: number; catalogPort: number };
  models: string[];
  quote: { contentHash: string; priceVersion: string; identityFingerprint: string; priceLocked: false };
  acceptance: { fingerprint: string; quoteHash: string; priceVersion: string };
}

export interface P2pConnectionRequestBody {
  requestHash: string;
  request: P2pRequestDocument;
}

export interface P2pApprovedBody {
  requestHash: string;
  approvalId: string;
  /** re-approval generation after a revocation; never reissues in place */
  generation: number;
  consumerNodeId: string;
  consumerFingerprint: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  priceVersion: string;
  expiresAt: string;
  keyId: string;
  keyName: string;
}

export const P2P_REJECTION_REASONS = [
  "no-shared-models",
  "untrusted-consumer",
  "quote-changed",
  "policy",
  "capacity",
  "declined",
  "expired",
] as const;
export type P2pRejectionReason = (typeof P2P_REJECTION_REASONS)[number];

export interface P2pRejectedBody {
  requestHash: string;
  reason: P2pRejectionReason;
  note: string | null;
}

/** The sealed inner authorization. The key exists only inside `ciphertext`. */
export interface P2pSealedAuthorization {
  algorithm: "aes-256-gcm";
  keyDerivation: "hkdf-sha256";
  /** base64 12-byte GCM nonce */
  nonce: string;
  /** base64 AES-256-GCM ciphertext + 16-byte tag */
  ciphertext: string;
}

export interface P2pAuthorizationDocument {
  schema: "ohmyaihub.authorization/v2";
  createdAt: string;
  provider: { nodeId: string; mappedCidr: string; gatewayPort: number };
  consumer: { nodeId: string; fingerprint: string };
  approvalId: string;
  requestHash: string;
  models: string[];
  capUsd: number;
  quote: { contentHash: string; identityFingerprint: string; priceVersion: string; priceLocked: false };
  keyId: string;
  keyName: string;
  keyHash: string;
  key: string;
}

export interface P2pAuthorizationDeliveryBody {
  approvalId: string;
  generation: number;
  requestHash: string;
  authorizationHash: string;
  keyId: string;
  keyName: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  priceVersion: string;
  expiresAt: string;
  sealed: P2pSealedAuthorization;
}

export interface P2pAckBody {
  approvalId: string;
  requestHash: string;
  authorizationHash: string;
  keyId: string;
  state: "registered" | "delivery-failed";
  readback: { models: string[]; capUsd: number } | null;
  detail: string | null;
}

export const P2P_REVOKE_REASONS = [
  "operator-revoked",
  "key-rotated",
  "price-changed",
  "policy",
  "consumer-cancelled",
  "account-closed",
] as const;
export type P2pRevokeReason = (typeof P2P_REVOKE_REASONS)[number];

export interface P2pRevokedBody {
  approvalId: string | null;
  consumerNodeId: string;
  consumerFingerprint: string;
  reason: P2pRevokeReason;
}

export interface P2pQuoteChangedBody {
  quoteHash: string;
  priceVersion: string;
  models: string[];
}

export interface P2pPaymentRequestBody {
  paymentId: string;
  amountUsd: number;
  network: { chainId: number; tokenContract: string; decimals: number; issuerType: "native-issuer" | "bridged" | "mock" };
  memo: string | null;
}

export interface P2pStatusBody {
  state: "query" | "report";
  approvalId: string | null;
  requestHash: string | null;
  approvalState: "unknown" | "pending" | "approved" | "delivering" | "delivered" | "revoked" | "expired";
}

export interface P2pCreditUpdatedBody {
  creditId: string;
  consumerNodeId: string;
  fundsClass: "test" | "main";
  amountUsd: number;
  state: "observed" | "credited" | "failed";
}

type BodyByType = {
  connection_request: P2pConnectionRequestBody;
  approved: P2pApprovedBody;
  rejected: P2pRejectedBody;
  authorization_delivery: P2pAuthorizationDeliveryBody;
  ack: P2pAckBody;
  revoked: P2pRevokedBody;
  quote_changed: P2pQuoteChangedBody;
  payment_request: P2pPaymentRequestBody;
  status: P2pStatusBody;
  credit_updated: P2pCreditUpdatedBody;
};

export type P2pBody<T extends P2pMessageType> = BodyByType[T];

const NULLABLE_MEMO = MEMO_RE;

function validateRequestDocument(raw: unknown): P2pRequestDocument {
  const o = objectOf(raw, "body.request");
  assertKeys(o, ["consumer", "provider", "models", "quote", "acceptance"], "body.request");

  const consumer = objectOf(o.consumer, "body.request.consumer");
  assertKeys(consumer, ["nodeId", "hostname"], "body.request.consumer");
  const consumerNodeId = textOf(consumer.nodeId, "body.request.consumer.nodeId", 8, 64);
  if (!isValidNodeId(consumerNodeId)) fail("malformed", "the request consumer node id is invalid");
  const consumerHostname = textOf(consumer.hostname, "body.request.consumer.hostname", 3, 72);
  if (!isValidOverlayHostname(consumerHostname, consumerNodeId)) fail("malformed", "the request consumer hostname does not match its node id");

  const provider = objectOf(o.provider, "body.request.provider");
  assertKeys(provider, ["nodeId", "hostname", "mappedCidr", "gatewayPort", "catalogPort"], "body.request.provider");
  const providerNodeId = textOf(provider.nodeId, "body.request.provider.nodeId", 8, 64);
  if (!isValidNodeId(providerNodeId)) fail("malformed", "the request provider node id is invalid");
  const providerHostname = textOf(provider.hostname, "body.request.provider.hostname", 3, 72);
  if (!isValidOverlayHostname(providerHostname, providerNodeId)) fail("malformed", "the request provider hostname does not match its node id");
  if (!isValidMappedCidr(provider.mappedCidr)) fail("malformed", "the request provider address is not a mapped /32");
  const gatewayPort = integerInRange(provider.gatewayPort, "body.request.provider.gatewayPort", 1, 65535);
  const catalogPort = integerInRange(provider.catalogPort, "body.request.provider.catalogPort", 1, 65535);
  if (gatewayPort === catalogPort) fail("malformed", "the request provider ports must differ");

  const models = modelListOf(o.models, "body.request.models");

  const quote = objectOf(o.quote, "body.request.quote");
  assertKeys(quote, ["contentHash", "priceVersion", "identityFingerprint", "priceLocked"], "body.request.quote");
  if (!isHex64(quote.contentHash)) fail("quote_mismatch", "the request quote hash is invalid");
  if (!isHex64(quote.priceVersion)) fail("quote_mismatch", "the request price version is invalid");
  if (!isHex64(quote.identityFingerprint)) fail("quote_mismatch", "the request identity fingerprint is invalid");
  if (quote.priceLocked !== false) fail("quote_mismatch", "B1 never claims a locked price");

  const acceptance = objectOf(o.acceptance, "body.request.acceptance");
  assertKeys(acceptance, ["fingerprint", "quoteHash", "priceVersion"], "body.request.acceptance");
  if (!isHex64(acceptance.fingerprint)) fail("quote_mismatch", "the acceptance fingerprint is invalid");
  if (!isHex64(acceptance.quoteHash)) fail("quote_mismatch", "the acceptance quote hash is invalid");
  if (!isHex64(acceptance.priceVersion)) fail("quote_mismatch", "the acceptance price version is invalid");
  if (acceptance.fingerprint !== quote.identityFingerprint) fail("quote_mismatch", "the acceptance fingerprint differs from the quote identity");
  if (acceptance.quoteHash !== quote.contentHash) fail("quote_mismatch", "the acceptance quote hash differs from the quote");
  if (acceptance.priceVersion !== quote.priceVersion) fail("quote_mismatch", "the acceptance price version differs from the quote");

  return {
    consumer: { nodeId: consumerNodeId, hostname: consumerHostname },
    provider: { nodeId: providerNodeId, hostname: providerHostname, mappedCidr: provider.mappedCidr, gatewayPort, catalogPort },
    models,
    quote: {
      contentHash: quote.contentHash,
      priceVersion: quote.priceVersion,
      identityFingerprint: quote.identityFingerprint,
      priceLocked: false,
    },
    acceptance: { fingerprint: acceptance.fingerprint, quoteHash: acceptance.quoteHash, priceVersion: acceptance.priceVersion },
  };
}

function validateBody(type: P2pMessageType, raw: unknown, ctx: { from: P2pPeerIdentity; to: P2pTargetIdentity }): unknown {
  const o = objectOf(raw, "body");
  switch (type) {
    case "connection_request": {
      assertKeys(o, ["requestHash", "request"], "body");
      const request = validateRequestDocument(o.request);
      if (!isHex64(o.requestHash)) fail("malformed", "the request hash is invalid");
      if (o.requestHash !== sha256Hex(canonicalJson(request))) fail("conflict", "the request hash does not match its content");
      if (request.consumer.nodeId !== ctx.from.nodeId) fail("bad_identity", "the request consumer is not the sender");
      if (request.provider.nodeId !== ctx.to.nodeId) fail("target_mismatch", "the request provider is not the recipient");
      if (request.acceptance.fingerprint !== ctx.to.fingerprint) fail("quote_mismatch", "the request accepts a different provider key");
      if (request.quote.identityFingerprint !== ctx.to.fingerprint) fail("quote_mismatch", "the request quote belongs to a different provider key");
      return { requestHash: o.requestHash, request } satisfies P2pConnectionRequestBody;
    }
    case "approved": {
      assertKeys(
        o,
        ["requestHash", "approvalId", "generation", "consumerNodeId", "consumerFingerprint", "models", "capUsd", "quoteHash", "priceVersion", "expiresAt", "keyId", "keyName"],
        "body",
      );
      if (!isHex64(o.requestHash)) fail("malformed", "the approval request hash is invalid");
      if (!isHex32(o.approvalId)) fail("malformed", "the approval id is invalid");
      const generation = integerInRange(o.generation, "body.generation", 1, 2_147_483_647);
      const consumerNodeId = textOf(o.consumerNodeId, "body.consumerNodeId", 8, 64);
      if (!isValidNodeId(consumerNodeId)) fail("malformed", "the approval consumer node id is invalid");
      if (!isHex64(o.consumerFingerprint)) fail("malformed", "the approval consumer fingerprint is invalid");
      if (consumerNodeId !== ctx.to.nodeId || o.consumerFingerprint !== ctx.to.fingerprint) {
        fail("target_mismatch", "the approval is for a different consumer");
      }
      const models = modelListOf(o.models, "body.models");
      const capUsd = capOnGridOf(o.capUsd, "body.capUsd");
      if (!isHex64(o.quoteHash)) fail("quote_mismatch", "the approval quote hash is invalid");
      if (!isHex64(o.priceVersion)) fail("quote_mismatch", "the approval price version is invalid");
      timeMs(o.expiresAt, "body.expiresAt");
      textOf(o.keyId, "body.keyId", 1, 128, KEY_ID_RE);
      textOf(o.keyName, "body.keyName", 1, 128, KEY_NAME_RE);
      return {
        requestHash: o.requestHash,
        approvalId: o.approvalId,
        generation,
        consumerNodeId,
        consumerFingerprint: o.consumerFingerprint,
        models,
        capUsd,
        quoteHash: o.quoteHash,
        priceVersion: o.priceVersion,
        expiresAt: o.expiresAt,
        keyId: o.keyId,
        keyName: o.keyName,
      } satisfies P2pApprovedBody;
    }
    case "rejected": {
      assertKeys(o, ["requestHash", "reason", "note"], "body");
      if (!isHex64(o.requestHash)) fail("malformed", "the rejection request hash is invalid");
      if (typeof o.reason !== "string" || !(P2P_REJECTION_REASONS as readonly string[]).includes(o.reason)) {
        fail("malformed", "the rejection reason is not in the allow-list");
      }
      const note = o.note === null ? null : textOf(o.note, "body.note", 0, 200, NULLABLE_MEMO);
      return { requestHash: o.requestHash, reason: o.reason as P2pRejectionReason, note } satisfies P2pRejectedBody;
    }
    case "authorization_delivery": {
      assertKeys(
        o,
        ["approvalId", "generation", "requestHash", "authorizationHash", "keyId", "keyName", "models", "capUsd", "quoteHash", "priceVersion", "expiresAt", "sealed"],
        "body",
      );
      if (!isHex32(o.approvalId)) fail("malformed", "the delivery approval id is invalid");
      const generation = integerInRange(o.generation, "body.generation", 1, 2_147_483_647);
      if (!isHex64(o.requestHash)) fail("malformed", "the delivery request hash is invalid");
      if (!isHex64(o.authorizationHash)) fail("malformed", "the delivery authorization hash is invalid");
      textOf(o.keyId, "body.keyId", 1, 128, KEY_ID_RE);
      textOf(o.keyName, "body.keyName", 1, 128, KEY_NAME_RE);
      const models = modelListOf(o.models, "body.models");
      const capUsd = capOnGridOf(o.capUsd, "body.capUsd");
      if (!isHex64(o.quoteHash)) fail("quote_mismatch", "the delivery quote hash is invalid");
      if (!isHex64(o.priceVersion)) fail("quote_mismatch", "the delivery price version is invalid");
      timeMs(o.expiresAt, "body.expiresAt");
      const sealed = objectOf(o.sealed, "body.sealed");
      assertKeys(sealed, ["algorithm", "keyDerivation", "nonce", "ciphertext"], "body.sealed");
      if (sealed.algorithm !== "aes-256-gcm") fail("malformed", "the sealed authorization is not AES-256-GCM");
      if (sealed.keyDerivation !== "hkdf-sha256") fail("malformed", "the sealed authorization lacks HKDF-SHA256 derivation");
      if (typeof sealed.nonce !== "string" || !/^[A-Za-z0-9+/]{16}$/.test(sealed.nonce)) fail("malformed", "the sealed nonce is invalid");
      if (typeof sealed.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed.ciphertext) || sealed.ciphertext.length > 8192) {
        fail("malformed", "the sealed ciphertext is invalid");
      }
      return {
        approvalId: o.approvalId,
        generation,
        requestHash: o.requestHash,
        authorizationHash: o.authorizationHash,
        keyId: o.keyId,
        keyName: o.keyName,
        models,
        capUsd,
        quoteHash: o.quoteHash,
        priceVersion: o.priceVersion,
        expiresAt: o.expiresAt,
        sealed: { algorithm: "aes-256-gcm", keyDerivation: "hkdf-sha256", nonce: sealed.nonce, ciphertext: sealed.ciphertext },
      } satisfies P2pAuthorizationDeliveryBody;
    }
    case "ack": {
      assertKeys(o, ["approvalId", "requestHash", "authorizationHash", "keyId", "state", "readback", "detail"], "body");
      if (!isHex32(o.approvalId)) fail("malformed", "the ack approval id is invalid");
      if (!isHex64(o.requestHash)) fail("malformed", "the ack request hash is invalid");
      if (!isHex64(o.authorizationHash)) fail("malformed", "the ack authorization hash is invalid");
      textOf(o.keyId, "body.keyId", 1, 128, KEY_ID_RE);
      if (o.state !== "registered" && o.state !== "delivery-failed") fail("malformed", "the ack state is not in the allow-list");
      let readback: P2pAckBody["readback"] = null;
      if (o.readback !== null) {
        const r = objectOf(o.readback, "body.readback");
        assertKeys(r, ["models", "capUsd"], "body.readback");
        readback = { models: modelListOf(r.models, "body.readback.models"), capUsd: capOnGridOf(r.capUsd, "body.readback.capUsd") };
      }
      const detail = o.detail === null ? null : textOf(o.detail, "body.detail", 0, 200, NULLABLE_MEMO);
      if (o.state === "registered" && readback === null) fail("malformed", "a registered ack must carry the model/cap readback");
      return { approvalId: o.approvalId, requestHash: o.requestHash, authorizationHash: o.authorizationHash, keyId: o.keyId, state: o.state, readback, detail } satisfies P2pAckBody;
    }
    case "revoked": {
      assertKeys(o, ["approvalId", "consumerNodeId", "consumerFingerprint", "reason"], "body");
      if (o.approvalId !== null && !isHex32(o.approvalId)) fail("malformed", "the revocation approval id is invalid");
      const consumerNodeId = textOf(o.consumerNodeId, "body.consumerNodeId", 8, 64);
      if (!isValidNodeId(consumerNodeId)) fail("malformed", "the revocation consumer node id is invalid");
      if (!isHex64(o.consumerFingerprint)) fail("malformed", "the revocation consumer fingerprint is invalid");
      if (consumerNodeId !== ctx.to.nodeId || o.consumerFingerprint !== ctx.to.fingerprint) {
        fail("target_mismatch", "the revocation is for a different consumer");
      }
      if (typeof o.reason !== "string" || !(P2P_REVOKE_REASONS as readonly string[]).includes(o.reason)) {
        fail("malformed", "the revocation reason is not in the allow-list");
      }
      return { approvalId: o.approvalId as string | null, consumerNodeId, consumerFingerprint: o.consumerFingerprint, reason: o.reason as P2pRevokeReason } satisfies P2pRevokedBody;
    }
    case "quote_changed": {
      assertKeys(o, ["quoteHash", "priceVersion", "models"], "body");
      if (!isHex64(o.quoteHash)) fail("quote_mismatch", "the changed quote hash is invalid");
      if (!isHex64(o.priceVersion)) fail("quote_mismatch", "the changed price version is invalid");
      return { quoteHash: o.quoteHash, priceVersion: o.priceVersion, models: modelListOf(o.models, "body.models") } satisfies P2pQuoteChangedBody;
    }
    case "payment_request": {
      assertKeys(o, ["paymentId", "amountUsd", "network", "memo"], "body");
      if (!isHex32(o.paymentId)) fail("malformed", "the payment id is invalid");
      const amountUsd = numberInRange(o.amountUsd, "body.amountUsd", 0.0001, 1_000_000);
      if (Math.abs(Math.round(amountUsd * 1e4) / 1e4 - amountUsd) > 1e-9) fail("malformed", "the payment amount is off the $0.0001 grid");
      const network = objectOf(o.network, "body.network");
      assertKeys(network, ["chainId", "tokenContract", "decimals", "issuerType"], "body.network");
      const chainId = integerInRange(network.chainId, "body.network.chainId", 1, 2_147_483_647);
      if (typeof network.tokenContract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(network.tokenContract)) {
        fail("malformed", "the payment token contract is invalid");
      }
      const decimals = integerInRange(network.decimals, "body.network.decimals", 0, 36);
      if (!["native-issuer", "bridged", "mock"].includes(String(network.issuerType))) fail("malformed", "the payment issuer type is invalid");
      const memo = o.memo === null ? null : textOf(o.memo, "body.memo", 0, 200, NULLABLE_MEMO);
      return { paymentId: o.paymentId, amountUsd, network: { chainId, tokenContract: network.tokenContract.toLowerCase(), decimals, issuerType: network.issuerType }, memo } satisfies P2pPaymentRequestBody;
    }
    case "status": {
      assertKeys(o, ["state", "approvalId", "requestHash", "approvalState"], "body");
      if (o.state !== "query" && o.state !== "report") fail("malformed", "the status state is not query/report");
      if (o.approvalId !== null && !isHex32(o.approvalId)) fail("malformed", "the status approval id is invalid");
      if (o.requestHash !== null && !isHex64(o.requestHash)) fail("malformed", "the status request hash is invalid");
      if (o.approvalId === null && o.requestHash === null) fail("malformed", "a status message needs an approval or request id");
      if (!["unknown", "pending", "approved", "delivering", "delivered", "revoked", "expired"].includes(String(o.approvalState))) {
        fail("malformed", "the status approval state is not in the allow-list");
      }
      return {
        state: o.state,
        approvalId: o.approvalId as string | null,
        requestHash: o.requestHash as string | null,
        approvalState: o.approvalState,
      } satisfies P2pStatusBody;
    }
    case "credit_updated": {
      assertKeys(o, ["creditId", "consumerNodeId", "fundsClass", "amountUsd", "state"], "body");
      if (!isHex32(o.creditId)) fail("malformed", "the credit id is invalid");
      const consumerNodeId = textOf(o.consumerNodeId, "body.consumerNodeId", 8, 64);
      if (!isValidNodeId(consumerNodeId)) fail("malformed", "the credit consumer node id is invalid");
      if (o.fundsClass !== "test" && o.fundsClass !== "main") fail("malformed", "the credit funds class is invalid");
      const amountUsd = numberInRange(o.amountUsd, "body.amountUsd", 0, 1_000_000);
      if (!["observed", "credited", "failed"].includes(String(o.state))) fail("malformed", "the credit state is not in the allow-list");
      return { creditId: o.creditId, consumerNodeId, fundsClass: o.fundsClass, amountUsd, state: o.state } satisfies P2pCreditUpdatedBody;
    }
  }
  return fail("unsupported_type", "the envelope type is not in the allow-list");
}

// --- construction ------------------------------------------------------------

/** A deterministic, content-addressed handle for a request document. */
export function requestHashOf(request: P2pRequestDocument): string {
  return sha256Hex(canonicalJson(request));
}

/** SHA-256 of the Gateway Key. Stored; the key itself never is. */
export function keyHashOf(key: string): string {
  return sha256Hex(Buffer.from(key, "utf8"));
}

/**
 * The authorization hash binds the whole authorization **except the key and the
 * local creation timestamp** plus the key hash, so a swapped key cannot keep the
 * same approval identity, while re-reading the same key at send time (and after
 * a restart) still produces the same hash.
 */
export function authorizationHashOf(document: Omit<P2pAuthorizationDocument, "key">, keyHash: string): string {
  // Both createdAt and key are local-only; the wire binds neither. The key is
  // stripped defensively because a caller may pass the sealed document itself.
  const { createdAt: _createdAt, ...rest } = document as Omit<P2pAuthorizationDocument, "key"> & { key?: string };
  const { key: _key, ...bound } = rest as { key?: string } & Record<string, unknown>;
  void _createdAt;
  void _key;
  return sha256Hex(canonicalJson({ domain: "ohmyaihub/p2p/authorization/v2", document: bound, keyHash }));
}

/** Validates the unsealed authorization document (receiver side). */
export function validateAuthorizationDocument(raw: unknown): P2pAuthorizationDocument {
  const o = objectOf(raw, "authorization");
  assertKeys(
    o,
    ["schema", "createdAt", "provider", "consumer", "approvalId", "requestHash", "models", "capUsd", "quote", "keyId", "keyName", "keyHash", "key"],
    "authorization",
  );
  if (o.schema !== "ohmyaihub.authorization/v2") fail("malformed", "not an ohmyaihub.authorization/v2 document");
  timeMs(o.createdAt, "authorization.createdAt");
  const provider = objectOf(o.provider, "authorization.provider");
  assertKeys(provider, ["nodeId", "mappedCidr", "gatewayPort"], "authorization.provider");
  if (!isValidNodeId(provider.nodeId)) fail("malformed", "the authorization provider node id is invalid");
  if (!isValidMappedCidr(provider.mappedCidr)) fail("malformed", "the authorization provider address is invalid");
  const gatewayPort = integerInRange(provider.gatewayPort, "authorization.provider.gatewayPort", 1, 65535);
  const consumer = objectOf(o.consumer, "authorization.consumer");
  assertKeys(consumer, ["nodeId", "fingerprint"], "authorization.consumer");
  if (!isValidNodeId(consumer.nodeId)) fail("malformed", "the authorization consumer node id is invalid");
  if (!isHex64(consumer.fingerprint)) fail("malformed", "the authorization consumer fingerprint is invalid");
  if (!isHex32(o.approvalId)) fail("malformed", "the authorization approval id is invalid");
  if (!isHex64(o.requestHash)) fail("malformed", "the authorization request hash is invalid");
  const models = modelListOf(o.models, "authorization.models");
  const capUsd = capOnGridOf(o.capUsd, "authorization.capUsd");
  const quote = objectOf(o.quote, "authorization.quote");
  assertKeys(quote, ["contentHash", "identityFingerprint", "priceVersion", "priceLocked"], "authorization.quote");
  if (!isHex64(quote.contentHash) || !isHex64(quote.identityFingerprint) || !isHex64(quote.priceVersion)) {
    fail("quote_mismatch", "the authorization quote binding is incomplete");
  }
  if (quote.priceLocked !== false) fail("quote_mismatch", "B1 never claims a locked price");
  textOf(o.keyId, "authorization.keyId", 1, 128, KEY_ID_RE);
  textOf(o.keyName, "authorization.keyName", 1, 128, KEY_NAME_RE);
  if (!isHex64(o.keyHash)) fail("malformed", "the authorization key hash is invalid");
  const key = textOf(o.key, "authorization.key", 8, 512);
  if (/\s/.test(key)) fail("malformed", "the authorization key contains whitespace");
  if (keyHashOf(key) !== o.keyHash) fail("malformed", "the authorization key does not match its hash");

  const document: P2pAuthorizationDocument = {
    schema: "ohmyaihub.authorization/v2",
    createdAt: o.createdAt,
    provider: { nodeId: provider.nodeId, mappedCidr: provider.mappedCidr, gatewayPort },
    consumer: { nodeId: consumer.nodeId, fingerprint: consumer.fingerprint },
    approvalId: o.approvalId,
    requestHash: o.requestHash,
    models,
    capUsd,
    quote: {
      contentHash: quote.contentHash,
      identityFingerprint: quote.identityFingerprint,
      priceVersion: quote.priceVersion,
      priceLocked: false,
    },
    keyId: o.keyId,
    keyName: o.keyName,
    keyHash: o.keyHash,
    key,
  };
  // A Gateway Key is the one secret allowed in this document; everything else
  // must still be free of credential material. The key field is excluded from
  // the check by construction, not by setting it to undefined (the field-name
  // rule would still see it).
  assertNoSecretMaterial(
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
    "authorization",
  );
  return document;
}
