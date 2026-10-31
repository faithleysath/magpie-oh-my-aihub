// External-wallet adapter for the local console: EIP-6963 discovery, explicit
// EIP-1193 connection, EIP-712 verification and testnet-only ERC-20 payment
// previews.
//
// Scope and boundaries (docs/phase10-c-external-wallet.md):
//  - pure browser module; no runtime dependency, no build step, no storage;
//  - a wallet's `info` is untrusted display data, never an identity proof;
//  - no generic RPC passthrough, no dynamic method or calldata from callers;
//  - no mnemonic/private-key field, no bridge, swap or token approval;
//  - mainnet 56/8453 sending is refused here as defense-in-depth. The service
//    layer remains the hard gate; this module must never be the only gate.
//  - `eth_sendTransaction` only for a preview issued by this module, after an
//    explicit, per-transfer confirmation. A broadcast hash is never credit.
//
// The Keccak/secp256k1/EIP-712 code below is a browser-readable port of
// plugin/src/{keccak,eip712,secp256k1}.ts. The unit tests compare its output with
// the TypeScript implementation so the two cannot silently diverge.

/* ------------------------------------------------------------------ */
/* Errors and fixed constants                                          */
/* ------------------------------------------------------------------ */

export const EIP6963_ANNOUNCE = "eip6963:announceProvider";
export const EIP6963_REQUEST = "eip6963:requestProvider";
export const TESTNET_CHAIN_IDS = Object.freeze([97, 84532]);
export const MAINNET_CHAIN_IDS = Object.freeze([56, 8453]);

/** Local copy of the C-registry hard set until plugin/src/mainnet-surface.ts merges. */
export function isMainnetChainId(chainId) {
  return MAINNET_CHAIN_IDS.includes(chainId);
}

/** Hard refusal shared by every send/sign path; chainId is authoritative. */
export function assertNoMainnetSend(chainId) {
  if (isMainnetChainId(chainId)) throw fail(WALLET_ERROR.MAINNET_BLOCKED, "主网发送/授信在本模块和服务层均被阻断");
}
export const DEPOSIT_DOMAIN_NAME = "Oh My AI Hub";
export const DEPOSIT_DOMAIN_VERSION = "1";
export const DEPOSIT_VERIFYING_CONTRACT = "0x000000000000000000000000000000000000a1b2";
export const DEPOSIT_TYPES = Object.freeze({
  EIP712Domain: Object.freeze([
    Object.freeze({ name: "name", type: "string" }),
    Object.freeze({ name: "version", type: "string" }),
    Object.freeze({ name: "chainId", type: "uint256" }),
    Object.freeze({ name: "verifyingContract", type: "address" }),
  ]),
  DepositIntent: Object.freeze([
    Object.freeze({ name: "invoiceId", type: "string" }),
    Object.freeze({ name: "consumerId", type: "string" }),
    Object.freeze({ name: "providerId", type: "string" }),
    Object.freeze({ name: "chainId", type: "uint256" }),
    Object.freeze({ name: "assetId", type: "string" }),
    Object.freeze({ name: "tokenContract", type: "address" }),
    Object.freeze({ name: "recipient", type: "address" }),
    Object.freeze({ name: "expectedAmountRaw", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "string" }),
    Object.freeze({ name: "requestedAt", type: "uint64" }),
    Object.freeze({ name: "expiresAt", type: "uint64" }),
  ]),
});
export const WALLET_ERROR = Object.freeze({
  EXPLICIT_ACTION_REQUIRED: "EXPLICIT_ACTION_REQUIRED",
  DISCOVERY_UNAVAILABLE: "DISCOVERY_UNAVAILABLE",
  PROVIDER_INVALID: "PROVIDER_INVALID",
  NO_ACCOUNT: "NO_ACCOUNT",
  NOT_CONNECTED: "NOT_CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  USER_REJECTED: "USER_REJECTED",
  UNAUTHORIZED: "UNAUTHORIZED",
  UNSUPPORTED_METHOD: "UNSUPPORTED_METHOD",
  REQUEST_PENDING: "REQUEST_PENDING",
  WALLET_LOCKED: "WALLET_LOCKED",
  WALLET_TIMEOUT: "WALLET_TIMEOUT",
  WALLET_STATE_CHANGED: "WALLET_STATE_CHANGED",
  WALLET_ERROR: "WALLET_ERROR",
  INVALID_CHAIN_ID: "INVALID_CHAIN_ID",
  UNKNOWN_CHAIN: "UNKNOWN_CHAIN",
  CHAIN_DISABLED: "CHAIN_DISABLED",
  CHAIN_MISMATCH: "CHAIN_MISMATCH",
  CHAIN_NOT_ADDED: "CHAIN_NOT_ADDED",
  MAINNET_BLOCKED: "MAINNET_BLOCKED",
  UNKNOWN_TOKEN: "UNKNOWN_TOKEN",
  UNKNOWN_DECIMALS: "UNKNOWN_DECIMALS",
  UNKNOWN_ISSUER: "UNKNOWN_ISSUER",
  ASSET_NOT_CREDITABLE: "ASSET_NOT_CREDITABLE",
  NETWORK_NOT_CREDITABLE: "NETWORK_NOT_CREDITABLE",
  INVALID_REGISTRY: "INVALID_REGISTRY",
  INVALID_ACCOUNT: "INVALID_ACCOUNT",
  INVALID_ADDRESS: "INVALID_ADDRESS",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_DEPOSIT_DOCUMENT: "INVALID_DEPOSIT_DOCUMENT",
  DIGEST_MISMATCH: "DIGEST_MISMATCH",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  INVALID_TX_HASH: "INVALID_TX_HASH",
  INVALID_INTENT_HASH: "INVALID_INTENT_HASH",
  OPERATION_JOURNAL_REQUIRED: "OPERATION_JOURNAL_REQUIRED",
  OPERATION_ALREADY_STARTED: "OPERATION_ALREADY_STARTED",
  OPERATION_UNKNOWN: "OPERATION_UNKNOWN",
  OPERATION_JOURNAL_FAILED: "OPERATION_JOURNAL_FAILED",
  INSUFFICIENT_TOKEN_BALANCE: "INSUFFICIENT_TOKEN_BALANCE",
  INSUFFICIENT_NATIVE_BALANCE: "INSUFFICIENT_NATIVE_BALANCE",
  GAS_ESTIMATE_FAILED: "GAS_ESTIMATE_FAILED",
  RPC_UNKNOWN: "RPC_UNKNOWN",
  PREVIEW_NOT_ISSUED: "PREVIEW_NOT_ISSUED",
  PREVIEW_CONFIRMATION_REQUIRED: "PREVIEW_CONFIRMATION_REQUIRED",
  PREVIEW_STALE: "PREVIEW_STALE",
  PREVIEW_BLOCKED: "PREVIEW_BLOCKED",
  UNKNOWN_BROADCAST: "UNKNOWN_BROADCAST",
  RECEIPT_MISMATCH: "RECEIPT_MISMATCH",
  DISPOSED: "DISPOSED",
});

export class ExternalWalletError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ExternalWalletError";
    this.code = code;
    this.providerCode = options.providerCode ?? null;
    this.hash = options.hash ?? null;
    this.retryable = options.retryable === true;
  }
}

function fail(code, message, options) {
  return new ExternalWalletError(code, message, options);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_65_RE = /^0x[0-9a-fA-F]{130}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const MAX_UINT256 = (1n << 256n) - 1n;

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && ADDRESS_RE.test(a) && ADDRESS_RE.test(b) && a.toLowerCase() === b.toLowerCase();
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  let text = value.replace(CONTROL_RE, "").replace(/[<>]/g, "").trim();
  const chars = Array.from(text);
  if (chars.length > max) text = chars.slice(0, max).join("");
  return text;
}

function textValue(value, label, max = 160) {
  if (typeof value !== "string") throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, `${label} 不是文本`);
  const text = value.trim();
  if (!text || CONTROL_RE.test(text) || Array.from(text).length > max) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, `${label} 长度或字符不受支持`);
  return text;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, `${label} 不是对象`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, `${label} 含未定义字段`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function cloneJson(value) {
  if (typeof globalThis.structuredClone === "function") {
    try { return globalThis.structuredClone(value); } catch { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function randomId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/* ------------------------------------------------------------------ */
/* Keccak-256, secp256k1 recovery and EIP-712 (browser port)           */
/* ------------------------------------------------------------------ */

const MASK64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];

function rotl(value, bits) {
  if (bits === 0) return value;
  const shift = BigInt(bits);
  return ((value << shift) | (value >> (64n - shift))) & MASK64;
}

function keccakF(state) {
  const c = new Array(5);
  const b = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROT[x][y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) state[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y]);
    state[0] ^= RC[round];
  }
}

const KECCAK_RATE = 136;

