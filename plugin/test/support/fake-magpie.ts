// A fake Magpie with the observable contract the Provisioner relies on.
//
// It is not a Magpie emulator: it holds one cost cap and one `used` counter per
// key, computes `used` from recorded usage rows at the recorded price, refuses
// with 429 when a call cannot be afforded, and can be told to fail a cap write
// or to report no limit at all (`limited=false`, which is what a 0 cap really
// means in Magpie 0.1.2038).

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costNanos, priceSnapshot, type PriceParts } from "../../src/pricing.ts";

export const LAB_MODEL = "lab/lab-model";
export const LAB_PRICE: PriceParts = { input: 1, output: 2, cache_read: 0, cache_write: 0 };

export interface FakeKey {
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

export class FakeMagpie {
  keys = new Map<string, FakeKey>();
  rows: { callerKeyId: string; t: string; in: number; out: number }[] = [];
  /** fail the next N cap writes (throws from `setCostLimit`) */
  failCapWrites = 0;
  /** fail the next N limit reads (throws from `limitStatus`) */
  failLimitReads = 0;
  /** report `limited=false` on read-back, as a real 0 cap does */
  noLimitFor = new Set<string>();
  readonly logPath: string;
  private n = 0;

  constructor(logPath?: string) {
    if (logPath) {
      this.logPath = logPath;
    } else {
      const dir = mkdtempSync(join(tmpdir(), "fake-magpie-"));
      this.logPath = join(dir, "usage.jsonl");
      writeFileSync(this.logPath, "");
    }
  }

  keyByName(name: string): FakeKey | undefined {
    for (const k of this.keys.values()) if (k.name === name) return { ...k };
    return undefined;
  }

  keyById(id: string): FakeKey | undefined {
    const k = this.keys.get(id);
    return k ? { ...k } : undefined;
  }

  keyList(): FakeKey[] {
    return [...this.keys.values()].map((k) => ({ ...k }));
  }

  async addKey(name: string, secret?: string): Promise<FakeKey> {
    const id = `k${++this.n}`;
    const now = Date.now();
    const key: FakeKey = {
      id,
      name,
      secret: secret ?? `sk-${id}`,
      models: [],
      cap: 0,
      start: now,
      reset: now + 3650 * 86_400_000,
      window: "3650d",
      calls: 0,
    };
    this.keys.set(id, key);
    return { ...key };
  }

  async setModels(id: string, models: string[]): Promise<void> {
    this.keys.get(id)!.models = [...models];
  }

  async setQuotasOff(_id: string): Promise<void> {}

  async setCostLimit(id: string, window: string, usd: number): Promise<void> {
    if (this.failCapWrites > 0) {
      this.failCapWrites -= 1;
      throw new Error("the cap write was refused");
    }
    const k = this.keys.get(id)!;
    if (k.window !== window) {
      k.start = Date.now();
      k.reset = k.start + 3650 * 86_400_000;
      k.window = window;
    }
    k.cap = usd;
  }

  async limitStatus(secret: string) {
    if (this.failLimitReads > 0) {
      this.failLimitReads -= 1;
      throw new Error("the limit read was refused");
    }
    const k = [...this.keys.values()].find((x) => x.secret === secret);
    if (!k) throw new Error("no such key");
    const used = this.used(k);
    const noLimit = this.noLimitFor.has(k.id) || k.cap === 0;
    return {
      limited: !noLimit,
      key: k.name,
      limit: noLimit
        ? null
        : {
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

  used(key: FakeKey): number {
    let nanos = 0;
    for (const row of this.rows) {
      if (row.callerKeyId !== key.id) continue;
      if (Date.parse(row.t) < key.start) continue;
      nanos += costNanos(LAB_PRICE, { input: row.in, output: row.out, cacheRead: 0, cacheWrite: 0 });
    }
    return nanos / 1_000_000_000;
  }

  /** One model call, refused with 429 when the cap cannot cover it. */
  call(keyId: string, input: number, output: number): { status: number } {
    const k = this.keys.get(keyId)!;
    const estimate = costNanos(LAB_PRICE, { input, output, cacheRead: 0, cacheWrite: 0 }) / 1_000_000_000;
    if (k.cap > 0 && this.used(k) + estimate > k.cap) return { status: 429 };
    const row = { callerKeyId: keyId, t: new Date().toISOString(), in: input, out: output };
    this.rows.push(row);
    appendFileSync(this.logPath, JSON.stringify({ ...row, provider: "lab", model: "lab-model", cache_read: 0, cache_write: 0, status: 200 }) + "\n");
    k.calls += 1;
    return { status: 200 };
  }

  metas(): { id: string; price: PriceParts }[] {
    return [{ id: LAB_MODEL, price: LAB_PRICE }];
  }

  version(): string {
    return priceSnapshot(this.metas(), [LAB_MODEL])!.version;
  }

  async removeKey(id: string): Promise<void> {
    this.keys.delete(id);
  }

  async rotateKey(id: string): Promise<string | null> {
    const k = this.keys.get(id);
    if (!k) return null;
    k.secret = `${k.secret}-rotated`;
    return k.secret;
  }

  async inFlightRequests(_id: string): Promise<number> {
    return 0;
  }

  nativeProviderIds(): Set<string> {
    return new Set(["lab"]);
  }

  remoteProviderIds(): Set<string> {
    return new Set();
  }

  async catalogModels() {
    return this.metas();
  }
}
