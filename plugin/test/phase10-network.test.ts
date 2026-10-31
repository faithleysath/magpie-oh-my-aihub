// Phase 10 A-service: the three-field join, the one-click share transaction,
// the read-only network projection and the automatic port ledger.
//
// Every probe is local and injected: no overlay, no Magpie binary, no testnet
// RPC and no production port on this host is touched.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type SupervisorLike } from "../src/service.ts";
import { consoleAction, CONSOLE_ACTIONS } from "../src/console-api.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import type { CatalogModelMeta } from "../src/magpie.ts";
import { emptyPortLedger, SocketBinder, type PortBinder, type PortReservation } from "../src/ports.ts";
import { loadState } from "../src/state.ts";
import { ConsoleInputError } from "../src/console-server.ts";

const NATIVE = "alpha";
const NATIVE_MODEL = "alpha/native-model";
const PRICED = "alpha/priced-model";
const UNPRICED = "alpha/unpriced-model";

class FakeMagpie {
  providers = new Map<string, { id: string; preset: string; chat: string; key: string }>();
  native = new Set<string>([NATIVE]);
  providerReadable = true;

  providersReadable() {
    return this.providerReadable;
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
  async addRemoteProvider(opts: { id: string; url: string; key: string }) {
    this.providers.set(opts.id, { id: opts.id, preset: "remote-magpie", chat: `${opts.url}/v1`, key: opts.key });
  }
  async replaceRemoteProvider(opts: { id: string; url: string; key: string }) {
    await this.addRemoteProvider(opts);
  }
  async removeProvider(id: string) {
    this.providers.delete(id);
  }
}

class FakeSupervisor implements SupervisorLike {
  cfg: EasytierConfig | null = null;
  forwards: PortForward[] = [];
  peerRows: Peer[] = [];
  routeRows: RouteRow[] = [];
  starts = 0;
  failNextStart: string | null = null;
  version = "easytier-core 2.6.4-8428a89d";
  lastError: string | null = null;

  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    if (this.failNextStart) {
      const why = this.failNextStart;
      this.failNextStart = null;
      this.lastError = why;
      throw new Error(why);
    }
    this.cfg = { ...cfg, portForwards: cfg.portForwards.map((f) => ({ ...f })) };
    this.forwards = (cfg.portForwards ?? []).map((f: ForwardSpec) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
    this.starts += 1;
    this.lastError = null;
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
    this.forwards.push({ protocol: "tcp", bindAddr, dstAddr });
    return true;
  }
  async removePortForward(): Promise<void> {}
  setForwards(forwards: ForwardSpec[]): void {
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
      lastError: this.lastError,
      coreVersion: cfg ? this.version : null,
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

/** In-memory PID-less binder: `busy` simulates a foreign listener. */
class FakeBinder implements PortBinder {
  held = new Set<string>();
  busy = new Set<string>();
  static key(host: string, port: number) {
    return `${host}:${port}`;
  }
  async reserve(host: string, port: number): Promise<PortReservation | null> {
    const key = FakeBinder.key(host, port);
    if (this.held.has(key) || this.busy.has(key)) return null;
    this.held.add(key);
    return {
      host,
      port,
      release: async () => {
        this.held.delete(key);
      },
    };
  }
  async isFree(host: string, port: number): Promise<boolean> {
    const key = FakeBinder.key(host, port);
    return !this.held.has(key) && !this.busy.has(key);
  }
  occupy(host: string, port: number) {
    this.busy.add(FakeBinder.key(host, port));
  }
}

let dir: string;
let services: Service[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
let binder: FakeBinder;
let gatewayServer: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-phase10-"));
  process.chdir(dir);
  for (const s of services.splice(0)) void s.stop();
  gatewayServer?.stop(true);
  gatewayServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("key required", { status: 401 }),
  });
  process.env.MAGPIE_ADDR = `127.0.0.1:${gatewayServer.port}`;
  magpie = new FakeMagpie();
  sup = new FakeSupervisor();
  binder = new FakeBinder();
});

