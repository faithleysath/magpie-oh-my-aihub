// The bridge between B-core's business port and the plugin's existing Service.
//
// This module adds no second approval path and no second key store. Provider
// approval calls `Service.approveConnectionRequest`, which already re-validates
// the request against the current signed quote, the sharing policy, the priced
// native models and the existing consumer generation. Provider hand-over calls
// `Service.handover`, which runs the share guard and the Provisioner read-back.
// Consumer import calls `Service.addProvider`, the same path the console uses:
// probe the overlay, register a native Remote Magpie, then read the model list
// and cap back. The plaintext Gateway Key is passed through to B-core for
// sealing and is never stored, logged or cached here.

import { capOnGrid, modelList, type ConnectionRequest } from "../connection-request.ts";
import { sha256Hex } from "../catalog.ts";
import type { Service } from "../service.ts";
import type { ConsumerRecord } from "../provisioner.ts";

export class ControlServiceRefusal extends Error {
  constructor(
    readonly code: "malformed" | "untrusted_peer" | "quote_mismatch" | "conflict" | "expired" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "ControlServiceRefusal";
  }
}

const refuse = (code: ControlServiceRefusal["code"], message: string): never => {
  throw new ControlServiceRefusal(code, message);
};

/** The request document B-core validated and wants the provider to review. */
export interface ControlRequestDocument {
  consumer: { nodeId: string; hostname: string };
  provider: { nodeId: string; hostname: string; mappedCidr: string; gatewayPort: number; catalogPort: number };
  models: string[];
  quote: { contentHash: string; priceVersion: string; identityFingerprint: string; priceLocked: false };
  acceptance: { fingerprint: string; quoteHash: string; priceVersion: string };
}

export interface ControlProviderContext {
  nodeId: string;
  hostname: string;
  mappedCidr: string | null;
  gatewayPort: number;
  catalogPort: number;
  quote: {
    contentHash: string;
    priceVersion: string | null;
    identityFingerprint: string;
    models: { id: string; pricing: unknown }[];
  } | null;
}

export interface ControlApproveInput {
  approvalId: string;
  requestHash: string;
  consumerNodeId: string;
  consumerFingerprint: string;
  document: ControlRequestDocument;
  models: string[];
  capUsd: number;
  memo: string;
  expiresAt: string;
}

export interface ControlApprovalMaterials {
  approvalId: string;
  consumerNodeId: string;
  consumerFingerprint: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  priceVersion: string;
  expiresAt: string;
  keyId: string;
  keyName: string;
  memo: string;
}

export interface ControlTakeAuthorizationInput {
  approvalId: string;
  consumerNodeId: string;
  consumerFingerprint: string;
  requestHash: string;
  models: string[];
  capUsd: number;
  quote: { contentHash: string; priceVersion: string; identityFingerprint: string };
  keyId: string;
  keyName: string;
}

/** Exactly the B-core v2 document; `key` is the only secret. */
export interface ControlAuthorizationDocument {
  schema: "ohmyaihub.authorization/v2";
  createdAt: string;
  provider: { nodeId: string; mappedCidr: string; gatewayPort: number };
  consumer: { nodeId: string; fingerprint: string };
  approvalId: string;
  requestHash: string;
  models: string[];
  capUsd: number;
  quote: { contentHash: string; identityFingerprint: string; priceVersion: string; priceLocked: false };
  keyId: string;
  keyName: string;
  keyHash: string;
  key: string;
}

export interface ControlInboundApproval {
  approvalId: string;
  requestHash: string;
  consumerNodeId: string;
  consumerFingerprint: string;
  providerNodeId: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  priceVersion: string;
  expiresAt: string;
  keyId: string;
  keyName: string;
}

