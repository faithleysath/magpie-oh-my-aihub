// Deposit intents: how a transfer on a shared receiving address is tied to one
// consumer, and how an ambiguous transfer is refused.
//
// The problem: a provider publishes one receiving address per chain. Many
// consumers send to it. A `Transfer` event says `from`, `to`, `amount` — nothing
// about which invoice it pays. The plugin must not guess.
//
// The mechanism (all local, no server):
//
//  1. The consumer asks for an intent. The plugin writes a row with a unique
//     `invoiceId` and a `nonce`, the exact `chainId`, `assetId`, recipient and
//     `expectedAmountRaw`, and an expiry.
//  2. The plugin hands the consumer an EIP-712 document whose domain carries
//     `chainId` and `verifyingContract` = the plugin's own attribution address,
//     and whose message carries every field above plus `consumerId`.
//  3. The consumer signs it with their own wallet and returns the signature.
//     The plugin recovers the signer locally and stores it as `payerAddress`.
//  4. A watcher only claims a `Transfer` for this intent when
//     `Transfer.from == payerAddress`, and only when exactly one *signed,
//     unexpired, unclaimed* intent matches `(chainId, assetId, recipient,
//     amount, payerAddress)`.
//
// Consequences, each of which the tests exercise:
//
//  - Cross-chain replay is refused: `chainId` is in the signed domain.
//  - Cross-invoice replay is refused: `invoiceId`, `nonce` and the exact amount
//    are signed, and a nonce is single-use.
//  - Address impersonation is impossible: the payer is recovered from the
//    signature, never taken from the request body.
//  - Two consumers cannot claim one transfer: claiming is a single SQLite
//    transaction with a unique constraint on the deposit event id.
//  - A transfer from an exchange or a contract that cannot sign stays
//    `unclaimed`. It is visible, and it is never credited automatically.
//
// The plugin holds no private key here: `verifyingContract` is only a domain
// separator. Signing is the consumer's own wallet's job.

import { randomBytes, randomUUID } from "node:crypto";
import { fromHex, keccak256Hex, toHex } from "./keccak.ts";
import { recoverAddress } from "./secp256k1.ts";
import { typedDataDigest, type TypedData, type TypedTypes } from "./eip712.ts";
import { assetIdOf, type AssetRecord, type NetworkRecord } from "./networks.ts";

export type IntentStatus = "requested" | "signed" | "matched" | "expired" | "cancelled" | "void";

/** A fixed, documented EIP-712 shape. Changing it changes every signature. */
export const DEPOSIT_DOMAIN_NAME = "Oh My AI Hub";
export const DEPOSIT_DOMAIN_VERSION = "1";

/**
 * `verifyingContract` for the deposit domain. It is **not** a deployed contract
 * and holds no funds; it only separates this signature space from every other
 * EIP-712 document a wallet may be asked to sign. The plugin uses the same value
 * on every node so a consumer can verify the document offline.
 */
export const DEPOSIT_VERIFYING_CONTRACT = "0x000000000000000000000000000000000000a1b2";

