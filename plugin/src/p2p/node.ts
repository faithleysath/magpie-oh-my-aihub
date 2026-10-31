// P2pNode — the public B1 core, and the only file B-service imports.
//
// It owns the handshake, sessions, replay/idempotency rows, the business state
// machine and the outbox. It reaches the plugin only through `P2pBusinessPort`
// (implemented by B-service) and an optional `P2pTransport` (also B-service):
// there is no import of Service, Provisioner, Magpie, Ledger, Wallet, Console or
// the HTTP layer, and no method dispatches on a remote-supplied action name.
//
// The no-file flow:
//
//   consumer.openSession(target)            signed hello + X25519 + AEAD
//   consumer.requestConnection(...)         signed connection_request
//   provider.approve(...)                   ONE local human action:
//                                             approves, creates/ensures the key,
//                                             binds the authorization hash and
//                                             queues the encrypted delivery
//   provider.tick() → transport             approved + sealed authorization
//   consumer.handleFrame(...)               open seal → importAuthorization →
//                                           models/cap readback → delivered
//   consumer.tick() → transport             ACK (after registration, never before)
//   provider.handleFrame(ack)               acked; no second key, no ledger write
//
// Failure policy: a key is created at most once per approval generation; an
// authorization is bound once per generation; a revoke invalidates the
// generation before any further seal; an unknown outcome is `uncertain` and is
// surfaced to the operator, never auto-reissued.

import { randomBytes } from "node:crypto";
import {
  canonicalJson,
  fingerprintOf,
  loadCatalogTrust,
  sha256Hex,
} from "../catalog.ts";
import {
  assertNoSecretMaterial,
  authorizationHashOf,
  capOnGridOf,
  fail,
  keyHashOf,
  modelListOf,
  P2P_B1_UNSUPPORTED,
  P2P_MAX_FRAME_BYTES,
  P2P_MAX_TTL_MS,
  P2P_PROTOCOL,
  P2P_VERSION,
  P2pError,
  requestHashOf,
  timeMs,
  validateEnvelope,
  type P2pAckBody,
  type P2pApprovedBody,
  type P2pAuthorizationDocument,
  type P2pAuthorizationDeliveryBody,
  type P2pConnectionRequestBody,
  type P2pEnvelope,
  type P2pMessageType,
  type P2pPeerIdentity,
  type P2pRejectionReason,
  type P2pRequestDocument,
  type P2pRevokeReason,
  type P2pRevokedBody,
  type P2pStatusBody,
} from "./protocol.ts";
import {
  catalogProviderTrust,
  trustVerdict,
  type P2pIdentity,
  type P2pLocalBinding,
  type P2pTrustVerdict,
} from "./identity.ts";
import {
  buildClientHello,
  buildServerHello,
  completeHandshake,
  validateClientHello,
  validateServerHello,
  type ClientHandshake,
  type P2pHelloTarget,
  type P2pServerHello,
} from "./handshake.ts";
import { generateEphemeralKeyPair, openAuthorization, sealAuthorization } from "./crypto.ts";
import { P2pSession } from "./session.ts";
import {
  DEFAULT_P2P_RETRY,
  retryDelayMs,
  type P2pApprovalRow,
  type P2pDeliveryRow,
  type P2pOutboxRow,
  type P2pRecoveryReport,
  type P2pRequestRow,
  type P2pRetryPolicy,
  P2pStore,
} from "./store.ts";

// --- contracts ---------------------------------------------------------------

export interface P2pPeerView {
  accountId: string;
  nodeId: string;
  hostname: string;
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
  /** the eligible subset of the requested models; never a widening */
  models: string[];
  /** must equal request.quote.contentHash */
  quoteHash: string;
  /** price version for the REQUESTED set; informational, never the approved subset */
  priceVersion: string;
  /** when the offer/validation stops being usable */
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

export interface P2pReconcileEvidence {
  /** read-only source, e.g. "magpie-key-readback" or "provisioner-record" */
  source: string;
  /** when the adapter observed the real state; stale evidence is refused */
  observedAt: string;
  /** the fields actually read back, e.g. ["keys","costLimit","models"] */
  checked: string[];
  /** native key ids the adapter saw; no key material */
  nativeKeyIds?: string[];
}

export interface P2pReconcileBindings {
  requestHash: string;
  approvalId: string;
  generation: number;
  consumerNodeId: string;
  consumerFingerprint: string;
  keyId: string | null;
}

export type P2pApprovalReconcile =
  | ({ state: "keyReady"; keyId: string; keyName: string; models: string[]; capUsd: number; priceVersion: string; expiresAt: string; detail?: string | null } & Omit<P2pReconcileBindings, "keyId"> & { keyId: string; evidence: P2pReconcileEvidence })
  | ({ state: "noSideEffect"; detail?: string | null } & P2pReconcileBindings & { evidence: P2pReconcileEvidence })
  | { state: "unknown"; detail: string | null };

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
  /** bindings the adapter must read back from the real Provisioner/Magpie */
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

/**
 * A revoke is confirmed only by an explicit typed result. void, null, a missing
 * enforcement, or a non-binding enforcement (cap/network/safety) is not success:
 * the approval stays uncertain and can be retried.
 */
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

/** Implemented by B-service. Every method must be safe to retry. */
export interface P2pBusinessPort {
  providerContext(): Promise<P2pProviderContext>;
  /** read-only revalidation against the current signed quote and share policy */
  validateRequest(input: P2pRequestValidationInput): Promise<P2pRequestValidation>;
  recordRequest(input: P2pRecordedRequest): Promise<boolean>;
  approve(input: P2pApprovalRequest): Promise<P2pApprovedMaterials>;
  // Read-only lookup for an interrupted approval attempt. Must not create or
  // rotate a key. unknown keeps the approval uncertain; noSideEffect allows a
  // retry with the same approvalId/generation.
  reconcileApproval?(input: P2pApprovalReconcileInput): Promise<P2pApprovalReconcile>;
  takeAuthorization(input: P2pTakeAuthorizationInput): Promise<P2pAuthorizationDocument>;
  recordAck(input: P2pAckRecord): Promise<void>;
  /** Must actually revoke the native key. Resolving means "the key is gone". */
  revoke(input: P2pRevokeRequest): Promise<P2pRevokeOutcome>;
  recordApproval(input: P2pInboundApproval): Promise<void>;
  importAuthorization(input: { document: P2pAuthorizationDocument; approval: P2pInboundApproval; session: { sessionId: string; peer: P2pPeerIdentity } }): Promise<{ models: string[]; capUsd: number }>;
  dropAuthorization(input: { approvalId: string; consumerNodeId: string; providerNodeId: string | null; providerFingerprint: string | null; reason: P2pRevokeReason }): Promise<void>;
}

/** Implemented by B-service's HTTP transport. No crypto decisions here. */
export interface P2pTransport {
  /** POST the signed hello and return the parsed server_hello JSON. */
  hello(target: P2pHelloTarget, hello: unknown): Promise<unknown>;
  /** POST one sealed frame to the peer of the session. */
  frame(session: { sessionId: string; peer: P2pPeerIdentity }, frame: Buffer): Promise<void>;
  /**
   * Whether a push to this peer is currently possible. Returning false leaves
   * outbox rows pending for an authenticated poll instead of exhausting their
   * retry budget to dead.
   */
  canPush?(peer: P2pPeerIdentity): boolean;
  /**
   * Pull-style transport: send a signed hello and receive the server_hello plus
   * a bounded list of sealed frames already addressed to this consumer. This
   * avoids requiring a reverse consumer endpoint; authentication is the hello
   * signature and the frames are AEAD-sealed to the new session.
   */
  poll?(target: P2pHelloTarget, hello: unknown): Promise<{ serverHello: unknown; frames: string[] }>;
}

export type P2pTrustLookup = (provider: { nodeId: string; fingerprint: string }) => P2pTrustVerdict;

export interface P2pNodeOptions {
  identity: P2pIdentity;
  store: P2pStore;
  port: P2pBusinessPort;
  transport?: P2pTransport;
  /** defaults to the persisted Catalogue TOFU (`catalog-trust.json`) */
  trust?: P2pTrustLookup;
  now?: () => Date;
  retry?: P2pRetryPolicy;
  approvalTtlMs?: number;
  deliveryTtlMs?: number;
}

export type P2pResultCode =
  | "ok"
  | "duplicate"
  | "awaiting-trust"
  | "awaiting-approval"
  | "rejected"
  | "unsupported"
  | "conflict"
  | "not-found"
  | "untrusted-peer"
  | "expired"
  | "registered"
  | "retry";

export interface P2pFrameResult {
  duplicate: boolean;
  type: P2pMessageType;
  state: string;
  code: P2pResultCode;
}

export interface P2pTickResult {
  recovered: P2pRecoveryReport | null;
  sessionsExpired: number;
  sent: number;
  failed: number;
  dead: number;
  rearmed: number;
  actionNeeded: string[];
  outboxPending: number;
  transportAvailable: boolean;
}

export interface P2pRequestView {
  requestHash: string;
  state: string;
  receivedAt: string;
  expiresAt: string;
  models: string[];
  quoteHash: string;
  priceVersion: string;
  consumer: { nodeId: string; fingerprint: string; hostname: string };
  trust: P2pTrustVerdict;
  approvalId: string | null;
  approvalState: string | null;
  note: string | null;
}

export interface P2pApprovalView {
  approvalId: string;
  requestHash: string;
  generation: number;
  state: string;
  models: string[];
  capUsd: number;
  quoteHash: string;
  /** price version for the SELECTED models (not the request's full set) */
  priceVersion: string;
  /** price version the consumer accepted for the requested models */
  requestedPriceVersion: string;
  provider: { nodeId: string | null; fingerprint: string | null };
  consumer: { nodeId: string; fingerprint: string };
  keyId: string | null;
  keyName: string | null;
  authorizationHash: string | null;
  createdAt: string;
  approvedAt: string | null;
  expiresAt: string;
  deliveredAt: string | null;
  ackState: "none" | "pending" | "acked" | "failed";
  memo: string | null;
  error: string | null;
  actionNeeded: string | null;
}

// --- implementation ----------------------------------------------------------

const ACTIVE_APPROVAL_STATES = ["approving", "approved", "delivering", "delivered", "acked"] as const;
/** A revoke may retry an uncertain approval once the port confirms the key is gone. */
const REVOCABLE_STATES = [...ACTIVE_APPROVAL_STATES, "uncertain"] as const;
const MAX_MEMO = 200;

export class P2pNode {
  private identity: P2pIdentity;
  private readonly store: P2pStore;
  private readonly port: P2pBusinessPort;
  private readonly transport: P2pTransport | null;
  private readonly trust: P2pTrustLookup;
  private readonly clock: () => Date;
  private readonly retry: P2pRetryPolicy;
  private readonly approvalTtlMs: number;
  private readonly deliveryTtlMs: number;
  private readonly sessions = new Map<string, P2pSession>();
  private readonly helloCache = new Map<string, { clientHelloId: string; serverHello: P2pServerHello; session: P2pSession }>();
  private recoveryReport: P2pRecoveryReport | null = null;
  private readonly recoveredAtBoot: boolean;
  private closed = false;
  /** all state transitions run one at a time; approve/revoke/delivery never race */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: P2pNodeOptions) {
    this.identity = options.identity;
    this.store = options.store;
    this.port = options.port;
    this.transport = options.transport ?? null;
    this.trust = options.trust ?? defaultCatalogTrust;
    this.clock = options.now ?? (() => new Date());
    this.retry = options.retry ?? DEFAULT_P2P_RETRY;
    this.approvalTtlMs = Math.min(options.approvalTtlMs ?? 10 * 60_000, P2P_MAX_TTL_MS);
    this.deliveryTtlMs = Math.min(options.deliveryTtlMs ?? 10 * 60_000, P2P_MAX_TTL_MS);
    // Boot recovery must run before any session exists: it expires the previous
    // process's sessions (their keys died with it) and re-queues interrupted
    // outbox/inbox rows. Running it on the first tick would kill live sessions.
    this.recoveryReport = this.store.recover(this.clock());
    this.recoveredAtBoot = true;
  }

  get identityView(): P2pIdentity {
    return this.identity;
  }
  get binding(): P2pLocalBinding {
    return this.identity.binding;
  }

  /** Update the local binding when sharing/catalogue/ports change. */
  setBinding(binding: P2pLocalBinding): void {
    this.identity = this.identity.withBinding(binding);
    // A binding change invalidates the cached hellos: they name the old quote
    // and ports and must not be replayed.
    this.helloCache.clear();
  }

  // --- handshake -------------------------------------------------------------

  /** Provider side: validate + answer a signed hello and open a session. */
  async acceptHello(raw: unknown, opts: { rejectReplay?: boolean } = {}): Promise<{ serverHello: P2pServerHello; sessionId: string; trust: P2pTrustVerdict }> {
    this.assertOpen();
    const hello = validateClientHello(raw, { now: this.clock(), local: { identity: this.identity, binding: this.identity.binding } });
    const cached = this.helloCache.get(hello.sessionId);
    if (cached) {
      if (opts.rejectReplay) fail("replay", "a poll hello cannot be replayed");
      if (cached.clientHelloId !== hello.id) fail("replay", "this session id was already used by another hello");
      this.store.recordPeerSeen(hello.from, this.clock());
      return { serverHello: cached.serverHello, sessionId: hello.sessionId, trust: this.verdictFor(hello.from) };
    }
    if (this.store.hasTombstone("hello-nonce", hello.clientNonce)) fail("replay", "this hello nonce was already used");
    if (this.store.getSession(hello.sessionId)) fail("replay", "this session id was already used");
    if (hello.to.catalogQuoteHash && !this.identity.binding.catalogQuoteHash) fail("quote_mismatch", "this node publishes no catalogue for that quote");
    const peer = this.store.recordPeerSeen(hello.from, this.clock());
    const ephemeral = generateEphemeralKeyPair();
    const serverHello = buildServerHello({ hello, identity: this.identity, ephemeral, now: this.clock() });
    const material = completeHandshake({ role: "provider", clientHello: hello, serverHello, ephemeral, now: this.clock() });
    const session = P2pSession.establish({ material, store: this.store, now: this.clock });
    this.store.putTombstone("hello-nonce", hello.clientNonce, "consumed hello nonce", this.clock(), 2 * 60 * 60_000);
    this.helloCache.set(hello.sessionId, { clientHelloId: hello.id, serverHello, session });
    if (this.helloCache.size > 32) {
      const oldest = this.helloCache.keys().next().value;
      if (oldest) this.helloCache.delete(oldest);
    }
    this.pruneSessions();
    this.sessions.set(session.sessionId, session);
    return { serverHello, sessionId: hello.sessionId, trust: trustVerdict(trustRowToLike(peer), hello.from) };
  }

