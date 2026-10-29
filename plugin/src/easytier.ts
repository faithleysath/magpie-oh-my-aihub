import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { EASYTIER_VERSION, assetFor, assetUrl } from "./easytier-manifest.ts";
import { logger, registerSecret, redact } from "./log.ts";
import { checkConfig, type AclExpectation } from "./acl.ts";
import { lanIPv4, stateDir, statePath } from "./paths.ts";
import { run } from "./run.ts";
import { mappedHost, randomMappedCidr, randomVirtualIp } from "./addresses.ts";

export { randomMappedCidr, randomVirtualIp };

/** One loopback listener EasyTier opens towards a remote provider. */
export interface ForwardSpec {
  bindAddr: string;
  dstAddr: string;
}

export interface EasytierConfig {
  /** publish this node's Magpie on the overlay */
  sharingEnabled: boolean;
  /** allow this node to use remote providers (its forwards) */
  consumingEnabled: boolean;
  /** stable id of this node: the overlay hostname is `ohmyaihub-<nodeId>` */
  nodeId: string;
  /** stable EasyTier instance id, persisted so the instance keeps its name */
  instanceId: string;
  networkName: string;
  networkSecret: string;
  peers: string[];
  /** virtual address inside the overlay, CIDR form, e.g. 10.77.0.7/24 */
  virtualIpv4: string;
  /** overlay-wide /24, fixed so every node routes to every other */
  overlayCidr: string;
  /** VPN listener, e.g. 127.0.0.1:11010, or null for none */
  listenAddr: string | null;
  rpcPort: number;
  /** sharing: the provider's own address exported through the overlay */
  proxyCidr: string | null;
  /** sharing: the stable address consumers dial */
  mappedCidr: string | null;
  /** sharing: ports the Forward chain may reach (default [3425]) */
  publishedPorts: number[];
  /** consuming: loopback SOCKS5 listener for on-demand catalogue reads */
  socks5Proxy: string | null;
  /** consuming: loopback listeners towards remote providers */
  portForwards: ForwardSpec[];
  secureMode: boolean;
  /** persisted X25519 identity (base64), so the peer key survives restarts */
  secureIdentity?: { privateKey: string; publicKey: string } | null;
}

export interface CoreProcess {
  pid: number;
  startedAt: string;
  configPath: string;
  rpcPort: number;
  adopted?: boolean;
}

export interface Peer {
  ipv4: string;
  hostname: string;
  cost: string;
  latencyMs: string;
  loss: string;
  tunnel: string;
  nat: string;
  id: string;
}

export interface RouteRow {
  ipv4: string;
  hostname: string;
  proxyCidrs: string;
  nextHop: string;
  pathLen: number;
}

export interface PortForward {
  protocol: string;
  bindAddr: string;
  dstAddr: string;
}

/**
 * Decodes one address from `port-forward list -o json`. EasyTier 2.6.4 prints
 * the protobuf `SocketAddr { port, ip: { Ipv4: { addr: <u32> } } }`, not the
 * `127.0.0.1:13425` string the human table shows, so both shapes are accepted.
 */
export function decodeForwardAddr(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const rec = raw as { port?: unknown; ip?: unknown } | null;
  if (!rec || typeof rec !== "object") return "";
  const port = Number(rec.port ?? 0);
  const ip = rec.ip as Record<string, unknown> | undefined;
  const v4 = ip?.Ipv4 as { addr?: unknown } | undefined;
  if (!v4 || typeof v4.addr !== "number") return port ? `:${port}` : "";
  const n = v4.addr >>> 0;
  const octets = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return `${octets.join(".")}:${port}`;
}

export function decodeForward(raw: Record<string, unknown>): PortForward {
  const protocol = raw.protocol ?? raw.proto ?? (typeof raw.socket_type === "number" ? (raw.socket_type === 0 ? "tcp" : "udp") : "");
  return {
    protocol: String(protocol ?? "").toLowerCase(),
    bindAddr: decodeForwardAddr(raw.bind_addr ?? raw.bindAddr),
    dstAddr: decodeForwardAddr(raw.dst_addr ?? raw.dstAddr),
  };
}

const VERSION = EASYTIER_VERSION;

export function easytierHome(): string {
  const dir = statePath("easytier");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function binariesDir(): string {
  return join(easytierHome(), `v${VERSION}`, `${process.platform}-${process.arch}`);
}

async function hashFile(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return new Bun.CryptoHasher("sha256").update(new Uint8Array(bytes)).digest("hex");
}

/**
 * A pid belongs to this plugin only when it is alive and its command line runs
 * exactly our config file: a recycled pid or another EasyTier on the machine is
 * never adopted and never killed.
 */
export function ownsProcess(pid: number, configPath: string, platform: string = process.platform): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (platform === "linux") {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const cmd = raw.split("\0").join(" ");
      return cmd.includes("easytier-core") && cmd.includes(configPath);
    }
    const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
    const cmd = r.stdout.toString();
    return cmd.includes("easytier-core") && cmd.includes(configPath);
  } catch {
    return false;
  }
}

