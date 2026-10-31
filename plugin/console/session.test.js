import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeTicketFragment, createSessionClient, pollState, waitForPairing } from "./session.js";
import { ConsoleInputError, createConsoleHandler } from "../src/console-server.ts";

const REQUEST_HEADER = "X-Ohmyaihub-Request";
const CSRF_HEADER = REQUEST_HEADER.replace(/Request$/, "CS" + "RF");

const session = { csrf: "test-csrf-memory-only", instance: "test-instance", expiresAt: "2099-01-01T00:00:00Z" };
const response = (body, status = 200) => Response.json(body, { status });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("console session transport", () => {
  test("removes the complete fragment synchronously, preserving only path and query", () => {
    const calls = [];
    const ticket = consumeTicketFragment({ hash: "#ticket=test-ticket&other=private", pathname: "/", search: "" }, { replaceState: (...args) => calls.push(args) });
    expect(calls).toEqual([[null, "", "/"]]);
    expect(ticket).toBe("test-ticket");
    expect(consumeTicketFragment({ hash: "#unexpected-secret", pathname: "/", search: "" }, { replaceState: (...args) => calls.push(args) })).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("redeems once, refresh resumes via cookie, passive reads never carry csrf or action keys", async () => {
    const calls = [];
    const client = createSessionClient({ fetch: async (path, init) => {
      calls.push({ path, init });
      return response(path === "/ui/session" ? session : { schema: "ohmyaihub/console/1" });
    } });
    const info = await client.open("one-use-ticket");
    expect(info).toEqual({ instance: session.instance, expiresAt: session.expiresAt });
    expect(info.csrf).toBeUndefined();
    await client.open(null);
    await client.state();
    expect(calls.map((call) => [call.path, call.init.method])).toEqual([["/ui/session", "POST"], ["/ui/session", "GET"], ["/ui/api/state", "GET"]]);
    expect(JSON.parse(calls[0].init.body)).toEqual({ ticket: "one-use-ticket" });
    for (const { init } of calls) {
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.headers["X-Ohmyaihub-Request"]).toBe("1");
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.headers[CSRF_HEADER]).toBeUndefined();
      expect(init.headers["Idempotency-Key"]).toBeUndefined();
    }
    client.dispose();
  });

  test("explicit operations have memory csrf and unique UUID, unwrap result, never retry unknown writes", async () => {
    const calls = [];
    const client = createSessionClient({ fetch: async (path, init) => {
      calls.push({ path, init });
      if (path === "/ui/session") return response(session);
      if (path.endsWith("configure")) throw new TypeError("socket closed with sensitive raw details");
      return response({ result: { checked: true } });
    } });
    await client.open(null);
    expect(await client.action("checks", {})).toEqual({ checked: true });
    await expect(client.action("configure", { sharingEnabled: true })).rejects.toMatchObject({ status: 0 });
    expect(calls).toHaveLength(3);
    for (const { init } of calls.slice(1)) {
      expect(init.headers[CSRF_HEADER]).toBe(session.csrf);
      expect(init.headers["Idempotency-Key"]).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(calls[1].init.headers["Idempotency-Key"]).not.toBe(calls[2].init.headers["Idempotency-Key"]);
    client.dispose();
  });

  test("configure allows a first download for 180 seconds while session, state and checks stay bounded", async () => {
    const timeouts = [];
    const client = createSessionClient({
      schedule: (run, ms) => { timeouts.push(ms); return timeouts.length; }, cancel: () => {},
      fetch: async (path) => response(path === "/ui/session" ? session : { result: true }),
    });
    await client.open(null);
    await client.state();
    await client.action("configure", {});
    await client.action("checks", {});
    expect(timeouts).toEqual([30_000, 30_000, 180_000, 30_000]);
    client.dispose();
  });

  test("a slow read serializes a user action rather than overlapping requests", async () => {
    const pending = deferred();
    const calls = [];
    const client = createSessionClient({ fetch: async (path) => {
      calls.push(path);
      if (path === "/ui/session") return response(session);
      if (path === "/ui/api/state") return pending.promise;
      return response({ result: true });
    } });
    await client.open(null);
    const read = client.state();
    await Promise.resolve();
    const write = client.action("checks", {});
    expect(calls).toHaveLength(2);
    pending.resolve(response({ ready: true }));
    await read;
    expect(await write).toBeTrue();
    expect(calls).toHaveLength(3);
    client.dispose();
  });

  test("401 clears session, reports reopen, and is never blindly redeemed again", async () => {
    let expired = 0;
    let calls = 0;
    const client = createSessionClient({ fetch: async () => { calls++; return response({ error: "private raw error" }, 401); }, onExpired: () => expired++ });
    await expect(client.open(null)).rejects.toMatchObject({ status: 401 });
    expect(expired).toBe(1);
    await expect(client.action("checks", {})).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
    client.dispose();
  });

  test("cancellation aborts a read and dispose blocks queued work", async () => {
    const started = deferred();
    let calls = 0;
    const client = createSessionClient({ fetch: async (path, init) => {
      calls++;
      if (path === "/ui/session") return response(session);
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        started.resolve();
      });
    } });
    await client.open(null);
    const controller = new AbortController();
    const reading = client.state(controller.signal);
    await started.promise;
    const writing = client.action("checks", {});
    const results = Promise.allSettled([reading, writing]);
    client.dispose();
    const settled = await results;
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(settled.map((result) => result.reason.name)).toEqual(["AbortError", "AbortError"]);
    expect(calls).toBe(2);
  });
});

