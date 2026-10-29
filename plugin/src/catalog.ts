// The read-only peer catalogue: a tiny, opt-in HTTP document a sharing node
// publishes, and the local client that reads peers' documents through
// EasyTier's own SOCKS5 listener.
//
// It is deliberately NOT a gateway, NOT a management API and NOT a directory
// server. There is one GET endpoint, one small JSON body, no write path, no
// AI request, no key and no access to Magpie's admin surface. The overlay's
// Forward ACL must explicitly allow the catalogue port; the virtual-IP Inbound
// chain stays Drop with no rules, so the virtual-IP/loopback rewrite cannot
// reach it.
//
// The quote is self-signed with a persisted Ed25519 key (TOFU on the reader).
// A signature proves only that the same key signed the document; it is not a
// proof of a real-world identity.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { statePath } from "./paths.ts";
import { logger, registerSecret } from "./log.ts";
import { readJsonWithBackup, writeJsonAtomic } from "./store.ts";

export const CATALOG_SCHEMA = "ohmyaihub.catalog/v1";
/** The one path the catalogue server answers. Anything else is a 404. */
export const CATALOG_PATH = "/catalog/v1";
export const CATALOG_MAX_BYTES = 64 * 1024;
export const CATALOG_MAX_MODELS = 200;
export const CATALOG_MAX_CONCURRENT = 8;

export interface CatalogPriceTier {
  above: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

/** USD per million tokens, exactly the unit Magpie's own prices use. */
export interface CatalogPrice {
  unit: "USD per 1M tokens";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  tiers?: CatalogPriceTier[];
  source: "magpie-gateway" | "magpie-settings";
}

export interface CatalogModel {
  id: string;
  displayName: string | null;
  /** the API paths the gateway accepts for this model (it translates where needed) */
  gatewayApis: string[];
  /** the paths Magpie would relay natively, when its local list can be read */
  nativeApis: string[] | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  images: boolean | null;
  modalities: { input?: string[]; output?: string[] } | null;
  reasoningLevels: string[] | null;
  pricing: CatalogPrice | null;
  capabilitiesSource: "magpie-gateway" | "magpie-settings" | "configured-endpoints";
}

export interface CatalogIdentitySummary {
  algorithm: "ed25519";
  publicKey: string;
  fingerprint: string;
  keyId: string;
  createdAt: string;
}

export interface CatalogQuoteBody {
  schema: typeof CATALOG_SCHEMA;
  node: {
    id: string;
    displayName: string;
    hostname: string;
    virtualIpv4: string;
    mappedCidr: string;
    gatewayPort: number;
    catalogPort: number;
    contact: string | null;
  };
  publication: {
    status: "published";
    version: number;
    updatedAt: string;
    publishedAt: string;
    note: string;
  };
  models: CatalogModel[];
  topUp: {
    minUsd: number;
    simulated: true;
    note: string;
  };
  /** The quote is display data; it is not an invoice and never charges. */
  billing: {
    quoteOnly: true;
    charged: false;
    note: string;
  };
  identity: CatalogIdentitySummary;
}

export interface SignedCatalog extends CatalogQuoteBody {
  signature: string;
}

export interface VerifiedCatalog {
  quote: CatalogQuoteBody;
  signature: string;
  /** SHA-256 of the canonical unsigned body; a stable handle for a quote */
  contentHash: string;
  fingerprint: string;
}

// --- canonical JSON and Ed25519 ---------------------------------------------

/** Deterministic JSON: object keys sorted, arrays in order, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return "null";
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Raw Ed25519 public key -> the DER SPKI Node accepts. */
function spkiFromRaw(raw: Buffer) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

export function fingerprintOf(publicKey: string): string {
  return sha256Hex(Buffer.from(publicKey, "base64"));
}

export function keyIdOf(publicKey: string): string {
  return fingerprintOf(publicKey).slice(0, 16);
}

interface IdentityFile {
  version: 1;
  algorithm: "ed25519";
  privateKeyPem: string;
  publicKey: string;
  fingerprint: string;
  keyId: string;
  createdAt: string;
}

export interface CatalogIdentity {
  summary: CatalogIdentitySummary;
  privateKeyPem: string;
}

export function identityFile(): string {
  return statePath("catalog-identity.json");
}

/**
 * The persisted signing identity. A missing or corrupt file creates a new key;
 * that is a new fingerprint, which readers will warn about (never silently
 * accept). The private key is 0600 and never leaves this file.
 */
export function loadOrCreateCatalogIdentity(): CatalogIdentity {
  const { value } = readJsonWithBackup<IdentityFile>(identityFile());
  if (value && value.algorithm === "ed25519" && value.privateKeyPem && value.publicKey) {
    try {
      const raw = Buffer.from(value.publicKey, "base64");
      const fingerprint = fingerprintOf(value.publicKey);
      const keyId = keyIdOf(value.publicKey);
      // Prove the stored pair really matches before trusting it for a signature.
      const probe = sign(null, Buffer.from("ohmyaihub-identity-check"), createPrivateKey(value.privateKeyPem));
      if (verify(null, Buffer.from("ohmyaihub-identity-check"), spkiFromRaw(raw), probe)) {
        registerSecret(value.privateKeyPem);
        return {
          summary: {
            algorithm: "ed25519",
            publicKey: value.publicKey,
            fingerprint,
            keyId,
            createdAt: value.createdAt || new Date().toISOString(),
          },
          privateKeyPem: value.privateKeyPem,
        };
      }
    } catch {
      /* regenerate below */
    }
    logger.warn("the stored catalogue identity is unusable; generating a new Ed25519 key");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("Ed25519 public key export failed");
  const raw = Buffer.from(jwk.x, "base64url");
  const pub = raw.toString("base64");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const file: IdentityFile = {
    version: 1,
    algorithm: "ed25519",
    privateKeyPem,
    publicKey: pub,
    fingerprint: fingerprintOf(pub),
    keyId: keyIdOf(pub),
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(identityFile(), file);
  registerSecret(privateKeyPem);
  logger.info(`generated a catalogue signing identity (fingerprint ${file.fingerprint})`);
  return {
    summary: {
      algorithm: "ed25519",
      publicKey: pub,
      fingerprint: file.fingerprint,
      keyId: file.keyId,
      createdAt: file.createdAt,
    },
    privateKeyPem,
  };
}

/** Signs the canonical unsigned body (including the identity block). */
export function signCatalog(body: Omit<CatalogQuoteBody, "identity"> & { identity: CatalogIdentitySummary }, identity: CatalogIdentity): SignedCatalog {
  const signature = sign(null, Buffer.from(canonicalJson(body)), createPrivateKey(identity.privateKeyPem)).toString("base64");
  return { ...body, signature };
}

/** A node id is the persisted 8-64 hex id; reserved object keys can never match. */
export const NODE_ID_RE = /^[a-f0-9]{8,64}$/;
const HOSTNAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const KEY_ID_RE = /^[a-f0-9]{16}$/;
const API_NAMES = new Set(["chat", "responses", "anthropic"]);
const MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);
const CAPABILITY_SOURCES = new Set(["magpie-gateway", "magpie-settings", "configured-endpoints"]);
const PRICE_SOURCES = new Set(["magpie-gateway", "magpie-settings"]);
const MAX_MONEY = 1_000_000;
const MAX_TOKENS = 10_000_000;
const MAX_NOTE = 300;
const MAX_DISPLAY = 128;

export function isValidNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID_RE.test(value);
}

export function isValidOverlayHostname(value: unknown, nodeId?: string): value is string {
  if (typeof value !== "string" || value.length > 72 || !HOSTNAME_RE.test(value)) return false;
  return nodeId ? value.endsWith(`-${nodeId}`) : true;
}

export function isValidModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && MODEL_ID_RE.test(value);
}

