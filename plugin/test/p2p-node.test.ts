// End-to-end B1 flow on an in-process overlay: no sockets, no real EasyTier,
// no Magpie. This is a simulation of the protocol and state machine, not a
// two-host integration claim.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, loadOrCreateCatalogIdentity, sha256Hex } from "../src/catalog.ts";
import { P2pLab, KEY, KEY_ID } from "./support/p2p-lab.ts";
import { p2pIdentityFromCatalog, type P2pIdentity } from "../src/p2p/identity.ts";
import { P2pError, requestHashOf } from "../src/p2p/protocol.ts";
import { QUOTE_HASH, PRICE_VERSION } from "./support/p2p-lab.ts";

let lab: P2pLab | null = null;
afterEach(() => {
  lab?.close();
  lab = null;
});

async function ackFlow(l: P2pLab): Promise<{ approvalId: string }> {
  const { approval } = await l.deliver();
  await l.A.tick();
  return { approvalId: approval.approvalId };
}

describe("no-file request → approval → sealed delivery → ACK", () => {
  test("the full happy path registers before the ACK and never files a document", async () => {
    lab = P2pLab.create();
    const { approvalId } = await ackFlow(lab);
    expect(lab.calls.approve).toBe(1);
    expect(lab.calls.takeAuthorization).toBeGreaterThanOrEqual(2); // prepare + send
    expect(lab.calls.register).toBe(1);
    expect(lab.importedApprovals).toEqual([approvalId]);
    expect(lab.calls.recordApproval).toBe(1);
    expect(lab.calls.recordAck).toBe(1);

    const provider = await lab.B.approvalView(approvalId);
    expect(provider?.state).toBe("acked");
    expect(provider?.ackState).toBe("acked");
    expect(provider?.keyId).toBe(KEY_ID);
    const consumer = await lab.A.approvalView(approvalId);
    expect(consumer?.state).toBe("delivered");
    expect(consumer?.provider.nodeId).toBe("bbbb2222");
    expect(consumer?.provider.fingerprint).toBe(lab.identityB.peer.fingerprint);
    expect(lab.storeA.getDelivery(approvalId)?.state).toBe("delivered");
    // The provider stored the consumer identity, not a key.
    expect(lab.storeB.listPeers()[0]?.accepted).toBe(true);
  });

  test("the approved price version is the selected subset, not the request's full set", async () => {
    lab = P2pLab.create();
    const { approval } = await lab.deliver({ models: ["alpha/x"], capUsd: 2 });
    const selected = sha256Hex(canonicalJson({ selected: ["alpha/x"] })).slice(0, 64);
    expect(approval.priceVersion).toBe(selected);
    expect(approval.requestedPriceVersion).not.toBe(approval.priceVersion);
    const consumer = await lab.A.approvalView(approval.approvalId);
    expect(consumer?.priceVersion).toBe(selected);
    expect(consumer?.requestedPriceVersion).not.toBe(selected);
  });

  test("TOFU: an unknown consumer cannot be approved until the identity is accepted", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    const { requestHash } = await lab.sendRequest(sessionId);
    const request = (await lab.B.listRequests()).find((r) => r.requestHash === requestHash);
    expect(request?.trust).toBe("pending");
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2 })).rejects.toBeInstanceOf(P2pError);
    expect(lab.calls.approve).toBe(0);

    const approval = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true, memo: "first contact" });
    expect(approval.state).not.toBe("rejected");
    expect(approval.memo).toBe("first contact");
    expect(lab.calls.approve).toBe(1);
  });

  test("approval is idempotent for the same decision and refuses a different one", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    const { requestHash } = await lab.sendRequest(sessionId);
    const first = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true });
    const again = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2 });
    expect(again.approvalId).toBe(first.approvalId);
    expect(lab.calls.approve).toBe(1);
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 3 })).rejects.toBeInstanceOf(P2pError);
    expect(lab.calls.approve).toBe(1);
    expect(lab.storeB.listApprovals()).toHaveLength(1);
  });

  test("the ACK is idempotent and a resent delivery is not imported twice", async () => {
    lab = P2pLab.create();
    const { approval } = await lab.deliver();
    const approvalId = approval.approvalId;
    // No ACK yet: this is the "ACK lost" state, where a bounded resend is allowed.
    expect((await lab.B.approvalView(approvalId))?.ackState).toBe("pending");
    // Pretend the ACK was lost: the provider re-arms the same generation.
    const outbox = lab.storeB.outboxByIdempotency("authorization_delivery", expectedDeliveryIdempotency(approvalId));
    expect(outbox?.state).toBe("sent");
    lab.storeB.rearmOutbox(outbox!.messageId, lab.clock.now.toISOString(), lab.clock.now);
    lab.advance(10_000);
    await lab.B.tick();
    expect(lab.calls.register).toBe(1);
    expect(lab.calls.takeAuthorization).toBeGreaterThanOrEqual(3);
    await lab.A.tick();
    expect((await lab.B.approvalView(approvalId))?.ackState).toBe("acked");
  });
});

