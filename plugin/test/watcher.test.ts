import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainStore } from "../src/chainstore.ts";
import { buildIntent, intentDigest } from "../src/deposits.ts";
import { assetIdOf, defaultRegistry, type AssetRecord, type NetworkRecord } from "../src/networks.ts";
import { ChainWatcher, convertRawToNanos, finalityVerdict, TRANSFER_TOPIC, type CreditSink } from "../src/watcher.ts";
import type { EvmBlock, EvmLog, EvmReceipt } from "../src/evm.ts";
import { keccak256, fromHex, toHex } from "../src/keccak.ts";

/**
 * Requirement 14B's event and reconciliation half. A fake chain lets the exact
 * situations be produced: a duplicate log, two transfers in one transaction, a
 * reorg, a mid-scan RPC outage, a restart, a crash between the ledger write and
 * the cap write, and an unclaimed payer.
 */

const SIGNER_A = { address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", key: 1n };
const SIGNER_B = { address: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf", key: 2n };
const RECIPIENT = "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000ff";

// --- signing (the same tiny signer the deposits test uses) -------------------

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const mod = (a: bigint, m: bigint = P): bigint => ((a % m) + m) % m;
function inv(a: bigint, m: bigint): bigint {
  let b = mod(a, m), e = m - 2n, o = 1n;
  while (e > 0n) { if (e & 1n) o = (o * b) % m; b = (b * b) % m; e >>= 1n; }
  return o;
}
type Pt = { x: bigint; y: bigint } | null;
function add(a: Pt, b: Pt): Pt {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y) === 0n) return null;
    const l = mod(3n * a.x * a.x * inv(2n * a.y, P));
    const x = mod(l * l - 2n * a.x);
    return { x, y: mod(l * (a.x - x) - a.y) };
  }
  const l = mod((b.y - a.y) * inv(b.x - a.x, P));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}
function mul(p: Pt, k: bigint): Pt {
  let n = mod(k, N), o: Pt = null, a = p;
  while (n > 0n) { if (n & 1n) o = add(o, a); a = add(a, a); n >>= 1n; }
  return o;
}
function sign(digestHex: string, key: bigint): string {
  const z = BigInt(digestHex);
  let k = mod(BigInt(`0x${toHex(keccak256(`${key}:${digestHex}`))}`), N);
  if (k === 0n) k = 1n;
  const R = mul({ x: GX, y: GY }, k)!;
  const r = mod(R.x, N);
  let s = mod(inv(k, N) * (z + r * key), N);
  let parity = Number(R.y & 1n);
  if (s > N / 2n) { s = N - s; parity ^= 1; }
  const out = new Uint8Array(65);
  out.set(fromHex(r.toString(16).padStart(64, "0")), 0);
  out.set(fromHex(s.toString(16).padStart(64, "0")), 32);
  out[64] = parity + 27;
  return `0x${toHex(out)}`;
}

// --- a fake chain ------------------------------------------------------------

interface FakeTx {
  hash: string;
  block: number;
  status: "0x1" | "0x0";
  logs: EvmLog[];
}

/**
 * A chain that can be manipulated: blocks, logs, receipts, outages and a reorg.
 * It answers exactly the calls `EvmClient` makes, and nothing else.
 */
class FakeChain {
  chainId: number;
  /** the token this chain's asset is registered at */
  readonly contract: string;
  blocks: EvmBlock[] = [];
  txs = new Map<string, FakeTx>();
  failLogs = false;
  failAll = false;
  /** when set, `finalized` reports this block instead of following the policy */
  finalizedAt: number | null = null;
  calls = 0;

  constructor(chainId: number, height = 20) {
    this.chainId = chainId;
    this.contract = chainId === 97 ? CONTRACT : OTHER_CONTRACT;
    for (let i = 0; i < height; i++) this.mine();
  }

  mine(parent?: string): EvmBlock {
    const number = this.blocks.length;
    const block: EvmBlock = {
      number: `0x${number.toString(16)}`,
      hash: `0x${keccak256(`${this.chainId}:${number}:${parent ?? ""}`).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`,
      parentHash: parent ?? (number === 0 ? `0x${"00".repeat(32)}` : this.blocks[number - 1]!.hash),
      timestamp: `0x${(1_700_000_000 + number).toString(16)}`,
    };
    this.blocks.push(block);
    return block;
  }

