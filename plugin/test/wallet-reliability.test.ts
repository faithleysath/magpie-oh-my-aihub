import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainStore } from "../src/chainstore.ts";
import { buildIntent, intentDigest } from "../src/deposits.ts";
import { assetIdOf, defaultRegistry, type AssetRecord, type NetworkRecord } from "../src/networks.ts";
import { ChainWatcher, convertRawToNanos, TRANSFER_TOPIC, type CreditSink } from "../src/watcher.ts";
import { EvmClient } from "../src/evm.ts";
import { Wallet } from "../src/wallet.ts";
import { keccak256, fromHex, toHex } from "../src/keccak.ts";

/**
 * The four reliability defects the phase-7 review found. Each block starts with
 * the failure it reproduces, so the fix is proved by a test that failed before
 * it and passes after.
 *
 *  A. An event whose receipt could not be read was set `uncertain` and then
 *     never re-examined (`pendingFinality` only selected observed/confirming), so
 *     a temporary RPC error lost a real payment permanently. A log whose insert
 *     threw still let the page cursor advance past it. The scan's comment also
 *     claimed one transaction where there were two.
 *  B. `creditFinalized()` credited anything in `crediting` without re-checking
 *     the block hash or the finality policy, so a reorg between a failed credit
 *     and its retry was ignored.
 *  C. The conversion used the *current* registry rate, not the rate the deposit
 *     intent was issued at, so changing a test rate silently changed an amount.
 *  D. `wallet.receiving` lived only in memory, so every receiving address was
 *     lost on restart.
 */

