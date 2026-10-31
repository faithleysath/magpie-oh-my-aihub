// Everything the plugin does, independent of how it was invoked (the plugin host
// or the loopback HTTP API). It owns the EasyTier supervisor, the Gateway Key
// provisioner and the set of remote providers this node consumes.
//
// Phase 4 replaces the single role with two independent capabilities:
//
//   sharingEnabled   — publish this node's own Magpie on the overlay
//   consumingEnabled — use any number of remote Magpies, each one a
//                      ProviderConnection with its own loopback port, Gateway
//                      Key and status
//
// Both may be on at once. One EasyTier core and one set of network identities
// serve both: the overlay config carries the provider export/ACL *and* the
// consumer's loopback forwards, because a second core on the same machine would
// fight over the same network name and identity.
//
// The plugin still never touches an AI request. Magpie authenticates, routes and
// bills every call through the remote provider's own Gateway Key.

import { lanIPv4, statePath } from "./paths.ts";
import { readFileSync } from "node:fs";
import { capOnGrid, modelList, RequestValidationError, validateRequestApproval, type ApprovalContext, type ConnectionRequest } from "./connection-request.ts";
import { logger, registerSecret, writePageStatus } from "./log.ts";
import { gatewayBaseURL, type CatalogModelMeta, type LimitStatus, type Magpie } from "./magpie.ts";
import { Provisioner, type ConsumerView } from "./provisioner.ts";
import { Ledger, type LedgerDeposit } from "./ledger.ts";
import { catalogPriceVersion, nanosToUsd, priceSnapshot, unsupportedPriceReason, usdToNanos } from "./pricing.ts";
import { Wallet, type WalletStatus } from "./wallet.ts";
import type { KeyReadback } from "./walletview.ts";
import { buildStatement, type ConsumerStatement } from "./walletstatement.ts";
import type { CreditSink } from "./watcher.ts";
import type { AssetRecord, NetworkRecord } from "./networks.ts";
import type { ChainDepositEvent } from "./chainstore.ts";
import {
  EasytierSupervisor,
  generateSecureIdentity,
  type EasytierConfig,
  type ForwardSpec,
  type Peer,
  type PortForward,
  type RouteRow,
  type SupervisorState,
} from "./easytier.ts";
import { mappedHost, randomMappedCidr, randomVirtualIp } from "./addresses.ts";
import {
  OsSocketOwnership,
  SocketBinder,
  claimFreePort,
  emptyPortLedger,
  portRange,
  proofEvidence,
  recordPortEvidence,
  recordPortMigration,
  verifyOwnedPort,
  type PortBinder,
  type PortLedger,
  type PortOwner,
  type PortProof,
  type PortPurpose,
  type SocketOwnershipProbe,
} from "./ports.ts";
import { projectNetwork, splitListenAddr, type NetworkView } from "./network.ts";
import {
  CATALOG_MAX_MODELS,
  CATALOG_PATH,
  CatalogServer,
  canonicalJson,
  classifyPeers,
  isValidModelId,
  isValidNodeId,
  isValidOverlayHostname,
  keyIdOf,
  loadCatalogTrust,
  loadOrCreateCatalogIdentity,
  loadPublishState,
  mappedOf,
  saveCatalogTrust,
  savePublishState,
  sha256Hex,
  signCatalog,
  socksHttpGet,
  verifySignedCatalog,
  type CatalogIdentity,
  type CatalogModel,
  type CatalogPrice,
  type CatalogQuoteBody,
  type CatalogServerHandle,
  type CatalogTrustRecord,
  type DirectoryPeer,
  type SignedCatalog,
} from "./catalog.ts";
import {
  FORWARD_PORT_FROM,
  MODELS_EVIDENCE_TTL_MS,
  FORWARD_PORT_TO,
  deleteProviderKey,
  getProviderKey,
  loadState,
  newNodeId,
  newInstanceId,
  normalizeCatalogConfig,
  providerKeyRef,
  providerView,
  saveState,
  setProviderKey,
  type CatalogConfig,
  type PluginConfig,
  type PluginState,
  type ProviderConnection,
  type ProviderLimitView,
  type ProviderModelsEvidence,
  type ProviderView,
  type OrphanForward,
  type SharePolicy,
} from "./state.ts";

/** `provider` was the phase-3 role; still accepted where a role is asked for. */
export type Role = "provider" | "consumer";

/** The part of the supervisor the service uses; injectable for tests. */
export interface SupervisorLike {
  start(cfg: EasytierConfig): Promise<SupervisorState>;
  stop(): Promise<void>;
  refresh(): Promise<SupervisorState>;
  snapshot(): SupervisorState;
  listPortForwards(): Promise<PortForward[]>;
  addPortForward(bindAddr: string, dstAddr: string): Promise<boolean>;
  removePortForward(bindAddr: string): Promise<void>;
  setForwards(forwards: ForwardSpec[]): void;
  peers(): Promise<Peer[]>;
  routes(): Promise<RouteRow[]>;
}

/** Network probes, injectable so a unit test does not need a real overlay. */
export interface Probes {
  /** does `host:port` answer `want` for `/v1/models` with this bearer (or none)? */
  statusWith: (host: string, port: number, want: number, bearer?: string) => Promise<boolean>;
  /** the models a remote gateway serves through a forward, with its key */
  remoteModelIds: (localPort: number, key: string, timeoutMs: number) => Promise<string[] | null>;
  /** the models this node's Magpie lists (through its own CLI) */
  localModelIds: () => Promise<string[]>;
  /** the local Magpie's own model metadata, read-only, for the catalogue */
  catalogModels: () => Promise<CatalogModelMeta[]>;
  /** a connected provider's own `/v1/magpie/limit`, through its forward */
  remoteLimit: (localPort: number, key: string, timeoutMs: number) => Promise<LimitStatus | null>;
  /** one GET through EasyTier's loopback SOCKS5 listener */
  catalogHttpGet: (opts: { socksPort: number; host: string; port: number; path: string; timeoutMs: number }) => Promise<{ status: number; body: string }>;
  /** a local catalogue server; injectable so a unit test keeps the LAN untouched */
  catalogServer: (opts: {
    hostname: string;
    port: number;
    document: () => SignedCatalog | null;
    presence?: () => unknown | null;
  }) => CatalogServerHandle;
}

export interface ServiceDeps {
  magpie: Magpie;
  magpieVersion: string;
  supervisor?: SupervisorLike;
  probes?: Partial<Probes>;
  /** the LAN address the provider exports; injected in tests */
  lanIp?: () => string | null;
  /** how long an ingress probe retries before giving up (tests shorten it) */
  probeTimeoutMs?: number;
  /**
   * How often the accounting safety check runs, independent of /status and the
   * page. Defaults to ACCOUNTING_TICK_MS.
   */
  accountingTickMs?: number;
  /** consecutive failed checks before the export is withdrawn */
  accountingFailureBudget?: number;
  /** a check that takes longer than this is a failure, not a pass */
  accountingTimeoutMs?: number;
  /**
   * The chain wallet module. Off by default: a node that never enables a network
   * must not open a socket to an RPC. Tests pass a stub or a real one.
   */
  wallet?: Wallet | null;
  /** build the wallet from the plugin state directory when the node enables it */
  walletFactory?: () => Wallet | null;
  /**
   * Port claims. The default holds real sockets; a unit test injects a binder
   * (or a fake supervisor) so no listener is created on the host.
   */
  ports?: { binder?: PortBinder; ownership?: SocketOwnershipProbe; now?: () => Date };
  /**
   * Host ownership proof. Only the instance holding the host lock may start,
   * adopt, restart or stop the shared overlay core. A probe/secondary instance
   * is read-only: it must leave the core, its config and its forwards alone.
   */
  ownsHost?: () => boolean;
}

/**
 * The accounting check's own cadence. It is a poll, not a price lock: a price
 * edit is acted on at the next check, so the exposure is this interval plus the
 * time one check takes.
 */
