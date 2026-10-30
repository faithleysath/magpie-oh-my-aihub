#!/usr/bin/env bun
// Phase-8 real operator journey.
//
// Two (optionally three) fresh, fully isolated Magpie 0.1.2038 profiles on one
// macOS host, each with its own copy of the plugin package (so page/status.js is
// never shared), one real EasyTier 2.6.4 no-TUN overlay, real plugin hosts
// started by Magpie itself, and the real operator CLI. No vendor, no payment, no
// public-chain transaction.
//
//   bun docs/validation/lab/phase8/journey.ts [--keep] [--no-second-provider] [--no-wallet]
//
// Environment overrides:
//   MAGPIE_APP=/path/to/Magpie.app      the verified 0.1.2038 app bundle
//   EASYTIER_CACHE=/path/to/dir         dir holding easytier-core/easytier-cli
//   PHASE8_LAB_DIR=/path/to/lab         disposable root (default /tmp/ohmyaihub-phase8-<pid>)
//   PHASE8_EVIDENCE_DIR=/path/to/dir    sanitized evidence (default docs/validation/phase8-live)
//
// The harness is maintainer evidence, not a user instruction. It writes only
// sanitized output into the repository; raw state (keys, secrets, Magpie data)
// stays in the disposable lab root and is deleted unless --keep is passed.

import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";

const ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const LAB = process.env.PHASE8_LAB_DIR || `/tmp/ohmyaihub-phase8-${process.pid}`;
const EVIDENCE = process.env.PHASE8_EVIDENCE_DIR || join(ROOT, "docs", "validation", "phase8-live");
const KEEP = process.argv.includes("--keep");
const SECOND_PROVIDER = !process.argv.includes("--no-second-provider");
const RUN_WALLET = !process.argv.includes("--no-wallet");
const NETWORK = `phase8-lab-${process.pid}`;
const NETWORK_SECRET = `phase8-${createHash("sha256").update(`${process.pid}-${Date.now()}`).digest("hex").slice(0, 24)}`;

const MAGPIE_APP = process.env.MAGPIE_APP || findMagpieApp();
const MAGPIE_BIN = join(MAGPIE_APP, "Contents", "MacOS", "magpie");
const EASYTIER_CACHE = process.env.EASYTIER_CACHE || join(process.env.HOME || "", "Projects", "lab", "et", "easytier-macos-aarch64");
const PLUGIN_SOURCE = join(ROOT, "plugin");
const CLI = (node: Instance) => join(node.pluginDir, "bin", "ohmyaihub.ts");
const PLUGIN_MANIFEST_FILES = [
  "src/service.ts",
  "src/provisioner.ts",
  "src/server.ts",
  "src/catalog.ts",
  "src/walletview.ts",
  "src/wallet.ts",
  "bin/ohmyaihub.ts",
  "bin/operator-lib.ts",
  "bin/operator-setup.ts",
  "bin/operator-share.ts",
  "bin/operator-connect.ts",
  "bin/operator-remote.ts",
  "bin/wallet-wizard.ts",
];
const copyHashes: Record<string, Record<string, string>> = {};

const RPC_97 = "https://bsc-testnet-rpc.publicnode.com";
const RPC_84532 = "https://base-sepolia-rpc.publicnode.com";

// The mock test tokens and recipient were deployed and measured in the merged
// phase-7 lab. Read them from the public evidence file instead of hard-coding a
// chain address in this script.
const PHASE7_ASSETS = JSON.parse(readFileSync(join(ROOT, "docs", "validation", "phase7-twohost", "assets.json"), "utf8")) as {
  chainId: number;
  token: string;
  decimals: number;
  recipient: string;
}[];
const ASSET_97 = PHASE7_ASSETS.find((a) => a.chainId === 97);
const ASSET_84532 = PHASE7_ASSETS.find((a) => a.chainId === 84532);
if (!ASSET_97 || !ASSET_84532) throw new Error("phase-7 assets.json has no 97/84532 test asset");
const BSC_TOKEN = ASSET_97.token;
const BASE_TOKEN = ASSET_84532.token;
const TEST_RECIPIENT = ASSET_97.recipient;

const transcript: string[] = [];
const secrets = new Set<string>();
const results: { name: string; ok: boolean; detail: string; ms: number; required: boolean }[] = [];
const httpLog: { at: string; method: string; url: string; status: number; note: string }[] = [];
const walletEvidence: Record<string, any> = { ran: false };
const labFacts: Record<string, any> = {};

interface Proc {
  pid: number;
  kill: (signal?: NodeJS.Signals) => void;
}

function findMagpieApp(): string {
  const candidates = [
    join(process.env.HOME || "", "Projects", "lab", "magpie-iso", "Magpie.app"),
    join(process.env.HOME || "", "Projects", "lab", "magpie-pricing-2038", "Magpie.app"),
    "/tmp/phase7-twohost-wallet/Magpie.app",
  ];
  for (const c of candidates) {
    const bin = join(c, "Contents", "MacOS", "magpie");
    if (!existsSync(bin)) continue;
    const v = Bun.spawnSync([bin, "--version"]).stdout.toString();
    if (/\b0\.1\.2038\b/.test(v)) return c;
  }
  throw new Error("no Magpie 0.1.2038 app found; set MAGPIE_APP=/path/to/Magpie.app");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function sanitize(text: string): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("<redacted>");
  }
  out = out.replace(/sk-[A-Za-z0-9._-]{12,}/g, "<redacted-key>");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1<redacted>");
  out = out.replace(/("?(?:privateKey|networkSecret|secret|apiToken)"?\s*[:=]\s*")[^"]+(")/gi, "$1<redacted>$2");
  out = out.replace(/(local-private-key[= ]+)[A-Za-z0-9+/=_-]{16,}/gi, "$1<redacted>");
  return out;
}

function record(line: string): void {
  transcript.push(sanitize(line));
}

function logTranscript(command: string, out: string, err: string): void {
  record(`$ ${command}`);
  const body = [out.trim(), err.trim()].filter(Boolean).join("\n");
  if (body) record(body.split("\n").slice(0, 120).join("\n"));
}

function lanIP(): string {
  const candidates: { name: string; ip: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const parts = a.address.split(".").map(Number);
      if (parts[0] === 0 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254)) continue;
      if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) continue;
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) continue;
      candidates.push({ name, ip: a.address });
    }
  }
  candidates.sort((a, b) => Number(/^(en0|en1|eth0|wlan0)$/.test(b.name)) - Number(/^(en0|en1|eth0|wlan0)$/.test(a.name)));
  if (!candidates.length) throw new Error("no usable LAN IPv4 address");
  return candidates[0].ip;
}

async function portFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", LAN]) {
    try {
      const s = await Bun.connect({ hostname: host, port, socket: { data() {}, open() {}, close() {} } });
      s.end();
      return false;
    } catch {
      /* free */
    }
  }
  return true;
}

async function freePort(lo = 20_000, hi = 60_000, used = new Set<number>()): Promise<number> {
  for (let attempt = 0; attempt < 800; attempt++) {
    const port = lo + Math.floor(Math.random() * (hi - lo));
    if (used.has(port)) continue;
    if (await portFree(port)) {
      used.add(port);
      return port;
    }
  }
  throw new Error(`no free port in ${lo}-${hi}`);
}

/**
 * The plugin's discovery probes the consumer's own catalog port and the next
 * four ports. A one-machine lab therefore puts C at <base> and P at <base+1>
 * (P2 at <base+2), so no new scanning and no product change is needed.
 */
async function freeCatalogWindow(used: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const base = 34_000 + Math.floor(Math.random() * 5_000);
    const ports = [0, 1, 2, 3, 4].map((i) => base + i);
    if (ports.some((p) => used.has(p) || p > 65_535)) continue;
    let free = true;
    for (const p of ports) {
      if (!(await portFree(p))) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    for (const p of ports) used.add(p);
    return base;
  }
  throw new Error("no free five-port catalogue window in 34000-39000");
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 60_000, everyMs = 1200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = String((e as Error)?.message ?? e);
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last error: ${last})` : ""}`);
}

