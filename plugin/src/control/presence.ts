// Signed presence for control endpoint discovery.
//
// This is deliberately separate from the strict Catalogue v1 document: no unknown
// field is added there, and a control-only node never publishes models or keys.
// Presence only says "this Catalogue identity owns this node id and this ready
// control endpoint", signed with the same Ed25519 Catalogue key and valid for a
// short window. Being on the LAN/overlay never authorizes business actions; the
// actual request/approval still uses the signed session/AEAD protocol.
//
// No secret, model list, Gateway Key, catalogue quote body or Magpie admin field
// is carried here. Endpoint publication must be gated by an actual owned/ready
// listener in the caller.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson, type CatalogIdentity } from "../catalog.ts";
import { isValidNodeId, isValidOverlayHostname } from "../catalog.ts";

export const PRESENCE_SCHEMA = "ohmyaihub.presence/v1";
export const PRESENCE_PATH = "/p2p/v1/presence";
export const PRESENCE_MAX_BYTES = 8 * 1024;

export interface PresenceBody {
  schema: typeof PRESENCE_SCHEMA;
  node: {
    nodeId: string;
    hostname: string;
    fingerprint: string;
    publicKey: string;
  };
  endpoint: {
    /** exact bind/forward host the peer should address; not a trust claim */
    host: string;
    mappedCidr: string | null;
    controlPort: number;
    ready: true;
  };
  capability: {
    control: true;
    sharing: "enabled" | "disabled" | "suspended";
    /** no model ids, no key: only whether this node currently offers models */
    providesModels: boolean;
  };
  issuedAt: string;
  expiresAt: string;
}

export interface SignedPresence extends PresenceBody {
  signature: string;
}

function rawKey(publicKey: string): Buffer {
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32) throw new Error("presence public key must be 32 bytes");
  return raw;
}

function verifyBytes(publicKey: string, bytes: Buffer, signature: string): boolean {
  try {
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey(publicKey)]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const sig = Buffer.from(signature, "base64");
    return sig.length === 64 && verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

function assertText(value: unknown, max: number, where: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${where} must be non-empty text of at most ${max} characters`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${where} has unexpected field ${JSON.stringify(extra[0])}`);
}

export function signPresence(body: PresenceBody, identity: CatalogIdentity): SignedPresence {
  const unsigned: PresenceBody = {
    schema: PRESENCE_SCHEMA,
    node: { nodeId: body.node.nodeId, hostname: body.node.hostname, fingerprint: body.node.fingerprint, publicKey: body.node.publicKey },
    endpoint: { host: body.endpoint.host, mappedCidr: body.endpoint.mappedCidr, controlPort: body.endpoint.controlPort, ready: true },
    capability: { control: true, sharing: body.capability.sharing, providesModels: body.capability.providesModels },
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  };
  const bytes = Buffer.from(canonicalJson({ domain: PRESENCE_SCHEMA, body: unsigned }), "utf8");
  const privateKey = createPrivateKey(identity.privateKeyPem);
  return { ...unsigned, signature: sign(null, bytes, privateKey).toString("base64") };
}

export interface VerifyPresenceOptions {
  /** when known, the endpoint host must be exactly this catalogue mapped host */
  expectedMappedCidr?: string | null;
  /** tests only: allow a loopback endpoint */
  allowLoopback?: boolean;
}

