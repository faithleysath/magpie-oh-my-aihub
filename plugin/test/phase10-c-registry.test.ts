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
  defaultRegistry,
  simulationRegistry,
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
  mainnetCapabilityAllowed,
  MainnetGateError,
} from "../src/mainnet-gate.ts";
import { ReceivingNetworkPolicy } from "../src/receiving-networks.ts";
import { encodeBalanceOf, ReadOnlyChainReader } from "../src/readonly-balance.ts";
import { EvmClient } from "../src/evm.ts";
import { Wallet } from "../src/wallet.ts";
import { buildIntent } from "../src/deposits.ts";
import { recoverLegacyChainDeposit } from "../src/legacy-recovery.ts";
import { ChainStore } from "../src/chainstore.ts";
import { Ledger } from "../src/ledger.ts";
import { Provisioner } from "../src/provisioner.ts";
import { priceSnapshot, usdToNanos } from "../src/pricing.ts";
import { FakeMagpie, LAB_MODEL } from "./support/fake-magpie.ts";
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


function provisionerLab() {
  const dir = TMP();
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  const magpie = new FakeMagpie();
  const cwd = process.cwd();
  let provisioner: Provisioner;
  try {
    process.chdir(dir);
    provisioner = new Provisioner(magpie as never, {
      ledger,
      prices: async (models) => priceSnapshot(magpie.metas(), models),
      usageLog: () => magpie.logPath,
      drainMs: 0,
      save: () => {},
    });
  } finally {
    process.chdir(cwd);
  }
  return { dir, ledger, magpie, provisioner };
}

describe("C1 production network registry: BSC and Base are peers", () => {
  test("56 and 8453 are equal credit product networks with the same record shape", () => {
    expect(PRODUCT_NETWORKS.map((n) => n.chainId)).toEqual([56, 8453]);
    for (const n of PRODUCT_NETWORKS) {
      expect(n.networkType).toBe("mainnet");
      expect(n.support).toBe("credit");
      expect(n.receivable).toBe(true);
      expect(n.enabled).toBe(true);
      expect(n.rpcQuorum).toBe(2);
      expect(n.finality.mode).toBe("finalized-tag");
      expect(n.evidence).not.toBeNull();
      expect(new Set(n.rpcEndpoints.map((u) => new URL(u).host)).size).toBeGreaterThanOrEqual(2);
    }
  });

  test("the full registry exposes both mainnets as credit and receiving, and both dev testnets as credit", () => {
    const r = productRegistry();
    expect(r.enabledNetworks().map((n) => n.chainId)).toEqual([97, 84532, 56, 8453]);
    expect(r.creditableNetworks().map((n) => n.chainId)).toEqual([97, 84532, 56, 8453]);
    expect(r.receivableNetworks().map((n) => n.chainId)).toEqual([56, 8453]);
    expect(r.readOnlyNetworks().map((n) => n.chainId)).toEqual([]);
  });

  test("a product mainnet needs two distinct RPC hosts and a real finality policy", () => {
    const base = PRODUCT_NETWORKS[1]!;
    expect(() => new NetworkRegistry({ version: 3, networks: [{ ...base, rpcEndpoints: ["https://mainnet.base.org"], rpcQuorum: 2 }], assets: MAINNET_ASSETS })).toThrow(/distinct RPC host/);
    expect(() => new NetworkRegistry({ version: 3, networks: [{ ...base, finality: { ...base.finality, mode: "read-only" } }], assets: MAINNET_ASSETS })).toThrow(/finality|credit/);
  });

  test("relabelling a real mainnet as testnet is refused by the document", () => {
    const base = PRODUCT_NETWORKS[1]!;
    expect(() => new NetworkRegistry({ version: 3, networks: [{ ...base, networkType: "testnet" }], assets: [] })).toThrow(/relabelling|cannot unlock/);
  });

  test("a mainnet endpoint must use https and carry no credentials", () => {
    const base = PRODUCT_NETWORKS[0]!;
    expect(() => new NetworkRegistry({ version: 3, networks: [{ ...base, rpcEndpoints: ["http://bsc.example"] }], assets: MAINNET_ASSETS })).toThrow(/https/);
    expect(() => new NetworkRegistry({ version: 3, networks: [{ ...base, rpcEndpoints: ["https://user:pw@bsc.example"] }], assets: MAINNET_ASSETS })).toThrow(/credentials/);
  });

  test("credit is allowlisted: chain 1 disguised as testnet/credit/enabled is refused", () => {
    const testnet = DEFAULT_NETWORKS[0]!;
    expect(() => new NetworkRegistry({ version: 3, networks: [{ ...testnet, chainId: 1 }], assets: [] })).toThrow(/credit allowlist/);
  });

  test("the chain-id boundary allows send/credit on 56/8453 but never auto-recharge", () => {
    for (const chainId of MAINNET_CHAIN_IDS) {
      const caps = mainnetCapabilities(chainId);
      expect(caps.send).toBe(true);
      expect(caps.credit).toBe(true);
      expect(caps["auto-recharge"]).toBe(false);
      expect(mainnetCapabilityAllowed(chainId, "send")).toBe(true);
      expect(mainnetCapabilityAllowed(chainId, "credit")).toBe(true);
      expect(mainnetCapabilityAllowed(chainId, "auto-recharge")).toBe(false);
      expect(() => assertNoMainnetSend({ chainId })).not.toThrow();
      expect(() => assertNoMainnetCredit({ chainId })).not.toThrow();
      expect(() => assertNoMainnetAutoRecharge({ chainId })).toThrow(MainnetGateError);
    }
    expect(MAINNET_BOUNDARY.allowed).toContain("send");
    expect(MAINNET_BOUNDARY.allowed).toContain("credit");
    expect(MAINNET_BOUNDARY.forbidden).toEqual(["auto-recharge"]);
  });
});

