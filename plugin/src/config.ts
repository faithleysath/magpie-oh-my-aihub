// The plugin's single configuration document.
//
// It holds the network, the shared-model selection, the overlay hostname and the
// consumer-side connections. The format is version 3.
//
// There is no exported subnet any more: every node takes a virtual IP from
// EasyTier's DHCP (`dhcp = true`) and peers are addressed by it, so a public
// address per host is neither required nor advertised.
// Older files are never deleted or rewritten in place by this module:
// `readConfig` falls back to defaults, and `writeJsonAtomic` keeps the replaced
// document as `state.json.prev`.
//
// A connection is `{provider, localPort}` plus `peerHost`: the peer's overlay
// address as last discovered (`10.126.x.y` from EasyTier's DHCP), kept so the
// generated TOML can restore the `[[port_forward]]` after a restart without a
// live discovery read. It is a routing clue only — the peer's identity is still
// the signed document.

import { writeJsonAtomic, readJsonWithBackup } from "./store.ts";
import { logger } from "./log.ts";
import { statePath } from "./paths.ts";

export const CONFIG_VERSION = 3 as const;

export interface NetworkConfig {
  name: string;
  secret: string;
  initialNode: string | null;
  /**
   * EasyTier secure mode. A network whose nodes run it rejects a node that does
   * not (`same-network peers must use the same secure mode`), so this is a
   * property of the network, not a preference: it is chosen when joining and
   * kept from then on. The X25519 pair it needs lives in `easytier/secure-key.json`.
   */
  secureMode: boolean;
  /**
   * Listen for peers instead of only dialling out.
   *
   * Without it EasyTier opens no port at all, so every packet reaches this node
   * through whatever peer already holds a connection to it — in practice the
   * seed, which is slower and depends on it. A listener is what lets two nodes
   * talk directly. Only turn it on where an inbound port is actually reachable
   * (a host with a public address, or a port forwarded to it), and open that
   * port in the host's firewall.
   */
  listen: boolean;
  /**
   * Ask for a TUN device instead of EasyTier's user-space (no-TUN) stack.
   *
   * A request, not a promise: a process without root cannot create a device, so
   * the effective mode is `tun && canCreateTun()`. The difference is not only
   * performance — with a device a peer's packets arrive carrying the peer's
   * overlay address as their source, so Magpie sees a real client and enforces
   * the Gateway Key and its cost limit. Through the no-TUN stack inbound is
   * rewritten to 127.0.0.1, which Magpie answers as the local, keyless caller,
   * so a no-TUN provider publishes no gateway port at all.
   */
  tun: boolean;
}

export interface ShareConfig {
  models: string[];
}

/**
 * One Remote Magpie this node consumes. `provider` is the peer's wallet address
 * (its identity), `localPort` is the loopback forward EasyTier listens on, and
 * `peerHost` is the peer's overlay address the forward points at.
 */
export interface ConnectionConfig {
  provider: string;
  localPort: number;
  peerHost: string | null;
}

export interface HubConfig {
  version: typeof CONFIG_VERSION;
  network: NetworkConfig | null;
  share: ShareConfig;
  connections: ConnectionConfig[];
  hostname: string | null;
  /**
   * The name this node publishes for itself in its directory.
   *
   * It is whatever the user called *themselves* in the address book — an alias
   * that points at this node's own wallet. Display only: identity is the address,
   * and `hostname` stays the machine-like name EasyTier uses.
   */
  displayName: string | null;
}

export function configPath(): string {
  return statePath("state.json");
}

export function defaultConfig(): HubConfig {
  return {
    version: CONFIG_VERSION,
    network: null,
    share: { models: [] },
    connections: [],
    hostname: null,
    displayName: null,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A published name: printable, trimmed, one line, at most 64 characters. */
export function displayNameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The overlay address is a plain IPv4; the subnet itself belongs to the network. */
function isOverlayHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const host = value.trim();
  if (!IPV4_RE.test(host)) return false;
  return host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function isLocalPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * Connections are routing config, not authorization: a malformed or duplicate
 * entry is dropped, so a hand-edited file can never make the generated TOML
 * forward somewhere unintended. Identity is the `0x` address; the port and the
 * overlay host are only clues.
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
    out.push({ provider, localPort: src.localPort, peerHost: isOverlayHost(src.peerHost) ? src.peerHost.trim() : null });
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
      network = {
        name,
        secret,
        initialNode: text(src.initialNode),
        secureMode: src.secureMode === true,
        listen: src.listen === true,
        tun: src.tun === true,
      };
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
    connections: connectionsOf(o.connections),
    hostname: text(o.hostname),
    displayName: displayNameOf(o.displayName),
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
      ? {
          name: cfg.network.name,
          secret: cfg.network.secret,
          initialNode: cfg.network.initialNode,
          secureMode: cfg.network.secureMode,
          listen: cfg.network.listen,
          tun: cfg.network.tun,
        }
      : null,
    share: { models: [...cfg.share.models] },
    connections: cfg.connections.map((c) => ({
      provider: c.provider,
      localPort: c.localPort,
      peerHost: c.peerHost,
    })),
    hostname: cfg.hostname,
    displayName: cfg.displayName,
  });
}

/** The overlay hostname is derived from the wallet, never chosen by the user. */
export function hostnameForAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  return `omai-${hex.slice(-8)}`;
}