afterAll(() => {
  for (const s of services) void s.stop();
  gatewayServer?.stop(true);
});

function meta(id: string, price: CatalogModelMeta["price"]): CatalogModelMeta {
  return {
    id,
    displayName: id,
    gatewayApis: ["chat"],
    nativeApis: null,
    contextWindow: null,
    maxOutputTokens: null,
    images: null,
    modalities: null,
    reasoningLevels: null,
    price,
    priceSource: "magpie-gateway",
    capabilitiesSource: "magpie-gateway",
  };
}

function catalogModels(): CatalogModelMeta[] {
  return [
    meta(NATIVE_MODEL, { input: 1, output: 2, cache_read: 0, cache_write: 0 }),
    meta(PRICED, { input: 1, output: 2, cache_read: 0, cache_write: 0 }),
    meta(UNPRICED, {}),
  ];
}

interface Opts {
  config?: boolean;
  sharing?: boolean;
  consuming?: boolean;
}

async function service(opts: Opts = {}): Promise<Service> {
  const svc = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2289",
    supervisor: sup,
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 200,
    ports: { binder, now: () => new Date("2026-10-31T00:00:10.000Z") },
    probes: {
      catalogModels: async () => catalogModels(),
      statusWith: async () => true,
      catalogServer: ({ port }) => ({
        port,
        stop: () => {},
      }),
      catalogHttpGet: async () => ({ status: 404, body: "" }),
    },
  });
  services.push(svc);
  if (opts.config !== false) {
    await svc.configure({
      sharingEnabled: opts.sharing ?? false,
      consumingEnabled: opts.consuming ?? true,
      networkName: "phase10-lab",
      networkSecret: "phase10-lab-secret",
    });
  }
  return svc;
}

describe("join-network: three fields, everything else automatic", () => {
  test("first join consumes and discovers but never shares", async () => {
    const svc = await service({ config: false });
    const net = await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret", initialNode: "203.0.113.10:11010" });
    const cfg = svc.config()!;
    expect(cfg.networkName).toBe("omp-lab");
    expect(cfg.peers).toEqual(["tcp://203.0.113.10:11010"]);
    expect(cfg.consumingEnabled).toBe(true);
    expect(cfg.catalog.discoveryEnabled).toBe(true);
    expect(cfg.sharingEnabled).toBe(false);
    expect(cfg.catalog.enabled).toBe(false);
    expect(cfg.listenAddr).toMatch(/^tcp:\/\/0\.0\.0\.0:\d+$/);
    expect(cfg.controlEnabled).toBe(true);
    expect(net.config.role).toBe("consumer");
    expect(net.network.state).toBe("online");
    expect(net.network.configured).toBe(true);
    expect(net.network.thisNode.nodeId).toBe(cfg.nodeId);
  });

  test("rejoining keeps the identity, providers and the port ledger", async () => {
    const svc = await service({ config: false });
    await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" });
    const first = svc.config()!;
    const before = loadState().state;
    await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret", initialNode: "198.51.100.7:11010" });
    const second = svc.config()!;
    const after = loadState().state;
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.secureIdentity).toEqual(first.secureIdentity);
    expect(after.providers).toEqual(before.providers);
    expect(after.ports.version).toBe(1);
    expect(second.peers).toEqual(["tcp://198.51.100.7:11010"]);
  });

  test("the console rejects role/port fields and short secrets", async () => {
    const svc = await service({ config: false });
    await expect(
      consoleAction(svc, "join-network", { networkName: "omp-lab", networkSecret: "omp-lab-secret", role: "provider" }),
    ).rejects.toBeInstanceOf(ConsoleInputError);
    await expect(
      consoleAction(svc, "join-network", { networkName: "omp-lab", networkSecret: "short" }),
    ).rejects.toBeInstanceOf(ConsoleInputError);
    expect(CONSOLE_ACTIONS).toContain("join-network");
    expect(CONSOLE_ACTIONS).toContain("share-native-models");
    expect(CONSOLE_ACTIONS).toContain("stop-sharing");
    expect(CONSOLE_ACTIONS).toContain("network-refresh");
  });
});

