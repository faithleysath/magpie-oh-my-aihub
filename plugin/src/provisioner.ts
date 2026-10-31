import { existsSync, statSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { stateDir, statePath } from "./paths.ts";
import { logger, registerSecret } from "./log.ts";
import type { Magpie, LimitStatus } from "./magpie.ts";
import { readJsonWithBackup, writeJsonAtomic } from "./store.ts";
import { Ledger, assetIdChainId, assertCreditChainAllowed, classifyChainSource, classifyDepositSource, isKnownFundsClass, usageLogPath, type KnownFundsClass, type LedgerWindow } from "./ledger.ts";
import { assertCreditSourceNotMainnet } from "./mainnet-gate.ts";
import {
  GRID_NANOS,
  floorGrid,
  nanosToUsd,
  priceSnapshot,
  usdToNanos,
  type PriceSnapshot,
} from "./pricing.ts";

/**
 * The accounting check could not read what it needs (Magpie's key limit, the
 * price source). This is not evidence that the books are wrong, but it is also
 * not a healthy result: the caller must count the check as failed.
 */
export class VerificationUnavailableError extends Error {
  constructor(
    readonly consumerId: string,
    readonly what: string,
    override readonly cause: unknown,
  ) {
    super(`${consumerId}: cannot verify ${what}: ${String((cause as Error)?.message ?? cause)}`);
    this.name = "VerificationUnavailableError";
  }
}

export type PauseReason =
  | "price-mismatch"
  | "window-rollover"
  | "drift"
  | "unpriced"
  | "overdraft"
  | "dust"
  | "manual"
  | "log-gap"
  | "unsettled";

export interface Deposit {
  id: string;
  usd: number;
  at: string;
}

/**
 * A cap written to Magpie but not yet committed. The provenance fields are
 * written before the Magpie call so a crash can restore the same funds class
 * instead of guessing `simulated`. They are optional only for legacy files.
 */
export interface PendingDeposit {
  capUsd: number;
  depositId: string;
  usd: number;
  fundsClass?: KnownFundsClass;
  chainId?: number | null;
  assetId?: string | null;
  source?: string;
}

export interface ConsumerRecord {
  consumerId: string;
  keyName: string;
  keyId: string;
  /** the Gateway Key secret; never logged, written only to a 0600 file */
  secret: string;
  models: string[];
  window: string;
  /** the cumulative cost cap currently set on the key */
  capUsd: number;
  /** total simulated deposits credited to this consumer */
  creditedUsd: number;
  /** every applied deposit, by id, for idempotency and audit */
  deposits: Deposit[];
  /**
   * A cap written to Magpie but not yet confirmed in this file. Left behind when
   * the process dies between the Magpie write and the local commit; reconcile()
   * finishes or discards it from what the gateway actually says.
   */
  pending: PendingDeposit | null;
  /**
   * Fail-closed state. A confirmed price change, a window boundary or a
   * native-vs-ledger drift removes the key and records why; reissue() is the
   * only way back. `enforced` is false when Magpie could not be changed, which
   * must be shown, never hidden.
   */
  paused: {
    at: string;
    reason:
      | "price-mismatch"
      | "window-rollover"
      | "drift"
      | "unpriced"
      | "overdraft"
      | "dust"
      | "manual"
      | "log-gap"
      | "unsettled";
    detail: string;
    windowId: string | null;
    /** true only when the recorded enforcement really stops a remote caller */
    enforced: boolean;
    /**
     * How far the stop actually went:
     *  - keyRevoked    the key is gone; a remote call with its secret is 401
     *  - secretRotated the key stayed (remove failed) but its secret changed;
     *                  the old secret is 401 and was never handed out again
     *  - capRestricted only the cap was lowered; the key still answers 200
     *  - networkWithdrawn the overlay publication was withdrawn as well
     *  - safetyUncertain none of the above could be proven
     */
    enforcement: "keyRevoked" | "secretRotated" | "capRestricted" | "networkWithdrawn" | "safetyUncertain";
    /** why the strongest attempt failed, when enforcement is weaker than revoked */
    enforcementError: string | null;
  } | null;
  /** the immutable price version this consumer's current window was issued at */
  priceVersion?: string | null;
  /** the signed catalogue quote the consumer accepted at issuance, if any */
  acceptedQuoteHash?: string | null;
  /**
   * Why this consumer's charges cannot be proven complete (a usage-log gap, an
   * unreadable log). Null when every imported row was accounted for.
   */
  ledgerUncertain?: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastCheck: {
    at: string;
    usedUsd: number;
    leftUsd: number;
    calls: number;
    spent: boolean;
  } | null;
}

export interface ConsumerView {
  consumerId: string;
  keyName: string;
  keyId: string;
  models: string[];
  window: string;
  capUsd: number;
  creditedUsd: number;
  createdAt: string;
  revokedAt: string | null;
  usedUsd: number | null;
  leftUsd: number | null;
  calls: number | null;
  spent: boolean | null;
  reset: string | null;
  /** a deposit that is applied to Magpie but not yet committed here */
  pending: boolean;
  /** why the key is refused and awaiting reissue, if it is */
  paused: ConsumerRecord["paused"];
  /** the immutable price version bound to the current window */
  priceVersion: string | null;
  /** the accepted signed quote's content hash, if the key came from a quote */
  acceptedQuoteHash: string | null;
  /** ledger view; null for a legacy record not yet migrated */
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
    /** legacy/unknown-provenance deposits still included in the historical balance */
    unreviewedUsd: number;
    /** known-provenance available credit; unknown rows are excluded */
    creditableAvailableUsd: number;
    unpricedCalls: number;
    /** windows that can still be billed against, so not proven settled */
    openSettlements: number;
    /** a log gap or an unreadable log means charges may be missing */
    uncertain: string | null;
    /** every recorded gap, resolved or not, with the audit note */
    gaps: { logId: string; reason: string; resolvedAt: string | null; note: string | null }[];
  } | null;
  /** the key secret is never returned by the status view */
}

const FILE = "consumers.json";
const MAX_CAP_USD = 1_000_000;
const GRID = 1e4; // Magpie rounds cost caps to 1/10000 USD

export function roundCap(usd: number): number {
  return Math.round(usd * GRID) / GRID;
}

/**
 * A deposit whose id came from a chain event (`chain:<event id>`). Its id is
 * derived, not chosen, so it can never be "retried with a new id" the way a
 * simulated top-up can; treating it as permanently failed would strand a real
 * payment with no operator path back.
 */
export function isChainDerivedDeposit(deposit: { id: string; source: string; fundsClass?: KnownFundsClass }): boolean {
  return deposit.fundsClass === "chain" || classifyDepositSource(deposit.source) === "chain" || /^chain[:._-]/i.test(deposit.id.trim());
}

/** The provenance of a pending intent, or null when it cannot be trusted. */
function pendingProvenance(pending: PendingDeposit): { fundsClass: KnownFundsClass; chainId: number | null; assetId: string | null; source: string } | null {
  const source = pending.source ?? (pending.fundsClass === "simulated" ? "simulated" : pending.fundsClass === "manual" ? "manual" : pending.fundsClass === "chain" && pending.chainId !== null && pending.chainId !== undefined ? `chain:${pending.chainId}` : null);
  if (pending.fundsClass !== undefined && !isKnownFundsClass(pending.fundsClass)) return null;
  const fundsClass = pending.fundsClass ?? (source ? classifyDepositSource(source) : null);
  if (!fundsClass || !isKnownFundsClass(fundsClass) || !source) return null;
  const chainId = pending.chainId ?? (fundsClass === "chain" ? classifyChainSource(source) : null);
  if (fundsClass === "chain" && (chainId === null || !Number.isSafeInteger(chainId) || chainId <= 0)) return null;
  if (fundsClass !== "chain" && chainId !== null && chainId !== undefined) return null;
  return { fundsClass, chainId: chainId ?? null, assetId: pending.assetId ?? null, source };
}

/** chain/opening-looking ids are never valid for a local top-up. */
function isReservedDepositId(id: string): boolean {
  return /^(chain|opening)\s*(?:[:._-]|$)/i.test(id.trim());
}

/** A cap Magpie can actually hold: finite, positive, on its grid, and bounded. */
export function assertCap(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd)) throw new Error("a cost cap must be a finite number");
  if (!(usd >= 0.0001)) throw new Error("a consumer key needs a positive cost cap of at least $0.0001");
  if (usd > MAX_CAP_USD) throw new Error(`a cost cap above $${MAX_CAP_USD} is refused`);
  const rounded = roundCap(usd);
  if (Math.abs(rounded - usd) > 1e-9) {
    throw new Error(`$${usd} is not on Magpie's $0.0001 cap grid (use $${rounded.toFixed(4)})`);
  }
  return rounded;
}

interface ConsumersFile {
  consumers: ConsumerRecord[];
}

export interface ProvisionerOptions {
  save?: (list: ConsumerRecord[]) => void;
  validateModels?: (models: string[]) => void;
  /** durable prepaid ledger; omitted only by legacy unit tests */
  ledger?: Ledger;
  /** Magpie's effective prices for exactly these models; null means unpriced */
  prices?: (models: string[]) => Promise<PriceSnapshot | null>;
  /** override for tests */
  usageLog?: () => string;
  /** how long reissue() waits for in-flight usage rows to settle */
  drainMs?: number;
  /** how long a closed window is still audited for late rows */
  auditHorizonMs?: number;
}

/**
 * Reads the consumer records. A document that exists but cannot be parsed is an
 * error, never an empty list: "no consumers" would orphan every live Gateway Key
 * and make the ledger look like the only record of money that was spent.
 */
export function loadConsumers(): ConsumerRecord[] {
  const file = statePath(FILE);
  if (!existsSync(file)) return [];
  const read = readJsonWithBackup<ConsumersFile>(file);
  if (read.value === null) {
    throw new Error(
      `consumers.json is unreadable (${read.error ?? "no valid document"}); refusing to start with an empty consumer list`,
    );
  }
  const parsed = read.value;
  if (read.from === "previous") {
    logger.error(`consumers.json was unreadable; recovered the previous copy (${read.error ?? "unknown"})`);
  }
  const list = Array.isArray(parsed.consumers) ? parsed.consumers : [];
  for (const c of list) {
    registerSecret(c.secret);
    if (!Array.isArray(c.deposits)) c.deposits = [];
    if (c.pending === undefined) c.pending = null;
    if (c.paused === undefined) c.paused = null;
  }
  return list;
}

function saveConsumers(list: ConsumerRecord[]): void {
  // The same crash-safe writer the rest of the plugin uses: temp file, fsync,
  // rename, directory fsync, and the replaced document kept as `.prev`. A
  // truncated write can therefore never be read back as "no consumers".
  writeJsonAtomic(statePath(FILE), { consumers: list }, 0o600);
}

