// Forward recovery for an already-connected, plugin-owned Remote:
// a foreign/occupied loopback port is moved to a new one in one bounded
// reconcile, proving the new port belongs to the core before any Gateway Key is
// sent, then re-registering the native Remote under the same key.
//
// All probes are synthetic and local: no overlay, no Magpie, no testnet.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import { FakeBinder, FakeOwnership } from "./support/fake-ports.ts";
import { getProviderKey, loadState, saveState, setProviderKey, type ProviderConnection } from "../src/state.ts";

const OLD = 13610;
const PEER2 = 13611;
const KEY = "sk-labcap12";
const KEY2 = "sk-labcap13";
const MODELS = ["peer-model"];

class FakeMagpie {
  providers = new Map<string, { id: string; preset: string; chat: string; key: string }>();
  native = new Set<string>();
  readable = true;
  replaceCalls = 0;
  addCalls = 0;
  removeCalls: string[] = [];
  failReplaceOnce = false;
  failAddOnce = false;
  failRemoveOnce = false;

  providersReadable() {
    return this.readable;
  }
  nativeProviderIds() {
    return new Set(this.native);
  }
  remoteProviderIds() {
    return new Set([...this.providers.values()].filter((p) => p.preset === "remote-magpie").map((p) => p.id));
  }
  providerById(id: string) {
    return this.providers.get(id);
  }
  keyById() {
    return undefined;
  }
  async modelIds() {
    return [...this.providers.keys()].map((id) => `${id}/peer-model`);
  }
  async addRemoteProvider(opts: { id: string; url: string; key: string }) {
    this.addCalls += 1;
    if (this.failAddOnce) {
      this.failAddOnce = false;
      throw new Error("simulated native registration failure");
    }
    this.providers.set(opts.id, { id: opts.id, preset: "remote-magpie", chat: `${opts.url}/v1`, key: opts.key });
  }
  async replaceRemoteProvider(opts: { id: string; url: string; key: string }) {
    this.replaceCalls += 1;
    if (this.failReplaceOnce) {
      this.failReplaceOnce = false;
      throw new Error("simulated native replace failure");
    }
    this.providers.set(opts.id, { id: opts.id, preset: "remote-magpie", chat: `${opts.url}/v1`, key: opts.key });
  }
  async removeProvider(id: string) {
    if (this.failRemoveOnce) {
      this.failRemoveOnce = false;
      throw new Error("simulated remove failure");
    }
    this.removeCalls.push(id);
    this.providers.delete(id);
  }
}

