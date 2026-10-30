import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./log.ts";
import { maskSensitiveText } from "./page-snapshot.ts";
import { ConsolePairingJournal, PairingCapacityError, PairingUnavailableError } from "./console-pairing.ts";
import type { PendingPairing } from "./console-pairing.ts";

export interface ConsoleServerOptions {
  port?: number;
  state: () => Promise<unknown>;
  action: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  allowedActions: readonly string[];
  /** One response owner per UUID; only fingerprint tombstones are retained. */
  sensitiveActions?: readonly string[];
  assetsDir?: string;
  /** Exact host-controlled shipped module paths, e.g. ["/settings.js"]. No filesystem routing. */
  staticModules?: readonly string[];
  /** Explicit experiment setting, never selected from a User-Agent. HTTP127 defaults to false. */
  secureCookie?: boolean;
  /** Host-owned state path only. Omit to disable explicit browser pairing. */
  pairingFile?: string;
}

export interface ConsoleServer {
  port: number;
  origin: string;
  /** Secret-bearing launch URL. Never persist, log, or include it in a page snapshot. */
  issueTicket(): string;
  pendingPairings(): PendingPairing[];
  /** Called only from explicit Magpie official-options approval, never browser input. */
  approvePairing(id: string, code: string): boolean;
  stop(): void;
}

export interface ConsoleHandler extends ConsoleServer {
  handle(request: Request): Promise<Response>;
}

/** Backend adapters may use this for validation refusals before doing any work. No raw error text crosses HTTP. */
export class ConsoleInputError extends Error {
  constructor(message = "invalid console action input") {
    // Only an explicitly selected pre-mutation validation message is eligible.
    // Redact before truncating, or truncation could leave half a registered secret.
    super(maskSensitiveText(redact(message)).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300));
    this.name = "ConsoleInputError";
  }
}

const BODY_LIMIT = 64 * 1024;
const RESULT_LIMIT = 256 * 1024;
const STATE_LIMIT = 2 * 1024 * 1024;
const SESSION_CACHE_LIMIT = 2 * 1024 * 1024;
const TOTAL_CACHE_LIMIT = 8 * 1024 * 1024;
const CSRF_HEADER = "X-Ohmyaihub-Request".replace(/Request$/, "CS" + "RF");
const TICKET_TTL = 2 * 60 * 1000;
const TICKET_LIMIT = 32;
const SESSION_LIMIT = 16;
const SESSION_IDLE = 30 * 60 * 1000;
const SESSION_ABSOLUTE = 8 * 60 * 60 * 1000;
const OPERATION_LIMIT = 128;
const SECRET = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODULE_PATH = /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.js$/;

