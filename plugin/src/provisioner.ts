import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { stateDir, statePath } from "./paths.ts";
import { logger, registerSecret } from "./log.ts";
import type { Magpie, LimitStatus } from "./magpie.ts";
import { Ledger, usageLogPath, type LedgerWindow } from "./ledger.ts";
import {
  GRID_NANOS,
  floorGrid,
  nanosToUsd,
  priceSnapshot,
  usdToNanos,
  type PriceSnapshot,
} from "./pricing.ts";

export interface Deposit {
  id: string;
  usd: number;
  at: string;
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
  pending: { capUsd: number; depositId: string; usd: number } | null;
  /**
   * Fail-closed state. A confirmed price change, a window boundary or a
   * native-vs-ledger drift removes the key and records why; reissue() is the
   * only way back. `enforced` is false when Magpie could not be changed, which
   * must be shown, never hidden.
   */
  paused: {
    at: string;
    reason: "price-mismatch" | "window-rollover" | "drift" | "unpriced" | "overdraft" | "dust" | "manual";
    detail: string;
    windowId: string | null;
    enforced: boolean;
  } | null;
  /** the immutable price version this consumer's current window was issued at */
  priceVersion?: string | null;
  /** the signed catalogue quote the consumer accepted at issuance, if any */
  acceptedQuoteHash?: string | null;
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
    unpricedCalls: number;
  } | null;
  /** the key secret is never returned by the status view */
}

const FILE = "consumers.json";
const MAX_CAP_USD = 1_000_000;
const GRID = 1e4; // Magpie rounds cost caps to 1/10000 USD

export function roundCap(usd: number): number {
  return Math.round(usd * GRID) / GRID;
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
}

