// The network and asset registry: every chain is a record, none is a constant.
//
// The requirement this file exists to satisfy: BSC and Base must be *registered*
// peers, not a hardcoded pair with a primary and a fallback. Adding a third EVM
// chain must be a registry entry, not an edit to the ledger, the deposit state
// machine or the provisioner. So:
//
//  - nothing in this file is named after BSC or Base; the two seeded chains are
//    `DEFAULT_NETWORKS` data, and the same code path accepts any EVM chain.
//  - `NetworkRegistry` has no "default", "primary" or "preferred" chain. A
//    consumer picks; the registry only validates that the pick is enabled.
//  - finality is a per-network policy object, because the chains genuinely
//    differ: measured on 2026-10-30, BSC testnet reports `finalized` == `latest`
//    (one-block BFT finality) while Base Sepolia's `finalized` lags `latest` by
//    ~5000 blocks (~17 min) because it is an L2 whose finality is inherited.
//    A single global confirmation count would either over-credit BSC or
//    needlessly delay Base.
//  - assets are identified by `(chainId, contract)` only. Two chains may both
//    have a token called "USDC" with 6 decimals; they are different assets, and
//    the registry keys them separately. Nothing here ever compares symbols.
//
// Mainnet entries exist so the shape is complete, but `enabled: false` and the
// watcher refuses any network whose `networkType` is not `testnet` until an
// operator explicitly opts in — the phase-7 rule is testnet only.

import { existsSync, readFileSync } from "node:fs";
import { statePath } from "./paths.ts";
import { writeJsonAtomic } from "./store.ts";
import { logger } from "./log.ts";

export type NetworkType = "testnet" | "mainnet";
export type ChainFamily = "evm";

/**
 * How a chain's deposits become irreversible. Every field is measured or chosen
 * per chain, never inherited from another chain.
 */
export interface FinalityPolicy {
  /**
   * Which RPC block tag proves finality. `finalized` is the strongest and is
   * used when the chain's provider really advances it; `confirmations` is the
   * fallback for a chain whose `finalized` tag is a stub (BSC testnet reports
   * `finalized` == `latest`, which proves nothing about depth).
   */
  mode: "finalized-tag" | "confirmations";
  /** used when mode is `confirmations` */
  confirmations: number;
  /**
   * Reorg depth the chain is known to allow. A deposit whose block is this many
   * blocks behind the head is not credited on a confirmations policy, and a
   * finalized-tag policy additionally requires the tag to have passed it.
   */
  reorgDepth: number;
  /** why this number, so a later reader does not have to guess */
  rationale: string;
  /** measured on the pinned date, for the validation report */
  measured?: {
    at: string;
    finalizedLagBlocks: number | null;
    blockTimeSec: number | null;
    source: string;
  };
}

export interface NetworkRecord {
  chainId: number;
  displayName: string;
  family: ChainFamily;
  networkType: NetworkType;
  /** ordered; the first healthy one is used and the rest are fallbacks */
  rpcEndpoints: string[];
  blockExplorer: string;
  nativeSymbol: string;
  enabled: boolean;
  finality: FinalityPolicy;
  /** seconds between scans while healthy */
  scanIntervalSec: number;
  /** how many blocks one `eth_getLogs` page may cover */
  maxBlockRange: number;
  /** the deployment the operator trusts for this chain, if any */
  notes: string | null;
}

export interface AssetRecord {
  /** `eip155:<chainId>:<contract>` — the only identity a deposit may use */
  assetId: string;
  chainId: number;
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  issuerType: "mock" | "native-issuer" | "bridged";
  testnetOnly: boolean;
  enabled: boolean;
  /**
   * How one raw unit becomes the ledger's nano-USD. A fixed test rate is
   * recorded as a version so a later change cannot silently reprice history.
   */
  pricing: AssetPricing;
}