export function isValidMappedCidr(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 18) return false;
  const m = /^10\.66\.(\d{1,3})\.(\d{1,3})\/32$/.exec(value);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a >= 1 && a <= 254 && b >= 1 && b <= 254;
}

type JsonObject = Record<string, unknown>;

function objectOf(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as JsonObject;
}

function assertKeys(value: JsonObject, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} has an unexpected field ${JSON.stringify(key)}`);
  }
}

function stringOf(value: unknown, where: string, min: number, max: number, pattern?: RegExp): string {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  if (value.length < min || value.length > max) throw new Error(`${where} must be ${min}-${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${where} contains a control character`);
  if (pattern && !pattern.test(value)) throw new Error(`${where} has an invalid format`);
  return value;
}

function nullableString(value: unknown, where: string, max: number): string | null {
  if (value === null) return null;
  return stringOf(value, where, 0, max);
}

function boolOf(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${where} must be a boolean`);
  return value;
}

function intOf(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${where} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function moneyOf(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MONEY) {
    throw new Error(`${where} must be a finite USD amount from 0 to ${MAX_MONEY}`);
  }
  return value;
}

function timestampOf(value: unknown, where: string): string {
  const s = stringOf(value, where, 20, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    throw new Error(`${where} must be an ISO-8601 timestamp`);
  }
  if (!Number.isFinite(Date.parse(s))) throw new Error(`${where} is not a valid time`);
  const year = Number(s.slice(0, 4));
  if (year < 2000 || year > 2100) throw new Error(`${where} is outside 2000-2100`);
  return s;
}

function apiList(value: unknown, where: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > 3 || (!allowEmpty && value.length === 0)) {
    throw new Error(`${where} must be an array of at most 3 API names`);
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !API_NAMES.has(v)) throw new Error(`${where} has an unknown API ${JSON.stringify(v)}`);
    if (out.includes(v)) throw new Error(`${where} repeats ${v}`);
    out.push(v);
  }
  return out;
}

function modalityList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error(`${where} must be an array of at most 8 modalities`);
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !MODALITIES.has(v)) throw new Error(`${where} has an unknown modality ${JSON.stringify(v)}`);
    if (out.includes(v)) throw new Error(`${where} repeats ${v}`);
    out.push(v);
  }
  return out;
}

