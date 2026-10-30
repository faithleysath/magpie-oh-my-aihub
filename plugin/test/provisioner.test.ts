import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Provisioner, assertCap } from "../src/provisioner.ts";
import { stateDir, statePath } from "../src/paths.ts";

interface FakeKey {
  id: string;
  name: string;
  secret: string;
  models: string[];
  cap: number;
  used: number;
  calls: number;
}

/** A stand-in for Magpie's CLI and gateway, with the same observable contract. */
class FakeMagpie {
  keys = new Map<string, FakeKey>();
  removed: string[] = [];
  quotaOff: string[] = [];
  setLimitCalls = 0;
  /** runs inside setCostLimit, after the cap is written (simulates live usage) */
  onSetLimit: ((k: FakeKey) => void) | null = null;
  /** make the next read-back report a wrong cap, to exercise the check */
  lieAboutCap: number | null = null;
  failSetModels = false;
  failSetLimit = false;
  delayMs = 0;
  private n = 0;

  keyByName(name: string) {
    for (const k of this.keys.values()) {
      if (k.name === name) return { ...k, secret: k.secret, limit: { period: "day", cost: k.cap } };
    }
    return undefined;
  }
  keyById(id: string) {
    const k = this.keys.get(id);
    return k ? { ...k, limit: { period: "day", cost: k.cap } } : undefined;
  }
  async addKey(name: string) {
    const id = `id${++this.n}`;
    const k: FakeKey = { id, name, secret: `sk-test-${id}-secret`, models: [], cap: 0, used: 0, calls: 0 };
    this.keys.set(id, k);
    return { ...k, limit: null };
  }
  async setModels(id: string, models: string[]) {
    if (this.failSetModels) throw new Error("magpie said no");
    this.keys.get(id)!.models = [...models];
  }
  async setCostLimit(id: string, _window: string, usd: number) {
    this.setLimitCalls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failSetLimit) throw new Error("magpie refused the cap");
    const k = this.keys.get(id)!;
    k.cap = usd;
    this.onSetLimit?.(k);
  }
  async setQuotasOff(id: string) {
    this.quotaOff.push(id);
  }
  async removeKey(id: string) {
    this.removed.push(id);
    this.keys.delete(id);
  }
  async limitStatus(secret: string) {
    const k = [...this.keys.values()].find((x) => x.secret === secret);
    if (!k) throw new Error("no such key");
    const cap = this.lieAboutCap ?? k.cap;
    return {
      limited: cap > 0,
      key: k.name,
      limit: {
        period: "day",
        costLimit: cap,
        cost: k.used,
        costLeft: Math.max(cap - k.used, 0),
        calls: k.calls,
        spent: k.used >= cap,
        reset: "2026-10-31T00:00:00+08:00",
      },
    } as never;
  }
}

let fake: FakeMagpie;
let p: Provisioner;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-test-"));
  process.chdir(dir);
  fake = new FakeMagpie();
  p = new Provisioner(fake as never);
});

const models = ["deepseek/deepseek-flash"];

describe("key creation", () => {
  test("refuses a key without a model whitelist", async () => {
    await expect(p.ensure("alice", { models: [], capUsd: 1 })).rejects.toThrow(/model whitelist/);
    expect(fake.keys.size).toBe(0);
  });

  test("refuses a cap below the grid or not on it", async () => {
    await expect(p.ensure("alice", { models, capUsd: 0.000024 })).rejects.toThrow(/0\.0001/);
    await expect(p.ensure("alice", { models, capUsd: 0.00015 })).rejects.toThrow(/grid/);
    expect(fake.keys.size).toBe(0);
  });

  test("creates a held key: models, cap, quotas off, read back", async () => {
    const v = await p.ensure("alice", { models, capUsd: 1 });
    expect(v.keyName).toBe("ohmyaihub-alice");
    expect(v.capUsd).toBe(1);
    expect(v.spent).toBe(false);
    expect(v.pending).toBe(false);
    expect(fake.quotaOff).toContain(v.keyId);
    expect(fake.keys.get(v.keyId)!.models).toEqual(models);
    expect(fake.keys.get(v.keyId)!.cap).toBe(1);
  });

  test("a key that cannot get its whitelist is deleted, not left behind", async () => {
    fake.failSetModels = true;
    await expect(p.ensure("bob", { models, capUsd: 1 })).rejects.toThrow(/could not provision bob/);
    expect(fake.keys.size).toBe(0);
    expect(fake.removed.length).toBe(1);
    expect(p.find("bob")).toBeUndefined();
    const file = JSON.parse(readFileSync(join(dir, "oh-my-aihub", "consumers.json"), "utf8"));
    expect(file.consumers).toEqual([]);
  });

  test("a key whose cap cannot be written is deleted too", async () => {
    fake.failSetLimit = true;
    await expect(p.ensure("bob", { models, capUsd: 1 })).rejects.toThrow(/could not provision bob/);
    expect(fake.keys.size).toBe(0);
  });

  test("re-ensuring keeps the cap and refreshes the model list", async () => {
    const v = await p.ensure("dave", { models: ["deepseek/a"], capUsd: 2 });
    const again = await p.ensure("dave", { models: ["deepseek/a", "deepseek/b"], capUsd: 1 });
    expect(again.keyId).toBe(v.keyId);
    expect(again.capUsd).toBe(2); // never lowered by a smaller request
    expect(again.models).toEqual(["deepseek/a", "deepseek/b"]);
  });
});

