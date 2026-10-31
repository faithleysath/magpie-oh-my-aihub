import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetIdOf,
  defaultRegistry,
  DEFAULT_NETWORKS,
  isAssetId,
  loadRegistry,
  NetworkRegistry,
  NETWORK_REGISTRY_VERSION,
  RESERVED_MAINNETS,
  type RegistryDocument,
} from "../src/networks.ts";

/**
 * Requirement 14A: both chains registered, neither privileged, independent
 * enable/disable, no hardcoded primary chain, a third EVM chain added without
 * touching the ledger, same-named tokens on different chains kept apart, and 6
 * vs 18 decimals.
 */
const tmp = () => join(mkdtempSync(join(tmpdir(), "networks-")), "networks.json");

function withThirdChain(): RegistryDocument {
  return {
    version: NETWORK_REGISTRY_VERSION,
    networks: [
      ...DEFAULT_NETWORKS,
      {
        chainId: 31337,
        displayName: "Local EVM",
        family: "evm",
        networkType: "testnet",
        rpcEndpoints: ["http://127.0.0.1:8547"],
        blockExplorer: "",
        nativeSymbol: "ETH",
        enabled: true,
        finality: { mode: "confirmations", confirmations: 1, reorgDepth: 1, rationale: "a local dev chain cannot reorg" },
        scanIntervalSec: 2,
        maxBlockRange: 1000,
        notes: null,
      },
    ],
    assets: [],
  };
}

describe("registry membership", () => {
  test("BSC testnet and Base Sepolia are both registered and both enabled", () => {
    const r = defaultRegistry();
    const enabled = r.enabledNetworks();
    expect(enabled.map((n) => n.chainId).sort((a, b) => a - b)).toEqual([97, 84532]);
    for (const n of enabled) expect(n.networkType).toBe("testnet");
  });

  test("neither chain is privileged: no primary/secondary/preferred/default field", () => {
    const r = defaultRegistry();
    const text = JSON.stringify(r.networks());
    for (const word of ["primary", "secondary", "preferred", "fallbackChain", "isDefault", "priority"]) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
    // The only ordering is the array's; both chains have the same shape of fields.
    const [a, b] = r.networks();
    expect(Object.keys(a!).sort()).toEqual(Object.keys(b!).sort());
  });

  test("the two chains are independent: disabling one leaves the other enabled", () => {
    const path = tmp();
    const r = loadRegistry(path);
    r.setNetworkEnabled(97, false);
    expect(r.enabledNetworks().map((n) => n.chainId)).toEqual([84532]);
    expect(r.network(97)!.enabled).toBe(false);
    r.setNetworkEnabled(84532, false);
    expect(r.enabledNetworks()).toEqual([]);
    r.setNetworkEnabled(97, true);
    expect(r.enabledNetworks().map((n) => n.chainId)).toEqual([97]);
  });

  test("a disabled network stays disabled across a reload (no silent re-seeding)", () => {
    const path = tmp();
    const r = loadRegistry(path);
    r.setNetworkEnabled(84532, false);
    const again = loadRegistry(path);
    expect(again.network(84532)!.enabled).toBe(false);
    expect(again.network(97)!.enabled).toBe(true);
  });

  test("mainnet records exist but can never be enabled in this phase", () => {
    expect(RESERVED_MAINNETS.map((n) => n.chainId)).toEqual([56, 8453]);
    for (const n of RESERVED_MAINNETS) expect(n.enabled).toBe(false);
    const r = new NetworkRegistry({ version: NETWORK_REGISTRY_VERSION, networks: [...DEFAULT_NETWORKS, ...RESERVED_MAINNETS], assets: [] });
    expect(() => r.setNetworkEnabled(56, true)).toThrow(/mainnet/);
    expect(() => r.setNetworkEnabled(8453, true)).toThrow(/mainnet/);
    // They are not in the enabled set and requireEnabledNetwork refuses them.
    expect(r.enabledNetworks().map((n) => n.chainId)).toEqual([97, 84532]);
    expect(() => r.requireEnabledNetwork(56)).toThrow(/mainnet|disabled/);
  });

  test("a registry document with an enabled mainnet is refused outright", () => {
    expect(
      () =>
        new NetworkRegistry({
          version: NETWORK_REGISTRY_VERSION,
          networks: [{ ...RESERVED_MAINNETS[0]!, enabled: true, rpcEndpoints: ["https://bsc-dataseed.binance.org"] }],
          assets: [],
        }),
    ).toThrow(/mainnet/);
  });

  test("a third EVM chain is added by data alone", () => {
    const r = new NetworkRegistry(withThirdChain());
    expect(r.enabledNetworks().map((n) => n.chainId)).toEqual([97, 84532, 31337]);
    // The same code path works for it: register an asset, enable, disable.
    const a = r.registerTestAsset({
      chainId: 31337,
      contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      symbol: "tMOCK18",
      name: "Mock Eighteen",
      decimals: 18,
      nanosPerToken: "1000000000",
      pricingNote: "1 tMOCK18 = 1 test USD",
    });
    expect(a.chainId).toBe(31337);
    expect(r.setAssetEnabled(a.assetId, false).enabled).toBe(false);
  });

  test("a chain registered twice is refused", () => {
    expect(
      () => new NetworkRegistry({ version: 1, networks: [DEFAULT_NETWORKS[0]!, DEFAULT_NETWORKS[0]!], assets: [] }),
    ).toThrow(/twice/);
  });

  test("an enabled chain with no endpoint is refused", () => {
    expect(
      () => new NetworkRegistry({ version: 1, networks: [{ ...DEFAULT_NETWORKS[0]!, rpcEndpoints: [] }], assets: [] }),
    ).toThrow(/RPC endpoint/);
  });

  test("a confirmations policy with zero confirmations is refused", () => {
    expect(
      () =>
        new NetworkRegistry({
          version: 1,
          networks: [{ ...DEFAULT_NETWORKS[0]!, finality: { mode: "confirmations", confirmations: 0, reorgDepth: 0, rationale: "x" } }],
          assets: [],
        }),
    ).toThrow(/no confirmations/);
  });
});

