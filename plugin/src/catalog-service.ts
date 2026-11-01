// The directory document this node publishes, and the one endpoint that serves
// it (DESIGN-V2 §8.1).
//
// `omai/catalog/1` is a small self-signed JSON body: the node's wallet address,
// its hostname, the two fixed ports, and the native models it shares with their
// prices. `sig` is an EIP-191 `personal_sign` over `canonicalJson` of every
// field except `sig`, so a reader can prove the document was written by whoever
// owns `address` — the overlay address a peer was reached on proves nothing.
//
// The service binds exactly one interface (the LAN address EasyTier exports) and
// answers exactly one path, `GET /catalog`. No CORS, no write path, no admin
// surface, no cache. Re-signing happens in memory: changing the shared models
// never restarts the core.

import type { Wallet } from "ethers";
import { logger } from "./log.ts";
import { signCanonical, signerOf } from "./signing.ts";

export const CATALOG_SCHEMA = "omai/catalog/1" as const;
/** The one path the directory server answers. Anything else is a 404. */
export const CATALOG_PATH = "/catalog";
export const CATALOG_MAX_BYTES = 64 * 1024;
export const CATALOG_MAX_MODELS = 200;
export const CATALOG_MAX_MODEL_ID = 200;
export const CATALOG_MAX_HOSTNAME = 64;

/** USD per 1M tokens — exactly the unit Magpie's own prices use. */
export interface CatalogPrice {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CatalogModel {
  id: string;
  price: CatalogPrice;
}

/** Every signed field except `sig`. */
export interface CatalogBody {
  schema: typeof CATALOG_SCHEMA;
  address: string;
  hostname: string;
  controlPort: number;
  gatewayPort: number | null;
  models: CatalogModel[];
  ts: string;
}

export interface CatalogDocument extends CatalogBody {
  sig: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function isHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CATALOG_MAX_HOSTNAME &&
    HOSTNAME_RE.test(value)
  );
}

export function isCatalogPrice(value: unknown): value is CatalogPrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== 4) return false;
  for (const key of ["in", "out", "cacheRead", "cacheWrite"]) {
    if (!Object.hasOwn(p, key)) return false;
    const n = p[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false;
  }
  return true;
}

export function isCatalogModel(value: unknown): value is CatalogModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (Object.keys(m).length !== 2 || !Object.hasOwn(m, "id") || !Object.hasOwn(m, "price")) return false;
  const id = m.id;
  if (typeof id !== "string" || id.trim().length === 0 || id.length > CATALOG_MAX_MODEL_ID) return false;
  return isCatalogPrice(m.price);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TS_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** ISO-8601 UTC, seconds precision (DESIGN-V2 §8.1 writes `…T10:00:00Z`). */
export function catalogTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Construct-time limits: at most 200 models, non-empty ids, finite non-negative
 * prices. An entry that cannot be published is dropped rather than signed into a
 * document a reader would have to reject as a whole.
 */
export function sanitizeCatalogModels(raw: readonly unknown[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const value of raw) {
    if (out.length >= CATALOG_MAX_MODELS) {
      logger.warn(`catalogue: dropping models after the first ${CATALOG_MAX_MODELS}`);
      break;
    }
    if (!isCatalogModel(value)) {
      logger.warn("catalogue: dropping a model with a missing id or an incomplete price");
      continue;
    }
    out.push({ id: value.id, price: { ...value.price } });
  }
  return out;
}

export interface CatalogInput {
  address: string;
  hostname: string;
  controlPort: number;
  gatewayPort: number | null;
  models: readonly unknown[];
  ts?: string;
}

