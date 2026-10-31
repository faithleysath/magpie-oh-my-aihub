import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { catalogPriceVersion } from "../src/pricing.ts";
import { Service } from "../src/service.ts";
import { FakeMagpie, LAB_MODEL, LAB_PRICE } from "./support/fake-magpie.ts";
import { ControlServiceRefusal } from "../src/control/service-port.ts";
import {
  controlRemotes,
  createP2pBusinessPort,
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