function view(c: ConsumerRecord, status: LimitStatus | null, ledger?: Ledger): ConsumerView {
  const lim = status?.limit ?? null;
  let ledgerView: ConsumerView["ledger"] = null;
  if (ledger) {
    const account = ledger.account(c.consumerId);
    if (account) {
      const w = ledger.openWindowFor(c.consumerId);
      const balance = ledger.balance(c.consumerId);
      let unsettledNanos = 0;
      let unpriced = 0;
      if (w) {
        for (const row of ledger.consumptionForWindow(w.id)) {
          if (!row.priceVerified) {
            unpriced += 1;
            unsettledNanos += row.amountNanos;
          }
        }
      }
      const unsettled = ledger.unsettledWindows(c.consumerId);
      ledgerView = {
        priceVersion: account.priceVersion,
        windowId: w?.id ?? account.windowId,
        start: w?.startAt ?? null,
        reset: w?.resetAt ?? null,
        depositedUsd: nanosToUsd(balance.depositedNanos),
        consumedUsd: nanosToUsd(balance.consumedNanos),
        balanceUsd: nanosToUsd(balance.balanceNanos),
        overdraftUsd: nanosToUsd(balance.overdraftNanos),
        unsettledUsd: nanosToUsd(unsettledNanos),
        unreviewedUsd: nanosToUsd(balance.unreviewedNanos),
        creditableAvailableUsd: nanosToUsd(balance.creditableAvailableNanos),
        unpricedCalls: unpriced,
        openSettlements: unsettled.length,
        uncertain: c.ledgerUncertain ?? null,
        gaps: ledger.gaps(c.consumerId),
      };
    }
  }
  return {
    consumerId: c.consumerId,
    keyName: c.keyName,
    keyId: c.keyId,
    models: [...c.models],
    window: c.window,
    capUsd: c.capUsd,
    creditedUsd: c.creditedUsd,
    createdAt: c.createdAt,
    revokedAt: c.revokedAt,
    usedUsd: lim?.cost ?? c.lastCheck?.usedUsd ?? null,
    leftUsd: lim?.costLeft ?? c.lastCheck?.leftUsd ?? null,
    calls: lim?.calls ?? c.lastCheck?.calls ?? null,
    spent: lim?.spent ?? c.lastCheck?.spent ?? null,
    reset: lim?.reset ?? null,
    pending: c.pending !== null,
    paused: c.paused,
    priceVersion: c.priceVersion ?? ledgerView?.priceVersion ?? null,
    acceptedQuoteHash: c.acceptedQuoteHash ?? null,
    ledger: ledgerView,
  };
}

/**
 * Issues and maintains one provider-owned Gateway Key per consumer.
 *
 * The rules this enforces are the ones the architecture calls non-negotiable:
 * a model whitelist is mandatory, a positive cost cap is mandatory, the cap is
 * written on Magpie's $0.0001 grid, every write is read back, top-ups raise the
 * same key's cumulative cap (never `reset`), and the gateway key's own
 * `/v1/magpie/limit` is the only source of truth for what a key used.
 *
 * Consistency: operations on one consumer are serialized, a deposit carries an
 * id so a retried one is not applied twice, a cap is recorded as pending before
 * it is written (so a crash between the Magpie write and the local commit is
 * reconciled from the gateway), and a key whose whitelist or cap cannot be
 * applied is deleted instead of being handed over.
 */
export class Provisioner {
  private save: (list: ConsumerRecord[]) => void;
  /**
   * Called with every whitelist before it is written. The service uses it to
   * refuse a model that is not this node's own: a Gateway Key may share native
   * models only, never a channel this node merely consumes from a peer.
   */
  private validateModels: (models: string[]) => void;
  private ledger: Ledger | undefined;
  private prices: ((models: string[]) => Promise<PriceSnapshot | null>) | undefined;
  private usageLog: () => string;
  private drainMs: number;
  /**
   * How long a closed window is still audited for late rows. Magpie records a
   * request's start time, so a long stream that started before the close can
   * settle after it; the horizon bounds how long that is watched for.
   */
  private auditHorizonMs: number;

  constructor(private magpie: Magpie, opts: ProvisionerOptions = {}) {
    this.save = opts.save ?? saveConsumers;
    this.validateModels = opts.validateModels ?? (() => {});
    this.ledger = opts.ledger;
    this.prices = opts.prices;
    this.usageLog = opts.usageLog ?? usageLogPath;
    this.drainMs = opts.drainMs ?? 1500;
    this.auditHorizonMs = opts.auditHorizonMs ?? 30 * 60_000;
    this.list = loadConsumers();
    // The ledger account is seeded lazily by status/top-up/ensure: a constructor
    // must not race a CLI read or a gateway that is not up yet. A key can
    // outlive the ledger file (a backup restored without it); seedLedger()
    // reconstructs cap - last used without guessing at history.
  }

  private persist(): void {
    this.save(this.list);
  }

  private list: ConsumerRecord[] = loadConsumers();
  private locks = new Map<string, Promise<unknown>>();

  /** One operation per consumer at a time; different consumers run in parallel. */
  private withLock<T>(consumerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(consumerId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      consumerId,
      next.catch(() => {}),
    );
    return next;
  }

  all(): ConsumerView[] {
    return this.list.map((c) => view(c, null, this.ledger));
  }

  /**
   * Magpie's effective prices. A model with no complete price is a null
   * snapshot; a price source that cannot be read at all is an error, because
   * "unreadable" must not be confused with "free" (the caller turns it into a
   * failed accounting check, which withdraws the export).
   */
  private async snapshotFor(models: string[]): Promise<PriceSnapshot | null> {
    if (!this.prices) return null;
    return this.prices(models);
  }

  /** The window bounds a fresh limit of this spec gets (local calendar for day/week/month). */
  private windowBounds(spec: string, now = new Date()): { start: string; reset: string } {
    const days = /^(\d+)d$/.exec(spec);
    if (days) {
      const n = Number(days[1]);
      return { start: now.toISOString(), reset: new Date(now.getTime() + n * 86_400_000).toISOString() };
    }
    const hours = /^(\d+)h$/.exec(spec);
    if (hours) {
      const n = Number(hours[1]);
      return { start: now.toISOString(), reset: new Date(now.getTime() + n * 3_600_000).toISOString() };
    }
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    if (spec === "week") {
      const back = (now.getDay() + 6) % 7;
      return {
        start: new Date(y, m, d - back).toISOString(),
        reset: new Date(y, m, d - back + 7).toISOString(),
      };
    }
    if (spec === "month") {
      return { start: new Date(y, m, 1).toISOString(), reset: new Date(y, m + 1, 1).toISOString() };
    }
    return { start: new Date(y, m, d).toISOString(), reset: new Date(y, m, d + 1).toISOString() };
  }

  private async seedLedger(rec: ConsumerRecord): Promise<LedgerWindow | null> {
    if (!this.ledger) return null;
    const existing = this.ledger.account(rec.consumerId);
    if (existing) {
      const open = this.ledger.openWindowFor(rec.consumerId);
      if (open) return open;
      return null;
    }
    let status: LimitStatus | null = null;
    try {
      status = await this.magpie.limitStatus(rec.secret);
    } catch {
      status = null;
    }
    // A price source that cannot be read must not seed a window: an "unpriced"
    // window would make every later charge free. The accounting check turns
    // this into a failed check instead.
    const snap =
      (await this.snapshotFor(rec.models).catch(() => null)) ?? {
        version: "unpriced",
        body: JSON.stringify({ models: [...rec.models].sort(), prices: {} }),
        models: [...rec.models].sort(),
        prices: {},
      };
    const usedNanos = usdToNanos(status?.limit?.cost ?? rec.lastCheck?.usedUsd ?? 0);
    const capNanos = usdToNanos(rec.capUsd);
    const bounds = this.windowBounds(rec.window);
    const window = this.ledger.ensureAccount({
      consumerId: rec.consumerId,
      keyId: rec.keyId,
      keyName: rec.keyName,
      price: snap,
      windowSpec: rec.window,
      startAt: status?.limit?.start ?? bounds.start,
      resetAt: status?.limit?.reset ?? bounds.reset,
      openingNanos: capNanos,
      capNanos,
    });
    // The opening deposit is the whole cap. The already-used part is an
    // adjustment, so balance = cap - used without touching old history.
    if (usedNanos > 0) {
      this.ledger.recordAdjustment({
        id: `migration:${rec.consumerId}:${window.id}`,
        consumerId: rec.consumerId,
        windowId: window.id,
        keyId: rec.keyId,
        amountNanos: usedNanos,
        reason: "legacy-consumers.json-used-cost",
      });
    }
    // The adjustment above already represents all usage before this moment.
    // Start reading usage.jsonl at its current end, or the first import would
    // count the same calls a second time.
    try {
      const size = existsSync(this.usageLog()) ? statSync(this.usageLog()).size : 0;
      this.ledger.seedCursor(this.usageLog(), rec.keyId, size);
    } catch {
      /* an unreadable log leaves the offset at 0; the unique ids still guard */
    }
    rec.priceVersion = snap.version;
    this.persist();
    return window;
  }

  /**
   * Freezes a consumer because a credited chain deposit was reverted.
   *
   * The ledger deposit is **not** removed and the balance is **not** adjusted:
   * the freeze is the auditable record, and `reissue()` is the only way back.
   * The stop goes through the same `pause()` a price change uses, so the
   * enforcement level is measured and reported rather than assumed.
   */
  async pauseForChain(consumerId: string, reason: string): Promise<void> {
    const rec = this.find(consumerId);
    if (!rec) throw new Error(`no consumer ${consumerId}`);
    await this.pause(rec, "manual", `chain-reorg: ${reason}`, true);
  }

