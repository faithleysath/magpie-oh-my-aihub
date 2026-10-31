// Test-only child process: one real Service + one real ControlApp + a local
// test-control endpoint. Cross-node traffic still goes through the real control
// HTTP listener; the test endpoint only calls local app/Service actions.
//
// This file is executed with a per-node cwd (state dir) by the test harness.

import { keyIdOf, loadCatalogTrust, loadOrCreateCatalogIdentity, saveCatalogTrust, type CatalogModel } from "../../src/catalog.ts";
import { providerIdFor } from "../../src/control/service-port.ts";
import { startControlApp } from "../../src/control/app.ts";
import { Service, type Probes } from "../../src/service.ts";
import type { PluginConfig } from "../../src/state.ts";
import { fakePortOwnership } from "./fake-ports.ts";
import { HttpFixtureMagpie, HttpFixtureSupervisor, LAB_MODEL } from "./http-node-fixture.ts";

const role = process.env.ROLE === "consumer" ? "consumer" : "provider";
const nodeId = process.env.NODE_ID ?? (role === "provider" ? "aa11bb22" : "cc33dd44");
const providerNodeId = process.env.PROVIDER_NODE_ID ?? "aa11bb22";
const providerFingerprint = process.env.PROVIDER_FINGERPRINT ?? "";
const quoteHash = process.env.QUOTE_HASH ?? "ab".repeat(32);
const capUsd = Number(process.env.CAP_USD ?? "1");
const testToken = process.env.TEST_TOKEN ?? "";
const mappedCidr = "10.66.1.2/32";
const gatewayPort = 3425;
const catalogPort = 3426;

const MODEL: CatalogModel = {
  id: LAB_MODEL,
  displayName: null,
  gatewayApis: ["chat"],
  nativeApis: ["chat"],
  contextWindow: null,
  maxOutputTokens: null,
  images: null,
  modalities: null,
  reasoningLevels: null,
  pricing: { unit: "USD per 1M tokens", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, source: "magpie-settings" },
  capabilitiesSource: "magpie-settings",
};

const magpie = new HttpFixtureMagpie();
const sup = new HttpFixtureSupervisor();
const identity = loadOrCreateCatalogIdentity();
let currentQuoteHash = quoteHash;

const config: PluginConfig = {
  sharingEnabled: role === "provider",
  consumingEnabled: true,
  nodeId,
  instanceId: `i${nodeId}`,
  networkName: "http-lab",
  networkSecret: "http-lab-fixture",
  peers: [],
  listenAddr: null,
  virtualIpv4: "10.77.0.2",
  overlayCidr: "10.77.0.0/24",
  rpcPort: 17888,
  proxyCidr: role === "provider" ? "192.0.2.84" : null,
  mappedCidr: role === "provider" ? mappedCidr : null,
  publishedPorts: [],
  secureMode: false,
  secureIdentity: null,
  share: { models: ["*"] },
  catalog: {
    enabled: true,
    discoveryEnabled: false,
    displayName: null,
    contact: null,
    port: catalogPort,
    socksPort: 13400,
    refreshSec: 60,
    minTopUpUsd: 1,
  },
  controlEnabled: true,
  controlPort: null,
};

const quoteView = {
  version: 1,
  updatedAt: "2026-10-31T00:00:00.000Z",
  publishedAt: "2026-10-31T00:00:00.000Z",
  contentHash: currentQuoteHash,
  modelCount: 1,
  models: [MODEL],
  billing: { quoteOnly: true, charged: false, note: "fixture", priceVersion: null, priceLocked: false },
  identity: identity.summary,
};

const providerPeer = {
  nodeId: providerNodeId,
  hostname: `ohmyaihub-${providerNodeId}`,
  status: "verified",
  online: true,
  mappedCidr,
  catalogPort,
  quoteHash,
  quoteVersion: 1,
  identity: { fingerprint: providerFingerprint, publicKey: "", keyId: "", algorithm: "ed25519", createdAt: "" },
  quote: { node: { gatewayPort, catalogPort }, models: [MODEL] },
  lastSeenAt: "2026-10-31T00:00:00.000Z",
};

