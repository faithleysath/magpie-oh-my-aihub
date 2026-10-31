import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { expectBlocked, isTestServerAllowed, registerTestServer, unregisterTestServer } from "./support/network-guard.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import type { ProviderRecord } from "../src/magpie.ts";
import { FORWARD_PORT_FROM, FORWARD_PORT_TO, getProviderKey } from "../src/state.ts";

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
  addCalls = 0;
  replaceCalls = 0;
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
  async addRemoteProvider(opts: { id: string; url: string; key: string }): Promise<void> {
    this.addCalls += 1;
    if (this.providers.has(opts.id)) throw new Error(`provider ${opts.id} already exists`);
    this.providers.set(opts.id, { id: opts.id, preset: "remote-magpie", chat: `${opts.url}/v1`, key: opts.key });
  }
  async replaceRemoteProvider(opts: { id: string; url: string; key: string }): Promise<void> {
    this.replaceCalls += 1;
    this.providers.delete(opts.id);
    await this.addRemoteProvider(opts);
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
      socks5Port: cfg?.socks5Proxy ? Number(new URL(cfg.socks5Proxy).port) : null,
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
  /** The address the OS actually bound; nothing here guesses a port number. */
  readonly port: number;
  constructor(
    readonly name: string,
    readonly keys: Set<string>,
  ) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const auth = req.headers.get("authorization") ?? "";
        const key = auth.replace(/^Bearer\s+/i, "");
        if (!this.keys.has(key)) return new Response("no", { status: 401 });
        return Response.json({ object: "list", data: [{ id: `${this.name}-model`, object: "model" }] });
      },
    });
    this.port = this.server.port!;
  }
  private stopped = false;
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.server.stop(true);
  }
}

let services: Service[] = [];
let gateways: FakeGateway[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
/** This node's own gateway: it refuses every unkeyed call, like a real one. */
let localGateway: ReturnType<typeof Bun.serve> | null = null;
/** Port of the server above, fixed for the duration of one test. */
let localGatewayPort = 0;
// Captured when the module loads so `afterAll` can put the process back exactly
// as this file found it, even when a test throws.
const originalMagpieAddr = process.env.MAGPIE_ADDR;
const originalCwd = process.cwd();
/** Origins registered with `registerTestServer`, for the afterAll fallback. */
const explicitOrigins = new Set<string>();

async function closeOpenResources(): Promise<void> {
  // Service.stop() is asynchronous: the next test must not start while the
  // previous supervisor is still shutting down.
  await Promise.all(services.splice(0).map((s) => s.stop()));
  for (const g of gateways.splice(0)) g.stop();
  localGateway?.stop(true);
  localGateway = null;
}

beforeEach(async () => {
  await closeOpenResources();
  const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-service-"));
  process.chdir(dir);
  localGateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("no key", { status: 401 }),
  });
  localGatewayPort = localGateway.port!;
  process.env.MAGPIE_ADDR = `127.0.0.1:${localGatewayPort}`;
  magpie = new FakeMagpie();
  sup = new FakeSupervisor();
});

async function service(opts: { sharing?: boolean; consuming?: boolean; fresh?: boolean } = {}): Promise<Service> {
  const s = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2038",
    supervisor: sup,
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 400,
    // This suite exercises shares/providers, not the chain module: an injected
    // null wallet keeps `configure()` from opening watchers, and the key limit
    // read-back is not part of it (the wallet suites inject their own).
    wallet: null,
    probes: { remoteLimit: async () => null },
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

/**
 * A service whose remote probes are simulated per loopback port. Used when a
 * test needs the plugin to choose its own new port (retargeting) and still have
 * that port answer like a keyed gateway.
 */
function isForwardPort(port: number): boolean {
  return port >= FORWARD_PORT_FROM && port <= FORWARD_PORT_TO;
}

async function serviceSim(
  portKeys: Map<number, string>,
  opts: { sharing?: boolean; consuming?: boolean; anyForwardKey?: string } = {},
): Promise<Service> {
  const sim = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2038",
    supervisor: sup,
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 400,
    wallet: null,
    probes: {
      remoteLimit: async () => null,
      statusWith: async (_host, port, want, bearer) => {
        if (port === localGatewayPort) return want === 401;
        const key = portKeys.get(port) ?? (isForwardPort(port) ? opts.anyForwardKey : undefined);
        if (!key) return false;
        return want === (bearer === key ? 200 : 401);
      },
      remoteModelIds: async (port) =>
        portKeys.has(port) || (isForwardPort(port) && opts.anyForwardKey !== undefined) ? ["sim-model"] : null,
    },
  });
  services.push(sim);
  await sim.configure({
    sharingEnabled: opts.sharing ?? true,
    consumingEnabled: opts.consuming ?? true,
    networkName: "service-lab",
    networkSecret: "service-lab-secret",
  });
  return sim;
}

