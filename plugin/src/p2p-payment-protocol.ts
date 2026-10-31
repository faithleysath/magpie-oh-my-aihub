// P2P payment protocol (independent version) and its narrow authenticated port.
//
// This file is pure validation/typing: no network, filesystem, Wallet, Service
// or Ledger. The frozen B envelope cannot carry the old strict `payment_request`
// body, so the future reviewed B extension must expose a new versioned
// `payment_message` type whose opaque body is validated here. The first C unit
// tests through a synthetic authenticated port; a real remote B path is UNKNOWN.

import { createHash } from "node:crypto";
import {
  DEPOSIT_DOMAIN_NAME,
  DEPOSIT_DOMAIN_VERSION,
  DEPOSIT_TYPES,
  DEPOSIT_VERIFYING_CONTRACT,
  type DepositIntent,
} from "./deposits.ts";
import { typedDataDigest, type TypedData } from "./eip712.ts";

export const P2P_PAYMENT_SCHEMA = "ohmyaihub/payment/v1";
export const P2P_PAYMENT_MESSAGE_TYPE = "payment_message";
export const P2P_PAYMENT_MAX_BYTES = 16 * 1024;
export const P2P_PAYMENT_MAX_BODY_BYTES = 12 * 1024;
export const P2P_PAYMENT_MAX_TTL_MS = 15 * 60_000;
export const P2P_PAYMENT_CLOCK_SKEW_MS = 2 * 60_000;

/** Payment simulation paths. Product networks are deliberately not selectable. */
export const PAYMENT_SIMULATION_CHAIN_IDS = Object.freeze([97, 84532] as const);
export const PAYMENT_PRODUCT_CHAIN_IDS = Object.freeze([56, 8453] as const);

export const PAYMENT_STATUSES = ["waitingpayment", "confirming", "received", "actionneeded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_FRAME_KINDS = ["request", "terms", "signature", "status"] as const;
export type PaymentFrameKind = (typeof PAYMENT_FRAME_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVOICE = /^inv_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]{0,77})$/;
const TEXT = /^[A-Za-z0-9._:@+/=-]{1,200}$/;
const NODE = /^[A-Za-z0-9._:-]{1,128}$/;
const DETAIL = /^[A-Za-z0-9._:-]{1,80}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export type PaymentProtocolCode =
  | "invalid"
  | "unsupported"
  | "network-gated"
  | "mainnet-blocked"
  | "expired"
  | "clock-skew"
  | "peer-mismatch"
  | "selection-mismatch"
  | "terms-mismatch"
  | "signature"
  | "authority"
  | "conflict"
  | "idempotency"
  | "not-found"
  | "role"
  | "transport"
  | "limit";

export class PaymentProtocolError extends Error {
  constructor(
    readonly code: PaymentProtocolCode,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "PaymentProtocolError";
  }
}

export function paymentFail(code: PaymentProtocolCode, message: string, detail: string | null = null): never {
  throw new PaymentProtocolError(code, message, detail);
}

export function paymentErrorCode(error: unknown): string {
  return error instanceof PaymentProtocolError ? error.code : "transport";
}

export interface PaymentPeer {
  nodeId: string;
  fingerprint: string;
}

export interface PaymentAsset {
  assetId: string;
  contractAddress: string;
  decimals: number;
}

export interface PaymentSelection {
  consumerId: string;
  providerNodeId: string;
  providerFingerprint: string;
  chainId: number;
  asset: PaymentAsset;
  amountRaw: string;
}

export interface ProviderPaymentIdentity {
  providerId: string;
  nodeId: string;
  fingerprint: string;
  authorizationGeneration: number;
  quoteHash: string;
  priceVersion: string;
}

export interface PaymentTerms {
  requestId: string;
  invoiceId: string;
  provider: ProviderPaymentIdentity;
  consumerId: string;
  chainId: number;
  asset: PaymentAsset;
  recipientAddress: string;
  amountRaw: string;
  intent: DepositIntent;
  typedData: TypedData;
  digest: string;
  createdAt: string;
  expiresAt: string;
}

export interface PaymentRequestFrameBody {
  selection: PaymentSelection;
}

export interface PaymentTermsFrameBody {
  terms: PaymentTerms;
}