export interface AssetPricing {
  /** nano-USD per whole token, as an integer string (bigint-safe) */
  nanosPerToken: string;
  version: string;
  /** `fixed-test-rate` for the phase-7 mock tokens */
  kind: "fixed-test-rate";
  note: string;
}

export const NETWORK_REGISTRY_VERSION = 1;

/** ISO date of the measurements behind `DEFAULT_NETWORKS`. */
export const MEASURED_AT = "2026-10-30";

/**
 * The seeded chains. Both are first-class: same shape, same code path, both
 * enabled, neither ordered before the other for any business reason. The array
 * order is only the order the status page prints them.
 */
export const DEFAULT_NETWORKS: NetworkRecord[] = [
  {
    chainId: 97,
    displayName: "BNB Smart Chain Testnet",
    family: "evm",
    networkType: "testnet",
    rpcEndpoints: [
      "https://bsc-testnet-rpc.publicnode.com",
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      "https://97.rpc.thirdweb.com",
    ],
    blockExplorer: "https://testnet.bscscan.com",
    nativeSymbol: "tBNB",
    enabled: true,
    finality: {
      // Measured 2026-10-30: `finalized` == `latest` on every endpoint tried
      // (publicnode, bnbchain seed, thirdweb), so the tag carries no depth
      // information on this chain. BSC's own consensus finalises in one block
      // (Parlia BFT), but the testnet RPCs do not expose a lagging tag, so a
      // depth policy is what can actually be verified. 15 blocks ≈ 6.6 s at the
      // measured 0.44 s block time; it is a depth that no observed testnet reorg
      // exceeded, and it is stated as a choice rather than as a chain guarantee.
      mode: "confirmations",
      confirmations: 15,
      reorgDepth: 15,
      rationale:
        "BSC testnet RPCs report finalized == latest, so the tag proves nothing. Parlia BFT gives one-block finality in principle; 15 blocks of depth is the conservative, verifiable substitute.",
      measured: { at: MEASURED_AT, finalizedLagBlocks: 0, blockTimeSec: 0.44, source: "publicnode/bnbchain-seed/thirdweb eth_getBlockByNumber(finalized)" },
    },
    scanIntervalSec: 5,
    maxBlockRange: 2000,
    notes: "Testnet only. Mainnet 56 is not registered in this phase.",
  },
  {
    chainId: 84532,
    displayName: "Base Sepolia",
    family: "evm",
    networkType: "testnet",
    rpcEndpoints: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.gateway.tenderly.co"],
    blockExplorer: "https://sepolia.basescan.org",
    nativeSymbol: "ETH",
    enabled: true,
    finality: {
      // Measured 2026-10-30: `finalized` lags `latest` by ~5,100-7,200 blocks
      // (~17-24 min at the measured 0.2 s block time) and the value agrees
      // across three independent providers. That is the L2's inherited L1
      // finality, so the tag is meaningful here and is used directly.
      mode: "finalized-tag",
      confirmations: 0,
      reorgDepth: 0,
      rationale:
        "Base is an L2: its `finalized` tag tracks L1 finality and lags ~17 min, and three providers agree on it. Waiting for the tag is the real condition, so a block count would only be a guess.",
      measured: { at: MEASURED_AT, finalizedLagBlocks: 5093, blockTimeSec: 0.2, source: "sepolia.base.org/publicnode/tenderly eth_getBlockByNumber(finalized)" },
    },
    scanIntervalSec: 12,
    maxBlockRange: 2000,
    notes: "Testnet only. Mainnet 8453 is not registered in this phase.",
  },
];

/**
 * Mainnet records, kept for shape completeness and **always disabled**. They are
 * never merged into the enabled set: `defaultRegistry()` filters them out and
 * the watcher refuses a mainnet network outright.
 */
