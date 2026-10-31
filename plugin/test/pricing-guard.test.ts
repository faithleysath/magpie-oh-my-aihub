import { describe, expect, test } from "bun:test";
import { Magpie } from "../src/magpie.ts";
import {
  catalogPriceVersion,
  normalizePrice,
  priceSnapshot,
  unsupportedPriceReason,
  type PriceParts,
} from "../src/pricing.ts";

const P: PriceParts = { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 };
const PRICE = { ...P, unit: "USD per 1M tokens", source: "magpie-gateway" };

describe("unsupported dynamic price forms", () => {
  test("a no-peak price stays exactly as before", () => {
    expect(normalizePrice(P)).toEqual(P);
    expect(normalizePrice({ ...P, peak: "" })).toEqual(P);
    expect(unsupportedPriceReason(P)).toBeNull();
    expect(unsupportedPriceReason({ ...P, peak: "" })).toBeNull();
    expect(unsupportedPriceReason(P, { rateWindows: [] })).toBeNull();
  });

  test("a peak price is refused, not treated as a complete off-peak price", () => {
    for (const peak of ["deepseek", "weekdays", "custom", 1, null, {}]) {
      expect(normalizePrice({ ...P, peak })).toBeNull();
      expect(unsupportedPriceReason({ ...P, peak })).toBe("peak");
    }
  });

  test("a provider rate window is refused even when the price itself has no peak", () => {
    expect(unsupportedPriceReason(P, { rateWindows: [{ start: "09:00", end: "12:00", rate: 2 }] })).toBe("rate-window");
    expect(unsupportedPriceReason(P, { rateWindows: null })).toBe("rate-window");
    expect(unsupportedPriceReason({ ...P, rateWindows: [] })).toBe("rate-window");
  });

  test("a peak marker inside a tier is refused too", () => {
    const tier = { above: 100_000, ...P, peak: "deepseek" };
    expect(normalizePrice({ ...P, tiers: [tier] })).toBeNull();
    expect(unsupportedPriceReason(tier)).toBe("peak");
  });

  test("a snapshot and a catalogue price version cannot be built from a peak price", () => {
    expect(priceSnapshot([{ id: "a/m", price: { ...P, peak: "deepseek" } }], ["a/m"])).toBeNull();
    expect(catalogPriceVersion([{ id: "a/m", pricing: { ...PRICE, peak: "deepseek" } }])).toBeNull();
    expect(catalogPriceVersion([{ id: "a/m", pricing: PRICE }])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Magpie catalogue marks dynamic prices unsupported", () => {
  async function metas(price: unknown, providers: unknown[]) {
    const m = new Magpie("/does/not/exist/magpie");
    (m as unknown as { modelIds: () => Promise<string[]> }).modelIds = async () => ["lab/m"];
    (m as unknown as { localModelList: () => Promise<Record<string, unknown>[]> }).localModelList = async () => [
      { id: "lab/m", magpie_price: price },
    ];
    (m as unknown as { providers: () => unknown[] }).providers = () => providers;
    return m.catalogModels();
  }

  test("a static magpie_price is still a complete price", async () => {
    const [meta] = await metas(P, [{ id: "lab" }]);
    expect(meta.price).toEqual(P);
    expect(meta.priceSource).toBe("magpie-gateway");
    expect(meta.priceUnsupported).toBeNull();
  });

  test("price.peak from 0.1.2289 is marked, not silently dropped", async () => {
    const [meta] = await metas({ ...P, peak: "deepseek" }, [{ id: "lab" }]);
    expect(meta.price).toBeNull();
    expect(meta.priceSource).toBeNull();
    expect(meta.priceUnsupported).toBe("peak");
  });

  test("provider rateWindows makes every model's displayed price dynamic", async () => {
    const [meta] = await metas(P, [{ id: "lab", rateWindows: [{ start: "09:00", end: "12:00", rate: 2 }] }]);
    expect(meta.price).toBeNull();
    expect(meta.priceUnsupported).toBe("rate-window");
  });

  test("a settings fallback on a known 0.1.2289 peak vendor is refused too", async () => {
    const m = new Magpie("/does/not/exist/magpie");
    (m as unknown as { modelIds: () => Promise<string[]> }).modelIds = async () => ["deepseek/deepseek-chat"];
    (m as unknown as { localModelList: () => Promise<Record<string, unknown>[]> }).localModelList = async () => [];
    (m as unknown as { settings: () => Record<string, unknown> }).settings = () => ({
      modelPrices: { "deepseek/deepseek-chat": P },
    });
    (m as unknown as { providers: () => unknown[] }).providers = () => [
      { id: "deepseek", chat: "https://api.deepseek.com/v1" },
    ];
    const [meta] = await m.catalogModels();
    expect(meta.price).toBeNull();
    expect(meta.priceUnsupported).toBe("peak");
  });

  test("a settings fallback on a static provider still keeps the old path", async () => {
    const m = new Magpie("/does/not/exist/magpie");
    (m as unknown as { modelIds: () => Promise<string[]> }).modelIds = async () => ["lab/m"];
    (m as unknown as { localModelList: () => Promise<Record<string, unknown>[]> }).localModelList = async () => [];
    (m as unknown as { settings: () => Record<string, unknown> }).settings = () => ({
      modelPrices: { "lab/m": P },
    });
    (m as unknown as { providers: () => unknown[] }).providers = () => [
      { id: "lab", chat: "https://example.invalid/v1" },
    ];
    const [meta] = await m.catalogModels();
    expect(meta.price).toEqual(P);
    expect(meta.priceUnsupported).toBeNull();
  });

  test("an empty peak or empty rateWindows keeps the legacy static path", async () => {
    const [a] = await metas({ ...P, peak: "" }, [{ id: "lab" }]);
    const [b] = await metas(P, [{ id: "lab", rateWindows: [] }]);
    expect(a.price).toEqual({ ...P, peak: "" });
    expect(a.priceUnsupported).toBeNull();
    expect(b.price).toEqual(P);
    expect(b.priceUnsupported).toBeNull();
  });
});
