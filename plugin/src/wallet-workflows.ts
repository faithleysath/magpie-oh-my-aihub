// Shared, pure wallet document/planning helpers. No signing, RPC, CLI or key custody.
import { createHash } from "node:crypto";
import { canonicalJson } from "./catalog.ts";
import { DEPOSIT_DOMAIN_NAME, DEPOSIT_DOMAIN_VERSION, DEPOSIT_TYPES, DEPOSIT_VERIFYING_CONTRACT, intentDigest, intentTypedData, type DepositIntent } from "./deposits.ts";
import { typedDataDigest } from "./eip712.ts";
import { recoverAddress } from "./secp256k1.ts";
import { fromHex } from "./keccak.ts";
import { formatTokenAmount, parseTokenAmount } from "./walletamount.ts";
import { convertRawToNanos } from "./watcher.ts";
import type { AssetRecord, NetworkRecord } from "./networks.ts";
import type { ConsumerView } from "./provisioner.ts";

export class WalletWorkflowError extends Error {}
export const walletBad = (message: string): never => { throw new WalletWorkflowError(message); };
export const walletHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function walletObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return walletBad("需要 JSON 对象文件");
  return value as Record<string, any>;
}
export function walletFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) walletBad("包含不支持的输入字段");
}
export function walletText(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return walletBad(`${label}格式不正确`);
  return value.trim();
}
export function walletAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) return walletBad("需要有效的非零钱包地址");
  return value;
}
export function boundedWalletDocument(value: unknown, maxBytes = 32 * 1024): Record<string, any> {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return walletBad("文件无法读取"); }
  if (!encoded || Buffer.byteLength(encoded) > maxBytes) return walletBad(`文件过大，最多 ${maxBytes / 1024} KiB`);
  return walletObject(value);
}

/** File adapters share decoding; missing payer can still be prompted by the CLI. */
export function decodeSignatureText(raw: string): {signature:string;payerAddress:string|null} {
  if (Buffer.byteLength(raw)>8192) return walletBad("签名文件过大，最多 8 KiB");
  const text=raw.trim();
  if (!text.startsWith("{")) return {signature:text,payerAddress:null};
  let doc:Record<string,any>;
  try{doc=walletObject(JSON.parse(text));}catch{return walletBad("签名文件 JSON 无法读取");}
  walletFields(doc,["schema","invoiceId","signature","payerAddress","payer"]);
  if(typeof doc.signature!=="string")return walletBad("签名文件缺少签名");
  return {signature:doc.signature,payerAddress:typeof(doc.payerAddress??doc.payer)==="string"?(doc.payerAddress??doc.payer):null};
}

/** CLI file adapter and browser file adapter share the same signature parser. */
export function parseWalletSignature(value: unknown, invoiceId?: string): { signature: string; payerAddress: string } {
  const document = boundedWalletDocument(value);
  walletFields(document, ["schema", "invoiceId", "signature", "payerAddress", "payer"]);
  if (document.schema !== undefined && document.schema !== "ohmyaihub.deposit-signature/v1") walletBad("签名文件格式不支持");
  if (document.invoiceId !== undefined && document.invoiceId !== invoiceId) walletBad("签名文件属于另一笔充值请求");
  if (typeof document.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(document.signature)) walletBad("签名必须是 65 字节十六进制内容");
  const payerAddress = walletAddress(document.payerAddress ?? document.payer);
  if (document.payerAddress && document.payer && document.payerAddress.toLowerCase() !== document.payer.toLowerCase()) walletBad("签名文件的钱包地址不一致");
  return { signature: document.signature, payerAddress };
}