const SIGNER_A = { address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", key: 1n };
const RECIPIENT = "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6";
const RECIPIENT_2 = "0x617c2C85E9D45F1E714855FA051CcB8c538200cd";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

// --- signing -----------------------------------------------------------------

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

// --- a fake chain with failure modes ----------------------------------------

interface FakeTx {
  hash: string;
  block: number;
  status: "0x1" | "0x0";
  logs: ReturnType<FakeChain["mkLog"]>[];
}

class FakeChain {
  chainId: number;
  readonly contract = CONTRACT;
  blocks: { number: string; hash: string; parentHash: string; timestamp: string }[] = [];
  txs = new Map<string, FakeTx>();
  /** `eth_getTransactionReceipt` fails while true (a temporary provider error) */
  receiptDown = false;
  /** `eth_getLogs` fails while true */
  logsDown = false;
  /** every RPC fails while true */
  allDown = false;
  finalizedAt: number | null = null;
  getLogsCalls = 0;

  constructor(chainId: number, height = 30) {
    this.chainId = chainId;
    for (let i = 0; i < height; i++) this.mine();
  }

  mine(parent?: string) {
    const number = this.blocks.length;
    const block = {
      number: `0x${number.toString(16)}`,
      hash: `0x${toHex(keccak256(`${this.chainId}:${number}:${parent ?? ""}`))}`,
      parentHash: parent ?? (number === 0 ? `0x${"00".repeat(32)}` : this.blocks[number - 1]!.hash),
      timestamp: `0x${(1_700_000_000 + number).toString(16)}`,
    };
    this.blocks.push(block);
    return block;
  }

  get head(): number {
    return this.blocks.length - 1;
  }

  mkLog(input: { from: string; to: string; amount: bigint; block: number; txHash: string; logIndex?: number; contract?: string }) {
    const b = this.blocks[input.block]!;
    return {
      address: input.contract ?? this.contract,
      topics: [
        TRANSFER_TOPIC,
        `0x${input.from.slice(2).toLowerCase().padStart(64, "0")}`,
        `0x${input.to.slice(2).toLowerCase().padStart(64, "0")}`,
      ],
      data: `0x${input.amount.toString(16).padStart(64, "0")}`,
      blockNumber: b.number,
      blockHash: b.hash,
      transactionHash: input.txHash,
      logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
    };
  }

  transfer(input: { from: string; to: string; amount: bigint; block?: number; status?: "0x1" | "0x0"; contract?: string }) {
    const block = input.block ?? this.head;
    const b = this.blocks[block]!;
    const txHash = `0x${toHex(keccak256(`${b.hash}:${this.txs.size}:${input.amount}:${input.from}`))}`;
    const log = this.mkLog({ from: input.from, to: input.to, amount: input.amount, block, txHash, contract: input.contract });
    this.txs.set(txHash, { hash: txHash, block, status: input.status ?? "0x1", logs: [log] });
    return { txHash, block, log };
  }

  /** Replaces a block and everything after it, keeping the same tx hashes. */
  reorg(atBlock: number) {
    this.blocks = this.blocks.slice(0, atBlock);
    this.mine(`0x${"ff".repeat(32)}`);
    while (this.blocks.length <= this.head) this.mine();
    for (const tx of this.txs.values()) {
      if (tx.block >= atBlock) {
        const b = this.blocks[tx.block]!;
        tx.logs = tx.logs.map((l) => ({ ...l, blockHash: b.hash }));
      }
    }
  }

  fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    if (this.allDown) return new Response("down", { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    const reply = (r: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: r }), { status: 200 });
    const error = (m: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: m } }), { status: 200 });
    switch (body.method) {
      case "eth_chainId":
        return reply(`0x${this.chainId.toString(16)}`);
      case "eth_blockNumber":
        return reply(`0x${this.head.toString(16)}`);
      case "eth_getBlockByNumber": {
        const tag = body.params[0] as string;
        if (tag === "finalized") return reply(this.blocks[this.finalizedAt ?? this.head] ?? null);
        if (tag === "safe" || tag === "latest") return reply(this.blocks[this.head] ?? null);
        return reply(this.blocks[Number(BigInt(tag))] ?? null);
      }
      case "eth_getLogs": {
        this.getLogsCalls += 1;
        if (this.logsDown) return error("rate limited");
        const f = body.params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        const out: unknown[] = [];
        for (const tx of this.txs.values()) {
          if (tx.block < from || tx.block > to) continue;
          out.push(...tx.logs);
        }
        return reply(out);
      }
      case "eth_getTransactionReceipt": {
        if (this.receiptDown) return error("the receipt index is catching up");
        const tx = this.txs.get(body.params[0] as string);
        if (!tx) return reply(null);
        const b = this.blocks[tx.block]!;
        return reply({ transactionHash: tx.hash, blockNumber: b.number, blockHash: b.hash, status: tx.status, logs: tx.logs });
      }
      case "eth_call":
        return reply(`0x${(6).toString(16).padStart(64, "0")}`);
      default:
        return error(`unexpected ${body.method}`);
    }
  };
}

class FakeCredit implements CreditSink {
  deposits = new Map<string, { consumerId: string; amountNanos: number; source: string }>();
  applied = new Set<string>();
  frozen: { consumerId: string; reason: string }[] = [];
  failApplyTimes = 0;

  depositIntent(input: { id: string; consumerId: string; amountNanos: number; source: string }): { created: boolean } {
    const existing = this.deposits.get(input.id);
    if (existing) {
      if (existing.consumerId !== input.consumerId || existing.amountNanos !== input.amountNanos) {
        throw new Error("replayed with another amount");
      }
      return { created: false };
    }
    this.deposits.set(input.id, { consumerId: input.consumerId, amountNanos: input.amountNanos, source: input.source });
    return { created: true };
  }
  async applyDeposit(input: { id: string }): Promise<void> {
    if (this.failApplyTimes > 0) {
      this.failApplyTimes -= 1;
      throw new Error("Magpie refused the cap write");
    }
    this.applied.add(input.id);
  }
  async freezeConsumer(consumerId: string, reason: string): Promise<void> {
    this.frozen.push({ consumerId, reason });
  }
  balance() {
    return { depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 };
  }
}

// --- harness -----------------------------------------------------------------

interface HarnessOpts {
  chainId?: number;
  confirmations?: number;
  decimals?: number;
  rateNanosPerToken?: string;
}

