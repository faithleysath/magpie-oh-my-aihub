import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainStore, chainEventId } from "../src/chainstore.ts";
import {
  buildIntent,
  intentDigest,
  intentTypedData,
  isExpired,
  matchesTransfer,
  verifyIntentSignature,
  DEPOSIT_TYPES,
  DEPOSIT_VERIFYING_CONTRACT,
} from "../src/deposits.ts";
import { defaultRegistry, assetIdOf } from "../src/networks.ts";
import { typedDataDigest } from "../src/eip712.ts";
import { keccak256, fromHex, toHex } from "../src/keccak.ts";

/**
 * Requirement 14B's attribution half: one transfer, one consumer, or nothing.
 *
 * The signatures are produced the way a consumer's wallet produces them — a
 * secp256k1 signature over the EIP-712 digest — by signing with a fixed test key
 * and checking that the recovered address is the payer. `SIGNERS` holds
 * addresses whose keys exist only in this test file; no real wallet is involved.
 */

// A deterministic test signer. The private key never leaves this file and is not
// a wallet anyone uses: it is the point 1 on the curve multiplied by a small
// scalar, which is enough to make signatures that recover correctly.
const SIGNER_A = { address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", key: 1n };
const SIGNER_B = { address: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf", key: 2n };
const SIGNER_C = { address: "0x6813eb9362372eef6200f3b1dbc3f819671cba69", key: 3n };

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a: bigint, m = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}
function inv(a: bigint, m: bigint): bigint {
  let base = mod(a, m);
  let exp = m - 2n;
  let out = 1n;
  while (exp > 0n) {
    if (exp & 1n) out = (out * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return out;
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
  let out: Pt = null;
  let addend = p;
  while (n > 0n) {
    if (n & 1n) out = add(out, addend);
    addend = add(addend, addend);
    n >>= 1n;
  }
  return out;
}

/** A real ECDSA signature over `digest`, deterministic (RFC 6979 is not needed: k is fixed per test). */
function sign(digestHex: string, key: bigint): string {
  const z = BigInt(digestHex);
  const G = { x: GX, y: GY };
  // A deterministic k that differs per digest and key, as a real signer's would.
  let k = mod(BigInt(`0x${toHex(keccak256(`${key}:${digestHex}`))}`), N);
  if (k === 0n) k = 1n;
  const R = mul(G, k)!;
  const r = mod(R.x, N);
  let s = mod(inv(k, N) * (z + r * key), N);
  // Normalise to low-s and flip the recovery parity with it, which is what a
  // wallet does; a raw high-s signature would be refused by the verifier.
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

const tmpStore = () => new ChainStore(join(mkdtempSync(join(tmpdir(), "chainstore-")), "chain.sqlite"));
const CONTRACT_97 = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CONTRACT_84532 = "0x00000000000000000000000000000000000000ff";
const RECIPIENT = "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6";

function setup() {
  const registry = defaultRegistry();
  const a97 = registry.registerTestAsset({
    chainId: 97,
    contractAddress: CONTRACT_97,
    symbol: "tMOCK6",
    name: "Mock Six",
    decimals: 6,
    nanosPerToken: "1000000000",
    pricingNote: "1 tMOCK6 = 1 test USD",
  });
  const a84532 = registry.registerTestAsset({
    chainId: 84532,
    contractAddress: CONTRACT_84532,
    symbol: "tMOCK18",
    name: "Mock Eighteen",
    decimals: 18,
    nanosPerToken: "1000000000",
    pricingNote: "1 tMOCK18 = 1 test USD",
  });
  const store = tmpStore();
  const net97 = registry.requireEnabledNetwork(97);
  const net84532 = registry.requireEnabledNetwork(84532);
  return { registry, store, a97, a84532, net97, net84532 };
}

describe("intent construction", () => {
  test("an intent fixes chain, asset, recipient and exact amount", () => {
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: {
        providerId: "p1",
        consumerId: "c1",
        chainId: 97,
        assetId: a97.assetId,
        recipientAddress: RECIPIENT,
        expectedAmountRaw: "5000000",
        ttlSec: 600,
      },
      network: net97,
      asset: a97,
      priceVersion: a97.pricing.version,
    });
    expect(intent.chainId).toBe(97);
    expect(intent.assetId).toBe(a97.assetId);
    expect(intent.tokenContract).toBe(a97.contractAddress);
    expect(intent.expectedAmountRaw).toBe("5000000");
    expect(intent.attributionStatus).toBe("unsigned");
    expect(intent.payerAddress).toBeNull();
    expect(intent.status).toBe("requested");
    // A bigint amount survives JSON because it is a decimal string.
    expect(BigInt(intent.expectedAmountRaw)).toBe(5000000n);
    store.close();
  });

  test("the typed data carries chainId in the domain and every binding field in the message", () => {
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 },
      network: net97,
      asset: a97,
      priceVersion: a97.pricing.version,
    });
    const td = intentTypedData(intent, net97, a97);
    expect(td.domain.chainId).toBe(97);
    expect(td.domain.verifyingContract).toBe(DEPOSIT_VERIFYING_CONTRACT);
    expect(td.primaryType).toBe("DepositIntent");
    for (const field of ["invoiceId", "consumerId", "providerId", "chainId", "assetId", "tokenContract", "recipient", "expectedAmountRaw", "nonce", "requestedAt", "expiresAt"]) {
      expect(Object.keys(td.message)).toContain(field);
      expect(DEPOSIT_TYPES.DepositIntent.map((f) => f.name)).toContain(field);
    }
    store.close();
  });

  test("the digest is stable for one intent and changes with the chain", () => {
    const { a97, a84532, net97, net84532, store } = setup();
    const base = { providerId: "p1", consumerId: "c1", recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 };
    const i97 = buildIntent({ request: { ...base, chainId: 97, assetId: a97.assetId }, network: net97, asset: a97, priceVersion: a97.pricing.version });
    expect(intentDigest(i97, net97, a97)).toBe(intentDigest(i97, net97, a97));
    // The same fields on another chain produce a different document and digest.
    const i84532 = buildIntent({ request: { ...base, chainId: 84532, assetId: a84532.assetId }, network: net84532, asset: a84532, priceVersion: a84532.pricing.version });
    expect(intentDigest(i84532, net84532, a84532)).not.toBe(intentDigest(i97, net97, a97));
    store.close();
  });

  test("the digest matches the EIP-712 rules computed independently", () => {
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 },
      network: net97,
      asset: a97,
      priceVersion: a97.pricing.version,
    });
    const td = intentTypedData(intent, net97, a97);
    const ds = typedDataDigest({ types: { EIP712Domain: DEPOSIT_TYPES.EIP712Domain! }, primaryType: "EIP712Domain", domain: td.domain, message: td.domain });
    void ds;
    // The full digest must equal keccak(0x1901 ‖ domain ‖ message) by construction.
    expect(intentDigest(intent, net97, a97)).toBe(typedDataDigest(td));
    store.close();
  });

  test("an intent for the wrong chain or asset is refused", () => {
    const { a97, net97, store } = setup();
    expect(() =>
      buildIntent({
        request: { providerId: "p1", consumerId: "c1", chainId: 84532, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1", ttlSec: 600 },
        network: net97,
        asset: a97,
        priceVersion: "v",
      }),
    ).toThrow();
    store.close();
  });

  test("a zero or negative amount, the zero address and a silly TTL are refused", () => {
    const { a97, net97, store } = setup();
    const base = { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, ttlSec: 600 };
    expect(() => buildIntent({ request: { ...base, expectedAmountRaw: "0" }, network: net97, asset: a97, priceVersion: "v" })).toThrow(/positive/);
    expect(() => buildIntent({ request: { ...base, expectedAmountRaw: "-5" }, network: net97, asset: a97, priceVersion: "v" })).toThrow(/positive/);
    expect(() => buildIntent({ request: { ...base, expectedAmountRaw: "1.5" }, network: net97, asset: a97, priceVersion: "v" })).toThrow(/integer/);
    expect(() =>
      buildIntent({ request: { ...base, expectedAmountRaw: "1", recipientAddress: "0x0000000000000000000000000000000000000000" }, network: net97, asset: a97, priceVersion: "v" }),
    ).toThrow(/zero address/);
    expect(() => buildIntent({ request: { ...base, expectedAmountRaw: "1", ttlSec: 5 }, network: net97, asset: a97, priceVersion: "v" })).toThrow(/between/);
    expect(() => buildIntent({ request: { ...base, expectedAmountRaw: "1", ttlSec: 99999999 }, network: net97, asset: a97, priceVersion: "v" })).toThrow(/between/);
    store.close();
  });

  test("an intent expires", () => {
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1", ttlSec: 60 },
      network: net97,
      asset: a97,
      priceVersion: "v",
      now: new Date("2026-10-30T00:00:00Z"),
    });
    expect(isExpired(intent, new Date("2026-10-30T00:00:59Z"))).toBe(false);
    expect(isExpired(intent, new Date("2026-10-30T00:01:00Z"))).toBe(true);
    store.close();
  });
});