describe("revocation and failure handling", () => {
  test("revoke confirms the native key first and notifies the consumer with the provider identity", async () => {
    lab = P2pLab.create();
    const { approvalId } = await ackFlow(lab);
    await lab.B.revoke(approvalId, "operator-revoked");
    expect(lab.calls.revoke).toBe(1);
    expect(lab.calls.drop).toBe(1);
    const peer = (await lab.B.approvalView(approvalId))?.state;
    expect(peer).toBe("revoked");
    expect(lab.storeB.hasTombstone("authorization", approvalId)).toBe(true);
    expect(lab.storeA.getApproval(approvalId)?.state).toBe("revoked");
    const drop = lab.registeredSessions.at(-1);
    expect(drop?.providerNodeId).toBe("bbbb2222");
    expect(drop?.providerFingerprint).toBe(lab.identityB.peer.fingerprint);
  });

  test("an unconfirmed revoke marks uncertain and sends no notice", async () => {
    lab = P2pLab.create();
    lab.faults.revokeUnconfirmed = true;
    const { approvalId } = await ackFlow(lab);
    await expect(lab.B.revoke(approvalId, "key-rotated")).rejects.toBeInstanceOf(P2pError);
    const view = await lab.B.approvalView(approvalId);
    expect(view?.state).toBe("uncertain");
    expect(view?.actionNeeded).toBe("reconcile-before-retry");
    expect(lab.storeB.outboxByIdempotency("revoked", expectedRevokedIdempotency(approvalId))).toBeNull();
    expect((await lab.A.approvalView(approvalId))?.state).toBe("delivered");
  });

  test("a throwing revoke does not fake success either", async () => {
    lab = P2pLab.create();
    lab.faults.failRevoke = true;
    const { approvalId } = await ackFlow(lab);
    await expect(lab.B.revoke(approvalId, "operator-revoked")).rejects.toThrow(/did not confirm/);
    expect((await lab.B.approvalView(approvalId))?.state).toBe("uncertain");
    expect(lab.storeB.outboxByIdempotency("revoked", expectedRevokedIdempotency(approvalId))).toBeNull();
  });

  test("a second, different authorization for the same approval is refused", async () => {
    lab = P2pLab.create();
    const { approvalId } = await ackFlow(lab);
    const delivery = lab.storeA.getDelivery(approvalId);
    expect(delivery).not.toBeNull();
    // The store itself refuses to swap the prepared authorization.
    expect(() => lab!.storeA.prepareDelivery({ ...delivery!, authorizationHash: "0".repeat(64) })).toThrow(P2pError);
  });
});

