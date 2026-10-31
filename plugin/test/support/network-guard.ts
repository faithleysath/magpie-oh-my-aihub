// Hermetic network guard, preloaded for every `bun test` run (see bunfig.toml).
//
// A test may reach only the servers the test itself started (registered by the
// Bun.serve wrapper below) or a server a test explicitly registers with
// `registerTestServer()`. Everything else is refused *and recorded*: a fetch
// that a code path would swallow in a try/catch still fails the test in
// afterEach, so an accidental call to the developer's real Magpie gateway
// (127.0.0.1:3425 or the LAN address), to a public RPC endpoint, or to any other
// machine cannot hide behind a green suite.
//
// The guard is exact-origin: `http://127.0.0.1:<port>` is allowed only while a
// server started in this process is listening there. "All loopback" is
// deliberately not allowed, so a leaked fixed port (3425, 34567, …) is caught.
//
// Scope and known limits — do not read this as a complete network sandbox:
// - covered: `globalThis.fetch` and `Bun.serve` in THIS test process;
// - not covered: `Bun.fetch`/another runtime's fetch binding, `node:http`,
//   `node:net`/raw sockets, WebSockets and any child process the test spawns.
//   Children are confined by their own preload (`child-network-spy.ts`) with an
//   exact allowlist, not by this guard;
// - attribution: `beforeEach` clears the record, so a request issued inside
//   `beforeAll`/`afterAll` (or after a test) is not attributed to a test and can
//   be dropped; only attempts inside a test are guaranteed to fail it;
// - `registerTestServer()` persists for the rest of the file unless the caller
//   removes it with `unregisterTestServer()`; a test that registers a broad or
//   long-lived origin widens the allowlist for later tests in that file.

import { afterEach, beforeEach } from "bun:test";

type Attempt = { url: string; origin: string; at: string; stack: string };

/** Origins a test process is currently serving or has explicitly registered. */
const allowed = new Map<string, string>();

let attempts: Attempt[] = [];
let currentTestHadUnexpected = false;
let installed = false;

const realFetch = globalThis.fetch.bind(globalThis);

function rawUrlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return String(input);
}

/** An exact `scheme://host:port` origin for an http(s) URL, else null. */
function originOf(input: unknown): string | null {
  try {
    const url = new URL(rawUrlOf(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isInProcessScheme(input: unknown): boolean {
  try {
    const protocol = new URL(rawUrlOf(input)).protocol;
    return protocol === "blob:" || protocol === "data:";
  } catch {
    return false;
  }
}

function addressesFor(server: { hostname?: string; port?: number }): string[] {
  const hosts = new Set<string>(["127.0.0.1", "localhost", "[::1]"]);
  // A server bound to one specific address is reachable on that address too.
  const bound = String(server.hostname ?? "").trim();
  if (bound && bound !== "0.0.0.0" && bound !== "::" && bound !== "::0") hosts.add(bound);
  return [...hosts].map((host) => `http://${host}:${server.port}`);
}

function install(): void {
  if (installed) return;
  installed = true;

  // A real server started by a test is the only kind of endpoint it may call.
  const serve = Bun.serve.bind(Bun) as typeof Bun.serve;
  (Bun as unknown as { serve: typeof Bun.serve }).serve = ((options: Bun.Serve.Options<unknown, never>) => {
    const server = serve(options);
    const origins = addressesFor(server as unknown as { hostname: string; port: number });
    for (const origin of origins) allowed.set(origin, "test server");
    const stop = server.stop.bind(server);
    server.stop = ((...args: Parameters<typeof server.stop>) => {
      for (const origin of origins) allowed.delete(origin);
      return stop(...args);
    }) as typeof server.stop;
    return server;
  }) as typeof Bun.serve;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    // blob:/data: never reach the network; they are the page's own downloads.
    if (isInProcessScheme(input)) return realFetch(input as RequestInfo, init);
    const origin = originOf(input);
    if (origin && allowed.has(origin)) return realFetch(input as RequestInfo, init);
    let display = String(input).slice(0, 200);
    try {
      const url = new URL(rawUrlOf(input));
      display = url.origin === "null" ? `${url.protocol}${url.pathname.slice(0, 120)}` : `${url.origin}${url.pathname}`;
    } catch {
      /* keep the raw text */
    }
    attempts.push({
      url: display,
      origin: origin ?? "<unparseable>",
      at: new Date().toISOString(),
      stack: (new Error().stack ?? "").split("\n").slice(2, 8).join(" | "),
    });
    currentTestHadUnexpected = true;
    throw new TypeError(`hermetic network guard: ${origin ?? display} is not a registered test server`);
  }) as typeof fetch;

  beforeEach(() => {
    attempts = [];
    currentTestHadUnexpected = false;
  });
  afterEach(() => {
    const seen = attempts.splice(0);
    currentTestHadUnexpected = false;
    if (seen.length === 0) return;
    const lines = seen.map((a) => `  ${a.url} -> ${a.stack}`).join("\n");
    throw new Error(
      `hermetic network guard: ${seen.length} request(s) to a server this test did not start or register\n${lines}`,
    );
  });
}

/**
 * Register an exact server origin for the rest of the current test file. Use it
 * for a server this process did not start through Bun.serve (there are none
 * today; kept for fixtures such as an external process the test owns).
 */
export function registerTestServer(origin: string): void {
  const parsed = new URL(origin);
  allowed.set(parsed.origin, "explicit");
}

/** Remove an origin registered with `registerTestServer()` (test-scoped use). */
export function unregisterTestServer(origin: string): void {
  try {
    allowed.delete(new URL(origin).origin);
  } catch {
    /* an unparseable origin was never registered */
  }
}

/** Whether the guard would let a request to this exact origin through. */
export function isTestServerAllowed(origin: string): boolean {
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * Assert that a request is refused and keep the refusal out of the afterEach
 * failure, so a regression test can prove the guard itself works without
 * pretending the leak happened.
 */
export async function expectBlocked(request: () => Promise<unknown>): Promise<boolean> {
  const before = attempts.length;
  let refused = false;
  try {
    await request();
  } catch {
    refused = true;
  }
  attempts.splice(before);
  return refused;
}

export function guardInstalled(): boolean {
  return installed;
}

install();
