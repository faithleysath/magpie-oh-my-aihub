// The plugin's SQLite ledger.
//
// One file, `<stateDir>/ledger.sqlite`, opened once per plugin host. WAL keeps
// the read side (`GET /request`) from blocking an approval; the file and its
// sidecars are 0600 because `consumers.key_secret` is a bearer credential.
//
// The deposit-claim path writes `deposits` and `send_payment` writes `payouts`;
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
// A deposit row from a chain the registry does not know is never summed.

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

-- Consumer-side hints: "please look at this transaction". They are not money;
-- the provider credits only after checking the receipt on chain.
CREATE TABLE IF NOT EXISTS deposit_claims (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deposit_claims_state
  ON deposit_claims(state, last_at);
CREATE INDEX IF NOT EXISTS deposit_claims_provider
  ON deposit_claims(provider, state);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- The address book: a local alias for an address, so a person need not paste
-- hex. Never signed, never published, never consulted for authorization.
CREATE TABLE IF NOT EXISTS contacts (
  alias TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  note TEXT,
  created_at TEXT
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
 * Σ credited deposits to `toAddr` from `fromAddr`.
 * Both BSC and Base count towards the same account; a reverted row does not.
 */
export function balanceMicro(db: Database, toAddr: string, fromAddr: string): bigint {
  return sumMicro(creditedRows(db, toAddr, fromAddr), toAddr);
}

/** `deposits.id`: the uniqueness key, one string. */
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
 * the whole of the duplicate protection: a repeated claim changes
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
 * A row can be `reverted` from an earlier version or a manual correction. If a
 * final receipt now proves the same transaction/log is included again, putting
 * it back to credited is the correct answer; skipping it would silently lose
 * the deposit. Only a final, receipt-verified log can reach this.
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

/** The only local record of money leaving this wallet. */
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

/** Reclassifies a payout after `send_payment` (for example, a deliberate gift). */
export function setPayoutState(db: Database, txHash: string, state: string): void {
  db.run("UPDATE payouts SET state = ? WHERE tx_hash = ?", [state, txHash.toLowerCase()]);
}

/** Σ payout micro-USD this wallet sent to one address, across both chains. */
export function payoutMicroTo(db: Database, toAddr: string): bigint {
  // After wallet_import, older payouts belong to the previous identity; the
  // "local sent" comparison must not count them.
  const since = metaGet(db, "wallet:since");
  const rows = (
    since
      ? db
          .query(
            "SELECT chain_id, token, amount_raw FROM payouts " +
              "WHERE lower(to_addr) = lower(?) AND state IN ('sent','unknown') AND created_at >= ?",
          )
          .all(toAddr, since)
      : db
          .query("SELECT chain_id, token, amount_raw FROM payouts WHERE lower(to_addr) = lower(?) AND state IN ('sent','unknown')")
          .all(toAddr)
  ) as { chain_id: number; token: string; amount_raw: string }[];
  let total = 0n;
  for (const row of rows) {
    // Native gas airdrops are not provider credit and use 18 decimals on both
    // chains, so they must not enter the USDC balance comparison.
    if (row.token.toLowerCase() === "native") continue;
    const micro = microFromRaw(Number(row.chain_id), row.amount_raw);
    if (micro !== null) total += micro;
  }
  return total;
}

export type DepositClaimState = "pending" | "credited" | "failed";

export interface DepositClaimRow {
  id: string;
  provider: string;
  chain_id: number;
  tx_hash: string;
  log_index: number | null;
  state: DepositClaimState;
  attempts: number;
  last_at: string | null;
  error: string | null;
  created_at: string;
}

function claimId(chainId: number, txHash: string): string {
  return `${chainId}:${txHash.toLowerCase()}`;
}

/**
 * Records one "look at this transaction" hint. A credited claim stays credited;
 * a failed one can be reset by the user before asking again.
 */
export function enqueueDepositClaim(
  db: Database,
  row: { provider: string; chainId: number; txHash: string; logIndex?: number | null; at: string },
): DepositClaimRow {
  const id = claimId(row.chainId, row.txHash);
  db.run(
    "INSERT INTO deposit_claims(id, provider, chain_id, tx_hash, log_index, state, attempts, last_at, error, created_at) " +
      "VALUES(?,?,?,?,?, 'pending', 0, NULL, NULL, ?) " +
      "ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, log_index = excluded.log_index",
    [id, row.provider.toLowerCase(), row.chainId, row.txHash.toLowerCase(), row.logIndex ?? null, row.at],
  );
  return db.query("SELECT * FROM deposit_claims WHERE id = ?").get(id) as DepositClaimRow;
}

export function resetDepositClaim(db: Database, chainId: number, txHash: string): boolean {
  const result = db.run(
    "UPDATE deposit_claims SET state = 'pending', attempts = 0, last_at = NULL, error = NULL WHERE id = ?",
    [claimId(chainId, txHash)],
  );
  return result.changes > 0;
}

export function depositClaim(db: Database, chainId: number, txHash: string): DepositClaimRow | null {
  return db.query("SELECT * FROM deposit_claims WHERE id = ?").get(claimId(chainId, txHash)) as DepositClaimRow | null;
}

export function listPendingDepositClaims(db: Database, limit = 50): DepositClaimRow[] {
  return db
    .query(
      "SELECT * FROM deposit_claims WHERE state = 'pending' ORDER BY COALESCE(last_at, created_at), id LIMIT ?",
    )
    .all(limit) as DepositClaimRow[];
}

export function markDepositClaimAttempt(db: Database, id: string, at: string, error: string | null): void {
  db.run(
    "UPDATE deposit_claims SET attempts = attempts + 1, last_at = ?, error = ? WHERE id = ? AND state = 'pending'",
    [at, error?.slice(0, 500) ?? null, id],
  );
}

export function markDepositClaimCredited(db: Database, id: string, at: string): void {
  db.run(
    "UPDATE deposit_claims SET state = 'credited', last_at = ?, error = NULL WHERE id = ?",
    [at, id],
  );
}

export function markDepositClaimFailed(db: Database, id: string, at: string, error: string): void {
  db.run(
    "UPDATE deposit_claims SET state = 'failed', last_at = ?, error = ? WHERE id = ?",
    [at, error.slice(0, 500), id],
  );
}

/** Drops consumer hints that belong to an old wallet identity. */
export function clearDepositClaims(db: Database): number {
  const result = db.run("DELETE FROM deposit_claims");
  return result.changes;
}

export function countPendingClaims(db: Database, provider: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM deposit_claims WHERE provider = lower(?) AND state = 'pending'")
    .get(provider) as { n: number };
  return row.n;
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
