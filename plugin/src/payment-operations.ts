// Durable payment-operation journal: the local, single-winner record of one
// outbound testnet ERC-20 payment attempt.
//
// Why this file exists
// --------------------
// The external-wallet adapter (plugin/console/external-wallet.js, PR #30) can
// only send when the service injects an `operationPort` with
//   reserve / markBroadcasting / recordHash / recordUnknown / query.
// Its in-memory preview map cannot survive a refresh, a second tab, a new
// session or a crash. A browser `localStorage` key cannot make the claim atomic
// across two senders either. So the authoritative order is kept here: one
// SQLite row per locally verified payment intent, claimed in one IMMEDIATE
// transaction, moved to `broadcasting` with a compare-and-swap before the
// wallet is called, and never moved back to a sendable state by an automatic
// timeout.
//
// What this module is NOT
// -----------------------
//  - It does not sign, hold keys, build a wallet, or send a transaction.
//  - It does not credit a ledger, reserve a Magpie cap, or interpret a receipt.
//  - It does not open a socket, start an HTTP server, or act as a proxy. It is
//    constructed in-process by the authenticated local service owner; a
//    constructor "capability" is never a network authorization. A future HTTP
//    API still needs its own CSRF token, exact UUID-action allowlist and local
//    authentication; this module deliberately exposes none of that.
//  - It does not accept P2P input as the source of truth for recipient, amount,
//    asset or price. The binding passed to `operationPort()` must be built from
//    the service's already-verified intent, and the journal refuses a changed
//    recipient/amount/asset/calldata for the same invoice.
//
// Safety invariants (each is covered by plugin/test/payment-operations.test.ts)
// ---------------------------------------------------------------------------
//  1. `reserve` is a single-winner atomic claim on the stable intent key
//     (`invoice` + authenticated consumer address), never on a preview UUID.
//     The first caller gets `state:"reserved"`; every later caller gets the
//     current state, or `"claimed"` while a reservation is live. Only an
//     explicit, evidenced release makes the row claimable again.
//  2. `markBroadcasting` is the send gate: a CAS from `reserved` to
//     `broadcasting` that also matches `reservationId` and the exact operation
//     payload. It commits (SQLite synchronous=FULL, WAL) before returning. If it
//     throws, the wallet must not be called; if it returns, a crash can only
//     ever leave the row at `broadcasting`, which is not sendable again.
//  3. `recordHash` and `recordUnknown` are compare-and-swap too. A hash already
//     stored is never overwritten with a different hash; `recordUnknown` never
//     downgrades a row that already has a hash.
//  4. `unknown` (timeout, RPC error, invalid hash, ...) is terminal for sending.
//     A wallet user-rejection (4001 / ACTION_REJECTED / USER_REJECTED) is also
//     recorded as `unknown` first. Only the service owner, after it has
//     established that nothing was broadcast (chain/node/wallet evidence), may
//     release that one row for a new explicit user confirmation. There is no
//     browser release API and no automatic release.
//  5. Mainnet 56/8453 and every chain outside the hard testnet allowlist
//     (97/84532; 31337 only when the isolated-test option is passed) are refused
//     before any row is written, regardless of UI/env/registry flags. A manual
//     "confirmation" cannot bypass this.
//  6. Only public payment metadata is stored: invoice id, public addresses,
//     chain/asset tuple, amount, intent/calldata hashes, state, optional public
//     tx hash, sanitized reason. No seed, private key, signature or raw
//     transaction is accepted or stored; unknown input fields are rejected.
//  7. The DB is created 0600 in a 0700 directory, with WAL and
//     `synchronous=FULL`, so a commit is durable before the wallet is touched.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fromHex, keccak256Hex } from "./keccak.ts";
import { statePath } from "./paths.ts";
import { assetIdOf, type NetworkRegistry } from "./networks.ts";

/* ------------------------------------------------------------------ */
/* Fixed contract and hard chain gate                                  */
/* ------------------------------------------------------------------ */

/** Schema of the operation object produced by the external-wallet adapter. */
export const EXTERNAL_WALLET_OPERATION_SCHEMA = "ohmyaihub.external-wallet.operation/v1";

/** The journal's own persisted row version (also the SQLite `user_version`). */
export const PAYMENT_OPERATION_DB_VERSION = 3;

/** The only chains a payment may be authorised on, independent of any flag. */
export const SENDABLE_TESTNET_CHAIN_IDS = Object.freeze([97, 84532] as const);

/** Mainnet ids the module refuses outright, before any registry/UI check. */
export const HARD_BLOCKED_MAINNET_CHAIN_IDS = Object.freeze([56, 8453] as const);

/** A local Anvil chain is usable only via the explicit isolated-test option. */
export const ISOLATED_TEST_CHAIN_ID = 31337;

/** Fixed ERC-20 `transfer(address,uint256)` selector. */
export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

const HEX_32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const REASON_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;
const TEXT_ID = /^[A-Za-z0-9._:@+/=-]{1,128}$/;
const FINGERPRINT = /^[A-Za-z0-9._:@+/=-]{1,200}$/;

/** Reasons that mean "the wallet itself refused"; still recorded as unknown. */
const WALLET_REJECTION_REASONS = new Set(["USER_REJECTED", "4001", "ACTION_REJECTED"]);

/**
 * Unknown release is closed for this integration round. The journal can prove
 * that a `reserved` row was never marked broadcasting; it cannot prove that a
 * wallet attempt recorded as `unknown` did not broadcast. Reopening requires a
 * fresh, independently observed no-broadcast proof (chain nonce / node mempool
 * / wallet pending set) and a retry UI that creates a new preview. Keep the
 * implementation for that later unit but refuse at the API surface now.
 */
const UNKNOWN_RELEASE_ENABLED = false;

/** A no-broadcast observation older than this cannot clear a current attempt. */
const RELEASE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** All three provider spellings mean the same safety class: the wallet refused. */
function rejectionKind(value: string): "wallet-user-rejection" | null {
  return WALLET_REJECTION_REASONS.has(value) ? "wallet-user-rejection" : null;
}

const OPERATION_FIELDS = [
  "schema",
  "intentHash",
  "account",
  "chainId",
  "assetId",
  "contractAddress",
  "recipientAddress",
  "amountRaw",
  "calldata",
  "calldataHash",
] as const;

const BINDING_FIELDS = [
  "invoice",
  "consumerAddress",
  "providerIdentityFingerprint",
  "authorizationGeneration",
  "intentHash",
  "chainId",
  "assetId",
  "contractAddress",
  "decimals",
  "recipientAddress",
  "amountRaw",
  "calldataHash",
  "expiresAtMs",
] as const;

export type PaymentOperationState = "reserved" | "broadcasting" | "broadcast" | "unknown" | "released";

/**
 * A send authorization produced by the Service from a locally verified payment
 * intent. Every field except the derived hashes is copied from that intent.
 *
 * `invoice` is the stable intent id: a new preview UUID, a new browser tab or a
 * new wallet session must not become a new payment. `intentHash` is optional in
 * the external-wallet protocol; when the local intent has one it must be passed
 * through unchanged, and when it has none `null` must be passed. A per-preview
 * hash is rejected rather than treated as a new operation.
 */
export interface PaymentBinding {
  invoice: string;
  /** Public address of the consumer wallet authenticated by the local service. */
  consumerAddress: string;
  /** Fingerprint of the provider identity the local service accepted. */
  providerIdentityFingerprint: string;
  /** Monotonic local authorization epoch that accepted that identity. */
  authorizationGeneration: number;
  /** The verified intent hash, or null when the intent carries none. */
  intentHash: string | null;
  chainId: number;
  /** `eip155:<chainId>:<contract>` of the testnet asset being sent. */
  assetId: string;
  contractAddress: string;
  decimals: number;
  recipientAddress: string;
  /** Exact base units, decimal string; never a float or a display amount. */
  amountRaw: string;
  /** keccak256 of the exact fixed ERC-20 transfer calldata. */
  calldataHash: string;
  /** Absolute expiry of the verified quote/intent, milliseconds since epoch. */
  expiresAtMs: number;
}

/** The exact object the external-wallet adapter passes to the port. */
export interface ExternalWalletOperation {
  schema: string;
  intentHash: string | null;
  account: string;
  chainId: number;
  assetId: string;
  contractAddress: string;
  recipientAddress: string;
  amountRaw: string;
  calldata: string;
  calldataHash: string;
}

export interface PaymentReservation {
  reservationId: string;
  /**
   * `reserved` is the only value that permits sending. `claimed` means "this
   * intent is already claimed by a live reservation"; the other values are the
   * persisted terminal/in-flight state. The external-wallet adapter refuses
   * every value except `reserved`.
   */
  state: "reserved" | "claimed" | "broadcasting" | "broadcast" | "unknown";
  hash: string | null;
  attempt: number;
  reason: string | null;
  blocked: boolean;
}

export interface PaymentOperationRecord {
  idemKey: string;
  reservationId: string;
  attempt: number;
  state: PaymentOperationState;
  /** Hash of the exact operation tuple (identity/generation and payment fields). */
  payloadHash: string;
  invoice: string;
  consumerAddress: string;
  providerIdentityFingerprint: string;
  authorizationGeneration: number;
  intentHash: string | null;
  chainId: number;
  assetId: string;
  contractAddress: string;
  decimals: number;
  recipientAddress: string;
  amountRaw: string;
  calldataHash: string;
  expiresAtMs: number;
  txHash: string | null;
  /** Every known hash for this operation (canonical first). */
  hashes: readonly string[];
  reason: string | null;
  recoveredFromUnknown: boolean;
  ownerInstanceId: string;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
}

