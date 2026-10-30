import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import {
  CATALOG_PATH,
  CatalogServer,
  canonicalJson,
  classifyPeers,
  fingerprintOf,
  keyIdOf,
  loadCatalogTrust,
  loadOrCreateCatalogIdentity,
  saveCatalogTrust,
  sha256Hex,
  trustFile,
  signCatalog,
  socksHttpGet,
  verifySignedCatalog,
  type CatalogModel,
  type CatalogQuoteBody,
  type CatalogTrustRecord,
  type SignedCatalog,
} from "../src/catalog.ts";
import { catalogPriceVersion } from "../src/pricing.ts";

let dir: string;

function body(identity: ReturnType<typeof loadOrCreateCatalogIdentity>, models: CatalogModel[] = [model("alpha/x")], version = 1): CatalogQuoteBody {
  return {
    schema: "ohmyaihub.catalog/v1",
    node: {
      id: "abcd1234",
      displayName: "ohmyaihub-abcd1234",
      hostname: "ohmyaihub-abcd1234",
      virtualIpv4: "10.77.0.2",
      mappedCidr: "10.66.1.2/32",
      gatewayPort: 3425,
      catalogPort: 3426,
      contact: null,
    },
    publication: { status: "published", version, updatedAt: "2026-10-30T00:00:00.000Z", publishedAt: "2026-10-30T00:00:00.000Z", note: "read only" },
    models,
    topUp: { minUsd: 1, simulated: true, note: "simulated" },
    billing: { quoteOnly: true, charged: false, note: "display only" },
    identity: identity.summary,
  };
}

function quote(identity: ReturnType<typeof loadOrCreateCatalogIdentity>, models: CatalogModel[] = [model("alpha/x")], version = 1): SignedCatalog {
  return signCatalog(body(identity, models, version), identity);
}

function signedWith(mutate: (b: any) => void): SignedCatalog {
  const identity = loadOrCreateCatalogIdentity();
  const b = body(identity);
  mutate(b);
  return signCatalog(b as never, identity);
}

function model(id: string): CatalogModel {
  return {
    id,
    displayName: null,
    gatewayApis: ["chat", "responses"],
    nativeApis: ["chat"],
    contextWindow: 128000,
    maxOutputTokens: 4096,
    images: false,
    modalities: null,
    reasoningLevels: null,
    pricing: { unit: "USD per 1M tokens", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, source: "magpie-settings" },
    capabilitiesSource: "magpie-settings",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-catalog-"));
  process.chdir(dir);
});

describe("canonical JSON and Ed25519 quotes", () => {
  test("canonical JSON sorts keys and keeps arrays in order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("a quote is signed, verifies, and a tampered field is refused", () => {
    const identity = loadOrCreateCatalogIdentity();
    const signed = quote(identity);
    const verified = verifySignedCatalog(signed);
    expect(verified.quote.node.id).toBe("abcd1234");
    expect(verified.fingerprint).toBe(identity.summary.fingerprint);
    expect(verified.contentHash).toBe(sha256Hex(canonicalJson({ ...signed, signature: undefined })));

    const tampered = { ...signed, topUp: { ...signed.topUp, minUsd: 0 } };
    expect(() => verifySignedCatalog(tampered)).toThrow(/signature does not match/);
    const wrongKey = { ...signed, identity: { ...signed.identity, fingerprint: "0".repeat(64) } };
    expect(() => verifySignedCatalog(wrongKey)).toThrow(/fingerprint does not match/);
  });

  test("the identity persists across loads and is 0600", () => {
    const a = loadOrCreateCatalogIdentity();
    const b = loadOrCreateCatalogIdentity();
    expect(b.summary.fingerprint).toBe(a.summary.fingerprint);
    expect(keyIdOf(a.summary.publicKey)).toBe(a.summary.keyId);
    expect(fingerprintOf(a.summary.publicKey)).toBe(a.summary.fingerprint);
  });
});