interface Result {
  status: number;
  text: string;
}
interface Operation {
  fingerprint: string;
  result: Promise<Result>;
  pending: boolean;
  bytes: number;
}
interface SensitiveOperation {
  fingerprint: string;
  sensitive: true;
}
interface Session {
  id: string;
  csrf: string;
  idleAt: number;
  absoluteAt: number;
  operations: Map<string, Operation | SensitiveOperation>;
  cacheBytes: number;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "x-dns-prefetch-control": "off",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function respond(text: string | Uint8Array, status: number, type: string, extra?: HeadersInit): Response {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", type);
  if (extra) new Headers(extra).forEach((v, k) => headers.set(k, v));
  return new Response(typeof text === "string" ? text : new Uint8Array(text), { status, headers });
}

function json(value: unknown, status = 200, extra?: HeadersInit): Response {
  return respond(JSON.stringify(value), status, "application/json; charset=utf-8", extra);
}

function error(code: string, status: number): Response {
  return json({ error: code }, status);
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

function equalSecret(given: string | null, wanted: string): boolean {
  return given !== null && SECRET.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(wanted));
}

/** Key order does not change an operation's identity; array order and JSON value types do. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readObject(req: Request): Promise<Record<string, unknown> | Response> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type")?.trim() ?? "")) {
    return error("json_content_type_required", 415);
  }
  const encoding = req.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return error("content_encoding_not_supported", 415);
  const length = req.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) return error("invalid_content_length", 400);
  if (length !== null && Number(length) > BODY_LIMIT) return error("body_too_large", 413);
  if (!req.body) return error("json_object_required", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > BODY_LIMIT) {
        await reader.cancel().catch(() => {});
        return error("body_too_large", 413);
      }
      chunks.push(value);
    }
  } catch {
    return error("unreadable_body", 400);
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return error("json_object_required", 400);
    return value as Record<string, unknown>;
  } catch {
    return error("json_object_required", 400);
  }
}

function loadAssets(options: ConsoleServerOptions): Map<string, { bytes: Uint8Array; type: string }> {
  const root = realpathSync(options.assetsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "../console"));
  const paths = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
    ["/session.js", { file: "session.js", type: "text/javascript; charset=utf-8" }],
    ["/providers.js", { file: "providers.js", type: "text/javascript; charset=utf-8" }],
  ]);
  for (const path of options.staticModules ?? []) {
    if (!MODULE_PATH.test(path)) throw new Error("invalid shipped console module path");
    paths.set(path, { file: path.slice(1), type: "text/javascript; charset=utf-8" });
  }
  const assets = new Map<string, { bytes: Uint8Array; type: string }>();
  for (const [path, asset] of paths) {
    const file = realpathSync(resolve(root, asset.file));
    const rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("console asset is outside its shipped directory");
    assets.set(path, { bytes: readFileSync(file), type: asset.type });
  }
  return assets;
}

/** Deterministic clock is only available to in-process tests, never request input. */
export function createConsoleHandler(
  options: ConsoleServerOptions,
  port: number,
  runtime: { now?: () => number } = {},
): ConsoleHandler {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid console port");
  const origin = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;
  const assets = loadAssets(options);
  const actions = new Set(options.allowedActions);
  for (const name of actions) {
    if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(name)) throw new Error("invalid console action name");
  }
  const sensitiveActions = new Set(options.sensitiveActions ?? []);
  for (const name of sensitiveActions) {
    if (!actions.has(name)) throw new Error("sensitive action must be an allowed console action");
  }
  const now = runtime.now ?? Date.now;
  const pairing = options.pairingFile ? new ConsolePairingJournal(options.pairingFile, now) : undefined;
  const instance = randomBytes(16).toString("hex");
  // Browser cookies do not isolate ports. A stable per-port name overwrites
  // stale cookies on reauthorization; random in-memory sessions still bind
  // authority to this host instance and never survive its restart.
  const cookieName = "ohmyaihub_ui_" + port;
  const cookieAttributes = `Path=/ui/; HttpOnly; SameSite=Strict${options.secureCookie === true ? "; Secure" : ""}`;
  const tickets = new Map<string, number>();
  const sessions = new Map<string, Session>();
  let stopped = false;
  let cacheBytes = 0;

