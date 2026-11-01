// Shared plumbing for the phase-8 operator journeys.
//
// The operator CLI is a client of the loopback host API. This module keeps the
// three things that must be identical across every journey in one place:
//   - argument parsing with repeated flags and explicit booleans
//   - an API client with a timeout, actionable connection errors and no payload
//     echo on failure
//   - secret input/output (hidden TTY prompt, or an owner-only 0600 file)
//
// It deliberately does not talk to Magpie for a state change and does not import
// the service. The wizard only prepares arguments and renders results.

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Magpie } from "../src/magpie.ts";
import { lanIPv4, resolveMagpieBin } from "../src/paths.ts";
import { EASYTIER_COMMIT, EASYTIER_VERSION, assetFor } from "../src/easytier-manifest.ts";
import { redact } from "../src/log.ts";

/** The only Magpie version with measured host/CLI behaviour in this project. */
export const VERIFIED_MAGPIE_VERSION = "0.1.2038";

export class CliError extends Error {}

export function fail(message: string): never {
  throw new CliError(message);
}

/** Flags that never consume the following token (unless written as --x=value). */
const BOOLEAN_FLAGS = new Set([
  "json",
  "resume",
  "check",
  "reconfigure",
  "share",
  "no-share",
  "consume",
  "no-consume",
  "publish",
  "no-publish",
  "catalog-publish",
  "no-catalog-publish",
  "catalog-discover",
  "no-catalog-discover",
  "enable-sharing",
  "all-priced",
  "force",
  "trust",
  "yes",
  "prompt-secret",
  "debug",
  "help",
  "clear-peers",
  "print-key",
  "wait",
]);

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  has(name: string): boolean;
  one(name: string): string | undefined;
  all(name: string): string[];
}

export function parseArgs(argv: string[], booleans: Set<string> = BOOLEAN_FLAGS): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim();
    if (!name) fail("an empty --flag is not valid");
    let value = "true";
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else if (!booleans.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[++i];
    }
    const list = flags.get(name) ?? [];
    list.push(value);
    flags.set(name, list);
  }
  return {
    positionals,
    flags,
    has: (name) => flags.has(name),
    one: (name) => flags.get(name)?.at(-1),
    all: (name) => flags.get(name) ?? [],
  };
}

/** Resolve a path for reading: relative paths are relative to the operator's cwd. */
export function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Reads a secret from an owner-only regular file. Non-interactive setup and
 * remote-key handover must use this path; the value never enters a flag.
 */
