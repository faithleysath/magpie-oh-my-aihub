// EasyTier lifecycle for the agent-native plugin.
//
// One supervisor per plugin host. It downloads the pinned release asset, checks
// its SHA-256, writes `easytier/current.toml`, spawns `easytier-core` with a
// loopback RPC portal, reads the overlay address and peers through
// `easytier-cli`, and restarts a core that exits unexpectedly (bounded). It
// only ever stops the child it spawned itself; it never adopts or kills another
// EasyTier on the machine.
//
// The export is `[[proxy_network]]` plus the Forward ACL that allows exactly the
// directory port and the Magpie gateway, whenever a LAN address exists. The
// consumer side is one `[[port_forward]]` per connection (loopback ->
// `<peer mapped host>:<gateway>`), added live with the EasyTier CLI and restored
// from the generated TOML after a restart.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomMappedCidr } from "./addresses.ts";
import type { HubConfig } from "./config.ts";
import { EASYTIER_VERSION, assetFor, assetUrl } from "./easytier-manifest.ts";
import { detectLanIPv4 } from "./lan.ts";
import { logger, registerSecret } from "./log.ts";
import { statePath } from "./paths.ts";
import { run } from "./run.ts";
import { loadOrCreateSecureKeyPair, type SecureKeyPair } from "./secure-key.ts";

export type OverlayState = "offline" | "starting" | "online" | "error";

export interface OverlayPeer {
  hostname: string;
  ipv4: string;
  online: boolean;
}

export interface OverlayStatus {
  configured: boolean;
  networkName: string | null;
  /** EasyTier secure mode: the network requires it, this node runs it */
  secureMode: boolean;
  state: OverlayState;
  step: string;
  detail: string | null;
  overlayIp: string | null;
  hostname: string | null;
  peers: OverlayPeer[];
  publishedPorts: number[];
}

/** What the generated TOML exports. Both values are needed to write the export. */
export interface OverlayPublish {
  lanIp: string | null;
  mappedCidr: string | null;
}

/** One peer as EasyTier's own peer/route tables describe it (routing clues only). */
export interface OverlayNeighbor {
  hostname: string;
  ipv4: string;
  /** the mapped address this peer exports, or null when it exports nothing */
  mappedHost: string | null;
}

export interface OverlayHooks {
  /** the persisted config changed (a mapped CIDR was allocated for the first time) */
  onConfigChange?: (cfg: HubConfig) => void;
  /** the core answered for the first time since this start */
  onOnline?: () => void;
}

/**
 * Fixed ports. The environment overrides exist only so an
 * isolated test can run beside an already-running EasyTier; production uses the
 * defaults.
 */
function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

export const CONTROL_PORT = envPort("OH_MY_AIHUB_CONTROL_PORT", 3426);
export const GATEWAY_PORT = envPort("OH_MY_AIHUB_GATEWAY_PORT", 3425);
export const SOCKS_PORT = envPort("OH_MY_AIHUB_SOCKS_PORT", 13400);
export const RPC_PORT = envPort("OH_MY_AIHUB_RPC_PORT", 15888);

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 5 * 60_000;
const MONITOR_MS = 10_000;

