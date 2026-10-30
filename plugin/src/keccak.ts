// Keccak-256, as Ethereum uses it (original Keccak padding 0x01, not SHA3's 0x06).
//
// Bun's crypto and Node's `createHash` do not expose Keccak-256: `getHashes()`
// lists `sha3-256`, which is a *different* function with the same output length.
// Node's secp256k1 is unavailable in Bun builds too (`getCurves()` has no
// secp256k1), so signature verification cannot borrow a library either.
//
// This is the only new cryptographic primitive the wallet phase needs, so it is
// written here, in one file, with published test vectors. It is not a general
// hashing utility: only `keccak256` and the Ethereum address derivation are used.

const MASK64 = (1n << 64n) - 1n;

/** Keccak-f[1600] round constants. */
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed [x][y]. */
const ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(v: bigint, n: number): bigint {
  if (n === 0) return v;
  const s = BigInt(n);
  return ((v << s) | (v >> (64n - s))) & MASK64;
}

function keccakF(state: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROT[x][y]);
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y]);
      }
    }
    // iota
    state[0] ^= RC[round];
  }
}

const RATE = 136; // bytes, for a 256-bit output

/** Keccak-256 of arbitrary bytes. */
export function keccak256(input: Uint8Array | string): Uint8Array {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const state = new Array<bigint>(25).fill(0n);
  const padded = new Uint8Array(Math.floor(data.length / RATE) * RATE + RATE);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      state[i] ^= lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function keccak256Hex(input: Uint8Array | string): string {
  return `0x${toHex(keccak256(input))}`;
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Strict 0x-hex to bytes; throws on anything that is not whole bytes. */
export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error("not a hex string of whole bytes");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 32-bit big-endian length-prefixed encoding, as abi.encodePacked does for bytes/string. */
export function bytes32From(value: Uint8Array): Uint8Array {
  return keccak256(value);
}

/** An EVM address from a 64-byte uncompressed public key (without the 0x04 prefix). */
export function addressFromPublicKey(pub: Uint8Array): string {
  if (pub.length !== 64) throw new Error("an EVM public key is 64 bytes without its 0x04 prefix");
  const hash = keccak256(pub);
  return `0x${toHex(hash.subarray(12))}`;
}
