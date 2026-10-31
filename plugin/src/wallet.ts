// The wallet module's public surface: registry, intents, watchers, status.
//
// This is the only place where the chain side meets the credit side, and it
// meets it through `Provisioner.applyChainDeposit()` — the phase-6 path that
// already knows how to write Magpie's cap, read it back, and reconcile a crash.
// The chain module therefore cannot reach Magpie's Gateway Key directly: it can
// only ask the provisioner to book a deposit that the ledger already holds.
//
// Boundaries kept here, deliberately:
//
//  - No private key is stored, generated or used. `setReceivingAddress` records
//    an address the provider already owns; `signIntent` verifies a signature the
//    consumer's own wallet produced.
//  - One watcher per enabled chain, started and stopped independently, so one
//    chain's RPC failure cannot stall another's deposits.
//  - A consumer's chain credit is a normal ledger deposit. There is no second
//    balance, and nothing here computes "available" on its own.

import { logger } from "./log.ts";
import { ChainStore, type ChainDepositEvent, type ChainAnomaly } from "./chainstore.ts";
import {
  loadRegistry,
  type AssetRecord,
  type NetworkRecord,
  type NetworkRegistry,
} from "./networks.ts";
import {
  buildIntent,
  intentDigest,
  intentTypedData,
  verifyIntentSignature,
  isExpired,
  type DepositIntent,
  type SignableIntent,
} from "./deposits.ts";
import { ChainWatcher, convertRawToNanos, type ChainHealth, type CreditSink, type ScanResult } from "./watcher.ts";
import { EvmClient } from "./evm.ts";
import { nanosToUsd, usdToNanos } from "./pricing.ts";
import { ReadOnlyChainReader, type ReadOnlyBalance, type ReadOnlyBalanceInput, type ReadOnlyChainSummary } from "./readonly-balance.ts";
import { ReceivingNetworkPolicy, type PaymentRequestVerdict, type ReceivingSelection } from "./receiving-networks.ts";
import { assertNoMainnetCredit, isMainnetChainId } from "./mainnet-gate.ts";

/** The receiving addresses a provider has published, keyed by `(providerId, chainId)`. */
export interface ReceivingAddress {
  providerId: string;
  chainId: number;
  address: string;
  addedAt: string;
}

export interface WalletDeps {
  /** the ledger, through the provisioner's own deposit path */
  credit: CreditSink;
  /** where the registry and the chain store live; defaults to the plugin state dir */
  registryPath?: string;
  chainDbPath?: string;
  /** injected in tests */
  makeWatcher?: (deps: ConstructorParameters<typeof ChainWatcher>[0]) => ChainWatcher;
  registry?: NetworkRegistry;
  store?: ChainStore;
  now?: () => Date;
  /** how many blocks a first scan looks back */
  initialLookback?: number;
  /** receiving-network selection file; defaults to the plugin state dir */
  receivingPath?: string;
  /** injected for read-only balance tests */
  readOnlyFetch?: typeof fetch;
}

/** Event totals over the whole store, never over a truncated page of rows. */
export interface ChainEventTotals {
  credited: number;
  finalized: number;
  /** finalized but the ledger has not applied it yet */
  crediting: number;
  /** observed + confirming */
  pending: number;
  unclaimed: number;
  uncertain: number;
  reverted: number;
  manualReview: number;
  failed: number;
  creditedNanos: number;
  events: number;
}

export interface WalletTotals extends ChainEventTotals {
  byChain: ({ chainId: number } & ChainEventTotals)[];
}

export interface ConsumerChainCredit extends ChainEventTotals {
  chainId: number;
}

/**
 * Chain credit per consumer, for the "wallet credit" view.
 *
 * `ledger` is the ledger's own balance (which includes simulated credits), and
 * `chainCredit` is the chain-attributed part. They are shown separately on
 * purpose: adding them would double-count nothing but would mislabel a
 * simulated top-up as a chain deposit.
 */
