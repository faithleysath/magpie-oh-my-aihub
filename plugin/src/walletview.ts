// The wallet's presentation model: state, evidence and next steps.
//
// This module is pure. It performs no I/O, opens no socket, reads no file and
// never touches a Gateway Key. Its only job is to turn the accounting the plugin
// already keeps into something an operator can read without guessing, and to be
// strict about what may be claimed:
//
//   a receipt is not a payment, a payment is not a credit, a credit is not a
//   usable key. "Usable" requires `credited` + an applied ledger deposit + a
//   gateway read-back that still covers that credit.
//
// The model is also the parity layer for BSC and Base: both chains render the
// same shape, the same state words and the same totals, and the only permitted
// difference is the chain's own finality policy.

import type { ChainDepositEvent, ChainAnomaly } from "./chainstore.ts";
import type { DepositIntent } from "./deposits.ts";
import type { ChainEventTotals, WalletStatus } from "./wallet.ts";
import { formatTokenAmount, usdForRaw } from "./walletamount.ts";
import { nanosToUsd } from "./pricing.ts";

// --- inputs -----------------------------------------------------------------

/** A ledger deposit, structurally (so the ledger type stays the source of truth). */
export interface LedgerDepositLike {
  id: string;
  consumerId: string;
  amountNanos: number;
  source: string;
  status: "intent" | "applied" | "failed";
  priceVersion: string | null;
  capAfterNanos: number | null;
  createdAt: string;
  appliedAt: string | null;
  error: string | null;
}

/**
 * A successful `GET /v1/magpie/limit` read. `fromGateway` must be true: a value
 * copied from `lastCheck` is a record of an older read, not evidence now.
 */
export interface KeyReadback {
  at: string;
  capUsd: number;
  usedUsd: number;
  leftUsd: number;
  fromGateway: boolean;
}

/** The structural subset of `ConsumerView` this model reads. */
export interface ConsumerEvidence {
  consumerId: string;
  keyName: string;
  models: string[];
  capUsd: number;
  usedUsd: number | null;
  leftUsd: number | null;
  calls: number | null;
  spent: boolean | null;
  reset: string | null;
  pending: boolean;
  paused: {
    reason: string;
    detail: string;
    enforcement: string;
    enforced: boolean;
    windowId: string | null;
  } | null;
  revokedAt: string | null;
  priceVersion: string | null;
  ledger: {
    priceVersion: string | null;
    windowId: string | null;
    start: string | null;
    reset: string | null;
    depositedUsd: number;
    consumedUsd: number;
    balanceUsd: number;
    overdraftUsd: number;
    unsettledUsd: number;
    unpricedCalls: number;
    openSettlements: number;
    uncertain: string | null;
    gaps: { logId: string; reason: string; resolvedAt: string | null; note: string | null }[];
  } | null;
}

export interface AccountingView {
  state: "ok" | "uncertain" | "unknown";
  reason: string | null;
  serving: boolean;
}

export interface WalletViewInput {
  wallet: WalletStatus;
  consumers?: ConsumerEvidence[];
  /** `ledger.depositsFor(id)`, keyed by consumer */
  deposits?: Record<string, LedgerDepositLike[]>;
  /** `Provisioner.verify()` results, keyed by consumer */
  readbacks?: Record<string, KeyReadback>;
  accounting?: AccountingView | null;
  now?: Date;
}

// --- output -----------------------------------------------------------------

export type DepositState =
  | "awaiting-signature"
  | "payment-not-seen"
  | "observed"
  | "verifying"
  | "confirming"
  | "finality-reached"
  | "crediting"
  | "unproven"
  | "credited"
  | "unclaimed"
  | "uncertain"
  | "reverted"
  | "manual-review"
  | "failed"
  | "expired"
  | "cancelled";

export type StepId = "signature" | "payment" | "verification" | "confirmations" | "finality" | "ledger" | "key";
export type StepState = "done" | "current" | "pending" | "blocked" | "unknown" | "not-applicable";

export interface JourneyStep {
  id: StepId;
  label: string;
  state: StepState;
  at: string | null;
  detail: string;
}

export interface DepositJourney {
  invoiceId: string | null;
  consumerId: string | null;
  chainId: number;
  chainName: string;
  assetId: string | null;
  symbol: string | null;
  decimals: number | null;
  amountRaw: string | null;
  amountTokens: string | null;
  expectedUsd: number | null;
  creditedUsd: number | null;
  state: DepositState;
  stateDetail: string;
  updatedAt: string | null;
  requestedAt: string | null;
  expiresAt: string | null;
  txHash: string | null;
  logIndex: number | null;
  blockNumber: number | null;
  confirmations: number | null;
  explorerUrl: string | null;
  steps: JourneyStep[];
  nextStep: string;
  retry: string | null;
  keyUsable: boolean;
  keyUsableReason: string;
}

export type KeyState = "usable" | "usable-but-export-withdrawn" | "spent" | "paused" | "revoked" | "no-key" | "unverified" | "unproven" | "unknown";

export interface ConsumerAccounting {
  consumerId: string;
  keyName: string | null;
  models: string[];
  state: KeyState;
  stateDetail: string;
  capUsd: number | null;
  usedUsd: number | null;
  leftUsd: number | null;
  calls: number | null;
  spent: boolean | null;
  readback: { at: string | null; fromGateway: boolean };
  cumulativeCreditUsd: number | null;
  /** the ledger's settled consumption total (all windows) */
  consumedUsd: number | null;
  /** consumed minus charges the ledger could not price; never negative */
  settledUsd: number | null;
  appliedCreditUsd: number;
  pendingDeposits: number;
  balanceUsd: number | null;
  overdraftUsd: number | null;
  unsettledUsd: number | null;
  openSettlements: number;
  unpricedCalls: number;
  priceVersion: string | null;
  windowEnd: string | null;
  accounting: AccountingView;
  paused: ConsumerEvidence["paused"];
  chainCredit: {
    chainId: number;
    displayName: string;
    creditedEvents: number;
    creditedUsd: number;
    pendingEvents: number;
    unclaimedEvents: number;
    uncertainEvents: number;
    revertedEvents: number;
    manualReviewEvents: number;
  }[];
  updatedAt: string | null;
}

