import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import type { ProviderRecord } from "../src/magpie.ts";

// A unit test for the multi-provider service: a fake Magpie (providers +
// Gateway Keys), a fake EasyTier supervisor that behaves like 2.6.4 (a forward
// can be added live but not removed), and real loopback HTTP servers standing in
// for each remote Magpie's gateway. No overlay, no network, no Magpie binary.

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
  native = new Set<string>(["alpha"]);
  keys = new Map<string, FakeKey>();
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
      limit: { period: "day", costLimit: k.cap, cost: k.used, costLeft: Math.max(k.cap - k.used, 0), calls: k.calls, spent: k.used >= k.cap, reset: "2026-11-01T00:00:00+08:00" },
    } as never;
  }

  providers_(): ProviderRecord[] {
    return [...this.providers.values()];
  }
  providersReadable(): boolean {
    return true;
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
  async ensureRemoteProvider(opts: { id: string; url: string; key: string }): Promise<"unchanged" | "added" | "replaced"> {
    const existing = this.providers.get(opts.id);
    const chat = `${opts.url}/v1`;
    if (existing && existing.preset === "remote-magpie" && existing.chat === chat && existing.key === opts.key) return "unchanged";
    const replaced = Boolean(existing);
    this.providers.set(opts.id, { id: opts.id, preset: "remote-magpie", chat, key: opts.key });
    return replaced ? "replaced" : "added";
  }
  async removeProvider(id: string) {
    if (!this.providers.has(id)) throw new Error("no such provider");
    this.providers.delete(id);
  }
  /** Magpie lists a remote Magpie's models as `<remote>/<provider>/<model>`. */
  async modelIds(): Promise<string[]> {
    const ids = [...this.native].map((p) => `${p}/native-model`);
    for (const p of this.providers.values()) {
      if (p.preset === "remote-magpie") ids.push(`${p.id}/alpha/${p.id}-model`);
    }
    return ids;
  }
  addManualProvider(id: string) {
    this.providers.set(id, { id, name: "Hand made", chat: "https://api.example.com/v1" });
  }
}

class FakeSupervisor implements SupervisorLike {
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
  async stop(): Promise<void> {
    this.cfg = null;
    this.forwards = [];
  }
  async refresh(): Promise<SupervisorState> {
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
      aclOk: Boolean(cfg),
      aclProblems: [],
      lanIp: "192.0.2.84",
      lastCheckAt: null,
    };
  }
  async listPortForwards(): Promise<PortForward[]> {
    return this.forwards.map((f) => ({ ...f }));
  }
  async addPortForward(bindAddr: string, dstAddr: string): Promise<boolean> {
    if (this.forwards.some((f) => f.bindAddr === bindAddr && f.dstAddr === dstAddr)) return false;
    if (this.forwards.some((f) => f.bindAddr === bindAddr)) throw new Error(`bind ${bindAddr} is taken`);
    this.forwards.push({ protocol: "tcp", bindAddr, dstAddr });
    return true;
  }
  async removePortForward(): Promise<void> {
    // EasyTier 2.6.4: prints success, keeps the listener.
  }
  setForwards(forwards: ForwardSpec[]): void {
    if (!this.cfg) return;
    this.cfg = { ...this.cfg, portForwards: forwards.map((f) => ({ ...f })) };
  }
  async peers(): Promise<Peer[]> {
    return [...this.peerRows];
  }
  async routes(): Promise<RouteRow[]> {
    return [...this.routeRows];
  }
  route(mapped: string, hostname: string, ipv4 = "10.77.0.2/24") {
    this.routeRows = this.routeRows.filter((r) => !r.proxyCidrs.includes(mapped));
    this.routeRows.push({ ipv4, hostname, proxyCidrs: `192.0.2.84->${mapped}`, nextHop: "DIRECT", pathLen: 1 });
  }
}

