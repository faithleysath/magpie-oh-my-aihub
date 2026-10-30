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

/** The price shape Magpie stores in settings.json (USD per 1M tokens). */
export interface ModelPriceRecord {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cache_write_1h?: number;
  tiers?: { above: number; input: number; output: number; cache_read: number; cache_write: number; cache_write_1h?: number }[];
}

/** One model as the catalogue publishes it, before share-policy filtering. */
export interface CatalogModelMeta {
  id: string;
  displayName: string | null;
  gatewayApis: string[];
  nativeApis: string[] | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  images: boolean | null;
  modalities: { input?: string[]; output?: string[] } | null;
  reasoningLevels: string[] | null;
  price: ModelPriceRecord | null;
  priceSource: "magpie-gateway" | "magpie-settings" | null;
  capabilitiesSource: "magpie-gateway" | "magpie-settings" | "configured-endpoints";
}

interface SettingsFile {
  modelPrices?: Record<string, ModelPriceRecord>;
  modelAPIs?: Record<string, string>;
  modelImages?: Record<string, boolean>;
  modelKinds?: Record<string, string>;
  modelOutputs?: Record<string, number>;
  modelCompacts?: Record<string, number>;
  modelReasonless?: Record<string, boolean>;
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

  /** The user's own model settings, read-only; keys and providers are untouched. */
  settings(): SettingsFile {
    try {
      const parsed = JSON.parse(readFileSync(join(magpieDataDir(), "settings.json"), "utf8")) as SettingsFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * The model metadata the catalogue publishes: Magpie's own local
   * `/v1/models` when the gateway answers on loopback (no key: a loopback caller
   * is local), otherwise the explicit per-model settings. Nothing here invents a
   * capability or a price.
   */
  async catalogModels(): Promise<CatalogModelMeta[]> {
    const ids = await this.modelIds().catch(() => []);
    if (ids.length === 0) return [];
    const gateway = await this.localModelList();
    const settings = this.settings();
    const native = this.nativeProviderIds();
    const byId = new Map((gateway ?? []).map((m) => [String(m.id ?? ""), m]));
    const out: CatalogModelMeta[] = [];
    for (const id of ids) {
      const [provider] = id.split("/");
      if (!native.has(provider)) continue;
      const g = byId.get(id) ?? null;
      const endpointNames = g ? endpointsToNames(Array.isArray(g.native_endpoints) ? g.native_endpoints.map(String) : []) : null;
      const settingApis = settingFor(settings.modelAPIs, id);
      const configured = configuredProtocols(this.providerById(provider));
      const gatewayApis = endpointNames && endpointNames.length > 0
        ? endpointNames
        : settingApis
          ? [normalizeProtocol(settingApis)]
          : configured;
      const images = g
        ? Array.isArray((g.modalities as { input?: unknown })?.input)
          ? ((g.modalities as { input: string[] }).input.includes("image") ? true : null)
          : null
        : settingFor(settings.modelImages, id) ?? null;
      const output = g && Number.isFinite(Number(g.max_output_tokens))
        ? Number(g.max_output_tokens)
        : settingFor(settings.modelOutputs, id) ?? null;
      const context = g && Number.isFinite(Number(g.context_window ?? g.max_input_tokens))
        ? Number(g.context_window ?? g.max_input_tokens)
        : null;
      const reasoning = g && Array.isArray(g.reasoning_levels)
        ? g.reasoning_levels.map(String)
        : settingFor(settings.modelReasonless, id) === true
          ? []
          : null;
      const magpiePrice = (g as { magpie_price?: ModelPriceRecord } | null)?.magpie_price ?? null;
      const storedPrice = magpiePrice ?? settingFor(settings.modelPrices, id) ?? null;
      const anySetting =
        settingApis !== undefined || images !== null || output !== null || storedPrice !== null ||
        settingFor(settings.modelReasonless, id) !== undefined;
      out.push({
        id,
        displayName: g && typeof g.display_name === "string" ? g.display_name : null,
        gatewayApis: gatewayApis.length ? gatewayApis : ["chat", "responses", "anthropic"],
        nativeApis: endpointNames && endpointNames.length ? endpointNames : null,
        contextWindow: context,
        maxOutputTokens: output,
        images,
        modalities: g && g.modalities && typeof g.modalities === "object" ? (g.modalities as { input?: string[]; output?: string[] }) : null,
        reasoningLevels: reasoning,
        price: storedPrice,
        priceSource: storedPrice ? (magpiePrice ? "magpie-gateway" : "magpie-settings") : null,
        capabilitiesSource: g ? "magpie-gateway" : anySetting ? "magpie-settings" : "configured-endpoints",
      });
    }
    return out;
  }

  /**
   * Magpie's model list over the loopback gateway, with the user's prices when
   * the gateway is on loopback. A gateway pinned to a LAN address has no
   * loopback listener; the caller then falls back to settings.json.
   */
  private async localModelList(): Promise<Record<string, unknown>[] | null> {
    try {
      const base = new URL(gatewayBaseURL());
      const port = base.port || "3425";
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { "x-magpie-prices": "1" },
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown };
      return Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : null;
    } catch {
      return null;
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
  async addKey(name: string, ownSecret?: string): Promise<KeyRecord> {
    const args = [this.bin, "gateway-key", "add", name];
    // Re-issuing with the same secret keeps the consumer's client configuration:
    // the old key is removed first, then this one takes over its credential.
    if (ownSecret) args.push("--key", ownSecret);
    const out = await this.serial(() => runOk(args, { timeoutMs: 30_000 }));
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
   * Registers a remote Magpie. It never removes or replaces an existing entry:
   * the caller must prove ownership first and call `replaceRemoteProvider`, or
   * refuse. The key is never part of an error.
   */
  async addRemoteProvider(opts: { id: string; url: string; key: string }): Promise<void> {
    const r = await this.serial(() =>
      run([this.bin, "provider", "add", "remote-magpie", opts.key, `url=${opts.url}`, `id=${opts.id}`], {
        timeoutMs: 120_000,
      }),
    );
    if (r.code !== 0) throw new Error(`provider add: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }

  /**
   * Replaces an entry the caller has proven it owns (same id, same URL, same
   * key as the one it wrote). Magpie 0.1.2038 has no in-place edit for a Remote
   * Magpie, so this is remove-then-add.
   */
  async replaceRemoteProvider(opts: { id: string; url: string; key: string }): Promise<void> {
    await this.removeProvider(opts.id);
    await this.addRemoteProvider(opts);
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

/** A per-model setting: exact id, then `provider/*`, then the any-provider entry. */
export function settingFor<T>(map: Record<string, T> | undefined, id: string): T | undefined {
  if (!map) return undefined;
  const [provider, ...rest] = id.split("/");
  const model = rest.join("/");
  return map[id] ?? map[`${provider}/*`] ?? map[`*/${model}`];
}

function normalizeProtocol(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === "messages" || v === "anthropic") return "anthropic";
  if (v === "responses") return "responses";
  return "chat";
}

function endpointsToNames(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (p === "/v1/chat/completions") out.push("chat");
    else if (p === "/v1/responses") out.push("responses");
    else if (p === "/v1/messages") out.push("anthropic");
  }
  return [...new Set(out)];
}

/** The API paths a provider's configured endpoints say it speaks. */
function configuredProtocols(p: ProviderRecord | undefined): string[] {
  if (!p) return ["chat"];
  const out: string[] = [];
  if (p.chat) out.push("chat");
  if (p.responses) out.push("responses");
  if (p.anthropic) out.push("anthropic");
  return out.length ? out : ["chat"];
}
