// The B control plane's HTTP envelope.
//
// This module is deliberately only a transport. It knows three exact routes,
// bounded bodies, a host/origin policy and rate/concurrency limits; it does not
// parse protocol bodies, verify signatures, hold session keys or touch Magpie.
// Those belong to `plugin/src/p2p/*` (B-core) and `plugin/src/control/service-port.ts`.
//
// Why the policy is this strict: no-TUN EasyTier means the listener may be
// reachable from the ordinary LAN, not only from the overlay. Being on the LAN
// must never grant authority, so every business action is a signed envelope or
// an authenticated session frame. The transport refuses browser traffic
// (`Origin`/`Sec-Fetch-*`), unknown Host values, unknown routes and any body
// before handing it to the node. Errors are stable codes only: a remote caller
// never learns whether a key, approval or peer exists from this layer.

export type ControlListenerKind = "loopback-only" | "lan-reachable";

/** The narrow part of B-core this transport needs. No Magpie or Service here. */
export interface ControlNode {
  /** Validate + answer a signed client hello. Throws a `{code}` error on refusal. */
  acceptHello(raw: unknown): Promise<unknown>;
  /** Open one sealed session frame and run its one business transition. */
  handleFrame(sessionId: string, frame: Uint8Array): Promise<unknown>;
}

export interface RateRule {
  /** how many requests fit in a full bucket */
  limit: number;
  /** the period those requests refill over */
  windowMs: number;
}

export interface ControlLimits {
  /** every request, including unknown routes, before any body read */
  request: RateRule;
  health: RateRule;
  hello: RateRule;
  frame: RateRule;
  /** simultaneous open route handlers */
  maxConcurrent: number;
  /** simultaneous handlers from one source address */
  maxConcurrentPerPeer: number;
  healthTimeoutMs: number;
  helloTimeoutMs: number;
  frameTimeoutMs: number;
  maxHelloBytes: number;
  maxFrameBytes: number;
}

export const DEFAULT_CONTROL_LIMITS: Readonly<ControlLimits> = Object.freeze({
  request: { limit: 240, windowMs: 10_000 },
  health: { limit: 60, windowMs: 10_000 },
  hello: { limit: 20, windowMs: 60_000 },
  frame: { limit: 240, windowMs: 60_000 },
  maxConcurrent: 8,
  maxConcurrentPerPeer: 2,
  healthTimeoutMs: 2_000,
  helloTimeoutMs: 5_000,
  frameTimeoutMs: 5_000,
  maxHelloBytes: 8 * 1024,
  maxFrameBytes: 32 * 1024,
});

export interface ControlHttpOptions {
  node: ControlNode;
  /** Exact Host header values, including the port. Never a substring match. */
  allowedHosts: readonly string[];
  /** The truth about the socket; the diagnostic must not claim more. */
  listener: ControlListenerKind;
  limits?: Partial<ControlLimits>;
  now?: () => number;
  /** Advertised maximum session lifetime; informational only. */
  maxSessionTtlMs?: number;
}

export interface ControlHttpHandler {
  handle(req: Request, peer?: string): Promise<Response>;
}

type Decision = { ok: true } | { ok: false; retryAfterMs: number };

/** A bounded token bucket. One bucket per (peer, route) plus a global one. */
class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly now: () => number,
    private readonly maxBuckets = 2048,
  ) {}

  take(key: string, rule: RateRule): Decision {
    if (!Number.isFinite(rule.limit) || rule.limit < 1 || !Number.isFinite(rule.windowMs) || rule.windowMs < 1) {
      return { ok: false, retryAfterMs: 1000 };
    }
    const at = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) this.prune(at);
      bucket = { tokens: rule.limit, at };
      this.buckets.set(key, bucket);
    }
    const refill = (rule.limit / rule.windowMs) * Math.max(0, at - bucket.at);
    bucket.tokens = Math.min(rule.limit, bucket.tokens + refill);
    bucket.at = at;
    if (bucket.tokens < 1) {
      const wait = Math.ceil((1 - bucket.tokens) / (rule.limit / rule.windowMs));
      return { ok: false, retryAfterMs: Math.max(1, Math.min(rule.windowMs, wait)) };
    }
    bucket.tokens -= 1;
    return { ok: true };
  }

  private prune(at: number): void {
    // Buckets older than an hour cannot matter to any default rule; dropping
    // them keeps a spoofed-source flood from growing memory without bound.
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.at > 60 * 60_000) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxBuckets) {
      // The map is full of recently active peers. Drop the oldest insertion;
      // that only ever makes the limiter more permissive for one bucket, never
      // less safe for the node.
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}

