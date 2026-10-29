import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stateDir, statePath } from "./paths.ts";
import { logger, registerSecret } from "./log.ts";
import type { Magpie, LimitStatus } from "./magpie.ts";

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
  /** the key secret is never returned by the status view */
}

const FILE = "consumers.json";

interface ConsumersFile {
  consumers: ConsumerRecord[];
}

export function loadConsumers(): ConsumerRecord[] {
  const file = statePath(FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ConsumersFile;
  const list = Array.isArray(parsed.consumers) ? parsed.consumers : [];
  for (const c of list) registerSecret(c.secret);
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
 */
export class Provisioner {
  constructor(private magpie: Magpie) {}

  private list: ConsumerRecord[] = loadConsumers();

  all(): ConsumerView[] {
    return this.list.map((c) => view(c, null));
  }

  /**
   * Every consumer's view, reading each key's numbers from the gateway. A key
   * that cannot be read keeps its last known numbers and says so in lastCheck.
   */
  async refreshAll(): Promise<ConsumerView[]> {
    const out: ConsumerView[] = [];
    for (const c of this.list) {
      if (c.revokedAt || !c.secret) {
        out.push(view(c, null));
        continue;
      }
      try {
        out.push(view(c, await this.verify(c)));
      } catch {
        out.push(view(c, null));
      }
    }
    return out;
  }

  find(consumerId: string): ConsumerRecord | undefined {
    return this.list.find((c) => c.consumerId === consumerId);
  }

  /** Creates the consumer's key if it does not exist yet, and checks it either way. */
  async ensure(
    consumerId: string,
    opts: { models: string[]; window?: string; capUsd: number },
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
    const window = opts.window ?? "day";
    if (!(opts.capUsd >= 0.0001)) throw new Error("a consumer key needs a positive cost cap of at least $0.0001");

    let rec = this.find(consumerId);
    if (rec?.revokedAt) throw new Error(`consumer ${consumerId} was revoked; create a new consumer id`);

    if (!rec) {
      const keyName = `ohmyaihub-${consumerId}`;
      const existing = this.magpie.keyByName(keyName);
      const key = existing ?? (await this.magpie.addKey(keyName));
      rec = {
        consumerId,
        keyName,
        keyId: key.id,
        secret: key.secret,
        models: [...opts.models],
        window,
        capUsd: opts.capUsd,
        creditedUsd: 0,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastCheck: null,
      };
      this.list.push(rec);
      saveConsumers(this.list);
      logger.info(`created gateway key ${keyName} (${key.id}) for ${consumerId}`);
    } else {
      if (!rec.secret) {
        const again = this.magpie.keyById(rec.keyId);
        if (!again) throw new Error(`key ${rec.keyName} no longer exists in Magpie`);
        rec.secret = again.secret;
      }
      if (JSON.stringify(rec.models) !== JSON.stringify(opts.models)) {
        await this.magpie.setModels(rec.keyId, opts.models);
        rec.models = [...opts.models];
        logger.info(`key ${rec.keyName}: model whitelist updated (${opts.models.join(", ")})`);
      }
      if (window !== rec.window) {
        rec.window = window;
      }
      if (opts.capUsd > rec.capUsd) {
        await this.setCap(rec, opts.capUsd);
      }
    }

    await this.magpie.setModels(rec.keyId, rec.models);
    await this.magpie.setQuotasOff(rec.keyId);
    await this.setCap(rec, Math.max(rec.capUsd, opts.capUsd));
    const status = await this.verify(rec);
    saveConsumers(this.list);
    return view(rec, status);
  }

  private async setCap(rec: ConsumerRecord, capUsd: number): Promise<void> {
    if (!(capUsd >= 0.0001)) throw new Error(`refusing a cap below $0.0001 (${capUsd})`);
    const rounded = Math.round(capUsd * 1e4) / 1e4;
    if (rounded !== capUsd) logger.warn(`cost cap ${capUsd} rounded to the $0.0001 grid: ${rounded}`);
    await this.magpie.setCostLimit(rec.keyId, rec.window, rounded);
    rec.capUsd = rounded;
    saveConsumers(this.list);
  }

  /**
   * Reads the key's own numbers back from the gateway and checks that the cap is
   * the one written. Returns the status; throws when the key is not actually held.
   */
  async verify(rec: ConsumerRecord): Promise<LimitStatus> {
    const status = await this.magpie.limitStatus(rec.secret);
    const lim = status.limit;
    if (!status.limited || !lim) {
      throw new Error(`key ${rec.keyName} is not held to a limit after the update (Magpie reports limited=false)`);
    }
    const cap = lim.costLimit ?? 0;
    if (Math.abs(cap - rec.capUsd) > 1e-9) {
      throw new Error(`key ${rec.keyName}: read back costLimit ${cap}, wrote ${rec.capUsd}`);
    }
    rec.lastCheck = {
      at: new Date().toISOString(),
      usedUsd: lim.cost ?? 0,
      leftUsd: lim.costLeft ?? 0,
      calls: lim.calls ?? 0,
      spent: Boolean(lim.spent),
    };
    saveConsumers(this.list);
    return status;
  }

  async status(consumerId: string): Promise<ConsumerView> {
    const rec = this.find(consumerId);
    if (!rec) throw new Error(`no consumer ${consumerId}`);
    const status = await this.verify(rec);
    return view(rec, status);
  }

  /**
   * A simulated deposit: raise the same key's cumulative cap, never reset the
   * window. `usd` is added to the recorded credit and to the cap.
   */
  async topUp(consumerId: string, usd: number): Promise<ConsumerView> {
    if (!(usd > 0)) throw new Error("a top-up must be positive");
    if (usd < 0.0001) throw new Error("the smallest top-up the key can express is $0.0001");
    const rec = this.find(consumerId);
    if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
    const before = await this.verify(rec);
    const used = before.limit?.cost ?? 0;
    const newCap = Math.round((rec.capUsd + usd) * 1e4) / 1e4;
    await this.setCap(rec, newCap);
    const after = await this.verify(rec);
    const afterUsed = after.limit?.cost ?? 0;
    if (Math.abs(afterUsed - used) > 1e-9) {
      throw new Error(`top-up changed the used cost (${used} -> ${afterUsed}); it must raise the cap only`);
    }
    if (afterUsed >= newCap) {
      logger.warn(`top-up left ${consumerId} over budget: used ${afterUsed}, cap ${newCap}`);
    }
    rec.creditedUsd = Math.round((rec.creditedUsd + usd) * 1e4) / 1e4;
    saveConsumers(this.list);
    logger.info(`simulated top-up ${usd} USD for ${consumerId}: cap ${newCap} USD, used ${afterUsed} USD`);
    return view(rec, after);
  }

  async revoke(consumerId: string): Promise<ConsumerView> {
    const rec = this.find(consumerId);
    if (!rec) throw new Error(`no consumer ${consumerId}`);
    if (!rec.revokedAt) {
      await this.magpie.removeKey(rec.keyId);
      rec.revokedAt = new Date().toISOString();
      rec.secret = "";
      saveConsumers(this.list);
      logger.info(`revoked gateway key ${rec.keyName} (${rec.keyId})`);
    }
    return view(rec, null);
  }

  /** Consumers whose key names match this format, for the page. */
  static keyName(consumerId: string): string {
    return `ohmyaihub-${consumerId}`;
  }
}