function gateway(name: string, keys: string[]): FakeGateway {
  const g = new FakeGateway(name, new Set(keys));
  gateways.push(g);
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

  test("re-adding without a local port keeps the same listener", async () => {
    // Any port the product's allocator picks answers with this key.
    const s = await serviceSim(new Map(), { anyForwardKey: "sk-test-provider-b-0001" });
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    const first = await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425 });
    const starts = sup.starts;
    const again = await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425 });
    expect(again.localPort).toBe(first.localPort);
    expect(sup.starts).toBe(starts);
    expect(sup.forwards).toHaveLength(1);
    expect(magpie.providers_()).toHaveLength(1);
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

    // The provider is down on purpose: re-declare its own (now closed) port so
    // the reconcile probe may reach the OS and observe a refused connection,
    // instead of the hermetic guard blocking a port no test declares. The
    // explicit registration is undone afterwards: `server.stop()` only removes
    // the automatic one.
    const closedOrigin = `http://127.0.0.1:${b.port}`;
    b.stop();
    registerTestServer(closedOrigin);
    explicitOrigins.add(closedOrigin);
    try {
      const after = await s.reconcileProviders({ verifyModels: true });
      expect(after.find((p) => p.id === "peer-b")!.status).toBe("degraded");
      expect(after.find((p) => p.id === "peer-c")!.status).toBe("connected");
      // a degraded provider is not unregistered: Magpie would just fail its calls
      expect(magpie.providers_().map((p) => p.id).sort()).toEqual(["peer-b", "peer-c"]);
    } finally {
      unregisterTestServer(closedOrigin);
      explicitOrigins.delete(closedOrigin);
      expect(isTestServerAllowed(closedOrigin)).toBe(false);
      expect(await expectBlocked(() => fetch(closedOrigin))).toBe(true);
    }
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
    // The switch restarts the core once, so the old listener is gone and no
    // unregistered forward is left behind.
    expect(s.providers().find((p) => p.id === "peer-b")!.localPort).toBe(b2.port);
    expect(sup.forwards.map((f) => f.bindAddr).sort()).toEqual([`127.0.0.1:${b2.port}`, `127.0.0.1:${c.port}`].sort());
    expect((s as unknown as { state: { orphanForwards: unknown[] } }).state.orphanForwards).toEqual([]);
  });

  test("an update that only changes the destination picks a fresh port and verifies it first", async () => {
    // The old listener is a real OS-assigned server, not a guessed number.
    const old = gateway("old-b", ["sk-test-provider-b-0001"]);
    const oldPort = old.port;
    const s = await serviceSim(new Map([[oldPort, "sk-test-provider-b-0001"]]), {
      anyForwardKey: "sk-test-provider-b-0001",
    });
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.9", "ohmyaihub-b0000009");
    const first = await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: oldPort });
    expect(first.localPort).toBe(oldPort);

    const updated = await s.updateProvider("peer-b", { mappedCidr: "10.66.1.9/32" });
    expect(updated.mappedCidr).toBe("10.66.1.9/32");
    expect(updated.localPort).not.toBe(oldPort);
    expect(updated.localPort).toBeGreaterThanOrEqual(FORWARD_PORT_FROM);
    expect(updated.localPort).toBeLessThanOrEqual(FORWARD_PORT_TO);
    expect(updated.status).toBe("connected");
    // the new target was proven through the new port before the old one retired
    expect(sup.forwards.map((f) => f.bindAddr).sort()).toEqual([`127.0.0.1:${updated.localPort}`]);
    expect(magpie.providers_()[0].chat).toBe(`http://127.0.0.1:${updated.localPort}/v1`);
  });

  test("retargeting onto the same loopback port is refused instead of half-switching", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.9", "ohmyaihub-b0000009");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    await expect(s.updateProvider("peer-b", { mappedCidr: "10.66.1.9/32", localPort: b.port })).rejects.toThrow(
      /cannot point an existing loopback forward at a new target|omit localPort/,
    );
    // nothing changed
    expect(s.providers()[0].mappedCidr).toBe("10.66.1.2/32");
    expect(s.providers()[0].localPort).toBe(b.port);
    expect(s.providers()[0].status).toBe("connected");
    expect(magpie.providers_()[0].chat).toBe(`http://127.0.0.1:${b.port}/v1`);
  });

  test("a retarget whose new path never answers keeps the old connection and records the failed listener", async () => {
    const old = gateway("old-b", ["sk-test-provider-b-0001"]);
    const other = gateway("old-c", ["sk-test-provider-c-0001"]);
    const oldPort = old.port, otherPort = other.port;
    const portKeys = new Map<number, string>([
      [oldPort, "sk-test-provider-b-0001"],
      [otherPort, "sk-test-provider-c-0001"],
    ]);
    // No fresh port answers: the update fails at the first ingress probe.
    const s = await serviceSim(portKeys, { sharing: false, consuming: true });
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.9", "ohmyaihub-b0000009");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: oldPort });
    await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: otherPort });

    await expect(s.updateProvider("peer-b", { mappedCidr: "10.66.1.9/32" })).rejects.toThrow(/did not answer 401/);
    const rec = s.providers().find((p) => p.id === "peer-b")!;
    expect(rec.mappedCidr).toBe("10.66.1.2/32");
    expect(rec.localPort).toBe(oldPort);
    expect(rec.status).toBe("connected");
    expect(magpie.providerById("peer-b")!.chat).toBe(`http://127.0.0.1:${oldPort}/v1`);
    expect(magpie.providerById("peer-b")!.key).toBe("sk-test-provider-b-0001");
    expect(s.providers().find((p) => p.id === "peer-c")!.status).toBe("connected");
    const orphans = (s as unknown as { state: { orphanForwards: { localPort: number }[] } }).state.orphanForwards;
    expect(orphans).toHaveLength(1);
    expect(orphans[0].localPort).toBeGreaterThanOrEqual(FORWARD_PORT_FROM);
    expect(orphans[0].localPort).toBeLessThanOrEqual(FORWARD_PORT_TO);
    expect(orphans[0].localPort).not.toBe(oldPort);
  });

  test("a failed retarget keeps the old provider working and restores its registration", async () => {
    const old = gateway("old-b", ["sk-test-provider-b-0001"]);
    const other = gateway("old-c", ["sk-test-provider-c-0001"]);
    const oldPort = old.port, otherPort = other.port;
    // Every fresh port answers the key probes but serves no model, so the
    // failure happens after the new registration was written.
    const s = await serviceSim(
      new Map<number, string>([
        [oldPort, "sk-test-provider-b-0001"],
        [otherPort, "sk-test-provider-c-0001"],
      ]),
      { sharing: false, consuming: true, anyForwardKey: "sk-test-provider-b-0001" },
    );
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    sup.route("10.66.1.9", "ohmyaihub-b0000009");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: oldPort });
    const otherProvider = await s.addProvider({ id: "peer-c", mappedCidr: "10.66.1.3/32", key: "sk-test-provider-c-0001", providerPort: 3425, localPort: otherPort });
    void otherProvider;

    // Make the new target answer the key but serve no model, after the
    // registration step; then the update must roll back.
    const sim = s as unknown as { probes: { remoteModelIds: (port: number, key: string, t: number) => Promise<string[] | null> } };
    const real = sim.probes.remoteModelIds;
    sim.probes.remoteModelIds = async (port, key, t) => (port === oldPort ? real(port, key, t) : null);

    await expect(s.updateProvider("peer-b", { mappedCidr: "10.66.1.9/32" })).rejects.toThrow(/connect failed/);
    sim.probes.remoteModelIds = real;

    const rec = s.providers().find((p) => p.id === "peer-b")!;
    expect(rec.mappedCidr).toBe("10.66.1.2/32");
    expect(rec.localPort).toBe(oldPort);
    expect(rec.status).toBe("connected");
    // the old registration is back, pointing at the old port and key
    const entry = magpie.providerById("peer-b")!;
    expect(entry.chat).toBe(`http://127.0.0.1:${oldPort}/v1`);
    expect(entry.key).toBe("sk-test-provider-b-0001");
    // the other provider is untouched
    expect(s.providers().find((p) => p.id === "peer-c")!.status).toBe("connected");
    expect(magpie.providerById("peer-c")).toBeDefined();
    // the failed new listener is recorded, not silently forgotten
    const orphans = (s as unknown as { state: { orphanForwards: { localPort: number }[] } }).state.orphanForwards;
    expect(orphans.length).toBe(1);
    expect(orphans[0].localPort).not.toBe(oldPort);
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
    expect(guard).toEqual({ narrowed: [], revoked: [], suspended: true });
    expect(s.provisioner.find("carol")!.revokedAt).toBeNull();
    // "unknown" is not "safe": the export is withdrawn while it cannot be proven.
    expect(sup.cfg!.sharingEnabled).toBe(false);
    const report = await s.checks();
    const check = report.find((c) => c.name === "shared-models-native-only");
    expect(check?.ok).toBe(false);
    magpie.providersReadable = real;
  });
});

