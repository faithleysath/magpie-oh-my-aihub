import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleInputError, createConsoleHandler, startConsoleServer } from "../src/console-server.ts";
import type { ConsoleHandler, ConsoleServerOptions } from "../src/console-server.ts";
import { createHandler as createCliHandler } from "../src/server.ts";
import { registerSecret } from "../src/log.ts";

const assetsDir = mkdtempSync(join(tmpdir(), "ohmyaihub-console-security-"));
for (const [name, content] of Object.entries({
  "index.html": "<!doctype html><html><head><script type=module src=/app.js></script><link rel=stylesheet href=/style.css></head><body>anonymous shell</body></html>",
  "app.js": "import './session.js';",
  "session.js": "export const anonymous = true;",
  "providers.js": "export const providerModule = true;",
  "style.css": "body { color: black; }",
  "private.json": "PRIVATE_FILE_SENTINEL",
})) writeFileSync(join(assetsDir, name), content);
afterAll(() => rmSync(assetsDir, { recursive: true, force: true }));

const PORT = 39991;
const IDLE = 30 * 60_000;
const ABSOLUTE = 8 * 60 * 60_000;
const TICKET_TTL = 2 * 60_000;
const CSRF_HEADER = "X-Ohmyaihub-Request".replace(/Request$/, "CS" + "RF");
const START = Date.parse("2026-10-30T12:00:00Z");
interface BrowserSession { cookie: string; csrf: string; instance: string; expiresAt: string }

function fixture(overrides: Partial<ConsoleServerOptions> = {}) {
  let time = START;
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const h = createConsoleHandler({
    assetsDir,
    state: async () => ({ schema: "test", private: "authenticated-only" }),
    action: async (name, input) => { calls.push({ name, input }); return { done: true }; },
    allowedActions: ["configure", "checks"],
    ...overrides,
  }, PORT, { now: () => time });
  return { h, calls, advance: (milliseconds: number) => { time += milliseconds; } };
}

