// Applications, authorizations, revocations and Gateway Key issuance
// (DESIGN-V2 §5, §7.2, §7.3, §9).
//
// One row per address on both sides:
//   requests  — the last application (what was asked for, when, and its state)
//   consumers — the authorization (what is granted, the key, and its state)
//
// An application never changes a grant; a grant always names a subset of the
// models this node currently publishes *and* Magpie currently prices. The key's
// cost limit is the balance (`D`) floored to Magpie's $0.0001 grid, never a
// per-request budget: there is exactly one source of money, the deposit.
//
// A key is issued only for `D >= $0.0001` (Magpie reads `--cost 0` as
// unlimited). Before stage 4 there are no deposits; stage 4's watcher calls
// `onDeposit`/`onRevert` after every bookkeeping change, and both recompute the
// whole chain `D → cap → key` for that payer. With no money the approval stays
// `waiting-deposit` and the poll answers `approved` with `key: null`; when the
// balance drops to zero the key is removed (never left at an unlimited cap).
//
// The secret is stored here because it has to be handed to the consumer. It is
// never logged, never part of `status`, and only ever leaves through the
// provider→consumer poll response.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { Magpie, type KeyRecord } from "./magpie.ts";
import { resolveMagpieBin } from "./paths.ts";
import { catalogTimestamp } from "./catalog-service.ts";
import {
  balanceMicro,
  creditByPayer,
  capMicroOf,
  formatUsd4,
  metaGet,
  metaSet,
  microFromUsd,
  MIN_CAP_MICRO,
} from "./db.ts";
import { logger, registerSecret } from "./log.ts";
import { listNativeModels } from "./tools/native-models.ts";

export type ConsumerState = "pending" | "waiting-deposit" | "active" | "revoked";
export type PollState = "none" | "pending" | "approved" | "revoked";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const MODEL_LIMIT = 200;
const MODEL_ID_LIMIT = 200;
/** Effectively perpetual: 10 years, so `used` never resets (DESIGN-V2 §6). */
export const LIMIT_WINDOW = "3650d";

export interface ConsumerDbRow {
  address: string;
  granted_models: string;
  requested_models: string;
  key_name: string | null;
  key_secret: string | null;
  state: string;
  created_at: string;
  revoked_at: string | null;
}

export interface RequestDbRow {
  address: string;
  models: string;
  ts: string;
  state: string;
}

/** `GET /request` answer, DESIGN-V2 §8.3. Never signed. */
export interface PollResponse {
  state: PollState;
  grantedModels: string[];
  balanceUsd: string;
  usedUsd: string;
  remainingUsd: string;
  gatewayPort: number;
  key: string | null;
  ts: string;
}

/** `POST /request` answer, DESIGN-V2 §8.2. Never signed. */
export interface RequestAck {
  state: PollState;
  grantedModels: string[];
  requestedModels: string[];
  ts: string;
}

export interface ApproveResult {
  address: string;
  grantedModels: string[];
  state: ConsumerState;
  keyIssued: boolean;
}

export interface RevokeResult {
  address: string;
  state: "revoked";
  keyRemoved: boolean;
  rotated: boolean;
  detail?: string;
}

/**
 * What one `D → cap → key` recomputation did. Returned to the watcher (which
 * only logs it) and never to a tool: a consumer sees the effects through
 * `GET /request` and `history`.
 */
export interface CreditResult {
  address: string;
  state: ConsumerState | "none";
  balanceUsd: string;
  capUsd: string;
  keyIssued: boolean;
  keyRemoved: boolean;
  /** the cap could not be written to Magpie (the ledger is still the truth) */
  keyError?: boolean;
  detail?: string;
}

/** What one boot-time reconciliation pass did. Logged, never returned by a tool. */
export interface ResyncSummary {
  checked: number;
  updated: number;
  failed: number;
  detail?: string;
}

/** What one orphan-key sweep did. Logged, never returned by a tool. */
export interface SweepSummary {
  /** `omai-` keys inspected */
  checked: number;
  /** keys deleted because no consumer row backs them */
  removed: number;
  /** keys rotated (and) or cost-clamped to $0.0001 instead of deleted */
  clamped: number;
  /** keys that could not be cleaned up at all */
  failed: number;
  detail?: string;
}

export interface ConsumerView {
  address: string;
  grantedModels: string[];
  requestedModels: string[];
  state: ConsumerState;
  depositsUsd: string;
  usedUsd: string;
  remainingUsd: string;
  keyIssued: boolean;
}

export interface ConsumersListing {
  consumers: ConsumerView[];
  unclaimed: { address: string; balanceUsd: string }[];
}