export interface ChainView {
  chainId: number;
  displayName: string;
  networkType: string;
  enabled: boolean;
  blockExplorer: string;
  finality: { mode: string; confirmations: number; rationale: string };
  head: number | null;
  finalizedBlock: number | null;
  cursor: number | null;
  lagBlocks: number | null;
  lastScanAt: string | null;
  lastError: string | null;
  probed: boolean;
  rpc: { url: string; ok: boolean; lastError: string | null }[];
  totals: ChainEventTotals;
  assets: {
    assetId: string;
    symbol: string;
    decimals: number;
    enabled: boolean;
    nanosPerToken: string;
    priceVersion: string;
    onchainDecimals: number | null;
    decimalsOk: boolean | null;
  }[];
}

export type WalletAlertKind =
  | "unclaimed"
  | "uncertain"
  | "reverted"
  | "manual-review"
  | "failed"
  | "credit-failure"
  | "ledger-failure"
  | "rate-mismatch"
  | "finality-unavailable"
  | "rpc-disagreement"
  | "cursor-gap"
  | "over-credit"
  | "bad-log"
  | "credit-unproven"
  | "reorg"
  | "accounting-uncertain"
  | "consumer-paused"
  | "rpc-unavailable"
  | "never-scanned";

export interface WalletAlert {
  severity: "info" | "warning" | "critical";
  kind: WalletAlertKind;
  chainId: number | null;
  consumerId: string | null;
  at: string | null;
  detail: string;
  nextStep: string;
}

export interface WalletView {
  generatedAt: string;
  disabled: boolean;
  chains: ChainView[];
  deposits: DepositJourney[];
  consumers: ConsumerAccounting[];
  alerts: WalletAlert[];
  /** true when the bounded history lists were filled, so older rows may be absent */
  truncated: boolean;
  evidence: { readbacks: number; appliedDeposits: number; note: string };
}

// --- helpers ----------------------------------------------------------------

export function explorerTxUrl(blockExplorer: string, txHash: string): string {
  return `${String(blockExplorer).replace(/\/+$/, "")}/tx/${txHash}`;
}

const STEP_LABELS: Record<StepId, string> = {
  signature: "Signature",
  payment: "Transfer seen",
  verification: "Receipt verified",
  confirmations: "Confirmations",
  finality: "Finality",
  ledger: "Ledger deposit",
  key: "Gateway key cap",
};

function step(id: StepId, state: StepState, detail: string, at: string | null = null): JourneyStep {
  return { id, label: STEP_LABELS[id], state, at, detail };
}

function isoMax(values: (string | null | undefined)[]): string | null {
  let out: string | null = null;
  for (const v of values) if (v && (!out || v > out)) out = v;
  return out;
}

function retryCommand(chainId: number): string {
  return `bun plugin/bin/ohmyaihub.ts --data <magpie config dir> wallet scan ${chainId}`;
}

// --- the model --------------------------------------------------------------