export function readSecretFile(path: string, label: string): string {
  const file = absolutePath(path);
  let fd: number | null = null;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) fail(`${label} file ${file} is not a regular file`);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      fail(`${label} file ${file} is mode ${(st.mode & 0o777).toString(8)}; chmod 600 it first`);
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      fail(`${label} file ${file} is owned by uid ${st.uid}, not the current user`);
    }
    if (st.size > 8192) fail(`${label} file ${file} is larger than 8 KiB`);
    const raw = readFileSync(fd, "utf8");
    const value = raw.replace(/\r?\n$/, "").trim();
    if (!value) fail(`${label} file ${file} is empty`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} file ${file} contains control characters`);
    return value;
  } catch (e) {
    if (e instanceof CliError) throw e;
    return fail(`${label} file ${file} cannot be read: ${(e as Error).message}`);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Writes a one-time secret to a new 0600 file; never overwrites unless forced. */
export function writeSecretFile(path: string, value: string, opts: { force?: boolean } = {}): string {
  const file = absolutePath(path);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Open first, then inspect/fchmod the descriptor. A preceding lstat() would
  // be a TOCTOU window: an attacker could swap in a symlink between the check
  // and open. O_NOFOLLOW closes that window; O_EXCL refuses overwrite unless
  // --force; the mode is applied to the descriptor before any secret is written.
  const base = opts.force
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  let fd: number | null = null;
  try {
    fd = openSync(file, base | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const st = fstatSync(fd);
    if (!st.isFile()) fail(`${file} is not a regular file`);
    fchmodSync(fd, 0o600);
    writeSync(fd, `${value}\n`);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (e instanceof CliError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") fail(`refusing to overwrite ${file}; choose a new path or pass --force`);
    if (code === "ELOOP") fail(`refusing to write a secret through the symbolic link ${file}`);
    fail(`cannot write ${file}: ${(e as Error).message}`);
  }
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  return file;
}

/** Reads a hidden value from a TTY. Non-interactive callers must use a 0600 file. */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("no TTY for a hidden prompt; non-interactive callers must pass a 0600 secret file");
  }
  return new Promise<string>((resolvePromise, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const anyRl = rl as unknown as { _writeToOutput?: (text: string) => void };
    anyRl._writeToOutput = (text: string) => {
      // Echo the question once, never the typed secret.
      if (text === question) process.stdout.write(question);
    };
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      reject(new CliError("cancelled"));
    });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePromise(answer);
    });
  });
}

export function sha256Prefix(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** The prompt surface of a journey. Tests inject a scripted implementation. */
export interface WizardIO {
  isTTY: boolean;
  prompt(question: string, opts?: { default?: string; secret?: boolean }): Promise<string>;
  print(line: string): void;
}

/** The real terminal implementation: visible by default, hidden for secrets. */
export function defaultWizardIO(): WizardIO {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async prompt(question, opts = {}) {
      const suffix = opts.default !== undefined && !opts.secret ? ` [${opts.default}]` : "";
      const answer = opts.secret
        ? await promptHidden(`${question}: `)
        : await promptText(`${question}${suffix}: `);
      const trimmed = answer.trim();
      return trimmed || opts.default || "";
    },
    print(text) {
      process.stdout.write(`${text}\n`);
    },
  };
}

/** A visible question. Used for names and selections, never for a secret. */
export async function promptText(question: string): Promise<string> {
  if (!process.stdin.isTTY) fail(`no TTY to answer "${question.trim()}"; pass the value as a flag`);
  return new Promise<string>((resolvePromise, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      reject(new CliError("cancelled"));
    });
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(answer);
    });
  });
}

export interface ApiOptions {
  dataDir: string;
  timeoutMs?: number;
}

/**
 * Loopback API client. Only the port/token files are read; a missing host is a
 * one-line actionable error, never an ENOENT stack. A non-2xx response prints
 * the server's redacted `error` field (if any), never the request or response
 * body, and a timeout says the mutation may still be running.
 */
export class OperatorApi {
  private cached: { port: string; token: string } | null = null;
  private readonly dataDir: string;
  readonly timeoutMs: number;

  constructor(opts: ApiOptions) {
    this.dataDir = opts.dataDir;
    this.timeoutMs = Math.max(100, opts.timeoutMs ?? 180_000);
  }

  private hostFile(name: string): string {
    return join(this.dataDir, "oh-my-aihub", name);
  }

  private credentials(): { port: string; token: string } {
    if (this.cached) return this.cached;
    let port: string;
    let token: string;
    try {
      port = readFileSync(this.hostFile("api-port"), "utf8").trim();
      token = readFileSync(this.hostFile("api-token"), "utf8").trim();
    } catch {
      fail(
        `the plugin host is not running for ${this.dataDir} (no api-port/api-token). ` +
          `Install it with \`magpie plugin add <plugin path>\`, restart Magpie, then retry.`,
      );
    }
    if (!port || !token) fail(`the plugin host credentials in ${this.hostFile("api-port")} are empty`);
    this.cached = { port, token };
    return this.cached;
  }

  async call<T = any>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    // The constructor timeout is a ceiling the operator can lower with
    // --timeout-ms; a command's own default can be shorter (a read) or longer
    // (a core restart), but never outlives the operator's ceiling.
    const effectiveTimeout = Math.max(100, Math.min(timeoutMs, this.timeoutMs));
    const { port, token } = this.credentials();
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (/abort|timeout|timed\s*out/i.test(message)) {
        fail(
          `the plugin host did not answer ${method} ${path} within ${effectiveTimeout}ms. ` +
            `The change may still be applying; run status/checks before retrying.`,
        );
      }
      fail(`cannot reach the plugin host on 127.0.0.1:${port}: ${redact(message)}`);
    }
    const text = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const safe = typeof json?.error === "string" ? redact(json.error).split("\n")[0].slice(0, 400) : "";
      fail(`HTTP ${res.status}${safe ? `: ${safe}` : " (no safe error message)"}`);
    }
    return (json ?? text) as T;
  }

  get<T = any>(path: string, timeoutMs?: number): Promise<T> {
    return this.call<T>("GET", path, undefined, timeoutMs);
  }

  post<T = any>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return this.call<T>("POST", path, body, timeoutMs);
  }

  async healthy(timeoutMs = 2_000): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.credentials().port}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}