describe("provider ownership", () => {
  test("a new remote provider refuses a same-named native provider and leaves it untouched", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    magpie.addManualProvider("peer-b");
    const before = { ...magpie.providerById("peer-b")! };
    await expect(
      s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port }),
    ).rejects.toThrow(/not owned by this plugin/);
    expect(magpie.providerById("peer-b")).toEqual(before);
    expect(s.providers()).toHaveLength(0);
    expect(sup.forwards).toHaveLength(0);
    expect(magpie.addCalls).toBe(0);
    expect(magpie.replaceCalls).toBe(0);
  });

  test("a new remote provider refuses a same-named foreign Remote Magpie", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    magpie.providers.set("peer-b", {
      id: "peer-b",
      preset: "remote-magpie",
      chat: "http://127.0.0.1:1/v1",
      key: "sk-test-somebody-elses-key",
    });
    const before = { ...magpie.providerById("peer-b")! };
    await expect(
      s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port }),
    ).rejects.toThrow(/not owned by this plugin/);
    expect(magpie.providerById("peer-b")).toEqual(before);
    expect(magpie.addCalls).toBe(0);
    expect(magpie.replaceCalls).toBe(0);
  });

  test("a provider edited outside the plugin is not overwritten, and reconcile leaves it alone", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    const calls = { add: magpie.addCalls, replace: magpie.replaceCalls };

    // The user rotates the key in Magpie (or edits the URL) by hand.
    magpie.providers.get("peer-b")!.key = "sk-test-user-rotated-key";
    await expect(s.updateProvider("peer-b", { key: "sk-test-provider-b-0002" })).rejects.toThrow(/not owned by this plugin/);
    expect(magpie.providerById("peer-b")!.key).toBe("sk-test-user-rotated-key");

    const list = await s.reconcileProviders({ verifyModels: false });
    expect(list[0].status).toBe("degraded");
    expect(list[0].detail).toMatch(/changed outside this plugin/);
    expect(magpie.providerById("peer-b")!.key).toBe("sk-test-user-rotated-key");
    expect(magpie.addCalls).toBe(calls.add);
    expect(magpie.replaceCalls).toBe(calls.replace);
  });

  test("deleting a connection leaves an edited provider in Magpie, and clears only plugin state", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    magpie.providers.get("peer-b")!.chat = "http://127.0.0.1:19999/v1";

    const removed = await s.removeProvider("peer-b");
    expect(magpie.providerById("peer-b")!.chat).toBe("http://127.0.0.1:19999/v1");
    expect(s.providers()).toHaveLength(0);
    expect(getProviderKey("peer-b")).toBeNull();
    expect(removed.detail).toMatch(/left untouched/);
  });

  test("turning consumption off leaves an edited provider alone", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    magpie.providers.get("peer-b")!.key = "sk-test-user-rotated-key";

    await s.setConsuming(false);
    expect(magpie.providerById("peer-b")!.key).toBe("sk-test-user-rotated-key");
    expect(s.providers()[0].status).toBe("disabled");
  });

  test("a restart reconciles an owned provider without rewriting it, and never overwrites a foreign one", async () => {
    const s = await service();
    const b = gateway("b", ["sk-test-provider-b-0001"]);
    sup.route("10.66.1.2", "ohmyaihub-b0000001");
    await s.addProvider({ id: "peer-b", mappedCidr: "10.66.1.2/32", key: "sk-test-provider-b-0001", providerPort: 3425, localPort: b.port });
    const calls = { add: magpie.addCalls, replace: magpie.replaceCalls };

    const restarted = await service();
    const ok = await restarted.reconcileProviders({ verifyModels: true });
    expect(ok[0].status).toBe("connected");
    expect(magpie.addCalls).toBe(calls.add);
    expect(magpie.replaceCalls).toBe(calls.replace);

    magpie.providers.get("peer-b")!.chat = "http://127.0.0.1:19999/v1";
    const list = await restarted.reconcileProviders({ verifyModels: false });
    expect(list[0].status).toBe("degraded");
    expect(magpie.providerById("peer-b")!.chat).toBe("http://127.0.0.1:19999/v1");
    expect(magpie.addCalls).toBe(calls.add);
    expect(magpie.replaceCalls).toBe(calls.replace);
  });
});