export interface Binaries {
  core: string;
  cli: string;
  verified: boolean;
}

/**
 * The verified EasyTier binaries. Downloads the pinned release asset for this
 * platform, checks its SHA-256 against the manifest, extracts it, and refuses to
 * run anything that does not match.
 */
export async function ensureBinaries(log: (m: string) => void = () => {}): Promise<Binaries> {
  const asset = assetFor();
  const dir = binariesDir();
  const core = join(dir, asset.core);
  const cli = join(dir, asset.cli);
  const marker = join(dir, ".sha256");
  const records = join(dir, ".binaries.json");

  if (existsSync(core) && existsSync(cli) && existsSync(marker) && existsSync(records)) {
    // The marker says which archive was extracted once; it says nothing about
    // the files that are there now. Hash the binaries themselves on every start.
    try {
      const rec = JSON.parse(readFileSync(records, "utf8")) as { core?: string; cli?: string };
      if (
        readFileSync(marker, "utf8").trim() === asset.sha256 &&
        rec.core === (await hashFile(core)) &&
        rec.cli === (await hashFile(cli))
      ) {
        return { core, cli, verified: true };
      }
      log(`installed binaries at ${dir} no longer match their recorded hashes; reinstalling`);
    } catch {
      log(`cannot read the binary records at ${dir}; reinstalling`);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const zip = join(easytierHome(), asset.file);
  const url = assetUrl(asset);
  log(`downloading ${url}`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(
      `EasyTier ${VERSION} ${asset.file}: SHA-256 mismatch (got ${digest}, expected ${asset.sha256}); refusing to run it`,
    );
  }
  writeFileSync(zip, bytes, { mode: 0o600 });

  const extractDir = join(dir, ".extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  const extract = await run(process.platform === "win32" ? ["tar", "-xf", zip, "-C", extractDir] : ["unzip", "-o", "-q", zip, "-d", extractDir], {
    timeoutMs: 120_000,
  });
  if (extract.code !== 0) throw new Error(`extracting ${asset.file}: ${extract.stderr || extract.stdout}`);

  const inner = join(extractDir, asset.dir);
  const srcCore = join(inner, asset.core);
  const srcCli = join(inner, asset.cli);
  if (!existsSync(srcCore) || !existsSync(srcCli)) {
    throw new Error(`unexpected archive layout for ${asset.file}: ${asset.dir}/{${asset.core},${asset.cli}} missing`);
  }
  for (const [src, dst] of [
    [srcCore, core],
    [srcCli, cli],
  ]) {
    writeFileSync(dst, readFileSync(src), { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(dst, 0o755);
  }
  writeFileSync(marker, asset.sha256 + "\n", { mode: 0o600 });
  writeFileSync(
    records,
    JSON.stringify({ version: VERSION, zip: asset.sha256, core: await hashFile(core), cli: await hashFile(cli) }, null, 1),
    { mode: 0o600 },
  );
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(zip, { force: true });
  log(`EasyTier ${VERSION} verified and installed in ${dir}`);
  return { core, cli, verified: true };
}

// --- TOML -------------------------------------------------------------------

function tomlString(s: string): string {
  return JSON.stringify(s);
}

/** The hostname this node answers and announces: stable across restarts. */
export function overlayHostname(cfg: Pick<EasytierConfig, "nodeId">): string {
  return `ohmyaihub-${cfg.nodeId}`;
}

/** The whole generated config, including the ACL invariants this project requires. */
export function renderConfig(cfg: EasytierConfig): string {
  const lines: string[] = [];
  const name = overlayHostname(cfg);
  lines.push(`# generated by @oh-my-aihub/magpie-plugin — edits are overwritten`);
  lines.push(`instance_name = ${tomlString(name)}`);
  lines.push(`instance_id = ${tomlString(cfg.instanceId)}`);
  lines.push(`hostname = ${tomlString(name)}`);
  lines.push(`ipv4 = ${tomlString(cfg.virtualIpv4)}`);
  if (cfg.listenAddr) lines.push(`listeners = [${tomlString(cfg.listenAddr.startsWith("tcp://") || cfg.listenAddr.includes("://") ? cfg.listenAddr : `tcp://${cfg.listenAddr}`)}]`);
  if (cfg.peers.length > 0) lines.push(`peer = [${cfg.peers.map((p) => `{ uri = ${tomlString(p)} }`).join(", ")}]`);
  if (cfg.sharingEnabled && cfg.proxyCidr && cfg.mappedCidr) {
    lines.push(
      `proxy_network = [{ cidr = ${tomlString(cfg.proxyCidr)}, mapped_cidr = ${tomlString(cfg.mappedCidr)} }]`,
    );
  }
  if (cfg.socks5Proxy) {
    // EasyTier's SOCKS5 portal is the on-demand path for reading a peer's
    // catalogue: no per-read port forward, no listener 2.6.4 cannot remove.
    // It must be loopback-only; the URL's host is what EasyTier binds
    // (gateway/socks5.rs: `proxy_url.host_str()`), unlike `--socks5`, which
    // hardcodes 0.0.0.0.
    assertLoopbackUrl(cfg.socks5Proxy);
    lines.push(`socks5_proxy = ${tomlString(cfg.socks5Proxy)}`);
  }
  // A forward is part of the generated config, not a runtime-only CLI command:
  // it comes back by itself after an EasyTier restart, and removing one is a
  // config change (2.6.4 cannot delete a forward at runtime).
  for (const f of cfg.consumingEnabled ? cfg.portForwards : []) {
    lines.push("");
    lines.push("[[port_forward]]");
    lines.push(`bind_addr = ${tomlString(f.bindAddr)}`);
    lines.push(`dst_addr = ${tomlString(f.dstAddr)}`);
    lines.push(`proto = "tcp"`);
  }
  lines.push("");
  lines.push("[network_identity]");
  lines.push(`network_name = ${tomlString(cfg.networkName)}`);
  lines.push(`network_secret = ${tomlString(cfg.networkSecret)}`);
  lines.push("");
  lines.push("[flags]");
  lines.push("no_tun = true");
  if (cfg.secureMode) {
    lines.push("");
    lines.push("[secure_mode]");
    lines.push("enabled = true");
    if (cfg.secureIdentity?.privateKey && cfg.secureIdentity?.publicKey) {
      lines.push(`local_private_key = ${tomlString(cfg.secureIdentity.privateKey)}`);
      lines.push(`local_public_key = ${tomlString(cfg.secureIdentity.publicKey)}`);
    }
  }
  lines.push("");
  lines.push("[acl.acl_v1]");
  if (cfg.sharingEnabled) {
    lines.push("# Forward: the subnet-proxy path a consumer reaches; exactly the published ports.");
    lines.push("[[acl.acl_v1.chains]]");
    lines.push('name = "Forward"');
    lines.push("chain_type = 3");
    lines.push("enabled = true");
    lines.push("default_action = 2");
    for (const port of cfg.publishedPorts) {
      lines.push("[[acl.acl_v1.chains.rules]]");
      lines.push(`name = ${tomlString(`allow-${port}`)}`);
      lines.push("priority = 1000");
      lines.push("enabled = true");
      lines.push("protocol = 1");
      lines.push(`ports = [${tomlString(String(port))}]`);
      lines.push("action = 1");
      lines.push("stateful = true");
    }
  }
  lines.push("# Inbound: nothing addressed to this node's own virtual IP is delivered.");
  lines.push("# Never add a rule here for a Magpie port: in no-TUN that is the 127.0.0.1");
  lines.push("# rewrite, which Magpie treats as a local, unauthenticated caller.");
  lines.push("[[acl.acl_v1.chains]]");
  lines.push('name = "Inbound"');
  lines.push("chain_type = 1");
  lines.push("enabled = true");
  lines.push("default_action = 2");
  lines.push("");
  return lines.join("\n");
}

function expectationsOf(cfg: EasytierConfig): AclExpectation {
  return {
    sharingEnabled: cfg.sharingEnabled,
    publishedPorts: cfg.sharingEnabled ? cfg.publishedPorts : [],
    proxy:
      cfg.sharingEnabled && cfg.proxyCidr && cfg.mappedCidr
        ? { cidr: cfg.proxyCidr, mappedCidr: cfg.mappedCidr }
        : null,
    portForwards: cfg.consumingEnabled ? cfg.portForwards : [],
    secureMode: cfg.secureMode,
    networkName: cfg.networkName,
  };
}

// --- supervisor --------------------------------------------------------------

export interface SupervisorEvents {
  onState: (state: SupervisorState) => void;
  /** the provider's exported address changed and the core was restarted for it */
  onProxyMoved?: (proxyCidr: string) => void;
}

export interface SupervisorState {
  sharingEnabled: boolean;
  consumingEnabled: boolean;
  hostname: string | null;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  lastError: string | null;
  coreVersion: string | null;
  rpcPort: number | null;
  networkName: string | null;
  virtualIpv4: string | null;
  proxyCidr: string | null;
  mappedCidr: string | null;
  publishedPorts: number[];
  peers: Peer[];
  secureMode: boolean;
  socks5Port: number | null;
  aclOk: boolean;
  aclProblems: string[];
  lanIp: string | null;
  lastCheckAt: string | null;
}

const emptyState = (): SupervisorState => ({
  sharingEnabled: false,
  consumingEnabled: false,
  hostname: null,
  running: false,
  pid: null,
  startedAt: null,
  restarts: 0,
  lastError: null,
  coreVersion: null,
  rpcPort: null,
  networkName: null,
  virtualIpv4: null,
  proxyCidr: null,
  mappedCidr: null,
  publishedPorts: [],
  peers: [],
  secureMode: false,
  socks5Port: null,
  aclOk: false,
  aclProblems: [],
  lanIp: null,
  lastCheckAt: null,
});

interface Persisted {
  process: CoreProcess | null;
  config: EasytierConfig | null;
  restarts: number;
}

export interface RelocationInput {
  current: string | null;
  observed: string | null;
  pending: string | null;
  count: number;
  now: number;
  lastAt: number;
}

/**
 * When the provider's own address moved far enough to act on. A new address must
 * be seen twice and the previous move must be at least a minute old, so a
 * flapping interface cannot restart the core in a loop.
 */
export function relocationDecision(i: RelocationInput): { relocate: boolean; pending: string | null; count: number } {
  if (!i.current || !i.observed || i.observed === i.current) return { relocate: false, pending: null, count: 0 };
  const count = i.pending === i.observed ? i.count + 1 : 1;
  if (count < 2) return { relocate: false, pending: i.observed, count };
  if (i.now - i.lastAt < 60_000) return { relocate: false, pending: i.observed, count: 0 };
  return { relocate: true, pending: null, count: 0 };
}

export interface SupervisorOptions {
  lanIp?: () => string | null;
  /** injected for tests; production always verifies the downloaded binaries */
  binaries?: Binaries;
  probe?: {
    nodeInfo?: () => Promise<{ peerId: number; proxyCidrs: string[]; listeners: string[]; config: string }>;
    rpcListeners?: (port: number) => Promise<string[]>;
  };
}

/** How many consecutive unsafe runtime checks are tolerated before the core is stopped. */
const MAX_UNSAFE_STRIKES = 2;

export class EasytierSupervisor {
  private state = emptyState();
  private lanIpSource: () => string | null;
  private opts: SupervisorOptions;
  private probe: Required<NonNullable<SupervisorOptions["probe"]>>;
  private unsafeStrikes = 0;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private bin: Binaries | null = null;
  private cfg: EasytierConfig | null = null;
  private restarts = 0;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private lastStartAt = 0;
  private lastRelocateAt = 0;
  private pendingLanIp: string | null = null;
  private pendingLanCount = 0;
  private events: SupervisorEvents;

  constructor(events: SupervisorEvents, opts: SupervisorOptions = {}) {
    this.events = events;
    this.opts = opts;
    this.lanIpSource = opts.lanIp ?? safeLanIp;
    this.probe = {
      nodeInfo: opts.probe?.nodeInfo ?? (() => this.nodeInfo()),
      rpcListeners: opts.probe?.rpcListeners ?? ((port: number) => rpcListeners(port)),
    };
  }

  snapshot(): SupervisorState {
    return structuredClone(this.state);
  }

  private persist(): void {
    const data: Persisted = {
      process: this.state.running && this.state.pid ? { pid: this.state.pid, startedAt: this.state.startedAt ?? "", configPath: this.configPath(), rpcPort: this.state.rpcPort ?? 0 } : null,
      config: this.cfg,
      restarts: this.restarts,
    };
    try {
      writeFileSync(statePath("easytier-state.json"), JSON.stringify(data, null, 1), { mode: 0o600 });
    } catch (e) {
      logger.warn(`cannot persist easytier state: ${String(e)}`);
    }
  }

  private configPath(): string {
    return join(easytierHome(), "current.toml");
  }

  loadPersisted(): Persisted | null {
    try {
      const raw = readFileSync(statePath("easytier-state.json"), "utf8");
      const parsed = JSON.parse(raw) as Persisted;
      registerSecret(parsed.config?.networkSecret);
      return parsed;
    } catch {
      return null;
    }
  }

  /** Whether a pid is alive and looks like our easytier-core. */
  private adoptable(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    return ownsProcess(pid, this.configPath());
  }

  /**
   * Starts (or adopts) the core for cfg. Adoption is what lets a restarted Magpie
   * host take over a core that is already up instead of fighting it.
   */
  async start(cfg: EasytierConfig): Promise<SupervisorState> {
    if (this.state.running) await this.stop();
    this.stopping = false;
    this.cfg = cfg;
    registerSecret(cfg.networkSecret);
    mkdirSync(easytierHome(), { recursive: true, mode: 0o700 });

    this.bin = this.opts.binaries ?? (await ensureBinaries((m) => logger.info(m)));

    const text = renderConfig(cfg);
    const acl = checkConfig(text, expectationsOf(cfg));
    this.state.aclOk = acl.ok;
    this.state.aclProblems = acl.problems;
    if (!acl.ok) {
      this.state.lastError = `refusing to start: ACL invariants violated: ${acl.problems.join("; ")}`;
      logger.error(this.state.lastError);
      this.emit();
      throw new Error(this.state.lastError);
    }
    writeFileSync(this.configPath(), text, { mode: 0o600 });

    // what this node is, whether the core is adopted or started now
    this.state.sharingEnabled = cfg.sharingEnabled;
    this.state.consumingEnabled = cfg.consumingEnabled;
    this.state.hostname = overlayHostname(cfg);
    this.state.networkName = cfg.networkName;
    this.state.virtualIpv4 = cfg.virtualIpv4;
    this.state.proxyCidr = cfg.proxyCidr;
    this.state.mappedCidr = cfg.mappedCidr;
    this.state.publishedPorts = [...cfg.publishedPorts];
    this.state.secureMode = cfg.secureMode;
    this.state.socks5Port = cfg.socks5Proxy ? Number(new URL(cfg.socks5Proxy).port) : null;
    this.state.rpcPort = cfg.rpcPort;

    const persisted = this.loadPersisted();
    if (persisted?.process && this.adoptable(persisted.process.pid) && persisted.process.configPath === this.configPath()) {
      logger.info(`adopting running easytier-core pid ${persisted.process.pid}`);
      this.state.pid = persisted.process.pid;
      this.state.startedAt = persisted.process.startedAt || new Date().toISOString();
      this.state.running = true;
      this.state.rpcPort = cfg.rpcPort;
      this.startMonitor();
      await this.refresh();
      return this.snapshot();
    }

    const version = (await run([this.bin.core, "--version"], { timeoutMs: 10_000 })).stdout.trim();
    const args = [this.bin.core, "-c", this.configPath(), "-r", `127.0.0.1:${cfg.rpcPort}`];
    logger.info(`starting ${version}`);
    const proc = Bun.spawn({
      cmd: args,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    this.proc = proc;
    this.lastStartAt = Date.now();
    this.state.pid = proc.pid;
    this.state.running = true;
    this.state.startedAt = new Date().toISOString();
    this.state.coreVersion = version;
    this.state.rpcPort = cfg.rpcPort;
    this.state.lastError = null;

    void this.pump(proc);
    this.startMonitor();
    this.persist();
    this.emit();

    const up = await this.waitForRpc(cfg.rpcPort, 20_000);
    if (!up) {
      const why = `easytier-core did not answer its RPC on 127.0.0.1:${cfg.rpcPort} within 20s`;
      logger.error(why);
      this.state.lastError = why;
      await this.stop();
      throw new Error(why);
    }
    await this.refresh();
    return this.snapshot();
  }

  private async pump(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const read = async (stream: ReadableStream<Uint8Array>, level: "info" | "error") => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        let i = rest.indexOf("\n");
        while (i >= 0) {
          const line = rest.slice(0, i).trimEnd();
          rest = rest.slice(i + 1);
          if (line) logger[level](`easytier: ${line}`);
          i = rest.indexOf("\n");
        }
      }
      if (rest.trim()) logger[level](`easytier: ${rest}`);
    };
    void read(proc.stdout as ReadableStream<Uint8Array>, "info");
    void read(proc.stderr as ReadableStream<Uint8Array>, "error");
    const code = await proc.exited;
    if (this.proc === proc) this.proc = null; // the handle no longer pins a pid
    if (this.stopping) return;
    logger.error(`easytier-core exited unexpectedly (code ${code})`);
    this.state.running = false;
    this.state.pid = null;
    this.persist();
    this.emit();
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (!this.cfg || this.stopping) return;
    const stable = Date.now() - this.lastStartAt > 5 * 60_000;
    if (stable) this.consecutiveFailures = 0;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures > 5) {
      this.state.lastError = "easytier-core keeps failing; giving up after 5 restarts";
      logger.error(this.state.lastError);
      this.emit();
      return;
    }
    const delay = Math.min(30_000, 2 ** (this.consecutiveFailures - 1) * 1000);
    this.restarts += 1;
    this.state.restarts = this.restarts;
    this.state.lastError = `restarting in ${delay} ms (attempt ${this.consecutiveFailures})`;
    this.emit();
    setTimeout(() => {
      if (!this.cfg || this.stopping) return;
      this.start(this.cfg).catch((e) => logger.error(`restart failed: ${String(e)}`));
    }, delay);
  }

  private startMonitor(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.refresh().catch((e) => logger.warn(`refresh failed: ${String(e)}`));
    }, 10_000);
  }

  private emit(): void {
    this.events.onState(this.snapshot());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pid = this.state.pid;
    if (pid) {
      // A child we spawned in this process is ours by handle, whatever `ps` says
      // about its command line (a script's argv changes under a shell shebang).
      // An adopted pid has no handle, so its command line must still be ours.
      const byHandle = this.proc !== null && this.proc.pid === pid && this.proc.exitCode === null;
      if (!byHandle && !ownsProcess(pid, this.configPath())) {
        logger.warn(`pid ${pid} no longer runs our easytier-core (exited or reused); not signalling it`);
      } else {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (!ownsProcess(pid, this.configPath())) break;
          if (i === 49) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* gone */
            }
          }
        }
      }
    }
    this.proc = null;
    this.state.running = false;
    this.state.pid = null;
    this.persist();
    this.emit();
  }

  private async waitForRpc(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.cli(["-o", "json", "node"], port, 3000);
      if (r.code === 0) return true;
      await new Promise((res) => setTimeout(res, 500));
    }
    return false;
  }

  private async cli(args: string[], port?: number, timeoutMs = 10_000) {
    if (!this.bin) throw new Error("EasyTier binaries are not ready");
    const rpc = port ?? this.state.rpcPort;
    if (!rpc) throw new Error("no RPC port");
    return run([this.bin.cli, "-p", `127.0.0.1:${rpc}`, ...args], { timeoutMs });
  }

  async peers(): Promise<Peer[]> {
    const r = await this.cli(["-o", "json", "peer", "list"]);
    if (r.code !== 0) throw new Error(`peer list: ${r.stderr || r.stdout}`);
    const arr = JSON.parse(r.stdout || "[]") as Record<string, unknown>[];
    const out: Peer[] = [];
    for (const p of arr) {
      out.push({
        ipv4: String(p.ipv4 ?? ""),
        hostname: String(p.hostname ?? ""),
        cost: String(p.cost ?? ""),
        latencyMs: String(p.lat_ms ?? ""),
        loss: String(p.loss_rate ?? ""),
        tunnel: String(p.tunnel_proto ?? ""),
        nat: String(p.nat_type ?? ""),
        id: String(p.id ?? ""),
      });
    }
    return out;
  }

  async routes(): Promise<RouteRow[]> {
    const r = await this.cli(["-o", "json", "route"]);
    if (r.code !== 0) throw new Error(`route: ${r.stderr || r.stdout}`);
    const arr = JSON.parse(r.stdout || "[]") as Record<string, unknown>[];
    return arr.map((x) => ({
      ipv4: String(x.ipv4 ?? ""),
      hostname: String(x.hostname ?? ""),
      proxyCidrs: String(x.proxy_cidrs ?? ""),
      nextHop: String(x.next_hop_hostname ?? ""),
      pathLen: Number(x.path_len ?? 0),
    }));
  }

  async nodeInfo(): Promise<{ peerId: number; proxyCidrs: string[]; listeners: string[]; config: string }> {
    const r = await this.cli(["-o", "json", "node"]);
    if (r.code !== 0) throw new Error(`node: ${r.stderr || r.stdout}`);
    const o = JSON.parse(r.stdout || "{}") as Record<string, unknown>;
    return {
      peerId: Number(o.peer_id ?? 0),
      proxyCidrs: (o.proxy_cidrs as string[] | undefined) ?? [],
      listeners: (o.listeners as string[] | undefined) ?? [],
      config: String(o.config ?? ""),
    };
  }

  async listPortForwards(): Promise<PortForward[]> {
    const r = await this.cli(["-o", "json", "port-forward", "list"]);
    if (r.code !== 0) throw new Error(`port-forward list: ${r.stderr || r.stdout}`);
    const o = JSON.parse(r.stdout || "{}") as { cfgs?: Record<string, unknown>[] };
    return (o.cfgs ?? []).map((c) => decodeForward(c)).filter((f) => f.bindAddr || f.dstAddr);
  }

  /**
   * Opens the loopback listener towards a remote provider. Adding the same rule
   * twice really does create two listeners in 2.6.4, so an identical rule that
   * is already there is left alone (this is what makes a repeated connect
   * idempotent). Returns true when a rule was added.
   */
  async addPortForward(bindAddr: string, dstAddr: string): Promise<boolean> {
    assertLoopbackBind(bindAddr);
    const existing = await this.listPortForwards();
    if (existing.some((f) => f.bindAddr === bindAddr && f.dstAddr === dstAddr)) return false;
    if (existing.some((f) => f.bindAddr === bindAddr && f.dstAddr !== dstAddr)) {
      throw new Error(`127.0.0.1:${bindAddr.split(":")[1]} is already forwarding to ${existing.find((f) => f.bindAddr === bindAddr)?.dstAddr}`);
    }
    const r = await this.cli(["port-forward", "add", "tcp", bindAddr, dstAddr], undefined, 15_000);
    if (r.code !== 0) throw new Error(`port-forward add: ${r.stderr || r.stdout}`);
    return true;
  }

  /**
   * Asks the core to drop a forward. EasyTier 2.6.4 prints success and keeps the
   * listener: removal only takes effect when the core restarts with a config
   * that no longer names it (see the generated `[[port_forward]]`). Callers must
   * therefore treat the return value as advisory and verify with the list.
   */
  async removePortForward(bindAddr: string): Promise<void> {
    const r = await this.cli(["port-forward", "remove", "tcp", bindAddr], undefined, 15_000);
    if (r.code !== 0 && !/not found|no such|does not exist/i.test(r.stderr + r.stdout)) {
      throw new Error(`port-forward remove: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * Updates the in-memory config and rewrites the generated TOML, without
   * restarting: the next core start (a crash restart, a Magpie restart, an ACL
   * change) then restores exactly this set of forwards. A forward added live by
   * `addPortForward` is persisted here in the same operation.
   */
  setForwards(forwards: ForwardSpec[]): void {
    if (!this.cfg) return;
    this.cfg = { ...this.cfg, portForwards: forwards.map((f) => ({ bindAddr: f.bindAddr, dstAddr: f.dstAddr })) };
    try {
      writeFileSync(this.configPath(), renderConfig(this.cfg), { mode: 0o600 });
      this.persist();
    } catch (e) {
      logger.warn(`cannot persist the forward set: ${String(e)}`);
    }
  }

  /**
   * Re-reads the running core and proves it is still in the state this project
   * requires. Anything that cannot be proven — an ACL that changed, an export
   * that is not announced, an RPC portal somewhere else or not verifiable, a
   * configuration that cannot be read — is a strike; two consecutive strikes stop
   * the core this plugin owns. An explicit start() re-validates everything before
   * serving again.
   */
  async refresh(): Promise<SupervisorState> {
    if (!this.state.running) return this.snapshot();
    const problems: string[] = [];

    let node: { peerId: number; proxyCidrs: string[]; listeners: string[]; config: string } | null = null;
    try {
      node = await this.probe.nodeInfo();
    } catch (e) {
      problems.push(`cannot read the running configuration: ${(e as Error).message}`);
    }

    if (node) {
      const acl = checkConfig(
        node.config,
        this.cfg
          ? expectationsOf(this.cfg)
          : {
              sharingEnabled: false,
              publishedPorts: [],
              proxy: null,
              portForwards: [],
              secureMode: false,
              networkName: "",
            },
      );
      problems.push(...acl.problems);

      const effective = extractToml(node.config, "network_secret");
      if (effective) registerSecret(effective);

      if (this.cfg?.sharingEnabled && this.cfg.mappedCidr) {
        const want = mappedHost(this.cfg.mappedCidr);
        // An unmapped export is listed as "10.0.0.1"; a mapped one as
        // "192.0.2.10->10.66.1.2" (real->dialled), so compare the dialled side.
        const has = node.proxyCidrs.some((c) => c === want || c.endsWith(`->${want}`) || c === this.cfg?.mappedCidr);
        if (!has) problems.push(`proxy CIDR ${want} is not announced (got ${node.proxyCidrs.join(",") || "none"})`);
      }

      if (this.cfg?.socks5Proxy) {
        const effective = extractToml(node.config, "socks5_proxy");
        if (effective !== this.cfg.socks5Proxy) {
          problems.push(`the running core does not carry the loopback SOCKS5 listener ${this.cfg.socks5Proxy}`);
        }
      }

      try {
        this.state.peers = await this.peers();
      } catch (e) {
        logger.warn(`peer list unavailable: ${String(e)}`);
      }
      this.state.lanIp = safeLanIp();
      this.state.rpcPort = this.state.rpcPort ?? this.cfg?.rpcPort ?? null;
      this.state.lastCheckAt = new Date().toISOString();
    }

    if (this.state.rpcPort) {
      try {
        const bound = await this.probe.rpcListeners(this.state.rpcPort);
        if (bound.length === 0) {
          problems.push(`the RPC portal on port ${this.state.rpcPort} cannot be verified (no listener found)`);
        } else if (bound.some((a) => !a.startsWith("127.0.0.1"))) {
          problems.push(`the RPC portal listens on ${bound.join(", ")}, not loopback`);
        }
      } catch (e) {
        problems.push(`the RPC portal on port ${this.state.rpcPort} cannot be verified: ${(e as Error).message}`);
      }
    }

    if (this.state.socks5Port) {
      // The catalogue client reaches peers through this local proxy. If it is
      // bound beyond loopback, any LAN host could use the private overlay.
      try {
        const bound = await this.probe.rpcListeners(this.state.socks5Port);
        if (bound.length === 0) {
          problems.push(`the catalogue SOCKS5 listener on port ${this.state.socks5Port} cannot be verified (no listener found)`);
        } else if (bound.some((a) => !a.startsWith("127.0.0.1"))) {
          problems.push(`the catalogue SOCKS5 listener listens on ${bound.join(", ")}, not loopback`);
        }
      } catch (e) {
        problems.push(`the catalogue SOCKS5 listener on port ${this.state.socks5Port} cannot be verified: ${(e as Error).message}`);
      }
    }

    const ok = problems.length === 0;
    this.state.aclOk = ok;
    this.state.aclProblems = problems;
    if (!ok) {
      this.unsafeStrikes += 1;
      logger.error(`unsafe runtime state (${this.unsafeStrikes}/${MAX_UNSAFE_STRIKES}): ${problems.join("; ")}`);
      if (this.unsafeStrikes >= MAX_UNSAFE_STRIKES) {
        await this.haltUnsafe(problems);
        return this.snapshot();
      }
    } else {
      this.unsafeStrikes = 0;
    }

    this.persist();
    this.emit();
    this.maybeRelocate();
    return this.snapshot();
  }

  /** Stops an owned core that cannot be proven safe, and keeps it stopped. */
  private async haltUnsafe(problems: string[]): Promise<void> {
    this.state.lastError = `refusing to serve: ${problems.join("; ")}`;
    this.state.aclOk = false;
    this.state.aclProblems = problems;
    logger.error(`stopping easytier-core: ${this.state.lastError}`);
    // No supervised restart: the configuration must be fixed and start() called
    // again, which re-validates the generated file and the running core.
    await this.stop();
    this.stopping = true;
    this.emit();
  }

  /**
   * The provider's exported address moved: rewrite the export and restart (2.6.4
   * has no hot ACL/proxy edit). Called from the monitor only after the new
   * address has been seen twice and not sooner than a minute after the previous
   * move, so a flapping interface does not restart the core in a loop.
   */
  async relocateProxy(): Promise<SupervisorState> {
    if (!this.cfg || !this.cfg.sharingEnabled) return this.snapshot();
    const ip = this.lanIpSource();
    if (!ip || !this.cfg.proxyCidr) return this.snapshot();
    const next = `${ip}/32`;
    if (next === this.cfg.proxyCidr) return this.snapshot();
    if (Date.now() - this.lastRelocateAt < 60_000) {
      logger.warn(`LAN address moved to ${next} again within a minute; keeping ${this.cfg.proxyCidr} for now`);
      return this.snapshot();
    }
    logger.warn(`provider LAN address changed: ${this.cfg.proxyCidr} -> ${next}; restarting easytier-core`);
    this.lastRelocateAt = Date.now();
    this.cfg = { ...this.cfg, proxyCidr: next };
    const state = await this.start(this.cfg);
    this.events.onProxyMoved?.(next);
    return state;
  }

  /** Watches the provider's own address; called by the monitor. */
  private maybeRelocate(): void {
    if (!this.cfg || !this.cfg.sharingEnabled || !this.cfg.proxyCidr) return;
    const ip = this.lanIpSource();
    const decision = relocationDecision({
      current: this.cfg.proxyCidr,
      observed: ip ? `${ip}/32` : null,
      pending: this.pendingLanIp,
      count: this.pendingLanCount,
      now: Date.now(),
      lastAt: this.lastRelocateAt,
    });
    this.pendingLanIp = decision.pending;
    this.pendingLanCount = decision.count;
    if (decision.relocate) {
      this.relocateProxy().catch((e) => logger.error(`relocating the export failed: ${String(e)}`));
    }
  }
}

function safeLanIp(): string | null {
  try {
    return lanIPv4();
  } catch {
    return null;
  }
}

function extractToml(text: string, key: string): string | null {
  const m = new RegExp(`${key}\\s*=\\s*"([^"]+)"`).exec(text);
  return m ? m[1] : null;
}