describe("C3 strict asset quadruple and evidence", () => {
  test("Base native USDC is recorded with issuer evidence and a 1 USD credit rate", () => {
    const r = productRegistry();
    const id = assetIdOf(8453, BASE_USDC);
    const a = r.asset(id)!;
    expect(a.chainId).toBe(8453);
    expect(a.contractAddress.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(a.decimals).toBe(6);
    expect(a.issuerType).toBe("native-issuer");
    expect(a.testnetOnly).toBe(false);
    expect(a.credit).toBe(true);
    expect(a.pricing.kind).toBe("stablecoin-usd");
    expect(a.pricing.nanosPerToken).toBe("1000000000");
    expect(a.evidence?.issuer).toBe("Circle");
    expect(a.evidence?.onchainDecimals).toBe(6);
    expect(a.evidence?.onchainSymbol).toBe("USDC");
  });

  test("BSC USDC is the bridged 18-decimal asset, a different identity from Base", () => {
    const r = productRegistry();
    const bsc = r.asset(assetIdOf(56, BSC_USDC))!;
    expect(bsc.decimals).toBe(18);
    expect(bsc.issuerType).toBe("bridged");
    expect(bsc.credit).toBe(true);
    expect(bsc.pricing.kind).toBe("stablecoin-usd");
    expect(bsc.evidence?.issuer).toContain("Binance");
    expect(bsc.assetId).not.toBe(assetIdOf(8453, BASE_USDC));
    expect(bsc.symbol).toBe("USDC");
    expect(r.asset(assetIdOf(8453, BASE_USDC))!.decimals).toBe(6);
  });

  test("a production asset with a mock issuer, a fixed rate, missing evidence or a mismatched quadruple is refused", () => {
    const base = MAINNET_ASSETS[0]!;
    const build = (asset: AssetRecordInput) => new NetworkRegistry({ version: 3, networks: PRODUCT_NETWORKS, assets: [asset] });
    expect(() => build({ ...base, issuerType: "mock" })).toThrow(/mock/);
    expect(() => build({ ...base, pricing: { ...base.pricing, kind: "fixed-test-rate" } })).toThrow(/stablecoin rate/);
    expect(() => build({ ...base, pricing: { ...base.pricing, nanosPerToken: "999999999" } })).toThrow(/exactly 1 USD/);
    expect(() => build({ ...base, evidence: null })).toThrow(/evidence/);
    expect(() => build({ ...base, evidence: { ...base.evidence!, onchainDecimals: 6 } })).toThrow(/decimals/);
    expect(() => build({ ...base, evidence: { ...base.evidence!, onchainContract: BASE_USDC } })).toThrow(/another contract/);
  });

  test("a creditable test asset must stay a mock and keep a fixed test rate", () => {
    const testnet = DEFAULT_NETWORKS[0]!;
    const good = v1Asset(97, "0x" + "9".repeat(40));
    const build = (asset: AssetRecordInput) => new NetworkRegistry({ version: 3, networks: [testnet], assets: [asset] });
    expect(() => build(good)).not.toThrow();
    expect(() => build({ ...good, issuerType: "native-issuer" })).toThrow(/mock/);
    expect(() => build({ ...good, pricing: { ...good.pricing, kind: "stablecoin-usd" } })).toThrow(/fixed test rate/);
  });
});

describe("C1 migration from the version-1/v2 read-only mainnet document", () => {
  test("a v2 document with read-only mainnet records is upgraded to production credit", () => {
    const dir = TMP();
    const path = join(dir, "networks.json");
    const oldMainnets = PRODUCT_NETWORKS.map((n) => ({
      ...n,
      support: "read-only" as const,
      enabled: false,
      rpcQuorum: 1,
      notes: "Read-only product network. No watcher, no ledger credit, no send, no automatic recharge.",
      finality: { ...n.finality, mode: "read-only" as const, confirmations: 0, reorgDepth: 0 },
    }));
    const oldBaseAsset = {
      ...MAINNET_ASSETS[1]!,
      credit: false,
      pricing: { nanosPerToken: "0", version: "not-creditable:8453:usdc:v1", kind: "not-creditable" as const, note: "old" },
    };
    writeFileSync(path, JSON.stringify({ version: 2, networks: [...DEFAULT_NETWORKS, ...oldMainnets], assets: [oldBaseAsset] }));
    const r = loadRegistry(path);
    for (const chainId of [56, 8453]) {
      const n = r.network(chainId)!;
      expect(n.support).toBe("credit");
      expect(n.enabled).toBe(true);
      expect(n.rpcQuorum).toBe(2);
    }
    expect(r.asset(assetIdOf(56, BSC_USDC))!.credit).toBe(true);
    expect(r.asset(assetIdOf(8453, BASE_USDC))!.credit).toBe(true);
    expect(r.asset(assetIdOf(8453, BASE_USDC))!.pricing.kind).toBe("stablecoin-usd");
    // The testnet records are not rewritten or enabled by the migration.
    expect(r.network(97)!.enabled).toBe(true);
    expect(r.network(97)!.networkType).toBe("testnet");
  });

  test("a v2 document is authoritative for an absent product network", () => {
    const dir = TMP();
    const path = join(dir, "networks.json");
    const only56 = PRODUCT_NETWORKS[0]!;
    writeFileSync(path, JSON.stringify({ version: 2, networks: [...DEFAULT_NETWORKS, { ...only56, support: "read-only", enabled: false }], assets: [] }));
    const r = loadRegistry(path);
    expect(r.network(56)!.support).toBe("credit");
    expect(r.network(8453)).toBeNull();
  });

  test("a v2 local lab enabled record is downgraded and cannot be credited", () => {
    const dir = TMP();
    const path = join(dir, "networks.json");
    const local = { ...v1Network(31337, true), networkType: "testnet" as const, support: "credit" as const, receivable: false, rpcQuorum: 1 };
    writeFileSync(path, JSON.stringify({ version: 2, networks: [local], assets: [] }));
    const r = loadRegistry(path);
    expect(r.network(31337)!.enabled).toBe(false);
    expect(r.network(31337)!.notes).toContain("legacy enabled=true");
    expect(r.network(31337)!.notes).toContain("simulation-import-required");
  });

  test("a v2 document cannot smuggle chain 1 in as an enabled testnet", () => {
    const dir = TMP();
    const path = join(dir, "networks.json");
    writeFileSync(path, JSON.stringify({ version: 2, networks: [{ ...v1Network(1, true), networkType: "testnet", support: "credit", receivable: false, rpcQuorum: 1 }], assets: [] }));
    expect(() => loadRegistry(path)).toThrow(/credit allowlist/);
  });

  test("the seeded document contains both credit testnets and both production mainnets", () => {
    const r = productRegistry();
    expect(r.networks().map((n) => n.chainId)).toEqual([97, 84532, 56, 8453]);
    expect(r.allAssets().map((a) => a.assetId).sort()).toEqual([assetIdOf(56, BSC_USDC), assetIdOf(8453, BASE_USDC)].sort());
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
    expect(p.setSelected("provider-a", 56, false).updatedAt).toBeNull();
  });

  test("selection survives a reload and is not auto-filled", () => {
    const path = join(TMP(), "receiving-networks.json");
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path });
    p.setSelected("provider-a", 56, true);
    const again = new ReceivingNetworkPolicy({ registry: productRegistry(), path });
    expect(again.selection("provider-a").chainIds).toEqual([56]);
    expect(again.selection("provider-b").chainIds).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).providers["provider-a"].chainIds).toEqual([56]);
  });

  test("an internal testnet or an unregistered chain cannot be selected", () => {
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path: join(TMP(), "r.json") });
    expect(() => p.setSelected("provider-a", 97, true)).toThrow(/not a product receiving network/);
    expect(() => p.setSelected("provider-a", 84532, true)).toThrow(/not a product receiving network/);
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
    expect(() => new ReceivingNetworkPolicy({ registry: productRegistry(), path: testnet })).toThrow(/not a product receiving network/);
  });

  test("an unselected product chain is refused; a selected BSC or Base request is allowed", () => {
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path: join(TMP(), "r.json") });
    expect(p.paymentRequestVerdict("provider-a", 56)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
    expect(p.paymentRequestVerdict("provider-a", 8453)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
    p.setSelected("provider-a", 56, true);
    expect(p.paymentRequestVerdict("provider-a", 56)).toMatchObject({ allowed: true, code: "allowed" });
    expect(p.paymentRequestVerdict("provider-a", 8453)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
    p.setSelected("provider-a", 8453, true);
    expect(p.paymentRequestVerdict("provider-a", 8453)).toMatchObject({ allowed: true, code: "allowed" });
    expect(p.paymentRequestVerdict("provider-a", 1)).toMatchObject({ allowed: false, code: "unknown-network" });
  });

  test("event credit follows the same explicit selection for both mainnets", () => {
    const p = new ReceivingNetworkPolicy({ registry: productRegistry(), path: join(TMP(), "r.json") });
    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(p.creditVerdict("provider-a", chainId)).toMatchObject({ allowed: false, code: "receiving-network-not-selected" });
      p.setSelected("provider-a", chainId, true);
      expect(p.creditVerdict("provider-a", chainId)).toMatchObject({ allowed: true, code: "allowed" });
      expect(() => p.requireCredit("provider-a", chainId)).not.toThrow();
    }
  });
});

