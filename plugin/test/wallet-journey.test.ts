import { describe, expect, test } from "bun:test";
import { walletView } from "../src/walletview.ts";
import { createLab, ensureConsumer, CONTRACT_84532, PROVIDER_ID, RECIPIENT, type Lab } from "./support/wallet-lab.ts";
import { TEST_STRANGER, TEST_PAYER } from "./support/signer.ts";
import { LAB_MODEL } from "./support/fake-magpie.ts";
import { nanosToUsd } from "../src/pricing.ts";

/**
 * The wallet UX journey, driven end to end through the production modules.
 *
 * The rule this file exists to enforce: no wording may claim a key is usable, or
 * a top-up complete, from a receipt, a row status or an optimistic timestamp.
 * Only `credited` + an applied ledger deposit + a gateway read-back may say so.
 *
 * Everything below runs on a fake EVM transport and a fake Magpie. There is no
 * signer for a chain transaction and no broadcast path anywhere in the harness,
 * so "zero payments" is structural, not a promise.
 */

const RAW_97 = "1000000"; // 1 token, 6 decimals
const RAW_84532 = "1000000000000000000"; // 1 token, 18 decimals

const byTx = (view: Awaited<ReturnType<typeof walletView>>, txHash: string) => view.deposits.find((d) => d.txHash === txHash)!;

async function creditedOnce(lab: Lab, chainId = 97, raw = RAW_97): Promise<{ invoiceId: string; txHash: string; block: number }> {
  await ensureConsumer(lab, "alice");
  const req = lab.request({ consumerId: "alice", chainId, amountRaw: raw });
  lab.sign(req.intent.invoiceId, req.digest);
  const chain = lab.chainFor(chainId);
  const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: BigInt(raw) });
  chain.mineN(chainId === 97 ? 20 : 2);
  if (chainId === 84532) chain.finalizedAt = chain.head;
  await lab.scan(chainId);
  return { invoiceId: req.intent.invoiceId, txHash: tx.txHash, block: tx.block };
}

