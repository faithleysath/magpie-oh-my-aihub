// Immutable price snapshots for prepaid accounting.
//
// Magpie has no price pinning: a Gateway Key's used cost is recomputed from
// usage.jsonl at *today's* effective prices (internal/budget/budget.go,
// internal/usage/ledger.go). The plugin therefore cannot make Magpie's number
// immutable. It can, however, record the exact effective price it saw when a
// key/window was issued, charge each settled call at that snapshot, and fail
// closed when the live price no longer matches the snapshot.
//
// The snapshot is built from what Magpie's own /v1/models reports with
// `X-Magpie-Prices: 1` (`magpie_price`), which is `provider.EffectivePriceIn`:
// the user's explicit price, the provider's list, the maker's list, then
// `ModelSameAs`. Nothing here invents a price; a missing or partial price is
// refused rather than treated as zero.
//
// Magpie 0.1.2289 has two time-dependent price forms this snapshot cannot
// freeze: `price.peak` (a DeepSeek/Command Code/OpenCode Go off-peak list
// price, doubled in the vendor's peak hours) and a provider's `rateWindows`
// (applied to the price before /v1/models answers). A static snapshot of either
// silently under- or over-charges against Magpie's own usage ledger, so both
// are refused here rather than dropped.

import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, arrays in order, no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return "null";
}

/** USD per 1M tokens, the unit Magpie stores and reports. */
export interface PriceParts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h?: number;
  tiers?: PriceTier[];
}

export interface PriceTier {
  above: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h?: number;
}

export type PriceBook = Record<string, PriceParts>;

export interface PriceSnapshot {
  /** SHA-256 over the sorted model -> price document */
  version: string;
  /** canonical JSON of `models` below, stored with the window */
  body: string;
  models: string[];
  prices: PriceBook;
}

/** A usage record's token fields, as Magpie wrote them. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

const NANOS_PER_USD = 1_000_000_000;
/** Magpie's cost-cap grid: math.Round(cost*1e4)/1e4 USD. */
export const GRID_NANOS = 100_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A price form this plugin cannot snapshot; never a zero price. */
export type UnsupportedPriceReason = "peak" | "rate-window" | "tier-limit";

/** Magpie/catalog schema accepts at most 10 tiers; bound the check as well. */
export const MAX_PRICE_TIERS = 10;

/**
 * The one place that recognizes a price the plugin cannot freeze.
 *
 *  - `price.peak`: Magpie's 0.1.2289 `catalog.Price` keeps the off-peak
 *    price and doubles it at the vendor's peak hours. The plugin has no
 *    call-time multiplier, so treating this price as complete would bill
 *    every peak call at the off-peak rate.
 *  - `provider.rateWindows`: Magpie applies the window's rate before
 *    answering /v1/models. The returned number is only today's window; a
 *    snapshot of it would keep that discount/surcharge all day.
 *
 * An empty `peak` is what Magpie writes for a price that holds at every hour
 * (`omitempty`), so it is accepted; any non-empty value, and any malformed
 * value, is refused. Only an empty array of rate windows is accepted.
 */
function directUnsupportedPriceReason(price: unknown): UnsupportedPriceReason | null {
  if (!price || typeof price !== "object" || Array.isArray(price)) return null;
  const p = price as Record<string, unknown>;
  // A price object carrying rate windows is not a shape /v1/models writes;
  // refuse it rather than guessing which window applies.
  if (Object.hasOwn(p, "rateWindows")) return "rate-window";
  if (Object.hasOwn(p, "peak") && p.peak !== undefined && p.peak !== "") return "peak";
  return null;
}

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

function normalizeTier(value: unknown): PriceTier | null {
  if (!value || typeof value !== "object") return null;
  if (unsupportedPriceReason(value)) return null;
  const t = value as Record<string, unknown>;
  if (!finite(t.above) || t.above <= 0) return null;
  if (!finite(t.input) || !finite(t.output) || !finite(t.cache_read) || !finite(t.cache_write)) return null;
  const tier: PriceTier = {
    above: t.above,
    input: t.input,
    output: t.output,
    cache_read: t.cache_read,
    cache_write: t.cache_write,
  };
  if (t.cache_write_1h !== undefined) {
    if (!finite(t.cache_write_1h)) return null;
    tier.cache_write_1h = t.cache_write_1h;
  }
  return tier;
}

/**
 * A complete, usable price, or null. Magpie treats a missing part as "no price"
 * and a zero as a deliberate zero; for prepaid credit only an explicit, whole
 * price is accepted. A zero is allowed (a free model) but it must be stated.
 */
