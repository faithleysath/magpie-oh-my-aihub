// Canonical JSON plus EIP-191 `personal_sign`, the one signature format every
// overlay document uses (DESIGN-V2 §8).
//
// The signed bytes are `canonicalJson(payload)`: object keys sorted, `undefined`
// members omitted, no whitespace, UTF-8. Every document carries a `schema` field
// so a signature cannot be replayed as another document type. Verification is
// `ethers.verifyMessage` over the same bytes; the recovered address must equal
// `payload.address` (the caller checks that, this module only reports it).

import { verifyMessage } from "ethers";

/** Deterministic JSON: object keys sorted, arrays in order, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
  }
  return "null";
}

/** The minimal signer this module needs; an ethers `Wallet` satisfies it. */
export interface Signer {
  signMessage(message: string): Promise<string>;
}

/** EIP-191 signature over `canonicalJson(payload)`, as 65-byte lowercase hex. */
export async function signCanonical(signer: Signer, payload: unknown): Promise<string> {
  const signature = await signer.signMessage(canonicalJson(payload));
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error(`the signer returned a non-65-byte signature (${signature.length} chars)`);
  }
  return signature.toLowerCase();
}

/**
 * The address that signed `payload`, or null when the signature is malformed or
 * does not recover. Lowercased, so a caller can compare it directly.
 */
export function signerOf(payload: unknown, signature: unknown): string | null {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    return verifyMessage(canonicalJson(payload), signature).toLowerCase();
  } catch {
    return null;
  }
}