describe("wallet UX journey — BSC testnet (confirmations policy)", () => {
  test("signature → payment not seen → confirming → credited → usable, and no duplicate credit", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });

      let view = walletView(await lab.viewInput());
      expect(view.deposits).toHaveLength(1);
      expect(view.deposits[0]!.state).toBe("awaiting-signature");
      expect(view.deposits[0]!.steps.find((s) => s.id === "signature")!.state).toBe("current");
      expect(view.deposits[0]!.keyUsable).toBe(false);
      expect(view.deposits[0]!.nextStep.toLowerCase()).toContain("sign");

      lab.sign(req.intent.invoiceId, req.digest);
      view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("payment-not-seen");
      expect(view.deposits[0]!.steps.find((s) => s.id === "signature")!.state).toBe("done");
      expect(view.deposits[0]!.steps.find((s) => s.id === "payment")!.state).toBe("current");

      // The transfer lands in the current block; with a 15-confirmation policy
      // one later block is nowhere near finality.
      const chain = lab.chainFor(97);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(1);
      const first = await lab.scan(97);
      expect(first.credited).toBe(0);

      view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("confirming");
      expect(view.deposits[0]!.txHash).toBe(tx.txHash);
      expect(view.deposits[0]!.explorerUrl).toBe(`https://testnet.bscscan.com/tx/${tx.txHash}`);
      expect(view.deposits[0]!.steps.find((s) => s.id === "confirmations")!.detail).toContain("/15");
      expect(view.deposits[0]!.keyUsable).toBe(false);

      chain.mineN(20);
      const second = await lab.scan(97);
      expect(second.credited).toBe(1);

      view = walletView(await lab.viewInput());
      const journey = view.deposits[0]!;
      expect(journey.state).toBe("credited");
      expect(journey.keyUsable).toBe(true);
      expect(journey.keyUsableReason.toLowerCase()).toContain("read-back");
      expect(journey.steps.find((s) => s.id === "ledger")!.state).toBe("done");
      expect(journey.steps.find((s) => s.id === "key")!.state).toBe("done");

      const consumer = view.consumers.find((c) => c.consumerId === "alice")!;
      expect(consumer.state).toBe("usable");
      expect(consumer.capUsd).toBeCloseTo(1.0001, 6);
      expect(consumer.usedUsd).toBe(0);
      expect(consumer.balanceUsd).toBeCloseTo(1.0001, 6);
      expect(consumer.readback.fromGateway).toBe(true);

      // A rescan is not a second credit.
      const deposited = lab.ledger.balance("alice").depositedNanos;
      const again = await lab.scan(97);
      expect(again.credited).toBe(0);
      expect(lab.ledger.balance("alice").depositedNanos).toBe(deposited);
      const after = walletView(await lab.viewInput());
      expect(after.deposits.filter((d) => d.state === "credited")).toHaveLength(1);
    } finally {
      lab.close();
    }
  });

  test("a receipt outage is retryable, never 'failed'", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });
      lab.sign(req.intent.invoiceId, req.digest);
      const chain = lab.chainFor(97);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(1);

      chain.failReceipts = true;
      await lab.scan(97);
      let view = walletView(await lab.viewInput());
      let journey = byTx(view, tx.txHash);
      expect(journey.state).toBe("verifying");
      expect(journey.state).not.toBe("failed");
      expect(journey.nextStep.toLowerCase()).toContain("retry");
      expect(journey.keyUsable).toBe(false);
      expect(lab.ledger.balance("alice").depositedNanos).toBe(100_000);

      chain.failReceipts = false;
      chain.mineN(20);
      await lab.scan(97);
      view = walletView(await lab.viewInput());
      journey = byTx(view, tx.txHash);
      expect(journey.state).toBe("credited");
    } finally {
      lab.close();
    }
  });

  test("an RPC outage leaves the payment unseen and the cursor honest", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });
      lab.sign(req.intent.invoiceId, req.digest);
      const chain = lab.chainFor(97);
      chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(1);

      chain.failLogs = true;
      const scan = await lab.scan(97);
      expect(scan.partial).toBe(true);
      let view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("payment-not-seen");
      expect(view.alerts.some((a) => a.kind === "rpc-unavailable")).toBe(true);
      expect(view.deposits[0]!.keyUsable).toBe(false);

      chain.failLogs = false;
      chain.mineN(20);
      await lab.scan(97);
      view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("credited");
    } finally {
      lab.close();
    }
  });

  test("REGRESSION: a cap write Magpie refused keeps the same chain deposit booked, and the retry credits once", async () => {
    // Exact trigger: `setCostLimit` throws (Magpie refused the write) after the
    // chain deposit was booked as an intent and `rec.pending` was set.
    // Old behaviour: the next reconcile() saw that Magpie did not hold the
    // pending cap and marked the chain deposit `failed`; `applyChainDeposit`
    // refuses a failed deposit ("it needs a new id") and the chain path cannot
    // mint one, so the payment was stranded as `crediting` forever.
    // New behaviour: the deposit stays `intent` with the SAME id, and the next
    // scan re-proves canonicality/finality and applies it once.
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });
      lab.sign(req.intent.invoiceId, req.digest);
      const chain = lab.chainFor(97);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(20);

      lab.magpie.failCapWrites = 1;
      await lab.scan(97);
      let view = walletView(await lab.viewInput());
      let journey = byTx(view, tx.txHash);
      expect(journey.state).toBe("crediting");
      expect(journey.keyUsable).toBe(false);
      expect(view.alerts.some((a) => a.kind === "credit-failure")).toBe(true);
      expect(lab.provisioner.find("alice")!.capUsd).toBe(0.0001);

      // `refreshAll()` runs reconcile(), which is what the page and CLI do.
      const event = lab.store.eventsForConsumer("alice", 10)[0]!;
      const depositId = `chain:${event.id}`;
      const booked = lab.ledger.depositsFor("alice").filter((d) => d.id === depositId);
      expect(booked).toHaveLength(1);
      expect(booked[0]!.status).toBe("intent"); // was "failed" before the fix
      expect(lab.ledger.balance("alice").depositedNanos).toBe(100_000);

      // Retry: the watcher re-verifies the block, re-computes the cap from the
      // ledger, and applies the same deposit id.
      await lab.scan(97);
      view = walletView(await lab.viewInput());
      journey = byTx(view, tx.txHash);
      expect(journey.state).toBe("credited");
      expect(journey.keyUsable).toBe(true);
      expect(lab.provisioner.find("alice")!.capUsd).toBeCloseTo(1.0001, 6);
      const applied = lab.ledger.depositsFor("alice").filter((d) => d.id === depositId);
      expect(applied).toHaveLength(1);
      expect(applied[0]!.status).toBe("applied");
      expect(applied[0]!.capAfterNanos).toBe(1_000_100_000);

      // Attribution and the deposit id did not change, and a rescan is a no-op.
      const credited = lab.store.eventsForConsumer("alice", 10)[0]!;
      expect(credited.invoiceId).toBe(req.intent.invoiceId);
      expect(credited.depositId).toBe(depositId);
      const balance = lab.ledger.balance("alice").depositedNanos;
      await lab.scan(97);
      expect(lab.ledger.balance("alice").depositedNanos).toBe(balance);
      expect(lab.ledger.depositsFor("alice").filter((d) => d.id === depositId)).toHaveLength(1);
    } finally {
      lab.close();
    }
  });

  test("REGRESSION: a failed cap write followed by a reorg is never credited — the retry re-checks the chain", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });
      lab.sign(req.intent.invoiceId, req.digest);
      const chain = lab.chainFor(97);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(20);

      lab.magpie.failCapWrites = 1;
      await lab.scan(97);
      const event = lab.store.eventsForConsumer("alice", 10)[0]!;
      const depositId = `chain:${event.id}`;
      expect(lab.ledger.depositsFor("alice").find((d) => d.id === depositId)!.status).toBe("intent");

      // The block that carried the payment moves before the retry.
      chain.reorg(tx.block);
      await lab.scan(97);

      const view = walletView(await lab.viewInput());
      const journey = byTx(view, tx.txHash);
      expect(journey.state).toBe("reverted");
      expect(journey.keyUsable).toBe(false);
      expect(view.alerts.some((a) => a.kind === "reverted")).toBe(true);
      // Nothing was guessed: the deposit stays booked, not applied, not deleted.
      const booked = lab.ledger.depositsFor("alice").find((d) => d.id === depositId)!;
      expect(booked.status).toBe("intent");
      expect(journey.steps.find((s) => s.id === "ledger")!.state).toBe("blocked");
      expect(lab.ledger.balance("alice").depositedNanos).toBe(100_000);
      expect(lab.provisioner.find("alice")!.capUsd).toBe(0.0001);
      expect(lab.store.eventsForConsumer("alice", 10)[0]!.status).toBe("reverted");
    } finally {
      lab.close();
    }
  });

  test("a read-back failure after a successful cap write retries to credited", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });
      lab.sign(req.intent.invoiceId, req.digest);
      const chain = lab.chainFor(97);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(20);

      // Magpie applies the cap, but the read-back fails: the deposit stays an
      // intent and `reconcile()` can prove the cap on the next attempt.
      lab.magpie.failLimitReads = 1;
      await lab.scan(97);
      let view = walletView(await lab.viewInput());
      let journey = byTx(view, tx.txHash);
      expect(["crediting", "credited"]).toContain(journey.state);
      expect(journey.keyUsable).toBe(false);

      await lab.scan(97);
      view = walletView(await lab.viewInput());
      journey = byTx(view, tx.txHash);
      expect(journey.state).toBe("credited");
      expect(journey.keyUsable).toBe(true);
      expect(lab.provisioner.find("alice")!.capUsd).toBeCloseTo(1.0001, 6);
    } finally {
      lab.close();
    }
  });

  test("credited without an applied deposit or read-back is 'unproven', not usable", async () => {
    const lab = createLab();
    try {
      await creditedOnce(lab);

      let view = walletView(await lab.viewInput({ readbacks: {} }));
      expect(view.deposits[0]!.state).toBe("unproven");
      expect(view.deposits[0]!.keyUsable).toBe(false);
      expect(view.deposits[0]!.keyUsableReason.toLowerCase()).toContain("read-back");
      expect(view.consumers[0]!.state).toBe("unverified");

      view = walletView(await lab.viewInput({ deposits: {} }));
      expect(view.deposits[0]!.keyUsable).toBe(false);
      expect(view.deposits[0]!.keyUsableReason.toLowerCase()).toContain("applied");
      expect(view.evidence.appliedDeposits).toBe(0);
    } finally {
      lab.close();
    }
  });

  test("expired intent: a later transfer is unclaimed, not lost and not credited", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97, ttlSec: 60 });
      lab.sign(req.intent.invoiceId, req.digest);
      lab.advance(120_000);

      const chain = lab.chainFor(97);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(20);
      await lab.scan(97);

      const view = walletView(await lab.viewInput());
      const journey = view.deposits.find((d) => d.txHash === tx.txHash)!;
      expect(journey.state).toBe("unclaimed");
      expect(journey.nextStep.toLowerCase()).toContain("contact");
      expect(journey.keyUsable).toBe(false);
      expect(view.alerts.some((a) => a.kind === "unclaimed")).toBe(true);
      expect(lab.ledger.balance("alice").depositedNanos).toBe(100_000);
      expect(nanosToUsd(lab.ledger.balance("alice").depositedNanos)).toBeCloseTo(0.0001, 6);
    } finally {
      lab.close();
    }
  });

  test("two signed intents for the same amount make the transfer uncertain, never credited", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const a = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });
      const b = lab.request({ consumerId: "alice", chainId: 97, amountRaw: RAW_97 });
      lab.sign(a.intent.invoiceId, a.digest);
      lab.sign(b.intent.invoiceId, b.digest);
      const chain = lab.chainFor(97);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(20);
      await lab.scan(97);

      const view = walletView(await lab.viewInput());
      const journey = byTx(view, tx.txHash);
      expect(journey.state).toBe("uncertain");
      expect(journey.keyUsable).toBe(false);
      expect(journey.nextStep.toLowerCase()).toContain("manual");
      expect(lab.ledger.balance("alice").depositedNanos).toBe(100_000);
    } finally {
      lab.close();
    }
  });

  test("a reorg freezes, keeps the deposit and never edits the balance", async () => {
    const lab = createLab();
    try {
      const { block } = await creditedOnce(lab);
      const before = lab.ledger.balance("alice").depositedNanos;
      const capBefore = lab.provisioner.find("alice")!.capUsd;

      lab.chainFor(97).reorg(block);
      await lab.scan(97);

      const view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("reverted");
      expect(view.deposits[0]!.keyUsable).toBe(false);
      expect(view.alerts.some((a) => a.kind === "reverted")).toBe(true);
      expect(lab.ledger.balance("alice").depositedNanos).toBe(before);
      const consumer = view.consumers[0]!;
      expect(consumer.state).toBe("paused");
      expect(consumer.paused?.reason).toBeTruthy();
      expect(lab.provisioner.find("alice")!.capUsd).toBe(capBefore);
      // The reverted credit stays visible as a deposit for audit.
      expect(lab.ledger.depositsFor("alice").some((d) => d.status === "applied")).toBe(true);
    } finally {
      lab.close();
    }
  });

  test("Magpie reporting 'no limit' is UNKNOWN, never 'zero credit'", async () => {
    const lab = createLab();
    try {
      await creditedOnce(lab);
      const rec = lab.provisioner.find("alice")!;
      const key = lab.magpie.keyById(rec.keyId)!;
      lab.magpie.noLimitFor.add(key.id);
      const k = lab.magpie.keys.get(key.id)!;
      k.cap = 0;

      const view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.keyUsable).toBe(false);
      expect(view.consumers[0]!.state).toBe("unverified");
      expect(view.consumers[0]!.stateDetail.toLowerCase()).toContain("limit");

      // A caller that supplies a synthetic cap-0 read-back gets the same answer.
      const fabricated = walletView(
        await lab.viewInput({
          readbacks: { alice: { at: "2026-10-30T12:00:00.000Z", capUsd: 0, usedUsd: 0, leftUsd: 0, fromGateway: true } },
        }),
      );
      expect(fabricated.deposits[0]!.keyUsable).toBe(false);
      expect(fabricated.consumers[0]!.state).toBe("unproven");
      expect(fabricated.consumers[0]!.stateDetail.toLowerCase()).toContain("unlimited");
    } finally {
      lab.close();
    }
  });
});

