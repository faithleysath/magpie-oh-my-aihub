// Runtime production policy for a credit decision.
//
// `networks.ts` validates the persisted registry when it is constructed. This
// module is the small, explicit re-check at the moment money is about to move:
// the watcher before it books a deposit, the payment host before it accepts a
// selection, and the send path before it signs. It exists because a registry
// object can be mutated in memory, a future call site can forget which fields
// matter, and "the chain id is 56" was never a sufficient reason to credit.
//
// The two product mainnets are treated as peers. Nothing here names a preferred
// chain, and a testnet is not silently promoted: its asset must still be a mock
// with a fixed test rate.

import type { AssetRecord, NetworkRecord } from "./networks.ts";
import { assetIdOf } from "./networks.ts";
import { isMainnetChainId } from "./mainnet-gate.ts";

export type ProductionPolicyCode =
  | "chain-not-credit"
  | "chain-disabled"
  | "chain-not-receivable"
  | "mainnet-quorum-too-small"
  | "mainnet-finality-unset"
  | "asset-not-credit"
  | "asset-disabled"
  | "asset-chain-mismatch"
  | "asset-id-mismatch"
  | "asset-issuer-invalid"
  | "asset-rate-invalid"
  | "asset-evidence-missing"
  | "asset-evidence-mismatch";

export class ProductionPolicyError extends Error {
  constructor(
    readonly code: ProductionPolicyCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductionPolicyError";
  }
}

function refuse(code: ProductionPolicyCode, message: string): never {
  throw new ProductionPolicyError(code, message);
}

/**
 * A network that may be credited right now. `requireReceivable` is true for a
 * provider's product receiving selection and for a production payment; the
 * development testnets are credit-capable but not product receiving networks,
 * so their `receivable` is false and they are allowed only on the watcher/send
 * paths that explicitly do not require it.
 */
export function assertProductionCreditNetwork(network: NetworkRecord, options: { requireReceivable?: boolean } = {}): void {
  if (network.support !== "credit") refuse("chain-not-credit", `chain ${network.chainId} has no credit support`);
  if (!network.enabled) refuse("chain-disabled", `chain ${network.chainId} (${network.displayName}) is disabled`);
  const requireReceivable = options.requireReceivable ?? isMainnetChainId(network.chainId);
  if (requireReceivable && !network.receivable) refuse("chain-not-receivable", `chain ${network.chainId} is not a receiving network`);
  if (isMainnetChainId(network.chainId) || network.networkType === "mainnet") {
    if (!Number.isInteger(network.rpcQuorum) || network.rpcQuorum < 2) {
      refuse("mainnet-quorum-too-small", `chain ${network.chainId} needs at least two agreeing RPC endpoints`);
    }
    if (network.finality.mode === "read-only") {
      refuse("mainnet-finality-unset", `chain ${network.chainId} asserts no finality; it cannot credit`);
    }
    const hosts = new Set(network.rpcEndpoints.map((endpoint) => {
      try { return new URL(endpoint).host; } catch { return endpoint; }
    }));
    if (hosts.size < network.rpcQuorum) {
      refuse("mainnet-quorum-too-small", `chain ${network.chainId} lists ${hosts.size} distinct RPC host(s) for a quorum of ${network.rpcQuorum}`);
    }
  }
}

/**
 * A verified, creditable asset. A mainnet asset must be a non-mock stablecoin
 * with issuer evidence and exactly a 1 USD face value; a testnet asset must be a
 * mock with a positive fixed test rate. Symbols alone are never identity.
 */
export function assertProductionCreditAsset(network: NetworkRecord, asset: AssetRecord, options: { requireReceivable?: boolean } = {}): void {
  assertProductionCreditNetwork(network, options);
  if (asset.chainId !== network.chainId) refuse("asset-chain-mismatch", `asset ${asset.assetId} is not on chain ${network.chainId}`);
  if (asset.assetId !== assetIdOf(asset.chainId, asset.contractAddress)) {
    refuse("asset-id-mismatch", `asset ${asset.assetId} does not match its chain and contract`);
  }
  if (!asset.credit) refuse("asset-not-credit", `asset ${asset.assetId} is not creditable`);
  if (!asset.enabled) refuse("asset-disabled", `asset ${asset.assetId} is disabled`);

  if (isMainnetChainId(asset.chainId) || network.networkType === "mainnet") {
    if (asset.issuerType !== "native-issuer" && asset.issuerType !== "bridged") {
      refuse("asset-issuer-invalid", `asset ${asset.assetId} on a product mainnet must be native-issuer or bridged, not ${asset.issuerType}`);
    }
    if (asset.testnetOnly) refuse("asset-issuer-invalid", `asset ${asset.assetId} is marked testnet-only on a mainnet`);
    if (asset.pricing.kind !== "stablecoin-usd" || asset.pricing.nanosPerToken !== "1000000000") {
      refuse("asset-rate-invalid", `asset ${asset.assetId} must be credited at exactly 1 USD per token`);
    }
    const evidence = asset.evidence;
    if (!evidence) refuse("asset-evidence-missing", `asset ${asset.assetId} has no issuer/bridge evidence`);
    if (
      evidence.onchainChainId !== asset.chainId ||
      evidence.onchainContract.toLowerCase() !== asset.contractAddress.toLowerCase() ||
      evidence.onchainDecimals !== asset.decimals ||
      evidence.onchainSymbol.toLowerCase() !== asset.symbol.toLowerCase()
    ) {
      refuse("asset-evidence-mismatch", `asset ${asset.assetId} evidence does not match its recorded quadruple`);
    }
    return;
  }

  if (asset.issuerType !== "mock" || !asset.testnetOnly) {
    refuse("asset-issuer-invalid", `asset ${asset.assetId} on a test chain must be a mock test asset`);
  }
  if (asset.pricing.kind !== "fixed-test-rate" || !/^\d+$/.test(asset.pricing.nanosPerToken) || BigInt(asset.pricing.nanosPerToken) <= 0n) {
    refuse("asset-rate-invalid", `asset ${asset.assetId} has no usable fixed test rate`);
  }
}

/** A short, non-secret readiness summary for the status page and logs. */
export function productionReadiness(network: NetworkRecord, assets: AssetRecord[]): {
  ready: boolean;
  code: ProductionPolicyCode | null;
  reason: string | null;
  creditableAssets: AssetRecord[];
} {
  try {
    assertProductionCreditNetwork(network);
  } catch (error) {
    const e = error as ProductionPolicyError;
    return { ready: false, code: e.code, reason: e.message, creditableAssets: [] };
  }
  const creditableAssets: AssetRecord[] = [];
  let first: ProductionPolicyError | null = null;
  for (const asset of assets) {
    try {
      assertProductionCreditAsset(network, asset);
      creditableAssets.push(asset);
    } catch (error) {
      if (!first && error instanceof ProductionPolicyError) first = error;
    }
  }
  if (creditableAssets.length === 0) {
    return {
      ready: false,
      code: first?.code ?? "asset-not-credit",
      reason: first?.message ?? `chain ${network.chainId} has no creditable asset`,
      creditableAssets: [],
    };
  }
  return { ready: true, code: null, reason: null, creditableAssets };
}
