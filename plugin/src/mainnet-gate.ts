// The production chain capability matrix.
//
// Version 3 of the registry makes BSC 56 and Base 8453 first-class credit
// networks. The old blanket "mainnet means no send and no credit" rule is gone;
// what remains here is a small, registry-independent chain-id layer so a forged
// `networkType: "testnet"` label still cannot make chain 56 a test chain.
//
// The real production controls are not in this file:
//
//   * the registry requires a verified `(chainId, contract, decimals, symbol)`
//     asset with issuer/bridge evidence and refuses a stablecoin rate other than
//     exactly 1 USD (`networks.ts`);
//   * a product mainnet must use at least two distinct RPC hosts and a real
//     finality policy (`networks.ts`, `evm.ts`);
//   * the watcher re-verifies the receipt, log, recipient, amount and finalized
//     block across the quorum before it books a deposit (`watcher.ts`);
//   * the ledger only accepts `chain:<id>` sources whose chain is on the credit
//     allowlist, and the provisioner grants `native used + ledger balance`
//     (`ledger.ts`, `provisioner.ts`);
//   * the payment journal binds the invoice, identity, authorization generation,
//     quote expiry and exact calldata before a send (`payment-operations.ts`).
//
// This module therefore answers "does this chain id have the capability at all",
// not "may this particular payment proceed". Do not replace the checks above
// with a chain-id allowlist.

export const MAINNET_CHAIN_IDS = [56, 8453] as const;

export type MainnetChainId = (typeof MAINNET_CHAIN_IDS)[number];

/** Every operation a network can be asked to perform in this plugin. */
export type NetworkCapability =
  | "read-metadata"
  | "read-balance"
  | "select-receiving"
  | "send"
  | "credit"
  | "auto-recharge";

/**
 * Automatic recharge is still a reminder + one-click confirmation. It has no
 * unattended executor, so the capability is false on every chain and the gate
 * cannot be used to pretend a full-auto path exists.
 */
const MAINNET_ALLOWED: readonly NetworkCapability[] = ["read-metadata", "read-balance", "select-receiving", "send", "credit"];

export class MainnetGateError extends Error {
  constructor(
    readonly code:
      | "mainnet-capability-forbidden"
      | "mainnet-auto-recharge-forbidden"
      | "chain-id-invalid",
    message: string,
  ) {
    super(message);
    this.name = "MainnetGateError";
  }
}

/** True only for the two real mainnets this product knows by identity. */
export function isMainnetChainId(chainId: unknown): chainId is MainnetChainId {
  return typeof chainId === "number" && Number.isSafeInteger(chainId) && (MAINNET_CHAIN_IDS as readonly number[]).includes(chainId);
}

/** A positive, safe-integer chain id; a JSON string is never accepted. */
function assertChainId(chainId: unknown, operation: string): asserts chainId is number {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new MainnetGateError("chain-id-invalid", `chain id ${String(chainId)} is not a positive integer; refusing ${operation}`);
  }
}

/**
 * The capability matrix for one chain. Testnet chains keep every capability the
 * code implements. A mainnet has send/credit because the production controls
 * live above this layer; it still has no automatic recharge.
 */
export function mainnetCapabilities(chainId: number): Record<NetworkCapability, boolean> {
  assertChainId(chainId, "the capability query");
  const mainnet = isMainnetChainId(chainId);
  return {
    "read-metadata": true,
    "read-balance": true,
    "select-receiving": true,
    send: true,
    credit: true,
    "auto-recharge": !mainnet,
  };
}

export function mainnetCapabilityAllowed(chainId: number, capability: NetworkCapability): boolean {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) return false;
  if (!isMainnetChainId(chainId)) return true;
  return MAINNET_ALLOWED.includes(capability);
}

/** Refuses one capability that the product does not implement at all. */
export function assertMainnetCapability(chainId: number, capability: NetworkCapability, operation: string = capability): void {
  assertChainId(chainId, operation);
  if (mainnetCapabilityAllowed(chainId, capability)) return;
  const code = capability === "auto-recharge" ? "mainnet-auto-recharge-forbidden" : "mainnet-capability-forbidden";
  throw new MainnetGateError(
    code,
    `chain ${chainId}: ${operation} is not implemented. Automatic recharge is a reminder plus one explicit confirmation, not an unattended signer.`,
  );
}

/**
 * Kept for the code paths that used to block mainnet sends. It now checks the
 * chain id only; the send-specific checks are the registry asset tuple, the
 * journal binding and the production policy. The name is historical.
 */
export function assertNoMainnetSend(input: { chainId: number; operation?: string }): void {
  assertMainnetCapability(input.chainId, "send", input.operation ?? "send");
}

/** Deposit/intent/cap guard. Chain-id layer only; see this file's header. */
export function assertNoMainnetCredit(input: { chainId: number; operation?: string }): void {
  assertMainnetCapability(input.chainId, "credit", input.operation ?? "credit");
}

/** Automatic top-up guard. No unattended executor exists on any chain. */
export function assertNoMainnetAutoRecharge(input: { chainId: number; operation?: string }): void {
  assertMainnetCapability(input.chainId, "auto-recharge", input.operation ?? "automatic recharge");
}

/**
 * The chain id a ledger source names, or null. The watcher books a chain
 * deposit as `chain:<id>`; this is the only format that can imply credit.
 */
export function creditSourceChainId(source: unknown): number | null {
  if (typeof source !== "string") return null;
  // Normalize case and whitespace so `Chain:56`, ` chain : 56` cannot evade the
  // ledger's format check. Unknown source formats are additionally refused by
  // the ledger's funds-class classifier.
  const normalized = source.trim().toLowerCase();
  const match = /^(?:chain|mainnet)\s*:\s*(\d+)(?=\D|$)/.exec(normalized);
  if (!match) return null;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) ? chainId : null;
}

/**
 * The ledger's second line of defence is `assertCreditChainAllowed` in
 * `ledger.ts`, which checks the actual credit allowlist. This helper exists so a
 * caller can classify a source without importing the ledger.
 */
export function assertCreditSourceNotMainnet(source: unknown): void {
  const chainId = creditSourceChainId(source);
  if (chainId !== null) assertChainId(chainId, `a ledger deposit from ${String(source)}`);
}

/** A complete, frozen description of the chain-id boundary, for docs and tests. */
export const MAINNET_BOUNDARY = Object.freeze({
  chains: MAINNET_CHAIN_IDS,
  allowed: Object.freeze([...MAINNET_ALLOWED]),
  forbidden: Object.freeze(["auto-recharge"] as const),
  note: "BSC 56 and Base 8453 have send and credit capabilities; the production policy, registry, watcher and journal decide each payment. Automatic recharge remains manual-confirm only.",
});
