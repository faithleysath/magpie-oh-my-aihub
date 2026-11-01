// This node's X25519 key pair for EasyTier secure mode.
//
// Secure mode swaps "one shared password protects the tunnel" for "the tunnel is
// a Noise session between two static X25519 keys, and the shared network secret
// proves membership". Nothing is exchanged between members: every node generates
// its own pair here, and two peers negotiate their session key the first time
// they connect. A node therefore needs no help from the network owner to join a
// secure-mode network — it needs the password it already has.
//
// The pair is this node's overlay identity, so it is written once and reused:
// a new pair is a different node (and, once the network hands out credentials
// instead of the main secret, a different authorization). The file is `0600`,
// the private key is registered as a log secret, and no tool ever returns it.

import { generateKeyPairSync } from "node:crypto";
import { logger, registerSecret } from "./log.ts";
import { statePath } from "./paths.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export interface SecureKeyPair {
  /** base64 of the raw 32-byte X25519 private key */
  privateKey: string;
  /** base64 of the raw 32-byte X25519 public key */
  publicKey: string;
}

const KEY_BYTES = 32;
/** 32 raw bytes are 44 base64 characters with one `=` of padding. */
const BASE64_32_RE = /^[A-Za-z0-9+/]{43}=$/;

export function secureKeyPath(): string {
  return statePath("easytier", "secure-key.json");
}

function base64UrlToBase64(value: string): string {
  const swapped = value.replace(/-/g, "+").replace(/_/g, "/");
  return swapped.padEnd(Math.ceil(swapped.length / 4) * 4, "=");
}

/** A key that is exactly 32 bytes of base64, or null for anything else. */
function keyOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!BASE64_32_RE.test(trimmed)) return null;
  return Buffer.from(trimmed, "base64").length === KEY_BYTES ? trimmed : null;
}

/** A fresh pair. `node:crypto` exports X25519 as JWK, which is base64url. */
export function generateSecureKeyPair(): SecureKeyPair {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d?: unknown; x?: unknown };
  const secret = typeof jwk.d === "string" ? base64UrlToBase64(jwk.d) : "";
  const pub = typeof jwk.x === "string" ? base64UrlToBase64(jwk.x) : "";
  const privateKey64 = keyOf(secret);
  const publicKey64 = keyOf(pub);
  if (!privateKey64 || !publicKey64) {
    throw new Error("E_SECURE_KEY: node:crypto did not return a usable X25519 pair");
  }
  return { privateKey: privateKey64, publicKey: publicKey64 };
}

function remembered(pair: SecureKeyPair): SecureKeyPair {
  registerSecret(pair.privateKey);
  return pair;
}

/** The stored pair, or null when the file is missing or does not hold one. */
export function readSecureKeyPair(): SecureKeyPair | null {
  const raw = readJson<Record<string, unknown>>(secureKeyPath());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const privateKey = keyOf((raw as Record<string, unknown>).privateKey);
  const publicKey = keyOf((raw as Record<string, unknown>).publicKey);
  if (!privateKey || !publicKey) {
    logger.warn(`${secureKeyPath()} does not hold a usable X25519 pair; it will be regenerated`);
    return null;
  }
  return remembered({ privateKey, publicKey });
}

/**
 * The pair to put in the generated TOML. Created on first use and then reused
 * forever: regenerating would silently make this a different node on the overlay.
 */
export function loadOrCreateSecureKeyPair(): SecureKeyPair {
  const existing = readSecureKeyPair();
  if (existing) return existing;
  const pair = generateSecureKeyPair();
  writeJsonAtomic(secureKeyPath(), pair, 0o600);
  logger.info(`generated a secure-mode key pair (${secureKeyPath()})`);
  return remembered(pair);
}
