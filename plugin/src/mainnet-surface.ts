// Narrow surface for the other Phase 10 C units (external wallet adapter and
// built-in wallet). They should import from here instead of copying chain ids,
// the mainnet allowlist or asset-shape checks into browser/UI code.
//
// The two rules this surface exists to preserve:
//
//   * "readable" is not "creditable". `readOnlyNetworks()` / `readOnlyBalance()`
//     and `requireReadableNetwork()` never imply a credit path.
//   * send/credit/auto-recharge on 56 or 8453 are refused by the core gate, not
//     by a UI branch. A UI that hides a button is not the security boundary.
//
// See docs/phase10-c-registry.md ("C1 narrow API contract") for the field-level
// contract and the intended call sequence.

export {
  MAINNET_BOUNDARY,
  MAINNET_CHAIN_IDS,
  MainnetGateError,
  assertCreditSourceNotMainnet,
  assertMainnetCapability,
  assertNoMainnetAutoRecharge,
  assertNoMainnetCredit,
  assertNoMainnetSend,
  creditSourceChainId,
  isMainnetChainId,
  mainnetCapabilities,
  mainnetCapabilityAllowed,
  type MainnetChainId,
  type NetworkCapability,
} from "./mainnet-gate.ts";

export type {
  AssetEvidence,
  AssetIssuerType,
  AssetPricing,
  AssetRecord,
  FinalityPolicy,
  NetworkEvidence,
  NetworkRecord,
  NetworkSupport,
  NetworkType,
} from "./networks.ts";
export type { NetworkRegistry } from "./networks.ts";

export { ReadOnlyChainReader, encodeBalanceOf, type ReadOnlyBalance, type ReadOnlyBalanceInput } from "./readonly-balance.ts";
export {
  ReceivingNetworkPolicy,
  type CreditVerdict,
  type PaymentRequestVerdict,
  type ReceivingSelection,
} from "./receiving-networks.ts";
