import { describe, expect, test } from "bun:test";
import {
  catalogPriceVersion,
  costNanos,
  floorGrid,
  normalizePrice,
  priceSnapshot,
  priceVersionOf,
  unsupportedPriceReason,
  usdToNanos,
  GRID_NANOS,
} from "../src/pricing.ts";

const p = { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 };

describe("price validation", () => {
  test("a price is whole or refused; zeros are deliberate and allowed", () => {
    expect(normalizePrice(p)).toEqual(p);
    expect(normalizePrice({ input: 0, output: 0, cache_read: 0, cache_write: 0 })).not.toBeNull();
    expect(normalizePrice({ input: 1 })).toBeNull();
    expect(normalizePrice({ ...p, output: Number.NaN })).toBeNull();
    expect(normalizePrice({ ...p, cache_write: -1 })).toBeNull();
    expect(normalizePrice({ ...p, tiers: [] })).toBeNull();
    expect(normalizePrice({ ...p, tiers: [{ above: 0, ...p }] })).toBeNull();
  });

  test("a peak or rate-window price is refused instead of being treated as static", () => {
    expect(normalizePrice({ ...p, peak: "deepseek" })).toBeNull();
    expect(normalizePrice({ ...p, peak: "weekdays" })).toBeNull();
    expect(normalizePrice({ ...p, peak: 1 as never })).toBeNull();
    expect(normalizePrice({ ...p, peak: "" })).toEqual(p);
    expect(unsupportedPriceReason(p, { rateWindows: [{ start: "09:00", end: "12:00", rate: 2 }] })).toBe("rate-window");
    expect(unsupportedPriceReason(p, { rateWindows: [] })).toBeNull();
    expect(catalogPriceVersion([{ id: "a/m", pricing: { ...p, peak: "deepseek", unit: "USD per 1M tokens", source: "magpie-gateway" } }])).toBeNull();
  });

  test("the price version changes with any part, and not with key order", () => {
    const a = priceVersionOf(["b/m", "a/m"], { "a/m": p, "b/m": { ...p, output: 3 } });
    const b = priceVersionOf(["a/m", "b/m"], { "b/m": { ...p, output: 3 }, "a/m": p });
    expect(a).toBe(b);
    const c = priceVersionOf(["a/m", "b/m"], { "a/m": { ...p, output: 9 }, "b/m": { ...p, output: 3 } });
    expect(c).not.toBe(a);
  });

  test("a snapshot refuses a model with no complete price", () => {
    expect(priceSnapshot([{ id: "a/m", price: p }], ["a/m"])).not.toBeNull();
    expect(priceSnapshot([{ id: "a/m", price: p }], ["a/m", "a/missing"])).toBeNull();
    expect(priceSnapshot([{ id: "a/m", price: { input: 1 } }], ["a/m"])).toBeNull();
  });


  test("a wildcard whitelist expands to every matching model, and refuses an empty match", () => {
    const metas = [
      { id: "lab/a", price: p },
      { id: "lab/b", price: { ...p, output: 3 } },
      { id: "other/c", price: p },
    ];
    const snap = priceSnapshot(metas, ["lab/*"])!;
    expect(snap.models).toEqual(["lab/a", "lab/b"]);
    expect(snap.prices["lab/b"].output).toBe(3);
    expect(priceSnapshot(metas, ["missing/*"])).toBeNull();
    expect(priceSnapshot(metas, ["lab/*", "lab/a"])!.models).toEqual(["lab/a", "lab/b"]);
  });

  test("catalog price version is recomputable from the quote's models", () => {
    const models = [
      { id: "a/m", pricing: { ...p, unit: "USD per 1M tokens", source: "magpie-gateway" } },
      { id: "b/m", pricing: { ...p, output: 3, unit: "USD per 1M tokens", source: "magpie-gateway" } },
    ];
    const version = catalogPriceVersion(models);
    expect(version).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogPriceVersion([...models].reverse())).toBe(version);
    expect(catalogPriceVersion([{ id: "a/m", pricing: { input: 1 } }])).toBeNull();
  });
});

describe("cost snapshot", () => {
  test("input, output and cache read/write match Magpie's formula", () => {
    expect(costNanos(p, { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })).toBe(usdToNanos(0.0012));
    expect(costNanos(p, { input: 400, output: 100, cacheRead: 600, cacheWrite: 0 })).toBe(usdToNanos(0.00066));
    expect(costNanos(p, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 })).toBe(usdToNanos(0.0002));
  });

  test("a tier applies only when the prompt is strictly over its threshold", () => {
    const tiered = { ...p, tiers: [{ above: 100_000, input: 10, output: 20, cache_read: 1, cache_write: 2 }] };
    expect(costNanos(tiered, { input: 100_000, output: 100, cacheRead: 0, cacheWrite: 0 })).toBe(
      usdToNanos(0.1 + 0.0002),
    );
    expect(costNanos(tiered, { input: 100_001, output: 100, cacheRead: 0, cacheWrite: 0 })).toBe(
      usdToNanos(1.00001 + 0.002),
    );
  });

  test("1-hour cache writes are clamped and use their own price when present", () => {
    const c = { ...p, cache_write_1h: 0.8 };
    expect(costNanos(c, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 2000 })).toBe(
      usdToNanos(0.0008),
    );
  });

  test("caps are floored to Magpie's grid, never rounded up", () => {
    expect(floorGrid(GRID_NANOS - 1)).toBe(0);
    expect(floorGrid(GRID_NANOS)).toBe(GRID_NANOS);
    expect(floorGrid(GRID_NANOS * 3 + 99)).toBe(GRID_NANOS * 3);
  });
});