const probes: Partial<Probes> = {
  statusWith: async () => true,
  catalogModels: async () => magpie.metas,
  localModelIds: async () => magpie.modelIds(),
  remoteModelIds: async () => [LAB_MODEL],
  remoteLimit: async () =>
    ({ limited: true, key: "fixture", limit: { costLimit: capUsd, cost: 0, costLeft: capUsd, calls: 0, spent: false } }) as never,
  catalogHttpGet: async () => ({ status: 404, body: "" }),
};

const service = new Service({
  magpie: magpie as never,
  magpieVersion: "fixture-0.1.2289",
  supervisor: sup as never,
  ports: { ownership: fakePortOwnership() },
  lanIp: () => "127.0.0.1",
  probeTimeoutMs: 300,
  probes,
});
(service as unknown as { state: { config: PluginConfig } }).state.config = config;
// The fixture supervisor is "running" so forward-owner proofs have a live PID.
(sup as unknown as { cfg: Record<string, unknown> }).cfg = {
  nodeId,
  sharingEnabled: config.sharingEnabled,
  consumingEnabled: config.consumingEnabled,
  portForwards: [],
  networkName: config.networkName,
  networkSecret: config.networkSecret,
};
(service as unknown as { writeSnapshot: () => void }).writeSnapshot = () => {};
(service as unknown as { publishCatalogNow: () => Promise<void> }).publishCatalogNow = async () => {};
(service as unknown as { catalogStatus: () => unknown }).catalogStatus = () =>
  ({
    config,
    publishing: { published: false, version: 0, updatedAt: null, reason: "fixture" },
    server: { running: false, port: null, address: null, error: null },
    quote: role === "provider" ? quoteView : null,
    peers: role === "consumer" ? [providerPeer] : [],
    lastRefreshAt: null,
    refreshing: false,
    error: null,
  }) as never;
(service as unknown as { requestApprovalContext: () => unknown }).requestApprovalContext = () => ({
  provider: { nodeId, mappedCidr: role === "provider" ? mappedCidr : null, gatewayPort },
  quote: role === "provider" ? { contentHash: currentQuoteHash, identity: identity.summary, models: [MODEL] } : null,
});

if (role === "consumer" && providerFingerprint) {
  const trust = loadCatalogTrust();
  const publicKey = process.env.PROVIDER_PUBLIC_KEY ?? "";
  const now = new Date().toISOString();
  trust[providerNodeId] = {
    nodeId: providerNodeId,
    overlayHostname: `ohmyaihub-${providerNodeId}`,
    publicKey,
    fingerprint: providerFingerprint,
    keyId: publicKey ? keyIdOf(publicKey) : "",
    firstSeenAt: now,
    lastSeenAt: now,
    quoteVersion: 1,
    quoteHash,
    accepted: true,
    pending: null,
  };
  saveCatalogTrust(trust);
}

const app = await startControlApp(service, { host: "127.0.0.1", tickMs: 4000, allowLanDirect: true });
if (!app) {
  console.error("control app did not start");
  process.exit(1);
}

