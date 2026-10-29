import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type Probes } from "../src/service.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import type { CatalogModelMeta, ProviderRecord } from "../src/magpie.ts";
import { loadOrCreateCatalogIdentity, signCatalog, verifySignedCatalog, type CatalogIdentity, type CatalogModel, type CatalogQuoteBody, type SignedCatalog } from "../src/catalog.ts";
import { getProviderKey } from "../src/state.ts";

// Service-level catalogue tests: a fake Magpie, a fake supervisor, a fake
// read-only HTTP server and an in-memory peer. No overlay, no real Magpie and
// no listener is opened on the LAN.

interface FakeKey {
  id: string;
  name: string;
  secret: string;
  models: string[];
  cap: number;
  used: number;
  calls: number;
}

class FakeMagpie {
  providers = new Map<string, ProviderRecord>();
  native = new Set(["alpha", "beta"]);
  keys = new Map<string, FakeKey>();
  models: string[] = ["alpha/a", "alpha/b", "beta/c"];
  metas: CatalogModelMeta[] = [];
  removed: string[] = [];
  private n = 0;

  keyByName(name: string) {
    for (const k of this.keys.values()) if (k.name === name) return { ...k, limit: { period: "day", cost: k.cap } };
    return undefined;
  }
  keyById(id: string) {
    const k = this.keys.get(id);
    return k ? { ...k, limit: { period: "day", cost: k.cap } } : undefined;
  }
  async addKey(name: string) {
    const id = `id${++this.n}`;
    const k: FakeKey = { id, name, secret: `sk-test-${id}-${name}`, models: [], cap: 0, used: 0, calls: 0 };
    this.keys.set(id, k);
    return { ...k, limit: null };
  }
  async setModels(id: string, models: string[]) {
    this.keys.get(id)!.models = [...models];
  }
  async setCostLimit(id: string, _w: string, usd: number) {
    this.keys.get(id)!.cap = usd;
  }
  async setQuotasOff() {}
  async removeKey(id: string) {
    this.removed.push(id);
    this.keys.delete(id);
  }
  async limitStatus(secret: string) {
    const k = [...this.keys.values()].find((x) => x.secret === secret);
    if (!k) throw new Error("no such key");
    return {
      limited: k.cap > 0,
      key: k.name,
      limit: { period: "day", costLimit: k.cap, cost: k.used, costLeft: Math.max(k.cap - k.used, 0), calls: k.calls, spent: k.used >= k.cap },
    } as never;
  }
  providersReadable() {
    return true;
  }
  providers_() {
    return [...this.providers.values()];
  }
  providerById(id: string) {
    return this.providers.get(id);
  }
  nativeProviderIds() {
    return new Set(this.native);
  }
  remoteProviderIds() {
    return new Set([...this.providers.values()].filter((p) => p.preset === "remote-magpie").map((p) => p.id));
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
  addManualProvider(id: string) {
    this.providers.set(id, { id, name: "Hand made", chat: "https://api.example.com/v1" });
  }
  async modelIds() {
    const ids = [...this.models];
    for (const p of this.providers.values()) if (p.preset === "remote-magpie") ids.push(`${p.id}/alpha/remote`);
    return ids;
  }
  async catalogModels() {
    return [...this.metas];
  }
}

class FakeSupervisor {
  cfg: EasytierConfig | null = null;
  forwards: PortForward[] = [];
  routeRows: RouteRow[] = [];
  peerRows: Peer[] = [];
  starts = 0;

  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    this.cfg = { ...cfg, portForwards: cfg.portForwards.map((f) => ({ ...f })) };
    this.starts += 1;
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
      secureMode: cfg?.secureMode ?? false,
      socks5Port: cfg?.socks5Proxy ? Number(new URL(cfg.socks5Proxy).port) : null,
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
  route(mapped: string, hostname: string, ipv4: string) {
    this.routeRows = this.routeRows.filter((r) => r.hostname !== hostname);
    this.routeRows.push({ ipv4, hostname, proxyCidrs: `10.0.0.1->${mapped}`, nextHop: "DIRECT", pathLen: 1 });
  }
}

interface FakeServer {
  port: number;
  started: number;
  stopped: number;
  doc: SignedCatalog | null;
  stop: () => void;
}

function identity(): CatalogIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const raw = Buffer.from(jwk.x!, "base64url");
  const pub = raw.toString("base64");
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  return {
    summary: { algorithm: "ed25519", publicKey: pub, fingerprint, keyId: fingerprint.slice(0, 16), createdAt: "2026-10-30T00:00:00.000Z" },
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

function model(id: string): CatalogModel {
  return {
    id,
    displayName: null,
    gatewayApis: ["chat", "responses"],
    nativeApis: ["chat"],
    contextWindow: 1000,
    maxOutputTokens: 100,
    images: false,
    modalities: null,
    reasoningLevels: null,
    pricing: { unit: "USD per 1M tokens", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, source: "magpie-settings" },
    capabilitiesSource: "magpie-settings",
  };
}

function quote(id: string, ident: CatalogIdentity, mapped: string, models: CatalogModel[]): SignedCatalog {
  const body: CatalogQuoteBody = {
    schema: "ohmyaihub.catalog/v1",
    node: {
      id,
      displayName: `ohmyaihub-${id}`,
      hostname: `ohmyaihub-${id}`,
      virtualIpv4: "10.77.0.9",
      mappedCidr: mapped,
      gatewayPort: 3425,
      catalogPort: 3426,
      contact: null,
    },
    publication: { status: "published", version: 1, updatedAt: "2026-10-30T00:00:00.000Z", publishedAt: "2026-10-30T00:00:00.000Z", note: "read only" },
    models,
    topUp: { minUsd: 1, simulated: true, note: "simulated" },
    identity: ident.summary,
  };
  return signCatalog(body, ident);
}

function meta(id: string, price: boolean): CatalogModelMeta {
  return {
    id,
    displayName: null,
    gatewayApis: ["chat", "responses"],
    nativeApis: ["chat"],
    contextWindow: 128000,
    maxOutputTokens: 4096,
    images: false,
    modalities: null,
    reasoningLevels: null,
    price: price ? { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 } : null,
    priceSource: price ? "magpie-settings" : null,
    capabilitiesSource: "magpie-settings",
  };
}

let services: Service[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
let fakeServer: FakeServer | null;
let serverStarts = 0;
let fetchMap: Map<string, string>;
let probed: string[];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-catalog-service-"));
  process.chdir(dir);
  magpie = new FakeMagpie();
  magpie.metas = [meta("alpha/a", true), meta("alpha/b", false), meta("beta/c", true), meta("peer-b/alpha/remote", true)];
  sup = new FakeSupervisor();
  fakeServer = null;
  serverStarts = 0;
  fetchMap = new Map();
  probed = [];
});

afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
});