export interface GrantsOptions {
  db: Database;
  /** the provider's own address; a getter because wallet_import can replace it */
  address: () => string;
  /** the gateway port published in a poll answer (3425) */
  gatewayPort: number;
  /** native models with a complete price; defaults to Magpie's live list */
  shareable?: () => Promise<{ id: string }[]>;
  /** the ids this node currently publishes (state.json `share.models`) */
  published?: () => string[];
  /** a Magpie client; resolved lazily so boot does not depend on the binary */
  magpie?: () => Magpie;
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

/**
 * The same, but longer: an `ensureKey` failure ends with the fail-closed note
 * ("the half-configured key was removed"), which is the part a reader needs, and
 * a 200-character cut would drop exactly that.
 */
function longError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 600) || "unknown error";
}

export function normalizeAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("E_INPUT: address must be a string");
  const address = value.trim().toLowerCase();
  if (!ADDRESS_RE.test(address)) throw new Error(`E_INPUT: ${value} is not an EVM address`);
  return address;
}

/** The Gateway Key name this plugin owns for one consumer. */
export function gatewayKeyName(address: string): string {
  return `omai-${address.toLowerCase().replace(/^0x/, "").slice(-8)}`;
}

function modelsJson(models: readonly string[]): string {
  return JSON.stringify(models);
}

