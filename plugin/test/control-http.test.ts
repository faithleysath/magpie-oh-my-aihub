import { describe, expect, test } from "bun:test";
import {
  controlHostAllowed,
  createControlHandler,
  startControlServer,
  type ControlHttpOptions,
  type ControlLimits,
  type ControlNode,
} from "../src/control/http.ts";

const PORT = 34519;
const HOST = `127.0.0.1:${PORT}`;
const SESSION = "a".repeat(32);
const START = Date.parse("2026-10-30T12:00:00Z");

function fakeNode(overrides: Partial<ControlNode> = {}) {
  const calls: { kind: string; value: unknown }[] = [];
  const node: ControlNode = {
    async acceptHello(raw) {
      calls.push({ kind: "hello", value: raw });
      return { kind: "server_hello", sessionId: SESSION };
    },
    async handleFrame(sessionId, frame) {
      calls.push({ kind: "frame", value: { sessionId, frame: [...frame] } });
      return { state: "accepted" };
    },
    ...overrides,
  };
  return { node, calls };
}

function handler(node: ControlNode, options: Partial<ControlHttpOptions> = {}, limits: Partial<ControlLimits> = {}) {
  let time = START;
  const h = createControlHandler({
    node,
    allowedHosts: [HOST, `localhost:${PORT}`, `10.66.1.2:${PORT}`, `192.168.1.10:${PORT}`],
    listener: "lan-reachable",
    limits: {
      request: { limit: 1000, windowMs: 1000 },
      health: { limit: 1000, windowMs: 1000 },
      hello: { limit: 1000, windowMs: 1000 },
      frame: { limit: 1000, windowMs: 1000 },
      ...limits,
    },
    now: () => time,
    ...options,
  });
  return { h, advance: (ms: number) => { time += ms; }, now: () => time };
}

function request(
  path: string,
  options: { method?: string; body?: BodyInit | null; headers?: Record<string, string | null> } = {},
): Request {
  const headers = new Headers({ host: HOST });
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  if (options.body !== undefined && options.body !== null) headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request(`http://${HOST}${path}`, {
    method,
    headers,
    ...(options.body !== undefined && options.body !== null ? { body: options.body, duplex: "half" } : {}),
  } as RequestInit);
}