  /**
   * Stops a consumer and records exactly how far the stop went.
   *
   * Measured against Magpie 0.1.2038 (see the phase-6 review note):
   *  - a removed key is 401 for a remote caller, but a *loopback* caller with
   *    the same secret is still served (loopback is trusted), so removal is a
   *    remote stop, not a local one;
   *  - `gateway-key rotate` is also 401 for the old secret and keeps the usage,
   *    which makes it the fallback when removal fails;
   *  - a $0.0001 cap is NOT a stop: a 10/10-token call still returned 200 with
   *    cost 6e-05 of 0.0001 left. It is only ever recorded as `capRestricted`,
   *    never as enforced.
   */
  private async pause(
    rec: ConsumerRecord,
    reason: PauseReason,
    detail: string,
    force = false,
  ): Promise<void> {
    if (rec.paused && !force) return;
    let enforcement: NonNullable<ConsumerRecord["paused"]>["enforcement"] = "safetyUncertain";
    let enforcementError: string | null = null;
    let newSecret: string | null = null;
    if (rec.keyId && this.magpie.keyById(rec.keyId)) {
      // 1. Removing the key is the strong stop.
      try {
        await this.magpie.removeKey(rec.keyId);
        if (!this.magpie.keyById(rec.keyId)) enforcement = "keyRevoked";
      } catch (e) {
        enforcementError = `remove: ${String((e as Error).message ?? e)}`;
        logger.warn(`could not remove paused key ${rec.keyName}: ${enforcementError}`);
      }
      // 2. Rotating the secret stops every caller that holds the old one, and
      //    keeps the usage record (unlike remove + add, which loses it).
      if (enforcement !== "keyRevoked") {
        try {
          const rotated = await this.magpie.rotateKey(rec.keyId);
          if (rotated && rotated !== rec.secret) {
            newSecret = rotated;
            enforcement = "secretRotated";
            registerSecret(rotated);
          }
        } catch (e) {
          enforcementError = `${enforcementError ? `${enforcementError}; ` : ""}rotate: ${String((e as Error).message ?? e)}`;
          logger.error(`could not rotate paused key ${rec.keyName}: ${String(e)}`);
        }
      }
      // 3. A minimum cap is not a stop. Only record it as the weakest level.
      if (enforcement === "safetyUncertain") {
        try {
          await this.magpie.setCostLimit(rec.keyId, rec.window, 0.0001);
          const st = await this.magpie.limitStatus(newSecret ?? rec.secret);
          if (Math.abs((st.limit?.costLimit ?? 0) - 0.0001) < 1e-9) {
            enforcement = "capRestricted";
            enforcementError = `${enforcementError ? `${enforcementError}; ` : ""}a $0.0001 cap still admits calls`;
          }
        } catch (e) {
          enforcementError = `${enforcementError ? `${enforcementError}; ` : ""}cap: ${String((e as Error).message ?? e)}`;
        }
      }
    } else {
      enforcement = "keyRevoked";
    }
    if (newSecret) rec.secret = newSecret;
    const window = this.ledger?.openWindowFor(rec.consumerId) ?? null;
    rec.paused = {
      at: new Date().toISOString(),
      reason,
      detail,
      windowId: window?.id ?? null,
      enforced: enforcement === "keyRevoked" || enforcement === "secretRotated",
      enforcement,
      enforcementError,
    };
    if (this.ledger) {
      this.ledger.setPaused(rec.consumerId, `${reason}: ${detail}`);
      // The window is closed for new charges but stays unsettled until nothing
      // can still bill against it; late rows are imported by settleWindows().
      if (window) this.ledger.closeWindow(window.id, `paused:${reason}`);
    }
    this.persist();
    logger.warn(
      `paused ${rec.consumerId}: ${reason} (${detail}); enforcement=${enforcement}` +
        (enforcementError ? ` (${enforcementError})` : ""),
    );
  }

  /**
   * The one place that answers "may this consumer keep using its key?".
   * It imports Magpie's settled usage first, then compares the bound price
   * version, the window identity and native cost with the ledger. Any mismatch
   * is fail-closed: the key is removed and a human must reissue it.
   */
  private async ledgerCheck(
    rec: ConsumerRecord,
    opts: { pause: boolean } = { pause: true },
  ): Promise<{
    window: LedgerWindow | null;
    status: LimitStatus | null;
    reason: string | null;
    /** false when the key's own numbers could not be read: never a pass */
    verified: boolean;
    unverified: string | null;
  }> {
    if (!this.ledger) return { window: null, status: null, reason: null, verified: true, unverified: null };
    const unknown = await this.blockUnknownProvenance(rec);
    if (unknown) return { window: null, status: null, reason: "unreviewed-provenance", verified: true, unverified: unknown };
    if (rec.paused) {
      // A paused consumer has no live key, but a request that was in flight when
      // it was stopped still settles. Import it, or the charge is lost; the
      // balance and the overdraft stay visible for the next reissue. No key is
      // touched here, so nothing is re-opened.
      const settlement = await this.settleWindows(rec);
      rec.ledgerUncertain = settlement.gap;
      if (settlement.gap) {
        this.ledger.setPaused(rec.consumerId, `log-gap: ${settlement.gap}`);
        this.persist();
      }
      return { window: null, status: null, reason: rec.paused.reason, verified: true, unverified: null };
    }
    let window = this.ledger.openWindowFor(rec.consumerId);
    if (!window) window = await this.seedLedger(rec);
    if (!window) {
      if (opts.pause) await this.pause(rec, "manual", "ledger account has no open window");
      return { window: null, status: null, reason: "no-window", verified: true, unverified: null };
    }
    // Import every window that can still be billed against, not only the open
    // one: a request that started before a rotation settles afterwards, and its
    // row must be charged at that old window's frozen price. A log gap means
    // charges may be missing, which is never treated as zero.
    const settlement = await this.settleWindows(rec);
    if (settlement.gap) {
      rec.ledgerUncertain = settlement.gap;
    } else {
      rec.ledgerUncertain = null;
    }
    if (!this.magpie.keyById(rec.keyId)) {
      if (opts.pause) await this.pause(rec, "manual", "the key was removed outside the plugin");
      return { window, status: null, reason: "missing-key", verified: true, unverified: null };
    }
    let status: LimitStatus | null = null;
    try {
      status = await this.verify(rec);
    } catch (e) {
      // A read failure is not evidence of a price/window problem, so the key is
      // not paused for it. It is also not a pass: the caller is told the check
      // could not verify, and the periodic check counts it as a failure.
      const unverified = `cannot read the key's limit: ${String((e as Error)?.message ?? e)}`;
      rec.ledgerUncertain = unverified;
      this.persist();
      logger.warn(`${rec.consumerId}: ${unverified}`);
      return { window, status: null, reason: "unreadable", verified: false, unverified };
    }
    const snap = await this.snapshotFor(rec.models);
    let reason: PauseReason | null = null;
    let detail = "";
    if (settlement.gap) {
      reason = "log-gap";
      detail = settlement.gap;
    } else if (settlement.unpriced > 0) {
      reason = "unpriced";
      detail = `${settlement.unpriced} settled call(s) had no price in the bound snapshot`;
    } else if (!snap) {
      reason = "unpriced";
      detail = "at least one shared model has no complete effective price";
    } else if (snap.version !== window.priceVersion) {
      reason = "price-mismatch";
      detail = `bound ${window.priceVersion.slice(0, 16)}…, now ${snap.version.slice(0, 16)}…`;
    } else if (Date.parse(window.resetAt) <= Date.now()) {
      reason = "window-rollover";
      detail = `window reset at ${window.resetAt}`;
    } else if (status.limit?.start && Math.abs(Date.parse(status.limit.start) - Date.parse(window.startAt)) > 1000) {
      reason = "window-rollover";
      detail = `native window starts at ${status.limit.start}, ledger at ${window.startAt}`;
    } else {
      const native = usdToNanos(status.limit?.cost ?? 0);
      const recorded = this.ledger.windowConsumption(window.id);
      const tolerance = Math.max(GRID_NANOS, Math.round(Math.max(native, recorded) * 0.005));
      if (Math.abs(native - recorded) > tolerance) {
        reason = "drift";
        detail = `native used ${nanosToUsd(native).toFixed(9)} USD, ledger ${nanosToUsd(recorded).toFixed(9)} USD`;
      }
    }
    if (!reason && settlement.lateNanos > 0) {
      // Late charges from an old window reduce the balance after the current
      // key was issued. Tighten the live cap to the new balance, or pause when
      // there is nothing left to grant.
      const tightened = await this.tightenCap(rec, status);
      if (tightened.reason) {
        reason = tightened.reason;
        detail = tightened.detail ?? "";
      } else if (tightened.status) {
        status = tightened.status;
      }
    }
    if (reason && opts.pause) await this.pause(rec, reason, detail);
    return { window, status, reason, verified: true, unverified: null };
  }

  /**
   * Imports Magpie's own settled rows for every window of this consumer that is
   * not proven settled. The open window and any closed/draining one are read
   * with their own frozen price snapshot, so a late call is charged what it was
   * quoted at, never today's price.
   */
  async settleWindows(rec: ConsumerRecord): Promise<{ lateNanos: number; gap: string | null; unpriced: number }> {
    const ledger = this.ledger;
    if (!ledger) return { lateNanos: 0, gap: null, unpriced: 0 };
    let lateNanos = 0;
    let gap: string | null = null;
    let unpriced = 0;
    const openId = ledger.openWindowFor(rec.consumerId)?.id ?? null;
    // Unsettled windows and recently closed ones: a request can end between the
    // settlement check and the next read, so a settled window is still audited
    // for the audit horizon and reopened if a late row lands in it.
    for (const window of ledger.windowsToScan(rec.consumerId, this.auditHorizonMs)) {
      const before = ledger.windowConsumption(window.id);
      const result = ledger.importUsage({
        consumerId: rec.consumerId,
        window,
        logPath: this.usageLog(),
      });
      if (result.gap) gap = result.gap;
      unpriced += result.unpriced;
      if (window.id !== openId) {
        const after = ledger.windowConsumption(window.id);
        if (after > before) {
          lateNanos += after - before;
          if (window.settled) {
            ledger.reopenWindow(window.id, `a late row of ${nanosToUsd(after - before)} USD arrived after settlement`);
            logger.warn(`${rec.consumerId}: reopened ${window.id} for a late row`);
          }
        }
        // The window can only be called settled when the gateway proves nothing
        // is in flight and no unread bytes remain. Waiting a fixed time is not
        // such a proof.
        await this.trySettleWindow(window);
      }
    }
    if (!gap) {
      const open = ledger.openGaps(rec.consumerId);
      if (open.length > 0) gap = open[0].reason;
    }
    if (lateNanos > 0) {
      logger.warn(`${rec.consumerId}: ${nanosToUsd(lateNanos)} USD settled against an older window`);
    }
    return { lateNanos, gap, unpriced };
  }

