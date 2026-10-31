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
import { emptyPortLedger, SocketBinder } from "../src/ports.ts";
import { projectNetwork } from "../src/network.ts";
import { loadState } from "../src/state.ts";
import { ConsoleInputError } from "../src/console-server.ts";
import { FakeBinder, FakeOwnership } from "./support/fake-ports.ts";

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
  async modelIds() {
    const ids = [...this.native].map((p) => `${p}/native-model`);
    for (const p of this.providers.values()) if (p.preset === "remote-magpie") ids.push(`${p.id}/peer-model`);
    return ids;
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
  /** the core "starts" but exits immediately, as a real bind/ACL failure does */
  dieNextStart = false;
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
    if (this.dieNextStart) {
      this.dieNextStart = false;
      this.cfg = null;
      this.lastError = "easytier-core exited immediately (simulated)";
    }
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

let dir: string;
let services: Service[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
let binder: FakeBinder;
let ownership: FakeOwnership;
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
  ownership = new FakeOwnership();
  // The fake supervisor reports pid 4242 and the plugin owns its own listeners.
  ownership.defaultPids = [4242, process.pid];
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
    ports: { binder, ownership, now: () => new Date("2026-10-31T00:00:10.000Z") },
    probes: {
      catalogModels: async () => catalogModels(),
      statusWith: async () => true,
      remoteModelIds: async () => ["peer-model"],
      localModelIds: async () => ["peer/alpha/peer-model"],
      remoteLimit: async () => null,
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

  test("editing a network may omit the secret and keeps the stored one", async () => {
    const svc = await service({ config: false });
    await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" });
    const secret = svc.config()!.networkSecret;
    await svc.joinNetwork({ networkName: "omp-lab-edited" });
    expect(svc.config()!.networkName).toBe("omp-lab-edited");
    expect(svc.config()!.networkSecret).toBe(secret);
    // A first join still needs a secret (a fresh data directory has nothing to keep).
    const here = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "ohmyaihub-phase10-blank-")));
    try {
      const blank = await service({ config: false });
      await expect(blank.joinNetwork({ networkName: "another-lab" })).rejects.toThrow(/networkSecret/);
    } finally {
      process.chdir(here);
    }
  });

  test("a restart keeps the identity, providers and the port ledger", async () => {
    const svc = await service({ config: false });
    await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" });
    const first = svc.config()!;
    const restarted = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: new FakeSupervisor(),
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership },
      probes: { catalogModels: async () => catalogModels(), statusWith: async () => true },
    });
    services.push(restarted);
    const again = restarted.config()!;
    expect(again.nodeId).toBe(first.nodeId);
    expect(again.instanceId).toBe(first.instanceId);
    expect(again.networkSecret).toBe(first.networkSecret);
    expect(again.secureIdentity).toEqual(first.secureIdentity);
    expect(loadState().state.ports.version).toBe(1);
  });

  test("a join whose core did not stay up is a failure and rolls back", async () => {
    const svc = await service({ config: false });
    sup.dieNextStart = true;
    await expect(
      svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" }),
    ).rejects.toThrow(/configure failed/);
    // A first join with a dead core leaves the node unconfigured, not "joined".
    expect(svc.config()).toBeNull();
    expect(svc.networkView().state).toBe("unconfigured");
  });

  test("a re-join whose core dies falls back to the previous network", async () => {
    const svc = await service({ config: false });
    await svc.joinNetwork({ networkName: "original-lab", networkSecret: "omp-lab-secret" });
    sup.dieNextStart = true;
    await expect(
      svc.joinNetwork({ networkName: "second-lab", networkSecret: "omp-lab-secret" }),
    ).rejects.toThrow(/configure failed/);
    expect(svc.config()!.networkName).toBe("original-lab");
    expect(svc.networkView().state).toBe("online");
  });

  test("an overlay listener port conflict migrates instead of reusing it", async () => {
    const svc = await service({ config: false });
    await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" });
    const before = svc.config()!.listenAddr!;
    const port = Number(before.split(":").pop());
    binder.occupy("0.0.0.0", port);
    const fresh = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: new FakeSupervisor(),
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership },
      probes: { catalogModels: async () => catalogModels(), statusWith: async () => true },
    });
    services.push(fresh);
    await fresh.start();
    const after = fresh.config()!.listenAddr!;
    expect(after).not.toBe(before);
    expect(after.startsWith("tcp://0.0.0.0:")).toBe(true);
    const migration = loadState().state.ports.migrations.find((m) => m.purpose === "overlay-listen");
    expect(migration).toMatchObject({ from: port, to: Number(after.split(":").pop()) });
  });

  test("a listener held by another pid is a failure, not an online node", async () => {
    const svc = await service();
    const rpc = svc.config()!.rpcPort;
    // Restart with the stored RPC port answered by a foreign process.
    ownership.pids.set(rpc, [999_999]);
    const fresh = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: new FakeSupervisor(),
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership },
      probes: { catalogModels: async () => catalogModels(), statusWith: async () => true },
    });
    services.push(fresh);
    await fresh.start();
    expect(fresh.problem()).toMatch(/does not own its listeners|held by pid/);
    const net = fresh.networkView();
    expect(net.state).toBe("failed");
    expect(net.core.running).toBe(false);
    expect(net.core.lastError).toMatch(/does not own its listeners|held by pid/);
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

  test("a core that dies after the share restart rolls the whole transaction back", async () => {
    const svc = await service();
    sup.dieNextStart = true;
    await expect(svc.shareNativeModels({ models: [PRICED], confirm: true })).rejects.toThrow(/previous configuration was restored/);
    expect(svc.config()!.sharingEnabled).toBe(false);
    expect(svc.config()!.share.models).toEqual(["*"]);
    expect(svc.statusSnapshotForTest().catalog.publishing).toBe(false);
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

  test("a catalogue port held by another process is migrated with the Forward ACL", async () => {
    let firstBind = true;
    const bound: number[] = [];
    const svc = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: sup,
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership, now: () => new Date("2026-10-31T00:00:30.000Z") },
      probes: {
        catalogModels: async () => catalogModels(),
        statusWith: async () => true,
        catalogHttpGet: async () => ({ status: 404, body: "" }),
        catalogServer: ({ port }) => {
          if (firstBind) {
            firstBind = false;
            throw new Error("Failed to start server. Is port 3426 in use?");
          }
          bound.push(port);
          return { port, stop: () => {} };
        },
      },
    });
    services.push(svc);
    await svc.configure({ sharingEnabled: false, consumingEnabled: true, networkName: "phase10-lab", networkSecret: "phase10-lab-secret" });
    const net = await svc.shareNativeModels({ models: [PRICED], confirm: true });
    const cfg = svc.config()!;
    expect(cfg.catalog.port).not.toBe(3426);
    expect(bound).toEqual([cfg.catalog.port]);
    const migration = loadState().state.ports.migrations.find((m) => m.purpose === "catalog");
    expect(migration).toMatchObject({ purpose: "catalog", from: 3426, to: cfg.catalog.port });
    // The ACL is regenerated from the config, so it names the migrated port.
    expect(sup.cfg!.publishedPorts).toContain(cfg.catalog.port);
    expect(net.catalog.server.port).toBe(cfg.catalog.port);
    expect(net.catalog.publishing).toBe(true);
    expect(net.catalog.quote!.modelCount).toBe(1);
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

describe("sharing is a bounded, explicit transaction", () => {
  test("a first join selects no models; a wildcard cannot be re-enabled from the console", async () => {
    const svc = await service({ config: false });
    await svc.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" });
    expect(svc.config()!.share.models).toEqual([]);
    await expect(svc.setSharing(true)).rejects.toThrow(/wildcard|share-native-models/);
    await expect(consoleAction(svc, "share-models", { models: ["alpha/*"] })).rejects.toBeInstanceOf(ConsoleInputError);
    expect(CONSOLE_ACTIONS).not.toContain("share-toggle" as never);
    expect(CONSOLE_ACTIONS).not.toContain("catalog-publish" as never);
  });

  test("a guard suspension after the restart rolls the share back", async () => {
    // Read candidates while the provider list is still readable, then make the
    // guard's later read fail: that is the race the transaction must catch.
    let reads = 0;
    const svc = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: sup,
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership },
      probes: {
        catalogModels: async () => {
          reads += 1;
          // become unreadable right after the candidate read: the guard must
          // catch it before the export is opened
          if (reads > 0) magpie.providerReadable = false;
          return catalogModels();
        },
        statusWith: async () => true,
        remoteModelIds: async () => ["peer-model"],
        localModelIds: async () => ["peer/alpha/peer-model"],
        remoteLimit: async () => null,
        catalogHttpGet: async () => ({ status: 404, body: "" }),
        catalogServer: ({ port }) => ({ port, stop: () => {} }),
      },
    });
    services.push(svc);
    await svc.configure({ sharingEnabled: false, consumingEnabled: true, networkName: "phase10-lab", networkSecret: "phase10-lab-secret" });
    await expect(svc.shareNativeModels({ models: [PRICED], confirm: true })).rejects.toThrow(/withdrew sharing|previous configuration was restored/);
    expect(svc.config()!.sharingEnabled).toBe(false);
    expect(svc.statusSnapshotForTest().config.sharingActive).toBe(false);
    magpie.providerReadable = true;
  });

  test("a catalogue bind failure that is not a port conflict fails the share", async () => {
    const svc = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: sup,
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership },
      probes: {
        catalogModels: async () => catalogModels(),
        statusWith: async () => true,
        catalogHttpGet: async () => ({ status: 404, body: "" }),
        catalogServer: () => {
          throw new Error("permission denied binding the catalogue");
        },
      },
    });
    services.push(svc);
    await svc.configure({ sharingEnabled: false, consumingEnabled: true, networkName: "phase10-lab", networkSecret: "phase10-lab-secret" });
    await expect(svc.shareNativeModels({ models: [PRICED], confirm: true })).rejects.toThrow(/previous configuration was restored/);
    expect(svc.config()!.sharingEnabled).toBe(false);
    expect(svc.statusSnapshotForTest().catalog.publishing).toBe(false);
  });
});