function validateIdentity(value: unknown): CatalogIdentitySummary {
  const ident = objectOf(value, "identity");
  assertKeys(ident, ["algorithm", "publicKey", "fingerprint", "keyId", "createdAt"], "identity");
  if (ident.algorithm !== "ed25519") throw new Error("identity.algorithm must be ed25519");
  const publicKey = stringOf(ident.publicKey, "identity.publicKey", 43, 44, /^[A-Za-z0-9+/]+={0,2}$/);
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32) throw new Error("identity.publicKey must be a 32-byte Ed25519 key");
  const fingerprint = stringOf(ident.fingerprint, "identity.fingerprint", 64, 64, FINGERPRINT_RE);
  const keyId = stringOf(ident.keyId, "identity.keyId", 16, 16, KEY_ID_RE);
  if (fingerprint !== fingerprintOf(publicKey)) throw new Error("identity.fingerprint does not match its key");
  if (keyId !== keyIdOf(publicKey)) throw new Error("identity.keyId does not match its key");
  return { algorithm: "ed25519", publicKey, fingerprint, keyId, createdAt: timestampOf(ident.createdAt, "identity.createdAt") };
}

function validatePrice(value: unknown): CatalogPrice {
  const p = objectOf(value, "model.pricing");
  assertKeys(p, ["unit", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "tiers", "source"], "model.pricing");
  if (p.unit !== "USD per 1M tokens") throw new Error("model.pricing.unit is not USD per 1M tokens");
  const out: CatalogPrice = {
    unit: "USD per 1M tokens",
    input: moneyOf(p.input, "model.pricing.input"),
    output: moneyOf(p.output, "model.pricing.output"),
    cacheRead: moneyOf(p.cacheRead, "model.pricing.cacheRead"),
    cacheWrite: moneyOf(p.cacheWrite, "model.pricing.cacheWrite"),
    source: PRICE_SOURCES.has(String(p.source)) ? (p.source as CatalogPrice["source"]) : (() => { throw new Error("model.pricing.source is invalid"); })(),
  };
  if (p.cacheWrite1h !== undefined) out.cacheWrite1h = moneyOf(p.cacheWrite1h, "model.pricing.cacheWrite1h");
  if (p.tiers !== undefined) {
    if (!Array.isArray(p.tiers) || p.tiers.length > 10) throw new Error("model.pricing.tiers must have at most 10 entries");
    const tiers: CatalogPriceTier[] = [];
    let lastAbove = 0;
    for (const [i, raw] of p.tiers.entries()) {
      const t = objectOf(raw, `model.pricing.tiers[${i}]`);
      assertKeys(t, ["above", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"], `model.pricing.tiers[${i}]`);
      const above = intOf(t.above, `model.pricing.tiers[${i}].above`, 1, MAX_TOKENS);
      if (above <= lastAbove) throw new Error("model.pricing.tiers must be strictly increasing");
      lastAbove = above;
      const tier: CatalogPriceTier = {
        above,
        input: moneyOf(t.input, `model.pricing.tiers[${i}].input`),
        output: moneyOf(t.output, `model.pricing.tiers[${i}].output`),
        cacheRead: moneyOf(t.cacheRead, `model.pricing.tiers[${i}].cacheRead`),
        cacheWrite: moneyOf(t.cacheWrite, `model.pricing.tiers[${i}].cacheWrite`),
      };
      if (t.cacheWrite1h !== undefined) tier.cacheWrite1h = moneyOf(t.cacheWrite1h, `model.pricing.tiers[${i}].cacheWrite1h`);
      tiers.push(tier);
    }
    if (tiers.length) out.tiers = tiers;
  }
  return out;
}

function validateModel(value: unknown, index: number): CatalogModel {
  const where = `models[${index}]`;
  const m = objectOf(value, where);
  assertKeys(
    m,
    ["id", "displayName", "gatewayApis", "nativeApis", "contextWindow", "maxOutputTokens", "images", "modalities", "reasoningLevels", "pricing", "capabilitiesSource"],
    where,
  );
  const id = stringOf(m.id, `${where}.id`, 3, 200);
  if (!isValidModelId(id)) throw new Error(`${where}.id is not a safe provider/model id`);
  const displayName = m.displayName === null ? null : stringOf(m.displayName, `${where}.displayName`, 1, MAX_DISPLAY);
  const gatewayApis = apiList(m.gatewayApis, `${where}.gatewayApis`, false);
  const nativeApis = m.nativeApis === null ? null : apiList(m.nativeApis, `${where}.nativeApis`, true);
  const contextWindow = m.contextWindow === null ? null : intOf(m.contextWindow, `${where}.contextWindow`, 0, MAX_TOKENS);
  const maxOutputTokens = m.maxOutputTokens === null ? null : intOf(m.maxOutputTokens, `${where}.maxOutputTokens`, 0, MAX_TOKENS);
  const images = m.images === null ? null : boolOf(m.images, `${where}.images`);
  let modalities: { input?: string[]; output?: string[] } | null = null;
  if (m.modalities !== null) {
    const mod = objectOf(m.modalities, `${where}.modalities`);
    assertKeys(mod, ["input", "output"], `${where}.modalities`);
    modalities = {};
    if (mod.input !== undefined) modalities.input = modalityList(mod.input, `${where}.modalities.input`);
    if (mod.output !== undefined) modalities.output = modalityList(mod.output, `${where}.modalities.output`);
  }
  let reasoningLevels: string[] | null = null;
  if (m.reasoningLevels !== null) {
    if (!Array.isArray(m.reasoningLevels) || m.reasoningLevels.length > 20) throw new Error(`${where}.reasoningLevels must have at most 20 entries`);
    reasoningLevels = m.reasoningLevels.map((v) => stringOf(v, `${where}.reasoningLevels`, 1, 24, /^[a-z0-9_-]+$/));
    if (new Set(reasoningLevels).size !== reasoningLevels.length) throw new Error(`${where}.reasoningLevels repeats a level`);
  }
  const pricing = m.pricing === null ? null : validatePrice(m.pricing);
  if (typeof m.capabilitiesSource !== "string" || !CAPABILITY_SOURCES.has(m.capabilitiesSource)) {
    throw new Error(`${where}.capabilitiesSource is invalid`);
  }
  return {
    id,
    displayName,
    gatewayApis,
    nativeApis,
    contextWindow,
    maxOutputTokens,
    images,
    modalities,
    reasoningLevels,
    pricing,
    capabilitiesSource: m.capabilitiesSource as CatalogModel["capabilitiesSource"],
  };
}

/** Strict runtime validation of the unsigned quote body. */
export function validateCatalogQuote(value: unknown): CatalogQuoteBody {
  const doc = objectOf(value, "catalogue");
  assertKeys(doc, ["schema", "node", "publication", "models", "topUp", "billing", "identity"], "catalogue");
  if (doc.schema !== CATALOG_SCHEMA) throw new Error(`unsupported catalogue schema ${JSON.stringify(doc.schema)}`);
  const node = objectOf(doc.node, "node");
  assertKeys(node, ["id", "displayName", "hostname", "virtualIpv4", "mappedCidr", "gatewayPort", "catalogPort", "contact"], "node");
  const id = stringOf(node.id, "node.id", 8, 64);
  if (!isValidNodeId(id)) throw new Error("node.id must be 8-64 lowercase hex characters");
  const hostname = stringOf(node.hostname, "node.hostname", 3, 72);
  if (!isValidOverlayHostname(hostname, id)) throw new Error("node.hostname does not belong to node.id");
  const displayName = stringOf(node.displayName, "node.displayName", 1, 64);
  const virtualIpv4 = stringOf(node.virtualIpv4, "node.virtualIpv4", 7, 15);
  const v4 = /^10\.77\.0\.(\d{1,3})$/.exec(virtualIpv4);
  if (!v4 || Number(v4[1]) < 2 || Number(v4[1]) > 254) {
    throw new Error("node.virtualIpv4 must be a host in 10.77.0.0/24");
  }
  const mappedCidr = stringOf(node.mappedCidr, "node.mappedCidr", 9, 18);
  if (!isValidMappedCidr(mappedCidr)) throw new Error("node.mappedCidr must be 10.66.a.b/32 with a,b in 1-254");
  const gatewayPort = intOf(node.gatewayPort, "node.gatewayPort", 1, 65535);
  const catalogPort = intOf(node.catalogPort, "node.catalogPort", 1024, 65535);
  if (gatewayPort === catalogPort) throw new Error("node.gatewayPort and node.catalogPort must differ");
  const contact = nullableString(node.contact, "node.contact", 120);

  const pub = objectOf(doc.publication, "publication");
  assertKeys(pub, ["status", "version", "updatedAt", "publishedAt", "note"], "publication");
  if (pub.status !== "published") throw new Error("publication.status must be published");
  const version = intOf(pub.version, "publication.version", 1, 2_147_483_647);
  const updatedAt = timestampOf(pub.updatedAt, "publication.updatedAt");
  const publishedAt = timestampOf(pub.publishedAt, "publication.publishedAt");
  if (Date.parse(publishedAt) > Date.parse(updatedAt)) throw new Error("publication.publishedAt is after updatedAt");
  const pubNote = stringOf(pub.note, "publication.note", 1, MAX_NOTE);

  if (!Array.isArray(doc.models) || doc.models.length > CATALOG_MAX_MODELS) {
    throw new Error(`catalogue models must be an array of at most ${CATALOG_MAX_MODELS}`);
  }
  const models = doc.models.map((m, i) => validateModel(m, i));
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`catalogue repeats model ${model.id}`);
    ids.add(model.id);
  }

  const topUp = objectOf(doc.topUp, "topUp");
  assertKeys(topUp, ["minUsd", "simulated", "note"], "topUp");
  const minUsd = moneyOf(topUp.minUsd, "topUp.minUsd");
  if (minUsd < 0.0001) throw new Error("topUp.minUsd must be at least 0.0001");
  if (topUp.simulated !== true) throw new Error("topUp.simulated must be true");
  const topUpNote = stringOf(topUp.note, "topUp.note", 1, MAX_NOTE);

  const billing = objectOf(doc.billing, "billing");
  assertKeys(billing, ["quoteOnly", "charged", "note"], "billing");
  if (billing.quoteOnly !== true) throw new Error("billing.quoteOnly must be true");
  if (billing.charged !== false) throw new Error("billing.charged must be false");
  const billingNote = stringOf(billing.note, "billing.note", 1, MAX_NOTE);

  const identity = validateIdentity(doc.identity);
  return {
    schema: CATALOG_SCHEMA,
    node: { id, displayName, hostname, virtualIpv4, mappedCidr, gatewayPort, catalogPort, contact },
    publication: { status: "published", version, updatedAt, publishedAt, note: pubNote },
    models,
    topUp: { minUsd, simulated: true, note: topUpNote },
    billing: { quoteOnly: true, charged: false, note: billingNote },
    identity,
  };
}