export const RESERVED_MAINNETS: NetworkRecord[] = [
  {
    chainId: 56,
    displayName: "BNB Smart Chain",
    family: "evm",
    networkType: "mainnet",
    rpcEndpoints: [],
    blockExplorer: "https://bscscan.com",
    nativeSymbol: "BNB",
    enabled: false,
    finality: { mode: "confirmations", confirmations: 15, reorgDepth: 15, rationale: "reserved; not measured in this phase" },
    scanIntervalSec: 5,
    maxBlockRange: 2000,
    notes: "Reserved. Disabled: phase 7 does not watch or credit any mainnet asset.",
  },
  {
    chainId: 8453,
    displayName: "Base",
    family: "evm",
    networkType: "mainnet",
    rpcEndpoints: [],
    blockExplorer: "https://basescan.org",
    nativeSymbol: "ETH",
    enabled: false,
    finality: { mode: "finalized-tag", confirmations: 0, reorgDepth: 0, rationale: "reserved; not measured in this phase" },
    scanIntervalSec: 12,
    maxBlockRange: 2000,
    notes: "Reserved. Disabled: phase 7 does not watch or credit any mainnet asset.",
  },
];

/** `eip155:<chainId>:<contract>` in lower case, the only asset identity used. */
export function assetIdOf(chainId: number, contract: string): string {
  return `eip155:${chainId}:${contract.toLowerCase()}`;
}

export function isAssetId(value: unknown): value is string {
  return typeof value === "string" && /^eip155:\d+:0x[0-9a-f]{40}$/.test(value);
}

export interface RegistryDocument {
  version: number;
  networks: NetworkRecord[];
  assets: AssetRecord[];
}

export function registryPath(): string {
  return statePath("networks.json");
}

/**
 * The registry: a validated view over the persisted document.
 *
 * Nothing here reaches the network. Chain health is the watcher's business; this
 * only decides what is *configured*, which is what the ledger and the deposit
 * state machine are allowed to consult.
 */
export class NetworkRegistry {
  private nets: NetworkRecord[];
  private assets: AssetRecord[];
  private readonly save: ((doc: RegistryDocument) => void) | null;

  constructor(doc: RegistryDocument, save?: (doc: RegistryDocument) => void) {
    this.nets = doc.networks.map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
    this.assets = doc.assets.map((a) => ({ ...a }));
    this.save = save ?? null;
    this.validate();
  }

