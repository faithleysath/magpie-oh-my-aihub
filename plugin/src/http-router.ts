// The one HTTP listener this plugin owns: port 3426, bound to this node's
// overlay address with a TUN device, and to 127.0.0.1 without one.
//
// Four endpoints, nothing else:
//   GET  /catalog    the signed directory
//   POST /request    a signed application
//   GET  /request    a signed poll
//   POST /deposit    a signed "look at this transaction" hint
//
// Every route is plain HTTP on the overlay: EasyTier encrypts the transport and
// the network secret is the only door. No CORS, no cookies, no admin surface, no
// cache.
//
// Verification is strict: exact field sets, 16 KiB bodies, a ±5 minute clock
// window, EIP-191 `personal_sign` over `canonicalJson` of the document, and the
// signer required to equal `address`. A bad signature is 403; stale or
// malformed input is 400. `POST /request` is additionally limited to 30 calls
// per address per minute (in memory), because replay is idempotent but a flood
// is not free. `POST /deposit` has its own smaller bucket: one claim costs an
// RPC receipt read.
//
// The body limit is enforced while reading the stream, not after `req.text()`:
// a chunked upload without `Content-Length` is measured as it arrives and the
// read is cancelled the moment it passes 16 KiB.

import type { CatalogService, CatalogServiceStatus } from "./catalog-service.ts";
import type { DepositClaimer } from "./deposit-claim.ts";
import { signerOf } from "./signing.ts";
import { logger } from "./log.ts";
import type { Grants } from "./grants.ts";

export const REQUEST_SCHEMA = "omai/request/1" as const;
export const POLL_SCHEMA = "omai/poll/1" as const;
export const DEPOSIT_SCHEMA = "omai/deposit/1" as const;
export const CATALOG_PATH = "/catalog";
export const REQUEST_PATH = "/request";
export const DEPOSIT_PATH = "/deposit";

const MAX_BODY_BYTES = 16 * 1024;
const TS_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT = 30;
const CLAIM_RATE_LIMIT = 12;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_BUCKETS = 1024;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MODEL_LIMIT = 200;
const MODEL_ID_LIMIT = 200;

export interface DirectoryServerOptions {
  catalog: CatalogService;
  grants: Grants;
  /** verifies and credits a claimed transaction; the route only parses/signs */
  deposits: DepositClaimer;
  /** the fixed directory/control port (3426) */
  controlPort: number;
}

function json(status: number, value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
    },
  });
}

function error(status: number, message: string): Response {
  return json(status, { error: message });
}

function messageOf(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

/**
 * Reads at most `limit` bytes. A declared `Content-Length` over the limit is
 * refused before reading; a chunked body is stopped as soon as the running total
 * passes it, so 16 KiB is a real bound rather than a post-hoc check.
 */
async function readLimitedBody(
  req: Request,
  limit: number,
): Promise<{ text: string | null; tooLarge: boolean }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return { text: null, tooLarge: true };
  if (!req.body) return { text: "", tooLarge: false };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          /* the rest of the upload is already irrelevant */
        }
        return { text: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { text: null, tooLarge: false };
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), tooLarge: false };
}

/** ISO-8601 UTC with seconds (optionally fractions) → ms, or null. */
function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !TS_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function addressOf(value: unknown): string | null {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return null;
  return value.toLowerCase();
}

/**
 * Validates the model list without rewriting it: the exact array the client sent
 * is what it signed, so normalisation (trim, dedupe) happens only after the
 * signature has been checked.
 */
function rawModelsOf(value: unknown): string[] | string {
  if (!Array.isArray(value)) return "models must be an array of model ids";
  if (value.length === 0) return "models must not be empty";
  if (value.length > MODEL_LIMIT) return `models has more than ${MODEL_LIMIT} entries`;
  for (const item of value) {
    if (typeof item !== "string") return "every entry of models must be a string";
    const id = item.trim();
    if (!id) return "a model id must not be empty";
    if (id.length > MODEL_ID_LIMIT) return `a model id is longer than ${MODEL_ID_LIMIT} characters`;
  }
  return value as string[];
}

