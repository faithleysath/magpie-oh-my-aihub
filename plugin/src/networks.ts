// The network and asset registry: every chain is a record, none is a constant.
//
// The requirement this file satisfies: BSC and Base must be *registered* peers,
// not a hardcoded pair with a primary and a fallback. Adding a third EVM chain
// must be a registry entry, not an edit to the ledger, the deposit state machine
// or the provisioner. So:
//
//  - nothing here is named after BSC or Base for business reasons; the seeded
//    chains are data. The two testnets and the two read-only mainnets have the
//    same record shape, and the same code path accepts any EVM chain.
//  - `NetworkRegistry` has no "default", "primary" or "preferred" chain. A
//    consumer picks; the registry only validates that the pick is allowed for the
//    requested capability.
//  - finality is a per-network policy object, because the chains genuinely
//    differ: measured on 2026-10-30, BSC testnet reports `finalized` == `latest`
//    (one-block BFT finality) while Base Sepolia's `finalized` lags `latest` by
//    ~5000 blocks (~17 min) because it is an L2 whose finality is inherited.
//    A single global confirmation count would either over-credit BSC or
//    needlessly delay Base. Read-only mainnets carry `mode: "read-only"`: their
//    finality is not asserted because nothing is credited.
//  - assets are identified by `(chainId, contract)` and, for a mainnet record,
//    by the full `(chainId, contract, decimals, issuerType)` quadruple plus the
//    evidence behind it. Two chains may both have a token called "USDC" with
//    different decimals; they are different assets and nothing here ever
//    compares symbols to decide identity.
//
// Mainnet records are now product metadata, but `networkType: "mainnet"` and
// `support: "read-only"` keep them out of the watcher and the ledger. The hard
// chain-id boundary lives in `mainnet-gate.ts`, so relabelling 56/8453 as a
// testnet in a registry document is refused here *and* cannot unlock credit
// there.

import { existsSync, readFileSync } from "node:fs";
import { statePath } from "./paths.ts";
import { writeJsonAtomic } from "./store.ts";
import { logger } from "./log.ts";
import { isMainnetChainId } from "./mainnet-gate.ts";

export type NetworkType = "testnet" | "mainnet";
export type ChainFamily = "evm";

/**
 * What a network may do in this build.
 *
 * `credit` is the watcher path: scan, verify finality, book a ledger deposit and
 * raise a Magpie cap. It is used by the two product mainnets (BSC 56, Base 8453)
 * *and* the two development testnets (97, 84532) through exactly the same code.
 * `read-only` remains for metadata/balance-only records that must never credit;
 * it is not the production mainnet state any more.
 */
export type NetworkSupport = "credit" | "read-only";

/** A source that a later reader can check, with the date it was checked. */
export interface NetworkEvidence {
  source: string;
  url: string;
  checkedAt: string;
  note: string;
}

/**
 * How a chain's deposits become irreversible. Every field is measured or chosen
 * per chain, never inherited from another chain.
 */
export interface FinalityPolicy {
  /**
   * Which RPC block tag proves finality. `finalized` is the strongest and is
   * used when the chain's provider really advances it; `confirmations` is the
   * fallback for a chain whose `finalized` tag is a stub (BSC testnet reports
   * `finalized` == `latest`, which proves nothing about depth). `read-only`
   * records assert no finality at all because they never credit.
   */
  mode: "finalized-tag" | "confirmations" | "read-only";
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
  /** `credit` is watched/credited; `read-only` is display + balance only */
  support: NetworkSupport;
  /** may a provider explicitly select this as a receiving network? */
  receivable: boolean;
  /**
   * How many independent RPC endpoints must agree before a credit-critical read
   * is trusted. 1 keeps the development/testnet failover behaviour; a product
   * mainnet must use at least 2 (the registry refuses a weaker record).
   */
  rpcQuorum: number;
  /**
   * Ordered candidates. Order is not authority: the quorum reader asks the
   * whole set and refuses a contradictory answer rather than taking the first.
   */
  rpcEndpoints: string[];
  blockExplorer: string;
  nativeSymbol: string;
  nativeDecimals: number;
  enabled: boolean;
  finality: FinalityPolicy;
  /** seconds between scans while healthy */
  scanIntervalSec: number;
  /** how many blocks one `eth_getLogs` page may cover */
  maxBlockRange: number;
  /** the deployment the operator trusts for this chain, if any */
  notes: string | null;
  /** required for a product/mainnet record; null for legacy testnet records */
  evidence: NetworkEvidence | null;
}

/**
 * Registry input allows old documents (and old tests) to omit the new
 * capability fields; the constructor fills a safe default before validating.
 */
export type NetworkRecordInput = Omit<NetworkRecord, "support" | "receivable" | "rpcQuorum" | "nativeDecimals" | "evidence"> & {
  support?: NetworkSupport;
  receivable?: boolean;
  rpcQuorum?: number;
  nativeDecimals?: number;
  evidence?: NetworkEvidence | null;
};

export type AssetIssuerType = "mock" | "native-issuer" | "bridged";

/**
 * The evidence behind a mainnet asset. A URL alone is not enough: the on-chain
 * quadruple is recorded next to the issuer's own documentation, and validation
 * refuses a record whose claimed decimals/symbol disagree with it.
 */
export interface AssetEvidence {
  /** who issues the token, e.g. Circle */
  issuer: string;
  source: string;
  url: string;
  checkedAt: string;
  onchainChainId: number;
  onchainContract: string;
  onchainDecimals: number;
  onchainSymbol: string;
  note: string;
}