/**
 * Verifies a catalogue document and then validates every field. A signature
 * alone is not enough: a peer controls its own content. The returned quote is a
 * freshly built, strictly typed object; unknown fields and malformed values are
 * refused.
 */
export function verifySignedCatalog(value: unknown): VerifiedCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalogue is not an object");
  const doc = value as Record<string, unknown>;
  // The schema is checked before the signature only to give a clear error; the
  // signature still covers it, and validateCatalogQuote checks it again.
  if (doc.schema !== CATALOG_SCHEMA) throw new Error(`unsupported catalogue schema ${String(doc.schema)}`);
  if (typeof doc.signature !== "string" || doc.signature.length > 128) throw new Error("catalogue has no valid signature");
  const signature = Buffer.from(doc.signature, "base64");
  if (signature.length !== 64) throw new Error("catalogue signature is not a 64-byte Ed25519 signature");

  // Validate the identity before using its key. This also proves fingerprint and
  // key id are derived, not merely claims attached to the document.
  const identity = validateIdentity(doc.identity);
  const unsigned = { ...doc } as Record<string, unknown>;
  delete unsigned.signature;
  const canonical = canonicalJson(unsigned);
  if (Buffer.byteLength(canonical) > CATALOG_MAX_BYTES) throw new Error("catalogue exceeds the 64 KiB limit");
  const raw = Buffer.from(identity.publicKey, "base64");
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonical), spkiFromRaw(raw), signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("catalogue signature does not match its content");
  const quote = validateCatalogQuote(unsigned);
  return { quote, signature: doc.signature, contentHash: sha256Hex(canonical), fingerprint: identity.fingerprint };
}