export function loadConsumers(): ConsumerRecord[] {
  const file = statePath(FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ConsumersFile;
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
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const file = statePath(FILE);
  writeFileSync(file, JSON.stringify({ consumers: list }, null, 1), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
}

function view(c: ConsumerRecord, status: LimitStatus | null, ledger?: Ledger): ConsumerView {
  const lim = status?.limit ?? null;
  let ledgerView: ConsumerView["ledger"] = null;
  if (ledger) {
    const account = ledger.account(c.consumerId);
    if (account) {
      const w = ledger.openWindowFor(c.consumerId);
      const balance = ledger.balance(c.consumerId);
      let unsettled = 0;
      let unpriced = 0;
      if (w) {
        for (const row of ledger.consumptionForWindow(w.id)) {
          if (!row.priceVerified) {
            unpriced += 1;
            unsettled += row.amountNanos;
          }
        }
      }
      ledgerView = {
        priceVersion: account.priceVersion,
        windowId: w?.id ?? account.windowId,
        start: w?.startAt ?? null,
        reset: w?.resetAt ?? null,
        depositedUsd: nanosToUsd(balance.depositedNanos),
        consumedUsd: nanosToUsd(balance.consumedNanos),
        balanceUsd: nanosToUsd(balance.balanceNanos),
        overdraftUsd: nanosToUsd(balance.overdraftNanos),
        unsettledUsd: nanosToUsd(unsettled),
        unpricedCalls: unpriced,
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

  constructor(private magpie: Magpie, opts: ProvisionerOptions = {}) {
    this.save = opts.save ?? saveConsumers;
    this.validateModels = opts.validateModels ?? (() => {});
    this.ledger = opts.ledger;
    this.prices = opts.prices;
    this.usageLog = opts.usageLog ?? usageLogPath;
    this.drainMs = opts.drainMs ?? 1500;
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

  /** Magpie's effective prices, or null when any model has no whole price. */
  private async snapshotFor(models: string[]): Promise<PriceSnapshot | null> {
    if (!this.prices) return null;
    try {
      return await this.prices(models);
    } catch (e) {
      logger.warn(`cannot read effective prices: ${String(e)}`);
      return null;
    }
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
    const snap =
      (await this.snapshotFor(rec.models)) ?? {
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
      this.ledger.setUsageOffset(rec.keyId, size);
    } catch {
      /* an unreadable log leaves the offset at 0; the unique ids still guard */
    }
    rec.priceVersion = snap.version;
    this.persist();
    return window;
  }

  /** Removes/freezes a key and records why; never claims enforcement it did not get. */
  private async pause(
    rec: ConsumerRecord,
    reason: NonNullable<ConsumerRecord["paused"]>["reason"],
    detail: string,
    force = false,
  ): Promise<void> {
    if (rec.paused && !force) return;
    let enforced = true;
    if (rec.keyId && this.magpie.keyById(rec.keyId)) {
      enforced = false;
      try {
        await this.magpie.removeKey(rec.keyId);
        enforced = !this.magpie.keyById(rec.keyId);
      } catch (e) {
        logger.warn(`could not remove paused key ${rec.keyName}: ${String(e)}`);
      }
      if (!enforced) {
        // Removing is the strong stop; if it failed, collapse the cap to the
        // smallest enforceable value and read it back. A cap of 0 is unlimited,
        // so never write that.
        try {
          await this.magpie.setCostLimit(rec.keyId, rec.window, 0.0001);
          const st = await this.magpie.limitStatus(rec.secret);
          enforced = Math.abs((st.limit?.costLimit ?? 0) - 0.0001) < 1e-9;
        } catch (e) {
          logger.error(`could not freeze paused key ${rec.keyName}: ${String(e)}`);
        }
      }
    }
    const window = this.ledger?.openWindowFor(rec.consumerId) ?? null;
    rec.paused = {
      at: new Date().toISOString(),
      reason,
      detail,
      windowId: window?.id ?? null,
      enforced,
    };
    if (this.ledger) {
      this.ledger.setPaused(rec.consumerId, `${reason}: ${detail}`);
      if (window) this.ledger.closeWindow(window.id, `paused:${reason}`);
    }
    this.persist();
    logger.warn(`paused ${rec.consumerId}: ${reason} (${detail}); enforced=${enforced}`);
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
  ): Promise<{ window: LedgerWindow | null; status: LimitStatus | null; reason: string | null }> {
    if (!this.ledger) return { window: null, status: null, reason: null };
    if (rec.paused) return { window: null, status: null, reason: rec.paused.reason };
    let window = this.ledger.openWindowFor(rec.consumerId);
    if (!window) window = await this.seedLedger(rec);
    if (!window) {
      if (opts.pause) await this.pause(rec, "manual", "ledger account has no open window");
      return { window: null, status: null, reason: "no-window" };
    }
    const imported = this.ledger.importUsage({
      consumerId: rec.consumerId,
      window,
      logPath: this.usageLog(),
    });
    if (!this.magpie.keyById(rec.keyId)) {
      if (opts.pause) await this.pause(rec, "manual", "the key was removed outside the plugin");
      return { window, status: null, reason: "missing-key" };
    }
    let status: LimitStatus | null = null;
    try {
      status = await this.verify(rec);
    } catch (e) {
      // A transient read failure is not evidence of a price/window problem.
      logger.warn(`cannot read ${rec.consumerId}'s key yet: ${String(e)}`);
      return { window, status: null, reason: "unreadable" };
    }
    const snap = await this.snapshotFor(rec.models);
    let reason: string | null = null;
    let detail = "";
    if (!snap) {
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
    } else if (imported.unpriced > 0) {
      reason = "unpriced";
      detail = `${imported.unpriced} settled call(s) had no price in the bound snapshot`;
    } else {
      const native = usdToNanos(status.limit?.cost ?? 0);
      const recorded = this.ledger.windowConsumption(window.id);
      const tolerance = Math.max(GRID_NANOS, Math.round(Math.max(native, recorded) * 0.005));
      if (Math.abs(native - recorded) > tolerance) {
        reason = "drift";
        detail = `native used ${nanosToUsd(native).toFixed(9)} USD, ledger ${nanosToUsd(recorded).toFixed(9)} USD`;
      }
    }
    if (reason && opts.pause) await this.pause(rec, reason as NonNullable<ConsumerRecord["paused"]>["reason"], detail);
    return { window, status, reason };
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

  /** Finishes or discards a cap that was written but not committed locally. */
  async reconcile(c: ConsumerRecord): Promise<void> {
    if (!c.pending || !c.secret) return;
    let status: LimitStatus;
    try {
      status = await this.magpie.limitStatus(c.secret);
    } catch (e) {
      logger.warn(`cannot reconcile ${c.consumerId} yet: ${String(e)}`);
      return;
    }
    const cap = status.limit?.costLimit;
    const pending = c.pending;
    if (cap !== undefined && Math.abs(cap - pending.capUsd) < 1e-9) {
      if (this.ledger) {
        const window = this.ledger.openWindowFor(c.consumerId);
        if (!window) {
          // The cap is in force but there is no window to book it against. Do
          // not credit it twice or lose it; leave the intent and surface it.
          logger.error(`pending deposit ${pending.depositId} is in Magpie but ${c.consumerId} has no open ledger window`);
          return;
        }
        let dep = this.ledger.deposit(pending.depositId);
        if (!dep) {
          dep = this.ledger.depositIntent({
            id: pending.depositId,
            consumerId: c.consumerId,
            amountNanos: usdToNanos(pending.usd),
            source: "simulated",
          }).deposit;
        }
        if (dep.status !== "applied") this.ledger.markDepositApplied(dep.id, window.id, usdToNanos(pending.capUsd));
      }
      c.capUsd = pending.capUsd;
      c.creditedUsd = roundCap(c.creditedUsd + pending.usd);
      if (!c.deposits.some((d) => d.id === pending.depositId)) {
        c.deposits.push({ id: pending.depositId, usd: pending.usd, at: new Date().toISOString() });
      }
      logger.info(`reconciled ${c.consumerId}: the cap written before the restart is in force`);
    } else {
      if (this.ledger && cap !== undefined && Math.abs(cap - c.capUsd) < 1e-9) {
        const dep = this.ledger.deposit(pending.depositId);
        if (dep?.status === "intent") this.ledger.markDepositFailed(dep.id, "Magpie did not apply the cap");
      }
      logger.warn(
        `reconciled ${c.consumerId}: the pending cap ${pending.capUsd} is not what Magpie holds (${String(cap)}); dropped the intent`,
      );
    }
    c.pending = null;
    this.persist();
  }

  /** Creates the consumer's key if it does not exist yet, and checks it either way. */
  async ensure(
    consumerId: string,
    opts: { models: string[]; window?: string; capUsd: number; quoteHash?: string; quotePriceVersion?: string },
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
  private async setCap(rec: ConsumerRecord, capUsd: number): Promise<number> {
    const cap = assertCap(capUsd);
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
      const id = depositId?.trim() || randomUUID();
      const idApplied = rec.deposits.find((d) => d.id === id);
      const ledgerApplied = this.ledger?.deposit(id) ?? null;
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
      rec.pending = { capUsd: newCap, depositId: id, usd: amount };
      this.persist();

      await this.setCap(rec, newCap);
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
    rec.pending = { capUsd, depositId: id, usd: amount };
    this.persist();
    try {
      await this.setCap(rec, capUsd);
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
        rec.paused = {
          at: new Date().toISOString(),
          reason: "manual",
          detail: `reissue failed: ${String(e)}`,
          windowId: oldWindow?.id ?? null,
          enforced: true,
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

  static keyName(consumerId: string): string {
    return `ohmyaihub-${consumerId}`;
  }
}

/** A plugin-owned Gateway Key secret; never the reserved sk-magpie- prefix. */
function newConsumerSecret(): string {
  return `sk-ohmy-${randomBytes(32).toString("hex")}`;
}
