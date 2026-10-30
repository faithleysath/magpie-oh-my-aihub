// TEST ONLY: synthetic read-only RPC state. No Magpie, ledger or credit sink.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { FakeChain, TRANSFER_TOPIC } from "../../../../../plugin/test/support/fake-chain.ts";
import type { EvmBlock, EvmLog } from "../../../../../plugin/src/evm.ts";

export const SIMULATION_LABEL = "本地模拟链，仅复用 chainId；未连接公链，未付款";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BLOCKS = 4096;
const MAX_EVENTS = 256;
const MAX_OPERATIONS = 512;
const MAX_FILE = 4 * 1024 * 1024;
export type ChainId = 97 | 84532;
interface Flags { failAll: boolean; failLogs: boolean; receipt: "normal" | "missing" | "unavailable"; wrongChain: boolean; wrongDecimals: boolean }
interface ChainSnapshot {
  chainId: ChainId; contract: string; decimals: number; blocks: EvmBlock[];
  txs: ReturnType<LocalChain["transactions"]>; finalizedAt: number; flags: Flags;
}
interface SavedOperation { id: string; fingerprint: string; result: unknown }
interface Snapshot { schema: "ohmyaihub.local-fixture/v1"; chains: ChainSnapshot[]; operations: SavedOperation[] }

