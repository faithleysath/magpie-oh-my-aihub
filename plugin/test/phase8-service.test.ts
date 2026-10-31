import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type Probes } from "../src/service.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import type { CatalogModelMeta, ProviderRecord } from "../src/magpie.ts";
import { getProviderKey, loadState, setProviderKey } from "../src/state.ts";
import { fakePortOwnership } from "./support/fake-ports.ts";

// Phase-8 service journeys: configure rollback, cached readiness/local wallet,
// native share candidates and a targeted remote probe. No overlay, Magpie or
// RPC is started.

class FakeMagpie {
  providers = new Map<string, ProviderRecord>();
  models: string[] = ["alpha/a", "alpha/b", "peer-x/c"];
  metas: CatalogModelMeta[] = [];
  keys = new Map<string, { id: string; name: string; secret: string; models: string[] }>();
  private n = 0;

  providersReadable() {
    return true;
  }
  providerById(id: string) {
    return this.providers.get(id);
  }
  nativeProviderIds() {
    return new Set([...this.providers.values()].filter((p) => p.preset !== "remote-magpie").map((p) => p.id));
  }
  remoteProviderIds() {
    return new Set([...this.providers.values()].filter((p) => p.preset === "remote-magpie").map((p) => p.id));
  }
  async modelIds() {
    return [...this.models];
  }
  async catalogModels() {
    return [...this.metas];
  }
  async addRemoteProvider(opts: { id: string; url: string; key: string }) {
    this.providers.set(opts.id, { id: opts.id, preset: "remote-magpie", chat: `${opts.url}/v1`, key: opts.key });
  }
  async replaceRemoteProvider(opts: { id: string; url: string; key: string }) {
    this.providers.delete(opts.id);
    await this.addRemoteProvider(opts);
  }
  async removeProvider(id: string) {
    this.providers.delete(id);
  }
  keyById(id: string) {
    const k = this.keys.get(id);
    return k ? { ...k } : undefined;
  }
  keyByName(name: string) {
    for (const k of this.keys.values()) if (k.name === name) return { ...k };
    return undefined;
  }
  async addKey(name: string) {
    const id = `id${++this.n}`;
    const k = { id, name, secret: `sk-test-${id}-${name}`, models: [] as string[] };
    this.keys.set(id, k);
    return { ...k };
  }
  async setModels(id: string, models: string[]) {
    this.keys.get(id)!.models = [...models];
  }
  async setCostLimit() {}
  async setQuotasOff() {}
  async removeKey(id: string) {
    this.keys.delete(id);
  }
  async limitStatus(secret: string) {
    const k = [...this.keys.values()].find((x) => x.secret === secret);
    if (!k) throw new Error("no such key");
    return { limited: true, key: k.name, limit: { period: "day", costLimit: 1, cost: 0, costLeft: 1, calls: 0, spent: false } } as never;
  }
}

class FakeSupervisor implements SupervisorLike {
  cfg: EasytierConfig | null = null;
  forwards: PortForward[] = [];
  routeRows: RouteRow[] = [];
  peerRows: Peer[] = [];
  starts = 0;
  failNetwork: string | null = null;

  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    if (this.failNetwork && cfg.networkName === this.failNetwork) throw new Error("the test core rejected the new network");
    this.starts += 1;
    this.cfg = { ...cfg, portForwards: cfg.portForwards.map((f) => ({ ...f })) };
    this.forwards = cfg.portForwards.map((f) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
    return this.snapshot();
  }
  async stop() {
    this.cfg = null;
    this.forwards = [];
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
      running: Boolean(cfg),
      pid: cfg ? 4242 : null,
      startedAt: cfg ? "2026-10-30T00:00:00.000Z" : null,
      restarts: 0,
      lastError: null,
      coreVersion: "2.6.4-fake",
      rpcPort: cfg?.rpcPort ?? null,
      networkName: cfg?.networkName ?? null,
      virtualIpv4: cfg?.virtualIpv4 ?? null,
      proxyCidr: cfg?.sharingEnabled ? cfg.proxyCidr : null,
      mappedCidr: cfg?.sharingEnabled ? cfg.mappedCidr : null,
      publishedPorts: cfg?.publishedPorts ?? [],
      peers: [...this.peerRows],
      secureMode: false,
      socks5Port: null,
      aclOk: Boolean(cfg),
      aclProblems: [],
      lanIp: "127.0.0.1",
      lastCheckAt: null,
    };
  }
  async listPortForwards() {
    return this.forwards.map((f) => ({ ...f }));
  }
  async addPortForward(bindAddr: string, dstAddr: string) {
    if (this.forwards.some((f) => f.bindAddr === bindAddr && f.dstAddr === dstAddr)) return false;
    this.forwards.push({ protocol: "tcp", bindAddr, dstAddr });
    return true;
  }
  async removePortForward() {}
  setForwards(forwards: ForwardSpec[]) {
    if (this.cfg) this.cfg = { ...this.cfg, portForwards: forwards.map((f) => ({ ...f })) };
  }
  async peers() {
    return [...this.peerRows];
  }
  async routes() {
    return [...this.routeRows];
  }
  route(mapped: string, hostname: string) {
    this.routeRows = this.routeRows.filter((r) => r.hostname !== hostname);
    this.routeRows.push({ ipv4: "10.77.0.2/24", hostname, proxyCidrs: `192.0.2.1->${mapped}`, nextHop: "DIRECT", pathLen: 1 });
  }
}