/** A loopback stand-in for a remote Magpie's keyed gateway. */
class FakeGateway {
  server: ReturnType<typeof Bun.serve>;
  constructor(
    readonly port: number,
    readonly name: string,
    readonly keys: Set<string>,
  ) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req) => {
        const auth = req.headers.get("authorization") ?? "";
        const key = auth.replace(/^Bearer\s+/i, "");
        if (!this.keys.has(key)) return new Response("no", { status: 401 });
        return Response.json({ object: "list", data: [{ id: `${this.name}-model`, object: "model" }] });
      },
    });
  }
  stop() {
    this.server.stop(true);
  }
}

let services: Service[] = [];
let gateways: FakeGateway[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
let nextPort = 13525;
/** This node's own gateway: it refuses every unkeyed call, like a real one. */
let localGateway: ReturnType<typeof Bun.serve> | null = null;
const LOCAL_GATEWAY_PORT = 13650;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-service-"));
  process.chdir(dir);
  for (const s of services.splice(0)) void s.stop();
  for (const g of gateways.splice(0)) g.stop();
  localGateway?.stop(true);
  localGateway = Bun.serve({
    hostname: "127.0.0.1",
    port: LOCAL_GATEWAY_PORT,
    fetch: () => new Response("no key", { status: 401 }),
  });
  process.env.MAGPIE_ADDR = `127.0.0.1:${LOCAL_GATEWAY_PORT}`;
  magpie = new FakeMagpie();
  sup = new FakeSupervisor();
  nextPort = 13525;
});

async function service(opts: { sharing?: boolean; consuming?: boolean; fresh?: boolean } = {}): Promise<Service> {
  const s = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2038",
    supervisor: sup,
    lanIp: () => "127.0.0.1",
  });
  services.push(s);
  await s.configure({
    sharingEnabled: opts.sharing ?? true,
    consumingEnabled: opts.consuming ?? true,
    networkName: "service-lab",
    networkSecret: "service-lab-secret",
  });
  return s;
}

function gateway(name: string, keys: string[]): FakeGateway {
  const g = new FakeGateway(nextPort, name, new Set(keys));
  gateways.push(g);
  nextPort += 1;
  return g;
}