// --- trust (TOFU) ------------------------------------------------------------

export interface CatalogTrustRecord {
  nodeId: string;
  overlayHostname: string;
  publicKey: string;
  fingerprint: string;
  keyId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  quoteVersion: number;
  /** hash of the last accepted quote at that version (absent in older files) */
  quoteHash?: string | null;
  /** the key the reader has actually accepted (first seen, or explicitly trusted) */
  accepted: boolean;
  /** a different key was seen: warned about until an operator accepts it */
  pending: { publicKey: string; fingerprint: string; keyId: string; hostname: string; seenAt: string } | null;
}

interface TrustFile {
  version: 1;
  peers: Record<string, CatalogTrustRecord>;
}

export function trustFile(): string {
  return statePath("catalog-trust.json");
}

export function catalogFilesExist(): boolean {
  return existsSync(identityFile());
}

function trustKey(value: unknown): { publicKey: string; fingerprint: string; keyId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.publicKey !== "string" || typeof v.fingerprint !== "string" || typeof v.keyId !== "string") return null;
  try {
    const raw = Buffer.from(v.publicKey, "base64");
    if (raw.length !== 32 || fingerprintOf(v.publicKey) !== v.fingerprint || keyIdOf(v.publicKey) !== v.keyId) return null;
    return { publicKey: v.publicKey, fingerprint: v.fingerprint, keyId: v.keyId };
  } catch {
    return null;
  }
}