export interface PaymentSignatureFrameBody {
  invoiceId: string;
  requestId: string;
  signature: string;
  payerAddress: string;
}

export interface PaymentStatusFrameBody {
  invoiceId: string;
  requestId: string;
  status: PaymentStatus;
  detail: string | null;
}

export interface PaymentFrame {
  schema: typeof P2P_PAYMENT_SCHEMA;
  kind: PaymentFrameKind;
  requestId: string;
  invoiceId: string | null;
  from: PaymentPeer;
  to: PaymentPeer;
  createdAt: string;
  expiresAt: string;
  body: PaymentRequestFrameBody | PaymentTermsFrameBody | PaymentSignatureFrameBody | PaymentStatusFrameBody;
}

/** Future reviewed B extension; fields match the B payment-hook draft. */
export interface P2pAuthenticatedPaymentContext {
  type: typeof P2P_PAYMENT_MESSAGE_TYPE;
  messageId: string;
  idempotency: string;
  correlation: string | null;
  from: PaymentPeer;
  to: PaymentPeer;
  sessionId: string;
  catalogQuoteHash: string | null;
  receivedAt: string;
  body: unknown;
}

export interface P2pPaymentMessagePort {
  onPaymentMessage(handler: (ctx: P2pAuthenticatedPaymentContext) => Promise<{ code: string; detail?: string | null }>): void;
  sendPaymentMessage(
    to: PaymentPeer,
    input: { idempotency: string; correlation: string | null; body: unknown; expiresAt: string },
  ): Promise<{ code: string; detail?: string | null }>;
}

/** The local consumer wallet boundary. It never exposes a key to the peer. */
export interface PaymentSigner {
  sign(input: { intent: DepositIntent; typedData: TypedData; digest: string }): Promise<{ signature: string; payerAddress: string }>;
}

/** Local observer (Watcher/chain service) only; never a remote message. */
export interface PaymentObservation {
  requestId: string;
  invoiceId: string;
  status: "confirming" | "received" | "actionneeded";
  detail: string | null;
  observedAt: string;
}

function plain(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) paymentFail("invalid", `${where} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) paymentFail("invalid", `${where} must be a plain object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!fields.includes(key)) paymentFail("invalid", `${where} has an unexpected field`);
  for (const key of fields) if (!(key in value)) paymentFail("invalid", `${where} is missing ${key}`);
}

function text(value: unknown, where: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    paymentFail("invalid", `${where} is invalid`);
  }
  return value.trim();
}

function nodeId(value: unknown, where: string): string {
  if (typeof value !== "string" || !NODE.test(value)) paymentFail("invalid", `${where} is invalid`);
  return value;
}

function fingerprint(value: unknown, where: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) paymentFail("invalid", `${where} must be 64 hex`);
  return value;
}

function address(value: unknown, where: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value) || value.toLowerCase() === "0x" + "0".repeat(40)) {
    paymentFail("invalid", `${where} must be a non-zero address`);
  }
  return value.toLowerCase();
}

function uuid(value: unknown, where: string): string {
  if (typeof value !== "string" || !UUID.test(value)) paymentFail("invalid", `${where} must be a UUID`);
  return value.toLowerCase();
}

function invoice(value: unknown, where: string): string {
  if (typeof value !== "string" || !INVOICE.test(value)) paymentFail("invalid", `${where} must be an invoice id`);
  return value.toLowerCase();
}

function amount(value: unknown, where: string): string {
  if (typeof value !== "string" || !UINT.test(value) || value === "0" || BigInt(value) > (1n << 256n) - 1n) {
    paymentFail("invalid", `${where} must be a positive uint256 decimal string`);
  }
  return value;
}

function timestamp(value: unknown, where: string): string {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) {
    paymentFail("invalid", `${where} must be an ISO timestamp`);
  }
  return value;
}

function peer(value: unknown, where: string): PaymentPeer {
  const raw = plain(value, where);
  exact(raw, ["nodeId", "fingerprint"], where);
  return { nodeId: nodeId(raw.nodeId, `${where}.nodeId`), fingerprint: fingerprint(raw.fingerprint, `${where}.fingerprint`) };
}

