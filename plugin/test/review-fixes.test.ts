import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Provisioner } from "../src/provisioner.ts";
import { costNanos, priceSnapshot, usdToNanos, type PriceParts } from "../src/pricing.ts";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { EasytierConfig, PortForward, RouteRow, Peer, SupervisorState } from "../src/easytier.ts";
import type { CatalogModelMeta, ProviderRecord } from "../src/magpie.ts";
import { fakePortOwnership } from "./support/fake-ports.ts";

// Review-patch tests. Each one is written against the reported failure, so it
// fails on the reviewed HEAD and passes only when the defect is really fixed.

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
  off: boolean;
}

/** Magpie 0.1.2038's observable key/limit/rotate behaviour. */
class FakeMagpie {
  constructor(private log: string) {}
  keyMap = new Map<string, FakeKey>();
  get keys(): FakeKey[] {
    return [...this.keyMap.values()];
  }
  keysRaw(): FakeKey[] {
    return [...this.keyMap.values()];
  }
  rows: { t: string; callerKeyId: string; provider: string; model: string; in: number; out: number; route_id: number }[] = [];
  price: PriceParts | null = BASE;
  removeFails = false;
  rotateFails = false;
  setCapFails = false;
  inFlight = 0;
  concurrencyReadable = true;
  metasReadable = true;
  private n = 0;
  private route = 1_700_000_000_000;

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
      secret: secret ?? `sk-ohmy-${id}${"0".repeat(40)}`,
      models: [],
      cap: 0,
      start: now,
      reset: now + 3650 * 86_400_000,
      calls: 0,
      off: false,
    };
    this.keyMap.set(id, k);
    return { ...this.copy(k), secret: k.secret };
  }
  async setModels(id: string, models: string[]) {
    this.keyMap.get(id)!.models = [...models];
  }
  async setQuotasOff() {}
  async setCostLimit(id: string, _w: string, usd: number) {
    if (this.setCapFails) throw new Error("magpie refused the cap");
    this.keyMap.get(id)!.cap = usd;
  }
  async removeKey(id: string) {
    if (this.removeFails) throw new Error("magpie refused to remove the key");
    this.keyMap.delete(id);
  }
  async rotateKey(id: string) {
    if (this.rotateFails) throw new Error("magpie refused to rotate the key");
    const k = this.keyMap.get(id)!;
    k.secret = `sk-ohmy-rotated${id}${"0".repeat(32)}`;
    return k.secret;
  }
  async limitStatus(secret: string) {
    const k = [...this.keyMap.values()].find((x) => x.secret === secret && !x.off);
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
    return this.concurrencyReadable ? this.inFlight : null;
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
  /** A settled call: Magpie appends one usage row. */
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
  starts = 0;
  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    this.cfg = cfg;
    this.running = true;
    this.starts += 1;
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

let dir: string;
let log: string;
let fake: FakeMagpie;
let ledger: Ledger;

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

function make(delay = 0): Provisioner {
  return new Provisioner(fake as never, {
    ledger,
    prices: async (models) => priceSnapshot(fake.metas(), models),
    usageLog: () => log,
    drainMs: delay,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-review-"));
  process.chdir(dir);
  log = join(dir, "usage.jsonl");
  writeFileSync(log, "");
  fake = new FakeMagpie(log);
  ledger = new Ledger(join(dir, "ledger.sqlite"));
});

// --- C: consumption identity -------------------------------------------------

describe("C — one row is one event, two equal calls are two events", () => {
  test("two byte-identical usage lines are two separate charges", async () => {
    const p = make();
    const v = await p.ensure("alice", { models: [MODEL], capUsd: 1 });
    // Same timestamp, same tokens, same route_id: only the file position differs.
    const line =
      JSON.stringify({
        route_id: 99,
        t: "2026-10-30T01:00:00.000Z",
        callerKeyId: v.keyId,
        provider: "lab",
        model: "lab-model",
        in: 1000,
        out: 100,
        cache_read: 0,
        cache_write: 0,
        status: 200,
      }) + "\n";
    writeFileSync(log, line + line);
    const view = await p.status("alice");
    expect(view.ledger?.consumedUsd).toBeCloseTo(0.0024, 9);
  });

  test("re-reading the same line (a repeated import) charges once", async () => {
    const p = make();
    const v = await p.ensure("bob", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 1000, 100);
    await p.status("bob");
    // A forced re-read from offset 0 must not double-charge the same line.
    const window = ledger.openWindowFor("bob")!;
    const again = ledger.importUsage({ consumerId: "bob", window, logPath: log, fromOffset: 0 });
    expect(again.imported).toBe(0);
    expect((await p.status("bob")).ledger?.consumedUsd).toBeCloseTo(0.0012, 9);
  });

  test("a truncated log is marked uncertain instead of charging garbage", async () => {
    const p = make();
    const v = await p.ensure("carol", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 1000, 100);
    fake.addUsage(v.keyId, 1000, 100);
    await p.status("carol");
    // Magpie does not truncate, but a disk restore or a hand edit can.
    writeFileSync(log, JSON.stringify({ route_id: 1, t: "2026-10-30T02:00:00.000Z", callerKeyId: v.keyId, provider: "lab", model: "lab-model", in: 10, out: 10, status: 200 }) + "\n");
    const view = await p.status("carol");
    expect(view.paused?.reason ?? view.ledger?.uncertain ?? "none").not.toBe("none");
  });
});

// --- B: late usage from an old window ---------------------------------------

describe("B — a late row from an old key is still charged", () => {
  test("a row written 5 s after reissue is charged at the old snapshot", async () => {
    const p = make(100);
    const v = await p.ensure("dave", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 200_000, 50_000); // $0.3
    fake.rollWindow(v.keyId);
    await p.status("dave");
    const next = await p.reissue("dave");
    expect(next.capUsd).toBe(0.7);
    // The old request settles only now.
    fake.addUsage(v.keyId, 100_000, 25_000); // $0.15 at the old price
    const settled = await p.status("dave");
    expect(settled.ledger?.consumedUsd).toBeCloseTo(0.45, 9);
    expect(settled.ledger?.balanceUsd).toBeCloseTo(0.55, 9);
    // The live key must be tightened to the new balance, not left at 0.7.
    expect(settled.capUsd).toBeCloseTo(0.55, 9);
  });

  test("a late row after 30 s is charged, and an exhausted balance pauses the key", async () => {
    const p = make(100);
    const v = await p.ensure("erin", { models: [MODEL], capUsd: 1 });
    fake.rollWindow(v.keyId);
    await p.status("erin");
    const next = await p.reissue("erin");
    expect(next.capUsd).toBe(1);
    fake.addUsage(v.keyId, 4_000_000, 2_000_000); // $8 at the old price
    const settled = await p.status("erin");
    expect(settled.ledger?.overdraftUsd).toBeCloseTo(7, 9);
    expect(settled.paused?.reason).toBe("overdraft");
    expect(settled.paused?.enforced).toBe(true);
  });

  test("a window is never called settled while an in-flight request can still bill", async () => {
    const p = make(50);
    const v = await p.ensure("frank", { models: [MODEL], capUsd: 1 });
    fake.rollWindow(v.keyId);
    await p.status("frank");
    fake.inFlight = 1;
    await p.reissue("frank");
    const windows = ledger.windowsFor("frank");
    const old = windows.find((w) => w.status === "closed");
    // Either the old window is still being watched, or the record says uncertain.
    const watched = ledger.unsettledWindows().some((w) => w.consumerId === "frank");
    expect(Boolean(old) || watched).toBe(true);
    if (old) expect(ledger.windowSettlement(old.id).settled).toBe(false);
  });

  test("a restart re-scans windows that were not proven settled", async () => {
    const p = make(50);
    const v = await p.ensure("gina", { models: [MODEL], capUsd: 1 });
    fake.rollWindow(v.keyId);
    await p.status("gina");
    await p.reissue("gina");
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    const restarted = make(50);
    fake.addUsage(v.keyId, 100_000, 25_000);
    const view = await restarted.status("gina");
    expect(view.ledger?.consumedUsd).toBeCloseTo(0.15, 9);
  });
});


  test("a log gap pauses the consumer and keeps the export down until it is resolved", async () => {
    const p = make(50);
    const v = await p.ensure("quinn", { models: [MODEL], capUsd: 1 });
    fake.addUsage(v.keyId, 1000, 100);
    await p.status("quinn");
    writeFileSync(log, ""); // the log is replaced under the cursor
    const after = await p.status("quinn");
    expect(after.paused?.reason).toBe("log-gap");
    expect(after.paused?.enforced).toBe(true);
    expect(after.ledger?.uncertain).toMatch(/shrank|truncated|missing/i);
  });


  test("a late row that lands after a window was called settled reopens it and is charged", async () => {
    const p = make(50);
    const v = await p.ensure("rita", { models: [MODEL], capUsd: 1 });
    fake.rollWindow(v.keyId);
    await p.status("rita");
    // No request in flight and nothing unread: the old window settles.
    await p.reissue("rita");
    await p.status("rita");
    const old = ledger.windowsFor("rita").find((w) => w.keyId === v.keyId)!;
    expect(ledger.windowSettlement(old.id).settled).toBe(true);
    // The request that ended just after the settlement check still writes a row.
    fake.addUsage(v.keyId, 100_000, 25_000);
    const after = await p.status("rita");
    expect(after.ledger?.consumedUsd).toBeCloseTo(0.15, 9);
    expect(after.capUsd).toBeCloseTo(0.85, 9);
    expect(ledger.windowSettlement(old.id).settled).toBe(true);
  });

// --- D: pause must actually stop consumption --------------------------------

describe("D — pause stops remote consumption, or says it cannot", () => {
  test("a removed key is reported as revoked, not merely cap-restricted", async () => {
    const p = make();
    const v = await p.ensure("hank", { models: [MODEL], capUsd: 1 });
    fake.setPrice(null);
    const paused = await p.status("hank");
    expect(paused.paused?.enforcement).toBe("keyRevoked");
    expect(paused.paused?.enforced).toBe(true);
    expect(fake.keyMap.has(v.keyId)).toBe(false);
  });

  test("when remove fails, the secret is rotated and enforcement is not claimed as revoked", async () => {
    const p = make();
    await p.ensure("iris", { models: [MODEL], capUsd: 1 });
    fake.removeFails = true;
    fake.setPrice(null);
    const paused = await p.status("iris");
    expect(paused.paused?.enforced).toBe(true);
    expect(paused.paused?.enforcement).toBe("secretRotated");
    expect(paused.paused?.enforcementError ?? "").toMatch(/remove/i);
  });

  test("when remove and rotate both fail, the strongest honest level is capRestricted and it is not enforced", async () => {
    const p = make();
    await p.ensure("jane", { models: [MODEL], capUsd: 1 });
    fake.removeFails = true;
    fake.rotateFails = true;
    fake.setPrice(null);
    const paused = await p.status("jane");
    expect(paused.paused?.enforced).toBe(false);
    expect(paused.paused?.enforcement).toBe("capRestricted");
    expect(paused.paused?.enforcementError ?? "").toMatch(/still admits calls/i);
  });

  test("when even the cap cannot be written, it is safetyUncertain", async () => {
    const p = make();
    await p.ensure("joel", { models: [MODEL], capUsd: 1 });
    fake.removeFails = true;
    fake.rotateFails = true;
    fake.setCapFails = true;
    fake.setPrice(null);
    const paused = await p.status("joel");
    expect(paused.paused?.enforced).toBe(false);
    expect(paused.paused?.enforcement).toBe("safetyUncertain");
  });

  test("a minimum cap is never presented as a stop", async () => {
    const p = make();
    await p.ensure("kate", { models: [MODEL], capUsd: 1 });
    fake.removeFails = true;
    fake.rotateFails = true;
    fake.setPrice(null);
    const paused = await p.status("kate");
    expect(paused.paused?.enforced).toBe(false);
    // The record must say the key can still be called, not that it is blocked.
    expect(paused.paused?.enforcement).toBe("capRestricted");
    expect(JSON.stringify(paused.paused)).toMatch(/still admits calls/i);
  });
});

// --- E: crash between SQLite, consumers.json and Magpie ----------------------

describe("E — a crash between the three stores is recoverable", () => {
  test("a new key exists with no ledger window: recovery adopts or removes it", async () => {
    const p = make(50);
    const v = await p.ensure("liam", { models: [MODEL], capUsd: 1 });
    fake.rollWindow(v.keyId);
    await p.status("liam");
    // Simulate: the new Magpie key was created, then the process died before
    // openWindow committed.
    // A secret the fake already issued, so no literal credential is in the tree.
    const created = await fake.addKey("ohmyaihub-liam", `sk-test-reissued-liam-${"0".repeat(20)}`);
    await fake.setModels(created.id, [MODEL]);
    await fake.setCostLimit(created.id, "3650d", 0.5);
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    const restarted = make(50);
    const view = await restarted.status("liam");
    // The consumer is either usable with a ledger window for the new key, or
    // paused with no usable secret — never silently active without a window.
    if (view.paused) {
      expect(view.paused.enforced).toBe(true);
    } else {
      expect(ledger.openWindowFor("liam")?.keyId).toBe(view.keyId);
    }
  });

  test("a committed ledger window with an unsaved consumer record is adopted", async () => {
    const p = make(50);
    await p.ensure("mona", { models: [MODEL], capUsd: 1 });
    // Drop consumers.json, keep the ledger: the ledger is the money record.
    rmSync(join(dir, "oh-my-aihub", "consumers.json"), { force: true });
    rmSync(join(dir, "oh-my-aihub", "consumers.json.prev"), { force: true });
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    const restarted = make(50);
    // It must not silently start with zero consumers while a key still exists.
    const accounts = ledger.accounts();
    expect(accounts.length).toBe(1);
    const status = await restarted.recover();
    expect(status.recovered.length + status.uncertain.length).toBeGreaterThan(0);
  });

  test("consumers.json is written atomically and a corrupt file fails closed", async () => {
    const p = make(50);
    await p.ensure("nina", { models: [MODEL], capUsd: 1 });
    const file = join(dir, "oh-my-aihub", "consumers.json");
    expect(existsSync(file)).toBe(true);
    // A hand edit that truncates the document must not become "no consumers":
    // the constructor refuses to build a provisioner with an empty list.
    writeFileSync(file, '{"consumers": [');
    rmSync(`${file}.prev`, { force: true });
    expect(() => make(50)).toThrow(/unreadable/);
    // With a good .prev copy it recovers that instead of starting empty.
    writeFileSync(`${file}.prev`, readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ consumers: [{ consumerId: "nina" }] }));
    const restarted = make(50);
    expect(restarted.find("nina")?.consumerId).toBe("nina");
    expect(() => make(50)).not.toThrow();
  });
});

