// The plugin's SQLite ledger (DESIGN-V2 §9).
//
// One file, `<stateDir>/ledger.sqlite`, opened once per plugin host. WAL keeps
// the read side (`GET /request`) from blocking an approval; the file and its
// sidecars are 0600 because `consumers.key_secret` is a bearer credential.
//
// Stage 3 writes only `requests` and `consumers`. `deposits` and `payouts` are
// created here so stage 4 can credit without a migration, and `balanceMicro`
// already reads credited deposits, so a single inserted row is enough to
// exercise the key-issuance path.
//
// Money is held as integer micro-USD (1e-6 USD) in this module. That is the
// finest unit the product needs: balances arrive as USDC raw (18 decimals on
// BSC, 6 on Base) and are floored once, and Magpie's cost limit is a $0.0001
// grid (`capMicroOf` floors again to 100 micro).

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./log.ts";
import { statePath } from "./paths.ts";

export const LEDGER_FILE = "ledger.sqlite";

/** 1 USD = 1e6 micro; Magpie's limit grid is 1e-4 USD = 100 micro. */
export const MICRO_PER_USD = 1_000_000n;
export const CAP_STEP_MICRO = 100n;
/** Below this a cost limit would mean "unlimited" to Magpie, so no key is issued. */
export const MIN_CAP_MICRO = CAP_STEP_MICRO;

/** USDC decimals per chain id. A row from any other chain is not credited. */
const CHAIN_DECIMALS: Record<number, number> = {
  56: 18, // BSC USDC
  8453: 6, // Base USDC
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  chain_id INTEGER,
  token TEXT,
  from_addr TEXT,
  to_addr TEXT,
  amount_raw TEXT,
  block_number INTEGER,
  block_hash TEXT,
  tx_hash TEXT,
  log_index INTEGER,
  state TEXT,
  first_seen TEXT,
  credited_at TEXT,
  reverted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_chain_log
  ON deposits(chain_id, token, tx_hash, log_index);

CREATE TABLE IF NOT EXISTS requests (
  address TEXT PRIMARY KEY,
  models TEXT,
  ts TEXT,
  state TEXT
);

CREATE TABLE IF NOT EXISTS consumers (
  address TEXT PRIMARY KEY,
  granted_models TEXT,
  requested_models TEXT,
  key_name TEXT,
  key_secret TEXT,
  state TEXT,
  created_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS payouts (
  tx_hash TEXT PRIMARY KEY,
  chain_id INTEGER,
  token TEXT,
  to_addr TEXT,
  amount_raw TEXT,
  state TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

export function ledgerPath(): string {
  return statePath(LEDGER_FILE);
}

/** The SQLite sidecars inherit the umask; a bearer credential must not. */
function secureFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows and exotic filesystems: best effort */
  }
}

export function secureLedgerFiles(path = ledgerPath()): void {
  for (const suffix of ["", "-wal", "-shm"]) secureFile(`${path}${suffix}`);
}

/**
 * Opens (and creates) the ledger. `path` is a parameter so a self-check can use
 * its own file; production always uses `ledgerPath()`.
 */
export function openLedger(path = ledgerPath()): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  secureLedgerFiles(path);
  return db;
}

/** One `meta` row, or null. */
export function metaGet(db: Database, key: string): string | null {
  const row = db.query("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | null;
  return row?.v ?? null;
}

export function metaSet(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    [key, value],
  );
}

export function metaDelete(db: Database, key: string): void {
  db.run("DELETE FROM meta WHERE k = ?", [key]);
}

/** Every `meta` row whose key starts with `prefix`, in key order. */
export function metaEntries(db: Database, prefix: string): { k: string; v: string }[] {
  return db.query("SELECT k, v FROM meta WHERE k LIKE ? ORDER BY k").all(`${prefix}%`) as {
    k: string;
    v: string;
  }[];
}

/**
 * USDC raw → micro-USD, floored. Returns null for a chain this plugin does not
 * credit (stage 4 only ever writes BSC and Base rows).
 */
export function microFromRaw(chainId: number, amountRaw: string | bigint): bigint | null {
  const decimals = CHAIN_DECIMALS[chainId];
  if (decimals === undefined) return null;
  let raw: bigint;
  try {
    raw = typeof amountRaw === "bigint" ? amountRaw : BigInt(String(amountRaw).trim());
  } catch {
    return null;
  }
  if (raw < 0n) return null;
  if (decimals >= 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}

/** Micro-USD → the $0.0001 grid Magpie's `--cost` accepts. */
export function capMicroOf(balanceMicro: bigint): bigint {
  if (balanceMicro <= 0n) return 0n;
  return (balanceMicro / CAP_STEP_MICRO) * CAP_STEP_MICRO;
}

/** Micro-USD → four decimal places, truncated (never overstates a balance). */
export function formatUsd4(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO_PER_USD;
  const frac = (abs % MICRO_PER_USD) / 100n; // 1e-4 USD per step
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(4, "0")}`;
}

/** A USD amount from Magpie (a float) → micro, floored. */
export function microFromUsd(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return BigInt(Math.floor(usd * 1_000_000));
}

interface CreditRow {
  chain_id: number;
  from_addr: string;
  amount_raw: string;
}

function creditedRows(db: Database, toAddr: string, fromAddr?: string): CreditRow[] {
  const sql =
    "SELECT chain_id, from_addr, amount_raw FROM deposits " +
    "WHERE state = 'credited' AND lower(to_addr) = lower(?)" +
    (fromAddr === undefined ? "" : " AND lower(from_addr) = lower(?)");
  const params = fromAddr === undefined ? [toAddr] : [toAddr, fromAddr];
  return db.query(sql).all(...params) as CreditRow[];
}

function sumMicro(rows: CreditRow[], toAddr: string): bigint {
  let total = 0n;
  for (const row of rows) {
    const micro = microFromRaw(Number(row.chain_id), row.amount_raw);
    if (micro === null) {
      logger.warn(`ledger: ignoring a credited row on unregistered chain ${String(row.chain_id)} for ${toAddr}`);
      continue;
    }
    total += micro;
  }
  return total;
}

/**
 * Σ credited deposits to `toAddr` from `fromAddr` (DESIGN-V2 §6 `D(地址)`).
 * Both BSC and Base count towards the same account; a reverted row does not.
 */
export function balanceMicro(db: Database, toAddr: string, fromAddr: string): bigint {
  return sumMicro(creditedRows(db, toAddr, fromAddr), toAddr);
}

/** Every payer with credited deposits to `toAddr`, and how much. */
export function creditByPayer(db: Database, toAddr: string): { address: string; micro: bigint }[] {
  const totals = new Map<string, bigint>();
  for (const row of creditedRows(db, toAddr)) {
    const key = String(row.from_addr).toLowerCase();
    const micro = microFromRaw(Number(row.chain_id), row.amount_raw);
    if (micro === null) continue;
    totals.set(key, (totals.get(key) ?? 0n) + micro);
  }
  return [...totals.entries()]
    .map(([address, micro]) => ({ address, micro }))
    .sort((a, b) => (a.address < b.address ? -1 : 1));
}