class FakeSupervisor implements SupervisorLike {
  cfg: EasytierConfig | null = null;
  forwards: PortForward[] = [];
  peerRows: Peer[] = [];
  routeRows: RouteRow[] = [];
  starts = 0;
  failStartOnce = false;
  onStart: (() => void) | null = null;

  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    this.onStart?.();
    if (this.failStartOnce) {
      this.failStartOnce = false;
      throw new Error("simulated core restart failure");
    }
    this.cfg = { ...cfg, portForwards: cfg.portForwards.map((f) => ({ ...f })) };
    this.forwards = (cfg.portForwards ?? []).map((f: ForwardSpec) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
    this.starts += 1;
    return this.snapshot();
  }
  async stop(): Promise<void> {
    this.cfg = null;
  }
  async refresh(): Promise<SupervisorState> {
    return this.snapshot();
  }
  async listPortForwards(): Promise<PortForward[]> {
    return this.forwards.map((f) => ({ ...f }));
  }
  async addPortForward(bindAddr: string, dstAddr: string): Promise<boolean> {
    if (this.forwards.some((f) => f.bindAddr === bindAddr && f.dstAddr === dstAddr)) return false;
    this.forwards.push({ protocol: "tcp", bindAddr, dstAddr });
    return true;
  }
  async removePortForward(): Promise<void> {}
  setForwards(forwards: ForwardSpec[]): void {
    this.forwards = forwards.map((f) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
    if (this.cfg) this.cfg = { ...this.cfg, portForwards: forwards.map((f) => ({ ...f })) };
  }
  async peers(): Promise<Peer[]> {
    return [...this.peerRows];
  }
  async routes(): Promise<RouteRow[]> {
    return [...this.routeRows];
  }
  snapshot(): SupervisorState {
    const cfg = this.cfg;
    return {
      sharingEnabled: cfg?.sharingEnabled ?? false,
      consumingEnabled: cfg?.consumingEnabled ?? false,
      hostname: cfg ? `ohmyaihub-${cfg.nodeId}` : null,
      running: Boolean(cfg),
      pid: cfg ? 4242 : null,
      startedAt: cfg ? "2026-10-31T00:00:00.000Z" : null,
      restarts: 0,
      lastError: null,
      coreVersion: cfg ? "easytier-core 2.6.4-fake" : null,
      rpcPort: cfg?.rpcPort ?? null,
      networkName: cfg?.networkName ?? null,
      virtualIpv4: cfg?.virtualIpv4 ?? null,
      proxyCidr: cfg?.sharingEnabled ? cfg.proxyCidr : null,
      mappedCidr: cfg?.sharingEnabled ? cfg.mappedCidr : null,
      publishedPorts: cfg?.publishedPorts ?? [],
      peers: cfg ? [...this.peerRows] : [],
      peersAt: cfg ? "2026-10-31T00:00:05.000Z" : null,
      routes: cfg ? [...this.routeRows] : [],
      routesAt: cfg ? "2026-10-31T00:00:05.000Z" : null,
      secureMode: cfg?.secureMode ?? false,
      socks5Port: cfg?.socks5Proxy ? Number(new URL(cfg.socks5Proxy).port) : null,
      aclOk: Boolean(cfg),
      aclProblems: [],
      lanIp: "127.0.0.1",
      lastCheckAt: "2026-10-31T00:00:05.000Z",
    };
  }
}

let dir: string;
let services: Service[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
let binder: FakeBinder;
let ownership: FakeOwnership;
let keyedCalls: { port: number; key: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-forward-recovery-"));
  process.chdir(dir);
  for (const s of services.splice(0)) void s.stop();
  magpie = new FakeMagpie();
  sup = new FakeSupervisor();
  binder = new FakeBinder();
  ownership = new FakeOwnership();
  ownership.defaultPids = [4242];
  keyedCalls = [];
});

async function service(): Promise<Service> {
  const svc = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2289",
    supervisor: sup,
    wallet: null,
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 300,
    ports: { binder, ownership, now: () => new Date("2026-10-31T00:00:10.000Z") },
    probes: {
      statusWith: async (_host, port, want, bearer) => {
        if (bearer === KEY || bearer === KEY2) keyedCalls.push({ port, key: bearer });
        if (want === 401) return bearer !== KEY && bearer !== KEY2;
        return bearer === KEY || bearer === KEY2;
      },
      remoteModelIds: async (port, key) => {
        keyedCalls.push({ port, key });
        return port === OLD ? null : MODELS;
      },
      localModelIds: async () => ["peer/peer-model", "peer2/peer-model"],
      remoteLimit: async () => null,
      catalogModels: async () => [] as never,
    },
  });
  services.push(svc);
  await svc.configure({
    sharingEnabled: false,
    consumingEnabled: true,
    networkName: "forward-recovery-lab",
    networkSecret: "forward-recovery-secret",
  });
  sup.peerRows = [];
  sup.routeRows = [
    { ipv4: "10.77.0.3/24", hostname: "peer-host", proxyCidrs: "192.0.2.84->10.66.1.2", nextHop: "DIRECT", pathLen: 1 },
    { ipv4: "10.77.0.4/24", hostname: "peer2-host", proxyCidrs: "192.0.2.84->10.66.1.3", nextHop: "DIRECT", pathLen: 1 },
  ];
  return svc;
}

function provider(id: string, localPort: number, mapped: string, key: string, models: string[], hostname: string): ProviderConnection {
  const now = "2026-10-30T00:00:00.000Z";
  return {
    id,
    remoteMagpieId: id,
    mappedCidr: mapped,
    providerPort: 3425,
    localPort,
    keyRef: `provider-keys.json#${id}`,
    fingerprint: { hostname, virtualIpv4: mapped.replace(/^10\.66\./, "10.77.0."), peerId: `pid-${id}` },
    models,
    status: "connected",
    detail: null,
    limit: null,
    createdAt: now,
    updatedAt: now,
    lastConnectedAt: now,
  };
}

