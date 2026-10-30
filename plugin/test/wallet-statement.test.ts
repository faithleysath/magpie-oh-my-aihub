import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStatement,
  canonicalJson,
  statementText,
  verifyStatement,
  writeStatementFile,
  type ConsumerStatement,
  type StatementInput,
} from "../src/walletstatement.ts";
import type { KeyReadback } from "../src/walletview.ts";
import type { Lab } from "./support/wallet-lab.ts";
import { createLab, ensureConsumer, PROVIDER_ID, RECIPIENT } from "./support/wallet-lab.ts";
import { TEST_PAYER } from "./support/signer.ts";

/**
 * The statement is the only thing a consumer receives from the provider, so its
 * shape and its limits matter more than its convenience:
 *   - one explicitly named consumer, no one else's rows;
 *   - an explicit field allowlist (an extra field is refused, not ignored);
 *   - an unsigned digest that says it is not proof;
 *   - 0600 on disk and no network code in the module.
 */

const GENERATED = "2026-10-30T12:30:00.000Z";

async function statementInput(lab: Lab, consumerId: string): Promise<StatementInput> {
  const consumers = await lab.provisioner.refreshAll();
  const consumer = consumers.find((c) => c.consumerId === consumerId) ?? null;
  const rec = lab.provisioner.find(consumerId);
  let readback: KeyReadback | null = null;
  if (rec && !rec.paused && !rec.revokedAt) {
    try {
      const status = await lab.provisioner.verify(rec);
      readback = {
        at: GENERATED,
        capUsd: status.limit?.costLimit ?? 0,
        usedUsd: status.limit?.cost ?? 0,
        leftUsd: status.limit?.costLeft ?? 0,
        fromGateway: true,
      };
    } catch {
      readback = null;
    }
  }
  return {
    providerId: PROVIDER_ID,
    consumerId,
    generatedAt: GENERATED,
    networks: lab.registry.networks(),
    assets: lab.registry.networks().flatMap((n) => lab.registry.assetsForChain(n.chainId)),
    intents: lab.store.intentsFor(consumerId, 500),
    events: lab.store.eventsForConsumer(consumerId, 500),
    deposits: lab.ledger.depositsFor(consumerId),
    consumer,
    accounting: { state: "ok", reason: null, openSettlements: consumer?.ledger?.openSettlements ?? 0 },
    readback,
  };
}

async function creditAlice(lab: Lab): Promise<void> {
  await ensureConsumer(lab, "alice");
  const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: "1000000" });
  lab.sign(req.intent.invoiceId, req.digest);
  const chain = lab.chainFor(97);
  chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
  chain.mineN(20);
  await lab.scan(97);
}

