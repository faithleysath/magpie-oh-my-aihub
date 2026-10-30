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
  at?: Date;
}): Conversion {
  if (input.rawAmount < 0n) throw new Error("a token amount cannot be negative");
  const perToken = BigInt(input.asset.pricing.nanosPerToken);
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
    nanosPerToken: input.asset.pricing.nanosPerToken,
    priceVersion: input.asset.pricing.version,
    rateAt: (input.at ?? new Date()).toISOString(),
    rounding: "floor",
  };
}

/**
 * What one log produced. `stored` says whether a new row was written (so a
 * rescan is visibly a no-op) and `attribution` says what happened to it.
 */
interface IngestOutcome {
  stored: boolean;
  attribution: "claimed" | "unclaimed" | "none";
}

const DUPLICATE: IngestOutcome = { stored: false, attribution: "none" };
const stored = (): IngestOutcome => ({ stored: true, attribution: "none" });
const claimedStored = (): IngestOutcome => ({ stored: true, attribution: "claimed" });
const unclaimedStored = (): IngestOutcome => ({ stored: true, attribution: "unclaimed" });

/** What the watcher needs from the ledger. Narrow on purpose: it cannot repricing anything. */
export interface CreditSink {
  /** books a deposit intent; idempotent by id */
  depositIntent(input: { id: string; consumerId: string; amountNanos: number; source: string }): { created: boolean };
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
   * One scan step: read the range, store new logs, attribute them, then move
   * whatever is final into the ledger.
   *
   * The cursor advances in the same transaction that stores the events of that
   * range (the store writes both), so a crash either loses the whole page or
   * none of it, and a restart re-reads the same page harmlessly.
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
      for (const log of logs) {
        try {
          const outcome = await this.ingestLog(log);
          if (outcome.stored) result.newEvents += 1;
          if (outcome.attribution === "claimed") result.claimed += 1;
          if (outcome.attribution === "unclaimed") result.unclaimed += 1;
        } catch (e) {
          const message = `log ${log.transactionHash}:${log.logIndex}: ${String((e as Error).message ?? e)}`;
          result.errors.push(message);
          this.store.anomaly({ chainId, kind: "bad-log", detail: message, at: this.now().toISOString() });
        }
      }
      const endBlock = await this.client.block(to).catch(() => null);
      // The cursor is written only after the page's logs are stored, and it
      // carries the page's own block hash so a reorg behind it is detectable.
      this.store.advanceCursor({ chainId, block: to, blockHash: endBlock?.hash ?? null, at: this.now().toISOString() });
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
   * Stores one log and tries to attribute it. Attribution is strict:
   *  - the token must be an enabled asset of *this* chain,
   *  - the recipient must be one an intent names,
   *  - exactly one signed, unexpired intent must match `(payer, amount, token,
   *    recipient)`. Zero means `unclaimed`; two or more means `uncertain`.
   */
  private async ingestLog(log: EvmLog): Promise<IngestOutcome> {
    const chainId = this.network.chainId;
    const blockNumber = Number(BigInt(log.blockNumber));
    const logIndex = Number(BigInt(log.logIndex));
    const topics = log.topics.map((t) => t.toLowerCase());
    if (topics.length !== 3 || topics[0] !== TRANSFER_TOPIC.toLowerCase()) {
      // An ERC-721 `Transfer` has 4 topics; this phase credits ERC-20 only.
      this.store.anomaly({
        chainId,
        kind: "bad-log",
        detail: `log ${log.transactionHash}:${log.logIndex} has ${topics.length} topics; only an ERC-20 Transfer (3 topics) is credited`,
        at: this.now().toISOString(),
      });
      return DUPLICATE;
    }
    const asset = this.registry.asset(assetIdOf(chainId, log.address));
    if (!asset || !asset.enabled) {
      this.store.anomaly({
        chainId,
        kind: "bad-log",
        detail: `log ${log.transactionHash}:${log.logIndex} is from ${log.address}, which is not an enabled asset of chain ${chainId}`,
        at: this.now().toISOString(),
      });
      return DUPLICATE;
    }
    const from = `0x${topics[1]!.slice(26)}`;
    const to = `0x${topics[2]!.slice(26)}`;
    const amount = BigInt(log.data);
    const head = await this.client.blockNumber().catch(() => blockNumber);
    const confirmations = Math.max(0, head - blockNumber);
    const { event, created } = this.store.observeEvent({
      chainId,
      tokenContract: log.address,
      txHash: log.transactionHash,
      logIndex,
      blockNumber,
      blockHash: log.blockHash,
      from,
      to,
      amountRaw: amount.toString(),
      confirmations,
      at: this.now().toISOString(),
    });
    if (!created) return DUPLICATE;
    // The receipt is the proof that the transaction itself succeeded; a log
    // from a reverted transaction is not a payment.
    const receipt = await this.client.receipt(log.transactionHash).catch(() => null);
    if (!receipt) {
      this.store.setEventStatus(event.id, "uncertain", "the transaction receipt is unavailable");
      return stored();
    }
    if (receipt.status !== "0x1") {
      this.store.setEventStatus(event.id, "failed", `the transaction status is ${receipt.status}, not success`);
      return stored();
    }
    const inReceipt = receipt.logs.some((l) => Number(BigInt(l.logIndex)) === logIndex && l.blockHash.toLowerCase() === log.blockHash.toLowerCase());
    if (!inReceipt) {
      this.store.setEventStatus(event.id, "uncertain", "the receipt does not contain this log at this block");
      return stored();
    }
    const candidates = this.store.candidatesFor({
      chainId,
      tokenContract: log.address,
      recipient: to,
      payer: from,
      amountRaw: amount.toString(),
      now: this.now(),
    });
    if (candidates.length === 0) {
      this.store.markUnclaimed(event.id, `no signed, unexpired intent matches ${from} → ${to} of ${amount.toString()} ${asset.symbol}`);
      return unclaimedStored();
    }
    if (candidates.length > 1) {
      this.store.setEventStatus(
        event.id,
        "uncertain",
        `${candidates.length} intents match this transfer (${candidates.map((c) => c.invoiceId).join(", ")}); the plugin will not guess`,
      );
      return stored();
    }
    const intent = candidates[0]!;
    const verdict = matchesTransfer({
      intent,
      chainId,
      tokenContract: log.address,
      recipient: to,
      from,
      amountRaw: amount,
      at: this.now(),
    });
    if (!verdict.ok) {
      this.store.markUnclaimed(event.id, verdict.reason ?? "the intent does not match");
      return unclaimedStored();
    }
    this.store.claim({ eventId: event.id, invoiceId: intent.invoiceId, at: this.now().toISOString() });
    return claimedStored();
  }