  get head(): number {
    return this.blocks.length - 1;
  }

  /** Adds a Transfer log to a new block. */
  transfer(input: { from: string; to: string; amount: bigint; contract?: string; logIndex?: number; status?: "0x1" | "0x0"; block?: number }): { txHash: string; logIndex: number; block: number } {
    const block = input.block ?? this.head;
    const b = this.blocks[block]!;
    const txHash = `0x${keccak256(`${b.hash}:${this.txs.size}:${input.amount}`).reduce((s, x) => s + x.toString(16).padStart(2, "0"), "")}`;
    const logIndex = input.logIndex ?? (this.txs.get(txHash)?.logs.length ?? 0);
    const log: EvmLog = {
      address: input.contract ?? this.contract,
      topics: [TRANSFER_TOPIC, `0x${input.from.slice(2).toLowerCase().padStart(64, "0")}`, `0x${input.to.slice(2).toLowerCase().padStart(64, "0")}`],
      data: `0x${input.amount.toString(16).padStart(64, "0")}`,
      blockNumber: b.number,
      blockHash: b.hash,
      transactionHash: txHash,
      logIndex: `0x${logIndex.toString(16)}`,
    };
    const existing = this.txs.get(txHash);
    if (existing) existing.logs.push(log);
    else this.txs.set(txHash, { hash: txHash, block, status: input.status ?? "0x1", logs: [log] });
    return { txHash, logIndex, block };
  }

  /** Replaces a block and everything after it, as a reorg would. */
  reorg(atBlock: number): void {
    this.blocks = this.blocks.slice(0, atBlock);
    const fork = `0x${"ff".repeat(32)}`;
    this.mine(fork);
    while (this.blocks.length <= this.head) this.mine();
    // The transactions from the orphaned blocks keep their hash but their block
    // hash moved; that is what the watcher must notice.
    for (const tx of this.txs.values()) {
      if (tx.block >= atBlock) {
        const b = this.blocks[tx.block]!;
        tx.logs = tx.logs.map((l) => ({ ...l, blockHash: b.hash }));
      }
    }
  }

  fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    this.calls += 1;
    if (this.failAll) return new Response("boom", { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    const error = (message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message } }), { status: 200 });
    switch (body.method) {
      case "eth_chainId":
        return reply(`0x${this.chainId.toString(16)}`);
      case "eth_blockNumber":
        return reply(`0x${this.head.toString(16)}`);
      case "eth_getBlockByNumber": {
        const tag = body.params[0] as string;
        if (tag === "finalized") {
          const at = this.finalizedAt ?? this.head;
          return reply(this.blocks[at] ?? null);
        }
        if (tag === "safe") return reply(this.blocks[this.head] ?? null);
        if (tag === "latest") return reply(this.blocks[this.head] ?? null);
        const n = Number(BigInt(tag));
        return reply(this.blocks[n] ?? null);
      }
      case "eth_getLogs": {
        if (this.failLogs) return error("rate limited");
        const filter = body.params[0] as { address: string | string[]; fromBlock: string; toBlock: string; topics: string[] };
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        const wanted = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
        const out: EvmLog[] = [];
        for (const tx of this.txs.values()) {
          if (tx.block < from || tx.block > to) continue;
          for (const log of tx.logs) {
            if (!wanted.includes(log.address.toLowerCase())) continue;
            if (filter.topics[0] && log.topics[0] !== filter.topics[0]) continue;
            out.push(log);
          }
        }
        return reply(out);
      }
      case "eth_getTransactionReceipt": {
        const tx = this.txs.get(body.params[0] as string);
        if (!tx) return reply(null);
        const b = this.blocks[tx.block]!;
        const receipt: EvmReceipt = { transactionHash: tx.hash, blockNumber: b.number, blockHash: b.hash, status: tx.status, logs: tx.logs };
        return reply(receipt);
      }
      case "eth_call":
        return reply(`0x${(6).toString(16).padStart(64, "0")}`);
      default:
        return error(`unexpected method ${body.method}`);
    }
  };
}