function keccak256(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const state = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.floor(data.length / KECCAK_RATE) * KECCAK_RATE + KECCAK_RATE);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let offset = 0; offset < padded.length; offset += KECCAK_RATE) {
    for (let i = 0; i < KECCAK_RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + k]);
      state[i] ^= lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let k = 0; k < 8; k++) { out[i * 8 + k] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex) {
  const raw = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (raw.length % 2 !== 0 || /[^0-9a-fA-F]/.test(raw)) throw new Error("not whole-byte hex");
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function addressFromPublicKey(publicKey) {
  if (publicKey.length !== 64) throw new Error("an EVM public key is 64 bytes");
  const hash = keccak256(publicKey);
  return `0x${toHex(hash.subarray(12))}`;
}

const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP_HALF_N = SECP_N / 2n;
const SECP_GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const SECP_GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function secpMod(value, modulus = SECP_P) {
  const remainder = value % modulus;
  return remainder >= 0n ? remainder : remainder + modulus;
}

function secpInv(value, modulus = SECP_P) {
  let base = secpMod(value, modulus);
  if (base === 0n) throw new Error("no inverse of zero");
  let exponent = modulus - 2n;
  let result = 1n;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

function secpAdd(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (secpMod(a.y + b.y) === 0n) return null;
    const slope = secpMod(3n * a.x * a.x * secpInv(2n * a.y));
    const x = secpMod(slope * slope - 2n * a.x);
    return { x, y: secpMod(slope * (a.x - x) - a.y) };
  }
  const slope = secpMod((b.y - a.y) * secpInv(b.x - a.x));
  const x = secpMod(slope * slope - a.x - b.x);
  return { x, y: secpMod(slope * (a.x - x) - a.y) };
}

function secpMul(point, scalar) {
  let n = secpMod(scalar, SECP_N);
  let result = null;
  let addend = point;
  while (n > 0n) {
    if (n & 1n) result = secpAdd(result, addend);
    addend = secpAdd(addend, addend);
    n >>= 1n;
  }
  return result;
}

function secpOnCurve(point) {
  return secpMod(point.y * point.y - point.x * point.x * point.x - 7n) === 0n;
}

function secpLiftX(x, odd) {
  if (x <= 0n || x >= SECP_P) return null;
  const rhs = secpMod(x * x * x + 7n);
  let base = rhs;
  let exponent = (SECP_P + 1n) / 4n;
  let y = 1n;
  while (exponent > 0n) {
    if (exponent & 1n) y = (y * base) % SECP_P;
    base = (base * base) % SECP_P;
    exponent >>= 1n;
  }
  if (secpMod(y * y) !== rhs) return null;
  const isOdd = (y & 1n) === 1n;
  return { x, y: odd === isOdd ? y : secpMod(-y) };
}

function parseSignature(signature) {
  const bytes = typeof signature === "string" ? fromHex(signature) : signature;
  if (bytes.length !== 65) throw new Error("an Ethereum signature is 65 bytes");
  const r = BigInt(`0x${toHex(bytes.subarray(0, 32))}`);
  const s = BigInt(`0x${toHex(bytes.subarray(32, 64))}`);
  let v = bytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error("invalid recovery byte");
  return { r, s, v };
}

/** The signer's address, or null for any malformed/malleable signature. */
export function recoverTypedDataSigner(digest, signature) {
  try {
    const digestBytes = fromHex(digest);
    if (digestBytes.length !== 32) return null;
    const { r, s, v } = parseSignature(signature);
    if (r <= 0n || r >= SECP_N || s <= 0n || s >= SECP_N || s > SECP_HALF_N) return null;
    const R = secpLiftX(r, v === 1);
    if (!R) return null;
    const z = BigInt(`0x${toHex(digestBytes)}`);
    const rInv = secpInv(r, SECP_N);
    const u1 = secpMod(-z * rInv, SECP_N);
    const u2 = secpMod(s * rInv, SECP_N);
    const Q = secpAdd(secpMul({ x: SECP_GX, y: SECP_GY }, u1), secpMul(R, u2));
    if (!Q || !secpOnCurve(Q)) return null;
    const publicKey = new Uint8Array(64);
    publicKey.set(fromHex(Q.x.toString(16).padStart(64, "0")), 0);
    publicKey.set(fromHex(Q.y.toString(16).padStart(64, "0")), 32);
    return addressFromPublicKey(publicKey);
  } catch {
    return null;
  }
}

function encodeType(types, primaryType) {
  const dependencies = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const fields = types[name];
    if (!fields) throw new Error(`EIP-712 type ${name} is not declared`);
    for (const field of fields) {
      const base = field.type.replace(/\[\d*\]$/, "");
      if (types[base]) dependencies.push(base);
    }
    for (const field of fields) {
      const base = field.type.replace(/\[\d*\]$/, "");
      if (types[base]) visit(base);
    }
  };
  visit(primaryType);
  return [primaryType, ...[...new Set(dependencies)].sort()].map((name) => `${name}(${types[name].map((field) => `${field.type} ${field.name}`).join(",")})`).join("");
}

function pad32(bytes) {
  if (bytes.length > 32) throw new Error("bytesN is at most 32 bytes");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function uintTo32(value, label) {
  let big;
  if (typeof value === "bigint") big = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
    big = BigInt(value);
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) big = BigInt(value);
  else throw new Error(`${label} must be an integer`);
  if (big < 0n) throw new Error(`${label} must not be negative`);
  const out = new Uint8Array(32);
  let n = big;
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  if (n !== 0n) throw new Error(`${label} does not fit in 32 bytes`);
  return out;
}

function encodeValue(types, type, value, label) {
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    return keccak256(value);
  }
  if (type === "bytes") {
    if (typeof value !== "string") throw new Error(`${label} must be hex`);
    return keccak256(fromHex(value));
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) {
    if (typeof value !== "string") throw new Error(`${label} must be hex`);
    const bytes = fromHex(value);
    if (bytes.length !== Number(fixed[1])) throw new Error(`${label} must be exactly ${fixed[1]} bytes`);
    return pad32(bytes);
  }
  if (type === "address") {
    if (typeof value !== "string" || !ADDRESS_RE.test(value)) throw new Error(`${label} must be an address`);
    const out = new Uint8Array(32);
    out.set(fromHex(value).subarray(0), 12);
    return out;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
    const out = new Uint8Array(32);
    out[31] = value ? 1 : 0;
    return out;
  }
  if (/^u?int\d*$/.test(type)) {
    if (type.startsWith("int") && typeof value === "number" && value < 0) throw new Error(`${label}: negative ints are not used`);
    return uintTo32(value, label);
  }
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    const inner = array[1];
    const size = array[2] ? Number(array[2]) : null;
    if (size !== null && value.length !== size) throw new Error(`${label} must have ${size} items`);
    const encoded = concatBytes(...value.map((item, index) => encodeValue(types, inner, item, `${label}[${index}]`)));
    return size === null ? keccak256(encoded) : encoded;
  }
  if (types[type]) return hashStruct(types, type, value, label);
  throw new Error(`EIP-712 type ${type} is not supported`);
}

function hashStruct(types, primaryType, data, label = primaryType) {
  const fields = types[primaryType];
  if (!fields) throw new Error(`EIP-712 type ${primaryType} is not declared`);
  if (!data || typeof data !== "object") throw new Error(`${label} must be an object`);
  const parts = [keccak256(encodeType(types, primaryType))];
  for (const field of fields) {
    const value = data[field.name];
    if (value === undefined) throw new Error(`${label}.${field.name} is missing`);
    parts.push(encodeValue(types, field.type, value, `${label}.${field.name}`));
  }
  return keccak256(concatBytes(...parts));
}

/** The 32-byte digest a wallet signs under EIP-712. */
export function typedDataDigest(data) {
  if (!data || typeof data !== "object" || !data.types || !data.primaryType || !data.domain || !data.message) throw new Error("incomplete typed data");
  if (!data.types[data.primaryType]) throw new Error("primary type is not declared");
  const domain = hashStruct(data.types, "EIP712Domain", data.domain, "domain");
  const message = hashStruct(data.types, data.primaryType, data.message);
  return `0x${toHex(keccak256(concatBytes(fromHex("0x1901"), domain, message)))}`;
}

/* ------------------------------------------------------------------ */
/* Untrusted EIP-6963 info and icon handling                           */
/* ------------------------------------------------------------------ */