  /** Consumer side: handshake with a peer and open a session. */
  async openSession(target: P2pHelloTarget): Promise<{ sessionId: string; peer: P2pPeerIdentity }> {
    this.assertOpen();
    const now = this.clock().getTime();
    for (const live of this.sessions.values()) {
      if (live.closedReason) continue;
      if (live.peer.nodeId !== target.nodeId || live.peer.fingerprint !== target.fingerprint) continue;
      if (live.catalogQuoteHash !== target.catalogQuoteHash) continue;
      if (Date.parse(live.expiresAt) - now < 60_000) continue;
      return { sessionId: live.sessionId, peer: live.peer };
    }
    if (!this.transport) fail("internal", "no P2P transport is configured");
    if (target.nodeId === this.identity.peer.nodeId) fail("target_mismatch", "a node cannot handshake with itself");
    const client: ClientHandshake = buildClientHello({ identity: this.identity, target, now: this.clock() });
    const serverHello = await this.transport.hello(target, client.hello);
    const verdict = this.trust({ nodeId: target.nodeId, fingerprint: target.fingerprint });
    if (verdict !== "accepted" && verdict !== "pending") {
      fail("untrusted_peer", `the provider identity is ${verdict}; read and accept its catalogue key first`);
    }
    const validated = validateServerHello(serverHello, {
      now: this.clock(),
      client: client.hello,
      expectedProvider: { nodeId: target.nodeId, fingerprint: target.fingerprint },
    });
    if (this.store.getSession(client.sessionId)) fail("replay", "this session id was already used");
    const material = completeHandshake({ role: "consumer", clientHello: client.hello, serverHello: validated, ephemeral: client.ephemeral, now: this.clock() });
    const session = P2pSession.establish({ material, store: this.store, now: this.clock });
    this.sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId, peer: session.peer };
  }

  /**
   * Provider side: materialize and return the bounded outbox frames addressed to
   * this authenticated session. The caller has already accepted a signed hello,
   * so a random session id alone cannot pull anything. Frames are marked sent;
   * ACK loss is handled by the existing rearm/tick path, not by a second key.
   */
  async pullFrames(sessionId: string, limit = 10): Promise<Buffer[]> {
    this.assertOpen();
    await this.serial(async () => {
      // no-op barrier: a pull must not race approve/revoke state transitions
    });
    const session = this.sessions.get(sessionId);
    if (!session || session.closedReason) fail("session_closed", "the poll session is not open");
    // A lost HTTP poll response must not permanently consume the approval. The
    // next authenticated poll re-arms the same generation's still-unacked rows;
    // this is safe because approval/delivery are idempotent by generation/hash.
    await this.rearmUnackedForPoll(session.peer);
    const out: Buffer[] = [];
    for (const row of this.dueForSession(session, Math.max(1, Math.min(limit, 20)))) {
      if (row.type === "authorization_delivery" && !this.approvedWasSent(row)) continue;
      if (!this.store.markOutboxSending(row.messageId, this.clock())) continue;
      try {
        out.push(await this.materialize(row, session));
        this.store.markOutboxSent(row.messageId, this.clock());
      } catch (e) {
        this.store.markOutboxRetry(row.messageId, this.clock(), e instanceof Error ? e.message : String(e), this.retry);
      }
    }
    return out;
  }

  /**
   * Consumer side: authenticate a fresh signed hello, complete the session, and
   * process a bounded set of provider frames returned in the same poll response.
   * The session is a normal P2pSession; seq/AEAD/recipient/expiry/replay checks
   * are the same as the push path. ACKs are queued normally and sent by tick().
   */
  /** Bounds in-memory poll sessions; persistent rows are never trusted for keys. */
  private pruneSessions(max = 32): void {
    const now = this.clock().getTime();
    for (const [id, session] of [...this.sessions]) {
      if (session.closedReason || Date.parse(session.expiresAt) <= now) {
        if (!session.closedReason) session.close("pruned");
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size <= max) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => Date.parse(a[1].expiresAt) - Date.parse(b[1].expiresAt));
    for (const [id, session] of oldest.slice(0, oldest.length - max)) {
      if (!session.closedReason) session.close("pruned");
      this.sessions.delete(id);
    }
  }

  async poll(target: P2pHelloTarget): Promise<P2pFrameResult[]> {
    this.assertOpen();
    if (!this.transport?.poll) fail("internal", "the transport does not support pull/poll");
    const client: ClientHandshake = buildClientHello({ identity: this.identity, target, now: this.clock() });
    const response = await this.transport.poll(target, client.hello);
    if (!response || !Array.isArray(response.frames) || response.frames.length > 20) fail("malformed", "poll returned an invalid frame list");
    const verdict = this.trust({ nodeId: target.nodeId, fingerprint: target.fingerprint });
    if (verdict !== "accepted" && verdict !== "pending") fail("untrusted_peer", `the provider identity is ${verdict}; read and accept its catalogue key first`);
    const serverHello = validateServerHello(response.serverHello, {
      now: this.clock(),
      client: client.hello,
      expectedProvider: { nodeId: target.nodeId, fingerprint: target.fingerprint },
    });
    const material = completeHandshake({ role: "consumer", clientHello: client.hello, serverHello, ephemeral: client.ephemeral, now: this.clock() });
    const session = P2pSession.establish({ material, store: this.store, now: this.clock });
    this.sessions.set(session.sessionId, session);
    this.pruneSessions();
    const results: P2pFrameResult[] = [];
    for (const encoded of response.frames) {
      if (typeof encoded !== "string" || encoded.length > P2P_MAX_FRAME_BYTES * 2) fail("malformed", "poll frame is invalid");
      const frame = Buffer.from(encoded, "base64");
      if (frame.length === 0 || frame.length > P2P_MAX_FRAME_BYTES) fail("malformed", "poll frame is too large");
      results.push(await this.handleFrame(session.sessionId, frame));
    }
    if (results.length) await this.tick();
    return results;
  }

  // --- inbound frames --------------------------------------------------------

  /**
   * Opens, verifies and dispatches one sealed frame. A duplicate frame returns
   * the cached result and performs no second side effect.
   */
  /** Frames dropped before authentication (for B-service rate/metrics). */
  rejectedFrameCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.rejectedFrames ?? 0;
  }

  async handleFrame(sessionId: string, frame: Uint8Array): Promise<P2pFrameResult> {
    this.assertOpen();
    const session = this.sessions.get(sessionId);
    if (!session || session.closedReason) fail("session_closed", "the session is not open; handshake again");
    const opened = session.open(Buffer.from(frame));
    if (opened.duplicate) {
      const cached = parseResult(opened.cachedResultJson);
      return {
        duplicate: true,
        type: opened.type,
        state: String(cached.state ?? opened.cachedResultCode ?? "duplicate"),
        code: (opened.cachedResultCode as P2pResultCode | null) ?? "duplicate",
      };
    }
    const envelope = opened.envelope;
    if (!envelope) fail("malformed", "the frame opened without an envelope");
    try {
      const handled = await this.dispatch(session, envelope);
      session.finish(opened.seq, handled.code, canonicalJson(handled.result));
      return { duplicate: false, type: envelope.type, state: String(handled.result.state ?? handled.code), code: handled.code };
    } catch (e) {
      const inbox = this.store.getInbox(envelope.id);
      if (inbox && isRetryable(e)) {
        // A local port failure is not a protocol verdict: drop the inbox row so
        // the peer's bounded retry (with the same idempotency key) can be
        // processed again, and cache a retryable result for this frame.
        this.store.abandonInbox(envelope.id);
        session.finish(opened.seq, "retry", canonicalJson({ state: "retry", code: "retry" }));
      } else {
        session.finish(opened.seq, "rejected", canonicalJson({ state: "rejected", code: e instanceof P2pError ? e.code : "internal" }));
      }
      throw e;
    }
  }

  private async dispatch(session: P2pSession, envelope: P2pEnvelope): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    if (envelope.from.fingerprint !== session.peer.fingerprint) fail("stale_identity", "the envelope sender is not the session peer");
    if (P2P_B1_UNSUPPORTED.includes(envelope.type)) return this.finishUnsupported(envelope);
    if (envelope.idempotency !== expectedIdempotencyFor(envelope)) fail("conflict", "the idempotency key does not match this business object");
    switch (envelope.type) {
      case "connection_request":
        return this.onConnectionRequest(session, envelope as P2pEnvelope<P2pConnectionRequestBody>);
      case "ack":
        return this.onAck(envelope as P2pEnvelope<P2pAckBody>);
      case "status":
        return this.onStatus(session, envelope as P2pEnvelope<P2pStatusBody>);
      case "approved":
        return this.onApproved(session, envelope as P2pEnvelope<P2pApprovedBody>);
      case "rejected":
        return this.onRejected(envelope as P2pEnvelope<{ requestHash: string; reason: P2pRejectionReason; note: string | null }>);
      case "authorization_delivery":
        return this.onDelivery(session, envelope as P2pEnvelope<P2pAuthorizationDeliveryBody>);
      case "revoked":
        return this.onRevoked(envelope as P2pEnvelope<P2pRevokedBody>);
      case "quote_changed":
        return this.onQuoteChanged(envelope as P2pEnvelope<{ quoteHash: string; priceVersion: string; models: string[] }>);
      default:
        return fail("unsupported_type", "the message type has no handler");
    }
  }

  private async finishUnsupported(envelope: P2pEnvelope): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: envelope.correlation,
      bodyHash: sha256Hex(canonicalJson(envelope.body)),
      metaJson: canonicalJson({ type: envelope.type, code: "unsupported" }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) {
      const existing = inbox.row;
      return { code: "duplicate", result: parseResult(existing.resultJson) };
    }
    const result = { state: "unsupported", type: envelope.type };
    this.store.finishInbox(inbox.row.messageId, "unsupported", canonicalJson(result), this.clock());
    return { code: "unsupported", result };
  }

  private async onConnectionRequest(session: P2pSession, envelope: P2pEnvelope<P2pConnectionRequestBody>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    const request = body.request;
    const now = this.clock();
    const peer = envelope.from;
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: peer.accountId,
      fromNodeId: peer.nodeId,
      fromFingerprint: peer.fingerprint,
      correlation: body.requestHash,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ requestHash: body.requestHash, models: request.models, quoteHash: request.quote.contentHash }),
      nextAttemptAt: now.toISOString(),
      expiresAt: envelope.expires,
      receivedAt: now.toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);

    this.store.recordPeerSeen(peer, now);
    const existing = this.store.getRequest(body.requestHash);
    if (existing && existing.consumerFingerprint !== peer.fingerprint) {
      fail("conflict", "this request hash is already bound to another consumer identity");
    }
    if (existing && !["rejected", "expired", "revoked"].includes(existing.state)) {
      await this.port.recordRequest({ requestHash: body.requestHash, request, consumer: peer, sessionId: session.sessionId, firstSeenAt: existing.receivedAt, expiresAt: existing.expiresAt });
      return this.finishInbox(inbox.row, "duplicate", { requestHash: body.requestHash, state: existing.state });
    }

    const verdict = this.verdictFor(peer);
    const state = verdict === "accepted" ? "awaiting-approval" : "awaiting-trust";
    if (existing) {
      this.store.setRequestState(body.requestHash, state, now, { note: null });
    } else {
      this.store.insertRequest({
        requestHash: body.requestHash,
        sessionId: session.sessionId,
        consumerAccountId: peer.accountId,
        consumerNodeId: peer.nodeId,
        consumerFingerprint: peer.fingerprint,
        providerNodeId: this.identity.peer.nodeId,
        providerFingerprint: this.identity.peer.fingerprint,
        quoteHash: request.quote.contentHash,
        priceVersion: request.quote.priceVersion,
        modelsJson: canonicalJson(request.models),
        eligibleJson: null,
        documentJson: canonicalJson(request),
        state,
        receivedAt: now.toISOString(),
        expiresAt: envelope.expires,
        approvalId: null,
        note: null,
      });
    }

    if (verdict !== "accepted") {
      await this.port.recordRequest({ requestHash: body.requestHash, request, consumer: peer, sessionId: session.sessionId, firstSeenAt: now.toISOString(), expiresAt: envelope.expires });
      return this.finishInbox(inbox.row, "awaiting-trust", { requestHash: body.requestHash, state: "awaiting-trust" });
    }

    // A previous identity's native key may still be usable. Do not start a new
    // request flow until that is reconciled and confirmed revoked.
    if (this.unresolvedLegacyIdentity(peer.nodeId, peer.fingerprint)) {
      this.store.setRequestState(body.requestHash, "rejected", now, { note: "legacy-key-unresolved" });
      await this.enqueueRejection(body.requestHash, "policy", "a previous identity's key is not confirmed revoked");
      return this.finishInbox(inbox.row, "rejected", { requestHash: body.requestHash, state: "rejected", reason: "policy" });
    }

    // Revalidate against the local provider context. A consumer may have read a
    // stale quote; that is a policy rejection, not a key.
    try {
      const context = await this.port.providerContext();
      this.assertRequestAgainstContext(request, context);
      // The validator returns the eligible subset and the price version for the
      // REQUESTED set. It is not the approved subset's version; that one comes
      // from the approval port after the human picks models.
      const validation = await this.port.validateRequest({ requestHash: body.requestHash, request, consumer: peer, sessionId: session.sessionId });
      if (validation.quoteHash !== request.quote.contentHash) fail("quote_mismatch", "the validator checked another quote");
      modelListOf(validation.models, "validated eligible models");
      if (validation.models.some((m) => !request.models.includes(m))) fail("conflict", "the validator returned a model outside the request");
      if (!/^[a-f0-9]{64}$/.test(validation.priceVersion)) fail("quote_mismatch", "the validator returned no requested-set price version");
      timeMs(validation.expiresAt, "validated expiry");
      this.store.setRequestState(body.requestHash, "awaiting-approval", now, { eligibleJson: canonicalJson(validation.models) });
    } catch (e) {
      const reason = e instanceof P2pError && e.code === "quote_mismatch" ? "quote-changed" : e instanceof P2pError && e.code === "no_shared_models" ? "no-shared-models" : "policy";
      this.store.setRequestState(body.requestHash, "rejected", now, { note: reason });
      await this.enqueueRejection(body.requestHash, reason as P2pRejectionReason, null);
      return this.finishInbox(inbox.row, "rejected", { requestHash: body.requestHash, state: "rejected", reason });
    }
    await this.port.recordRequest({ requestHash: body.requestHash, request, consumer: peer, sessionId: session.sessionId, firstSeenAt: now.toISOString(), expiresAt: envelope.expires });
    return this.finishInbox(inbox.row, "awaiting-approval", { requestHash: body.requestHash, state: "awaiting-approval" });
  }

  private async onAck(envelope: P2pEnvelope<P2pAckBody>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: body.approvalId,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ approvalId: body.approvalId, state: body.state, keyId: body.keyId }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);

    const approval = this.store.getApproval(body.approvalId);
    if (!approval) return this.finishInbox(inbox.row, "not-found", { approvalId: body.approvalId, state: "unknown" });
    if (approval.consumerFingerprint !== envelope.from.fingerprint || approval.consumerNodeId !== envelope.from.nodeId) {
      fail("stale_identity", "the ack does not come from the approved consumer");
    }
    if (approval.requestHash !== body.requestHash) fail("conflict", "the ack names another request");
    if (approval.authorizationHash !== body.authorizationHash) fail("conflict", "the ack names another authorization");
    if (approval.keyId !== body.keyId) fail("conflict", "the ack names another key");
    if (body.state === "registered") {
      if (!body.readback) fail("malformed", "a registered ack needs the readback");
      const approvedModels = JSON.parse(approval.modelsJson) as string[];
      if (!sameSet(body.readback.models, approvedModels)) fail("conflict", "the registered models differ from the approval");
      if (Math.abs(body.readback.capUsd - approval.capUsd) > 1e-9) fail("conflict", "the registered cap differs from the approval");
    }
    if (approval.state === "acked") return this.finishInbox(inbox.row, "duplicate", { approvalId: approval.approvalId, state: "acked" });
    if (!["approved", "delivering", "delivered", "acked"].includes(approval.state)) fail("conflict", `the approval is ${approval.state}, not deliverable`);

    await this.port.recordAck({
      approvalId: approval.approvalId,
      generation: approval.generation,
      authorizationHash: body.authorizationHash,
      state: body.state,
      readback: body.readback,
      detail: body.detail,
    });
    if (body.state === "registered") {
      this.store.db.transaction(() => {
        this.store.transitionApproval(approval.approvalId, ["approved", "delivering", "delivered"], "acked", { deliveredAt: this.clock().toISOString() });
        this.store.setDeliveryState(approval.approvalId, "acked", this.clock());
        this.store.putTombstone("authorization", approval.approvalId, "delivered and acknowledged", this.clock());
      })();
      return this.finishInbox(inbox.row, "ok", { approvalId: approval.approvalId, state: "acked" });
    }
    this.store.transitionApproval(approval.approvalId, ["approved", "delivering", "delivered"], "uncertain", {
      error: `consumer reported delivery-failed: ${body.detail ?? ""}`.slice(0, 300),
    });
    this.store.setDeliveryState(approval.approvalId, "uncertain", this.clock(), body.detail);
    return this.finishInbox(inbox.row, "rejected", { approvalId: approval.approvalId, state: "uncertain" });
  }

  private async onStatus(session: P2pSession, envelope: P2pEnvelope<P2pStatusBody>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    if (body.state === "query") {
      const approval = body.approvalId ? this.store.getApproval(body.approvalId) : body.requestHash ? this.store.approvalByRequest(body.requestHash) : null;
      const request = body.requestHash ? this.store.getRequest(body.requestHash) : null;
      if (!approval && !request) return { code: "not-found", result: { approvalId: body.approvalId, requestHash: body.requestHash, approvalState: "unknown" } };
      const approvalState = normalizeApprovalState(approval?.state ?? request?.state ?? "unknown");
      this.enqueueStatusReport({ approvalId: approval?.approvalId ?? null, requestHash: body.requestHash ?? approval?.requestHash ?? null, approvalState });
      return { code: "ok", result: { approvalId: approval?.approvalId ?? null, requestHash: body.requestHash, approvalState } };
    }
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: body.approvalId,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ approvalId: body.approvalId, approvalState: body.approvalState }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);
    return this.finishInbox(inbox.row, "ok", { approvalId: body.approvalId, approvalState: body.approvalState });
  }

  private async onApproved(session: P2pSession, envelope: P2pEnvelope<P2pApprovedBody>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: body.requestHash,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ approvalId: body.approvalId, requestHash: body.requestHash, keyId: body.keyId }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);
    if (Date.parse(body.expiresAt) <= this.clock().getTime()) fail("expired", "the approval already expired");
    if (session.catalogQuoteHash && body.quoteHash !== session.catalogQuoteHash) fail("quote_mismatch", "the approval is for a different catalogue quote");

    const request = this.store.getRequest(body.requestHash);
    if (!request) fail("not_found", "the consumer has no such request");
    if (request.consumerFingerprint !== this.identity.peer.fingerprint) fail("stale_identity", "the request belongs to another consumer");
    if (request.state === "revoked") fail("conflict", "the request was revoked; a late approval cannot resurrect it");
    let approval = this.store.getApproval(body.approvalId);
    if (approval) {
      if (approval.keyId && approval.keyId !== body.keyId) fail("conflict", "the approval has a different key");
      if (!sameSet(JSON.parse(approval.modelsJson) as string[], body.models) || Math.abs(approval.capUsd - body.capUsd) > 1e-9) {
        fail("conflict", "the approval changed models or cap");
      }
    } else {
      this.store.insertApproval({
        approvalId: body.approvalId,
        requestHash: body.requestHash,
        generation: body.generation,
        providerNodeId: envelope.from.nodeId,
        providerFingerprint: envelope.from.fingerprint,
        consumerAccountId: this.identity.peer.accountId,
        consumerNodeId: this.identity.peer.nodeId,
        consumerFingerprint: this.identity.peer.fingerprint,
        quoteHash: body.quoteHash,
        priceVersion: body.priceVersion,
        modelsJson: canonicalJson(body.models),
        capUsd: body.capUsd,
        memo: null,
        state: "approved",
        createdAt: this.clock().toISOString(),
        approvedAt: this.clock().toISOString(),
        expiresAt: body.expiresAt,
        keyId: body.keyId,
        keyName: body.keyName,
        authorizationHash: null,
        deliveredAt: null,
        error: null,
        enforcedAt: null,
        enforcement: null,
        enforcedKeyId: null,
      });
      approval = this.store.getApproval(body.approvalId);
    }
    this.store.setRequestState(body.requestHash, "approved", this.clock(), { approvalId: body.approvalId });
    await this.port.recordApproval(inboundApprovalOf(body, envelope.from));
    return this.finishInbox(inbox.row, "ok", { approvalId: body.approvalId, requestHash: body.requestHash, state: "approved" });
  }

  private async onRejected(envelope: P2pEnvelope<{ requestHash: string; reason: P2pRejectionReason; note: string | null }>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: body.requestHash,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ requestHash: body.requestHash, reason: body.reason }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);
    this.store.setRequestState(body.requestHash, "rejected", this.clock(), { note: body.reason });
    return this.finishInbox(inbox.row, "rejected", { requestHash: body.requestHash, state: "rejected", reason: body.reason });
  }

  private async onDelivery(session: P2pSession, envelope: P2pEnvelope<P2pAuthorizationDeliveryBody>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: body.approvalId,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ approvalId: body.approvalId, generation: body.generation, requestHash: body.requestHash, authorizationHash: body.authorizationHash, keyId: body.keyId }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);

    const approval = this.store.getApproval(body.approvalId);
    if (!approval) fail("not_found", "no approval exists for this delivery");
    if (approval.consumerFingerprint !== this.identity.peer.fingerprint) fail("stale_identity", "the approval belongs to another consumer");
    if (approval.requestHash !== body.requestHash) fail("conflict", "the delivery names another request");
    if (approval.generation !== body.generation) fail("conflict", "the delivery names another approval generation");
    if (approval.keyId && approval.keyId !== body.keyId) fail("conflict", "the delivery carries a different key than approved");
    if (!sameSet(JSON.parse(approval.modelsJson) as string[], body.models)) fail("conflict", "the delivery models differ from the approval");
    if (Math.abs(approval.capUsd - body.capUsd) > 1e-9) fail("conflict", "the delivery cap differs from the approval");
    if (Date.parse(body.expiresAt) <= this.clock().getTime()) fail("expired", "the delivery already expired");

    // Defense in depth: even if a session somehow carried a stale delivery, a
    // revoked/uncertain approval is not importable.
    if (!["approved", "delivering", "delivered", "acked"].includes(approval.state)) {
      fail("conflict", `the approval is ${approval.state}; the delivery cannot be imported`);
    }
    const existing = this.store.getDelivery(body.approvalId);
    if (existing?.state === "revoked") fail("conflict", "the authorization was revoked");
    if (!existing && this.store.hasTombstone("authorization", body.approvalId)) fail("conflict", "the authorization was revoked");
    if (existing) {
      if (existing.authorizationHash !== body.authorizationHash || existing.keyId !== body.keyId) {
        this.store.transitionApproval(body.approvalId, ["approved", "delivering", "delivered"], "uncertain", { error: "superseded by a different delivery" });
        fail("conflict", "this approval already carries a different authorization");
      }
      if (existing.state === "delivered" || existing.state === "acked") {
        await this.enqueueAck({ approvalId: body.approvalId, generation: body.generation, requestHash: body.requestHash, authorizationHash: body.authorizationHash, keyId: body.keyId, models: body.models, capUsd: body.capUsd });
        return this.finishInbox(inbox.row, "duplicate", { approvalId: body.approvalId, state: "registered", keyId: body.keyId });
      }
    }

    const opened = openAuthorization(
      session.authorizationKey,
      {
        sessionId: session.sessionId,
        approvalId: body.approvalId,
        requestHash: body.requestHash,
        authorizationHash: body.authorizationHash,
        recipientFingerprint: this.identity.peer.fingerprint,
      },
      body.sealed,
      {
        providerNodeId: session.peer.nodeId,
        consumerNodeId: this.identity.peer.nodeId,
        consumerFingerprint: this.identity.peer.fingerprint,
      },
    );
    const document = opened.document;
    if (document.quote.identityFingerprint !== session.peer.fingerprint) fail("stale_identity", "the authorization names another provider key");
    if (document.quote.contentHash !== body.quoteHash) fail("quote_mismatch", "the authorization quote differs from the delivery");
    if (document.quote.priceVersion !== body.priceVersion) fail("quote_mismatch", "the authorization price version differs from the delivery");
    if (document.keyId !== body.keyId || document.keyName !== body.keyName) fail("conflict", "the authorization key identity differs from the delivery");
    if (!sameSet(document.models, body.models) || Math.abs(document.capUsd - body.capUsd) > 1e-9) {
      fail("conflict", "the authorization models/cap differ from the delivery");
    }
    if (session.catalogQuoteHash && document.quote.contentHash !== session.catalogQuoteHash) fail("quote_mismatch", "the authorization is for a quote this session did not bind");

    // The actual received key must not already have been imported under another
    // approval/generation. The hash is computed by the core from the received
    // document, not trusted from a caller-declared field.
    const receivedKeyHash = keyHashOf(document.key);
    if (receivedKeyHash !== document.keyHash) fail("malformed", "the received authorization key does not match its hash");
    const priorKey = this.store.keyHashSeenElsewhere(this.identity.peer.nodeId, receivedKeyHash, body.approvalId);
    if (priorKey.length > 0) {
      this.store.prepareDelivery({
        approvalId: body.approvalId,
        authorizationHash: body.authorizationHash,
        keyId: body.keyId,
        keyName: body.keyName,
        keyHash: receivedKeyHash,
        state: "uncertain",
        preparedAt: this.clock().toISOString(),
        deliveredAt: null,
        lastError: "this Gateway Key was already imported under another approval",
      });
      fail("conflict", "this Gateway Key was already imported under another approval; it cannot be reused");
    }

    const inbound = inboundApprovalOf({ ...body, consumerNodeId: this.identity.peer.nodeId, consumerFingerprint: this.identity.peer.fingerprint, providerNodeId: session.peer.nodeId, providerFingerprint: session.peer.fingerprint } as P2pApprovedBody, session.peer);
    // Registration happens before any ACK. If it throws, the inbox row is
    // abandoned and the provider's bounded retry can deliver the same generation
    // again; no ACK is sent and nothing is marked delivered.
    const registration = await this.port.importAuthorization({
      document,
      approval: inbound,
      session: { sessionId: session.sessionId, peer: session.peer },
    });
    if (!sameSet(registration.models, document.models) || Math.abs(registration.capUsd - document.capUsd) > 1e-9) {
      this.store.prepareDelivery({
        approvalId: body.approvalId,
        authorizationHash: body.authorizationHash,
        keyId: body.keyId,
        keyName: body.keyName,
        keyHash: receivedKeyHash,
        state: "uncertain",
        preparedAt: this.clock().toISOString(),
        deliveredAt: null,
        lastError: "local registration readback differs from the authorization",
      });
      fail("conflict", "the local Magpie readback differs from the authorization; not acknowledged");
    }

    this.store.db.transaction(() => {
      this.store.prepareDelivery({
        approvalId: body.approvalId,
        authorizationHash: body.authorizationHash,
        keyId: body.keyId,
        keyName: body.keyName,
        keyHash: receivedKeyHash,
        state: "delivered",
        preparedAt: this.clock().toISOString(),
        deliveredAt: this.clock().toISOString(),
        lastError: null,
      });
      this.store.transitionApproval(body.approvalId, ["approved", "delivering", "delivered"], "delivered", {
        keyId: document.keyId,
        keyName: document.keyName,
        authorizationHash: body.authorizationHash,
        deliveredAt: this.clock().toISOString(),
      });
    })();
    await this.enqueueAck({ approvalId: body.approvalId, generation: body.generation, requestHash: body.requestHash, authorizationHash: body.authorizationHash, keyId: body.keyId, models: body.models, capUsd: body.capUsd });
    return this.finishInbox(inbox.row, "registered", { approvalId: body.approvalId, state: "registered", keyId: document.keyId, authorizationHash: body.authorizationHash });
  }

  private async onRevoked(envelope: P2pEnvelope<P2pRevokedBody>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: body.approvalId,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ approvalId: body.approvalId, consumerNodeId: body.consumerNodeId, reason: body.reason }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);
    if (body.consumerFingerprint !== this.identity.peer.fingerprint) fail("stale_identity", "the revocation is for another consumer");
    const approvals: P2pApprovalRow[] = body.approvalId
      ? [this.store.getApproval(body.approvalId)].filter((a): a is P2pApprovalRow => Boolean(a))
      : this.store.listApprovals(this.identity.peer.nodeId);
    for (const approval of approvals) {
      this.store.transitionApproval(approval.approvalId, [...ACTIVE_APPROVAL_STATES], "revoked", { error: body.reason });
      this.store.setDeliveryState(approval.approvalId, "revoked", this.clock(), body.reason);
      this.store.putTombstone("authorization", approval.approvalId, `revoked: ${body.reason}`, this.clock());
      await this.port.dropAuthorization({
        approvalId: approval.approvalId,
        consumerNodeId: this.identity.peer.nodeId,
        providerNodeId: approval.providerNodeId ?? envelope.from.nodeId,
        providerFingerprint: approval.providerFingerprint ?? envelope.from.fingerprint,
        reason: body.reason,
      });
    }
    return this.finishInbox(inbox.row, "ok", { approvalId: body.approvalId, state: "revoked" });
  }

  private async onQuoteChanged(envelope: P2pEnvelope<{ quoteHash: string; priceVersion: string; models: string[] }>): Promise<{ code: P2pResultCode; result: Record<string, unknown> }> {
    const body = envelope.body;
    const inbox = this.store.enqueueInbox({
      messageId: envelope.id,
      idempotency: envelope.idempotency,
      type: envelope.type,
      fromAccountId: envelope.from.accountId,
      fromNodeId: envelope.from.nodeId,
      fromFingerprint: envelope.from.fingerprint,
      correlation: null,
      bodyHash: sha256Hex(canonicalJson(body)),
      metaJson: canonicalJson({ quoteHash: body.quoteHash, priceVersion: body.priceVersion }),
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: envelope.expires,
      receivedAt: this.clock().toISOString(),
    });
    if (!inbox.created) return duplicateInbox(inbox.row);
    return this.finishInbox(inbox.row, "ok", { quoteHash: body.quoteHash });
  }

  // --- local consumer actions ------------------------------------------------

  async requestConnection(input: { sessionId: string; request: P2pRequestDocument }): Promise<{ requestHash: string; approvalId: null; state: "pending" }> {
    this.assertOpen();
    const session = this.sessions.get(input.sessionId);
    if (!session || session.closedReason) fail("session_closed", "the session is not open; handshake again");
    const verdict = this.trust({ nodeId: session.peer.nodeId, fingerprint: session.peer.fingerprint });
    if (verdict !== "accepted") fail("untrusted_peer", `the provider identity is ${verdict}; accept its catalogue key first`);
    if (input.request.provider.nodeId !== session.peer.nodeId) fail("target_mismatch", "the request provider is not the session peer");
    if (input.request.acceptance.fingerprint !== session.peer.fingerprint || input.request.quote.identityFingerprint !== session.peer.fingerprint) {
      fail("quote_mismatch", "the request does not accept the session peer's key");
    }
    if (session.catalogQuoteHash && input.request.quote.contentHash !== session.catalogQuoteHash) {
      fail("quote_mismatch", "the request quote is not the quote this session bound");
    }
    return this.serial(async () => {
      const requestHash = requestHashOf(input.request);
      const body: P2pConnectionRequestBody = { requestHash, request: input.request };
      const idempotency = expectedIdempotency("connection_request", requestHash);
      // The consumer keeps its own copy of what it asked for; the provider's
      // approval is matched against this row, never against a file.
      this.store.insertRequest({
        requestHash,
        sessionId: session.sessionId,
        consumerAccountId: session.self.accountId,
        consumerNodeId: session.self.nodeId,
        consumerFingerprint: session.self.fingerprint,
        providerNodeId: session.peer.nodeId,
        providerFingerprint: session.peer.fingerprint,
        quoteHash: input.request.quote.contentHash,
        priceVersion: input.request.quote.priceVersion,
        modelsJson: canonicalJson(input.request.models),
        eligibleJson: null,
        documentJson: canonicalJson(input.request),
        state: "requested",
        receivedAt: this.clock().toISOString(),
        expiresAt: new Date(this.clock().getTime() + this.deliveryTtlMs).toISOString(),
        approvalId: null,
        note: null,
      });
      this.store.enqueueOutbox({
        messageId: id16(),
        sessionId: session.sessionId,
        peerNodeId: session.peer.nodeId,
        peerFingerprint: session.peer.fingerprint,
        type: "connection_request",
        idempotency,
        correlation: null,
        // The consumer has no local request row; the document itself is the
        // non-sensitive payload that lets a bounded retry rebuild the envelope.
        payloadJson: canonicalJson({ requestHash, request: input.request }),
        bodyHash: sha256Hex(canonicalJson(body)),
        state: "pending",
        nextAttemptAt: this.clock().toISOString(),
        expiresAt: new Date(this.clock().getTime() + this.deliveryTtlMs).toISOString(),
        createdAt: this.clock().toISOString(),
      });
      await this.sendDueFor(session);
      return { requestHash, approvalId: null, state: "pending" as const };
    });
  }

  // --- local provider actions ------------------------------------------------

  async acceptConsumer(nodeId: string, expectedFingerprint: string): Promise<{ accepted: string; revoked: string[]; uncertain: string[] }> {
    this.assertOpen();
    const row = this.store.getPeer(nodeId);
    if (!row) fail("not_found", "this consumer has never been seen");
    const old = rowToPeer(row);
    const pending = pendingPeerOf(row);
    if (pending) {
      if (pending.fingerprint !== expectedFingerprint) fail("stale_identity", "the pending fingerprint changed; review it again");
      const accepted = this.store.acceptPendingPeer(nodeId, expectedFingerprint, this.clock());
      const invalidation = await this.invalidateOldIdentity(nodeId, old, rowToPeer(accepted));
      return { accepted: accepted.fingerprint, ...invalidation };
    }
    if (old.fingerprint !== expectedFingerprint) fail("stale_identity", "this is not the accepted fingerprint for the node");
    this.store.acceptPeer(old, this.clock());
    return { accepted: old.fingerprint, revoked: [], uncertain: [] };
  }

  /**
   * The single local approval action: accepts the consumer identity if asked,
   * revalidates the quote, creates/ensures the key exactly once for this
   * generation, binds the authorization hash, and queues the encrypted
   * delivery. No second "send key" action exists.
   */
  async approve(requestHash: string, input: { models: string[]; capUsd: number; memo?: string | null; acceptConsumer?: boolean }): Promise<P2pApprovalView> {
    this.assertOpen();
    return this.serial(async () => {
      const models = modelListOf(input.models, "approved models");
      const capUsd = capOnGridOf(input.capUsd, "approved cap");
      const memo = input.memo == null ? null : String(input.memo).slice(0, MAX_MEMO);
      if (memo !== null && /[\u0000-\u001f\u007f]/.test(memo)) fail("malformed", "the memo contains a control character");
      const request = this.store.getRequest(requestHash);
      if (!request) fail("not_found", "no such connection request");

      const peerRow = this.store.getPeer(request.consumerNodeId);
      if (!peerRow) fail("not_found", "the consumer identity is not recorded");
      const oldPeer = rowToPeer(peerRow);
      // If a different key was seen for this node, the human decision is about
      // that *pending* key, not the old one. The request must be signed by it.
      const pending = pendingPeerOf(peerRow);
      const peer = pending ?? oldPeer;
      if (request.consumerFingerprint !== peer.fingerprint) fail("stale_identity", "the request was stored for another consumer key");
      let verdict = trustVerdict(trustRowToLike(peerRow), peer);
      if (verdict !== "accepted") {
        if (!input.acceptConsumer) fail("untrusted_peer", `the consumer identity is ${verdict}; accept it in the same explicit approval`);
        if (pending) this.store.acceptPendingPeer(peer.nodeId, peer.fingerprint, this.clock());
        else this.store.acceptPeer(peer, this.clock());
        if (peer.fingerprint !== oldPeer.fingerprint) {
          const invalidation = await this.invalidateOldIdentity(peer.nodeId, oldPeer, peer);
          if (invalidation.uncertain.length > 0) {
            // The old native key is not proven gone. Approving the new identity
            // now would leave two usable keys for one node.
            fail("conflict", "the replaced identity's native key could not be revoked; reconcile it before approving the new identity");
          }
        }
        verdict = "accepted";
      }
      // Runs on every approval path (pending cleared, restart, same identity):
      // a historic identity whose key is not confirmed revoked blocks this.
      this.assertNoUnresolvedLegacyIdentity(request.consumerNodeId, peer.fingerprint, "approval");
      // A second request from the same identity must not mint another key while
      // any other approval for this consumer has an unconfirmed key.
      this.assertNoOtherUnresolvedApproval(peer.nodeId, requestHash);
      if (!models.every((m) => JSON.parse(request.modelsJson).includes(m))) fail("conflict", "approved models must be a subset of the request");

      const active = this.store.activeApprovalByRequest(requestHash);
      if (active) {
        const sameDecision = sameSet(JSON.parse(active.modelsJson) as string[], models) && Math.abs(active.capUsd - capUsd) <= 1e-9 && (active.memo ?? null) === memo;
        if (sameDecision) return this.viewOf(active);
        fail("conflict", "this request is already approved with a different decision");
      }
      if (!["received", "awaiting-trust", "awaiting-approval", "rejected", "expired", "revoked"].includes(request.state)) {
        fail("conflict", `the request is ${request.state}`);
      }

      const document = JSON.parse(request.documentJson) as P2pRequestDocument;
      const context = await this.port.providerContext();
      this.assertRequestAgainstContext(document, context);

      // A port.approve may have created a key and then failed/restarted. That
      // unresolved attempt, not a new generation, is the only thing we may
      // continue: first a read-only reconcile, then either adopt the original
      // key or retry the same approvalId/generation. Never mint a second key.
      const unresolved = this.store
        .listApprovals(peer.nodeId)
        .filter((a) => a.requestHash === requestHash && (a.state === "approving" || a.state === "uncertain"))
        .sort((a, b) => b.generation - a.generation)[0] ?? null;
      if (unresolved) {
        const sameDecision =
          sameSet(JSON.parse(unresolved.modelsJson) as string[], models) &&
          Math.abs(unresolved.capUsd - capUsd) <= 1e-9 &&
          (unresolved.memo ?? null) === memo;
        if (!sameDecision) fail("conflict", "an unresolved approval exists with a different models/cap/memo decision; resolve it first");
        if (Date.parse(unresolved.expiresAt) <= this.clock().getTime()) {
          fail("conflict", "the unresolved approval has expired; reconcile or revoke it explicitly, do not create a new key");
        }
        const reconciled = await this.reconcileApprovalAttempt(unresolved, peer, document);
        if (reconciled) return reconciled;
        return this.runApprovalAttempt(unresolved, peer, document);
      }

      const generation = this.store.nextGeneration(requestHash);
      const approvalId = id16();
      const expiresAt = new Date(this.clock().getTime() + this.approvalTtlMs).toISOString();
      // Persist the attempt BEFORE calling the port: a crash or a throw can no
      // longer be mistaken for "no key was created".
      this.store.insertApproval({
        approvalId,
        requestHash,
        generation,
        providerNodeId: this.identity.peer.nodeId,
        providerFingerprint: this.identity.peer.fingerprint,
        consumerAccountId: peer.accountId,
        consumerNodeId: peer.nodeId,
        consumerFingerprint: peer.fingerprint,
        quoteHash: document.quote.contentHash,
        priceVersion: document.quote.priceVersion,
        modelsJson: canonicalJson(models),
        capUsd,
        memo,
        state: "approving",
        createdAt: this.clock().toISOString(),
        approvedAt: null,
        expiresAt,
        keyId: null,
        keyName: null,
        authorizationHash: null,
        deliveredAt: null,
        error: null,
        enforcedAt: null,
        enforcement: null,
        enforcedKeyId: null,
      });
      return this.runApprovalAttempt(this.store.getApproval(approvalId)!, peer, document);
    });
  }

  /**
   * Calls the approval port for an already persisted attempt. On a throw the row
   * stays the single unresolved intent for this request; a later approve must
   * reconcile it, not create a new generation.
   */
  private async runApprovalAttempt(approval: P2pApprovalRow, peer: P2pPeerView, document: P2pRequestDocument): Promise<P2pApprovalView> {
    const models = JSON.parse(approval.modelsJson) as string[];
    let materials: P2pApprovedMaterials;
    try {
      materials = await this.port.approve({
        approvalId: approval.approvalId,
        generation: approval.generation,
        requestHash: approval.requestHash,
        request: document,
        consumer: peer,
        models,
        capUsd: approval.capUsd,
        memo: approval.memo,
        quote: { contentHash: approval.quoteHash, identityFingerprint: document.quote.identityFingerprint },
      });
    } catch (e) {
      this.store.transitionApproval(approval.approvalId, ["approving", "uncertain"], "uncertain", {
        error: e instanceof Error ? e.message.slice(0, 300) : "approval failed",
      });
      throw e;
    }
    this.assertApprovedMaterials(approval.approvalId, approval.generation, peer, models, approval.capUsd, approval.memo, document, materials);
    this.assertNoReusedKeyId(approval.approvalId, peer.nodeId, materials.keyId, materials.keyName);
    if (!this.store.transitionApproval(approval.approvalId, ["approving", "uncertain"], "approved", {
      approvedAt: this.clock().toISOString(),
      keyId: materials.keyId,
      keyName: materials.keyName,
      expiresAt: materials.expiresAt,
      priceVersion: materials.priceVersion,
    })) {
      this.store.transitionApproval(approval.approvalId, ["approving", "uncertain"], "uncertain", { error: "approval state changed concurrently" });
      fail("conflict", "the approval was revoked while it was being prepared");
    }
    this.store.setRequestState(approval.requestHash, "approved", this.clock(), { approvalId: approval.approvalId });
    this.enqueueApproved(approval.approvalId, peer, document, materials);
    try {
      await this.prepareDelivery(approval.approvalId);
    } catch (e) {
      // The approval stands and the consumer is told; the key/delivery needs a
      // human look. Never retry this by creating a new key.
      this.store.transitionApproval(approval.approvalId, ["approved", "delivering"], "uncertain", { error: `delivery preparation failed: ${e instanceof Error ? e.message.slice(0, 240) : "unknown"}` });
    }
    const session = this.newestSessionFor(peer.nodeId, peer.fingerprint);
    if (session) await this.sendDueFor(session);
    return this.viewApproval(approval.approvalId);
  }

  /**
   * Read-only lookup of an interrupted approval attempt. Returns a view if the
   * original key exists; null means the port confirms no side effect and the
   * same approvalId/generation may be retried; anything unknown keeps the row
   * uncertain and blocks a new generation.
   */
  /**
   * A reconcile result is only usable if it echoes this exact attempt and the
   * adapter's readback. Missing/mismatched bindings or stale/absent evidence
   * keep the approval uncertain; they never authorize a retry.
   */
  private reconcileBindingError(result: P2pApprovalReconcile, approval: P2pApprovalRow): string | null {
    if (result.state === "unknown") return "the reconcile result is unknown";
    if (result.requestHash !== approval.requestHash) return "reconcile request hash mismatch";
    if (result.approvalId !== approval.approvalId) return "reconcile approval id mismatch";
    if (result.generation !== approval.generation) return "reconcile generation mismatch";
    if (result.consumerNodeId !== approval.consumerNodeId) return "reconcile consumer node mismatch";
    if (result.consumerFingerprint !== approval.consumerFingerprint) return "reconcile consumer fingerprint mismatch";
    if (result.state === "keyReady") {
      if (!result.keyId) return "reconcile keyReady has no key id";
      if (approval.keyId && result.keyId !== approval.keyId) return "reconcile key id mismatch";
    } else if ((result.keyId ?? null) !== (approval.keyId ?? null)) {
      return "noSideEffect contradicts the recorded key id";
    }
    const evidence = result.evidence;
    if (!evidence || typeof evidence !== "object") return "reconcile evidence is missing";
    if (typeof evidence.source !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(evidence.source)) return "reconcile evidence source is invalid";
    if (typeof evidence.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(evidence.observedAt)) return "reconcile evidence timestamp is invalid";
    const observed = Date.parse(evidence.observedAt);
    if (!Number.isFinite(observed) || Math.abs(this.clock().getTime() - observed) > 5 * 60_000) return "reconcile evidence is stale";
    if (!Array.isArray(evidence.checked) || evidence.checked.length < 1 || evidence.checked.length > 20) return "reconcile evidence fields are missing";
    if (evidence.checked.some((field) => typeof field !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(field))) return "reconcile evidence fields are invalid";
    if (evidence.nativeKeyIds !== undefined) {
      if (!Array.isArray(evidence.nativeKeyIds) || evidence.nativeKeyIds.length > 100) return "reconcile native key list is invalid";
      if (evidence.nativeKeyIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(id))) return "reconcile native key list is invalid";
    }
    if (result.state === "keyReady") {
      if (evidence.source !== "magpie-key-readback") return "keyReady needs magpie-key-readback evidence";
      for (const field of ["keys", "keyId", "models", "costLimit"]) {
        if (!evidence.checked.includes(field)) return "keyReady evidence did not read " + field;
      }
      if (!evidence.nativeKeyIds || !evidence.nativeKeyIds.includes(result.keyId)) return "keyReady evidence does not include the key id";
    } else {
      if (evidence.source !== "provisioner-journal:magpie-readback") return "noSideEffect needs the provisioner journal plus a Magpie key readback";
      for (const field of ["journal", "keys"]) {
        if (!evidence.checked.includes(field)) return "noSideEffect evidence did not read " + field;
      }
      // [] is valid and meaningful; an omitted list is not evidence.
      if (!Array.isArray(evidence.nativeKeyIds)) return "noSideEffect needs an explicit nativeKeyIds array";
      if (approval.keyId && evidence.nativeKeyIds.includes(approval.keyId)) return "noSideEffect contradicts the native key list";
    }
    try {
      assertNoSecretMaterial(evidence, "reconcile evidence");
    } catch {
      return "reconcile evidence contains credential material";
    }
    return null;
  }

  private async reconcileApprovalAttempt(approval: P2pApprovalRow, peer: P2pPeerView, document: P2pRequestDocument): Promise<P2pApprovalView | null> {
    if (!this.port.reconcileApproval) {
      fail("conflict", "an approval attempt is unresolved and the port has no read-only reconcile; refusing to create a new key");
    }
    let result: P2pApprovalReconcile;
    try {
      result = await this.port.reconcileApproval({
        requestHash: approval.requestHash,
        approvalId: approval.approvalId,
        generation: approval.generation,
        consumer: peer,
        keyId: approval.keyId,
      });
    } catch (e) {
      fail("conflict", `cannot reconcile the unresolved approval: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}; it stays uncertain`);
    }
    if (result.state === "unknown") {
      fail("conflict", `the unresolved approval is still unknown${result.detail ? ` (${result.detail.slice(0, 120)})` : ""}; reconcile or revoke it explicitly`);
    }
    const bindingError = this.reconcileBindingError(result, approval);
    if (bindingError) fail("conflict", bindingError + "; the approval stays uncertain");
    if (result.state === "noSideEffect") return null;

    const materials: P2pApprovedMaterials = {
      approvalId: approval.approvalId,
      generation: approval.generation,
      consumerNodeId: approval.consumerNodeId,
      consumerFingerprint: approval.consumerFingerprint,
      models: result.models,
      capUsd: result.capUsd,
      quoteHash: approval.quoteHash,
      priceVersion: result.priceVersion,
      expiresAt: result.expiresAt,
      keyId: result.keyId,
      keyName: result.keyName,
      memo: approval.memo,
    };
    this.assertApprovedMaterials(approval.approvalId, approval.generation, peer, JSON.parse(approval.modelsJson) as string[], approval.capUsd, approval.memo, document, materials);
    this.assertNoReusedKeyId(approval.approvalId, peer.nodeId, materials.keyId, materials.keyName);
    if (!this.store.transitionApproval(approval.approvalId, ["approving", "uncertain"], "approved", {
      approvedAt: this.clock().toISOString(),
      keyId: materials.keyId,
      keyName: materials.keyName,
      expiresAt: materials.expiresAt,
      priceVersion: materials.priceVersion,
    })) {
      fail("conflict", "the unresolved approval changed concurrently; re-read it");
    }
    this.store.setRequestState(approval.requestHash, "approved", this.clock(), { approvalId: approval.approvalId });
    this.enqueueApproved(approval.approvalId, peer, document, materials);
    try {
      await this.prepareDelivery(approval.approvalId);
    } catch (e) {
      this.store.transitionApproval(approval.approvalId, ["approved", "delivering"], "uncertain", { error: `delivery preparation failed: ${e instanceof Error ? e.message.slice(0, 240) : "unknown"}` });
    }
    const session = this.newestSessionFor(peer.nodeId, peer.fingerprint);
    if (session) await this.sendDueFor(session);
    return this.viewApproval(approval.approvalId);
  }

  /** A key id seen on any other approval for this node must not be reused. */
  private assertNoReusedKeyId(approvalId: string, nodeId: string, keyId: string, keyName: string): void {
    const prior = this.store.listApprovals(nodeId).filter((a) => a.approvalId !== approvalId && a.keyId && a.keyId === keyId);
    if (prior.length > 0) {
      // Persist the returned key identity so a revoke can bind to the real key;
      // this is an uncertain attempt, not a delivered authorization.
      this.store.transitionApproval(approvalId, ["approving", "uncertain"], "uncertain", {
        keyId,
        keyName,
        error: `the provisioner reused key ${keyId} from approval ${prior[0].approvalId}`,
      });
      fail("conflict", "the provisioner returned an already-used key id; it was not delivered");
    }
  }

  /** Explicitly rejects a pending key change; the previously accepted key stays. */
  rejectConsumerIdentityChange(nodeId: string, expectedFingerprint: string): void {
    this.assertOpen();
    this.store.rejectPendingPeer(nodeId, expectedFingerprint, this.clock());
  }

  async reject(requestHash: string, reason: P2pRejectionReason, note?: string): Promise<void> {
    this.assertOpen();
    await this.serial(async () => {
      const request = this.store.getRequest(requestHash);
      if (!request) fail("not_found", "no such connection request");
      if (this.store.activeApprovalByRequest(requestHash)) fail("conflict", "an approved request must be revoked, not rejected");
      this.store.setRequestState(requestHash, "rejected", this.clock(), { note: reason });
      await this.enqueueRejection(requestHash, reason, note ?? null);
    });
  }

  /** Revoke: the provisioner key must actually be gone before the notice is queued. */
  async revoke(approvalId: string, reason: P2pRevokeReason): Promise<void> {
    this.assertOpen();
    await this.serial(async () => {
      const approval = this.store.getApproval(approvalId);
      if (!approval) fail("not_found", "no such approval");
      // A revoked row is done only with valid durable enforcement. A legacy
      // revoked row without it is re-confirmed through the port (never assumed).
      if (this.revokeEnforced(approval)) return;
      let outcome: P2pRevokeOutcome | null | undefined;
      try {
        outcome = await this.port.revoke({
          consumerNodeId: approval.consumerNodeId,
          approvalId,
          keyId: approval.keyId,
          generation: approval.generation,
          reason,
        });
      } catch (e) {
        // The native key is not proven gone: keep the approval actionable and do
        // not send a revocation that claims otherwise.
        this.store.transitionApproval(approvalId, [...ACTIVE_APPROVAL_STATES], "uncertain", { error: `revoke failed: ${e instanceof Error ? e.message.slice(0, 240) : "unknown"}` });
        throw e;
      }
      const confirmation = this.revokeConfirmation(outcome, approval);
      if (!confirmation.ok) {
        this.store.transitionApproval(approvalId, [...ACTIVE_APPROVAL_STATES], "uncertain", { error: `revoke not enforced: ${confirmation.reason}`.slice(0, 300) });
        fail("conflict", `the native key is not confirmed gone (${confirmation.reason}); no revocation notice was sent`);
      }
      // An uncertain approval is still revocable: the port just confirmed that
      // the native key is gone, so the state must be allowed to converge.
      if (!this.store.transitionApproval(approvalId, [...REVOCABLE_STATES], "revoked", { error: reason })) {
        const current = this.store.getApproval(approvalId);
        if (current?.state !== "revoked") fail("conflict", `the approval cannot be revoked from ${current?.state ?? "unknown"}`);
      }
      // Durable, never-purged proof of typed enforcement (the tombstone may be
      // purged by TTL; the gate must not depend on it).
      const confirmedOutcome = outcome as P2pRevokeConfirmed;
      this.store.recordEnforcement(approvalId, {
        enforcedAt: this.clock().toISOString(),
        enforcement: confirmedOutcome.enforcement,
        enforcedKeyId: confirmedOutcome.keyId,
      });
      // The request becomes re-approvable as a NEW generation; the old one is
      // tombstoned and its key is already gone. No key is reissued here.
      this.store.setRequestState(approval.requestHash, "revoked", this.clock(), { note: reason });
      this.store.setDeliveryState(approvalId, "revoked", this.clock(), reason);
      this.store.putTombstone("authorization", approvalId, `revoked: ${reason}`, this.clock());
      // Queued approved/delivery frames for this generation must not go out
      // after the key is gone. The revocation notice is enqueued below.
      this.store.cancelOutboxForApproval(approvalId, this.clock());
      const body: P2pRevokedBody = {
        approvalId,
        consumerNodeId: approval.consumerNodeId,
        consumerFingerprint: approval.consumerFingerprint,
        reason,
      };
      const idempotency = expectedIdempotency("revoked", approvalId);
      this.store.enqueueOutbox({
        messageId: id16(),
        sessionId: null,
        peerNodeId: approval.consumerNodeId,
        peerFingerprint: approval.consumerFingerprint,
        type: "revoked",
        idempotency,
        correlation: approvalId,
        payloadJson: canonicalJson({ approvalId, reason }),
        bodyHash: sha256Hex(canonicalJson(body)),
        state: "pending",
        nextAttemptAt: this.clock().toISOString(),
        expiresAt: new Date(this.clock().getTime() + this.deliveryTtlMs).toISOString(),
        createdAt: this.clock().toISOString(),
      });
      const session = this.newestSessionFor(approval.consumerNodeId, approval.consumerFingerprint);
      if (session) await this.sendDueFor(session);
    });
  }

  async notifyQuoteChanged(input: { quoteHash: string; priceVersion: string; models: string[] }): Promise<number> {
    this.assertOpen();
    return this.serial(async () => {
      const body = { quoteHash: input.quoteHash, priceVersion: input.priceVersion, models: modelListOf(input.models, "quote models") };
      const idempotency = expectedIdempotency("quote_changed", input.quoteHash);
      const seen = new Set<string>();
      let queued = 0;
      for (const approval of this.store.listApprovals()) {
        if (!["approved", "delivering", "delivered", "acked"].includes(approval.state)) continue;
        if (seen.has(approval.consumerNodeId)) continue;
        seen.add(approval.consumerNodeId);
        const res = this.store.enqueueOutbox({
          messageId: id16(),
          sessionId: null,
          peerNodeId: approval.consumerNodeId,
          peerFingerprint: approval.consumerFingerprint,
          type: "quote_changed",
          idempotency,
          correlation: null,
          payloadJson: canonicalJson(body),
          bodyHash: sha256Hex(canonicalJson(body)),
          state: "pending",
          nextAttemptAt: this.clock().toISOString(),
          expiresAt: new Date(this.clock().getTime() + this.deliveryTtlMs).toISOString(),
          createdAt: this.clock().toISOString(),
        });
        if (res.created) queued += 1;
      }
      return queued;
    });
  }

  // --- views -----------------------------------------------------------------

  async listRequests(): Promise<P2pRequestView[]> {
    const raws = this.store.db.query("SELECT request_hash FROM p2p_requests ORDER BY received_at DESC LIMIT 100").all() as { request_hash: string }[];
    const out: P2pRequestView[] = [];
    for (const raw of raws) {
      const request = this.store.getRequest(raw.request_hash);
      if (!request) continue;
      const trustRow = this.store.getPeer(request.consumerNodeId);
      const trust = trustRow ? trustVerdict(trustRowToLike(trustRow), rowToPeer(trustRow)) : "unknown";
      const approval = this.store.activeApprovalByRequest(request.requestHash);
      out.push({
        requestHash: request.requestHash,
        state: approval?.state ?? request.state,
        receivedAt: request.receivedAt,
        expiresAt: request.expiresAt,
        models: JSON.parse(request.modelsJson) as string[],
        quoteHash: request.quoteHash,
        priceVersion: request.priceVersion,
        consumer: { nodeId: request.consumerNodeId, fingerprint: request.consumerFingerprint, hostname: trustRow?.hostname ?? "" },
        trust,
        approvalId: approval?.approvalId ?? request.approvalId,
        approvalState: approval?.state ?? null,
        note: request.note,
      });
    }
    return out;
  }

  async listApprovals(): Promise<P2pApprovalView[]> {
    return this.store.listApprovals().map((row) => this.viewOf(row));
  }

  async approvalView(approvalId: string): Promise<P2pApprovalView | null> {
    const row = this.store.getApproval(approvalId);
    return row ? this.viewOf(row) : null;
  }

  private viewApproval(approvalId: string): P2pApprovalView {
    const row = this.store.getApproval(approvalId);
    if (!row) fail("not_found", "no such approval");
    return this.viewOf(row);
  }

  private viewOf(row: P2pApprovalRow): P2pApprovalView {
    const delivery = this.store.getDelivery(row.approvalId);
    const ackState: P2pApprovalView["ackState"] = row.state === "acked" ? "acked" : row.state === "uncertain" && delivery?.lastError ? "failed" : row.state === "delivered" || row.state === "delivering" ? "pending" : "none";
    let actionNeeded: string | null = null;
    if (row.state === "uncertain") actionNeeded = "reconcile-before-retry";
    else if (row.state === "approved" && !row.authorizationHash) actionNeeded = "prepare-delivery";
    else if (row.state === "delivered" && ackState === "pending") actionNeeded = "ack-missing";
    return {
      approvalId: row.approvalId,
      requestHash: row.requestHash,
      generation: row.generation,
      state: row.state,
      models: JSON.parse(row.modelsJson) as string[],
      capUsd: row.capUsd,
      quoteHash: row.quoteHash,
      priceVersion: row.priceVersion,
      requestedPriceVersion: this.store.getRequest(row.requestHash)?.priceVersion ?? row.priceVersion,
      provider: { nodeId: row.providerNodeId, fingerprint: row.providerFingerprint },
      consumer: { nodeId: row.consumerNodeId, fingerprint: row.consumerFingerprint },
      keyId: row.keyId,
      keyName: row.keyName,
      authorizationHash: row.authorizationHash,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      expiresAt: row.expiresAt,
      deliveredAt: row.deliveredAt,
      ackState,
      memo: row.memo,
      error: row.error,
      actionNeeded,
    };
  }

  // --- ticking / recovery ----------------------------------------------------

  /**
   * Boot recovery + bounded retry driver. ACK loss is handled by re-sending the
   * **same** approval generation (same authorizationHash) and by `status`
   * queries; it never creates a second key.
   */
  async tick(now?: Date): Promise<P2pTickResult> {
    this.assertOpen();
    return this.serial(async () => {
      const at = now ?? this.clock();
      const recovered: P2pRecoveryReport | null = this.recoveryReport;
      this.recoveryReport = null;
      const sessionsExpired = this.store.expireSessions(at);
      for (const session of this.sessions.values()) {
        if (!session.closedReason && Date.parse(session.expiresAt) <= at.getTime()) session.close("expired");
      }
      const rearmed = await this.rearmDeliveries(at);
      let sent = 0;
      let failed = 0;
      let dead = 0;
      const actionNeeded = new Set<string>();
      if (this.transport) {
        for (const row of this.dueRows(at)) {
          if (row.type === "authorization_delivery" && !this.approvedWasSent(row)) continue;
          const session = this.sessionForRow(row);
          if (!session) continue;
          if (this.transport.canPush && !this.transport.canPush(session.peer)) continue;
          if (!this.store.markOutboxSending(row.messageId, at)) continue;
          try {
            const frame = await this.materialize(row, session);
            await this.transport.frame({ sessionId: session.sessionId, peer: session.peer }, frame);
            this.store.markOutboxSent(row.messageId, at);
            sent += 1;
          } catch (e) {
            const result = this.store.markOutboxRetry(row.messageId, at, e instanceof Error ? e.message : String(e), this.retry);
            if (result.dead) dead += 1;
            else failed += 1;
          }
        }
      }
      for (const approval of this.store.listApprovals()) {
        if (approval.state === "uncertain") actionNeeded.add(`approval:${approval.approvalId}`);
        if (approval.state === "delivered" && approval.expiresAt && Date.parse(approval.expiresAt) <= at.getTime()) actionNeeded.add(`ack-expired:${approval.approvalId}`);
      }
      this.pruneSessions();
      return {
        recovered,
        sessionsExpired,
        sent,
        failed,
        dead,
        rearmed,
        actionNeeded: [...actionNeeded].slice(0, 50),
        outboxPending: this.store.outboxPendingCount(),
        transportAvailable: Boolean(this.transport),
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) session.close("node closed");
    this.sessions.clear();
    this.helloCache.clear();
    this.store.close();
  }

  // --- internals -------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) fail("session_closed", "the P2P node is closed");
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private verdictFor(peer: P2pPeerIdentity): P2pTrustVerdict {
    return trustVerdict(trustRowToLike(this.store.getPeer(peer.nodeId)), peer);
  }

  /**
   * A newly accepted key invalidates the old identity's live sessions and
   * approval generations. The native key is revoked through the port **before**
   * any tombstone is written; a port refusal or failure leaves the approval
   * uncertain and recoverable, never a fake local revoked.
   */
  private async invalidateOldIdentity(nodeId: string, oldPeer: P2pPeerIdentity, nextPeer: P2pPeerIdentity): Promise<{ revoked: string[]; uncertain: string[] }> {
    const result: { revoked: string[]; uncertain: string[] } = { revoked: [], uncertain: [] };
    for (const session of this.sessions.values()) {
      if (session.closedReason) continue;
      if (session.peer.nodeId === nodeId && session.peer.fingerprint === oldPeer.fingerprint) session.close("consumer identity changed");
    }
    for (const approval of this.store.listApprovals(nodeId)) {
      if (approval.consumerFingerprint !== oldPeer.fingerprint) continue;
      if (![...REVOCABLE_STATES].includes(approval.state as (typeof REVOCABLE_STATES)[number])) continue;
      let outcome: P2pRevokeOutcome | null | undefined;
      try {
        outcome = await this.port.revoke({
          consumerNodeId: nodeId,
          approvalId: approval.approvalId,
          keyId: approval.keyId,
          generation: approval.generation,
          reason: "account-closed",
        });
      } catch (e) {
        this.store.transitionApproval(approval.approvalId, [...REVOCABLE_STATES], "uncertain", {
          error: `identity change revoke failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`,
        });
        result.uncertain.push(approval.approvalId);
        continue;
      }
      const confirmation = this.revokeConfirmation(outcome, approval);
      if (!confirmation.ok) {
        this.store.transitionApproval(approval.approvalId, [...REVOCABLE_STATES], "uncertain", { error: `identity change revoke not enforced: ${confirmation.reason}`.slice(0, 300) });
        result.uncertain.push(approval.approvalId);
        continue;
      }
      // Only now is the local state allowed to claim the key is gone.
      this.store.transitionApproval(approval.approvalId, [...REVOCABLE_STATES], "revoked", { error: "consumer identity changed" });
      const confirmedOutcome = outcome as P2pRevokeConfirmed;
      this.store.recordEnforcement(approval.approvalId, {
        enforcedAt: this.clock().toISOString(),
        enforcement: confirmedOutcome.enforcement,
        enforcedKeyId: confirmedOutcome.keyId,
      });
      this.store.setDeliveryState(approval.approvalId, "revoked", this.clock(), "consumer identity changed");
      this.store.putTombstone("authorization", approval.approvalId, "consumer identity changed", this.clock());
      this.store.cancelOutboxForApproval(approval.approvalId, this.clock());
      result.revoked.push(approval.approvalId);
    }
    // Audit only: the old fingerprint is replaced; it does not claim a key was
    // removed (that is the per-approval tombstone above).
    this.store.putTombstone("identity", `${nodeId}:${oldPeer.fingerprint}`, `replaced by ${nextPeer.fingerprint}`, this.clock());
    return result;
  }

  /**
   * A result is accepted only if it is typed, explicitly enforced and bound to
   * this exact approval and key generation. Everything else is uncertain.
   */
  /**
   * Any approval for this consumer node from a different (historic) identity
   * whose native key is not confirmed revoked blocks new approvals/deliveries.
   */
  /**
   * The single durable "the native key was confirmed gone" predicate used by
   * both revoke idempotence and the historic-identity gate. A legacy revoked
   * row with missing/mismatched enforcement evidence is NOT resolved.
   */
  private revokeEnforced(approval: P2pApprovalRow): boolean {
    if (approval.state !== "revoked") return false;
    if (approval.enforcement !== "keyRevoked" && approval.enforcement !== "secretRotated") return false;
    if (!approval.keyId || approval.enforcedKeyId !== approval.keyId) return false;
    if (!approval.enforcedAt) return false;
    const at = Date.parse(approval.enforcedAt);
    if (!Number.isFinite(at)) return false;
    const now = this.clock().getTime();
    if (at - now > 2 * 60_000) return false;
    const created = Date.parse(approval.createdAt);
    if (Number.isFinite(created) && at < created - 2 * 60_000) return false;
    return true;
  }

  private unresolvedLegacyIdentity(nodeId: string, currentFingerprint: string): P2pApprovalRow | null {
    for (const approval of this.store.listApprovals(nodeId)) {
      if (approval.consumerFingerprint === currentFingerprint) continue;
      if (approval.state === "rejected" && !approval.keyId) continue;
      if (approval.state === "expired" && !approval.keyId) continue;
      // Only a revoked row with a valid durable enforcement record is resolved.
      // A legacy revoked row without method/key/time evidence stays unresolved.
      if (this.revokeEnforced(approval)) continue;
      return approval;
    }
    return null;
  }

  private assertNoUnresolvedLegacyIdentity(nodeId: string, currentFingerprint: string, action: string): void {
    const legacy = this.unresolvedLegacyIdentity(nodeId, currentFingerprint);
    if (!legacy) return;
    fail(
      "conflict",
      `previous identity approval ${legacy.approvalId} is ${legacy.state} and not confirmed revoked; reconcile before ${action}`,
    );
  }

  /** Whether this approval still represents a key whose end state is unknown. */
  private approvalNeedsReconcile(approval: P2pApprovalRow): boolean {
    if (approval.state === "approving" || approval.state === "uncertain") return true;
    if (approval.state === "revoked") return !this.revokeEnforced(approval);
    if (approval.state === "rejected" || approval.state === "expired") return Boolean(approval.keyId);
    return false; // an active delivered key is a legitimate other request
  }

  /** Same identity, another request: an unresolved key blocks a new key too. */
  private assertNoOtherUnresolvedApproval(nodeId: string, requestHash: string): void {
    for (const approval of this.store.listApprovals(nodeId)) {
      if (approval.requestHash === requestHash) continue;
      if (this.approvalNeedsReconcile(approval)) {
        fail(
          "conflict",
          `another approval for this consumer (${approval.approvalId}, ${approval.state}) has an unconfirmed key; reconcile or revoke it first`,
        );
      }
    }
  }

  private revokeConfirmation(outcome: P2pRevokeOutcome | null | undefined, approval: P2pApprovalRow): { ok: true } | { ok: false; reason: string } {
    if (!outcome || typeof outcome !== "object") return { ok: false, reason: "the port returned no enforceable result" };
    if (outcome.revoked !== true) {
      const enforcement = (outcome as { enforcement?: unknown }).enforcement;
      return { ok: false, reason: `the port refused (${typeof enforcement === "string" ? enforcement : "unknown"})` };
    }
    if (outcome.enforcement !== "keyRevoked" && outcome.enforcement !== "secretRotated") {
      return { ok: false, reason: "the enforcement mode does not prove the key is unusable" };
    }
    if (outcome.consumerNodeId !== approval.consumerNodeId) return { ok: false, reason: "consumer binding mismatch" };
    if (outcome.approvalId !== approval.approvalId) return { ok: false, reason: "approval binding mismatch" };
    if (!approval.keyId || outcome.keyId !== approval.keyId) return { ok: false, reason: "key binding mismatch" };
    if (outcome.generation !== approval.generation) return { ok: false, reason: "generation binding mismatch" };
    if (outcome.detail !== null && typeof outcome.detail !== "string") return { ok: false, reason: "the detail field is not a string" };
    try {
      assertNoSecretMaterial({ detail: outcome.detail ?? null }, "revoke detail");
    } catch {
      return { ok: false, reason: "the detail field contains credential material" };
    }
    return { ok: true };
  }

  private assertRequestAgainstContext(request: P2pRequestDocument, context: P2pProviderContext): void {
    if (context.sharing !== "enabled") fail("policy", "this node is not sharing");
    if (!context.quote) fail("no_shared_models", "this node publishes no catalogue");
    if (context.quote.contentHash !== request.quote.contentHash) fail("quote_mismatch", "the request quote is not the current catalogue quote");
    if (context.quote.identityFingerprint !== this.identity.peer.fingerprint) fail("stale_identity", "the current catalogue is signed by another key");
    if (context.quote.identityFingerprint !== request.quote.identityFingerprint) fail("quote_mismatch", "the request accepts another provider key");
    const offered = new Set(context.quote.models);
    if (!request.models.every((m) => offered.has(m))) fail("no_shared_models", "the request names a model this node no longer offers");
  }

  private assertApprovedMaterials(approvalId: string, generation: number, peer: P2pPeerView, models: string[], capUsd: number, memo: string | null, request: P2pRequestDocument, materials: P2pApprovedMaterials): void {
    if (materials.approvalId !== approvalId) fail("internal", "the provisioner returned another approval id");
    if (materials.generation !== generation) fail("internal", "the provisioner returned another generation");
    if (materials.consumerNodeId !== peer.nodeId || materials.consumerFingerprint !== peer.fingerprint) fail("internal", "the provisioner returned another consumer");
    if (!sameSet(materials.models, models)) fail("conflict", "the provisioner applied different models than approved");
    if (Math.abs(materials.capUsd - capUsd) > 1e-9) fail("conflict", "the provisioner applied a different cap than approved");
    if (materials.quoteHash !== request.quote.contentHash) fail("quote_mismatch", "the provisioner approved another quote");
    if (typeof materials.priceVersion !== "string" || !/^[a-f0-9]{64}$/.test(materials.priceVersion)) {
      fail("internal", "the provisioner returned no selected-set price version");
    }
    if (materials.memo !== memo) fail("internal", "the provisioner changed the memo");
    if (!materials.keyId || !materials.keyName) fail("internal", "the provisioner returned no key identity");
    const expires = timeMs(materials.expiresAt, "materials.expiresAt");
    const now = this.clock().getTime();
    if (expires <= now) fail("expired", "the approval expiry is already past");
    if (expires > now + P2P_MAX_TTL_MS + 60_000) fail("malformed", "the approval expiry is too far in the future");
  }

  private enqueueApproved(approvalId: string, peer: P2pPeerView, request: P2pRequestDocument, materials: P2pApprovedMaterials): void {
    const body: P2pApprovedBody = {
      requestHash: requestHashOf(request),
      approvalId,
      generation: materials.generation,
      consumerNodeId: peer.nodeId,
      consumerFingerprint: peer.fingerprint,
      models: materials.models,
      capUsd: materials.capUsd,
      quoteHash: materials.quoteHash,
      priceVersion: materials.priceVersion,
      expiresAt: materials.expiresAt,
      keyId: materials.keyId,
      keyName: materials.keyName,
    };
    const idempotency = expectedIdempotency("approved", approvalId);
    this.store.enqueueOutbox({
      messageId: id16(),
      sessionId: null,
      peerNodeId: peer.nodeId,
      peerFingerprint: peer.fingerprint,
      type: "approved",
      idempotency,
      correlation: approvalId,
      payloadJson: canonicalJson({ approvalId }),
      bodyHash: sha256Hex(canonicalJson(body)),
      state: "pending",
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: materials.expiresAt,
      createdAt: this.clock().toISOString(),
    });
  }

  private async prepareDelivery(approvalId: string): Promise<P2pOutboxRow> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) fail("not_found", "no such approval");
    if (!["approved", "delivering", "delivered"].includes(approval.state)) fail("conflict", `the approval is ${approval.state}`);
    if (!this.store.transitionApproval(approvalId, ["approved"], "delivering")) {
      const current = this.store.getApproval(approvalId);
      if (current?.state !== "delivering" && current?.state !== "delivered") fail("conflict", `the approval is ${current?.state ?? "gone"}`);
    }
    this.assertNoUnresolvedLegacyIdentity(approval.consumerNodeId, approval.consumerFingerprint, "delivery");
    const document = await this.takeAuthorization(approval);
    const authorizationHash = authorizationHashOf(document, document.keyHash);
    const receivedKeyHash = keyHashOf(document.key);
    if (receivedKeyHash !== document.keyHash) fail("malformed", "the received authorization key does not match its hash");
    const priorKey = this.store.keyHashSeenElsewhere(approval.consumerNodeId, receivedKeyHash, approvalId);
    if (priorKey.length > 0) {
      this.store.transitionApproval(approvalId, ["delivering"], "uncertain", {
        error: `the Gateway Key was already delivered under approval ${priorKey[0].approvalId} generation ${priorKey[0].generation}`,
      });
      fail("conflict", "this Gateway Key was already delivered under another approval; refusing to reuse an old secret");
    }
    const existing = this.store.getDelivery(approvalId);
    if (existing && (existing.authorizationHash !== authorizationHash || existing.keyId !== document.keyId)) {
      this.store.transitionApproval(approvalId, ["delivering"], "uncertain", { error: "a different authorization was already prepared" });
      fail("conflict", "a different authorization was already prepared for this approval");
    }
    this.store.prepareDelivery({
      approvalId,
      authorizationHash,
      keyId: document.keyId,
      keyName: document.keyName,
      keyHash: receivedKeyHash,
      state: "delivering",
      preparedAt: this.clock().toISOString(),
      deliveredAt: null,
      lastError: null,
    });
    this.store.transitionApproval(approvalId, ["delivering"], "delivering", { authorizationHash, keyId: document.keyId, keyName: document.keyName, expiresAt: approval.expiresAt });
    const idempotency = expectedIdempotency("authorization_delivery", approvalId);
    const bodyHash = sha256Hex(canonicalJson({ approvalId, authorizationHash }));
    return this.store.enqueueOutbox({
      messageId: id16(),
      sessionId: null,
      peerNodeId: approval.consumerNodeId,
      peerFingerprint: approval.consumerFingerprint,
      type: "authorization_delivery",
      idempotency,
      correlation: approvalId,
      payloadJson: canonicalJson({ approvalId, authorizationHash }),
      bodyHash,
      state: "pending",
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: approval.expiresAt,
      createdAt: this.clock().toISOString(),
    }).row;
  }

  private async takeAuthorization(approval: P2pApprovalRow): Promise<P2pAuthorizationDocument> {
    if (!this.identity.binding.mappedCidr || !this.identity.binding.gatewayPort) fail("internal", "the provider has no gateway address/port");
    const document = await this.port.takeAuthorization({
      approvalId: approval.approvalId,
      generation: approval.generation,
      consumerNodeId: approval.consumerNodeId,
      consumerFingerprint: approval.consumerFingerprint,
      requestHash: approval.requestHash,
      models: JSON.parse(approval.modelsJson) as string[],
      capUsd: approval.capUsd,
      quote: { contentHash: approval.quoteHash, priceVersion: approval.priceVersion, identityFingerprint: this.identity.peer.fingerprint },
      keyId: approval.keyId ?? "",
      keyName: approval.keyName ?? "",
    });
    this.assertAuthorizationDocument(document, approval);
    return document;
  }

  private assertAuthorizationDocument(document: P2pAuthorizationDocument, approval: P2pApprovalRow): void {
    if (document.approvalId !== approval.approvalId) fail("conflict", "the authorization belongs to another approval");
    if (document.requestHash !== approval.requestHash) fail("conflict", "the authorization belongs to another request");
    if (document.consumer.nodeId !== approval.consumerNodeId || document.consumer.fingerprint !== approval.consumerFingerprint) {
      fail("stale_identity", "the authorization names another consumer");
    }
    if (document.provider.nodeId !== this.identity.peer.nodeId) fail("target_mismatch", "the authorization names another provider node");
    if (document.quote.identityFingerprint !== this.identity.peer.fingerprint) fail("stale_identity", "the authorization names another provider key");
    if (document.quote.contentHash !== approval.quoteHash) fail("quote_mismatch", "the authorization uses another quote");
    if (document.quote.priceVersion !== approval.priceVersion) fail("quote_mismatch", "the authorization uses another price version");
    if (!sameSet(document.models, JSON.parse(approval.modelsJson) as string[])) fail("conflict", "the authorization models differ from the approval");
    if (Math.abs(document.capUsd - approval.capUsd) > 1e-9) fail("conflict", "the authorization cap differs from the approval");
    if (approval.keyId && document.keyId !== approval.keyId) fail("conflict", "the authorization carries a different key than approved");
    if (approval.keyName && document.keyName !== approval.keyName) fail("conflict", "the authorization carries another key name");
    if (keyHashOf(document.key) !== document.keyHash) fail("malformed", "the authorization key does not match its hash");
  }

  private async enqueueRejection(requestHash: string, reason: P2pRejectionReason, note: string | null): Promise<P2pOutboxRow> {
    const request = this.store.getRequest(requestHash);
    if (!request) fail("not_found", "no such request");
    const body = { requestHash, reason, note: note ? note.slice(0, MAX_MEMO) : null };
    const idempotency = expectedIdempotency("rejected", requestHash);
    const row = this.store.enqueueOutbox({
      messageId: id16(),
      sessionId: null,
      peerNodeId: request.consumerNodeId,
      peerFingerprint: request.consumerFingerprint,
      type: "rejected",
      idempotency,
      correlation: requestCorrelation(requestHash),
      payloadJson: canonicalJson(body),
      bodyHash: sha256Hex(canonicalJson(body)),
      state: "pending",
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: new Date(this.clock().getTime() + this.deliveryTtlMs).toISOString(),
      createdAt: this.clock().toISOString(),
    }).row;
    const session = this.newestSessionFor(request.consumerNodeId, request.consumerFingerprint);
    if (session) await this.sendDueFor(session);
    return row;
  }

  private enqueueStatusReport(input: { approvalId: string | null; requestHash: string | null; approvalState: P2pStatusBody["approvalState"] }): void {
    const key = input.approvalId ?? input.requestHash ?? "unknown";
    // A report goes back to whoever asked: on the provider side that is the
    // consumer; on the consumer side a report is never generated.
    const approval = input.approvalId ? this.store.getApproval(input.approvalId) : null;
    const request = input.requestHash ? this.store.getRequest(input.requestHash) : null;
    const nodeId = approval?.consumerNodeId ?? request?.consumerNodeId;
    const fingerprint = approval?.consumerFingerprint ?? request?.consumerFingerprint;
    if (!nodeId || !fingerprint) return;
    const body: P2pStatusBody = { state: "report", approvalId: input.approvalId, requestHash: input.requestHash, approvalState: input.approvalState };
    this.store.enqueueOutbox({
      messageId: id16(),
      sessionId: null,
      peerNodeId: nodeId,
      peerFingerprint: fingerprint,
      type: "status",
      idempotency: expectedIdempotency("status", key),
      correlation: input.approvalId,
      payloadJson: canonicalJson(body),
      bodyHash: sha256Hex(canonicalJson(body)),
      state: "pending",
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: new Date(this.clock().getTime() + this.deliveryTtlMs).toISOString(),
      createdAt: this.clock().toISOString(),
    });
  }

  private async enqueueAck(input: { approvalId: string; generation: number; requestHash: string; authorizationHash: string; keyId: string; models: string[]; capUsd: number }): Promise<void> {
    const approval = this.store.getApproval(input.approvalId);
    if (!approval) return;
    // The ACK travels consumer -> provider, so it must be addressed to the
    // provider bound to the approval, not to the local consumer identity.
    if (!approval.providerNodeId || !approval.providerFingerprint) fail("internal", "the approval has no provider identity to acknowledge");
    const body: P2pAckBody = {
      approvalId: input.approvalId,
      requestHash: input.requestHash,
      authorizationHash: input.authorizationHash,
      keyId: input.keyId,
      state: "registered",
      readback: { models: input.models, capUsd: input.capUsd },
      detail: null,
    };
    const idempotency = expectedIdempotency("ack", input.authorizationHash);
    this.store.enqueueOutbox({
      messageId: id16(),
      sessionId: null,
      peerNodeId: approval.providerNodeId,
      peerFingerprint: approval.providerFingerprint,
      type: "ack",
      idempotency,
      correlation: input.approvalId,
      payloadJson: canonicalJson(body),
      bodyHash: sha256Hex(canonicalJson(body)),
      state: "pending",
      nextAttemptAt: this.clock().toISOString(),
      expiresAt: new Date(this.clock().getTime() + this.deliveryTtlMs).toISOString(),
      createdAt: this.clock().toISOString(),
    });
  }

  private async rearmUnackedForPoll(peer: P2pPeerIdentity): Promise<void> {
    const now = this.clock();
    for (const approval of this.store.listApprovals(peer.nodeId)) {
      if (!["approved", "delivering", "delivered"].includes(approval.state)) continue;
      if (approval.consumerFingerprint !== peer.fingerprint) continue;
      for (const type of ["approved", "authorization_delivery"] as const) {
        const id = expectedIdempotency(type, approval.approvalId);
        const row = this.store.outboxByIdempotency(type, id);
        if (row?.state === "sent") this.store.rearmOutbox(row.messageId, now.toISOString(), now);
      }
    }
  }

  private async sendDueFor(session: P2pSession): Promise<void> {
    if (!this.transport) return;
    if (this.transport.canPush && !this.transport.canPush(session.peer)) return;
    for (const row of this.dueForSession(session)) {
      if (row.type === "authorization_delivery" && !this.approvedWasSent(row)) continue;
      if (!this.store.markOutboxSending(row.messageId, this.clock())) continue;
      try {
        const frame = await this.materialize(row, session);
        await this.transport.frame({ sessionId: session.sessionId, peer: session.peer }, frame);
        this.store.markOutboxSent(row.messageId, this.clock());
      } catch (e) {
        this.store.markOutboxRetry(row.messageId, this.clock(), e instanceof Error ? e.message : String(e), this.retry);
      }
    }
  }

  private dueForSession(session: P2pSession, limit = 10): P2pOutboxRow[] {
    return this.store
      .dueOutbox(this.clock(), 50)
      .filter((row) => row.peerNodeId === session.peer.nodeId && row.peerFingerprint === session.peer.fingerprint)
      .sort((a, b) => outboxPriority(a.type) - outboxPriority(b.type))
      .slice(0, limit);
  }

  private dueRows(at: Date): P2pOutboxRow[] {
    return this.store.dueOutbox(at, 50).sort((a, b) => outboxPriority(a.type) - outboxPriority(b.type));
  }

  private sessionForRow(row: P2pOutboxRow): P2pSession | null {
    if (row.sessionId) {
      const bound = this.sessions.get(row.sessionId);
      if (bound && !bound.closedReason && Date.parse(bound.expiresAt) > this.clock().getTime()) return bound;
    }
    return this.newestSessionFor(row.peerNodeId, row.peerFingerprint);
  }

  private newestSessionFor(nodeId: string, fingerprint: string): P2pSession | null {
    let best: P2pSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.closedReason) continue;
      if (session.peer.nodeId !== nodeId || session.peer.fingerprint !== fingerprint) continue;
      if (Date.parse(session.expiresAt) <= this.clock().getTime()) continue;
      if (!best || Date.parse(session.expiresAt) > Date.parse(best.expiresAt)) best = session;
    }
    return best;
  }

  private approvedWasSent(row: P2pOutboxRow): boolean {
    if (row.type !== "authorization_delivery") return true;
    const approvalId = String((row.payloadJson ? (JSON.parse(row.payloadJson) as { approvalId?: string }).approvalId : null) ?? row.correlation ?? "");
    if (!approvalId) return false;
    const approved = this.store.outboxByIdempotency("approved", expectedIdempotency("approved", approvalId));
    return approved?.state === "sent" || approved?.state === "dead";
  }

  private async rearmDeliveries(at: Date): Promise<number> {
    let rearmed = 0;
    for (const approval of this.store.listApprovals()) {
      if (!["delivering", "delivered"].includes(approval.state)) continue;
      if (approval.expiresAt && Date.parse(approval.expiresAt) <= at.getTime()) continue;
      const delivery = this.store.getDelivery(approval.approvalId);
      if (!delivery || !["delivering", "delivered"].includes(delivery.state)) continue;
      const outbox = this.store.outboxByIdempotency("authorization_delivery", expectedIdempotency("authorization_delivery", approval.approvalId));
      if (!outbox) continue;
      if (outbox.state !== "sent") continue;
      if (outbox.attempts >= this.retry.maxAttempts) {
        this.store.setDeliveryState(approval.approvalId, "uncertain", at, "ack not received within the retry budget");
        continue;
      }
      const due = new Date(at.getTime() + retryDelayMs(outbox.attempts, this.retry)).toISOString();
      if (this.store.rearmOutbox(outbox.messageId, due, at)) rearmed += 1;
    }
    return rearmed;
  }

  /** Builds the signed envelope for an outbox row. Never reads a key from disk. */
  private async materialize(row: P2pOutboxRow, session: P2pSession): Promise<Buffer> {
    if (row.peerNodeId !== session.peer.nodeId || row.peerFingerprint !== session.peer.fingerprint) {
      fail("target_mismatch", "the outbox row belongs to another peer");
    }
    const envelope = await this.envelopeForRow(row, session);
    this.store.db.query("UPDATE p2p_outbox SET session_id = ? WHERE message_id = ?").run(session.sessionId, row.messageId);
    return session.seal(envelope);
  }

  private async envelopeForRow(row: P2pOutboxRow, session: P2pSession): Promise<P2pEnvelope> {
    const payload = row.payloadJson ? (JSON.parse(row.payloadJson) as Record<string, unknown>) : {};
    const to = { accountId: row.peerFingerprint, nodeId: row.peerNodeId, fingerprint: row.peerFingerprint };
    const expiresAt = new Date(this.clock().getTime() + this.deliveryTtlMs);
    switch (row.type) {
      case "connection_request": {
        const request = payload.request as P2pRequestDocument | undefined;
        if (!request) fail("not_found", "the queued request document is missing");
        return this.signEnvelope({
          type: "connection_request",
          to,
          correlation: null,
          idempotency: row.idempotency,
          body: { requestHash: requestHashOf(request), request },
          expiresAt,
        });
      }
      case "approved": {
        const approval = this.store.getApproval(String(payload.approvalId));
        if (!approval) fail("not_found", "the approval is gone");
        return this.signEnvelope({
          type: "approved",
          to,
          correlation: approval.approvalId,
          idempotency: row.idempotency,
          body: {
            requestHash: approval.requestHash,
            approvalId: approval.approvalId,
            generation: approval.generation,
            consumerNodeId: approval.consumerNodeId,
            consumerFingerprint: approval.consumerFingerprint,
            models: JSON.parse(approval.modelsJson) as string[],
            capUsd: approval.capUsd,
            quoteHash: approval.quoteHash,
            priceVersion: approval.priceVersion,
            expiresAt: approval.expiresAt,
            keyId: approval.keyId!,
            keyName: approval.keyName!,
          },
          expiresAt,
        });
      }
      case "rejected": {
        return this.signEnvelope({
          type: "rejected",
          to,
          correlation: requestCorrelation(String(payload.requestHash)),
          idempotency: row.idempotency,
          body: {
            requestHash: String(payload.requestHash),
            reason: payload.reason as P2pRejectionReason,
            note: (payload.note as string | null) ?? null,
          },
          expiresAt,
        });
      }
      case "authorization_delivery":
        return this.buildDeliveryEnvelope(session, String(payload.approvalId), row.idempotency);
      case "ack": {
        return this.signEnvelope({
          type: "ack",
          to,
          correlation: String(payload.approvalId),
          idempotency: row.idempotency,
          body: {
            approvalId: String(payload.approvalId),
            requestHash: String(payload.requestHash),
            authorizationHash: String(payload.authorizationHash),
            keyId: String(payload.keyId),
            state: payload.state === "delivery-failed" ? "delivery-failed" : "registered",
            readback: (payload.readback as P2pAckBody["readback"]) ?? null,
            detail: (payload.detail as string | null) ?? null,
          },
          expiresAt,
        });
      }
      case "revoked": {
        const approval = this.store.getApproval(String(payload.approvalId));
        if (!approval) fail("not_found", "the revoked approval is gone");
        return this.signEnvelope({
          type: "revoked",
          to,
          correlation: approval.approvalId,
          idempotency: row.idempotency,
          body: {
            approvalId: approval.approvalId,
            consumerNodeId: approval.consumerNodeId,
            consumerFingerprint: approval.consumerFingerprint,
            reason: (payload.reason as P2pRevokeReason) ?? "operator-revoked",
          },
          expiresAt,
        });
      }
      case "quote_changed": {
        return this.signEnvelope({
          type: "quote_changed",
          to,
          correlation: null,
          idempotency: row.idempotency,
          body: { quoteHash: String(payload.quoteHash), priceVersion: String(payload.priceVersion), models: payload.models as string[] },
          expiresAt,
        });
      }
      case "status": {
        return this.signEnvelope({
          type: "status",
          to,
          correlation: (payload.approvalId as string | null) ?? null,
          idempotency: row.idempotency,
          body: {
            state: "report",
            approvalId: (payload.approvalId as string | null) ?? null,
            requestHash: (payload.requestHash as string | null) ?? null,
            approvalState: (payload.approvalState as P2pStatusBody["approvalState"]) ?? "unknown",
          },
          expiresAt,
        });
      }
      default:
        return fail("unsupported_type", "this outbox row has no envelope builder");
    }
  }

  private async buildDeliveryEnvelope(session: P2pSession, approvalId: string, idempotency: string): Promise<P2pEnvelope<P2pAuthorizationDeliveryBody>> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) fail("not_found", "no such approval");
    if (!["delivering", "delivered", "acked"].includes(approval.state)) fail("conflict", `the approval is ${approval.state}; it cannot be delivered`);
    this.assertNoUnresolvedLegacyIdentity(approval.consumerNodeId, approval.consumerFingerprint, "delivery");
    if (this.store.hasTombstone("authorization", approvalId)) fail("conflict", "the authorization was revoked");
    if (Date.parse(approval.expiresAt) <= this.clock().getTime()) {
      this.store.transitionApproval(approvalId, ["approved", "delivering"], "expired", { error: "approval expired before delivery" });
      fail("expired", "the approval expired before delivery");
    }
    const document = await this.takeAuthorization(approval);
    const authorizationHash = authorizationHashOf(document, document.keyHash);
    const delivery = this.store.getDelivery(approvalId);
    if (!delivery) fail("not_found", "the delivery was never prepared");
    if (delivery.authorizationHash !== authorizationHash || delivery.keyId !== document.keyId) {
      this.store.transitionApproval(approvalId, ["delivering"], "uncertain", { error: "the authorization changed between preparation and delivery" });
      this.store.setDeliveryState(approvalId, "superseded", this.clock(), "the approved key changed");
      fail("conflict", "the authorization changed; revoke and approve again");
    }
    const sealed = sealAuthorization(
      session.authorizationKey,
      {
        sessionId: session.sessionId,
        approvalId,
        requestHash: approval.requestHash,
        authorizationHash,
        // The seal is addressed to the consumer, not to the provider's own key.
        recipientFingerprint: session.peer.fingerprint,
      },
      document,
    );
    const body: P2pAuthorizationDeliveryBody = {
      approvalId,
      generation: approval.generation,
      requestHash: approval.requestHash,
      authorizationHash,
      keyId: document.keyId,
      keyName: document.keyName,
      models: document.models,
      capUsd: document.capUsd,
      quoteHash: approval.quoteHash,
      priceVersion: approval.priceVersion,
      expiresAt: approval.expiresAt,
      sealed,
    };
    const target = { accountId: session.peer.fingerprint, nodeId: session.peer.nodeId, fingerprint: session.peer.fingerprint };
    return this.signEnvelope({ type: "authorization_delivery", to: target, correlation: approvalId, idempotency, body, expiresAt: new Date(approval.expiresAt) }) as unknown as P2pEnvelope<P2pAuthorizationDeliveryBody>;
  }

  private signEnvelope(input: {
    type: P2pMessageType;
    to: { accountId: string; nodeId: string; fingerprint: string };
    correlation: string | null;
    idempotency: string;
    body: unknown;
    expiresAt: Date;
  }): P2pEnvelope {
    const now = this.clock();
    if (input.expiresAt.getTime() <= now.getTime()) fail("expired", "the message would already be expired");
    const unsigned = {
      version: 1 as const,
      protocol: P2P_PROTOCOL as typeof P2P_PROTOCOL,
      type: input.type,
      id: id16(),
      from: this.identity.peer,
      to: input.to,
      time: now.toISOString(),
      expires: input.expiresAt.toISOString(),
      correlation: input.correlation,
      idempotency: input.idempotency,
      body: input.body,
    };
    const auth = this.identity.sign(input.type, unsigned as unknown as Record<string, unknown>);
    const envelope: P2pEnvelope = { ...unsigned, auth };
    // Validate our own output: a core bug must not emit something a peer will
    // reject or something that skips a required binding.
    validateEnvelope(envelope, { now, expectedTo: { nodeId: input.to.nodeId, fingerprint: input.to.fingerprint } });
    assertNoSecretMaterial(envelope.body, "outbound body");
    return envelope;
  }

  private finishInbox(row: ReturnType<P2pStore["getInbox"]> & object, code: P2pResultCode, result: Record<string, unknown>): { code: P2pResultCode; result: Record<string, unknown> } {
    const resultJson = canonicalJson(result);
    assertNoSecretMaterial(result, "inbox result");
    this.store.finishInbox(row.messageId, code, resultJson, this.clock());
    return { code, result };
  }
}

