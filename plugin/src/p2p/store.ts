// B1 persistence: one SQLite file next to `ledger.sqlite`, `chain.sqlite` and
// `catalog-trust.json`.
//
// Invariants this file is responsible for:
//
//  - **No Gateway Key** reaches disk. `assertNoSecretMaterial` runs on every
//    JSON value before it is written, and the authorization-delivery outbox row
//    stores metadata only; the sealed blob is regenerated from the approval
//    port when a retry is due.
//  - **Replay cannot become a second business action.** `p2p_messages` is keyed
//    by `(session, direction, seq)` and `(session, message_id)`; requests are
//    content-addressed by `request_hash`; approvals are unique per request;
//    deliveries are unique per approval. A duplicate envelope therefore reads
//    the first result instead of creating a second key.
//  - **Session keys never reach disk.** A session row stores only identities,
//    the transcript hash, sequence numbers and state. After a restart every open
//    session becomes `expired` and the peer re-handshakes.
//  - **Idempotency keys cannot be reused with different content.** The outbox
//    and inbox have `UNIQUE(type, idempotency)` and the caller must compare the
//    body hash before treating a row as a retry.
//
// A crash can leave a row in `sending`/`processing`; `recover()` moves it back
// to `pending` and the same envelope (same id, same idempotency key) is retried.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprintOf } from "../catalog.ts";
import { statePath } from "../paths.ts";
import {
  assertNoSecretMaterial,
  fail,
  P2P_MAX_TTL_MS,
  type P2pMessageType,
  type P2pPeerIdentity,
  type P2pTargetIdentity,
} from "./protocol.ts";

export type P2pSessionState = "open" | "closed" | "expired";
export type P2pRequestState = "requested" | "received" | "awaiting-trust" | "awaiting-approval" | "approved" | "rejected" | "expired" | "revoked";
export type P2pApprovalState = "approving" | "approved" | "rejected" | "delivering" | "delivered" | "acked" | "revoked" | "expired" | "uncertain";
export type P2pDeliveryState = "preparing" | "delivering" | "delivered" | "acked" | "superseded" | "revoked" | "uncertain";
export type P2pOutboxState = "pending" | "sending" | "sent" | "dead";
export type P2pInboxState = "pending" | "processing" | "done" | "failed" | "dead";

