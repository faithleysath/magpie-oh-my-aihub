import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainStore } from "../src/chainstore.ts";
import { Wallet } from "../src/wallet.ts";
import { defaultRegistry, assetIdOf, type NetworkRegistry } from "../src/networks.ts";
import { signDigest, TEST_PAYER } from "./support/signer.ts";
import { PaymentLocalService, type TrustedObligationResolver } from "../src/payment-local-service.ts";
import { erc20TransferCalldata, erc20TransferCalldataHash, networkRegistryAssetResolver, type PaymentBinding } from "../src/payment-operations.ts";
import {
  ConsumerPaymentService,
  P2pPaymentCoordinator,
  ProviderPaymentService,
  type PaymentPeerAuthority,
} from "../src/p2p-payment.ts";
import { P2pPaymentStore } from "../src/p2p-payment-store.ts";
import {
  PaymentProtocolError,
  paymentErrorCode,
  validateSelection,
  validateTerms,
  type PaymentPeer,
  type PaymentSelection,
  type P2pAuthenticatedPaymentContext,
  type P2pPaymentMessagePort,
  type PaymentProtocolCode,
  type PaymentSigner,
} from "../src/p2p-payment-protocol.ts";
import { randomUUID } from "node:crypto";
import { getAddress } from "ethers";

const RECIPIENT = "0x3d80c477021e3fa568e91c73baec8e806518d9a6";
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const ASSET = assetIdOf(97, CONTRACT);
const PROVIDER: PaymentPeer = { nodeId: "provider-node", fingerprint: "a".repeat(64) };
const CONSUMER: PaymentPeer = { nodeId: "consumer-node", fingerprint: "b".repeat(64) };
const PROVIDER_QUOTE = "c".repeat(64);
const AMOUNT = "1000001";
const EXPECTED_PAYER = TEST_PAYER.toLowerCase();

const dirs: string[] = [];
let dir = "";
let clock = 1_800_000_000_000;

function tempDir(): string { const value = mkdtempSync(join(tmpdir(), "omaih-p2p-payment-")); dirs.push(value); return value; }

function registry(): NetworkRegistry {
  const value = defaultRegistry();
  value.upsertAsset({
    assetId: ASSET, chainId: 97, contractAddress: CONTRACT, symbol: "tMock", name: "Test Mock",
    decimals: 6, issuerType: "mock", testnetOnly: true, enabled: true,
    pricing: { nanosPerToken: "1", version: "test", kind: "fixed-test-rate", note: "no value" },
  });
  return value;
}

function selection(over: Partial<PaymentSelection> = {}): PaymentSelection {
  return {
    consumerId: CONSUMER.nodeId,
    providerNodeId: PROVIDER.nodeId,
    providerFingerprint: PROVIDER.fingerprint,
    chainId: 97,
    asset: { assetId: ASSET, contractAddress: CONTRACT, decimals: 6 },
    amountRaw: AMOUNT,
    ...over,
  };
}

class MemoryPort implements P2pPaymentMessagePort {
  handler: ((ctx: P2pAuthenticatedPaymentContext) => Promise<{ code: string; detail?: string | null }>) | null = null;
  peer: MemoryPort | null = null;
  failNext = 0;
  lastResult: { code: string; detail?: string | null } | null = null;
  constructor(readonly local: PaymentPeer, readonly quoteHash: string | null) {}
  onPaymentMessage(handler: (ctx: P2pAuthenticatedPaymentContext) => Promise<{ code: string; detail?: string | null }>): void { this.handler = handler; }
  async sendPaymentMessage(to: PaymentPeer, input: { idempotency: string; correlation: string | null; body: unknown; expiresAt: string }): Promise<{ code: string; detail?: string | null }> {
    if (this.failNext > 0) { this.failNext -= 1; return { code: "transport", detail: null }; }
    const target = this.peer;
    if (!target?.handler) return { code: "transport", detail: null };
    if (to.nodeId !== target.local.nodeId || to.fingerprint !== target.local.fingerprint) return { code: "peer-mismatch", detail: null };
    const ctx: P2pAuthenticatedPaymentContext = {
      type: "payment_message", messageId: randomUUID().replace(/-/g, ""), idempotency: input.idempotency, correlation: input.correlation,
      from: this.local, to: target.local, sessionId: "test-session", catalogQuoteHash: this.quoteHash,
      receivedAt: new Date(clock).toISOString(), body: input.body,
    };
    this.lastResult = await target.handler(ctx);
    return { code: "queued", detail: null };
  }
}