export interface WalletConsumerCredit {
  consumerId: string;
  chainCredit: ConsumerChainCredit[];
  chainCreditedNanos: number;
  ledger: { depositedNanos: number; consumedNanos: number; balanceNanos: number } | null;
  updatedAt: string | null;
}

export interface StatusOptions {
  /** consumers to describe even when they have no chain intent yet */
  consumerIds?: string[];
}

export interface WalletStatus {
  registry: {
    networks: {
      chainId: number;
      displayName: string;
      networkType: string;
      support: string;
      receivable: boolean;
      enabled: boolean;
      blockExplorer: string;
      finality: { mode: string; confirmations: number; rationale: string };
      endpoints: string[];
    }[];
    assets: {
      assetId: string;
      chainId: number;
      symbol: string;
      name: string;
      decimals: number;
      contractAddress: string;
      enabled: boolean;
      credit: boolean;
      testnetOnly: boolean;
      issuerType: string;
      nanosPerToken: string;
      priceVersion: string;
    }[];
  };
  chains: ChainHealth[];
  intents: DepositIntent[];
  events: ChainDepositEvent[];
  anomalies: ChainAnomaly[];
  receiving: ReceivingAddress[];
  totals: WalletTotals;
  consumers: WalletConsumerCredit[];
  /** true when nothing on this node is enabled: the page must say so */
  disabled: boolean;
}

function emptyTotals(): ChainEventTotals {
  return {
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
  };
}

function addEventTotal(target: ChainEventTotals, row: { status: string; count: number; creditedNanos: number }): void {
  target.events += row.count;
  switch (row.status) {
    case "credited":
      target.credited += row.count;
      target.creditedNanos += row.creditedNanos;
      break;
    case "finalized":
      target.finalized += row.count;
      break;
    case "crediting":
      target.crediting += row.count;
      break;
    case "observed":
    case "confirming":
      target.pending += row.count;
      break;
    case "unclaimed":
      target.unclaimed += row.count;
      break;
    case "uncertain":
      target.uncertain += row.count;
      break;
    case "reverted":
      target.reverted += row.count;
      break;
    case "manualReview":
      target.manualReview += row.count;
      break;
    case "failed":
      target.failed += row.count;
      break;
  }
}

function addTotals(target: ChainEventTotals, source: ChainEventTotals): void {
  for (const key of Object.keys(emptyTotals()) as (keyof ChainEventTotals)[]) target[key] += source[key];
}

/**
 * The wallet module. Constructing it does not touch the network; `start()` is
 * what begins scanning, and it is idempotent.
 */
export class Wallet {
  private registry: NetworkRegistry;
  private store: ChainStore;
  private credit: CreditSink;
  private watchers = new Map<number, ChainWatcher>();
  private running = new Map<number, { stop: () => void }>();
  private makeWatcher: (deps: ConstructorParameters<typeof ChainWatcher>[0]) => ChainWatcher;
  private now: () => Date;
  private initialLookback: number;
  private lastScan = new Map<number, ScanResult>();
  /** the last authenticated health probe, for the zero-RPC local status */
  private lastHealth = new Map<number, ChainHealth>();
  private scanTimers = new Map<number, ReturnType<typeof setInterval>>();
  private inFlight = new Set<number>();
  private scanPromises = new Map<number, Promise<ScanResult>>();
  private rpcGeneration = new Map<number, number>();
  private started = false;
  private readonly receivingPath: string | undefined;
  private readonly readOnlyFetch: typeof fetch | undefined;
  private selectionPolicy: ReceivingNetworkPolicy | null = null;
  private readOnlyReader: ReadOnlyChainReader | null = null;

  constructor(deps: WalletDeps) {
    this.registry = deps.registry ?? loadRegistry(deps.registryPath);
    this.store = deps.store ?? new ChainStore(deps.chainDbPath);
    this.credit = deps.credit;
    this.makeWatcher = deps.makeWatcher ?? ((d) => new ChainWatcher(d));
    this.now = deps.now ?? (() => new Date());
    this.initialLookback = deps.initialLookback ?? 5;
    this.receivingPath = deps.receivingPath;
    this.readOnlyFetch = deps.readOnlyFetch;
  }