describe("C9 production gates: send/credit allowed, auto-recharge not implemented", () => {
  test("the capability matrix is fixed for the two production chains", () => {
    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(mainnetCapabilities(chainId)).toEqual({
        "read-metadata": true,
        "read-balance": true,
        "select-receiving": true,
        send: true,
        credit: true,
        "auto-recharge": false,
      });
      expect(mainnetCapabilityAllowed(chainId, "send")).toBe(true);
      expect(mainnetCapabilityAllowed(chainId, "credit")).toBe(true);
      expect(mainnetCapabilityAllowed(chainId, "auto-recharge")).toBe(false);
    }
    expect(mainnetCapabilities(97)).toMatchObject({ send: true, credit: true, "auto-recharge": true });
  });

  test("send/credit pass the chain-id layer; auto-recharge is refused; malformed ids fail closed", () => {
    for (const chainId of MAINNET_CHAIN_IDS) {
      expect(() => assertNoMainnetSend({ chainId })).not.toThrow();
      expect(() => assertNoMainnetCredit({ chainId })).not.toThrow();
      expect(() => assertNoMainnetAutoRecharge({ chainId })).toThrow(/auto|not implemented/);
    }
    for (const bad of ["56", 0, -1, 1.5, Number.NaN] as unknown as number[]) {
      expect(() => assertNoMainnetSend({ chainId: bad })).toThrow(/positive integer/);
      expect(() => assertNoMainnetCredit({ chainId: bad })).toThrow(/positive integer/);
    }
  });

  test("Wallet can issue a BSC/Base deposit intent after selecting the receiving network", () => {
    const { wallet } = walletOnlyProduct();
    expect(wallet.productNetworks().map((n) => n.chainId)).toEqual([56, 8453]);
    expect(wallet.receivingSelection("provider-a").chainIds).toEqual([]);
    const status = wallet.statusLocal();
    expect(status.registry.networks.find((n) => n.chainId === 56)).toMatchObject({ support: "credit", receivable: true, enabled: true });
    expect(status.registry.assets.find((a) => a.assetId === BASE_USDC_ID)).toMatchObject({ credit: true, pricingKind: "stablecoin-usd", issuerType: "native-issuer" });

    expect(() =>
      wallet.requestIntent({ providerId: "provider-a", consumerId: "c1", chainId: 56, assetId: assetIdOf(56, BSC_USDC), amountRaw: "1" }),
    ).toThrow(/未选择|not selected/);

    wallet.setReceivingNetwork("provider-a", 56, true);
    wallet.setReceivingAddress("provider-a", 56, "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6");
    const intent = wallet.requestIntent({ providerId: "provider-a", consumerId: "c1", chainId: 56, assetId: assetIdOf(56, BSC_USDC), amountRaw: "1000000000000000000" });
    expect(intent.intent.chainId).toBe(56);
    expect(intent.intent.tokenContract.toLowerCase()).toBe(BSC_USDC.toLowerCase());

    wallet.setReceivingNetwork("provider-a", 8453, true);
    wallet.setReceivingAddress("provider-a", 8453, "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6");
    const base = wallet.requestIntent({ providerId: "provider-a", consumerId: "c1", chainId: 8453, assetId: BASE_USDC_ID, amountRaw: "1500000" });
    expect(base.intent.chainId).toBe(8453);

    expect(wallet.registryView().creditableNetworks().map((n) => n.chainId)).toEqual([56, 8453]);
  });

  test("a ledger source on a production chain is accepted; an unallowlisted chain is refused", () => {
    const dir = TMP();
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    ledger.ensureAccount({
      consumerId: "c1",
      keyId: "k1",
      keyName: "k1",
      price: { version: "v1", body: JSON.stringify({ models: [], prices: {} }), models: [], prices: {} },
      windowSpec: "day",
      startAt: "2026-11-01T00:00:00Z",
      resetAt: "2026-11-02T00:00:00Z",
      openingNanos: 0,
      capNanos: 0,
    });
    for (const [chainId, contract] of [[56, BSC_USDC], [8453, BASE_USDC]] as const) {
      const r = ledger.depositIntent({
        id: `chain-test-${chainId}`,
        consumerId: "c1",
        amountNanos: 1_000_000,
        source: `chain:${chainId}`,
        fundsClass: "chain",
        chainId,
        assetId: assetIdOf(chainId, contract),
      });
      expect(r.created).toBe(true);
    }
    expect(() => ledger.depositIntent({ id: "x1", consumerId: "c1", amountNanos: 1, source: "chain:1", fundsClass: "chain", chainId: 1, assetId: assetIdOf(1, "0x" + "1".repeat(40)) })).toThrow(/allowlist/);
    expect(() => assertCreditSourceNotMainnet("chain:56")).not.toThrow();
  });
});

