// C-owned P2P payment service: provider terms from the existing local Wallet /
// DepositIntent/EIP-712, consumer signature exchange, durable verified-obligation
// store/resolver and status projection.
//
// No server, no transport, no signing key: the future reviewed B extension
// delivers an authenticated context; this service validates the C frame, uses the
// existing Wallet for provider intent creation/verification, and exposes a
// resolver that the approved local PaymentLocalService can consume. The journal
// remains the only send gate; the Watcher/Ledger remain the only credit authority.

import { randomUUID } from "node:crypto";
import { logger } from "./log.ts";
import type { Wallet } from "./wallet.ts";
import type { DepositIntent } from "./deposits.ts";
import { type PaymentBinding, erc20TransferCalldataHash } from "./payment-operations.ts";
import type { TrustedObligationResolver, TrustedPaymentObligation } from "./payment-local-service.ts";
import { P2pPaymentStore, type StoredMessage, type StoredObligation, type StoredProviderRequest, type StoredSelection } from "./p2p-payment-store.ts";
import {
  P2P_PAYMENT_MESSAGE_TYPE,
  PAYMENT_STATUSES,
  PaymentProtocolError,
  assertPaymentNetwork,
  paymentErrorCode,
  paymentFail,
  paymentFrameDigest,
  selectionMatchesTerms,
  validatePaymentFrame,
  validateSelection,
  validateTerms,
  type PaymentAsset,
  type PaymentFrame,
  type PaymentObservation,
  type PaymentPeer,
  type PaymentRequestFrameBody,
  type PaymentSelection,
  type PaymentSignatureFrameBody,
  type PaymentSigner,
  type PaymentStatus,
  type PaymentStatusFrameBody,
  type PaymentTerms,
  type P2pAuthenticatedPaymentContext,
  type P2pPaymentMessagePort,
  type ProviderPaymentIdentity,
} from "./p2p-payment-protocol.ts";

const FRAME_TTL_MS = 10 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32 = /^0x[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const TEXT = /^[A-Za-z0-9._:@+/=-]{1,200}$/;
const NODE = /^[A-Za-z0-9._:-]{1,128}$/;
const DETAIL = /^[A-Za-z0-9._:-]{1,80}$/;

function cleanPeer(value: unknown, where: string): PaymentPeer {
  if (!value || typeof value !== "object" || Array.isArray(value)) paymentFail("invalid", `${where} is invalid`);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "nodeId" && key !== "fingerprint")) paymentFail("invalid", `${where} has an unexpected field`);
  if (typeof raw.nodeId !== "string" || !NODE.test(raw.nodeId) || typeof raw.fingerprint !== "string" || !HEX64.test(raw.fingerprint)) {
    paymentFail("invalid", `${where} is invalid`);
  }
  return { nodeId: raw.nodeId, fingerprint: raw.fingerprint };
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
function lower(value: string): string { return value.toLowerCase(); }

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Peer status is informational and must not regress after confirming/received. */
function peerStatusAcceptable(current: PaymentStatus | null, next: PaymentStatus): boolean {
  if (current === null || current === next) return true;
  if (current === "received") return false;
  if (current === "confirming" && next === "waitingpayment") return false;
  if (current === "actionneeded" && next === "waitingpayment") return false;
  return true;
}

function makeFrame(input: {
  kind: PaymentFrame["kind"];
  from: PaymentPeer;
  to: PaymentPeer;
  requestId: string;
  invoiceId: string | null;
  body: PaymentFrame["body"];
  nowMs: number;
  maxExpiresMs?: number;
}): PaymentFrame {
  const created = input.nowMs;
  const expires = Math.min(created + FRAME_TTL_MS, input.maxExpiresMs ?? created + FRAME_TTL_MS);
  if (!(expires > created)) paymentFail("expired", "payment frame has already expired");
  return {
    schema: "ohmyaihub/payment/v1",
    kind: input.kind,
    requestId: input.requestId,
    invoiceId: input.invoiceId,
    from: input.from,
    to: input.to,
    createdAt: iso(created),
    expiresAt: iso(expires),
    body: input.body,
  };
}

function bindingFor(terms: PaymentTerms, payerAddress: string): PaymentBinding {
  const payer = lower(payerAddress);
  return {
    invoice: terms.invoiceId,
    consumerAddress: payer,
    providerIdentityFingerprint: terms.provider.fingerprint,
    authorizationGeneration: terms.provider.authorizationGeneration,
    intentHash: terms.digest,
    chainId: terms.chainId,
    assetId: terms.asset.assetId,
    contractAddress: terms.asset.contractAddress,
    decimals: terms.asset.decimals,
    recipientAddress: terms.recipientAddress,
    amountRaw: terms.amountRaw,
    calldataHash: erc20TransferCalldataHash(terms.recipientAddress, terms.amountRaw),
    expiresAtMs: Date.parse(terms.expiresAt),
  };
}

function statusFrame(input: {
  from: PaymentPeer;
  to: PaymentPeer;
  requestId: string;
  invoiceId: string;
  status: PaymentStatus;
  detail: string | null;
  nowMs: number;
  maxExpiresMs?: number;
}): PaymentFrame {
  const detail = input.detail && DETAIL.test(input.detail) ? input.detail : null;
  return makeFrame({
    kind: "status",
    from: input.from,
    to: input.to,
    requestId: input.requestId,
    invoiceId: input.invoiceId,
    body: { invoiceId: input.invoiceId, requestId: input.requestId, status: input.status, detail },
    nowMs: input.nowMs,
    // A status update is informational and may arrive just after the invoice
    // expiry; keep a short positive frame lifetime instead of failing to send.
    maxExpiresMs: Math.max(input.maxExpiresMs ?? 0, input.nowMs + 60_000),
  });
}

