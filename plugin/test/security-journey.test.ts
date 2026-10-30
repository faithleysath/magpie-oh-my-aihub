// Phase 8 security journey: the loopback API and the page snapshot.
//
// The handler is tested directly (a Request in, a Response out): no socket, no
// working-directory change, no file written into the repository. The page
// snapshot is tested through its pure projection, because the file writer only
// adds the mode and the atomic rename.
//
// Written before the implementation on purpose: every assertion below failed
// against the phase-7 `GET`s that answered before the token check.

import { describe, expect, test } from "bun:test";
import { createHandler, hostAllowed, tokenMatches } from "../src/server.ts";
import { maskSensitiveText, projectPageStatus } from "../src/page-snapshot.ts";

const TOKEN = "c".repeat(64);
const PORT = 45678;
const PAYER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TX = "0xe3afa08300ba0d08a0fbf2cd7a6f9c1f402d2dbd221989e2a8cb53ee160b5943";
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const RPC_URL = "https://base-sepolia.g.alchemy.com/v2/SECRETKEY123";
const HOME = "/Users/operator/.config/magpie";

function statusFixture() {
  return {
    plugin: { version: "0.4.0", pid: 4242, dataDir: HOME, startedAt: "2026-10-30T00:00:00.000Z", stateVersion: 3 },
    magpie: { version: "magpie 0.1.2038", gateway: "http://127.0.0.1:3425" },
    config: {
      role: "provider",
      sharingEnabled: true,
      sharingActive: true,
      shareSuspended: null,
      consumingEnabled: true,
      nodeId: "d4c7a837",
      hostname: "ohmyaihub-d4c7a837",
      networkName: "lab",
      networkSecret: "not-for-the-page",
      peers: ["tcp://relay.example:11010"],
      virtualIpv4: "10.77.0.70/24",
      proxyCidr: "127.0.0.1/32",
      mappedCidr: "10.66.62.217/32",
      publishedPorts: [3425],
      secureMode: true,
      rpcPort: 17888,
      share: { models: ["*"] },
      nativeProviders: ["alpha"],
      remoteProviders: [],
      catalog: { enabled: false, discoveryEnabled: false, displayName: null, contact: null, port: 3426, socksPort: 13400, refreshSec: 20, minTopUpUsd: 1 },
    },
    easytier: {
      sharingEnabled: true,
      consumingEnabled: true,
      hostname: "ohmyaihub-d4c7a837",
      running: true,
      pid: 4242,
      startedAt: "2026-10-30T00:00:00.000Z",
      restarts: 0,
      lastError: `cannot read ${HOME}/easytier/current.toml from ${RPC_URL}`,
      coreVersion: "2.6.4",
      rpcPort: 17888,
      networkName: "lab",
      virtualIpv4: "10.77.0.70/24",
      proxyCidr: "127.0.0.1/32",
      mappedCidr: "10.66.62.217/32",
      publishedPorts: [3425],
      peers: [{ hostname: "peer-b", ipv4: "10.77.0.2", cost: "p2p", latencyMs: "3", loss: "0", tunnel: "direct", nat: "public", id: "42" }],
      secureMode: true,
      socks5Port: 13400,
      aclOk: true,
      aclProblems: [`configuration at ${HOME}/easytier/current.toml mentions ${PAYER}`],
      lastCheckAt: "2026-10-30T00:00:00.000Z",
    },
    consumers: [
      {
        consumerId: "alice",
        keyName: "alice",
        keyId: "key-1",
        models: ["alpha/a"],
        capUsd: 1,
        creditedUsd: 1,
        usedUsd: 0.25,
        leftUsd: 0.75,
        calls: 3,
        spent: false,
        revokedAt: null,
        ledger: { balanceUsd: 0.75, uncertain: null, openSettlements: 0, gaps: [] },
        paused: null,
      },
      {
        consumerId: "bob",
        keyName: "bob",
        keyId: "key-2",
        models: ["alpha/a"],
        capUsd: 1,
        creditedUsd: 1,
        usedUsd: 1,
        leftUsd: 0,
        calls: 9,
        spent: true,
        revokedAt: null,
        ledger: { balanceUsd: 0, uncertain: null, openSettlements: 0, gaps: [] },
        paused: null,
      },
    ],
    accounting: {
      intervalMs: 10000,
      maxDetectionMs: 30000,
      lastCheckAt: "2026-10-30T00:00:00.000Z",
      lastCheckMs: 5,
      lastOkAt: "2026-10-30T00:00:00.000Z",
      failures: 0,
      uncertain: false,
      uncertainReason: null,
      paused: [{ consumerId: "alice", reason: "price-mismatch", enforcement: "keyRevoked", enforced: true }],
      serving: true,
    },
    providers: [
      {
        id: "peer-b",
        remoteMagpieId: "peer-b",
        mappedCidr: "10.66.1.2/32",
        providerPort: 3425,
        localPort: 13425,
        url: "http://127.0.0.1:13425",
        keyRef: "peer-b",
        status: "connected",
        detail: `probe failed at ${HOME}/x`,
        fingerprint: { hostname: "ohmyaihub-b", virtualIpv4: "10.77.0.2", peerId: "7" },
        limit: { cost: 0, costLimit: 1, calls: 0, spent: false },
        createdAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
        lastConnectedAt: "2026-10-30T00:00:00.000Z",
      },
    ],
    catalog: {
      config: { enabled: false, discoveryEnabled: false, displayName: null, contact: null, port: 3426, socksPort: 13400, refreshSec: 20, minTopUpUsd: 1 },
      publishing: false,
      server: { running: false, port: null, address: null, error: null },
      quote: {
        version: 1,
        updatedAt: "2026-10-30T00:00:00.000Z",
        publishedAt: "2026-10-30T00:00:00.000Z",
        contentHash: "d".repeat(64),
        modelCount: 1,
        models: [{
          id: "alpha/a", displayName: `at ${RPC_URL}`, gatewayApis: ["chat"], nativeApis: ["chat"], contextWindow: 1, maxOutputTokens: 1,
          images: false, modalities: null, reasoningLevels: null,
          pricing: { unit: "USD per 1M tokens", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, source: "magpie-settings" },
          capabilitiesSource: "magpie-settings",
        }],
        identity: { algorithm: "ed25519", publicKey: "BASE64", fingerprint: "f".repeat(64), keyId: "f".repeat(16), createdAt: "2026-10-30T00:00:00.000Z" },
      },
      peers: [{
        hostname: "peer-b",
        virtualIpv4: "10.77.0.2",
        mappedCidr: "10.66.1.2/32",
        catalogPort: 3426,
        route: "p2p",
        latencyMs: 12,
        tunnel: null,
        status: "verified",
        detail: `probe failed at ${HOME}/x`,
        nodeId: "n2",
        identity: { algorithm: "ed25519", publicKey: "BASE64B", fingerprint: "e".repeat(64), keyId: "e".repeat(16), createdAt: "2026-10-30T00:00:00.000Z" },
        pendingFingerprint: null,
        quote: {
          schema: "ohmyaihub.catalog/v1",
          node: { id: "n2", displayName: "Peer B", hostname: "ohmyaihub-b", virtualIpv4: "10.77.0.2", mappedCidr: "10.66.1.2/32", gatewayPort: 3425, catalogPort: 3426, contact: `reach me at ${HOME}/x` },
          publication: { status: "published", version: 2, updatedAt: "2026-10-30T00:00:00.000Z", publishedAt: "2026-10-30T00:00:00.000Z", note: "public" },
          models: [{
            id: "alpha/a", displayName: `at ${RPC_URL}`, gatewayApis: ["chat"], nativeApis: ["chat"], contextWindow: 1, maxOutputTokens: 1,
            images: false, modalities: null, reasoningLevels: null,
            pricing: { unit: "USD per 1M tokens", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, source: "magpie-settings" },
            capabilitiesSource: "magpie-settings",
          }],
          topUp: { minUsd: 1, simulated: true, note: "simulated" },
          billing: { quoteOnly: true, charged: false, note: "quote only", priceVersion: null, priceLocked: false },
          identity: { algorithm: "ed25519", publicKey: "BASE64B", fingerprint: "e".repeat(64), keyId: "e".repeat(16), createdAt: "2026-10-30T00:00:00.000Z" },
          signature: "sig",
        },
        quoteHash: "d".repeat(64),
        fetchedAt: "2026-10-30T00:00:00.000Z",
        connectedProviderId: null,
      }],
      lastRefreshAt: null,
      refreshing: false,
      error: null,
    },
    checks: [
      { name: "gateway-key-required", ok: true, kind: "local", at: "2026-10-30T00:00:00.000Z", detail: `401 from http://127.0.0.1:3425/v1/models (${HOME}/evidence)` },
    ],
    checksAt: "2026-10-30T00:00:00.000Z",
    checksDurationMs: 12,
    readiness: { state: "ready", checkedAt: "2026-10-30T00:00:00.000Z", ageMs: 100, source: "cached", reasons: [`see ${HOME}/x`], providers: [{ id: "peer-b", reachability: "reachable" }] },
    wallet: {
      disabled: false,
      registry: {
        networks: [
          {
            chainId: 97,
            displayName: "BSC Testnet",
            networkType: "testnet",
            enabled: true,
            blockExplorer: "https://testnet.bscscan.com",
            finality: { mode: "confirmations", confirmations: 15, rationale: "BSC testnet reports finalized == latest" },
            endpoints: [RPC_URL],
          },
        ],
        assets: [
          {
            assetId: `eip155:97:${CONTRACT}`,
            chainId: 97,
            symbol: "tMOCK6",
            name: "Test Mock 6",
            decimals: 6,
            contractAddress: CONTRACT,
            enabled: true,
            testnetOnly: true,
            issuerType: "mock",
            nanosPerToken: "1000000000",
            priceVersion: "rate-1",
          },
        ],
      },
      chains: [
        {
          chainId: 97,
          displayName: "BSC Testnet",
          enabled: true,
          networkType: "testnet",
          blockExplorer: "https://testnet.bscscan.com",
          endpoints: [{ url: RPC_URL, ok: true, lastError: null, latencyMs: 20 }],
          head: 100,
          finalizedBlock: 85,
          cursor: 100,
          cursorHash: TX,
          lagBlocks: 15,
          lastScanAt: "2026-10-30T00:00:00.000Z",
          lastError: null,
          finality: { mode: "confirmations", confirmations: 15, rationale: "…" },
          assets: [{ assetId: `eip155:97:${CONTRACT}`, symbol: "tMOCK6", decimals: 6, enabled: true, onchainDecimals: 6, decimalsOk: true }],
        },
      ],
      intents: [
        {
          invoiceId: "inv-1",
          providerId: "p1",
          consumerId: "alice",
          chainId: 97,
          assetId: `eip155:97:${CONTRACT}`,
          tokenContract: CONTRACT,
          recipientAddress: PAYER,
          expectedAmountRaw: "1000000",
          requestedAt: "2026-10-30T00:00:00.000Z",
          expiresAt: "2026-10-30T01:00:00.000Z",
          payerAddress: PAYER,
          attributionStatus: "matched",
          priceVersion: "rate-1",
          status: "matched",
          nonce: "1",
          digest: TX,
          createdAt: "2026-10-30T00:00:00.000Z",
          rateNanosPerToken: "1000000000",
        },
      ],
      events: [
        {
          id: `chain:97:${CONTRACT}:${TX}:0`,
          chainId: 97,
          tokenContract: CONTRACT,
          txHash: TX,
          logIndex: 0,
          blockNumber: 90,
          blockHash: TX,
          fromAddress: PAYER,
          toAddress: PAYER,
          amountRaw: "1000000",
          status: "credited",
          invoiceId: "inv-1",
          depositId: "d-1",
          confirmations: 15,
          firstSeenAt: "2026-10-30T00:00:00.000Z",
        },
      ],
      anomalies: [{ id: 1, chainId: 97, kind: "reorg", detail: `credited event ${TX} was reverted`, at: "2026-10-30T00:00:00.000Z", resolvedAt: null, resolutionNote: null }],
      receiving: [{ providerId: "p1", chainId: 97, address: PAYER, addedAt: "2026-10-30T00:00:00.000Z" }],
      totals: { credited: 1, finalized: 0, pending: 0, unclaimed: 0, uncertain: 0, reverted: 0, creditedNanos: 1000000000, events: 1 },
      consumers: [{ consumerId: "alice", balanceUsd: 0.75, depositedUsd: 1, events: [] }],
    },
    logs: [`chain 97: 1000000 of tMOCK6 from ${PAYER} credited as 1000000000 nanos to alice`],
    wiring: { id: "peer-b", mappedCidr: "10.66.1.2/32", url: "http://127.0.0.1:13425", createdAt: "2026-10-30T00:00:00.000Z" },
  };
}

