import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  HARD_BLOCKED_MAINNET_CHAIN_IDS,
  ISOLATED_TEST_CHAIN_ID,
  PaymentOperationError,
  PaymentOperationJournal,
  SENDABLE_TESTNET_CHAIN_IDS,
  erc20TransferCalldata,
  erc20TransferCalldataHash,
  networkRegistryAssetResolver,
  openPaymentOperationJournal,
  paymentIdempotencyKey,
  type ExternalWalletOperation,
  type PaymentAssetRegistry,
  type PaymentBinding,
  type PaymentIdentityAuthority,
  type PaymentOperationErrorCode,
  type PaymentOperationPort,
  type RejectedUnknownReleaseEvidence,
  type UnsentReleaseEvidence,
} from "../src/payment-operations.ts";
import { assetIdOf, defaultRegistry, NetworkRegistry, NETWORK_REGISTRY_VERSION } from "../src/networks.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PAYER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x3d80c477021e3fa568e91c73baec8e806518d9a6";
const OTHER_RECIPIENT = "0x617c2c85e9d45f1e714855fa051ccb8c538200cd";
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const INTENT_HASH = `0x${"ab".repeat(32)}`;
const OTHER_INTENT_HASH = `0x${"cd".repeat(32)}`;
const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const FP = "provider:lab:fp-1";

const dirs: string[] = [];
const journals: PaymentOperationJournal[] = [];

let now = 1_800_000_000_000;
let dir = "";

function tempDir(): string {
  const value = mkdtempSync(join(tmpdir(), "omaih-payops-"));
  dirs.push(value);
  return value;
}

function openJournal(options: {
  dbName?: string;
  ownerInstanceId?: string;
  registry?: PaymentAssetRegistry;
  authority?: PaymentIdentityAuthority;
  isolated?: boolean;
} = {}): PaymentOperationJournal {
  const journal = openPaymentOperationJournal({
    path: join(dir, options.dbName ?? "state/payment-operations.sqlite"),
    ownerInstanceId: options.ownerInstanceId ?? "owner-1",
    assetRegistry: options.registry ?? networkRegistryAssetResolver(testRegistry()),
    identityAuthority: options.authority ?? new TestAuthority(),
    now: () => now,
    ...(options.isolated ? { isolatedTestChains: [ISOLATED_TEST_CHAIN_ID] } : {}),
  });
  journals.push(journal);
  return journal;
}

let cachedRegistry: NetworkRegistry | null = null;
function testRegistry(): NetworkRegistry {
  if (cachedRegistry) return cachedRegistry;
  const registry = defaultRegistry();
  registry.upsertAsset({
    assetId: assetIdOf(97, CONTRACT),
    chainId: 97,
    contractAddress: CONTRACT,
    symbol: "tMock",
    name: "Test Mock",
    decimals: 6,
    issuerType: "mock",
    testnetOnly: true,
    enabled: true,
    pricing: { nanosPerToken: "2000000000000000000", version: "test:97:tMock:v1", kind: "fixed-test-rate", note: "unit test asset; no value" },
  });
  cachedRegistry = registry;
  return registry;
}

function isolatedRegistry(): NetworkRegistry {
  const registry = new NetworkRegistry({
    version: NETWORK_REGISTRY_VERSION,
    networks: [
      {
        chainId: ISOLATED_TEST_CHAIN_ID,
        displayName: "Anvil (isolated test)",
        family: "evm",
        networkType: "testnet",
        rpcEndpoints: ["http://127.0.0.1:8545"],
        blockExplorer: "",
        nativeSymbol: "ETH",
        enabled: true,
        finality: { mode: "confirmations", confirmations: 1, reorgDepth: 0, rationale: "isolated unit test chain" },
        scanIntervalSec: 5,
        maxBlockRange: 2000,
        notes: "test only",
      },
    ],
    assets: [
      {
        assetId: assetIdOf(ISOLATED_TEST_CHAIN_ID, CONTRACT),
        chainId: ISOLATED_TEST_CHAIN_ID,
        contractAddress: CONTRACT,
        symbol: "tLocal",
        name: "Test Local",
        decimals: 6,
        issuerType: "mock",
        testnetOnly: true,
        enabled: true,
        pricing: { nanosPerToken: "1000000000000000000", version: "test:31337:tLocal:v1", kind: "fixed-test-rate", note: "unit test asset; no value" },
      },
    ],
  });
  return registry;
}

class TestAuthority implements PaymentIdentityAuthority {
  readonly accepted = {
    consumerAddress: PAYER,
    providerIdentityFingerprint: FP,
    authorizationGeneration: 7,
  };
  revoked = false;
  last: Record<string, unknown> | null = null;

  assertCurrent(input: Parameters<PaymentIdentityAuthority["assertCurrent"]>[0]): void {
    this.last = input as unknown as Record<string, unknown>;
    if (this.revoked) throw new Error("invoice revoked");
    if (input.consumerAddress !== this.accepted.consumerAddress) throw new Error("consumer changed");
    if (input.providerIdentityFingerprint !== this.accepted.providerIdentityFingerprint) throw new Error("provider identity changed");
    if (input.authorizationGeneration !== this.accepted.authorizationGeneration) throw new Error("authorization generation changed");
  }
}

