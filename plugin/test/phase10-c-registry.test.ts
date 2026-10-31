import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetIdOf,
  DEFAULT_NETWORKS,
  loadRegistry,
  MAINNET_ASSETS,
  NetworkRegistry,
  PRODUCT_NETWORKS,
  productRegistry,
  type AssetRecord,
  type AssetRecordInput,
  type RegistryDocument,
} from "../src/networks.ts";
import {
  assertCreditSourceNotMainnet,
  assertNoMainnetAutoRecharge,
  assertNoMainnetCredit,
  assertNoMainnetSend,
  isMainnetChainId,
  MAINNET_BOUNDARY,
  MAINNET_CHAIN_IDS,
  mainnetCapabilities,
  MainnetGateError,
} from "../src/mainnet-gate.ts";
import { ReceivingNetworkPolicy } from "../src/receiving-networks.ts";
import { encodeBalanceOf, ReadOnlyChainReader } from "../src/readonly-balance.ts";
import { Wallet } from "../src/wallet.ts";
import { ChainStore } from "../src/chainstore.ts";
import { Ledger } from "../src/ledger.ts";
import { priceSnapshot, usdToNanos } from "../src/pricing.ts";
import type { CreditSink } from "../src/watcher.ts";

const TMP = () => mkdtempSync(join(tmpdir(), "phase10-c-"));
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_USDC_ID = "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const emptySink = (): CreditSink => ({
  depositIntent: () => ({ created: true }),
  applyDeposit: async () => {},
  freezeConsumer: async () => {},
  balance: () => ({ depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 }),
});

function onlyProductRegistry(): NetworkRegistry {
  return new NetworkRegistry({ version: 2, networks: PRODUCT_NETWORKS, assets: MAINNET_ASSETS });
}

function walletOnlyProduct(dir = TMP(), fetchImpl?: typeof fetch) {
  const store = new ChainStore(join(dir, "chain.sqlite"));
  const wallet = new Wallet({
    credit: emptySink(),
    registry: onlyProductRegistry(),
    store,
    receivingPath: join(dir, "receiving-networks.json"),
    readOnlyFetch: fetchImpl,
    now: () => new Date("2026-10-31T00:00:00.000Z"),
  });
  return { wallet, store, dir };
}

