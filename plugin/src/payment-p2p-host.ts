// C-owned P2P payment host: wires the reviewed C services to the B
// payment_message hook, the built-in wallet and the local chain store.
//
// Boundaries:
//  - B only transports an opaque frame; C owns terms/signature/status.
//  - the journal is the only send gate; the Watcher/ChainStore is the only
//    observation source and the Ledger/Provisioner the only credit authority.
//  - no automatic signature, no stored private key and no mainnet send/credit.
//    The auto-recharge surface is a reminder + one-click confirm only; the full
//    unattended executor is deliberately not implemented in this phase.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Service } from "./service.ts";
import type { ControlApp } from "./control/app.ts";
import { catalogQuoteUsability } from "./service.ts";
import { controlAuthorizationForConsumer, controlRemotes } from "./control/p2p-port.ts";
import { statePath } from "./paths.ts";
import { writeJsonAtomic } from "./store.ts";
import { logger } from "./log.ts";
import { Wallet, type ReceivingAddress } from "./wallet.ts";
import { P2pPaymentStore, type StoredObligation, type StoredProviderRequest } from "./p2p-payment-store.ts";
import {
  ConsumerPaymentService,
  P2pPaymentCoordinator,
  ProviderPaymentService,
  type PaymentPeerAuthority,
} from "./p2p-payment.ts";
import type { PaymentAsset, PaymentPeer, PaymentSelection, P2pAuthenticatedPaymentContext, P2pPaymentMessagePort, PaymentSigner } from "./p2p-payment-protocol.ts";
import { PAYMENT_PRODUCT_CHAIN_IDS, PAYMENT_SIMULATION_CHAIN_IDS, paymentFail } from "./p2p-payment-protocol.ts";
import { setPaymentObligationResolver, type TrustedObligationResolver } from "./payment-local-service.ts";
import { WalletPaymentSender, WalletSendError, type WalletSendPreview } from "./wallet-payment-send.ts";
import { walletLocalService } from "./wallet-local-service.ts";
import type { ConsoleActionContext } from "./console-server.ts";
import { isMainnetChainId } from "./mainnet-gate.ts";

export const PAYMENT_P2P_ACTIONS = [
  "payment-p2p-state",
  "payment-p2p-request",
  "payment-p2p-sign",
  "payment-p2p-resume",
  "payment-local-send-preview",
  "payment-local-send",
  "payment-auto-policy-get",
  "payment-auto-policy-set",
] as const;
export type PaymentP2pAction = (typeof PAYMENT_P2P_ACTIONS)[number];

const SIMULATION_CHAINS = new Set<number>(PAYMENT_SIMULATION_CHAIN_IDS);
const PRODUCT_CHAINS = new Set<number>(PAYMENT_PRODUCT_CHAIN_IDS);
const NODE = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export class PaymentP2pError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PaymentP2pError";
  }
}

function reject(message: string, code = "invalid"): never {
  throw new PaymentP2pError(code, message);
}

function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) reject(`${label} is invalid`);
  return value.trim();
}

function onlyFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) reject(`unexpected parameter ${key}`);
}

// --- auto-recharge policy (reminder only) -----------------------------------

export interface PaymentAutoPolicy {
  version: 1;
  enabled: boolean;
  /** Full unattended signing is not implemented; this must stay "manual-confirm". */
  mode: "reminder" | "manual-confirm";
  executor: "none";
  fullAuto: false;
  providerNodeId: string | null;
  providerFingerprint: string | null;
  chainId: number | null;
  assetId: string | null;
  triggerUsd: number;
  perPaymentMaxUsd: number;
  dailyMaxUsd: number;
  gasMaxWei: string;
  authorizationTtlSec: number;
  updatedAt: string | null;
}

const DEFAULT_AUTO_POLICY: PaymentAutoPolicy = Object.freeze({
  version: 1 as const,
  enabled: false,
  mode: "manual-confirm" as const,
  executor: "none" as const,
  fullAuto: false as const,
  providerNodeId: null,
  providerFingerprint: null,
  chainId: null,
  assetId: null,
  triggerUsd: 1,
  perPaymentMaxUsd: 5,
  dailyMaxUsd: 20,
  gasMaxWei: "2000000000000000",
  authorizationTtlSec: 600,
  updatedAt: null,
});

