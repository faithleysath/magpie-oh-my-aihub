import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Provisioner } from "../src/provisioner.ts";

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
  private n = 0;
  /** make the next read-back report a wrong cap, to exercise the check */
  lieAboutCap: number | null = null;

  keyByName(name: string) {
    for (const k of this.keys.values()) if (k.name === name) return { ...k, secret: k.secret, limit: { period: "day", cost: k.cap } };
    return undefined;
  }
  keyById(id: string) {
    const k = this.keys.get(id);
    return k ? { ...k, limit: { period: "day", cost: k.cap } } : undefined;
  }
  async addKey(name: string) {
    const id = `id${++this.n}`;
    const secret = `sk-test-${id}-secret`;
    const k: FakeKey = { id, name, secret, models: [], cap: 0, used: 0, calls: 0 };
    this.keys.set(id, k);
    return { ...k, limit: null };
  }
  async setModels(id: string, models: string[]) {
    this.keys.get(id)!.models = [...models];
  }
  async setCostLimit(id: string, _window: string, usd: number) {
    this.keys.get(id)!.cap = usd;
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

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-test-"));
  process.chdir(dir);
  fake = new FakeMagpie();
  p = new Provisioner(fake as never);
});

describe("provisioner", () => {
  test("refuses a key without a model whitelist", async () => {
    await expect(p.ensure("alice", { models: [], capUsd: 1 })).rejects.toThrow(/model whitelist/);
    expect(fake.keys.size).toBe(0);
  });

  test("refuses a cap below Magpie's $0.0001 grid", async () => {
    await expect(p.ensure("alice", { models: ["deepseek/deepseek-flash"], capUsd: 0.000024 })).rejects.toThrow(/0\.0001/);
    expect(fake.keys.size).toBe(0);
  });

  test("creates a held key: models, cap, quotas off, read back", async () => {
    const v = await p.ensure("alice", { models: ["deepseek/deepseek-flash"], capUsd: 1 });
    expect(v.keyName).toBe("ohmyaihub-alice");
    expect(v.models).toEqual(["deepseek/deepseek-flash"]);
    expect(v.capUsd).toBe(1);
    expect(v.spent).toBe(false);
    const id = v.keyId;
    expect(fake.quotaOff).toContain(id);
    expect(fake.keys.get(id)!.models).toEqual(["deepseek/deepseek-flash"]);
    expect(fake.keys.get(id)!.cap).toBe(1);
  });

  test("top-up raises the same key's cap and never resets usage", async () => {
    const v = await p.ensure("bob", { models: ["deepseek/*"], capUsd: 0.5 });
    fake.keys.get(v.keyId)!.used = 0.42;
    const after = await p.topUp("bob", 1);
    expect(after.capUsd).toBe(1.5);
    expect(after.usedUsd).toBe(0.42);
    expect(after.creditedUsd).toBe(1);
    expect(fake.removed).toEqual([]);
  });

  test("a top-up below the overdraft leaves the key spent", async () => {
    const v = await p.ensure("carol", { models: ["deepseek/*"], capUsd: 0.5 });
    fake.keys.get(v.keyId)!.used = 0.6; // over budget
    const after = await p.topUp("carol", 0.05);
    expect(after.capUsd).toBe(0.55);
    expect(after.spent).toBe(true);
  });

  test("re-ensuring keeps the cap and refreshes the model list", async () => {
    const v = await p.ensure("dave", { models: ["deepseek/a"], capUsd: 2 });
    const again = await p.ensure("dave", { models: ["deepseek/a", "deepseek/b"], capUsd: 1 });
    expect(again.keyId).toBe(v.keyId);
    expect(again.capUsd).toBe(2); // never lowered by a smaller request
    expect(again.models).toEqual(["deepseek/a", "deepseek/b"]);
  });

  test("a read-back that does not match what was written throws", async () => {
    const v = await p.ensure("erin", { models: ["deepseek/*"], capUsd: 1 });
    fake.lieAboutCap = 0.25;
    await expect(p.topUp("erin", 1)).rejects.toThrow(/read back costLimit/);
    expect(v.keyId).toBeTruthy();
  });

  test("revoking removes the key and wipes the stored secret", async () => {
    const v = await p.ensure("frank", { models: ["deepseek/*"], capUsd: 1 });
    const after = await p.revoke("frank");
    expect(after.revokedAt).not.toBeNull();
    expect(fake.removed).toEqual([v.keyId]);
    expect(p.find("frank")!.secret).toBe("");
    await expect(p.topUp("frank", 1)).rejects.toThrow(/no active consumer/);
  });

  test("no top-up may be below the grid", async () => {
    await p.ensure("gina", { models: ["deepseek/*"], capUsd: 1 });
    await expect(p.topUp("gina", 0.00001)).rejects.toThrow(/0\.0001/);
  });
});