const SVG_DANGER = [
  /<script\b/i, /<foreignobject\b/i, /<iframe\b/i, /<object\b/i, /<embed\b/i,
  /\son[a-z]+\s*=/i, /javascript:/i, /@import\b/i, /url\s*\(/i, /expression\s*\(/i,
  /<!doctype/i, /<!entity/i, /<(?:image|use)\b[^>]*(?:href|src)\s*=\s*["']https?:/i,
];

function base64ToBytes(text) {
  if (typeof globalThis.atob !== "function") return null;
  try {
    const binary = globalThis.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Returns a base64 data URL safe to assign to an <img>, or null. */
export function safeWalletIcon(value) {
  if (typeof value !== "string" || value.length > 160000) return null;
  const match = /^data:image\/(png|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = base64ToBytes(match[2]);
  if (!bytes || bytes.length === 0 || bytes.length > 120000) return null;
  if (match[1] === "svg+xml") {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
    if (SVG_DANGER.some((pattern) => pattern.test(text))) return null;
  }
  return `data:image/${match[1]};base64,${match[2]}`;
}

/**
 * Sanitizes wallet-supplied display metadata. This is never identity proof.
 * `uuid`, `rdns` and `name` are display strings; the provider reference is the
 * only thing the module uses to make a request.
 */
export function sanitizeWalletInfo(info) {
  const raw = info && typeof info === "object" && !Array.isArray(info) ? info : {};
  const warnings = [];
  let uuid = typeof raw.uuid === "string" ? raw.uuid.trim().toLowerCase() : "";
  if (!UUID_RE.test(uuid)) { if (uuid) warnings.push("invalid-uuid"); uuid = ""; }
  let rdns = cleanText(raw.rdns, 120);
  if (rdns && (!/^[a-z0-9](?:[a-z0-9.-]{0,118}[a-z0-9])?$/i.test(rdns) || rdns.includes(".."))) {
    warnings.push("invalid-rdns"); rdns = "";
  }
  let name = cleanText(raw.name, 80);
  if (!name) name = "未命名钱包";
  const icon = safeWalletIcon(raw.icon);
  if (raw.icon && !icon) warnings.push("icon-rejected");
  if (!raw.icon) warnings.push("missing-icon");
  return Object.freeze({ uuid, name, rdns, icon, identity: "unverified", source: "eip6963", warnings: Object.freeze(warnings) });
}

function legacyInfo() {
  return Object.freeze({ uuid: "", name: "旧式浏览器钱包（window.ethereum）", rdns: "", icon: null, identity: "unverified", source: "legacy", warnings: Object.freeze(["legacy-no-eip6963"]) });
}

/**
 * EIP-6963 discovery. It listens for announcements and dispatches one request;
 * it never reads or selects `window.ethereum` automatically. A legacy provider
 * is offered as an explicit `"legacy"` choice only.
 */
export function createWalletDiscovery(options = {}) {
  const target = options.target ?? (typeof globalThis.window !== "undefined" ? globalThis.window : null);
  const CustomEventCtor = options.CustomEvent ?? globalThis.CustomEvent;
  const EventCtor = options.Event ?? globalThis.Event;
  const now = options.now ?? Date.now;
  const records = new Map();
  let byProvider = new WeakMap();
  let sequence = 0;
  let started = false;
  let selectedId = null;
  let listener = null;
  const subscribers = new Set();

  function publicEntry(record) {
    return Object.freeze({
      id: record.id,
      uuid: record.info.uuid,
      name: record.info.name,
      rdns: record.info.rdns,
      icon: record.info.icon,
      identity: "unverified",
      source: record.info.source,
      warnings: Object.freeze([...record.info.warnings]),
      announcedAt: record.announcedAt,
      selected: record.id === selectedId,
    });
  }

  function notify() {
    const snapshot = list();
    for (const subscriber of [...subscribers]) {
      try { subscriber(snapshot); } catch { /* a listener must not break discovery */ }
    }
  }

  function recomputeDuplicates() {
    const counts = new Map();
    for (const record of records.values()) if (record.info.uuid) counts.set(record.info.uuid, (counts.get(record.info.uuid) ?? 0) + 1);
    for (const record of records.values()) {
      const base = record.info.warnings.filter((warning) => warning !== "duplicate-uuid" && warning !== "uuid-claimed-by-multiple-providers");
      if (record.info.uuid && counts.get(record.info.uuid) > 1) base.push("uuid-claimed-by-multiple-providers");
      record.info = Object.freeze({ ...record.info, warnings: Object.freeze(base) });
    }
  }

  function ingest(detail) {
    if (!detail || typeof detail !== "object") return null;
    const provider = detail.provider;
    if (!provider || typeof provider.request !== "function") return null;
    const info = sanitizeWalletInfo(detail.info);
    let id = byProvider.get(provider);
    if (!id) {
      id = `wallet-${++sequence}`;
      byProvider.set(provider, id);
    }
    records.set(id, { id, info, provider, announcedAt: now() });
    recomputeDuplicates();
    notify();
    return id;
  }

  function list() {
    return Object.freeze([...records.values()].map(publicEntry));
  }

  function select(id) {
    if (id === "legacy") {
      const provider = target && target.ethereum;
      if (!provider || typeof provider.request !== "function") throw fail(WALLET_ERROR.PROVIDER_INVALID, "没有可显式选择的旧式浏览器钱包");
      selectedId = "legacy";
      notify();
      return { id: "legacy", provider, info: legacyInfo() };
    }
    const record = records.get(id);
    if (!record) throw fail(WALLET_ERROR.PROVIDER_INVALID, "请先明确选择一个已发现的钱包");
    selectedId = record.id;
    notify();
    return { id: record.id, provider: record.provider, info: record.info };
  }

  function legacy() {
    if (!target || !target.ethereum || typeof target.ethereum.request !== "function") return null;
    return Object.freeze({ id: "legacy", ...legacyInfo(), selected: selectedId === "legacy", announcedAt: null });
  }

  function request() {
    if (!target || typeof target.dispatchEvent !== "function") return false;
    let event;
    if (typeof CustomEventCtor === "function") event = new CustomEventCtor(EIP6963_REQUEST, { bubbles: false, cancelable: false });
    else if (typeof EventCtor === "function") event = new EventCtor(EIP6963_REQUEST);
    else return false;
    target.dispatchEvent(event);
    return true;
  }

  function start() {
    if (started) return api;
    if (!target || typeof target.addEventListener !== "function") throw fail(WALLET_ERROR.DISCOVERY_UNAVAILABLE, "当前浏览器不支持钱包扩展发现");
    listener = (event) => {
      if (event && event.type === EIP6963_ANNOUNCE) ingest(event.detail);
    };
    target.addEventListener(EIP6963_ANNOUNCE, listener);
    started = true;
    request();
    return api;
  }

  function stop() {
    if (listener && target && typeof target.removeEventListener === "function") target.removeEventListener(EIP6963_ANNOUNCE, listener);
    listener = null;
    started = false;
    records.clear();
    byProvider = new WeakMap();
    selectedId = null;
    notify();
  }

  const api = {
    start,
    stop,
    dispose: stop,
    request,
    ingest,
    list,
    select,
    legacy,
    subscribe(callback) {
      if (typeof callback !== "function") return () => {};
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    get started() { return started; },
    get selectedId() { return selectedId; },
  };
  return Object.freeze(api);
}

/* ------------------------------------------------------------------ */
/* Exact amounts and registry lookups                                  */
/* ------------------------------------------------------------------ */

/** Exact base units -> decimal text, with no floating point. */
export function formatUnits(raw, decimals) {
  if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) throw new Error("a raw amount must be an unsigned integer string");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("unusable decimals");
  const value = BigInt(raw).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return value;
  const whole = value.slice(0, -decimals);
  const fraction = value.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseRawAmount(value, label = "amount") {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw fail(WALLET_ERROR.INVALID_AMOUNT, `${label} 必须是十进制整数最小单位`);
  const amount = BigInt(value);
  if (amount <= 0n) throw fail(WALLET_ERROR.INVALID_AMOUNT, `${label} 必须大于零`);
  if (amount > MAX_UINT256) throw fail(WALLET_ERROR.INVALID_AMOUNT, `${label} 超出 uint256`);
  return { raw: amount.toString(), big: amount };
}

function assetIdOf(chainId, contract) {
  return `eip155:${chainId}:${String(contract).toLowerCase()}`;
}

function registrySnapshot(registry) {
  let raw;
  try { raw = typeof registry === "function" ? registry() : registry; } catch { throw fail(WALLET_ERROR.INVALID_REGISTRY, "资产注册表不可读取"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail(WALLET_ERROR.INVALID_REGISTRY, "资产注册表格式无效");
  const networks = Array.isArray(raw.networks) ? raw.networks : [];
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  return { networks, assets };
}

function findNetwork(registry, chainId) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw fail(WALLET_ERROR.INVALID_CHAIN_ID, "chainId 无效");
  const matches = registrySnapshot(registry).networks.filter((network) => network && network.chainId === chainId);
  if (matches.length === 0) throw fail(WALLET_ERROR.UNKNOWN_CHAIN, `未登记 chainId ${chainId}`);
  if (matches.length > 1) throw fail(WALLET_ERROR.INVALID_REGISTRY, `chainId ${chainId} 在注册表重复`);
  const network = matches[0];
  if (network.family !== undefined && network.family !== "evm") throw fail(WALLET_ERROR.UNKNOWN_CHAIN, "只支持 EVM 网络");
  if (typeof network.enabled !== "boolean") throw fail(WALLET_ERROR.INVALID_REGISTRY, "网络 enabled 字段无效");
  if (network.networkType !== "testnet" && network.networkType !== "mainnet") throw fail(WALLET_ERROR.UNKNOWN_CHAIN, "未知网络类型");
  // C-registry contract: enabled is a watcher/credit switch, not a display flag.
  // Missing support/receivable metadata is not treated as safe.
  if (network.support !== "credit" && network.support !== "read-only") throw fail(WALLET_ERROR.INVALID_REGISTRY, "网络缺少有效 support 字段");
  if (typeof network.receivable !== "boolean") throw fail(WALLET_ERROR.INVALID_REGISTRY, "网络缺少有效 receivable 字段");
  const displayName = cleanText(network.displayName, 80) || `chainId ${chainId}`;
  const nativeSymbol = cleanText(network.nativeSymbol, 16) || "ETH";
  const nativeDecimals = network.nativeDecimals === undefined ? 18 : network.nativeDecimals;
  if (!Number.isInteger(nativeDecimals) || nativeDecimals < 0 || nativeDecimals > 36) throw fail(WALLET_ERROR.UNKNOWN_DECIMALS, "原生代币精度无效");
  return {
    chainId, displayName, nativeSymbol, nativeDecimals, networkType: network.networkType,
    enabled: network.enabled, support: network.support, receivable: network.receivable,
  };
}

const KNOWN_ISSUERS = new Set(["mock", "native-issuer", "bridged"]);

function findAsset(registry, assetId) {
  if (typeof assetId !== "string" || assetId.length > 160) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币标识无效");
  const matches = registrySnapshot(registry).assets.filter((asset) => asset && asset.assetId === assetId);
  if (matches.length === 0) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币未登记");
  if (matches.length > 1) throw fail(WALLET_ERROR.INVALID_REGISTRY, "代币标识在注册表重复");
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.chainId) || asset.chainId <= 0) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币 chainId 无效");
  if (typeof asset.contractAddress !== "string" || !ADDRESS_RE.test(asset.contractAddress) || /^0x0{40}$/i.test(asset.contractAddress)) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币合约地址无效");
  if (asset.assetId !== assetIdOf(asset.chainId, asset.contractAddress)) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币标识与网络/合约不一致");
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) throw fail(WALLET_ERROR.UNKNOWN_DECIMALS, "代币精度无效");
  if (!KNOWN_ISSUERS.has(asset.issuerType)) throw fail(WALLET_ERROR.UNKNOWN_ISSUER, "代币发行方类型未知");
  if (typeof asset.enabled !== "boolean") throw fail(WALLET_ERROR.INVALID_REGISTRY, "代币 enabled 字段无效");
  // C-registry contract: missing credit/pricing metadata is not treated as safe.
  if (typeof asset.credit !== "boolean") throw fail(WALLET_ERROR.INVALID_REGISTRY, "代币缺少有效 credit 字段");
  // Internal AssetRecord uses pricing.kind; WalletStatus/page snapshots project
  // the same value as pricingKind. Accept exactly one consistent shape.
  const pricingKind = asset.pricing && typeof asset.pricing === "object" ? asset.pricing.kind : asset.pricingKind;
  if (asset.pricing && typeof asset.pricing === "object" && asset.pricingKind !== undefined && asset.pricingKind !== pricingKind) throw fail(WALLET_ERROR.INVALID_REGISTRY, "代币 pricing.kind 与 pricingKind 不一致");
  if (pricingKind !== "fixed-test-rate" && pricingKind !== "not-creditable") throw fail(WALLET_ERROR.INVALID_REGISTRY, "代币缺少有效 pricing.kind/pricingKind");
  if (asset.credit !== (pricingKind === "fixed-test-rate")) throw fail(WALLET_ERROR.INVALID_REGISTRY, "代币 credit 与 pricing 不一致");
  const symbol = cleanText(asset.symbol, 32);
  if (!symbol) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币符号无效");
  return {
    assetId: asset.assetId,
    chainId: asset.chainId,
    contractAddress: asset.contractAddress,
    symbol,
    decimals: asset.decimals,
    issuerType: asset.issuerType,
    testnetOnly: asset.testnetOnly === true,
    enabled: asset.enabled,
    credit: asset.credit,
    pricingKind,
  };
}

function assertSendableNetwork(network, allowedChainIds) {
  // ChainId is the hard gate: a forged networkType="testnet" on 56/8453 still
  // fails here. Do not replace this with a metadata-only check.
  assertNoMainnetSend(network.chainId);
  if (network.networkType !== "testnet") throw fail(WALLET_ERROR.UNKNOWN_CHAIN, "只允许测试网");
  if (!allowedChainIds.has(network.chainId)) throw fail(WALLET_ERROR.UNKNOWN_CHAIN, "该测试网不在允许列表");
  if (!network.enabled) throw fail(WALLET_ERROR.CHAIN_DISABLED, `chainId ${network.chainId} 未启用`);
  if (network.support !== "credit") throw fail(WALLET_ERROR.NETWORK_NOT_CREDITABLE, "该网络只读，不能发送/授信");
  if (!network.receivable) throw fail(WALLET_ERROR.NETWORK_NOT_CREDITABLE, "该网络未开启收款");
}

function assertSendableAsset(asset, network) {
  if (asset.chainId !== network.chainId) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币不属于当前网络");
  if (!asset.enabled) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币未启用");
  if (!asset.testnetOnly) throw fail(WALLET_ERROR.UNKNOWN_ISSUER, "只允许 testnetOnly 代币");
  if (asset.issuerType !== "mock") throw fail(WALLET_ERROR.UNKNOWN_ISSUER, "当前只允许已登记的 mock 测试代币");
  if (!asset.credit) throw fail(WALLET_ERROR.ASSET_NOT_CREDITABLE, "该代币不可授信/入账");
  if (asset.pricingKind !== "fixed-test-rate") throw fail(WALLET_ERROR.ASSET_NOT_CREDITABLE, "该代币没有可授信的固定测试价格");
}

/** A signature is not credit, but it still needs a credit-capable testnet record. */
function assertDepositNetworkKnown(registry, chainId) {
  if (registry === undefined || registry === null) throw fail(WALLET_ERROR.UNKNOWN_CHAIN, "签名需要本地网络登记；未提供注册表");
  const network = findNetwork(registry, chainId);
  assertNoMainnetSend(chainId);
  if (network.networkType !== "testnet") throw fail(WALLET_ERROR.MAINNET_BLOCKED, "主网签名请求被阻断");
  if (!network.enabled || network.support !== "credit" || !network.receivable) throw fail(WALLET_ERROR.NETWORK_NOT_CREDITABLE, "该测试网当前只读或未开启收款，不能签名");
}

/** Signing never credits, but the asset must always be locally registered. */
function assertDepositAssetKnown(registry, checked) {
  if (registry === undefined || registry === null) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "签名需要本地资产登记；未提供注册表");
  const asset = findAsset(registry, checked.asset.assetId);
  if (asset.chainId !== checked.chainId) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币不属于请求网络");
  if (!asset.enabled) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币未启用");
  if (!asset.testnetOnly) throw fail(WALLET_ERROR.UNKNOWN_ISSUER, "代币不是测试网专用");
  if (asset.issuerType !== "mock") throw fail(WALLET_ERROR.UNKNOWN_ISSUER, "代币发行方类型不被当前签名策略接受");
  if (!asset.credit) throw fail(WALLET_ERROR.ASSET_NOT_CREDITABLE, "代币不可授信/入账");
  if (asset.pricingKind !== "fixed-test-rate") throw fail(WALLET_ERROR.ASSET_NOT_CREDITABLE, "代币没有可授信的固定测试价格");
  if (asset.decimals !== checked.asset.decimals) throw fail(WALLET_ERROR.UNKNOWN_DECIMALS, "代币精度与本地登记不一致");
}

/* ------------------------------------------------------------------ */
/* Deposit document verification                                       */
/* ------------------------------------------------------------------ */

/**
 * Verifies the exact server-issued deposit request: strict keys, chain, asset
 * tuple, amount, expiry, EIP-712 domain/types/message and the recomputed digest.
 * This function verifies the document only; signDeposit separately requires a
 * locally registered, credit-capable asset and testnet network. A caller cannot
 * turn a valid-looking document into credit or a transfer with this function.
 */
export function validateDepositDocument(document, options = {}) {
  const now = options.now ?? Date.now();
  const allowed = options.allowedChainIds ? new Set(options.allowedChainIds) : new Set(TESTNET_CHAIN_IDS);
  const d = exactKeys(document, ["schema", "invoiceId", "consumerId", "providerId", "chainId", "asset", "amount", "recipientAddress", "expiresAt", "digest", "typedData"], "请求");
  if (d.schema !== "ohmyaihub.deposit-request/v1") throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "不是充值请求文件");
  if (!Number.isSafeInteger(d.chainId) || d.chainId <= 0) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "chainId 无效");
  assertNoMainnetSend(d.chainId);
  if (!allowed.has(d.chainId)) throw fail(WALLET_ERROR.UNKNOWN_CHAIN, "请求不是允许的测试网络");
  if (options.expectedChainId !== undefined && options.expectedChainId !== d.chainId) throw fail(WALLET_ERROR.CHAIN_MISMATCH, "请求网络与预期不一致");
  const invoiceId = textValue(d.invoiceId, "请求编号");
  const consumerId = textValue(d.consumerId, "消费者");
  const providerId = textValue(d.providerId, "提供方");
  if (typeof d.recipientAddress !== "string" || !ADDRESS_RE.test(d.recipientAddress) || d.recipientAddress.toLowerCase() === ZERO_ADDRESS) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "收款地址无效");
  const asset = exactKeys(d.asset, ["assetId", "contractAddress", "symbol", "decimals"], "代币");
  if (typeof asset.contractAddress !== "string" || !ADDRESS_RE.test(asset.contractAddress) || asset.contractAddress.toLowerCase() === ZERO_ADDRESS) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "代币合约地址无效");
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) throw fail(WALLET_ERROR.UNKNOWN_DECIMALS, "代币精度无效");
  if (asset.assetId !== assetIdOf(d.chainId, asset.contractAddress)) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币标识与网络/合约不一致");
  const symbol = textValue(asset.symbol, "代币符号", 32);
  const amount = exactKeys(d.amount, ["tokens", "raw"], "金额");
  const parsed = parseRawAmount(amount.raw, "请求金额");
  if (typeof amount.tokens !== "string" || amount.tokens !== formatUnits(parsed.raw, asset.decimals)) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "显示金额与最小单位不一致");
  if (typeof d.expiresAt !== "string") throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "有效期不是时间");
  const expiresMs = Date.parse(d.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "请求已过期或有效期无效");
  const typed = exactKeys(d.typedData, ["types", "primaryType", "domain", "message"], "EIP-712 数据");
  if (canonicalJson(typed.types) !== canonicalJson(DEPOSIT_TYPES) || typed.primaryType !== "DepositIntent") throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "EIP-712 类型不符合充值规范");
  const domain = exactKeys(typed.domain, ["name", "version", "chainId", "verifyingContract"], "EIP-712 domain");
  if (domain.name !== DEPOSIT_DOMAIN_NAME || domain.version !== DEPOSIT_DOMAIN_VERSION || domain.chainId !== d.chainId || !sameAddress(domain.verifyingContract, DEPOSIT_VERIFYING_CONTRACT)) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "EIP-712 domain 不符合充值规范");
  const message = exactKeys(typed.message, ["invoiceId", "consumerId", "providerId", "chainId", "assetId", "tokenContract", "recipient", "expectedAmountRaw", "nonce", "requestedAt", "expiresAt"], "EIP-712 message");
  if (message.invoiceId !== invoiceId || message.consumerId !== consumerId || message.providerId !== providerId || message.chainId !== d.chainId || message.assetId !== asset.assetId || message.tokenContract !== asset.contractAddress || message.recipient !== d.recipientAddress || message.expectedAmountRaw !== parsed.raw) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "显示内容与签名 message 不一致");
  if (typeof message.nonce !== "string" || !/^0x[0-9a-fA-F]{32}$/.test(message.nonce)) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "nonce 无效");
  if (!Number.isSafeInteger(message.requestedAt) || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= message.requestedAt || message.expiresAt - message.requestedAt > 604800) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "请求时间或有效期无效");
  if (Math.floor(expiresMs / 1000) !== message.expiresAt) throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "有效期与签名 message 不一致");
  let computed;
  try { computed = typedDataDigest(typed); } catch { throw fail(WALLET_ERROR.INVALID_DEPOSIT_DOCUMENT, "EIP-712 数据无法计算摘要"); }
  if (typeof d.digest !== "string" || !HEX_32_RE.test(d.digest) || d.digest.toLowerCase() !== computed.toLowerCase()) throw fail(WALLET_ERROR.DIGEST_MISMATCH, "请求摘要与 EIP-712 数据不一致");
  const expected = options.expectedDigest ?? options.expectedIntentHash;
  if (expected !== undefined && (typeof expected !== "string" || !HEX_32_RE.test(expected) || expected.toLowerCase() !== computed.toLowerCase())) throw fail(WALLET_ERROR.DIGEST_MISMATCH, "签名摘要与服务校验摘要不一致");
  return Object.freeze({
    schema: d.schema, invoiceId, consumerId, providerId, chainId: d.chainId,
    asset: Object.freeze({ assetId: asset.assetId, contractAddress: asset.contractAddress, symbol, decimals: asset.decimals }),
    amount: Object.freeze({ tokens: formatUnits(parsed.raw, asset.decimals), raw: parsed.raw }),
    recipientAddress: d.recipientAddress, expiresAt: d.expiresAt, digest: computed,
    typedData: cloneJson(typed),
  });
}

