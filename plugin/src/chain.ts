// The chain registry, the only JSON-RPC client, and the only write path to a
// chain: an ERC-20 `transfer`.
//
// The registry is data. BSC (56) and Base (8453) are the two product chains, and
// `registerChain` lets a self-check add a local chain (31337) without touching
// the defaults. USDC decimals live here and nowhere else: BSC's USDC has 18
// decimals, Base's has 6, and confusing the two would misprice a balance by
// 1e12. `db.ts` imports `decimalsForChain` from here for that reason.
//
// Reading is failover over an ordered endpoint list, with the endpoint that last
// worked remembered: one dead public RPC must not stop an on-demand read. Writing is a
// single legacy transaction, signed locally and broadcast once — never retried,
// because "maybe it went out" is a different answer from "it failed".

import { Interface, Transaction, formatUnits, id, type Wallet } from "ethers";
import { logger } from "./log.ts";

/** How a chain's deposits become irreversible. */
export type FinalityPolicy =
  /** `finalized` on a chain where that tag really lags the head (Base, an L2). */
  | { mode: "finalized" }
  /**
   * A confirmation depth. BSC's `finalized` tag equals `latest`, so the tag
   * proves nothing about depth and 15 blocks is the substitute policy.
   */
  | { mode: "confirmations"; confirmations: number };

export interface ChainRecord {
  /** tool-facing name, `"bsc"` / `"base"`; a test chain may use anything */
  key: string;
  /** human label for messages */
  label: string;
  chainId: number;
  /** ordered; the first one is the default, the rest are failover */
  rpcUrls: readonly string[];
  /** the ERC-20 this plugin credits and sends; no other token is money here */
  usdc: string;
  decimals: number;
  /** what the chain charges gas in, for error messages */
  nativeSymbol: string;
  finality: FinalityPolicy;
  explorerTx?: string;
}

/**
 * Ordered endpoints, first is the default. The plugin no longer scans blocks:
 * these are used for an on-demand receipt, balance, nonce/estimate or broadcast.
 * `bsc-dataseed` stays last because it is still the most reliable endpoint for
 * `eth_blockNumber`, receipts and broadcasting; publicnode is first for reads.
 */
function rpcUrls(env: string, fallback: readonly string[]): readonly string[] {
  const raw = process.env[env]?.trim();
  if (!raw) return fallback;
  const urls = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return urls.length > 0 ? urls : fallback;
}

const BSC_RPC = rpcUrls("OH_MY_AIHUB_BSC_RPC", [
  "https://bsc-rpc.publicnode.com",
  "https://bsc.blockrazor.xyz",
  "https://bsc-dataseed.bnbchain.org",
]);

/**
 * Base: publicnode answers receipts/head; `mainnet.base.org` is the failover
 * and the official head. Both serve receipts and sends.
 */
const BASE_RPC = rpcUrls("OH_MY_AIHUB_BASE_RPC", [
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
]);

/** BSC: 3s blocks → 115_200 blocks ≈ 24h; USDC is the 18-decimal BEP-20. */
export const BSC_CHAIN: ChainRecord = {
  key: "bsc",
  label: "BSC",
  chainId: 56,
  rpcUrls: BSC_RPC,
  usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  decimals: 18,
  nativeSymbol: "BNB",
  finality: { mode: "confirmations", confirmations: 15 },
  explorerTx: "https://bscscan.com/tx/",
};

/** Base: 2s blocks → 43_200 blocks ≈ 24h; USDC is the 6-decimal OP-stack token. */
export const BASE_CHAIN: ChainRecord = {
  key: "base",
  label: "Base",
  chainId: 8453,
  rpcUrls: BASE_RPC,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
  nativeSymbol: "ETH",
  finality: { mode: "finalized" },
  explorerTx: "https://basescan.org/tx/",
};

/** The production chains, in the order tools and `wallet` report them. */
export const PRODUCT_CHAINS: readonly ChainRecord[] = [BSC_CHAIN, BASE_CHAIN];

const byId = new Map<number, ChainRecord>();
const byKey = new Map<string, ChainRecord>();

/**
 * Adds or replaces a chain record. Production calls it twice at import; a
 * self-check calls it with a local anvil chain. Replacing an id is intentional
 * (an endpoint list can be corrected) and never changes what a stored deposit
 * row meant: the row keeps its own `token` and `amount_raw`.
 */
