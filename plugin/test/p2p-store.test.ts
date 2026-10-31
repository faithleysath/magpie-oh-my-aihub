// Persistence invariants: uniqueness, retry bounds, recovery and no secrets.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_P2P_RETRY,
  P2pStore,
  nextAttemptAt,
  retryDelayMs,
  type P2pApprovalRow,
  type P2pOutboxRow,
} from "../src/p2p/store.ts";
import { P2pError } from "../src/p2p/protocol.ts";

const NOW = new Date("2026-10-31T12:00:00.000Z");
let store: P2pStore;
let dir: string;

function outbox(overrides: Partial<P2pOutboxRow> = {}): Omit<P2pOutboxRow, "attempts" | "updatedAt" | "lastError"> & { lastError?: string | null } {
  return {
    messageId: "1".repeat(32),
    sessionId: null,
    peerNodeId: "bbbb2222",
    peerFingerprint: "b".repeat(64),
    type: "approved",
    idempotency: "2".repeat(32),
    correlation: "3".repeat(32),
    payloadJson: JSON.stringify({ approvalId: "3".repeat(32) }),
    bodyHash: "4".repeat(64),
    state: "pending",
    nextAttemptAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function approval(overrides: Partial<P2pApprovalRow> = {}): P2pApprovalRow {
  return {
    approvalId: "5".repeat(32),
    requestHash: "6".repeat(64),
    generation: 1,
    providerNodeId: "bbbb2222",
    providerFingerprint: "b".repeat(64),
    consumerAccountId: "c".repeat(64),
    consumerNodeId: "aaaa1111",
    consumerFingerprint: "c".repeat(64),
    quoteHash: "a".repeat(64),
    priceVersion: "d".repeat(64),
    modelsJson: JSON.stringify(["alpha/x"]),
    capUsd: 2,
    memo: "memo",
    state: "approved",
    createdAt: NOW.toISOString(),
    approvedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    keyId: "key-1",
    keyName: "key-name",
    authorizationHash: null,
    deliveredAt: null,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p2p-store-"));
  store = new P2pStore(join(dir, "p2p.sqlite"));
});

describe("outbox", () => {
  test("(type, idempotency) is unique; a retry reads the first row", () => {
    const first = store.enqueueOutbox(outbox());
    expect(first.created).toBe(true);
    const again = store.enqueueOutbox(outbox({ messageId: "9".repeat(32) }));
    expect(again.created).toBe(false);
    expect(again.row.messageId).toBe("1".repeat(32));
    expect(again.row.bodyHash).toBe("4".repeat(64));

    const different = store.enqueueOutbox(outbox({ type: "ack", idempotency: "2".repeat(32), messageId: "8".repeat(32) }));
    expect(different.created).toBe(true);
  });

  test("retry backoff is exponential, capped and bounded", () => {
    expect(retryDelayMs(1)).toBe(DEFAULT_P2P_RETRY.baseMs);
    expect(retryDelayMs(2)).toBe(DEFAULT_P2P_RETRY.baseMs * 2);
    expect(retryDelayMs(99)).toBe(DEFAULT_P2P_RETRY.maxDelayMs);
    expect(nextAttemptAt(NOW, DEFAULT_P2P_RETRY.maxAttempts - 1).dead).toBe(false);
    expect(nextAttemptAt(NOW, DEFAULT_P2P_RETRY.maxAttempts).dead).toBe(true);

    store.enqueueOutbox(outbox());
    expect(store.markOutboxSending("1".repeat(32), NOW)).toBe(true);
    expect(store.getOutbox("1".repeat(32))?.attempts).toBe(1);
    const retried = store.markOutboxRetry("1".repeat(32), NOW, "transport down");
    expect(retried.dead).toBe(false);
    expect(retried.nextAttemptAt).toBe(new Date(NOW.getTime() + DEFAULT_P2P_RETRY.baseMs).toISOString());
    expect(store.getOutbox("1".repeat(32))?.lastError).toBe("transport down");

    for (let i = 1; i < DEFAULT_P2P_RETRY.maxAttempts; i++) {
      store.markOutboxSending("1".repeat(32), NOW);
      store.markOutboxRetry("1".repeat(32), NOW, `failure ${i}`);
    }
    expect(store.getOutbox("1".repeat(32))?.state).toBe("dead");
  });

  test("a dead retry can be re-armed only from a sent delivery", () => {
    store.enqueueOutbox(outbox({ type: "authorization_delivery", idempotency: "e".repeat(32) }));
    expect(store.rearmOutbox("1".repeat(32), NOW.toISOString(), NOW)).toBe(false);
    store.markOutboxSending("1".repeat(32), NOW);
    store.markOutboxSent("1".repeat(32), NOW);
    expect(store.rearmOutbox("1".repeat(32), NOW.toISOString(), NOW)).toBe(true);
    expect(store.getOutbox("1".repeat(32))?.state).toBe("pending");
  });

  test("no credential material can be persisted", () => {
    for (const payload of [
      JSON.stringify({ secret: "x" }),
      JSON.stringify({ authorization: { key: "x" } }),
      JSON.stringify({ note: "Bearer " + "a".repeat(32) }),
      JSON.stringify({ note: "sk-ohmy-" + "a".repeat(48) }),
      JSON.stringify({ nested: { privateKeyPem: "x" } }),
    ]) {
      expect(() => store.enqueueOutbox(outbox({ payloadJson: payload }))).toThrow(P2pError);
    }
  });
});

describe("approvals and generations", () => {
  test("one live approval per request, a new generation after a terminal state", () => {
    store.insertApproval(approval());
    expect(store.activeApprovalByRequest("6".repeat(64))?.generation).toBe(1);
    expect(store.nextGeneration("6".repeat(64))).toBe(2);
    expect(() => store.insertApproval(approval({ approvalId: "7".repeat(32), generation: 2 }))).toThrow(P2pError);

    expect(store.transitionApproval("5".repeat(32), ["approved"], "revoked")).toBe(true);
    expect(store.activeApprovalByRequest("6".repeat(64))).toBeNull();
    expect(() => store.insertApproval(approval({ approvalId: "7".repeat(32), generation: 2 }))).not.toThrow();
    expect(store.approvalByRequest("6".repeat(64))?.generation).toBe(2);
  });

  test("compare-and-set transitions lose cleanly", () => {
    store.insertApproval(approval());
    expect(store.transitionApproval("5".repeat(32), ["approving"], "approved")).toBe(false);
    expect(store.transitionApproval("5".repeat(32), ["approved"], "delivering", { priceVersion: "e".repeat(64) })).toBe(true);
    expect(store.getApproval("5".repeat(32))?.priceVersion).toBe("e".repeat(64));
    expect(store.transitionApproval("5".repeat(32), ["approved"], "revoked")).toBe(false);
  });

  test("a delivery cannot silently change its authorization", () => {
    store.prepareDelivery({ approvalId: "5".repeat(32), authorizationHash: "a".repeat(64), keyId: "key-1", keyName: "n", state: "delivering", preparedAt: NOW.toISOString(), deliveredAt: null, lastError: null });
    expect(() => store.prepareDelivery({ approvalId: "5".repeat(32), authorizationHash: "b".repeat(64), keyId: "key-1", keyName: "n", state: "delivering", preparedAt: NOW.toISOString(), deliveredAt: null, lastError: null })).toThrow(P2pError);
    expect(store.getDelivery("5".repeat(32))?.authorizationHash).toBe("a".repeat(64));
  });
});

describe("recovery", () => {
  test("boot expires sessions, requeues in-flight work and flags uncertain approvals", () => {
    store.createSession({
      sessionId: "1".repeat(32),
      role: "provider",
      peer: { accountId: "c".repeat(64), nodeId: "aaaa1111", fingerprint: "c".repeat(64) },
      transcriptHash: "d".repeat(64),
      catalogQuoteHash: null,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    });
    store.enqueueOutbox(outbox({ state: "sending" }));
    store.enqueueInbox({
      messageId: "2".repeat(32),
      idempotency: "3".repeat(32),
      type: "connection_request",
      fromAccountId: "c".repeat(64),
      fromNodeId: "aaaa1111",
      fromFingerprint: "c".repeat(64),
      correlation: null,
      bodyHash: "4".repeat(64),
      metaJson: JSON.stringify({}),
      nextAttemptAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      receivedAt: NOW.toISOString(),
    });
    store.markInboxProcessing("2".repeat(32));
    store.insertApproval(approval({ state: "approving" }));
    store.insertApproval(approval({ approvalId: "7".repeat(32), requestHash: "8".repeat(64), state: "delivering" }));
    store.putTombstone("authorization", "5".repeat(32), "revoked", new Date(NOW.getTime() - 60_000), 1);

    const report = store.recover(NOW);
    expect(report.sessionsExpired).toBe(1);
    expect(report.outboxRequeued).toBe(1);
    expect(report.inboxRequeued).toBe(1);
    expect(report.tombstonesPurged).toBe(1);
    expect(store.getSession("1".repeat(32))?.state).toBe("expired");
    expect(store.getOutbox("1".repeat(32))?.state).toBe("pending");
    expect(store.getInbox("2".repeat(32))?.state).toBe("pending");
    expect(store.getApproval("5".repeat(32))?.state).toBe("uncertain");
    expect(store.getApproval("7".repeat(32))?.state).toBe("delivering");
  });

  test("sessions expire by time and outbound sequence is contiguous", () => {
    store.createSession({
      sessionId: "1".repeat(32),
      role: "consumer",
      peer: { accountId: "b".repeat(64), nodeId: "bbbb2222", fingerprint: "b".repeat(64) },
      transcriptHash: "d".repeat(64),
      catalogQuoteHash: null,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 1_000).toISOString(),
    });
    store.bumpSeqOut("1".repeat(32), 1, NOW);
    expect(() => store.bumpSeqOut("1".repeat(32), 3, NOW)).toThrow(P2pError);
    expect(store.bumpSeqOut("1".repeat(32), 2, NOW)).toBeUndefined();
    expect(store.expireSessions(new Date(NOW.getTime() + 2_000))).toBe(1);
    expect(store.getSession("1".repeat(32))?.state).toBe("expired");
    expect(() => store.bumpSeqIn("1".repeat(32), 1, NOW)).toThrow(P2pError);
  });
});

describe("database hygiene", () => {
  test("the sqlite file contains no key, private key or mnemonic", () => {
    store.insertApproval(approval());
    store.prepareDelivery({ approvalId: "5".repeat(32), authorizationHash: "a".repeat(64), keyId: "key-1", keyName: "n", state: "delivered", preparedAt: NOW.toISOString(), deliveredAt: NOW.toISOString(), lastError: null });
    store.enqueueOutbox(outbox({ type: "authorization_delivery", idempotency: "f".repeat(32), payloadJson: JSON.stringify({ approvalId: "5".repeat(32) }) }));
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(join(dir, "p2p.sqlite")).toString("latin1");
    for (const marker of ["sk-ohmy-", "BEGIN PRIVATE KEY", "mnemonic", "seedPhrase"]) {
      expect(bytes.includes(marker)).toBe(false);
    }
    expect(bytes).toContain("authorization_delivery");
  });
});