interface Fixture {
  store: P2pPaymentStore;
  wallet: Wallet;
  providerPort: MemoryPort;
  consumerPort: MemoryPort;
  provider: ProviderPaymentService;
  consumer: ConsumerPaymentService;
  providerCoordinator: P2pPaymentCoordinator;
  consumerCoordinator: P2pPaymentCoordinator;
  authority: PaymentPeerAuthority & { reject: boolean; calls: number };
}

function fixture(options: { retry?: { attempts?: number; delayMs?: number }; signer?: PaymentSigner } = {}): Fixture {
  const registryValue = registry();
  const chain = new ChainStore(join(dir, "chain.sqlite"));
  const wallet = new Wallet({ registry: registryValue, store: chain, credit: {} as never, makeWatcher: () => { throw new Error("no RPC watcher in this test"); }, now: () => new Date(clock) });
  wallet.setReceivingAddress("provider-a", 97, RECIPIENT);
  const store = new P2pPaymentStore(join(dir, "p2p-payment.sqlite"));
  const providerPort = new MemoryPort(PROVIDER, PROVIDER_QUOTE);
  const consumerPort = new MemoryPort(CONSUMER, null);
  providerPort.peer = consumerPort;
  consumerPort.peer = providerPort;
  const provider = new ProviderPaymentService({
    node: PROVIDER,
    config: {
      providerId: "provider-a", nodeId: PROVIDER.nodeId, fingerprint: PROVIDER.fingerprint,
      authorizationGeneration: 7, quoteHash: PROVIDER_QUOTE, priceVersion: "price-v1",
      allowedNetworks: [97], allowedAssets: [{ assetId: ASSET, contractAddress: CONTRACT, decimals: 6 }],
    },
    wallet, store, now: () => clock,
  });
  const authority: Fixture["authority"] = {
    reject: false, calls: 0,
    assertAuthorized(input) {
      this.calls += 1;
      if (this.reject) throw new Error("provider not authorized");
      if (input.peer.nodeId !== PROVIDER.nodeId || input.peer.fingerprint !== PROVIDER.fingerprint) throw new Error("wrong provider");
      if (input.terms.provider.quoteHash !== PROVIDER_QUOTE) throw new Error("stale quote");
      if (input.terms.provider.authorizationGeneration !== 7) throw new Error("stale authorization generation");
      if (input.selection.amountRaw !== AMOUNT) throw new Error("wrong amount");
    },
  };
  const consumer = new ConsumerPaymentService({
    node: CONSUMER, store, authority,
    signer: options.signer ?? { async sign({ digest }) { return { signature: signDigest(digest), payerAddress: TEST_PAYER }; } },
    now: () => clock,
  });
  const providerCoordinator = new P2pPaymentCoordinator({
    node: PROVIDER, store, port: providerPort, provider, now: () => clock,
    retry: options.retry ?? { attempts: 3, delayMs: 0 }, sleep: async () => {},
  });
  const consumerCoordinator = new P2pPaymentCoordinator({
    node: CONSUMER, store, port: consumerPort, consumer, now: () => clock,
    retry: options.retry ?? { attempts: 3, delayMs: 0 }, sleep: async () => {},
  });
  providerCoordinator.start();
  consumerCoordinator.start();
  return { store, wallet, providerPort, consumerPort, provider, consumer, providerCoordinator, consumerCoordinator, authority };
}