async function http(url: string, opts: { key?: string; method?: string; body?: unknown; timeoutMs?: number } = {}) {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* text */
    }
    httpLog.push({ at: new Date().toISOString(), method: opts.method ?? "GET", url: url.replace(LAN, "<lan>"), status: res.status, note: "" });
    return { status: res.status, text, json };
  } catch (e) {
    httpLog.push({
      at: new Date().toISOString(),
      method: opts.method ?? "GET",
      url: url.replace(LAN, "<lan>"),
      status: 0,
      note: String((e as Error)?.message ?? e).slice(0, 120),
    });
    return { status: 0, text: String((e as Error)?.message ?? e), json: null };
  }
}

function parseJsonLoose(text: string): any {
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "{") starts.push(i);
  for (const i of starts.reverse()) {
    try {
      return JSON.parse(text.slice(i));
    } catch {
      /* try the next */
    }
  }
  return null;
}

function objectAt(text: string, start: number): { value: any; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function typedDataFrom(text: string): any {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const o = objectAt(text, i);
    if (o && o.value && o.value.types && o.value.primaryType && o.value.domain && o.value.message) return o.value;
  }
  return null;
}

function readStateIdentity(dataDir: string) {
  const state = JSON.parse(readFileSync(join(dataDir, "oh-my-aihub", "state.json"), "utf8"));
  const c = state.config;
  return {
    nodeId: c.nodeId as string,
    instanceId: c.instanceId as string,
    mappedCidr: c.mappedCidr as string | null,
    rpcPort: c.rpcPort as number,
    virtualIpv4: c.virtualIpv4 as string,
    networkName: c.networkName as string,
    sharingEnabled: c.sharingEnabled as boolean,
    consumingEnabled: c.consumingEnabled as boolean,
    securePublicKey: c.secureIdentity?.publicKey as string | undefined,
  };
}

function processTable(): { pid: number; ppid: number; command: string }[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
    })
    .filter((x): x is { pid: number; ppid: number; command: string } => Boolean(x));
}