describe("client to real HTTP handler", () => {
  test("ticket cookie resume, real csrf checks, configure, safe validation and logout agree", async () => {
    let cookie = "";
    let configured = false;
    const actions = [];
    const state = () => ({ schema: "ohmyaihub/console/1", at: new Date().toISOString(), configured, status: { config: {} } });
    const server = createConsoleHandler({
      state: async () => state(),
      allowedActions: ["configure", "checks"],
      action: async (name, input) => {
        if (name === "checks" && input.invalid) throw new ConsoleInputError("请填写有效的网络名称");
        actions.push({ name, input });
        if (name === "configure") configured = true;
        return state();
      },
    }, 34761);
    const fetch = async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("Host", `127.0.0.1:${server.port}`);
      headers.set("Sec-Fetch-Site", "same-origin");
      headers.set("Sec-Fetch-Mode", "cors");
      headers.set("Sec-Fetch-Dest", "empty");
      if (cookie) headers.set("Cookie", cookie);
      if (init.method === "POST") headers.set("Origin", server.origin);
      const result = await server.handle(new Request(server.origin + path, { ...init, headers }));
      const setCookie = result.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.includes("Max-Age=0") ? "" : setCookie.split(";")[0];
      return result;
    };
    let expired = 0;
    const first = createSessionClient({ fetch, onExpired: () => expired++ });
    const second = createSessionClient({ fetch });
    try {
      const ticket = new URL(server.issueTicket()).hash.slice("#ticket=".length);
      await first.open(ticket);
      expect(cookie).not.toBe("");
      expect((await first.state()).configured).toBeFalse();
      const saved = await first.action("configure", { consumingEnabled: true });
      expect(saved.configured).toBeTrue();
      expect(actions).toEqual([{ name: "configure", input: { consumingEnabled: true } }]);
      await expect(first.action("checks", { invalid: true })).rejects.toMatchObject({ status: 400, message: "请填写有效的网络名称" });
      // A new JS client has no CSRF memory: refresh must recover via HttpOnly cookie.
      await second.open(null);
      expect((await second.action("checks", {})).configured).toBeTrue();
      await second.logout();
      expect(cookie).toBe("");
      await expect(first.state()).rejects.toMatchObject({ status: 401 });
      expect(expired).toBe(1);
    } finally {
      first.dispose();
      second.dispose();
      server.stop();
    }
  });
});