const NO_STORE = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function response(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function errorResponse(status: number, code: string, headers: Record<string, string> = {}): Response {
  return response(JSON.stringify({ code }), status, headers);
}

/** Browser-originated requests have no business on this plane. */
function browserOrigin(req: Request): boolean {
  if (req.headers.has("origin")) return true;
  if (req.headers.has("sec-fetch-site") || req.headers.has("sec-fetch-mode") || req.headers.has("sec-fetch-dest")) return true;
  return false;
}

function normaliseHost(value: string | null): string | null {
  if (value === null) return null;
  const host = value.trim().toLowerCase();
  if (!host || host.length > 255) return null;
  // A Host header is one authority, not a list, not a URL and not a DNS name
  // with userinfo. These characters have no legitimate use here.
  if (/[\s/\\@,;]/.test(host)) return null;
  if (host.startsWith(".") || host.endsWith(".")) return null;
  return host;
}

export function controlHostAllowed(header: string | null, allowed: readonly string[]): boolean {
  const host = normaliseHost(header);
  if (!host) return false;
  return allowed.some((candidate) => normaliseHost(candidate) === host);
}

interface ParsedTarget {
  rawPath: string;
  url: URL;
}

function targetOf(req: Request): ParsedTarget | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  // Compare the raw path as well: `%2fp2p` must not be treated as `/p2p`.
  const authorityEnd = req.url.indexOf("//");
  const pathStart = authorityEnd >= 0 ? req.url.indexOf("/", authorityEnd + 2) : -1;
  if (pathStart < 0) return null;
  const queryStart = req.url.indexOf("?", pathStart);
  const rawPath = req.url.slice(pathStart, queryStart >= 0 ? queryStart : undefined);
  if (!rawPath.startsWith("/") || rawPath.includes("%") || rawPath.includes("\\")) return null;
  if (rawPath !== url.pathname) return null;
  return { rawPath, url };
}

type Route = "health" | "hello" | "frame";

function routeOf(method: string, path: string): Route | "method" | null {
  const route: Route | null =
    path === "/p2p/v1/health" ? "health" : path === "/p2p/v1/hello" ? "hello" : path === "/p2p/v1/frame" ? "frame" : null;
  if (!route) return null;
  if (route === "health") return method === "GET" ? route : "method";
  return method === "POST" ? route : "method";
}

function contentEncodingIsIdentity(req: Request): boolean {
  const encoding = req.headers.get("content-encoding");
  if (encoding === null) return true;
  return encoding.trim().toLowerCase() === "identity";
}

function declaredLength(req: Request): number | null | "invalid" {
  const raw = req.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d{1,10}$/.test(raw.trim())) return "invalid";
  return Number(raw.trim());
}

async function readBounded(req: Request, limit: number, deadline: number, now: () => number): Promise<Uint8Array | Response> {
  const declared = declaredLength(req);
  if (declared === "invalid") return errorResponse(400, "malformed");
  if (declared !== null && declared > limit) return errorResponse(413, "oversize");
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (now() > deadline) {
        await reader.cancel().catch(() => {});
        return errorResponse(408, "timeout");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return errorResponse(413, "oversize");
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(400, "malformed");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* a cancelled reader cannot be released again */
    }
  }
  return Buffer.concat(chunks);
}

function jsonContentType(req: Request): boolean {
  const value = req.headers.get("content-type");
  return value !== null && /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?[ \t]*$/i.test(value.trim());
}

function frameContentType(req: Request): boolean {
  const value = req.headers.get("content-type");
  return value !== null && /^application\/octet-stream[ \t]*$/i.test(value.trim());
}

const SAFE_CODES = new Set([
  "malformed",
  "unsupported_version",
  "unsupported_type",
  "unsupported_in_b1",
  "oversize",
  "bad_identity",
  "stale_identity",
  "bad_signature",
  "bad_ciphertext",
  "expired",
  "clock_skew",
  "replay",
  "target_mismatch",
  "quote_mismatch",
  "untrusted_peer",
  "not_found",
  "conflict",
  "session_closed",
  "internal",
]);

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    if (SAFE_CODES.has(code)) return code;
  }
  return "internal";
}