describe("deposits", () => {
  test("a top-up raises the cap and keeps usage", async () => {
    const v = await p.ensure("bob", { models: ["deepseek/*"], capUsd: 0.5 });
    fake.keys.get(v.keyId)!.used = 0.42;
    const after = await p.topUp("bob", 1);
    expect(after.capUsd).toBe(1.5);
    expect(after.usedUsd).toBe(0.42);
    expect(after.creditedUsd).toBe(1);
    expect(fake.removed).toEqual([]);
  });

  test("the same deposit id is applied once", async () => {
    await p.ensure("carol", { models, capUsd: 1 });
    const a = await p.topUp("carol", 0.5, "dep-1");
    const b = await p.topUp("carol", 0.5, "dep-1");
    expect(a.capUsd).toBe(1.5);
    expect(b.capUsd).toBe(1.5); // not 2
    expect(b.creditedUsd).toBe(0.5);
  });

  test("two deposits in parallel are both applied (no lost update)", async () => {
    await p.ensure("erin", { models, capUsd: 1 });
    fake.delayMs = 30;
    const [a, b] = await Promise.all([p.topUp("erin", 0.5, "dep-a"), p.topUp("erin", 0.5, "dep-b")]);
    expect([a.capUsd, b.capUsd].sort()).toEqual([1.5, 2]);
    const rec = p.find("erin")!;
    expect(rec.capUsd).toBe(2);
    expect(rec.creditedUsd).toBe(1);
    expect(rec.deposits.map((d) => d.id).sort()).toEqual(["dep-a", "dep-b"]);
  });

  test("a top-up below the overdraft leaves the key spent", async () => {
    const v = await p.ensure("frank", { models, capUsd: 0.5 });
    fake.keys.get(v.keyId)!.used = 0.6;
    const after = await p.topUp("frank", 0.05);
    expect(after.capUsd).toBe(0.55);
    expect(after.spent).toBe(true);
  });

  test("a read-back that disagrees leaves a pending intent for reconciliation", async () => {
    await p.ensure("gina", { models, capUsd: 1 });
    // The cap is written to Magpie, but the read-back after it lies: the local
    // commit must not happen, and the intent must survive for reconcile().
    fake.delayMs = 60;
    const inFlight = p.topUp("gina", 1);
    await new Promise((r) => setTimeout(r, 20));
    fake.lieAboutCap = 0.25;
    await expect(inFlight).rejects.toThrow(/read back costLimit/);
    expect(p.find("gina")!.pending).not.toBeNull();
    expect(p.find("gina")!.capUsd).toBe(1); // not committed locally

    // Magpie really holds 2 (the write landed); now it tells the truth again.
    fake.lieAboutCap = null;
    fake.delayMs = 0;
    await p.reconcile(p.find("gina")!);
    expect(p.find("gina")!.capUsd).toBe(2);
    expect(p.find("gina")!.creditedUsd).toBe(1);
    expect(p.find("gina")!.pending).toBeNull();
  });

  test("a pending intent Magpie does not hold is dropped, not credited", async () => {
    await p.ensure("hank", { models, capUsd: 1 });
    const rec = p.find("hank")!;
    rec.pending = { capUsd: 3, depositId: "lost", usd: 2 };
    await p.reconcile(rec);
    expect(rec.capUsd).toBe(1);
    expect(rec.creditedUsd).toBe(0);
    expect(rec.pending).toBeNull();
  });

  test("no top-up may be below the grid or made up", async () => {
    await p.ensure("iris", { models, capUsd: 1 });
    await expect(p.topUp("iris", 0.00001)).rejects.toThrow(/0\.0001/);
    await expect(p.topUp("iris", 0.00015)).rejects.toThrow(/grid/);
    await expect(p.topUp("iris", Number.NaN)).rejects.toThrow(/positive/);
    await expect(p.topUp("iris", Number.POSITIVE_INFINITY)).rejects.toThrow(/positive/);
  });
});

