import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainStore } from "../src/chainstore.ts";
import { Wallet, type WalletStatus } from "../src/wallet.ts";
import { defaultRegistry } from "../src/networks.ts";
import { accountingLine, explorerTxUrl, journeyLines, walletView, type WalletViewInput } from "../src/walletview.ts";
import type { CreditSink } from "../src/watcher.ts";
import { createLab, ensureConsumer, RECIPIENT } from "./support/wallet-lab.ts";
import { TEST_PAYER } from "./support/signer.ts";

/**
 * Unit behaviour of the pure view model and of the zero-RPC status.
 *
 * The journey file proves the state machine against the production modules; this
 * one pins the pieces that are easy to get subtly wrong: cumulative aggregates,
 * plain-text explorer URLs, wording that must never appear, and the rule that a
 * status snapshot cannot open a socket.
 */

function emptySink(): CreditSink {
  return {
    depositIntent: () => ({ created: true }),
    applyDeposit: async () => {},
    freezeConsumer: async () => {},
    balance: () => ({ depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 }),
  };
}

function emptyWallet(): WalletStatus {
  return {
    registry: {
      networks: defaultRegistry()
        .networks()
        .map((n) => ({
          chainId: n.chainId,
          displayName: n.displayName,
          networkType: n.networkType,
          support: n.support,
          receivable: n.receivable,
          enabled: n.enabled,
          blockExplorer: n.blockExplorer,
          finality: { mode: n.finality.mode, confirmations: n.finality.confirmations, rationale: n.finality.rationale },
          endpoints: n.rpcEndpoints,
        })),
      assets: [],
    },
    chains: [],
    intents: [],
    events: [],
    anomalies: [],
    receiving: [],
    totals: {
      credited: 0,
      finalized: 0,
      crediting: 0,
      pending: 0,
      unclaimed: 0,
      uncertain: 0,
      reverted: 0,
      manualReview: 0,
      failed: 0,
      creditedNanos: 0,
      events: 0,
      byChain: [],
    },
    consumers: [],
    disabled: false,
  };
}

function fakeConsumer(overrides: Record<string, unknown> = {}): NonNullable<WalletViewInput["consumers"]>[number] {
  return {
    consumerId: "alice",
    keyName: "ohmyaihub-alice",
    models: ["lab/lab-model"],
    capUsd: 1,
    usedUsd: 0,
    leftUsd: 1,
    calls: 0,
    spent: false,
    reset: "2036-10-30T00:00:00.000Z",
    pending: false,
    paused: null,
    revokedAt: null,
    priceVersion: "price-v1",
    ledger: {
      priceVersion: "price-v1",
      windowId: "w1",
      start: "2026-10-30T00:00:00.000Z",
      reset: "2036-10-30T00:00:00.000Z",
      depositedUsd: 1.0001,
      consumedUsd: 0,
      balanceUsd: 1.0001,
      overdraftUsd: 0,
      unsettledUsd: 0,
      unpricedCalls: 0,
      openSettlements: 0,
      uncertain: null,
      gaps: [],
    },
    ...overrides,
  } as NonNullable<WalletViewInput["consumers"]>[number];
}