describe("restart and recovery", () => {
  test("a restart expires sessions, keeps business state and re-delivers the same key once", async () => {
    lab = P2pLab.create();
    const { approval } = await lab.deliver();
    expect(lab.calls.register).toBe(1);
    const takeBefore = lab.calls.takeAuthorization;

    lab.crash();
    lab.advance(3 * 60_000);
    const tick = await lab.B.tick();
    expect(tick.sessionsExpired + (tick.recovered?.sessionsExpired ?? 0)).toBeGreaterThanOrEqual(1);

    await lab.A.openSession(lab.target());
    // Re-arm the same delivery generation (the ACK was never sent before restart).
    await lab.B.tick();
    lab.advance(10_000);
    await lab.B.tick();
    expect(lab.calls.register).toBe(1); // duplicate delivery: no second import
    expect(lab.calls.takeAuthorization).toBeGreaterThan(takeBefore);
    expect(lab.storeA.getDelivery(approval.approvalId)?.keyId).toBe(KEY_ID);

    await lab.A.tick();
    expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("acked");
  });

  test("old sessions are not resumable and a wrong session id is refused", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    expect(sessionId).toHaveLength(32);
    lab.advance(3 * 60_000);
    await lab.B.tick();
    // A fresh handshake still works; the old session row is expired.
    const again = await lab.establish();
    expect(again).not.toBe(sessionId);
    await expect(lab.B.handleFrame("0".repeat(32), Buffer.from("not-a-frame"))).rejects.toBeInstanceOf(P2pError);
  });
});

