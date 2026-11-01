// The plugin's SQLite ledger (DESIGN-V2 §9).
//
// One file, `<stateDir>/ledger.sqlite`, opened once per plugin host. WAL keeps
// the read side (`GET /request`) from blocking an approval; the file and its
// sidecars are 0600 because `consumers.key_secret` is a bearer credential.
//
// Stage 4 writes `deposits` (from the watcher) and `payouts` (from
// `send_payment`); both tables already existed, so the schema is unchanged.
// `balanceMicro` reads credited deposits, which is the single number a cap is
// derived from.
//
// Money is held as integer micro-USD (1e-6 USD) in this module. That is the
// finest unit the product needs: balances arrive as USDC raw (18 decimals on
// BSC, 6 on Base) and are floored once, and Magpie's cost limit is a $0.0001
// grid (`capMicroOf` floors again to 100 micro).
//
// A chain's decimals are **not** repeated here: `chain.ts` is the single source
// (BSC USDC has 18, Base USDC has 6), and this module only asks that registry.
// A deposit row from a chain the registry does not know is never summed. Stage 4
// writes `deposits` (from the watcher) and `payouts` (from `send_payment`); both
// tables already existed, so the schema is unchanged.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decimalsForChain } from "./chain.ts";
import { logger } from "./log.ts";
import { statePath } from "./paths.ts";

export const LEDGER_FILE = "ledger.sqlite";

/** 1 USD = 1e6 micro; Magpie's limit grid is 1e-4 USD = 100 micro. */
export const MICRO_PER_USD = 1_000_000n;
export const CAP_STEP_MICRO = 100n;
/** Below this a cost limit would mean "unlimited" to Magpie, so no key is issued. */
export const MIN_CAP_MICRO = CAP_STEP_MICRO;

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
 * USDC raw → micro-USD, floored. Returns null for a chain the registry does not
 * know, which is how a row from a retired experiment stays out of a balance.
 */
