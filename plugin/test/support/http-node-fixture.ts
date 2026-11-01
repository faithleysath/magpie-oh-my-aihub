// Test-only Magpie/Supervisor fixtures for the real-HTTP two-Service journey.
// This file is included in the test tree only; production code never imports it.

import type { CatalogModelMeta, ProviderRecord } from "../../src/magpie.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../../src/easytier.ts";
import { LAB_MODEL, LAB_PRICE, type FakeKey } from "./fake-magpie.ts";

export { LAB_MODEL, LAB_PRICE };
export type { FakeKey };

export class HttpFixtureMagpie {
  keys = new Map<string, FakeKey>();
  providers = new Map<string, ProviderRecord>();
  native = new Set(["lab"]);
  models: string[] = [LAB_MODEL];
  metas: CatalogModelMeta[] = [
    {
      id: LAB_MODEL,
      price: LAB_PRICE,
      displayName: null,
      gatewayApis: ["chat"],
      nativeApis: ["chat"],
      contextWindow: null,
      maxOutputTokens: null,
      images: null,
      modalities: null,
      reasoningLevels: null,
      priceSource: "magpie-settings",
      capabilitiesSource: "magpie-settings",
    } as unknown as CatalogModelMeta,
  ];
  private n = 0;

  providersReadable() {
    return true;
  }
  nativeProviderIds() {
    return new Set(this.native);
  }
  remoteProviderIds() {
    return new Set([...this.providers.values()].filter((p) => p.preset === "remote-magpie").map((p) => p.id));
  }
  providers_() {
    return [...this.providers.values()];
  }
  providerById(id: string) {
    return this.providers.get(id);
  }
  keyByName(name: string) {
    for (const k of this.keys.values()) if (k.name === name) return { ...k, limit: { period: "day", cost: k.cap } };
    return undefined;
  }
  keyById(id: string) {
    const k = this.keys.get(id);
    return k ? { ...k, limit: { period: "day", cost: k.cap } } : undefined;
  }
  keyList() {
    return [...this.keys.values()].map((k) => ({ ...k }));
  }
  async addKey(name: string, secret?: string) {
    const id = `hk${++this.n}`;
    const now = Date.now();
    const key: FakeKey = {
      id,
      name,
      secret: secret ?? `sk-fixture-${id}-${"x".repeat(24)}`,
      models: [],
      cap: 0,
      start: now,
      reset: now + 3650 * 86_400_000,
      window: "3650d",
      calls: 0,
    };
    this.keys.set(id, key);
    return { ...key, limit: null };
  }
  async setModels(id: string, models: string[]) {
    this.keys.get(id)!.models = [...models];
  }
  async setQuotasOff() {}
  async setCostLimit(id: string, _window: string, usd: number) {
    this.keys.get(id)!.cap = usd;
  }
  async removeKey(id: string) {
    this.keys.delete(id);
  }
  async rotateKey(id: string) {
    const k = this.keys.get(id);
    if (!k) return null;
    k.secret = `${k.secret}-rotated`;
    return k.secret;
  }
  async limitStatus(secret: string) {
    const k = [...this.keys.values()].find((x) => x.secret === secret);
    if (!k) {
      const error = new Error("HTTP 401: the key is not accepted") as Error & { status: number };
      error.status = 401;
      throw error;
    }
    const used = 0;
    const noLimit = k.cap === 0;
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
            costLeft: k.cap,
            calls: 0,
            spent: false,
          },
    } as never;
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
  async modelIds() {
    const ids = [...this.models];
    for (const p of this.providers.values()) if (p.preset === "remote-magpie") ids.push(`${p.id}/lab/lab-model`);
    return ids;
  }
  async catalogModels() {
    return [...this.metas];
  }
}

export class HttpFixtureSupervisor {
  cfg: EasytierConfig | null = null;
  forwards: PortForward[] = [];
  peerRows: Peer[] = [];
  routeRows: RouteRow[] = [];
  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    this.cfg = { ...cfg };
    this.forwards = cfg.portForwards.map((f: ForwardSpec) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
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
      startedAt: cfg ? "2026-10-31T00:00:00.000Z" : null,
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
      secureMode: cfg?.secureMode ?? false,
      socks5Port: cfg?.socks5Proxy ? Number(new URL(cfg.socks5Proxy).port) : null,
      aclOk: Boolean(cfg),
      aclProblems: [],
      lanIp: "192.0.2.84",
      lastCheckAt: null,
    };
  }
  async listPortForwards() {
    return this.forwards.map((f) => ({ ...f }));
  }
  async addPortForward(bindAddr: string, dstAddr: string) {
    if (this.forwards.some((f) => f.bindAddr === bindAddr)) return false;
    this.forwards.push({ protocol: "tcp", bindAddr, dstAddr });
    return true;
  }
  async removePortForward() {}
  setForwards(forwards: ForwardSpec[]) {
    if (this.cfg) this.cfg = { ...this.cfg, portForwards: forwards };
  }
  async peers() {
    return [...this.peerRows];
  }
  async routes() {
    return [...this.routeRows];
  }
}