export class FixtureInputError extends Error { constructor(message = "invalid fixture input") { super(message); } }
function requireInput(condition: unknown, message: string): asserts condition { if (!condition) throw new FixtureInputError(message); }
export function object(input: unknown): Record<string, unknown> {
  requireInput(input && typeof input === "object" && !Array.isArray(input), "JSON object required");
  return input as Record<string, unknown>;
}
export function fields(input: Record<string, unknown>, allowed: readonly string[], required = allowed): void {
  requireInput(Object.keys(input).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(input, key)), "unexpected or missing fields");
}
export function address(input: unknown): string {
  requireInput(typeof input === "string" && ADDRESS.test(input) && !/^0x0{40}$/i.test(input), "nonzero20byte address required");
  return input.toLowerCase();
}
function integer(input: unknown, min: number, max: number): number {
  requireInput(typeof input === "number" && Number.isSafeInteger(input) && input >= min && input <= max, "integer outside fixture limits");
  return input;
}
export function chainId(input: unknown): ChainId {
  requireInput(input === 97 || input === 84532, "choose explicit fixture chain97 or84532");
  return input;
}
function digest(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
function quantity(input: unknown): number {
  requireInput(typeof input === "string" && /^0x[0-9a-f]+$/i.test(input), "hex quantity required");
  const value = Number(BigInt(input));
  requireInput(Number.isSafeInteger(value) && value >= 0, "quantity outside safe range");
  return value;
}

/** Reuses FakeChain event/receipt encoding; time and RPC perimeter are corrected here. */
class LocalChain extends FakeChain {
  flags: Flags = { failAll: false, failLogs: false, receipt: "normal", wrongChain: false, wrongDecimals: false };
  override mine(parent?: string): EvmBlock {
    if (this.blocks.length >= MAX_BLOCKS) throw new FixtureInputError("fixture block limit reached");
    const block = super.mine(parent);
    block.timestamp = "0x" + Math.floor(Date.now() / 1000).toString(16);
    return block;
  }
  transactions() { return [...this.txs.values()]; }
  snapshot(): ChainSnapshot {
    return { chainId: chainId(this.chainId), contract: this.contract, decimals: this.decimals, blocks: this.blocks, txs: this.transactions(), finalizedAt: this.finalizedAt ?? 0, flags: this.flags };
  }
}
function restore(snapshot: ChainSnapshot): LocalChain {
  const chain = new LocalChain({ chainId: snapshot.chainId, contract: snapshot.contract, decimals: snapshot.decimals, height: 0, finalizedAt: snapshot.finalizedAt });
  chain.blocks = snapshot.blocks;
  chain.txs = new Map(snapshot.txs.map((tx) => [tx.hash, tx]));
  chain.flags = snapshot.flags;
  return chain;
}

function validateSnapshot(input: unknown): Snapshot {
  const value = object(input);
  fields(value, ["schema", "chains", "operations"]);
  requireInput(value.schema === "ohmyaihub.local-fixture/v1" && Array.isArray(value.chains) && value.chains.length === 2 && Array.isArray(value.operations) && value.operations.length <= MAX_OPERATIONS, "invalid fixture store");
  const ids = new Set<number>();
  for (const raw of value.chains) {
    const c = object(raw);
    fields(c, ["chainId", "contract", "decimals", "blocks", "txs", "finalizedAt", "flags"]);
    const id = chainId(c.chainId);
    requireInput(!ids.has(id), "duplicate fixture chain"); ids.add(id);
    address(c.contract);
    requireInput(c.decimals === (id === 97 ? 6 : 18), "invalid fixture decimals");
    requireInput(Array.isArray(c.blocks) && c.blocks.length > 0 && c.blocks.length <= MAX_BLOCKS && Array.isArray(c.txs) && c.txs.length <= MAX_EVENTS, "invalid fixture bounds");
    integer(c.finalizedAt, 0, c.blocks.length - 1);
    for (const [index, rawBlock] of c.blocks.entries()) {
      const b = object(rawBlock); fields(b, ["number", "hash", "parentHash", "timestamp"]);
      requireInput(quantity(b.number) === index && typeof b.hash === "string" && HASH.test(b.hash) && typeof b.parentHash === "string" && HASH.test(b.parentHash), "invalid block");
      quantity(b.timestamp);
      if (index > 0) requireInput(b.parentHash === c.blocks[index - 1].hash, "broken fixture block ancestry");
    }
    const txIds = new Set<string>();
    for (const rawTx of c.txs) {
      const tx = object(rawTx); fields(tx, ["hash", "block", "status", "logs"]);
      requireInput(typeof tx.hash === "string" && HASH.test(tx.hash) && !txIds.has(tx.hash), "invalid transaction"); txIds.add(tx.hash);
      integer(tx.block, 0, c.blocks.length - 1);
      requireInput((tx.status === "0x1" || tx.status === "0x0") && Array.isArray(tx.logs) && tx.logs.length === 1, "invalid receipt");
      const log = object(tx.logs[0]); fields(log, ["address", "topics", "data", "blockNumber", "blockHash", "transactionHash", "logIndex"]);
      address(log.address);
      requireInput(Array.isArray(log.topics) && log.topics.length === 3 && log.topics[0] === TRANSFER_TOPIC && log.topics.every((t) => typeof t === "string" && HASH.test(t)) && typeof log.data === "string" && HASH.test(log.data), "invalid transfer");
      requireInput(quantity(log.blockNumber) === tx.block && log.blockHash === c.blocks[tx.block as number].hash && log.transactionHash === tx.hash && log.logIndex === "0x0", "inconsistent transfer");
    }
    const flags = object(c.flags); fields(flags, ["failAll", "failLogs", "receipt", "wrongChain", "wrongDecimals"]);
    requireInput(["normal", "missing", "unavailable"].includes(String(flags.receipt)) && [flags.failAll, flags.failLogs, flags.wrongChain, flags.wrongDecimals].every((v) => typeof v === "boolean"), "invalid error flags");
  }
  const operations = new Set<string>();
  for (const rawOperation of value.operations) {
    const op = object(rawOperation); fields(op, ["id", "fingerprint", "result"]);
    requireInput(typeof op.id === "string" && UUID.test(op.id) && !operations.has(op.id) && typeof op.fingerprint === "string" && /^[0-9a-f]{64}$/.test(op.fingerprint) && JSON.stringify(op.result).length < 1024, "invalid operation tombstone"); operations.add(op.id);
  }
  return input as Snapshot;
}

/** No backup recovery: an uncertain store must never revive a spent event UUID. */
export function atomicPrivateJson(file: string, input: unknown): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  requireInput(!lstatSync(directory).isSymbolicLink(), "fixture directory must not be a symlink");
  chmodSync(directory, 0o700);
  const tmp = file + "." + randomBytes(8).toString("hex") + ".tmp";
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(input) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, file);
    const dirFd = openSync(directory, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* renamed */ }
  }
}

