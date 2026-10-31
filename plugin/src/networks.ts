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
 * `credit` is the existing testnet watcher path: scan, verify finality, book a
 * ledger deposit and raise a Magpie cap. `read-only` means metadata, a read-only
 * balance query and (when `receivable` is true) selection as a provider's
 * receiving network. It never reaches the watcher, the ledger or a cap.
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
  /** ordered; the first healthy one is used and the rest are fallbacks */
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
export type NetworkRecordInput = Omit<NetworkRecord, "support" | "receivable" | "nativeDecimals" | "evidence"> & {
  support?: NetworkSupport;
  receivable?: boolean;
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
   * A mainnet/read-only asset has `kind: "not-creditable"` and no rate.
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
  /** `fixed-test-rate` for the phase-7 mock tokens; `not-creditable` for mainnet */
  kind: "fixed-test-rate" | "not-creditable";
  note: string;
}

export const NETWORK_REGISTRY_VERSION = 2;

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
 * The two real mainnets as first-class, **read-only** product networks.
 *
 * They are not `enabled`: `enabled` still means "the watcher may scan and the
 * ledger may credit this chain", and that is false for both. The read-only
 * capability is a separate field (`support`) and the balance reader has its own
 * gate (`requireReadableNetwork`). There is no primary/default field; selection
 * starts empty and is explicit (see `receiving-networks.ts`).
 */
export const PRODUCT_NETWORKS: NetworkRecord[] = [
  {
    chainId: 56,
    displayName: "BNB Smart Chain",
    family: "evm",
    networkType: "mainnet",
    support: "read-only",
    receivable: true,
    rpcEndpoints: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed-public.bnbchain.org"],
    blockExplorer: "https://bscscan.com",
    nativeSymbol: "BNB",
    nativeDecimals: 18,
    enabled: false,
    finality: {
      // BEP-126 gives fast finality; the public RPC's `finalized` tag was
      // observed at ~the head on 2026-10-31. This build never credits a mainnet,
      // so no confirmation depth is asserted or used. The policy is explicit
      // rather than copied from the testnet.
      mode: "read-only",
      confirmations: 0,
      reorgDepth: 0,
      rationale:
        "Read-only product network: nothing is credited, so finality is not asserted. BEP-126 fast finality exists (https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP126.md); the public RPC finalized tag was observed near the head on 2026-10-31, but it is not a credit condition in this build.",
    },
    scanIntervalSec: 5,
    maxBlockRange: 2000,
    notes: "Read-only product network. No watcher, no ledger credit, no send, no automatic recharge.",
    evidence: {
      source: "BNB Smart Chain docs — JSON-RPC Endpoint",
      url: "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/",
      checkedAt: MAINNET_CHECKED_AT,
      note: "Docs list BSC Mainnet (ChainID 0x38, 56 in decimal) and https://bsc-dataseed.bnbchain.org. eth_chainId returned 0x38 on 2026-10-31 (read-only).",
    },
  },
  {
    chainId: 8453,
    displayName: "Base",
    family: "evm",
    networkType: "mainnet",
    support: "read-only",
    receivable: true,
    rpcEndpoints: ["https://mainnet.base.org"],
    blockExplorer: "https://basescan.org",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    enabled: false,
    finality: {
      mode: "read-only",
      confirmations: 0,
      reorgDepth: 0,
      rationale:
        "Read-only product network: nothing is credited, so finality is not asserted. Base is an L2 whose finalized tag tracks L1; the tag was observed lagging the head on 2026-10-31, but it is not a credit condition in this build.",
    },
    scanIntervalSec: 12,
    maxBlockRange: 2000,
    notes: "Read-only product network. No watcher, no ledger credit, no send, no automatic recharge.",
    evidence: {
      source: "Base docs — Connect to Base (Network Details)",
      url: "https://docs.base.org/get-started/connect-to-base",
      checkedAt: MAINNET_CHECKED_AT,
      note: "Docs list Base Mainnet RPC https://mainnet.base.org, Chain ID 8453, Currency ETH and explorer basescan.org. eth_chainId returned 0x2105 on 2026-10-31 (read-only).",
    },
  },
];