describe("no Gateway Key is sent before the forward is proven ours", () => {
  class KeyedGateway {
    server: ReturnType<typeof Bun.serve>;
    authHeaders: string[] = [];
    constructor(readonly port: number, readonly key: string) {
      this.server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => {
          const auth = req.headers.get("authorization") ?? "";
          this.authHeaders.push(auth);
          if (!auth.includes(this.key)) return new Response("no", { status: 401 });
          return Response.json({ object: "list", data: [{ id: "peer-model", object: "model" }] });
        },
      });
    }
    stop() {
      this.server.stop(true);
    }
  }

  test("a foreign listener on the forward port never sees a key", async () => {
    const gateway = new KeyedGateway(0, "sk-labcap12");
    const realPort = (gateway.server as unknown as { port: number }).port;
    try {
      const svc = await service();
      sup.routeRows = [{ ipv4: "10.66.1.2/32", hostname: "peer-host", proxyCidrs: "192.0.2.84->10.66.1.2", nextHop: "DIRECT", pathLen: 1 }];
      // The fake supervisor claims pid 4242, but the socket belongs to a foreign pid.
      ownership.pids.set(realPort, [999_999]);
      await expect(
        svc.addProvider({ id: "peer", mappedCidr: "10.66.1.2/32", key: "sk-labcap12", providerPort: 3425, localPort: realPort }),
      ).rejects.toThrow(/not provably owned|refusing to send the Gateway Key/);
      expect(gateway.authHeaders).toEqual([]);
    } finally {
      gateway.stop();
    }
  });

  test("reconcile does not re-send the key once the forward owner is foreign", async () => {
    const gateway = new KeyedGateway(0, "sk-labcap12");
    const realPort = (gateway.server as unknown as { port: number }).port;
    try {
      const svc = new Service({
        magpie: magpie as never,
        magpieVersion: "magpie 0.1.2289",
        supervisor: sup,
        lanIp: () => "127.0.0.1",
        probeTimeoutMs: 500,
        ports: { binder, ownership },
        probes: { catalogModels: async () => catalogModels() },
      });
      services.push(svc);
      await svc.configure({ sharingEnabled: false, consumingEnabled: true, networkName: "phase10-lab", networkSecret: "phase10-lab-secret" });
      sup.routeRows = [{ ipv4: "10.66.1.2/32", hostname: "peer-host", proxyCidrs: "192.0.2.84->10.66.1.2", nextHop: "DIRECT", pathLen: 1 }];
      ownership.pids.set(realPort, [4242]);
      await svc.addProvider({ id: "peer", mappedCidr: "10.66.1.2/32", key: "sk-labcap12", providerPort: 3425, localPort: realPort });
      const afterConnect = gateway.authHeaders.length;
      expect(afterConnect).toBeGreaterThan(0);
      ownership.pids.set(realPort, [999_999]);
      await svc.reconcileProviders({ only: "peer", verifyModels: true });
      expect(gateway.authHeaders.length).toBe(afterConnect);
      expect(svc.provider("peer")!.detail).toMatch(/not provably owned|not sending the Gateway Key/);
    } finally {
      gateway.stop();
    }
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
      ports: { binder, ownership },
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
      ports: { binder, ownership, now: () => new Date("2026-10-31T00:00:20.000Z") },
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

describe("stale port evidence never hides a live failure", () => {
  test("a failed live listener wins over a persisted stable proof", () => {
    const ledger = {
      version: 1 as const,
      migrations: [],
      evidence: [
        {
          purpose: "easytier-rpc" as const,
          port: 17888,
          host: "127.0.0.1",
          owner: "easytier" as const,
          state: "stable" as const,
          verifiedAt: "2026-10-30T00:00:00.000Z",
          detail: null,
        },
      ],
    };
    const view = projectNetwork({
      config: null,
      supervisor: { running: false, pid: null, rpcPort: 17888, peers: [], aclOk: false } as never,
      catalog: { peers: [], publishing: false, server: { running: false, port: null, address: null, error: null } } as never,
      providers: [],
      gatewayPort: 3425,
      ledger,
    });
    const rpc = view.ports.find((p) => p.purpose === "easytier-rpc")!;
    expect(rpc.state).toBe("failed");
  });

  test("a restart marks persisted proofs unverified until this host re-proves them", async () => {
    const first = await service({ config: false });
    await first.joinNetwork({ networkName: "omp-lab", networkSecret: "omp-lab-secret" });
    const saved = loadState().state;
    expect(saved.ports.evidence.some((e) => e.purpose === "easytier-rpc" && e.state === "stable")).toBe(true);
    const restarted = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: new FakeSupervisor(),
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership },
      probes: { catalogModels: async () => catalogModels(), statusWith: async () => true },
    });
    services.push(restarted);
    const persisted = (restarted as unknown as { state: { ports: { evidence: { purpose: string; state: string }[] } } }).state.ports.evidence.find(
      (e) => e.purpose === "easytier-rpc",
    )!;
    expect(persisted.state).toBe("unverified");
    const rpc = restarted.networkView().ports.find((p) => p.purpose === "easytier-rpc")!;
    // The core is not running in this fresh instance, so the live verdict is
    // "failed": either way the old "stable" never survives the restart.
    expect(rpc.state).not.toBe("stable");
  });

  test("console and API ports are not claimed stable by a fallback", async () => {
    const svc = await service();
    const view = projectNetwork({
      config: svc.config(),
      supervisor: { running: true, pid: 4242, rpcPort: svc.config()!.rpcPort, peers: [], aclOk: true } as never,
      catalog: { peers: [], publishing: false, server: { running: false, port: null, address: null, error: null } } as never,
      providers: [],
      gatewayPort: 3425,
      consolePort: 39001,
      apiPort: 34517,
    });
    expect(view.ports.find((p) => p.purpose === "console")!.state).toBe("unverified");
    expect(view.ports.find((p) => p.purpose === "api")!.state).toBe("unverified");
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