describe("consumer statement", () => {
  test("one consumer's own rows, an allowlist, and an explicit 'not proof'", async () => {
    const lab = createLab();
    try {
      await creditAlice(lab);
      await ensureConsumer(lab, "bob");
      const bobReq = lab.request({ consumerId: "bob", chainId: 97, amountRaw: "2000000" });

      const { statement, digest } = buildStatement(await statementInput(lab, "alice"));
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(statement.consumerId).toBe("alice");
      expect(statement.requests.every((r) => r.invoiceId !== bobReq.intent.invoiceId)).toBe(true);
      expect(statement.deposits).toHaveLength(1);
      expect(statement.deposits[0]!.amountRaw).toBe("1000000");
      expect(statement.deposits[0]!.creditedUsd).toBeCloseTo(1, 9);
      expect(statement.totals.creditedUsd).toBeCloseTo(1, 9);
      expect(statement.totals.consumedUsd).toBe(0);
      expect(statement.totals.pendingDeposits).toBe(0);
      expect(statement.key.capUsd).toBeCloseTo(1.0001, 6);
      expect(statement.key.fromGateway).toBe(true);
      expect(statement.signed).toBe(false);
      expect(statement.disclaimer).toContain("not a signature");
      expect(statement.disclaimer).toContain("not proof of payment");
      expect(verifyStatement({ statement, digest })).toEqual({ ok: true, reason: null });

      const text = statementText({ statement, digest });
      expect(text).not.toMatch(/secret|keyId|sk-|0x[0-9a-f]{64}\b.*private/i);
      // Only the two chains' public metadata is included, no RPC credentials or paths.
      expect(text).not.toContain("rpc");
    } finally {
      lab.close();
    }
  });

  test("the digest is stable for identical input and covers the body", async () => {
    const lab = createLab();
    try {
      await creditAlice(lab);
      const input = await statementInput(lab, "alice");
      const a = buildStatement(input);
      const b = buildStatement(input);
      expect(a.digest).toBe(b.digest);
      expect(a.digest).toBe(b.digest);
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');

      const tampered: ConsumerStatement = structuredClone(a);
      tampered.statement.deposits[0]!.amountRaw = "1";
      const check = verifyStatement(tampered);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain("digest");
    } finally {
      lab.close();
    }
  });

  test("an unexpected field is refused, not ignored", async () => {
    const lab = createLab();
    try {
      await creditAlice(lab);
      const { statement, digest } = buildStatement(await statementInput(lab, "alice"));

      const extraDeposit: any = structuredClone(statement);
      extraDeposit.deposits[0].keySecret = "sk-nope";
      expect(verifyStatement({ statement: extraDeposit, digest }).ok).toBe(false);
      expect(verifyStatement({ statement: extraDeposit, digest }).reason).toContain("deposit");

      const extraTop: any = structuredClone(statement);
      extraTop.extra = 1;
      expect(verifyStatement({ statement: extraTop, digest }).ok).toBe(false);

      const missing: any = structuredClone(statement);
      delete missing.totals;
      expect(verifyStatement({ statement: missing, digest }).ok).toBe(false);

      const resealed = structuredClone(statement) as any;
      resealed.deposits[0].txHash = `0x${"00".repeat(32)}`;
      expect(verifyStatement({ statement: resealed, digest }).ok).toBe(false);
    } finally {
      lab.close();
    }
  });

  test("writing is local, 0600 and verified before it leaves the process", async () => {
    const lab = createLab();
    try {
      await creditAlice(lab);
      const built = buildStatement(await statementInput(lab, "alice"));
      const dir = mkdtempSync(join(tmpdir(), "statements-"));
      const { path } = writeStatementFile(built, { dir: join(dir, "out") });
      expect(path.startsWith(join(dir, "out"))).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ConsumerStatement;
      expect(verifyStatement(parsed).ok).toBe(true);

      const broken: ConsumerStatement = structuredClone(built);
      broken.statement.digest = "0".repeat(64);
      expect(() => writeStatementFile(broken, { dir })).toThrow(/invalid statement/);
    } finally {
      lab.close();
    }
  });

  test("a statement for one consumer refuses another consumer's request", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      await ensureConsumer(lab, "bob");
      const bobReq = lab.request({ consumerId: "bob", chainId: 97, amountRaw: "1000000" });
      const input = await statementInput(lab, "alice");
      // A mixed list is refused outright: a statement is one consumer, always.
      expect(() => buildStatement({ ...input, intents: [bobReq.intent] })).toThrow(/another consumer/);
      const aliceOnly = buildStatement(input);
      expect(aliceOnly.statement.requests.every((r) => r.invoiceId !== bobReq.intent.invoiceId)).toBe(true);
    } finally {
      lab.close();
    }
  });

  test("mixed input is refused, not silently included", async () => {
    const lab = createLab();
    try {
      await creditAlice(lab);
      await ensureConsumer(lab, "bob");
      const bobReq = lab.request({ consumerId: "bob", chainId: 97, amountRaw: "2000000" });
      lab.sign(bobReq.intent.invoiceId, bobReq.digest);
      const bobChain = lab.chainFor(97);
      bobChain.mineN(1); // the previous scan's cursor is at the old head
      bobChain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 2_000_000n });
      bobChain.mineN(20);
      await lab.scan(97);

      const input = await statementInput(lab, "alice");
      const bobEvents = lab.store.eventsForConsumer("bob", 10);
      expect(bobEvents.length).toBe(1);
      expect(() => buildStatement({ ...input, events: [...input.events, ...bobEvents] })).toThrow(/another consumer/);

      const bobDeposit = lab.ledger.depositsFor("bob")[0]!;
      expect(() => buildStatement({ ...input, deposits: [...input.deposits, bobDeposit] })).toThrow(/another consumer/);

      const bobView = (await lab.provisioner.refreshAll()).find((c) => c.consumerId === "bob")!;
      expect(() => buildStatement({ ...input, consumer: bobView })).toThrow(/consumer record/);
      expect(bobReq.intent.consumerId).toBe("bob");
    } finally {
      lab.close();
    }
  });

  test("a malformed statement is refused without throwing", async () => {
    const lab = createLab();
    try {
      await creditAlice(lab);
      const built = buildStatement(await statementInput(lab, "alice"));
      expect(verifyStatement(null).ok).toBe(false);
      expect(verifyStatement(undefined as never).ok).toBe(false);
      expect(verifyStatement("not a statement").ok).toBe(false);
      expect(verifyStatement({ statement: null } as never).ok).toBe(false);

      const nullNetworks: any = structuredClone(built);
      nullNetworks.statement.networks = null;
      const check = verifyStatement(nullNetworks);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain("networks");

      const nullTotals: any = structuredClone(built);
      nullTotals.statement.totals = null;
      expect(verifyStatement(nullTotals).ok).toBe(false);

      const nullNetworkEntry: any = structuredClone(built);
      nullNetworkEntry.statement.networks[0] = null;
      expect(verifyStatement(nullNetworkEntry).ok).toBe(false);

      const nullFinality: any = structuredClone(built);
      nullFinality.statement.networks[0].finality = null;
      expect(verifyStatement(nullFinality).ok).toBe(false);
    } finally {
      lab.close();
    }
  });

  test("the writer refuses overwrite, follows no symlink, and cannot be steered by the timestamp", async () => {
    const lab = createLab();
    try {
      await creditAlice(lab);
      const dir = mkdtempSync(join(tmpdir(), "statements-safe-"));
      const built = buildStatement(await statementInput(lab, "alice"));
      const first = writeStatementFile(built, { dir });
      expect(() => writeStatementFile(built, { dir })).toThrow(/refusing to overwrite/);
      expect(statSync(first.path).mode & 0o777).toBe(0o600);

      // `--out <file>`: the exact path is honoured, exclusively created, and the
      // same protection applies (no overwrite, no symlink follow).
      const explicit = join(dir, "alice-statement.json");
      const second = writeStatementFile(built, { path: explicit });
      expect(second.path).toBe(explicit);
      expect(statSync(explicit).mode & 0o777).toBe(0o600);
      expect(() => writeStatementFile(built, { path: explicit })).toThrow(/refusing to overwrite/);
      const outside = join(dir, "outside.json");
      writeFileSync(outside, "{}");
      const planted = join(dir, "planted.json");
      symlinkSync(outside, planted);
      expect(() => writeStatementFile(built, { path: planted })).toThrow(/refusing to overwrite/);
      expect(() => writeStatementFile(built, { path: join(dir, "missing-dir", "x.json") })).toThrow(/does not exist/);
      expect(() => writeStatementFile(built, { path: join(dir, "not-json.txt") })).toThrow(/end with .json/);

      // A symlinked output directory is refused.
      const realDir = join(dir, "real");
      mkdirSync(realDir, { recursive: true });
      const link = join(dir, "link");
      symlinkSync(realDir, link);
      expect(() => writeStatementFile(built, { dir: link })).toThrow(/not a real directory/);

      // `generatedAt` cannot introduce a path separator, even when it is hostile.
      const hostile = buildStatement({ ...(await statementInput(lab, "alice")), generatedAt: "../../escape/2026" });
      const written = writeStatementFile(hostile, { dir });
      expect(written.path.startsWith(dir + "/")).toBe(true);
      expect(written.path.includes("..")).toBe(false);
      expect(written.path.includes("/escape")).toBe(false);
      expect(verifyStatement(JSON.parse(readFileSync(written.path, "utf8"))).ok).toBe(true);
    } finally {
      lab.close();
    }
  });

  test("the module contains no network code", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "walletstatement.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/new\s+WebSocket|XMLHttpRequest|Bun\.serve/);
  });
});
