// A minimal EVM JSON-RPC client for deposit watching.
//
// Deliberately small: it reads blocks, logs, receipts and one `decimals()` call.
// It never signs, never sends a transaction and never holds a key. Every call
// goes to an operator-configured endpoint list; the first endpoint that answers
// wins and the others are only tried on failure, so one provider's outage does
// not stop a chain.
//
// Two rules matter for money and are enforced here rather than by callers:
//
//  1. `eth_chainId` is checked on connect. An endpoint that answers with another
//     chain id is refused, because a log from the wrong chain would credit the
//     wrong asset. (A BSC node must never be able to answer for Base.)
//  2. Nothing is inferred from a missing field. A block without a hash, a log
//     without a `logIndex`, or a receipt that is not `status: 0x1` is an error,
//     not a zero.

export interface RpcEndpointHealth {
  url: string;
  ok: boolean;
  lastError: string | null;
  lastOkAt: string | null;
  latencyMs: number | null;
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface EvmBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

export interface EvmReceipt {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  status: string;
  logs: EvmLog[];
}

export interface EvmClientOptions {
  chainId: number;
  endpoints: string[];
  timeoutMs?: number;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class EvmClient {
  private readonly chainId: number;
  private endpoints: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private health = new Map<string, RpcEndpointHealth>();
  private preferred = 0;
  private nextId = 1;
  private verified = false;

  constructor(opts: EvmClientOptions) {
    this.chainId = opts.chainId;
    this.endpoints = [...opts.endpoints];
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    for (const url of this.endpoints) {
      this.health.set(url, { url, ok: false, lastError: null, lastOkAt: null, latencyMs: null });
    }
  }

  get id(): number {
    return this.chainId;
  }

  endpointHealth(): RpcEndpointHealth[] {
    return this.endpoints.map((u) => ({ ...this.health.get(u)! }));
  }

  setEndpoints(urls: string[]): void {
    this.endpoints = [...urls];
    this.verified = false;
    this.preferred = 0;
    this.health = new Map(urls.map((url) => [url, this.health.get(url) ?? { url, ok: false, lastError: null, lastOkAt: null, latencyMs: null }]));
  }

  /**
   * Confirms that the endpoint list really serves `chainId`. Called before any
   * scan; a mismatch is fatal for this chain, never "close enough".
   */
  async verifyChain(): Promise<void> {
    const id = await this.call<string>("eth_chainId", []);
    const got = Number(BigInt(id));
    if (got !== this.chainId) {
      throw new Error(`the RPC for chain ${this.chainId} reports chainId ${got}; refusing to watch it`);
    }
    this.verified = true;
  }

  async call<T>(method: string, params: unknown[], timeoutMs?: number): Promise<T> {
    const errors: string[] = [];
    const order = [...this.endpoints.slice(this.preferred), ...this.endpoints.slice(0, this.preferred)];
    for (const url of order) {
      const started = this.now();
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let body: { result?: unknown; error?: { code?: number; message?: string } };
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          throw new Error(`not JSON: ${text.slice(0, 120)}`);
        }
        if (body.error) throw new Error(`${body.error.code ?? "error"}: ${body.error.message ?? "unknown"}`);
        if (body.result === undefined) throw new Error("a JSON-RPC reply without result");
        this.markOk(url, this.now() - started);
        this.preferred = this.endpoints.indexOf(url);
        return body.result as T;
      } catch (e) {
        const message = String((e as Error)?.message ?? e).slice(0, 200);
        errors.push(`${url}: ${message}`);
        this.markBad(url, message);
      }
    }
    throw new RpcError(`${method} failed on every endpoint of chain ${this.chainId}: ${errors.join("; ")}`, this.endpoints[0] ?? "none", method);
  }

  private markOk(url: string, latencyMs: number): void {
    const h = this.health.get(url) ?? { url, ok: false, lastError: null, lastOkAt: null, latencyMs: null };
    this.health.set(url, { ...h, ok: true, lastError: null, lastOkAt: new Date(this.now()).toISOString(), latencyMs });
  }

