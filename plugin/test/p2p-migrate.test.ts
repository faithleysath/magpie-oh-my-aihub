// Additive migration of a p2p.sqlite written by an earlier B-core build.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2pStore } from "../src/p2p/store.ts";

const NOW = "2026-10-31T12:00:00.000Z";
const APPROVAL = "a".repeat(32);
const REQUEST = "b".repeat(64);

describe("p2p.sqlite migration", () => {
  test("an older approvals/deliveries schema gains the new columns without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "p2p-migrate-"));
    const file = join(dir, "legacy.sqlite");
    const raw = new Database(file, { create: true });
    raw.exec(`
      CREATE TABLE p2p_approvals (
        approval_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
        consumer_account_id TEXT NOT NULL, consumer_node_id TEXT NOT NULL,
        consumer_fingerprint TEXT NOT NULL, quote_hash TEXT NOT NULL,
        price_version TEXT NOT NULL, models_json TEXT NOT NULL, cap_usd REAL NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT,
        expires_at TEXT NOT NULL, key_id TEXT, key_name TEXT,
        authorization_hash TEXT, delivered_at TEXT, error TEXT
      );
      CREATE TABLE p2p_deliveries (
        approval_id TEXT PRIMARY KEY, authorization_hash TEXT NOT NULL,
        key_id TEXT NOT NULL, key_name TEXT NOT NULL, state TEXT NOT NULL,
        prepared_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT
      );
      CREATE TABLE p2p_requests (
        request_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        consumer_account_id TEXT NOT NULL, consumer_node_id TEXT NOT NULL,
        consumer_fingerprint TEXT NOT NULL, provider_node_id TEXT NOT NULL,
        provider_fingerprint TEXT NOT NULL, quote_hash TEXT NOT NULL,
        price_version TEXT NOT NULL, models_json TEXT NOT NULL,
        document_json TEXT NOT NULL, state TEXT NOT NULL, received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, approval_id TEXT, note TEXT
      );
      CREATE TABLE p2p_outbox (
        message_id TEXT PRIMARY KEY, session_id TEXT, peer_node_id TEXT NOT NULL,
        peer_fingerprint TEXT NOT NULL, type TEXT NOT NULL, idempotency TEXT NOT NULL,
        correlation TEXT, envelope_json TEXT, body_hash TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE p2p_inbox (
        message_id TEXT PRIMARY KEY, idempotency TEXT NOT NULL, type TEXT NOT NULL,
        from_account_id TEXT NOT NULL, from_node_id TEXT NOT NULL,
        from_fingerprint TEXT NOT NULL, correlation TEXT, body_hash TEXT NOT NULL,
        meta_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL, expires_at TEXT NOT NULL, received_at TEXT NOT NULL,
        processed_at TEXT, result_code TEXT, result_json TEXT
      );
      INSERT INTO p2p_approvals (
        approval_id, request_hash, consumer_account_id, consumer_node_id,
        consumer_fingerprint, quote_hash, price_version, models_json, cap_usd,
        state, created_at, approved_at, expires_at, key_id, key_name,
        authorization_hash, delivered_at, error
      ) VALUES (
        '${APPROVAL}', '${REQUEST}', '${"c".repeat(64)}', 'aaaa1111',
        '${"d".repeat(64)}', '${"e".repeat(64)}', '${"f".repeat(64)}', '["alpha/x"]', 2,
        'revoked', '${NOW}', '${NOW}', '${NOW}', 'key-old', 'old-name',
        '${"1".repeat(64)}', '${NOW}', NULL
      );
    `);
    raw.close();

    const migrated = new P2pStore(file);
    const approvalCols = (migrated.db.query("PRAGMA table_info(p2p_approvals)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(approvalCols).toEqual(expect.arrayContaining(["generation", "provider_node_id", "provider_fingerprint", "enforced_at", "enforcement", "enforced_key_id"]));
    const deliveryCols = (migrated.db.query("PRAGMA table_info(p2p_deliveries)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(deliveryCols).toContain("key_hash");
    const requestCols = (migrated.db.query("PRAGMA table_info(p2p_requests)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(requestCols).toContain("eligible_json");

    const legacy = migrated.getApproval(APPROVAL)!;
    expect(legacy.state).toBe("revoked");
    expect(legacy.enforcedAt).toBeNull();
    expect(legacy.generation).toBe(1);
    expect(legacy.keyId).toBe("key-old");
    migrated.close();

    // Reopening the same file is idempotent (restart path).
    const again = new P2pStore(file);
    expect(again.getApproval(APPROVAL)?.state).toBe("revoked");
    const version = again.db.query("SELECT value FROM p2p_meta WHERE key = 'schema_version'").get() as { value: string };
    expect(version.value).toBe("2");
    again.close();
  });
});