describe("a deposit while the consumer is calling models", () => {
  test("usage moving during the cap write does not lose or duplicate the deposit", async () => {
    const v = await p.ensure("jane", { models, capUsd: 1 });
    fake.keys.get(v.keyId)!.used = 0.4;
    // a request completes between the cap write and the read-back
    fake.onSetLimit = (k) => {
      k.used = 0.43;
      k.calls += 1;
    };
    const first = await p.topUp("jane", 1, "dep-A");
    expect(first.capUsd).toBe(2);
    expect(first.creditedUsd).toBe(1);
    expect(first.usedUsd).toBeCloseTo(0.43, 10);
    expect(first.pending).toBe(false);
    expect(p.find("jane")!.deposits.map((d) => d.id)).toEqual(["dep-A"]);

    // the same event twice: no second credit, no error
    const replay = await p.topUp("jane", 1, "dep-A");
    expect(replay.capUsd).toBe(2);
    expect(replay.creditedUsd).toBe(1);
    expect(p.find("jane")!.deposits).toHaveLength(1);
  });

  test("the same deposit id with a different amount is refused", async () => {
    await p.ensure("kate", { models, capUsd: 1 });
    await p.topUp("kate", 1, "dep-B");
    await expect(p.topUp("kate", 2, "dep-B")).rejects.toThrow(/already applied with \$1/);
    expect(p.find("kate")!.capUsd).toBe(2);
  });

  test("a local save failure after the Magpie write is reconciled on restart", async () => {
    const v = await p.ensure("ivy", { models, capUsd: 1 });
    let failSave = false;
    const flaky = (list: unknown[]) => {
      if (failSave) throw new Error("disk full");
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      writeFileSync(statePath("consumers.json"), JSON.stringify({ consumers: list }), { mode: 0o600 });
    };
    const writing = new Provisioner(fake as never, { save: flaky as never });
    fake.onSetLimit = () => {
      failSave = true; // every save after this point fails
    };
    await expect(writing.topUp("ivy", 1, "dep-C")).rejects.toThrow(/disk full/);
    expect(writing.find("ivy")!.pending).not.toBeNull(); // the intent was on disk before the write
    expect(fake.keys.get(v.keyId)!.cap).toBe(2); // Magpie did apply it

    // restart: a fresh provisioner reads the file and finishes the deposit once
    failSave = false;
    const restarted = new Provisioner(fake as never);
    const view = await restarted.status("ivy");
    expect(view.capUsd).toBe(2);
    expect(view.creditedUsd).toBe(1);
    expect(view.pending).toBe(false);
  });

  test("a Magpie write that did not happen is never credited", async () => {
    const v = await p.ensure("liam", { models, capUsd: 1 });
    fake.failSetLimit = true;
    await expect(p.topUp("liam", 1, "dep-D")).rejects.toThrow(/refused the cap/);
    expect(fake.keys.get(v.keyId)!.cap).toBe(1);
    fake.failSetLimit = false;
    const restarted = new Provisioner(fake as never);
    const view = await restarted.status("liam");
    expect(view.capUsd).toBe(1); // unchanged
    expect(view.creditedUsd).toBe(0);
    expect(view.pending).toBe(false); // the intent was dropped, not credited
  });

  test("refreshAll, status and a deposit running together keep one ledger", async () => {
    await p.ensure("mona", { models, capUsd: 1 });
    fake.delayMs = 25;
    const deposit = p.topUp("mona", 1, "dep-E");
    const reads = Promise.all([p.refreshAll(), p.status("mona"), p.refreshAll()]);
    const [view, readResults] = await Promise.all([deposit, reads]);
    expect(view.capUsd).toBe(2);
    expect(view.creditedUsd).toBe(1);
    for (const r of readResults) {
      const list = Array.isArray(r) ? r : [r];
      for (const x of list) expect(Number.isFinite(x.capUsd)).toBe(true);
    }
    const rec = p.find("mona")!;
    expect(rec.capUsd).toBe(2);
    expect(rec.deposits.map((d) => d.id)).toEqual(["dep-E"]);
    expect(rec.pending).toBeNull();
  });

  test("the plugin never calls limit reset", () => {
    const src = readFileSync(new URL("../src/provisioner.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/"reset"/);
    // The dangerous call is the CLI reset (`gateway-key limit <id> reset`), not
    // reading limit.reset (the window's end time) in status or in the ledger.
    expect(src).not.toMatch(/gateway-key[^\n]*\blimit\b[^\n]*\breset\b/);
  });
});

describe("revocation", () => {
  test("removes the key and wipes the stored secret", async () => {
    const v = await p.ensure("frank", { models, capUsd: 1 });
    const after = await p.revoke("frank");
    expect(after.revokedAt).not.toBeNull();
    expect(fake.removed).toEqual([v.keyId]);
    expect(p.find("frank")!.secret).toBe("");
    await expect(p.topUp("frank", 1)).rejects.toThrow(/no active consumer/);
  });
});

describe("cap validation", () => {
  test("accepts the grid and refuses everything else", () => {
    expect(assertCap(0.0001)).toBe(0.0001);
    expect(assertCap(1.2345)).toBe(1.2345);
    for (const bad of [0, 0.00001, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001]) {
      expect(() => assertCap(bad)).toThrow();
    }
  });
});
