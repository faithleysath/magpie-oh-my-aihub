// A wildcard share policy must never be stored or silently widened on boot.
// Advanced callers get an exact, priced native snapshot only after an explicit
// confirmation; legacy "*" boots withdraw the export and keep the ledger.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import type { CatalogModelMeta } from "../src/magpie.ts";
import { FakeBinder, FakeOwnership } from "./support/fake-ports.ts";
import { loadState, saveState } from "../src/state.ts";
import { consoleAction } from "../src/console-api.ts";
import { ConsoleInputError } from "../src/console-server.ts";

const NATIVE = "alpha";
const PRICED = "alpha/priced-model";
const PRICED2 = "alpha/other-priced-model";
const UNPRICED = "alpha/unpriced-model";

class FakeMagpie {
  native = new Set([NATIVE]);
  providers = new Map<string, { id: string; preset: string; chat: string; key: string }>();
  providersReadable() { return true; }
  nativeProviderIds() { return new Set(this.native); }
  remoteProviderIds() { return new Set<string>(); }
  providerById(id: string) { return this.providers.get(id); }
  keyById() { return undefined; }
  async modelIds() { return [`${NATIVE}/priced-model`]; }
  async addRemoteProvider() {}
  async replaceRemoteProvider() {}
  async removeProvider() {}
}

class FakeSupervisor implements SupervisorLike {
  cfg: EasytierConfig | null = null;
  forwards: PortForward[] = [];
  peerRows: Peer[] = [];
  routeRows: RouteRow[] = [];
  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    this.cfg = { ...cfg, portForwards: cfg.portForwards.map((f) => ({ ...f })) };
    this.forwards = (cfg.portForwards ?? []).map((f: ForwardSpec) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
    return this.snapshot();
  }
  async stop(): Promise<void> { this.cfg = null; }
  async refresh(): Promise<SupervisorState> { return this.snapshot(); }
  async listPortForwards(): Promise<PortForward[]> { return [...this.forwards]; }
  async addPortForward(bindAddr: string, dstAddr: string) { this.forwards.push({ protocol: "tcp", bindAddr, dstAddr }); return true; }
  async removePortForward() {}
  setForwards(forwards: ForwardSpec[]) { this.forwards = forwards.map((f) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr })); }
  async peers(): Promise<Peer[]> { return [...this.peerRows]; }
  async routes(): Promise<RouteRow[]> { return [...this.routeRows]; }
  snapshot(): SupervisorState {
    const cfg = this.cfg;
    return {
      sharingEnabled: cfg?.sharingEnabled ?? false, consumingEnabled: cfg?.consumingEnabled ?? false,
      hostname: cfg ? `ohmyaihub-${cfg.nodeId}` : null, running: Boolean(cfg), pid: cfg ? 4242 : null,
      startedAt: cfg ? "2026-10-31T00:00:00.000Z" : null, restarts: 0, lastError: null,
      coreVersion: cfg ? "easytier-core 2.6.4-fake" : null, rpcPort: cfg?.rpcPort ?? null,
      networkName: cfg?.networkName ?? null, virtualIpv4: cfg?.virtualIpv4 ?? null,
      proxyCidr: cfg?.sharingEnabled ? cfg.proxyCidr : null, mappedCidr: cfg?.sharingEnabled ? cfg.mappedCidr : null,
      publishedPorts: cfg?.publishedPorts ?? [], peers: [], peersAt: cfg ? "2026-10-31T00:00:05.000Z" : null,
      routes: [], routesAt: cfg ? "2026-10-31T00:00:05.000Z" : null, secureMode: false,
      socks5Port: null, aclOk: Boolean(cfg), aclProblems: [], lanIp: "127.0.0.1", lastCheckAt: null,
    };
  }
}

let dir: string;
let services: Service[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
let binder: FakeBinder;
let ownership: FakeOwnership;

function meta(id: string, price: CatalogModelMeta["price"]): CatalogModelMeta {
  return {
    id, displayName: id, gatewayApis: ["chat"], nativeApis: null, contextWindow: null, maxOutputTokens: null,
    images: null, modalities: null, reasoningLevels: null, price, priceSource: "magpie-gateway", capabilitiesSource: "magpie-gateway",
  };
}
function catalogModels(): CatalogModelMeta[] {
  return [
    meta(PRICED, { input: 1, output: 2, cache_read: 0, cache_write: 0 }),
    meta(PRICED2, { input: 2, output: 3, cache_read: 0, cache_write: 0 }),
    meta(UNPRICED, {}),
  ];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-share-consent-"));
  process.chdir(dir);
  for (const s of services.splice(0)) void s.stop();
  magpie = new FakeMagpie();
  sup = new FakeSupervisor();
  binder = new FakeBinder();
  ownership = new FakeOwnership();
  ownership.defaultPids = [4242, process.pid];
});

