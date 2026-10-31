// The deposit watcher: chain logs in, one ledger credit out.
//
// One `ChainWatcher` per enabled network, each with its own cursor, its own
// finality policy and its own failure state. BSC being down must not stop Base,
// so nothing here is shared between chains except the store and the ledger.
//
// The pipeline is the phase-7 dataflow, in order, and each arrow is a separate,
// recorded step:
//
//   scan → observe (dedupe) → attribute (claim) → finality → credit → read back
//
// Rules that are enforced here rather than left to a caller:
//
//  - A log is stored once per `(chain, token, tx, logIndex)`; a rescan finds the
//    same row and only bumps `observations`.
//  - A log whose `to` is not the intent's recipient, or whose token is not on
//    the allowlist, is ignored (or kept `unclaimed`) — never credited.
//  - Nothing is credited before the chain's own finality policy is satisfied.
//  - Crediting goes through `Ledger.depositIntent` with the chain event's id, so
//    a crash between the ledger write and the Magpie cap write is recoverable by
//    `Provisioner.reconcile()` and cannot mint credit twice.
//  - A finalized-but-credited event is never credited again; the ledger's own
//    unique deposit id is the guard.
//  - A reorg of a credited event marks it `reverted`, writes an anomaly and asks
//    the ledger to pause the consumer. It never deletes the deposit.

import { logger } from "./log.ts";
import type { EvmClient, EvmLog } from "./evm.ts";
import { EvmClient as Client } from "./evm.ts";
import { chainEventId, type ChainDepositEvent, type ChainStore } from "./chainstore.ts";
import { assetIdOf, type AssetRecord, type NetworkRecord, type NetworkRegistry } from "./networks.ts";
import { matchesTransfer, isExpired, type DepositIntent } from "./deposits.ts";
import { keccak256Hex } from "./keccak.ts";
import { usdToNanos, type PriceParts } from "./pricing.ts";
import type { FundsClass } from "./ledger.ts";

/** `Transfer(address,address,uint256)` — the only event this phase watches. */
export const TRANSFER_TOPIC = keccak256Hex("Transfer(address,address,uint256)");

/** `decimals()` selector. */
export const DECIMALS_SELECTOR = "0x313ce567";

export interface FinalityVerdict {
  final: boolean;
  /** how far the event is from the condition, for the status view */
  detail: string;
  confirmations: number;
}

/**
 * Decides whether a block is final under a policy. Pure, so the policy can be
 * tested against recorded chain states without a network.
 *
 * `finalized-tag`: the chain's own `finalized` block must have reached the
 * event's block, and the hash at that height must still match.
 * `confirmations`: the head must be at least `confirmations` blocks past it.
 *
 * Both also require the event's block hash to still be the canonical one, which
 * is checked by the caller from a fresh block read.
 */
export function finalityVerdict(input: {
  policy: NetworkRecord["finality"];
  eventBlock: number;
  head: number;
  finalizedBlock: number | null;
}): FinalityVerdict {
  const { policy } = input;
  if (policy.mode === "read-only") {
    return { final: false, detail: "read-only network: finality is not asserted and nothing is credited", confirmations: 0 };
  }
  if (policy.mode === "finalized-tag") {
    if (input.finalizedBlock === null) return { final: false, detail: "the chain does not answer the finalized tag", confirmations: 0 };
    const confirmations = input.finalizedBlock - input.eventBlock;
    if (confirmations < 0) {
      return { final: false, detail: `${-confirmations} block(s) short of the finalized tag`, confirmations: 0 };
    }
    return { final: true, detail: `finalized tag reached block ${input.finalizedBlock}`, confirmations };
  }
  const confirmations = input.head - input.eventBlock;
  if (confirmations < policy.confirmations) {
    return {
      final: false,
      detail: `${confirmations}/${policy.confirmations} confirmations`,
      confirmations: Math.max(0, confirmations),
    };
  }
  return { final: true, detail: `${confirmations} confirmations (policy ${policy.confirmations})`, confirmations };
}

/** A decimal amount of a token, as integer nano-USD, with the dust left over. */
export interface Conversion {
  nanos: number;
  /** raw units that did not convert to a whole nano-USD */
  dustRaw: string;
  assetId: string;
  decimals: number;
  rawAmount: string;
  nanosPerToken: string;
  priceVersion: string;
  rateAt: string;
  rounding: "floor";
}

/**
 * Converts an ERC-20 base-unit amount to the ledger's nano-USD.
 *
 * bigint throughout: a `Number` would lose precision above 2^53 base units,
 * which an 18-decimal token reaches at 0.009 tokens. Rounding is floor and the
 * remainder is returned as `dustRaw` so it is recorded rather than dropped.
 */