// --- the ledger side ---------------------------------------------------------

/** A credit sink that records exactly what it was asked to do. */
class FakeCredit implements CreditSink {
  deposits = new Map<string, { consumerId: string; amountNanos: number; source: string }>();
  applied = new Set<string>();
  frozen: { consumerId: string; reason: string }[] = [];
  /** when set, `applyDeposit` throws this many times before succeeding */
  failApplyTimes = 0;
  failIntent = false;
  balances = new Map<string, { depositedNanos: number; consumedNanos: number; balanceNanos: number }>();

  depositIntent(input: { id: string; consumerId: string; amountNanos: number; source: string }): { created: boolean } {
    if (this.failIntent) throw new Error("the ledger is unavailable");
    const existing = this.deposits.get(input.id);
    if (existing) {
      if (existing.consumerId !== input.consumerId || existing.amountNanos !== input.amountNanos) throw new Error("replayed with another amount");
      return { created: false };
    }
    this.deposits.set(input.id, { consumerId: input.consumerId, amountNanos: input.amountNanos, source: input.source });
    return { created: true };
  }

  async applyDeposit(input: { id: string; consumerId: string; amountNanos: number }): Promise<void> {
    if (this.failApplyTimes > 0) {
      this.failApplyTimes -= 1;
      throw new Error("Magpie refused the cap write");
    }
    if (!this.deposits.has(input.id)) throw new Error(`deposit ${input.id} was not booked`);
    this.applied.add(input.id);
    const b = this.balances.get(input.consumerId) ?? { depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 };
    if (!this.appliedAgain.has(input.id)) {
      b.depositedNanos += input.amountNanos;
      b.balanceNanos += input.amountNanos;
      this.balances.set(input.consumerId, b);
    }
    this.appliedAgain.add(input.id);
  }

  private appliedAgain = new Set<string>();

  async freezeConsumer(consumerId: string, reason: string): Promise<void> {
    this.frozen.push({ consumerId, reason });
  }

  balance(consumerId: string): { depositedNanos: number; consumedNanos: number; balanceNanos: number } {
    return this.balances.get(consumerId) ?? { depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 };
  }
}

function harness(opts: { chainId?: number; finalityMode?: "finalized-tag" | "confirmations"; confirmations?: number; decimals?: number } = {}) {
  const chainId = opts.chainId ?? 97;
  const registry = defaultRegistry();
  const contract = chainId === 97 ? CONTRACT : OTHER_CONTRACT;
  const asset = registry.registerTestAsset({
    chainId,
    contractAddress: contract,
    symbol: `tMOCK${opts.decimals ?? 6}`,
    name: "Mock Token",
    decimals: opts.decimals ?? 6,
    nanosPerToken: "1000000000",
    pricingNote: "1 mock = 1 test USD",
  });
  const base = registry.requireEnabledNetwork(chainId);
  const network: NetworkRecord = {
    ...base,
    finality:
      opts.finalityMode === "finalized-tag"
        ? { mode: "finalized-tag", confirmations: 0, reorgDepth: 0, rationale: "test" }
        : { mode: "confirmations", confirmations: opts.confirmations ?? 3, reorgDepth: opts.confirmations ?? 3, rationale: "test" },
  };
  const chain = new FakeChain(chainId);
  const store = new ChainStore(join(mkdtempSync(join(tmpdir(), "watcher-")), "chain.sqlite"));
  const credit = new FakeCredit();
  const watcher = new ChainWatcher({
    network,
    registry,
    store,
    ledger: credit,
    client: undefined,
    initialLookback: 500,
  });
  // Replace the client's transport with the fake chain.
  const { EvmClient } = require("../src/evm.ts") as typeof import("../src/evm.ts");
  // A late-bound transport: the tests replace `chain.fetch` after the harness is
  // built, and the client must see the replacement.
  const client = new EvmClient({ chainId, endpoints: ["http://fake"], fetchImpl: ((u: string, i?: RequestInit) => chain.fetch(u, i)) as typeof fetch });
  (watcher as unknown as { client: InstanceType<typeof EvmClient> }).client = client;
  return { chainId, registry, asset, network, chain, store, credit, watcher, client };
}

