import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, symlinkSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsolePairingJournal, PairingUnavailableError } from "../src/console-pairing.ts";
import { createConsoleHandler, startConsoleServer } from "../src/console-server.ts";
import type { BrowserPairing } from "../src/console-pairing.ts";
import type { ConsoleHandler } from "../src/console-server.ts";

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const PORT = 39887;
const START = Date.parse("2026-10-30T12:00:00Z");
const TTL = 120_000;
const REQUEST_HEADER = "X-Ohmyaihub-Request";
const CSRF_HEADER = REQUEST_HEADER.replace(/Request$/, "CS" + "RF");

function lab() {
  const root = mkdtempSync(join(tmpdir(), "ohmyaihub-pairing-test-"));
  folders.push(root);
  const assetsDir = join(root, "assets");
  mkdirSync(assetsDir);
  for (const name of ["index.html", "app.js", "style.css", "session.js", "providers.js"]) writeFileSync(join(assetsDir, name), "anonymous");
  const pairingFile = join(root, "state", "console-pairing.json");
  let time = START;
  const options = { assetsDir, pairingFile, state: async () => ({ authenticated: true }), action: async () => ({ changed: true }), allowedActions: ["configure"] };
  return {
    root, assetsDir, pairingFile, options,
    host: (enabled = true) => createConsoleHandler({ ...options, pairingFile: enabled ? pairingFile : undefined }, PORT, { now: () => time }),
    journal: () => new ConsolePairingJournal(pairingFile, () => time),
    advance: (ms: number) => { time += ms; },
  };
}