/* ------------------------------------------------------------------ */
/* EIP-1193 session: explicit connect, sign and testnet ERC-20 send     */
/* ------------------------------------------------------------------ */

function parseChainId(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw fail(WALLET_ERROR.INVALID_CHAIN_ID, "钱包返回的 chainId 不是十六进制");
  const big = BigInt(value);
  if (big <= 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(WALLET_ERROR.INVALID_CHAIN_ID, "钱包返回的 chainId 超出范围");
  return Number(big);
}

function parseQuantity(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw fail(WALLET_ERROR.RPC_UNKNOWN, `${label} 不是有效的十六进制数量`);
  return BigInt(value);
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function encodeErc20Transfer(recipient, amountRaw) {
  const addressWord = recipient.toLowerCase().slice(2).padStart(64, "0");
  const amountWord = BigInt(amountRaw).toString(16).padStart(64, "0");
  return `0xa9059cbb${addressWord}${amountWord}`;
}

function calldataHashOf(data) {
  return `0x${toHex(keccak256(fromHex(data)))}`;
}

/** Exact fields a durable service journal must bind; never previewId-only. */
function operationOf(preview) {
  return Object.freeze({
    schema: "ohmyaihub.external-wallet.operation/v1",
    intentHash: preview.intentHash,
    account: preview.account,
    chainId: preview.chainId,
    assetId: preview.assetId,
    contractAddress: preview.contractAddress,
    recipientAddress: preview.recipientAddress,
    amountRaw: preview.amountRaw,
    calldata: preview.call.data,
    calldataHash: preview.calldataHash,
  });
}

function normalizeProviderError(error) {
  if (error instanceof ExternalWalletError) return error;
  const rawCode = error && typeof error === "object" ? error.code : undefined;
  const code = typeof rawCode === "string" && /^-?\d+$/.test(rawCode) ? Number(rawCode) : rawCode;
  if (code === 4001 || code === "ACTION_REJECTED") return fail(WALLET_ERROR.USER_REJECTED, "你已取消钱包操作。", { providerCode: code ?? null });
  if (code === 4100) return fail(WALLET_ERROR.UNAUTHORIZED, "钱包未授权或已锁定；请解锁后重新明确操作。", { providerCode: code });
  if (code === 4200 || code === -32601) return fail(WALLET_ERROR.UNSUPPORTED_METHOD, "钱包不支持这个只读标准方法。", { providerCode: code });
  if (code === 4900) return fail(WALLET_ERROR.DISCONNECTED, "钱包已断开；本模块不会自动重连或重发。", { providerCode: code });
  if (code === 4901) return fail(WALLET_ERROR.CHAIN_NOT_ADDED, "钱包尚未添加目标网络；请在钱包中手动添加，本模块不会自动添加。", { providerCode: code });
  if (code === -32002) return fail(WALLET_ERROR.REQUEST_PENDING, "钱包已有待处理请求；请先完成或取消它。", { providerCode: code });
  return fail(WALLET_ERROR.WALLET_ERROR, "钱包请求未完成；未自动重试。", { providerCode: code ?? null });
}

function timeoutError() {
  return fail(WALLET_ERROR.WALLET_TIMEOUT, "钱包操作超时；结果未知，未自动重试。");
}

function validateAccounts(value) {
  if (!Array.isArray(value)) throw fail(WALLET_ERROR.INVALID_ACCOUNT, "钱包返回的账户不是数组");
  const out = [];
  for (const account of value) {
    if (typeof account !== "string" || !ADDRESS_RE.test(account)) throw fail(WALLET_ERROR.INVALID_ACCOUNT, "钱包返回了无效公开账户");
    if (!out.some((known) => sameAddress(known, account))) out.push(account);
  }
  return out;
}

function assertExplicit(options) {
  if (!options || options.userInitiated !== true) throw fail(WALLET_ERROR.EXPLICIT_ACTION_REQUIRED, "请由用户明确发起此钱包操作");
}

/**
 * Creates one explicit EIP-1193 session for the selected provider. Construction
 * does not call the provider; `connect({userInitiated:true})` does.
 */
export function createExternalWallet(options = {}) {
  const discovery = options.discovery;
  if (!discovery || typeof discovery.select !== "function") throw fail(WALLET_ERROR.PROVIDER_INVALID, "缺少钱包发现");
  const selection = discovery.select(options.selectionId);
  let activeProvider = selection.provider;
  if (!activeProvider || typeof activeProvider.request !== "function") throw fail(WALLET_ERROR.PROVIDER_INVALID, "所选钱包没有 EIP-1193 request");
  const registry = options.registry;
  const operationPort = options.operationPort ?? null;
  const requiredPortMethods = ["reserve", "markBroadcasting", "recordHash", "recordUnknown", "query"];
  if (operationPort !== null && (typeof operationPort !== "object" || requiredPortMethods.some((name) => typeof operationPort[name] !== "function"))) {
    throw fail(WALLET_ERROR.OPERATION_JOURNAL_REQUIRED, "operationPort 必须实现 reserve/markBroadcasting/recordHash/recordUnknown/query");
  }
  const allowMainnetRead = options.allowMainnetRead === true;
  const allowedChainIds = new Set(Array.isArray(options.allowedChainIds) ? options.allowedChainIds : TESTNET_CHAIN_IDS);
  const now = options.now ?? Date.now;
  const timeouts = options.timeouts ?? {};
  const rpcMs = timeouts.rpcMs ?? 15000;
  const connectMs = timeouts.connectMs ?? 120000;
  const signMs = timeouts.signMs ?? 180000;
  const switchMs = timeouts.switchMs ?? 120000;
  const sendMs = timeouts.sendMs ?? 180000;
  const previewTtlMs = options.previewTtlMs ?? 120000;
  if (!Number.isFinite(previewTtlMs) || previewTtlMs < 1000 || previewTtlMs > 300000) throw fail(WALLET_ERROR.INVALID_REGISTRY, "previewTtlMs 无效");
  let explicitlyConnected = false;
  let status = "idle";
  let accounts = [];
  let account = null;
  let chainId = null;
  let generation = 0;
  let disposed = false;
  let lastError = null;
  const subscribers = new Set();
  const previews = new WeakMap();
  const cleanups = [];

  function snapshot() {
    return Object.freeze({
      status, account, accounts: Object.freeze([...accounts]), chainId, generation, disposed, lastError,
      selection: Object.freeze({
        id: selection.id, name: selection.info.name, rdns: selection.info.rdns, uuid: selection.info.uuid,
        identity: "unverified", source: selection.info.source, warnings: Object.freeze([...(selection.info.warnings ?? [])]),
      }),
    });
  }

  function emit() {
    const state = snapshot();
    for (const subscriber of [...subscribers]) {
      try { subscriber(state); } catch { /* a listener must not break the wallet session */ }
    }
  }

  function applyState(list, nextChainId) {
    const changed = list.length !== accounts.length || list.some((value, index) => !sameAddress(value, accounts[index])) || nextChainId !== chainId;
    accounts = [...list];
    account = list[0] ?? null;
    chainId = nextChainId;
    if (!accounts.length) { status = "disconnected"; explicitlyConnected = false; }
    else status = explicitlyConnected ? "connected" : "idle";
    if (changed) generation++;
    emit();
  }

  function bump(reason) {
    generation++;
    lastError = reason ?? null;
    emit();
  }

  function assertUsable() {
    if (disposed) throw fail(WALLET_ERROR.DISPOSED, "钱包会话已关闭");
    if (!explicitlyConnected || status !== "connected" || !account || chainId === null) throw fail(WALLET_ERROR.NOT_CONNECTED, "请先明确连接钱包");
  }

  function assertCurrent(expected) {
    if (disposed) throw fail(WALLET_ERROR.DISPOSED, "钱包会话已关闭");
    if (expected !== generation) throw fail(WALLET_ERROR.WALLET_STATE_CHANGED, "钱包账户或网络已变化；请重新核对后再操作");
  }

  async function providerRequest(method, params, timeoutMs) {
    if (disposed || !activeProvider) throw fail(WALLET_ERROR.DISPOSED, "钱包会话已关闭");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw fail(WALLET_ERROR.WALLET_ERROR, "钱包超时配置无效");
    let timer;
    const call = Promise.resolve().then(() => activeProvider.request({ method, params }));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } catch (error) {
      throw normalizeProviderError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readCurrentState() {
    const rawAccounts = await providerRequest("eth_accounts", [], rpcMs);
    const list = validateAccounts(rawAccounts);
    const rawChain = await providerRequest("eth_chainId", [], rpcMs);
    const parsed = parseChainId(rawChain);
    return { list, chainId: parsed };
  }

  function attachEvents() {
    if (!activeProvider || typeof activeProvider.on !== "function") return;
    const add = (event, handler) => {
      try { activeProvider.on(event, handler); } catch { return; }
      const remove = activeProvider.removeListener ?? activeProvider.off;
      cleanups.push(() => { try { if (typeof remove === "function") remove.call(activeProvider, event, handler); } catch { /* already gone */ } });
    };
    add("accountsChanged", (next) => {
      try {
        const list = validateAccounts(next);
        applyState(list, chainId);
      } catch {
        status = "error"; lastError = WALLET_ERROR.INVALID_ACCOUNT; bump(WALLET_ERROR.INVALID_ACCOUNT);
      }
    });
    add("chainChanged", (next) => {
      try {
        const parsed = parseChainId(next);
        applyState(accounts, parsed);
      } catch {
        chainId = null; status = "error"; lastError = WALLET_ERROR.INVALID_CHAIN_ID; bump(WALLET_ERROR.INVALID_CHAIN_ID);
      }
    });
    add("disconnect", () => {
      explicitlyConnected = false; accounts = []; account = null;
      status = "disconnected"; bump(WALLET_ERROR.DISCONNECTED);
    });
    add("connect", (info) => {
      if (!info || typeof info !== "object" || info.chainId === undefined) return;
      try { applyState(accounts, parseChainId(info.chainId)); } catch { /* ignore malformed connect info */ }
    });
  }

  attachEvents();

  async function connect(options = {}) {
    assertExplicit(options);
    if (disposed) throw fail(WALLET_ERROR.DISPOSED, "钱包会话已关闭");
    if (explicitlyConnected && status === "connected" && account && chainId !== null) return snapshot();
    status = "connecting"; lastError = null; emit();
    try {
      const raw = await providerRequest("eth_requestAccounts", [], connectMs);
      const list = validateAccounts(raw);
      if (!list.length) throw fail(WALLET_ERROR.NO_ACCOUNT, "钱包没有返回可用公开账户");
      const parsed = parseChainId(await providerRequest("eth_chainId", [], rpcMs));
      explicitlyConnected = true;
      accounts = [...list]; account = list[0]; chainId = parsed; status = "connected"; generation++;
      emit();
      return snapshot();
    } catch (error) {
      status = "error"; lastError = error.code ?? WALLET_ERROR.WALLET_ERROR; emit();
      throw error;
    }
  }

  async function refresh() {
    if (disposed) throw fail(WALLET_ERROR.DISPOSED, "钱包会话已关闭");
    if (!explicitlyConnected) throw fail(WALLET_ERROR.NOT_CONNECTED, "请先明确连接钱包");
    const current = await readCurrentState();
    applyState(current.list, current.chainId);
    return snapshot();
  }

  async function requestSwitchChain(target, options = {}) {
    assertExplicit(options);
    assertUsable();
    if (!Number.isSafeInteger(target) || target <= 0) throw fail(WALLET_ERROR.INVALID_CHAIN_ID, "目标 chainId 无效");
    if (isMainnetChainId(target)) {
      if (!allowMainnetRead) throw fail(WALLET_ERROR.MAINNET_BLOCKED, "主网仅允许只读，且需显式允许；本会话默认阻断");
      const network = findNetwork(registry, target);
      if (network.networkType !== "mainnet" || network.support !== "read-only") throw fail(WALLET_ERROR.INVALID_REGISTRY, "目标不是已登记的只读主网");
    } else {
      const network = findNetwork(registry, target);
      if (!allowedChainIds.has(network.chainId) || network.networkType !== "testnet") throw fail(WALLET_ERROR.UNKNOWN_CHAIN, "目标测试网不在允许列表");
    }
    if (chainId === target) return Object.freeze({ chainId, already: true, generation });
    const before = generation;
    try {
      await providerRequest("wallet_switchEthereumChain", [{ chainId: toQuantity(target) }], switchMs);
    } catch (error) {
      if (error.code === WALLET_ERROR.CHAIN_NOT_ADDED) throw error;
      throw error;
    }
    const current = await readCurrentState();
    applyState(current.list, current.chainId);
    if (current.chainId !== target) throw fail(WALLET_ERROR.CHAIN_MISMATCH, "钱包未切换到目标网络；没有自动重试");
    if (generation === before) generation++;
    lastError = null;
    emit();
    return Object.freeze({ chainId: current.chainId, already: false, generation });
  }

  async function readBalances(options = {}) {
    assertUsable();
    const current = await readCurrentState();
    applyState(current.list, current.chainId);
    assertUsable();
    const network = findNetwork(registry, current.chainId);
    const mainnet = isMainnetChainId(network.chainId) || network.networkType === "mainnet";
    if (mainnet) {
      if (!allowMainnetRead) throw fail(WALLET_ERROR.MAINNET_BLOCKED, "主网只读需要显式允许");
      if (network.support !== "read-only") throw fail(WALLET_ERROR.INVALID_REGISTRY, "主网记录不是 read-only，拒绝读取");
    }
    const readOnly = mainnet || network.support === "read-only";
    const creditEligible = !mainnet && network.networkType === "testnet" && network.enabled && network.support === "credit" && network.receivable;
    const wanted = options.assetId;
    let asset = null;
    if (wanted !== undefined) {
      asset = findAsset(registry, wanted);
      if (asset.chainId !== network.chainId) throw fail(WALLET_ERROR.CHAIN_MISMATCH, "代币不属于当前网络");
      if (!asset.enabled) throw fail(WALLET_ERROR.UNKNOWN_TOKEN, "代币未启用");
    }
    const startedGen = generation;
    const nativeRaw = parseQuantity(await providerRequest("eth_getBalance", [account, "latest"], rpcMs), "原生余额");
    let token = null;
    if (asset) {
      const result = await providerRequest("eth_call", [{ to: asset.contractAddress, data: `0x70a08231${account.toLowerCase().slice(2).padStart(64, "0")}` }, "latest"], rpcMs);
      if (typeof result !== "string" || !/^0x[0-9a-f]+$/i.test(result) || result.length > 66) throw fail(WALLET_ERROR.RPC_UNKNOWN, "代币余额返回值无法识别");
      token = Object.freeze({ assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, raw: BigInt(result).toString(), formatted: formatUnits(BigInt(result).toString(), asset.decimals) });
    }
    assertCurrent(startedGen);
    return Object.freeze({
      chainId: network.chainId, account, generation, readOnly, creditEligible, usdValue: null,
      native: Object.freeze({ symbol: network.nativeSymbol, decimals: network.nativeDecimals, raw: nativeRaw.toString(), formatted: formatUnits(nativeRaw.toString(), network.nativeDecimals) }),
      token,
      at: new Date(now()).toISOString(),
    });
  }

  async function signDeposit(document, options = {}) {
    assertExplicit(options);
    assertUsable();
    const checked = validateDepositDocument(document, {
      now: now(), allowedChainIds,
      expectedDigest: options.expectedDigest,
      expectedIntentHash: options.expectedIntentHash,
    });
    assertDepositNetworkKnown(registry, checked.chainId);
    assertDepositAssetKnown(registry, checked);
    const current = await readCurrentState();
    applyState(current.list, current.chainId);
    assertUsable();
    if (current.chainId !== checked.chainId) throw fail(WALLET_ERROR.CHAIN_MISMATCH, "钱包当前网络与请求不一致；请由用户显式切换网络，本模块不会自动切换");
    if (!current.list.some((value) => sameAddress(value, account))) throw fail(WALLET_ERROR.WALLET_STATE_CHANGED, "钱包账户在签名前发生变化");
    const startedGen = generation;
    const signature = await providerRequest("eth_signTypedData_v4", [account, JSON.stringify(checked.typedData)], signMs);
    assertCurrent(startedGen);
    const after = await readCurrentState();
    applyState(after.list, after.chainId);
    if (after.chainId !== checked.chainId || !after.list.some((value) => sameAddress(value, account))) throw fail(WALLET_ERROR.WALLET_STATE_CHANGED, "钱包账户或网络在签名期间变化；签名已丢弃");
    if (typeof signature !== "string" || !HEX_65_RE.test(signature)) throw fail(WALLET_ERROR.INVALID_SIGNATURE, "钱包返回的签名格式无法识别");
    const recovered = recoverTypedDataSigner(checked.digest, signature);
    if (!recovered || !sameAddress(recovered, account)) throw fail(WALLET_ERROR.INVALID_SIGNATURE, "签名无法恢复为当前钱包账户；签名已丢弃");
    return Object.freeze({ signature, payerAddress: recovered, digest: checked.digest, chainId: checked.chainId, expiresAt: checked.expiresAt, generation });
  }

  async function prepareTransfer(options = {}) {
    assertExplicit(options);
    assertUsable();
    const current = await readCurrentState();
    applyState(current.list, current.chainId);
    assertUsable();
    const network = findNetwork(registry, current.chainId);
    assertSendableNetwork(network, allowedChainIds);
    if (current.chainId !== network.chainId) throw fail(WALLET_ERROR.CHAIN_MISMATCH, "钱包网络与预览网络不一致");
    const asset = findAsset(registry, options.assetId);
    assertSendableAsset(asset, network);
    const recipient = options.recipientAddress;
    if (typeof recipient !== "string" || !ADDRESS_RE.test(recipient) || recipient.toLowerCase() === ZERO_ADDRESS) throw fail(WALLET_ERROR.INVALID_ADDRESS, "收款地址无效");
    const amount = parseRawAmount(options.amountRaw, "转账金额");
    const rawIntentHash = options.intentHash === undefined ? null : options.intentHash;
    if (rawIntentHash !== null && (typeof rawIntentHash !== "string" || !HEX_32_RE.test(rawIntentHash))) throw fail(WALLET_ERROR.INVALID_INTENT_HASH, "intentHash 必须是 32 字节十六进制");
    const intentHash = rawIntentHash === null ? null : rawIntentHash.toLowerCase();
    const startedGen = generation;
    const tokenRaw = parseQuantity(await providerRequest("eth_call", [{ to: asset.contractAddress, data: `0x70a08231${account.toLowerCase().slice(2).padStart(64, "0")}` }, "latest"], rpcMs), "代币余额");
    const nativeRaw = parseQuantity(await providerRequest("eth_getBalance", [account, "latest"], rpcMs), "原生余额");
    const callData = encodeErc20Transfer(recipient, amount.raw);
    let gasLimit;
    try {
      gasLimit = parseQuantity(await providerRequest("eth_estimateGas", [{ from: account, to: asset.contractAddress, value: "0x0", data: callData }], rpcMs), "gas 估算");
    } catch (error) {
      if (error instanceof ExternalWalletError && error.code === WALLET_ERROR.WALLET_ERROR) throw fail(WALLET_ERROR.GAS_ESTIMATE_FAILED, "无法估算 ERC-20 转账 gas；未创建预览", { providerCode: error.providerCode });
      throw error;
    }
    const gasPrice = parseQuantity(await providerRequest("eth_gasPrice", [], rpcMs), "gas 价格");
    if (gasLimit <= 0n || gasPrice <= 0n) throw fail(WALLET_ERROR.GAS_ESTIMATE_FAILED, "gas 估算为零，无法安全预览");
    const feeRaw = gasLimit * gasPrice;
    const blockers = [];
    if (tokenRaw < amount.big) blockers.push("代币余额不足");
    if (nativeRaw < feeRaw) blockers.push("原生余额不足以支付 gas");
    assertCurrent(startedGen);
    const previewId = randomId();
    const expiresAtMs = now() + previewTtlMs;
    const preview = Object.freeze({
      schema: "ohmyaihub.external-wallet.transfer-preview/v1",
      previewId,
      chainId: network.chainId,
      chainIdHex: toQuantity(network.chainId),
      account,
      assetId: asset.assetId,
      contractAddress: asset.contractAddress,
      symbol: asset.symbol,
      decimals: asset.decimals,
      amountRaw: amount.raw,
      amountTokens: formatUnits(amount.raw, asset.decimals),
      recipientAddress: recipient,
      nativeSymbol: network.nativeSymbol,
      nativeDecimals: network.nativeDecimals,
      nativeBalanceRaw: nativeRaw.toString(),
      nativeBalance: formatUnits(nativeRaw.toString(), network.nativeDecimals),
      tokenBalanceRaw: tokenRaw.toString(),
      tokenBalance: formatUnits(tokenRaw.toString(), asset.decimals),
      gasLimitRaw: gasLimit.toString(),
      gasLimitHex: toQuantity(gasLimit),
      gasPriceRaw: gasPrice.toString(),
      gasPriceHex: toQuantity(gasPrice),
      estimatedFeeRaw: feeRaw.toString(),
      estimatedFeeNative: formatUnits(feeRaw.toString(), network.nativeDecimals),
      feeModel: "legacy-gas-price",
      intentHash,
      calldataHash: calldataHashOf(callData),
      call: Object.freeze({ to: asset.contractAddress, value: "0x0", data: callData }),
      blockers: Object.freeze(blockers),
      canSend: blockers.length === 0,
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      generation,
    });
    previews.set(preview, { preview, status: "preview", hash: null, promise: null, error: null, attemptedSend: false });
    return preview;
  }

  async function confirmTransfer(preview, options = {}) {
    assertExplicit(options);
    if (options.acknowledged !== true) throw fail(WALLET_ERROR.PREVIEW_CONFIRMATION_REQUIRED, "请逐笔核对并明确确认这笔转账");
    if (!preview || typeof preview !== "object" || !previews.has(preview)) throw fail(WALLET_ERROR.PREVIEW_NOT_ISSUED, "只能确认本模块生成的转账预览");
    if (options.previewId !== preview.previewId) throw fail(WALLET_ERROR.PREVIEW_CONFIRMATION_REQUIRED, "确认的预览编号不匹配");
    const state = previews.get(preview);
    if (state.status === "sent") return Object.freeze({ hash: state.hash, chainId: preview.chainId, from: preview.account, to: preview.contractAddress, amountRaw: preview.amountRaw, broadcast: true, alreadySent: true, credited: false, transferVerified: false, finality: "unknown", warning: "已广播；回执和 calldata/收款人/日志仍未核验，不代表预期转账或入账。", generation });
    if (state.status === "unknown") throw fail(WALLET_ERROR.UNKNOWN_BROADCAST, "上次发送结果未知；不要重发。请用已知交易哈希核对链上状态");
    if (operationPort === null) throw fail(WALLET_ERROR.OPERATION_JOURNAL_REQUIRED, "没有注入 Service 持久操作 journal，禁止发送；本模块不保存跨刷新状态");
    if (state.promise) return state.promise;
    state.promise = (async () => {
      assertUsable();
      if (preview.blockers.length) throw fail(WALLET_ERROR.PREVIEW_BLOCKED, "预览存在余额或 gas 阻塞项，不能发送");
      if (now() >= preview.expiresAtMs) throw fail(WALLET_ERROR.PREVIEW_STALE, "预览已过期，请重新预览");
      if (preview.generation !== generation) throw fail(WALLET_ERROR.PREVIEW_STALE, "账户或网络已变化，预览失效");
      const current = await readCurrentState();
      applyState(current.list, current.chainId);
      assertUsable();
      if (current.chainId !== preview.chainId || !sameAddress(account, preview.account)) throw fail(WALLET_ERROR.PREVIEW_STALE, "账户或网络已变化，预览失效");
      const network = findNetwork(registry, preview.chainId);
      assertSendableNetwork(network, allowedChainIds);
      const asset = findAsset(registry, preview.assetId);
      assertSendableAsset(asset, network);
      const tokenRaw = parseQuantity(await providerRequest("eth_call", [{ to: asset.contractAddress, data: `0x70a08231${account.toLowerCase().slice(2).padStart(64, "0")}` }, "latest"], rpcMs), "代币余额");
      const nativeRaw = parseQuantity(await providerRequest("eth_getBalance", [account, "latest"], rpcMs), "原生余额");
      const gasLimit = parseQuantity(await providerRequest("eth_estimateGas", [{ from: account, to: asset.contractAddress, value: "0x0", data: preview.call.data }], rpcMs), "gas 估算");
      const gasPrice = parseQuantity(await providerRequest("eth_gasPrice", [], rpcMs), "gas 价格");
      if (gasLimit.toString() !== preview.gasLimitRaw || gasPrice.toString() !== preview.gasPriceRaw) throw fail(WALLET_ERROR.PREVIEW_STALE, "gas 估算或价格变化，请重新预览");
      if (tokenRaw < BigInt(preview.amountRaw)) throw fail(WALLET_ERROR.INSUFFICIENT_TOKEN_BALANCE, "代币余额已不足，请重新预览");
      if (nativeRaw < BigInt(preview.estimatedFeeRaw)) throw fail(WALLET_ERROR.INSUFFICIENT_NATIVE_BALANCE, "原生余额不足以支付 gas，请重新预览");
      if (preview.generation !== generation) throw fail(WALLET_ERROR.PREVIEW_STALE, "账户、网络或 gas 已变化，预览失效");
      const operation = operationOf(preview);
      let reservation;
      try {
        reservation = await operationPort.reserve(operation);
      } catch {
        throw fail(WALLET_ERROR.OPERATION_JOURNAL_FAILED, "Service 操作 journal 预留失败；未发送");
      }
      if (!reservation || typeof reservation.reservationId !== "string" || !reservation.reservationId) throw fail(WALLET_ERROR.OPERATION_JOURNAL_FAILED, "Service journal 未返回有效预留编号；未发送");
      if (reservation.state === "unknown") {
        state.status = "unknown"; state.error = WALLET_ERROR.OPERATION_UNKNOWN; state.promise = null;
        throw fail(WALLET_ERROR.OPERATION_UNKNOWN, "Service journal 记录该操作结果未知；禁止重发，请按已知哈希恢复", { hash: reservation.hash ?? null });
      }
      if (reservation.state === "broadcasting" || reservation.state === "broadcast") {
        state.status = "unknown"; state.error = WALLET_ERROR.OPERATION_ALREADY_STARTED; state.promise = null;
        throw fail(WALLET_ERROR.OPERATION_ALREADY_STARTED, "Service journal 记录该操作已开始广播；禁止重发", { hash: reservation.hash ?? null });
      }
      if (reservation.state !== "reserved") {
        state.status = "unknown"; state.error = WALLET_ERROR.OPERATION_JOURNAL_FAILED; state.promise = null;
        throw fail(WALLET_ERROR.OPERATION_JOURNAL_FAILED, "Service journal 返回了不可发送的状态；未发送");
      }
      try {
        await operationPort.markBroadcasting({ reservationId: reservation.reservationId, operation });
      } catch {
        throw fail(WALLET_ERROR.OPERATION_JOURNAL_FAILED, "Service journal 无法标记 broadcasting；未发送");
      }
      state.attemptedSend = true;
      let hash;
      try {
        hash = await providerRequest("eth_sendTransaction", [{
          from: preview.account, to: preview.contractAddress, value: "0x0", data: preview.call.data,
          gas: preview.gasLimitHex, gasPrice: preview.gasPriceHex,
        }], sendMs);
      } catch (error) {
        try { await operationPort.recordUnknown({ reservationId: reservation.reservationId, operation, reason: error.code ?? WALLET_ERROR.WALLET_ERROR }); } catch { /* journal failure is reported by state below */ }
        state.status = "unknown"; state.error = error.code ?? WALLET_ERROR.WALLET_ERROR;
        state.promise = null;
        throw error;
      }
      if (typeof hash !== "string" || !HEX_32_RE.test(hash)) {
        try { await operationPort.recordUnknown({ reservationId: reservation.reservationId, operation, reason: WALLET_ERROR.INVALID_TX_HASH }); } catch { /* journal failure is reported by state below */ }
        state.status = "unknown"; state.error = WALLET_ERROR.INVALID_TX_HASH; state.promise = null;
        throw fail(WALLET_ERROR.INVALID_TX_HASH, "钱包未返回有效交易哈希；结果未知，不要重发");
      }
      try {
        await operationPort.recordHash({ reservationId: reservation.reservationId, operation, hash });
      } catch {
        state.status = "unknown"; state.error = WALLET_ERROR.OPERATION_JOURNAL_FAILED; state.promise = null;
        throw fail(WALLET_ERROR.OPERATION_JOURNAL_FAILED, "交易已广播但 Service journal 未记录哈希；不要自动重发", { hash });
      }
      state.status = "sent"; state.hash = hash;
      const staleAfterSend = generation !== preview.generation;
      return Object.freeze({
        hash, chainId: preview.chainId, from: preview.account, to: preview.contractAddress, amountRaw: preview.amountRaw,
        broadcast: true, alreadySent: false, credited: false, transferVerified: false, finality: "unknown",
        warning: "已广播；回执和 calldata/收款人/日志仍未核验，不代表预期转账或入账。", staleAfterSend, generation,
      });
    })();
    return state.promise;
  }

  async function getReceipt(hash) {
    if (typeof hash !== "string" || !HEX_32_RE.test(hash)) throw fail(WALLET_ERROR.INVALID_TX_HASH, "交易哈希无效");
    const receipt = await providerRequest("eth_getTransactionReceipt", [hash], rpcMs);
    if (receipt === null) return Object.freeze({ state: "pending", hash, evidence: "chain-receipt", broadcast: true, credited: false, transferVerified: false, finality: "unknown", warning: "回执只证明该交易哈希的链上执行结果；未核验 from/to/input/日志，不证明预期转账或入账。" });
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw fail(WALLET_ERROR.RPC_UNKNOWN, "回执返回值无法识别；未重发");
    if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw fail(WALLET_ERROR.RECEIPT_MISMATCH, "回执交易哈希不匹配；未重发");
    const statusValue = typeof receipt.status === "string" ? receipt.status.toLowerCase() : "";
    const state = statusValue === "0x1" ? "success" : statusValue === "0x0" ? "reverted" : "unknown";
    return Object.freeze({
      state, hash: receipt.transactionHash, blockNumber: typeof receipt.blockNumber === "string" ? receipt.blockNumber : null,
      evidence: "chain-receipt", broadcast: true, credited: false, transferVerified: false, finality: "unknown",
      warning: "回执只证明该交易哈希的链上执行结果；未核验 from/to/input/日志，不证明预期转账或入账。",
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    activeProvider = null;
    explicitlyConnected = false;
    accounts = []; account = null; chainId = null;
    status = "disposed"; generation++;
    emit();
    subscribers.clear();
  }

  return Object.freeze({
    connect, refresh, requestSwitchChain, readBalances, signDeposit, prepareTransfer, confirmTransfer, getReceipt,
    snapshot, subscribe(callback) {
      if (typeof callback !== "function") return () => {};
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    isCurrent(expected) { return !disposed && Number.isInteger(expected) && expected === generation; },
    dispose,
  });
}