export interface ControlImportInput {
  document: ControlAuthorizationDocument;
  approval: ControlInboundApproval;
  /** the identity B-core verified for the session/authorization */
  providerFingerprint: string;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function currentQuote(service: Service): ControlProviderContext["quote"] {
  const quote = service.catalogStatus().quote;
  if (!quote) return null;
  return {
    contentHash: quote.contentHash,
    priceVersion: quote.billing.priceVersion ?? null,
    identityFingerprint: quote.identity?.fingerprint ?? "",
    models: quote.models.map((m) => ({ id: m.id, pricing: m.pricing })),
  };
}

/** Read-only current state for server-side revalidation. No network, no key. */
export function providerContext(service: Service): ControlProviderContext {
  const cfg = service.config();
  if (!cfg || !cfg.nodeId) return refuse("conflict", "this node is not configured");
  return {
    nodeId: cfg.nodeId,
    hostname: `ohmyaihub-${cfg.nodeId}`,
    mappedCidr: cfg.mappedCidr,
    gatewayPort: service.gatewayPort(),
    catalogPort: cfg.catalog.port,
    quote: currentQuote(service),
  };
}

/**
 * Converts B-core's v2 request into the existing v1 `ConnectionRequest` shape
 * only for the Service call. `Service.approveConnectionRequest` then performs
 * the real validation; this function does not decide whether the request is
 * eligible.
 */
export function toConnectionRequest(document: ControlRequestDocument, capUsd: number): ConnectionRequest {
  const cap = capOnGrid(capUsd);
  const models = modelList(document.models);
  return {
    schema: "ohmyaihub.connection-request/v1",
    consumer: { nodeId: document.consumer.nodeId, hostname: document.consumer.hostname },
    provider: {
      nodeId: document.provider.nodeId,
      hostname: document.provider.hostname,
      mappedCidr: document.provider.mappedCidr,
      gatewayPort: document.provider.gatewayPort,
    },
    models: [...models],
    quote: {
      contentHash: document.quote.contentHash,
      priceVersion: document.quote.priceVersion,
      identityFingerprint: document.quote.identityFingerprint,
      priceLocked: false,
    },
    acceptance: {
      fingerprint: document.acceptance.fingerprint,
      quoteHash: document.acceptance.quoteHash,
      priceVersion: document.acceptance.priceVersion,
    },
    approval: {
      action: "consumers add",
      consumerId: document.consumer.nodeId,
      models: [...models],
      capUsd: cap,
      quoteHash: document.quote.contentHash,
      quotePriceVersion: document.quote.priceVersion,
    },
  };
}

/**
 * Human approval. The caller has already checked TOFU, the request hash and the
 * expiry; Service rechecks the current quote, policy, prices and generation.
 */
export function approve(service: Service, input: ControlApproveInput): Promise<ControlApprovalMaterials> {
  return (async () => {
    const models = modelList(input.models);
    const capUsd = capOnGrid(input.capUsd);
    if (models.some((id) => !input.document.models.includes(id))) {
      return refuse("quote_mismatch", "approved models must be a subset of the request");
    }
    const legacy = toConnectionRequest(input.document, capUsd);
    const view = await service.approveConnectionRequest(legacy, models, capUsd);
    if (view.revokedAt) return refuse("conflict", "the consumer was revoked while approving");
    if (view.models.length !== models.length || !sameSet(view.models, models) || view.capUsd !== capUsd) {
      return refuse("conflict", "the consumer authorization differs from the approved request; review it again");
    }
    if (view.acceptedQuoteHash !== input.document.quote.contentHash) {
      return refuse("quote_mismatch", "the consumer was not bound to the accepted quote");
    }
    return {
      approvalId: input.approvalId,
      consumerNodeId: input.consumerNodeId,
      consumerFingerprint: input.consumerFingerprint,
      models: [...view.models],
      capUsd: view.capUsd,
      quoteHash: input.document.quote.contentHash,
      priceVersion: view.priceVersion ?? input.document.quote.priceVersion,
      expiresAt: input.expiresAt,
      keyId: view.keyId,
      keyName: view.keyName,
      memo: input.memo,
    };
  })();
}

function consumerOf(service: Service, consumerId: string): ConsumerRecord {
  const consumer = service.provisioner.find(consumerId);
  if (!consumer || consumer.revokedAt) return refuse("conflict", "no active consumer authorization");
  return consumer;
}

/**
 * Reads the key once, for B-core to seal. Re-checks the current quote and the
 * Provisioner binding after hand-over, so a price change or a reissue between
 * approval and delivery cannot deliver the old key under the new approval.
 */
export async function takeAuthorization(service: Service, input: ControlTakeAuthorizationInput): Promise<ControlAuthorizationDocument> {
  const before = consumerOf(service, input.consumerNodeId);
  if (before.keyId !== input.keyId || before.keyName !== input.keyName) {
    return refuse("conflict", "the consumer key changed after approval; approve the current key generation again");
  }
  if (before.acceptedQuoteHash !== input.quote.contentHash || before.priceVersion !== input.quote.priceVersion) {
    return refuse("quote_mismatch", "the consumer is bound to a different quote than this approval");
  }
  if (before.capUsd !== input.capUsd || before.models.length !== input.models.length || !sameSet(before.models, input.models)) {
    return refuse("conflict", "the consumer cap or models changed after approval; approve again");
  }
  const context = service.requestApprovalContext();
  if (context.provider.nodeId !== null && context.provider.nodeId !== undefined) {
    // requestApprovalContext is local; no provider id check is needed for a
    // non-sharing node, but a published quote must still be the accepted one.
    if (context.quote && context.quote.contentHash !== input.quote.contentHash) {
      return refuse("quote_mismatch", "the published quote changed after approval; ask the consumer to re-read it");
    }
    if (context.quote && context.quote.identity?.fingerprint !== input.quote.identityFingerprint) {
      return refuse("quote_mismatch", "the published identity changed after approval");
    }
    if (!context.quote) return refuse("quote_mismatch", "this provider no longer publishes the accepted quote");
  }
  const handover = await service.handover(input.consumerNodeId);
  const after = consumerOf(service, input.consumerNodeId);
  if (after.keyId !== input.keyId || after.keyName !== input.keyName) {
    return refuse("conflict", "the consumer key changed during hand-over; nothing was sent");
  }
  if (handover.capUsd !== input.capUsd || handover.models.length !== input.models.length || !sameSet(handover.models, input.models)) {
    return refuse("conflict", "the consumer cap or models changed during hand-over; nothing was sent");
  }
  if (after.acceptedQuoteHash !== input.quote.contentHash || after.priceVersion !== input.quote.priceVersion) {
    return refuse("quote_mismatch", "the consumer quote binding changed during hand-over; nothing was sent");
  }
  const cfg = service.config();
  if (!cfg?.nodeId) return refuse("conflict", "this node lost its configuration");
  const mapped = cfg.mappedCidr;
  if (!mapped) return refuse("conflict", "this node has no published overlay address");
  const keyHash = sha256Hex(Buffer.from(handover.key, "utf8"));
  return {
    schema: "ohmyaihub.authorization/v2",
    createdAt: new Date().toISOString(),
    provider: { nodeId: cfg.nodeId, mappedCidr: mapped, gatewayPort: service.gatewayPort() },
    consumer: { nodeId: input.consumerNodeId, fingerprint: input.consumerFingerprint },
    approvalId: input.approvalId,
    requestHash: input.requestHash,
    models: [...handover.models],
    capUsd: handover.capUsd,
    quote: {
      contentHash: input.quote.contentHash,
      identityFingerprint: input.quote.identityFingerprint,
      priceVersion: input.quote.priceVersion,
      priceLocked: false,
    },
    keyId: after.keyId,
    keyName: handover.keyName,
    keyHash,
    key: handover.key,
  };
}

function providerIdFor(providerNodeId: string): string {
  return `p2p-${sha256Hex(providerNodeId).slice(0, 16)}`;
}

function assertAuthorization(document: ControlAuthorizationDocument, approval: ControlInboundApproval, providerFingerprint: string): void {
  if (document.schema !== "ohmyaihub.authorization/v2") return refuse("malformed", "not an authorization/v2 document");
  if (document.approvalId !== approval.approvalId || document.requestHash !== approval.requestHash) {
    return refuse("conflict", "the authorization belongs to another approval");
  }
  if (document.consumer.nodeId !== approval.consumerNodeId || document.consumer.fingerprint !== approval.consumerFingerprint) {
    return refuse("untrusted_peer", "the authorization is addressed to another consumer");
  }
  if (document.provider.nodeId !== approval.providerNodeId) return refuse("untrusted_peer", "the authorization names another provider");
  if (document.quote.identityFingerprint !== providerFingerprint) return refuse("untrusted_peer", "the provider identity differs from the approved session");
  if (document.quote.contentHash !== approval.quoteHash || document.quote.priceVersion !== approval.priceVersion) {
    return refuse("quote_mismatch", "the authorization quote differs from the approval");
  }
  if (document.models.length !== approval.models.length || !sameSet(document.models, approval.models) || document.capUsd !== approval.capUsd) {
    return refuse("conflict", "the authorization models or cap differ from the approval");
  }
  if (document.keyId !== approval.keyId || document.keyName !== approval.keyName) {
    return refuse("conflict", "the authorization key generation differs from the approval");
  }
  if (typeof document.key !== "string" || document.key.length < 8 || document.key.length > 512 || /[\s\x00-\x1f]/.test(document.key)) {
    return refuse("malformed", "the authorization key is malformed");
  }
  if (sha256Hex(Buffer.from(document.key, "utf8")) !== document.keyHash) return refuse("malformed", "the authorization key does not match its hash");
  const models = modelList(document.models);
  if (!sameSet(models, approval.models)) return refuse("conflict", "the authorization model list changed");
  capOnGrid(document.capUsd);
}

/**
 * Consumer import. Registers the provider through the existing `addProvider`
 * path, then reads the model scope and cap back from the provider's own
 * gateway. A mismatch removes the Remote this call created and reports failure;
 * no ACK may claim `registered`.
 */
export async function importAuthorization(service: Service, input: ControlImportInput): Promise<{ models: string[]; capUsd: number; providerId: string }> {
  assertAuthorization(input.document, input.approval, input.providerFingerprint);
  const document = input.document;
  const providerId = providerIdFor(document.provider.nodeId);
  let registered = false;
  try {
    const view = await service.addProvider({
      id: providerId,
      mappedCidr: document.provider.mappedCidr,
      providerPort: document.provider.gatewayPort,
      key: document.key,
    });
    registered = true;
    const readback = await service.providerModels(view.id);
    const models = readback.models;
    if (models.length !== document.models.length || !sameSet(models, document.models)) {
      return refuse("conflict", "the provider served a different model scope than the authorization");
    }
    const cap = readback.limit?.costLimit;
    if (typeof cap !== "number" || !Number.isFinite(cap) || Math.abs(cap - document.capUsd) > 1e-9) {
      return refuse("conflict", "the provider did not report the approved cap");
    }
    return { models: [...models], capUsd: cap, providerId };
  } catch (error) {
    if (registered) {
      // Only remove an entry this call just proved ours; removeProvider itself
      // checks ownership and never touches a foreign Magpie entry.
      await service.removeProvider(providerId).catch(() => {});
    }
    throw error;
  }
}

/** Remove only the Remote this plugin registered for a revoked approval. */
export async function dropAuthorization(service: Service, providerNodeId: string): Promise<void> {
  const id = providerIdFor(providerNodeId);
  if (!service.provider(id)) return;
  await service.removeProvider(id);
}

export { providerIdFor };