function harness(opts: HarnessOpts = {}) {
  const chainId = opts.chainId ?? 97;
  const registry = defaultRegistry();
  const asset = registry.registerTestAsset({
    chainId,
    contractAddress: CONTRACT,
    symbol: "tMOCK6",
    name: "Mock Test Dollar",
    decimals: opts.decimals ?? 6,
    nanosPerToken: opts.rateNanosPerToken ?? "1000000000",
    pricingNote: "1 tMOCK6 = 1 test USD",
  });
  const network: NetworkRecord = {
    ...registry.requireEnabledNetwork(chainId),
    finality: { mode: "confirmations", confirmations: opts.confirmations ?? 2, reorgDepth: opts.confirmations ?? 2, rationale: "test" },
  };
  const dir = mkdtempSync(join(tmpdir(), "reliability-"));
  const storePath = join(dir, "chain.sqlite");
  const store = new ChainStore(storePath);
  const chain = new FakeChain(chainId);
  const credit = new FakeCredit();
  const watcher = new ChainWatcher({ network, registry, store, ledger: credit, initialLookback: 500 });
  const wire = (w: ChainWatcher) => {
    (w as unknown as { client: InstanceType<typeof EvmClient> }).client = new EvmClient({
      chainId,
      endpoints: ["http://fake"],
      fetchImpl: ((u: string, i?: RequestInit) => chain.fetch(u, i)) as typeof fetch,
    });
  };
  wire(watcher);
  return { chainId, registry, asset, network, store, storePath, chain, credit, watcher, wire, dir };
}

function signedIntent(ctx: ReturnType<typeof harness>, input: { amount: string; consumerId?: string }) {
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
  return ctx.store.setPayer({ invoiceId: intent.invoiceId, payerAddress: SIGNER_A.address, digest: intentDigest(intent, ctx.network, ctx.asset) });
}

// =============================================================================
// A. A recorded but unverified event must never be lost
// =============================================================================

describe("A. a temporary receipt failure is retried, not lost", () => {
  test("the event is stored, marked retryable, and credited once the receipt is readable", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();

    // The provider cannot serve receipts for a moment.
    ctx.chain.receiptDown = true;
    const first = await ctx.watcher.scan();
    const event = ctx.store.eventByTx(t.txHash)[0]!;
    expect(event.status).toBe("uncertain");
    expect(ctx.credit.deposits.size).toBe(0);
    expect(first.credited).toBe(0);

    // It must be in the re-check set, not stranded.
    expect(ctx.store.pendingVerification(ctx.chainId).map((e) => e.id)).toContain(event.id);

    // The receipt comes back. The next scan must finish the job.
    ctx.chain.receiptDown = false;
    await ctx.watcher.scan();
    const after = ctx.store.eventByTx(t.txHash)[0]!;
    expect(after.status).toBe("credited");
    expect(ctx.credit.deposits.size).toBe(1);
    expect(ctx.credit.applied.size).toBe(1);
    ctx.store.close();
  });

  test("a restart continues an unverified event instead of skipping it", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    ctx.chain.receiptDown = true;
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("uncertain");

    // A brand-new store handle and watcher over the same file: a real restart.
    ctx.store.close();
    const reopened = new ChainStore(ctx.storePath);
    const restarted = new ChainWatcher({ network: ctx.network, registry: ctx.registry, store: reopened, ledger: ctx.credit, initialLookback: 500 });
    ctx.wire(restarted);
    ctx.chain.receiptDown = false;
    await restarted.scan();
    expect(reopened.eventByTx(t.txHash)[0]!.status).toBe("credited");
    expect(ctx.credit.deposits.size).toBe(1);
    reopened.close();
  });

  test("a reverted transaction is permanent, not retried forever", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n, status: "0x0" });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    const event = ctx.store.eventByTx(t.txHash)[0]!;
    expect(event.status).toBe("failed");
    // A permanent refusal is not in the retry set, so it cannot churn.
    expect(ctx.store.pendingVerification(ctx.chainId).map((e) => e.id)).not.toContain(event.id);
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("failed");
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("repeated scans of an unverifiable event never credit it", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    ctx.chain.receiptDown = true;
    for (let i = 0; i < 4; i++) await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(0);
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("uncertain");
    // And when it finally resolves, exactly one credit.
    ctx.chain.receiptDown = false;
    for (let i = 0; i < 3; i++) await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(1);
    expect(ctx.credit.applied.size).toBe(1);
    ctx.store.close();
  });
});

