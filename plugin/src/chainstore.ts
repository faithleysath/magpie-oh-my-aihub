// Chain-side persistence: deposit events, intents, scan cursors and anomalies.
//
// This is a second SQLite file next to `ledger.sqlite`, and the separation is
// deliberate: `ledger.sqlite` is the business credit balance and nothing here
// may write to it. A chain row records what a chain said; the ledger records
// what the plugin decided to owe. The only bridge is the wallet's credit sink,
// which asks the ledger for a deposit intent carrying the chain event's own id.
//
// The constraints that make double-crediting impossible are **in the schema**,
// not in a JavaScript `Set`:
//
//  - `deposit_events` is unique on `(chain_id, token_contract, tx_hash, log_index)`.
//    Not on `tx_hash`: one transaction may contain several `Transfer`s.
//  - `deposit_events.deposit_id` is unique, so one chain event can back at most
//    one ledger deposit.
//  - `deposit_intents.invoice_id` and `nonce` are unique.
//  - `deposit_intents.claimed_event_id` is unique, so one event is claimed by at
//    most one intent.
//  - `scan_cursors` is keyed by chain, so each chain advances on its own.
//
// A reorg is recorded, never hidden: a block hash change marks the event
// `reverted`, and a credited event that is reverted also gets a row in
// `deposit_anomalies` and freezes the consumer in the ledger. Nothing is deleted.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./paths.ts";
import type { DepositIntent, IntentStatus } from "./deposits.ts";

/**
 * `observed` → `confirming` → `finalized` → `crediting` → `credited`, with the
 * branches the phase-7 brief requires. Only `finalized` may be credited.
 */
export type ChainEventStatus =
  | "observed"
  | "confirming"
  | "finalized"
  | "crediting"
  | "credited"
  | "unclaimed"
  | "uncertain"
  | "reverted"
  | "failed"
  | "manualReview";

export interface ChainDepositEvent {
  id: string;
  chainId: number;
  tokenContract: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  status: ChainEventStatus;
  /** the intent that claimed this event, if any */
  invoiceId: string | null;
  /** the ledger deposit id created for this event, if any */
  depositId: string | null;
  confirmations: number;
  firstSeenAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  creditedAt: string | null;
  /** why it is unclaimed/uncertain/reverted; never overwritten silently */
  reason: string | null;
  /** how many times a scan saw this same log (proves the dedupe) */
  observations: number;
  /** the rate this event was converted at; null until credited (or on an old row) */
  rateNanosPerToken: string | null;
  rateVersion: string | null;
  /** the nano-USD actually booked, once credited */
  creditedNanos: number | null;
  /** how many verification attempts the scan has made */
  verifyAttempts: number;
}

export interface ScanCursor {
  chainId: number;
  /** last block fully scanned and committed */
  lastBlock: number;
  /** hash of `lastBlock`, to detect a reorg behind the cursor */
  lastBlockHash: string | null;
  updatedAt: string;
  lastError: string | null;
  lastScanAt: string | null;
}