export interface ProviderPaymentConfig {
  providerId: string;
  nodeId: string;
  fingerprint: string;
  authorizationGeneration: number;
  quoteHash: string;
  priceVersion: string;
  allowedNetworks: readonly number[];
  allowedAssets: readonly PaymentAsset[];
}

export interface PaymentPeerAuthority {
  /** Local B/Service authorization: current provider identity, quote, generation, allowed network/asset. */
  assertAuthorized(input: {
    peer: PaymentPeer;
    catalogQuoteHash: string | null;
    selection: PaymentSelection;
    terms: PaymentTerms;
  }): void | Promise<void>;
}

export interface ProviderPaymentServiceOptions {
  node: PaymentPeer;
  config: ProviderPaymentConfig;
  wallet: Wallet;
  store: P2pPaymentStore;
  now?: () => number;
  ttlSec?: number;
  /**
   * The provider's current authorization for one consumer (B approval
   * generation and accepted quote). When present it replaces the static
   * config binding, so terms always name the consumer's real approval.
   */
  authorizationFor?: (consumerNodeId: string) => { authorizationGeneration: number; quoteHash: string; priceVersion: string } | null;
}

export interface ConsumerPaymentServiceOptions {
  node: PaymentPeer;
  store: P2pPaymentStore;
  signer: PaymentSigner;
  authority: PaymentPeerAuthority;
  now?: () => number;
}

export interface FrameOutbound {
  to: PaymentPeer;
  frame: PaymentFrame;
  idempotency: string;
}

export interface FrameResult {
  code: string;
  detail?: string | null;
  outbound?: FrameOutbound;
}

function providerConfigValid(config: ProviderPaymentConfig, node: PaymentPeer): void {
  if (config.nodeId !== node.nodeId || config.fingerprint !== node.fingerprint) paymentFail("authority", "provider config does not match the local node");
  if (!TEXT.test(config.providerId) || !config.quoteHash || !config.priceVersion) paymentFail("authority", "provider identity/quote is incomplete");
  if (!Number.isSafeInteger(config.authorizationGeneration) || config.authorizationGeneration < 1) paymentFail("authority", "provider authorization generation is invalid");
  for (const chain of config.allowedNetworks) assertPaymentNetwork(chain);
  for (const asset of config.allowedAssets) {
    if (!/^eip155:\d+:0x[0-9a-f]{40}$/.test(asset.assetId) || !/^0x[0-9a-f]{40}$/.test(asset.contractAddress) || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
      paymentFail("authority", "provider allowed asset is invalid");
    }
  }
}

export class ProviderPaymentService {
  private readonly now: () => number;
  private readonly ttlSec: number;
  constructor(private readonly options: ProviderPaymentServiceOptions) {
    providerConfigValid(options.config, options.node);
    this.now = options.now ?? Date.now;
    this.ttlSec = options.ttlSec ?? 3600;
  }

  get node(): PaymentPeer { return this.options.node; }
  get config(): ProviderPaymentConfig { return this.options.config; }

  private allowedAsset(selection: PaymentSelection): void {
    if (!this.options.config.allowedNetworks.includes(selection.chainId)) paymentFail("authority", "provider does not allow this payment network");
    if (!this.options.config.allowedAssets.some((asset) => sameJson(asset, selection.asset))) {
      paymentFail("authority", "provider does not allow this asset tuple");
    }
  }