function parseModels(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** Dedupe, trim, bound. Used for both incoming requests and approvals. */
export function cleanModelList(raw: unknown, label = "models"): string[] {
  if (!Array.isArray(raw)) throw new Error(`E_INPUT: ${label} must be an array of model ids`);
  if (raw.length === 0) throw new Error(`E_INPUT: ${label} must not be empty`);
  if (raw.length > MODEL_LIMIT) throw new Error(`E_INPUT: ${label} has more than ${MODEL_LIMIT} entries`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") throw new Error(`E_INPUT: every entry of ${label} must be a string`);
    const id = item.trim();
    if (!id) throw new Error(`E_INPUT: ${label} must not contain an empty id`);
    if (id.length > MODEL_ID_LIMIT) {
      throw new Error(`E_INPUT: a model id in ${label} is longer than ${MODEL_ID_LIMIT} characters`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The provider-side authorization store. Every method is safe to call twice:
 * a repeated request overwrites the requested set, a repeated approve rewrites
 * the same grant, a repeated revoke finds no key left to remove.
 */
export class Grants {
  constructor(private readonly opts: GrantsOptions) {}

  private get db(): Database {
    return this.opts.db;
  }

  private provider(): string {
    return this.opts.address().toLowerCase();
  }

  private magpie(): Magpie {
    return (this.opts.magpie ?? (() => new Magpie(resolveMagpieBin())))();
  }

  private async shareableModels(): Promise<string[]> {
    const list = this.opts.shareable
      ? await this.opts.shareable()
      : (await listNativeModels()).filter((model) => model.shareable);
    return list.map((model) => model.id);
  }

  private publishedModels(): string[] {
    return this.opts.published ? this.opts.published() : [];
  }

  consumer(address: string): ConsumerDbRow | null {
    return this.db.query("SELECT * FROM consumers WHERE address = ?").get(address) as ConsumerDbRow | null;
  }

  request(address: string): RequestDbRow | null {
    return this.db.query("SELECT * FROM requests WHERE address = ?").get(address) as RequestDbRow | null;
  }

  /** The state a poll answer reports, derived from the one consumer row. */
  pollState(address: string): PollState {
    const consumer = this.consumer(address);
    if (!consumer) return this.request(address) ? "pending" : "none";
    if (consumer.state === "active" || consumer.state === "waiting-deposit") {
      return parseModels(consumer.granted_models).length > 0 ? "approved" : "revoked";
    }
    if (consumer.state === "revoked") return "revoked";
    return "pending";
  }

  /**
   * DESIGN-V2 §8.3. `key` is present only for an approved address whose balance
   * is at least $0.0001; `used` is the last value read from Magpie's limit
   * endpoint (stage 3 never refreshes it on the read path).
   */
  snapshot(address: string): PollResponse {
    const target = normalizeAddress(address);
    const state = this.pollState(target);
    const consumer = this.consumer(target);
    const balance = balanceMicro(this.db, this.provider(), target);
    const used = this.usedMicro(target);
    const granted = state === "approved" && consumer ? parseModels(consumer.granted_models) : [];
    const key =
      state === "approved" && balance >= MIN_CAP_MICRO && consumer?.key_secret ? consumer.key_secret : null;
    return {
      state,
      grantedModels: granted,
      balanceUsd: formatUsd4(balance),
      usedUsd: formatUsd4(used),
      remainingUsd: formatUsd4(balance - used),
      gatewayPort: this.opts.gatewayPort,
      key,
      ts: catalogTimestamp(),
    };
  }

  /**
   * Records an application (DESIGN-V2 §8.2). An approved address only gets its
   * `requested_models` replaced; the grant and the key are untouched. A revoked
   * address that asks again starts a fresh pending application with no grant.
   */
  upsertRequest(address: string, models: string[], ts: string): RequestAck {
    const target = normalizeAddress(address);
    const requested = cleanModelList(models);
    const now = catalogTimestamp();
    const requestTs = typeof ts === "string" && ts ? ts : now;
    const consumer = this.consumer(target);
    const approved = consumer?.state === "active" || consumer?.state === "waiting-deposit";

    if (consumer && approved) {
      this.db.run("UPDATE consumers SET requested_models = ? WHERE address = ?", [modelsJson(requested), target]);
      this.writeRequest(target, requested, requestTs, "approved");
      return {
        state: this.pollState(target),
        grantedModels: parseModels(consumer.granted_models),
        requestedModels: requested,
        ts: now,
      };
    }

    this.writeConsumer({
      address: target,
      granted: [],
      requested,
      keyName: null,
      keySecret: null,
      state: "pending",
      createdAt: consumer?.created_at ?? now,
      revokedAt: null,
    });
    this.writeRequest(target, requested, requestTs, "pending");
    return { state: "pending", grantedModels: [], requestedModels: requested, ts: now };
  }

  /**
   * Approves (or re-approves) a consumer (DESIGN-V2 §7.2). `models` defaults to
   * the pending request; either way the result is intersected with what this
   * node publishes and Magpie still prices. An empty result is `E_INPUT`, never
   * a silent empty grant.
   *
   * The approval is written before the key is attempted, so a Magpie failure
   * leaves a retryable `waiting-deposit` row instead of losing the decision.
   */
  async approve(address: string, models?: string[]): Promise<ApproveResult> {
    const target = normalizeAddress(address);
    const consumer = this.consumer(target);
    const request = this.request(target);
    const asked = models !== undefined && models.length > 0 ? cleanModelList(models) : parseModels(request?.models);
    if (asked.length === 0) {
      throw new Error(
        `E_INPUT: ${target} has no pending request; pass models:[...] to approve an address seen in consumers.unclaimed`,
      );
    }

    const shareable = new Set(await this.shareableModels());
    const published = new Set(this.publishedModels());
    const granted = asked.filter((id) => shareable.has(id) && published.has(id));
    if (granted.length === 0) {
      throw new Error(
        `E_INPUT: none of the requested models is currently shared and priced ` +
          `(asked ${asked.length}; check native_models and share_models)`,
      );
    }

    const balance = balanceMicro(this.db, this.provider(), target);
    const cap = capMicroOf(balance);
    const now = catalogTimestamp();
    const keep = consumer
      ? { name: consumer.key_name, secret: consumer.key_secret, created: consumer.created_at }
      : { name: null, secret: null, created: now };

    this.writeConsumer({
      address: target,
      granted,
      requested: [],
      keyName: keep.name,
      keySecret: keep.secret,
      state: "waiting-deposit",
      createdAt: keep.created,
      revokedAt: null,
    });
    // Keep what was asked for; the grant is a subset and lives in `consumers`.
    const askedFor = parseModels(request?.models);
    this.writeRequest(target, askedFor.length > 0 ? askedFor : granted, request?.ts ?? now, "approved");

    // One code path for `D → cap → key`, shared with the watcher: below $0.0001
    // it also removes a key left over from a larger earlier balance, so the
    // approval cannot keep an unlimited-or-stale cap alive.
    const resynced = await this.resync(target, "deposit");
    if (resynced.state !== "active") {
      if (cap >= MIN_CAP_MICRO) {
        throw new Error(
          `E_MAGPIE: ${target} is approved, but the Gateway Key could not be issued ` +
            `(${resynced.detail ?? "unknown reason"}); the approval is recorded as waiting-deposit — ` +
            "approve again to retry",
        );
      }
      return { address: target, grantedModels: granted, state: "waiting-deposit", keyIssued: false };
    }
    return { address: target, grantedModels: granted, state: "active", keyIssued: true };
  }

  /**
   * Refuses a pending application. An address that already holds a grant must go
   * through `revoke`, which also removes the Magpie key.
   */
  async reject(address: string): Promise<{ address: string; state: "revoked" }> {
    const target = normalizeAddress(address);
    const consumer = this.consumer(target);
    const request = this.request(target);
    if (!consumer && !request) throw new Error(`E_INPUT: no request from ${target}`);
    if (consumer && (consumer.state === "active" || consumer.state === "waiting-deposit")) {
      throw new Error(`E_INPUT: ${target} is already approved; use revoke_consumer to take the key back`);
    }
    const now = catalogTimestamp();
    if (consumer) {
      this.writeConsumer({
        address: target,
        granted: [],
        requested: [],
        keyName: null,
        keySecret: null,
        state: "revoked",
        createdAt: consumer.created_at,
        revokedAt: now,
      });
    }
    this.writeRequest(target, parseModels(request?.models), request?.ts ?? now, "revoked");
    return { address: target, state: "revoked" };
  }

  /**
   * Takes the authorization back (DESIGN-V2 §7.2). The key is removed from
   * Magpie; if removal fails it is rotated, which invalidates the secret the
   * consumer holds even though the key still exists. A Magpie that cannot be
   * reached at all still leaves the local state revoked — the caller is told the
   * key may keep working, and that is the honest answer.
   */
  async revoke(address: string): Promise<RevokeResult> {
    const target = normalizeAddress(address);
    const consumer = this.consumer(target);
    const name = consumer?.key_name ?? gatewayKeyName(target);
    let secret = consumer?.key_secret ?? null;
    let keyRemoved = false;
    let rotated = false;
    let detail: string | undefined;

    try {
      const magpie = this.magpie();
      const record = magpie.keyByName(name);
      if (!record) {
        keyRemoved = true;
        secret = null;
      } else {
        try {
          await magpie.removeKey(record.id);
          keyRemoved = true;
          secret = null;
        } catch (removeError) {
          try {
            secret = await magpie.rotateKey(record.id);
            rotated = true;
            detail =
              `the key could not be removed (${shortError(removeError)}); ` +
              "it was rotated instead, so the consumer's copy is refused";
          } catch (rotateError) {
            detail =
              `the key could not be removed (${shortError(removeError)}) or rotated ` +
              `(${shortError(rotateError)}); the authorization is revoked locally but the old key may still work`;
          }
        }
      }
    } catch (error) {
      detail = `Magpie is unreachable (${shortError(error)}); the authorization is revoked locally, but the key may still work`;
    }

    const now = catalogTimestamp();
    const request = this.request(target);
    if (consumer) {
      this.writeConsumer({
        address: target,
        granted: [],
        requested: [],
        keyName: keyRemoved ? null : name,
        keySecret: keyRemoved ? null : secret,
        state: "revoked",
        createdAt: consumer.created_at,
        revokedAt: now,
      });
    }
    if (request) this.writeRequest(target, parseModels(request.models), request.ts, "revoked");

    return { address: target, state: "revoked", keyRemoved, rotated, ...(detail ? { detail } : {}) };
  }

  /**
   * A deposit was credited for `payer` (DESIGN-V2 §6). The balance is already in
   * the ledger; this recomputes `D → cap` and moves the Gateway Key to match. A
   * payer without an authorization is not an error: the money is visible in
   * `consumers.unclaimed`, and approving that address later issues the key.
   */
  async onDeposit(payer: string): Promise<CreditResult> {
    return this.resync(payer, "deposit");
  }

  /**
   * A credited deposit reverted. Same recomputation, but the only outcome that
   * matters here is a lower cap (or no key at all when `D` reached zero).
   */
  async onRevert(payer: string): Promise<CreditResult> {
    return this.resync(payer, "revert");
  }

  /**
   * Boot-time reconciliation of every authorized consumer (DESIGN-V2 §6, §9).
   *
   * The ledger row and the scan cursor are written in one transaction, but the
   * Magpie cap (and key) are written after it. A host killed between the two
   * leaves a `credited` row whose cap was never applied — and because the cursor
   * already moved, no later scan will revisit that deposit. This walks the
   * consumers table once and re-derives `D → cap → key` for each of them, so the
   * gap closes at the next start instead of at the next deposit.
   *
   * One consumer failing must not stop the others: each row is independent and a
   * failure is logged and counted, never thrown.
   */
  async resyncAll(): Promise<ResyncSummary> {
    let rows: { address: string; granted_models: string; state: string }[];
    try {
      rows = this.db
        .query("SELECT address, granted_models, state FROM consumers ORDER BY address")
        .all() as { address: string; granted_models: string; state: string }[];
    } catch (error) {
      logger.error(`resync: cannot list consumers: ${shortError(error)}`);
      return { checked: 0, updated: 0, failed: 0, detail: shortError(error) };
    }

    let checked = 0;
    let updated = 0;
    let failed = 0;
    for (const row of rows) {
      if (parseModels(row.granted_models).length === 0) continue;
      checked += 1;
      try {
        const result = await this.resync(row.address, "resync");
        if (result.keyError) failed += 1;
        else if (result.state === "active" || result.keyRemoved || result.state !== row.state) updated += 1;
      } catch (error) {
        failed += 1;
        logger.error(`resync: ${row.address} could not be reconciled: ${shortError(error)}`);
      }
    }
    return { checked, updated, failed };
  }

  private async resync(payer: string, kind: "deposit" | "revert" | "resync"): Promise<CreditResult> {
    const target = normalizeAddress(payer);
    const consumer = this.consumer(target);
    const balance = balanceMicro(this.db, this.provider(), target);
    const cap = capMicroOf(balance);
    const base = { address: target, balanceUsd: formatUsd4(balance), capUsd: formatUsd4(cap) };

    if (!consumer) {
      logger.info(
        `${kind}: ${target} has ${formatUsd4(balance)} but no authorization here; ` +
          "it is listed in consumers.unclaimed",
      );
      return {
        ...base,
        state: "none",
        keyIssued: false,
        keyRemoved: false,
        detail: "no authorization; approve_request issues the key once the address is approved",
      };
    }

    if (consumer.state !== "active" && consumer.state !== "waiting-deposit") {
      // A revocation wins over money: the provider said no, and a deposit does
      // not undo it. `approve` is the only way back.
      logger.info(`${kind}: ${target} is ${consumer.state}; the balance changed but no key is issued`);
      return {
        ...base,
        state: consumer.state === "pending" ? "pending" : "revoked",
        keyIssued: Boolean(consumer.key_secret),
        keyRemoved: false,
        detail: "the address is not approved, so the key is left alone",
      };
    }

    const granted = parseModels(consumer.granted_models);
    const requested = parseModels(consumer.requested_models);
    const stopped = granted.length === 0 || cap < MIN_CAP_MICRO;

    if (stopped) {
      let keyRemoved = false;
      let name = consumer.key_name;
      let secret = consumer.key_secret;
      let detail: string | undefined;
      if (name || secret) {
        const dropped = await this.dropKey(target, consumer);
        keyRemoved = dropped.removed;
        name = dropped.name;
        secret = dropped.secret;
        detail = dropped.detail;
      }
      this.writeConsumer({
        address: target,
        granted,
        requested,
        keyName: name,
        keySecret: secret,
        state: "waiting-deposit",
        createdAt: consumer.created_at,
        revokedAt: null,
      });
      return {
        ...base,
        state: "waiting-deposit",
        keyIssued: false,
        keyRemoved,
        ...(name || secret ? { keyError: true } : {}),
        detail:
          detail ??
          (cap < MIN_CAP_MICRO
            ? "below the $0.0001 minimum, so no key is issued (a $0 limit means unlimited in Magpie)"
            : "no granted models, so no key is issued"),
      };
    }

    try {
      const key = await this.ensureKey(target, granted, cap);
      this.writeConsumer({
        address: target,
        granted,
        requested,
        keyName: key.name,
        keySecret: key.secret,
        state: "active",
        createdAt: consumer.created_at,
        revokedAt: null,
      });
      logger.info(
        `${kind}: ${target} now has ${formatUsd4(balance)} → cap $${formatUsd4(cap)} ` +
          `on ${granted.length} model(s)${key.rotatedSecret ? " (key secret replaced)" : ""}`,
      );
      return { ...base, state: "active", keyIssued: true, keyRemoved: false };
    } catch (error) {
      // The money is booked; only the cap failed to follow. Keep the row so the
      // next deposit (or an approve) retries instead of silently forgetting.
      logger.error(`${kind}: ${target} could not have its key updated: ${shortError(error)}`);
      return {
        ...base,
        state: "waiting-deposit",
        keyIssued: false,
        keyRemoved: false,
        keyError: true,
        detail: `the Gateway Key could not be updated: ${longError(error)}`,
      };
    }
  }

  /**
   * Takes a key away fail-closed. Removing it is the clean path; when Magpie
   * refuses, the secret is rotated (so the consumer's copy stops working) and the
   * limit is set to the smallest value Magpie accepts. That is **not** a stop:
   * Magpie still admits requests until about `$0.0001` has been spent, so the
   * result says exactly that instead of claiming the balance cannot be used.
   * When Magpie cannot be reached at all the local state still stops handing the
   * secret out, and the result says so too.
   */
  private async dropKey(
    target: string,
    consumer: ConsumerDbRow,
  ): Promise<{ removed: boolean; name: string | null; secret: string | null; detail?: string }> {
    const name = consumer.key_name ?? gatewayKeyName(target);
    let magpie: Magpie;
    try {
      magpie = this.magpie();
    } catch (error) {
      return {
        removed: false,
        name: consumer.key_name,
        secret: consumer.key_secret,
        detail: `Magpie is unreachable (${shortError(error)}), so the cap could not be lowered`,
      };
    }
    let record;
    try {
      record = magpie.keyByName(name);
    } catch (error) {
      return {
        removed: false,
        name: consumer.key_name,
        secret: consumer.key_secret,
        detail: `Magpie is unreachable (${shortError(error)}), so the cap could not be lowered`,
      };
    }
    if (!record) return { removed: true, name: null, secret: null };
    try {
      await magpie.removeKey(record.id);
      return { removed: true, name: null, secret: null };
    } catch (removeError) {
      try {
        const secret = await magpie.rotateKey(record.id);
        await magpie.setCostLimit(record.id, LIMIT_WINDOW, Number(MIN_CAP_MICRO) / 1_000_000);
        return {
          removed: false,
          name,
          secret,
          detail:
            `the key could not be removed (${shortError(removeError)}); it was rotated and its cost limit was set to ` +
            `$0.0001. The consumer's old secret stops working, but Magpie can still serve roughly $0.0001 of requests ` +
            "under the new one — only a real delete (or a revoke in Magpie) stops it completely",
        };
      } catch (fallbackError) {
        return {
          removed: false,
          name: consumer.key_name,
          secret: consumer.key_secret,
          detail:
            `the key could not be removed (${shortError(removeError)}) or rotated (${shortError(fallbackError)}); ` +
            "the consumer's copy may still work until Magpie is reachable",
        };
      }
    }
  }

  /**
   * `consumers` / `status.sharing.consumers` (DESIGN-V2 §7.2). `usage` reads each
   * active key's used cost from Magpie's own limit endpoint and stores it; the
   * poll path never pays that cost.
   */
  async listing(opts: { usage?: boolean } = {}): Promise<ConsumersListing> {
    if (opts.usage !== false) await this.refreshUsage();
    const rows = this.db
      .query("SELECT * FROM consumers ORDER BY created_at, address")
      .all() as ConsumerDbRow[];
    const provider = this.provider();
    const consumers: ConsumerView[] = rows.map((row) => {
      const balance = balanceMicro(this.db, provider, row.address);
      const used = this.usedMicro(row.address);
      return {
        address: row.address,
        grantedModels: parseModels(row.granted_models),
        requestedModels: parseModels(row.requested_models),
        state: this.displayState(row, balance),
        depositsUsd: formatUsd4(balance),
        usedUsd: formatUsd4(used),
        remainingUsd: formatUsd4(balance - used),
        keyIssued: Boolean(row.key_secret),
      };
    });

    const known = new Set(rows.map((row) => row.address));
    const unclaimed = creditByPayer(this.db, provider)
      .filter((payer) => !known.has(payer.address))
      .map((payer) => ({ address: payer.address, balanceUsd: formatUsd4(payer.micro) }));

    return { consumers, unclaimed };
  }

  private displayState(row: ConsumerDbRow, balance: bigint): ConsumerState {
    if (row.state === "revoked") return "revoked";
    if (row.state === "pending") return "pending";
    return balance >= MIN_CAP_MICRO ? "active" : "waiting-deposit";
  }

  private usedMicro(address: string): bigint {
    const raw = metaGet(this.db, `used:${address}`);
    if (!raw) return 0n;
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }

  private async refreshUsage(): Promise<void> {
    const rows = this.db
      .query("SELECT address, key_secret FROM consumers WHERE key_secret IS NOT NULL AND state IN ('active','waiting-deposit')")
      .all() as { address: string; key_secret: string }[];
    if (rows.length === 0) return;
    let magpie: Magpie;
    try {
      magpie = this.magpie();
    } catch {
      // Without a locatable Magpie the last known used cost is still the best
      // answer; listing consumers must not fail because of it.
      return;
    }
    await Promise.allSettled(
      rows.map(async (row) => {
        try {
          const status = await magpie.limitStatus(row.key_secret, 3000);
          const cost = status.limit?.cost;
          if (typeof cost === "number" && Number.isFinite(cost)) {
            metaSet(this.db, `used:${row.address}`, microFromUsd(cost).toString());
          }
        } catch {
          // Keep the last known value: a gateway that is briefly down must not
          // make a used balance look like zero.
        }
      }),
    );
  }

  /**
   * Creates or updates the consumer's key and sets its cap to the balance.
   *
   * `gateway-key add` produces a key that is **all models, no cost limit** — the
   * widest credential Magpie has. Narrowing it is a second and third CLI call, so
   * a crash or a refusal in between would leave a fully open key in Magpie with
   * nothing in this plugin pointing at it. That key therefore never outlives a
   * failed setup: the created key is removed, and if removal fails it is rotated
   * (the secret it was created with stops working) and clamped to `$0.0001`.
   * The original error is always rethrown — a half-built key is never returned as
   * if it were usable.
   *
   * Updating an existing key is less destructive: its cap is re-applied on
   * failure, and the key keeps the limit Magpie already had rather than being
   * taken away from a consumer who paid.
   */
  private async ensureKey(
    address: string,
    models: string[],
    cap: bigint,
  ): Promise<{ name: string; secret: string; rotatedSecret: boolean }> {
    const magpie = this.magpie();
    const name = gatewayKeyName(address);
    const stored = this.consumer(address)?.key_secret ?? undefined;
    const existing = magpie.keyByName(name);
    const capUsd = Number(cap) / 1_000_000;

    if (existing) {
      let modelsSet = false;
      try {
        await magpie.setModels(existing.id, models);
        modelsSet = true;
        await magpie.setCostLimit(existing.id, LIMIT_WINDOW, capUsd);
      } catch (error) {
        const note = modelsSet
          ? (await this.reapplyCap(magpie, existing.id, capUsd)).note
          : "the model list could not be updated, so the cap was left at its previous value";
        throw new Error(
          `E_MAGPIE: cannot update the Gateway Key ${name}: ${shortError(error)}; ` +
            `${note}. The authorization keeps the last limit Magpie accepted`,
        );
      }
      return { name, secret: existing.secret, rotatedSecret: Boolean(stored && existing.secret !== stored) };
    }

    // The secret is ours: it is generated here, stored in `consumers`, and handed
    // to this one address through the poll response. Magpie only stores it.
    const record = await magpie.addKey(name, stored ?? newKeySecret());
    let narrowed = false;
    try {
      if (!record.secret) throw new Error("Magpie returned a key without a secret");
      await magpie.setModels(record.id, models);
      narrowed = true;
      await magpie.setCostLimit(record.id, LIMIT_WINDOW, capUsd);
      return { name, secret: record.secret, rotatedSecret: Boolean(stored && record.secret !== stored) };
    } catch (error) {
      const retired = await this.retireKey(magpie, record.id, name, narrowed ? models : null);
      throw new Error(
        `E_MAGPIE: the Gateway Key ${name} could not be configured: ${shortError(error)}; ${retired.note}`,
      );
    }
  }

  /**
   * Re-applies the intended cap after a failed update: `setCostLimit` once more,
   * because "it failed once" must not leave a cap wider than `D`.
   */
  private async reapplyCap(magpie: Magpie, id: string, capUsd: number): Promise<{ ok: boolean; note: string }> {
    try {
      await magpie.setCostLimit(id, LIMIT_WINDOW, capUsd);
      return { ok: true, note: `the cost limit was re-applied to $${capUsd.toFixed(4)}` };
    } catch (error) {
      return {
        ok: false,
        note: `its cost limit could not be set to $${capUsd.toFixed(4)} either (${shortError(error)})`,
      };
    }
  }

  /**
   * Disposes of a key this plugin created but could not finish configuring.
   *
   * `attemptRemove` is false when the caller already tried to delete it (the
   * sweep): retrying a delete that Magpie just refused would only blur the
   * reported outcome.
   */
  private async retireKey(
    magpie: Magpie,
    id: string,
    name: string,
    models: string[] | null,
    attemptRemove = true,
  ): Promise<{ outcome: "removed" | "clamped" | "failed"; note: string }> {
    if (attemptRemove) {
      try {
        await magpie.removeKey(id);
        return { outcome: "removed", note: "the half-configured key was removed from Magpie" };
      } catch (removeError) {
        const retired = await this.retireKey(magpie, id, name, models, false);
        return {
          outcome: retired.outcome,
          note: `it could not be removed (${shortError(removeError)}); ${retired.note}`,
        };
      }
    }
    let rotated: string;
    try {
      const secret = await magpie.rotateKey(id);
      registerSecret(secret);
      rotated = "it was rotated, so the secret it was created with no longer works";
    } catch (rotateError) {
      return {
        outcome: "failed",
        note:
          `the key could not be rotated either (${shortError(rotateError)}); ` +
          `a key named ${name} may still exist in Magpie and must be deleted by hand`,
      };
    }
    const clamp = await this.clampCap(magpie, id, models);
    return {
      outcome: clamp.ok ? "clamped" : "failed",
      note: `${rotated} and ${clamp.note}`,
    };
  }

  /**
   * Pushes a key's cost limit to `$0.0001`. That is **not** a stop: Magpie still
   * serves requests until about that much has been spent. It is only the smallest
   * bound Magpie accepts, and the note says so.
   */
  private async clampCap(
    magpie: Magpie,
    id: string,
    models: string[] | null,
  ): Promise<{ ok: boolean; note: string }> {
    if (models && models.length > 0) {
      try {
        await magpie.setModels(id, models);
      } catch {
        // The cap is what bounds the money; the model list is secondary here.
      }
    }
    try {
      await magpie.setCostLimit(id, LIMIT_WINDOW, Number(MIN_CAP_MICRO) / 1_000_000);
      return {
        ok: true,
        note: "its cost limit was set to $0.0001 (Magpie can still serve roughly that much)",
      };
    } catch (error) {
      return {
        ok: false,
        note: `its cost limit could not be lowered to $0.0001 (${shortError(error)}), so it may still be unrestricted`,
      };
    }
  }

  /**
   * Finds Gateway Keys this plugin owns but no consumer row backs, and clamps
   * `omai-` keys that have no cost limit at all.
   *
   * The only names this plugin may own are `gatewayKeyName(address)` for the
   * addresses in `consumers`. Anything else with the `omai-` prefix is the debris
   * of an interrupted `ensureKey` (a key created by `gateway-key add` and never
   * narrowed), and nothing else in the system would ever look for it.
   * Keys the user created themselves are never touched: only this plugin uses the
   * `omai-` prefix.
   */
  async sweepOrphanKeys(): Promise<SweepSummary> {
    let magpie: Magpie;
    let keys: KeyRecord[];
    let legal: Set<string>;
    try {
      magpie = this.magpie();
      keys = magpie.keys();
      // Only a consumer we actually hand a key to protects that key name. A
      // revoked consumer, or one whose key was removed because D reached zero,
      // must not shield a same-named key that reappears (an interrupted
      // re-approval, or a hand-made leftover): that key is an orphan.
      const rows = this.db
        .query("SELECT address FROM consumers WHERE key_secret IS NOT NULL ORDER BY address")
        .all() as { address: string }[];
      legal = new Set(rows.map((row) => gatewayKeyName(row.address)));
    } catch (error) {
      return { checked: 0, removed: 0, clamped: 0, failed: 0, detail: shortError(error) };
    }

    let checked = 0;
    let removed = 0;
    let clamped = 0;
    let failed = 0;
    const notes: string[] = [];

    for (const key of keys) {
      const name = typeof key.name === "string" ? key.name : "";
      if (!/^omai-/i.test(name)) continue; // the user's own key
      checked += 1;

      if (legal.has(name)) {
        // A legal name without a cost limit means the setup died between
        // `gateway-key add` and `limit`; it must not stay unrestricted.
        if (typeof key.limit?.cost !== "number") {
          const clamp = await this.clampCap(magpie, key.id, null);
          if (clamp.ok) {
            clamped += 1;
            notes.push(`${name}: had no cost limit, ${clamp.note}`);
          } else {
            failed += 1;
            notes.push(`${name}: ${clamp.note}`);
          }
        }
        continue;
      }

      try {
        await magpie.removeKey(key.id);
        removed += 1;
        notes.push(`${name}: no consumer holds this key, removed`);
      } catch (removeError) {
        logger.warn(`sweep: ${name} could not be removed (${shortError(removeError)})`);
        const retired = await this.retireKey(magpie, key.id, name, null, false);
        if (retired.outcome === "clamped") clamped += 1;
        else failed += 1;
        notes.push(`${name}: ${retired.note}`);
      }
    }

    return {
      checked,
      removed,
      clamped,
      failed,
      ...(notes.length > 0 ? { detail: notes.slice(0, 4).join("; ") } : {}),
    };
  }

  private writeRequest(address: string, models: string[], ts: string, state: string): void {
    this.db.run(
      "INSERT INTO requests(address, models, ts, state) VALUES(?,?,?,?) " +
        "ON CONFLICT(address) DO UPDATE SET models = excluded.models, ts = excluded.ts, state = excluded.state",
      [address, modelsJson(models), ts, state],
    );
  }

  private writeConsumer(row: {
    address: string;
    granted: string[];
    requested: string[];
    keyName: string | null;
    keySecret: string | null;
    state: ConsumerState;
    createdAt: string;
    revokedAt: string | null;
  }): void {
    this.db.run(
      "INSERT INTO consumers(address, granted_models, requested_models, key_name, key_secret, state, created_at, revoked_at) " +
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET " +
        "granted_models = excluded.granted_models, requested_models = excluded.requested_models, " +
        "key_name = excluded.key_name, key_secret = excluded.key_secret, state = excluded.state, " +
        "revoked_at = excluded.revoked_at",
      [
        row.address,
        modelsJson(row.granted),
        modelsJson(row.requested),
        row.keyName,
        row.keySecret,
        row.state,
        row.createdAt,
        row.revokedAt,
      ],
    );
  }
}

/** A fresh, unguessable Gateway Key secret owned by this plugin. */
export function newKeySecret(): string {
  return `sk-omai-${randomBytes(24).toString("hex")}`;
}