function asset(value: unknown, where: string): PaymentAsset {
  const raw = plain(value, where);
  exact(raw, ["assetId", "contractAddress", "decimals"], where);
  const contractAddress = address(raw.contractAddress, `${where}.contractAddress`);
  if (typeof raw.assetId !== "string" || !/^eip155:\d+:0x[0-9a-f]{40}$/.test(raw.assetId)) {
    paymentFail("invalid", `${where}.assetId must be eip155:<chain>:<contract>`);
  }
  if (typeof raw.decimals !== "number" || !Number.isInteger(raw.decimals) || raw.decimals < 0 || raw.decimals > 36) {
    paymentFail("invalid", `${where}.decimals is invalid`);
  }
  return { assetId: raw.assetId.toLowerCase(), contractAddress, decimals: raw.decimals };
}

export function assertPaymentNetwork(chainId: unknown): number {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) paymentFail("invalid", "chainId is invalid");
  if ((PAYMENT_PRODUCT_CHAIN_IDS as readonly number[]).includes(chainId)) {
    paymentFail("network-gated", "product network payments are gated in this phase", "product-network");
  }
  if (!(PAYMENT_SIMULATION_CHAIN_IDS as readonly number[]).includes(chainId)) {
    paymentFail("network-gated", "payment simulation chain is not allowed", "unsupported-network");
  }
  return chainId;
}

export function validateSelection(raw: unknown): PaymentSelection {
  const value = plain(raw, "selection");
  exact(value, ["consumerId", "providerNodeId", "providerFingerprint", "chainId", "asset", "amountRaw"], "selection");
  const chainId = assertPaymentNetwork(value.chainId);
  const a = asset(value.asset, "selection.asset");
  if (a.assetId !== `eip155:${chainId}:${a.contractAddress}`) paymentFail("invalid", "asset tuple does not match the chain");
  const consumerId = nodeId(value.consumerId, "selection.consumerId");
  const providerNodeId = nodeId(value.providerNodeId, "selection.providerNodeId");
  const providerFingerprint = fingerprint(value.providerFingerprint, "selection.providerFingerprint");
  return { consumerId, providerNodeId, providerFingerprint, chainId, asset: a, amountRaw: amount(value.amountRaw, "selection.amountRaw") };
}

const INTENT_FIELDS = [
  "invoiceId", "providerId", "consumerId", "chainId", "assetId", "tokenContract", "recipientAddress",
  "expectedAmountRaw", "requestedAt", "expiresAt", "payerAddress", "attributionStatus", "priceVersion",
  "status", "nonce", "digest", "createdAt", "rateNanosPerToken", "rateDecimals", "rateAssetId",
] as const;

function validateIntent(raw: unknown): DepositIntent {
  const value = plain(raw, "terms.intent");
  exact(value, INTENT_FIELDS, "terms.intent");
  const chainId = assertPaymentNetwork(value.chainId);
  const assetId = text(value.assetId, "terms.intent.assetId", 160).toLowerCase();
  const tokenContract = address(value.tokenContract, "terms.intent.tokenContract");
  if (assetId !== `eip155:${chainId}:${tokenContract}`) paymentFail("invalid", "intent asset tuple is inconsistent");
  const intent: DepositIntent = {
    invoiceId: invoice(value.invoiceId, "terms.intent.invoiceId"),
    providerId: nodeId(value.providerId, "terms.intent.providerId"),
    consumerId: nodeId(value.consumerId, "terms.intent.consumerId"),
    chainId,
    assetId,
    tokenContract,
    recipientAddress: address(value.recipientAddress, "terms.intent.recipientAddress"),
    expectedAmountRaw: amount(value.expectedAmountRaw, "terms.intent.expectedAmountRaw"),
    requestedAt: timestamp(value.requestedAt, "terms.intent.requestedAt"),
    expiresAt: timestamp(value.expiresAt, "terms.intent.expiresAt"),
    payerAddress: value.payerAddress === null ? null : address(value.payerAddress, "terms.intent.payerAddress"),
    attributionStatus: value.attributionStatus as DepositIntent["attributionStatus"],
    priceVersion: text(value.priceVersion, "terms.intent.priceVersion", 160),
    status: value.status as DepositIntent["status"],
    nonce: text(value.nonce, "terms.intent.nonce", 200),
    digest: value.digest === null ? null : text(value.digest, "terms.intent.digest", 66).toLowerCase(),
    createdAt: timestamp(value.createdAt, "terms.intent.createdAt"),
    rateNanosPerToken: text(value.rateNanosPerToken, "terms.intent.rateNanosPerToken", 80),
    rateDecimals: typeof value.rateDecimals === "number" && Number.isInteger(value.rateDecimals) && value.rateDecimals >= 0 && value.rateDecimals <= 36 ? value.rateDecimals : paymentFail("invalid", "terms.intent.rateDecimals is invalid"),
    rateAssetId: text(value.rateAssetId, "terms.intent.rateAssetId", 160).toLowerCase(),
  };
  if (intent.attributionStatus !== "unsigned" || intent.status !== "requested") paymentFail("invalid", "payment terms must be an unsigned request intent");
  if (intent.payerAddress !== null) paymentFail("invalid", "payment terms must not yet be signed");
  if (intent.digest !== null && !HEX32.test(intent.digest)) paymentFail("invalid", "intent digest must be 32-byte hex");
  if (Date.parse(intent.expiresAt) <= Date.parse(intent.requestedAt)) paymentFail("invalid", "intent expiry is before its request time");
  return intent;
}