function request(h: ConsoleHandler, path: string, options: {
  method?: string;
  body?: unknown;
  session?: BrowserSession;
  headers?: Record<string, string | null | undefined>;
  rawBody?: string | ReadableStream;
} = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers({ host: `127.0.0.1:${h.port}`, "X-Ohmyaihub-Request": "1", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
  if (method === "POST") {
    headers.set("origin", h.origin);
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", randomUUID());
  }
  if (options.session) {
    headers.set("cookie", options.session.cookie);
    headers.set(CSRF_HEADER, options.session.csrf);
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(`${h.origin}${path}`, {
    method, headers,
    ...(options.rawBody !== undefined ? { body: options.rawBody, duplex: "half" } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  } as RequestInit);
}

function ticket(h: ConsoleHandler): string {
  const url = h.issueTicket();
  expect(url).toStartWith(`${h.origin}/#ticket=`);
  const value = new URLSearchParams(new URL(url).hash.slice(1)).get("ticket")!;
  expect(value).toMatch(/^[0-9a-f]{64}$/);
  return value;
}

async function exchange(h: ConsoleHandler, value: string, session?: BrowserSession): Promise<Response> {
  return h.handle(request(h, "/ui/session", { method: "POST", body: { ticket: value }, session }));
}

async function open(h: ConsoleHandler): Promise<BrowserSession> {
  const response = await exchange(h, ticket(h));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, ...await response.json() };
}

async function action(h: ConsoleHandler, session: BrowserSession, body: unknown = {}, headers?: Record<string, string | null | undefined>, name = "configure") {
  return h.handle(request(h, `/ui/api/action/${name}`, { method: "POST", body, session, headers }));
}

describe("console static perimeter", () => {
  test("only exact shipped assets, strong headers, anonymous shell and no token side effects", async () => {
    const { h } = fixture();
    const issued = ticket(h);
    for (const path of ["/", "/app.js", "/style.css", "/session.js", "/providers.js"]) {
      const response = await h.handle(request(h, path));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      const csp = response.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
      expect(response.headers.has("set-cookie")).toBe(false);
      const text = await response.text();
      for (const sentinel of [issued, "authenticated-only", "PRIVATE_FILE_SENTINEL"]) expect(text).not.toContain(sentinel);
    }
    for (const path of ["/index.html", "/private.json", "/src/server.ts", "/api/caller-keys", "/health", "/ui/api/state/", "/%2e%2e/private.json", "/%2e%2e%2fprivate.json", "/app.js%00", "//private.json"]) {
      const response = await h.handle(request(h, path));
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain("PRIVATE_FILE_SENTINEL");
    }
    expect((await h.handle(request(h, "/?ticket=not-a-secret"))).status).toBe(400);
  });

  test("manifest permits only exact host-selected modules and refuses traversal/symlinks", async () => {
    const moduleDir = mkdtempSync(join(tmpdir(), "ohmyaihub-console-manifest-"));
    try {
      for (const name of ["index.html", "app.js", "style.css", "session.js", "providers.js"]) writeFileSync(join(moduleDir, name), "asset");
      mkdirSync(join(moduleDir, "modules"));
      writeFileSync(join(moduleDir, "modules", "view.js"), "export const ok = true;");
      const h = fixture({ assetsDir: moduleDir, staticModules: ["/modules/view.js"] }).h;
      expect((await h.handle(request(h, "/modules/view.js"))).status).toBe(200);
      expect((await h.handle(request(h, "/modules/other.js"))).status).toBe(404);
      for (const name of ["/../other.js", "/%2e%2e/x.js", "/view.js?secret=x", "view.js", "/x.json", "/a//b.js"]) {
        expect(() => fixture({ assetsDir: moduleDir, staticModules: [name] })).toThrow("invalid shipped console module path");
      }
      symlinkSync(join(assetsDir, "private.json"), join(moduleDir, "outside.js"));
      expect(() => fixture({ assetsDir: moduleDir, staticModules: ["/outside.js"] })).toThrow("outside its shipped directory");
    } finally { rmSync(moduleDir, { recursive: true, force: true }); }
  });

  test("exact Host+port and URL origin prevent rebinding, LAN and alternate loopbacks", async () => {
    const { h } = fixture();
    for (const host of [null, "evil.example:39991", "127.0.0.1:39992", "localhost:39991", "127.1:39991", "[::1]:39991", "0.0.0.0:39991", "127.0.0.1", "127.0.0.1:039991", "127.0.0.1:39991, evil.example"]) {
      const response = await h.handle(request(h, "/", { headers: { host } }));
      expect(response.status, String(host)).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    const mismatched = new Request("http://evil.example:39991/", { headers: { host: `127.0.0.1:${PORT}` } });
    expect((await h.handle(mismatched)).status).toBe(403);
    for (const origin of ["null", "https://evil.example", `http://localhost:${PORT}`, `http://127.0.0.1:${PORT + 1}`]) {
      expect((await h.handle(request(h, "/", { headers: { origin } }))).status).toBe(403);
    }
  });

  test("cross-site requests and unexpected Fetch Metadata denied, no CORS preflight", async () => {
    const { h } = fixture();
    const session = await open(h);
    for (const site of ["cross-site", "same-site", "none", "garbage"]) {
      expect((await h.handle(request(h, "/ui/api/state", { session, headers: { "sec-fetch-site": site } }))).status).toBe(403);
    }
    for (const [name, value] of [["sec-fetch-mode", "navigate"], ["sec-fetch-mode", "no-cors"], ["sec-fetch-dest", "iframe"], ["sec-fetch-dest", "script"]]) {
      expect((await h.handle(request(h, "/ui/api/state", { session, headers: { [name!]: value! } }))).status).toBe(403);
    }
    const response = await h.handle(request(h, "/ui/session", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }));
    expect(response.status).toBe(403);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    // Engines without Fetch Metadata still have Host, exact mutation Origin, CSRF and custom-read-header guards.
    expect((await h.handle(request(h, "/ui/api/state", { session, headers: { "sec-fetch-site": null, "sec-fetch-mode": null, "sec-fetch-dest": null } }))).status).toBe(200);
  });
});

describe("one-use tickets and host-memory sessions", () => {
  test("ticket not usable as cookie/CSRF/bearer; single-use even during concurrent exchange", async () => {
    const { h } = fixture();
    const value = ticket(h);
    const responses = await Promise.all([exchange(h, value), exchange(h, value)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    expect((await exchange(h, value)).status).toBe(401);
    for (const value of ["", "a", "0".repeat(64), "A".repeat(64)]) expect((await exchange(h, value)).status).toBe(401);
    expect((await h.handle(request(h, "/ui/api/state", { headers: { authorization: `Bearer ${value}` } }))).status).toBe(401);
    expect((await h.handle(request(h, "/ui/api/state", { headers: { cookie: `ticket=${value}` } }))).status).toBe(401);
  });

  test("ticket expiry precise, cap32 bounded and consumed/expired slots reclaimed", async () => {
    const f = fixture();
    const values = Array.from({ length: 32 }, () => ticket(f.h));
    expect(() => f.h.issueTicket()).toThrow("ticket limit");
    expect((await exchange(f.h, values[0]!)).status).toBe(200);
    ticket(f.h);
    expect(() => f.h.issueTicket()).toThrow("ticket limit");
    f.advance(TICKET_TTL);
    expect((await exchange(f.h, values[1]!)).status).toBe(401);
    ticket(f.h);
  });

  test("cookie stable per-port HttpOnly Strict /ui without Secure by default; explicit probe switch", async () => {
    const { h } = fixture();
    const response = await exchange(h, ticket(h));
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^ohmyaihub_ui_39991=[0-9a-f]{64}; Path=\/ui\/; HttpOnly; SameSite=Strict$/);
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("Domain");
    expect(cookie).not.toContain("Expires");
    expect(cookie).not.toContain("Max-Age");
    expect(await response.text()).not.toContain(cookie.split(";")[0]!.split("=")[1]!);
    const secure = fixture({ secureCookie: true }).h;
    const secureResponse = await exchange(secure, ticket(secure));
    expect(secureResponse.headers.get("set-cookie")).toEndWith("; Secure");
  });

  test("reauthorization overwrites one cookie across repeated restarts and two ports keep independent sessions", async () => {
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    function acceptCookie(response: Response) {
      const full = response.headers.get("set-cookie")!;
      const pair = full.split(";")[0]!;
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals);
      if (full.includes("Max-Age=0")) jar.delete(name);
      else jar.set(name, pair.slice(equals + 1));
    }
    const peer = createConsoleHandler({ assetsDir, allowedActions: [], state: async () => ({ peer: true }), action: async () => ({}) }, PORT + 1);
    const peerSession = await open(peer);
    jar.set(peerSession.cookie.split("=")[0]!, peerSession.cookie.split("=")[1]!);
    let previousId = "";
    let previousInstance = "";
    for (let restart = 0; restart < 100; restart++) {
      const { h } = fixture();
      expect((await h.handle(request(h, "/ui/session", { headers: { cookie: cookieHeader() } }))).status).toBe(401);
      const response = await h.handle(request(h, "/ui/session", { method: "POST", body: { ticket: ticket(h) }, headers: { cookie: cookieHeader() } }));
      expect(response.status).toBe(200);
      const info = await response.json();
      expect(info.instance).not.toBe(previousInstance);
      previousInstance = info.instance;
      acceptCookie(response);
      const currentId = jar.get("ohmyaihub_ui_" + PORT)!;
      expect(currentId).not.toBe(previousId);
      previousId = currentId;
      expect(jar.size).toBe(2);
      expect(cookieHeader().length).toBeLessThan(250);
      expect((await h.handle(request(h, "/ui/api/state", { headers: { cookie: cookieHeader() } }))).status).toBe(200);
      expect((await peer.handle(request(peer, "/ui/api/state", { headers: { cookie: cookieHeader() } }))).status).toBe(200);
      if (restart === 99) {
        const logout = await h.handle(request(h, "/ui/logout", { method: "POST", body: {}, headers: { cookie: cookieHeader(), [CSRF_HEADER]: info.csrf } }));
        expect(logout.status).toBe(200);
        acceptCookie(logout);
        expect(jar.size).toBe(1);
        expect((await peer.handle(request(peer, "/ui/session", { headers: { cookie: cookieHeader() } }))).status).toBe(200);
      }
      h.stop();
    }
    expect((await peer.handle(request(peer, "/ui/session", { headers: { cookie: "ohmyaihub_ui_" + (PORT + 1) + "=" + previousId } }))).status).toBe(401);
    peer.stop();
  });

  test("session max16 fail closed, logout reclaims capacity, replacement invalidates old cookie", async () => {
    const { h } = fixture();
    const sessions = [];
    for (let i = 0; i < 16; i++) sessions.push(await open(h));
    const pendingTicket = ticket(h);
    expect((await exchange(h, pendingTicket)).status).toBe(429);
    const replacement = await exchange(h, pendingTicket, sessions[0]);
    expect(replacement.status).toBe(200);
    expect((await h.handle(request(h, "/ui/session", { session: sessions[0] }))).status).toBe(401);
    const logout = await h.handle(request(h, "/ui/logout", { method: "POST", body: {}, session: sessions[1] }));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await h.handle(request(h, "/ui/session", { session: sessions[1] }))).status).toBe(401);
    await open(h);
  });

  test("same-host reload resumes; passive state/session reads do not renew idle", async () => {
    const f = fixture();
    const session = await open(f.h);
    expect(session.expiresAt).toBe(new Date(START + IDLE).toISOString());
    f.advance(IDLE - 1);
    const resumed = await f.h.handle(request(f.h, "/ui/session", { session }));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ csrf: session.csrf, instance: session.instance, expiresAt: session.expiresAt });
    expect(resumed.headers.has("set-cookie")).toBe(false);
    expect((await f.h.handle(request(f.h, "/ui/api/state", { session }))).status).toBe(200);
    f.advance(1);
    expect((await f.h.handle(request(f.h, "/ui/api/state", { session }))).status).toBe(401);
    expect((await action(f.h, session)).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });

  test("only a successful new action renews idle, never replay, validation or uncertain failure", async () => {
    const f = fixture();
    const session = await open(f.h);
    f.advance(IDLE - 1);
    const id = randomUUID();
    expect((await action(f.h, session, {}, { "idempotency-key": id })).status).toBe(200);
    f.advance(IDLE - 1);
    expect((await action(f.h, session, {}, { "idempotency-key": id })).status).toBe(200);
    f.advance(1);
    expect((await action(f.h, session)).status).toBe(401);
    expect(f.calls).toHaveLength(1);
    for (const failure of [new ConsoleInputError(), new Error("SECRET_backend_path")]) {
      const fail = fixture({ action: async () => { throw failure; } });
      const session = await open(fail.h);
      fail.advance(IDLE - 1);
      expect((await action(fail.h, session)).status).toBe(failure instanceof ConsoleInputError ? 400 : 500);
      fail.advance(1);
      expect((await action(fail.h, session)).status).toBe(401);
    }
  });

  test("absolute8h expires even with explicit actions, and old instances/tickets do not survive restart", async () => {
    const f = fixture();
    const session = await open(f.h);
    for (let step = 1; step < 32; step++) {
      f.advance(15 * 60_000);
      expect((await action(f.h, session)).status).toBe(200);
    }
    const res = await f.h.handle(request(f.h, "/ui/session", { session }));
    expect((await res.json()).expiresAt).toBe(new Date(START + ABSOLUTE).toISOString());
    f.advance(15 * 60_000);
    expect((await action(f.h, session)).status).toBe(401);
    const oldTicket = ticket(f.h);
    const freshSession = await open(f.h);
    f.h.stop();
    expect(() => f.h.issueTicket()).toThrow("stopped");
    expect((await f.h.handle(request(f.h, "/"))).status).toBe(503);
    const restarted = fixture().h;
    expect((await exchange(restarted, oldTicket)).status).toBe(401);
    expect((await restarted.handle(request(restarted, "/ui/session", { session: freshSession }))).status).toBe(401);
    expect((await open(restarted)).instance).not.toBe(freshSession.instance);
  });

  test("duplicate/malformed session cookies refused; non-browser tokens do not replace cookie", async () => {
    const { h } = fixture();
    const session = await open(h);
    for (const cookie of [session.cookie + "; " + session.cookie, session.cookie.split("=")[0] + "=attacker", "a=" + "x".repeat(9000)]) {
      expect((await h.handle(request(h, "/ui/session", { session, headers: { cookie } }))).status).toBe(401);
    }
    const response = await h.handle(request(h, "/ui/session", { session, headers: { authorization: "Bearer CLI_API_SECRET_SENTINEL" } }));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("CLI_API_SECRET_SENTINEL");
    const cli = createCliHandler({ status: async () => ({}) } as never, "separate-cli-token", PORT);
    expect((await cli(request(h, "/status", { session }))).status).toBe(401);
    expect((await h.handle(request(h, "/status", { session }))).status).toBe(404);
  });
});