function signedIntent(ctx: ReturnType<typeof harness>, input: { amount: string; payer?: { address: string; key: bigint }; consumerId?: string }) {
  const payer = input.payer ?? SIGNER_A;
  const intent = ctx.store.insertIntent(
    buildIntent({
      request: {
        providerId: "p1",
        consumerId: input.consumerId ?? "c1",
        chainId: ctx.chainId,
        assetId: ctx.asset.assetId,
        recipientAddress: RECIPIENT,
        expectedAmountRaw: input.amount,
        ttlSec: 3600,
      },
      network: ctx.network,
      asset: ctx.asset,
      priceVersion: ctx.asset.pricing.version,
    }),
  );
  const digest = intentDigest(intent, ctx.network, ctx.asset);
  return ctx.store.setPayer({ invoiceId: intent.invoiceId, payerAddress: payer.address, digest });
}

describe("finality policies", () => {
  test("a finalized-tag policy needs the tag to reach the block", () => {
    const policy = { mode: "finalized-tag" as const, confirmations: 0, reorgDepth: 0, rationale: "t" };
    expect(finalityVerdict({ policy, eventBlock: 100, head: 200, finalizedBlock: 99 }).final).toBe(false);
    expect(finalityVerdict({ policy, eventBlock: 100, head: 200, finalizedBlock: 100 }).final).toBe(true);
    expect(finalityVerdict({ policy, eventBlock: 100, head: 200, finalizedBlock: 150 }).final).toBe(true);
  });

  test("a confirmations policy needs the depth, regardless of the tag", () => {
    const policy = { mode: "confirmations" as const, confirmations: 15, reorgDepth: 15, rationale: "t" };
    // The tag being far ahead does not substitute for depth on this policy.
    expect(finalityVerdict({ policy, eventBlock: 100, head: 110, finalizedBlock: 200 }).final).toBe(false);
    expect(finalityVerdict({ policy, eventBlock: 100, head: 115, finalizedBlock: 0 }).final).toBe(true);
    expect(finalityVerdict({ policy, eventBlock: 100, head: 114, finalizedBlock: 200 }).final).toBe(false);
  });

  test("a chain that cannot answer the finalized tag never finalises under that policy", () => {
    const policy = { mode: "finalized-tag" as const, confirmations: 0, reorgDepth: 0, rationale: "t" };
    const v = finalityVerdict({ policy, eventBlock: 10, head: 9999, finalizedBlock: null });
    expect(v.final).toBe(false);
    expect(v.detail).toContain("finalized tag");
  });

  test("the two seeded chains produce different verdicts for the same heights", () => {
    const registry = defaultRegistry();
    const bsc = registry.network(97)!;
    const base = registry.network(84532)!;
    const state = { eventBlock: 1000, head: 1015, finalizedBlock: 1000 };
    // BSC: 15 confirmations is exactly its policy, so it is final.
    expect(finalityVerdict({ policy: bsc.finality, ...state }).final).toBe(true);
    // Base at the same heights: the finalized tag has only just reached the
    // block, which for Base is a ~17 minute wait, and 15 blocks is not enough.
    const baseState = { eventBlock: 1000, head: 1015, finalizedBlock: 900 };
    expect(finalityVerdict({ policy: base.finality, ...baseState }).final).toBe(false);
    expect(finalityVerdict({ policy: base.finality, eventBlock: 1000, head: 7000, finalizedBlock: 1000 }).final).toBe(true);
  });
});