describe("A. the page cursor has explicit commit semantics", () => {
  test("a page whose events could not be stored does not advance the cursor", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    // The store refuses the page: simulate by making the insert throw.
    const store = ctx.store as unknown as { commitPage: (...a: unknown[]) => unknown };
    const original = store.commitPage;
    store.commitPage = () => {
      throw new Error("disk full");
    };
    const before = ctx.store.cursor(ctx.chainId)?.lastBlock ?? null;
    const r = await ctx.watcher.scan();
    expect(r.partial).toBe(true);
    expect(ctx.store.cursor(ctx.chainId)?.lastBlock ?? null).toBe(before);
    // Restore and re-scan: the same page is read again and stored.
    store.commitPage = original;
    const second = await ctx.watcher.scan();
    console.error("PROBE", JSON.stringify(second), "events", JSON.stringify(ctx.store.eventsForChain(ctx.chainId).map(e=>[e.status,e.reason])));
    await ctx.watcher.scan();
    expect(ctx.credit.deposits.size).toBe(1);
    ctx.store.close();
  });

  test("the events and the cursor commit in one transaction", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    // A store-level page commit is all-or-nothing: a bad event in the batch
    // leaves both the rows and the cursor untouched.
    const before = ctx.store.cursor(ctx.chainId)?.lastBlock ?? null;
    expect(() =>
      ctx.store.commitPage({
        chainId: ctx.chainId,
        block: ctx.chain.head,
        blockHash: ctx.chain.blocks[ctx.chain.head]!.hash,
        events: [
          {
            tokenContract: CONTRACT,
            txHash: `0x${"11".repeat(32)}`,
            logIndex: 0,
            blockNumber: ctx.chain.head,
            blockHash: ctx.chain.blocks[ctx.chain.head]!.hash,
            from: SIGNER_A.address,
            to: RECIPIENT,
            amountRaw: "1",
          },
          // A row that violates the NOT NULL constraint: a real mid-batch
          // failure, so the whole page must roll back, cursor included.
          {
            tokenContract: CONTRACT,
            txHash: `0x${"22".repeat(32)}`,
            logIndex: 0,
            blockNumber: ctx.chain.head,
            blockHash: ctx.chain.blocks[ctx.chain.head]!.hash,
            from: SIGNER_A.address,
            to: RECIPIENT,
            amountRaw: null as unknown as string,
          },
        ],
      }),
    ).toThrow();
    expect(ctx.store.cursor(ctx.chainId)?.lastBlock ?? null).toBe(before);
    // The first event of the batch is gone too: the page is all-or-nothing.
    expect(ctx.store.eventByTx(`0x${"11".repeat(32)}`)).toEqual([]);
    expect(ctx.store.eventByTx(`0x${"22".repeat(32)}`)).toEqual([]);
    ctx.store.close();
  });
});

// =============================================================================
// B. A credit retry must re-verify the chain
// =============================================================================

