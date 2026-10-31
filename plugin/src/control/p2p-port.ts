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

export interface P2pApprovalReconcileInput {
  requestHash: string;
  approvalId: string;
  generation: number;
  consumer: P2pPeerView;
  keyId: string | null;
}

export interface P2pApprovalReconcileBinding {
  consumerNodeId: string;
  requestHash: string;
  approvalId: string;
  generation: number;
  knownKeyId: string | null;
  observedAt: string;
  /** where the observation came from; never a key or ciphertext */
  source: "journal+native" | "journal" | "native-management" | "none";
}

export type P2pApprovalReconcile =
  | (P2pApprovalReconcileBinding & {
      state: "keyReady";
      keyId: string;
      keyName: string;
      models: string[];
      capUsd: number;
      priceVersion: string;
      expiresAt: string;
      detail: string | null;
    })
  | (P2pApprovalReconcileBinding & { state: "noSideEffect"; knownKeyId: null; detail: string | null })
  | (P2pApprovalReconcileBinding & { state: "unknown"; detail: string | null });

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
  approvalId: string;
  /** the key id recorded for this approval; null when it was never confirmed */
  keyId: string | null;
  generation: number;
  reason: P2pRevokeReason;
}

/** Only these two enforcement modes prove the native key can no longer be used. */
export type P2pRevokeEnforcement = "keyRevoked" | "secretRotated";

export interface P2pRevokeConfirmed {
  revoked: true;
  enforcement: P2pRevokeEnforcement;
  consumerNodeId: string;
  approvalId: string;
  keyId: string;
  generation: number;
  detail: string | null;
}

export interface P2pRevokeRefused {
  revoked: false;
  enforcement: "none" | "capRestricted" | "networkWithdrawn" | "safetyUncertain" | "failed";
  detail: string | null;
}

export type P2pRevokeOutcome = P2pRevokeConfirmed | P2pRevokeRefused;

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
  /** Read-only recovery of an interrupted approval; must not create/rotate a key. */
  reconcileApproval?(input: P2pApprovalReconcileInput): Promise<P2pApprovalReconcile>;
  takeAuthorization(input: P2pTakeAuthorizationInput): Promise<P2pAuthorizationDocument>;
  recordAck(input: P2pAckRecord): Promise<void>;
  revoke(input: P2pRevokeRequest): Promise<P2pRevokeOutcome>;
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
  /** injectable for tests; defaults to statePath("control-approvals.json") */
  approvalStateFile?: string;
  now?: () => Date;
}

// --- durable, non-secret provider approval journal --------------------------
//
// B-core owns the authoritative approval rows. This journal exists only for
// B-service idempotency and old-key protection across retries/restarts: it binds
// approvalId/requestHash/generation to the Provisioner keyId and selected
// snapshot, and contains no Gateway Key, secret or authorization document.

type ApprovalState = "pending" | "approved" | "uncertain" | "revoked";

interface ApprovalRecord {
  approvalId: string;
  requestHash: string;
  generation: number;
  consumerNodeId: string;
  consumerFingerprint: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  priceVersion: string;
  expiresAt: string;
  keyId: string | null;
  keyName: string | null;
  memo: string | null;
  state: ApprovalState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ApprovalsState {
  version: 1;
  approvals: ApprovalRecord[];
}

const MAX_APPROVALS = 200;

function emptyApprovals(): ApprovalsState {
  return { version: 1, approvals: [] };
}

function parseApprovals(raw: unknown): ApprovalsState {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || o.version !== 1 || !Array.isArray(o.approvals) || o.approvals.length > MAX_APPROVALS) {
    throw new ControlServiceRefusal("internal", "the control approval journal is corrupt; refusing to approve or revoke");
  }
  const approvals: ApprovalRecord[] = [];
  for (const entry of o.approvals) {
    const r = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    if (!r) throw new ControlServiceRefusal("internal", "the control approval journal is corrupt; refusing to approve or revoke");
    const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
    const maybeText = (v: unknown) => v === null || text(v);
    if (
      !text(r.approvalId) ||
      !text(r.requestHash) ||
      !Number.isInteger(r.generation) ||
      (r.generation as number) < 0 ||
      !text(r.consumerNodeId) ||
      !text(r.consumerFingerprint) ||
      !Array.isArray(r.models) ||
      r.models.some((m) => typeof m !== "string") ||
      typeof r.capUsd !== "number" ||
      !Number.isFinite(r.capUsd) ||
      !text(r.quoteHash) ||
      !text(r.priceVersion) ||
      !text(r.expiresAt) ||
      !maybeText(r.keyId) ||
      !maybeText(r.keyName) ||
      !maybeText(r.memo) ||
      !["pending", "approved", "uncertain", "revoked"].includes(String(r.state)) ||
      !maybeText(r.error) ||
      !text(r.createdAt) ||
      !text(r.updatedAt)
    ) {
      throw new ControlServiceRefusal("internal", "the control approval journal is corrupt; refusing to approve or revoke");
    }
    approvals.push({
      approvalId: String(r.approvalId),
      requestHash: String(r.requestHash),
      generation: Number(r.generation),
      consumerNodeId: String(r.consumerNodeId),
      consumerFingerprint: String(r.consumerFingerprint),
      models: r.models.map(String),
      capUsd: r.capUsd,
      quoteHash: String(r.quoteHash),
      priceVersion: String(r.priceVersion),
      expiresAt: String(r.expiresAt),
      keyId: r.keyId === null ? null : String(r.keyId),
      keyName: r.keyName === null ? null : String(r.keyName),
      memo: r.memo === null ? null : String(r.memo),
      state: r.state as ApprovalState,
      error: r.error === null ? null : String(r.error),
      createdAt: String(r.createdAt),
      updatedAt: String(r.updatedAt),
    });
  }
  return { version: 1, approvals };
}