function fakeService() {
  const status = statusFixture();
  return {
    status: async () => status,
    checks: async () => status.checks,
    config: () => status.config,
    providers: () => status.providers,
    catalogStatus: () => status.catalog,
    peersInDirectory: () => status.catalog.peers,
    accountingStatus: () => status.accounting,
    walletStatus: async () => status.wallet,
    walletEvidence: async () => ({
      wallet: status.wallet,
      consumers: status.consumers,
      deposits: {},
      readbacks: {},
      accounting: { state: "ok", reason: null, serving: true },
    }),
    walletStatement: async (consumerId: string) => ({ consumerId, deposits: [], events: [], balance: 0 }),
    walletModule: () => ({
      intents: () => status.wallet.intents,
      chainStore: () => ({ anomalies: () => status.wallet.anomalies }),
      status: async () => status.wallet,
    }),
    requireWallet: () => ({ chainStore: () => ({ anomalies: () => [] }) }),
    configure: async (body: Record<string, unknown>) => {
      throw new Error(`configure refused the secret ${String(body.networkSecret)}`);
    },
  };
}

function handler() {
  return createHandler(fakeService() as never, TOKEN, PORT);
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, ...headers } });
}

function authed(path: string, headers: Record<string, string> = {}): Request {
  return get(path, { authorization: `Bearer ${TOKEN}`, ...headers });
}