describe("several remote providers", () => {
  test("two providers coexist, each with its own port, key and registration", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const c = gateway("c", ["sk-test-provider-c-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.3", "ohmyaihub-c0000002");

    const pb = await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    const pc = await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: c.port });

    expect(pb.status).toBe("connected");
    expect(pc.status).toBe("connected");
    expect(pb.localPort).not.toBe(pc.localPort);
    expect(b.port).not.toBe(c.port);
    const providers = magpie.providers_();
    expect(providers.map((p) => p.id).sort()).toEqual(["peer-b", "peer-c"]);
    expect(providers.find((p) => p.id === "peer-b")!.key).toBe("sk-test-provider-b-0001");
    expect(providers.find((p) => p.id === "peer-c")!.key).toBe("sk-test-provider-c-0001");
    expect(s.providers()).toHaveLength(2);
    expect(sup.forwards).toHaveLength(2);
    // the forward set is part of the generated config, so a core restart restores it
    expect(sup.cfg!.portForwards).toHaveLength(2);
  });

  test("adding the same provider twice is idempotent", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    const input = { id: "peer-b" as const, mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port };
    await s.addProvider(input);
    await s.addProvider(input);
    expect(s.providers()).toHaveLength(1);
    expect(sup.forwards).toHaveLength(1);
    expect(magpie.providers_()).toHaveLength(1);
  });

  test("a second provider cannot reuse another provider's mapped address", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const c = gateway("c", ["sk-test-provider-c-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    await expect(
      s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: c.port }),
    ).rejects.toThrow(/already used by provider peer-b/);
    expect(s.providers()).toHaveLength(1);
  });

  test("a mapped prefix announced by two peers is refused, not guessed", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.routeRows = [
      { ipv4: "10.77.0.2/24", hostname: "ohmyaihub-b0000001", proxyCidrs: "192.0.2.84->10.66.1.2", nextHop: "DIRECT", pathLen: 1 },
      { ipv4: "10.77.0.3/24", hostname: "ohmyaihub-other001", proxyCidrs: "192.0.2.85->10.66.1.2", nextHop: "DIRECT", pathLen: 1 },
    ];
    await expect(
      s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port }),
    ).rejects.toThrow(/announces 10\.66\.1\.2 from/);
    expect(s.providers()).toHaveLength(0);
    expect(magpie.providers_()).toHaveLength(0);
  });

  test("connecting to this node's own mapped prefix is refused", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const own = `ohmyaihub-${s.config()!.nodeId}`;
    sup.route("10.66.1.2", own);
    await expect(
      s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port }),
    ).rejects.toThrow(/this node itself/);
    expect(s.providers()).toHaveLength(0);
  });

  test("a failed connect keeps the working providers and leaves no registration", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    // This gateway refuses every key, so the valid-key probe fails after the
    // registration was made: the rollback must undo exactly that.
    const bad = gateway("bad", ["sk-test-some-other-key"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.4", "ohmyaihub-bad00004");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });

    await expect(
      s.addProvider({ id: "peer-bad", mappedCidr: "10.66.1.4/32", key: "sk-test-provider-bad-01", providerPort: 3425, localPort: bad.port }),
    ).rejects.toThrow(/connect failed/);
    expect(s.providers().map((p) => p.id)).toEqual(["peer-b"]);
    expect(magpie.providers_().map((p) => p.id)).toEqual(["peer-b"]);
    expect(s.providers()[0].status).toBe("connected");
  });

  test("removing one provider leaves the other connected", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const c = gateway("c", ["sk-test-provider-c-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.3", "ohmyaihub-c0000002");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: c.port });

    await s.removeProvider("peer-b");
    const left = s.providers();
    expect(left.map((p) => p.id)).toEqual(["peer-c"]);
    expect(magpie.providers_().map((p) => p.id)).toEqual(["peer-c"]);
    expect(sup.forwards.map((f) => f.bindAddr)).toEqual([`127.0.0.1:${c.port}`]);
    expect(left[0].status).toBe("connected");
  });

  test("an offline provider degrades alone; the other keeps working", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const c = gateway("c", ["sk-test-provider-c-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.3", "ohmyaihub-c0000002");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: c.port });

    b.stop();
    const after = await s.reconcileProviders({ verifyModels: true });
    expect(after.find((p) => p.id === "peer-b")!.status).toBe("degraded");
    expect(after.find((p) => p.id === "peer-c")!.status).toBe("connected");
    // a degraded provider is not unregistered: Magpie would just fail its calls
    expect(magpie.providers_().map((p) => p.id).sort()).toEqual(["peer-b", "peer-c"]);
  });

  test("a mapped address taken over by another overlay name is unregistered, then restored", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    expect(s.providers()[0].fingerprint!.hostname).toBe("ohmyaihub-b0000001");

    sup.route("10.66.1.2", "ohmyaihub-imposter");
    const mismatch = await s.reconcileProviders();
    expect(mismatch[0].status).toBe("identity-mismatch");
    expect(mismatch[0].detail).toContain("ohmyaihub-imposter");
    expect(magpie.providers_()).toHaveLength(0);

    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    const back = await s.reconcileProviders();
    expect(back[0].status).toBe("connected");
    expect(magpie.providers_().map((p) => p.id)).toEqual(["peer-b"]);
  });

  test("a restart re-registers a missing provider and restores a missing forward", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const c = gateway("c", ["sk-test-provider-c-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.3", "ohmyaihub-c0000002");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: c.port });

    // Magpie restarted without the registrations; the core lost one forward.
    magpie.providers.clear();
    sup.forwards = sup.forwards.filter((f) => f.bindAddr !== `127.0.0.1:${b.port}`);

    const restarted = await service();
    const providers = await restarted.reconcileProviders({ verifyModels: true });
    expect(providers.map((p) => p.id).sort()).toEqual(["peer-b", "peer-c"]);
    expect(providers.every((p) => p.status === "connected")).toBe(true);
    expect(magpie.providers_().map((p) => p.id).sort()).toEqual(["peer-b", "peer-c"]);
    expect(sup.forwards.map((f) => f.bindAddr).sort()).toEqual([`127.0.0.1:${b.port}`, `127.0.0.1:${c.port}`]);
  });

  test("the key of one provider is not handed to another", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const c = gateway("c", ["sk-test-provider-c-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.3", "ohmyaihub-c0000002");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: c.port });

    // Swapping the keys must fail: each gateway only accepts its own key.
    await expect(
      s.updateProvider("peer-b", { key: "sk-test-provider-c-0001" }),
    ).rejects.toThrow(/connect failed/);
    expect(magpie.providers_().find((p) => p.id === "peer-b")!.key).toBe("sk-test-provider-b-0001");
    expect(s.providers().find((p) => p.id === "peer-b")!.status).toBe("connected");
  });

  test("the update path changes one provider without disturbing the other", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    const c = gateway("c", ["sk-test-provider-c-0001"]);
    const b2 = gateway("b2", ["sk-test-provider-b-0002"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.5", "ohmyaihub-b0000002");
    sup.route("10.66.1.3", "ohmyaihub-c0000002");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: c.port });

    const updated = await s.updateProvider("peer-b", { mappedCidr: "10.66.1.5/32", key: "sk-test-provider-b-0002", localPort: b2.port });
    expect(updated.localPort).toBe(b2.port);
    expect(updated.mappedCidr).toBe("10.66.1.5/32");
    expect(magpie.providers_().find((p) => p.id === "peer-b")!.key).toBe("sk-test-provider-b-0002");
    expect(s.providers().find((p) => p.id === "peer-c")!.status).toBe("connected");
    // 2.6.4 cannot close the old listener live: it is recorded, then dropped by
    // the next core restart (which the generated config makes inevitable).
    expect(s.providers().find((p) => p.id === "peer-b")!.localPort).toBe(b2.port);
    expect(sup.forwards.map((f) => f.bindAddr)).toContain(`127.0.0.1:${b.port}`);
    expect((s as unknown as { state: { orphanForwards: { localPort: number }[] } }).state.orphanForwards.map((o) => o.localPort)).toEqual([b.port]);

    await s.setConsuming(true); // restarts the core from the generated config
    await s.reconcileProviders({ verifyModels: true });
    expect(sup.forwards.map((f) => f.bindAddr).sort()).toEqual([`127.0.0.1:${b2.port}`, `127.0.0.1:${c.port}`].sort());
    expect((s as unknown as { state: { orphanForwards: unknown[] } }).state.orphanForwards).toEqual([]);
  });
});