function loadApprovals(file: string): ApprovalsState {
  if (!existsSync(file)) return emptyApprovals();
  const read = readJsonWithBackup<unknown>(file);
  if (read.value === null) throw new ControlServiceRefusal("internal", "the control approval journal is unreadable; refusing to approve or revoke");
  return parseApprovals(read.value);
}

function saveApprovals(file: string, state: ApprovalsState): void {
  writeJsonAtomic(file, { version: 1, approvals: state.approvals.slice(-MAX_APPROVALS) }, 0o600);
}

function recordFor(input: P2pApprovalRequest, at: string): ApprovalRecord {
  return {
    approvalId: input.approvalId,
    requestHash: input.requestHash,
    generation: input.generation,
    consumerNodeId: input.consumer.nodeId,
    consumerFingerprint: input.consumer.fingerprint,
    models: [...input.models],
    capUsd: input.capUsd,
    quoteHash: input.quote.contentHash,
    priceVersion: "",
    expiresAt: "",
    keyId: null,
    keyName: null,
    memo: input.memo ?? null,
    state: "pending",
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}

function materialsFrom(record: ApprovalRecord): P2pApprovedMaterials {
  if (!record.keyId || !record.keyName) throw new ControlServiceRefusal("internal", "the approval journal has no key binding");
  return {
    approvalId: record.approvalId,
    generation: record.generation,
    consumerNodeId: record.consumerNodeId,
    consumerFingerprint: record.consumerFingerprint,
    models: [...record.models],
    capUsd: record.capUsd,
    quoteHash: record.quoteHash,
    priceVersion: record.priceVersion,
    expiresAt: record.expiresAt,
    keyId: record.keyId,
    keyName: record.keyName,
    memo: record.memo,
  };
}

function recoverApproval(record: ApprovalRecord, service: Service, at: string): ApprovalRecord | null {
  const rec = service.provisioner.find(record.consumerNodeId);
  if (!rec || rec.revokedAt || !rec.keyId || !rec.keyName) return null;
  if (rec.acceptedQuoteHash !== record.quoteHash) return null;
  if (rec.capUsd !== record.capUsd || !sameSet(rec.models, record.models)) return null;
  return {
    ...record,
    keyId: rec.keyId,
    keyName: rec.keyName,
    priceVersion: rec.priceVersion ?? record.priceVersion,
    expiresAt: record.expiresAt || new Date(Date.parse(at) + 10 * 60_000).toISOString(),
    state: "approved",
    error: null,
    updatedAt: at,
  };
}

/** Read-only lookup for recovery/UI; no key material. */
export function lookupControlApproval(approvalId: string, file = statePath("control-approvals.json")): ApprovalRecord | null {
  return loadApprovals(file).approvals.find((a) => a.approvalId === approvalId) ?? null;
}

export function lookupControlRequest(requestHash: string, file = statePath("control-approvals.json")): ApprovalRecord | null {
  return loadApprovals(file)
    .approvals.filter((a) => a.requestHash === requestHash)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1) ?? null;
}

/**
 * Builds the port. The returned object is the only integration point B-core
 * needs; all Service calls are the existing approval/handover/registration
 * paths, not copies.
 */