async function withProvider(svc: Service, opts: { urlPort?: number; oldPort?: number } = {}): Promise<void> {
  const oldPort = opts.oldPort ?? OLD;
  setProviderKey("peer", KEY);
  magpie.providers.set("peer", {
    id: "peer",
    preset: "remote-magpie",
    chat: `http://127.0.0.1:${opts.urlPort ?? oldPort}/v1`,
    key: KEY,
  });
  const state = (svc as unknown as { state: ReturnType<typeof loadState>["state"] }).state;
  state.providers = [provider("peer", oldPort, "10.66.1.2/32", KEY, MODELS, "peer-host")];
  saveState(state);
  // A different, durable identity must survive the migration.
  expect(state.config!.nodeId).toBeTruthy();
}

function stateOf(svc: Service) {
  return (svc as unknown as { state: ReturnType<typeof loadState>["state"] }).state;
}

describe("forward recovery for an owned Remote", () => {
  test("an occupied old port migrates, proves the new owner, and keeps the key", async () => {
    const svc = await service();
    await withProvider(svc);
    const cfgId = svc.config()!.nodeId;
    ownership.pids.set(OLD, [999_999]); // foreign listener on the old port
    let sawPending = false;
    let sawOldRegistrationGone = false;
    sup.onStart = () => {
      const saved = loadState().state.providers.find((p) => p.id === "peer")!;
      sawPending = Boolean(saved.forwardPending && saved.forwardPending.from === OLD && saved.forwardPending.to !== OLD);
      sawOldRegistrationGone = !magpie.providers.has("peer");
    };
    const first = await svc.reconcileProviders({ only: "peer", quiet: true, verifyModels: true });
    sup.onStart = null;
    expect(sawPending).toBe(true);
    expect(sawOldRegistrationGone).toBe(true);
    const rec = first.find((p) => p.id === "peer")!;
    expect(rec.status).toBe("connected");
    expect(rec.localPort).not.toBe(OLD);
    expect(getProviderKey("peer")).toBe(KEY);
    expect(magpie.providers.get("peer")!.chat).toBe(`http://127.0.0.1:${rec.localPort}/v1`);
    expect(magpie.providers.get("peer")!.key).toBe(KEY);
    const saved = loadState().state;
    expect(saved.config!.nodeId).toBe(cfgId);
    expect(saved.providers.find((p) => p.id === "peer")!.localPort).toBe(rec.localPort);
    const migration = saved.ports.migrations.find((m) => m.purpose === "forward");
    expect(migration).toMatchObject({ from: OLD, to: rec.localPort });
    // No valid key ever went to the foreign old port.
    expect(keyedCalls.some((c) => c.port === OLD && c.key === KEY)).toBe(false);
    // The new port was probed only after the SQL-like ownership proof (tested in ports unit).
    expect(keyedCalls.some((c) => c.port === rec.localPort && c.key === KEY)).toBe(true);
  });

  test("a crash between registration and state commit adopts the registered port", async () => {
    const svc = await service();
    await withProvider(svc, { urlPort: PEER2 });
    const state = stateOf(svc);
    state.providers.find((p) => p.id === "peer")!.forwardPending = { from: OLD, to: PEER2, at: "2026-10-31T00:00:00.000Z" };
    saveState(state);
    ownership.pids.set(OLD, [999_999]);
    ownership.pids.set(PEER2, [4242]);
    const out = await svc.reconcileProviders({ only: "peer", quiet: true });
    const rec = out.find((p) => p.id === "peer")!;
    expect(rec.localPort).toBe(PEER2);
    expect(rec.status).toBe("connected");
    expect(loadState().state.providers.find((p) => p.id === "peer")!.localPort).toBe(PEER2);
    expect(loadState().state.ports.migrations.some((m) => m.purpose === "forward" && m.to === PEER2)).toBe(true);
    expect(magpie.providers.get("peer")!.chat).toBe(`http://127.0.0.1:${PEER2}/v1`);
  });

  test("a failed re-registration removes a registration that points at an unproven port", async () => {
    const svc = await service();
    await withProvider(svc);
    ownership.pids.set(OLD, [999_999]);
    magpie.failAddOnce = true;
    const out = await svc.reconcileProviders({ only: "peer", quiet: true });
    const rec = out.find((p) => p.id === "peer")!;
    expect(rec.status).toBe("degraded");
    expect(rec.detail).toMatch(/removed|not provably owned|re-registering/);
    expect(magpie.providers.has("peer")).toBe(false);
    expect(magpie.removeCalls).toContain("peer");
    expect(keyedCalls.some((c) => c.port === OLD && c.key === KEY)).toBe(false);
    expect(getProviderKey("peer")).toBe(KEY); // key is kept, not rotated
  });

  test("a core restart failure during recovery rolls back and never registers the bad port", async () => {
    const svc = await service();
    await withProvider(svc);
    ownership.pids.set(OLD, [999_999]);
    sup.failStartOnce = true;
    const out = await svc.reconcileProviders({ only: "peer", quiet: true });
    const rec = out.find((p) => p.id === "peer")!;
    expect(rec.status).toBe("degraded");
    expect(magpie.providers.has("peer")).toBe(false);
    expect(rec.localPort).toBe(OLD);
    expect(keyedCalls.some((c) => c.port === OLD && c.key === KEY)).toBe(false);
    expect(loadState().state.providers.find((p) => p.id === "peer")!.status).toBe("degraded");
  });

  test("if the old registration cannot be removed, abort without retargeting it", async () => {
    const svc = await service();
    await withProvider(svc);
    const before = magpie.providers.get("peer")!.chat;
    ownership.pids.set(OLD, [999_999]);
    magpie.failRemoveOnce = true;
    const starts = sup.starts;
    const out = await svc.reconcileProviders({ only: "peer", quiet: true });
    const rec = out.find((p) => p.id === "peer")!;
    expect(rec.status).toBe("degraded");
    expect(rec.detail).toMatch(/could not be removed|Remove it in Magpie/);
    // The entry keeps its real URL; it is never pointed at another local port.
    expect(magpie.providers.get("peer")!.chat).toBe(before);
    expect(sup.starts).toBe(starts); // no restart while the key route is unresolved
    expect(keyedCalls.some((c) => c.port === OLD && c.key === KEY)).toBe(false);
  });

  test("a failed recovery backs off instead of restarting the core on every reconcile", async () => {
    const svc = await service();
    await withProvider(svc);
    ownership.pids.set(OLD, [999_999]);
    magpie.failAddOnce = true;
    await svc.reconcileProviders({ only: "peer", quiet: true });
    const starts = sup.starts;
    await svc.reconcileProviders({ only: "peer", quiet: true });
    expect(sup.starts).toBe(starts);
  });

  test("another provider's registration and forward survive the shared restart", async () => {
    const svc = await service();
    await withProvider(svc);
    setProviderKey("peer2", KEY2);
    magpie.providers.set("peer2", { id: "peer2", preset: "remote-magpie", chat: `http://127.0.0.1:${PEER2}/v1`, key: KEY2 });
    const state = stateOf(svc);
    state.providers.push(provider("peer2", PEER2, "10.66.1.3/32", KEY2, MODELS, "peer2-host"));
    saveState(state);
    ownership.pids.set(OLD, [999_999]);
    const out = await svc.reconcileProviders({ only: "peer", quiet: true, verifyModels: true });
    const peer2 = out.find((p) => p.id === "peer2")!;
    expect(peer2.localPort).toBe(PEER2);
    expect(magpie.providers.get("peer2")!.chat).toBe(`http://127.0.0.1:${PEER2}/v1`);
    expect(sup.forwards.some((f) => f.bindAddr === `127.0.0.1:${PEER2}`)).toBe(true);
    expect(sup.forwards.some((f) => f.bindAddr === `127.0.0.1:${out.find((p) => p.id === "peer")!.localPort}`)).toBe(true);
  });

  test("a real foreign loopback listener on the old port receives zero requests", async () => {
    const captured: string[] = [];
    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        captured.push(req.headers.get("authorization") ?? "");
        return new Response("no", { status: 401 });
      },
    });
    const foreignPort = foreign.port!;
    try {
      const svc = await service();
      await withProvider(svc, { oldPort: foreignPort });
      ownership.pids.set(foreignPort, [999_999]);
      await svc.reconcileProviders({ only: "peer", quiet: true });
      expect(captured).toEqual([]);
      expect(captured.some((h) => h.includes(KEY))).toBe(false);
    } finally {
      foreign.stop(true);
    }
  });

  test("migration refreshes model evidence from the same keyed read-back", async () => {
    const svc = await service();
    await withProvider(svc);
    const state = stateOf(svc);
    const rec = state.providers.find((p) => p.id === "peer")! as unknown as Record<string, unknown>;
    rec.modelsEvidence = {
      status: "current", source: "connect-readback", readAt: "2026-10-30T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z", models: ["stale-model"], modelCount: 1,
      callable: "yes", identity: null, generation: 3, keyRef: rec.keyRef, keyGeneration: 1, error: null,
    };
    saveState(state);
    ownership.pids.set(OLD, [999_999]);
    await svc.reconcileProviders({ only: "peer", quiet: true, verifyModels: true });
    const evidence = (stateOf(svc).providers.find((p) => p.id === "peer")! as unknown as { modelsEvidence?: Record<string, unknown> }).modelsEvidence;
    expect(evidence).toMatchObject({ status: "current", source: "reconcile", callable: "yes", modelCount: MODELS.length });
    expect(evidence!.models).toEqual(MODELS);
    expect(evidence!.generation).toBe(4);
  });

  test("a failed migration leaves old model evidence stale, never current", async () => {
    const svc = await service();
    await withProvider(svc);
    const state = stateOf(svc);
    const rec = state.providers.find((p) => p.id === "peer")! as unknown as Record<string, unknown>;
    rec.modelsEvidence = {
      status: "current", source: "connect-readback", readAt: "2026-10-30T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z", models: MODELS, modelCount: MODELS.length,
      callable: "yes", identity: null, generation: 2, keyRef: rec.keyRef, keyGeneration: 1, error: null,
    };
    saveState(state);
    ownership.pids.set(OLD, [999_999]);
    magpie.failAddOnce = true;
    await svc.reconcileProviders({ only: "peer", quiet: true });
    const evidence = (stateOf(svc).providers.find((p) => p.id === "peer")! as unknown as { modelsEvidence?: Record<string, unknown> }).modelsEvidence;
    expect(evidence!.status).toBe("stale");
    expect(evidence!.modelCount).toBeNull();
    expect(evidence!.callable).toBe("unknown");
  });

  test("a foreign Magpie entry is never migrated or edited", async () => {
    const svc = await service();
    await withProvider(svc);
    const entry = magpie.providers.get("peer")!;
    entry.key = "sk-someone-else-key";
    const before = { ...entry };
    ownership.pids.set(OLD, [999_999]);
    const out = await svc.reconcileProviders({ only: "peer", quiet: true });
    const rec = out.find((p) => p.id === "peer")!;
    expect(rec.status).toBe("degraded");
    expect(magpie.providers.get("peer")).toEqual(before);
    expect(magpie.replaceCalls).toBe(0);
    expect(keyedCalls).toEqual([]);
  });
});