type SupervisorLike = import("../src/service.ts").SupervisorLike;

let services: Service[] = [];

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "ohmyaihub-phase8-")));
  for (const s of services.splice(0)) void s.stop();
});

afterEach(() => {
  for (const s of services.splice(0)) void s.stop();
});

function meta(id: string, price: any): CatalogModelMeta {
  return {
    id,
    displayName: null,
    gatewayApis: ["chat"],
    nativeApis: null,
    contextWindow: null,
    maxOutputTokens: null,
    images: null,
    modalities: null,
    reasoningLevels: null,
    price,
    priceSource: price ? "magpie-settings" : null,
    capabilitiesSource: "magpie-settings",
  };
}

async function configured(opts: { consuming?: boolean } = {}): Promise<{ service: Service; magpie: FakeMagpie; sup: FakeSupervisor }> {
  const magpie = new FakeMagpie();
  magpie.providers.set("alpha", { id: "alpha", name: "alpha" });
  if (opts.consuming) magpie.providers.set("peer-x", { id: "peer-x", preset: "remote-magpie", chat: "https://remote.invalid/v1", key: "sk-remote" });
  const sup = new FakeSupervisor();
  const probes: Partial<Probes> = {
    statusWith: async () => true,
    catalogModels: async () => magpie.metas,
    localModelIds: async () => magpie.models,
    remoteModelIds: async () => ["model/a"],
    remoteLimit: async () => null,
    catalogHttpGet: async () => ({ status: 404, body: "" }),
    catalogServer: () => {
      throw new Error("no catalog server in this test");
    },
  };
  const service = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2038",
    supervisor: sup,
    ports: { ownership: fakePortOwnership() },
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 200,
    probes,
  });
  services.push(service);
  await service.configure({
    sharingEnabled: true,
    consumingEnabled: opts.consuming ?? false,
    networkName: "old-net",
    networkSecret: "old-secret",
  });
  return { service, magpie, sup };
}

describe("phase 8 configure transaction", () => {
  test("a failed reconfigure restores the previous config and keeps it running", async () => {
    const { service, sup } = await configured();
    expect(service.config()?.networkName).toBe("old-net");
    const now = new Date().toISOString();
    (service as any).state.providers = [
      {
        id: "peer-x",
        remoteMagpieId: "peer-x",
        mappedCidr: "10.66.1.9/32",
        providerPort: 3425,
        localPort: 14501,
        keyRef: "provider-keys.json#peer-x",
        fingerprint: null,
        status: "connected",
        detail: null,
        limit: null,
        createdAt: now,
        updatedAt: now,
        lastConnectedAt: now,
      },
    ];
    setProviderKey("peer-x", "sk-pfae-wxrhlp-a-6649");
    sup.failNetwork = "new-net";
    await expect(
      service.configure({ sharingEnabled: true, networkName: "new-net", networkSecret: "new-secret" }),
    ).rejects.toThrow(/previous configuration was restored/);
    expect(service.config()?.networkName).toBe("old-net");
    expect(service.config()?.networkSecret).toBe("old-secret");
    expect(sup.cfg?.networkName).toBe("old-net");
    expect(loadState().state.config?.networkName).toBe("old-net");
    expect(service.provider("peer-x")?.status).toBe("connected");
    expect(getProviderKey("peer-x")).toBe("sk-pfae-wxrhlp-a-6649");
  });

  test("a rollback keeps a stricter suspension produced during the failed apply", async () => {
    const { service, magpie, sup } = await configured();
    // The candidate apply succeeds, then the guard cannot prove the provider
    // split and withdraws sharing. A later status failure forces rollback.
    (magpie as any).providersReadable = () => false;
    (service as any).status = async () => {
      throw new Error("post-apply status failed");
    };
    await expect(
      service.configure({ sharingEnabled: true, networkName: "new-net", networkSecret: "new-secret" }),
    ).rejects.toThrow(/previous configuration was restored/);
    expect(service.config()?.networkName).toBe("old-net");
    const suspended = (service as any).state.shareSuspended;
    expect(suspended).toBeTruthy();
    expect(String(suspended.reason)).toMatch(/provider|safety|native/i);
    // The restored config is applied with sharing inactive; the export is not
    // republished without a passing guard.
    expect(sup.cfg?.networkName).toBe("old-net");
    expect(sup.cfg?.sharingEnabled).toBe(false);
  });

  test("a failed first setup leaves no config and stops the partial core", async () => {
    const magpie = new FakeMagpie();
    magpie.providers.set("alpha", { id: "alpha", name: "alpha" });
    const sup = new FakeSupervisor();
    sup.failNetwork = "first-net";
    const service = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2038",
      supervisor: sup,
      ports: { ownership: fakePortOwnership() },
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 200,
      probes: { statusWith: async () => true, catalogModels: async () => [] },
    });
    services.push(service);
    await expect(
      service.configure({ sharingEnabled: true, networkName: "first-net", networkSecret: "first-secret" }),
    ).rejects.toThrow(/previous configuration was restored/);
    expect(service.config()).toBeNull();
    expect(sup.cfg).toBeNull();
    expect(loadState().state.config).toBeNull();
  });
});