  close(): void {
    this.stop();
    this.store.close();
  }

  registryView(): NetworkRegistry {
    return this.registry;
  }

  chainStore(): ChainStore {
    return this.store;
  }

  // --- network administration -------------------------------------------------

  networks(): NetworkRecord[] {
    return this.registry.networks();
  }

  setNetworkEnabled(chainId: number, enabled: boolean): NetworkRecord {
    const net = this.registry.setNetworkEnabled(chainId, enabled);
    if (!enabled) this.stopChain(chainId);
    else if (this.started) this.startChain(chainId);
    return net;
  }

  setRpcEndpoints(chainId: number, endpoints: string[]): NetworkRecord {
    const restart = this.started && this.running.has(chainId);
    const net = this.registry.setRpcEndpoints(chainId, endpoints);
    // Measurements belong to the previous endpoint set. Durable scan progress
    // remains historical evidence, but a new endpoint has no measured head or
    // finality until its own probe completes.
    this.rpcGeneration.set(chainId, (this.rpcGeneration.get(chainId) ?? 0) + 1);
    this.lastHealth.delete(chainId);
    this.lastScan.delete(chainId);
    // Remember running intent before stopping the sole active chain.
    this.stopChain(chainId);
    if (net.enabled && restart) {
      try {
        this.startChain(chainId);
      } catch (e) {
        logger.warn(`restart of chain ${chainId} failed: ${String(e)}`);
      }
    }
    return net;
  }

  assets(): AssetRecord[] {
    return this.registry.enabledAssets();
  }

  allAssets(): AssetRecord[] {
    return this.registry.networks().flatMap((n) => this.registry.assetsForChain(n.chainId));
  }

  setAssetEnabled(assetId: string, enabled: boolean): AssetRecord {
    return this.registry.setAssetEnabled(assetId, enabled);
  }

  /**
   * Reads a contract's `decimals()` and registers it only when the two agree.
   * A token whose on-chain decimals differ from the claim is refused, because
   * every later conversion would be off by a power of ten.
   */
  async registerTestAsset(input: {
    chainId: number;
    contractAddress: string;
    symbol: string;
    name: string;
    expectedDecimals: number;
    nanosPerToken: string;
    pricingNote: string;
  }): Promise<{ asset: AssetRecord; onchainDecimals: number }> {
    const net = this.registry.requireEnabledNetwork(input.chainId);
    const client = new EvmClient({ chainId: net.chainId, endpoints: net.rpcEndpoints });
    await client.verifyChain();
    const raw = await client.callData(input.contractAddress, "0x313ce567");
    if (raw === "0x") throw new Error(`${input.contractAddress} did not answer decimals(); it is not an ERC-20`);
    const onchain = Number(BigInt(raw));
    if (onchain !== input.expectedDecimals) {
      throw new Error(
        `${input.contractAddress} reports ${onchain} decimals on chain ${net.chainId}, not ${input.expectedDecimals}; refusing to register it`,
      );
    }
    const asset = this.registry.registerTestAsset({
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      symbol: input.symbol,
      name: input.name,
      decimals: onchain,
      nanosPerToken: input.nanosPerToken,
      pricingNote: input.pricingNote,
    });
    this.store.recordAssetCheck({
      assetId: asset.assetId,
      chainId: asset.chainId,
      contract: asset.contractAddress,
      onchainDecimals: onchain,
      registeredDecimals: asset.decimals,
      ok: true,
      detail: `decimals() returned ${onchain}`,
      at: this.now().toISOString(),
    });
    logger.info(`registered test asset ${asset.symbol} (${asset.assetId}) with ${onchain} decimals`);
    return { asset, onchainDecimals: onchain };
  }

  // --- receiving addresses ----------------------------------------------------