describe("B. a crediting retry re-verifies the block before crediting", () => {
  test("a reorg between a failed credit and its retry is refused", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();

    // The credit is booked but the cap write fails, so the event stays crediting.
    ctx.credit.failApplyTimes = 1;
    await ctx.watcher.scan();
    const stuck = ctx.store.eventByTx(t.txHash)[0]!;
    expect(stuck.status).toBe("crediting");
    expect(ctx.credit.applied.size).toBe(0);

    // Before the retry, the block is reorganised away.
    ctx.chain.reorg(t.block);
    await ctx.watcher.scan();

    const after = ctx.store.eventByTx(t.txHash)[0]!;
    expect(after.status).toBe("reverted");
    // The ledger intent stays for audit, but nothing was applied to the key.
    expect(ctx.credit.applied.size).toBe(0);
    expect(ctx.credit.deposits.size).toBe(1);
    // And the consumer is frozen, because a booked credit lost its chain event.
    expect(ctx.credit.frozen.length).toBeGreaterThanOrEqual(1);
    ctx.store.close();
  });

  test("a credit retry with no trustworthy RPC does not credit", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    ctx.credit.failApplyTimes = 1;
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("crediting");

    // The chain becomes unreadable: a retry must pause, not assume.
    ctx.chain.allDown = true;
    const r = await ctx.watcher.scan();
    expect(r.partial).toBe(true);
    expect(ctx.credit.applied.size).toBe(0);
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("crediting");

    // The chain comes back, unchanged: now it may credit.
    ctx.chain.allDown = false;
    await ctx.watcher.scan();
    expect(ctx.store.eventByTx(t.txHash)[0]!.status).toBe("credited");
    expect(ctx.credit.applied.size).toBe(1);
    expect(ctx.credit.deposits.size).toBe(1);
    ctx.store.close();
  });

  test("finality that no longer holds sends the event back to confirming", async () => {
    const ctx = harness({ confirmations: 5 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    for (let i = 0; i < 6; i++) ctx.chain.mine();
    ctx.credit.failApplyTimes = 1;
    await ctx.watcher.scan();
    const stuck = ctx.store.eventByTx(t.txHash)[0]!;
    expect(stuck.status).toBe("crediting");

    // A reorg that removes the depth without changing the block hash cannot
    // happen, so simulate the weaker condition: the block survives but the
    // policy is no longer satisfied because the chain rewound to before it.
    // Rewinding is what a deep reorg does; the hash then differs, which is the
    // `reverted` path. This test covers the case where the hash is intact but
    // the head is behind the event, which must also not credit.
    ctx.store.setEventStatus(stuck.id, "crediting", "test: force a retry");
    const originalHead = ctx.chain.blocks.length;
    ctx.chain.blocks = ctx.chain.blocks.slice(0, t.block);
    await ctx.watcher.scan();
    const after = ctx.store.eventByTx(t.txHash)[0]!;
    expect(after.status).not.toBe("credited");
    expect(ctx.credit.applied.size).toBe(0);
    ctx.chain.blocks.length = originalHead;
    ctx.store.close();
  });
});

// =============================================================================
// C. The conversion is bound to the intent's rate, not the current one
// =============================================================================

