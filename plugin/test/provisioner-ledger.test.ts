import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Provisioner } from "../src/provisioner.ts";
import { Ledger } from "../src/ledger.ts";
import { costNanos, priceSnapshot, usdToNanos, type PriceParts } from "../src/pricing.ts";

const MODEL = "lab/lab-model";
const BASE: PriceParts = { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 };

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

interface UsageRow {
  t: string;
  callerKeyId: string;
  provider: string;
  model: string;
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
}

/** A fake with the observable contract of Magpie 0.1.2038's key/limit path. */
class FakeMagpie {
  constructor(private log: string) {}
  keys = new Map<string, FakeKey>();
  removed: string[] = [];
  quotaOff: string[] = [];
  price: PriceParts | null = BASE;
  rows: UsageRow[] = [];
  failStatusOnce = false;
  failStatusAfterSetLimit = false;
  private n = 0;

  keyByName(name: string) {
    for (const k of this.keys.values()) if (k.name === name) return this.copy(k);
    return undefined;
  }
  keyById(id: string) {
    const k = this.keys.get(id);
    return k ? this.copy(k) : undefined;
  }
  private copy(k: FakeKey) {
    return { ...k, limit: { period: "days", days: 3650, cost: k.cap } };
  }
  async addKey(name: string, secret?: string) {
    if (secret && [...this.keys.values()].some((k) => k.secret === secret)) throw new Error("another key has this secret");
    const id = `k${++this.n}`;
    const now = Date.now();
    const k: FakeKey = {
      id,
      name,
      secret: secret ?? `sk-test-${id}-secret`,
      models: [],
      cap: 0,
      start: now,
      reset: now + 3650 * 86_400_000,
      window: "3650d",
      calls: 0,
    };
    this.keys.set(id, k);
    return { ...this.copy(k), secret: k.secret };
  }
  async setModels(id: string, models: string[]) {
    this.keys.get(id)!.models = [...models];
  }
  async setQuotasOff(id: string) {
    this.quotaOff.push(id);
  }
  async removeKey(id: string) {
    this.removed.push(id);
    this.keys.delete(id);
  }
  async setCostLimit(id: string, window: string, usd: number) {
    const k = this.keys.get(id)!;
    if (k.window !== window) {
      // Magpie's sinceOf() starts a new cycle when the period/cycle changes.
      k.start = Date.now();
      k.reset = k.start + 3650 * 86_400_000;
      k.window = window;
    }
    k.cap = usd;
    if (this.failStatusAfterSetLimit) {
      this.failStatusAfterSetLimit = false;
      this.failStatusOnce = true;
    }
  }
  async limitStatus(secret: string) {
    if (this.failStatusOnce) {
      this.failStatusOnce = false;
      throw new Error("read-back unavailable");
    }
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
    if (!this.price) return 0;
    let nanos = 0;
    for (const r of this.rows) {
      if (r.callerKeyId !== k.id) continue;
      if (Date.parse(r.t) < k.start) continue;
      nanos += costNanos(this.price, {
        input: r.in,
        output: r.out,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
      });
    }
    return nanos / 1_000_000_000;
  }
  addUsage(keyId: string, input: number, output: number, at = new Date().toISOString()) {
    const row = {
      route_id: this.rows.length + 1,
      t: at,
      callerKeyId: keyId,
      callerKeyName: this.keys.get(keyId)?.name ?? "lab",
      provider: "lab",
      model: "lab-model",
      in: input,
      out: output,
      cache_read: 0,
      cache_write: 0,
      status: 200,
    };
    this.rows.push(row);
    appendFileSync(this.log, JSON.stringify(row) + "\n");
    const k = this.keys.get(keyId)!;
    k.calls += 1;
  }
  rollWindow(keyId: string) {
    const k = this.keys.get(keyId)!;
    k.start = Date.now() + 5000;
    k.reset = k.start + 3650 * 86_400_000;
  }
  setPrice(p: PriceParts | null) {
    this.price = p;
  }
  metas() {
    return [{ id: MODEL, price: this.price }];
  }
  version(): string {
    return priceSnapshot(this.metas(), [MODEL])!.version;
  }
}

let dir: string;
let fake: FakeMagpie;
let ledger: Ledger;
let log: string;
let p: Provisioner;