// --- helpers -----------------------------------------------------------------

function id16(): string {
  return randomBytes(16).toString("hex");
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function defaultCatalogTrust(provider: { nodeId: string; fingerprint: string }): P2pTrustVerdict {
  return catalogProviderTrust(loadCatalogTrust()[provider.nodeId], provider);
}

function trustRowToLike(row: ReturnType<P2pStore["getPeer"]>): { fingerprint: string; accepted: boolean; pendingFingerprint: string | null; revokedAt: string | null } | null {
  if (!row) return null;
  let pendingFingerprint: string | null = null;
  if (row.pendingJson) {
    try {
      pendingFingerprint = (JSON.parse(row.pendingJson) as { fingerprint?: string }).fingerprint ?? null;
    } catch {
      pendingFingerprint = "malformed";
    }
  }
  return { fingerprint: row.fingerprint, accepted: row.accepted, pendingFingerprint, revokedAt: row.revokedAt };
}

function rowToPeer(row: NonNullable<ReturnType<P2pStore["getPeer"]>>): P2pPeerIdentity {
  return { accountId: row.accountId, nodeId: row.nodeId, hostname: row.hostname, publicKey: row.publicKey, fingerprint: row.fingerprint };
}

/** The changed key a human still has to accept, if any. */
function pendingPeerOf(row: NonNullable<ReturnType<P2pStore["getPeer"]>>): P2pPeerIdentity | null {
  if (!row.pendingJson) return null;
  try {
    const p = JSON.parse(row.pendingJson) as Record<string, unknown>;
    if (typeof p.accountId !== "string" || typeof p.fingerprint !== "string" || typeof p.publicKey !== "string" || typeof p.hostname !== "string") return null;
    if (fingerprintOf(p.publicKey) !== p.fingerprint || p.accountId !== p.fingerprint) return null;
    return { accountId: p.accountId, nodeId: row.nodeId, hostname: p.hostname, publicKey: p.publicKey, fingerprint: p.fingerprint };
  } catch {
    return null;
  }
}

function inboundApprovalOf(body: P2pApprovedBody, provider: P2pPeerIdentity): P2pInboundApproval {
  return {
    approvalId: body.approvalId,
    generation: body.generation,
    requestHash: body.requestHash,
    consumerNodeId: body.consumerNodeId,
    consumerFingerprint: body.consumerFingerprint,
    providerNodeId: provider.nodeId,
    providerFingerprint: provider.fingerprint,
    models: body.models,
    capUsd: body.capUsd,
    quoteHash: body.quoteHash,
    priceVersion: body.priceVersion,
    expiresAt: body.expiresAt,
    keyId: body.keyId,
    keyName: body.keyName,
  };
}

export function expectedIdempotency(type: P2pMessageType, id: string): string {
  const prefixes: Record<P2pMessageType, string> = {
    connection_request: "p2p:request:",
    approved: "p2p:approved:",
    rejected: "p2p:rejected:",
    authorization_delivery: "p2p:delivery:",
    ack: "p2p:ack:",
    revoked: "p2p:revoked:",
    quote_changed: "p2p:quote:",
    payment_request: "p2p:payment:",
    status: "p2p:status:",
    credit_updated: "p2p:credit:",
  };
  return sha256Hex(prefixes[type] + id).slice(0, 32);
}

function expectedIdempotencyFor(envelope: P2pEnvelope): string {
  const body = envelope.body as Record<string, unknown>;
  switch (envelope.type) {
    case "connection_request":
      return expectedIdempotency("connection_request", String(body.requestHash));
    case "approved":
      return expectedIdempotency("approved", String(body.approvalId));
    case "rejected":
      return expectedIdempotency("rejected", String(body.requestHash));
    case "authorization_delivery":
      return expectedIdempotency("authorization_delivery", String(body.approvalId));
    case "ack":
      return expectedIdempotency("ack", String(body.authorizationHash));
    case "revoked":
      return expectedIdempotency("revoked", String(body.approvalId));
    case "quote_changed":
      return expectedIdempotency("quote_changed", String(body.quoteHash));
    case "status":
      return expectedIdempotency("status", String(body.approvalId ?? body.requestHash ?? "unknown"));
    case "payment_request":
      return expectedIdempotency("payment_request", String(body.paymentId));
    case "credit_updated":
      return expectedIdempotency("credit_updated", String(body.creditId));
    default:
      return fail("unsupported_type", "no idempotency rule for this type");
  }
}

function duplicateInbox(row: NonNullable<ReturnType<P2pStore["getInbox"]>>): { code: P2pResultCode; result: Record<string, unknown> } {
  return { code: (row.resultCode as P2pResultCode | null) ?? "duplicate", result: parseResult(row.resultJson) };
}

function parseResult(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeApprovalState(state: string): P2pStatusBody["approvalState"] {
  if (state === "approved" || state === "delivering" || state === "delivered" || state === "revoked" || state === "expired") return state;
  if (state === "acked") return "delivered";
  if (["approving", "awaiting-approval", "awaiting-trust", "received", "pending"].includes(state)) return "pending";
  return "unknown";
}

/** A 32-hex business correlation for a content-addressed request. */
export function requestCorrelation(requestHash: string): string {
  return sha256Hex("p2p:correlation:request:" + requestHash).slice(0, 32);
}

function outboxPriority(type: P2pMessageType): number {
  switch (type) {
    case "approved":
    case "rejected":
    case "connection_request":
    case "ack":
      return 0;
    case "authorization_delivery":
      return 1;
    case "revoked":
      return 2;
    case "status":
    case "quote_changed":
      return 3;
    default:
      return 4;
  }
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof P2pError) || error.code === "internal";
}