describe("strict runtime validation of untrusted quotes", () => {
  test("a valid signed quote still verifies", () => {
    expect(verifySignedCatalog(quote(loadOrCreateCatalogIdentity())).quote.models[0].id).toBe("alpha/x");
  });

  test("dangerous model ids and shell metacharacters are refused", () => {
    for (const id of ["alpha/x; touch /tmp/pwn", "alpha/$(id)", "alpha/`id`", "alpha/x|cat", "alpha/x y", "alpha/x*", "alpha/..", "alpha/" + "x".repeat(150)]) {
      expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].id = id; }))).toThrow(/model|safe provider\/model/);
    }
  });

  test("invalid amounts, ports, timestamps and unknown fields are refused", () => {
    expect(() => verifySignedCatalog(signedWith((b) => { b.topUp.minUsd = "1; rm -rf /"; }))).toThrow(/minUsd/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.topUp.minUsd = -1; }))).toThrow(/minUsd/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.topUp.minUsd = 0; }))).toThrow(/at least/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].pricing.input = -1; }))).toThrow(/input/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].pricing.input = "1"; }))).toThrow(/input/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.node.catalogPort = 70000; }))).toThrow(/catalogPort/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.node.catalogPort = b.node.gatewayPort; }))).toThrow(/must differ/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.publication.version = 0; }))).toThrow(/version/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.publication.updatedAt = "2026-99-99T99:99:99Z"; }))).toThrow(/updatedAt/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.node.contact = "ok\nrm"; }))).toThrow(/control/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.evil = "extra"; }))).toThrow(/unexpected field/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].gatewayApis = ["chat", "evil"]; }))).toThrow(/unknown API/);
  });

  test("node id and hostname binding reject prototype names and mismatches", () => {
    for (const id of ["__proto__", "constructor", "prototype", "ABCD1234", "abc"]) {
      expect(() => verifySignedCatalog(signedWith((b) => { b.node.id = id; b.node.hostname = `ohmyaihub-${id}`; }))).toThrow(/node\.id/);
    }
    expect(() => verifySignedCatalog(signedWith((b) => { b.node.hostname = "ohmyaihub-ffffffff"; }))).toThrow(/does not belong/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.node.mappedCidr = "10.66.999.1/32"; }))).toThrow(/mappedCidr/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.node.virtualIpv4 = "192.0.2.1"; }))).toThrow(/virtualIpv4/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.models = Array.from({ length: 201 }, (_, i) => model(`alpha/m${i}`)); }))).toThrow(/at most 200|64 KiB/);
  });

  test("pricing shape and tiers are bounded", () => {
    expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].pricing.unit = "USD"; }))).toThrow(/unit/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].pricing.source = "remote"; }))).toThrow(/source/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].pricing.input = 1e12; }))).toThrow(/input/);
    expect(() => verifySignedCatalog(signedWith((b) => { b.models[0].pricing.tiers = [{ above: 10, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { above: 10, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]; }))).toThrow(/strictly increasing/);
  });
});