function statusForCode(code: string): number {
  switch (code) {
    case "malformed":
    case "unsupported_version":
    case "unsupported_type":
    case "unsupported_in_b1":
    case "oversize":
    case "bad_identity":
    case "bad_signature":
    case "bad_ciphertext":
    case "target_mismatch":
    case "quote_mismatch":
      return 400;
    case "untrusted_peer":
      return 403;
    case "not_found":
      return 404;
    case "expired":
    case "session_closed":
      return 410;
    case "clock_skew":
    case "replay":
    case "stale_identity":
    case "conflict":
      return 409;
    default:
      return 500;
  }
}

function refusal(error: unknown): Response {
  const code = errorCodeOf(error);
  return errorResponse(statusForCode(code), code);
}

/** Runs `work` but answers a timeout; the node keeps its own internal deadline. */
async function boundedWork(work: Promise<Response>, timeoutMs: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => resolve(errorResponse(408, "timeout")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // If the node is still running after a timeout, its eventual rejection is
    // not an unhandled rejection of this handler.
    work.catch(() => {});
  }
}

function responseBody(value: unknown, maxBytes = 16 * 1024): Response {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return errorResponse(500, "internal");
  }
  if (typeof text !== "string" || Buffer.byteLength(text) > maxBytes) return errorResponse(500, "internal");
  return response(text, 200);
}

/**
 * Builds the request handler. Tests call this without opening a socket; the
 * server wrapper supplies the real peer address from `server.requestIP`.
 */
export function createControlHandler(options: ControlHttpOptions): ControlHttpHandler {
  const limits: ControlLimits = { ...DEFAULT_CONTROL_LIMITS, ...(options.limits ?? {}) };
  const now = options.now ?? (() => Date.now());
  const buckets = new TokenBuckets(now);
  const allowedHosts = options.allowedHosts.map((h) => h.trim()).filter(Boolean);
  let active = 0;
  const activePerPeer = new Map<string, number>();

  function enter(peer: string): Response | null {
    if (active >= limits.maxConcurrent) return errorResponse(503, "busy", { "retry-after": "1" });
    const current = activePerPeer.get(peer) ?? 0;
    if (current >= limits.maxConcurrentPerPeer) return errorResponse(503, "busy", { "retry-after": "1" });
    active += 1;
    activePerPeer.set(peer, current + 1);
    return null;
  }

  function leave(peer: string): void {
    active = Math.max(0, active - 1);
    const current = (activePerPeer.get(peer) ?? 1) - 1;
    if (current <= 0) activePerPeer.delete(peer);
    else activePerPeer.set(peer, current);
  }

  return {
    async handle(req: Request, peer = "unknown"): Promise<Response> {
      // Host is checked before anything expensive; it is not authentication, it
      // only stops DNS-rebinding/absolute-URL confusion.
      if (!controlHostAllowed(req.headers.get("host"), allowedHosts)) return errorResponse(403, "forbidden");
      if (browserOrigin(req)) return errorResponse(403, "forbidden");

      // Global rate limit first, so unknown routes cannot be used as an oracle
      // or a free work generator.
      const global = buckets.take("request:all", limits.request);
      if (!global.ok) return errorResponse(429, "rate_limited", { "retry-after": String(Math.ceil(global.retryAfterMs / 1000)) });

      const target = targetOf(req);
      if (!target) return errorResponse(400, "malformed");
      const route = routeOf(req.method, target.rawPath);
      if (route === null) return errorResponse(404, "not_found");
      if (route === "method") return errorResponse(405, "method_not_allowed", { allow: target.rawPath === "/p2p/v1/health" ? "GET" : "POST" });

      const routeRule = route === "health" ? limits.health : route === "hello" ? limits.hello : limits.frame;
      const perPeer = buckets.take(`${route}:${peer}`, routeRule);
      if (!perPeer.ok) return errorResponse(429, "rate_limited", { "retry-after": String(Math.ceil(perPeer.retryAfterMs / 1000)) });

      const busy = enter(peer);
      if (busy) return busy;
      try {
        const startedAt = now();
        const timeout = route === "health" ? limits.healthTimeoutMs : route === "hello" ? limits.helloTimeoutMs : limits.frameTimeoutMs;
        const bodyLimit = route === "hello" ? limits.maxHelloBytes : route === "frame" ? limits.maxFrameBytes : 0;

        if (route === "health") {
          if (target.url.search !== "") return errorResponse(400, "malformed");
          if (!contentEncodingIsIdentity(req)) return errorResponse(415, "unsupported_encoding");
          const declared = declaredLength(req);
          if (declared === "invalid") return errorResponse(400, "malformed");
          if (declared !== null && declared > 0) return errorResponse(400, "malformed");
          return await boundedWork(
            (async () =>
              response(
                JSON.stringify({
                  ok: true,
                  protocol: "ohmyaihub/p2p/v1",
                }),
                200,
              ))(),
            timeout,
          );
        }

        if (!contentEncodingIsIdentity(req)) return errorResponse(415, "unsupported_encoding");
        if (route === "hello") {
          if (target.url.search !== "") return errorResponse(400, "malformed");
          if (!jsonContentType(req)) return errorResponse(415, "unsupported_media_type");
        } else {
          const keys = [...target.url.searchParams.keys()];
          const sessions = target.url.searchParams.getAll("session");
          if (target.url.search === "" || keys.length !== 1 || keys[0] !== "session" || sessions.length !== 1 || !/^[a-f0-9]{32}$/.test(sessions[0])) {
            return errorResponse(400, "malformed");
          }
          if (!frameContentType(req)) return errorResponse(415, "unsupported_media_type");
        }

        const work = (async (): Promise<Response> => {
          const bytes = await readBounded(req, bodyLimit, startedAt + timeout, now);
          if (bytes instanceof Response) return bytes;
          if (route === "hello") {
            if (bytes.byteLength === 0) return errorResponse(400, "malformed");
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
            } catch {
              return errorResponse(400, "malformed");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return errorResponse(400, "malformed");
            const result = await options.node.acceptHello(parsed);
            return responseBody(result);
          }
          const sessionId = target.url.searchParams.get("session")!;
          if (bytes.byteLength === 0) return errorResponse(400, "malformed");
          const result = await options.node.handleFrame(sessionId, bytes);
          // A successful frame has no response body: the business result is
          // local to the node and the caller only needs to know it was accepted.
          void result;
          return new Response(null, { status: 204, headers: NO_STORE });
        })().catch((error: unknown) => refusal(error));

        return await boundedWork(work, timeout);
      } catch (error) {
        return refusal(error);
      } finally {
        leave(peer);
      }
    },
  };
}