export interface P2pRetryPolicy {
  baseMs: number;
  factor: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_P2P_RETRY: P2pRetryPolicy = Object.freeze({
  baseMs: 5_000,
  factor: 2,
  maxDelayMs: 300_000,
  maxAttempts: 8,
});

/** Exponential backoff with a cap; attempt 1 is the first retry, not the send. */
export function retryDelayMs(attempts: number, policy: P2pRetryPolicy = DEFAULT_P2P_RETRY): number {
  const n = Math.max(1, Math.trunc(attempts));
  return Math.min(policy.maxDelayMs, policy.baseMs * policy.factor ** (n - 1));
}

export function nextAttemptAt(now: Date, attempts: number, policy: P2pRetryPolicy = DEFAULT_P2P_RETRY): { at: string; dead: boolean } {
  if (attempts >= policy.maxAttempts) return { at: now.toISOString(), dead: true };
  return { at: new Date(now.getTime() + retryDelayMs(attempts, policy)).toISOString(), dead: false };
}

export interface P2pPeerTrustRow {
  nodeId: string;
  accountId: string;
  fingerprint: string;
  publicKey: string;
  hostname: string;
  accepted: boolean;
  /** a different key seen for this node; blocks business until a human decides */
  pendingJson: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface P2pSessionRow {
  sessionId: string;
  role: "consumer" | "provider";
  state: P2pSessionState;
  peerAccountId: string;
  peerNodeId: string;
  peerFingerprint: string;
  transcriptHash: string;
  catalogQuoteHash: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastSeqIn: number;
  lastSeqOut: number;
  error: string | null;
}

export interface P2pMessageRow {
  sessionId: string;
  direction: "in" | "out";
  seq: number;
  msgId: string;
  type: P2pMessageType;
  frameHash: string;
  bodyHash: string;
  resultCode: string | null;
  resultJson: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface P2pRequestRow {
  requestHash: string;
  sessionId: string;
  consumerAccountId: string;
  consumerNodeId: string;
  consumerFingerprint: string;
  providerNodeId: string;
  providerFingerprint: string;
  quoteHash: string;
  priceVersion: string;
  modelsJson: string;
  /** models the provider's validator says are eligible; null until validated */
  eligibleJson: string | null;
  documentJson: string;
  state: P2pRequestState;
  receivedAt: string;
  expiresAt: string;
  approvalId: string | null;
  note: string | null;
}

export interface P2pApprovalRow {
  approvalId: string;
  requestHash: string;
  /** incremented per re-approval after a revocation; the delivery generation */
  generation: number;
  /** the provider that issued this approval (local identity on the provider side) */
  providerNodeId: string | null;
  providerFingerprint: string | null;
  consumerAccountId: string;
  consumerNodeId: string;
  consumerFingerprint: string;
  quoteHash: string;
  priceVersion: string;
  modelsJson: string;
  capUsd: number;
  /** local-only operator memo; never sent on the wire */
  memo: string | null;
  state: P2pApprovalState;
  createdAt: string;
  approvedAt: string | null;
  expiresAt: string;
  keyId: string | null;
  keyName: string | null;
  authorizationHash: string | null;
  deliveredAt: string | null;
  error: string | null;
}

export interface P2pDeliveryRow {
  approvalId: string;
  authorizationHash: string;
  keyId: string;
  keyName: string;
  /** SHA-256 of the actual Gateway Key received from the port; never the key */
  keyHash: string | null;
  state: P2pDeliveryState;
  preparedAt: string;
  deliveredAt: string | null;
  lastError: string | null;
}

export interface P2pOutboxRow {
  messageId: string;
  sessionId: string | null;
  peerNodeId: string;
  peerFingerprint: string;
  type: P2pMessageType;
  idempotency: string;
  correlation: string | null;
  /** non-sensitive business inputs used to rebuild the envelope on retry */
  payloadJson: string | null;
  bodyHash: string;
  state: P2pOutboxState;
  attempts: number;
  nextAttemptAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface P2pInboxRow {
  messageId: string;
  idempotency: string;
  type: P2pMessageType;
  fromAccountId: string;
  fromNodeId: string;
  fromFingerprint: string;
  correlation: string | null;
  bodyHash: string;
  metaJson: string;
  state: P2pInboxState;
  attempts: number;
  nextAttemptAt: string;
  expiresAt: string;
  receivedAt: string;
  processedAt: string | null;
  resultCode: string | null;
  resultJson: string | null;
  lastError: string | null;
}

export interface P2pRecoveryReport {
  sessionsExpired: number;
  outboxRequeued: number;
  inboxRequeued: number;
  tombstonesPurged: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS p2p_peer_trust (
  node_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  public_key TEXT NOT NULL,
  hostname TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  pending_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS p2p_sessions (
  session_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  peer_account_id TEXT NOT NULL,
  peer_node_id TEXT NOT NULL,
  peer_fingerprint TEXT NOT NULL,
  transcript_hash TEXT NOT NULL,
  catalog_quote_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seq_in INTEGER NOT NULL DEFAULT 0,
  last_seq_out INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS p2p_sessions_transcript ON p2p_sessions(transcript_hash);

CREATE TABLE IF NOT EXISTS p2p_messages (
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  seq INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  type TEXT NOT NULL,
  frame_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  result_code TEXT,
  result_json TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (session_id, direction, seq),
  UNIQUE (session_id, msg_id)
);

CREATE TABLE IF NOT EXISTS p2p_tombstones (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS p2p_requests (
  request_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  consumer_account_id TEXT NOT NULL,
  consumer_node_id TEXT NOT NULL,
  consumer_fingerprint TEXT NOT NULL,
  provider_node_id TEXT NOT NULL,
  provider_fingerprint TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  price_version TEXT NOT NULL,
  models_json TEXT NOT NULL,
  eligible_json TEXT,
  document_json TEXT NOT NULL,
  state TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approval_id TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS p2p_approvals (
  approval_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  provider_node_id TEXT,
  provider_fingerprint TEXT,
  consumer_account_id TEXT NOT NULL,
  consumer_node_id TEXT NOT NULL,
  consumer_fingerprint TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  price_version TEXT NOT NULL,
  models_json TEXT NOT NULL,
  cap_usd REAL NOT NULL,
  memo TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  expires_at TEXT NOT NULL,
  key_id TEXT,
  key_name TEXT,
  authorization_hash TEXT,
  delivered_at TEXT,
  error TEXT,
  UNIQUE (request_hash, generation)
);
-- At most one live approval per request; a revoked/expired generation does not
-- block the consumer from asking again.
CREATE UNIQUE INDEX IF NOT EXISTS p2p_approvals_active ON p2p_approvals(request_hash)
  WHERE state IN ('approving','approved','delivering','delivered','acked');

CREATE TABLE IF NOT EXISTS p2p_deliveries (
  approval_id TEXT PRIMARY KEY,
  authorization_hash TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  key_hash TEXT,
  state TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS p2p_outbox (
  message_id TEXT PRIMARY KEY,
  session_id TEXT,
  peer_node_id TEXT NOT NULL,
  peer_fingerprint TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency TEXT NOT NULL,
  correlation TEXT,
  payload_json TEXT,
  body_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS p2p_outbox_idempotency ON p2p_outbox(type, idempotency);

CREATE TABLE IF NOT EXISTS p2p_inbox (
  message_id TEXT PRIMARY KEY,
  idempotency TEXT NOT NULL,
  type TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  from_fingerprint TEXT NOT NULL,
  correlation TEXT,
  body_hash TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  result_code TEXT,
  result_json TEXT,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS p2p_inbox_idempotency ON p2p_inbox(type, idempotency);
`;

/** Row → typed object helpers keep SQLite's unknown types out of the callers. */
function boolOf(value: unknown): boolean {
  return Number(value) === 1;
}
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sessionRow(raw: Record<string, unknown>): P2pSessionRow {
  return {
    sessionId: String(raw.session_id),
    role: raw.role === "consumer" ? "consumer" : "provider",
    state: raw.state as P2pSessionState,
    peerAccountId: String(raw.peer_account_id),
    peerNodeId: String(raw.peer_node_id),
    peerFingerprint: String(raw.peer_fingerprint),
    transcriptHash: String(raw.transcript_hash),
    catalogQuoteHash: raw.catalog_quote_hash === null ? null : String(raw.catalog_quote_hash),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
    expiresAt: String(raw.expires_at),
    lastSeqIn: numberOr(raw.last_seq_in, 0),
    lastSeqOut: numberOr(raw.last_seq_out, 0),
    error: raw.error === null ? null : String(raw.error),
  };
}

function messageRow(raw: Record<string, unknown>): P2pMessageRow {
  return {
    sessionId: String(raw.session_id),
    direction: raw.direction === "out" ? "out" : "in",
    seq: numberOr(raw.seq, 0),
    msgId: String(raw.msg_id),
    type: raw.type as P2pMessageType,
    frameHash: String(raw.frame_hash),
    bodyHash: String(raw.body_hash),
    resultCode: raw.result_code === null ? null : String(raw.result_code),
    resultJson: raw.result_json === null ? null : String(raw.result_json),
    receivedAt: String(raw.received_at),
    processedAt: raw.processed_at === null ? null : String(raw.processed_at),
  };
}

export class P2pStore {
  readonly db: Database;
  readonly path: string;
  private retry: P2pRetryPolicy;
  private closed = false;

  constructor(path = statePath("p2p.sqlite"), retry: P2pRetryPolicy = DEFAULT_P2P_RETRY) {
    this.path = path;
    this.retry = retry;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* a busy checkpoint is not a reason to keep the handle */
    }
    this.db.close();
  }

  // --- trust -----------------------------------------------------------------

  getPeer(nodeId: string): P2pPeerTrustRow | null {
    const raw = this.db.query("SELECT * FROM p2p_peer_trust WHERE node_id = ?").get(nodeId) as Record<string, unknown> | null;
    if (!raw) return null;
    return {
      nodeId: String(raw.node_id),
      accountId: String(raw.account_id),
      fingerprint: String(raw.fingerprint),
      publicKey: String(raw.public_key),
      hostname: String(raw.hostname),
      accepted: boolOf(raw.accepted),
      pendingJson: raw.pending_json === null ? null : String(raw.pending_json),
      firstSeenAt: String(raw.first_seen_at),
      lastSeenAt: String(raw.last_seen_at),
      revokedAt: raw.revoked_at === null ? null : String(raw.revoked_at),
    };
  }

  /**
   * Records that a peer was seen. The *accepted* key never changes here: a new
   * fingerprint becomes a pending change that a human must resolve, exactly like
   * the Catalogue TOFU. Re-seeing the accepted key only updates `lastSeen`.
   */
  recordPeerSeen(peer: P2pPeerIdentity, now: Date): P2pPeerTrustRow {
    const at = now.toISOString();
    const existing = this.getPeer(peer.nodeId);
    if (!existing) {
      this.db
        .query(
          "INSERT INTO p2p_peer_trust (node_id, account_id, fingerprint, public_key, hostname, accepted, pending_json, first_seen_at, last_seen_at, revoked_at) VALUES (?,?,?,?,?,0,NULL,?,?,NULL)",
        )
        .run(peer.nodeId, peer.accountId, peer.fingerprint, peer.publicKey, peer.hostname, at, at);
      return this.getPeer(peer.nodeId)!;
    }
    if (existing.fingerprint === peer.fingerprint) {
      this.db.query("UPDATE p2p_peer_trust SET account_id = ?, hostname = ?, last_seen_at = ? WHERE node_id = ?").run(peer.accountId, peer.hostname, at, peer.nodeId);
    } else {
      const pending = JSON.stringify({ accountId: peer.accountId, fingerprint: peer.fingerprint, publicKey: peer.publicKey, hostname: peer.hostname, seenAt: at });
      assertNoSecretMaterial(JSON.parse(pending), "peer trust pending");
      this.db.query("UPDATE p2p_peer_trust SET pending_json = ?, last_seen_at = ? WHERE node_id = ?").run(pending, at, peer.nodeId);
    }
    return this.getPeer(peer.nodeId)!;
  }

  /** A human explicitly accepted this exact key for this node. */
  acceptPeer(peer: P2pPeerIdentity, now: Date): P2pPeerTrustRow {
    const row = this.getPeer(peer.nodeId);
    if (row?.pendingJson) {
      let pendingFingerprint: string | null = null;
      try {
        pendingFingerprint = (JSON.parse(row.pendingJson) as { fingerprint?: string }).fingerprint ?? null;
      } catch {
        pendingFingerprint = "unreadable";
      }
      // Clearing a pending change by passing the old row is exactly how a key
      // swap used to be lost. Only an explicit fingerprint may do it.
      if (pendingFingerprint !== peer.fingerprint) {
        fail("stale_identity", "a pending identity change must be accepted with acceptPendingPeer and its fingerprint");
      }
    }
    this.storeAcceptPeer(peer, now);
    return this.getPeer(peer.nodeId)!;
  }

  /**
   * Explicitly accepts the changed key a human has just reviewed. The caller
   * must name the exact pending fingerprint; a changed/unknown pending row is
   * refused, so a silent key swap is impossible.
   */
  acceptPendingPeer(nodeId: string, expectedFingerprint: string, now: Date): P2pPeerTrustRow {
    const row = this.getPeer(nodeId);
    if (!row) fail("not_found", "this peer has never been seen");
    if (!row.pendingJson) fail("conflict", "this peer has no pending identity change");
    let pending: { accountId?: unknown; fingerprint?: unknown; publicKey?: unknown; hostname?: unknown };
    try {
      pending = JSON.parse(row.pendingJson) as typeof pending;
    } catch {
      return fail("conflict", "the pending identity record is unreadable");
    }
    if (typeof pending.fingerprint !== "string" || pending.fingerprint !== expectedFingerprint) {
      fail("stale_identity", "the pending fingerprint changed; review it again");
    }
    if (typeof pending.accountId !== "string" || pending.accountId !== pending.fingerprint) fail("conflict", "the pending account id is inconsistent");
    if (typeof pending.publicKey !== "string" || fingerprintOf(pending.publicKey) !== pending.fingerprint) {
      fail("conflict", "the pending key does not match its fingerprint");
    }
    if (typeof pending.hostname !== "string") fail("conflict", "the pending hostname is missing");
    this.storeAcceptPeer({ accountId: pending.accountId, nodeId, hostname: pending.hostname, publicKey: pending.publicKey, fingerprint: pending.fingerprint }, now);
    return this.getPeer(nodeId)!;
  }

  private storeAcceptPeer(peer: P2pPeerIdentity, now: Date): void {
    const at = now.toISOString();
    this.db
      .query(
        `INSERT INTO p2p_peer_trust (node_id, account_id, fingerprint, public_key, hostname, accepted, pending_json, first_seen_at, last_seen_at, revoked_at)
         VALUES (?,?,?,?,?,1,NULL,?,?,NULL)
         ON CONFLICT(node_id) DO UPDATE SET account_id=excluded.account_id, fingerprint=excluded.fingerprint,
           public_key=excluded.public_key, hostname=excluded.hostname, accepted=1, pending_json=NULL,
           last_seen_at=excluded.last_seen_at, revoked_at=NULL`,
      )
      .run(peer.nodeId, peer.accountId, peer.fingerprint, peer.publicKey, peer.hostname, at, at);
  }

  /**
   * Explicitly rejects the pending key change and keeps the previously accepted
   * identity. This is the human "no" to a changed fingerprint; nothing is
   * auto-accepted and the old key is not silently replaced.
   */
  rejectPendingPeer(nodeId: string, expectedFingerprint: string, now: Date): P2pPeerTrustRow {
    const row = this.getPeer(nodeId);
    if (!row) fail("not_found", "this peer has never been seen");
    if (!row.pendingJson) fail("conflict", "this peer has no pending identity change");
    let pendingFingerprint: string | null = null;
    try {
      pendingFingerprint = (JSON.parse(row.pendingJson) as { fingerprint?: string }).fingerprint ?? null;
    } catch {
      pendingFingerprint = "unreadable";
    }
    if (pendingFingerprint !== expectedFingerprint) fail("stale_identity", "the pending fingerprint changed; review it again");
    this.db.query("UPDATE p2p_peer_trust SET pending_json = NULL, last_seen_at = ? WHERE node_id = ?").run(now.toISOString(), nodeId);
    return this.getPeer(nodeId)!;
  }

  /** Prior deliveries of the same Gateway Key (by hash) for another approval. */
  keyHashSeenElsewhere(consumerNodeId: string, keyHash: string, approvalId: string): Array<{ approvalId: string; generation: number; consumerFingerprint: string }> {
    const rows = this.db
      .query(
        `SELECT d.approval_id, a.generation, a.consumer_fingerprint
         FROM p2p_deliveries d JOIN p2p_approvals a ON a.approval_id = d.approval_id
         WHERE a.consumer_node_id = ? AND d.key_hash = ? AND d.approval_id != ?`,
      )
      .all(consumerNodeId, keyHash, approvalId) as Array<{ approval_id: string; generation: number; consumer_fingerprint: string }>;
    return rows.map((raw) => ({ approvalId: String(raw.approval_id), generation: numberOr(raw.generation, 1), consumerFingerprint: String(raw.consumer_fingerprint) }));
  }

  revokePeer(nodeId: string, now: Date): void {
    this.db.query("UPDATE p2p_peer_trust SET accepted = 0, revoked_at = ? WHERE node_id = ?").run(now.toISOString(), nodeId);
  }


  listPeers(): P2pPeerTrustRow[] {
    const rows = this.db.query("SELECT * FROM p2p_peer_trust ORDER BY last_seen_at DESC").all() as Record<string, unknown>[];
    return rows.map((raw) => ({
      nodeId: String(raw.node_id),
      accountId: String(raw.account_id),
      fingerprint: String(raw.fingerprint),
      publicKey: String(raw.public_key),
      hostname: String(raw.hostname),
      accepted: boolOf(raw.accepted),
      pendingJson: raw.pending_json === null ? null : String(raw.pending_json),
      firstSeenAt: String(raw.first_seen_at),
      lastSeenAt: String(raw.last_seen_at),
      revokedAt: raw.revoked_at === null ? null : String(raw.revoked_at),
    }));
  }

  // --- sessions --------------------------------------------------------------

  createSession(input: {
    sessionId: string;
    role: "consumer" | "provider";
    peer: P2pTargetIdentity & { accountId: string };
    transcriptHash: string;
    catalogQuoteHash: string | null;
    now: Date;
    expiresAt: string;
  }): P2pSessionRow {
    const at = input.now.toISOString();
    try {
      this.db
        .query(
          `INSERT INTO p2p_sessions (session_id, role, state, peer_account_id, peer_node_id, peer_fingerprint, transcript_hash, catalog_quote_hash, created_at, updated_at, expires_at, last_seq_in, last_seq_out, error)
           VALUES (?,?,'open',?,?,?,?,?,?,?,?,0,0,NULL)`,
        )
        .run(
          input.sessionId,
          input.role,
          input.peer.accountId,
          input.peer.nodeId,
          input.peer.fingerprint,
          input.transcriptHash,
          input.catalogQuoteHash,
          at,
          at,
          input.expiresAt,
        );
    } catch (e) {
      if (/UNIQUE|PRIMARY/i.test(String(e))) fail("replay", "this handshake transcript was already used");
      throw e;
    }
    return this.getSession(input.sessionId)!;
  }

  getSession(sessionId: string): P2pSessionRow | null {
    const raw = this.db.query("SELECT * FROM p2p_sessions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | null;
    return raw ? sessionRow(raw) : null;
  }

  bumpSeqOut(sessionId: string, seq: number, now: Date): void {
    const res = this.db
      .query("UPDATE p2p_sessions SET last_seq_out = ?, updated_at = ? WHERE session_id = ? AND state = 'open' AND last_seq_out = ?")
      .run(seq, now.toISOString(), sessionId, seq - 1);
    if (res.changes !== 1) fail("session_closed", "the session is not open or the outbound sequence moved");
  }

  bumpSeqIn(sessionId: string, seq: number, now: Date): void {
    const res = this.db
      .query("UPDATE p2p_sessions SET last_seq_in = ?, updated_at = ? WHERE session_id = ? AND state = 'open' AND last_seq_in = ?")
      .run(seq, now.toISOString(), sessionId, seq - 1);
    if (res.changes !== 1) fail("replay", "the inbound sequence is not contiguous");
  }

  closeSession(sessionId: string, reason: string, now: Date, state: P2pSessionState = "closed"): void {
    this.db.query("UPDATE p2p_sessions SET state = ?, error = ?, updated_at = ? WHERE session_id = ?").run(state, reason.slice(0, 200), now.toISOString(), sessionId);
  }

  expireSessions(now: Date): number {
    return this.db.query("UPDATE p2p_sessions SET state = 'expired', updated_at = ? WHERE state = 'open' AND expires_at <= ?").run(now.toISOString(), now.toISOString()).changes;
  }

  // --- messages --------------------------------------------------------------

  recordInbound(input: {
    sessionId: string;
    seq: number;
    msgId: string;
    type: P2pMessageType;
    frameHash: string;
    bodyHash: string;
    at: string;
    resultCode?: string | null;
    resultJson?: string | null;
  }): void {
    if (input.resultJson) assertNoSecretMaterial(JSON.parse(input.resultJson), "inbound result");
    this.db
      .query(
        "INSERT INTO p2p_messages (session_id, direction, seq, msg_id, type, frame_hash, body_hash, result_code, result_json, received_at, processed_at) VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.sessionId,
        input.seq,
        input.msgId,
        input.type,
        input.frameHash,
        input.bodyHash,
        input.resultCode ?? null,
        input.resultJson ?? null,
        input.at,
        input.resultCode ? input.at : null,
      );
  }

  recordOutbound(input: { sessionId: string; seq: number; msgId: string; type: P2pMessageType; frameHash: string; bodyHash: string; at: string }): void {
    this.db
      .query(
        "INSERT INTO p2p_messages (session_id, direction, seq, msg_id, type, frame_hash, body_hash, result_code, result_json, received_at, processed_at) VALUES (?, 'out', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
      )
      .run(input.sessionId, input.seq, input.msgId, input.type, input.frameHash, input.bodyHash, input.at, input.at);
  }

  inboundBySeq(sessionId: string, seq: number): P2pMessageRow | null {
    const raw = this.db.query("SELECT * FROM p2p_messages WHERE session_id = ? AND direction = 'in' AND seq = ?").get(sessionId, seq) as Record<string, unknown> | null;
    return raw ? messageRow(raw) : null;
  }

  inboundByMsgId(sessionId: string, msgId: string): P2pMessageRow | null {
    const raw = this.db.query("SELECT * FROM p2p_messages WHERE session_id = ? AND msg_id = ?").get(sessionId, msgId) as Record<string, unknown> | null;
    return raw ? messageRow(raw) : null;
  }

  finishInbound(sessionId: string, seq: number, resultCode: string, resultJson: string | null, now: Date): void {
    if (resultJson) assertNoSecretMaterial(JSON.parse(resultJson), "inbound result");
    this.db.query("UPDATE p2p_messages SET result_code = ?, result_json = ?, processed_at = ? WHERE session_id = ? AND direction = 'in' AND seq = ?").run(resultCode, resultJson, now.toISOString(), sessionId, seq);
  }

  // --- tombstones ------------------------------------------------------------

  putTombstone(scope: string, key: string, reason: string, now: Date, ttlMs = P2P_MAX_TTL_MS): void {
    this.db
      .query("INSERT OR REPLACE INTO p2p_tombstones (scope, key, reason, created_at, expires_at) VALUES (?,?,?,?,?)")
      .run(scope, key, reason.slice(0, 200), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
  }

  hasTombstone(scope: string, key: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM p2p_tombstones WHERE scope = ? AND key = ?").get(scope, key));
  }

  tombstone(scope: string, key: string): { reason: string; createdAt: string; expiresAt: string } | null {
    const raw = this.db.query("SELECT * FROM p2p_tombstones WHERE scope = ? AND key = ?").get(scope, key) as Record<string, unknown> | null;
    if (!raw) return null;
    return { reason: String(raw.reason), createdAt: String(raw.created_at), expiresAt: String(raw.expires_at) };
  }

  purgeTombstones(now: Date): number {
    return this.db.query("DELETE FROM p2p_tombstones WHERE expires_at <= ?").run(now.toISOString()).changes;
  }

  // --- requests --------------------------------------------------------------

  insertRequest(row: P2pRequestRow): { row: P2pRequestRow; created: boolean } {
    assertNoSecretMaterial(JSON.parse(row.documentJson), "request document");
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO p2p_requests (request_hash, session_id, consumer_account_id, consumer_node_id, consumer_fingerprint, provider_node_id, provider_fingerprint, quote_hash, price_version, models_json, eligible_json, document_json, state, received_at, expires_at, approval_id, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.requestHash,
        row.sessionId,
        row.consumerAccountId,
        row.consumerNodeId,
        row.consumerFingerprint,
        row.providerNodeId,
        row.providerFingerprint,
        row.quoteHash,
        row.priceVersion,
        row.modelsJson,
        row.eligibleJson,
        row.documentJson,
        row.state,
        row.receivedAt,
        row.expiresAt,
        row.approvalId,
        row.note,
      );
    return { row: this.getRequest(row.requestHash)!, created: res.changes === 1 };
  }

  getRequest(requestHash: string): P2pRequestRow | null {
    const raw = this.db.query("SELECT * FROM p2p_requests WHERE request_hash = ?").get(requestHash) as Record<string, unknown> | null;
    if (!raw) return null;
    return {
      requestHash: String(raw.request_hash),
      sessionId: String(raw.session_id),
      consumerAccountId: String(raw.consumer_account_id),
      consumerNodeId: String(raw.consumer_node_id),
      consumerFingerprint: String(raw.consumer_fingerprint),
      providerNodeId: String(raw.provider_node_id),
      providerFingerprint: String(raw.provider_fingerprint),
      quoteHash: String(raw.quote_hash),
      priceVersion: String(raw.price_version),
      modelsJson: String(raw.models_json),
      eligibleJson: raw.eligible_json === null || raw.eligible_json === undefined ? null : String(raw.eligible_json),
      documentJson: String(raw.document_json),
      state: raw.state as P2pRequestState,
      receivedAt: String(raw.received_at),
      expiresAt: String(raw.expires_at),
      approvalId: raw.approval_id === null ? null : String(raw.approval_id),
      note: raw.note === null ? null : String(raw.note),
    };
  }

  setRequestState(requestHash: string, state: P2pRequestState, now: Date, patch: { approvalId?: string | null; note?: string | null; eligibleJson?: string | null } = {}): boolean {
    if (patch.eligibleJson) assertNoSecretMaterial(JSON.parse(patch.eligibleJson), "request eligible models");
    const res = this.db
      .query("UPDATE p2p_requests SET state = ?, approval_id = COALESCE(?, approval_id), note = COALESCE(?, note), eligible_json = COALESCE(?, eligible_json) WHERE request_hash = ? AND state != ?")
      .run(state, patch.approvalId ?? null, patch.note ?? null, patch.eligibleJson ?? null, requestHash, state);
    return res.changes === 1;
  }

  // --- approvals -------------------------------------------------------------

  insertApproval(row: P2pApprovalRow): void {
    try {
      this.db
        .query(
          `INSERT INTO p2p_approvals (approval_id, request_hash, generation, provider_node_id, provider_fingerprint, consumer_account_id, consumer_node_id, consumer_fingerprint, quote_hash, price_version, models_json, cap_usd, memo, state, created_at, approved_at, expires_at, key_id, key_name, authorization_hash, delivered_at, error)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.approvalId,
          row.requestHash,
          row.generation,
          row.providerNodeId,
          row.providerFingerprint,
          row.consumerAccountId,
          row.consumerNodeId,
          row.consumerFingerprint,
          row.quoteHash,
          row.priceVersion,
          row.modelsJson,
          row.capUsd,
          row.memo,
          row.state,
          row.createdAt,
          row.approvedAt,
          row.expiresAt,
          row.keyId,
          row.keyName,
          row.authorizationHash,
          row.deliveredAt,
          row.error,
        );
    } catch (e) {
      if (/UNIQUE|PRIMARY/i.test(String(e))) fail("conflict", "this request already has a live approval");
      throw e;
    }
  }

  /** The next generation for a request; re-approval only after a terminal state. */
  nextGeneration(requestHash: string): number {
    const raw = this.db.query("SELECT MAX(generation) AS g FROM p2p_approvals WHERE request_hash = ?").get(requestHash) as { g: number | null } | null;
    return numberOr(raw?.g, 0) + 1;
  }

  getApproval(approvalId: string): P2pApprovalRow | null {
    const raw = this.db.query("SELECT * FROM p2p_approvals WHERE approval_id = ?").get(approvalId) as Record<string, unknown> | null;
    return raw ? approvalRow(raw) : null;
  }

  approvalByRequest(requestHash: string): P2pApprovalRow | null {
    const raw = this.db.query("SELECT * FROM p2p_approvals WHERE request_hash = ? ORDER BY generation DESC LIMIT 1").get(requestHash) as Record<string, unknown> | null;
    return raw ? approvalRow(raw) : null;
  }

  /** The approval that currently owns the request (the active generation). */
  activeApprovalByRequest(requestHash: string): P2pApprovalRow | null {
    const raw = this.db
      .query("SELECT * FROM p2p_approvals WHERE request_hash = ? AND state IN ('approving','approved','delivering','delivered','acked') ORDER BY generation DESC LIMIT 1")
      .get(requestHash) as Record<string, unknown> | null;
    return raw ? approvalRow(raw) : null;
  }

  listApprovals(consumerNodeId?: string): P2pApprovalRow[] {
    const rows = (
      consumerNodeId
        ? this.db.query("SELECT * FROM p2p_approvals WHERE consumer_node_id = ? ORDER BY created_at DESC").all(consumerNodeId)
        : this.db.query("SELECT * FROM p2p_approvals ORDER BY created_at DESC").all()
    ) as Record<string, unknown>[];
    return rows.map(approvalRow);
  }

  /** Compare-and-set on state; a concurrent revoke/approve loses cleanly. */
  transitionApproval(approvalId: string, from: readonly P2pApprovalState[], to: P2pApprovalState, patch: Partial<Pick<P2pApprovalRow, "approvedAt" | "keyId" | "keyName" | "authorizationHash" | "deliveredAt" | "error" | "expiresAt" | "priceVersion">> = {}): boolean {
    const placeholders = from.map(() => "?").join(",");
    const res = this.db
      .query(
        `UPDATE p2p_approvals SET state = ?, approved_at = COALESCE(?, approved_at), key_id = COALESCE(?, key_id), key_name = COALESCE(?, key_name),
           authorization_hash = COALESCE(?, authorization_hash), delivered_at = COALESCE(?, delivered_at), error = COALESCE(?, error), expires_at = COALESCE(?, expires_at), price_version = COALESCE(?, price_version)
         WHERE approval_id = ? AND state IN (${placeholders})`,
      )
      .run(to, patch.approvedAt ?? null, patch.keyId ?? null, patch.keyName ?? null, patch.authorizationHash ?? null, patch.deliveredAt ?? null, patch.error ?? null, patch.expiresAt ?? null, patch.priceVersion ?? null, approvalId, ...from);
    return res.changes === 1;
  }

  // --- deliveries ------------------------------------------------------------

  prepareDelivery(row: P2pDeliveryRow): boolean {
    const res = this.db
      .query(
        `INSERT INTO p2p_deliveries (approval_id, authorization_hash, key_id, key_name, key_hash, state, prepared_at, delivered_at, last_error)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(approval_id) DO UPDATE SET state = excluded.state, last_error = excluded.last_error,
           delivered_at = COALESCE(excluded.delivered_at, p2p_deliveries.delivered_at)
         WHERE p2p_deliveries.authorization_hash = excluded.authorization_hash AND p2p_deliveries.key_id = excluded.key_id`,
      )
      .run(row.approvalId, row.authorizationHash, row.keyId, row.keyName, row.keyHash, row.state, row.preparedAt, row.deliveredAt, row.lastError);
    if (res.changes === 0) {
      const current = this.getDelivery(row.approvalId);
      if (current && (current.authorizationHash !== row.authorizationHash || current.keyId !== row.keyId)) {
        fail("conflict", "this approval already has a different prepared authorization");
      }
    }
    return res.changes === 1;
  }

  getDelivery(approvalId: string): P2pDeliveryRow | null {
    const raw = this.db.query("SELECT * FROM p2p_deliveries WHERE approval_id = ?").get(approvalId) as Record<string, unknown> | null;
    if (!raw) return null;
    return {
      approvalId: String(raw.approval_id),
      authorizationHash: String(raw.authorization_hash),
      keyId: String(raw.key_id),
      keyName: String(raw.key_name),
      keyHash: raw.key_hash === null || raw.key_hash === undefined ? null : String(raw.key_hash),
      state: raw.state as P2pDeliveryState,
      preparedAt: String(raw.prepared_at),
      deliveredAt: raw.delivered_at === null ? null : String(raw.delivered_at),
      lastError: raw.last_error === null ? null : String(raw.last_error),
    };
  }

  setDeliveryState(approvalId: string, state: P2pDeliveryState, now: Date, error: string | null = null): boolean {
    const res = this.db
      .query("UPDATE p2p_deliveries SET state = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, last_error = ? WHERE approval_id = ?")
      .run(state, state, now.toISOString(), error, approvalId);
    return res.changes === 1;
  }

  // --- outbox ----------------------------------------------------------------

  enqueueOutbox(row: Omit<P2pOutboxRow, "attempts" | "updatedAt" | "lastError"> & { lastError?: string | null }): { row: P2pOutboxRow; created: boolean } {
    if (row.payloadJson !== null) assertNoSecretMaterial(JSON.parse(row.payloadJson), "outbox payload");
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO p2p_outbox (message_id, session_id, peer_node_id, peer_fingerprint, type, idempotency, correlation, payload_json, body_hash, state, attempts, next_attempt_at, expires_at, created_at, updated_at, last_error)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,NULL)`,
      )
      .run(
        row.messageId,
        row.sessionId,
        row.peerNodeId,
        row.peerFingerprint,
        row.type,
        row.idempotency,
        row.correlation,
        row.payloadJson,
        row.bodyHash,
        row.state,
        row.nextAttemptAt,
        row.expiresAt,
        row.createdAt,
        row.createdAt,
      );
    if (res.changes !== 1) {
      const existing = this.outboxByIdempotency(row.type, row.idempotency);
      if (!existing) fail("conflict", "the outbox insert was ignored without an existing row");
      return { row: existing, created: false };
    }
    return { row: this.getOutbox(row.messageId)!, created: true };
  }

  getOutbox(messageId: string): P2pOutboxRow | null {
    const raw = this.db.query("SELECT * FROM p2p_outbox WHERE message_id = ?").get(messageId) as Record<string, unknown> | null;
    return raw ? outboxRow(raw) : null;
  }

  outboxByIdempotency(type: P2pMessageType, idempotency: string): P2pOutboxRow | null {
    const raw = this.db.query("SELECT * FROM p2p_outbox WHERE type = ? AND idempotency = ?").get(type, idempotency) as Record<string, unknown> | null;
    return raw ? outboxRow(raw) : null;
  }

  dueOutbox(now: Date, limit = 20): P2pOutboxRow[] {
    const rows = this.db
      .query("SELECT * FROM p2p_outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?")
      .all(now.toISOString(), limit) as Record<string, unknown>[];
    return rows.map(outboxRow);
  }

  markOutboxSending(messageId: string, now: Date): boolean {
    return this.db.query("UPDATE p2p_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE message_id = ? AND state = 'pending'").run(now.toISOString(), messageId).changes === 1;
  }

  markOutboxSent(messageId: string, now: Date): void {
    this.db.query("UPDATE p2p_outbox SET state = 'sent', updated_at = ?, last_error = NULL WHERE message_id = ?").run(now.toISOString(), messageId);
  }

  markOutboxRetry(messageId: string, now: Date, error: string, policy: P2pRetryPolicy = this.retry): { dead: boolean; nextAttemptAt: string } {
    const row = this.getOutbox(messageId);
    if (!row) fail("not_found", "the outbox message no longer exists");
    const attempts = row.attempts;
    const next = nextAttemptAt(now, attempts, policy);
    this.db
      .query("UPDATE p2p_outbox SET state = ?, next_attempt_at = ?, updated_at = ?, last_error = ? WHERE message_id = ?")
      .run(next.dead ? "dead" : "pending", next.at, now.toISOString(), error.slice(0, 300), messageId);
    return { dead: next.dead, nextAttemptAt: next.at };
  }

  /** Re-arms a sent delivery whose ACK never arrived (same authorization). */
  rearmOutbox(messageId: string, nextAttemptAt: string, now: Date): boolean {
    return this.db.query("UPDATE p2p_outbox SET state = 'pending', next_attempt_at = ?, updated_at = ? WHERE message_id = ? AND state = 'sent'").run(nextAttemptAt, now.toISOString(), messageId).changes === 1;
  }

  /** Stops queued messages that would announce a revoked approval/generation. */
  cancelOutboxForApproval(approvalId: string, now: Date): number {
    return this.db
      .query("UPDATE p2p_outbox SET state = 'dead', updated_at = ?, last_error = 'approval revoked' WHERE correlation = ? AND state IN ('pending','sending')")
      .run(now.toISOString(), approvalId).changes;
  }

  outboxPendingCount(): number {
    const raw = this.db.query("SELECT COUNT(*) AS n FROM p2p_outbox WHERE state IN ('pending','sending')").get() as { n: number };
    return numberOr(raw?.n, 0);
  }

  // --- inbox -----------------------------------------------------------------

  enqueueInbox(row: Omit<P2pInboxRow, "attempts" | "state" | "processedAt" | "resultCode" | "resultJson" | "lastError">): { row: P2pInboxRow; created: boolean } {
    assertNoSecretMaterial(JSON.parse(row.metaJson), "inbox metadata");
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO p2p_inbox (message_id, idempotency, type, from_account_id, from_node_id, from_fingerprint, correlation, body_hash, meta_json, state, attempts, next_attempt_at, expires_at, received_at, processed_at, result_code, result_json)
         VALUES (?,?,?,?,?,?,?,?,?, 'pending', 0, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        row.messageId,
        row.idempotency,
        row.type,
        row.fromAccountId,
        row.fromNodeId,
        row.fromFingerprint,
        row.correlation,
        row.bodyHash,
        row.metaJson,
        row.nextAttemptAt,
        row.expiresAt,
        row.receivedAt,
      );
    if (res.changes !== 1) {
      const existing = this.inboxByIdempotency(row.type, row.idempotency);
      if (!existing) fail("conflict", "the inbox insert was ignored without an existing row");
      return { row: existing, created: false };
    }
    return { row: this.getInbox(row.messageId)!, created: true };
  }

  getInbox(messageId: string): P2pInboxRow | null {
    const raw = this.db.query("SELECT * FROM p2p_inbox WHERE message_id = ?").get(messageId) as Record<string, unknown> | null;
    return raw ? inboxRow(raw) : null;
  }

  inboxByIdempotency(type: P2pMessageType, idempotency: string): P2pInboxRow | null {
    const raw = this.db.query("SELECT * FROM p2p_inbox WHERE type = ? AND idempotency = ?").get(type, idempotency) as Record<string, unknown> | null;
    return raw ? inboxRow(raw) : null;
  }

  dueInbox(now: Date, limit = 20): P2pInboxRow[] {
    const rows = this.db
      .query("SELECT * FROM p2p_inbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?")
      .all(now.toISOString(), limit) as Record<string, unknown>[];
    return rows.map(inboxRow);
  }

  markInboxProcessing(messageId: string): boolean {
    return this.db.query("UPDATE p2p_inbox SET state = 'processing', attempts = attempts + 1 WHERE message_id = ? AND state = 'pending'").run(messageId).changes === 1;
  }

  finishInbox(messageId: string, resultCode: string, resultJson: string | null, now: Date): void {
    if (resultJson) assertNoSecretMaterial(JSON.parse(resultJson), "inbox result");
    this.db.query("UPDATE p2p_inbox SET state = 'done', result_code = ?, result_json = ?, processed_at = ? WHERE message_id = ?").run(resultCode, resultJson, now.toISOString(), messageId);
  }

  /** A retryable port failure: drop the row so a bounded peer retry can run. */
  abandonInbox(messageId: string): void {
    this.db.query("DELETE FROM p2p_inbox WHERE message_id = ?").run(messageId);
  }

  markInboxRetry(messageId: string, now: Date, error: string, policy: P2pRetryPolicy = this.retry): { dead: boolean; nextAttemptAt: string } {
    const row = this.getInbox(messageId);
    if (!row) fail("not_found", "the inbox message no longer exists");
    const next = nextAttemptAt(now, row.attempts, policy);
    this.db
      .query("UPDATE p2p_inbox SET state = ?, next_attempt_at = ?, last_error = ? WHERE message_id = ?")
      .run(next.dead ? "dead" : "pending", next.at, error.slice(0, 300), messageId);
    return { dead: next.dead, nextAttemptAt: next.at };
  }

  // --- recovery --------------------------------------------------------------

  /**
   * Called once when the service starts. Open sessions lose their keys with the
   * process, so they are expired rather than resumed; in-flight outbox/inbox
   * rows are retried with their original id and idempotency key.
   */
  recover(now: Date): P2pRecoveryReport {
    const sessionsExpired = this.db.query("UPDATE p2p_sessions SET state = 'expired', updated_at = ?, error = COALESCE(error, 'host restart') WHERE state = 'open'").run(now.toISOString()).changes;
    const outboxRequeued = this.db.query("UPDATE p2p_outbox SET state = 'pending', next_attempt_at = ?, updated_at = ? WHERE state = 'sending'").run(now.toISOString(), now.toISOString()).changes;
    const inboxRequeued = this.db.query("UPDATE p2p_inbox SET state = 'pending', next_attempt_at = ? WHERE state = 'processing'").run(now.toISOString()).changes;
    const tombstonesPurged = this.purgeTombstones(now);
    // A key creation that was interrupted is uncertain and needs a human: it may
    // or may not exist in Magpie, and re-approving could create a second key.
    // A delivery that was already bound to an authorization generation may keep
    // retrying that same generation; it never reissues a key.
    this.db.query("UPDATE p2p_approvals SET state = 'uncertain', error = COALESCE(error, 'host restart during approval') WHERE state = 'approving'").run();
    this.db.query("UPDATE p2p_deliveries SET state = 'uncertain', last_error = COALESCE(last_error, 'host restart while preparing delivery') WHERE state = 'preparing'").run();
    return { sessionsExpired, outboxRequeued, inboxRequeued, tombstonesPurged };
  }
}

function approvalRow(raw: Record<string, unknown>): P2pApprovalRow {
  return {
    approvalId: String(raw.approval_id),
    requestHash: String(raw.request_hash),
    generation: numberOr(raw.generation, 1),
    providerNodeId: raw.provider_node_id === null || raw.provider_node_id === undefined ? null : String(raw.provider_node_id),
    providerFingerprint: raw.provider_fingerprint === null || raw.provider_fingerprint === undefined ? null : String(raw.provider_fingerprint),
    consumerAccountId: String(raw.consumer_account_id),
    consumerNodeId: String(raw.consumer_node_id),
    consumerFingerprint: String(raw.consumer_fingerprint),
    quoteHash: String(raw.quote_hash),
    priceVersion: String(raw.price_version),
    modelsJson: String(raw.models_json),
    capUsd: numberOr(raw.cap_usd, 0),
    memo: raw.memo === null ? null : String(raw.memo),
    state: raw.state as P2pApprovalState,
    createdAt: String(raw.created_at),
    approvedAt: raw.approved_at === null ? null : String(raw.approved_at),
    expiresAt: String(raw.expires_at),
    keyId: raw.key_id === null ? null : String(raw.key_id),
    keyName: raw.key_name === null ? null : String(raw.key_name),
    authorizationHash: raw.authorization_hash === null ? null : String(raw.authorization_hash),
    deliveredAt: raw.delivered_at === null ? null : String(raw.delivered_at),
    error: raw.error === null ? null : String(raw.error),
  };
}

function outboxRow(raw: Record<string, unknown>): P2pOutboxRow {
  return {
    messageId: String(raw.message_id),
    sessionId: raw.session_id === null ? null : String(raw.session_id),
    peerNodeId: String(raw.peer_node_id),
    peerFingerprint: String(raw.peer_fingerprint),
    type: raw.type as P2pMessageType,
    idempotency: String(raw.idempotency),
    correlation: raw.correlation === null ? null : String(raw.correlation),
    payloadJson: raw.payload_json === null ? null : String(raw.payload_json),
    bodyHash: String(raw.body_hash),
    state: raw.state as P2pOutboxState,
    attempts: numberOr(raw.attempts, 0),
    nextAttemptAt: String(raw.next_attempt_at),
    expiresAt: String(raw.expires_at),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
    lastError: raw.last_error === null ? null : String(raw.last_error),
  };
}

function inboxRow(raw: Record<string, unknown>): P2pInboxRow {
  return {
    messageId: String(raw.message_id),
    idempotency: String(raw.idempotency),
    type: raw.type as P2pMessageType,
    fromAccountId: String(raw.from_account_id),
    fromNodeId: String(raw.from_node_id),
    fromFingerprint: String(raw.from_fingerprint),
    correlation: raw.correlation === null ? null : String(raw.correlation),
    bodyHash: String(raw.body_hash),
    metaJson: String(raw.meta_json),
    state: raw.state as P2pInboxState,
    attempts: numberOr(raw.attempts, 0),
    nextAttemptAt: String(raw.next_attempt_at),
    expiresAt: String(raw.expires_at),
    receivedAt: String(raw.received_at),
    processedAt: raw.processed_at === null ? null : String(raw.processed_at),
    resultCode: raw.result_code === null ? null : String(raw.result_code),
    resultJson: raw.result_json === null ? null : String(raw.result_json),
    lastError: raw.last_error === null || raw.last_error === undefined ? null : String(raw.last_error),
  };
}
