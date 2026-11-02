import { readFileSync } from "node:fs";
import { join } from "node:path";
import { magpieDataDir, resolveMagpieBin } from "./paths.ts";
import { run, runOk } from "./run.ts";
import { registerSecret } from "./log.ts";

/**
 * A price form this plugin cannot freeze; never a zero price.
 *
 *  - `rate-window`: `provider.rateWindows` is applied before /v1/models answers,
 *    so the returned number is only today's window.
 *  - `tier-limit`: more tiers than Magpie's schema accepts.
 *
 * `peak` is no longer on this list: `omai/catalog/2` publishes it as a multiplier
 * on top of the vendor's off-peak numbers, so a peer knows what a peak call
 * costs instead of being billed off-peak on paper and peak in practice.
 */
export type UnsupportedPriceReason = "rate-window" | "tier-limit";

/** Magpie's catalogue schema accepts at most 10 tiers; bound the check too. */
const MAX_PRICE_TIERS = 10;

/**
 * The provider model ids in one `/v1/models` answer. Routing groups (`group/…`,
 * `auto/…`) are not a provider's model — their prices are derived — so they never
 * become catalogue entries.
 */
function modelIdsFromGateway(rows: readonly Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const raw = row.id;
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || id.startsWith("group/") || id.startsWith("auto/")) continue;
    if (!/^[^\s/]+\/[^\s]+$/.test(id)) continue;
    ids.add(id);
  }
  return [...ids];
}

/** Refuses one price object, without looking at its provider. */
function directUnsupportedPriceReason(price: unknown): UnsupportedPriceReason | null {
  if (!price || typeof price !== "object" || Array.isArray(price)) return null;
  const p = price as Record<string, unknown>;
  // A price object carrying rate windows is not a shape /v1/models writes;
  // refuse it rather than guessing which window applies.
  if (Object.hasOwn(p, "rateWindows")) return "rate-window";
  return null;
}

/**
 * The one place that recognizes a price the plugin cannot freeze. Only an empty
 * array of rate windows is accepted; a missing or partial price is refused by
 * the caller rather than treated as zero.
 */
export function unsupportedPriceReason(
  price: unknown,
  provider?: { rateWindows?: unknown } | null,
): UnsupportedPriceReason | null {
  if (provider && provider.rateWindows !== undefined) {
    const windows = provider.rateWindows;
    if (!Array.isArray(windows) || windows.length !== 0) return "rate-window";
  }
  const direct = directUnsupportedPriceReason(price);
  if (direct) return direct;
  if (price && typeof price === "object" && !Array.isArray(price)) {
    const tiers = (price as Record<string, unknown>).tiers;
    if (Array.isArray(tiers)) {
      // A finite, non-recursive walk: a tier cannot nest tiers in the supported
      // schema, and a hostile/cyclic object must not turn this into unbounded work.
      if (tiers.length > MAX_PRICE_TIERS) return "tier-limit";
      for (const tier of tiers) {
        const reason = directUnsupportedPriceReason(tier);
        if (reason) return reason;
      }
    }
  }
  return null;
}

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
  /**
   * Magpie 0.1.2289 time-of-day rates. Present and non-empty means its
   * /v1/models price is only today's window; this plugin cannot freeze it.
   */
  rateWindows?: unknown;
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
  /** Magpie 0.1.2289 off-peak marker; present and non-empty is dynamic. */
  peak?: unknown;
}

/**
 * Magpie 0.1.2289 vendors known to bill DeepSeek's models by the hour. The
 * gateway's /v1/models carries `peak` on their prices; settings.json does not.
 * When the gateway list cannot be read, fall back to settings only for a vendor
 * that is not one of these, and otherwise refuse the price rather than guess.
 * This is deliberately provider-wide: it may over-block a flat model on one of
 * these vendors, but it never under-charges a peak one.
 */