function binding(over: Partial<PaymentBinding> = {}): PaymentBinding {
  const base: PaymentBinding = {
    invoice: "inv_pay_001",
    consumerAddress: PAYER,
    providerIdentityFingerprint: FP,
    authorizationGeneration: 7,
    intentHash: INTENT_HASH,
    chainId: 97,
    assetId: assetIdOf(97, CONTRACT),
    contractAddress: CONTRACT,
    decimals: 6,
    recipientAddress: RECIPIENT,
    amountRaw: "1000001",
    calldataHash: erc20TransferCalldataHash(RECIPIENT, "1000001"),
    expiresAtMs: now + 600_000,
  };
  const merged = { ...base, ...over };
  if (!("calldataHash" in over)) {
    merged.calldataHash = erc20TransferCalldataHash(merged.recipientAddress, merged.amountRaw);
  }
  if (!("assetId" in over) && merged.chainId === 97) merged.assetId = assetIdOf(merged.chainId, merged.contractAddress);
  if (!("assetId" in over) && merged.chainId === ISOLATED_TEST_CHAIN_ID) merged.assetId = assetIdOf(merged.chainId, merged.contractAddress);
  return merged;
}

function operationFrom(value: PaymentBinding, over: Partial<ExternalWalletOperation> = {}): ExternalWalletOperation {
  const calldata = erc20TransferCalldata(value.recipientAddress, value.amountRaw);
  return {
    schema: "ohmyaihub.external-wallet.operation/v1",
    intentHash: value.intentHash,
    account: value.consumerAddress,
    chainId: value.chainId,
    assetId: value.assetId,
    contractAddress: value.contractAddress,
    recipientAddress: value.recipientAddress,
    amountRaw: value.amountRaw,
    calldata,
    calldataHash: erc20TransferCalldataHash(value.recipientAddress, value.amountRaw),
    ...over,
  };
}

function operation(over: Partial<ExternalWalletOperation> = {}): ExternalWalletOperation {
  return operationFrom(binding(), over);
}

/** A self-consistent operation for a *different* payment tuple. */
function tamperedOperation(value: PaymentBinding, patch: { recipientAddress?: string; amountRaw?: string; intentHash?: string | null }): ExternalWalletOperation {
  const recipient = patch.recipientAddress ?? value.recipientAddress;
  const amount = patch.amountRaw ?? value.amountRaw;
  return {
    schema: "ohmyaihub.external-wallet.operation/v1",
    intentHash: patch.intentHash === undefined ? value.intentHash : patch.intentHash,
    account: value.consumerAddress,
    chainId: value.chainId,
    assetId: value.assetId,
    contractAddress: value.contractAddress,
    recipientAddress: recipient,
    amountRaw: amount,
    calldata: erc20TransferCalldata(recipient, amount),
    calldataHash: erc20TransferCalldataHash(recipient, amount),
  };
}

