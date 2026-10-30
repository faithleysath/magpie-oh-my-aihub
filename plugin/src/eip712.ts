// EIP-712 typed data: hashing only.
//
// A consumer binds a deposit request by signing one EIP-712 document with their
// own wallet. The plugin verifies it locally, so it needs the same digest the
// wallet signed. This module implements the hashing rules of EIP-712 for the
// small, fixed set of types a deposit intent uses — no dynamic types, no
// recursive structs — rather than a general implementation that would have to
// be trusted for inputs it never sees.
//
// Verified against `cast wallet sign --data` (foundry 1.8.6), which is the same
// implementation MetaMask uses; see test/eip712.test.ts.

import { concatBytes, fromHex, keccak256, toHex } from "./keccak.ts";

/** One member of a struct type, in declaration order. */
export interface TypedField {
  name: string;
  /** `uint256`, `address`, `bytes32`, `uint64`, `string`, or `Type[]`/struct names */
  type: string;
}

export type TypedTypes = Record<string, TypedField[]>;

export interface TypedData {
  types: TypedTypes;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

const ZERO32 = new Uint8Array(32);

/** `Type(typeA a,typeB b)` — the encoding EIP-712 hashes for each struct. */
export function encodeType(types: TypedTypes, primaryType: string): string {
  const deps: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const fields = types[name];
    if (!fields) throw new Error(`EIP-712 type ${name} is not declared`);
    for (const f of fields) {
      const base = f.type.replace(/\[\d*\]$/, "");
      if (types[base]) deps.push(base);
    }
    // Only declared struct types are visited; a primitive such as `string` has
    // no members and must not be looked up as a struct.
    for (const f of fields) {
      const base = f.type.replace(/\[\d*\]$/, "");
      if (types[base]) visit(base);
    }
  };
  visit(primaryType);
  const parts = [primaryType, ...[...new Set(deps)].sort()].map((name) => {
    const fields = types[name]!;
    return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
  });
  return parts.join("");
}

export function typeHash(types: TypedTypes, primaryType: string): string {
  return `0x${toHex(keccak256(encodeType(types, primaryType)))}`;
}

function pad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("a bytesN value is at most 32 bytes");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function uintTo32(value: unknown, label: string): Uint8Array {
  let big: bigint;
  if (typeof value === "bigint") big = value;
  else if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
    big = BigInt(value);
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) big = BigInt(value);
  else throw new Error(`${label} must be an integer`);
  if (big < 0n) throw new Error(`${label} must not be negative`);
  const out = new Uint8Array(32);
  let v = big;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`${label} does not fit in 32 bytes`);
  return out;
}

function encodeValue(types: TypedTypes, type: string, value: unknown, label: string): Uint8Array {
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    return keccak256(value);
  }
  if (type === "bytes") {
    if (typeof value !== "string") throw new Error(`${label} must be a hex string`);
    return keccak256(fromHex(value));
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) {
    if (typeof value !== "string") throw new Error(`${label} must be a hex string`);
    const bytes = fromHex(value);
    if (bytes.length !== Number(fixed[1])) throw new Error(`${label} must be exactly ${fixed[1]} bytes`);
    return pad32(bytes);
  }
  if (type === "address") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an address`);
    const out = new Uint8Array(32);
    out.set(fromHex(value).subarray(0), 12);
    return out;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
    const out = new Uint8Array(32);
    out[31] = value ? 1 : 0;
    return out;
  }
  if (/^u?int\d*$/.test(type)) {
    if (type.startsWith("int") && typeof value === "number" && value < 0) throw new Error(`${label}: negative ints are not used here`);
    return uintTo32(value, label);
  }
  const arr = /^(.*)\[(\d*)\]$/.exec(type);
  if (arr) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    const inner = arr[1]!;
    const size = arr[2] ? Number(arr[2]) : null;
    if (size !== null && value.length !== size) throw new Error(`${label} must have ${size} items`);
    // A dynamic array hashes its concatenated element encodings; a fixed array
    // is encoded inline (its elements are concatenated the same way).
    const encoded = concatBytes(...value.map((v, i) => encodeValue(types, inner, v, `${label}[${i}]`)));
    return size === null ? keccak256(encoded) : encoded;
  }
  if (types[type]) return hashStruct(types, type, value as Record<string, unknown>, label);
  throw new Error(`EIP-712 type ${type} is not supported`);
}

function hashStruct(types: TypedTypes, primaryType: string, data: Record<string, unknown>, label = primaryType): Uint8Array {
  const fields = types[primaryType];
  if (!fields) throw new Error(`EIP-712 type ${primaryType} is not declared`);
  if (!data || typeof data !== "object") throw new Error(`${label} must be an object`);
  const parts = [keccak256(encodeType(types, primaryType))];
  for (const f of fields) {
    const v = data[f.name];
    if (v === undefined) throw new Error(`${label}.${f.name} is missing`);
    parts.push(encodeValue(types, f.type, v, `${label}.${f.name}`));
  }
  return keccak256(concatBytes(...parts));
}

/** `hashStruct(domain)`; EIP-712 requires a domain with a name and version. */
export function domainSeparator(types: TypedTypes, domain: Record<string, unknown>): string {
  if (!types.EIP712Domain) throw new Error("the EIP-712 domain type is not declared");
  return `0x${toHex(hashStruct(types, "EIP712Domain", domain, "domain"))}`;
}

/**
 * The 32-byte digest a wallet signs:
 * keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message)).
 */
export function typedDataDigest(data: TypedData): string {
  const types = data.types;
  if (!types[data.primaryType]) throw new Error(`the primary type ${data.primaryType} is not declared`);
  const domain = hashStruct(types, "EIP712Domain", data.domain, "domain");
  const message = hashStruct(types, data.primaryType, data.message);
  return `0x${toHex(keccak256(concatBytes(fromHex("0x1901"), domain, message)))}`;
}

export { ZERO32 };
