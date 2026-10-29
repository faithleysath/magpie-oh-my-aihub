import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { magpieDataDir } from "./paths.ts";
import { run, runOk } from "./run.ts";
import { registerSecret } from "./log.ts";

export interface KeyLimit {
  period?: string;
  days?: number;
  hours?: number;
  tokens?: number;
  cost?: number;
  since?: string;
}

export interface KeyRecord {
  id: string;
  name: string;
  secret: string;
  limit?: KeyLimit | null;
  more?: KeyLimit[] | null;
  models?: string[] | null;
  quotas?: boolean;
}

export interface ProviderRecord {
  id: string;
  name?: string;
  preset?: string;
  /** where the vendor (or the remote Magpie) is reached; holds a key, never log it */
  chat?: string;
  responses?: string;
  anthropic?: string;
  /** the Gateway Key of a remote Magpie; never logged or returned */
  key?: string;
  models?: string[];
}

export interface LimitStatus {
  limited: boolean;
  key: string;
  limit?: {
    period?: string;
    days?: number;
    hours?: number;
    start?: string;
    reset?: string;
    calls?: number;
    tokens?: number;
    cost?: number;
    tokenLimit?: number;
    costLimit?: number;
    tokensLeft?: number;
    costLeft?: number;
    inFlight?: number;
    reserved?: number;
    spent?: boolean;
  };
  limits?: unknown[];
}

/** The gateway port Magpie told the host about. */
export function gatewayBaseURL(): string {
  const addr = (process.env.MAGPIE_ADDR || "").trim();
  if (!addr) return "http://127.0.0.1:3425";
  const withScheme = /^https?:\/\//.test(addr) ? addr : `http://${addr}`;
  return withScheme.replace(/\/$/, "");
}

/**
 * Everything the plugin does to Magpie goes through its own binary's CLI with an
 * argv array (never a shell) or its documented HTTP API. The binary is the one
 * running this host, so it reads and writes the same data directory.
 */
export class Magpie {
  private queue: Promise<unknown> = Promise.resolve();
  private versionLabel: string | null = null;
  private cliTried = false;

  constructor(private bin: string) {}

  /**
   * The Magpie version, read from the app bundle on macOS.
   *
   * It is deliberately **not** `magpie --version`: in a portable copy whose
   * bundle is already running as `magpie serve`, spawning the bundle again for
   * `--version` can spin (the app tries to hand off to the running instance) and
   * a host that boots repeatedly leaves a pile of those behind. The version is a
   * label, never a reason to start a process.
   */
  version(): string {
    if (this.versionLabel) return this.versionLabel;
    try {
      if (process.platform === "darwin") {
        const bundle = dirname(dirname(dirname(this.bin)));
        const plist = join(bundle, "Contents", "Info.plist");
        if (existsSync(plist)) {
          const r = Bun.spawnSync(["plutil", "-extract", "CFBundleShortVersionString", "raw", plist]);
          const v = r.stdout.toString().trim();
          if (v) this.versionLabel = `magpie ${v}`;
        }
      }
    } catch {
      /* label only */
    }
    if (!this.versionLabel) this.versionLabel = "magpie (version unknown)";
    return this.versionLabel;
  }

  /**
   * The version on a platform without an app bundle. Magpie itself has no
   * cross-platform reader (`internal/update/cli_path.go`'s otherVersion is
   * macOS/Homebrew only), so `--version` is the only source. It is tried once,
   * with a short timeout, and never at boot: a hung CLI must not keep a host
   * from starting.
   */
  async detectVersion(): Promise<string> {
    const known = this.version();
    if (!known.includes("unknown")) return known;
    if (this.cliTried) return known;
    this.cliTried = true;
    try {
      const r = await this.serial(() => run([this.bin, "--version"], { timeoutMs: 3000 }));
      const m = /magpie\s+(\d+\.\d+\.\d+)/.exec(r.stdout);
      if (r.code === 0 && m) this.versionLabel = `magpie ${m[1]}`;
    } catch {
      /* a label, not a dependency */
    }
    return this.version();
  }