describe("share-native-models: one explicit transaction", () => {
  test("only a native, complete-price model is accepted", async () => {
    const svc = await service();
    await expect(svc.shareNativeModels({ models: [PRICED], confirm: false })).rejects.toThrow(/confirmation/);
    await expect(svc.shareNativeModels({ models: ["beta/remote-model"], confirm: true })).rejects.toThrow(/native models/);
    await expect(svc.shareNativeModels({ models: [UNPRICED], confirm: true })).rejects.toThrow(/complete effective price/);
    expect(svc.config()!.sharingEnabled).toBe(false);
  });

  test("one confirmation shares the exact models and publishes the catalogue", async () => {
    const svc = await service();
    const net = await svc.shareNativeModels({ models: [PRICED, NATIVE_MODEL], confirm: true });
    const cfg = svc.config()!;
    expect(cfg.sharingEnabled).toBe(true);
    expect(cfg.share.models).toEqual([NATIVE_MODEL, PRICED].sort());
    expect(cfg.catalog.enabled).toBe(true);
    expect(net.catalog.publishing).toBe(true);
    expect(net.catalog.quote!.models.map((m) => m.id)).toEqual([NATIVE_MODEL, PRICED].sort());
    expect(net.network.ports.some((p) => p.purpose === "catalog" && p.editable === false)).toBe(true);
  });

  test("a failed apply restores the previous configuration and reports it", async () => {
    const svc = await service();
    const before = structuredClone(svc.config()!);
    sup.failNextStart = "simulated core start failure";
    await expect(svc.shareNativeModels({ models: [PRICED], confirm: true })).rejects.toThrow(/previous configuration was restored/);
    expect(svc.config()!.sharingEnabled).toBe(before.sharingEnabled);
    expect(svc.config()!.share.models).toEqual(before.share.models);
    expect(svc.config()!.catalog.enabled).toBe(false);
    expect(svc.statusSnapshotForTest().catalog.publishing).toBe(false);
  });

  test("stop-sharing withdraws the export and the catalogue but keeps the selection", async () => {
    const svc = await service();
    await svc.shareNativeModels({ models: [PRICED], confirm: true });
    await expect(svc.stopSharing({ confirm: false })).rejects.toThrow(/confirm/);
    const net = await svc.stopSharing({ confirm: true });
    expect(svc.config()!.sharingEnabled).toBe(false);
    expect(svc.config()!.catalog.enabled).toBe(false);
    expect(svc.config()!.share.models).toEqual([PRICED]);
    expect(net.catalog.publishing).toBe(false);
    expect(net.config.sharingEnabled).toBe(false);
  });
});