describe("wallet view — zero-RPC local status", () => {
  test("statusLocal never constructs a watcher or touches a chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "wallet-view-"));
    const wallet = new Wallet({
      credit: emptySink(),
      registry: defaultRegistry(),
      store: new ChainStore(join(dir, "chain.sqlite")),
      makeWatcher: () => {
        throw new Error("statusLocal must not build a watcher");
      },
    });
    const status = wallet.statusLocal();
    expect(status.chains).toHaveLength(2);
    for (const chain of status.chains) {
      expect(chain.head).toBeNull();
      expect(chain.finalizedBlock).toBeNull();
      expect(chain.endpoints).toEqual([]);
    }
    wallet.close();
  });

  test("totals are aggregates over the whole table, not over the last 100 rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "wallet-totals-"));
    const store = new ChainStore(join(dir, "chain.sqlite"));
    const events = Array.from({ length: 120 }, (_, i) => ({
      tokenContract: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      logIndex: 0,
      blockNumber: i + 1,
      blockHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      from: TEST_PAYER,
      to: RECIPIENT,
      amountRaw: "1000000",
    }));
    store.commitPage({ chainId: 97, block: 120, blockHash: null, events });
    const wallet = new Wallet({
      credit: emptySink(),
      registry: defaultRegistry(),
      store,
      makeWatcher: () => {
        throw new Error("a local status must not build a watcher");
      },
    });
    const status = wallet.statusLocal();
    // 120 stored, all `observed` because commitPage had no confirmations.
    expect(status.totals.events).toBe(120);
    expect(status.totals.pending).toBe(120);
    expect(status.totals.byChain.find((c) => c.chainId === 97)!.pending).toBe(120);
    // The page list stays bounded, and the totals do not come from it.
    expect(status.events.length).toBe(100);
    wallet.close();
  });

  test("per-consumer chain credit is a SQL aggregate and is separate from the ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "wallet-credit-"));
    const store = new ChainStore(join(dir, "chain.sqlite"));
    const intent = {
      invoiceId: "inv-1",
      providerId: "provider-a",
      consumerId: "alice",
      chainId: 97,
      assetId: "eip155:97:0x5fbdb2315678afecb367f032d93f642f64180aa3",
      tokenContract: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      recipientAddress: RECIPIENT,
      expectedAmountRaw: "1000000",
      requestedAt: "2026-10-30T12:00:00.000Z",
      expiresAt: "2036-10-30T12:00:00.000Z",
      payerAddress: TEST_PAYER,
      attributionStatus: "signed" as const,
      priceVersion: "rate-v1",
      status: "signed" as const,
      nonce: "n-1",
      digest: `0x${"11".repeat(32)}`,
      createdAt: "2026-10-30T12:00:00.000Z",
      rateNanosPerToken: "1000000000",
      rateDecimals: 6,
      rateAssetId: "eip155:97:0x5fbdb2315678afecb367f032d93f642f64180aa3",
    };
    store.insertIntent(intent);
    const txHash = `0x${"22".repeat(32)}`;
    const { created } = store.commitPage({
      chainId: 97,
      block: 10,
      blockHash: null,
      events: [
        {
          tokenContract: intent.tokenContract,
          txHash,
          logIndex: 0,
          blockNumber: 10,
          blockHash: `0x${"33".repeat(32)}`,
          from: TEST_PAYER,
          to: RECIPIENT,
          amountRaw: "1000000",
        },
      ],
    });
    const event = created[0]!;
    store.claim({ eventId: event.id, invoiceId: intent.invoiceId });
    store.recordConversion({ id: event.id, nanos: 1_000_000_000, nanosPerToken: "1000000000", priceVersion: "rate-v1" });
    store.markCredited(event.id, `chain:${event.id}`);

    const wallet = new Wallet({
      credit: emptySink(),
      registry: defaultRegistry(),
      store,
      makeWatcher: () => {
        throw new Error("a credit aggregate must not build a watcher");
      },
    });
    const credit = wallet.consumerChainCredit("alice");
    expect(credit.chainCreditedNanos).toBe(1_000_000_000);
    expect(credit.chainCredit.find((c) => c.chainId === 97)!.credited).toBe(1);
    expect(credit.chainCredit.find((c) => c.chainId === 84532)!.credited).toBe(0);
    // A consumer with no chain activity still appears when the host names it.
    const withIds = wallet.statusLocal({ consumerIds: ["alice", "bob"] });
    expect(withIds.consumers.map((c) => c.consumerId)).toEqual(["alice", "bob"]);
    expect(withIds.consumers.find((c) => c.consumerId === "bob")!.chainCreditedNanos).toBe(0);
    wallet.close();
  });
});