/** A provider limit is never inferred: missing is UNKNOWN, <=0 is unlimited/unsafe. */
export function limitDisplay(limit: any): { text: string; unsafe: boolean; unknown: boolean } {
  if (!limit || typeof limit !== "object") {
    return { text: "limit UNKNOWN (no read-back)", unsafe: false, unknown: true };
  }
  const cap = limit.costLimit;
  if (typeof cap !== "number" || !Number.isFinite(cap)) {
    return { text: "limit UNKNOWN (no finite cap read-back)", unsafe: false, unknown: true };
  }
  const used = typeof limit.cost === "number" && Number.isFinite(limit.cost) ? `$${limit.cost.toFixed(4)}` : "?";
  if (cap <= 0) {
    return { text: `limit ${used} used / UNLIMITED cap (unsafe: not out of credit)`, unsafe: true, unknown: false };
  }
  return {
    text: `limit ${used} used / $${cap.toFixed(4)} cap${limit.spent ? " spent" : ""}`,
    unsafe: false,
    unknown: false,
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function boolFlag(args: ParsedArgs, positive: string, negative?: string): boolean | undefined {
  if (args.has(positive)) return true;
  if (negative && args.has(negative)) return false;
  return undefined;
}

/** A comma list or repeated flag, trimmed and de-duplicated. */
export function listFlag(args: ParsedArgs, name: string): string[] | undefined {
  const values = args.all(name).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

// --- preflight ---------------------------------------------------------------

export interface StateSummary {
  path: string;
  exists: boolean;
  version: number | null;
  configured: boolean;
  networkName: string | null;
  nodeId: string | null;
  legacy: boolean;
  error: string | null;
}

export function readStateSummary(dataDir: string): StateSummary {
  const path = join(dataDir, "oh-my-aihub", "state.json");
  if (!existsSync(path)) {
    return { path, exists: false, version: null, configured: false, networkName: null, nodeId: null, legacy: false, error: null };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      config?: { networkName?: unknown; nodeId?: unknown } | null;
    };
    const version = typeof raw.version === "number" ? raw.version : null;
    const config = raw.config && typeof raw.config === "object" ? raw.config : null;
    return {
      path,
      exists: true,
      version,
      configured: Boolean(config),
      networkName: typeof config?.networkName === "string" ? config.networkName : null,
      nodeId: typeof config?.nodeId === "string" ? config.nodeId : null,
      legacy: version !== null && version < 3,
      error: null,
    };
  } catch (e) {
    return {
      path,
      exists: true,
      version: null,
      configured: false,
      networkName: null,
      nodeId: null,
      legacy: false,
      error: `state.json cannot be parsed: ${(e as Error).message}`,
    };
  }
}

async function hashFile(path: string): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

export interface Preflight {
  at: string;
  platform: { platform: string; arch: string; bun: string; verifiedBun: string };
  magpie: { bin: string | null; version: string | null; verifiedVersion: string; matches: boolean | null; error: string | null };
  host: { dataDir: string; reachable: boolean; port: string | null; error: string | null };
  state: StateSummary;
  easytier: {
    version: string;
    commit: string;
    platformSupported: boolean;
    installed: boolean;
    verified: boolean | null;
    running: boolean | null;
    coreVersion: string | null;
    rpcPort: number | null;
    error: string | null;
  };
  network: { lanIpv4: string | null; gatewayPort: number; gatewayKeyRequired: boolean | null; error: string | null };
  checks: { available: boolean; at: string | null; items: { name: string; ok: boolean; detail: string; kind?: string; at?: string }[]; error: string | null };
  readiness: unknown;
  blockers: string[];
  warnings: string[];
}

export interface PreflightOptions {
  dataDir: string;
  magpieBin?: string;
  gatewayPort?: number;
  /** live checks are opt-in; the snapshot's own cached checks are always read */
  liveChecks?: boolean;
  timeoutMs?: number;
  /** the LAN address the gateway probe uses; tests pass one with a stub fetch */
  lan?: string | null;
  /** the gateway probe's transport; tests inject it so no real gateway is read */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export async function preflight(opts: PreflightOptions): Promise<Preflight> {
  const at = new Date().toISOString();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const state = readStateSummary(opts.dataDir);
  if (state.error) blockers.push(state.error);
  if (state.legacy) warnings.push(`state.json is version ${state.version}; start the host once to migrate it before reconfiguring`);

  const magpieBin = opts.magpieBin ?? process.env.OH_MY_AIHUB_MAGPIE ?? null;
  let bin: string | null = null;
  let version: string | null = null;
  let magpieError: string | null = null;
  try {
    bin = resolveMagpieBin({ env: magpieBin ?? undefined });
    version = new Magpie(bin).version();
    if (version.includes("unknown")) version = await new Magpie(bin).detectVersion();
  } catch (e) {
    magpieError = (e as Error).message;
    blockers.push(`no usable Magpie binary: ${magpieError}`);
  }
  const magicNumber = version?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  const magpieMatches = magicNumber ? magicNumber === VERIFIED_MAGPIE_VERSION : null;
  if (magicNumber && !magpieMatches) {
    warnings.push(
      `Magpie ${magicNumber} is installed, but only ${VERIFIED_MAGPIE_VERSION} has measured host/CLI behaviour; ` +
        `compatibility is UNKNOWN`,
    );
  }

  const api = new OperatorApi({ dataDir: opts.dataDir, timeoutMs: opts.timeoutMs ?? 10_000 });
  let hostReachable = false;
  let hostPort: string | null = null;
  let hostError: string | null = null;
  try {
    hostPort = readFileSync(join(opts.dataDir, "oh-my-aihub", "api-port"), "utf8").trim() || null;
  } catch {
    hostPort = null;
  }
  if (!hostPort) {
    hostError = "api-port is missing; the plugin host is not running";
  } else {
    hostReachable = await api.healthy(2_000);
    if (!hostReachable) hostError = `api-port points at 127.0.0.1:${hostPort}, but /health does not answer`;
  }
  if (!hostReachable) {
    blockers.push(`the plugin host is not reachable (${hostError}); install/enable the plugin and restart Magpie`);
  }

  let status: any = null;
  let checkError: string | null = null;
  if (hostReachable) {
    try {
      status = await api.get("/status", opts.timeoutMs ?? 30_000);
    } catch (e) {
      checkError = (e as Error).message;
    }
    if (opts.liveChecks) {
      try {
        await api.get("/checks", opts.timeoutMs ?? 30_000);
        status = await api.get("/status", opts.timeoutMs ?? 30_000);
      } catch (e) {
        checkError = (e as Error).message;
      }
    }
  }

  const et = status?.easytier;
  let lan: string | null = null;
  let lanError: string | null = null;
  if (opts.lan !== undefined) {
    lan = opts.lan;
    if (!lan) lanError = "no LAN address supplied";
  } else {
    try {
      lan = lanIPv4();
    } catch (e) {
      lanError = (e as Error).message;
    }
  }
  if (!lan && state.configured) warnings.push(`no usable LAN IPv4: ${lanError ?? "none"}; sharing cannot be published`);

  const gatewayPort = Number(opts.gatewayPort ?? (() => {
    try {
      const url = new URL(status?.magpie?.gateway ?? process.env.MAGPIE_ADDR ?? "http://127.0.0.1:3425");
      return url.port || "3425";
    } catch {
      return 3425;
    }
  })());
  let gatewayKeyRequired: boolean | null = null;
  if (lan) {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`http://${lan}:${gatewayPort}/v1/models`, {
        signal: AbortSignal.timeout(2_000),
      });
      gatewayKeyRequired = res.status === 401;
      if (res.status === 200) warnings.push(`the gateway at ${lan}:${gatewayPort} answered 200 without a key; sharing must not be published`);
    } catch {
      gatewayKeyRequired = false;
    }
    if (gatewayKeyRequired === false && state.configured) {
      warnings.push(
        `the gateway does not answer 401 at ${lan}:${gatewayPort}; enable Magpie's "Share on local network" before sharing`,
      );
    }
  }

  let platformSupported = true;
  let installed = false;
  let verified: boolean | null = null;
  let easytierError: string | null = null;
  const etRoot = join(opts.dataDir, "oh-my-aihub", "easytier", `v${EASYTIER_VERSION}`, `${process.platform}-${process.arch}`);
  try {
    const asset = assetFor(process.platform, process.arch);
    const core = join(etRoot, asset.core);
    const cli = join(etRoot, asset.cli);
    const marker = join(etRoot, ".sha256");
    const records = join(etRoot, ".binaries.json");
    installed = existsSync(core) && existsSync(cli);
    if (installed) {
      try {
        const rec = JSON.parse(readFileSync(records, "utf8")) as { core?: string; cli?: string };
        const markerOk = readFileSync(marker, "utf8").trim() === asset.sha256;
        const coreHash = await hashFile(core);
        const cliHash = await hashFile(cli);
        verified = markerOk && rec.core === coreHash && rec.cli === cliHash;
        if (!verified) easytierError = "installed EasyTier binaries do not match the pinned hashes";
      } catch (e) {
        verified = false;
        easytierError = `cannot verify the installed EasyTier binaries: ${(e as Error).message}`;
      }
    } else {
      easytierError = `EasyTier ${EASYTIER_VERSION} is not installed yet; the host downloads and verifies it on first start`;
    }
  } catch (e) {
    platformSupported = false;
    easytierError = (e as Error).message;
    blockers.push(`EasyTier ${EASYTIER_VERSION} has no verified build for ${process.platform}-${process.arch}`);
  }
  if (verified === false) blockers.push(easytierError ?? "EasyTier binaries failed verification");
  const coreVersion = typeof et?.coreVersion === "string" ? et.coreVersion : null;
  if (coreVersion && !coreVersion.includes(EASYTIER_VERSION)) {
    blockers.push(`the running EasyTier core reports "${coreVersion}", not ${EASYTIER_VERSION}`);
  }
  // A host with no config yet has no core and therefore no ACL to check;
  // that is not a failure, it is the state a first setup starts from.
  if (et?.aclOk === false && (state.configured || et?.running)) {
    blockers.push(`ACL check failed: ${(et.aclProblems ?? []).join("; ") || "unknown"}`);
  }
  if (state.configured && hostReachable && et && !et.running) {
    blockers.push(`the overlay core is not running${et.lastError ? `: ${et.lastError}` : ""}`);
  }
  if (state.configured && hostReachable && et?.rpcPort == null) {
    warnings.push("the RPC port is not reported yet; run checks after the core starts");
  }

  const checkItems = Array.isArray(status?.checks) ? status.checks : [];
  if (status && checkItems.some((c: any) => c.ok === false)) {
    warnings.push(`cached checks contain ${checkItems.filter((c: any) => c.ok === false).length} failure(s)`);
  }
  if (checkError) warnings.push(`checks could not be refreshed: ${checkError}`);

  return {
    at,
    platform: { platform: process.platform, arch: process.arch, bun: Bun.version, verifiedBun: "1.4.3" },
    magpie: { bin, version: magicNumber ?? version, verifiedVersion: VERIFIED_MAGPIE_VERSION, matches: magpieMatches, error: magpieError },
    host: { dataDir: opts.dataDir, reachable: hostReachable, port: hostPort, error: hostError },
    state,
    easytier: {
      version: EASYTIER_VERSION,
      commit: EASYTIER_COMMIT,
      platformSupported,
      installed,
      verified,
      running: typeof et?.running === "boolean" ? et.running : null,
      coreVersion,
      rpcPort: typeof et?.rpcPort === "number" ? et.rpcPort : null,
      error: easytierError,
    },
    network: { lanIpv4: lan, gatewayPort, gatewayKeyRequired, error: lanError },
    checks: {
      available: checkItems.length > 0,
      at: typeof status?.checksAt === "string" ? status.checksAt : null,
      items: checkItems.map((c: any) => ({
        name: String(c.name ?? ""),
        ok: Boolean(c.ok),
        detail: String(c.detail ?? ""),
        ...(typeof c.kind === "string" ? { kind: c.kind } : {}),
        ...(typeof c.at === "string" ? { at: c.at } : {}),
      })),
      error: checkError,
    },
    readiness: status?.readiness ?? null,
    blockers,
    warnings,
  };
}

export function printPreflight(p: Preflight): void {
  line(`platform      ${p.platform.platform}-${p.platform.arch} · Bun ${p.platform.bun} (tested ${p.platform.verifiedBun})`);
  line(
    `Magpie        ${p.magpie.version ?? "not found"} · tested ${p.magpie.verifiedVersion}` +
      (p.magpie.matches === false ? " · UNKNOWN compatibility" : p.magpie.matches === true ? " · match" : ""),
  );
  line(`host          ${p.host.reachable ? `reachable on 127.0.0.1:${p.host.port}` : (p.host.error ?? "not reachable")}`);
  line(`state         ${p.state.exists ? `v${p.state.version ?? "?"}, ${p.state.configured ? `configured (${p.state.networkName ?? "?"})` : "no config"}` : "absent"}`);
  line(
    `EasyTier      ${p.easytier.version} (${p.easytier.commit.slice(0, 12)}) · ` +
      `${p.easytier.installed ? (p.easytier.verified ? "installed & verified" : "installed, NOT verified") : "not installed"}` +
      (p.easytier.coreVersion ? ` · running ${p.easytier.coreVersion}` : ""),
  );
  line(`RPC           ${p.easytier.rpcPort ?? "not reported"}`);
  line(`network       LAN ${p.network.lanIpv4 ?? "none"} · gateway ${p.network.gatewayPort} · keyed probe ${p.network.gatewayKeyRequired === null ? "UNKNOWN" : p.network.gatewayKeyRequired ? "401 (ok)" : "not proven"}`);
  if (p.checks.available) {
    line(`checks        ${p.checks.items.filter((c) => c.ok).length}/${p.checks.items.length} pass · evidence ${p.checks.at ?? "?"}`);
    for (const c of p.checks.items.filter((c) => !c.ok)) line(`  FAIL        ${c.name}: ${c.detail}`);
  } else {
    line(`checks        no cached checks yet${p.checks.error ? ` (${p.checks.error})` : ""}`);
  }
  for (const b of p.blockers) line(`BLOCKER       ${b}`);
  for (const w of p.warnings) line(`warning       ${w}`);
}