export function walletView(input: WalletViewInput): WalletView {
  const now = input.now ?? new Date();
  const wallet = input.wallet;
  const consumers = input.consumers ?? [];
  const depositsByConsumer = input.deposits ?? {};
  const readbacks = input.readbacks ?? {};
  const accounting: AccountingView = input.accounting ?? { state: "unknown", reason: null, serving: true };

  const assets = new Map(wallet.registry.assets.map((a) => [a.assetId, a]));
  const networks = new Map(wallet.registry.networks.map((n) => [n.chainId, n]));
  const health = new Map(wallet.chains.map((c) => [c.chainId, c]));
  const consumerById = new Map(consumers.map((c) => [c.consumerId, c]));
  const consumerCredits = new Map((wallet.consumers ?? []).map((c) => [c.consumerId, c]));

  const eventByInvoice = new Map<string, ChainDepositEvent>();
  for (const e of wallet.events) if (e.invoiceId) eventByInvoice.set(e.invoiceId, e);
  const intentById = new Map(wallet.intents.map((i) => [i.invoiceId, i]));

  const byChainTotals = wallet.totals.byChain ?? [];
  const totalsFor = (chainId: number): ChainEventTotals =>
    byChainTotals.find((b) => b.chainId === chainId) ??
    byChainTotals[0] ?? {
      credited: 0,
      finalized: 0,
      crediting: 0,
      pending: 0,
      unclaimed: 0,
      uncertain: 0,
      reverted: 0,
      manualReview: 0,
      failed: 0,
      creditedNanos: 0,
      events: 0,
    };

  const chains: ChainView[] = wallet.registry.networks.map((n) => {
    const h = health.get(n.chainId);
    return {
      chainId: n.chainId,
      displayName: n.displayName,
      networkType: n.networkType,
      enabled: n.enabled,
      blockExplorer: n.blockExplorer,
      finality: { ...n.finality },
      head: h?.head ?? null,
      finalizedBlock: h?.finalizedBlock ?? null,
      cursor: h?.cursor ?? null,
      lagBlocks: h?.lagBlocks ?? null,
      lastScanAt: h?.lastScanAt ?? null,
      lastError: h?.lastError ?? null,
      probed: (h?.endpoints?.length ?? 0) > 0,
      rpc: (h?.endpoints ?? []).map((e) => ({ url: e.url, ok: e.ok, lastError: e.lastError })),
      totals: totalsFor(n.chainId),
      assets: wallet.registry.assets
        .filter((a) => a.chainId === n.chainId)
        .map((a) => {
          const measured = h?.assets.find((x) => x.assetId === a.assetId);
          return {
            assetId: a.assetId,
            symbol: a.symbol,
            decimals: a.decimals,
            enabled: a.enabled,
            nanosPerToken: a.nanosPerToken,
            priceVersion: a.priceVersion,
            onchainDecimals: measured?.onchainDecimals ?? null,
            decimalsOk: measured?.decimalsOk ?? null,
          };
        }),
    };
  });

  const depositFor = (consumerId: string | null, depositId: string | null): LedgerDepositLike | null => {
    if (!consumerId || !depositId) return null;
    return (depositsByConsumer[consumerId] ?? []).find((d) => d.id === depositId) ?? null;
  };

  const journeys: DepositJourney[] = [];

  const buildJourney = (event: ChainDepositEvent | null, intent: DepositIntent | null): DepositJourney => {
    const chainId = event?.chainId ?? intent?.chainId ?? 0;
    const net = networks.get(chainId);
    const byContract = event
      ? wallet.registry.assets.find((a) => a.chainId === event.chainId && a.contractAddress.toLowerCase() === event.tokenContract.toLowerCase()) ?? null
      : null;
    const resolvedAsset = (intent ? assets.get(intent.assetId) ?? null : null) ?? byContract;
    const consumerId = intent?.consumerId ?? null;
    const consumer = consumerId ? consumerById.get(consumerId) ?? null : null;
    // An event only carries `depositId` after it is credited. While it is being
    // applied, the deposit id is the deterministic `chain:<event id>` the watcher
    // uses, so the booked-but-unapplied row can still be shown.
    const deposit =
      depositFor(consumerId, event?.depositId ?? null) ??
      (event && consumerId ? (depositsByConsumer[consumerId] ?? []).find((d) => d.id === `chain:${event.id}`) ?? null : null);
    const readback = consumerId ? readbacks[consumerId] ?? null : null;
    const raw = event?.amountRaw ?? intent?.expectedAmountRaw ?? null;
    const decimals = resolvedAsset?.decimals ?? intent?.rateDecimals ?? null;
    const amountTokens = raw && decimals !== null ? formatTokenAmount(raw, decimals) : null;
    const expectedUsd =
      intent && raw && decimals !== null
        ? safeUsd(raw, decimals, intent.rateNanosPerToken ?? resolvedAsset?.nanosPerToken ?? null)
        : null;
    const creditedUsd = event?.creditedNanos !== null && event?.creditedNanos !== undefined ? nanosToUsd(event.creditedNanos) : null;

    const key = assessKey({ consumer, deposit, readback, accounting, requireAppliedDeposit: true });
    const state = depositState({ event, intent, deposit, key, readback, intents: wallet.intents });
    const explorerUrl = event && net ? explorerTxUrl(net.blockExplorer, event.txHash) : null;

    const steps: JourneyStep[] = [];
    // signature
    if (!intent) {
      steps.push(step("signature", "not-applicable", "no signed request is loaded for this transfer"));
    } else if (intent.payerAddress) {
      steps.push(step("signature", "done", `signed by ${intent.payerAddress}; the plugin records the payer, not a signature timestamp`));
    } else if (intent.status === "expired") {
      steps.push(step("signature", "blocked", `the request expired at ${intent.expiresAt}; a transfer sent after it is unclaimed`, intent.expiresAt));
    } else if (intent.status === "cancelled") {
      steps.push(step("signature", "blocked", "the request was cancelled"));
    } else {
      steps.push(step("signature", "current", `sign the EIP-712 document with the paying wallet, then submit the signature; expires ${intent.expiresAt}`));
    }

    // payment
    if (event) {
      steps.push(step("payment", "done", `${event.txHash}:${event.logIndex} in block ${event.blockNumber}`, event.firstSeenAt));
    } else if (intent?.status === "matched" || intent?.attributionStatus === "matched") {
      steps.push(step("payment", "unknown", "the request says it matched a transfer, but the event is older than the loaded history"));
    } else if (intent?.payerAddress) {
      steps.push(step("payment", "current", "the chain has not shown this transfer yet"));
    } else {
      steps.push(step("payment", "pending", "waiting for a signature first"));
    }

    // verification
    if (!event) {
      steps.push(step("verification", "pending", "waiting for the transfer"));
    } else if (event.status === "failed") {
      steps.push(step("verification", "blocked", event.reason ?? "the transaction reverted", event.updatedAt));
    } else if (event.status === "manualReview") {
      steps.push(step("verification", "unknown", event.reason ?? "needs a human", event.updatedAt));
    } else if (event.status === "uncertain" && ambiguous(event, intent, wallet.intents)) {
      steps.push(step("verification", "done", "the receipt is valid; more than one request matches", event.updatedAt));
    } else if (event.status === "uncertain") {
      steps.push(step("verification", "current", event.reason ?? "the receipt could not be read yet", event.updatedAt));
    } else {
      steps.push(step("verification", "done", "the transaction succeeded and contains this transfer", event.updatedAt));
    }

    // confirmations
    const policy = net?.finality;
    if (!event) {
      steps.push(step("confirmations", "pending", "waiting for the transfer"));
    } else if (policy?.mode === "finalized-tag") {
      const reached = health.get(event.chainId)?.finalizedBlock ?? null;
      const done =
        event.finalizedAt !== null || ["finalized", "crediting", "credited"].includes(event.status) || (reached !== null && reached >= event.blockNumber);
      steps.push(
        step(
          "confirmations",
          done ? "done" : "current",
          done
            ? `the chain's finalized tag reached block ${reached}`
            : `waiting for the finalized tag: ${reached === null ? "not answered by the RPC" : `${reached} < payment block ${event.blockNumber}`}`,
          done ? event.finalizedAt ?? event.updatedAt : event.updatedAt,
        ),
      );
    } else if (policy) {
      const need = policy.confirmations;
      const done = event.confirmations >= need || ["finalized", "crediting", "credited"].includes(event.status) || event.finalizedAt !== null;
      steps.push(
        step(
          "confirmations",
          done ? "done" : "current",
          done ? `${event.confirmations} confirmations (policy ${need})` : `${event.confirmations}/${need} confirmations`,
          event.updatedAt,
        ),
      );
    } else {
      steps.push(step("confirmations", "unknown", "no finality policy is loaded for this chain"));
    }

    // finality
    if (!event) {
      steps.push(step("finality", "pending", "waiting for the transfer"));
    } else if (event.status === "reverted") {
      steps.push(
        step(
          "finality",
          "blocked",
          event.finalizedAt ? `finality was reached at ${event.finalizedAt}, then the block moved` : "the block moved before finality",
          event.updatedAt,
        ),
      );
    } else if (event.finalizedAt || ["finalized", "crediting", "credited"].includes(event.status)) {
      steps.push(step("finality", "done", "the chain's finality condition is satisfied", event.finalizedAt ?? event.updatedAt));
    } else {
      steps.push(step("finality", "pending", "not final yet; nothing is credited before finality"));
    }

    // ledger
    if (deposit?.status === "applied") {
      steps.push(
        step(
          "ledger",
          "done",
          `deposit ${deposit.id} applied${deposit.capAfterNanos !== null ? `; cap after ${nanosToUsd(deposit.capAfterNanos).toFixed(6)} test USD` : ""}`,
          deposit.appliedAt,
        ),
      );
    } else if (deposit?.status === "intent" && event && ["reverted", "failed", "manualReview"].includes(event.status)) {
      steps.push(
        step(
          "ledger",
          "blocked",
          `booked but never applied: the event is ${event.status}, so this credit cannot reach the key`,
          deposit.createdAt,
        ),
      );
    } else if (deposit?.status === "intent") {
      steps.push(step("ledger", "current", `booked but not applied${deposit.error ? `: ${deposit.error}` : ""}`, deposit.createdAt));
    } else if (deposit?.status === "failed") {
      steps.push(step("ledger", "blocked", deposit.error ?? "the ledger refused this deposit", deposit.createdAt));
    } else if (event && !intent) {
      steps.push(step("ledger", "not-applicable", "an unclaimed transfer has no ledger deposit and is never credited"));
    } else if (event?.status === "credited") {
      steps.push(step("ledger", "unknown", "the event says credited, but no applied ledger deposit was supplied", event.creditedAt));
    } else {
      steps.push(step("ledger", "pending", "no ledger deposit yet"));
    }

    // key
    if (!consumer) {
      steps.push(step("key", "not-applicable", "no consumer key is involved in this transfer"));
    } else if (key.usable) {
      steps.push(step("key", "done", key.detail, readback?.at ?? null));
    } else if (key.state === "paused" || key.state === "revoked" || key.state === "spent") {
      steps.push(step("key", "blocked", key.detail));
    } else {
      steps.push(step("key", "current", key.detail));
    }

    return {
      invoiceId: event?.invoiceId ?? intent?.invoiceId ?? null,
      consumerId,
      chainId,
      chainName: net?.displayName ?? `chain ${chainId}`,
      assetId: resolvedAsset?.assetId ?? intent?.assetId ?? null,
      symbol: resolvedAsset?.symbol ?? null,
      decimals,
      amountRaw: raw,
      amountTokens,
      expectedUsd,
      creditedUsd,
      state,
      stateDetail: journeyDetail(state, event, intent, key),
      updatedAt: isoMax([event?.updatedAt, event?.creditedAt, intent?.requestedAt, deposit?.createdAt, deposit?.appliedAt]),
      requestedAt: intent?.requestedAt ?? null,
      expiresAt: intent?.expiresAt ?? null,
      txHash: event?.txHash ?? null,
      logIndex: event?.logIndex ?? null,
      blockNumber: event?.blockNumber ?? null,
      confirmations: event?.confirmations ?? null,
      explorerUrl,
      steps,
      nextStep: nextStepFor(state, { event, intent, asset: resolvedAsset, net: net ?? null, key, readback }),
      retry: ["verifying", "crediting", "observed"].includes(state) ? retryCommand(chainId) : null,
      keyUsable: key.usable,
      keyUsableReason: key.reason,
    };
  };

  // An event that could not be claimed has no invoice id. Showing it as a bare
  // row next to the request the operator is waiting on would read like two
  // different payments, so a single *display* match is folded into one journey.
  // This never claims, credits or changes an event: attribution stays the
  // watcher's decision, and two or more candidates are left separate on purpose.
  const remainingIntents = new Map(wallet.intents.filter((i) => !eventByInvoice.has(i.invoiceId)).map((i) => [i.invoiceId, i]));
  for (const event of wallet.events) {
    let intent = event.invoiceId ? intentById.get(event.invoiceId) ?? null : null;
    if (!intent) {
      const candidates = [...remainingIntents.values()].filter((i) => displayMatches(i, event));
      if (candidates.length === 1) {
        intent = candidates[0]!;
        remainingIntents.delete(intent.invoiceId);
      }
    }
    journeys.push(buildJourney(event, intent));
  }
  for (const intent of remainingIntents.values()) {
    journeys.push(buildJourney(null, intent));
  }
  journeys.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  const accountingRows: ConsumerAccounting[] = consumers.map((c) => {
    const walletCredit = consumerCredits.get(c.consumerId);
    const own = depositsByConsumer[c.consumerId] ?? [];
    const readback = readbacks[c.consumerId] ?? null;
    const key = assessKey({ consumer: c, deposit: null, readback, accounting });
    const applied = own.filter((d) => d.status === "applied");
    const appliedCreditUsd = applied.reduce((s, d) => s + nanosToUsd(d.amountNanos), 0);
    const lastLedgerAt = isoMax(own.map((d) => d.appliedAt ?? d.createdAt));
    const state: KeyState = key.state;
    return {
      consumerId: c.consumerId,
      keyName: c.keyName,
      models: [...c.models],
      state,
      stateDetail: key.detail,
      capUsd: c.capUsd,
      usedUsd: c.usedUsd,
      leftUsd: c.leftUsd,
      calls: c.calls,
      spent: c.spent,
      readback: { at: readback?.at ?? null, fromGateway: readback?.fromGateway === true },
      cumulativeCreditUsd: c.ledger?.depositedUsd ?? (appliedCreditUsd || null),
      consumedUsd: c.ledger?.consumedUsd ?? null,
      settledUsd: c.ledger ? Math.max(0, c.ledger.consumedUsd - c.ledger.unsettledUsd) : null,
      appliedCreditUsd,
      pendingDeposits: own.filter((d) => d.status === "intent").length,
      balanceUsd: c.ledger?.balanceUsd ?? null,
      overdraftUsd: c.ledger?.overdraftUsd ?? null,
      unsettledUsd: c.ledger?.unsettledUsd ?? null,
      openSettlements: c.ledger?.openSettlements ?? 0,
      unpricedCalls: c.ledger?.unpricedCalls ?? 0,
      priceVersion: c.priceVersion ?? c.ledger?.priceVersion ?? null,
      windowEnd: c.reset ?? c.ledger?.reset ?? null,
      accounting,
      paused: c.paused,
      chainCredit: wallet.registry.networks.map((n) => {
        const row = walletCredit?.chainCredit.find((x) => x.chainId === n.chainId);
        return {
          chainId: n.chainId,
          displayName: n.displayName,
          creditedEvents: row?.credited ?? 0,
          creditedUsd: row ? nanosToUsd(row.creditedNanos) : 0,
          pendingEvents: row?.pending ?? 0,
          unclaimedEvents: row?.unclaimed ?? 0,
          uncertainEvents: row?.uncertain ?? 0,
          revertedEvents: row?.reverted ?? 0,
          manualReviewEvents: row?.manualReview ?? 0,
        };
      }),
      updatedAt: isoMax([walletCredit?.updatedAt, lastLedgerAt]),
    };
  });

  const alerts: WalletAlert[] = [];
  for (const e of wallet.events) {
    if (e.status === "unclaimed") {
      alerts.push({
        severity: "warning",
        kind: "unclaimed",
        chainId: e.chainId,
        consumerId: consumerOfEvent(e, intentById),
        at: e.updatedAt,
        detail: `${e.txHash}:${e.logIndex} ${e.amountRaw} from ${e.fromAddress}: ${e.reason ?? "no signed request matches"}`,
        nextStep: "Nothing is lost and nothing was credited. Contact the provider with the transaction hash; do not resend.",
      });
    } else if (e.status === "uncertain") {
      alerts.push({
        severity: "warning",
        kind: "uncertain",
        chainId: e.chainId,
        consumerId: consumerOfEvent(e, intentById),
        at: e.updatedAt,
        detail: `${e.txHash}:${e.logIndex}: ${e.reason ?? "the plugin could not decide"}`,
        nextStep: "Wait for another scan; if it stays uncertain, review the matching requests manually.",
      });
    } else if (e.status === "reverted") {
      alerts.push({
        severity: "critical",
        kind: "reverted",
        chainId: e.chainId,
        consumerId: consumerOfEvent(e, intentById),
        at: e.updatedAt,
        detail: `${e.txHash}:${e.logIndex}: the block that carried this credit moved; the balance was not edited`,
        nextStep: "The consumer is paused. Review the reorg and use `consumers reissue` to resume; do not credit again.",
      });
    } else if (e.status === "manualReview") {
      alerts.push({
        severity: "warning",
        kind: "manual-review",
        chainId: e.chainId,
        consumerId: consumerOfEvent(e, intentById),
        at: e.updatedAt,
        detail: `${e.txHash}:${e.logIndex}: ${e.reason ?? "needs a human"}`,
        nextStep: "Inspect the event, the token registry and the request; nothing is credited automatically.",
      });
    } else if (e.status === "failed") {
      alerts.push({
        severity: "info",
        kind: "failed",
        chainId: e.chainId,
        consumerId: consumerOfEvent(e, intentById),
        at: e.updatedAt,
        detail: `${e.txHash}:${e.logIndex}: ${e.reason ?? "the transaction reverted"}`,
        nextStep: "This transaction is not a payment. Nothing to retry on it.",
      });
    }
  }
  for (const a of wallet.anomalies) {
    if (a.resolvedAt) continue;
    alerts.push({
      severity: a.kind === "reorg" || a.kind === "over-credit" ? "critical" : "warning",
      kind: a.kind,
      chainId: a.chainId,
      consumerId: null,
      at: a.at,
      detail: a.detail,
      nextStep: anomalyNextStep(a),
    });
  }
  for (const c of chains) {
    if (!c.enabled) continue;
    if (c.lastError) {
      alerts.push({
        severity: "warning",
        kind: "rpc-unavailable",
        chainId: c.chainId,
        consumerId: null,
        at: c.lastScanAt,
        detail: `chain ${c.chainId}: ${c.lastError}`,
        nextStep: "An RPC error is not a failed payment. The cursor did not advance; the next scan retries the same range.",
      });
    } else if (!c.probed && c.cursor === null) {
      alerts.push({
        severity: "info",
        kind: "never-scanned",
        chainId: c.chainId,
        consumerId: null,
        at: null,
        detail: `chain ${c.chainId} has never completed a scan`,
        nextStep: `Run \`wallet scan ${c.chainId}\` (or start the wallet) so deposits can be observed.`,
      });
    }
  }
  if (accounting.state === "uncertain") {
    alerts.push({
      severity: "critical",
      kind: "accounting-uncertain",
      chainId: null,
      consumerId: null,
      at: null,
      detail: accounting.reason ?? "the accounting check cannot prove the books",
      nextStep: "The overlay publication is withdrawn while this lasts. Resolve the reported cause; a top-up does not clear it.",
    });
  }
  for (const c of consumers) {
    if (!c.paused) continue;
    alerts.push({
      severity: "warning",
      kind: "consumer-paused",
      chainId: null,
      consumerId: c.consumerId,
      at: null,
      detail: `${c.consumerId} paused: ${c.paused.reason} (${c.paused.enforcement}${c.paused.enforced ? "" : ", NOT stopped"}) — ${c.paused.detail}`,
      nextStep: "A deposit is still booked while paused, but only `consumers reissue` (or `consumers resolve-gap`) makes it usable. A top-up does not unpause the key.",
    });
  }
  // A credited event without an applied deposit or a read-back is the one state
  // that must never be quiet.
  for (const journey of journeys) {
    if (journey.state === "unproven") {
      alerts.push({
        severity: "warning",
        kind: "credit-unproven",
        chainId: journey.chainId,
        consumerId: journey.consumerId,
        at: journey.updatedAt,
        detail: `${journey.txHash ?? journey.invoiceId ?? "deposit"}: ${journey.keyUsableReason}`,
        nextStep: journey.nextStep,
      });
    }
  }
  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || (b.at ?? "").localeCompare(a.at ?? ""));

  return {
    generatedAt: now.toISOString(),
    disabled: wallet.disabled,
    chains,
    deposits: journeys,
    consumers: accountingRows,
    alerts,
    truncated: wallet.intents.length >= 100 || wallet.events.length >= 200,
    evidence: {
      readbacks: Object.values(readbacks).filter((r) => r?.fromGateway).length,
      appliedDeposits: Object.values(depositsByConsumer).flat().filter((d) => d.status === "applied").length,
      note: "A key is usable only with a credited event, an applied ledger deposit and a gateway read-back.",
    },
  };
}