function normalizeModels(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = item.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

interface ParsedRequest {
  /** exactly what the client signed: the raw address and model strings */
  payload: { schema: typeof REQUEST_SCHEMA; address: string; models: string[]; ts: string };
  /** what is stored: lowercase address, trimmed and deduped models */
  address: string;
  models: string[];
  ts: string;
  sig: string;
}

/** The exact five-field body of `POST /request`; anything else is a 400. */
function parseRequestBody(raw: unknown): ParsedRequest | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "the body is not a JSON object" };
  const o = raw as Record<string, unknown>;
  const required = ["schema", "address", "models", "ts", "sig"];
  const keys = Object.keys(o);
  if (keys.length !== required.length) return { error: "unexpected field count" };
  for (const key of required) if (!Object.hasOwn(o, key)) return { error: `missing field ${key}` };
  for (const key of keys) if (!required.includes(key)) return { error: `unknown field ${key}` };

  if (o.schema !== REQUEST_SCHEMA) return { error: `schema is not ${REQUEST_SCHEMA}` };
  const address = addressOf(o.address);
  if (!address) return { error: "address is not an EVM address" };
  const models = rawModelsOf(o.models);
  if (typeof models === "string") return { error: models };
  if (timestampMs(o.ts) === null) return { error: "ts is not an ISO-8601 UTC timestamp" };
  if (typeof o.sig !== "string" || !SIGNATURE_RE.test(o.sig)) return { error: "sig is not 65 bytes of hex" };
  const ts = o.ts as string;
  return {
    payload: { schema: REQUEST_SCHEMA, address: o.address as string, models, ts },
    address,
    models: normalizeModels(models),
    ts,
    sig: o.sig,
  };
}

interface ParsedDeposit {
  /** exactly what the client signed; the raw tx hash is part of the signature */
  payload: { schema: typeof DEPOSIT_SCHEMA; address: string; chainId: number; txHash: string; logIndex?: number; ts: string };
  address: string;
  chainId: number;
  txHash: string;
  logIndex?: number;
  ts: string;
  sig: string;
}

/** The exact body of `POST /deposit`: six fields, or seven with `logIndex`. */
function parseDepositBody(raw: unknown): ParsedDeposit | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "the body is not a JSON object" };
  const o = raw as Record<string, unknown>;
  const required = ["schema", "address", "chainId", "txHash", "ts", "sig"];
  const keys = Object.keys(o);
  if (keys.length !== required.length && keys.length !== required.length + 1) return { error: "unexpected field count" };
  for (const key of required) if (!Object.hasOwn(o, key)) return { error: `missing field ${key}` };
  for (const key of keys) if (!required.includes(key) && key !== "logIndex") return { error: `unknown field ${key}` };

  if (o.schema !== DEPOSIT_SCHEMA) return { error: `schema is not ${DEPOSIT_SCHEMA}` };
  const address = addressOf(o.address);
  if (!address) return { error: "address is not an EVM address" };
  if (typeof o.chainId !== "number" || !Number.isSafeInteger(o.chainId) || o.chainId <= 0) {
    return { error: "chainId must be a positive integer" };
  }
  if (typeof o.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(o.txHash)) {
    return { error: "txHash is not a 32-byte hex transaction hash" };
  }
  let logIndex: number | undefined;
  if (o.logIndex !== undefined) {
    if (typeof o.logIndex !== "number" || !Number.isSafeInteger(o.logIndex) || o.logIndex < 0) {
      return { error: "logIndex must be a non-negative integer" };
    }
    logIndex = o.logIndex;
  }
  if (timestampMs(o.ts) === null) return { error: "ts is not an ISO-8601 UTC timestamp" };
  if (typeof o.sig !== "string" || !SIGNATURE_RE.test(o.sig)) return { error: "sig is not 65 bytes of hex" };
  const ts = o.ts as string;
  const payload: ParsedDeposit["payload"] = {
    schema: DEPOSIT_SCHEMA,
    address: o.address as string,
    chainId: o.chainId,
    txHash: o.txHash,
    ts,
  };
  if (logIndex !== undefined) payload.logIndex = logIndex;
  return { payload, address, chainId: o.chainId, txHash: o.txHash, ...(logIndex !== undefined ? { logIndex } : {}), ts, sig: o.sig };
}

/**
 * Owns the listener, the routes and the per-address request bucket. The signed
 * document and all authorization state are injected; nothing about either is
 * decided here beyond input validation.
 */
