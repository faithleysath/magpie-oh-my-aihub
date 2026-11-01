// native_models: the models this node can share, with the price a consumer would
// be billed at.
//
// Only Magpie's own native providers are candidates (never `remote-magpie`, never
// `group/…` or `auto/…`): reselling somebody else's channel is not a feature of
// this product (DESIGN-V2 D7). `Magpie.catalogModels()` already applies exactly
// that filter and refuses prices Magpie itself cannot freeze (peak windows,
// provider rate windows, tier limits); this module adds the shape check the
// directory needs — all four price parts present, finite and non-negative.

import { Magpie, type ModelPriceRecord } from "../magpie.ts";
import { resolveMagpieBin } from "../paths.ts";
import type { CatalogPrice } from "../catalog-service.ts";
import { jsonText, NO_ARGS, type ToolDef } from "./types.ts";

export type NativeModelReason = "no-price";

export interface NativeModel {
  id: string;
  /** USD per 1M tokens, or null when Magpie has no complete static price */
  price: CatalogPrice | null;
  shareable: boolean;
  reason?: NativeModelReason;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Magpie's stored price → the directory's four-part price, or null.
 *
 * A tiered price has no single `in`/`out` pair in the directory schema, and a
 * dynamic (`peak`) price cannot be published as one number; both are "no price"
 * rather than a guess.
 */
export function catalogPriceOf(price: ModelPriceRecord | null | undefined): CatalogPrice | null {
  if (!price || typeof price !== "object") return null;
  if (price.tiers !== undefined) return null;
  if (price.peak !== undefined && price.peak !== null && price.peak !== "") return null;
  const { input, output, cache_read, cache_write } = price;
  if (!finiteNonNegative(input) || !finiteNonNegative(output)) return null;
  if (!finiteNonNegative(cache_read) || !finiteNonNegative(cache_write)) return null;
  return { in: input, out: output, cacheRead: cache_read, cacheWrite: cache_write };
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
    return price
      ? { id: meta.id, price, shareable: true }
      : { id: meta.id, price: null, shareable: false, reason: "no-price" };
  });
}

export const nativeModelsTool: ToolDef = {
  description:
    "列出本机 Magpie 的原生模型和价格（USD / 1M tokens），以及可否共享。只有非 remote-magpie 的 provider 且价格完整的模型 " +
    "shareable:true；缺价格给 reason:\"no-price\"。Magpie 不可用时抛 E_MAGPIE，不返回空列表。",
  args: NO_ARGS,
  async execute() {
    return jsonText({ models: await listNativeModels() });
  },
};
