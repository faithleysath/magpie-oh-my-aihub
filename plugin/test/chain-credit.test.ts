import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Provisioner } from "../src/provisioner.ts";
import { costNanos, nanosToUsd, priceSnapshot, usdToNanos, type PriceParts } from "../src/pricing.ts";
import { Wallet } from "../src/wallet.ts";
import { ChainStore } from "../src/chainstore.ts";
import { buildIntent, intentDigest } from "../src/deposits.ts";
import { defaultRegistry } from "../src/networks.ts";
import { ChainWatcher, type CreditSink } from "../src/watcher.ts";
import { EvmClient } from "../src/evm.ts";
import { keccak256, fromHex, toHex } from "../src/keccak.ts";

/**
 * The phase-7 closing loop, in one test: a finalized chain event becomes a
 * ledger deposit, the provisioner raises the Magpie cap, and the cap is what
 * admits or refuses the next call.
 *
 * The "Magpie" here is a fake with the observable contract of the real one (a
 * cost cap, a used counter, 429 when used >= cap), because the point under test
 * is the plugin's arithmetic and ordering, not Magpie's. The real-Magpie half is
 * in the testnet validation note.
 */

const MODEL = "lab/lab-model";
// USD per 1M tokens, which is the unit Magpie stores: $1 in, $2 out.
const BASE: PriceParts = { input: 1, output: 2, cache_read: 0, cache_write: 0 };
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const RECIPIENT = "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6";
const PAYER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

interface FakeKey {
  id: string;
  name: string;
  secret: string;
  models: string[];
  cap: number;
  start: number;
  reset: number;
  window: string;
  calls: number;
}

class FakeMagpie {
  keys = new Map<string, FakeKey>();
  rows: { callerKeyId: string; t: string; in: number; out: number }[] = [];
  private n = 0;
  constructor(private log: string) {}
  keyByName(name: string) {
    for (const k of this.keys.values()) if (k.name === name) return { ...k };
    return undefined;
  }
  keyById(id: string) {
    const k = this.keys.get(id);
    return k ? { ...k } : undefined;
  }
  async addKey(name: string, secret?: string) {
    const id = `k${++this.n}`;
    const now = Date.now();
    const k: FakeKey = { id, name, secret: secret ?? `sk-${id}`, models: [], cap: 0, start: now, reset: now + 3650 * 86_400_000, window: "3650d", calls: 0 };
    this.keys.set(id, k);
    return { ...k };
  }
  async setModels(id: string, models: string[]) {
    this.keys.get(id)!.models = [...models];
  }
  async setCostLimit(id: string, window: string, usd: number) {
    const k = this.keys.get(id)!;
    if (k.window !== window) {
      k.start = Date.now();
      k.reset = k.start + 3650 * 86_400_000;
      k.window = window;
    }
    k.cap = usd;
  }
  async limitStatus(secret: string) {
    const k = [...this.keys.values()].find((x) => x.secret === secret);
    if (!k) throw new Error("no such key");
    const used = this.used(k);
    return {
      limited: k.cap > 0,
      key: k.name,
      limit: {
        period: "days",
        days: 3650,
        start: new Date(k.start).toISOString(),
        reset: new Date(k.reset).toISOString(),
        costLimit: k.cap,
        cost: used,
        costLeft: Math.max(k.cap - used, 0),
        calls: k.calls,
        spent: used >= k.cap,
      },
    } as never;
  }
  used(k: FakeKey): number {
    let nanos = 0;
    for (const r of this.rows) {
      if (r.callerKeyId !== k.id) continue;
      if (Date.parse(r.t) < k.start) continue;
      nanos += costNanos(BASE, { input: r.in, output: r.out, cacheRead: 0, cacheWrite: 0 });
    }
    return nanos / 1_000_000_000;
  }
  /**
   * One model call, refused with 429 when it cannot be afforded.
   *
   * Magpie reserves before the upstream call (internal/budget/budget.go
   * `Reserve`): a request whose estimated cost would take `used` past the cap is
   * refused, not admitted and then found to be over. Modelling that here is what
   * makes "the last deposit restores service" a real assertion.
   */
  call(keyId: string, input: number, output: number): { status: number } {
    const k = this.keys.get(keyId)!;
    const estimate = costNanos(BASE, { input, output, cacheRead: 0, cacheWrite: 0 }) / 1_000_000_000;
    if (k.cap > 0 && this.used(k) + estimate > k.cap) return { status: 429 };
    const row = { callerKeyId: keyId, t: new Date().toISOString(), in: input, out: output };
    this.rows.push(row);
    appendFileSync(this.log, JSON.stringify({ ...row, provider: "lab", model: "lab-model", cache_read: 0, cache_write: 0, status: 200 }) + "\n");
    k.calls += 1;
    return { status: 200 };
  }
  metas() {
    return [{ id: MODEL, price: BASE }];
  }
  version(): string {
    return priceSnapshot(this.metas(), [MODEL])!.version;
  }
  async removeKey(id: string) {
    this.keys.delete(id);
  }
  async rotateKey(id: string) {
    const k = this.keys.get(id);
    if (!k) return null;
    k.secret = `${k.secret}-rotated`;
    return k.secret;
  }
  async setQuotasOff() {}
  nativeProviderIds() {
    return new Set(["lab"]);
  }
  remoteProviderIds() {
    return new Set<string>();
  }
  async catalogModels() {
    return this.metas();
  }
}