describe("raw amount conversion", () => {
  const asset = (decimals: number): AssetRecord => ({
    assetId: assetIdOf(97, CONTRACT),
    chainId: 97,
    contractAddress: CONTRACT,
    symbol: "tMOCK",
    name: "Mock",
    decimals,
    issuerType: "mock",
    testnetOnly: true,
    enabled: true,
    pricing: { nanosPerToken: "1000000000", version: "fixed:v1", kind: "fixed-test-rate", note: "1:1" },
  });

  test("6 decimals: one whole token is one test USD", () => {
    expect(convertRawToNanos({ rawAmount: 1_000_000n, asset: asset(6) }).nanos).toBe(1_000_000_000);
    expect(convertRawToNanos({ rawAmount: 2_500_000n, asset: asset(6) }).nanos).toBe(2_500_000_000);
  });

  test("18 decimals: the same whole token is the same USD", () => {
    expect(convertRawToNanos({ rawAmount: 10n ** 18n, asset: asset(18) }).nanos).toBe(1_000_000_000);
    expect(convertRawToNanos({ rawAmount: 10n ** 18n / 4n, asset: asset(18) }).nanos).toBe(250_000_000);
  });

  test("an 18-decimal amount beyond 2^53 base units does not lose precision", () => {
    // 1e18 base units is far beyond Number.MAX_SAFE_INTEGER; a float would round.
    const raw = 12_345_678_901_234_567_890n;
    const c = convertRawToNanos({ rawAmount: raw, asset: asset(18) });
    expect(c.rawAmount).toBe(raw.toString());
    expect(c.nanos).toBe(Number((raw * 1_000_000_000n) / 10n ** 18n));
    expect(Number.isSafeInteger(c.nanos)).toBe(true);
  });

  test("rounding is floor and the remainder is recorded as dust", () => {
    // 1 base unit of a 6-decimal token is 0.000001 tokens = 1000 nanos exactly.
    expect(convertRawToNanos({ rawAmount: 1n, asset: asset(6) }).nanos).toBe(1000);
    // A 12-decimal token: 1 base unit = 1e-12 tokens = 0.001 nanos, which floors to 0.
    const c = convertRawToNanos({ rawAmount: 1n, asset: asset(12) });
    expect(c.nanos).toBe(0);
    expect(c.dustRaw).toBe("1000000000");
    expect(c.rounding).toBe("floor");
  });

  test("the conversion records the rate, its version, the decimals and the time", () => {
    const c = convertRawToNanos({ rawAmount: 1_000_000n, asset: asset(6), at: new Date("2026-10-30T00:00:00Z") });
    expect(c).toMatchObject({
      assetId: assetIdOf(97, CONTRACT),
      decimals: 6,
      rawAmount: "1000000",
      nanosPerToken: "1000000000",
      priceVersion: "fixed:v1",
      rateAt: "2026-10-30T00:00:00.000Z",
    });
  });

  test("a negative amount or a useless rate is refused", () => {
    expect(() => convertRawToNanos({ rawAmount: -1n, asset: asset(6) })).toThrow(/negative/);
    expect(() => convertRawToNanos({ rawAmount: 1n, asset: { ...asset(6), pricing: { ...asset(6).pricing, nanosPerToken: "0" } } })).toThrow(/rate/);
  });
});