function assertLoopbackBind(bindAddr: string): void {
  const host = bindAddr.replace(/^tcp:\/\//, "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`refusing a port forward bound to ${bindAddr}: local proxies must listen on 127.0.0.1`);
  }
}

function assertLoopbackUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing a malformed SOCKS5 URL: ${url}`);
  }
  if (parsed.protocol !== "socks5:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
    throw new Error(`refusing a SOCKS5 listener that is not 127.0.0.1:<port>: ${url}`);
  }
}

/** The addresses a listener is bound to, from lsof (macOS) or ss (Linux). */
export async function rpcListeners(port: number): Promise<string[]> {
  if (process.platform === "darwin") {
    const r = await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeoutMs: 5000 });
    const out: string[] = [];
    for (const line of r.stdout.split("\n").slice(1)) {
      const m = /\s(\S+):(\d+)\s+\(LISTEN\)/.exec(line);
      if (m && Number(m[2]) === port) out.push(m[1]);
    }
    return [...new Set(out)];
  }
  const r = await run(["ss", "-lntp"], { timeoutMs: 5000 });
  const out: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.includes(`:${port}`)) continue;
    const m = /\s(\S+):(\d+)\s/.exec(line);
    if (m && Number(m[2]) === port) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * A persisted Secure Mode identity: X25519, base64 (EasyTier's format, see
 * normalize_secure_mode_config). Keeping it makes the peer's public key stable
 * across restarts, which the wallet phase will bind identity to.
 */
export function generateSecureIdentity(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privJwk = privateKey.export({ format: "jwk" }) as { d?: string };
  const pubJwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!privJwk.d || !pubJwk.x) throw new Error("X25519 export failed");
  const rawPriv = Buffer.from(privJwk.d, "base64url");
  const rawPub = Buffer.from(pubJwk.x, "base64url");
  return { privateKey: rawPriv.toString("base64"), publicKey: rawPub.toString("base64") };
}

/** File mode check helper used by tests and the status page. */
export function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return -1;
  }
}

export { redact };