export function planWalletIntent(input: {
  consumer: ConsumerView; providerId: string; network: NetworkRecord; asset: AssetRecord;
  recipientAddress: string; amount: string; ttlSec: number; pending: DepositIntent[];
}) {
  const { consumer, providerId, network, asset, pending } = input;
  if (consumer.revokedAt) walletBad("消费者授权已撤销，请选择有效授权");
  if (!network.enabled || network.networkType !== "testnet") walletBad("请选择已启用的测试网络");
  if (!asset.enabled || asset.chainId !== network.chainId || !asset.testnetOnly || !asset.credit || asset.pricing.kind !== "fixed-test-rate") {
    walletBad("请选择此网络已登记、可授信的测试代币");
  }
  const recipientAddress = walletAddress(input.recipientAddress);
  if (!Number.isInteger(input.ttlSec) || input.ttlSec < 60 || input.ttlSec > 604800) walletBad("请求有效期必须在 60 秒至 7 天之间");
  if (typeof input.amount !== "string" || input.amount.length > 120) walletBad("请填写代币数量");
  const parsed = parseTokenAmount(input.amount, asset.decimals);
  if (!parsed.ok) return walletBad("数量必须是可精确表示的普通小数，不能超过代币精度");
  if (BigInt(parsed.raw) <= 0n) walletBad("数量必须大于零");
  if (BigInt(parsed.raw) >= 1n << 256n) walletBad("数量超过 ERC-20 的 uint256 范围");
  if (!/^\d+$/.test(asset.pricing.nanosPerToken) || BigInt(asset.pricing.nanosPerToken) <= 0n) walletBad("代币测试兑换率不可用");
  // Validate exactly the conversion the watcher will later book, before the
  // caller reserves a durable operation or creates an invoice. Predictable
  // numeric refusals are input errors, never an uncertain reserved operation.
  let convertedNanos: number;
  try { convertedNanos = convertRawToNanos({ rawAmount: BigInt(parsed.raw), asset }).nanos; }
  catch { return walletBad("数量按固定测试汇率换算后超出可安全记账范围"); }
  const binding = { consumerId: consumer.consumerId, models: consumer.models, priceVersion: consumer.priceVersion,
    providerId, chainId: network.chainId, assetId: asset.assetId, contractAddress: asset.contractAddress,
    amountRaw: parsed.raw, amountTokens: parsed.normalised, recipientAddress, decimals: asset.decimals,
    symbol: asset.symbol, rate: asset.pricing, ttlSec: input.ttlSec,
    paused: consumer.paused, pending: pending.map(i => ({ invoiceId: i.invoiceId, status: i.status, expiresAt: i.expiresAt })) };
  return { ...binding, previewHash: walletHash(binding), estimatedUsd: convertedNanos / 1_000_000_000,
    blockers: pending.length ? ["已有未完成的充值请求，请继续或取消原请求"] : [] };
}

export function externalSignatureDocument(raw:unknown, signature:unknown, payerAddress:unknown, localConsumerId:string|null, now:Date=new Date()) {
  const {document}=previewDepositDocument(raw,localConsumerId,now);
  const parsed=parseWalletSignature({signature,payerAddress},document.invoiceId);
  const recovered=recoverAddress(fromHex(document.digest),parsed.signature);
  if(!recovered||recovered.toLowerCase()!==parsed.payerAddress.toLowerCase())return walletBad("外部签名与请求或付款钱包不匹配");
  return {document:{schema:"ohmyaihub.deposit-signature/v1" as const,invoiceId:document.invoiceId,payerAddress:recovered,signature:parsed.signature},verified:true as const};
}

export function walletIntentDocument(intent: DepositIntent, network: NetworkRecord, asset: AssetRecord) {
  return { schema: "ohmyaihub.deposit-request/v1" as const, invoiceId: intent.invoiceId,
    consumerId: intent.consumerId, providerId: intent.providerId, chainId: intent.chainId,
    asset: { assetId: intent.assetId, contractAddress: intent.tokenContract, symbol: asset.symbol, decimals: intent.rateDecimals },
    amount: { tokens: formatTokenAmount(intent.expectedAmountRaw, intent.rateDecimals), raw: intent.expectedAmountRaw },
    recipientAddress: intent.recipientAddress, expiresAt: intent.expiresAt,
    digest: intentDigest(intent, network, asset), typedData: intentTypedData(intent, network, asset) };
}