function probes(extra: Partial<Probes> = {}): Partial<Probes> {
  return {
    statusWith: async () => true,
    remoteModelIds: async () => ["alpha/model"],
    localModelIds: async () => magpie.modelIds(),
    catalogModels: async () => magpie.metas,
    remoteLimit: async () => ({ limited: true, key: "k", limit: { period: "day", calls: 2, cost: 0.25, costLimit: 1, costLeft: 0.75, spent: false } }),
    catalogHttpGet: async ({ host }) => {
      probed.push(host);
      const body = fetchMap.get(host);
      return body ? { status: 200, body } : { status: 404, body: "" };
    },
    catalogServer: (opts) => {
      serverStarts += 1;
      fakeServer = { port: opts.port, started: 1, stopped: 0, doc: null, stop: () => { fakeServer!.stopped += 1; } };
      const handle = {
        port: opts.port,
        stop: () => fakeServer?.stop(),
      };
      return handle;
    },
    ...extra,
  };
}

async function service(opts: { catalog?: boolean; discovery?: boolean; sharing?: boolean; consuming?: boolean; extra?: Partial<Probes> } = {}): Promise<Service> {
  const s = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2038",
    supervisor: sup,
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 200,
    probes: probes(opts.extra),
  });
  services.push(s);
  await s.configure({
    sharingEnabled: opts.sharing ?? true,
    consumingEnabled: opts.consuming ?? true,
    networkName: "catalog-lab",
    networkSecret: "catalog-lab-secret",
    catalogEnabled: opts.catalog ?? true,
    catalogDiscovery: opts.discovery ?? false,
    catalogPort: 3426,
    catalogSocksPort: 13400,
  });
  return s;
}