describe("scanning", () => {
  test("a matching transfer is observed, claimed, finalized and credited once", async () => {
    const ctx = harness({ confirmations: 3 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    for (let i = 0; i < 4; i++) ctx.chain.mine();

    const r1 = await ctx.watcher.scan();
    expect(r1.errors).toEqual([]);
    expect(r1.newEvents).toBe(1);
    expect(r1.claimed).toBe(1);
    expect(r1.credited).toBe(1);

    const event = ctx.store.eventByTx(t.txHash)[0]!;
    expect(event.status).toBe("credited");
    expect(event.amountRaw).toBe("1000000");
    expect(event.confirmations).toBeGreaterThanOrEqual(3);
    expect(ctx.credit.deposits.size).toBe(1);
    expect([...ctx.credit.deposits.values()][0]).toMatchObject({ consumerId: "c1", amountNanos: 1_000_000_000, source: "chain:97" });
    expect(ctx.credit.applied.size).toBe(1);
    ctx.store.close();
  });

  test("the same log scanned again is one event and one credit", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    // Rewind the cursor to force a full re-read, as a manual rescan would.
    ctx.store.rewindCursor(ctx.chainId, 0, "test rescan");
    const again = await ctx.watcher.scan();
    expect(again.newEvents).toBe(0);
    expect(again.credited).toBe(0);
    expect(ctx.store.eventByTx(t.txHash)).toHaveLength(1);
    expect(ctx.credit.deposits.size).toBe(1);
    ctx.store.close();
  });

  test("two transfers in one transaction are two events and two credits", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    signedIntent(ctx, { amount: "2000000", consumerId: "c2" });
    const b = ctx.chain.head + 1;
    ctx.chain.mine();
    const one = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n, block: b });
    // The same transaction, second log: same hash, different index.
    const tx = ctx.chain.txs.get(one.txHash)!;
    tx.logs.push({ ...tx.logs[0]!, logIndex: "0x1", data: `0x${(2_000_000n).toString(16).padStart(64, "0")}` });
    ctx.chain.mine();
    ctx.chain.mine();
    const r = await ctx.watcher.scan();
    expect(r.newEvents).toBe(2);
    expect(ctx.store.eventByTx(one.txHash)).toHaveLength(2);
    expect(ctx.credit.deposits.size).toBe(2);
    ctx.store.close();
  });

  test("a transfer whose payer never signed is unclaimed and not credited", async () => {
    const ctx = harness({ confirmations: 1 });
    const t = ctx.chain.transfer({ from: SIGNER_B.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    const r = await ctx.watcher.scan();
    expect(r.unclaimed).toBe(1);
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("unclaimed");
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("a transfer of a token that is not allowlisted is never even requested", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n, contract: "0x00000000000000000000000000000000000000aa" });
    ctx.chain.mine();
    ctx.chain.mine();
    const r = await ctx.watcher.scan();
    // The address filter is the allowlist: the RPC is asked only for enabled
    // contracts, so another token's Transfer never becomes a candidate at all.
    expect(r.logs).toBe(0);
    expect(r.newEvents).toBe(0);
    expect(ctx.store.eventByTx(t.txHash)).toEqual([]);
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("a log from an unallowlisted contract is refused if a provider returns it anyway", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    // A misbehaving provider that ignores the address filter.
    const original = ctx.chain.fetch;
    const stray = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n, contract: "0x00000000000000000000000000000000000000aa" });
    const strayLog = ctx.chain.txs.get(stray.txHash)!.logs[0]!;
    let served = false;
    ctx.chain.fetch = async (url: string, init?: RequestInit) => {
      const res = await original(url, init);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method !== "eth_getLogs" || served) return res;
      served = true;
      const parsed = (await res.json()) as { result: EvmLog[] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [...parsed.result, strayLog] }), { status: 200 });
    };
    await ctx.watcher.scan();
    expect(ctx.store.anomalies(ctx.chainId).some((a) => a.kind === "bad-log" && a.detail.includes("not an enabled asset"))).toBe(true);
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("a transfer to another recipient is unclaimed", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: SIGNER_B.address, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("unclaimed");
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("a transfer of the wrong amount is unclaimed", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 999_999n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("unclaimed");
    ctx.store.close();
  });

  test("a log from a reverted transaction is failed, not credited", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n, status: "0x0" });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("failed");
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("an ERC-721 Transfer (4 topics) is refused rather than parsed as ERC-20", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const b = ctx.chain.head + 1;
    ctx.chain.mine();
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n, block: b });
    const tx = ctx.chain.txs.get(t.txHash)!;
    tx.logs[0]!.topics.push(`0x${"00".repeat(32)}`);
    ctx.chain.mine();
    ctx.chain.mine();
    const r = await ctx.watcher.scan();
    expect(r.newEvents).toBe(0);
    expect(ctx.credit.deposits.size).toBe(0);
    expect(ctx.store.anomalies(ctx.chainId).some((a) => a.detail.includes("3 topics"))).toBe(true);
    ctx.store.close();
  });

  test("two identical signed intents make the transfer uncertain, never a guess", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    const event = ctx.store.eventByTx(t.txHash)[0]!;
    expect(event.status).toBe("uncertain");
    expect(event.reason).toContain("will not guess");
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });
});

