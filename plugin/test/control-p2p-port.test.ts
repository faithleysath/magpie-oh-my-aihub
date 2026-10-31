import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { catalogPriceVersion, priceSnapshot } from "../src/pricing.ts";
import { statePath } from "../src/paths.ts";
import { Service } from "../src/service.ts";
import { FakeMagpie, LAB_MODEL, LAB_PRICE } from "./support/fake-magpie.ts";
import { ControlServiceRefusal } from "../src/control/service-port.ts";
import {
  controlAuthorizationForConsumer,
  controlRemotes,
  createP2pBusinessPort,
  lookupControlApproval,
  providerIdFor,
  type P2pAuthorizationDocument,
  type P2pInboundApproval,
  type P2pPeerIdentity,
} from "../src/control/p2p-port.ts";

const NODE = "d".repeat(16);
const PROVIDER = "e".repeat(16);
const FP = "f".repeat(64);
const HASH = "b".repeat(64);
const APPROVAL = "c".repeat(32);
const APPROVAL2 = "d".repeat(32);
const models = [{ id: LAB_MODEL, pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }];
const quoteModels = [models[0]!, { id: "lab/other", pricing: models[0]!.pricing }];

const previousMagpieAddr = process.env.MAGPIE_ADDR;
beforeEach(() => {
  process.env.MAGPIE_ADDR = "127.0.0.1:3425";
  process.chdir(mkdtempSync(join(tmpdir(), "control-p2p-port-")));
});
afterAll(() => {
  if (previousMagpieAddr === undefined) delete process.env.MAGPIE_ADDR;
  else process.env.MAGPIE_ADDR = previousMagpieAddr;
});

function context() {
  return {
    provider: { nodeId: NODE, mappedCidr: "10.66.1.2/32", gatewayPort: 3425 },
    quote: { contentHash: HASH, identity: { fingerprint: FP }, models: structuredClone(quoteModels) },
  };
}

function requestDocument() {
  const version = catalogPriceVersion(quoteModels)!;
  return {
    consumer: { nodeId: "alice", hostname: "ohmyaihub-alice" },
    provider: { nodeId: NODE, hostname: `ohmyaihub-${NODE}`, mappedCidr: "10.66.1.2/32", gatewayPort: 3425, catalogPort: 3426 },
    models: quoteModels.map((m) => m.id),
    quote: { contentHash: HASH, priceVersion: version, identityFingerprint: FP, priceLocked: false as const },
    acceptance: { fingerprint: FP, quoteHash: HASH, priceVersion: version },
  };
}

function singleRequest(consumer: { nodeId: string; hostname: string }) {
  const doc = requestDocument();
  doc.consumer = consumer;
  doc.models = [LAB_MODEL];
  const version = catalogPriceVersion([models[0]!])!;
  doc.quote.priceVersion = version;
  doc.acceptance.priceVersion = version;
  return doc;
}

function realService() {
  const magpie = new FakeMagpie();
  (magpie as any).providersReadable = () => true;
  const metas = quoteModels.map((m) => ({
    id: m.id,
    price: LAB_PRICE,
    displayName: null,
    gatewayApis: ["chat"],
    nativeApis: null,
    contextWindow: null,
    maxOutputTokens: null,
    images: null,
    modalities: null,
    reasoningLevels: null,
    priceSource: "magpie-settings",
    capabilitiesSource: "magpie-settings",
  }));
  (magpie as any).catalogModels = async () => metas;
  const svc = new Service({ magpie: magpie as never, magpieVersion: "fixture", probes: { catalogModels: async () => metas as any } });
  (svc as any).state.config = { nodeId: NODE, share: { models: ["*"] }, sharingEnabled: true, mappedCidr: "10.66.1.2/32", catalog: { port: 3426 } };
  (svc as any).publishCatalogNow = async () => {};
  (svc as any).catalogStatus = () => ({
    quote: { contentHash: HASH, billing: { priceVersion: catalogPriceVersion(quoteModels) }, identity: { fingerprint: FP }, models: quoteModels },
  });
  svc.requestApprovalContext = context;
  svc.writeSnapshot = () => {};
  // The assembly's full network projection needs a complete catalog fixture;
  // this adapter test only needs the sharing gate.
  (svc as any).statusSnapshotForTest = () => ({ config: { sharingEnabled: true, shareSuspended: null } });
  // The real gateway refuses an unknown secret with 401; the shared fake uses
  // a plain "no such key" message, which the revoke proof deliberately treats
  // as UNKNOWN, not as evidence of revocation.
  const limitStatus = magpie.limitStatus.bind(magpie);
  (magpie as any).limitStatus = async (secret: string) => {
    try {
      return await limitStatus(secret);
    } catch (error) {
      if (/no such key/.test(String((error as Error)?.message ?? error))) throw new Error("GET /v1/magpie/limit: HTTP 401");
      throw error;
    }
  };
  return { svc, magpie };
}

function authorization(): P2pAuthorizationDocument {
  const key = "sk-test-control-fixture-0001";
  return {
    schema: "ohmyaihub.authorization/v2",
    createdAt: "2026-10-31T00:00:00.000Z",
    provider: { nodeId: PROVIDER, mappedCidr: "10.66.2.3/32", gatewayPort: 3425 },
    consumer: { nodeId: "alice", fingerprint: "a".repeat(64) },
    approvalId: APPROVAL,
    requestHash: HASH,
    models: [LAB_MODEL],
    capUsd: 1,
    quote: { contentHash: HASH, identityFingerprint: FP, priceVersion: "p".repeat(64), priceLocked: false },
    keyId: "key-1",
    keyName: "ohmyaihub-alice",
    keyHash: createHash("sha256").update(key).digest("hex"),
    key,
  };
}

function inbound(overrides: Partial<P2pInboundApproval> = {}): P2pInboundApproval {
  return {
    approvalId: APPROVAL,
    generation: 1,
    requestHash: HASH,
    consumerNodeId: "alice",
    consumerFingerprint: "a".repeat(64),
    providerNodeId: PROVIDER,
    providerFingerprint: FP,
    models: [LAB_MODEL],
    capUsd: 1,
    quoteHash: HASH,
    priceVersion: "p".repeat(64),
    expiresAt: "2026-10-31T00:10:00.000Z",
    keyId: "key-1",
    keyName: "ohmyaihub-alice",
    ...overrides,
  };
}

const peer: P2pPeerIdentity = {
  accountId: FP,
  nodeId: PROVIDER,
  hostname: `ohmyaihub-${PROVIDER}`,
  publicKey: Buffer.alloc(32, 7).toString("base64"),
  fingerprint: FP,
};