function validateAutoPolicy(raw: unknown): PaymentAutoPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) reject("the auto policy must be an object");
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled === true;
  const chainId = o.chainId === null ? null : Number(o.chainId);
  if (chainId !== null && (!Number.isSafeInteger(chainId) || !SIMULATION_CHAINS.has(chainId))) {
    reject("automatic recharge can only name a simulation chain (97/84532)");
  }
  if (chainId !== null && (PRODUCT_CHAINS.has(chainId) || isMainnetChainId(chainId))) reject("mainnet automatic recharge is closed", "mainnet-blocked");
  const providerNodeId = o.providerNodeId === null ? null : text(o.providerNodeId, "providerNodeId", 128);
  if (providerNodeId !== null && !NODE.test(providerNodeId)) reject("providerNodeId is invalid");
  const providerFingerprint = o.providerFingerprint === null ? null : text(o.providerFingerprint, "providerFingerprint", 64);
  if (providerFingerprint !== null && !FINGERPRINT.test(providerFingerprint)) reject("providerFingerprint is invalid");
  const assetId = o.assetId === null ? null : text(o.assetId, "assetId", 160);
  if (enabled && (!providerNodeId || !providerFingerprint || chainId === null || !assetId)) {
    reject("an enabled policy needs the provider, chain and asset");
  }
  const number = (value: unknown, label: string, min: number, max: number) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) reject(`${label} is invalid`);
    if (Math.abs(Math.round(value * 1e4) / 1e4 - value) > 1e-9) reject(`${label} must be on the $0.0001 grid`);
    return value;
  };
  const gasMaxWei = typeof o.gasMaxWei === "string" && /^[1-9][0-9]{0,77}$/.test(o.gasMaxWei) ? o.gasMaxWei : reject("gasMaxWei is invalid");
  const ttl = typeof o.authorizationTtlSec === "number" && Number.isInteger(o.authorizationTtlSec) && o.authorizationTtlSec >= 60 && o.authorizationTtlSec <= 3600
    ? o.authorizationTtlSec
    : reject("authorizationTtlSec must be 60..3600");
  return Object.freeze({
    version: 1 as const,
    enabled,
    mode: "manual-confirm" as const,
    executor: "none" as const,
    fullAuto: false as const,
    providerNodeId,
    providerFingerprint,
    chainId,
    assetId,
    triggerUsd: number(o.triggerUsd, "triggerUsd", 0.0001, 1_000_000),
    perPaymentMaxUsd: number(o.perPaymentMaxUsd, "perPaymentMaxUsd", 0.0001, 1_000_000),
    dailyMaxUsd: number(o.dailyMaxUsd, "dailyMaxUsd", 0.0001, 1_000_000),
    gasMaxWei,
    authorizationTtlSec: ttl,
    updatedAt: new Date().toISOString(),
  });
}

function loadAutoPolicy(path: string): PaymentAutoPolicy {
  if (!existsSync(path)) return { ...DEFAULT_AUTO_POLICY };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return validateAutoPolicy(raw);
  } catch (error) {
    logger.warn(`the automatic-recharge policy is unreadable; it stays disabled: ${String((error as Error)?.message ?? error)}`);
    return { ...DEFAULT_AUTO_POLICY };
  }
}

// --- node port ---------------------------------------------------------------

function createNodePaymentPort(app: ControlApp): P2pPaymentMessagePort & { stop(): void } {
  let handler: ((ctx: P2pAuthenticatedPaymentContext) => Promise<{ code: string; detail?: string | null }>) | null = null;
  const hook = {
    quoteHashFor: () => app.service.catalogStatus().quote?.contentHash ?? null,
    async onPaymentMessage(ctx: unknown) {
      if (!handler) return { code: "role", detail: "no-payment-handler" };
      return handler(ctx as P2pAuthenticatedPaymentContext);
    },
  };
  app.node.setPaymentHook(hook);
  return {
    onPaymentMessage(next) { handler = next; },
    async sendPaymentMessage(to, input) {
      return app.node.sendPaymentMessage(to, input);
    },
    stop() { /* the node owns the hook lifetime */ },
  };
}

