// The provider's receiving-network selection.
//
// The product rule is simple and deliberately inconvenient: a provider starts
// with **no** receiving network. BSC and Base are peers; selecting one does not
// select the other, selecting both is allowed, and clearing one leaves the other
// alone. There is no default, no primary, no "first enabled chain" fallback and
// no code path that picks a chain on the user's behalf.
//
// The selection is not the same thing as a receiving address (that is still the
// per-chain address record used by the testnet watcher). It is the policy input
// that answers two questions:
//
//   1. may this provider issue a payment request on this chain?
//   2. may an event on this chain be credited to this provider?
//
// Both answers are refused for an unselected chain. A mainnet is refused even
// when selected, because this build is read-only for mainnets: `mainnet-gate.ts`
// is checked first, so selection cannot be used to unlock credit. A transfer
// that someone else makes on another chain is outside the plugin's control; the
// policy only decides whether this node will invoice or credit it, and the
// status text says so rather than pretending the transfer can be stopped.

import { existsSync, readFileSync } from "node:fs";
import { logger } from "./log.ts";
import { statePath } from "./paths.ts";
import { writeJsonAtomic } from "./store.ts";
import type { NetworkRecord, NetworkRegistry } from "./networks.ts";
import { assertNoMainnetCredit, isMainnetChainId } from "./mainnet-gate.ts";

export type PaymentRequestCode =
  | "allowed"
  | "unknown-network"
  | "not-a-product-network"
  | "receiving-network-not-selected"
  | "mainnet-credit-forbidden";

export interface PaymentRequestVerdict {
  allowed: boolean;
  code: PaymentRequestCode;
  reason: string;
}

export type CreditCode =
  | "allowed"
  | "unknown-network"
  | "not-a-product-network"
  | "receiving-network-not-selected";

export interface CreditVerdict {
  allowed: boolean;
  code: CreditCode;
  reason: string;
}

export interface ReceivingSelection {
  providerId: string;
  /** sorted ascending; empty means "no receiving network selected" */
  chainIds: number[];
  updatedAt: string | null;
}

interface ProviderSelection {
  chainIds: number[];
  updatedAt: string;
}

interface ReceivingDocument {
  version: 1;
  providers: Record<string, ProviderSelection>;
}

export interface ReceivingPolicyDeps {
  registry: NetworkRegistry;
  /** defaults to the plugin state dir; injectable for tests */
  path?: string;
  now?: () => Date;
}

function assertProviderId(providerId: unknown): string {
  if (typeof providerId !== "string" || !/^[\x21-\x7e]{1,64}$/.test(providerId)) {
    throw new Error("a receiving selection needs a provider id of 1-64 printable characters");
  }
  // The document is a plain JSON object; do not let a provider id mutate its
  // prototype or collide with inherited properties.
  if (providerId === "__proto__" || providerId === "constructor" || providerId === "prototype") {
    throw new Error("that provider id is reserved");
  }
  return providerId;
}

/**
 * Loads and validates the selection document. An unreadable or inconsistent
 * file is an error, not an empty selection: silently starting with no selection
 * would be safe, but silently starting with *some* selection would not, and the
 * operator needs to know which one happened.
 */