describe("TOFU key change", () => {
  test("a pending new fingerprint blocks the old key, is accepted explicitly, and kills old generations", async () => {
    lab = P2pLab.create();
    const { approval, requestHash, sessionId } = await lab.deliver();
    await lab.A.tick();
    expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("acked");

    const alien = alienIdentity();
    lab.storeB.recordPeerSeen(alien.peer, lab.clock.now);
    expect((await lab.B.listRequests()).find((r) => r.requestHash === requestHash)?.trust).toBe("changed");

    await expect(lab.B.acceptConsumer("aaaa1111", "0".repeat(64))).rejects.toBeInstanceOf(P2pError);
    const queued = lab.storeB.outboxByIdempotency("authorization_delivery", expectedDeliveryIdempotency(approval.approvalId))!;
    lab.storeB.rearmOutbox(queued.messageId, lab.clock.now.toISOString(), lab.clock.now);
    expect(lab.storeB.getOutbox(queued.messageId)?.state).toBe("pending");

    const invalidation = await lab.B.acceptConsumer("aaaa1111", alien.peer.fingerprint);
    expect(invalidation.accepted).toBe(alien.peer.fingerprint);
    expect(invalidation.revoked).toEqual([approval.approvalId]);
    expect(lab.calls.revoke).toBe(1);
    expect(lab.storeB.getOutbox(queued.messageId)?.state).toBe("dead");
    expect(lab.storeB.getPeer("aaaa1111")?.fingerprint).toBe(alien.peer.fingerprint);
    expect(lab.storeB.getPeer("aaaa1111")?.pendingJson).toBeNull();
    expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("revoked");
    expect(lab.storeB.hasTombstone("authorization", approval.approvalId)).toBe(true);
    expect(lab.storeB.getSession(sessionId)?.state).toBe("closed");

    // The old key cannot approve its old request any more.
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true })).rejects.toBeInstanceOf(P2pError);
  });

  test("if the native key cannot be revoked, the old generation is uncertain and recoverable, not locally revoked", async () => {
    lab = P2pLab.create();
    const { approval } = await lab.deliver(); // delivery registered, ACK not yet: no tombstone
    const alien = alienIdentity();
    lab.storeB.recordPeerSeen(alien.peer, lab.clock.now);

    lab.faults.revokeVoid = true;
    const invalidation = await lab.B.acceptConsumer("aaaa1111", alien.peer.fingerprint);
    expect(invalidation.revoked).toEqual([]);
    expect(invalidation.uncertain).toEqual([approval.approvalId]);
    expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("uncertain");
    expect(lab.storeB.getDelivery(approval.approvalId)?.state).not.toBe("revoked");
    expect(lab.storeB.hasTombstone("authorization", approval.approvalId)).toBe(false);
    expect(lab.storeB.getPeer("aaaa1111")?.fingerprint).toBe(alien.peer.fingerprint);

    // A later confirmed revoke of the same approval converges and tombstones.
    lab.faults.revokeVoid = false;
    await lab.B.revoke(approval.approvalId, "operator-revoked");
    expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("revoked");
    expect(lab.storeB.getDelivery(approval.approvalId)?.state).toBe("revoked");
    expect(lab.storeB.hasTombstone("authorization", approval.approvalId)).toBe(true);
  });

  test("a new identity cannot receive a key that belonged to the replaced identity", async () => {
    lab = P2pLab.create();
    const { approval } = await lab.deliver();
    await lab.A.tick();
    const alien = alienIdentity();
    lab.storeB.recordPeerSeen(alien.peer, lab.clock.now);
    await lab.B.acceptConsumer("aaaa1111", alien.peer.fingerprint);

    const request = lab.requestDocument({ models: ["beta/y"] });
    const requestHash = requestHashOf(request);
    lab.storeB.insertRequest({
      requestHash,
      sessionId: "9".repeat(32),
      consumerAccountId: alien.peer.accountId,
      consumerNodeId: "aaaa1111",
      consumerFingerprint: alien.peer.fingerprint,
      providerNodeId: "bbbb2222",
      providerFingerprint: lab.identityB.peer.fingerprint,
      quoteHash: QUOTE_HASH,
      priceVersion: PRICE_VERSION,
      modelsJson: JSON.stringify(request.models),
      eligibleJson: null,
      documentJson: JSON.stringify(request),
      state: "awaiting-approval",
      receivedAt: lab.clock.now.toISOString(),
      expiresAt: new Date(lab.clock.now.getTime() + 10 * 60_000).toISOString(),
      approvalId: null,
      note: null,
    });

    // The port still returns the old key id: the core must refuse to deliver it,
    // persist the returned key identity and keep the attempt revocable.
    await expect(lab.B.approve(requestHash, { models: ["beta/y"], capUsd: 2, acceptConsumer: true })).rejects.toBeInstanceOf(P2pError);
    const bad = (await lab.B.listApprovals()).find((a) => a.requestHash === requestHash && a.state === "uncertain")!;
    expect(bad.keyId).toBe(KEY_ID);
    await lab.B.revoke(bad.approvalId, "operator-revoked");
    expect((await lab.B.approvalView(bad.approvalId))?.state).toBe("revoked");

    lab.faults.approveKeyId = "key-new-0001";
    lab.faults.takeKey = "new-gateway-secret-0001";
    const fresh = await lab.B.approve(requestHash, { models: ["beta/y"], capUsd: 2, acceptConsumer: true });
    expect(fresh.keyId).toBe("key-new-0001");
    expect(fresh.generation).toBe(2);
    expect(fresh.approvalId).not.toBe(approval.approvalId);
  });
});

describe("uncertain revoke and generations", () => {
  test("an uncertain revoke can converge after a later confirmation and a new generation can be approved", async () => {
    lab = P2pLab.create();
    const { approval, requestHash } = await lab.deliver();
    await lab.A.tick();

    lab.faults.revokeUnconfirmed = true;
    await expect(lab.B.revoke(approval.approvalId, "key-rotated")).rejects.toBeInstanceOf(P2pError);
    expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("uncertain");
    expect(lab.storeB.outboxByIdempotency("revoked", expectedRevokedIdempotency(approval.approvalId))).toBeNull();

    lab.faults.revokeUnconfirmed = false;
    await lab.B.revoke(approval.approvalId, "key-rotated");
    expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("revoked");
    expect((await lab.B.listRequests()).find((r) => r.requestHash === requestHash)?.state).toBe("revoked");

    lab.faults.approveKeyId = "key-2";
    lab.faults.takeKey = "secret-two-0123456789";
    const generation2 = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true });
    expect(generation2.generation).toBe(2);
    expect(generation2.approvalId).not.toBe(approval.approvalId);
    expect(generation2.state).not.toBe("rejected");
    await lab.A.tick();
    expect(lab.calls.register).toBe(2);
    expect((await lab.B.approvalView(generation2.approvalId))?.ackState).toBe("acked");
  });
});