function wordHex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function abiStringHex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${bytes.length.toString(16).padStart(64, "0")}${padded}`;
}

class FakeReadOnlyRpc {
  calls = 0;
  methods: string[] = [];
  constructor(
    readonly opts: {
      chainId: number;
      reportedChainId?: number;
      decimals?: number;
      symbol?: string;
      balance?: bigint;
      nativeBalance?: bigint;
      block?: number;
    },
  ) {}
  fetch = (async (_url: string, init?: RequestInit): Promise<Response> => {
    this.calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    this.methods.push(body.method);
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    switch (body.method) {
      case "eth_chainId":
        return reply(`0x${(this.opts.reportedChainId ?? this.opts.chainId).toString(16)}`);
      case "eth_blockNumber":
        return reply(`0x${(this.opts.block ?? 777).toString(16)}`);
      case "eth_getBalance":
        // A JSON-RPC quantity is not zero-padded, unlike an ABI word.
        return reply(`0x${(this.opts.nativeBalance ?? 0n).toString(16)}`);
      case "eth_call": {
        const data = String((body.params[0] as { data?: string })?.data ?? "");
        if (data.startsWith("0x313ce567")) return reply(wordHex(BigInt(this.opts.decimals ?? 6)));
        if (data.startsWith("0x95d89b41")) return reply(abiStringHex(this.opts.symbol ?? "USDC"));
        if (data.startsWith("0x70a08231")) return reply(wordHex(this.opts.balance ?? 0n));
        return reply("0x");
      }
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: "unexpected method" } }), { status: 200 });
    }
  }) as typeof fetch;
}

function v1Network(chainId: number, enabled: boolean) {
  return {
    chainId,
    displayName: chainId === 97 ? "BNB Smart Chain Testnet" : chainId === 84532 ? "Base Sepolia" : "Local EVM",
    family: "evm" as const,
    networkType: "testnet" as const,
    rpcEndpoints: ["https://example.test"],
    blockExplorer: "",
    nativeSymbol: "ETH",
    enabled,
    finality: { mode: "confirmations" as const, confirmations: 1, reorgDepth: 1, rationale: "old document" },
    scanIntervalSec: 2,
    maxBlockRange: 1000,
    notes: null,
  };
}

function v1Asset(chainId: number, contract: string): AssetRecordInput {
  return {
    assetId: assetIdOf(chainId, contract),
    chainId,
    contractAddress: contract,
    symbol: "tMOCK6",
    name: "Mock Six",
    decimals: 6,
    issuerType: "mock",
    testnetOnly: true,
    enabled: true,
    pricing: { nanosPerToken: "1000000000", version: "fixed:v1", kind: "fixed-test-rate", note: "1:1" },
  };
}

describe("C1 product network registry: BSC and Base are peers", () => {
  test("56 and 8453 are read-only product networks with the same record shape", () => {
    expect(PRODUCT_NETWORKS.map((n) => n.chainId)).toEqual([56, 8453]);
    for (const n of PRODUCT_NETWORKS) {
      expect(n.networkType).toBe("mainnet");
      expect(n.support).toBe("read-only");
      expect(n.receivable).toBe(true);
      expect(n.enabled).toBe(false);
      expect(n.rpcEndpoints.length).toBeGreaterThan(0);
      expect(n.evidence?.url).toMatch(/^https:\/\//);
      expect(n.evidence?.checkedAt).toBe("2026-10-31");
      expect(n.finality.mode).toBe("read-only");
    }
    const fields = Object.keys(PRODUCT_NETWORKS[0]!).sort();
    expect(Object.keys(PRODUCT_NETWORKS[1]!).sort()).toEqual(fields);
    const text = JSON.stringify(productRegistry().networks()).toLowerCase();
    for (const word of ["primary", "preferred", "isdefault", "fallbackchain", "priority"]) {
      expect(text).not.toContain(word);
    }
  });

  test("the full registry separates credit, read and receiving sets", () => {
    const r = productRegistry();
    expect(r.enabledNetworks().map((n) => n.chainId)).toEqual([97, 84532]);
    expect(r.creditableNetworks().map((n) => n.chainId)).toEqual([97, 84532]);
    expect(r.receivableNetworks().map((n) => n.chainId)).toEqual([56, 8453]);
    expect(r.readableNetworks().map((n) => n.chainId)).toEqual([97, 84532, 56, 8453]);
    expect(r.requireReadableNetwork(56).displayName).toBe("BNB Smart Chain");
    expect(r.requireReadableNetwork(8453).displayName).toBe("Base");
  });

  test("a mainnet cannot be enabled, watched or credited, but can be read", () => {
    const r = productRegistry();
    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(() => r.setNetworkEnabled(chainId, true)).toThrow(/mainnet/);
      expect(() => r.requireEnabledNetwork(chainId)).toThrow(/mainnet|read-only/);
      expect(() => r.requireCreditableNetwork(chainId)).toThrow(/mainnet/);
      expect(r.network(chainId)?.enabled).toBe(false);
      expect(r.requireReadableNetwork(chainId).chainId).toBe(chainId);
    }
  });

  test("relabelling a real mainnet as testnet or credit is refused by the document", () => {
    const base = PRODUCT_NETWORKS[1]!;
    const build = (network: Record<string, unknown>) =>
      new NetworkRegistry({ version: 2, networks: [network as never], assets: [] });
    expect(() => build({ ...base, networkType: "testnet" })).toThrow(/relabelling|cannot unlock/);
    expect(() => build({ ...base, support: "credit" })).toThrow(/read-only|credit/);
    expect(() => build({ ...base, enabled: true })).toThrow(/mainnet/);
    expect(() => build({ ...base, networkType: "testnet", support: "credit", enabled: true })).toThrow();
    // Every mainnet is read-only, not only the two hard ids.
    expect(() => build({ ...base, chainId: 999999, support: "credit" })).toThrow(/read-only|credit/);
  });

  test("a mainnet/read-only endpoint must use https", () => {
    const r = productRegistry();
    expect(() => r.setRpcEndpoints(56, ["http://127.0.0.1:8545"])).toThrow(/https/);
    expect(r.setRpcEndpoints(56, ["https://bsc-dataseed.bnbchain.org"]).rpcEndpoints).toEqual(["https://bsc-dataseed.bnbchain.org"]);
    // The testnet local-dev path still accepts http.
    expect(r.setRpcEndpoints(97, ["http://127.0.0.1:8545"]).rpcEndpoints).toEqual(["http://127.0.0.1:8545"]);
  });

  test("the hard chain-id boundary is independent of the registry", () => {
    expect(isMainnetChainId(56)).toBe(true);
    expect(isMainnetChainId(8453)).toBe(true);
    expect(isMainnetChainId(97)).toBe(false);
    expect(isMainnetChainId(84532)).toBe(false);
    expect(MAINNET_BOUNDARY.allowed).toEqual(["read-metadata", "read-balance", "select-receiving"]);
    expect(MAINNET_BOUNDARY.forbidden).toEqual(["send", "credit", "auto-recharge"]);
  });
});

describe("C3 strict asset quadruple and evidence", () => {
  test("Base native USDC is recorded with issuer evidence and no credit rate", () => {
    const a = productRegistry().asset(BASE_USDC_ID)!;
    expect(a.chainId).toBe(8453);
    expect(a.contractAddress.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(a.decimals).toBe(6);
    expect(a.issuerType).toBe("native-issuer");
    expect(a.testnetOnly).toBe(false);
    expect(a.credit).toBe(false);
    expect(a.pricing.kind).toBe("not-creditable");
    expect(a.pricing.nanosPerToken).toBe("0");
    expect(a.evidence?.issuer).toBe("Circle");
    expect(a.evidence?.url).toBe("https://developers.circle.com/stablecoins/usdc-contract-addresses");
    expect(a.evidence?.onchainDecimals).toBe(6);
    expect(a.evidence?.onchainSymbol).toBe("USDC");
  });

  test("BSC USDC is unsupported, not guessed: no record and no readable asset", () => {
    const r = productRegistry();
    expect(r.asset(assetIdOf(56, BSC_USDC))).toBeNull();
    expect(() => r.requireReadableAsset(assetIdOf(56, BSC_USDC))).toThrow(/not registered/);
    expect(() => r.requireEnabledAsset(56, BSC_USDC)).toThrow(/not an allowlisted asset/);
  });

  test("a mainnet asset cannot be registered through the test-asset path", () => {
    const r = productRegistry();
    expect(() =>
      r.registerTestAsset({ chainId: 56, contractAddress: BSC_USDC, symbol: "tUSDC", name: "Mock", decimals: 18, nanosPerToken: "1", pricingNote: "x" }),
    ).toThrow(/mainnet/);
  });

  test("a mainnet asset with a mock issuer, fixed rate, missing evidence or a mismatched quadruple is refused", () => {
    const base = MAINNET_ASSETS[0]!;
    const build = (asset: AssetRecordInput) => new NetworkRegistry({ version: 2, networks: PRODUCT_NETWORKS, assets: [asset] });
    expect(() => build({ ...base, issuerType: "mock" })).toThrow(/mock/);
    expect(() => build({ ...base, pricing: { ...base.pricing, kind: "fixed-test-rate" } })).toThrow(/fixed test rate/);
    expect(() => build({ ...base, pricing: { ...base.pricing, nanosPerToken: "1000000000" } })).toThrow(/USD rate/);
    expect(() => build({ ...base, evidence: null })).toThrow(/evidence/);
    expect(() => build({ ...base, decimals: 18 })).toThrow(/decimals/);
    expect(() => build({ ...base, evidence: { ...base.evidence!, onchainDecimals: 18 } })).toThrow(/decimals/);
    expect(() => build({ ...base, evidence: { ...base.evidence!, onchainContract: BSC_USDC } })).toThrow(/contract/);
    expect(() => build({ ...base, evidence: { ...base.evidence!, onchainChainId: 56 } })).toThrow(/chain/);
    expect(() => build({ ...base, evidence: { ...base.evidence!, url: "http://example.test" } })).toThrow(/https/);
  });

  test("a creditable test asset must stay a mock and keep a fixed test rate", () => {
    const a = v1Asset(97, "0x5FbDB2315678afecb367f032d93F642f64180aa3");
    const base: RegistryDocument = { version: 2, networks: DEFAULT_NETWORKS, assets: [a] };
    expect(() => new NetworkRegistry(base)).not.toThrow();
    expect(() => new NetworkRegistry({ ...base, assets: [{ ...a, issuerType: "native-issuer" }] })).toThrow(/mock/);
    expect(() => new NetworkRegistry({ ...base, assets: [{ ...a, pricing: { ...a.pricing!, kind: "not-creditable" } }] })).toThrow(/fixed test rate/);
  });
});

describe("C1 migration from the version-1 testnet document", () => {
  test("adds read-only mainnets without rewriting old chain ids or enabling anything", () => {
    const path = join(TMP(), "networks.json");
    const old = {
      version: 1,
      networks: [v1Network(97, false), v1Network(84532, true), v1Network(31337, true)],
      assets: [v1Asset(97, "0x5FbDB2315678afecb367f032d93F642f64180aa3")],
    };
    writeFileSync(path, JSON.stringify(old));
    const r = loadRegistry(path);
    expect(r.network(97)!.enabled).toBe(false);
    expect(r.network(97)!.support).toBe("credit");
    expect(r.network(84532)!.enabled).toBe(true);
    expect(r.network(31337)!.enabled).toBe(true);
    expect(r.enabledNetworks().map((n) => n.chainId).sort((a, b) => a - b)).toEqual([31337, 84532]);

    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(r.network(chainId)!.enabled).toBe(false);
      expect(r.network(chainId)!.support).toBe("read-only");
      expect(r.network(chainId)!.receivable).toBe(true);
    }
    expect(r.asset(BASE_USDC_ID)?.credit).toBe(false);
    const oldAsset = r.asset(assetIdOf(97, "0x5FbDB2315678afecb367f032d93F642f64180aa3"))!;
    expect(oldAsset.chainId).toBe(97);
    expect(oldAsset.decimals).toBe(6);
    expect(oldAsset.credit).toBe(true);

    const persisted = JSON.parse(readFileSync(path, "utf8")) as RegistryDocument;
    expect(persisted.version).toBe(2);
    expect(persisted.networks.map((n) => n.chainId)).toEqual([97, 84532, 31337, 56, 8453]);
    // The test asset is unchanged in identity; only the new capability default was added.
    expect(persisted.assets[0]!.assetId).toBe(assetIdOf(97, "0x5FbDB2315678afecb367f032d93F642f64180aa3"));
    expect(persisted.assets[0]!.chainId).toBe(97);

    const again = loadRegistry(path);
    expect(again.network(56)!.enabled).toBe(false);
    expect(again.asset(BASE_USDC_ID)?.credit).toBe(false);
    expect(again.enabledNetworks().map((n) => n.chainId).sort((a, b) => a - b)).toEqual([31337, 84532]);
  });

  test("a version-1 reserved-mainnet record gets evidence but keeps its disabled state", () => {
    const path = join(TMP(), "networks.json");
    const old = {
      version: 1,
      networks: [v1Network(97, true), { ...v1Network(56, false), networkType: "mainnet" as const, displayName: "BNB Smart Chain" }],
      assets: [],
    };
    writeFileSync(path, JSON.stringify(old));
    const r = loadRegistry(path);
    expect(r.network(56)!.enabled).toBe(false);
    expect(r.network(56)!.support).toBe("read-only");
    expect(r.network(56)!.receivable).toBe(true);
    expect(r.network(56)!.evidence?.url).toMatch(/^https:\/\//);
    expect(r.network(8453)!.enabled).toBe(false);
  });

  test("a version-2 document is authoritative: a removed product network is not resurrected", () => {
    const path = join(TMP(), "networks.json");
    writeFileSync(path, JSON.stringify({ version: 2, networks: [v1Network(97, true)], assets: [] }));
    const r = loadRegistry(path);
    expect(r.network(97)!.enabled).toBe(true);
    expect(r.network(56)).toBeNull();
    expect(r.network(8453)).toBeNull();
  });

  test("the seeded document contains both testnets and both read-only mainnets", () => {
    const path = join(TMP(), "networks.json");
    loadRegistry(path);
    const doc = JSON.parse(readFileSync(path, "utf8")) as RegistryDocument;
    expect(doc.version).toBe(2);
    expect(doc.networks.map((n) => n.chainId)).toEqual([97, 84532, 56, 8453]);
    expect(doc.assets.map((a) => a.assetId)).toEqual([BASE_USDC_ID]);
  });
});

describe("C2 receiving-network selection is explicit and independent", () => {
  test("a new provider starts empty and no file is created by reading", () => {
    const dir = TMP();
    const path = join(dir, "receiving-networks.json");
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path });
    expect(p.selection("provider-a").chainIds).toEqual([]);
    expect(p.isSelected("provider-a", 56)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("single BSC, single Base, both, then empty are independent", () => {
    const path = join(TMP(), "receiving-networks.json");
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path });
    expect(p.setSelected("provider-a", 56, true).chainIds).toEqual([56]);
    expect(p.selection("provider-b").chainIds).toEqual([]);
    expect(p.setSelected("provider-b", 8453, true).chainIds).toEqual([8453]);
    expect(p.selection("provider-a").chainIds).toEqual([56]);
    expect(p.setSelected("provider-a", 8453, true).chainIds).toEqual([56, 8453]);
    expect(p.setSelected("provider-a", 56, false).chainIds).toEqual([8453]);
    expect(p.setSelected("provider-a", 8453, false).chainIds).toEqual([]);
    expect(p.selection("provider-b").chainIds).toEqual([8453]);
    // Repeating a no-op does not invent a timestamp or a default.
    expect(p.setSelected("provider-a", 56, false).updatedAt).toBeNull();
  });

  test("selection survives a reload and is not auto-filled", () => {
    const path = join(TMP(), "receiving-networks.json");
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path });
    p.setSelected("provider-a", 56, true);
    const again = new ReceivingNetworkPolicy({ registry: productRegistry(), path });
    expect(again.selection("provider-a").chainIds).toEqual([56]);
    expect(again.selection("provider-b").chainIds).toEqual([]);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.providers["provider-a"].chainIds).toEqual([56]);
    expect(Object.keys(raw.providers)).toEqual(["provider-a"]);
  });

  test("an internal testnet or an unregistered chain cannot be selected", () => {
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path: join(TMP(), "r.json") });
    expect(() => p.setSelected("provider-a", 97, true)).toThrow(/internal test network/);
    expect(() => p.setSelected("provider-a", 84532, true)).toThrow(/internal test network/);
    expect(() => p.setSelected("provider-a", 1, true)).toThrow(/not registered/);
    expect(() => p.setSelected("__proto__", 56, true)).toThrow(/reserved/);
  });

  test("an unreadable or inconsistent selection file is an error, not an empty/default set", () => {
    const dir = TMP();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => new ReceivingNetworkPolicy({ registry: productRegistry(), path: bad })).toThrow(/unreadable/);
    const testnet = join(dir, "testnet.json");
    writeFileSync(testnet, JSON.stringify({ version: 1, providers: { p: { chainIds: [97], updatedAt: "2026-10-31T00:00:00Z" } } }));
    expect(() => new ReceivingNetworkPolicy({ registry: productRegistry(), path: testnet })).toThrow(/internal test network/);
  });

  test("payment requests refuse an unselected chain and a selected mainnet with distinct reasons", () => {
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path: join(TMP(), "r.json") });
    expect(p.paymentRequestVerdict("provider-a", 56)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
    p.setSelected("provider-a", 56, true);
    expect(p.paymentRequestVerdict("provider-a", 56)).toMatchObject({ allowed: false, code: "mainnet-credit-forbidden" });
    expect(p.paymentRequestVerdict("provider-a", 8453)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
    p.setSelected("provider-a", 8453, true);
    expect(p.paymentRequestVerdict("provider-a", 8453)).toMatchObject({ allowed: false, code: "mainnet-credit-forbidden" });
    expect(p.paymentRequestVerdict("provider-a", 97)).toMatchObject({ allowed: false, code: "not-a-product-network" });
    expect(p.paymentRequestVerdict("provider-a", 1)).toMatchObject({ allowed: false, code: "unknown-network" });
  });

  test("event credit is refused for a mainnet before selection can be consulted", () => {
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path: join(TMP(), "r.json") });
    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(() => p.creditVerdict("provider-a", chainId)).toThrow(MainnetGateError);
      expect(() => p.creditVerdict("provider-a", chainId)).toThrow(/mainnet/);
    }
    p.setSelected("provider-a", 56, true);
    expect(() => p.requireCredit("provider-a", 56)).toThrow(/mainnet/);
    expect(p.creditVerdict("provider-a", 97)).toMatchObject({ allowed: false, code: "not-a-product-network" });
  });
});

describe("C9 hard gates: mainnet send/credit/auto-recharge", () => {
  test("the capability matrix is fixed for mainnets and unchanged for testnets", () => {
    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(mainnetCapabilities(chainId)).toEqual({
        "read-metadata": true,
        "read-balance": true,
        "select-receiving": true,
        send: false,
        credit: false,
        "auto-recharge": false,
      });
    }
    expect(mainnetCapabilities(97)).toEqual({
      "read-metadata": true,
      "read-balance": true,
      "select-receiving": true,
      send: true,
      credit: true,
      "auto-recharge": true,
    });
  });

  test("send, credit and auto-recharge refuse both real mainnets from the core", () => {
    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(() => assertNoMainnetSend({ chainId })).toThrow(/mainnet/);
      expect(() => assertNoMainnetCredit({ chainId })).toThrow(/mainnet/);
      expect(() => assertNoMainnetAutoRecharge({ chainId })).toThrow(/mainnet/);
    }
    expect(() => assertNoMainnetSend({ chainId: 97 })).not.toThrow();
    expect(() => assertNoMainnetCredit({ chainId: 97 })).not.toThrow();
    expect(() => assertNoMainnetAutoRecharge({ chainId: 97 })).not.toThrow();
  });

  test("no environment variable can unlock a mainnet", () => {
    process.env.OH_MY_AIHUB_ALLOW_MAINNET = "1";
    process.env.OH_MY_AIHUB_MAINNET_CREDIT = "1";
    process.env.OH_MY_AIHUB_MAINNET_SEND = "1";
    try {
      expect(() => assertNoMainnetCredit({ chainId: 56 })).toThrow(/mainnet/);
      expect(() => assertNoMainnetSend({ chainId: 8453 })).toThrow(/mainnet/);
      expect(() => assertNoMainnetAutoRecharge({ chainId: 56 })).toThrow(/mainnet/);
    } finally {
      delete process.env.OH_MY_AIHUB_ALLOW_MAINNET;
      delete process.env.OH_MY_AIHUB_MAINNET_CREDIT;
      delete process.env.OH_MY_AIHUB_MAINNET_SEND;
    }
  });

  test("a ledger source that claims a mainnet is refused even if a caller reaches the ledger directly", () => {
    for (const source of ["chain:56", "chain:8453", "chain:56:tx", "chain:56/tx", "mainnet:8453"]) {
      expect(() => assertCreditSourceNotMainnet(source)).toThrow(/mainnet/);
    }
    for (const source of ["chain:97", "chain:84532", "simulated", "operator"]) {
      expect(() => assertCreditSourceNotMainnet(source)).not.toThrow();
    }
  });

  test("Wallet cannot issue a mainnet deposit intent or scan a mainnet, and can still read its balance", async () => {
    const { wallet } = walletOnlyProduct();
    expect(wallet.productNetworks().map((n) => n.chainId)).toEqual([56, 8453]);
    expect(wallet.receivingSelection("provider-a").chainIds).toEqual([]);
    const status = wallet.statusLocal();
    expect(status.registry.networks.find((n) => n.chainId === 56)).toMatchObject({ support: "read-only", receivable: true, enabled: false });
    expect(status.registry.assets.find((a) => a.assetId === BASE_USDC_ID)).toMatchObject({ credit: false, pricingKind: "not-creditable", issuerType: "native-issuer" });

    expect(() =>
      wallet.requestIntent({ providerId: "provider-a", consumerId: "c1", chainId: 56, assetId: BASE_USDC_ID, amountRaw: "1" }),
    ).toThrow(/未选择|not selected/);

    wallet.setReceivingNetwork("provider-a", 56, true);
    expect(() =>
      wallet.requestIntent({ providerId: "provider-a", consumerId: "c1", chainId: 56, assetId: BASE_USDC_ID, amountRaw: "1" }),
    ).toThrow(/read-only|mainnet/);

    expect(() => wallet.setReceivingAddress("provider-a", 56, "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6")).toThrow(/mainnet/);
    expect(() => wallet.scanNow(56)).toThrow(/mainnet/);
    wallet.start();
    expect(wallet.runningChains()).toEqual([]);
    wallet.stop();

    const rpc = new FakeReadOnlyRpc({ chainId: 56, nativeBalance: 123n });
    const reading = walletOnlyProduct(TMP(), rpc.fetch);
    const read = await reading.wallet.readOnlyBalance({ chainId: 56, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6" });
    expect(read.chainId).toBe(56);
    expect(read.balanceRaw).toBe("123");
    expect(read.creditEligible).toBe(false);
    expect(read.usdValue).toBeNull();
    reading.wallet.close();
    wallet.close();
  });
});

describe("C9 ledger defence in depth", () => {
  test("the durable ledger refuses a chain:56/8453 credit and keeps testnet sources working", () => {
    const dir = TMP();
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    for (const source of ["chain:56", "chain:8453"]) {
      expect(() => ledger.depositIntent({ id: `d-${source}`, consumerId: "alice", amountNanos: 1, source })).toThrow(/mainnet/);
    }
    const snap = priceSnapshot([{ id: "m", price: { input: 1, output: 1, cache_read: 0, cache_write: 0 } }], ["m"])!;
    ledger.ensureAccount({
      consumerId: "alice",
      keyId: "key-1",
      keyName: "lab",
      price: snap,
      windowSpec: "3650d",
      startAt: "2026-10-30T00:00:00.000Z",
      resetAt: "2036-10-27T00:00:00.000Z",
      openingNanos: usdToNanos(1),
      capNanos: usdToNanos(1),
    });
    expect(ledger.depositIntent({ id: "d-97", consumerId: "alice", amountNanos: 1, source: "chain:97" }).created).toBe(true);
    expect(ledger.depositIntent({ id: "d-sim", consumerId: "alice", amountNanos: 1, source: "simulated" }).created).toBe(true);
    ledger.close();
  });
});

describe("read-only mainnet balances", () => {
  test("Base native ETH and Base USDC are read without a USD value or credit", async () => {
    const r = productRegistry();
    const rpc = new FakeReadOnlyRpc({ chainId: 8453, decimals: 6, symbol: "USDC", balance: 1_234_567n, nativeBalance: 42n });
    const reader = new ReadOnlyChainReader({ registry: r, fetchImpl: rpc.fetch, now: () => new Date("2026-10-31T00:00:00Z") });

    const native = await reader.balance({ chainId: 8453, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6" });
    expect(native.asset).toBeNull();
    expect(native.balanceRaw).toBe("42");
    expect(native.decimals).toBe(18);
    expect(native.creditEligible).toBe(false);
    expect(native.usdValue).toBeNull();
    expect(native.readOnly).toBe(true);

    const token = await reader.balance({ chainId: 8453, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: BASE_USDC_ID });
    expect(token.asset).toMatchObject({ assetId: BASE_USDC_ID, symbol: "USDC", decimals: 6, issuerType: "native-issuer", credit: false });
    expect(token.balanceRaw).toBe("1234567");
    expect(token.balanceTokens).toBe("1.234567");
    expect(token.creditEligible).toBe(false);
    expect(token.usdValue).toBeNull();
    expect(rpc.methods).toContain("eth_chainId");
    expect(rpc.methods).toContain("eth_call");
    // Read-only means exactly these RPCs: no logs, no broadcast, no receipt writes.
    expect(new Set(rpc.methods)).toEqual(new Set(["eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_call"]));
  });

  test("a BSC USDC query is refused because the asset is unsupported", async () => {
    const rpc = new FakeReadOnlyRpc({ chainId: 56 });
    const reader = new ReadOnlyChainReader({ registry: productRegistry(), fetchImpl: rpc.fetch });
    await expect(reader.balance({ chainId: 56, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: assetIdOf(56, BSC_USDC) })).rejects.toThrow(/not registered/);
    expect(rpc.calls).toBe(0);
  });

  test("an asset id from another chain is refused before a balance is returned", async () => {
    const rpc = new FakeReadOnlyRpc({ chainId: 56, decimals: 6, symbol: "USDC", balance: 1n });
    const reader = new ReadOnlyChainReader({ registry: productRegistry(), fetchImpl: rpc.fetch });
    await expect(reader.balance({ chainId: 56, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: BASE_USDC_ID })).rejects.toThrow(/belongs to chain 8453/);
  });

  test("wrong chain id, decimals or symbol is refused before a balance is returned", async () => {
    const address = "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6";
    const wrongChain = new FakeReadOnlyRpc({ chainId: 8453, reportedChainId: 56 });
    await expect(
      new ReadOnlyChainReader({ registry: productRegistry(), fetchImpl: wrongChain.fetch }).balance({ chainId: 8453, address }),
    ).rejects.toThrow(/reports chainId/);

    const wrongDecimals = new FakeReadOnlyRpc({ chainId: 8453, decimals: 18, symbol: "USDC", balance: 1n });
    await expect(
      new ReadOnlyChainReader({ registry: productRegistry(), fetchImpl: wrongDecimals.fetch }).balance({ chainId: 8453, address, assetId: BASE_USDC_ID }),
    ).rejects.toThrow(/decimals/);

    const wrongSymbol = new FakeReadOnlyRpc({ chainId: 8453, decimals: 6, symbol: "USDT", balance: 1n });
    await expect(
      new ReadOnlyChainReader({ registry: productRegistry(), fetchImpl: wrongSymbol.fetch }).balance({ chainId: 8453, address, assetId: BASE_USDC_ID }),
    ).rejects.toThrow(/symbol/);
  });

  test("a disabled testnet is not readable, and the balance word is encoded strictly", async () => {
    const r = productRegistry();
    r.setNetworkEnabled(97, false);
    const rpc = new FakeReadOnlyRpc({ chainId: 97 });
    const reader = new ReadOnlyChainReader({ registry: r, fetchImpl: rpc.fetch });
    await expect(reader.balance({ chainId: 97, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6" })).rejects.toThrow(/disabled/);
    expect(rpc.calls).toBe(0);

    const enabledTestnet = productRegistry();
    const testnetRpc = new FakeReadOnlyRpc({ chainId: 97 });
    await expect(
      new ReadOnlyChainReader({ registry: enabledTestnet, fetchImpl: testnetRpc.fetch }).balance({
        chainId: 97,
        address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6",
      }),
    ).rejects.toThrow(/read-only product networks only/);
    expect(testnetRpc.calls).toBe(0);
    expect(encodeBalanceOf("0x3d80C477021E3FA568e91C73bAEC8E806518D9a6")).toBe(
      "0x70a082310000000000000000000000003d80c477021e3fa568e91c73baec8e806518d9a6",
    );
    expect(() => encodeBalanceOf("0x0")).toThrow(/20-byte/);
  });
});
