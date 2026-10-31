// Authenticated local payment service: the bridge between the console's
// server-owned browser session and the durable payment-operation journal.
//
// This module does not start a server, broadcast a transaction, sign anything,
// touch the Ledger/cap, or trust a browser-declared provider/price. The
// existing console server authenticates the browser and passes an opaque
// ConsoleActionContext; this module maps one context (one authenticated browser
// session) to one payment port/facade. A trusted obligation is read from a
// server-side persisted verified payment request. The browser only supplies an
// obligation id, a preview ref, an opaque reservation id, and the exact
// external-wallet operation for cross-checking.
//
// Default trusted source (restricted local testnet path): a signed local wallet
// deposit intent whose recipient is a receiving address published by this
// node's wallet. The provider identity is that persisted receiving-address
// authorization; no remote P2P request is accepted here until B persists an
// authenticated obligation via the same resolver interface. No unsigned or
// offline-JSON payment can reach reserve.

import { createHash, randomUUID } from "node:crypto";
import { ConsoleInputError, type ConsoleActionContext } from "./console-server.ts";
import {
  EXTERNAL_WALLET_OPERATION_SCHEMA,
  HARD_BLOCKED_MAINNET_CHAIN_IDS,
  PaymentOperationError,
  SENDABLE_TESTNET_CHAIN_IDS,
  erc20TransferCalldata,
  erc20TransferCalldataHash,
  networkRegistryAssetResolver,
  openPaymentOperationJournal,
  paymentOperationDefaultPath,
  type ExternalWalletOperation,
  type PaymentAssetRegistry,
  type PaymentBinding,
  type PaymentIdentityAuthority,
  type PaymentOperationJournal,
  type PaymentOperationPort,
  type PaymentOperationRecord,
  type PaymentReservation,
} from "./payment-operations.ts";
import type { DepositIntent } from "./deposits.ts";
import type { Service } from "./service.ts";
import type { ReceivingAddress, Wallet } from "./wallet.ts";

export const PAYMENT_LOCAL_ACTIONS = [
  "payment-obligation-preview",
  "payment-operation-reserve",
  "payment-operation-mark",
  "payment-operation-hash",
  "payment-operation-unknown",
  "payment-operation-query",
  "payment-operation-pending",
] as const;

export type PaymentLocalAction = (typeof PAYMENT_LOCAL_ACTIONS)[number];

export interface TrustedPaymentObligation {
  /** Opaque server lookup key; equal to binding.invoice for this local source. */
  obligationId: string;
  binding: PaymentBinding;
  source: "local-wallet-intent" | "p2p-authenticated-request";
  verifiedAt: string;
}

/**
 * The only trusted payment-request read path. It must be server-owned and
 * read-only; the browser never supplies the provider/price/recipient fields.
 */
export interface TrustedObligationResolver {
  resolve(obligationId: string): TrustedPaymentObligation | null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX_32 = /^0x[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]{0,77})$/;
const SESSION = /^[0-9a-f]{64}$/;
const PREVIEW = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBLIGATION = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION_FIELDS = [
  "schema",
  "intentHash",
  "account",
  "chainId",
  "assetId",
  "contractAddress",
  "recipientAddress",
  "amountRaw",
  "calldata",
  "calldataHash",
] as const;
const PREVIEW_TTL = 10 * 60 * 1000;
const SESSION_STATE_LIMIT = 32;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ConsoleInputError(`${label} is invalid`);
  }
  return value.trim();
}