describe("wallet view — mapping and wording", () => {
  test("explorer URLs are plain text and trimmed of a trailing slash", () => {
    expect(explorerTxUrl("https://testnet.bscscan.com/", "0xabc")).toBe("https://testnet.bscscan.com/tx/0xabc");
    expect(explorerTxUrl("https://sepolia.basescan.org", "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  test("a consumer with no read-back is unverified, never usable", () => {
    const view = walletView({ wallet: emptyWallet(), consumers: [fakeConsumer()] });
    const consumer = view.consumers[0]!;
    expect(consumer.state).toBe("unverified");
    expect(consumer.stateDetail.toLowerCase()).toContain("read-back");
    expect(view.evidence.readbacks).toBe(0);
  });

  test("read-back with cap 0 is 'unlimited', never 'zero credit'", () => {
    const view = walletView({
      wallet: emptyWallet(),
      consumers: [fakeConsumer()],
      readbacks: { alice: { at: "2026-10-30T12:00:00.000Z", capUsd: 0, usedUsd: 0, leftUsd: 0, fromGateway: true } },
    });
    expect(view.consumers[0]!.state).toBe("unproven");
    expect(view.consumers[0]!.stateDetail.toLowerCase()).toContain("unlimited");
  });

  test("a spent key and a paused key are distinct states", () => {
    const spent = walletView({
      wallet: emptyWallet(),
      consumers: [fakeConsumer({ leftUsd: 0 })],
      readbacks: { alice: { at: "2026-10-30T12:00:00.000Z", capUsd: 1, usedUsd: 1, leftUsd: 0, fromGateway: true } },
    });
    expect(spent.consumers[0]!.state).toBe("spent");

    const paused = walletView({
      wallet: emptyWallet(),
      consumers: [
        fakeConsumer({
          paused: { reason: "price-mismatch", detail: "the price changed", enforcement: "keyRevoked", enforced: true, windowId: "w1" },
        }),
      ],
    });
    expect(paused.consumers[0]!.state).toBe("paused");
    expect(paused.alerts.some((a) => a.kind === "consumer-paused" && /NOT|not stopped|keyRevoked/.test(a.detail))).toBe(true);
    expect(paused.alerts.find((a) => a.kind === "consumer-paused")!.nextStep.toLowerCase()).toContain("reissue");
  });

  test("accounting uncertainty keeps the key's own state honest", () => {
    const view = walletView({
      wallet: emptyWallet(),
      consumers: [fakeConsumer()],
      readbacks: { alice: { at: "2026-10-30T12:00:00.000Z", capUsd: 1, usedUsd: 0, leftUsd: 1, fromGateway: true } },
      accounting: { state: "uncertain", reason: "a usage row could not be read", serving: false },
    });
    expect(view.consumers[0]!.state).toBe("usable-but-export-withdrawn");
    expect(view.alerts.some((a) => a.kind === "accounting-uncertain")).toBe(true);
  });

  test("overdraft and unsettled amounts are shown as they are", () => {
    const view = walletView({
      wallet: emptyWallet(),
      consumers: [
        fakeConsumer({
          ledger: {
            ...fakeConsumer().ledger!,
            consumedUsd: 0.75,
            balanceUsd: -0.5,
            overdraftUsd: 0.5,
            unsettledUsd: 0.25,
            openSettlements: 1,
          },
        }),
      ],
    });
    const consumer = view.consumers[0]!;
    expect(consumer.balanceUsd).toBe(-0.5);
    expect(consumer.overdraftUsd).toBe(0.5);
    expect(consumer.unsettledUsd).toBe(0.25);
    expect(consumer.openSettlements).toBe(1);
    expect(consumer.cumulativeCreditUsd).toBe(1.0001);
    expect(consumer.consumedUsd).toBe(0.75);
    expect(consumer.settledUsd).toBe(0.5);
    expect(accountingLine(consumer)).toContain("consumed 0.750000");
    expect(accountingLine(consumer)).toContain("settled 0.500000");
  });

  test("a filled history says it is truncated instead of implying it is complete", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      for (let i = 0; i < 101; i++) {
        lab.request({ consumerId: "alice", chainId: 97, amountRaw: "1000000" });
      }
      const status = lab.statusLocal();
      const view = walletView(await lab.viewInput());
      expect(status.intents.length).toBe(100);
      expect(view.truncated).toBe(true);
    } finally {
      lab.close();
    }
  });

  test("no wording claims success without evidence, and no chain is privileged", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const view = walletView(await lab.viewInput());
      const text = JSON.stringify(view);
      for (const forbidden of [/\bfunds? (were|are) lost\b/i, /\btop-?up complete\b/i, /\bpayment failed\b/i, /\b0\.0000 credit\b/i, /\bprimary\b|\bsecondary\b|\bpreferred\b|\bfallback chain\b/i]) {
        expect(text).not.toMatch(forbidden);
      }
      const unclaimedView = walletView({
        wallet: emptyWallet(),
        consumers: [fakeConsumer()],
      });
      expect(unclaimedView.disabled).toBe(false);
    } finally {
      lab.close();
    }
  });

  test("a cancelled request is its own state, not a failure", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: "1000000" });
      lab.wallet.cancelIntent(req.intent.invoiceId, "test: no longer needed");
      const view = walletView(await lab.viewInput());
      expect(view.deposits[0]!.state).toBe("cancelled");
      expect(view.deposits[0]!.nextStep.toLowerCase()).toContain("create a new one");
    } finally {
      lab.close();
    }
  });

  test("an expired request says the money is not lost", async () => {
    const lab = createLab();
    try {
      await ensureConsumer(lab, "alice");
      const req = lab.request({ consumerId: "alice", chainId: 97, amountRaw: "1000000" });
      lab.store.setIntentStatus(req.intent.invoiceId, "expired");
      const view = walletView(await lab.viewInput());
      const journey = view.deposits[0]!;
      expect(journey.state).toBe("expired");
      expect(journey.nextStep.toLowerCase()).toContain("unclaimed");
      expect(journey.nextStep.toLowerCase()).toContain("not lost");
    } finally {
      lab.close();
    }
  });

  test("no chain is named in the view's own vocabulary", async () => {
    const lab = createLab();
    try {
      const view = walletView(await lab.viewInput());
      const chainFields = view.chains.map((c) => Object.keys(c).sort());
      expect(chainFields[0]).toEqual(chainFields[1]);
      expect(view.chains.map((c) => c.finality.mode)).toEqual(["confirmations", "finalized-tag"]);
    } finally {
      lab.close();
    }
  });
});