// --- host --------------------------------------------------------------------

export interface PaymentP2pState {
  schema: "ohmyaihub.payment-p2p-state/v1";
  at: string;
  available: boolean;
  reason: string | null;
  nodeId: string | null;
  fingerprint: string | null;
  provider: {
    enabled: boolean;
    networks: number[];
    assets: Array<{ chainId: number; assetId: string; contractAddress: string; decimals: number; symbol: string }>;
    receiving: Array<{ chainId: number; address: string }>;
    requests: Array<Record<string, unknown>>;
  };
  consumer: {
    remotes: Array<{ providerNodeId: string; providerFingerprint: string; approvalId: string; generation: number; capUsd: number }>;
    obligations: Array<Record<string, unknown>>;
    pending: Array<Record<string, unknown>>;
  };
  auto: PaymentAutoPolicy;
  reminder: { active: boolean; reason: string | null; providerNodeId: string | null; costLeftUsd: number | null } | null;
  readOnly: true;
}

export class PaymentP2pHost {
  readonly store: P2pPaymentStore;
  readonly provider: ProviderPaymentService;
  readonly consumer: ConsumerPaymentService;
  readonly coordinator: P2pPaymentCoordinator;
  readonly sender: WalletPaymentSender;
  readonly node: PaymentPeer;
  private readonly port: ReturnType<typeof createNodePaymentPort>;
  private readonly wallet: Wallet;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly autoPath: string;

  private constructor(
    private readonly service: Service,
    private readonly app: ControlApp,
    node: PaymentPeer,
    wallet: Wallet,
    store: P2pPaymentStore,
    provider: ProviderPaymentService,
    consumer: ConsumerPaymentService,
    coordinator: P2pPaymentCoordinator,
    sender: WalletPaymentSender,
    port: ReturnType<typeof createNodePaymentPort>,
  ) {
    this.node = node;
    this.wallet = wallet;
    this.store = store;
    this.provider = provider;
    this.consumer = consumer;
    this.coordinator = coordinator;
    this.sender = sender;
    this.port = port;
    this.autoPath = statePath("payment-auto-policy.json");
  }

  static async start(service: Service, app: ControlApp): Promise<PaymentP2pHost> {
    const cfg = service.config();
    if (!cfg?.nodeId) throw new PaymentP2pError("not-configured", "configure this node first");
    const fingerprint = app.identity.summary.fingerprint;
    const node: PaymentPeer = { nodeId: cfg.nodeId, fingerprint: fingerprint.toLowerCase() };
    const wallet = service.requireWallet();
    const registry = wallet.registryView();
    const networks: number[] = [...PAYMENT_SIMULATION_CHAIN_IDS];
    const assets: PaymentAsset[] = registry
      .enabledAssets()
      .filter((a) => networks.includes(a.chainId) && a.enabled && a.credit && a.pricing.kind === "fixed-test-rate" && a.testnetOnly)
      .map((a) => ({ assetId: a.assetId, contractAddress: a.contractAddress.toLowerCase(), decimals: a.decimals }));
    const allowedNetworks = networks.filter((chain) => assets.some((a) => a.assetId.startsWith(`eip155:${chain}:`)));
    const store = new P2pPaymentStore(statePath("p2p-payment.sqlite"));
    const port = createNodePaymentPort(app);
    const provider = new ProviderPaymentService({
      node,
      config: {
        providerId: node.nodeId,
        nodeId: node.nodeId,
        fingerprint: node.fingerprint,
        authorizationGeneration: 1,
        quoteHash: app.service.catalogStatus().quote?.contentHash ?? "0".repeat(64),
        priceVersion: app.service.catalogStatus().quote?.billing?.priceVersion ?? "none",
        allowedNetworks,
        allowedAssets: assets,
      },
      wallet,
      store,
      authorizationFor: (consumerNodeId) => {
        const auth = controlAuthorizationForConsumer(consumerNodeId);
        if (!auth) return null;
        return {
          authorizationGeneration: auth.generation,
          quoteHash: auth.quoteHash,
          priceVersion: auth.priceVersion,
        };
      },
    });
    const authority = new HostAuthority(service);
    const consumer = new ConsumerPaymentService({
      node,
      store,
      authority,
      signer: { async sign() { paymentFail("signature", "this host signs only through the console action"); } },
    });
    const coordinator = new P2pPaymentCoordinator({ node, store, port, provider, consumer });
    const sender = new WalletPaymentSender(service, consumer, wallet);
    const host = new PaymentP2pHost(service, app, node, wallet, store, provider, consumer, coordinator, sender, port);
    setPaymentObligationResolver(service, consumer.obligationResolver() as TrustedObligationResolver);
    coordinator.start();
    host.startObservationTick();
    return host;
  }

