import { expect, test } from "bun:test";
import { castReceipt, labAmount } from "../scripts/testnet-lab-utils.ts";

test("default lab payment is one whole token at either precision", () => {
  expect(labAmount(6)).toBe(1_000_000n);
  expect(labAmount(18)).toBe(1_000_000_000_000_000_000n);
});

test("the old six-decimal amount is refused for an eighteen-decimal token before spending gas", () => {
  expect(() => labAmount(18, "1000000")).toThrow("positive, safe");
  expect(labAmount(6, "2500000")).toBe(2_500_000n);
});

test("invalid, zero and overflowing lab amounts are refused", () => {
  for (const amount of ["0", "-1", "1.5", "100000000000000000000000000000000000000"]) {
    expect(() => labAmount(18, amount)).toThrow();
  }
  expect(() => labAmount(-1)).toThrow();
});

test("cast JSON must include a successful receipt, not merely exit zero", () => {
  const transactionHash = `0x${"ab".repeat(32)}`;
  expect(castReceipt(JSON.stringify({ transactionHash, status: "0x1" })).transactionHash).toBe(transactionHash);
  expect(() => castReceipt(JSON.stringify({ success: false, errors: [{ message: "insufficient funds" }] }))).toThrow("insufficient funds");
  expect(() => castReceipt(JSON.stringify({ transactionHash, status: "0x0" }))).toThrow("successful receipt");
  expect(() => castReceipt("{}")).toThrow("no transaction hash");
});