function fields(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConsoleInputError("invalid payment action input");
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new ConsoleInputError("unexpected payment action parameter");
  for (const key of allowed) if (!(key in input)) throw new ConsoleInputError(`missing payment action parameter: ${key}`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameBinding(a: PaymentBinding, b: PaymentBinding): boolean {
  return (
    a.invoice === b.invoice &&
    sameAddress(a.consumerAddress, b.consumerAddress) &&
    a.providerIdentityFingerprint === b.providerIdentityFingerprint &&
    a.authorizationGeneration === b.authorizationGeneration &&
    a.intentHash === b.intentHash &&
    a.chainId === b.chainId &&
    a.assetId === b.assetId &&
    sameAddress(a.contractAddress, b.contractAddress) &&
    a.decimals === b.decimals &&
    sameAddress(a.recipientAddress, b.recipientAddress) &&
    a.amountRaw === b.amountRaw &&
    a.calldataHash === b.calldataHash &&
    a.expiresAtMs === b.expiresAtMs
  );
}

function publicPayment(obligation: TrustedPaymentObligation): Record<string, unknown> {
  const b = obligation.binding;
  return Object.freeze({
    invoice: b.invoice,
    providerIdentityFingerprint: b.providerIdentityFingerprint,
    authorizationGeneration: b.authorizationGeneration,
    consumerAddress: b.consumerAddress,
    chainId: b.chainId,
    assetId: b.assetId,
    contractAddress: b.contractAddress,
    decimals: b.decimals,
    recipientAddress: b.recipientAddress,
    amountRaw: b.amountRaw,
    intentHash: b.intentHash,
    expiresAtMs: b.expiresAtMs,
    calldataHash: b.calldataHash,
    source: obligation.source,
  });
}

/** The exact external-wallet operation a trusted binding implies. Server-owned. */
export function expectedOperation(binding: PaymentBinding): ExternalWalletOperation {
  const calldata = erc20TransferCalldata(binding.recipientAddress, binding.amountRaw);
  return Object.freeze({
    schema: EXTERNAL_WALLET_OPERATION_SCHEMA,
    intentHash: binding.intentHash,
    account: binding.consumerAddress,
    chainId: binding.chainId,
    assetId: binding.assetId,
    contractAddress: binding.contractAddress,
    recipientAddress: binding.recipientAddress,
    amountRaw: binding.amountRaw,
    calldata,
    calldataHash: erc20TransferCalldataHash(binding.recipientAddress, binding.amountRaw),
  });
}

function sameOperation(raw: unknown, expected: ExternalWalletOperation): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !(OPERATION_FIELDS as readonly string[]).includes(key))) return false;
  if (value.schema !== expected.schema || value.intentHash !== expected.intentHash) return false;
  if (typeof value.account !== "string" || !sameAddress(value.account, expected.account)) return false;
  if (value.chainId !== expected.chainId || value.assetId !== expected.assetId) return false;
  if (typeof value.contractAddress !== "string" || !sameAddress(value.contractAddress, expected.contractAddress)) return false;
  if (typeof value.recipientAddress !== "string" || !sameAddress(value.recipientAddress, expected.recipientAddress)) return false;
  if (value.amountRaw !== expected.amountRaw) return false;
  if (typeof value.calldata !== "string" || value.calldata.toLowerCase() !== expected.calldata) return false;
  if (typeof value.calldataHash !== "string" || value.calldataHash.toLowerCase() !== expected.calldataHash) return false;
  return true;
}

function publicPending(record: PaymentOperationRecord): Record<string, unknown> {
  return Object.freeze({
    invoice: record.invoice,
    providerIdentityFingerprint: record.providerIdentityFingerprint,
    authorizationGeneration: record.authorizationGeneration,
    consumerAddress: record.consumerAddress,
    chainId: record.chainId,
    assetId: record.assetId,
    contractAddress: record.contractAddress,
    decimals: record.decimals,
    recipientAddress: record.recipientAddress,
    amountRaw: record.amountRaw,
    state: record.state,
    attempt: record.attempt,
    txHash: record.txHash,
    hashes: record.hashes,
    reason: record.reason,
    expiresAtMs: record.expiresAtMs,
    updatedAt: record.updatedAt,
  });
}

/**
 * The canonical console context returns a boolean. Other adapters may throw
 * when inactive and return void when active; only an explicit false is treated
 * as inactive, so a normal void implementation is not falsely rejected.
 */
function contextActive(context: ConsoleActionContext): boolean {
  const result = context.assertActive();
  return result !== false;
}

function requireActive(context: ConsoleActionContext, message: string): void {
  if (!contextActive(context)) throw new ConsoleInputError(message);
}

