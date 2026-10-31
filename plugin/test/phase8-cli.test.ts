import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPriceVersion } from "../src/pricing.ts";
import { buildStatement } from "../src/walletstatement.ts";
import { readSecretFile, writeSecretFile } from "../bin/operator-lib.ts";

// Phase-8 CLI journey tests. A fake loopback host records the exact JSON the
// wizard sends; no real plugin, Magpie, EasyTier or network is used.

interface Call { method: string; path: string; body: any; auth: string }

const fingerprint = "a".repeat(64);
const quoteHash = "b".repeat(64);
const priceVersion = catalogPriceVersion([
  { id: "alpha/a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
])!;

let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
let binDir: string;
let calls: Call[];
let handlers: Map<string, (body: any) => any>;
let statusDoc: any;
let catalogDoc: any;
let providersDoc: any;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fakeStatus() {
  return {
    plugin: { version: "0.4.0", pid: 1, dataDir, startedAt: new Date().toISOString(), stateVersion: 3 },
    magpie: { version: "magpie 0.1.2038", gateway: "http://127.0.0.1:3425" },
    config: {
      role: "provider",
      sharingEnabled: true,
      sharingActive: true,
      shareSuspended: null,
      consumingEnabled: true,
      nodeId: "d".repeat(16),
      hostname: "ohmyaihub-dddddddddddddddd",
      networkName: "old-net",
      peers: ["tcp://relay.example:11010"],
      listenAddr: null,
      virtualIpv4: "10.77.0.9/24",
      proxyCidr: "127.0.0.1/32",
      mappedCidr: "10.66.1.9/32",
      publishedPorts: [3425],
      secureMode: true,
      rpcPort: 17888,
      share: { models: ["alpha/a"] },
      nativeProviders: ["alpha"],
      remoteProviders: [],
      catalog: { enabled: false, discoveryEnabled: false, displayName: null, contact: null, port: 3426, socksPort: 13400, refreshSec: 20, minTopUpUsd: 1 },
    },
    easytier: { running: true, pid: 2, coreVersion: "easytier-core 2.6.4", aclOk: true, aclProblems: [], rpcPort: 17888 },
    consumers: [],
    providers: [],
    catalog: { publishing: false, quote: null, peers: [] },
    accounting: { paused: [] },
    checks: [
      { name: "core-running", ok: true, detail: "pid 2" },
      { name: "acl", ok: true, detail: "Inbound Drop" },
      { name: "catalog-published", ok: true, detail: "published" },
      { name: "catalog-quote", ok: true, detail: "signed" },
      { name: "catalog-identity", ok: true, detail: "self-signed" },
    ],
    checksAt: "2026-10-30T00:00:00.000Z",
    readiness: { state: "ready", checkedAt: "2026-10-30T00:00:00.000Z", ageMs: 0, source: "cached", reasons: [], providers: [] },
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ohmyaihub-cli-"));
  binDir = mkdtempSync(join(tmpdir(), "ohmyaihub-bin-"));
  mkdirSync(join(dataDir, "oh-my-aihub"), { recursive: true });
  // A stub Magpie makes `setup` preflight deterministic; the host API is fake.
  const magpie = join(binDir, "magpie");
  writeFileSync(magpie, "#!/bin/sh\necho 'magpie 0.1.2038'\n");
  chmodSync(magpie, 0o755);
  calls = [];
  handlers = new Map();
  statusDoc = fakeStatus();
  catalogDoc = {
    catalog: {
      publishing: false,
      server: { running: false, port: null, address: null, error: null },
      quote: {
        version: 2,
        updatedAt: "2026-10-30T00:00:00.000Z",
        contentHash: quoteHash,
        modelCount: 1,
        models: [{ id: "alpha/a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, source: "magpie-settings" } }],
        identity: { fingerprint, keyId: fingerprint.slice(0, 16), publicKey: "pk" },
      },
      peers: [],
    },
  };
  providersDoc = { sharingEnabled: true, consumingEnabled: true, providers: [] };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      const body = text ? JSON.parse(text) : null;
      calls.push({ method: req.method, path: url.pathname, body, auth: req.headers.get("authorization") ?? "" });
      const custom = handlers.get(`${req.method} ${url.pathname}`);
      if (custom) return json(custom(body));
      switch (`${req.method} ${url.pathname}`) {
        case "GET /health":
          return json({ ok: true });
        case "GET /status":
          return json(statusDoc);
        case "GET /checks":
          return json({ checks: statusDoc.checks });
        case "POST /supervisor/start":
          return json({ ok: true });
        case "POST /configure":
          return json(statusDoc);
        case "GET /providers":
          return json(providersDoc);
        case "GET /catalog":
          return json(catalogDoc);
        case "POST /share/models":
          return json({ ...statusDoc, config: { ...statusDoc.config, share: { models: body.models } } });
        case "POST /catalog/publish":
          catalogDoc.catalog.publishing = Boolean(body.enabled);
          catalogDoc.catalog.server.running = Boolean(body.enabled);
          catalogDoc.catalog.server.address = body.enabled ? "127.0.0.1:3426" : null;
          return json(catalogDoc);
        case "POST /secret":
          return json({ consumerId: body.consumerId, keyName: "ohmyaihub-alice", key: "sk-test-handover-key-0001", models: ["alpha/a"], capUsd: 1 });
        case "POST /consumers/add":
          return json({ consumerId: body.consumerId, models: body.models, capUsd: body.capUsd, keyName: "ohmyaihub-alice" });
        case "POST /providers/models":
          return json({ id: body.id, models: ["alpha/a"], status: "connected", detail: null, limit: null });
        case "POST /providers/update":
          return json({ id: body.id, status: "connected", detail: null, localPort: 14501, mappedCidr: "10.66.1.2/32", providerPort: 3425 });
        case "POST /providers/reconcile":
          return json({ providers: [{ id: body.id ?? "peer-a", status: "connected", detail: null, localPort: 14501, mappedCidr: "10.66.1.2/32", providerPort: 3425 }] });
        case "POST /providers/rm":
          return json({ id: body.id, localPort: 14501, status: "disabled" });
        case "POST /catalog/request":
          return json({ schema: "ohmyaihub.connection-request/v1", acceptance: { fingerprint: body.fingerprint, quoteHash: body.quoteHash }, models: body.models });
        case "POST /catalog/connect":
          return json({ id: body.id ?? "peer-aaaa", status: "connected", detail: null, localPort: 14501, mappedCidr: "10.66.1.2/32", providerPort: 3425 });
        case "POST /catalog/trust":
          return json({ trust: { accepted: true } });
        default:
          return json({ error: `no fake route for ${req.method} ${url.pathname}` }, 404);
      }
    },
  });
  writeFileSync(join(dataDir, "oh-my-aihub", "api-port"), `${server.port}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, "oh-my-aihub", "api-token"), "test-token\n", { mode: 0o600 });
  // Bun.serve(port: 0) is bound synchronously on this runtime, but a child
  // process starts before the test's event loop gives the listener its first
  // turn; wait one tick so the journey tests are deterministic.
  await Bun.sleep(50);
  writeFileSync(
    join(dataDir, "oh-my-aihub", "state.json"),
    JSON.stringify({ version: 3, config: { networkName: "old-net", nodeId: "d".repeat(16), peers: ["tcp://relay.example:11010"], listenAddr: null }, consumers: [], providers: [], orphanForwards: [], shareSuspended: null }),
    { mode: 0o600 },
  );
});

afterEach(() => {
  server.stop(true);
});

/**
 * Spawn the real CLI with `child-network-spy.ts` preloaded. The child may reach
 * only this test's fake host API; any other fetch is refused and logged, so a
 * leaked probe is both harmless and visible to the test.
 */
async function cli(args: string[], timeoutMs = 10_000, netLog?: string): Promise<{ out: string; err: string; code: number }> {
  const log = netLog ?? join(dataDir, `child-net-${randomUUID()}.log`);
  const proc = Bun.spawn(
    [process.execPath, "--preload", join(import.meta.dir, "support/child-network-spy.ts"), "bin/ohmyaihub.ts", "--data", dataDir, ...args],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OH_MY_AIHUB_MAGPIE: join(binDir, "magpie"),
        OH_MY_AIHUB_PREFLIGHT_LAN: "none",
        HERMETIC_CHILD_LOG: log,
        HERMETIC_CHILD_ALLOW: `http://127.0.0.1:${server.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { out, err, code };
}

describe("child CLI network confinement", () => {
  test("no CLI path reaches an endpoint outside the controlled host API", async () => {
    const paths: [string[], string][] = [
      [["setup"], "setup"],
      [["setup", "--check"], "setup-check"],
      [["preflight"], "preflight"],
      [["doctor"], "doctor"],
      [["resume"], "resume"],
    ];
    for (const [args, label] of paths) {
      const log = join(dataDir, `child-net-${label}-${randomUUID()}.log`);
      await cli(args, 15_000, log);
      const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      // Nothing was refused: the child never tried the LAN, :3425 or a public RPC.
      expect({ label, blocked: lines.filter((line) => line.startsWith("BLOCKED")) }).toEqual({ label, blocked: [] });
      for (const line of lines) {
        expect(line.startsWith("ALLOW ")).toBe(true);
        expect(line).toContain(`127.0.0.1:${server.port}`);
      }
      // A hard-coded probe that the spy happened to allow would still show up here.
      expect(lines.join("\n")).not.toMatch(/:3425|192\.168\.|publicnode|sepolia\.base\.org|thirdweb|tenderly/);
    }
  });
});

describe("phase 8 setup journeys", () => {
  test("setup on an existing node reports resume and never calls /configure", async () => {
    const r = await cli(["setup"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already has a configuration");
    expect(calls.some((c) => c.path === "/configure")).toBe(false);
  });

  test("a first setup sends the chosen network and a 0600 secret", async () => {
    rmSync(join(dataDir, "oh-my-aihub", "state.json"));
    const secret = join(dataDir, "network-secret");
    writeFileSync(secret, "a-long-first-secret\n", { mode: 0o600 });
    const r = await cli(["setup", "--network", "first-net", "--secret-file", secret, "--share"]);
    expect(r.code).toBe(0);
    const configure = calls.find((c) => c.path === "/configure");
    expect(configure!.body).toMatchObject({ networkName: "first-net", networkSecret: "a-long-first-secret", sharingEnabled: true });
  });

  test("setup --reconfigure sends only named fields and no empty peers/listen", async () => {
    const secret = join(dataDir, "network-secret");
    writeFileSync(secret, "a-long-new-secret\n", { mode: 0o600 });
    const r = await cli(["setup", "--reconfigure", "--network", "new-net", "--secret-file", secret, "--share", "--listen", "127.0.0.1:11010"]);
    expect(r.code).toBe(0);
    const configure = calls.find((c) => c.path === "/configure");
    expect(configure).toBeTruthy();
    expect(configure!.body.networkName).toBe("new-net");
    expect(configure!.body.networkSecret).toBe("a-long-new-secret");
    expect(configure!.body.sharingEnabled).toBe(true);
    expect("peers" in configure!.body).toBe(false);
    // The listen field is intentionally not named here: it is a versioned state
    // key, and the wizard must send it only when --listen was named.
    expect(Object.values(configure!.body)).toContain("127.0.0.1:11010");
  });

  test("a world-readable secret file is refused before any request", async () => {
    const secret = join(dataDir, "network-secret");
    writeFileSync(secret, "a-long-new-secret\n", { mode: 0o644 });
    chmodSync(secret, 0o644);
    const r = await cli(["setup", "--reconfigure", "--network", "new-net", "--secret-file", secret]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("chmod 600");
    expect(calls.some((c) => c.path === "/configure")).toBe(false);
  });
});

describe("phase 8 share journeys", () => {
  test("share setup shows priceLocked false and writes only the selected priced native models", async () => {
    handlers.set("GET /share/candidates", () => ({
      candidates: {
        policy: ["*"],
        models: [
          { id: "alpha/a", displayName: null, provider: "alpha", pricing: { input: 1, output: 2 }, completePrice: true, allowedByPolicy: true },
          { id: "alpha/b", displayName: null, provider: "alpha", pricing: null, completePrice: false, allowedByPolicy: true },
        ],
        priceVersion,
        priceLocked: false,
        blocking: [{ id: "alpha/b", reason: "no complete effective price; a capped key cannot be issued" }],
      },
    }));
    const r = await cli(["share", "setup", "--models", "alpha/a", "--no-publish"]);
    expect(r.code).toBe(0);
    const wrote = calls.find((c) => c.path === "/share/models");
    expect(wrote!.body.models).toEqual(["alpha/a"]);
    expect(r.out).toContain("priceLocked false");
    expect(calls.some((c) => c.path === "/catalog/publish")).toBe(false);
  });

  test("share setup verifies publish success by server + signed quote + checks", async () => {
    const r = await cli(["share", "setup", "--models", "alpha/a", "--publish"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("verified by server");
    expect(r.out).toContain("priceLocked false");
  });

  test("share setup refuses to call publishing a success when the server is not running", async () => {
    handlers.set("POST /catalog/publish", () => {
      catalogDoc.catalog.publishing = true;
      catalogDoc.catalog.server.running = false;
      return catalogDoc;
    });
    const r = await cli(["share", "setup", "--models", "alpha/a", "--publish"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("PUBLISH NOT VERIFIED");
  });

  test("share handover writes a 0600 key file and never prints the key", async () => {
    const keyFile = join(dataDir, "consumer-key");
    const r = await cli(["share", "handover", "alice", "--key-file", keyFile]);
    expect(r.code).toBe(0);
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, "utf8")).toContain("sk-test-handover-key-0001");
    expect(r.out).not.toContain("sk-test-handover-key-0001");
  });

  test("share approve verifies the whole request and uses the provider's cap", async () => {
    const request = join(dataDir, "request.json");
    writeFileSync(
      request,
      JSON.stringify({
        schema: "ohmyaihub.connection-request/v1",
        consumer: { nodeId: "alice", hostname: "consumer-host" },
        provider: {
          nodeId: statusDoc.config.nodeId,
          hostname: statusDoc.config.hostname,
          mappedCidr: statusDoc.config.mappedCidr,
          gatewayPort: 3425,
        },
        quote: { contentHash: quoteHash, priceVersion, identityFingerprint: fingerprint },
        acceptance: { fingerprint, quoteHash, priceVersion },
        models: ["alpha/a"],
        approval: { action: "consumers add", consumerId: "alice", models: ["alpha/a"], capUsd: 999, quoteHash, quotePriceVersion: priceVersion },
      }),
    );
    const r = await cli(["share", "approve", request, "--cap", "2", "--yes"]);
    expect(r.code).toBe(0);
    const add = calls.find((c) => c.path === "/consumers/add");
    expect(add!.body).toMatchObject({ consumerId: "alice", models: ["alpha/a"], capUsd: 2, quoteHash, quotePriceVersion: priceVersion });
    expect(r.out).not.toContain("sk-");
  });

  test("share approve refuses a request whose accepted quote is not the current one", async () => {
    const request = join(dataDir, "stale-request.json");
    const otherQuote = "d".repeat(64);
    writeFileSync(
      request,
      JSON.stringify({
        schema: "ohmyaihub.connection-request/v1",
        consumer: { nodeId: "alice" },
        provider: { nodeId: statusDoc.config.nodeId, mappedCidr: statusDoc.config.mappedCidr, gatewayPort: 3425 },
        quote: { contentHash: otherQuote, priceVersion, identityFingerprint: fingerprint },
        acceptance: { fingerprint, quoteHash: otherQuote, priceVersion },
        models: ["alpha/a"],
        approval: { action: "consumers add", consumerId: "alice", models: ["alpha/a"], capUsd: 1, quoteHash: otherQuote, quotePriceVersion: priceVersion },
      }),
    );
    const r = await cli(["share", "approve", request, "--cap", "2", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not the current published quote");
    expect(calls.some((c) => c.path === "/consumers/add")).toBe(false);
  });

  test("share approve refuses a request for another provider or a nested mismatch", async () => {
    const base = {
      schema: "ohmyaihub.connection-request/v1",
      consumer: { nodeId: "alice" },
      provider: { nodeId: "not-this-node", mappedCidr: statusDoc.config.mappedCidr, gatewayPort: 3425 },
      quote: { contentHash: quoteHash, priceVersion, identityFingerprint: fingerprint },
      acceptance: { fingerprint, quoteHash, priceVersion },
      models: ["alpha/a"],
      approval: { action: "consumers add", consumerId: "alice", models: ["alpha/a"], capUsd: 1, quoteHash, quotePriceVersion: priceVersion },
    };
    const request = join(dataDir, "bad-request.json");
    writeFileSync(request, JSON.stringify(base));
    const r = await cli(["share", "approve", request, "--cap", "2", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not this node");
    expect(calls.some((c) => c.path === "/consumers/add")).toBe(false);
  });
});

describe("phase 8 connect journeys", () => {
  function peer(status = "verified") {
    return {
      hostname: "ohmyaihub-bbbbbbbb",
      virtualIpv4: "10.77.0.3/24",
      nodeId: "b".repeat(8),
      status,
      detail: null,
      mappedCidr: "10.66.1.3/32",
      online: true,
      identity: { keyId: fingerprint.slice(0, 16), fingerprint, publicKey: "pk" },
      pendingFingerprint: null,
      quote: {
        publication: { version: 2 },
        contentHash: quoteHash,
        billing: { priceVersion, priceLocked: false },
        node: { gatewayPort: 3425, catalogPort: 3426 },
        models: [{ id: "alpha/a", pricing: { input: 1, output: 2 } }],
      },
      quoteHash,
      catalogPort: 3426,
    };
  }

  test("an untrusted first sight is refused without --trust", async () => {
    catalogDoc.catalog.peers = [peer("unverified")];
    const r = await cli(["connect", "--node", "bbbbbbbb", "--models", "alpha/a"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("self-signed TOFU");
    expect(calls.some((c) => c.path === "/catalog/request")).toBe(false);
  });

  test("request output carries the exact accepted fingerprint and quote hash", async () => {
    catalogDoc.catalog.peers = [peer("verified")];
    const requestFile = join(dataDir, "request-out.json");
    const r = await cli([
      "connect", "--node", "bbbbbbbb", "--models", "alpha/a",
      "--fingerprint", fingerprint, "--quote", quoteHash, "--request-out", requestFile,
    ]);
    expect(r.code).toBe(0);
    expect(existsSync(requestFile)).toBe(true);
    const req = calls.find((c) => c.path === "/catalog/request");
    expect(req!.body).toMatchObject({ nodeId: "bbbbbbbb", models: ["alpha/a"], fingerprint, quoteHash });
    expect(readFileSync(requestFile, "utf8")).toContain("ohmyaihub.connection-request/v1");
  });

  test("connect reads the key from a 0600 file and never prints it", async () => {
    catalogDoc.catalog.peers = [peer("verified")];
    const keyFile = join(dataDir, "provider-key");
    writeFileSync(keyFile, "sk-test-connect-file-key-0001\n", { mode: 0o600 });
    const r = await cli([
      "connect", "--node", "bbbbbbbb", "--models", "alpha/a",
      "--fingerprint", fingerprint, "--quote", quoteHash, "--key-file", keyFile,
    ]);
    expect(r.code).toBe(0);
    const connect = calls.find((c) => c.path === "/catalog/connect");
    expect(connect!.body).toMatchObject({ key: "sk-test-connect-file-key-0001", fingerprint, quoteHash });
    expect(r.out).not.toContain("sk-test-connect-file-key-0001");
  });
});

describe("phase 8 secret file boundary", () => {
  test("secret file helpers refuse a symlink for both read and force-write", () => {
    const target = join(dataDir, "real-secret");
    writeFileSync(target, "sk-test-real-secret-0001\n", { mode: 0o600 });
    const link = join(dataDir, "linked-secret");
    symlinkSync(target, link);
    expect(() => readSecretFile(link, "test secret")).toThrow(/cannot be read|symbolic/i);
    expect(() => writeSecretFile(link, "sk-test-new-secret-0001", { force: true })).toThrow(/symbolic|not a regular/i);
    expect(readFileSync(target, "utf8")).toContain("sk-test-real-secret-0001");
  });
});

describe("phase 8 wallet wiring", () => {
  test("wallet credit reads the consumer chainCredit/ledger view", async () => {
    handlers.set("GET /wallet", () => ({
      wallet: {
        consumers: [
          {
            consumerId: "alice",
            chainCredit: [{ chainId: 97, credited: 2, creditedNanos: 2_000_000_000 }],
            chainCreditedNanos: 2_000_000_000,
            ledger: { depositedNanos: 2_000_000_000, consumedNanos: 0, balanceNanos: 2_000_000_000 },
            updatedAt: "2026-10-30T00:00:00.000Z",
          },
        ],
        totals: { credited: 1 },
      },
    }));
    const r = await cli(["wallet", "credit", "alice"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.chainCredit[0]).toMatchObject({ chainId: 97, credited: 2 });
    expect(out.ledger.balanceNanos).toBe(2_000_000_000);
  });

  test("wallet status falls back to the raw wallet view when evidence is absent", async () => {
    handlers.set("GET /wallet", () => ({
      wallet: { disabled: true, registry: { networks: [], assets: [] }, chains: [], totals: {}, consumers: [] },
    }));
    const r = await cli(["wallet", "status"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.disabled).toBe(true);
    expect(out.registry.networks).toEqual([]);
  });

  test("wallet asset-register defaults to a valid decimal nanos rate and assets reads pricing.nanosPerToken", async () => {
    handlers.set("POST /wallet/asset/register", (body) => ({ asset: { ...body, pricing: { nanosPerToken: body.nanosPerToken } } }));
    const reg = await cli(["wallet", "asset-register", "97", "0x00000000000000000000000000000000000000aa", "tMOCK6", "Mock Test Dollar", "6"]);
    expect(reg.code).toBe(0);
    const body = calls.find((c) => c.path === "/wallet/asset/register")!.body;
    expect(body.nanosPerToken).toBe("1000000000");
    expect(() => BigInt(body.nanosPerToken)).not.toThrow();

    handlers.set("GET /wallet/assets", () => ({
      assets: [{ assetId: "eip155:97:0xaa", chainId: 97, symbol: "tMOCK6", decimals: 6, enabled: true, pricing: { nanosPerToken: "1000000000" }, contractAddress: "0x00000000000000000000000000000000000000aa" }],
    }));
    const list = await cli(["wallet", "assets"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("1000000000 nanos/token");
    expect(list.out).not.toContain("undefined nanos/token");
  });

  test("wallet statement's local fallback accepts evidence with accounting.serving", async () => {
    // The live evidence object carries `serving` (a WalletViewInput field). The
    // statement schema allows only state/reason/openSettlements, so the fallback
    // must project it instead of spreading the live object.
    handlers.set("GET /wallet/statement", () => ({ error: "no such endpoint" }));
    server.stop(true);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/wallet/statement") return json({ error: "no such endpoint" }, 404);
        if (url.pathname === "/wallet/evidence") {
          return json({
            wallet: {
              disabled: false,
              registry: { networks: [], assets: [] },
              chains: [],
              intents: [],
              events: [],
              receiving: [{ providerId: "provider-a", chainId: 97, address: "0x00000000000000000000000000000000000000aa", addedAt: "2026-10-30T00:00:00.000Z" }],
              totals: {},
            },
            consumers: [
              {
                consumerId: "alice",
                keyName: "ohmyaihub-alice",
                models: ["alpha/a"],
                capUsd: 1,
                usedUsd: 0,
                leftUsd: 1,
                calls: 0,
                spent: false,
                reset: null,
                pending: false,
                paused: null,
                revokedAt: null,
                priceVersion: null,
                ledger: { priceVersion: null, windowId: null, start: null, reset: null, depositedUsd: 0, consumedUsd: 0, balanceUsd: 0, overdraftUsd: 0, unsettledUsd: 0, unpricedCalls: 0, openSettlements: 0, uncertain: null, gaps: [] },
              },
            ],
            deposits: { alice: [] },
            readbacks: { alice: { at: "2026-10-30T00:00:00.000Z", capUsd: 1, usedUsd: 0, leftUsd: 1, fromGateway: true } },
            accounting: { state: "ok", reason: null, serving: true },
          });
        }
        return json({ error: "unexpected" }, 500);
      },
    });
    writeFileSync(join(dataDir, "oh-my-aihub", "api-port"), `${server.port}\n`, { mode: 0o600 });
    await Bun.sleep(20);
    const out = join(dataDir, "fallback-statement.json");
    const r = await cli(["wallet", "statement", "alice", "--out", out]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).statementFile).toBe(out);
    const written = JSON.parse(readFileSync(out, "utf8"));
    const body = written.statement ?? written;
    expect(body.accounting).toEqual({ state: "ok", reason: null, openSettlements: 0 });
    expect("serving" in body.accounting).toBe(false);
  });

  test("wallet statement uses the host statement and writes a verified 0600 file", async () => {
    const statement = buildStatement({
      providerId: "provider-a",
      consumerId: "alice",
      generatedAt: "2026-10-30T00:00:00.000Z",
      networks: [],
      assets: [],
      intents: [],
      events: [],
      deposits: [],
      consumer: null,
      accounting: { state: "ok", reason: null, openSettlements: 0 },
    });
    handlers.set("GET /wallet/statement", () => statement);
    const outDir = join(dataDir, "statements");
    const r = await cli(["wallet", "statement", "alice", "--out", outDir]);
    expect(r.code).toBe(0);
    const file = JSON.parse(r.out).statementFile as string;
    expect(file.startsWith(outDir)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.out).not.toContain("sk-");

    // The written file is the bare statement body (no {statement:…} wrapper), so
    // a consumer can verify it exactly as received. A reader must not assume a
    // wrapper.
    const bare = JSON.parse(readFileSync(file, "utf8"));
    expect(bare.consumerId).toBe("alice");
    expect(typeof bare.statement).toBe("undefined");
    expect(bare.digest).toBe(JSON.parse(r.out).digest);

    const exact = join(dataDir, "statement.json");
    const r2 = await cli(["wallet", "statement", "alice", "--out", exact]);
    expect(r2.code).toBe(0);
    expect(JSON.parse(r2.out).statementFile).toBe(exact);
    expect(statSync(exact).mode & 0o777).toBe(0o600);
  });
});

describe("phase 8 remote journeys", () => {
  test("remote models sends the target id only", async () => {
    const r = await cli(["remote", "models", "peer-a"]);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.path === "/providers/models")!.body).toEqual({ id: "peer-a" });
    expect(r.out).toContain("alpha/a");
  });

  test("remote update-key reads the key file and never prints it", async () => {
    const keyFile = join(dataDir, "new-key");
    writeFileSync(keyFile, "sk-test-update-file-key-0001\n", { mode: 0o600 });
    const r = await cli(["remote", "update-key", "peer-a", "--key-file", keyFile]);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.path === "/providers/update")!.body).toMatchObject({ id: "peer-a", key: "sk-test-update-file-key-0001" });
    expect(r.out).not.toContain("sk-test-update-file-key-0001");
  });
});

describe("phase 8 limit display safety", () => {
  test("remote list never turns a missing/zero cap into $0.0000", async () => {
    handlers.set("GET /providers", () => ({
      providers: [
        { id: "unsafe", mappedCidr: "10.66.1.2/32", providerPort: 3425, localPort: 14501, status: "connected", detail: null, limit: { cost: 0, costLimit: 0 } },
        { id: "unknown", mappedCidr: "10.66.1.3/32", providerPort: 3425, localPort: 14502, status: "connected", detail: null, limit: null },
        { id: "good", mappedCidr: "10.66.1.4/32", providerPort: 3425, localPort: 14503, status: "connected", detail: null, limit: { cost: 0.1, costLimit: 1 } },
      ],
    }));
    const r = await cli(["remote", "list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("UNLIMITED cap (unsafe");
    expect(r.out).toContain("limit UNKNOWN");
    expect(r.out).toContain("$1.0000 cap");
    expect(r.out).not.toContain("$0.0000/$0.0000");
  });

  test("remote test fails an unlimited cap and passes a positive cap", async () => {
    const base = { id: "peer-a", mappedCidr: "10.66.1.2/32", providerPort: 3425, localPort: 14501, status: "connected", detail: null };
    handlers.set("POST /providers/reconcile", () => ({ providers: [{ ...base, limit: { cost: 0, costLimit: 0 } }] }));
    const unsafe = await cli(["remote", "test", "peer-a"]);
    expect(unsafe.code).toBe(1);
    expect(unsafe.out).toContain("UNSAFE");

    handlers.set("POST /providers/reconcile", () => ({ providers: [{ ...base, limit: { cost: 0, costLimit: 1 } }] }));
    handlers.set("POST /providers/reconcile", () => ({ providers: [{ ...base, limit: null }] }));
    const unknown = await cli(["remote", "test", "peer-a"]);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("limit UNKNOWN");

    handlers.set("POST /providers/reconcile", () => ({ providers: [{ ...base, limit: { cost: 0, costLimit: 1 } }] }));
    const good = await cli(["remote", "test", "peer-a"]);
    expect(good.code).toBe(0);
    expect(good.out).toContain("$1.0000 cap");
  });
});

describe("phase 8 CLI failure hygiene", () => {
  test("an API error prints its error field but never the rest of the payload", async () => {
    handlers.set("GET /providers", () => {
      throw new Error("unused");
    });
    // A route returning a body with an error and a canary.
    handlers.set("GET /providers", () => ({ error: "bad request", canary: "DO-NOT-ECHO" }));
    // The fake helper returns 200 for custom handlers; use a direct route.
    server.stop(true);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => json({ error: "bad request", canary: "DO-NOT-ECHO" }, 400),
    });
    writeFileSync(join(dataDir, "oh-my-aihub", "api-port"), `${server.port}\n`, { mode: 0o600 });
    const r = await cli(["remote", "list"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bad request");
    expect(r.err).not.toContain("DO-NOT-ECHO");
  });

  test("a hung API is reported as a timeout, not as a raw stack", async () => {
    server.stop(true);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 5_000));
        return json({ ok: true });
      },
    });
    writeFileSync(join(dataDir, "oh-my-aihub", "api-port"), `${server.port}\n`, { mode: 0o600 });
    const r = await cli(["remote", "list", "--timeout-ms", "100"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not answer");
    expect(r.err).not.toContain("at async");
  });
});