/** Imported files never create intents/credit; compare every visible field with the signed message. */
export function previewDepositDocument(raw: unknown, localConsumerId: string | null, now = new Date()) {
  const d = boundedWalletDocument(raw);
  walletFields(d, ["schema", "invoiceId", "consumerId", "providerId", "chainId", "asset", "amount", "recipientAddress", "expiresAt", "digest", "typedData"]);
  if (d.schema !== "ohmyaihub.deposit-request/v1") walletBad("不是充值请求文件");
  if (localConsumerId && d.consumerId !== localConsumerId) walletBad("充值请求属于另一消费者节点");
  if (![97, 84532].includes(d.chainId)) walletBad("文件不是当前支持的测试网络");
  const asset = walletObject(d.asset), amount = walletObject(d.amount), typed = walletObject(d.typedData);
  walletFields(asset, ["assetId", "contractAddress", "symbol", "decimals"]); walletFields(amount, ["tokens", "raw"]);
  walletFields(typed, ["types", "primaryType", "domain", "message"]);
  const domain = walletObject(typed.domain), message = walletObject(typed.message);
  if (canonicalJson(typed.types) !== canonicalJson(DEPOSIT_TYPES) || typed.primaryType !== "DepositIntent" ||
      canonicalJson(domain) !== canonicalJson({ name: DEPOSIT_DOMAIN_NAME, version: DEPOSIT_DOMAIN_VERSION, chainId: d.chainId, verifyingContract: DEPOSIT_VERIFYING_CONTRACT })) walletBad("签名域或类型不符合充值请求规范");
  const invoiceId = walletText(d.invoiceId, "请求编号"), consumerId = walletText(d.consumerId, "消费者"), providerId = walletText(d.providerId, "提供方");
  const contractAddress = walletAddress(asset.contractAddress), recipientAddress = walletAddress(d.recipientAddress);
  if (asset.assetId !== `eip155:${d.chainId}:${contractAddress.toLowerCase()}`) walletBad("代币标识与网络和合约不一致");
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) walletBad("代币精度无效");
  const parsed = parseTokenAmount(amount.tokens, asset.decimals);
  if (!parsed.ok) return walletBad("显示数量不能精确表示");
  if (parsed.raw !== amount.raw || BigInt(parsed.raw) <= 0n) return walletBad("显示数量与签名原始数量不一致");
  if (BigInt(parsed.raw) >= 1n << 256n) walletBad("数量超过 ERC-20 的 uint256 范围");
  if (!/^0x[0-9a-fA-F]{32}$/.test(message.nonce) || !Number.isSafeInteger(message.requestedAt) || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= message.requestedAt || message.expiresAt - message.requestedAt > 604800) walletBad("请求时间或随机数无效");
  if (typeof d.expiresAt !== "string" || Math.floor(Date.parse(d.expiresAt)/1000) !== message.expiresAt || Date.parse(d.expiresAt) <= now.getTime()) walletBad("请求已过期或到期时间不一致");
  const expectedMessage = { invoiceId, consumerId, providerId, chainId: d.chainId, assetId: asset.assetId,
    tokenContract: contractAddress, recipient: recipientAddress, expectedAmountRaw: parsed.raw,
    nonce: message.nonce, requestedAt: message.requestedAt, expiresAt: message.expiresAt };
  if (canonicalJson(message) !== canonicalJson(expectedMessage) || typeof d.digest !== "string" || typedDataDigest(typed as any).toLowerCase() !== d.digest.toLowerCase()) walletBad("文件显示内容或摘要与真实签名数据不一致");
  const document = { schema: d.schema, invoiceId, consumerId, providerId, chainId: d.chainId,
    asset: { assetId: asset.assetId, contractAddress, symbol: walletText(asset.symbol, "代币符号", 32), decimals: asset.decimals },
    amount: { tokens: parsed.normalised, raw: parsed.raw }, recipientAddress, expiresAt: d.expiresAt,
    digest: d.digest, typedData: { types: DEPOSIT_TYPES, primaryType: "DepositIntent", domain, message: expectedMessage } };
  return { document, verified: true as const, canTransfer: false as const };
}
