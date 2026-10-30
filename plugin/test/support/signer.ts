// A deterministic secp256k1 signer for tests.
//
// The production verifier is `src/secp256k1.ts`; this is the smallest thing that
// can produce a signature it accepts, so a journey test never needs a wallet,
// a keystore or a network. Deterministic k (no RNG), low-s, recovery parity in
// the last byte — the same conventions `cast wallet sign` uses.

import { fromHex, keccak256, toHex } from "../../src/keccak.ts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a: bigint, m: bigint = P): bigint => ((a % m) + m) % m;
function inv(a: bigint, m: bigint): bigint {
  let b = mod(a, m);
  let e = m - 2n;
  let o = 1n;
  while (e > 0n) {
    if (e & 1n) o = (o * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return o;
}

type Pt = { x: bigint; y: bigint } | null;
function add(a: Pt, b: Pt): Pt {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y) === 0n) return null;
    const l = mod(3n * a.x * a.x * inv(2n * a.y, P));
    const x = mod(l * l - 2n * a.x);
    return { x, y: mod(l * (a.x - x) - a.y) };
  }
  const l = mod((b.y - a.y) * inv(b.x - a.x, P));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}
function mul(p: Pt, k: bigint): Pt {
  let n = mod(k, N);
  let o: Pt = null;
  let a = p;
  while (n > 0n) {
    if (n & 1n) o = add(o, a);
    a = add(a, a);
    n >>= 1n;
  }
  return o;
}

/** The address for a private key, in EIP-55 checksum form. */
export function addressOf(privateKey: bigint): string {
  const pub = mul({ x: GX, y: GY }, privateKey)!;
  const bytes = new Uint8Array(64);
  bytes.set(fromHex(pub.x.toString(16).padStart(64, "0")), 0);
  bytes.set(fromHex(pub.y.toString(16).padStart(64, "0")), 32);
  const lower = toHex(keccak256(bytes)).slice(-40);
  const hash = toHex(keccak256(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  return out;
}

/** Signs a 32-byte digest. The output is the 65-byte r||s||v form the plugin verifies. */
export function signDigest(digestHex: string, privateKey = 1n): string {
  const z = BigInt(digestHex);
  let k = mod(BigInt(`0x${toHex(keccak256(`${privateKey}:${digestHex}`))}`), N);
  if (k === 0n) k = 1n;
  const R = mul({ x: GX, y: GY }, k)!;
  const r = mod(R.x, N);
  let s = mod(inv(k, N) * (z + r * privateKey), N);
  let parity = Number(R.y & 1n);
  if (s > N / 2n) {
    s = N - s;
    parity ^= 1;
  }
  const out = new Uint8Array(65);
  out.set(fromHex(r.toString(16).padStart(64, "0")), 0);
  out.set(fromHex(s.toString(16).padStart(64, "0")), 32);
  out[64] = parity + 27;
  return `0x${toHex(out)}`;
}

export const TEST_PAYER_KEY = 1n;
export const TEST_PAYER = addressOf(TEST_PAYER_KEY);
export const TEST_STRANGER_KEY = 2n;
export const TEST_STRANGER = addressOf(TEST_STRANGER_KEY);