describe("network projection: evidence, not assumptions", () => {
  function neighbour(id: string, hostname: string, cost: string, latency: string, ipv4: string): Peer {
    return { id, hostname, cost, latencyMs: latency, loss: "0.0%", tunnel: "tcp", nat: "Symmetric", ipv4 };
  }

  test("direct, relay and unknown links come from EasyTier's own tables", async () => {
    const svc = await service();
    sup.peerRows = [
      neighbour("1", "node-b", "p2p", "0.11", "10.77.0.3"),
      neighbour("2", "node-c", "relay(2)", "2.00", "10.77.0.4"),
      neighbour("3", "node-d", "", "-", "10.77.0.5"),
    ];
    sup.routeRows = [
      { ipv4: "10.77.0.3/24", hostname: "node-b", proxyCidrs: "", nextHop: "DIRECT", pathLen: 1 },
      { ipv4: "10.77.0.4/24", hostname: "node-c", proxyCidrs: "", nextHop: "node-b", pathLen: 2 },
    ];
    const view = svc.networkView();
    const byHost = new Map(view.neighbors.map((n) => [n.hostname, n]));
    expect(byHost.get("node-b")!.link).toBe("direct");
    expect(byHost.get("node-b")!.latencyMs).toBeCloseTo(0.11, 5);
    expect(byHost.get("node-c")!.link).toBe("relay");
    expect(byHost.get("node-c")!.relayVia).toBe("node-b");
    const unknown = byHost.get("node-d")!;
    expect(unknown.link).toBe("unknown");
    expect(unknown.latencyMs).toBeNull();
    expect(unknown.online).toBe(true);
    // A neighbour is not an authorization and has no catalogue evidence.
    expect(unknown.catalogNodeId).toBeNull();
    expect(unknown.modelsPublished).toBeNull();
    expect(unknown.modelsAuthorizedForMe).toBeNull();
    expect(unknown.relation).toBe("none");
  });

  test("no peer read means unknown online, never a fake offline", () => {
    const svc = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: sup,
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder },
      probes: { catalogModels: async () => catalogModels() },
    });
    services.push(svc);
    const view = svc.networkView();
    expect(view.state).toBe("unconfigured");
    expect(view.neighbors).toEqual([]);
    expect(view.evidence.readAt).toBeNull();
  });

  test("ports are read-only diagnostics, including the plugin-owned gateway", async () => {
    const svc = await service({ config: false });
    await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" });
    const view = svc.networkView();
    expect(view.ports.every((p) => p.editable === false)).toBe(true);
    const gateway = view.ports.find((p) => p.purpose === "gateway")!;
    expect(gateway.owner).toBe("magpie");
    expect(gateway.state).toBe("unknown");
    expect(view.ports.some((p) => p.purpose === "easytier-rpc")).toBe(true);
    expect(view.ports.some((p) => p.purpose === "overlay-listen")).toBe(true);
  });

  test("a stored port conflict is migrated and recorded instead of reused", async () => {
    const svc = await service();
    const rpc = svc.config()!.rpcPort;
    // The next start finds the stored RPC port taken by somebody else.
    const fresh = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: new FakeSupervisor(),
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, now: () => new Date("2026-10-31T00:00:20.000Z") },
      probes: { catalogModels: async () => catalogModels(), statusWith: async () => true },
    });
    services.push(fresh);
    binder.occupy("127.0.0.1", rpc);
    const nextSup = (fresh as unknown as { supervisor: FakeSupervisor }).supervisor;
    expect(nextSup).toBeInstanceOf(FakeSupervisor);
    await fresh.start();
    const cfg = fresh.config()!;
    expect(cfg.rpcPort).not.toBe(rpc);
    expect(nextSup.cfg!.rpcPort).toBe(cfg.rpcPort);
    const state = loadState().state;
    const migration = state.ports.migrations.find((m) => m.purpose === "easytier-rpc");
    expect(migration).toMatchObject({ purpose: "easytier-rpc", from: rpc, to: cfg.rpcPort });
    expect(state.ports.version).toBe(1);
  });
});

describe("port primitives are shared with B-service", () => {
  test("a reservation is exclusive and released for the real listener", async () => {
    const b = new FakeBinder();
    const first = await b.reserve("127.0.0.1", 13425);
    expect(first).not.toBeNull();
    expect(await b.reserve("127.0.0.1", 13425)).toBeNull();
    await first!.release();
    expect(await b.isFree("127.0.0.1", 13425)).toBe(true);
  });

  test("the real binder holds a real socket at the advertising moment", async () => {
    const real = new SocketBinder();
    const held = await real.reserve("127.0.0.1", 0);
    expect(held).not.toBeNull();
    expect(await real.isFree("127.0.0.1", held!.port)).toBe(false);
    await held!.release();
    expect(await real.isFree("127.0.0.1", held!.port)).toBe(true);
  });

  test("an empty ledger is the default, not a missing field", () => {
    expect(emptyPortLedger()).toEqual({ version: 1, migrations: [], evidence: [] });
  });
});