  async createTerms(input: {
    selection: PaymentSelection;
    consumer: PaymentPeer;
    requestId: string;
    idempotency: string;
  }): Promise<{ request: StoredProviderRequest; frame: PaymentFrame }> {
    const selection = validateSelection(input.selection);
    if (selection.consumerId !== input.consumer.nodeId) paymentFail("peer-mismatch", "selection consumer is not the authenticated peer");
    if (selection.providerNodeId !== this.node.nodeId || selection.providerFingerprint !== this.node.fingerprint) {
      paymentFail("selection-mismatch", "selection provider is not this node");
    }
    this.allowedAsset(selection);
    const registryAsset = this.options.wallet.registryView().asset(selection.asset.assetId);
    if (
      !registryAsset || !registryAsset.enabled || registryAsset.chainId !== selection.chainId ||
      lower(registryAsset.contractAddress) !== selection.asset.contractAddress ||
      registryAsset.decimals !== selection.asset.decimals
    ) {
      paymentFail("authority", "provider wallet registry does not match the selected asset tuple");
    }
    if (!UUID.test(input.requestId)) paymentFail("invalid", "requestId must be a UUID");
    const existing = this.options.store.providerRequest(input.requestId);
    if (existing) {
      if (existing.consumerFingerprint !== input.consumer.fingerprint) paymentFail("peer-mismatch", "requestId belongs to a different consumer identity");
      if (!sameJson(existing.selection, selection) || existing.invoiceId === "") {
        paymentFail("conflict", "requestId already belongs to a different payment request");
      }
      return { request: existing, frame: this.frameForRequest(existing, input.consumer) };
    }

    // Never mint a second open invoice for the same consumer/network/asset/
    // amount. A lost terms reply or a client restart can resend with a fresh
    // request id; the existing invoice is the only payable object, and the
    // consumer adopts it after checking that every term matches its selection.
    const open = this.options.store.openProviderRequest({
      consumerNodeId: selection.consumerId,
      chainId: selection.chainId,
      assetId: selection.asset.assetId,
      amountRaw: selection.amountRaw,
      nowMs: this.now(),
    });
    if (open) {
      if (open.consumerFingerprint !== input.consumer.fingerprint) paymentFail("peer-mismatch", "the open invoice belongs to a different consumer identity");
      if (!sameJson(open.selection, selection)) paymentFail("conflict", "an open invoice already exists for a different selection");
      return { request: open, frame: this.frameForRequest(open, input.consumer) };
    }

    // The provider may have crashed after writing the ChainStore intent but
    // before persisting the P2P request. Reuse that still-unsigned intent
    // instead of creating a second invoice for the same payment.
    let signable = this.options.wallet
      .openIntents(selection.consumerId)
      .filter((intent) =>
        intent.providerId === this.options.config.providerId &&
        intent.chainId === selection.chainId &&
        intent.assetId === selection.asset.assetId &&
        intent.expectedAmountRaw === selection.amountRaw &&
        lower(intent.tokenContract) === selection.asset.contractAddress,
      )
      .map((intent) => this.options.wallet.signableIntent(intent.invoiceId))
      .find((value) => value !== null) ?? null;
    if (signable === null) {
      try {
        signable = this.options.wallet.requestIntent({
          providerId: this.options.config.providerId,
          consumerId: selection.consumerId,
          chainId: selection.chainId,
          assetId: selection.asset.assetId,
          amountRaw: selection.amountRaw,
          ttlSec: this.ttlSec,
        });
      } catch {
        paymentFail("authority", "provider cannot create a local payment request", "provider-unavailable");
      }
    }
    const intent = signable.intent;
    if (
      intent.providerId !== this.options.config.providerId ||
      intent.consumerId !== selection.consumerId ||
      intent.chainId !== selection.chainId ||
      intent.assetId !== selection.asset.assetId ||
      lower(intent.tokenContract) !== selection.asset.contractAddress ||
      intent.expectedAmountRaw !== selection.amountRaw
    ) paymentFail("terms-mismatch", "wallet intent does not match the consumer selection");
    const authorization = this.options.authorizationFor
      ? this.options.authorizationFor(selection.consumerId)
      : {
          authorizationGeneration: this.options.config.authorizationGeneration,
          quoteHash: this.options.config.quoteHash,
          priceVersion: this.options.config.priceVersion,
        };
    if (!authorization) paymentFail("authority", "no current authorization for this consumer", "provider-authority");
    if (!TEXT.test(authorization.quoteHash) || !TEXT.test(authorization.priceVersion) || !Number.isSafeInteger(authorization.authorizationGeneration) || authorization.authorizationGeneration < 1) {
      paymentFail("authority", "the consumer authorization is incomplete", "provider-authority");
    }
    const terms: PaymentTerms = validateTerms({
      requestId: input.requestId,
      invoiceId: intent.invoiceId,
      provider: {
        providerId: this.options.config.providerId,
        nodeId: this.node.nodeId,
        fingerprint: this.node.fingerprint,
        authorizationGeneration: authorization.authorizationGeneration,
        quoteHash: authorization.quoteHash,
        priceVersion: authorization.priceVersion,
      },
      consumerId: selection.consumerId,
      chainId: selection.chainId,
      asset: selection.asset,
      recipientAddress: intent.recipientAddress,
      amountRaw: selection.amountRaw,
      intent,
      typedData: signable.typedData,
      digest: signable.digest,
      createdAt: iso(this.now()),
      expiresAt: intent.expiresAt,
    });
    const nowMs = this.now();
    const sameInvoice = this.options.store.providerRequestByInvoice(terms.invoiceId);
    if (sameInvoice) {
      // The intent was already persisted under this invoice. Never create a
      // second P2P row/invoice; hand back the one that exists.
      if (sameInvoice.consumerFingerprint !== input.consumer.fingerprint) paymentFail("peer-mismatch", "the invoice belongs to a different consumer identity");
      if (!sameJson(sameInvoice.selection, selection)) paymentFail("conflict", "the invoice already exists for a different selection");
      return { request: sameInvoice, frame: this.frameForRequest(sameInvoice, input.consumer) };
    }
    const request = this.options.store.saveProviderRequest({
      requestId: terms.requestId,
      invoiceId: terms.invoiceId,
      consumerFingerprint: input.consumer.fingerprint,
      selection,
      terms,
      digest: terms.digest,
      status: "waitingpayment",
      signature: null,
      payerAddress: null,
      peerStatus: null,
      error: null,
      idempotency: input.idempotency,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: Date.parse(terms.expiresAt),
    });
    const frame = makeFrame({
      kind: "terms", from: this.node, to: input.consumer, requestId: request.requestId,
      invoiceId: request.invoiceId, body: { terms: request.terms }, nowMs,
      maxExpiresMs: request.expiresAtMs,
    });
    return { request, frame };
  }

  /** Terms while the invoice is still unpaid; current status once it is not. */
  private frameForRequest(request: StoredProviderRequest, to: PaymentPeer): PaymentFrame {
    const nowMs = this.now();
    if (request.status === "waitingpayment") {
      return makeFrame({
        kind: "terms", from: this.node, to, requestId: request.requestId,
        invoiceId: request.invoiceId, body: { terms: request.terms }, nowMs, maxExpiresMs: request.expiresAtMs,
      });
    }
    return statusFrame({
      from: this.node, to, requestId: request.requestId, invoiceId: request.invoiceId,
      status: request.status, detail: request.error, nowMs, maxExpiresMs: request.expiresAtMs,
    });
  }