  /**
   * Re-checks finality for everything this chain still holds, credits what is
   * final, and detects a reorg behind an already-credited event.
   */
  private async settlePending(result: ScanResult): Promise<void> {
    const chainId = this.network.chainId;
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
      this.store.setEventStatus(event.id, verdict.final ? "finalized" : "confirming", verdict.detail);
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
   *  - `depositIntent` with the event's own id is a no-op if it already exists;
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
      const asset = this.registry.asset(assetIdOf(event.chainId, event.tokenContract));
      if (!asset) {
        this.store.setEventStatus(event.id, "manualReview", "the event's token is no longer allowlisted");
        continue;
      }
      let conversion: Conversion;
      try {
        conversion = convertRawToNanos({ rawAmount: BigInt(event.amountRaw), asset, at: this.now() });
      } catch (e) {
        this.store.setEventStatus(event.id, "failed", `conversion failed: ${String((e as Error).message ?? e)}`);
        continue;
      }
      if (conversion.nanos <= 0) {
        this.store.setEventStatus(event.id, "manualReview", "the amount converts to zero nano-USD");
        continue;
      }
      // The deposit id is derived from the chain event, so a retry after a crash
      // asks the ledger for the same deposit rather than a new one.
      const depositId = `chain:${event.id}`;
      try {
        this.ledger.depositIntent({ id: depositId, consumerId: intent.consumerId, amountNanos: conversion.nanos, source: `chain:${event.chainId}` });
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
