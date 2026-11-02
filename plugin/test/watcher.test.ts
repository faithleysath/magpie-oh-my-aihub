import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSC_CHAIN, TRANSFER_TOPIC, addressTopic, type RpcClient } from "../src/chain.ts";
import { Watcher } from "../src/chain-watcher.ts";
import { balanceMicro, openLedger } from "../src/db.ts";

const TOKEN = BSC_CHAIN.usdc;
const FROM = `0x${"11".repeat(20)}`;
const TO = `0x${"22".repeat(20)}`;
const BLOCK = 80;
const TX = `0x${"bb".repeat(32)}`;
const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"cc".repeat(32)}`;

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

function log(): Record<string, unknown> {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, addressTopic(FROM), addressTopic(TO)],
    data: `0x${(10n ** 18n).toString(16)}`,
    blockNumber: `0x${BLOCK.toString(16)}`,
    blockHash: HASH_A,
    transactionHash: TX,
    logIndex: "0x1",
  };
}

class FakeClient {
  blockHash = HASH_A;
  async head(): Promise<number> {
    return 100;
  }
  async getLogs(): Promise<Record<string, unknown>[]> {
    return [log()];
  }
  async receipt(): Promise<Record<string, unknown>> {
    return { transactionHash: TX, status: "0x1", blockNumber: `0x${BLOCK.toString(16)}`, blockHash: HASH_A, logs: [log()] };
  }
  async block(): Promise<Record<string, unknown>> {
    return { number: `0x${BLOCK.toString(16)}`, hash: this.blockHash, parentHash: HASH_A };
  }
}

describe("deposit watcher", () => {
  test("credits a finalized transfer once, then reverses it when its block hash changes", async () => {
    dir = mkdtempSync(join(tmpdir(), "omai-watch-"));
    db = openLedger(join(dir, "ledger.sqlite"));
    const fake = new FakeClient();
    const watcher = new Watcher({
      db,
      address: () => TO,
      credit: { onDeposit: async () => undefined, onRevert: async () => undefined },
      chains: [BSC_CHAIN],
      client: () => fake as unknown as RpcClient,
      lookbackBlocks: () => 100,
    });

    const first = await watcher.passChain(BSC_CHAIN);
    expect(first.credited).toBe(1);
    expect(balanceMicro(db, TO, FROM)).toBe(1_000_000n);

    const second = await watcher.passChain(BSC_CHAIN);
    expect(second.credited).toBe(0);
    expect(balanceMicro(db, TO, FROM)).toBe(1_000_000n);

    fake.blockHash = HASH_B;
    const third = await watcher.passChain(BSC_CHAIN);
    expect(third.reverted).toBe(1);
    expect(balanceMicro(db, TO, FROM)).toBe(0n);
  });
});