  private startObservationTick(): void {
    const tick = () => {
      if (this.stopped) return;
      try {
        this.observeChain();
      } catch (error) {
        logger.warn(`payment observation tick failed: ${String((error as Error)?.message ?? error)}`);
      }
    };
    this.ticker = setInterval(tick, 5_000);
    (this.ticker as { unref?: () => void }).unref?.();
  }

  /**
   * The only "received" source: the ChainStore rows the real Watcher writes.
   * A remote message can never make this state; a peer status cannot credit.
   */
  private observeChain(): void {
    for (const request of this.provider.activeRequests()) {
      let next: "confirming" | "received" | "actionneeded" | null = null;
      const events = this.wallet.chainStore().eventsForChain(request.selection.chainId, 200).filter((e) => e.invoiceId === request.invoiceId);
      const event = events[0];
      if (event) {
        if (event.status === "credited") next = "received";
        else if (event.status === "reverted") next = "actionneeded";
        else next = "confirming";
      } else {
        const intent = this.wallet.chainStore().intent(request.invoiceId);
        if (intent && ["expired", "void", "cancelled"].includes(intent.status)) next = "actionneeded";
      }
      if (!next || next === request.status) continue;
      void this.coordinator.observe({
        requestId: request.requestId,
        invoiceId: request.invoiceId,
        status: next,
        detail: next === "received" ? "chain-credited" : next === "actionneeded" ? "chain-reverted" : null,
        observedAt: new Date().toISOString(),
      }).catch((error) => logger.warn(`cannot report payment ${request.invoiceId}: ${String((error as Error)?.message ?? error)}`));
    }
  }

  private peerFor(providerNodeId: string): { peer: PaymentPeer; quoteHash: string; priceVersion: string } {
    const peers = this.service.catalogStatus().peers;
    const view = peers.find((p) => p.nodeId === providerNodeId);
    if (!view) reject("the provider is not a discovered peer; refresh the directory", "not-found");
    const usability = catalogQuoteUsability(view);
    if (!usability.usable) reject(`the provider ${usability.detail ?? "has no usable offer"}`, "not-available");
    const fingerprint = view.identity?.fingerprint;
    if (!fingerprint || !FINGERPRINT.test(fingerprint)) reject("the provider has no accepted identity fingerprint", "not-available");
    const quoteHash = view.quoteHash;
    const priceVersion = view.quote?.billing?.priceVersion ?? null;
    if (!quoteHash || !priceVersion) reject("the provider quote is incomplete", "not-available");
    return { peer: { nodeId: view.nodeId as string, fingerprint: fingerprint as string }, quoteHash: quoteHash as string, priceVersion: priceVersion as string };
  }

  private remoteFor(peer: PaymentPeer) {
    const remote = controlRemotes().remotes.find((r) => r.providerNodeId === peer.nodeId && r.providerFingerprint === peer.fingerprint);
    if (!remote) reject("this consumer has no approved connection to that provider; complete the zero-file approval first", "no-authorization");
    return remote;
  }

  private assetFor(chainId: number, assetId: string): PaymentAsset {
    if (!SIMULATION_CHAINS.has(chainId) || isMainnetChainId(chainId) || PRODUCT_CHAINS.has(chainId)) {
      reject("payments are limited to the 97/84532 simulation chains", "network-gated");
    }
    const asset = this.wallet.registryView().asset(assetId);
    if (!asset || asset.chainId !== chainId || !asset.enabled || !asset.credit || asset.pricing.kind !== "fixed-test-rate") {
      reject("the selected asset is not a registered creditable test asset", "asset-not-found");
    }
    return { assetId: asset.assetId, contractAddress: asset.contractAddress.toLowerCase(), decimals: asset.decimals };
  }