export function registerChain(record: ChainRecord): ChainRecord {
  byId.set(record.chainId, record);
  byKey.set(record.key.toLowerCase(), record);
  return record;
}

for (const chain of PRODUCT_CHAINS) registerChain(chain);

export function chainById(chainId: number): ChainRecord | null {
  return byId.get(chainId) ?? null;
}

export function chainByKey(key: string): ChainRecord | null {
  return byKey.get(key.trim().toLowerCase()) ?? null;
}

/** USDC decimals for a chain id, or null when this build does not know it. */
export function decimalsForChain(chainId: number): number | null {
  return chainById(chainId)?.decimals ?? null;
}

/** Display a raw token amount with the chain's own decimals. */
export function formatTokenAmount(amountRaw: bigint | string, decimals: number): string {
  let raw: bigint;
  try {
    raw = typeof amountRaw === "bigint" ? amountRaw : BigInt(String(amountRaw).trim());
  } catch {
    return String(amountRaw);
  }
  return formatUnits(raw, decimals);
}

const AMOUNT_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * A decimal USDC string → exact raw units. Floats are refused on purpose: an
 * agent that passes a JS number has already lost precision, so the loss must be
 * reported instead of being rounded away (`E_INPUT`).
 */
export function parseAmountRaw(text: string, decimals: number): bigint {
  const value = text.trim();
  const match = AMOUNT_RE.exec(value);
  if (!match) {
    throw new Error(
      `E_INPUT: amount must be a plain decimal string such as "1.25" — ` +
        `got ${JSON.stringify(value.slice(0, 40))} (no sign, no exponent, no float)`,
    );
  }
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(
      `E_INPUT: amount ${value} has ${fraction.length} decimal places, but this chain's USDC has ${decimals}`,
    );
  }
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw <= 0n) throw new Error("E_INPUT: amount must be greater than zero");
  return raw;
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export interface RpcOptions {
  /** ordered endpoints; the first is the default */
  urls: readonly string[];
  /** per attempt */
  timeoutMs?: number;
  /** full passes over the endpoint list */
  rounds?: number;
  fetchImpl?: typeof fetch;
}

class RpcReplyError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcReplyError";
  }
}

interface RpcHttpError extends Error {
  status?: number;
}

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface RpcBlock {
  number: string;
  hash: string | null;
  parentHash: string;
}

export interface RpcReceipt {
  transactionHash: string;
  status: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  logs: RpcLog[];
}

function asHex(value: number | "latest" | "finalized" | "pending"): string {
  return typeof value === "number" ? `0x${value.toString(16)}` : value;
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 220) || "unknown error";
}

/**
 * A read/write JSON-RPC client over plain `fetch`.
 *
 * `call` walks the endpoints from the last-known-good one and returns the first
 * success. The last reason is surfaced as `E_RPC`, so a failure names the chain
 * and not an opaque fetch error. Nothing is cached: every call sees the head it
 * asked for.
 */
export class RpcClient {
  private readonly urls: string[];
  private readonly timeoutMs: number;
  private readonly rounds: number;
  private readonly fetchImpl: typeof fetch;
  private preferred = 0;
  private nextId = 1;
  /** Wall-clock until which an endpoint is skipped, per index. */
  private readonly cooldownUntil: number[] = [];