function selfPeer(): Peer {
  return { ipv4: "10.77.0.2", hostname: "ohmyaihub-self", cost: "Local", latencyMs: "-", loss: "-", tunnel: "-", nat: "Unknown", id: "1" };
}
function peer(host: string, ip: string): Peer {
  return { ipv4: ip, hostname: host, cost: "p2p", latencyMs: "1.2", loss: "0.0%", tunnel: "tcp", nat: "PortRestricted", id: "2" };
}

describe("catalogue publication", () => {
  test("publishes only native models in the allow list, with prices and no secrets", async () => {
    sup.peerRows = [selfPeer()];
    const s = await service();
    const st = s.catalogStatus();
    expect(st.publishing).toBe(true);
    expect(st.server.running).toBe(true);
    const quote = s.localCatalog()!;
    expect(quote.models.map((m) => m.id)).toEqual(["alpha/a", "alpha/b", "beta/c"]);
    expect(quote.models[0].pricing?.input).toBe(1);
    expect(quote.models[1].pricing).toBeNull();
    expect(quote.models.some((m) => m.id.startsWith("peer-b/"))).toBe(false);
    expect(quote.identity.fingerprint).toHaveLength(64);
    expect(verifySignedCatalog(quote).quote.node.mappedCidr).toBe(s.config()!.mappedCidr ?? "");
    const text = JSON.stringify(quote);
    expect(text).not.toContain("catalog-lab-secret");
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("api.example.com");
    expect(text).not.toContain("privateKey");
    expect(text).not.toContain("peer-b");
    expect(sup.cfg!.publishedPorts).toContain(3426);
    expect(sup.cfg!.publishedPorts.length).toBeGreaterThanOrEqual(2);
  });

  test("unpublishing stops the listener and removes the Forward port", async () => {
    const s = await service();
    expect(sup.cfg!.publishedPorts).toContain(3426);
    const before = sup.starts;
    await s.setCatalogPublishing(false);
    expect(s.catalogStatus().publishing).toBe(false);
    expect(s.catalogStatus().server.running).toBe(false);
    expect(sup.cfg!.publishedPorts).not.toContain(3426);
    expect(sup.starts).toBe(before + 1);
    expect(s.localCatalog()).toBeNull();
    expect(fakeServer!.stopped).toBe(1);
  });

  test("a quote version rises only when the signed content changes", async () => {
    const s = await service();
    const v1 = s.catalogStatus().quote!.version;
    await s.setShareModels(["alpha/a"]);
    const v2 = s.catalogStatus().quote!.version;
    expect(v2).toBe(v1 + 1);
    expect(s.localCatalog()!.models.map((m) => m.id)).toEqual(["alpha/a"]);
  });

  test("publishing without sharing is refused", async () => {
    const s = await service({ catalog: false });
    await s.setSharing(false);
    await expect(s.setCatalogPublishing(true)).rejects.toThrow(/requires sharing/);
  });
});