  async state(): Promise<PaymentP2pState> {
    const cfg = this.service.config();
    const assets = this.wallet.registryView().enabledAssets()
      .filter((a) => SIMULATION_CHAINS.has(a.chainId) && a.enabled && a.credit && a.pricing.kind === "fixed-test-rate" && a.testnetOnly)
      .map((a) => ({ chainId: a.chainId, assetId: a.assetId, contractAddress: a.contractAddress, decimals: a.decimals, symbol: a.symbol }));
    const receiving = this.wallet.receivingAddresses()
      .filter((r: ReceivingAddress) => SIMULATION_CHAINS.has(r.chainId))
      .map((r) => ({ chainId: r.chainId, address: r.address }));
    const remotes = controlRemotes().remotes.map((r) => ({
      providerNodeId: r.providerNodeId, providerFingerprint: r.providerFingerprint,
      approvalId: r.approvalId, generation: r.generation, capUsd: r.capUsd,
    }));
    const obligations = this.consumer.pendingObligations().map((o) => publicObligation(o));
    const pending: Array<Record<string, unknown>> = [];
    for (const remote of controlRemotes().remotes) {
      for (const selection of this.consumer.pendingObligations().filter((o) => o.provider.nodeId === remote.providerNodeId)) {
        // obligations are already included above; keep this list for future
        // selection-only rows without an obligation.
        void selection;
      }
    }
    const auto = loadAutoPolicy(this.autoPath);
    return {
      schema: "ohmyaihub.payment-p2p-state/v1",
      at: new Date().toISOString(),
      available: true,
      reason: null,
      nodeId: cfg?.nodeId ?? null,
      fingerprint: this.node.fingerprint,
      provider: {
        enabled: assets.length > 0 && receiving.length > 0,
        networks: [...new Set(assets.map((a) => a.chainId))].sort((a, b) => a - b),
        assets,
        receiving,
        requests: this.provider.activeRequests().map((r) => publicProviderRequest(r)),
      },
      consumer: { remotes, obligations, pending },
      auto,
      reminder: this.reminder(auto),
      readOnly: true,
    };
  }

  private reminder(auto: PaymentAutoPolicy): PaymentP2pState["reminder"] {
    if (!auto.enabled || !auto.providerNodeId) return null;
    const provider = this.service.consoleSnapshot().providers.find((p) => p.id === auto.providerNodeId || p.remoteMagpieId === auto.providerNodeId) as
      | { limit?: { costLeft?: number | null } | null }
      | undefined;
    const left = provider?.limit && typeof provider.limit.costLeft === "number" ? provider.limit.costLeft : null;
    if (left === null) return { active: false, reason: "the provider limit could not be read", providerNodeId: auto.providerNodeId, costLeftUsd: null };
    return {
      active: left < auto.triggerUsd,
      reason: left < auto.triggerUsd ? `remaining provider credit $${left.toFixed(4)} is below the $${auto.triggerUsd.toFixed(4)} trigger` : null,
      providerNodeId: auto.providerNodeId,
      costLeftUsd: left,
    };
  }

  async request(input: Record<string, unknown>) {
    onlyFields(input, ["providerNodeId", "chainId", "assetId", "amountRaw"]);
    const providerNodeId = text(input.providerNodeId, "providerNodeId", 128);
    const chainId = Number(input.chainId);
    if (!Number.isSafeInteger(chainId)) reject("chainId is invalid");
    const assetId = text(input.assetId, "assetId", 160);
    const amountRaw = typeof input.amountRaw === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(input.amountRaw) && input.amountRaw !== "0"
      ? input.amountRaw
      : reject("amountRaw must be a positive integer string");
    const { peer } = this.peerFor(providerNodeId);
    this.remoteFor(peer);
    const asset = this.assetFor(chainId, assetId);
    const selection: PaymentSelection = {
      consumerId: this.node.nodeId, providerNodeId: peer.nodeId, providerFingerprint: peer.fingerprint,
      chainId, asset, amountRaw,
    };
    const result = await this.coordinator.requestPayment({ selection, idempotency: `request:${randomUUID()}` });
    return Object.freeze({ ...result, invoiceId: this.store.obligation(result.requestId)?.invoiceId ?? null });
  }

