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
}

export interface WalletStatus {
  registry: {
    networks: {
      chainId: number;
      displayName: string;
      networkType: string;
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
  totals: {
    credited: number;
    finalized: number;
    pending: number;
    unclaimed: number;
    uncertain: number;
    reverted: number;
  };
  /** true when nothing on this node is enabled: the page must say so */
  disabled: boolean;
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
  private receiving: ReceivingAddress[] = [];
  private makeWatcher: (deps: ConstructorParameters<typeof ChainWatcher>[0]) => ChainWatcher;
  private now: () => Date;
  private initialLookback: number;
  private lastScan = new Map<number, ScanResult>();
  private scanTimers = new Map<number, ReturnType<typeof setInterval>>();
  private inFlight = new Set<number>();

  constructor(deps: WalletDeps) {
    this.registry = deps.registry ?? loadRegistry(deps.registryPath);
    this.store = deps.store ?? new ChainStore(deps.chainDbPath);
    this.credit = deps.credit;
    this.makeWatcher = deps.makeWatcher ?? ((d) => new ChainWatcher(d));
    this.now = deps.now ?? (() => new Date());
    this.initialLookback = deps.initialLookback ?? 5;
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
    return net;
  }

  setRpcEndpoints(chainId: number, endpoints: string[]): NetworkRecord {
    const net = this.registry.setRpcEndpoints(chainId, endpoints);
    // The running watcher holds its own client with the old list.
    this.stopChain(chainId);
    if (net.enabled && this.running.size > 0) {
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

  setReceivingAddress(providerId: string, chainId: number, address: string): ReceivingAddress {
    this.registry.requireEnabledNetwork(chainId);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("a receiving address must be a 20-byte hex address");
    if (address.toLowerCase() === "0x0000000000000000000000000000000000000000") throw new Error("the zero address cannot receive");
    const existing = this.receiving.find((r) => r.providerId === providerId && r.chainId === chainId);
    if (existing) {
      existing.address = address;
      return { ...existing };
    }
    const rec: ReceivingAddress = { providerId, chainId, address, addedAt: this.now().toISOString() };
    this.receiving.push(rec);
    return { ...rec };
  }

  receivingAddresses(): ReceivingAddress[] {
    return this.receiving.map((r) => ({ ...r }));
  }

  receivingAddressFor(providerId: string, chainId: number): string | null {
    return this.receiving.find((r) => r.providerId === providerId && r.chainId === chainId)?.address ?? null;
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
    const net = this.registry.requireEnabledNetwork(input.chainId);
    const asset = this.registry.asset(input.assetId);
    if (!asset) throw new Error(`no asset ${input.assetId}`);
    if (asset.chainId !== input.chainId) throw new Error(`asset ${input.assetId} belongs to chain ${asset.chainId}`);
    if (!asset.enabled) throw new Error(`asset ${input.assetId} is disabled`);
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
    for (const net of this.registry.enabledNetworks()) {
      this.startChain(net.chainId);
    }
  }

  private startChain(chainId: number): void {
    if (this.running.has(chainId)) return;
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
      this.inFlight.add(chainId);
      watcher
        .scan()
        .then((r) => this.lastScan.set(chainId, r))
        .catch((e) => logger.warn(`chain ${chainId} scan failed: ${String(e)}`))
        .finally(() => this.inFlight.delete(chainId));
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
    for (const id of [...this.running.keys()]) this.stopChain(id);
  }

  runningChains(): number[] {
    return [...this.running.keys()];
  }

  /** One scan of one chain, for the CLI's "rescan now". */
  async scanNow(chainId: number): Promise<ScanResult> {
    const watcher = this.watchers.get(chainId) ?? this.makeWatcher({
      network: this.registry.requireEnabledNetwork(chainId),
      registry: this.registry,
      store: this.store,
      ledger: this.credit,
      initialLookback: this.initialLookback,
      now: this.now,
    });
    const result = await watcher.scan();
    this.lastScan.set(chainId, result);
    return result;
  }

  lastScanResult(chainId: number): ScanResult | null {
    return this.lastScan.get(chainId) ?? null;
  }

  /** Health per registered chain, never throwing: an unreachable RPC is data. */
  async health(): Promise<ChainHealth[]> {
    const out: ChainHealth[] = [];
    for (const net of this.registry.networks()) {
      const watcher = this.watchers.get(net.chainId) ?? this.makeWatcher({
        network: net,
        registry: this.registry,
        store: this.store,
        ledger: this.credit,
        initialLookback: this.initialLookback,
        now: this.now,
      });
      try {
        out.push(await watcher.health());
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

  async status(): Promise<WalletStatus> {
    const chains = await this.health();
    const events = this.registry.networks().flatMap((n) => this.store.eventsForChain(n.chainId, 100));
    const count = (status: ChainDepositEvent["status"]) => events.filter((e) => e.status === status).length;
    return {
      registry: {
        networks: this.registry.networks().map((n) => ({
          chainId: n.chainId,
          displayName: n.displayName,
          networkType: n.networkType,
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
          testnetOnly: a.testnetOnly,
          issuerType: a.issuerType,
          nanosPerToken: a.pricing.nanosPerToken,
          priceVersion: a.pricing.version,
        })),
      },
      chains,
      intents: this.store.allIntents(100),
      events,
      anomalies: this.registry.networks().flatMap((n) => this.store.anomalies(n.chainId, 25)),
      receiving: this.receivingAddresses(),
      totals: {
        credited: count("credited"),
        finalized: count("finalized"),
        pending: count("observed") + count("confirming"),
        unclaimed: count("unclaimed"),
        uncertain: count("uncertain"),
        reverted: count("reverted"),
      },
      disabled: this.registry.enabledNetworks().length === 0,
    };
  }

  /** The consumer's chain credit, read from the ledger (never a second balance). */
  consumerChainCredit(consumerId: string): { depositedUsd: number; balanceUsd: number; events: ChainDepositEvent[] } {
    const balance = this.credit.balance(consumerId);
    const invoices = new Set(this.store.intentsFor(consumerId, 500).map((i) => i.invoiceId));
    const events = this.registry
      .networks()
      .flatMap((n) => this.store.eventsForChain(n.chainId, 500))
      .filter((e) => e.invoiceId !== null && invoices.has(e.invoiceId));
    return { depositedUsd: nanosToUsd(balance.depositedNanos), balanceUsd: nanosToUsd(balance.balanceNanos), events };
  }
}

/** Test-rate helper: a whole-token rate as nanos, for `registerTestAsset`. */
export function nanosPerTokenForUsd(usd: number): string {
  return String(usdToNanos(usd));
}