describe("C9 ledger defence in depth", () => {
  test("a chain deposit on 56/8453 is normal ledger money; a reorg reversal is append-only and idempotent", () => {
    const dir = TMP();
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    ledger.ensureAccount({
      consumerId: "c1",
      keyId: "k1",
      keyName: "k1",
      price: { version: "v1", body: JSON.stringify({ models: [], prices: {} }), models: [], prices: {} },
      windowSpec: "day",
      startAt: "2026-11-01T00:00:00Z",
      resetAt: "2026-11-02T00:00:00Z",
      openingNanos: 0,
      capNanos: 0,
    });
    const dep = ledger.depositIntent({
      id: "chain:56:event-1",
      consumerId: "c1",
      amountNanos: 2_000_000_000,
      source: "chain:56",
      fundsClass: "chain",
      chainId: 56,
      assetId: assetIdOf(56, BSC_USDC),
    });
    expect(dep.created).toBe(true);
    ledger.markDepositApplied("chain:56:event-1", ledger.openWindowFor("c1")!.id, 2_000_000_000);
    expect(ledger.balance("c1").balanceNanos).toBe(2_000_000_000);
    const first = ledger.reverseChainDeposit({ depositId: "chain:56:event-1", consumerId: "c1", reason: "block removed by a reorg" });
    expect(first).toEqual({ reversed: true, amountNanos: 2_000_000_000 });
    const again = ledger.reverseChainDeposit({ depositId: "chain:56:event-1", consumerId: "c1", reason: "block removed by a reorg" });
    expect(again.reversed).toBe(false);
    const balance = ledger.balance("c1");
    expect(balance.depositedNanos).toBe(2_000_000_000);
    expect(balance.reversedNanos).toBe(2_000_000_000);
    expect(balance.balanceNanos).toBe(0);
    expect(ledger.deposit("chain:56:event-1")!.status).toBe("applied");
    expect(() => ledger.reverseChainDeposit({ depositId: "does-not-exist", consumerId: "c1", reason: "x" })).toThrow(/no deposit/);
  });

  test("an overdraft reversal is visible and blocks reactivation until covered", () => {
    const dir = TMP();
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    const price = { version: "v1", body: JSON.stringify({ models: [], prices: {} }), models: [], prices: {} };
    const w = ledger.ensureAccount({ consumerId: "c1", keyId: "k1", keyName: "k1", price, windowSpec: "day", startAt: "2026-11-01T00:00:00Z", resetAt: "2026-11-02T00:00:00Z", openingNanos: 1_000_000, capNanos: 1_000_000 });
    ledger.depositIntent({ id: "chain:8453:e1", consumerId: "c1", amountNanos: 1_000_000, source: "chain:8453", fundsClass: "chain", chainId: 8453, assetId: assetIdOf(8453, BASE_USDC) });
    ledger.markDepositApplied("chain:8453:e1", w.id, 1_000_000);
    ledger.recordAdjustment({ id: "spend-1", consumerId: "c1", windowId: w.id, keyId: "k1", amountNanos: 1_500_000, reason: "test consumption" });
    ledger.reverseChainDeposit({ depositId: "chain:8453:e1", consumerId: "c1", reason: "reorg" });
    expect(ledger.balance("c1").overdraftNanos).toBeGreaterThan(0);
  });
});

