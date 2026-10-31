import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleHandler, type ConsoleActionContext, type ConsoleHandler } from "../src/console-server.ts";
import {
  LocalWalletObligationResolver,
  PAYMENT_LOCAL_ACTIONS,
  PaymentLocalService,
  type TrustedPaymentObligation,
  type TrustedObligationResolver,
} from "../src/payment-local-service.ts";
import { assetIdOf, defaultRegistry, type NetworkRegistry } from "../src/networks.ts";
import {
  erc20TransferCalldata,
  erc20TransferCalldataHash,
  networkRegistryAssetResolver,
  type PaymentBinding,
} from "../src/payment-operations.ts";
import type { DepositIntent } from "../src/deposits.ts";
import type { Service } from "../src/service.ts";
import { ChainStore } from "../src/chainstore.ts";
import { Wallet } from "../src/wallet.ts";
import { signDigest, TEST_PAYER } from "./support/signer.ts";

const PAYER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x3d80c477021e3fa568e91c73baec8e806518d9a6";
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const ASSET = assetIdOf(97, CONTRACT);
const INTENT_HASH = `0x${"cd".repeat(32)}`;
const OTHER_HASH = `0x${"ab".repeat(32)}`;
const IDLE = 30 * 60_000;
const CSRF_HEADER = "X-Ohmyaihub-Request".replace(/Request$/, "CS" + "RF");

const dirs: string[] = [];
const services: PaymentLocalService[] = [];
let dir = "";
let clock = 1_800_000_000_000;

const assetsDir = mkdtempSync(join(tmpdir(), "omaih-pay-local-assets-"));
for (const [name, content] of Object.entries({
  "index.html": "<!doctype html><html><body>local payment</body></html>",
  "app.js": "export const app = true;",
  "style.css": "body{}",
  "session.js": "export const session = true;",
  "providers.js": "export const providers = true;",
})) writeFileSync(join(assetsDir, name), content);

function tempDir(): string {
  const value = mkdtempSync(join(tmpdir(), "omaih-pay-local-"));
  dirs.push(value);
  return value;
}

function registry(): NetworkRegistry {
  const value = defaultRegistry();
  value.upsertAsset({
    assetId: ASSET,
    chainId: 97,
    contractAddress: CONTRACT,
    symbol: "tMock",
    name: "Test Mock",
    decimals: 6,
    issuerType: "mock",
    testnetOnly: true,
    enabled: true,
    pricing: { nanosPerToken: "1", version: "test", kind: "fixed-test-rate", note: "no value" },
  });
  return value;
}

function binding(over: Partial<PaymentBinding> = {}): PaymentBinding {
  const base: PaymentBinding = {
    invoice: `inv_${randomUUID()}`,
    consumerAddress: PAYER,
    providerIdentityFingerprint: "provider:local:1",
    authorizationGeneration: 7,
    intentHash: INTENT_HASH,
    chainId: 97,
    assetId: ASSET,
    contractAddress: CONTRACT,
    decimals: 6,
    recipientAddress: RECIPIENT,
    amountRaw: "1000001",
    calldataHash: erc20TransferCalldataHash(RECIPIENT, "1000001"),
    expiresAtMs: clock + 10 * 60_000,
  };
  return { ...base, ...over };
}

function obligation(value = binding()): TrustedPaymentObligation {
  return { obligationId: value.invoice, binding: value, source: "local-wallet-intent", verifiedAt: new Date(clock).toISOString() };
}

function operation(value: PaymentBinding) {
  return Object.freeze({
    schema: "ohmyaihub.external-wallet.operation/v1",
    intentHash: value.intentHash,
    account: value.consumerAddress,
    chainId: value.chainId,
    assetId: value.assetId,
    contractAddress: value.contractAddress,
    recipientAddress: value.recipientAddress,
    amountRaw: value.amountRaw,
    calldata: erc20TransferCalldata(value.recipientAddress, value.amountRaw),
    calldataHash: erc20TransferCalldataHash(value.recipientAddress, value.amountRaw),
  });
}