let dir: string;
let fake: FakeMagpie;
let ledger: Ledger;
let log: string;
let provisioner: Provisioner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phase7-e2e-"));
  process.chdir(dir);
  log = join(dir, "usage.jsonl");
  writeFileSync(log, "");
  fake = new FakeMagpie(log);
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  provisioner = new Provisioner(fake as never, {
    ledger,
    prices: async (models) => priceSnapshot(fake.metas(), models),
    usageLog: () => log,
    drainMs: 0,
  });
});

/** The credit sink the wallet uses: the ledger for booking, the provisioner for applying. */
function sink(): CreditSink {
  return {
    depositIntent: (input) => {
      const r = ledger.depositIntent({
        id: input.id,
        consumerId: input.consumerId,
        amountNanos: input.amountNanos,
        source: input.source,
        fundsClass: input.fundsClass,
        chainId: input.chainId,
        assetId: input.assetId,
      });
      return { created: r.created };
    },
    applyDeposit: async (input) => {
      await provisioner.applyChainDeposit(input);
    },
    freezeConsumer: async (consumerId, reason) => {
      ledger.setPaused(consumerId, `chain-reorg: ${reason}`);
      await provisioner.pauseForChain(consumerId, reason);
    },
    balance: (consumerId) => {
      const b = ledger.balance(consumerId);
      return { depositedNanos: b.depositedNanos, consumedNanos: b.consumedNanos, balanceNanos: b.balanceNanos };
    },
  };
}

/** A minimal chain that returns one Transfer for a signed intent. */
function fakeChain(opts: { chainId: number; contract: string; height?: number }) {
  const height = opts.height ?? 30;
  let head = height;
  const blocks = Array.from({ length: 400 }, (_, i) => ({
    number: `0x${i.toString(16)}`,
    hash: `0x${keccak256(`${opts.chainId}:${i}`).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`,
    parentHash: `0x${keccak256(`${opts.chainId}:${Math.max(0, i - 1)}`).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`,
    timestamp: "0x1",
  }));
  const topic = `0x${toHex(keccak256("Transfer(address,address,uint256)"))}`;
  const logs: {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    blockHash: string;
    transactionHash: string;
    logIndex: string;
  }[] = [];
  let finalized = head;
  const addTransfer = (from: string, to: string, amount: bigint) => {
    head += 1;
    logs.push({
      address: opts.contract,
      topics: [topic, `0x${from.slice(2).padStart(64, "0")}`, `0x${to.slice(2).padStart(64, "0")}`],
      data: `0x${amount.toString(16).padStart(64, "0")}`,
      blockNumber: `0x${head.toString(16)}`,
      blockHash: blocks[head]!.hash,
      transactionHash: `0x${keccak256(`${head}:${logs.length}`).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`,
      logIndex: "0x0",
    });
    return logs[logs.length - 1]!;
  };
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    const reply = (r: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: r }));
    switch (body.method) {
      case "eth_chainId":
        return reply(`0x${opts.chainId.toString(16)}`);
      case "eth_blockNumber":
        return reply(`0x${head.toString(16)}`);
      case "eth_getBlockByNumber": {
        const tag = body.params[0] as string;
        if (tag === "finalized") return reply(blocks[finalized]);
        if (tag === "latest" || tag === "safe") return reply(blocks[head]);
        return reply(blocks[Number(BigInt(tag))]);
      }
      case "eth_getLogs": {
        const f = body.params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        return reply(logs.filter((l) => {
          const n = Number(BigInt(l.blockNumber));
          return n >= from && n <= to;
        }));
      }
      case "eth_getTransactionReceipt": {
        const l = logs.find((x) => x.transactionHash === body.params[0]);
        if (!l) return reply(null);
        return reply({ transactionHash: l.transactionHash, blockNumber: l.blockNumber, blockHash: l.blockHash, status: "0x1", logs: [l] });
      }
      case "eth_call":
        return reply(`0x${(6).toString(16).padStart(64, "0")}`);
      default:
        return reply(null);
    }
  }) as unknown as typeof fetch;
  return { addTransfer, fetchImpl, mine: (n = 1) => (head += n), finalize: (n: number) => (finalized = n) };
}

