// The plugin's single configuration document.
//
// It holds the network, the shared-model selection, the overlay hostname, the
// persisted overlay export (`publish.mappedCidr`) and the consumer-side
// connections. The format is version 3.
// Older files are never deleted or rewritten in place by this module:
// `readConfig` falls back to defaults, and `writeJsonAtomic` keeps the replaced
// document as `state.json.prev`.
//
// A connection is `{provider, localPort}` per the design, plus `mappedHost`: the
// peer's exported overlay address, kept so the generated TOML can restore the
// `[[port_forward]]` after a restart without a live discovery read. It is a
// routing clue only — the peer's identity is still the signed document.

import { writeJsonAtomic, readJsonWithBackup } from "./store.ts";
import { logger } from "./log.ts";
import { statePath } from "./paths.ts";

export const CONFIG_VERSION = 3 as const;

export interface NetworkConfig {
  name: string;
  secret: string;
  initialNode: string | null;
}

export interface ShareConfig {
  models: string[];
}

/**
 * The overlay export. `mappedCidr` is allocated once (`10.66.a.b/32`) and never
 * changes, so a consumer's saved route keeps pointing at this node.
 */
export interface PublishConfig {
  mappedCidr: string | null;
}

/**
 * One Remote Magpie this node consumes. `provider` is the peer's wallet address
 * (its identity), `localPort` is the loopback forward EasyTier listens on, and
 * `mappedHost` is the peer's exported overlay address the forward points at.
 */
export interface ConnectionConfig {
  provider: string;
  localPort: number;
  mappedHost: string | null;
}

export interface HubConfig {
  version: typeof CONFIG_VERSION;
  network: NetworkConfig | null;
  share: ShareConfig;
  publish: PublishConfig;
  connections: ConnectionConfig[];
  hostname: string | null;
}

export function configPath(): string {
  return statePath("state.json");
}

export function defaultConfig(): HubConfig {
  return {
    version: CONFIG_VERSION,
    network: null,
    share: { models: [] },
    publish: { mappedCidr: null },
    connections: [],
    hostname: null,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The persisted export must be the fixed `10.66.a.b/32` shape. Anything else (a
 * hand edit, a migrated file) is dropped so the next start allocates a fresh
 * one instead of exporting an unrelated subnet.
 */
function mappedCidrOf(publish: unknown): string | null {
  if (!publish || typeof publish !== "object" || Array.isArray(publish)) return null;
  const value = (publish as Record<string, unknown>).mappedCidr;
  if (typeof value !== "string") return null;
  const m = /^10\.66\.(\d{1,3})\.(\d{1,3})\/32$/.exec(value.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (Number(a) < 1 || Number(a) > 254 || Number(b) < 1 || Number(b) > 254) return null;
  return `10.66.${a}.${b}/32`;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const MAPPED_HOST_RE = /^10\.66\.(\d{1,3})\.(\d{1,3})$/;

function isMappedHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = MAPPED_HOST_RE.exec(value.trim());
  if (!m) return false;
  return Number(m[1]) >= 1 && Number(m[1]) <= 254 && Number(m[2]) >= 1 && Number(m[2]) <= 254;
}

function isLocalPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * Connections are routing config, not authorization: a malformed or duplicate
 * entry is dropped, so a hand-edited file can never make the generated TOML
 * forward somewhere unintended. Identity is the `0x` address; the port and the
 * mapped host are only clues.
 */
function connectionsOf(raw: unknown): ConnectionConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: ConnectionConfig[] = [];
  const providers = new Set<string>();
  const ports = new Set<number>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const src = value as Record<string, unknown>;
    const provider = typeof src.provider === "string" ? src.provider.trim().toLowerCase() : "";
    if (!ADDRESS_RE.test(provider) || providers.has(provider)) continue;
    if (!isLocalPort(src.localPort) || ports.has(src.localPort)) continue;
    providers.add(provider);
    ports.add(src.localPort);
    out.push({ provider, localPort: src.localPort, mappedHost: isMappedHost(src.mappedHost) ? src.mappedHost.trim() : null });
  }
  return out;
}

/**
 * Reads any JSON value as a v3 config. Unknown fields are dropped, a missing or
 * different version becomes the default, and a network without both a name and
 * a secret is not a network.
 */
export function normalizeConfig(raw: unknown): HubConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultConfig();
  const o = raw as Record<string, unknown>;
  if (o.version !== CONFIG_VERSION) return defaultConfig();

  let network: NetworkConfig | null = null;
  const n = o.network;
  if (n && typeof n === "object" && !Array.isArray(n)) {
    const src = n as Record<string, unknown>;
    const name = text(src.name);
    const secret = text(src.secret);
    if (name && secret) {
      network = { name, secret, initialNode: text(src.initialNode) };
    }
  }

  const shareRaw = o.share;
  let models: string[] = [];
  if (shareRaw && typeof shareRaw === "object" && !Array.isArray(shareRaw)) {
    const list = (shareRaw as Record<string, unknown>).models;
    if (Array.isArray(list)) {
      models = list.filter((m): m is string => typeof m === "string" && m.length > 0);
    }
  }

  return {
    version: CONFIG_VERSION,
    network,
    share: { models },
    publish: { mappedCidr: mappedCidrOf(o.publish) },
    connections: connectionsOf(o.connections),
    hostname: text(o.hostname),
  };
}

export function readConfig(): HubConfig {
  const read = readJsonWithBackup<unknown>(configPath());
  if (read.value === null) {
    if (read.error) logger.warn(`state.json is unreadable (${read.error}); using defaults`);
    return defaultConfig();
  }
  const value = read.value;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version !== CONFIG_VERSION
  ) {
    // A file from the old implementation: leave it on disk, start clean.
    logger.warn(
      `state.json has version ${String((value as Record<string, unknown>).version)}; ` +
        `using v${CONFIG_VERSION} defaults (the old file is kept as state.json.prev on the next write)`,
    );
  }
  if (read.from === "previous") logger.warn("state.json was unreadable; recovered the previous copy");
  return normalizeConfig(value);
}

export function writeConfig(cfg: HubConfig): void {
  writeJsonAtomic(configPath(), {
    version: CONFIG_VERSION,
    network: cfg.network
      ? { name: cfg.network.name, secret: cfg.network.secret, initialNode: cfg.network.initialNode }
      : null,
    share: { models: [...cfg.share.models] },
    publish: { mappedCidr: cfg.publish.mappedCidr },
    connections: cfg.connections.map((c) => ({
      provider: c.provider,
      localPort: c.localPort,
      mappedHost: c.mappedHost,
    })),
    hostname: cfg.hostname,
  });
}

/** The overlay hostname is derived from the wallet, never chosen by the user. */
export function hostnameForAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  return `omai-${hex.slice(-8)}`;
}