describe("the two capabilities are independent", () => {
  test("consumption can be switched off without touching a hand-made provider", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    magpie.addManualProvider("my-own-vendor");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });

    await s.setConsuming(false);
    expect(s.config()!.consumingEnabled).toBe(false);
    expect(magpie.providers_().map((p) => p.id)).toEqual(["my-own-vendor"]);
    expect(s.providers()[0].status).toBe("disabled");
    expect(sup.cfg!.consumingEnabled).toBe(false);
    expect(sup.cfg!.portForwards).toHaveLength(0);

    const on = await s.setConsuming(true);
    expect(on.config.consumingEnabled).toBe(true);
    expect(magpie.providers_().map((p) => p.id).sort()).toEqual(["my-own-vendor", "peer-b"]);
    expect(s.providers()[0].status).toBe("connected");
  });

  test("sharing can be switched off without touching this node's own providers", async () => {
    magpie.addManualProvider("my-own-vendor");
    const s = await service();
    expect(s.config()!.sharingEnabled).toBe(true);
    expect(sup.cfg!.proxyCidr).toBe("127.0.0.1/32");
    const mapped = s.config()!.mappedCidr;

    await s.setSharing(false);
    expect(s.config()!.sharingEnabled).toBe(false);
    expect(sup.cfg!.sharingEnabled).toBe(false);
    expect(sup.cfg!.proxyCidr).toBeNull();
    expect(sup.cfg!.mappedCidr).toBeNull();
    // the address consumers already know is kept for when sharing comes back
    expect(s.config()!.mappedCidr).toBe(mapped);
    expect(magpie.nativeProviderIds().has("alpha")).toBe(true);
    expect(magpie.providers_().map((p) => p.id)).toEqual(["my-own-vendor"]);

    await s.setSharing(true);
    expect(sup.cfg!.proxyCidr).toBe("127.0.0.1/32");
    expect(s.config()!.mappedCidr).toBe(mapped);
  });

  test("a dual node keeps both roles in one EasyTier configuration", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    expect(sup.cfg!.sharingEnabled).toBe(true);
    expect(sup.cfg!.consumingEnabled).toBe(true);
    expect(sup.cfg!.proxyCidr).toBeTruthy();
    expect(sup.cfg!.portForwards).toHaveLength(1);
    // one core for both: configure/connect never start a second one
    expect(sup.starts).toBeGreaterThan(0);
  });
});

