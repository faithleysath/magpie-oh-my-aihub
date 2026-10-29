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

/**
 * Verifies a catalogue document. Returns its unsigned body and content hash, or
 * throws with a reason. A self-signed document proves only key possession.
 */
export function verifySignedCatalog(value: unknown): VerifiedCatalog {
  if (!value || typeof value !== "object") throw new Error("catalogue is not an object");
  const doc = value as Record<string, unknown>;
  if (doc.schema !== CATALOG_SCHEMA) throw new Error(`unsupported catalogue schema ${String(doc.schema)}`);
  if (typeof doc.signature !== "string" || !doc.signature) throw new Error("catalogue has no signature");
  const identity = doc.identity as Record<string, unknown> | undefined;
  if (!identity || identity.algorithm !== "ed25519" || typeof identity.publicKey !== "string") {
    throw new Error("catalogue has no Ed25519 identity");
  }
  const unsigned = { ...doc } as Record<string, unknown>;
  delete unsigned.signature;
  const canonical = canonicalJson(unsigned);
  const raw = Buffer.from(identity.publicKey, "base64");
  const ok = verify(null, Buffer.from(canonical), spkiFromRaw(raw), Buffer.from(doc.signature, "base64"));
  if (!ok) throw new Error("catalogue signature does not match its content");
  const fingerprint = fingerprintOf(identity.publicKey);
  if (identity.fingerprint !== fingerprint || identity.keyId !== keyIdOf(identity.publicKey)) {
    throw new Error("catalogue identity fingerprint does not match its key");
  }
  const node = doc.node as Record<string, unknown> | undefined;
  if (!node || typeof node.id !== "string" || typeof node.mappedCidr !== "string" || typeof node.catalogPort !== "number") {
    throw new Error("catalogue node block is incomplete");
  }
  if (!Array.isArray(doc.models) || doc.models.length > CATALOG_MAX_MODELS) {
    throw new Error(`catalogue models must be an array of at most ${CATALOG_MAX_MODELS}`);
  }
  const quote = unsigned as unknown as CatalogQuoteBody;
  return { quote, signature: doc.signature, contentHash: sha256Hex(canonical), fingerprint };
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

export function loadCatalogTrust(): Record<string, CatalogTrustRecord> {
  const { value } = readJsonWithBackup<TrustFile>(trustFile());
  if (!value || typeof value.peers !== "object" || !value.peers) return {};
  return value.peers;
}

export function saveCatalogTrust(peers: Record<string, CatalogTrustRecord>): void {
  writeJsonAtomic(trustFile(), { version: 1, peers });
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