// --- private decisions ------------------------------------------------------

function safeUsd(raw: string, decimals: number, nanosPerToken: string | null): number | null {
  if (!nanosPerToken) return null;
  try {
    return usdForRaw({ raw, decimals, nanosPerToken });
  } catch {
    return null;
  }
}

/** Same evidence `candidatesFor` uses, for display only. Never used to credit. */
function displayMatches(intent: DepositIntent, event: ChainDepositEvent): boolean {
  return (
    intent.chainId === event.chainId &&
    intent.tokenContract.toLowerCase() === event.tokenContract.toLowerCase() &&
    intent.recipientAddress.toLowerCase() === event.toAddress.toLowerCase() &&
    intent.payerAddress?.toLowerCase() === event.fromAddress.toLowerCase() &&
    intent.expectedAmountRaw === event.amountRaw
  );
}

function consumerOfEvent(event: ChainDepositEvent, intents: Map<string, DepositIntent>): string | null {
  if (!event.invoiceId) return null;
  return intents.get(event.invoiceId)?.consumerId ?? null;
}

function ambiguous(event: ChainDepositEvent, intent: DepositIntent | null, intents: DepositIntent[]): boolean {
  if (event.status !== "uncertain") return false;
  const matches = intents.filter((i) => displayMatches(i, event) && ["signed", "matched"].includes(i.status));
  if (matches.length > 1) return true;
  // fall back to the recorded reason only when the loaded history cannot prove it
  return /intents? match/i.test(event.reason ?? "");
}