export function easytierHome(): string {
  const dir = statePath("easytier");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function binariesDir(): string {
  return join(easytierHome(), `v${EASYTIER_VERSION}`, `${process.platform}-${process.arch}`);
}

export function currentTomlPath(): string {
  return join(easytierHome(), "current.toml");
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

/** `real/32->mapped/32` (or a bare mapped prefix) → the mapped IPv4 to dial. */
function mappedHostOf(proxyCidrs: string): string | null {
  for (const raw of proxyCidrs.split(",").map((item) => item.trim())) {
    if (!raw) continue;
    const dialled = raw.includes("->") ? raw.split("->")[1]!.trim() : raw;
    const host = dialled.replace(/\/\d+$/, "");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  }
  return null;
}

/**
 * One address from `port-forward list -o json`. EasyTier 2.6.4 prints the
 * protobuf `SocketAddr { port, ip: { Ipv4: { addr: <u32> } } }`, not the
 * `127.0.0.1:13425` string the human table shows. Copied from the old
 * supervisor so this module does not import it.
 */
function decodeForwardAddr(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const rec = raw as { port?: unknown; ip?: unknown } | null;
  if (!rec || typeof rec !== "object") return "";
  const port = Number(rec.port ?? 0);
  const ip = rec.ip as Record<string, unknown> | undefined;
  const v4 = ip?.Ipv4 as { addr?: unknown } | undefined;
  if (!v4 || typeof v4.addr !== "number") return port ? `:${port}` : "";
  const n = v4.addr >>> 0;
  return `${[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")}:${port}`;
}

function decodeForward(raw: Record<string, unknown>): { bindAddr: string; dstAddr: string } {
  return {
    bindAddr: decodeForwardAddr(raw.bind_addr ?? raw.bindAddr).replace(/^tcp:\/\//, ""),
    dstAddr: decodeForwardAddr(raw.dst_addr ?? raw.dstAddr).replace(/^tcp:\/\//, ""),
  };
}

function assertLoopbackBind(bindAddr: string): void {
  const host = bindAddr.replace(/^tcp:\/\//, "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`E_INPUT: refusing a port forward bound to ${bindAddr}: local proxies listen on 127.0.0.1`);
  }
}

function toml(value: string): string {
  // JSON string escaping is valid TOML basic-string escaping.
  return JSON.stringify(value);
}

function peerUris(initialNode: string | null): string[] {
  if (!initialNode) return [];
  return initialNode
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(item) ? item : `tcp://${item}`));
}

/** Renders the exact TOML this plugin starts. Exported for tests. */
export function renderOverlayConfig(
  cfg: HubConfig,
  publish: OverlayPublish = { lanIp: null, mappedCidr: null },
  secure: SecureKeyPair | null = null,
): string {
  const network = cfg.network;
  if (!network) throw new Error("E_NO_NETWORK: join a network before starting EasyTier");
  const hostname = cfg.hostname;
  if (!hostname) throw new Error("E_NO_WALLET: the overlay hostname needs a wallet");
  if (network.secureMode && !secure) {
    throw new Error("E_SECURE_KEY: secure mode needs this node's X25519 pair");
  }

  const lines: string[] = [];
  lines.push("# generated by magpie-oh-my-aihub — edits are overwritten");
  lines.push(`instance_name = ${toml(hostname)}`);
  lines.push(`hostname = ${toml(hostname)}`);

  const peers = peerUris(network.initialNode);
  if (peers.length > 0) {
    lines.push(`peer = [${peers.map((uri) => `{ uri = ${toml(uri)} }`).join(", ")}]`);
  }

  // EasyTier 2.6.4 binds the SOCKS5 portal to the URL's host. It must be
  // loopback: this node's own directory reads go through it.
  lines.push(`socks5_proxy = ${toml(`socks5://127.0.0.1:${SOCKS_PORT}`)}`);

  // The export is what makes the directory reachable. No LAN
  // address means no export and no Forward rule: an ACL that allows ports on an
  // export that does not exist is dead config.
  const exported = Boolean(publish.lanIp && publish.mappedCidr);
  if (exported) {
    lines.push(
      `proxy_network = [{ cidr = ${toml(`${publish.lanIp}/32`)}, mapped_cidr = ${toml(publish.mappedCidr!)} }]`,
    );
  }

  // Consumer side: `[[port_forward]]` is local -> overlay, not
  // an inbound publish. One entry per connection; a connection without a mapped
  // host has nothing to dial and is skipped rather than guessed.
  for (const connection of cfg.connections) {
    if (!connection.mappedHost) continue;
    lines.push("");
    lines.push("# consumer side: one loopback port per Remote Magpie");
    lines.push("[[port_forward]]");
    lines.push(`bind_addr = ${toml(`127.0.0.1:${connection.localPort}`)}`);
    lines.push(`dst_addr = ${toml(`${connection.mappedHost}:${GATEWAY_PORT}`)}`);
    lines.push('proto = "tcp"');
  }

  lines.push("");
  lines.push("[network_identity]");
  lines.push(`network_name = ${toml(network.name)}`);
  lines.push(`network_secret = ${toml(network.secret)}`);
  lines.push("");
  lines.push("[flags]");
  lines.push("no_tun = true");

  // Secure mode: the pair is this node's overlay identity, the network secret is
  // still what proves membership, and two peers negotiate their session key
  // themselves at connect time. Both keys are written because 2.6.4 refuses to
  // derive the public key (`local public key is not set`) although its --help
  // says it can.
  if (network.secureMode && secure) {
    lines.push("");
    lines.push("[secure_mode]");
    lines.push("enabled = true");
    lines.push(`local_private_key = ${toml(secure.privateKey)}`);
    lines.push(`local_public_key = ${toml(secure.publicKey)}`);
  }

  lines.push("");
  lines.push("[acl.acl_v1]");
  if (exported) {
    // Forward is the subnet-proxy path a consumer reaches: exactly the two
    // fixed ports. 3426 carries the directory, 3425 the Magpie gateway; sharing
    // another model never touches this file.
    lines.push("# Forward: the subnet-proxy path a consumer reaches; exactly the published ports.");
    lines.push("[[acl.acl_v1.chains]]");
    lines.push('name = "Forward"');
    lines.push("chain_type = 3");
    lines.push("enabled = true");
    lines.push("default_action = 2");
    for (const port of [CONTROL_PORT, GATEWAY_PORT]) {
      lines.push("[[acl.acl_v1.chains.rules]]");
      lines.push(`name = ${toml(`allow-${port}`)}`);
      lines.push("priority = 1000");
      lines.push("enabled = true");
      lines.push("protocol = 1");
      lines.push(`ports = [${toml(String(port))}]`);
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

/**
 * Verified EasyTier binaries. The cache is accepted only when the marker matches
 * the pinned archive hash; a first run downloads, checks SHA-256, and extracts.
 */
export async function ensureBinaries(log: (message: string) => void = logger.info): Promise<{ core: string; cli: string }> {
  const asset = assetFor();
  const dir = binariesDir();
  const core = join(dir, asset.core);
  const cli = join(dir, asset.cli);
  const marker = join(dir, ".sha256");

  if (existsSync(core) && existsSync(cli) && existsSync(marker)) {
    try {
      if (readFileSync(marker, "utf8").trim() === asset.sha256) return { core, cli };
    } catch {
      /* fall through and reinstall */
    }
    log(`cached EasyTier binaries at ${dir} do not match the pinned archive; reinstalling`);
  }

  const home = easytierHome();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const zip = join(home, asset.file);
  const url = assetUrl(asset);
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await hashBytes(bytes);
  if (digest !== asset.sha256) {
    throw new Error(
      `EasyTier ${EASYTIER_VERSION} ${asset.file}: SHA-256 mismatch ` +
        `(got ${digest}, expected ${asset.sha256}); refusing to run it`,
    );
  }
  writeFileSync(zip, bytes, { mode: 0o600 });

  const extractDir = join(home, ".extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  const extract =
    process.platform === "win32"
      ? await run(["tar", "-xf", zip, "-C", extractDir], { timeoutMs: 120_000 })
      : await run(["unzip", "-o", "-q", zip, "-d", extractDir], { timeoutMs: 120_000 });
  if (extract.code !== 0) {
    throw new Error(`extracting ${asset.file}: ${shortError(extract.stderr || extract.stdout)}`);
  }

  const inner = join(extractDir, asset.dir);
  const srcCore = join(inner, asset.core);
  const srcCli = join(inner, asset.cli);
  if (!existsSync(srcCore) || !existsSync(srcCli)) {
    throw new Error(`unexpected archive layout for ${asset.file}: ${asset.dir}/{${asset.core},${asset.cli}} missing`);
  }
  for (const [src, dst] of [
    [srcCore, core],
    [srcCli, cli],
  ] as const) {
    writeFileSync(dst, readFileSync(src), { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(dst, 0o755);
  }
  writeFileSync(marker, `${asset.sha256}\n`, { mode: 0o600 });
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(zip, { force: true });
  log(`EasyTier ${EASYTIER_VERSION} verified and installed in ${dir}`);
  return { core, cli };
}

async function drain(stream: ReadableStream<Uint8Array>, log: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    let index = rest.indexOf("\n");
    while (index >= 0) {
      const line = rest.slice(0, index).trim();
      rest = rest.slice(index + 1);
      if (line) log(line);
      index = rest.indexOf("\n");
    }
  }
  if (rest.trim()) log(rest.trim());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Overlay {
  private cfg: HubConfig;
  private readonly hooks: OverlayHooks;
  private state: OverlayState = "offline";
  private step = "offline";
  private detail: string | null = null;
  private overlayIp: string | null = null;
  private peers: OverlayPeer[] = [];
  private lanIp: string | null = null;
  private lanDetail: string | null = null;
  private bin: { core: string; cli: string } | null = null;
  /** Created on first need; the same pair is reused for the life of the node. */
  private secureKey: SecureKeyPair | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private desired = false;
  private generation = 0;
  private work: Promise<void> = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private restartTimes: number[] = [];
  private refreshing = false;
  private stopped: Promise<void> | null = null;

  constructor(cfg: HubConfig, hooks: OverlayHooks = {}) {
    this.cfg = cfg;
    this.hooks = hooks;
  }

  /** Updates the non-running view (e.g. a wallet change while offline). */
  configure(cfg: HubConfig): void {
    this.cfg = cfg;
  }

  /** The LAN address this core exports, or null when the probe found none. */
  lanAddress(): string | null {
    return this.lanIp;
  }

  status(): OverlayStatus {
    return {
      configured: this.cfg.network !== null,
      networkName: this.cfg.network?.name ?? null,
      secureMode: this.cfg.network?.secureMode ?? false,
      state: this.state,
      step: this.step,
      detail: this.detail,
      overlayIp: this.overlayIp,
      hostname: this.cfg.hostname,
      peers: this.peers.map((peer) => ({ ...peer })),
      publishedPorts: this.publishedPorts(),
    };
  }

  /** True when the generated TOML exports this node's LAN address. */
  private exportActive(): boolean {
    return Boolean(this.cfg.network && this.lanIp && this.cfg.publish.mappedCidr);
  }

  /**
   * 3426 carries the directory, 3425 the Magpie gateway. Both are
   * reachable only through an export, so a node without one publishes nothing.
   */
  publishedPorts(): number[] {
    return this.exportActive() ? [CONTROL_PORT, GATEWAY_PORT] : [];
  }

  /**
   * Replaces the configuration and starts (or restarts) the core in the
   * background. A newer call always wins; the previous start abandons itself at
   * its next checkpoint instead of spawning a second core.
   */
  beginStart(cfg: HubConfig): void {
    this.cfg = cfg;
    if (cfg.network?.secret) registerSecret(cfg.network.secret);
    // The LAN address is probed once per start; `join_network` starts again, and
    // that is the deliberate way to re-read it.
    this.probeLan();
    this.ensureMappedCidr();
    this.desired = true;
    const generation = ++this.generation;
    this.state = "starting";
    this.step = "queued";
    this.detail = null;
    this.overlayIp = null;
    this.peers = [];
    this.restartTimes = [];
    this.clearRestartTimer();
    this.work = this.work
      .then(() => this.startNow(generation))
      .catch((error) => {
        if (generation === this.generation) this.fail(error);
      });
  }

  /**
   * Waits up to `timeoutMs` for the core to answer. Returns "starting" when the
   * deadline passes but the work is still in flight; a terminal failure throws
   * E_NETWORK_TIMEOUT (the tool contract's code for a failed join).
   */
  async join(cfg: HubConfig, timeoutMs = 40_000): Promise<"online" | "starting"> {
    this.beginStart(cfg);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.stateOf();
      if (state === "online") return "online";
      if (state === "error") this.failFromState();
      if (Date.now() >= deadline) return this.stateOf() === "online" ? "online" : "starting";
      await this.refresh();
      const after = this.stateOf();
      if (after === "online") return "online";
      if (after === "error") this.failFromState();
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  }

  /** Widened read: `refresh()` mutates the state, which TS cannot see through. */
  private stateOf(): OverlayState {
    return this.state;
  }

  private failFromState(): never {
    throw new Error(`E_NETWORK_TIMEOUT: ${this.detail ?? "EasyTier did not come online"}`);
  }

  private fail(error: unknown): void {
    this.state = "error";
    this.step = "error";
    this.detail = shortError(error);
    logger.error(`EasyTier: ${this.detail}`);
  }

  private probeLan(): void {
    try {
      this.lanIp = detectLanIPv4();
      this.lanDetail = null;
    } catch (error) {
      this.lanIp = null;
      this.lanDetail = shortError(error);
      logger.warn(`LAN probe: ${this.lanDetail}`);
    }
  }

  /**
   * The export address is allocated once and persisted: a consumer's saved route
   * must keep pointing at this node across restarts. The write is delegated to
   * the runtime, which owns state.json.
   */
  private ensureMappedCidr(): void {
    if (!this.cfg.network || this.cfg.publish.mappedCidr) return;
    this.cfg.publish = { mappedCidr: randomMappedCidr() };
    try {
      this.hooks.onConfigChange?.(this.cfg);
    } catch (error) {
      logger.error(`cannot persist the mapped CIDR: ${shortError(error)}`);
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /**
   * The pair secure mode needs, generated on first use. Synchronous on purpose:
   * the generated TOML needs it in hand, and a missing pair must fail the start
   * instead of quietly writing a config EasyTier would reject.
   */
  private ensureSecureKey(): SecureKeyPair | null {
    if (!this.cfg.network?.secureMode) return null;
    if (!this.secureKey) this.secureKey = loadOrCreateSecureKeyPair();
    return this.secureKey;
  }

  /** Writes the generated TOML from the current config (never starts anything). */
  private writeConfigFile(secure: SecureKeyPair | null): void {
    const text = renderOverlayConfig(
      this.cfg,
      {
        lanIp: this.lanIp,
        mappedCidr: this.cfg.publish.mappedCidr,
      },
      secure,
    );
    const configPath = currentTomlPath();
    mkdirSync(join(statePath("easytier")), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, text, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(configPath, 0o600);
  }

  private async startNow(generation: number): Promise<void> {
    await this.stopProcess();
    if (generation !== this.generation || !this.desired) return;

    this.state = "starting";
    this.step = "download";
    this.detail = `verifying EasyTier ${EASYTIER_VERSION}`;
    this.bin = await ensureBinaries((message) => logger.info(message));
    if (generation !== this.generation || !this.desired) return;

    this.writeConfigFile(this.ensureSecureKey());

    this.step = "spawn";
    this.detail = "starting easytier-core";
    this.spawn(generation);
  }

  private spawn(generation: number): void {
    if (!this.bin) throw new Error("EasyTier binaries are not ready");
    const args = [this.bin.core, "-c", currentTomlPath(), "-r", `127.0.0.1:${RPC_PORT}`];
    const proc = Bun.spawn({
      cmd: args,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    this.proc = proc;
    this.state = "starting";
    this.step = "waiting";
    this.detail = `easytier-core pid ${proc.pid}`;
    logger.info(`started easytier-core pid ${proc.pid} (rpc 127.0.0.1:${RPC_PORT})`);

    void drain(proc.stdout, (line) => logger.debug(`easytier: ${line}`)).catch(() => {});
    void drain(proc.stderr, (line) => logger.warn(`easytier: ${line}`)).catch(() => {});
    void proc.exited.then((code) => this.onExit(generation, proc, code));
    this.startMonitor();
  }

  private onExit(generation: number, proc: ReturnType<typeof Bun.spawn>, code: number): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.overlayIp = null;
    this.peers = [];
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
    }
    if (generation !== this.generation || !this.desired) return;

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((time) => now - time < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.state = "error";
      this.step = "restart-limit";
      this.detail = `easytier-core exited (code ${code}); ${MAX_RESTARTS} restarts failed within 5 minutes`;
      logger.error(this.detail);
      return;
    }
    this.restartTimes.push(now);
    const delay = Math.min(1_000 * 2 ** (this.restartTimes.length - 1), 15_000);
    this.state = "starting";
    this.step = "restarting";
    this.detail = `easytier-core exited (code ${code}); restarting in ${Math.round(delay / 1000)}s`;
    logger.warn(this.detail);
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (generation !== this.generation || !this.desired) return;
      try {
        this.spawn(generation);
      } catch (error) {
        this.fail(error);
      }
    }, delay);
    this.restartTimer.unref?.();
  }

  private startMonitor(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = setInterval(() => void this.refresh(), MONITOR_MS);
    this.monitor.unref?.();
  }

  private async cli(args: string[], timeoutMs: number) {
    if (!this.bin) throw new Error("EasyTier binaries are not ready");
    if (!this.proc || this.proc.exitCode !== null) throw new Error("easytier-core is not running");
    return run([this.bin.cli, "-p", `127.0.0.1:${RPC_PORT}`, ...args], { timeoutMs });
  }

  /** Reads the running core once. Never throws; a failed read leaves the state as is. */
  async refresh(): Promise<void> {
    if (this.refreshing || !this.proc || this.proc.exitCode !== null) return;
    this.refreshing = true;
    try {
      const wasOnline = this.state === "online";
      const node = await this.cli(["-o", "json", "node"], 4_000);
      if (node.code !== 0) throw new Error(node.stderr || node.stdout || `exit ${node.code}`);
      const info = JSON.parse(node.stdout || "{}") as Record<string, unknown>;
      const rawIp = typeof info.ipv4_addr === "string" ? info.ipv4_addr : "";
      this.overlayIp = rawIp.split("/")[0] || null;
      const reportedHost = typeof info.hostname === "string" ? info.hostname : "";
      if (reportedHost && this.cfg.hostname && reportedHost !== this.cfg.hostname) {
        // A fixed loopback RPC port can already be held by another EasyTier. Do
        // not present that node's address or peers as ours.
        logger.warn(`EasyTier RPC portal answered for ${reportedHost}, configured ${this.cfg.hostname}`);
        throw new Error(`RPC portal answered for ${reportedHost}, not ${this.cfg.hostname}`);
      }
      this.state = "online";
      this.step = "online";
      this.detail = this.onlineDetail();
      if (!wasOnline) {
        try {
          this.hooks.onOnline?.();
        } catch (error) {
          logger.warn(`overlay online hook failed: ${shortError(error)}`);
        }
      }

      try {
        const list = await this.cli(["-o", "json", "peer", "list"], 4_000);
        if (list.code !== 0) throw new Error(list.stderr || list.stdout || `exit ${list.code}`);
        const rows = JSON.parse(list.stdout || "[]") as Record<string, unknown>[];
        const selfId = String(info.peer_id ?? "");
        this.peers = rows
          .filter((row) => String(row.cost ?? "") !== "Local" && String(row.id ?? "") !== selfId)
          .map((row) => ({
            hostname: String(row.hostname ?? ""),
            ipv4: String(row.ipv4 ?? ""),
            online: true,
          }));
      } catch (error) {
        this.detail = `${this.detail}; peers unavailable: ${shortError(error)}`;
      }
    } catch (error) {
      // The RPC portal answers only after the core has bound it. Until then a
      // failed read is "starting", not an error; once online it is only a
      // stale-read warning and the next tick retries.
      if (this.state === "online") this.detail = `refresh failed: ${shortError(error)}`;
    } finally {
      this.refreshing = false;
    }
  }

  private onlineDetail(): string {
    const parts = [this.overlayIp ? `overlay ${this.overlayIp}` : "core is running"];
    if (this.exportActive()) {
      parts.push(
        `exporting ${this.lanIp}/32 as ${this.cfg.publish.mappedCidr} (ports ${this.publishedPorts().join(", ")})`,
      );
    } else if (!this.lanIp) {
      parts.push(this.lanDetail ?? "no exportable LAN address (没有可导出的 LAN 地址)");
    }
    return parts.join("; ");
  }

  /**
   * The peers EasyTier currently routes to, with the mapped address each one
   * exports. Identity is not implied: an overlay address only says where to dial,
   * the signed directory says who answers.
   */
  async neighbors(): Promise<OverlayNeighbor[]> {
    if (!this.proc || this.proc.exitCode !== null) {
      throw new Error("E_PEER_OFFLINE: EasyTier is not running");
    }
    try {
      const [peerResult, routeResult] = await Promise.all([
        this.cli(["-o", "json", "peer", "list"], 6_000),
        this.cli(["-o", "json", "route"], 6_000),
      ]);
      if (peerResult.code !== 0) {
        throw new Error(`peer list failed: ${peerResult.stderr || peerResult.stdout || `exit ${peerResult.code}`}`);
      }
      if (routeResult.code !== 0) {
        throw new Error(`route list failed: ${routeResult.stderr || routeResult.stdout || `exit ${routeResult.code}`}`);
      }
      const peerRows = JSON.parse(peerResult.stdout || "[]") as Record<string, unknown>[];
      const routeRows = JSON.parse(routeResult.stdout || "[]") as Record<string, unknown>[];
      if (!Array.isArray(peerRows) || !Array.isArray(routeRows)) throw new Error("unexpected tables from easytier-cli");

      const routesByHost = new Map<string, string>();
      for (const row of routeRows) {
        const hostname = String(row.hostname ?? "");
        const proxy = String(row.proxy_cidrs ?? "");
        if (hostname && proxy) routesByHost.set(hostname, proxy);
      }

      const out: OverlayNeighbor[] = [];
      for (const row of peerRows) {
        const hostname = String(row.hostname ?? "");
        const ipv4 = String(row.ipv4 ?? "").replace(/\/\d+$/, "");
        if (String(row.cost ?? "") === "Local") continue;
        if (this.cfg.hostname && hostname === this.cfg.hostname) continue;
        if (!ipv4) continue;
        out.push({ hostname: hostname || ipv4, ipv4, mappedHost: mappedHostOf(routesByHost.get(hostname) ?? "") });
      }
      return out;
    } catch (error) {
      const message = shortError(error);
      if (/^E_[A-Z_]+:/.test(message)) throw error;
      throw new Error(`E_PEER_OFFLINE: ${message}`);
    }
  }

  /**
   * Opens the loopback listener towards a peer's gateway. The
   * command shape is copied from the old supervisor's `addPortForward`: adding
   * the same rule twice really creates two listeners in 2.6.4, so an identical
   * rule is left alone. Adding a forward never restarts the core.
   */
  async addForward(bindAddr: string, dstAddr: string): Promise<boolean> {
    assertLoopbackBind(bindAddr);
    if (!this.bin || !this.proc || this.proc.exitCode !== null) {
      throw new Error("E_PEER_OFFLINE: EasyTier is not running, so the forward cannot be added");
    }
    const listed = await this.cli(["-o", "json", "port-forward", "list"], 6_000);
    if (listed.code !== 0) {
      throw new Error(`E_NETWORK_TIMEOUT: port-forward list failed: ${shortError(listed.stderr || listed.stdout)}`);
    }
    let existing: { bindAddr: string; dstAddr: string }[] = [];
    try {
      const parsed = JSON.parse(listed.stdout || "{}") as { cfgs?: unknown };
      const rows = Array.isArray(parsed.cfgs) ? (parsed.cfgs as Record<string, unknown>[]) : [];
      existing = rows.map(decodeForward).filter((row) => row.bindAddr || row.dstAddr);
    } catch (error) {
      throw new Error(`E_NETWORK_TIMEOUT: cannot read the forward table: ${shortError(error)}`);
    }
    if (existing.some((row) => row.bindAddr === bindAddr && row.dstAddr === dstAddr)) return false;
    const clash = existing.find((row) => row.bindAddr === bindAddr);
    if (clash) {
      throw new Error(
        `E_INPUT: ${bindAddr} already forwards to ${clash.dstAddr}; run disconnect_provider first`,
      );
    }
    const added = await this.cli(["port-forward", "add", "tcp", bindAddr, dstAddr], 15_000);
    if (added.code !== 0) {
      throw new Error(`E_NETWORK_TIMEOUT: port-forward add failed: ${shortError(added.stderr || added.stdout)}`);
    }
    logger.info(`forward ${bindAddr} -> ${dstAddr} added`);
    return true;
  }

  /**
   * Applies a new configuration and, when a core is running, restarts it. This is
   * the only way to make a removed `[[port_forward]]` really disappear: EasyTier
   * 2.6.4's `port-forward remove` prints success and keeps the listener. Other
   * connections are interrupted for a few seconds; callers must say so.
   */
  async applyConfig(cfg: HubConfig): Promise<{ restarted: boolean }> {
    this.cfg = cfg;
    if (!this.desired || !this.proc || this.proc.exitCode !== null) return { restarted: false };
    const generation = ++this.generation;
    await this.stopProcess();
    if (generation !== this.generation || !this.desired) return { restarted: false };
    this.writeConfigFile(this.ensureSecureKey());
    this.spawn(generation);
    return { restarted: true };
  }

  /** Stops the core this instance started, if any. */
  async stop(): Promise<void> {
    this.desired = false;
    this.generation += 1;
    this.clearRestartTimer();
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
    }
    await this.stopProcess();
    this.state = "offline";
    this.step = "offline";
    this.detail = "stopped";
    this.overlayIp = null;
    this.peers = [];
  }

  private stopProcess(): Promise<void> {
    if (this.stopped) return this.stopped;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) {
      this.proc = null;
      return Promise.resolve();
    }
    this.proc = null;
    this.stopped = (async () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      await Promise.race([proc.exited.catch(() => 0), sleep(3_000)]);
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      this.stopped = null;
    })();
    return this.stopped;
  }

  /**
   * Synchronous stop for `process.on("exit")`. Sends SIGTERM and briefly waits,
   * then SIGKILL; only the child this instance spawned is signalled.
   */
  stopSync(): void {
    this.desired = false;
    this.generation += 1;
    this.clearRestartTimer();
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    Bun.sleepSync(1_500);
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
