// TEST ONLY. The synthetic unfunded scalar lives exclusively in this process.
import { randomBytes } from "node:crypto";
import { DEPOSIT_DOMAIN_NAME, DEPOSIT_DOMAIN_VERSION, DEPOSIT_TYPES, DEPOSIT_VERIFYING_CONTRACT } from "../../../../../plugin/src/deposits.ts";
import { typedDataDigest } from "../../../../../plugin/src/eip712.ts";
import type { TypedData } from "../../../../../plugin/src/eip712.ts";
import { addressOf, signDigest } from "../../../../../plugin/test/support/signer.ts";
import { address, chainId, fields, FixtureInputError, object } from "./model.ts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function requireInput(value: unknown, message: string): asserts value { if (!value) throw new FixtureInputError(message); }
function boundedText(value: unknown): string {
  requireInput(typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value), "invalid document identity");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}

export interface ReviewedDeposit {
  document: Record<string, unknown>;
  typedData: TypedData;
  digest: string;
  invoiceId: string;
  chainId: 97 | 84532;
  tokenContract: string;
  recipient: string;
  raw: string;
}

/** Accept only the displayed production deposit shape; never an arbitrary digest. */
export function reviewDeposit(input: unknown, now = Date.now()): ReviewedDeposit {
  const d = object(input);
  fields(d, ["schema", "invoiceId", "consumerId", "providerId", "chainId", "asset", "amount", "recipientAddress", "expiresAt", "digest", "typedData"]);
  requireInput(d.schema === "ohmyaihub.deposit-request/v1", "production deposit-request file required");
  const invoiceId = boundedText(d.invoiceId), consumerId = boundedText(d.consumerId), providerId = boundedText(d.providerId);
  const id = chainId(d.chainId);
  const asset = object(d.asset), amount = object(d.amount);
  fields(asset, ["assetId", "contractAddress", "symbol", "decimals"]); fields(amount, ["tokens", "raw"]);
  const contract = address(asset.contractAddress), recipient = address(d.recipientAddress);
  requireInput(asset.assetId === `eip155:${id}:${contract}` && typeof asset.symbol === "string" && asset.symbol.length <= 30, "asset identity mismatch");
  requireInput(typeof asset.decimals === "number" && Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 36, "invalid token decimals");
  requireInput(typeof amount.raw === "string" && /^[1-9][0-9]{0,77}$/.test(amount.raw) && BigInt(amount.raw) < (1n << 256n), "positive uint256 amount required");
  requireInput(typeof amount.tokens === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount.tokens) && amount.tokens.length <= 100, "invalid display token amount");
  const [whole, fraction = ""] = amount.tokens.split(".");
  requireInput(fraction.length <= asset.decimals && BigInt(whole! + fraction.padEnd(asset.decimals, "0")) === BigInt(amount.raw), "display amount differs from signed raw amount");
  const typed = object(d.typedData);
  fields(typed, ["types", "primaryType", "domain", "message"]);
  requireInput(typed.primaryType === "DepositIntent" && canonical(typed.types) === canonical(DEPOSIT_TYPES), "unexpected typed-data definition");
  const domain = object(typed.domain), message = object(typed.message);
  fields(domain, DEPOSIT_TYPES.EIP712Domain!.map((f) => f.name));
  fields(message, DEPOSIT_TYPES.DepositIntent!.map((f) => f.name));
  requireInput(domain.name === DEPOSIT_DOMAIN_NAME && domain.version === DEPOSIT_DOMAIN_VERSION && domain.chainId === id && domain.verifyingContract === DEPOSIT_VERIFYING_CONTRACT, "unexpected signing domain");
  requireInput(message.invoiceId === invoiceId && message.consumerId === consumerId && message.providerId === providerId && message.chainId === id && message.assetId === asset.assetId && address(message.tokenContract) === contract && address(message.recipient) === recipient && message.expectedAmountRaw === amount.raw, "document differs from signed fields");
  requireInput(typeof message.nonce === "string" && /^0x[0-9a-f]{32}$/i.test(message.nonce), "invalid intent nonce");
  requireInput(typeof message.requestedAt === "number" && Number.isSafeInteger(message.requestedAt) && message.requestedAt <= Math.floor(now / 1000) + 5 && typeof message.expiresAt === "number" && Number.isSafeInteger(message.expiresAt) && message.expiresAt > Math.floor(now / 1000) && message.expiresAt > message.requestedAt && message.expiresAt - message.requestedAt <= 604800, "expired or invalid intent lifetime");
  requireInput(typeof d.expiresAt === "string" && Number.isFinite(Date.parse(d.expiresAt)) && Math.floor(Date.parse(d.expiresAt) / 1000) === message.expiresAt, "expiry differs from signed fields");
  const typedData = typed as unknown as TypedData;
  const digest = typedDataDigest(typedData);
  requireInput(d.digest === digest, "document digest mismatch");
  return { document: structuredClone(d), typedData, digest, invoiceId, chainId: id, tokenContract: contract, recipient, raw: amount.raw };
}

export function reviewTransfer(input: unknown, now = Date.now()) {
  const d = object(input);
  fields(d, ["schema", "invoiceId", "consumerId", "providerId", "chainId", "assetId", "contractAddress", "symbol", "decimals", "amountRaw", "amountTokens", "recipientAddress", "payerAddress", "expiresAt"]);
  requireInput(d.schema === "ohmyaihub.transfer-instructions/v1", "production transfer-instructions file required");
  boundedText(d.invoiceId); boundedText(d.consumerId); boundedText(d.providerId);
  const id = chainId(d.chainId), contract = address(d.contractAddress);
  requireInput(d.assetId === `eip155:${id}:${contract}`, "transfer asset identity mismatch");
  requireInput(typeof d.expiresAt === "string" && Date.parse(d.expiresAt) > now, "transfer instructions expired");
  requireInput(typeof d.amountRaw === "string" && /^[1-9][0-9]{0,77}$/.test(d.amountRaw) && BigInt(d.amountRaw) < (1n << 256n), "positive uint256 amount required");
  requireInput(typeof d.decimals === "number" && Number.isInteger(d.decimals) && d.decimals >= 0 && d.decimals <= 36 && typeof d.amountTokens === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(d.amountTokens), "invalid transfer amount");
  const [whole, fraction = ""] = d.amountTokens.split(".");
  requireInput(fraction.length <= d.decimals && BigInt(whole! + fraction.padEnd(d.decimals, "0")) === BigInt(d.amountRaw), "transfer display amount mismatch");
  return { chainId: id, from: address(d.payerAddress), to: address(d.recipientAddress), amountRaw: d.amountRaw, tokenContract: contract };
}

export class SyntheticSigner {
  #key: bigint | null = null;
  generate(): { payerAddress: string } {
    let key: bigint;
    do { key = BigInt("0x" + randomBytes(32).toString("hex")); } while (key === 0n || key >= N);
    this.#key = key;
    return { payerAddress: addressOf(key) };
  }
  state(): { payerAddress: string | null } { return { payerAddress: this.#key === null ? null : addressOf(this.#key) }; }
  clear(): void { this.#key = null; }
  sign(document: unknown, consent: unknown) {
    requireInput(consent === true, "explicit review and consent required");
    requireInput(this.#key !== null, "generate disposable unfunded fixture wallet first");
    const reviewed = reviewDeposit(document);
    return { schema: "ohmyaihub.deposit-signature/v1", invoiceId: reviewed.invoiceId, payerAddress: addressOf(this.#key), signature: signDigest(reviewed.digest, this.#key) };
  }
}
