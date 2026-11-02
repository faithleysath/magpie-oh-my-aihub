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
  payoutMicroTo,
  recreditDeposit,
  countPendingClaims,
  enqueueDepositClaim,
  listPendingDepositClaims,
  markDepositClaimAttempt,
  markDepositClaimCredited,
  recordPayout,
  setPayoutState,
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

  test("keeps deposit claims pending and counts payouts to a provider", () => {
    dir = mkdtempSync(join(tmpdir(), "omai-claims-"));
    db = openLedger(join(dir, "ledger.sqlite"));
    const tx = `0x${"dd".repeat(32)}`;
    recordPayout(db, {
      txHash: tx,
      chainId: 56,
      token: TOKEN,
      to: TO,
      amountRaw: 10n ** 18n,
      state: "sent",
      at: new Date().toISOString(),
    });
    expect(payoutMicroTo(db, TO)).toBe(1_000_000n);
    setPayoutState(db, tx, "gift");
    expect(payoutMicroTo(db, TO)).toBe(0n);
    setPayoutState(db, tx, "sent");
    recordPayout(db, {
      txHash: `0x${"ee".repeat(32)}`,
      chainId: 56,
      token: "native",
      to: TO,
      amountRaw: 10n ** 18n,
      state: "sent",
      at: new Date().toISOString(),
    });
    expect(payoutMicroTo(db, TO)).toBe(1_000_000n);

    const claim = enqueueDepositClaim(db, { provider: TO, chainId: 56, txHash: tx, at: new Date().toISOString() });
    expect(claim.state).toBe("pending");
    expect(countPendingClaims(db, TO)).toBe(1);
    expect(listPendingDepositClaims(db).map((row) => row.id)).toEqual([claim.id]);

    markDepositClaimAttempt(db, claim.id, new Date().toISOString(), "offline");
    expect(listPendingDepositClaims(db)[0]?.attempts).toBe(1);
    markDepositClaimCredited(db, claim.id, new Date().toISOString());
    expect(countPendingClaims(db, TO)).toBe(0);
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
