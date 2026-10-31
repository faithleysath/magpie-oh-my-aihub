/**
 * Development-only preview server for plugin/console.
 *
 * It serves the shipped static console plus FIXTURE JSON so the UI can be
 * inspected without a real Magpie/EasyTier node. It is not part of the plugin
 * runtime, is never installed by Magpie, and contains no real credentials,
 * keys, addresses or account data. Every value below is obviously synthetic.
 *
 *   bun run plugin/scripts/console-preview.ts --scenario configured --port 61390
 *   bun run plugin/scripts/console-preview.ts --scenario first-run --port 61391
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const scenario = option("scenario", "configured");
const port = Number(option("port", "61390"));
const root = resolve(import.meta.dir, "../console");

const assets: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/session.js": ["session.js", "text/javascript; charset=utf-8"],
  "/providers.js": ["providers.js", "text/javascript; charset=utf-8"],
  "/wallet.js": ["wallet.js", "text/javascript; charset=utf-8"],
};

const model = (id: string, displayName: string, input: number, output: number) => ({
  id, displayName, completePrice: true, allowedByPolicy: true,
  pricing: { input, output, cacheRead: 0.1, cacheWrite: 0.2, unit: "USD / 1M tokens", source: "magpie-settings" },
  contextWindow: 128000, maxOutputTokens: 8192, images: false,
  gatewayApis: ["openai"], reasoningLevels: [],
});

const candidates = {
  detectedAt: "2026-10-31T02:00:00.000Z",
  source: "magpie-native",
  models: [
    model("deepseek/deepseek-chat", "DeepSeek Chat", 0.27, 1.1),
    model("deepseek/deepseek-reasoner", "DeepSeek Reasoner", 0.55, 2.19),
    { id: "local/unpriced", displayName: "本机未定价模型", completePrice: false, allowedByPolicy: true },
    model("qwen/qwen3-235b", "Qwen3 235B", 0.2, 0.6),
  ],
};

const neighbor = (hostname: string, virtualIpv4: string, latencyMs: number | null, link: string, online: boolean | null) => ({
  hostname, virtualIpv4, latencyMs, lossRatePct: latencyMs === null ? null : 0, link, linkBasis: link === "direct" ? "route.next_hop_hostname=DIRECT" : "route path_len=2",
  relayVia: link === "relay" ? "studio-relay" : null, online, tunnel: "tcp", natType: "PortRestricted",
  catalogNodeId: null, catalogStatus: "verified", modelsPublished: 0, modelsAuthorizedForMe: 0, relation: "none",
  lastCatalogReadAt: "2026-10-31T02:00:00.000Z",
});

// Fixture objects are intentionally loosely typed: they only feed the browser.
function configuredState(): any {
  return {
    schema: "ohmyaihub/console/1",
    at: new Date().toISOString(),
    configured: true,
    status: {
      plugin: { version: "0.5.0", startedAt: "2026-10-31T01:00:00.000Z", stateVersion: 3 },
      magpie: { version: "0.1.2289" },
      config: {
        networkName: "studio-ai", hostname: "ohmyaihub-7f3c", virtualIpv4: "10.126.126.1",
        peers: ["tcp://198.51.100.7:11010"], sharingEnabled: true, sharingActive: true,
        consumingEnabled: true, secureMode: true, rpcPort: 45871,
        share: { models: ["deepseek/deepseek-chat", "qwen/qwen3-235b"] },
        catalog: { enabled: true, discoveryEnabled: true, port: 45872, socksPort: 45873, displayName: "Studio AI", contact: "studio@example.invalid" },
      },
      network: {
        configured: true, name: "studio-ai", state: "online", summary: "已连接 2 个其他节点 · 目录已发布",
        at: new Date().toISOString(),
        evidence: { coreVersion: "2.6.4", readAt: new Date().toISOString(), staleMs: 1200, complete: true, problems: [] },
        core: { running: true, pid: 4210, version: "2.6.4", startedAt: "2026-10-31T01:00:10.000Z", restarts: 0, state: "running", lastError: null, aclOk: true },
        thisNode: { nodeId: "7f3c9a2b1d4e5f60", hostname: "ohmyaihub-7f3c", virtualIpv4: "10.126.126.1", networkName: "studio-ai" },
        neighbors: [
          neighbor("ohmyaihub-7f3c", "10.126.126.1", null, "self", true),
          neighbor("partner-harbor", "10.126.126.2", 12, "direct", true),
          neighbor("partner-relay", "10.126.126.3", 68, "relay", null),
        ],
        ports: [
          { purpose: "easytier-rpc", label: "本机管理端口", host: "127.0.0.1", port: 45871, owner: "easytier", reachability: "loopback", editable: false, state: "stable", verifiedAt: new Date().toISOString(), detail: null },
          { purpose: "catalog", label: "目录发布端口", host: "198.51.100.7", port: 45872, owner: "easytier", reachability: "lan", editable: false, state: "stable", verifiedAt: new Date().toISOString(), detail: null },
          { purpose: "catalog-socks", label: "目录查询端口", host: "127.0.0.1", port: 45873, owner: "easytier", reachability: "loopback", editable: false, state: "migrated", verifiedAt: new Date().toISOString(), detail: "旧端口已迁移" },
          { purpose: "gateway", label: "Magpie 网关端口", host: null, port: null, owner: "magpie", reachability: "unknown", editable: false, state: "unverified", verifiedAt: null, detail: "由 Magpie 自己监听" },
          { purpose: "overlay-listen", label: "网络监听地址", host: "198.51.100.7", port: 11010, owner: "easytier", reachability: "lan", editable: false, state: "stable", verifiedAt: new Date().toISOString(), detail: null },
        ],
        catalog: { publishing: true, address: "ohmyaihub-7f3c.et.internal", port: 45872, error: null, modelCount: 2 },
        catalogPeers: [],
      },
      easytier: { running: true, coreVersion: "2.6.4", peers: [] },
      providers: [{
        id: "provider-harbor", remoteMagpieId: "magpie-harbor", url: "http://127.0.0.1:45901",
        mappedCidr: "10.126.126.2/32", status: "connected", lastConnectedAt: "2026-10-31T01:30:00.000Z",
        fingerprint: { hostname: "partner-harbor" },
        limit: { costLimit: 2.5, cost: 0.42, costLeft: 2.08, spent: false },
      }],
      catalog: {
        enabled: true,
        peers: [{
          nodeId: "a".repeat(16), hostname: "partner-harbor", status: "verified", online: true,
          identity: { fingerprint: "f".repeat(64) }, quoteHash: "b".repeat(64),
          quote: { node: { displayName: "Harbor Studio", contact: "harbor@example.invalid" }, publication: { version: 3, updatedAt: "2026-10-31T01:40:00.000Z" }, identity: { fingerprint: "f".repeat(64) }, models: [model("qwen/qwen3-32b", "Qwen3 32B", 0.1, 0.3)] },
        }, {
          nodeId: "c".repeat(16), hostname: "partner-new", status: "unverified", online: true,
          identity: { fingerprint: "e".repeat(64) }, quoteHash: "d".repeat(64),
          quote: { node: { displayName: "New Peer" }, publication: { version: 1, updatedAt: "2026-10-31T01:45:00.000Z" }, identity: { fingerprint: "e".repeat(64) }, models: [model("deepseek/deepseek-chat", "DeepSeek Chat", 0.27, 1.1)] },
        }],
        quote: { contentHash: "9".repeat(64), identity: { fingerprint: "1".repeat(64) }, billing: { priceVersion: "2".repeat(64) }, version: 4, updatedAt: "2026-10-31T01:50:00.000Z", publishedAt: "2026-10-31T01:50:00.000Z", models: candidates.models.filter((row) => row.completePrice) },
      },
      consumers: [{
        consumerId: "partner-harbor", models: ["deepseek/deepseek-chat"], capUsd: 5, usedUsd: 0.31, leftUsd: 4.69, calls: 42,
        paused: null, revokedAt: null, priceVersion: "2".repeat(64), acceptedQuoteHash: "9".repeat(64),
        ledger: { balanceUsd: 4.69, depositedUsd: 5, consumedUsd: 0.31, uncertain: false },
      }],
      accounting: { uncertain: false, lastCheckAt: "2026-10-31T01:55:00.000Z", serving: true },
      checks: [
        { name: "magpie", ok: true, detail: "native API reachable" },
        { name: "easy-tier", ok: true, detail: "no-tun supervisor running" },
        { name: "catalog", ok: false, detail: "one peer identity is not accepted yet" },
      ],
      checksAt: "2026-10-31T01:55:00.000Z", checksDurationMs: 1200,
      readiness: { state: "degraded", reasons: ["1 个伙伴身份待核对"] },
    },
    workflows: { requests: [{ id: "request-1", status: "pending", importedAt: "2026-10-31T01:58:00.000Z", document: { consumer: { nodeId: "c".repeat(16), hostname: "partner-new" }, provider: { nodeId: "7f3c9a2b1d4e5f60" }, models: ["deepseek/deepseek-chat"], createdAt: "2026-10-31T01:58:00.000Z", quote: { identityFingerprint: "1".repeat(64), contentHash: "9".repeat(64), priceVersion: "2".repeat(64) } } }] },
    shareCandidates: candidates,
    shareCandidatesAt: "2026-10-31T02:00:00.000Z",
    wallet: {
      availability: "available", source: "local", viewAt: "2026-10-31T01:56:00.000Z", evidenceAt: "2026-10-31T01:56:00.000Z", error: null, truncated: false,
      registry: {
        networks: [
          { chainId: 97, displayName: "BSC Testnet", networkType: "testnet", enabled: true, finality: { mode: "confirmations", confirmations: 15, rationale: "testnet confirmations" }, rpcConfigured: true, rpcCount: 2, running: true },
          { chainId: 84532, displayName: "Base Sepolia", networkType: "testnet", enabled: true, finality: { mode: "finalized-tag", rationale: "finalized tag on Base" }, rpcConfigured: true, rpcCount: 1, running: false },
        ],
        assets: [
          { chainId: 97, assetId: "eip155:97:0x" + "2".repeat(40), contractAddress: "0x" + "2".repeat(40), symbol: "tUSDC", name: "Test USD", decimals: 6, enabled: true, testnetOnly: true, pricing: { nanosPerToken: "1000000000" }, priceVersion: "3".repeat(64) },
          { chainId: 84532, assetId: "eip155:84532:0x" + "4".repeat(40), contractAddress: "0x" + "4".repeat(40), symbol: "tMOCK", name: "Mock", decimals: 18, enabled: true, testnetOnly: true, pricing: { nanosPerToken: "500000000" } },
        ],
      },
      receiving: [{ chainId: 97, address: "0x" + "7".repeat(40) }],
      consumers: [{ consumerId: "partner-harbor", models: ["deepseek/deepseek-chat"], revokedAt: null, paused: null, ledger: { balanceUsd: 4.69 } }],
      intents: [{ invoiceId: "invoice-fixture-1", consumerId: "partner-harbor", providerId: "7f3c9a2b1d4e5f60", chainId: 97, assetId: "eip155:97:0x" + "2".repeat(40), expectedAmountRaw: "5000000", recipientAddress: "0x" + "7".repeat(40), payerAddress: null, status: "requested", expiresAt: "2026-11-01T01:00:00.000Z", requestedAt: "2026-10-31T01:00:00.000Z" }],
      intentOperations: [],
      anomalies: [],
      view: {
        chains: [
          { chainId: 97, displayName: "BSC Testnet", totals: { credited: 5, unclaimed: 0, uncertain: 0, pending: 0 }, lastScanAt: "2026-10-31T01:56:00.000Z", head: 44100221, finalizedBlock: 44100206, cursor: 44100206, lastError: null, rpc: [{ ok: true, lastError: null }], assets: [] },
          { chainId: 84532, displayName: "Base Sepolia", totals: { credited: 0, unclaimed: 1, uncertain: 0, pending: 0 }, lastScanAt: null, head: null, finalizedBlock: null, cursor: null, lastError: "RPC 未配置", rpc: [], assets: [] },
        ],
        consumers: [{ consumerId: "partner-harbor", capUsd: 5, usedUsd: 0.31, leftUsd: 4.69, ledger: { balanceUsd: 4.69, depositedUsd: 5, consumedUsd: 0.31, uncertain: false, gaps: [] }, accounting: { state: "ok" }, stateDetail: "最近核验额度上限未知" }],
        deposits: [{ invoiceId: "invoice-fixture-1", state: "awaiting-signature", chainId: 97, updatedAt: "2026-10-31T01:00:00.000Z", steps: [{ id: "signature", state: "current", at: null, detail: "sign in your own wallet" }, { id: "payment", state: "pending", at: null }] }],
        alerts: [],
      },
    },
  };
}

function firstRunState(): any {
  const state = configuredState();
  state.configured = false;
  state.status.config = { catalog: {}, share: { models: [] } };
  state.status.network = {
    configured: false, name: "", state: "unconfigured", summary: "尚未加入任何网络", at: new Date().toISOString(),
    evidence: { coreVersion: null, readAt: null, staleMs: null, complete: false, problems: [] },
    core: { running: false, pid: null, version: null, startedAt: null, restarts: 0, state: "stopped", lastError: null, aclOk: null },
    thisNode: null, neighbors: [], ports: [],
    catalog: { publishing: false, address: null, port: null, error: null, modelCount: 0 }, catalogPeers: [],
  };
  state.status.providers = [];
  state.status.consumers = [];
  state.status.catalog = { enabled: false, peers: [] };
  state.workflows = { requests: [] };
  state.shareCandidates = null;
  state.wallet = { ...state.wallet, availability: "uninitialized", intents: [], view: { chains: [], consumers: [], deposits: [], alerts: [] }, consumers: [], receiving: [] };
  return state;
}

let current: any = scenario === "first-run" ? firstRunState() : configuredState();
const csrf = "0".repeat(32);
const instance = "preview-instance";

const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      return new Response(readFileSync(resolve(root, file)), { headers: { "content-type": type, "cache-control": "no-store" } });
    }
    if (url.pathname === "/ui/session") {
      return json({ csrf, instance, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.pathname === "/ui/api/state") return json(current);
    if (url.pathname.startsWith("/ui/api/action/")) {
      const name = url.pathname.slice("/ui/api/action/".length);
      const input = await request.json().catch(() => ({})) as Record<string, unknown>;
      if (name === "join-network" || name === "configure") {
        current = configuredState();
        return json({ result: current });
      }
      if (name === "share-native-models") {
        current.status.config.sharingEnabled = true;
        current.status.config.sharingActive = true;
        return json({ result: current });
      }
      if (name === "stop-sharing") {
        current.status.config.sharingEnabled = false;
        current.status.config.sharingActive = false;
        current.status.config.catalog.enabled = false;
        return json({ result: current });
      }
      if (name === "network-refresh" || name === "catalog-refresh" || name === "checks") return json({ result: current });
      if (name === "share-candidates") return json({ result: candidates });
      if (name === "catalog-settings" || name === "share-models" || name === "share-toggle" || name === "catalog-publish") return json({ result: current });
      return json({ error: "action_not_allowed" }, 404);
    }
    if (url.pathname === "/ui/logout") return json({ ok: true });
    return new Response("not found", { status: 404 });
  },
});

console.log(JSON.stringify({ listening: `http://127.0.0.1:${server.port}`, scenario }));
