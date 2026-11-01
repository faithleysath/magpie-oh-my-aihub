// discover: read the directory of every peer EasyTier routes to.
//
// For each peer that exports a mapped address, this walks the local SOCKS5
// listener to `http://<mapped>:3426/catalog`, then parses the document strictly:
// exact field set, type and length bounds, a valid signature, and the signer
// equal to `address`. A peer that fails any check is reported `online:false` with
// a short reason; it is never partially trusted (DESIGN-V2 §8).
//
// The cache is memory only, 30 seconds, keyed by the address that signed a
// document. It keeps, per peer, the overlay endpoint the catalogue arrived on
// (`<mappedHost>:3426`), because that is where the same peer answers `POST
// /request` and `GET /request` — `peerEndpoint()` is what `request_access` and
// `connect_provider` use. Nothing is written to disk.
//
// A peer that is offline, exports nothing, or signs a document that does not
// verify has no endpoint: there is nowhere to send a signed request. A peer that
// is online but shares nothing still has one — its catalogue is served, just
// with `models: []`.

import { CATALOG_MAX_BYTES, CATALOG_PATH, parseCatalogDocument, type CatalogModel } from "../catalog-service.ts";
import { CONTROL_PORT, SOCKS_PORT, type OverlayNeighbor } from "../overlay.ts";
import { getRuntime } from "../runtime.ts";
import { socksHttpGet } from "../socks.ts";
import { fail, jsonText, objectArgs, optionalBoolean, type ToolDef } from "./types.ts";

/** Where one peer's directory and request endpoints answer. */
export interface PeerEndpoint {
  address: string;
  host: string;
  port: number;
}

export interface DiscoveredPeer {
  /** the address from the signed document; null when no valid document was read */
  address: string | null;
  /** the signed hostname when online, otherwise the EasyTier hostname we dialled */
  hostname: string;
  online: boolean;
  models: CatalogModel[];
  ts?: string;
  /** `<mappedHost>:3426` when a document was read; null otherwise */
  endpoint: PeerEndpoint | null;
  /** short reason for an unreadable peer */
  error?: string;
}

const CACHE_TTL_MS = 30_000;
const READ_TIMEOUT_MS = 5_000;
const READ_BUDGET_MS = 20_000;
const MAX_CONCURRENT_READS = 4;

let cache: { at: number; peers: DiscoveredPeer[] } | null = null;
let inflight: Promise<DiscoveredPeer[]> | null = null;

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
}

function offline(neighbor: OverlayNeighbor, error: string): DiscoveredPeer {
  return { address: null, hostname: neighbor.hostname, online: false, models: [], endpoint: null, error };
}

async function readPeer(neighbor: OverlayNeighbor): Promise<DiscoveredPeer> {
  if (!neighbor.mappedHost) return offline(neighbor, "no exported address");
  let response: { status: number; body: string };
  try {
    response = await socksHttpGet({
      socksPort: SOCKS_PORT,
      host: neighbor.mappedHost,
      port: CONTROL_PORT,
      path: CATALOG_PATH,
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: CATALOG_MAX_BYTES,
    });
  } catch (error) {
    return offline(neighbor, shortError(error));
  }
  if (response.status !== 200) return offline(neighbor, `HTTP ${response.status}`);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.body);
  } catch {
    return offline(neighbor, "response is not JSON");
  }
  const parsed = parseCatalogDocument(parsedJson);
  if (!parsed.ok) return offline(neighbor, parsed.error);
  return {
    address: parsed.doc.address,
    hostname: parsed.doc.hostname,
    online: true,
    models: parsed.doc.models,
    ts: parsed.doc.ts,
    endpoint: { address: parsed.doc.address, host: neighbor.mappedHost, port: CONTROL_PORT },
  };
}

async function collectPeers(): Promise<DiscoveredPeer[]> {
  const runtime = await getRuntime();
  if (!runtime.overlay.status().configured) {
    fail("E_NO_NETWORK", "join a network before discovering peers");
  }
  const neighbors = await runtime.overlay.neighbors();
  if (neighbors.length === 0) return [];

  const results = new Array<DiscoveredPeer>(neighbors.length);
  const deadline = Date.now() + READ_BUDGET_MS;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= neighbors.length) return;
      const neighbor = neighbors[index];
      if (!neighbor.mappedHost) {
        results[index] = offline(neighbor, "no exported address");
        continue;
      }
      if (Date.now() >= deadline) {
        results[index] = offline(neighbor, "read budget exhausted");
        continue;
      }
      results[index] = await readPeer(neighbor);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_READS, neighbors.length) }, () => worker()),
  );
  return results;
}

/**
 * The cached peer list, re-reading once when `refresh` is set or the cache is
 * older than 30 seconds. Concurrent callers share one read.
 */
async function loadPeers(refresh: boolean): Promise<DiscoveredPeer[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.peers;
  if (inflight) return inflight;

  const run = (async () => {
    const peers = await collectPeers();
    cache = { at: Date.now(), peers };
    return peers;
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

/**
 * Test seam: installs the in-memory peer list the tools read, so a harness can
 * exercise `peerEndpoint` without an EasyTier core. Production never calls it;
 * `null` restores the empty cache.
 */
export function setDiscoverCacheForTest(peers: DiscoveredPeer[] | null): void {
  cache = peers === null ? null : { at: Date.now(), peers };
  inflight = null;
}

function findPeer(peers: DiscoveredPeer[], address: string): DiscoveredPeer | undefined {
  const wanted = address.toLowerCase();
  return peers.find((peer) => peer.address?.toLowerCase() === wanted);
}

/**
 * Where to send a signed request for one address (DESIGN-V2 §7.3).
 *
 * The endpoint comes from the cached catalogue read; a missing peer triggers one
 * refresh, never a loop. A peer that answered `online:false` is surfaced as
 * `E_PEER_OFFLINE` with its reason, because a request to a node whose document
 * did not verify would be sent to an unproven address.
 */
export async function peerEndpoint(address: string): Promise<PeerEndpoint> {
  const wanted = address.trim().toLowerCase();
  let peers = cache?.peers ?? [];
  let peer = findPeer(peers, wanted);
  if (!peer) {
    peers = await loadPeers(true);
    peer = findPeer(peers, wanted);
  }
  if (!peer) {
    throw new Error(
      `E_PEER_OFFLINE: no node at ${wanted} answered on the overlay; run discover to see who is online`,
    );
  }
  if (!peer.online || !peer.endpoint) {
    throw new Error(`E_PEER_OFFLINE: ${wanted} is not reachable: ${peer.error ?? "no signed directory"}`);
  }
  return peer.endpoint;
}

export const discoverTool: ToolDef = {
  description:
    "发现网络里其他节点公布的模型：通过本机 EasyTier SOCKS5 读每个邻居的 GET /catalog，严格验签后返回 " +
    "地址、hostname、模型与价格。结果内存缓存 30 秒，refresh:true 强制重读；" +
    "没有邻居时返回空列表。读不到或校验不过的邻居标 online:false 并给出简短原因。",
  args: {
    type: "object",
    properties: {
      refresh: { type: "boolean", description: "忽略 30 秒缓存，强制重新读取；默认 false" },
    },
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const refresh = optionalBoolean(args, "refresh");
    return jsonText({ peers: await loadPeers(refresh) });
  },
};
