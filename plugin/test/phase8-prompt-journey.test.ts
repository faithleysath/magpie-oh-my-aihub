import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../bin/operator-setup.ts";
import { runShare } from "../bin/operator-share.ts";
import { runConnect } from "../bin/operator-connect.ts";
import type { WizardIO } from "../bin/operator-lib.ts";
import { catalogPriceVersion } from "../src/pricing.ts";

// These tests exercise the interactive journey functions with a scripted IO.
// They do not need a PTY; they assert the real prompt order and the JSON sent to
// the host, which is the part a TTY user experiences.

interface Call { method: string; path: string; body: any }
const fingerprint = "a".repeat(64);
const quoteHash = "b".repeat(64);
const priceVersion = catalogPriceVersion([{ id: "alpha/a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }])!;

let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
let binDir: string;
let calls: Call[];
let handlers: Map<string, (body: any) => any>;
let magpieEnv: string | undefined;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function status(config: any, checks: any[] = []) {
  return {
    plugin: { version: "0.4.0", pid: 1, dataDir, startedAt: new Date().toISOString(), stateVersion: 3 },
    magpie: { version: "magpie 0.1.2038", gateway: "http://127.0.0.1:3425" },
    config,
    easytier: { running: Boolean(config), pid: 2, coreVersion: "easytier-core 2.6.4", aclOk: true, aclProblems: [], rpcPort: 17888 },
    consumers: [],
    providers: [],
    catalog: { publishing: false, quote: null, peers: [] },
    accounting: { paused: [] },
    checks,
    checksAt: new Date().toISOString(),
    readiness: { state: "ready", checkedAt: new Date().toISOString(), ageMs: 0, source: "cached", reasons: [], providers: [] },
  };
}

function baseConfig(over: Record<string, unknown> = {}) {
  return {
    role: "provider",
    sharingEnabled: true,
    sharingActive: true,
    shareSuspended: null,
    consumingEnabled: false,
    nodeId: "d".repeat(16),
    hostname: "ohmyaihub-dddddddddddddddd",
    networkName: "prompt-net",
    peers: [],
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
    ...over,
  };
}

function scriptedIO(answers: string[]): WizardIO & { prompts: { question: string; opts?: { default?: string; secret?: boolean } }[] } {
  const prompts: { question: string; opts?: { default?: string; secret?: boolean } }[] = [];
  let i = 0;
  return {
    isTTY: true,
    prompts,
    async prompt(question, opts) {
      prompts.push({ question, opts });
      const answer = answers[i++];
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      return answer || opts?.default || "";
    },
    print() {},
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ohmyaihub-prompt-"));
  binDir = mkdtempSync(join(tmpdir(), "ohmyaihub-prompt-bin-"));
  mkdirSync(join(dataDir, "oh-my-aihub"), { recursive: true });
  const magpie = join(binDir, "magpie");
  writeFileSync(magpie, "#!/bin/sh\necho 'magpie 0.1.2038'\n");
  chmodSync(magpie, 0o755);
  magpieEnv = process.env.OH_MY_AIHUB_MAGPIE;
  process.env.OH_MY_AIHUB_MAGPIE = magpie;
  calls = [];
  handlers = new Map();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      const body = text ? JSON.parse(text) : null;
      calls.push({ method: req.method, path: url.pathname, body });
      const custom = handlers.get(`${req.method} ${url.pathname}`);
      if (custom) return json(custom(body));
      switch (`${req.method} ${url.pathname}`) {
        case "GET /health":
          return json({ ok: true });
        case "GET /status":
          return json(status(null, []));
        case "GET /checks":
          return json({ checks: [{ name: "configured", ok: true, detail: "ok" }] });
        case "POST /supervisor/start":
          return json({ ok: true });
        case "POST /configure":
          return json(status(baseConfig({ networkName: body.networkName })));
        default:
          return json({ error: `no fake route for ${req.method} ${url.pathname}` }, 404);
      }
    },
  });
  writeFileSync(join(dataDir, "oh-my-aihub", "api-port"), `${server.port}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, "oh-my-aihub", "api-token"), "prompt-token\n", { mode: 0o600 });
  await Bun.sleep(20);
});

afterEach(() => {
  server.stop(true);
  if (magpieEnv === undefined) delete process.env.OH_MY_AIHUB_MAGPIE;
  else process.env.OH_MY_AIHUB_MAGPIE = magpieEnv;
});

describe("phase 8 prompt journeys", () => {
  test("setup asks network, role, hidden secret, peer and listen, then configures", async () => {
    handlers.set("POST /configure", (body) => {
      return status(baseConfig({ sharingEnabled: body.sharingEnabled, consumingEnabled: body.consumingEnabled, networkName: body.networkName }));
    });
    const io = scriptedIO(["prompt-net", "2", "prompt-secret", "tcp://relay.example:11010", "", "n"]);
    const code = await runSetup([], dataDir, io, {
      preflight: { lan: "127.0.0.1", fetchImpl: async () => new Response("", { status: 401 }) },
    });
    expect(code).toBe(0);
    const configure = calls.find((c) => c.path === "/configure");
    expect(configure!.body).toMatchObject({
      networkName: "prompt-net",
      networkSecret: "prompt-secret",
      peers: ["tcp://relay.example:11010"],
      sharingEnabled: false,
      consumingEnabled: true,
      catalogDiscovery: false,
    });
    expect(io.prompts.some((p) => p.question.includes("Role"))).toBe(true);
    expect(io.prompts.some((p) => p.question.includes("Initial peer"))).toBe(true);
    expect(io.prompts.some((p) => p.opts?.secret === true)).toBe(true);
  });

  test("check and resume take the injected preflight transport and the named gateway port", async () => {
    // Regression: resumeOrCheck() used to build its own preflight and drop
    // deps.preflight, so `--check`/`resume`/`preflight`/`doctor` ignored both the
    // fixture transport and OH_MY_AIHUB_PREFLIGHT_LAN=none and still probed the
    // real LAN gateway on the default port.
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return new Response("", { status: 401 });
    };
    const io = scriptedIO([]);
    const preflight = { lan: "127.0.0.1", fetchImpl };

    const check = await runSetup(["--check", "--gateway-port", "39999", "--json"], dataDir, io, { preflight });
    expect(check).toBe(0);
    expect(seen).toEqual(["http://127.0.0.1:39999/v1/models"]);

    seen.length = 0;
    const resume = await runSetup(["--resume", "--gateway-port", "39999", "--json"], dataDir, io, { preflight });
    expect(resume).toBe(0);
    expect(seen).toEqual(["http://127.0.0.1:39999/v1/models"]);
  });

  test("share setup rejects an invalid number instead of silently selecting all priced", async () => {
    handlers.set("GET /status", () => status(baseConfig(), []));
    handlers.set("GET /share/candidates", () => ({
      candidates: {
        policy: ["*"],
        models: [
          { id: "alpha/a", displayName: null, provider: "alpha", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, completePrice: true, allowedByPolicy: true },
        ],
        priceVersion,
        priceLocked: false,
        blocking: [],
      },
    }));
    const io = scriptedIO(["99"]);
    await expect(runShare(["setup"], dataDir, io)).rejects.toThrow(/outside 1-1/);
    expect(calls.some((c) => c.path === "/share/models")).toBe(false);
  });

  test("share setup lists priced models and accepts a number selection", async () => {
    handlers.set("GET /status", () => status(baseConfig(), []));
    handlers.set("GET /share/candidates", () => ({
      candidates: {
        policy: ["*"],
        models: [
          { id: "alpha/a", displayName: null, provider: "alpha", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, completePrice: true, allowedByPolicy: true },
          { id: "alpha/b", displayName: null, provider: "alpha", pricing: null, completePrice: false, allowedByPolicy: true },
        ],
        priceVersion,
        priceLocked: false,
        blocking: [{ id: "alpha/b", reason: "no complete effective price; a capped key cannot be issued" }],
      },
    }));
    handlers.set("POST /share/models", (body) => status(baseConfig({ share: { models: body.models } })));
    handlers.set("GET /catalog", () => ({ catalog: { publishing: false, server: { running: false }, quote: null, peers: [] } }));
    const io = scriptedIO(["1", "n"]);
    const code = await runShare(["setup"], dataDir, io);
    expect(code).toBe(0);
    expect(calls.find((c) => c.path === "/share/models")!.body.models).toEqual(["alpha/a"]);
    expect(io.prompts[0].question).toContain("Select models");
  });

  test("share setup asks for catalogue name/contact and verifies the publish", async () => {
    handlers.set("GET /status", () => status(baseConfig(), []));
    handlers.set("GET /share/candidates", () => ({
      candidates: {
        policy: ["*"],
        models: [
          { id: "alpha/a", displayName: null, provider: "alpha", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, completePrice: true, allowedByPolicy: true },
        ],
        priceVersion,
        priceLocked: false,
        blocking: [],
      },
    }));
    handlers.set("POST /share/models", (body) => status(baseConfig({ share: { models: body.models } })));
    handlers.set("POST /catalog/configure", (body) => ({ catalog: { config: body } }));
    handlers.set("POST /catalog/publish", () => ({ ok: true }));
    handlers.set("GET /catalog", () => ({
      catalog: {
        publishing: true,
        server: { running: true, address: "127.0.0.1:3426" },
        quote: {
          version: 2,
          contentHash: quoteHash,
          updatedAt: new Date().toISOString(),
          modelCount: 1,
          models: [{ id: "alpha/a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
          identity: { fingerprint, keyId: fingerprint.slice(0, 16), publicKey: "pk" },
        },
        peers: [],
      },
    }));
    handlers.set("GET /checks", () => ({
      checks: ["acl", "catalog-published", "catalog-quote", "catalog-identity"].map((name) => ({ name, ok: true, detail: "ok" })),
    }));
    const io = scriptedIO(["1", "y", "My Magpie", ""]);
    const code = await runShare(["setup"], dataDir, io);
    expect(code).toBe(0);
    expect(io.prompts.some((p) => p.question.includes("Publish"))).toBe(true);
    expect(io.prompts.some((p) => p.question.includes("display name"))).toBe(true);
    expect(calls.find((c) => c.path === "/catalog/configure")!.body).toMatchObject({ displayName: "My Magpie" });
    expect(calls.some((c) => c.path === "/catalog/publish")).toBe(true);
  });

  test("share approve shows the full request and asks for a manual TTY confirmation", async () => {
    handlers.set("GET /status", () => status(baseConfig(), []));
    handlers.set("GET /catalog", () => ({
      catalog: {
        publishing: true,
        server: { running: true },
        quote: {
          version: 2,
          contentHash: quoteHash,
          updatedAt: new Date().toISOString(),
          modelCount: 1,
          models: [{ id: "alpha/a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
          identity: { fingerprint, keyId: fingerprint.slice(0, 16), publicKey: "pk" },
        },
        peers: [],
      },
    }));
    handlers.set("POST /consumers/add", (body) => ({ consumerId: body.consumerId, models: body.models, capUsd: body.capUsd }));
    const request = join(dataDir, "request.json");
    writeFileSync(
      request,
      JSON.stringify({
        schema: "ohmyaihub.connection-request/v1",
        consumer: { nodeId: "alice", hostname: "consumer-host" },
        provider: { nodeId: "d".repeat(16), hostname: "ohmyaihub-dddddddddddddddd", mappedCidr: "10.66.1.9/32", gatewayPort: 3425 },
        quote: { contentHash: quoteHash, priceVersion, identityFingerprint: fingerprint },
        acceptance: { fingerprint, quoteHash, priceVersion },
        models: ["alpha/a"],
        approval: { action: "consumers add", consumerId: "alice", models: ["alpha/a"], capUsd: 9, quoteHash, quotePriceVersion: priceVersion },
      }),
    );
    const io = scriptedIO(["y"]);
    const code = await runShare(["approve", request, "--cap", "2"], dataDir, io);
    expect(code).toBe(0);
    expect(io.prompts.some((p) => p.question.includes("Issue this model-scoped"))).toBe(true);
    expect(calls.find((c) => c.path === "/consumers/add")!.body).toMatchObject({ consumerId: "alice", capUsd: 2 });
    expect(calls.find((c) => c.path === "/consumers/add")!.body).not.toMatchObject({ capUsd: 9 });
  });

  test("connect shows a first-seen quote and accepts an explicit TTY trust confirmation", async () => {
    const peer: any = {
      hostname: "ohmyaihub-bbbbbbbb",
      virtualIpv4: "10.77.0.3/24",
      nodeId: "b".repeat(8),
      status: "unverified",
      detail: null,
      mappedCidr: "10.66.1.3/32",
      online: true,
      identity: { keyId: fingerprint.slice(0, 16), fingerprint, publicKey: "pk" },
      pendingFingerprint: null,
      quote: {
        publication: { version: 2 },
        billing: { priceVersion, priceLocked: false },
        node: { gatewayPort: 3425, catalogPort: 3426 },
        models: [{ id: "alpha/a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      },
      quoteHash,
      catalogPort: 3426,
    };
    handlers.set("GET /catalog", () => ({ catalog: { peers: [peer] } }));
    handlers.set("POST /catalog/trust", () => {
      peer.status = "verified";
      return { trust: { accepted: true } };
    });
    handlers.set("POST /catalog/request", (body) => ({ schema: "ohmyaihub.connection-request/v1", models: body.models }));
    const io = scriptedIO(["1", "y", fingerprint.slice(0, 12), quoteHash.slice(0, 12), "1"]);
    const code = await runConnect([], dataDir, io);
    expect(code).toBe(0);
    expect(io.prompts.some((p) => p.question.includes("Accept this first-seen"))).toBe(true);
    expect(calls.find((c) => c.path === "/catalog/trust")!.body).toMatchObject({ fingerprint });
    expect(calls.find((c) => c.path === "/catalog/request")!.body).toMatchObject({ fingerprint, quoteHash, models: ["alpha/a"] });
  });

  test("connect lists peers, lets the user choose by number, and then models by number", async () => {
    const peer = {
      hostname: "ohmyaihub-bbbbbbbb",
      virtualIpv4: "10.77.0.3/24",
      nodeId: "b".repeat(8),
      status: "verified",
      detail: null,
      mappedCidr: "10.66.1.3/32",
      online: true,
      identity: { keyId: fingerprint.slice(0, 16), fingerprint, publicKey: "pk" },
      pendingFingerprint: null,
      quote: {
        publication: { version: 2 },
        billing: { priceVersion, priceLocked: false },
        node: { gatewayPort: 3425, catalogPort: 3426 },
        models: [{ id: "alpha/a", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      },
      quoteHash,
      catalogPort: 3426,
    };
    const other = { ...peer, hostname: "ohmyaihub-cccccccc", nodeId: "c".repeat(8), mappedCidr: "10.66.1.4/32", identity: { ...peer.identity, fingerprint: "e".repeat(64) } };
    handlers.set("GET /catalog", () => ({ catalog: { peers: [peer, other] } }));
    handlers.set("POST /catalog/request", (body) => ({ schema: "ohmyaihub.connection-request/v1", models: body.models }));
    const io = scriptedIO(["2", "e".repeat(12), quoteHash.slice(0, 12), "1"]);
    const code = await runConnect([], dataDir, io);
    expect(code).toBe(0);
    expect(io.prompts[0].question).toContain("Select peer");
    expect(io.prompts.some((p) => p.question.includes("Select models"))).toBe(true);
    expect(calls.find((c) => c.path === "/catalog/request")!.body).toMatchObject({
      nodeId: "c".repeat(8),
      models: ["alpha/a"],
      fingerprint: "e".repeat(64),
    });
  });
});