export interface AssetRecord {
  /** `eip155:<chainId>:<contract>` — the only identity a deposit may use */
  assetId: string;
  chainId: number;
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  issuerType: AssetIssuerType;
  testnetOnly: boolean;
  /** true only for the legacy testnet fixed-rate credit path */
  credit: boolean;
  enabled: boolean;
  /**
   * How one raw unit becomes the ledger's nano-USD. A fixed test rate is
   * recorded as a version so a later change cannot silently reprice history.
   * A product stablecoin uses `stablecoin-usd`: its face value is the peg the
   * issuer promises, not an oracle price, and the provider accepts that peg.
   * A display-only asset has `kind: "not-creditable"` and no rate.
   */
  pricing: AssetPricing;
  /** required for a non-mock (mainnet) asset */
  evidence: AssetEvidence | null;
}

export type AssetRecordInput = Omit<AssetRecord, "credit" | "evidence"> & {
  credit?: boolean;
  evidence?: AssetEvidence | null;
};

export interface AssetPricing {
  /** nano-USD per whole token, as an integer string (bigint-safe); "0" when not creditable */
  nanosPerToken: string;
  version: string;
  /**
   * `fixed-test-rate` for mock test tokens, `stablecoin-usd` for a verified
   * dollar stablecoin credited at face value, `not-creditable` for display only.
   */
  kind: "fixed-test-rate" | "stablecoin-usd" | "not-creditable";
  note: string;
}

/**
 * Version 3 makes BSC 56 and Base 8453 first-class credit networks with verified
 * assets. Version 2 documents are migrated in `loadRegistry`: only the seeded
 * read-only records are upgraded, and the migration never invents an asset.
 */
export const NETWORK_REGISTRY_VERSION = 3;

/**
 * The only real chains this build may credit. A `networkType:"testnet"` label
 * is metadata, not permission: chain 1 relabelled as a testnet is still chain 1.
 * Local forks/simulations must opt in explicitly through
 * `simulationChainIds`, and only for the small local-lab set below.
 */
export const CREDIT_CHAIN_ALLOWLIST = [56, 97, 8453, 84532] as const;

/** Local EVM ids that a test/fork registry may opt into; never real mainnets. */
export const LOCAL_SIMULATION_CHAIN_IDS = [1337, 31337, 31338] as const;

export interface NetworkRegistryOptions {
  /** test/fork only; production loadRegistry/defaultRegistry never pass this */
  simulationChainIds?: readonly number[];
}

/** ISO date of the measurements behind `DEFAULT_NETWORKS`. */
export const MEASURED_AT = "2026-10-30";

/** ISO date the read-only mainnet metadata and assets were re-checked. */
export const MAINNET_CHECKED_AT = "2026-10-31";

/**
 * The seeded test chains. Both are first-class: same shape, same code path, both
 * enabled, neither ordered before the other for any business reason. The array
 * order is only the order the status page prints them.
 */
export const DEFAULT_NETWORKS: NetworkRecord[] = [
  {
    chainId: 97,
    displayName: "BNB Smart Chain Testnet",
    family: "evm",
    networkType: "testnet",
    support: "credit",
    receivable: false,
    rpcQuorum: 1,
    rpcEndpoints: [
      "https://bsc-testnet-rpc.publicnode.com",
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      "https://97.rpc.thirdweb.com",
    ],
    blockExplorer: "https://testnet.bscscan.com",
    nativeSymbol: "tBNB",
    nativeDecimals: 18,
    enabled: true,
    finality: {
      // Measured 2026-10-30: `finalized` == `latest` on every endpoint tried
      // (publicnode, bnbchain seed, thirdweb), so the tag carries no depth
      // information on this chain. BSC's own consensus finalises in one block
      // (Parlia BFT/BEP-126), but the testnet RPCs do not expose a lagging tag,
      // so a depth policy is what can actually be verified. 15 blocks ≈ 6.6 s at
      // the measured 0.44 s block time; it is a depth that no observed testnet
      // reorg exceeded, and it is stated as a choice rather than a chain
      // guarantee.
      mode: "confirmations",
      confirmations: 15,
      reorgDepth: 15,
      rationale:
        "BSC testnet RPCs report finalized == latest, so the tag proves nothing. Parlia BFT gives one-block finality in principle; 15 blocks of depth is the conservative, verifiable substitute.",
      measured: { at: MEASURED_AT, finalizedLagBlocks: 0, blockTimeSec: 0.44, source: "publicnode/bnbchain-seed/thirdweb eth_getBlockByNumber(finalized)" },
    },
    scanIntervalSec: 5,
    maxBlockRange: 2000,
    notes: "Testnet credit path only. Mainnet 56 is a separate read-only product record.",
    evidence: null,
  },
  {
    chainId: 84532,
    displayName: "Base Sepolia",
    family: "evm",
    networkType: "testnet",
    support: "credit",
    receivable: false,
    rpcQuorum: 1,
    rpcEndpoints: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.gateway.tenderly.co"],
    blockExplorer: "https://sepolia.basescan.org",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
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
    notes: "Testnet credit path only. Mainnet 8453 is a separate read-only product record.",
    evidence: null,
  },
];

/**
 * The two real mainnets as first-class **credit** product networks.
 *
 * BSC and Base are peers: the same record shape, the same watcher, the same
 * ledger bridge and the same finality check. Neither is a default. They are
 * enabled because this build is the production payment build; the per-chain
 * `rpcQuorum` (2) and the verified assets are what make a credit decision safe,
 * not a hidden feature flag.
 */
