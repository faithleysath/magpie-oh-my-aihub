// secp256k1 public-key recovery and EIP-55 addresses.
//
// Why hand-written: this plugin must verify a consumer's wallet signature
// locally, on a machine that may be offline, and Bun ships no secp256k1
// (`node:crypto.getCurves()` has no secp256k1) and no Keccak-256. A wallet
// dependency would be a new supply-chain surface for the code that guards
// credit, so the curve arithmetic lives here: ~120 lines of BigInt, one file,
// no native code, checked against `cast wallet verify` and published vectors.
//
// Scope: recovery of the signer address from a 65-byte Ethereum signature. No
// signing, no key generation, no HD derivation. The plugin never holds a
// private key for a consumer or a provider.

import { addressFromPublicKey, fromHex, keccak256, toHex } from "./keccak.ts";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N / 2n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

export interface Point {
  x: bigint;
  y: bigint;
}

function mod(a: bigint, m = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

/** Modular inverse by Fermat's little theorem; the modulus is prime. */
function inv(a: bigint, m = P): bigint {
  let base = mod(a, m);
  if (base === 0n) throw new Error("no inverse of zero");
  let exp = m - 2n;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return result;
}

function add(a: Point | null, b: Point | null): Point | null {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y) === 0n) return null;
    const l = mod(3n * a.x * a.x * inv(2n * a.y));
    const x = mod(l * l - 2n * a.x);
    return { x, y: mod(l * (a.x - x) - a.y) };
  }
  const l = mod((b.y - a.y) * inv(b.x - a.x));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}

function mul(p: Point | null, k: bigint): Point | null {
  let n = mod(k, N);
  let result: Point | null = null;
  let addend: Point | null = p;
  while (n > 0n) {
    if (n & 1n) result = add(result, addend);
    addend = add(addend, addend);
    n >>= 1n;
  }
  return result;
}

function onCurve(p: Point): boolean {
  return mod(p.y * p.y - p.x * p.x * p.x - 7n) === 0n;
}

/** y for a given x, with the parity the recovery id asks for; null when x is not on the curve. */
function liftX(x: bigint, odd: boolean): Point | null {
  if (x <= 0n || x >= P) return null;
  const rhs = mod(x * x * x + 7n);
  // P % 4 === 3, so the square root is rhs^((P+1)/4).
  const y = (() => {
    let base = rhs;
    let exp = (P + 1n) / 4n;
    let result = 1n;
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % P;
      base = (base * base) % P;
      exp >>= 1n;
    }
    return result;
  })();
  if (mod(y * y) !== rhs) return null;
  const wantOdd = odd;
  const isOdd = (y & 1n) === 1n;
  return { x, y: wantOdd === isOdd ? y : mod(-y) };
}

export interface Signature {
  r: bigint;
  s: bigint;
  /** 27/28, or the raw 0/1 parity bit */
  v: number;
}

export function parseSignature(sig: Uint8Array | string): Signature {
  const bytes = typeof sig === "string" ? fromHex(sig) : sig;
  if (bytes.length !== 65) throw new Error("an Ethereum signature is 65 bytes (r, s, v)");
  const r = BigInt(`0x${toHex(bytes.subarray(0, 32))}`);
  const s = BigInt(`0x${toHex(bytes.subarray(32, 64))}`);
  let v = bytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error(`signature recovery byte ${bytes[64]} is neither 0/1 nor 27/28`);
  return { r, s, v };
}

/**
 * The signer's address for `digest` and a signature, or null.
 *
 * Null means "this signature does not prove this digest" for any reason:
 * malformed values, a point off the curve, a high-s (malleable) signature, or a
 * recovered key that is not on the curve. A caller must treat null as a refusal,
 * never as an address.
 */
export function recoverAddress(digest: Uint8Array, signature: Uint8Array | string): string | null {
  if (digest.length !== 32) return null;
  let sig: Signature;
  try {
    sig = parseSignature(signature);
  } catch {
    return null;
  }
  const { r, s, v } = sig;
  if (r <= 0n || r >= N) return null;
  if (s <= 0n || s >= N) return null;
  // EIP-2: a signature and its mirror both verify otherwise, so one digest
  // would have two valid signatures. Prepaid credit refuses that.
  if (s > HALF_N) return null;
  const x = r;
  const R = liftX(x, v === 1);
  if (!R) return null;
  const z = BigInt(`0x${toHex(digest)}`);
  const rInv = inv(r, N);
  const u1 = mod(-z * rInv, N);
  const u2 = mod(s * rInv, N);
  const Q = add(mul({ x: GX, y: GY }, u1), mul(R, u2));
  if (!Q || !onCurve(Q)) return null;
  const pub = new Uint8Array(64);
  pub.set(fromHex(Q.x.toString(16).padStart(64, "0")), 0);
  pub.set(fromHex(Q.y.toString(16).padStart(64, "0")), 32);
  return addressFromPublicKey(pub);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Whether a string is shaped like an EVM address (checksum is not required to parse). */
export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

/** Two addresses are the same account regardless of EIP-55 letter case. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!isAddress(a) || !isAddress(b)) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** The EIP-55 mixed-case form, for display and logs. */
export function checksumAddress(address: string): string {
  if (!isAddress(address)) throw new Error(`${address} is not an EVM address`);
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak256(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/** Keccak-256 of a string, as a 0x-prefixed hex digest. */
export function hashString(value: string): string {
  return `0x${toHex(keccak256(value))}`;
}

/**
 * The address an EIP-712 signature proves, from the 32-byte typed-data digest.
 * Same refusal semantics as `recoverAddress`.
 */
export function signerOfTypedData(digest: string, signature: string): string | null {
  try {
    return recoverAddress(fromHex(digest), signature);
  } catch {
    return null;
  }
}
