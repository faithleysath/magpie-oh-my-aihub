// The read-only "network" projection the console renders.
//
// Everything here is evidence-backed: EasyTier's own peer/route output, the
// signed catalogue reads, and this node's own records. A neighbour is a routing
// hint, never an identity and never an authorization; a missing read is `null`,
// not `false`, and never 0. Ports are diagnostics only and are never editable.
//
// This module is pure on purpose: it takes a snapshot and returns a view, so a
// unit test can prove the "unknown is not online" and "neighbour is not
// authorized" rules without a network.

import type { CatalogStatus } from "./service.ts";
import type { Peer, RouteRow, SupervisorState } from "./easytier.ts";
import { reachabilityOf, type PortEvidence, type PortLedger, type PortOwner, type PortPurpose, type PortReachability, type PortState } from "./ports.ts";
import type { PluginConfig, ProviderView } from "./state.ts";

export type NetworkState = "unconfigured" | "starting" | "online" | "degraded" | "offline" | "failed" | "unknown";
export type NeighborLink = "self" | "direct" | "relay" | "unknown";
export type PortViewPurpose = PortPurpose;

export interface NetworkNeighbor {
  key: string;
  hostname: string;
  virtualIpv4: string | null;
  /** EasyTier's own lat_ms; null means no evidence, never 0 */
  latencyMs: number | null;
  lossRatePct: number | null;
  link: NeighborLink;
  linkBasis: "easytier-peer-cost" | "easytier-route" | "none";
  relayVia: string | null;
  online: boolean | null;
  tunnel: string | null;
  natType: string | null;
  catalogNodeId: string | null;
  catalogStatus: string | null;
  /** model count from a signed catalogue; null when no catalogue was read */
  modelsPublished: number | null;
  /** model count this node's own provider record covers; null = not recorded/read */
  modelsAuthorizedForMe: number | null;
  /** only from this node's own records; "none" != "not authorized anywhere" */
  relation: "none" | "i-consume" | "unknown";
  lastCatalogReadAt: string | null;
}

export interface NetworkPortView {
  purpose: PortViewPurpose;
  label: string;
  host: string | null;
  port: number | null;
  owner: PortOwner;
  editable: false;
  /** loopback/overlay/lan/unknown, from the real bind address, never assumed */
  reachability: PortReachability;
  state: PortState;
  verifiedAt: string | null;
  detail: string | null;
}

export interface NetworkView {
  configured: boolean;
  name: string | null;
  state: NetworkState;
  summary: string;
  at: string | null;
  evidence: {
    source: "easytier";
    coreVersion: string | null;
    readAt: string | null;
    staleMs: number | null;
    complete: boolean;
    problems: string[];
  };
  core: {
    running: boolean;
    pid: number | null;
    version: string | null;
    startedAt: string | null;
    restarts: number;
    state: "running" | "stopped" | "failed" | "unknown";
    lastError: string | null;
    aclOk: boolean;
  };
  thisNode: {
    nodeId: string | null;
    hostname: string | null;
    virtualIpv4: string | null;
    networkName: string | null;
  };
  neighbors: NetworkNeighbor[];
  ports: NetworkPortView[];
  catalog: {
    publishing: boolean;
    address: string | null;
    port: number | null;
    error: string | null;
    modelCount: number | null;
  };
  catalogPeers: number;
}

