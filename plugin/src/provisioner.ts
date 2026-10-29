import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { stateDir, statePath } from "./paths.ts";
import { logger, registerSecret } from "./log.ts";
import type { Magpie, LimitStatus } from "./magpie.ts";

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

export function loadConsumers(): ConsumerRecord[] {
  const file = statePath(FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ConsumersFile;
  const list = Array.isArray(parsed.consumers) ? parsed.consumers : [];
  for (const c of list) {
    registerSecret(c.secret);
    if (!Array.isArray(c.deposits)) c.deposits = [];
    if (c.pending === undefined) c.pending = null;
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

function view(c: ConsumerRecord, status: LimitStatus | null): ConsumerView {
  const lim = status?.limit ?? null;
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

  constructor(
    private magpie: Magpie,
    opts: { save?: (list: ConsumerRecord[]) => void; validateModels?: (models: string[]) => void } = {},
  ) {
    this.save = opts.save ?? saveConsumers;
    this.validateModels = opts.validateModels ?? (() => {});
    this.list = loadConsumers();
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
    return this.list.map((c) => view(c, null));
  }

  /**
   * Every consumer's view, reading each key's numbers from the gateway. A key
   * that cannot be read keeps its last known numbers.
   */
  async refreshAll(): Promise<ConsumerView[]> {
    const out: ConsumerView[] = [];
    for (const c of this.list) {
      if (c.revokedAt || !c.secret) {
        out.push(view(c, null));
        continue;
      }
      try {
        out.push(
          await this.withLock(c.consumerId, async () => {
            await this.reconcile(c);
            return view(c, await this.verify(c));
          }),
        );
      } catch {
        out.push(view(c, null));
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
    if (cap !== undefined && Math.abs(cap - c.pending.capUsd) < 1e-9) {
      c.capUsd = c.pending.capUsd;
      c.creditedUsd = roundCap(c.creditedUsd + c.pending.usd);
      c.deposits.push({ id: c.pending.depositId, usd: c.pending.usd, at: new Date().toISOString() });
      logger.info(`reconciled ${c.consumerId}: the cap written before the restart is in force`);
    } else {
      logger.warn(
        `reconciled ${c.consumerId}: the pending cap ${c.pending.capUsd} is not what Magpie holds (${String(cap)}); dropped the intent`,
      );
    }
    c.pending = null;
    this.persist();
  }

  /** Creates the consumer's key if it does not exist yet, and checks it either way. */
  async ensure(consumerId: string, opts: { models: string[]; window?: string; capUsd: number }): Promise<ConsumerView> {
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
    const window = opts.window ?? "day";
    if (!/^(day|week|month|\d+d|\d+h)$/.test(window)) throw new Error(`bad limit window ${window}`);
    const capUsd = assertCap(opts.capUsd);

    return this.withLock(consumerId, async () => {
      let rec = this.find(consumerId);
      if (rec?.revokedAt) throw new Error(`consumer ${consumerId} was revoked; create a new consumer id`);
      if (rec) await this.reconcile(rec);

      if (!rec) {
        const keyName = Provisioner.keyName(consumerId);
        const existing = this.magpie.keyByName(keyName);
        let key = existing;
        try {
          key = existing ?? (await this.magpie.addKey(keyName));
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
          await this.setCap(rec, capUsd);
          await this.verify(rec, capUsd);
          rec.capUsd = capUsd;
        }
        await this.verify(rec);
        this.persist();
      }
      const status = await this.verify(rec);
      return view(rec, status);
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
      return view(rec, await this.verify(rec));
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
      const applied = rec.deposits.find((d) => d.id === id);
      if (applied) {
        if (Math.abs(applied.usd - amount) > 1e-9) {
          throw new Error(`deposit ${id} was already applied with $${applied.usd}; it cannot be replayed with $${amount}`);
        }
        logger.info(`deposit ${id} for ${consumerId} was already applied; returning the current state`);
        return view(rec, await this.verify(rec));
      }
      if (rec.pending && rec.pending.depositId === id && Math.abs(rec.pending.usd - amount) > 1e-9) {
        throw new Error(`deposit ${id} is pending with $${rec.pending.usd}; it cannot be replayed with $${amount}`);
      }

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
      return view(rec, after);
    });
  }

  async revoke(consumerId: string): Promise<ConsumerView> {
    return this.withLock(consumerId, async () => {
      const rec = this.find(consumerId);
      if (!rec) throw new Error(`no consumer ${consumerId}`);
      if (!rec.revokedAt) {
        await this.magpie.removeKey(rec.keyId);
        rec.revokedAt = new Date().toISOString();
        rec.secret = "";
        rec.pending = null;
        this.persist();
        logger.info(`revoked gateway key ${rec.keyName} (${rec.keyId})`);
      }
      return view(rec, null);
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
      return view(rec, await this.verify(rec));
    });
  }

  static keyName(consumerId: string): string {
    return `ohmyaihub-${consumerId}`;
  }
}
