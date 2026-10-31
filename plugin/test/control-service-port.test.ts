import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPriceVersion } from "../src/pricing.ts";
import { Service } from "../src/service.ts";
import { FakeMagpie, LAB_MODEL, LAB_PRICE } from "./support/fake-magpie.ts";
import {
  ControlServiceRefusal,
  approve,
  createApprovalPort,
  dropAuthorization,
  importAuthorization,
  providerContext,
  providerIdFor,
  takeAuthorization,
  type ControlAuthorizationDocument,
  type ControlInboundApproval,
} from "../src/control/service-port.ts";

const NODE = "d".repeat(16);
const PROVIDER = "e".repeat(16);
const FP = "f".repeat(64);
const HASH = "b".repeat(64);
const APPROVAL = "c".repeat(32);
const models = [{ id: LAB_MODEL, pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }];

function context() {
  return {
    provider: { nodeId: NODE, mappedCidr: "10.66.1.2/32", gatewayPort: 3425 },
    quote: { contentHash: HASH, identity: { fingerprint: FP }, models: structuredClone(models) },
  };
}

function document() {
  const version = catalogPriceVersion(models)!;
  return {
    consumer: { nodeId: "alice", hostname: "ohmyaihub-alice" },
    provider: { nodeId: NODE, hostname: `ohmyaihub-${NODE}`, mappedCidr: "10.66.1.2/32", gatewayPort: 3425, catalogPort: 3426 },
    models: [LAB_MODEL],
    quote: { contentHash: HASH, priceVersion: version, identityFingerprint: FP, priceLocked: false as const },
    acceptance: { fingerprint: FP, quoteHash: HASH, priceVersion: version },
  };
}

function realService() {
  process.chdir(mkdtempSync(join(tmpdir(), "control-service-")));
  const magpie = new FakeMagpie();
  (magpie as any).providersReadable = () => true;
  const metas = () =>
    [LAB_MODEL].map((id) => ({
      id,
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
  (magpie as any).catalogModels = async () => metas();
  const svc = new Service({ magpie: magpie as never, magpieVersion: "fixture", probes: { catalogModels: async () => metas() as any } });
  (svc as any).state.config = { nodeId: NODE, share: { models: ["*"] }, sharingEnabled: true, mappedCidr: "10.66.1.2/32" };
  (svc as any).publishCatalogNow = async () => {};
  svc.requestApprovalContext = context;
  svc.writeSnapshot = () => {};
  return { svc, magpie };
}

beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "control-service-port-")));
});

describe("provider context", () => {
  test("reports the exact mapped /32 and current quote; null when not publishing", () => {
    const baseService = {
      config: () => ({ nodeId: NODE, mappedCidr: "10.66.1.2/32", catalog: { port: 3426 } }),
      gatewayPort: () => 3425,
      catalogStatus: () => ({ quote: { contentHash: HASH, billing: { priceVersion: "p".repeat(64) }, identity: { fingerprint: FP }, models } }),
    };
    const service = baseService as never;
    expect(providerContext(service)).toEqual({
      nodeId: NODE,
      hostname: `ohmyaihub-${NODE}`,
      mappedCidr: "10.66.1.2/32",
      gatewayPort: 3425,
      catalogPort: 3426,
      quote: { contentHash: HASH, priceVersion: "p".repeat(64), identityFingerprint: FP, models: [{ id: LAB_MODEL, pricing: models[0]!.pricing }] },
    });
    const noQuote = { ...baseService, catalogStatus: () => ({ quote: null }) } as never;
    expect(providerContext(noQuote).quote).toBeNull();
    expect(() => providerContext({ ...baseService, config: () => null } as never)).toThrow(ControlServiceRefusal);
  });
});