interface KeyAssessment {
  usable: boolean;
  state: KeyState;
  detail: string;
  reason: string;
}

function assessKey(input: {
  consumer: ConsumerEvidence | null;
  /** a specific deposit when assessing one journey; null for the consumer panel */
  deposit: LedgerDepositLike | null;
  readback: KeyReadback | null;
  accounting: AccountingView;
  /** a credited event must show the deposit that applied it */
  requireAppliedDeposit?: boolean;
}): KeyAssessment {
  const { consumer, deposit, readback, accounting, requireAppliedDeposit } = input;
  if (!consumer) {
    return { usable: false, state: "unknown", detail: "no consumer record is loaded for this credit", reason: "no consumer record" };
  }
  if (consumer.revokedAt) {
    return { usable: false, state: "revoked", detail: `the key was revoked at ${consumer.revokedAt}`, reason: "key revoked" };
  }
  if (consumer.paused) {
    return {
      usable: false,
      state: "paused",
      detail: `paused: ${consumer.paused.reason} (${consumer.paused.enforcement}${consumer.paused.enforced ? "" : ", NOT stopped"}) — ${consumer.paused.detail}`,
      reason: `paused: ${consumer.paused.reason}`,
    };
  }
  if (requireAppliedDeposit && !deposit) {
    return {
      usable: false,
      state: "unverified",
      detail: "no applied ledger deposit has been supplied for this credit yet",
      reason: "credit not proven applied to the key",
    };
  }
  if (deposit && deposit.status !== "applied") {
    return {
      usable: false,
      state: "unverified",
      detail: deposit.status === "intent" ? "the ledger deposit is booked but not applied" : "the ledger deposit failed",
      reason: "the credit is not applied to the key",
    };
  }
  if (deposit && !deposit.appliedAt) {
    return { usable: false, state: "unverified", detail: "the applied deposit has no application time", reason: "credit not proven applied" };
  }
  if (!readback || !readback.fromGateway) {
    const hint = consumer.ledger?.uncertain ? ` Magpie said: ${consumer.ledger.uncertain}` : "";
    return {
      usable: false,
      state: "unverified",
      detail: `no gateway read-back of this key's limit.${hint}`,
      reason: "no gateway read-back; the key cannot be called usable",
    };
  }
  if (readback.capUsd <= 0) {
    return {
      usable: false,
      state: "unproven",
      detail: `Magpie reports a cap of 0, which means unlimited, not "no credit"; the plugin will not treat it as a usable prepaid key`,
      reason: "cap 0 means unlimited; no prepaid limit is proven",
    };
  }
  if (deposit && deposit.appliedAt && readback.at < deposit.appliedAt) {
    return {
      usable: false,
      state: "unverified",
      detail: `the read-back (${readback.at}) is older than the applied deposit (${deposit.appliedAt})`,
      reason: "the read-back predates the credit",
    };
  }
  if (deposit && deposit.capAfterNanos !== null && readback.capUsd + 1e-9 < deposit.capAfterNanos / 1_000_000_000) {
    return {
      usable: false,
      state: "unproven",
      detail: `the read-back cap ${readback.capUsd} is below the applied credit's cap ${(deposit.capAfterNanos / 1_000_000_000).toFixed(4)}`,
      reason: "the read-back does not cover this credit",
    };
  }
  if (readback.leftUsd <= 0) {
    return {
      usable: false,
      state: "spent",
      detail: `the key has no credit left (used ${readback.usedUsd} of ${readback.capUsd})`,
      reason: "the key is spent; the next call is refused by Magpie",
    };
  }
  if (consumer.pending) {
    return { usable: false, state: "unverified", detail: "a deposit is still pending between Magpie and the local record", reason: "a deposit is pending" };
  }
  if (accounting.state === "uncertain") {
    return {
      usable: true,
      state: "usable-but-export-withdrawn",
      detail: `the key's cap is read back, but the accounting check withdrew the overlay publication: ${accounting.reason ?? "unknown reason"}`,
      reason: `credit applied and cap read back from Magpie (read-back at ${readback.at}); the key is not published while accounting is uncertain`,
    };
  }
  return {
    usable: true,
    state: "usable",
    detail: `cap ${readback.capUsd} read back at ${readback.at} (used ${readback.usedUsd}, left ${readback.leftUsd}); key ${consumer.keyName}`,
    reason: `credit applied and cap read back from Magpie (read-back at ${readback.at})`,
  };
}