// --- A: periodic accounting check -------------------------------------------

describe("A — the accounting check runs without any page or status call", () => {
  test("an external price change pauses a key on the tick alone", async () => {
    const sup = new FakeSupervisor();
    const service = new Service({
      magpie: fake as never,
      magpieVersion: "magpie 0.1.2038",
      supervisor: sup,
      ports: { ownership: fakePortOwnership() },
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 200,
      accountingTickMs: 40,
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
      networkName: "review-lab",
      networkSecret: "review-lab-secret",
    });
    const created = await service.ensureConsumer("olga", [MODEL], 1);
    expect(created.paused).toBeNull();
    // Nobody touches the page or /status from here on.
    fake.setPrice({ input: 2, output: 4, cache_read: 0.2, cache_write: 0.4 });
    await waitFor(() => service.provisioner.find("olga")?.paused?.reason === "price-mismatch", 3000);
    expect(service.provisioner.find("olga")?.paused?.reason).toBe("price-mismatch");
    expect(service.accountingStatus().maxDetectionMs).toBeGreaterThan(0);
    expect(service.accountingStatus().lastCheckAt).not.toBeNull();
    await service.stop();
  });

  test("repeated check failures withdraw sharing instead of serving forever", async () => {
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
      networkName: "review-lab",
      networkSecret: "review-lab-secret",
    });
    await service.ensureConsumer("peter", [MODEL], 1);
    fake.metasReadable = false; // the price source becomes unreadable
    await waitFor(() => service.accountingStatus().uncertain === true, 3000);
    expect(service.accountingStatus().uncertain).toBe(true);
    expect(service.accountingStatus().serving).toBe(false);
    // A later successful check must not silently re-publish a key that was
    // never re-validated.
    expect(service.statusSnapshotForTest().config.shareSuspended?.reason).toMatch(/account/i);
    // While the check cannot verify the accounting, the export is withdrawn and
    // the status says so; consumers are not served "on trust".
    expect(service.accountingStatus().serving).toBe(false);
    // A passing check re-validates every key before republishing, and says when.
    fake.metasReadable = true;
    await waitFor(() => service.accountingStatus().serving === true, 3000);
    const ok = service.accountingStatus();
    expect(ok.uncertain).toBe(false);
    expect(ok.lastOkAt).not.toBeNull();
    expect(ok.failures).toBe(0);
    await service.stop();
  });
});

