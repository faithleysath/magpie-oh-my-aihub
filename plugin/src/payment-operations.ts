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
export const PAYMENT_OPERATION_DB_VERSION = 1;

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
  txHash: string | null;
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
  reason: string | null;
  attempt: number;
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

/** Evidence the Service must supply before a not-sent reservation is released. */
export interface UnsentReleaseEvidence {
  basis: "owner-restarted-before-broadcast" | "service-recovered-unsent";
  confirmedNoBroadcast: true;
  observedAt: string;
  /** Opaque public reference; stored hashed, never raw. */
  reference: string;
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
  noBroadcastObservation: {
    method: "chain-nonce" | "provider-response" | "node-mempool" | "wallet-pending-set";
    observedAt: string;
    /** Opaque public reference; stored hashed, never raw. */
    reference: string;
  };
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
export function paymentIdempotencyKey(input: { invoice: string; consumerAddress: string }): string {
  assertPlainObject(input, "paymentIdempotencyKey");
  const invoice = textId(input.invoice, "invoice");
  const consumerAddress = publicAddress(input.consumerAddress, "consumerAddress");
  return sha256(`ohmyaihub.payment-operation/idem/v1\n${canonicalJson({ invoice, consumerAddress })}`);
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
  tx_hash: string | null;
  reason: string | null;
  recovered_from_unknown: number;
  created_at_ms: number;
  updated_at_ms: number;
  released_at_ms: number | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function recordOf(row: OperationRow): PaymentOperationRecord {
  return Object.freeze({
    idemKey: row.idem_key,
    reservationId: row.reservation_id,
    attempt: row.attempt,
    state: row.state,
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
    txHash: row.tx_hash,
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

function observedAtOf(value: unknown, nowMs: number): string {
  if (typeof value !== "string") fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "release evidence observedAt must be an ISO timestamp");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > nowMs + 60_000 || parsed < nowMs - 24 * 60 * 60 * 1000) {
    fail("PAYMENT_OPERATION_INVALID_ARGUMENT", "release evidence observedAt is invalid or outside the last 24 hours");
  }
  return new Date(parsed).toISOString();
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
  readonly path: string;
  readonly ownerInstanceId: string;
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
    this.path = path;
    this.ownerInstanceId = owner;
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
    if (version < PAYMENT_OPERATION_DB_VERSION) this.db.exec(`PRAGMA user_version = ${PAYMENT_OPERATION_DB_VERSION};`);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* a filesystem without POSIX modes: the directory is still 0700 */
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
  idempotencyKeyOf(input: { invoice: string; consumerAddress: string }): string {
    this.requireOpen();
    return paymentIdempotencyKey(input);
  }

  lookup(input: { invoice: string; consumerAddress: string }): PaymentOperationRecord | null {
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
    return rows.map(recordOf);
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

  private row(idemKey: string): OperationRow | null {
    return this.db.query("SELECT * FROM payment_operations WHERE idem_key = ?").get(idemKey) as OperationRow | null;
  }

  private recordForKey(idemKey: string): PaymentOperationRecord | null {
    const row = this.row(idemKey);
    return row ? recordOf(row) : null;
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
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* the transaction is already gone */
      }
      throw error;
    }
  }

  private insertReserved(binding: NormalizedBinding, payloadHash: string, nowMs: number): OperationRow {
    const reservationId = randomUUID();
    this.db
      .query(
        `INSERT INTO payment_operations (
          idem_key, attempt, reservation_id, owner_instance_id, state, payload_hash,
          invoice, consumer_address, provider_fingerprint, authorization_generation,
          intent_hash, chain_id, asset_id, contract_address, decimals, recipient_address,
          amount_raw, calldata_hash, tx_hash, reason, recovered_from_unknown,
          created_at_ms, updated_at_ms, released_at_ms
        ) VALUES (?, 1, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL)`,
      )
      .run(
        paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress }),
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
        nowMs,
        nowMs,
      );
    const row = this.row(paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress }));
    if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "the newly inserted payment operation disappeared");
    return row;
  }

  private reclaimReleased(binding: NormalizedBinding, payloadHash: string, previous: OperationRow, nowMs: number): OperationRow | null {
    const next = this.db
      .query(
        `UPDATE payment_operations SET
          attempt = attempt + 1, reservation_id = ?, owner_instance_id = ?, state = 'reserved',
          payload_hash = ?, provider_fingerprint = ?, authorization_generation = ?,
          intent_hash = ?, chain_id = ?, asset_id = ?, contract_address = ?, decimals = ?,
          recipient_address = ?, amount_raw = ?, calldata_hash = ?,
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
        nowMs,
        paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress }),
        previous.reservation_id,
      );
    if (next.changes !== 1) return null;
    return this.row(previous.idem_key);
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
    evidence: UnsentReleaseEvidence;
  }): PaymentOperationRecord {
    this.requireOpen();
    assertPlainObject(input, "releaseUnsentReservation input");
    const idemKey = textId(input.idemKey, "idemKey", 128);
    const reservationId = textId(input.reservationId, "reservationId", 128);
    const evidence = input.evidence;
    assertPlainObject(evidence, "unsent release evidence");
    if (evidence.basis !== "owner-restarted-before-broadcast" && evidence.basis !== "service-recovered-unsent") {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "unsent release basis must be an explicit recovery basis");
    }
    if (evidence.confirmedNoBroadcast !== true) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the service must confirm that no transaction was broadcast");
    }
    const nowMs = this.nowMs();
    const observedAt = observedAtOf(evidence.observedAt, nowMs);
    const referenceHash = sha256(sanitizeReference(evidence.reference));
    return this.transaction(() => {
      const row = this.row(idemKey);
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation for that key");
      if (row.state !== "reserved") {
        fail("PAYMENT_OPERATION_RELEASE_REFUSED", "only a never-broadcast reserved row can be released this way");
      }
      if (row.reservation_id !== reservationId) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "release must name the exact current reservation");
      }
      if (evidence.basis === "owner-restarted-before-broadcast") {
        if (evidence.previousOwnerInstanceId !== row.owner_instance_id || row.owner_instance_id === this.ownerInstanceId) {
          fail("PAYMENT_OPERATION_RELEASE_REFUSED", "owner-restarted evidence must name a previous, different owner instance");
        }
      }
      const reason = `RELEASED_${evidence.basis.toUpperCase().replace(/-/g, "_")}`;
      const updated = this.db
        .query(
          "UPDATE payment_operations SET state = 'released', reason = ?, released_at_ms = ?, updated_at_ms = ? WHERE idem_key = ? AND state = 'reserved' AND reservation_id = ? AND tx_hash IS NULL",
        )
        .run(reason, nowMs, nowMs, idemKey, reservationId);
      if (updated.changes !== 1) fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the reservation changed while being released");
      const after = this.row(idemKey)!;
      this.event(after, "released-unsent", { basis: evidence.basis, observedAt, referenceHash }, nowMs);
      return recordOf(after);
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
    evidence: RejectedUnknownReleaseEvidence;
  }): PaymentOperationRecord {
    this.requireOpen();
    assertPlainObject(input, "releaseRejectedUnknown input");
    const idemKey = textId(input.idemKey, "idemKey", 128);
    const reservationId = textId(input.reservationId, "reservationId", 128);
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
    if (!["chain-nonce", "provider-response", "node-mempool", "wallet-pending-set"].includes(observation.method)) {
      fail("PAYMENT_OPERATION_RELEASE_REFUSED", "the no-broadcast observation method is not recognised");
    }
    const nowMs = this.nowMs();
    const observedAt = observedAtOf(observation.observedAt, nowMs);
    const referenceHash = sha256(sanitizeReference(observation.reference));
    return this.transaction(() => {
      const row = this.row(idemKey);
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation for that key");
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
      this.event(
        after,
        "released-wallet-rejection",
        { code, method: observation.method, observedAt, referenceHash, userConfirmedRetry: true },
        nowMs,
      );
      return recordOf(after);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Port internals                                                    */
  /* ---------------------------------------------------------------- */

  async reserve(binding: NormalizedBinding, operation: NormalizedOperation): Promise<PaymentReservation> {
    this.requireOpen();
    assertOperationMatchesBinding(binding, operation);
    const idemKey = paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress });
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
      const row = this.row(paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress }));
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
      const changed = this.db
        .query(
          "UPDATE payment_operations SET state = 'broadcasting', updated_at_ms = ? WHERE idem_key = ? AND state = 'reserved' AND reservation_id = ? AND payload_hash = ?",
        )
        .run(nowMs, row.idem_key, reservationId, payloadHash);
      if (changed.changes !== 1) {
        fail("PAYMENT_OPERATION_NOT_RESERVED", "the claim changed before the send gate");
      }
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
      const row = this.row(paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress }));
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation to record");
      if (row.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "the operation payload changed after the claim");
      }
      if (row.state === "broadcast") {
        if (row.tx_hash === normalizedHash) return; // idempotent
        fail("PAYMENT_OPERATION_HASH_CONFLICT", "a different transaction hash is already recorded");
      }
      if (row.state !== "broadcasting" && row.state !== "unknown") {
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", `cannot record a hash from state ${row.state}`);
      }
      if (row.reservation_id !== reservationId) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the reservation id does not own this claim");
      }
      if (row.tx_hash !== null && row.tx_hash !== normalizedHash) {
        fail("PAYMENT_OPERATION_HASH_CONFLICT", "a different transaction hash is already recorded");
      }
      const from = row.state;
      const changed = this.db
        .query(
          "UPDATE payment_operations SET state = 'broadcast', tx_hash = ?, recovered_from_unknown = CASE WHEN state = 'unknown' THEN 1 ELSE recovered_from_unknown END, updated_at_ms = ? WHERE idem_key = ? AND state IN ('broadcasting','unknown') AND reservation_id = ? AND payload_hash = ? AND (tx_hash IS NULL OR tx_hash = ?)",
        )
        .run(normalizedHash, nowMs, row.idem_key, reservationId, payloadHash, normalizedHash);
      if (changed.changes !== 1) {
        const current = this.row(row.idem_key)!;
        if (current.state === "broadcast" && current.tx_hash === normalizedHash) return;
        if (current.tx_hash !== null && current.tx_hash !== normalizedHash) {
          fail("PAYMENT_OPERATION_HASH_CONFLICT", "a different transaction hash won the race");
        }
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", "the hash could not be recorded from the current state");
      }
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
      const row = this.row(paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress }));
      if (!row) fail("PAYMENT_OPERATION_NOT_FOUND", "no payment operation to record");
      if (row.payload_hash !== payloadHash) {
        fail("PAYMENT_OPERATION_PAYLOAD_MISMATCH", "the operation payload changed after the claim");
      }
      if (row.state === "broadcast") {
        // A stored hash is evidence and is never downgraded by a late unknown.
        this.event(row, "unknown-ignored-after-hash", { reason }, nowMs);
        return;
      }
      if (row.state === "unknown") {
        if (row.reservation_id !== reservationId) {
          fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the reservation id does not own this claim");
        }
        this.event(row, "unknown-repeat", { reason, keptReason: row.reason }, nowMs);
        return;
      }
      if (row.state !== "broadcasting") {
        fail("PAYMENT_OPERATION_NOT_BROADCASTING", `cannot record unknown from state ${row.state}`);
      }
      if (row.reservation_id !== reservationId) {
        fail("PAYMENT_OPERATION_RESERVATION_MISMATCH", "the reservation id does not own this claim");
      }
      const changed = this.db
        .query(
          "UPDATE payment_operations SET state = 'unknown', reason = ?, updated_at_ms = ? WHERE idem_key = ? AND state = 'broadcasting' AND reservation_id = ? AND payload_hash = ? AND tx_hash IS NULL",
        )
        .run(reason, nowMs, row.idem_key, reservationId, payloadHash);
      if (changed.changes !== 1) fail("PAYMENT_OPERATION_NOT_BROADCASTING", "the unknown result could not be recorded");
      const after = this.row(row.idem_key)!;
      this.event(after, "unknown", { state: "unknown", reason }, nowMs);
    });
  }

  query(binding: NormalizedBinding, operation: NormalizedOperation): PaymentOperationQuery | null {
    this.requireOpen();
    // A different tuple is a different operation, not an error: recovery callers
    // may ask about a preview that never matched this binding.
    if (operationMismatch(binding, operation) !== null) return null;
    const row = this.row(paymentIdempotencyKey({ invoice: binding.invoice, consumerAddress: binding.consumerAddress }));
    if (!row) return null;
    if (row.payload_hash !== bindingPayloadHash(binding)) return null;
    return Object.freeze({
      state: row.state,
      hash: row.tx_hash,
      reason: row.reason,
      attempt: row.attempt,
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