  private requestFor(requestId: string, invoiceId: string | null): StoredProviderRequest | null {
    return this.options.store.providerRequest(requestId) ?? (invoiceId ? this.options.store.providerRequestByInvoice(invoiceId) : null);
  }

  hasRequest(invoiceId: string): boolean {
    return this.options.store.providerRequestByInvoice(invoiceId) !== null;
  }

  async handleFrame(ctx: P2pAuthenticatedPaymentContext, frame: PaymentFrame): Promise<FrameResult> {
    if (frame.kind === "request") {
      const selection = (frame.body as PaymentRequestFrameBody).selection;
      const created = await this.createTerms({ selection, consumer: ctx.from, requestId: frame.requestId, idempotency: ctx.idempotency });
      return { code: "terms", outbound: { to: ctx.from, frame: created.frame, idempotency: `terms:${created.request.requestId}` } };
    }
    if (frame.kind === "signature") {
      const body = frame.body as PaymentSignatureFrameBody;
      const request = this.requestFor(frame.requestId, body.invoiceId);
      if (!request) paymentFail("not-found", "no local provider payment request for this signature");
      if (request.requestId !== frame.requestId || request.invoiceId !== body.invoiceId) {
        paymentFail("terms-mismatch", "signature request id and invoice do not belong to the same provider request");
      }
      if (request.selection.consumerId !== ctx.from.nodeId || request.consumerFingerprint !== ctx.from.fingerprint) {
        paymentFail("peer-mismatch", "signature sender is not the request consumer");
      }
      if (request.signature !== null && (request.signature !== body.signature || request.payerAddress !== body.payerAddress)) {
        paymentFail("conflict", "a different signature is already recorded");
      }
      if (request.signature === null) {
        let accepted: { intent: DepositIntent; payer: string };
        try {
          accepted = this.options.wallet.signIntent({
            invoiceId: body.invoiceId,
            signature: body.signature,
            payerAddress: body.payerAddress,
          });
        } catch {
          // Only a wallet refusal becomes actionneeded; a store failure below is
          // not a signature verdict and must stay retryable.
          this.options.store.updateProviderRequest({
            requestId: request.requestId, status: "actionneeded", error: "signature", nowMs: this.now(),
          });
          const failed = this.options.store.providerRequest(request.requestId)!;
          return {
            code: "actionneeded",
            detail: "signature",
            outbound: { to: ctx.from, frame: statusFrame({ from: this.node, to: ctx.from, requestId: failed.requestId, invoiceId: failed.invoiceId, status: "actionneeded", detail: "signature", nowMs: this.now(), maxExpiresMs: failed.expiresAtMs }), idempotency: `status:${failed.requestId}:actionneeded` },
          };
        }
        if (lower(accepted.payer) !== body.payerAddress) paymentFail("signature", "wallet recovered a different payer");
        this.options.store.updateProviderRequest({
          requestId: request.requestId, signature: body.signature, payerAddress: body.payerAddress,
          status: "waitingpayment", error: null, nowMs: this.now(),
        });
      }
      const current = this.options.store.providerRequest(request.requestId)!;
      return {
        code: current.status,
        outbound: {
          to: ctx.from,
          frame: statusFrame({ from: this.node, to: ctx.from, requestId: current.requestId, invoiceId: current.invoiceId, status: current.status, detail: current.status === "actionneeded" ? "signature" : null, nowMs: this.now(), maxExpiresMs: current.expiresAtMs }),
          idempotency: `status:${current.requestId}:${current.status}`,
        },
      };
    }
    if (frame.kind === "status") {
      const body = frame.body as PaymentStatusFrameBody;
      const request = this.requestFor(frame.requestId, body.invoiceId);
      if (!request) paymentFail("not-found", "no local provider payment request for this status");
      if (request.requestId !== frame.requestId || request.invoiceId !== body.invoiceId) {
        paymentFail("terms-mismatch", "status request id and invoice do not belong to the same provider request");
      }
      if (request.selection.consumerId !== ctx.from.nodeId || request.consumerFingerprint !== ctx.from.fingerprint) {
        paymentFail("peer-mismatch", "status sender is not the request consumer");
      }
      if (!peerStatusAcceptable(request.peerStatus, body.status)) return { code: "peer-status" };
      this.options.store.updateProviderRequest({ requestId: request.requestId, peerStatus: body.status, nowMs: this.now() });
      return { code: "peer-status" };
    }
    paymentFail("role", "provider cannot handle this payment frame");
  }

  async observe(observation: PaymentObservation): Promise<FrameResult & { outbound?: FrameOutbound }> {
    const request = this.options.store.providerRequest(observation.requestId) ?? this.options.store.providerRequestByInvoice(observation.invoiceId);
    if (!request) paymentFail("not-found", "no local provider payment request for this observation");
    if (observation.status !== "confirming" && observation.status !== "received" && observation.status !== "actionneeded") {
      paymentFail("invalid", "observation status is invalid");
    }
    const updated = this.options.store.updateProviderRequest({
      requestId: request.requestId,
      status: observation.status,
      error: observation.status === "actionneeded" ? (observation.detail && DETAIL.test(observation.detail) ? observation.detail : "observation") : null,
      nowMs: this.now(),
    });
    const detail = observation.detail && DETAIL.test(observation.detail) ? observation.detail : null;
    const outbound = {
      to: { nodeId: updated.selection.consumerId, fingerprint: updated.consumerFingerprint },
      frame: statusFrame({
        from: this.node, to: { nodeId: updated.selection.consumerId, fingerprint: updated.consumerFingerprint },
        requestId: updated.requestId, invoiceId: updated.invoiceId, status: updated.status, detail, nowMs: this.now(), maxExpiresMs: updated.expiresAtMs,
      }),
      idempotency: `status:${updated.requestId}:${updated.status}`,
    };
    return { code: updated.status, outbound };
  }