describe("the share guard reacts to changes made outside the plugin", () => {
  test("start() re-checks issued keys when a native provider became a Remote Magpie", async () => {
    const s = await service();
    await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    expect(magpie.keys.size).toBe(1);

    magpie.native.delete("alpha");
    magpie.providers.set("alpha", { id: "alpha", preset: "remote-magpie", chat: "http://127.0.0.1:1/v1", key: "sk-test-foreign" });
    const restarted = new Service({ magpie: magpie as never, magpieVersion: "magpie 0.1.2038", supervisor: sup, lanIp: () => "127.0.0.1", probeTimeoutMs: 400, wallet: null, probes: { remoteLimit: async () => null } });
    services.push(restarted);
    await restarted.start();
    await restarted.stop();

    expect(restarted.provisioner.find("carol")!.revokedAt).not.toBeNull();
    expect(magpie.keys.size).toBe(0);
  });

  test("reconcile notices a provider-list change and revokes the key naming it", async () => {
    const s = await service();
    await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    magpie.native.delete("alpha");
    magpie.providers.set("alpha", { id: "alpha", preset: "remote-magpie", chat: "http://127.0.0.1:1/v1", key: "sk-test-foreign" });

    await s.reconcileProviders({ verifyModels: false });
    expect(s.provisioner.find("carol")!.revokedAt).not.toBeNull();
    expect(magpie.keys.size).toBe(0);
  });

  test("an unreadable provider list suspends the export, keeps keys, and resumes when readable", async () => {
    const s = await service();
    await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    const real = magpie.providersReadable.bind(magpie);
    magpie.providersReadable = () => false;

    const guard = await s.guardSharedKeys();
    expect(guard.suspended).toBe(true);
    expect(sup.cfg!.sharingEnabled).toBe(false);
    expect(guard.revoked).toEqual([]);
    expect(s.provisioner.find("carol")!.revokedAt).toBeNull();
    expect(magpie.keys.size).toBe(1);

    const checks = await s.checks();
    expect(checks.find((c) => c.name === "sharing-suspended")?.ok).toBe(false);
    expect(checks.find((c) => c.name === "shared-models-native-only")?.ok).toBe(false);

    magpie.providersReadable = real;
    const resumed = await s.guardSharedKeys();
    expect(resumed.suspended).toBe(false);
    expect(sup.cfg!.sharingEnabled).toBe(true);
    expect((s as unknown as { state: { shareSuspended: unknown } }).state.shareSuspended).toBeNull();
    expect(s.provisioner.find("carol")!.revokedAt).toBeNull();
  });

  test("a key deleted outside the plugin does not fail the guard or revoke anything else", async () => {
    const s = await service();
    const gone = await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    const kept = await s.ensureConsumer("dave", ["alpha/native-model"], 1);
    magpie.keys.delete(gone.keyId);
    const result = await s.guardSharedKeys();
    expect(result.revoked).toEqual([]);
    expect(s.provisioner.find("carol")!.revokedAt).toBeNull();
    expect(s.provisioner.find("dave")!.revokedAt).toBeNull();
    expect(magpie.keyById(kept.keyId)).toBeDefined();
  });

  test("a key widened by hand is narrowed back to the operator's shareable list", async () => {
    const s = await service();
    const view = await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    magpie.keys.get(view.keyId)!.models = [];

    await s.guardSharedKeys();
    expect(magpie.keyById(view.keyId)!.models).toEqual(["alpha/native-model"]);

    // A remote model slipped into the key: the guard removes it.
    magpie.providers.set("peer-b", { id: "peer-b", preset: "remote-magpie", chat: "http://127.0.0.1:1/v1", key: "sk-test-foreign" });
    magpie.keys.get(view.keyId)!.models = ["alpha/native-model", "peer-b/x/model"];
    await s.guardSharedKeys();
    expect(magpie.keyById(view.keyId)!.models).toEqual(["alpha/native-model"]);
  });
});