/** The unsigned document, with every limit and default applied. */
export function buildCatalogBody(input: CatalogInput): CatalogBody {
  if (!ADDRESS_RE.test(input.address)) throw new Error(`not an EVM address: ${input.address}`);
  if (!isHostname(input.hostname)) throw new Error(`not a valid hostname: ${input.hostname}`);
  if (!isPort(input.controlPort)) throw new Error(`not a TCP port: ${String(input.controlPort)}`);
  if (input.gatewayPort !== null && !isPort(input.gatewayPort)) {
    throw new Error(`not a TCP port: ${String(input.gatewayPort)}`);
  }
  return {
    schema: CATALOG_SCHEMA,
    address: input.address,
    hostname: input.hostname,
    controlPort: input.controlPort,
    gatewayPort: input.gatewayPort,
    models: sanitizeCatalogModels(input.models),
    ts: input.ts ?? catalogTimestamp(),
  };
}

export type CatalogParse = { ok: true; doc: CatalogDocument } | { ok: false; error: string };

/**
 * Strict parse of a peer's document: exact field set (unknown fields are
 * rejected), every type and bound checked, the signature verified, and the
 * signer required to equal `address`. A peer that fails any check is reported as
 * offline by `discover`; it is never partially trusted.
 */
export function parseCatalogDocument(raw: unknown): CatalogParse {
  const reject = (error: string): CatalogParse => ({ ok: false, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("not a JSON object");
  const o = raw as Record<string, unknown>;

  const required = ["schema", "address", "hostname", "controlPort", "gatewayPort", "models", "ts", "sig"];
  const own = Object.keys(o);
  if (own.length !== required.length) return reject("unexpected field count");
  for (const key of required) if (!Object.hasOwn(o, key)) return reject(`missing field ${key}`);
  for (const key of own) if (!required.includes(key)) return reject(`unknown field ${key}`);

  if (o.schema !== CATALOG_SCHEMA) return reject(`schema is not ${CATALOG_SCHEMA}`);
  if (typeof o.address !== "string" || !ADDRESS_RE.test(o.address)) return reject("address is not an EVM address");
  if (typeof o.hostname !== "string" || !isHostname(o.hostname)) return reject("hostname is invalid");
  if (!isPort(o.controlPort)) return reject("controlPort is not a TCP port");
  if (o.gatewayPort !== null && !isPort(o.gatewayPort)) return reject("gatewayPort is not null or a TCP port");
  if (!isTimestamp(o.ts)) return reject("ts is not an ISO-8601 UTC timestamp");
  if (typeof o.sig !== "string" || !SIGNATURE_RE.test(o.sig)) return reject("sig is not 65 bytes of hex");
  if (!Array.isArray(o.models)) return reject("models is not an array");
  if (o.models.length > CATALOG_MAX_MODELS) return reject(`models has more than ${CATALOG_MAX_MODELS} entries`);
  const models: CatalogModel[] = [];
  for (const value of o.models) {
    if (!isCatalogModel(value)) return reject("a model has an invalid id or price");
    models.push({ id: value.id, price: { ...value.price } });
  }
  if (models.length === 0 && o.gatewayPort !== null) return reject("gatewayPort must be null when no model is shared");
  if (models.length > 0 && o.gatewayPort === null) return reject("gatewayPort is null while models are shared");

  const body: CatalogBody = {
    schema: CATALOG_SCHEMA,
    address: o.address,
    hostname: o.hostname,
    controlPort: o.controlPort,
    gatewayPort: o.gatewayPort,
    models,
    ts: o.ts,
  };
  const signer = signerOf(body, o.sig);
  if (!signer) return reject("signature does not recover");
  if (signer !== o.address.toLowerCase()) return reject(`signature is from ${signer}, not ${o.address}`);

  return { ok: true, doc: { ...body, sig: o.sig } };
}

export interface CatalogServiceOptions {
  wallet: Wallet;
  hostname: string;
  controlPort: number;
  /** the Magpie gateway port, published only while at least one model is shared */
  gatewayPort: number;
}

export interface CatalogServiceStatus {
  listening: boolean;
  host: string | null;
  port: number;
  modelCount: number;
  catalogTs: string | null;
  detail: string | null;
}

/**
 * Holds the signed document in memory and serves it on `<lan>:3426`.
 *
 * A failed bind (port taken, address gone) is recorded in `detail` and visible
 * through `status`; it never kills the plugin, and the share selection is kept.
 */
export class CatalogService {
  private wallet: Wallet;
  private hostname: string;
  private readonly controlPort: number;
  private readonly gatewayPort: number;
  private doc: CatalogDocument | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private boundHost: string | null = null;
  private bindDetail: string | null = null;
  private refreshDetail: string | null = null;

  constructor(opts: CatalogServiceOptions) {
    this.wallet = opts.wallet;
    this.hostname = opts.hostname;
    this.controlPort = opts.controlPort;
    this.gatewayPort = opts.gatewayPort;
  }

  get current(): CatalogDocument | null {
    return this.doc;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  status(): CatalogServiceStatus {
    return {
      listening: this.listening,
      host: this.boundHost,
      port: this.controlPort,
      modelCount: this.doc?.models.length ?? 0,
      catalogTs: this.doc?.ts ?? null,
      detail: this.bindDetail ?? this.refreshDetail,
    };
  }

  /**
   * Why the last refresh could not re-sign (Magpie unreadable). A successful
   * refresh clears it; a bind problem is tracked separately so one never hides
   * the other.
   */
  setDetail(detail: string | null): void {
    const value = detail?.replace(/\s+/g, " ").trim().slice(0, 300) ?? "";
    this.refreshDetail = value || null;
  }

  /** A changed node wallet changes the document's address, signature and hostname. */
  setWallet(wallet: Wallet, hostname?: string): void {
    this.wallet = wallet;
    if (hostname) this.hostname = hostname;
  }

  /**
   * Re-signs the document in memory. `models` must already be shareable native
   * models; only the publish limits are applied here. No core restart.
   */
  async update(models: readonly CatalogModel[]): Promise<CatalogDocument> {
    const body = buildCatalogBody({
      address: this.wallet.address,
      hostname: this.hostname,
      controlPort: this.controlPort,
      gatewayPort: models.length > 0 ? this.gatewayPort : null,
      models,
    });
    const sig = await signCanonical(this.wallet, body);
    const doc: CatalogDocument = { ...body, sig };
    this.doc = doc;
    return doc;
  }

  /** Re-signs the current model set after a wallet change. */
  async resign(): Promise<CatalogDocument | null> {
    if (!this.doc) return null;
    return this.update(this.doc.models);
  }

  /** Binds `<lanIp>:<controlPort>`. Idempotent; a failed bind is a status detail. */
  start(lanIp: string | null): boolean {
    if (!lanIp) {
      this.bindDetail = "no exportable LAN address (没有可导出的 LAN 地址)";
      return false;
    }
    if (this.server && this.boundHost === lanIp) return true;
    if (this.server) this.stop();
    try {
      this.server = Bun.serve({
        hostname: lanIp,
        port: this.controlPort,
        idleTimeout: 10,
        fetch: (req) => this.handle(req),
      });
      this.boundHost = lanIp;
      this.bindDetail = null;
      logger.info(`catalogue listening on http://${lanIp}:${this.controlPort}${CATALOG_PATH}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.server = null;
      this.boundHost = null;
      this.bindDetail = `cannot bind ${lanIp}:${this.controlPort}: ${message.slice(0, 200)}`;
      logger.error(`catalogue: ${this.bindDetail}`);
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

  private handle(req: Request): Response {
    if (req.method !== "GET") return plain(405, "method not allowed");
    const url = new URL(req.url);
    if (url.pathname !== CATALOG_PATH || url.search !== "") return plain(404, "not found");
    if (!this.doc) return plain(503, "the directory is not published yet");
    const body = JSON.stringify(this.doc);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        "cache-control": "no-store",
      },
    });
  }
}

function plain(status: number, message: string): Response {
  return new Response(message + "\n", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(message) + 1),
      "cache-control": "no-store",
    },
  });
}