describe("control HTTP surface", () => {
  test("health is the only unauthenticated read and carries no identity or secret", async () => {
    const { node } = fakeNode();
    const { h } = handler(node);
    const res = await h.handle(request("/p2p/v1/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ ok: true, protocol: "ohmyaihub/p2p/v1" });
    expect(JSON.stringify(body)).not.toMatch(/fingerprint|nodeId|key|secret|mapped|listener|port/i);
  });

  test("exact Host allow-list: wrong port, DNS name, comma, userinfo and missing Host are refused", async () => {
    const { node } = fakeNode();
    const { h } = handler(node);
    for (const host of [`127.0.0.1:${PORT + 1}`, "evil.example:34519", `${HOST},evil.example`, "user@127.0.0.1:34519", null]) {
      const res = await h.handle(request("/p2p/v1/health", { headers: { host } }));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('{"code":"forbidden"}');
    }
    expect((await h.handle(request("/p2p/v1/health", { headers: { host: HOST.toUpperCase() } }))).status).toBe(200);
    expect((await h.handle(request("/p2p/v1/health", { headers: { host: "10.66.1.2:34519" } }))).status).toBe(200);
    expect(controlHostAllowed("127.0.0.1:34519", [HOST])).toBe(true);
    expect(controlHostAllowed("127.0.0.1:34519.", [HOST])).toBe(false);
  });

  test("browser traffic is refused and no CORS header is ever emitted", async () => {
    const { node } = fakeNode();
    const { h } = handler(node);
    const browserHeaders: Record<string, string>[] = [{ origin: "http://127.0.0.1:34519" }, { origin: "null" }, { "sec-fetch-site": "same-origin" }];
    for (const headers of browserHeaders) {
      const res = await h.handle(request("/p2p/v1/health", { headers }));
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-methods")).toBeNull();
    }
    const options = await h.handle(request("/p2p/v1/health", { method: "OPTIONS" }));
    expect(options.status).toBe(405);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    expect(options.headers.get("allow")).toBe("GET");
  });

  test("only three exact routes and strict methods", async () => {
    const { node } = fakeNode();
    const { h } = handler(node);
    for (const path of ["/", "/p2p", "/p2p/v1", "/p2p/v1/health/", "/p2p/v1/hello/", "/p2p/v1/frame/", "/p2p/v1/status", "/P2P/v1/health"]) {
      const res = await h.handle(request(path));
      expect(res.status).toBe(404);
    }
    expect((await h.handle(request("/p2p/v1/%68ealth"))).status).toBe(400);
    expect((await h.handle(request("/p2p/v1/health", { method: "POST", body: "{}" }))).status).toBe(405);
    expect((await h.handle(request("/p2p/v1/hello"))).status).toBe(405);
    expect((await h.handle(request("/p2p/v1/frame"))).status).toBe(405);
    const post = await h.handle(request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json" } }));
    expect(post.headers.get("allow")).toBeNull();
  });

  test("queries are exact: health/hello reject any, frame needs one valid session", async () => {
    const { node, calls } = fakeNode();
    const { h } = handler(node);
    expect((await h.handle(request("/p2p/v1/health?x=1"))).status).toBe(400);
    expect((await h.handle(request("/p2p/v1/hello?session=" + SESSION, { body: "{}", headers: { "content-type": "application/json" } }))).status).toBe(400);
    for (const query of ["", "?session=", "?session=xyz", `?session=${SESSION}x`, `?session=${SESSION}&session=${SESSION}`, `?session=${SESSION}&x=1`, `?other=${SESSION}`]) {
      const res = await h.handle(request(`/p2p/v1/frame${query}`, { body: new Uint8Array([1]), headers: { "content-type": "application/octet-stream" } }));
      expect(res.status).toBe(400);
    }
    expect(calls.length).toBe(0);
  });

  test("hello accepts bounded canonical JSON and passes the parsed object only", async () => {
    const { node, calls } = fakeNode();
    const { h } = handler(node);
    const res = await h.handle(request("/p2p/v1/hello", { body: '{"kind":"hello","x":1}', headers: { "content-type": "application/json; charset=utf-8" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "server_hello", sessionId: SESSION });
    expect(calls).toEqual([{ kind: "hello", value: { kind: "hello", x: 1 } }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("hello refuses wrong media type, encodings, empty, malformed, array and oversized bodies", async () => {
    const { node, calls } = fakeNode();
    const { h } = handler(node, {}, { maxHelloBytes: 64 });
    const cases: [Request, number][] = [
      [request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "text/plain" } }), 415],
      [request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json", "content-encoding": "gzip" } }), 415],
      [request("/p2p/v1/hello", { body: "", headers: { "content-type": "application/json" } }), 400],
      [request("/p2p/v1/hello", { body: "{", headers: { "content-type": "application/json" } }), 400],
      [request("/p2p/v1/hello", { body: "[]", headers: { "content-type": "application/json" } }), 400],
      [request("/p2p/v1/hello", { body: "null", headers: { "content-type": "application/json" } }), 400],
      [request("/p2p/v1/hello", { body: JSON.stringify({ x: "a".repeat(100) }), headers: { "content-type": "application/json", "content-length": "120" } }), 413],
      [request("/p2p/v1/hello", { body: JSON.stringify({ x: "a".repeat(100) }), headers: { "content-type": "application/json" } }), 413],
      [request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json", "content-length": "x" } }), 400],
    ];
    for (const [req, status] of cases) expect((await h.handle(req)).status).toBe(status);
    expect(calls.length).toBe(0);
  });

  test("frame is binary, exact-length bounded and returns 204 without metadata", async () => {
    const { node, calls } = fakeNode();
    const { h } = handler(node, {}, { maxFrameBytes: 8 });
    const ok = await h.handle(request(`/p2p/v1/frame?session=${SESSION}`, { body: new Uint8Array([1, 2, 3]), headers: { "content-type": "application/octet-stream" } }));
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    expect(calls[0]).toEqual({ kind: "frame", value: { sessionId: SESSION, frame: [1, 2, 3] } });
    expect((await h.handle(request(`/p2p/v1/frame?session=${SESSION}`, { body: "{}", headers: { "content-type": "application/json" } }))).status).toBe(415);
    expect((await h.handle(request(`/p2p/v1/frame?session=${SESSION}`, { body: new Uint8Array(9), headers: { "content-type": "application/octet-stream" } }))).status).toBe(413);
    expect((await h.handle(request(`/p2p/v1/frame?session=${SESSION}`, { body: new Uint8Array(0), headers: { "content-type": "application/octet-stream" } }))).status).toBe(400);
  });

  test("node errors are reduced to allow-listed codes and status, never a message or secret", async () => {
    const { h } = handler(fakeNode({ async acceptHello() { throw Object.assign(new Error("sk-live-secret /Users/me"), { code: "bad_signature" }); } }).node);
    const res = await h.handle(request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"code":"bad_signature"}');

    for (const [code, status] of [
      ["untrusted_peer", 403],
      ["policy", 403],
      ["no_shared_models", 409],
      ["expired", 410],
      ["session_closed", 410],
      ["replay", 409],
      ["stale_identity", 409],
      ["conflict", 409],
      ["not_found", 404],
      ["internal", 500],
    ] as const) {
      const { h: one } = handler(fakeNode({ async acceptHello() { throw { code }; } }).node);
      const r = await one.handle(request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json" } }));
      expect(r.status).toBe(status);
      expect(await r.text()).toBe(`{"code":"${code}"}`);
    }

    const { h: unknown } = handler(fakeNode({ async acceptHello() { throw Object.assign(new Error("boom secret"), { code: "made_up" }); } }).node);
    const r = await unknown.handle(request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json" } }));
    expect(r.status).toBe(500);
    expect(await r.text()).toBe('{"code":"internal"}');

    const { h: plain } = handler(fakeNode({ async acceptHello() { throw new Error("plain failure with sk-live-secret"); } }).node);
    const p = await plain.handle(request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json" } }));
    expect(p.status).toBe(500);
    expect(await p.text()).toBe('{"code":"internal"}');
  });

  test("rate limit is enforced before the node call, per peer and globally", async () => {
    const { node, calls } = fakeNode();
    const limiter = handler(node, {}, { hello: { limit: 2, windowMs: 60_000 }, request: { limit: 100, windowMs: 1000 } });
    const body = { body: "{}", headers: { "content-type": "application/json" } };
    expect((await limiter.h.handle(request("/p2p/v1/hello", body), "10.0.0.1")).status).toBe(200);
    expect((await limiter.h.handle(request("/p2p/v1/hello", body), "10.0.0.1")).status).toBe(200);
    const denied = await limiter.h.handle(request("/p2p/v1/hello", body), "10.0.0.1");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await limiter.h.handle(request("/p2p/v1/hello", body), "10.0.0.2")).status).toBe(200);
    expect(calls.length).toBe(3);

    const global = handler(node, {}, { request: { limit: 1, windowMs: 60_000 } });
    expect((await global.h.handle(request("/p2p/v1/health"), "10.0.0.1")).status).toBe(200);
    expect((await global.h.handle(request("/p2p/v1/health"), "10.0.0.2")).status).toBe(429);
  });

  test("concurrency is bounded globally and per peer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { h } = handler(fakeNode({ async acceptHello() { await gate; return { kind: "server_hello" }; } }).node, {}, {
      maxConcurrent: 1,
      maxConcurrentPerPeer: 1,
    });
    const body = { body: "{}", headers: { "content-type": "application/json" } };
    const first = h.handle(request("/p2p/v1/hello", body), "10.0.0.1");
    await Bun.sleep(0);
    const overflow = await h.handle(request("/p2p/v1/hello", body), "10.0.0.1");
    expect(overflow.status).toBe(503);
    expect(overflow.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
  });

  test("a slow node is bounded by the transport timeout", async () => {
    let rejected: (e: Error) => void = () => {};
    const { h } = handler(fakeNode({ async acceptHello() { await new Promise((_, reject) => { rejected = reject; }); return {}; } }).node, {}, {
      helloTimeoutMs: 20,
    });
    const started = Date.now();
    const res = await h.handle(request("/p2p/v1/hello", { body: "{}", headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(408);
    expect(await res.text()).toBe('{"code":"timeout"}');
    expect(Date.now() - started).toBeLessThan(1000);
    rejected(new Error("late failure"));
    await Bun.sleep(1);
  });

  test("startControlServer refuses a wildcard bind and a false loopback claim", () => {
    const { node } = fakeNode();
    expect(() => startControlServer({ node, host: "0.0.0.0", port: 0, allowedHosts: [HOST], listener: "lan-reachable" })).toThrow(/wildcard/);
    expect(() => startControlServer({ node, host: "192.168.1.10", port: 0, allowedHosts: [HOST], listener: "loopback-only" })).toThrow(/loopback-only/);
    expect(() => startControlServer({ node, host: "127.0.0.1", port: 0, allowedHosts: [], listener: "loopback-only" })).toThrow(/allowed Host/);
  });
});

// --- real Bun.serve behaviour under slow/never-settling work -----------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function realControlServer(
  node: ControlNode,
  limits: Partial<ControlLimits> = {},
) {
  let handler!: ReturnType<typeof createControlHandler>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, srv) => handler.handle(req, srv.requestIP(req)?.address ?? "test-peer"),
  });
  const port = server.port;
  if (!port) throw new Error("the real test server did not bind a port");
  const host = `127.0.0.1:${port}`;
  handler = createControlHandler({
    node,
    allowedHosts: [host],
    listener: "loopback-only",
    limits: {
      request: { limit: 1000, windowMs: 1000 },
      health: { limit: 1000, windowMs: 1000 },
      hello: { limit: 1000, windowMs: 1000 },
      frame: { limit: 1000, windowMs: 1000 },
      ...limits,
    },
    now: () => Date.now(),
  });
  return { server, host, port };
}

function realFrame(host: string): Promise<Response> {
  return fetch(`http://${host}/p2p/v1/frame?session=${SESSION}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array([1, 2, 3]),
  });
}

async function waitForHealth(host: string, status: number, timeoutMs = 1000): Promise<number> {
  const until = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < until) {
    try {
      last = (await fetch(`http://${host}/p2p/v1/health`)).status;
      if (last === status) return last;
    } catch {
      /* the listener may still be stopping */
    }
    await Bun.sleep(5);
  }
  return last;
}

describe("real Bun.serve timeout and execution-slot ownership", () => {
  test("a timeout keeps the slot until the business promise settles; late success does not re-enter or duplicate", async () => {
    const gate = deferred<void>();
    let calls = 0;
    const { server, host } = realControlServer(
      {
        async acceptHello() { return {}; },
        async handleFrame() {
          calls += 1;
          await gate.promise;
          return { state: "approved" };
        },
      },
      { maxConcurrent: 1, maxConcurrentPerPeer: 1, frameTimeoutMs: 25, bodyTimeoutMs: 500 },
    );
    const first = await realFrame(host);
    expect(first.status).toBe(408);
    expect(await first.text()).toBe('{"code":"timeout"}');
    // The transport response timed out, but the business promise still owns its
    // slot. A new request must not start unbounded parallel work.
    expect((await fetch(`http://${host}/p2p/v1/health`)).status).toBe(503);
    expect(calls).toBe(1);
    gate.resolve();
    expect(await waitForHealth(host, 200)).toBe(200);
    expect(calls).toBe(1); // late success did not run the frame again
    server.stop(true);
  });

  test("a never-settling business promise is bounded: later requests get 503 until it settles", async () => {
    const gate = deferred<void>();
    const { server, host } = realControlServer(
      {
        async acceptHello() { return {}; },
        async handleFrame() { await gate.promise; return {}; },
      },
      { maxConcurrent: 1, maxConcurrentPerPeer: 1, frameTimeoutMs: 20, bodyTimeoutMs: 500 },
    );
    expect((await realFrame(host)).status).toBe(408);
    for (let i = 0; i < 3; i += 1) expect((await realFrame(host)).status).toBe(503);
    gate.resolve();
    expect(await waitForHealth(host, 200)).toBe(200);
    server.stop(true);
  });

  test("a late rejection releases the slot and never becomes an unhandled rejection", async () => {
    const gate = deferred<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const { server, host } = realControlServer(
      {
        async acceptHello() { return {}; },
        async handleFrame() { await gate.promise; return {}; },
      },
      { maxConcurrent: 1, maxConcurrentPerPeer: 1, frameTimeoutMs: 20, bodyTimeoutMs: 500 },
    );
    try {
      expect((await realFrame(host)).status).toBe(408);
      gate.reject(new Error("late business failure"));
      expect(await waitForHealth(host, 200)).toBe(200);
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      gate.resolve();
      server.stop(true);
    }
  });

  test("stopping the real listener with in-flight work does not produce an unhandled late rejection", async () => {
    const gate = deferred<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const { server, host } = realControlServer(
      {
        async acceptHello() { return {}; },
        async handleFrame() { await gate.promise; return {}; },
      },
      { maxConcurrent: 1, maxConcurrentPerPeer: 1, frameTimeoutMs: 20, bodyTimeoutMs: 500 },
    );
    try {
      expect((await realFrame(host)).status).toBe(408);
      server.stop(true);
      gate.reject(new Error("rejected after stop"));
      await Bun.sleep(30);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      server.stop(true);
    }
  });

  test("a stalled real request body is cancelled at its own deadline and releases the slot", async () => {
    let accepted = 0;
    const { server, host, port } = realControlServer(
      {
        async acceptHello() { accepted += 1; return {}; },
        async handleFrame() { return {}; },
      },
      { maxConcurrent: 1, maxConcurrentPerPeer: 1, bodyTimeoutMs: 50, helloTimeoutMs: 500 },
    );
    let received = "";
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_socket, chunk) {
          received += new TextDecoder().decode(chunk);
        },
        open(socket) {
          socket.write(
            `POST /p2p/v1/hello HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{`,
          );
        },
      },
    });
    const until = Date.now() + 1000;
    while (!received.includes(" 408 ") && Date.now() < until) await Bun.sleep(5);
    expect(received).toContain(" 408 ");
    expect(received).toContain('{"code":"timeout"}');
    expect(accepted).toBe(0); // the body never completed, so no hello work ran
    socket.end();
    expect(await waitForHealth(host, 200)).toBe(200);
    server.stop(true);
  });
});

  test("the timeout aborts the node signal; a node that honours it releases the slot", async () => {
    let signal: AbortSignal | undefined;
    const { server, host } = realControlServer(
      {
        async acceptHello() { return {}; },
        handleFrame(_sessionId, _frame, abort) {
          signal = abort;
          return new Promise((_resolve, reject) => {
            abort?.addEventListener("abort", () => reject(new Error("aborted by transport")), { once: true });
          });
        },
      },
      { maxConcurrent: 1, maxConcurrentPerPeer: 1, frameTimeoutMs: 20, bodyTimeoutMs: 500 },
    );
    expect((await realFrame(host)).status).toBe(408);
    expect(signal?.aborted).toBe(true);
    expect(await waitForHealth(host, 200)).toBe(200);
    server.stop(true);
  });

describe("body cancellation", () => {
  test("a stalled ReadableStream is really cancelled, not merely abandoned", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        // never close
      },
      cancel() {
        cancelled = true;
      },
    });
    const { h } = handler(
      fakeNode().node,
      { now: () => Date.now() } as Partial<ControlHttpOptions>,
      { bodyTimeoutMs: 20, helloTimeoutMs: 50 },
    );
    const req = new Request(`http://${HOST}/p2p/v1/hello`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await h.handle(req);
    expect(res.status).toBe(408);
    await Bun.sleep(5);
    expect(cancelled).toBe(true);
  });
});