  private validate(): void {
    const seen = new Set<number>();
    for (const n of this.nets) {
      if (!Number.isInteger(n.chainId) || n.chainId <= 0) throw new Error(`a network needs a positive integer chainId, got ${n.chainId}`);
      if (seen.has(n.chainId)) throw new Error(`chain ${n.chainId} is registered twice`);
      seen.add(n.chainId);
      if (n.family !== "evm") throw new Error(`chain ${n.chainId}: only evm is implemented in this phase`);
      if (n.enabled && n.rpcEndpoints.length === 0) throw new Error(`chain ${n.chainId} is enabled without an RPC endpoint`);
      if (n.enabled && n.networkType === "mainnet") {
        throw new Error(`chain ${n.chainId} is mainnet; this phase does not watch or credit mainnet assets`);
      }
      if (n.finality.mode === "confirmations" && n.finality.confirmations <= 0) {
        throw new Error(`chain ${n.chainId} uses a confirmations policy with no confirmations`);
      }
      if (!Number.isInteger(n.maxBlockRange) || n.maxBlockRange <= 0) throw new Error(`chain ${n.chainId} needs a positive maxBlockRange`);
    }
    const ids = new Set<string>();
    for (const a of this.assets) {
      if (a.assetId !== assetIdOf(a.chainId, a.contractAddress)) {
        throw new Error(`asset ${a.assetId} does not match its chain and contract`);
      }
      if (ids.has(a.assetId)) throw new Error(`asset ${a.assetId} is registered twice`);
      ids.add(a.assetId);
      if (!seen.has(a.chainId)) throw new Error(`asset ${a.assetId} names an unregistered chain`);
      if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 36) throw new Error(`asset ${a.assetId} has an unusable decimals value`);
      if (a.enabled && a.testnetOnly) {
        const net = this.nets.find((n) => n.chainId === a.chainId)!;
        if (net.networkType !== "testnet") throw new Error(`asset ${a.assetId} is testnet-only but its chain is not a testnet`);
      }
    }
  }

  private persist(): void {
    this.save?.({ version: NETWORK_REGISTRY_VERSION, networks: this.nets, assets: this.assets });
  }

  /** Every registered network, enabled or not, in registration order. */
  networks(): NetworkRecord[] {
    return this.nets.map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  /** Only the networks a deposit may currently name. Order carries no priority. */
  enabledNetworks(): NetworkRecord[] {
    return this.nets.filter((n) => n.enabled).map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  network(chainId: number): NetworkRecord | null {
    const n = this.nets.find((x) => x.chainId === chainId);
    return n ? { ...n, rpcEndpoints: [...n.rpcEndpoints] } : null;
  }

  /** Throws unless this chain may be watched right now. */
  requireEnabledNetwork(chainId: number): NetworkRecord {
    const n = this.network(chainId);
    if (!n) throw new Error(`chain ${chainId} is not registered`);
    if (!n.enabled) throw new Error(`chain ${chainId} (${n.displayName}) is disabled`);
    if (n.networkType === "mainnet") throw new Error(`chain ${chainId} is mainnet; this phase credits testnets only`);
    if (n.rpcEndpoints.length === 0) throw new Error(`chain ${chainId} has no RPC endpoint`);
    return n;
  }

  setNetworkEnabled(chainId: number, enabled: boolean): NetworkRecord {
    const n = this.nets.find((x) => x.chainId === chainId);
    if (!n) throw new Error(`chain ${chainId} is not registered`);
    if (enabled && n.networkType === "mainnet") throw new Error(`chain ${chainId} is mainnet and cannot be enabled in this phase`);
    if (enabled && n.rpcEndpoints.length === 0) throw new Error(`chain ${chainId} has no RPC endpoint to enable it with`);
    n.enabled = enabled;
    this.validate();
    this.persist();
    return { ...n, rpcEndpoints: [...n.rpcEndpoints] };
  }

  setRpcEndpoints(chainId: number, endpoints: string[]): NetworkRecord {
    const n = this.nets.find((x) => x.chainId === chainId);
    if (!n) throw new Error(`chain ${chainId} is not registered`);
    const clean = endpoints.map((e) => e.trim()).filter(Boolean);
    for (const e of clean) {
      let u: URL;
      try {
        u = new URL(e);
      } catch {
        throw new Error(`${e} is not a URL`);
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${e} must be http or https`);
    }
    if (n.enabled && clean.length === 0) throw new Error(`chain ${chainId} is enabled; it needs at least one endpoint`);
    n.rpcEndpoints = clean;
    this.validate();
    this.persist();
    return { ...n, rpcEndpoints: [...clean] };
  }

  /** Assets of one chain, enabled or not. */
  assetsForChain(chainId: number): AssetRecord[] {
    return this.assets.filter((a) => a.chainId === chainId).map((a) => ({ ...a }));
  }

  /** The assets a deposit may name right now. */
  enabledAssets(): AssetRecord[] {
    return this.assets.filter((a) => a.enabled && this.network(a.chainId)?.enabled === true).map((a) => ({ ...a }));
  }

  asset(assetId: string): AssetRecord | null {
    const a = this.assets.find((x) => x.assetId === assetId);
    return a ? { ...a } : null;
  }

  /**
   * The asset a `(chainId, contract)` pair names, refusing anything not in the
   * allowlist. Contract comparison is case-insensitive but chain comparison is
   * exact: the same contract address on two chains is two assets.
   */
  requireEnabledAsset(chainId: number, contract: string): AssetRecord {
    const id = assetIdOf(chainId, contract);
    const a = this.asset(id);
    if (!a) throw new Error(`${contract} is not an allowlisted asset on chain ${chainId}`);
    if (!a.enabled) throw new Error(`asset ${a.symbol} on chain ${chainId} is disabled`);
    const n = this.network(chainId);
    if (!n?.enabled) throw new Error(`chain ${chainId} is not enabled, so ${a.symbol} cannot be credited`);
    return a;
  }

  upsertAsset(asset: AssetRecord): AssetRecord {
    if (asset.assetId !== assetIdOf(asset.chainId, asset.contractAddress)) throw new Error("an asset id must be eip155:<chain>:<contract>");
    const i = this.assets.findIndex((a) => a.assetId === asset.assetId);
    if (i >= 0) this.assets[i] = { ...asset };
    else this.assets.push({ ...asset });
    this.validate();
    this.persist();
    return { ...asset };
  }

  setAssetEnabled(assetId: string, enabled: boolean): AssetRecord {
    const a = this.assets.find((x) => x.assetId === assetId);
    if (!a) throw new Error(`no asset ${assetId}`);
    a.enabled = enabled;
    this.validate();
    this.persist();
    return { ...a };
  }

  /**
   * Registers a newly deployed test token after the on-chain `decimals()` has
   * been read and matched. `decimals` here must be the value the contract
   * reported, not the value the operator expected.
   */
  registerTestAsset(input: {
    chainId: number;
    contractAddress: string;
    symbol: string;
    name: string;
    decimals: number;
    nanosPerToken: string;
    pricingNote: string;
  }): AssetRecord {
    const net = this.requireEnabledNetwork(input.chainId);
    if (net.networkType !== "testnet") throw new Error("only a testnet asset can be registered in this phase");
    if (!/^[A-Za-z0-9 ._-]{1,32}$/.test(input.symbol)) throw new Error("a mock token symbol must be short plain text");
    if (!/^(Mock|Test|t)/i.test(input.symbol) && !/mock|test/i.test(input.name)) {
      throw new Error(`refusing to register ${input.symbol}: a test token's symbol or name must say it is a mock or test token`);
    }
    return this.upsertAsset({
      assetId: assetIdOf(input.chainId, input.contractAddress),
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      symbol: input.symbol,
      name: input.name,
      decimals: input.decimals,
      issuerType: "mock",
      testnetOnly: true,
      enabled: true,
      pricing: {
        nanosPerToken: input.nanosPerToken,
        version: `fixed:${input.chainId}:${input.symbol}:${input.nanosPerToken}:v1`,
        kind: "fixed-test-rate",
        note: input.pricingNote,
      },
    });
  }
}

/**
 * Loads the registry, seeding the two testnets on first use.
 *
 * An existing file is authoritative: a chain the operator disabled stays
 * disabled, and a seeded default is never silently re-enabled.
 */
export function loadRegistry(path = registryPath()): NetworkRegistry {
  if (existsSync(path)) {
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as RegistryDocument;
      return new NetworkRegistry(doc, (d) => writeJsonAtomic(path, d));
    } catch (e) {
      throw new Error(`the network registry at ${path} is unreadable: ${String((e as Error).message ?? e)}`);
    }
  }
  const doc: RegistryDocument = { version: NETWORK_REGISTRY_VERSION, networks: DEFAULT_NETWORKS, assets: [] };
  const reg = new NetworkRegistry(doc, (d) => writeJsonAtomic(path, d));
  try {
    writeJsonAtomic(path, doc);
  } catch (e) {
    logger.warn(`cannot persist the seeded network registry yet: ${String(e)}`);
  }
  return reg;
}

/** An in-memory registry for tests and for a node that has not written state yet. */
export function defaultRegistry(): NetworkRegistry {
  return new NetworkRegistry({ version: NETWORK_REGISTRY_VERSION, networks: DEFAULT_NETWORKS, assets: [] });
}