describe("revoke enforcement result", () => {
  const failures: Array<[string, (l: P2pLab) => void]> = [
    ["void", (l) => { l.faults.revokeVoid = true; }],
    ["typed false", (l) => { l.faults.revokeUnconfirmed = true; }],
    ["throw", (l) => { l.faults.failRevoke = true; }],
    ["wrong key id", (l) => { l.faults.revokeWrongKey = true; }],
    ["wrong generation", (l) => { l.faults.revokeWrongGeneration = true; }],
    ["capRestricted", (l) => { l.faults.revokeCapRestricted = true; }],
    ["revoked:true with a non-enforcing mode", (l) => { l.faults.revokeEnforcement = "safetyUncertain"; }],
  ];

  for (const [name, apply] of failures) {
    test(name + " is uncertain: no tombstone and no notice", async () => {
      lab = P2pLab.create();
      const { approval } = await lab.deliver(); // no ACK, so no ack tombstone
      apply(lab);
      await expect(lab.B.revoke(approval.approvalId, "operator-revoked")).rejects.toThrow();
      expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("uncertain");
      expect(lab.storeB.getDelivery(approval.approvalId)?.state).not.toBe("revoked");
      expect(lab.storeB.hasTombstone("authorization", approval.approvalId)).toBe(false);
      expect(lab.storeB.outboxByIdempotency("revoked", expectedRevokedIdempotency(approval.approvalId))).toBeNull();
    });
  }

  for (const mode of ["keyRevoked", "secretRotated"] as const) {
    test("typed " + mode + " is accepted: revoked + tombstone + notice", async () => {
      lab = P2pLab.create();
      const { approval } = await lab.deliver();
      lab.faults.revokeEnforcement = mode;
      await lab.B.revoke(approval.approvalId, "operator-revoked");
      expect((await lab.B.approvalView(approval.approvalId))?.state).toBe("revoked");
      expect(lab.storeB.getDelivery(approval.approvalId)?.state).toBe("revoked");
      expect(lab.storeB.hasTombstone("authorization", approval.approvalId)).toBe(true);
      expect(lab.storeB.outboxByIdempotency("revoked", expectedRevokedIdempotency(approval.approvalId))).not.toBeNull();
    });
  }
});

describe("interrupted approval attempts", () => {
  test("a thrown port.approve stays the only unresolved intent; unknown/restart never mints a second key", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    const { requestHash } = await lab.sendRequest(sessionId);
    lab.faults.failApprove = true;
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true })).rejects.toThrow();
    expect(lab.calls.approve).toBe(1);
    const first = (await lab.B.listApprovals())[0];
    expect(first.state).toBe("uncertain");
    expect(first.generation).toBe(1);

    lab.faults.failApprove = false;
    lab.faults.reconcileMode = "unknown";
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2 })).rejects.toBeInstanceOf(P2pError);
    expect(lab.calls.approve).toBe(1);
    expect((await lab.B.listApprovals()).length).toBe(1);

    lab.restart();
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2 })).rejects.toBeInstanceOf(P2pError);
    expect(lab.calls.approve).toBe(1);
    expect((await lab.B.listApprovals())[0]?.generation).toBe(1);
  });

  test("keyReady adopts the original key without calling port.approve again", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    const { requestHash } = await lab.sendRequest(sessionId);
    lab.faults.failApprove = true;
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true })).rejects.toThrow();
    lab.faults.failApprove = false;
    lab.faults.reconcileMode = "keyReady";
    const view = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2 });
    expect(lab.calls.approve).toBe(1);
    expect(lab.calls.reconcile).toBe(1);
    expect(view.generation).toBe(1);
    expect(view.keyId).toBe(KEY_ID);
    expect(view.state).not.toBe("uncertain");
  });

  test("noSideEffect retries the same approvalId and generation", async () => {
    lab = P2pLab.create();
    const sessionId = await lab.establish();
    const { requestHash } = await lab.sendRequest(sessionId);
    lab.faults.failApprove = true;
    await expect(lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true })).rejects.toThrow();
    lab.faults.failApprove = false;
    lab.faults.reconcileMode = "noSideEffect";
    const view = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2 });
    expect(lab.calls.approve).toBe(2);
    expect(lab.approveInputs[0]?.approvalId).toBe(lab.approveInputs[1]?.approvalId);
    expect(lab.approveInputs[0]?.generation).toBe(lab.approveInputs[1]?.generation);
    expect(lab.approveInputs[1]?.generation).toBe(1);
    expect((await lab.B.listApprovals()).filter((a) => a.requestHash === requestHash).length).toBe(1);
    expect(view.generation).toBe(1);
  });
});