describe("wallet UX journey — Base Sepolia and parity", () => {
  test("Base follows the same steps, with its own finality condition", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "bob");
      const chain = lab.chainFor(84532);
      chain.finalizedAt = -1; // the tag has not reached the payment block yet
      const req = lab.request({ consumerId: "bob", chainId: 84532, amountRaw: RAW_84532 });
      lab.sign(req.intent.invoiceId, req.digest);
      const tx = chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: 1_000_000_000_000_000_000n });
      chain.mineN(2);
      await lab.scan(84532);

      let view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("confirming");
      expect(view.deposits[0]!.explorerUrl).toBe(`https://sepolia.basescan.org/tx/${tx.txHash}`);
      expect(view.deposits[0]!.steps.find((s) => s.id === "confirmations")!.detail.toLowerCase()).toContain("finalized");

      chain.finalizedAt = chain.head;
      await lab.scan(84532);
      view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("credited");
      expect(view.deposits[0]!.keyUsable).toBe(true);
      expect(view.consumers[0]!.capUsd).toBeCloseTo(1.0001, 6);
      // 18 decimals credit exactly one test USD, no float drift.
      expect(view.consumers[0]!.chainCredit.find((c) => c.chainId === 84532)!.creditedUsd).toBeCloseTo(1, 9);
    } finally {
      lab.close();
    }
  });

  test("both chains render the same shape and vocabulary", async () => {
    const stepStates = async (chainId: number, raw: string) => {
      const lab = createLab();
      try {
        await ensureConsumer(lab, "cara");
        const req = lab.request({ consumerId: "cara", chainId, amountRaw: raw });
        lab.sign(req.intent.invoiceId, req.digest);
        const chain = lab.chainFor(chainId);
        chain.transfer({ from: TEST_PAYER, to: RECIPIENT, amount: BigInt(raw) });
        chain.mineN(chainId === 97 ? 20 : 2);
        if (chainId === 84532) chain.finalizedAt = chain.head;
        await lab.scan(chainId);
        const view = walletView(await lab.viewInput());
        return {
          steps: view.deposits[0]!.steps.map((s) => s.state),
          chainKeys: Object.keys(view.chains.find((c) => c.chainId === chainId)!).sort(),
          totalsKeys: Object.keys(view.chains.find((c) => c.chainId === chainId)!.totals).sort(),
          json: JSON.stringify(view),
        };
      } finally {
        lab.close();
      }
    };

    const bsc = await stepStates(97, RAW_97);
    const base = await stepStates(84532, RAW_84532);
    expect(base.steps).toEqual(bsc.steps);
    expect(base.chainKeys).toEqual(bsc.chainKeys);
    expect(base.totalsKeys).toEqual(bsc.totalsKeys);
    for (const text of [bsc.json, base.json]) {
      expect(text).not.toMatch(/\b(primary|secondary|preferred|fallbackChain|isDefault|priority)\b/i);
    }
  });

  test("the same journey works with a stranger's transfer: unclaimed, never guessed", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "dave");
      const chain = lab.chainFor(97);
      chain.transfer({ from: TEST_STRANGER, to: RECIPIENT, amount: 1_000_000n });
      chain.mineN(20);
      await lab.scan(97);
      const view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("unclaimed");
      expect(view.deposits[0]!.nextStep.toLowerCase()).toContain("contact");
      expect(lab.ledger.balance("dave").depositedNanos).toBe(100_000);
      expect(view.consumers[0]!.chainCredit[0]!.creditedEvents).toBe(0);
    } finally {
      lab.close();
    }
  });
});
