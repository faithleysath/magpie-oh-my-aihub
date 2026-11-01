import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Provisioner } from "../src/provisioner.ts";
import { costNanos, priceSnapshot, usdToNanos, type PriceParts } from "../src/pricing.ts";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { EasytierConfig, PortForward, RouteRow, Peer, SupervisorState } from "../src/easytier.ts";
import type { CatalogModelMeta, ProviderRecord } from "../src/magpie.ts";
import { fakePortOwnership } from "./support/fake-ports.ts";

// Final targeted patch: the two ways an uncertain state could be reported as
// healthy. Every test here fails on 9bd99fa.

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
  calls: number;
}

class FakeMagpie {
  constructor(private log: string) {}
  keyMap = new Map<string, FakeKey>();
  rows: { t: string; callerKeyId: string; provider: string; model: string; in: number; out: number; route_id: number }[] = [];
  price: PriceParts | null = BASE;
  /** the key/limit read endpoint fails while calls still work */
  limitReadFails = false;
  removeFails = false;
  rotateFails = false;
  inFlight = 0;
  metasReadable = true;
  /** counts of the AI calls the gateway actually accepted */
  accepted = 0;
  private n = 0;
  private route = 1_700_000_000_000;

  get keys(): FakeKey[] {
    return [...this.keyMap.values()];
  }
  keyByName(name: string) {
    for (const k of this.keyMap.values()) if (k.name === name) return this.copy(k);
    return undefined;
  }
  keyById(id: string) {
    const k = this.keyMap.get(id);
    return k ? this.copy(k) : undefined;
  }
  private copy(k: FakeKey) {
    return { ...k, limit: { period: "days", days: 3650, cost: k.cap } };
  }
  async addKey(name: string, secret?: string) {
    if (secret && [...this.keyMap.values()].some((k) => k.secret === secret)) throw new Error("another key has this secret");
    const id = `k${++this.n}`;
    const now = Date.now();
    const k: FakeKey = {
      id,
      name,
      secret: secret ?? `sk-test-${id}-${"0".repeat(30)}`,
      models: [],
      cap: 0,
      start: now,
      reset: now + 3650 * 86_400_000,
      calls: 0,
    };
    this.keyMap.set(id, k);
    return { ...this.copy(k), secret: k.secret };
  }
  async setModels(id: string, models: string[]) {
    this.keyMap.get(id)!.models = [...models];
  }
  async setQuotasOff() {}
  async setCostLimit(id: string, _w: string, usd: number) {
    this.keyMap.get(id)!.cap = usd;
  }
  async removeKey(id: string) {
    if (this.removeFails) throw new Error("magpie refused to remove the key");
    this.keyMap.delete(id);
  }
  async rotateKey(id: string) {
    if (this.rotateFails) throw new Error("magpie refused to rotate the key");
    const k = this.keyMap.get(id)!;
    k.secret = `sk-test-rotated-${id}-${"0".repeat(24)}`;
    return k.secret;
  }
  async limitStatus(secret: string) {
    if (this.limitReadFails) throw new Error("GET /v1/magpie/limit: HTTP 502");
    const k = [...this.keyMap.values()].find((x) => x.secret === secret);
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
  async inFlightRequests(): Promise<number | null> {
    return this.inFlight;
  }
  used(k: FakeKey): number {
    if (!this.price) return 0;
    let nanos = 0;
    for (const r of this.rows) {
      if (r.callerKeyId !== k.id) continue;
      if (Date.parse(r.t) < k.start) continue;
      nanos += costNanos(this.price, { input: r.in, output: r.out, cacheRead: 0, cacheWrite: 0 });
    }
    return nanos / 1_000_000_000;
  }
  /** A settled call: Magpie appends one usage row and accepted the request. */
  addUsage(keyId: string, input: number, output: number, at = new Date().toISOString()) {
    const row = {
      route_id: ++this.route,
      t: at,
      callerKeyId: keyId,
      callerKeyName: this.keyMap.get(keyId)?.name ?? "lab",
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
    this.accepted += 1;
    const k = this.keyMap.get(keyId);
    if (k) k.calls += 1;
  }
  rollWindow(keyId: string) {
    const k = this.keyMap.get(keyId)!;
    k.start = Date.now() + 5000;
    k.reset = k.start + 3650 * 86_400_000;
  }
  metas() {
    if (!this.metasReadable) throw new Error("catalog unreadable");
    return [meta(MODEL, this.price)];
  }
  setPrice(p: PriceParts | null) {
    this.price = p;
  }
  version(): string {
    return priceSnapshot(this.metas(), [MODEL])!.version;
  }
  keyList() {
    return this.keys.map((k) => ({ ...k, secret: k.secret }));
  }
  providers(): ProviderRecord[] {
    return [{ id: "lab", name: "lab", chat: "http://127.0.0.1:19080/v1", models: [MODEL] }];
  }
  providersReadable() {
    return true;
  }
  providerById(id: string) {
    return this.providers().find((p) => p.id === id);
  }
  nativeProviderIds() {
    return new Set(["lab"]);
  }
  remoteProviderIds() {
    return new Set<string>();
  }
  async modelIds() {
    return [MODEL];
  }
  async catalogModels() {
    return this.metas();
  }
}

class FakeSupervisor implements SupervisorLike {
  cfg: EasytierConfig | null = null;
  running = false;
  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    this.cfg = cfg;
    this.running = true;
    return this.snapshot();
  }
  async stop() {
    this.running = false;
    this.cfg = null;
  }
  async refresh() {
    return this.snapshot();
  }
  snapshot(): SupervisorState {
    const cfg = this.cfg;
    return {
      sharingEnabled: cfg?.sharingEnabled ?? false,
      consumingEnabled: cfg?.consumingEnabled ?? false,
      hostname: cfg ? `ohmyaihub-${cfg.nodeId}` : null,
      running: this.running,
      pid: this.running ? 4242 : null,
      startedAt: this.running ? "2026-10-30T00:00:00.000Z" : null,
      restarts: 0,
      lastError: null,
      coreVersion: "2.6.4-fake",
      rpcPort: cfg?.rpcPort ?? null,
      networkName: cfg?.networkName ?? null,
      virtualIpv4: cfg?.virtualIpv4 ?? null,
      proxyCidr: this.running ? (cfg?.proxyCidr ?? null) : null,
      mappedCidr: this.running ? (cfg?.mappedCidr ?? null) : null,
      publishedPorts: this.running ? (cfg?.publishedPorts ?? []) : [],
      peers: [] as Peer[],
      secureMode: cfg?.secureMode ?? false,
      socks5Port: null,
      aclOk: this.running,
      aclProblems: [],
      lanIp: "192.0.2.84",
      lastCheckAt: null,
    };
  }
  async listPortForwards(): Promise<PortForward[]> {
    return [];
  }
  async addPortForward(): Promise<boolean> {
    return true;
  }
  async removePortForward(): Promise<void> {}
  async setForwards(): Promise<PortForward[]> {
    return [];
  }
  async peers(): Promise<Peer[]> {
    return [];
  }
  async routes(): Promise<RouteRow[]> {
    return [];
  }
  async rpcConfig(): Promise<string> {
    return "";
  }
  async acl(): Promise<{ inbound: string; forward: string }> {
    return { inbound: "Drop", forward: "Drop" };
  }
}

function meta(id: string, price: PriceParts | null): CatalogModelMeta {
  return {
    id,
    displayName: null,
    gatewayApis: ["chat"],
    nativeApis: ["chat"],
    contextWindow: 128000,
    maxOutputTokens: 4096,
    images: false,
    modalities: null,
    reasoningLevels: null,
    price,
    priceSource: price ? "magpie-settings" : null,
    capabilitiesSource: "magpie-settings",
  };
}

let dir: string;
let log: string;
let fake: FakeMagpie;
let ledger: Ledger;

function make(delay = 0): Provisioner {
  return new Provisioner(fake as never, {
    ledger,
    prices: async (models) => priceSnapshot(fake.metas(), models),
    usageLog: () => log,
    drainMs: delay,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-final-"));
  process.chdir(dir);
  log = join(dir, "usage.jsonl");
  writeFileSync(log, "");
  fake = new FakeMagpie(log);
  ledger = new Ledger(join(dir, "ledger.sqlite"));
});

// --- A: an unreadable limit must not count as a healthy check ---------------

describe("A — an unreadable limit read is a failed check, not a pass", () => {
  test("checkConsumer propagates the read failure instead of reporting health", async () => {
    const p = make();
    await p.ensure("alice", { models: [MODEL], capUsd: 1 });
    fake.limitReadFails = true;
    // The gateway still accepts AI calls; only the limit read fails.
    fake.addUsage(p.find("alice")!.keyId, 1000, 100);
    await expect(p.checkConsumer("alice")).rejects.toThrow(/limit|read|502/i);
  });

  test("the periodic check counts consecutive read failures and withdraws sharing", async () => {
    const sup = new FakeSupervisor();
    const service = new Service({
      magpie: fake as never,
      magpieVersion: "magpie 0.1.2038",
      supervisor: sup,
      ports: { ownership: fakePortOwnership() },
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 200,
      accountingTickMs: 30,
      accountingFailureBudget: 3,
      probes: {
        statusWith: async () => true,
        remoteModelIds: async () => [],
        localModelIds: async () => fake.modelIds(),
        catalogModels: async () => fake.metas(),
        remoteLimit: async () => null,
        catalogHttpGet: async () => ({ status: 404, body: "" }),
        catalogServer: () => ({ port: 3426, stop: () => {} }),
      },
    });
    await service.configure({
      sharingEnabled: true,
      consumingEnabled: false,
      networkName: "final-lab",
      networkSecret: "final-lab-secret",
    });
    await service.ensureConsumer("bob", [MODEL], 1);
    const ok = service.accountingStatus();
    expect(ok.failures).toBe(0);
    expect(ok.lastOkAt).not.toBeNull();

    // Magpie keeps serving AI requests; the limit endpoint alone is broken.
    fake.limitReadFails = true;
    const callsBefore = fake.accepted;
    await waitFor(() => service.accountingStatus().uncertain === true, 4000);
    const bad = service.accountingStatus();
    expect(bad.failures).toBeGreaterThanOrEqual(3);
    expect(bad.uncertain).toBe(true);
    expect(bad.uncertainReason).toMatch(/limit|read|502/i);
    expect(bad.serving).toBe(false);
    expect(service.statusSnapshotForTest().config.shareSuspended?.reason).toMatch(/account/i);
    // The gateway really was still accepting calls during the outage.
    fake.addUsage(service.provisioner.find("bob")!.keyId, 1000, 100);
    expect(fake.accepted).toBeGreaterThan(callsBefore);
    // And the consumer was not silently treated as healthy.
    expect(service.provisioner.find("bob")?.paused ?? null).toBeNull();
    await service.stop();
  });

  test("recovery republishes only after every consumer is verified again", async () => {
    const sup = new FakeSupervisor();
    const service = new Service({
      magpie: fake as never,
      magpieVersion: "magpie 0.1.2038",
      supervisor: sup,
      ports: { ownership: fakePortOwnership() },
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 200,
      accountingTickMs: 30,
      accountingFailureBudget: 2,
      probes: {
        statusWith: async () => true,
        remoteModelIds: async () => [],
        localModelIds: async () => fake.modelIds(),
        catalogModels: async () => fake.metas(),
        remoteLimit: async () => null,
        catalogHttpGet: async () => ({ status: 404, body: "" }),
        catalogServer: () => ({ port: 3426, stop: () => {} }),
      },
    });
    await service.configure({
      sharingEnabled: true,
      consumingEnabled: false,
      networkName: "final-lab",
      networkSecret: "final-lab-secret",
    });
    await service.ensureConsumer("carol", [MODEL], 1);
    fake.limitReadFails = true;
    await waitFor(() => service.accountingStatus().serving === false, 4000);
    expect(service.accountingStatus().uncertain).toBe(true);

    fake.limitReadFails = false;
    await waitFor(() => service.accountingStatus().serving === true, 4000);
    const good = service.accountingStatus();
    expect(good.uncertain).toBe(false);
    expect(good.failures).toBe(0);
    expect(good.lastOkAt).not.toBeNull();
    // A healthy state still allows normal money operations.
    const after = await service.topUp("carol", 1, "after-recovery");
    expect(after.capUsd).toBe(2);
    expect(after.creditedUsd).toBe(1);
    await service.stop();
  });
});

// --- B: reissue must refuse a window with an unproven log -------------------

describe("B — reissue refuses a consumer whose usage log is not trustworthy", () => {
  test("a truncated log blocks reissue and leaves the trusted balance untouched", async () => {
    const p = make(50);
    const v = await p.ensure("dave", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 200_000, 50_000); // $0.3, a real charge and a cursor
    const before = await p.status("dave");
    expect(before.ledger?.consumedUsd).toBeCloseTo(0.3, 9);
    const balanceBefore = before.ledger!.balanceUsd;

    fake.rollWindow(v.keyId);
    const paused = await p.status("dave");
    expect(paused.paused?.reason).toBe("window-rollover");

    // The log is truncated: the cursor now points past the end.
    writeFileSync(log, "");
    await expect(p.reissue("dave")).rejects.toThrow(/log|gap|uncertain|usage/i);
    // No new key was created, and the recorded balance is unchanged.
    expect(fake.keyMap.size).toBe(0);
    const after = await p.status("dave");
    expect(after.ledger?.balanceUsd).toBeCloseTo(balanceBefore, 9);
    expect(after.paused).not.toBeNull();
  });

  test("the gap survives a restart and still blocks reissue", async () => {
    const p = make(50);
    const v = await p.ensure("erin", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 200_000, 50_000);
    await p.status("erin");
    fake.rollWindow(v.keyId);
    await p.status("erin");
    writeFileSync(log, "");
    await expect(p.reissue("erin")).rejects.toThrow();
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    const restarted = make(50);
    await expect(restarted.reissue("erin")).rejects.toThrow(/log|gap|uncertain|usage/i);
    expect(fake.keyMap.size).toBe(0);
  });

  test("the log coming back does not clear the gap by itself", async () => {
    const p = make(50);
    const v = await p.ensure("frank", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 200_000, 50_000);
    await p.status("frank");
    fake.rollWindow(v.keyId);
    await p.status("frank");
    writeFileSync(log, "");
    await expect(p.reissue("frank")).rejects.toThrow();
    // The same file name reappears with a single unrelated row.
    writeFileSync(log, JSON.stringify({ route_id: 1, t: new Date().toISOString(), callerKeyId: v.keyId, provider: "lab", model: "lab-model", in: 10, out: 10, status: 200 }) + "\n");
    await expect(p.reissue("frank")).rejects.toThrow(/log|gap|uncertain|usage/i);
  });

  test("a complete but unparsable line is not silently a zero-cost call", async () => {
    const p = make(50);
    const v = await p.ensure("gina", { models: [MODEL], capUsd: 1 });
    // A complete line that is not valid JSON, followed by a valid one.
    writeFileSync(log, '{"route_id": 7, "callerKeyId": "broken"\n');
    const after = await p.status("gina");
    expect(after.paused?.reason ?? after.ledger?.uncertain ?? "").toMatch(/log|gap|uncertain|parse|malformed/i);
    // It is never silently a healthy consumer: the gap is persisted and blocks
    // a reissue until it is resolved with an audit note.
    expect(ledger.openGaps("gina").length).toBeGreaterThan(0);
    await expect(p.reissue("gina")).rejects.toThrow(/gap/i);
    void v;
  });


  test("only an audited resolution unblocks reissue, and it does not invent money", async () => {
    const p = make(50);
    const v = await p.ensure("jane", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 200_000, 50_000); // $0.3 recorded before the gap
    const before = await p.status("jane");
    fake.rollWindow(v.keyId);
    await p.status("jane");
    writeFileSync(log, "");
    await expect(p.reissue("jane")).rejects.toThrow(/gap/i);
    const gap = ledger.openGaps("jane")[0];
    expect(gap).toBeDefined();

    // A resolution without who/why is refused.
    await expect(p.resolveUsageGap("jane", { logId: gap.logId, resolvedBy: "", note: "x" })).rejects.toThrow(/who|note/i);
    const resolved = await p.resolveUsageGap("jane", {
      logId: gap.logId,
      resolvedBy: "operator@example",
      note: "log restored from backup; two calls confirmed unbilled, written off",
    });
    expect(resolved.ledger?.balanceUsd).toBeCloseTo(before.ledger!.balanceUsd, 9); // no compensation
    expect(ledger.openGaps("jane")).toHaveLength(0);
    expect(ledger.gaps("jane")[0].note).toMatch(/written off/);
    // Only now does the reissue go through, at the recorded balance.
    const next = await p.reissue("jane");
    expect(next.capUsd).toBeCloseTo(before.ledger!.balanceUsd, 9);
  });

  test("a healthy consumer still reissues and tops up normally", async () => {
    const p = make(50);
    const v = await p.ensure("hank", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 100_000, 25_000); // $0.15
    await p.status("hank");
    fake.rollWindow(v.keyId);
    await p.status("hank");
    const next = await p.reissue("hank");
    expect(next.paused).toBeNull();
    expect(next.capUsd).toBeCloseTo(0.85, 9);
    const after = await p.topUp("hank", 0.15, "healthy-dep");
    expect(after.capUsd).toBeCloseTo(1, 9);
    expect(after.ledger?.balanceUsd).toBeCloseTo(1, 9);
  });

  test("a late row from an older window is still charged after the fix", async () => {
    const p = make(50);
    const v = await p.ensure("iris", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 200_000, 50_000);
    fake.rollWindow(v.keyId);
    await p.status("iris");
    const next = await p.reissue("iris");
    expect(next.capUsd).toBeCloseTo(0.7, 9);
    fake.addUsage(v.keyId, 100_000, 25_000);
    const settled = await p.status("iris");
    expect(settled.ledger?.consumedUsd).toBeCloseTo(0.45, 9);
    expect(settled.capUsd).toBeCloseTo(0.55, 9);
  });
});

async function waitFor(fn: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

void readFileSync;
void usdToNanos;