export function normalizePrice(value: unknown): PriceParts | null {
  if (!value || typeof value !== "object") return null;
  if (unsupportedPriceReason(value)) return null;
  const p = value as Record<string, unknown>;
  if (!finite(p.input) || !finite(p.output) || !finite(p.cache_read) || !finite(p.cache_write)) return null;
  const out: PriceParts = {
    input: p.input,
    output: p.output,
    cache_read: p.cache_read,
    cache_write: p.cache_write,
  };
  if (p.cache_write_1h !== undefined) {
    if (!finite(p.cache_write_1h)) return null;
    out.cache_write_1h = p.cache_write_1h;
  }
  if (p.tiers !== undefined) {
    if (!Array.isArray(p.tiers) || p.tiers.length === 0) return null;
    const tiers: PriceTier[] = [];
    for (const raw of p.tiers) {
      const t = normalizeTier(raw);
      if (!t) return null;
      // Magpie's own parser requires strictly increasing thresholds.
      if (tiers.length > 0 && t.above <= tiers[tiers.length - 1].above) return null;
      tiers.push(t);
    }
    out.tiers = tiers;
  }
  return out;
}

/** The canonical document that is hashed; source/unit labels are excluded. */
function canonicalPrices(models: string[], prices: PriceBook): string {
  return canonicalJson(
    [...models].sort().map((id) => {
      const p = prices[id];
      const entry: Record<string, unknown> = {
        id,
        input: p.input,
        output: p.output,
        cache_read: p.cache_read,
        cache_write: p.cache_write,
      };
      if (p.cache_write_1h !== undefined) entry.cache_write_1h = p.cache_write_1h;
      if (p.tiers !== undefined) {
        entry.tiers = p.tiers.map((t) => ({
          above: t.above,
          input: t.input,
          output: t.output,
          cache_read: t.cache_read,
          cache_write: t.cache_write,
          ...(t.cache_write_1h !== undefined ? { cache_write_1h: t.cache_write_1h } : {}),
        }));
      }
      return entry;
    }),
  );
}

export function priceVersionOf(models: string[], prices: PriceBook): string {
  return createHash("sha256").update(canonicalPrices(models, prices)).digest("hex");
}

/**
 * Builds a snapshot for every requested model. `metas` is Magpie's own catalogue
 * (`magpie.catalogModels()`), whose `price` is the effective price. Returns null
 * when any model is missing, unpriced, or only partially priced: a caller must
 * fail closed, not issue a key.
 */
export function priceSnapshot(
  metas: { id: string; price: unknown }[],
  models: string[],
): PriceSnapshot | null {
  // A consumer's whitelist may be a glob (`provider/*`). The native key keeps
  // the glob, but the snapshot must cover every model it currently matches; a
  // later model appearing under the glob changes the version and pauses the key.
  const byId = new Map(metas.map((m) => [m.id, m]));
  const wanted = new Set<string>();
  for (const pattern of models) {
    if (!pattern.includes("*")) {
      wanted.add(pattern);
      continue;
    }
    const rx = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    let matched = 0;
    for (const meta of metas) {
      if (!rx.test(meta.id)) continue;
      wanted.add(meta.id);
      matched += 1;
    }
    if (matched === 0) return null;
  }
  const ids = [...wanted].sort();
  if (ids.length === 0) return null;
  const prices: PriceBook = {};
  for (const id of ids) {
    const normalized = normalizePrice(byId.get(id)?.price);
    if (!normalized) return null;
    prices[id] = normalized;
  }
  return {
    version: priceVersionOf(ids, prices),
    body: JSON.stringify({ models: ids, prices }),
    models: ids,
    prices,
  };
}

/** Parses a snapshot stored with a window; null for a corrupt document. */
export function parsePriceSnapshot(body: string): PriceSnapshot | null {
  try {
    const parsed = JSON.parse(body) as { models?: unknown; prices?: unknown };
    if (!Array.isArray(parsed.models) || !parsed.models.every((m) => typeof m === "string")) return null;
    if (!parsed.prices || typeof parsed.prices !== "object") return null;
    const models = [...new Set(parsed.models as string[])].sort();
    const prices: PriceBook = {};
    for (const id of models) {
      const p = normalizePrice((parsed.prices as Record<string, unknown>)[id]);
      if (!p) return null;
      prices[id] = p;
    }
    return { version: priceVersionOf(models, prices), body: JSON.stringify({ models, prices }), models, prices };
  } catch {
    return null;
  }
}