  /**
   * Settles an older window only on evidence: the gateway reports no request in
   * flight and its usage log has no unread bytes. Otherwise the window stays
   * open for late rows and is reported as not settled.
   */
  private async trySettleWindow(window: LedgerWindow): Promise<boolean> {
    const ledger = this.ledger;
    if (!ledger) return false;
    // Read the flag from the database, not the caller's copy: a window reopened
    // for a late row in this same pass must be settled again on evidence.
    if (ledger.windowSettlement(window.id).settled) return true;
    const inFlight =
      typeof this.magpie.inFlightRequests === "function"
        ? await this.magpie.inFlightRequests().catch(() => null)
        : null;
    if (inFlight === null) {
      ledger.event(window.consumerId, "settlement-unproven", { windowId: window.id, reason: "gateway would not say what is in flight" });
      return false;
    }
    if (inFlight > 0) return false;
    const path = this.usageLog();
    const size = existsSync(path) ? statSync(path).size : 0;
    if (ledger.cursorFor(path, window.keyId) < size) return false;
    ledger.markWindowSettled(window.id, "no request in flight and no unread usage bytes");
    return true;
  }

  /**
   * Re-aligns the live key's cap with the ledger after a late charge. The cap is
   * `native used + balance`, so it only ever moves down here; a balance below
   * one grid unit pauses the consumer instead of issuing a cap it cannot hold.
   */
  private async tightenCap(
    rec: ConsumerRecord,
    status: LimitStatus,
  ): Promise<{ status?: LimitStatus; reason?: PauseReason; detail?: string }> {
    const ledger = this.ledger!;
    const balance = ledger.balance(rec.consumerId);
    const used = usdToNanos(status.limit?.cost ?? 0);
    const target = floorGrid(used + balance.balanceNanos);
    const current = usdToNanos(status.limit?.costLimit ?? 0);
    if (balance.balanceNanos < 0) {
      return {
        reason: "overdraft",
        detail: `late charges left an overdraft of ${nanosToUsd(balance.overdraftNanos).toFixed(4)} USD`,
      };
    }
    if (target < GRID_NANOS) {
      return {
        reason: "dust",
        detail: `late charges left ${nanosToUsd(balance.balanceNanos).toFixed(9)} USD, below the $0.0001 minimum`,
      };
    }
    if (target >= current) return {};
    try {
      await this.magpie.setCostLimit(rec.keyId, rec.window, target / 1_000_000_000);
      const after = await this.magpie.limitStatus(rec.secret);
      if (Math.abs((after.limit?.costLimit ?? 0) - target / 1_000_000_000) > 1e-9) {
        return { reason: "drift", detail: `could not tighten the cap to ${nanosToUsd(target)}` };
      }
      rec.capUsd = target / 1_000_000_000;
      this.persist();
      ledger.event(rec.consumerId, "cap-tightened", { capNanos: target, usedNanos: used });
      logger.info(`tightened ${rec.consumerId} to ${rec.capUsd} after a late charge`);
      return { status: after };
    } catch (e) {
      return { reason: "drift", detail: `could not tighten the cap after a late charge: ${String(e)}` };
    }
  }

  /**
   * Every consumer's view, reading each key's numbers from the gateway. A key
   * that cannot be read keeps its last known numbers.
   */
  async refreshAll(): Promise<ConsumerView[]> {
    const out: ConsumerView[] = [];
    for (const c of this.list) {
      if (c.revokedAt || !c.secret) {
        out.push(view(c, null, this.ledger));
        continue;
      }
      try {
        out.push(
          await this.withLock(c.consumerId, async () => {
            await this.reconcile(c);
            if (this.ledger) {
              const check = await this.ledgerCheck(c);
              return view(c, check.status, this.ledger);
            }
            return view(c, await this.verify(c), this.ledger);
          }),
        );
      } catch {
        out.push(view(c, null, this.ledger));
      }
    }
    return out;
  }

  find(consumerId: string): ConsumerRecord | undefined {
    return this.list.find((c) => c.consumerId === consumerId);
  }

  /**
   * Finishes or discards a cap that was written but not committed locally.
   *
   * The two outcomes are deliberately asymmetric:
   *  - the pending cap IS in force → the deposit is proven applied (a read-back,
   *    not a guess) and is booked as applied;
   *  - it is not → nothing was granted by this attempt. A simulated deposit may
   *    be marked `failed` because a caller can retry with a new id. A **chain**
   *    deposit cannot: its id is derived from the chain event, `applyChainDeposit`
   *    refuses a failed id, and no operator command can un-fail one. Marking it
   *    failed would strand a real payment whose cap write never landed, so it
   *    stays `intent` and the watcher retries the same id (after re-proving
   *    canonicality and finality). Nothing is credited and no row is deleted.
   */
  /**
   * Unknown-provenance deposits stay in the historical balance but may not
   * grant new credit. The consumer is paused/uncertain until a local review
   * assigns provenance; no amount or row is changed here.
   */
  private async blockUnknownProvenance(rec: ConsumerRecord): Promise<string | null> {
    const balance = this.ledger?.balance(rec.consumerId);
    if (!balance || balance.unreviewedNanos <= 0) return null;
    const detail = `${nanosToUsd(balance.unreviewedNanos).toFixed(9)} USD of deposit provenance is unknown; local review is required before new credit`;
    rec.ledgerUncertain = detail;
    if (!rec.paused) await this.pause(rec, "manual", detail, true);
    this.persist();
    return detail;
  }

  private async uncertainPending(rec: ConsumerRecord, detail: string): Promise<never> {
    rec.ledgerUncertain = detail;
    await this.pause(rec, "manual", detail, true);
    this.persist();
    throw new Error(detail);
  }