export class DirectoryServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private boundHost: string | null = null;
  private bindDetail: string | null = null;
  private readonly buckets = new Map<string, number[]>();
  private readonly claimBuckets = new Map<string, number[]>();

  constructor(private readonly opts: DirectoryServerOptions) {}

  get listening(): boolean {
    return this.server !== null;
  }

  /** The bound port; with `controlPort: 0` this is the OS-assigned one. */
  get port(): number {
    return this.server?.port ?? this.opts.controlPort;
  }

  status(): CatalogServiceStatus {
    const doc = this.opts.catalog.current;
    return {
      listening: this.listening,
      host: this.boundHost,
      port: this.port,
      modelCount: doc?.models.length ?? 0,
      catalogTs: doc?.ts ?? null,
      detail: this.bindDetail ?? this.opts.catalog.detail,
    };
  }

  /**
   * Binds `<host>:<controlPort>`: every interface with a TUN device, `127.0.0.1`
   * without one (that is where the user-space stack rewrites inbound). Rebinds
   * when the host changes; a failed bind is a status detail.
   */
  start(host: string | null): boolean {
    if (!host) {
      this.bindDetail = "no bind address (没有可绑定的地址)";
      if (this.server) this.stop();
      return false;
    }
    if (this.server && this.boundHost === host) return true;
    if (this.server) this.stop();
    try {
      this.server = Bun.serve({
        hostname: host,
        port: this.port,
        idleTimeout: 10,
        fetch: (req) => this.handle(req),
      });
      this.boundHost = host;
      this.bindDetail = null;
      const port = this.server.port;
      logger.info(
        `directory listening on http://${host}:${port}` +
          `${CATALOG_PATH}, ${REQUEST_PATH} (GET, POST), ${DEPOSIT_PATH} (POST)`,
      );
      return true;
    } catch (error) {
      const message = messageOf(error);
      this.server = null;
      this.boundHost = null;
      this.bindDetail = `cannot bind ${host}:${this.opts.controlPort}: ${message.slice(0, 200)}`;
      logger.error(`directory: ${this.bindDetail}`);
      return false;
    }
  }

  stop(): void {
    if (!this.server) return;
    try {
      this.server.stop(true);
    } catch {
      /* already stopped */
    }
    this.server = null;
    this.boundHost = null;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === CATALOG_PATH) {
      if (req.method !== "GET") return error(405, "method not allowed");
      if (url.search) return error(404, "not found");
      const doc = this.opts.catalog.current;
      if (!doc) return error(503, "the directory is not published yet");
      return json(200, doc);
    }
    if (url.pathname === REQUEST_PATH) {
      if (req.method === "POST") return this.handleRequest(req);
      if (req.method === "GET") return this.handlePoll(url);
      return error(405, "method not allowed");
    }
    if (url.pathname === DEPOSIT_PATH) {
      if (req.method !== "POST") return error(405, "method not allowed");
      return this.handleDeposit(req);
    }
    return error(404, "not found");
  }

  private async handleRequest(req: Request): Promise<Response> {
    const read = await readLimitedBody(req, MAX_BODY_BYTES);
    if (read.tooLarge) return error(413, `the request body is larger than ${MAX_BODY_BYTES} bytes`);
    if (read.text === null) return error(400, "cannot read the request body");
    const text = read.text;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return error(400, "the body is not JSON");
    }
    const body = parseRequestBody(parsed);
    if ("error" in body) return error(400, body.error);

    const age = Math.abs(Date.now() - (timestampMs(body.ts) ?? 0));
    if (age > TS_WINDOW_MS) return error(400, "ts is outside the ±5 minute window");

    // The signature covers the raw payload, not the normalised values: trimming
    // a model id after verification would let a valid signature cover a different
    // stored list.
    const signer = signerOf(body.payload, body.sig);
    if (!signer) return error(403, "the signature does not recover");
    if (signer !== body.address) return error(403, `the signature is from ${signer}, not ${body.address}`);

    if (!this.allow(body.address)) {
      return error(429, "too many requests from this address; try again in a minute");
    }

    try {
      return json(200, this.opts.grants.upsertRequest(body.address, body.models, body.ts));
    } catch (err) {
      return error(400, messageOf(err));
    }
  }

  private async handleDeposit(req: Request): Promise<Response> {
    const read = await readLimitedBody(req, MAX_BODY_BYTES);
    if (read.tooLarge) return error(413, `the deposit body is larger than ${MAX_BODY_BYTES} bytes`);
    if (read.text === null) return error(400, "cannot read the deposit body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return error(400, "the body is not JSON");
    }
    const body = parseDepositBody(parsed);
    if ("error" in body) return error(400, body.error);

    const age = Math.abs(Date.now() - (timestampMs(body.ts) ?? 0));
    if (age > TS_WINDOW_MS) return error(400, "ts is outside the ±5 minute window");
    const signer = signerOf(body.payload, body.sig);
    if (!signer) return error(403, "the signature does not recover");
    if (signer !== body.address) return error(403, `the signature is from ${signer}, not ${body.address}`);
    if (!this.allowClaim(body.address)) {
      return error(429, "too many deposit claims from this address; try again in a minute");
    }

    try {
      return json(
        200,
        await this.opts.deposits.claim({
          payer: body.address,
          chainId: body.chainId,
          txHash: body.txHash,
          ...(body.logIndex !== undefined ? { logIndex: body.logIndex } : {}),
        }),
      );
    } catch (err) {
      logger.warn(`deposit claim from ${body.address} failed: ${messageOf(err)}`);
      return error(502, `the provider could not check this transaction: ${messageOf(err)}`);
    }
  }

  private handlePoll(url: URL): Response {
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 3) return error(400, "expected exactly address, ts and sig");
    const seen = new Set(entries.map(([key]) => key));
    if (seen.size !== 3 || !seen.has("address") || !seen.has("ts") || !seen.has("sig")) {
      return error(400, "expected exactly address, ts and sig");
    }

    const rawAddress = url.searchParams.get("address") ?? "";
    const address = addressOf(rawAddress);
    if (!address) return error(400, "address is not an EVM address");
    const ts = url.searchParams.get("ts") ?? "";
    if (timestampMs(ts) === null) return error(400, "ts is not an ISO-8601 UTC timestamp");
    if (Math.abs(Date.now() - (timestampMs(ts) ?? 0)) > TS_WINDOW_MS) {
      return error(400, "ts is outside the ±5 minute window");
    }
    const sig = url.searchParams.get("sig") ?? "";
    if (!SIGNATURE_RE.test(sig)) return error(400, "sig is not 65 bytes of hex");

    // The query string itself is the signed document.
    const signer = signerOf({ schema: POLL_SCHEMA, address: rawAddress, ts }, sig);
    if (!signer) return error(403, "the signature does not recover");
    if (signer !== address) return error(403, `the signature is from ${signer}, not ${address}`);

    return json(200, this.opts.grants.snapshot(address));
  }

  /** 30 applications per address per minute; the bucket only counts accepted calls. */
  private allow(address: string): boolean {
    return this.allowIn(this.buckets, address, RATE_LIMIT);
  }

  /** Deposit claims cost a receipt read; keep their budget separate and smaller. */
  private allowClaim(address: string): boolean {
    return this.allowIn(this.claimBuckets, address, CLAIM_RATE_LIMIT);
  }

  private allowIn(buckets: Map<string, number[]>, address: string, limit: number): boolean {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    let stamps = buckets.get(address);
    if (!stamps) {
      if (buckets.size >= MAX_RATE_BUCKETS) {
        this.pruneBuckets(buckets, cutoff);
        // A flood of distinct, currently active addresses must not grow the map
        // past the cap: evict the oldest bucket (Map preserves insertion order).
        if (buckets.size >= MAX_RATE_BUCKETS) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      stamps = [];
      buckets.set(address, stamps);
    }
    while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
    if (stamps.length >= limit) return false;
    stamps.push(now);
    return true;
  }

  private pruneBuckets(buckets: Map<string, number[]>, cutoff: number): void {
    for (const [address, stamps] of buckets) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) buckets.delete(address);
    }
  }
}

/** The exact canonical payload a client signs for a poll. Exported for tools. */
export function pollPayload(address: string, ts: string): { schema: typeof POLL_SCHEMA; address: string; ts: string } {
  return { schema: POLL_SCHEMA, address, ts };
}

/** The exact canonical payload a client signs for an application. Exported for tools. */
export function requestPayload(
  address: string,
  models: string[],
  ts: string,
): { schema: typeof REQUEST_SCHEMA; address: string; models: string[]; ts: string } {
  return { schema: REQUEST_SCHEMA, address, models, ts };
}

/** The exact canonical payload a client signs for a deposit claim. Exported for tools. */
export function depositPayload(
  address: string,
  chainId: number,
  txHash: string,
  logIndex: number | undefined,
  ts: string,
): { schema: typeof DEPOSIT_SCHEMA; address: string; chainId: number; txHash: string; logIndex?: number; ts: string } {
  const payload: { schema: typeof DEPOSIT_SCHEMA; address: string; chainId: number; txHash: string; logIndex?: number; ts: string } = {
    schema: DEPOSIT_SCHEMA,
    address,
    chainId,
    txHash,
    ts,
  };
  if (logIndex !== undefined) payload.logIndex = logIndex;
  return payload;
}
