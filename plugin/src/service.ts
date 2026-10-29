import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stateDir, statePath } from "./paths.ts";
import { logger, registerSecret, writePageStatus } from "./log.ts";
import { gatewayBaseURL, type Magpie } from "./magpie.ts";
import { Provisioner, type ConsumerView } from "./provisioner.ts";
import {
  EasytierSupervisor,
  generateSecureIdentity,
  randomMappedCidr,
  randomVirtualIp,
  type EasytierConfig,
  type SupervisorState,
} from "./easytier.ts";
import { lanIPv4 } from "./paths.ts";

export type Role = "provider" | "consumer";

export interface ProviderWiring {
  /** what the consumer calls this provider (Remote Magpie provider id) */
  id: string;
  mappedCidr: string;
  providerPort?: number;
  key: string;
  /** local loopback port the consumer's EasyTier forwards */
  localPort: number;
  createdAt: string;
}

export interface PluginConfig {
  role: Role;
  networkName: string;
  networkSecret: string;
  peers: string[];
  listenAddr: string | null;
  virtualIpv4: string;
  overlayCidr: string;
  rpcPort: number;
  mappedCidr: string | null;
  /** the provider's own exported address (real LAN IP/32 or /24) */
  proxyCidr: string | null;
  publishedPorts: number[];
  secureMode: boolean;
  secureIdentity: { privateKey: string; publicKey: string } | null;
}

interface StateFile {
  config: PluginConfig | null;
  consumers: string[];
  providerWiring: ProviderWiring | null;
}

const OVERLAY: Record<string, string> = {};

function stateFile(): string {
  return statePath("state.json");
}

function readState(): StateFile {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8")) as StateFile;
    if (s.config?.networkSecret) registerSecret(s.config.networkSecret);
    if (s.providerWiring?.key) registerSecret(s.providerWiring.key);
    return { config: s.config ?? null, consumers: s.consumers ?? [], providerWiring: s.providerWiring ?? null };
  } catch {
    return { config: null, consumers: [], providerWiring: null };
  }
}

function writeState(s: StateFile): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(), JSON.stringify(s, null, 1), { mode: 0o600 });
}

export interface ServiceDeps {
  magpie: Magpie;
  magpieVersion: string;
}

export interface StatusSnapshot {
  plugin: { version: string; pid: number; dataDir: string; startedAt: string };
  magpie: { version: string; gateway: string };
  config: {
    role: Role | null;
    networkName: string | null;
    peers: string[];
    listenAddr: string | null;
    virtualIpv4: string | null;
    proxyCidr: string | null;
    mappedCidr: string | null;
    publishedPorts: number[];
    secureMode: boolean;
    rpcPort: number | null;
  };
  easytier: SupervisorState;
  consumers: ConsumerView[];
  wiring: { id: string; mappedCidr: string; url: string; createdAt: string } | null;
  checks: { name: string; ok: boolean; detail: string }[];
  logs: string[];
}

/**
 * Everything the plugin does, independent of how it was invoked (the plugin host
 * or the HTTP API). It owns the EasyTier supervisor and the Gateway Key
 * provisioner; it never touches an AI request.
 */
