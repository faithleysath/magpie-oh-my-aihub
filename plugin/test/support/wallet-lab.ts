// A wallet lab: production Wallet / ChainWatcher / ChainStore / Ledger / Provisioner
// over a fake EVM and a fake Magpie.
//
// This is the wiring `Service.chainCreditSink()` uses, reproduced in five lines
// because that method is private. Everything that decides credit, finality and
// cap arithmetic is the production code; only the transport and Magpie's CLI
// surface are fake. No key material and no broadcast path exists here.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainStore } from "../../src/chainstore.ts";
import { ChainWatcher, type CreditSink } from "../../src/watcher.ts";
import { EvmClient } from "../../src/evm.ts";
import { Ledger } from "../../src/ledger.ts";
import { Provisioner } from "../../src/provisioner.ts";
import { Wallet, type WalletStatus } from "../../src/wallet.ts";
import { defaultRegistry, type AssetRecord, type NetworkRegistry } from "../../src/networks.ts";
import { priceSnapshot } from "../../src/pricing.ts";
import { FakeChain } from "./fake-chain.ts";
import { FakeMagpie, LAB_MODEL } from "./fake-magpie.ts";
import { signDigest, TEST_PAYER } from "./signer.ts";
import type { WalletViewInput } from "../../src/walletview.ts";
import type { KeyReadback } from "../../src/walletview.ts";
import type { LedgerDepositLike } from "../../src/walletview.ts";

/** One fixture clock for every production class that accepts `now`. */
export const labNow = (lab: Lab) => () => new Date(lab.clock.at);

export const RECIPIENT = "0x3d80c477021e3fa568e91c73baec8e806518d9a6";
export const PROVIDER_ID = "provider-a";
export const CONTRACT_97 = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const CONTRACT_84532 = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";

const CHAINS = [
  { chainId: 97, contract: CONTRACT_97, decimals: 6, symbol: "tMOCK6", name: "Mock Token 6" },
  { chainId: 84532, contract: CONTRACT_84532, decimals: 18, symbol: "tMOCK18", name: "Mock Token 18" },
] as const;

export interface Lab {
  dir: string;
  registry: NetworkRegistry;
  store: ChainStore;
  ledger: Ledger;
  magpie: FakeMagpie;
  provisioner: Provisioner;
  wallet: Wallet;
  chains: Map<number, FakeChain>;
  assets: Map<number, AssetRecord>;
  clock: { at: Date };
  /** The same fixture clock in epoch milliseconds (browser adapters take `now`). */
  nowMs(): number;
  advance(ms: number): void;
  chainFor(chainId: number): FakeChain;
  assetFor(chainId: number): AssetRecord;
  scan(chainId: number): Promise<Awaited<ReturnType<Wallet["scanNow"]>>>;
  request(input: { consumerId: string; chainId: number; amountRaw: string; ttlSec?: number }): ReturnType<Wallet["requestIntent"]>;
  sign(invoiceId: string, digest: string): ReturnType<Wallet["signIntent"]>;
  views(): ReturnType<Provisioner["all"]>;
  readbacks(): Promise<Record<string, KeyReadback>>;
  deposits(): Record<string, LedgerDepositLike[]>;
  viewInput(overrides?: Partial<WalletViewInput>): Promise<WalletViewInput>;
  statusLocal(): WalletStatus;
  close(): void;
}