function fakeConsumerService() {
  const providers = new Map<string, { id: string; mappedCidr: string; providerPort: number; key: string }>();
  const calls: string[] = [];
  const service = {
    addProvider: async (input: any) => {
      calls.push(`add:${input.id}`);
      providers.set(input.id, { ...input });
      return { id: input.id };
    },
    providerModels: async (id: string) => {
      calls.push(`models:${id}`);
      return { id, models: [LAB_MODEL], limit: { costLimit: 1 } };
    },
    removeProvider: async (id: string) => {
      calls.push(`remove:${id}`);
      if (!providers.has(id)) throw new Error(`no remote provider ${id}`);
      providers.delete(id);
      return { id };
    },
    provider: (id: string) => providers.get(id),
    provisioner: {},
  } as never;
  return { service, providers, calls };
}

describe("B-core P2pBusinessPort mapping", () => {
  test("validate returns the requested-set version, not the eligible subset version", async () => {
    const { svc } = realService();
    const port = createP2pBusinessPort(svc);
    const doc = requestDocument();
    const consumer = { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) };
    const result = await port.validateRequest({ requestHash: HASH, request: doc as any, consumer, sessionId: "s".repeat(32) });
    expect(result.models).toEqual([LAB_MODEL, "lab/other"]);
    expect(result.priceVersion).toBe(doc.quote.priceVersion);
    expect(result.quoteHash).toBe(HASH);
  });

  test("approve/takeAuthorization reuse Service and return selected-subset price binding", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const consumer = { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) };
    const doc = requestDocument();
    const approved = await port.approve({
      approvalId: APPROVAL,
      generation: 1,
      requestHash: HASH,
      request: doc as any,
      consumer,
      models: [LAB_MODEL],
      capUsd: 1,
      memo: "reviewed",
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    expect(approved.models).toEqual([LAB_MODEL]);
    expect(approved.priceVersion).toBe(catalogPriceVersion([models[0]!])!);
    expect(approved.quoteHash).toBe(HASH);
    expect(magpie.keys.size).toBe(1);
    const again = await port.approve({
      approvalId: APPROVAL,
      generation: 1,
      requestHash: HASH,
      request: doc as any,
      consumer,
      models: [LAB_MODEL],
      capUsd: 1,
      memo: "reviewed",
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    expect(again.keyId).toBe(approved.keyId);
    expect(magpie.keys.size).toBe(1); // idempotent: no second ensureKey
    await expect(
      port.approve({
        approvalId: "1".repeat(32),
        generation: 2,
        requestHash: HASH,
        request: doc as any,
        consumer,
        models: [LAB_MODEL],
        capUsd: 1,
        memo: "second",
        quote: { contentHash: HASH, identityFingerprint: FP },
      }),
    ).rejects.toThrow(/already has an approval attempt|second key/);
    expect(magpie.keys.size).toBe(1);
    const auth = await port.takeAuthorization({
      approvalId: APPROVAL,
      generation: 1,
      consumerNodeId: "alice",
      consumerFingerprint: "a".repeat(64),
      requestHash: HASH,
      models: approved.models,
      capUsd: approved.capUsd,
      quote: { contentHash: HASH, priceVersion: approved.priceVersion, identityFingerprint: FP },
      keyId: approved.keyId,
      keyName: approved.keyName,
    });
    expect(auth.key).toBe(magpie.keyById(approved.keyId)!.secret);
    expect(auth.quote.priceVersion).toBe(approved.priceVersion);
    await expect(svc.provisioner.confirmHandover("alice", approved.keyId, "sk-test-wrong-secret")).rejects.toThrow(/changed while/);
    await expect(svc.provisioner.confirmHandover("alice", approved.keyId, auth.key)).resolves.toBeUndefined();
    await expect(svc.provisioner.readHandover("alice", "wrong-key")).rejects.toThrow(/changed while/);

    // Core can reach takeAuthorization after reconcile keyReady; the journal
    // may still be pending. It must promote the exact native key, not ensure.
    const approvalFile = statePath("control-approvals.json");
    const pending = JSON.parse(readFileSync(approvalFile, "utf8"));
    pending.approvals[0].state = "pending";
    pending.approvals[0].keyId = null;
    pending.approvals[0].keyName = null;
    writeFileSync(approvalFile, JSON.stringify(pending));
    const afterPending = await port.takeAuthorization({
      approvalId: APPROVAL,
      generation: 1,
      consumerNodeId: "alice",
      consumerFingerprint: "a".repeat(64),
      requestHash: HASH,
      models: approved.models,
      capUsd: approved.capUsd,
      quote: { contentHash: HASH, priceVersion: approved.priceVersion, identityFingerprint: FP },
      keyId: approved.keyId,
      keyName: approved.keyName,
    });
    expect(afterPending.key).toBe(auth.key);
    expect(lookupControlApproval(APPROVAL, approvalFile)?.state).toBe("approved");
  });

  test("an approval whose native key was revoked elsewhere is converged, never replayed", async () => {
    // The console also exposes the legacy operator revoke. That path removes
    // the Magpie key but does not know the P2P approval id. The persisted
    // approval row must not keep pretending the dead key is an active
    // authorization, and a retry must not return that approval's materials.
    const { svc, magpie } = realService();
    const approvalFile = join(process.cwd(), "control-approvals.json");
    const port = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    const consumer = { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) };
    const first = await port.approve({
      approvalId: APPROVAL,
      generation: 1,
      requestHash: HASH,
      request: requestDocument() as any,
      consumer,
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    await svc.provisioner.revokeEnforced("alice", first.keyId);
    expect(svc.provisioner.find("alice")!.revokedAt).not.toBeNull();
    const versionsBefore = JSON.parse(readFileSync(approvalFile, "utf8")).approvals.length;
    await expect(port.approve({
      approvalId: APPROVAL,
      generation: 1,
      requestHash: HASH,
      request: requestDocument() as any,
      consumer,
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    })).rejects.toThrow(/native key is gone/);
    // Revocation is terminal for a consumer id (ledger account revoked): a new
    // approval of the same consumer is refused explicitly, not as an unknown
    // outcome, and creates no second key.
    await expect(port.approve({
      approvalId: APPROVAL2,
      generation: 2,
      requestHash: "9".repeat(64),
      request: requestDocument() as any,
      consumer,
      models: [LAB_MODEL],
      capUsd: 1,
      memo: "new generation after an external revoke",
      quote: { contentHash: HASH, identityFingerprint: FP },
    })).rejects.toThrow(/already has a different authorization|was revoked/);
    expect(magpie.keys.size).toBe(0); // the revoked key stays gone; no second key was created
    const versionsAfter = JSON.parse(readFileSync(approvalFile, "utf8")).approvals;
    // The refused attempt is retained as a non-approved record (never a second
    // live key), and the externally-revoked approval is converged to revoked.
    expect(versionsAfter.find((a: any) => a.approvalId === APPROVAL).state).toBe("revoked");
    const attempted = versionsAfter.find((a: any) => a.approvalId === APPROVAL2);
    expect(attempted.state).not.toBe("approved");
    expect(attempted.keyId).toBeNull();
    expect(versionsAfter.length).toBeGreaterThanOrEqual(versionsBefore);
  });

  test("reconcileApproval is read-only and recovers only a proven keyReady", async () => {
    const { svc, magpie } = realService();
    const approvalFile = join(process.cwd(), "control-approvals.json");
    const port = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    const consumer = { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) };
    const missing = await port.reconcileApproval!({ requestHash: HASH, approvalId: APPROVAL, generation: 1, consumer, keyId: null });
    expect(missing.state).toBe("unknown"); // a missing journal is not proof of no side effect
    const approved = await port.approve({
      approvalId: APPROVAL,
      generation: 1,
      requestHash: HASH,
      request: requestDocument() as any,
      consumer,
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    const ready = await port.reconcileApproval!({ requestHash: HASH, approvalId: APPROVAL, generation: 1, consumer, keyId: approved.keyId });
    expect(ready.state).toBe("keyReady");
    if (ready.state === "keyReady") {
      expect(ready.keyId).toBe(approved.keyId);
      expect(ready.consumerNodeId).toBe("alice");
      expect(ready.approvalId).toBe(APPROVAL);
      expect(ready.generation).toBe(1);
      expect(ready.evidence.source).toBe("magpie-key-readback");
      expect(ready.evidence.observedAt).toMatch(/T/);
      expect(ready.evidence.checked).toContain("keys");
      expect(ready.evidence.nativeKeyIds).toContain(approved.keyId);
      expect(ready.models).toEqual([LAB_MODEL]);
      expect(ready.capUsd).toBe(1);
    }
    // Simulate a crash between the native ensure and the journal keyId write:
    // the pending intent plus the deterministic native key is a keyReady.
    const file = JSON.parse(readFileSync(approvalFile, "utf8"));
    file.approvals[0].state = "pending";
    file.approvals[0].keyId = null;
    file.approvals[0].keyName = null;
    writeFileSync(approvalFile, JSON.stringify(file));
    const interrupted = await port.reconcileApproval!({ requestHash: HASH, approvalId: APPROVAL, generation: 1, consumer, keyId: null });
    expect(interrupted.state).toBe("keyReady");
    if (interrupted.state === "keyReady") expect(interrupted.keyId).toBe(approved.keyId);

    // A different generation/approval binding is unknown, never noSideEffect.
    expect((await port.reconcileApproval!({ requestHash: HASH, approvalId: APPROVAL, generation: 2, consumer, keyId: null })).state).toBe("unknown");
    expect((await port.reconcileApproval!({ requestHash: HASH, approvalId: "9".repeat(32), generation: 1, consumer, keyId: null })).state).toBe("unknown");
    expect(magpie.keys.size).toBe(1);

    // noSideEffect requires a durable pending intent plus native absence, not
    // merely a missing record.
    const other = "8".repeat(32);
    const pending = {
      approvalId: other, requestHash: "8".repeat(64), generation: 1,
      consumerNodeId: "nobody", consumerFingerprint: "8".repeat(64),
      models: [LAB_MODEL], capUsd: 1, quoteHash: HASH, priceVersion: "p".repeat(64),
      expiresAt: "2026-10-31T00:10:00.000Z", keyId: null, keyName: null, memo: null,
      state: "pending", error: null, createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
    };
    writeFileSync(approvalFile, JSON.stringify({ version: 1, approvals: [pending] }));
    const none = await port.reconcileApproval!({
      requestHash: "8".repeat(64), approvalId: other, generation: 1,
      consumer: { accountId: "8".repeat(64), nodeId: "nobody", hostname: "ohmyaihub-nobody", fingerprint: "8".repeat(64) }, keyId: null,
    });
    expect(none.state).toBe("noSideEffect");
    if (none.state === "noSideEffect") {
      expect(none.keyId).toBeNull();
      expect(none.evidence.source).toBe("provisioner-journal:magpie-readback");
      expect(none.evidence.checked).toEqual(["journal", "keys"]);
      expect(Array.isArray(none.evidence.nativeKeyIds)).toBe(true);
      expect(none.consumerNodeId).toBe("nobody");
    }
    // A restart re-reads the same journal; the truly absent intent remains a
    // noSideEffect, not a fresh approval attempt.
    const restarted = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    const afterRestart = await restarted.reconcileApproval!({
      requestHash: "8".repeat(64), approvalId: other, generation: 1,
      consumer: { accountId: "8".repeat(64), nodeId: "nobody", hostname: "ohmyaihub-nobody", fingerprint: "8".repeat(64) }, keyId: null,
    });
    expect(afterRestart.state).toBe("noSideEffect");

    // A native key from an interrupted approval with no local record is
    // keyReady; takeAuthorization must adopt the same key (Provisioner+ledger)
    // and never call ensure.
    const nativeOnly = "7".repeat(32);
    const nativePrice = catalogPriceVersion([models[0]!])!;
    const pendingNative = {
      ...pending,
      approvalId: nativeOnly,
      consumerNodeId: "native-only",
      consumerFingerprint: "7".repeat(64),
      priceVersion: nativePrice,
      expiresAt: "2026-10-31T00:10:00.000Z",
    };
    writeFileSync(approvalFile, JSON.stringify({ version: 1, approvals: [pendingNative] }));
    const nativeKey = await magpie.addKey("ohmyaihub-native-only");
    await magpie.setModels(nativeKey.id, [LAB_MODEL]);
    await magpie.setCostLimit(nativeKey.id, "3650d", 1);
    magpie.call(nativeKey.id, 1000, 1000);
    const nativeUsed = magpie.used(magpie.keys.get(nativeKey.id)!);
    const countBefore = magpie.keys.size;
    const nativeConsumer = { accountId: "7".repeat(64), nodeId: "native-only", hostname: "ohmyaihub-native-only", fingerprint: "7".repeat(64) };
    const ambiguous = await port.reconcileApproval!({
      requestHash: "8".repeat(64), approvalId: nativeOnly, generation: 1,
      consumer: nativeConsumer, keyId: null,
    });
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        port.reconcileApproval!({
          requestHash: "8".repeat(64), approvalId: nativeOnly, generation: 1,
          consumer: nativeConsumer, keyId: null,
        }),
      ),
    );
    for (const result of concurrent) {
      expect(result.state).toBe("keyReady");
      if (result.state === "keyReady") expect(result.keyId).toBe(nativeKey.id);
    }
    expect(magpie.keys.size).toBe(countBefore);
    expect(ambiguous.state).toBe("keyReady");
    if (ambiguous.state === "keyReady") expect(ambiguous.keyId).toBe(nativeKey.id);
    const adopted = await port.takeAuthorization({
      approvalId: nativeOnly,
      generation: 1,
      consumerNodeId: "native-only",
      consumerFingerprint: "7".repeat(64),
      requestHash: "8".repeat(64),
      models: [LAB_MODEL],
      capUsd: 1,
      quote: { contentHash: HASH, priceVersion: nativePrice, identityFingerprint: FP },
      keyId: nativeKey.id,
      keyName: "ohmyaihub-native-only",
    });
    expect(adopted.key).toBe(nativeKey.secret);
    expect(magpie.keys.size).toBe(countBefore); // no second key
    expect(svc.provisioner.find("native-only")?.keyId).toBe(nativeKey.id);
    expect(svc.ledger?.account("native-only")).toBeDefined();
    const balance = svc.ledger!.balance("native-only");
    expect(balance.depositedNanos).toBe(1_000_000_000);
    expect(balance.consumedNanos).toBe(Math.round(nativeUsed * 1_000_000_000));
    const concurrentTakes = await Promise.all([
      port.takeAuthorization({
        approvalId: nativeOnly, generation: 1, consumerNodeId: "native-only", consumerFingerprint: "7".repeat(64),
        requestHash: "8".repeat(64), models: [LAB_MODEL], capUsd: 1,
        quote: { contentHash: HASH, priceVersion: nativePrice, identityFingerprint: FP },
        keyId: nativeKey.id, keyName: "ohmyaihub-native-only",
      }),
      port.takeAuthorization({
        approvalId: nativeOnly, generation: 1, consumerNodeId: "native-only", consumerFingerprint: "7".repeat(64),
        requestHash: "8".repeat(64), models: [LAB_MODEL], capUsd: 1,
        quote: { contentHash: HASH, priceVersion: nativePrice, identityFingerprint: FP },
        keyId: nativeKey.id, keyName: "ohmyaihub-native-only",
      }),
    ]);
    expect(concurrentTakes.every((r) => r.key === nativeKey.secret)).toBe(true);
    expect(magpie.keys.size).toBe(countBefore);

    // Restart and take again: same approval/key, still no ensure.
    const restartedNative = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    const adoptedAgain = await restartedNative.takeAuthorization({
      approvalId: nativeOnly,
      generation: 1,
      consumerNodeId: "native-only",
      consumerFingerprint: "7".repeat(64),
      requestHash: "8".repeat(64),
      models: [LAB_MODEL],
      capUsd: 1,
      quote: { contentHash: HASH, priceVersion: nativePrice, identityFingerprint: FP },
      keyId: nativeKey.id,
      keyName: "ohmyaihub-native-only",
    });
    expect(adoptedAgain.key).toBe(nativeKey.secret);
    expect(magpie.keys.size).toBe(countBefore);
    expect(svc.ledger!.balance("native-only")).toEqual(balance); // no duplicate opening/credit
  });

  test("adoption reads limit once and seeds from that same snapshot", async () => {
    const { svc, magpie } = realService();
    const key = await magpie.addKey("ohmyaihub-single-read");
    await magpie.setModels(key.id, [LAB_MODEL]);
    await magpie.setCostLimit(key.id, "3650d", 1);
    magpie.call(key.id, 1000, 1000);
    const used = magpie.used(magpie.keys.get(key.id)!);
    const original = magpie.limitStatus.bind(magpie);
    let calls = 0;
    (magpie as any).limitStatus = async (secret: string) => {
      calls += 1;
      if (calls > 1) throw new Error("late limit read failed");
      return original(secret);
    };
    await svc.provisioner.adoptControlKey({
      consumerId: "single-read", keyId: key.id, keyName: "ohmyaihub-single-read",
      models: [LAB_MODEL], capUsd: 1, quoteHash: HASH, priceVersion: catalogPriceVersion([models[0]!])!,
    });
    expect(calls).toBe(1);
    const balance = svc.ledger!.balance("single-read");
    expect(balance.depositedNanos).toBe(1_000_000_000);
    expect(balance.consumedNanos).toBe(Math.round(used * 1_000_000_000));
    // Existing account: a retry must not add another opening even if readback is down.
    await svc.provisioner.adoptControlKey({
      consumerId: "single-read", keyId: key.id, keyName: "ohmyaihub-single-read",
      models: [LAB_MODEL], capUsd: 1, quoteHash: HASH, priceVersion: catalogPriceVersion([models[0]!])!,
    });
    expect(svc.ledger!.balance("single-read")).toEqual(balance);
  });

  test("adoption repairs an opening that has no migration adjustment", async () => {
    const { svc, magpie } = realService();
    const key = await magpie.addKey("ohmyaihub-halfstate");
    await magpie.setModels(key.id, [LAB_MODEL]);
    await magpie.setCostLimit(key.id, "3650d", 1);
    magpie.call(key.id, 1000, 1000);
    const used = magpie.used(magpie.keys.get(key.id)!);
    const snap = priceSnapshot([{ id: LAB_MODEL, price: LAB_PRICE }], [LAB_MODEL])!;
    svc.ledger!.ensureAccount({
      consumerId: "halfstate", keyId: key.id, keyName: "ohmyaihub-halfstate", price: snap,
      windowSpec: "3650d", startAt: "2026-10-31T00:00:00.000Z", resetAt: "2036-10-31T00:00:00.000Z",
      openingNanos: 1_000_000_000, capNanos: 1_000_000_000,
    });
    await svc.provisioner.adoptControlKey({
      consumerId: "halfstate", keyId: key.id, keyName: "ohmyaihub-halfstate",
      models: [LAB_MODEL], capUsd: 1, quoteHash: HASH, priceVersion: snap.version,
    });
    const balance = svc.ledger!.balance("halfstate");
    expect(balance.depositedNanos).toBe(1_000_000_000);
    expect(balance.consumedNanos).toBe(Math.round(used * 1_000_000_000));
  });

  test("adoption refuses an unproven native used cost instead of opening the full cap", async () => {
    const { svc, magpie } = realService();
    const approvalFile = join(process.cwd(), "control-approvals.json");
    const port = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    const consumer = { accountId: "6".repeat(64), nodeId: "used-unknown", hostname: "ohmyaihub-used-unknown", fingerprint: "6".repeat(64) };
    const price = catalogPriceVersion([models[0]!])!;
    const key = await magpie.addKey("ohmyaihub-used-unknown");
    await magpie.setModels(key.id, [LAB_MODEL]);
    await magpie.setCostLimit(key.id, "3650d", 1);
    magpie.call(key.id, 1000, 1000);
    const pending = {
      approvalId: "6".repeat(32), requestHash: "6".repeat(64), generation: 1,
      consumerNodeId: "used-unknown", consumerFingerprint: "6".repeat(64),
      models: [LAB_MODEL], capUsd: 1, quoteHash: HASH, priceVersion: price,
      expiresAt: "2026-10-31T00:10:00.000Z", keyId: null, keyName: null, memo: null,
      state: "pending", error: null, createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
    };
    writeFileSync(approvalFile, JSON.stringify({ version: 1, approvals: [pending] }));
    expect((await port.reconcileApproval!({ requestHash: "6".repeat(64), approvalId: pending.approvalId, generation: 1, consumer, keyId: null })).state).toBe("keyReady");
    (magpie as any).limitStatus = async () => { throw new Error("ECONNREFUSED"); };
    await expect(port.takeAuthorization({
      approvalId: pending.approvalId, generation: 1, consumerNodeId: "used-unknown", consumerFingerprint: "6".repeat(64),
      requestHash: "6".repeat(64), models: [LAB_MODEL], capUsd: 1,
      quote: { contentHash: HASH, priceVersion: price, identityFingerprint: FP },
      keyId: key.id, keyName: "ohmyaihub-used-unknown",
    })).rejects.toBeInstanceOf(Error);
    expect(svc.ledger?.account("used-unknown") ?? null).toBeNull();
    expect(svc.provisioner.find("used-unknown") ?? null).toBeNull();
  });

  test("an invalid native used cost writes neither a ConsumerRecord nor an opening account", async () => {
    const { svc, magpie } = realService();
    const approvalFile = join(process.cwd(), "control-approvals.json");
    const port = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    const consumer = { accountId: "5".repeat(64), nodeId: "bad-used", hostname: "ohmyaihub-bad-used", fingerprint: "5".repeat(64) };
    const price = catalogPriceVersion([models[0]!])!;
    const key = await magpie.addKey("ohmyaihub-bad-used");
    await magpie.setModels(key.id, [LAB_MODEL]);
    await magpie.setCostLimit(key.id, "3650d", 1);
    const pending = {
      approvalId: "5".repeat(32), requestHash: "5".repeat(64), generation: 1,
      consumerNodeId: "bad-used", consumerFingerprint: "5".repeat(64),
      models: [LAB_MODEL], capUsd: 1, quoteHash: HASH, priceVersion: price,
      expiresAt: "2026-10-31T00:10:00.000Z", keyId: null, keyName: null, memo: null,
      state: "pending", error: null, createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
    };
    writeFileSync(approvalFile, JSON.stringify({ version: 1, approvals: [pending] }));
    (magpie as any).limitStatus = async () => ({ limited: true, key: "x", limit: { costLimit: 1 } });
    await expect(port.takeAuthorization({
      approvalId: pending.approvalId, generation: 1, consumerNodeId: "bad-used", consumerFingerprint: "5".repeat(64),
      requestHash: "5".repeat(64), models: [LAB_MODEL], capUsd: 1,
      quote: { contentHash: HASH, priceVersion: price, identityFingerprint: FP },
      keyId: key.id, keyName: "ohmyaihub-bad-used",
    })).rejects.toThrow(/used cost is invalid\/unknown|used cost is unknown/);
    expect(svc.provisioner.find("bad-used") ?? null).toBeNull();
    expect(svc.ledger?.account("bad-used") ?? null).toBeNull();
    await expect(svc.provisioner.status("bad-used")).rejects.toThrow(/no consumer/);
    expect(svc.ledger?.account("bad-used") ?? null).toBeNull();
  });

  test("a legacy adopted record with unknown used cannot open credit via status/recover", async () => {
    const { svc, magpie } = realService();
    const key = await magpie.addKey("ohmyaihub-old-adopt");
    await magpie.setModels(key.id, [LAB_MODEL]);
    await magpie.setCostLimit(key.id, "3650d", 1);
    const rec = {
      consumerId: "old-adopt", keyName: "ohmyaihub-old-adopt", keyId: key.id, secret: key.secret,
      models: [LAB_MODEL], window: "3650d", capUsd: 1, creditedUsd: 0, deposits: [], pending: null,
      paused: null, priceVersion: "p".repeat(64), acceptedQuoteHash: HASH,
      createdAt: "2026-10-31T00:00:00.000Z", revokedAt: null, adoptedFromNative: true, lastCheck: null,
    };
    (svc.provisioner as any).list.push(rec);
    (magpie as any).limitStatus = async () => ({ limited: true, key: "x", limit: { costLimit: 1 } });
    await expect(svc.provisioner.status("old-adopt")).rejects.toThrow(/used cost is unknown/);
    expect(svc.ledger?.account("old-adopt") ?? null).toBeNull();
    await svc.provisioner.recover();
    expect(svc.ledger?.account("old-adopt") ?? null).toBeNull();
  });

  test("reconcileApproval returns unknown when Magpie key management cannot be read", async () => {
    const { svc } = realService();
    const approvalFile = join(process.cwd(), "control-approvals.json");
    const port = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    (svc.provisioner as any).nativeKeySnapshot = async () => { throw new Error("Magpie key list unreadable"); };
    const result = await port.reconcileApproval!({
      requestHash: HASH, approvalId: APPROVAL, generation: 1,
      consumer: { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) }, keyId: null,
    });
    expect(result.state).toBe("unknown");
  });

  test("reconcileApproval treats a corrupt journal as unknown, not noSideEffect", async () => {
    const { svc } = realService();
    const approvalFile = join(process.cwd(), "control-approvals.json");
    writeFileSync(approvalFile, "{corrupt");
    const port = createP2pBusinessPort(svc, { approvalStateFile: approvalFile });
    const result = await port.reconcileApproval!({ requestHash: HASH, approvalId: APPROVAL, generation: 1, consumer: { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) }, keyId: null });
    expect(result.state).toBe("unknown");
  });

  test("consumer import is generation-owned, refuses a different approval while a Remote exists, and survives restart", async () => {
    const { service, providers, calls } = fakeConsumerService();
    const stateFile = join(process.cwd(), "control-remotes.json");
    const port = createP2pBusinessPort(service, { stateFile });
    const doc = authorization();
    const first = await port.importAuthorization({ document: doc, approval: inbound(), session: { sessionId: "s".repeat(32), peer } });
    expect(first.models).toEqual([LAB_MODEL]);
    expect(providers.size).toBe(1);
    const firstId = providerIdFor(PROVIDER, APPROVAL);
    expect(providers.has(firstId)).toBe(true);
    expect(controlRemotes(stateFile).remotes).toHaveLength(1);

    // A different approval must not replace a live Remote.
    const older = { ...doc, approvalId: APPROVAL2, keyId: "key-old", keyName: "old" };
    await expect(
      port.importAuthorization({ document: older, approval: inbound({ approvalId: APPROVAL2, generation: 9, keyId: "key-old", keyName: "old" }), session: { sessionId: "s".repeat(32), peer } }),
    ).rejects.toBeInstanceOf(ControlServiceRefusal);
    expect(providers.has(firstId)).toBe(true);
    expect(calls.filter((c) => c.startsWith("add:")).length).toBe(1);

    // After restart the ownership file still blocks a different approval.
    const restarted = createP2pBusinessPort(service, { stateFile });
    await expect(
      restarted.importAuthorization({ document: older, approval: inbound({ approvalId: APPROVAL2, generation: 9, keyId: "key-old", keyName: "old" }), session: { sessionId: "s".repeat(32), peer } }),
    ).rejects.toBeInstanceOf(ControlServiceRefusal);

    // The same approval with a different generation is a different key
    // generation and must not replace the existing Remote.
    await expect(
      restarted.importAuthorization({ document: doc, approval: inbound({ generation: 2 }), session: { sessionId: "s".repeat(32), peer } }),
    ).rejects.toBeInstanceOf(ControlServiceRefusal);

    // Revoking the old approval removes only its own Remote.
    await restarted.dropAuthorization({ approvalId: APPROVAL, consumerNodeId: "alice", providerNodeId: PROVIDER, providerFingerprint: FP, reason: "operator-revoked" });
    expect(providers.size).toBe(0);
    expect(controlRemotes(stateFile).remotes).toHaveLength(0);
  });

  test("a stale revocation does not remove a newer Remote", async () => {
    const { service, providers } = fakeConsumerService();
    const stateFile = join(process.cwd(), "control-remotes.json");
    const port = createP2pBusinessPort(service, { stateFile });
    const doc = authorization();
    await port.importAuthorization({ document: doc, approval: inbound(), session: { sessionId: "s".repeat(32), peer } });
    // Manually make the stored record look newer than the revocation; this is
    // what a second approval would produce after the first was removed.
    const current = providerIdFor(PROVIDER, APPROVAL);
    const newerId = providerIdFor(PROVIDER, APPROVAL2);
    await (service as any).addProvider({ id: newerId, mappedCidr: "10.66.2.3/32", providerPort: 3425, key: "sk-new" });
    const file = JSON.parse(readFileSync(stateFile, "utf8"));
    file.remotes[0].approvalId = APPROVAL2;
    file.remotes[0].providerId = newerId;
    writeFileSync(stateFile, JSON.stringify(file));
    await port.dropAuthorization({ approvalId: APPROVAL, consumerNodeId: "alice", providerNodeId: PROVIDER, providerFingerprint: FP, reason: "operator-revoked" });
    expect(providers.has(newerId)).toBe(true);
    // The old Remote may remain because the ownership record now names the
    // newer approval; a stale revocation must not remove either one blindly.
    expect(providers.has(current)).toBe(true);
  });

  test("a crash after the native add but before the final save keeps ownership and never resets the new Remote", async () => {
    const providers = new Map<string, any>();
    let failAfterAdd = true;
    const service = {
      addProvider: async (input: any) => {
        providers.set(input.id, { ...input });
        if (failAfterAdd) {
          failAfterAdd = false;
          throw new Error("simulated crash after native add");
        }
        return { id: input.id };
      },
      providerModels: async (id: string) => ({ id, models: [LAB_MODEL], limit: { costLimit: 1 } }),
      removeProvider: async (id: string) => { providers.delete(id); return { id }; },
      provider: (id: string) => providers.get(id),
    } as never;
    const stateFile = join(process.cwd(), "control-remotes.json");
    const port = createP2pBusinessPort(service, { stateFile });
    const doc = authorization();
    await expect(port.importAuthorization({ document: doc, approval: inbound(), session: { sessionId: "s".repeat(32), peer } })).rejects.toThrow(/simulated crash/);
    const pendingId = providerIdFor(PROVIDER, APPROVAL);
    expect(providers.has(pendingId)).toBe(true);
    expect(controlRemotes(stateFile).remotes[0]!.approvalId).toBe(APPROVAL);

    // A different approval cannot take this provider while the pending/native
    // record exists, even though the first import did not complete.
    const other = { ...doc, approvalId: APPROVAL2, keyId: "key-old" };
    await expect(
      port.importAuthorization({ document: other, approval: inbound({ approvalId: APPROVAL2, generation: 2, keyId: "key-old" }), session: { sessionId: "s".repeat(32), peer } }),
    ).rejects.toBeInstanceOf(ControlServiceRefusal);

    // The same approval retries idempotently and adopts the existing Remote.
    const retried = await port.importAuthorization({ document: doc, approval: inbound(), session: { sessionId: "s".repeat(32), peer } });
    expect(retried.models).toEqual([LAB_MODEL]);
    expect(providers.has(pendingId)).toBe(true);
    expect(controlRemotes(stateFile).remotes[0]!.capUsd).toBe(1);
  });

  test("a corrupt ownership file fails closed before touching a Remote", async () => {
    const { service, calls } = fakeConsumerService();
    const stateFile = join(process.cwd(), "control-remotes.json");
    writeFileSync(stateFile, "{not json");
    const port = createP2pBusinessPort(service, { stateFile });
    await expect(port.importAuthorization({ document: authorization(), approval: inbound(), session: { sessionId: "s".repeat(32), peer } })).rejects.toThrow(/corrupt|unreadable/);
    expect(calls).toEqual([]);
  });

  test("a missing local key row with a still-working secret is not confirmed", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "a".repeat(32),
      generation: 1,
      requestHash: "6".repeat(64),
      request: singleRequest({ nodeId: "erin", hostname: "ohmyaihub-erin" }) as any,
      consumer: { accountId: "e".repeat(64), nodeId: "erin", hostname: "ohmyaihub-erin", fingerprint: "e".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    // The local key row disappears while the gateway still accepts the old
    // secret: absence of a row is not proof of revocation.
    (magpie as any).keyById = () => undefined;
    const result = await port.revoke({ consumerNodeId: "erin", approvalId: "a".repeat(32), keyId: approved.keyId, generation: 1, reason: "operator-revoked" });
    expect(result.revoked).toBe(false);
    expect(result.enforcement).not.toBe("keyRevoked");
    expect(svc.provisioner.find("erin")!.revokedAt).toBeNull();
  });

  test("an unknown readback error is not enough to confirm revocation", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "b".repeat(32),
      generation: 1,
      requestHash: "5".repeat(64),
      request: singleRequest({ nodeId: "frank", hostname: "ohmyaihub-frank" }) as any,
      consumer: { accountId: "f".repeat(64), nodeId: "frank", hostname: "ohmyaihub-frank", fingerprint: "f".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    (magpie as any).removeKey = async () => { throw new Error("native remove failed"); };
    (magpie as any).rotateKey = async () => { throw new Error("rotate failed"); };
    (magpie as any).keyById = () => undefined;
    (magpie as any).limitStatus = async () => { throw new Error("ECONNREFUSED"); };
    const result = await port.revoke({ consumerNodeId: "frank", approvalId: "b".repeat(32), keyId: approved.keyId, generation: 1, reason: "operator-revoked" });
    expect(result.revoked).toBe(false);
    expect(svc.provisioner.find("frank")!.revokedAt).toBeNull();
  });

  test("a revoke request for another key generation is refused before touching the native key", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "c".repeat(32),
      generation: 1,
      requestHash: "4".repeat(64),
      request: singleRequest({ nodeId: "grace", hostname: "ohmyaihub-grace" }) as any,
      consumer: { accountId: "1".repeat(64), nodeId: "grace", hostname: "ohmyaihub-grace", fingerprint: "1".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    const result = await port.revoke({ consumerNodeId: "grace", approvalId: "c".repeat(32), keyId: "other-key", generation: 1, reason: "operator-revoked" });
    expect(result.revoked).toBe(false);
    expect(magpie.keyById(approved.keyId)).toBeDefined();
    expect(svc.provisioner.find("grace")!.revokedAt).toBeNull();
    // The same expected-key check is inside the Provisioner lock, not only in
    // the port's pre-check.
    const locked = await svc.provisioner.revokeEnforced("grace", "other-key");
    expect(locked.revoked).toBe(false);
    expect(magpie.keyById(approved.keyId)).toBeDefined();
  });

  test("a rotation that leaves the old secret accepted is not claimed enforced", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "f".repeat(32),
      generation: 1,
      requestHash: "7".repeat(64),
      request: singleRequest({ nodeId: "dave", hostname: "ohmyaihub-dave" }) as any,
      consumer: { accountId: "d".repeat(64), nodeId: "dave", hostname: "ohmyaihub-dave", fingerprint: "d".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    (magpie as any).removeKey = async () => { throw new Error("remove failed"); };
    (magpie as any).rotateKey = async (id: string) => {
      const key = magpie.keyById(id);
      if (key) key.secret = "sk-test-rotated-secret";
      return "sk-test-rotated-secret";
    };
    // The provider's read-back still accepts the old secret: rotation happened
    // but the old credential is not proven dead.
    (magpie as any).limitStatus = async () => ({ limited: true, key: "x", limit: { costLimit: 1, cost: 0, costLeft: 1, calls: 0, spent: false } });
    const result = await port.revoke({ consumerNodeId: "dave", approvalId: "f".repeat(32), keyId: approved.keyId, generation: 1, reason: "operator-revoked" });
    expect(result && result.revoked).toBe(false);
    expect(result && result.enforcement).toBe("safetyUncertain");
    expect(svc.provisioner.find("dave")!.revokedAt).toBeNull();
    expect(magpie.keyById(approved.keyId)).toBeDefined();
  });
});