export const DEPOSIT_TYPES: TypedTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  DepositIntent: [
    { name: "invoiceId", type: "string" },
    { name: "consumerId", type: "string" },
    { name: "providerId", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "assetId", type: "string" },
    { name: "tokenContract", type: "address" },
    { name: "recipient", type: "address" },
    { name: "expectedAmountRaw", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "requestedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};

export interface DepositIntent {
  invoiceId: string;
  providerId: string;
  consumerId: string;
  chainId: number;
  assetId: string;
  tokenContract: string;
  recipientAddress: string;
  /** exact ERC-20 base units; a decimal string so bigint survives JSON */
  expectedAmountRaw: string;
  requestedAt: string;
  expiresAt: string;
  /** recovered from the consumer's signature; null until signed */
  payerAddress: string | null;
  attributionStatus: "unsigned" | "signed" | "matched" | "unclaimed" | "void";
  priceVersion: string;
  status: IntentStatus;
  nonce: string;
  /** the digest that was signed, for audit; null until signed */
  digest: string | null;
  createdAt: string;
  /**
   * The rate snapshot taken when the intent was issued.
   *
   * A deposit is converted at **this** rate, never at whatever the registry says
   * when the transfer eventually lands. Without it, an operator changing a test
   * rate between the request and the confirmation would silently change the
   * value of a payment the consumer already agreed to, which is exactly the
   * repricing the phase-6 ledger refuses to do for consumption.
   */
  rateNanosPerToken: string;
  rateDecimals: number;
  rateAssetId: string;
}

export interface IntentRequest {
  providerId: string;
  consumerId: string;
  chainId: number;
  assetId: string;
  recipientAddress: string;
  expectedAmountRaw: string;
  ttlSec: number;
}

/** What the consumer's wallet must sign, plus the values it must be shown. */
export interface SignableIntent {
  intent: DepositIntent;
  typedData: TypedData;
  digest: string;
  /** a plain-language summary for the CLI and the page */
  summary: string;
}

export function intentTypedData(intent: DepositIntent, net: NetworkRecord, asset: AssetRecord): TypedData {
  if (intent.chainId !== net.chainId) throw new Error("the intent and the network disagree about the chain");
  if (intent.assetId !== asset.assetId) throw new Error("the intent and the asset disagree about the token");
  return {
    types: DEPOSIT_TYPES,
    primaryType: "DepositIntent",
    domain: {
      name: DEPOSIT_DOMAIN_NAME,
      version: DEPOSIT_DOMAIN_VERSION,
      chainId: net.chainId,
      verifyingContract: DEPOSIT_VERIFYING_CONTRACT,
    },
    message: {
      invoiceId: intent.invoiceId,
      consumerId: intent.consumerId,
      providerId: intent.providerId,
      chainId: net.chainId,
      assetId: intent.assetId,
      tokenContract: asset.contractAddress,
      recipient: intent.recipientAddress,
      expectedAmountRaw: intent.expectedAmountRaw,
      nonce: intent.nonce,
      requestedAt: Math.floor(new Date(intent.requestedAt).getTime() / 1000),
      expiresAt: Math.floor(new Date(intent.expiresAt).getTime() / 1000),
    },
  };
}

/** The digest a consumer's wallet signs. Deterministic for the same intent. */
export function intentDigest(intent: DepositIntent, net: NetworkRecord, asset: AssetRecord): string {
  return typedDataDigest(intentTypedData(intent, net, asset));
}

export interface BuildIntentInput {
  request: IntentRequest;
  network: NetworkRecord;
  asset: AssetRecord;
  /** the plugin's attribution price version, recorded so history cannot reprice */
  priceVersion: string;
  now?: Date;
}

/**
 * Builds an unsigned intent. Every field that a later match depends on is fixed
 * here and cannot be edited afterwards: `setPayer` only adds the signature.
 */
export function buildIntent(input: BuildIntentInput): DepositIntent {
  const now = input.now ?? new Date();
  const { request, network, asset } = input;
  if (network.chainId !== request.chainId) throw new Error("the network does not match the requested chain");
  if (asset.assetId !== request.assetId) throw new Error("the asset does not belong to the requested chain");
  if (asset.chainId !== network.chainId) throw new Error("the asset is registered on another chain");
  if (!asset.credit || asset.pricing.kind !== "fixed-test-rate" || asset.testnetOnly !== true) {
    throw new Error(`asset ${asset.assetId} is not a creditable test asset; a mainnet/read-only asset cannot back a deposit intent`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.recipientAddress)) throw new Error("a deposit needs a provider receiving address");
  if (request.recipientAddress.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error("the zero address cannot receive a deposit");
  }
  let amount: bigint;
  try {
    amount = BigInt(request.expectedAmountRaw);
  } catch {
    throw new Error("expectedAmountRaw must be an integer string of base units");
  }
  if (amount <= 0n) throw new Error("a deposit must expect a positive amount");
  if (request.ttlSec < 60 || request.ttlSec > 7 * 86_400) throw new Error("a deposit intent lives between 1 minute and 7 days");
  const requestedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + request.ttlSec * 1000).toISOString();
  return {
    invoiceId: `inv_${randomUUID()}`,
    providerId: request.providerId,
    consumerId: request.consumerId,
    chainId: network.chainId,
    assetId: assetIdOf(network.chainId, asset.contractAddress),
    tokenContract: asset.contractAddress,
    recipientAddress: request.recipientAddress,
    expectedAmountRaw: amount.toString(),
    requestedAt,
    expiresAt,
    payerAddress: null,
    attributionStatus: "unsigned",
    priceVersion: input.priceVersion,
    status: "requested",
    // Frozen here, at issue time, and never read from the registry again.
    rateNanosPerToken: asset.pricing.nanosPerToken,
    rateDecimals: asset.decimals,
    rateAssetId: asset.assetId,
    nonce: `0x${randomBytes(16).toString("hex")}`,
    digest: null,
    createdAt: requestedAt,
  };
}

export interface SignatureCheck {
  ok: boolean;
  payer: string | null;
  reason: string | null;
}

/**
 * Recovers the payer from a consumer's signature and checks it against the
 * intent. `expectedPayer`, when the consumer already has a bound wallet, must
 * match: a second wallet cannot claim the same consumer's invoice.
 *
 * A bad signature is a refusal, never an address: `ok: false` carries no payer.
 */
export function verifyIntentSignature(input: {
  intent: DepositIntent;
  network: NetworkRecord;
  asset: AssetRecord;
  signature: string;
  expectedPayer?: string | null;
}): SignatureCheck {
  let digest: string;
  try {
    digest = intentDigest(input.intent, input.network, input.asset);
  } catch (e) {
    return { ok: false, payer: null, reason: String((e as Error).message ?? e) };
  }
  if (input.intent.digest && input.intent.digest !== digest) {
    return { ok: false, payer: null, reason: "the stored digest does not match this intent" };
  }
  let payer: string | null;
  try {
    payer = recoverAddress(fromHex(digest), input.signature);
  } catch (e) {
    return { ok: false, payer: null, reason: String((e as Error).message ?? e) };
  }
  if (!payer) return { ok: false, payer: null, reason: "the signature does not recover to any address for this intent" };
  if (payer.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return { ok: false, payer: null, reason: "the recovered address is the zero address" };
  }
  if (input.expectedPayer && input.expectedPayer.toLowerCase() !== payer.toLowerCase()) {
    return { ok: false, payer: null, reason: `this consumer is bound to ${input.expectedPayer}, not ${payer}` };
  }
  return { ok: true, payer, reason: null };
}

/** Whether an intent can still be matched at `at`. */
export function isExpired(intent: DepositIntent, at: Date = new Date()): boolean {
  return new Date(intent.expiresAt).getTime() <= at.getTime();
}

/**
 * Whether an intent is eligible to claim a transfer. Both sides must be exact:
 * a transfer of another amount, from another payer or on another chain never
 * matches, and an unsigned intent never matches at all.
 */
export function matchesTransfer(input: {
  intent: DepositIntent;
  chainId: number;
  tokenContract: string;
  recipient: string;
  from: string;
  amountRaw: bigint;
  at?: Date;
}): { ok: boolean; reason: string | null } {
  const { intent } = input;
  const at = input.at ?? new Date();
  if (intent.status !== "signed" || intent.attributionStatus !== "signed") return { ok: false, reason: `intent is ${intent.status}/${intent.attributionStatus}` };
  if (!intent.payerAddress) return { ok: false, reason: "intent has no signed payer" };
  if (isExpired(intent, at)) return { ok: false, reason: "intent has expired" };
  if (intent.chainId !== input.chainId) return { ok: false, reason: `intent is for chain ${intent.chainId}` };
  if (intent.tokenContract.toLowerCase() !== input.tokenContract.toLowerCase()) return { ok: false, reason: "intent is for another token contract" };
  if (intent.recipientAddress.toLowerCase() !== input.recipient.toLowerCase()) return { ok: false, reason: "intent is for another recipient" };
  if (intent.payerAddress.toLowerCase() !== input.from.toLowerCase()) return { ok: false, reason: "the transfer did not come from the signed payer" };
  if (BigInt(intent.expectedAmountRaw) !== input.amountRaw) return { ok: false, reason: "the transfer amount is not the expected amount" };
  return { ok: true, reason: null };
}

/** `assetId` for a chain/contract pair, re-exported so callers need one import. */
export { assetIdOf };

/** The digest hex a consumer signs, useful in a CLI listing. */
export function digestOf(intent: DepositIntent, net: NetworkRecord, asset: AssetRecord): string {
  return intentDigest(intent, net, asset);
}

/** Keccak of a string, used to fingerprint a document without storing it. */
export function documentFingerprint(doc: unknown): string {
  return keccak256Hex(toHex(new TextEncoder().encode(JSON.stringify(doc))));
}