describe("finality and reorgs", () => {
  test("a transfer is not credited before the policy is satisfied", async () => {
    const ctx = harness({ confirmations: 10 });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(0);
    const event = ctx.store.eventsByStatus("confirming")[0]!;
    expect(event.status).toBe("confirming");
    for (let i = 0; i < 12; i++) ctx.chain.mine();
    await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(1);
    ctx.store.close();
  });

  test("a finalized-tag chain waits for the tag, not for a block count", async () => {
    const ctx = harness({ chainId: 84532, finalityMode: "finalized-tag" });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    for (let i = 0; i < 50; i++) ctx.chain.mine();
    // The tag is stuck far behind: 50 confirmations are still not final.
    ctx.chain.finalizedAt = 0;
    await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(0);
    // The tag catches up.
    ctx.chain.finalizedAt = ctx.chain.head;
    await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(1);
    ctx.store.close();
  });

  test("a reorg before finality marks the event reverted and credits nothing", async () => {
    const ctx = harness({ confirmations: 5 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toMatch(/observed|confirming/);
    ctx.chain.reorg(t.block);
    await ctx.watcher.scan();
    const event = ctx.store.eventByTx(t.txHash)[0]!;
    expect(event.status).toBe("reverted");
    expect(ctx.credit.deposits.size).toBe(0);
    expect(ctx.store.anomalies(ctx.chainId).some((a) => a.kind === "reorg")).toBe(true);
    ctx.store.close();
  });

  test("a reorg of an already-credited event freezes the consumer and keeps the deposit", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("credited");
    const depositId = ctx.store.eventByTx(t.txHash)[0]!.depositId!;
    ctx.chain.reorg(t.block);
    await ctx.watcher.scan();
    const event = ctx.store.eventByTx(t.txHash)[0]!;
    expect(event.status).toBe("reverted");
    // The deposit is still there: a freeze, not a deletion.
    expect(ctx.credit.deposits.has(depositId)).toBe(true);
    expect(ctx.credit.frozen).toHaveLength(1);
    expect(ctx.credit.frozen[0]!.consumerId).toBe("c1");
    expect(ctx.credit.frozen[0]!.reason).toContain("reverted");
    ctx.store.close();
  });
});

describe("crash and restart", () => {
  test("the cursor survives a restart and the same page is not re-credited", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    const cursor = ctx.store.cursor(ctx.chainId)!;
    expect(cursor.lastBlock).toBe(ctx.chain.head);
    expect(ctx.credit.deposits.size).toBe(1);

    // A new watcher over the same store is a restart: it resumes from the cursor.
    const restarted = new ChainWatcher({ network: ctx.network, registry: ctx.registry, store: ctx.store, ledger: ctx.credit, initialLookback: 500 });
    const { EvmClient } = require("../src/evm.ts") as typeof import("../src/evm.ts");
    const { EvmClient: C } = require("../src/evm.ts") as typeof import("../src/evm.ts");
    (restarted as unknown as { client: InstanceType<typeof C> }).client = new C({ chainId: ctx.chainId, endpoints: ["http://fake"], fetchImpl: ctx.chain.fetch as unknown as typeof fetch });
    const r = await restarted.scan();
    expect(r.newEvents).toBe(0);
    expect(r.credited).toBe(0);
    expect(ctx.credit.deposits.size).toBe(1);
    ctx.store.close();
  });

  test("a crash between the ledger write and the cap write is retried with the same deposit id", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    ctx.credit.failApplyTimes = 1;
    await ctx.watcher.scan();
    // Booked, not applied, and the event is left in a retryable state.
    expect(ctx.credit.deposits.size).toBe(1);
    expect(ctx.credit.applied.size).toBe(0);
    expect(ctx.store.eventsByStatus("crediting")).toHaveLength(1);
    expect(ctx.store.anomalies(ctx.chainId).some((a) => a.kind === "credit-failure")).toBe(true);

    // The retry must ask for the same deposit, not a new one.
    await ctx.watcher.creditFinalized();
    expect(ctx.credit.deposits.size).toBe(1);
    expect(ctx.credit.applied.size).toBe(1);
    expect(ctx.store.eventsByStatus("credited")).toHaveLength(1);
    ctx.store.close();
  });

  test("a ledger that is unavailable leaves the event for a later retry, never credited", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    ctx.credit.failIntent = true;
    await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(0);
    expect(ctx.store.eventsByStatus("manualReview")).toHaveLength(1);
    expect(ctx.store.anomalies(ctx.chainId).some((a) => a.kind === "ledger-failure")).toBe(true);
    ctx.store.close();
  });

  test("an RPC outage mid-scan leaves the cursor where it was and does not lose events", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    // A healthy scan first, so there is a committed cursor to compare against.
    await ctx.watcher.scan();
    const before = ctx.store.cursor(ctx.chainId)?.lastBlock ?? null;
    expect(before).not.toBeNull();
    // A new block so the failed scan has work it cannot complete.
    ctx.chain.mine();
    ctx.chain.failLogs = true;
    const r = await ctx.watcher.scan();
    expect(r.partial).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(ctx.store.cursor(ctx.chainId)?.lastBlock ?? null).toBe(before);
    expect(ctx.store.lastError(ctx.chainId)).toBeTruthy();
    ctx.chain.failLogs = false;
    const ok = await ctx.watcher.scan();
    expect(ok.partial).toBe(false);
    ctx.store.close();
  });

  test("a completely unreachable RPC is reported, not treated as no deposits", async () => {
    const ctx = harness({ confirmations: 1 });
    ctx.chain.failAll = true;
    const r = await ctx.watcher.scan();
    expect(r.partial).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
    const health = await ctx.watcher.health();
    expect(health.head).toBeNull();
    expect(health.lastError).toBeTruthy();
    ctx.store.close();
  });

  test("an RPC that answers with the wrong chain id is refused", async () => {
    const ctx = harness({ confirmations: 1 });
    ctx.chain.chainId = 84532; // the BSC watcher's endpoint now claims Base
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    const r = await ctx.watcher.scan();
    expect(r.partial).toBe(true);
    expect(r.errors[0]).toContain("refusing to watch");
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("a corrupt cursor is repaired by an explicit rewind that records an anomaly", async () => {
    const ctx = harness({ confirmations: 1 });
    ctx.store.advanceCursor({ chainId: ctx.chainId, block: 10_000_000, blockHash: null });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    // The cursor is past the head, so nothing would ever be scanned again.
    const stuck = await ctx.watcher.scan();
    expect(stuck.newEvents).toBe(0);
    ctx.store.rewindCursor(ctx.chainId, 0, "the cursor was ahead of the chain");
    const r = await ctx.watcher.scan();
    expect(r.newEvents).toBe(1);
    expect(ctx.store.anomalies(ctx.chainId).some((a) => a.kind === "cursor-gap")).toBe(true);
    ctx.store.close();
  });
});