describe("historic identity gate", () => {
  test("a new identity cannot approve while an old identity's key is uncertain, even after pending is cleared or a restart", async () => {
    lab = P2pLab.create();
    const { approval } = await lab.deliver();
    await lab.A.tick();
    const alien = alienIdentity();
    lab.storeB.recordPeerSeen(alien.peer, lab.clock.now);
    lab.faults.revokeVoid = true;
    const invalidation = await lab.B.acceptConsumer("aaaa1111", alien.peer.fingerprint);
    expect(invalidation.uncertain).toEqual([approval.approvalId]);
    expect(lab.storeB.getPeer("aaaa1111")?.pendingJson).toBeNull();
    expect(lab.storeB.getPeer("aaaa1111")?.fingerprint).toBe(alien.peer.fingerprint);

    const requestHash = insertAlienRequest(lab, alien, ["beta/y"]);
    const before = lab.calls.approve;
    await expect(lab.B.approve(requestHash, { models: ["beta/y"], capUsd: 2, acceptConsumer: true })).rejects.toBeInstanceOf(P2pError);
    expect(lab.calls.approve).toBe(before);

    lab.restart();
    await expect(lab.B.approve(requestHash, { models: ["beta/y"], capUsd: 2, acceptConsumer: true })).rejects.toBeInstanceOf(P2pError);
    expect(lab.calls.approve).toBe(before);

    // Only a typed, confirmed revocation of the old key unlocks the new identity.
    lab.faults.revokeVoid = false;
    lab.faults.approveKeyId = "key-new-0001";
    lab.faults.takeKey = "new-gateway-secret-0001";
    await lab.B.revoke(approval.approvalId, "operator-revoked");
    const view = await lab.B.approve(requestHash, { models: ["beta/y"], capUsd: 2, acceptConsumer: true });
    expect(view.state).not.toBe("rejected");
    expect(lab.calls.approve).toBe(before + 1);
  });
});

describe("pending identity rejection", () => {
  test("a pending key change can be explicitly rejected and the old accepted key stays", async () => {
    lab = P2pLab.create();
    await lab.deliver();
    await lab.A.tick();
    const alien = alienIdentity();
    lab.storeB.recordPeerSeen(alien.peer, lab.clock.now);
    expect(() => lab!.B.rejectConsumerIdentityChange("aaaa1111", "0".repeat(64))).toThrow(P2pError);
    lab.B.rejectConsumerIdentityChange("aaaa1111", alien.peer.fingerprint);
    const row = lab.storeB.getPeer("aaaa1111")!;
    expect(row.pendingJson).toBeNull();
    expect(row.fingerprint).toBe(lab.identityA.peer.fingerprint);
    expect(row.accepted).toBe(true);
    expect((await lab.B.listRequests())[0]?.trust).toBe("accepted");
  });

  test("an unauthenticated hello does not create a pending identity", async () => {
    lab = P2pLab.create();
    await expect(lab.B.acceptHello({ version: 1 })).rejects.toBeInstanceOf(P2pError);
    expect(lab.storeB.getPeer("aaaa1111")).toBeNull();
  });
});