  function retire(session: Session): void {
    sessions.delete(session.id);
    for (const operation of session.operations.values()) {
      // In-flight work retains its reservation until settlement, even across logout.
      if ("result" in operation && !operation.pending) { cacheBytes -= operation.bytes; operation.bytes = 0; }
    }
    session.operations.clear();
    session.cacheBytes = 0;
  }
  function expired(session: Session): boolean {
    return now() >= session.idleAt || now() >= session.absoluteAt;
  }
  function prune(): void {
    const time = now();
    for (const [id, expiresAt] of tickets) if (time >= expiresAt) tickets.delete(id);
    for (const session of sessions.values()) if (expired(session)) retire(session);
  }
  function authenticate(req: Request): Session | undefined {
    const cookie = req.headers.get("cookie");
    if (!cookie || cookie.length > 8192) return;
    const values = cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return;
    const id = values[0]!.slice(cookieName.length + 1);
    if (!SECRET.test(id)) return;
    return sessions.get(id);
  }
  function sessionInfo(session: Session): unknown {
    return { csrf: session.csrf, instance, expiresAt: new Date(Math.min(session.idleAt, session.absoluteAt)).toISOString() };
  }
  function mintSession(previous?: Session): Response {
    if (previous) retire(previous);
    const time = now();
    const session: Session = {
      id: secret(), csrf: secret(), idleAt: time + SESSION_IDLE, absoluteAt: time + SESSION_ABSOLUTE, operations: new Map(), cacheBytes: 0,
    };
    sessions.set(session.id, session);
    return json(sessionInfo(session), 200, { "set-cookie": `${cookieName}=${session.id}; ${cookieAttributes}` });
  }
  function active(session: Session): boolean {
    return !stopped && sessions.get(session.id) === session && !expired(session);
  }
  async function perform(session: Session, name: string, input: Record<string, unknown>): Promise<Result> {
    try {
      // Deferred invocation lets the operation cache claim the UUID before any callback runs.
      const result = await options.action(name, input);
      const text = JSON.stringify({ result });
      if (Buffer.byteLength(text) > RESULT_LIMIT) throw new Error("result too large");
      // A completion cannot resurrect a logged-out or expired session.
      if (active(session)) session.idleAt = Math.min(now() + SESSION_IDLE, session.absoluteAt);
      return { status: 200, text };
    } catch (cause) {
      if (cause instanceof ConsoleInputError) {
        return { status: 400, text: JSON.stringify({ error: "invalid_action_input", message: cause.message }) };
      }
      // Includes money/backend uncertainty. Cache this refusal; never rerun automatically.
      return { status: 500, text: JSON.stringify({ error: "action_outcome_unknown", code: "outcome_unknown" }) };
    }
  }