function depositState(input: {
  event: ChainDepositEvent | null;
  intent: DepositIntent | null;
  deposit: LedgerDepositLike | null;
  key: KeyAssessment;
  readback: KeyReadback | null;
  intents: DepositIntent[];
}): DepositState {
  const { event, intent, key, intents } = input;
  if (event) {
    switch (event.status) {
      case "reverted":
        return "reverted";
      case "failed":
        return "failed";
      case "manualReview":
        return "manual-review";
      case "unclaimed":
        return "unclaimed";
      case "uncertain":
        return ambiguous(event, intent, intents) ? "uncertain" : "verifying";
      case "credited":
        return key.usable ? "credited" : "unproven";
      case "crediting":
        return "crediting";
      case "finalized":
        return "finality-reached";
      case "confirming":
        return "confirming";
      case "observed":
        return "observed";
    }
  }
  if (intent) {
    if (intent.status === "cancelled") return "cancelled";
    if (intent.status === "expired") return "expired";
    if (intent.payerAddress || intent.attributionStatus === "signed" || intent.attributionStatus === "matched") return "payment-not-seen";
    return "awaiting-signature";
  }
  return "payment-not-seen";
}

function journeyDetail(state: DepositState, event: ChainDepositEvent | null, intent: DepositIntent | null, key: KeyAssessment): string {
  switch (state) {
    case "awaiting-signature":
      return `a signed request exists only after the paying wallet signs it; expires ${intent?.expiresAt ?? "unknown"}`;
    case "payment-not-seen":
      return "the request is signed; the chain has not shown the transfer yet";
    case "observed":
      return "the transfer is stored and waiting for its receipt";
    case "verifying":
      return event?.reason ?? "the receipt is not readable yet; this is retryable";
    case "confirming":
      return event?.reason ?? "waiting for the chain's finality condition";
    case "finality-reached":
      return "the chain condition is satisfied, but the ledger has not applied the credit";
    case "crediting":
      return "the deposit is booked; the key's cap has not been written and read back";
    case "unproven":
      return key.detail;
    case "credited":
      return "credit applied to the key and read back from Magpie";
    case "unclaimed":
      return event?.reason ?? "no signed, unexpired request matches this transfer";
    case "uncertain":
      return event?.reason ?? "more than one request matches this transfer";
    case "reverted":
      return event?.reason ?? "the block that carried this credit moved";
    case "manual-review":
      return event?.reason ?? "this event needs a human";
    case "failed":
      return event?.reason ?? "the transaction reverted";
    case "expired":
      return "the request expired; a transfer sent after it is unclaimed, not lost";
    case "cancelled":
      return "the request was cancelled before any transfer";
  }
}

