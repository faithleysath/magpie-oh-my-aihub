import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  balanceMicro,
  capMicroOf,
  formatUsd4,
  insertCreditedDeposit,
  markDepositReverted,
  microFromRaw,
  openLedger,
  recreditDeposit,
  type NewDeposit,
} from "../src/db.ts";

const TOKEN = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const FROM = `0x${"11".repeat(20)}`;
const TO = `0x${"22".repeat(20)}`;

let db: Database | null = null;
let dir: string | null = null;

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function row(overrides: Partial<NewDeposit> = {}): NewDeposit {
  return {
    chainId: 56,
    token: TOKEN,
    from: FROM,
    to: TO,
    amountRaw: 5_000_000_000_000_000_000n,
    blockNumber: 100,
    blockHash: `0x${"aa".repeat(32)}`,
    txHash: `0x${"bb".repeat(32)}`,
    logIndex: 1,
    seenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ledger", () => {
  test("books a deposit once, reverts it, and re-credits the same log", () => {
    dir = mkdtempSync(join(tmpdir(), "omai-db-"));
    db = openLedger(join(dir, "ledger.sqlite"));
    const deposit = row();

    expect(insertCreditedDeposit(db, deposit)).toBe(true);
    expect(insertCreditedDeposit(db, deposit)).toBe(false);
    expect(balanceMicro(db, TO, FROM)).toBe(5_000_000n);

    expect(markDepositReverted(db, `${56}:${TOKEN}:${deposit.txHash}:${deposit.logIndex}`, new Date().toISOString())).toBe(true);
    expect(balanceMicro(db, TO, FROM)).toBe(0n);

    const revived = row({ blockNumber: 101, blockHash: `0x${"cc".repeat(32)}` });
    expect(insertCreditedDeposit(db, revived)).toBe(false);
    expect(recreditDeposit(db, revived)).toBe(true);
    expect(balanceMicro(db, TO, FROM)).toBe(5_000_000n);
  });

  test("converts raw token amounts and floors a cap to $0.0001", () => {
    expect(microFromRaw(56, 10n ** 18n)).toBe(1_000_000n);
    expect(microFromRaw(8453, 1_000_000n)).toBe(1_000_000n);
    expect(microFromRaw(999, 1n)).toBeNull();
    expect(capMicroOf(1_234_567n)).toBe(1_234_500n);
    expect(formatUsd4(1_234_567n)).toBe("1.2345");
    expect(formatUsd4(-1n)).toBe("-0.0000");
  });
});