interface SessionPaymentState {
  obligationId: string;
  previewRef: string;
  previewExpiresAt: number;
  binding: PaymentBinding;
  expected: ExternalWalletOperation;
  port: PaymentOperationPort;
  reservationId: string | null;
  /** Server-owned session liveness; used only to prune dead memory state. */
  active: () => boolean;
}

export interface PaymentLocalServiceOptions {
  service?: Service;
  resolver?: TrustedObligationResolver;
  journalPath?: string;
  assetRegistry?: PaymentAssetRegistry;
  now?: () => number;
  previewTtlMs?: number;
  ownerInstanceId?: string;
  /** Tests only; the core journal accepts only 31337. */
  isolatedTestChains?: readonly number[];
}

/**
 * Default resolver: a signed local wallet deposit intent plus a locally
 * published receiving address. This is a restricted local testnet path, not a
 * remote P2P payment. The provider identity is the persisted receiving-address
 * authorization; a re-registration or a changed/expired/cancelled intent is
 * rejected on every resolve.
 */
export class LocalWalletObligationResolver implements TrustedObligationResolver {
  constructor(
    private readonly service: Service,
    private readonly now: () => number = Date.now,
  ) {}

  resolve(obligationId: string): TrustedPaymentObligation | null {
    try {
      const wallet = this.service.walletForConfiguration();
      const intent = wallet.chainStore().intent(obligationId);
      if (!intent) return null;
      return this.fromIntent(obligationId, wallet, intent);
    } catch {
      return null;
    }
  }

  private fromIntent(obligationId: string, wallet: Wallet, intent: DepositIntent): TrustedPaymentObligation | null {
    if (intent.invoiceId !== obligationId) return null;
    if (intent.status !== "signed" || intent.attributionStatus !== "signed") return null;
    if (!intent.payerAddress || !ADDRESS.test(intent.payerAddress)) return null;
    if (!intent.digest || !HEX_32.test(intent.digest)) return null;
    if (!SENDABLE_TESTNET_CHAIN_IDS.includes(intent.chainId as 97 | 84532)) return null;
    const network = wallet.registryView().network(intent.chainId);
    if (!network?.enabled || network.networkType !== "testnet") return null;
    const asset = wallet.registryView().asset(intent.assetId);
    if (!asset || !asset.enabled || asset.chainId !== intent.chainId) return null;
    if (!sameAddress(asset.contractAddress, intent.tokenContract)) return null;
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) return null;
    if (!UINT.test(intent.expectedAmountRaw) || intent.expectedAmountRaw === "0") return null;
    if (BigInt(intent.expectedAmountRaw) > (1n << 256n) - 1n) return null;

    // The local provider identity is the receiving-address authorization. The
    // intent must name an address this wallet published before the intent was
    // requested; a later re-registration is a new authorization epoch and
    // invalidates the old request rather than creating a second journal key.
    const record: ReceivingAddress | undefined = wallet
      .receivingAddresses()
      .find(
        (row) =>
          row.providerId === intent.providerId &&
          row.chainId === intent.chainId &&
          sameAddress(row.address, intent.recipientAddress),
      );
    if (!record) return null;
    const addedMs = Date.parse(record.addedAt);
    const requestedMs = Date.parse(intent.requestedAt);
    const expiresMs = Date.parse(intent.expiresAt);
    if (!Number.isFinite(addedMs) || !Number.isFinite(requestedMs) || !Number.isFinite(expiresMs)) return null;
    if (addedMs > requestedMs || expiresMs <= this.now()) return null;
    const generation = Math.floor(addedMs / 1000);
    if (!Number.isSafeInteger(generation) || generation < 1) return null;