  /**
   * Publishes the provider's own receiving address for one chain.
   *
   * Persisted in `chain.sqlite`, keyed by `(providerId, chainId)`, because an
   * address that vanishes on restart would make every outstanding deposit intent
   * unclaimable. Updating one network's address never touches another's, and an
   * intent that was already issued keeps the address it was issued with (it is
   * a column of that row, not a lookup).
   *
   * No key material is involved: this records a public address the provider
   * already controls. The plugin holds no private key for either side.
   */
  setReceivingAddress(providerId: string, chainId: number, address: string): ReceivingAddress {
    assertNoMainnetCredit({ chainId, operation: "a receiving address / watcher credit" });
    this.registry.requireEnabledNetwork(chainId);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("a receiving address must be a 20-byte hex address");
    if (address.toLowerCase() === "0x0000000000000000000000000000000000000000") throw new Error("the zero address cannot receive");
    if (!providerId || providerId.length > 64) throw new Error("a receiving address needs a provider id");
    const at = this.now().toISOString();
    this.store.setReceivingAddress({ providerId, chainId, address, at });
    return { providerId, chainId, address, addedAt: at };
  }

  receivingAddresses(): ReceivingAddress[] {
    return this.store.receivingAddresses();
  }

  receivingAddressFor(providerId: string, chainId: number): string | null {
    return this.store.receivingAddress(providerId, chainId);
  }

  // --- product receiving networks and read-only balances ----------------------

  private policy(): ReceivingNetworkPolicy {
    if (!this.selectionPolicy) {
      this.selectionPolicy = new ReceivingNetworkPolicy({ registry: this.registry, path: this.receivingPath, now: this.now });
    }
    return this.selectionPolicy;
  }

  private reader(): ReadOnlyChainReader {
    if (!this.readOnlyReader) {
      this.readOnlyReader = new ReadOnlyChainReader({ registry: this.registry, fetchImpl: this.readOnlyFetch, now: this.now });
    }
    return this.readOnlyReader;
  }

  /** BSC and Base, in registry order, with no primary/default. */
  productNetworks(): NetworkRecord[] {
    return this.registry.receivableNetworks();
  }

  /** The provider's explicit selection. A new provider starts empty. */
  receivingSelection(providerId: string): ReceivingSelection {
    return this.policy().selection(providerId);
  }

  /** Explicitly toggles one product network; never changes the other one. */
  setReceivingNetwork(providerId: string, chainId: number, selected: boolean): ReceivingSelection {
    return this.policy().setSelected(providerId, chainId, selected);
  }

  /** Whether a payment request would be allowed, with a reason code for the UI. */
  paymentRequestVerdict(providerId: string, chainId: number): PaymentRequestVerdict {
    return this.policy().paymentRequestVerdict(providerId, chainId);
  }

  /** Read-only metadata for chains whose balance may be queried. */
  readOnlyNetworks(): ReadOnlyChainSummary[] {
    return this.reader().networks();
  }

  /** A read-only native/token balance. It never credits, sends or prices anything. */
  async readOnlyBalance(input: ReadOnlyBalanceInput): Promise<ReadOnlyBalance> {
    return this.reader().balance(input);
  }

  // --- intents ----------------------------------------------------------------