async function expectCode(fn: () => unknown | Promise<unknown>, code: PaymentOperationErrorCode): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentOperationError);
    expect((error as PaymentOperationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

function expectSyncCode(fn: () => unknown, code: PaymentOperationErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentOperationError);
    expect((error as PaymentOperationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

async function reservedPort(j: PaymentOperationJournal, value = binding()): Promise<{ port: PaymentOperationPort; op: ExternalWalletOperation; reservationId: string }> {
  const port = j.operationPort(value);
  const op = operationFrom(value);
  const reservation = await port.reserve(op);
  expect(reservation.state).toBe("reserved");
  return { port, op, reservationId: reservation.reservationId };
}

beforeEach(() => {
  dir = tempDir();
  now = 1_800_000_000_000;
});

afterEach(() => {
  while (journals.length) {
    try {
      journals.pop()!.close();
    } catch {
      /* already closed by a test */
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  cachedRegistry = null;
});

/* ------------------------------------------------------------------ */
/* The hard chain gate                                                 */
/* ------------------------------------------------------------------ */

describe("hard testnet chain gate", () => {
  test("the exported allowlist is exactly 97/84532 and mainnet is listed as blocked", () => {
    expect([...SENDABLE_TESTNET_CHAIN_IDS]).toEqual([97, 84532]);
    expect([...HARD_BLOCKED_MAINNET_CHAIN_IDS]).toEqual([56, 8453]);
  });

  test("56 and 8453 are refused before any row can be written", () => {
    const j = openJournal();
    for (const chainId of [56, 8453]) {
      expectSyncCode(
        () => j.operationPort(binding({ chainId, assetId: assetIdOf(chainId, CONTRACT) })),
        "PAYMENT_OPERATION_MAINNET_BLOCKED",
      );
    }
    const db = new Database(j.path);
    expect((db.query("SELECT COUNT(*) AS n FROM payment_operations").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("an unknown chain is refused", () => {
    const j = openJournal();
    expectSyncCode(
      () => j.operationPort(binding({ chainId: 1, assetId: assetIdOf(1, CONTRACT) })),
      "PAYMENT_OPERATION_CHAIN_NOT_ALLOWED",
    );
  });

  test("31337 needs the explicit isolated-test option and its own registry", () => {
    const defaultJournal = openJournal();
    expectSyncCode(
      () => defaultJournal.operationPort(binding({ chainId: ISOLATED_TEST_CHAIN_ID, assetId: assetIdOf(ISOLATED_TEST_CHAIN_ID, CONTRACT) })),
      "PAYMENT_OPERATION_CHAIN_NOT_ALLOWED",
    );
    expect(defaultJournal.chainIds()).toEqual([97, 84532]);

    const isolated = openJournal({
      dbName: "isolated/payment.sqlite",
      registry: networkRegistryAssetResolver(isolatedRegistry()),
      isolated: true,
    });
    expect(isolated.chainIds()).toEqual([97, ISOLATED_TEST_CHAIN_ID, 84532]);
    const value = binding({ chainId: ISOLATED_TEST_CHAIN_ID, assetId: assetIdOf(ISOLATED_TEST_CHAIN_ID, CONTRACT) });
    expect(() => isolated.operationPort(value)).not.toThrow();
  });

  test("the isolated option cannot smuggle in any other chain", () => {
    expectSyncCode(
      () =>
        openPaymentOperationJournal({
          path: join(dir, "bad/payment.sqlite"),
          ownerInstanceId: "owner-x",
          assetRegistry: networkRegistryAssetResolver(isolatedRegistry()),
          identityAuthority: new TestAuthority(),
          isolatedTestChains: [ISOLATED_TEST_CHAIN_ID, 56],
        }),
      "PAYMENT_OPERATION_CHAIN_NOT_ALLOWED",
    );
    // A mainnet id is still blocked on port creation even with the isolated option.
    const j = openJournal({ isolated: true, registry: networkRegistryAssetResolver(isolatedRegistry()) });
    expectSyncCode(
      () => j.operationPort(binding({ chainId: 56, assetId: assetIdOf(56, CONTRACT) })),
      "PAYMENT_OPERATION_MAINNET_BLOCKED",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Atomic claim / crash recovery                                      */
/* ------------------------------------------------------------------ */

describe("atomic single-winner claim", () => {
  test("one journal, two ports: only the first reserve gets reserved", async () => {
    const j = openJournal();
    const portA = j.operationPort(binding());
    const portB = j.operationPort(binding());
    const op = operation();
    const first = await portA.reserve(op);
    expect(first).toMatchObject({ state: "reserved", blocked: false, attempt: 1 });
    const second = await portB.reserve(op);
    expect(second).toMatchObject({ state: "claimed", blocked: true, attempt: 1 });
    expect(second.reservationId).toBe(first.reservationId);
    const db = new Database(j.path);
    expect((db.query("SELECT COUNT(*) AS n FROM payment_operations").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("two real journal instances on the same SQLite file: only one winner", async () => {
    const j1 = openJournal({ ownerInstanceId: "owner-1" });
    const j2 = openJournal({ ownerInstanceId: "owner-1" });
    const port1 = j1.operationPort(binding());
    const port2 = j2.operationPort(binding());
    const op = operation();
    const first = await port1.reserve(op);
    const second = await port2.reserve(op);
    expect(first.state).toBe("reserved");
    expect(second.state).toBe("claimed");
    expect(second.reservationId).toBe(first.reservationId);
  });

  test("a new preview/session with the same intent cannot reserve again", async () => {
    const j = openJournal();
    const first = await reservedPort(j);
    await first.port.markBroadcasting({ reservationId: first.reservationId, operation: first.op });
    // A new session/journal instance after a reload.
    const reopened = openJournal({ dbName: "state/payment-operations.sqlite" });
    const port = reopened.operationPort(binding());
    const reservation = await port.reserve(operation());
    expect(reservation.state).toBe("broadcasting");
    expect(reservation.blocked).toBe(true);
    expect(reservation.reservationId).toBe(first.reservationId);
    await expectCode(
      () => port.markBroadcasting({ reservationId: first.reservationId, operation: operation() }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );
  });

  test("a preview UUID is not accepted as part of the operation", async () => {
    const j = openJournal();
    const port = j.operationPort(binding());
    const withUuid = { ...operation(), previewId: crypto.randomUUID() } as unknown as ExternalWalletOperation;
    await expectCode(() => port.reserve(withUuid), "PAYMENT_OPERATION_INVALID_ARGUMENT");
    // The UUID variant must not have created a second row under a different key.
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })).toBeNull();
  });

  test("the stable key is invoice+consumer, not a preview UUID or intent hash", () => {
    const a = paymentIdempotencyKey({ invoice: "inv_pay_001", consumerAddress: PAYER });
    const b = paymentIdempotencyKey({ invoice: "inv_pay_001", consumerAddress: PAYER.toUpperCase().replace("0X", "0x") });
    expect(a).toBe(b);
    const c = paymentIdempotencyKey({ invoice: "inv_pay_002", consumerAddress: PAYER });
    expect(c).not.toBe(a);
  });

  test("crash after markBroadcasting leaves a non-sendable row after reopen", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await port.markBroadcasting({ reservationId, operation: op });
    j.close(); // the crash: no send, no hash, no unknown

    const reopened = openJournal({ ownerInstanceId: "owner-2" });
    const reservation = await reopened.operationPort(binding()).reserve(op);
    expect(reservation.state).toBe("broadcasting");
    expect(reservation.blocked).toBe(true);
    expect(reservation.hash).toBeNull();
    const queried = await reopened.operationPort(binding()).query(op);
    expect(queried).toMatchObject({ state: "broadcasting", hash: null, retryable: false });
    await expectCode(
      () => reopened.operationPort(binding()).markBroadcasting({ reservationId, operation: op }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );
  });

  test("a reserved row is not re-claimable without an evidenced release", async () => {
    const j = openJournal();
    const { reservationId } = await reservedPort(j);
    const again = await openJournal({ ownerInstanceId: "owner-2" }).operationPort(binding()).reserve(operation());
    expect(again.state).toBe("claimed");
    expect(again.reservationId).toBe(reservationId);
  });

  test("an owner-restarted reservation can be released only with the exact reservation and previous owner", async () => {
    const before = openJournal({ ownerInstanceId: "owner-old" });
    const { reservationId } = await reservedPort(before);
    before.close();

    const after = openJournal({ ownerInstanceId: "owner-new" });
    const record = after.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    const evidence: UnsentReleaseEvidence = {
      basis: "owner-restarted-before-broadcast",
      confirmedNoBroadcast: true,
      observedAt: new Date(now).toISOString(),
      reference: "boot:owner-old-ended",
      previousOwnerInstanceId: "owner-old",
    };
    expectSyncCode(
      () => after.releaseUnsentReservation({ idemKey: record.idemKey, reservationId: "wrong", evidence }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );
    expectSyncCode(
      () => after.releaseUnsentReservation({ idemKey: record.idemKey, reservationId, evidence: { ...evidence, previousOwnerInstanceId: "owner-new" } }),
      "PAYMENT_OPERATION_RELEASE_REFUSED",
    );
    const released = after.releaseUnsentReservation({ idemKey: record.idemKey, reservationId, evidence });
    expect(released.state).toBe("released");
    expect(released.txHash).toBeNull();
    expect(released.reason).toContain("OWNER_RESTARTED");

    const reclaimed = await after.operationPort(binding()).reserve(operation());
    expect(reclaimed.state).toBe("reserved");
    expect(reclaimed.attempt).toBe(2);
    expect(reclaimed.reservationId).not.toBe(reservationId);
    // The old reservation is no longer a send permit.
    await expectCode(
      () => after.operationPort(binding()).markBroadcasting({ reservationId, operation: operation() }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Send gate and state transitions                                    */
/* ------------------------------------------------------------------ */

describe("send gate and durable state machine", () => {
  test("markBroadcasting checks reservationId and the exact operation, then persists", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await expectCode(
      () => port.markBroadcasting({ reservationId: "not-the-claim", operation: op }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );
    await expectCode(
      () => port.markBroadcasting({ reservationId, operation: tamperedOperation(binding(), { amountRaw: "2000002" }) }),
      "PAYMENT_OPERATION_PAYLOAD_MISMATCH",
    );
    // Still not broadcasting after both refusals.
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("reserved");

    await port.markBroadcasting({ reservationId, operation: op });
    // A second journal instance can see it immediately: the commit is durable.
    const observer = new Database(j.path);
    expect((observer.query("SELECT state FROM payment_operations WHERE reservation_id = ?").get(reservationId) as { state: string }).state).toBe("broadcasting");
    observer.close();
    await expectCode(
      () => port.markBroadcasting({ reservationId, operation: op }),
      "PAYMENT_OPERATION_NOT_RESERVED",
    );
  });

  test("recordHash stores the first hash, is idempotent for the same hash, and conflicts on another", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await port.markBroadcasting({ reservationId, operation: op });
    await expectCode(() => port.recordHash({ reservationId, operation: op, hash: "0x1234" }), "PAYMENT_OPERATION_INVALID_ARGUMENT");
    await expectCode(() => port.recordHash({ reservationId: "other", operation: op, hash: HASH_A }), "PAYMENT_OPERATION_RESERVATION_MISMATCH");

    await port.recordHash({ reservationId, operation: op, hash: HASH_A });
    await port.recordHash({ reservationId, operation: op, hash: HASH_A }); // idempotent
    const record = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    expect(record.state).toBe("broadcast");
    expect(record.txHash).toBe(HASH_A);
    await expectCode(() => port.recordHash({ reservationId, operation: op, hash: HASH_B }), "PAYMENT_OPERATION_HASH_CONFLICT");

    // A late unknown never erases the hash.
    await port.recordUnknown({ reservationId, operation: op, reason: "TIMEOUT" });
    const after = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    expect(after.state).toBe("broadcast");
    expect(after.txHash).toBe(HASH_A);

    // No new send permit.
    expect((await port.reserve(op)).state).toBe("broadcast");
    await expectCode(() => port.markBroadcasting({ reservationId, operation: op }), "PAYMENT_OPERATION_NOT_RESERVED");
  });

  test("unknown is terminal for sending; a known hash can still recover it", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordUnknown({ reservationId, operation: op, reason: "RPC_500" });
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("unknown");

    const reopened = openJournal();
    const retry = await reopened.operationPort(binding()).reserve(op);
    expect(retry.state).toBe("unknown");
    expect(retry.blocked).toBe(true);
    await expectCode(
      () => reopened.operationPort(binding()).markBroadcasting({ reservationId, operation: op }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );

    // A hash found later is evidence, not a resend: it upgrades unknown→broadcast.
    await reopened.operationPort(binding()).recordHash({ reservationId, operation: op, hash: HASH_A });
    const record = reopened.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    expect(record.state).toBe("broadcast");
    expect(record.txHash).toBe(HASH_A);
    expect(record.recoveredFromUnknown).toBe(true);
  });

  test("recordUnknown without a broadcast mark is refused and leaves the claim intact", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await expectCode(
      () => port.recordUnknown({ reservationId, operation: op, reason: "TIMEOUT" }),
      "PAYMENT_OPERATION_NOT_BROADCASTING",
    );
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("reserved");
    // The original claim can still be marked normally.
    await port.markBroadcasting({ reservationId, operation: op });
  });

  test("a wallet rejection is recorded as unknown, and needs evidence to be released", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordUnknown({ reservationId, operation: op, reason: "USER_REJECTED" });
    const record = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    expect(record.state).toBe("unknown");
    expect(record.reason).toBe("USER_REJECTED");

    const valid: RejectedUnknownReleaseEvidence = {
      basis: "wallet-user-rejection",
      providerCode: "USER_REJECTED",
      confirmedNoBroadcast: true,
      userConfirmedRetry: true,
      noBroadcastObservation: { method: "chain-nonce", observedAt: new Date(now).toISOString(), reference: "nonce-observation-7" },
    };
    expectSyncCode(
      () => j.releaseRejectedUnknown({ idemKey: record.idemKey, reservationId, evidence: { ...valid, userConfirmedRetry: false as true } }),
      "PAYMENT_OPERATION_RELEASE_REFUSED",
    );
    expectSyncCode(
      () => j.releaseRejectedUnknown({ idemKey: record.idemKey, reservationId, evidence: { ...valid, providerCode: "4001", noBroadcastObservation: { ...valid.noBroadcastObservation, method: "guessed" as "chain-nonce" } } }),
      "PAYMENT_OPERATION_RELEASE_REFUSED",
    );
    expectSyncCode(
      () => j.releaseRejectedUnknown({ idemKey: record.idemKey, reservationId: "other", evidence: valid }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );

    const released = j.releaseRejectedUnknown({ idemKey: record.idemKey, reservationId, evidence: valid });
    expect(released.state).toBe("released");
    expect(released.reason).toContain("WALLET_REJECTION");

    const reclaimed = await port.reserve(op);
    expect(reclaimed.state).toBe("reserved");
    expect(reclaimed.attempt).toBe(2);
    expect(reclaimed.reservationId).not.toBe(reservationId);
    await expectCode(
      () => port.markBroadcasting({ reservationId, operation: op }),
      "PAYMENT_OPERATION_RESERVATION_MISMATCH",
    );
  });

  test("timeouts, 500s and invalid hashes are never released by the rejection path", async () => {
    for (const reason of ["TIMEOUT", "RPC_500", "INVALID_TX_HASH", "WALLET_ERROR"]) {
      const j = openJournal({ dbName: `state/${reason}.sqlite` });
      const { port, op, reservationId } = await reservedPort(j);
      await port.markBroadcasting({ reservationId, operation: op });
      await port.recordUnknown({ reservationId, operation: op, reason });
      const record = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
      expectSyncCode(
        () =>
          j.releaseRejectedUnknown({
            idemKey: record.idemKey,
            reservationId,
            evidence: {
              basis: "wallet-user-rejection",
              providerCode: "USER_REJECTED",
              confirmedNoBroadcast: true,
              userConfirmedRetry: true,
              noBroadcastObservation: { method: "chain-nonce", observedAt: new Date(now).toISOString(), reference: "nonce" },
            },
          }),
        "PAYMENT_OPERATION_RELEASE_REFUSED",
      );
      expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("unknown");
    }
  });

  test("4001 and USER_REJECTED are the same rejection class for release", async () => {
    const j = openJournal({ dbName: "state/rejection-code.sqlite" });
    const value = binding({ invoice: "inv_rejection_code" });
    const { port, op, reservationId } = await reservedPort(j, value);
    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordUnknown({ reservationId, operation: op, reason: 4001 });
    const record = j.lookup({ invoice: "inv_rejection_code", consumerAddress: PAYER })!;
    expect(record.reason).toBe("4001");
    const released = j.releaseRejectedUnknown({
      idemKey: record.idemKey,
      reservationId,
      evidence: {
        basis: "wallet-user-rejection",
        providerCode: "USER_REJECTED",
        confirmedNoBroadcast: true,
        userConfirmedRetry: true,
        noBroadcastObservation: { method: "chain-nonce", observedAt: new Date(now).toISOString(), reference: "nonce" },
      },
    });
    expect(released.state).toBe("released");
  });

  test("a hash cannot be recorded before the send gate, and an unknown reason is sanitized", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await expectCode(() => port.recordHash({ reservationId, operation: op, hash: HASH_A }), "PAYMENT_OPERATION_NOT_BROADCASTING");
    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordUnknown({ reservationId, operation: op, reason: "seed words: alpha beta / secret" });
    const record = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    expect(record.reason).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(record.reason).not.toContain(" ");
    expect(record.reason).not.toContain("seed words");
  });
});

/* ------------------------------------------------------------------ */
/* Tamper, quote change, expiry, identity, asset                       */
/* ------------------------------------------------------------------ */

describe("verified intent binding and negative cases", () => {
  test("every operation tuple field is bound to the verified intent", async () => {
    const j = openJournal();
    const value = binding();
    const port = j.operationPort(value);
    const base = operationFrom(value);

    const cases: ExternalWalletOperation[] = [
      { ...base, account: OTHER_RECIPIENT },
      { ...base, chainId: 84532, assetId: assetIdOf(84532, CONTRACT) },
      { ...base, assetId: assetIdOf(97, OTHER_RECIPIENT), contractAddress: OTHER_RECIPIENT },
      { ...base, contractAddress: OTHER_RECIPIENT, assetId: assetIdOf(97, OTHER_RECIPIENT) },
      tamperedOperation(value, { recipientAddress: OTHER_RECIPIENT }),
      tamperedOperation(value, { amountRaw: "2000002" }),
      tamperedOperation(value, { intentHash: OTHER_INTENT_HASH }),
    ];
    for (const candidate of cases) {
      await expectCode(() => port.reserve(candidate), "PAYMENT_OPERATION_PAYLOAD_MISMATCH");
    }
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })).toBeNull();
  });

  test("malformed operations and bindings fail closed", async () => {
    const j = openJournal();
    const port = j.operationPort(binding());
    const base = operation();
    await expectCode(() => port.reserve({ ...base, schema: "v2" }), "PAYMENT_OPERATION_INVALID_OPERATION");
    await expectCode(() => port.reserve({ ...base, calldata: "0x1234" }), "PAYMENT_OPERATION_INVALID_OPERATION");
    await expectCode(() => port.reserve({ ...base, calldata: base.calldata.replace(/.$/, (c) => (c === "0" ? "1" : "0")) }), "PAYMENT_OPERATION_INVALID_OPERATION");
    await expectCode(() => port.reserve({ ...base, amountRaw: 1000001 as unknown as string }), "PAYMENT_OPERATION_INVALID_BINDING");
    expectSyncCode(() => j.operationPort(binding({ recipientAddress: "0x" + "0".repeat(40) })), "PAYMENT_OPERATION_INVALID_BINDING");
    expectSyncCode(() => j.operationPort(binding({ decimals: 37 })), "PAYMENT_OPERATION_INVALID_BINDING");
    expectSyncCode(() => j.operationPort(binding({ calldataHash: HASH_A })), "PAYMENT_OPERATION_INVALID_BINDING");
    expectSyncCode(
      () => j.operationPort({ ...binding(), signature: "0xdeadbeef" } as unknown as PaymentBinding),
      "PAYMENT_OPERATION_INVALID_ARGUMENT",
    );
  });

  test("a changed quote for the same invoice is not a new operation", async () => {
    const j = openJournal();
    await reservedPort(j);
    const changedQuote = binding({ amountRaw: "9000009" });
    const port = j.operationPort(changedQuote);
    await expectCode(() => port.reserve(operationFrom(changedQuote)), "PAYMENT_OPERATION_PAYLOAD_MISMATCH");
    // The original row is untouched.
    const record = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    expect(record.amountRaw).toBe("1000001");
    expect(record.state).toBe("reserved");
  });

  test("a different invoice is a different verified obligation", async () => {
    const j = openJournal();
    const first = await reservedPort(j);
    const secondValue = binding({ invoice: "inv_pay_002" });
    const second = await j.operationPort(secondValue).reserve(operationFrom(secondValue));
    expect(second.state).toBe("reserved");
    expect(second.reservationId).not.toBe(first.reservationId);
  });

  test("an expired quote cannot be claimed or sent", async () => {
    const value = binding({ expiresAtMs: now + 1000 });
    const j = openJournal();
    const port = j.operationPort(value);
    const op = operationFrom(value);
    const reservation = await port.reserve(op);
    expect(reservation.state).toBe("reserved");

    now += 1001;
    await expectCode(() => port.markBroadcasting({ reservationId: reservation.reservationId, operation: op }), "PAYMENT_OPERATION_EXPIRED");
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("reserved");

    const fresh = binding({ invoice: "inv_expired_new", expiresAtMs: now - 1 });
    await expectCode(() => j.operationPort(fresh).reserve(operationFrom(fresh)), "PAYMENT_OPERATION_EXPIRED");
  });

  test("a revoked or replaced identity/authorization epoch stops the send gate", async () => {
    const authority = new TestAuthority();
    const registry = networkRegistryAssetResolver(testRegistry());
    const j = openJournal({ authority, registry });
    const { port, op, reservationId } = await reservedPort(j);

    authority.revoked = true;
    await expectCode(() => port.markBroadcasting({ reservationId, operation: op }), "PAYMENT_OPERATION_IDENTITY_STALE");
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("reserved");

    authority.revoked = false;
    authority.accepted.providerIdentityFingerprint = "provider:lab:fp-2";
    await expectCode(() => port.markBroadcasting({ reservationId, operation: op }), "PAYMENT_OPERATION_IDENTITY_STALE");
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("reserved");

    // A new reservation for a new invoice with a stale fingerprint is refused too.
    authority.accepted.providerIdentityFingerprint = "provider:lab:fp-1";
    const fresh = binding({ invoice: "inv_revoked", providerIdentityFingerprint: "provider:lab:fp-2" });
    await expectCode(() => j.operationPort(fresh).reserve(operationFrom(fresh)), "PAYMENT_OPERATION_IDENTITY_STALE");

    // Restoring the accepted identity lets the original claim continue.
    await port.markBroadcasting({ reservationId, operation: op });
  });

  test("a disabled or unregistered asset is not trusted, even with a matching tuple", async () => {
    const registry = defaultRegistry();
    registry.upsertAsset({
      assetId: assetIdOf(97, CONTRACT),
      chainId: 97,
      contractAddress: CONTRACT,
      symbol: "tMock",
      name: "Test Mock",
      decimals: 6,
      issuerType: "mock",
      testnetOnly: true,
      enabled: true,
      pricing: { nanosPerToken: "1", version: "test", kind: "fixed-test-rate", note: "test" },
    });
    const j = openJournal({ registry: networkRegistryAssetResolver(registry) });
    const { port, op, reservationId } = await reservedPort(j);

    registry.setAssetEnabled(assetIdOf(97, CONTRACT), false);
    await expectCode(() => port.markBroadcasting({ reservationId, operation: op }), "PAYMENT_OPERATION_ASSET_NOT_TRUSTED");
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("reserved");

    const unknown = binding({ invoice: "inv_unknown_asset", contractAddress: OTHER_RECIPIENT, assetId: assetIdOf(97, OTHER_RECIPIENT) });
    await expectCode(() => j.operationPort(unknown).reserve(operationFrom(unknown)), "PAYMENT_OPERATION_ASSET_NOT_TRUSTED");
  });

  test("a closed journal cannot be used as a send permit", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    j.close();
    await expectCode(() => port.markBroadcasting({ reservationId, operation: op }), "PAYMENT_OPERATION_CLOSED");

    const reopened = openJournal();
    expect(reopened.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.state).toBe("reserved");
  });

  test("a CAS loss (another service released the claim) prevents the send", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    const record = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    j.releaseUnsentReservation({
      idemKey: record.idemKey,
      reservationId,
      evidence: {
        basis: "service-recovered-unsent",
        confirmedNoBroadcast: true,
        observedAt: new Date(now).toISOString(),
        reference: "confirm-flow-failed-before-send",
      },
    });
    await expectCode(() => port.markBroadcasting({ reservationId, operation: op }), "PAYMENT_OPERATION_NOT_RESERVED");
  });
});

/* ------------------------------------------------------------------ */
/* Query / recovery surface                                            */
/* ------------------------------------------------------------------ */

describe("recovery queries", () => {
  test("query, lookup and pending expose the known hash and never a send permit", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    const key = j.idempotencyKeyOf({ invoice: "inv_pay_001", consumerAddress: PAYER });
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.idemKey).toBe(key);
    expect(j.lookupByIdemKey(key)!.reservationId).toBe(reservationId);
    expect(j.pending().map((row) => row.state)).toEqual(["reserved"]);

    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordHash({ reservationId, operation: op, hash: HASH_A });
    expect(j.pending()).toEqual([]);

    const queried = await port.query(op);
    expect(queried).toMatchObject({ state: "broadcast", hash: HASH_A, retryable: false });
    // A different tuple is not this operation.
    expect(await port.query(tamperedOperation(binding(), { amountRaw: "2" }))).toBeNull();
    const otherInvoice = binding({ invoice: "other_invoice" });
    expect(await j.operationPort(otherInvoice).query(operationFrom(otherInvoice))).toBeNull();
  });

  test("an unknown row stays visible for the Service to recover by hash", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordUnknown({ reservationId, operation: op, reason: "RPC_500" });

    const pending = j.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state: "unknown", txHash: null, reason: "RPC_500", invoice: "inv_pay_001" });
    expect(await port.query(op)).toMatchObject({ state: "unknown", hash: null, retryable: false });
    // The Service can hand the invoice to a chain lookup; no resend API exists.
    expect(j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!.reservationId).toBe(reservationId);
  });
});

/* ------------------------------------------------------------------ */
/* Storage safety                                                     */
/* ------------------------------------------------------------------ */

describe("local storage safety", () => {
  test("the database is 0600 in a 0700 directory with WAL and synchronous=FULL", () => {
    const j = openJournal();
    const diagnostics = j.diagnostics();
    expect(diagnostics.journalMode).toBe("wal");
    expect(diagnostics.synchronous).toBe(2); // FULL
    expect(diagnostics.foreignKeys).toBe(1);
    if (process.platform !== "win32") {
      expect(diagnostics.fileMode).toBe(0o600);
      expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    }
  });

  test("the journal stores no calldata, signature or raw evidence reference", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordUnknown({ reservationId, operation: op, reason: "USER_REJECTED" });
    const record = j.lookup({ invoice: "inv_pay_001", consumerAddress: PAYER })!;
    j.releaseRejectedUnknown({
      idemKey: record.idemKey,
      reservationId,
      evidence: {
        basis: "wallet-user-rejection",
        providerCode: "USER_REJECTED",
        confirmedNoBroadcast: true,
        userConfirmedRetry: true,
        noBroadcastObservation: {
          method: "chain-nonce",
          observedAt: new Date(now).toISOString(),
          reference: "SECRET-REFERENCE-DO-NOT-STORE",
        },
      },
    });
    const raw = readFileSync(j.path).toString("utf8");
    expect(raw).not.toContain("SECRET-REFERENCE-DO-NOT-STORE");
    expect(raw).not.toContain(op.calldata);
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain("privateKey");
  });

  test("the audit table records transitions without payment secrets", async () => {
    const j = openJournal();
    const { port, op, reservationId } = await reservedPort(j);
    await port.markBroadcasting({ reservationId, operation: op });
    await port.recordUnknown({ reservationId, operation: op, reason: "TIMEOUT" });
    const db = new Database(j.path);
    const events = db.query("SELECT event, detail FROM payment_operation_events ORDER BY id").all() as { event: string; detail: string }[];
    db.close();
    expect(events.map((row) => row.event)).toEqual(["claimed", "broadcasting", "unknown"]);
    for (const row of events) {
      expect(row.detail).not.toContain(op.calldata);
      expect(row.detail.length).toBeLessThanOrEqual(512);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Real multi-process races                                           */
/* ------------------------------------------------------------------ */

const RACE_CHILD = join(import.meta.dir, "support", "payment-operation-race-child.ts");

async function runRaceChild(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, RACE_CHILD, JSON.stringify(payload)], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`race child failed (${code}): ${stderr.slice(0, 800)}`);
  try {
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  } catch {
    throw new Error(`race child produced no JSON: ${stdout.slice(0, 800)} ${stderr.slice(0, 800)}`);
  }
}

describe("real SQLite concurrency across processes", () => {
  test("four processes claim and mark the same intent: exactly one send permit", async () => {
    const dbPath = join(dir, "race", "payment-operations.sqlite");
    const value = binding();
    const op = operationFrom(value);
    const startAt = Date.now() + 700;
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runRaceChild({
          dbPath,
          ownerInstanceId: `race-owner-${index}`,
          binding: value,
          operation: op,
          startAt,
          nowMs: now,
          mode: "reserve-and-mark",
        }),
      ),
    );
    const permitted = results.filter((result) => result.marked === true);
    expect(permitted).toHaveLength(1);
    const reserveStates = results.map((result) => result.reserveState);
    expect(reserveStates.filter((state) => state === "reserved")).toHaveLength(1);
    expect(reserveStates.every((state) => state === "reserved" || state === "claimed" || state === "broadcasting")).toBe(true);

    const db = new Database(dbPath);
    const rows = db.query("SELECT state, reservation_id FROM payment_operations").all() as { state: string; reservation_id: string }[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("broadcasting");
  }, 30_000);

  test("concurrent recordHash/recordUnknown keep one hash and never leave unknown after a hash", async () => {
    const dbPath = join(dir, "race2", "payment-operations.sqlite");
    const value = binding();
    const op = operationFrom(value);
    const j = openJournal({ dbName: "race2/payment-operations.sqlite" });
    const port = j.operationPort(value);
    const reservation = await port.reserve(op);
    await port.markBroadcasting({ reservationId: reservation.reservationId, operation: op });
    j.close();

    const startAt = Date.now() + 700;
    const results = await Promise.all([
      runRaceChild({ dbPath, ownerInstanceId: "r-h1", binding: value, operation: op, reservationId: reservation.reservationId, startAt, nowMs: now, mode: "record-hash", hash: HASH_A }),
      runRaceChild({ dbPath, ownerInstanceId: "r-h2", binding: value, operation: op, reservationId: reservation.reservationId, startAt, nowMs: now, mode: "record-hash", hash: HASH_B }),
      runRaceChild({ dbPath, ownerInstanceId: "r-u", binding: value, operation: op, reservationId: reservation.reservationId, startAt, nowMs: now, mode: "record-unknown", reason: "TIMEOUT" }),
    ]);
    const okHashes = results.filter((result) => result.ok === true && result.kind === "hash");
    expect(okHashes).toHaveLength(1);
    const check = openJournal({ dbName: "race2/payment-operations.sqlite" });
    const record = check.lookupByIdemKey(paymentIdempotencyKey({ invoice: value.invoice, consumerAddress: value.consumerAddress }))!;
    check.close();
    expect(record.state).toBe("broadcast");
    expect([HASH_A, HASH_B]).toContain(record.txHash!);
    expect(okHashes[0].hash).toBe(record.txHash);
  }, 30_000);
});