describe("chain independence", () => {
  test("one chain failing does not stop the other", async () => {
    const a = harness({ chainId: 97, confirmations: 1 });
    const b = harness({ chainId: 84532, confirmations: 1 });
    signedIntent(a, { amount: "1000000" });
    signedIntent(b, { amount: "2000000" });
    a.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    b.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 2_000_000n });
    for (let i = 0; i < 4; i++) {
      a.chain.mine();
      b.chain.mine();
    }
    a.chain.failAll = true;
    const [ra, rb] = await Promise.all([a.watcher.scan(), b.watcher.scan()]);
    expect(ra.partial).toBe(true);
    expect(rb.partial).toBe(false);
    expect(b.credit.deposits.size).toBe(1);
    expect(a.credit.deposits.size).toBe(0);
    a.store.close();
    b.store.close();
  });

  test("each chain has its own cursor and its own events", async () => {
    const a = harness({ chainId: 97, confirmations: 1 });
    const b = harness({ chainId: 84532, confirmations: 1 });
    a.store.advanceCursor({ chainId: 97, block: 5, blockHash: null });
    expect(a.store.cursor(97)!.lastBlock).toBe(5);
    expect(b.store.cursor(84532)).toBeNull();
    expect(a.store.allCursors().map((c) => c.chainId)).toEqual([97]);
    a.store.close();
    b.store.close();
  });
});

describe("decimals verification", () => {
  test("an asset whose on-chain decimals differ is reported, not silently used", async () => {
    const ctx = harness({ confirmations: 1, decimals: 18 });
    // The fake chain always answers 6.
    const health = await ctx.watcher.health();
    expect(health.assets[0]!.onchainDecimals).toBe(6);
    expect(health.assets[0]!.decimalsOk).toBe(false);
    ctx.store.close();
  });

  test("a matching decimals value is reported as ok", async () => {
    const ctx = harness({ confirmations: 1, decimals: 6 });
    const health = await ctx.watcher.health();
    expect(health.assets[0]!.decimalsOk).toBe(true);
    ctx.store.close();
  });
});