  status(invoiceId: string): StoredProviderRequest | null {
    return this.options.store.providerRequestByInvoice(invoiceId);
  }

  /** Open/active provider requests for the console (bounded). */
  activeRequests(): StoredProviderRequest[] {
    return this.options.store.activeProviderRequests();
  }
}

export class ConsumerPaymentService {
  private readonly now: () => number;
  constructor(private readonly options: ConsumerPaymentServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  get node(): PaymentPeer { return this.options.node; }

  async requestPayment(input: {
    selection: PaymentSelection;
    requestId?: string;
    idempotency?: string;
  }): Promise<{ requestId: string; selection: StoredSelection; frame: PaymentFrame }> {
    const selection = validateSelection(input.selection);
    if (selection.consumerId !== this.node.nodeId) paymentFail("peer-mismatch", "selection consumer is not this node");
    if (selection.providerNodeId === this.node.nodeId) paymentFail("selection-mismatch", "provider cannot be the local consumer");
    const idempotency = input.idempotency ?? `request:${input.requestId ?? randomUUID()}`;
    const byIdempotency = this.options.store.selectionByIdempotency(idempotency);
    if (byIdempotency) {
      if (!sameJson(byIdempotency.selection, selection)) paymentFail("conflict", "idempotency key belongs to a different selection");
      const frame = makeFrame({
        kind: "request", from: this.node, to: { nodeId: selection.providerNodeId, fingerprint: selection.providerFingerprint },
        requestId: byIdempotency.requestId, invoiceId: null, body: { selection }, nowMs: this.now(),
      });
      return { requestId: byIdempotency.requestId, selection: byIdempotency, frame };
    }
    const requestId = input.requestId ?? randomUUID();
    if (!UUID.test(requestId)) paymentFail("invalid", "requestId must be a UUID");
    const existing = this.options.store.selection(requestId);
    if (existing) {
      if (!sameJson(existing.selection, selection) || (existing.idempotency && existing.idempotency !== idempotency)) {
        paymentFail("conflict", "requestId already belongs to a different selection");
      }
      const frame = makeFrame({
        kind: "request", from: this.node, to: { nodeId: selection.providerNodeId, fingerprint: selection.providerFingerprint },
        requestId, invoiceId: null, body: { selection }, nowMs: this.now(),
      });
      return { requestId, selection: existing, frame };
    }
    const nowMs = this.now();
    const stored = this.options.store.saveSelection({
      requestId, selection, status: "actionneeded", idempotency, createdAtMs: nowMs, updatedAtMs: nowMs,
    });
    const frame = makeFrame({
      kind: "request", from: this.node, to: { nodeId: selection.providerNodeId, fingerprint: selection.providerFingerprint },
      requestId, invoiceId: null, body: { selection }, nowMs,
    });
    return { requestId, selection: stored, frame };
  }

  async handleFrame(ctx: P2pAuthenticatedPaymentContext, frame: PaymentFrame): Promise<FrameResult> {
    if (frame.kind === "terms") {
      const terms = (frame.body as { terms: PaymentTerms }).terms;
      if (ctx.from.nodeId !== terms.provider.nodeId || ctx.from.fingerprint !== terms.provider.fingerprint) {
        paymentFail("peer-mismatch", "terms sender is not the provider");
      }
      if (ctx.catalogQuoteHash && lower(ctx.catalogQuoteHash) !== lower(terms.provider.quoteHash)) {
        paymentFail("authority", "terms quote does not match the authenticated provider context");
      }
      // The provider may answer with an already-open invoice after a lost
      // terms reply. Adopt it only when every term matches a local selection
      // that has no obligation yet; otherwise this is not our request.
      const selection = this.options.store.selection(terms.requestId) ?? this.options.store.pendingSelectionFor({
        consumerId: terms.consumerId,
        providerNodeId: terms.provider.nodeId,
        providerFingerprint: terms.provider.fingerprint,
        chainId: terms.chainId,
        asset: terms.asset,
        amountRaw: terms.amountRaw,
      });
      if (!selection) paymentFail("not-found", "no local consumer selection for these terms");
      try { selectionMatchesTerms(selection.selection, terms); } catch (error) { if (error instanceof PaymentProtocolError) throw error; paymentFail("selection-mismatch", "terms do not match the local selection"); }
      if (Date.parse(terms.expiresAt) <= this.now()) paymentFail("expired", "payment terms expired");
      try {
        await this.options.authority.assertAuthorized({ peer: ctx.from, catalogQuoteHash: ctx.catalogQuoteHash, selection: selection.selection, terms });
      } catch { paymentFail("authority", "provider is not currently authorized", "provider-authority"); }
      const existing = this.options.store.obligation(terms.requestId) ?? this.options.store.obligationByInvoice(terms.invoiceId);
      if (existing) {
        if (!sameJson(existing.terms, terms)) paymentFail("conflict", "requestId already belongs to different terms");
        return { code: "terms-accepted" };
      }
      const nowMs = this.now();
      this.options.store.saveObligation({
        requestId: terms.requestId,
        invoiceId: terms.invoiceId,
        provider: {
          nodeId: terms.provider.nodeId,
          fingerprint: terms.provider.fingerprint,
          authorizationGeneration: terms.provider.authorizationGeneration,
          quoteHash: terms.provider.quoteHash,
          priceVersion: terms.provider.priceVersion,
        },
        consumerId: terms.consumerId,
        binding: null,
        terms,
        digest: terms.digest,
        signature: null,
        payerAddress: null,
        status: "actionneeded",
        peerStatus: null,
        statusSource: "local",
        error: null,
        idempotency: ctx.idempotency,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        expiresAtMs: Date.parse(terms.expiresAt),
      });
      return { code: "terms-accepted" };
    }
    if (frame.kind === "status") {
      const body = frame.body as PaymentStatusFrameBody;
      const obligation = this.options.store.obligation(frame.requestId) ?? this.options.store.obligationByInvoice(body.invoiceId);
      if (!obligation) paymentFail("not-found", "no local consumer obligation for this status");
      if (obligation.requestId !== frame.requestId || obligation.invoiceId !== body.invoiceId) {
        paymentFail("terms-mismatch", "status request id and invoice do not belong to the same obligation");
      }
      if (ctx.from.nodeId !== obligation.provider.nodeId || ctx.from.fingerprint !== obligation.provider.fingerprint) {
        paymentFail("peer-mismatch", "status sender is not the obligation provider");
      }
      if (!peerStatusAcceptable(obligation.peerStatus, body.status)) return { code: "peer-status" };
      this.options.store.updateObligation({
        requestId: obligation.requestId, peerStatus: body.status, statusSource: "peer", nowMs: this.now(),
      });
      return { code: "peer-status" };
    }
    paymentFail("role", "consumer cannot handle this payment frame");
  }

  async sign(requestId: string, signer: PaymentSigner = this.options.signer): Promise<{ status: PaymentStatus; frame: PaymentFrame }> {
    if (!UUID.test(requestId)) paymentFail("invalid", "requestId must be a UUID");
    const obligation = this.options.store.obligation(requestId);
    if (!obligation) paymentFail("not-found", "no local consumer obligation");
    if (obligation.signature) {
      if (obligation.status !== "waitingpayment") paymentFail("conflict", "obligation already has a signature");
      const frame = makeFrame({
        kind: "signature", from: this.node, to: { nodeId: obligation.provider.nodeId, fingerprint: obligation.provider.fingerprint },
        requestId, invoiceId: obligation.invoiceId,
        body: { invoiceId: obligation.invoiceId, requestId, signature: obligation.signature, payerAddress: obligation.payerAddress! },
        nowMs: this.now(), maxExpiresMs: obligation.expiresAtMs,
      });
      return { status: "waitingpayment", frame };
    }
    if (obligation.status !== "actionneeded") paymentFail("role", "obligation is not waiting for a signature");
    if (obligation.peerStatus === "confirming" || obligation.peerStatus === "received" || obligation.peerStatus === "actionneeded") {
      paymentFail("conflict", "the provider already reported this payment as confirming/received/action-needed");
    }
    if (obligation.expiresAtMs <= this.now()) paymentFail("expired", "payment terms expired");
    let signed: { signature: string; payerAddress: string };
    try {
      signed = await signer.sign({ intent: obligation.terms.intent, typedData: obligation.terms.typedData, digest: obligation.digest });
    } catch {
      this.options.store.updateObligation({ requestId, status: "actionneeded", error: "signer", nowMs: this.now() });
      paymentFail("signature", "local wallet did not sign", "signer");
    }
    if (!SIGNATURE.test(signed.signature) || !/^0x[0-9a-fA-F]{40}$/.test(signed.payerAddress) || lower(signed.payerAddress) === `0x${"0".repeat(40)}`) {
      paymentFail("signature", "local wallet returned an invalid signature/payer");
    }
    const binding = bindingFor(obligation.terms, signed.payerAddress);
    this.options.store.updateObligation({
      requestId, signature: signed.signature, payerAddress: lower(signed.payerAddress), binding,
      status: "waitingpayment", error: null, nowMs: this.now(),
    });
    const frame = makeFrame({
      kind: "signature", from: this.node, to: { nodeId: obligation.provider.nodeId, fingerprint: obligation.provider.fingerprint },
      requestId, invoiceId: obligation.invoiceId,
      body: { invoiceId: obligation.invoiceId, requestId, signature: signed.signature, payerAddress: lower(signed.payerAddress) },
      nowMs: this.now(), maxExpiresMs: obligation.expiresAtMs,
    });
    return { status: "waitingpayment", frame };
  }

  obligation(invoiceId: string): StoredObligation | null {
    return this.options.store.obligationByInvoice(invoiceId);
  }

  obligationByRequest(requestId: string): StoredObligation | null {
    return this.options.store.obligation(requestId);
  }

  selection(requestId: string): StoredSelection | null {
    return this.options.store.selection(requestId);
  }

  /** Unsigned obligations for the console, newest first (bounded). */
  pendingObligations(): StoredObligation[] {
    return this.options.store.pendingObligations();
  }

  status(invoiceId: string): { status: PaymentStatus; localStatus: PaymentStatus; peerStatus: PaymentStatus | null; source: "local" | "peer" } | null {
    const row = this.options.store.obligationByInvoice(invoiceId);
    if (!row) return null;
    return { status: row.peerStatus ?? row.status, localStatus: row.status, peerStatus: row.peerStatus, source: row.peerStatus ? "peer" : "local" };
  }

  /** Resolver for the approved PaymentLocalService; only a signed, unpaid obligation is payable. */
  obligationResolver(): TrustedObligationResolver {
    return {
      resolve: (obligationId: string): TrustedPaymentObligation | null => {
        const row = this.options.store.obligationByInvoice(obligationId);
        if (!row || !row.binding) return null;
        if (row.status !== "waitingpayment") return null;
        // Do not let the consumer send before the provider has verified the
        // signature. The provider sends waitingpayment only after verification;
        // confirming/received/actionneeded are not a send permit.
        if (row.peerStatus !== "waitingpayment") return null;
        if (row.expiresAtMs <= this.now()) return null;
        return {
          obligationId: row.invoiceId,
          binding: row.binding,
          source: "p2p-authenticated-request",
          verifiedAt: iso(row.updatedAtMs),
        };
      },
    };
  }
}

export interface P2pPaymentCoordinatorOptions {
  node: PaymentPeer;
  store: P2pPaymentStore;
  port: P2pPaymentMessagePort;
  provider?: ProviderPaymentService;
  consumer?: ConsumerPaymentService;
  now?: () => number;
  retry?: { attempts?: number; delayMs?: number };
  sleep?: (ms: number) => Promise<void>;
}

export class P2pPaymentCoordinator {
  private readonly now: () => number;
  private readonly attempts: number;
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private started = false;