function nextStepFor(
  state: DepositState,
  input: { event: ChainDepositEvent | null; intent: DepositIntent | null; asset: { symbol: string; decimals: number } | null; net: { displayName: string; chainId: number } | null; key: KeyAssessment; readback: KeyReadback | null },
): string {
  const amount = input.intent && input.asset ? formatTokenAmount(input.intent.expectedAmountRaw, input.asset.decimals) : null;
  const what = amount && input.asset ? `${amount} ${input.asset.symbol}` : "the exact amount";
  switch (state) {
    case "awaiting-signature":
      return `Sign the EIP-712 request with the wallet that will pay, then submit the signature with \`wallet sign\`. Do not send anything before it is signed.`;
    case "payment-not-seen":
      return `Send exactly ${what} on ${input.net?.displayName ?? "the requested chain"} to the request's recipient. If it was already sent, wait for the next scan or run \`wallet scan ${input.net?.chainId ?? 0}\`.`;
    case "observed":
      return "The transfer is stored; waiting for the receipt. No action is needed and nothing is credited yet.";
    case "verifying":
      return "The receipt could not be read. This is retryable and does not mean the payment failed; the next scan retries it.";
    case "confirming":
      return "Waiting for the chain's own finality condition. Do not resend; a second transfer is not a second credit.";
    case "finality-reached":
      return "Finality is satisfied; the credit is not applied yet. Wait for the ledger step.";
    case "crediting":
      return `The deposit is booked but not applied to the key. Retry with \`wallet scan ${input.net?.chainId ?? 0}\`; if it keeps failing, check Magpie before doing anything else.`;
    case "unproven":
      return `The chain credit exists, but ${input.key.reason}. Re-read the key (\`wallet credit <consumer>\`) before calling it usable.`;
    case "credited":
      return "Credit applied and read back from Magpie. The key is usable.";
    case "unclaimed":
      return "The transfer is at the provider's address but matches no signed request. Nothing is lost and nothing was credited; contact the provider with the transaction hash. Do not resend.";
    case "uncertain":
      return "More than one request matches this transfer, so the plugin does not guess. Review the requests manually.";
    case "reverted":
      return "The block that carried this credit moved. The balance was not edited and the consumer is paused; review the reorg, then `consumers reissue`.";
    case "manual-review":
      return "A human must resolve this event: check the request, the token registry and the ledger. Nothing is credited automatically.";
    case "failed":
      return "The transaction reverted on chain; it is not a payment. There is nothing to retry on this transaction.";
    case "expired":
      return "The request expired before the transfer was seen. Funds sent afterwards are unclaimed, not lost. Create a new request if needed.";
    case "cancelled":
      return "The request was cancelled. Create a new one if credit is still wanted.";
  }
}

