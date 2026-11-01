// native_models: the models this node can share, with the price a consumer would
// be billed at.
//
// Only Magpie's own native providers are candidates (never `remote-magpie`, never
// `group/…` or `auto/…`): reselling somebody else's channel is not a feature of
// this product (D7). `Magpie.catalogModels()` already applies exactly
// that filter and refuses prices Magpie itself cannot freeze (peak windows,
// provider rate windows, tier limits); this module adds the shape check the
// directory needs — all four price parts present, finite and non-negative.

import { Magpie, type ModelPriceRecord } from "../magpie.ts";
import { resolveMagpieBin } from "../paths.ts";
import { CATALOG_MAX_TIERS, type CatalogPeak, type CatalogPrice, type CatalogPriceTier } from "../catalog-service.ts";
import { jsonText, NO_ARGS, type ToolDef } from "./types.ts";

export type NativeModelReason = "no-price" | "rate-window" | "tier-limit";

export interface NativeModel {
  id: string;
  /** USD per 1M tokens, or null when Magpie has no price this plugin can publish */
  price: CatalogPrice | null;
  shareable: boolean;
  reason?: NativeModelReason;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Magpie keeps the off-peak number and doubles it while the vendor's peak hours
 * run (0.1.2289 `catalog.Price`), so 2 is the whole difference between an
 * off-peak and a peak call. `catalog/2` publishes it as a multiplier instead of
 * throwing the price away.
 */
const MAGPIE_PEAK_MULTIPLIER = 2;
const MAX_PEAK_NOTE = 32;

/** Magpie's tiers, or null when this record cannot be published as written. */
function priceTiers(raw: unknown): CatalogPriceTier[] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CATALOG_MAX_TIERS) return null;
  const tiers: CatalogPriceTier[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const t = value as Record<string, unknown>;
    if (!Number.isInteger(t.above) || (t.above as number) <= 0) return null;
    const { input, output, cache_read, cache_write } = t;
    if (!finiteNonNegative(input) || !finiteNonNegative(output)) return null;
    if (!finiteNonNegative(cache_read) || !finiteNonNegative(cache_write)) return null;
    tiers.push({ above: t.above as number, in: input, out: output, cacheRead: cache_read, cacheWrite: cache_write });
  }
  tiers.sort((a, b) => a.above - b.above);
  // A repeated threshold would make "the last tier below the prompt" ambiguous.
  for (let i = 1; i < tiers.length; i += 1) if (tiers[i].above === tiers[i - 1].above) return null;
  return tiers;
}

/** Magpie's `peak` is the vendor tag; the multiplier itself is not in the record. */
function pricePeak(raw: unknown): CatalogPeak | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > MAX_PEAK_NOTE) return null;
  return { multiplier: MAGPIE_PEAK_MULTIPLIER, note: raw };
}

/**
 * Magpie's stored price → the directory's price, or null.
 *
 * The four numbers are always required. `tiers` and `peak` are carried over when
 * Magpie has them (that is what `/2` exists for); a tier or peak this plugin
 * cannot express makes the whole price unpublishable rather than partially
 * advertised — a reader must never compute a bill from half a price.
 */
export function catalogPriceOf(price: ModelPriceRecord | null | undefined): CatalogPrice | null {
  if (!price || typeof price !== "object") return null;
  const { input, output, cache_read, cache_write } = price;
  if (!finiteNonNegative(input) || !finiteNonNegative(output)) return null;
  if (!finiteNonNegative(cache_read) || !finiteNonNegative(cache_write)) return null;
  const tiers = priceTiers(price.tiers);
  if (tiers === null) return null;
  const peak = pricePeak(price.peak);
  if (peak === null) return null;
  const out: CatalogPrice = { in: input, out: output, cacheRead: cache_read, cacheWrite: cache_write };
  if (tiers) out.tiers = tiers;
  if (peak) out.peak = peak;
  return out;
}

/**
 * Every native model Magpie reports. A missing or unusable Magpie is an error
 * (`E_MAGPIE`), never an empty list: an empty list would look like "this node has
 * no models" and could quietly unpublish a working share.
 */
export async function listNativeModels(): Promise<NativeModel[]> {
  let metas;
  try {
    metas = await new Magpie(resolveMagpieBin()).catalogModels();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`E_MAGPIE: cannot read Magpie's model list: ${message}`);
  }
  return metas.map((meta) => {
    const price = catalogPriceOf(meta.price);
    if (price) return { id: meta.id, price, shareable: true };
    const reason: NativeModelReason = meta.priceUnsupported ?? "no-price";
    return { id: meta.id, price: null, shareable: false, reason };
  });
}

export const nativeModelsTool: ToolDef = {
  description:
    "列出本机 Magpie 的原生模型和价格（USD / 1M tokens），以及可否共享。阶梯价（tiers）和高峰加价（peak）" +
    "现在照原样发布，不再是不可共享的理由。只有非 remote-magpie 的 provider 且价格可发布才 shareable:true；" +
    "否则给 reason：no-price（Magpie 没有可用价格）/ rate-window（按时段计价，一个数字只代表当前时段）/ tier-limit（阶数超过 10）。" +
    "暴露在被路由组 unlists 藏起来的模型副本也算：它们仍然可以被网关路由，只是不在模型选择器里。" +
    "Magpie 不可用时抛 E_MAGPIE，不返回空列表。",
  args: NO_ARGS,
  async execute() {
    return jsonText({ models: await listNativeModels() });
  },
};