describe("funds provenance and pending recovery", () => {
  test("a local top-up cannot use a chain/opening id or reuse a chain ledger row", async () => {
    const { ledger, provisioner } = provisionerLab();
    await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    for (const id of ["chain:synthetic", "Chain:56", "chain :56", "opening:alice", "opening:alice:1"]) {
      await expect(provisioner.topUp("alice", 1, id)).rejects.toThrow(/reserved|local top-up/);
    }
    expect(ledger.deposit("chain:synthetic")).toBeNull();
    const chain = ledger.depositIntent({
      id: "dep-chain",
      consumerId: "alice",
      amountNanos: usdToNanos(1),
      source: "chain:97",
      fundsClass: "chain",
      chainId: 97,
      assetId: "eip155:97:0x6666666666666666666666666666666666666666",
    });
    expect(chain.deposit.fundsClass).toBe("chain");
    await expect(provisioner.topUp("alice", 1, "dep-chain")).rejects.toThrow(/chain deposit|local top-up/);
    ledger.close();
  });

  test("actual money refuses chain 1 and a cross-chain asset before any cap write", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    expect(() =>
      ledger.depositIntent({
        id: "chain:evt-1",
        consumerId: "alice",
        amountNanos: usdToNanos(1),
        source: "chain:1",
        fundsClass: "chain",
        chainId: 1,
        assetId: "eip155:84532:0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/credit allowlist/);
    expect(() =>
      ledger.depositIntent({
        id: "chain:evt-cross",
        consumerId: "alice",
        amountNanos: usdToNanos(1),
        source: "chain:97",
        fundsClass: "chain",
        chainId: 97,
        assetId: "eip155:84532:0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/belongs to chain 84532/);
    expect(ledger.deposit("chain:evt-1")).toBeNull();
    expect(ledger.deposit("chain:evt-cross")).toBeNull();
    const before = magpie.keyByName("ohmyaihub-alice")!.cap;
    await expect(provisioner.applyChainDeposit({ id: "chain:evt-1", consumerId: "alice", amountNanos: usdToNanos(1) })).rejects.toThrow(/not booked/);
    expect(magpie.keyByName("ohmyaihub-alice")!.cap).toBe(before);
    expect(() =>
      ledger.depositIntent({ id: "bad-class", consumerId: "alice", amountNanos: 1, source: "simulated", fundsClass: "bogus" as never }),
    ).toThrow(/known funds class/);
    ledger.close();
  });

  test("a pending chain deposit with a missing ledger row is not re-recorded as simulated", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    magpie.keys.get(view.keyId)!.cap = 2;
    rec.pending = { capUsd: 2, depositId: "chain:missing", usd: 1, fundsClass: "chain", chainId: 97, assetId: "eip155:97:0x6666666666666666666666666666666666666666", source: "chain:97" };
    await expect(provisioner.reconcile(rec)).rejects.toThrow(/missing its ledger row|manual recovery/);
    expect(ledger.deposit("chain:missing")).toBeNull();
    expect(rec.pending).not.toBeNull();
    expect(rec.creditedUsd).toBe(0);
    ledger.close();
  });

  test("a pending manual/simulated deposit restores its same source, never a chain source", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    magpie.keys.get(view.keyId)!.cap = 2;
    rec.pending = { capUsd: 2, depositId: "manual-pending", usd: 1, fundsClass: "simulated", chainId: null, assetId: null, source: "simulated" };
    await provisioner.reconcile(rec);
    expect(ledger.deposit("manual-pending")).toMatchObject({ fundsClass: "simulated", source: "simulated", status: "applied" });
    expect(rec.pending).toBeNull();
    ledger.close();
  });

  test("a pending chain deposit whose ledger row is a different class is refused", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    ledger.depositIntent({ id: "pending-conflict", consumerId: "alice", amountNanos: usdToNanos(1), source: "simulated" });
    magpie.keys.get(view.keyId)!.cap = 2;
    rec.pending = { capUsd: 2, depositId: "pending-conflict", usd: 1, fundsClass: "chain", chainId: 97, assetId: "eip155:97:0x6666666666666666666666666666666666666666", source: "chain:97" };
    await expect(provisioner.reconcile(rec)).rejects.toThrow(/provenance|disagrees/);
    expect(rec.pending).not.toBeNull();
    ledger.close();
  });

  test("reconcile refuses asset/amount mismatches before crediting or raising a cap", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    magpie.keys.get(view.keyId)!.cap = 2;
    ledger.depositIntent({
      id: "chain:mismatch",
      consumerId: "alice",
      amountNanos: usdToNanos(1),
      source: "chain:97",
      fundsClass: "chain",
      chainId: 97,
      assetId: "eip155:97:0x6666666666666666666666666666666666666666",
    });
    rec.pending = {
      capUsd: 2,
      depositId: "chain:mismatch",
      usd: 1,
      fundsClass: "chain",
      chainId: 97,
      assetId: "eip155:97:0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
      source: "chain:97",
    };
    await expect(provisioner.reconcile(rec)).rejects.toThrow(/provenance|asset/);
    expect(rec.creditedUsd).toBe(0);
    expect(rec.pending).not.toBeNull();

    ledger.close();

    // amount mismatch with the same class/chain/asset, on a fresh consumer/key
    const second = provisionerLab();
    const view2 = await second.provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec2 = second.provisioner.find("alice")!;
    second.magpie.keys.get(view2.keyId)!.cap = 2;
    second.ledger.depositIntent({
      id: "chain:amount",
      consumerId: "alice",
      amountNanos: usdToNanos(1),
      source: "chain:97",
      fundsClass: "chain",
      chainId: 97,
      assetId: "eip155:97:0x6666666666666666666666666666666666666666",
    });
    rec2.pending = {
      capUsd: 2,
      depositId: "chain:amount",
      usd: 2,
      fundsClass: "chain",
      chainId: 97,
      assetId: "eip155:97:0x6666666666666666666666666666666666666666",
      source: "chain:97",
    };
    await expect(second.provisioner.reconcile(rec2)).rejects.toThrow(/amount/);
    expect(rec2.creditedUsd).toBe(0);
    expect(rec2.pending).not.toBeNull();
    second.ledger.close();
  });

  test("a pending chain asset-null row with native cap in force is uncertain, not applied", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    const window = ledger.openWindowFor("alice")!;
    const db = (ledger as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.query("INSERT INTO deposits(id,consumer_id,amount_nanos,source,funds_class,chain_id,asset_id,status,window_id,price_version,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "chain:asset-null",
      "alice",
      usdToNanos(1),
      "chain:97",
      "chain",
      97,
      null,
      "intent",
      null,
      null,
      null,
      "2026-10-30T00:00:00.000Z",
      null,
      null,
    );
    magpie.keys.get(view.keyId)!.cap = 2;
    rec.pending = { capUsd: 2, depositId: "chain:asset-null", usd: 1, fundsClass: "chain", chainId: 97, assetId: null, source: "chain:97" };
    await expect(provisioner.reconcile(rec)).rejects.toThrow(/asset|provenance|manual/);
    expect(ledger.deposit("chain:asset-null")?.status).toBe("intent");
    expect(rec.pending).not.toBeNull();
    expect(rec.creditedUsd).toBe(0);
    ledger.close();
  });

  test("a pending chain deposit with native cap in force but missing provenance is not applied", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    magpie.keys.get(view.keyId)!.cap = 2;
    rec.pending = { capUsd: 2, depositId: "chain:no-provenance", usd: 1 };
    await expect(provisioner.reconcile(rec)).rejects.toThrow(/provenance|manual/);
    expect(rec.pending).not.toBeNull();
    expect(rec.creditedUsd).toBe(0);
    ledger.close();
  });

  test("a pending deposit whose ledger row needs review is not applied even with native cap in force", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    const window = ledger.openWindowFor("alice")!;
    const db = (ledger as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.query("INSERT INTO deposits(id,consumer_id,amount_nanos,source,funds_class,chain_id,asset_id,status,window_id,price_version,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "chain:needs-review", "alice", usdToNanos(1), "chain:97", "chain", 97, null, "intent", null, null, null, "2026-10-30T00:00:00.000Z", null, null,
    );
    magpie.keys.get(view.keyId)!.cap = 2;
    rec.pending = { capUsd: 2, depositId: "chain:needs-review", usd: 1, fundsClass: "chain", chainId: 97, assetId: "eip155:97:0x" + "6".repeat(40), source: "chain:97" };
    await expect(provisioner.reconcile(rec)).rejects.toThrow(/review|provenance|asset/);
    expect(ledger.deposit("chain:needs-review")?.status).toBe("intent");
    expect(rec.pending).not.toBeNull();
    expect(rec.creditedUsd).toBe(0);
    ledger.close();
  });

  test("a pending unknown fundsClass is refused before any cap write", async () => {
    const { ledger, provisioner } = provisionerLab();
    await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const rec = provisioner.find("alice")!;
    rec.pending = { capUsd: 2, depositId: "bogus-class", usd: 1, fundsClass: "bogus" as never, source: "simulated" };
    await expect(provisioner.reconcile(rec)).rejects.toThrow(/fundsClass|unknown/);
    expect(rec.pending).not.toBeNull();
    expect(rec.creditedUsd).toBe(0);
    ledger.close();
  });

  test("a legacy unknown-source deposit stays auditable, pauses credit and can be reviewed without rewriting history", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    const view = await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const window = ledger.openWindowFor("alice")!;
    const db = (ledger as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.query("INSERT INTO deposits(id,consumer_id,amount_nanos,source,funds_class,chain_id,asset_id,status,window_id,price_version,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "legacy-unknown",
      "alice",
      usdToNanos(1),
      "operator",
      null,
      null,
      null,
      "applied",
      window.id,
      window.priceVersion,
      usdToNanos(1),
      "2026-10-30T00:00:00.000Z",
      "2026-10-30T00:00:00.000Z",
      null,
    );
    const row = ledger.deposit("legacy-unknown")!;
    expect(row.fundsClass).toBe("unknown");
    expect(row.needsReview).toBe(true);
    expect(ledger.depositsFor("alice").some((d) => d.id === "legacy-unknown")).toBe(true);
    const before = ledger.balance("alice");
    expect(before.depositedNanos).toBe(usdToNanos(2));
    expect(before.unreviewedNanos).toBe(usdToNanos(1));
    expect(before.creditableAvailableNanos).toBe(usdToNanos(1));
    const capBefore = magpie.keyByName("ohmyaihub-alice")!.cap;
    await expect(provisioner.topUp("alice", 1)).rejects.toThrow(/unknown|review/);
    expect(magpie.keyByName("ohmyaihub-alice")?.cap ?? capBefore).toBe(capBefore);
    await expect(provisioner.reissue("alice")).rejects.toThrow(/unknown|review|reissue/);

    expect(() =>
      ledger.reviewDepositProvenance({ id: "legacy-unknown", fundsClass: "chain", chainId: 97, assetId: `eip155:97:0x${"6".repeat(40)}`, note: "do not fabricate chain evidence" }),
    ).toThrow(/ChainStore|chain deposit|relabel/);
    const reviewed = ledger.reviewDepositProvenance({ id: "legacy-unknown", fundsClass: "simulated", note: "legacy operator opening reviewed" });
    expect(reviewed.fundsClass).toBe("simulated");
    expect(reviewed.needsReview).toBe(false);
    expect(reviewed.amountNanos).toBe(usdToNanos(1));
    expect(ledger.balance("alice").depositedNanos).toBe(before.depositedNanos);
    expect(ledger.balance("alice").unreviewedNanos).toBe(0);
    ledger.close();
  });

  test("legacy chain asset-null recovery needs local ChainStore evidence; otherwise it stays readable", async () => {
    const { dir, ledger, provisioner } = provisionerLab();
    await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    const store = new ChainStore(join(dir, "chain.sqlite"));
    const registry = defaultRegistry();
    const contract = `0x${"6".repeat(40)}`;
    const asset = registry.registerTestAsset({ chainId: 97, contractAddress: contract, symbol: "tMOCK6", name: "Mock Six", decimals: 6, nanosPerToken: "1000000000", pricingNote: "1:1" });
    const network = registry.network(97)!;
    const intent = buildIntent({
      request: { providerId: "p", consumerId: "alice", chainId: 97, assetId: asset.assetId, recipientAddress: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", expectedAmountRaw: "1000000", ttlSec: 600 },
      network,
      asset,
      priceVersion: "v1",
      now: new Date("2026-10-31T00:00:00.000Z"),
    });
    intent.payerAddress = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    intent.status = "signed";
    intent.attributionStatus = "signed";
    store.insertIntent(intent);
    const observed = store.observeEvent({
      chainId: 97,
      tokenContract: contract,
      txHash: `0x${"a".repeat(64)}`,
      logIndex: 0,
      blockNumber: 100,
      blockHash: `0x${"b".repeat(64)}`,
      from: intent.payerAddress,
      to: intent.recipientAddress,
      amountRaw: intent.expectedAmountRaw,
      confirmations: 15,
    });
    store.claim({ eventId: observed.event.id, invoiceId: intent.invoiceId });
    store.recordConversion({ id: observed.event.id, nanos: usdToNanos(1), nanosPerToken: "1000000000", priceVersion: "v1" });
    const depositId = `chain:${observed.event.id}`;
    store.markCredited(observed.event.id, depositId);
    const window = ledger.openWindowFor("alice")!;
    const db = (ledger as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.query("INSERT INTO deposits(id,consumer_id,amount_nanos,source,funds_class,chain_id,asset_id,status,window_id,price_version,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      depositId,
      "alice",
      usdToNanos(1),
      "chain:97",
      "chain",
      97,
      null,
      "applied",
      window.id,
      window.priceVersion,
      usdToNanos(1),
      "2026-10-30T00:00:00.000Z",
      "2026-10-30T00:00:00.000Z",
      null,
    );
    // A bare asset patch is refused and does not mutate the row.
    expect(() =>
      (ledger as unknown as { reviewChainDepositProvenance: (input: unknown) => unknown }).reviewChainDepositProvenance({
        id: depositId,
        chainId: 97,
        assetId: asset.assetId,
        note: "bare patch",
      }),
    ).toThrow(/ChainStore|evidence/);
    expect(ledger.deposit(depositId)!.assetId).toBeNull();
    // No evidence/incorrect invoice: no mutation, row remains readable.
    expect(() => recoverLegacyChainDeposit({ ledger, store, evidence: { depositId, chainId: 97, assetId: asset.assetId, invoiceId: "wrong-invoice", txHash: observed.event.txHash, logIndex: 0 } })).toThrow(/claimed|event|invoice/);
    expect(ledger.deposit(depositId)!.assetId).toBeNull();
    expect(ledger.depositsFor("alice").some((d) => d.id === depositId)).toBe(true);
    const recovered = recoverLegacyChainDeposit({ ledger, store, evidence: { depositId, chainId: 97, assetId: asset.assetId, invoiceId: intent.invoiceId, txHash: observed.event.txHash, logIndex: 0 } });
    expect(recovered.assetId).toBe(asset.assetId);
    expect(recovered.amountNanos).toBe(usdToNanos(1));
    expect(recovered.source).toBe("chain:97");
    expect(recovered.status).toBe("applied");
    expect(recovered.fundsClass).toBe("chain");
    const repeated = recoverLegacyChainDeposit({ ledger, store, evidence: { depositId, chainId: 97, assetId: asset.assetId, invoiceId: intent.invoiceId, txHash: observed.event.txHash, logIndex: 0 } });
    expect(repeated.assetId).toBe(asset.assetId);
    expect(repeated.amountNanos).toBe(usdToNanos(1));
    expect(repeated.source).toBe("chain:97");
    expect(repeated.status).toBe("applied");
    store.close();
    ledger.close();
  });

  test("the chain apply path refuses a manual ledger row before touching Magpie", async () => {
    const { ledger, magpie, provisioner } = provisionerLab();
    await provisioner.ensure("alice", { models: [LAB_MODEL], capUsd: 1 });
    ledger.depositIntent({ id: "manual-row", consumerId: "alice", amountNanos: usdToNanos(1), source: "simulated" });
    const before = magpie.keyByName("ohmyaihub-alice")!.cap;
    await expect(provisioner.applyChainDeposit({ id: "manual-row", consumerId: "alice", amountNanos: usdToNanos(1) })).rejects.toThrow(/not chain-derived/);
    expect(magpie.keyByName("ohmyaihub-alice")!.cap).toBe(before);
    ledger.close();
  });
});

describe("read-only RPC transport hardening", () => {
  const jsonReply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });

  test("redirects are refused and the fetch is told not to follow them", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(null, { status: 307, headers: { location: "https://evil.example/rpc" } });
    }) as typeof fetch;
    const client = new EvmClient({ chainId: 56, endpoints: ["https://rpc.example"], fetchImpl });
    await expect(client.verifyChain()).rejects.toThrow(/HTTP 307/);
    expect(seen?.redirect).toBe("error");
  });

  test("an oversized response is refused instead of parsed", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method === "eth_chainId") return jsonReply("0x38");
      return new Response("x".repeat(4096), { status: 200 });
    }) as typeof fetch;
    const client = new EvmClient({ chainId: 56, endpoints: ["https://rpc.example"], fetchImpl, maxResponseBytes: 1024 });
    await client.verifyChain();
    await expect(client.blockNumber()).rejects.toThrow(/exceeds 1024/);
  });

  test("failover verifies the next endpoint before using it, never returns a wrong-chain balance", async () => {
    let bBalanceCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (url === "https://a.example") {
        if (body.method === "eth_chainId") return jsonReply("0x38");
        if (body.method === "eth_getBalance") return new Response("down", { status: 500 });
      }
      if (url === "https://b.example") {
        if (body.method === "eth_chainId") return jsonReply("0x2105");
        if (body.method === "eth_getBalance") {
          bBalanceCalls += 1;
          return jsonReply("0x1");
        }
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const client = new EvmClient({ chainId: 56, endpoints: ["https://a.example", "https://b.example"], fetchImpl });
    await client.verifyChain(); // verifies A only
    await expect(client.call("eth_getBalance", ["0x0000000000000000000000000000000000000001", "latest"])).rejects.toThrow(/reports chainId/);
    expect(bBalanceCalls).toBe(0);
  });
});

