// The mainnet capability gate: a hard, registry-independent boundary.
//
// Phase 10 C1 makes BSC (56) and Base (8453) first-class *read-only* product
// networks. That is a smaller change than it sounds, but it is exactly the kind
// of change where a later "just one flag" would be dangerous, so the rule lives
// here rather than only in the registry document:
//
//   - the chain ids are constants in this module, not fields in `networks.json`;
//   - a registry record that relabels 56 as `testnet` or `credit` is refused by
//     `networks.ts` *and* this module still refuses the operation;
//   - no UI action, plugin option or environment variable is read here, so
//     there is nothing to toggle;
//   - the only allowed mainnet capabilities are reading metadata, reading a
//     balance and selecting the chain as a receiving network. Sending,
//     crediting and automatic recharge are always refused.
//
// The last point is not a temporary phase-7 rule. Real-money credit needs the
// independent D review and an explicit product decision; this module is the
// place that must keep saying no until that exists.

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

/** The complete mainnet allowlist. Reading and selection are the only entries. */
const MAINNET_ALLOWED: readonly NetworkCapability[] = ["read-metadata", "read-balance", "select-receiving"];

export class MainnetGateError extends Error {
  constructor(
    readonly code:
      | "mainnet-send-forbidden"
      | "mainnet-credit-forbidden"
      | "mainnet-auto-recharge-forbidden"
      | "mainnet-capability-forbidden",
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

/**
 * The capability matrix for one chain. Testnet chains keep the existing
 * capabilities; a mainnet can never gain send/credit/auto-recharge through
 * data, because the columns are hard-coded here.
 */
export function mainnetCapabilities(chainId: number): Record<NetworkCapability, boolean> {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new MainnetGateError("mainnet-capability-forbidden", `chain id ${String(chainId)} is not a positive integer`);
  }
  const mainnet = isMainnetChainId(chainId);
  return {
    "read-metadata": true,
    "read-balance": true,
    "select-receiving": true,
    send: !mainnet,
    credit: !mainnet,
    "auto-recharge": !mainnet,
  };
}

export function mainnetCapabilityAllowed(chainId: number, capability: NetworkCapability): boolean {
  // A UI/JSON string must not read as "not a mainnet" and therefore allowed.
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) return false;
  if (!isMainnetChainId(chainId)) return true;
  return MAINNET_ALLOWED.includes(capability);
}

/** Refuses one capability, with the chain id checked independently of the registry. */
export function assertMainnetCapability(chainId: number, capability: NetworkCapability, operation: string = capability): void {
  // A JSON/UI caller can hand a string even though TypeScript says number. A
  // non-integer chain id must not fall through to "not a mainnet".
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new MainnetGateError("mainnet-capability-forbidden", `chain id ${String(chainId)} is not a positive integer; refusing ${operation}`);
  }
  if (mainnetCapabilityAllowed(chainId, capability)) return;
  const code =
    capability === "send"
      ? "mainnet-send-forbidden"
      : capability === "credit"
        ? "mainnet-credit-forbidden"
        : capability === "auto-recharge"
          ? "mainnet-auto-recharge-forbidden"
          : "mainnet-capability-forbidden";
  throw new MainnetGateError(
    code,
    `chain ${chainId} is a real mainnet; ${operation} is forbidden in this build. ` +
      `Mainnets are read-only: no send, no credit and no automatic recharge.`,
  );
}

/** Outbound broadcast/signing path guard. */
export function assertNoMainnetSend(input: { chainId: number; operation?: string }): void {
  assertMainnetCapability(input.chainId, "send", input.operation ?? "send");
}

/** Deposit/intent/cap guard. Called by the ledger and the receiving policy. */
export function assertNoMainnetCredit(input: { chainId: number; operation?: string }): void {
  assertMainnetCapability(input.chainId, "credit", input.operation ?? "credit");
}

/** Automatic top-up guard. C8 must call this before any execution path. */
export function assertNoMainnetAutoRecharge(input: { chainId: number; operation?: string }): void {
  assertMainnetCapability(input.chainId, "auto-recharge", input.operation ?? "automatic recharge");
}

/**
 * The chain id a ledger source names, or null. The watcher books a chain
 * deposit as `chain:<id>`; this is the only format that can imply credit.
 */
export function creditSourceChainId(source: unknown): number | null {
  if (typeof source !== "string") return null;
  const match = /^(?:chain|mainnet):(\d+)(?=\D|$)/.exec(source);
  if (!match) return null;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) ? chainId : null;
}

/**
 * Refuses a ledger source that claims to be a mainnet chain. This is a second
 * line of defence: even if a future watcher bug tried to book `chain:56`, the
 * durable ledger refuses the row instead of creating a credit.
 */
export function assertCreditSourceNotMainnet(source: unknown): void {
  const chainId = creditSourceChainId(source);
  if (chainId !== null && isMainnetChainId(chainId)) {
    assertNoMainnetCredit({ chainId, operation: `a ledger deposit from ${String(source)}` });
  }
}

/** A complete, frozen description of the mainnet boundary, for docs and tests. */
export const MAINNET_BOUNDARY = Object.freeze({
  chains: MAINNET_CHAIN_IDS,
  allowed: Object.freeze([...MAINNET_ALLOWED]),
  forbidden: Object.freeze(["send", "credit", "auto-recharge"] as const),
  note: "Real-money credit/send/auto-recharge is NO-GO; these capabilities have no mainnet implementation.",
});