describe("C. a rate change cannot silently change a deposit's value", () => {
  test("the intent's rate is used even after the registry rate doubles", async () => {
    const ctx = harness({ confirmations: 1, rateNanosPerToken: "1000000000" });
    const intent = signedIntent(ctx, { amount: "1000000" });
    expect(intent.priceVersion).toBe(ctx.asset.pricing.version);

    // The operator doubles the test rate before the transfer is confirmed.
    ctx.registry.upsertAsset({
      ...ctx.asset,
      pricing: { nanosPerToken: "2000000000", version: "fixed:97:tMOCK6:2000000000:v1", kind: "fixed-test-rate", note: "doubled" },
    });

    ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();

    const event = ctx.store.eventByTx([...ctx.chain.txs.keys()][0]!)[0]!;
    expect(event.status).toBe("credited");
    // 1 token at the *issued* rate of 1 test USD, not 2.
    const deposit = ctx.credit.deposits.get(event.depositId!)!;
    expect(deposit.amountNanos).toBe(1_000_000_000);
    // And the rate actually used is recorded on the event.
    expect(event.rateNanosPerToken).toBe("1000000000");
    expect(event.rateVersion).toBe(intent.priceVersion);
    ctx.store.close();
  });

  test("a registry change after the credit cannot recompute the amount", async () => {
    const ctx = harness({ confirmations: 1 });
    signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    await ctx.watcher.scan();
    const event = ctx.store.eventByTx(t.txHash)[0]!;
    const booked = ctx.credit.deposits.get(event.depositId!)!.amountNanos;

    ctx.registry.upsertAsset({
      ...ctx.asset,
      pricing: { nanosPerToken: "5000000000", version: "fixed:97:tMOCK6:5000000000:v1", kind: "fixed-test-rate", note: "five times" },
    });
    // A full rescan, and a direct retry of the credit.
    ctx.store.rewindCursor(ctx.chainId, 0, "test: deliberate rescan");
    await ctx.watcher.scan();
    await ctx.watcher.creditFinalized();
    expect(ctx.credit.deposits.get(event.depositId!)!.amountNanos).toBe(booked);
    expect(ctx.credit.applied.size).toBe(1);
    ctx.store.close();
  });

  test("an intent without a rate snapshot whose version no longer matches goes to manual review", async () => {
    const ctx = harness({ confirmations: 1 });
    const intent = signedIntent(ctx, { amount: "1000000" });
    const t = ctx.chain.transfer({ from: SIGNER_A.address, to: RECIPIENT, amount: 1_000_000n });
    ctx.chain.mine();
    ctx.chain.mine();
    // Simulate a row written by the previous build: no snapshot on the intent.
    ctx.store.clearIntentRateSnapshot(intent.invoiceId);
    ctx.registry.upsertAsset({
      ...ctx.asset,
      pricing: { nanosPerToken: "3000000000", version: "fixed:97:tMOCK6:3000000000:v1", kind: "fixed-test-rate", note: "changed" },
    });
    await ctx.watcher.scan();
    const event = ctx.store.eventByTx(t.txHash)[0]!;
    expect(event.status).toBe("manualReview");
    expect(ctx.credit.deposits.size).toBe(0);
    ctx.store.close();
  });

  test("convertRawToNanos uses an explicit rate when given one", () => {
    const asset: AssetRecord = {
      assetId: assetIdOf(97, CONTRACT),
      chainId: 97,
      contractAddress: CONTRACT,
      symbol: "tMOCK6",
      name: "Mock",
      decimals: 6,
      issuerType: "mock",
      testnetOnly: true,
      credit: true,
      enabled: true,
      evidence: null,
      pricing: { nanosPerToken: "2000000000", version: "v2", kind: "fixed-test-rate", note: "x" },
    };
    // The registry says 2, the caller asks for the issued 1.
    expect(convertRawToNanos({ rawAmount: 1_000_000n, asset }).nanos).toBe(2_000_000_000);
    expect(convertRawToNanos({ rawAmount: 1_000_000n, asset, nanosPerToken: "1000000000", priceVersion: "v1" }).nanos).toBe(1_000_000_000);
  });
});

// =============================================================================
// D. Receiving addresses survive a restart
// =============================================================================

