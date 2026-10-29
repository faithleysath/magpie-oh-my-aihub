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

export const STATE_VERSION = 2;

/** The overlay's forward-port range; one port per remote provider. */
export const FORWARD_PORT_FROM = 13425;
export const FORWARD_PORT_TO = 13499;

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
}

export type ConnectionStatus = "connected" | "degraded" | "disabled" | "identity-mismatch";

/** What the overlay said about the peer that owned a mapped prefix. */
export interface PeerFingerprint {
  hostname: string;
  virtualIpv4: string;
  /** session-scoped: EasyTier assigns a new peer_id on every start */
  peerId: string | null;
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
  status: ConnectionStatus;
  detail: string | null;
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
    share: normalizeShare(raw.share),
  };
}

function normalizeShare(share: SharePolicy | undefined): SharePolicy {
  const models = Array.isArray(share?.models) ? share.models.map(String).filter(Boolean) : ["*"];
  return { models: models.length ? models : ["*"] };
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
        status: p.status ?? "degraded",
        detail: p.detail ?? null,
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
      status: "degraded",
      detail: "migrated from the phase-3 provider wiring; not verified since",
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
  return { version: STATE_VERSION, config: null, consumers: [], providers: [], orphanForwards: [], shareSuspended: null };
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
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export function providerView(p: ProviderConnection): ProviderView {
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