export interface PaymentOperationQuery {
  state: PaymentOperationState;
  hash: string | null;
  hashes: readonly string[];
  reason: string | null;
  attempt: number;
  expiresAtMs: number;
  updatedAt: string;
  retryable: boolean;
}

/**
 * Narrow read-only asset check. The production implementation is
 * `networkRegistryAssetResolver()` below; it returns the registry's own record
 * fields, so the journal compares contract/chain/decimals/asset id and never
 * trusts a caller-supplied "trusted" boolean.
 */
export interface PaymentAssetEvidence {
  chainId: number;
  assetId: string;
  contractAddress: string;
  decimals: number;
  networkType: "testnet";
}

export interface PaymentAssetRegistry {
  resolveSendableAsset(input: {
    chainId: number;
    assetId: string;
    contractAddress: string;
    decimals: number;
  }): PaymentAssetEvidence | null;
}

/**
 * Narrow identity/authorization check. The Service implements this against its
 * own authenticated consumer session and accepted provider registration; the
 * journal calls it before claiming and again before the send gate. A changed
 * fingerprint/epoch, a revoked invoice, or an unknown consumer fails closed.
 */
export interface PaymentIdentityAuthority {
  assertCurrent(input: {
    invoice: string;
    payloadHash: string;
    consumerAddress: string;
    providerIdentityFingerprint: string;
    authorizationGeneration: number;
    intentHash: string | null;
    chainId: number;
    assetId: string;
    contractAddress: string;
    decimals: number;
    recipientAddress: string;
    amountRaw: string;
    calldataHash: string;
  }): void | Promise<void>;
}

/** A fresh, independent observation that the operation did not reach a chain/node. */
export interface NoBroadcastObservation {
  /**
   * `provider-response` is deliberately absent: a wallet/provider 4001 is the
   * same source that created the unknown row and cannot prove its own absence
   * from the chain. `service-flow` is only valid for a `reserved` row, where
   * `markBroadcasting` was never committed.
   */
  method: "service-flow" | "chain-nonce" | "node-mempool" | "wallet-pending-set";
  observedAt: string;
  /** Opaque public reference; stored hashed, never raw. */
  reference: string;
}

/** Evidence the Service must supply before a not-sent reservation is released. */
export interface UnsentReleaseEvidence {
  basis: "owner-restarted-before-broadcast" | "service-recovered-unsent";
  confirmedNoBroadcast: true;
  /** The current journal owner; a release is never anonymous. */
  releasedByOwnerInstanceId: string;
  noBroadcastObservation: NoBroadcastObservation;
  /** Required when basis is `owner-restarted-before-broadcast`. */
  previousOwnerInstanceId?: string;
}

/**
 * Evidence the Service must supply before a wallet-rejected unknown may be
 * released. 4001 alone is not proof: the Service must also state how it
 * established that nothing reached the chain/node/wallet pending set.
 */
export interface RejectedUnknownReleaseEvidence {
  basis: "wallet-user-rejection";
  providerCode: "4001" | "ACTION_REJECTED" | "USER_REJECTED";
  confirmedNoBroadcast: true;
  userConfirmedRetry: true;
  releasedByOwnerInstanceId: string;
  noBroadcastObservation: NoBroadcastObservation;
}

export type PaymentOperationErrorCode =
  | "PAYMENT_OPERATION_INVALID_BINDING"
  | "PAYMENT_OPERATION_INVALID_OPERATION"
  | "PAYMENT_OPERATION_INVALID_ARGUMENT"
  | "PAYMENT_OPERATION_MAINNET_BLOCKED"
  | "PAYMENT_OPERATION_CHAIN_NOT_ALLOWED"
  | "PAYMENT_OPERATION_ASSET_NOT_TRUSTED"
  | "PAYMENT_OPERATION_IDENTITY_STALE"
  | "PAYMENT_OPERATION_EXPIRED"
  | "PAYMENT_OPERATION_PAYLOAD_MISMATCH"
  | "PAYMENT_OPERATION_NOT_FOUND"
  | "PAYMENT_OPERATION_NOT_RESERVED"
  | "PAYMENT_OPERATION_RESERVATION_MISMATCH"
  | "PAYMENT_OPERATION_NOT_BROADCASTING"
  | "PAYMENT_OPERATION_HASH_CONFLICT"
  | "PAYMENT_OPERATION_RELEASE_REFUSED"
  | "PAYMENT_OPERATION_BUSY"
  | "PAYMENT_OPERATION_CLOSED"
  | "PAYMENT_OPERATION_DB_VERSION";

export class PaymentOperationError extends Error {
  readonly code: PaymentOperationErrorCode;

  constructor(code: PaymentOperationErrorCode, message: string) {
    super(message);
    this.name = "PaymentOperationError";
    this.code = code;
  }
}

function fail(code: PaymentOperationErrorCode, message: string): never {
  throw new PaymentOperationError(code, message);
}

/* ------------------------------------------------------------------ */
/* Canonicalisation, hashing and fixed calldata                        */
/* ------------------------------------------------------------------ */

/** Deterministic JSON: object keys sorted, `undefined` omitted. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PAYMENT_OPERATION_INVALID_ARGUMENT", `${label} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", `${label} contains an unsupported field: ${key.slice(0, 32)}`);
    }
  }
  for (const key of allowed) {
    if (!(key in value)) fail("PAYMENT_OPERATION_INVALID_ARGUMENT", `${label} is missing ${key}`);
  }
}

function textId(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string") fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\x00-\x1f\x7f]/.test(trimmed)) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} is empty, too long or contains control characters`);
  }
  return trimmed;
}

function publicAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} must be a 20-byte hex address`);
  }
  const lower = value.toLowerCase();
  if (lower === ZERO_ADDRESS) fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} must not be the zero address`);
  return lower;
}

function hex32(value: unknown, label: string, code: "PAYMENT_OPERATION_INVALID_BINDING" | "PAYMENT_OPERATION_INVALID_OPERATION" = "PAYMENT_OPERATION_INVALID_BINDING"): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(code, `${label} must be a 32-byte hex value`);
  }
  return value.toLowerCase();
}

function optionalHex32(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return hex32(value, label);
}

function uint(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} must be an integer between 0 and ${max}`);
  }
  return value;
}

function amountRaw(value: unknown, label: string): string {
  if (typeof value !== "string" || !UINT_DECIMAL.test(value) || value === "0") {
    fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} must be a positive base-unit decimal string`);
  }
  if (BigInt(value) > (1n << 256n) - 1n) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} exceeds uint256`);
  }
  return value;
}

function chainIdOf(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", `${label} must be a positive integer`);
  }
  return value;
}

function canonicalAssetId(
  value: unknown,
  chainId: number,
  contractAddress: string,
  code: "PAYMENT_OPERATION_INVALID_BINDING" | "PAYMENT_OPERATION_INVALID_OPERATION" = "PAYMENT_OPERATION_INVALID_BINDING",
): string {
  if (typeof value !== "string") fail(code, "assetId must be a string");
  const match = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(value);
  if (!match) fail(code, "assetId must be eip155:<chainId>:<contract>");
  const parsedChain = Number(match[1]);
  const parsedContract = match[2].toLowerCase();
  if (parsedChain !== chainId) fail(code, "assetId chain does not match chainId");
  if (parsedContract !== contractAddress) fail(code, "assetId contract does not match contractAddress");
  return assetIdOf(chainId, contractAddress);
}

function transferWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** Exact fixed ERC-20 transfer calldata; no caller-chosen selector or calldata. */
export function erc20TransferCalldata(recipientAddress: string, rawAmount: string): string {
  const recipient = publicAddress(recipientAddress, "recipientAddress");
  const amount = amountRaw(rawAmount, "amountRaw");
  return `${ERC20_TRANSFER_SELECTOR}${recipient.slice(2).padStart(64, "0")}${transferWord(BigInt(amount))}`;
}

export function erc20TransferCalldataHash(recipientAddress: string, rawAmount: string): string {
  return keccak256Hex(fromHex(erc20TransferCalldata(recipientAddress, rawAmount)));
}

/** Decode and re-encode the fixed transfer shape; null means "not our call". */
function decodeTransferCalldata(calldata: string): { recipientAddress: string; amountRaw: string } | null {
  if (typeof calldata !== "string" || !/^0x[0-9a-fA-F]{136}$/.test(calldata)) return null;
  const lower = calldata.toLowerCase();
  if (!lower.startsWith(ERC20_TRANSFER_SELECTOR)) return null;
  // The first 12 bytes of the 32-byte address word must be zero; the address
  // itself is the last 20 bytes. Re-encoding below proves the whole shape.
  const recipient = `0x${lower.slice(34, 74)}`;
  if (!ADDRESS.test(recipient) || recipient === ZERO_ADDRESS) return null;
  const amount = BigInt(`0x${lower.slice(74)}`);
  if (amount <= 0n) return null;
  const encoded = erc20TransferCalldata(recipient, amount.toString());
  return encoded.toLowerCase() === lower ? { recipientAddress: recipient, amountRaw: amount.toString() } : null;
}

/** Stable operation key: never includes a preview UUID, reservation or intent hash. */
export function paymentIdempotencyKey(input: {
  invoice: string;
  consumerAddress: string;
  /** Stable provider/node identity; two providers' local invoice ids must not collide. */
  providerIdentityFingerprint: string;
}): string {
  assertPlainObject(input, "paymentIdempotencyKey");
  const invoice = textId(input.invoice, "invoice");
  const consumerAddress = publicAddress(input.consumerAddress, "consumerAddress");
  if (typeof input.providerIdentityFingerprint !== "string" || !FINGERPRINT.test(input.providerIdentityFingerprint)) {
    fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "providerIdentityFingerprint is not a bounded opaque id");
  }
  return sha256(
    `ohmyaihub.payment-operation/idem/v2\n${canonicalJson({
      invoice,
      consumerAddress,
      providerIdentityFingerprint: input.providerIdentityFingerprint,
    })}`,
  );
}