    const providerIdentityFingerprint = sha256Hex(
      `ohmyaihub.payment.local-provider/v1\n${intent.providerId}\n${intent.chainId}\n${record.address.toLowerCase()}`,
    );
    let calldataHash: string;
    try {
      calldataHash = erc20TransferCalldataHash(intent.recipientAddress, intent.expectedAmountRaw);
    } catch {
      return null;
    }
    return Object.freeze({
      obligationId,
      source: "local-wallet-intent" as const,
      verifiedAt: new Date(this.now()).toISOString(),
      binding: Object.freeze({
        invoice: intent.invoiceId,
        consumerAddress: intent.payerAddress.toLowerCase(),
        providerIdentityFingerprint,
        authorizationGeneration: generation,
        intentHash: intent.digest.toLowerCase(),
        chainId: intent.chainId,
        assetId: asset.assetId,
        contractAddress: asset.contractAddress.toLowerCase(),
        decimals: asset.decimals,
        recipientAddress: intent.recipientAddress.toLowerCase(),
        amountRaw: intent.expectedAmountRaw,
        calldataHash,
        expiresAtMs: expiresMs,
      }),
    });
  }
}

export class PaymentLocalService {
  private readonly resolver: TrustedObligationResolver;
  private readonly service: Service | null;
  private readonly now: () => number;
  private readonly previewTtlMs: number;
  private readonly journalPath: string;
  private readonly assetRegistryOption: PaymentAssetRegistry | null;
  private readonly isolatedTestChains: readonly number[];
  private readonly ownerInstanceId: string;
  private readonly allowedChains: ReadonlySet<number>;
  private readonly sessions = new Map<string, SessionPaymentState>();
  private operationJournal: PaymentOperationJournal | null = null;

  constructor(options: PaymentLocalServiceOptions) {
    this.service = options.service ?? null;
    this.now = options.now ?? Date.now;
    this.resolver = options.resolver ?? (options.service ? new LocalWalletObligationResolver(options.service, this.now) : null) as TrustedObligationResolver;
    if (!this.resolver || (!options.resolver && !options.service)) throw new Error("a trusted obligation resolver or Service is required");
    this.assetRegistryOption = options.assetRegistry ?? null;
    if (!this.assetRegistryOption && !options.service) throw new Error("an asset registry or Service is required");
    const ttl = options.previewTtlMs ?? PREVIEW_TTL;
    this.previewTtlMs = Number.isSafeInteger(ttl) && ttl >= 60_000 && ttl <= 30 * 60_000 ? ttl : PREVIEW_TTL;
    this.journalPath = options.journalPath ?? paymentOperationDefaultPath();
    this.ownerInstanceId = options.ownerInstanceId ?? randomUUID();
    const isolated = [...(options.isolatedTestChains ?? [])];
    if (isolated.some((chain) => chain !== 31337)) throw new Error("isolatedTestChains may only contain 31337");
    this.isolatedTestChains = Object.freeze(isolated);
    this.allowedChains = new Set([...SENDABLE_TESTNET_CHAIN_IDS, ...isolated]);
  }

  close(): void {
    this.operationJournal?.close();
    this.operationJournal = null;
    this.sessions.clear();
  }

  /** Narrow journal access for the built-in wallet executor (trusted binding only). */
  portFor(binding: PaymentBinding): PaymentOperationPort {
    this.assertSendable(binding);
    return this.port(binding);
  }

  private journal(): PaymentOperationJournal {
    if (this.operationJournal) return this.operationJournal;
    const assetRegistry: PaymentAssetRegistry = this.assetRegistryOption ?? {
      resolveSendableAsset: (input) => {
        if (!this.service) return null;
        try {
          return networkRegistryAssetResolver(this.service.walletForConfiguration().registryView()).resolveSendableAsset(input);
        } catch {
          return null;
        }
      },
    };
    const authority: PaymentIdentityAuthority = {
      assertCurrent: (input) => {
        const obligation = this.resolver.resolve(input.invoice);
        if (!obligation) throw new Error("trusted payment obligation is no longer available");
        const b = obligation.binding;
        const mismatched =
          input.invoice !== b.invoice ||
          !sameAddress(input.consumerAddress, b.consumerAddress) ||
          input.providerIdentityFingerprint !== b.providerIdentityFingerprint ||
          input.authorizationGeneration !== b.authorizationGeneration ||
          input.intentHash !== b.intentHash ||
          input.chainId !== b.chainId ||
          input.assetId !== b.assetId ||
          !sameAddress(input.contractAddress, b.contractAddress) ||
          input.decimals !== b.decimals ||
          !sameAddress(input.recipientAddress, b.recipientAddress) ||
          input.amountRaw !== b.amountRaw ||
          input.calldataHash !== b.calldataHash;
        if (mismatched) throw new Error("trusted payment obligation changed");
      },
    };
    this.operationJournal = openPaymentOperationJournal({
      path: this.journalPath,
      ownerInstanceId: this.ownerInstanceId,
      assetRegistry,
      identityAuthority: authority,
      now: this.now,
      isolatedTestChains: this.isolatedTestChains,
    });
    return this.operationJournal;
  }