/** The flat price for a prompt of this size (Magpie's Price.At: above, not >=). */
function priceAt(p: PriceParts, promptTokens: number): PriceParts {
  let flat: PriceParts = {
    input: p.input,
    output: p.output,
    cache_read: p.cache_read,
    cache_write: p.cache_write,
    ...(p.cache_write_1h !== undefined ? { cache_write_1h: p.cache_write_1h } : {}),
  };
  for (const t of p.tiers ?? []) {
    if (promptTokens > t.above) {
      flat = {
        input: t.input,
        output: t.output,
        cache_read: t.cache_read,
        cache_write: t.cache_write,
        ...(t.cache_write_1h !== undefined ? { cache_write_1h: t.cache_write_1h } : {}),
      };
    }
  }
  return flat;
}

/**
 * Cost of a recorded call at a frozen price, in integer nano-USD. This mirrors
 * Magpie's catalog.Price.CostSplit; the tokens are Magpie's own record, never a
 * second meter.
 */
export function costNanos(p: PriceParts, tokens: UsageTokens): number {
  const input = Math.max(0, Math.trunc(tokens.input) || 0);
  const output = Math.max(0, Math.trunc(tokens.output) || 0);
  const cacheRead = Math.max(0, Math.trunc(tokens.cacheRead) || 0);
  const cacheWrite = Math.max(0, Math.trunc(tokens.cacheWrite) || 0);
  const cacheWrite1h = Math.min(Math.max(0, Math.trunc(tokens.cacheWrite1h ?? 0) || 0), cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  const flat = priceAt(p, prompt);
  const oneHour = flat.cache_write_1h && flat.cache_write_1h > 0 ? flat.cache_write_1h : flat.cache_write;
  const usd =
    (input * flat.input +
      output * flat.output +
      cacheRead * flat.cache_read +
      (cacheWrite - cacheWrite1h) * flat.cache_write +
      cacheWrite1h * oneHour) /
    1_000_000;
  return Math.round(usd * NANOS_PER_USD);
}

export function usdToNanos(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("a USD amount must be finite and not negative");
  return Math.round(usd * NANOS_PER_USD);
}

export function nanosToUsd(nanos: number): number {
  return nanos / NANOS_PER_USD;
}

/** The largest enforceable cap at or below `nanos` on Magpie's $0.0001 grid. */
export function floorGrid(nanos: number): number {
  if (!Number.isFinite(nanos)) return 0;
  return Math.max(0, Math.floor(nanos / GRID_NANOS) * GRID_NANOS);
}

/** Whether a nanos value is exactly representable as a Magpie cost cap. */
export function onGrid(nanos: number): boolean {
  return Number.isInteger(nanos) && nanos > 0 && nanos % GRID_NANOS === 0;
}

/**
 * Price version of a signed catalogue's models, for binding a quote to the
 * effective price. Null when a model is unpriced: the catalogue may still show
 * it, but it cannot back a prepaid key.
 */
export function catalogPriceVersion(models: { id: string; pricing: unknown }[]): string | null {
  const prices: PriceBook = {};
  const ids: string[] = [];
  for (const model of models) {
    const pricing = model.pricing;
    if (!pricing || typeof pricing !== "object") return null;
    const q = pricing as Record<string, unknown>;
    if (unsupportedPriceReason(q)) return null;
    const p = normalizePrice({
      input: q.input,
      output: q.output,
      cache_read: q.cacheRead ?? q.cache_read,
      cache_write: q.cacheWrite ?? q.cache_write,
      ...((q.cacheWrite1h ?? q.cache_write_1h) !== undefined ? { cache_write_1h: q.cacheWrite1h ?? q.cache_write_1h } : {}),
      ...(Array.isArray(q.tiers)
        ? {
            tiers: q.tiers.map((t) => {
              const tier = t as Record<string, unknown>;
              return {
                above: tier.above,
                input: tier.input,
                output: tier.output,
                cache_read: tier.cacheRead ?? tier.cache_read,
                cache_write: tier.cacheWrite ?? tier.cache_write,
                ...((tier.cacheWrite1h ?? tier.cache_write_1h) !== undefined
                  ? { cache_write_1h: tier.cacheWrite1h ?? tier.cache_write_1h }
                  : {}),
              };
            }),
          }
        : {}),
    });
    if (!p) return null;
    ids.push(model.id);
    prices[model.id] = p;
  }
  if (ids.length === 0) return null;
  return priceVersionOf(ids, prices);
}