describe("control forward retirement", () => {
  test("a removed config entry with a live socket is not reported closed", async () => {
    const svc = await service();
    binder.occupy("127.0.0.1", 13620);
    sup.forwards = [{ protocol: "tcp", bindAddr: "127.0.0.1:13620", dstAddr: "10.66.1.2:41651" }];
    // 2.6.4 can remove the list entry while the actual listener stays.
    ;(sup as any).removePortForward = async () => { sup.forwards = []; };
    const result = await svc.retireControlForward("127.0.0.1:13620", "10.66.1.2:41651");
    expect(result.closed).toBe(false);
    expect(result.orphan).toBe(true);
    expect(loadState().state.orphanForwards.some((o) => o.localPort === 13620)).toBe(true);
  });

  test("a control forward is part of the canonical Forward set (no unsafe-runtime strike)", async () => {
    const svc = await service();
    await svc.addControlForward("127.0.0.1:13650", "10.66.1.9:35000");
    // The generated/persisted config the supervisor checks against must name
    // exactly this forward; otherwise a live control forward looks foreign and
    // two refreshes would stop the core.
    const persisted = (sup.cfg?.portForwards ?? []).map((f) => f.bindAddr);
    expect(persisted).toContain("127.0.0.1:13650");
    const et = (svc as unknown as { etConfig: (cfg: unknown) => { portForwards: { bindAddr: string }[] } }).etConfig(svc.config());
    expect(et.portForwards.map((f) => f.bindAddr)).toContain("127.0.0.1:13650");
  });

  test("multiple owned control forwards are not treated as manual/foreign", async () => {
    const svc = await service();
    binder.occupy("127.0.0.1", 13620);
    const originalStart = sup.start.bind(sup);
    sup.start = async (cfg) => { const state = await originalStart(cfg); binder.free("127.0.0.1", 13620); return state; };
    sup.forwards = [
      { protocol: "tcp", bindAddr: "127.0.0.1:13620", dstAddr: "10.66.1.2:41651" },
      { protocol: "tcp", bindAddr: "127.0.0.1:13621", dstAddr: "10.66.1.3:41651" },
    ];
    ;(sup as any).removePortForward = async (bind: string) => { sup.forwards = sup.forwards.filter((f) => f.bindAddr !== bind); };
    const result = await svc.retireControlForward("127.0.0.1:13620", "10.66.1.2:41651", ["127.0.0.1:13621"]);
    expect(result.closed).toBe(true);
    expect(result.restarted).toBe(true);
    expect(sup.forwards.some((f) => f.bindAddr === "127.0.0.1:13621")).toBe(true);
  });

  test("a listener owned by another process is never restarted around", async () => {
    const svc = await service();
    binder.occupy("127.0.0.1", 13620);
    ownership.pids.set(13620, [999]);
    sup.forwards = [{ protocol: "tcp", bindAddr: "127.0.0.1:13620", dstAddr: "10.66.1.2:41651" }];
    ;(sup as any).removePortForward = async () => { sup.forwards = []; };
    const result = await svc.retireControlForward("127.0.0.1:13620", "10.66.1.2:41651");
    expect(result.closed).toBe(false);
    expect(result.restarted).toBe(false);
    const orphan = loadState().state.orphanForwards.find((o) => o.localPort === 13620);
    expect(orphan?.pids).toEqual([999]);
  });

  test("remove that leaves a live listener forces a supervised restart and keeps other forwards", async () => {
    const svc = await service();
    (svc as any).state.providers = [provider("peer2", 13621, "10.66.1.3", KEY2, MODELS, "peer2-host")];
    binder.occupy("127.0.0.1", 13620);
    const originalStart = sup.start.bind(sup);
    sup.start = async (cfg) => { const state = await originalStart(cfg); binder.free("127.0.0.1", 13620); return state; };
    sup.forwards = [
      { protocol: "tcp", bindAddr: "127.0.0.1:13620", dstAddr: "10.66.1.2:41651" },
      { protocol: "tcp", bindAddr: "127.0.0.1:13621", dstAddr: "10.66.1.3:41651" },
    ];
    // 2.6.4 semantics: remove does not close the listener; only start() rebuilds.
    const result = await svc.retireControlForward("127.0.0.1:13620", "10.66.1.2:41651");
    expect(result.closed).toBe(true);
    expect(result.restarted).toBe(true);
    expect(sup.starts).toBeGreaterThanOrEqual(2);
    expect(sup.forwards.some((f) => f.bindAddr === "127.0.0.1:13620")).toBe(false);
    // The app removed only its named bind; the supervised restart rebuilt the
    // provider forward that is still recorded in Service state.
    expect(sup.forwards.some((f) => f.bindAddr === "127.0.0.1:13621")).toBe(true);
  });
});