  async reconcile(c: ConsumerRecord): Promise<void> {
    if (!c.pending || !c.secret) return;
    const blocked = await this.blockUnknownProvenance(c);
    if (blocked) throw new Error(`pending deposit ${c.pending.depositId} cannot be reconciled: ${blocked}`);
    if (c.pending.fundsClass !== undefined && !isKnownFundsClass(c.pending.fundsClass)) {
      await this.uncertainPending(c, `pending deposit ${c.pending.depositId} has unknown fundsClass ${JSON.stringify(c.pending.fundsClass)}; manual review is required`);
    }
    let status: LimitStatus;
    try {
      status = await this.magpie.limitStatus(c.secret);
    } catch (e) {
      logger.warn(`cannot reconcile ${c.consumerId} yet: ${String(e)}`);
      return;
    }
    const cap = status.limit?.costLimit;
    const pending = c.pending;
    const dep = this.ledger?.deposit(pending.depositId) ?? null;
    const provenance = pendingProvenance(pending);
    if (this.ledger && !provenance) {
      await this.uncertainPending(c, `pending deposit ${pending.depositId} has no trusted provenance; refusing to apply it even if the native cap is in force`);
    }
    if (dep?.needsReview) {
      await this.uncertainPending(c, `pending deposit ${pending.depositId} has an unknown-provenance ledger row; local review is required`);
    }
    const chainClass = provenance?.fundsClass === "chain" || dep?.fundsClass === "chain";
    if (chainClass) {
      const chainId = provenance?.chainId ?? dep?.chainId ?? null;
      const assetId = provenance?.assetId ?? dep?.assetId ?? null;
      if (chainId === null || !Number.isSafeInteger(chainId) || chainId <= 0) {
        await this.uncertainPending(c, `pending chain deposit ${pending.depositId} has no trustworthy chain id`);
      }
      assertCreditChainAllowed(chainId as number);
      if (!assetId || assetIdChainId(assetId) !== chainId) {
        await this.uncertainPending(c, `pending chain deposit ${pending.depositId} has no valid asset on chain ${chainId}; local evidence recovery is required`);
      }
    }
    if (dep) {
      const expectedAmount = usdToNanos(pending.usd);
      if (dep.amountNanos !== expectedAmount) {
        await this.uncertainPending(
          c,
          `pending deposit ${pending.depositId} says ${pending.usd} USD but its ledger row is ${nanosToUsd(dep.amountNanos)} USD; refusing to credit`,
        );
      }
      if (provenance) {
        const assetMismatch = (dep.assetId ?? null) !== (provenance.assetId ?? null);
        if (dep.fundsClass !== provenance.fundsClass || dep.chainId !== provenance.chainId || assetMismatch) {
          await this.uncertainPending(
            c,
            `pending deposit ${pending.depositId} provenance (${provenance.fundsClass}/${String(provenance.chainId)}/${provenance.assetId ?? "no-asset"}) ` +
              `disagrees with its ledger row (${dep.fundsClass}/${String(dep.chainId)}/${dep.assetId ?? "no-asset"}); refusing to credit`,
          );
        }
      }
    }
    if (cap !== undefined && Math.abs(cap - pending.capUsd) < 1e-9) {
      if (this.ledger) {
        const window = this.ledger.openWindowFor(c.consumerId);
        if (!window) {
          // The cap is in force but there is no window to book it against. Do
          // not credit it twice or lose it; leave the intent and surface it.
          logger.error(`pending deposit ${pending.depositId} is in Magpie but ${c.consumerId} has no open ledger window`);
          return;
        }
        let booked = dep;
        if (!booked) {
          if (!provenance) {
            throw new Error(
              `pending deposit ${pending.depositId} is in Magpie but its ledger row and provenance are missing; ` +
                `refusing to guess simulated — manual recovery is required`,
            );
          }
          if (provenance.fundsClass === "chain") {
            logger.error(`pending chain deposit ${pending.depositId} is in Magpie but its ledger row is missing`);
            throw new Error(
              `pending chain deposit ${pending.depositId} is missing its ledger row; refusing to invent a simulated source — manual recovery is required`,
            );
          }
          booked = this.ledger.depositIntent({
            id: pending.depositId,
            consumerId: c.consumerId,
            amountNanos: usdToNanos(pending.usd),
            source: provenance.source,
            fundsClass: provenance.fundsClass,
            chainId: provenance.chainId,
            assetId: provenance.assetId,
          }).deposit;
        } else if (provenance && (booked.fundsClass !== provenance.fundsClass || booked.chainId !== provenance.chainId)) {
          throw new Error(
            `pending deposit ${pending.depositId} provenance (${provenance.fundsClass}/${String(provenance.chainId)}) ` +
              `disagrees with its ledger row (${booked.fundsClass}/${String(booked.chainId)}); manual review is required`,
          );
        }
        if (booked.status !== "applied") this.ledger.markDepositApplied(booked.id, window.id, usdToNanos(pending.capUsd));
      }
      c.capUsd = pending.capUsd;
      c.creditedUsd = roundCap(c.creditedUsd + pending.usd);
      if (!c.deposits.some((d) => d.id === pending.depositId)) {
        c.deposits.push({ id: pending.depositId, usd: pending.usd, at: new Date().toISOString() });
      }
      logger.info(`reconciled ${c.consumerId}: the cap written before the restart is in force`);
    } else {
      const fundsClass = provenance?.fundsClass ?? dep?.fundsClass ?? null;
      if (this.ledger && !fundsClass) {
        throw new Error(
          `pending deposit ${pending.depositId} has no trusted provenance and Magpie does not hold its cap; ` +
            `refusing to drop or reclassify it — manual recovery is required`,
        );
      }
      if (dep?.status === "intent" && fundsClass === "chain") {
        // Magpie does not hold the pending cap, so this attempt granted nothing.
        // The chain deposit keeps its id and provenance for the next scan.
        logger.warn(
          `reconciled ${c.consumerId}: the pending chain deposit ${pending.depositId} is not in Magpie (cap ${String(cap)}); it stays booked for retry`,
        );
      } else if (fundsClass === "chain") {
        throw new Error(
          `pending chain deposit ${pending.depositId} is not in Magpie and has no ledger row; manual recovery is required`,
        );
      } else {
        if (dep?.status === "intent" && cap !== undefined && Math.abs(cap - c.capUsd) < 1e-9) {
          this.ledger!.markDepositFailed(dep.id, "Magpie did not apply the cap");
        }
        logger.warn(
          `reconciled ${c.consumerId}: the pending cap ${pending.capUsd} is not what Magpie holds (${String(cap)}); dropped the intent`,
        );
      }
    }
    c.pending = null;
    this.persist();
  }
  /** Creates the consumer's key if it does not exist yet, and checks it either way. */
  async ensure(
    consumerId: string,
    opts: { models: string[]; window?: string; capUsd: number; quoteHash?: string; quotePriceVersion?: string; beforeApply?: () => void },
  ): Promise<ConsumerView> {
    if (!consumerId || !/^[a-z0-9][a-z0-9._-]{1,40}$/.test(consumerId)) {
      throw new Error("consumerId must be 2-41 characters of a-z0-9._-");
    }
    if (!Array.isArray(opts.models) || opts.models.length === 0) {
      throw new Error("refusing to create a key without a model whitelist");
    }
    for (const m of opts.models) {
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._*,/-]+$/.test(m)) throw new Error(`bad model name: ${m}`);
    }
    this.validateModels(opts.models);
    // A prepaid key gets the longest native cycle (3650 days): the plugin must
    // still handle its eventual end, but a daily reset would re-grant credit
    // every midnight. The window is never changed by a top-up.
    const window = opts.window ?? (this.ledger ? "3650d" : "day");
    if (!/^(day|week|month|\d+d|\d+h)$/.test(window)) throw new Error(`bad limit window ${window}`);
    const capUsd = assertCap(opts.capUsd);

    return this.withLock(consumerId, async () => {
      // Quote-based approval rechecks after waiting for this consumer's lock.
      opts.beforeApply?.();
      let rec = this.find(consumerId);
      if (rec?.revokedAt) throw new Error(`consumer ${consumerId} was revoked; create a new consumer id`);
      if (rec) {
        await this.reconcile(rec);
        await this.ledgerCheck(rec);
        if (rec.paused) {
          throw new Error(`consumer ${consumerId} is paused (${rec.paused.reason}): reissue the key before using it`);
        }
      }

      if (!rec) {
        // A key for an unpriced model cannot be enforced by a cost cap. Refuse
        // before creating anything, rather than hand out a free channel.
        if (this.ledger) {
          const snap = await this.snapshotFor(opts.models);
          if (!snap) throw new Error("refusing a key while at least one shared model has no complete effective price");
          if (opts.quotePriceVersion && opts.quotePriceVersion !== snap.version) {
            throw new Error(
              `the accepted quote is bound to price version ${opts.quotePriceVersion}, but the effective price is ${snap.version}`,
            );
          }
        }
        const keyName = Provisioner.keyName(consumerId);
        const existing = this.magpie.keyByName(keyName);
        let key = existing;
        // Synchronous check immediately before the first key mutation, after
        // all awaited price reads. A refusal here must not remove an old key.
        opts.beforeApply?.();
        try {
          // Magpie's own generated prefix (`sk-magpie-`) may not be passed back
          // through `--key`, so a ledger-managed key gets a plugin-owned
          // secret that a later reissue can reuse without client reconfiguration.
          key = existing ?? (await this.magpie.addKey(keyName, this.ledger ? newConsumerSecret() : undefined));
          rec = {
            consumerId,
            keyName,
            keyId: key.id,
            secret: key.secret,
            models: [...opts.models],
            window,
            capUsd,
            creditedUsd: 0,
            deposits: [],
            pending: null,
            paused: null,
            priceVersion: null,
            acceptedQuoteHash: opts.quoteHash ?? null,
            createdAt: new Date().toISOString(),
            revokedAt: null,
            lastCheck: null,
          };
          await this.magpie.setModels(rec.keyId, rec.models);
          await this.magpie.setQuotasOff(rec.keyId);
          this.list.push(rec);
          this.persist();
          await this.setCap(rec, capUsd);
          await this.verify(rec);
          if (this.ledger) await this.seedLedger(rec);
          logger.info(`created gateway key ${keyName} (${key.id}) for ${consumerId}`);
        } catch (e) {
          // A key that could not be given its whitelist or cap must never be
          // handed over: delete it rather than leave a dangerous one behind.
          const idx = this.list.findIndex((c) => c.consumerId === consumerId);
          if (idx >= 0) this.list.splice(idx, 1);
          this.persist();
          if (key) {
            await this.magpie.removeKey(key.id).catch((err) => logger.error(`could not remove the half-made key ${keyName}: ${String(err)}`));
          }
          throw new Error(`could not provision ${consumerId}: ${(e as Error).message}`);
        }
      } else {
        if (!rec.secret) {
          const again = this.magpie.keyById(rec.keyId);
          if (!again) throw new Error(`key ${rec.keyName} no longer exists in Magpie`);
          rec.secret = again.secret;
        }
        opts.beforeApply?.();
        if (opts.quotePriceVersion && rec.priceVersion !== opts.quotePriceVersion) {
          throw new Error("the existing consumer price version differs from the accepted quote; reissue explicitly");
        }
        if (JSON.stringify(rec.models) !== JSON.stringify(opts.models)) {
          this.validateModels(opts.models);
          await this.magpie.setModels(rec.keyId, opts.models);
          rec.models = [...opts.models];
          logger.info(`key ${rec.keyName}: model whitelist updated (${opts.models.join(", ")})`);
        }
        await this.magpie.setModels(rec.keyId, rec.models);
        await this.magpie.setQuotasOff(rec.keyId);
        if (capUsd > rec.capUsd) {
          if (this.ledger) {
            throw new Error(`raising ${consumerId}'s cap requires a deposit id; use topUp so the ledger and the key agree`);
          }
          await this.setCap(rec, capUsd);
          await this.verify(rec, capUsd);
          rec.capUsd = capUsd;
        }
        await this.verify(rec);
        this.persist();
        if (this.ledger) {
          await this.ledgerCheck(rec);
          if (rec.paused) throw new Error(`consumer ${consumerId} is paused (${rec.paused.reason}): reissue the key`);
        }
      }
      const status = await this.verify(rec);
      return view(rec, status, this.ledger);
    });
  }

  /**
   * Writes the cap to Magpie only. The local record is committed by the caller
   * after the read-back, so a failed verification never leaves this file saying
   * a cap that Magpie may not hold.
   */
  private async setCap(rec: ConsumerRecord, capUsd: number, expected?: { depositId: string; fundsClass: KnownFundsClass }): Promise<number> {
    const cap = assertCap(capUsd);
    if (expected) {
      const pending = rec.pending;
      if (!pending || pending.depositId !== expected.depositId) {
        throw new Error(`cap write ${expected.depositId} has no matching pending deposit; refusing to apply money without provenance`);
      }
      const actual = pending.fundsClass ?? (pending.source ? classifyDepositSource(pending.source) : null);
      if (actual !== expected.fundsClass) {
        throw new Error(`cap write ${expected.depositId} is ${actual ?? "unclassified"}, not ${expected.fundsClass}; refusing to apply it`);
      }
      if (expected.fundsClass === "chain") {
        const chainId = pending.chainId ?? (pending.source ? classifyChainSource(pending.source) : null);
        if (chainId === null || !Number.isSafeInteger(chainId) || chainId <= 0) {
          throw new Error(`chain cap write ${expected.depositId} has no trustworthy chain id; refusing to apply it`);
        }
        assertCreditChainAllowed(chainId as number);
        if (!pending.assetId || assetIdChainId(pending.assetId) !== chainId) {
          throw new Error(`chain cap write ${expected.depositId} has no asset id on chain ${chainId}; refusing to apply it`);
        }
      }
    }
    await this.magpie.setCostLimit(rec.keyId, rec.window, cap);
    return cap;
  }

  /**
   * Reads the key's own numbers back from the gateway and checks that the cap is
   * the one written. Throws when the key is not actually held.
   */
  async verify(rec: ConsumerRecord, expectedCap: number = rec.capUsd): Promise<LimitStatus> {
    const status = await this.magpie.limitStatus(rec.secret);
    const lim = status.limit;
    if (!status.limited || !lim) {
      throw new Error(`key ${rec.keyName} is not held to a limit after the update (Magpie reports limited=false)`);
    }
    const cap = lim.costLimit ?? 0;
    if (Math.abs(cap - expectedCap) > 1e-9) {
      throw new Error(`key ${rec.keyName}: read back costLimit ${cap}, wrote ${expectedCap}`);
    }
    rec.lastCheck = {
      at: new Date().toISOString(),
      usedUsd: lim.cost ?? 0,
      leftUsd: lim.costLeft ?? 0,
      calls: lim.calls ?? 0,
      spent: Boolean(lim.spent),
    };
    this.persist();
    return status;
  }

  /**
   * The accounting check for one consumer, serialized with every money
   * operation on it. It imports settled usage from every unsettled window,
   * compares the bound price/window/native cost with the ledger, and pauses the
   * consumer when any of them cannot be proven.
   */
  async checkConsumer(consumerId: string): Promise<ConsumerView> {
    return this.withLock(consumerId, async () => {
      const rec = this.find(consumerId);
      if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
      await this.reconcile(rec);
      if (this.ledger) {
        const check = await this.ledgerCheck(rec);
        if (!check.verified) {
          // The caller (the periodic check) must count this as a failure, not a
          // healthy result. A paused consumer has no key to read, so it is
          // reported as verified-by-absence rather than throwing.
          throw new VerificationUnavailableError(rec.consumerId, "the gateway key's limit", check.unverified);
        }
        return view(rec, check.status, this.ledger);
      }
      return view(rec, await this.verify(rec), this.ledger);
    });
  }

  /**
   * The audited way out of a usage-log gap: an operator states what happened.
   * It records the note and nothing else — the missing charges are not
   * reconstructed, and the balance is not adjusted (no compensation in this
   * phase). A reissue is possible afterwards, and it carries only the recorded
   * balance.
   */
  async resolveUsageGap(
    consumerId: string,
    opts: { logId: string; resolvedBy: string; note: string; acceptedOffset?: number },
  ): Promise<ConsumerView> {
    return this.withLock(consumerId, async () => {
      const rec = this.find(consumerId);
      if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
      if (!this.ledger) throw new Error("resolveUsageGap requires the durable ledger");
      if (!opts.resolvedBy?.trim() || !opts.note?.trim()) {
        throw new Error("resolving a usage gap needs who resolved it and a note");
      }
      // The operator accepts everything the log currently holds as accounted
      // for (usually written off). Without that baseline the next read would
      // rediscover the same truncation.
      const path = this.usageLog();
      const acceptedOffset =
        opts.acceptedOffset !== undefined ? Math.max(0, Math.trunc(opts.acceptedOffset)) : existsSync(path) ? statSync(path).size : 0;
      this.ledger.resolveGap({
        consumerId,
        logId: opts.logId,
        resolvedBy: opts.resolvedBy.trim(),
        note: opts.note.trim(),
        acceptedOffset,
      });
      rec.ledgerUncertain = this.ledger.openGaps(consumerId)[0]?.reason ?? null;
      this.persist();
      logger.warn(`usage gap of ${consumerId} on ${opts.logId} resolved by ${opts.resolvedBy}: ${opts.note}`);
      return view(rec, rec.paused ? null : await this.verify(rec), this.ledger);
    });
  }

  async status(consumerId: string): Promise<ConsumerView> {
    const rec = this.find(consumerId);
    if (!rec) throw new Error(`no consumer ${consumerId}`);
    return this.withLock(consumerId, async () => {
      await this.reconcile(rec);
      if (this.ledger) {
        const check = await this.ledgerCheck(rec);
        return view(rec, check.status, this.ledger);
      }
      return view(rec, await this.verify(rec), this.ledger);
    });
  }

  /**
   * A simulated deposit: raise the same key's cumulative cap, never reset the
   * window. `depositId` makes a retried deposit a no-op; without one, a fresh id
   * is generated and remembered.
   */
  async topUp(consumerId: string, usd: number, depositId?: string): Promise<ConsumerView> {
    if (typeof usd !== "number" || !Number.isFinite(usd) || !(usd > 0)) throw new Error("a top-up must be positive");
    if (usd < 0.0001) throw new Error("the smallest top-up the key can express is $0.0001");
    const amount = roundCap(usd);
    if (Math.abs(amount - usd) > 1e-9) throw new Error(`$${usd} is not on Magpie's $0.0001 grid (use $${amount.toFixed(4)})`);

    return this.withLock(consumerId, async () => {
      const rec = this.find(consumerId);
      if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
      await this.reconcile(rec);
      const unknown = await this.blockUnknownProvenance(rec);
      if (unknown) throw new Error(`top-up refused: ${unknown}`);
      const id = depositId?.trim() || randomUUID();
      if (isReservedDepositId(id)) {
        throw new Error(`deposit id ${JSON.stringify(id)} is reserved for chain/opening funds; a local top-up must use its own id`);
      }
      const idApplied = rec.deposits.find((d) => d.id === id);
      const ledgerApplied = this.ledger?.deposit(id) ?? null;
      if (ledgerApplied && ledgerApplied.fundsClass !== "simulated" && ledgerApplied.fundsClass !== "manual") {
        throw new Error(`deposit ${id} is a ${ledgerApplied.fundsClass} deposit; a local top-up cannot reuse it`);
      }
      if (idApplied || ledgerApplied?.status === "applied") {
        const seen = ledgerApplied?.amountNanos ?? usdToNanos(idApplied!.usd);
        if (Math.abs(nanosToUsd(seen) - amount) > 1e-9) {
          throw new Error(`deposit ${id} was already applied with $${nanosToUsd(seen)}; it cannot be replayed with $${amount}`);
        }
        logger.info(`deposit ${id} for ${consumerId} was already applied; returning the current state`);
        return view(rec, rec.paused ? null : await this.verify(rec), this.ledger);
      }
      if (rec.pending && rec.pending.depositId === id && Math.abs(rec.pending.usd - amount) > 1e-9) {
        throw new Error(`deposit ${id} is pending with $${rec.pending.usd}; it cannot be replayed with $${amount}`);
      }
      if (ledgerApplied?.status === "failed") {
        throw new Error(`deposit ${id} failed earlier; a new deposit id is required`);
      }

      // A paused consumer has no usable key. Credit can still be recorded in
      // the ledger: there is no native cap to verify, and reissue will spend
      // the resulting balance. This is what lets an overdraft be repaid.
      if (this.ledger && rec.paused) return this.topUpPaused(rec, amount, id);

      if (this.ledger) return this.topUpLedger(rec, amount, id);

      const before = await this.verify(rec);
      const usedBefore = before.limit?.cost ?? 0;
      const newCap = assertCap(roundCap(rec.capUsd + amount));

      // The intent is on disk before Magpie is touched, so a crash here can be
      // reconciled from what the gateway holds instead of double-crediting.
      rec.pending = { capUsd: newCap, depositId: id, usd: amount, fundsClass: "simulated", chainId: null, assetId: null, source: "simulated" };
      this.persist();

      await this.setCap(rec, newCap, { depositId: id, fundsClass: "simulated" });
      const after = await this.verify(rec, newCap);
      const usedAfter = after.limit?.cost ?? 0;
      // Usage moving while the cap is written is normal: the consumer is allowed
      // to call models during a top-up, and a window may roll over. The deposit
      // is about the cap only, so this is recorded and never treated as failure.
      if (Math.abs(usedAfter - usedBefore) > 1e-9) {
        logger.info(
          `deposit ${id}: usage moved ${usedBefore} -> ${usedAfter} while the cap was raised (allowed)`,
        );
      }

      rec.capUsd = newCap;
      rec.creditedUsd = roundCap(rec.creditedUsd + amount);
      rec.deposits.push({ id, usd: amount, at: new Date().toISOString() });
      rec.pending = null;
      this.persist();
      if (usedAfter >= newCap) {
        logger.warn(`top-up left ${consumerId} over budget: used ${usedAfter}, cap ${newCap}`);
      }
      logger.info(`simulated deposit ${id} of ${amount} USD for ${consumerId}: cap ${newCap}, used ${usedAfter}`);
      return view(rec, after, this.ledger);
    });
  }

  /** Records a deposit while paused; no key exists until a later reissue. */
  private async topUpPaused(rec: ConsumerRecord, amount: number, id: string): Promise<ConsumerView> {
    const ledger = this.ledger!;
    const amountNanos = usdToNanos(amount);
    ledger.depositIntent({ id, consumerId: rec.consumerId, amountNanos, source: "simulated" });
    ledger.markDepositApplied(id, rec.paused?.windowId ?? "", amountNanos);
    rec.creditedUsd = roundCap(rec.creditedUsd + amount);
    if (!rec.deposits.some((d) => d.id === id)) {
      rec.deposits.push({ id, usd: amount, at: new Date().toISOString() });
    }
    this.persist();
    logger.info(`simulated deposit ${id} of ${amount} USD for paused ${rec.consumerId}; reissue to use it`);
    return view(rec, null, this.ledger);
  }

  /**
   * The ledger path of a top-up. The cap is `native used + ledger balance`,
   * never `old cap + amount`: after a price change or a window boundary the old
   * cap means nothing. The deposit is booked only after Magpie's read-back
   * shows the cap, so a crash cannot mint credit.
   */
  private async topUpLedger(rec: ConsumerRecord, amount: number, id: string): Promise<ConsumerView> {
    const ledger = this.ledger!;
    const check = await this.ledgerCheck(rec);
    if (rec.paused) {
      throw new Error(`consumer ${rec.consumerId} is paused (${rec.paused.reason}); reissue the key before a top-up`);
    }
    const window = check.window;
    const status = check.status;
    if (!window || !status) throw new Error(`consumer ${rec.consumerId} has no readable open window`);
    const snap = await this.snapshotFor(rec.models);
    if (!snap) {
      await this.pause(rec, "unpriced", "top-up refused: a shared model has no complete effective price");
      throw new Error("top-up refused: a shared model has no complete effective price");
    }
    if (snap.version !== window.priceVersion) {
      await this.pause(rec, "price-mismatch", `top-up refused: key is bound to ${window.priceVersion.slice(0, 16)}…`);
      throw new Error("top-up refused: the effective price changed; reissue the key at the new price");
    }
    const usedNanos = usdToNanos(status.limit?.cost ?? 0);
    const amountNanos = usdToNanos(amount);
    ledger.depositIntent({ id, consumerId: rec.consumerId, amountNanos, source: "simulated" });
    const balanceAfter = ledger.balance(rec.consumerId).balanceNanos + amountNanos;
    const capNanos = floorGrid(usedNanos + balanceAfter);
    if (capNanos < GRID_NANOS) {
      ledger.markDepositFailed(id, "credit is below Magpie's $0.0001 enforceable minimum");
      throw new Error("top-up refused: the resulting credit is below $0.0001 and cannot be enforced; add more");
    }
    if (capNanos / 1_000_000_000 > MAX_CAP_USD) {
      ledger.markDepositFailed(id, "resulting cap above the maximum");
      throw new Error(`a cost cap above $${MAX_CAP_USD} is refused`);
    }
    const capUsd = assertCap(capNanos / 1_000_000_000);
    rec.pending = { capUsd, depositId: id, usd: amount, fundsClass: "simulated", chainId: null, assetId: null, source: "simulated" };
    this.persist();
    try {
      await this.setCap(rec, capUsd, { depositId: id, fundsClass: "simulated" });
      const after = await this.verify(rec, capUsd);
      ledger.markDepositApplied(id, window.id, capNanos);
      rec.capUsd = capUsd;
      rec.creditedUsd = roundCap(rec.creditedUsd + amount);
      if (!rec.deposits.some((d) => d.id === id)) {
        rec.deposits.push({ id, usd: amount, at: new Date().toISOString() });
      }
      rec.pending = null;
      rec.priceVersion = window.priceVersion;
      this.persist();
      if ((after.limit?.cost ?? 0) >= capUsd) {
        logger.warn(`top-up left ${rec.consumerId} over budget: used ${after.limit?.cost}, cap ${capUsd}`);
      }
      logger.info(`simulated deposit ${id} of ${amount} USD for ${rec.consumerId}: cap ${capUsd}, used ${after.limit?.cost}`);
      return view(rec, after, this.ledger);
    } catch (e) {
      // The intent stays on disk; reconcile() confirms it only if the read-back
      // later shows this exact cap. It is never retried with a blind += amount.
      logger.error(`deposit ${id} for ${rec.consumerId} is pending: ${String(e)}`);
      throw e;
    }
  }

  /**
   * Applies a deposit the ledger already holds, without creating it.
   *
   * This is the chain module's only way in. The phase-6 `topUp()` computes an
   * amount from a caller's USD figure; a chain deposit has already been priced
   * and booked by `depositIntent()` from a finalized on-chain amount, so
   * re-deriving it here would be a second, competing calculation. The cap is
   * therefore `native used + the ledger's balance including this deposit`,
   * exactly as `topUpLedger` computes it, and the read-back rule is unchanged:
   * the deposit is marked applied only after Magpie reports the cap.
   *
   * Idempotent: an already-applied deposit returns the current view, and a
   * pending one is reconciled first. A crash between the cap write and the
   * local commit leaves `rec.pending` set, which `reconcile()` finishes.
   */
  async applyChainDeposit(input: { id: string; consumerId: string; amountNanos: number }): Promise<ConsumerView> {
    if (!this.ledger) throw new Error("a chain deposit needs the durable ledger");
    if (!Number.isInteger(input.amountNanos) || input.amountNanos <= 0) throw new Error("a chain deposit must be a positive integer amount");
    return this.withLock(input.consumerId, async () => {
      const rec = this.find(input.consumerId);
      if (!rec || rec.revokedAt) throw new Error(`no active consumer ${input.consumerId}`);
      await this.reconcile(rec);
      const unknown = await this.blockUnknownProvenance(rec);
      if (unknown) throw new Error(`chain deposit refused: ${unknown}`);
      const ledger = this.ledger!;
      const booked = ledger.deposit(input.id);
      if (!booked) throw new Error(`deposit ${input.id} was not booked before it was applied`);
      // Defence in depth at the only chain-credit → Magpie-cap bridge.
      if (booked.fundsClass !== "chain") {
        throw new Error(`deposit ${input.id} is a ${booked.fundsClass} deposit, not chain-derived; it cannot be applied by the chain path`);
      }
      const bookedChainId = booked.chainId ?? classifyChainSource(booked.source);
      if (bookedChainId === null || !Number.isSafeInteger(bookedChainId) || bookedChainId <= 0) {
        throw new Error(`chain deposit ${input.id} has no trustworthy chain id`);
      }
      assertCreditChainAllowed(bookedChainId);
      if (!booked.assetId || assetIdChainId(booked.assetId) !== bookedChainId) {
        throw new Error(`chain deposit ${input.id} has no asset id on chain ${bookedChainId}; refusing actual money movement`);
      }
      assertCreditSourceNotMainnet(booked.source);
      if (booked.consumerId !== input.consumerId) throw new Error(`deposit ${input.id} belongs to ${booked.consumerId}`);
      if (booked.amountNanos !== input.amountNanos) {
        throw new Error(`deposit ${input.id} was booked at ${booked.amountNanos} nanos, not ${input.amountNanos}`);
      }
      if (booked.status === "applied") return view(rec, rec.paused ? null : await this.verify(rec), this.ledger);
      if (booked.status === "failed") throw new Error(`deposit ${input.id} failed earlier; it needs a new id`);

      // A paused consumer keeps the credit in the ledger; reissue spends it.
      // This is what lets a chain deposit repay an overdraft without a key.
      if (rec.paused) {
        ledger.markDepositApplied(input.id, rec.paused.windowId ?? "", input.amountNanos);
        rec.creditedUsd = roundCap(rec.creditedUsd + nanosToUsd(input.amountNanos));
        if (!rec.deposits.some((d) => d.id === input.id)) {
          rec.deposits.push({ id: input.id, usd: nanosToUsd(input.amountNanos), at: new Date().toISOString() });
        }
        this.persist();
        logger.info(`chain deposit ${input.id} of ${nanosToUsd(input.amountNanos)} test USD booked for paused ${rec.consumerId}; reissue to use it`);
        return view(rec, null, this.ledger);
      }

      const check = await this.ledgerCheck(rec);
      const window = check.window;
      const status = check.status;
      if (!window || !status) throw new Error(`consumer ${input.consumerId} has no readable open window`);
      const snap = await this.snapshotFor(rec.models);
      if (!snap) {
        await this.pause(rec, "unpriced", "a chain deposit could not be applied: a shared model has no complete effective price");
        throw new Error("a shared model has no complete effective price");
      }
      if (snap.version !== window.priceVersion) {
        await this.pause(rec, "price-mismatch", `a chain deposit arrived while the key is bound to ${window.priceVersion.slice(0, 16)}…`);
        throw new Error("the effective price changed; the deposit is booked and will apply after a reissue");
      }
      const usedNanos = usdToNanos(status.limit?.cost ?? 0);
      // The deposit is still an *intent* here: `balance()` counts applied
      // deposits only, so the amount has to be added explicitly. Without this a
      // second deposit arriving before the first is applied would compute a cap
      // that leaves the newer credit unenforced.
      const balanceAfter = ledger.balance(rec.consumerId).balanceNanos + input.amountNanos;
      const capNanos = floorGrid(usedNanos + balanceAfter);
      if (capNanos < GRID_NANOS) {
        ledger.markDepositFailed(input.id, "credit is below Magpie's $0.0001 enforceable minimum");
        throw new Error("the resulting credit is below $0.0001 and cannot be enforced; add more");
      }
      if (capNanos / 1_000_000_000 > MAX_CAP_USD) {
        ledger.markDepositFailed(input.id, "resulting cap above the maximum");
        throw new Error(`a cost cap above $${MAX_CAP_USD} is refused`);
      }
      const capUsd = assertCap(capNanos / 1_000_000_000);
      rec.pending = {
        capUsd,
        depositId: input.id,
        usd: nanosToUsd(input.amountNanos),
        fundsClass: "chain",
        chainId: bookedChainId,
        assetId: booked.assetId,
        source: booked.source,
      };
      this.persist();
      try {
        await this.setCap(rec, capUsd, { depositId: input.id, fundsClass: "chain" });
        const after = await this.verify(rec, capUsd);
        ledger.markDepositApplied(input.id, window.id, capNanos);
        rec.capUsd = capUsd;
        rec.creditedUsd = roundCap(rec.creditedUsd + nanosToUsd(input.amountNanos));
        if (!rec.deposits.some((d) => d.id === input.id)) {
          rec.deposits.push({ id: input.id, usd: nanosToUsd(input.amountNanos), at: new Date().toISOString() });
        }
        rec.pending = null;
        rec.priceVersion = window.priceVersion;
        this.persist();
        logger.info(`chain deposit ${input.id} of ${nanosToUsd(input.amountNanos)} test USD for ${rec.consumerId}: cap ${capUsd}, used ${after.limit?.cost}`);
        return view(rec, after, this.ledger);
      } catch (e) {
        logger.error(`chain deposit ${input.id} for ${rec.consumerId} is pending: ${String(e)}`);
        throw e;
      }
    });
  }

  /**
   * Reissues a paused key with the same secret and name. The balance is the
   * ledger's (deposits minus settled consumption), never the old cap: a window
   * boundary therefore cannot re-grant what was already spent, and a price
   * change starts a new immutable price version without repricing history.
   */
  async reissue(
    consumerId: string,
    opts: { acceptPriceVersion?: string; acceptQuoteHash?: string } = {},
  ): Promise<ConsumerView> {
    return this.withLock(consumerId, async () => {
      const rec = this.find(consumerId);
      if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
      if (!this.ledger) throw new Error("reissue requires the durable ledger");
      if (rec.pending) {
        throw new Error(
          `consumer ${consumerId} has an unconfirmed deposit ${rec.pending.depositId}; reconcile it before reissue (no blind retry)`,
        );
      }
      const ledger = this.ledger;
      let account = ledger.account(consumerId);
      if (!account) {
        await this.seedLedger(rec);
        account = ledger.account(consumerId);
      }
      const snap = await this.snapshotFor(rec.models);
      if (!snap) throw new Error("cannot reissue: a shared model has no complete effective price");
      if (rec.paused?.reason === "price-mismatch") {
        if (opts.acceptPriceVersion !== snap.version) {
          throw new Error(
            `the effective price changed to ${snap.version}; pass acceptPriceVersion=${snap.version} to accept it explicitly`,
          );
        }
      }
      const oldWindow = rec.paused?.windowId ? ledger.window(rec.paused.windowId) : ledger.openWindowFor(consumerId);
      const boundVersion = oldWindow?.priceVersion ?? rec.priceVersion ?? null;
      if (boundVersion && boundVersion !== snap.version && opts.acceptPriceVersion !== snap.version) {
        throw new Error(
          `this key is bound to price version ${boundVersion}; pass acceptPriceVersion=${snap.version} to accept the change`,
        );
      }
      if (oldWindow) {
        ledger.markWindowDraining(oldWindow.id);
        ledger.importUsage({ consumerId, window: oldWindow, logPath: this.usageLog() });
      }
      // A gap means charges may be missing. Reissuing would grant a balance the
      // plugin cannot prove, so it is refused until an operator resolves the
      // gap with an audited note. The trusted balance is not touched and no key
      // is created; the old key (if any) is left exactly as it was.
      const gaps = ledger.openGaps(consumerId);
      if (gaps.length > 0) {
        rec.ledgerUncertain = gaps[0].reason;
        this.persist();
        throw new Error(
          `cannot reissue ${consumerId}: its usage log has an unresolved gap (${gaps[0].reason}). ` +
            `The recorded charges may be incomplete; resolve the gap with an audit note before reissuing. No key was created.`,
        );
      }
      // A key is revoked first: no new request may enter while its usage is
      // being finalized. The secret is kept so the consumer does not reconfigure.
      if (rec.keyId && this.magpie.keyById(rec.keyId)) {
        await this.magpie.removeKey(rec.keyId);
        if (this.magpie.keyById(rec.keyId)) throw new Error("could not revoke the old key; refusing to issue another");
      }
      // Wait a bounded time for in-flight streams to settle. A request longer
      // than this is reported as an operational uncertainty, not silently
      // treated as free; the cap is still the ledger balance.
      const deadline = Date.now() + this.drainMs;
      let quiet = 0;
      let lastOffset = -1;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        const before = oldWindow
          ? ledger.importUsage({ consumerId, window: oldWindow, logPath: this.usageLog() }).lastOffset
          : -1;
        if (before === lastOffset) quiet += 1;
        else quiet = 0;
        lastOffset = before;
        if (quiet >= 2) break;
      }
      const balance = ledger.balance(consumerId);
      if (balance.unreviewedNanos > 0) {
        const detail = `${nanosToUsd(balance.unreviewedNanos).toFixed(9)} USD of deposit provenance is unknown; review it locally before reissue`;
        rec.ledgerUncertain = detail;
        await this.pause(rec, "manual", detail, true);
        this.persist();
        throw new Error(`cannot reissue ${consumerId}: ${detail}. No key was created.`);
      }
      if (oldWindow) ledger.closeWindow(oldWindow.id, `reissued: ${rec.paused?.reason ?? "manual"}`);
      if (balance.balanceNanos < GRID_NANOS) {
        const reason: NonNullable<ConsumerRecord["paused"]>["reason"] = balance.balanceNanos < 0 ? "overdraft" : "dust";
        const detail =
          balance.balanceNanos < 0
            ? `overdraft ${nanosToUsd(balance.overdraftNanos).toFixed(4)} USD; a new key needs a top-up`
            : `remaining ${nanosToUsd(balance.balanceNanos).toFixed(9)} USD is below Magpie's $0.0001 minimum`;
        rec.priceVersion = snap.version;
        await this.pause(rec, reason, detail, true);
        if (rec.paused) rec.paused.enforced = true; // no key exists now
        this.persist();
        return view(rec, null, this.ledger);
      }
      const capNanos = floorGrid(balance.balanceNanos);
      const capUsd = assertCap(capNanos / 1_000_000_000);
      let key: Awaited<ReturnType<Magpie["addKey"]>> | null = null;
      try {
        // A generated `sk-magpie-` secret cannot be set through --key. New
        // consumers have a plugin-owned secret and keep it; a legacy one gets a
        // new secret and must be handed over again.
        const reusable = rec.secret && !rec.secret.startsWith("sk-magpie-") ? rec.secret : undefined;
        key = await this.magpie.addKey(rec.keyName, reusable);
        await this.magpie.setModels(key.id, rec.models);
        await this.magpie.setQuotasOff(key.id);
        await this.magpie.setCostLimit(key.id, rec.window, capUsd);
        const status = await this.magpie.limitStatus(key.secret);
        if (!status.limited || Math.abs((status.limit?.costLimit ?? 0) - capUsd) > 1e-9) {
          throw new Error(`new key read back costLimit ${status.limit?.costLimit}, wrote ${capUsd}`);
        }
        const newWindow = ledger.openWindow({
          consumerId,
          keyId: key.id,
          keyName: rec.keyName,
          price: snap,
          windowSpec: rec.window,
          startAt: status.limit?.start ?? this.windowBounds(rec.window).start,
          resetAt: status.limit?.reset ?? this.windowBounds(rec.window).reset,
          capNanos,
        });
        ledger.setKey(consumerId, key.id, rec.keyName);
        if (reusable && key.secret !== reusable) throw new Error("Magpie did not keep the reissued key's secret");
        rec.keyId = key.id;
        rec.secret = key.secret;
        rec.capUsd = capUsd;
        rec.pending = null;
        rec.paused = null;
        rec.priceVersion = snap.version;
        if (opts.acceptQuoteHash) rec.acceptedQuoteHash = opts.acceptQuoteHash;
        rec.lastCheck = {
          at: new Date().toISOString(),
          usedUsd: status.limit?.cost ?? 0,
          leftUsd: status.limit?.costLeft ?? capUsd,
          calls: status.limit?.calls ?? 0,
          spent: Boolean(status.limit?.spent),
        };
        this.persist();
        ledger.event(consumerId, "reissued", {
          windowId: newWindow.id,
          keyId: key.id,
          capNanos,
          priceVersion: snap.version,
        });
        logger.info(`reissued ${consumerId}: key ${rec.keyId}, cap ${capUsd}, balance ${nanosToUsd(balance.balanceNanos)}`);
        return view(rec, status, this.ledger);
      } catch (e) {
        if (key) await this.magpie.removeKey(key.id).catch(() => {});
        // The old key is already gone and no new key survived the failure, so
        // nothing can be called; the failure itself is still reported.
        rec.paused = {
          at: new Date().toISOString(),
          reason: "manual",
          detail: `reissue failed: ${String(e)}`,
          windowId: oldWindow?.id ?? null,
          enforced: !rec.keyId || !this.magpie.keyById(rec.keyId),
          enforcement: !rec.keyId || !this.magpie.keyById(rec.keyId) ? "keyRevoked" : "safetyUncertain",
          enforcementError: String((e as Error).message ?? e),
        };
        ledger.setPaused(consumerId, `reissue failed: ${String(e)}`);
        this.persist();
        throw new Error(`reissue of ${consumerId} failed and left the consumer paused: ${String(e)}`);
      }
    });
  }

  async revoke(consumerId: string): Promise<ConsumerView> {
    return this.withLock(consumerId, async () => {
      const rec = this.find(consumerId);
      if (!rec) throw new Error(`no consumer ${consumerId}`);
      if (!rec.revokedAt) {
        try {
          if (this.magpie.keyById(rec.keyId)) await this.magpie.removeKey(rec.keyId);
        } finally {
          rec.revokedAt = new Date().toISOString();
          rec.secret = "";
          rec.pending = null;
          rec.paused = null;
          if (this.ledger) {
            const w = this.ledger.openWindowFor(rec.consumerId);
            if (w) this.ledger.closeWindow(w.id, "revoked");
            this.ledger.revokeAccount(rec.consumerId, "revoked");
          }
          this.persist();
        }
        logger.info(`revoked gateway key ${rec.keyName} (${rec.keyId})`);
      }
      return view(rec, null, this.ledger);
    });
  }

  /**
   * Replaces a consumer's whitelist (used when a shared model stopped being
   * shareable). Refuses an empty list: a key without models would be unlimited
   * in Magpie's eyes, so the caller must revoke instead.
   */
  async setModels(consumerId: string, models: string[]): Promise<ConsumerView> {
    if (!Array.isArray(models) || models.length === 0) throw new Error("refusing to set an empty model whitelist");
    for (const m of models) {
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._*,/-]+$/.test(m)) throw new Error(`bad model name: ${m}`);
    }
    this.validateModels(models);
    return this.withLock(consumerId, async () => {
      const rec = this.find(consumerId);
      if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
      await this.magpie.setModels(rec.keyId, models);
      rec.models = [...models];
      this.persist();
      logger.info(`key ${rec.keyName}: model whitelist set to ${models.join(", ")}`);
      if (this.ledger) {
        const check = await this.ledgerCheck(rec);
        return view(rec, check.status, this.ledger);
      }
      return view(rec, await this.verify(rec), this.ledger);
    });
  }

  /**
   * Reconciles the three stores after a crash: Magpie's key list, the ledger and
   * consumers.json. It never mints credit and never adopts a key it cannot bind
   * to a ledger window.
   *
   *  - ledger account + open window, key present  → adopt the record (or finish
   *    a reissue whose consumers.json write was lost);
   *  - ledger window, key absent                  → pause (`manual`); the
   *    balance stays in the ledger for a later reissue;
   *  - Magpie key named like ours, no ledger      → remove it: an unbound key has
   *    no balance behind it, so it must not serve;
   *  - record with no ledger account              → seed from `cap - used`, as a
   *    legacy migration does.
   */
  async recover(): Promise<{ recovered: string[]; removed: string[]; uncertain: string[] }> {
    const ledger = this.ledger;
    const recovered: string[] = [];
    const removed: string[] = [];
    const uncertain: string[] = [];
    if (!ledger) return { recovered, removed, uncertain };
    const known = new Set(this.list.map((c) => c.consumerId));
    for (const account of ledger.accounts()) {
      if (account.status === "revoked" || known.has(account.consumerId)) continue;
      const window = ledger.openWindowFor(account.consumerId);
      const held = window ? this.magpie.keyById(window.keyId) : undefined;
      if (!window || !held) {
        // Money is recorded but no key can serve it. Keep the ledger, report it.
        uncertain.push(account.consumerId);
        ledger.event(account.consumerId, "recovery-uncertain", { windowId: window?.id ?? null, keyId: window?.keyId ?? null });
        logger.error(
          `recovery: ledger has ${account.consumerId} but no usable key` +
            (window ? ` (${window.keyId} is gone)` : " (no open window)") +
            "; its balance is kept and it is not served",
        );
        continue;
      }
      // A committed window and a live key with no consumer record: the reissue
      // finished in Magpie and SQLite, then the process died before the record.
      this.list.push({
        consumerId: account.consumerId,
        keyName: account.keyName ?? window.keyName,
        keyId: window.keyId,
        secret: held.secret,
        models: [...(held.models ?? [])].length ? [...(held.models ?? [])].map(String) : this.ledger!.windowModels(window),
        window: window.windowSpec,
        capUsd: window.capNanos / 1_000_000_000,
        creditedUsd: 0,
        deposits: [],
        pending: null,
        paused: null,
        priceVersion: window.priceVersion,
        acceptedQuoteHash: null,
        createdAt: account.createdAt,
        revokedAt: null,
        lastCheck: null,
      });
      registerSecret(held.secret);
      recovered.push(account.consumerId);
      ledger.event(account.consumerId, "recovery-adopted", { windowId: window.id, keyId: window.keyId });
      logger.warn(`recovery: adopted ${account.consumerId} from the ledger and key ${window.keyId}`);
    }
    // A key this plugin named but no ledger window backs: it has no balance, so
    // it must not be usable. Only the exact naming scheme is touched.
    for (const key of this.magpie.keyList()) {
      const prefix = "ohmyaihub-";
      if (!key.name?.startsWith(prefix)) continue;
      const consumerId = key.name.slice(prefix.length);
      if (known.has(consumerId) || ledger.account(consumerId)) continue;
      try {
        await this.magpie.removeKey(key.id);
        removed.push(consumerId);
        logger.error(`recovery: removed unbound key ${key.name} (${key.id}): no ledger account backs it`);
      } catch (e) {
        uncertain.push(consumerId);
        logger.error(`recovery: could not remove unbound key ${key.name}: ${String(e)}`);
      }
    }
    for (const rec of this.list) {
      if (rec.revokedAt) continue;
      if (!ledger.account(rec.consumerId)) {
        await this.seedLedger(rec).catch((e) => {
          uncertain.push(rec.consumerId);
          logger.error(`recovery: could not seed ${rec.consumerId}: ${String(e)}`);
        });
        recovered.push(rec.consumerId);
      }
    }
    this.persist();
    return { recovered, removed, uncertain };
  }

  static keyName(consumerId: string): string {
    return `ohmyaihub-${consumerId}`;
  }
}

/** A plugin-owned Gateway Key secret; never the reserved sk-magpie- prefix. */
function newConsumerSecret(): string {
  return `sk-ohmy-${randomBytes(32).toString("hex")}`;
}
