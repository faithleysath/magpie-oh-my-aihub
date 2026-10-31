// Child process for the real-SQLite race tests in
// plugin/test/payment-operations.test.ts. It opens the journal independently,
// waits for a shared start time, and performs exactly one claims/send-gate or
// evidence operation. It never talks to a wallet or a network.
//
// This is a test probe, not production code. Its asset authority is synthetic;
// the production registry adapter and identity authority are exercised in the
// parent test file.

import {
  openPaymentOperationJournal,
  type ExternalWalletOperation,
  type PaymentAssetRegistry,
  type PaymentBinding,
  type PaymentIdentityAuthority,
} from "../../src/payment-operations.ts";

interface Payload {
  dbPath: string;
  ownerInstanceId: string;
  binding: PaymentBinding;
  operation: ExternalWalletOperation;
  nowMs: number;
  startAt: number;
  mode: "reserve-and-mark" | "record-hash" | "record-unknown";
  reservationId?: string;
  hash?: string;
  reason?: string;
}

const payload = JSON.parse(process.argv[2] ?? "{}") as Payload;

// A synthetic registry/authority is enough here: this probe measures the
// SQLite claim/CAS semantics. The production adapters are test-covered in the
// parent suite.
const assetRegistry: PaymentAssetRegistry = {
  resolveSendableAsset(input) {
    return { ...input, networkType: "testnet" as const };
  },
};
const identityAuthority: PaymentIdentityAuthority = { assertCurrent() {} };

const journal = openPaymentOperationJournal({
  path: payload.dbPath,
  ownerInstanceId: payload.ownerInstanceId,
  assetRegistry,
  identityAuthority,
  now: () => payload.nowMs,
});

await Bun.sleep(Math.max(0, payload.startAt - Date.now()));

let result: Record<string, unknown>;
try {
  const port = journal.operationPort(payload.binding);
  if (payload.mode === "reserve-and-mark") {
    const reservation = await port.reserve(payload.operation);
    let marked = false;
    if (reservation.state === "reserved") {
      await port.markBroadcasting({ reservationId: reservation.reservationId, operation: payload.operation });
      marked = true;
    }
    result = {
      ok: true,
      kind: "claim",
      reserveState: reservation.state,
      marked,
      reservationId: reservation.reservationId,
    };
  } else if (payload.mode === "record-hash") {
    await port.recordHash({
      reservationId: payload.reservationId ?? "",
      operation: payload.operation,
      hash: payload.hash ?? "",
    });
    result = { ok: true, kind: "hash", hash: payload.hash };
  } else if (payload.mode === "record-unknown") {
    await port.recordUnknown({
      reservationId: payload.reservationId ?? "",
      operation: payload.operation,
      reason: payload.reason ?? "TIMEOUT",
    });
    result = { ok: true, kind: "unknown" };
  } else {
    result = { ok: false, kind: "invalid-mode" };
  }
} catch (error) {
  result = {
    ok: false,
    kind: payload.mode,
    code: (error as { code?: string }).code ?? null,
    message: String((error as Error).message ?? error).slice(0, 300),
  };
}

journal.close();
process.stdout.write(JSON.stringify(result));