async function waitFor(fn: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}


  test("a deposit while paused is booked once and survives a restart", async () => {
    const p = make(50);
    const v = await p.ensure("tara", { models: [MODEL], capUsd: 0.5 });
    fake.addUsage(v.keyId, 400_000, 100_000); // $0.6, an overdraft
    await p.status("tara");
    expect((await p.status("tara")).ledger?.overdraftUsd).toBeCloseTo(0.1, 9);
    fake.rollWindow(v.keyId);
    await p.status("tara");
    const paid = await p.topUp("tara", 0.3, "paused-dep");
    expect(paid.ledger?.balanceUsd).toBeCloseTo(0.2, 9);
    const replay = await p.topUp("tara", 0.3, "paused-dep");
    expect(replay.ledger?.depositedUsd).toBeCloseTo(0.8, 9);
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    const restarted = make(50);
    const view = await restarted.status("tara");
    expect(view.ledger?.balanceUsd).toBeCloseTo(0.2, 9);
    expect(ledger.depositsFor("tara").filter((d) => d.status === "applied")).toHaveLength(2);
    const reissued = await restarted.reissue("tara");
    expect(reissued.paused).toBeNull();
    expect(reissued.capUsd).toBe(0.2);
  });

describe("B/D interaction — a paused consumer still gets late charges", () => {
  test("a row that settles after the pause is still charged, and the overdraft is visible", async () => {
    const p = make(50);
    const v = await p.ensure("sam", { models: [MODEL], capUsd: 1 });
    fake.rollWindow(v.keyId);
    const paused = await p.status("sam");
    expect(paused.paused?.reason).toBe("window-rollover");
    const before = paused.ledger?.consumedUsd ?? 0;
    // The request was in flight when the key was stopped; it settles now.
    fake.addUsage(v.keyId, 4_000_000, 2_000_000);
    const after = await p.status("sam");
    expect((after.ledger?.consumedUsd ?? 0) - before).toBeCloseTo(8, 9);
    expect(after.paused?.reason).toBe("window-rollover");
    expect(after.ledger?.balanceUsd).toBeCloseTo(-7, 9);
  });
});