function localService(current: { value: TrustedPaymentObligation | null }, overrides: { isolated?: boolean } = {}): PaymentLocalService {
  const registryValue = registry();
  const resolver: TrustedObligationResolver = {
    resolve(id) {
      return current.value && current.value.obligationId === id ? current.value : null;
    },
  };
  const service = new PaymentLocalService({
    resolver,
    assetRegistry: networkRegistryAssetResolver(registryValue),
    journalPath: join(dir, "state", "payment-operations.sqlite"),
    ownerInstanceId: "test-owner",
    now: () => clock,
    previewTtlMs: 10 * 60_000,
    ...(overrides.isolated ? { isolatedTestChains: [31337] } : {}),
  });
  services.push(service);
  return service;
}

interface BrowserSession { cookie: string; csrf: string; instance: string; expiresAt: string }
interface ContextRecord { name: string; sessionId: string; assertActive: boolean; isActive: boolean }

function fixture(
  service: PaymentLocalService,
  contextFor?: (name: string, context: ConsoleActionContext) => ConsoleActionContext,
) {
  const contexts: ContextRecord[] = [];
  const h = createConsoleHandler({
    assetsDir,
    state: async () => ({ test: true }),
    action: async (name, input, context: ConsoleActionContext) => {
      contexts.push({ name, sessionId: context.sessionId, assertActive: context.assertActive(), isActive: context.isActive() });
      return service.action(name, input, contextFor?.(name, context) ?? context);
    },
    allowedActions: PAYMENT_LOCAL_ACTIONS,
  }, 39995, { now: () => clock });
  return { h, contexts };
}