describe("phase 8 cached readiness and local wallet", () => {
  test("checks are cached with the time they ran and readiness is derived from them", async () => {
    const { service } = await configured();
    const snap = service.statusSnapshotForTest();
    expect(snap.checks.length).toBeGreaterThan(0);
    expect(snap.checksAt).toBeTruthy();
    expect(snap.checks.every((c) => c.at === snap.checksAt)).toBe(true);
    expect(snap.readiness.checkedAt).toBe(snap.checksAt);
    expect(snap.readiness.ageMs).toBeGreaterThanOrEqual(0);
    expect(snap.readiness.state).toBe("ready");
  });

  test("a provider with no probe is UNKNOWN, never reachable by default", async () => {
    const { service } = await configured({ consuming: true });
    (service as any).state.providers = [
      {
        id: "peer-x",
        remoteMagpieId: "peer-x",
        mappedCidr: "10.66.1.9/32",
        providerPort: 3425,
        localPort: 14501,
        keyRef: "provider-keys.json#peer-x",
        fingerprint: null,
        status: "disabled",
        detail: null,
        limit: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastConnectedAt: null,
      },
    ];
    expect(service.readinessSnapshot().providers).toEqual([{ id: "peer-x", reachability: "UNKNOWN" }]);
  });

  test("walletEvidence scopes the gateway read to the named consumer and never reconciles others", async () => {
    const magpie = new FakeMagpie();
    const read: string[] = [];
    (magpie as any).limitStatus = async (secret: string) => {
      read.push(secret);
      return { limited: true, key: "k", limit: { costLimit: 1, cost: 0, costLeft: 1 } } as never;
    };
    let statusLocalOpts: any = null;
    const fakeWallet = {
      statusLocal: (opts: any) => {
        statusLocalOpts = opts;
        return { marker: "local" };
      },
      stop: () => {},
    };
    const service = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2038",
      wallet: fakeWallet as never,
      supervisor: new FakeSupervisor(),
      ports: { ownership: fakePortOwnership() },
      lanIp: () => "127.0.0.1",
    });
    services.push(service);
    const consumer = (id: string) => ({ consumerId: id, ledger: { openSettlements: 0 } } as any);
    (service.provisioner as any).all = () => [consumer("alice"), consumer("bob")];
    (service.provisioner as any).find = (id: string) => (id === "alice" || id === "bob" ? { secret: `sk-${id}`, revokedAt: null, paused: null } : undefined);
    (service.provisioner as any).refreshAll = () => {
      throw new Error("refreshAll must not run for evidence");
    };
    (service.provisioner as any).verify = () => {
      throw new Error("verify must not run for evidence");
    };

    const evidence = await service.walletEvidence({ consumerId: "alice" });
    expect(evidence!.consumers.map((c) => c.consumerId)).toEqual(["alice"]);
    expect(read).toEqual(["sk-alice"]);
    expect(statusLocalOpts).toEqual({ consumerIds: ["alice"] });
    expect(evidence!.readbacks.alice).toMatchObject({ capUsd: 1, usedUsd: 0, leftUsd: 1, fromGateway: true });
    expect(evidence!.readbacks.bob).toBeUndefined();
  });

  test("a page snapshot uses Wallet.statusLocal without calling the RPC-backed status", async () => {
    let statusCalls = 0;
    const local = { disabled: false, networks: [], assets: [], totals: { credited: 0, finalized: 0, pending: 0, unclaimed: 0, uncertain: 0, reverted: 0 }, projection: "local" } as any;
    const fakeWallet = {
      statusLocal: () => local,
      status: async () => {
        statusCalls += 1;
        return null;
      },
    };
    const service = new Service({
      magpie: new FakeMagpie() as never,
      magpieVersion: "magpie 0.1.2038",
      wallet: fakeWallet as never,
      supervisor: new FakeSupervisor(),
      ports: { ownership: fakePortOwnership() },
      lanIp: () => "127.0.0.1",
    });
    services.push(service);
    expect(service.statusSnapshotForTest().wallet).toBe(local);
    expect(statusCalls).toBe(0);
  });
});

