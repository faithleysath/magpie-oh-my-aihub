import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type LedgerWindow } from "../src/ledger.ts";
import { priceSnapshot, usdToNanos } from "../src/pricing.ts";

const MODELS = ["lab/lab-model"];
const price = { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 };
const snap = priceSnapshot([{ id: "lab/lab-model", price }], MODELS)!;

let dir: string;
let ledger: Ledger;
let log: string;

function row(over: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      route_id: 1,
      t: new Date().toISOString(),
      callerKeyId: "key-1",
      callerKeyName: "lab",
      provider: "lab",
      model: "lab-model",
      in: 1000,
      out: 100,
      cache_read: 0,
      cache_write: 0,
      status: 200,
      ...over,
    }) + "\n"
  );
}

function open(): LedgerWindow {
  return ledger.ensureAccount({
    consumerId: "alice",
    keyId: "key-1",
    keyName: "lab",
    price: snap,
    windowSpec: "3650d",
    startAt: "2026-10-30T00:00:00.000Z",
    resetAt: "2036-10-27T00:00:00.000Z",
    openingNanos: usdToNanos(10),
    capNanos: usdToNanos(10),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-ledger-"));
  log = join(dir, "usage.jsonl");
  writeFileSync(log, "");
  ledger = new Ledger(join(dir, "ledger.sqlite"));
});

describe("credit arithmetic", () => {
  test("opening credit, deposits and consumption are integer nanos", () => {
    open();
    expect(ledger.balance("alice")).toMatchObject({
      depositedNanos: usdToNanos(10),
      consumedNanos: 0,
      balanceNanos: usdToNanos(10),
    });
    const intent = ledger.depositIntent({ id: "dep-1", consumerId: "alice", amountNanos: usdToNanos(2.5), source: "simulated" });
    expect(intent.created).toBe(true);
    // intent is not credit until the cap write is confirmed
    expect(ledger.balance("alice").balanceNanos).toBe(usdToNanos(10));
    ledger.markDepositApplied("dep-1", ledger.openWindowFor("alice")!.id, usdToNanos(12.5));
    expect(ledger.balance("alice").depositedNanos).toBe(usdToNanos(12.5));
    expect(ledger.balance("alice").balanceNanos).toBe(usdToNanos(12.5));
  });

  test("a repeated deposit id is a no-op, a conflicting one is refused", () => {
    open();
    ledger.depositIntent({ id: "dep-1", consumerId: "alice", amountNanos: usdToNanos(1), source: "simulated" });
    expect(ledger.depositIntent({ id: "dep-1", consumerId: "alice", amountNanos: usdToNanos(1), source: "simulated" }).created).toBe(false);
    expect(() =>
      ledger.depositIntent({ id: "dep-1", consumerId: "alice", amountNanos: usdToNanos(2), source: "simulated" }),
    ).toThrow(/cannot be replayed/);
    ledger.markDepositApplied("dep-1", ledger.openWindowFor("alice")!.id, usdToNanos(11));
    expect(ledger.balance("alice").balanceNanos).toBe(usdToNanos(11));
  });

  test("an overdraft is visible, not hidden", () => {
    ledger.ensureAccount({
      consumerId: "bob",
      keyId: "key-2",
      keyName: "lab",
      price: snap,
      windowSpec: "3650d",
      startAt: "2026-10-30T00:00:00.000Z",
      resetAt: "2036-10-27T00:00:00.000Z",
      openingNanos: usdToNanos(1),
      capNanos: usdToNanos(1),
    });
    appendFileSync(
      log,
      row({ callerKeyId: "key-2", in: 4_000_000, out: 2_000_000, route_id: 2 }),
    );
    ledger.importUsage({ consumerId: "bob", window: ledger.openWindowFor("bob")!, logPath: log });
    const b = ledger.balance("bob");
    expect(b.balanceNanos).toBe(-usdToNanos(7));
    expect(b.overdraftNanos).toBe(usdToNanos(7));
    expect(b.availableNanos).toBe(0);
  });
});

describe("usage import", () => {
  test("imports only this key's settled rows, exactly once, and advances the offset", () => {
    open();
    writeFileSync(
      log,
      row({ route_id: 10, t: "2026-10-30T01:00:00.000Z" }) +
        row({ route_id: 11, t: "2026-10-30T01:00:01.000Z", rejected: true }) +
        row({ route_id: 12, t: "2026-10-30T01:00:02.000Z", callerKeyId: "other" }) +
        row({ route_id: 13, t: "2026-10-30T01:00:03.000Z", provider: "", status: 429 }) +
        row({ route_id: 14, t: "2026-10-30T01:00:04.000Z", source: "reported" }),
    );
    const first = ledger.importUsage({ consumerId: "alice", window: ledger.openWindowFor("alice")!, logPath: log });
    expect(first.imported).toBe(1);
    expect(ledger.balance("alice").consumedNanos).toBe(usdToNanos(0.0012));
    const again = ledger.importUsage({ consumerId: "alice", window: ledger.openWindowFor("alice")!, logPath: log });
    expect(again.imported).toBe(0);
    appendFileSync(log, row({ route_id: 15, t: "2026-10-30T01:00:05.000Z" }));
    const third = ledger.importUsage({ consumerId: "alice", window: ledger.openWindowFor("alice")!, logPath: log });
    expect(third.imported).toBe(1);
    expect(ledger.balance("alice").consumedNanos).toBe(usdToNanos(0.0024));
  });

  test("a partial last line is left for the next import", () => {
    open();
    const full = row({ route_id: 20, t: "2026-10-30T02:00:00.000Z" });
    writeFileSync(log, full + '{"route_id":21');
    expect(ledger.importUsage({ consumerId: "alice", window: ledger.openWindowFor("alice")!, logPath: log }).imported).toBe(1);
    appendFileSync(log, ',"t":"2026-10-30T02:00:01.000Z","callerKeyId":"key-1","provider":"lab","model":"lab-model","in":1000,"out":100,"status":200}\n');
    expect(ledger.importUsage({ consumerId: "alice", window: ledger.openWindowFor("alice")!, logPath: log }).imported).toBe(1);
    expect(ledger.balance("alice").consumedNanos).toBe(usdToNanos(0.0024));
  });

  test("an unpriced row is recorded at zero and flagged, never silently priced", () => {
    open();
    writeFileSync(log, row({ route_id: 30, t: "2026-10-30T03:00:00.000Z", model: "unknown" }));
    const out = ledger.importUsage({ consumerId: "alice", window: ledger.openWindowFor("alice")!, logPath: log });
    expect(out.unpriced).toBe(1);
    expect(ledger.balance("alice").consumedNanos).toBe(0);
    expect(ledger.consumptionForWindow(ledger.openWindowFor("alice")!.id)[0].priceVerified).toBe(false);
  });
});

describe("windows and restart", () => {
  test("a new window carries the ledger balance, never the old cap", () => {
    const first = open();
    writeFileSync(log, row({ route_id: 40, t: "2026-10-30T04:00:00.000Z", in: 4_000_000, out: 2_000_000 }));
    ledger.importUsage({ consumerId: "alice", window: first, logPath: log });
    expect(ledger.balance("alice").balanceNanos).toBe(usdToNanos(2));
    ledger.closeWindow(first.id, "window-rollover");
    const second = ledger.openWindow({
      consumerId: "alice",
      keyId: "key-1b",
      keyName: "lab",
      price: snap,
      windowSpec: "3650d",
      startAt: "2036-10-27T00:00:00.000Z",
      resetAt: "2046-10-24T00:00:00.000Z",
      capNanos: usdToNanos(2),
    });
    expect(second.capNanos).toBe(usdToNanos(2));
    expect(ledger.balance("alice").balanceNanos).toBe(usdToNanos(2));
    expect(ledger.balance("alice").consumedNanos).toBe(usdToNanos(8));
  });

  test("the ledger survives a close and reopen with the same balance", () => {
    open();
    ledger.depositIntent({ id: "dep-1", consumerId: "alice", amountNanos: usdToNanos(1), source: "simulated" });
    ledger.markDepositApplied("dep-1", ledger.openWindowFor("alice")!.id, usdToNanos(11));
    ledger.close();
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    expect(ledger.balance("alice").balanceNanos).toBe(usdToNanos(11));
    expect(ledger.account("alice")?.status).toBe("active");
    expect(ledger.depositsFor("alice").map((d) => d.id)).toEqual(["opening:alice", "dep-1"]);
  });

  test("pausing closes the window but leaves the balance and an audit event", () => {
    const w = open();
    ledger.setPaused("alice", "price-mismatch");
    ledger.closeWindow(w.id, "paused:price-mismatch");
    expect(ledger.openWindowFor("alice")).toBeNull();
    expect(ledger.balance("alice").balanceNanos).toBe(usdToNanos(10));
    expect(ledger.events("alice").some((e) => e.kind === "account-opened")).toBe(true);
  });
});