export function convertRawToNanos(input: {
  rawAmount: bigint;
  asset: AssetRecord;
  /**
   * The rate to convert at. **Always pass the snapshot the deposit intent was
   * issued with**; the default (the asset's current rate) exists only for a
   * caller that has no intent, such as the status view.
   */
  nanosPerToken?: string;
  /** recorded alongside the result, so the amount is auditable */
  priceVersion?: string;
  at?: Date;
}): Conversion {
  if (input.rawAmount < 0n) throw new Error("a token amount cannot be negative");
  const rate = input.nanosPerToken ?? input.asset.pricing.nanosPerToken;
  const perToken = BigInt(rate);
  if (perToken <= 0n) throw new Error(`asset ${input.asset.assetId} has no usable rate`);
  const scale = 10n ** BigInt(input.asset.decimals);
  const numerator = input.rawAmount * perToken;
  const nanos = numerator / scale;
  const dust = numerator % scale;
  if (nanos > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("the converted amount does not fit in a safe integer");
  return {
    nanos: Number(nanos),
    dustRaw: dust.toString(),
    assetId: input.asset.assetId,
    decimals: input.asset.decimals,
    rawAmount: input.rawAmount.toString(),
    nanosPerToken: rate,
    priceVersion: input.priceVersion ?? input.asset.pricing.version,
    rateAt: (input.at ?? new Date()).toISOString(),
    rounding: "floor",
  };
}

/**
 * The rate a deposit must be converted at, or a refusal.
 *
 * The intent's snapshot wins. An intent written before snapshots existed has
 * none, and then the only safe answer is "do not convert": if the current
 * registry rate still carries the same version the intent was issued with, the
 * amount is provably unchanged and may be used; otherwise a human must look.
 */
export function rateForDeposit(input: {
  intent: { rateNanosPerToken?: string | null; priceVersion: string };
  asset: AssetRecord;
}): { ok: true; nanosPerToken: string; priceVersion: string } | { ok: false; reason: string } {
  if (!input.asset.credit || input.asset.pricing.kind !== "fixed-test-rate") {
    return { ok: false, reason: `asset ${input.asset.assetId} is not creditable; a mainnet/read-only asset has no USD rate` };
  }
  const snapshot = input.intent.rateNanosPerToken;
  if (snapshot && snapshot !== "") {
    // The version on the intent is the one that was signed; a registry edit
    // after the fact cannot change what this deposit is worth.
    return { ok: true, nanosPerToken: snapshot, priceVersion: input.intent.priceVersion };
  }
  if (input.asset.pricing.version === input.intent.priceVersion) {
    return { ok: true, nanosPerToken: input.asset.pricing.nanosPerToken, priceVersion: input.asset.pricing.version };
  }
  return {
    ok: false,
    reason:
      `the deposit was requested at rate version ${input.intent.priceVersion.slice(0, 24)}… but the asset now reports ` +
      `${input.asset.pricing.version.slice(0, 24)}…, and the intent carries no rate snapshot; ` +
      `the amount cannot be recomputed safely, so it needs manual review`,
  };
}

/** What the watcher needs from the ledger. Narrow on purpose: it cannot repricing anything. */
export interface CreditSink {
  /** books a deposit intent; idempotent by id */
  depositIntent(input: {
    id: string;
    consumerId: string;
    amountNanos: number;
    source: string;
    fundsClass?: FundsClass;
    chainId?: number | null;
    assetId?: string | null;
  }): { created: boolean };
  /** applies the deposit to a consumer's window and Magpie cap */
  applyDeposit(input: { id: string; consumerId: string; amountNanos: number }): Promise<void>;
  /** a credited event was reverted: freeze, never silently adjust */
  freezeConsumer(consumerId: string, reason: string): Promise<void>;
  /** the balance view, for the status page */
  balance(consumerId: string): { depositedNanos: number; consumedNanos: number; balanceNanos: number };
}

export interface WatcherDeps {
  network: NetworkRecord;
  registry: NetworkRegistry;
  store: ChainStore;
  ledger: CreditSink;
  client?: EvmClient;
  /** how many blocks to look back on the very first scan */
  initialLookback?: number;
  now?: () => Date;
  /** resolves `decimals()` for an asset; the real one is the RPC */
  decimalsOf?: (asset: AssetRecord) => Promise<number>;
}

export interface ScanResult {
  chainId: number;
  fromBlock: number;
  toBlock: number;
  logs: number;
  newEvents: number;
  claimed: number;
  unclaimed: number;
  finalized: number;
  credited: number;
  /** stored-but-unverified events that verification resolved this pass */
  reverified: number;
  errors: string[];
  /** true when the scan did not complete and the cursor did not advance */
  partial: boolean;
}

export interface ChainHealth {
  chainId: number;
  displayName: string;
  enabled: boolean;
  networkType: string;
  blockExplorer: string;
  endpoints: { url: string; ok: boolean; lastError: string | null; latencyMs: number | null }[];
  head: number | null;
  finalizedBlock: number | null;
  cursor: number | null;
  cursorHash: string | null;
  lagBlocks: number | null;
  lastScanAt: string | null;
  lastError: string | null;
  finality: { mode: string; confirmations: number; rationale: string };
  assets: { assetId: string; symbol: string; decimals: number; enabled: boolean; onchainDecimals: number | null; decimalsOk: boolean | null }[];
}

/**
 * One chain's watcher. Independent instances; nothing static is shared.
 */
export class ChainWatcher {
  readonly network: NetworkRecord;
  private registry: NetworkRegistry;
  private store: ChainStore;
  private ledger: CreditSink;
  private client: EvmClient;
  private initialLookback: number;
  private now: () => Date;
  private decimalsOf: (asset: AssetRecord) => Promise<number>;

  constructor(deps: WatcherDeps) {
    this.network = deps.network;
    this.registry = deps.registry;
    this.store = deps.store;
    this.ledger = deps.ledger;
    this.initialLookback = deps.initialLookback ?? 5;
    this.now = deps.now ?? (() => new Date());
    this.client =
      deps.client ??
      new Client({ chainId: deps.network.chainId, endpoints: deps.network.rpcEndpoints });
    this.decimalsOf =
      deps.decimalsOf ??
      (async (asset: AssetRecord) => {
        const raw = await this.client.callData(asset.contractAddress, DECIMALS_SELECTOR);
        if (raw === "0x") throw new Error(`${asset.symbol} returned no data for decimals(); it is not an ERC-20`);
        return Number(BigInt(raw));
      });
  }

  /** Verifies the RPC's chain id and every enabled asset's on-chain decimals. */
  async health(): Promise<ChainHealth> {
    let head: number | null = null;
    let finalizedBlock: number | null = null;
    let lastError: string | null = null;
    try {
      await this.client.verifyChain();
      head = await this.client.blockNumber();
      const fin = await this.client.maybeBlock("finalized");
      finalizedBlock = fin ? Number(BigInt(fin.number)) : null;
    } catch (e) {
      lastError = String((e as Error).message ?? e).slice(0, 300);
    }
    const cursor = this.store.cursor(this.network.chainId);
    const assets = await Promise.all(
      this.registry.assetsForChain(this.network.chainId).map(async (asset) => {
        let onchain: number | null = null;
        if (head !== null) {
          try {
            onchain = await this.decimalsOf(asset);
          } catch {
            onchain = null;
          }
        }
        return {
          assetId: asset.assetId,
          symbol: asset.symbol,
          decimals: asset.decimals,
          enabled: asset.enabled,
          onchainDecimals: onchain,
          decimalsOk: onchain === null ? null : onchain === asset.decimals,
        };
      }),
    );
    return {
      chainId: this.network.chainId,
      displayName: this.network.displayName,
      enabled: this.network.enabled,
      networkType: this.network.networkType,
      blockExplorer: this.network.blockExplorer,
      endpoints: this.client.endpointHealth().map((h) => ({ url: h.url, ok: h.ok, lastError: h.lastError, latencyMs: h.latencyMs })),
      head,
      finalizedBlock,
      cursor: cursor?.lastBlock ?? null,
      cursorHash: cursor?.lastBlockHash ?? null,
      lagBlocks: head !== null && cursor ? head - cursor.lastBlock : null,
      lastScanAt: cursor?.lastScanAt ?? null,
      lastError: lastError ?? this.store.lastError(this.network.chainId) ?? cursor?.lastError ?? null,
      finality: { mode: this.network.finality.mode, confirmations: this.network.finality.confirmations, rationale: this.network.finality.rationale },
      assets,
    };
  }

  /** Reads a contract's `decimals()`; the caller compares it to the registry. */
  async onchainDecimals(asset: AssetRecord): Promise<number> {
    return this.decimalsOf(asset);
  }

  /**
   * One scan step: read the range, store and attribute its logs, verify anything
   * still unverified, then move whatever is final into the ledger.
   *
   * **Commit semantics.** One page of logs and the cursor move commit in a single
   * `commitPage()` transaction. The earlier comment claimed this while the code
   * did not: each event was inserted in its own transaction and the cursor in
   * another, so a crash or a failed insert could leave a page half-stored with
   * the cursor already past it, losing the rest permanently. Now a page either
   * commits whole or not at all, and a failed page stops the scan with the cursor
   * where it was, so the same range is read again next time.
   */
  async scan(): Promise<ScanResult> {
    const chainId = this.network.chainId;
    const result: ScanResult = {
      chainId,
      fromBlock: 0,
      toBlock: 0,
      logs: 0,
      newEvents: 0,
      claimed: 0,
      unclaimed: 0,
      finalized: 0,
      credited: 0,
      reverified: 0,
      errors: [],
      partial: false,
    };
    try {
      await this.client.verifyChain();
    } catch (e) {
      const message = String((e as Error).message ?? e);
      result.errors.push(message);
      result.partial = true;
      this.store.recordScanError(chainId, message);
      return result;
    }
    const head = await this.client.blockNumber().catch((e) => {
      result.errors.push(String((e as Error).message ?? e));
      return null;
    });
    if (head === null) {
      result.partial = true;
      this.store.recordScanError(chainId, result.errors[0] ?? "no head");
      return result;
    }
    const cursor = this.store.cursor(chainId);
    let from = cursor ? cursor.lastBlock + 1 : Math.max(0, head - this.initialLookback);
    if (from > head) {
      // Nothing new. Still re-check finality of what is already stored.
      await this.settlePending(result);
      return result;
    }
    result.fromBlock = from;
    const assets = this.registry.assetsForChain(chainId).filter((a) => a.enabled);
    if (assets.length === 0) {
      result.toBlock = head;
      this.store.advanceCursor({ chainId, block: head, blockHash: null, at: this.now().toISOString() });
      await this.settlePending(result);
      return result;
    }
    const contracts = assets.map((a) => a.contractAddress.toLowerCase());
    let to = Math.min(head, from + this.network.maxBlockRange - 1);
    while (from <= head) {
      let logs: EvmLog[];
      try {
        logs = await this.client.logs({ address: contracts, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to });
      } catch (e) {
        const message = String((e as Error).message ?? e);
        result.errors.push(message);
        result.partial = true;
        this.store.recordScanError(chainId, message);
        break;
      }
      result.logs += logs.length;
      const page = this.pageFrom(logs);
      if (page.refused.length > 0) {
        // A log the plugin will not even store (another token, a non-ERC-20
        // Transfer) is recorded as an anomaly, not as a silent skip.
        for (const r of page.refused) {
          this.store.anomaly({ chainId, kind: "bad-log", detail: r, at: this.now().toISOString() });
        }
      }
      const endBlock = await this.client.block(to).catch(() => null);
      let committed: { created: ChainDepositEvent[]; duplicates: number };
      try {
        // One transaction: the page's events and the cursor together.
        committed = this.store.commitPage({
          chainId,
          block: to,
          blockHash: endBlock?.hash ?? null,
          events: page.events,
          at: this.now().toISOString(),
        });
      } catch (e) {
        // Nothing from this page was stored and the cursor did not move, so the
        // next scan reads the same range again. This is the case that used to
        // lose events permanently.
        const message = `page ${from}..${to} could not be committed: ${String((e as Error).message ?? e)}`;
        result.errors.push(message);
        result.partial = true;
        this.store.recordScanError(chainId, message);
        break;
      }
      result.newEvents += committed.created.length;
      for (const event of committed.created) {
        const outcome = await this.attribute(event).catch((e) => {
          const message = `log ${event.txHash}:${event.logIndex}: ${String((e as Error).message ?? e)}`;
          result.errors.push(message);
          this.store.anomaly({ chainId, kind: "bad-log", detail: message, eventId: event.id, at: this.now().toISOString() });
          return { attribution: "none" as const };
        });
        if (outcome.attribution === "claimed") result.claimed += 1;
        if (outcome.attribution === "unclaimed") result.unclaimed += 1;
      }
      if (to >= head) break;
      from = to + 1;
      to = Math.min(head, from + this.network.maxBlockRange - 1);
      result.toBlock = to;
    }
    if (result.toBlock === 0) result.toBlock = to;
    await this.settlePending(result);
    return result;
  }

  /**
   * Splits a page's logs into the ones this watcher will store and the ones it
   * refuses, without touching the database. Storing and refusing both happen in
   * `commitPage()`/`anomaly()`, so a refusal cannot half-write a page.
   */
  private pageFrom(logs: EvmLog[]): {
    events: Parameters<ChainStore["commitPage"]>[0]["events"];
    refused: string[];
  } {
    const chainId = this.network.chainId;
    const events: Parameters<ChainStore["commitPage"]>[0]["events"] = [];
    const refused: string[] = [];
    for (const log of logs) {
      const topics = log.topics.map((t) => t.toLowerCase());
      if (topics.length !== 3 || topics[0] !== TRANSFER_TOPIC.toLowerCase()) {
        refused.push(`log ${log.transactionHash}:${log.logIndex} has ${topics.length} topics; only an ERC-20 Transfer (3 topics) is credited`);
        continue;
      }
      const asset = this.registry.asset(assetIdOf(chainId, log.address));
      if (!asset || !asset.enabled) {
        refused.push(`log ${log.transactionHash}:${log.logIndex} is from ${log.address}, which is not an enabled asset of chain ${chainId}`);
        continue;
      }
      const blockNumber = Number(BigInt(log.blockNumber));
      const amount = BigInt(log.data);
      events.push({
        tokenContract: log.address,
        txHash: log.transactionHash,
        logIndex: Number(BigInt(log.logIndex)),
        blockNumber,
        blockHash: log.blockHash,
        from: `0x${topics[1]!.slice(26)}`,
        to: `0x${topics[2]!.slice(26)}`,
        amountRaw: amount.toString(),
      });
    }
    return { events, refused };
  }

  /**
   * Verifies a stored event and attributes it. Split from storing so the page
   * commit stays one transaction and a receipt failure cannot roll back the
   * event that proves the payment exists.
   *
   * Verification (the receipt) and attribution (the intent) are separate
   * outcomes:
   *
   *  - a **permanent** refusal (`failed`: the transaction reverted) stops here;
   *  - a **retryable** failure (`uncertain`: the receipt could not be read, or
   *    did not yet contain the log) leaves the event in the retry set, so the
   *    next scan tries again instead of losing the payment;
   *  - attribution is strict: exactly one signed, unexpired intent must match
   *    `(payer, amount, token, recipient)`. Zero means `unclaimed`; two or more
   *    means `uncertain`.
   */
  private async attribute(event: ChainDepositEvent): Promise<{ attribution: "claimed" | "unclaimed" | "none" }> {
    const chainId = this.network.chainId;
    const asset = this.registry.asset(assetIdOf(chainId, event.tokenContract));
    if (!asset || !asset.enabled) {
      // The token was disabled between storing and attributing; it cannot be
      // credited, and the row stays for audit.
      this.store.setEventStatus(event.id, "manualReview", "the event's token is no longer an enabled asset");
      return { attribution: "none" };
    }
    const verified = await this.verifyEvent(event);
    if (verified !== "ok") return { attribution: "none" };
    // A successful re-verification returns the event to the finality path. An
    // `uncertain` row that verified but stayed `uncertain` would be claimed and
    // then never finalised, which is the same permanent loss in a different
    // place.
    if (event.status === "uncertain") {
      this.store.setEventStatus(event.id, "observed", "the receipt was re-read and the log is in it");
    }
    const candidates = this.store.candidatesFor({
      chainId,
      tokenContract: event.tokenContract,
      recipient: event.toAddress,
      payer: event.fromAddress,
      amountRaw: event.amountRaw,
      now: this.now(),
    });
    if (candidates.length === 0) {
      this.store.markUnclaimed(event.id, `no signed, unexpired intent matches ${event.fromAddress} → ${event.toAddress} of ${event.amountRaw} ${asset.symbol}`);
      return { attribution: "unclaimed" };
    }
    if (candidates.length > 1) {
      this.store.setEventStatus(
        event.id,
        "uncertain",
        `${candidates.length} intents match this transfer (${candidates.map((c) => c.invoiceId).join(", ")}); the plugin will not guess`,
      );
      return { attribution: "none" };
    }
    const intent = candidates[0]!;
    const verdict = matchesTransfer({
      intent,
      chainId,
      tokenContract: event.tokenContract,
      recipient: event.toAddress,
      from: event.fromAddress,
      amountRaw: BigInt(event.amountRaw),
      at: this.now(),
    });
    if (!verdict.ok) {
      this.store.markUnclaimed(event.id, verdict.reason ?? "the intent does not match");
      return { attribution: "unclaimed" };
    }
    this.store.claim({ eventId: event.id, invoiceId: intent.invoiceId, at: this.now().toISOString() });
    return { attribution: "claimed" };
  }

  /**
   * The receipt check, which is what distinguishes a payment from a log a
   * reverted transaction left behind.
   *
   * `ok`           the transaction succeeded and this exact log is in it
   * `retryable`    the receipt could not be read, or does not contain the log
   *                *yet*: an RPC problem or an index catching up, not a refusal
   * `permanent`    the transaction reverted: this log can never be a payment
   */
  private async verifyEvent(event: ChainDepositEvent): Promise<"ok" | "retryable" | "permanent"> {
    this.store.noteVerifyAttempt(event.id, this.now().toISOString());
    let receipt: Awaited<ReturnType<EvmClient["receipt"]>>;
    try {
      receipt = await this.client.receipt(event.txHash);
    } catch (e) {
      // A transport or provider error is never evidence that the payment is
      // invalid, so the event stays retryable and nothing is credited.
      this.store.setEventStatus(event.id, "uncertain", `the receipt could not be read: ${String((e as Error).message ?? e).slice(0, 200)}`);
      return "retryable";
    }
    if (!receipt) {
      this.store.setEventStatus(event.id, "uncertain", "the transaction receipt is not available yet");
      return "retryable";
    }
    if (receipt.status !== "0x1") {
      this.store.setEventStatus(event.id, "failed", `the transaction status is ${receipt.status}, not success`);
      return "permanent";
    }
    const inReceipt = receipt.logs.some(
      (l) => Number(BigInt(l.logIndex)) === event.logIndex && l.blockHash.toLowerCase() === event.blockHash.toLowerCase(),
    );
    if (!inReceipt) {
      // The receipt exists but does not carry this log at this block. That is
      // either a provider index lagging or the log was replaced; both are
      // retryable, because a later read may settle it and the finality check
      // will catch a replaced block.
      this.store.setEventStatus(event.id, "uncertain", "the receipt does not contain this log at this block yet");
      return "retryable";
    }
    return "ok";
  }

  /**
   * Re-examines everything stored but not verified. This is what makes a
   * temporary receipt failure recoverable, including across a restart: the
   * retry set is a query over persisted rows, not a list in memory.
   */
  async verifyPending(): Promise<number> {
    let done = 0;
    for (const event of this.store.pendingVerification(this.network.chainId)) {
      const outcome = await this.attribute(event).catch((e) => {
        logger.warn(`could not re-verify ${event.id}: ${String(e)}`);
        return { attribution: "none" as const };
      });
      if (outcome.attribution !== "none") done += 1;
    }
    return done;
  }

  /**
   * Re-checks finality for everything this chain still holds, credits what is
   * final, and detects a reorg behind an already-credited event.
   */
  private async settlePending(result: ScanResult): Promise<void> {
    const chainId = this.network.chainId;
    // Everything stored but not yet verified is retried here, on every path
    // including "no new blocks", so a receipt that was briefly unavailable for a
    // block that has already been scanned still resolves on the next tick.
    result.reverified += await this.verifyPending();
    const head = await this.client.blockNumber().catch(() => null);
    if (head === null) {
      result.errors.push("the head could not be read while settling finality");
      result.partial = true;
      return;
    }
    const finalized = await this.client.maybeBlock("finalized");
    const finalizedBlock = finalized ? Number(BigInt(finalized.number)) : null;
    for (const event of this.store.pendingFinality(chainId)) {
      const canonical = await this.client.maybeBlock(event.blockNumber);
      if (!canonical) {
        this.store.setEventStatus(event.id, "uncertain", `block ${event.blockNumber} is not available`);
        continue;
      }
      if (canonical.hash.toLowerCase() !== event.blockHash.toLowerCase()) {
        this.store.setEventStatus(event.id, "reverted", `the block hash at ${event.blockNumber} is ${canonical.hash}, not ${event.blockHash}`);
        this.store.anomaly({
          chainId,
          kind: "reorg",
          eventId: event.id,
          detail: `event ${event.id} was in block ${event.blockHash}; the canonical block at that height is now ${canonical.hash}`,
          at: this.now().toISOString(),
        });
        continue;
      }
      const verdict = finalityVerdict({ policy: this.network.finality, eventBlock: event.blockNumber, head, finalizedBlock });
      this.store.setEventStatus(event.id, verdict.final ? "finalized" : "confirming", verdict.detail, this.now().toISOString(), verdict.confirmations);
      if (verdict.final) result.finalized += 1;
    }
    // A credited event whose block is gone must freeze the consumer.
    for (const event of this.store.eventsByStatus("credited", 500)) {
      if (event.chainId !== chainId) continue;
      const canonical = await this.client.maybeBlock(event.blockNumber);
      if (canonical && canonical.hash.toLowerCase() === event.blockHash.toLowerCase()) continue;
      this.store.setEventStatus(event.id, "reverted", `the block hash at ${event.blockNumber} is no longer ${event.blockHash}`);
      this.store.anomaly({
        chainId,
        kind: "reorg",
        eventId: event.id,
        detail: `a credited event was reverted: ${event.id} (deposit ${event.depositId})`,
        at: this.now().toISOString(),
      });
      if (event.invoiceId) {
        const intent = this.store.intent(event.invoiceId);
        if (intent) {
          await this.ledger
            .freezeConsumer(intent.consumerId, `a credited deposit on chain ${chainId} was reverted (${event.txHash}:${event.logIndex})`)
            .catch((e) => logger.error(`could not freeze ${intent.consumerId} after a reorg: ${String(e)}`));
        }
      }
    }
    result.credited += await this.creditFinalized();
  }

  /**
   * Moves finalized events into the ledger. Idempotent at every step:
   *
   *  - the chain is re-read first: a `crediting` retry is **not** a licence to
   *    credit, because a reorg may have happened between the failed attempt and
   *    this one;
   *  - `depositIntent` with the event's own id is a no-op if it already exists;
   *  - the conversion uses the rate the **intent** was issued at, never the live
   *    registry rate, so a later rate edit cannot change an accepted amount;
   *  - the event is marked `credited` only after `applyDeposit` returned;
   *  - a failure leaves it `crediting` so the next scan retries the *same*
   *    deposit id, which cannot double-credit.
   */
  async creditFinalized(): Promise<number> {
    let credited = 0;
    for (const event of this.store.awaitingCredit(this.network.chainId)) {
      const intent = event.invoiceId ? this.store.intent(event.invoiceId) : null;
      if (!intent) {
        this.store.setEventStatus(event.id, "manualReview", "the event has no intent to credit");
        continue;
      }
      // B: re-verify the chain *before* crediting, for a first attempt and for a
      // retry alike. A `crediting` row proves the ledger intent exists, not that
      // the block still does.
      const check = await this.reconfirmChain(event);
      if (check !== "ok") continue;
      const asset = this.registry.asset(assetIdOf(event.chainId, event.tokenContract));
      if (!asset) {
        this.store.setEventStatus(event.id, "manualReview", "the event's token is no longer allowlisted");
        continue;
      }
      // C: the rate is the one the intent was issued at.
      const rate = rateForDeposit({ intent, asset });
      if (!rate.ok) {
        this.store.setEventStatus(event.id, "manualReview", rate.reason);
        this.store.anomaly({
          chainId: event.chainId,
          kind: "rate-mismatch",
          eventId: event.id,
          detail: rate.reason,
          at: this.now().toISOString(),
        });
        continue;
      }
      let conversion: Conversion;
      try {
        conversion = convertRawToNanos({ rawAmount: BigInt(event.amountRaw), asset, nanosPerToken: rate.nanosPerToken, priceVersion: rate.priceVersion, at: this.now() });
      } catch (e) {
        this.store.setEventStatus(event.id, "failed", `conversion failed: ${String((e as Error).message ?? e)}`);
        continue;
      }
      if (conversion.nanos <= 0) {
        this.store.setEventStatus(event.id, "manualReview", "the amount converts to zero nano-USD");
        continue;
      }
      // Freeze the conversion before the ledger sees it, and refuse to proceed if
      // the event was already converted at a different amount.
      try {
        this.store.recordConversion({ id: event.id, nanos: conversion.nanos, nanosPerToken: conversion.nanosPerToken, priceVersion: conversion.priceVersion, at: this.now().toISOString() });
      } catch (e) {
        this.store.setEventStatus(event.id, "manualReview", String((e as Error).message ?? e));
        continue;
      }
      // The deposit id is derived from the chain event, so a retry after a crash
      // asks the ledger for the same deposit rather than a new one.
      const depositId = `chain:${event.id}`;
      try {
        this.ledger.depositIntent({
          id: depositId,
          consumerId: intent.consumerId,
          amountNanos: conversion.nanos,
          source: `chain:${event.chainId}`,
          fundsClass: "chain",
          chainId: event.chainId,
          assetId: asset.assetId,
        });
      } catch (e) {
        this.store.setEventStatus(event.id, "manualReview", `the ledger refused the deposit: ${String((e as Error).message ?? e)}`);
        this.store.anomaly({
          chainId: event.chainId,
          kind: "ledger-failure",
          eventId: event.id,
          detail: String((e as Error).message ?? e),
          at: this.now().toISOString(),
        });
        continue;
      }
      this.store.setEventStatus(event.id, "crediting", `credited ${conversion.nanos} nanos at ${conversion.priceVersion}`);
      try {
        await this.ledger.applyDeposit({ id: depositId, consumerId: intent.consumerId, amountNanos: conversion.nanos });
      } catch (e) {
        this.store.anomaly({
          chainId: event.chainId,
          kind: "credit-failure",
          eventId: event.id,
          detail: String((e as Error).message ?? e),
          at: this.now().toISOString(),
        });
        logger.warn(`deposit ${depositId} is booked but not yet applied to the key: ${String(e)}`);
        continue;
      }
      this.store.markCredited(event.id, depositId, this.now().toISOString());
      credited += 1;
      logger.info(
        `chain ${event.chainId}: ${event.amountRaw} of ${asset.symbol} from ${event.fromAddress} credited as ${conversion.nanos} nanos to ${intent.consumerId} (${depositId})`,
      );
    }
    return credited;
  }

  /**
   * Re-proves that the event's block is still canonical and that the network's
   * finality policy is still satisfied, immediately before crediting.
   *
   * Three outcomes, and none of them is "assume it is fine":
   *
   *  `ok`       the block hash matches and the policy still holds
   *  `reverted` the block at that height is a different block: the event is
   *             marked reverted, an anomaly is written, and if a ledger deposit
   *             was already booked the consumer is frozen (never silently
   *             un-credited)
   *  `paused`   the chain could not answer: the event keeps its status and the
   *             caller skips it, so a retry happens later instead of a credit
   *             now
   */
  private async reconfirmChain(event: ChainDepositEvent): Promise<"ok" | "reverted" | "paused"> {
    let canonical: Awaited<ReturnType<EvmClient["maybeBlock"]>>;
    try {
      canonical = await this.client.maybeBlock(event.blockNumber);
    } catch (e) {
      this.store.anomaly({
        chainId: event.chainId,
        kind: "finality-unavailable",
        eventId: event.id,
        detail: `could not re-read block ${event.blockNumber} before crediting: ${String((e as Error).message ?? e).slice(0, 200)}`,
        at: this.now().toISOString(),
      });
      return "paused";
    }
    if (!canonical) {
      // `maybeBlock` returns null for both "not found" and "the call failed"; a
      // null is not evidence of a reorg, so it pauses rather than reverting.
      this.store.anomaly({
        chainId: event.chainId,
        kind: "finality-unavailable",
        eventId: event.id,
        detail: `block ${event.blockNumber} could not be read before crediting; the credit is paused, not assumed`,
        at: this.now().toISOString(),
      });
      return "paused";
    }
    if (canonical.hash.toLowerCase() !== event.blockHash.toLowerCase()) {
      this.store.setEventStatus(event.id, "reverted", `the block hash at ${event.blockNumber} is ${canonical.hash}, not ${event.blockHash}`);
      this.store.anomaly({
        chainId: event.chainId,
        kind: "reorg",
        eventId: event.id,
        detail: `a credit was retried after a reorg: ${event.id} was in ${event.blockHash}, the canonical block is ${canonical.hash}`,
        at: this.now().toISOString(),
      });
      if (event.depositId || event.status === "crediting") {
        // The ledger may already hold the intent. It is kept for audit and the
        // consumer is frozen; nothing is deleted and no balance is rewritten.
        const intent = event.invoiceId ? this.store.intent(event.invoiceId) : null;
        if (intent) {
          await this.ledger
            .freezeConsumer(intent.consumerId, `a booked deposit on chain ${event.chainId} was reverted before it was applied (${event.txHash}:${event.logIndex})`)
            .catch((e) => logger.error(`could not freeze ${intent.consumerId} after a reorg: ${String(e)}`));
        }
      }
      return "reverted";
    }
    const head = await this.client.blockNumber().catch(() => null);
    if (head === null) {
      this.store.anomaly({
        chainId: event.chainId,
        kind: "finality-unavailable",
        eventId: event.id,
        detail: "the head could not be read before crediting; the credit is paused",
        at: this.now().toISOString(),
      });
      return "paused";
    }
    const finalized = await this.client.maybeBlock("finalized");
    const verdict = finalityVerdict({
      policy: this.network.finality,
      eventBlock: event.blockNumber,
      head,
      finalizedBlock: finalized ? Number(BigInt(finalized.number)) : null,
    });
    if (!verdict.final) {
      // The policy is no longer satisfied (the chain rewound below the depth, or
      // the finalized tag moved back). Back to confirming; nothing is credited.
      this.store.setEventStatus(event.id, "confirming", `credit paused: ${verdict.detail}`);
      return "paused";
    }
    return "ok";
  }

  /** Every intent this watcher could still see paid, for the status view. */
  openIntents(consumerId?: string): DepositIntent[] {
    const list = consumerId ? this.store.intentsFor(consumerId) : this.store.allIntents();
    return list.filter((i) => i.chainId === this.network.chainId);
  }
}

/** The status page's view of one chain, without throwing on an unreachable RPC. */
export function watcherHealthError(chainId: number, error: unknown): ChainHealth {
  return {
    chainId,
    displayName: `chain ${chainId}`,
    enabled: false,
    networkType: "unknown",
    blockExplorer: "",
    endpoints: [],
    head: null,
    finalizedBlock: null,
    cursor: null,
    cursorHash: null,
    lagBlocks: null,
    lastScanAt: null,
    lastError: String((error as Error)?.message ?? error).slice(0, 300),
    finality: { mode: "unknown", confirmations: 0, rationale: "unavailable" },
    assets: [],
  };
}

/** A fixed test rate, expressed the way `AssetPricing` stores it. */
export function fixedRatePricing(input: { nanosPerToken: number; note: string }): { nanosPerToken: string; version: string; kind: "fixed-test-rate"; note: string } {
  if (!Number.isInteger(input.nanosPerToken) || input.nanosPerToken <= 0) throw new Error("a fixed rate must be a positive integer number of nanos");
  return {
    nanosPerToken: String(input.nanosPerToken),
    version: `fixed:${input.nanosPerToken}:v1`,
    kind: "fixed-test-rate",
    note: input.note,
  };
}

/** Unused price shape kept out of the hot path; here only to type `PriceParts` imports. */
export type { PriceParts };