function knownPeakVendor(p: ProviderRecord | undefined): boolean {
  if (!p) return false;
  const ids = new Set([p.id, p.preset ?? ""]);
  for (const id of ["deepseek", "commandcode", "commandcode-plan", "opencode-go"]) {
    if (ids.has(id)) return true;
  }
  for (const raw of [p.chat, p.responses, p.anthropic]) {
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    // A trailing dot is the same DNS host but not the same string upstream's
    // HostOf() compares. Strip it so the settings fallback stays conservative.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "api.deepseek.com" || host === "api.commandcode.ai") return true;
    if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
      if (/\/go(?:\/|$)/.test(url.pathname)) return true;
    }
  }
  return false;
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
  /** Why a price cannot back a capped key; null when it is static. */
  priceUnsupported?: UnsupportedPriceReason | null;
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

  constructor(private bin: string) {}

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
    } catch (error) {
      // A missing file means "no providers yet"; anything else is a read or a
      // parse failure and must not look like an empty provider set.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`cannot read providers.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The user's own model settings, read-only; keys and providers are untouched. */
  settings(): SettingsFile {
    try {
      const parsed = JSON.parse(readFileSync(join(magpieDataDir(), "settings.json"), "utf8")) as SettingsFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      // No settings file is normal on a fresh install; a corrupt one is not.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`cannot read settings.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The model metadata the catalogue publishes, read from Magpie's own local
   * `/v1/models` (no key: a loopback caller is local). Nothing here invents a
   * capability or a price.
   *
   * The *ids* come from that same answer, not from `magpie models`. The gateway
   * lists every id it will actually route — which is the question a catalogue
   * answers — and it keeps models a routing group's `unlists` hides from the
   * picker (they are still routable; a probe reached the vendor upstream with an
   * unlisted id). `magpie models` also costs about ten seconds per call, against
   * two milliseconds here.
   *
   * `modelIds()` stays as the fallback for a gateway that is not answering on
   * loopback (bound to a LAN address, or down). Only when neither answers is this
   * an error, never an empty list — an empty list would unpublish everything.
   */
  async catalogModels(): Promise<CatalogModelMeta[]> {
    const gateway = await this.localModelList();
    let ids: string[];
    if (gateway) {
      ids = modelIdsFromGateway(gateway);
    } else {
      try {
        ids = await this.modelIds();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Magpie answered nothing: /v1/models is unreachable and magpie models failed (${detail})`);
      }
    }
    if (ids.length === 0) return [];
    if (!this.providersReadable()) {
      throw new Error("providers.json cannot be read; refusing to publish an empty provider set");
    }
    const settings = this.settings();
    const native = this.nativeProviderIds();
    const providerRecords = new Map(this.providers().map((p) => [p.id, p]));
    const byId = new Map((gateway ?? []).map((m) => [String(m.id ?? ""), m]));
    const out: CatalogModelMeta[] = [];
    for (const id of ids) {
      const [provider] = id.split("/");
      if (!native.has(provider)) continue;
      const providerRecord = providerRecords.get(provider);
      const g = byId.get(id) ?? null;
      const endpointNames = g ? endpointsToNames(Array.isArray(g.native_endpoints) ? g.native_endpoints.map(String) : []) : null;
      const settingApis = settingFor(settings.modelAPIs, id);
      const configured = configuredProtocols(providerRecord);
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
      const unsupported = unsupportedPriceReason(storedPrice, providerRecord)
        // A vendor that bills by the hour, read without the gateway list: the stored
        // number is only one window, so it is refused exactly like a rate window.
        ?? (magpiePrice === null && knownPeakVendor(providerRecord) ? "rate-window" : null);
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
        price: unsupported ? null : storedPrice,
        priceSource: unsupported ? null : storedPrice ? (magpiePrice ? "magpie-gateway" : "magpie-settings") : null,
        priceUnsupported: unsupported,
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
    } catch (error) {
      // No providers file is a fresh Magpie with no providers: an empty list is
      // the truth. A read/parse failure is not, and must keep the last directory.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  providerById(id: string): ProviderRecord | undefined {
    return this.providers().find((p) => p.id === id);
  }

  nativeProviderIds(): Set<string> {
    return new Set(this.providers().filter((p) => p.preset !== "remote-magpie").map((p) => p.id));
  }

  keyByName(name: string): KeyRecord | undefined {
    return this.keys().find((k) => k.name === name);
  }

  /**
   * Creates a key and returns it with its secret. The CLI prints the secret; the
   * id comes from Magpie's store, matched by the unique name this plugin picks.
   */
  async addKey(name: string, ownSecret?: string): Promise<KeyRecord> {
    const args = [this.bin, "gateway-key", "add", name];
    // Re-issuing with the same secret keeps the consumer's client configuration.
    // `--key -` reads it from stdin, so the secret never appears in the process
    // list (`ps`) for every local user on the machine.
    if (ownSecret) args.push("--key", "-");
    const out = await this.serial(() =>
      runOk(args, { timeoutMs: 30_000, ...(ownSecret ? { stdin: `${ownSecret}\n` } : {}) }),
    );
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
    if (rec) {
      // Two keys with one name would make keyByName() ambiguous; never return a
      // record whose id belongs to a different secret.
      if (rec.secret !== secret) throw new Error(`created key ${name} but a different key with that name already exists`);
      return { ...rec, secret };
    }
    throw new Error(`created key ${name} but it is not in caller-keys.json yet`);
  }

  async setModels(id: string, models: string[]): Promise<void> {
    if (models.length === 0) throw new Error("refusing to set an empty model whitelist");
    await this.serial(() => runOk([this.bin, "gateway-key", "models", id, ...models], { timeoutMs: 30_000 }));
  }

  /**
   * Replaces the key's secret, keeping the key, its usage and its limits
   * (`gateway-key rotate`). The old secret is then refused by a remote caller,
   * which is what makes this the fail-closed fallback when removal fails.
   */
  async rotateKey(id: string): Promise<string> {
    const out = await this.serial(() => runOk([this.bin, "gateway-key", "rotate", id], { timeoutMs: 30_000 }));
    const secret = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^sk-/.test(l))
      .pop();
    if (!secret) throw new Error("magpie gateway-key rotate printed no key");
    registerSecret(secret);
    return secret;
  }

  async setCostLimit(id: string, window: string, usd: number): Promise<void> {
    await this.setLimit(id, window, { costUsd: usd });
  }

  /**
   * Sets the key's cost and/or token limit in one CLI call. The token limit is a
   * second, price-independent bound: Magpie admits a request while both the cost
   * and token reservations have room, so a concurrent workload cannot spend an
   * unbounded multiple of the prepaid balance even if a call costs more than its
   * reservation.
   */
  async setLimit(id: string, window: string, limit: { costUsd?: number; tokens?: number }): Promise<void> {
    if (!/^(day|week|month|\d+d|\d+h)$/.test(window)) throw new Error(`bad limit window ${window}`);
    if (limit.costUsd === undefined && limit.tokens === undefined) throw new Error("a limit needs a cost or a token cap");
    const args = [this.bin, "gateway-key", "limit", id, window];
    if (limit.costUsd !== undefined) {
      if (!(limit.costUsd >= 0.0001)) throw new Error(`refusing a cost limit below $0.0001 (${limit.costUsd})`);
      args.push("--cost", limit.costUsd.toFixed(4));
    }
    if (limit.tokens !== undefined) {
      if (!Number.isSafeInteger(limit.tokens) || limit.tokens <= 0) throw new Error(`refusing a token limit of ${String(limit.tokens)}`);
      args.push("--tokens", String(limit.tokens));
    }
    await this.serial(() => runOk(args, { timeoutMs: 30_000 }));
  }

  async removeKey(id: string): Promise<void> {
    await this.serial(() => runOk([this.bin, "gateway-key", "remove", id], { timeoutMs: 30_000 }));
  }

  /**
   * Registers a remote Magpie. It never removes or replaces an existing entry:
   * the caller must prove ownership first and call `replaceRemoteProvider`, or
   * refuse. The key is never part of an error.
   */
  async addRemoteProvider(opts: { id: string; url: string; key: string; name?: string }): Promise<void> {
    const args = [this.bin, "provider", "add", "remote-magpie", opts.key, `url=${opts.url}`, `id=${opts.id}`];
    // The name is what a human sees in Magpie's provider list; without it every
    // Remote Magpie this plugin adds is called "Remote magpie".
    if (opts.name) args.push(`name=${opts.name}`);
    const r = await this.serial(() => run(args, { timeoutMs: 120_000 }));
    if (r.code !== 0) throw new Error(`provider add: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }

  /**
   * Replaces an entry the caller has proven it owns (same id, same URL, same
   * key as the one it wrote). Magpie 0.1.2038 has no in-place edit for a Remote
   * Magpie, so this is remove-then-add.
   */
  async replaceRemoteProvider(opts: { id: string; url: string; key: string; name?: string }): Promise<void> {
    await this.removeProvider(opts.id);
    await this.addRemoteProvider(opts);
  }

  async removeProvider(id: string, timeoutMs = 60_000): Promise<void> {
    const r = await this.serial(() => run([this.bin, "provider", "rm", id], { timeoutMs }));
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
    if (!res.ok) {
      const error = new Error(`GET /v1/magpie/limit: HTTP ${res.status}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
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

let shared: Magpie | null = null;

/**
 * The one Magpie client for this host.
 *
 * `serial()` is per instance, so a fresh client per call would let two
 * approvals (or a watcher credit and an approval) run `gateway-key add` at the
 * same time. One client is what makes "one CLI call at a time" true.
 */
export function magpieClient(): Magpie {
  if (!shared) shared = new Magpie(resolveMagpieBin());
  return shared;
}

/** Test seam: installs a client, or null to resolve the running Magpie again. */
export function setMagpieClientForTest(client: Magpie | null): void {
  shared = client;
}