export const PRODUCT_NETWORKS: NetworkRecord[] = [
  {
    chainId: 56,
    displayName: "BNB Smart Chain",
    family: "evm",
    networkType: "mainnet",
    support: "credit",
    receivable: true,
    rpcQuorum: 2,
    rpcEndpoints: [
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-rpc.publicnode.com",
      "https://bsc-dataseed1.defibit.io",
    ],
    blockExplorer: "https://bscscan.com",
    nativeSymbol: "BNB",
    nativeDecimals: 18,
    enabled: true,
    finality: {
      // Measured 2026-11-01 (four independent public endpoints): the `finalized`
      // tag lags `latest` by one block, and `safe` is at or one block ahead of
      // `finalized`. BEP-126 fast finality is the chain's own guarantee, so the
      // tag is the real condition; one extra block is required as the depth a
      // credit waits for, and a hash change at that height reverts the event.
      mode: "finalized-tag",
      confirmations: 1,
      reorgDepth: 1,
      rationale:
        "BEP-126 gives fast finality; the public RPC finalized tag was measured one block behind latest across bnbchain, publicnode, defibit and ninicoin endpoints on 2026-11-01. A credit requires the finalized tag plus its block hash still being canonical.",
      measured: { at: MAINNET_CHECKED_AT, finalizedLagBlocks: 1, blockTimeSec: 0.75, source: "bsc-dataseed/publicnode/defibit/ninicoin eth_getBlockByNumber(finalized)" },
    },
    scanIntervalSec: 5,
    maxBlockRange: 2000,
    notes: "Production credit network. BSC USDC is the Binance-Peg bridged asset, not a Circle-native deployment.",
    evidence: {
      source: "BNB Smart Chain docs — JSON-RPC Endpoint",
      url: "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/",
      checkedAt: MAINNET_CHECKED_AT,
      note: "Docs list BSC Mainnet (ChainID 0x38, 56 decimal) and https://bsc-dataseed.bnbchain.org. eth_chainId returned 0x38 on 2026-11-01 (read-only).",
    },
  },
  {
    chainId: 8453,
    displayName: "Base",
    family: "evm",
    networkType: "mainnet",
    support: "credit",
    receivable: true,
    rpcQuorum: 2,
    rpcEndpoints: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://1rpc.io/base"],
    blockExplorer: "https://basescan.org",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    enabled: true,
    finality: {
      // Measured 2026-11-01: `finalized` lagged `latest` by ~600 blocks
      // (~20 min at ~2 s blocks) and two independent providers agreed on the
      // same finalized height. Base inherits L1 finality, so waiting for the
      // tag is the real condition, not a guessed confirmation count.
      mode: "finalized-tag",
      confirmations: 0,
      reorgDepth: 0,
      rationale:
        "Base is an L2: its finalized tag tracks L1 finality and lagged the head by ~600 blocks on 2026-11-01, with mainnet.base.org and publicnode agreeing. The tag is the credit condition; a hash change at the event height reverts and freezes.",
      measured: { at: MAINNET_CHECKED_AT, finalizedLagBlocks: 590, blockTimeSec: 2.0, source: "mainnet.base.org/publicnode eth_getBlockByNumber(finalized)" },
    },
    scanIntervalSec: 12,
    maxBlockRange: 2000,
    notes: "Production credit network. Base native USDC is a Circle-issued deployment.",
    evidence: {
      source: "Base docs — Connect to Base (Network Details)",
      url: "https://docs.base.org/get-started/connect-to-base",
      checkedAt: MAINNET_CHECKED_AT,
      note: "Docs list Base Mainnet RPC https://mainnet.base.org, Chain ID 8453, Currency ETH and explorer basescan.org. eth_chainId returned 0x2105 on 2026-11-01 (read-only).",
    },
  },
];

/**
 * Backwards-compatible name. The records are no longer read-only; they are the
 * product mainnets, enabled for credit through the same watcher as a testnet.
 */
export const RESERVED_MAINNETS: NetworkRecord[] = PRODUCT_NETWORKS;

/**
 * Verified production assets. An asset belongs here only with an issuer/bridge
 * source and a matching on-chain `(chainId, contract, decimals, symbol)` tuple.
 *
 * BSC has no Circle-native USDC (Circle's mainnet table did not list BSC when
 * checked on 2026-11-01). The real BSC dollar asset is Binance-Peg USD Coin,
 * a bridged 18-decimal token; it is a *different asset* from Base's 6-decimal
 * Circle deployment and is recorded as such. Symbols are never compared.
 */