describe("human approval and one-time hand-over", () => {
  test("approval uses the existing Service path and produces the exact v2 binding", async () => {
    const { svc, magpie } = realService();
    const approved = await approve(svc, {
      approvalId: APPROVAL,
      requestHash: HASH,
      consumerNodeId: "alice",
      consumerFingerprint: "a".repeat(64),
      document: document(),
      models: [LAB_MODEL],
      capUsd: 1,
      memo: "operator approved after review",
      expiresAt: "2026-10-31T00:10:00.000Z",
    });
    expect(approved.approvalId).toBe(APPROVAL);
    expect(approved.models).toEqual([LAB_MODEL]);
    expect(approved.capUsd).toBe(1);
    expect(approved.quoteHash).toBe(HASH);
    expect(approved.keyName).toBe("ohmyaihub-alice");
    expect(magpie.keys.size).toBe(1);

    const doc = await takeAuthorization(svc, {
      approvalId: APPROVAL,
      consumerNodeId: "alice",
      consumerFingerprint: "a".repeat(64),
      requestHash: HASH,
      models: approved.models,
      capUsd: approved.capUsd,
      quote: { contentHash: HASH, priceVersion: approved.priceVersion, identityFingerprint: FP },
      keyId: approved.keyId,
      keyName: approved.keyName,
    });
    expect(doc.schema).toBe("ohmyaihub.authorization/v2");
    expect(doc.key).toBe(magpie.keyById(approved.keyId)!.secret);
    expect(doc.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify({ ...doc, key: undefined })).not.toContain(doc.key);
    expect(doc.provider).toEqual({ nodeId: NODE, mappedCidr: "10.66.1.2/32", gatewayPort: 3425 });
    expect(doc.consumer).toEqual({ nodeId: "alice", fingerprint: "a".repeat(64) });
  });

  test("a cap change after approval refuses hand-over and never returns a key", async () => {
    const { svc } = realService();
    const approved = await approve(svc, {
      approvalId: APPROVAL,
      requestHash: HASH,
      consumerNodeId: "alice",
      consumerFingerprint: "a".repeat(64),
      document: document(),
      models: [LAB_MODEL],
      capUsd: 1,
      memo: "",
      expiresAt: "2026-10-31T00:10:00.000Z",
    });
    await expect(
      takeAuthorization(svc, {
        approvalId: APPROVAL,
        consumerNodeId: "alice",
        consumerFingerprint: "a".repeat(64),
        requestHash: HASH,
        models: approved.models,
        capUsd: 2,
        quote: { contentHash: HASH, priceVersion: approved.priceVersion, identityFingerprint: FP },
        keyId: approved.keyId,
        keyName: approved.keyName,
      }),
    ).rejects.toThrow(/cap or models changed/);
  });

  test("a changed quote after approval refuses hand-over", async () => {
    const { svc } = realService();
    const approved = await approve(svc, {
      approvalId: APPROVAL,
      requestHash: HASH,
      consumerNodeId: "alice",
      consumerFingerprint: "a".repeat(64),
      document: document(),
      models: [LAB_MODEL],
      capUsd: 1,
      memo: "",
      expiresAt: "2026-10-31T00:10:00.000Z",
    });
    const changed = context();
    changed.quote.contentHash = "9".repeat(64);
    svc.requestApprovalContext = () => changed;
    await expect(
      takeAuthorization(svc, {
        approvalId: APPROVAL,
        consumerNodeId: "alice",
        consumerFingerprint: "a".repeat(64),
        requestHash: HASH,
        models: approved.models,
        capUsd: 1,
        quote: { contentHash: HASH, priceVersion: approved.priceVersion, identityFingerprint: FP },
        keyId: approved.keyId,
        keyName: approved.keyName,
      }),
    ).rejects.toThrow(/published quote changed/);
  });
});

const authorization = (): ControlAuthorizationDocument => ({
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
  keyHash: "0".repeat(64),
  key: "sk-test-key-123456",
});

const approval = (): ControlInboundApproval => ({
  approvalId: APPROVAL,
  requestHash: HASH,
  consumerNodeId: "alice",
  consumerFingerprint: "a".repeat(64),
  providerNodeId: PROVIDER,
  models: [LAB_MODEL],
  capUsd: 1,
  quoteHash: HASH,
  priceVersion: "p".repeat(64),
  expiresAt: "2026-10-31T00:10:00.000Z",
  keyId: "key-1",
  keyName: "ohmyaihub-alice",
});

function importFixture() {
  const calls: any[] = [];
  const service = {
    addProvider: async (input: any) => {
      calls.push({ kind: "add", input });
      return { id: input.id };
    },
    providerModels: async (id: string) => {
      calls.push({ kind: "models", id });
      return { id, models: [LAB_MODEL], limit: { costLimit: 1 } };
    },
    removeProvider: async (id: string) => {
      calls.push({ kind: "remove", id });
      return { id };
    },
    provider: (id: string) => (id === providerIdFor(PROVIDER) ? { id } : undefined),
  } as never;
  return { service, calls };
}