  async function handle(req: Request): Promise<Response> {
    try {
      if (stopped) return error("console_stopped", 503);
      const url = new URL(req.url);
      if (req.headers.get("host") !== host || url.origin !== origin) return error("unexpected_host", 403);
      const requestOrigin = req.headers.get("origin");
      if (requestOrigin !== null && requestOrigin !== origin) return error("unexpected_origin", 403);
      const site = req.headers.get("sec-fetch-site");
      const isApi = url.pathname.startsWith("/ui/");
      if (site !== null && site !== "same-origin" && !(site === "none" && !isApi)) return error("cross_site_request", 403);
      if (isApi) {
        const mode = req.headers.get("sec-fetch-mode");
        const dest = req.headers.get("sec-fetch-dest");
        if ((mode !== null && mode !== "cors" && mode !== "same-origin") || (dest !== null && dest !== "empty")) {
          return error("unexpected_fetch_metadata", 403);
        }
      }
      // Browser auth is deliberately separate from the CLI API's bearer and routes.
      if (req.headers.has("authorization")) return error("browser_cookie_required", 401);
      if (url.search) return error("query_not_supported", 400);
      prune();
      if (req.method === "GET" && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname)!;
        return respond(asset.bytes, 200, asset.type);
      }
      if (!isApi) return error("not_found", 404);
      if (req.method !== "GET" && req.method !== "POST") return error("method_not_allowed", 405);
      if (req.method === "POST" && requestOrigin !== origin) return error("origin_required", 403);

      if (req.method === "POST" && (url.pathname === "/ui/pairing" || url.pathname === "/ui/pairing/exchange")) {
        if (req.headers.get("X-Ohmyaihub-Request") !== "1") return error("request_header_required", 403);
        if (!pairing) return error("pairing_disabled", 404);
        const input = await readObject(req);
        if (input instanceof Response) return input;
        if (stopped) return error("console_stopped", 503);
        prune();
        if (url.pathname === "/ui/pairing") {
          if (Object.keys(input).length) return error("empty_object_required", 400);
          return json(pairing.create());
        }
        if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "id") || !Object.hasOwn(input, "secret")) {
          return error("pairing_credentials_required", 400);
        }
        const status = pairing.inspect(input.id, input.secret);
        if (status === "invalid") return error("invalid_or_expired_pairing", 401);
        if (status === "pending") return json({ pending: true }, 202);
        const previous = authenticate(req);
        if (sessions.size >= SESSION_LIMIT && !previous) return error("session_limit", 429);
        // Synchronous durable consumption precedes session creation. A lost reply
        // requires a new explicit pairing; no spent credential can be replayed.
        if (!pairing.consume(input.id, input.secret)) return error("invalid_or_expired_pairing", 401);
        return mintSession(previous);
      }

      if (req.method === "POST" && url.pathname === "/ui/session") {
        const input = await readObject(req);
        if (input instanceof Response) return input;
        prune(); // The request body may have been delayed beyond the ticket/session deadline.
        const ticket = input.ticket;
        if (Object.keys(input).length !== 1 || typeof ticket !== "string" || !SECRET.test(ticket) || !tickets.has(ticket)) {
          return error("invalid_or_expired_ticket", 401);
        }
        const previous = authenticate(req);
        if (sessions.size >= SESSION_LIMIT && !previous) return error("session_limit", 429);
        tickets.delete(ticket); // No await between consuming the ticket and claiming the session.
        return mintSession(previous);
      }

      // Custom read header prevents cross-origin/simple-navigation data access even on browsers without Fetch Metadata.
      if (req.headers.get("X-Ohmyaihub-Request") !== "1") return error("request_header_required", 403);
      const session = authenticate(req);
      if (!session) return error("session_required", 401);
      if (req.method === "GET") {
        if (url.pathname === "/ui/session") return json(sessionInfo(session));
        if (url.pathname === "/ui/api/state") {
          const state = JSON.stringify(await options.state());
          if (!active(session)) return error("session_required", 401);
          if (typeof state !== "string" || Buffer.byteLength(state) > STATE_LIMIT) return error("state_too_large", 500);
          return respond(state, 200, "application/json; charset=utf-8");
        }
        return error("not_found", 404);
      }
      if (!equalSecret(req.headers.get(CSRF_HEADER), session.csrf)) return error("csrf_required", 403);
      if (url.pathname === "/ui/logout") {
        const input = await readObject(req);
        if (input instanceof Response) return input;
        retire(session);
        return json({ ok: true }, 200, { "set-cookie": `${cookieName}=; ${cookieAttributes}; Max-Age=0` });
      }
      const prefix = "/ui/api/action/";
      if (!url.pathname.startsWith(prefix)) return error("not_found", 404);
      const name = url.pathname.slice(prefix.length);
      if (!actions.has(name)) return error("action_not_allowed", 404);
      const operationId = req.headers.get("idempotency-key");
      if (!operationId || !UUID.test(operationId)) return error("idempotency_key_required", 400);
      const input = await readObject(req);
      if (input instanceof Response) return input;
      if (!active(session)) return error("session_required", 401);
      const fingerprint = createHash("sha256").update(name).update("\n").update(canonical(input)).digest("hex");
      let operation = session.operations.get(operationId.toLowerCase());
      if (operation && operation.fingerprint !== fingerprint) return error("idempotency_conflict", 409);
      if (operation && "sensitive" in operation) return error("sensitive_response_already_claimed", 409);
      if (!operation && sensitiveActions.has(name)) {
        if (session.operations.size >= OPERATION_LIMIT) return error("operation_limit_reconnect", 429);
        if (session.cacheBytes + RESULT_LIMIT > SESSION_CACHE_LIMIT || cacheBytes + RESULT_LIMIT > TOTAL_CACHE_LIMIT) {
          return error("operation_cache_full", 429);
        }
        // The map never owns a promise or result containing this response.
        // Claim before awaiting the backend so concurrent duplicates fail409.
        session.operations.set(operationId.toLowerCase(), { fingerprint, sensitive: true });
        cacheBytes += RESULT_LIMIT;
        session.cacheBytes += RESULT_LIMIT;
        try {
          const result = await perform(session, name, input);
          return active(session) ? respond(result.text, result.status, "application/json; charset=utf-8") : error("session_required", 401);
        } finally {
          cacheBytes -= RESULT_LIMIT;
          if (sessions.get(session.id) === session) session.cacheBytes -= RESULT_LIMIT;
        }
      }
      if (!operation) {
        // Do not evict a spent UUID: that would permit a delayed replay to mutate twice.
        if (session.operations.size >= OPERATION_LIMIT) return error("operation_limit_reconnect", 429);
        if (session.cacheBytes + RESULT_LIMIT > SESSION_CACHE_LIMIT || cacheBytes + RESULT_LIMIT > TOTAL_CACHE_LIMIT) {
          return error("operation_cache_full", 429);
        }
        // Reserve the maximum response before running the backend. No write can
        // succeed and then discover there is no space to retain its replay result.
        cacheBytes += RESULT_LIMIT;
        session.cacheBytes += RESULT_LIMIT;
        const claimed: Operation = { fingerprint, result: Promise.resolve({ status: 500, text: "" }), pending: true, bytes: RESULT_LIMIT };
        claimed.result = Promise.resolve().then(() => perform(session, name, input)).then((result) => {
          const bytes = Buffer.byteLength(result.text);
          const retained = active(session);
          cacheBytes -= claimed.bytes - (retained ? bytes : 0);
          if (sessions.get(session.id) === session) session.cacheBytes -= claimed.bytes - (retained ? bytes : 0);
          claimed.bytes = retained ? bytes : 0;
          claimed.pending = false;
          return result;
        });
        operation = claimed;
        session.operations.set(operationId.toLowerCase(), operation);
      }
      const result = await operation.result;
      return active(session) ? respond(result.text, result.status, "application/json; charset=utf-8") : error("session_required", 401);
    } catch (cause) {
      if (cause instanceof PairingCapacityError) return error("pairing_limit", 429);
      if (cause instanceof PairingUnavailableError) return error("pairing_unavailable", 503);
      return error("console_request_failed", 500);
    }
  }

  return {
    port, origin, handle,
    pendingPairings: () => stopped ? [] : pairing?.pending() ?? [],
    approvePairing: (id, code) => !stopped && (pairing?.approve(id, code) ?? false),
    issueTicket() {
      if (stopped) throw new Error("console stopped");
      prune();
      if (tickets.size >= TICKET_LIMIT) throw new Error("console ticket limit reached");
      const ticket = secret();
      tickets.set(ticket, now() + TICKET_TTL);
      return `${origin}/#ticket=${ticket}`;
    },
    stop() {
      stopped = true;
      tickets.clear();
      for (const session of sessions.values()) retire(session);
    },
  };
}

/** Own listener only. Never exposes or forwards the Magpie administrative interface. */
export function startConsoleServer(options: ConsoleServerOptions): ConsoleServer {
  let transport: ConsoleHandler | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    // First-use EasyTier download and explicit RPC checks can take minutes.
    // Browser commands have their own bounded deadlines; do not close the
    // socket at Bun's short default while a validated action is still running.
    idleTimeout: 255,
    fetch: (request) => transport?.handle(request) ?? error("console_starting", 503),
  });
  try {
    transport = createConsoleHandler(options, server.port!);
  } catch (cause) {
    server.stop(true);
    throw cause;
  }
  const handler = transport;
  return {
    port: handler.port,
    origin: handler.origin,
    issueTicket: () => handler.issueTicket(),
    pendingPairings: () => handler.pendingPairings(),
    approvePairing: (id, code) => handler.approvePairing(id, code),
    stop() {
      handler.stop();
      server.stop(true);
    },
  };
}
