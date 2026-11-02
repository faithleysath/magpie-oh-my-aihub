import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertCreditedDeposit, openLedger } from "../src/db.ts";
import { Grants } from "../src/grants.ts";
import type { KeyRecord, LimitStatus, Magpie } from "../src/magpie.ts";

const TOKEN = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const PROVIDER = `0x${"22".repeat(20)}`;
const PAYER = `0x${"11".repeat(20)}`;

class FakeMagpie {
  records: KeyRecord[] = [];
  caps: number[] = [];
  used = 0;
  private next = 1;

  keyByName(name: string): KeyRecord | undefined {
    return this.records.find((key) => key.name === name);
  }

  keys(): KeyRecord[] {
    return this.records;
  }

  async addKey(name: string, ownSecret?: string): Promise<KeyRecord> {
    const id = `k${this.next++}`;
    const secret = ownSecret ?? `secret-${id}`;
    const record: KeyRecord = { id, name, secret };
    this.records.push(record);
    return record;
  }

  async setModels(): Promise<void> {}

  async setCostLimit(_id: string, _window: string, usd: number): Promise<void> {
    this.caps.push(usd);
  }

  async removeKey(id: string): Promise<void> {
    this.records = this.records.filter((key) => key.id !== id);
  }

  async rotateKey(): Promise<string> {
    return "rotated";
  }

  async limitStatus(): Promise<LimitStatus> {
    return { limited: true, key: "test", limit: { cost: this.used } };
  }
}

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

function setup(): { grants: Grants; fake: FakeMagpie } {
  dir = mkdtempSync(join(tmpdir(), "omai-grants-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  insertCreditedDeposit(db, {
    chainId: 56,
    token: TOKEN,
    from: PAYER,
    to: PROVIDER,
    amountRaw: 5_000_000_000_000_000_000n,
    blockNumber: 1,
    blockHash: `0x${"aa".repeat(32)}`,
    txHash: `0x${"bb".repeat(32)}`,
    logIndex: 0,
    seenAt: new Date().toISOString(),
  });
  const fake = new FakeMagpie();
  const grants = new Grants({
    db,
    address: () => PROVIDER,
    gatewayPort: 3425,
    shareable: async () => [{ id: "devin/swe-2" }],
    published: () => ["devin/swe-2"],
    magpie: () => fake as unknown as Magpie,
  });
  return { grants, fake };
}

describe("Gateway Key accounting", () => {
  test("a new key after revoke is capped at deposits minus what the old key spent", async () => {
    const { grants, fake } = setup();
    const first = await grants.approve(PAYER, ["devin/swe-2"]);
    expect(first.state).toBe("active");
    expect(fake.caps.at(-1)).toBe(5);

    fake.used = 4;
    const revoked = await grants.revoke(PAYER);
    expect(revoked.keyRemoved).toBe(true);

    const second = await grants.approve(PAYER, ["devin/swe-2"]);
    expect(second.state).toBe("active");
    expect(fake.caps.at(-1)).toBe(1);

    const snapshot = grants.snapshot(PAYER);
    expect(snapshot.usedUsd).toBe("4.0000");
    expect(snapshot.remainingUsd).toBe("1.0000");
    expect(snapshot.key).not.toBeNull();
  });

  test("concurrent approvals for one address do not create duplicate keys", async () => {
    const { grants, fake } = setup();
    const [a, b] = await Promise.all([
      grants.approve(PAYER, ["devin/swe-2"]),
      grants.approve(PAYER, ["devin/swe-2"]),
    ]);
    expect(a.state).toBe("active");
    expect(b.state).toBe("active");
    expect(fake.records.length).toBe(1);
  });

  test("revoking a spent key leaves no key when the remaining balance is below the minimum", async () => {
    const { grants, fake } = setup();
    await grants.approve(PAYER, ["devin/swe-2"]);
    fake.used = 5;
    await grants.revoke(PAYER);
    const second = await grants.approve(PAYER, ["devin/swe-2"]);
    expect(second.state).toBe("waiting-deposit");
    expect(second.keyIssued).toBe(false);
  });
});
