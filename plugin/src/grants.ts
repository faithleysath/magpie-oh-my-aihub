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
// unlimited). With no deposits — the whole of stage 3 — approval is recorded as
// `waiting-deposit` and the poll answers `approved` with `key: null`.
//
// The secret is stored here because it has to be handed to the consumer. It is
// never logged, never part of `status`, and only ever leaves through the
// provider→consumer poll response.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { Magpie } from "./magpie.ts";
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
import { logger } from "./log.ts";
import { listNativeModels } from "./tools/native-models.ts";

export type ConsumerState = "pending" | "waiting-deposit" | "active" | "revoked";
export type PollState = "none" | "pending" | "approved" | "revoked";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const MODEL_LIMIT = 200;
const MODEL_ID_LIMIT = 200;

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

    if (cap < MIN_CAP_MICRO) {
      return { address: target, grantedModels: granted, state: "waiting-deposit", keyIssued: false };
    }

    try {
      const key = await this.ensureKey(target, granted, cap);
      this.writeConsumer({
        address: target,
        granted,
        requested: [],
        keyName: key.name,
        keySecret: key.secret,
        state: "active",
        createdAt: keep.created,
        revokedAt: null,
      });
      return { address: target, grantedModels: granted, state: "active", keyIssued: true };
    } catch (error) {
      logger.error(`approve ${target}: the Gateway Key could not be issued: ${shortError(error)}`);
      throw new Error(
        `E_MAGPIE: ${target} is approved, but the Gateway Key could not be issued (${shortError(error)}); ` +
          `the approval is recorded as waiting-deposit — approve again to retry`,
      );
    }
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
   * Reuses the stored secret so a re-approve keeps the credential the consumer
   * already has.
   */
  private async ensureKey(address: string, models: string[], cap: bigint): Promise<{ name: string; secret: string }> {
    const magpie = this.magpie();
    const name = gatewayKeyName(address);
    const stored = this.consumer(address)?.key_secret ?? undefined;
    let record = magpie.keyByName(name);
    // The secret is ours: it is generated here, stored in `consumers`, and handed
    // to this one address through the poll response. Magpie only stores it.
    if (!record) record = await magpie.addKey(name, stored ?? newKeySecret());
    if (!record.secret) throw new Error("Magpie returned a key without a secret");
    await magpie.setModels(record.id, models);
    await magpie.setCostLimit(record.id, "3650d", Number(cap) / 1_000_000);
    return { name, secret: record.secret };
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