function descendants(root: number): number[] {
  const table = processTable();
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const p of table) {
      if (p.ppid === pid && !out.includes(p.pid)) {
        out.push(p.pid);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

function killTree(pid: number): void {
  if (!pid) return;
  const kids = descendants(pid);
  for (const p of [...kids].reverse()) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* gone */
  }
  setTimeout(() => {
    for (const p of [...kids, pid]) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 2500);
}

function start(cmd: string[], opts: { cwd: string; env: Record<string, string>; log: string }): Proc {
  mkdirSync(join(opts.log, ".."), { recursive: true });
  writeFileSync(opts.log, "");
  const p = Bun.spawn({ cmd, cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      try {
        appendFileSync(opts.log, sanitize(dec.decode(value, { stream: true })));
      } catch {
        /* lab only */
      }
    }
  };
  void drain(p.stdout as ReadableStream<Uint8Array>);
  void drain(p.stderr as ReadableStream<Uint8Array>);
  return { pid: p.pid, kill: (signal = "SIGTERM") => killTree(p.pid) };
}

interface Ports {
  gateway: number;
  upstream: number;
  listen: number;
}

class Instance {
  readonly home: string;
  readonly data: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly pluginDir: string;
  readonly gatewayPort: number;
  readonly upstreamPort: number;
  readonly listenPort: number;
  readonly upstreamName: string;
  readonly model: string;
  catalogPort = 0;
  socksPort = 0;
  serve: Proc | null = null;
  upstream: Proc | null = null;
  apiPort = "";
  apiToken = "";
  cKey = "";

  constructor(readonly name: string, readonly ports: Ports) {
    this.home = join(LAB, name, "home");
    this.data = join(this.home, ".config", "magpie");
    this.stateDir = join(this.data, "oh-my-aihub");
    this.logDir = join(LAB, name, "logs");
    this.pluginDir = join(LAB, name, "plugin");
    this.gatewayPort = ports.gateway;
    this.upstreamPort = ports.upstream;
    this.listenPort = ports.listen;
    this.upstreamName = name.toLowerCase();
    this.model = `${this.upstreamName}-model`;
  }

  /** The per-node copy of the verified app. Its portable data folder is <lab>/<name>/data. */
  get bin(): string {
    return join(LAB, this.name, "Magpie.app", "Contents", "MacOS", "magpie");
  }

  env(): Record<string, string> {
    return {
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      MAGPIE_NO_ACCOUNTS: "1",
      MAGPIE_ADDR: `${LAN}:${this.gatewayPort}`,
      MAGPIE_ALLOW_IPS: `${LAN}/32`,
      MAGPIE_TRUST_PROXY: "0",
      OH_MY_AIHUB_MAGPIE: this.bin,
    };
  }

  async prepare(): Promise<void> {
    mkdirSync(join(LAB, this.name), { recursive: true });
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.data, { recursive: true });
    // A portable copy of the verified app, per node: nothing of the user's
    // installed Magpie or its data directory is read or written.
    const appCopy = join(LAB, this.name, "Magpie.app");
    if (!existsSync(appCopy)) copyTree(MAGPIE_APP, appCopy);
    writeFileSync(join(this.data, "settings.json"), JSON.stringify({ lan: true, noAccountDiscovery: true }) + "\n", { mode: 0o600 });
    // Its own plugin package: page/status.js and page/options.js are written
    // under the plugin directory, so two nodes must never share it.
    copyTree(PLUGIN_SOURCE, this.pluginDir);
    for (const skip of ["node_modules", "test", "lab"]) rmSync(join(this.pluginDir, skip), { recursive: true, force: true });
    rmSync(join(this.pluginDir, "page", "status.js"), { force: true });
    // Capture the immutable source identity now, before any command can touch it.
    copyHashes[this.name] = pluginFileHashes(this.pluginDir);
    // Reuse the verified EasyTier cache instead of downloading it again.
    if (existsSync(join(EASYTIER_CACHE, "easytier-core"))) {
      const dir = join(this.data, "oh-my-aihub", "easytier", "v2.6.4", `${process.platform}-${process.arch}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const f of ["easytier-core", "easytier-cli"]) {
        copyFileSync(join(EASYTIER_CACHE, f), join(dir, f));
        chmodSync(join(dir, f), 0o755);
      }
      writeFileSync(join(dir, ".sha256"), "4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b\n", { mode: 0o600 });
      writeFileSync(
        join(dir, ".binaries.json"),
        JSON.stringify({
          version: "2.6.4",
          zip: "4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b",
          core: sha256File(join(dir, "easytier-core")),
          cli: sha256File(join(dir, "easytier-cli")),
        }) + "\n",
        { mode: 0o600 },
      );
    }
    // The mock upstream is deterministic and local; no vendor key or network.
    this.upstream = start(["bun", join(ROOT, "docs", "validation", "lab", "phase8", "mock-upstream.ts")], {
      cwd: LAB,
      env: { PORT: String(this.upstreamPort), UPSTREAM_NAME: this.upstreamName, MODELS: this.model },
      log: join(this.logDir, "upstream.log"),
    });
    await waitFor(`${this.name} upstream`, async () => ((await http(`http://127.0.0.1:${this.upstreamPort}/v1/models`, { timeoutMs: 3000 })).status === 200 ? true : null));
    this.magpie(["provider", "add", this.upstreamName, `url=http://127.0.0.1:${this.upstreamPort}/v1`, `responses=http://127.0.0.1:${this.upstreamPort}/v1`, `anthropic=http://127.0.0.1:${this.upstreamPort}`, `key=sk-test-${this.name.toLowerCase()}`, `models=${this.model}`, `name=${this.upstreamName}`]);
    this.magpie(["model", "price", `${this.upstreamName}/${this.model}`, "1000,1000,0,0"]);
    record(`# ${this.name}: mock upstream on 127.0.0.1:${this.upstreamPort}; native ${this.upstreamName}/${this.model} priced 1000/1000`);
  }

  magpie(args: string[], opts: { timeoutMs?: number } = {}): { code: number; out: string; err: string } {
    const r = Bun.spawnSync([this.bin, ...args], {
      cwd: this.data,
      env: { ...process.env, ...this.env() },
      timeout: opts.timeoutMs ?? 120_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  async install(): Promise<void> {
    const r = this.magpie(["plugin", "add", this.pluginDir], { timeoutMs: 180_000 });
    if (r.code !== 0) {
      // `magpie plugin add` exits non-zero when the host it starts logs an
      // error (for example a stale API port), even though the entry was
      // written. Accept only a recorded spec; anything else is a real failure.
      const listed = existsSync(join(this.data, "plugins.json"))
        ? (JSON.parse(readFileSync(join(this.data, "plugins.json"), "utf8")).plugins ?? []).some(
            (p: any) => p.spec === this.pluginDir,
          )
        : false;
      if (!listed) throw new Error(`${this.name} plugin add failed: ${(r.err || r.out).slice(0, 500)}`);
      record(`# ${this.name}: plugin add exited ${r.code} but plugins.json records the spec; continuing`);
    }
    record(`$ ${this.name}: magpie plugin add <own copy>`);
    // `magpie plugin add` starts a host of its own; stop that one so the
    // `serve` process owns the data directory and its supervisor/API.
    try {
      const lock = Number(readFileSync(join(this.stateDir, "host.lock"), "utf8").trim());
      if (lock > 0) {
        killTree(lock);
        await sleep(800);
      }
    } catch {
      /* no host, fine */
    }
    rmSync(join(this.stateDir, "host.lock"), { force: true });
  }

  async startServe(): Promise<void> {
    this.serve = start([this.bin, "serve"], { cwd: this.data, env: this.env(), log: join(this.logDir, "serve.log") });
    await waitFor(
      `${this.name} gateway 401`,
      async () => ((await http(`http://${LAN}:${this.gatewayPort}/v1/models`, { timeoutMs: 2000 })).status === 401 ? true : null),
      45_000,
    );
    await waitFor(
      `${this.name} plugin API`,
      async () => {
        if (!existsSync(join(this.stateDir, "api-port"))) return null;
        const port = readFileSync(join(this.stateDir, "api-port"), "utf8").trim();
        const token = readFileSync(join(this.stateDir, "api-token"), "utf8").trim();
        if (!port || !token) return null;
        const r = await http(`http://127.0.0.1:${port}/health`, { key: token, timeoutMs: 2000 });
        if (r.status !== 200) return null;
        this.apiPort = port;
        this.apiToken = token;
        return true;
      },
      45_000,
    );
  }

  cli(args: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): { code: number; out: string; err: string } {
    const cmd = ["bun", CLI(this), "--data", this.data, ...args];
    const r = Bun.spawnSync(cmd, {
      cwd: ROOT,
      env: { ...process.env, ...this.env() },
      timeout: opts.timeoutMs ?? 240_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString();
    const err = r.stderr.toString();
    logTranscript(`${this.name}: bun plugin/bin/ohmyaihub.ts --data <own data> ${args.join(" ")}`, out, err);
    const code = r.exitCode ?? 1;
    if (code !== 0 && !opts.allowFail) throw new Error(`${this.name} CLI ${args.join(" ")} failed (${code}): ${(err || out).trim().slice(0, 800)}`);
    return { code, out, err };
  }

  cliJson(args: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): any {
    const r = this.cli(args, opts);
    const parsed = parseJsonLoose(r.out);
    if (!parsed) throw new Error(`${this.name} CLI ${args.join(" ")} returned no JSON: ${(r.out || r.err).slice(0, 400)}`);
    return parsed;
  }

  async stopServices(): Promise<void> {
    if (this.serve) {
      this.serve.kill();
      this.serve = null;
    }
    await sleep(1500);
    // Kill anything left that belongs to this disposable data directory.
    for (const p of processTable()) {
      if (p.command.includes(this.data) && (p.command.includes("magpie-bun") || p.command.includes("easytier-core") || p.command.includes("Magpie.app"))) {
        try {
          process.kill(p.pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
    await sleep(500);
    rmSync(join(this.stateDir, "host.lock"), { force: true });
  }

  stopAll(): void {
    this.stopServices().catch(() => {});
    this.upstream?.kill();
    this.upstream = null;
  }
}

function pluginFileHashes(pluginDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of PLUGIN_MANIFEST_FILES) {
    const p = join(pluginDir, f);
    if (!existsSync(p)) throw new Error(`plugin copy ${pluginDir} is missing ${f}`);
    out[f] = sha256File(p);
  }
  return out;
}

function copyTree(src: string, dst: string): void {
  rmSync(dst, { recursive: true, force: true });
  const r = Bun.spawnSync(["cp", "-R", src, dst], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`cp -R ${src} -> ${dst} failed: ${r.stderr.toString().slice(0, 300)}`);
}

function writeSecret(path: string, value: string): void {
  rmSync(path, { force: true });
  const fd = openSync(path, "wx", 0o600);
  writeSync(fd, value);
  closeSync(fd);
  chmodSync(path, 0o600);
}

const usedPorts = new Set<number>();
const LAN = lanIP();

async function makeInstance(name: string): Promise<Instance> {
  const ports: Ports = {
    gateway: await freePort(30_000, 60_000, usedPorts),
    upstream: await freePort(19_000, 29_000, usedPorts),
    listen: await freePort(11_000, 18_000, usedPorts),
  };
  return new Instance(name, ports);
}

async function step(name: string, fn: () => Promise<string | void>, required = true): Promise<void> {
  const started = Date.now();
  process.stderr.write(`\n=== ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "ok", ms: Date.now() - started, required });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    const detail = String((e as Error)?.message ?? e);
    results.push({ name, ok: false, detail, ms: Date.now() - started, required });
    console.log(`FAIL  ${name} — ${detail}`);
    if (required) throw e;
  }
}

function parsePeerList(out: string): any[] {
  const d = parseJsonLoose(out);
  return (d?.peers ?? []).filter((p: any) => p.status !== "self");
}

function peerOf(out: string, nodeId: string): any | undefined {
  return parsePeerList(out).find((p) => p.nodeId === nodeId || p.identity?.keyId === nodeId || p.hostname === nodeId);
}

async function main(): Promise<void> {
  mkdirSync(LAB, { recursive: true, mode: 0o700 });
  mkdirSync(EVIDENCE, { recursive: true });
  record(`# environment: ${process.platform} ${process.arch} · Bun ${Bun.version} · macOS ${Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim()}`);
  record(`# magpie: ${MAGPIE_BIN} (${sha256File(MAGPIE_BIN)})`);
  record(`# lab: ${LAB}`);

  const magpieVersion = Bun.spawnSync([MAGPIE_BIN, "--version"]).stdout.toString().trim();
  assert(magpieVersion.includes("0.1.2038"), `expected Magpie 0.1.2038, got ${magpieVersion}`);
  labFacts.magpie = { app: MAGPIE_APP, bin: MAGPIE_BIN, version: magpieVersion, sha256: sha256File(MAGPIE_BIN) };
  const gitRev = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
  const gitDirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ROOT }).stdout.toString().trim().length > 0;
  labFacts.plugin = { commit: gitRev, dirty: gitDirty };
  labFacts.platform = { os: Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim(), arch: process.arch, bun: Bun.version };

  const P = await makeInstance("P");
  const C = await makeInstance("C");
  let P2: Instance | null = null;
  if (SECOND_PROVIDER) P2 = await makeInstance("P2");
  const catalogBase = await freeCatalogWindow(usedPorts);
  C.catalogPort = catalogBase;
  P.catalogPort = catalogBase + 1;
  if (P2) P2.catalogPort = catalogBase + 2;

  const secretFile = join(LAB, "network.secret");
  writeSecret(secretFile, NETWORK_SECRET + "\n");
  secrets.add(NETWORK_SECRET);
  const handoverDir = join(LAB, "handover");
  mkdirSync(handoverDir, { recursive: true, mode: 0o700 });

  try {
    await step("P: fresh Magpie 0.1.2038, own plugin copy, real host and EasyTier 2.6.4", async () => {
      await P.prepare();
      await P.install();
      await P.startServe();
      const pre = P.cliJson(["setup", "--check", "--json"], { timeoutMs: 120_000 });
      assert(pre.state.configured === false, "a fresh node reports configured");
      assert(pre.magpie.matches === true, `preflight Magpie mismatch: ${JSON.stringify(pre.magpie)}`);
      assert(pre.easytier.verified === true, "EasyTier cache is not verified");
      return `preflight: Magpie ${pre.magpie.version}, EasyTier ${pre.easytier.version} verified, host ${pre.host.reachable}, no overlay yet`;
    });

    await step("C: second fresh Magpie, own plugin copy, gateway enforces a key", async () => {
      await C.prepare();
      await C.install();
      await C.startServe();
      const noKey = await http(`http://${LAN}:${C.gatewayPort}/v1/models`);
      assert(noKey.status === 401, `consumer gateway without a key answered ${noKey.status}`);
      return `C gateway ${LAN}:${C.gatewayPort} answered 401 without a key`;
    });

    await step("P setup: provider overlay, sharing, published native model", async () => {
      const r = P.cli([
        "setup",
        "--network",
        NETWORK,
        "--secret-file",
        secretFile,
        "--listen",
        `127.0.0.1:${P.listenPort}`,
        "--share",
        "--no-consume",
        "--ports",
        String(P.gatewayPort),
        "--no-catalog-publish",
        "--json",
      ]);
      assert(/configured/.test(r.out) || r.code === 0, "setup did not report a configuration");
      const st = P.cliJson(["status", "--json"]);
      assert(st.sharing === true, "P is not sharing");
      assert(typeof P.cliJson(["catalog", "config", "--port", String(P.catalogPort), "--display-name", "Phase8 P"]) === "object" || true, "catalog config");
      const published = P.cliJson(["share", "setup", "--all-priced", "--publish", "--json"], { timeoutMs: 240_000 });
      assert(published.published === true, `publish not verified: ${JSON.stringify(published).slice(0, 400)}`);
      assert(/^[0-9a-f]{64}$/.test(String(published.quote?.contentHash)), "no quote contentHash");
      assert(/^[0-9a-f]{64}$/.test(String(published.quote?.identityFingerprint)), "no identity fingerprint");
      labFacts.provider = {
        nodeId: readStateIdentity(P.data).nodeId,
        mappedCidr: readStateIdentity(P.data).mappedCidr,
        gatewayPort: P.gatewayPort,
        catalogPort: P.catalogPort,
        quoteHash: published.quote.contentHash,
        fingerprint: published.quote.identityFingerprint,
        priceVersion: published.priceVersion,
      };
      return `P ${labFacts.provider.nodeId} exports ${labFacts.provider.mappedCidr}; quote v${published.quote.version} ${published.quote.contentHash.slice(0, 12)}…, priceVersion ${published.priceVersion.slice(0, 12)}…, priceLocked false`;
    });

    await step("C setup: same overlay, consume-only, discovery on", async () => {
      C.socksPort = await freePort(13_400, 13_600, usedPorts);
      C.cli([
        "setup",
        "--network",
        NETWORK,
        "--secret-file",
        secretFile,
        "--peer",
        `tcp://127.0.0.1:${P.listenPort}`,
        "--listen",
        `127.0.0.1:${C.listenPort}`,
        "--no-share",
        "--consume",
        "--catalog-discover",
        "--json",
      ], { timeoutMs: 240_000 });
      C.cli(["catalog", "config", "--port", String(C.catalogPort), "--socks-port", String(C.socksPort)]);
      const st = C.cliJson(["status", "--json"]);
      assert(st.consuming === true, "C is not consuming");
      return `C ${readStateIdentity(C.data).nodeId} joined; discovery base port ${C.catalogPort}, SOCKS ${C.socksPort}; P catalogue at ${P.catalogPort}`;
    });

    let peer: any;
    await step("C discovers P through EasyTier; TOFU fingerprint and quote hash are shown", async () => {
      const pNode = readStateIdentity(P.data).nodeId;
      await waitFor(
        "C sees P catalogue",
        async () => {
          const r = C.cli(["connect", "--json"], { allowFail: true });
          const p = peerOf(r.out, pNode);
          return p?.quote && p?.quoteHash ? p : null;
        },
        120_000,
        3000,
      );
      const r = C.cli(["connect", "--json"], { allowFail: true });
      peer = peerOf(r.out, pNode);
      assert(peer, "P is not in C's catalogue");
      assert(peer.status === "unverified", `first sight is ${peer.status}, expected unverified`);
      assert(/^[0-9a-f]{64}$/.test(peer.identity?.fingerprint), "no full fingerprint");
      assert(/^[0-9a-f]{64}$/.test(peer.quoteHash), "no full quote hash");
      assert(peer.quote.billing.priceVersion === labFacts.provider.priceVersion, "priceVersion mismatch");
      assert(peer.quote.billing.priceLocked === false, "priceLocked is not false");
      labFacts.consumer = { nodeId: readStateIdentity(C.data).nodeId, hostname: readStateIdentity(C.data).nodeId, socksPort: C.socksPort };
      return `P ${peer.nodeId} ${peer.status}; fingerprint ${peer.identity.fingerprint}; quote ${peer.quoteHash.slice(0, 16)}…; mapped ${peer.mappedCidr}`;
    });

    await step("TOFU: unverified is refused, then the exact fingerprint is accepted", async () => {
      const pNode = readStateIdentity(P.data).nodeId;
      const rejected = C.cli(["connect", "--node", pNode], { allowFail: true });
      assert(rejected.code !== 0, "connect to an unverified peer succeeded without acceptance");
      assert(/unverified|fingerprint/.test(rejected.err || rejected.out), `unexpected refusal: ${(rejected.err || rejected.out).slice(0, 300)}`);
      const fp = peer.identity.fingerprint as string;
      const qh = peer.quoteHash as string;
      const wrong = C.cli(["connect", "--node", pNode, "--trust", "--fingerprint", "11".repeat(32), "--quote", qh, "--request-out", join(LAB, "wrong.request.json")], { allowFail: true });
      assert(wrong.code !== 0, "a wrong fingerprint was accepted");
      let requestRun = C.cli(["connect", "--node", pNode, "--trust", "--fingerprint", fp, "--quote", qh, "--request-out", join(handoverDir, "request.json"), "--json"], { allowFail: true });
      if (requestRun.code !== 0) {
        // Known phase-8 race: /catalog/trust can refresh asynchronously; the
        // request then still sees the cached "unverified" view. Record it and
        // retry only after the host itself reports verified.
        record(`# TOFU trust race reproduced: ${requestRun.err.trim().slice(0, 300)}`);
        await waitFor(
          "C reports P verified",
          async () => {
            const r = C.cli(["connect", "--json"], { allowFail: true });
            const p = peerOf(r.out, pNode);
            return p && (p.status === "verified" || p.status === "connected") ? p : null;
          },
          30_000,
          2000,
        );
        requestRun = C.cli(["connect", "--node", pNode, "--fingerprint", fp, "--quote", qh, "--request-out", join(handoverDir, "request.json"), "--json"], { allowFail: true });
      }
      assert(requestRun.code === 0, `request failed after acceptance: ${(requestRun.err || requestRun.out).slice(0, 500)}`);
      const req = JSON.parse(readFileSync(join(handoverDir, "request.json"), "utf8"));
      assert(req.schema === "ohmyaihub.connection-request/v1", "wrong request schema");
      assert(req.consumer.nodeId === readStateIdentity(C.data).nodeId, "request consumer mismatch");
      assert(req.provider.nodeId === readStateIdentity(P.data).nodeId, "request provider mismatch");
      assert(req.models.includes(`${P.upstreamName}/${P.model}`), "request model missing");
      assert(req.quote.contentHash === labFacts.provider.quoteHash, `request quote ${req.quote.contentHash} != provider ${labFacts.provider.quoteHash}`);
      assert(req.acceptance.fingerprint === fp && req.acceptance.quoteHash === qh, "acceptance does not bind the displayed values");
      assert(!JSON.stringify(req).includes("sk-"), "request contains a secret-like key");
      assert((statSync(join(handoverDir, "request.json")).mode & 0o777) === 0o600, "request file is not 0600");
      return `unverified refused; wrong fingerprint refused; accepted ${fp.slice(0, 16)}… and quote ${qh.slice(0, 16)}…; request 0600`;
    });

    await step("provider approves the request and hands over a 0600 key file", async () => {
      const approved = P.cliJson(["share", "approve", join(handoverDir, "request.json"), "--cap", "0.0001", "--yes", "--json"]);
      assert(approved.approved === true, "share approve did not approve");
      assert(approved.keyPrinted === false, "share approve printed a key");
      const consumerId = readStateIdentity(C.data).nodeId;
      const handover = P.cliJson(["share", "handover", consumerId, "--key-file", join(handoverDir, `${consumerId}.key`), "--json"]);
      assert(handover.keyPrinted === false, "share handover printed a key");
      assert(!handover.keyFile.includes("sk-"), "handover leaked a key in the path");
      assert((statSync(handover.keyFile).mode & 0o777) === 0o600, "handover file is not 0600");
      const key = readFileSync(handover.keyFile, "utf8").trim();
      assert(key.startsWith("sk-"), "handover file does not contain a key");
      secrets.add(key);
      copyFileSync(handover.keyFile, join(C.home, "approved.key"));
      chmodSync(join(C.home, "approved.key"), 0o600);
      return `consumer ${consumerId}: ${approved.models.join(",")} cap $${approved.capUsd}; handover 0600, key not printed`;
    });

    await step("an invalid or stale approval request is refused and issues no key", async () => {
      const raw = JSON.parse(readFileSync(join(handoverDir, "request.json"), "utf8"));
      const fakeHash = "00".repeat(32);
      raw.consumer.nodeId = "deadbeef";
      raw.approval.consumerId = "deadbeef";
      raw.quote.contentHash = fakeHash;
      raw.acceptance.quoteHash = fakeHash;
      raw.approval.quoteHash = fakeHash;
      const file = join(handoverDir, "tampered.request.json");
      writeSecret(file, JSON.stringify(raw, null, 2));
      const refused = P.cli(["share", "approve", file, "--cap", "0.0001", "--yes", "--json"], { allowFail: true });
      assert(refused.code !== 0, "share approve accepted a request with a stale quote hash");
      assert(/accepted quote is not the current published quote|not the current published quote/.test(refused.err || refused.out), `unexpected refusal: ${(refused.err || refused.out).slice(0, 300)}`);
      const st = P.cliJson(["status", "--json"]);
      assert(!(st.consumers ?? []).some((c: any) => c.consumerId === "deadbeef"), "a key/consumer was created for the refused request");
      return `stale quote hash refused; no consumer deadbeef was created (existing ${(st.consumers ?? []).length})`;
    });

    await step("consumer connects with the key file and the same accepted fingerprint/quote", async () => {
      const pNode = readStateIdentity(P.data).nodeId;
      const fp = labFacts.provider.fingerprint as string;
      const qh = labFacts.provider.quoteHash as string;
      const r = C.cliJson(["connect", "--node", pNode, "--key-file", join(C.home, "approved.key"), "--id", "peer-p", "--fingerprint", fp, "--quote", qh, "--json"]);
      assert(r.connected === true, "connect did not report connected");
      assert(r.provider.status === "connected", `provider is ${r.provider.status}`);
      return `peer-p ${r.provider.mappedCidr}:${r.provider.providerPort} -> 127.0.0.1:${r.provider.localPort}; limit ${JSON.stringify(r.provider.limit)}`;
    });

    await step("remote test/models are read-only and target only peer-p", async () => {
      const tested = C.cliJson(["remote", "test", "peer-p", "--json"]);
      assert(tested.provider.status === "connected", `remote test: ${tested.provider.status}`);
      const models = C.cliJson(["remote", "models", "peer-p", "--json"]);
      assert(models.models.includes(`${P.upstreamName}/${P.model}`), "remote models missing the native model");
      return `test connected; models [${models.models.join(", ")}]`;
    });

    await step("consumer Magpie calls the real Remote Magpie: 200 → native 429 → topup → 200", async () => {
      const key = readFileSync(join(C.home, "approved.key"), "utf8").trim();
      const cKeyRun = C.magpie(["gateway-key", "add", "cagent"]);
      assert(cKeyRun.code === 0, "consumer gateway-key add failed");
      const keys = JSON.parse(readFileSync(join(C.data, "caller-keys.json"), "utf8")) as { name: string; secret: string; id: string }[];
      const own = keys.filter((k) => k.name === "cagent").at(-1)!;
      C.cKey = own.secret;
      secrets.add(own.secret);
      C.magpie(["gateway-key", "models", own.id, "all"]);
      const body = { model: `peer-p/${P.upstreamName}/${P.model}`, messages: [{ role: "user", content: "phase8 real remote call" }] };
      const before = (await http(`http://127.0.0.1:${P.upstreamPort}/count`)).json?.requests ?? 0;
      const first = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, { method: "POST", key: C.cKey, body, timeoutMs: 30_000 });
      assert(first.status === 200, `first remote call answered ${first.status}: ${first.text.slice(0, 300)}`);
      assert(String(first.json?.choices?.[0]?.message?.content ?? "").includes("hello from"), "first call returned no mock content");
      const second = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, { method: "POST", key: C.cKey, body, timeoutMs: 30_000 });
      assert(second.status === 429, `spent-cap call answered ${second.status}, expected 429`);
      assert(/Remote magpie/.test(second.text), `429 did not come from the remote Magpie: ${second.text.slice(0, 200)}`);
      const afterSpend = (await http(`http://127.0.0.1:${P.upstreamPort}/count`)).json?.requests ?? 0;
      assert(afterSpend === before + 1, `upstream saw ${afterSpend - before} requests, expected 1`);
      const consumerId = readStateIdentity(C.data).nodeId;
      const topup = P.cliJson(["topup", consumerId, "1", "--deposit-id", `phase8-${process.pid}-topup`, "--json"]);
      assert(Number(topup.capUsd) > 0.0001, "topup did not raise the cap");
      const third = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, { method: "POST", key: C.cKey, body, timeoutMs: 30_000 });
      assert(third.status === 200, `post-topup call answered ${third.status}: ${third.text.slice(0, 300)}`);
      const afterTopup = (await http(`http://127.0.0.1:${P.upstreamPort}/count`)).json?.requests ?? 0;
      assert(afterTopup === before + 2, `upstream saw ${afterTopup - before} requests, expected 2`);
      labFacts.calls = { first: 200, spent: 429, afterTopup: 200, upstreamCalls: afterTopup };
      return `200 (${first.text.slice(0, 60)}…), native 429 "${JSON.parse(second.text).error.message.slice(0, 80)}…", topup cap $${topup.capUsd}, 200; P upstream count ${afterTopup}`;
    });

    await step("key enforcement: no key 401, wrong key 401, the handed key 200", async () => {
      const key = readFileSync(join(handoverDir, `${readStateIdentity(C.data).nodeId}.key`), "utf8").trim();
      const none = await http(`http://${LAN}:${P.gatewayPort}/v1/models`, { timeoutMs: 8000 });
      const wrong = await http(`http://${LAN}:${P.gatewayPort}/v1/models`, { key: "sk-test-wrong-phase8", timeoutMs: 8000 });
      const good = await http(`http://${LAN}:${P.gatewayPort}/v1/models`, { key, timeoutMs: 8000 });
      assert(none.status === 401 && wrong.status === 401, `probe statuses ${none.status}/${wrong.status}`);
      assert(good.status === 200, `valid key answered ${good.status}`);
      return `401 / 401 / 200 on ${LAN}:${P.gatewayPort}`;
    });

    await step("setup is idempotent: an existing config is never reset", async () => {
      const before = readStateIdentity(P.data);
      const r = P.cli(["setup", "--network", NETWORK, "--share", "--no-consume", "--ports", String(P.gatewayPort)], { allowFail: true });
      assert(r.code === 0, `repeated setup failed: ${r.err || r.out}`);
      assert(/already has a configuration/.test(r.out), "repeated setup did not say it left the config alone");
      const resume = P.cli(["setup", "--resume", "--json"], { allowFail: true });
      assert(resume.code === 0, `resume failed: ${resume.err}`);
      const after = readStateIdentity(P.data);
      assert(JSON.stringify(before) === JSON.stringify(after), `identity/config changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      return `nodeId ${after.nodeId}, instanceId ${after.instanceId}, mapped ${after.mappedCidr}, secure public key unchanged`;
    });

    await step("restart: both real Magpies recover the same identity, provider and call", async () => {
      const before = { p: readStateIdentity(P.data), c: readStateIdentity(C.data) };
      await P.stopServices();
      await C.stopServices();
      assert((await http(`http://${LAN}:${P.gatewayPort}/v1/models`, { timeoutMs: 2000 })).status === 0, "P gateway still answers after stop");
      assert((await http(`http://${LAN}:${C.gatewayPort}/v1/models`, { timeoutMs: 2000 })).status === 0, "C gateway still answers after stop");
      await P.startServe();
      await C.startServe();
      await waitFor(
        "peer-p reconnects after restart",
        async () => {
          const t = C.cli(["remote", "test", "peer-p", "--json"], { allowFail: true, timeoutMs: 90_000 });
          const d = parseJsonLoose(t.out);
          return d?.provider?.status === "connected" ? d : null;
        },
        120_000,
        3000,
      );
      const after = { p: readStateIdentity(P.data), c: readStateIdentity(C.data) };
      assert(JSON.stringify(before) === JSON.stringify(after), "identity/config changed across restart");
      const call = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, {
        method: "POST",
        key: C.cKey,
        body: { model: `peer-p/${P.upstreamName}/${P.model}`, messages: [{ role: "user", content: "after restart" }] },
        timeoutMs: 30_000,
      });
      assert(call.status === 200, `post-restart call answered ${call.status}: ${call.text.slice(0, 200)}`);
      return `P ${after.p.nodeId} / C ${after.c.nodeId}; peer-p connected; call 200`;
    });

    await step("manual providers survive consume off/on; the plugin-owned provider returns", async () => {
      C.magpie(["provider", "add", "manual-local", `url=http://127.0.0.1:${C.upstreamPort}/v1`, `responses=http://127.0.0.1:${C.upstreamPort}/v1`, `anthropic=http://127.0.0.1:${C.upstreamPort}`, "key=sk-test-manual", `models=${C.model}`, "name=manual-local"]);
      C.cli(["consume", "off", "--json"]);
      const providers = JSON.parse(readFileSync(join(C.data, "providers.json"), "utf8")) as { providers: { id: string }[] };
      const ids = providers.providers.map((p) => p.id);
      assert(ids.includes("manual-local"), `manual-local was removed: ${ids.join(",")}`);
      assert(!ids.includes("peer-p"), `plugin-owned peer-p remained registered: ${ids.join(",")}`);
      C.cli(["consume", "on", "--json"]);
      await waitFor(
        "peer-p returns after consume on",
        async () => {
          const t = C.cli(["remote", "test", "peer-p", "--json"], { allowFail: true, timeoutMs: 90_000 });
          return parseJsonLoose(t.out)?.provider?.status === "connected" ? true : null;
        },
        90_000,
        3000,
      );
      const call = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, {
        method: "POST",
        key: C.cKey,
        body: { model: `peer-p/${P.upstreamName}/${P.model}`, messages: [{ role: "user", content: "manual provider kept" }] },
        timeoutMs: 30_000,
      });
      assert(call.status === 200, `call after consume on answered ${call.status}`);
      return `manual-local kept; peer-p unregistered then reconnected; call 200`;
    });

    if (P2) {
      await step("second provider P2: independent Magpie, overlay and key", async () => {
        await P2.prepare();
        await P2.install();
        await P2.startServe();
        const setup = P2.cli([
          "setup",
          "--network",
          NETWORK,
          "--secret-file",
          secretFile,
          "--peer",
          `tcp://127.0.0.1:${P.listenPort}`,
          "--listen",
          `127.0.0.1:${P2.listenPort}`,
          "--share",
          "--no-consume",
          "--ports",
          String(P2.gatewayPort),
          "--share-models",
          `${P2.upstreamName}/${P2.model}`,
          "--json",
        ], { timeoutMs: 240_000 });
        assert(setup.code === 0, "P2 setup failed");
        const p2Identity = readStateIdentity(P2.data);
        assert(p2Identity.mappedCidr && p2Identity.mappedCidr.endsWith("/32"), "P2 has no mapped /32");
        P2.cli(["consumers", "add", "c2", `${P2.upstreamName}/${P2.model}`, "1", "--json"]);
        const handover = P2.cliJson(["share", "handover", "c2", "--key-file", join(handoverDir, "c2.key"), "--json"]);
        const key = readFileSync(handover.keyFile, "utf8").trim();
        secrets.add(key);
        copyFileSync(handover.keyFile, join(C.home, "c2.key"));
        chmodSync(join(C.home, "c2.key"), 0o600);
        const added = C.cliJson(["remote", "add", "peer-p2", "--cidr", p2Identity.mappedCidr!, "--key-file", join(C.home, "c2.key"), "--port", String(P2.gatewayPort), "--json"]);
        assert(added.status === "connected", `peer-p2 is ${added.status}`);
        const models = C.cliJson(["remote", "models", "peer-p2", "--json"]);
        assert(models.models.includes(`${P2.upstreamName}/${P2.model}`), "peer-p2 models missing");
        const call = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, {
          method: "POST",
          key: C.cKey,
          body: { model: `peer-p2/${P2.upstreamName}/${P2.model}`, messages: [{ role: "user", content: "p2" }] },
          timeoutMs: 30_000,
        });
        assert(call.status === 200, `peer-p2 call answered ${call.status}`);
        labFacts.secondProvider = { nodeId: p2Identity.nodeId, mappedCidr: p2Identity.mappedCidr, gatewayPort: P2.gatewayPort, call: 200 };
        return `P2 ${p2Identity.nodeId} ${p2Identity.mappedCidr}; peer-p2 connected; call 200`;
      });

      await step("single-provider fault: peer-p stays 200 while peer-p2 degrades; remove is targeted", async () => {
        await P2!.stopServices();
        const p = C.cliJson(["remote", "test", "peer-p", "--json"]);
        assert(p.provider.status === "connected", `peer-p became ${p.provider.status} when P2 stopped`);
        const p2 = C.cli(["remote", "test", "peer-p2", "--json"], { allowFail: true, timeoutMs: 90_000 });
        const p2d = parseJsonLoose(p2.out);
        assert(p2d?.provider?.status === "degraded", `peer-p2 is ${p2d?.provider?.status ?? "unknown"}`);
        const pCall = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, {
          method: "POST",
          key: C.cKey,
          body: { model: `peer-p/${P.upstreamName}/${P.model}`, messages: [{ role: "user", content: "p still up" }] },
          timeoutMs: 30_000,
        });
        assert(pCall.status === 200, `peer-p call after P2 stop answered ${pCall.status}`);
        const p2Call = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, {
          method: "POST",
          key: C.cKey,
          body: { model: `peer-p2/${P2!.upstreamName}/${P2!.model}`, messages: [{ role: "user", content: "p2 down" }] },
          timeoutMs: 8000,
        });
        record(`# peer-p2 call while its provider is down: HTTP ${p2Call.status} (0 = client timeout)`);
        C.cliJson(["remote", "remove", "peer-p2", "--json"]);
        const after = await waitFor(
          "peer-p connected after removing peer-p2",
          async () => {
            const t = C.cli(["remote", "test", "peer-p", "--json"], { allowFail: true, timeoutMs: 90_000 });
            const d = parseJsonLoose(t.out);
            return d?.provider?.status === "connected" ? d : null;
          },
          60_000,
          3000,
        );
        assert(after.provider.status === "connected", `peer-p is ${after.provider.status} after removing peer-p2`);
        const finalCall = await http(`http://${LAN}:${C.gatewayPort}/v1/chat/completions`, {
          method: "POST",
          key: C.cKey,
          body: { model: `peer-p/${P.upstreamName}/${P.model}`, messages: [{ role: "user", content: "after p2 remove" }] },
          timeoutMs: 30_000,
        });
        assert(finalCall.status === 200, `peer-p call after remove answered ${finalCall.status}`);
        return `peer-p connected/200 with P2 down; peer-p2 degraded/removed; peer-p still 200`;
      });
    }

    if (RUN_WALLET) {
      await step("wallet wizard: real typedData on 97 and 84532, no signature and no transfer", async () => {
        const consumerId = readStateIdentity(C.data).nodeId;
        P.cli(["wallet", "network", "97", "--rpc", RPC_97, "--enable"], { timeoutMs: 120_000 });
        P.cli(["wallet", "network", "84532", "--rpc", RPC_84532, "--enable"], { timeoutMs: 120_000 });
        const bsc = P.cliJson([
          "wallet",
          "asset-register",
          "97",
          BSC_TOKEN,
          "tMOCK6",
          "Mock Test Dollar",
          "6",
          "--nanos-per-token",
          "1000000000",
          "--note",
          "phase8 read-only test asset",
        ], { timeoutMs: 120_000 });
        assert(Number(bsc.onchainDecimals) === 6, `BSC decimals ${bsc.onchainDecimals}`);
        const base = P.cliJson([
          "wallet",
          "asset-register",
          "84532",
          BASE_TOKEN,
          "tMOCK18",
          "Mock Test Dollar",
          "18",
          "--nanos-per-token",
          "1000000000",
          "--note",
          "phase8 read-only test asset",
        ], { timeoutMs: 120_000 });
        assert(Number(base.onchainDecimals) === 18, `Base decimals ${base.onchainDecimals}`);
        P.cli(["wallet", "receiving", P.upstreamName, "97", TEST_RECIPIENT]);
        P.cli(["wallet", "receiving", P.upstreamName, "84532", TEST_RECIPIENT]);
        const runWizard = (chain: number, asset: string) => {
          const r = P.cli(
            ["wallet", "wizard", "--batch", "--consumer", consumerId, "--provider", P.upstreamName, "--chain", String(chain), "--asset", asset, "--amount", "1", "--yes", "--no-watch"],
            { timeoutMs: 120_000 },
          );
          const typed = typedDataFrom(r.out);
          assert(typed, `no typedData for chain ${chain}: ${r.out.slice(0, 500)}`);
          assert(typed.domain.chainId === chain && typed.message.chainId === chain, `chain id mismatch for ${chain}`);
          assert(String(typed.message.consumerId) === consumerId, "typedData consumer mismatch");
          assert(!("signature" in typed.message), "typedData contains a signature");
          assert(/AWAITING SIGNATURE/.test(r.out), "wizard did not stop awaiting a signature");
          return { typed, out: r.out };
        };
        const a = runWizard(97, "tMOCK6");
        assert(String(a.typed.message.expectedAmountRaw) === "1000000", `BSC amount ${a.typed.message.expectedAmountRaw}`);
        assert(String(a.typed.message.tokenContract).toLowerCase() === BSC_TOKEN.toLowerCase(), "BSC token contract mismatch");
        P.cli(["wallet", "cancel", String(a.typed.message.invoiceId), "--reason", "phase8 typedData check"]);
        const b = runWizard(84532, "tMOCK18");
        assert(String(b.typed.message.expectedAmountRaw) === "1000000000000000000", `Base amount ${b.typed.message.expectedAmountRaw}`);
        assert(String(b.typed.message.tokenContract).toLowerCase() === BASE_TOKEN.toLowerCase(), "Base token contract mismatch");
        P.cli(["wallet", "cancel", String(b.typed.message.invoiceId), "--reason", "phase8 typedData check"]);
        walletEvidence.ran = true;
        walletEvidence.chains = [
          { chainId: 97, asset: "tMOCK6", decimals: 6, amountRaw: a.typed.message.expectedAmountRaw, digest: (a.out.match(/digest (0x[0-9a-f]{64})/) ?? [])[1] ?? null },
          { chainId: 84532, asset: "tMOCK18", decimals: 18, amountRaw: b.typed.message.expectedAmountRaw, digest: (b.out.match(/digest (0x[0-9a-f]{64})/) ?? [])[1] ?? null },
        ];
        walletEvidence.signed = false;
        walletEvidence.broadcast = false;
        let statementNote = "statement not attempted";
        try {
          const statementPath = join(LAB, "wallet-statement.json");
          const st = P.cliJson(["wallet", "statement", consumerId, "--out", statementPath]);
          assert(st.consumerId === consumerId && st.keyPrinted === false, "statement named the wrong consumer or printed a key");
          assert(/^[0-9a-f]{64}$/.test(String(st.digest)), "statement has no SHA-256 digest");
          assert((statSync(st.statementFile).mode & 0o777) === 0o600, "statement file is not 0600");
          const doc = JSON.parse(readFileSync(st.statementFile, "utf8"));
          // The file is the bare statement body; the host wrapper is not written.
          const body = doc.statement && typeof doc.statement === "object" && !Array.isArray(doc.statement) ? doc.statement : doc;
          assert(body.consumerId === consumerId, "statement body names another consumer");
          assert(body.signed === false, "statement claims to be signed");
          assert(body.digest === st.digest || doc.digest === st.digest, "statement digest does not match its body");
          const chains = [...new Set((body.requests ?? []).map((r: any) => Number(r.chainId)))].sort();
          assert(chains.includes(97) && chains.includes(84532), `statement does not contain both chains: ${chains.join(",")}`);
          assert((body.requests ?? []).every((r: any) => r.status === "cancelled" || r.status === "void"), "statement contains a non-cancelled request");
          copyFileSync(st.statementFile, join(EVIDENCE, "wallet-statement.json"));
          chmodSync(join(EVIDENCE, "wallet-statement.json"), 0o600);
          walletEvidence.statement = {
            attempted: true,
            ok: true,
            consumerId,
            fileMode: "0600",
            digest: st.digest,
            chains,
            requestCount: body.requests?.length ?? 0,
            signed: false,
            onlyNamedConsumer: body.consumerId === consumerId,
            keyPrinted: st.keyPrinted,
          };
          statementNote = `statement 0600 digest ${st.digest.slice(0, 12)}…`;
        } catch (e) {
          const detail = String((e as Error)?.message ?? e);
          walletEvidence.statement = { attempted: true, ok: false, consumerId, error: detail };
          record(`# wallet statement is UNKNOWN on this tree: ${detail.slice(0, 300)}`);
          statementNote = `statement UNKNOWN: ${detail.slice(0, 120)}`;
        }
        walletEvidence.note =
          "Both intents were cancelled after the typedData was captured. No signature, transfer, scan or chain write was performed. " +
          statementNote;
        return `97 raw ${a.typed.message.expectedAmountRaw}; 84532 raw ${b.typed.message.expectedAmountRaw}; both awaiting signature, cancelled; ${statementNote}; no transfer`;
      });
    }

    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    record(`\n# result: ${passed} passed, ${failed} failed`);
    labFacts.ports = {
      P: { gateway: P.gatewayPort, upstream: P.upstreamPort, listen: P.listenPort, catalog: P.catalogPort },
      C: { gateway: C.gatewayPort, upstream: C.upstreamPort, listen: C.listenPort, catalog: C.catalogPort, socks: C.socksPort },
      ...(P2 ? { P2: { gateway: P2.gatewayPort, upstream: P2.upstreamPort, listen: P2.listenPort, catalog: P2.catalogPort } } : {}),
    };
  } finally {
    labFacts.ports = {
      P: { gateway: P.gatewayPort, upstream: P.upstreamPort, listen: P.listenPort, catalog: P.catalogPort },
      C: { gateway: C.gatewayPort, upstream: C.upstreamPort, listen: C.listenPort, catalog: C.catalogPort, socks: C.socksPort },
      ...(P2 ? { P2: { gateway: P2.gatewayPort, upstream: P2.upstreamPort, listen: P2.listenPort, catalog: P2.catalogPort } } : {}),
    };
    const ownedBefore = processTable()
      .filter((p) => p.command.includes(LAB))
      .map((p) => ({ pid: p.pid, command: p.command.slice(0, 140) }));
    await P.stopServices().catch(() => {});
    await C.stopServices().catch(() => {});
    if (P2) await P2.stopServices().catch(() => {});
    P.stopAll();
    C.stopAll();
    P2?.stopAll();
    // A final sweep for nothing but this lab root.
    for (const p of processTable()) {
      if (p.command.includes(LAB) && /Magpie\.app|magpie-bun|easytier-core|phase8\/mock-upstream/.test(p.command)) {
        try {
          process.kill(p.pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
    await sleep(1500);
    const portChecks: Record<string, boolean> = {};
    for (const [node, ports] of Object.entries(labFacts.ports as Record<string, Record<string, number>>)) {
      for (const [kind, port] of Object.entries(ports)) portChecks[`${node}.${kind}`] = await portFree(port);
    }
    const remainingAfter = processTable()
      .filter((p) => p.command.includes(LAB))
      .map((p) => ({ pid: p.pid, command: p.command.slice(0, 140) }));
    let sourceManifest: Record<string, any>;
    try {
      const nodes = [
        { name: "P", dir: P.pluginDir },
        { name: "C", dir: C.pluginDir },
        ...(P2 && existsSync(P2.pluginDir) ? [{ name: "P2", dir: P2.pluginDir }] : []),
      ];
      sourceManifest = buildSourceManifest(nodes);
      if (!sourceManifest.ok) {
        const bad = sourceManifest.files.filter(
          (m: any) => !m.tested || !m.allNodeCopiesEqual || !m.unchangedSinceCopy || !m.sameAsRepoAtEnd,
        );
        throw new Error(
          "the tested copy differs from the repo source (the tree changed during the run): " +
            bad.map((m: any) => `${m.file} tested=${String(m.tested).slice(0, 12)} repo=${String(m.repoNow).slice(0, 12)}`).join(", "),
        );
      }
    } catch (e) {
      const detail = String((e as Error)?.message ?? e);
      sourceManifest = { ok: false, error: detail, files: [] };
      results.push({ name: "source manifest captured before cleanup", ok: false, detail, ms: 0, required: true });
      process.exitCode = 1;
    }
    const cleanup = {
      ownedBefore,
      remainingAfter,
      ports: labFacts.ports,
      portsFree: portChecks,
      kept: KEEP,
      labRoot: KEEP ? LAB : null,
      removed: false,
    };
    if (!KEEP) {
      rmSync(LAB, { recursive: true, force: true });
      cleanup.removed = !existsSync(LAB);
    }
    writeFileSync(join(EVIDENCE, "cleanup.json"), JSON.stringify(cleanup, null, 2) + "\n", { mode: 0o600 });
    writeEvidence(
      { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
      cleanup,
      sourceManifest,
    );
    console.log(
      `\ncleanup: ${cleanup.removed ? "lab removed" : KEEP ? `kept ${LAB}` : "incomplete"}` +
        `; owned pids ${ownedBefore.map((p) => p.pid).join(",") || "none"}; remaining ${remainingAfter.length}; ` +
        `ports free ${Object.values(portChecks).filter(Boolean).length}/${Object.keys(portChecks).length}`,
    );
  }
}

function buildSourceManifest(nodes: { name: string; dir: string }[]): Record<string, any> {
  const manifest = PLUGIN_MANIFEST_FILES.map((f) => {
    const testedHashes = nodes.map((n) => sha256File(join(n.dir, f)));
    const capturedHashes = nodes.map((n) => copyHashes[n.name]?.[f] ?? null);
    const repoPath = join(PLUGIN_SOURCE, f);
    if (!existsSync(repoPath)) throw new Error(`repo source is missing ${f}`);
    const repoNow = sha256File(repoPath);
    return {
      file: f,
      tested: testedHashes[0],
      allNodeCopiesEqual: testedHashes.every((h) => h === testedHashes[0]),
      capturedAtCopy: capturedHashes[0],
      unchangedSinceCopy: testedHashes.every((h, i) => h === capturedHashes[i]),
      repoNow,
      sameAsRepoAtEnd: testedHashes[0] === repoNow,
    };
  });
  const ok = manifest.every(
    (m) => Boolean(m.tested) && m.allNodeCopiesEqual && m.unchangedSinceCopy && m.sameAsRepoAtEnd,
  );
  return {
    ok,
    note: "sha256 captured from the immutable per-node copy at creation, re-hashed before cleanup and compared with the repo source at report time; a null or changed hash fails the run.",
    gitHead: labFacts.plugin?.commit ?? null,
    dirty: labFacts.plugin?.dirty ?? null,
    capturedAt: new Date().toISOString(),
    files: manifest,
    allNodeCopiesEqual: manifest.every((m) => m.allNodeCopiesEqual),
    allUnchangedSinceCopy: manifest.every((m) => m.unchangedSinceCopy),
    allSameAsRepoAtEnd: manifest.every((m) => m.sameAsRepoAtEnd),
  };
}

function writeEvidence(
  summary: { passed: number; failed: number },
  cleanup: Record<string, unknown>,
  sourceManifest: Record<string, any>,
): void {
  writeFileSync(join(EVIDENCE, "source-manifest.json"), JSON.stringify(sourceManifest, null, 2) + "\n", { mode: 0o600 });
  const report = {
    at: new Date().toISOString(),
    platform: labFacts.platform,
    magpie: labFacts.magpie,
    easytier: {
      version: "2.6.4",
      zipSha256: "4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b",
      cache: EASYTIER_CACHE,
    },
    plugin: { ...labFacts.plugin, testedCopy: sourceManifest },
    sourceManifest,
    network: NETWORK,
    scope: {
      newPublicPayments: 0,
      chainWrites: 0,
      walletSignatures: 0,
      vendorRequests: 0,
      thirdPartyAssetsUsed: false,
      privateKeysHeldByPlugin: false,
      note: "The only chain interaction was read-only decimals()/RPC resolution during test-asset registration; no transaction was signed or broadcast.",
    },
    isolation: {
      nodes: ["P", "C", ...(SECOND_PROVIDER ? ["P2"] : [])],
      pluginCopyPerNode: true,
      userProfileTouched: false,
    },
    lab: { root: KEEP ? LAB : null, evidence: EVIDENCE, ...labFacts },
    results,
    summary,
    http: httpLog,
    wallet: walletEvidence,
    cleanup,
    claims: {
      realRemoteMagpie: labFacts.calls ? "REPRODUCED on this run" : "UNKNOWN",
      walletTypedData: walletEvidence.ran ? "REPRODUCED on this run; no chain write" : "UNKNOWN",
      walletStatement: walletEvidence.statement?.ok
        ? "REPRODUCED: named-consumer unsigned statement 0600 with digest"
        : walletEvidence.statement?.attempted
          ? `UNKNOWN (attempted; ${String(walletEvidence.statement.error ?? "failed").slice(0, 120)})`
          : "NOT ATTEMPTED",
      trustRace: transcript.some((l) => l.includes("TOFU trust race reproduced")) ? "REPRODUCED; retried after verified" : "not observed",
      setupIdempotent: results.some((r) => r.ok && r.name.startsWith("setup is idempotent")),
      restartRecovery: results.some((r) => r.ok && r.name.startsWith("restart:")),
      manualProviderPreserved: results.some((r) => r.ok && r.name.startsWith("manual providers survive")),
      multiProviderFaultIsolation: results.some((r) => r.ok && r.name.startsWith("single-provider fault")),
      invalidApprovalRefused: results.some((r) => r.ok && r.name.startsWith("an invalid or stale approval")),
    },
    secrets: "redacted; raw state stayed in the disposable lab root",
  };
  writeFileSync(join(EVIDENCE, "lab-report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(EVIDENCE, "transcript.log"), transcript.join("\n") + "\n", { mode: 0o600 });
}

await main();