export function validateTerms(raw: unknown): PaymentTerms {
  const value = plain(raw, "terms");
  exact(value, ["requestId", "invoiceId", "provider", "consumerId", "chainId", "asset", "recipientAddress", "amountRaw", "intent", "typedData", "digest", "createdAt", "expiresAt"], "terms");
  const requestId = uuid(value.requestId, "terms.requestId");
  const invoiceId = invoice(value.invoiceId, "terms.invoiceId");
  const providerRaw = plain(value.provider, "terms.provider");
  exact(providerRaw, ["providerId", "nodeId", "fingerprint", "authorizationGeneration", "quoteHash", "priceVersion"], "terms.provider");
  const provider: ProviderPaymentIdentity = {
    providerId: nodeId(providerRaw.providerId, "terms.provider.providerId"),
    nodeId: nodeId(providerRaw.nodeId, "terms.provider.nodeId"),
    fingerprint: fingerprint(providerRaw.fingerprint, "terms.provider.fingerprint"),
    authorizationGeneration:
      typeof providerRaw.authorizationGeneration === "number" && Number.isSafeInteger(providerRaw.authorizationGeneration) && providerRaw.authorizationGeneration >= 1
        ? providerRaw.authorizationGeneration
        : paymentFail("invalid", "terms.provider.authorizationGeneration is invalid"),
    quoteHash: text(providerRaw.quoteHash, "terms.provider.quoteHash", 128),
    priceVersion: text(providerRaw.priceVersion, "terms.provider.priceVersion", 160),
  };
  const chainId = assertPaymentNetwork(value.chainId);
  const a = asset(value.asset, "terms.asset");
  if (a.assetId !== `eip155:${chainId}:${a.contractAddress}`) paymentFail("invalid", "terms asset tuple is inconsistent");
  const recipientAddress = address(value.recipientAddress, "terms.recipientAddress");
  const amountRaw = amount(value.amountRaw, "terms.amountRaw");
  const intent = validateIntent(value.intent);
  if (intent.invoiceId !== invoiceId || intent.chainId !== chainId || intent.assetId !== a.assetId || intent.tokenContract !== a.contractAddress) {
    paymentFail("terms-mismatch", "payment terms and intent disagree");
  }
  if (intent.recipientAddress !== recipientAddress || intent.expectedAmountRaw !== amountRaw) paymentFail("terms-mismatch", "payment terms amount/recipient mismatch");
  if (intent.providerId !== provider.providerId) paymentFail("terms-mismatch", "provider id mismatch");
  const consumerId = nodeId(value.consumerId, "terms.consumerId");
  if (intent.consumerId !== consumerId) paymentFail("terms-mismatch", "consumer id mismatch");
  const rawTypedData = plain(value.typedData, "terms.typedData") as unknown as TypedData;
  // EIP-712 addresses are 20-byte values: a checksummed spelling and a lowercase
  // spelling hash identically. The wallet normally returns checksummed values
  // while the terms normalize; compare normalized fields, not strings.
  const rawMessage = plain(rawTypedData.message, "terms.typedData.message");
  const rawDomain = plain(rawTypedData.domain, "terms.typedData.domain");
  const typedData = {
    ...rawTypedData,
    domain: { ...rawDomain, verifyingContract: address(rawDomain.verifyingContract, "terms.typedData.domain.verifyingContract") },
    message: {
      ...rawMessage,
      tokenContract: address(rawMessage.tokenContract, "terms.typedData.message.tokenContract"),
      recipient: address(rawMessage.recipient, "terms.typedData.message.recipient"),
    },
  } as unknown as TypedData;
  const digest = text(value.digest, "terms.digest", 66).toLowerCase();
  if (!HEX32.test(digest)) paymentFail("invalid", "terms.digest must be 32-byte hex");
  const expected: TypedData = {
    types: DEPOSIT_TYPES,
    primaryType: "DepositIntent",
    domain: { name: DEPOSIT_DOMAIN_NAME, version: DEPOSIT_DOMAIN_VERSION, chainId, verifyingContract: DEPOSIT_VERIFYING_CONTRACT },
    message: {
      invoiceId: intent.invoiceId,
      consumerId: intent.consumerId,
      providerId: intent.providerId,
      chainId,
      assetId: a.assetId,
      tokenContract: a.contractAddress,
      recipient: recipientAddress,
      expectedAmountRaw: amountRaw,
      nonce: intent.nonce,
      requestedAt: Math.floor(Date.parse(intent.requestedAt) / 1000),
      expiresAt: Math.floor(Date.parse(intent.expiresAt) / 1000),
    },
  };
  if (canonicalTypedData(typedData) !== canonicalTypedData(expected)) paymentFail("terms-mismatch", "typed data does not match the intent");
  if (typedDataDigest(expected) !== digest) paymentFail("terms-mismatch", "typed data digest mismatch");
  if (intent.digest !== null && intent.digest !== digest) paymentFail("terms-mismatch", "intent digest differs from the signed digest");
  const createdAt = timestamp(value.createdAt, "terms.createdAt");
  const expiresAt = timestamp(value.expiresAt, "terms.expiresAt");
  if (expiresAt !== intent.expiresAt) paymentFail("terms-mismatch", "terms expiry differs from the intent");
  return { requestId, invoiceId, provider, consumerId, chainId, asset: a, recipientAddress, amountRaw, intent, typedData: expected, digest, createdAt, expiresAt };
}