  private resolve(obligationId: string): TrustedPaymentObligation {
    const obligation = this.resolver.resolve(obligationId);
    if (!obligation) throw new ConsoleInputError("no trusted local payment obligation");
    return obligation;
  }

  private assertSendable(binding: PaymentBinding): void {
    if (binding.chainId === 56 || binding.chainId === 8453 || HARD_BLOCKED_MAINNET_CHAIN_IDS.some((id) => id === binding.chainId)) {
      throw new ConsoleInputError("mainnet payments are disabled");
    }
    if (!this.allowedChains.has(binding.chainId)) throw new ConsoleInputError("this payment chain is not allowed");
    if (!(binding.expiresAtMs > this.now())) throw new ConsoleInputError("the trusted payment request has expired");
    let expectedHash: string;
    try {
      expectedHash = erc20TransferCalldataHash(binding.recipientAddress, binding.amountRaw);
    } catch {
      throw new ConsoleInputError("the trusted payment request has an invalid amount or recipient");
    }
    if (expectedHash !== binding.calldataHash) throw new ConsoleInputError("the trusted payment request has an invalid calldata hash");
    const evidence = this.assetRegistry().resolveSendableAsset({
      chainId: binding.chainId,
      assetId: binding.assetId,
      contractAddress: binding.contractAddress,
      decimals: binding.decimals,
    });
    if (
      !evidence ||
      evidence.chainId !== binding.chainId ||
      evidence.assetId !== binding.assetId ||
      !sameAddress(evidence.contractAddress, binding.contractAddress) ||
      evidence.decimals !== binding.decimals ||
      evidence.networkType !== "testnet"
    ) {
      throw new ConsoleInputError("the trusted payment asset is not currently sendable");
    }
  }

  private assetRegistry(): PaymentAssetRegistry {
    if (this.assetRegistryOption) return this.assetRegistryOption;
    return {
      resolveSendableAsset: (input) => {
        if (!this.service) return null;
        try {
          return networkRegistryAssetResolver(this.service.walletForConfiguration().registryView()).resolveSendableAsset(input);
        } catch {
          return null;
        }
      },
    };
  }

  private port(binding: PaymentBinding): PaymentOperationPort {
    try {
      return this.journal().operationPort(binding);
    } catch (error) {
      if (error instanceof PaymentOperationError) throw new ConsoleInputError(error.message);
      throw error;
    }
  }

  private prune(): void {
    for (const [sessionId, state] of this.sessions) {
      // A dead console session can never use its state again; the journal row
      // persists and remains visible via pending/query. Never evict a live
      // session that still holds a reservation.
      if (!state.active()) {
        this.sessions.delete(sessionId);
        continue;
      }
      if (state.reservationId === null && this.now() >= state.previewExpiresAt) this.sessions.delete(sessionId);
    }
  }

  private requireState(
    context: ConsoleActionContext,
    input: Record<string, unknown>,
    fresh: boolean,
  ): SessionPaymentState {
    const obligationId = text(input.obligationId, "obligationId");
    const previewRef = text(input.previewRef, "previewRef", 64);
    if (!PREVIEW.test(previewRef)) throw new ConsoleInputError("previewRef is invalid");
    const state = this.sessions.get(context.sessionId);
    if (!state || state.obligationId !== obligationId) throw new ConsoleInputError("preview the trusted payment obligation first");
    if (state.previewRef !== previewRef) throw new ConsoleInputError("previewRef does not belong to this session/obligation");
    if (fresh && this.now() >= state.previewExpiresAt) throw new ConsoleInputError("the payment preview expired; preview again");
    return state;
  }