/** Strictly validates one trust record; anything malformed is ignored (fail closed). */
function trustRecord(value: unknown, nodeId: string): CatalogTrustRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  try {
    assertKeys(r, ["nodeId", "overlayHostname", "publicKey", "fingerprint", "keyId", "firstSeenAt", "lastSeenAt", "quoteVersion", "quoteHash", "accepted", "pending"], "trust record");
  } catch {
    return null;
  }
  if (r.nodeId !== nodeId || !isValidNodeId(nodeId)) return null;
  if (typeof r.overlayHostname !== "string" || !isValidOverlayHostname(r.overlayHostname, nodeId)) return null;
  const key = trustKey(r);
  if (!key) return null;
  let firstSeenAt: string;
  let lastSeenAt: string;
  try {
    firstSeenAt = timestampOf(r.firstSeenAt, "trust.firstSeenAt");
    lastSeenAt = timestampOf(r.lastSeenAt, "trust.lastSeenAt");
  } catch {
    return null;
  }
  const quoteVersion = r.quoteVersion === undefined ? 0 : Number(r.quoteVersion);
  if (!Number.isInteger(quoteVersion) || quoteVersion < 0 || quoteVersion > 2_147_483_647) return null;
  let quoteHash: string | null = null;
  if (r.quoteHash !== undefined && r.quoteHash !== null) {
    if (typeof r.quoteHash !== "string" || !FINGERPRINT_RE.test(r.quoteHash)) return null;
    quoteHash = r.quoteHash;
  }
  // An older file may predate "accepted": absence must mean "not accepted",
  // never automatic trust. A missing pending is simply no pending change.
  const accepted = r.accepted === undefined ? false : r.accepted;
  if (typeof accepted !== "boolean") return null;
  let pending: CatalogTrustRecord["pending"] = null;
  if (r.pending !== undefined && r.pending !== null) {
    const p = r.pending;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const po = p as Record<string, unknown>;
    try {
      assertKeys(po, ["publicKey", "fingerprint", "keyId", "hostname", "seenAt"], "trust pending");
    } catch {
      return null;
    }
    const pendingKey = trustKey(po);
    if (!pendingKey) return null;
    if (typeof po.hostname !== "string" || !isValidOverlayHostname(po.hostname, nodeId)) return null;
    let seenAt: string;
    try {
      seenAt = timestampOf(po.seenAt, "trust.pending.seenAt");
    } catch {
      return null;
    }
    pending = { ...pendingKey, hostname: po.hostname, seenAt };
  }
  return {
    nodeId,
    overlayHostname: r.overlayHostname,
    ...key,
    firstSeenAt,
    lastSeenAt,
    quoteVersion,
    quoteHash,
    accepted,
    pending,
  };
}

/**
 * Loads trust into a null-prototype map. A corrupt file or an invalid record is
 * skipped rather than trusted; a file with a different version is ignored.
 */
export function loadCatalogTrust(): Record<string, CatalogTrustRecord> {
  const out: Record<string, CatalogTrustRecord> = Object.create(null) as Record<string, CatalogTrustRecord>;
  const { value } = readJsonWithBackup<TrustFile>(trustFile());
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  if (value.version !== undefined && value.version !== 1) return out;
  const peers = value.peers;
  if (!peers || typeof peers !== "object" || Array.isArray(peers)) return out;
  for (const nodeId of Object.keys(peers)) {
    const rec = trustRecord((peers as Record<string, unknown>)[nodeId], nodeId);
    if (rec) out[nodeId] = rec;
  }
  return out;
}

/** Writes only strictly valid, non-reserved node ids; never mutates a prototype. */
export function saveCatalogTrust(peers: Record<string, CatalogTrustRecord>): void {
  const out: Record<string, CatalogTrustRecord> = Object.create(null) as Record<string, CatalogTrustRecord>;
  for (const nodeId of Object.keys(peers)) {
    if (!isValidNodeId(nodeId)) continue;
    const rec = trustRecord(peers[nodeId], nodeId);
    if (rec) out[nodeId] = rec;
  }
  writeJsonAtomic(trustFile(), { version: 1, peers: out });
}

// --- publication version -----------------------------------------------------

interface PublishFile {
  version: 1;
  publishedAt: string | null;
  versionNumber: number;
  updatedAt: string | null;
  contentHash: string | null;
}

function publishFile(): string {
  return statePath("catalog-publish.json");
}

export function loadPublishState(): PublishFile {
  const { value } = readJsonWithBackup<PublishFile>(publishFile());
  return {
    version: 1,
    publishedAt: value?.publishedAt ?? null,
    versionNumber: Number.isInteger(value?.versionNumber) ? Number(value?.versionNumber) : 0,
    updatedAt: value?.updatedAt ?? null,
    contentHash: value?.contentHash ?? null,
  };
}

export function savePublishState(s: PublishFile): void {
  writeJsonAtomic(publishFile(), s);
}

// --- small HTTP client through EasyTier's SOCKS5 -----------------------------

export interface SocksHttpGetOptions {
  socksPort: number;
  host: string;
  port: number;
  path: string;
  timeoutMs?: number;
  maxBytes?: number;
}

function ipv4Bytes(host: string): Buffer {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`the catalogue client only dials IPv4 addresses, not ${host}`);
  }
  return Buffer.from(parts);
}

/** Reads exact protocol fields from a socket without losing coalesced bytes. */
class SocketReader {
  private buf = Buffer.alloc(0);
  constructor(private it: AsyncIterator<Buffer>) {}