async function service(): Promise<Service> {
  const svc = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2289",
    supervisor: sup,
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 100,
    ports: { binder, ownership, now: () => new Date("2026-10-31T00:00:10.000Z") },
    probes: {
      catalogModels: async () => catalogModels(),
      statusWith: async () => true,
      remoteModelIds: async () => ["peer-model"],
      localModelIds: async () => ["peer/peer-model"],
      remoteLimit: async () => null,
      catalogServer: ({ port }) => ({ port, stop: () => {} }),
      catalogHttpGet: async () => ({ status: 404, body: "" }),
    },
  });
  services.push(svc);
  await svc.configure({ sharingEnabled: false, consumingEnabled: true, networkName: "share-consent-lab", networkSecret: "share-consent-secret" });
  return svc;
}

async function legacyWildcard(svc: Service): Promise<void> {
  const state = (svc as unknown as { state: ReturnType<typeof loadState>["state"] }).state;
  state.config!.sharingEnabled = true;
  state.config!.share = { models: ["*"] };
  state.shareSuspended = null;
  saveState(state);
}

describe("wildcard sharing consent", () => {
  test("a legacy wildcard boot withdraws the export and does not auto-resume", async () => {
    const svc = await service();
    await legacyWildcard(svc);
    const nodeId = svc.config()!.nodeId;
    await svc.start();
    const state = loadState().state;
    expect(state.config!.nodeId).toBe(nodeId);
    expect(state.shareSuspended?.reason).toMatch(/share-policy-required/);
    expect(sup.cfg!.sharingEnabled).toBe(false);
    expect(sup.cfg!.proxyCidr).toBeNull();
    const guard = await svc.guardSharedKeys();
    expect(guard.suspended).toBe(true);
    expect(loadState().state.shareSuspended?.reason).toMatch(/share-policy-required/);
  });

  test("a wildcard cannot be stored without an explicit exact confirmation", async () => {
    const svc = await service();
    await svc.setShareModels([PRICED], { strict: true });
    await expect(svc.setShareModels(["*"], { strict: true })).rejects.toThrow(/confirmExact/);
    expect(svc.config()!.share.models).toEqual([PRICED]);
  });

  test("confirmExact expands to the priced native snapshot only", async () => {
    const svc = await service();
    await svc.setShareModels(["*"], { confirmExact: true, strict: true });
    expect(svc.config()!.share.models).toEqual([PRICED, PRICED2].sort());
    expect(svc.config()!.share.models).not.toContain(UNPRICED);
    expect(svc.config()!.share.models).not.toContain("*");
  });

  test("an exact list is still checked against the native priced snapshot", async () => {
    const svc = await service();
    await expect(svc.setShareModels(["beta/not-native"], { strict: true })).rejects.toThrow(/not a native model|unverified/);
    await expect(svc.setShareModels([UNPRICED], { strict: true })).rejects.toThrow(/complete effective price/);
    expect(svc.config()!.share.models).toEqual(["*"]); // untouched from configure default
  });

  test("the public configure path refuses a wildcard shareModels", async () => {
    const svc = await service();
    const before = structuredClone(svc.config()!);
    await expect(
      consoleAction(svc, "configure", {
        sharingEnabled: true,
        shareModels: ["*"],
        networkName: "share-consent-lab",
        networkSecret: "share-consent-secret",
      }),
    ).rejects.toBeInstanceOf(ConsoleInputError);
    expect(svc.config()!.nodeId).toBe(before.nodeId);
    expect(svc.config()!.share.models).toEqual(before.share.models);
  });

  test("strict configure validates exact models against native priced snapshot", async () => {
    const svc = await service();
    const base = { networkName: "share-consent-lab", networkSecret: "share-consent-secret", sharingEnabled: true };
    await expect(
      svc.configure({ ...base, shareModels: ["beta/remote-model"] }, { strictShareModels: true }),
    ).rejects.toThrow(/not a native model|unverified/);
    await expect(
      svc.configure({ ...base, shareModels: [UNPRICED] }, { strictShareModels: true }),
    ).rejects.toThrow(/complete effective price/);
    const ok = await svc.configure({ ...base, shareModels: [PRICED] }, { strictShareModels: true });
    expect(ok.config.share.models).toEqual([PRICED]);
    expect(ok.config.sharingEnabled).toBe(true);
  });

  test("an explicit shareNativeModels selection clears the legacy policy suspension", async () => {
    const svc = await service();
    await legacyWildcard(svc);
    await svc.start();
    const out = await svc.shareNativeModels({ models: [PRICED], confirm: true });
    expect(out.config.share.models).toEqual([PRICED]);
    expect(out.config.sharingEnabled).toBe(true);
    expect(loadState().state.shareSuspended).toBeNull();
    expect(sup.cfg!.sharingEnabled).toBe(true);
  });
});
