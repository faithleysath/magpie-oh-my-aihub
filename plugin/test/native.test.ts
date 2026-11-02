import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Wallet, Transaction } from "ethers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSC_CHAIN, type RpcClient } from "../src/chain.ts";
import { listPayouts, openLedger } from "../src/db.ts";
import { executeSendNative } from "../src/tools/money.ts";

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

describe("native transfers", () => {
  test("signs, broadcasts and records BNB without touching USDC", async () => {
    dir = mkdtempSync(join(tmpdir(), "omai-native-"));
    db = openLedger(join(dir, "ledger.sqlite"));
    const wallet = new Wallet(Wallet.createRandom().privateKey);
    const fake = {
      balance: async () => 10n ** 18n,
      gasPrice: async () => 1n,
      nonce: async () => 0,
      estimateGas: async () => 21_000n,
      sendRawTransaction: async (raw: string) => Transaction.from(raw).hash,
    } as unknown as RpcClient;

    const result = await executeSendNative(BSC_CHAIN, TO, "0.1", {
      ledger: db,
      wallet,
      client: () => fake,
    });
    expect(result.state).toBe("sent");
    expect(result.asset).toBe("native");
    expect(result.amountRaw).toBe(100_000_000_000_000_000n.toString());
    expect(listPayouts(db, 10)[0]?.token).toBe("native");
  });
});
