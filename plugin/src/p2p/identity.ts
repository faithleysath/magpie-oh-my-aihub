// The bridge between the persisted Catalogue identity and B1.
//
// B1 does not mint a key of its own. The account identity is the Ed25519 key in
// `catalog-identity.json`; its fingerprint is the account id. Every signature
// here is domain-separated per purpose, so a signed Catalogue quote can never be
// replayed as a P2P approval (or the other way round) even though both use the
// same key pair.

import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalJson, keyIdOf, type CatalogIdentity, type CatalogTrustRecord } from "../catalog.ts";
import {
  fail,
  peerIdentityOf,
  P2P_PROTOCOL,
  validatePeerIdentity,
  verifyEd25519,
  type P2pAuth,
  type P2pEnvelope,
  type P2pMessageType,
  type P2pPeerIdentity,
  type P2pTargetIdentity,
} from "./protocol.ts";

/** What this node can prove about itself on the overlay, beyond its key. */
export interface P2pLocalBinding {
  nodeId: string;
  hostname: string;
  /** the mapped provider /32, or null when this node publishes no catalogue */
  mappedCidr: string | null;
  /** the control port the peer should address, or null before the listener exists */
  controlPort: number | null;
  /** the native Magpie gateway port, or null when this node does not share */
  gatewayPort: number | null;
  /** the current published catalogue hash, or null when nothing is published */
  catalogQuoteHash: string | null;
}

export interface P2pIdentity {
  readonly peer: P2pPeerIdentity;
  readonly binding: P2pLocalBinding;
  /** the target a remote peer must put in `to` when addressing this node */
  readonly target: P2pTargetIdentity;
  /** a copy of this identity with a new local binding (sharing/ports/quotes change) */
  withBinding(binding: P2pLocalBinding): P2pIdentity;
  sign(type: P2pMessageType, unsignedWithoutDomain: Record<string, unknown>): P2pAuth;
  /** handshake signatures use their own domains; they are not envelope types */
  signHandshake(kind: "hello" | "server_hello", value: Record<string, unknown>): P2pAuth;
}

export function signingValueWithoutSignature(envelope: Omit<P2pEnvelope, "auth">): Record<string, unknown> {
  return {
    protocol: envelope.protocol,
    version: envelope.version,
    type: envelope.type,
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    time: envelope.time,
    expires: envelope.expires,
    correlation: envelope.correlation,
    idempotency: envelope.idempotency,
    body: envelope.body,
  };
}

export function handshakeSigningValue(kind: "hello" | "server_hello", value: Record<string, unknown>): Buffer {
  const domain = kind === "hello" ? "ohmyaihub/p2p/handshake/hello/v1" : "ohmyaihub/p2p/handshake/server-hello/v1";
  return Buffer.from(canonicalJson({ domain, protocol: P2P_PROTOCOL, kind, ...value }), "utf8");
}

export function p2pIdentityFromCatalog(identity: CatalogIdentity, binding: P2pLocalBinding): P2pIdentity {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(identity.privateKeyPem);
  } catch {
    return fail("internal", "the Catalogue private key cannot be loaded");
  }
  const keyId = keyIdOf(identity.summary.publicKey);
  const signValue = (bytes: Buffer): string => cryptoSign(null, bytes, privateKey).toString("base64");

  const build = (current: P2pLocalBinding): P2pIdentity => {
    const peer = peerIdentityOf(identity.summary, current.nodeId, current.hostname);
    const target: P2pTargetIdentity = { accountId: peer.fingerprint, nodeId: peer.nodeId, fingerprint: peer.fingerprint };
    return {
      peer,
      binding: current,
      target,
      withBinding: build,
      sign(type, unsigned) {
        const bytes = Buffer.from(canonicalJson({ domain: `ohmyaihub/p2p/${type}/v1`, ...unsigned }), "utf8");
        return { algorithm: "ed25519", keyId, signature: signValue(bytes) };
      },
      signHandshake(kind, value) {
        return { algorithm: "ed25519", keyId, signature: signValue(handshakeSigningValue(kind, value)) };
      },
    };
  };
  return build(binding);
}

export function verifyHandshakeSignature(kind: "hello" | "server_hello", peer: P2pPeerIdentity, value: Record<string, unknown>, auth: P2pAuth): boolean {
  if (auth.algorithm !== "ed25519" || auth.keyId !== keyIdOf(peer.publicKey)) return false;
  return verifyEd25519(peer.publicKey, handshakeSigningValue(kind, value), auth.signature);
}

// --- trust verdicts ----------------------------------------------------------

export type P2pTrustVerdict = "accepted" | "pending" | "unknown" | "changed" | "revoked";

/** The minimal shape of a provider-side TOFU row (see store.ts). */
export interface P2pTrustRecordLike {
  fingerprint: string;
  accepted: boolean;
  pendingFingerprint?: string | null;
  revokedAt?: string | null;
}

/**
 * Fail closed: only an explicitly accepted, unpending, same-fingerprint record
 * counts as trusted. A first contact is "pending" (the human has not decided);
 * a new key for a known node is "changed"; a revoked record stays revoked.
 */
export function trustVerdict(record: P2pTrustRecordLike | null | undefined, peer: P2pPeerIdentity): P2pTrustVerdict {
  if (!record) return "unknown";
  if (record.revokedAt) return "revoked";
  if (record.fingerprint !== peer.fingerprint) {
    return record.pendingFingerprint === peer.fingerprint ? "pending" : "changed";
  }
  if (!record.accepted) return "pending";
  return "accepted";
}

/**
 * The consumer's mirror of `catalogIdentityAccepted()`: the peer must have been
 * read from the catalogue, its key explicitly accepted, and no key change may be
 * pending. This is the same predicate the existing console uses before it lets
 * an operator import an authorization file.
 */
export function catalogProviderTrust(record: CatalogTrustRecord | undefined, expected: { nodeId: string; fingerprint: string }): P2pTrustVerdict {
  if (!record || record.nodeId !== expected.nodeId) return "unknown";
  if (record.fingerprint !== expected.fingerprint) {
    return record.pending?.fingerprint === expected.fingerprint ? "pending" : "changed";
  }
  if (record.pending) return "changed";
  return record.accepted ? "accepted" : "pending";
}

/** The identity block of a hello, without any secret. */
export function peerOf(raw: unknown, where = "peer"): P2pPeerIdentity {
  return validatePeerIdentity(raw, where);
}