export const ACCOUNTING_TICK_MS = 10_000;
const ACCOUNTING_TIMEOUT_MS = 20_000;
const ACCOUNTING_FAILURE_BUDGET = 3;
/** Marks a withdrawal caused by the accounting check, not by the share guard. */
const ACCOUNTING_SUSPENSION = "accounting-uncertain: ";
/** A legacy wildcard policy; sharing stays withdrawn until an exact selection. */
const SHARE_POLICY_SUSPENSION = "share-policy-required: ";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`accounting check exceeded ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface AccountingStatus {
  /** the interval the timer uses */
  intervalMs: number;
  /** the largest gap between the end of one check and the start of the next */
  maxDetectionMs: number;
  lastCheckAt: string | null;
  lastCheckMs: number | null;
  lastOkAt: string | null;
  /** consecutive failed checks */
  failures: number;
  /** true while the check cannot prove the accounting is sound */
  uncertain: boolean;
  uncertainReason: string | null;
  /** consumers paused by this check, with the reason */
  paused: { consumerId: string; reason: string; enforcement: string; enforced: boolean }[];
  /** false while the export is withdrawn because the check cannot be trusted */
  serving: boolean;
}

/** One operator check. `at` is when the evidence was collected, never when a page was written. */
export interface OperatorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** local evidence (state/ACL) or a probe of a remote provider */
  kind?: "local" | "remote";
  at?: string;
}

/** What the page may say without doing any network work. */
export interface ReadinessSnapshot {
  state: "ready" | "degraded" | "blocked" | "unknown";
  checkedAt: string | null;
  ageMs: number | null;
  source: "cached" | "none";
  reasons: string[];
  providers: { id: string; reachability: "reachable" | "unreachable" | "UNKNOWN" }[];
}

export interface ShareCandidate {
  id: string;
  displayName: string | null;
  provider: string;
  pricing: CatalogModel["pricing"];
  completePrice: boolean;
  allowedByPolicy: boolean;
  /** Why a dynamic price (peak/rate window) cannot back a capped key. */
  unsupportedPrice?: string | null;
}

export interface ShareCandidatesView {
  policy: string[];
  models: ShareCandidate[];
  /** SHA-256 of the priced, policy-allowed models; null when none can back a key */
  priceVersion: string | null;
  priceLocked: false;
  blocking: { id: string; reason: string }[];
  /** when the native-model read behind this view happened */
  detectedAt?: string;
  /** this list is Magpie's own model metadata, never a copied setting */
  source?: "magpie-native";
}

export interface StatusSnapshot {
  plugin: { version: string; pid: number; dataDir: string; startedAt: string; stateVersion: number };
  magpie: { version: string; gateway: string };
  config: {
    role: Role | null;
    sharingEnabled: boolean;
    /** false while the export is withdrawn by the safety guard */
    sharingActive: boolean;
    shareSuspended: { at: string; reason: string } | null;
    consumingEnabled: boolean;
    nodeId: string | null;
    hostname: string | null;
    networkName: string | null;
    peers: string[];
    listenAddr: string | null;
    virtualIpv4: string | null;
    proxyCidr: string | null;
    mappedCidr: string | null;
    publishedPorts: number[];
    secureMode: boolean;
    rpcPort: number | null;
    share: SharePolicy;
    nativeProviders: string[];
    remoteProviders: string[];
    catalog: CatalogConfig;
  };
  easytier: SupervisorState;
  /** the read-only network projection: state, neighbours, ports (never editable) */
  network: NetworkView;
  consumers: ConsumerView[];
  providers: ProviderView[];
  catalog: CatalogStatus;
  accounting: AccountingStatus;
  /** the chain wallet, or null when this node runs no network */
  wallet: WalletStatus | null;
  /** the phase-3 field, kept for older clients: the first provider, or null */
  wiring: { id: string; mappedCidr: string; url: string; createdAt: string } | null;
  /** cached result; `checksAt` is when the probes actually ran */
  checks: OperatorCheck[];
  checksAt: string | null;
  checksDurationMs: number | null;
  readiness: ReadinessSnapshot;
  logs: string[];
}

export interface CatalogPeerView extends DirectoryPeer {
  /** the stable node id the peer signed in its catalogue, once one was read */
  nodeId: string | null;
  status:
    | "self"
    | "connected"
    | "verified"
    | "unverified"
    | "identity-changed"
    | "stale"
    | "unreachable"
    | "no-catalog"
    | "conflict"
    | "offline";
  detail: string | null;
  catalogPort: number | null;
  identity: { fingerprint: string; keyId: string; publicKey: string; firstSeenAt: string } | null;
  pendingFingerprint: string | null;
  quote: SignedCatalog | null;
  quoteHash: string | null;
  fetchedAt: string | null;
  connectedProviderId: string | null;
  /**
   * What the overlay currently advertises, kept separate from `online`:
   * `online` is a network-neighbour fact, `catalog` is a publication fact. A
   * peer that stops sharing keeps its network row but can no longer serve a
   * quote, so it must not be presented as an applicable online offer.
   */
  catalog: "published" | "withdrawn" | "none" | "conflict" | "unknown";
  /** the cached quote was read inside CATALOG_QUOTE_TTL_MS and may be applied */
  quoteFresh: boolean;
  /** when the quote may no longer be applied; null without a quote */
  quoteExpiresAt: string | null;
  /** the last time a quote was read successfully, kept after a withdrawal */
  lastQuoteAt: string | null;
  /** the last probe attempt; never used as quote freshness */
  lastAttemptAt: string | null;
}

/**
 * Whether a discovered peer's cached quote may be used to request or connect.
 * Online-ness of the network neighbour is deliberately separate from whether a
 * catalogue is still published: a peer that stopped sharing stays a neighbour
 * but must not offer its last quote any more. Pure, so both the service guards
 * and the tests use one rule.
 */
export function catalogQuoteUsability(peer: CatalogPeerView, now = Date.now()): { usable: boolean; detail: string | null } {
  if (peer.status === "self") return { usable: false, detail: "is this node" };
  if (peer.online !== true) return { usable: false, detail: "is offline; refresh the directory when it returns" };
  if (peer.catalog === "withdrawn" || peer.status === "no-catalog") {
    return { usable: false, detail: "is online as a neighbour but has withdrawn its catalogue (sharing stopped or the mapping is gone); refresh the directory" };
  }
  if (peer.catalog === "none") {
    return { usable: false, detail: "has not shared any models; there is no catalogue to request" };
  }
  if (peer.catalog !== "published" || !peer.quote || !peer.quoteHash) {
    return { usable: false, detail: "has no catalogue quote to request; refresh the directory" };
  }
  if (peer.status === "identity-changed") return { usable: false, detail: "changed its catalogue identity; accept the new fingerprint explicitly first" };
  // `quoteFresh` is computed by the service from its own clock, so it is the
  // authority here; mixing in the caller's wall clock would expire a quote
  // that was just read under an injected clock.
  const expires = peer.quoteExpiresAt ? Date.parse(peer.quoteExpiresAt) : Number.NaN;
  const fresh = typeof peer.quoteFresh === "boolean"
    ? peer.quoteFresh
    : Number.isFinite(expires) && expires > now;
  if (!fresh) {
    return { usable: false, detail: "has an expired quote; refresh the directory and review the current quote before requesting or connecting" };
  }
  if (peer.status === "stale") return { usable: false, detail: "offered an older or replayed quote; refresh the directory first" };
  return { usable: true, detail: null };
}

/**
 * How long a quote read over the overlay may be applied. EasyTier discovery is
 * polled every `catalog.refreshSec` (default 20 s); a quote this old is still
 * suspicious after a provider withdraws its export, so the window is bounded.
 * After it, the peer is `stale` and no request/connect may use the quote.
 */
export const CATALOG_QUOTE_TTL_MS = 120_000;

/**
 * The bounded catalogue/presence port window. Every product instance allocates
 * inside it (default 3426), and every reader probes the whole window regardless
 * of its own port. This is what lets two isolated instances share one LAN IP.
 */
export const CATALOG_PORT_WINDOW: readonly number[] = Object.freeze([3426, 3427, 3428, 3429, 3430]);

/**
 * The ordered catalogue probe list. A remembered port is tried first; the
 * product window is always probed, so a peer that moved inside the window stays
 * discoverable. The local legacy range is kept as a bounded fallback for a
 * maintainer override, but it is never the only base.
 */
export function catalogProbePorts(remembered: number | null, localPort: number): number[] {
  const local = [localPort, localPort + 1, localPort + 2, localPort + 3, localPort + 4].filter((p) => p >= 1 && p <= 65535);
  const all = [...new Set([...CATALOG_PORT_WINDOW, ...local])];
  return remembered ? [remembered, ...all.filter((p) => p !== remembered)] : all;
}

export interface CatalogStatus {
  config: CatalogConfig;
  publishing: boolean;
  server: { running: boolean; port: number | null; address: string | null; error: string | null };
  quote: {
    version: number;
    updatedAt: string;
    publishedAt: string;
    contentHash: string;
    modelCount: number;
    models: CatalogModel[];
    billing: CatalogQuoteBody["billing"];
    identity: { fingerprint: string; keyId: string; publicKey: string; createdAt: string } | null;
  } | null;
  peers: CatalogPeerView[];
  lastRefreshAt: string | null;
  refreshing: boolean;
  error: string | null;
}

/** Who wrote the Magpie provider entry that currently holds this id. */
type Ownership = "absent" | "ours" | "foreign";

export interface ProviderInput {
  id: string;
  mappedCidr: string;
  key: string;
  providerPort?: number;
  localPort?: number;
}

/** The exact identity/quote a human saw and accepted before request/connect. */
export interface CatalogAcceptance {
  fingerprint: string;
  quoteHash: string;
  priceVersion?: string;
}

interface RouteOwner {
  hostname: string;
  ipv4: string;
  peerId: string | null;
}

function defaultProbes(magpie: Magpie): Probes {
  return {
    statusWith: statusIs,
    remoteModelIds,
    localModelIds: () => magpie.modelIds(),
    catalogModels: () => magpie.catalogModels(),
    remoteLimit,
    catalogHttpGet: socksHttpGet,
    catalogServer: (opts) => new CatalogServer(opts).start(),
  };
}

export class Service {
  readonly supervisor: SupervisorLike;
  readonly provisioner: Provisioner;
  readonly ledger: Ledger | null;
  private state: PluginState;
  private startedAt = new Date().toISOString();
  private lastProblem: string | null = null;
  private ticking: ReturnType<typeof setInterval> | null = null;
  private probes: Probes;
  private lanIp: () => string | null;
  private probeTimeoutMs: number;
  private opQueue: Promise<unknown> = Promise.resolve();
  private connectionsBusy = new Set<string>();
  private mutating = 0;
  private lastReconcileAt = 0;
  private lastProviderFingerprint = "";
  private accountingTimer: ReturnType<typeof setInterval> | null = null;
  private accountingRunning = false;
  private accounting: AccountingStatus;
  private accountingTickMs: number;
  private accountingFailureBudget: number;
  private accountingTimeoutMs: number;
  private catalogServer: CatalogServerHandle | null = null;
  private controlPresenceProvider: (() => unknown | null) | null = null;
  /** the P2P control listener is running for this Service instance */
  private controlActive = false;
  /** presence-only listener used when the node does not share a catalogue */
  private presenceServer: CatalogServerHandle | null = null;
  /**
   * Loopback forwards the control plane opened towards peers. They are part of
   * the canonical Forward set: a live forward that the supervisor's own ACL /
   * config check does not expect is treated as an unsafe runtime (and rightly
   * so), so every control forward is registered and persisted like a provider
   * forward.
   */
  private controlForwards = new Map<string, ForwardSpec>();
  /** called after a successful configure/sharing change so the control plane can re-sync */
  private topologyListener: (() => Promise<void>) | null = null;
  private catalogServerError: string | null = null;
  private catalogQuote: SignedCatalog | null = null;
  private catalogQuoteHash: string | null = null;
  private catalogQuoteVersion = 0;
  private catalogQuoteUpdatedAt: string | null = null;
  private catalogPeers: CatalogPeerView[] = [];
  private catalogLastRefreshAt: string | null = null;
  private catalogRefreshing = false;
  private presencePortMigrating = false;
  /** bounded supervised recovery after the supervisor stopped an unproven core */
  private coreRecovery = { attempts: 0, nextAt: 0 };
  private catalogError: string | null = null;
  private catalogNextQuoteAt = 0;
  private catalogNextRefreshAt = 0;
  /**
   * The chain wallet, when this node runs one. It is created lazily by
   * `walletModule()` because constructing it opens SQLite and the registry file;
   * a node that never enables a network never touches either.
   */
  private walletInstance: Wallet | null | undefined = undefined;
  private walletStatusCache: WalletStatus | null = null;
  /** Checks are expensive: the page and snapshots render this cache with its real timestamp. */
  private cachedChecks: OperatorCheck[] = [];
  private cachedChecksAt: string | null = null;
  private cachedChecksDurationMs: number | null = null;
  private cachedChecksError: string | null = null;
  private binder: PortBinder;
  private ownership: SocketOwnershipProbe;
  private readonly ownsHost: () => boolean;
  /** one core restart at a time for forward recovery; avoids nested serialize */
  private forwardMigrationBusy = false;
  /** per-provider backoff so a stuck recovery cannot restart the core every tick */
  private readonly forwardRecoveryBackoff = new Map<string, number>();
  private clock: () => Date;
  private lastNetworkRefreshAt = 0;

  constructor(private deps: ServiceDeps) {
    this.state = loadState().state;
    // A proof belongs to the process that made it. After a restart nothing has
    // been re-proven yet, so persisted "stable" entries become "unverified"
    // until this instance checks the listeners again (H1: no stale green).
    if (this.state.ports && this.state.ports.evidence.length) {
      this.state.ports = {
        ...this.state.ports,
        evidence: this.state.ports.evidence.map((e) => ({
          ...e,
          state: "unverified" as const,
          detail: "not re-proven since this host started",
        })),
      };
    }
    this.binder = deps.ports?.binder ?? new SocketBinder();
    this.ownership = deps.ports?.ownership ?? new OsSocketOwnership();
    this.ownsHost = deps.ownsHost ?? (() => true);
    for (const f of this.state.controlForwards) this.controlForwards.set(f.bindAddr, { bindAddr: f.bindAddr, dstAddr: f.dstAddr });
    this.clock = deps.ports?.now ?? (() => new Date());
    this.probes = { ...defaultProbes(deps.magpie), ...(deps.probes ?? {}) };
    this.accountingTickMs = Math.max(10, deps.accountingTickMs ?? ACCOUNTING_TICK_MS);
    this.accountingFailureBudget = Math.max(1, deps.accountingFailureBudget ?? ACCOUNTING_FAILURE_BUDGET);
    this.accountingTimeoutMs = Math.max(50, deps.accountingTimeoutMs ?? ACCOUNTING_TIMEOUT_MS);
    this.accounting = {
      intervalMs: this.accountingTickMs,
      maxDetectionMs: this.accountingTickMs + this.accountingTimeoutMs,
      lastCheckAt: null,
      lastCheckMs: null,
      lastOkAt: null,
      failures: 0,
      uncertain: false,
      uncertainReason: null,
      paused: [],
      serving: true,
    };
    this.lanIp = deps.lanIp ?? (() => safeLanIp());
    this.probeTimeoutMs = deps.probeTimeoutMs ?? 6000;
    this.supervisor =
      deps.supervisor ??
      new EasytierSupervisor({
        onState: () => this.writeSnapshot(),
        onProxyMoved: (cidr) => {
          if (this.state.config) {
            this.state.config.proxyCidr = cidr;
            saveState(this.state);
            logger.info(`export moved to ${cidr}; plugin state updated`);
          }
        },
      }, { ownsHost: () => this.ownsHost() });
    // The durable ledger needs Magpie's effective prices. A test double that
    // cannot report them keeps the legacy behaviour rather than failing every
    // key; the real Magpie always has catalogModels().
    const canPrice = typeof (deps.magpie as unknown as { catalogModels?: unknown }).catalogModels === "function";
    this.ledger = canPrice ? new Ledger() : null;
    this.provisioner = new Provisioner(deps.magpie, {
      validateModels: (models) => this.assertShareable(models),
      ...(this.ledger
        ? {
            ledger: this.ledger,
            prices: async (models: string[]) => priceSnapshot(await deps.magpie.catalogModels(), models),
          }
        : {}),
    });
  }

  config(): PluginConfig | null {
    return this.state.config;
  }

  providers(): ProviderView[] {
    return this.state.providers.map((p) => providerView(p, this.clock().getTime()));
  }

  provider(id: string): ProviderConnection | undefined {
    return this.state.providers.find((p) => p.id === id);
  }

  /**
   * The models one remote provider serves through its own loopback forward and
   * Gateway Key. Read-only: it never re-registers, removes or re-routes this or
   * any other provider.
   */
  async providerModels(id: string): Promise<{
    id: string;
    models: string[];
    status: string;
    detail: string | null;
    limit: ProviderLimitView | null;
    modelsEvidence: ProviderModelsEvidence;
  }> {
    const rec = this.provider(id);
    if (!rec) throw new Error(`no remote provider ${id}`);
    const key = getProviderKey(id);
    if (!key) throw new Error(`provider ${id} has no stored Gateway Key; update the provider first`);
    const forwardOwner = await this.proveForwardOwner(id, rec.localPort);
    if (forwardOwner.state !== "stable") {
      const why =
        `127.0.0.1:${rec.localPort} is not provably owned by the supervised core ` +
        `(${forwardOwner.state}: ${forwardOwner.detail ?? "no evidence"}); not sending the Gateway Key`;
      this.recordModelsEvidence(rec, [], "provider-models", why, "unknown");
      saveState(this.state);
      throw new Error(why);
    }
    let models: string[] | null = null;
    try {
      models = await this.probes.remoteModelIds(rec.localPort, key, 15_000);
      if (!models || models.length === 0) {
        throw new Error(`provider ${id} served no model for its key (offline, revoked or a different provider)`);
      }
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      rec.modelsEvidence = {
        ...(rec.modelsEvidence ?? {
          status: "unknown",
          source: "provider-models",
          readAt: null,
          expiresAt: null,
          models: [],
          modelCount: null,
          callable: "unknown",
          identity: null,
          generation: 0,
          keyRef: rec.keyRef,
          keyGeneration: rec.keyGeneration ?? 1,
          error: null,
        }),
        status: "unknown",
        source: "provider-models",
        readAt: this.clock().toISOString(),
        expiresAt: null,
        modelCount: null,
        callable: /401|403|revoke|unauthor/i.test(why) ? "no" : "unknown",
        error: why.slice(0, 300),
      };
      rec.updatedAt = new Date().toISOString();
      saveState(this.state);
      throw e;
    }
    const at = this.clock();
    rec.models = [...models!];
    rec.modelsEvidence = {
      status: "current",
      source: "provider-models",
      readAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + MODELS_EVIDENCE_TTL_MS).toISOString(),
      models: [...models!],
      modelCount: models!.length,
      callable: "yes",
      identity: {
        hostname: rec.fingerprint?.hostname ?? null,
        virtualIpv4: rec.fingerprint?.virtualIpv4 ?? null,
        fingerprint: rec.acceptedFingerprint ?? rec.modelsEvidence?.identity?.fingerprint ?? null,
      },
      generation: (rec.modelsEvidence?.generation ?? 0) + 1,
      keyRef: rec.keyRef,
      keyGeneration: rec.keyGeneration ?? 1,
      error: null,
    };
    rec.updatedAt = at.toISOString();
    saveState(this.state);
    return {
      id,
      models,
      status: rec.status,
      detail: rec.detail,
      limit: rec.limit ?? null,
      modelsEvidence: providerView(rec, this.clock().getTime()).modelsEvidence,
    };
  }

  /** Stores one real read-back result on the provider record (never a probe by polling). */
  private recordModelsEvidence(
    conn: ProviderConnection,
    models: string[],
    source: ProviderModelsEvidence["source"],
    error: string | null = null,
    callable: ProviderModelsEvidence["callable"] = error ? "unknown" : "yes",
  ): void {
    const at = this.clock();
    const previous = conn.modelsEvidence;
    conn.modelsEvidence = {
      status: error ? "unknown" : "current",
      source,
      readAt: at.toISOString(),
      expiresAt: error ? null : new Date(at.getTime() + MODELS_EVIDENCE_TTL_MS).toISOString(),
      models: error ? (previous?.models ?? []) : [...models],
      modelCount: error ? null : models.length,
      callable,
      identity: {
        hostname: conn.fingerprint?.hostname ?? previous?.identity?.hostname ?? null,
        virtualIpv4: conn.fingerprint?.virtualIpv4 ?? previous?.identity?.virtualIpv4 ?? null,
        fingerprint: conn.acceptedFingerprint ?? previous?.identity?.fingerprint ?? null,
      },
      generation: (previous?.generation ?? 0) + (error ? 0 : 1),
      keyRef: conn.keyRef,
      keyGeneration: conn.keyGeneration ?? 1,
      error: error ? error.slice(0, 300) : null,
    };
    if (!error) conn.models = [...models];
    conn.updatedAt = at.toISOString();
  }

  /** The gateway port this Magpie answers on (3425 unless told). */
  gatewayPort(): number {
    try {
      const u = new URL(gatewayBaseURL());
      return Number(u.port || (u.protocol === "https:" ? 443 : 80));
    } catch {
      return 3425;
    }
  }


  // --- accounting safety -----------------------------------------------------

  /** The accounting check's last result, for the status page and the API. */
  /** The snapshot without the (network) checks, for tests that only read state. */
  statusSnapshotForTest(): StatusSnapshot {
    return this.lightStatus();
  }

  accountingStatus(): AccountingStatus {
    return { ...this.accounting, paused: [...this.accounting.paused] };
  }

  // --- chain wallet ----------------------------------------------------------

  /**
   * The wallet module, or null when this node runs none.
   *
   * Construction opens local registry/SQLite stores only; disabled networks
   * remain administrable without RPC. Passive console reads never construct
   * this module. `deps.wallet` is the test seam; `deps.walletFactory` supplies paths.
   */
  walletModule(): Wallet | null {
    if (this.walletInstance !== undefined) return this.walletInstance;
    if (this.deps.wallet !== undefined) {
      this.walletInstance = this.deps.wallet;
      return this.walletInstance;
    }
    try {
      const built = this.deps.walletFactory ? this.deps.walletFactory() : null;
      if (built) {
        this.walletInstance = built;
        return built;
      }
      // Construction opens local stores only. Keep disabled registries available
      // for configuration: closing and caching null made re-enable impossible.
      const probe = new Wallet({ credit: this.chainCreditSink(), registry: undefined });
      this.walletInstance = probe;
      return probe;
    } catch (e) {
      logger.warn(`the chain wallet is unavailable: ${String(e)}`);
      // An unreadable registry is unavailable, never an empty replacement. An
      // explicit later operation may retry after the operator repairs it.
      this.walletInstance = undefined;
      return null;
    }
  }

  /** Local console reads never initialize a wallet or start RPC work. */
  consoleWalletModule(): Wallet | null {
    return this.walletInstance === undefined ? (this.deps.wallet ?? null) : this.walletInstance;
  }

  /** Explicit administration may open disabled stores, without starting watchers. */
  walletForConfiguration(): Wallet {
    return this.requireWallet();
  }

  /**
   * The only bridge from a chain event to credit. It delegates to the
   * provisioner, which owns the Magpie cap write and its read-back; nothing in
   * the wallet module can reach a Gateway Key any other way.
   */
  private chainCreditSink(): CreditSink {
    const ledger = this.ledger;
    return {
      depositIntent: (input) => {
        if (!ledger) throw new Error("a chain deposit needs the durable ledger");
        const r = ledger.depositIntent({
          id: input.id,
          consumerId: input.consumerId,
          amountNanos: input.amountNanos,
          source: input.source,
          fundsClass: input.fundsClass,
          chainId: input.chainId,
          assetId: input.assetId,
        });
        return { created: r.created };
      },
      applyDeposit: async (input) => {
        await this.provisioner.applyChainDeposit(input);
      },
      freezeConsumer: async (consumerId, reason) => {
        if (!ledger) return;
        // A reverted credit is an auditable freeze, not a silent adjustment: the
        // deposit row stays, the account is paused, and the key is stopped by the
        // same fail-closed path a price change uses.
        ledger.setPaused(consumerId, `chain-reorg: ${reason}`);
        const rec = this.provisioner.find(consumerId);
        if (rec) await this.provisioner.pauseForChain(consumerId, reason);
      },
      balance: (consumerId) => {
        if (!ledger) return { depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 };
        const b = ledger.balance(consumerId);
        return { depositedNanos: b.depositedNanos, consumedNanos: b.consumedNanos, balanceNanos: b.balanceNanos };
      },
    };
  }

  /** Starts the chain watchers for every enabled network (idempotent). */
  startWallet(): void {
    const w = this.walletModule();
    if (!w) return;
    try {
      w.start();
    } catch (e) {
      logger.error(`chain watchers did not start: ${String(e)}`);
    }
  }

  /** The wallet's status, or null; cached briefly so the page is not slow. */
  async walletStatus(): Promise<WalletStatus | null> {
    const w = this.walletModule();
    if (!w) return null;
    try {
      this.walletStatusCache = await w.status();
      return this.walletStatusCache;
    } catch (e) {
      logger.warn(`wallet status failed: ${String(e)}`);
      return this.walletStatusCache;
    }
  }

  walletStatusSync(): WalletStatus | null {
    return this.walletStatusCache;
  }

  /**
   * The local projection for a page snapshot. It must never open an RPC or
   * construct a wallet that was not already built: a page write is not a
   * network event. The wallet owner supplies `statusLocal()`; until then the
   * last cached async result is the only thing we can honestly show.
   */
  private walletLocalStatus(): WalletStatus | null {
    // `walletInstance` is undefined until startWallet/walletStatus; the test
    // seam may already hold a wallet, and asking it for a local view constructs
    // nothing and opens no RPC.
    const source = this.walletInstance === undefined ? this.deps.wallet : this.walletInstance;
    const w = source as (Wallet & { statusLocal?: () => WalletStatus | null }) | null | undefined;
    if (!w || typeof w.statusLocal !== "function") return this.walletStatusCache;
    try {
      return w.statusLocal() ?? this.walletStatusCache;
    } catch (e) {
      logger.warn(`local wallet snapshot failed: ${String(e)}`);
      return this.walletStatusCache;
    }
  }

  /**
   * The authenticated local evidence a CLI needs to prove a credit:
   * `WalletStatus`, the provisioner's consumers, ledger deposits per consumer,
   * gateway read-backs and the accounting state. It is read-only and contains
   * no key material; the caller must already hold the API token.
   */
  async walletEvidence(opts: { consumerId?: string } = {}): Promise<{
    wallet: WalletStatus;
    consumers: ConsumerView[];
    deposits: Record<string, LedgerDeposit[]>;
    readbacks: Record<string, KeyReadback>;
    accounting: { state: "ok" | "uncertain" | "unknown"; reason: string | null; serving: boolean };
  } | null> {
    const w = this.walletModule();
    if (!w) return null;
    // No refreshAll()/verify(): those reconcile pending deposits and persist
    // lastCheck. Evidence is a token-protected GET; it reads the gateway limit
    // directly and never changes another consumer's record.
    const all = this.provisioner.all();
    const consumers = opts.consumerId ? all.filter((c) => c.consumerId === opts.consumerId) : all;
    const wallet = w.statusLocal({ consumerIds: consumers.map((c) => c.consumerId) });
    const deposits: Record<string, LedgerDeposit[]> = {};
    const readbacks: Record<string, KeyReadback> = {};
    for (const c of consumers) {
      deposits[c.consumerId] = this.ledger?.depositsFor(c.consumerId) ?? [];
      const rec = this.provisioner.find(c.consumerId);
      if (!rec?.secret || rec.revokedAt || rec.paused) continue;
      try {
        const status = await this.deps.magpie.limitStatus(rec.secret);
        const lim = status.limit;
        if (
          status.limited === true &&
          typeof lim?.costLimit === "number" &&
          typeof lim.cost === "number" &&
          typeof lim.costLeft === "number"
        ) {
          readbacks[c.consumerId] = {
            at: new Date().toISOString(),
            capUsd: lim.costLimit,
            usedUsd: lim.cost,
            leftUsd: lim.costLeft,
            fromGateway: true,
          };
        }
      } catch {
        // Unreadable key: omit the read-back; the view says unproven, never zero.
      }
    }
    const a = this.accountingStatus();
    return {
      wallet,
      consumers,
      deposits,
      readbacks,
      accounting: {
        state: a.uncertain ? "uncertain" : a.lastCheckAt ? "ok" : "unknown",
        reason: a.uncertainReason,
        serving: a.serving,
      },
    };
  }

  /**
   * One consumer's out-of-band statement, built by the host that owns the
   * ledger. The builder refuses rows that belong to another consumer; this
   * method passes only that consumer's intents, events and deposits.
   */
  async walletStatement(consumerId: string): Promise<ConsumerStatement | null> {
    // Scope the evidence to this consumer so one statement cannot read another
    // account's key, or reconcile another account.
    const evidence = await this.walletEvidence({ consumerId });
    if (!evidence) return null;
    const w = this.walletModule();
    if (!w) return null;
    const consumer = evidence.consumers.find((c) => c.consumerId === consumerId);
    if (!consumer) throw new Error(`no consumer ${consumerId}`);
    // A statement is a historical record, not the wallet's 50-row preview.
    const intents = w.chainStore().intentsFor(consumerId, 1_000_000);
    const providerIds = [...new Set(intents.map((i) => i.providerId))];
    if (providerIds.length > 1) {
      throw new Error(`consumer ${consumerId} has deposit intents from more than one provider: ${providerIds.join(", ")}`);
    }
    const providerId = providerIds[0] ?? this.state.config?.nodeId;
    if (!providerId) throw new Error(`consumer ${consumerId} has no provider/deposit intent to state`);
    return buildStatement({
      providerId,
      consumerId,
      generatedAt: new Date().toISOString(),
      networks: w.networks(),
      assets: w.allAssets(),
      intents,
      events: w.chainStore().eventsForConsumer(consumerId, 1_000_000),
      deposits: evidence.deposits[consumerId] ?? [],
      consumer,
      // The statement schema allows exactly state/reason/openSettlements.
      // `serving` belongs to the live accounting view, not to a historical file.
      accounting: {
        state: evidence.accounting.state,
        reason: evidence.accounting.reason,
        openSettlements: consumer.ledger?.openSettlements ?? 0,
      },
      readback: evidence.readbacks[consumerId] ?? null,
    });
  }

  /** The wallet module for the API, or an error when this node runs none. */
  requireWallet(): Wallet {
    const w = this.walletModule();
    if (!w) throw new Error("this node has no chain wallet; enable a network first");
    return w;
  }

  /**
   * Runs the prepaid-accounting check without being asked.
   *
   * It is a **poll**, not a price lock: an external price edit, a window
   * boundary, a late usage row or a log gap is acted on at the next check. The
   * exposure is bounded by `intervalMs` plus one check's duration, which
   * `accountingStatus().maxDetectionMs` reports.
   *
   * Fail closed: a check that throws, times out, or cannot read the price source
   * counts as a failure. After `accountingFailureBudget` consecutive failures the
   * export is withdrawn (`safetyUncertain`), so consumers cannot keep spending
   * against accounting the plugin can no longer verify.
   */
  async accountingTick(): Promise<AccountingStatus> {
    if (this.accountingRunning) return this.accountingStatus();
    this.accountingRunning = true;
    const startedAt = Date.now();
    this.accounting.lastCheckAt = new Date(startedAt).toISOString();
    try {
      const paused = await withTimeout(this.runAccountingCheck(), this.accountingTimeoutMs);
      this.accounting.lastCheckMs = Date.now() - startedAt;
      this.accounting.failures = 0;
      this.accounting.lastOkAt = new Date().toISOString();
      this.accounting.paused = paused;
      if (this.accounting.uncertain) {
        // A check that passed after the export was withdrawn for accounting
        // reasons may republish — but only after a full re-validation, which
        // runAccountingCheck() has just done for every key.
        this.accounting.uncertain = false;
        this.accounting.uncertainReason = null;
        await this.restoreAccountingServing("the accounting check passes again");
      }
    } catch (e) {
      this.accounting.lastCheckMs = Date.now() - startedAt;
      this.accounting.failures += 1;
      this.accounting.uncertainReason = String((e as Error).message ?? e);
      logger.error(`accounting check ${this.accounting.failures}/${this.accountingFailureBudget} failed: ${this.accounting.uncertainReason}`);
      if (this.accounting.failures >= this.accountingFailureBudget) {
        this.accounting.uncertain = true;
        await this.withdrawForAccounting(
          `the prepaid accounting check failed ${this.accounting.failures} times in a row (${this.accounting.uncertainReason})`,
        );
      }
    } finally {
      this.accountingRunning = false;
      this.accounting.serving = this.sharingActive();
      this.writeSnapshot();
    }
    return this.accountingStatus();
  }

  private async runAccountingCheck(): Promise<AccountingStatus["paused"]> {
    const paused: AccountingStatus["paused"] = [];
    for (const rec of this.provisioner.all()) {
      if (rec.revokedAt) continue;
      // The same per-consumer lock as topUp/reissue/revoke: a check never races
      // a money operation on the same consumer.
      await this.provisioner.checkConsumer(rec.consumerId);
      const after = this.provisioner.find(rec.consumerId);
      if (after?.paused) {
        paused.push({
          consumerId: after.consumerId,
          reason: after.paused.reason,
          enforcement: after.paused.enforcement,
          enforced: after.paused.enforced,
        });
      }
    }
    // A pause that could not stop the key (remove and rotate both failed) is not
    // a stopped consumer: withdraw the overlay publication as well.
    const unenforced = paused.filter((p) => !p.enforced);
    if (unenforced.length > 0) {
      await this.withdrawForAccounting(
        `a consumer could not be stopped (${unenforced.map((p) => `${p.consumerId}: ${p.enforcement}`).join(", ")})`,
      );
    }
    return paused;
  }

  private async withdrawForAccounting(reason: string): Promise<void> {
    if (!this.state.config?.sharingEnabled) return;
    if (this.state.shareSuspended?.reason.startsWith(ACCOUNTING_SUSPENSION)) {
      this.state.shareSuspended = { at: new Date().toISOString(), reason: `${ACCOUNTING_SUSPENSION}${reason}` };
      saveState(this.state);
      return;
    }
    try {
      await this.suspendSharing(`${ACCOUNTING_SUSPENSION}${reason}`);
      this.accounting.serving = false;
    } catch (e) {
      // Withdrawing failed: the export is still up. That is reported, never
      // treated as a successful stop.
      logger.error(`could not withdraw sharing for accounting: ${String(e)}`);
      this.accounting.uncertain = true;
      this.accounting.uncertainReason = `${reason}; the overlay publication could not be withdrawn: ${String(e)}`;
      this.accounting.serving = this.sharingActive();
    }
  }

  /**
   * Republishes after an accounting withdrawal, but only when the check that
   * just passed could actually verify every consumer. A consumer whose charges
   * are still uncertain (a usage-log gap) keeps the export down: restoring it
   * would let the node serve against accounting it cannot prove. A merely
   * paused consumer does not block it — its key is already revoked, which is
   * the stop; the export is what serves the others.
   */
  private async restoreAccountingServing(reason: string): Promise<void> {
    if (!this.state.shareSuspended?.reason.startsWith(ACCOUNTING_SUSPENSION)) return;
    const blocked = this.provisioner.all().filter((c) => !c.revokedAt && (c.ledger?.uncertain ?? null));
    if (blocked.length > 0) {
      this.accounting.uncertainReason =
        `still uncertain: ${blocked.map((c) => c.consumerId).join(", ")}; the export stays withdrawn`;
      logger.warn(this.accounting.uncertainReason);
      return;
    }
    await this.resumeSharing().catch((e) => logger.error(`could not restore sharing: ${String(e)}`));
    logger.info(`sharing restored: ${reason}`);
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.ownsHost()) throw new Error("this Service instance does not own the host; refusing to start or adopt the overlay core");
    const cfg = this.state.config;
    let coreReady = true;
    if (cfg?.sharingEnabled && cfg.share.models.some((m) => m.includes("*"))) {
      // A document written before exact consent may still say "*". Do not
      // publish every current/future model on boot; keep the ledger/identity
      // and ask for a new exact selection.
      if (!this.state.shareSuspended?.reason.startsWith(SHARE_POLICY_SUSPENSION)) {
        this.state.shareSuspended = {
          at: new Date().toISOString(),
          reason:
            SHARE_POLICY_SUSPENSION +
            "the saved sharing policy is a wildcard; reselect exact native models with their prices before publishing again",
        };
        saveState(this.state);
        logger.error(this.state.shareSuspended.reason);
      }
    }
    if (cfg) {
      // A legacy document may carry Secure Mode without a keypair (the field was
      // optional); generate and persist one instead of refusing to start.
      if (cfg.secureMode && !cfg.secureIdentity) {
        cfg.secureIdentity = generateSecureIdentity();
        saveState(this.state);
        logger.info("generated the Secure Mode identity this node was missing");
      }
      try {
        // A stored port somebody else now holds is migrated before the start,
        // never "tried and retried" until it happens to work.
        await this.ensureConfiguredPorts(cfg);
        await this.supervisor.start(this.etConfig(cfg));
        this.assertCorePortsProven(await this.reconcileCorePorts(cfg));
        this.lastProblem = null;
      } catch (e) {
        // A core we cannot attribute is not "online": stop it rather than serve
        // with a state that was never proven.
        await this.supervisor.stop().catch(() => {});
        this.lastProblem = String(e);
        coreReady = false;
        logger.error(`supervisor did not start: ${String(e)}`);
      }
    }
    // A core that is not running or whose listeners cannot be attributed is not
    // a usable node: do not start the catalogue, guard, provider reconciliation,
    // accounting or wallet loops on top of it. The state is written as failed
    // and a later explicit start (after fixing the port/ACL) can retry.
    if (!coreReady) {
      this.stopCatalogServer();
      this.writeSnapshot();
      logger.error("startup aborted: the overlay core is not proven; background services were not started");
      return;
    }
    // A restart normally drops orphan listeners, but 2.6.4 can leave a socket
    // alive. Keep an orphan unless the OS bind probe proves the port is free.
    if (this.state.orphanForwards.length) {
      const kept: OrphanForward[] = [];
      for (const orphan of this.state.orphanForwards) {
        let free = false;
        try {
          free = await this.binder.isFree("127.0.0.1", orphan.localPort);
        } catch {
          free = false;
        }
        if (free) continue;
        kept.push(orphan);
        logger.error(`control forward 127.0.0.1:${orphan.localPort} is still listening after core start; keeping the orphan record`);
      }
      this.state.orphanForwards = kept;
      saveState(this.state);
    }
    // Before serving again, prove every issued key still names only this node's
    // own providers. An unreadable provider list withdraws the export instead of
    // pretending the state is safe.
    await this.guardSharedKeys().catch((e) => logger.warn(`share guard at start failed: ${String(e)}`));
    this.lastProviderFingerprint = this.providerFingerprint();
    await this.applyCatalog().catch((e) => logger.error(`catalogue at start failed: ${String(e)}`));
    await this.reconcileProviders({ quiet: true, verifyModels: true }).catch((e) =>
      logger.warn(`reconcile after start failed: ${String(e)}`),
    );
    // Reconcile Magpie's keys, the ledger and consumers.json before serving:
    // a crash between the three must never leave an unbacked key live.
    await this.provisioner
      .recover()
      .then((r) => {
        if (r.recovered.length || r.removed.length || r.uncertain.length) {
          logger.warn(
            `accounting recovery: adopted ${r.recovered.join(",") || "none"}; removed ${r.removed.join(",") || "none"}; uncertain ${r.uncertain.join(",") || "none"}`,
          );
        }
      })
      .catch((e) => logger.error(`accounting recovery failed: ${String(e)}`));
    this.startLoops();
    // Chain watchers start only after recovery: a deposit must never be applied
    // to a key the recovery pass has not yet reconciled.
    this.startWallet();
    // Do not make boot wait for peers: the directory fills in the background.
    void this.catalogTick();
    this.writeSnapshot();
    // The page has no network. Fill the cached checks once after boot so its
    // first snapshot is evidence with a real timestamp, not an empty list.
    void this.checks()
      .then(() => this.writeSnapshot())
      .catch((e) => logger.warn(`checks after boot failed: ${String(e)}`));
  }

  /**
   * Installs the background loops once. Both `start()` and `configure()` call
   * it: a node configured through the loopback API (index.ts does not call
   * start() then) must run the accounting check too, or a price edit would only
   * be noticed when somebody opened the page.
   */
  private startLoops(): void {
    if (!this.ticking) {
      this.ticking = setInterval(() => {
        void this.tick();
      }, 15_000);
    }
    if (!this.accountingTimer) {
      this.accountingTimer = setInterval(() => {
        void this.accountingTick();
      }, this.accountingTickMs);
      // The first check runs at once, so a price edit made while the plugin was
      // down is caught before the interval elapses.
      void this.accountingTick();
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.supervisor.refresh();
    } catch {
      /* the supervisor reports its own state */
    }
    if (!this.ownsHost()) return;
    await this.recoverCoreIfHalted().catch((e) => logger.warn(`core recovery failed: ${String(e)}`));
    if (this.busy()) return;
    // Detect a change made to Magpie's provider list outside the plugin. This is
    // a polled check, so the protection window is bounded by this interval (15s),
    // not instantaneous; see the validation note.
    if (this.state.config?.sharingEnabled) {
      const fingerprint = this.providerFingerprint();
      // Also retry while suspended: the withdrawal or the resumption may have
      // failed (a restart error) and must not be forgotten until a change.
      if (fingerprint !== this.lastProviderFingerprint || this.state.shareSuspended) {
        this.lastProviderFingerprint = fingerprint;
        await this.guardSharedKeys().catch((e) => logger.warn(`share guard after a provider change failed: ${String(e)}`));
      }
    }
    await this.catalogTick().catch((e) => logger.warn(`catalogue tick failed: ${String(e)}`));
    if (Date.now() - this.lastReconcileAt < 45_000) return;
    await this.reconcileProviders({ quiet: true }).catch(() => {});
  }

  /**
   * Catalogue work is separate from the sharing guard and never restarts the
   * core. A peer refresh is one SOCKS5 GET per peer (bounded, no forward); a
   * local quote rebuild is rate-limited and only changes the served document.
   */
  private async catalogTick(): Promise<void> {
    const cfg = this.state.config;
    if (!cfg) return;
    if (cfg.catalog.discoveryEnabled && Date.now() >= this.catalogNextRefreshAt) {
      await this.refreshCatalogPeers().catch((e) => {
        this.catalogError = String((e as Error).message ?? e);
        logger.warn(`catalogue refresh failed: ${this.catalogError}`);
      });
    }
    if (this.catalogPublishing() && Date.now() >= this.catalogNextQuoteAt) {
      await this.publishCatalogNow().catch((e) => {
        this.catalogError = String((e as Error).message ?? e);
        logger.warn(`catalogue rebuild failed: ${this.catalogError}`);
        this.writeSnapshot();
      });
    }
  }

  /**
   * A core the supervisor stopped because it could not prove it safe is not a
   * normal stop; it stays stopped and the checks say so. Recovery is a bounded
   * number of full supervised starts (which re-validate the TOML, ACL, owner and
   * RPC identity), with backoff. After the budget the state stays honestly
   * degraded until an operator acts; nothing is silently skipped.
   */
  async recoverCoreIfHalted(): Promise<void> {
    const cfg = this.state.config;
    if (!cfg) return;
    const snap = this.supervisor.snapshot();
    if (snap.running) {
      this.coreRecovery.attempts = 0;
      this.coreRecovery.nextAt = 0;
      return;
    }
    if (!(snap.lastError ?? "").startsWith("refusing to serve")) return;
    if (this.busy()) return;
    const now = this.clock().getTime();
    if (now < this.coreRecovery.nextAt || this.coreRecovery.attempts >= 3) return;
    this.coreRecovery.attempts += 1;
    this.coreRecovery.nextAt = now + Math.min(60_000, 5_000 * 2 ** (this.coreRecovery.attempts - 1));
    logger.warn(`the core was stopped by a failed safety check; supervised restart ${this.coreRecovery.attempts}/3`);
    try {
      await this.applyConfig(cfg);
      await this.applyCatalog();
      logger.info("the supervised restart proved the core safe again");
    } catch (e) {
      logger.error(`supervised restart after an unsafe stop failed: ${String(e)}`);
    }
  }

  /** A cheap summary of Magpie's provider list, to notice external changes. */
  private providerFingerprint(): string {
    if (!this.deps.magpie.providersReadable()) return "unreadable";
    try {
      const native = [...this.deps.magpie.nativeProviderIds()].sort();
      const remote = [...this.deps.magpie.remoteProviderIds()].sort();
      return `native:${native.join(",")}|remote:${remote.join(",")}`;
    } catch {
      return "unreadable";
    }
  }

  /** Whether the export should be published: enabled by the operator and safe. */
  private sharingActive(): boolean {
    return Boolean(this.state.config?.sharingEnabled && !this.state.shareSuspended);
  }

  /**
   * Withdraws the network publication while the operator's intent to share is
   * kept. Used when the native/remote split cannot be proven: serving a key that
   * might name a remote channel is worse than being briefly offline.
   */
  private async suspendSharing(reason: string): Promise<void> {
    const cfg = this.state.config;
    if (!cfg?.sharingEnabled || this.state.shareSuspended) return;
    this.state.shareSuspended = { at: new Date().toISOString(), reason };
    saveState(this.state);
    await this.applyConfig(cfg);
    await this.applyCatalog();
    logger.error(`sharing withdrawn: ${reason}`);
  }

  /** Republishes the export once the safety check passes again. */
  private async resumeSharing(): Promise<void> {
    if (!this.state.shareSuspended) return;
    this.state.shareSuspended = null;
    saveState(this.state);
    const cfg = this.state.config;
    if (cfg) {
      await this.applyConfig(cfg);
      await this.applyCatalog();
    }
    logger.info("sharing restored: every shared key names only this node's own providers");
  }

  async stop(): Promise<void> {
    if (this.ticking) clearInterval(this.ticking);
    this.ticking = null;
    if (this.accountingTimer) clearInterval(this.accountingTimer);
    this.accountingTimer = null;
    this.stopCatalogServer();
    this.stopPresenceServer();
    this.walletInstance?.stop();
    if (!this.ownsHost()) {
      // A secondary/probe instance never stops the core it did not start.
      logger.warn("non-owner Service stop: leaving the shared overlay core untouched");
      return;
    }
    await this.supervisor.stop();
  }

  /** Serializes configuration and provider mutations: each one can restart the core. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    this.mutating += 1;
    const run = () => fn().finally(() => {
      this.mutating -= 1;
    });
    const next = this.opQueue.then(run, run);
    this.opQueue = next.catch(() => {});
    return next;
  }

  /** True while a mutation is in flight; the background tick stays out of its way. */
  busy(): boolean {
    return this.mutating > 0 || this.connectionsBusy.size > 0;
  }

  // --- configuration ---------------------------------------------------------

  /**
   * Configures this node's overlay and its two capabilities. A change to the
   * network, the export, the published ports or the forward set rewrites the
   * TOML and restarts the core: EasyTier 2.6.4 has no runtime ACL edit.
   */
  async configure(input: {
    role?: Role;
    sharingEnabled?: boolean;
    consumingEnabled?: boolean;
    networkName?: string;
    networkSecret?: string;
    peers?: string[];
    listenAddr?: string | null;
    publishedPorts?: number[];
    secureMode?: boolean;
    rpcPort?: number;
    virtualIpv4?: string;
    shareModels?: string[];
    catalogEnabled?: boolean;
    catalogDiscovery?: boolean;
    catalogDisplayName?: string | null;
    catalogContact?: string | null;
    catalogPort?: number;
    catalogSocksPort?: number;
    catalogRefreshSec?: number;
    catalogMinTopUpUsd?: number;
  }, opts: { strictShareModels?: boolean } = {}): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const prev = this.state.config;
      // Snapshot only what this operation owns. A failed wizard must restore the
      // previous config without undoing a guard narrowing, un-registering a
      // provider, deleting a key or editing the ledger.
      const previousConfig = prev ? structuredClone(prev) : null;
      const previousSuspension = this.state.shareSuspended ? { ...this.state.shareSuspended } : null;
      const role = input.role;
      if (role !== undefined && role !== "provider" && role !== "consumer") {
        throw new Error("role must be provider or consumer");
      }
      const sharingEnabled =
        input.sharingEnabled ?? (role === "provider" ? true : role === "consumer" ? false : (prev?.sharingEnabled ?? false));
      const consumingEnabled =
        input.consumingEnabled ?? (role === "consumer" ? true : role === "provider" ? false : (prev?.consumingEnabled ?? false));

      const networkName = (input.networkName ?? prev?.networkName ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(networkName)) {
        throw new Error("networkName must be 2-63 characters of letters, digits, dot, dash or underscore");
      }
      const networkSecret = (input.networkSecret ?? prev?.networkSecret ?? "").trim();
      if (networkSecret.length < 8) throw new Error("networkSecret must be at least 8 characters");

      const peers = (input.peers ?? prev?.peers ?? [])
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p.includes("://") ? p : `tcp://${p}`));
      for (const p of peers) {
        if (!/^(tcp|udp|ws|wss|quic|wg):\/\/[A-Za-z0-9._:-]+(:\d+)?$/.test(p)) {
          throw new Error(`bad peer address: ${p} (expected tcp://host:port)`);
        }
      }

      const listenAddr = input.listenAddr === undefined ? (prev?.listenAddr ?? null) : normalizeListen(input.listenAddr);
      const publishedPorts = (input.publishedPorts ?? prev?.publishedPorts ?? [this.gatewayPort()])
        .map((p) => Number(p))
        .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
      if (sharingEnabled && publishedPorts.length === 0) {
        throw new Error("a node that shares its Magpie must publish at least one port");
      }

      const secureMode = input.secureMode ?? prev?.secureMode ?? true;
      const rpcPort =
        input.rpcPort ??
        prev?.rpcPort ??
        (await this.choosePort("easytier-rpc", "127.0.0.1", this.rpcCandidates(), [
          this.gatewayPort(),
          prev?.catalog.port ?? 3426,
          prev?.catalog.socksPort ?? 13400,
        ]));

      const virtualIpv4 = input.virtualIpv4 ? normalizeVirtualIp(input.virtualIpv4) : (prev?.virtualIpv4 ?? randomVirtualIp("10.77.0.0/24"));
      const overlayCidr = "10.77.0.0/24";
      const mappedCidr = prev?.mappedCidr ?? (sharingEnabled ? randomMappedCidr() : null);
      const proxyCidr = sharingEnabled ? (this.lanIp() ? `${this.lanIp()}/32` : null) : (prev?.proxyCidr ?? null);
      if (sharingEnabled && !proxyCidr) {
        throw new Error("no usable LAN address to export; connect this machine to a network first");
      }

      const secureIdentity = secureMode ? (prev?.secureIdentity ?? generateSecureIdentity()) : null;
      let shareModels = input.shareModels ? normalizeShareModels(input.shareModels) : (prev?.share.models ?? ["*"]);
      if (opts.strictShareModels) {
        const effective = input.shareModels ?? prev?.share.models ?? (sharingEnabled ? ["*"] : []);
        if (sharingEnabled && effective.some((m) => m.includes("*"))) {
          throw new Error("refusing to share with a wildcard model policy: choose the exact native models with their prices");
        }
        if (effective.length === 0 && sharingEnabled) {
          throw new Error("sharing requires at least one exact native model with a complete effective price");
        }
        if (effective.length > 0) shareModels = await this.validateShareSelection(effective, { expandGlobs: false });
      }
      const share = { models: shareModels };
      const catalog = normalizeCatalogConfig(
        {
          ...(prev?.catalog ?? {}),
          ...(input.catalogEnabled !== undefined ? { enabled: input.catalogEnabled } : {}),
          ...(input.catalogDiscovery !== undefined ? { discoveryEnabled: input.catalogDiscovery } : {}),
          ...(input.catalogDisplayName !== undefined ? { displayName: input.catalogDisplayName } : {}),
          ...(input.catalogContact !== undefined ? { contact: input.catalogContact } : {}),
          ...(input.catalogPort !== undefined ? { port: input.catalogPort } : {}),
          ...(input.catalogSocksPort !== undefined ? { socksPort: input.catalogSocksPort } : {}),
          ...(input.catalogRefreshSec !== undefined ? { refreshSec: input.catalogRefreshSec } : {}),
          ...(input.catalogMinTopUpUsd !== undefined ? { minTopUpUsd: input.catalogMinTopUpUsd } : {}),
        },
        { gatewayPort: this.gatewayPort(), reserved: [rpcPort], strict: true },
      );
      if (catalog.enabled && !sharingEnabled) {
        if (input.catalogEnabled === true) {
          throw new Error("publishing a catalogue requires sharing this node's Magpie; enable sharing first");
        }
        // Turning sharing off withdraws the catalogue with it; leaving the
        // intent on would make the next boot fail or advertise a dead port.
        catalog.enabled = false;
      }

      const cfg: PluginConfig = {
        sharingEnabled,
        consumingEnabled,
        nodeId: prev?.nodeId ?? newNodeId(),
        instanceId: prev?.instanceId ?? newInstanceId(),
        networkName,
        networkSecret,
        peers,
        listenAddr,
        virtualIpv4,
        overlayCidr,
        rpcPort,
        mappedCidr,
        proxyCidr,
        publishedPorts,
        secureMode,
        secureIdentity,
        share,
        catalog,
        controlEnabled: prev?.controlEnabled ?? true,
        controlPort: prev?.controlPort ?? null,
      };
      this.state.config = cfg;
      registerSecret(networkSecret);
      saveState(this.state);

      try {
        await this.applyConfig(cfg);
        await this.applyCatalog();
        // A new configuration can change what is shareable (and a previous
        // suspension may have to be lifted or re-applied).
        if (cfg.sharingEnabled) {
          await this.guardSharedKeys().catch((e) => logger.warn(`share guard after configure: ${String(e)}`));
          this.lastProviderFingerprint = this.providerFingerprint();
          await this.publishCatalogNow().catch((e) => logger.warn(`catalogue rebuild after configure: ${String(e)}`));
        }
        logger.info(
          `configured ${describeRole(cfg)} on ${networkName}; peers ${peers.join(",") || "none"}`,
        );
        // A configured node must run the accounting check even when it was not
        // started through start() (the API path in index.ts).
        this.startLoops();
        const snapshot = await this.status();
        // Turning consumption off must cut the remote providers this node added,
        // and nothing else: a provider the operator made by hand stays. Do it
        // after every fallible step, so a failed status read cannot leave the
        // old config restored but its registrations already dropped.
        if (!consumingEnabled) await this.dropRemoteRegistrations("consumption disabled");
        this.notifyTopology();
        return snapshot;
      } catch (e) {
        const why = (e as Error)?.message ?? String(e);
        this.state.config = previousConfig;
        // Never clear a stricter suspension produced while applying the
        // candidate: restoring the old config must not restore the "safe"
        // label. Keep the current suspension if one exists, otherwise keep the
        // old one (which was also not a proof of safety).
        this.state.shareSuspended = this.state.shareSuspended ?? previousSuspension;
        registerSecret(previousConfig?.networkSecret);
        saveState(this.state);
        try {
          if (previousConfig) {
            // Guard first. It may resume sharing only after proving the old
            // config safe, and `resumeSharing()` applies that config itself. If
            // it cannot prove safety, the suspension stays and the apply below
            // writes a config that exports nothing.
            if (previousConfig.sharingEnabled) {
              await this.guardSharedKeys().catch(async (guardError) => {
                logger.error(`configure rollback guard could not prove safety; withdrawing sharing: ${String(guardError)}`);
                await this.suspendSharing(`configure rollback could not prove safety: ${(guardError as Error)?.message ?? String(guardError)}`).catch(
                  (suspendError) => logger.error(`could not withdraw sharing after the failed rollback guard: ${String(suspendError)}`),
                );
              });
            }
            await this.applyConfig(previousConfig);
            await this.applyCatalog();
            this.lastProviderFingerprint = this.providerFingerprint();
          } else {
            this.stopCatalogServer();
            await this.supervisor.stop();
          }
          logger.error(`configure failed; the previous configuration was restored: ${why}`);
        } catch (restoreError) {
          const restoreWhy = (restoreError as Error)?.message ?? String(restoreError);
          logger.error(
            `configure failed (${why}) and restoring the previous configuration also failed (${restoreWhy})`,
          );
          throw new Error(
            `configure failed: ${why}; restoring the previous configuration also failed: ${restoreWhy}. ` +
              `The previous config is retained on disk; run setup --resume and checks before retrying.`,
          );
        }
        throw new Error(`configure failed: ${why}; the previous configuration was restored`);
      }
    });
  }

  // --- phase-10: three-field join, one explicit share, read-only network ------

  /**
   * The only first-run network configuration the console offers: name, secret
   * and (optionally) one initial node. Role, listener and ports are the plugin's
   * job. Every joined node discovers and consumes; sharing is never implied.
   */
  async joinNetwork(input: { networkName: string; networkSecret?: string; initialNode?: string | null }): Promise<StatusSnapshot> {
    const prev = this.state.config;
    const initialNode = (input.initialNode ?? "").trim();
    // Editing an existing network may leave the secret blank, which keeps the
    // stored one. A first join cannot: there is nothing to keep.
    const secret = (input.networkSecret ?? "").trim();
    if (!secret && !prev) throw new Error("networkSecret must be at least 8 characters");
    // A first join also gets a listener, so another node can reach this one
    // without the operator having to understand "accept connections" or ports.
    const listenAddr =
      prev?.listenAddr ??
      `tcp://0.0.0.0:${await this.choosePort("overlay-listen", "0.0.0.0", portRange(11010, 11059), [this.gatewayPort()])}`;
    const snapshot = await this.configure({
      networkName: input.networkName,
      networkSecret: secret || prev?.networkSecret || "",
      peers: initialNode ? [initialNode] : (prev?.peers ?? []),
      // A first join selects no models: sharing anything later still needs an
      // explicit native-model choice. An existing policy is kept on edit.
      shareModels: prev?.share.models ?? [],
      listenAddr,
      // All nodes discover and consume. Sharing stays a separate human action.
      sharingEnabled: prev?.sharingEnabled ?? false,
      consumingEnabled: true,
      catalogDiscovery: true,
    });
    // `configure` keeps the saved config even when the core refuses to run (a
    // later boot can retry). Do not report a join that did not happen.
    const et = this.supervisor.snapshot();
    if (!et.running) {
      throw new Error(`the overlay core is not running after the join: ${et.lastError ?? "no error was recorded"}`);
    }
    return snapshot;
  }

  /**
   * The single explicit "share these models" action. It re-reads Magpie's own
   * native models and their effective prices, accepts only complete-price native
   * models, publishes the catalogue and reapplies the ACL in one supervised
   * restart. A failure restores the previous configuration; this method never
   * issues a Gateway Key or approves a request. Model settings are not copied:
   * the existing `share.models` allow list is the only switch.
   */
  async shareNativeModels(input: { models: string[]; confirm: boolean }): Promise<StatusSnapshot> {
    // One transaction at a time: a concurrent tick/share must not see or roll
    // back half of another operator's change.
    return this.serialize(() => this.shareNativeModelsLocked(input));
  }

  private async shareNativeModelsLocked(input: { models: string[]; confirm: boolean }): Promise<StatusSnapshot> {
    if (input.confirm !== true) throw new Error("refusing to share: the human confirmation (confirm: true) is required");
    const cfg = this.state.config;
    if (!cfg) throw new Error("configure this node first");
    if (!this.deps.magpie.providersReadable()) {
      throw new Error("cannot read Magpie's provider list; refusing to issue or change a shared key");
    }
    const requested = [...new Set(input.models.map((m) => m.trim()).filter(Boolean))];
    if (requested.length === 0) throw new Error("choose at least one native model with a complete price to share");
    const candidates = await this.shareCandidates();
    const byId = new Map(candidates.models.map((m) => [m.id, m]));
    const selected: string[] = [];
    for (const model of requested) {
      const candidate = byId.get(model);
      if (!candidate) throw new Error(`refusing to share ${model}: it is not one of this Magpie's native models`);
      if (!candidate.completePrice) {
        throw new Error(`refusing to share ${model}: it has no complete effective price, so a capped key cannot be issued for it`);
      }
      selected.push(model);
    }
    selected.sort();
    const lan = this.lanIp();
    if (!lan) throw new Error("no usable LAN address to export; connect this machine to a network first");
    const previousConfig = structuredClone(cfg);
    const previousSuspension = this.state.shareSuspended ? { ...this.state.shareSuspended } : null;
    const next: PluginConfig = {
      ...cfg,
      sharingEnabled: true,
      share: { models: selected },
      mappedCidr: cfg.mappedCidr ?? randomMappedCidr(),
      proxyCidr: `${lan}/32`,
      publishedPorts: cfg.publishedPorts.includes(this.gatewayPort())
        ? cfg.publishedPorts
        : [...cfg.publishedPorts, this.gatewayPort()],
      // Publishing the catalogue is part of this one action, not a second one.
      // Discovery keeps whatever the operator chose (join-network turns it on).
      catalog: { ...cfg.catalog, enabled: true },
    };
    if (this.state.shareSuspended?.reason.startsWith(SHARE_POLICY_SUSPENSION)) {
      this.state.shareSuspended = null;
    }
    this.state.config = next;
    saveState(this.state);
    try {
      // The guard runs BEFORE the export is opened: it re-checks every issued
      // key against this node's own native models and the exact selection. A
      // suspension therefore never happens after the ACL already allowed the
      // gateway; it either passes here or the transaction fails.
      const guard = await this.guardSharedKeys();
      if (guard.suspended || !this.sharingActive()) {
        const reason = this.state.shareSuspended?.reason ?? "the share guard did not confirm the export";
        throw new Error(`the share guard withdrew sharing: ${reason}`);
      }
      await this.applyConfig(next);
      const et = this.supervisor.snapshot();
      if (!et.running) {
        throw new Error(`the overlay core is not running after the restart: ${et.lastError ?? "no error was recorded"}`);
      }
      await this.applyCatalog();
      this.lastProviderFingerprint = this.providerFingerprint();
      await this.publishCatalogNow();
      if (!this.catalogPublishing() || !this.catalogServer || !this.catalogQuote) {
        throw new Error("the catalogue server is not running or no signed quote was published");
      }
      logger.info(`sharing ${selected.length} native model(s); the catalogue is published`);
      // The control plane publishes a presence whose endpoint follows the new
      // export; without this the signed presence would still name the old host.
      this.notifyTopology();
      return this.status();
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      this.state.config = previousConfig;
      this.state.shareSuspended = this.state.shareSuspended ?? previousSuspension;
      saveState(this.state);
      try {
        await this.applyConfig(previousConfig);
        await this.applyCatalog();
      } catch (restoreError) {
        const restoreWhy = (restoreError as Error)?.message ?? String(restoreError);
        logger.error(`sharing models failed (${why}) and restoring the previous configuration failed (${restoreWhy})`);
        // The core may still be running the half-applied export: stop it, so a
        // failed rollback can never leave the gateway published.
        await this.supervisor.stop().catch(() => {});
        throw new Error(
          `share failed: ${why}; restoring the previous configuration also failed: ${restoreWhy}. ` +
            `The overlay core was stopped; the previous config is retained on disk; run checks before retrying.`,
        );
      }
      throw new Error(`share failed: ${why}; the previous configuration was restored`);
    }
  }

  /** The separate, explicit stop: withdraws the export and the catalogue. */
  async stopSharing(input: { confirm: boolean }): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      if (input.confirm !== true) throw new Error("refusing to stop sharing without confirm: true");
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      const next: PluginConfig = { ...cfg, sharingEnabled: false, catalog: { ...cfg.catalog, enabled: false } };
      this.state.config = next;
      saveState(this.state);
      try {
        await this.applyConfig(next);
        await this.applyCatalog();
      } catch (e) {
        // Never leave a config that says "not sharing" while the core still
        // publishes the old export: stop it and report the failure.
        await this.supervisor.stop().catch(() => {});
        throw new Error(`stopping sharing failed: ${(e as Error).message}; the overlay core was stopped`);
      }
      logger.info("sharing stopped: the export and the catalogue were withdrawn; keys and records were kept");
      this.notifyTopology();
      return this.status();
    });
  }

  /** Read-only network diagnostics; never probes, never edits a port. */
  networkView(): NetworkView {
    return projectNetwork({
      config: this.state.config,
      supervisor: this.supervisor.snapshot(),
      catalog: this.catalogStatus(),
      providers: this.providers(),
      gatewayPort: this.gatewayPort(),
      ledger: this.portLedger(),
      serviceProblem: this.lastProblem,
      consolePort: readPortFile("console-port.json"),
      apiPort: readPortFile("api-port"),
      now: () => this.clock().getTime(),
    });
  }

  /**
   * An explicit refresh (a button, never the poll): re-reads EasyTier's peer and
   * route tables and, when discovery is on, the neighbours' catalogues. Values
   * are cached between calls so a stuck page cannot hammer the core.
   */
  async refreshNetwork(): Promise<NetworkView> {
    const now = this.clock().getTime();
    if (now - this.lastNetworkRefreshAt < 2000) return this.networkView();
    this.lastNetworkRefreshAt = now;
    await this.supervisor.refresh().catch((e) => logger.warn(`network refresh failed: ${String(e)}`));
    if (this.state.config?.catalog.discoveryEnabled) {
      await this.refreshCatalog().catch((e) => logger.warn(`catalogue refresh from the network page failed: ${String(e)}`));
    }
    return this.networkView();
  }

  // --- automatic ports -------------------------------------------------------

  private portLedger(): PortLedger {
    return this.state.ports ?? emptyPortLedger();
  }

  private persistLedger(next: PortLedger): void {
    this.state.ports = next;
    saveState(this.state);
  }

  /**
   * Atomically reserves a candidate, then releases it for the real listener.
   * The release is followed by a post-start proof, so a port stolen in the gap
   * is detected instead of being used for an overlay connection.
   */
  private async choosePort(purpose: PortPurpose, host: string, candidates: number[], exclude: number[] = []): Promise<number> {
    const claim = await claimFreePort(this.binder, host, candidates, { exclude });
    const { port, release } = claim.reservation;
    await release();
    return port;
  }

  /**
   * Candidates for the core's RPC portal. Deliberately not in ascending order:
   * 17888 is a well-known EasyTier default that other Magpie/piggybacked cores
   * on this host may already use, and a collision there is exactly how a
   * supervisor could read somebody else's core. The chosen port is persisted,
   * so this only affects first allocation and explicit migration.
   */
  private rpcCandidates(exclude: number[] = []): number[] {
    const ports = portRange(17888, 17959).filter((p) => !exclude.includes(p));
    for (let i = ports.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ports[i], ports[j]] = [ports[j], ports[i]];
    }
    return ports;
  }

  private async recordPortProof(input: {
    purpose: PortPurpose;
    host: string;
    port: number | null;
    owner: PortOwner;
    reported: boolean | null;
    /** the live PIDs allowed to own this port; empty = no proof possible */
    expectedPids: number[];
    detail?: string | null;
  }): Promise<PortProof | null> {
    if (!input.port) return null;
    const proof = await verifyOwnedPort({
      ownership: this.ownership,
      purpose: input.purpose,
      host: input.host,
      port: input.port,
      owner: input.owner,
      reported: input.reported,
      expectedPids: input.expectedPids,
      now: this.clock,
    });
    const evidence = proofEvidence({
      purpose: input.purpose,
      host: input.host,
      port: input.port,
      owner: input.owner,
      proof: input.detail ? { ...proof, detail: proof.detail ?? input.detail } : proof,
      at: this.clock(),
    });
    this.persistLedger(recordPortEvidence(this.portLedger(), evidence));
    return proof;
  }

  private migratePort(purpose: PortPurpose, from: number, to: number, reason: string): void {
    this.persistLedger(
      recordPortMigration(this.portLedger(), {
        at: this.clock().toISOString(),
        purpose,
        from,
        to,
        reason,
      }),
    );
    logger.warn(`port ${purpose} migrated ${from} -> ${to}: ${reason}`);
  }

  /**
   * Proves the supervised core really holds the ports its configuration names.
   * Recorded as evidence, never trusted from the config alone.
   */
  /**
   * Proves the supervised core owns a loopback forward socket. This runs BEFORE
   * any request carrying the Gateway Key: a foreign listener on that port would
   * otherwise receive the key. A proof that is not `stable` is a hard failure.
   */
  private async proveForwardOwner(id: string, localPort: number): Promise<PortProof> {
    const snap = this.supervisor.snapshot();
    const proof = await this.recordPortProof({
      purpose: "forward",
      host: "127.0.0.1",
      port: localPort,
      owner: "easytier",
      reported: true,
      expectedPids: snap.pid ? [snap.pid] : [],
      detail: `forward to ${id}`,
    });
    return (
      proof ?? {
        state: "unverified",
        detail: "no forward proof was produced",
        pids: null,
        ownership: "none",
        reported: null,
      }
    );
  }

  private async reconcileCorePorts(cfg: PluginConfig): Promise<PortProof[]> {
    const snap = this.supervisor.snapshot();
    const running = Boolean(snap.running);
    const expected = snap.pid ? [snap.pid] : [];
    const proofs: (PortProof | null)[] = [];
    const listen = splitListenAddr(cfg.listenAddr);
    proofs.push(
      await this.recordPortProof({
        purpose: "overlay-listen",
        host: listen.host ?? "0.0.0.0",
        port: listen.port,
        owner: "easytier",
        reported: running,
        expectedPids: expected,
      }),
    );
    proofs.push(
      await this.recordPortProof({
        purpose: "easytier-rpc",
        host: "127.0.0.1",
        port: cfg.rpcPort,
        owner: "easytier",
        reported: running && (snap.rpcPort === null || snap.rpcPort === cfg.rpcPort),
        expectedPids: expected,
      }),
    );
    if (cfg.catalog.discoveryEnabled) {
      proofs.push(
        await this.recordPortProof({
          purpose: "catalog-socks",
          host: "127.0.0.1",
          port: cfg.catalog.socksPort,
          owner: "easytier",
          reported: running && (snap.socks5Port === null || snap.socks5Port === cfg.catalog.socksPort),
          expectedPids: expected,
        }),
      );
    }
    return proofs.filter((p): p is PortProof => p !== null);
  }

  /** Every core listener the last apply produced must be owned by the live core. */
  private assertCorePortsProven(proofs: PortProof[]): void {
    const bad = proofs.filter((p) => p.state !== "stable");
    if (bad.length === 0) return;
    throw new Error(
      `the overlay core does not own its listeners: ${bad.map((p) => `${p.state}: ${p.detail ?? "no detail"}`).join("; ")}`,
    );
  }

  /**
   * Before the core starts, move a stored port that is already held by somebody
   * else. Nothing is "just tried": the new port is reserved, persisted, and the
   * migration is recorded so the diagnostic shows what moved and why.
   */
  private async ensureConfiguredPorts(cfg: PluginConfig): Promise<void> {
    const snap = this.supervisor.snapshot();
    if (snap.running) return;
    const reserved = [this.gatewayPort(), cfg.catalog.port, cfg.catalog.socksPort];
    if (!(await this.binder.isFree("127.0.0.1", cfg.rpcPort))) {
      const next = await this.choosePort("easytier-rpc", "127.0.0.1", this.rpcCandidates(reserved), reserved);
      this.migratePort("easytier-rpc", cfg.rpcPort, next, "the stored RPC port was already in use");
      cfg.rpcPort = next;
      saveState(this.state);
    }
    const listen = splitListenAddr(cfg.listenAddr);
    if (listen.host && listen.port && !(await this.binder.isFree(listen.host, listen.port))) {
      const next = await this.choosePort("overlay-listen", listen.host, portRange(11010, 11059), [
        this.gatewayPort(),
        cfg.rpcPort,
        cfg.catalog.port,
        cfg.catalog.socksPort,
        listen.port,
      ]);
      this.migratePort("overlay-listen", listen.port, next, "the stored overlay listener port was already in use");
      cfg.listenAddr = `${cfg.listenAddr!.replace(/:\d+$/, "")}:${next}`;
      saveState(this.state);
    }
    if (cfg.catalog.discoveryEnabled && !(await this.binder.isFree("127.0.0.1", cfg.catalog.socksPort))) {
      const next = await this.choosePort("catalog-socks", "127.0.0.1", portRange(13400, 13424), [
        this.gatewayPort(),
        cfg.rpcPort,
        cfg.catalog.port,
      ]);
      this.migratePort("catalog-socks", cfg.catalog.socksPort, next, "the stored catalogue SOCKS5 port was already in use");
      cfg.catalog.socksPort = next;
      saveState(this.state);
    }
  }

  private async applyConfig(cfg: PluginConfig): Promise<void> {
    if (!this.ownsHost()) throw new Error("this Service instance does not own the host; refusing to rewrite or restart the overlay core");
    if (process.env.OH_MY_AIHUB_TRACE === "1") {
      const caller = (new Error().stack ?? "").split("\n").slice(2, 4).map((l) => l.trim()).join(" | ");
      logger.info(`trace applyConfig ${caller}`);
    }
    await this.ensureConfiguredPorts(cfg);
    await this.supervisor.start(this.etConfig(cfg));
    await this.supervisor.refresh().catch(() => this.supervisor.snapshot());
    this.assertCorePortsProven(await this.reconcileCorePorts(cfg));
  }

  /** The EasyTier configuration that implements the plugin's state. */
  private etConfig(cfg: PluginConfig): EasytierConfig {
    return {
      sharingEnabled: this.sharingActive(),
      consumingEnabled: cfg.consumingEnabled,
      nodeId: cfg.nodeId,
      instanceId: cfg.instanceId,
      networkName: cfg.networkName,
      networkSecret: cfg.networkSecret,
      peers: cfg.peers,
      virtualIpv4: cfg.virtualIpv4,
      overlayCidr: cfg.overlayCidr,
      listenAddr: cfg.listenAddr,
      rpcPort: cfg.rpcPort,
      proxyCidr: cfg.sharingEnabled || this.controlOnlyPublication() ? cfg.proxyCidr : null,
      mappedCidr: cfg.sharingEnabled || this.controlOnlyPublication() ? cfg.mappedCidr : null,
      publishedPorts: this.publishedPorts(cfg),
      socks5Proxy: cfg.catalog.discoveryEnabled ? `socks5://127.0.0.1:${cfg.catalog.socksPort}` : null,
      // A control forward is an outbound path to a peer: it belongs to the
      // consuming capability, exactly like a provider forward.
      portForwards: cfg.consumingEnabled ? this.allForwardSpecs() : [],
      secureMode: cfg.secureMode,
      secureIdentity: cfg.secureIdentity,
    };
  }

  /** The Forward ACL's ports: the gateway plus the catalogue only while it is published. */
  private publishedPorts(cfg: PluginConfig): number[] {
    if (cfg.sharingEnabled) {
      const ports = [...cfg.publishedPorts];
      if (this.catalogPublishing()) ports.push(cfg.catalog.port);
      // The control listener is a bounded P2P endpoint, never the AI gateway.
      if (this.controlActive && cfg.controlEnabled && cfg.controlPort) ports.push(cfg.controlPort);
      return [...new Set(ports)];
    }
    // Control-only: the node exports nothing of its Magpie. Exactly the
    // presence endpoint and the bounded control listener are forwarded.
    if (!this.controlOnlyPublication()) return [];
    return [...new Set([cfg.catalog.port, cfg.controlPort!])];
  }

  /**
   * A configured node that is not sharing models still takes part in the P2P
   * control plane: it publishes a signed presence and forwards only its
   * presence + control ports. That publication never includes the Magpie
   * gateway or a catalogue, and Inbound stays Drop with zero rules.
   */
  private controlOnlyPublication(): boolean {
    const cfg = this.state.config;
    return Boolean(cfg && cfg.controlEnabled && this.controlActive && cfg.controlPort && !cfg.sharingEnabled);
  }

  /** Provider forwards plus the control plane's owned loopback forwards. */
  private allForwardSpecs(): ForwardSpec[] {
    return [...this.forwardSpecs(), ...[...this.controlForwards.values()].map((f) => ({ ...f }))];
  }

  /** Read-only view of the owned control forwards (tests and diagnostics). */
  controlForwardView(): ForwardSpec[] {
    return [...this.controlForwards.values()].map((f) => ({ ...f }));
  }

  /** The canonical owned control-forward set survives a host handover. */
  private persistControlForwards(): void {
    const next = [...this.controlForwards.values()].slice(0, 16).map((f) => ({ bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
    const same = next.length === this.state.controlForwards.length &&
      next.every((f, i) => this.state.controlForwards[i]?.bindAddr === f.bindAddr && this.state.controlForwards[i]?.dstAddr === f.dstAddr);
    if (same) return;
    this.state.controlForwards = next;
    saveState(this.state);
  }

  /**
   * Opens a control forward and makes it part of the canonical set before the
   * listener exists: the supervisor's safety check must expect exactly this
   * forward, and a supervised restart must restore it from the generated TOML.
   */
  async addControlForward(bindAddr: string, dstAddr: string): Promise<boolean> {
    const bind = bindAddr.replace(/^tcp:\/\//, "");
    if (!/^127\.0\.0\.1:\d{1,5}$/.test(bind)) throw new Error("control forwards must bind 127.0.0.1");
    const existing = this.controlForwards.get(bind);
    this.controlForwards.set(bind, { bindAddr: bind, dstAddr });
    try {
      const added = await this.supervisor.addPortForward(bind, dstAddr);
      this.supervisor.setForwards(this.allForwardSpecs());
      this.persistControlForwards();
      return added;
    } catch (error) {
      if (existing) this.controlForwards.set(bind, existing);
      else this.controlForwards.delete(bind);
      throw error;
    }
  }

  private forwardSpecs(): ForwardSpec[] {
    return this.state.providers.map((p) => ({
      bindAddr: `127.0.0.1:${p.localPort}`,
      dstAddr: `${mappedHost(p.mappedCidr)}:${p.providerPort}`,
    }));
  }

  /**
   * Turns sharing on or off. Off removes the network publication (the export
   * and the Forward chain) and leaves every local provider, model and Gateway
   * Key of this node's own Magpie untouched.
   */
  async setSharing(enabled: boolean): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      if (enabled && cfg.share.models.length === 0) {
        throw new Error("choose at least one native model with share-native-models before enabling sharing");
      }
      if (enabled && cfg.share.models.some((m) => m.includes("*"))) {
        throw new Error(
          "refusing to share with a wildcard model policy: choose the exact native models with share-native-models " +
            "so future models are never shared without consent",
        );
      }
      const next: PluginConfig = {
        ...cfg,
        sharingEnabled: enabled,
        mappedCidr: cfg.mappedCidr ?? (enabled ? randomMappedCidr() : null),
        proxyCidr: enabled ? (this.lanIp() ? `${this.lanIp()}/32` : cfg.proxyCidr) : cfg.proxyCidr,
        publishedPorts: cfg.publishedPorts.length ? cfg.publishedPorts : [this.gatewayPort()],
      };
      if (enabled && !next.proxyCidr) throw new Error("no usable LAN address to export; connect this machine to a network first");
      this.state.config = next;
      saveState(this.state);
      await this.applyConfig(next);
      await this.applyCatalog();
      if (enabled) {
        // Never republish blindly: the guard may keep the export withdrawn.
        await this.guardSharedKeys().catch((e) => logger.warn(`share guard after enabling sharing: ${String(e)}`));
        this.lastProviderFingerprint = this.providerFingerprint();
        await this.reconcileProviders({ quiet: true }).catch(() => {});
        await this.publishCatalogNow().catch((e) => logger.warn(`catalogue rebuild after enabling sharing: ${String(e)}`));
      }
      logger.info(enabled ? "sharing enabled: the gateway is published on the overlay" : "sharing disabled: the network publication was withdrawn");
      this.notifyTopology();
      return this.status();
    });
  }

  /**
   * Turns consumption on or off. Off removes only the Remote Magpie providers
   * this plugin registered and the forwards that went with them; a provider the
   * operator added by hand in Magpie is never touched. The connection records
   * and their keys are kept so turning it back on restores them.
   */
  async setConsuming(enabled: boolean): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      const next: PluginConfig = { ...cfg, consumingEnabled: enabled };
      this.state.config = next;
      saveState(this.state);
      if (!enabled) {
        await this.dropRemoteRegistrations("consumption disabled");
        for (const p of this.state.providers) {
          p.status = "disabled";
          p.detail = "consumption is disabled";
          p.updatedAt = new Date().toISOString();
        }
        saveState(this.state);
        // The forwards must go too; 2.6.4 can only drop them by restarting.
        await this.applyConfig(next);
      } else {
        await this.applyConfig(next);
        await this.reconcileProviders({ quiet: true });
      }
      logger.info(enabled ? "consumption enabled" : "consumption disabled: remote providers were unregistered");
      return this.status();
    });
  }

  /** Provider: publishes a port (ACL + restart) and re-verifies. */
  async publishPorts(ports: number[]): Promise<StatusSnapshot> {
    const cfg = this.state.config;
    if (!cfg || !cfg.sharingEnabled) throw new Error("only a node that shares its Magpie publishes ports");
    return this.configure({ publishedPorts: ports });
  }

  /**
   * Validates an external share selection against the node's own native model
   * snapshot. Exact ids must exist and have a complete price; wildcards expand
   * to priced native models only. No pricing logic is duplicated: this uses the
   * same `catalogModel`/`priceSnapshot` path as shareCandidates.
   */
  private async validateShareSelection(entries: string[], opts: { expandGlobs: boolean }): Promise<string[]> {
    const requested = [...new Set(entries.map((m) => m.trim()).filter(Boolean))];
    if (!requested.length) throw new Error("choose at least one native model");
    const models = await this.nativeShareCandidates();
    const byId = new Map(models.map((m) => [m.id, m]));
    const hasGlob = requested.some((m) => m.includes("*"));
    if (hasGlob && !opts.expandGlobs) {
      throw new Error("refusing a wildcard share policy: choose the exact native models with their prices first");
    }
    let exact: string[];
    if (hasGlob) {
      const selected = new Set<string>();
      const dropped: string[] = [];
      for (const token of requested) {
        if (!token.includes("*")) {
          if (!byId.has(token)) throw new Error(`refusing to share ${token}: it is not a native model`);
          selected.add(token);
          continue;
        }
        if (token !== "*" && !/^[A-Za-z0-9._-]+\/\*$/.test(token)) {
          throw new Error(`share model glob must be "*" or "provider/*": ${token}`);
        }
        const matches = models.filter((m) => allowedByPolicy(m.id, { models: [token] }));
        if (!matches.length) throw new Error(`the wildcard ${token} matches no native model`);
        for (const m of matches) {
          if (m.completePrice) selected.add(m.id);
          else dropped.push(m.id);
        }
      }
      exact = [...selected].sort();
      if (!exact.length) throw new Error("the wildcard matched no native model with a complete effective price");
      if (dropped.length) logger.warn(`wildcard share policy left out ${dropped.join(", ")} (no complete effective price)`);
    } else {
      exact = [...requested].sort();
    }
    const bad: string[] = [];
    for (const model of exact) {
      const candidate = byId.get(model);
      if (!candidate) bad.push(`${model}: not a native model`);
      else if (!candidate.completePrice) bad.push(`${model}: no complete effective price`);
    }
    if (bad.length) throw new Error(`refusing to share an unverified model snapshot: ${bad.join("; ")}`);
    return exact;
  }

  /**
   * Replaces the sharing allow list.
   *
   * A wildcard is never stored: with `confirmExact` it is expanded against the
   * node's own native, complete-price models; without it the call fails closed.
   * Exact ids are also checked against that same snapshot, so the allow list is
   * always a concrete consent record rather than "everything, forever".
   */
  async setShareModels(
    models: string[],
    opts: { confirmExact?: boolean; strict?: boolean } = {},
  ): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      if (opts.strict !== true) {
        // Internal/maintainer callers with already-reviewed lists keep the old
        // allow-list semantics; public HTTP/console/CLI callers set strict.
        cfg.share = { models: normalizeShareModels(models) };
        saveState(this.state);
        await this.guardSharedKeys();
        await this.publishCatalogNow().catch((e) => logger.warn(`catalogue rebuild after share models: ${String(e)}`));
        return this.status();
      }
      if (models.some((m) => m.includes("*")) && opts.confirmExact !== true) {
        throw new Error(
          "refusing a wildcard share policy: expand it to exact native models and confirm the reviewed price snapshot " +
            "(confirmExact: true)",
        );
      }
      const exact = await this.validateShareSelection(models, { expandGlobs: true });
      cfg.share = { models: exact };
      if (this.state.shareSuspended?.reason.startsWith(SHARE_POLICY_SUSPENSION)) this.state.shareSuspended = null;
      saveState(this.state);
      await this.guardSharedKeys();
      await this.publishCatalogNow().catch((e) => logger.warn(`catalogue rebuild after share models: ${String(e)}`));
      return this.status();
    });
  }

  /**
   * The native models this node could share, with the effective price and
   * whether that price is complete enough to back a capped key. Read-only: it
   * never creates a key, publishes a quote or changes the allow list.
   */
  /** The node's own native, priced models — the only source of a share snapshot. */
  private async nativeShareCandidates(): Promise<ShareCandidate[]> {
    const metas = await this.probes.catalogModels().catch((e) => {
      throw new Error(`cannot read Magpie's native models: ${(e as Error).message}`);
    });
    const native = this.deps.magpie.nativeProviderIds();
    const remote = this.deps.magpie.remoteProviderIds();
    const models: ShareCandidate[] = [];
    for (const meta of metas) {
      if (!meta.id.includes("/")) continue;
      const provider = meta.id.split("/")[0];
      if (provider === "group" || provider === "auto") continue;
      if (remote.has(provider) || !native.has(provider)) continue;
      const model = catalogModel(meta);
      if (!model) continue;
      models.push({
        id: meta.id,
        displayName: meta.displayName,
        provider,
        pricing: model.pricing,
        completePrice: !meta.priceUnsupported && priceSnapshot([meta], [meta.id]) !== null,
        allowedByPolicy: false,
        unsupportedPrice: meta.priceUnsupported ?? null,
      });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }

  async shareCandidates(): Promise<ShareCandidatesView> {
    const cfg = this.state.config;
    if (!cfg) throw new Error("configure this node first");
    const models = (await this.nativeShareCandidates()).map((m) => ({
      ...m,
      allowedByPolicy: allowedByPolicy(m.id, cfg.share),
    }));
    const selected = models.filter((m) => m.allowedByPolicy && m.completePrice);
    const priceVersion = catalogPriceVersion(selected.map((m) => ({ id: m.id, pricing: m.pricing })));
    const blocking = models
      .filter((m) => m.allowedByPolicy && !m.completePrice)
      .map((m) => ({
        id: m.id,
        reason: m.unsupportedPrice
          ? `unsupported dynamic price (${m.unsupportedPrice}); a capped key cannot be issued`
          : "no complete effective price; a capped key cannot be issued",
      }));
    return {
      policy: [...cfg.share.models],
      models,
      priceVersion,
      priceLocked: false,
      blocking,
      detectedAt: new Date().toISOString(),
      source: "magpie-native" as const,
    };
  }

  // --- read-only catalogue ---------------------------------------------------

  /** Attach the signed control-presence document to the read-only catalog listener. */
  setControlPresence(presence: (() => unknown | null) | null): void {
    this.controlPresenceProvider = presence;
    this.catalogServer?.setPresence?.(presence);
  }

  /** The control listener started (or stopped): re-evaluate what may be published. */
  setControlActive(active: boolean): void {
    this.controlActive = active;
  }

  /** Registers a re-sync callback for successful topology changes. */
  setTopologyListener(listener: (() => Promise<void>) | null): void {
    this.topologyListener = listener;
  }

  private notifyTopology(): void {
    if (!this.topologyListener) return;
    void this.topologyListener().catch((e) => logger.warn(`control plane re-sync failed: ${String(e)}`));
  }

  /** Persists the control port so the Forward ACL and the next boot use it. */
  setControlPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid control port");
    const cfg = this.state.config;
    if (!cfg) return;
    if (cfg.controlPort === port) return;
    cfg.controlPort = port;
    saveState(this.state);
  }

  /** Allocates and persists a control port before the core starts, when none is set. */
  async ensureControlPort(): Promise<number | null> {
    const cfg = this.state.config;
    if (!cfg?.controlEnabled) return null;
    if (cfg.controlPort) return cfg.controlPort;
    const claim = await claimFreePort(this.binder, "127.0.0.1", portRange(35000, 35099));
    const port = claim.reservation.port;
    await claim.reservation.release();
    this.setControlPort(port);
    return port;
  }

  /**
   * Applies the control plane's publication: the control port when sharing, or
   * the presence + control ports when the node shares no models. A change to
   * the exported address or the Forward set is a config change and therefore a
   * supervised restart (EasyTier 2.6.4 has no hot ACL edit).
   */
  async applyControlPublication(): Promise<void> {
    const cfg = this.state.config;
    if (!cfg) return;
    if (this.controlActive && cfg.controlEnabled && !cfg.sharingEnabled) {
      if (!cfg.mappedCidr) cfg.mappedCidr = randomMappedCidr();
      if (!cfg.proxyCidr && this.lanIp()) cfg.proxyCidr = `${this.lanIp()}/32`;
      saveState(this.state);
    }
    const desired = this.publishedPorts(cfg);
    const et = this.supervisor.snapshot();
    const samePorts = desired.length === et.publishedPorts.length && desired.every((p) => et.publishedPorts.includes(p));
    const sameExport =
      (cfg.sharingEnabled || this.controlOnlyPublication())
        ? et.mappedCidr === cfg.mappedCidr
        : et.mappedCidr === null;
    if (!samePorts || !sameExport) await this.applyConfig(cfg);
    await this.applyCatalog();
    await this.applyPresenceOnly();
  }

  /** Starts or stops the presence-only listener used by control-only nodes. */
  private async applyPresenceOnly(): Promise<void> {
    const cfg = this.state.config;
    // Serve the signed presence ourselves whenever the catalogue server is not
    // doing it: a node may share models with its catalogue unpublished, and a
    // node that shares nothing must still be discoverable for the control plane.
    const wanted = Boolean(cfg && this.controlActive && cfg.controlEnabled && !this.catalogPublishing());
    if (!wanted) {
      this.stopPresenceServer();
      return;
    }
    const host = this.lanIp();
    if (!host) {
      this.stopPresenceServer();
      logger.warn("no LAN address for the signed presence; the control-only node will not be discoverable");
      return;
    }
    if (this.presenceServer && this.presenceServer.port === cfg!.catalog.port) return;
    if (this.presencePortMigrating) return;
    this.stopPresenceServer();
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = this.state.config!;
      try {
        this.presenceServer = this.probes.catalogServer({
          hostname: host,
          port: current.catalog.port,
          // No catalogue document: only the signed presence is served.
          document: () => null,
          presence: () => this.controlPresenceProvider?.() ?? null,
        });
        logger.info(`signed presence published on ${host}:${current.catalog.port} (no models shared)`);
        return;
      } catch (e) {
        const why = String((e as Error).message ?? e);
        this.presenceServer = null;
        const portTaken = /in use|EADDRINUSE|address already in use|failed to start server/i.test(why);
        if (!portTaken || attempt > 0) {
          logger.error(`cannot publish the signed presence on ${host}:${current.catalog.port}: ${why}`);
          return;
        }
        // The presence port is in the Forward ACL, so a collision is a config
        // migration plus a supervised core restart, never a silent retry loop.
        this.presencePortMigrating = true;
        try {
          const next = await this.choosePort("catalog", host, portRange(CATALOG_PORT_WINDOW[0], CATALOG_PORT_WINDOW.at(-1)!), [
            this.gatewayPort(),
            current.rpcPort,
            current.catalog.socksPort,
            current.catalog.port,
          ]);
          this.migratePort("catalog", current.catalog.port, next, `the signed-presence port was unavailable: ${why}`);
          this.state.config = { ...current, catalog: { ...current.catalog, port: next } };
          saveState(this.state);
          await this.applyConfig(this.state.config);
        } catch (migrationError) {
          logger.error(`cannot migrate the signed-presence port: ${String((migrationError as Error)?.message ?? migrationError)}`);
          return;
        } finally {
          this.presencePortMigrating = false;
        }
      }
    }
  }

  private stopPresenceServer(): void {
    if (!this.presenceServer) return;
    try {
      this.presenceServer.stop();
    } catch {
      /* already gone */
    }
    this.presenceServer = null;
  }

  /** Whether the catalogue should be on the network right now. */
  private catalogPublishing(): boolean {
    const cfg = this.state.config;
    return Boolean(cfg?.catalog.enabled && cfg.sharingEnabled && this.sharingActive() && !this.state.shareSuspended);
  }

  async setCatalogPublishing(enabled: boolean): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      if (enabled && !cfg.sharingEnabled) {
        throw new Error("publishing a catalogue requires sharing this node's Magpie; enable sharing first");
      }
      const next: PluginConfig = { ...cfg, catalog: { ...cfg.catalog, enabled } };
      this.state.config = next;
      saveState(this.state);
      // The catalogue port is part of the Forward ACL, so changing publication
      // is a config change and a supervised core restart (2.6.4 has no hot ACL).
      await this.applyConfig(next);
      await this.applyCatalog();
      if (enabled) await this.publishCatalogNow();
      logger.info(enabled ? "catalogue publishing enabled" : "catalogue publishing disabled; its Forward port is withdrawn");
      return this.status();
    });
  }

  async setCatalogDiscovery(enabled: boolean): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      const next: PluginConfig = { ...cfg, catalog: { ...cfg.catalog, discoveryEnabled: enabled } };
      this.state.config = next;
      saveState(this.state);
      // The SOCKS5 listener lives in the generated TOML; start/stop is a restart.
      await this.applyConfig(next);
      this.catalogNextRefreshAt = 0;
      if (enabled) await this.refreshCatalogPeers();
      else this.catalogPeers = [];
      logger.info(enabled ? "catalogue discovery enabled" : "catalogue discovery disabled");
      return this.status();
    });
  }

  async setCatalogOptions(patch: {
    displayName?: string | null;
    contact?: string | null;
    port?: number;
    socksPort?: number;
    refreshSec?: number;
    minTopUpUsd?: number;
  }): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      const catalog = normalizeCatalogConfig(
        {
          ...cfg.catalog,
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.contact !== undefined ? { contact: patch.contact } : {}),
          ...(patch.port !== undefined ? { port: patch.port } : {}),
          ...(patch.socksPort !== undefined ? { socksPort: patch.socksPort } : {}),
          ...(patch.refreshSec !== undefined ? { refreshSec: patch.refreshSec } : {}),
          ...(patch.minTopUpUsd !== undefined ? { minTopUpUsd: patch.minTopUpUsd } : {}),
        },
        { gatewayPort: this.gatewayPort(), reserved: [cfg.rpcPort], strict: true },
      );
      const networkChanged = catalog.port !== cfg.catalog.port || catalog.socksPort !== cfg.catalog.socksPort;
      const next: PluginConfig = { ...cfg, catalog };
      this.state.config = next;
      saveState(this.state);
      if (networkChanged) {
        await this.applyConfig(next);
        await this.applyCatalog();
      } else {
        await this.publishCatalogNow().catch((e) => logger.warn(`catalogue rebuild after options: ${String(e)}`));
      }
      this.catalogNextRefreshAt = 0;
      return this.status();
    });
  }

  catalogStatus(): CatalogStatus {
    const cfg = this.state.config?.catalog;
    return {
      config: cfg ?? normalizeCatalogConfig(undefined),
      publishing: this.catalogPublishing(),
      server: {
        running: this.catalogServer !== null,
        port: this.catalogServer?.port ?? null,
        address: this.catalogServer && cfg ? `${this.lanIp() ?? "?"}:${cfg.port}` : null,
        error: this.catalogServerError,
      },
      quote: this.catalogQuote
        ? {
            version: this.catalogQuote.publication.version,
            updatedAt: this.catalogQuote.publication.updatedAt,
            publishedAt: this.catalogQuote.publication.publishedAt,
            contentHash: this.catalogQuoteHash ?? "",
            modelCount: this.catalogQuote.models.length,
            models: this.catalogQuote.models.map((m) => ({ ...m })),
            // Safe read-only clone: the page needs the quote's real billing
            // version/lock flags; it must never be able to mutate the signed body.
            billing: { ...this.catalogQuote.billing },
            identity: this.catalogQuote.identity,
          }
        : null,
      peers: this.catalogPeers.map((p) => ({ ...p })),
      lastRefreshAt: this.catalogLastRefreshAt,
      refreshing: this.catalogRefreshing,
      error: this.catalogError,
    };
  }

  peersInDirectory(): CatalogPeerView[] {
    return this.catalogPeers.map((p) => ({ ...p }));
  }

  /** The signed document the catalogue server returns; null unless published. */
  localCatalog(): SignedCatalog | null {
    return this.catalogPublishing() ? this.catalogQuote : null;
  }

  async refreshCatalog(): Promise<CatalogPeerView[]> {
    await this.refreshCatalogPeers();
    return this.peersInDirectory();
  }

  async trustCatalogPeer(nodeId: string, fingerprint: string): Promise<CatalogTrustRecord> {
    if (!isValidNodeId(nodeId)) throw new Error("a catalogue node id must be 8-64 lowercase hex characters");
    if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error("trustCatalogPeer requires the exact 64 lowercase hex fingerprint the operator reviewed");
    }
    const trust = loadCatalogTrust();
    if (!Object.hasOwn(trust, nodeId)) throw new Error(`no catalogue identity is known for node ${nodeId}`);
    const rec = trust[nodeId];
    if (!rec.pending) {
      // First-seen acceptance is still explicit: the caller must name the
      // fingerprint already in the trust record. A wrong value changes nothing.
      if (fingerprint !== rec.fingerprint) {
        throw new Error(`the seen fingerprint is ${rec.fingerprint}, not ${fingerprint}`);
      }
      rec.accepted = true;
      saveCatalogTrust(trust);
      this.syncTrustedPeerCache(nodeId, rec);
      return rec;
    }
    if (fingerprint !== rec.pending.fingerprint) {
      throw new Error(`the pending fingerprint is ${rec.pending.fingerprint}, not ${fingerprint}`);
    }
    rec.publicKey = rec.pending.publicKey;
    rec.fingerprint = rec.pending.fingerprint;
    rec.keyId = rec.pending.keyId;
    rec.overlayHostname = rec.pending.hostname;
    rec.firstSeenAt = new Date().toISOString();
    rec.lastSeenAt = rec.firstSeenAt;
    rec.accepted = true;
    rec.pending = null;
    // An explicitly accepted key may have reset its quote version. Do not let
    // the old key's version make the new identity look like a rollback.
    rec.quoteVersion = 0;
    rec.quoteHash = null;
    saveCatalogTrust(trust);
    logger.warn(`accepted a changed catalogue identity for ${nodeId}: ${rec.fingerprint}`);
    // The cached quote still carries the old identity after a change. Do not
    // relabel it; only a new read may mark the new identity verified.
    this.syncTrustedPeerCache(nodeId, rec);
    await this.refreshCatalogPeers().catch(() => {});
    return rec;
  }

  /** Update the in-memory peer status only when the cached quote really belongs to the accepted key. */
  private syncTrustedPeerCache(nodeId: string, rec: CatalogTrustRecord): void {
    for (const peer of this.catalogPeers) {
      if (peer.nodeId !== nodeId && peer.hostname !== rec.overlayHostname) continue;
      if (peer.status === "stale" || peer.status === "conflict") continue;
      if (peer.nodeId !== nodeId) continue;
      if (!peer.identity || peer.identity.fingerprint !== rec.fingerprint) continue;
      if (!peer.quote || peer.quote.identity?.fingerprint !== rec.fingerprint) continue;
      if (peer.status === "unverified") {
        peer.status = "verified";
        peer.detail = "accepted locally; same Ed25519 key as before (TOFU)";
      }
    }
  }

  /** A manual connection request; never creates a key or a paid account. */
  catalogRequest(nodeId: string, models?: string[], acceptance?: CatalogAcceptance): Record<string, unknown> {
    const peer = this.catalogPeers.find((p) => p.identity?.keyId === nodeId || p.nodeId === nodeId || p.hostname === nodeId);
    if (!peer) throw new Error(`no discovered catalogue peer ${nodeId}; refresh the directory first`);
    const usability = catalogQuoteUsability(peer);
    if (!usability.usable) throw new Error(`${peer.hostname} ${usability.detail}`);
    if (!peer.quote || !peer.mappedCidr) throw new Error(`no catalogue quote from ${peer.hostname} yet`);
    assertCatalogAcceptance(peer, acceptance);
    if (models !== undefined && !Array.isArray(models)) throw new Error("models must be an array of provider/model ids");
    const available = peer.quote.models.map((m) => m.id);
    const wanted = models && models.length ? models : available;
    if (!Array.isArray(wanted) || wanted.length === 0 || wanted.length > CATALOG_MAX_MODELS) {
      throw new Error(`choose 1-${CATALOG_MAX_MODELS} models from the catalogue`);
    }
    if (wanted.some((m) => !isValidModelId(m))) throw new Error("a requested model is not a safe provider/model id");
    if (new Set(wanted).size !== wanted.length) throw new Error("a requested model is repeated");
    const missing = wanted.filter((m) => !available.includes(m));
    if (missing.length) throw new Error(`${peer.hostname} does not offer: ${missing.join(", ")}`);
    // A quote's billing.priceVersion covers every quoted model; a request may
    // choose a subset. Bind the key to the version of exactly those models.
    const selectedPriceVersion = catalogPriceVersion(peer.quote.models.filter((m) => wanted.includes(m.id)));
    if (!selectedPriceVersion) {
      throw new Error(`${peer.hostname} has no complete static price for the selected models (peak/rate-window pricing is unsupported); a capped key cannot be issued`);
    }
    if (acceptance?.priceVersion !== undefined && acceptance.priceVersion !== selectedPriceVersion) {
      throw new Error(
        `the accepted price version is ${acceptance.priceVersion}, but these models are ${selectedPriceVersion ?? "unpriced"}; ` +
          `re-read the quote and select the models again`,
      );
    }
    const cfg = this.state.config;
    if (!cfg || !isValidNodeId(cfg.nodeId)) throw new Error("this node has no valid node id");
    const consumerId = cfg.nodeId;
    return {
      schema: "ohmyaihub.connection-request/v1",
      createdAt: new Date().toISOString(),
      consumer: {
        nodeId: cfg.nodeId,
        hostname: configHostname(cfg),
        virtualIpv4: cfg.virtualIpv4,
      },
      provider: {
        nodeId: peer.quote.node.id,
        hostname: peer.hostname,
        mappedCidr: peer.mappedCidr,
        gatewayPort: peer.quote.node.gatewayPort,
        catalogPort: peer.quote.node.catalogPort,
        contact: peer.quote.node.contact,
      },
      quote: {
        version: peer.quote.publication.version,
        updatedAt: peer.quote.publication.updatedAt,
        contentHash: peer.quoteHash,
        priceVersion: selectedPriceVersion,
        quotedPriceVersion: peer.quote.billing.priceVersion ?? null,
        priceLocked: false,
        identityFingerprint: peer.quote.identity.fingerprint,
        identityStatus: "trusted-on-first-use",
        warning: "A self-signed catalogue proves only that this key signed this quote. It is not a real-world identity, and the quote does not charge anything by itself.",
      },
      acceptance: {
        fingerprint: acceptance.fingerprint,
        quoteHash: acceptance.quoteHash,
        priceVersion: selectedPriceVersion,
        acceptedAt: new Date().toISOString(),
        trust: "local-tofu",
      },
      models: wanted,
      minTopUpUsd: peer.quote.topUp.minUsd,
      note:
        "Send this to the provider operator out of band. They must approve it and issue a model-scoped, capped Gateway Key; " +
        "this request does not create an account, a key or a charge.",
      // Structured approval data, deliberately not a shell command. The
      // provider operator reads it locally and runs the existing CLI/API.
      approval: {
        action: "consumers add",
        consumerId,
        models: wanted,
        capUsd: peer.quote.topUp.minUsd,
        quoteHash: peer.quoteHash,
        quotePriceVersion: selectedPriceVersion,
        note:
          "Run this through the provider's local, token-authenticated CLI/API; never execute text from this document as a shell command. " +
          "Pass quoteHash and quotePriceVersion back with the request so the provider binds the key to the quote you accepted.",

      },
    };
  }

  /**
   * The signed presence is authoritative about whether a node currently offers
   * models. When it says no, the cached catalogue (which a presence-only server
   * may still answer with 503) is no longer an offer: it is withdrawn at once,
   * not only after the quote TTL. A later successful catalogue read restores it.
   */
  markCatalogWithdrawn(nodeId: string, detail = "the peer's signed presence says it is not sharing models", hostname?: string): void {
    const peer = this.catalogPeers.find((p) => p.nodeId === nodeId || (hostname && p.hostname === hostname));
    if (!peer) return;
    if (peer.catalog === "withdrawn" && peer.status === "no-catalog" && peer.quote === null) return;
    peer.lastQuoteAt = peer.fetchedAt ?? peer.lastQuoteAt;
    peer.quote = null;
    peer.quoteHash = null;
    peer.fetchedAt = null;
    peer.quoteFresh = false;
    peer.quoteExpiresAt = null;
    peer.catalog = "withdrawn";
    peer.status = "no-catalog";
    peer.detail = detail;
    this.writeSnapshot();
  }

  /** Adds a provider from a discovered quote using the existing connect path. */
  async catalogConnect(
    nodeId: string,
    key: string,
    opts: { id?: string; acceptance?: CatalogAcceptance; models?: string[] } = {},
  ): Promise<ProviderView> {
    return this.serialize(async () => {
    const peer = this.catalogPeers.find((p) => p.identity?.keyId === nodeId || p.nodeId === nodeId || p.hostname === nodeId);
    if (!peer) throw new Error(`no discovered catalogue peer ${nodeId}; refresh the directory first`);
    const usability = catalogQuoteUsability(peer);
    if (!usability.usable) throw new Error(`${peer.hostname} ${usability.detail}`);
    if (!peer.quote || !peer.mappedCidr) throw new Error(`no catalogue quote from ${peer.hostname} yet`);
    assertCatalogAcceptance(peer, opts.acceptance);
    const id = opts.id ?? `peer-${peer.quote.node.id.replace(/[^a-z0-9-]/gi, "").slice(0, 20)}`;
    const revalidate = () => {
      const current = this.catalogPeers.find(p => p.nodeId === peer.nodeId);
      if (!current || !current.online || !current.quote || !current.mappedCidr) throw new RequestValidationError("the provider disappeared; refresh discovery before connecting");
      const currentUsability = catalogQuoteUsability(current);
      if (!currentUsability.usable) throw new RequestValidationError(`the provider's quote is no longer usable: ${currentUsability.detail}`);
      assertCatalogAcceptance(current, opts.acceptance);
      if (current.mappedCidr !== peer.mappedCidr || current.quote.node.gatewayPort !== peer.quote!.node.gatewayPort) throw new RequestValidationError("the provider address changed while connecting");
      if (opts.models) {
        if (opts.models.some(id => !current.quote!.models.some(m => m.id === id)) || catalogPriceVersion(current.quote.models.filter(m => opts.models!.includes(m.id))) !== opts.acceptance?.priceVersion) {
          throw new RequestValidationError("authorization model prices changed while connecting");
        }
      }
    };
    revalidate();
    return this.connectProvider({
      id: id.toLowerCase(),
      mappedCidr: peer.mappedCidr,
      key,
      providerPort: peer.quote.node.gatewayPort,
    }, { update: false, beforeRegister: revalidate, expectedModels: opts.models, acceptedFingerprint: opts.acceptance?.fingerprint });
    });
  }

  // --- catalogue internals ---------------------------------------------------

  private stopCatalogServer(): void {
    if (this.catalogServer) {
      try {
        this.catalogServer.stop();
      } catch {
        /* already gone */
      }
      this.catalogServer = null;
    }
  }

  /** Starts, keeps or stops the local catalogue listener for the current state. */
  private async applyCatalog(): Promise<void> {
    if (!this.catalogPublishing()) {
      this.stopCatalogServer();
      this.catalogQuote = null;
      this.catalogQuoteHash = null;
      this.catalogServerError = null;
      this.writeSnapshot();
      // A node that does not publish a catalogue may still publish a signed
      // presence for the control plane.
      await this.applyPresenceOnly();
      return;
    }
    // While the catalogue runs it serves /p2p/v1/presence itself; a separate
    // presence-only listener on the same port would fail to bind.
    this.stopPresenceServer();
    const host = this.lanIp();
    if (!host) {
      this.catalogServerError = "no usable LAN address to bind the catalogue";
      this.stopCatalogServer();
      logger.error(this.catalogServerError);
      throw new Error(this.catalogServerError);
    }
    // A catalogue port held by another process is migrated, not "tried again":
    // the Forward ACL names the port, so this is a config change and a restart.
    for (let attempt = 0; attempt < 3; attempt++) {
      const cfg = this.state.config!;
      try {
        if (!this.catalogServer || this.catalogServer.port !== cfg.catalog.port) {
          this.stopCatalogServer();
          this.catalogServer = this.probes.catalogServer({
            hostname: host,
            port: cfg.catalog.port,
            document: () => this.localCatalog(),
            presence: () => this.controlPresenceProvider?.() ?? null,
          });
        }
        await this.publishCatalogNow();
        this.catalogServerError = null;
        await this.recordPortProof({
          purpose: "catalog",
          host,
          port: cfg.catalog.port,
          owner: "plugin",
          reported: true,
          expectedPids: [process.pid],
        });
        return;
      } catch (e) {
        const why = String((e as Error).message ?? e);
        this.catalogServerError = why;
        this.stopCatalogServer();
        const portTaken = /in use|EADDRINUSE|address already in use|failed to start server/i.test(why);
        if (!portTaken) {
          this.writeSnapshot();
          throw new Error(`the catalogue could not be published: ${why}`);
        }
        const next = await this.choosePort("catalog", host, portRange(CATALOG_PORT_WINDOW[0], CATALOG_PORT_WINDOW.at(-1)!), [
          this.gatewayPort(),
          cfg.rpcPort,
          cfg.catalog.socksPort,
          cfg.catalog.port,
        ]);
        this.migratePort("catalog", cfg.catalog.port, next, `the catalogue port was unavailable: ${why}`);
        this.state.config = { ...cfg, catalog: { ...cfg.catalog, port: next } };
        saveState(this.state);
        // The published ACL contains the catalogue port: apply the new config.
        await this.applyConfig(this.state.config);
      }
    }
    const why = this.catalogServerError ?? "no free catalogue port";
    logger.error(`the catalogue could not be published: ${why}`);
    this.writeSnapshot();
    throw new Error(`the catalogue could not be published: ${why}`);
  }

  /**
   * Builds and signs the current quote. The version rises only when the signed
   * content changes, so a reader can tell a refresh from a new quote. No key,
   * upstream address, network secret or admin field is ever placed in it.
   */
  private async publishCatalogNow(): Promise<void> {
    const cfg = this.state.config;
    if (!cfg || !this.catalogPublishing()) return;
    const identity = loadOrCreateCatalogIdentity();
    const metas = await this.probes.catalogModels().catch(() => [] as CatalogModelMeta[]);
    const native = this.deps.magpie.nativeProviderIds();
    const remote = this.deps.magpie.remoteProviderIds();
    const models: CatalogModel[] = [];
    for (const meta of metas) {
      const provider = meta.id.split("/")[0];
      if (!meta.id.includes("/") || provider.startsWith("group") || provider.startsWith("auto")) continue;
      if (remote.has(provider) || !native.has(provider)) continue;
      if (!allowedByPolicy(meta.id, cfg.share)) continue;
      if (!isValidModelId(meta.id)) {
        logger.warn(`not publishing ${JSON.stringify(meta.id)}: it is not a safe provider/model id`);
        continue;
      }
      const model = catalogModel(meta);
      if (model) models.push(model);
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    if (models.length > CATALOG_MAX_MODELS) {
      logger.warn(`catalogue has ${models.length} models; publishing the first ${CATALOG_MAX_MODELS}`);
      models.length = CATALOG_MAX_MODELS;
    }
    const now = new Date().toISOString();
    const node = {
      id: cfg.nodeId,
      displayName: cfg.catalog.displayName ?? configHostname(cfg),
      hostname: configHostname(cfg),
      virtualIpv4: cfg.virtualIpv4.replace(/\/\d+$/, ""),
      mappedCidr: cfg.mappedCidr ?? "",
      gatewayPort: this.gatewayPort(),
      catalogPort: cfg.catalog.port,
      contact: cfg.catalog.contact,
    };
    const topUp = {
      minUsd: cfg.catalog.minTopUpUsd,
      simulated: true as const,
      note:
        "Minimum top-up is a test-credit quote. BSC/Base Sepolia mock testnet deposits may be configured separately; " +
        "there is no mainnet or real-money credit.",
    };
    const priceVersion = catalogPriceVersion(models);
    const billing = {
      quoteOnly: true as const,
      charged: false as const,
      note:
        "Display only. A prepaid key is issued only when every quoted model has a complete effective price; " +
        "the price version binds this quote to those prices, but Magpie itself has no price pinning.",
      priceVersion,
      priceLocked: false as const,
    };
    // The version/dirty check must not include `publication`: it carries the
    // timestamp/version that this very check produces. Keep this material hash
    // for savePublishState only; the hash a reader receives is the full unsigned
    // body (including publication), exactly what verifySignedCatalog computes.
    const materialHash = sha256Hex(canonicalJson({ schema: "ohmyaihub.catalog/v1", node, models, topUp, billing, identity: identity.summary }));
    const prev = loadPublishState();
    let version = prev.versionNumber;
    let updatedAt = prev.updatedAt ?? now;
    let publishedAt = prev.publishedAt ?? now;
    if (materialHash !== prev.contentHash) {
      version = Math.max(1, prev.versionNumber + 1);
      updatedAt = now;
      publishedAt = prev.publishedAt ?? now;
      savePublishState({ version: 1, publishedAt, versionNumber: version, updatedAt, contentHash: materialHash });
    } else if (!version) {
      version = 1;
      updatedAt = now;
      publishedAt = prev.publishedAt ?? now;
      savePublishState({ version: 1, publishedAt, versionNumber: version, updatedAt, contentHash: materialHash });
    }
    const body: CatalogQuoteBody = {
      schema: "ohmyaihub.catalog/v1",
      node,
      publication: {
        status: "published",
        version,
        updatedAt,
        publishedAt,
        note:
          "Read-only display data. Real charging requires a manually approved, model-scoped, capped Gateway Key and a later " +
          "price-lock check; this quote never changes a key's limit or creates an account.",
      },
      models,
      topUp,
      billing,
      identity: identity.summary,
    };
    const signed = signCatalog(body, identity);
    // Same bytes the peer's verifySignedCatalog hashes: full unsigned body,
    // including publication. `materialHash` above remains the version input.
    const verified = verifySignedCatalog(signed);
    this.catalogQuote = signed;
    this.catalogQuoteHash = verified.contentHash;
    this.catalogQuoteVersion = version;
    this.catalogQuoteUpdatedAt = updatedAt;
    this.catalogNextQuoteAt = Date.now() + Math.max(30, cfg.catalog.refreshSec) * 1000;
    this.catalogError = null;
    this.writeSnapshot();
  }

  /**
   * Reads every reachable peer's catalogue through the loopback SOCKS5
   * listener. It never adds a port forward, never restarts EasyTier and never
   * writes to another node.
   */
  private async refreshCatalogPeers(): Promise<CatalogPeerView[]> {
    const cfg = this.state.config;
    if (!cfg?.catalog.discoveryEnabled) {
      this.catalogPeers = [];
      return [];
    }
    if (this.catalogRefreshing) return this.catalogPeers;
    this.catalogRefreshing = true;
    this.catalogError = null;
    try {
      const [peers, routes] = await Promise.all([this.supervisor.peers(), this.supervisor.routes()]);
      const classified = classifyPeers(peers, routes, {
        hostname: configHostname(cfg),
        virtualIpv4: this.supervisor.snapshot().virtualIpv4 ?? cfg.virtualIpv4,
      });
      const trust = loadCatalogTrust();
      const prev = new Map(this.catalogPeers.map((p) => [p.hostname, p]));
      // The injected clock keeps quote freshness testable without waiting.
      const nowDate = this.clock();
      const now = nowDate.toISOString();
      const previousViews: CatalogPeerView[] = [];
      const liveHosts = new Set<string>();
      const candidates: { entry: DirectoryPeer; view: CatalogPeerView }[] = [];

      const nowMs = nowDate.getTime();
      for (const entry of classified) {
        liveHosts.add(entry.hostname);
        const earlier = prev.get(entry.hostname);
        const connected = this.state.providers.find(
          (p) =>
            (entry.mappedCidr && mappedHost(p.mappedCidr) === mappedHost(entry.mappedCidr)) ||
            (entry.hostname && p.fingerprint?.hostname === entry.hostname),
        );
        const ageMs = earlier?.fetchedAt ? nowMs - Date.parse(earlier.fetchedAt) : Number.NaN;
        const quoteFresh = Boolean(earlier?.quote) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= CATALOG_QUOTE_TTL_MS;
        // A live EasyTier neighbour with no exported/mapped address has stopped
        // publishing its catalogue. That is a publication fact, independent of
        // whether the peer is still reachable on the overlay.
        const withdrawn = !entry.conflict && entry.route !== "self" && !entry.mappedCidr;
        // Warnings about identity or a replayed quote survive an unreadable
        // peer (that is the whole point of a warning), but only while a
        // catalogue is actually published; a withdrawal supersedes them.
        const sticky = !withdrawn && (earlier?.status === "identity-changed" || earlier?.status === "unverified" || earlier?.status === "stale");
        const view: CatalogPeerView = {
          ...entry,
          nodeId: earlier?.nodeId ?? null,
          status: entry.conflict
            ? "conflict"
            : entry.route === "self"
              ? "self"
              : withdrawn
                ? "no-catalog"
                : sticky
                  ? earlier!.status
                  : !earlier?.quote
                    ? "unreachable"
                    : !quoteFresh
                      ? "stale"
                      : connected && earlier.identity && catalogIdentityAccepted(earlier.nodeId, earlier.identity.fingerprint)
                        ? "connected"
                        : earlier.status === "connected" || earlier.status === "verified"
                          ? earlier.status
                          : "unreachable",
          detail: entry.conflict
            ?? (withdrawn
              ? "the peer is online but no longer publishes a catalogue address (share stopped or mapping withdrawn)"
              : sticky
                ? earlier!.detail
                : !earlier?.quote
                  ? null
                  : !quoteFresh
                    ? "the cached quote has expired; refresh the directory before requesting or connecting"
                    : null),
          catalogPort: earlier?.catalogPort ?? null,
          identity: earlier?.identity ?? null,
          pendingFingerprint: earlier?.pendingFingerprint ?? null,
          // A withdrawn catalog keeps its identity as last-known metadata but
          // never a quote that could still be requested or connected with.
          quote: withdrawn ? null : earlier?.quote ?? null,
          quoteHash: withdrawn ? null : earlier?.quoteHash ?? null,
          fetchedAt: withdrawn ? null : earlier?.fetchedAt ?? null,
          connectedProviderId: connected?.id ?? null,
          catalog: entry.conflict
            ? "conflict"
            : withdrawn
              ? (earlier?.quote || earlier?.lastQuoteAt ? "withdrawn" : "none")
              : earlier?.quote
                ? "published"
                : "unknown",
          quoteFresh: withdrawn ? false : quoteFresh,
          quoteExpiresAt:
            withdrawn || !earlier?.fetchedAt
              ? null
              : new Date(Date.parse(earlier.fetchedAt) + CATALOG_QUOTE_TTL_MS).toISOString(),
          lastQuoteAt: earlier?.fetchedAt ?? earlier?.lastQuoteAt ?? null,
          lastAttemptAt: earlier?.lastAttemptAt ?? null,
        };
        if (view.status !== "self" && view.status !== "conflict" && entry.mappedCidr) {
          candidates.push({ entry, view });
        }
        previousViews.push(view);
      }

      const fetched = await mapLimit(candidates, 4, ({ entry, view }) => this.fetchCatalogFor(entry, view, cfg, trust));
      const byHost = new Map<string, CatalogPeerView>();
      for (const v of previousViews) byHost.set(v.hostname, v);
      for (const v of fetched) byHost.set(v.hostname, v);

      // Offline: keep the last quote for an hour so the page can say who was
      // seen, but never keep probing a peer EasyTier no longer lists. The quote
      // is last-known display data only; it has expired for any application.
      for (const [host, old] of prev) {
        if (liveHosts.has(host)) continue;
        const seen = old.lastQuoteAt ?? old.fetchedAt ?? old.lastSeenAt;
        if (seen && nowMs - Date.parse(seen) > 60 * 60_000) continue;
        byHost.set(host, {
          ...old,
          online: false,
          status: "offline",
          detail: "not present in EasyTier's current peer list",
          lastSeenAt: old.lastSeenAt,
          catalog: "unknown",
          quoteFresh: false,
          quoteExpiresAt: null,
          lastQuoteAt: old.lastQuoteAt ?? old.fetchedAt ?? null,
          lastAttemptAt: old.lastAttemptAt ?? old.fetchedAt ?? null,
        });
      }

      this.catalogPeers = [...byHost.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
      this.catalogLastRefreshAt = now;
      this.catalogNextRefreshAt = nowMs + Math.max(10, cfg.catalog.refreshSec) * 1000;
      saveCatalogTrust(trust);
      this.writeSnapshot();
      return this.catalogPeers;
    } catch (e) {
      this.catalogError = String((e as Error).message ?? e);
      this.catalogNextRefreshAt = Date.now() + Math.max(10, cfg.catalog.refreshSec) * 1000;
      this.writeSnapshot();
      throw e;
    } finally {
      this.catalogRefreshing = false;
    }
  }

  private async fetchCatalogFor(
    entry: DirectoryPeer,
    base: CatalogPeerView,
    cfg: PluginConfig,
    trust: Record<string, CatalogTrustRecord>,
  ): Promise<CatalogPeerView> {
    const mapped = mappedHost(entry.mappedCidr!);
    const now = this.clock().toISOString();
    // The default port is 3426. A host that runs several isolated lab instances
    // (or an operator who changed the port) may publish on the next few; probe a
    // small bounded range only until one answers, then remember that port.
    // A remembered port is tried first, but it is not the only possibility: a
    // provider whose catalogue port was migrated must not become undiscoverable
    // forever. The fallback is the same bounded range as a first read.
    // The probe base is the product's fixed catalogue window, not this node's own
    // port. Two isolated instances on one LAN address must be able to allocate
    // different ports in the same window and still find each other; probing the
    // local port would make each node blind to the other's window.
    const candidates = catalogProbePorts(base.catalogPort, cfg.catalog.port);
    let lastDetail = "no catalogue answer";
    let lastPort = candidates[0];
    for (const port of candidates) {
      lastPort = port;
      let res: { status: number; body: string };
      try {
        res = await this.probes.catalogHttpGet({
          socksPort: cfg.catalog.socksPort,
          host: mapped,
          port,
          path: CATALOG_PATH,
          timeoutMs: 5000,
        });
      } catch (e) {
        lastDetail = `no catalogue answer through the overlay: ${(e as Error).message}`;
        continue;
      }
      if (res.status !== 200) {
        lastDetail = `the catalogue endpoint answered HTTP ${res.status} on port ${port}`;
        continue;
      }
      let verified;
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
        verified = verifySignedCatalog(parsed);
      } catch (e) {
        lastDetail = `invalid catalogue: ${(e as Error).message}`;
        continue;
      }
      const quote = verified.quote;
      if (quote.node.hostname !== entry.hostname || quote.node.virtualIpv4 !== entry.virtualIpv4) {
        lastDetail = `catalogue identifies ${quote.node.hostname}/${quote.node.virtualIpv4}, not ${entry.hostname}/${entry.virtualIpv4}`;
        continue;
      }
      if (!isValidOverlayHostname(entry.hostname, quote.node.id)) {
        lastDetail = `EasyTier hostname ${entry.hostname} does not belong to node id ${quote.node.id}`;
        continue;
      }
      if (mappedHost(quote.node.mappedCidr) !== mapped) {
        // Another peer (or this host) answered on this port; a catalogue must
        // name the address it was reached on. Keep looking, never accept it.
        lastDetail = `catalogue on port ${port} says ${quote.node.mappedCidr}, not ${mapped}`;
        continue;
      }
      if (quote.node.catalogPort !== port) {
        lastDetail = `catalogue says port ${quote.node.catalogPort} but was read on ${port}`;
        continue;
      }
      return this.finishCatalogPeer(entry, base, cfg, trust, quote, verified, parsed, port, now);
    }
    // A failed probe is not a fresh quote: `fetchedAt` keeps the time of the
    // last *successful* read, and the application window is derived from it.
    const expired = Boolean(base.quote) && !base.quoteFresh;
    return {
      ...base,
      // A failed refresh cannot erase a pending identity or replay warning.
      status: ["identity-changed", "unverified"].includes(base.status)
        ? base.status
        : expired || base.status === "stale"
          ? "stale"
          : base.connectedProviderId && base.identity && catalogIdentityAccepted(base.nodeId, base.identity.fingerprint) ? "connected" : "unreachable",
      detail: expired
        ? "the cached quote has expired and the peer did not answer; refresh the directory before requesting or connecting"
        : lastDetail.slice(0, 300),
      catalogPort: base.catalogPort ?? null,
      fetchedAt: base.fetchedAt,
      lastAttemptAt: now,
      catalog: base.catalog,
      quoteFresh: base.quoteFresh,
      quoteExpiresAt: base.quoteExpiresAt,
      lastQuoteAt: base.lastQuoteAt ?? base.fetchedAt ?? null,
    };
  }

  private finishCatalogPeer(
    entry: DirectoryPeer,
    base: CatalogPeerView,
    cfg: PluginConfig,
    trust: Record<string, CatalogTrustRecord>,
    quote: import("./catalog.ts").CatalogQuoteBody,
    verified: import("./catalog.ts").VerifiedCatalog,
    parsed: unknown,
    port: number,
    now: string,
  ): CatalogPeerView {
    const nodeId = quote.node.id;
    const fp = quote.identity.fingerprint;
    const known = Object.hasOwn(trust, nodeId) ? trust[nodeId] : undefined;
    // A cached quote from a different identity says nothing about this key's
    // version. After an explicit identity acceptance the new key may start at
    // v1 even though the old key reached v3.
    const baseSameIdentity = Boolean(base.quote && base.quote.identity.fingerprint === fp);
    const lastVersion = Math.max(known?.quoteVersion ?? 0, baseSameIdentity ? base.quote?.publication.version ?? 0 : 0);
    const lastHash = known?.quoteHash || (baseSameIdentity ? base.quoteHash : null) || null;
    // A changed key is an identity warning, not a version replay: do not let
    // the old key's version mask it. Neither path accepts the new quote.
    const keyChanged = Boolean(known && known.fingerprint !== fp);
    if (!keyChanged && quote.publication.version < lastVersion) {
      return {
        ...base,
        nodeId,
        status: "stale",
        detail: `catalogue offered v${quote.publication.version}, older than the last accepted v${lastVersion}; the newer cached quote was kept`,
        online: true,
        catalogPort: port,
        lastAttemptAt: now,
      };
    }
    if (!keyChanged && quote.publication.version === lastVersion && lastHash && verified.contentHash !== lastHash) {
      return {
        ...base,
        nodeId,
        status: "stale",
        detail: `catalogue reuses v${quote.publication.version} with different content (${verified.contentHash.slice(0, 12)}… vs ${lastHash.slice(0, 12)}…); refused`,
        online: true,
        catalogPort: port,
        lastAttemptAt: now,
      };
    }
    let rec = known;
    let status: CatalogPeerView["status"] = "unverified";
    let detail: string | null = null;
    if (!rec) {
      rec = {
        nodeId,
        overlayHostname: entry.hostname,
        publicKey: quote.identity.publicKey,
        fingerprint: fp,
        keyId: quote.identity.keyId,
        firstSeenAt: now,
        lastSeenAt: now,
        quoteVersion: quote.publication.version,
        quoteHash: verified.contentHash,
        accepted: false,
        pending: null,
      };
      trust[nodeId] = rec;
      status = "unverified";
      detail = "first seen: self-signed key (TOFU), not a real-world identity";
    } else if (rec.pending && rec.pending.fingerprint === fp) {
      status = "identity-changed";
      detail = `a different key (${fp}) is still awaiting local acceptance; the previously trusted key is ${rec.fingerprint}`;
    } else if (rec.pending && rec.fingerprint !== fp) {
      // The key changed again while the previous change was pending. Keep the
      // newest pending key; the operator must still accept it explicitly.
      rec.pending = { publicKey: quote.identity.publicKey, fingerprint: fp, keyId: quote.identity.keyId, hostname: entry.hostname, seenAt: now };
      status = "identity-changed";
      detail = `the catalogue key changed to ${fp}; not accepted automatically`;
    } else if (rec.fingerprint !== fp) {
      rec.pending = { publicKey: quote.identity.publicKey, fingerprint: fp, keyId: quote.identity.keyId, hostname: entry.hostname, seenAt: now };
      status = "identity-changed";
      detail = `the catalogue key changed from ${rec.fingerprint} to ${fp}; not accepted automatically`;
    } else {
      // The key is the one first seen (or the one an operator accepted). It is
      // still self-signed: "verified" means "the same key as before", never a
      // real-world identity.
      rec.pending = null;
      rec.overlayHostname = entry.hostname;
      rec.quoteVersion = quote.publication.version;
      rec.quoteHash = verified.contentHash;
      status = rec.accepted ? "verified" : "unverified";
      detail = rec.accepted
        ? "the same Ed25519 key as the one accepted locally"
        : "same key as first seen; accept it locally with catalog trust to stop showing unverified";
    }
    if (rec.pending && status !== "identity-changed") status = "identity-changed";
    rec.lastSeenAt = now;
    if (base.connectedProviderId && status === "verified" && rec.accepted) status = "connected";
    return {
      ...base,
      nodeId,
      status,
      detail,
      online: true,
      catalogPort: port,
      identity: {
        fingerprint: rec.fingerprint,
        keyId: rec.keyId,
        publicKey: rec.publicKey,
        firstSeenAt: rec.firstSeenAt,
      },
      pendingFingerprint: rec.pending?.fingerprint ?? null,
      quote: parsed as SignedCatalog,
      quoteHash: verified.contentHash,
      fetchedAt: now,
      catalog: "published",
      quoteFresh: true,
      quoteExpiresAt: new Date(Date.parse(now) + CATALOG_QUOTE_TTL_MS).toISOString(),
      lastQuoteAt: now,
      lastAttemptAt: now,
    };
  }

  // --- remote providers ------------------------------------------------------

  /**
   * Adds (or re-adds) one remote provider. The validation and rollback of the
   * phase-3 `connectProvider` are kept: the overlay path is proven with the key
   * before Magpie is touched, the remote is registered only after that, and a
   * failure removes exactly what this call added.
   */
  async addProvider(input: ProviderInput): Promise<ProviderView> {
    return this.serialize(() => this.connectProvider(input, { update: false }));
  }

  async updateProvider(id: string, patch: Partial<Omit<ProviderInput, "id">>): Promise<ProviderView> {
    return this.serialize(async () => {
      const existing = this.provider(id);
      if (!existing) throw new Error(`no remote provider ${id}`);
      const key = patch.key ?? getProviderKey(id);
      if (!key) throw new Error(`provider ${id} has no stored Gateway Key; pass --key`);
      return this.connectProvider(
        {
          id,
          mappedCidr: patch.mappedCidr ?? existing.mappedCidr,
          key,
          providerPort: patch.providerPort ?? existing.providerPort,
          // Deliberately not defaulting to existing.localPort: if the target
          // changes, connectProvider must pick a fresh port and prove it first.
          localPort: patch.localPort,
        },
        { update: true },
      );
    });
  }

  private async connectProvider(
    input: ProviderInput,
    opts: { update: boolean; beforeRegister?: () => void; expectedModels?: string[]; acceptedFingerprint?: string },
  ): Promise<ProviderView> {
    const cfg = this.state.config;
    if (!cfg) throw new Error("configure this node as a provider or consumer first");
    if (!cfg.consumingEnabled) {
      throw new Error("consumption is disabled on this node; enable it before adding a remote provider");
    }
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(input.id)) throw new Error("provider id must be 2-31 characters of a-z0-9-");
    const mappedCidr = input.mappedCidr.trim();
    if (!/^10\.66\.\d{1,3}\.\d{1,3}\/32$/.test(mappedCidr)) throw new Error("mappedCidr must look like 10.66.a.b/32");
    if (!/^sk-[A-Za-z0-9._-]{8,}$/.test(input.key)) throw new Error("that is not a gateway key");
    registerSecret(input.key);

    const providerPort = input.providerPort ?? 3425;
    if (!Number.isInteger(providerPort) || providerPort < 1 || providerPort > 65535) {
      throw new Error("providerPort must be a TCP port");
    }

    const existing = this.provider(input.id);
    if (opts.update && !existing) throw new Error(`no remote provider ${input.id}`);
    if (!opts.update && existing && existing.status !== "disabled") {
      // Re-adding is idempotent: it re-verifies the same connection.
      logger.info(`provider ${input.id} is already configured; re-verifying it`);
    }
    const clash = this.state.providers.find((p) => p.id !== input.id && mappedHost(p.mappedCidr) === mappedHost(mappedCidr));
    if (clash) throw new Error(`${mappedCidr} is already used by provider ${clash.id}; each provider needs its own mapped_cidr`);

    const want = mappedHost(mappedCidr);
    const dst = `${want}:${providerPort}`;
    const targetChanged =
      Boolean(existing) && (`${mappedHost(existing!.mappedCidr)}:${existing!.providerPort}` !== dst);

    // EasyTier 2.6.4 cannot retarget a live forward, so a changed destination
    // gets a fresh loopback port and is proven before the old one is retired.
    let localPort: number;
    if (input.localPort !== undefined) {
      if (targetChanged && input.localPort === existing!.localPort) {
        throw new Error(
          "EasyTier 2.6.4 cannot point an existing loopback forward at a new target; " +
            "omit localPort and the plugin will switch to a fresh port safely",
        );
      }
      localPort = input.localPort;
    } else if (existing && !targetChanged) {
      // A repeated add with the same target is idempotent: keep the port (and
      // therefore the listener) instead of moving the connection for no reason.
      localPort = existing.localPort;
    } else {
      localPort = await this.allocLocalPort();
    }
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("localPort must be a TCP port");
    if (this.state.providers.some((p) => p.id !== input.id && p.localPort === localPort)) {
      throw new Error(`127.0.0.1:${localPort} is already the forward port of another provider`);
    }
    const bind = `127.0.0.1:${localPort}`;

    // Ownership check: the plugin may only replace a Magpie entry it can prove
    // it wrote. A same-named native provider, a foreign Remote Magpie, or an
    // entry the user edited by hand is never removed or overwritten.
    const prevKey = existing ? getProviderKey(existing.id) : null;
    const entryOwnership: Ownership = existing && prevKey
      ? this.ownershipOf(input.id, existing.localPort, prevKey)
      : this.deps.magpie.providerById(input.id)
        ? "foreign"
        : "absent";
    if (entryOwnership === "foreign") {
      throw new Error(
        `a provider named "${input.id}" already exists in Magpie and is not owned by this plugin ` +
          `(or was changed outside it); refusing to remove or overwrite it. Remove it in Magpie first, ` +
          `or use a different id`,
      );
    }

    // 0. Who actually owns that mapped prefix? A mapped address can move, be
    //    spoofed or be announced by two peers; it is a routing selector, not an
    //    identity. The owner's overlay name is recorded so a later change is
    //    visible, and this node's own name is refused outright (a loop).
    const owner = await this.routeOwner(want).catch((e) => {
      // Two peers announcing the same prefix is ambiguous, not "no route": the
      // dial would land on either of them, so refuse instead of guessing.
      if (/announces .* from/.test(String((e as Error).message))) throw e;
      return null;
    });
    if (owner && configHostname(cfg) && owner.hostname === configHostname(cfg)) {
      throw new Error(`that mapped address is this node itself (${owner.hostname}); refusing to connect to myself`);
    }

    const prev = existing ? { ...existing } : null;
    this.connectionsBusy.add(input.id);
    let addedForward = false;
    let registered: "unchanged" | "added" | "replaced" | null = null;
    try {
      // 1. the overlay path first; nothing in Magpie changes yet. A freshly
      //    announced prefix can take a moment to accept forwarded connections,
      //    so the probe is retried for a few seconds before giving up.
      addedForward = await this.supervisor.addPortForward(bind, dst);
      // No Gateway Key touches the wire before the OS attributes this loopback
      // listener to the supervised core.
      const forwardProof = await this.proveForwardOwner(input.id, localPort);
      if (forwardProof.state !== "stable") {
        throw new Error(
          `127.0.0.1:${localPort} is not provably owned by the supervised core ` +
            `(${forwardProof.state}: ${forwardProof.detail ?? "no evidence"}); refusing to send the Gateway Key`,
        );
      }
      if (!(await this.waitForStatus("127.0.0.1", localPort, 401))) {
        throw new Error(
          `127.0.0.1:${localPort} did not answer 401 without a key: ` +
            `the provider must be online, on the same network, and its mapped address reachable`,
        );
      }
      // A keyless 401 could also come from something that refuses everything.
      // A wrong key must also be refused, which proves a Gateway Key is actually
      // checked at the other end rather than a local, trusted caller.
      const wrong = `sk-ohmyaihub-probe-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      if (!(await this.waitForStatus("127.0.0.1", localPort, 401, wrong))) {
        throw new Error(`127.0.0.1:${localPort} did not refuse a wrong key; refusing to trust this endpoint`);
      }

      // Authorization files promise an exact model scope. Read it with the
      // delivered key before registering anything in native Magpie.
      const remoteModels = await this.probes.remoteModelIds(localPort, input.key, 15_000);
      if (!remoteModels || remoteModels.length === 0) {
        if (opts.expectedModels) throw new RequestValidationError("the provider served no model for the authorization key; ask for a matching authorization");
        throw new Error("the provider served no model for that key; is the key allowed a model?");
      }
      if (opts.expectedModels && !sameSet(remoteModels, opts.expectedModels)) {
        throw new RequestValidationError("the key's actual model scope differs from the authorization file; ask the provider for a matching authorization");
      }

      // 2. the provider. An entry this plugin owns is replaced; a missing one is
      //    added; anything else was refused above. Re-registering an identical
      //    binding is a no-op.
      opts.beforeRegister?.();
      const targetOurs = this.ownershipOf(input.id, localPort, input.key) === "ours";
      if (targetOurs) {
        registered = "unchanged";
      } else if (entryOwnership === "absent") {
        await this.deps.magpie.addRemoteProvider({ id: input.id, url: `http://127.0.0.1:${localPort}`, key: input.key });
        registered = "added";
      } else {
        await this.deps.magpie.replaceRemoteProvider({ id: input.id, url: `http://127.0.0.1:${localPort}`, key: input.key });
        registered = "replaced";
      }

      // 3. the consumer must see the validated remote through native Magpie.
      if (!(await this.waitLocalModels(input.id, 15_000))) {
        throw new Error(`magpie did not list any ${input.id}/ model within 15s`);
      }

      // 4. only now commit the connection record
      const now = new Date().toISOString();
      const limit = limitView(await this.probes.remoteLimit(localPort, input.key, 8000));
      const previousKey = prev ? getProviderKey(prev.id) : null;
      const keyGeneration = (prev?.keyGeneration ?? 1) + (previousKey && previousKey !== input.key ? 1 : 0);
      const identity = {
        hostname: owner?.hostname ?? prev?.fingerprint?.hostname ?? null,
        virtualIpv4: owner?.ipv4 ?? prev?.fingerprint?.virtualIpv4 ?? null,
        fingerprint: opts.acceptedFingerprint ?? prev?.acceptedFingerprint ?? null,
      };
      const rec: ProviderConnection = {
        id: input.id,
        remoteMagpieId: input.id,
        mappedCidr,
        providerPort,
        localPort,
        keyRef: providerKeyRef(input.id),
        fingerprint: owner ? { hostname: owner.hostname, virtualIpv4: owner.ipv4, peerId: owner.peerId } : null,
        models: [...(opts.expectedModels ?? remoteModels)],
        keyGeneration,
        acceptedFingerprint: identity.fingerprint,
        modelsEvidence: {
          status: "current",
          source: "connect-readback",
          readAt: this.clock().toISOString(),
          expiresAt: new Date(this.clock().getTime() + MODELS_EVIDENCE_TTL_MS).toISOString(),
          models: [...remoteModels],
          modelCount: remoteModels.length,
          callable: "yes",
          identity,
          generation: (prev?.modelsEvidence?.generation ?? 0) + 1,
          keyRef: providerKeyRef(input.id),
          keyGeneration,
          error: null,
        },
        status: "connected",
        detail: null,
        limit,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        lastConnectedAt: now,
      };
      setProviderKey(input.id, input.key);
      const idx = this.state.providers.findIndex((p) => p.id === input.id);
      if (idx >= 0) this.state.providers[idx] = rec;
      else this.state.providers.push(rec);
      saveState(this.state);
      this.supervisor.setForwards(this.allForwardSpecs());
      if (prev && prev.localPort !== localPort) {
        // The old listener cannot be closed live in 2.6.4. Restart from the new
        // config now, so no unregistered forward is left behind, and re-verify
        // the other providers afterwards.
        const current = this.state.config;
        if (current) await this.applyConfig(current);
        await this.reconcileProviders({ quiet: true }).catch((e) => logger.warn(`reconcile after retarget: ${String(e)}`));
      }
      await this.guardSharedKeys().catch((e) => logger.warn(`share guard: ${String(e)}`));
      logger.info(`connected provider ${input.id} at ${bind} -> ${dst} (${registered})`);
      return providerView(rec);
    } catch (e) {
      // Roll back exactly what this call changed. The previous registration of
      // the same id is restored with its key; other providers are untouched.
      if (registered === "added" || registered === "replaced") {
        // Only undo an entry that still matches what this call wrote; a user
        // edit in the meantime is theirs and is left alone.
        if (this.ownershipOf(input.id, localPort, input.key) === "ours") {
          await this.deps.magpie.removeProvider(input.id).catch(() => {});
        } else {
          logger.error(`not removing "${input.id}": its Magpie entry no longer matches what this call wrote`);
        }
        if (prev && prevKey) await this.restoreRemoteProvider(prev, prevKey);
      }
      if (!this.state.providers.some((p) => p.localPort === localPort)) {
        // The listener could not be proven (or the forward could not be added),
        // so record a real failure: the next attempt must not reuse this port.
        await this.recordPortProof({
          purpose: "forward",
          host: "127.0.0.1",
          port: localPort,
          owner: "easytier",
          reported: false,
          expectedPids: this.supervisor.snapshot().pid ? [this.supervisor.snapshot().pid!] : [],
          detail: `forward to ${input.id} failed: ${(e as Error).message}`.slice(0, 300),
        }).catch(() => {});
      }
      if (addedForward && !this.state.providers.some((p) => p.localPort === localPort)) {
        await this.recordOrphanForward(localPort, dst);
      }
      if (e instanceof RequestValidationError) throw e;
      throw new Error(
        `connect failed: ${(e as Error).message}` +
          (this.state.providers.some((p) => p.id !== input.id) ? " (the other providers were kept)" : ""),
      );
    } finally {
      this.connectionsBusy.delete(input.id);
    }
  }

  /**
   * Removes one remote provider: its Remote Magpie registration, its stored key
   * and its loopback forward. The other providers are re-verified afterwards;
   * only this one can be affected.
   */
  async removeProvider(id: string): Promise<ProviderView> {
    return this.serialize(async () => {
      const rec = this.provider(id);
      if (!rec) throw new Error(`no remote provider ${id}`);
      const ownership = this.ownershipOf(id, rec.localPort, getProviderKey(id));
      const leftInMagpie = ownership === "foreign";
      if (ownership === "ours") {
        await this.deps.magpie.removeProvider(id);
      } else if (leftInMagpie) {
        logger.warn(
          `not deleting the Magpie provider "${id}": it was changed outside the plugin or is not owned by it; ` +
            `removing only this plugin's connection`,
        );
      }
      deleteProviderKey(id);
      this.state.providers = this.state.providers.filter((p) => p.id !== id);
      // Evidence for a retired forward port must not look green if the range
      // hands the same number to a future provider.
      this.state.ports = {
        ...this.portLedger(),
        evidence: this.portLedger().evidence.filter((e) => !(e.purpose === "forward" && e.port === rec.localPort)),
      };
      saveState(this.state);
      // 2.6.4 cannot close a forward at runtime: restart with the new config so
      // no listener is left pointing at a provider that is no longer used.
      const cfg = this.state.config;
      if (cfg) await this.applyConfig(cfg);
      await this.reconcileProviders({ quiet: true }).catch((e) => logger.warn(`reconcile after removal: ${String(e)}`));
      logger.info(`removed remote provider ${id}; its loopback port ${rec.localPort} is gone`);
      return providerView({
        ...rec,
        status: "disabled",
        detail: leftInMagpie ? "removed from the plugin; the Magpie entry was left untouched (not owned by this plugin)" : "removed",
      });
    });
  }

  /** Legacy phase-3 name: disconnect means "remove the first provider". */
  async disconnectProvider(): Promise<StatusSnapshot> {
    const first = this.state.providers[0];
    if (first) await this.removeProvider(first.id);
    return this.status();
  }

  /** Combo with provider models evidence: never leave a pre-migration read-back "current". */
  private invalidateMigrationEvidence(conn: ProviderConnection, reason: string): void {
    const e = (conn as unknown as { modelsEvidence?: Record<string, unknown> | null }).modelsEvidence;
    if (!e) return;
    e.status = "stale";
    e.modelCount = null;
    e.callable = "unknown";
    e.error = reason.slice(0, 300);
  }

  private refreshMigrationEvidence(conn: ProviderConnection, models: string[]): void {
    const e = (conn as unknown as { modelsEvidence?: Record<string, unknown> | null }).modelsEvidence;
    if (!e) return;
    const at = new Date().toISOString();
    e.status = "current";
    e.source = "reconcile";
    e.readAt = at;
    e.expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    e.models = [...models];
    e.modelCount = models.length;
    e.callable = "yes";
    e.generation = (Number(e.generation) || 0) + 1;
    e.keyGeneration = (conn as unknown as { keyGeneration?: number }).keyGeneration ?? e.keyGeneration;
    e.error = null;
  }

  /**
   * Existing, plugin-owned Remote: its loopback forward became foreign/dead.
   *
   * One bounded attempt per call (plus a backoff) that: allocates Q, rewrites
   * the forward config and restarts the core, proves Q belongs to the core
   * BEFORE any Gateway Key is sent, re-reads models/limit with the same key,
   * and only then re-registers the native Remote at Q. A `foreign` entry is
   * never edited; the key, identity and ledger are never rotated or reset. If
   * the old port cannot be proven, its registration is removed instead of being
   * restored to somebody else's socket.
   */
  private async migrateProviderForward(conn: ProviderConnection, key: string, reason: string): Promise<boolean> {
    const cfg = this.state.config;
    if (!cfg) return true;
    if (this.forwardMigrationBusy || this.mutating > 0) {
      conn.status = "degraded";
      conn.detail = `forward recovery is waiting for another core operation: ${reason}`.slice(0, 300);
      conn.updatedAt = new Date().toISOString();
      return true;
    }
    const now = Date.now();
    const until = this.forwardRecoveryBackoff.get(conn.id) ?? 0;
    if (now < until) {
      conn.status = "degraded";
      conn.detail = `forward recovery is backing off after a failed attempt: ${reason}`.slice(0, 300);
      conn.updatedAt = new Date().toISOString();
      return true;
    }
    const magpiePort = this.ownedLoopbackPort(conn.id, key);
    if (magpiePort === "foreign") {
      conn.status = "degraded";
      conn.detail = "forward recovery refused: the Magpie entry is not owned by this plugin";
      conn.updatedAt = new Date().toISOString();
      return true;
    }
    this.forwardMigrationBusy = true;
    const fromPort = conn.localPort;
    let nextPort: number;
    try {
      nextPort = await this.allocLocalPort();
    } catch (e) {
      this.forwardMigrationBusy = false;
      this.forwardRecoveryBackoff.set(conn.id, now + 60_000);
      conn.status = "degraded";
      conn.detail = `forward recovery could not allocate a loopback port: ${(e as Error).message}`.slice(0, 300);
      conn.updatedAt = new Date().toISOString();
      return true;
    }
    // Persist the intent before the native registration or the core changes.
    // A crash at any later boundary can then converge from state.
    conn.forwardPending = { from: fromPort, to: nextPort, at: new Date().toISOString() };
    this.invalidateMigrationEvidence(conn, `forward migration ${fromPort} -> ${nextPort} in progress`);
    saveState(this.state);
    // Never let Magpie keep routing consumers with the stored key to the old
    // port while that listener is gone/foreign. Remove our own entry first; a
    // failure here aborts before the core restart.
    if (magpiePort !== null) {
      // Magpie stores the Gateway Key. Retargeting that entry to another local
      // port would just make Magpie hand the key to whoever listens there, so
      // the only safe transition is a verified remove: no entry, no key route.
      let removalError: string | null = null;
      try {
        await this.deps.magpie.removeProvider(conn.id);
      } catch (e) {
        removalError = (e as Error).message;
      }
      if (this.deps.magpie.providerById(conn.id)) {
        conn.status = "degraded";
        conn.detail = (
          `forward recovery aborted: the old Magpie registration could not be removed` +
          `${removalError ? ` (${removalError})` : " (still present after remove)"}; ` +
          `the core was not restarted and the entry was not retargeted. Remove it in Magpie before retrying`
        ).slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        this.forwardMigrationBusy = false;
        this.forwardRecoveryBackoff.set(conn.id, Date.now() + 120_000);
        saveState(this.state);
        return true;
      }
    }
    conn.localPort = nextPort;
    let magpieChanged = false;
    try {
      this.supervisor.setForwards(this.allForwardSpecs());
      await this.applyConfig(cfg);
      const proof = await this.proveForwardOwner(conn.id, nextPort);
      if (proof.state !== "stable") {
        throw new Error(`127.0.0.1:${nextPort} is not owned by the core (${proof.state}: ${proof.detail ?? "no evidence"})`);
      }
      // No Gateway Key before the proof above; the two unkeyed probes only.
      if (!(await this.waitForStatus("127.0.0.1", nextPort, 401))) {
        throw new Error(`127.0.0.1:${nextPort} did not answer 401 without a key`);
      }
      const wrong = `sk-ohmyaihub-probe-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      if (!(await this.waitForStatus("127.0.0.1", nextPort, 401, wrong))) {
        throw new Error(`127.0.0.1:${nextPort} did not refuse a wrong key`);
      }
      const models = await this.probes.remoteModelIds(nextPort, key, 15_000);
      if (!models || models.length === 0) throw new Error("the provider served no model for the stored key");
      if (conn.models.length > 0 && !sameSet(models, conn.models)) {
        throw new Error("the provider's model scope changed; refusing to rewrite the connection silently");
      }
      const limit = limitView(await this.probes.remoteLimit(nextPort, key, 8000));
      await this.deps.magpie.addRemoteProvider({ id: conn.id, url: `http://127.0.0.1:${nextPort}`, key });
      magpieChanged = true;
      if (!(await this.waitLocalModels(conn.id, 15_000))) {
        throw new Error(`Magpie did not list any ${conn.id}/ model after re-registration`);
      }
      const at = new Date().toISOString();
      conn.models = [...models];
      conn.limit = limit;
      conn.forwardPending = null;
      this.refreshMigrationEvidence(conn, models);
      conn.status = "connected";
      conn.detail = `forward recovered ${fromPort} -> ${nextPort}: ${reason}`.slice(0, 300);
      conn.updatedAt = at;
      conn.lastConnectedAt = at;
      this.persistLedger(
        recordPortMigration(this.portLedger(), {
          at,
          purpose: "forward",
          from: fromPort,
          to: nextPort,
          reason: `provider ${conn.id}: ${reason}`.slice(0, 300),
        }),
      );
      this.state.ports = {
        ...this.portLedger(),
        evidence: this.portLedger().evidence.filter((e) => !(e.purpose === "forward" && e.port === fromPort)),
      };
      this.forwardRecoveryBackoff.delete(conn.id);
      saveState(this.state);
      logger.warn(`provider ${conn.id}: ${conn.detail}`);
      return true;
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      if (magpieChanged) {
        // The registration already points at the proven next port: commit it so
        // state and Magpie agree, but show the verification failure honestly.
        conn.localPort = nextPort;
        conn.forwardPending = null;
        this.invalidateMigrationEvidence(conn, `forward moved to ${nextPort} but verification failed: ${why}`);
        conn.status = "degraded";
        conn.detail = `forward moved to ${nextPort} and was re-registered, but verification failed: ${why}`.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        this.persistLedger(
          recordPortMigration(this.portLedger(), {
            at: conn.updatedAt,
            purpose: "forward",
            from: fromPort,
            to: nextPort,
            reason: `provider ${conn.id}: ${why}`.slice(0, 300),
          }),
        );
        this.forwardRecoveryBackoff.set(conn.id, Date.now() + 120_000);
        saveState(this.state);
        logger.error(`provider ${conn.id}: ${conn.detail}`);
        return true;
      }

      // Magpie was not touched. Put the old port back and prove it; a port that
      // is no longer ours must not keep a registration (Magpie would send the
      // stored key to whoever holds it).
      conn.localPort = fromPort;
      conn.forwardPending = null;
      let restored = false;
      try {
        this.supervisor.setForwards(this.allForwardSpecs());
        await this.applyConfig(cfg);
        restored = true;
      } catch (restoreError) {
        logger.error(`provider ${conn.id}: restoring the old forward failed: ${String(restoreError)}`);
        await this.supervisor.stop().catch(() => {});
      }
      const oldProof = restored ? await this.proveForwardOwner(conn.id, fromPort) : null;
      this.invalidateMigrationEvidence(conn, `forward recovery failed: ${why}`);
      if (!oldProof || oldProof.state !== "stable") {
        conn.status = "degraded";
        conn.detail =
          `forward recovery failed (${why}); the old port ${fromPort} is not provably owned, ` +
          `so its registration was removed instead of restored`;
      } else {
        try {
          await this.deps.magpie.addRemoteProvider({ id: conn.id, url: `http://127.0.0.1:${fromPort}`, key });
          conn.status = "degraded";
          conn.detail = `forward recovery failed (${why}); the old forward ${fromPort} was restored after proving its owner`.slice(0, 300);
        } catch (restoreRegistration) {
          conn.status = "degraded";
          conn.detail =
            `forward recovery failed (${why}); the old forward ${fromPort} is owned but re-registering it failed: ` +
            `${(restoreRegistration as Error).message}`.slice(0, 300);
        }
      }
      conn.updatedAt = new Date().toISOString();
      // The failed candidate must never be chosen again by allocLocalPort().
      this.persistLedger(
        recordPortEvidence(this.portLedger(), {
          purpose: "forward",
          port: nextPort,
          host: "127.0.0.1",
          owner: "easytier",
          state: "failed",
          verifiedAt: conn.updatedAt,
          detail: `forward recovery failed: ${why}`.slice(0, 300),
        }),
      );
      this.forwardRecoveryBackoff.set(conn.id, Date.now() + 120_000);
      saveState(this.state);
      logger.error(`provider ${conn.id}: ${conn.detail}`);
      return true;
    } finally {
      this.forwardMigrationBusy = false;
    }
  }

  /**
   * Re-checks every remote provider independently. A provider that is down or
   * changed does not disturb the others: each one gets its own status, and the
   * loop below never lets one failure escape.
   */
  async reconcileProviders(opts: { quiet?: boolean; verifyModels?: boolean; only?: string } = {}): Promise<ProviderView[]> {
    if (!opts.only) this.lastReconcileAt = Date.now();
    const cfg = this.state.config;
    if (!cfg) return [];
    if (opts.only && !this.provider(opts.only)) throw new Error(`no remote provider ${opts.only}`);
    if (!cfg.consumingEnabled) {
      if (opts.only) throw new Error("consumption is disabled on this node; enable it before testing a provider");
      for (const p of this.state.providers) {
        if (p.status !== "disabled") {
          p.status = "disabled";
          p.detail = "consumption is disabled";
          p.updatedAt = new Date().toISOString();
        }
      }
      saveState(this.state);
      return this.providers();
    }

    const forwards = await this.supervisor.listPortForwards().catch(() => null);
    if (this.state.orphanForwards.length) {
      // An orphan is gone once the runtime no longer listens on its port. A port
      // that a provider uses again is not an orphan any more either.
      const before = this.state.orphanForwards.length;
      this.state.orphanForwards = this.state.orphanForwards.filter((o) => {
        if (this.state.providers.some((p) => p.localPort === o.localPort)) return false;
        if (!forwards) return true;
        return forwards.some((f) => f.bindAddr === `127.0.0.1:${o.localPort}`);
      });
      if (this.state.orphanForwards.length !== before) saveState(this.state);
    }
    let changed = false;
    for (const conn of [...this.state.providers]) {
      if (opts.only && conn.id !== opts.only) continue;
      if (this.connectionsBusy.has(conn.id)) continue;
      this.connectionsBusy.add(conn.id);
      try {
        changed = (await this.reconcileOne(conn, forwards, opts)) || changed;
      } catch (e) {
        conn.status = "degraded";
        conn.detail = (e as Error).message.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        changed = true;
      } finally {
        this.connectionsBusy.delete(conn.id);
      }
    }
    if (changed) saveState(this.state);
    // A reconcile is also a full safety re-check (provider list and the keys
    // Magpie actually holds), so a manual `/providers/reconcile` catches an
    // external change even when the 15 s tick has not run yet.
    if (cfg.sharingEnabled && !opts.only) {
      this.lastProviderFingerprint = this.providerFingerprint();
      await this.guardSharedKeys().catch((e) => logger.warn(`share guard after a provider change failed: ${String(e)}`));
    }
    if (!opts.quiet) await this.writeSnapshot();
    return this.providers();
  }

  private async reconcileOne(
    conn: ProviderConnection,
    forwards: PortForward[] | null,
    opts: { verifyModels?: boolean },
  ): Promise<boolean> {
    let changed = false;
    const key = getProviderKey(conn.id);
    if (!key) {
      conn.status = "degraded";
      conn.detail = "the Gateway Key for this provider is missing from the key store; update the provider";
      return true;
    }

    // The mapped prefix must still be owned by the same overlay peer. This is a
    // routing check, not a cryptographic one: 2.6.4 does not expose a peer's
    // public key through its CLI (see docs/ARCHITECTURE.md), so the overlay
    // name and address are recorded and compared, and the Gateway Key is what
    // actually guards the traffic.
    const owner = await this.routeOwner(mappedHost(conn.mappedCidr)).catch((e) => {
      if (/announces .* from/.test(String((e as Error).message))) {
        conn.status = "identity-mismatch";
        conn.detail = (e as Error).message.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
      }
      return null;
    });
    if (conn.status === "identity-mismatch" && conn.detail?.includes("announces")) {
      if (this.ownershipOf(conn.id, conn.localPort, key) === "ours") {
        await this.deps.magpie.removeProvider(conn.id).catch(() => {});
      }
      logger.error(`provider ${conn.id}: ${conn.detail}; unregistered while the prefix is ambiguous`);
      return true;
    }
    if (owner && !conn.fingerprint) {
      // The route table was not ready at connect time: remember who owns it now,
      // so a later takeover is still visible.
      conn.fingerprint = { hostname: owner.hostname, virtualIpv4: owner.ipv4, peerId: owner.peerId };
      changed = true;
    }
    if (owner && conn.fingerprint && owner.hostname && owner.hostname !== conn.fingerprint.hostname) {
      if (conn.status !== "identity-mismatch") {
        conn.status = "identity-mismatch";
        conn.detail = `${mappedHost(conn.mappedCidr)} is now announced by ${owner.hostname}, not ${conn.fingerprint.hostname}`;
        conn.updatedAt = new Date().toISOString();
        changed = true;
      }
      // Stop routing to it: the registration is what gives Magpie the path.
      if (this.ownershipOf(conn.id, conn.localPort, key) === "ours") {
        await this.deps.magpie.removeProvider(conn.id).catch(() => {});
      }
      logger.error(`provider ${conn.id}: ${conn.detail}; unregistered until its identity is back`);
      return changed;
    }

    const cfg = this.state.config;
    if (!cfg) return changed;
    const owned = this.ownedLoopbackPort(conn.id, key);
    if (owned === "foreign") {
      // Something else now holds this id. It is not ours to edit, and routing
      // through it with our key would be wrong: report it and stop.
      conn.status = "degraded";
      conn.detail =
        `the Magpie provider "${conn.id}" was replaced or changed outside this plugin; ` +
        `leaving it untouched. Remove it in Magpie or use a different id`;
      conn.updatedAt = new Date().toISOString();
      logger.error(`provider ${conn.id}: ${conn.detail}`);
      return true;
    }

    const bind = `127.0.0.1:${conn.localPort}`;
    const dst = `${mappedHost(conn.mappedCidr)}:${conn.providerPort}`;
    if (forwards && !forwards.some((f) => f.bindAddr === bind && f.dstAddr === dst)) {
      try {
        await this.supervisor.addPortForward(bind, dst);
        this.supervisor.setForwards(this.allForwardSpecs());
      } catch (e) {
        // A port that cannot be restored may be occupied by somebody else; a
        // recovery is one bounded restart, not an endless "degraded" label.
        return await this.migrateProviderForward(conn, key, `cannot restore the loopback forward: ${(e as Error).message}`);
      }
    }

    let forwardOwner = await this.proveForwardOwner(conn.id, conn.localPort);
    if (forwardOwner.state !== "stable" && owned !== null && owned !== conn.localPort) {
      // Crash between the Magpie registration and the state commit (either
      // order): our own entry names another loopback port. If that port is
      // provably ours, adopt it instead of migrating again.
      const stored = await this.proveForwardOwner(conn.id, owned);
      if (stored.state === "stable") {
        const adoptedFrom = conn.localPort;
        conn.localPort = owned;
        try {
          this.supervisor.setForwards(this.allForwardSpecs());
          await this.applyConfig(cfg);
        } catch (e) {
          logger.warn(`provider ${conn.id}: could not apply the adopted forward port: ${String(e)}`);
        }
        const after = await this.proveForwardOwner(conn.id, owned);
        if (after.state === "stable") {
          this.persistLedger(
            recordPortMigration(this.portLedger(), {
              at: new Date().toISOString(),
              purpose: "forward",
              from: adoptedFrom,
              to: owned,
              reason: `provider ${conn.id}: adopted the already-registered loopback port after a restart`,
            }),
          );
          conn.forwardPending = null;
          this.invalidateMigrationEvidence(conn, `adopted loopback port ${owned} after a restart; re-reading the key scope`);
          conn.status = "degraded";
          conn.detail = `adopted the registered loopback port ${owned} after a restart; re-reading the key scope`;
          conn.updatedAt = new Date().toISOString();
          changed = true;
          forwardOwner = after;
          saveState(this.state);
        } else {
          conn.localPort = adoptedFrom;
        }
      }
    }
    if (forwardOwner.state === "stable" && conn.forwardPending) {
      // The crash happened before the core was restarted: the old forward is
      // still valid, so no migration is needed.
      conn.forwardPending = null;
      changed = true;
      saveState(this.state);
    }
    if (forwardOwner.state !== "stable") {
      return await this.migrateProviderForward(
        conn,
        key,
        `loopback ${conn.localPort} is not owned by the core (${forwardOwner.state}: ${forwardOwner.detail ?? "no evidence"})`,
      );
    }

    // Registration only after the owner proof; replace only our own entry.
    if (owned === null) {
      try {
        await this.deps.magpie.addRemoteProvider({ id: conn.id, url: `http://127.0.0.1:${conn.localPort}`, key });
        changed = true;
      } catch (e) {
        conn.status = "degraded";
        conn.detail = `cannot register the Remote Magpie: ${(e as Error).message}`.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        return true;
      }
    } else if (owned !== conn.localPort) {
      try {
        await this.deps.magpie.replaceRemoteProvider({ id: conn.id, url: `http://127.0.0.1:${conn.localPort}`, key });
        changed = true;
      } catch (e) {
        conn.status = "degraded";
        conn.detail = `cannot update the Remote Magpie URL: ${(e as Error).message}`.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        return true;
      }
    }

    const keyed = await this.probes.statusWith("127.0.0.1", conn.localPort, 200, key);
    if (!keyed) {
      conn.status = "degraded";
      conn.detail = "the provider does not answer with this Gateway Key (offline, revoked or a different provider)";
      this.recordModelsEvidence(conn, [], "reconcile", conn.detail, "no");
      return true;
    }

    const limit = limitView(await this.probes.remoteLimit(conn.localPort, key, 5000));
    if (JSON.stringify(limit) !== JSON.stringify(conn.limit)) {
      conn.limit = limit;
      changed = true;
    }

    if (opts.verifyModels) {
      const remote = await this.probes.remoteModelIds(conn.localPort, key, 8_000);
      if (!remote || remote.length === 0) {
        conn.status = "degraded";
        conn.detail = "the provider answered but served no model for this key";
        this.recordModelsEvidence(conn, [], "reconcile", conn.detail, "no");
        return true;
      }
      if (!(await this.waitLocalModels(conn.id, 5_000))) {
        conn.status = "degraded";
        conn.detail = `magpie does not list any ${conn.id}/ model`;
        this.recordModelsEvidence(conn, remote, "reconcile", conn.detail, "unknown");
        return true;
      }
      this.recordModelsEvidence(conn, remote, "reconcile", null, "yes");
    }

    if (conn.status !== "connected" || conn.detail) {
      conn.status = "connected";
      conn.detail = null;
      conn.updatedAt = new Date().toISOString();
      conn.lastConnectedAt = conn.updatedAt;
      changed = true;
    }
    return changed;
  }

  /** Unregisters the Remote Magpies this plugin added, and only those. */
  private async dropRemoteRegistrations(reason: string): Promise<void> {
    for (const p of this.state.providers) {
      const ownership = this.ownershipOf(p.id, p.localPort, getProviderKey(p.id));
      if (ownership === "ours") {
        await this.deps.magpie.removeProvider(p.id).catch((e) => logger.warn(`cannot unregister ${p.id}: ${String(e)}`));
      } else if (ownership === "foreign") {
        logger.warn(
          `leaving the Magpie provider "${p.id}" in place: it was changed outside the plugin or is not owned by it`,
        );
      }
    }
    if (this.state.providers.length) logger.info(`unregistered the plugin's remote provider(s): ${reason}`);
  }

  private async recordOrphanForward(localPort: number, dstAddr: string): Promise<void> {
    // 2.6.4's `port-forward remove` does not close a live listener. The forward
    // stays until the core next starts from the generated config; it is
    // recorded so the page and `checks` show it, and it is dropped at that start.
    await this.supervisor.removePortForward(`127.0.0.1:${localPort}`).catch(() => {});
    const still = await this.supervisor.listPortForwards().catch(() => []);
    if (still.some((f) => f.bindAddr === `127.0.0.1:${localPort}`)) {
      this.state.orphanForwards.push({ localPort, dstAddr, since: new Date().toISOString() });
      saveState(this.state);
      logger.warn(`127.0.0.1:${localPort} could not be closed live (EasyTier 2.6.4); it will be dropped at the next core start`);
    }
  }

  /**
   * Retires one control-forward listener. EasyTier 2.6.4 can leave a removed
   * forward listening until the supervised core restarts, so a map delete is not
   * proof of closure. This removes only the named bind, records an owned orphan,
   * and performs the existing supervised restart; other provider forwards and
   * foreign processes are untouched. Returns the measured result for status.
   */
  async retireControlForward(
    bindAddr: string,
    dstAddr: string,
    ownedControlBinds: string[] = [],
  ): Promise<{ closed: boolean; restarted: boolean; orphan: boolean; detail?: string | null }> {
    return this.serialize(async () => {
      const localPort = Number(bindAddr.split(":").pop());
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("invalid control forward bind address");
      const ownedControl = new Set([bindAddr, ...ownedControlBinds]);
      const recordOrphan = (pids: number[], detail: string): void => {
        const existing = this.state.orphanForwards.find((o) => o.localPort === localPort && o.dstAddr === dstAddr);
        if (existing) {
          existing.pids = pids;
          existing.detail = detail;
          existing.since = new Date().toISOString();
        } else {
          this.state.orphanForwards.push({ localPort, dstAddr, since: new Date().toISOString(), pids, detail });
        }
        saveState(this.state);
      };
      // Preserve forwards owned by other state providers and any manual ET
      // forward; the restart below rebuilds only plugin state.
      const before = await this.supervisor.listPortForwards().catch(() => []);
      const providerBinds = new Set(this.forwardSpecs().map((f) => f.bindAddr));
      const extras = before.filter((f) => f.bindAddr !== bindAddr && !providerBinds.has(f.bindAddr) && !ownedControl.has(f.bindAddr));
      const ownedForwards = before.filter((f) => f.bindAddr !== bindAddr && ownedControl.has(f.bindAddr));
      // The retired forward leaves the canonical set; the other owned control
      // forwards stay and are restored by the restart below.
      this.controlForwards.delete(bindAddr);
      for (const f of before) {
        if (f.bindAddr !== bindAddr && ownedControl.has(f.bindAddr)) {
          this.controlForwards.set(f.bindAddr, { bindAddr: f.bindAddr, dstAddr: f.dstAddr });
        }
      }
      this.persistControlForwards();
      this.supervisor.setForwards(this.allForwardSpecs());
      if (extras.length > 0) {
        // A manual/foreign forward is not ours to import or silently rebuild.
        const pids = await this.ownership.listenerPids(localPort).then((r) => r.pids ?? []).catch(() => []);
        recordOrphan(pids, `control restart refused; other forward(s) present: ${extras.map((f) => f.bindAddr).join(", ")}`.slice(0, 300));
        logger.error(`refusing a control restart while ${extras.length} non-plugin forward(s) are present: ${extras.map((f) => f.bindAddr).join(", ")}`);
        return { closed: false, restarted: false, orphan: true };
      }
      await this.supervisor.removePortForward(bindAddr).catch(() => {});
      const probe = async (): Promise<boolean> => {
        try {
          return await this.binder.isFree("127.0.0.1", localPort);
        } catch {
          return false;
        }
      };
      let free = await probe();
      if (free) return { closed: true, restarted: false, orphan: false };
      let pids: number[] = [];
      try {
        const found = await this.ownership.listenerPids(localPort);
        pids = found.pids ?? [];
      } catch {
        pids = [];
      }
      const corePid = this.supervisor.snapshot().pid;
      if (!corePid || pids.length === 0 || !pids.includes(corePid)) {
        // A listener we cannot attribute to the supervised core is not ours to
        // kill/restart around. Keep the evidence and leave it degraded.
        recordOrphan(pids, "listener owner is not the supervised core; restart refused");
        logger.error(`control forward ${bindAddr} remains, but its listener is not owned by the supervised core (pids=${pids.join(",") || "unknown"})`);
        return { closed: false, restarted: false, orphan: true };
      }
      recordOrphan(pids, "2.6.4 remove did not close the listener");
      let restarted = false;
      let restoreError: string | null = null;
      const cfg = this.state.config;
      if (cfg) {
        try {
          await this.applyConfig(cfg);
          restarted = true;
        } catch (e) {
          logger.error(`control forward ${bindAddr} could not be cleared by a supervised restart: ${String(e)}`);
        }
      }
      // Re-add only forwards that existed before and were not part of state;
      // failures are surfaced, never silently lost.
      for (const ownedForward of ownedForwards) {
        try {
          await this.supervisor.addPortForward(ownedForward.bindAddr, ownedForward.dstAddr);
        } catch (e) {
          restoreError = `could not restore control forward ${ownedForward.bindAddr}: ${String((e as Error)?.message ?? e)}`;
          logger.error(restoreError);
          const port = Number(ownedForward.bindAddr.split(":").pop());
          const pids = await this.ownership.listenerPids(port).then((r) => r.pids ?? []).catch(() => []);
          recordOrphan(pids, restoreError.slice(0, 300));
        }
      }
      for (const extra of extras) {
        try {
          await this.supervisor.addPortForward(extra.bindAddr, extra.dstAddr);
        } catch (e) {
          logger.error(`could not restore forward ${extra.bindAddr} after control restart: ${String(e)}`);
        }
      }
      free = await probe();
      const orphan = !free;
      if (!orphan) {
        this.state.orphanForwards = this.state.orphanForwards.filter((o) => o.localPort !== localPort || o.dstAddr !== dstAddr);
        saveState(this.state);
      }
      return { closed: !orphan && !restoreError, restarted, orphan: orphan || Boolean(restoreError), detail: restoreError };
    });
  }

  // --- sharing ---------------------------------------------------------------

  /**
   * A model whitelist may only name this node's own providers. A Remote Magpie
   * (`preset = remote-magpie`) is somebody else's channel and is refused, so a
   * Gateway Key can never resell a peer's models, and an A→B→A chain cannot
   * form through a shared key.
   */
  private assertShareable(models: string[]): void {
    const cfg = this.state.config;
    if (!cfg?.sharingEnabled) throw new Error("this node does not share its Magpie; enable sharing first");
    if (!this.deps.magpie.providersReadable()) {
      throw new Error("cannot read Magpie's provider list; refusing to issue or change a shared key");
    }
    const native = this.deps.magpie.nativeProviderIds();
    const remote = this.deps.magpie.remoteProviderIds();
    const policy = cfg.share;
    for (const m of models) {
      if (m.startsWith("group/") || m.startsWith("auto/")) {
        throw new Error(`a routing group (${m}) cannot be shared: it may contain models from another Magpie`);
      }
      const provider = m.split("/")[0];
      if (remote.has(provider)) {
        throw new Error(`model ${m} belongs to the remote Magpie "${provider}"; a shared key may only use this node's own models`);
      }
      if (!native.has(provider)) {
        throw new Error(`model ${m}: "${provider}" is not a provider on this Magpie`);
      }
      if (!allowedByPolicy(m, policy)) {
        throw new Error(`model ${m} is not in the sharing allow list (${policy.models.join(", ")})`);
      }
    }
  }

  /**
   * Re-checks every issued key against the current native/remote split. A key
   * whose whitelist became unshareable (e.g. a provider was replaced by a
   * Remote Magpie of the same id) is narrowed; if nothing shareable remains it
   * is revoked rather than left open.
   */
  async guardSharedKeys(): Promise<{ narrowed: string[]; revoked: string[]; suspended: boolean }> {
    const narrowed: string[] = [];
    const revoked: string[] = [];
    const cfg = this.state.config;
    if (!cfg?.sharingEnabled) return { narrowed, revoked, suspended: Boolean(this.state.shareSuspended) };
    if (!this.deps.magpie.providersReadable()) {
      // "Unknown" is not "safe": withdraw the export instead of serving keys
      // that may name a provider somebody replaced. Nothing is revoked on a
      // transient read failure, so a flaky read does not destroy working keys.
      await this.suspendSharing(
        "Magpie's provider list cannot be read, so it cannot be proven that every shared model still belongs to this node",
      ).catch((e) => logger.error(`could not withdraw sharing: ${String(e)}`));
      return { narrowed, revoked, suspended: true };
    }
    const native = this.deps.magpie.nativeProviderIds();
    const remote = this.deps.magpie.remoteProviderIds();
    let unverified: string | null = null;
    for (const c of this.provisioner.all()) {
      if (c.revokedAt) continue;
      try {
        // Magpie's own store is the truth, not this plugin's record: the key may
        // have been widened by hand (an empty `models` means "every model" there).
        const held = this.deps.magpie.keyById(c.keyId);
        if (!held) {
          // Somebody removed the key outside the plugin. There is nothing left to
          // widen, narrow or revoke; a hand-over will report it. Do not fail the
          // whole guard (or try to delete a key that is already gone) on it.
          logger.warn(`consumer ${c.consumerId}: its key is no longer in Magpie; nothing to re-check`);
          continue;
        }
        const allowed = c.models.filter((m) => {
          const provider = m.split("/")[0];
          return !remote.has(provider) && native.has(provider) && allowedByPolicy(m, cfg.share);
        });
        if (allowed.length === 0) {
          await this.provisioner.revoke(c.consumerId);
          revoked.push(c.consumerId);
          logger.error(`revoked ${c.consumerId}: none of its models may be shared any more (${c.models.join(", ")})`);
          continue;
        }
        const heldModels = Array.isArray(held.models) ? held.models.map(String) : [];
        const drift = heldModels.length === 0 || !sameSet(heldModels, allowed);
        if (drift) {
          await this.provisioner.setModels(c.consumerId, allowed);
          narrowed.push(c.consumerId);
          logger.warn(
            `narrowed ${c.consumerId} to ${allowed.join(", ")}: Magpie held ` +
              `${heldModels.length ? heldModels.join(", ") : "an empty (all-models) list"}`,
          );
          continue;
        }
        if (allowed.length !== c.models.length) {
          // The key is right but the record still lists an unshareable model.
          await this.provisioner.setModels(c.consumerId, allowed);
          narrowed.push(c.consumerId);
          logger.warn(`narrowed ${c.consumerId} to ${allowed.join(", ")}: the rest may not be shared`);
        }
      } catch (e) {
        // A key that cannot be re-checked must not keep being served: the export
        // is withdrawn until the check succeeds, instead of assuming it is safe.
        unverified = `${c.consumerId}: ${(e as Error).message}`;
        logger.error(`cannot re-check ${c.consumerId}; withdrawing sharing: ${(e as Error).message}`);
      }
    }
    if (unverified) {
      await this.suspendSharing(`a shared key could not be re-checked (${unverified})`).catch((e) =>
        logger.error(`could not withdraw sharing: ${String(e)}`),
      );
      return { narrowed, revoked, suspended: true };
    }
    if (this.state.shareSuspended && this.state.shareSuspended.reason.startsWith(SHARE_POLICY_SUSPENSION)) {
      // Only an explicit new exact selection may restore sharing.
      return { narrowed, revoked, suspended: true };
    }
    if (this.state.shareSuspended && this.state.shareSuspended.reason.startsWith(ACCOUNTING_SUSPENSION)) {
      // The accounting check withdrew the export. The share guard has no
      // authority to restore it: only a passing accounting check may.
      return { narrowed, revoked, suspended: true };
    }
    if (this.state.shareSuspended) {
      await this.resumeSharing().catch((e) => logger.error(`could not restore sharing: ${String(e)}`));
    }
    return { narrowed, revoked, suspended: false };
  }

  // --- consumers -------------------------------------------------------------

  /** The provider operator hands a consumer key over; never logged. */
  async handover(
    consumerId: string,
  ): Promise<{ consumerId: string; keyName: string; key: string; models: string[]; capUsd: number }> {
    const first = this.provisioner.find(consumerId);
    if (!first || first.revokedAt) throw new Error(`no active consumer ${consumerId}`);
    if (!first.secret) throw new Error(`the key of ${consumerId} is not in this Magpie any more; recreate it`);

    // The guard can narrow or revoke this key, so it runs before anything is
    // returned, and every result below is re-read from that post-guard state.
    await this.guardSharedKeys();
    const rec = this.provisioner.find(consumerId);
    if (!rec || rec.revokedAt) {
      throw new Error(`consumer ${consumerId} was revoked while its key was being prepared; do not hand it over`);
    }
    if (!rec.secret) throw new Error(`the key of ${consumerId} is not in this Magpie any more; recreate it`);

    // The cap is verified against the gateway; the model list comes from
    // Magpie's own key store, never from the local record alone.
    await this.provisioner.status(consumerId);
    if (rec.paused) throw new Error(`consumer ${consumerId} is paused (${rec.paused.reason}); reissue the key before hand-over`);
    const held = this.deps.magpie.keyById(rec.keyId);
    if (!held) throw new Error(`the key of ${consumerId} is no longer in Magpie; recreate it`);
    let models = Array.isArray(held.models) ? held.models.map(String) : [];
    if (models.length === 0) {
      // An empty whitelist means "every model" in Magpie: rewrite it from the
      // record (which the guard has just checked) before handing anything over.
      await this.provisioner.setModels(consumerId, rec.models);
      models = this.deps.magpie.keyById(rec.keyId)?.models?.map(String) ?? [];
    }
    // Read the secret under the same per-consumer lock that approve/reissue/
    // revoke use, and re-check the exact key generation/native row there.
    const locked = await this.provisioner.readHandover(consumerId, rec.keyId);
    models = locked.models;
    this.assertShareable(models);
    logger.info(`handing key ${locked.keyName} over for ${consumerId} (${models.join(", ")})`);
    return { consumerId, keyName: locked.keyName, key: locked.key, models, capUsd: locked.capUsd };
  }

  async topUp(consumerId: string, usd: number, depositId?: string): Promise<ConsumerView> {
    return this.provisioner.topUp(consumerId, usd, depositId);
  }

  /**
   * Fail-closed recovery: reissue a paused key with the same secret, carrying
   * only the ledger balance. A price change requires the new version to be
   * accepted explicitly; a window boundary does not, because no price changed.
   */
  /**
   * Records an audited resolution of a usage-log gap. It does not reconstruct
   * the missing charges or adjust the balance; it states what the operator
   * accepted, so a later reissue can proceed on the recorded balance.
   */
  async resolveConsumerGap(
    consumerId: string,
    opts: { logId: string; resolvedBy: string; note: string; acceptedOffset?: number },
  ): Promise<ConsumerView> {
    const view = await this.provisioner.resolveUsageGap(consumerId, opts);
    this.writeSnapshot();
    return view;
  }

  async reissueConsumer(consumerId: string, acceptPriceVersion?: string, acceptQuoteHash?: string): Promise<ConsumerView> {
    const view = await this.provisioner.reissue(consumerId, { acceptPriceVersion, acceptQuoteHash });
    this.writeSnapshot();
    return view;
  }

  /** The local quote/provider evidence used by both import preview and approval. */
  requestApprovalContext(): ApprovalContext {
    return {
      provider: { nodeId: this.state.config?.nodeId ?? null, mappedCidr: this.state.config?.mappedCidr ?? null, gatewayPort: this.gatewayPort() },
      quote: this.catalogStatus().quote,
    };
  }

  /** Keep quote validation and issuance in the same service operation and consumer lock. */
  async approveConnectionRequest(request: ConnectionRequest, models: string[], capUsd: number, opts: { reactivate?: boolean } = {}): Promise<ConsumerView> {
    capOnGrid(capUsd);
    return this.serialize(async () => {
      await this.publishCatalogNow();
      const chosen = validateRequestApproval(request, this.requestApprovalContext(), models);
      this.assertShareable(chosen.models);
      const candidates = await this.shareCandidates();
      if (chosen.models.some(id => !candidates.models.some(m => m.id === id && m.completePrice && m.allowedByPolicy))) {
        throw new RequestValidationError("approved models must be currently priced native models allowed by your sharing policy");
      }
      // A repeat is a no-op only for the exact existing approval. It must never
      // turn into an implicit top-up or silently widen an existing account.
      const existing = this.provisioner.find(request.consumer.nodeId);
      if (existing?.revokedAt && !opts.reactivate) {
        throw new RequestValidationError("this consumer was revoked; an explicit re-approval is required");
      }
      if (existing && !existing.revokedAt && (existing.acceptedQuoteHash !== request.quote.contentHash || existing.capUsd !== capUsd || !sameSet(existing.models, chosen.models))) {
        throw new RequestValidationError("this consumer already has a different authorization; manage its existing account explicitly");
      }
      return this.ensureConsumer(request.consumer.nodeId, chosen.models, capUsd, {
        reactivate: Boolean(opts.reactivate && existing?.revokedAt),
        hash: request.quote.contentHash,
        priceVersion: chosen.priceVersion,
        beforeApply: () => {
          validateRequestApproval(request, this.requestApprovalContext(), chosen.models);
          this.assertShareable(chosen.models);
          const current = this.provisioner.find(request.consumer.nodeId);
          if (opts.reactivate && current?.revokedAt) return;
          if (current && (current.revokedAt || current.acceptedQuoteHash !== request.quote.contentHash || current.capUsd !== capUsd || !sameSet(current.models, chosen.models))) {
            throw new RequestValidationError("this consumer authorization changed while approval was waiting; review it again");
          }
        },
      });
    });
  }

  /** Browser selection requires explicit, completely priced native model IDs. */
  async setConsoleShareModels(models: string[]): Promise<StatusSnapshot> {
    const selected = modelList(models);
    const candidates = await this.shareCandidates();
    if (selected.some(id => !candidates.models.some(m => m.id === id && m.completePrice))) {
      throw new RequestValidationError("only native models with a complete effective price can be shared");
    }
    return this.setShareModels(selected);
  }

  consumerReissuePreview(consumerId: string): { consumerId: string; currentPriceVersion: string | null; currentQuoteHash: string | null } {
    const c = this.provisioner.find(consumerId);
    if (!c || c.revokedAt) throw new RequestValidationError("no active consumer");
    const quote = this.catalogStatus().quote;
    const complete = quote && c.models.every(id => quote.models.some(m => m.id === id));
    return { consumerId, currentPriceVersion: complete ? catalogPriceVersion(quote.models.filter(m => c.models.includes(m.id))) : null, currentQuoteHash: complete ? quote.contentHash : null };
  }

  async reissueConsoleConsumer(consumerId: string, acceptPriceVersion?: string, acceptQuoteHash?: string) {
    return this.serialize(async () => {
      await this.publishCatalogNow();
      const preview = this.consumerReissuePreview(consumerId);
      if (!preview.currentPriceVersion || !preview.currentQuoteHash) throw new RequestValidationError("publish a complete priced quote before reissue");
      if (acceptPriceVersion !== preview.currentPriceVersion || acceptQuoteHash !== preview.currentQuoteHash) throw new RequestValidationError("review and accept the current model price version and quote before reissue");
      return this.reissueConsumer(consumerId, acceptPriceVersion, acceptQuoteHash);
    });
  }

  async checkConsoleConsumer(consumerId: string) {
    await this.publishCatalogNow();
    const consumer = await this.provisioner.checkConsumer(consumerId);
    return { consumer, ...this.consumerReissuePreview(consumerId) };
  }

  async setConsumerModels(consumerId: string, models: string[]): Promise<ConsumerView> {
    const selected = modelList(models);
    this.assertShareable(selected);
    const c = this.provisioner.find(consumerId);
    if (!c || c.revokedAt) throw new RequestValidationError("no active consumer");
    // Narrowing is safe within the issued authorization. Widening requires a
    // newly reviewed request and price binding, never an empty/all-models list.
    if (selected.some(m => !c.models.includes(m))) throw new RequestValidationError("consumer models may only narrow the existing authorization");
    const candidates = await this.shareCandidates();
    if (selected.some(id => !candidates.models.some(m => m.id === id && m.completePrice && m.allowedByPolicy))) {
      throw new RequestValidationError("consumer models must remain priced native models allowed by your policy");
    }
    const result = await this.provisioner.setModels(consumerId, selected);
    this.writeSnapshot();
    return result;
  }

  async ensureConsumer(
    consumerId: string,
    models: string[],
    capUsd: number,
    quote: { hash?: string; priceVersion?: string; beforeApply?: () => void; reactivate?: boolean } = {},
  ): Promise<ConsumerView> {
    this.assertShareable(models);
    const v = await this.provisioner.ensure(consumerId, {
      models,
      capUsd,
      quoteHash: quote.hash,
      quotePriceVersion: quote.priceVersion,
      beforeApply: quote.beforeApply,
      reactivate: quote.reactivate === true,
    });
    if (!this.state.consumers.includes(consumerId)) this.state.consumers.push(consumerId);
    saveState(this.state);
    return v;
  }

  async revokeConsumer(consumerId: string): Promise<ConsumerView> {
    return this.provisioner.revoke(consumerId);
  }

  // --- checks ----------------------------------------------------------------

  /**
   * Runs the checks and caches the evidence with the time it was collected.
   * The page snapshot renders this cache; it never claims a cached result is
   * current, and it never invents a reachable provider before a probe.
   */
  async checks(): Promise<OperatorCheck[]> {
    const started = Date.now();
    try {
      const out = await this.runChecks();
      const at = new Date().toISOString();
      for (const check of out) {
        check.at = at;
        check.kind ??= check.name.startsWith("provider:") ? "remote" : "local";
      }
      this.cachedChecks = out;
      this.cachedChecksAt = at;
      this.cachedChecksDurationMs = Date.now() - started;
      this.cachedChecksError = null;
      return out;
    } catch (e) {
      this.cachedChecksError = (e as Error)?.message ?? String(e);
      throw e;
    }
  }

  /** The last cached checks and a readiness verdict derived from them. */
  readinessSnapshot(): ReadinessSnapshot {
    const checkedAt = this.cachedChecksAt;
    const ageMs = checkedAt ? Math.max(0, Date.now() - Date.parse(checkedAt)) : null;
    const source: "cached" | "none" = checkedAt ? "cached" : "none";
    const providers = this.providerReadiness();
    if (!this.state.config) {
      return {
        state: "blocked",
        checkedAt,
        ageMs,
        source,
        reasons: ["no overlay configuration yet"],
        providers,
      };
    }
    if (!checkedAt) {
      return {
        state: "unknown",
        checkedAt: null,
        ageMs: null,
        source,
        reasons: [this.cachedChecksError ?? "checks have not run yet"],
        providers,
      };
    }
    const blocked = this.cachedChecks.filter((c) => !c.ok && isCriticalCheck(c.name)).map((c) => `${c.name}: ${c.detail}`);
    const remote = this.cachedChecks.filter((c) => !c.ok && !isCriticalCheck(c.name) && c.kind === "remote").map((c) => `${c.name}: ${c.detail}`);
    const reasons = [...blocked, ...remote];
    if (this.cachedChecksError) reasons.push(`last check failed to complete: ${this.cachedChecksError}`);
    const state: ReadinessSnapshot["state"] = blocked.length
      ? "blocked"
      : remote.length || this.cachedChecksError
        ? "degraded"
        : "ready";
    return { state, checkedAt, ageMs, source, reasons, providers };
  }

  /** Remote reachability is a claim only after a probe; otherwise it is UNKNOWN. */
  private providerReadiness(): ReadinessSnapshot["providers"] {
    return this.state.providers.map((p) => {
      const check = this.cachedChecks.find((c) => c.name === `provider:${p.id}:status`);
      return {
        id: p.id,
        reachability: check ? (check.ok ? "reachable" : "unreachable") : "UNKNOWN",
      };
    });
  }

  /** The checks that decide whether this node may serve or consume at all. */
  private async runChecks(): Promise<OperatorCheck[]> {
    const out: OperatorCheck[] = [];
    const cfg = this.state.config;
    const et = this.supervisor.snapshot();
    if (!cfg) {
      out.push({ name: "configured", ok: false, detail: "no overlay configuration yet" });
      return out;
    }
    out.push({ name: "core-running", ok: et.running, detail: et.running ? `pid ${et.pid}` : (et.lastError ?? "stopped") });
    out.push({
      name: "acl",
      ok: et.aclOk,
      detail: et.aclOk
        ? cfg.sharingEnabled
          ? "Inbound Drop (no rules), Forward Drop with published ports, forwards loopback-only"
          : "Inbound Drop (no rules); nothing exported"
        : et.aclProblems.join("; "),
    });
    if (this.state.shareSuspended) {
      out.push({
        name: "sharing-suspended",
        ok: false,
        detail: `sharing was withdrawn at ${this.state.shareSuspended.at}: ${this.state.shareSuspended.reason}`,
      });
    }
    if (cfg.sharingEnabled) {
      const gw = this.gatewayPort();
      out.push({
        name: "gateway-key-required",
        ok: await this.probes.statusWith(hostOf(cfg.proxyCidr) ?? "127.0.0.1", gw, 401),
        detail: `GET http://${hostOf(cfg.proxyCidr) ?? "127.0.0.1"}:${gw}/v1/models without a key must answer 401`,
      });
      out.push({
        name: "mapped-cidr",
        ok: Boolean(et.mappedCidr && et.aclOk),
        detail: et.mappedCidr ?? "none",
      });
      out.push({
        name: "published-gateway",
        ok: cfg.publishedPorts.includes(gw),
        detail: `the gateway answers on ${gw}; published ports are [${cfg.publishedPorts.join(", ")}]`,
      });
      const guard = await this.shareGuardReport();
      out.push({ name: "shared-models-native-only", ok: guard.ok, detail: guard.detail });
      out.push({
        name: "share-guard-cadence",
        ok: true,
        detail:
          "provider-id/type changes are noticed on the 15s tick; a direct edit of a Gateway Key's model whitelist " +
          "is noticed by the full guard on the reconcile pass (about 45s) or at the next hand-over",
      });
    }
    const cat = this.catalogStatus();
    if (cfg.catalog.enabled) {
      const published = cat.publishing && cat.server.running && et.publishedPorts.includes(cfg.catalog.port);
      out.push({
        name: "catalog-published",
        ok: published,
        detail: published
          ? `${cat.server.address}${CATALOG_PATH} (Forward ACL allows tcp/${cfg.catalog.port})`
          : `publishing is ${cat.publishing ? "on but not serving" : "off"}: ${cat.server.error ?? "no catalogue listener"}`,
      });
      out.push({
        name: "catalog-forward-port",
        ok: !cat.publishing || et.publishedPorts.includes(cfg.catalog.port),
        detail: `catalogue port ${cfg.catalog.port}; Forward ACL ports [${et.publishedPorts.join(", ")}]`,
      });
      out.push({
        name: "catalog-quote",
        ok: Boolean(cat.quote),
        detail: cat.quote
          ? `version ${cat.quote.version}, ${cat.quote.modelCount} model(s), updated ${cat.quote.updatedAt}, identity ${cat.quote.identity?.fingerprint ?? "none"}`
          : "no signed quote yet",
      });
      out.push({
        name: "catalog-identity",
        ok: Boolean(cat.quote?.identity),
        detail: cat.quote?.identity
          ? `self-signed Ed25519 ${cat.quote.identity.fingerprint} (not a real-world identity)`
          : "no identity yet",
      });
    }
    if (cfg.catalog.discoveryEnabled) {
      out.push({
        name: "catalog-socks5-loopback",
        ok: Boolean(et.socks5Port && et.aclOk),
        detail: et.socks5Port
          ? `127.0.0.1:${et.socks5Port} (on-demand reads; no per-peer port forward)`
          : "the SOCKS5 listener is not running",
      });
      const changed = cat.peers.filter((p) => p.status === "identity-changed").length;
      const stale = cat.peers.filter((p) => p.status === "stale").length;
      out.push({
        name: "catalog-peers",
        ok: changed === 0,
        detail:
          `${cat.peers.filter((p) => p.online && p.status !== "self").length} online, ` +
          `${cat.peers.filter((p) => p.status === "offline").length} offline` +
          (changed ? `, ${changed} with a changed identity awaiting local acceptance` : "") +
          (stale ? `, ${stale} with an older/replayed quote refused` : "") +
          (cat.error ? `; last error: ${cat.error}` : ""),
      });
    }
    if (cfg.consumingEnabled) {
      const forwards = await this.supervisor.listPortForwards().catch(() => []);
      for (const p of this.state.providers) {
        const has = forwards.some((f) => f.bindAddr === `127.0.0.1:${p.localPort}`);
        out.push({
          name: `provider:${p.id}:forward`,
          ok: has,
          detail: has ? `127.0.0.1:${p.localPort} -> ${p.mappedCidr}` : `no listener on 127.0.0.1:${p.localPort}`,
        });
        const ownership = this.ownershipOf(p.id, p.localPort, getProviderKey(p.id));
        out.push({
          name: `provider:${p.id}:registered`,
          ok: ownership === "ours",
          detail:
            ownership === "ours"
              ? `Remote Magpie "${p.id}" is the one this plugin registered`
              : ownership === "absent"
                ? `Remote Magpie "${p.id}" is not registered in Magpie`
                : `the Magpie provider "${p.id}" was changed outside this plugin; left untouched`,
        });
        out.push({
          name: `provider:${p.id}:status`,
          ok: p.status === "connected",
          detail: `${p.status}${p.detail ? `: ${p.detail}` : ""}`,
        });
      }
    }
    if (cfg.consumingEnabled) {
      const running = await this.supervisor.listPortForwards().catch(() => null);
      if (running) {
        const expected = new Set(this.allForwardSpecs().map((f) => `${f.bindAddr}->${f.dstAddr}`));
        const unexpected = running.filter((f) => !expected.has(`${f.bindAddr}->${f.dstAddr}`));
        out.push({
          name: "forwards-match",
          ok: unexpected.length === 0,
          detail: unexpected.length
            ? `loopback listeners no provider uses: ${unexpected.map((f) => `${f.bindAddr} -> ${f.dstAddr}`).join(", ")}`
            : `${expected.size} loopback forward(s), all owned by a provider`,
        });
      }
      // A forward is only usable when the OS attributes its loopback socket to
      // the supervised core; a matching config line is not ownership. An
      // injected test supervisor has no real PID, so the check is not asserted.
      const snap = this.supervisor.snapshot();
      const owned: string[] = [];
      const foreign: string[] = [];
      for (const p of this.state.providers) {
        if (!snap.pid) {
          foreign.push(`${p.id}: no core pid`);
          continue;
        }
        const found = await this.ownership.listenerPids(p.localPort);
        if (!found.supported) foreign.push(`${p.id}: socket-owner probe unavailable`);
        else if (!found.pids.includes(snap.pid)) foreign.push(`${p.id}: held by ${found.pids.join(",") || "nobody"}, not pid ${snap.pid}`);
        else owned.push(p.id);
      }
      if (this.state.providers.length) {
        out.push({
          name: "forwards-owned",
          ok: foreign.length === 0,
          detail: foreign.length
            ? `loopback forward(s) not proven to belong to this core: ${foreign.join("; ")}`
            : `${owned.length} loopback forward(s) owned by the core`,
        });
      }
    }
    if (this.state.orphanForwards.length) {
      out.push({
        name: "no-orphan-forwards",
        ok: false,
        detail: `${this.state.orphanForwards.length} loopback forward(s) will be dropped at the next core start: ${this.state.orphanForwards
          .map((o) => `127.0.0.1:${o.localPort}`)
          .join(", ")}`,
      });
    }
    return out;
  }

  private async shareGuardReport(): Promise<{ ok: boolean; detail: string }> {
    const cfg = this.state.config;
    if (!cfg) return { ok: false, detail: "not configured" };
    if (!this.deps.magpie.providersReadable()) {
      return { ok: false, detail: "cannot read Magpie's provider list; the native/remote split cannot be proven" };
    }
    const native = this.deps.magpie.nativeProviderIds();
    const remote = this.deps.magpie.remoteProviderIds();
    const bad: string[] = [];
    for (const c of this.provisioner.all()) {
      if (c.revokedAt) continue;
      for (const m of c.models) {
        const provider = m.split("/")[0];
        if (remote.has(provider) || !native.has(provider) || !allowedByPolicy(m, cfg.share)) bad.push(`${c.consumerId}:${m}`);
      }
    }
    return bad.length
      ? { ok: false, detail: `keys name models that may not be shared: ${bad.join(", ")}` }
      : { ok: true, detail: `${this.provisioner.all().filter((c) => !c.revokedAt).length} key(s) name only native, allowed models` };
  }

  // --- status ----------------------------------------------------------------

  async status(): Promise<StatusSnapshot> {
    // A platform without an app bundle learns its version from the CLI, once,
    // with a timeout; the page snapshot and boot never wait for it.
    if (this.deps.magpieVersion.includes("unknown")) {
      this.deps.magpieVersion = await this.deps.magpie.detectVersion();
    }
    const checks = await this.checks().catch(() => this.cachedChecks);
    const snap: StatusSnapshot = {
      ...this.lightStatus(),
      consumers: await this.provisioner.refreshAll(),
      accounting: this.accountingStatus(),
      checks,
      checksAt: this.cachedChecksAt,
      checksDurationMs: this.cachedChecksDurationMs,
      readiness: this.readinessSnapshot(),
    };
    this.lastSnapshot = snap;
    return snap;
  }

  private lastSnapshot: StatusSnapshot | null = null;

  /** Authenticated local console polling: cached evidence, never a network probe or reconciliation. */
  consoleSnapshot(): StatusSnapshot {
    return this.lightStatus();
  }

  /** The snapshot without the (network) checks, for the page file. */
  private lightStatus(): StatusSnapshot {
    const et = this.supervisor.snapshot();
    const cfg = this.state.config;
    return {
      plugin: { version: "0.5.0", pid: process.pid, dataDir: process.cwd(), startedAt: this.startedAt, stateVersion: this.state.version },
      magpie: { version: this.deps.magpieVersion, gateway: gatewayBaseURL() },
      config: {
        role: cfg ? (cfg.sharingEnabled ? "provider" : "consumer") : null,
        sharingEnabled: cfg?.sharingEnabled ?? false,
        sharingActive: this.sharingActive(),
        shareSuspended: this.state.shareSuspended,
        consumingEnabled: cfg?.consumingEnabled ?? false,
        nodeId: cfg?.nodeId ?? null,
        hostname: et.hostname ?? (cfg ? configHostname(cfg) : null),
        networkName: cfg?.networkName ?? null,
        peers: cfg?.peers ?? [],
        listenAddr: cfg?.listenAddr ?? null,
        virtualIpv4: cfg?.virtualIpv4 ?? null,
        proxyCidr: cfg?.proxyCidr ?? null,
        mappedCidr: cfg?.mappedCidr ?? null,
        publishedPorts: cfg?.publishedPorts ?? [],
        secureMode: cfg?.secureMode ?? false,
        rpcPort: cfg?.rpcPort ?? null,
        share: cfg?.share ?? { models: [] },
        nativeProviders: [...this.deps.magpie.nativeProviderIds()],
        remoteProviders: [...this.deps.magpie.remoteProviderIds()],
        catalog: cfg?.catalog ?? normalizeCatalogConfig(undefined),
      },
      easytier: et,
      network: this.networkView(),
      consumers: this.provisioner.all(),
      accounting: this.accountingStatus(),
      providers: this.providers(),
      catalog: this.catalogStatus(),
      wallet: this.walletLocalStatus(),
      wiring: this.state.providers[0]
        ? {
            id: this.state.providers[0].id,
            mappedCidr: this.state.providers[0].mappedCidr,
            url: `http://127.0.0.1:${this.state.providers[0].localPort}`,
            createdAt: this.state.providers[0].createdAt,
          }
        : null,
      checks: this.cachedChecks,
      checksAt: this.cachedChecksAt,
      checksDurationMs: this.cachedChecksDurationMs,
      readiness: this.readinessSnapshot(),
      logs: [],
    };
  }

  /** Keeps the page's snapshot file current (the page cannot fetch). */
  writeSnapshot(): void {
    const snap = this.lightStatus();
    this.lastSnapshot = snap;
    writePageStatus({ ...snap, generatedAt: new Date().toISOString() });
  }

  problem(): string | null {
    return this.lastProblem;
  }

  // --- helpers ---------------------------------------------------------------

  private async allocLocalPort(): Promise<number> {
    const used = new Set(this.state.providers.map((p) => p.localPort));
    // A port whose proof failed is not "free because the range says so": a
    // retry moves to another candidate and records the migration.
    const broken = this.portLedger().evidence
      .filter((e) => e.purpose === "forward" && (e.state === "failed" || e.state === "conflict"))
      .map((e) => e.port);
    return this.choosePort(
      "forward",
      "127.0.0.1",
      portRange(FORWARD_PORT_FROM, FORWARD_PORT_TO),
      [...used, ...broken, this.gatewayPort()],
    );
  }

  /**
   * Whether the Magpie entry with this id is the one this plugin wrote. This is
   * the only ownership record: the connection's loopback port and the Gateway
   * Key in the key store are what the plugin put there. A native provider, a
   * different Remote Magpie, or an entry edited by hand does not match.
   */
  /**
   * The loopback port the *plugin-owned* Magpie entry currently points at.
   * `null` = absent, `"foreign"` = somebody else's entry (never touch it).
   * This is what makes a crash between "register at the new port" and "commit
   * the new port in state" recoverable without treating our own entry as foreign.
   */
  private ownedLoopbackPort(id: string, key: string | null | undefined): number | "foreign" | null {
    const entry = this.deps.magpie.providerById(id);
    if (!entry) return null;
    if (entry.preset !== "remote-magpie" || !key || entry.key !== key) return "foreign";
    const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/v1$/.exec(typeof entry.chat === "string" ? entry.chat : "");
    if (!match) return "foreign";
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return "foreign";
    // Only a port this plugin knows about can be "ours": the recorded desired
    // port, or the from/to of a persisted recovery. An entry edited by hand to
    // an arbitrary loopback port stays foreign and is never rewritten.
    const rec = this.provider(id);
    const known = new Set<number>();
    if (rec?.localPort) known.add(rec.localPort);
    if (rec?.forwardPending) {
      known.add(rec.forwardPending.from);
      known.add(rec.forwardPending.to);
    }
    return known.has(port) ? port : "foreign";
  }

  private ownershipOf(id: string, localPort: number, key: string | null | undefined): Ownership {
    const entry = this.deps.magpie.providerById(id);
    if (!entry) return "absent";
    if (entry.preset !== "remote-magpie" || !key) return "foreign";
    const want = `http://127.0.0.1:${localPort}/v1`;
    return entry.chat === want && entry.key === key ? "ours" : "foreign";
  }

  /**
   * Re-registers a provider this plugin already owns after a failed update.
   * Never touches an entry that is not ours.
   */
  private async restoreRemoteProvider(prev: ProviderConnection, key: string): Promise<void> {
    const ownership = this.ownershipOf(prev.id, prev.localPort, key);
    if (ownership === "ours") return;
    if (ownership === "foreign") {
      logger.error(`not restoring Remote Magpie "${prev.id}": Magpie holds a different provider with that id`);
      return;
    }
    await this.deps.magpie
      .addRemoteProvider({ id: prev.id, url: `http://127.0.0.1:${prev.localPort}`, key })
      .catch((e) => logger.error(`could not restore provider ${prev.id}: ${String(e)}`));
  }

  /**
   * The peer that announces `mapped` as a proxy prefix. More than one owner is
   * ambiguous and refused: the dial would land on either of them.
   */
  async routeOwner(mapped: string): Promise<RouteOwner | null> {
    const routes = await this.supervisor.routes();
    const owners = new Map<string, RouteRow>();
    for (const r of routes) {
      for (const c of r.proxyCidrs.split(",").map((x) => x.trim())) {
        if (!c) continue;
        const dialed = c.includes("->") ? c.split("->")[1] : c;
        if (mappedHost(dialed) === mapped) owners.set(r.hostname || r.ipv4, r);
      }
    }
    if (owners.size > 1) {
      throw new Error(`the overlay announces ${mapped} from ${[...owners.keys()].join(", ")}; each provider needs its own mapped_cidr`);
    }
    const row = [...owners.values()][0];
    if (!row) return null;
    let peerId: string | null = null;
    try {
      const peers = await this.supervisor.peers();
      peerId = peers.find((p) => p.hostname === row.hostname && p.ipv4 === row.ipv4.replace(/\/\d+$/, ""))?.id ?? null;
    } catch {
      /* the peer list is a hint, the route is the selector */
    }
    return { hostname: row.hostname, ipv4: row.ipv4.replace(/\/\d+$/, ""), peerId };
  }

  /** Polls a keyed endpoint until it answers `want`, or the timeout passes. */
  private async waitForStatus(host: string, port: number, want: number, bearer?: string, timeoutMs = this.probeTimeoutMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.probes.statusWith(host, port, want, bearer)) return true;
      await new Promise((r) => setTimeout(r, 500));
    } while (Date.now() < deadline);
    return false;
  }

  private async waitLocalModels(providerId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ids = await this.probes.localModelIds();
        if (ids.some((id) => id.startsWith(`${providerId}/`))) return true;
      } catch {
        /* the CLI may be busy; keep waiting */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function describeRole(cfg: PluginConfig): string {
  if (cfg.sharingEnabled && cfg.consumingEnabled) return "a sharing and consuming node";
  if (cfg.sharingEnabled) return "a sharing node";
  if (cfg.consumingEnabled) return "a consuming node";
  return "an idle node (neither sharing nor consuming)";
}

function configHostname(cfg: PluginConfig): string {
  return `ohmyaihub-${cfg.nodeId}`;
}

function normalizeShareModels(models: string[]): string[] {
  const cleaned = models.map((m) => m.trim()).filter(Boolean);
  // An explicit empty policy shares nothing. Only legacy documents may still
  // carry "*"; a new selection must name native models.
  if (cleaned.length === 0) return [];
  for (const m of cleaned) {
    if (!/^(\*|[A-Za-z0-9._-]+\/(\*|[A-Za-z0-9._*,/-]+))$/.test(m)) {
      throw new Error(`share model must be "*", "provider/*" or "provider/model": ${m}`);
    }
  }
  return cleaned;
}

/** Does a native model id match the sharing allow list? */
export function allowedByPolicy(model: string, policy: SharePolicy): boolean {
  for (const entry of policy.models) {
    if (entry === "*") return true;
    if (entry.endsWith("/*") && model.startsWith(entry.slice(0, -1))) return true;
    if (entry === model) return true;
  }
  return false;
}

function normalizeListen(addr: string | null): string | null {
  if (!addr) return null;
  const a = addr.trim();
  if (!a) return null;
  const withScheme = a.includes("://") ? a : `tcp://${a}`;
  if (!/^(tcp|udp):\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/.test(withScheme)) {
    throw new Error("listenAddr must be host:port (IPv4) or empty");
  }
  return withScheme;
}

function normalizeVirtualIp(v: string): string {
  const s = v.trim();
  const withPrefix = s.includes("/") ? s : `${s}/24`;
  if (!/^10\.77\.\d{1,3}\.\d{1,3}\/24$/.test(withPrefix)) {
    throw new Error("virtualIpv4 must be an address inside 10.77.0.0/24");
  }
  const host = Number(withPrefix.split("/")[0].split(".")[3]);
  if (host < 2 || host > 254) throw new Error("virtualIpv4 host part must be 2-254");
  return withPrefix;
}

function safeLanIp(): string | null {
  try {
    return lanIPv4();
  } catch {
    return null;
  }
}

/** A loopback listener port another part of this host recorded, or null. */
function readPortFile(name: string): number | null {
  try {
    const raw = readFileSync(statePath(name), "utf8").trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function hostOf(cidr: string | null): string | null {
  if (!cidr) return null;
  return cidr.replace(/\/\d+$/, "");
}

async function statusIs(host: string, port: number, want: number, bearer?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(`http://${host}:${port}/v1/models`, { headers, signal: AbortSignal.timeout(5000) });
    return res.status === want;
  } catch {
    return false;
  }
}

/** The models a remote gateway serves, asked through the consumer's forward. */
async function remoteModelIds(localPort: number, key: string, timeoutMs: number): Promise<string[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${localPort}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean);
  } catch {
    return null;
  }
}