  /**
   * Creates a deposit request and returns the exact document the consumer's
   * wallet must sign. Nothing is credited at this point, and an unsigned intent
   * can never claim a transfer.
   */
  requestIntent(input: {
    providerId: string;
    consumerId: string;
    chainId: number;
    assetId: string;
    amountRaw: string;
    ttlSec?: number;
    /** overrides the recorded receiving address; refused when none is published */
    recipientAddress?: string;
  }): SignableIntent {
    const known = this.registry.network(input.chainId);
    if (!known) throw new Error(`chain ${input.chainId} is not registered`);
    if (isMainnetChainId(input.chainId) || known.support === "read-only") {
      // The selection is checked first so an unselected chain says so; a selected
      // mainnet then gets the read-only refusal. Neither path creates an intent.
      const verdict = this.paymentRequestVerdict(input.providerId, input.chainId);
      if (!verdict.allowed) throw new Error(verdict.reason);
    }
    const net = this.registry.requireEnabledNetwork(input.chainId);
    const asset = this.registry.asset(input.assetId);
    if (!asset) throw new Error(`no asset ${input.assetId}`);
    if (asset.chainId !== input.chainId) throw new Error(`asset ${input.assetId} belongs to chain ${asset.chainId}`);
    if (!asset.enabled) throw new Error(`asset ${input.assetId} is disabled`);
    if (!asset.credit || asset.pricing.kind !== "fixed-test-rate") {
      throw new Error(`asset ${input.assetId} is not creditable; a mainnet or read-only asset cannot back a deposit intent`);
    }
    const recipient = input.recipientAddress ?? this.receivingAddressFor(input.providerId, input.chainId);
    if (!recipient) {
      throw new Error(
        `provider ${input.providerId} has no receiving address on chain ${input.chainId}; set one before requesting a deposit`,
      );
    }
    const intent = buildIntent({
      request: {
        providerId: input.providerId,
        consumerId: input.consumerId,
        chainId: input.chainId,
        assetId: input.assetId,
        recipientAddress: recipient,
        expectedAmountRaw: input.amountRaw,
        ttlSec: input.ttlSec ?? 3600,
      },
      network: net,
      asset,
      priceVersion: asset.pricing.version,
      now: this.now(),
    });
    const digest = intentDigest(intent, net, asset);
    const stored = this.store.insertIntent({ ...intent, digest });
    const nanos = convertRawToNanos({ rawAmount: BigInt(stored.expectedAmountRaw), asset, at: this.now() });
    return {
      intent: stored,
      typedData: intentTypedData(stored, net, asset),
      digest,
      summary:
        `Pay ${stored.expectedAmountRaw} base units of ${asset.symbol} (${asset.decimals} decimals, ≈ $${nanosToUsd(nanos.nanos).toFixed(6)} test USD) ` +
        `on ${net.displayName} (chain ${net.chainId}) to ${stored.recipientAddress}. ` +
        `Sign the EIP-712 DepositIntent so the plugin can attribute your payment. Expires ${stored.expiresAt}.`,
    };
  }