  constructor(private readonly options: P2pPaymentCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.attempts = Math.max(1, Math.min(5, options.retry?.attempts ?? 3));
    this.delayMs = Math.max(0, options.retry?.delayMs ?? 100);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.port.onPaymentMessage((ctx) => this.handle(ctx));
  }

  private peer(value: unknown, where: string): PaymentPeer { return cleanPeer(value, where); }

  private async sendFrame(to: PaymentPeer, frame: PaymentFrame, idempotency: string): Promise<{ code: string; detail?: string | null }> {
    let last: { code: string; detail?: string | null } = { code: "transport", detail: null };
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try {
        const result = await this.options.port.sendPaymentMessage(to, {
          idempotency,
          correlation: frame.requestId,
          body: frame,
          expiresAt: frame.expiresAt,
        });
        if (result && typeof result.code === "string") {
          if (result.code !== "transport") return result;
          last = result;
        }
      } catch {
        last = { code: "transport", detail: null };
      }
      if (attempt + 1 < this.attempts) await this.sleep(this.delayMs * 2 ** attempt);
    }
    return last;
  }

  async handle(raw: unknown): Promise<{ code: string; detail?: string | null }> {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) paymentFail("invalid", "authenticated context is invalid");
      const ctx = raw as P2pAuthenticatedPaymentContext;
      if (ctx.type !== P2P_PAYMENT_MESSAGE_TYPE) paymentFail("unsupported", "not a payment message");
      const from = this.peer(ctx.from, "from");
      const to = this.peer(ctx.to, "to");
      if (to.nodeId !== this.options.node.nodeId || to.fingerprint !== this.options.node.fingerprint) {
        paymentFail("peer-mismatch", "payment message is not addressed to this node");
      }
      // The B envelope id is 32 lowercase hex, not a UUID. The synthetic port in
      // the first C unit used a UUID; accept both real wire ids and the test id,
      // but nothing else.
      const messageIdOk = typeof ctx.messageId === "string" && (UUID.test(ctx.messageId) || /^[0-9a-f]{32}$/.test(ctx.messageId));
      if (!messageIdOk || typeof ctx.idempotency !== "string" || !ctx.idempotency || ctx.idempotency.length > 200) {
        paymentFail("invalid", "payment envelope id/idempotency is invalid");
      }
      if (typeof ctx.sessionId !== "string" || !ctx.sessionId || ctx.sessionId.length > 256) paymentFail("invalid", "payment session is invalid");
      if (ctx.correlation !== null && (typeof ctx.correlation !== "string" || ctx.correlation.length > 200)) paymentFail("invalid", "payment correlation is invalid");
      if (typeof ctx.receivedAt !== "string" || !Number.isFinite(Date.parse(ctx.receivedAt))) paymentFail("invalid", "payment receivedAt is invalid");
      const frame = validatePaymentFrame(ctx.body, { ...ctx, from, to }, this.now());
      if (ctx.correlation !== null && ctx.correlation !== frame.requestId) {
        paymentFail("invalid", "payment correlation does not match the frame request id");
      }
      const payloadHash = paymentFrameDigest(frame);
      const seen = this.options.store.message(from.nodeId, ctx.idempotency);
      if (seen) {
        if (seen.payloadHash !== payloadHash || seen.requestId !== frame.requestId || seen.kind !== frame.kind) {
          paymentFail("idempotency", "idempotency key was reused for a different payment message");
        }
        return { code: seen.code, detail: seen.detail };
      }
      let result: FrameResult;
      if (frame.kind === "request") {
        if (!this.options.provider) paymentFail("role", "this node is not a payment provider");
        result = await this.options.provider.handleFrame(ctx, frame);
      } else if (frame.kind === "terms") {
        if (!this.options.consumer) paymentFail("role", "this node is not a payment consumer");
        result = await this.options.consumer.handleFrame(ctx, frame);
      } else if (frame.kind === "signature") {
        if (!this.options.provider) paymentFail("role", "this node is not a payment provider");
        result = await this.options.provider.handleFrame(ctx, frame);
      } else {
        const invoiceId = frame.invoiceId!;
        const obligation = this.options.consumer?.obligation(invoiceId) ?? null;
        if (obligation && from.nodeId === obligation.provider.nodeId && from.fingerprint === obligation.provider.fingerprint) {
          result = await this.options.consumer!.handleFrame(ctx, frame);
        } else if (this.options.provider?.hasRequest(invoiceId)) {
          result = await this.options.provider.handleFrame(ctx, frame);
        } else {
          paymentFail("not-found", "no local payment record for this status");
        }
      }
      let code = result.code;
      let detail = result.detail ?? null;
      if (result.outbound) {
        const sent = await this.sendFrame(result.outbound.to, result.outbound.frame, result.outbound.idempotency);
        if (sent.code !== "queued" && sent.code !== "sent" && sent.code !== "delivered" && sent.code !== "accepted") {
          code = sent.code;
          detail = sent.detail ?? null;
        }
      }
      this.options.store.recordMessage({
        peerNodeId: from.nodeId, idempotency: ctx.idempotency, requestId: frame.requestId, kind: frame.kind,
        payloadHash, code, detail, atMs: this.now(),
      });
      return { code, detail };
    } catch (error) {
      if (error instanceof PaymentProtocolError) logger.warn(`payment frame rejected (${error.code}): ${error.message}`);
      else logger.warn(`payment frame failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
      return { code: paymentErrorCode(error), detail: error instanceof PaymentProtocolError ? error.detail : null };
    }
  }

  async requestPayment(input: { selection: PaymentSelection; requestId?: string; idempotency?: string }): Promise<{ requestId: string; status: PaymentStatus; code: string; detail?: string | null }> {
    if (!this.options.consumer) paymentFail("role", "this node is not a payment consumer");
    const created = await this.options.consumer.requestPayment(input);
    const sent = await this.sendFrame(created.frame.to, created.frame, input.idempotency ?? created.selection.idempotency ?? `request:${created.requestId}`);
    return { requestId: created.requestId, status: created.selection.status, code: sent.code, detail: sent.detail ?? null };
  }

  async sign(requestId: string, signer?: PaymentSigner): Promise<{ status: PaymentStatus; code: string; detail?: string | null }> {
    if (!this.options.consumer) paymentFail("role", "this node is not a payment consumer");
    const signed = await this.options.consumer.sign(requestId, signer);
    const sent = await this.sendFrame(signed.frame.to, signed.frame, `signature:${requestId}`);
    return { status: signed.status, code: sent.code, detail: sent.detail ?? null };
  }

  async observe(observation: PaymentObservation): Promise<{ status: PaymentStatus; code: string; detail?: string | null }> {
    if (!this.options.provider) paymentFail("role", "this node is not a payment provider");
    const observed = await this.options.provider.observe(observation);
    if (!observed.outbound) return { status: observed.code as PaymentStatus, code: observed.code, detail: observed.detail ?? null };
    const sent = await this.sendFrame(observed.outbound.to, observed.outbound.frame, observed.outbound.idempotency);
    return { status: observed.code as PaymentStatus, code: sent.code, detail: sent.detail ?? null };
  }

  /**
   * Resend the durable request/signature for one payment after a lost reply or
   * a restart. It never creates a second selection, invoice or signature: the
   * request id is reused and a stored signature is resent, not re-signed.
   */
  async resume(input: { requestId?: string; invoiceId?: string }): Promise<{ status: PaymentStatus; code: string; detail?: string | null }> {
    if (!this.options.consumer) paymentFail("role", "this node is not a payment consumer");
    const obligation = input.requestId
      ? this.options.store.obligation(input.requestId)
      : input.invoiceId ? this.options.store.obligationByInvoice(input.invoiceId) : null;
    if (!input.requestId && !input.invoiceId) paymentFail("invalid", "resume needs a request id or an invoice id");
    if (obligation?.signature) {
      const frame = await this.options.consumer.sign(obligation.requestId);
      const sent = await this.sendFrame(frame.frame.to, frame.frame, `signature:${obligation.requestId}`);
      return { status: frame.status, code: sent.code, detail: sent.detail ?? null };
    }
    const selection = input.requestId
      ? this.options.store.selection(input.requestId)
      : obligation
        ? this.options.store.selection(obligation.requestId) ?? this.options.store.pendingSelectionFor({
            consumerId: obligation.terms.consumerId,
            providerNodeId: obligation.terms.provider.nodeId,
            providerFingerprint: obligation.terms.provider.fingerprint,
            chainId: obligation.terms.chainId,
            asset: obligation.terms.asset,
            amountRaw: obligation.terms.amountRaw,
          })
        : null;
    if (!selection) paymentFail("not-found", "no local selection can be resumed for this payment");
    const resent = await this.options.consumer.requestPayment({
      selection: selection.selection,
      requestId: selection.requestId,
      idempotency: selection.idempotency ?? undefined,
    });
    const sent = await this.sendFrame(resent.frame.to, resent.frame, selection.idempotency ?? `request:${selection.requestId}`);
    return { status: resent.selection.status, code: sent.code, detail: sent.detail ?? null };
  }

  status(invoiceId: string): { local: StoredProviderRequest | null; consumer: { status: PaymentStatus; localStatus: PaymentStatus; peerStatus: PaymentStatus | null; source: "local" | "peer" } | null } {
    return {
      local: this.options.provider?.status(invoiceId) ?? null,
      consumer: this.options.consumer?.status(invoiceId) ?? null,
    };
  }
}