/* ------------------------------------------------------------------ */
/* Normalised binding and operation                                    */
/* ------------------------------------------------------------------ */

interface NormalizedBinding {
  invoice: string;
  consumerAddress: string;
  providerIdentityFingerprint: string;
  authorizationGeneration: number;
  intentHash: string | null;
  chainId: number;
  assetId: string;
  contractAddress: string;
  decimals: number;
  recipientAddress: string;
  amountRaw: string;
  calldataHash: string;
  expiresAtMs: number;
}

interface NormalizedOperation {
  intentHash: string | null;
  account: string;
  chainId: number;
  assetId: string;
  contractAddress: string;
  recipientAddress: string;
  amountRaw: string;
  calldataHash: string;
}

function normalizeBinding(raw: PaymentBinding): NormalizedBinding {
  assertPlainObject(raw, "payment binding");
  assertExactKeys(raw as unknown as Record<string, unknown>, BINDING_FIELDS, "payment binding");
  const invoice = textId(raw.invoice, "invoice");
  if (!TEXT_ID.test(invoice)) fail("PAYMENT_OPERATION_INVALID_BINDING", "invoice contains unsupported characters");
  const consumerAddress = publicAddress(raw.consumerAddress, "consumerAddress");
  if (typeof raw.providerIdentityFingerprint !== "string" || !FINGERPRINT.test(raw.providerIdentityFingerprint)) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", "providerIdentityFingerprint is not a bounded opaque id");
  }
  const authorizationGeneration = uint(raw.authorizationGeneration, "authorizationGeneration", Number.MAX_SAFE_INTEGER);
  if (authorizationGeneration < 1) fail("PAYMENT_OPERATION_INVALID_BINDING", "authorizationGeneration must be at least 1");
  const intentHash = optionalHex32(raw.intentHash, "intentHash");
  const chainId = chainIdOf(raw.chainId, "chainId");
  const contractAddress = publicAddress(raw.contractAddress, "contractAddress");
  const recipientAddress = publicAddress(raw.recipientAddress, "recipientAddress");
  const decimals = uint(raw.decimals, "decimals", 36);
  const amount = amountRaw(raw.amountRaw, "amountRaw");
  const calldataHash = hex32(raw.calldataHash, "calldataHash");
  const expectedHash = erc20TransferCalldataHash(recipientAddress, amount);
  if (calldataHash !== expectedHash) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", "calldataHash is not the hash of the fixed transfer for this recipient and amount");
  }
  if (typeof raw.expiresAtMs !== "number" || !Number.isSafeInteger(raw.expiresAtMs) || raw.expiresAtMs <= 0) {
    fail("PAYMENT_OPERATION_INVALID_BINDING", "expiresAtMs must be a positive integer");
  }
  return Object.freeze({
    invoice,
    consumerAddress,
    providerIdentityFingerprint: raw.providerIdentityFingerprint,
    authorizationGeneration,
    intentHash,
    chainId,
    assetId: canonicalAssetId(raw.assetId, chainId, contractAddress),
    contractAddress,
    decimals,
    recipientAddress,
    amountRaw: amount,
    calldataHash,
    expiresAtMs: raw.expiresAtMs,
  });
}

function normalizeOperation(raw: ExternalWalletOperation): NormalizedOperation {
  assertPlainObject(raw, "external wallet operation");
  assertExactKeys(raw as unknown as Record<string, unknown>, OPERATION_FIELDS, "external wallet operation");
  if (raw.schema !== EXTERNAL_WALLET_OPERATION_SCHEMA) {
    fail("PAYMENT_OPERATION_INVALID_OPERATION", "operation schema is not the external-wallet v1 schema");
  }
  const account = publicAddress(raw.account, "account");
  const chainId = chainIdOf(raw.chainId, "chainId");
  const contractAddress = publicAddress(raw.contractAddress, "contractAddress");
  const recipientAddress = publicAddress(raw.recipientAddress, "recipientAddress");
  const amount = amountRaw(raw.amountRaw, "amountRaw");
  const intentHash = optionalHex32(raw.intentHash, "intentHash");
  const calldataHash = hex32(raw.calldataHash, "calldataHash", "PAYMENT_OPERATION_INVALID_OPERATION");
  const decoded = decodeTransferCalldata(raw.calldata);
  if (!decoded) fail("PAYMENT_OPERATION_INVALID_OPERATION", "calldata is not the fixed ERC-20 transfer(address,uint256) shape");
  const computed = keccak256Hex(fromHex(raw.calldata));
  if (computed !== calldataHash) {
    fail("PAYMENT_OPERATION_INVALID_OPERATION", "calldataHash does not match calldata");
  }
  if (decoded.recipientAddress !== recipientAddress) {
    fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "calldata recipient does not match recipientAddress");
  }
  if (decoded.amountRaw !== amount) {
    fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "calldata amount does not match amountRaw");
  }
  return Object.freeze({
    intentHash,
    account,
    chainId,
    assetId: canonicalAssetId(raw.assetId, chainId, contractAddress, "PAYMENT_OPERATION_INVALID_OPERATION"),
    contractAddress,
    recipientAddress,
    amountRaw: amount,
    calldataHash,
  });
}

function bindingPayloadHash(binding: NormalizedBinding): string {
  return sha256(
    `ohmyaihub.payment-operation/payload/v1\n${canonicalJson({
      intentHash: binding.intentHash,
      account: binding.consumerAddress,
      chainId: binding.chainId,
      assetId: binding.assetId,
      contractAddress: binding.contractAddress,
      decimals: binding.decimals,
      recipientAddress: binding.recipientAddress,
      amountRaw: binding.amountRaw,
      calldataHash: binding.calldataHash,
      providerIdentityFingerprint: binding.providerIdentityFingerprint,
      authorizationGeneration: binding.authorizationGeneration,
    })}`,
  );
}

/** The exact tuple every caller must echo; a changed field is not the same try. */
function operationMismatch(binding: NormalizedBinding, operation: NormalizedOperation): string | null {
  if (operation.account !== binding.consumerAddress) return "operation account is not the authenticated consumer wallet";
  if (operation.chainId !== binding.chainId) return "operation chainId does not match the verified intent";
  if (operation.assetId !== binding.assetId || operation.contractAddress !== binding.contractAddress) {
    return "operation asset does not match the verified intent";
  }
  if (operation.recipientAddress !== binding.recipientAddress) return "operation recipient does not match the verified intent";
  if (operation.amountRaw !== binding.amountRaw) return "operation amount does not match the verified intent";
  if (operation.calldataHash !== binding.calldataHash) return "operation calldata hash does not match the verified intent";
  if (operation.intentHash !== binding.intentHash) return "operation intentHash does not match the verified intent";
  return null;
}

function assertOperationMatchesBinding(binding: NormalizedBinding, operation: NormalizedOperation): void {
  const mismatch = operationMismatch(binding, operation);
  if (mismatch) fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", mismatch);
}

/* ------------------------------------------------------------------ */
/* Registry adapter                                                     */
/* ------------------------------------------------------------------ */

/**
 * Adapter from the existing NetworkRegistry to the narrow asset check.
 *
 * The hard chain allowlist is applied by the journal, not here. This adapter
 * only reports what the registry actually holds: the chain must be enabled and
 * classified `testnet`, and the asset must be enabled with exactly the chain,
 * contract and decimals the verified intent names. No caller boolean can make
 * an unregistered asset sendable.
 */
