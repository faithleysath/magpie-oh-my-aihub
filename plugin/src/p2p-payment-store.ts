// Durable P2P payment request/obligation state. This is not a ledger and never
// holds a key, seed, ciphertext or raw transaction: only public payment terms,
// public wallet addresses, the business signature and status/error codes.
//
// SQLite is used for the same reasons as the payment journal: one row per
// request/invoice, unique idempotency, a transaction that survives a crash, and
// no second server. The store is 0600/WAL/FULL. The payment journal remains the
// only send gate; this store only records provider terms and consumer
// obligations.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PaymentBinding } from "./payment-operations.ts";
import type { PaymentSelection, PaymentStatus, PaymentTerms } from "./p2p-payment-protocol.ts";

export interface StoredSelection {
  requestId: string;
  selection: PaymentSelection;
  status: PaymentStatus;
  idempotency: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface StoredProviderRequest {
  requestId: string;
  invoiceId: string;
  consumerFingerprint: string;
  selection: PaymentSelection;
  terms: PaymentTerms;
  digest: string;
  status: PaymentStatus;
  signature: string | null;
  payerAddress: string | null;
  peerStatus: PaymentStatus | null;
  error: string | null;
  idempotency: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface StoredObligation {
  requestId: string;
  invoiceId: string;
  provider: { nodeId: string; fingerprint: string; authorizationGeneration: number; quoteHash: string; priceVersion: string };
  consumerId: string;
  binding: PaymentBinding | null;
  terms: PaymentTerms;
  digest: string;
  signature: string | null;
  payerAddress: string | null;
  status: PaymentStatus;
  peerStatus: PaymentStatus | null;
  statusSource: "local" | "peer";
  error: string | null;
  idempotency: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface StoredMessage {
  peerNodeId: string;
  idempotency: string;
  requestId: string;
  kind: string;
  payloadHash: string;
  code: string;
  detail: string | null;
  atMs: number;
}

const MAX_JSON = 32 * 1024;
/** Bounded idempotency ledger: enough for retries, never an unbounded inbox. */
const MAX_MESSAGES = 1024;
const MESSAGE_TTL_MS = 24 * 60 * 60_000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_selections (
  request_id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL,
  provider_node_id TEXT NOT NULL,
  provider_fingerprint TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_selections_idempotency
  ON payment_selections(idempotency) WHERE idempotency IS NOT NULL;
CREATE TABLE IF NOT EXISTS provider_payment_requests (
  request_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE,
  consumer_node_id TEXT NOT NULL,
  consumer_fingerprint TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL,
  signature TEXT,
  payer_address TEXT,
  peer_status TEXT,
  error TEXT,
  idempotency TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consumer_payment_obligations (
  request_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE,
  provider_json TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  binding_json TEXT,
  terms_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  signature TEXT,
  payer_address TEXT,
  status TEXT NOT NULL,
  peer_status TEXT,
  status_source TEXT NOT NULL,
  error TEXT,
  idempotency TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_messages (
  peer_node_id TEXT NOT NULL,
  idempotency TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (peer_node_id, idempotency)
);
`;

function jsonOf(value: unknown, label: string): string {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > MAX_JSON) throw new Error(`${label} is too large`);
  return text;
}
function parse<T>(text: string, label: string): T {
  try { return JSON.parse(text) as T; } catch { throw new Error(`${label} is unreadable`); }
}
function statusRank(status: PaymentStatus): number {
  return status === "received" ? 3 : status === "confirming" ? 2 : status === "waitingpayment" ? 1 : 0;
}

interface SelectionRow { request_id: string; selection_json: string; status: PaymentStatus; idempotency: string | null; created_at_ms: number; updated_at_ms: number; }
interface ProviderRow {
  request_id: string; invoice_id: string; consumer_fingerprint: string; selection_json: string; terms_json: string; digest: string; status: PaymentStatus;
  signature: string | null; payer_address: string | null; peer_status: PaymentStatus | null; error: string | null;
  idempotency: string | null; created_at_ms: number; updated_at_ms: number; expires_at_ms: number;
}
interface ObligationRow {
  request_id: string; invoice_id: string; provider_json: string; consumer_id: string; binding_json: string; terms_json: string;
  digest: string; signature: string | null; payer_address: string | null; status: PaymentStatus; peer_status: PaymentStatus | null;
  status_source: "local" | "peer"; error: string | null; idempotency: string | null;
  created_at_ms: number; updated_at_ms: number; expires_at_ms: number;
}

export class P2pPaymentStore {
  private readonly db: Database;
  private closed = false;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec(SCHEMA);
    // The WAL/SHM sidecars carry the same public terms and signatures as the
    // main file; a default 0644 sidecar would leak them to other local users.
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try { chmodSync(file, 0o600); } catch { /* the file may not exist yet, or no POSIX modes */ }
    }
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* gone */ } throw error; }
  }

  private selectionRow(requestId: string): SelectionRow | null {
    return this.db.query("SELECT * FROM payment_selections WHERE request_id = ?").get(requestId) as SelectionRow | null;
  }
  private providerRow(requestId: string): ProviderRow | null {
    return this.db.query("SELECT * FROM provider_payment_requests WHERE request_id = ?").get(requestId) as ProviderRow | null;
  }
  private obligationRow(requestId: string): ObligationRow | null {
    return this.db.query("SELECT * FROM consumer_payment_obligations WHERE request_id = ?").get(requestId) as ObligationRow | null;
  }

  saveSelection(input: StoredSelection): StoredSelection {
    return this.tx(() => {
      const existing = this.selectionRow(input.requestId);
      if (existing) {
        if (existing.selection_json !== jsonOf(input.selection, "selection") || (existing.idempotency && input.idempotency && existing.idempotency !== input.idempotency)) {
          throw new Error("selection idempotency conflict");
        }
        return this.mapSelection(existing);
      }
      this.db.query("INSERT INTO payment_selections (request_id,consumer_id,provider_node_id,provider_fingerprint,selection_json,status,idempotency,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(input.requestId, input.selection.consumerId, input.selection.providerNodeId, input.selection.providerFingerprint, jsonOf(input.selection, "selection"), input.status, input.idempotency, input.createdAtMs, input.updatedAtMs);
      return input;
    });
  }

  selection(requestId: string): StoredSelection | null {
    const row = this.selectionRow(requestId);
    return row ? this.mapSelection(row) : null;
  }

  selectionByIdempotency(idempotency: string): StoredSelection | null {
    const row = this.db.query("SELECT * FROM payment_selections WHERE idempotency = ?").get(idempotency) as SelectionRow | null;
    return row ? this.mapSelection(row) : null;
  }

  /**
   * A local selection with no obligation that exactly matches these terms.
   * Used only to adopt one existing provider invoice after a lost reply, so a
   * new client request id cannot mint a second invoice for the same payment.
   */
  pendingSelectionFor(selection: PaymentSelection): StoredSelection | null {
    const target = jsonOf(selection, "selection");
    const rows = this.db.query(
      "SELECT * FROM payment_selections WHERE consumer_id=? AND provider_node_id=? ORDER BY created_at_ms DESC LIMIT 64",
    ).all(selection.consumerId, selection.providerNodeId) as SelectionRow[];
    for (const row of rows) {
      if (row.selection_json !== target) continue;
      const obligation = this.obligationRow(row.request_id);
      if (obligation) continue;
      return this.mapSelection(row);
    }
    return null;
  }

  saveProviderRequest(input: StoredProviderRequest): StoredProviderRequest {
    return this.tx(() => {
      const existing = this.providerRow(input.requestId);
      if (existing) {
        if (existing.invoice_id !== input.invoiceId || existing.terms_json !== jsonOf(input.terms, "terms")) {
          throw new Error("provider request idempotency conflict");
        }
        return this.mapProvider(existing);
      }
      this.db.query("INSERT INTO provider_payment_requests (request_id,invoice_id,consumer_node_id,consumer_fingerprint,chain_id,asset_id,amount_raw,selection_json,terms_json,digest,status,signature,payer_address,peer_status,error,idempotency,created_at_ms,updated_at_ms,expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.requestId, input.invoiceId, input.selection.consumerId, input.consumerFingerprint, input.selection.chainId, input.selection.asset.assetId, input.selection.amountRaw, jsonOf(input.selection, "selection"), jsonOf(input.terms, "terms"), input.digest, input.status, input.signature, input.payerAddress, input.peerStatus, input.error, input.idempotency, input.createdAtMs, input.updatedAtMs, input.expiresAtMs);
      return input;
    });
  }

  providerRequest(requestId: string): StoredProviderRequest | null {
    const row = this.providerRow(requestId);
    return row ? this.mapProvider(row) : null;
  }
  providerRequestByInvoice(invoiceId: string): StoredProviderRequest | null {
    const row = this.db.query("SELECT * FROM provider_payment_requests WHERE invoice_id = ?").get(invoiceId) as ProviderRow | null;
    return row ? this.mapProvider(row) : null;
  }

  /** An open request for the same consumer/network/asset/amount, for dedupe. */
  openProviderRequest(input: { consumerNodeId: string; chainId: number; assetId: string; amountRaw: string; nowMs: number }): StoredProviderRequest | null {
    const row = this.db.query(
      "SELECT * FROM provider_payment_requests WHERE consumer_node_id=? AND chain_id=? AND asset_id=? AND amount_raw=? AND status='waitingpayment' AND expires_at_ms>? ORDER BY created_at_ms DESC LIMIT 1",
    ).get(input.consumerNodeId, input.chainId, input.assetId, input.amountRaw, input.nowMs) as ProviderRow | null;
    return row ? this.mapProvider(row) : null;
  }

  updateProviderRequest(input: {
    requestId: string; status?: PaymentStatus; signature?: string | null; payerAddress?: string | null;
    peerStatus?: PaymentStatus | null; error?: string | null; nowMs: number;
  }): StoredProviderRequest {
    return this.tx(() => {
      const row = this.providerRow(input.requestId);
      if (!row) throw new Error("provider request not found");
      const status = input.status
        ? (row.status === "received" ? "received" : input.status === "actionneeded" || statusRank(input.status) >= statusRank(row.status) ? input.status : row.status)
        : row.status;
      const signature = input.signature === undefined ? row.signature : input.signature;
      const payer = input.payerAddress === undefined ? row.payer_address : input.payerAddress;
      if (row.signature && signature && row.signature !== signature) throw new Error("provider signature conflict");
      if (row.payer_address && payer && row.payer_address !== payer) throw new Error("provider payer conflict");
      this.db.query("UPDATE provider_payment_requests SET status=?,signature=?,payer_address=?,peer_status=?,error=?,updated_at_ms=? WHERE request_id=?")
        .run(status, signature, payer, input.peerStatus === undefined ? row.peer_status : input.peerStatus, input.error === undefined ? row.error : input.error, input.nowMs, input.requestId);
      return this.mapProvider(this.providerRow(input.requestId)!);
    });
  }

  saveObligation(input: StoredObligation): StoredObligation {
    return this.tx(() => {
      const existing = this.obligationRow(input.requestId);
      if (existing) {
        if (existing.invoice_id !== input.invoiceId || existing.terms_json !== jsonOf(input.terms, "terms")) {
          throw new Error("obligation idempotency conflict");
        }
        return this.mapObligation(existing);
      }
      this.db.query("INSERT INTO consumer_payment_obligations (request_id,invoice_id,provider_json,consumer_id,binding_json,terms_json,digest,signature,payer_address,status,peer_status,status_source,error,idempotency,created_at_ms,updated_at_ms,expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.requestId, input.invoiceId, jsonOf(input.provider, "provider"), input.consumerId, input.binding ? jsonOf(input.binding, "binding") : null, jsonOf(input.terms, "terms"), input.digest, input.signature, input.payerAddress, input.status, input.peerStatus, input.statusSource, input.error, input.idempotency, input.createdAtMs, input.updatedAtMs, input.expiresAtMs);
      return input;
    });
  }

  obligation(requestId: string): StoredObligation | null {
    const row = this.obligationRow(requestId);
    return row ? this.mapObligation(row) : null;
  }
  obligationByInvoice(invoiceId: string): StoredObligation | null {
    const row = this.db.query("SELECT * FROM consumer_payment_obligations WHERE invoice_id = ?").get(invoiceId) as ObligationRow | null;
    return row ? this.mapObligation(row) : null;
  }

  /** Bounded console list; never used for admission. */
  pendingObligations(limit = 50): StoredObligation[] {
    const rows = this.db.query(
      "SELECT * FROM consumer_payment_obligations WHERE status IN ('actionneeded','waitingpayment') ORDER BY updated_at_ms DESC LIMIT ?",
    ).all(limit) as ObligationRow[];
    return rows.map((row) => this.mapObligation(row));
  }

  /** Bounded console list of provider invoices still worth showing. */
  activeProviderRequests(limit = 50): StoredProviderRequest[] {
    const rows = this.db.query(
      "SELECT * FROM provider_payment_requests WHERE status IN ('waitingpayment','confirming','actionneeded') ORDER BY updated_at_ms DESC LIMIT ?",
    ).all(limit) as ProviderRow[];
    return rows.map((row) => this.mapProvider(row));
  }

  updateObligation(input: {
    requestId: string; status?: PaymentStatus; signature?: string | null; payerAddress?: string | null;
    binding?: PaymentBinding | null;
    peerStatus?: PaymentStatus | null; statusSource?: "local" | "peer"; error?: string | null; nowMs: number;
  }): StoredObligation {
    return this.tx(() => {
      const row = this.obligationRow(input.requestId);
      if (!row) throw new Error("obligation not found");
      const status = input.status
        ? (row.status === "received" ? "received" : input.status === "actionneeded" || statusRank(input.status) >= statusRank(row.status) ? input.status : row.status)
        : row.status;
      const signature = input.signature === undefined ? row.signature : input.signature;
      const payer = input.payerAddress === undefined ? row.payer_address : input.payerAddress;
      const bindingJson = input.binding === undefined ? row.binding_json : input.binding ? jsonOf(input.binding, "binding") : null;
      if (row.signature && signature && row.signature !== signature) throw new Error("obligation signature conflict");
      if (row.payer_address && payer && row.payer_address !== payer) throw new Error("obligation payer conflict");
      this.db.query("UPDATE consumer_payment_obligations SET status=?,signature=?,payer_address=?,binding_json=?,peer_status=?,status_source=?,error=?,updated_at_ms=? WHERE request_id=?")
        .run(status, signature, payer, bindingJson, input.peerStatus === undefined ? row.peer_status : input.peerStatus, input.statusSource ?? row.status_source, input.error === undefined ? row.error : input.error, input.nowMs, input.requestId);
      return this.mapObligation(this.obligationRow(input.requestId)!);
    });
  }

  message(peerNodeId: string, idempotency: string): StoredMessage | null {
    return this.db.query("SELECT * FROM payment_messages WHERE peer_node_id=? AND idempotency=?").get(peerNodeId, idempotency) as StoredMessage | null;
  }

  recordMessage(input: StoredMessage): StoredMessage {
    return this.tx(() => {
      // Prune first so a peer cannot grow this table without bound.
      this.db.query("DELETE FROM payment_messages WHERE at_ms < ?").run(input.atMs - MESSAGE_TTL_MS);
      const count = this.db.query("SELECT COUNT(*) AS n FROM payment_messages").get() as { n: number };
      if (Number(count.n) >= MAX_MESSAGES) {
        this.db.query(
          "DELETE FROM payment_messages WHERE rowid IN (SELECT rowid FROM payment_messages ORDER BY at_ms ASC LIMIT ?)",
        ).run(Number(count.n) - MAX_MESSAGES + 1);
      }
      const existing = this.message(input.peerNodeId, input.idempotency);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash || existing.requestId !== input.requestId || existing.kind !== input.kind) {
          throw new Error("message idempotency conflict");
        }
        return existing;
      }
      this.db.query("INSERT INTO payment_messages (peer_node_id,idempotency,request_id,kind,payload_hash,code,detail,at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(input.peerNodeId, input.idempotency, input.requestId, input.kind, input.payloadHash, input.code, input.detail, input.atMs);
      return input;
    });
  }

  private mapSelection(row: SelectionRow): StoredSelection {
    return { requestId: row.request_id, selection: parse(row.selection_json, "selection"), status: row.status, idempotency: row.idempotency, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms };
  }
  private mapProvider(row: ProviderRow): StoredProviderRequest {
    return {
      requestId: row.request_id, invoiceId: row.invoice_id, consumerFingerprint: row.consumer_fingerprint, selection: parse(row.selection_json, "selection"), terms: parse(row.terms_json, "terms"),
      digest: row.digest, status: row.status, signature: row.signature, payerAddress: row.payer_address, peerStatus: row.peer_status,
      error: row.error, idempotency: row.idempotency, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, expiresAtMs: row.expires_at_ms,
    };
  }
  private mapObligation(row: ObligationRow): StoredObligation {
    return {
      requestId: row.request_id, invoiceId: row.invoice_id, provider: parse(row.provider_json, "provider"), consumerId: row.consumer_id,
      binding: row.binding_json ? parse<PaymentBinding>(row.binding_json, "binding") : null, terms: parse(row.terms_json, "terms"), digest: row.digest,
      signature: row.signature, payerAddress: row.payer_address, status: row.status, peerStatus: row.peer_status,
      statusSource: row.status_source, error: row.error, idempotency: row.idempotency,
      createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, expiresAtMs: row.expires_at_ms,
    };
  }
}