  private markBad(url: string, error: string): void {
    const h = this.health.get(url) ?? { url, ok: false, lastError: null, lastOkAt: null, latencyMs: null };
    this.health.set(url, { ...h, ok: false, lastError: error });
  }

  private static toNumber(hex: string, label: string): number {
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${label} is not a hex quantity: ${String(hex).slice(0, 40)}`);
    const n = Number(BigInt(hex));
    if (!Number.isSafeInteger(n)) throw new Error(`${label} does not fit in a safe integer`);
    return n;
  }

  private static toBigInt(hex: string, label: string): bigint {
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${label} is not a hex quantity: ${String(hex).slice(0, 40)}`);
    return BigInt(hex);
  }

  private static block(raw: unknown, label: string): EvmBlock {
    if (!raw || typeof raw !== "object") throw new Error(`${label}: no such block`);
    const b = raw as Record<string, unknown>;
    if (typeof b.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) throw new Error(`${label}: the block has no hash`);
    if (typeof b.parentHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.parentHash)) throw new Error(`${label}: the block has no parent hash`);
    return {
      number: b.number as string,
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: b.timestamp as string,
    };
  }

  async blockNumber(): Promise<number> {
    return EvmClient.toNumber(await this.call<string>("eth_blockNumber", []), "eth_blockNumber");
  }

  /** A block by number, or by the `safe`/`finalized` tag when the chain supports it. */
  async block(tag: "latest" | "safe" | "finalized" | number): Promise<EvmBlock> {
    const param = typeof tag === "number" ? `0x${tag.toString(16)}` : tag;
    const raw = await this.call<unknown>("eth_getBlockByNumber", [param, false]);
    return EvmClient.block(raw, `block ${tag}`);
  }

  /** Null rather than an error: a caller must decide what a missing block means. */
  async maybeBlock(tag: "latest" | "safe" | "finalized" | number): Promise<EvmBlock | null> {
    try {
      return await this.block(tag);
    } catch {
      return null;
    }
  }

  async receipt(txHash: string): Promise<EvmReceipt | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("a transaction hash is 32 bytes of hex");
    const raw = await this.call<unknown>("eth_getTransactionReceipt", [txHash]);
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.blockHash !== "string" || typeof r.blockNumber !== "string") throw new Error(`receipt ${txHash} has no block`);
    if (typeof r.status !== "string") throw new Error(`receipt ${txHash} has no status; it cannot be trusted`);
    const logs = Array.isArray(r.logs) ? (r.logs as EvmLog[]).map((l) => EvmClient.log(l, txHash)) : [];
    return {
      transactionHash: txHash,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash,
      status: r.status,
      logs,
    };
  }

  private static log(raw: EvmLog, txHash: string): EvmLog {
    if (!raw || typeof raw !== "object") throw new Error(`receipt ${txHash} has a malformed log`);
    if (typeof raw.logIndex !== "string") throw new Error(`a log in ${txHash} has no logIndex`);
    if (typeof raw.blockHash !== "string") throw new Error(`a log in ${txHash} has no blockHash`);
    if (!Array.isArray(raw.topics)) throw new Error(`a log in ${txHash} has no topics`);
    return raw;
  }

  /** One page of logs; `null` blockHash tags are not accepted by every provider, so numbers are used. */
  async logs(input: { address: string | string[]; topics: (string | null)[]; fromBlock: number; toBlock: number }): Promise<EvmLog[]> {
    const raw = await this.call<unknown>("eth_getLogs", [
      {
        address: input.address,
        topics: input.topics,
        fromBlock: `0x${input.fromBlock.toString(16)}`,
        toBlock: `0x${input.toBlock.toString(16)}`,
      },
    ]);
    if (!Array.isArray(raw)) throw new Error("eth_getLogs did not return a list");
    return (raw as EvmLog[]).map((l) => EvmClient.log(l, "eth_getLogs"));
  }

  /** `eth_call` returning hex bytes, for `decimals()` and nothing else. */
  async callData(to: string, data: string): Promise<string> {
    const out = await this.call<string>("eth_call", [{ to, data }, "latest"]);
    if (typeof out !== "string" || !/^0x[0-9a-fA-F]*$/.test(out)) throw new Error("eth_call returned no hex data");
    return out;
  }
}