describe("finality is per chain, not global", () => {
  test("BSC and Base have different, independently justified policies", () => {
    const r = defaultRegistry();
    const bsc = r.network(97)!;
    const base = r.network(84532)!;
    expect(bsc.finality.mode).not.toBe(base.finality.mode);
    expect(bsc.finality.mode).toBe("confirmations");
    expect(base.finality.mode).toBe("finalized-tag");
    // Each carries its own rationale and the measurement it rests on.
    for (const n of [bsc, base]) {
      expect(n.finality.rationale.length).toBeGreaterThan(40);
      expect(n.finality.measured?.at).toBe("2026-10-30");
      expect(n.finality.measured?.source.length).toBeGreaterThan(10);
    }
    // Base's measured lag is recorded, not assumed.
    expect(base.finality.measured?.finalizedLagBlocks).toBeGreaterThan(1000);
    expect(bsc.finality.measured?.finalizedLagBlocks).toBe(0);
  });

  test("a third chain brings its own policy rather than inheriting one", () => {
    const r = new NetworkRegistry(withThirdChain());
    expect(r.network(31337)!.finality.confirmations).toBe(1);
    expect(r.network(31337)!.finality.rationale).toContain("local");
  });
});

describe("assets are identified by (chain, contract), never by symbol", () => {
  const contract = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  test("the same contract address on two chains is two assets", () => {
    const r = defaultRegistry();
    const a = r.registerTestAsset({ chainId: 97, contractAddress: contract, symbol: "tMOCK6", name: "Mock Dollar", decimals: 6, nanosPerToken: "1000000000", pricingNote: "1:1" });
    const b = r.registerTestAsset({ chainId: 84532, contractAddress: contract, symbol: "tMOCK6", name: "Mock Dollar", decimals: 6, nanosPerToken: "1000000000", pricingNote: "1:1" });
    expect(a.assetId).not.toBe(b.assetId);
    expect(a.assetId).toBe("eip155:97:0x5fbdb2315678afecb367f032d93f642f64180aa3");
    expect(b.assetId).toBe("eip155:84532:0x5fbdb2315678afecb367f032d93f642f64180aa3");
    // And a lookup by chain cannot reach the other chain's asset.
    expect(r.requireEnabledAsset(97, contract).chainId).toBe(97);
    expect(r.requireEnabledAsset(84532, contract).chainId).toBe(84532);
  });

  test("a symbol that pretends to be a real token is refused", () => {
    const r = defaultRegistry();
    for (const symbol of ["USDC", "USDT", "BUSD", "DAI"]) {
      expect(() =>
        r.registerTestAsset({ chainId: 97, contractAddress: contract, symbol, name: "USD Coin", decimals: 6, nanosPerToken: "1000000000", pricingNote: "x" }),
      ).toThrow(/mock or test/);
    }
    // A clearly-marked mock is accepted.
    expect(() =>
      r.registerTestAsset({ chainId: 97, contractAddress: contract, symbol: "tUSDC", name: "Mock USD Coin", decimals: 6, nanosPerToken: "1000000000", pricingNote: "x" }),
    ).not.toThrow();
  });

  test("6 and 18 decimals are both representable and independent", () => {
    const r = defaultRegistry();
    const six = r.registerTestAsset({ chainId: 97, contractAddress: contract, symbol: "tMOCK6", name: "Mock Six", decimals: 6, nanosPerToken: "1000000000", pricingNote: "1:1" });
    const eighteen = r.registerTestAsset({ chainId: 84532, contractAddress: "0x00000000000000000000000000000000000000ff", symbol: "tMOCK18", name: "Mock Eighteen", decimals: 18, nanosPerToken: "1000000000", pricingNote: "1:1" });
    expect(six.decimals).toBe(6);
    expect(eighteen.decimals).toBe(18);
    expect(r.enabledAssets()).toHaveLength(2);
  });

  test("an unusable decimals value is refused", () => {
    const r = defaultRegistry();
    for (const decimals of [-1, 37, 1.5]) {
      expect(() =>
        r.registerTestAsset({ chainId: 97, contractAddress: contract, symbol: "tX", name: "Mock X", decimals, nanosPerToken: "1000000000", pricingNote: "x" }),
      ).toThrow();
    }
  });

  test("an asset on an unregistered chain is refused", () => {
    const r = defaultRegistry();
    expect(() =>
      r.registerTestAsset({ chainId: 424242, contractAddress: contract, symbol: "tX", name: "Mock X", decimals: 6, nanosPerToken: "1", pricingNote: "x" }),
    ).toThrow(/not registered/);
  });

  test("an asset whose id does not match its chain and contract is refused", () => {
    expect(
      () =>
        new NetworkRegistry({
          version: 1,
          networks: DEFAULT_NETWORKS,
          assets: [
            {
              assetId: "eip155:84532:0x5fbdb2315678afecb367f032d93f642f64180aa3",
              chainId: 97,
              contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
              symbol: "tX",
              name: "Mock X",
              decimals: 6,
              issuerType: "mock",
              testnetOnly: true,
              enabled: true,
              pricing: { nanosPerToken: "1", version: "v", kind: "fixed-test-rate", note: "x" },
            },
          ],
        }),
    ).toThrow(/does not match/);
  });

  test("a disabled chain's assets are not creditable", () => {
    const r = defaultRegistry();
    const a = r.registerTestAsset({ chainId: 97, contractAddress: contract, symbol: "tMOCK6", name: "Mock Six", decimals: 6, nanosPerToken: "1000000000", pricingNote: "1:1" });
    r.setNetworkEnabled(97, false);
    expect(r.enabledAssets()).toEqual([]);
    expect(() => r.requireEnabledAsset(97, contract)).toThrow(/not enabled/);
    r.setNetworkEnabled(97, true);
    expect(r.requireEnabledAsset(97, contract).assetId).toBe(a.assetId);
  });

  test("an unknown contract is refused by the allowlist", () => {
    const r = defaultRegistry();
    expect(() => r.requireEnabledAsset(97, "0x00000000000000000000000000000000000000aa")).toThrow(/not an allowlisted asset/);
  });

  test("asset ids are validated", () => {
    expect(isAssetId(assetIdOf(97, "0x5FbDB2315678afecb367f032d93F642f64180aa3"))).toBe(true);
    expect(isAssetId("eip155:97:0xZZZ")).toBe(false);
    expect(isAssetId("USDC")).toBe(false);
    expect(isAssetId(97)).toBe(false);
  });
});

describe("persistence", () => {
  test("the seeded file is written and reloaded identically", () => {
    const path = tmp();
    const r = loadRegistry(path);
    const doc = JSON.parse(readFileSync(path, "utf8")) as RegistryDocument;
    expect(doc.networks.map((n) => n.chainId)).toEqual([97, 84532, 56, 8453]);
    const again = loadRegistry(path);
    expect(again.networks()).toEqual(r.networks());
  });

  test("an unreadable registry is an error, not an empty registry", () => {
    const path = tmp();
    writeFileSync(path, "{ this is not json");
    expect(() => loadRegistry(path)).toThrow(/unreadable/);
  });

  test("an endpoint list is validated", () => {
    const r = defaultRegistry();
    expect(() => r.setRpcEndpoints(97, ["not a url"])).toThrow(/not a URL/);
    expect(() => r.setRpcEndpoints(97, ["ftp://example.com"])).toThrow(/http/);
    expect(() => r.setRpcEndpoints(97, [])).toThrow(/at least one endpoint/);
    expect(r.setRpcEndpoints(97, ["https://one.example", "https://two.example"]).rpcEndpoints).toHaveLength(2);
  });
});