export function verifyPresence(raw: unknown, now = new Date(), opts: VerifyPresenceOptions = {}): PresenceBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("presence must be an object");
  const doc = raw as Record<string, unknown>;
  exactKeys(doc, ["schema", "node", "endpoint", "capability", "issuedAt", "expiresAt", "signature"], "presence");
  if (doc.schema !== PRESENCE_SCHEMA) throw new Error("unsupported presence schema");
  const node = doc.node as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("presence.node is missing");
  exactKeys(node, ["nodeId", "hostname", "fingerprint", "publicKey"], "presence.node");
  const nodeId = assertText(node.nodeId, 64, "presence.node.nodeId");
  if (!isValidNodeId(nodeId)) throw new Error("presence.node.nodeId is invalid");
  const hostname = assertText(node.hostname, 72, "presence.node.hostname");
  if (!isValidOverlayHostname(hostname, nodeId)) throw new Error("presence.node.hostname does not match node id");
  const publicKey = assertText(node.publicKey, 44, "presence.node.publicKey");
  const fingerprint = assertText(node.fingerprint, 64, "presence.node.fingerprint");
  if (fingerprint !== createHashFingerprint(publicKey)) throw new Error("presence fingerprint does not match publicKey");
  const endpoint = doc.endpoint as Record<string, unknown> | undefined;
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) throw new Error("presence.endpoint is missing");
  exactKeys(endpoint, ["host", "mappedCidr", "controlPort", "ready"], "presence.endpoint");
  const mappedCidr = endpoint.mappedCidr === null ? null : assertText(endpoint.mappedCidr, 18, "presence.endpoint.mappedCidr");
  if (mappedCidr !== null && !/^10\.66\.\d{1,3}\.\d{1,3}\/32$/.test(mappedCidr)) throw new Error("presence mappedCidr is invalid");
  const host = assertText(endpoint.host, 64, "presence.endpoint.host");
  if (/[\s/\\@]/.test(host)) throw new Error("presence endpoint host is invalid");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) throw new Error("presence endpoint host must be an IPv4 address");
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) throw new Error("presence endpoint host is invalid");
  const loopback = octets[0] === 127;
  const linkLocal = octets[0] === 169 && octets[1] === 254;
  const unspecified = octets.every((n) => n === 0);
  if ((loopback || linkLocal || unspecified) && !opts.allowLoopback) {
    throw new Error("presence endpoint host is loopback/link-local/unspecified");
  }
  if (mappedCidr !== null && host !== mappedCidr.replace(/\/32$/, "")) {
    throw new Error("presence endpoint host does not match its signed mappedCidr");
  }
  if (opts.expectedMappedCidr && host !== opts.expectedMappedCidr.replace(/\/32$/, "")) {
    throw new Error("presence endpoint host does not match the signed catalogue mapped address");
  }
  if (mappedCidr !== null && !/^10\.66\.\d{1,3}\.\d{1,3}\/32$/.test(mappedCidr)) throw new Error("presence mappedCidr is invalid");
  if (opts.expectedMappedCidr && mappedCidr !== opts.expectedMappedCidr) {
    throw new Error("presence mappedCidr does not match the signed catalogue");
  }
  const controlPort = endpoint.controlPort;
  if (typeof controlPort !== "number" || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error("presence controlPort is invalid");
  }
  if (endpoint.ready !== true) throw new Error("presence endpoint is not ready");
  const capability = doc.capability as Record<string, unknown> | undefined;
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) throw new Error("presence.capability is missing");
  exactKeys(capability, ["control", "sharing", "providesModels"], "presence.capability");
  if (capability.control !== true) throw new Error("presence does not claim control capability");
  if (!["enabled", "disabled", "suspended"].includes(String(capability.sharing))) throw new Error("presence sharing state is invalid");
  if (typeof capability.providesModels !== "boolean") throw new Error("presence providesModels is invalid");
  const issuedAt = assertText(doc.issuedAt, 40, "presence.issuedAt");
  const expiresAt = assertText(doc.expiresAt, 40, "presence.expiresAt");
  const signature = assertText(doc.signature, 128, "presence.signature");
  const t = Date.parse(issuedAt);
  const e = Date.parse(expiresAt);
  if (!Number.isFinite(t) || !Number.isFinite(e) || e <= t || e - t > 5 * 60_000) throw new Error("presence validity window is invalid");
  if (t - now.getTime() > 60_000 || now.getTime() - e > 60_000) throw new Error("presence is not current");
  const unsigned: PresenceBody = {
    schema: PRESENCE_SCHEMA,
    node: { nodeId, hostname, fingerprint, publicKey },
    endpoint: { host, mappedCidr, controlPort, ready: true },
    capability: { control: true, sharing: capability.sharing as "enabled" | "disabled" | "suspended", providesModels: capability.providesModels },
    issuedAt,
    expiresAt,
  };
  const bytes = Buffer.from(canonicalJson({ domain: PRESENCE_SCHEMA, body: unsigned }), "utf8");
  if (!verifyBytes(publicKey, bytes, signature)) throw new Error("presence signature is invalid");
  if (Buffer.byteLength(canonicalJson(raw)) > PRESENCE_MAX_BYTES) throw new Error("presence exceeds size limit");
  return unsigned;
}

function createHashFingerprint(publicKey: string): string {
  return createHash("sha256").update(rawKey(publicKey)).digest("hex");
}
