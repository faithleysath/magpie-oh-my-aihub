// discover: read the directory of every peer EasyTier routes to.
//
// For each peer that exports a mapped address, this walks the local SOCKS5
// listener to `http://<mapped>:3426/catalog`, then parses the document strictly:
// exact field set, type and length bounds, a valid signature, and the signer
// equal to `address`. A peer that fails any check is reported `online:false` with
// a short reason; it is never partially trusted (DESIGN-V2 §8).
//
// Results are cached in memory for 30 seconds, keyed by peer address. Nothing is
// written to disk.

import { CATALOG_MAX_BYTES, CATALOG_PATH, parseCatalogDocument, type CatalogModel } from "../catalog-service.ts";
import { CONTROL_PORT, SOCKS_PORT, type OverlayNeighbor } from "../overlay.ts";
import { getRuntime } from "../runtime.ts";
import { socksHttpGet } from "../socks.ts";
import { fail, jsonText, objectArgs, optionalBoolean, type ToolDef } from "./types.ts";

export interface DiscoveredPeer {
  /** the address from the signed document; null when no valid document was read */
  address: string | null;
  /** the signed hostname when online, otherwise the EasyTier hostname we dialled */
  hostname: string;
  online: boolean;
  models: CatalogModel[];
  ts?: string;
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
  return { address: null, hostname: neighbor.hostname, online: false, models: [], error };
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

    if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return jsonText({ peers: cache.peers });
    }
    if (inflight) return jsonText({ peers: await inflight });

    const run = (async () => {
      const peers = await collectPeers();
      cache = { at: Date.now(), peers };
      return peers;
    })();
    inflight = run;
    try {
      return jsonText({ peers: await run });
    } finally {
      if (inflight === run) inflight = null;
    }
  },
};
