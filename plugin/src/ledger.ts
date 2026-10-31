// The plugin's prepaid ledger: a small, local SQLite database.
//
// Why SQLite and not another JSON file: a deposit, its Gateway Key cap write
// and its local commit are three steps that can be interrupted independently.
// The ledger needs a unique deposit id, a unique consumption id, integer money,
// and a transaction that survives a kill between any two steps. The existing
// state.json writer is atomic per file but cannot express those constraints.
// Bun ships SQLite, so this adds no dependency and no server process.
//
// Money is stored in nano-USD (1e-9 USD) as INTEGER. Magpie's own cost cap is
// on a $0.0001 grid; a cap is always rounded DOWN to that grid so the plugin
// never grants a fraction more credit than the ledger holds. Dust below one
// grid unit stays in the ledger and is never silently discarded.
//
// The ledger is not a second token meter and not a second AI gateway. Usage
// rows are Magpie's own usage.jsonl records; a row is priced once, at the
// immutable price snapshot of the window it belongs to, and never repriced.

import { Database } from "bun:sqlite";
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { magpieDataDir, statePath } from "./paths.ts";
import { costNanos, parsePriceSnapshot, type PriceSnapshot, type UsageTokens } from "./pricing.ts";
import { assertCreditSourceNotMainnet } from "./mainnet-gate.ts";

export type AccountStatus = "active" | "paused" | "revoked";
export type WindowStatus = "open" | "draining" | "closed";
export type DepositStatus = "intent" | "applied" | "failed";

/**
 * The provenance of a deposit. This is not a display label: it decides whether a
 * row may back a chain retry, a local top-up or an account opening. Legacy rows
 * are classified from their existing source without rewriting it.
 */
export type FundsClass = "chain" | "manual" | "simulated" | "opening";

/** Classify the historical/current source text; null means unclassified. */
export function classifyDepositSource(source: unknown): FundsClass | null {
  if (typeof source !== "string") return null;
  if (classifyChainSource(source) !== null) return "chain";
  if (source === "opening") return "opening";
  if (source === "manual") return "manual";
  if (source === "simulated") return "simulated";
  return null;
}

