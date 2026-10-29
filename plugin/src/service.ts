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
import { gatewayBaseURL, type Magpie } from "./magpie.ts";
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
  FORWARD_PORT_FROM,
  FORWARD_PORT_TO,
  deleteProviderKey,
  getProviderKey,
  loadState,
  newNodeId,
  newInstanceId,
  providerKeyRef,
  providerView,
  saveState,
  setProviderKey,
  type PluginConfig,
  type PluginState,
  type ProviderConnection,
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
}

export interface ServiceDeps {
  magpie: Magpie;
  magpieVersion: string;
  supervisor?: SupervisorLike;
  probes?: Partial<Probes>;
  /** the LAN address the provider exports; injected in tests */
  lanIp?: () => string | null;
}

export interface StatusSnapshot {
  plugin: { version: string; pid: number; dataDir: string; startedAt: string; stateVersion: number };
  magpie: { version: string; gateway: string };
  config: {
    role: Role | null;
    sharingEnabled: boolean;
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
  };
  easytier: SupervisorState;
  consumers: ConsumerView[];
  providers: ProviderView[];
  /** the phase-3 field, kept for older clients: the first provider, or null */
  wiring: { id: string; mappedCidr: string; url: string; createdAt: string } | null;
  checks: { name: string; ok: boolean; detail: string }[];
  logs: string[];
}

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
  private opQueue: Promise<unknown> = Promise.resolve();
  private connectionsBusy = new Set<string>();
  private mutating = 0;
  private lastReconcileAt = 0;

  constructor(private deps: ServiceDeps) {
    this.state = loadState().state;
    this.probes = { ...defaultProbes(deps.magpie), ...(deps.probes ?? {}) };
    this.lanIp = deps.lanIp ?? (() => safeLanIp());
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
    await this.reconcileProviders({ quiet: true, verifyModels: true }).catch((e) =>
      logger.warn(`reconcile after start failed: ${String(e)}`),
    );
    this.ticking = setInterval(() => {
      void this.tick();
    }, 15_000);
    this.writeSnapshot();
  }

  private async tick(): Promise<void> {
    try {
      await this.supervisor.refresh();
    } catch {
      /* the supervisor reports its own state */
    }
    if (this.busy()) return;
    if (Date.now() - this.lastReconcileAt < 45_000) return;
    await this.reconcileProviders({ quiet: true }).catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.ticking) clearInterval(this.ticking);
    this.ticking = null;
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
      };
      this.state.config = cfg;
      registerSecret(networkSecret);
      saveState(this.state);

      await this.applyConfig(cfg);
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
      sharingEnabled: cfg.sharingEnabled,
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
      publishedPorts: cfg.sharingEnabled ? cfg.publishedPorts : [],
      portForwards: cfg.consumingEnabled ? this.forwardSpecs() : [],
      secureMode: cfg.secureMode,
      secureIdentity: cfg.secureIdentity,
    };
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
      if (enabled) await this.reconcileProviders({ quiet: true }).catch(() => {});
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
      return this.status();
    });
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
          localPort: patch.localPort ?? existing.localPort,
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

    const localPort = input.localPort ?? (opts.update && existing ? existing.localPort : await this.allocLocalPort());
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("localPort must be a TCP port");
    if (this.state.providers.some((p) => p.id !== input.id && p.localPort === localPort)) {
      throw new Error(`127.0.0.1:${localPort} is already the forward port of another provider`);
    }

    const want = mappedHost(mappedCidr);
    const dst = `${want}:${providerPort}`;
    const bind = `127.0.0.1:${localPort}`;

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
    const prevKey = existing ? getProviderKey(existing.id) : null;
    this.connectionsBusy.add(input.id);
    let addedForward = false;
    let registered: "unchanged" | "added" | "replaced" | null = null;
    try {
      // 1. the overlay path first; nothing in Magpie changes yet
      addedForward = await this.supervisor.addPortForward(bind, dst);
      if (!(await this.probes.statusWith("127.0.0.1", localPort, 401))) {
        throw new Error(
          `127.0.0.1:${localPort} did not answer 401 without a key: ` +
            `the provider must be online, on the same network, and its mapped address reachable`,
        );
      }
      // A keyless 401 could also come from something that refuses everything.
      // A wrong key must also be refused, which proves a Gateway Key is actually
      // checked at the other end rather than a local, trusted caller.
      const wrong = `sk-ohmyaihub-probe-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      if (!(await this.probes.statusWith("127.0.0.1", localPort, 401, wrong))) {
        throw new Error(`127.0.0.1:${localPort} did not refuse a wrong key; refusing to trust this endpoint`);
      }

      // 2. the provider. The same id is replaced; a different id is added.
      registered = await this.deps.magpie.ensureRemoteProvider({ id: input.id, url: `http://127.0.0.1:${localPort}`, key: input.key });

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
        // The old listener cannot be closed live in 2.6.4; it is no longer in the
        // generated config, so the next core start drops it. Record it meanwhile.
        await this.recordOrphanForward(prev.localPort, `${mappedHost(prev.mappedCidr)}:${prev.providerPort}`);
      }
      await this.guardSharedKeys().catch((e) => logger.warn(`share guard: ${String(e)}`));
      logger.info(`connected provider ${input.id} at ${bind} -> ${dst} (${registered})`);
      return providerView(rec);
    } catch (e) {
      // Roll back exactly what this call changed. The previous registration of
      // the same id is restored with its key; other providers are untouched.
      if (registered === "added" || registered === "replaced") {
        await this.deps.magpie.removeProvider(input.id).catch(() => {});
        if (prev && prevKey) {
          await this.deps.magpie
            .ensureRemoteProvider({ id: prev.id, url: `http://127.0.0.1:${prev.localPort}`, key: prevKey })
            .catch((err) => logger.error(`could not restore provider ${prev.id}: ${String(err)}`));
        }
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
      await this.deps.magpie.removeProvider(id);
      deleteProviderKey(id);
      this.state.providers = this.state.providers.filter((p) => p.id !== id);
      saveState(this.state);
      // 2.6.4 cannot close a forward at runtime: restart with the new config so
      // no listener is left pointing at a provider that is no longer used.
      const cfg = this.state.config;
      if (cfg) await this.applyConfig(cfg);
      await this.reconcileProviders({ quiet: true }).catch((e) => logger.warn(`reconcile after removal: ${String(e)}`));
      logger.info(`removed remote provider ${id}; its loopback port ${rec.localPort} is gone`);
      return providerView({ ...rec, status: "disabled", detail: "removed" });
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
      await this.deps.magpie.removeProvider(conn.id).catch(() => {});
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
      await this.deps.magpie.removeProvider(conn.id).catch(() => {});
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

    const registered = await this.deps.magpie
      .ensureRemoteProvider({ id: conn.id, url: `http://127.0.0.1:${conn.localPort}`, key })
      .catch((e) => {
        conn.status = "degraded";
        conn.detail = `cannot register the Remote Magpie: ${(e as Error).message}`.slice(0, 300);
        conn.updatedAt = new Date().toISOString();
        return null;
      });
    if (registered === null) return true;
    if (registered !== "unchanged") changed = true;

    const keyed = await this.probes.statusWith("127.0.0.1", conn.localPort, 200, key);
    if (!keyed) {
      conn.status = "degraded";
      conn.detail = "the provider does not answer with this Gateway Key (offline, revoked or a different provider)";
      conn.updatedAt = new Date().toISOString();
      return true;
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
      const existing = this.deps.magpie.providerById(p.id);
      if (existing && existing.preset === "remote-magpie") {
        await this.deps.magpie.removeProvider(p.id).catch((e) => logger.warn(`cannot unregister ${p.id}: ${String(e)}`));
      }
    }
    if (this.state.providers.length) logger.info(`unregistered ${this.state.providers.length} remote provider(s): ${reason}`);
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
  async guardSharedKeys(): Promise<{ narrowed: string[]; revoked: string[] }> {
    const narrowed: string[] = [];
    const revoked: string[] = [];
    const cfg = this.state.config;
    if (!cfg) return { narrowed, revoked };
    if (!this.deps.magpie.providersReadable()) {
      logger.warn("cannot read Magpie's provider list; leaving every issued key as it is");
      return { narrowed, revoked };
    }
    const native = this.deps.magpie.nativeProviderIds();
    const remote = this.deps.magpie.remoteProviderIds();
    for (const c of this.provisioner.all()) {
      if (c.revokedAt) continue;
      const allowed = c.models.filter((m) => {
        const provider = m.split("/")[0];
        return !remote.has(provider) && native.has(provider) && allowedByPolicy(m, cfg.share);
      });
      if (allowed.length === c.models.length) continue;
      if (allowed.length === 0) {
        await this.provisioner.revoke(c.consumerId);
        revoked.push(c.consumerId);
        logger.error(`revoked ${c.consumerId}: none of its models may be shared any more (${c.models.join(", ")})`);
        continue;
      }
      await this.provisioner.setModels(c.consumerId, allowed);
      narrowed.push(c.consumerId);
      logger.warn(`narrowed ${c.consumerId} to ${allowed.join(", ")}: the rest may not be shared`);
    }
    return { narrowed, revoked };
  }

  // --- consumers -------------------------------------------------------------

  /** The provider operator hands a consumer key over; never logged. */
  async handover(
    consumerId: string,
  ): Promise<{ consumerId: string; keyName: string; key: string; models: string[]; capUsd: number }> {
    const rec = this.provisioner.find(consumerId);
    if (!rec || rec.revokedAt) throw new Error(`no active consumer ${consumerId}`);
    if (!rec.secret) throw new Error(`the key of ${consumerId} is not in this Magpie any more; recreate it`);
    // A key is handed over only when Magpie really holds it with its whitelist
    // and cap: the read-back is the gate, not the local record.
    await this.provisioner.status(consumerId);
    await this.guardSharedKeys();
    logger.info(`handing key ${rec.keyName} over for ${consumerId}`);
    return { consumerId, keyName: rec.keyName, key: rec.secret, models: [...rec.models], capUsd: rec.capUsd };
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
        out.push({
          name: `provider:${p.id}:registered`,
          ok: this.deps.magpie.providerById(p.id)?.preset === "remote-magpie",
          detail: `Remote Magpie "${p.id}" ${this.deps.magpie.providerById(p.id) ? "is" : "is not"} registered in Magpie`,
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
      plugin: { version: "0.2.0", pid: process.pid, dataDir: process.cwd(), startedAt: this.startedAt, stateVersion: this.state.version },
      magpie: { version: this.deps.magpieVersion, gateway: gatewayBaseURL() },
      config: {
        role: cfg ? (cfg.sharingEnabled ? "provider" : "consumer") : null,
        sharingEnabled: cfg?.sharingEnabled ?? false,
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
      },
      easytier: et,
      consumers: this.provisioner.all(),
      providers: this.providers(),
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

