import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAINNET_ASSETS,
  NetworkRegistry,
  PRODUCT_NETWORKS,
  productRegistry,
} from "../src/networks.ts";
import { assertProductionCreditAsset, assertProductionCreditNetwork, productionReadiness } from "../src/production-policy.ts";
import { Ledger } from "../src/ledger.ts";
import { Provisioner } from "../src/provisioner.ts";
import { FakeMagpie } from "./support/fake-magpie.ts";
import { priceSnapshot, usdToNanos } from "../src/pricing.ts";

const TMP = () => mkdtempSync(join(tmpdir(), "production-policy-"));

describe("production payment policy", () => {
  test("both product mainnets pass the runtime policy with their verified asset", () => {
    const r = productRegistry();
    for (const chainId of [56, 8453]) {
      const network = r.network(chainId)!;
      const asset = r.asset(MAINNET_ASSETS.find((a) => a.chainId === chainId)!.assetId)!;
      expect(() => assertProductionCreditNetwork(network)).not.toThrow();
      expect(() => assertProductionCreditAsset(network, asset)).not.toThrow();
      const readiness = productionReadiness(network, r.assetsForChain(chainId));
      expect(readiness.ready).toBe(true);
      expect(readiness.creditableAssets).toHaveLength(1);
    }
  });

  test("a mainnet with one host, no finality, a mock asset or a non-1-USD rate is refused", () => {
    const base = PRODUCT_NETWORKS[0]!;
    const asset = MAINNET_ASSETS[0]!;
    expect(() => assertProductionCreditNetwork({ ...base, rpcEndpoints: ["https://one.example"], rpcQuorum: 2 })).toThrow(/quorum|distinct/);
    expect(() => assertProductionCreditNetwork({ ...base, finality: { ...base.finality, mode: "read-only" } })).toThrow(/finality/);
    expect(() => assertProductionCreditAsset(base, { ...asset, issuerType: "mock" })).toThrow(/issuer/);
    expect(() => assertProductionCreditAsset(base, { ...asset, pricing: { ...asset.pricing, nanosPerToken: "999999999" } })).toThrow(/1 USD/);
    expect(() => assertProductionCreditAsset(base, { ...asset, evidence: null })).toThrow(/evidence/);
  });

  test("the registry refuses a mainnet record that is not a peer of the two known chains", () => {
    const base = PRODUCT_NETWORKS[1]!;
    expect(() => new NetworkRegistry({ version: 3, networks: [{ ...base, chainId: 999 }], assets: [] })).toThrow(/not a known product mainnet/);
  });
});

describe("cap guard writes a cost cap and a token cap", () => {
  test("a production-shaped snapshot yields a finite token cap and a readback", async () => {
    const dir = TMP();
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    const magpie = new FakeMagpie();
    const snap = priceSnapshot([{ id: "lab/model", price: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, contextWindow: 128_000, maxOutputTokens: 8_192 }], ["lab/model"])!;
    const provisioner = new Provisioner(magpie as never, {
      ledger,
      prices: async () => snap,
      usageLog: () => magpie.logPath,
      drainMs: 0,
      save: () => {},
    });
    await provisioner.ensure("consumer", { models: ["lab/model"], capUsd: 0.01 });
    const view = await provisioner.topUp("consumer", 1, "dep-1");
    const record = provisioner.find("consumer")!;
    const key = magpie.keys.get(record.keyId)!;
    expect(view.capUsd).toBeGreaterThanOrEqual(1);
    expect(key.tokenCap).toBeGreaterThan(0);
    expect(key.tokenCap!).toBeLessThan(Number.MAX_SAFE_INTEGER);
    const status = (await magpie.limitStatus(record.secret)) as { limit?: { tokenLimit?: number; costLimit?: number } };
    expect(status.limit?.tokenLimit).toBe(key.tokenCap);
    expect(status.limit?.costLimit).toBeCloseTo(record.capUsd, 9);
  });
});