  /** One CLI call at a time: a stuck call must not pile up. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** All gateway keys, read from Magpie's own store (caller-keys.json). */
  keys(): KeyRecord[] {
    try {
      const raw = readFileSync(join(magpieDataDir(), "caller-keys.json"), "utf8");
      const arr = JSON.parse(raw) as KeyRecord[];
      for (const k of arr) registerSecret(k.secret);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** Magpie's provider list, read from its own store (providers.json). */
  providers(): ProviderRecord[] {
    try {
      const raw = readFileSync(join(magpieDataDir(), "providers.json"), "utf8");
      const parsed = JSON.parse(raw) as { providers?: ProviderRecord[] } | ProviderRecord[];
      const list = Array.isArray(parsed) ? parsed : (parsed.providers ?? []);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /**
   * Whether Magpie's provider list can be read at all. A transient read failure
   * must never look like "this node has no providers": that would make every
   * shared model look unshareable and could revoke working keys.
   */
  providersReadable(): boolean {
    try {
      const raw = readFileSync(join(magpieDataDir(), "providers.json"), "utf8");
      const parsed = JSON.parse(raw) as { providers?: unknown } | unknown[];
      return Array.isArray(parsed) || Array.isArray((parsed as { providers?: unknown }).providers);
    } catch {
      return false;
    }
  }

  providerById(id: string): ProviderRecord | undefined {
    return this.providers().find((p) => p.id === id);
  }

  /**
   * Providers this node owns. A Remote Magpie is another node's gateway: it is
   * marked with Magpie's own `remote-magpie` preset. Only the rest may be
   * shared — reselling somebody else's channel is not a feature of this phase.
   */
  remoteProviderIds(): Set<string> {
    return new Set(this.providers().filter((p) => p.preset === "remote-magpie").map((p) => p.id));
  }

  nativeProviderIds(): Set<string> {
    return new Set(this.providers().filter((p) => p.preset !== "remote-magpie").map((p) => p.id));
  }

  keyByName(name: string): KeyRecord | undefined {
    return this.keys().find((k) => k.name === name);
  }

  keyById(id: string): KeyRecord | undefined {
    return this.keys().find((k) => k.id === id);
  }

  /**
   * Creates a key and returns it with its secret. The CLI prints the secret; the
   * id comes from Magpie's store, matched by the unique name this plugin picks.
   */
  async addKey(name: string): Promise<KeyRecord> {
    const out = await this.serial(() => runOk([this.bin, "gateway-key", "add", name], { timeoutMs: 30_000 }));
    const secret = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^sk-/.test(l))
      .pop();
    if (!secret) throw new Error("magpie gateway-key add printed no key");
    registerSecret(secret);
    for (let i = 0; i < 20; i++) {
      const rec = this.keyByName(name);
      if (rec && rec.secret === secret) return rec;
      await new Promise((r) => setTimeout(r, 200));
    }
    const rec = this.keyByName(name);
    if (rec) return { ...rec, secret };
    throw new Error(`created key ${name} but it is not in caller-keys.json yet`);
  }

  async setModels(id: string, models: string[]): Promise<void> {
    if (models.length === 0) throw new Error("refusing to set an empty model whitelist");
    await this.serial(() => runOk([this.bin, "gateway-key", "models", id, ...models], { timeoutMs: 30_000 }));
  }

  async setCostLimit(id: string, window: string, usd: number): Promise<void> {
    if (!(usd >= 0.0001)) throw new Error(`refusing a cost limit below $0.0001 (${usd})`);
    if (!/^(day|week|month|\d+d|\d+h)$/.test(window)) throw new Error(`bad limit window ${window}`);
    const text = usd.toFixed(4);
    await this.serial(() => runOk([this.bin, "gateway-key", "limit", id, window, "--cost", text], { timeoutMs: 30_000 }));
  }

  async setQuotasOff(id: string): Promise<void> {
    await this.serial(() => runOk([this.bin, "gateway-key", "quotas", id, "off"], { timeoutMs: 30_000 }));
  }

  async removeKey(id: string): Promise<void> {
    await this.serial(() => runOk([this.bin, "gateway-key", "remove", id], { timeoutMs: 30_000 }));
  }

  /**
   * Registers a remote Magpie, or leaves an identical registration alone. A
   * different URL or key for the same id is replaced, because that is the only
   * way to change a provider in 0.1.2038. The key is never part of an error.
   */
  async ensureRemoteProvider(opts: { id: string; url: string; key: string }): Promise<"unchanged" | "added" | "replaced"> {
    const existing = this.providerById(opts.id);
    const wantChat = `${opts.url.replace(/\/$/, "")}/v1`;
    const same = existing && existing.preset === "remote-magpie" && existing.chat === wantChat && existing.key === opts.key;
    if (same) return "unchanged";
    let replaced = false;
    if (existing) {
      await this.removeProvider(opts.id);
      replaced = true;
    }
    const r = await this.serial(() =>
      run([this.bin, "provider", "add", "remote-magpie", opts.key, `url=${opts.url}`, `id=${opts.id}`], {
        timeoutMs: 120_000,
      }),
    );
    if (r.code !== 0) throw new Error(`provider add: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return replaced ? "replaced" : "added";
  }

  async removeProvider(id: string): Promise<void> {
    const r = await this.serial(() => run([this.bin, "provider", "rm", id], { timeoutMs: 60_000 }));
    if (r.code !== 0 && !/not found|no such|no provider/i.test(r.stderr + r.stdout)) {
      throw new Error(`provider rm: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
  }

  /**
   * Every model this Magpie serves, from its own read-only CLI. The gateway's
   * `/v1/models` cannot be used for this from the plugin: on a gateway bound to
   * the LAN address it requires a Gateway Key, and the plugin intentionally has
   * no standing local key. `magpie models` needs none and lists a remote
   * Magpie's models as `<remote>/<provider>/<model>`.
   */
  async modelIds(): Promise<string[]> {
    const r = await this.serial(() => run([this.bin, "models"], { timeoutMs: 30_000 }));
    if (r.code !== 0) throw new Error(`magpie models: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    const ids = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      const token = line.trim().split(/\s{2,}/)[0]?.trim();
      if (!token) continue;
      if (/^(https?|group|auto):?\/\//.test(token)) continue;
      if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._*,/-]+$/.test(token)) ids.add(token);
    }
    return [...ids];
  }

  /** The key's own numbers, from the gateway's documented endpoint. */
  async limitStatus(secret: string, timeoutMs = 15_000): Promise<LimitStatus> {
    const url = `${gatewayBaseURL()}/v1/magpie/limit`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GET /v1/magpie/limit: HTTP ${res.status}`);
    return (await res.json()) as LimitStatus;
  }
}