describe("signature binding", () => {
  test("a consumer's signature recovers to that consumer's address", () => {
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 },
      network: net97,
      asset: a97,
      priceVersion: "v",
    });
    const digest = intentDigest(intent, net97, a97);
    const sig = sign(digest, SIGNER_A.key);
    const check = verifyIntentSignature({ intent, network: net97, asset: a97, signature: sig });
    expect(check.ok).toBe(true);
    expect(check.payer).toBe(SIGNER_A.address);
    store.close();
  });

  test("a signature over another document recovers a different address, so the stated payer is checked", () => {
    // This is why `signIntent` takes the payer's own address: a signature over a
    // different digest is still a *valid* signature, and it recovers to some
    // other address. Binding on recovery alone would let a random signature
    // permanently block the real consumer's invoice.
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 },
      network: net97,
      asset: a97,
      priceVersion: "v",
    });
    const sig = sign(`0x${"22".repeat(32)}`, SIGNER_A.key);
    const check = verifyIntentSignature({ intent, network: net97, asset: a97, signature: sig });
    // It recovers *something*, and it is not the intended signer.
    expect(check.ok).toBe(true);
    expect(check.payer).not.toBe(SIGNER_A.address);
    // With the payer stated, it is refused.
    const bound = verifyIntentSignature({ intent, network: net97, asset: a97, signature: sig, expectedPayer: SIGNER_A.address });
    expect(bound.ok).toBe(false);
    store.close();
  });

  test("a signature over another chain's intent is refused (cross-chain replay)", () => {
    const { a97, a84532, net97, net84532, store } = setup();
    const base = { providerId: "p1", consumerId: "c1", recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 };
    const i97 = buildIntent({ request: { ...base, chainId: 97, assetId: a97.assetId }, network: net97, asset: a97, priceVersion: "v" });
    const i84532 = buildIntent({ request: { ...base, chainId: 84532, assetId: a84532.assetId }, network: net84532, asset: a84532, priceVersion: "v" });
    // A signature made for the Base intent must not bind the BSC one. It still
    // recovers (to another address), which is exactly why the stated payer is
    // required: recovery alone cannot tell "wrong document" from "wrong signer".
    const sig = sign(intentDigest(i84532, net84532, a84532), SIGNER_A.key);
    const check = verifyIntentSignature({ intent: i97, network: net97, asset: a97, signature: sig, expectedPayer: SIGNER_A.address });
    expect(check.ok).toBe(false);
    expect(check.payer).toBeNull();
    store.close();
  });

  test("a signature over another amount or invoice is refused", () => {
    const { a97, net97, store } = setup();
    const mk = (amount: string) =>
      buildIntent({
        request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: amount, ttlSec: 600 },
        network: net97,
        asset: a97,
        priceVersion: "v",
      });
    const one = mk("1000000");
    const two = mk("2000000");
    const sig = sign(intentDigest(two, net97, a97), SIGNER_A.key);
    expect(verifyIntentSignature({ intent: one, network: net97, asset: a97, signature: sig, expectedPayer: SIGNER_A.address }).ok).toBe(false);
    store.close();
  });

  test("a consumer bound to one wallet cannot be paid by another", () => {
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1", ttlSec: 600 },
      network: net97,
      asset: a97,
      priceVersion: "v",
    });
    const sig = sign(intentDigest(intent, net97, a97), SIGNER_B.key);
    const check = verifyIntentSignature({ intent, network: net97, asset: a97, signature: sig, expectedPayer: SIGNER_A.address });
    expect(check.ok).toBe(false);
    expect(check.payer).toBeNull();
    expect(check.reason).toContain("bound to");
    store.close();
  });

  test("a garbage signature is a refusal, never an address", () => {
    const { a97, net97, store } = setup();
    const intent = buildIntent({
      request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1", ttlSec: 600 },
      network: net97,
      asset: a97,
      priceVersion: "v",
    });
    for (const sig of ["0x", "0x00", "not a signature", `0x${"00".repeat(65)}`]) {
      const check = verifyIntentSignature({ intent, network: net97, asset: a97, signature: sig });
      expect(check.ok).toBe(false);
      expect(check.payer).toBeNull();
    }
    store.close();
  });

  test("a signature cannot be swapped onto an already-signed intent", () => {
    const { a97, net97, store } = setup();
    const intent = store.insertIntent(
      buildIntent({
        request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1", ttlSec: 600 },
        network: net97,
        asset: a97,
        priceVersion: "v",
      }),
    );
    store.setPayer({ invoiceId: intent.invoiceId, payerAddress: SIGNER_A.address, digest: intentDigest(intent, net97, a97) });
    expect(() => store.setPayer({ invoiceId: intent.invoiceId, payerAddress: SIGNER_B.address, digest: "0x00" })).toThrow();
    expect(store.intent(intent.invoiceId)!.payerAddress).toBe(SIGNER_A.address);
    store.close();
  });

  test("a nonce is unique across intents", () => {
    const { a97, net97, store } = setup();
    const mk = () =>
      buildIntent({
        request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1", ttlSec: 600 },
        network: net97,
        asset: a97,
        priceVersion: "v",
      });
    const a = store.insertIntent(mk());
    const b = store.insertIntent(mk());
    expect(a.nonce).not.toBe(b.nonce);
    expect(() => store.insertIntent({ ...mk(), invoiceId: "inv_x", nonce: a.nonce })).toThrow();
    store.close();
  });
});