export class Service {
  readonly supervisor: EasytierSupervisor;
  readonly provisioner: Provisioner;
  private state = readState();
  private startedAt = new Date().toISOString();
  private lastProblem: string | null = null;
  private ticking: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: ServiceDeps) {
    this.supervisor = new EasytierSupervisor({ onState: () => this.writeSnapshot() });
    this.provisioner = new Provisioner(deps.magpie);
  }

  config(): PluginConfig | null {
    return this.state.config;
  }

  /** The gateway port this Magpie answers on (3425 unless told). */
  gatewayPort(): number {
    try {
      const u = new URL(gatewayBaseURL());
      return Number(u.port || (u.protocol === "https:" ? 443 : 80));
    } catch {
      return 3425;
    }
  }

  async start(): Promise<void> {
    const cfg = this.state.config;
    if (cfg) {
      try {
        await this.supervisor.start({ ...cfg, secureIdentity: cfg.secureIdentity, instanceName: instanceName(cfg.role) });
      } catch (e) {
        this.lastProblem = String(e);
        logger.error(`supervisor did not start: ${String(e)}`);
      }
    }
    this.ticking = setInterval(() => {
      this.supervisor.refresh().catch(() => {});
    }, 15_000);
    this.writeSnapshot();
  }

  async stop(): Promise<void> {
    if (this.ticking) clearInterval(this.ticking);
    await this.supervisor.stop();
  }

  /**
   * Configures this node's overlay. A change to the network, the export or the
   * published ports rewrites the TOML and restarts the core: EasyTier 2.6.4 has
   * no runtime ACL edit.
   */
  async configure(input: {
    role?: Role;
    networkName?: string;
    networkSecret?: string;
    peers?: string[];
    listenAddr?: string | null;
    publishedPorts?: number[];
    secureMode?: boolean;
    rpcPort?: number;
  }): Promise<StatusSnapshot> {
    const prev = this.state.config;
    const role: Role = input.role ?? prev?.role ?? "provider";
    if (role !== "provider" && role !== "consumer") throw new Error("role must be provider or consumer");

    const networkName = (input.networkName ?? prev?.networkName ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(networkName)) {
      throw new Error("networkName must be 2-63 characters of letters, digits, dot, dash or underscore");
    }
    const networkSecret = (input.networkSecret ?? prev?.networkSecret ?? "").trim();
    if (networkSecret.length < 8) throw new Error("networkSecret must be at least 8 characters");

    const peers = (input.peers ?? prev?.peers ?? [])
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (p.includes("://") ? p : `tcp://${p}`));
    for (const p of peers) {
      if (!/^(tcp|udp|ws|wss|quic|wg):\/\/[A-Za-z0-9._:-]+(:\d+)?$/.test(p)) {
        throw new Error(`bad peer address: ${p} (expected tcp://host:port)`);
      }
    }

    const listenAddr = input.listenAddr === undefined ? (prev?.listenAddr ?? null) : normalizeListen(input.listenAddr);
    const publishedPorts = (input.publishedPorts ?? prev?.publishedPorts ?? [this.gatewayPort()])
      .map((p) => Number(p))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    if (publishedPorts.length === 0) throw new Error("a provider must publish at least one port");

    const secureMode = input.secureMode ?? prev?.secureMode ?? true;
    const rpcPort = input.rpcPort ?? prev?.rpcPort ?? (await freeRpcPort());

    const virtualIpv4 = prev?.virtualIpv4 ?? randomVirtualIp("10.77.0.0/24");
    const overlayCidr = "10.77.0.0/24";
    const mappedCidr = role === "provider" ? (prev?.mappedCidr ?? randomMappedCidr()) : null;
    const proxyCidr = role === "provider" ? `${lanIPv4()}/32` : null;

    const secureIdentity = secureMode ? (prev?.secureIdentity ?? generateSecureIdentity()) : null;

    const cfg: PluginConfig = {
      role,
      networkName,
      networkSecret,
      peers,
      listenAddr,
      virtualIpv4,
      overlayCidr,
      rpcPort,
      mappedCidr,
      proxyCidr,
      publishedPorts: role === "provider" ? publishedPorts : [],
      secureMode,
      secureIdentity,
    };
    this.state.config = cfg;
    writeState(this.state);
    registerSecret(networkSecret);

    const et: EasytierConfig = { ...cfg, instanceName: instanceName(role), secureIdentity };
    await this.supervisor.start(et);
    await this.supervisor.refresh();
    logger.info(`configured as ${role} on ${networkName}; peers ${peers.join(",") || "none"}`);
    return this.status();
  }

  /** The checks that decide whether the service may be published at all. */
  async checks(): Promise<{ name: string; ok: boolean; detail: string }[]> {
    const out: { name: string; ok: boolean; detail: string }[] = [];
    const cfg = this.state.config;
    const et = this.supervisor.snapshot();
    if (!cfg) {
      out.push({ name: "configured", ok: false, detail: "no overlay configuration yet" });
      return out;
    }
    out.push({ name: "core-running", ok: et.running, detail: et.running ? `pid ${et.pid}` : (et.lastError ?? "stopped") });
    out.push({ name: "acl", ok: et.aclOk, detail: et.aclOk
          ? cfg.role === "provider"
            ? "Inbound Drop (no rules), Forward Drop with published ports"
            : "Inbound Drop (no rules); nothing exported"
          : et.aclProblems.join("; ") });
    if (cfg.role === "provider") {
      const gw = this.gatewayPort();
      out.push({
        name: "gateway-key-required",
        ok: await requiresKey(cfg, gw),
        detail: `GET http://${cfg.proxyCidr?.replace(/\/32$/, "")}:${gw}/v1/models without a key must answer 401`,
      });
      out.push({
        name: "mapped-cidr",
        ok: Boolean(et.mappedCidr && et.aclOk),
        detail: et.mappedCidr ?? "none",
      });
    }
    if (this.state.providerWiring) {
      const ok = await ingressRequiresKey(this.state.providerWiring.localPort);
      out.push({ name: "consumer-ingress-keyed", ok, detail: `127.0.0.1:${this.state.providerWiring.localPort} must answer 401 without a key` });
    }
    return out;
  }

  /** Provider: publishes a port (ACL + restart) and re-verifies. */
  async publishPorts(ports: number[]): Promise<StatusSnapshot> {
    const cfg = this.state.config;
    if (!cfg || cfg.role !== "provider") throw new Error("only a provider publishes ports");
    return this.configure({ publishedPorts: ports });
  }

  /**
   * Consumer: wires this Magpie to a provider through EasyTier and registers the
   * provider as a native Remote Magpie. The key is the provider's Gateway Key.
   */
  async connectProvider(input: {
    id: string;
    mappedCidr: string;
    key: string;
    /** the provider's published gateway port (3425 in production) */
    providerPort?: number;
    localPort?: number;
  }): Promise<StatusSnapshot> {
    const cfg = this.state.config;
    if (!cfg || cfg.role !== "consumer") throw new Error("configure this node as a consumer first");
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(input.id)) throw new Error("provider id must be 2-31 characters of a-z0-9-");
    if (!/^10\.66\.\d{1,3}\.\d{1,3}\/32$/.test(input.mappedCidr.trim())) {
      throw new Error("mappedCidr must look like 10.66.a.b/32");
    }
    if (!/^sk-[A-Za-z0-9._-]{8,}$/.test(input.key)) throw new Error("that is not a gateway key");
    registerSecret(input.key);

    const providerPort = input.providerPort ?? 3425;
    if (!Number.isInteger(providerPort) || providerPort < 1 || providerPort > 65535) {
      throw new Error("providerPort must be a TCP port");
    }
    // A mapped prefix must identify exactly one provider on this overlay: two
    // peers announcing the same one would make the dial land on either.
    const want = input.mappedCidr.replace(/\/32$/, "");
    try {
      const routes = await this.supervisor.routes();
      const owners = new Set<string>();
      for (const r of routes) {
        for (const c of r.proxyCidrs.split(",").map((x) => x.trim())) {
          if (!c) continue;
          const dialed = c.includes("->") ? c.split("->")[1] : c;
          if (dialed === want) owners.add(r.hostname);
        }
      }
      if (owners.size > 1) {
        throw new Error(`the overlay already announces ${want} from ${[...owners].join(", ")}; each provider needs its own mapped_cidr`);
      }
    } catch (e) {
      if (String(e).includes("already announces")) throw e;
      // no route table yet: the connect's own ingress check will catch a real problem
    }

    const localPort = input.localPort ?? (await freeLoopbackPort());
    const dst = `${input.mappedCidr.replace(/\/32$/, "")}:${providerPort}`;
    for (const f of await this.supervisor.listPortForwards()) {
      if (f.bindAddr.endsWith(`:${localPort}`) && f.dstAddr !== dst) {
        await this.supervisor.removePortForward(f.bindAddr);
      }
    }
    await this.supervisor.addPortForward(`127.0.0.1:${localPort}`, dst);

    await this.deps.magpie.removeProvider(input.id);
    await this.deps.magpie.addRemoteProvider({ id: input.id, url: `http://127.0.0.1:${localPort}`, key: input.key });

    this.state.providerWiring = {
      id: input.id,
      mappedCidr: input.mappedCidr,
      providerPort,
      key: input.key,
      localPort,
      createdAt: new Date().toISOString(),
    };
    writeState(this.state);

    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      ok = await ingressRequiresKey(localPort);
      if (!ok) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ok) {
      throw new Error(
        `the ingress at 127.0.0.1:${localPort} did not answer 401 without a key within 10s: ` +
          `the provider must be online, on the same network, and its Virtual IP/export reachable`,
      );
    }
    logger.info(`connected provider ${input.id} at 127.0.0.1:${localPort} -> ${dst}`);
    await this.supervisor.refresh();
    return this.status();
  }

  async disconnectProvider(): Promise<StatusSnapshot> {
    const w = this.state.providerWiring;
    if (w) {
      await this.deps.magpie.removeProvider(w.id);
      await this.supervisor.removePortForward(`127.0.0.1:${w.localPort}`).catch(() => {});
      this.state.providerWiring = null;
      writeState(this.state);
      logger.info(`disconnected provider ${w.id}`);
    }
    return this.status();
  }

  /** The provider operator hands a consumer key over; never logged. */
  handover(consumerId: string): { consumerId: string; keyName: string; key: string; models: string[]; capUsd: number } {
    const rec = this.provisioner.find(consumerId);
    if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
    if (!rec.secret) throw new Error(`the key of ${consumerId} is not in this Magpie any more; recreate it`);
    logger.info(`handing key ${rec.keyName} over for ${consumerId}`);
    return { consumerId, keyName: rec.keyName, key: rec.secret, models: [...rec.models], capUsd: rec.capUsd };
  }

  async topUp(consumerId: string, usd: number): Promise<ConsumerView> {
    return this.provisioner.topUp(consumerId, usd);
  }

  async ensureConsumer(consumerId: string, models: string[], capUsd: number): Promise<ConsumerView> {
    const v = await this.provisioner.ensure(consumerId, { models, capUsd });
    if (!this.state.consumers.includes(consumerId)) this.state.consumers.push(consumerId);
    writeState(this.state);
    return v;
  }

  async status(): Promise<StatusSnapshot> {
    // A platform without an app bundle learns its version from the CLI, once,
    // with a timeout; the page snapshot and boot never wait for it.
    if (this.deps.magpieVersion.includes("unknown")) {
      this.deps.magpieVersion = await this.deps.magpie.detectVersion();
    }
    const et = this.supervisor.snapshot();
    const cfg = this.state.config;
    const checks = await this.checks().catch(() => [] as { name: string; ok: boolean; detail: string }[]);
    const snap: StatusSnapshot = {
      plugin: { version: "0.1.0", pid: process.pid, dataDir: process.cwd(), startedAt: this.startedAt },
      magpie: { version: this.deps.magpieVersion, gateway: gatewayBaseURL() },
      config: {
        role: cfg?.role ?? null,
        networkName: cfg?.networkName ?? null,
        peers: cfg?.peers ?? [],
        listenAddr: cfg?.listenAddr ?? null,
        virtualIpv4: cfg?.virtualIpv4 ?? null,
        proxyCidr: cfg?.proxyCidr ?? null,
        mappedCidr: cfg?.mappedCidr ?? null,
        publishedPorts: cfg?.publishedPorts ?? [],
        secureMode: cfg?.secureMode ?? false,
        rpcPort: cfg?.rpcPort ?? null,
      },
      easytier: et,
      consumers: await this.provisioner.refreshAll(),
      wiring: this.state.providerWiring
        ? { id: this.state.providerWiring.id, mappedCidr: this.state.providerWiring.mappedCidr, url: `http://127.0.0.1:${this.state.providerWiring.localPort}`, createdAt: this.state.providerWiring.createdAt }
        : null,
      checks,
      logs: [],
    };
    this.lastSnapshot = snap;
    return snap;
  }

  private lastSnapshot: StatusSnapshot | null = null;

  /** The snapshot without the (network) checks, for the page file. */
  private lightStatus(): StatusSnapshot {
    const et = this.supervisor.snapshot();
    const cfg = this.state.config;
    return {
      plugin: { version: "0.1.0", pid: process.pid, dataDir: process.cwd(), startedAt: this.startedAt },
      magpie: { version: this.deps.magpieVersion, gateway: gatewayBaseURL() },
      config: {
        role: cfg?.role ?? null,
        networkName: cfg?.networkName ?? null,
        peers: cfg?.peers ?? [],
        listenAddr: cfg?.listenAddr ?? null,
        virtualIpv4: cfg?.virtualIpv4 ?? null,
        proxyCidr: cfg?.proxyCidr ?? null,
        mappedCidr: cfg?.mappedCidr ?? null,
        publishedPorts: cfg?.publishedPorts ?? [],
        secureMode: cfg?.secureMode ?? false,
        rpcPort: cfg?.rpcPort ?? null,
      },
      easytier: et,
      consumers: this.provisioner.all(),
      wiring: this.state.providerWiring
        ? {
            id: this.state.providerWiring.id,
            mappedCidr: this.state.providerWiring.mappedCidr,
            url: `http://127.0.0.1:${this.state.providerWiring.localPort}`,
            createdAt: this.state.providerWiring.createdAt,
          }
        : null,
      checks: [],
      logs: [],
    };
  }

  /** Keeps the page's snapshot file current (the page cannot fetch). */
  writeSnapshot(): void {
    const snap = this.lightStatus();
    this.lastSnapshot = snap;
    writePageStatus({ ...snap, generatedAt: new Date().toISOString() });
  }

  problem(): string | null {
    return this.lastProblem;
  }
}