describe("handover reflects what Magpie actually holds", () => {
  test("a narrowed key delivers the narrowed list, not the old record", async () => {
    const s = await service();
    await s.ensureConsumer("carol", ["alpha/a", "alpha/b"], 1);
    s.config()!.share.models = ["alpha/a"];
    const h = await s.handover("carol");
    expect(h.models).toEqual(["alpha/a"]);
    expect(h.models).toEqual(magpie.keyById(s.provisioner.find("carol")!.keyId)!.models);
  });

  test("a key revoked during the check is never delivered, and the error has no secret", async () => {
    const s = await service();
    const view = await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    const secret = s.provisioner.find("carol")!.secret;
    s.config()!.share.models = ["nothing/*"];
    let message = "";
    try {
      await s.handover("carol");
      throw new Error("handover should have failed");
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    expect(message).toMatch(/revoked while/);
    expect(message).not.toContain(secret);
    expect(magpie.keyById(view.keyId)).toBeUndefined();
  });

  test("an empty model list is repaired before anything is handed over", async () => {
    const s = await service();
    const view = await s.ensureConsumer("carol", ["alpha/native-model"], 1);
    magpie.keys.get(view.keyId)!.models = [];
    const h = await s.handover("carol");
    expect(h.models.length).toBeGreaterThan(0);
    expect(h.models).toEqual(["alpha/native-model"]);
    expect(magpie.keyById(view.keyId)!.models).toEqual(["alpha/native-model"]);
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

describe("resource ownership", () => {
  test("closeOpenResources waits for an asynchronous stop", async () => {
    let stopped = false;
    services.push({ stop: async () => { await Bun.sleep(20); stopped = true; } } as unknown as Service);
    await closeOpenResources();
    expect(stopped).toBe(true);
  });
});

// Ownership: whatever a failing last test left open is closed with the file,
// and the process environment and cwd are restored even when cleanup throws.
afterAll(async () => {
  try {
    await closeOpenResources();
  } finally {
    for (const origin of explicitOrigins) unregisterTestServer(origin);
    explicitOrigins.clear();
    if (originalMagpieAddr === undefined) delete process.env.MAGPIE_ADDR;
    else process.env.MAGPIE_ADDR = originalMagpieAddr;
    process.chdir(originalCwd);
  }
});