export interface ChainAnomaly {
  id: number;
  chainId: number;
  at: string;
  kind:
    | "reorg"
    | "rpc-disagreement"
    | "cursor-gap"
    | "credit-failure"
    | "ledger-failure"
    | "finality-unavailable"
    | "bad-log"
    | "over-credit"
    /** the intent's rate snapshot no longer matches and cannot be proven */
    | "rate-mismatch";
  eventId: string | null;
  detail: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deposit_events (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  token_contract TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  status TEXT NOT NULL,
  invoice_id TEXT,
  deposit_id TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT,
  credited_at TEXT,
  reason TEXT,
  observations INTEGER NOT NULL DEFAULT 1,
  -- The rate the event was *converted at*, frozen here so a later registry edit
  -- can never recompute an accepted amount. Written once, at credit time.
  rate_nanos_per_token TEXT,
  rate_version TEXT,
  credited_nanos INTEGER,
  -- how many times verification was attempted, for the status view
  verify_attempts INTEGER NOT NULL DEFAULT 0
);
-- The phase-7 uniqueness rule: one row per (chain, token, tx, log index).
CREATE UNIQUE INDEX IF NOT EXISTS one_event_per_log
  ON deposit_events(chain_id, token_contract, tx_hash, log_index);
-- One chain event may back at most one ledger deposit.
CREATE UNIQUE INDEX IF NOT EXISTS one_deposit_per_event
  ON deposit_events(deposit_id) WHERE deposit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_by_status ON deposit_events(status, chain_id);
CREATE INDEX IF NOT EXISTS events_by_block ON deposit_events(chain_id, block_number);
CREATE INDEX IF NOT EXISTS events_by_invoice ON deposit_events(invoice_id);

CREATE TABLE IF NOT EXISTS deposit_intents (
  invoice_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  expected_amount_raw TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payer_address TEXT,
  attribution_status TEXT NOT NULL,
  price_version TEXT NOT NULL,
  status TEXT NOT NULL,
  nonce TEXT NOT NULL,
  digest TEXT,
  created_at TEXT NOT NULL,
  claimed_event_id TEXT,
  -- The rate snapshot taken when the intent was issued. A deposit is converted
  -- at *this* rate, never at whatever the registry says when the transfer lands.
  rate_nanos_per_token TEXT,
  rate_decimals INTEGER,
  rate_asset_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_intent_per_nonce ON deposit_intents(nonce);
CREATE UNIQUE INDEX IF NOT EXISTS one_intent_per_event
  ON deposit_intents(claimed_event_id) WHERE claimed_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intents_by_consumer ON deposit_intents(consumer_id, created_at);
CREATE INDEX IF NOT EXISTS intents_by_match
  ON deposit_intents(chain_id, token_contract, recipient_address, expected_amount_raw, payer_address, status);

CREATE TABLE IF NOT EXISTS scan_cursors (
  chain_id INTEGER PRIMARY KEY,
  last_block INTEGER NOT NULL,
  last_block_hash TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  last_scan_at TEXT
);

CREATE TABLE IF NOT EXISTS chain_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT,
  detail TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS anomalies_by_chain ON chain_anomalies(chain_id, id);

-- The provider's receiving address per (provider, chain). No secret material is
-- stored here: a receiving address is public and the plugin holds no key for it.
CREATE TABLE IF NOT EXISTS receiving_addresses (
  provider_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, chain_id)
);

CREATE TABLE IF NOT EXISTS asset_checks (
  asset_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  onchain_decimals INTEGER,
  registered_decimals INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
`;

function nowIso(): string {
  return new Date().toISOString();
}

export function chainDbPath(): string {
  return statePath("chain.sqlite");
}

/**
 * The identity of one chain event: `(chainId, tokenContract, txHash, logIndex)`.
 * Lower-cased hex so a checksummed and a lower-case spelling of the same log do
 * not become two rows.
 */
export function chainEventId(chainId: number, tokenContract: string, txHash: string, logIndex: number): string {
  return `${chainId}:${tokenContract.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;
}

export class ChainStore {
  private db: Database;
  private closed = false;

  constructor(path = chainDbPath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // A database written by the first phase-7 build has no rate snapshot on its
    // events. Add the columns rather than making the file unreadable; an event
    // from that build has `rate_nanos_per_token IS NULL` and is therefore
    // treated as "no snapshot" by the credit path, not as a zero rate.
    const eventColumns = this.db.query("PRAGMA table_info(deposit_events)").all() as { name: string }[];
    for (const [name, type] of [
      ["rate_nanos_per_token", "TEXT"],
      ["rate_version", "TEXT"],
      ["credited_nanos", "INTEGER"],
      ["verify_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!eventColumns.some((c) => c.name === name)) this.db.exec(`ALTER TABLE deposit_events ADD COLUMN ${name} ${type}`);
    }
    const intentColumns = this.db.query("PRAGMA table_info(deposit_intents)").all() as { name: string }[];
    for (const [name, type] of [
      ["rate_nanos_per_token", "TEXT"],
      ["rate_decimals", "INTEGER"],
      ["rate_asset_id", "TEXT"],
    ] as const) {
      if (!intentColumns.some((c) => c.name === name)) this.db.exec(`ALTER TABLE deposit_intents ADD COLUMN ${name} ${type}`);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      /* the directory is still 0700 */
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
        /* already gone */
      }
      throw e;
    }
  }

  // --- intents ---------------------------------------------------------------

  insertIntent(intent: DepositIntent): DepositIntent {
    this.db
      .query(
        `INSERT INTO deposit_intents(invoice_id,provider_id,consumer_id,chain_id,asset_id,token_contract,recipient_address,
          expected_amount_raw,requested_at,expires_at,payer_address,attribution_status,price_version,status,nonce,digest,created_at,claimed_event_id,
          rate_nanos_per_token,rate_decimals,rate_asset_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
      )
      .run(
        intent.invoiceId,
        intent.providerId,
        intent.consumerId,
        intent.chainId,
        intent.assetId,
        intent.tokenContract,
        intent.recipientAddress,
        intent.expectedAmountRaw,
        intent.requestedAt,
        intent.expiresAt,
        intent.payerAddress,
        intent.attributionStatus,
        intent.priceVersion,
        intent.status,
        intent.nonce,
        intent.digest,
        intent.createdAt,
        intent.rateNanosPerToken || null,
        intent.rateDecimals >= 0 ? intent.rateDecimals : null,
        intent.rateAssetId || null,
      );
    return this.intent(intent.invoiceId)!;
  }

  intent(invoiceId: string): DepositIntent | null {
    const row = this.db.query("SELECT * FROM deposit_intents WHERE invoice_id = ?").get(invoiceId) as IntentRow | null;
    return row ? mapIntent(row) : null;
  }

  intentsFor(consumerId: string, limit = 50): DepositIntent[] {
    const rows = this.db
      .query("SELECT * FROM deposit_intents WHERE consumer_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(consumerId, limit) as IntentRow[];
    return rows.map(mapIntent);
  }

  allIntents(limit = 200): DepositIntent[] {
    const rows = this.db.query("SELECT * FROM deposit_intents ORDER BY created_at DESC LIMIT ?").all(limit) as IntentRow[];
    return rows.map(mapIntent);
  }

  /**
   * Attaches a verified signature. Refused when the intent is no longer
   * `requested`, so a signature cannot be swapped onto a matched intent, and
   * when a different payer is already recorded.
   */
  setPayer(input: { invoiceId: string; payerAddress: string; digest: string; at?: string }): DepositIntent {
    return this.tx(() => {
      const current = this.intent(input.invoiceId);
      if (!current) throw new Error(`no deposit intent ${input.invoiceId}`);
      if (current.status !== "requested" || current.attributionStatus !== "unsigned") {
        throw new Error(`intent ${input.invoiceId} is ${current.status}; a signature cannot be added to it`);
      }
      if (current.payerAddress && current.payerAddress.toLowerCase() !== input.payerAddress.toLowerCase()) {
        throw new Error(`intent ${input.invoiceId} is already bound to another payer`);
      }
      this.db
        .query("UPDATE deposit_intents SET payer_address=?,digest=?,attribution_status='signed',status='signed' WHERE invoice_id=?")
        .run(input.payerAddress, input.digest, input.invoiceId);
      return this.intent(input.invoiceId)!;
    });
  }

  setIntentStatus(invoiceId: string, status: IntentStatus, attribution?: DepositIntent["attributionStatus"]): void {
    const current = this.intent(invoiceId);
    if (!current) throw new Error(`no deposit intent ${invoiceId}`);
    if (attribution) {
      this.db.query("UPDATE deposit_intents SET status=?,attribution_status=? WHERE invoice_id=?").run(status, attribution, invoiceId);
    } else {
      this.db.query("UPDATE deposit_intents SET status=? WHERE invoice_id=?").run(status, invoiceId);
    }
  }

  /**
   * Every signed intent that could claim this transfer. More than one candidate
   * is an ambiguity the caller must refuse: with two identical unsigned-amount
   * requests from the same payer, the plugin cannot tell which one the consumer
   * meant, and guessing would credit the wrong invoice.
   */
  candidatesFor(input: {
    chainId: number;
    tokenContract: string;
    recipient: string;
    payer: string;
    amountRaw: string;
    now?: Date;
  }): DepositIntent[] {
    const rows = this.db
      .query(
        `SELECT * FROM deposit_intents
         WHERE chain_id=? AND lower(token_contract)=lower(?) AND lower(recipient_address)=lower(?)
           AND lower(payer_address)=lower(?) AND expected_amount_raw=? AND status='signed' AND claimed_event_id IS NULL`,
      )
      .all(input.chainId, input.tokenContract, input.recipient, input.payer, input.amountRaw) as IntentRow[];
    const at = (input.now ?? new Date()).getTime();
    return rows.map(mapIntent).filter((i) => new Date(i.expiresAt).getTime() > at);
  }

  // --- events ----------------------------------------------------------------

  /**
   * Records one scanned log. Returns `created: false` when the same
   * `(chain, token, tx, logIndex)` was already stored — that is the dedupe, and
   * it is the database's unique index doing the work, not a caller's set.
   */
  observeEvent(input: {
    chainId: number;
    tokenContract: string;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    from: string;
    to: string;
    amountRaw: string;
    confirmations: number;
    at?: string;
  }): { event: ChainDepositEvent; created: boolean } {
    const id = chainEventId(input.chainId, input.tokenContract, input.txHash, input.logIndex);
    const at = input.at ?? nowIso();
    return this.tx(() => {
      const existing = this.event(id);
      if (existing) {
        // The same log seen again: count it, and if the block hash moved, the
        // chain reorganised and this event is no longer what it was.
        const sameBlock = existing.blockHash.toLowerCase() === input.blockHash.toLowerCase();
        this.db
          .query("UPDATE deposit_events SET observations=observations+1,updated_at=?,confirmations=? WHERE id=?")
          .run(at, Math.max(existing.confirmations, input.confirmations), id);
        if (!sameBlock) {
          this.db
            .query("UPDATE deposit_events SET status='reverted',reason=?,updated_at=? WHERE id=?")
            .run(`block hash changed from ${existing.blockHash} to ${input.blockHash}`, at, id);
          this.anomaly({
            chainId: input.chainId,
            kind: "reorg",
            eventId: id,
            detail: `event ${id} was seen in block ${input.blockNumber} with hash ${input.blockHash}; the stored hash was ${existing.blockHash}`,
            at,
          });
        }
        return { event: this.event(id)!, created: false };
      }
      this.db
        .query(
          `INSERT INTO deposit_events(id,chain_id,token_contract,tx_hash,log_index,block_number,block_hash,from_address,to_address,
            amount_raw,status,invoice_id,deposit_id,confirmations,first_seen_at,updated_at,finalized_at,credited_at,reason,observations)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,NULL,NULL,NULL,1)`,
        )
        .run(
          id,
          input.chainId,
          input.tokenContract.toLowerCase(),
          input.txHash.toLowerCase(),
          input.logIndex,
          input.blockNumber,
          input.blockHash.toLowerCase(),
          input.from.toLowerCase(),
          input.to.toLowerCase(),
          input.amountRaw,
          input.confirmations > 0 ? "confirming" : "observed",
          input.confirmations,
          at,
          at,
        );
      return { event: this.event(id)!, created: true };
    });
  }

  event(id: string): ChainDepositEvent | null {
    const row = this.db.query("SELECT * FROM deposit_events WHERE id = ?").get(id) as EventRow | null;
    return row ? mapEvent(row) : null;
  }

  eventByTx(txHash: string): ChainDepositEvent[] {
    const rows = this.db.query("SELECT * FROM deposit_events WHERE lower(tx_hash)=lower(?) ORDER BY chain_id,log_index").all(txHash) as EventRow[];
    return rows.map(mapEvent);
  }

  eventsByStatus(status: ChainEventStatus, limit = 200): ChainDepositEvent[] {
    const rows = this.db.query("SELECT * FROM deposit_events WHERE status=? ORDER BY chain_id,block_number LIMIT ?").all(status, limit) as EventRow[];
    return rows.map(mapEvent);
  }

  eventsForChain(chainId: number, limit = 200): ChainDepositEvent[] {
    const rows = this.db
      .query("SELECT * FROM deposit_events WHERE chain_id=? ORDER BY block_number DESC, log_index DESC LIMIT ?")
      .all(chainId, limit) as EventRow[];
    return rows.map(mapEvent);
  }

  pendingFinality(chainId: number): ChainDepositEvent[] {
    const rows = this.db
      .query("SELECT * FROM deposit_events WHERE chain_id=? AND status IN ('observed','confirming') ORDER BY block_number, log_index")
      .all(chainId) as EventRow[];
    return rows.map(mapEvent);
  }

  // --- read-only aggregation --------------------------------------------------
  //
  // A status view must not count "the last 100 rows" and present it as a total.
  // These queries are aggregates over the whole table; they write nothing and
  // they are the only place the page's totals come from.

  /** Event counts and credited nano-USD, grouped by chain and status. */
  eventTotals(chainId?: number): EventTotalRow[] {
    const rows =
      chainId === undefined
        ? (this.db
            .query(
              `SELECT chain_id, status, COUNT(*) AS n, COALESCE(SUM(credited_nanos),0) AS nanos, MAX(updated_at) AS updated
               FROM deposit_events GROUP BY chain_id, status ORDER BY chain_id, status`,
            )
            .all() as EventTotalDbRow[])
        : (this.db
            .query(
              `SELECT chain_id, status, COUNT(*) AS n, COALESCE(SUM(credited_nanos),0) AS nanos, MAX(updated_at) AS updated
               FROM deposit_events WHERE chain_id=? GROUP BY chain_id, status ORDER BY status`,
            )
            .all(chainId) as EventTotalDbRow[]);
    return rows.map((r) => ({ chainId: r.chain_id, status: r.status as ChainEventStatus, count: r.n, creditedNanos: r.nanos, updatedAt: r.updated }));
  }

  /**
   * Event totals for one consumer, through the intent that claimed the event.
   * An event with no intent (a stranger's transfer) belongs to no consumer and
   * is deliberately absent here.
   */
  eventTotalsForConsumer(consumerId: string): EventTotalRow[] {
    const rows = this.db
      .query(
        `SELECT e.chain_id AS chain_id, e.status AS status, COUNT(*) AS n, COALESCE(SUM(e.credited_nanos),0) AS nanos, MAX(e.updated_at) AS updated
         FROM deposit_events e JOIN deposit_intents i ON i.invoice_id = e.invoice_id
         WHERE i.consumer_id=?
         GROUP BY e.chain_id, e.status ORDER BY e.chain_id, e.status`,
      )
      .all(consumerId) as EventTotalDbRow[];
    return rows.map((r) => ({ chainId: r.chain_id, status: r.status as ChainEventStatus, count: r.n, creditedNanos: r.nanos, updatedAt: r.updated }));
  }

  /** Events this consumer's own signed requests claimed, newest first. */
  eventsForConsumer(consumerId: string, limit = 200): ChainDepositEvent[] {
    const rows = this.db
      .query(
        `SELECT e.* FROM deposit_events e JOIN deposit_intents i ON i.invoice_id = e.invoice_id
         WHERE i.consumer_id=? ORDER BY e.block_number DESC, e.log_index DESC LIMIT ?`,
      )
      .all(consumerId, limit) as EventRow[];
    return rows.map(mapEvent);
  }

  /**
   * Events that were stored but not yet verified, so a temporary RPC failure is
   * retried instead of losing the payment.
   *
   * `uncertain` covers both "the receipt could not be read" and "the receipt did
   * not contain this log"; `observed` covers a row whose verification never ran
   * (a crash between the insert and the receipt read). `failed` is deliberately
   * **not** here: a reverted transaction is permanent, and retrying it forever
   * would only churn. `unclaimed` is not here either: it is a decision, not an
   * error, and a later intent cannot retroactively claim an old transfer without
   * a human saying so.
   */
  pendingVerification(chainId: number, limit = 100): ChainDepositEvent[] {
    const rows = this.db
      .query(
        `SELECT * FROM deposit_events
         WHERE chain_id=? AND status IN ('observed','uncertain')
           AND deposit_id IS NULL AND invoice_id IS NULL
         ORDER BY verify_attempts, block_number, log_index
         LIMIT ?`,
      )
      .all(chainId, limit) as EventRow[];
    return rows.map(mapEvent);
  }

  /** Counts one verification attempt; the status view shows it. */
  noteVerifyAttempt(id: string, at = nowIso()): void {
    this.db.query("UPDATE deposit_events SET verify_attempts=verify_attempts+1,updated_at=? WHERE id=?").run(at, id);
  }

  /** Events that are finalized (or later) and still need a ledger deposit. */
  awaitingCredit(chainId?: number, limit = 50): ChainDepositEvent[] {
    const rows = chainId === undefined
      ? (this.db.query("SELECT * FROM deposit_events WHERE status IN ('finalized','crediting') ORDER BY chain_id,block_number LIMIT ?").all(limit) as EventRow[])
      : (this.db
          .query("SELECT * FROM deposit_events WHERE chain_id=? AND status IN ('finalized','crediting') ORDER BY block_number LIMIT ?")
          .all(chainId, limit) as EventRow[]);
    return rows.map(mapEvent);
  }

  setEventStatus(id: string, status: ChainEventStatus, reason?: string | null, at = nowIso(), confirmations?: number): void {
    const event = this.event(id);
    if (!event) throw new Error(`no deposit event ${id}`);
    // A credited event is never moved back to a creditable state by a scan; only
    // `reverted` (a proven reorg) may override it, and that keeps the deposit id.
    if (event.status === "credited" && status !== "reverted") return;
    this.db
      .query(
        `UPDATE deposit_events SET status=?,reason=?,updated_at=?,
           finalized_at=CASE WHEN ?='finalized' AND finalized_at IS NULL THEN ? ELSE finalized_at END,
           confirmations=CASE WHEN ? IS NULL THEN confirmations ELSE MAX(confirmations, ?) END
         WHERE id=?`,
      )
      .run(status, reason ?? event.reason, at, status, at, confirmations ?? null, confirmations ?? 0, id);
  }

  /**
   * Freezes the rate an event was converted at, before the ledger is asked for a
   * deposit. Written once: a later registry change cannot overwrite it, so an
   * accepted amount can never be recomputed.
   */
  recordConversion(input: { id: string; nanos: number; nanosPerToken: string; priceVersion: string; at?: string }): void {
    const at = input.at ?? nowIso();
    this.tx(() => {
      const event = this.event(input.id);
      if (!event) throw new Error(`no deposit event ${input.id}`);
      if (event.creditedNanos !== null) {
        if (event.creditedNanos !== input.nanos) {
          throw new Error(`event ${input.id} was converted at ${event.creditedNanos} nanos; it cannot be re-converted at ${input.nanos}`);
        }
        return;
      }
      this.db
        .query("UPDATE deposit_events SET credited_nanos=?,rate_nanos_per_token=?,rate_version=?,updated_at=? WHERE id=?")
        .run(input.nanos, input.nanosPerToken, input.priceVersion, at, input.id);
    });
  }

  markCredited(id: string, depositId: string, at = nowIso()): void {
    this.tx(() => {
      const event = this.event(id);
      if (!event) throw new Error(`no deposit event ${id}`);
      if (event.depositId && event.depositId !== depositId) {
        throw new Error(`event ${id} already backs deposit ${event.depositId}; it cannot back ${depositId} too`);
      }
      this.db.query("UPDATE deposit_events SET status='credited',deposit_id=?,credited_at=?,updated_at=? WHERE id=?").run(depositId, at, at, id);
    });
  }

  /**
   * Claims an event for one intent, atomically. Both unique indexes are the
   * guard: the second claimer's transaction fails rather than overwriting.
   */
  claim(input: { eventId: string; invoiceId: string; at?: string }): void {
    const at = input.at ?? nowIso();
    this.tx(() => {
      const event = this.event(input.eventId);
      if (!event) throw new Error(`no deposit event ${input.eventId}`);
      const intent = this.intent(input.invoiceId);
      if (!intent) throw new Error(`no deposit intent ${input.invoiceId}`);
      if (event.invoiceId && event.invoiceId !== input.invoiceId) {
        throw new Error(`event ${input.eventId} is already claimed by ${event.invoiceId}`);
      }
      // The status moves out of `observed`/`uncertain` here: attribution is done,
      // and only finality is left. Leaving it in the verification set would make
      // the retry pass re-attribute it after the intent is already `matched`,
      // which finds no candidate and wrongly marks a claimed payment `unclaimed`.
      this.db
        .query("UPDATE deposit_events SET invoice_id=?,status=CASE WHEN status IN ('observed','uncertain') THEN 'confirming' ELSE status END,updated_at=? WHERE id=? AND invoice_id IS NULL")
        .run(input.invoiceId, at, input.eventId);
      const r = this.db
        .query("UPDATE deposit_intents SET claimed_event_id=?,status='matched',attribution_status='matched' WHERE invoice_id=? AND claimed_event_id IS NULL")
        .run(input.eventId, input.invoiceId);
      if (r.changes === 0) throw new Error(`intent ${input.invoiceId} already claimed an event`);
    });
  }

  /** Records a transfer no intent could claim. It is visible, never credited. */
  markUnclaimed(id: string, reason: string): void {
    this.setEventStatus(id, "unclaimed", reason.slice(0, 400));
  }

  // --- cursors ---------------------------------------------------------------

  cursor(chainId: number): ScanCursor | null {
    const row = this.db.query("SELECT * FROM scan_cursors WHERE chain_id = ? AND last_scan_at IS NOT NULL").get(chainId) as CursorRow | null;
    return row ? mapCursor(row) : null;
  }

  /** The last error, even when no scan has ever completed. */
  lastError(chainId: number): string | null {
    const row = this.db.query("SELECT last_error FROM scan_cursors WHERE chain_id = ?").get(chainId) as { last_error: string | null } | null;
    return row?.last_error ?? null;
  }

  allCursors(): ScanCursor[] {
    return (this.db.query("SELECT * FROM scan_cursors WHERE last_scan_at IS NOT NULL ORDER BY chain_id").all() as CursorRow[]).map(mapCursor);
  }

  /**
   * Advances a cursor only forward, and records the block hash so a later scan
   * can prove the block it trusts is still in the chain. Going backwards is a
   * separate, explicit operation (`rewindCursor`) that also writes an anomaly.
   */
  advanceCursor(input: { chainId: number; block: number; blockHash: string | null; at?: string }): void {
    const at = input.at ?? nowIso();
    this.db
      .query(
        `INSERT INTO scan_cursors(chain_id,last_block,last_block_hash,updated_at,last_error,last_scan_at)
         VALUES(?,?,?,?,NULL,?)
         ON CONFLICT(chain_id) DO UPDATE SET
           last_block=MAX(scan_cursors.last_block, excluded.last_block),
           last_block_hash=CASE WHEN excluded.last_block >= scan_cursors.last_block THEN excluded.last_block_hash ELSE scan_cursors.last_block_hash END,
           updated_at=excluded.updated_at,
           last_error=NULL,
           last_scan_at=excluded.last_scan_at`,
      )
      .run(input.chainId, input.block, input.blockHash, at, at);
  }

  /**
   * Stores one page of logs **and** advances the cursor in a single transaction.
   *
   * This is the commit point. The phase-7 comment claimed this behaviour while
   * the code inserted each event in its own transaction and advanced the cursor
   * in another, so a crash or a failed insert could leave a page partially
   * stored with the cursor already past it. Either the whole page and the cursor
   * commit, or neither does and the page is re-read.
   *
   * Duplicates are not an error: an event that already exists is counted and
   * skipped, because re-reading a page is normal after a restart.
   */
  commitPage(input: {
    chainId: number;
    block: number;
    blockHash: string | null;
    events: {
      tokenContract: string;
      txHash: string;
      logIndex: number;
      blockNumber: number;
      blockHash: string;
      from: string;
      to: string;
      amountRaw: string;
      confirmations?: number;
    }[];
    at?: string;
  }): { created: ChainDepositEvent[]; duplicates: number } {
    const at = input.at ?? nowIso();
    return this.tx(() => {
      const created: ChainDepositEvent[] = [];
      let duplicates = 0;
      for (const e of input.events) {
        const id = chainEventId(input.chainId, e.tokenContract, e.txHash, e.logIndex);
        const existing = this.event(id);
        if (existing) {
          const sameBlock = existing.blockHash.toLowerCase() === e.blockHash.toLowerCase();
          this.db.query("UPDATE deposit_events SET observations=observations+1,updated_at=? WHERE id=?").run(at, id);
          if (!sameBlock) {
            this.db
              .query("UPDATE deposit_events SET status='reverted',reason=?,updated_at=? WHERE id=?")
              .run(`block hash changed from ${existing.blockHash} to ${e.blockHash}`, at, id);
            this.anomaly({
              chainId: input.chainId,
              kind: "reorg",
              eventId: id,
              detail: `event ${id} was seen in block ${e.blockNumber} with hash ${e.blockHash}; the stored hash was ${existing.blockHash}`,
              at,
            });
          }
          duplicates += 1;
          continue;
        }
        this.db
          .query(
            `INSERT INTO deposit_events(id,chain_id,token_contract,tx_hash,log_index,block_number,block_hash,from_address,to_address,
              amount_raw,status,invoice_id,deposit_id,confirmations,first_seen_at,updated_at,finalized_at,credited_at,reason,observations)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,NULL,NULL,NULL,1)`,
          )
          .run(
            id,
            input.chainId,
            e.tokenContract.toLowerCase(),
            e.txHash.toLowerCase(),
            e.logIndex,
            e.blockNumber,
            e.blockHash.toLowerCase(),
            e.from.toLowerCase(),
            e.to.toLowerCase(),
            e.amountRaw,
            (e.confirmations ?? 0) > 0 ? "confirming" : "observed",
            e.confirmations ?? 0,
            at,
            at,
          );
        created.push(this.event(id)!);
      }
      this.advanceCursorInTx(input.chainId, input.block, input.blockHash, at);
      return { created, duplicates };
    });
  }

  private advanceCursorInTx(chainId: number, block: number, blockHash: string | null, at: string): void {
    this.db
      .query(
        `INSERT INTO scan_cursors(chain_id,last_block,last_block_hash,updated_at,last_error,last_scan_at)
         VALUES(?,?,?,?,NULL,?)
         ON CONFLICT(chain_id) DO UPDATE SET
           last_block=MAX(scan_cursors.last_block, excluded.last_block),
           last_block_hash=CASE WHEN excluded.last_block >= scan_cursors.last_block THEN excluded.last_block_hash ELSE scan_cursors.last_block_hash END,
           updated_at=excluded.updated_at,
           last_error=NULL,
           last_scan_at=excluded.last_scan_at`,
      )
      .run(chainId, block, blockHash, at, at);
  }

  rewindCursor(chainId: number, toBlock: number, reason: string): void {
    this.tx(() => {
      const at = nowIso();
      this.db
        .query(
          `INSERT INTO scan_cursors(chain_id,last_block,last_block_hash,updated_at,last_error,last_scan_at)
           VALUES(?,?,NULL,?,?,NULL)
           ON CONFLICT(chain_id) DO UPDATE SET last_block=excluded.last_block,last_block_hash=NULL,updated_at=excluded.updated_at,last_error=excluded.last_error`,
        )
        .run(chainId, Math.max(0, toBlock), at, reason.slice(0, 300));
      this.anomaly({ chainId, kind: "cursor-gap", detail: `cursor rewound to ${toBlock}: ${reason}`, at });
    });
  }

  /**
   * Records a failure without inventing a cursor. A chain that has never
   * completed a scan must stay at "no cursor" (`null`), because "cursor 0" would
   * mean "blocks 0..head have been scanned and had nothing", which is a much
   * stronger and false claim.
   */
  recordScanError(chainId: number, error: string): void {
    const at = nowIso();
    this.db
      .query(
        `INSERT INTO scan_cursors(chain_id,last_block,last_block_hash,updated_at,last_error,last_scan_at)
         VALUES(?,0,NULL,?,?,NULL)
         ON CONFLICT(chain_id) DO UPDATE SET last_error=excluded.last_error,updated_at=excluded.updated_at`,
      )
      .run(chainId, at, error.slice(0, 400));
    this.db.query("DELETE FROM scan_cursors WHERE chain_id=? AND last_scan_at IS NULL").run(chainId);
  }

  /** Whether this chain has ever committed a scanned range. */
  hasCursor(chainId: number): boolean {
    const row = this.db.query("SELECT 1 AS x FROM scan_cursors WHERE chain_id=? AND last_scan_at IS NOT NULL").get(chainId) as { x: number } | null;
    return row !== null;
  }

  // --- anomalies -------------------------------------------------------------

  anomaly(input: { chainId: number; kind: ChainAnomaly["kind"]; detail: string; eventId?: string | null; at?: string }): void {
    this.db
      .query("INSERT INTO chain_anomalies(chain_id,at,kind,event_id,detail,resolved_at,resolution_note) VALUES(?,?,?,?,?,NULL,NULL)")
      .run(input.chainId, input.at ?? nowIso(), input.kind, input.eventId ?? null, input.detail.slice(0, 1000));
  }

  anomalies(chainId?: number, limit = 100): ChainAnomaly[] {
    const rows = chainId === undefined
      ? (this.db.query("SELECT * FROM chain_anomalies ORDER BY id DESC LIMIT ?").all(limit) as AnomalyRow[])
      : (this.db.query("SELECT * FROM chain_anomalies WHERE chain_id=? ORDER BY id DESC LIMIT ?").all(chainId, limit) as AnomalyRow[]);
    return rows.map((r) => ({
      id: r.id,
      chainId: r.chain_id,
      at: r.at,
      kind: r.kind as ChainAnomaly["kind"],
      eventId: r.event_id,
      detail: r.detail,
      resolvedAt: r.resolved_at,
      resolutionNote: r.resolution_note,
    }));
  }

  resolveAnomaly(id: number, note: string, at = nowIso()): void {
    const r = this.db.query("UPDATE chain_anomalies SET resolved_at=?,resolution_note=? WHERE id=? AND resolved_at IS NULL").run(at, note.slice(0, 500), id);
    if (r.changes === 0) throw new Error(`no open anomaly ${id}`);
  }

  // --- receiving addresses ----------------------------------------------------

  /**
   * Records the provider's receiving address for one chain.
   *
   * The unique key is `(provider_id, chain_id)`, so one provider may publish a
   * different address per network and updating one never touches another. No
   * secret is stored: a receiving address is public, and the plugin holds no key
   * for either side.
   */
  setReceivingAddress(input: { providerId: string; chainId: number; address: string; at?: string }): void {
    this.db
      .query(
        `INSERT INTO receiving_addresses(provider_id,chain_id,address,added_at) VALUES(?,?,?,?)
         ON CONFLICT(provider_id,chain_id) DO UPDATE SET address=excluded.address,added_at=excluded.added_at`,
      )
      .run(input.providerId, input.chainId, input.address, input.at ?? nowIso());
  }

  receivingAddresses(): { providerId: string; chainId: number; address: string; addedAt: string }[] {
    const rows = this.db.query("SELECT * FROM receiving_addresses ORDER BY provider_id, chain_id").all() as {
      provider_id: string;
      chain_id: number;
      address: string;
      added_at: string;
    }[];
    return rows.map((r) => ({ providerId: r.provider_id, chainId: r.chain_id, address: r.address, addedAt: r.added_at }));
  }

  receivingAddress(providerId: string, chainId: number): string | null {
    const row = this.db
      .query("SELECT address FROM receiving_addresses WHERE provider_id=? AND chain_id=?")
      .get(providerId, chainId) as { address: string } | null;
    return row?.address ?? null;
  }

  /** Test seam: pretend an intent was written before the rate snapshot existed. */
  clearIntentRateSnapshot(invoiceId: string): void {
    this.db.query("UPDATE deposit_intents SET rate_nanos_per_token=NULL,rate_decimals=NULL,rate_asset_id=NULL WHERE invoice_id=?").run(invoiceId);
  }

  // --- decimals checks -------------------------------------------------------

  recordAssetCheck(input: { assetId: string; chainId: number; contract: string; onchainDecimals: number | null; registeredDecimals: number; ok: boolean; detail: string | null; at?: string }): void {
    this.db
      .query(
        `INSERT INTO asset_checks(asset_id,chain_id,contract_address,onchain_decimals,registered_decimals,checked_at,ok,detail)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(asset_id) DO UPDATE SET onchain_decimals=excluded.onchain_decimals,checked_at=excluded.checked_at,ok=excluded.ok,detail=excluded.detail`,
      )
      .run(input.assetId, input.chainId, input.contract.toLowerCase(), input.onchainDecimals, input.registeredDecimals, input.at ?? nowIso(), input.ok ? 1 : 0, input.detail);
  }

  assetCheck(assetId: string): { onchainDecimals: number | null; registeredDecimals: number; ok: boolean; detail: string | null; checkedAt: string } | null {
    const row = this.db.query("SELECT * FROM asset_checks WHERE asset_id=?").get(assetId) as AssetCheckRow | null;
    if (!row) return null;
    return { onchainDecimals: row.onchain_decimals, registeredDecimals: row.registered_decimals, ok: row.ok === 1, detail: row.detail, checkedAt: row.checked_at };
  }
}

interface IntentRow {
  invoice_id: string;
  provider_id: string;
  consumer_id: string;
  chain_id: number;
  asset_id: string;
  token_contract: string;
  recipient_address: string;
  expected_amount_raw: string;
  requested_at: string;
  expires_at: string;
  payer_address: string | null;
  attribution_status: string;
  price_version: string;
  status: string;
  nonce: string;
  digest: string | null;
  created_at: string;
  claimed_event_id: string | null;
  rate_nanos_per_token: string | null;
  rate_decimals: number | null;
  rate_asset_id: string | null;
}

/** One `(chain, status)` aggregate row; read-only, from `eventTotals()`. */
export interface EventTotalRow {
  chainId: number;
  status: ChainEventStatus;
  count: number;
  creditedNanos: number;
  updatedAt: string | null;
}

interface EventTotalDbRow {
  chain_id: number;
  status: string;
  n: number;
  nanos: number;
  updated: string | null;
}

interface EventRow {
  id: string;
  chain_id: number;
  token_contract: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_hash: string;
  from_address: string;
  to_address: string;
  amount_raw: string;
  status: string;
  invoice_id: string | null;
  deposit_id: string | null;
  confirmations: number;
  first_seen_at: string;
  updated_at: string;
  finalized_at: string | null;
  credited_at: string | null;
  reason: string | null;
  observations: number;
  rate_nanos_per_token: string | null;
  rate_version: string | null;
  credited_nanos: number | null;
  verify_attempts: number;
}

interface CursorRow {
  chain_id: number;
  last_block: number;
  last_block_hash: string | null;
  updated_at: string;
  last_error: string | null;
  last_scan_at: string | null;
}

interface AnomalyRow {
  id: number;
  chain_id: number;
  at: string;
  kind: string;
  event_id: string | null;
  detail: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

interface AssetCheckRow {
  asset_id: string;
  chain_id: number;
  contract_address: string;
  onchain_decimals: number | null;
  registered_decimals: number;
  checked_at: string;
  ok: number;
  detail: string | null;
}

function mapIntent(r: IntentRow): DepositIntent {
  return {
    invoiceId: r.invoice_id,
    providerId: r.provider_id,
    consumerId: r.consumer_id,
    chainId: r.chain_id,
    assetId: r.asset_id,
    tokenContract: r.token_contract,
    recipientAddress: r.recipient_address,
    expectedAmountRaw: r.expected_amount_raw,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    payerAddress: r.payer_address,
    attributionStatus: r.attribution_status as DepositIntent["attributionStatus"],
    priceVersion: r.price_version,
    status: r.status as IntentStatus,
    nonce: r.nonce,
    digest: r.digest,
    createdAt: r.created_at,
    // An intent written by the first phase-7 build has no snapshot. It is
    // reported as empty strings rather than invented values, and the credit path
    // refuses such an intent instead of guessing a rate.
    rateNanosPerToken: r.rate_nanos_per_token ?? "",
    rateDecimals: r.rate_decimals ?? -1,
    rateAssetId: r.rate_asset_id ?? "",
  };
}

function mapEvent(r: EventRow): ChainDepositEvent {
  return {
    id: r.id,
    chainId: r.chain_id,
    tokenContract: r.token_contract,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    blockNumber: r.block_number,
    blockHash: r.block_hash,
    fromAddress: r.from_address,
    toAddress: r.to_address,
    amountRaw: r.amount_raw,
    status: r.status as ChainEventStatus,
    invoiceId: r.invoice_id,
    depositId: r.deposit_id,
    confirmations: r.confirmations,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
    finalizedAt: r.finalized_at,
    creditedAt: r.credited_at,
    reason: r.reason,
    observations: r.observations,
    rateNanosPerToken: r.rate_nanos_per_token,
    rateVersion: r.rate_version,
    creditedNanos: r.credited_nanos,
    verifyAttempts: r.verify_attempts,
  };
}

function mapCursor(r: CursorRow): ScanCursor {
  return {
    chainId: r.chain_id,
    lastBlock: r.last_block,
    lastBlockHash: r.last_block_hash,
    updatedAt: r.updated_at,
    lastError: r.last_error,
    lastScanAt: r.last_scan_at,
  };
}