describe("peer discovery", () => {
  test("reads two peers, keeps an offline quote, and warns on a changed key", async () => {
    const idB = identity();
    const idC = identity();
    fetchMap.set("10.66.1.3", JSON.stringify(quote("bbbbbbbb", idB, "10.66.1.3/32", [model("alpha/b")])));
    fetchMap.set("10.66.1.4", JSON.stringify(quote("cccccccc", idC, "10.66.1.4/32", [model("beta/c")])));
    sup.peerRows = [selfPeer(), peer("ohmyaihub-bbbbbbbb", "10.77.0.3"), peer("ohmyaihub-cccccccc", "10.77.0.4")];
    sup.route("10.66.1.3", "ohmyaihub-bbbbbbbb", "10.77.0.3");
    sup.route("10.66.1.4", "ohmyaihub-cccccccc", "10.77.0.4");

    const s = await service({ discovery: true });
    let peers = await s.refreshCatalog();
    expect(peers.filter((p) => p.status !== "self")).toHaveLength(2);
    const b = peers.find((p) => p.hostname === "ohmyaihub-bbbbbbbb")!;
    const c = peers.find((p) => p.hostname === "ohmyaihub-cccccccc")!;
    expect(b.status).toBe("unverified");
    expect(b.quote!.models[0].id).toBe("alpha/b");
    expect(c.quote!.models[0].id).toBe("beta/c");
    expect(probed.sort()).toEqual(["10.66.1.3", "10.66.1.4"]);

    const trusted = await s.trustCatalogPeer("bbbbbbbb");
    expect(trusted.accepted).toBe(true);
    peers = await s.refreshCatalog();
    expect(peers.find((p) => p.hostname === "ohmyaihub-bbbbbbbb")!.status).toBe("verified");
    const request = s.catalogRequest("bbbbbbbb");
    expect(JSON.stringify(request)).not.toContain("sk-");
    expect(request.provider).toMatchObject({ mappedCidr: "10.66.1.3/32", gatewayPort: 3425 });

    // C disappears from EasyTier's peer list: its last quote is kept, marked offline.
    sup.peerRows = [selfPeer(), peer("ohmyaihub-bbbbbbbb", "10.77.0.3")];
    sup.routeRows = sup.routeRows.filter((r) => !r.proxyCidrs.includes("10.66.1.4"));
    peers = await s.refreshCatalog();
    expect(peers.find((p) => p.hostname === "ohmyaihub-cccccccc")!.status).toBe("offline");
    expect(peers.find((p) => p.hostname === "ohmyaihub-cccccccc")!.quote!.models[0].id).toBe("beta/c");
    expect(() => s.catalogRequest("cccccccc")).toThrow(/offline/);

    // C comes back with a different key: a warning, never silent acceptance.
    const idC2 = identity();
    fetchMap.set("10.66.1.4", JSON.stringify(quote("cccccccc", idC2, "10.66.1.4/32", [model("beta/c")])));
    sup.peerRows = [selfPeer(), peer("ohmyaihub-bbbbbbbb", "10.77.0.3"), peer("ohmyaihub-cccccccc", "10.77.0.4")];
    sup.route("10.66.1.4", "ohmyaihub-cccccccc", "10.77.0.4");
    peers = await s.refreshCatalog();
    const changed = peers.find((p) => p.hostname === "ohmyaihub-cccccccc")!;
    expect(changed.status).toBe("identity-changed");
    expect(changed.pendingFingerprint).toBe(idC2.summary.fingerprint);
    expect(changed.identity!.fingerprint).toBe(idC.summary.fingerprint);
    expect(() => s.catalogRequest("cccccccc")).toThrow(/identity/);
    await s.trustCatalogPeer("cccccccc", idC2.summary.fingerprint);
    peers = await s.refreshCatalog();
    expect(peers.find((p) => p.hostname === "ohmyaihub-cccccccc")!.status).toBe("verified");
    expect(() => s.catalogRequest("cccccccc")).not.toThrow();
  });

  test("conflicting routes are shown and never probed", async () => {
    sup.peerRows = [selfPeer(), peer("ohmyaihub-bbbbbbbb", "10.77.0.3"), peer("ohmyaihub-cccccccc", "10.77.0.4")];
    sup.route("10.66.1.3", "ohmyaihub-bbbbbbbb", "10.77.0.3");
    sup.route("10.66.1.3", "ohmyaihub-cccccccc", "10.77.0.4");
    const s = await service({ discovery: true });
    const peers = await s.refreshCatalog();
    expect(peers.find((p) => p.hostname === "ohmyaihub-bbbbbbbb")!.status).toBe("conflict");
    expect(peers.find((p) => p.hostname === "ohmyaihub-cccccccc")!.status).toBe("conflict");
    expect(probed).toHaveLength(0);
  });
});