describe("authenticated actions and bounded idempotency", () => {
  test("read custom header, mutation Origin, CSRF, cookie and request header all enforced", async () => {
    const { h, calls } = fixture();
    const session = await open(h);
    expect((await h.handle(request(h, "/ui/api/state"))).status).toBe(401);
    expect((await h.handle(request(h, "/ui/api/state", { session, headers: { "X-Ohmyaihub-Request": null } }))).status).toBe(403);
    for (const headers of [
      { origin: null }, { origin: "null" }, { origin: "https://evil.example" },
      { [CSRF_HEADER]: null }, { [CSRF_HEADER]: "a".repeat(64) },
      { "X-Ohmyaihub-Request": null }, { cookie: null },
    ]) {
      const response = await action(h, session, {}, headers);
      expect([401, 403]).toContain(response.status);
      const logout = await h.handle(request(h, "/ui/logout", { method: "POST", body: {}, session, headers }));
      expect([401, 403]).toContain(logout.status);
    }
    expect((await exchange(h, ticket(h))).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  test("exchange also demands exact Origin/JSON and rejects cross-site, before consuming ticket", async () => {
    const { h } = fixture();
    const value = ticket(h);
    for (const headers of [{ origin: null }, { origin: "https://evil.example" }, { "content-type": "text/plain" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await h.handle(request(h, "/ui/session", { method: "POST", body: { ticket: value }, headers }));
      expect([403, 415]).toContain(response.status);
    }
    expect((await exchange(h, value)).status).toBe(200);
  });

  test("backend direct callback has exact action allowlist, no dynamic service dispatch", async () => {
    const { h, calls } = fixture();
    const session = await open(h);
    for (const name of ["constructor", "__proto__", "toString", "supervisor/stop", "consumers/add", "configure/extra", "%63onfigure"]) {
      expect((await action(h, session, {}, undefined, name)).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
    expect((await action(h, session, { sharingEnabled: true })).status).toBe(200);
    expect(calls).toEqual([{ name: "configure", input: { sharingEnabled: true } }]);
    expect(() => fixture({ allowedActions: ["../escape"] })).toThrow("invalid console action name");
  });

  test("idempotency UUID required; same UUID+canonical payload one operation, mismatch409", async () => {
    const { h, calls } = fixture();
    const session = await open(h);
    for (const id of [null, "not-a-uuid", "1", "00000000-0000-0000-0000-000000000000"]) {
      expect((await action(h, session, {}, { "idempotency-key": id })).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    const id = randomUUID();
    const first = await action(h, session, { b: { z: 2, a: 1 }, a: true }, { "idempotency-key": id });
    const second = await action(h, session, { a: true, b: { a: 1, z: 2 } }, { "idempotency-key": id.toUpperCase() });
    expect(await first.json()).toEqual(await second.json());
    expect(calls).toHaveLength(1);
    expect((await action(h, session, { a: false }, { "idempotency-key": id })).status).toBe(409);
    expect((await action(h, session, { b: { z: 2, a: 1 }, a: true }, { "idempotency-key": id }, "checks")).status).toBe(409);
    expect(calls).toHaveLength(1);
    const otherSession = await open(h);
    expect((await action(h, otherSession, {}, { "idempotency-key": id })).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("concurrent duplicates share one in-flight result, uncertain failure is cached without leaks", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { h } = fixture({ action: async () => { calls++; await pending; throw new Error("PRIVATE_KEY_AND_STACK_SENTINEL"); } });
    const session = await open(h);
    const id = randomUUID();
    const first = action(h, session, {}, { "idempotency-key": id });
    const second = action(h, session, {}, { "idempotency-key": id });
    release();
    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "action_outcome_unknown", code: "outcome_unknown" });
    }
    expect(calls).toBe(1);
    const replay = await action(h, session, {}, { "idempotency-key": id });
    expect(replay.status).toBe(500);
    expect(await replay.text()).not.toContain("PRIVATE_KEY_AND_STACK_SENTINEL");
    expect(calls).toBe(1);
  });

  test("operation cache128 fails closed rather than evicting a spent key; failures/large results bounded", async () => {
    const { h, calls } = fixture();
    const session = await open(h);
    const ids = Array.from({ length: 128 }, () => randomUUID());
    for (const id of ids) expect((await action(h, session, {}, { "idempotency-key": id })).status).toBe(200);
    expect((await action(h, session)).status).toBe(429);
    expect((await action(h, session, {}, { "idempotency-key": ids[0]! })).status).toBe(200);
    expect(calls).toHaveLength(128);
    const bounded = fixture({ action: async () => "sensitive".repeat(64 * 1024) }).h;
    const largeResponse = await action(bounded, await open(bounded));
    expect(largeResponse.status).toBe(500);
    expect((await largeResponse.text()).length).toBeLessThan(200);
  });

  test("sensitive response has one owner; concurrent/replayed UUID409 without secret or backend repeat", async () => {
    const key = "reveal-response-only-sentinel";
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const { h } = fixture({ allowedActions: ["configure", "key-reveal"], sensitiveActions: ["key-reveal"], action: async () => { calls++; started(); await pending; return { key }; } });
    const session = await open(h);
    const id = randomUUID();
    const first = action(h, session, { consumerId: "consumer" }, { "idempotency-key": id }, "key-reveal");
    await invoked;
    const concurrent = await action(h, session, { consumerId: "consumer" }, { "idempotency-key": id }, "key-reveal");
    expect(concurrent.status).toBe(409);
    expect(await concurrent.text()).not.toContain(key);
    expect(calls).toBe(1);
    release();
    const owner = await first;
    expect(owner.status).toBe(200);
    expect(owner.headers.get("cache-control")).toBe("no-store");
    expect(await owner.json()).toEqual({ result: { key } });
    for (const body of [{ consumerId: "consumer" }, { consumerId: "changed" }]) {
      const replay = await action(h, session, body, { "idempotency-key": id.toUpperCase() }, "key-reveal");
      expect(replay.status).toBe(409);
      expect(await replay.text()).not.toContain(key);
    }
    expect(calls).toBe(1);
    const state = await h.handle(request(h, "/ui/api/state", { session }));
    expect(await state.text()).not.toContain(key);
    // Another deliberate gesture has a fresh UUID and owns its own response.
    expect((await action(h, session, { consumerId: "consumer" }, undefined, "key-reveal")).status).toBe(200);
    expect(calls).toBe(2);
  });

  test("sensitive failures consume UUID, sanitized errors and expired/logged-out session never reveal", async () => {
    for (const failure of [new ConsoleInputError("consumerId is required"), new Error("RAW_REVEAL_SECRET_SENTINEL")]) {
      let calls = 0;
      const { h } = fixture({ allowedActions: ["key-reveal"], sensitiveActions: ["key-reveal"], action: async () => { calls++; throw failure; } });
      const session = await open(h);
      const id = randomUUID();
      const first = await action(h, session, {}, { "idempotency-key": id }, "key-reveal");
      expect(first.status).toBe(failure instanceof ConsoleInputError ? 400 : 500);
      expect(await first.text()).not.toContain("RAW_REVEAL_SECRET_SENTINEL");
      const replay = await action(h, session, {}, { "idempotency-key": id }, "key-reveal");
      expect(replay.status).toBe(409);
      expect(calls).toBe(1);
    }
    for (const logout of [false, true]) {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const invoked = new Promise<void>((resolve) => { started = resolve; });
      const f = fixture({ allowedActions: ["key-reveal"], sensitiveActions: ["key-reveal"], action: async () => { started(); await pending; return { key: "NO_STALE_SESSION_DISCLOSURE" }; } });
      const session = await open(f.h);
      const first = action(f.h, session, {}, undefined, "key-reveal");
      await invoked;
      if (logout) expect((await f.h.handle(request(f.h, "/ui/logout", { method: "POST", body: {}, session }))).status).toBe(200);
      else f.advance(IDLE);
      release();
      const res = await first;
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("NO_STALE_SESSION_DISCLOSURE");
    }
  });

  test("sensitive action guards and bounded tombstones with no retained response cache", async () => {
    let called = 0;
    const { h } = fixture({ allowedActions: ["key-reveal"], sensitiveActions: ["key-reveal"], action: async () => { called++; return { key: "x".repeat(220 * 1024) }; } });
    const session = await open(h);
    for (const headers of [{ origin: null }, { [CSRF_HEADER]: null }, { "idempotency-key": null }, { ["X-Ohmyaihub-Request"]: null }]) {
      expect([400, 403]).toContain((await action(h, session, {}, headers, "key-reveal")).status);
    }
    expect(called).toBe(0);
    const firstId = randomUUID();
    for (let i = 0; i < 128; i++) {
      const res = await action(h, session, {}, { "idempotency-key": i === 0 ? firstId : randomUUID() }, "key-reveal");
      expect(res.status).toBe(200);
      await res.text();
    }
    // A retained 220KiB result per operation would hit the2MiB session cache
    // after9 calls. All128 complete, leaving bounded fingerprint tombstones.
    expect(called).toBe(128);
    expect((await action(h, session, {}, undefined, "key-reveal")).status).toBe(429);
    expect((await action(h, session, {}, { "idempotency-key": firstId }, "key-reveal")).status).toBe(409);
    expect(called).toBe(128);
    expect(() => fixture({ sensitiveActions: ["key-reveal"] })).toThrow("sensitive action must be an allowed console action");
  });

  test("logout or idle expiry during in-flight work cannot resurrect session or disclose result", async () => {
    for (const logout of [true, false]) {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const invoked = new Promise<void>((resolve) => { started = resolve; });
      const f = fixture({ action: async () => { started(); await pending; return { result: "private" }; } });
      const session = await open(f.h);
      const actionResponse = action(f.h, session);
      await invoked;
      if (logout) expect((await f.h.handle(request(f.h, "/ui/logout", { method: "POST", body: {}, session }))).status).toBe(200);
      else f.advance(IDLE);
      release();
      expect((await actionResponse).status).toBe(401);
      expect((await f.h.handle(request(f.h, "/ui/session", { session }))).status).toBe(401);
    }
  });

  test("safe validation feedback bounded/redacted; no raw backend exception crosses HTTP", async () => {
    const credential = "registered-validation-credential-sentinel";
    registerSecret(credential);
    const f = fixture({ action: async () => { throw new ConsoleInputError(`networkName is required; ${credential}; /Users/lab/private; https://example.invalid/private\n${"x".repeat(500)}`); } });
    const response = await action(f.h, await open(f.h));
    expect(response.status).toBe(400);
    const value = await response.json();
    expect(value.error).toBe("invalid_action_input");
    expect(value.message).toContain("networkName is required");
    expect(value.message.length).toBeLessThanOrEqual(300);
    expect(value.message).not.toContain(credential);
    expect(value.message).not.toContain("/Users/lab/private");
    expect(value.message).not.toContain("example.invalid");
    expect(value.message).not.toContain("\n");
  });

  test("large state has independent2MiB cap while action cache bytes fail closed and reclaim on logout", async () => {
    for (const [size, expected] of [[100 * 1024, 200], [2 * 1024 * 1024, 500]]) {
      const h = fixture({ state: async () => ({ value: "x".repeat(size!) }) }).h;
      expect((await h.handle(request(h, "/ui/api/state", { session: await open(h) }))).status).toBe(expected!);
    }
    let called = 0;
    const h = fixture({ action: async () => { called++; return "x".repeat(220 * 1024); } }).h;
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const sessions = [];
    let globalFull = false;
    for (let index = 0; index < 5; index++) {
      const session = await open(h);
      sessions.push(session);
      let successes = 0;
      for (let n = 0; n < 12; n++) {
        const response = await action(h, session, {}, { "idempotency-key": n === 0 ? ids[index]! : randomUUID() });
        if (response.status === 429) break;
        expect(response.status).toBe(200);
        successes++;
      }
      expect(successes).toBeLessThan(12);
      if (successes < 9) globalFull = true;
    }
    expect(globalFull).toBe(true);
    expect(called).toBeLessThan(40);
    // Replay still available at the cap; clearing a session recovers bytes.
    expect((await action(h, sessions[0]!, {}, { "idempotency-key": ids[0]! })).status).toBe(200);
    expect((await h.handle(request(h, "/ui/logout", { method: "POST", body: {}, session: sessions[0] }))).status).toBe(200);
    expect((await action(h, sessions[4]!)).status).toBe(200);
  });

  test("in-flight reservation remains bounded across logout until backend settles", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const f = fixture({ action: async () => { started++; await pending; return {}; } });
    const inflight: Promise<Response>[] = [];
    const sessions = [];
    for (let i = 0; i < 4; i++) sessions.push(await open(f.h));
    for (const session of sessions) {
      for (let i = 0; i < 8; i++) inflight.push(action(f.h, session));
    }
    // Logout is processed after all bounded bodies above have been read and work claimed.
    for (const session of sessions) expect((await f.h.handle(request(f.h, "/ui/logout", { method: "POST", body: {}, session }))).status).toBe(200);
    expect(started).toBe(32);
    const replacement = await open(f.h);
    expect((await action(f.h, replacement)).status).toBe(429);
    release();
    expect((await Promise.all(inflight)).every((response) => response.status === 401)).toBe(true);
    expect((await action(f.h, replacement)).status).toBe(200);
  });

  test("state exceptions are sanitized, no cache; expiry while reading hides state", async () => {
    const failure = fixture({ state: async () => { throw new Error("RAW_PATH_KEY_SENTINEL"); } });
    const response = await failure.h.handle(request(failure.h, "/ui/api/state", { session: await open(failure.h) }));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("RAW_PATH_KEY_SENTINEL");
    const f = fixture({ state: async () => { f.advance(IDLE); return "PRIVATE_RESULT"; } });
    const expired = await f.h.handle(request(f.h, "/ui/api/state", { session: await open(f.h) }));
    expect(expired.status).toBe(401);
    expect(await expired.text()).not.toContain("PRIVATE_RESULT");
  });
});

describe("body bounds and real loopback listener", () => {
  test("strict JSON object and Content-Type required; size based on UTF8 bytes and declared length", async () => {
    const { h, calls } = fixture();
    const session = await open(h);
    for (const rawBody of ["", "invalid", "null", "[]", "1", '"text"']) {
      expect((await h.handle(request(h, "/ui/api/action/configure", { method: "POST", session, rawBody }))).status).toBe(400);
    }
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "application/jsonx", "application/json; charset=latin1"]) {
      expect((await action(h, session, {}, { "content-type": type })).status).toBe(415);
    }
    expect((await action(h, session, {}, { "content-encoding": "gzip" })).status).toBe(415);
    expect((await action(h, session, {}, { "content-length": "65537" })).status).toBe(413);
    expect((await action(h, session, {}, { "content-length": "nonsense" })).status).toBe(400);
    expect((await action(h, session, { text: "中".repeat(30_000) })).status).toBe(413);
    expect(calls).toHaveLength(0);
    expect((await action(h, session, {}, { "content-type": "application/json; charset=UTF-8" })).status).toBe(200);
  });

  test("chunked input cancelled beyond64KiB and never calls backend; unreadable/invalidUTF8 fails", async () => {
    const { h, calls } = fixture();
    const session = await open(h);
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)); },
      cancel() { cancelled = true; },
    });
    const response = await h.handle(request(h, "/ui/api/action/configure", { method: "POST", session, rawBody: stream }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    const broken = new ReadableStream({ start(controller) { controller.error(new Error("secret-read-failure")); } });
    expect((await h.handle(request(h, "/ui/api/action/configure", { method: "POST", session, rawBody: broken }))).status).toBe(400);
    const invalid = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
    expect((await h.handle(request(h, "/ui/api/action/configure", { method: "POST", session, rawBody: invalid }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("slow request body cannot claim expired ticket or start a mutation after session expires", async () => {
    for (const exchangeTicket of [true, false]) {
      const f = fixture();
      const session = await open(f.h);
      const body = exchangeTicket ? { ticket: ticket(f.h) } : {};
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          f.advance(exchangeTicket ? TICKET_TTL : IDLE);
          controller.close();
        },
      });
      const response = await f.h.handle(request(f.h, exchangeTicket ? "/ui/session" : "/ui/api/action/configure", { method: "POST", session, rawBody: stream }));
      expect(response.status).toBe(401);
      expect(f.calls).toHaveLength(0);
    }
  });

  test("shipped browser session client exchanges, reads, acts and logs out against real handler", async () => {
    const { createSessionClient } = await import(new URL("../console/session.js", import.meta.url).href);
    const { h, calls } = fixture();
    let cookie = "";
    const client = createSessionClient({ fetch: async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("host", `127.0.0.1:${PORT}`);
      headers.set("sec-fetch-site", "same-origin");
      if (init.method === "POST") headers.set("origin", h.origin);
      if (cookie) headers.set("cookie", cookie);
      const response = await h.handle(new Request(h.origin + path, { ...init, headers }));
      if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      return response;
    } });
    await client.open(ticket(h));
    expect(await client.state()).toEqual({ schema: "test", private: "authenticated-only" });
    expect(await client.action("configure", { sharingEnabled: true })).toEqual({ done: true });
    expect(calls).toHaveLength(1);
    await client.logout();
    expect((await h.handle(request(h, "/ui/api/state", { headers: { cookie } }))).status).toBe(401);
    client.dispose();
  });

  test("real server binds127, serves static and cookie state, no CLI route or bearer access", async () => {
    const server = startConsoleServer({ assetsDir, state: async () => ({ configured: false }), action: async () => ({}), allowedActions: ["configure"] });
    try {
      expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
      const shell = await fetch(server.origin);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain("anonymous shell");
      const value = new URLSearchParams(new URL(server.issueTicket()).hash.slice(1)).get("ticket");
      const response = await fetch(`${server.origin}/ui/session`, { method: "POST", headers: { origin: server.origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: value }) });
      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const state = await fetch(`${server.origin}/ui/api/state`, { headers: { cookie, "X-Ohmyaihub-Request": "1" } });
      expect(state.status).toBe(200);
      expect(await state.json()).toEqual({ configured: false });
      expect((await fetch(`${server.origin}/ui/api/state`, { headers: { authorization: "Bearer unrelated-cli-token" } })).status).toBe(401);
      expect((await fetch(`${server.origin}/status`, { headers: { cookie } })).status).toBe(404);
    } finally { server.stop(); }
  });
});
