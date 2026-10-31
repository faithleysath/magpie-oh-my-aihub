// TOFU pins for signed control presences.
//
// A node that shares no models has no signed catalogue, so the catalogue trust
// file cannot pin it. Its presence is still self-signed by the same Ed25519
// identity; this store remembers the first key seen for a node id so a later
// presence with another key is reported as an identity change instead of being
// silently accepted. Acceptance is a human action. The file is 0600, written
// atomically and read through a null-prototype map so a crafted node id cannot
// reach Object.prototype.

import { statePath } from "../paths.ts";
import { isValidNodeId } from "../catalog.ts";
import { readJson, writeJsonAtomic } from "../store.ts";

export interface PresencePin {
  nodeId: string;
  fingerprint: string;
  publicKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** a human accepted this key explicitly */
  accepted: boolean;
  /** a different key was seen; never accepted automatically */
  pending: { fingerprint: string; publicKey: string; seenAt: string } | null;
}

interface PresenceTrustFile {
  version: 1;
  peers: Record<string, PresencePin>;
}

function file(): string {
  return statePath("p2p-presence-trust.json");
}

const HEX64 = /^[0-9a-f]{64}$/;

function pinOf(raw: unknown, nodeId: string): PresencePin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.fingerprint !== "string" || !HEX64.test(r.fingerprint)) return null;
  if (typeof r.publicKey !== "string" || !r.publicKey || r.publicKey.length > 128) return null;
  if (typeof r.firstSeenAt !== "string" || typeof r.lastSeenAt !== "string") return null;
  const pending = r.pending && typeof r.pending === "object" && !Array.isArray(r.pending)
    ? r.pending as Record<string, unknown>
    : null;
  return {
    nodeId,
    fingerprint: r.fingerprint,
    publicKey: r.publicKey,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    accepted: r.accepted === true,
    pending: pending && typeof pending.fingerprint === "string" && HEX64.test(pending.fingerprint)
      && typeof pending.publicKey === "string" && typeof pending.seenAt === "string"
      ? { fingerprint: pending.fingerprint, publicKey: pending.publicKey, seenAt: pending.seenAt }
      : null,
  };
}

export function loadPresenceTrust(): Record<string, PresencePin> {
  const out: Record<string, PresencePin> = Object.create(null) as Record<string, PresencePin>;
  const value = readJson<PresenceTrustFile>(file());
  if (!value || typeof value !== "object" || value.version !== 1) return out;
  const peers = value.peers;
  if (!peers || typeof peers !== "object" || Array.isArray(peers)) return out;
  for (const nodeId of Object.keys(peers)) {
    if (!isValidNodeId(nodeId)) continue;
    const pin = pinOf((peers as Record<string, unknown>)[nodeId], nodeId);
    if (pin) out[nodeId] = pin;
  }
  return out;
}

export function savePresenceTrust(peers: Record<string, PresencePin>): void {
  const out: Record<string, PresencePin> = Object.create(null) as Record<string, PresencePin>;
  for (const nodeId of Object.keys(peers)) {
    if (!isValidNodeId(nodeId)) continue;
    const pin = pinOf(peers[nodeId], nodeId);
    if (pin) out[nodeId] = pin;
  }
  writeJsonAtomic(file(), { version: 1, peers: out } satisfies PresenceTrustFile);
}

export type PresenceTofu = "first-seen" | "accepted" | "pending" | "changed";

/** The TOFU state a pin gives one observed presence fingerprint. */
export function presenceTofu(pin: PresencePin | undefined, fingerprint: string): PresenceTofu {
  if (!pin) return "first-seen";
  if (pin.fingerprint === fingerprint) {
    if (pin.pending && pin.pending.fingerprint !== pin.fingerprint) return "changed";
    return pin.accepted ? "accepted" : "pending";
  }
  return "changed";
}