function json(value: unknown): Response {
  return Response.json(value);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

async function action(name: string, input: Record<string, unknown>): Promise<Response> {
  try {
    switch (name) {
      case "request":
        return json(await app!.request(input));
      case "quotePreview":
        return json(await app!.quotePreview(input));
      case "approve":
        return json(await app!.approve(input));
      case "revoke":
        await app!.revoke(input);
        return json({ ok: true });
      case "reject":
        await app!.reject(input);
        return json({ ok: true });
      case "state":
        return json(await app!.state());
      case "requests":
        return json(await app!.node.listRequests());
      case "approvals":
        return json(await app!.node.listApprovals());
      case "keys":
        return json(magpie.keyList().map((k) => ({ id: k.id, name: k.name, models: k.models, cap: k.cap })));
      case "outbox": {
        const store = (app!.node as unknown as { store: { db: { query: (sql: string) => { all: () => unknown } } } }).store;
        return json(store.db.query("SELECT type, state, attempts, last_error FROM p2p_outbox ORDER BY type").all());
      }
      case "providers":
        return json({
          service: service.providers().map((p) => ({ id: p.id, status: p.status, models: p.models, detail: p.detail })),
          magpie: magpie.providers_().map((p) => ({ id: p.id, preset: p.preset })),
        });
      case "registerPeer": {
        const host = text(input.host, "host");
        const port = Number(input.port);
        const hostHeader = text(input.hostHeader, "hostHeader");
        const controlPort = Number(input.controlPort);
        app!.registerPeer(
          text(input.nodeId, "nodeId"),
          {
            host,
            port,
            hostHeader,
            mappedCidr: typeof input.mappedCidr === "string" ? input.mappedCidr : mappedCidr,
            quoteHash: text(input.quoteHash, "quoteHash"),
            fingerprint: text(input.fingerprint, "fingerprint"),
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
          {
            accountId: text(input.fingerprint, "fingerprint"),
            nodeId: text(input.nodeId, "nodeId"),
            fingerprint: text(input.fingerprint, "fingerprint"),
            mappedCidr,
            controlPort,
            catalogQuoteHash: text(input.quoteHash, "quoteHash"),
          },
        );
        return json({ ok: true });
      }
      case "poll": {
        const controlPort = Number(process.env.PROVIDER_CONTROL_PORT ?? "0");
        if (!controlPort) throw new Error("PROVIDER_CONTROL_PORT is required");
        const target = {
          accountId: providerFingerprint,
          nodeId: providerNodeId,
          fingerprint: providerFingerprint,
          mappedCidr,
          controlPort,
          catalogQuoteHash: quoteHash,
        };
        return json(await app!.node.poll(target));
      }
      case "mutateQuote":
        currentQuoteHash = text(input.quoteHash, "quoteHash");
        return json({ ok: true });
      case "stop":
        setTimeout(() => process.exit(0), 10);
        return json({ ok: true });
      default:
        return json({ error: "unknown action" });
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) });
  }
}

let testServer: ReturnType<typeof Bun.serve>;
testServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req): Promise<Response> => {
    if (req.headers.get("x-test-token") !== testToken) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/info") {
      return json({
        role,
        nodeId,
        fingerprint: identity.summary.fingerprint,
        publicKey: identity.summary.publicKey,
        controlPort: app.port,
        testPort: testServer.port,
        quoteHash: currentQuoteHash,
        models: [LAB_MODEL],
        sharingEnabled: config.sharingEnabled,
        mappedCidr: config.mappedCidr,
        gatewayPort,
        catalogPort,
        providerId: providerIdFor(providerNodeId),
      });
    }
    if (url.pathname === "/action" && req.method === "POST") {
      const body = (await req.json()) as { name?: string; input?: Record<string, unknown> };
      return action(String(body.name ?? ""), body.input ?? {});
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  "READY " +
    JSON.stringify({
      role,
      nodeId,
      fingerprint: identity.summary.fingerprint,
      controlPort: app.port,
      publicKey: identity.summary.publicKey,
      testPort: testServer.port,
      quoteHash: currentQuoteHash,
      models: [LAB_MODEL],
      sharingEnabled: config.sharingEnabled,
      mappedCidr: config.mappedCidr,
      gatewayPort,
      catalogPort,
      providerId: providerIdFor(providerNodeId),
    }),
);

const stop = () => {
  try {
    app.stop();
  } catch {
    /* already stopped */
  }
  testServer.stop(true);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