  /**
   * Verifies a consumer's signature and binds the payer.
   *
   * The payer is always the recovered address; a `payerAddress` in a request
   * body is never trusted. But the caller **must** state which address it
   * expects to have signed (`payerAddress`), because a signature over some
   * other document still recovers to *some* address. Without that check, a
   * random signature would permanently bind an invoice to an address nobody
   * controls and the real consumer's payment could never claim it.
   */
  signIntent(input: { invoiceId: string; signature: string; payerAddress: string; expectedPayer?: string | null }): { intent: DepositIntent; payer: string } {
    const intent = this.store.intent(input.invoiceId);
    if (!intent) throw new Error(`no deposit intent ${input.invoiceId}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.payerAddress)) throw new Error("payerAddress must be the address you signed with");
    const net = this.registry.network(intent.chainId);
    if (!net) throw new Error(`chain ${intent.chainId} is not registered`);
    const asset = this.registry.asset(intent.assetId);
    if (!asset) throw new Error(`asset ${intent.assetId} is not registered`);
    if (isExpired(intent, this.now())) {
      this.store.setIntentStatus(intent.invoiceId, "expired", "void");
      throw new Error(`intent ${input.invoiceId} expired at ${intent.expiresAt}`);
    }
    const check = verifyIntentSignature({ intent, network: net, asset, signature: input.signature, expectedPayer: input.expectedPayer ?? null });
    if (!check.ok || !check.payer) throw new Error(`signature refused: ${check.reason ?? "unknown reason"}`);
    if (check.payer.toLowerCase() !== input.payerAddress.toLowerCase()) {
      throw new Error(
        `this signature was made by ${check.payer}, not ${input.payerAddress}; it is not a signature over this deposit request`,
      );
    }
    const stored = this.store.setPayer({
      invoiceId: input.invoiceId,
      payerAddress: check.payer,
      digest: intentDigest(intent, net, asset),
      at: this.now().toISOString(),
    });
    return { intent: stored, payer: check.payer };
  }

  intents(consumerId?: string): DepositIntent[] {
    return consumerId ? this.store.intentsFor(consumerId) : this.store.allIntents();
  }

  cancelIntent(invoiceId: string, reason: string): DepositIntent {
    const intent = this.store.intent(invoiceId);
    if (!intent) throw new Error(`no deposit intent ${invoiceId}`);
    if (intent.status === "matched") throw new Error(`intent ${invoiceId} already matched a transfer; it cannot be cancelled`);
    this.store.setIntentStatus(invoiceId, "cancelled", "void");
    logger.info(`intent ${invoiceId} cancelled: ${reason}`);
    return this.store.intent(invoiceId)!;
  }

  // --- scanning ---------------------------------------------------------------

  /** Starts every enabled chain's watcher, each on its own timer. */
  start(): void {
    this.started = true;
    for (const net of this.registry.enabledNetworks()) {
      this.startChain(net.chainId);
    }
  }

  private startChain(chainId: number): void {
    if (this.running.has(chainId)) return;
    assertNoMainnetCredit({ chainId, operation: "watcher start" });
    const net = this.registry.requireEnabledNetwork(chainId);
    const watcher = this.makeWatcher({
      network: net,
      registry: this.registry,
      store: this.store,
      ledger: this.credit,
      initialLookback: this.initialLookback,
      now: this.now,
    });
    this.watchers.set(chainId, watcher);
    const tick = () => {
      if (this.inFlight.has(chainId)) return;
      void this.runScan(chainId, watcher)
        .catch((e) => logger.warn(`chain ${chainId} scan failed: ${String(e)}`));
    };
    const timer = setInterval(tick, Math.max(2, net.scanIntervalSec) * 1000);
    timer.unref?.();
    this.scanTimers.set(chainId, timer);
    this.running.set(chainId, { stop: () => clearInterval(timer) });
    // The first scan is immediate so a restart does not wait a whole interval.
    tick();
  }

  private stopChain(chainId: number): void {
    this.running.get(chainId)?.stop();
    this.running.delete(chainId);
    this.scanTimers.delete(chainId);
    this.watchers.delete(chainId);
  }

  stop(): void {
    this.started = false;
    for (const id of [...this.running.keys()]) this.stopChain(id);
  }

  /** Explicit stop/disable can await already admitted scans, which are not cancellable. */
  async settleScans(): Promise<void> {
    await Promise.allSettled([...this.scanPromises.values()]);
  }

  scanningChains(): number[] { return [...this.inFlight]; }

  private runScan(chainId: number, watcher: ChainWatcher): Promise<ScanResult> {
    const existing = this.scanPromises.get(chainId);
    if (existing) return existing;
    this.inFlight.add(chainId);
    const generation = this.rpcGeneration.get(chainId) ?? 0;
    const promise = Promise.resolve().then(() => watcher.scan()).then(result => {
      if ((this.rpcGeneration.get(chainId) ?? 0) === generation) this.lastScan.set(chainId, result);
      return result;
    }).finally(() => { this.inFlight.delete(chainId); this.scanPromises.delete(chainId); });
    this.scanPromises.set(chainId, promise);
    return promise;
  }

  runningChains(): number[] {
    return [...this.running.keys()];
  }

  /** One scan of one chain, for the CLI's "rescan now". */
  async scanNow(chainId: number): Promise<ScanResult> {
    assertNoMainnetCredit({ chainId, operation: "a manual scan" });
    const watcher = this.watchers.get(chainId) ?? this.makeWatcher({
      network: this.registry.requireEnabledNetwork(chainId),
      registry: this.registry,
      store: this.store,
      ledger: this.credit,
      initialLookback: this.initialLookback,
      now: this.now,
    });
    return this.runScan(chainId, watcher);
  }

  lastScanResult(chainId: number): ScanResult | null {
    return this.lastScan.get(chainId) ?? null;
  }

  /** Health per registered chain, never throwing: an unreachable RPC is data. */
  async health(): Promise<ChainHealth[]> {
    const out: ChainHealth[] = [];
    for (const net of this.registry.networks()) {
      if (!net.enabled) { out.push(this.localHealth(net)); continue; }
      const watcher = this.watchers.get(net.chainId) ?? this.makeWatcher({
        network: net,
        registry: this.registry,
        store: this.store,
        ledger: this.credit,
        initialLookback: this.initialLookback,
        now: this.now,
      });
      const generation = this.rpcGeneration.get(net.chainId) ?? 0;
      try {
        const health = await watcher.health();
        if ((this.rpcGeneration.get(net.chainId) ?? 0) === generation) {
          this.lastHealth.set(net.chainId, health);
          out.push(health);
        } else {
          // An old in-flight endpoint probe must not repopulate invalidated evidence.
          out.push(this.localHealth(this.registry.network(net.chainId) ?? net));
        }
      } catch (e) {
        out.push({
          chainId: net.chainId,
          displayName: net.displayName,
          enabled: net.enabled,
          networkType: net.networkType,
          blockExplorer: net.blockExplorer,
          endpoints: [],
          head: null,
          finalizedBlock: null,
          cursor: null,
          cursorHash: null,
          lagBlocks: null,
          lastScanAt: null,
          lastError: String((e as Error).message ?? e).slice(0, 300),
          finality: { mode: net.finality.mode, confirmations: net.finality.confirmations, rationale: net.finality.rationale },
          assets: [],
        });
      }
    }
    return out;
  }

  // --- status -----------------------------------------------------------------

  /**
   * The authenticated status: probes every enabled chain's RPC, then renders.
   * Use this from the CLI. A page snapshot must use `statusLocal()` instead,
   * because a snapshot writer must never wait for a chain.
   */
  async status(opts: StatusOptions = {}): Promise<WalletStatus> {
    await this.health();
    return this.buildStatus(opts);
  }

  /**
   * The local status: no RPC, no timers, no writes. Chain health is whatever the
   * last authenticated probe measured (or an explicit "not probed yet" shape),
   * and every count is a SQL aggregate over the whole store, not over the last
   * page of rows.
   *
   * `consumerIds` lets the host include consumers that have no chain intent yet
   * (their ledger balance is still real). Without it, only consumers visible in
   * `deposit_intents` are described.
   */
  statusLocal(opts: StatusOptions = {}): WalletStatus {
    return this.buildStatus(opts);
  }

  private buildStatus(opts: StatusOptions): WalletStatus {
    const networks = this.registry.networks();
    return {
      registry: {
        networks: networks.map((n) => ({
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
        assets: this.allAssets().map((a) => ({
          assetId: a.assetId,
          chainId: a.chainId,
          symbol: a.symbol,
          name: a.name,
          decimals: a.decimals,
          contractAddress: a.contractAddress,
          enabled: a.enabled,
          credit: a.credit,
          testnetOnly: a.testnetOnly,
          issuerType: a.issuerType,
          nanosPerToken: a.pricing.nanosPerToken,
          priceVersion: a.pricing.version,
        })),
      },
      chains: networks.map((n) => {
        const base = this.lastHealth.get(n.chainId) ?? this.localHealth(n);
        // `recordScanError` deliberately keeps no cursor for a chain that never
        // completed a scan, so the error lives only in the last scan result.
        const scanError = this.lastScanResult(n.chainId)?.errors?.[0];
        return base.lastError || !scanError ? base : { ...base, lastError: scanError.slice(0, 300) };
      }),
      intents: this.store.allIntents(100),
      // A page list stays bounded; the totals below do not use it.
      events: networks.flatMap((n) => this.store.eventsForChain(n.chainId, 100)),
      anomalies: networks.flatMap((n) => this.store.anomalies(n.chainId, 25)),
      receiving: this.receivingAddresses(),
      totals: this.totals(),
      consumers: this.consumerCredits(opts.consumerIds),
      disabled: this.registry.enabledNetworks().length === 0,
    };
  }

  /** A chain health row with no probe behind it: nulls, never invented values. */
  private localHealth(net: NetworkRecord): ChainHealth {
    const cursor = this.store.cursor(net.chainId);
    return {
      chainId: net.chainId,
      displayName: net.displayName,
      enabled: net.enabled,
      networkType: net.networkType,
      blockExplorer: net.blockExplorer,
      endpoints: [],
      head: null,
      finalizedBlock: null,
      cursor: cursor?.lastBlock ?? null,
      cursorHash: cursor?.lastBlockHash ?? null,
      lagBlocks: null,
      lastScanAt: cursor?.lastScanAt ?? null,
      lastError: this.store.lastError(net.chainId) ?? cursor?.lastError ?? null,
      finality: { mode: net.finality.mode, confirmations: net.finality.confirmations, rationale: net.finality.rationale },
      assets: this.registry.assetsForChain(net.chainId).map((a) => {
        const check = this.store.assetCheck(a.assetId);
        return {
          assetId: a.assetId,
          symbol: a.symbol,
          decimals: a.decimals,
          enabled: a.enabled,
          onchainDecimals: check?.onchainDecimals ?? null,
          decimalsOk: check ? check.ok : null,
        };
      }),
    };
  }

  private totals(): WalletTotals {
    const byChain = this.registry.networks().map((n) => ({ chainId: n.chainId, ...emptyTotals() }));
    for (const row of this.store.eventTotals()) {
      const target = byChain.find((b) => b.chainId === row.chainId);
      if (!target) continue;
      addEventTotal(target, row);
    }
    const all = emptyTotals();
    for (const b of byChain) addTotals(all, b);
    return { ...all, byChain };
  }

  private consumerCredits(ids: string[] | undefined): WalletConsumerCredit[] {
    const known = new Set<string>(ids ?? []);
    if (!ids) {
      for (const intent of this.store.allIntents(1000)) known.add(intent.consumerId);
    }
    const out: WalletConsumerCredit[] = [];
    for (const consumerId of [...known].sort()) {
      const chainCredit = this.registry.networks().map((n) => ({ chainId: n.chainId, ...emptyTotals() }));
      let updatedAt: string | null = null;
      for (const row of this.store.eventTotalsForConsumer(consumerId)) {
        const target = chainCredit.find((b) => b.chainId === row.chainId);
        if (!target) continue;
        addEventTotal(target, row);
        if (row.updatedAt && (!updatedAt || row.updatedAt > updatedAt)) updatedAt = row.updatedAt;
      }
      let ledger: WalletConsumerCredit["ledger"] = null;
      try {
        const b = this.credit.balance(consumerId);
        ledger = { depositedNanos: b.depositedNanos, consumedNanos: b.consumedNanos, balanceNanos: b.balanceNanos };
      } catch {
        // A ledger that cannot be read is not a zero balance.
        ledger = null;
      }
      out.push({
        consumerId,
        chainCredit,
        chainCreditedNanos: chainCredit.reduce((sum, c) => sum + c.creditedNanos, 0),
        ledger,
        updatedAt,
      });
    }
    return out;
  }

  /**
   * One consumer's credit, read from the ledger and the chain store.
   *
   * The ledger balance includes simulated credits, so it is returned as
   * `ledger` and never presented as "chain credit".
   */
  consumerChainCredit(consumerId: string): {
    consumerId: string;
    chainCredit: ConsumerChainCredit[];
    chainCreditedNanos: number;
    depositedUsd: number;
    balanceUsd: number;
    ledger: { depositedNanos: number; consumedNanos: number; balanceNanos: number };
    events: ChainDepositEvent[];
    updatedAt: string | null;
  } {
    const credit = this.consumerCredits([consumerId]).find((c) => c.consumerId === consumerId)!;
    const balance = credit.ledger ?? { depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 };
    return {
      consumerId,
      chainCredit: credit.chainCredit,
      chainCreditedNanos: credit.chainCreditedNanos,
      depositedUsd: nanosToUsd(balance.depositedNanos),
      balanceUsd: nanosToUsd(balance.balanceNanos),
      ledger: balance,
      events: this.store.eventsForConsumer(consumerId, 200),
      updatedAt: credit.updatedAt,
    };
  }
}

/** Test-rate helper: a whole-token rate as nanos, for `registerTestAsset`. */
export function nanosPerTokenForUsd(usd: number): string {
  return String(usdToNanos(usd));
}