function anomalyNextStep(a: ChainAnomaly): string {
  switch (a.kind) {
    case "reorg":
      return "The consumer is frozen and the balance was not edited. Review the reorg, then `consumers reissue`.";
    case "credit-failure":
      return "The deposit is booked but not applied. Retry the scan; if it keeps failing, inspect Magpie's limit write before anything else.";
    case "ledger-failure":
      return "The ledger refused the deposit. Nothing was credited; inspect the ledger error.";
    case "rate-mismatch":
      return "The request's frozen rate no longer matches the registry. Do not reprice it; a human must resolve the intent.";
    case "finality-unavailable":
      return "The chain could not prove finality, so the credit is paused rather than assumed. The next scan retries.";
    case "rpc-disagreement":
      return "Two RPC answers disagreed. The event is not credited until the chain agrees with itself.";
    case "cursor-gap":
      return "The scan cursor was rewound. Re-scanning may re-observe rows; duplicate credits are prevented by the deposit id.";
    case "over-credit":
      return "A credit exceeds what the evidence supports. Stop and audit; do not add more credit.";
    case "bad-log":
      return "A log was refused before storage. No credit exists for it; inspect the log's token and topics.";
    default:
      return "Inspect the event and the chain before acting.";
  }
}

/** The one accounting line the CLI and the wizard both print. */
export function accountingLine(a: ConsumerAccounting): string {
  const money = (v: number | null) => (typeof v === "number" ? v.toFixed(6) : "?");
  return (
    `credit ${money(a.cumulativeCreditUsd)} · consumed ${money(a.consumedUsd)} · settled ${money(a.settledUsd)} · ` +
    `balance ${money(a.balanceUsd)} · overdraft ${money(a.overdraftUsd)} · unsettled ${money(a.unsettledUsd)} · ` +
    `cap ${money(a.capUsd)} · used ${money(a.usedUsd)} · price ${a.priceVersion?.slice(0, 12) ?? "?"}… · ` +
    `window ends ${a.windowEnd ?? "?"} · key ${a.state}`
  );
}

/** Plain-text CLI lines for one journey. No anchors, no hidden URLs. */
export function journeyLines(journey: DepositJourney): string[] {
  const lines = [
    `${journey.state.toUpperCase()}  ${journey.chainName}  ${journey.amountTokens ?? "?"} ${journey.symbol ?? ""}${journey.creditedUsd !== null ? ` (credited ${journey.creditedUsd.toFixed(6)} test USD)` : ""}`.trim(),
    `updated ${journey.updatedAt ?? "—"}${journey.invoiceId ? ` · request ${journey.invoiceId}` : ""}`,
  ];
  if (journey.txHash) lines.push(`tx ${journey.txHash}${journey.logIndex !== null ? `:${journey.logIndex}` : ""}${journey.explorerUrl ? ` — ${journey.explorerUrl}` : ""}`);
  lines.push(`next: ${journey.nextStep}`);
  if (journey.retry) lines.push(`retry: ${journey.retry}`);
  lines.push(`key usable: ${journey.keyUsable ? "yes" : "no"} — ${journey.keyUsableReason}`);
  return lines;
}
