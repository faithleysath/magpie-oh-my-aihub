// The B-service implementation of the reviewed B-core business port.
//
// This module deliberately mirrors the *shape* of B-core PR #26's
// `P2pBusinessPort` (commit fdc7d4c49e70735c4188f6816ed611fd745455c7) without
// importing that unreviewed module. The source types are repeated locally so
// this branch compiles and can be tested with a fake Magpie now; when the core
// commit is approved, only the type imports change, not the Service calls.
//
// It owns no crypto, no session, no envelope and no Gateway Key storage. It adds
// exactly two pieces of durable consumer-side state, both non-secret:
//   1. which approval/generation owns which native Remote id;
//   2. the provider node/fingerprint and selected model/cap snapshot for that
//      Remote, so a restart can remove only the revoked approval's Remote.
// The file is written atomically (0600) and contains no key, ciphertext or
// authorization document.
//
// Old authorization protection is fail-closed: a provider has at most one live
// Remote owned by this plugin. A different approval for the same provider is
// refused until the previous approval is explicitly revoked/removed. We never
// replace an existing Remote in this port, so an old delivery cannot overwrite
// a newer one; B-core also binds delivery hashes and audit state.

import { existsSync } from "node:fs";
import { statePath } from "../paths.ts";
import { readJsonWithBackup, writeJsonAtomic } from "../store.ts";
import { catalogPriceVersion } from "../pricing.ts";
import { capOnGrid, modelList } from "../connection-request.ts";
import type { Service } from "../service.ts";
import {
  ControlServiceRefusal,
  approve,
  importAuthorization as importAuthorizationWithService,
  providerIdFor,
  takeAuthorization as takeAuthorizationWithService,
  type ControlAuthorizationDocument,
  type ControlInboundApproval,
  type ControlRequestDocument,
} from "./service-port.ts";

export type P2pRequestDocument = ControlRequestDocument;
export type P2pAuthorizationDocument = ControlAuthorizationDocument;
export type P2pRevokeReason =
  | "operator-revoked"
  | "key-rotated"
  | "price-changed"
  | "policy"
  | "consumer-cancelled"
  | "account-closed";

export interface P2pPeerView {
  accountId: string;
  nodeId: string;
  hostname: string;
  fingerprint: string;
}

export interface P2pPeerIdentity {
  accountId: string;
  nodeId: string;
  hostname: string;
  publicKey: string;
  fingerprint: string;
}

export interface P2pProviderContext {
  nodeId: string;
  hostname: string;
  mappedCidr: string | null;
  gatewayPort: number | null;
  catalogPort: number | null;
  sharing: "enabled" | "disabled" | "suspended";
  quote: { contentHash: string; identityFingerprint: string; models: string[] } | null;
}

export interface P2pRequestValidationInput {
  requestHash: string;
  request: P2pRequestDocument;
  consumer: P2pPeerView;
  sessionId: string;
}

export interface P2pRequestValidation {
  models: string[];
  quoteHash: string;
  /** price version for the REQUESTED set, not the approved subset */
  priceVersion: string;
  expiresAt: string;
}

export interface P2pRecordedRequest {
  requestHash: string;
  request: P2pRequestDocument;
  consumer: P2pPeerView;
  sessionId: string;
  firstSeenAt: string;
  expiresAt: string;
}

export interface P2pApprovalRequest {
  approvalId: string;
  generation: number;
  requestHash: string;
  request: P2pRequestDocument;
  consumer: P2pPeerView;
  models: string[];
  capUsd: number;
  memo: string | null;
  quote: { contentHash: string; identityFingerprint: string };
}

export interface P2pApprovedMaterials {
  approvalId: string;
  generation: number;
  consumerNodeId: string;
  consumerFingerprint: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  priceVersion: string;
  expiresAt: string;
  keyId: string;
  keyName: string;
  memo: string | null;
}

export interface P2pTakeAuthorizationInput {
  approvalId: string;
  generation: number;
  consumerNodeId: string;
  consumerFingerprint: string;
  requestHash: string;
  models: string[];
  capUsd: number;
  quote: { contentHash: string; priceVersion: string; identityFingerprint: string };
  keyId: string;
  keyName: string;
}

export interface P2pAckRecord {
  approvalId: string;
  generation: number;
  authorizationHash: string;
  state: "registered" | "delivery-failed";
  readback: { models: string[]; capUsd: number } | null;
  detail: string | null;
}

export interface P2pRevokeRequest {
  consumerNodeId: string;
  approvalId: string | null;
  reason: P2pRevokeReason;
}

export interface P2pInboundApproval {
  approvalId: string;
  generation: number;
  requestHash: string;
  consumerNodeId: string;
  consumerFingerprint: string;
  providerNodeId: string;
  providerFingerprint: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  priceVersion: string;
  expiresAt: string;
  keyId: string;
  keyName: string;
}