function walletFor(chain: ReturnType<typeof fakeChain>, chainId: number, contract: string) {
  const registry = defaultRegistry();
  const asset = registry.registerTestAsset({
    chainId,
    contractAddress: contract,
    symbol: "tMOCK6",
    name: "Mock Test Dollar",
    decimals: 6,
    nanosPerToken: String(usdToNanos(1)),
    pricingNote: "1 tMOCK6 = 1 test USD",
  });
  const network = { ...registry.requireEnabledNetwork(chainId), finality: { mode: "confirmations" as const, confirmations: 2, reorgDepth: 2, rationale: "test" } };
  const store = new ChainStore(join(dir, `chain-${chainId}.sqlite`));
  const credit = sink();
  const watcher = new ChainWatcher({ network, registry, store, ledger: credit, initialLookback: 400 });
  (watcher as unknown as { client: InstanceType<typeof EvmClient> }).client = new EvmClient({
    chainId,
    endpoints: ["http://fake"],
    fetchImpl: chain.fetchImpl,
  });
  const wallet = new Wallet({
    credit,
    registry,
    store,
    initialLookback: 400,
    makeWatcher: () => watcher,
  });
  return { registry, asset, network, store, watcher, wallet, credit };
}

describe("chain deposit → ledger → Gateway Key", () => {
  test("a finalized deposit raises the cap, admits calls, and 429s when spent", async () => {
    const view = await provisioner.ensure("alice", { models: [MODEL], capUsd: 0.0001 });
    expect(view.keyId).toBeTruthy();
    // The opening credit is $0.0001, which is one 10/10-token call at this price.
    const opening = ledger.balance("alice");
    expect(opening.balanceNanos).toBe(usdToNanos(0.0001));

    const chain = fakeChain({ chainId: 97, contract: CONTRACT });
    const ctx = walletFor(chain, 97, CONTRACT);
    ctx.wallet.setReceivingAddress("provider-a", 97, RECIPIENT);

    // 2 whole mock tokens = $2 of test credit.
    const request = ctx.wallet.requestIntent({ providerId: "provider-a", consumerId: "alice", chainId: 97, assetId: ctx.asset.assetId, amountRaw: "2000000" });
    const signature = signDigest(request.digest);
    const signed = ctx.wallet.signIntent({ invoiceId: request.intent.invoiceId, signature, payerAddress: PAYER });
    expect(signed.intent.payerAddress).toBe(PAYER);

    chain.addTransfer(PAYER, RECIPIENT, 2_000_000n);
    chain.mine(2);
    const scan = await ctx.watcher.scan();
    expect(scan.credited).toBe(1);

    const balance = ledger.balance("alice");
    // Opening $0.0001 + $2 credited, floor-gridded into the cap.
    expect(nanosToUsd(balance.depositedNanos)).toBeCloseTo(2.0001, 6);
    const rec = provisioner.find("alice")!;
    expect(rec.capUsd).toBeGreaterThanOrEqual(2);
    expect(rec.pending).toBeNull();

    // The native key now admits a call it would have refused before: at
    // $1/$2 per 1M tokens, 400 in + 400 out costs $0.0012, which the opening
    // $0.0001 cap could never cover.
    // The fake charges each call from the *same* start instant, so the first
    // call's cost is measured against the cap the deposit just set.
    expect(ledger.balance("alice").depositedNanos).toBeGreaterThan(usdToNanos(2));
    const capBefore = provisioner.find("alice")!.capUsd;
    expect(capBefore).toBeGreaterThan(1.9);
    const before = fake.call(rec.keyId!, 400, 400);
    expect(before.status).toBe(200);
    // Spend past the cap with real-sized calls: 500k in + 500k out costs $1.50,
    // so the second one cannot fit in what is left of $2.0001 and Magpie 429s.
    const first = fake.call(rec.keyId!, 500_000, 500_000);
    expect(first.status).toBe(200);
    expect(fake.used(fake.keys.get(rec.keyId!)!)).toBeCloseTo(1.5012, 6);
    // $2.0001 - $1.5012 = $0.4989 left, and the next call needs $1.50.
    expect(fake.call(rec.keyId!, 500_000, 500_000).status).toBe(429);
    // A call that does fit is still admitted.
    expect(fake.call(rec.keyId!, 10, 10).status).toBe(200);

    // A second deposit on the same key restores service.
    const request2 = ctx.wallet.requestIntent({ providerId: "provider-a", consumerId: "alice", chainId: 97, assetId: ctx.asset.assetId, amountRaw: "5000000" });
    ctx.wallet.signIntent({ invoiceId: request2.intent.invoiceId, signature: signDigest(request2.digest), payerAddress: PAYER });
    chain.addTransfer(PAYER, RECIPIENT, 5_000_000n);
    chain.mine(2);
    const scan2 = await ctx.watcher.scan();
    expect(scan2.credited).toBe(1);
    const after = fake.call(rec.keyId!, 10, 10);
    expect(after.status).toBe(200);
    ctx.store.close();
  });

  test("a chain deposit for a paused consumer is booked and spent by a reissue", async () => {
    await provisioner.ensure("bob", { models: [MODEL], capUsd: 0.0001 });
    const rec = provisioner.find("bob")!;
    // A 10/10 call costs $0.00003, which the opening $0.0001 cap covers, so the
    // account ends with a small positive balance and no overdraft.
    fake.call(rec.keyId!, 10, 10);
    await provisioner.pauseForChain("bob", "test: the consumer was frozen");
    expect(provisioner.find("bob")!.paused).not.toBeNull();

    const chain = fakeChain({ chainId: 84532, contract: "0x00000000000000000000000000000000000000ff" });
    const ctx = walletFor(chain, 84532, "0x00000000000000000000000000000000000000ff");
    ctx.wallet.setReceivingAddress("provider-a", 84532, RECIPIENT);
    const req = ctx.wallet.requestIntent({ providerId: "provider-a", consumerId: "bob", chainId: 84532, assetId: ctx.asset.assetId, amountRaw: "3000000" });
    ctx.wallet.signIntent({ invoiceId: req.intent.invoiceId, signature: signDigest(req.digest), payerAddress: PAYER });
    chain.addTransfer(PAYER, RECIPIENT, 3_000_000n);
    chain.mine(2);
    const scan = await ctx.watcher.scan();
    expect(scan.credited).toBe(1);
    // Booked, not applied to a key: there is no key.
    expect(nanosToUsd(ledger.balance("bob").depositedNanos)).toBeCloseTo(3.0001, 6);
    expect(provisioner.find("bob")!.paused).not.toBeNull();

    // Reissue spends the recorded balance: $3 test credit plus what the opening
    // deposit left, minus the one call.
    const reissued = await provisioner.reissue("bob", { acceptPriceVersion: fake.version() });
    expect(reissued.paused).toBeNull();
    expect(reissued.capUsd).toBeGreaterThanOrEqual(3);
    expect(ledger.balance("bob").overdraftNanos).toBe(0);
    ctx.store.close();
  });

  test("the same chain event replayed cannot raise the cap twice", async () => {
    await provisioner.ensure("carol", { models: [MODEL], capUsd: 0.0001 });
    const chain = fakeChain({ chainId: 97, contract: CONTRACT });
    const ctx = walletFor(chain, 97, CONTRACT);
    ctx.wallet.setReceivingAddress("provider-a", 97, RECIPIENT);
    const req = ctx.wallet.requestIntent({ providerId: "provider-a", consumerId: "carol", chainId: 97, assetId: ctx.asset.assetId, amountRaw: "1000000" });
    ctx.wallet.signIntent({ invoiceId: req.intent.invoiceId, signature: signDigest(req.digest), payerAddress: PAYER });
    chain.addTransfer(PAYER, RECIPIENT, 1_000_000n);
    chain.mine(2);
    await ctx.watcher.scan();
    const capAfterFirst = provisioner.find("carol")!.capUsd;
    const balanceAfterFirst = ledger.balance("carol").depositedNanos;

    // A full rescan from block 0, and a direct replay of the ledger booking.
    ctx.store.rewindCursor(97, 0, "test: deliberate replay");
    await ctx.watcher.scan();
    const event = ctx.store.eventsForChain(97)[0]!;
    await ctx.watcher.creditFinalized();
    await provisioner.applyChainDeposit({ id: event.depositId!, consumerId: "carol", amountNanos: usdToNanos(1) });

    expect(ledger.balance("carol").depositedNanos).toBe(balanceAfterFirst);
    expect(provisioner.find("carol")!.capUsd).toBe(capAfterFirst);
    ctx.store.close();
  });

  test("a reverted credit freezes the consumer and does not adjust the balance", async () => {
    await provisioner.ensure("dave", { models: [MODEL], capUsd: 0.0001 });
    const chain = fakeChain({ chainId: 97, contract: CONTRACT });
    const ctx = walletFor(chain, 97, CONTRACT);
    ctx.wallet.setReceivingAddress("provider-a", 97, RECIPIENT);
    const req = ctx.wallet.requestIntent({ providerId: "provider-a", consumerId: "dave", chainId: 97, assetId: ctx.asset.assetId, amountRaw: "1000000" });
    ctx.wallet.signIntent({ invoiceId: req.intent.invoiceId, signature: signDigest(req.digest), payerAddress: PAYER });
    chain.addTransfer(PAYER, RECIPIENT, 1_000_000n);
    chain.mine(2);
    await ctx.watcher.scan();
    const deposited = ledger.balance("dave").depositedNanos;
    const event = ctx.store.eventsForChain(97)[0]!;
    expect(event.status).toBe("credited");

    // The chain reorganises: the credited block is replaced.
    ctx.store.setEventStatus(event.id, "reverted", "test: the block hash moved");
    await sink().freezeConsumer("dave", "test: a credited deposit was reverted");
    expect(ledger.balance("dave").depositedNanos).toBe(deposited); // not adjusted
    expect(ledger.account("dave")!.status).toBe("paused");
    expect(provisioner.find("dave")!.paused).not.toBeNull();
    ctx.store.close();
  });

  test("an unclaimed transfer never reaches the ledger", async () => {
    await provisioner.ensure("erin", { models: [MODEL], capUsd: 0.0001 });
    const chain = fakeChain({ chainId: 97, contract: CONTRACT });
    const ctx = walletFor(chain, 97, CONTRACT);
    ctx.wallet.setReceivingAddress("provider-a", 97, RECIPIENT);
    // No intent at all: a stranger pays the provider's address.
    chain.addTransfer("0x2b5ad5c4795c026514f8317c7a215e218dccd6cf", RECIPIENT, 1_000_000n);
    chain.mine(2);
    const scan = await ctx.watcher.scan();
    expect(scan.unclaimed).toBe(1);
    expect(scan.credited).toBe(0);
    expect(nanosToUsd(ledger.balance("erin").depositedNanos)).toBeCloseTo(0.0001, 6);
    ctx.store.close();
  });

  test("two chains credit the same consumer independently", async () => {
    await provisioner.ensure("frank", { models: [MODEL], capUsd: 0.0001 });
    const bsc = fakeChain({ chainId: 97, contract: CONTRACT });
    const base = fakeChain({ chainId: 84532, contract: "0x00000000000000000000000000000000000000ff" });
    const a = walletFor(bsc, 97, CONTRACT);
    const b = walletFor(base, 84532, "0x00000000000000000000000000000000000000ff");
    a.wallet.setReceivingAddress("provider-a", 97, RECIPIENT);
    b.wallet.setReceivingAddress("provider-a", 84532, RECIPIENT);
    const ra = a.wallet.requestIntent({ providerId: "provider-a", consumerId: "frank", chainId: 97, assetId: a.asset.assetId, amountRaw: "1000000" });
    const rb = b.wallet.requestIntent({ providerId: "provider-a", consumerId: "frank", chainId: 84532, assetId: b.asset.assetId, amountRaw: "2000000" });
    a.wallet.signIntent({ invoiceId: ra.intent.invoiceId, signature: signDigest(ra.digest), payerAddress: PAYER });
    b.wallet.signIntent({ invoiceId: rb.intent.invoiceId, signature: signDigest(rb.digest), payerAddress: PAYER });
    bsc.addTransfer(PAYER, RECIPIENT, 1_000_000n);
    base.addTransfer(PAYER, RECIPIENT, 2_000_000n);
    bsc.mine(2);
    base.mine(2);
    const [sa, sb] = await Promise.all([a.watcher.scan(), b.watcher.scan()]);
    expect(sa.credited).toBe(1);
    expect(sb.credited).toBe(1);
    // 0.0001 opening + 1 + 2 test USD, and the cap reflects all of it.
    expect(nanosToUsd(ledger.balance("frank").depositedNanos)).toBeCloseTo(3.0001, 6);
    expect(provisioner.find("frank")!.capUsd).toBeGreaterThanOrEqual(3);
    a.store.close();
    b.store.close();
  });

  test("one chain failing does not stop the other's credit", async () => {
    await provisioner.ensure("gina", { models: [MODEL], capUsd: 0.0001 });
    const bsc = fakeChain({ chainId: 97, contract: CONTRACT });
    const base = fakeChain({ chainId: 84532, contract: "0x00000000000000000000000000000000000000ff" });
    const a = walletFor(bsc, 97, CONTRACT);
    const b = walletFor(base, 84532, "0x00000000000000000000000000000000000000ff");
    a.wallet.setReceivingAddress("provider-a", 97, RECIPIENT);
    b.wallet.setReceivingAddress("provider-a", 84532, RECIPIENT);
    const ra = a.wallet.requestIntent({ providerId: "provider-a", consumerId: "gina", chainId: 97, assetId: a.asset.assetId, amountRaw: "1000000" });
    const rb = b.wallet.requestIntent({ providerId: "provider-a", consumerId: "gina", chainId: 84532, assetId: b.asset.assetId, amountRaw: "1000000" });
    a.wallet.signIntent({ invoiceId: ra.intent.invoiceId, signature: signDigest(ra.digest), payerAddress: PAYER });
    b.wallet.signIntent({ invoiceId: rb.intent.invoiceId, signature: signDigest(rb.digest), payerAddress: PAYER });
    bsc.addTransfer(PAYER, RECIPIENT, 1_000_000n);
    base.addTransfer(PAYER, RECIPIENT, 1_000_000n);
    bsc.mine(2);
    base.mine(2);
    // BSC's endpoint dies.
    (a.watcher as unknown as { client: InstanceType<typeof EvmClient> }).client = new EvmClient({
      chainId: 97,
      endpoints: ["http://dead"],
      fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    });
    const sa = await a.watcher.scan();
    const sb = await b.watcher.scan();
    expect(sa.partial).toBe(true);
    expect(sb.credited).toBe(1);
    expect(nanosToUsd(ledger.balance("gina").depositedNanos)).toBeCloseTo(1.0001, 6);
    a.store.close();
    b.store.close();
  });
});