export function createLab(opts: { initialLookback?: number } = {}): Lab {
  const dir = mkdtempSync(join(tmpdir(), "wallet-ux-"));
  const registry = defaultRegistry();
  const chains = new Map<number, FakeChain>();
  const assets = new Map<number, AssetRecord>();

  for (const c of CHAINS) {
    assets.set(
      c.chainId,
      registry.registerTestAsset({
        chainId: c.chainId,
        contractAddress: c.contract,
        symbol: c.symbol,
        name: c.name,
        decimals: c.decimals,
        nanosPerToken: "1000000000",
        pricingNote: "fixed test rate: 1 token = 1 test USD",
      }),
    );
    chains.set(c.chainId, new FakeChain({ chainId: c.chainId, contract: c.contract, decimals: c.decimals }));
  }

  const clock = { at: new Date("2026-10-30T12:00:00.000Z") };
  const now = () => new Date(clock.at);
  const store = new ChainStore(join(dir, "chain.sqlite"));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  const magpie = new FakeMagpie();
  // `Provisioner` loads `<cwd>/oh-my-aihub/consumers.json` in its constructor.
  // Another test file may have changed the process cwd, so construct the lab
  // inside its own empty directory and restore immediately. Without this, a
  // foreign consumers.json would be adopted by this ledger.
  const cwd = process.cwd();
  let provisioner: Provisioner;
  try {
    process.chdir(dir);
    provisioner = new Provisioner(magpie as never, {
      ledger,
      prices: async (models) => priceSnapshot(magpie.metas(), models),
      usageLog: () => magpie.logPath,
      drainMs: 0,
      save: () => {},
    });
  } finally {
    process.chdir(cwd);
  }

  const sink: CreditSink = {
    depositIntent: (input) => {
      const r = ledger.depositIntent({ id: input.id, consumerId: input.consumerId, amountNanos: input.amountNanos, source: input.source });
      return { created: r.created };
    },
    applyDeposit: async (input) => {
      await provisioner.applyChainDeposit(input);
    },
    freezeConsumer: async (consumerId, reason) => {
      ledger.setPaused(consumerId, `chain-reorg: ${reason}`);
      const rec = provisioner.find(consumerId);
      if (rec) await provisioner.pauseForChain(consumerId, reason);
    },
    balance: (consumerId) => {
      const b = ledger.balance(consumerId);
      return { depositedNanos: b.depositedNanos, consumedNanos: b.consumedNanos, balanceNanos: b.balanceNanos };
    },
  };

  const wallet = new Wallet({
    credit: sink,
    registry,
    store,
    now,
    initialLookback: opts.initialLookback ?? 500,
    makeWatcher: (deps) =>
      new ChainWatcher({
        ...deps,
        client: new EvmClient({
          chainId: deps.network.chainId,
          endpoints: ["http://fake"],
          fetchImpl: ((url: string, init?: RequestInit) => chainFor(deps.network.chainId).fetch(url, init)) as typeof fetch,
        }),
      }),
  });

  function chainFor(chainId: number): FakeChain {
    const c = chains.get(chainId);
    if (!c) throw new Error(`no fake chain ${chainId}`);
    return c;
  }
  function assetFor(chainId: number): AssetRecord {
    const a = assets.get(chainId);
    if (!a) throw new Error(`no asset on chain ${chainId}`);
    return a;
  }

  const lab: Lab = {
    dir,
    registry,
    store,
    ledger,
    magpie,
    provisioner,
    wallet,
    chains,
    assets,
    clock,
    nowMs: () => clock.at.getTime(),
    advance(ms) {
      clock.at = new Date(clock.at.getTime() + ms);
    },
    chainFor,
    assetFor,
    scan: (chainId) => wallet.scanNow(chainId),
    request: (input) =>
      wallet.requestIntent({
        providerId: PROVIDER_ID,
        consumerId: input.consumerId,
        chainId: input.chainId,
        assetId: assetFor(input.chainId).assetId,
        amountRaw: input.amountRaw,
        ttlSec: input.ttlSec,
      }),
    sign: (invoiceId, digest) => wallet.signIntent({ invoiceId, signature: signDigest(digest), payerAddress: TEST_PAYER }),
    views: () => provisioner.all(),
    async readbacks() {
      const out: Record<string, KeyReadback> = {};
      for (const c of provisioner.all()) {
        const rec = provisioner.find(c.consumerId);
        if (!rec || c.revokedAt || c.paused) continue;
        try {
          const st = await provisioner.verify(rec);
          const lim = st.limit;
          if (!lim) continue;
          out[c.consumerId] = {
            // This measures the real Provisioner/Ledger, whose appliedAt uses
            // wallclock. The controllable chain-expiry clock may be behind it;
            // stamping that clock here fabricates evidence predating the credit.
            at: new Date().toISOString(),
            capUsd: lim.costLimit ?? 0,
            usedUsd: lim.cost ?? 0,
            leftUsd: lim.costLeft ?? 0,
            fromGateway: true,
          };
        } catch {
          // an unreadable key is not evidence; leave it absent
        }
      }
      return out;
    },
    deposits() {
      const out: Record<string, LedgerDepositLike[]> = {};
      for (const c of provisioner.all()) out[c.consumerId] = ledger.depositsFor(c.consumerId);
      return out;
    },
    async viewInput(overrides = {}) {
      // The host path: `refreshAll()` performs a real gateway read-back, which is
      // the only evidence a key's cap may be trusted.
      const consumers = await provisioner.refreshAll();
      return {
        wallet: wallet.statusLocal({ consumerIds: consumers.map((c) => c.consumerId) }),
        consumers,
        deposits: lab.deposits(),
        readbacks: await lab.readbacks(),
        accounting: { state: "ok" as const, reason: null, serving: true },
        now: now(),
        ...overrides,
      };
    },
    statusLocal: () => wallet.statusLocal({ consumerIds: provisioner.all().map((c) => c.consumerId) }),
    close() {
      wallet.stop();
      store.close();
      ledger.close();
    },
  };

  wallet.setReceivingAddress(PROVIDER_ID, 97, RECIPIENT);
  wallet.setReceivingAddress(PROVIDER_ID, 84532, RECIPIENT);

  return lab;
}

export async function ensureConsumer(lab: Lab, consumerId = "alice", capUsd = 0.0001) {
  return lab.provisioner.ensure(consumerId, { models: [LAB_MODEL], capUsd });
}