describe("catalogue never disturbs connections, keys or foreign providers", () => {
  test("refreshing the directory does not restart the core or change a provider", async () => {
    magpie.addManualProvider("hand-made");
    sup.peerRows = [selfPeer()];
    const s = await service({ discovery: true, extra: {
      statusWith: async (_h, port) => port === 14001 || port === 14002,
      remoteModelIds: async () => ["alpha/model"],
    } });
    sup.route("10.66.1.3", "ohmyaihub-bbbbbbbb", "10.77.0.3");
    sup.route("10.66.1.4", "ohmyaihub-cccccccc", "10.77.0.4");
    const b = await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.3/32", key: "sk-test-aaaaaaaaaaaa", providerPort: 3425, localPort: 14001 });
    const c = await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.4/32", key: "sk-test-bbbbbbbbbbbb", providerPort: 3425, localPort: 14002 });
    expect(b.limit?.cost).toBe(0.25);
    expect(c.limit?.cost).toBe(0.25);
    const starts = sup.starts;
    const keyB = getProviderKey("peer-b");
    for (let i = 0; i < 3; i++) await s.refreshCatalog();
    expect(sup.starts).toBe(starts);
    expect(s.providers().map((p) => p.id)).toEqual(["peer-b", "peer-c"]);
    expect(s.providers().every((p) => p.status === "connected")).toBe(true);
    expect(getProviderKey("peer-b")).toBe(keyB);
    expect(magpie.providerById("hand-made")).toBeDefined();
    expect(magpie.providerById("peer-b")!.key).toBe("sk-test-aaaaaaaaaaaa");
    // A catalogue refresh cannot change a key's actual cost cap: the provisioner
    // is not touched at all.
    expect([...magpie.keys.values()].every((k) => k.cap === 0)).toBe(true);
  });

  test("a quote price change does not touch the provider's native limit", async () => {
    sup.peerRows = [selfPeer()];
    const s = await service({ discovery: true, extra: { statusWith: async (_h, port) => port === 14011, remoteModelIds: async () => ["alpha/model"] } });
    sup.route("10.66.1.3", "ohmyaihub-bbbbbbbb", "10.77.0.3");
    const b = await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.3/32", key: "sk-test-aaaaaaaaaaaa", providerPort: 3425, localPort: 14011 });
    expect(b.limit!.costLimit).toBe(1);
    // Change the local sharing quote (not the provider's key) and refresh.
    await s.setShareModels(["alpha/a"]);
    await s.refreshCatalog();
    expect(s.providers()[0].limit!.costLimit).toBe(1);
    expect([...magpie.keys.values()].every((k) => k.cap === 0)).toBe(true);
  });
});

describe("restart", () => {
  test("the publication, its version and the trust survive a host restart", async () => {
    const idB = identity();
    fetchMap.set("10.66.1.3", JSON.stringify(quote("bbbbbbbb", idB, "10.66.1.3/32", [model("alpha/b")])));
    sup.peerRows = [selfPeer(), peer("ohmyaihub-bbbbbbbb", "10.77.0.3")];
    sup.route("10.66.1.3", "ohmyaihub-bbbbbbbb", "10.77.0.3");
    const first = await service({ discovery: true });
    await first.refreshCatalog();
    await first.trustCatalogPeer("bbbbbbbb");
    const version = first.catalogStatus().quote!.version;
    expect(verifySignedCatalog(first.localCatalog()!).quote.node.id).toBe(first.config()!.nodeId);
    await first.stop();

    // A new host loads the same state, the same identity and the same trust.
    const second = await service({ discovery: true });
    expect(second.catalogStatus().quote!.version).toBe(version);
    expect(second.catalogStatus().publishing).toBe(true);
    const peers = await second.refreshCatalog();
    expect(peers.find((p) => p.hostname === "ohmyaihub-bbbbbbbb")!.status).toBe("verified");
    expect(serverStarts).toBeGreaterThanOrEqual(2);
  });
});

describe("existing guard cadence (documented, not a 15s claim for keys)", () => {
  test("the full guard narrows an externally widened key; catalogue refresh does not", async () => {
    const s = await service({ discovery: true });
    const consumer = await s.ensureConsumer("alice", ["alpha/a"], 1);
    const keyId = consumer.keyId;
    magpie.keys.get(keyId)!.models = ["alpha/a", "peer-b/alpha/remote"];
    const result = await s.guardSharedKeys();
    expect(result.narrowed).toContain("alice");
    expect(magpie.keys.get(keyId)!.models).toEqual(["alpha/a"]);
  });
});