describe("old Gateway Key reuse", () => {
  test("a new generation with a new key id but the old secret is refused before delivery", async () => {
    lab = P2pLab.create();
    const { approval, requestHash } = await lab.deliver();
    await lab.A.tick();
    lab.faults.revokeEnforcement = "keyRevoked";
    await lab.B.revoke(approval.approvalId, "operator-revoked");
    lab.faults.approveKeyId = "key-2";
    lab.faults.takeKey = KEY; // old secret under a new id
    const view = await lab.B.approve(requestHash, { models: ["alpha/x"], capUsd: 2, acceptConsumer: true });
    expect(view.state).toBe("uncertain");
    expect(lab.storeB.getDelivery(view.approvalId)).toBeNull();
    expect(lab.calls.register).toBe(1);
    expect(view.error ?? "").toContain("Gateway Key");
  });
});

describe("no secrets and no powerful imports", () => {

  test("both sqlite files are free of the gateway key", async () => {
    lab = P2pLab.create();
    await ackFlow(lab);
    lab.storeA.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    lab.storeB.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const file of [join(lab.dir, "a.sqlite"), join(lab.dir, "b.sqlite")]) {
      const bytes = readFileSync(file).toString("latin1");
      expect(bytes.includes(KEY)).toBe(false);
      expect(bytes.includes(KEY.slice(0, 24))).toBe(false);
      expect(bytes).toContain("p2p_");
    }
  });

  test("p2p/* never imports the ledger, wallet, provisioner, console or the Magpie admin", () => {
    const dir = join(import.meta.dir, "..", "src", "p2p");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const forbidden = [
      /from "\.\.\/ledger\.ts"/,
      /from "\.\.\/wallet\.ts"/,
      /from "\.\.\/provisioner\.ts"/,
      /from "\.\.\/console-/,
      /from "\.\.\/service\.ts"/,
      /from "\.\.\/magpie\.ts"/,
      /from "node:net"/,
      /from "node:http"/,
      /Bun\.serve/,
      /eth_send/,
      /signTransaction/,
      /child_process/,
    ];
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const re of forbidden) expect({ file, matches: re.test(text) }).toEqual({ file, matches: false });
    }
  });
});

function alienIdentity(): P2pIdentity {
  const dir = mkdtempSync(join(tmpdir(), "p2p-alien-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const id = loadOrCreateCatalogIdentity();
    return p2pIdentityFromCatalog(id, {
      nodeId: "aaaa1111",
      hostname: "ohmyaihub-aaaa1111",
      mappedCidr: "10.66.2.3/32",
      controlPort: 3428,
      gatewayPort: null,
      catalogQuoteHash: null,
    });
  } finally {
    process.chdir(cwd);
  }
}

function insertAlienRequest(lab: P2pLab, alien: P2pIdentity, models: string[]): string {
  const request = lab.requestDocument({ models });
  const requestHash = requestHashOf(request);
  lab.storeB.insertRequest({
    requestHash,
    sessionId: "9".repeat(32),
    consumerAccountId: alien.peer.accountId,
    consumerNodeId: "aaaa1111",
    consumerFingerprint: alien.peer.fingerprint,
    providerNodeId: "bbbb2222",
    providerFingerprint: lab.identityB.peer.fingerprint,
    quoteHash: QUOTE_HASH,
    priceVersion: PRICE_VERSION,
    modelsJson: JSON.stringify(request.models),
    eligibleJson: null,
    documentJson: JSON.stringify(request),
    state: "awaiting-approval",
    receivedAt: lab.clock.now.toISOString(),
    expiresAt: new Date(lab.clock.now.getTime() + 10 * 60_000).toISOString(),
    approvalId: null,
    note: null,
  });
  return requestHash;
}

function expectedDeliveryIdempotency(approvalId: string): string {
  return sha256Hex("p2p:delivery:" + approvalId).slice(0, 32);
}

function expectedRevokedIdempotency(approvalId: string): string {
  return sha256Hex("p2p:revoked:" + approvalId).slice(0, 32);
}
