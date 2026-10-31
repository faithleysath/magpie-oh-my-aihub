import { describe, expect, test } from "bun:test";
import { createConsolePaymentPort, PAYMENT_LOCAL_ACTION_NAMES } from "./payment-local-port.js";

const OBLIGATION = `inv_${crypto.randomUUID()}`;
const PREVIEW = crypto.randomUUID();
const RESERVATION = crypto.randomUUID();
const HASH = `0x${"ab".repeat(32)}`;
const OPERATION = Object.freeze({
  schema: "ohmyaihub.external-wallet.operation/v1",
  intentHash: `0x${"cd".repeat(32)}`,
  account: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  chainId: 97,
  assetId: "eip155:97:0x5fbdb2315678afecb367f032d93f642f64180aa3",
  contractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  recipientAddress: "0x3d80c477021e3fa568e91c73baec8e806518d9a6",
  amountRaw: "1000001",
  calldata: "0x",
  calldataHash: `0x${"ef".repeat(32)}`,
});

function fixture() {
  const calls = [];
  const port = createConsolePaymentPort({
    obligationId: OBLIGATION,
    previewRef: PREVIEW,
    callAction: async (name, body) => {
      calls.push({ name, body });
      if (name === "payment-operation-reserve") return { reservationId: RESERVATION, state: "reserved", hash: null };
      if (name === "payment-operation-query") return { state: "reserved", hash: null, hashes: [] };
      if (name === "payment-operation-pending") return [];
      return { ok: true };
    },
  });
  return { port, calls };
}

describe("console payment operation port", () => {
  test("maps the external-wallet methods to fixed actions and exact bodies", async () => {
    const { port, calls } = fixture();
    expect(Object.isFrozen(port)).toBe(true);
    expect("release" in port).toBe(false);
    expect(PAYMENT_LOCAL_ACTION_NAMES).not.toContain("payment-operation-release");

    expect(await port.reserve(OPERATION)).toEqual({ reservationId: RESERVATION, state: "reserved", hash: null });
    expect(calls.at(-1)).toEqual({
      name: "payment-operation-reserve",
      body: { obligationId: OBLIGATION, previewRef: PREVIEW, operation: OPERATION },
    });

    await port.markBroadcasting({ reservationId: RESERVATION, operation: OPERATION });
    expect(calls.at(-1)).toEqual({
      name: "payment-operation-mark",
      body: { obligationId: OBLIGATION, previewRef: PREVIEW, reservationId: RESERVATION, operation: OPERATION },
    });

    await port.recordHash({ reservationId: RESERVATION, operation: OPERATION, hash: HASH });
    expect(calls.at(-1)).toEqual({
      name: "payment-operation-hash",
      body: { obligationId: OBLIGATION, previewRef: PREVIEW, reservationId: RESERVATION, operation: OPERATION, hash: HASH },
    });

    await port.recordUnknown({ reservationId: RESERVATION, operation: OPERATION, reason: "USER_REJECTED" });
    expect(calls.at(-1)).toEqual({
      name: "payment-operation-unknown",
      body: { obligationId: OBLIGATION, previewRef: PREVIEW, reservationId: RESERVATION, operation: OPERATION, reason: "USER_REJECTED" },
    });

    await port.query(OPERATION);
    expect(calls.at(-1)).toEqual({ name: "payment-operation-query", body: { obligationId: OBLIGATION, operation: OPERATION } });

    expect(await port.pending()).toEqual([]);
    expect(calls.at(-1)).toEqual({ name: "payment-operation-pending", body: {} });

    for (const { body } of calls) {
      expect(body).not.toHaveProperty("sessionId");
      expect(body).not.toHaveProperty("ownerInstanceId");
      expect(body).not.toHaveProperty("providerIdentityFingerprint");
      expect(body).not.toHaveProperty("authorizationGeneration");
    }
  });

  test("rejects invalid construction and invalid per-call identifiers before the transport", async () => {
    expect(() => createConsolePaymentPort({ callAction: () => {}, obligationId: "../x", previewRef: PREVIEW })).toThrow();
    expect(() => createConsolePaymentPort({ callAction: () => {}, obligationId: OBLIGATION, previewRef: "not-a-uuid" })).toThrow();
    expect(() => createConsolePaymentPort({ callAction: null, obligationId: OBLIGATION, previewRef: PREVIEW })).toThrow();
    const { port, calls } = fixture();
    await expect(port.markBroadcasting({ reservationId: "not-a-uuid", operation: OPERATION })).rejects.toThrow();
    await expect(port.recordHash({ reservationId: RESERVATION, operation: OPERATION, hash: "0x1234" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