describe("consumer import", () => {
  test("registers once, reads model/cap back and returns the ACK readback", async () => {
    const { service, calls } = importFixture();
    const doc = authorization();
    const { createHash } = await import("node:crypto");
    doc.keyHash = createHash("sha256").update(doc.key).digest("hex");
    const result = await importAuthorization(service, { document: doc, approval: approval(), providerFingerprint: FP });
    expect(result).toEqual({ models: [LAB_MODEL], capUsd: 1, providerId: providerIdFor(PROVIDER) });
    expect(calls[0]).toEqual({
      kind: "add",
      input: { id: providerIdFor(PROVIDER), mappedCidr: "10.66.2.3/32", providerPort: 3425, key: doc.key },
    });
    expect(calls[1]).toEqual({ kind: "models", id: providerIdFor(PROVIDER) });
  });

  test("wrong consumer, provider identity, quote, model/cap, key hash and key generation are refused before registration", async () => {
    const { service, calls } = importFixture();
    const base = authorization();
    const { createHash } = await import("node:crypto");
    base.keyHash = createHash("sha256").update(base.key).digest("hex");
    const cases: [ControlAuthorizationDocument, ControlInboundApproval, string][] = [
      [{ ...base, consumer: { nodeId: "bob", fingerprint: base.consumer.fingerprint } }, approval(), FP],
      [{ ...base, provider: { ...base.provider, nodeId: "9".repeat(16) } }, approval(), FP],
      [{ ...base, quote: { ...base.quote, identityFingerprint: "1".repeat(64) } }, approval(), FP],
      [{ ...base, quote: { ...base.quote, contentHash: "2".repeat(64) } }, approval(), FP],
      [{ ...base, models: ["lab/other"] }, approval(), FP],
      [{ ...base, capUsd: 2 }, approval(), FP],
      [{ ...base, keyId: "key-2" }, approval(), FP],
      [{ ...base, keyHash: "3".repeat(64) }, approval(), FP],
      [base, approval(), "4".repeat(64)],
    ];
    for (const [doc, app, fingerprint] of cases) {
      await expect(importAuthorization(service, { document: doc, approval: app, providerFingerprint: fingerprint })).rejects.toBeInstanceOf(ControlServiceRefusal);
    }
    expect(calls.length).toBe(0);
  });

  test("a provider that reports a different model scope or cap is removed and not ACKed", async () => {
    const { service, calls } = importFixture();
    const doc = authorization();
    const { createHash } = await import("node:crypto");
    doc.keyHash = createHash("sha256").update(doc.key).digest("hex");
    (service as any).providerModels = async (id: string) => ({ id, models: ["lab/other"], limit: { costLimit: 1 } });
    await expect(importAuthorization(service, { document: doc, approval: approval(), providerFingerprint: FP })).rejects.toThrow(/different model scope/);
    expect(calls.some((c) => c.kind === "remove" && c.id === providerIdFor(PROVIDER))).toBe(true);

    const second = importFixture();
    (second.service as any).providerModels = async (id: string) => ({ id, models: [LAB_MODEL], limit: { costLimit: 0.5 } });
    await expect(importAuthorization(second.service, { document: doc, approval: approval(), providerFingerprint: FP })).rejects.toThrow(/did not report the approved cap/);
    expect(second.calls.some((c) => c.kind === "remove")).toBe(true);
  });

  test("drop removes only its own provider id and is idempotent", async () => {
    const { service, calls } = importFixture();
    await dropAuthorization(service, PROVIDER);
    expect(calls).toEqual([{ kind: "remove", id: providerIdFor(PROVIDER) }]);
    const absent = { provider: () => undefined, removeProvider: async () => { throw new Error("must not"); } } as never;
    await dropAuthorization(absent, PROVIDER);
  });
});