export function createP2pBusinessPort(service: Service, options: P2pBusinessPortOptions = {}): P2pBusinessPort {
  const stateFile = options.stateFile ?? statePath("control-remotes.json");
  const approvalStateFile = options.approvalStateFile ?? statePath("control-approvals.json");
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
      return serial(async () => {
        const at = now().toISOString();
        const state = loadApprovals(approvalStateFile);
        const existing = state.approvals.find((a) => a.approvalId === input.approvalId);
        if (existing) {
          if (
            existing.requestHash !== input.requestHash ||
            existing.generation !== input.generation ||
            existing.consumerNodeId !== input.consumer.nodeId ||
            existing.consumerFingerprint !== input.consumer.fingerprint ||
            existing.quoteHash !== input.quote.contentHash ||
            Math.abs(existing.capUsd - capUsd) > 1e-9 ||
            !sameSet(existing.models, models)
          ) {
            throw new ControlServiceRefusal("conflict", "the approval id is already bound to a different decision");
          }
          if (existing.state === "approved") return materialsFrom(existing);
          if (existing.state === "revoked") throw new ControlServiceRefusal("conflict", "this approval was already revoked");
          const recovered = recoverApproval(existing, service, at);
          if (recovered) {
            saveApprovals(approvalStateFile, { version: 1, approvals: state.approvals.map((a) => (a.approvalId === existing.approvalId ? recovered : a)) });
            return materialsFrom(recovered);
          }
          throw new ControlServiceRefusal("conflict", "this approval was already attempted and no second key will be created");
        }
        const sameRequest = state.approvals.find((a) => a.requestHash === input.requestHash && a.state !== "revoked");
        if (sameRequest) {
          throw new ControlServiceRefusal("conflict", "this request already has an approval attempt; do not create a second key");
        }
        const sameConsumer = state.approvals.find((a) => a.consumerNodeId === input.consumer.nodeId && a.state !== "revoked");
        if (sameConsumer) {
          throw new ControlServiceRefusal("conflict", "this consumer already has an active approval; revoke it before a new one");
        }

        const pending = recordFor(input, at);
        saveApprovals(approvalStateFile, { version: 1, approvals: [...state.approvals, pending] });
        const expiresAt = new Date(now().getTime() + 10 * 60_000).toISOString();
        let materials: P2pApprovedMaterials;
        try {
          const result = await approve(service, {
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
          if (result.quoteHash !== input.quote.contentHash) throw new ControlServiceRefusal("quote_mismatch", "the Service approved a different quote");
          materials = {
            approvalId: input.approvalId,
            generation: input.generation,
            consumerNodeId: input.consumer.nodeId,
            consumerFingerprint: input.consumer.fingerprint,
            models: result.models,
            capUsd: result.capUsd,
            quoteHash: result.quoteHash,
            priceVersion: result.priceVersion,
            expiresAt: result.expiresAt,
            keyId: result.keyId,
            keyName: result.keyName,
            memo: input.memo,
          };
        } catch (error) {
          // A failure after the Service created a key is uncertain, not a
          // reason to create another. A failure with no key at all is safe to
          // clear so the operator can retry after fixing the quote.
          const recovered = recoverApproval(pending, service, now().toISOString());
          if (recovered) {
            saveApprovals(approvalStateFile, { version: 1, approvals: [...state.approvals, recovered] });
            return materialsFrom(recovered);
          }
          if (!service.provisioner.find(input.consumer.nodeId)) {
            saveApprovals(approvalStateFile, { version: 1, approvals: state.approvals });
          } else {
            const failed: ApprovalRecord = {
              ...pending,
              state: "uncertain",
              error: String((error as Error)?.message ?? error).slice(0, 300),
              updatedAt: now().toISOString(),
            };
            saveApprovals(approvalStateFile, { version: 1, approvals: [...state.approvals, failed] });
          }
          throw error;
        }
        const approved: ApprovalRecord = {
          ...pending,
          models: [...materials.models],
          capUsd: materials.capUsd,
          priceVersion: materials.priceVersion,
          expiresAt: materials.expiresAt,
          keyId: materials.keyId,
          keyName: materials.keyName,
          state: "approved",
          error: null,
          updatedAt: now().toISOString(),
        };
        saveApprovals(approvalStateFile, { version: 1, approvals: [...state.approvals, approved] });
        return materials;
      });
    },

    async reconcileApproval(input) {
      const observedAt = now().toISOString();
      const binding = {
        consumerNodeId: input.consumer.nodeId,
        requestHash: input.requestHash,
        approvalId: input.approvalId,
        generation: input.generation,
        observedAt,
      };
      try {
        const state = loadApprovals(approvalStateFile);
        const record = state.approvals.find((a) => a.approvalId === input.approvalId);
        const consumer = service.provisioner.find(input.consumer.nodeId);
        const knownKeyId = consumer?.keyId ?? record?.keyId ?? null;
        if (input.keyId && consumer?.keyId && consumer.keyId !== input.keyId) {
          return { ...binding, state: "unknown", knownKeyId, source: "journal+native", detail: "the native consumer key id differs from the interrupted approval" };
        }
        if (!record) {
          // A missing journal is not proof that this approval intent never
          // existed. A Provisioner consumer may be from this or another
          // attempt; only an unknown result can prevent a second key.
          return {
            ...binding,
            state: "unknown",
            knownKeyId,
            source: consumer ? "native-management" : "none",
            detail: consumer
              ? "a Provisioner consumer exists without a persistent approval binding"
              : "no persistent approval journal entry proves this intent",
          };
        }
        if (
          record.requestHash !== input.requestHash ||
          record.generation !== input.generation ||
          record.consumerNodeId !== input.consumer.nodeId ||
          record.consumerFingerprint !== input.consumer.fingerprint
        ) {
          return { ...binding, state: "unknown", knownKeyId, source: "journal+native", detail: "the approval journal entry does not match the interrupted approval" };
        }
        if (record.state === "revoked") {
          return { ...binding, state: "unknown", knownKeyId, source: "journal+native", detail: "the approval was already revoked" };
        }
        if (record.state === "approved" || record.state === "pending" || record.state === "uncertain") {
          const recovered = recoverApproval(record, service, observedAt);
          if (recovered && consumer) {
            if (input.keyId && recovered.keyId !== input.keyId) {
              return { ...binding, state: "unknown", knownKeyId, source: "journal+native", detail: "the recovered key id does not match the interrupted approval" };
            }
            return {
              ...binding,
              state: "keyReady",
              knownKeyId: recovered.keyId!,
              keyId: recovered.keyId!,
              keyName: recovered.keyName!,
              models: recovered.models,
              capUsd: recovered.capUsd,
              priceVersion: recovered.priceVersion,
              expiresAt: recovered.expiresAt,
              source: "journal+native",
              detail: "recovered from the persistent approval/native key binding",
            };
          }
          if (record.state === "pending" && !consumer) {
            return {
              ...binding,
              state: "noSideEffect",
              knownKeyId: null,
              source: "journal+native",
              detail: "the durable pending intent exists and the native management view has no consumer key for it",
            };
          }
          return { ...binding, state: "unknown", knownKeyId, source: "journal+native", detail: "the approval exists but its native key binding cannot be proven" };
        }
        return { ...binding, state: "unknown", knownKeyId, source: "journal+native", detail: "the approval journal state is not recoverable" };
      } catch (error) {
        return {
          ...binding,
          state: "unknown",
          knownKeyId: null,
          source: "none",
          detail: String((error as Error)?.message ?? error).slice(0, 200),
        };
      }
    },

    async takeAuthorization(input) {
      return serial(async () => {
        const record = loadApprovals(approvalStateFile).approvals.find((a) => a.approvalId === input.approvalId);
        if (!record || record.state !== "approved") {
          throw new ControlServiceRefusal("conflict", "this approval has no confirmed key binding; refuse a second key hand-over");
        }
        if (
          record.generation !== input.generation ||
          record.consumerNodeId !== input.consumerNodeId ||
          record.consumerFingerprint !== input.consumerFingerprint ||
          record.requestHash !== input.requestHash ||
          record.quoteHash !== input.quote.contentHash ||
          Math.abs(record.capUsd - input.capUsd) > 1e-9 ||
          !sameSet(record.models, input.models) ||
          record.keyId !== input.keyId ||
          record.keyName !== input.keyName
        ) {
          throw new ControlServiceRefusal("conflict", "the approval journal does not match this hand-over; refuse a second key");
        }
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
      });
    },

    async recordAck() {
      // B-core stores the ACK/readback; this port must not write a second copy.
    },

    async revoke(input) {
      return serial(async () => {
        const state = loadApprovals(approvalStateFile);
        const record = state.approvals.find((a) => a.approvalId === input.approvalId);
        if (!record) {
          return {
            revoked: false,
            enforcement: "failed",
            detail: "no persistent approval binding; refusing to revoke a key by an old/unbound request",
          } as const;
        }
        if (
          record.consumerNodeId !== input.consumerNodeId ||
          record.generation !== input.generation ||
          !input.keyId ||
          record.keyId !== input.keyId
        ) {
          return {
            revoked: false,
            enforcement: "failed",
            detail: "the revoke request does not match the persisted approval/key generation",
          } as const;
        }
        if (record.state === "revoked") {
          return {
            revoked: true,
            enforcement: "keyRevoked",
            consumerNodeId: record.consumerNodeId,
            approvalId: record.approvalId,
            keyId: record.keyId,
            generation: record.generation,
            detail: "already revoked",
          } as const;
        }
        // A stale approval must never reach the native key that a newer
        // approval currently owns, even if the Provisioner reuses a key id.
        const newer = state.approvals.some(
          (a) =>
            a.consumerNodeId === input.consumerNodeId &&
            a.approvalId !== input.approvalId &&
            a.state !== "revoked" &&
            a.updatedAt > record.updatedAt,
        );
        if (newer) {
          return {
            revoked: false,
            enforcement: "failed",
            detail: "a newer approval owns this consumer; an old request cannot revoke its key",
          } as const;
        }
        const before = service.provisioner.find(input.consumerNodeId);
        if (!before || before.keyId !== input.keyId || before.revokedAt) {
          return {
            revoked: false,
            enforcement: "failed",
            detail: "the native current key does not match the target approval",
          } as const;
        }
        const result = await service.provisioner.revokeEnforced(input.consumerNodeId, input.keyId);
        const after = service.provisioner.find(input.consumerNodeId);
        if (!after || after.keyId !== input.keyId) {
          return { revoked: false, enforcement: "failed", detail: "the key identity changed during revocation; no revocation was claimed" } as const;
        }
        if (result.revoked && (result.enforcement === "keyRevoked" || result.enforcement === "secretRotated")) {
          const revoked: ApprovalRecord = { ...record, state: "revoked", error: null, updatedAt: now().toISOString() };
          saveApprovals(approvalStateFile, { version: 1, approvals: state.approvals.map((a) => (a.approvalId === record.approvalId ? revoked : a)) });
          return {
            revoked: true,
            enforcement: result.enforcement,
            consumerNodeId: input.consumerNodeId,
            approvalId: input.approvalId,
            keyId: input.keyId,
            generation: input.generation,
            detail: result.detail,
          } as const;
        }
        const enforcement =
          result.enforcement === "capRestricted" || result.enforcement === "safetyUncertain" ? result.enforcement : "failed";
        return { revoked: false, enforcement, detail: result.detail } as const;
      });
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
        // Write a pending ownership record before the native add. A crash after
        // addProvider but before the final atomic save therefore leaves an
        // ownership record with this exact approvalId/providerId: the same
        // approval can retry idempotently, while a different approval is refused
        // and can never reset/replace the new Remote. The record holds no key.
        const pending: RemoteRecord = {
          providerNodeId: approval.providerNodeId,
          providerFingerprint: approval.providerFingerprint,
          approvalId: approval.approvalId,
          generation: approval.generation,
          keyId: document.keyId,
          providerId,
          models: [...document.models],
          capUsd: document.capUsd,
          updatedAt: now().toISOString(),
        };
        saveState(stateFile, { version: 1, remotes: [...state.remotes.filter((r) => r.providerNodeId !== approval.providerNodeId), pending] });
        let result: { models: string[]; capUsd: number };
        try {
          result = await importAuthorizationWithService(service, {
            document,
            approval: inboundApproval,
            providerFingerprint: approval.providerFingerprint,
            providerId,
          });
        } catch (error) {
          // If no native Remote remains, the pending record is only a failed
          // attempt and can be cleared; if one remains (including an uncertain
          // add), keep the record so no other approval can replace it.
          if (!service.provider(providerId)) {
            saveState(stateFile, { version: 1, remotes: state.remotes.filter((r) => r.providerNodeId !== approval.providerNodeId) });
          }
          throw error;
        }
        const completed: RemoteRecord = {
          ...pending,
          models: [...result.models],
          capUsd: result.capUsd,
          updatedAt: now().toISOString(),
        };
        // The pending record already names this approval/providerId. A final
        // write failure leaves that recoverable record in place; do not remove a
        // native Remote that a later same-approval retry can adopt.
        saveState(stateFile, { version: 1, remotes: [...state.remotes.filter((r) => r.providerNodeId !== approval.providerNodeId), completed] });
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