function makeProvisioner(delay = 0): Provisioner {
  return new Provisioner(fake as never, {
    ledger,
    prices: async (models) => priceSnapshot(fake.metas(), models),
    usageLog: () => log,
    drainMs: delay,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-prov-"));
  process.chdir(dir);
  log = join(dir, "usage.jsonl");
  writeFileSync(log, "");
  fake = new FakeMagpie(log);
  ledger = new Ledger(join(dir, "ledger.sqlite"));
  p = makeProvisioner();
});

describe("ledger-backed issuance", () => {
  test("a new key gets 3650d, an opening ledger balance and a price version", async () => {
    const v = await p.ensure("alice", { models: [MODEL], capUsd: 1 });
    expect(v.window).toBe("3650d");
    expect(v.capUsd).toBe(1);
    expect(v.priceVersion).toBe(fake.version());
    expect(v.ledger?.balanceUsd).toBe(1);
    expect(v.ledger?.depositedUsd).toBe(1);
    expect(v.ledger?.consumedUsd).toBe(0);
    expect(fake.keys.get(v.keyId)!.cap).toBe(1);
  });

  test("an unpriced model creates no key at all", async () => {
    fake.setPrice(null);
    await expect(p.ensure("bob", { models: [MODEL], capUsd: 1 })).rejects.toThrow(/complete effective price/);
    expect(fake.keys.size).toBe(0);
    expect(p.find("bob")).toBeUndefined();
  });

  test("a top-up is native used + ledger balance; a replay is a no-op", async () => {
    const v = await p.ensure("carol", { models: [MODEL], capUsd: 1 });
    // $0.42 at 1/2 per 1M: 300k input, 60k output.
    fake.addUsage(v.keyId, 300_000, 60_000);
    const after = await p.topUp("carol", 1, "dep-1");
    expect(after.capUsd).toBe(2);
    expect(after.usedUsd).toBeCloseTo(0.42, 9);
    expect(after.creditedUsd).toBe(1);
    expect(after.ledger?.balanceUsd).toBeCloseTo(1.58, 9);
    const replay = await p.topUp("carol", 1, "dep-1");
    expect(replay.capUsd).toBe(2);
    expect(replay.creditedUsd).toBe(1);
    expect(fake.keys.get(v.keyId)!.cap).toBe(2);
  });

  test("two deposits racing are both applied and serialized", async () => {
    const v = await p.ensure("dave", { models: [MODEL], capUsd: 1 });
    const [a, b] = await Promise.all([p.topUp("dave", 0.5, "a"), p.topUp("dave", 0.5, "b")]);
    expect([a.capUsd, b.capUsd].sort()).toEqual([1.5, 2]);
    expect(ledger.balance("dave").balanceNanos).toBe(usdToNanos(2));
    expect(ledger.depositsFor("dave").filter((d) => d.status === "applied")).toHaveLength(3); // opening + a + b
    expect(fake.keys.get(v.keyId)!.cap).toBe(2);
  });

  test("a top-up below an existing overdraft leaves the key spent", async () => {
    const v = await p.ensure("erin", { models: [MODEL], capUsd: 0.5 });
    fake.addUsage(v.keyId, 400_000, 100_000); // $0.6
    const after = await p.topUp("erin", 0.05, "dep");
    expect(after.capUsd).toBe(0.55);
    expect(after.spent).toBe(true);
    expect(after.ledger?.overdraftUsd).toBeCloseTo(0.05, 9);
  });
});


  test("a key is bound to the accepted quote's price version", async () => {
    const v = await p.ensure("jane", {
      models: [MODEL],
      capUsd: 1,
      quoteHash: "a".repeat(64),
      quotePriceVersion: fake.version(),
    });
    expect(v.acceptedQuoteHash).toBe("a".repeat(64));
    expect(v.priceVersion).toBe(fake.version());
    await expect(
      p.ensure("kate", { models: [MODEL], capUsd: 1, quoteHash: "b".repeat(64), quotePriceVersion: "0".repeat(64) }),
    ).rejects.toThrow(/accepted quote is bound/);
    expect(fake.keys.has(p.find("kate")?.keyId ?? "")).toBe(false);
  });


  test("a pre-ledger consumer is migrated once, not by replaying its old usage log", async () => {
    const v = await p.ensure("legacy", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 200_000, 50_000); // $0.3
    const before = await p.status("legacy");
    expect(before.ledger?.consumedUsd).toBeCloseTo(0.3, 9);
    expect(before.ledger?.balanceUsd).toBeCloseTo(0.7, 9);

    // Simulate the ledger file being lost/restored without it, while the old
    // consumers.json and usage.jsonl remain. The migration adjustment must be
    // the only representation of the old call.
    ledger.close();
    for (const f of readdirSync(dir)) {
      if (f.startsWith("ledger.sqlite")) unlinkSync(join(dir, f));
    }
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    const restarted = makeProvisioner();
    const after = await restarted.status("legacy");
    expect(after.paused).toBeNull();
    expect(after.ledger?.consumedUsd).toBeCloseTo(0.3, 9);
    expect(after.ledger?.balanceUsd).toBeCloseTo(0.7, 9);
    expect(ledger.windowConsumption(ledger.openWindowFor("legacy")!.id)).toBe(usdToNanos(0.3));
  });


  test("an overdraft can be repaid while paused, and still-insufficient credit issues no key", async () => {
    const v = await p.ensure("olga", { models: [MODEL], capUsd: 0.5 });
    fake.addUsage(v.keyId, 400_000, 100_000); // $0.6, already an overdraft
    fake.rollWindow(v.keyId);
    const paused = await p.status("olga");
    expect(paused.paused?.reason).toBe("window-rollover");
    expect(paused.ledger?.overdraftUsd).toBeCloseTo(0.1, 9);

    const stillShort = await p.topUp("olga", 0.05, "repay-1");
    expect(stillShort.paused?.reason).toBe("window-rollover");
    expect(stillShort.ledger?.overdraftUsd).toBeCloseTo(0.05, 9);
    const noKey = await p.reissue("olga");
    expect(noKey.paused?.reason).toBe("overdraft");
    expect(fake.keys.size).toBe(0);

    const enough = await p.topUp("olga", 0.1, "repay-2");
    expect(enough.ledger?.balanceUsd).toBeCloseTo(0.05, 9);
    const reissued = await p.reissue("olga");
    expect(reissued.paused).toBeNull();
    expect(reissued.capUsd).toBe(0.05);
    expect(fake.keys.size).toBe(1);
  });


  test("removing a model's price pauses the active key; the key is not left unpriced", async () => {
    const v = await p.ensure("nina", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 100_000, 50_000);
    fake.setPrice(null);
    const paused = await p.status("nina");
    expect(paused.paused?.reason).toBe("unpriced");
    expect(paused.paused?.enforced).toBe(true);
    expect(fake.keys.has(v.keyId)).toBe(false);
    await expect(p.reissue("nina")).rejects.toThrow(/complete effective price/);
  });


  test("a peak price pauses the active key through the existing unpriced path", async () => {
    const v = await p.ensure("nina-peak", { models: [MODEL], capUsd: 1 });
    fake.setPrice({ ...BASE, peak: "deepseek" } as never);
    const paused = await p.status("nina-peak");
    expect(paused.paused?.reason).toBe("unpriced");
    expect(paused.paused?.enforced).toBe(true);
    expect(fake.keys.has(v.keyId)).toBe(false);
    await expect(p.reissue("nina-peak")).rejects.toThrow(/complete effective price/);
  });

  test("a tier-level peak pauses, blocks top-up and blocks reissue", async () => {
    const v = await p.ensure("nina-tier", { models: [MODEL], capUsd: 1 });
    fake.setPrice({ ...BASE, tiers: [{ above: 1000, ...BASE, peak: "deepseek" }] } as never);
    const paused = await p.status("nina-tier");
    expect(paused.paused?.reason).toBe("unpriced");
    expect(paused.paused?.enforced).toBe(true);
    expect(fake.keys.has(v.keyId)).toBe(false);
    const topped = await p.topUp("nina-tier", 1, "tier-dep");
    expect(topped.paused?.reason).toBe("unpriced");
    expect(fake.keys.size).toBe(0);
    await expect(p.reissue("nina-tier")).rejects.toThrow(/complete effective price/);
  });

  test("a key deleted outside the plugin pauses instead of looking usable", async () => {
    const v = await p.ensure("peter", { models: [MODEL], capUsd: 1 });
    await fake.removeKey(v.keyId);
    const paused = await p.status("peter");
    expect(paused.paused?.reason).toBe("manual");
    expect(paused.paused?.enforced).toBe(true);
    expect(paused.ledger?.balanceUsd).toBe(1);
  });


  test("reissue itself refuses an unaccepted price change, even before a status check", async () => {
    const v = await p.ensure("quinn", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 100_000, 50_000);
    fake.setPrice({ input: 2, output: 4, cache_read: 0.2, cache_write: 0.4 });
    await expect(p.reissue("quinn")).rejects.toThrow(/bound to price version/);
    const next = await p.reissue("quinn", { acceptPriceVersion: fake.version() });
    expect(next.capUsd).toBe(0.8);
    expect(next.ledger?.consumedUsd).toBeCloseTo(0.2, 9);
  });


  test("a wildcard whitelist is priced from its actual matching models", async () => {
    const v = await p.ensure("wild", { models: ["lab/*"], capUsd: 1 });
    expect(v.models).toEqual(["lab/*"]);
    expect(v.ledger?.balanceUsd).toBe(1);
    fake.addUsage(v.keyId, 100_000, 50_000);
    const after = await p.topUp("wild", 0.5, "wild-dep");
    expect(after.capUsd).toBe(1.5); // used 0.2 + balance (0.8 + 0.5)
    expect(after.ledger?.balanceUsd).toBeCloseTo(1.3, 9);
    expect(after.ledger?.consumedUsd).toBeCloseTo(0.2, 9);
  });

describe("price changes and windows", () => {
  test("a price change pauses, and reissue carries old-price consumption, not repriced history", async () => {
    const first = await p.ensure("frank", { models: [MODEL], capUsd: 1 });
    const firstSecret = p.find("frank")!.secret;
    fake.addUsage(first.keyId, 200_000, 50_000); // $0.3 at 1/2
    fake.setPrice({ input: 2, output: 4, cache_read: 0.2, cache_write: 0.4 });
    const paused = await p.status("frank");
    expect(paused.paused?.reason).toBe("price-mismatch");
    expect(fake.keys.has(first.keyId)).toBe(false);

    await expect(p.reissue("frank")).rejects.toThrow(/acceptPriceVersion/);
    const next = await p.reissue("frank", { acceptPriceVersion: fake.version() });
    expect(next.keyId).not.toBe(first.keyId);
    expect(p.find("frank")!.secret).toBe(firstSecret);
    expect(next.capUsd).toBe(0.7);
    expect(next.ledger?.consumedUsd).toBeCloseTo(0.3, 9); // old price, not 0.6
    expect(next.ledger?.balanceUsd).toBeCloseTo(0.7, 9);
    expect(fake.keys.get(next.keyId)!.cap).toBe(0.7);
    expect(ledger.account("frank")?.status).toBe("active");
  });

  test("a closed window pauses instead of re-granting the old cap; reissue carries the balance", async () => {
    const first = await p.ensure("gina", { models: [MODEL], capUsd: 1 });
    const firstSecret = p.find("gina")!.secret;
    fake.addUsage(first.keyId, 600_000, 100_000); // $0.8
    fake.rollWindow(first.keyId); // native used is now 0, exactly the lab hazard
    const paused = await p.status("gina");
    expect(paused.paused?.reason).toBe("window-rollover");
    expect(paused.paused?.enforced).toBe(true);
    expect(fake.keys.has(first.keyId)).toBe(false);

    const next = await p.reissue("gina");
    expect(p.find("gina")!.secret).toBe(firstSecret);
    expect(next.capUsd).toBe(0.2); // not 1.0
    expect(next.ledger?.balanceUsd).toBe(0.2);
    expect(next.ledger?.consumedUsd).toBe(0.8);

    fake.addUsage(next.keyId, 150_000, 25_000); // $0.2, spends the rest
    fake.rollWindow(next.keyId);
    const exhausted = await p.status("gina");
    expect(exhausted.paused?.reason).toBe("window-rollover");
    const noKey = await p.reissue("gina");
    expect(noKey.paused?.reason).toBe("dust");
    expect(fake.keys.size).toBe(0);
  });
});

describe("crash and idempotency", () => {
  test("a cap written but not committed is reconciled exactly once, never double-credited", async () => {
    const v = await p.ensure("hank", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 100_000, 50_000); // $0.2
    // Magpie applies the cap, then the read-back fails: the local commit must
    // not happen and the intent must remain, exactly as on a crash.
    fake.failStatusAfterSetLimit = true;
    await expect(p.topUp("hank", 1, "dep-crash")).rejects.toThrow(/read-back unavailable/);
    expect(p.find("hank")!.pending).not.toBeNull();
    expect(p.find("hank")!.creditedUsd).toBe(0);
    expect(ledger.deposit("dep-crash")?.status).toBe("intent");
    expect(fake.keys.get(v.keyId)!.cap).toBe(2);

    // Restart: a fresh provisioner and the same ledger. reconcile() sees the cap
    // and books the deposit once.
    const restarted = makeProvisioner();
    const view = await restarted.status("hank");
    expect(view.capUsd).toBe(2);
    expect(view.creditedUsd).toBe(1);
    expect(view.pending).toBe(false);
    expect(view.ledger?.balanceUsd).toBeCloseTo(1.8, 9);
    expect(ledger.deposit("dep-crash")?.status).toBe("applied");

    const again = await restarted.status("hank");
    expect(again.creditedUsd).toBe(1);
    expect(again.ledger?.balanceUsd).toBeCloseTo(1.8, 9);
    expect(ledger.depositsFor("hank").filter((d) => d.status === "applied")).toHaveLength(2);
  });

  test("a cap Magpie did not apply is never credited", async () => {
    await p.ensure("iris", { models: [MODEL], capUsd: 1 });
    // The write itself fails before Magpie changes anything.
    const orig = fake.setCostLimit.bind(fake);
    fake.setCostLimit = async () => {
      throw new Error("magpie refused the cap");
    };
    await expect(p.topUp("iris", 1, "dep-no")).rejects.toThrow(/refused the cap/);
    fake.setCostLimit = orig;
    const restarted = makeProvisioner();
    const view = await restarted.status("iris");
    expect(view.capUsd).toBe(1);
    expect(view.creditedUsd).toBe(0);
    expect(view.pending).toBe(false);
    expect(ledger.deposit("dep-no")?.status).toBe("failed");
  });
});