  constructor(opts: RpcOptions) {
    if (opts.urls.length === 0) throw new Error("E_RPC: no RPC endpoint configured");
    this.urls = [...opts.urls];
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.rounds = Math.max(1, opts.rounds ?? 2);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The endpoint currently preferred, for logs and the read-only smoke test. */
  get endpoint(): string {
    return this.urls[this.preferred] ?? this.urls[0];
  }

  get endpoints(): readonly string[] {
    return this.urls;
  }

  private async post(url: string, body: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} ${res.statusText}`.trim()) as RpcHttpError;
      error.status = res.status;
      throw error;
    }
    return await res.json();
  }

  /** The endpoints to try now: preferred first, cooled ones only as a last resort. */
  private endpointOrder(): number[] {
    const all = this.urls.map((_, index) => index);
    const now = Date.now();
    const ready = all.filter((index) => (this.cooldownUntil[index] ?? 0) <= now);
    const order = ready.length > 0 ? ready : all;
    const at = order.indexOf(this.preferred);
    return at > 0 ? [...order.slice(at), ...order.slice(0, at)] : order;
  }

  /** A 429 is a provider asking us to back off; other failures are shorter. */
  private cool(index: number, error: unknown): void {
    const status = (error as RpcHttpError).status;
    this.cooldownUntil[index] = Date.now() + (status === 429 ? 60_000 : 10_000);
  }

  /** One JSON-RPC call, with failover, cooldown and a per-endpoint timeout. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const reasons: string[] = [];
    // A JSON-RPC *error* is that endpoint's answer, not a transport hiccup: a
    // block-range limit will refuse the same query again, so the endpoint is
    // skipped for the remaining rounds instead of being asked twice.
    const refused = new Set<number>();
    for (let round = 0; round < this.rounds; round++) {
      for (const index of this.endpointOrder()) {
        if (refused.has(index)) continue;
        const url = this.urls[index];
        const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
        let replyRefused = false;
        try {
          const payload = (await this.post(url, body)) as {
            result?: T;
            error?: { code?: number; message?: string; data?: unknown };
          };
          if (payload.error) {
            replyRefused = true;
            throw new RpcReplyError(payload.error.message ?? "JSON-RPC error", payload.error.code, payload.error.data);
          }
          if (!("result" in payload)) throw new Error("JSON-RPC reply has no result");
          this.preferred = index;
          return payload.result as T;
        } catch (error) {
          reasons.push(`${new URL(url).host}: ${shortError(error)}`);
          this.cool(index, error);
          // A 429 is not worth a second ask in the same call either.
          if (replyRefused || (error as RpcHttpError).status === 429) refused.add(index);
        }
      }
    }
    throw new Error(`E_RPC: ${method} failed on every endpoint (${reasons.join("; ")})`);
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_chainId")));
  }

  async head(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_blockNumber")));
  }

  async receipt(txHash: string): Promise<RpcReceipt | null> {
    return this.call<RpcReceipt | null>("eth_getTransactionReceipt", [txHash]);
  }

  async block(numberOrTag: number | "latest" | "finalized"): Promise<RpcBlock | null> {
    return this.call<RpcBlock | null>("eth_getBlockByNumber", [asHex(numberOrTag), false]);
  }

  async balance(address: string): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [address, "latest"]));
  }

  async nonce(address: string): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_getTransactionCount", [address, "pending"])));
  }

  async gasPrice(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_gasPrice"));
  }

  async estimateGas(tx: { from: string; to: string; data: string; value?: string }): Promise<bigint> {
    return BigInt(await this.call<string>("eth_estimateGas", [tx]));
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  async sendRawTransaction(raw: string): Promise<string> {
    const reasons: string[] = [];
    const refused = new Set<number>();
    for (let round = 0; round < this.rounds; round++) {
      for (const index of this.endpointOrder()) {
        if (refused.has(index)) continue;
        const url = this.urls[index];
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "eth_sendRawTransaction",
          params: [raw],
        });
        let replyRefused = false;
        try {
          const payload = (await this.post(url, body)) as { result?: string; error?: { message?: string } };
          if (payload.error) {
            const message = payload.error.message ?? "JSON-RPC error";
            // The same signed bytes reaching a second node is not a failure.
            if (/already known|known transaction|already imported|already in (the )?(mempool|pool)/i.test(message)) {
              this.preferred = index;
              return Transaction.from(raw).hash ?? "";
            }
            replyRefused = true;
            throw new Error(message);
          }
          if (typeof payload.result !== "string") throw new Error("no transaction hash in the reply");
          this.preferred = index;
          return payload.result;
        } catch (error) {
          reasons.push(`${new URL(url).host}: ${shortError(error)}`);
          this.cool(index, error);
          if (replyRefused || (error as RpcHttpError).status === 429) refused.add(index);
        }
      }
    }
    throw new Error(`E_RPC: eth_sendRawTransaction failed on every endpoint (${reasons.join("; ")})`);
  }

  async erc20Balance(token: string, owner: string): Promise<bigint> {
    const data = new Interface(["function balanceOf(address owner) view returns (uint256)"]).encodeFunctionData(
      "balanceOf",
      [owner],
    );
    const result = await this.ethCall(token, data);
    try {
      return BigInt(result);
    } catch {
      throw new Error(`E_RPC: ${token} balanceOf returned malformed data`);
    }
  }
}

/**
 * The last block this chain can prove final, or null when it cannot today.
 * Used by the deposit-claim path:
 * BSC is a confirmation depth, Base uses the `finalized` tag.
 */
export async function finalBlockFor(chain: ChainRecord, client: RpcClient, head: number): Promise<number | null> {
  if (chain.finality.mode === "confirmations") {
    const final = head - chain.finality.confirmations;
    return final >= 0 ? final : null;
  }
  try {
    const block = await client.block("finalized");
    if (!block?.number || !/^0x[0-9a-fA-F]+$/.test(block.number)) return null;
    const number = Number(BigInt(block.number));
    if (!Number.isSafeInteger(number)) return null;
    return Math.min(number, head);
  } catch (error) {
    // A provider without the `finalized` tag cannot be used for credit on a
    // chain that needs it: guessing `latest` here would credit unfinal blocks.
    logger.warn(`chain: ${chain.label} has no finalized block (${shortError(error)})`);
    return null;
  }
}

/** A client for a chain record's endpoint list. */
export function clientFor(chain: ChainRecord, opts: Partial<RpcOptions> = {}): RpcClient {
  return new RpcClient({ urls: chain.rpcUrls, ...opts });
}

// ---------------------------------------------------------------------------
// ERC-20 transfer
// ---------------------------------------------------------------------------

export const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

const ERC20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/** `topics[2]` of a Transfer log: the recipient, left-padded to 32 bytes. */
export function addressTopic(address: string): string {
  return `0x${address.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
}

/** The `from` of a Transfer log, or null when the topic is not 32 bytes. */
export function topicToAddress(topic: string | undefined): string | null {
  if (!topic) return null;
  const body = topic.replace(/^0x/i, "").toLowerCase();
  if (body.length !== 64) return null;
  return `0x${body.slice(24)}`;
}

/** The transaction may or may not be on the chain: the caller must not resend. */
export class TxUnknownError extends Error {
  constructor(
    message: string,
    readonly txHash: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "TxUnknownError";
  }
}

export interface PreparedTransfer {
  to: string;
  data: string;
  nonce: number;
  gasLimit: bigint;
  gasPrice: bigint;
  /** gasLimit × gasPrice: the native balance a send needs before it can sign */
  fee: bigint;
}

/** Gas headroom on top of the estimate; a transfer is ~51k on both chains. */
const GAS_HEADROOM = 12_000n;

/**
 * Everything a transfer needs except the signature: nonce, gas price, gas
 * limit and calldata. Split out from the send so `send_payment` can refuse a
 * wallet with no gas *before* signing, and report the exact shortfall.
 */
export async function prepareUsdcTransfer(
  client: RpcClient,
  chain: ChainRecord,
  from: string,
  to: string,
  amountRaw: bigint,
): Promise<PreparedTransfer> {
  if (amountRaw <= 0n) throw new Error("E_INPUT: amount must be greater than zero");
  const data = ERC20.encodeFunctionData("transfer", [to, amountRaw]);
  try {
    const [gasPrice, nonce, estimate] = await Promise.all([
      client.gasPrice(),
      client.nonce(from),
      client.estimateGas({ from, to: chain.usdc, data }),
    ]);
    const gasLimit = estimate + GAS_HEADROOM;
    return { to, data, nonce, gasLimit, gasPrice, fee: gasLimit * gasPrice };
  } catch (error) {
    throw new Error(`E_RPC: cannot prepare a ${chain.label} transfer: ${shortError(error)}`);
  }
}

export interface PreparedNativeTransfer {
  to: string;
  value: bigint;
  nonce: number;
  gasLimit: bigint;
  gasPrice: bigint;
  /** gasLimit × gasPrice: the native balance the send must leave for gas */
  fee: bigint;
}

export interface SendUsdcRequest {
  chain: ChainRecord;
  wallet: Wallet;
  client: RpcClient;
  prepared: PreparedTransfer;
}

export interface SendUsdcResult {
  txHash: string;
  nonce: number;
  gasLimit: bigint;
  gasPrice: bigint;
}

/**
 * Signs the prepared transfer and broadcasts it exactly once.
 *
 * A transport or timeout failure while broadcasting throws `TxUnknownError`
 * carrying the hash of the signed bytes: the transaction is already valid and
 * may be in some mempool, so the only honest answer is "unknown", and re-sending
 * would be a second payment. Nothing before the broadcast has that ambiguity, so
 * those failures stay ordinary `E_*` errors.
 */
export async function sendPreparedUsdc(req: SendUsdcRequest): Promise<SendUsdcResult> {
  const { chain, wallet, client, prepared } = req;
  const signed = await wallet.signTransaction({
    type: 0,
    chainId: chain.chainId,
    nonce: prepared.nonce,
    to: chain.usdc,
    data: prepared.data,
    value: 0n,
    gasLimit: prepared.gasLimit,
    gasPrice: prepared.gasPrice,
  });
  const txHash = Transaction.from(signed).hash;
  if (!txHash) throw new Error("E_RPC: the signed transaction has no hash");

  try {
    const sent = await client.sendRawTransaction(signed);
    if (sent.toLowerCase() !== txHash.toLowerCase()) {
      logger.warn(`chain: ${chain.label} returned hash ${sent} for signed ${txHash}`);
    }
  } catch (error) {
    throw new TxUnknownError(
      `E_TX_UNKNOWN: the ${chain.label} broadcast did not confirm (${shortError(error)}); ` +
        `the signed transaction may still reach the chain — check ${txHash} before trying again`,
      txHash,
      signed,
    );
  }

  return { txHash, nonce: prepared.nonce, gasLimit: prepared.gasLimit, gasPrice: prepared.gasPrice };
}

/** Headroom for a plain native transfer; a 21k transfer becomes 26k. */
const NATIVE_GAS_HEADROOM = 5_000n;

/**
 * Prepare a native-coin transfer (BNB on BSC, ETH on Base). Native withdrawals
 * are just gas money for a human; they never become provider credit and are not
 * part of the deposit-claim path.
 */
export async function prepareNativeTransfer(
  client: RpcClient,
  chain: ChainRecord,
  from: string,
  to: string,
  amountRaw: bigint,
): Promise<PreparedNativeTransfer> {
  if (amountRaw <= 0n) throw new Error("E_INPUT: amount must be greater than zero");
  try {
    const [gasPrice, nonce, estimate] = await Promise.all([
      client.gasPrice(),
      client.nonce(from),
      client.estimateGas({ from, to, data: "0x", value: `0x${amountRaw.toString(16)}` }),
    ]);
    const gasLimit = estimate + NATIVE_GAS_HEADROOM;
    return { to, value: amountRaw, nonce, gasLimit, gasPrice, fee: gasLimit * gasPrice };
  } catch (error) {
    throw new Error(`E_RPC: cannot prepare a ${chain.label} native transfer: ${shortError(error)}`);
  }
}

export interface SendNativeRequest {
  chain: ChainRecord;
  wallet: Wallet;
  client: RpcClient;
  prepared: PreparedNativeTransfer;
}

export interface SendNativeResult {
  txHash: string;
  nonce: number;
  gasLimit: bigint;
  gasPrice: bigint;
}

/** Sign and broadcast one native transfer exactly once. */
export async function sendPreparedNative(req: SendNativeRequest): Promise<SendNativeResult> {
  const { chain, wallet, client, prepared } = req;
  const signed = await wallet.signTransaction({
    type: 0,
    chainId: chain.chainId,
    nonce: prepared.nonce,
    to: prepared.to,
    data: "0x",
    value: prepared.value,
    gasLimit: prepared.gasLimit,
    gasPrice: prepared.gasPrice,
  });
  const txHash = Transaction.from(signed).hash;
  if (!txHash) throw new Error("E_RPC: the signed transaction has no hash");
  try {
    const sent = await client.sendRawTransaction(signed);
    if (sent.toLowerCase() !== txHash.toLowerCase()) {
      logger.warn(`chain: ${chain.label} returned hash ${sent} for signed ${txHash}`);
    }
  } catch (error) {
    throw new TxUnknownError(
      `E_TX_UNKNOWN: the ${chain.label} broadcast did not confirm (${shortError(error)}); ` +
        `the signed transaction may still reach the chain — check ${txHash} before trying again`,
      txHash,
      signed,
    );
  }
  return { txHash, nonce: prepared.nonce, gasLimit: prepared.gasLimit, gasPrice: prepared.gasPrice };
}