export interface P2pBusinessPort {
  providerContext(): Promise<P2pProviderContext>;
  validateRequest(input: P2pRequestValidationInput): Promise<P2pRequestValidation>;
  recordRequest(input: P2pRecordedRequest): Promise<boolean>;
  approve(input: P2pApprovalRequest): Promise<P2pApprovedMaterials>;
  takeAuthorization(input: P2pTakeAuthorizationInput): Promise<P2pAuthorizationDocument>;
  recordAck(input: P2pAckRecord): Promise<void>;
  revoke(input: P2pRevokeRequest): Promise<void | { revoked: boolean; detail: string | null }>;
  recordApproval(input: P2pInboundApproval): Promise<void>;
  importAuthorization(input: {
    document: P2pAuthorizationDocument;
    approval: P2pInboundApproval;
    session: { sessionId: string; peer: P2pPeerIdentity };
  }): Promise<{ models: string[]; capUsd: number }>;
  dropAuthorization(input: {
    approvalId: string;
    consumerNodeId: string;
    providerNodeId: string | null;
    providerFingerprint: string | null;
    reason: P2pRevokeReason;
  }): Promise<void>;
}

// --- durable, non-secret consumer Remote ownership ---------------------------

interface RemoteRecord {
  providerNodeId: string;
  providerFingerprint: string;
  approvalId: string;
  generation: number;
  keyId: string;
  providerId: string;
  models: string[];
  capUsd: number;
  updatedAt: string;
}

interface RemotesState {
  version: 1;
  remotes: RemoteRecord[];
}

const MAX_REMOTES = 200;
const PROVIDER_ID_RE = /^p2p-[0-9a-f]{16}$/;

function emptyState(): RemotesState {
  return { version: 1, remotes: [] };
}

function parseState(raw: unknown): RemotesState {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || o.version !== 1 || !Array.isArray(o.remotes) || o.remotes.length > MAX_REMOTES) {
    throw new ControlServiceRefusal("internal", "the control Remote ownership file is corrupt; refusing to change any Remote");
  }
  const remotes: RemoteRecord[] = [];
  for (const entry of o.remotes) {
    const r = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    if (!r) throw new ControlServiceRefusal("internal", "the control Remote ownership file is corrupt; refusing to change any Remote");
    const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
    if (
      !text(r.providerNodeId) ||
      !text(r.providerFingerprint) ||
      !text(r.approvalId) ||
      !Number.isInteger(r.generation) ||
      (r.generation as number) < 0 ||
      !text(r.keyId) ||
      !text(r.providerId) ||
      !PROVIDER_ID_RE.test(String(r.providerId)) ||
      !Array.isArray(r.models) ||
      r.models.some((m) => typeof m !== "string") ||
      typeof r.capUsd !== "number" ||
      !Number.isFinite(r.capUsd) ||
      !text(r.updatedAt)
    ) {
      throw new ControlServiceRefusal("internal", "the control Remote ownership file is corrupt; refusing to change any Remote");
    }
    remotes.push({
      providerNodeId: String(r.providerNodeId),
      providerFingerprint: String(r.providerFingerprint),
      approvalId: String(r.approvalId),
      generation: Number(r.generation),
      keyId: String(r.keyId),
      providerId: String(r.providerId),
      models: r.models.map(String),
      capUsd: r.capUsd,
      updatedAt: String(r.updatedAt),
    });
  }
  if (new Set(remotes.map((r) => r.providerNodeId)).size !== remotes.length) {
    throw new ControlServiceRefusal("internal", "the control Remote ownership file lists a provider twice; refusing to change any Remote");
  }
  return { version: 1, remotes };
}

function loadState(file: string): RemotesState {
  if (!existsSync(file)) return emptyState();
  const read = readJsonWithBackup<unknown>(file);
  if (read.value === null) {
    throw new ControlServiceRefusal("internal", "the control Remote ownership file is unreadable; refusing to change any Remote");
  }
  return parseState(read.value);
}