function req(h: ConsoleHandler, path: string, body?: unknown, headers: Record<string, string | null | undefined> = {}) {
  const all = new Headers({ host: `127.0.0.1:${h.port}`, [REQUEST_HEADER]: "1", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
  if (body !== undefined) {
    all.set("origin", h.origin);
    all.set("content-type", "application/json");
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) all.delete(name);
    else if (value !== undefined) all.set(name, value);
  }
  return new Request(h.origin + path, { method: body === undefined ? "GET" : "POST", headers: all, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function pair(h: ConsoleHandler): Promise<BrowserPairing> {
  const res = await h.handle(req(h, "/ui/pairing", {}));
  expect(res.status).toBe(200);
  expect(res.headers.has("set-cookie")).toBe(false);
  const p = await res.json();
  expect(Object.keys(p).sort()).toEqual(["code", "expiresAt", "id", "secret"]);
  expect(p.id).toMatch(/^[0-9a-f]{32}$/);
  expect(p.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(p.code).toMatch(/^[0-9]{8}$/);
  return p;
}
function exchange(h: ConsoleHandler, p: BrowserPairing, headers?: Record<string, string | null>) {
  return h.handle(req(h, "/ui/pairing/exchange", { id: p.id, secret: p.secret }, headers));
}
async function ticketSession(h: ConsoleHandler) {
  const ticket = new URLSearchParams(new URL(h.issueTicket()).hash.slice(1)).get("ticket");
  const res = await h.handle(req(h, "/ui/session", { ticket }));
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, ...await res.json() };
}

function disk(file: string) { return JSON.parse(readFileSync(file, "utf8")); }

describe("explicit browser pairing transport", () => {
  test("disabled unless host supplies own journal; no anonymous session before approval", async () => {
    const l = lab();
    const disabled = l.host(false);
    expect((await disabled.handle(req(disabled, "/ui/pairing", {}))).status).toBe(404);
    expect(disabled.pendingPairings()).toEqual([]);
    expect(disabled.approvePairing("a".repeat(32), "12345678")).toBe(false);
    const h = l.host();
    const p = await pair(h);
    expect((await h.handle(req(h, "/ui/api/state"))).status).toBe(401);
    for (let i = 0; i < 3; i++) {
      const res = await exchange(h, p);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ pending: true });
      expect(res.headers.has("set-cookie")).toBe(false);
    }
    expect(disk(l.pairingFile).records[0].state).toBe("pending");
    expect(h.pendingPairings()).toEqual([{ id: p.id, code: p.code, expiresAt: p.expiresAt }]);
  });

  test("official approval binds exact public id+8digit code, secret still required and consumed only once", async () => {
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    const other = await pair(h);
    for (const [id, code] of [[p.id, "wrong"], [p.id, p.code === "00000000" ? "11111111" : "00000000"], ["e".repeat(32), p.code]]) {
      expect(h.approvePairing(id!, code!)).toBe(false);
    }
    expect((await exchange(h, p)).status).toBe(202);
    expect(h.approvePairing(p.id, p.code)).toBe(true);
    expect(h.approvePairing(p.id, p.code)).toBe(true);
    expect((await exchange(h, { ...p, secret: "a".repeat(64) })).status).toBe(401);
    expect((await exchange(h, { ...p, secret: p.code })).status).toBe(401);
    expect((await exchange(h, { ...p, secret: other.secret })).status).toBe(401);
    expect((await exchange(h, other)).status).toBe(202);
    const responses = await Promise.all([exchange(h, p), exchange(h, p)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    const res = responses.find((r) => r.status === 200)!;
    const info = await res.json();
    expect(Object.keys(info).sort()).toEqual(["csrf", "expiresAt", "instance"]);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await h.handle(req(h, "/ui/api/state", undefined, { cookie }))).status).toBe(200);
    expect(disk(l.pairingFile).records.find((r: any) => r.id === p.id).state).toBe("consumed");
    expect(h.approvePairing(p.id, p.code)).toBe(false);
    expect((await exchange(h, p)).status).toBe(401);
    expect(h.pendingPairings()).toEqual([{ id: other.id, code: other.code, expiresAt: other.expiresAt }]);
  });

  test("pending/approved preauth survives official restart, existing sessions and tickets never survive", async () => {
    const l = lab();
    const original = l.host();
    const oldSession = await ticketSession(original);
    const oldTicket = new URLSearchParams(new URL(original.issueTicket()).hash.slice(1)).get("ticket");
    const p = await pair(original);
    const p2 = await pair(original);
    original.stop();
    const approved = l.host();
    expect(approved.pendingPairings()).toHaveLength(2);
    expect(approved.approvePairing(p.id, p.code)).toBe(true);
    expect((await exchange(approved, p2)).status).toBe(202);
    approved.stop(); // approval may be saved by the old owner just before retirement
    const restarted = l.host();
    expect((await restarted.handle(req(restarted, "/ui/session", { ticket: oldTicket }))).status).toBe(401);
    expect((await restarted.handle(req(restarted, "/ui/session", undefined, { cookie: oldSession.cookie }))).status).toBe(401);
    const res = await exchange(restarted, p);
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.instance).not.toBe(oldSession.instance);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie.split("=")[0]).toBe(oldSession.cookie.split("=")[0]);
    expect(cookie).not.toBe(oldSession.cookie);
    restarted.stop(); // response loss must not mint another session on next host
    const afterConsume = l.host();
    expect((await exchange(afterConsume, p)).status).toBe(401);
    expect(afterConsume.approvePairing(p.id, p.code)).toBe(false);
    expect((await afterConsume.handle(req(afterConsume, "/ui/session", undefined, { cookie }))).status).toBe(401);
  });

  test("expiry2min for pending/approved and cap8 with consumed tombstones retained, no eviction", async () => {
    const l = lab();
    const h = l.host();
    const records = [];
    for (let i = 0; i < 8; i++) records.push(await pair(h));
    const first = records[0]!;
    expect((await h.handle(req(h, "/ui/pairing", {}))).status).toBe(429);
    expect(h.pendingPairings()).toHaveLength(8);
    h.approvePairing(first.id, first.code);
    expect((await exchange(h, first)).status).toBe(200);
    expect((await h.handle(req(h, "/ui/pairing", {}))).status).toBe(429);
    l.advance(TTL - 1);
    expect((await exchange(h, records[1]!)).status).toBe(202);
    expect(h.approvePairing(records[2]!.id, records[2]!.code)).toBe(true);
    l.advance(1);
    expect(h.approvePairing(records[1]!.id, records[1]!.code)).toBe(false);
    expect((await exchange(h, records[2]!)).status).toBe(401);
    expect(h.pendingPairings()).toEqual([]);
    await pair(h);
    expect(disk(l.pairingFile).records).toHaveLength(1);
    expect((await exchange(h, first)).status).toBe(401);
  });

  test("new session retains idle+absolute/logout/CSRF rules, approval never renews a session", async () => {
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    h.approvePairing(p.id, p.code);
    const res = await exchange(h, p);
    const info = await res.json();
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const logout = () => h.handle(req(h, "/ui/logout", {}, { cookie, [CSRF_HEADER]: info.csrf }));
    expect((await h.handle(req(h, "/ui/logout", {}, { cookie }))).status).toBe(403);
    expect((await logout()).status).toBe(200);
    expect((await h.handle(req(h, "/ui/session", undefined, { cookie }))).status).toBe(401);
    expect((await exchange(h, p)).status).toBe(401);
    const p2 = await pair(h);
    h.approvePairing(p2.id, p2.code);
    const next = await exchange(h, p2);
    const nextCookie = next.headers.get("set-cookie")!.split(";")[0]!;
    l.advance(30 * 60_000);
    expect((await h.handle(req(h, "/ui/session", undefined, { cookie: nextCookie }))).status).toBe(401);
  });

  test("shipped browser client pairs across approval restart without secret persistence or test auth bypass", async () => {
    const { createSessionClient } = await import(new URL("../console/session.js", import.meta.url).href);
    const l = lab();
    let h = l.host();
    let cookie = "";
    let expired = 0;
    const client = createSessionClient({ now: () => START, onExpired: () => { expired++; }, fetch: async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("host", `127.0.0.1:${PORT}`);
      if (init.method === "POST") headers.set("origin", h.origin);
      if (cookie) headers.set("cookie", cookie);
      const response = await h.handle(new Request(h.origin + path, { ...init, headers }));
      if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      return response;
    } });
    try {
      await expect(client.open()).rejects.toMatchObject({ status: 401 });
      expect(expired).toBe(1);
      const publicPairing = await client.requestPairing();
      expect(Object.keys(publicPairing).sort()).toEqual(["code", "expiresAt", "id"]);
      expect(await client.pollPairing()).toEqual({ pending: true });
      // Official Magpie approval starts a new host; no ticket or bearer credential
      // enters the client. Host callback is the launcher integration boundary.
      h.stop();
      h = l.host();
      expect(h.approvePairing(publicPairing.id, publicPairing.code)).toBe(true);
      const authenticated = await client.pollPairing();
      expect(authenticated.pending).toBe(false);
      expect(authenticated.instance).toBeString();
      expect(await client.state()).toEqual({ authenticated: true });
      expect(await client.action("configure", {})).toEqual({ changed: true });
      await client.logout();
      await expect(client.state()).rejects.toMatchObject({ status: 401 });
      const again = await client.requestPairing();
      expect(again.id).not.toBe(publicPairing.id);
      expect(await client.pollPairing()).toEqual({ pending: true });
    } finally { client.dispose(); h.stop(); }
  });

  test("session limit checked before consuming approved request", async () => {
    const l = lab();
    const h = l.host();
    const sessions = [];
    for (let i = 0; i < 16; i++) sessions.push(await ticketSession(h));
    const p = await pair(h);
    expect(h.approvePairing(p.id, p.code)).toBe(true);
    expect((await exchange(h, p)).status).toBe(429);
    expect(disk(l.pairingFile).records[0].state).toBe("approved");
    const replacement = await exchange(h, p, { cookie: sessions[0]!.cookie });
    expect(replacement.status).toBe(200);
    expect((await h.handle(req(h, "/ui/session", undefined, { cookie: sessions[0]!.cookie }))).status).toBe(401);
    expect((await exchange(h, p)).status).toBe(401);
  });

  test("both anonymous endpoints enforce Host/Origin/request-header/metadata/JSON/token separation", async () => {
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    const guards: Record<string, string | null>[] = [
      { host: "evil.example:39887" }, { host: "localhost:39887" }, { host: "127.0.0.1:39888" },
      { origin: null }, { origin: "null" }, { origin: "https://evil.example" },
      { [REQUEST_HEADER]: null }, { [REQUEST_HEADER]: "0" },
      { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" },
      { "sec-fetch-mode": "navigate" }, { "sec-fetch-dest": "iframe" },
      { "content-type": null }, { "content-type": "text/plain" }, { "content-encoding": "gzip" },
      { authorization: "Bearer CLI_OR_SESSION_TOKEN_SENTINEL" },
    ];
    for (const [path, body] of [["/ui/pairing", {}], ["/ui/pairing/exchange", { id: p.id, secret: p.secret }]] as const) {
      for (const headers of guards) {
        const response = await h.handle(req(h, path, body, headers));
        expect([401, 403, 415]).toContain(response.status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
    }
    for (const body of [{ approve: true }, { id: p.id }, { id: p.id, code: p.code }, { id: p.id, secret: p.secret, approved: true }]) {
      expect((await h.handle(req(h, "/ui/pairing", body))).status).toBe(400);
      expect((await h.handle(req(h, "/ui/pairing/exchange", body))).status).toBe(400);
    }
    expect((await h.handle(req(h, "/ui/pairing", { text: "x".repeat(65536) }))).status).toBe(413);
    expect((await h.handle(req(h, "/ui/pairing", {}))).status).toBe(200);
    expect(h.pendingPairings()).toHaveLength(2);
    expect((await exchange(h, p)).status).toBe(202);
  });
});

describe("short-lived hashed-secret durable journal", () => {
  test("own0700directory/0600file, public snapshot contains no hash/secret/cookie, no backups/raw credentials", async () => {
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    expect(statSync(join(l.root, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(l.pairingFile).mode & 0o777).toBe(0o600);
    const text = readFileSync(l.pairingFile, "utf8");
    const journal = JSON.parse(text);
    expect(journal.records[0].secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.records[0].secretHash).not.toBe(p.secret);
    expect(text).not.toContain(p.secret);
    for (const word of ["csrf", "ticket", "cookie", "Bearer"]) expect(text).not.toContain(word);
    const snapshot = JSON.stringify(h.pendingPairings());
    expect(snapshot).not.toContain(p.secret);
    expect(snapshot).not.toContain(journal.records[0].secretHash);
    expect(snapshot).not.toContain("secretHash");
    expect(Object.keys(h.pendingPairings()[0]!).sort()).toEqual(["code", "expiresAt", "id"]);
    h.approvePairing(p.id, p.code);
    const response = await exchange(h, p);
    const cookie = response.headers.get("set-cookie")!;
    expect(readFileSync(l.pairingFile, "utf8")).not.toContain(cookie.split(";")[0]!.split("=")[1]!);
    expect(readdirSync(join(l.root, "state"))).toEqual(["console-pairing.json"]);
  });

  test("malformed journal is quarantined failclosed across API/approval, never recovered from old backup", async () => {
    const malformed: unknown[] = [null, [], {}, { version: 2, records: [] }, { version: 1, records: "invalid" }, { version: 1, records: [], extra: true }];
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    h.approvePairing(p.id, p.code);
    const valid = disk(l.pairingFile);
    const record = valid.records[0];
    malformed.push(
      { ...valid, records: [{ ...record, state: "unknown" }] },
      { ...valid, records: [{ ...record, secretHash: p.secret.slice(1) }] },
      { ...valid, records: [{ ...record, expiresAt: record.createdAt + TTL + 1 }] },
      { ...valid, records: [{ ...record, secret: p.secret }] },
      { ...valid, records: [{ ...record, createdAt: START + 1 }] },
      { ...valid, records: [{ ...record, code: 12345678 }] },
      { ...valid, records: [record, record] },
      { ...valid, records: Array.from({ length: 9 }, (_, index) => ({ ...record, id: index.toString(16).padStart(32, "0") })) },
    );
    writeFileSync(l.pairingFile + ".prev", JSON.stringify(valid));
    for (const value of malformed) {
      writeFileSync(l.pairingFile, JSON.stringify(value));
      const restarted = l.host();
      expect((await exchange(restarted, p)).status).toBe(503);
      expect((await restarted.handle(req(restarted, "/ui/pairing", {}))).status).toBe(503);
      expect(() => restarted.pendingPairings()).toThrow(PairingUnavailableError);
      expect(() => restarted.approvePairing(p.id, p.code)).toThrow(PairingUnavailableError);
      expect(readFileSync(l.pairingFile, "utf8")).toBe(JSON.stringify(value));
      const response = await restarted.handle(req(restarted, "/ui/pairing", {}));
      const text = await response.text();
      expect(text).not.toContain(l.root);
      expect(text).not.toContain(p.secret);
      restarted.stop();
    }
    writeFileSync(l.pairingFile, "{".repeat(17000));
    expect((await exchange(l.host(), p)).status).toBe(503);
  });

  test("corruption/removal after startup stays failed for owner even if file later fixed", async () => {
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    const valid = readFileSync(l.pairingFile, "utf8");
    unlinkSync(l.pairingFile);
    expect((await exchange(h, p)).status).toBe(503);
    writeFileSync(l.pairingFile, valid);
    expect((await exchange(h, p)).status).toBe(503);
    expect(h.issueTicket()).toContain("/#ticket="); // other login path does not trust or restore the failed store
  });

  test("symlink/directory stores refused, failed durable consume never issues cookie", async () => {
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    h.approvePairing(p.id, p.code);
    const original = readFileSync(l.pairingFile, "utf8");
    const privateTarget = join(l.root, "other.json");
    writeFileSync(privateTarget, original);
    unlinkSync(l.pairingFile);
    symlinkSync(privateTarget, l.pairingFile);
    const response = await exchange(h, p);
    expect(response.status).toBe(503);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(readFileSync(privateTarget, "utf8")).toBe(original);
    expect((await exchange(l.host(), p)).status).toBe(503);
    unlinkSync(l.pairingFile);
    mkdirSync(l.pairingFile);
    expect((await exchange(l.host(), p)).status).toBe(503);
    expect(() => new ConsolePairingJournal("relative.json")).toThrow(PairingUnavailableError);
  });

  test("failed atomic write leaves no session, never returns success on journal save failure", async () => {
    const l = lab();
    const h = l.host();
    const p = await pair(h);
    h.approvePairing(p.id, p.code);
    // Move the actual state directory and replace it with a symlink. Reads can
    // see the approved record, but saving its tombstone must fail closed.
    renameSync(join(l.root, "state"), join(l.root, "moved"));
    symlinkSync(join(l.root, "moved"), join(l.root, "state"));
    const response = await exchange(h, p);
    expect(response.status).toBe(503);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(disk(join(l.root, "moved", "console-pairing.json")).records[0].state).toBe("approved");
    expect((await h.handle(req(h, "/ui/api/state"))).status).toBe(401);
  });

  test("real listener uses same approval/redeem routes and consumed preauth persists across listener restart", async () => {
    const l = lab();
    let h = startConsoleServer(l.options);
    try {
      const post = (path: string, body: unknown) => fetch(h.origin + path, { method: "POST", headers: { origin: h.origin, [REQUEST_HEADER]: "1", "content-type": "application/json" }, body: JSON.stringify(body) });
      const p = await (await post("/ui/pairing", {})).json();
      expect((await post("/ui/pairing/exchange", { id: p.id, secret: p.secret })).status).toBe(202);
      expect(h.approvePairing(p.id, p.code)).toBe(true);
      h.stop();
      h = startConsoleServer(l.options);
      const response = await post("/ui/pairing/exchange", { id: p.id, secret: p.secret });
      expect(response.status).toBe(200);
      expect(response.headers.has("set-cookie")).toBe(true);
      h.stop();
      h = startConsoleServer(l.options);
      expect((await post("/ui/pairing/exchange", { id: p.id, secret: p.secret })).status).toBe(401);
    } finally { h.stop(); }
  });
});