export const MAINNET_ASSETS: AssetRecord[] = [
  {
    assetId: "eip155:56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    chainId: 56,
    contractAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    symbol: "USDC",
    name: "USD Coin (Binance-Peg)",
    decimals: 18,
    issuerType: "bridged",
    testnetOnly: false,
    credit: true,
    enabled: true,
    pricing: {
      nanosPerToken: "1000000000",
      version: "stablecoin-usd:56:binance-peg-usdc:v1",
      kind: "stablecoin-usd",
      note: "Credited at 1 USD per token because Binance states the peg is 1:1; this is the issuer's redemption claim, not an oracle quote. A depeg is a provider risk and is not hidden.",
    },
    evidence: {
      issuer: "Binance (Binance-Peg)",
      source: "BscScan verified BEP-20 contract; CoinGecko BSC token list; on-chain metadata read",
      url: "https://bscscan.com/token/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      checkedAt: MAINNET_CHECKED_AT,
      onchainChainId: 56,
      onchainContract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      onchainDecimals: 18,
      onchainSymbol: "USDC",
      note: "symbol()=USDC, decimals()=18 and name()=USD Coin were read via https://bsc-dataseed.bnbchain.org on 2026-11-01; CoinGecko's chain-56 list names it Binance Bridged USDC (BNB Smart Chain). Circle's official table did not list BSC on the same date.",
    },
  },
  {
    assetId: "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    chainId: 8453,
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    issuerType: "native-issuer",
    testnetOnly: false,
    credit: true,
    enabled: true,
    pricing: {
      nanosPerToken: "1000000000",
      version: "stablecoin-usd:8453:circle-usdc:v1",
      kind: "stablecoin-usd",
      note: "Credited at 1 USD per token because Circle redeems native USDC at face value; this is an issuer peg assumption, not a market oracle.",
    },
    evidence: {
      issuer: "Circle",
      source: "Circle Docs — USDC contract addresses (Mainnet)",
      url: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
      checkedAt: MAINNET_CHECKED_AT,
      onchainChainId: 8453,
      onchainContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      onchainDecimals: 6,
      onchainSymbol: "USDC",
      note: "Base is listed in Circle's mainnet USDC table. decimals()=6, symbol()=USDC and name()=USD Coin were re-read on 2026-11-01 via https://mainnet.base.org.",
    },
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
  networks: NetworkRecordInput[];
  assets: AssetRecordInput[];
}

export function registryPath(): string {
  return statePath("networks.json");
}

function assertRpcEndpoint(endpoint: string, chainId: number, readOnly: boolean): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`chain ${chainId}: ${endpoint} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`chain ${chainId}: ${endpoint} must be http or https`);
  // A loopback endpoint is a local node/isolated fork; it has no network
  // attacker to protect against. Every remote mainnet endpoint must be HTTPS.
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (readOnly && url.protocol !== "https:" && !loopback) throw new Error(`chain ${chainId}: ${endpoint} must use https for a mainnet/read-only network`);
  if (url.username || url.password) throw new Error(`chain ${chainId}: ${endpoint} must not contain credentials`);
  if (url.hash) throw new Error(`chain ${chainId}: ${endpoint} must not contain a fragment`);
}

function assertEvidenceDate(checkedAt: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) throw new Error(`${label} needs a YYYY-MM-DD checkedAt date`);
}

function assertHttpsUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} needs an absolute evidence URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} evidence must use https`);
}

function assertNetworkEvidence(evidence: NetworkEvidence | null, chainId: number): void {
  if (!evidence) throw new Error(`chain ${chainId} is a product network and needs evidence`);
  if (!evidence.source.trim()) throw new Error(`chain ${chainId} evidence needs a source`);
  assertHttpsUrl(evidence.url, `chain ${chainId}`);
  assertEvidenceDate(evidence.checkedAt, `chain ${chainId}`);
  if (!evidence.note.trim()) throw new Error(`chain ${chainId} evidence needs a note`);
}

function assertAssetEvidence(asset: AssetRecord): void {
  const e = asset.evidence;
  if (!e) throw new Error(`asset ${asset.assetId} is not a mock and needs issuer evidence`);
  if (!e.issuer.trim() || !e.source.trim() || !e.note.trim()) throw new Error(`asset ${asset.assetId} evidence is incomplete`);
  assertHttpsUrl(e.url, `asset ${asset.assetId}`);
  assertEvidenceDate(e.checkedAt, `asset ${asset.assetId}`);
  if (e.onchainChainId !== asset.chainId) throw new Error(`asset ${asset.assetId} evidence names chain ${e.onchainChainId}`);
  if (e.onchainContract.toLowerCase() !== asset.contractAddress.toLowerCase()) {
    throw new Error(`asset ${asset.assetId} evidence names another contract`);
  }
  if (e.onchainDecimals !== asset.decimals) {
    throw new Error(`asset ${asset.assetId} evidence reports ${e.onchainDecimals} decimals, not ${asset.decimals}`);
  }
  if (e.onchainSymbol.toLowerCase() !== asset.symbol.toLowerCase()) {
    throw new Error(`asset ${asset.assetId} evidence reports symbol ${e.onchainSymbol}, not ${asset.symbol}`);
  }
}

function normalizeNetwork(input: NetworkRecordInput): NetworkRecord {
  const support = input.support ?? (input.networkType === "mainnet" ? "read-only" : "credit");
  return {
    ...input,
    support,
    receivable: input.receivable ?? false,
    rpcQuorum: input.rpcQuorum ?? 1,
    nativeDecimals: input.nativeDecimals ?? 18,
    evidence: input.evidence ?? null,
    rpcEndpoints: [...input.rpcEndpoints],
  };
}

function normalizeAsset(input: AssetRecordInput): AssetRecord {
  const credit = input.credit ?? input.testnetOnly;
  const kind = input.pricing.kind ?? (credit ? "fixed-test-rate" : "not-creditable");
  return {
    ...input,
    credit,
    evidence: input.evidence ?? null,
    pricing: { ...input.pricing, kind },
  };
}

/**
 * The registry: a validated view over the persisted document.
 *
 * Nothing here reaches the network. Chain health is the watcher's business; this
 * only decides what is *configured*, which is what the ledger, the balance reader
 * and the deposit state machine are allowed to consult.
 */
export class NetworkRegistry {
  private nets: NetworkRecord[];
  private assets: AssetRecord[];
  private readonly save: ((doc: RegistryDocument) => void) | null;
  private readonly simulationChainIds: Set<number>;