  private revalidate(state: SessionPaymentState): void {
    const current = this.resolve(state.obligationId);
    if (!sameBinding(current.binding, state.binding)) throw new ConsoleInputError("the trusted payment obligation changed; start a new preview");
    this.assertSendable(current.binding);
  }

  private checkOperation(raw: unknown, expected: ExternalWalletOperation): void {
    if (!sameOperation(raw, expected)) throw new ConsoleInputError("the payment operation does not match the trusted obligation");
  }

  private requireReservation(state: SessionPaymentState, input: Record<string, unknown>): string {
    const reservationId = text(input.reservationId, "reservationId", 64);
    if (!PREVIEW.test(reservationId) || state.reservationId === null || reservationId !== state.reservationId) {
      throw new ConsoleInputError("this session does not own that reservation");
    }
    return reservationId;
  }

  async action(name: string, input: Record<string, unknown>, context: ConsoleActionContext | undefined): Promise<unknown> {
    if (
      !context ||
      typeof context.sessionId !== "string" ||
      !SESSION.test(context.sessionId) ||
      typeof context.assertActive !== "function"
    ) {
      throw new ConsoleInputError("an authenticated console session is required");
    }
    requireActive(context, "the console session is no longer active");
    try {
      switch (name) {
        case "payment-obligation-preview": {
          fields(input, ["obligationId"]);
          const obligationId = text(input.obligationId, "obligationId");
          if (!OBLIGATION.test(obligationId)) throw new ConsoleInputError("obligationId is invalid");
          const obligation = this.resolve(obligationId);
          this.assertSendable(obligation.binding);
          const existing = this.sessions.get(context.sessionId);
          if (!existing) {
            this.prune();
            if (this.sessions.size >= SESSION_STATE_LIMIT) {
              throw new ConsoleInputError("too many active payment sessions; complete or wait before starting a new one");
            }
          }
          if (existing && existing.obligationId !== obligationId) {
            throw new ConsoleInputError("one active payment port per session; finish or log out before another obligation");
          }
          if (existing && !sameBinding(existing.binding, obligation.binding)) {
            throw new ConsoleInputError("the trusted payment obligation changed; log out and preview again");
          }
          const previewRef = randomUUID();
          const previewExpiresAt = this.now() + this.previewTtlMs;
          const expected = expectedOperation(obligation.binding);
          const state: SessionPaymentState = {
            obligationId,
            previewRef,
            previewExpiresAt,
            binding: obligation.binding,
            expected,
            port: existing?.port ?? this.port(obligation.binding),
            reservationId: existing?.reservationId ?? null,
            active: () => {
              try {
                return contextActive(context);
              } catch {
                return false;
              }
            },
          };
          this.sessions.set(context.sessionId, state);
          return Object.freeze({
            obligationId,
            previewRef,
            previewExpiresAt: new Date(previewExpiresAt).toISOString(),
            payment: publicPayment(obligation),
          });
        }
        case "payment-operation-reserve": {
          fields(input, ["obligationId", "previewRef", "operation"]);
          const state = this.requireState(context, input, true);
          this.checkOperation(input.operation, state.expected);
          this.revalidate(state);
          const reservation = await state.port.reserve(state.expected);
          requireActive(context, "the console session ended during reserve; no send permit was returned; recover via pending");
          if (reservation.state === "reserved") {
            state.reservationId = reservation.reservationId;
            return reservation;
          }
          // Never hand an opaque reservation id back for a non-reserved row.
          // The approved external adapter fails closed when it is not a
          // non-empty string. Keep the internal state for evidence recording.
          return Object.freeze({ ...reservation, reservationId: null });
        }
        case "payment-operation-mark": {
          fields(input, ["obligationId", "previewRef", "reservationId", "operation"]);
          const state = this.requireState(context, input, true);
          const reservationId = this.requireReservation(state, input);
          this.checkOperation(input.operation, state.expected);
          this.revalidate(state);
          requireActive(context, "the console session is no longer active");
          await state.port.markBroadcasting({ reservationId, operation: state.expected });
          // The journal has committed broadcasting. Re-check after the await: if
          // the session expired/logged out while the gate was running, the
          // external wallet must not receive {ok:true} and must not send.
          requireActive(context, "the console session ended during the send gate; do not send; recover via pending");
          return Object.freeze({ ok: true });
        }
        case "payment-operation-hash": {
          fields(input, ["obligationId", "previewRef", "reservationId", "operation", "hash"]);
          const state = this.requireState(context, input, false);
          const reservationId = this.requireReservation(state, input);
          this.checkOperation(input.operation, state.expected);
          if (typeof input.hash !== "string" || !HEX_32.test(input.hash)) throw new ConsoleInputError("transaction hash is invalid");
          await state.port.recordHash({ reservationId, operation: state.expected, hash: input.hash });
          return Object.freeze({ ok: true });
        }
        case "payment-operation-unknown": {
          fields(input, ["obligationId", "previewRef", "reservationId", "operation", "reason"]);
          const state = this.requireState(context, input, false);
          const reservationId = this.requireReservation(state, input);
          this.checkOperation(input.operation, state.expected);
          const reason =
            typeof input.reason === "string" && input.reason.length <= 64
              ? input.reason
              : typeof input.reason === "number" && Number.isFinite(input.reason)
                ? String(input.reason)
                : "UNKNOWN";
          await state.port.recordUnknown({ reservationId, operation: state.expected, reason });
          return Object.freeze({ ok: true });
        }
        case "payment-operation-query": {
          fields(input, ["obligationId", "operation"]);
          const obligationId = text(input.obligationId, "obligationId");
          if (!OBLIGATION.test(obligationId)) throw new ConsoleInputError("obligationId is invalid");
          const state = this.sessions.get(context.sessionId);
          if (state?.obligationId === obligationId) {
            this.checkOperation(input.operation, state.expected);
            return await state.port.query(state.expected);
          }
          const obligation = this.resolve(obligationId);
          this.assertSendable(obligation.binding);
          const expected = expectedOperation(obligation.binding);
          this.checkOperation(input.operation, expected);
          return await this.port(obligation.binding).query(expected);
        }
        case "payment-operation-pending": {
          fields(input, []);
          return this.journal().pending().map(publicPending);
        }
        default:
          throw new ConsoleInputError("unsupported payment operation");
      }
    } catch (error) {
      if (error instanceof PaymentOperationError) throw new ConsoleInputError(error.message);
      throw error;
    }
  }
}