export class FixtureModel {
  private data: Snapshot;
  private failed = false;
  private calls: Record<string, number> = {};
  constructor(private readonly file: string) {
    requireInput(isAbsolute(file), "absolute private fixture path required");
    try {
      const stat = lstatSync(file);
      requireInput(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_FILE, "invalid fixture store file");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { this.data = validateSnapshot(JSON.parse(readFileSync(fd, "utf8"))); } finally { closeSync(fd); }
      chmodSync(file, 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("fixture store unavailable");
      const chains = ([97, 84532] as const).map((id) => new LocalChain({ chainId: id, contract: "0x" + randomBytes(20).toString("hex"), decimals: id === 97 ? 6 : 18, height: 20, finalizedAt: 0 }).snapshot());
      this.data = { schema: "ohmyaihub.local-fixture/v1", chains, operations: [] };
      atomicPrivateJson(file, this.data);
    }
  }
  snapshot() {
    return { label: SIMULATION_LABEL, chains: this.data.chains.map((c) => ({ chainId: c.chainId, contractAddress: c.contract, symbol: c.decimals === 6 ? "tFIX6" : "tFIX18", name: `Local Fixture Mock${c.decimals}`, decimals: c.decimals, nanosPerToken: String(10 ** 9), head: c.blocks.length - 1, finalized: c.finalizedAt, flags: c.flags, events: c.txs.map((tx) => ({ txHash: tx.hash, block: tx.block, from: "0x" + tx.logs[0]!.topics[1]!.slice(-40), to: "0x" + tx.logs[0]!.topics[2]!.slice(-40), amountRaw: BigInt(tx.logs[0]!.data).toString(), tokenContract: tx.logs[0]!.address })) })), operations: this.data.operations.length, rpcCounts: { ...this.calls } };
  }
  control(name: string, input: Record<string, unknown>, operationId: unknown): unknown {
    requireInput(!this.failed, "fixture store unavailable");
    requireInput(typeof operationId === "string" && UUID.test(operationId), "operation UUID required");
    const id = operationId.toLowerCase();
    const fingerprint = digest([name, input]);
    const prior = this.data.operations.find((op) => op.id === id);
    if (prior) { requireInput(prior.fingerprint === fingerprint, "operation UUID payload conflict"); return prior.result; }
    requireInput(this.data.operations.length < MAX_OPERATIONS, "fixture operation limit reached");
    const next = structuredClone(this.data);
    const chain = restore(next.chains.find((c) => c.chainId === chainId(input.chainId))!);
    let result: unknown;
    if (name === "mine") {
      fields(input, ["chainId", "blocks"]); chain.mineN(integer(input.blocks, 1, 100)); result = { head: chain.head };
    } else if (name === "finalize") {
      fields(input, ["chainId", "block"]); chain.finalizedAt = integer(input.block, chain.finalizedAt ?? 0, chain.head); result = { finalized: chain.finalizedAt };
    } else if (name === "flags") {
      fields(input, ["chainId", "failAll", "failLogs", "receipt", "wrongChain", "wrongDecimals"]);
      const flags = { ...input }; delete flags.chainId;
      requireInput(["normal", "missing", "unavailable"].includes(String(flags.receipt)) && [flags.failAll, flags.failLogs, flags.wrongChain, flags.wrongDecimals].every((v) => typeof v === "boolean"), "invalid fixture error controls");
      chain.flags = flags as unknown as Flags; result = { updated: true };
    } else if (name === "transfer") {
      fields(input, ["chainId", "from", "to", "amountRaw", "tokenContract"]);
      requireInput(chain.txs.size < MAX_EVENTS, "fixture event limit reached");
      const from = address(input.from), to = address(input.to), contract = address(input.tokenContract);
      requireInput(typeof input.amountRaw === "string" && /^[1-9][0-9]{0,77}$/.test(input.amountRaw) && BigInt(input.amountRaw) < (1n << 256n), "positive uint256 raw amount required");
      chain.mine(); // Never inject retrospectively below the production watcher's cursor.
      result = chain.transfer({ from, to, amount: BigInt(input.amountRaw), contract });
    } else throw new FixtureInputError("unknown fixture control");
    next.chains = next.chains.map((c) => c.chainId === chain.chainId ? chain.snapshot() : c);
    next.operations.push({ id, fingerprint, result });
    requireInput(Buffer.byteLength(JSON.stringify(next)) <= MAX_FILE, "fixture store size limit reached");
    try { atomicPrivateJson(this.file, next); } catch { this.failed = true; throw new Error("fixture store unavailable"); }
    this.data = next;
    return result;
  }
  async rpc(id: ChainId, payload: unknown): Promise<{ status: number; body: unknown }> {
    const body = object(payload);
    fields(body, ["jsonrpc", "id", "method", "params"]);
    requireInput(body.jsonrpc === "2.0" && (typeof body.id === "string" || (typeof body.id === "number" && Number.isSafeInteger(body.id))) && typeof body.method === "string" && Array.isArray(body.params), "invalid JSON-RPC request");
    const method = body.method;
    const supported = ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call", "eth_getTransactionReceipt", "eth_getLogs"].includes(method);
    if (supported) this.calls[`${id}:${method}`] = (this.calls[`${id}:${method}`] ?? 0) + 1;
    const chain = restore(this.data.chains.find((c) => c.chainId === id)!);
    const reply = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result } });
    const rpcError = (code: number, message: string) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, error: { code, message } } });
    if (chain.flags.failAll) return { status: 503, body: { error: "synthetic RPC outage" } };
    if (method === "eth_chainId" || method === "eth_blockNumber") {
      requireInput(body.params.length === 0, "RPC params invalid");
      return reply("0x" + (method === "eth_chainId" ? (chain.flags.wrongChain ? 1 : id) : chain.head).toString(16));
    }
    if (method === "eth_getBlockByNumber") {
      requireInput(body.params.length === 2 && body.params[1] === false, "RPC block params invalid");
      const tag = body.params[0];
      const at = tag === "finalized" ? chain.finalizedAt! : tag === "latest" || tag === "safe" ? chain.head : quantity(tag);
      return reply(chain.blocks[at] ?? null);
    }
    if (method === "eth_call") {
      requireInput(body.params.length === 2 && body.params[1] === "latest", "RPC call params invalid");
      const call = object(body.params[0]); fields(call, ["to", "data"]);
      if (address(call.to) !== chain.contract || call.data !== "0x313ce567") return rpcError(-32602, "fixture exposes only registered token decimals()");
      return reply("0x" + (chain.decimals + (chain.flags.wrongDecimals ? 1 : 0)).toString(16).padStart(64, "0"));
    }
    if (method === "eth_getTransactionReceipt") {
      requireInput(body.params.length === 1 && typeof body.params[0] === "string" && HASH.test(body.params[0]), "RPC receipt params invalid");
      if (chain.flags.receipt === "missing") return reply(null);
      if (chain.flags.receipt === "unavailable") return { status: 503, body: { error: "synthetic missing receipt service" } };
      return { status: 200, body: await (await chain.fetch("local-fixture", { body: JSON.stringify(body) })).json() };
    }
    if (method === "eth_getLogs") {
      requireInput(body.params.length === 1, "RPC logs params invalid");
      const filter = object(body.params[0]); fields(filter, ["address", "topics", "fromBlock", "toBlock"]);
      const addresses = Array.isArray(filter.address) ? filter.address.map(address) : [address(filter.address)];
      requireInput(addresses.length <= 8 && Array.isArray(filter.topics) && filter.topics.length <= 4 && filter.topics.every((topic) => topic === null || typeof topic === "string" && HASH.test(topic)), "invalid log filter");
      const from = quantity(filter.fromBlock), to = quantity(filter.toBlock);
      requireInput(to >= from && to - from <= MAX_BLOCKS, "invalid log range");
      if (chain.flags.failLogs) return rpcError(-32000, "synthetic log service outage");
      const topics = filter.topics as (string | null)[];
      const logs = chain.transactions().flatMap((tx) => tx.logs).filter((log: EvmLog) => quantity(log.blockNumber) >= from && quantity(log.blockNumber) <= to && addresses.includes(log.address.toLowerCase()) && topics.every((topic, index) => topic === null || topic.toLowerCase() === log.topics[index]?.toLowerCase()));
      return reply(logs);
    }
    return rpcError(-32601, "method not supported by local fixture");
  }
}