export interface NetworkProjectionInput {
  config: PluginConfig | null;
  supervisor: SupervisorState;
  catalog: CatalogStatus;
  providers: ProviderView[];
  gatewayPort: number;
  ledger?: PortLedger;
  consolePort?: number | null;
  apiPort?: number | null;
  now?: () => number;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `"0.11"` → 0.11; `"-"`/`""`/missing → null (unknown, not 0). */
export function parseLatency(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === null || text === undefined || text === "" || text === "-") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `"0.0%"` → 0; `"-"`/missing → null. */
export function parseLoss(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === null || text === undefined || text === "" || text === "-") return null;
  const n = Number(String(text).replace(/%$/, ""));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

function hostOnly(cidr: string | null | undefined): string | null {
  if (!cidr) return null;
  const host = cidr.trim().replace(/\/\d+$/, "");
  return host || null;
}

export function classifyLink(peer: Pick<Peer, "cost"> | null, route: RouteRow | null): {
  link: NeighborLink;
  basis: NetworkNeighbor["linkBasis"];
  relayVia: string | null;
} {
  if (route) {
    if (route.pathLen <= 0) return { link: "self", basis: "easytier-route", relayVia: null };
    const next = (route.nextHop ?? "").trim();
    if (next === "DIRECT" || next === "Local") {
      return route.pathLen <= 1
        ? { link: "direct", basis: "easytier-route", relayVia: null }
        : { link: "relay", basis: "easytier-route", relayVia: null };
    }
    if (next) return { link: "relay", basis: "easytier-route", relayVia: next };
  }
  const cost = (peer?.cost ?? "").trim();
  if (cost === "p2p") return { link: "direct", basis: "easytier-peer-cost", relayVia: null };
  if (cost.startsWith("relay")) return { link: "relay", basis: "easytier-peer-cost", relayVia: null };
  if (cost === "Local") return { link: "self", basis: "easytier-peer-cost", relayVia: null };
  return { link: "unknown", basis: "none", relayVia: null };
}

function portView(input: {
  purpose: PortPurpose;
  label: string;
  host: string | null;
  port: number | null;
  owner: PortOwner;
  ledger?: PortLedger;
  reachability?: PortReachability;
  fallback: { state: PortState; detail: string | null; verifiedAt?: string | null };
}): NetworkPortView {
  const record: PortEvidence | null =
    input.port === null ? null : (input.ledger?.evidence.find((e) => e.purpose === input.purpose && e.port === input.port) ?? null);
  return {
    purpose: input.purpose,
    label: input.label,
    host: input.host,
    port: input.port,
    owner: input.owner,
    editable: false,
    reachability: record?.reachability ?? input.reachability ?? reachabilityOf(input.host),
    state: record?.state ?? input.fallback.state,
    verifiedAt: record?.verifiedAt ?? input.fallback.verifiedAt ?? null,
    detail: record?.detail ?? input.fallback.detail,
  };
}

/** Extracts `tcp://host:port` (or `host:port`) without throwing on junk. */
export function splitListenAddr(raw: string | null): { host: string | null; port: number | null } {
  if (!raw) return { host: null, port: null };
  const trimmed = raw.trim().replace(/^\w+:\/\//, "");
  const at = trimmed.lastIndexOf(":");
  if (at <= 0) return { host: trimmed || null, port: null };
  const host = trimmed.slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(trimmed.slice(at + 1));
  return { host: host || null, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null };
}

export function projectNetwork(input: NetworkProjectionInput): NetworkView {
  const now = input.now ?? Date.now;
  const cfg = input.config;
  const et = input.supervisor;
  const readAt = et.peersAt ?? null;
  const readMs = readAt ? Date.parse(readAt) : Number.NaN;
  const staleMs = Number.isFinite(readMs) ? Math.max(0, now() - readMs) : null;
  const problems: string[] = [];
  const routes = et.routes ?? [];
  const peers = et.peers ?? [];
  const peerRead = Boolean(et.peersAt);
  const routeRead = Boolean(et.routesAt);
  if (cfg && et.running && !peerRead) problems.push("peer list has not been read since the core started");
  else if (cfg && !et.running && peerRead) problems.push("the last peer read predates the core stopping");
  if (cfg && et.running && !routeRead) problems.push("route table has not been read since the core started");
  if (cfg && et.socks5Port !== null && !et.aclOk) problems.push("the runtime safety check has open findings");

  const peersByHost = new Map<string, Peer>();
  const selfHosts = new Set<string>();
  for (const peer of peers) {
    const host = peer.hostname || hostOnly(peer.ipv4) || "";
    if (!host) continue;
    peersByHost.set(host, peer);
    if (peer.cost === "Local" || peer.ipv4 === et.virtualIpv4) selfHosts.add(host);
  }
  if (et.hostname) selfHosts.add(et.hostname);
  const routesByHost = new Map<string, RouteRow>();
  for (const route of routes) {
    const host = route.hostname || hostOnly(route.ipv4) || "";
    if (host) routesByHost.set(host, route);
  }

  const catalogByHost = new Map<string, CatalogStatus["peers"][number]>();
  for (const peer of input.catalog.peers) {
    if (peer.status === "self") continue;
    if (peer.hostname) catalogByHost.set(peer.hostname, peer);
    const ip = hostOnly(peer.virtualIpv4);
    if (ip) catalogByHost.set(`ip:${ip}`, peer);
  }
  const providerByHost = new Map<string, ProviderView[]>();
  for (const provider of input.providers) {
    const fp = provider.fingerprint;
    const key = fp?.hostname || (fp ? hostOnly(fp.virtualIpv4) : null) || provider.id;
    const list = providerByHost.get(key) ?? [];
    list.push(provider);
    providerByHost.set(key, list);
  }

  const seen = new Set<string>();
  const neighbors: NetworkNeighbor[] = [];
  const pushNeighbor = (hostname: string, ip: string | null) => {
    const key = hostname || (ip ? `ip:${ip}` : null);
    if (!key || seen.has(key)) return;
    if (selfHosts.has(hostname) || (et.virtualIpv4 && ip === et.virtualIpv4)) return;
    seen.add(key);
    const peer = peersByHost.get(hostname) ?? null;
    const route = routesByHost.get(hostname) ?? null;
    const catalogPeer = catalogByHost.get(hostname) ?? (ip ? catalogByHost.get(`ip:${ip}`) : undefined) ?? null;
    const matching = providerByHost.get(hostname) ?? (ip ? providerByHost.get(ip) : undefined) ?? [];
    const link = classifyLink(peer, route);
    // An empty record means "not recorded", not "authorized for zero models".
    const modelCounts = matching
      .map((p) => (p.models && p.models.length ? p.models.length : null))
      .filter((n): n is number => n !== null);
    const relation =
      matching.length === 0 ? "none" : matching.length === 1 ? "i-consume" : "unknown";
    neighbors.push({
      key: peer?.id ? `peer:${peer.id}` : `host:${key}`,
      hostname: hostname || catalogPeer?.hostname || ip || "unknown",
      virtualIpv4: ip,
      latencyMs: parseLatency(peer?.latencyMs),
      lossRatePct: parseLoss(peer?.loss),
      link: link.link,
      linkBasis: link.basis,
      relayVia: link.relayVia,
      // A peer list kept from before the core stopped is not "online now".
      online: !et.running ? null : peer ? true : catalogPeer ? Boolean(catalogPeer.online) : null,
      tunnel: peer?.tunnel && peer.tunnel !== "-" ? peer.tunnel : null,
      natType: peer?.nat && peer.nat !== "-" ? peer.nat : null,
      catalogNodeId: catalogPeer?.nodeId ?? null,
      catalogStatus: catalogPeer?.status ?? null,
      modelsPublished: catalogPeer?.quote ? catalogPeer.quote.models.length : null,
      modelsAuthorizedForMe: modelCounts.length ? Math.max(...modelCounts) : null,
      relation,
      lastCatalogReadAt: catalogPeer?.fetchedAt ?? null,
    });
  };
  for (const [host, peer] of peersByHost) {
    if (peer.cost === "Local") continue;
    pushNeighbor(host, hostOnly(peer.ipv4));
  }
  for (const peer of input.catalog.peers) {
    if (peer.status === "self") continue;
    pushNeighbor(peer.hostname, hostOnly(peer.virtualIpv4));
  }
  neighbors.sort((a, b) => a.hostname.localeCompare(b.hostname));

  const listen = splitListenAddr(cfg?.listenAddr ?? null);
  const ports: NetworkPortView[] = [];
  if (listen.port) {
    ports.push(
      portView({
        purpose: "overlay-listen",
        label: "Overlay listener",
        host: listen.host,
        port: listen.port,
        owner: "easytier",
        ledger: input.ledger,
        fallback: {
          state: et.running ? "unverified" : "failed",
          detail: et.running ? null : "the core is not running",
        },
      }),
    );
  }
  if (et.rpcPort ?? cfg?.rpcPort) {
    const port = et.rpcPort ?? cfg?.rpcPort ?? null;
    ports.push(
      portView({
        purpose: "easytier-rpc",
        label: "Core RPC (loopback)",
        host: "127.0.0.1",
        port,
        owner: "easytier",
        ledger: input.ledger,
        fallback: {
          state: et.running ? "unverified" : "failed",
          detail: et.running ? null : "the core is not running",
        },
      }),
    );
  }
  const catalogPort = cfg?.catalog.port ?? null;
  if (catalogPort) {
    ports.push(
      portView({
        purpose: "catalog",
        label: "Catalogue publish (LAN)",
        host: input.catalog.server.address?.split(":").slice(0, -1).join(":") ?? null,
        port: catalogPort,
        owner: "plugin",
        ledger: input.ledger,
        fallback: {
          state: input.catalog.server.running ? "stable" : input.catalog.server.error ? "failed" : "unverified",
          detail: input.catalog.server.error,
        },
      }),
    );
  }
  if (cfg?.catalog.discoveryEnabled && cfg.catalog.socksPort) {
    ports.push(
      portView({
        purpose: "catalog-socks",
        label: "Catalogue query SOCKS5 (loopback)",
        host: "127.0.0.1",
        port: cfg.catalog.socksPort,
        owner: "easytier",
        ledger: input.ledger,
        fallback: {
          state: et.running ? "unverified" : "failed",
          detail: et.running ? null : "the core is not running",
        },
      }),
    );
  }
  ports.push(
    portView({
      purpose: "gateway",
      label: "Magpie gateway (owned by Magpie)",
      host: "127.0.0.1",
      port: input.gatewayPort,
      owner: "magpie",
      ledger: input.ledger,
      // The plugin reads the gateway on loopback but does not own its bind: it
      // may also listen on the LAN IP while sharing, so do not claim loopback.
      reachability: "unknown",
      fallback: {
        state: "unknown",
        detail: "owned by Magpie; this plugin never changes its listener and does not assert its bind scope",
      },
    }),
  );
  for (const provider of input.providers) {
    if (!provider.localPort) continue;
    ports.push(
      portView({
        purpose: "forward",
        label: `Forward to ${provider.id} (loopback)`,
        host: "127.0.0.1",
        port: provider.localPort,
        owner: "easytier",
        ledger: input.ledger,
        fallback: {
          state: et.running ? "unverified" : "failed",
          detail: et.running ? provider.detail : "the core is not running",
        },
      }),
    );
  }
  if (input.consolePort) {
    ports.push(
      portView({
        purpose: "console",
        label: "Console (loopback)",
        host: "127.0.0.1",
        port: input.consolePort,
        owner: "plugin",
        ledger: input.ledger,
        fallback: { state: "stable", detail: null },
      }),
    );
  }
  if (input.apiPort) {
    ports.push(
      portView({
        purpose: "api",
        label: "Maintainer API (loopback)",
        host: "127.0.0.1",
        port: input.apiPort,
        owner: "plugin",
        ledger: input.ledger,
        fallback: { state: "stable", detail: null },
      }),
    );
  }

  const running = Boolean(et.running);
  const aclOk = Boolean(et.aclOk);
  let state: NetworkState;
  if (!cfg?.nodeId) state = "unconfigured";
  else if (!running && et.lastError) state = "failed";
  else if (!running) state = "offline";
  else if (!peerRead) state = "starting";
  else if (!aclOk || !routeRead) state = "degraded";
  else if (et.lastError) state = "degraded";
  else state = "online";
  const summary =
    state === "unconfigured"
      ? "This node has not joined a network yet."
      : state === "failed"
        ? "The overlay core is not running; open diagnostics for the recorded error."
        : state === "offline"
          ? "The overlay core is not running."
          : state === "starting"
            ? "The overlay core is running; no peer list has been read yet."
            : state === "degraded"
              ? "The overlay is running, but its state could not be fully proven."
              : state === "online"
                ? `Connected to ${neighbors.length} peer${neighbors.length === 1 ? "" : "s"} over the overlay.`
                : "Network state is unknown.";

  const quoteModels = input.catalog.quote?.models.length ?? null;
  return {
    configured: Boolean(cfg?.nodeId),
    name: cfg?.networkName ?? null,
    state,
    summary,
    at: readAt,
    evidence: {
      source: "easytier",
      coreVersion: et.coreVersion,
      readAt,
      staleMs,
      complete: peerRead && routeRead,
      problems: problems.slice(0, 5),
    },
    core: {
      running,
      pid: et.pid,
      version: et.coreVersion,
      startedAt: et.startedAt,
      restarts: et.restarts,
      state: running ? "running" : et.lastError ? "failed" : cfg?.nodeId ? "stopped" : "unknown",
      lastError: et.lastError,
      aclOk,
    },
    thisNode: {
      nodeId: cfg?.nodeId ?? null,
      hostname: et.hostname ?? null,
      virtualIpv4: et.virtualIpv4 ?? cfg?.virtualIpv4 ?? null,
      networkName: et.networkName ?? cfg?.networkName ?? null,
    },
    neighbors,
    ports,
    catalog: {
      publishing: input.catalog.publishing,
      address: input.catalog.server.address,
      port: input.catalog.server.port ?? catalogPort,
      error: input.catalog.server.error ?? input.catalog.error,
      modelCount: quoteModels,
    },
    catalogPeers: input.catalog.peers.filter((p) => p.status !== "self" && Boolean(p.quote)).length,
  };
}
