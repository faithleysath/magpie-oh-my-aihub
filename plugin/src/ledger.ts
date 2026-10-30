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
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { magpieDataDir, statePath } from "./paths.ts";
import { costNanos, parsePriceSnapshot, type PriceSnapshot, type UsageTokens } from "./pricing.ts";

export type AccountStatus = "active" | "paused" | "revoked";
export type WindowStatus = "open" | "draining" | "closed";
export type DepositStatus = "intent" | "applied" | "failed";

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
}

export interface LedgerDeposit {
  id: string;
  consumerId: string;
  amountNanos: number;
  source: string;
  status: DepositStatus;
  windowId: string | null;
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

export interface ImportResult {
  imported: number;
  skipped: number;
  unpriced: number;
  lastOffset: number;
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
}

interface DepositRow {
  id: string;
  consumer_id: string;
  amount_nanos: number;
  source: string;
  status: DepositStatus;
  window_id: string | null;
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
  close_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_window
  ON windows(consumer_id) WHERE status IN ('open', 'draining');
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL,
  amount_nanos INTEGER NOT NULL CHECK (amount_nanos > 0),
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  window_id TEXT,
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
  };
}

function mapDeposit(r: DepositRow): LedgerDeposit {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    amountNanos: r.amount_nanos,
    source: r.source,
    status: r.status,
    windowId: r.window_id,
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
            "INSERT INTO deposits(id,consumer_id,amount_nanos,source,status,window_id,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            `opening:${input.consumerId}`,
            input.consumerId,
            input.openingNanos,
            "opening",
            "applied",
            window.id,
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
  depositIntent(input: { id: string; consumerId: string; amountNanos: number; source: string; at?: string }): { deposit: LedgerDeposit; created: boolean } {
    if (!Number.isInteger(input.amountNanos) || input.amountNanos <= 0) throw new Error("a deposit must be a positive integer amount");
    return this.tx(() => {
      const existing = this.deposit(input.id);
      if (existing) {
        if (existing.consumerId !== input.consumerId || existing.amountNanos !== input.amountNanos) {
          throw new Error(
            `deposit ${input.id} already exists for ${existing.consumerId} at ${existing.amountNanos} nanos; it cannot be replayed with another amount`,
          );
        }
        return { deposit: existing, created: false };
      }
      const at = input.at ?? nowIso();
      this.db
        .query(
          "INSERT INTO deposits(id,consumer_id,amount_nanos,source,status,window_id,cap_after_nanos,created_at,applied_at,error) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(input.id, input.consumerId, input.amountNanos, input.source, "intent", null, null, at, null, null);
      this.event(input.consumerId, "deposit-intent", { depositId: input.id, amountNanos: input.amountNanos, source: input.source });
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
        .query("UPDATE deposits SET status='applied',window_id=?,cap_after_nanos=?,applied_at=?,error=NULL WHERE id=?")
        .run(windowId, capNanos, nowIso(), id);
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

  depositsFor(consumerId: string): LedgerDeposit[] {
    const rows = this.db.query("SELECT * FROM deposits WHERE consumer_id=? ORDER BY created_at").all(consumerId) as DepositRow[];
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

  /** Marks bytes up to `offset` as already accounted for a key (migration). */
  setUsageOffset(keyId: string, offset: number): void {
    this.db
      .query("INSERT INTO usage_offsets(key_id,offset,updated_at) VALUES(?,?,?) ON CONFLICT(key_id) DO UPDATE SET offset=excluded.offset,updated_at=excluded.updated_at")
      .run(keyId, Math.max(0, Math.trunc(offset) || 0), nowIso());
  }

  usageOffset(keyId: string): number {
    const row = this.db.query("SELECT offset FROM usage_offsets WHERE key_id=?").get(keyId) as { offset: number } | null;
    return row?.offset ?? 0;
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

  /**
   * Imports Magpie's own usage rows for one key/window, exactly once. The byte
   * offset is advanced in the same transaction as the rows, so a crash either
   * imports a row or leaves it for the next attempt; the consumption primary
   * key is the second guard.
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
    const offsetRow = this.db.query("SELECT offset FROM usage_offsets WHERE key_id=?").get(input.window.keyId) as { offset: number } | null;
    let offset = input.fromOffset ?? offsetRow?.offset ?? 0;
    if (!existsSync(path)) return { imported: 0, skipped: 0, unpriced: 0, lastOffset: offset };
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size === offset) return { imported: 0, skipped: 0, unpriced: 0, lastOffset: offset };
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
    const rows: { line: string; end: number }[] = [];
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(10, pos);
      if (nl < 0) break; // a partial last line stays for the next read
      rows.push({ line: chunk.subarray(pos, nl).toString("utf8"), end: nl + 1 });
      pos = nl + 1;
    }
    if (rows.length === 0) return { imported: 0, skipped: 0, unpriced: 0, lastOffset: offset };

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
        const id = usageId(input.window.keyId, r);
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
            "usage.jsonl",
            at,
          );
        if (result.changes > 0) imported += 1;
      }
      const next = offset + pos;
      this.db
        .query("INSERT INTO usage_offsets(key_id,offset,updated_at) VALUES(?,?,?) ON CONFLICT(key_id) DO UPDATE SET offset=excluded.offset,updated_at=excluded.updated_at")
        .run(input.window.keyId, next, at);
    });
    return { imported, skipped, unpriced, lastOffset: offset + pos };
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

function usageId(keyId: string, r: UsageRecord): string {
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