export function microFromRaw(chainId: number, amountRaw: string | bigint): bigint | null {
  const decimals = decimalsForChain(chainId);
  if (decimals === null) return null;
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

/** `deposits.id`: the uniqueness key of DESIGN-V2 §4, one string. */
export function depositId(chainId: number, token: string, txHash: string, logIndex: number): string {
  return `${chainId}:${token.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;
}

export interface NewDeposit {
  chainId: number;
  token: string;
  from: string;
  to: string;
  amountRaw: bigint;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  seenAt: string;
}

/**
 * Books one confirmed deposit. `false` means the row already existed, which is
 * the whole of the duplicate protection: a re-scan of the same log changes
 * nothing and must not re-issue a key.
 */
export function insertCreditedDeposit(db: Database, row: NewDeposit): boolean {
  const result = db.run(
    "INSERT INTO deposits(id, chain_id, token, from_addr, to_addr, amount_raw, block_number, block_hash, " +
      "tx_hash, log_index, state, first_seen, credited_at, reverted_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?, 'credited', ?, ?, NULL) " +
      "ON CONFLICT(id) DO NOTHING",
    [
      depositId(row.chainId, row.token, row.txHash, row.logIndex),
      row.chainId,
      row.token.toLowerCase(),
      row.from.toLowerCase(),
      row.to.toLowerCase(),
      row.amountRaw.toString(),
      row.blockNumber,
      row.blockHash,
      row.txHash.toLowerCase(),
      row.logIndex,
      row.seenAt,
      row.seenAt,
    ],
  );
  return result.changes > 0;
}

/** Marks a credited row reverted. The row is never deleted and no money moves. */
export function markDepositReverted(db: Database, id: string, when: string): boolean {
  const result = db.run("UPDATE deposits SET state = 'reverted', reverted_at = ? WHERE id = ? AND state = 'credited'", [
    when,
    id,
  ]);
  return result.changes > 0;
}

/**
 * Puts a previously reverted row back to credited.
 *
 * This is the case the reorg handling deliberately leaves open: a deposit that
 * was reorged out and then re-included (same tx, same log index) in a block that
 * this scan has already verified and found final. Re-crediting is the correct
 * answer because the money really is on the chain; skipping it would silently
 * lose the deposit. Only a final, receipt-verified log can reach this.
 */
export function recreditDeposit(db: Database, row: NewDeposit): boolean {
  const id = depositId(row.chainId, row.token, row.txHash, row.logIndex);
  const result = db.run(
    "UPDATE deposits SET state = 'credited', block_number = ?, block_hash = ?, credited_at = ?, reverted_at = NULL " +
      "WHERE id = ? AND state = 'reverted' AND amount_raw = ? AND lower(from_addr) = lower(?) AND lower(to_addr) = lower(?)",
    [row.blockNumber, row.blockHash, row.seenAt, id, row.amountRaw.toString(), row.from, row.to],
  );
  return result.changes > 0;
}

export interface CreditedBlock {
  id: string;
  chain_id: number;
  from_addr: string;
  block_number: number;
  block_hash: string;
}

/** Credited rows worth re-checking against the canonical chain (§6 rollback). */
export function creditedBlocksSince(db: Database, toAddr: string, minBlock: number): CreditedBlock[] {
  return db
    .query(
      "SELECT id, chain_id, from_addr, block_number, block_hash FROM deposits " +
        "WHERE state = 'credited' AND lower(to_addr) = lower(?) AND block_number >= ?",
    )
    .all(toAddr, minBlock) as CreditedBlock[];
}

export interface DepositRow {
  id: string;
  chain_id: number;
  token: string;
  from_addr: string;
  to_addr: string;
  amount_raw: string;
  block_number: number;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  state: string;
  first_seen: string;
  credited_at: string | null;
  reverted_at: string | null;
}

/** Local deposits to `toAddr`, newest first; `fromAddr` filters the payer. */
export function listDeposits(
  db: Database,
  opts: { toAddr: string; fromAddr?: string; limit: number },
): DepositRow[] {
  const sql =
    "SELECT * FROM deposits WHERE lower(to_addr) = lower(?)" +
    (opts.fromAddr === undefined ? "" : " AND lower(from_addr) = lower(?)") +
    " ORDER BY block_number DESC, log_index DESC LIMIT ?";
  const params = opts.fromAddr === undefined ? [opts.toAddr, opts.limit] : [opts.toAddr, opts.fromAddr, opts.limit];
  return db.query(sql).all(...params) as DepositRow[];
}

export interface PayoutRow {
  tx_hash: string;
  chain_id: number;
  token: string;
  to_addr: string;
  amount_raw: string;
  state: string;
  created_at: string;
}

/** The only local record of money leaving this wallet (DESIGN-V2 §6). */
export function recordPayout(
  db: Database,
  row: { txHash: string; chainId: number; token: string; to: string; amountRaw: bigint; state: string; at: string },
): void {
  db.run(
    "INSERT INTO payouts(tx_hash, chain_id, token, to_addr, amount_raw, state, created_at) VALUES(?,?,?,?,?,?,?) " +
      "ON CONFLICT(tx_hash) DO UPDATE SET state = excluded.state",
    [
      row.txHash.toLowerCase(),
      row.chainId,
      row.token.toLowerCase(),
      row.to.toLowerCase(),
      row.amountRaw.toString(),
      row.state,
      row.at,
    ],
  );
}

export function listPayouts(db: Database, limit: number): PayoutRow[] {
  return db.query("SELECT * FROM payouts ORDER BY created_at DESC LIMIT ?").all(limit) as PayoutRow[];
}

/** Where the per-chain scanner resumes: the last block it fully scanned. */
export function scanCursor(db: Database, chainId: number): number | null {
  const raw = metaGet(db, `scan:${chainId}`);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Advances the cursor. The watcher calls this inside the same transaction as the
 * deposit inserts, so the two can never disagree after a crash.
 */
export function setScanCursor(db: Database, chainId: number, block: number): void {
  metaSet(db, `scan:${chainId}`, String(block));
}

/** Drops every cursor; used when the node identity changes (a new address). */
export function clearScanCursors(db: Database): number {
  const rows = metaEntries(db, "scan:");
  for (const row of rows) metaDelete(db, row.k);
  return rows.length;
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