describe("enforced revoke port", () => {
  test("remove success is enforced; remove failure with rotation is enforced; both failing is not claimed", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: APPROVAL,
      generation: 1,
      requestHash: HASH,
      request: requestDocument() as any,
      consumer: { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    const revoked = await port.revoke({ consumerNodeId: "alice", approvalId: APPROVAL, keyId: approved.keyId, generation: 1, reason: "operator-revoked" });
    expect(revoked).toEqual({
      revoked: true,
      enforcement: "keyRevoked",
      consumerNodeId: "alice",
      approvalId: APPROVAL,
      keyId: approved.keyId,
      generation: 1,
      detail: null,
    });
    expect(magpie.keyById(approved.keyId)).toBeUndefined();

    // A second consumer: remove fails, rotate succeeds -> old secret is no longer the stored secret.
    const second = await port.approve({
      approvalId: APPROVAL2,
      generation: 1,
      requestHash: "9".repeat(64),
      request: singleRequest({ nodeId: "bob", hostname: "ohmyaihub-bob" }) as any,
      consumer: { accountId: "b".repeat(64), nodeId: "bob", hostname: "ohmyaihub-bob", fingerprint: "b".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    const originalSecret = magpie.keyById(second.keyId)!.secret;
    const originalRemove = magpie.removeKey.bind(magpie);
    (magpie as any).removeKey = async () => { throw new Error("native remove failed"); };
    const rotated = await port.revoke({ consumerNodeId: "bob", approvalId: APPROVAL2, keyId: second.keyId, generation: 1, reason: "operator-revoked" });
    expect(rotated.revoked).toBe(true);
    if (!rotated.revoked) throw new Error("expected a confirmed rotation");
    expect(rotated.enforcement).toBe("secretRotated");
    expect(rotated.keyId).toBe(second.keyId);
    expect(rotated.detail).toContain("remove failed");
    expect(magpie.keyById(second.keyId)!.secret).not.toBe(originalSecret);
    (magpie as any).removeKey = originalRemove;

    // A third consumer: remove and rotate both fail -> not revoked, record stays active.
    const third = await port.approve({
      approvalId: "e".repeat(32),
      generation: 1,
      requestHash: "8".repeat(64),
      request: singleRequest({ nodeId: "carol", hostname: "ohmyaihub-carol" }) as any,
      consumer: { accountId: "c".repeat(64), nodeId: "carol", hostname: "ohmyaihub-carol", fingerprint: "c".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    (magpie as any).removeKey = async () => { throw new Error("remove failed"); };
    (magpie as any).rotateKey = async () => { throw new Error("rotate failed"); };
    const failed = await port.revoke({ consumerNodeId: "carol", approvalId: "e".repeat(32), keyId: third.keyId, generation: 1, reason: "operator-revoked" });
    expect(failed && failed.revoked).toBe(false);
    expect(failed && failed.enforcement).toBe("capRestricted");
    expect(magpie.keyById(third.keyId)).toBeDefined();
    expect(svc.provisioner.find("carol")!.revokedAt).toBeNull();
  });

  test("a missing local key row with a still-working secret is not confirmed", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "a".repeat(32),
      generation: 1,
      requestHash: "6".repeat(64),
      request: singleRequest({ nodeId: "erin", hostname: "ohmyaihub-erin" }) as any,
      consumer: { accountId: "e".repeat(64), nodeId: "erin", hostname: "ohmyaihub-erin", fingerprint: "e".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    // The local key row disappears while the gateway still accepts the old
    // secret: absence of a row is not proof of revocation.
    (magpie as any).keyById = () => undefined;
    const result = await port.revoke({ consumerNodeId: "erin", approvalId: "a".repeat(32), keyId: approved.keyId, generation: 1, reason: "operator-revoked" });
    expect(result.revoked).toBe(false);
    expect(result.enforcement).not.toBe("keyRevoked");
    expect(svc.provisioner.find("erin")!.revokedAt).toBeNull();
  });

  test("an unknown readback error is not enough to confirm revocation", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "b".repeat(32),
      generation: 1,
      requestHash: "5".repeat(64),
      request: singleRequest({ nodeId: "frank", hostname: "ohmyaihub-frank" }) as any,
      consumer: { accountId: "f".repeat(64), nodeId: "frank", hostname: "ohmyaihub-frank", fingerprint: "f".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    (magpie as any).removeKey = async () => { throw new Error("native remove failed"); };
    (magpie as any).rotateKey = async () => { throw new Error("rotate failed"); };
    (magpie as any).keyById = () => undefined;
    (magpie as any).limitStatus = async () => { throw new Error("ECONNREFUSED"); };
    const result = await port.revoke({ consumerNodeId: "frank", approvalId: "b".repeat(32), keyId: approved.keyId, generation: 1, reason: "operator-revoked" });
    expect(result.revoked).toBe(false);
    expect(svc.provisioner.find("frank")!.revokedAt).toBeNull();
  });

  test("a revoke request for another key generation is refused before touching the native key", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "c".repeat(32),
      generation: 1,
      requestHash: "4".repeat(64),
      request: singleRequest({ nodeId: "grace", hostname: "ohmyaihub-grace" }) as any,
      consumer: { accountId: "1".repeat(64), nodeId: "grace", hostname: "ohmyaihub-grace", fingerprint: "1".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    const result = await port.revoke({ consumerNodeId: "grace", approvalId: "c".repeat(32), keyId: "other-key", generation: 1, reason: "operator-revoked" });
    expect(result.revoked).toBe(false);
    expect(magpie.keyById(approved.keyId)).toBeDefined();
    expect(svc.provisioner.find("grace")!.revokedAt).toBeNull();
    // The same expected-key check is inside the Provisioner lock, not only in
    // the port's pre-check.
    const locked = await svc.provisioner.revokeEnforced("grace", "other-key");
    expect(locked.revoked).toBe(false);
    expect(magpie.keyById(approved.keyId)).toBeDefined();
  });

  test("a rotation that leaves the old secret accepted is not claimed enforced", async () => {
    const { svc, magpie } = realService();
    const port = createP2pBusinessPort(svc);
    const approved = await port.approve({
      approvalId: "f".repeat(32),
      generation: 1,
      requestHash: "7".repeat(64),
      request: singleRequest({ nodeId: "dave", hostname: "ohmyaihub-dave" }) as any,
      consumer: { accountId: "d".repeat(64), nodeId: "dave", hostname: "ohmyaihub-dave", fingerprint: "d".repeat(64) },
      models: [LAB_MODEL],
      capUsd: 1,
      memo: null,
      quote: { contentHash: HASH, identityFingerprint: FP },
    });
    (magpie as any).removeKey = async () => { throw new Error("remove failed"); };
    (magpie as any).rotateKey = async (id: string) => {
      const key = magpie.keyById(id);
      if (key) key.secret = "sk-test-rotated-secret";
      return "sk-test-rotated-secret";
    };
    // The provider's read-back still accepts the old secret: rotation happened
    // but the old credential is not proven dead.
    (magpie as any).limitStatus = async () => ({ limited: true, key: "x", limit: { costLimit: 1, cost: 0, costLeft: 1, calls: 0, spent: false } });
    const result = await port.revoke({ consumerNodeId: "dave", approvalId: "f".repeat(32), keyId: approved.keyId, generation: 1, reason: "operator-revoked" });
    expect(result && result.revoked).toBe(false);
    expect(result && result.enforcement).toBe("safetyUncertain");
    expect(svc.provisioner.find("dave")!.revokedAt).toBeNull();
    expect(magpie.keyById(approved.keyId)).toBeDefined();
  });
});

describe("payment authorization lifetime", () => {
  test("a delivered approval's key-delivery expiry does not revoke the payment authorization", () => {
    const file = join(process.cwd(), "expired-approvals.json");
    const now = new Date("2026-10-31T12:00:00Z");
    const record = {
      approvalId: "a".repeat(32), requestHash: "b".repeat(64), generation: 3,
      consumerNodeId: "consumer-1", consumerFingerprint: "c".repeat(64), models: ["lab/model"],
      capUsd: 0.05, quoteHash: "d".repeat(64), priceVersion: "e".repeat(64),
      expiresAt: "2026-10-31T11:50:00.000Z", keyId: "key-1", keyName: "name-1", memo: null,
      state: "approved", error: null, createdAt: "2026-10-31T11:40:00.000Z", updatedAt: "2026-10-31T11:40:00.000Z",
    };
    writeFileSync(file, JSON.stringify({ version: 1, approvals: [record] }));
    expect(controlAuthorizationForConsumer("consumer-1", file, now)).toMatchObject({ generation: 3, quoteHash: "d".repeat(64), priceVersion: "e".repeat(64) });
    const revoked = { ...record, state: "revoked" };
    writeFileSync(file, JSON.stringify({ version: 1, approvals: [revoked] }));
    expect(controlAuthorizationForConsumer("consumer-1", file, now)).toBeNull();
  });
});
