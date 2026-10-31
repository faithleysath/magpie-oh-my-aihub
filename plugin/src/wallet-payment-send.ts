// Built-in wallet manual send: preview, explicit confirmation, journal gate and
// one signed ERC-20 transfer on an allowed test chain.
//
// This is the manual path only. It never runs unattended, never signs without a
// live console session and an unlocked vault, and never handles 56/8453. The
// journal (payment-operations) is the single send gate: reserve -> sign ->
// markBroadcasting -> broadcast -> recordHash, and an ambiguous broadcast is
// recorded as unknown instead of retried.
//
// The chain transaction is an ERC-20 transfer to the exact recipient/amount of
// the authenticated obligation. Gas, nonce and fee values are previewed from
// the chain and revalidated before the send; a changed nonce or a fee above the
// approved ceiling refuses the send and asks for a new preview.

import { randomUUID } from "node:crypto";
import type { Service } from "./service.ts";
import type { Wallet } from "./wallet.ts";
import type { ConsumerPaymentService } from "./p2p-payment.ts";
import type { TrustedPaymentObligation } from "./payment-local-service.ts";
import { expectedOperation, paymentOperationPortFor } from "./payment-local-service.ts";
import type { ConsoleActionContext } from "./console-server.ts";
import { walletLocalService } from "./wallet-local-service.ts";
import { EvmClient } from "./evm.ts";
import { assertNoMainnetSend, isMainnetChainId } from "./mainnet-gate.ts";
import { erc20TransferCalldataHash, PaymentOperationError } from "./payment-operations.ts";
import { formatTokenAmount } from "./walletamount.ts";

const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEWS_PER_SESSION = 4;
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SELECTOR = "0xa9059cbb";

interface LocalContext {
  sessionId: string;
  assertActive?: () => boolean;
  isActive?: () => boolean;
}

export class WalletSendError extends Error {
  constructor(
    readonly code:
      | "not-available"
      | "invalid"
      | "stale"
      | "locked"
      | "wallet-mismatch"
      | "insufficient"
      | "fee-changed"
      | "nonce-changed"
      | "journal"
      | "broadcast-unknown"
      | "refused",
    message: string,
  ) {
    super(message);
    this.name = "WalletSendError";
  }
}

export interface WalletSendPreview {
  schema: "ohmyaihub.wallet-send-preview/v1";
  invoiceId: string;
  previewRef: string;
  expiresAt: string;
  chainId: number;
  assetId: string;
  tokenAddress: string;
  recipientAddress: string;
  amountRaw: string;
  amountTokens: string;
  decimals: number;
  payerAddress: string;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  maxGasCostWei: string;
  nativeBalanceWei: string;
  tokenBalanceRaw: string;
  calldataHash: string;
  digest: string;
  nativeSymbol: string;
  note: string;
}

interface PreviewRecord {
  sessionId: string;
  preview: WalletSendPreview;
  expiresAtMs: number;
}

function lower(value: string): string { return value.toLowerCase(); }
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new WalletSendError("invalid", `${label} is invalid`);
  }
  return value.trim();
}

function quantity(hex: unknown, label: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new WalletSendError("invalid", `${label} returned no hex quantity`);
  return BigInt(hex);
}

function blockField(raw: unknown, field: string): bigint | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)[field];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  return BigInt(value);
}

export class WalletPaymentSender {
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly now: () => number;
  private readonly clientFactory: (chainId: number) => EvmClient;

  constructor(
    private readonly service: Service,
    private readonly consumer: ConsumerPaymentService,
    private readonly wallet: Wallet,
    options: { now?: () => number; clientFactory?: (chainId: number) => EvmClient } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.clientFactory = options.clientFactory ?? ((chainId) => {
      const network = this.wallet.registryView().network(chainId);
      if (!network) throw new WalletSendError("not-available", `chain ${chainId} is not registered`);
      return new EvmClient({ chainId, endpoints: network.rpcEndpoints, now: this.now });
    });
  }

  private client(chainId: number): EvmClient {
    assertNoMainnetSend({ chainId, operation: "a built-in wallet payment" });
    if (isMainnetChainId(chainId) || (chainId !== 97 && chainId !== 84532)) {
      throw new WalletSendError("refused", `chain ${chainId} is not a sendable test chain`);
    }
    return this.clientFactory(chainId);
  }