describe("sharing only this node's own models", () => {
  test("a remote provider's models cannot be issued to a consumer", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });

    await expect(s.ensureConsumer("carol", ["peer-b/alpha/peer-b-model"], 1)).rejects.toThrow(/remote Magpie/);
    await expect(s.ensureConsumer("carol", ["group/auto-pick"], 1)).rejects.toThrow(/routing group/);
    await expect(s.ensureConsumer("carol", ["nope/model"], 1)).rejects.toThrow(/not a provider on this Magpie/);
    expect(magpie.keys.size).toBe(0);

    const ok = await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    expect(ok.models).toEqual(["alpha/native-model"]);
  });

  test("the sharing allow list bounds every key", async () => {
    const s = await service();
    await s.setShareModels(["alpha/native-model"]);
    await expect(s.ensureConsumer("carol", ["alpha/other-model"], 1)).rejects.toThrow(/allow list/);
    const ok = await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    expect(ok.keyName).toBe("ohmyaihub-carol");
  });

  test("narrowing the allow list narrows an issued key, and revokes it when nothing is left", async () => {
    const s = await service();
    await s.setShareModels(["alpha/*"]);
    const c = await s.ensureConsumer("carol", ["alpha/a", "alpha/b"], 1);
    expect(c.models).toEqual(["alpha/a", "alpha/b"]);

    await s.setShareModels(["alpha/a"]);
    const narrowed = s.provisioner.find("carol")!;
    expect(narrowed.models).toEqual(["alpha/a"]);

    await s.setShareModels(["nothing/*"]);
    expect(s.provisioner.find("carol")!.revokedAt).not.toBeNull();
    expect(magpie.keys.size).toBe(0);
  });

  test("a provider that became a Remote Magpie under the same id is not shared", async () => {
    const s = await service();
    await s.setShareModels(["*"]);
    await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    // alpha is replaced by a Remote Magpie with the same id
    magpie.native.delete("alpha");
    magpie.providers.set("alpha", { id: "alpha", preset: "remote-magpie", chat: "http://127.0.0.1:1/v1" });
    const result = await s.guardSharedKeys();
    expect(result.revoked).toEqual(["carol"]);
    expect(magpie.keys.size).toBe(0);
  });
});

describe("an unreadable provider list fails closed", () => {
  test("no key is issued or revoked from a transient read failure", async () => {
    const s = await service();
    await s.setShareModels(["*"]);
    await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    const real = magpie.providersReadable.bind(magpie);
    magpie.providersReadable = () => false;
    await expect(s.ensureConsumer("dave", ["alpha/native-model"], 1)).rejects.toThrow(/cannot read Magpie's provider list/);
    const guard = await s.guardSharedKeys();
    expect(guard).toEqual({ narrowed: [], revoked: [] });
    expect(s.provisioner.find("carol")!.revokedAt).toBeNull();
    const report = await s.checks();
    const check = report.find((c) => c.name === "shared-models-native-only");
    expect(check?.ok).toBe(false);
    magpie.providersReadable = real;
  });
});

describe("secrets stay out of the status", () => {
  test("no provider key appears in status or in the snapshot", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    const status = await s.status();
    const text = JSON.stringify(status);
    expect(text).not.toContain("sk-test-provider-b-0001");
    expect(text).not.toContain("service-lab-secret");
    expect(status.providers[0].keyRef).toContain("provider-keys.json#");
  });
});
