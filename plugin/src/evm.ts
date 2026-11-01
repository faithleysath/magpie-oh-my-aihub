// A minimal EVM JSON-RPC client for deposit watching.
//
// Deliberately small: it reads blocks, logs, receipts and one `decimals()` call.
// It never signs, never sends a transaction and never holds a key.
//
// Two read modes:
//
//  * `call()` is the historical failover reader for development/testnet work:
//    the first endpoint that answers wins. A single endpoint is enough because
//    a testnet deposit is explicitly not production money.
//  * `*Quorum()` is the production reader. It asks every configured endpoint,
//    requires `minimum` identical answers, and refuses a contradictory answer.
//    A head/finalized height is the *minimum* across endpoints (a lagging node
//    can only delay a credit, never advance one); a block, receipt, log set or
//    contract call must be byte-identical after normalization.
//
// Two rules matter for money and are enforced here rather than by callers:
//
//  1. `eth_chainId` is checked on every endpoint. An endpoint that answers with
//     another chain id is refused, because a log from the wrong chain would
//     credit the wrong asset. (A BSC node must never answer for Base.)
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
  /** refuse a JSON-RPC response body larger than this (default 8 MiB) */
  maxResponseBytes?: number;
}

/** Reads a response body with a hard byte cap, including chunked responses. */
async function readLimitedBody(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) throw new Error(`response body exceeds ${maxBytes} bytes`);
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`response body exceeds ${maxBytes} bytes`);
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    body.set(chunk, off);
    off += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
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

/**
 * The endpoints did not produce one agreed, sufficiently supported answer.
 * This is never "fall back to the first healthy endpoint": a credit decision is
 * paused and retried later instead of guessing.
 */
export class QuorumError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "QuorumError";
  }
}

/** Deterministic JSON for comparing two RPC results (object key order is not significant). */
function canonical(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return "null";
}

function groupAnswers<T>(answers: { url: string; result: T }[]): Map<string, { result: T; urls: string[] }> {
  const groups = new Map<string, { result: T; urls: string[] }>();
  for (const answer of answers) {
    const key = canonical(answer.result);
    const group = groups.get(key);
    if (group) group.urls.push(answer.url);
    else groups.set(key, { result: answer.result, urls: [answer.url] });
  }
  return groups;
}

export class EvmClient {
  private readonly chainId: number;
  private endpoints: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxResponseBytes: number;
  private health = new Map<string, RpcEndpointHealth>();
  private preferred = 0;
  private nextId = 1;
  /** chain verification is per endpoint, never reused across a failover */
  private verifiedEndpoints = new Map<string, boolean>();