  private resolve(invoiceId: string): TrustedPaymentObligation {
    const obligation = this.consumer.obligationResolver().resolve(invoiceId);
    if (!obligation) throw new WalletSendError("not-available", "the payment is not waiting for a verified send (provider acknowledgement and a valid signature are required)");
    if (obligation.binding.chainId === 56 || obligation.binding.chainId === 8453) throw new WalletSendError("refused", "mainnet payments are disabled");
    if (obligation.binding.expiresAtMs <= this.now()) throw new WalletSendError("stale", "the payment request expired; request new terms");
    return obligation;
  }

  private prune(): void {
    const at = this.now();
    for (const [key, record] of this.previews) if (record.expiresAtMs <= at) this.previews.delete(key);
  }

  /** Read-only chain preview; no journal row, no signature, no broadcast. */
  async preview(input: { invoiceId: unknown; context: ConsoleActionContext }): Promise<WalletSendPreview> {
    this.prune();
    const invoiceId = text(input.invoiceId, "invoiceId", 128);
    const obligation = this.resolve(invoiceId);
    const b = obligation.binding;
    if (!b.intentHash) throw new WalletSendError("invalid", "the payment binding has no intent hash");
    if (!ADDRESS.test(b.consumerAddress) || !ADDRESS.test(b.recipientAddress) || !ADDRESS.test(b.contractAddress)) {
      throw new WalletSendError("invalid", "the payment binding has an invalid address");
    }
    const expectedCalldata = erc20TransferCalldataHash(b.recipientAddress, b.amountRaw);
    if (expectedCalldata !== b.calldataHash) throw new WalletSendError("invalid", "the payment binding calldata does not match its hash");
    const snapshot = await walletLocalService(this.service).status();
    const vault = snapshot.wallet;
    if (vault.status !== "unlocked") throw new WalletSendError("locked", "unlock the built-in wallet before paying");
    if (!vault.address || lower(vault.address) !== b.consumerAddress) {
      throw new WalletSendError("wallet-mismatch", "the unlocked wallet is not the address that signed this payment");
    }
    const client = this.client(b.chainId);
    const network = this.wallet.registryView().network(b.chainId);
    if (!network) throw new WalletSendError("not-available", "the payment network is not registered");
    let nonceHex: string, gasHex: string, nativeHex: string, tokenHex: string, block: unknown, tipHex: string | null;
    try {
      nonceHex = await client.call<string>("eth_getTransactionCount", [b.consumerAddress, "pending"]);
      gasHex = await client.call<string>("eth_estimateGas", [{
        from: b.consumerAddress,
        to: b.contractAddress,
        value: "0x0",
        data: `${SELECTOR}${b.recipientAddress.slice(2).padStart(64, "0")}${BigInt(b.amountRaw).toString(16).padStart(64, "0")}`,
      }]);
      nativeHex = await client.call<string>("eth_getBalance", [b.consumerAddress, "latest"]);
      const data = `${SELECTOR}${b.consumerAddress.slice(2).padStart(64, "0")}`;
      tokenHex = await client.call<string>("eth_call", [{ to: b.contractAddress, data }, "latest"]);
      block = await client.call<unknown>("eth_getBlockByNumber", ["latest", false]);
      tipHex = await client.call<string>("eth_maxPriorityFeePerGas", []).catch(() => null);
    } catch (error) {
      throw new WalletSendError("not-available", `the chain could not be read: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    }
    const nonce = Number(quantity(nonceHex, "eth_getTransactionCount"));
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new WalletSendError("invalid", "the account nonce is out of range");
    const estimate = quantity(gasHex, "eth_estimateGas");
    const gasLimit = estimate + estimate / 4n + 2_000n;
    const baseFee = blockField(block, "baseFeePerGas");
    if (baseFee === null) throw new WalletSendError("not-available", "the chain did not report a base fee; EIP-1559 preview is unavailable");
    const tip = tipHex ? quantity(tipHex, "eth_maxPriorityFeePerGas") : 1_000_000_000n;
    const maxPriorityFeePerGas = tip > 5_000_000_000n ? 5_000_000_000n : tip;
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas + 1_000_000_000n;
    const nativeBalance = quantity(nativeHex, "eth_getBalance");
    const tokenBalance = quantity(tokenHex, "token balanceOf");
    const maxGasCost = gasLimit * maxFeePerGas;
    if (nativeBalance < maxGasCost) throw new WalletSendError("insufficient", `the wallet needs about ${maxGasCost} wei for gas; it has ${nativeBalance}`);
    if (tokenBalance < BigInt(b.amountRaw)) throw new WalletSendError("insufficient", "the wallet does not hold the exact token amount for this payment");
    const preview: WalletSendPreview = Object.freeze({
      schema: "ohmyaihub.wallet-send-preview/v1",
      invoiceId,
      previewRef: randomUUID(),
      expiresAt: new Date(this.now() + PREVIEW_TTL_MS).toISOString(),
      chainId: b.chainId,
      assetId: b.assetId,
      tokenAddress: b.contractAddress,
      recipientAddress: b.recipientAddress,
      amountRaw: b.amountRaw,
      amountTokens: formatTokenAmount(b.amountRaw, b.decimals),
      decimals: b.decimals,
      payerAddress: b.consumerAddress,
      nonce,
      gasLimit: gasLimit.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      maxGasCostWei: maxGasCost.toString(),
      nativeBalanceWei: nativeBalance.toString(),
      tokenBalanceRaw: tokenBalance.toString(),
      calldataHash: b.calldataHash,
      digest: b.intentHash,
      nativeSymbol: network.nativeSymbol,
      note: "Read-only preview. The transfer is sent only after an explicit confirmation; gas is capped by maxFeePerGas * gasLimit.",
    });
    const records = [...this.previews.values()].filter((r) => r.sessionId === input.context.sessionId);
    if (records.length >= MAX_PREVIEWS_PER_SESSION) {
      this.previews.delete([...this.previews.entries()].find(([, r]) => r.sessionId === input.context.sessionId)![0]);
    }
    this.previews.set(preview.previewRef, { sessionId: input.context.sessionId, preview, expiresAtMs: this.now() + PREVIEW_TTL_MS });
    return preview;
  }

  /**
   * One confirmed send. The caller must present the exact previewRef and
   * confirm:true; the journal decides whether this invoice may still be sent.
   */
  async send(input: { invoiceId: unknown; previewRef: unknown; confirm: unknown; context: ConsoleActionContext }): Promise<Record<string, unknown>> {
    this.prune();
    const invoiceId = text(input.invoiceId, "invoiceId", 128);
    const previewRef = text(input.previewRef, "previewRef", 64);
    if (input.confirm !== true) throw new WalletSendError("invalid", "the send needs an explicit confirmation");
    const record = this.previews.get(previewRef);
    if (!record || record.sessionId !== input.context.sessionId || record.preview.invoiceId !== invoiceId) {
      throw new WalletSendError("stale", "this preview does not belong to this session/payment; preview again");
    }
    if (record.expiresAtMs <= this.now()) throw new WalletSendError("stale", "the preview expired; preview again");
    const obligation = this.resolve(invoiceId);
    const b = obligation.binding;
    if (this.now() >= b.expiresAtMs) throw new WalletSendError("stale", "the payment request expired; request new terms");
    if (b.consumerAddress !== record.preview.payerAddress || b.amountRaw !== record.preview.amountRaw || b.recipientAddress !== record.preview.recipientAddress || b.contractAddress !== record.preview.tokenAddress) {
      throw new WalletSendError("stale", "the payment obligation changed; preview again");
    }
    const port = paymentOperationPortFor(this.service, b);
    const operation = expectedOperation(b);
    // Re-read the chain immediately before the journal gate. A changed nonce or
    // a fee above the confirmed ceiling refuses instead of silently paying more.
    const client = this.client(b.chainId);
    const nonceHex = await client.call<string>("eth_getTransactionCount", [b.consumerAddress, "pending"]);
    if (Number(quantity(nonceHex, "eth_getTransactionCount")) !== record.preview.nonce) {
      throw new WalletSendError("nonce-changed", "the account nonce changed since the preview; preview again");
    }
    const block = await client.call<unknown>("eth_getBlockByNumber", ["latest", false]);
    const baseFee = blockField(block, "baseFeePerGas");
    if (baseFee === null) throw new WalletSendError("not-available", "the chain did not report a base fee; preview again");
    const required = baseFee * 2n + BigInt(record.preview.maxPriorityFeePerGas) + 1_000_000_000n;
    if (required > BigInt(record.preview.maxFeePerGas)) throw new WalletSendError("fee-changed", "the required fee is above the previewed ceiling; preview again");
    const nativeHex = await client.call<string>("eth_getBalance", [b.consumerAddress, "latest"]);
    if (quantity(nativeHex, "eth_getBalance") < BigInt(record.preview.maxGasCostWei)) throw new WalletSendError("insufficient", "the wallet no longer has the previewed gas balance");
    const data = `${SELECTOR}${b.consumerAddress.slice(2).padStart(64, "0")}`;
    const tokenHex = await client.call<string>("eth_call", [{ to: b.contractAddress, data }, "latest"]);
    if (quantity(tokenHex, "token balanceOf") < BigInt(b.amountRaw)) throw new WalletSendError("insufficient", "the wallet no longer holds the exact token amount");

    let reservation;
    try {
      reservation = await port.reserve(operation);
    } catch (error) {
      if (error instanceof PaymentOperationError) throw new WalletSendError("journal", error.message);
      throw error;
    }
    if (reservation.state !== "reserved" || typeof reservation.reservationId !== "string") {
      return Object.freeze({ state: reservation.state, reservationId: null, broadcast: false, note: "the journal did not grant a send permit for this invoice" });
    }
    let signed;
    try {
      signed = await walletLocalService(this.service).signErc20Payment({
        chainId: b.chainId,
        to: b.contractAddress,
        tokenAddress: b.contractAddress,
        recipient: b.recipientAddress,
        amountRaw: b.amountRaw,
        decimals: b.decimals,
        valueWei: 0n,
        nonce: record.preview.nonce,
        gasLimit: BigInt(record.preview.gasLimit),
        maxFeePerGas: BigInt(record.preview.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(record.preview.maxPriorityFeePerGas),
      }, input.context as LocalContext);
    } catch (error) {
      this.previews.delete(previewRef);
      throw new WalletSendError("locked", String((error as Error)?.message ?? error).slice(0, 200));
    }
    if (lower(signed.from) !== b.consumerAddress || signed.chainId !== b.chainId || !signed.to || lower(signed.to) !== b.contractAddress) {
      throw new WalletSendError("wallet-mismatch", "the signed transaction does not match the payment binding");
    }
    // If the session ended while the wallet was signing, do not broadcast. The
    // journal stays reserved and recoverable; no hash/unknown is fabricated.
    if (typeof input.context.assertActive === "function" && input.context.assertActive() !== true) {
      throw new WalletSendError("refused", "the console session ended during signing; nothing was sent; recover via pending");
    }
    try {
      await port.markBroadcasting({ reservationId: reservation.reservationId, operation });
    } catch (error) {
      if (error instanceof PaymentOperationError) throw new WalletSendError("journal", error.message);
      throw error;
    }
    let chainHash: string;
    try {
      chainHash = await client.call<string>("eth_sendRawTransaction", [signed.rawTransaction]);
    } catch (error) {
      // The transaction may have reached a node even though the call failed.
      // It is never retried automatically; the journal records unknown.
      try { await port.recordUnknown({ reservationId: reservation.reservationId, operation, reason: "rpc-send-unknown" }); } catch { /* journal already records the state */ }
      throw new WalletSendError("broadcast-unknown", `the broadcast outcome is unknown; do not resend: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    }
    if (typeof chainHash !== "string" || !HEX32.test(chainHash)) throw new WalletSendError("broadcast-unknown", "the node returned no transaction hash; do not resend");
    if (lower(chainHash) !== lower(signed.hash)) throw new WalletSendError("broadcast-unknown", "the node returned a different transaction hash; do not resend");
    try {
      await port.recordHash({ reservationId: reservation.reservationId, operation, hash: chainHash });
    } catch (error) {
      throw new WalletSendError("journal", `the transaction was broadcast as ${chainHash}, but recording the hash failed; do not resend: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    }
    this.previews.delete(previewRef);
    return Object.freeze({
      state: "broadcast",
      hash: chainHash,
      chainId: b.chainId,
      invoiceId,
      amountRaw: b.amountRaw,
      recipientAddress: b.recipientAddress,
      broadcast: true,
      note: "Broadcast is not credit. The provider's watcher must observe finality before any balance changes.",
    });
  }
}