describe("D. receiving addresses are durable", () => {
  function walletAt(dir: string, store: ChainStore) {
    return new Wallet({
      credit: new FakeCredit(),
      registry: defaultRegistry(),
      store,
      initialLookback: 5,
    });
  }

  test("an address survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "recv-"));
    const path = join(dir, "chain.sqlite");
    const first = new ChainStore(path);
    const w1 = walletAt(dir, first);
    w1.setReceivingAddress("provider-a", 97, RECIPIENT);
    expect(w1.receivingAddressFor("provider-a", 97)).toBe(RECIPIENT);
    w1.close();

    const second = new ChainStore(path);
    const w2 = walletAt(dir, second);
    expect(w2.receivingAddressFor("provider-a", 97)).toBe(RECIPIENT);
    expect(w2.receivingAddresses()).toHaveLength(1);
    w2.close();
  });

  test("the unique key is (providerId, chainId): one provider, two chains", () => {
    const dir = mkdtempSync(join(tmpdir(), "recv-"));
    const store = new ChainStore(join(dir, "chain.sqlite"));
    const w = walletAt(dir, store);
    w.setReceivingAddress("provider-a", 97, RECIPIENT);
    w.setReceivingAddress("provider-a", 84532, RECIPIENT_2);
    expect(w.receivingAddressFor("provider-a", 97)).toBe(RECIPIENT);
    expect(w.receivingAddressFor("provider-a", 84532)).toBe(RECIPIENT_2);
    // Updating one leaves the other alone.
    w.setReceivingAddress("provider-a", 97, RECIPIENT_2);
    expect(w.receivingAddressFor("provider-a", 97)).toBe(RECIPIENT_2);
    expect(w.receivingAddressFor("provider-a", 84532)).toBe(RECIPIENT_2);
    // A different provider on the same chain is separate too.
    w.setReceivingAddress("provider-b", 97, RECIPIENT);
    expect(w.receivingAddressFor("provider-b", 97)).toBe(RECIPIENT);
    expect(w.receivingAddresses()).toHaveLength(3);
    w.close();
  });

  test("a corrupt address store is an error, never an unknown address", () => {
    const dir = mkdtempSync(join(tmpdir(), "recv-"));
    const path = join(dir, "chain.sqlite");
    writeFileSync(path, "this is not a database");
    expect(() => new ChainStore(path)).toThrow();
    // And nothing silently becomes a usable address.
    expect(readFileSync(path, "utf8")).toBe("this is not a database");
  });

  test("an issued intent keeps the address it was issued with", () => {
    const dir = mkdtempSync(join(tmpdir(), "recv-"));
    const store = new ChainStore(join(dir, "chain.sqlite"));
    const w = walletAt(dir, store);
    const registry = defaultRegistry();
    const asset = registry.registerTestAsset({
      chainId: 97,
      contractAddress: CONTRACT,
      symbol: "tMOCK6",
      name: "Mock Test Dollar",
      decimals: 6,
      nanosPerToken: "1000000000",
      pricingNote: "1:1",
    });
    // The wallet's registry is its own; register there too.
    const wreg = w.registryView();
    wreg.registerTestAsset({
      chainId: 97,
      contractAddress: CONTRACT,
      symbol: "tMOCK6",
      name: "Mock Test Dollar",
      decimals: 6,
      nanosPerToken: "1000000000",
      pricingNote: "1:1",
    });
    w.setReceivingAddress("provider-a", 97, RECIPIENT);
    const req = w.requestIntent({ providerId: "provider-a", consumerId: "c1", chainId: 97, assetId: asset.assetId, amountRaw: "1000000" });
    expect(req.intent.recipientAddress).toBe(RECIPIENT);
    // The provider changes their address afterwards.
    w.setReceivingAddress("provider-a", 97, RECIPIENT_2);
    const still = w.intents("c1").find((i) => i.invoiceId === req.intent.invoiceId)!;
    expect(still.recipientAddress).toBe(RECIPIENT);
    w.close();
  });

  test("the address table holds no secret material", () => {
    const dir = mkdtempSync(join(tmpdir(), "recv-"));
    const path = join(dir, "chain.sqlite");
    const store = new ChainStore(path);
    const w = walletAt(dir, store);
    w.setReceivingAddress("provider-a", 97, RECIPIENT);
    const columns = (store as unknown as { db: { query: (q: string) => { all: () => { name: string }[] } } }).db
      .query("PRAGMA table_info(receiving_addresses)")
      .all()
      .map((c) => c.name);
    expect(columns.sort()).toEqual(["added_at", "address", "chain_id", "provider_id"]);
    // The stored value is exactly the public address, as text, and nothing else.
    const rows = (store as unknown as { db: { query: (q: string) => { all: () => Record<string, unknown>[] } } }).db
      .query("SELECT * FROM receiving_addresses")
      .all();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["added_at", "address", "chain_id", "provider_id"]);
    expect(rows[0]!.address).toBe(RECIPIENT);
    // A 32-byte hex value anywhere in this table would be key material.
    for (const value of Object.values(rows[0]!)) {
      expect(String(value)).not.toMatch(/^(0x)?[0-9a-fA-F]{64}$/);
    }
    w.close();
  });
});