describe("B-core approval port adapter", () => {
  function portFixture() {
    const { svc, magpie } = realService();
    const quoteModels = [
      { id: LAB_MODEL, pricing: models[0]!.pricing },
      { id: "lab/other", pricing: models[0]!.pricing },
    ];
    (svc as any).catalogStatus = () => ({
      quote: {
        contentHash: HASH,
        billing: { priceVersion: catalogPriceVersion(quoteModels) },
        identity: { fingerprint: FP },
        models: quoteModels,
      },
    });
    svc.requestApprovalContext = () => ({ provider: { nodeId: NODE, mappedCidr: "10.66.1.2/32", gatewayPort: 3425 }, quote: { contentHash: HASH, identity: { fingerprint: FP }, models: quoteModels } });
    const metas = quoteModels.map((m) => ({ id: m.id, price: LAB_PRICE, displayName: null, gatewayApis: ["chat"], nativeApis: null, contextWindow: null, maxOutputTokens: null, images: null, modalities: null, reasoningLevels: null, priceSource: "magpie-settings", capabilitiesSource: "magpie-settings" }));
    (magpie as any).catalogModels = async () => metas;
    (svc as any).probes.catalogModels = async () => metas;
    const doc = {
      ...document(),
      models: [LAB_MODEL, "lab/other"],
      quote: { ...document().quote, priceVersion: catalogPriceVersion([...models, { id: "lab/other", pricing: models[0]!.pricing }])! },
    };
    return { svc, magpie, doc, port: createApprovalPort(svc) };
  }

  test("validate returns only priced native models and binds the accepted quote", async () => {
    const { port, doc } = portFixture();
    const valid = await port.validateRequest({ requestHash: HASH, request: doc as any, consumer: { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) }, sessionId: "s".repeat(32) });
    expect(valid.models).toEqual([LAB_MODEL, "lab/other"]);
    expect(valid.quoteHash).toBe(HASH);
    expect(valid.priceVersion).toBe(catalogPriceVersion([...models, { id: "lab/other", pricing: models[0]!.pricing }])!);
    await expect(port.validateRequest({ requestHash: HASH, request: { ...doc, quote: { ...doc.quote, contentHash: "9".repeat(64) } } as any, consumer: { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) }, sessionId: "s".repeat(32) })).rejects.toThrow(/current published quote/);
  });

  test("approval returns the price version for the selected subset, not the whole eligible set", async () => {
    const { port, doc, magpie } = portFixture();
    const consumer = { accountId: "a".repeat(64), nodeId: "alice", hostname: "ohmyaihub-alice", fingerprint: "a".repeat(64) };
    await port.validateRequest({ requestHash: HASH, request: doc as any, consumer, sessionId: "s".repeat(32) });
    const result = await port.approveRequest({
      requestHash: HASH,
      approvalId: APPROVAL,
      consumer,
      models: [LAB_MODEL],
      capUsd: 1,
      quoteHash: HASH,
      priceVersion: catalogPriceVersion([...models, { id: "lab/other", pricing: models[0]!.pricing }])!,
    });
    expect(result.models).toEqual([LAB_MODEL]);
    expect(result.capUsd).toBe(1);
    expect(result.priceVersion).toBe(catalogPriceVersion([models[0]!])!);
    expect(magpie.keys.size).toBe(1);
    const material = await port.readKeyMaterial({
      requestHash: HASH,
      approvalId: APPROVAL,
      consumer,
      provider: { nodeId: NODE, fingerprint: FP, mappedCidr: "10.66.1.2/32", gatewayPort: 3425 },
      keyId: result.keyId,
      keyName: result.keyName,
      models: result.models,
      capUsd: result.capUsd,
      quoteHash: HASH,
      priceVersion: result.priceVersion,
    });
    expect(material.key).toBe(magpie.keyById(result.keyId)!.secret);
    await expect(port.readKeyMaterial({
      requestHash: HASH,
      approvalId: APPROVAL,
      consumer,
      provider: { nodeId: NODE, fingerprint: FP, mappedCidr: "10.66.1.2/32", gatewayPort: 3425 },
      keyId: result.keyId,
      keyName: result.keyName,
      models: result.models,
      capUsd: result.capUsd,
      quoteHash: HASH,
      priceVersion: catalogPriceVersion([...models, { id: "lab/other", pricing: models[0]!.pricing }])!,
    })).rejects.toThrow(/different quote|prices changed/);
  });

  test("registerAuthorization maps a v2 document to addProvider/readback and onNotice drops it", async () => {
    const calls: any[] = [];
    const service = {
      addProvider: async (input: any) => { calls.push({ kind: "add", input }); return { id: input.id }; },
      providerModels: async (id: string) => ({ id, models: [LAB_MODEL], limit: { costLimit: 1 } }),
      removeProvider: async (id: string) => { calls.push({ kind: "remove", id }); return { id }; },
      provider: (id: string) => (id === providerIdFor(PROVIDER) ? { id } : undefined),
      revokeConsumer: async () => {},
    } as never;
    const port = createApprovalPort(service);
    const doc = authorization();
    const { createHash } = await import("node:crypto");
    doc.keyHash = createHash("sha256").update(doc.key).digest("hex");
    const result = await port.registerAuthorization({
      provider: { nodeId: PROVIDER, fingerprint: FP, mappedCidr: "10.66.2.3/32", gatewayPort: 3425 },
      consumer: { nodeId: "alice", fingerprint: "a".repeat(64) },
      document: doc,
    });
    expect(result).toEqual({ keyId: doc.keyId, models: [LAB_MODEL], capUsd: 1 });
    await port.onNotice?.({ kind: "revoked", approvalId: APPROVAL, requestHash: HASH, detail: "revoked" });
    expect(calls.some((c) => c.kind === "remove" && c.id === providerIdFor(PROVIDER))).toBe(true);
  });

  test("revokeConsumer is idempotent for a vanished consumer but propagates a real failure", async () => {
    const gone = { revokeConsumer: async () => { throw new Error("no consumer alice"); } } as never;
    await expect(createApprovalPort(gone).revokeConsumer?.({ consumer: { accountId: "", nodeId: "alice", hostname: "", fingerprint: "" }, approvalId: null, reason: "x" })).resolves.toBeUndefined();
    const broken = { revokeConsumer: async () => { throw new Error("magpie refused"); } } as never;
    await expect(createApprovalPort(broken).revokeConsumer?.({ consumer: { accountId: "", nodeId: "alice", hostname: "", fingerprint: "" }, approvalId: null, reason: "x" })).rejects.toThrow(/refused/);
  });
});