function canonicalTypedData(value: TypedData): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function validateBody(kind: PaymentFrameKind, raw: unknown): PaymentFrame["body"] {
  const value = plain(raw, `body.${kind}`);
  if (kind === "request") {
    exact(value, ["selection"], "body.request");
    return { selection: validateSelection(value.selection) };
  }
  if (kind === "terms") {
    exact(value, ["terms"], "body.terms");
    return { terms: validateTerms(value.terms) };
  }
  if (kind === "signature") {
    exact(value, ["invoiceId", "requestId", "signature", "payerAddress"], "body.signature");
    const signature = text(value.signature, "body.signature", 140);
    if (!/^0x[0-9a-f]{130}$/i.test(signature)) paymentFail("invalid", "signature must be 65 bytes");
    return {
      invoiceId: invoice(value.invoiceId, "body.signature.invoiceId"),
      requestId: uuid(value.requestId, "body.signature.requestId"),
      signature: signature.toLowerCase(),
      payerAddress: address(value.payerAddress, "body.signature.payerAddress"),
    };
  }
  exact(value, ["invoiceId", "requestId", "status", "detail"], "body.status");
  if (!(PAYMENT_STATUSES as readonly string[]).includes(value.status as string)) paymentFail("invalid", "payment status is invalid");
  if (value.detail !== null && (typeof value.detail !== "string" || !DETAIL.test(value.detail))) paymentFail("invalid", "status detail is invalid");
  return {
    invoiceId: invoice(value.invoiceId, "body.status.invoiceId"),
    requestId: uuid(value.requestId, "body.status.requestId"),
    status: value.status as PaymentStatus,
    detail: value.detail as string | null,
  };
}