/**
 * Backwards-compatible name for the read-only mainnet records. They used to be
 * "reserved and always disabled"; they are now displayable product networks, but
 * still disabled for credit and still refused by `requireEnabledNetwork`.
 */
export const RESERVED_MAINNETS: NetworkRecord[] = PRODUCT_NETWORKS;

/**
 * Verified mainnet assets. Only assets with an issuer-official contract source
 * and a matching on-chain quadruple belong here. There is intentionally no BSC
 * USDC entry: Circle's official mainnet list does not include BNB Smart Chain
 * (checked 2026-10-31), and the BSC token is a bridged/third-party asset whose
 * issuer evidence is not established in this build. It stays unsupported rather
 * than guessed.
 */
export const MAINNET_ASSETS: AssetRecord[] = [
  {
    assetId: "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    chainId: 8453,
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    issuerType: "native-issuer",
    testnetOnly: false,
    credit: false,
    enabled: true,
    pricing: {
      nanosPerToken: "0",
      version: "not-creditable:8453:usdc:v1",
      kind: "not-creditable",
      note: "Base native USDC is display/read-only in this build. No fixed test rate is reused and no USD credit is computed.",
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
      note: "Base is listed in Circle's mainnet USDC table. decimals()=6 and symbol()=USDC were re-read on 2026-10-31 via https://mainnet.base.org.",
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
    receivable: input.receivable ?? support === "read-only",
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

  constructor(doc: RegistryDocument, save?: (doc: RegistryDocument) => void) {
    this.nets = doc.networks.map(normalizeNetwork);
    this.assets = doc.assets.map(normalizeAsset);
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
      if (!Number.isInteger(n.nativeDecimals) || n.nativeDecimals < 0 || n.nativeDecimals > 36) {
        throw new Error(`chain ${n.chainId} has an unusable nativeDecimals value`);
      }
      if (n.finality.mode === "confirmations" && n.finality.confirmations <= 0) {
        throw new Error(`chain ${n.chainId} uses a confirmations policy with no confirmations`);
      }
      if (!Number.isInteger(n.maxBlockRange) || n.maxBlockRange <= 0) throw new Error(`chain ${n.chainId} needs a positive maxBlockRange`);

      // The hard chain-id rule. It is checked before the type/support labels so a
      // document that relabels 56/8453 as a testnet cannot reach the watcher.
      if (isMainnetChainId(n.chainId)) {
        if (n.networkType !== "mainnet") {
          throw new Error(`chain ${n.chainId} is a real mainnet; relabelling it as ${n.networkType} cannot unlock credit`);
        }
        if (n.support !== "read-only") {
          throw new Error(`chain ${n.chainId} is a real mainnet and must stay read-only; credit is forbidden`);
        }
        if (n.enabled) {
          throw new Error(`chain ${n.chainId} is a real mainnet and cannot be watched or credited in this phase`);
        }
        assertNetworkEvidence(n.evidence, n.chainId);
      }
      if (n.networkType === "mainnet" && n.support !== "read-only") {
        throw new Error(`chain ${n.chainId} is mainnet; only the read-only support level is implemented`);
      }
      if (n.networkType === "mainnet" || n.support === "read-only") assertNetworkEvidence(n.evidence, n.chainId);
      if (n.support === "read-only" && n.enabled) {
        throw new Error(`chain ${n.chainId} is read-only; it cannot be enabled for the watcher`);
      }
      if (n.enabled && n.networkType !== "testnet") {
        throw new Error(`chain ${n.chainId} is not a testnet; this phase does not watch or credit it`);
      }
      if (n.enabled && n.support !== "credit") {
        throw new Error(`chain ${n.chainId} is enabled without the credit support level`);
      }
      if (n.receivable && n.support !== "read-only") {
        throw new Error(`chain ${n.chainId} is creditable; only a read-only product network may be selected for receiving`);
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
      if (a.testnetOnly !== a.credit) {
        throw new Error(`asset ${a.assetId} must be either a creditable test asset or a non-creditable product asset`);
      }
      const net = this.nets.find((n) => n.chainId === a.chainId)!;
      if (a.credit) {
        if (net.networkType !== "testnet" || net.support !== "credit") throw new Error(`asset ${a.assetId} is creditable but its chain is not a credit testnet`);
        if (a.issuerType !== "mock") throw new Error(`asset ${a.assetId} would be credited; a creditable test asset must be a mock`);
        if (a.pricing.kind !== "fixed-test-rate") throw new Error(`asset ${a.assetId} is creditable without a fixed test rate`);
        if (!/^\d+$/.test(a.pricing.nanosPerToken) || BigInt(a.pricing.nanosPerToken) <= 0n) {
          throw new Error(`asset ${a.assetId} has an unusable fixed test rate`);
        }
        if (a.evidence !== null) throw new Error(`asset ${a.assetId} is a mock and cannot claim issuer evidence`);
      } else {
        if (net.networkType !== "mainnet" || net.support !== "read-only") {
          throw new Error(`asset ${a.assetId} is non-creditable but its chain is not a read-only mainnet`);
        }
        if (a.issuerType === "mock") throw new Error(`asset ${a.assetId} is a mainnet asset; a mock issuer is refused`);
        if (a.pricing.kind !== "not-creditable") throw new Error(`asset ${a.assetId} is mainnet; a fixed test rate cannot be reused`);
        if (a.pricing.nanosPerToken !== "0") throw new Error(`asset ${a.assetId} is mainnet and must not carry a USD rate`);
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

  /** Only networks that may credit; a mainnet is never in this set. */
  creditableNetworks(): NetworkRecord[] {
    return this.nets
      .filter((n) => n.enabled && n.support === "credit" && n.networkType === "testnet" && !isMainnetChainId(n.chainId))
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
    if (isMainnetChainId(chainId) || n.networkType === "mainnet" || n.support === "read-only") {
      throw new Error(`chain ${chainId} is mainnet/read-only; this build does not watch or credit it`);
    }
    if (!n.enabled) throw new Error(`chain ${chainId} (${n.displayName}) is disabled`);
    if (n.rpcEndpoints.length === 0) throw new Error(`chain ${chainId} has no RPC endpoint`);
    return n;
  }

  /** The credit gate, including the hard chain-id rule. */
  requireCreditableNetwork(chainId: number): NetworkRecord {
    if (isMainnetChainId(chainId)) {
      throw new Error(`chain ${chainId} is a real mainnet; credit is forbidden in this build`);
    }
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
    if (enabled && isMainnetChainId(chainId)) throw new Error(`chain ${chainId} is a real mainnet and cannot be enabled in this phase`);
    if (enabled && n.networkType === "mainnet") throw new Error(`chain ${chainId} is mainnet and cannot be enabled in this phase`);
    if (enabled && n.support !== "credit") throw new Error(`chain ${chainId} is ${n.support} and cannot be enabled for credit`);
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
      if ((n.support === "read-only" || n.networkType === "mainnet") && u.protocol !== "https:") {
        throw new Error(`${e} must use https for a mainnet/read-only network`);
      }
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

function seedDocument(): RegistryDocument {
  return {
    version: NETWORK_REGISTRY_VERSION,
    networks: [...DEFAULT_NETWORKS, ...PRODUCT_NETWORKS],
    assets: [...MAINNET_ASSETS],
  };
}

/**
 * Loads the registry, seeding the two testnets and the two read-only mainnets on
 * first use.
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

/** The full seeded registry: two credit testnets plus two read-only mainnets. */
export function productRegistry(): NetworkRegistry {
  return new NetworkRegistry(seedDocument());
}