  async sign(input: Record<string, unknown>, context: ConsoleActionContext) {
    onlyFields(input, ["invoiceId"]);
    const invoiceId = text(input.invoiceId, "invoiceId", 128);
    const obligation = this.store.obligationByInvoice(invoiceId);
    if (!obligation) reject("no local payment for that invoice", "not-found");
    if (obligation.signature) {
      const sent = await this.coordinator.resume({ invoiceId });
      return Object.freeze({ status: sent.status, code: sent.code, detail: sent.detail ?? null });
    }
    const service = this.service;
    const signer: PaymentSigner = {
      async sign({ typedData, digest }) {
        const signed = await walletLocalService(service).signDepositIntent({ typedData, digest }, context);
        return { signature: signed.signature, payerAddress: signed.address };
      },
    };
    const result = await this.coordinator.sign(obligation.requestId, signer);
    return Object.freeze(result);
  }

  async resume(input: Record<string, unknown>) {
    onlyFields(input, ["invoiceId"]);
    const invoiceId = text(input.invoiceId, "invoiceId", 128);
    return Object.freeze(await this.coordinator.resume({ invoiceId }));
  }

  async sendPreview(input: Record<string, unknown>, context: ConsoleActionContext): Promise<WalletSendPreview> {
    onlyFields(input, ["invoiceId"]);
    return this.sender.preview({ invoiceId: input.invoiceId, context });
  }

  async send(input: Record<string, unknown>, context: ConsoleActionContext) {
    onlyFields(input, ["invoiceId", "previewRef", "confirm"]);
    return this.sender.send({ invoiceId: input.invoiceId, previewRef: input.previewRef, confirm: input.confirm, context });
  }

  autoPolicy(): PaymentAutoPolicy {
    return loadAutoPolicy(this.autoPath);
  }

  setAutoPolicy(input: Record<string, unknown>): PaymentAutoPolicy {
    onlyFields(input, ["enabled", "providerNodeId", "providerFingerprint", "chainId", "assetId", "triggerUsd", "perPaymentMaxUsd", "dailyMaxUsd", "gasMaxWei", "authorizationTtlSec"]);
    const policy = validateAutoPolicy({ ...input, version: 1 });
    writeJsonAtomic(this.autoPath, policy);
    return policy;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.port.stop();
    this.store.close();
  }
}

class HostAuthority implements PaymentPeerAuthority {
  constructor(private readonly service: Service) {}

  assertAuthorized(input: {
    peer: PaymentPeer;
    catalogQuoteHash: string | null;
    selection: PaymentSelection;
    terms: import("./p2p-payment-protocol.ts").PaymentTerms;
  }): void {
    const peers = this.service.catalogStatus().peers;
    const view = peers.find((p) => p.nodeId === input.peer.nodeId);
    if (!view) reject("the provider is not a discovered peer", "authority");
    if (view.identity?.fingerprint !== input.peer.fingerprint) reject("the provider identity changed", "authority");
    const usability = catalogQuoteUsability(view);
    if (!usability.usable) reject(`the provider offer is not usable: ${usability.detail ?? "unknown"}`, "authority");
    if (view.quoteHash !== input.terms.provider.quoteHash) reject("the payment terms use an older quote", "authority");
    if (view.quote?.billing?.priceVersion !== input.terms.provider.priceVersion) reject("the payment terms use an older price", "authority");
    if (input.catalogQuoteHash && input.catalogQuoteHash.toLowerCase() !== input.terms.provider.quoteHash.toLowerCase()) {
      reject("the authenticated provider quote does not match the terms", "authority");
    }
    const remote = controlRemotes().remotes.find(
      (r) => r.providerNodeId === input.peer.nodeId && r.providerFingerprint === input.peer.fingerprint,
    );
    if (!remote) reject("this consumer has no approved connection to that provider", "authority");
    if (remote.generation !== input.terms.provider.authorizationGeneration) reject("the provider authorization generation changed", "authority");
    if (remote.capUsd <= 0) reject("the provider approval has no positive cap", "authority");
  }
}