describe("catalogue trust is prototype-safe and fail-closed", () => {
  function validTrust(nodeId: string, ident: ReturnType<typeof loadOrCreateCatalogIdentity>, extra: Partial<CatalogTrustRecord> = {}): CatalogTrustRecord {
    return {
      nodeId,
      overlayHostname: `ohmyaihub-${nodeId}`,
      publicKey: ident.summary.publicKey,
      fingerprint: ident.summary.fingerprint,
      keyId: ident.summary.keyId,
      firstSeenAt: "2026-10-30T00:00:00.000Z",
      lastSeenAt: "2026-10-30T00:00:00.000Z",
      quoteVersion: 1,
      quoteHash: null,
      accepted: false,
      pending: null,
      ...extra,
    };
  }

  test("__proto__/constructor/prototype keys are ignored and Object.prototype is untouched", () => {
    const ident = loadOrCreateCatalogIdentity();
    const peers = Object.create(null) as Record<string, unknown>;
    peers["__proto__"] = { polluted: true };
    peers["constructor"] = { polluted: true };
    peers["prototype"] = { polluted: true };
    peers["deadbeef"] = validTrust("deadbeef", ident, { accepted: undefined as never, pending: undefined as never });
    mkdirSync(join(dir, "oh-my-aihub"), { recursive: true, mode: 0o700 });
    writeFileSync(trustFile(), JSON.stringify({ version: 1, peers }), { mode: 0o600 });

    const trust = loadCatalogTrust();
    expect(Object.getPrototypeOf(trust)).toBeNull();
    expect(Object.keys(trust)).toEqual(["deadbeef"]);
    expect(trust["deadbeef"].accepted).toBe(false);
    expect(trust["deadbeef"].pending).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(trust, "__proto__")).toBe(false);
  });

  test("a corrupt trust file fails closed; a valid legacy record is recovered", () => {
    mkdirSync(join(dir, "oh-my-aihub"), { recursive: true, mode: 0o700 });
    writeFileSync(trustFile(), "{not json", { mode: 0o600 });
    expect(Object.keys(loadCatalogTrust())).toEqual([]);

    const ident = loadOrCreateCatalogIdentity();
    saveCatalogTrust({ deadbeef: validTrust("deadbeef", ident) });
    const loaded = loadCatalogTrust();
    expect(loaded["deadbeef"].fingerprint).toBe(ident.summary.fingerprint);
    expect(readFileSync(trustFile(), "utf8")).toContain("deadbeef");
  });

  test("saving ignores a reserved key instead of writing it", () => {
    const ident = loadOrCreateCatalogIdentity();
    const peers = Object.create(null) as Record<string, CatalogTrustRecord>;
    peers["__proto__"] = validTrust("__proto__" as never, ident);
    peers["deadbeef"] = validTrust("deadbeef", ident);
    saveCatalogTrust(peers);
    const raw = JSON.parse(readFileSync(trustFile(), "utf8")) as { peers: Record<string, unknown> };
    expect(Object.keys(raw.peers)).toEqual(["deadbeef"]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("peer classification", () => {
  const peer = (hostname: string, ipv4: string, cost = "p2p") => ({
    hostname,
    ipv4,
    cost,
    latencyMs: "1.20",
    loss: "0.0%",
    tunnel: "tcp",
    nat: "PortRestricted",
    id: "1",
  });
  test("separates self, direct and relay peers and reads the mapped side", () => {
    const rows = classifyPeers(
      [peer("ohmyaihub-me", "10.77.0.2/24", "Local"), peer("b", "10.77.0.3/24"), peer("c", "10.77.0.4/24", "relay(2)")],
      [
        { ipv4: "10.77.0.2/24", hostname: "ohmyaihub-me", proxyCidrs: "192.0.2.84->10.66.1.2", nextHop: "Local", pathLen: 0 },
        { ipv4: "10.77.0.3/24", hostname: "b", proxyCidrs: "192.0.2.85->10.66.1.3", nextHop: "DIRECT", pathLen: 1 },
        { ipv4: "10.77.0.4/24", hostname: "c", proxyCidrs: "192.0.2.86->10.66.1.4", nextHop: "b", pathLen: 2 },
      ],
      { hostname: "ohmyaihub-me", virtualIpv4: "10.77.0.2/24" },
    );
    expect(rows[0]).toMatchObject({ route: "self", mappedCidr: "10.66.1.2/32", online: false });
    expect(rows[1]).toMatchObject({ route: "direct", mappedCidr: "10.66.1.3/32", online: true });
    expect(rows[2]).toMatchObject({ route: "relay", mappedCidr: "10.66.1.4/32" });
  });

  test("marks duplicate virtual addresses and duplicate mapped prefixes as conflicts", () => {
    const rows = classifyPeers(
      [peer("b", "10.77.0.3/24"), peer("c", "10.77.0.3/24"), peer("d", "10.77.0.5/24")],
      [
        { ipv4: "10.77.0.3/24", hostname: "b", proxyCidrs: "10.66.1.3", nextHop: "DIRECT", pathLen: 1 },
        { ipv4: "10.77.0.3/24", hostname: "c", proxyCidrs: "10.66.1.4", nextHop: "DIRECT", pathLen: 1 },
        { ipv4: "10.77.0.5/24", hostname: "d", proxyCidrs: "10.66.1.3", nextHop: "DIRECT", pathLen: 1 },
      ],
      { hostname: "me", virtualIpv4: "10.77.0.2/24" },
    );
    expect(rows.find((r) => r.hostname === "b")!.conflict).toMatch(/duplicate virtual address/);
    expect(rows.find((r) => r.hostname === "c")!.conflict).toMatch(/duplicate virtual address/);
    expect(rows.find((r) => r.hostname === "d")!.conflict).toMatch(/announced by b, d/);
  });
});

describe("read-only catalogue server", () => {
  let server: CatalogServer | null = null;
  let port = 0;
  afterEach(() => {
    server?.stop();
    server = null;
  });

  function start(doc: SignedCatalog | null, maxBytes?: number): string {
    port = 25000 + Math.floor(Math.random() * 20000);
    server = new CatalogServer({ hostname: "127.0.0.1", port, document: () => doc, maxBytes });
    server.start();
    return `http://127.0.0.1:${port}`;
  }

  test("serves one signed GET and nothing else", async () => {
    const identity = loadOrCreateCatalogIdentity();
    const base = start(quote(identity));
    const res = await fetch(base + CATALOG_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await res.json()) as SignedCatalog;
    expect(verifySignedCatalog(body).quote.node.id).toBe("abcd1234");

    expect((await fetch(base + "/status")).status).toBe(404);
    expect((await fetch(base + "/providers")).status).toBe(404);
    expect((await fetch(base + "/configure", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await fetch(base + CATALOG_PATH + "?x=1")).status).toBe(404);
  });

  test("refuses a document above the byte cap", async () => {
    const identity = loadOrCreateCatalogIdentity();
    const base = start(quote(identity), 100);
    expect((await fetch(base + CATALOG_PATH)).status).toBe(503);
  });

  test("returns 503 when publication is off, and 429 after the burst", async () => {
    const off = start(null);
    expect((await fetch(off + CATALOG_PATH)).status).toBe(503);
    server?.stop();
    const identity = loadOrCreateCatalogIdentity();
    const base = start(quote(identity));
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await fetch(base + CATALOG_PATH)).status;
    expect(last).toBe(429);
  });
});

describe("SOCKS5 client", () => {
  let socks: ReturnType<typeof createTcpServer> | null = null;
  let http: ReturnType<typeof createTcpServer> | null = null;
  let socksPort = 0;
  let httpPort = 0;

  beforeEach(async () => {
    httpPort = 26000 + Math.floor(Math.random() * 10000);
    http = createTcpServer((socket) => {
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 21\r\nConnection: close\r\n\r\n123456789012345678901");
      });
    });
    await new Promise<void>((r) => http!.listen(httpPort, "127.0.0.1", r));

    socksPort = 27000 + Math.floor(Math.random() * 10000);
    socks = createTcpServer((socket) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        if (stage === 0 && buf.length >= 3) {
          buf = buf.subarray(3);
          socket.write(Buffer.from([5, 0]));
          stage = 1;
        }
        if (stage === 1 && buf.length >= 10) {
          const atyp = buf[3];
          const host = atyp === 1 ? [...buf.subarray(4, 8)].join(".") : "";
          const port = buf.readUInt16BE(8);
          buf = buf.subarray(10);
          const target = `${host}:${port}`;
          const ok = target.startsWith("10.66.1.2:");
          socket.write(Buffer.from([5, ok ? 0 : 5, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 2;
        }
        if (stage === 2 && buf.includes("\r\n\r\n")) {
          socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 23\r\nConnection: close\r\n\r\nsigned-catalogue-body!!");
          stage = 3;
        }
      });
    });
    await new Promise<void>((r) => socks!.listen(socksPort, "127.0.0.1", r));
  });

  afterEach(() => {
    socks?.close();
    http?.close();
    socks = null;
    http = null;
  });

  test("does a SOCKS5 CONNECT and reads one HTTP response", async () => {
    const res = await socksHttpGet({ socksPort, host: "10.66.1.2", port: httpPort, path: CATALOG_PATH, timeoutMs: 3000 });
    expect(res.status).toBe(200);
    expect(res.body).toBe("signed-catalogue-body!!");
  });

  test("refuses a non-IPv4 destination (no DNS through the proxy)", async () => {
    await expect(
      socksHttpGet({ socksPort, host: "example.com", port: 80, path: "/", timeoutMs: 1000 }),
    ).rejects.toThrow(/only dials IPv4/);
  });

  test("bounds the response size", async () => {
    await expect(
      socksHttpGet({ socksPort, host: "10.66.1.2", port: httpPort, path: CATALOG_PATH, timeoutMs: 3000, maxBytes: 5 }),
    ).rejects.toThrow(/exceeds 5 bytes/);
  });
});

describe("price version binding", () => {
  test("a signed quote can bind its displayed prices, and a mismatch is refused", () => {
    const identity = loadOrCreateCatalogIdentity();
    const m = model("alpha/x");
    const priceVersion = catalogPriceVersion([m])!;
    expect(priceVersion).toMatch(/^[0-9a-f]{64}$/);
    const b = body(identity, [m]);
    b.billing = { ...b.billing, priceVersion, priceLocked: false };
    const signed = signCatalog(b, identity);
    expect(verifySignedCatalog(signed).quote.billing.priceVersion).toBe(priceVersion);

    const wrong = body(identity, [m]);
    wrong.billing = { ...wrong.billing, priceVersion: "0".repeat(64), priceLocked: false };
    expect(() => verifySignedCatalog(signCatalog(wrong, identity))).toThrow(/priceVersion/);

    const repriced = body(identity, [{ ...m, pricing: { ...m.pricing!, input: 9 } }]);
    repriced.billing = { ...repriced.billing, priceVersion, priceLocked: false };
    expect(() => verifySignedCatalog(signCatalog(repriced, identity))).toThrow(/priceVersion/);
  });

  test("a quote without a price version stays readable, but a false lock claim is refused", () => {
    const identity = loadOrCreateCatalogIdentity();
    expect(() => verifySignedCatalog(quote(identity))).not.toThrow();
    const b = body(identity);
    b.billing = { ...b.billing, priceLocked: true as never };
    expect(() => verifySignedCatalog(signCatalog(b, identity))).toThrow(/priceLocked/);
  });
});