function saveState(file: string, state: RemotesState): void {
  writeJsonAtomic(file, { version: 1, remotes: state.remotes.slice(-MAX_REMOTES) }, 0o600);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function providerContextOf(service: Service): P2pProviderContext {
  const cfg = service.config();
  if (!cfg?.nodeId) throw new ControlServiceRefusal("conflict", "this node is not configured");
  const snapshot = service.statusSnapshotForTest();
  const quote = service.catalogStatus().quote;
  return {
    nodeId: cfg.nodeId,
    hostname: `ohmyaihub-${cfg.nodeId}`,
    mappedCidr: cfg.mappedCidr,
    gatewayPort: service.gatewayPort(),
    catalogPort: cfg.catalog?.port ?? null,
    sharing: snapshot.config.shareSuspended ? "suspended" : cfg.sharingEnabled ? "enabled" : "disabled",
    quote: quote
      ? { contentHash: quote.contentHash, identityFingerprint: quote.identity?.fingerprint ?? "", models: quote.models.map((m) => m.id) }
      : null,
  };
}

function checkProviderDocument(input: P2pRequestValidationInput, context: P2pProviderContext): string {
  const request = input.request;
  if (request.consumer.nodeId !== input.consumer.nodeId) {
    throw new ControlServiceRefusal("untrusted_peer", "the request consumer is not the session peer");
  }
  if (request.provider.nodeId !== context.nodeId || request.provider.mappedCidr !== context.mappedCidr || request.provider.gatewayPort !== context.gatewayPort) {
    throw new ControlServiceRefusal("quote_mismatch", "the request targets a different provider address");
  }
  if (!context.quote || context.quote.contentHash !== request.quote.contentHash || context.quote.identityFingerprint !== request.quote.identityFingerprint) {
    throw new ControlServiceRefusal("quote_mismatch", "the request's accepted quote is not this node's current published quote");
  }
  return context.quote.contentHash;
}

export interface P2pBusinessPortOptions {
  /** injectable for tests; defaults to statePath("control-remotes.json") */
  stateFile?: string;
  now?: () => Date;
}

/**
 * Builds the port. The returned object is the only integration point B-core
 * needs; all Service calls are the existing approval/handover/registration
 * paths, not copies.
 */
export function createP2pBusinessPort(service: Service, options: P2pBusinessPortOptions = {}): P2pBusinessPort {
  const stateFile = options.stateFile ?? statePath("control-remotes.json");
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    async providerContext() {
      return providerContextOf(service);
    },

    async validateRequest(input) {
      const context = providerContextOf(service);
      const quoteHash = checkProviderDocument(input, context);
      const quote = service.catalogStatus().quote;
      if (!quote) throw new ControlServiceRefusal("quote_mismatch", "this provider has no published quote");
      const requestedVersion = catalogPriceVersion(quote.models.filter((m) => input.request.models.includes(m.id)));
      if (!requestedVersion || requestedVersion !== input.request.quote.priceVersion) {
        throw new ControlServiceRefusal("quote_mismatch", "the request's accepted price version is not current for those models");
      }
      const candidates = await service.shareCandidates();
      const eligible = input.request.models.filter((id) => candidates.models.some((m) => m.id === id && m.allowedByPolicy && m.completePrice));
      if (eligible.length === 0) throw new ControlServiceRefusal("no_shared_models", "none of the requested models is a currently priced native model allowed by policy");
      return {
        models: eligible,
        quoteHash,
        // B-core uses this only for the requested-set offer; the approved
        // subset's version is returned by approve() below.
        priceVersion: requestedVersion,
        expiresAt: new Date(now().getTime() + 10 * 60_000).toISOString(),
      };
    },

    async recordRequest() {
      // B-core's SQLite request row is authoritative. This port deliberately
      // keeps no second request/key journal; the UI reads B-core views.
      return true;
    },

    async approve(input) {
      const models = modelList(input.models);
      const capUsd = capOnGrid(input.capUsd);
      if (input.request.quote.contentHash !== input.quote.contentHash || input.request.quote.identityFingerprint !== input.quote.identityFingerprint) {
        throw new ControlServiceRefusal("quote_mismatch", "the approval quote differs from the stored request");
      }
      const expiresAt = new Date(now().getTime() + 10 * 60_000).toISOString();
      const materials = await approve(service, {
        approvalId: input.approvalId,
        requestHash: input.requestHash,
        consumerNodeId: input.consumer.nodeId,
        consumerFingerprint: input.consumer.fingerprint,
        document: input.request,
        models,
        capUsd,
        memo: input.memo ?? "",
        expiresAt,
      });
      if (materials.quoteHash !== input.quote.contentHash) throw new ControlServiceRefusal("quote_mismatch", "the Service approved a different quote");
      return {
        approvalId: input.approvalId,
        generation: input.generation,
        consumerNodeId: input.consumer.nodeId,
        consumerFingerprint: input.consumer.fingerprint,
        models: materials.models,
        capUsd: materials.capUsd,
        quoteHash: materials.quoteHash,
        priceVersion: materials.priceVersion,
        expiresAt: materials.expiresAt,
        keyId: materials.keyId,
        keyName: materials.keyName,
        memo: input.memo,
      };
    },

    async takeAuthorization(input) {
      return takeAuthorizationWithService(service, {
        approvalId: input.approvalId,
        consumerNodeId: input.consumerNodeId,
        consumerFingerprint: input.consumerFingerprint,
        requestHash: input.requestHash,
        models: input.models,
        capUsd: input.capUsd,
        quote: input.quote,
        keyId: input.keyId,
        keyName: input.keyName,
      });
    },

    async recordAck() {
      // B-core stores the ACK/readback; this port must not write a second copy.
    },

    async revoke(input) {
      const result = await service.provisioner.revokeEnforced(input.consumerNodeId);
      return { revoked: result.revoked, detail: result.detail };
    },

    async recordApproval() {
      // B-core stores the inbound approval/generation; no local key or state here.
    },

    async importAuthorization(input) {
      const document = input.document;
      const approval = input.approval;
      if (document.provider.nodeId !== approval.providerNodeId || document.consumer.nodeId !== approval.consumerNodeId) {
        throw new ControlServiceRefusal("untrusted_peer", "the authorization names another provider or consumer");
      }
      if (input.session.peer.nodeId !== approval.providerNodeId || input.session.peer.fingerprint !== approval.providerFingerprint) {
        throw new ControlServiceRefusal("untrusted_peer", "the authorization session peer differs from the approval");
      }
      if (document.quote.identityFingerprint !== approval.providerFingerprint) {
        throw new ControlServiceRefusal("untrusted_peer", "the authorization provider key differs from the approved session");
      }
      return serial(async () => {
        const state = loadState(stateFile);
        const current = state.remotes.find((r) => r.providerNodeId === approval.providerNodeId);
        const providerId = providerIdFor(approval.providerNodeId, approval.approvalId);
        if (current && current.approvalId !== approval.approvalId) {
          // Never replace a live Remote with another approval. If the old
          // Remote is already gone (user removed it), the mapping is stale and
          // may be cleared.
          if (service.provider(current.providerId)) {
            throw new ControlServiceRefusal("conflict", "another authorization already owns this provider; revoke it before importing a new one");
          }
          state.remotes = state.remotes.filter((r) => r.providerNodeId !== approval.providerNodeId);
        }
        if (current && current.approvalId === approval.approvalId) {
          if (current.generation !== approval.generation || current.keyId !== document.keyId || current.providerId !== providerId) {
            throw new ControlServiceRefusal("conflict", "this approval's key generation changed; refuse to replace the Remote");
          }
        }
        const inboundApproval: ControlInboundApproval = {
          approvalId: document.approvalId,
          requestHash: document.requestHash,
          consumerNodeId: document.consumer.nodeId,
          consumerFingerprint: document.consumer.fingerprint,
          providerNodeId: document.provider.nodeId,
          models: document.models,
          capUsd: document.capUsd,
          quoteHash: document.quote.contentHash,
          priceVersion: document.quote.priceVersion,
          expiresAt: approval.expiresAt,
          keyId: document.keyId,
          keyName: document.keyName,
        };
        const result = await importAuthorizationWithService(service, {
          document,
          approval: inboundApproval,
          providerFingerprint: approval.providerFingerprint,
          providerId,
        });
        // Save ownership only after registration/readback succeeded. The write
        // is atomic and contains no key. If it fails, remove the Remote so the
        // next attempt cannot be mistaken for a different approval's Remote.
        const record: RemoteRecord = {
          providerNodeId: approval.providerNodeId,
          providerFingerprint: approval.providerFingerprint,
          approvalId: approval.approvalId,
          generation: approval.generation,
          keyId: document.keyId,
          providerId,
          models: [...result.models],
          capUsd: result.capUsd,
          updatedAt: now().toISOString(),
        };
        const next: RemotesState = { version: 1, remotes: [...state.remotes.filter((r) => r.providerNodeId !== approval.providerNodeId), record] };
        try {
          saveState(stateFile, next);
        } catch (error) {
          await service.removeProvider(providerId).catch(() => {});
          throw error;
        }
        return { models: result.models, capUsd: result.capUsd };
      });
    },

    async dropAuthorization(input) {
      return serial(async () => {
        const state = loadState(stateFile);
        const current = state.remotes.find((r) => r.providerNodeId === input.providerNodeId);
        const target = state.remotes.find((r) => r.approvalId === input.approvalId);
        if (current && current.approvalId !== input.approvalId) {
          // A newer authorization owns this provider. An old revocation must
          // never remove it; if the old record still exists separately, leave it
          // for a later explicit repair.
          return;
        }
        if (target) {
          await service.removeProvider(target.providerId);
          const next = state.remotes.filter((r) => r.approvalId !== input.approvalId && r.providerNodeId !== target.providerNodeId);
          saveState(stateFile, { version: 1, remotes: next });
          return;
        }
        if (!input.providerNodeId) return;
        const providerId = providerIdFor(input.providerNodeId, input.approvalId);
        if (service.provider(providerId)) await service.removeProvider(providerId);
      });
    },
  };
}

/** Read-only ownership view for diagnostics/tests; no key or ciphertext. */
export function controlRemotes(file = statePath("control-remotes.json")): RemotesState {
  return loadState(file);
}

export { providerIdFor };