describe("phase 8 share candidates", () => {
  test("only native models are candidates and an incomplete price blocks a key", async () => {
    const { service, magpie } = await configured({ consuming: true });
    magpie.providers.set("peer-x", { id: "peer-x", preset: "remote-magpie", chat: "https://remote.invalid/v1", key: "sk-remote" });
    magpie.metas = [
      meta("alpha/a", { input: 1, output: 2, cache_read: 0, cache_write: 0 }),
      meta("alpha/b", null),
      meta("peer-x/c", { input: 1, output: 2, cache_read: 0, cache_write: 0 }),
      meta("group/g", { input: 1, output: 2, cache_read: 0, cache_write: 0 }),
    ];
    const view = await service.shareCandidates();
    expect(view.models.map((m) => m.id)).toEqual(["alpha/a", "alpha/b"]);
    expect(view.models.find((m) => m.id === "alpha/a")!.completePrice).toBe(true);
    expect(view.models.find((m) => m.id === "alpha/b")!.completePrice).toBe(false);
    expect(view.priceVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(view.priceLocked).toBe(false);
    expect(view.blocking.map((b) => b.id)).toEqual(["alpha/b"]);
  });
});

describe("phase 8 targeted remote probe", () => {
  test("providerModels reads only the named provider, and reconcile --only skips the others", async () => {
    const { service, magpie, sup } = await configured({ consuming: true });
    const now = new Date().toISOString();
    const rec = (id: string, localPort: number, mapped: string) => ({
      id,
      remoteMagpieId: id,
      mappedCidr: mapped,
      providerPort: 3425,
      localPort,
      keyRef: `provider-keys.json#${id}`,
      fingerprint: null,
      status: "connected",
      detail: null,
      limit: null,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: now,
    });
    (service as any).state.providers = [rec("peer-a", 14501, "10.66.1.2/32"), rec("peer-b", 14502, "10.66.1.3/32")];
    setProviderKey("peer-a", "sk-test-peer-a-0001");
    setProviderKey("peer-b", "sk-test-peer-b-0001");
    magpie.providers.set("peer-a", { id: "peer-a", preset: "remote-magpie", chat: "http://127.0.0.1:14501/v1", key: "sk-test-peer-a-0001" });
    magpie.providers.set("peer-b", { id: "peer-b", preset: "remote-magpie", chat: "http://127.0.0.1:14502/v1", key: "sk-test-peer-b-0001" });
    sup.route("10.66.1.2", "ohmyaihub-a");
    sup.route("10.66.1.3", "ohmyaihub-b");
    sup.forwards = [
      { protocol: "tcp", bindAddr: "127.0.0.1:14501", dstAddr: "10.66.1.2:3425" },
      { protocol: "tcp", bindAddr: "127.0.0.1:14502", dstAddr: "10.66.1.3:3425" },
    ];
    const probed: number[] = [];
    (service as any).probes.remoteModelIds = async (port: number) => {
      probed.push(port);
      return [`${port}/model`];
    };
    (service as any).probes.localModelIds = async () => ["peer-a/model", "peer-b/model"];

    const one = await service.providerModels("peer-a");
    expect(one.models).toEqual(["14501/model"]);
    expect(probed).toEqual([14501]);

    probed.length = 0;
    await service.reconcileProviders({ only: "peer-a", verifyModels: true, quiet: true });
    expect(probed).toEqual([14501]);
    expect(getProviderKey("peer-b")).toBe("sk-test-peer-b-0001");
  });
});
