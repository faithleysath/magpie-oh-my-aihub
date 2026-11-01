// The directory document this node publishes.
//
// A self-signed JSON body: the node's wallet address, its hostname, the two
// fixed ports, and the native models it shares with their prices. `sig` is an
// EIP-191 `personal_sign` over `canonicalJson` of every field except `sig`, so a
// reader can prove the document was written by whoever owns `address` — the
// overlay address a peer was reached on proves nothing.
//
// Two schemas exist. `omai/catalog/1` gives a model exactly four numbers per
// million tokens. `omai/catalog/2` adds `tiers` (long-context pricing) and `peak`
// (a multiplier during the vendor's peak hours) to the same four numbers, and is
// used only when at least one shared model needs them — a node that shares plain
// prices keeps signing /1, so an older peer still reads it. A reader accepts both
// and rejects anything it does not fully understand: a silently ignored price
// field would make the reader compute a different bill than the one signed.
//
// This module only builds, signs and parses that document. The HTTP listener and
// every route (`GET /catalog`, `POST /request`, `GET /request`) live in
// `http-router.ts`, so the request/approval business never mixes with document
// construction. Re-signing happens in memory: changing the shared models never
// restarts the core.

import type { Wallet } from "ethers";
import { logger } from "./log.ts";
import { signCanonical, signerOf } from "./signing.ts";

export const CATALOG_SCHEMA_V1 = "omai/catalog/1" as const;
/**
 * Prices that cannot be written as four numbers are published under
 * `omai/catalog/2`: a price may carry `tiers` (a request above a token
 * threshold bills at that tier's rates) and `peak` (all four numbers multiply at
 * the vendor's peak hours). A document whose prices are all plain stays on /1,
 * so a peer running an older build keeps reading it.
 */
export const CATALOG_SCHEMA_V2 = "omai/catalog/2" as const;
export type CatalogSchema = typeof CATALOG_SCHEMA_V1 | typeof CATALOG_SCHEMA_V2;
/** What a document with plain prices is signed as. */
export const CATALOG_SCHEMA = CATALOG_SCHEMA_V1;
/** The one path the directory server answers. Anything else is a 404. */
export const CATALOG_PATH = "/catalog";
export const CATALOG_MAX_BYTES = 64 * 1024;
export const CATALOG_MAX_MODELS = 200;
export const CATALOG_MAX_MODEL_ID = 200;
export const CATALOG_MAX_HOSTNAME = 64;
/** Magpie's own price schema accepts at most ten tiers; the directory does too. */
export const CATALOG_MAX_TIERS = 10;

/**
 * One long-context tier. `above` is a prompt-token count: a request whose input
 * exceeds it is billed entirely at this tier's rates, which is how the vendors
 * this mirrors price long context.
 */
export interface CatalogPriceTier {
  above: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The vendor bills more during its peak hours. `multiplier` is what all four
 * numbers become then; `note` names the schedule (Magpie's own tag, such as
 * `weekdays`) because a reader cannot know the vendor's clock from the document.
 */
export interface CatalogPeak {
  multiplier: number;
  note?: string;
}

/** USD per 1M tokens — exactly the unit Magpie's own prices use. */
export interface CatalogPrice {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  /** ascending by `above`; the base numbers apply at or below the first one */
  tiers?: CatalogPriceTier[];
  peak?: CatalogPeak;
}

export interface CatalogModel {
  id: string;
  price: CatalogPrice;
}

/** Every signed field except `sig`. */
export interface CatalogBody {
  schema: CatalogSchema;
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

const PRICE_PARTS = ["in", "out", "cacheRead", "cacheWrite"] as const;
const TIER_KEYS = ["above", ...PRICE_PARTS];
const PEAK_KEYS = ["multiplier", "note"];
const PEAK_MAX_MULTIPLIER = 100;
const PEAK_MAX_NOTE = 32;

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > allowed.length) return false;
  for (const key of keys) if (!allowed.includes(key)) return false;
  for (const key of required) if (!Object.hasOwn(value, key)) return false;
  return true;
}

function isPriceParts(value: Record<string, unknown>): boolean {
  for (const key of PRICE_PARTS) if (!isUnit(value[key])) return false;
  return true;
}

function isTier(value: unknown): value is CatalogPriceTier {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  if (!hasExactKeys(t, TIER_KEYS, TIER_KEYS)) return false;
  // `above` is a token count: a whole number, and the base price already covers 0.
  if (!Number.isInteger(t.above) || (t.above as number) <= 0) return false;
  return isPriceParts(t);
}