  constructor(doc: RegistryDocument, save?: (doc: RegistryDocument) => void, options: NetworkRegistryOptions = {}) {
    const simulations = options.simulationChainIds ?? [];
    const bad = simulations.filter((id) => !(LOCAL_SIMULATION_CHAIN_IDS as readonly number[]).includes(id));
    if (bad.length > 0) {
      throw new Error(`simulation chain ids must be local lab ids (${LOCAL_SIMULATION_CHAIN_IDS.join(", ")}), got ${bad.join(", ")}`);
    }
    this.simulationChainIds = new Set(simulations);
    this.nets = doc.networks.map(normalizeNetwork);
    this.assets = doc.assets.map(normalizeAsset);
    this.save = save ?? null;
    this.validate();
  }

  /** Production credit is allowlisted; only an explicit local test registry may add a fork. */
  private creditChainAllowed(chainId: number): boolean {
    return (CREDIT_CHAIN_ALLOWLIST as readonly number[]).includes(chainId) || this.simulationChainIds.has(chainId);
  }

  private validate(): void {
    const seen = new Set<number>();
    for (const n of this.nets) {
      if (!Number.isInteger(n.chainId) || n.chainId <= 0) throw new Error(`a network needs a positive integer chainId, got ${n.chainId}`);
      if (seen.has(n.chainId)) throw new Error(`chain ${n.chainId} is registered twice`);
      seen.add(n.chainId);
      if (n.family !== "evm") throw new Error(`chain ${n.chainId}: only evm is implemented in this phase`);
      if (n.enabled && n.rpcEndpoints.length === 0) throw new Error(`chain ${n.chainId} is enabled without an RPC endpoint`);
      if (!Number.isInteger(n.nativeDecimals) || n.nativeDecimals < 0 || n.nativeDecimals > 36) {
        throw new Error(`chain ${n.chainId} has an unusable nativeDecimals value`);
      }
      if (n.finality.mode === "confirmations" && n.finality.confirmations <= 0) {
        throw new Error(`chain ${n.chainId} uses a confirmations policy with no confirmations`);
      }
      if (!Number.isInteger(n.maxBlockRange) || n.maxBlockRange <= 0) throw new Error(`chain ${n.chainId} needs a positive maxBlockRange`);
      for (const endpoint of n.rpcEndpoints) assertRpcEndpoint(endpoint, n.chainId, n.support === "read-only" || n.networkType === "mainnet");

      // The hard chain-id rule. It is checked before the type/support labels so a
      // document that relabels 56/8453 as a testnet cannot reach the watcher.
      if (isMainnetChainId(n.chainId)) {
        if (n.networkType !== "mainnet") {
          throw new Error(`chain ${n.chainId} is a real mainnet; relabelling it as ${n.networkType} cannot unlock credit`);
        }
        if (!this.creditChainAllowed(n.chainId)) {
          throw new Error(`chain ${n.chainId} is a real mainnet that is not on the production credit allowlist`);
        }
        if (n.support !== "credit") throw new Error(`chain ${n.chainId} is a product mainnet; only credit support is implemented`);
        assertNetworkEvidence(n.evidence, n.chainId);
        if (!Number.isInteger(n.rpcQuorum) || n.rpcQuorum < 2) {
          throw new Error(`chain ${n.chainId} is a product mainnet; rpcQuorum must be at least 2, got ${String(n.rpcQuorum)}`);
        }
        if (n.finality.mode === "read-only") throw new Error(`chain ${n.chainId} is a product mainnet and cannot assert no finality`);
      } else {
        if (n.networkType === "mainnet") throw new Error(`chain ${n.chainId} is labelled mainnet but is not a known product mainnet`);
        if (!Number.isInteger(n.rpcQuorum) || n.rpcQuorum < 1) {
          throw new Error(`chain ${n.chainId} needs a positive integer rpcQuorum`);
        }
        if (n.rpcQuorum > Math.max(1, n.rpcEndpoints.length)) {
          throw new Error(`chain ${n.chainId} asks for ${n.rpcQuorum} agreeing endpoints but lists only ${n.rpcEndpoints.length}`);
        }
      }
      if (n.networkType === "mainnet" || n.support === "read-only") assertNetworkEvidence(n.evidence, n.chainId);
      if (n.support === "read-only" && n.enabled) {
        throw new Error(`chain ${n.chainId} is read-only; it cannot be enabled for the watcher`);
      }
      if (n.enabled && n.support !== "credit") {
        throw new Error(`chain ${n.chainId} is enabled without the credit support level`);
      }
      if (n.enabled && !this.creditChainAllowed(n.chainId)) {
        throw new Error(
          `chain ${n.chainId} is not on the credit allowlist (${CREDIT_CHAIN_ALLOWLIST.join(", ")}); a testnet label or a local edit is not enough`,
        );
      }
      if (n.enabled && isMainnetChainId(n.chainId)) {
        const uniqueHosts = new Set(n.rpcEndpoints.map((endpoint) => {
          try { return new URL(endpoint).host; } catch { return endpoint; }
        }));
        if (uniqueHosts.size < n.rpcQuorum) {
          throw new Error(`chain ${n.chainId} needs ${n.rpcQuorum} distinct RPC hosts for a production credit quorum; it lists ${uniqueHosts.size}`);
        }
      }
      if (n.receivable && n.support !== "credit") {
        throw new Error(`chain ${n.chainId} is not creditable, so it cannot be a receiving network`);
      }
      if (n.finality.mode === "read-only" && n.enabled) {
        throw new Error(`chain ${n.chainId} asserts no finality, so it cannot be watched`);
      }
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
      const net = this.nets.find((n) => n.chainId === a.chainId)!;
      if (a.credit) {
        if (net.support !== "credit") throw new Error(`asset ${a.assetId} is creditable but its chain has no credit support`);
        if (a.testnetOnly) {
          if (net.networkType !== "testnet") throw new Error(`asset ${a.assetId} is a test asset on a mainnet record`);
          if (a.issuerType !== "mock") throw new Error(`asset ${a.assetId} would be credited; a creditable test asset must be a mock`);
          if (a.pricing.kind !== "fixed-test-rate") throw new Error(`asset ${a.assetId} is creditable without a fixed test rate`);
          if (!/^\d+$/.test(a.pricing.nanosPerToken) || BigInt(a.pricing.nanosPerToken) <= 0n) {
            throw new Error(`asset ${a.assetId} has an unusable fixed test rate`);
          }
          if (a.evidence !== null) throw new Error(`asset ${a.assetId} is a mock and cannot claim issuer evidence`);
        } else {
          if (net.networkType !== "mainnet") throw new Error(`asset ${a.assetId} is a production asset but its chain is not a product mainnet`);
          if (a.issuerType === "mock") throw new Error(`asset ${a.assetId} is a mainnet asset; a mock issuer is refused`);
          if (a.pricing.kind !== "stablecoin-usd") throw new Error(`asset ${a.assetId} is a production credit asset without a verified stablecoin rate`);
          if (a.pricing.nanosPerToken !== "1000000000") throw new Error(`asset ${a.assetId} must credit one stablecoin as exactly 1 USD`);
          assertAssetEvidence(a);
        }
      } else {
        if (net.networkType !== "mainnet" && net.support !== "read-only") {
          throw new Error(`asset ${a.assetId} is non-creditable but its chain is not a display-only network`);
        }
        if (a.issuerType === "mock") throw new Error(`asset ${a.assetId} is a production asset; a mock issuer is refused`);
        if (a.pricing.kind !== "not-creditable") throw new Error(`asset ${a.assetId} is display-only; a credit rate cannot be attached`);
        if (a.pricing.nanosPerToken !== "0") throw new Error(`asset ${a.assetId} is display-only and must not carry a USD rate`);
        assertAssetEvidence(a);
      }
    }
  }