/** The provider's own native limit numbers, through its keyed forward. */
async function remoteLimit(localPort: number, key: string, timeoutMs: number): Promise<LimitStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${localPort}/v1/magpie/limit`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as LimitStatus;
  } catch {
    return null;
  }
}

function finitePrice(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function limitView(status: LimitStatus | null): ProviderLimitView | null {
  const l = status?.limit;
  if (!l) return null;
  const out: ProviderLimitView = {};
  if (l.period) out.period = l.period;
  if (typeof l.calls === "number") out.calls = l.calls;
  if (typeof l.cost === "number") out.cost = l.cost;
  if (typeof l.costLimit === "number") out.costLimit = l.costLimit;
  if (typeof l.costLeft === "number") out.costLeft = l.costLeft;
  if (typeof l.tokens === "number") out.tokens = l.tokens;
  if (typeof l.spent === "boolean") out.spent = l.spent;
  if (typeof l.reset === "string") out.reset = l.reset;
  return out;
}

function priceFrom(p: import("./magpie.ts").ModelPriceRecord, source: "magpie-gateway" | "magpie-settings"): CatalogPrice | null {
  if (unsupportedPriceReason(p)) return null;
  const input = finitePrice(p.input);
  const output = finitePrice(p.output);
  const cacheRead = finitePrice(p.cache_read);
  const cacheWrite = finitePrice(p.cache_write);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  const tiers: CatalogPrice["tiers"] = [];
  for (const t of p.tiers ?? []) {
    const ti = finitePrice(t.input);
    const to = finitePrice(t.output);
    const tr = finitePrice(t.cache_read);
    const tw = finitePrice(t.cache_write);
    const above = finitePrice(t.above);
    if (ti === null || to === null || tr === null || tw === null || above === null || above <= 0) continue;
    tiers.push({ above, input: ti, output: to, cacheRead: tr, cacheWrite: tw, ...(finitePrice(t.cache_write_1h) !== null ? { cacheWrite1h: finitePrice(t.cache_write_1h)! } : {}) });
  }
  const out: CatalogPrice = { unit: "USD per 1M tokens", input, output, cacheRead, cacheWrite, source };
  const oneHour = finitePrice(p.cache_write_1h);
  if (oneHour !== null) out.cacheWrite1h = oneHour;
  if (tiers.length) out.tiers = tiers;
  return out;
}

function catalogModel(meta: CatalogModelMeta): CatalogModel | null {
  if (!meta.id) return null;
  const pricing = meta.price ? priceFrom(meta.price, meta.priceSource === "magpie-gateway" ? "magpie-gateway" : "magpie-settings") : null;
  return {
    id: meta.id,
    displayName: meta.displayName,
    gatewayApis: [...meta.gatewayApis],
    nativeApis: meta.nativeApis ? [...meta.nativeApis] : null,
    contextWindow: meta.contextWindow,
    maxOutputTokens: meta.maxOutputTokens,
    images: meta.images,
    modalities: meta.modalities ?? null,
    reasoningLevels: meta.reasoningLevels ? [...meta.reasoningLevels] : null,
    pricing,
    capabilitiesSource: meta.capabilitiesSource,
  };
}

/** Connectivity is never evidence of explicit acceptance of a catalogue key. */
export function catalogIdentityAccepted(nodeId: string | null, fingerprint: string): boolean {
  if (!nodeId) return false;
  const trust = loadCatalogTrust()[nodeId];
  return Boolean(trust?.accepted && !trust.pending && trust.fingerprint === fingerprint);
}

/**
 * A request/connect is only allowed for an identity the operator accepted and a
 * quote they actually reviewed. Without this, a quote could change between the
 * display and the click while the command still looked safe.
 */
function assertCatalogAcceptance(
  peer: CatalogPeerView,
  acceptance?: CatalogAcceptance,
): asserts acceptance is CatalogAcceptance {
  if (!acceptance) {
    throw new Error(
      `pass the catalogue fingerprint and quote hash you reviewed for ${peer.hostname} ` +
        `(\`--accept-fingerprint <sha256> --accept-quote <sha256>\`); no identity or quote is accepted implicitly`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(acceptance.fingerprint)) throw new Error("the accepted fingerprint must be 64 lowercase hex characters");
  if (!/^[0-9a-f]{64}$/.test(acceptance.quoteHash)) throw new Error("the accepted quote hash must be 64 lowercase hex characters");
  if (!peer.identity) throw new Error(`no catalogue identity from ${peer.hostname} yet`);
  if (peer.status === "unverified" || !catalogIdentityAccepted(peer.nodeId, peer.identity.fingerprint)) {
    throw new Error(
      `${peer.hostname} is first-seen and self-signed (TOFU). Run \`catalog trust <node-id> --fingerprint ` +
        `${peer.identity.fingerprint}\` before requesting or connecting`,
    );
  }
  if (peer.status !== "verified" && peer.status !== "connected") {
    throw new Error(`${peer.hostname} is ${peer.status}; its identity/quote is not acceptable`);
  }
  if (acceptance.fingerprint !== peer.identity.fingerprint) {
    throw new Error(
      `the accepted fingerprint ${acceptance.fingerprint} is not the fingerprint ${peer.hostname} presents ` +
        `(${peer.identity.fingerprint}); re-read the catalogue`,
    );
  }
  if (!peer.quoteHash || acceptance.quoteHash !== peer.quoteHash) {
    throw new Error(
      `the accepted quote hash ${acceptance.quoteHash} is not the current quote from ${peer.hostname} ` +
        `(${peer.quoteHash ?? "none"}); re-read the catalogue and accept it again`,
    );
  }
}

/** Checks whose failure blocks serving; provider-only failures degrade instead. */
function isCriticalCheck(name: string): boolean {
  return (
    name === "configured" ||
    name === "core-running" ||
    name === "acl" ||
    name === "sharing-suspended" ||
    name === "gateway-key-required" ||
    name === "mapped-cidr" ||
    name === "published-gateway" ||
    name === "shared-models-native-only" ||
    name === "catalog-published" ||
    name === "catalog-forward-port" ||
    name === "catalog-quote" ||
    name === "catalog-identity" ||
    name === "catalog-socks5-loopback" ||
    name === "forwards-match" ||
    name === "forwards-owned" ||
    name === "no-orphan-forwards"
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