function publicProviderRequest(r: StoredProviderRequest): Record<string, unknown> {
  return Object.freeze({
    requestId: r.requestId,
    invoiceId: r.invoiceId,
    consumerNodeId: r.selection.consumerId,
    consumerFingerprint: r.consumerFingerprint,
    chainId: r.selection.chainId,
    assetId: r.selection.asset.assetId,
    contractAddress: r.selection.asset.contractAddress,
    decimals: r.selection.asset.decimals,
    amountRaw: r.selection.amountRaw,
    recipientAddress: r.terms.recipientAddress,
    status: r.status,
    peerStatus: r.peerStatus,
    signaturePresent: r.signature !== null,
    payerAddress: r.payerAddress,
    expiresAt: r.terms.expiresAt,
    error: r.error,
  });
}

function publicObligation(o: StoredObligation): Record<string, unknown> {
  return Object.freeze({
    requestId: o.requestId,
    invoiceId: o.invoiceId,
    providerNodeId: o.provider.nodeId,
    providerFingerprint: o.provider.fingerprint,
    authorizationGeneration: o.provider.authorizationGeneration,
    quoteHash: o.provider.quoteHash,
    priceVersion: o.provider.priceVersion,
    chainId: o.terms.chainId,
    assetId: o.terms.asset.assetId,
    contractAddress: o.terms.asset.contractAddress,
    decimals: o.terms.asset.decimals,
    amountRaw: o.terms.amountRaw,
    recipientAddress: o.terms.recipientAddress,
    status: o.status,
    peerStatus: o.peerStatus,
    signed: o.signature !== null,
    payerAddress: o.payerAddress,
    expiresAt: o.terms.expiresAt,
    error: o.error,
  });
}

const hosts = new WeakMap<Service, PaymentP2pHost>();

export async function startPaymentP2p(service: Service, app: ControlApp): Promise<PaymentP2pHost> {
  const existing = hosts.get(service);
  if (existing) return existing;
  const host = await PaymentP2pHost.start(service, app);
  hosts.set(service, host);
  return host;
}

export function paymentP2pFor(service: Service): PaymentP2pHost | null {
  return hosts.get(service) ?? null;
}

export async function stopPaymentP2p(service: Service): Promise<void> {
  const host = hosts.get(service);
  if (!host) return;
  hosts.delete(service);
  setPaymentObligationResolver(service, null);
  await host.stop();
}

/** Console dispatch; the caller has already authenticated the session. */
export async function paymentP2pAction(
  service: Service,
  name: string,
  input: Record<string, unknown>,
  context?: ConsoleActionContext,
): Promise<unknown> {
  const host = hosts.get(service);
  if (!host) reject("the local P2P payment service is not running", "not-running");
  try {
    switch (name) {
      case "payment-p2p-state":
        onlyFields(input, []);
        return await host.state();
      case "payment-p2p-request":
        return await host.request(input);
      case "payment-p2p-sign":
        if (!context) reject("an authenticated console session is required", "session");
        return await host.sign(input, context);
      case "payment-p2p-resume":
        return await host.resume(input);
      case "payment-local-send-preview":
        if (!context) reject("an authenticated console session is required", "session");
        return await host.sendPreview(input, context);
      case "payment-local-send":
        if (!context) reject("an authenticated console session is required", "session");
        return await host.send(input, context);
      case "payment-auto-policy-get":
        onlyFields(input, []);
        return host.autoPolicy();
      case "payment-auto-policy-set":
        return host.setAutoPolicy(input);
      default:
        return reject("unsupported payment action");
    }
  } catch (error) {
    if (error instanceof PaymentP2pError) throw error;
    if (error instanceof WalletSendError) throw new PaymentP2pError(error.code, error.message);
    const message = String((error as Error)?.message ?? error);
    throw new PaymentP2pError("operation-failed", message.slice(0, 300));
  }
}