/** Signs a 32-byte digest with the fixed test key, low-s and with the right parity. */
function signDigest(digest: string): string {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
  const mod = (a: bigint, m: bigint = P) => ((a % m) + m) % m;
  const inv = (a: bigint, m: bigint) => {
    let b = mod(a, m), e = m - 2n, o = 1n;
    while (e > 0n) { if (e & 1n) o = (o * b) % m; b = (b * b) % m; e >>= 1n; }
    return o;
  };
  type Pt = { x: bigint; y: bigint } | null;
  const add = (a: Pt, b: Pt): Pt => {
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
  };
  const mul = (p: Pt, k: bigint): Pt => {
    let n = mod(k, N), o: Pt = null, a = p;
    while (n > 0n) { if (n & 1n) o = add(o, a); a = add(a, a); n >>= 1n; }
    return o;
  };
  const z = BigInt(digest);
  let k = mod(BigInt(`0x${toHex(keccak256(`1:${digest}`))}`), N);
  if (k === 0n) k = 1n;
  const R = mul({ x: GX, y: GY }, k)!;
  const r = mod(R.x, N);
  let s = mod(inv(k, N) * (z + r * 1n), N);
  let parity = Number(R.y & 1n);
  if (s > N / 2n) { s = N - s; parity ^= 1; }
  const out = new Uint8Array(65);
  out.set(fromHex(r.toString(16).padStart(64, "0")), 0);
  out.set(fromHex(s.toString(16).padStart(64, "0")), 32);
  out[64] = parity + 27;
  return `0x${toHex(out)}`;
}