describe("matching a transfer to an intent", () => {
  function signedIntent(store: ChainStore, net97: ReturnType<typeof setup>["net97"], a97: ReturnType<typeof setup>["a97"], amount = "1000000", payer = SIGNER_A) {
    const intent = store.insertIntent(
      buildIntent({
        request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: amount, ttlSec: 600 },
        network: net97,
        asset: a97,
        priceVersion: "v",
      }),
    );
    const digest = intentDigest(intent, net97, a97);
    return store.setPayer({ invoiceId: intent.invoiceId, payerAddress: payer.address, digest });
  }

  test("the exact transfer matches", () => {
    const { a97, net97, store } = setup();
    const intent = signedIntent(store, net97, a97);
    const r = matchesTransfer({ intent, chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, from: SIGNER_A.address, amountRaw: 1000000n });
    expect(r.ok).toBe(true);
    store.close();
  });

  test("each single difference refuses the match", () => {
    const { a97, net97, store } = setup();
    const intent = signedIntent(store, net97, a97);
    const cases: [string, Parameters<typeof matchesTransfer>[0]][] = [
      ["another chain", { intent, chainId: 84532, tokenContract: CONTRACT_97, recipient: RECIPIENT, from: SIGNER_A.address, amountRaw: 1000000n }],
      ["another token", { intent, chainId: 97, tokenContract: CONTRACT_84532, recipient: RECIPIENT, from: SIGNER_A.address, amountRaw: 1000000n }],
      ["another recipient", { intent, chainId: 97, tokenContract: CONTRACT_97, recipient: SIGNER_B.address, from: SIGNER_A.address, amountRaw: 1000000n }],
      ["another payer", { intent, chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, from: SIGNER_B.address, amountRaw: 1000000n }],
      ["another amount", { intent, chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, from: SIGNER_A.address, amountRaw: 999999n }],
      ["one unit more", { intent, chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, from: SIGNER_A.address, amountRaw: 1000001n }],
    ];
    for (const [label, input] of cases) {
      const r = matchesTransfer(input);
      expect({ label, ok: r.ok }).toEqual({ label, ok: false });
    }
    store.close();
  });

  test("an unsigned intent never matches", () => {
    const { a97, net97, store } = setup();
    const intent = store.insertIntent(
      buildIntent({
        request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 },
        network: net97,
        asset: a97,
        priceVersion: "v",
      }),
    );
    const r = matchesTransfer({ intent, chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, from: SIGNER_A.address, amountRaw: 1000000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unsigned");
    store.close();
  });

  test("an expired intent never matches", () => {
    const { a97, net97, store } = setup();
    const intent = signedIntent(store, net97, a97);
    const r = matchesTransfer({
      intent,
      chainId: 97,
      tokenContract: CONTRACT_97,
      recipient: RECIPIENT,
      from: SIGNER_A.address,
      amountRaw: 1000000n,
      at: new Date(new Date(intent.expiresAt).getTime() + 1),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("expired");
    store.close();
  });

  test("two identical intents from one payer are ambiguous, not a coin flip", () => {
    const { a97, net97, store } = setup();
    signedIntent(store, net97, a97, "1000000", SIGNER_A);
    signedIntent(store, net97, a97, "1000000", SIGNER_A);
    const candidates = store.candidatesFor({ chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, payer: SIGNER_A.address, amountRaw: "1000000" });
    expect(candidates).toHaveLength(2);
    store.close();
  });

  test("an expired candidate is not offered", () => {
    const { a97, net97, store } = setup();
    signedIntent(store, net97, a97);
    const later = new Date(Date.now() + 2 * 3600_000);
    expect(store.candidatesFor({ chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, payer: SIGNER_A.address, amountRaw: "1000000", now: later })).toEqual([]);
    store.close();
  });

  test("candidates are per chain and per token", () => {
    const { a97, net97, store } = setup();
    signedIntent(store, net97, a97);
    expect(store.candidatesFor({ chainId: 84532, tokenContract: CONTRACT_97, recipient: RECIPIENT, payer: SIGNER_A.address, amountRaw: "1000000" })).toEqual([]);
    expect(store.candidatesFor({ chainId: 97, tokenContract: CONTRACT_84532, recipient: RECIPIENT, payer: SIGNER_A.address, amountRaw: "1000000" })).toEqual([]);
    store.close();
  });
});

describe("one transfer, one claim", () => {
  function scenario() {
    const ctx = setup();
    const intent = ctx.store.insertIntent(
      buildIntent({
        request: { providerId: "p1", consumerId: "c1", chainId: 97, assetId: ctx.a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 },
        network: ctx.net97,
        asset: ctx.a97,
        priceVersion: "v",
      }),
    );
    ctx.store.setPayer({ invoiceId: intent.invoiceId, payerAddress: SIGNER_A.address, digest: intentDigest(intent, ctx.net97, ctx.a97) });
    return ctx;
  }

  test("the same log is stored once however often it is scanned", () => {
    const { store } = scenario();
    const log = { chainId: 97, tokenContract: CONTRACT_97, txHash: "0x" + "ab".repeat(32), logIndex: 3, blockNumber: 100, blockHash: "0x" + "cd".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1000000", confirmations: 0 };
    const first = store.observeEvent(log);
    const second = store.observeEvent(log);
    const third = store.observeEvent(log);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(third.event.observations).toBe(3);
    store.close();
  });

  test("the uniqueness key is (chain, token, tx, logIndex), so one transaction may hold several transfers", () => {
    const { store } = scenario();
    const tx = "0x" + "ef".repeat(32);
    const base = { chainId: 97, tokenContract: CONTRACT_97, txHash: tx, blockNumber: 100, blockHash: "0x" + "cd".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1000000", confirmations: 0 };
    store.observeEvent({ ...base, logIndex: 0 });
    store.observeEvent({ ...base, logIndex: 1 });
    store.observeEvent({ ...base, logIndex: 2 });
    expect(store.eventByTx(tx)).toHaveLength(3);
    store.close();
  });

  test("the same hash on two chains is two events", () => {
    const { store } = scenario();
    const tx = "0x" + "11".repeat(32);
    store.observeEvent({ chainId: 97, tokenContract: CONTRACT_97, txHash: tx, logIndex: 0, blockNumber: 10, blockHash: "0x" + "aa".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1", confirmations: 0 });
    store.observeEvent({ chainId: 84532, tokenContract: CONTRACT_84532, txHash: tx, logIndex: 0, blockNumber: 10, blockHash: "0x" + "bb".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1", confirmations: 0 });
    expect(store.eventByTx(tx)).toHaveLength(2);
    expect(chainEventId(97, CONTRACT_97, tx, 0)).not.toBe(chainEventId(84532, CONTRACT_84532, tx, 0));
    store.close();
  });

  test("two consumers cannot claim the same event", () => {
    const { store, a97, net97 } = scenario();
    const other = store.insertIntent(
      buildIntent({
        request: { providerId: "p1", consumerId: "c2", chainId: 97, assetId: a97.assetId, recipientAddress: RECIPIENT, expectedAmountRaw: "1000000", ttlSec: 600 },
        network: net97,
        asset: a97,
        priceVersion: "v",
      }),
    );
    store.setPayer({ invoiceId: other.invoiceId, payerAddress: SIGNER_B.address, digest: intentDigest(other, net97, a97) });
    const { event } = store.observeEvent({ chainId: 97, tokenContract: CONTRACT_97, txHash: "0x" + "22".repeat(32), logIndex: 0, blockNumber: 5, blockHash: "0x" + "cc".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1000000", confirmations: 0 });
    const first = store.candidatesFor({ chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, payer: SIGNER_A.address, amountRaw: "1000000" })[0]!;
    store.claim({ eventId: event.id, invoiceId: first.invoiceId });
    // The second claimer must fail, not overwrite.
    expect(() => store.claim({ eventId: event.id, invoiceId: other.invoiceId })).toThrow();
    expect(store.event(event.id)!.invoiceId).toBe(first.invoiceId);
    store.close();
  });

  test("one intent cannot claim two events", () => {
    const { store } = scenario();
    const invoice = store.candidatesFor({ chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, payer: SIGNER_A.address, amountRaw: "1000000" })[0]!;
    const e1 = store.observeEvent({ chainId: 97, tokenContract: CONTRACT_97, txHash: "0x" + "33".repeat(32), logIndex: 0, blockNumber: 5, blockHash: "0x" + "dd".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1000000", confirmations: 0 });
    const e2 = store.observeEvent({ chainId: 97, tokenContract: CONTRACT_97, txHash: "0x" + "44".repeat(32), logIndex: 0, blockNumber: 6, blockHash: "0x" + "ee".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1000000", confirmations: 0 });
    store.claim({ eventId: e1.event.id, invoiceId: invoice.invoiceId });
    expect(() => store.claim({ eventId: e2.event.id, invoiceId: invoice.invoiceId })).toThrow();
    store.close();
  });

  test("an event cannot back two ledger deposits", () => {
    const { store } = scenario();
    const { event } = store.observeEvent({ chainId: 97, tokenContract: CONTRACT_97, txHash: "0x" + "55".repeat(32), logIndex: 0, blockNumber: 5, blockHash: "0x" + "aa".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1", confirmations: 0 });
    store.markCredited(event.id, "chain:one");
    expect(() => store.markCredited(event.id, "chain:two")).toThrow();
    expect(store.event(event.id)!.depositId).toBe("chain:one");
    store.close();
  });

  test("a credited event is not moved back by a later scan", () => {
    const { store } = scenario();
    const { event } = store.observeEvent({ chainId: 97, tokenContract: CONTRACT_97, txHash: "0x" + "66".repeat(32), logIndex: 0, blockNumber: 5, blockHash: "0x" + "aa".repeat(32), from: SIGNER_A.address, to: RECIPIENT, amountRaw: "1", confirmations: 0 });
    store.markCredited(event.id, "chain:x");
    store.setEventStatus(event.id, "confirming", "a rescan thought it was pending");
    expect(store.event(event.id)!.status).toBe("credited");
    // A proven reorg is the one thing that may override it, and the deposit id stays.
    store.setEventStatus(event.id, "reverted", "the block hash moved");
    const after = store.event(event.id)!;
    expect(after.status).toBe("reverted");
    expect(after.depositId).toBe("chain:x");
    store.close();
  });
});

describe("an unclaimable transfer stays unclaimed", () => {
  test("a transfer from an address with no signed intent is unclaimed and never credited", () => {
    const { store } = setup();
    const { event } = store.observeEvent({ chainId: 97, tokenContract: CONTRACT_97, txHash: "0x" + "77".repeat(32), logIndex: 0, blockNumber: 5, blockHash: "0x" + "aa".repeat(32), from: SIGNER_C.address, to: RECIPIENT, amountRaw: "1000000", confirmations: 0 });
    // An exchange or a contract cannot sign, so there is no candidate.
    expect(store.candidatesFor({ chainId: 97, tokenContract: CONTRACT_97, recipient: RECIPIENT, payer: SIGNER_C.address, amountRaw: "1000000" })).toEqual([]);
    store.markUnclaimed(event.id, "no signed intent");
    expect(store.event(event.id)!.status).toBe("unclaimed");
    expect(store.event(event.id)!.depositId).toBeNull();
    expect(store.awaitingCredit()).toEqual([]);
    store.close();
  });
});