function normalizeListen(addr: string | null): string | null {
  if (!addr) return null;
  const a = addr.trim();
  if (!a) return null;
  const withScheme = a.includes("://") ? a : `tcp://${a}`;
  if (!/^(tcp|udp):\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/.test(withScheme)) {
    throw new Error("listenAddr must be host:port (IPv4) or empty");
  }
  return withScheme;
}

async function freeRpcPort(): Promise<number> {
  for (let port = 17888; port < 17960; port++) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error("no free RPC port in 17888-17959");
}

async function freeLoopbackPort(): Promise<number> {
  for (let port = 13425; port < 13500; port++) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error("no free loopback port in 13425-13499");
}

async function portInUse(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, close() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

/** From the provider's own address, the gateway must refuse an unkeyed call. */
async function requiresKey(cfg: PluginConfig, port: number): Promise<boolean> {
  const host = cfg.proxyCidr?.replace(/\/32$/, "") ?? "127.0.0.1";
  return statusIs(host, port, 401);
}

/** Through the consumer's local forward, the same must hold. */
async function ingressRequiresKey(localPort: number): Promise<boolean> {
  return statusIs("127.0.0.1", localPort, 401);
}

async function statusIs(host: string, port: number, want: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(5000) });
    return res.status === want;
  } catch {
    return false;
  }
}

function instanceName(role: Role): string {
  return `ohmyaihub-${role}`;
}