/** The chain id encoded by an exact `chain:<id>` source, or null. */
export function classifyChainSource(source: unknown): number | null {
  if (typeof source !== "string") return null;
  const match = /^chain:(\d+)$/.exec(source);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface LedgerAccount {
  consumerId: string;
  status: AccountStatus;
  keyId: string | null;
  keyName: string | null;
  windowId: string | null;
  priceVersion: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerWindow {
  id: string;
  consumerId: string;
  keyId: string;
  keyName: string;
  priceVersion: string;
  priceBody: string;
  windowSpec: string;
  startAt: string;
  resetAt: string;
  capNanos: number;
  status: WindowStatus;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  /** true only when nothing can still bill against this window */
  settled: boolean;
  settledAt: string | null;
  settleReason: string | null;
}

export interface LedgerDeposit {
  id: string;
  consumerId: string;
  amountNanos: number;
  source: string;
  fundsClass: FundsClass;
  /** chain id for chain-derived rows; null otherwise */
  chainId: number | null;
  /** registry asset id for chain-derived rows when known; null for legacy rows */
  assetId: string | null;
  status: DepositStatus;
  windowId: string | null;
  priceVersion: string | null;
  capAfterNanos: number | null;
  createdAt: string;
  appliedAt: string | null;
  error: string | null;
}

export interface LedgerBalance {
  depositedNanos: number;
  consumedNanos: number;
  balanceNanos: number;
  overdraftNanos: number;
  availableNanos: number;
}

export interface ConsumptionHistoryRow {
  id: string; kind: string; amountNanos: number; amountUsd: number; model: string;
  recordedAt: string; priceVersion: string; windowId: string; priceVerified: boolean;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
}
export class LedgerHistoryCursorError extends Error {
  constructor() { super("消费记录分页已失效或无效，请重新打开第一页"); }
}

export interface ImportResult {
  imported: number;
  skipped: number;
  unpriced: number;
  lastOffset: number;
  /**
   * The log no longer contains what the cursor had already passed (truncated,
   * replaced or rotated). Charges may be missing; the caller must treat the
   * window as uncertain instead of assuming the missing rows cost nothing.
   */
  gap: string | null;
}

interface AccountRow {
  consumer_id: string;
  status: AccountStatus;
  key_id: string | null;
  key_name: string | null;
  window_id: string | null;
  price_version: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

interface WindowRow {
  id: string;
  consumer_id: string;
  key_id: string;
  key_name: string;
  price_version: string;
  price_body: string;
  window_spec: string;
  start_at: string;
  reset_at: string;
  cap_nanos: number;
  status: WindowStatus;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  settled: number;
  settled_at: string | null;
  settle_reason: string | null;
}

interface DepositRow {
  id: string;
  consumer_id: string;
  amount_nanos: number;
  source: string;
  funds_class: string | null;
  chain_id: number | null;
  asset_id: string | null;
  status: DepositStatus;
  window_id: string | null;
  price_version: string | null;
  cap_after_nanos: number | null;
  created_at: string;
  applied_at: string | null;
  error: string | null;
}

interface UsageRecord {
  t?: string;
  route_id?: number;
  callerKeyId?: string;
  provider?: string;
  model?: string;
  req?: string;
  in?: number;
  out?: number;
  cache_read?: number;
  cache_write?: number;
  cache_write_1h?: number;
  status?: number;
  rejected?: boolean;
  handed_on?: boolean;
  tries?: number;
  source?: string;
  computer?: string;
  ep?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  consumer_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  key_id TEXT,
  key_name TEXT,
  window_id TEXT,
  price_version TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS windows (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  price_version TEXT NOT NULL,
  price_body TEXT NOT NULL,
  window_spec TEXT NOT NULL,
  start_at TEXT NOT NULL,
  reset_at TEXT NOT NULL,
  cap_nanos INTEGER NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
  settle_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_window
  ON windows(consumer_id) WHERE status IN ('open', 'draining');
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL,
  amount_nanos INTEGER NOT NULL CHECK (amount_nanos > 0),
  source TEXT NOT NULL,
  funds_class TEXT,
  chain_id INTEGER,
  asset_id TEXT,
  status TEXT NOT NULL,
  window_id TEXT,
  price_version TEXT,
  cap_after_nanos INTEGER,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS deposits_by_consumer ON deposits(consumer_id, created_at);
CREATE TABLE IF NOT EXISTS consumption (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_nanos INTEGER NOT NULL,
  price_version TEXT NOT NULL,
  model TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL,
  price_verified INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS consumption_by_window ON consumption(window_id, recorded_at);
CREATE INDEX IF NOT EXISTS consumption_by_consumer ON consumption(consumer_id, recorded_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consumer_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_consumer ON events(consumer_id, id);
CREATE TABLE IF NOT EXISTS usage_offsets (
  key_id TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_cursors (
  log_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (log_id, key_id)
);
CREATE TABLE IF NOT EXISTS usage_gaps (
  consumer_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  PRIMARY KEY (consumer_id, log_id)
);
`;

function mapAccount(r: AccountRow): LedgerAccount {
  return {
    consumerId: r.consumer_id,
    status: r.status,
    keyId: r.key_id,
    keyName: r.key_name,
    windowId: r.window_id,
    priceVersion: r.price_version,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapWindow(r: WindowRow): LedgerWindow {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    keyId: r.key_id,
    keyName: r.key_name,
    priceVersion: r.price_version,
    priceBody: r.price_body,
    windowSpec: r.window_spec,
    startAt: r.start_at,
    resetAt: r.reset_at,
    capNanos: r.cap_nanos,
    status: r.status,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
    settled: r.settled === 1,
    settledAt: r.settled_at,
    settleReason: r.settle_reason,
  };
}

function mapDeposit(r: DepositRow): LedgerDeposit {
  const fundsClass = (r.funds_class as FundsClass | null) ?? classifyDepositSource(r.source);
  if (!fundsClass) throw new Error(`deposit ${r.id} has an unclassified source ${JSON.stringify(r.source)}; refusing to guess its funds class`);
  return {
    id: r.id,
    consumerId: r.consumer_id,
    amountNanos: r.amount_nanos,
    source: r.source,
    fundsClass,
    chainId: r.chain_id ?? (fundsClass === "chain" ? classifyChainSource(r.source) : null),
    assetId: r.asset_id ?? null,
    status: r.status,
    windowId: r.window_id,
    priceVersion: r.price_version,
    capAfterNanos: r.cap_after_nanos,
    createdAt: r.created_at,
    appliedAt: r.applied_at,
    error: r.error,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The gateway's usage log, as Magpie writes it (internal/usage/usage.go). */
export function usageLogPath(): string {
  return join(magpieDataDir(), "usage.jsonl");
}

/** Default ledger path, beside state.json and consumers.json. */
export function ledgerPath(): string {
  return statePath("ledger.sqlite");
}

export class Ledger {
  // Opaque cursors contain no readable source/key identifiers and expire with this owner.
  private readonly historyCursorKey = randomBytes(32);
  private db: Database;
  private closed = false;

  constructor(path = ledgerPath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // A database written by an earlier phase-6 build has no price_version on
    // deposits; add it rather than making the file unreadable.
    const depositColumns = this.db.query("PRAGMA table_info(deposits)").all() as { name: string }[];
    if (!depositColumns.some((c) => c.name === "price_version")) {
      this.db.exec("ALTER TABLE deposits ADD COLUMN price_version TEXT");
    }
    // Provenance columns are nullable so historical rows are read without
    // rewriting their source, chain id or amount; mapDeposit classifies them.
    if (!depositColumns.some((c) => c.name === "funds_class")) this.db.exec("ALTER TABLE deposits ADD COLUMN funds_class TEXT");
    if (!depositColumns.some((c) => c.name === "chain_id")) this.db.exec("ALTER TABLE deposits ADD COLUMN chain_id INTEGER");
    if (!depositColumns.some((c) => c.name === "asset_id")) this.db.exec("ALTER TABLE deposits ADD COLUMN asset_id TEXT");
    try {
      // SQLite creates the file with the process umask; make the 0600 intent explicit.
      chmodSync(path, 0o600);
    } catch {
      /* a filesystem without modes: the directory is still 0700 */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const out = fn();
      this.db.exec("COMMIT;");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* the transaction is already gone */
      }
      throw e;
    }
  }

  /** Every account, for recovery after a lost or truncated consumers.json. */
  accounts(): LedgerAccount[] {
    const rows = this.db.query("SELECT * FROM accounts ORDER BY created_at").all() as AccountRow[];
    return rows.map(mapAccount);
  }

  account(consumerId: string): LedgerAccount | null {
    const row = this.db.query("SELECT * FROM accounts WHERE consumer_id = ?").get(consumerId) as AccountRow | null;
    return row ? mapAccount(row) : null;
  }

  /** Creates the account and its first window, with an opening credit deposit. */
  ensureAccount(input: {
    consumerId: string;
    keyId: string;
    keyName: string;
    price: PriceSnapshot;
    windowSpec: string;
    startAt: string;
    resetAt: string;
    openingNanos: number;
    capNanos: number;
  }): LedgerWindow {
    return this.tx(() => {
      const existing = this.account(input.consumerId);
      if (existing) {
        const open = this.openWindowFor(input.consumerId);
        if (!open) throw new Error(`ledger account ${input.consumerId} exists without an open window`);
        return open;
      }
      const at = nowIso();
      this.db
        .query(
          "INSERT INTO accounts(consumer_id,status,key_id,key_name,window_id,price_version,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(input.consumerId, "active", input.keyId, input.keyName, null, input.price.version, null, at, at);
      const window = this.insertWindow({
        consumerId: input.consumerId,
        keyId: input.keyId,
        keyName: input.keyName,
        price: input.price,
        windowSpec: input.windowSpec,
        startAt: input.startAt,
        resetAt: input.resetAt,
        capNanos: input.capNanos,
      });
      if (input.openingNanos > 0) {
        this.db
          .query(
            "INSERT INTO deposits(id,consumer_id,amount_nanos,source,funds_class,chain_id,asset_id,status,window_id,price_version,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            `opening:${input.consumerId}`,
            input.consumerId,
            input.openingNanos,
            "opening",
            "opening",
            null,
            null,
            "applied",
            window.id,
            input.price.version,
            input.capNanos,
            at,
            at,
            null,
          );
      }
      this.event(input.consumerId, "account-opened", {
        windowId: window.id,
        keyId: input.keyId,
        priceVersion: input.price.version,
        openingNanos: input.openingNanos,
      });
      return window;
    });
  }

  /** Opens a new window for an existing account; the secret/key are the caller's. */
  openWindow(input: {
    consumerId: string;
    keyId: string;
    keyName: string;
    price: PriceSnapshot;
    windowSpec: string;
    startAt: string;
    resetAt: string;
    capNanos: number;
  }): LedgerWindow {
    return this.tx(() => {
      const open = this.openWindowFor(input.consumerId);
      if (open) throw new Error(`ledger account ${input.consumerId} already has an open window`);
      const w = this.insertWindow(input);
      this.db
        .query("UPDATE accounts SET status='active',key_id=?,key_name=?,window_id=?,price_version=?,reason=NULL,updated_at=? WHERE consumer_id=?")
        .run(input.keyId, input.keyName, w.id, input.price.version, nowIso(), input.consumerId);
      this.event(input.consumerId, "window-opened", {
        windowId: w.id,
        keyId: input.keyId,
        priceVersion: input.price.version,
        capNanos: input.capNanos,
      });
      return w;
    });
  }

  private insertWindow(input: {
    consumerId: string;
    keyId: string;
    keyName: string;
    price: PriceSnapshot;
    windowSpec: string;
    startAt: string;
    resetAt: string;
    capNanos: number;
  }): LedgerWindow {
    const id = randomUUID();
    const at = nowIso();
    this.db
      .query(
        "INSERT INTO windows(id,consumer_id,key_id,key_name,price_version,price_body,window_spec,start_at,reset_at,cap_nanos,status,opened_at,closed_at,close_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.consumerId,
        input.keyId,
        input.keyName,
        input.price.version,
        input.price.body,
        input.windowSpec,
        input.startAt,
        input.resetAt,
        input.capNanos,
        "open",
        at,
        null,
        null,
      );
    this.db
      .query("UPDATE accounts SET status='active',window_id=?,price_version=?,reason=NULL,updated_at=? WHERE consumer_id=?")
      .run(id, input.price.version, at, input.consumerId);
    return this.window(id)!;
  }

  window(id: string): LedgerWindow | null {
    const row = this.db.query("SELECT * FROM windows WHERE id = ?").get(id) as WindowRow | null;
    return row ? mapWindow(row) : null;
  }

  openWindowFor(consumerId: string): LedgerWindow | null {
    const row = this.db
      .query("SELECT * FROM windows WHERE consumer_id = ? AND status IN ('open','draining') ORDER BY opened_at DESC LIMIT 1")
      .get(consumerId) as WindowRow | null;
    return row ? mapWindow(row) : null;
  }

  markWindowDraining(windowId: string): void {
    this.db.query("UPDATE windows SET status='draining' WHERE id=? AND status='open'").run(windowId);
  }

  closeWindow(windowId: string, reason: string, status: WindowStatus = "closed"): void {
    this.db
      .query("UPDATE windows SET status=?,closed_at=?,close_reason=? WHERE id=?")
      .run(status, nowIso(), reason, windowId);
  }

  setPaused(consumerId: string, reason: string): void {
    this.db
      .query("UPDATE accounts SET status='paused',reason=?,updated_at=? WHERE consumer_id=?")
      .run(reason, nowIso(), consumerId);
  }

  setKey(consumerId: string, keyId: string, keyName: string): void {
    this.db.query("UPDATE accounts SET key_id=?,key_name=?,updated_at=? WHERE consumer_id=?").run(keyId, keyName, nowIso(), consumerId);
  }

  setActive(consumerId: string, windowId: string, priceVersion: string): void {
    this.db
      .query("UPDATE accounts SET status='active',reason=NULL,window_id=?,price_version=?,updated_at=? WHERE consumer_id=?")
      .run(windowId, priceVersion, nowIso(), consumerId);
  }

  revokeAccount(consumerId: string, reason: string): void {
    this.db.query("UPDATE accounts SET status='revoked',reason=?,updated_at=? WHERE consumer_id=?").run(reason, nowIso(), consumerId);
  }

  deposit(id: string): LedgerDeposit | null {
    const row = this.db.query("SELECT * FROM deposits WHERE id = ?").get(id) as DepositRow | null;
    return row ? mapDeposit(row) : null;
  }

  /**
   * Records the intent before Magpie is touched. Repeating the same id and
   * amount is a no-op; the same id with another amount is refused. A caller
   * must never add the credit until the cap read-back confirms it.
   */
  depositIntent(input: {
    id: string;
    consumerId: string;
    amountNanos: number;
    source: string;
    fundsClass?: FundsClass;
    chainId?: number | null;
    assetId?: string | null;
    at?: string;
  }): { deposit: LedgerDeposit; created: boolean } {
    // A second, durable mainnet gate: no future watcher/CLI bug can book a
    // `chain:56` or `chain:8453` credit even if it reaches the ledger directly.
    assertCreditSourceNotMainnet(input.source);
    if (!Number.isInteger(input.amountNanos) || input.amountNanos <= 0) throw new Error("a deposit must be a positive integer amount");
    const fundsClass = input.fundsClass ?? classifyDepositSource(input.source);
    if (!fundsClass) throw new Error(`deposit source ${JSON.stringify(input.source)} has no trusted funds class`);
    if (fundsClass === "opening") throw new Error("an opening balance is written only by the account-opening transaction");
    const sourceChainId = classifyChainSource(input.source);
    const chainId = input.chainId ?? sourceChainId;
    if (fundsClass === "chain") {
      if (chainId === null || !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("a chain deposit needs a positive chain id");
      if (input.source !== `chain:${chainId}`) throw new Error("a chain deposit source must be exactly chain:<chainId>");
    } else if (chainId !== null || input.chainId !== undefined && input.chainId !== null) {
      throw new Error(`a ${fundsClass} deposit cannot name a chain`);
    }
    if (input.assetId !== undefined && input.assetId !== null && !/^eip155:\d+:0x[0-9a-f]{40}$/.test(input.assetId)) {
      throw new Error("a deposit asset id must be eip155:<chain>:<contract>");
    }
    return this.tx(() => {
      const existing = this.deposit(input.id);
      if (existing) {
        if (existing.consumerId !== input.consumerId || existing.amountNanos !== input.amountNanos) {
          throw new Error(
            `deposit ${input.id} already exists for ${existing.consumerId} at ${existing.amountNanos} nanos; it cannot be replayed with another amount`,
          );
        }
        if (existing.fundsClass !== fundsClass || existing.chainId !== chainId) {
          throw new Error(`deposit ${input.id} is already a ${existing.fundsClass} deposit and cannot be reclassified`);
        }
        return { deposit: existing, created: false };
      }
      const at = input.at ?? nowIso();
      this.db
        .query(
          "INSERT INTO deposits(id,consumer_id,amount_nanos,source,funds_class,chain_id,asset_id,status,window_id,price_version,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(input.id, input.consumerId, input.amountNanos, input.source, fundsClass, chainId, input.assetId ?? null, "intent", null, null, null, at, null, null);
      this.event(input.consumerId, "deposit-intent", { depositId: input.id, amountNanos: input.amountNanos, source: input.source, fundsClass });
      return { deposit: this.deposit(input.id)!, created: true };
    });
  }

  markDepositApplied(id: string, windowId: string, capNanos: number): LedgerDeposit {
    return this.tx(() => {
      const d = this.deposit(id);
      if (!d) throw new Error(`no deposit ${id}`);
      if (d.status === "applied") return d;
      if (d.status === "failed") throw new Error(`deposit ${id} already failed; a new deposit id is required`);
      this.db
        .query("UPDATE deposits SET status='applied',window_id=?,price_version=(SELECT price_version FROM windows WHERE id=?),cap_after_nanos=?,applied_at=?,error=NULL WHERE id=?")
        .run(windowId, windowId, capNanos, nowIso(), id);
      this.event(d.consumerId, "deposit-applied", { depositId: id, windowId, capNanos });
      return this.deposit(id)!;
    });
  }

  markDepositFailed(id: string, error: string): void {
    this.tx(() => {
      const d = this.deposit(id);
      if (!d) throw new Error(`no deposit ${id}`);
      if (d.status === "applied") throw new Error(`deposit ${id} is already applied`);
      this.db.query("UPDATE deposits SET status='failed',error=?,applied_at=NULL WHERE id=?").run(error.slice(0, 500), id);
      this.event(d.consumerId, "deposit-failed", { depositId: id, error: error.slice(0, 500) });
    });
  }

  pendingDeposits(consumerId: string): LedgerDeposit[] {
    const rows = this.db
      .query("SELECT * FROM deposits WHERE consumer_id=? AND status='intent' ORDER BY created_at")
      .all(consumerId) as DepositRow[];
    return rows.map(mapDeposit);
  }

  depositsFor(consumerId: string, limit?: number): LedgerDeposit[] {
    const rows = limit === undefined
      ? this.db.query("SELECT * FROM deposits WHERE consumer_id=? ORDER BY created_at").all(consumerId) as DepositRow[]
      : this.db.query("SELECT * FROM deposits WHERE consumer_id=? ORDER BY created_at DESC LIMIT ?").all(consumerId, Math.max(1, Math.min(1000, Math.trunc(limit)))) as DepositRow[];
    return rows.map(mapDeposit);
  }

  /** Sum of applied credits minus every recorded consumption; negative means overdraft. */
  balance(consumerId: string): LedgerBalance {
    const dep = this.db
      .query("SELECT COALESCE(SUM(amount_nanos),0) AS n FROM deposits WHERE consumer_id=? AND status='applied'")
      .get(consumerId) as { n: number };
    const con = this.db
      .query("SELECT COALESCE(SUM(amount_nanos),0) AS n FROM consumption WHERE consumer_id=?")
      .get(consumerId) as { n: number };
    const balanceNanos = dep.n - con.n;
    return {
      depositedNanos: dep.n,
      consumedNanos: con.n,
      balanceNanos,
      overdraftNanos: Math.max(-balanceNanos, 0),
      availableNanos: Math.max(balanceNanos, 0),
    };
  }

  /** The models a window was issued for, from its frozen price document. */
  windowModels(window: LedgerWindow): string[] {
    try {
      const parsed = JSON.parse(window.priceBody) as { models?: unknown };
      return Array.isArray(parsed.models) ? parsed.models.map(String) : [];
    } catch {
      return [];
    }
  }

  windowConsumption(windowId: string): number {
    const row = this.db
      .query("SELECT COALESCE(SUM(amount_nanos),0) AS n FROM consumption WHERE window_id=?")
      .get(windowId) as { n: number };
    return row.n;
  }

  consumptionForWindow(windowId: string): {
    id: string;
    model: string;
    recordedAt: string;
    amountNanos: number;
    priceVerified: boolean;
  }[] {
    const rows = this.db
      .query("SELECT id,model,recorded_at,amount_nanos,price_verified FROM consumption WHERE window_id=? ORDER BY recorded_at")
      .all(windowId) as { id: string; model: string; recorded_at: string; amount_nanos: number; price_verified: number }[];
    return rows.map((r) => ({ id: r.id, model: r.model, recordedAt: r.recorded_at, amountNanos: r.amount_nanos, priceVerified: r.price_verified === 1 }));
  }

  /** Consumer-scoped immutable rows only: no import, reconciliation or live repricing. */
  consumptionHistory(consumerId: string, cursor?: string): { rows: ConsumptionHistoryRow[]; nextCursor: string | null } {
    let boundary: { recordedAt: string; id: string } | null = null;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const bytes = Buffer.from(cursor, "base64url");
        if (bytes.length < 29 || bytes.toString("base64url") !== cursor) throw new Error();
        const decrypt = createDecipheriv("aes-256-gcm", this.historyCursorKey, bytes.subarray(0, 12));
        decrypt.setAuthTag(bytes.subarray(12, 28));
        const value = JSON.parse(Buffer.concat([decrypt.update(bytes.subarray(28)), decrypt.final()]).toString("utf8"));
        if (value.consumerId !== consumerId || typeof value.recordedAt !== "string" || value.recordedAt.length > 128 || typeof value.id !== "string" || value.id.length > 512 || Object.keys(value).sort().join() !== "consumerId,id,recordedAt") throw new Error();
        boundary = value;
      } catch { throw new LedgerHistoryCursorError(); }
    }
    type Row = { id: string; kind: string; amount_nanos: number; model: string; recorded_at: string; price_version: string; window_id: string; price_verified: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cache_write_1h_tokens: number };
    const columns = "id,kind,amount_nanos,model,recorded_at,price_version,window_id,price_verified,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_write_1h_tokens";
    const records = (boundary
      ? this.db.query(`SELECT ${columns} FROM consumption WHERE consumer_id=? AND (recorded_at<? OR (recorded_at=? AND id<?)) ORDER BY recorded_at DESC,id DESC LIMIT 51`).all(consumerId, boundary.recordedAt, boundary.recordedAt, boundary.id)
      : this.db.query(`SELECT ${columns} FROM consumption WHERE consumer_id=? ORDER BY recorded_at DESC,id DESC LIMIT 51`).all(consumerId)) as Row[];
    const page = records.slice(0, 50);
    let nextCursor: string | null = null;
    if (records.length > 50) {
      const last = page[page.length - 1]!;
      const iv = randomBytes(12), encrypt = createCipheriv("aes-256-gcm", this.historyCursorKey, iv);
      const encrypted = Buffer.concat([encrypt.update(JSON.stringify({ consumerId, recordedAt: last.recorded_at, id: last.id }), "utf8"), encrypt.final()]);
      nextCursor = Buffer.concat([iv, encrypt.getAuthTag(), encrypted]).toString("base64url");
    }
    return { rows: page.map(r => ({ id: createHash("sha256").update(r.id).digest("hex"), kind: r.kind,
      amountNanos: r.amount_nanos, amountUsd: r.amount_nanos / 1_000_000_000, model: r.model,
      recordedAt: r.recorded_at, priceVersion: r.price_version, windowId: r.window_id, priceVerified: r.price_verified === 1,
      tokens: { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens, cacheWrite1h: r.cache_write_1h_tokens } })), nextCursor };
  }

  /**
   * Imports Magpie's own usage rows for one key/window, exactly once.
   *
   * Identity is the log line's position: `(log id, byte offset, row ordinal)`.
   * A content hash cannot tell two genuinely identical calls apart, and Magpie
   * has no unique request field in usage.jsonl (`route_id` is a per-process
   * counter that restarts near `UnixMilli`, and rejected rows carry none).
   * Two equal lines at different offsets are therefore two charges, and the
   * same line read twice is one.
   *
   * The rows and the cursor advance in one transaction. A log that no longer
   * holds the bytes the cursor had passed (truncated, replaced, rotated) is
   * reported as a `gap`: the caller must treat the window as uncertain rather
   * than as "the missing rows cost nothing".
   */
  importUsage(input: {
    consumerId: string;
    window: LedgerWindow;
    logPath?: string;
    fromOffset?: number;
    maxBytes?: number;
  }): ImportResult {
    const path = input.logPath ?? usageLogPath();
    const snapshot = parsePriceSnapshot(input.window.priceBody);
    if (!snapshot) throw new Error(`window ${input.window.id} has a corrupt price snapshot`);
    const logId = usageLogId(path);
    const cursor = this.db
      .query("SELECT offset FROM usage_cursors WHERE log_id=? AND key_id=?")
      .get(logId, input.window.keyId) as { offset: number } | null;
    let offset = input.fromOffset ?? cursor?.offset ?? 0;
    if (!existsSync(path)) {
      const missing = offset > 0 ? `${logId} is missing` : null;
      // Persist on every path: a gap discovered by an early return is just as
      // real as one found while parsing, and must survive the process.
      if (missing) this.recordGap(input.consumerId, logId, missing, nowIso());
      return { imported: 0, skipped: 0, unpriced: 0, lastOffset: offset, gap: missing };
    }
    const size = statSync(path).size;
    let gap: string | null = null;
    if (size < offset) {
      gap = `${logId} shrank from ${offset} to ${size} bytes (truncated or replaced)`;
      offset = 0;
    }
    if (size === offset) {
      if (gap) this.recordGap(input.consumerId, logId, gap, nowIso());
      return { imported: 0, skipped: 0, unpriced: 0, lastOffset: offset, gap };
    }
    const length = Math.min(size - offset, input.maxBytes ?? 8 * 1024 * 1024);
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(path, "r");
    let read = 0;
    try {
      while (read < length) {
        const n = readSync(fd, buf, read, length - read, offset + read);
        if (n <= 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    const chunk = buf.subarray(0, read);
    const rows: { line: string; at: number }[] = [];
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(10, pos);
      if (nl < 0) break; // a partial last line stays for the next read
      rows.push({ line: chunk.subarray(pos, nl).toString("utf8"), at: offset + pos });
      pos = nl + 1;
    }
    if (rows.length === 0) {
      if (gap) this.recordGap(input.consumerId, logId, gap, nowIso());
      return { imported: 0, skipped: 0, unpriced: 0, lastOffset: offset, gap };
    }

    let imported = 0;
    let skipped = 0;
    let unpriced = 0;
    const at = nowIso();
    this.tx(() => {
      for (const row of rows) {
        let r: UsageRecord;
        try {
          r = JSON.parse(row.line) as UsageRecord;
        } catch {
          skipped += 1;
          continue;
        }
        if (r.rejected === true || (r.provider === "" && (r.status ?? 0) >= 400)) continue;
        if (r.source === "reported") continue;
        if (r.computer) continue;
        if (r.callerKeyId !== input.window.keyId) continue;
        const id = usageEventId(logId, row.at, input.window.keyId);
        const model = `${r.provider ?? ""}/${r.model ?? ""}`;
        const price = snapshot.prices[model] ?? (r.req ? snapshot.prices[r.req] : undefined);
        const tokens: UsageTokens = {
          input: numberOrZero(r.in),
          output: numberOrZero(r.out),
          cacheRead: numberOrZero(r.cache_read),
          cacheWrite: numberOrZero(r.cache_write),
          cacheWrite1h: numberOrZero(r.cache_write_1h),
        };
        const amountNanos = price ? costNanos(price, tokens) : 0;
        if (!price) unpriced += 1;
        const result = this.db
          .query(
            "INSERT OR IGNORE INTO consumption(id,consumer_id,window_id,key_id,kind,amount_nanos,price_version,model,recorded_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_write_1h_tokens,price_verified,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.consumerId,
            input.window.id,
            input.window.keyId,
            "call",
            amountNanos,
            input.window.priceVersion,
            model,
            r.t ?? at,
            tokens.input,
            tokens.output,
            tokens.cacheRead,
            tokens.cacheWrite,
            tokens.cacheWrite1h ?? 0,
            price ? 1 : 0,
            `usage.jsonl@${logId}:${row.at}`,
            at,
          );
        if (result.changes > 0) imported += 1;
      }
      this.advanceCursor(logId, input.window.keyId, offset + pos, at);
      if (gap) this.recordGap(input.consumerId, logId, gap, at);
    });
    if (skipped > 0 && !gap) {
      // A complete line that is not valid JSON. Its tokens cannot be read, so
      // its cost cannot be proven; the window is uncertain, never "zero cost".
      gap = `${skipped} complete line(s) in ${logId} could not be parsed, so their cost cannot be proven`;
      this.recordGap(input.consumerId, logId, gap, at);
    }
    return { imported, skipped, unpriced, lastOffset: offset + pos, gap };
  }

  /**
   * Records that charges may be missing. A gap is never cleared by the log
   * coming back or by reading more rows: only `resolveGap()` with an operator's
   * note does, and the note is kept.
   */
  private recordGap(consumerId: string, logId: string, reason: string, at: string): void {
    this.db
      .query(
        `INSERT INTO usage_gaps(consumer_id,log_id,reason,first_seen_at,last_seen_at,occurrences,resolved_at,resolved_by,resolution_note)
         VALUES(?,?,?,?,?,1,NULL,NULL,NULL)
         ON CONFLICT(consumer_id,log_id) DO UPDATE SET
           reason=excluded.reason,
           last_seen_at=excluded.last_seen_at,
           occurrences=usage_gaps.occurrences+1,
           resolved_at=NULL,
           resolved_by=NULL,
           resolution_note=NULL`,
      )
      .run(consumerId, logId, reason.slice(0, 500), at, at);
  }

  /** Every gap that has not been resolved by an audited action. */
  openGaps(consumerId: string): { logId: string; reason: string; firstSeenAt: string; lastSeenAt: string; occurrences: number }[] {
    const rows = this.db
      .query("SELECT * FROM usage_gaps WHERE consumer_id=? AND resolved_at IS NULL ORDER BY first_seen_at")
      .all(consumerId) as {
      log_id: string;
      reason: string;
      first_seen_at: string;
      last_seen_at: string;
      occurrences: number;
    }[];
    return rows.map((r) => ({
      logId: r.log_id,
      reason: r.reason,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      occurrences: r.occurrences,
    }));
  }

  /** All gaps, resolved ones included, for the status view. */
  gaps(consumerId: string): { logId: string; reason: string; resolvedAt: string | null; note: string | null }[] {
    const rows = this.db
      .query("SELECT * FROM usage_gaps WHERE consumer_id=? ORDER BY first_seen_at")
      .all(consumerId) as {
      log_id: string;
      reason: string;
      resolved_at: string | null;
      resolution_note: string | null;
    }[];
    return rows.map((r) => ({ logId: r.log_id, reason: r.reason, resolvedAt: r.resolved_at, note: r.resolution_note }));
  }

  /**
   * The only way out of a gap. It records who resolved it and why; the missing
   * charges are NOT reconstructed, so the operator must account for them out of
   * band before reissuing. This phase implements the marker, not compensation.
   */
  resolveGap(input: {
    consumerId: string;
    logId: string;
    resolvedBy: string;
    note: string;
    /** the byte offset the operator accepts as fully accounted for */
    acceptedOffset: number;
    at?: string;
  }): void {
    const at = input.at ?? nowIso();
    const offset = Math.max(0, Math.trunc(input.acceptedOffset) || 0);
    this.tx(() => {
      const result = this.db
        .query("UPDATE usage_gaps SET resolved_at=?,resolved_by=?,resolution_note=? WHERE consumer_id=? AND log_id=? AND resolved_at IS NULL")
        .run(at, input.resolvedBy.slice(0, 120), input.note.slice(0, 500), input.consumerId, input.logId);
      if (result.changes === 0) throw new Error(`no open usage gap for ${input.consumerId} on ${input.logId}`);
      // The operator has stated that everything up to `acceptedOffset` is
      // accounted for (typically written off). Without moving the cursor, the
      // next read would rediscover the same truncation and the resolution
      // would be meaningless. Both the old and the accepted position are kept.
      const keys = this.db.query("SELECT DISTINCT key_id FROM windows WHERE consumer_id=?").all(input.consumerId) as {
        key_id: string;
      }[];
      for (const k of keys) {
        const previous = this.cursorFor2(input.logId, k.key_id);
        this.advanceCursor(input.logId, k.key_id, offset, at);
        this.event(input.consumerId, "usage-gap-baseline", {
          logId: input.logId,
          keyId: k.key_id,
          previousOffset: previous,
          acceptedOffset: offset,
        });
      }
      this.event(input.consumerId, "usage-gap-resolved", {
        logId: input.logId,
        resolvedBy: input.resolvedBy.slice(0, 120),
        note: input.note.slice(0, 500),
        acceptedOffset: offset,
      });
    });
  }

  /** A cursor by log id rather than path, for callers that already have it. */
  private cursorFor2(logId: string, keyId: string): number {
    const row = this.db.query("SELECT offset FROM usage_cursors WHERE log_id=? AND key_id=?").get(logId, keyId) as {
      offset: number;
    } | null;
    return row?.offset ?? 0;
  }

  private advanceCursor(logId: string, keyId: string, offset: number, at: string): void {
    this.db
      .query(
        "INSERT INTO usage_cursors(log_id,key_id,offset,updated_at) VALUES(?,?,?,?) ON CONFLICT(log_id,key_id) DO UPDATE SET offset=excluded.offset,updated_at=excluded.updated_at",
      )
      .run(logId, keyId, offset, at);
  }

  /** Where this key's read of a log stands, for a migration that must not replay it. */
  cursorFor(logPath: string, keyId: string): number {
    const row = this.db
      .query("SELECT offset FROM usage_cursors WHERE log_id=? AND key_id=?")
      .get(usageLogId(logPath), keyId) as { offset: number } | null;
    return row?.offset ?? 0;
  }

  /** Marks a key's read of a log as already complete up to `offset`. */
  seedCursor(logPath: string, keyId: string, offset: number): void {
    this.advanceCursor(usageLogId(logPath), keyId, Math.max(0, Math.trunc(offset) || 0), nowIso());
  }

  /**
   * A window that can still be billed against: open, draining, or closed but
   * not proven settled. Late rows are imported for these at every check.
   */
  unsettledWindows(consumerId?: string): LedgerWindow[] {
    const rows = consumerId
      ? (this.db
          .query("SELECT * FROM windows WHERE consumer_id=? AND settled=0 ORDER BY opened_at")
          .all(consumerId) as WindowRow[])
      : (this.db.query("SELECT * FROM windows WHERE settled=0 ORDER BY opened_at").all() as WindowRow[]);
    return rows.map(mapWindow);
  }

  /**
   * Windows to re-read for late rows: every unsettled one, plus any closed
   * within `horizonMs`.
   *
   * "Settled" is a claim about the evidence available at that moment (nothing
   * in flight, nothing unread). A request can end between that check and the
   * next read and still be written afterwards, so the scan cannot stop at the
   * settlement flag alone; it keeps auditing recent windows and reopens one
   * that turns out to have a late row.
   */
  windowsToScan(consumerId: string, horizonMs: number): LedgerWindow[] {
    const since = new Date(Date.now() - Math.max(0, horizonMs)).toISOString();
    const rows = this.db
      .query(
        "SELECT * FROM windows WHERE consumer_id=? AND (settled=0 OR closed_at IS NULL OR closed_at >= ?) ORDER BY opened_at",
      )
      .all(consumerId, since) as WindowRow[];
    return rows.map(mapWindow);
  }

  /** A late row reached a window that had been called settled. */
  reopenWindow(windowId: string, reason: string): void {
    this.db
      .query("UPDATE windows SET settled=0,settled_at=NULL,settle_reason=NULL WHERE id=?")
      .run(windowId);
    const row = this.db.query("SELECT consumer_id FROM windows WHERE id=?").get(windowId) as { consumer_id: string } | null;
    if (row) this.event(row.consumer_id, "window-reopened", { windowId, reason: reason.slice(0, 300) });
  }

  windowsFor(consumerId: string): LedgerWindow[] {
    const rows = this.db.query("SELECT * FROM windows WHERE consumer_id=? ORDER BY opened_at").all(consumerId) as WindowRow[];
    return rows.map(mapWindow);
  }

  /**
   * Records that a window is fully settled. Only a caller that has proven no
   * request can still bill against it may do this; "we waited N seconds" is not
   * such a proof.
   */
  markWindowSettled(windowId: string, reason: string): void {
    this.db
      .query("UPDATE windows SET settled=1,settled_at=?,settle_reason=? WHERE id=?")
      .run(nowIso(), reason.slice(0, 300), windowId);
  }

  windowSettlement(windowId: string): { settled: boolean; reason: string | null; at: string | null } {
    const row = this.db.query("SELECT settled,settle_reason,settled_at FROM windows WHERE id=?").get(windowId) as
      | { settled: number; settle_reason: string | null; settled_at: string | null }
      | null;
    return { settled: row?.settled === 1, reason: row?.settle_reason ?? null, at: row?.settled_at ?? null };
  }

  /** A migration/repair adjustment, still immutable and auditable. */
  recordAdjustment(input: { id: string; consumerId: string; windowId: string; keyId: string; amountNanos: number; reason: string }): void {
    if (!Number.isInteger(input.amountNanos) || input.amountNanos < 0) throw new Error("an adjustment must be a non-negative integer");
    const at = nowIso();
    this.tx(() => {
      this.db
        .query(
          "INSERT OR IGNORE INTO consumption(id,consumer_id,window_id,key_id,kind,amount_nanos,price_version,model,recorded_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_write_1h_tokens,price_verified,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.consumerId,
          input.windowId,
          input.keyId,
          "adjustment",
          input.amountNanos,
          "migration",
          input.reason,
          at,
          0,
          0,
          0,
          0,
          0,
          1,
          "migration",
          at,
        );
      this.event(input.consumerId, "adjustment", { id: input.id, amountNanos: input.amountNanos, reason: input.reason });
    });
  }

  event(consumerId: string, kind: string, detail: unknown): void {
    this.db.query("INSERT INTO events(consumer_id,at,kind,detail) VALUES(?,?,?,?)").run(consumerId, nowIso(), kind, JSON.stringify(detail));
  }

  events(consumerId: string, limit = 100): { at: string; kind: string; detail: string }[] {
    return this.db
      .query("SELECT at,kind,detail FROM events WHERE consumer_id=? ORDER BY id DESC LIMIT ?")
      .all(consumerId, limit) as { at: string; kind: string; detail: string }[];
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * A stable name for one log file, so cursors and event ids follow the file
 * rather than the process. Magpie keeps one `usage.jsonl`; a test or an
 * operator may point at another, and the path is what tells them apart.
 */
export function usageLogId(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 32);
}

/**
 * One consumption event: this log file, this byte offset, this key.
 *
 * Not a content hash. Magpie's usage rows have no unique id (`route_id` is a
 * per-process counter seeded from `UnixMilli` and absent on rejected rows), so
 * two identical calls would collide under a content hash while the same line
 * read twice would not. The byte offset is unique per row by construction and
 * survives a restart; the log id keeps a replaced file from colliding.
 */
export function usageEventId(logId: string, offset: number, keyId: string): string {
  return createHash("sha256").update(`${logId}\u0000${offset}\u0000${keyId}`).digest("hex");
}

function legacyUsageId(keyId: string, r: UsageRecord): string {
  const caller = r.callerKeyId ?? "";
  const stable = [
    keyId,
    caller,
    String(r.route_id ?? ""),
    r.t ?? "",
    r.provider ?? "",
    r.model ?? "",
    r.req ?? "",
    String(r.in ?? 0),
    String(r.out ?? 0),
    String(r.cache_read ?? 0),
    String(r.cache_write ?? 0),
    String(r.cache_write_1h ?? 0),
    String(r.status ?? 0),
    r.handed_on ? "1" : "0",
    String(r.tries ?? 0),
    r.ep ?? "",
  ].join("\u0000");
  return createHash("sha256").update(stable).digest("hex");
}
