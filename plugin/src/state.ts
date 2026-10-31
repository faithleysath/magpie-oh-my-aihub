// The plugin's persisted state: one node, any combination of the two roles.
//
// Phase 3 stored a single `role` ("provider" or "consumer") and at most one
// consumer-side wiring. A node that both shares its Magpie and uses two remote
// Magpies is now the normal case, so the document is versioned and holds:
//
//   config    — this node's overlay and its sharing policy
//   consumers — ids of the Gateway Keys this node issued (the keys themselves
//               stay in consumers.json, owned by the provisioner)
//   providers — one record per remote provider this node consumes, each with
//               its own loopback port, Gateway Key reference and status
//
// Migration from the phase-3 document is explicit and backed up before a byte
// changes: a `provider` becomes `sharingEnabled`, a `consumer` (or a node that
// has a `providerWiring`) becomes `consumingEnabled`, and the old wiring becomes
// the first provider record with its Gateway Key moved out of `state.json` into
// a separate 0600 key store that the record only *references*.

import { existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { stateDir, statePath } from "./paths.ts";
import { backupFile, readJsonWithBackup, writeJsonAtomic } from "./store.ts";
import { logger, registerSecret } from "./log.ts";
import { randomMappedCidr } from "./addresses.ts";
import { emptyPortLedger, normalizePortLedger, type PortLedger } from "./ports.ts";

export const STATE_VERSION = 4;

/** The overlay's forward-port range; one port per remote provider. */
export const FORWARD_PORT_FROM = 13425;
export const FORWARD_PORT_TO = 13499;

/** The read-only catalog's fixed default port. It is opt-in and never the gateway. */
export const CATALOG_PORT = 3426;
/** Loopback ports EasyTier's SOCKS5 listener may use for on-demand catalog reads. */
export const CATALOG_SOCKS_FROM = 13400;
export const CATALOG_SOCKS_TO = 13424;
/** How often a peer catalogue is re-read, in seconds. */
export const CATALOG_REFRESH_SEC = 20;

export interface SecureIdentity {
  privateKey: string;
  publicKey: string;
}

/**
 * What this node is willing to share. Only *native* models can ever be in it:
 * a model this node merely consumes from another peer is refused when a key is
 * issued, so a shared key can never resell somebody else's channel.
 */
export interface SharePolicy {
  /** globs over native model ids (`provider/model`, `provider/*`); ["*"] is all */
  models: string[];
}

/**
 * The opt-in read-only catalogue a node may publish, and the opt-in discovery
 * that reads other nodes' catalogues. Neither is a gateway and neither carries
 * an AI request; see docs/ARCHITECTURE.md, Decision 13 onwards.
 */
export interface CatalogConfig {
  /** publish this node's shareable native models and quotes */
  enabled: boolean;
  /** read peers' catalogues through the local EasyTier SOCKS5 listener */
  discoveryEnabled: boolean;
  /** human label shown in the catalogue; null means the overlay hostname */
  displayName: string | null;
  /** optional manual contact text, never an address the plugin dials */
  contact: string | null;
  /** local catalogue port, and the port discovery probes by default */
  port: number;
  /** loopback SOCKS5 listener EasyTier opens for on-demand catalogue reads */
  socksPort: number;
  /** seconds between peer catalogue refreshes (10-300) */
  refreshSec: number;
  /** simulated minimum top-up, for display only; never charged here */
  minTopUpUsd: number;
}

export interface PluginConfig {
  /** publish this node's Magpie on the overlay */
  sharingEnabled: boolean;
  /** allow this node to use remote providers */
  consumingEnabled: boolean;
  /** stable per-node id, also this node's EasyTier hostname suffix */
  nodeId: string;
  /** stable EasyTier instance id (peer_id itself changes on every restart) */
  instanceId: string;
  networkName: string;
  networkSecret: string;
  peers: string[];
  listenAddr: string | null;
  virtualIpv4: string;
  overlayCidr: string;
  rpcPort: number;
  /** export address (the node's own LAN address) while sharing */
  proxyCidr: string | null;
  /** stable overlay address consumers dial while sharing */
  mappedCidr: string | null;
  publishedPorts: number[];
  secureMode: boolean;
  secureIdentity: SecureIdentity | null;
  share: SharePolicy;
  catalog: CatalogConfig;
  /**
   * Reserved for the Phase 10 B control listener: every joined node may receive
   * structured requests, not only a node that shares models. The A-service branch
   * owns the port mechanism; the B service owns the listener itself. Leaving it
   * true changes nothing until that service exists.
   */
  controlEnabled: boolean;
  /** the control listener's port; null until it is allocated (never user-entered) */
  controlPort: number | null;
}

export type ConnectionStatus = "connected" | "degraded" | "disabled" | "identity-mismatch";

/** How long a real model read-back can be trusted without a fresh read. */
export const MODELS_EVIDENCE_TTL_MS = 5 * 60_000;

/**
 * Real evidence of what one Remote Magpie served for this provider's Gateway
 * Key. This is deliberately separate from the sharing authorization list: only
 * a successful read-back with the current key/identity makes models "callable".
 */
export interface ProviderModelsEvidence {
  status: "current" | "stale" | "unknown";
  source: "connect-readback" | "provider-models" | "reconcile";
  readAt: string | null;
  expiresAt: string | null;
  models: string[];
  modelCount: number | null;
  callable: "yes" | "no" | "unknown";
  identity: { hostname: string | null; virtualIpv4: string | null; fingerprint: string | null } | null;
  /** monotonic per provider; increases only on a successful real read */
  generation: number;
  keyRef: string;
  keyGeneration: number;
  error: string | null;
}

export function unknownModelsEvidence(keyRef: string, keyGeneration = 1): ProviderModelsEvidence {
  return {
    status: "unknown",
    source: "connect-readback",
    readAt: null,
    expiresAt: null,
    models: [],
    modelCount: null,
    callable: "unknown",
    identity: null,
    generation: 0,
    keyRef,
    keyGeneration,
    error: null,
  };
}

function identityMatches(
  a: ProviderModelsEvidence["identity"],
  b: ProviderConnection["fingerprint"],
  acceptedA: string | null,
  acceptedB: string | null,
): boolean {
  if (a === null && b === null) return true;
  if (!a || !b) return false;
  if (acceptedA && acceptedB && acceptedA !== acceptedB) return false;
  return (a.hostname ?? "") === (b.hostname ?? "") && (a.virtualIpv4 ?? "") === (b.virtualIpv4 ?? "");
}

function normalizeModelsEvidence(
  raw: ProviderModelsEvidence | null | undefined,
  keyRef: string,
  keyGeneration: number,
): ProviderModelsEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const status = raw.status === "current" || raw.status === "stale" ? raw.status : "unknown";
  const source =
    raw.source === "provider-models" || raw.source === "reconcile" ? raw.source : "connect-readback";
  const callable = raw.callable === "yes" || raw.callable === "no" ? raw.callable : "unknown";
  return {
    status,
    source,
    readAt: typeof raw.readAt === "string" ? raw.readAt : null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    models: Array.isArray(raw.models) ? raw.models.map(String) : [],
    modelCount: Number.isInteger(raw.modelCount) ? raw.modelCount : null,
    callable,
    identity:
      raw.identity && typeof raw.identity === "object"
        ? {
            hostname: typeof raw.identity.hostname === "string" ? raw.identity.hostname : null,
            virtualIpv4: typeof raw.identity.virtualIpv4 === "string" ? raw.identity.virtualIpv4 : null,
            fingerprint: typeof raw.identity.fingerprint === "string" ? raw.identity.fingerprint : null,
          }
        : null,
    generation: Number.isInteger(raw.generation) && raw.generation >= 0 ? raw.generation : 0,
    keyRef: typeof raw.keyRef === "string" && raw.keyRef ? raw.keyRef : keyRef,
    keyGeneration: Number.isInteger(raw.keyGeneration) && raw.keyGeneration > 0 ? raw.keyGeneration : keyGeneration,
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

/**
 * Projects stored evidence to the console. It never probes; a later poll only
 * decides whether the stored proof is still valid.
 */
export function projectModelsEvidence(p: ProviderConnection, now = Date.now()): ProviderModelsEvidence {
  const stored = p.modelsEvidence ?? null;
  const keyGeneration = Number.isInteger(p.keyGeneration) && (p.keyGeneration ?? 0) > 0 ? p.keyGeneration! : 1;
  if (!stored) return unknownModelsEvidence(p.keyRef, keyGeneration);
  const currentKey = stored.keyGeneration === keyGeneration;
  const currentIdentity = identityMatches(stored.identity, p.fingerprint, stored.identity?.fingerprint ?? null, p.acceptedFingerprint ?? null);
  const currentKeyRef = stored.keyRef === p.keyRef;
  const readAtMs = stored.readAt ? Date.parse(stored.readAt) : Number.NaN;
  const expiresMs = stored.expiresAt ? Date.parse(stored.expiresAt) : Number.NaN;
  const invalidReadAt = !Number.isFinite(readAtMs);
  const futureReadAt = Number.isFinite(readAtMs) && readAtMs > now + 60_000;
  const invalidExpiry = !Number.isFinite(expiresMs) || (Number.isFinite(readAtMs) && expiresMs < readAtMs);
  const ttlTooLong =
    Number.isFinite(readAtMs) && Number.isFinite(expiresMs) && expiresMs - readAtMs > MODELS_EVIDENCE_TTL_MS;
  const expired = Number.isFinite(expiresMs) && now > expiresMs;
  const notServing = p.status !== "connected";
  const status: ProviderModelsEvidence["status"] =
    !currentKeyRef
      ? "unknown"
      : stored.status === "unknown" ||
          !currentKey ||
          !currentIdentity ||
          invalidReadAt ||
          futureReadAt ||
          invalidExpiry ||
          ttlTooLong ||
          expired ||
          notServing
        ? "stale"
        : stored.status;
  const current = status === "current";
  const callable: ProviderModelsEvidence["callable"] = current
    ? stored.models.length > 0
      ? "yes"
      : "no"
    : stored.callable === "no" && stored.error !== null
      ? "no"
      : "unknown";
  return {
    ...stored,
    status,
    modelCount: current ? stored.models.length : null,
    callable,
    error:
      status === "stale" && stored.error === null
        ? expired
          ? "the model read-back expired; read it again"
          : futureReadAt
            ? "the model read-back time is in the future; read it again"
            : invalidReadAt || invalidExpiry
              ? "the model read-back timestamps are invalid; read it again"
              : !currentKey
                ? "the Gateway Key changed; read the models again"
                : !currentIdentity
                  ? "the provider identity changed; read the models again"
                  : ttlTooLong
                    ? "the model read-back TTL is longer than allowed; read it again"
                    : "the provider is not serving"
        : !currentKeyRef
          ? "the model read-back belongs to a different key reference; read it again"
          : ttlTooLong
            ? "the model read-back TTL is longer than allowed; read it again"
            : stored.error,
  };
}

/** What the overlay said about the peer that owned a mapped prefix. */
export interface PeerFingerprint {
  hostname: string;
  virtualIpv4: string;
  /** session-scoped: EasyTier assigns a new peer_id on every start */
  peerId: string | null;
}

/** The provider's own Gateway Key numbers, as its gateway reports them. */
export interface ProviderLimitView {
  period?: string;
  calls?: number;
  cost?: number;
  costLimit?: number;
  costLeft?: number;
  tokens?: number;
  spent?: boolean;
  reset?: string;
}

export interface ProviderConnection {
  /** local id: the key of this record in the state and the key store */
  id: string;
  /**
   * the Remote Magpie provider id in this node's Magpie. Phase 4 keeps it equal
   * to `id` (one stable handle for CLI, API and Magpie), but it is stored
   * separately because Magpie's namespace and ours need not stay the same.
   */
  remoteMagpieId: string;
  mappedCidr: string;
  /** the port the provider publishes its gateway on */
  providerPort: number;
  /** the loopback port this node's EasyTier forwards */
  localPort: number;
  /** reference into the key store, never the key itself */
  keyRef: string;
  fingerprint: PeerFingerprint | null;
  /** models verified at connect time; [] = none recorded (never an authorization claim) */
  models: string[];
  /**
   * A forward move that was persisted before the core/Magpie were touched. It
   * lets a crash between the restart/registration and the state commit recover
   * the plugin's own URL without mistaking an edited entry for ours. Cleared on
   * success or rollback.
   */
  forwardPending?: { from: number; to: number; at: string } | null;
  /** increments when the stored Gateway Key changes */
  keyGeneration?: number;
  /** the exact catalogue fingerprint the operator accepted, when there was one */
  acceptedFingerprint?: string | null;
  /** the latest real read-back, never the authorization allow list */
  modelsEvidence?: ProviderModelsEvidence | null;
  status: ConnectionStatus;
  detail: string | null;
  limit: ProviderLimitView | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export interface OrphanForward {
  localPort: number;
  dstAddr: string;
  since: string;
}

export interface ShareSuspension {
  at: string;
  reason: string;
}

export interface PluginState {
  version: number;
  config: PluginConfig | null;
  consumers: string[];
  providers: ProviderConnection[];
  /** loopback forwards left behind by an EasyTier that cannot remove them live */
  orphanForwards: OrphanForward[];
  /**
   * Set while sharing is withdrawn because the native/remote split cannot be
   * proven (Magpie's provider list is unreadable). The operator's intent
   * (`config.sharingEnabled`) is kept; the export is not.
   */
  shareSuspended: ShareSuspension | null;
  /** automatic port claims: what was migrated and when each port was last proven */
  ports: PortLedger;
}

/** The shape phase 3 wrote; read only, never written. */
interface LegacyConfig {
  role?: "provider" | "consumer";
  nodeId?: string;
  instanceId?: string;
  networkName?: string;
  networkSecret?: string;
  peers?: string[];
  listenAddr?: string | null;
  virtualIpv4?: string;
  overlayCidr?: string;
  rpcPort?: number;
  mappedCidr?: string | null;
  proxyCidr?: string | null;
  publishedPorts?: number[];
  secureMode?: boolean;
  secureIdentity?: SecureIdentity | null;
  share?: SharePolicy;
  catalog?: Partial<CatalogConfig>;
  controlEnabled?: boolean;
  controlPort?: number | null;
  sharingEnabled?: boolean;
  consumingEnabled?: boolean;
}

interface LegacyWiring {
  id: string;
  mappedCidr: string;
  providerPort?: number;
  key: string;
  localPort: number;
  createdAt: string;
}

interface LegacyState {
  version?: number;
  config: LegacyConfig | null;
  consumers?: string[];
  providers?: ProviderConnection[];
  providerWiring?: LegacyWiring | null;
  orphanForwards?: OrphanForward[];
  shareSuspended?: ShareSuspension | null;
  ports?: unknown;
}

const KEY_STORE = "provider-keys.json";

interface KeyStoreFile {
  version: 1;
  keys: Record<string, string>;
}

export function stateFile(): string {
  return statePath("state.json");
}

export function keyStoreFile(): string {
  return statePath(KEY_STORE);
}

export function providerKeyRef(connectionId: string): string {
  return `${KEY_STORE}#${connectionId}`;
}

function loadKeyStore(): KeyStoreFile {
  const { value } = readJsonWithBackup<KeyStoreFile>(keyStoreFile());
  const keys = value && typeof value.keys === "object" && value.keys ? value.keys : {};
  for (const k of Object.values(keys)) registerSecret(k);
  return { version: 1, keys };
}

function saveKeyStore(store: KeyStoreFile): void {
  writeJsonAtomic(keyStoreFile(), store);
}

export function getProviderKey(connectionId: string): string | null {
  const k = loadKeyStore().keys[connectionId];
  if (!k) return null;
  registerSecret(k);
  return k;
}

export function setProviderKey(connectionId: string, key: string): void {
  const store = loadKeyStore();
  store.keys[connectionId] = key;
  registerSecret(key);
  saveKeyStore(store);
}

export function deleteProviderKey(connectionId: string): void {
  const store = loadKeyStore();
  if (!(connectionId in store.keys)) return;
  delete store.keys[connectionId];
  saveKeyStore(store);
}

export function allProviderKeys(): Record<string, string> {
  return { ...loadKeyStore().keys };
}

function newId(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

export function newNodeId(): string {
  return newId(4);
}

export function newInstanceId(): string {
  return randomUUID();
}

function inferBoolean(cfg: LegacyConfig, name: "sharingEnabled" | "consumingEnabled"): boolean {
  if (typeof cfg[name] === "boolean") return Boolean(cfg[name]);
  if (cfg.role === "provider") return name === "sharingEnabled";
  if (cfg.role === "consumer") return name === "consumingEnabled";
  return false;
}

/** Fills in what a v2 record may be missing without touching its semantics. */
function normalizeConfig(raw: LegacyConfig, wiring: LegacyWiring | null): PluginConfig {
  const sharingEnabled = inferBoolean(raw, "sharingEnabled");
  const consumingEnabled = inferBoolean(raw, "consumingEnabled") || Boolean(wiring);
  return {
    sharingEnabled,
    consumingEnabled,
    nodeId: raw.nodeId ?? newNodeId(),
    instanceId: raw.instanceId ?? newInstanceId(),
    networkName: raw.networkName ?? "",
    networkSecret: raw.networkSecret ?? "",
    peers: Array.isArray(raw.peers) ? raw.peers.map(String) : [],
    listenAddr: raw.listenAddr ?? null,
    virtualIpv4: raw.virtualIpv4 ?? "10.77.0.2/24",
    overlayCidr: raw.overlayCidr ?? "10.77.0.0/24",
    rpcPort: Number(raw.rpcPort ?? 17888),
    proxyCidr: raw.proxyCidr ?? null,
    // A node that used to share keeps its mapped prefix even when sharing is
    // switched off: re-enabling sharing must not change what consumers dial.
    mappedCidr: raw.mappedCidr ?? (sharingEnabled ? randomMappedCidr() : null),
    publishedPorts: Array.isArray(raw.publishedPorts) ? raw.publishedPorts.map(Number).filter(Number.isFinite) : [],
    secureMode: raw.secureMode ?? true,
    secureIdentity: raw.secureIdentity ?? null,
    share: normalizeShare(raw.share, sharingEnabled),
    // A phase-4 document has no catalogue yet: both switches stay off, so an
    // upgrade never starts a listener or publishes anything by itself.
    catalog: normalizeCatalogConfig(raw.catalog),
    // Default on: receiving a structured request is the normal state for a
    // joined node. There is no listener until the B service is installed.
    controlEnabled: raw.controlEnabled ?? true,
    controlPort: portIn(raw.controlPort, 0) || null,
  };
}

function normalizeShare(share: SharePolicy | undefined, sharingEnabled: boolean): SharePolicy {
  const models = Array.isArray(share?.models) ? share.models.map(String).filter(Boolean) : [];
  // A legacy document that shared before the allow list existed keeps the old
  // "everything" meaning; a new node starts with nothing selected, so no future
  // model is shared without an explicit choice.
  if (!models.length && sharingEnabled) return { models: ["*"] };
  return { models };
}

function portIn(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback;
}

/** Catalogue defaults are deliberately opt-in: publishing is never implicit. */
export function defaultCatalogConfig(): CatalogConfig {
  return {
    enabled: false,
    discoveryEnabled: false,
    displayName: null,
    contact: null,
    port: CATALOG_PORT,
    socksPort: CATALOG_SOCKS_FROM,
    refreshSec: CATALOG_REFRESH_SEC,
    minTopUpUsd: 1,
  };
}

/** Cleans the human fields and, when asked, refuses a port that collides with a service. */
export function normalizeCatalogConfig(
  raw: Partial<CatalogConfig> | undefined,
  opts: { gatewayPort?: number; reserved?: number[]; strict?: boolean } = {},
): CatalogConfig {
  const d = defaultCatalogConfig();
  const text = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
    return s || null;
  };
  const reserved = opts.reserved ?? [];
  let port = portIn(raw?.port, d.port);
  if (port === opts.gatewayPort || reserved.includes(port)) {
    if (opts.strict) {
      throw new Error(`the catalogue port ${port} is already used by the gateway, the host API or the EasyTier RPC`);
    }
    port = d.port;
    while (port === opts.gatewayPort || reserved.includes(port)) port += 1;
  }
  let socksPort = portIn(raw?.socksPort, d.socksPort);
  if (socksPort === opts.gatewayPort || socksPort === port || reserved.includes(socksPort)) {
    if (opts.strict) throw new Error(`the catalogue SOCKS5 port ${socksPort} collides with another service`);
    socksPort = d.socksPort;
    while (socksPort === opts.gatewayPort || socksPort === port || reserved.includes(socksPort)) socksPort += 1;
  }
  const refreshSec = Number(raw?.refreshSec);
  const minTopUpUsd = Number(raw?.minTopUpUsd);
  return {
    enabled: Boolean(raw?.enabled),
    discoveryEnabled: Boolean(raw?.discoveryEnabled),
    displayName: text(raw?.displayName, 64),
    contact: text(raw?.contact, 120),
    port,
    socksPort,
    refreshSec: Number.isFinite(refreshSec) ? Math.min(300, Math.max(10, Math.round(refreshSec))) : d.refreshSec,
    minTopUpUsd: Number.isFinite(minTopUpUsd) && minTopUpUsd >= 0.0001 && minTopUpUsd <= 1_000_000 ? Math.round(minTopUpUsd * 1e4) / 1e4 : d.minTopUpUsd,
  };
}

export interface LoadedState {
  state: PluginState;
  /** where the configuration came from, for the status output */
  migratedFrom: number | null;
  recoveredFromPrevious: boolean;
  backupPath: string | null;
  error: string | null;
}

/**
 * Reads the state, migrating a phase-3 document when needed. The migration
 * writes a backup first and only then replaces the document; if anything fails
 * the old file is left exactly as it was.
 */
export function loadState(): LoadedState {
  const file = stateFile();
  const { value, from, error } = readJsonWithBackup<LegacyState>(file);
  if (value === null) {
    return { state: emptyState(), migratedFrom: null, recoveredFromPrevious: false, backupPath: null, error };
  }

  const legacy = typeof value.version !== "number" || value.version < STATE_VERSION;
  const backupPath = legacy && existsSync(file) ? backupFile(file, `bak-${new Date().toISOString()}`) : null;
  const wiring = value.providerWiring ?? null;
  const config = value.config ? normalizeConfig(value.config, wiring) : null;
  if (config?.networkSecret) registerSecret(config.networkSecret);

  const providers: ProviderConnection[] = [];
  if (Array.isArray(value.providers)) {
    for (const p of value.providers) {
      if (!p || typeof p.id !== "string") continue;
      providers.push({
        id: p.id,
        remoteMagpieId: p.remoteMagpieId ?? p.id,
        mappedCidr: String(p.mappedCidr ?? ""),
        providerPort: Number(p.providerPort ?? 3425),
        localPort: Number(p.localPort ?? 0),
        keyRef: p.keyRef ?? providerKeyRef(p.id),
        fingerprint: p.fingerprint ?? null,
        models: Array.isArray(p.models) ? p.models.map(String) : [],
        forwardPending:
          p.forwardPending &&
          Number.isInteger(p.forwardPending.from) &&
          Number.isInteger(p.forwardPending.to) &&
          typeof p.forwardPending.at === "string"
            ? { from: p.forwardPending.from, to: p.forwardPending.to, at: p.forwardPending.at }
            : null,
        keyGeneration:
          Number.isInteger((p as ProviderConnection).keyGeneration) && ((p as ProviderConnection).keyGeneration ?? 0) > 0
            ? (p as ProviderConnection).keyGeneration!
            : 1,
        acceptedFingerprint: typeof p.acceptedFingerprint === "string" ? p.acceptedFingerprint : null,
        modelsEvidence: normalizeModelsEvidence(
          p.modelsEvidence,
          p.keyRef ?? providerKeyRef(p.id),
          Number.isInteger((p as ProviderConnection).keyGeneration) && ((p as ProviderConnection).keyGeneration ?? 0) > 0
            ? (p as ProviderConnection).keyGeneration!
            : 1,
        ),
        status: p.status ?? "degraded",
        detail: p.detail ?? null,
        limit: p.limit ?? null,
        createdAt: p.createdAt ?? new Date().toISOString(),
        updatedAt: p.updatedAt ?? p.createdAt ?? new Date().toISOString(),
        lastConnectedAt: p.lastConnectedAt ?? null,
      });
    }
  }

  // Phase 3 kept exactly one wiring and its Gateway Key inside state.json. Move
  // the secret into the key store and the wiring into a provider record, so a
  // consumer-only node keeps working without re-entering its key.
  if (wiring && wiring.id && !providers.some((p) => p.id === wiring.id)) {
    providers.push({
      id: wiring.id,
      remoteMagpieId: wiring.id,
      mappedCidr: String(wiring.mappedCidr ?? ""),
      providerPort: Number(wiring.providerPort ?? 3425),
      localPort: Number(wiring.localPort ?? 0),
      keyRef: providerKeyRef(wiring.id),
      fingerprint: null,
      models: [],
      forwardPending: null,
      keyGeneration: 1,
      acceptedFingerprint: null,
      modelsEvidence: null,
      status: "degraded",
      detail: "migrated from the phase-3 provider wiring; not verified since",
      limit: null,
      createdAt: wiring.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastConnectedAt: null,
    });
    if (wiring.key) setProviderKey(wiring.id, wiring.key);
  }

  const state: PluginState = {
    version: STATE_VERSION,
    config,
    consumers: Array.isArray(value.consumers) ? value.consumers.map(String) : [],
    providers,
    orphanForwards: Array.isArray(value.orphanForwards) ? value.orphanForwards : [],
    shareSuspended: value.shareSuspended ?? null,
    ports: normalizePortLedger((value as LegacyState & { ports?: unknown }).ports),
  };

  const migratedFrom = legacy ? (typeof value.version === "number" ? value.version : 1) : null;
  if (legacy) {
    saveState(state);
    logger.info(
      `state migrated to version ${STATE_VERSION}` +
        `${backupPath ? ` (backup: ${backupPath})` : ""}: ` +
        `sharing=${config?.sharingEnabled ?? false} consuming=${config?.consumingEnabled ?? false} providers=${providers.length}`,
    );
  }
  if (from === "previous") {
    logger.warn(`state.json was unreadable (${error ?? "unknown"}); recovered the previous copy`);
  }
  return { state, migratedFrom, recoveredFromPrevious: from === "previous", backupPath, error };
}

export function emptyState(): PluginState {
  return {
    version: STATE_VERSION,
    config: null,
    consumers: [],
    providers: [],
    orphanForwards: [],
    shareSuspended: null,
    ports: emptyPortLedger(),
  };
}

export function saveState(state: PluginState): void {
  writeJsonAtomic(stateFile(), { ...state, version: STATE_VERSION });
}

/** A redacted view of one provider connection, safe for the page and the API. */
export interface ProviderView {
  id: string;
  remoteMagpieId: string;
  mappedCidr: string;
  providerPort: number;
  localPort: number;
  url: string;
  keyRef: string;
  status: ConnectionStatus;
  detail: string | null;
  fingerprint: PeerFingerprint | null;
  /** models verified at connect time; [] = none recorded, not "authorized to nothing" */
  models: string[];
  keyGeneration: number;
  /** projected, poll-safe model evidence; only status==="current" is callable */
  modelsEvidence: ProviderModelsEvidence;
  /** the provider's own native limit numbers, read through its keyed forward */
  limit: ProviderLimitView | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export function providerView(p: ProviderConnection, now = Date.now()): ProviderView {
  return {
    id: p.id,
    remoteMagpieId: p.remoteMagpieId,
    mappedCidr: p.mappedCidr,
    providerPort: p.providerPort,
    localPort: p.localPort,
    url: `http://127.0.0.1:${p.localPort}`,
    keyRef: p.keyRef,
    status: p.status,
    detail: p.detail,
    fingerprint: p.fingerprint,
    models: Array.isArray(p.models) ? [...p.models] : [],
    keyGeneration: Number.isInteger(p.keyGeneration) && (p.keyGeneration ?? 0) > 0 ? p.keyGeneration! : 1,
    modelsEvidence: projectModelsEvidence(p, now),
    limit: p.limit ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastConnectedAt: p.lastConnectedAt,
  };
}

export function forwardPortsInUse(state: PluginState): Set<number> {
  return new Set(state.providers.map((p) => p.localPort));
}

export function ensureStateDir(): void {
  // the store does this per write; exposed for callers that need it early
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  stateDir();
}