describe("read-only product balances", () => {
  test("Base native ETH and Base USDC are read with a face-value USD amount and a positive credit flag", async () => {
    const rpc = new FakeReadOnlyRpc({ chainId: 8453, nativeBalance: 123n, balance: 1_500_000n, decimals: 6, symbol: "USDC" });
    const reg = productRegistry();
    const reader = new ReadOnlyChainReader({ registry: reg, fetchImpl: rpc.fetch });
    const native = await reader.balance({ chainId: 8453, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6" });
    expect(native.nativeSymbol).toBe("ETH");
    expect(native.balanceRaw).toBe("123");
    expect(native.creditEligible).toBe(false);
    const token = await reader.balance({ chainId: 8453, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: BASE_USDC_ID });
    expect(token.asset?.symbol).toBe("USDC");
    expect(token.creditEligible).toBe(true);
    expect(token.usdValue).toBe("1.500000");
    expect(token.readOnly).toBe(true);
  });

  test("BSC bridged USDC is read with 18 decimals and a 1 USD face value", async () => {
    const rpc = new FakeReadOnlyRpc({ chainId: 56, balance: 1_500_000_000_000_000_000n, decimals: 18, symbol: "USDC" });
    const reader = new ReadOnlyChainReader({ registry: productRegistry(), fetchImpl: rpc.fetch });
    const token = await reader.balance({ chainId: 56, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: assetIdOf(56, BSC_USDC) });
    expect(token.asset?.decimals).toBe(18);
    expect(token.creditEligible).toBe(true);
    expect(token.usdValue).toBe("1.500000");
  });

  test("an unregistered asset id, a wrong chain, decimals or symbol is refused before a balance is returned", async () => {
    const reader = (rpc: FakeReadOnlyRpc) => new ReadOnlyChainReader({ registry: productRegistry(), fetchImpl: rpc.fetch });
    await expect(reader(new FakeReadOnlyRpc({ chainId: 8453 })).balance({ chainId: 8453, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: "eip155:1:0x" + "1".repeat(40) })).rejects.toThrow(/not registered/);
    await expect(reader(new FakeReadOnlyRpc({ chainId: 8453, decimals: 18 })).balance({ chainId: 8453, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: BASE_USDC_ID })).rejects.toThrow(/decimals/);
    await expect(reader(new FakeReadOnlyRpc({ chainId: 8453, symbol: "USDX" })).balance({ chainId: 8453, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6", assetId: BASE_USDC_ID })).rejects.toThrow(/symbol/);
    await expect(reader(new FakeReadOnlyRpc({ chainId: 56, reportedChainId: 8453 })).balance({ chainId: 56, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6" })).rejects.toThrow(/chainId/);
  });

  test("a disabled credit chain is not readable and the balance word is encoded strictly", async () => {
    const disabled = new NetworkRegistry({ version: 3, networks: PRODUCT_NETWORKS.map((n) => n.chainId === 56 ? { ...n, enabled: false } : n), assets: MAINNET_ASSETS });
    const reader = new ReadOnlyChainReader({ registry: disabled, fetchImpl: new FakeReadOnlyRpc({ chainId: 56 }).fetch });
    await expect(reader.balance({ chainId: 56, address: "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6" })).rejects.toThrow(/disabled/);
    expect(encodeBalanceOf("0x3d80C477021E3FA568e91C73bAEC8E806518D9a6")).toBe("0x70a082310000000000000000000000003d80c477021e3fa568e91c73baec8e806518d9a6");
    expect(() => encodeBalanceOf("0x1234")).toThrow();
  });
});