export interface ControlServerOptions extends ControlHttpOptions {
  /** Exact bind address. A wildcard bind is refused unless explicitly allowed. */
  host: string;
  port: number;
  allowWildcardBind?: boolean;
}

export interface ControlServerHandle {
  host: string;
  port: number;
  listener: ControlListenerKind;
  stop: () => void;
}

/**
 * Opens the listener. The caller supplies the port (A-service allocates it) and
 * the exact Host values (loopback, LAN and mapped overlay address). A wildcard
 * bind would make the listener reachable on every interface, so it is refused
 * unless the caller explicitly says it has accounted for that exposure.
 */
export function startControlServer(options: ControlServerOptions): ControlServerHandle {
  const host = options.host.trim();
  if (!host) throw new Error("control listener needs an explicit bind host");
  if ((host === "0.0.0.0" || host === "::" || host === "[::]") && !options.allowWildcardBind) {
    throw new Error("refusing a wildcard control bind: pass the loopback or LAN address explicitly");
  }
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const listener: ControlListenerKind = options.listener ?? (loopback ? "loopback-only" : "lan-reachable");
  if (listener === "loopback-only" && !loopback) {
    throw new Error("a non-loopback control listener cannot be reported as loopback-only");
  }
  if (!options.allowedHosts.length) throw new Error("control listener needs at least one exact allowed Host value");
  const handler = createControlHandler({ ...options, listener });
  let bound = options.port;
  const server = Bun.serve({
    hostname: host,
    port: options.port,
    // Our own readers enforce tighter caps; this is the last-resort guard for a
    // request that never reaches the handler.
    maxRequestBodySize: Math.max(options.limits?.maxFrameBytes ?? DEFAULT_CONTROL_LIMITS.maxFrameBytes, 64 * 1024),
    fetch: (req, srv) => {
      const remote = srv.requestIP(req)?.address ?? "unknown";
      return handler.handle(req, remote).catch(() => errorResponse(500, "internal"));
    },
  });
  bound = server.port ?? options.port;
  return {
    host,
    port: bound,
    listener,
    stop: () => server.stop(true),
  };
}