  async read(n: number, what: string): Promise<Buffer> {
    while (this.buf.length < n) {
      const { value, done } = await this.it.next();
      if (done || !value) throw new Error(`SOCKS5 peer closed while reading ${what}`);
      this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : Buffer.from(value);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async rest(max: number): Promise<Buffer> {
    const parts = this.buf.length ? [this.buf] : [];
    let total = this.buf.length;
    for (;;) {
      const { value, done } = await this.it.next();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > max) throw new Error(`catalogue response exceeds ${max} bytes`);
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }
}

/**
 * One HTTP GET through the local EasyTier SOCKS5 listener.
 *
 * This is the on-demand path: it creates no EasyTier port forward and no
 * listener of its own, so a directory refresh cannot leak a port that 2.6.4
 * cannot close. The proxy is bound to 127.0.0.1 by the generated TOML.
 */
export async function socksHttpGet(opts: SocksHttpGetOptions): Promise<{ status: number; body: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? CATALOG_MAX_BYTES;
  const host = ipv4Bytes(opts.host);
  const port = Buffer.from([(opts.port >> 8) & 255, opts.port & 255]);
  const socket: Socket = connect({ host: "127.0.0.1", port: opts.socksPort });
  socket.setNoDelay(true);
  const timer = setTimeout(() => socket.destroy(new Error(`catalogue read timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.removeAllListeners("error");
    const it = (socket as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    const reader = new SocketReader(it);

    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const hello = await reader.read(2, "the SOCKS5 greeting");
    if (hello[0] !== 0x05 || hello[1] !== 0x00) throw new Error("the EasyTier SOCKS5 listener refused no-auth");

    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), host, port]));
    const replyHead = await reader.read(4, "the SOCKS5 connect reply");
    if (replyHead[0] !== 0x05 || replyHead[1] !== 0x00) {
      throw new Error(`SOCKS5 connect failed with code ${replyHead[1]}`);
    }
    const atyp = replyHead[3];
    const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await reader.read(1, "the SOCKS5 name length"))[0] : 0;
    if (!addrLen) throw new Error("SOCKS5 connect reply has an unknown address type");
    await reader.read(addrLen + 2, "the SOCKS5 bound address");

    const req =
      `GET ${opts.path} HTTP/1.1\r\n` +
      `Host: ${opts.host}:${opts.port}\r\n` +
      `Accept: application/json\r\n` +
      `User-Agent: ohmyaihub-catalog/1\r\n` +
      `Connection: close\r\n\r\n`;
    socket.write(req);

    const chunks = await reader.rest(maxBytes + 8192);
    const raw = chunks.toString("utf8");
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) throw new Error("catalogue response has no HTTP header");
    const header = raw.slice(0, split).split("\r\n");
    const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(header[0] ?? "")?.[1] ?? 0);
    const body = raw.slice(split + 4);
    if (Buffer.byteLength(body) > maxBytes) throw new Error(`catalogue response exceeds ${maxBytes} bytes`);
    return { status, body };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

// --- catalogue server --------------------------------------------------------

export interface CatalogServerOptions {
  hostname: string;
  port: number;
  /** the signed document, or null while the host cannot publish one */
  document: () => SignedCatalog | null;
  maxBytes?: number;
  maxConcurrent?: number;
}

export interface CatalogServerHandle {
  port: number;
  stop: () => void;
}

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * The read-only catalogue endpoint. It binds one interface (the provider's LAN
 * address), exposes one GET path, caps body size/concurrency/rate and has no
 * reference to the host API, Magpie's admin API or any write path.
 */
export class CatalogServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private buckets = new Map<string, Bucket>();
  private active = 0;
  private lastCleanup = 0;

  constructor(private opts: CatalogServerOptions) {}

  start(): CatalogServerHandle {
    if (this.server) return { port: this.opts.port, stop: () => this.stop() };
    const maxBytes = this.opts.maxBytes ?? CATALOG_MAX_BYTES;
    const maxConcurrent = this.opts.maxConcurrent ?? CATALOG_MAX_CONCURRENT;
    this.server = Bun.serve({
      hostname: this.opts.hostname,
      port: this.opts.port,
      idleTimeout: 5,
      fetch: (req) => {
        const url = new URL(req.url);
        if (req.method !== "GET") return text(405, "method not allowed");
        if (url.pathname !== CATALOG_PATH || url.search) return text(404, "not found");
        const source = this.sourceOf(req);
        if (!this.allow(source)) return text(429, "too many requests");
        if (this.active >= maxConcurrent) return text(503, "busy");
        this.active += 1;
        try {
          const doc = this.opts.document();
          if (!doc) return text(503, "catalogue is not published");
          const body = JSON.stringify(doc);
          if (Buffer.byteLength(body) > maxBytes) {
            logger.error(`catalogue document is ${Buffer.byteLength(body)} bytes, over the ${maxBytes} limit; refusing to publish it`);
            return text(503, "catalogue is too large");
          }
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(Buffer.byteLength(body)),
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
              "content-security-policy": "default-src 'none'",
            },
          });
        } finally {
          this.active -= 1;
        }
      },
    });
    logger.info(`read-only catalogue listening on ${this.opts.hostname}:${this.opts.port}${CATALOG_PATH}`);
    return { port: this.opts.port, stop: () => this.stop() };
  }

  stop(): void {
    if (!this.server) return;
    this.server.stop(true);
    this.server = null;
    this.buckets.clear();
    logger.info("read-only catalogue stopped");
  }

  get running(): boolean {
    return this.server !== null;
  }

  private sourceOf(req: Request): string {
    // Bun's requestIP is authoritative; the extra field keeps a test/fake sane.
    const fromBun = (this.server as unknown as { requestIP?: (r: Request) => { address?: string } | null } | null)?.requestIP?.(req);
    return fromBun?.address ?? (req as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";
  }

  /** 60 requests/minute, burst 10, per source; a static document needs no more. */
  private allow(source: string): boolean {
    const now = Date.now();
    if (now - this.lastCleanup > 60_000) {
      for (const [k, b] of this.buckets) if (now - b.at > 120_000) this.buckets.delete(k);
      this.lastCleanup = now;
    }
    const b = this.buckets.get(source) ?? { tokens: 10, at: now };
    b.tokens = Math.min(10, b.tokens + ((now - b.at) / 1000) * 1);
    b.at = now;
    this.buckets.set(source, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

// --- peer classification -----------------------------------------------------

export type RouteKind = "self" | "direct" | "relay" | "unknown";

export interface DirectoryPeer {
  hostname: string;
  virtualIpv4: string;
  peerId: string | null;
  online: boolean;
  route: RouteKind;
  cost: string;
  latencyMs: string | null;
  loss: string | null;
  tunnel: string | null;
  nat: string | null;
  mappedCidr: string | null;
  conflict: string | null;
  lastSeenAt: string | null;
}

/** The dialled side of an EasyTier proxy CIDR entry (`real->mapped`). */
export function mappedOf(proxyCidrs: string): string | null {
  for (const raw of proxyCidrs.split(",").map((s) => s.trim())) {
    if (!raw) continue;
    const dialed = raw.includes("->") ? raw.split("->")[1].trim() : raw;
    const host = dialed.replace(/\/\d+$/, "");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  }
  return null;
}

export function routeKind(cost: string, nextHop: string): RouteKind {
  if (cost === "Local" || nextHop === "Local") return "self";
  if (cost === "p2p" || nextHop === "DIRECT") return "direct";
  if (cost.startsWith("relay") || (nextHop && nextHop !== "-")) return "relay";
  return "unknown";
}

/**
 * Combines EasyTier's peer list and route table into one directory row per
 * peer. Duplicate virtual addresses and duplicate mapped prefixes are marked
 * as conflicts and never probed: an ambiguous dial has no safe winner.
 */
export function classifyPeers(
  peers: { hostname: string; ipv4: string; cost: string; latencyMs: string; loss: string; tunnel: string; nat: string; id: string }[],
  routes: { ipv4: string; hostname: string; proxyCidrs: string; nextHop: string; pathLen: number }[],
  own: { hostname: string | null; virtualIpv4: string | null },
): DirectoryPeer[] {
  const byIp = new Map<string, number>();
  for (const p of peers) {
    const ip = p.ipv4.replace(/\/\d+$/, "");
    byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
  }
  const mappedOwners = new Map<string, string[]>();
  for (const r of routes) {
    const m = mappedOf(r.proxyCidrs);
    if (!m) continue;
    mappedOwners.set(m, [...(mappedOwners.get(m) ?? []), r.hostname || r.ipv4]);
  }
  const ownIp = own.virtualIpv4?.replace(/\/\d+$/, "") ?? null;
  return peers.map((p) => {
    const ip = p.ipv4.replace(/\/\d+$/, "");
    const self = p.cost === "Local" || (own.hostname !== null && p.hostname === own.hostname) || (ownIp !== null && ip === ownIp);
    const route = routes.find((r) => (r.hostname || "") === p.hostname && r.ipv4.replace(/\/\d+$/, "") === ip)
      ?? routes.find((r) => (r.hostname || "") === p.hostname);
    const mapped = route ? mappedOf(route.proxyCidrs) : null;
    let conflict: string | null = null;
    if ((byIp.get(ip) ?? 0) > 1) conflict = `duplicate virtual address ${ip}`;
    else if (!self && mapped && (mappedOwners.get(mapped)?.length ?? 0) > 1) {
      conflict = `mapped prefix ${mapped} is announced by ${mappedOwners.get(mapped)!.join(", ")}`;
    } else if (!self && route && route.hostname && p.hostname && route.hostname !== p.hostname) {
      conflict = `route ${route.hostname} does not match peer ${p.hostname}`;
    }
    return {
      hostname: p.hostname || ip,
      virtualIpv4: ip,
      peerId: p.id || null,
      online: !self,
      route: routeKind(p.cost, route?.nextHop ?? ""),
      cost: p.cost || "",
      latencyMs: p.latencyMs && p.latencyMs !== "-" ? p.latencyMs : null,
      loss: p.loss && p.loss !== "-" ? p.loss : null,
      tunnel: p.tunnel && p.tunnel !== "-" ? p.tunnel : null,
      nat: p.nat && p.nat !== "Unknown" ? p.nat : null,
      mappedCidr: mapped ? `${mapped}/32` : null,
      conflict,
      lastSeenAt: new Date().toISOString(),
    };
  });
}