describe("explicit browser pairing", () => {
  const proposal = { id: "a".repeat(32), secret: "b".repeat(64), code: "01234567", expiresAt: "2099-01-01T00:00:00Z" };

  test("secret never leaves the closure; pending has no session, duplicate requests are refused, success adopts CSRF", async () => {
    const calls = [];
    let approved = false;
    const client = createSessionClient({ fetch: async (path, init) => {
      calls.push({ path, init });
      if (path === "/ui/pairing") return response(proposal);
      if (path.endsWith("exchange")) return response(approved ? session : { pending: true }, approved ? 200 : 202);
      return response({ result: true });
    } });
    const visible = await client.requestPairing();
    expect(visible).toEqual({ id: proposal.id, code: proposal.code, expiresAt: proposal.expiresAt });
    expect(JSON.stringify(visible)).not.toContain(proposal.secret);
    await expect(client.requestPairing()).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
    expect(await client.pollPairing()).toEqual({ pending: true });
    await expect(client.action("checks", {})).rejects.toMatchObject({ status: 401 });
    approved = true;
    expect(await client.pollPairing()).toEqual({ pending: false, instance: session.instance, expiresAt: session.expiresAt });
    expect(await client.action("checks", {})).toBeTrue();
    for (const call of calls.filter((call) => call.path.includes("pairing"))) {
      expect(call.init.headers[REQUEST_HEADER]).toBe("1");
      expect(call.init.headers[CSRF_HEADER]).toBeUndefined();
      expect(call.init.headers["Idempotency-Key"]).toBeUndefined();
    }
    expect(JSON.parse(calls[1].init.body)).toEqual({ id: proposal.id, secret: proposal.secret });
    expect(calls.at(-1).init.headers[CSRF_HEADER]).toBe(session.csrf);
    client.dispose();
  });

  test("401 expires a pairing without disposing the client, explicit restart works and cancel erases credentials", async () => {
    let expired = 0;
    let creates = 0;
    const client = createSessionClient({ onExpired: () => expired++, fetch: async (path) => {
      if (path === "/ui/pairing") { creates++; return response(proposal); }
      return response({}, 401);
    } });
    await client.requestPairing();
    await expect(client.pollPairing()).rejects.toMatchObject({ status: 401 });
    expect(expired).toBe(0);
    await expect(client.pollPairing()).rejects.toMatchObject({ status: 401 });
    expect(creates).toBe(1);
    client.reset();
    expect((await client.requestPairing()).code).toBe(proposal.code);
    client.cancelPairing();
    await expect(client.pollPairing()).rejects.toMatchObject({ status: 401 });
    expect(creates).toBe(2);
    client.dispose();
  });

  test("local expiry prevents network exchange and pending exchange cannot authenticate after cancellation", async () => {
    let now = 0;
    let calls = 0;
    const pending = deferred();
    const client = createSessionClient({ now: () => now, fetch: async (path) => {
      calls++;
      if (path === "/ui/pairing") return response({ ...proposal, expiresAt: new Date(1_000).toISOString() });
      return pending.promise;
    } });
    await client.requestPairing();
    const exchanging = client.pollPairing();
    await Promise.resolve();
    client.cancelPairing();
    pending.resolve(response(session));
    await expect(exchanging).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.action("checks", {})).rejects.toMatchObject({ status: 401 });
    await client.requestPairing();
    now = 1_001;
    const before = calls;
    await expect(client.pollPairing()).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(before);
    client.dispose();
  });

  test("approval restart retries exchange with backoff, resets after pending, never creates another request", async () => {
    let now = 0;
    const delays = [];
    const observed = [];
    const outcomes = [{ status: 0 }, { status: 503 }, { pending: true }, { pending: false, instance: "new-host" }];
    const client = { pollPairing: async () => { const next = outcomes.shift(); if (next.status !== undefined) throw next; return next; }, cancelPairing: () => {} };
    const result = await waitForPairing(client, { now: () => now, expiresAt: new Date(120_000).toISOString(), onWaiting: (stale) => observed.push(stale), delay: async (ms) => { delays.push(ms); now += ms; } });
    expect(result.instance).toBe("new-host");
    expect(delays).toEqual([2_000, 4_000, 1_000]);
    expect(observed).toEqual([true, true, false]);
    expect(outcomes).toHaveLength(0);
  });

  test("waiting ends at its deadline or cancellation, without silently minting new requests", async () => {
    let now = 0;
    let cancelled = 0;
    let calls = 0;
    const client = { pollPairing: async () => { calls++; return { pending: true }; }, cancelPairing: () => cancelled++ };
    await expect(waitForPairing(client, { now: () => now, expiresAt: new Date(2_500).toISOString(), delay: async (ms) => { now += ms; } })).rejects.toMatchObject({ status: 401 });
    expect(now).toBe(2_500);
    expect(calls).toBe(3);
    expect(cancelled).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(waitForPairing(client, { signal: controller.signal, expiresAt: "2099-01-01T00:00:00Z" })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(3);
  });

  // Durable pairing journal requires POSIX directory fsync; on win32 the
  // handler refuses with 503 (known gap, reported by scripts/platform-report.ts).
  test.skipIf(process.platform === "win32")("real handler only creates a new instance session after explicit approval survives host restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-client-pairing-"));
    const options = { pairingFile: join(dir, "pending.json"), state: async () => ({ configured: true }), action: async () => true, allowedActions: ["checks"] };
    let server = createConsoleHandler(options, 34762);
    let cookie = "";
    const fetch = async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("Host", "127.0.0.1:34762");
      headers.set("Origin", server.origin);
      headers.set("Sec-Fetch-Site", "same-origin");
      headers.set("Sec-Fetch-Mode", "cors");
      headers.set("Sec-Fetch-Dest", "empty");
      if (cookie) headers.set("Cookie", cookie);
      const result = await server.handle(new Request(server.origin + path, { ...init, headers }));
      const changed = result.headers.get("set-cookie");
      if (changed) cookie = changed.includes("Max-Age=0") ? "" : changed.split(";")[0];
      return result;
    };
    const client = createSessionClient({ fetch });
    try {
      const old = await client.open(new URL(server.issueTicket()).hash.slice("#ticket=".length));
      const oldCookie = cookie;
      await client.logout();
      client.reset();
      const pending = await client.requestPairing();
      expect(await client.pollPairing()).toEqual({ pending: true });
      expect(cookie).toBe("");
      expect(server.approvePairing(pending.id, pending.code)).toBeTrue();
      server.stop();
      server = createConsoleHandler(options, 34762);
      const paired = await client.pollPairing();
      expect(paired.pending).toBeFalse();
      expect(paired.instance).not.toBe(old.instance);
      expect(await client.action("checks", {})).toBeTrue();
      expect(await client.state()).toEqual({ configured: true });
      const oldRead = await server.handle(new Request(server.origin + "/ui/api/state", { headers: { Host: "127.0.0.1:34762", Cookie: oldCookie, [REQUEST_HEADER]: "1" } }));
      expect(oldRead.status).toBe(401);
      await client.logout();
      client.reset();
      const again = await client.requestPairing();
      expect(again.id).not.toBe(pending.id);
      expect(server.pendingPairings().map((item) => item.id)).not.toContain(pending.id);
    } finally {
      client.dispose();
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("passive state polling", () => {
  test("retries exponentially, caps delay, resets after success, and stops on 401", async () => {
    const timers = [];
    const states = [];
    const errors = [];
    const outcomes = [{ status: 0 }, { status: 0 }, { status: 0 }, { state: "ok" }, { status: 401 }];
    const client = { state: async () => { const value = outcomes.shift(); if (value.status !== undefined) throw value; return value; } };
    const poller = pollState(client, { onState: (v) => states.push(v), onError: (e) => errors.push(e), intervalMs: 100, maxDelayMs: 500, schedule: (run, ms) => { timers.push({ run, ms }); return timers.length; }, cancel: () => {} });
    await poller.start();
    expect(timers.at(-1).ms).toBe(200);
    await timers.at(-1).run();
    expect(timers.at(-1).ms).toBe(400);
    await timers.at(-1).run();
    expect(timers.at(-1).ms).toBe(500);
    await timers.at(-1).run();
    expect(timers.at(-1).ms).toBe(100);
    await timers.at(-1).run();
    expect(timers).toHaveLength(4);
    expect(states).toEqual([{ state: "ok" }]);
    expect(errors).toHaveLength(4);
    await poller.refresh();
    expect(outcomes).toHaveLength(0);
  });

  test("concurrent refresh coalesces and stopping aborts without a retry", async () => {
    const pending = deferred();
    let signal;
    let calls = 0;
    let scheduled = 0;
    const poller = pollState({ state: (arg) => { calls++; signal = arg; return pending.promise; } }, { onState: () => { throw Error("must not publish after stop"); }, onError: () => { throw Error("must not publish after stop"); }, schedule: () => { scheduled++; } });
    const first = poller.start();
    expect(poller.refresh()).toBe(first);
    expect(calls).toBe(1);
    poller.stop();
    expect(signal.aborted).toBeTrue();
    pending.reject(new DOMException("Aborted", "AbortError"));
    await first;
    expect(scheduled).toBe(0);
  });
});

test("shipped UI uses safe DOM, no persistent credentials, remote resources, or inline handlers", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const transport = readFileSync(new URL("./session.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  expect(app + transport).not.toMatch(/localStorage|sessionStorage|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|document\.cookie/);
  expect(html).not.toMatch(/\son[a-z]+\s*=|<script[^>]*>\s*[^<\s]|(?:src|href)=["']https?:/);
  expect(html).not.toMatch(/\bstyle=/);
  expect(app).toContain('consumeTicketFragment(window.location, window.history)');
});