/** Ascending, unique thresholds: the tier that applies is the last one below. */
function isTierList(value: unknown): value is CatalogPriceTier[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CATALOG_MAX_TIERS) return false;
  let previous = 0;
  for (const tier of value) {
    if (!isTier(tier)) return false;
    if (tier.above <= previous) return false;
    previous = tier.above;
  }
  return true;
}

function isPeak(value: unknown): value is CatalogPeak {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (!hasExactKeys(p, PEAK_KEYS, ["multiplier"])) return false;
  const multiplier = p.multiplier;
  // 1x is not a peak: a price that never moves is the plain four-number form.
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 1 || multiplier > PEAK_MAX_MULTIPLIER) {
    return false;
  }
  if (p.note === undefined) return true;
  return typeof p.note === "string" && p.note.length > 0 && p.note.length <= PEAK_MAX_NOTE;
}

/**
 * `/1` carries exactly four numbers per model; `/2` adds the two optional
 * shapes. Anything else is rejected, because a reader that silently ignored a
 * field would compute a different price than the one the signer published.
 */
export function isCatalogPrice(value: unknown, schema: CatalogSchema = CATALOG_SCHEMA_V2): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (schema === CATALOG_SCHEMA_V1) {
    if (!hasExactKeys(p, PRICE_PARTS, PRICE_PARTS)) return false;
    return isPriceParts(p);
  }
  if (!hasExactKeys(p, [...PRICE_PARTS, "tiers", "peak"], PRICE_PARTS)) return false;
  if (!isPriceParts(p)) return false;
  if (p.tiers !== undefined && !isTierList(p.tiers)) return false;
  if (p.peak !== undefined && !isPeak(p.peak)) return false;
  return true;
}

/** A deep copy, so nothing later mutates a signed document. */
export function copyCatalogPrice(price: CatalogPrice): CatalogPrice {
  const out: CatalogPrice = { in: price.in, out: price.out, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite };
  if (price.tiers) out.tiers = price.tiers.map((tier) => ({ ...tier }));
  if (price.peak) out.peak = { ...price.peak };
  return out;
}

/** `/2` exists for tiers and peaks; a document that has neither stays on `/1`. */
export function schemaForModels(models: readonly CatalogModel[]): CatalogSchema {
  return models.some((model) => model.price.tiers !== undefined || model.price.peak !== undefined)
    ? CATALOG_SCHEMA_V2
    : CATALOG_SCHEMA_V1;
}

export function isCatalogModel(value: unknown, schema: CatalogSchema = CATALOG_SCHEMA_V2): value is CatalogModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (Object.keys(m).length !== 2 || !Object.hasOwn(m, "id") || !Object.hasOwn(m, "price")) return false;
  const id = m.id;
  if (typeof id !== "string" || id.trim().length === 0 || id.length > CATALOG_MAX_MODEL_ID) return false;
  return isCatalogPrice(m.price, schema);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TS_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** ISO-8601 UTC, seconds precision. */
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
    if (!isCatalogModel(value, CATALOG_SCHEMA_V2)) {
      logger.warn("catalogue: dropping a model with a missing id or an unpublishable price");
      continue;
    }
    out.push({ id: value.id, price: copyCatalogPrice(value.price) });
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
  const models = sanitizeCatalogModels(input.models);
  return {
    schema: schemaForModels(models),
    address: input.address,
    hostname: input.hostname,
    controlPort: input.controlPort,
    gatewayPort: input.gatewayPort,
    models,
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

  if (o.schema !== CATALOG_SCHEMA_V1 && o.schema !== CATALOG_SCHEMA_V2) {
    return reject(`schema is not ${CATALOG_SCHEMA_V1} or ${CATALOG_SCHEMA_V2}`);
  }
  const schema: CatalogSchema = o.schema;
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
    if (!isCatalogModel(value, schema)) return reject("a model has an invalid id or price");
    models.push({ id: value.id, price: copyCatalogPrice(value.price) });
  }
  if (models.length === 0 && o.gatewayPort !== null) return reject("gatewayPort must be null when no model is shared");
  if (models.length > 0 && o.gatewayPort === null) return reject("gatewayPort is null while models are shared");

  const body: CatalogBody = {
    schema,
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
 * Holds the signed document in memory.
 *
 * A failed re-sign is recorded in `detail` (visible through `status`) and the
 * previous document is kept; nothing here binds a socket.
 */
export class CatalogService {
  private wallet: Wallet;
  private hostname: string;
  private readonly controlPort: number;
  private readonly gatewayPort: number;
  private doc: CatalogDocument | null = null;
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

  /** Why the last re-sign failed, or null. The listener owns bind failures. */
  get detail(): string | null {
    return this.refreshDetail;
  }

  /**
   * Why the last refresh could not re-sign (Magpie unreadable). A successful
   * refresh clears it.
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
}
