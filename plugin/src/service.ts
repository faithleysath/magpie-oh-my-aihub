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

import { lanIPv4 } from "./paths.ts";
import { logger, registerSecret, writePageStatus } from "./log.ts";
import { gatewayBaseURL, type CatalogModelMeta, type LimitStatus, type Magpie } from "./magpie.ts";
import { Provisioner, type ConsumerView } from "./provisioner.ts";
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
  CATALOG_MAX_MODELS,
  CATALOG_PATH,
  CatalogServer,
  canonicalJson,
  classifyPeers,
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
  type ProviderView,
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
  catalogServer: (opts: { hostname: string; port: number; document: () => SignedCatalog | null }) => CatalogServerHandle;
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
  consumers: ConsumerView[];
  providers: ProviderView[];
  catalog: CatalogStatus;
  /** the phase-3 field, kept for older clients: the first provider, or null */
  wiring: { id: string; mappedCidr: string; url: string; createdAt: string } | null;
  checks: { name: string; ok: boolean; detail: string }[];
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
  private catalogServer: CatalogServerHandle | null = null;
  private catalogServerError: string | null = null;
  private catalogQuote: SignedCatalog | null = null;
  private catalogQuoteHash: string | null = null;
  private catalogQuoteVersion = 0;
  private catalogQuoteUpdatedAt: string | null = null;
  private catalogPeers: CatalogPeerView[] = [];
  private catalogLastRefreshAt: string | null = null;
  private catalogRefreshing = false;
  private catalogError: string | null = null;
  private catalogNextQuoteAt = 0;
  private catalogNextRefreshAt = 0;

  constructor(private deps: ServiceDeps) {
    this.state = loadState().state;
    this.probes = { ...defaultProbes(deps.magpie), ...(deps.probes ?? {}) };
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
      });
    this.provisioner = new Provisioner(deps.magpie, {
      validateModels: (models) => this.assertShareable(models),
    });
  }

  config(): PluginConfig | null {
    return this.state.config;
  }

  providers(): ProviderView[] {
    return this.state.providers.map(providerView);
  }

  provider(id: string): ProviderConnection | undefined {
    return this.state.providers.find((p) => p.id === id);
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

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    const cfg = this.state.config;
    if (cfg) {
      // A legacy document may carry Secure Mode without a keypair (the field was
      // optional); generate and persist one instead of refusing to start.
      if (cfg.secureMode && !cfg.secureIdentity) {
        cfg.secureIdentity = generateSecureIdentity();
        saveState(this.state);
        logger.info("generated the Secure Mode identity this node was missing");
      }
      try {
        await this.supervisor.start(this.etConfig(cfg));
      } catch (e) {
        this.lastProblem = String(e);
        logger.error(`supervisor did not start: ${String(e)}`);
      }
    }
    // A core that just started has no leftover forwards: the generated config
    // is the whole set. Anything recorded as orphan is gone with it.
    if (this.state.orphanForwards.length) {
      this.state.orphanForwards = [];
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
    this.ticking = setInterval(() => {
      void this.tick();
    }, 15_000);
    // Do not make boot wait for peers: the directory fills in the background.
    void this.catalogTick();
    this.writeSnapshot();
  }

  private async tick(): Promise<void> {
    try {
      await this.supervisor.refresh();
    } catch {
      /* the supervisor reports its own state */
    }
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
    this.stopCatalogServer();
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
  }): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const prev = this.state.config;
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
      const rpcPort = input.rpcPort ?? prev?.rpcPort ?? (await freeRpcPort());

      const virtualIpv4 = input.virtualIpv4 ? normalizeVirtualIp(input.virtualIpv4) : (prev?.virtualIpv4 ?? randomVirtualIp("10.77.0.0/24"));
      const overlayCidr = "10.77.0.0/24";
      const mappedCidr = prev?.mappedCidr ?? (sharingEnabled ? randomMappedCidr() : null);
      const proxyCidr = sharingEnabled ? (this.lanIp() ? `${this.lanIp()}/32` : null) : (prev?.proxyCidr ?? null);
      if (sharingEnabled && !proxyCidr) {
        throw new Error("no usable LAN address to export; connect this machine to a network first");
      }

      const secureIdentity = secureMode ? (prev?.secureIdentity ?? generateSecureIdentity()) : null;
      const share = input.shareModels ? { models: normalizeShareModels(input.shareModels) } : (prev?.share ?? { models: ["*"] });
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
        throw new Error("publishing a catalogue requires sharing this node's Magpie; enable sharing first");
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
      };
      this.state.config = cfg;
      registerSecret(networkSecret);
      saveState(this.state);

      await this.applyConfig(cfg);
      await this.applyCatalog();
      // A new configuration can change what is shareable (and a previous
      // suspension may have to be lifted or re-applied).
      if (cfg.sharingEnabled) {
        await this.guardSharedKeys().catch((e) => logger.warn(`share guard after configure: ${String(e)}`));
        this.lastProviderFingerprint = this.providerFingerprint();
        await this.publishCatalogNow().catch((e) => logger.warn(`catalogue rebuild after configure: ${String(e)}`));
      }
      // Turning consumption off must cut the remote providers this node added,
      // and nothing else: a provider the operator made by hand stays.
      if (!consumingEnabled) await this.dropRemoteRegistrations("consumption disabled");
      logger.info(
        `configured ${describeRole(cfg)} on ${networkName}; peers ${peers.join(",") || "none"}`,
      );
      return this.status();
    });
  }

  private async applyConfig(cfg: PluginConfig): Promise<void> {
    await this.supervisor.start(this.etConfig(cfg));
    await this.supervisor.refresh().catch(() => this.supervisor.snapshot());
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
      proxyCidr: cfg.sharingEnabled ? cfg.proxyCidr : null,
      mappedCidr: cfg.sharingEnabled ? cfg.mappedCidr : null,
      publishedPorts: this.publishedPorts(cfg),
      socks5Proxy: cfg.catalog.discoveryEnabled ? `socks5://127.0.0.1:${cfg.catalog.socksPort}` : null,
      portForwards: cfg.consumingEnabled ? this.forwardSpecs() : [],
      secureMode: cfg.secureMode,
      secureIdentity: cfg.secureIdentity,
    };
  }

  /** The Forward ACL's ports: the gateway plus the catalogue only while it is published. */
  private publishedPorts(cfg: PluginConfig): number[] {
    if (!cfg.sharingEnabled) return [];
    const ports = [...cfg.publishedPorts];
    if (this.catalogPublishing()) ports.push(cfg.catalog.port);
    return [...new Set(ports)];
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

  /** Replaces the sharing allow list (native model globs). */
  async setShareModels(models: string[]): Promise<StatusSnapshot> {
    return this.serialize(async () => {
      const cfg = this.state.config;
      if (!cfg) throw new Error("configure this node first");
      cfg.share = { models: normalizeShareModels(models) };
      saveState(this.state);
      await this.guardSharedKeys();
      await this.publishCatalogNow().catch((e) => logger.warn(`catalogue rebuild after share models: ${String(e)}`));
      return this.status();
    });
  }

  // --- read-only catalogue ---------------------------------------------------

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

  async trustCatalogPeer(nodeId: string, fingerprint?: string): Promise<CatalogTrustRecord> {
    const trust = loadCatalogTrust();
    const rec = trust[nodeId];
    if (!rec) throw new Error(`no catalogue identity is known for node ${nodeId}`);
    if (!rec.pending) {
      rec.accepted = true;
      saveCatalogTrust(trust);
      return rec;
    }
    if (fingerprint && fingerprint !== rec.pending.fingerprint) {
      throw new Error(`the seen fingerprint is ${rec.pending.fingerprint}, not ${fingerprint}`);
    }
    rec.publicKey = rec.pending.publicKey;
    rec.fingerprint = rec.pending.fingerprint;
    rec.keyId = rec.pending.keyId;
    rec.overlayHostname = rec.pending.hostname;
    rec.firstSeenAt = new Date().toISOString();
    rec.lastSeenAt = rec.firstSeenAt;
    rec.accepted = true;
    rec.pending = null;
    saveCatalogTrust(trust);
    logger.warn(`accepted a changed catalogue identity for ${nodeId}: ${rec.fingerprint}`);
    await this.refreshCatalogPeers().catch(() => {});
    return rec;
  }

  /** A manual connection request; never creates a key or a paid account. */
  catalogRequest(nodeId: string, models?: string[]): Record<string, unknown> {
    const peer = this.catalogPeers.find((p) => p.identity?.keyId === nodeId || p.nodeId === nodeId || p.hostname === nodeId);
    if (!peer) throw new Error(`no discovered catalogue peer ${nodeId}; refresh the directory first`);
    if (!peer.online) throw new Error(`${peer.hostname} is offline; refresh the directory when it returns`);
    if (peer.status === "identity-changed") {
      throw new Error(`the identity of ${peer.hostname} changed; accept its new fingerprint locally before requesting a connection`);
    }
    if (!peer.quote || !peer.mappedCidr) throw new Error(`no catalogue quote from ${peer.hostname} yet`);
    const available = peer.quote.models.map((m) => m.id);
    const wanted = models && models.length ? models : available;
    const missing = wanted.filter((m) => !available.includes(m));
    if (missing.length) throw new Error(`${peer.hostname} does not offer: ${missing.join(", ")}`);
    const cfg = this.state.config;
    const consumerId = cfg ? `${cfg.nodeId}` : "unknown";
    return {
      schema: "ohmyaihub.connection-request/v1",
      createdAt: new Date().toISOString(),
      consumer: {
        nodeId: cfg?.nodeId ?? null,
        hostname: cfg ? configHostname(cfg) : null,
        virtualIpv4: cfg?.virtualIpv4 ?? null,
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
        identityFingerprint: peer.quote.identity.fingerprint,
        identityStatus: peer.status === "verified" || peer.status === "connected" ? "trusted-on-first-use" : "unverified",
        warning: "A self-signed catalogue proves only that this key signed this quote. It is not a real-world identity, and the quote does not charge anything by itself.",
      },
      models: wanted,
      minTopUpUsd: peer.quote.topUp.minUsd,
      note:
        "Send this to the provider operator out of band. They must approve it and issue a model-scoped, capped Gateway Key; " +
        "this request does not create an account, a key or a charge.",
      providerCommand:
        `ohmyaihub consumers add ${consumerId} ${wanted.join(",")} ${peer.quote.topUp.minUsd}`, // operator runs it on the provider
    };
  }

  /** Adds a provider from a discovered quote using the existing connect path. */
  async catalogConnect(nodeId: string, key: string, opts: { id?: string } = {}): Promise<ProviderView> {
    const peer = this.catalogPeers.find((p) => p.identity?.keyId === nodeId || p.nodeId === nodeId || p.hostname === nodeId);
    if (!peer) throw new Error(`no discovered catalogue peer ${nodeId}; refresh the directory first`);
    if (!peer.online) throw new Error(`${peer.hostname} is offline; refresh the directory when it returns`);
    if (peer.status === "identity-changed") throw new Error("the provider's catalogue identity changed; trust it explicitly before connecting");
    if (!peer.quote || !peer.mappedCidr) throw new Error(`no catalogue quote from ${peer.hostname} yet`);
    const id = opts.id ?? `peer-${peer.quote.node.id.replace(/[^a-z0-9-]/gi, "").slice(0, 20)}`;
    return this.addProvider({
      id: id.toLowerCase(),
      mappedCidr: peer.mappedCidr,
      key,
      providerPort: peer.quote.node.gatewayPort,
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
      return;
    }
    const cfg = this.state.config!;
    const host = this.lanIp();
    if (!host) {
      this.catalogServerError = "no usable LAN address to bind the catalogue";
      this.stopCatalogServer();
      logger.error(this.catalogServerError);
      return;
    }
    try {
      if (!this.catalogServer || this.catalogServer.port !== cfg.catalog.port) {
        this.stopCatalogServer();
        this.catalogServer = this.probes.catalogServer({
          hostname: host,
          port: cfg.catalog.port,
          document: () => this.localCatalog(),
        });
      }
      await this.publishCatalogNow();
      this.catalogServerError = null;
    } catch (e) {
      this.catalogServerError = String((e as Error).message ?? e);
      this.stopCatalogServer();
      logger.error(`the catalogue could not be published: ${this.catalogServerError}`);
      this.writeSnapshot();
    }
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
      note: "Simulated configuration only. No wallet, payment network, deposit or real credit is connected in this phase.",
    };
    const contentHash = sha256Hex(canonicalJson({ schema: "ohmyaihub.catalog/v1", node, models, topUp, identity: identity.summary }));
    const prev = loadPublishState();
    let version = prev.versionNumber;
    let updatedAt = prev.updatedAt ?? now;
    let publishedAt = prev.publishedAt ?? now;
    if (contentHash !== prev.contentHash) {
      version = Math.max(1, prev.versionNumber + 1);
      updatedAt = now;
      publishedAt = prev.publishedAt ?? now;
      savePublishState({ version: 1, publishedAt, versionNumber: version, updatedAt, contentHash });
    } else if (!version) {
      version = 1;
      updatedAt = now;
      publishedAt = prev.publishedAt ?? now;
      savePublishState({ version: 1, publishedAt, versionNumber: version, updatedAt, contentHash });
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
      identity: identity.summary,
    };
    this.catalogQuote = signCatalog(body, identity);
    this.catalogQuoteHash = contentHash;
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
      const now = new Date().toISOString();
      const previousViews: CatalogPeerView[] = [];
      const liveHosts = new Set<string>();
      const candidates: { entry: DirectoryPeer; view: CatalogPeerView }[] = [];

      for (const entry of classified) {
        liveHosts.add(entry.hostname);
        const earlier = prev.get(entry.hostname);
        const connected = this.state.providers.find(
          (p) =>
            (entry.mappedCidr && mappedHost(p.mappedCidr) === mappedHost(entry.mappedCidr)) ||
            (entry.hostname && p.fingerprint?.hostname === entry.hostname),
        );
        const view: CatalogPeerView = {
          ...entry,
          nodeId: earlier?.nodeId ?? null,
          status: entry.conflict
            ? "conflict"
            : entry.route === "self"
              ? "self"
              : connected
                ? "connected"
                : entry.mappedCidr
                  ? "unreachable"
                  : "no-catalog",
          detail: entry.conflict,
          catalogPort: earlier?.catalogPort ?? null,
          identity: earlier?.identity ?? null,
          pendingFingerprint: earlier?.pendingFingerprint ?? null,
          quote: earlier?.quote ?? null,
          quoteHash: earlier?.quoteHash ?? null,
          fetchedAt: earlier?.fetchedAt ?? null,
          connectedProviderId: connected?.id ?? null,
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
      // seen, but never keep probing a peer EasyTier no longer lists.
      for (const [host, old] of prev) {
        if (liveHosts.has(host)) continue;
        const seen = old.fetchedAt ?? old.lastSeenAt;
        if (seen && Date.now() - Date.parse(seen) > 60 * 60_000) continue;
        byHost.set(host, {
          ...old,
          online: false,
          status: "offline",
          detail: "not present in EasyTier's current peer list",
          lastSeenAt: old.lastSeenAt,
        });
      }

      this.catalogPeers = [...byHost.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
      this.catalogLastRefreshAt = now;
      this.catalogNextRefreshAt = Date.now() + Math.max(10, cfg.catalog.refreshSec) * 1000;
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
    const now = new Date().toISOString();
    // The default port is 3426. A host that runs several isolated lab instances
    // (or an operator who changed the port) may publish on the next few; probe a
    // small bounded range only until one answers, then remember that port.
    const candidates = base.catalogPort
      ? [base.catalogPort]
      : [cfg.catalog.port, cfg.catalog.port + 1, cfg.catalog.port + 2, cfg.catalog.port + 3, cfg.catalog.port + 4].filter((p) => p <= 65535);
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
    return {
      ...base,
      status: base.connectedProviderId ? "connected" : "unreachable",
      detail: lastDetail.slice(0, 300),
      catalogPort: base.catalogPort ?? null,
      fetchedAt: now,
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
    let rec = trust[nodeId];
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
      status = rec.accepted ? "verified" : "unverified";
      detail = rec.accepted
        ? "the same Ed25519 key as the one accepted locally"
        : "same key as first seen; accept it locally with catalog trust to stop showing unverified";
    }
    if (rec.pending && status !== "identity-changed") status = "identity-changed";
    rec.lastSeenAt = now;
    rec.quoteVersion = quote.publication.version;
    if (base.connectedProviderId && status !== "identity-changed") status = "connected";
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

  private async connectProvider(input: ProviderInput, opts: { update: boolean }): Promise<ProviderView> {
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

      // 2. the provider. An entry this plugin owns is replaced; a missing one is
      //    added; anything else was refused above. Re-registering an identical
      //    binding is a no-op.
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

      // 3. the consumer must actually see the remote's models through its key
      const remoteModels = await this.probes.remoteModelIds(localPort, input.key, 15_000);
      if (!remoteModels || remoteModels.length === 0) {
        throw new Error(`the provider served no model for that key; is the key allowed a model?`);
      }
      if (!(await this.waitLocalModels(input.id, 15_000))) {
        throw new Error(`magpie did not list any ${input.id}/ model within 15s`);
      }

      // 4. only now commit the connection record
      const now = new Date().toISOString();
      const limit = limitView(await this.probes.remoteLimit(localPort, input.key, 8000));
      const rec: ProviderConnection = {
        id: input.id,
        remoteMagpieId: input.id,
        mappedCidr,
        providerPort,
        localPort,
        keyRef: providerKeyRef(input.id),
        fingerprint: owner ? { hostname: owner.hostname, virtualIpv4: owner.ipv4, peerId: owner.peerId } : null,
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
      this.supervisor.setForwards(this.forwardSpecs());
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
      if (addedForward && !this.state.providers.some((p) => p.localPort === localPort)) {
        await this.recordOrphanForward(localPort, dst);
      }
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

  /**
   * Re-checks every remote provider independently. A provider that is down or
   * changed does not disturb the others: each one gets its own status, and the
   * loop below never lets one failure escape.
   */
  async reconcileProviders(opts: { quiet?: boolean; verifyModels?: boolean } = {}): Promise<ProviderView[]> {
    this.lastReconcileAt = Date.now();
    const cfg = this.state.config;
    if (!cfg) return [];
    if (!cfg.consumingEnabled) {
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
    if (cfg.sharingEnabled) {
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

    const bind = `127.0.0.1:${conn.localPort}`;
    const dst = `${mappedHost(conn.mappedCidr)}:${conn.providerPort}`;
    if (forwards && !forwards.some((f) => f.bindAddr === bind && f.dstAddr === dst)) {
      try {
        await this.supervisor.addPortForward(bind, dst);
        this.supervisor.setForwards(this.forwardSpecs());
      } catch (e) {
        conn.status = "degraded";
        conn.detail = `cannot restore the loopback forward: ${(e as Error).message}`.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        return true;
      }
    }

    const ownership = this.ownershipOf(conn.id, conn.localPort, key);
    if (ownership === "foreign") {
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
    if (ownership === "absent") {
      try {
        await this.deps.magpie.addRemoteProvider({ id: conn.id, url: `http://127.0.0.1:${conn.localPort}`, key });
        changed = true;
      } catch (e) {
        conn.status = "degraded";
        conn.detail = `cannot register the Remote Magpie: ${(e as Error).message}`.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        return true;
      }
    }

    const keyed = await this.probes.statusWith("127.0.0.1", conn.localPort, 200, key);
    if (!keyed) {
      conn.status = "degraded";
      conn.detail = "the provider does not answer with this Gateway Key (offline, revoked or a different provider)";
      conn.updatedAt = new Date().toISOString();
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
        conn.updatedAt = new Date().toISOString();
        return true;
      }
      if (!(await this.waitLocalModels(conn.id, 5_000))) {
        conn.status = "degraded";
        conn.detail = `magpie does not list any ${conn.id}/ model`;
        conn.updatedAt = new Date().toISOString();
        return true;
      }
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
    const held = this.deps.magpie.keyById(rec.keyId);
    if (!held) throw new Error(`the key of ${consumerId} is no longer in Magpie; recreate it`);
    let models = Array.isArray(held.models) ? held.models.map(String) : [];
    if (models.length === 0) {
      // An empty whitelist means "every model" in Magpie: rewrite it from the
      // record (which the guard has just checked) before handing anything over.
      await this.provisioner.setModels(consumerId, rec.models);
      models = this.deps.magpie.keyById(rec.keyId)?.models?.map(String) ?? [];
    }
    if (models.length === 0) {
      throw new Error(`the key of ${consumerId} has no model whitelist in Magpie; refusing to hand it over`);
    }
    this.assertShareable(models);
    logger.info(`handing key ${rec.keyName} over for ${consumerId} (${models.join(", ")})`);
    return { consumerId, keyName: rec.keyName, key: rec.secret, models, capUsd: rec.capUsd };
  }

  async topUp(consumerId: string, usd: number, depositId?: string): Promise<ConsumerView> {
    return this.provisioner.topUp(consumerId, usd, depositId);
  }

  async ensureConsumer(consumerId: string, models: string[], capUsd: number): Promise<ConsumerView> {
    this.assertShareable(models);
    const v = await this.provisioner.ensure(consumerId, { models, capUsd });
    if (!this.state.consumers.includes(consumerId)) this.state.consumers.push(consumerId);
    saveState(this.state);
    return v;
  }

  async revokeConsumer(consumerId: string): Promise<ConsumerView> {
    return this.provisioner.revoke(consumerId);
  }

  // --- checks ----------------------------------------------------------------

  /** The checks that decide whether this node may serve or consume at all. */
  async checks(): Promise<{ name: string; ok: boolean; detail: string }[]> {
    const out: { name: string; ok: boolean; detail: string }[] = [];
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
      out.push({
        name: "catalog-peers",
        ok: changed === 0,
        detail:
          `${cat.peers.filter((p) => p.online && p.status !== "self").length} online, ` +
          `${cat.peers.filter((p) => p.status === "offline").length} offline` +
          (changed ? `, ${changed} with a changed identity awaiting local acceptance` : "") +
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
        const expected = new Set(this.forwardSpecs().map((f) => `${f.bindAddr}->${f.dstAddr}`));
        const unexpected = running.filter((f) => !expected.has(`${f.bindAddr}->${f.dstAddr}`));
        out.push({
          name: "forwards-match",
          ok: unexpected.length === 0,
          detail: unexpected.length
            ? `loopback listeners no provider uses: ${unexpected.map((f) => `${f.bindAddr} -> ${f.dstAddr}`).join(", ")}`
            : `${expected.size} loopback forward(s), all owned by a provider`,
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
    const checks = await this.checks().catch(() => [] as { name: string; ok: boolean; detail: string }[]);
    const snap: StatusSnapshot = {
      ...this.lightStatus(),
      consumers: await this.provisioner.refreshAll(),
      checks,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  private lastSnapshot: StatusSnapshot | null = null;

  /** The snapshot without the (network) checks, for the page file. */
  private lightStatus(): StatusSnapshot {
    const et = this.supervisor.snapshot();
    const cfg = this.state.config;
    return {
      plugin: { version: "0.3.0", pid: process.pid, dataDir: process.cwd(), startedAt: this.startedAt, stateVersion: this.state.version },
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
      consumers: this.provisioner.all(),
      providers: this.providers(),
      catalog: this.catalogStatus(),
      wiring: this.state.providers[0]
        ? {
            id: this.state.providers[0].id,
            mappedCidr: this.state.providers[0].mappedCidr,
            url: `http://127.0.0.1:${this.state.providers[0].localPort}`,
            createdAt: this.state.providers[0].createdAt,
          }
        : null,
      checks: [],
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
    for (let port = FORWARD_PORT_FROM; port <= FORWARD_PORT_TO; port++) {
      if (used.has(port)) continue;
      if (await portInUse(port)) continue;
      return port;
    }
    throw new Error(`no free loopback port in ${FORWARD_PORT_FROM}-${FORWARD_PORT_TO}`);
  }

  /**
   * Whether the Magpie entry with this id is the one this plugin wrote. This is
   * the only ownership record: the connection's loopback port and the Gateway
   * Key in the key store are what the plugin put there. A native provider, a
   * different Remote Magpie, or an entry edited by hand does not match.
   */
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
  if (cleaned.length === 0) return ["*"];
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

async function freeRpcPort(): Promise<number> {
  for (let port = 17888; port < 17960; port++) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error("no free RPC port in 17888-17959");
}

async function portInUse(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, close() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

function safeLanIp(): string | null {
  try {
    return lanIPv4();
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