export function validatePaymentFrame(raw: unknown, context: P2pAuthenticatedPaymentContext, now = Date.now()): PaymentFrame {
  const value = plain(raw, "payment frame");
  exact(value, ["schema", "kind", "requestId", "invoiceId", "from", "to", "createdAt", "expiresAt", "body"], "payment frame");
  if (value.schema !== P2P_PAYMENT_SCHEMA) paymentFail("unsupported", "payment frame schema is not supported");
  if (!(PAYMENT_FRAME_KINDS as readonly string[]).includes(value.kind as string)) paymentFail("unsupported", "payment frame kind is not supported");
  const kind = value.kind as PaymentFrameKind;
  const requestId = uuid(value.requestId, "requestId");
  const invoiceId = value.invoiceId === null ? null : invoice(value.invoiceId, "invoiceId");
  if (kind !== "request" && invoiceId === null) paymentFail("invalid", "this payment frame needs an invoiceId");
  if (kind === "request" && invoiceId !== null) paymentFail("invalid", "a request frame must not choose an invoiceId");
  const from = peer(value.from, "from");
  const to = peer(value.to, "to");
  if (from.nodeId !== context.from.nodeId || from.fingerprint !== context.from.fingerprint) paymentFail("peer-mismatch", "frame sender does not match the authenticated peer");
  if (to.nodeId !== context.to.nodeId || to.fingerprint !== context.to.fingerprint) paymentFail("peer-mismatch", "frame target does not match the authenticated target");
  const createdAt = timestamp(value.createdAt, "createdAt");
  const expiresAt = timestamp(value.expiresAt, "expiresAt");
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= createdMs || expiresMs - createdMs > P2P_PAYMENT_MAX_TTL_MS) paymentFail("invalid", "frame TTL is out of bounds");
  if (createdMs > now + P2P_PAYMENT_CLOCK_SKEW_MS) paymentFail("clock-skew", "frame creation time is in the future");
  if (expiresMs <= now) paymentFail("expired", "payment frame expired");
  const body = validateBody(kind, value.body);
  if (kind === "signature") {
    const b = body as PaymentSignatureFrameBody;
    if (b.invoiceId !== invoiceId || b.requestId !== requestId) paymentFail("terms-mismatch", "signature frame correlation mismatch");
  }
  if (kind === "status") {
    const b = body as PaymentStatusFrameBody;
    if (b.invoiceId !== invoiceId || b.requestId !== requestId) paymentFail("terms-mismatch", "status frame correlation mismatch");
  }
  if (kind === "terms") {
    const b = body as PaymentTermsFrameBody;
    if (b.terms.invoiceId !== invoiceId || b.terms.requestId !== requestId) paymentFail("terms-mismatch", "terms frame correlation mismatch");
  }
  const frame: PaymentFrame = { schema: P2P_PAYMENT_SCHEMA, kind, requestId, invoiceId, from, to, createdAt, expiresAt, body };
  if (Buffer.byteLength(canonicalFrame(frame)) > P2P_PAYMENT_MAX_BYTES) paymentFail("limit", "payment frame is too large");
  return frame;
}

function canonicalFrame(frame: PaymentFrame): string {
  return JSON.stringify(frame);
}

export function paymentFrameDigest(frame: PaymentFrame): string {
  return `sha256:${createHash("sha256").update(canonicalFrame(frame)).digest("hex")}`;
}

export function selectionMatchesTerms(selection: PaymentSelection, terms: PaymentTerms): void {
  if (selection.consumerId !== terms.consumerId) paymentFail("selection-mismatch", "consumer selection mismatch");
  if (selection.providerNodeId !== terms.provider.nodeId || selection.providerFingerprint !== terms.provider.fingerprint) {
    paymentFail("selection-mismatch", "provider selection mismatch");
  }
  if (selection.chainId !== terms.chainId) paymentFail("selection-mismatch", "chain selection mismatch");
  if (selection.asset.assetId !== terms.asset.assetId || selection.asset.contractAddress !== terms.asset.contractAddress || selection.asset.decimals !== terms.asset.decimals) {
    paymentFail("selection-mismatch", "asset tuple selection mismatch");
  }
  if (selection.amountRaw !== terms.amountRaw) paymentFail("selection-mismatch", "amount selection mismatch");
}