const sensitiveGets = [
  "/status",
  "/",
  "/checks",
  "/providers",
  "/catalog",
  "/catalog/peers",
  "/accounting",
  "/consumers",
  "/wallet",
  "/wallet/networks",
  "/wallet/assets",
  "/wallet/intents",
  "/wallet/events",
  "/wallet/anomalies",
  "/wallet/evidence",
  "/wallet/statement?consumerId=alice",
];

describe("the loopback API", () => {
  test("only /health is anonymous, and it says nothing", async () => {
    const res = await handler()(get("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("every sensitive GET is refused without the token, and leaks nothing", async () => {
    for (const path of sensitiveGets) {
      const res = await handler()(get(path));
      expect(res.status, `${path} must require the token`).toBe(401);
      const body = await res.text();
      expect(body).not.toContain("alice");
      expect(body).not.toContain(PAYER);
      expect(body).not.toContain("wallet");
    }
  });

  test("a POST without the token is refused before the body is read", async () => {
    const res = await handler()(
      new Request(`http://127.0.0.1:${PORT}/configure`, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "provider" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("a valid token reads the same routes", async () => {
    const h = handler();
    for (const path of ["/status", "/consumers", "/wallet", "/wallet/intents", "/checks", "/providers", "/catalog", "/accounting"]) {
      const res = await h(authed(path));
      expect(res.status, path).toBe(200);
    }
    const status = await (await h(authed("/status"))).json();
    expect(status.consumers[0].consumerId).toBe("alice");
  });

  test("Host must be loopback and the actual port", async () => {
    expect(hostAllowed(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(hostAllowed(`localhost:${PORT}`, PORT)).toBe(true);
    expect(hostAllowed(`LOCALHOST:${PORT}`, PORT)).toBe(true);
    expect(hostAllowed(`127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(hostAllowed(`127.0.0.1`, PORT)).toBe(false);
    expect(hostAllowed(`evil.example:${PORT}`, PORT)).toBe(false);
    expect(hostAllowed(`127.0.0.1:${PORT}.evil.example`, PORT)).toBe(false);
    expect(hostAllowed(null, PORT)).toBe(false);

    const h = handler();
    for (const host of [`evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, `127.0.0.1`]) {
      const res = await h(authed("/status", { host }));
      expect(res.status, host).toBe(403);
    }
    expect((await h(authed("/status", { host: `127.0.0.1:${PORT}` }))).status).toBe(200);
    expect((await h(authed("/status", { host: `localhost:${PORT}` }))).status).toBe(200);
    // the host check comes first: a foreign Host is refused even anonymously
    expect((await h(get("/status", { host: `evil.example:${PORT}` }))).status).toBe(403);
  });

  test("a cross-origin request is refused even with the token", async () => {
    const res = await handler()(authed("/status", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  test("the bearer comparison is exact", () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches(`Bearer ${"c".repeat(63)}`, TOKEN)).toBe(false);
  });

  test("a body that is not a JSON object is a 400, and the payload is not echoed", async () => {
    const h = handler();
    const sentinel = "must-not-be-echoed-42";
    for (const body of ["[]", "null", `"${sentinel}"`, "1", "true"]) {
      const res = await h(
        new Request(`http://127.0.0.1:${PORT}/configure`, {
          method: "POST",
          headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body,
        }),
      );
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(sentinel);
    }
    const invalid = await h(
      new Request(`http://127.0.0.1:${PORT}/configure`, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: `{${sentinel}`,
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(sentinel);
  });

  test("a non-JSON content type is a 415 and an oversized body is a 413", async () => {
    const h = handler();
    const text = await h(
      new Request(`http://127.0.0.1:${PORT}/configure`, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
        body: "hello",
      }),
    );
    expect(text.status).toBe(415);

    const big = "x".repeat(65 * 1024);
    const res = await h(
      new Request(`http://127.0.0.1:${PORT}/configure`, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": String(big.length + 16) },
        body: JSON.stringify({ padding: big }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("a service error is redacted and does not echo the payload", async () => {
    const secret = "sk-abcdefghijklmnop";
    const res = await handler()(
      new Request(`http://127.0.0.1:${PORT}/configure`, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ networkSecret: secret }),
      }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("<redacted-key>");
  });

  test("a wrong method on a known route is a 405 after auth", async () => {
    const res = await handler()(
      new Request(`http://127.0.0.1:${PORT}/status`, {
        method: "PUT",
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(405);
  });
});

describe("the page snapshot", () => {
  const input = statusFixture();
  const projected = projectPageStatus(input);
  const json = JSON.stringify(projected);

  test("keeps the public node state the page needs", () => {
    expect((projected as any).schema).toBe("oh-my-aihub/page/2");
    expect((projected as any).plugin.pid).toBe(4242);
    expect((projected as any).config.networkName).toBe("lab");
    expect((projected as any).config.publishedPorts).toEqual([3425]);
    expect((projected as any).easytier.running).toBe(true);
    expect((projected as any).consumers.map((c: any) => c.consumerId)).toEqual(["alice", "bob"]);
    expect((projected as any).consumers.map((c: any) => c.spent)).toEqual([false, true]);
    expect((projected as any).consumersSummary).toEqual({ total: 2, open: 1, paused: 0, spent: 1, revoked: 0 });
    expect((projected as any).providers[0].limit).toEqual({ spent: false });
    expect((projected as any).providersSummary).toEqual({ total: 1, connected: 1, degraded: 0, spent: 0 });
    expect((projected as any).checks[0].name).toBe("gateway-key-required");
    expect((projected as any).readiness.providers[0].reachability).toBe("reachable");
    expect((projected as any).wallet.totals.credited).toBe(1);
    expect((projected as any).wallet.networks[0].chainId).toBe(97);
    expect((projected as any).wallet.assets[0].onchainDecimals).toBe(6);
    expect((projected as any).wallet.assets[0].contractAddress).toBe(CONTRACT);
  });

  test("never carries per-consumer money, payment linkage, RPC credentials, paths or logs", () => {
    for (const banned of [
      "payerAddress",
      "recipientAddress",
      "txHash",
      "fromAddress",
      "toAddress",
      "blockHash",
      "endpoints",
      "dataDir",
      "wiring",
      "keyRef",
      "networkSecret",
      "creditedNanos",
      "capUsd",
      "usedUsd",
      "leftUsd",
      "balanceUsd",
      "creditedUsd",
      "costLimit",
      "costLeft",
      "calls",
      "ledger",
      "intents",
      "receiving",
      "anomalies",
      "consumers\":[{\"consumerId\":\"alice\",\"balance",
      "SECRETKEY123",
      HOME,
      "not-for-the-page",
    ]) {
      expect(json, banned).not.toContain(banned);
    }
    expect(json).not.toContain(PAYER);
    expect(json).not.toContain(TX);
    expect((projected as any).logs).toBeUndefined();
    expect((projected as any).wallet.consumers).toBeUndefined();
    expect((projected as any).wallet.events).toBeUndefined();
    expect((projected as any).plugin.dataDir).toBeUndefined();
  });

  test("scrubs free text but not public contract addresses", () => {
    const p = projected as any;
    expect(p.easytier.lastError).not.toContain(HOME);
    expect(p.easytier.lastError).not.toContain("SECRETKEY123");
    expect(p.easytier.aclProblems[0]).not.toContain(PAYER);
    expect(p.checks[0].detail).not.toContain(HOME);
    expect(p.readiness.reasons[0]).not.toContain(HOME);
    expect(p.providers[0].detail).not.toContain(HOME);
    expect(p.wallet.assets[0].contractAddress).toBe(CONTRACT);
    expect(p.catalog.quote.version).toBe(1);
    expect(p.catalog.quote.modelCount).toBe(1);
    expect(p.catalog.quote.contentHash).toBe("d".repeat(64));
    expect(p.catalog.quote.models[0].displayName).toContain("<url>");
    expect(p.catalog.quote.models[0].id).toBe("alpha/a");
    expect(p.catalog.peers[0].quote.publication.version).toBe(2);
    expect(p.catalog.peers[0].quote.billing.priceLocked).toBe(false);
    expect(p.catalog.peers[0].quote.node.contact).toContain("<path>");
    expect(p.catalog.peers[0].quote.node.contact).not.toContain(HOME);
  });

  test("an absent wallet stays absent, not a half object", () => {
    const p = projectPageStatus({ ...input, wallet: null }, (s) => s) as any;
    expect(p.wallet).toBeNull();
  });

  test("maskSensitiveText masks the four classes and leaves prose alone", () => {
    expect(maskSensitiveText(`payer ${PAYER}`)).toBe("payer <address>");
    expect(maskSensitiveText(`tx 0x${"a".repeat(64)}`)).toBe("tx <hash>");
    expect(maskSensitiveText(`GET ${RPC_URL} now`)).toBe("GET <url> now");
    expect(maskSensitiveText(`wrote ${HOME}/state.json`)).toBe("wrote <path>");
    expect(maskSensitiveText("no secrets here")).toBe("no secrets here");
  });
});

describe("the phase-8 operator routes", () => {
  const FP = "a".repeat(64);
  const QH = "b".repeat(64);
  const PV = "c".repeat(64);

  function serviceWithSpies() {
    const seen: { call: string; args: unknown[] }[] = [];
    const base = fakeService();
    const svc: any = {
      ...base,
      shareCandidates: async () => ({ policy: ["*"], models: [{ id: "alpha/a" }], priceVersion: PV, priceLocked: false, blocking: [] }),
      providerModels: async (id: string) => {
        seen.push({ call: "providerModels", args: [id] });
        return { id, models: ["alpha/a"], status: "connected", detail: null, limit: null };
      },
      reconcileProviders: async (opts: unknown) => {
        seen.push({ call: "reconcile", args: [opts] });
        return [{ id: "peer-b", status: "connected" }];
      },
      catalogRequest: (nodeId: string, models: unknown, acceptance: unknown) => {
        seen.push({ call: "catalogRequest", args: [nodeId, models, acceptance] });
        return { schema: "ohmyaihub.connection-request/v1", acceptance };
      },
      catalogConnect: async (nodeId: string, key: string, opts: unknown) => {
        seen.push({ call: "catalogConnect", args: [nodeId, key, opts] });
        return { id: "peer-b", status: "connected" };
      },
      configure: async (input: unknown) => {
        seen.push({ call: "configure", args: [input] });
        return {};
      },
      trustCatalogPeer: async (nodeId: string, fingerprint: string) => {
        seen.push({ call: "trust", args: [nodeId, fingerprint] });
        return { accepted: true };
      },
    };
    return { h: createHandler(svc as never, TOKEN, PORT), seen };
  }

  function post(path: string, body: unknown): Request {
    return new Request(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST",
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("GET /share/candidates is token protected and returns the view", async () => {
    const { h } = serviceWithSpies();
    expect((await h(get("/share/candidates"))).status).toBe(401);
    const res = await h(authed("/share/candidates"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates.models[0].id).toBe("alpha/a");
  });

  test("POST /providers/models probes exactly the named provider", async () => {
    const { h, seen } = serviceWithSpies();
    const res = await h(post("/providers/models", { id: "peer-b" }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ call: "providerModels", args: ["peer-b"] }]);
    expect((await res.json()).models).toEqual(["alpha/a"]);
  });

  test("POST /catalog/trust requires the exact reviewed fingerprint", async () => {
    const { h, seen } = serviceWithSpies();
    expect((await h(post("/catalog/trust", { nodeId: "n1" }))).status).toBe(400);
    expect((await h(post("/catalog/trust", { nodeId: "n1", fingerprint: "abc" }))).status).toBe(400);
    expect((await h(post("/catalog/trust", { nodeId: "n1", fingerprint: "A".repeat(64) }))).status).toBe(400);
    expect(seen).toHaveLength(0);
    const ok = await h(post("/catalog/trust", { nodeId: "n1", fingerprint: "a".repeat(64) }));
    expect(ok.status).toBe(200);
    expect(seen[0]).toEqual({ call: "trust", args: ["n1", "a".repeat(64)] });
  });

  test("POST /catalog/request requires the exact accepted fingerprint and quote hash", async () => {
    const { h, seen } = serviceWithSpies();
    const bad = await h(post("/catalog/request", { nodeId: "node-1", fingerprint: "abc", quoteHash: QH }));
    expect(bad.status).toBe(400);
    expect(seen).toHaveLength(0);
    const good = await h(post("/catalog/request", { nodeId: "node-1", models: ["alpha/a"], fingerprint: FP, quoteHash: QH, priceVersion: PV }));
    expect(good.status).toBe(200);
    expect(seen[0]).toEqual({ call: "catalogRequest", args: ["node-1", ["alpha/a"], { fingerprint: FP, quoteHash: QH, priceVersion: PV }] });
  });

  test("POST /catalog/connect forwards the same acceptance", async () => {
    const { h, seen } = serviceWithSpies();
    const res = await h(post("/catalog/connect", { nodeId: "node-1", key: "sk-test", id: "peer-b", fingerprint: FP, quoteHash: QH }));
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual({
      call: "catalogConnect",
      args: ["node-1", "sk-test", { id: "peer-b", acceptance: { fingerprint: FP, quoteHash: QH } }],
    });
    expect(await res.text()).not.toContain("sk-test");
  });

  test("/configure validates every field instead of casting it", async () => {
    const { h, seen } = serviceWithSpies();
    for (const bad of [
      { sharingEnabled: "false" },
      { consumingEnabled: 1 },
      { rpcPort: "17888" },
      { publishedPorts: ["3425"] },
      { peers: "tcp://relay:11010" },
      { shareModels: [{}] },
      { listenAddr: 11010 },
      { catalogMinTopUpUsd: -1 },
      { wat: true },
    ]) {
      const res = await h(post("/configure", bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(seen.filter((s) => s.call === "configure")).toHaveLength(0);
    const ok = await h(post("/configure", { sharingEnabled: true, peers: ["tcp://relay:11010"], publishedPorts: [3425] }));
    expect(ok.status).toBe(200);
    expect(seen.find((s) => s.call === "configure")!.args[0]).toEqual({ sharingEnabled: true, peers: ["tcp://relay:11010"], publishedPorts: [3425] });
  });

  test("a chunked body is cut off at 64 KiB, not buffered", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(encoder.encode("x".repeat(10 * 1024)));
        controller.close();
      },
    });
    const req = new Request(`http://127.0.0.1:${PORT}/configure`, {
      method: "POST",
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await serviceWithSpies().h(req);
    expect(res.status).toBe(413);
  });

  test("the token-only wallet evidence and statement are direct objects", async () => {
    const { h } = serviceWithSpies();
    const evidence = await h(authed("/wallet/evidence"));
    expect(evidence.status).toBe(200);
    const evidenceBody = await evidence.json();
    expect(Array.isArray(evidenceBody.consumers)).toBe(true);
    expect(evidenceBody.accounting.state).toBe("ok");

    expect((await h(authed("/wallet/statement"))).status).toBe(400);
    expect((await h(authed("/wallet/statement?consumerId=%20"))).status).toBe(400);
    const statement = await h(authed("/wallet/statement?consumerId=alice"));
    expect(statement.status).toBe(200);
    expect((await statement.json()).consumerId).toBe("alice");
  });

  test("POST /providers/reconcile passes only the requested id", async () => {
    const { h, seen } = serviceWithSpies();
    const res = await h(post("/providers/reconcile", { id: "peer-b", verifyModels: true }));
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual({ call: "reconcile", args: [{ verifyModels: true, only: "peer-b" }] });
    const body = await res.json();
    expect(body.providers.map((p: any) => p.id)).toEqual(["peer-b"]);
  });
});
