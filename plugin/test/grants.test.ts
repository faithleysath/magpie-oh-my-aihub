import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveContact } from "../src/contacts.ts";
import { insertCreditedDeposit, openLedger } from "../src/db.ts";
import { Grants } from "../src/grants.ts";
import type { KeyRecord, LimitStatus, Magpie } from "../src/magpie.ts";

const TOKEN = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const PROVIDER = `0x${"22".repeat(20)}`;
const PAYER = `0x${"11".repeat(20)}`;

class FakeMagpie {
  records: KeyRecord[] = [];
  caps: number[] = [];
  /** how many CLI-equivalent writes the plugin asked for */
  modelCalls = 0;
  capCalls = 0;
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

  // Mirrors caller-keys.json: what is written is what a later read sees, which
  // is what lets the plugin skip a write it does not need.
  async setModels(id: string, models: string[]): Promise<void> {
    this.modelCalls += 1;
    const record = this.records.find((key) => key.id === id);
    if (record) record.models = [...models];
  }

  async setCostLimit(id: string, _window: string, usd: number): Promise<void> {
    this.caps.push(usd);
    this.capCalls += 1;
    const record = this.records.find((key) => key.id === id);
    if (record) record.limit = { period: "days", days: 3650, cost: usd };
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

describe("key reconciliation", () => {
  test("a resync leaves a key that already matches untouched", async () => {
    const { grants, fake } = setup();
    await grants.approve(PAYER, ["devin/swe-2"]);
    const models = fake.modelCalls;
    const caps = fake.capCalls;

    await grants.resyncAll();
    await grants.resyncAll();

    // Every write is a `magpie gateway-key …` child, and magpie answers that
    // child by booting this plugin again: an unconditional write on boot is a
    // process loop, not a slow path.
    expect(fake.modelCalls).toBe(models);
    expect(fake.capCalls).toBe(caps);
  });

  test("a new deposit widens the cap without rewriting the model list", async () => {
    const { grants, fake } = setup();
    await grants.approve(PAYER, ["devin/swe-2"]);
    const models = fake.modelCalls;
    const caps = fake.capCalls;

    insertCreditedDeposit(db!, {
      chainId: 56,
      token: TOKEN,
      from: PAYER,
      to: PROVIDER,
      amountRaw: 2_000_000_000_000_000_000n,
      blockNumber: 2,
      blockHash: `0x${"cc".repeat(32)}`,
      txHash: `0x${"dd".repeat(32)}`,
      logIndex: 0,
      seenAt: new Date().toISOString(),
    });
    await grants.onDeposit(PAYER);

    expect(fake.modelCalls).toBe(models);
    expect(fake.capCalls).toBe(caps + 1);
    expect(fake.caps.at(-1)).toBe(7);
  });
});

describe("payersWithoutGrant", () => {
  test("a payer with money and no grant is listed until it is approved", async () => {
    const { grants } = setup();
    const before = await grants.listing({ usage: false });
    expect(before.payersWithoutGrant).toEqual([{ address: PAYER, name: null, balanceUsd: "5.0000" }]);

    await grants.approve(PAYER, ["devin/swe-2"]);
    const after = await grants.listing({ usage: false });
    expect(after.payersWithoutGrant).toEqual([]);
  });

  test("a revoked payer who still holds money is listed again", async () => {
    const { grants } = setup();
    await grants.approve(PAYER, ["devin/swe-2"]);
    await grants.revoke(PAYER);

    const listing = await grants.listing({ usage: false });
    // The regression this replaces: the revoked payer kept its consumers row and
    // was therefore invisible while its money was still in the ledger.
    expect(listing.consumers[0]?.state).toBe("revoked");
    expect(listing.payersWithoutGrant).toEqual([{ address: PAYER, name: null, balanceUsd: "5.0000" }]);
  });

  test("an address-book alias is reported as the name", async () => {
    const { grants } = setup();
    saveContact(db!, { alias: "  张三 ", address: PAYER, now: new Date().toISOString() });

    const listing = await grants.listing({ usage: false });
    expect(listing.payersWithoutGrant).toEqual([{ address: PAYER, name: "张三", balanceUsd: "5.0000" }]);
  });
});
