import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { EASYTIER_VERSION, assetFor, assetUrl } from "./easytier-manifest.ts";
import { logger, registerSecret, redact } from "./log.ts";
import { lanIPv4, stateDir, statePath } from "./paths.ts";
import { run } from "./run.ts";

export type Role = "provider" | "consumer";

export interface EasytierConfig {
  role: Role;
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
  /** provider: the provider's own address exported through the overlay */
  proxyCidr: string | null;
  /** provider: the stable address consumers dial */
  mappedCidr: string | null;
  /** provider: ports the Forward chain may reach (default [3425]) */
  publishedPorts: number[];
  secureMode: boolean;
  /** persisted X25519 identity (base64), so the peer key survives restarts */
  secureIdentity?: { privateKey: string; publicKey: string } | null;
  instanceName: string;
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

export interface PortForward {
  protocol: string;
  bindAddr: string;
  dstAddr: string;
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

  if (existsSync(core) && existsSync(cli) && existsSync(marker)) {
    if (readFileSync(marker, "utf8").trim() === asset.sha256) {
      return { core, cli, verified: true };
    }
    log(`binaries at ${dir} do not match the pinned hash; reinstalling`);
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
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(zip, { force: true });
  log(`EasyTier ${VERSION} verified and installed in ${dir}`);
  return { core, cli, verified: true };
}

// --- TOML -------------------------------------------------------------------

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function overlayNet(overlayCidr: string): string {
  return overlayCidr.replace(/\.0\/24$/, ".0/24");
}

/** The whole generated config, including the ACL invariants this project requires. */
export function renderConfig(cfg: EasytierConfig): string {
  const lines: string[] = [];
  lines.push(`# generated by @oh-my-aihub/magpie-plugin — edits are overwritten`);
  lines.push(`instance_name = ${tomlString(cfg.instanceName)}`);
  lines.push(`hostname = ${tomlString(cfg.instanceName)}`);
  lines.push(`ipv4 = ${tomlString(cfg.virtualIpv4)}`);
  if (cfg.listenAddr) lines.push(`listeners = [${tomlString(cfg.listenAddr.startsWith("tcp://") || cfg.listenAddr.includes("://") ? cfg.listenAddr : `tcp://${cfg.listenAddr}`)}]`);
  if (cfg.peers.length > 0) lines.push(`peer = [${cfg.peers.map((p) => `{ uri = ${tomlString(p)} }`).join(", ")}]`);
  if (cfg.role === "provider" && cfg.proxyCidr && cfg.mappedCidr) {
    lines.push(
      `proxy_network = [{ cidr = ${tomlString(cfg.proxyCidr)}, mapped_cidr = ${tomlString(cfg.mappedCidr)} }]`,
    );
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
  if (cfg.role === "provider") {
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

export interface AclCheck {
  ok: boolean;
  problems: string[];
}

/** The invariants that make the ingress safe (docs/ARCHITECTURE.md, decision 3). */
export function checkAclInvariants(text: string): AclCheck {
  const problems: string[] = [];
  if (/\btcp_whitelist\s*=/.test(text)) problems.push("tcp_whitelist is present (it builds Inbound allow rules)");
  if (/\budp_whitelist\s*=/.test(text)) problems.push("udp_whitelist is present");

  const inbound = section(text, "Inbound");
  if (!inbound) {
    problems.push("no Inbound chain: EasyTier's default inbound action is Allow");
  } else {
    if (!/default_action\s*=\s*2\b/.test(inbound)) problems.push("Inbound chain does not default to Drop");
    const rules = (inbound.match(/\[\[acl\.acl_v1\.chains\.rules\]\]/g) ?? []).length;
    if (rules > 0) problems.push(`Inbound chain has ${rules} rule(s); it must have none`);
  }
  if (/\bforward_by_system\s*=\s*true/.test(text)) problems.push("forward_by_system would bypass the internal proxy");

  if (/\[\[acl\.acl_v1\.chains\]\]/.test(text)) {
    // every Forward chain must default to Drop
    for (const chunk of chainsOfType(text, 3)) {
      if (!/default_action\s*=\s*2\b/.test(chunk)) problems.push("a Forward chain does not default to Drop");
    }
  }
  return { ok: problems.length === 0, problems };
}

function section(text: string, name: string): string | null {
  for (const chunk of chains(text)) {
    if (new RegExp(`^name = "${name}"$`, "m").test(chunk)) return chunk;
  }
  return null;
}

function chains(text: string): string[] {
  const parts = text.split(/^\[\[acl\.acl_v1\.chains\]\]$/m);
  return parts.slice(1).map((p) => p.split(/^\[\[acl\.acl_v1\.chains\.rules\]\]$/m).length > 0 ? p : p);
}

function chainsOfType(text: string, chainType: number): string[] {
  const out: string[] = [];
  for (const chunk of chains(text)) {
    // the chain's own header precedes its rules; compare only the header block
    const header = chunk.split(/^\[\[acl\.acl_v1\.chains\.rules\]\]$/m)[0] ?? "";
    if (new RegExp(`chain_type = ${chainType}\\b`).test(header)) out.push(chunk);
  }
  return out;
}

// --- supervisor --------------------------------------------------------------

export interface SupervisorEvents {
  onState: (state: SupervisorState) => void;
}

export interface SupervisorState {
  role: Role | null;
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
  aclOk: boolean;
  aclProblems: string[];
  lanIp: string | null;
  lastCheckAt: string | null;
}

const emptyState = (): SupervisorState => ({
  role: null,
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

export class EasytierSupervisor {
  private state = emptyState();
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private bin: Binaries | null = null;
  private cfg: EasytierConfig | null = null;
  private restarts = 0;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private lastStartAt = 0;
  private events: SupervisorEvents;

  constructor(events: SupervisorEvents) {
    this.events = events;
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
    const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
    return r.stdout.toString().includes("easytier-core");
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

    this.bin = await ensureBinaries((m) => logger.info(m));

    const text = renderConfig(cfg);
    const acl = checkAclInvariants(text);
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
    this.state.role = cfg.role;
    this.state.networkName = cfg.networkName;
    this.state.virtualIpv4 = cfg.virtualIpv4;
    this.state.proxyCidr = cfg.proxyCidr;
    this.state.mappedCidr = cfg.mappedCidr;
    this.state.publishedPorts = [...cfg.publishedPorts];
    this.state.secureMode = cfg.secureMode;
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
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        if (i === 49) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* gone */
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

  async routes(): Promise<{ ipv4: string; hostname: string; proxyCidrs: string; nextHop: string; pathLen: number }[]> {
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
    return (o.cfgs ?? []).map((c) => ({
      protocol: String(c.protocol ?? c.proto ?? ""),
      bindAddr: String(c.bind_addr ?? ""),
      dstAddr: String(c.dst_addr ?? ""),
    }));
  }

  async addPortForward(bindAddr: string, dstAddr: string): Promise<void> {
    assertLoopbackBind(bindAddr);
    const r = await this.cli(["port-forward", "add", "tcp", bindAddr, dstAddr], undefined, 15_000);
    if (r.code !== 0) throw new Error(`port-forward add: ${r.stderr || r.stdout}`);
  }

  async removePortForward(bindAddr: string): Promise<void> {
    const r = await this.cli(["port-forward", "remove", "tcp", bindAddr], undefined, 15_000);
    if (r.code !== 0 && !/not found|no such|does not exist/i.test(r.stderr + r.stdout)) {
      throw new Error(`port-forward remove: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * Re-reads the running core and checks the invariants this project depends on:
   * the effective config's ACL, the RPC bound to loopback, and the proxy prefix.
   */
  async refresh(): Promise<SupervisorState> {
    if (!this.state.running) return this.snapshot();
    try {
      const node = await this.nodeInfo();
      const acl = checkAclInvariants(node.config);
      this.state.aclOk = acl.ok;
      this.state.aclProblems = acl.problems;
      if (!acl.ok) logger.error(`effective ACL failed the check: ${acl.problems.join("; ")}`);

      const effective = extractToml(node.config, "network_secret");
      if (effective) registerSecret(effective);

      this.state.peers = await this.peers();
      this.state.lanIp = safeLanIp();
      this.state.rpcPort = this.state.rpcPort ?? this.cfg?.rpcPort ?? null;
      this.state.lastCheckAt = new Date().toISOString();

      if (this.cfg?.role === "provider" && this.cfg.mappedCidr) {
        const want = this.cfg.mappedCidr.replace(/\/32$/, "");
        // An unmapped export is listed as "10.0.0.1"; a mapped one as
        // "192.0.2.10->10.66.1.2" (real->dialled), so compare the dialled side.
        const has = node.proxyCidrs.some((c) => c === want || c.endsWith(`->${want}`) || c === this.cfg?.mappedCidr);
        if (!has) {
          this.state.aclProblems = [...this.state.aclProblems, `proxy CIDR ${want} is not announced (got ${node.proxyCidrs.join(",") || "none"})`];
          this.state.aclOk = false;
        }
      }
      if (this.state.rpcPort) {
        const rpcBound = await rpcListeners(this.state.rpcPort);
        if (rpcBound.length > 0 && rpcBound.some((a) => !a.startsWith("127.0.0.1"))) {
          this.state.aclProblems = [...this.state.aclProblems, `RPC portal listens on ${rpcBound.join(", ")}, not loopback`];
          this.state.aclOk = false;
        }
      }
    } catch (e) {
      this.state.lastError = String(e);
    }
    this.persist();
    this.emit();
    return this.snapshot();
  }

  /** called when the LAN address moved: rewrite the export and restart (no hot ACL). */
  async relocateProxy(): Promise<SupervisorState> {
    if (!this.cfg || this.cfg.role !== "provider") return this.snapshot();
    const ip = safeLanIp();
    if (!ip || !this.cfg.proxyCidr) return this.snapshot();
    const next = `${ip}/32`;
    if (next === this.cfg.proxyCidr) return this.snapshot();
    logger.warn(`provider LAN address changed: ${this.cfg.proxyCidr} -> ${next}; restarting easytier-core`);
    this.cfg = { ...this.cfg, proxyCidr: next };
    return this.start(this.cfg);
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

/** A random, persisted virtual address inside the fixed overlay /24. */
export function randomVirtualIp(overlayCidr: string, taken: Set<number> = new Set()): string {
  const base = overlayCidr.replace(/\.0\/24$/, "");
  for (let i = 0; i < 200; i++) {
    const host = 2 + Math.floor(Math.random() * 252);
    if (!taken.has(host)) return `${base}.${host}/24`;
  }
  throw new Error("no free overlay address");
}

/**
 * A unique, persisted per-provider overlay prefix (10.66.a.b/32). Two providers
 * exporting the same LAN subnet are only addressable apart because of this.
 */
export function randomMappedCidr(taken: Set<string> = new Set()): string {
  for (let i = 0; i < 200; i++) {
    const a = 1 + Math.floor(Math.random() * 254);
    const b = 1 + Math.floor(Math.random() * 254);
    const cidr = `10.66.${a}.${b}/32`;
    if (!taken.has(cidr)) return cidr;
  }
  throw new Error("no free mapped CIDR");
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
