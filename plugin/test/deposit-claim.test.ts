import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BSC_CHAIN,
  TRANSFER_TOPIC,
  addressTopic,
  type RpcClient,
} from "../src/chain.ts";
import { DepositClaimService } from "../src/deposit-claim.ts";
import { balanceMicro, openLedger } from "../src/db.ts";
import type { AccountSummary, Grants } from "../src/grants.ts";

const FROM = `0x${"11".repeat(20)}`;
const TO = `0x${"22".repeat(20)}`;
const TX = `0x${"bb".repeat(32)}`;
const BLOCK_HASH = `0x${"aa".repeat(32)}`;
const AMOUNT = 10n ** 18n;

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

class FakeClient {
  blockNumber = 80;
  blockHash = BLOCK_HASH;
  headBlock = 100;
  status = "0x1";
  from = FROM;
  async receipt(): Promise<Record<string, unknown>> {
    return {
      transactionHash: TX,
      status: this.status,
      blockNumber: `0x${this.blockNumber.toString(16)}`,
      blockHash: this.blockHash,
      logs: [
        {
          address: BSC_CHAIN.usdc,
          topics: [TRANSFER_TOPIC, addressTopic(this.from), addressTopic(TO)],
          data: `0x${AMOUNT.toString(16)}`,
          blockNumber: `0x${this.blockNumber.toString(16)}`,
          blockHash: this.blockHash,
          transactionHash: TX,
          logIndex: "0x1",
        },
      ],
    };
  }
  async head(): Promise<number> {
    return this.headBlock;
  }
  async block(): Promise<Record<string, unknown>> {
    return { number: `0x${this.blockNumber.toString(16)}`, hash: this.blockHash, parentHash: BLOCK_HASH };
  }
}

function service(fake: FakeClient, credited: string[] = []): DepositClaimService {
  dir = mkdtempSync(join(tmpdir(), "omai-claim-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  const summary: AccountSummary = {
    state: "approved",
    grantedModels: ["devin/swe-2"],
    balanceUsd: "1.0000",
    usedUsd: "0.0000",
    remainingUsd: "1.0000",
    gatewayPort: 3425,
    ts: new Date().toISOString(),
  };
  const grants = {
    onDeposit: async (payer: string) => {
      credited.push(payer);
    },
    summary: () => summary,
  } as unknown as Grants;
  return new DepositClaimService({
    db,
    address: () => TO,
    grants,
    client: () => fake as unknown as RpcClient,
    now: () => "2026-11-02T00:00:00.000Z",
  });
}

describe("deposit claims", () => {
  test("credits a final Transfer from the claimed payer and is idempotent", async () => {
    const fake = new FakeClient();
    const credited: string[] = [];
    const claim = service(fake, credited);

    const first = await claim.claim({ payer: FROM, chainId: 56, txHash: TX, logIndex: 1 });
    expect(first.state).toBe("credited");
    expect(first.credited?.[0]?.amountRaw).toBe(AMOUNT.toString());
    expect(credited).toEqual([FROM]);
    expect(db && balanceMicro(db, TO, FROM)).toBe(1_000_000n);

    const second = await claim.claim({ payer: FROM, chainId: 56, txHash: TX, logIndex: 1 });
    expect(second.state).toBe("already");
    expect(db && balanceMicro(db, TO, FROM)).toBe(1_000_000n);
  });

  test("returns pending until the block is final", async () => {
    const fake = new FakeClient();
    fake.blockNumber = 99; // BSC final = 100 - 15 = 85
    const claim = service(fake);
    const result = await claim.claim({ payer: FROM, chainId: 56, txHash: TX });
    expect(result.state).toBe("pending");
  });

  test("does not credit a Transfer from a different payer", async () => {
    const fake = new FakeClient();
    fake.from = `0x${"33".repeat(20)}`;
    const claim = service(fake);
    const result = await claim.claim({ payer: FROM, chainId: 56, txHash: TX });
    expect(result.state).toBe("not_found");
  });

  test("does not credit a failed transaction", async () => {
    const fake = new FakeClient();
    fake.status = "0x0";
    const claim = service(fake);
    const result = await claim.claim({ payer: FROM, chainId: 56, txHash: TX });
    expect(result.state).toBe("failed");
  });
});