  constructor(opts: EvmClientOptions) {
    this.chainId = opts.chainId;
    this.endpoints = [...opts.endpoints];
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.maxResponseBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024) {
      throw new Error("maxResponseBytes must be at least 1024");
    }
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
    this.verifiedEndpoints = new Map();
    this.preferred = 0;
    this.health = new Map(urls.map((url) => [url, this.health.get(url) ?? { url, ok: false, lastError: null, lastOkAt: null, latencyMs: null }]));
  }

  /**
   * Confirms that the endpoint list really serves `chainId`. Called before any
   * scan; a mismatch is fatal for this chain, never "close enough".
   */
  async verifyChain(): Promise<void> {
    const errors: string[] = [];
    for (const url of this.endpoints) {
      try {
        await this.verifyEndpoint(url);
        return;
      } catch (e) {
        errors.push(`${url}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    }
    throw new RpcError(
      `eth_chainId verification failed on every endpoint of chain ${this.chainId}: ${errors.join("; ")}`,
      this.endpoints[0] ?? "none",
      "eth_chainId",
    );
  }

  /**
   * Verifies one endpoint and records the result for that endpoint only. A
   * second endpoint is never used for `eth_call`/`eth_getBalance` until it has
   * answered `eth_chainId` itself.
   */
  private async verifyEndpoint(url: string): Promise<void> {
    const started = this.now();
    try {
      const id = await this.requestAt<string>(url, "eth_chainId", []);
      const got = Number(BigInt(id));
      if (got !== this.chainId) {
        throw new Error(`the RPC for chain ${this.chainId} reports chainId ${got}; refusing to watch or use it`);
      }
      this.verifiedEndpoints.set(url, true);
      this.markOk(url, this.now() - started);
    } catch (e) {
      const message = String((e as Error)?.message ?? e).slice(0, 200);
      this.markBad(url, message);
      throw e;
    }
  }

  async call<T>(method: string, params: unknown[], timeoutMs?: number): Promise<T> {
    const errors: string[] = [];
    const order = [...this.endpoints.slice(this.preferred), ...this.endpoints.slice(0, this.preferred)];
    for (const url of order) {
      const started = this.now();
      try {
        if (method !== "eth_chainId" && this.verifiedEndpoints.get(url) !== true) await this.verifyEndpoint(url);
        const result = await this.requestAt<T>(url, method, params, timeoutMs);
        this.markOk(url, this.now() - started);
        this.preferred = this.endpoints.indexOf(url);
        return result;
      } catch (e) {
        const message = String((e as Error)?.message ?? e).slice(0, 200);
        errors.push(`${url}: ${message}`);
        this.markBad(url, message);
      }
    }
    throw new RpcError(`${method} failed on every endpoint of chain ${this.chainId}: ${errors.join("; ")}`, this.endpoints[0] ?? "none", method);
  }

  /** One request to one endpoint. Redirects are refused; the body is bounded. */
  private async requestAt<T>(url: string, method: string, params: unknown[], timeoutMs?: number): Promise<T> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readLimitedBody(res, this.maxResponseBytes);
    let body: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`not JSON: ${text.slice(0, 120)}`);
    }
    if (body.error) throw new Error(`${body.error.code ?? "error"}: ${body.error.message ?? "unknown"}`);
    if (body.result === undefined) throw new Error("a JSON-RPC reply without result");
    return body.result as T;
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

  /**
   * Asks every endpoint for one method and requires `minimum` identical answers.
   * All answered values must agree; a single contradictory answer refuses the
   * read even when `minimum` others agree, because a credit decision must not
   * pick a winner between two chains. `normalize` lets a caller drop volatile
   * fields that are not part of the decision (never use it to drop a hash).
   */
  async callQuorum<T>(
    method: string,
    params: unknown[],
    minimum: number,
    options: { normalize?: (value: T) => unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!Number.isInteger(minimum) || minimum < 1) throw new Error("a quorum needs a positive integer minimum");
    if (this.endpoints.length < minimum) {
      throw new QuorumError(`${method}: ${this.endpoints.length} endpoint(s) configured, quorum needs ${minimum}`, method);
    }
    const verified = await Promise.allSettled(this.endpoints.map(async (url) => {
      await this.verifyEndpoint(url);
      return url;
    }));
    const usable = this.endpoints.filter((_, i) => verified[i]!.status === "fulfilled");
    if (usable.length < minimum) {
      const details = verified.map((v, i) => `${this.endpoints[i]}: ${v.status === "rejected" ? String((v.reason as Error)?.message ?? v.reason).slice(0, 160) : "ok"}`);
      throw new QuorumError(`${method}: only ${usable.length} endpoint(s) verified, quorum needs ${minimum}`, method, details);
    }
    const settled = await Promise.allSettled(usable.map(async (url) => {
      const started = this.now();
      try {
        const result = await this.requestAt<T>(url, method, params, options.timeoutMs);
        this.markOk(url, this.now() - started);
        return { url, result };
      } catch (e) {
        this.markBad(url, String((e as Error)?.message ?? e).slice(0, 200));
        throw e;
      }
    }));
    const answers: { url: string; result: T }[] = [];
    const failures: string[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") answers.push(outcome.value);
      else failures.push(`${usable[i]}: ${String((outcome.reason as Error)?.message ?? outcome.reason).slice(0, 160)}`);
    });
    if (answers.length < minimum) {
      throw new QuorumError(`${method}: only ${answers.length} endpoint(s) answered, quorum needs ${minimum}`, method, failures);
    }
    const normalized = options.normalize
      ? answers.map((a) => ({ url: a.url, result: options.normalize!(a.result) as T }))
      : answers;
    const groups = groupAnswers(normalized);
    if (groups.size !== 1) {
      const summary = [...groups.values()].map((g) => `${g.urls.join("+")} => ${canonical(g.result).slice(0, 120)}`);
      throw new QuorumError(`${method}: endpoints disagree (${summary.join(" | ")})`, method, [...failures, ...summary]);
    }
    const only = [...groups.values()][0]!;
    if (only.urls.length < minimum) {
      throw new QuorumError(`${method}: only ${only.urls.length} endpoint(s) agree, quorum needs ${minimum}`, method, failures);
    }
    return only.result;
  }

  /**
   * A block at the conservative head (minimum height across the quorum). Every
   * endpoint has that height, so its hash can be compared; using each endpoint's
   * own "latest" would compare different blocks and never agree.
   */
  async headBlockQuorum(minimum: number): Promise<EvmBlock> {
    const head = await this.blockNumberQuorum(minimum);
    return this.blockQuorum(head, minimum);
  }

  /**
   * A numeric JSON-RPC quantity across the quorum. `identical` is for a nonce or
   * a token balance (a difference is a refusal), `max` for a gas estimate (be
   * conservative) and `min` for a tip (never overpay because one provider is
   * greedy). At least `minimum` endpoints must answer.
   */
  async quantityQuorum(
    method: string,
    params: unknown[],
    minimum: number,
    mode: "identical" | "max" | "min",
  ): Promise<bigint> {
    const settled = await Promise.allSettled(this.endpoints.map(async (url) => {
      await this.verifyEndpoint(url);
      const raw = await this.requestAt<unknown>(url, method, params);
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error(`${method} did not return a hex quantity`);
      return BigInt(raw);
    }));
    const values = settled.filter((s): s is PromiseFulfilledResult<bigint> => s.status === "fulfilled").map((s) => s.value);
    if (values.length < minimum) {
      const details = settled.map((s, i) => `${this.endpoints[i]}: ${s.status === "rejected" ? String((s.reason as Error)?.message ?? s.reason).slice(0, 120) : "ok"}`);
      throw new QuorumError(`${method}: only ${values.length} endpoint(s) answered, quorum needs ${minimum}`, method, details);
    }
    if (mode === "identical") {
      const first = values[0]!;
      if (!values.every((v) => v === first)) throw new QuorumError(`${method}: endpoints returned different quantities`, method);
      return first;
    }
    return mode === "max" ? values.reduce((a, b) => (b > a ? b : a)) : values.reduce((a, b) => (b < a ? b : a));
  }

  /**
   * The conservative head: the lowest answered head. A lagging endpoint delays
   * a scan; a lying high endpoint cannot make the watcher skip a block. The
   * caller still requires `minimum` answers.
   */
  async blockNumberQuorum(minimum: number): Promise<number> {
    const settled = await Promise.allSettled(this.endpoints.map(async (url) => {
      await this.verifyEndpoint(url);
      return EvmClient.toNumber(await this.requestAt<string>(url, "eth_blockNumber", []), "eth_blockNumber");
    }));
    const heads = settled.filter((s): s is PromiseFulfilledResult<number> => s.status === "fulfilled").map((s) => s.value);
    if (heads.length < minimum) throw new QuorumError(`eth_blockNumber: only ${heads.length} endpoint(s) answered, quorum needs ${minimum}`, "eth_blockNumber");
    return Math.min(...heads);
  }

  /** The lowest finalized height across the quorum; null only when none answers. */
  async finalizedNumberQuorum(minimum: number): Promise<number | null> {
    const settled = await Promise.allSettled(this.endpoints.map(async (url) => {
      await this.verifyEndpoint(url);
      const raw = await this.requestAt<unknown>(url, "eth_getBlockByNumber", ["finalized", false]);
      if (!raw || typeof raw !== "object") return null;
      return EvmClient.toNumber((raw as { number: string }).number, "finalized number");
    }));
    const values = settled.filter((s): s is PromiseFulfilledResult<number | null> => s.status === "fulfilled").map((s) => s.value).filter((v): v is number => v !== null);
    if (values.length < minimum) {
      throw new QuorumError(`eth_getBlockByNumber(finalized): only ${values.length} endpoint(s) answered, quorum needs ${minimum}`, "eth_getBlockByNumber");
    }
    return Math.min(...values);
  }

  /** A block at a fixed height/tag, identical across the quorum. */
  async blockQuorum(tag: "latest" | "safe" | "finalized" | number, minimum: number): Promise<EvmBlock> {
    const param = typeof tag === "number" ? `0x${tag.toString(16)}` : tag;
    return this.callQuorum<unknown>("eth_getBlockByNumber", [param, false], minimum, {
      normalize: (raw) => {
        const b = EvmClient.block(raw, `block ${tag}`);
        return { number: EvmClient.toNumber(b.number, "block number"), hash: b.hash.toLowerCase(), parentHash: b.parentHash.toLowerCase(), timestamp: b.timestamp };
      },
    }).then((raw) => EvmClient.block(raw, `block ${tag}`));
  }

  /** A receipt, identical across the quorum. Null means no endpoint has it yet. */
  async receiptQuorum(txHash: string, minimum: number): Promise<EvmReceipt | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("a transaction hash is 32 bytes of hex");
    const settled = await Promise.allSettled(this.endpoints.map(async (url) => {
      await this.verifyEndpoint(url);
      const raw = await this.requestAt<unknown>(url, "eth_getTransactionReceipt", [txHash]);
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      if (typeof r.blockHash !== "string" || typeof r.blockNumber !== "string" || typeof r.status !== "string") {
        throw new Error(`receipt ${txHash} is incomplete on ${url}`);
      }
      const logs = Array.isArray(r.logs) ? (r.logs as EvmLog[]).map((l) => EvmClient.log(l, txHash)) : [];
      return {
        transactionHash: txHash.toLowerCase(),
        blockNumber: r.blockNumber,
        blockHash: r.blockHash.toLowerCase(),
        status: r.status.toLowerCase(),
        logs: logs.map((l) => ({
          ...l,
          address: l.address.toLowerCase(),
          topics: l.topics.map((t) => t.toLowerCase()),
          blockHash: l.blockHash.toLowerCase(),
          transactionHash: l.transactionHash.toLowerCase(),
          data: l.data.toLowerCase(),
        })),
      } satisfies EvmReceipt;
    }));
    const values = settled.filter((s): s is PromiseFulfilledResult<EvmReceipt | null> => s.status === "fulfilled").map((s) => s.value);
    if (values.length < minimum) throw new QuorumError(`eth_getTransactionReceipt: only ${values.length} endpoint(s) answered, quorum needs ${minimum}`, "eth_getTransactionReceipt");
    const present = values.filter((v): v is EvmReceipt => v !== null);
    if (present.length === 0) return null;
    if (present.length !== values.length) {
      throw new QuorumError("eth_getTransactionReceipt: some endpoints returned the receipt and some did not", "eth_getTransactionReceipt");
    }
    const groups = groupAnswers(present.map((result, i) => ({ url: this.endpoints[i] ?? `endpoint-${i}`, result })));
    if (groups.size !== 1) throw new QuorumError("eth_getTransactionReceipt: endpoints disagree", "eth_getTransactionReceipt", [...groups.values()].map((g) => canonical(g.result).slice(0, 200)));
    return present[0]!;
  }

  /** A transaction's public send fields; no signature is exposed. */
  async transaction(txHash: string): Promise<{ from: string; to: string | null; input: string; value: string; nonce: string; blockHash: string | null; blockNumber: string | null } | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("a transaction hash is 32 bytes of hex");
    const raw = await this.call<unknown>("eth_getTransactionByHash", [txHash]);
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.from !== "string" || typeof t.input !== "string" || typeof t.value !== "string" || typeof t.nonce !== "string") {
      throw new Error(`transaction ${txHash} is incomplete`);
    }
    return {
      from: t.from.toLowerCase(),
      to: typeof t.to === "string" ? t.to.toLowerCase() : null,
      input: t.input.toLowerCase(),
      value: t.value,
      nonce: t.nonce,
      blockHash: typeof t.blockHash === "string" ? t.blockHash.toLowerCase() : null,
      blockNumber: typeof t.blockNumber === "string" ? t.blockNumber : null,
    };
  }

  /** The same transaction from the quorum; a disagreement is a refusal. */
  async transactionQuorum(txHash: string, minimum: number): Promise<{ from: string; to: string | null; input: string; value: string; nonce: string; blockHash: string | null; blockNumber: string | null } | null> {
    return this.callQuorum<unknown>("eth_getTransactionByHash", [txHash], minimum, {
      normalize: (raw) => {
        if (!raw || typeof raw !== "object") return null;
        const t = raw as Record<string, unknown>;
        if (typeof t.from !== "string" || typeof t.input !== "string" || typeof t.value !== "string" || typeof t.nonce !== "string") {
          throw new Error(`transaction ${txHash} is incomplete`);
        }
        return {
          from: t.from.toLowerCase(),
          to: typeof t.to === "string" ? t.to.toLowerCase() : null,
          input: t.input.toLowerCase(),
          value: t.value,
          nonce: t.nonce,
          blockHash: typeof t.blockHash === "string" ? t.blockHash.toLowerCase() : null,
          blockNumber: typeof t.blockNumber === "string" ? t.blockNumber : null,
        };
      },
    }).then((v) => (v as { from: string; to: string | null; input: string; value: string; nonce: string; blockHash: string | null; blockNumber: string | null } | null));
  }

  /** A log page, identical across the quorum after a stable sort. */
  async logsQuorum(input: { address: string | string[]; topics: (string | null)[]; fromBlock: number; toBlock: number }, minimum: number): Promise<EvmLog[]> {
    return this.callQuorum<unknown[]>("eth_getLogs", [{
      address: input.address,
      topics: input.topics,
      fromBlock: `0x${input.fromBlock.toString(16)}`,
      toBlock: `0x${input.toBlock.toString(16)}`,
    }], minimum, {
      normalize: (raw) => {
        if (!Array.isArray(raw)) throw new Error("eth_getLogs did not return a list");
        return raw.map((l) => EvmClient.log(l as EvmLog, "eth_getLogs")).map((l) => ({
          address: l.address.toLowerCase(),
          topics: l.topics.map((t) => t.toLowerCase()),
          data: l.data.toLowerCase(),
          blockNumber: String(BigInt(l.blockNumber)),
          blockHash: l.blockHash.toLowerCase(),
          transactionHash: l.transactionHash.toLowerCase(),
          logIndex: String(BigInt(l.logIndex)),
          removed: l.removed === true,
        })).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex) || a.transactionHash.localeCompare(b.transactionHash));
      },
    }).then((raw) => (raw as EvmLog[]).map((l) => EvmClient.log(l, "eth_getLogs")));
  }

  /** A `decimals()`/`balanceOf()` call, identical across the quorum. */
  async callDataQuorum(to: string, data: string, minimum: number): Promise<string> {
    return this.callQuorum<string>("eth_call", [{ to, data }, "latest"], minimum, {
      normalize: (out) => {
        if (typeof out !== "string" || !/^0x[0-9a-fA-F]*$/.test(out)) throw new Error("eth_call returned no hex data");
        return out.toLowerCase();
      },
    });
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