const owners = new WeakMap<Service, PaymentLocalService>();
/** Additional server-owned obligation sources (e.g. the authenticated P2P store). */
const extraResolvers = new WeakMap<Service, TrustedObligationResolver>();

/**
 * Registers the C P2P authenticated-obligation resolver for this Service. It is
 * consulted before the local intent resolver; both are server-owned and the
 * journal still decides the send permit. Replacing it is idempotent.
 */
export function setPaymentObligationResolver(service: Service, resolver: TrustedObligationResolver | null): void {
  if (resolver) extraResolvers.set(service, resolver);
  else extraResolvers.delete(service);
}

/** The one journal-owning payment service for a Service instance. */
export function paymentLocalServiceFor(service: Service): PaymentLocalService {
  let owner = owners.get(service);
  if (!owner) {
    const local = new LocalWalletObligationResolver(service);
    // Look up the extra source per resolve, so registration order cannot hide it.
    owner = new PaymentLocalService({
      service,
      resolver: { resolve: (id) => extraResolvers.get(service)?.resolve(id) ?? local.resolve(id) },
    });
    owners.set(service, owner);
  }
  return owner;
}

/** A trusted binding gets the journal's operation port; nothing else is exposed. */
export function paymentOperationPortFor(service: Service, binding: PaymentBinding): PaymentOperationPort {
  return paymentLocalServiceFor(service).portFor(binding);
}

/** Production entry: one payment service/journal per Service instance. */
export async function paymentLocalAction(
  service: Service,
  name: string,
  input: Record<string, unknown>,
  context: ConsoleActionContext | undefined,
): Promise<unknown> {
  return paymentLocalServiceFor(service).action(name, input, context);
}