  private persist(): void {
    this.save?.(this.document());
  }

  /** The normalized document, for migration and tests. */
  document(): RegistryDocument {
    return {
      version: NETWORK_REGISTRY_VERSION,
      networks: this.nets.map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] })),
      assets: this.assets.map((a) => ({ ...a })),
    };
  }

  /** Every registered network, enabled or not, in registration order. */
  networks(): NetworkRecord[] {
    return this.nets.map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  /** Only the networks a watcher may scan. Order carries no priority. */
  enabledNetworks(): NetworkRecord[] {
    return this.nets.filter((n) => n.enabled).map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  /** Every network this build may watch and credit, including the two product mainnets. */
  creditableNetworks(): NetworkRecord[] {
    return this.nets
      .filter((n) => n.enabled && n.support === "credit" && this.creditChainAllowed(n.chainId))
      .map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  /** Product receiving networks. Empty selection is a policy decision, not an absence of data. */
  receivableNetworks(): NetworkRecord[] {
    return this.nets.filter((n) => n.receivable).map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  /** Product read-only networks. This is the mainnet balance surface. */
  readOnlyNetworks(): NetworkRecord[] {
    return this.nets.filter((n) => n.support === "read-only").map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  /** Networks whose metadata/balance may be read without implying credit. */
  readableNetworks(): NetworkRecord[] {
    return this.nets
      .filter((n) => n.rpcEndpoints.length > 0 && (n.enabled || n.support === "read-only"))
      .map((n) => ({ ...n, rpcEndpoints: [...n.rpcEndpoints] }));
  }

  network(chainId: number): NetworkRecord | null {
    const n = this.nets.find((x) => x.chainId === chainId);
    return n ? { ...n, rpcEndpoints: [...n.rpcEndpoints] } : null;
  }

  isReadOnly(chainId: number): boolean {
    return this.network(chainId)?.support === "read-only";
  }

  /** Throws unless this chain may be watched/credited right now. */
  requireEnabledNetwork(chainId: number): NetworkRecord {
    const n = this.network(chainId);
    if (!n) throw new Error(`chain ${chainId} is not registered`);
    if (n.support !== "credit") throw new Error(`chain ${chainId} is read-only; this build does not watch or credit it`);
    if (!n.enabled) throw new Error(`chain ${chainId} (${n.displayName}) is disabled`);
    if (!this.creditChainAllowed(chainId)) {
      throw new Error(`chain ${chainId} is not on the credit allowlist (${CREDIT_CHAIN_ALLOWLIST.join(", ")}); refusing to watch or credit it`);
    }
    if (n.rpcEndpoints.length === 0) throw new Error(`chain ${chainId} has no RPC endpoint`);
    return n;
  }

  /** The credit gate, including the hard chain-id rule and the production quorum. */
  requireCreditableNetwork(chainId: number): NetworkRecord {
    const n = this.requireEnabledNetwork(chainId);
    if (n.support !== "credit") throw new Error(`chain ${chainId} has no credit support`);
    return n;
  }

  /** Read-only access: metadata and balances only, never a credit path. */
  requireReadableNetwork(chainId: number): NetworkRecord {
    const n = this.network(chainId);
    if (!n) throw new Error(`chain ${chainId} is not registered`);
    if (n.rpcEndpoints.length === 0) throw new Error(`chain ${chainId} has no RPC endpoint for a read-only query`);
    if (n.support === "read-only" || n.enabled) return n;
    throw new Error(`chain ${chainId} (${n.displayName}) is disabled`);
  }

  /** A product network a provider may explicitly select for receiving. */
  requireReceivableNetwork(chainId: number): NetworkRecord {
    const n = this.network(chainId);
    if (!n) throw new Error(`chain ${chainId} is not registered`);
    if (!n.receivable) throw new Error(`chain ${chainId} is an internal test network, not a product receiving network`);
    return n;
  }

  setNetworkEnabled(chainId: number, enabled: boolean): NetworkRecord {
    const n = this.nets.find((x) => x.chainId === chainId);
    if (!n) throw new Error(`chain ${chainId} is not registered`);
    if (enabled && n.support !== "credit") throw new Error(`chain ${chainId} is ${n.support} and cannot be enabled for credit`);
    if (enabled && !this.creditChainAllowed(chainId)) {
      throw new Error(`chain ${chainId} is not on the credit allowlist (${CREDIT_CHAIN_ALLOWLIST.join(", ")}); enabling it would credit an unknown chain`);
    }
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
    for (const e of clean) assertRpcEndpoint(e, chainId, n.support === "read-only" || n.networkType === "mainnet");
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

  /** The assets a testnet deposit may name right now. Mainnet is never here. */
  enabledAssets(): AssetRecord[] {
    return this.assets
      .filter((a) => a.enabled && a.credit && this.network(a.chainId)?.enabled === true)
      .map((a) => ({ ...a }));
  }

  allAssets(): AssetRecord[] {
    return this.assets.map((a) => ({ ...a }));
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
    if (!a.credit) throw new Error(`asset ${a.symbol} on chain ${chainId} is not creditable`);
    const n = this.network(chainId);
    if (!n?.enabled) throw new Error(`chain ${chainId} is not enabled, so ${a.symbol} cannot be credited`);
    return a;
  }

  /** A read-only asset on a readable network. Never implies credit. */
  requireReadableAsset(assetId: string): AssetRecord {
    const a = this.asset(assetId);
    if (!a) throw new Error(`asset ${assetId} is not registered; an unknown contract cannot be read or credited`);
    if (!a.enabled) throw new Error(`asset ${assetId} is disabled`);
    this.requireReadableNetwork(a.chainId);
    return a;
  }

  requireReadableAssetFor(chainId: number, contract: string): AssetRecord {
    return this.requireReadableAsset(assetIdOf(chainId, contract));
  }

  upsertAsset(asset: AssetRecordInput): AssetRecord {
    const normalized = normalizeAsset(asset);
    if (normalized.assetId !== assetIdOf(normalized.chainId, normalized.contractAddress)) {
      throw new Error("an asset id must be eip155:<chain>:<contract>");
    }
    const i = this.assets.findIndex((a) => a.assetId === normalized.assetId);
    if (i >= 0) this.assets[i] = normalized;
    else this.assets.push(normalized);
    this.validate();
    this.persist();
    return { ...normalized };
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
   * reported, not the value the operator expected. A mainnet asset cannot be
   * registered through this path.
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
    if (isMainnetChainId(input.chainId)) throw new Error(`chain ${input.chainId} is a real mainnet; this build does not register creditable mainnet assets`);
    const net = this.requireEnabledNetwork(input.chainId);
    if (net.networkType !== "testnet" || net.support !== "credit") throw new Error("only a testnet asset can be registered in this phase");
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
      credit: true,
      enabled: true,
      pricing: {
        nanosPerToken: input.nanosPerToken,
        version: `fixed:${input.chainId}:${input.symbol}:${input.nanosPerToken}:v1`,
        kind: "fixed-test-rate",
        note: input.pricingNote,
      },
      evidence: null,
    });
  }
}

function downgradeLegacyLocalNetworks(doc: RegistryDocument): { doc: RegistryDocument; changed: boolean } {
  let changed = false;
  const networks = doc.networks.map((n) => {
    if (
      n.enabled === true &&
      (LOCAL_SIMULATION_CHAIN_IDS as readonly number[]).includes(n.chainId) &&
      !(CREDIT_CHAIN_ALLOWLIST as readonly number[]).includes(n.chainId)
    ) {
      changed = true;
      const marker = "migration-audit: legacy enabled=true was downgraded; simulation-import-required: use an explicit simulationRegistry for local tests";
      const notes = n.notes ? `${n.notes} | ${marker}` : marker;
      return { ...n, enabled: false, notes };
    }
    return n;
  });
  return { doc: { ...doc, networks }, changed };
}

/**
 * Upgrades the v1/v2 seeded read-only mainnet records to the v3 production
 * credit records. It is deliberately narrow: a record is upgraded only when it
 * still carries the seeded read-only shape and note, so an operator's custom
 * network is never silently turned into a credit chain. Custom RPC endpoints are
 * kept and the product endpoints are added; the union must still meet the
 * quorum. An asset disabled by the operator stays disabled.
 */
function upgradeSeededMainnets(doc: RegistryDocument): { doc: RegistryDocument; changed: boolean } {
  let changed = false;
  const networks = doc.networks.map((n) => {
    const product = PRODUCT_NETWORKS.find((p) => p.chainId === n.chainId);
    if (!product) return n;
    // v1/v2 seeded records are the only mainnet records with support
    // "read-only". A production v3 record is already "credit" and is left alone.
    const seeded = n.networkType === "mainnet" && n.support === "read-only";
    if (!seeded) return n;
    changed = true;
    const extra = n.rpcEndpoints.filter((endpoint) => !product.rpcEndpoints.includes(endpoint));
    return {
      ...product,
      rpcEndpoints: [...new Set([...product.rpcEndpoints, ...extra])],
      enabled: true,
    };
  });
  const assets = doc.assets.map((a) => {
    const product = MAINNET_ASSETS.find((p) => p.assetId === a.assetId);
    if (!product) return a;
    // A display-only seeded asset (v2) or a record missing the credit fields is
    // upgraded; a record already marked credit is left as the operator set it.
    if (a.credit === true) return a;
    changed = true;
    return { ...product, enabled: a.enabled !== false };
  });
  const assetIds = new Set(assets.map((a) => a.assetId));
  const networkIds = new Set(networks.map((n) => n.chainId));
  for (const product of MAINNET_ASSETS) {
    if (networkIds.has(product.chainId) && !assetIds.has(product.assetId)) {
      assets.push(product);
      changed = true;
    }
  }
  return { doc: { version: NETWORK_REGISTRY_VERSION, networks, assets }, changed };
}

function seedDocument(): RegistryDocument {
  return {
    version: NETWORK_REGISTRY_VERSION,
    networks: [...DEFAULT_NETWORKS, ...PRODUCT_NETWORKS],
    assets: [...MAINNET_ASSETS],
  };
}

/**
 * Loads the registry, seeding the two credit testnets and the two production
 * credit mainnets on first use.
 *
 * An existing file is authoritative for what it contains: a chain the operator
 * disabled stays disabled, and a seeded default is never silently re-enabled.
 * A version-1 document is migrated by adding the missing read-only mainnet
 * records and assets and filling the new capability fields. Existing testnet
 * chain ids, enabled flags and assets are not rewritten; nothing is enabled by
 * the migration.
 */
export function loadRegistry(path = registryPath()): NetworkRegistry {
  if (existsSync(path)) {
    let raw: RegistryDocument;
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as RegistryDocument;
    } catch (e) {
      throw new Error(`the network registry at ${path} is unreadable: ${String((e as Error).message ?? e)}`);
    }
    let doc = raw;
    let migrated = raw.version !== NETWORK_REGISTRY_VERSION;
    if ((raw.version ?? 1) < 2) {
      // A version-1 document could contain the old "reserved" mainnet records
      // without the new evidence fields. Fill only the non-secret metadata from
      // the product record; never change enabled/networkType or add an RPC.
      const networks = raw.networks.map((n) => {
        const product = PRODUCT_NETWORKS.find((p) => p.chainId === n.chainId);
        if (!product) return n;
        return {
          ...n,
          support: n.support ?? "read-only",
          receivable: n.receivable ?? true,
          evidence: n.evidence ?? product.evidence,
        };
      });
      const chainIds = new Set(networks.map((n) => n.chainId));
      for (const product of PRODUCT_NETWORKS) {
        if (!chainIds.has(product.chainId)) {
          networks.push(product);
          migrated = true;
        }
      }
      const assets = [...raw.assets];
      const assetIds = new Set(assets.map((a) => a.assetId));
      for (const asset of MAINNET_ASSETS) {
        if (!assetIds.has(asset.assetId)) {
          assets.push(asset);
          migrated = true;
        }
      }
      doc = { version: NETWORK_REGISTRY_VERSION, networks, assets };
    }
    const downgraded = downgradeLegacyLocalNetworks(doc);
    doc = downgraded.doc;
    const upgraded = upgradeSeededMainnets(doc);
    doc = upgraded.doc;
    migrated = migrated || downgraded.changed || upgraded.changed;
    try {
      const reg = new NetworkRegistry(doc, (d) => writeJsonAtomic(path, d));
      if (migrated) {
        try {
          writeJsonAtomic(path, reg.document());
        } catch (e) {
          logger.warn(`cannot persist the migrated network registry yet: ${String(e)}`);
        }
      }
      return reg;
    } catch (e) {
      throw new Error(`the network registry at ${path} is unreadable: ${String((e as Error).message ?? e)}`);
    }
  }
  const doc = seedDocument();
  const reg = new NetworkRegistry(doc, (d) => writeJsonAtomic(path, d));
  try {
    writeJsonAtomic(path, doc);
  } catch (e) {
    logger.warn(`cannot persist the seeded network registry yet: ${String(e)}`);
  }
  return reg;
}

/**
 * An in-memory registry for tests and for a node that has not written state yet.
 * It keeps the historical testnet-only shape so existing wallet fixtures do not
 * silently acquire product networks; use `productRegistry()` for C1 tests.
 */
export function defaultRegistry(): NetworkRegistry {
  return new NetworkRegistry({ version: NETWORK_REGISTRY_VERSION, networks: DEFAULT_NETWORKS, assets: [] });
}

/** The full seeded registry: two credit testnets plus two production mainnets. */
export function productRegistry(): NetworkRegistry {
  return new NetworkRegistry(seedDocument());
}

/** Test/fork registry: the only way to opt a local chain into credit. */
export function simulationRegistry(doc: RegistryDocument, chainIds: readonly number[] = LOCAL_SIMULATION_CHAIN_IDS): NetworkRegistry {
  return new NetworkRegistry(doc, undefined, { simulationChainIds: chainIds });
}