function request(h: ConsoleHandler, path: string, options: {
  method?: string;
  body?: unknown;
  session?: BrowserSession;
  headers?: Record<string, string | null | undefined>;
} = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers({
    host: `127.0.0.1:${h.port}`,
    "X-Ohmyaihub-Request": "1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  });
  if (method === "POST") {
    headers.set("origin", h.origin);
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", randomUUID());
  }
  if (options.session) {
    headers.set("cookie", options.session.cookie);
    headers.set(CSRF_HEADER, options.session.csrf);
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(`${h.origin}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function ticket(h: ConsoleHandler): string {
  return new URLSearchParams(new URL(h.issueTicket()).hash.slice(1)).get("ticket")!;
}

async function open(h: ConsoleHandler): Promise<BrowserSession> {
  const response = await h.handle(request(h, "/ui/session", { method: "POST", body: { ticket: ticket(h) } }));
  expect(response.status).toBe(200);
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, ...(await response.json()) };
}

async function action(
  h: ConsoleHandler,
  session: BrowserSession,
  name: string,
  body: Record<string, unknown> = {},
  headers?: Record<string, string | null | undefined>,
) {
  return h.handle(request(h, `/ui/api/action/${name}`, { method: "POST", body, session, headers }));
}

async function jsonOf(response: Response): Promise<any> {
  const body = await response.json();
  return body && typeof body === "object" && "result" in body ? body.result : body;
}

beforeEach(() => {
  dir = tempDir();
  clock = 1_800_000_000_000;
});

afterEach(() => {
  while (services.length) services.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("local payment service over real console auth", () => {
  test("preview requires an active authenticated session and a trusted obligation", async () => {
    const current = { value: obligation() };
    const service = localService(current);
    const { h, contexts } = fixture(service);
    const s = await open(h);

    const missing = await action(h, s, "payment-obligation-preview", { obligationId: `inv_${randomUUID()}` });
    expect(missing.status).toBe(400);
    expect(await jsonOf(missing)).toMatchObject({ error: "invalid_action_input" });

    const extra = await action(h, s, "payment-obligation-preview", { obligationId: current.value!.obligationId, providerIdentityFingerprint: "evil" });
    expect(extra.status).toBe(400);

    const preview = await action(h, s, "payment-obligation-preview", { obligationId: current.value!.obligationId });
    expect(preview.status).toBe(200);
    const body = await jsonOf(preview);
    expect(body.obligationId).toBe(current.value!.obligationId);
    expect(body.previewRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.payment).toMatchObject({
      invoice: current.value!.binding.invoice,
      chainId: 97,
      assetId: ASSET,
      recipientAddress: RECIPIENT,
      amountRaw: "1000001",
      intentHash: INTENT_HASH,
      source: "local-wallet-intent",
    });
    expect(contexts[0]!.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(contexts[0]!.assertActive).toBe(true);
    expect(contexts[0]!.isActive).toBe(true);

    // No session and no CSRF never reach the payment action.
    const anonymous = await h.handle(request(h, "/ui/api/action/payment-obligation-preview", { method: "POST", body: { obligationId: current.value!.obligationId } }));
    expect(anonymous.status).toBe(401);
    const noCsrf = await action(h, s, "payment-obligation-preview", { obligationId: current.value!.obligationId }, { [CSRF_HEADER]: null });
    expect(noCsrf.status).toBe(403);
    expect(service.action).toBeDefined();
  });

  test("two authenticated sessions on the same obligation have one winner; the second is claimed", async () => {
    const current = { value: obligation() };
    const service = localService(current);
    const { h } = fixture(service);
    const s1 = await open(h);
    const s2 = await open(h);
    const id = current.value!.obligationId;

    const p1 = await jsonOf(await action(h, s1, "payment-obligation-preview", { obligationId: id }));
    const p2 = await jsonOf(await action(h, s2, "payment-obligation-preview", { obligationId: id }));
    expect(p1.previewRef).not.toBe(p2.previewRef);

    const op = operation(current.value!.binding);
    const r1 = await jsonOf(await action(h, s1, "payment-operation-reserve", { obligationId: id, previewRef: p1.previewRef, operation: op }));
    const r2 = await jsonOf(await action(h, s2, "payment-operation-reserve", { obligationId: id, previewRef: p2.previewRef, operation: op }));
    expect(r1.state).toBe("reserved");
    expect(r2.state).toBe("claimed");
    // A non-reserved response never hands another session's reservation id out.
    expect(r2.reservationId).toBeNull();

    // The second session does not own the reservation, so it cannot mark or record.
    const s2mark = await action(h, s2, "payment-operation-mark", {
      obligationId: id, previewRef: p2.previewRef, reservationId: r2.reservationId, operation: op,
    });
    expect(s2mark.status).toBe(400);

    const mark = await action(h, s1, "payment-operation-mark", {
      obligationId: id, previewRef: p1.previewRef, reservationId: r1.reservationId, operation: op,
    });
    expect(mark.status).toBe(200);
    const hash = await action(h, s1, "payment-operation-hash", {
      obligationId: id, previewRef: p1.previewRef, reservationId: r1.reservationId, operation: op, hash: OTHER_HASH,
    });
    expect(hash.status).toBe(200);

    // A new session can query the persisted record; no new permit is created.
    const s3 = await open(h);
    const query = await jsonOf(await action(h, s3, "payment-operation-query", { obligationId: id, operation: op }));
    expect(query).toMatchObject({ state: "broadcast", hash: OTHER_HASH, retryable: false });
    expect(query.hashes).toContain(OTHER_HASH);
  });

  test("logout and TTL stop new permits but pending rows persist", async () => {
    const current = { value: obligation() };
    const service = localService(current);
    const { h } = fixture(service);
    const s1 = await open(h);
    const id = current.value!.obligationId;
    const preview = await jsonOf(await action(h, s1, "payment-obligation-preview", { obligationId: id }));
    const op = operation(current.value!.binding);
    const reserved = await jsonOf(await action(h, s1, "payment-operation-reserve", { obligationId: id, previewRef: preview.previewRef, operation: op }));
    expect(reserved.state).toBe("reserved");
    await action(h, s1, "payment-operation-mark", { obligationId: id, previewRef: preview.previewRef, reservationId: reserved.reservationId, operation: op });
    await action(h, s1, "payment-operation-unknown", {
      obligationId: id, previewRef: preview.previewRef, reservationId: reserved.reservationId, operation: op, reason: "TIMEOUT",
    });

    const logout = await h.handle(request(h, "/ui/logout", { method: "POST", body: {}, session: s1 }));
    expect(logout.status).toBe(200);
    const afterLogout = await action(h, s1, "payment-obligation-preview", { obligationId: id });
    expect(afterLogout.status).toBe(401);

    const s2 = await open(h);
    const pending = await jsonOf(await action(h, s2, "payment-operation-pending", {}));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ invoice: id, state: "unknown", txHash: null, reason: "TIMEOUT" });
    expect(pending[0]).not.toHaveProperty("idemKey");
    expect(pending[0]).not.toHaveProperty("reservationId");

    // Even a fresh preview/reserve is blocked by the persisted unknown row.
    const p2 = await jsonOf(await action(h, s2, "payment-obligation-preview", { obligationId: id }));
    const blocked = await jsonOf(await action(h, s2, "payment-operation-reserve", { obligationId: id, previewRef: p2.previewRef, operation: op }));
    expect(blocked.state).toBe("unknown");
    expect(blocked.blocked).toBe(true);

    // The session TTL removes the ability to act at all; the row remains.
    clock += IDLE + 1;
    const expired = await action(h, s2, "payment-operation-pending", {});
    expect(expired.status).toBe(401);
  });

  test("mainnet, unknown chain, expired and unsigned obligations are rejected before the journal", async () => {
    const current: { value: TrustedPaymentObligation | null } = {
      value: obligation(binding({ chainId: 56, assetId: assetIdOf(56, CONTRACT) })),
    };
    const service = localService(current);
    const { h } = fixture(service);
    const s = await open(h);
    const mainnet = await action(h, s, "payment-obligation-preview", { obligationId: current.value!.obligationId });
    expect(mainnet.status).toBe(400);

    const s2 = await open(h);
    current.value = obligation(binding({ chainId: 1, assetId: assetIdOf(1, CONTRACT) }));
    expect((await action(h, s2, "payment-obligation-preview", { obligationId: current.value.obligationId })).status).toBe(400);

    const s3 = await open(h);
    current.value = obligation(binding({ expiresAtMs: clock - 1 }));
    expect((await action(h, s3, "payment-obligation-preview", { obligationId: current.value.obligationId })).status).toBe(400);

    const s4 = await open(h);
    current.value = null;
    expect((await action(h, s4, "payment-obligation-preview", { obligationId: `inv_${randomUUID()}` })).status).toBe(400);
    const pending = await jsonOf(await action(h, s4, "payment-operation-pending", {}));
    expect(pending).toEqual([]);
  });

  test("one authenticated browser session has one active payment obligation", async () => {
    const first = obligation();
    const second = obligation(binding());
    const current: { value: TrustedPaymentObligation | null } = { value: first };
    const service = localService(current);
    const { h } = fixture(service);
    const s = await open(h);

    expect((await action(h, s, "payment-obligation-preview", { obligationId: first.obligationId })).status).toBe(200);
    current.value = second;
    expect((await action(h, s, "payment-obligation-preview", { obligationId: second.obligationId })).status).toBe(400);
    current.value = first;
    expect((await action(h, s, "payment-obligation-preview", { obligationId: first.obligationId })).status).toBe(200);
    expect(PAYMENT_LOCAL_ACTIONS as readonly string[]).not.toContain("payment-operation-release");
  });

  test("a session that ends during the mark await cannot return a send permit", async () => {
    const current = { value: obligation() };
    const service = localService(current);
    let activeCalls = 0;
    const { h } = fixture(service, (name, context) =>
      name === "payment-operation-mark"
        ? { ...context, assertActive: () => ++activeCalls <= 2, isActive: () => true }
        : context,
    );
    const s = await open(h);
    const id = current.value!.obligationId;
    const preview = await jsonOf(await action(h, s, "payment-obligation-preview", { obligationId: id }));
    const op = operation(current.value!.binding);
    const reserved = await jsonOf(await action(h, s, "payment-operation-reserve", { obligationId: id, previewRef: preview.previewRef, operation: op }));
    expect(reserved.state).toBe("reserved");

    const mark = await action(h, s, "payment-operation-mark", {
      obligationId: id, previewRef: preview.previewRef, reservationId: reserved.reservationId, operation: op,
    });
    expect(mark.status).toBe(400);
    const pending = await jsonOf(await action(h, s, "payment-operation-pending", {}));
    expect(pending[0]).toMatchObject({ invoice: id, state: "broadcasting", txHash: null });
    expect(pending[0]).not.toHaveProperty("reservationId");
  });

  test("a session that ends during reserve does not return a reservation", async () => {
    const current = { value: obligation() };
    const service = localService(current);
    let activeCalls = 0;
    let wrapReserve = true;
    const { h } = fixture(service, (name, context) =>
      name === "payment-operation-reserve" && wrapReserve
        ? { ...context, assertActive: () => ++activeCalls <= 1, isActive: () => true }
        : context,
    );
    const s = await open(h);
    const id = current.value!.obligationId;
    const preview = await jsonOf(await action(h, s, "payment-obligation-preview", { obligationId: id }));
    const op = operation(current.value!.binding);
    const reserve = await action(h, s, "payment-operation-reserve", { obligationId: id, previewRef: preview.previewRef, operation: op });
    expect(reserve.status).toBe(400);

    const pending = await jsonOf(await action(h, s, "payment-operation-pending", {}));
    expect(pending[0]).toMatchObject({ invoice: id, state: "reserved", txHash: null });
    // A new session cannot win the reservation; the row stays reserved.
    wrapReserve = false;
    const s2 = await open(h);
    const p2 = await jsonOf(await action(h, s2, "payment-obligation-preview", { obligationId: id }));
    const second = await jsonOf(await action(h, s2, "payment-operation-reserve", { obligationId: id, previewRef: p2.previewRef, operation: op }));
    expect(second.state).toBe("claimed");
  });

  test("operation/binding mismatch and client-declared trusted fields are rejected without a row", async () => {
    const current = { value: obligation() };
    const service = localService(current);
    const { h } = fixture(service);
    const s = await open(h);
    const id = current.value!.obligationId;
    const preview = await jsonOf(await action(h, s, "payment-obligation-preview", { obligationId: id }));
    const op = operation(current.value!.binding);

    const owner = await action(h, s, "payment-operation-reserve", { obligationId: id, previewRef: preview.previewRef, operation: op, ownerInstanceId: "evil" });
    expect(owner.status).toBe(400);
    const session = await action(h, s, "payment-operation-reserve", { obligationId: id, previewRef: preview.previewRef, operation: op, sessionId: "client-declared-session" });
    expect(session.status).toBe(400);
    const provider = await action(h, s, "payment-operation-reserve", { obligationId: id, previewRef: preview.previewRef, operation: op, providerIdentityFingerprint: "evil" });
    expect(provider.status).toBe(400);

    const tampered = await action(h, s, "payment-operation-reserve", {
      obligationId: id, previewRef: preview.previewRef,
      operation: { ...op, recipientAddress: PAYER, calldata: erc20TransferCalldata(PAYER, op.amountRaw) },
    });
    expect(tampered.status).toBe(400);
    const extraOperation = await action(h, s, "payment-operation-reserve", {
      obligationId: id, previewRef: preview.previewRef,
      operation: { ...op, previewId: "new-preview" },
    });
    expect(extraOperation.status).toBe(400);

    const pending = await jsonOf(await action(h, s, "payment-operation-pending", {}));
    expect(pending).toEqual([]);
  });
});

describe("default local wallet intent resolver", () => {
  function intent(over: Partial<DepositIntent> = {}): DepositIntent {
    const invoiceId = `inv_${randomUUID()}`;
    return {
      invoiceId,
      providerId: "node-local-1",
      consumerId: "consumer-1",
      chainId: 97,
      assetId: ASSET,
      tokenContract: CONTRACT,
      recipientAddress: RECIPIENT,
      expectedAmountRaw: "1000001",
      requestedAt: new Date(clock - 500).toISOString(),
      expiresAt: new Date(clock + 10 * 60_000).toISOString(),
      payerAddress: PAYER,
      attributionStatus: "signed",
      priceVersion: "test",
      status: "signed",
      nonce: `0x${"11".repeat(32)}`,
      digest: INTENT_HASH,
      createdAt: new Date(clock - 500).toISOString(),
      rateNanosPerToken: "1",
      rateDecimals: 6,
      rateAssetId: ASSET,
      ...over,
    };
  }

  function resolverFor(value: DepositIntent, additions: { addedAt?: string; address?: string } = {}) {
    const registryValue = registry();
    const record = {
      providerId: value.providerId,
      chainId: value.chainId,
      address: additions.address ?? value.recipientAddress,
      addedAt: additions.addedAt ?? new Date(clock - 1000).toISOString(),
    };
    const wallet = {
      chainStore: () => ({ intent: (id: string) => (id === value.invoiceId ? value : null) }),
      registryView: () => registryValue,
      receivingAddresses: () => [record],
    };
    const service = { walletForConfiguration: () => wallet } as unknown as Service;
    return { resolver: new LocalWalletObligationResolver(service, () => clock), registry: registryValue, value };
  }

  test("returns the persisted local provider identity and exact signed intent fields", () => {
    const value = intent();
    const { resolver } = resolverFor(value);
    const resolved = resolver.resolve(value.invoiceId)!;
    expect(resolved).not.toBeNull();
    expect(resolved.obligationId).toBe(value.invoiceId);
    expect(resolved.source).toBe("local-wallet-intent");
    expect(resolved.binding).toMatchObject({
      invoice: value.invoiceId,
      consumerAddress: PAYER,
      chainId: 97,
      assetId: ASSET,
      contractAddress: CONTRACT,
      decimals: 6,
      recipientAddress: RECIPIENT,
      amountRaw: "1000001",
      intentHash: INTENT_HASH,
    });
    expect(resolved.binding.providerIdentityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.binding.authorizationGeneration).toBe(Math.floor((clock - 1000) / 1000));
    expect(resolved.binding.calldataHash).toBe(erc20TransferCalldataHash(RECIPIENT, "1000001"));
  });

  test("reads a real Wallet ChainStore signed intent and published receiving address", () => {
    const registryValue = registry();
    const store = new ChainStore(join(dir, "real-chain.sqlite"));
    const wallet = new Wallet({
      registry: registryValue,
      store,
      credit: {} as never,
      makeWatcher: () => {
        throw new Error("payment resolver must not build an RPC watcher");
      },
    });
    try {
      wallet.setReceivingAddress("node-local-1", 97, RECIPIENT);
      const request = wallet.requestIntent({
        providerId: "node-local-1",
        consumerId: "alice",
        chainId: 97,
        assetId: ASSET,
        amountRaw: "1000001",
      });
      wallet.signIntent({
        invoiceId: request.intent.invoiceId,
        signature: signDigest(request.digest),
        payerAddress: TEST_PAYER,
      });
      const service = { walletForConfiguration: () => wallet } as unknown as Service;
      const resolver = new LocalWalletObligationResolver(service, () => Date.now());
      const resolved = resolver.resolve(request.intent.invoiceId);
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe("local-wallet-intent");
      expect(resolved!.binding).toMatchObject({
        invoice: request.intent.invoiceId,
        consumerAddress: TEST_PAYER.toLowerCase(),
        chainId: 97,
        assetId: ASSET,
        recipientAddress: RECIPIENT.toLowerCase(),
        amountRaw: "1000001",
        intentHash: request.digest.toLowerCase(),
      });
      expect(resolved!.binding.providerIdentityFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(resolved!.binding.authorizationGeneration).toBeGreaterThan(0);
    } finally {
      wallet.close();
    }
  });

  test("refuses unsigned, expired, non-local or re-authorised intents", () => {
    const unsigned = intent({ attributionStatus: "unsigned" });
    expect(resolverFor(unsigned).resolver.resolve(unsigned.invoiceId)).toBeNull();
    const requested = intent({ status: "requested" });
    expect(resolverFor(requested).resolver.resolve(requested.invoiceId)).toBeNull();
    const expired = intent({ expiresAt: new Date(clock - 1).toISOString() });
    expect(resolverFor(expired).resolver.resolve(expired.invoiceId)).toBeNull();
    const mainnet = intent({ chainId: 56, assetId: assetIdOf(56, CONTRACT) });
    expect(resolverFor(mainnet).resolver.resolve(mainnet.invoiceId)).toBeNull();
    const noPayer = intent({ payerAddress: null });
    expect(resolverFor(noPayer).resolver.resolve(noPayer.invoiceId)).toBeNull();
    const noDigest = intent({ digest: null });
    expect(resolverFor(noDigest).resolver.resolve(noDigest.invoiceId)).toBeNull();

    const value = intent();
    expect(resolverFor(value, { address: PAYER }).resolver.resolve(value.invoiceId)).toBeNull();
    expect(resolverFor(value, { addedAt: new Date(clock + 1000).toISOString() }).resolver.resolve(value.invoiceId)).toBeNull();

    const { resolver, registry } = resolverFor(value);
    registry.setAssetEnabled(ASSET, false);
    expect(resolver.resolve(value.invoiceId)).toBeNull();
  });
});