function readDocument(path: string, registry: NetworkRegistry): ReceivingDocument {
  if (!existsSync(path)) return { version: 1, providers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`the receiving-network selection at ${path} is unreadable: ${String((e as Error).message ?? e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`the receiving-network selection at ${path} is not an object`);
  const doc = raw as Partial<ReceivingDocument>;
  if (doc.version !== 1 || !doc.providers || typeof doc.providers !== "object" || Array.isArray(doc.providers)) {
    throw new Error(`the receiving-network selection at ${path} has an unsupported shape`);
  }
  const providers: Record<string, ProviderSelection> = {};
  for (const [providerId, value] of Object.entries(doc.providers)) {
    assertProviderId(providerId);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`provider ${providerId} has no selection record`);
    const row = value as Partial<ProviderSelection>;
    if (!Array.isArray(row.chainIds) || row.chainIds.length > 16) throw new Error(`provider ${providerId} has an invalid chain list`);
    const chainIds: number[] = [];
    for (const chainId of row.chainIds) {
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`provider ${providerId} has an invalid chain id`);
      if (chainIds.includes(chainId)) throw new Error(`provider ${providerId} selects chain ${chainId} twice`);
      // Fail closed if the persisted file names a chain the registry no longer
      // offers as a product receiving network.
      registry.requireReceivableNetwork(chainId);
      chainIds.push(chainId);
    }
    if (typeof row.updatedAt !== "string" || Number.isNaN(Date.parse(row.updatedAt))) {
      throw new Error(`provider ${providerId} has no valid selection timestamp`);
    }
    providers[providerId] = { chainIds: chainIds.sort((a, b) => a - b), updatedAt: row.updatedAt };
  }
  return { version: 1, providers };
}

export class ReceivingNetworkPolicy {
  private readonly registry: NetworkRegistry;
  private readonly path: string;
  private readonly now: () => Date;
  private doc: ReceivingDocument;

  constructor(deps: ReceivingPolicyDeps) {
    this.registry = deps.registry;
    this.path = deps.path ?? statePath("receiving-networks.json");
    this.now = deps.now ?? (() => new Date());
    this.doc = readDocument(this.path, this.registry);
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.path, this.doc);
    } catch (e) {
      // The in-memory selection stays as the caller set it, but a crash would
      // lose it; make that visible rather than claiming a durable write.
      logger.warn(`cannot persist the receiving-network selection: ${String(e)}`);
      throw e;
    }
  }

  /** The explicit selection of one provider. A missing provider is empty, never implied. */
  selectionFor(providerId: string): number[] {
    assertProviderId(providerId);
    return [...(this.doc.providers[providerId]?.chainIds ?? [])];
  }

  selection(providerId: string): ReceivingSelection {
    const chainIds = this.selectionFor(providerId);
    return { providerId, chainIds, updatedAt: this.doc.providers[providerId]?.updatedAt ?? null };
  }

  isSelected(providerId: string, chainId: number): boolean {
    return this.selectionFor(providerId).includes(chainId);
  }

  /**
   * Explicitly turns one product network on or off for one provider. Selecting
   * BSC never changes Base, and clearing the last chain leaves an empty set
   * rather than falling back to a default.
   */
  setSelected(providerId: string, chainId: number, selected: boolean): ReceivingSelection {
    assertProviderId(providerId);
    this.registry.requireReceivableNetwork(chainId);
    const current = this.doc.providers[providerId]?.chainIds ?? [];
    const has = current.includes(chainId);
    if (has === selected) return this.selection(providerId);
    const before = JSON.parse(JSON.stringify(this.doc)) as ReceivingDocument;
    const next = selected ? [...current, chainId].sort((a, b) => a - b) : current.filter((id) => id !== chainId);
    if (next.length === 0) delete this.doc.providers[providerId];
    else this.doc.providers[providerId] = { chainIds: next, updatedAt: this.now().toISOString() };
    try {
      this.persist();
    } catch (e) {
      // A failed write must not leave an in-memory selection that looks saved.
      this.doc = before;
      throw e;
    }
    return this.selection(providerId);
  }

  /** The product networks a provider may choose from, in registry order, no primary. */
  receivableNetworks(): NetworkRecord[] {
    return this.registry.receivableNetworks();
  }

  /**
   * Payment-request policy. An unselected chain is refused; a selected mainnet is
   * still refused because this build cannot promise a credit it is forbidden to
   * make. The two codes are deliberately different so the UI can say which one
   * applied.
   */
  paymentRequestVerdict(providerId: string, chainId: number): PaymentRequestVerdict {
    assertProviderId(providerId);
    const net = this.registry.network(chainId);
    if (!net) {
      return { allowed: false, code: "unknown-network", reason: `chain ${chainId} is not registered` };
    }
    if (!net.receivable) {
      return {
        allowed: false,
        code: "not-a-product-network",
        reason: `chain ${chainId} (${net.displayName}) is an internal test network, not a product receiving network`,
      };
    }
    if (!this.isSelected(providerId, chainId)) {
      return {
        allowed: false,
        code: "receiving-network-not-selected",
        reason: `收款网络 ${net.displayName} 未选择；请显式选择该网络后再发起付款请求`,
      };
    }
    if (isMainnetChainId(chainId) || net.support !== "credit") {
      return {
        allowed: false,
        code: "mainnet-credit-forbidden",
        reason:
          `${net.displayName} is read-only in this build: mainnet payment requests cannot be credited, sent or automatically recharged. ` +
          `Nothing was requested; a transfer made by someone else on another chain is not blocked or credited by this node.`,
      };
    }
    return { allowed: true, code: "allowed", reason: `${net.displayName} is selected and creditable` };
  }

  /** Throws unless a payment request on this chain is allowed. */
  requirePaymentRequest(providerId: string, chainId: number): NetworkRecord {
    const verdict = this.paymentRequestVerdict(providerId, chainId);
    if (!verdict.allowed) throw new Error(verdict.reason);
    return this.registry.network(chainId)!;
  }

  /**
   * Event-credit policy. The hard mainnet gate runs first: no selection can turn
   * a mainnet credit on. Then the chain must be a selected product network; a
   * testnet credit event is not accepted through this policy (it keeps the
   * existing watcher path unchanged).
   */
  creditVerdict(providerId: string, chainId: number): CreditVerdict {
    assertProviderId(providerId);
    assertNoMainnetCredit({ chainId, operation: "event credit" });
    const net = this.registry.network(chainId);
    if (!net) return { allowed: false, code: "unknown-network", reason: `chain ${chainId} is not registered` };
    if (!net.receivable) {
      return {
        allowed: false,
        code: "not-a-product-network",
        reason: `chain ${chainId} (${net.displayName}) is an internal test network; use the testnet watcher path, not the product receiving selection`,
      };
    }
    if (!this.isSelected(providerId, chainId)) {
      return {
        allowed: false,
        code: "receiving-network-not-selected",
        reason: `收款网络 ${net.displayName} 未选择；该链上的事件不会被本节点授信`,
      };
    }
    return { allowed: true, code: "allowed", reason: `${net.displayName} is selected` };
  }

  /** Throws unless an event on this chain may be credited. */
  requireCredit(providerId: string, chainId: number): void {
    const verdict = this.creditVerdict(providerId, chainId);
    if (!verdict.allowed) throw new Error(verdict.reason);
  }
}