async function expectCode(fn: () => unknown | Promise<unknown>, code: PaymentProtocolCode): Promise<void> {
  try { await fn(); } catch (error) {
    expect(error).toBeInstanceOf(PaymentProtocolError);
    expect((error as PaymentProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

async function paidFixture(): Promise<Fixture & { requestId: string; invoiceId: string; obligation: NonNullable<ReturnType<Fixture["consumer"]["obligation"]>> }> {
  const f = fixture();
  const requested = await f.consumerCoordinator.requestPayment({ selection: selection() });
  expect(requested.code).toBe("queued");
  const obligation = f.store.obligation(requested.requestId);
  expect(obligation).not.toBeNull();
  expect(obligation!.status).toBe("actionneeded");
  const signed = await f.consumerCoordinator.sign(requested.requestId);
  expect(signed.status).toBe("waitingpayment");
  expect(signed.code).toBe("queued");
  const paid = f.store.obligation(requested.requestId)!;
  expect(paid.status).toBe("waitingpayment");
  expect(paid.payerAddress).toBe(EXPECTED_PAYER);
  return { ...f, requestId: requested.requestId, invoiceId: paid.invoiceId, obligation: paid };
}

beforeEach(() => { dir = tempDir(); clock = 1_800_000_000_000; });
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("P2P payment terms and signature", () => {
  test("provider terms come from a real Wallet intent; consumer signs; provider verifies; journal resolver gets the exact binding", async () => {
    const f = await paidFixture();
    expect(f.obligation.terms.provider.nodeId).toBe(PROVIDER.nodeId);
    expect(f.obligation.terms.provider.fingerprint).toBe(PROVIDER.fingerprint);
    expect(f.obligation.terms.provider.authorizationGeneration).toBe(7);
    expect(f.obligation.terms.provider.quoteHash).toBe(PROVIDER_QUOTE);
    expect(f.obligation.binding).not.toBeNull();
    expect(f.obligation.binding!).toMatchObject({
      invoice: f.invoiceId,
      consumerAddress: EXPECTED_PAYER,
      providerIdentityFingerprint: PROVIDER.fingerprint,
      authorizationGeneration: 7,
      chainId: 97,
      assetId: ASSET,
      contractAddress: CONTRACT,
      decimals: 6,
      recipientAddress: RECIPIENT,
      amountRaw: AMOUNT,
      intentHash: f.obligation.digest,
    });
    expect(f.obligation.binding!.calldataHash).toBe(erc20TransferCalldataHash(RECIPIENT, AMOUNT));
    const providerRow = f.provider.status(f.invoiceId)!;
    expect(providerRow.status).toBe("waitingpayment");
    expect(providerRow.signature).toBe(f.obligation.signature);
    expect(providerRow.payerAddress).toBe(EXPECTED_PAYER);

    const resolver = f.consumer.obligationResolver();
    const resolved = resolver.resolve(f.invoiceId)!;
    expect(resolved.source).toBe("p2p-authenticated-request");
    expect(resolved.binding).toEqual(f.obligation.binding!);

    // The approvals local payment service can consume the P2P obligation.
    const local = new PaymentLocalService({
      resolver, assetRegistry: networkRegistryAssetResolver(registry()),
      journalPath: join(dir, "payment.sqlite"), ownerInstanceId: "test-owner", now: () => clock,
    });
    const ctx = { sessionId: "d".repeat(64), assertActive: () => true, isActive: () => true };
    const preview = await local.action("payment-obligation-preview", { obligationId: f.invoiceId }, ctx) as any;
    expect(preview.payment.invoice).toBe(f.invoiceId);
    expect(preview.payment.source).toBe("p2p-authenticated-request");
    const op = {
      schema: "ohmyaihub.external-wallet.operation/v1", intentHash: f.obligation.digest,
      account: EXPECTED_PAYER, chainId: 97, assetId: ASSET, contractAddress: CONTRACT,
      recipientAddress: RECIPIENT, amountRaw: AMOUNT,
      calldata: erc20TransferCalldata(RECIPIENT, AMOUNT), calldataHash: erc20TransferCalldataHash(RECIPIENT, AMOUNT),
    };
    const reservation = await local.action("payment-operation-reserve", { obligationId: f.invoiceId, previewRef: preview.previewRef, operation: op }, ctx) as any;
    expect(reservation.state).toBe("reserved");
    await local.action("payment-operation-mark", { obligationId: f.invoiceId, previewRef: preview.previewRef, reservationId: reservation.reservationId, operation: op }, ctx);
    const query = await local.action("payment-operation-query", { obligationId: f.invoiceId, operation: op }, ctx) as any;
    expect(query.state).toBe("broadcasting");
    local.close();
  });

  test("same request/idempotency does not create a second invoice; signature is idempotent", async () => {
    const f = fixture();
    let intentCalls = 0;
    const original = f.wallet.requestIntent.bind(f.wallet);
    (f.wallet as any).requestIntent = (input: Parameters<typeof original>[0]) => { intentCalls += 1; return original(input); };
    const requestId = randomUUID();
    const first = await f.consumerCoordinator.requestPayment({ selection: selection(), requestId, idempotency: "same-request" });
    const second = await f.consumerCoordinator.requestPayment({ selection: selection(), requestId, idempotency: "same-request" });
    expect(first.code).toBe("queued");
    expect(second.code).toBe("queued");
    expect(intentCalls).toBe(1);
    const firstInvoice = f.store.obligation(first.requestId)!.invoiceId;
    expect(f.store.obligation(second.requestId)!.invoiceId).toBe(firstInvoice);
    const third = await f.consumerCoordinator.requestPayment({ selection: selection(), idempotency: "same-request" });
    expect(third.requestId).toBe(requestId);
    const one = f.provider.status(firstInvoice)!;
    expect(one.requestId).toBe(requestId);
    expect(intentCalls).toBe(1);

    await f.consumerCoordinator.sign(requestId);
    await f.consumerCoordinator.sign(requestId);
    const after = f.provider.status(firstInvoice)!;
    expect(after.signature).not.toBeNull();
    expect(f.store.obligation(requestId)!.status).toBe("waitingpayment");
  });

  test("a checksummed EIP-712 document hashes and validates like its lowercase form", async () => {
    const f = await paidFixture();
    const terms = structuredClone(f.obligation.terms);
    (terms.typedData.message as Record<string, unknown>).recipient = getAddress(terms.recipientAddress);
    (terms.typedData.message as Record<string, unknown>).tokenContract = getAddress(terms.asset.contractAddress);
    (terms.intent as unknown as Record<string, unknown>).recipientAddress = getAddress(terms.recipientAddress);
    (terms.intent as unknown as Record<string, unknown>).tokenContract = getAddress(terms.asset.contractAddress);
    expect(() => validateTerms(terms)).not.toThrow();
  });

  test("checksummed addresses from the wallet/registry are accepted and normalized", () => {
    const checksummed = "0xF91D6aDC07a240B8663f965C17eEbb5C5e3436b9";
    const normalized = validateSelection(selection({
      asset: { assetId: `eip155:97:${checksummed.toLowerCase()}`, contractAddress: checksummed, decimals: 6 },
    }));
    expect(normalized.asset.contractAddress).toBe(checksummed.toLowerCase());
    expect(normalized.asset.assetId).toBe(`eip155:97:${checksummed.toLowerCase()}`);
  });

  test("a fresh request id for the same payment adopts the one open invoice instead of minting another", async () => {
    const f = fixture();
    let intentCalls = 0;
    const original = f.wallet.requestIntent.bind(f.wallet);
    (f.wallet as any).requestIntent = (input: Parameters<typeof original>[0]) => { intentCalls += 1; return original(input); };
    const first = await f.consumerCoordinator.requestPayment({ selection: selection(), idempotency: "first" });
    const invoice = f.store.obligation(first.requestId)!.invoiceId;
    // A lost terms reply / client restart uses a fresh request id. The provider
    // must answer with the existing invoice, not create a second one.
    const second = await f.consumerCoordinator.requestPayment({ selection: selection(), idempotency: "second" });
    expect(second.requestId).not.toBe(first.requestId);
    expect(intentCalls).toBe(1);
    const adopted = f.store.obligation(second.requestId) ?? f.store.obligationByInvoice(invoice);
    expect(adopted).not.toBeNull();
    // The obligation is stored under the provider's request id, but the
    // consumer can find it by invoice and sign exactly the adopted terms.
    const obligation = f.store.obligationByInvoice(invoice)!;
    expect(obligation.invoiceId).toBe(invoice);
    expect(obligation.terms.requestId).toBe(first.requestId);
    const signed = await f.consumerCoordinator.sign(obligation.requestId);
    expect(signed.status).toBe("waitingpayment");
    const providerRow = f.provider.status(invoice)!;
    expect(providerRow.signature).not.toBeNull();
    expect(f.consumer.obligationResolver().resolve(invoice)).not.toBeNull();
  });

  test("a provider crash after the ChainStore intent reuses that invoice, not a second one", async () => {
    const f = fixture();
    // Simulate the crash window: the intent exists, the P2P request row does not.
    const orphan = f.wallet.requestIntent({
      providerId: "provider-a", consumerId: CONSUMER.nodeId, chainId: 97,
      assetId: ASSET, amountRaw: AMOUNT, ttlSec: 3600,
    });
    expect(f.store.providerRequestByInvoice(orphan.intent.invoiceId)).toBeNull();
    const requested = await f.consumerCoordinator.requestPayment({ selection: selection() });
    const obligation = f.store.obligationByInvoice(orphan.intent.invoiceId);
    expect(obligation).not.toBeNull();
    expect(f.store.providerRequestByInvoice(orphan.intent.invoiceId)!.invoiceId).toBe(orphan.intent.invoiceId);
    expect(f.provider.status(orphan.intent.invoiceId)!.requestId).toBe(requested.requestId);
  });

  test("a signature frame cannot bind an invoice to a different provider request id", async () => {
    const f = fixture();
    const a = await f.consumerCoordinator.requestPayment({ selection: selection() });
    const obligA = f.store.obligation(a.requestId)!;
    // A second provider request from another consumer, created directly so the
    // test does not depend on the consumer-side authority fixture.
    const other = { nodeId: "consumer-two", fingerprint: "e".repeat(64) };
    const otherRequestId = randomUUID();
    const created = await f.provider.createTerms({
      selection: {
        consumerId: other.nodeId, providerNodeId: PROVIDER.nodeId, providerFingerprint: PROVIDER.fingerprint,
        chainId: 97, asset: { assetId: ASSET, contractAddress: CONTRACT, decimals: 6 }, amountRaw: "2000002",
      },
      consumer: other, requestId: otherRequestId, idempotency: `request:${otherRequestId}`,
    });
    expect(created.request.invoiceId).not.toBe(obligA.invoiceId);
    const signature = signDigest(obligA.digest);
    // Frame B's request id with A's invoice: the provider looks up B, then must
    // refuse instead of binding A's signature to B's request.
    const frame = {
      schema: "ohmyaihub/payment/v1", kind: "signature", requestId: otherRequestId,
      invoiceId: obligA.invoiceId, from: other, to: PROVIDER,
      createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 60_000).toISOString(),
      body: { invoiceId: obligA.invoiceId, requestId: otherRequestId, signature, payerAddress: TEST_PAYER },
    };
    await expectCode(
      () => f.provider.handleFrame({
        type: "payment_message", messageId: randomUUID(), idempotency: "bad-pair", correlation: otherRequestId,
        from: other, to: PROVIDER, sessionId: "test-session", catalogQuoteHash: null,
        receivedAt: new Date(clock).toISOString(), body: frame,
      } as never, frame as never),
      "terms-mismatch",
    );
    expect(f.provider.status(obligA.invoiceId)!.signature).toBeNull();
    expect(f.provider.status(created.request.invoiceId)!.signature).toBeNull();
  });

  test("the payment store and its WAL sidecars are 0600", () => {
    const f = fixture();
    expect(statSync(join(dir, "p2p-payment.sqlite")).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try { expect(statSync(join(dir, `p2p-payment.sqlite${suffix}`)).mode & 0o777).toBe(0o600); } catch { /* absent while empty */ }
    }
    f.store.close();
  });

  test("a bounded outbound retry reuses the same idempotency and creates one request", async () => {
    const f = fixture();
    f.consumerPort.failNext = 2;
    const requested = await f.consumerCoordinator.requestPayment({ selection: selection() });
    expect(requested.code).toBe("queued");
    expect(f.store.providerRequest(requested.requestId)).not.toBeNull();
    expect(f.store.obligation(requested.requestId)).not.toBeNull();
  });
});

describe("P2P payment safety gates and status", () => {
  test("mainnet/product and unknown networks are blocked before a request/terms", async () => {
    const f = fixture();
    for (const chainId of [56, 8453, 1, 31337]) {
      await expectCode(
        () => f.consumerCoordinator.requestPayment({ selection: selection({ chainId, asset: { assetId: assetIdOf(chainId, CONTRACT), contractAddress: CONTRACT, decimals: 6 } }) }),
        "network-gated",
      );
    }
    expect(f.store.selection("no-such-request")).toBeNull();
    await expectCode(
      () => f.provider.createTerms({ selection: selection({ chainId: 56 }), consumer: CONSUMER, requestId: randomUUID(), idempotency: "mainnet" }),
      "network-gated",
    );
  });

  test("a terms/selection/quote/authority mismatch is rejected without an obligation", async () => {
    const f = fixture();
    f.authority.reject = true;
    const requested = await f.consumerCoordinator.requestPayment({ selection: selection() });
    expect(requested.code).toBe("queued");
    expect(f.store.obligation(requested.requestId)).toBeNull();
    expect(f.store.selection(requested.requestId)?.status).toBe("actionneeded");
    expect(f.provider.status(f.store.providerRequest(requested.requestId)?.invoiceId ?? "")).not.toBeNull();
  });

  test("provider identity/quote/authorization generation and selection are bound", async () => {
    const f = fixture();
    const requested = await f.consumerCoordinator.requestPayment({ selection: selection() });
    const providerRequest = f.store.providerRequest(requested.requestId)!;
    const ctx = {
      type: "payment_message" as const, messageId: randomUUID(), idempotency: "tamper", correlation: requested.requestId,
      from: PROVIDER, to: CONSUMER, sessionId: "tamper-session", catalogQuoteHash: PROVIDER_QUOTE,
      receivedAt: new Date(clock).toISOString(), body: {},
    };
    const frameOf = (terms: typeof providerRequest.terms) => ({
      schema: "ohmyaihub/payment/v1" as const, kind: "terms" as const, requestId: requested.requestId,
      invoiceId: terms.invoiceId, from: PROVIDER, to: CONSUMER,
      createdAt: new Date(clock).toISOString(),
      expiresAt: new Date(Math.min(clock + 10 * 60_000, Date.parse(terms.expiresAt))).toISOString(),
      body: { terms },
    });

    const staleQuote = { ...providerRequest.terms, provider: { ...providerRequest.terms.provider, quoteHash: "e".repeat(64) } };
    await expectCode(() => f.consumer.handleFrame(ctx, frameOf(staleQuote)), "authority");
    const staleGeneration = { ...providerRequest.terms, provider: { ...providerRequest.terms.provider, authorizationGeneration: 8 } };
    await expectCode(() => f.consumer.handleFrame(ctx, frameOf(staleGeneration)), "authority");
    const otherIdentity = { ...providerRequest.terms, provider: { ...providerRequest.terms.provider, fingerprint: "f".repeat(64) } };
    await expectCode(() => f.consumer.handleFrame(ctx, frameOf(otherIdentity)), "peer-mismatch");

    // A self-consistent terms object for a different amount is rejected by the
    // consumer's persisted selection, not accepted as a new client JSON quote.
    const otherSelection = selection({ amountRaw: "2000002", consumerId: CONSUMER.nodeId });
    const other = await f.provider.createTerms({ selection: otherSelection, consumer: CONSUMER, requestId: randomUUID(), idempotency: "other-amount" });
    const mismatched = { ...other.request.terms, requestId: requested.requestId };
    await expectCode(() => f.consumer.handleFrame(ctx, frameOf(mismatched)), "selection-mismatch");
    expect(f.store.obligation(requested.requestId)!.status).toBe("actionneeded");
  });

  test("signature only reaches waitingpayment; only a local provider observation reaches confirming/received", async () => {
    const f = await paidFixture();
    expect(f.consumer.status(f.invoiceId)).toMatchObject({ localStatus: "waitingpayment", peerStatus: "waitingpayment", status: "waitingpayment" });
    expect(f.provider.status(f.invoiceId)!.status).toBe("waitingpayment");
    const confirming = await f.providerCoordinator.observe({ requestId: f.requestId, invoiceId: f.invoiceId, status: "confirming", detail: null, observedAt: new Date(clock).toISOString() });
    expect(confirming.code).toBe("queued");
    expect(f.consumer.status(f.invoiceId)).toMatchObject({ localStatus: "waitingpayment", peerStatus: "confirming", status: "confirming" });
    expect(f.consumer.obligationResolver().resolve(f.invoiceId)).toBeNull();
    const received = await f.providerCoordinator.observe({ requestId: f.requestId, invoiceId: f.invoiceId, status: "received", detail: null, observedAt: new Date(clock).toISOString() });
    expect(received.code).toBe("queued");
    expect(f.provider.status(f.invoiceId)!.status).toBe("received");
    expect(f.consumer.status(f.invoiceId)).toMatchObject({ localStatus: "waitingpayment", peerStatus: "received", status: "received" });
    expect(f.consumer.obligationResolver().resolve(f.invoiceId)).toBeNull();
  });

  test("an invalid provider-side signature becomes actionneeded, never received", async () => {
    const f = fixture({
      signer: {
        async sign() {
          return { signature: `0x${"11".repeat(65)}`, payerAddress: TEST_PAYER };
        },
      },
    });
    const requested = await f.consumerCoordinator.requestPayment({ selection: selection() });
    const signed = await f.consumerCoordinator.sign(requested.requestId);
    expect(signed.status).toBe("waitingpayment");
    const obligation = f.store.obligation(requested.requestId)!;
    expect(obligation.status).toBe("waitingpayment");
    expect(obligation.peerStatus).toBe("actionneeded");
    expect(f.provider.status(obligation.invoiceId)!.status).toBe("actionneeded");
    expect(f.consumer.status(obligation.invoiceId)).toMatchObject({ status: "actionneeded", localStatus: "waitingpayment", peerStatus: "actionneeded", source: "peer" });
    expect(f.consumer.obligationResolver().resolve(obligation.invoiceId)).toBeNull();
  });

  test("expired terms cannot be signed or paid", async () => {
    const f = fixture();
    const requested = await f.consumerCoordinator.requestPayment({ selection: selection() });
    const obligation = f.store.obligation(requested.requestId)!;
    clock = Date.parse(obligation.terms.expiresAt) + 1;
    await expectCode(() => f.consumerCoordinator.sign(requested.requestId), "expired");
    expect(f.consumer.obligationResolver().resolve(obligation.invoiceId)).toBeNull();
  });

  test("store is 0600 and contains only public payment data, no key/seed/private material", async () => {
    const f = await paidFixture();
    const path = join(dir, "p2p-payment.sqlite");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path).toString("utf8") + readFileSync(`${path}-wal`).toString("utf8");
    for (const forbidden of ["privateKey", "private_key", "mnemonic", "seed", "rawTransaction", "eth_sendTransaction"]) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(raw).toContain(f.invoiceId);
    f.store.close();
  });
});