export function networkRegistryAssetResolver(registry: NetworkRegistry): PaymentAssetRegistry {
  return {
    resolveSendableAsset(input) {
      const network = registry.network(input.chainId);
      if (!network || !network.enabled || network.networkType !== "testnet") return null;
      let asset;
      try {
        asset = registry.requireEnabledAsset(input.chainId, input.contractAddress);
      } catch {
        return null;
      }
      const expectedId = assetIdOf(input.chainId, input.contractAddress);
      if (
        asset.chainId !== input.chainId ||
        asset.assetId !== expectedId ||
        asset.contractAddress.toLowerCase() !== input.contractAddress.toLowerCase() ||
        asset.decimals !== input.decimals ||
        !asset.enabled
      ) {
        return null;
      }
      return {
        chainId: asset.chainId,
        assetId: asset.assetId,
        contractAddress: asset.contractAddress.toLowerCase(),
        decimals: asset.decimals,
        networkType: "testnet",
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_operations (
  idem_key TEXT PRIMARY KEY,
  attempt INTEGER NOT NULL,
  reservation_id TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','broadcasting','broadcast','unknown','released')),
  payload_hash TEXT NOT NULL,
  invoice TEXT NOT NULL,
  consumer_address TEXT NOT NULL,
  provider_fingerprint TEXT NOT NULL,
  authorization_generation INTEGER NOT NULL,
  intent_hash TEXT,
  chain_id INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  recipient_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  calldata_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT,
  reason TEXT,
  recovered_from_unknown INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  released_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS payment_operations_state ON payment_operations(state, updated_at_ms);
CREATE TABLE IF NOT EXISTS payment_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_operation_events_key ON payment_operation_events(idem_key, id);
CREATE TABLE IF NOT EXISTS payment_operation_attempts (
  reservation_id TEXT PRIMARY KEY,
  idem_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  tx_hash TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_operation_attempts_key ON payment_operation_attempts(idem_key, attempt);
CREATE TABLE IF NOT EXISTS payment_operation_hashes (
  hash TEXT PRIMARY KEY,
  idem_key TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_operation_hashes_key ON payment_operation_hashes(idem_key, recorded_at_ms);
`;

interface OperationRow {
  idem_key: string;
  attempt: number;
  reservation_id: string;
  owner_instance_id: string;
  state: PaymentOperationState;
  payload_hash: string;
  invoice: string;
  consumer_address: string;
  provider_fingerprint: string;
  authorization_generation: number;
  intent_hash: string | null;
  chain_id: number;
  asset_id: string;
  contract_address: string;
  decimals: number;
  recipient_address: string;
  amount_raw: string;
  calldata_hash: string;
  expires_at_ms: number;
  tx_hash: string | null;
  reason: string | null;
  recovered_from_unknown: number;
  created_at_ms: number;
  updated_at_ms: number;
  released_at_ms: number | null;
}

interface AttemptRow {
  reservation_id: string;
  idem_key: string;
  attempt: number;
  payload_hash: string;
  state: PaymentOperationState;
  tx_hash: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function recordOf(row: OperationRow, hashes: readonly string[]): PaymentOperationRecord {
  return Object.freeze({
    idemKey: row.idem_key,
    reservationId: row.reservation_id,
    attempt: row.attempt,
    state: row.state,
    payloadHash: row.payload_hash,
    invoice: row.invoice,
    consumerAddress: row.consumer_address,
    providerIdentityFingerprint: row.provider_fingerprint,
    authorizationGeneration: row.authorization_generation,
    intentHash: row.intent_hash,
    chainId: row.chain_id,
    assetId: row.asset_id,
    contractAddress: row.contract_address,
    decimals: row.decimals,
    recipientAddress: row.recipient_address,
    amountRaw: row.amount_raw,
    calldataHash: row.calldata_hash,
    expiresAtMs: row.expires_at_ms,
    txHash: row.tx_hash,
    hashes: Object.freeze([...hashes]),
    reason: row.reason,
    recoveredFromUnknown: row.recovered_from_unknown === 1,
    ownerInstanceId: row.owner_instance_id,
    createdAt: iso(row.created_at_ms),
    updatedAt: iso(row.updated_at_ms),
    releasedAt: row.released_at_ms === null ? null : iso(row.released_at_ms),
  });
}

function reservationStateOf(state: PaymentOperationState): PaymentReservation["state"] {
  if (state === "reserved") return "claimed";
  if (state === "released") return "claimed";
  return state;
}

function reservationOf(row: OperationRow, state: PaymentReservation["state"], blocked: boolean): PaymentReservation {
  return Object.freeze({
    reservationId: row.reservation_id,
    state,
    hash: row.tx_hash,
    attempt: row.attempt,
    reason: row.reason,
    blocked,
  });
}

function syncSleep(ms: number): void {
  // The journal constructor is synchronous (the Service constructs it before it
  // starts serving). This is a local, bounded wait, not a retry of a payment.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* the platform has no SharedArrayBuffer; the caller's busy_timeout remains */
  }
}

/**
 * WAL is a persistent database property, so every later opener can skip the
 * write. When several processes open a fresh file at once, the first one to
 * switch the mode wins and the others wait instead of failing the constructor.
 */
function ensureWal(db: Database): void {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const current = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      if (current.toLowerCase() === "wal") return;
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (error) {
      const message = String((error as Error).message ?? error);
      if (!/locked|busy/i.test(message) || attempt === 39) throw error;
      syncSleep(25 + attempt * 10);
    }
  }
}

function sanitizeReason(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return "UNKNOWN";
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 64);
  return REASON_TEXT.test(cleaned) ? cleaned : "UNKNOWN";
}

function sanitizeReference(value: unknown): string {
  if (typeof value !== "string") fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "release evidence reference must be a string");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\x00-\x1f\x7f]/.test(trimmed)) {
    fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "release evidence reference is empty, too long or contains control characters");
  }
  return trimmed;
}

function payloadHashOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "release must name the exact 32-byte payload hash it inspected");
  }
  return value;
}

function observedAtOf(
  value: unknown,
  nowMs: number,
  options: { notBeforeMs?: number; maxAgeMs?: number; code?: PaymentOperationErrorCode } = {},
): { iso: string; ms: number } {
  const code = options.code ?? "PAYMENT_OPERATION_INVALID_ARGUMENT";
  if (typeof value !== "string") fail(code, "release evidence observedAt must be an ISO timestamp");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > nowMs + 60_000) {
    fail(code, "release evidence observedAt is invalid or in the future");
  }
  if (options.notBeforeMs !== undefined && parsed < options.notBeforeMs) {
    fail("PAYMENT_OPERATION_RELEASE_REFUSED", "release evidence was observed before the state it is meant to clear");
  }
  if (options.maxAgeMs !== undefined && nowMs - parsed > options.maxAgeMs) {
    fail("PAYMENT_OPERATION_RELEASE_REFUSED", "release evidence is stale; observe again before releasing");
  }
  return { iso: new Date(parsed).toISOString(), ms: parsed };
}

/** Public record shape for docs/tests; no stored field is a secret. */
export function paymentOperationDefaultPath(): string {
  return statePath("payment-operations.sqlite");
}

export interface OpenPaymentOperationJournalOptions {
  path?: string;
  ownerInstanceId: string;
  assetRegistry: PaymentAssetRegistry;
  identityAuthority: PaymentIdentityAuthority;
  now?: () => number;
  /**
   * Tests only. The only accepted value is 31337; 56/8453 are refused before
   * this option is even considered, and ordinary construction never enables it.
   */
  isolatedTestChains?: readonly number[];
}

export function openPaymentOperationJournal(options: OpenPaymentOperationJournalOptions): PaymentOperationJournal {
  return new PaymentOperationJournal(options);
}

export class PaymentOperationJournal {
  private readonly statePathValue: string;
  private readonly ownerValue: string;
  private readonly db: Database;
  private readonly assetRegistry: PaymentAssetRegistry;
  private readonly identityAuthority: PaymentIdentityAuthority;
  private readonly now: () => number;
  private readonly allowedChains: ReadonlySet<number>;
  private closed = false;

  constructor(options: OpenPaymentOperationJournalOptions) {
    assertPlainObject(options, "payment journal options");
    const owner = textId(options.ownerInstanceId, "ownerInstanceId", 128);
    if (!options.assetRegistry || typeof options.assetRegistry.resolveSendableAsset !== "function") {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "an injected payment asset registry is required");
    }
    if (!options.identityAuthority || typeof options.identityAuthority.assertCurrent !== "function") {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "an injected payment identity authority is required");
    }
    const now = options.now ?? (() => Date.now());
    if (typeof now !== "function") fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "now must be a function");

    const chains = new Set<number>(SENDABLE_TESTNET_CHAIN_IDS);
    const isolated = options.isolatedTestChains ?? [];
    if (!Array.isArray(isolated)) fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "isolatedTestChains must be an array");
    for (const chain of isolated) {
      if (chain === ISOLATED_TEST_CHAIN_ID) chains.add(chain);
      else fail("PAYMENT_OPERATION_CHAIN_NOT_ALLOWED", `isolatedTestChains may only contain ${ISOLATED_TEST_CHAIN_ID}`);
    }
    for (const mainnet of HARD_BLOCKED_MAINNET_CHAIN_IDS) {
      if (chains.has(mainnet)) fail("PAYMENT_OPERATION_MAINNET_BLOCKED", `mainnet ${mainnet} can never be a payment chain`);
    }

    const path = options.path ?? paymentOperationDefaultPath();
    if (typeof path !== "string" || !path.trim()) fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "path must be a non-empty string");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.statePathValue = path;
    this.ownerValue = owner;
    this.assetRegistry = options.assetRegistry;
    this.identityAuthority = options.identityAuthority;
    this.now = now;
    this.allowedChains = chains;
    this.db = new Database(path, { create: true });
    // busy_timeout first: another process may be switching/validating WAL while
    // this connection opens. The journal-mode call is still a write operation.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    ensureWal(this.db);
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > PAYMENT_OPERATION_DB_VERSION) {
      this.db.close();
      fail("PAYMENT_OPERATION_DB_VERSION", `payment journal schema ${version} is newer than this build`);
    }
    this.db.exec(SCHEMA);
    if (version < 3) {
      // The stable key now includes the provider identity. Silently reusing a
      // row created under the old provider-agnostic key could let the same
      // invoice from another provider coexist; refuse and require an explicit
      // migration instead of merging or duplicating behind the caller's back.
      const existing = this.db.query("SELECT COUNT(*) AS n FROM payment_operations").get() as { n: number };
      if (existing.n > 0) {
        this.db.close();
        fail(
          "PAYMENT_OPERATION_DB_VERSION",
          "existing payment journal rows use the provider-agnostic key; refusing to migrate them silently",
        );
      }
    }
    const columns = this.db.query("PRAGMA table_info(payment_operations)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "expires_at_ms")) {
      this.db.exec("ALTER TABLE payment_operations ADD COLUMN expires_at_ms INTEGER NOT NULL DEFAULT 0;");
    }
    const duplicate = this.db
      .query("SELECT tx_hash FROM payment_operations WHERE tx_hash IS NOT NULL GROUP BY tx_hash HAVING COUNT(*) > 1 LIMIT 1")
      .get() as { tx_hash: string } | null;
    if (duplicate) {
      this.db.close();
      fail("PAYMENT_OPERATION_DB_VERSION", "existing payment journal has duplicate transaction hashes; refusing to open");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS payment_operations_tx_hash_unique ON payment_operations(tx_hash) WHERE tx_hash IS NOT NULL;");
    if (version < PAYMENT_OPERATION_DB_VERSION) this.db.exec(`PRAGMA user_version = ${PAYMENT_OPERATION_DB_VERSION};`);
    this.secureFiles();
  }

  /** Read-only runtime accessors: assignment cannot silently change identity. */
  get path(): string {
    return this.statePathValue;
  }

  get ownerInstanceId(): string {
    return this.ownerValue;
  }

  /**
   * SQLite's WAL and SHM sidecars contain pages of the same payment metadata.
   * They are created with the process umask, so a normal 022 umask would leave
   * them 0644 even though the main database is 0600. Keep all three private.
   * Only the files are chmodded: the caller may have chosen a shared directory,
   * and changing that directory's mode is not this module's business.
   */
  private secureFiles(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(`${this.path}${suffix}`, 0o600);
      } catch {
        /* the sidecar does not exist yet, or the filesystem has no POSIX modes */
      }
    }
  }

  /** Diagnostic values for the evidence report; reads no row content. */
  diagnostics(): { path: string; journalMode: string; synchronous: number; foreignKeys: number; fileMode: number | null } {
    this.requireOpen();
    const mode = (this.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const synchronous = (this.db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    const foreignKeys = (this.db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    let fileMode: number | null = null;
    try {
      if (existsSync(this.path)) fileMode = statSync(this.path).mode & 0o777;
    } catch {
      /* a test may inspect a path on another filesystem */
    }
    return { path: this.path, journalMode: mode, synchronous, foreignKeys, fileMode };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** The chains this instance may authorise, for a status page and tests. */
  chainIds(): number[] {
    return [...this.allowedChains].sort((a, b) => a - b);
  }

  /** Stable key for an invoice, so the service can look a row up after restart. */
  idempotencyKeyOf(input: { invoice: string; consumerAddress: string; providerIdentityFingerprint: string }): string {
    this.requireOpen();
    return paymentIdempotencyKey(input);
  }

  lookup(input: { invoice: string; consumerAddress: string; providerIdentityFingerprint: string }): PaymentOperationRecord | null {
    this.requireOpen();
    const key = paymentIdempotencyKey(input);
    return this.recordForKey(key);
  }

  lookupByIdemKey(idemKey: string): PaymentOperationRecord | null {
    this.requireOpen();
    return this.recordForKey(idemKey);
  }

  /**
   * Rows that need service/UI attention after a restart or a lost response.
   * `unknown`/`broadcasting`/`reserved` are never retried automatically; the
   * service uses this list to show the known hash or to gather release evidence.
   */
  pending(limit = 100): PaymentOperationRecord[] {
    this.requireOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "limit must be 1..1000");
    const rows = this.db
      .query(
        "SELECT * FROM payment_operations WHERE state IN ('reserved','broadcasting','unknown','released') ORDER BY updated_at_ms DESC LIMIT ?",
      )
      .all(limit) as OperationRow[];
    return rows.map((row) => this.recordFor(row));
  }

  /**
   * One port bound to one locally verified intent. The external-wallet adapter
   * receives this object; it never sees the database or the release methods.
   */
  operationPort(rawBinding: PaymentBinding): PaymentOperationPort {
    this.requireOpen();
    for (const mainnet of HARD_BLOCKED_MAINNET_CHAIN_IDS) {
      if (rawBinding?.chainId === mainnet) {
        fail("PAYMENT_OPERATION_MAINNET_BLOCKED", `mainnet ${mainnet} is hard-blocked for payments`);
      }
    }
    const binding = normalizeBinding(rawBinding);
    this.assertChain(binding.chainId);
    return new BoundPaymentOperationPort(this, binding);
  }

  /* ---------------------------------------------------------------- */
  /* Internal state machine                                            */
  /* ---------------------------------------------------------------- */

  private requireOpen(): void {
    if (this.closed) fail("PAYMENT_OPERATION_CLOSED", "payment operation journal is closed");
  }

  private assertChain(chainId: number): void {
    if (HARD_BLOCKED_MAINNET_CHAIN_IDS.includes(chainId as 56 | 8453)) {
      fail("PAYMENT_OPERATION_MAINNET_BLOCKED", `mainnet ${chainId} can never be a payment chain`);
    }
    if (!this.allowedChains.has(chainId)) {
      fail("PAYMENT_OPERATION_CHAIN_NOT_ALLOWED", `chain ${chainId} is not in the hard testnet allowlist`);
    }
  }

  private checkAsset(binding: NormalizedBinding): void {
    let evidence: PaymentAssetEvidence | null = null;
    try {
      evidence = this.assetRegistry.resolveSendableAsset({
        chainId: binding.chainId,
        assetId: binding.assetId,
        contractAddress: binding.contractAddress,
        decimals: binding.decimals,
      });
    } catch {
      evidence = null;
    }
    if (
      !evidence ||
      evidence.chainId !== binding.chainId ||
      evidence.assetId !== binding.assetId ||
      evidence.contractAddress.toLowerCase() !== binding.contractAddress ||
      evidence.decimals !== binding.decimals ||
      evidence.networkType !== "testnet"
    ) {
      fail("PAYMENT_OPERATION_ASSET_NOT_TRUSTED", "the injected registry does not currently trust this testnet asset tuple");
    }
  }

  private async checkAuthority(binding: NormalizedBinding, payloadHash: string): Promise<void> {
    try {
      await this.identityAuthority.assertCurrent({
        invoice: binding.invoice,
        payloadHash,
        consumerAddress: binding.consumerAddress,
        providerIdentityFingerprint: binding.providerIdentityFingerprint,
        authorizationGeneration: binding.authorizationGeneration,
        intentHash: binding.intentHash,
        chainId: binding.chainId,
        assetId: binding.assetId,
        contractAddress: binding.contractAddress,
        decimals: binding.decimals,
        recipientAddress: binding.recipientAddress,
        amountRaw: binding.amountRaw,
        calldataHash: binding.calldataHash,
      });
    } catch (error) {
      if (error instanceof PaymentOperationError) throw error;
      fail("PAYMENT_OPERATION_IDENTITY_STALE", "the local consumer/provider identity or authorization epoch is no longer current");
    }
  }

  private checkExpiry(binding: NormalizedBinding): number {
    const now = this.nowMs();
    if (now >= binding.expiresAtMs) {
      fail("PAYMENT_OPERATION_EXPIRED", "the verified quote/intent has expired; a new preview and confirmation are required");
    }
    return now;
  }

  private nowMs(): number {
    const value = this.now();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "now() returned an unusable timestamp");
    }
    return Math.floor(value);
  }

  private idemKeyOf(binding: NormalizedBinding): string {
    return paymentIdempotencyKey({
      invoice: binding.invoice,
      consumerAddress: binding.consumerAddress,
      providerIdentityFingerprint: binding.providerIdentityFingerprint,
    });
  }

  private row(idemKey: string): OperationRow | null {
    return this.db.query("SELECT * FROM payment_operations WHERE idem_key = ?").get(idemKey) as OperationRow | null;
  }

  private attempt(reservationId: string): AttemptRow | null {
    return this.db.query("SELECT * FROM payment_operation_attempts WHERE reservation_id = ?").get(reservationId) as AttemptRow | null;
  }

  private addAttempt(row: OperationRow, nowMs: number): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO payment_operation_attempts
          (reservation_id, idem_key, attempt, payload_hash, state, tx_hash, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.reservation_id, row.idem_key, row.attempt, row.payload_hash, row.state, row.tx_hash, nowMs, nowMs);
  }

  private updateAttempt(reservationId: string, state: PaymentOperationState, txHash: string | null, nowMs: number): void {
    const changed = this.db
      .query("UPDATE payment_operation_attempts SET state = ?, tx_hash = ?, updated_at_ms = ? WHERE reservation_id = ?")
      .run(state, txHash, nowMs, reservationId);
    if (changed.changes !== 1) {
      fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the attempt history for this reservation is missing");
    }
  }

  private hashesFor(idemKey: string, canonical: string | null): string[] {
    const rows = this.db
      .query("SELECT hash FROM payment_operation_hashes WHERE idem_key = ? ORDER BY recorded_at_ms, hash")
      .all(idemKey) as { hash: string }[];
    const hashes = rows.map((row) => row.hash);
    if (canonical && !hashes.includes(canonical)) hashes.unshift(canonical);
    return hashes;
  }

  private assertHashAvailable(idemKey: string, hash: string): void {
    const owned = this.db.query("SELECT idem_key FROM payment_operation_hashes WHERE hash = ?").get(hash) as { idem_key: string } | null;
    if (owned && owned.idem_key !== idemKey) {
      fail("PAYMENT_OPERATION_HASH_CONFLICT", "this transaction hash already belongs to another payment operation");
    }
    const main = this.db
      .query("SELECT idem_key FROM payment_operations WHERE tx_hash = ? AND idem_key <> ?")
      .get(hash, idemKey) as { idem_key: string } | null;
    if (main) {
      fail("PAYMENT_OPERATION_HASH_CONFLICT", "this transaction hash already belongs to another payment operation");
    }
  }

  private insertHash(idemKey: string, reservationId: string, hash: string, nowMs: number): void {
    this.assertHashAvailable(idemKey, hash);
    this.db
      .query("INSERT OR IGNORE INTO payment_operation_hashes (hash, idem_key, reservation_id, recorded_at_ms) VALUES (?, ?, ?, ?)")
      .run(hash, idemKey, reservationId, nowMs);
  }

  private recordForKey(idemKey: string): PaymentOperationRecord | null {
    const row = this.row(idemKey);
    return row ? this.recordFor(row) : null;
  }

  private recordFor(row: OperationRow): PaymentOperationRecord {
    return recordOf(row, this.hashesFor(row.idem_key, row.tx_hash));
  }

  private event(row: OperationRow, event: string, detail: Record<string, unknown>, atMs: number): void {
    // Event detail contains only state transitions and public hashes/reasons.
    // It deliberately never contains calldata, signatures, keys or raw tx bytes.
    const encoded = canonicalJson(detail).slice(0, 512);
    this.db
      .query("INSERT INTO payment_operation_events (idem_key, attempt, event, detail, at_ms) VALUES (?, ?, ?, ?, ?)")
      .run(row.idem_key, row.attempt, event, encoded, atMs);
  }

  private transaction<T>(fn: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (error) {
      throw this.mapTransactionError(error);
    }
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      // A first write may have just created the WAL/SHM sidecars.
      this.secureFiles();
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* the transaction is already gone */
      }
      this.secureFiles();
      throw this.mapTransactionError(error);
    }
  }

  private mapTransactionError(error: unknown): Error {
    if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)) {
      return new PaymentOperationError("PAYMENT_OPERATION_BUSY", "the payment journal is busy; no send permit was granted");
    }
    return error as Error;
  }

  private insertReserved(binding: NormalizedBinding, payloadHash: string, nowMs: number): OperationRow {
    const reservationId = randomUUID();
    this.db
      .query(
        `INSERT INTO payment_operations (
          idem_key, attempt, reservation_id, owner_instance_id, state, payload_hash,
          invoice, consumer_address, provider_fingerprint, authorization_generation,
          intent_hash, chain_id, asset_id, contract_address, decimals, recipient_address,
          amount_raw, calldata_hash, expires_at_ms, tx_hash, reason, recovered_from_unknown,
          created_at_ms, updated_at_ms, released_at_ms
        ) VALUES (?, 1, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL)`,
      )
      .run(
        this.idemKeyOf(binding),
        reservationId,
        this.ownerInstanceId,
        payloadHash,
        binding.invoice,
        binding.consumerAddress,
        binding.providerIdentityFingerprint,
        binding.authorizationGeneration,
        binding.intentHash,
        binding.chainId,
        binding.assetId,
        binding.contractAddress,
        binding.decimals,
        binding.recipientAddress,
        binding.amountRaw,
        binding.calldataHash,
        binding.expiresAtMs,
        nowMs,
        nowMs,
      );
    const row = this.row(this.idemKeyOf(binding));
    if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "the newly inserted payment operation disappeared");
    this.addAttempt(row, nowMs);
    return row;
  }

  private reclaimReleased(binding: NormalizedBinding, payloadHash: string, previous: OperationRow, nowMs: number): OperationRow | null {
    const next = this.db
      .query(
        `UPDATE payment_operations SET
          attempt = attempt + 1, reservation_id = ?, owner_instance_id = ?, state = 'reserved',
          payload_hash = ?, provider_fingerprint = ?, authorization_generation = ?,
          intent_hash = ?, chain_id = ?, asset_id = ?, contract_address = ?, decimals = ?,
          recipient_address = ?, amount_raw = ?, calldata_hash = ?, expires_at_ms = ?,
          tx_hash = NULL, reason = NULL, recovered_from_unknown = 0,
          updated_at_ms = ?, released_at_ms = NULL
        WHERE idem_key = ? AND state = 'released' AND reservation_id = ?`,
      )
      .run(
        randomUUID(),
        this.ownerInstanceId,
        payloadHash,
        binding.providerIdentityFingerprint,
        binding.authorizationGeneration,
        binding.intentHash,
        binding.chainId,
        binding.assetId,
        binding.contractAddress,
        binding.decimals,
        binding.recipientAddress,
        binding.amountRaw,
        binding.calldataHash,
        binding.expiresAtMs,
        nowMs,
        this.idemKeyOf(binding),
        previous.reservation_id,
      );
    if (next.changes !== 1) return null;
    const reclaimed = this.row(previous.idem_key);
    if (!reclaimed) fail("PAYMENT_OPERATION_NOT_FOUND", "the reclaimed payment operation disappeared");
    this.addAttempt(reclaimed, nowMs);
    return reclaimed;
  }

  /* ---------------------------------------------------------------- */
  /* Public state operations used by the Service (never by the wallet) */
  /* ---------------------------------------------------------------- */

  /**
   * Release a never-broadcast reservation. This is the only path that makes a
   * `reserved` row claimable again. The caller must match the exact current
   * reservation id and supply the evidence it used; there is no timer, no
   * "stale after N minutes" rule and no browser access.
   */
  releaseUnsentReservation(input: {
    idemKey: string;
    reservationId: string;
    /** The exact payload the Service inspected before deciding to release. */
    payloadHash: string;
    evidence: UnsentReleaseEvidence;
  }): PaymentOperationRecord {
    this.requireOpen();
    assertPlainObject(input, "releaseUnsentReservation input");
    const idemKey = textId(input.idemKey, "idemKey", 128);
    const reservationId = textId(input.reservationId, "reservationId", 128);
    const payloadHash = payloadHashOf(input.payloadHash);
    const evidence = input.evidence;
    assertPlainObject(evidence, "unsent release evidence");
    if (evidence.basis !== "owner-restarted-before-broadcast" && evidence.basis !== "service-recovered-unsent") {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "unsent release basis must be an explicit recovery basis");
    }
    if (evidence.confirmedNoBroadcast !== true) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the service must confirm that no transaction was broadcast");
    }
    if (evidence.releasedByOwnerInstanceId !== this.ownerInstanceId) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the release must name the current journal owner");
    }
    const observation = evidence.noBroadcastObservation;
    assertPlainObject(observation, "no-broadcast observation");
    if (!["service-flow", "chain-nonce", "node-mempool", "wallet-pending-set"].includes(observation.method)) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the no-broadcast observation method is not recognised");
    }
    const referenceHash = sha256(sanitizeReference(observation.reference));
    const nowMs = this.nowMs();
    return this.transaction(() => {
      const row = this.row(idemKey);
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation for that key");
      if (row.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "release names a different operation payload");
      }
      if (row.state !== "reserved") {
        fail("PAYMENT_OPERATION_RELEASE_REFUSED", "only a never-broadcast reserved row can be released this way");
      }
      if (row.reservation_id !== reservationId) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "release must name the exact current reservation");
      }
      const observed = observedAtOf(observation.observedAt, nowMs, {
        notBeforeMs: row.updated_at_ms,
        maxAgeMs: RELEASE_EVIDENCE_MAX_AGE_MS,
        code: "PAYMENT_OPERATION_RELEASE_REFUSED",
      });
      if (evidence.basis === "owner-restarted-before-broadcast") {
        if (evidence.previousOwnerInstanceId !== row.owner_instance_id || row.owner_instance_id === this.ownerInstanceId) {
          fail("PAYMENT_OPERATION_RELEASE_REFUSED", "owner-restarted evidence must name a previous, different owner instance");
        }
      } else if (row.owner_instance_id !== this.ownerInstanceId) {
        fail("PAYMENT_OPERATION_RELEASE_REFUSED", "service-recovered-unsent is only valid in the owning Service instance; use owner-restarted evidence after a restart");
      }
      const reason = `RELEASED_${evidence.basis.toUpperCase().replace(/-/g, "_")}`;
      const updated = this.db
        .query(
          "UPDATE payment_operations SET state = 'released', reason = ?, released_at_ms = ?, updated_at_ms = ? WHERE idem_key = ? AND state = 'reserved' AND reservation_id = ? AND tx_hash IS NULL",
        )
        .run(reason, nowMs, nowMs, idemKey, reservationId);
      if (updated.changes !== 1) fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the reservation changed while being released");
      const after = this.row(idemKey)!;
      this.updateAttempt(reservationId, "released", null, nowMs);
      this.event(
        after,
        "released-unsent",
        {
          basis: evidence.basis,
          method: observation.method,
          observedAt: observed.iso,
          referenceHash,
          releasedByOwnerInstanceId: this.ownerInstanceId,
          rowOwnerInstanceId: row.owner_instance_id,
        },
        nowMs,
      );
      return this.recordFor(after);
    });
  }

  /**
   * Release one wallet-rejected `unknown` row after the Service has established
   * that nothing was broadcast, so the user may explicitly confirm a new try.
   * Timeouts, RPC/500 errors and invalid hashes cannot use this path.
   */
  releaseRejectedUnknown(input: {
    idemKey: string;
    reservationId: string;
    /** The exact payload the Service inspected before deciding to release. */
    payloadHash: string;
    evidence: RejectedUnknownReleaseEvidence;
  }): PaymentOperationRecord {
    this.requireOpen();
    if (!UNKNOWN_RELEASE_ENABLED) {
      fail(
        "PAYMENT_OPERATION_RELEASE_REFUSED",
        "wallet-rejected unknown release is disabled; the operation stays unknown until a fresh, independently observed no-broadcast proof exists",
      );
    }
    assertPlainObject(input, "releaseRejectedUnknown input");
    const idemKey = textId(input.idemKey, "idemKey", 128);
    const reservationId = textId(input.reservationId, "reservationId", 128);
    const payloadHash = payloadHashOf(input.payloadHash);
    const evidence = input.evidence;
    assertPlainObject(evidence, "rejected unknown release evidence");
    if (evidence.basis !== "wallet-user-rejection") {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "only a wallet user-rejection has a retry path");
    }
    const code = sanitizeReason(evidence.providerCode);
    if (!WALLET_REJECTION_REASONS.has(code)) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the evidence code is not a wallet user-rejection");
    }
    if (evidence.confirmedNoBroadcast !== true || evidence.userConfirmedRetry !== true) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the service must establish no broadcast and the user must confirm a new try");
    }
    const observation = evidence.noBroadcastObservation;
    assertPlainObject(observation, "no-broadcast observation");
    if (!["chain-nonce", "node-mempool", "wallet-pending-set"].includes(observation.method)) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the no-broadcast observation method is not recognised");
    }
    if (evidence.releasedByOwnerInstanceId !== this.ownerInstanceId) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the release must name the current journal owner");
    }
    const nowMs = this.nowMs();
    const observed = observedAtOf(observation.observedAt, nowMs);
    const referenceHash = sha256(sanitizeReference(observation.reference));
    return this.transaction(() => {
      const row = this.row(idemKey);
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation for that key");
      if (row.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "release names a different operation payload");
      }
      if (row.state !== "unknown" || row.tx_hash !== null) {
        fail("PAYMENT_OPERATION_RELEASE_REFUSED", "only an unknown row without a known hash can be released");
      }
      if (row.reservation_id !== reservationId) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "release must name the exact current reservation");
      }
      if (rejectionKind(sanitizeReason(row.reason)) === null || rejectionKind(sanitizeReason(row.reason)) !== rejectionKind(code)) {
        fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the recorded reason is not the same wallet user-rejection");
      }
      const reason = `RELEASED_WALLET_REJECTION_${code}`;
      const updated = this.db
        .query(
          "UPDATE payment_operations SET state = 'released', reason = ?, released_at_ms = ?, updated_at_ms = ? WHERE idem_key = ? AND state = 'unknown' AND reservation_id = ? AND tx_hash IS NULL",
        )
        .run(reason, nowMs, nowMs, idemKey, reservationId);
      if (updated.changes !== 1) fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the reservation changed while being released");
      const after = this.row(idemKey)!;
      this.updateAttempt(reservationId, "released", null, nowMs);
      this.event(
        after,
        "released-wallet-rejection",
        { code, method: observation.method, observedAt: observed.iso, referenceHash, userConfirmedRetry: true },
        nowMs,
      );
      return this.recordFor(after);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Port internals                                                    */
  /* ---------------------------------------------------------------- */

  async reserve(binding: NormalizedBinding, operation: NormalizedOperation): Promise<PaymentReservation> {
    this.requireOpen();
    assertOperationMatchesBinding(binding, operation);
    const idemKey = this.idemKeyOf(binding);
    const payloadHash = bindingPayloadHash(binding);

    // A row that already exists is never sendable again unless it was
    // explicitly released. Check that before identity/registry/expiry so a
    // stale identity cannot hide an unknown/broadcasting row.
    const existing = this.row(idemKey);
    if (existing && existing.state !== "released") {
      if (existing.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "the same invoice was already used with a different payment payload");
      }
      return reservationOf(existing, reservationStateOf(existing.state), true);
    }

    this.assertChain(binding.chainId);
    this.checkAsset(binding);
    this.checkExpiry(binding);
    await this.checkAuthority(binding, payloadHash);
    const nowMs = this.nowMs();

    return this.transaction(() => {
      // Re-read inside the write transaction: another process may have inserted
      // the row between the optimistic read above and this claim.
      const row = this.row(idemKey);
      if (!row) {
        const inserted = this.insertReserved(binding, payloadHash, nowMs);
        this.event(inserted, "claimed", { state: "reserved" }, nowMs);
        return reservationOf(inserted, "reserved", false);
      }
      if (row.state !== "released") {
        if (row.payload_hash !== payloadHash) {
          fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "the same invoice was already used with a different payment payload");
        }
        return reservationOf(row, reservationStateOf(row.state), true);
      }
      // The previous reservation was explicitly released with evidence that
      // nothing was broadcast; a new try may use a new quote/payload.
      const reclaimed = this.reclaimReleased(binding, payloadHash, row, nowMs);
      if (!reclaimed) {
        const current = this.row(idemKey)!;
        return reservationOf(current, reservationStateOf(current.state), true);
      }
      this.event(reclaimed, "reclaimed", { state: "reserved", attempt: reclaimed.attempt }, nowMs);
      return reservationOf(reclaimed, "reserved", false);
    });
  }

  async markBroadcasting(
    binding: NormalizedBinding,
    operation: NormalizedOperation,
    reservationId: string,
  ): Promise<void> {
    this.requireOpen();
    assertOperationMatchesBinding(binding, operation);
    this.assertChain(binding.chainId);
    this.checkAsset(binding);
    this.checkExpiry(binding);
    const payloadHash = bindingPayloadHash(binding);
    await this.checkAuthority(binding, payloadHash);
    const nowMs = this.nowMs();
    this.transaction(() => {
      const row = this.row(this.idemKeyOf(binding));
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation to broadcast");
      if (row.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "the operation payload changed after the claim");
      }
      if (row.state !== "reserved") {
        fail("PAYMENT_OPERATION_NOT_RESERVED", `cannot broadcast from state ${row.state}`);
      }
      if (row.reservation_id !== reservationId) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the reservation id does not own this claim");
      }
      if (row.expires_at_ms > 0 && nowMs >= row.expires_at_ms) {
        fail("PAYMENT_OPERATION_EXPIRED", "the persisted quote/intent expiry has passed; the send gate is closed");
      }
      const attempt = this.attempt(reservationId);
      if (!attempt || attempt.idem_key !== row.idem_key) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the attempt history for this reservation is missing");
      }
      const changed = this.db
        .query(
          "UPDATE payment_operations SET state = 'broadcasting', updated_at_ms = ? WHERE idem_key = ? AND state = 'reserved' AND reservation_id = ? AND payload_hash = ?",
        )
        .run(nowMs, row.idem_key, reservationId, payloadHash);
      if (changed.changes !== 1) {
        fail("PAYMENT_OPERATION_NOT_RESERVED", "the claim changed before the send gate");
      }
      this.updateAttempt(reservationId, "broadcasting", null, nowMs);
      const after = this.row(row.idem_key)!;
      this.event(after, "broadcasting", { state: "broadcasting" }, nowMs);
    });
    // Returning only after COMMIT is the durability guarantee: synchronous=FULL
    // has fsynced the WAL, so a crash after this line leaves "broadcasting".
  }

  async recordHash(
    binding: NormalizedBinding,
    operation: NormalizedOperation,
    reservationId: string,
    hash: string,
  ): Promise<void> {
    this.requireOpen();
    assertOperationMatchesBinding(binding, operation);
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "transaction hash must be 32-byte hex");
    }
    const normalizedHash = hash.toLowerCase();
    const payloadHash = bindingPayloadHash(binding);
    const nowMs = this.nowMs();
    this.transaction(() => {
      const row = this.row(this.idemKeyOf(binding));
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation to record");
      if (row.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "the operation payload changed after the claim");
      }
      const attempt = this.attempt(reservationId);
      if (!attempt || attempt.idem_key !== row.idem_key) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the reservation does not belong to this payment operation");
      }
      const current = row.reservation_id === reservationId;

      if (current && row.state === "reserved") {
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", "cannot record a hash before the send gate");
      }
      // A transaction hash belongs to exactly one payment operation, even if a
      // caller tries to attach it to a different invoice. Check before any row
      // update so the unique index cannot surface as a raw SQLite error.
      this.assertHashAvailable(row.idem_key, normalizedHash);

      if (row.state === "broadcast") {
        if (row.tx_hash === normalizedHash) {
          this.insertHash(row.idem_key, reservationId, normalizedHash, nowMs);
          return; // idempotent
        }
        if (current) {
          fail("PAYMENT_OPERATION_HASH_CONFLICT", "a different transaction hash is already recorded");
        }
        // A prior attempt's hash is still real evidence; keep the canonical
        // hash and record the additional one without changing the state.
        this.insertHash(row.idem_key, reservationId, normalizedHash, nowMs);
        this.updateAttempt(reservationId, "broadcast", normalizedHash, nowMs);
        this.event(row, "additional-prior-hash", { hash: normalizedHash, priorAttempt: attempt.attempt }, nowMs);
        return;
      }

      // A reservation from an earlier attempt. The old attempt was released
      // (or a new claim replaced it); its hash must never be silently lost.
      if (!current) {
        if (row.state === "reserved") {
          // The new attempt is still unsent. A late hash from the old attempt
          // is stronger evidence than the release; block the new send.
          const blocked = this.db
            .query(
              "UPDATE payment_operations SET state = 'broadcast', tx_hash = ?, updated_at_ms = ? WHERE idem_key = ? AND state = 'reserved' AND reservation_id = ? AND payload_hash = ?",
            )
            .run(normalizedHash, nowMs, row.idem_key, row.reservation_id, payloadHash);
          if (blocked.changes !== 1) {
            fail("PAYMENT_OPERATION_NOT_RESERVED", "the new claim changed while recording the prior hash");
          }
          this.insertHash(row.idem_key, reservationId, normalizedHash, nowMs);
          this.updateAttempt(reservationId, "broadcast", normalizedHash, nowMs);
          const after = this.row(row.idem_key)!;
          this.event(
            after,
            "late-hash-blocks-attempt",
            { hash: normalizedHash, priorAttempt: attempt.attempt, blockedAttempt: after.attempt },
            nowMs,
          );
          return;
        }
        if (row.state === "broadcasting") {
          // The current attempt may already be in flight. Do not claim that
          // this late hash stopped it; preserve both attempts' evidence.
          this.insertHash(row.idem_key, reservationId, normalizedHash, nowMs);
          this.updateAttempt(reservationId, "broadcast", normalizedHash, nowMs);
          this.event(
            row,
            "late-hash-while-broadcasting",
            { hash: normalizedHash, priorAttempt: attempt.attempt, currentAttempt: row.attempt },
            nowMs,
          );
          return;
        }
        if (row.state === "unknown" || row.state === "released") {
          const changed = this.db
            .query(
              "UPDATE payment_operations SET state = 'broadcast', tx_hash = ?, recovered_from_unknown = CASE WHEN state = 'unknown' THEN 1 ELSE recovered_from_unknown END, updated_at_ms = ? WHERE idem_key = ? AND state IN ('unknown','released') AND reservation_id = ? AND payload_hash = ? AND (tx_hash IS NULL OR tx_hash = ?)",
            )
            .run(normalizedHash, nowMs, row.idem_key, row.reservation_id, payloadHash, normalizedHash);
          if (changed.changes !== 1) {
            fail("PAYMENT_OPERATION_NOT_BROADCASTING", "the prior hash could not be recorded from the current state");
          }
          this.insertHash(row.idem_key, reservationId, normalizedHash, nowMs);
          this.updateAttempt(reservationId, "broadcast", normalizedHash, nowMs);
          const after = this.row(row.idem_key)!;
          this.event(after, "prior-hash-recorded", { hash: normalizedHash, priorAttempt: attempt.attempt, from: row.state }, nowMs);
          return;
        }
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", `cannot record a hash from state ${row.state}`);
      }

      // The current attempt is the sender. Only its own hash may become the
      // canonical hash; a different hash is a conflict.
      if (row.state !== "broadcasting" && row.state !== "unknown" && row.state !== "released") {
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", `cannot record a hash from state ${row.state}`);
      }
      if (row.tx_hash !== null && row.tx_hash !== normalizedHash) {
        fail("PAYMENT_OPERATION_HASH_CONFLICT", "a different transaction hash is already recorded");
      }
      const from = row.state;
      const changed = this.db
        .query(
          "UPDATE payment_operations SET state = 'broadcast', tx_hash = ?, recovered_from_unknown = CASE WHEN state = 'unknown' THEN 1 ELSE recovered_from_unknown END, updated_at_ms = ? WHERE idem_key = ? AND state IN ('broadcasting','unknown','released') AND reservation_id = ? AND payload_hash = ? AND (tx_hash IS NULL OR tx_hash = ?)",
        )
        .run(normalizedHash, nowMs, row.idem_key, reservationId, payloadHash, normalizedHash);
      if (changed.changes !== 1) {
        const currentRow = this.row(row.idem_key)!;
        if (currentRow.state === "broadcast" && currentRow.tx_hash === normalizedHash) return;
        if (currentRow.tx_hash !== null && currentRow.tx_hash !== normalizedHash) {
          fail("PAYMENT_OPERATION_HASH_CONFLICT", "a different transaction hash won the race");
        }
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", "the hash could not be recorded from the current state");
      }
      this.insertHash(row.idem_key, reservationId, normalizedHash, nowMs);
      this.updateAttempt(reservationId, "broadcast", normalizedHash, nowMs);
      const after = this.row(row.idem_key)!;
      this.event(after, "hash-recorded", { state: "broadcast", hash: normalizedHash, from }, nowMs);
    });
  }

  async recordUnknown(
    binding: NormalizedBinding,
    operation: NormalizedOperation,
    reservationId: string,
    rawReason: unknown,
  ): Promise<void> {
    this.requireOpen();
    assertOperationMatchesBinding(binding, operation);
    const reason = sanitizeReason(rawReason);
    const payloadHash = bindingPayloadHash(binding);
    const nowMs = this.nowMs();
    this.transaction(() => {
      const row = this.row(this.idemKeyOf(binding));
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation to record");
      if (row.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "the operation payload changed after the claim");
      }
      const attempt = this.attempt(reservationId);
      if (!attempt || attempt.idem_key !== row.idem_key) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the reservation does not belong to this payment operation");
      }
      const current = row.reservation_id === reservationId;
      if (!current) {
        // A historical attempt's unknown result. It never changes a canonical
        // broadcast hash; if a new attempt is still unsent it blocks that send.
        if (attempt.state === "broadcast" || attempt.tx_hash !== null) {
          this.event(row, "prior-attempt-unknown-ignored", { reason, priorAttempt: attempt.attempt }, nowMs);
          return;
        }
        if (row.state === "reserved") {
          const blocked = this.db
            .query(
              "UPDATE payment_operations SET state = 'unknown', reason = 'PRIOR_ATTEMPT_UNKNOWN', updated_at_ms = ? WHERE idem_key = ? AND state = 'reserved' AND reservation_id = ?",
            )
            .run(nowMs, row.idem_key, row.reservation_id);
          if (blocked.changes === 1) {
            this.updateAttempt(reservationId, "unknown", null, nowMs);
            const after = this.row(row.idem_key)!;
            this.event(after, "prior-unknown-blocks-attempt", { reason, priorAttempt: attempt.attempt, blockedAttempt: after.attempt }, nowMs);
          }
          return;
        }
        this.updateAttempt(reservationId, "unknown", null, nowMs);
        this.event(row, "prior-attempt-unknown", { reason, priorAttempt: attempt.attempt }, nowMs);
        return;
      }
      if (row.state === "broadcast") {
        // A stored hash is evidence and is never downgraded by a late unknown.
        this.event(row, "unknown-ignored-after-hash", { reason }, nowMs);
        return;
      }
      if (row.state === "unknown") {
        this.event(row, "unknown-repeat", { reason, keptReason: row.reason }, nowMs);
        return;
      }
      if (row.state !== "broadcasting") {
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", `cannot record unknown from state ${row.state}`);
      }
      const changed = this.db
        .query(
          "UPDATE payment_operations SET state = 'unknown', reason = ?, updated_at_ms = ? WHERE idem_key = ? AND state = 'broadcasting' AND reservation_id = ? AND payload_hash = ? AND tx_hash IS NULL",
        )
        .run(reason, nowMs, row.idem_key, reservationId, payloadHash);
      if (changed.changes !== 1) fail("PAYMENT_OPERATION_NOT_BROADCASTING", "the unknown result could not be recorded");
      this.updateAttempt(reservationId, "unknown", null, nowMs);
      const after = this.row(row.idem_key)!;
      this.event(after, "unknown", { state: "unknown", reason }, nowMs);
    });
  }

  query(binding: NormalizedBinding, operation: NormalizedOperation): PaymentOperationQuery | null {
    this.requireOpen();
    // A different tuple is a different operation, not an error: recovery callers
    // may ask about a preview that never matched this binding.
    if (operationMismatch(binding, operation) !== null) return null;
    const row = this.row(this.idemKeyOf(binding));
    if (!row) return null;
    if (row.payload_hash !== bindingPayloadHash(binding)) return null;
    return Object.freeze({
      state: row.state,
      hash: row.tx_hash,
      hashes: Object.freeze(this.hashesFor(row.idem_key, row.tx_hash)),
      reason: row.reason,
      attempt: row.attempt,
      expiresAtMs: row.expires_at_ms,
      updatedAt: iso(row.updated_at_ms),
      retryable: row.state === "released",
    });
  }
}

/**
 * The object handed to the external-wallet adapter. It exposes only the five
 * send-time methods; release is a Service-only operation on the journal.
 */
export interface PaymentOperationPort {
  reserve(operation: ExternalWalletOperation): Promise<PaymentReservation>;
  markBroadcasting(input: { reservationId: string; operation: ExternalWalletOperation }): Promise<void>;
  recordHash(input: { reservationId: string; operation: ExternalWalletOperation; hash: string }): Promise<void>;
  recordUnknown(input: { reservationId: string; operation: ExternalWalletOperation; reason: unknown }): Promise<void>;
  query(operation: ExternalWalletOperation): Promise<PaymentOperationQuery | null>;
}

class BoundPaymentOperationPort implements PaymentOperationPort {
  private readonly journal: PaymentOperationJournal;
  private readonly binding: NormalizedBinding;
  /** Reservation ids this wallet session created; the send gate needs one. */
  private readonly issued = new Set<string>();

  constructor(journal: PaymentOperationJournal, binding: NormalizedBinding) {
    this.journal = journal;
    this.binding = binding;
  }

  private operation(raw: ExternalWalletOperation): NormalizedOperation {
    return normalizeOperation(raw);
  }

  async reserve(rawOperation: ExternalWalletOperation): Promise<PaymentReservation> {
    const reservation = await this.journal.reserve(this.binding, this.operation(rawOperation));
    if (reservation.state === "reserved") this.issued.add(reservation.reservationId);
    return reservation;
  }

  async markBroadcasting(input: { reservationId: string; operation: ExternalWalletOperation }): Promise<void> {
    if (typeof input?.reservationId !== "string" || !input.reservationId) {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "markBroadcasting needs the reservationId returned by reserve");
    }
    // The database CAS already proves the row is reserved by that id; this
    // in-process check additionally proves the caller is the wallet session
    // that made the claim (a second tab cannot send with a leaked id).
    if (!this.issued.has(input.reservationId)) {
      fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "this wallet session did not create that reservation");
    }
    await this.journal.markBroadcasting(this.binding, this.operation(input.operation), input.reservationId);
  }

  async recordHash(input: { reservationId: string; operation: ExternalWalletOperation; hash: string }): Promise<void> {
    if (typeof input?.reservationId !== "string" || !input.reservationId) {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "recordHash needs the reservationId returned by reserve");
    }
    await this.journal.recordHash(this.binding, this.operation(input.operation), input.reservationId, input.hash);
  }

  async recordUnknown(input: { reservationId: string; operation: ExternalWalletOperation; reason: unknown }): Promise<void> {
    if (typeof input?.reservationId !== "string" || !input.reservationId) {
      fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "recordUnknown needs the reservationId returned by reserve");
    }
    await this.journal.recordUnknown(this.binding, this.operation(input.operation), input.reservationId, input.reason);
  }

  async query(rawOperation: ExternalWalletOperation): Promise<PaymentOperationQuery | null> {
    return this.journal.query(this.binding, this.operation(rawOperation));
  }
}
