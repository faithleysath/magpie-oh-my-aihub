// B1 crypto primitives: standard algorithms only, plus the binding checks around
// them. These tests run without a node, a store or a network.

import { describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import {
  decodeFrame,
  deriveSessionKeys,
  digestHex,
  encodeFrame,
  frameAad,
  generateEphemeralKeyPair,
  openAuthorization,
  openFrame,
  sealAuthorization,
  sealFrame,
  transcriptHash,
  wipe,
  x25519SharedSecret,
} from "../src/p2p/crypto.ts";
import { authorizationHashOf, keyHashOf, type P2pAuthorizationDocument } from "../src/p2p/protocol.ts";
import { P2pError, type P2pErrorCode } from "../src/p2p/protocol.ts";

const KEY = Buffer.alloc(32, 7);

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

function expectCode(fn: () => unknown, code: P2pErrorCode): void {
  try {
    fn();
    throw new Error("expected a P2pError");
  } catch (e) {
    expect(e).toBeInstanceOf(P2pError);
    expect((e as P2pError).code).toBe(code);
  }
}

describe("X25519", () => {
  test("RFC 7748 section 6.1 vector", () => {
    const alice = createPrivateKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        d: Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex").toString("base64url"),
        x: Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex").toString("base64url"),
      },
      format: "jwk",
    });
    const bobPublic = Buffer.from("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", "hex").toString("base64");
    const shared = x25519SharedSecret(alice, bobPublic);
    expect(shared.toString("hex")).toBe("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
  });

  test("two ephemeral keys agree and low-order points are refused", () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    expect(x25519SharedSecret(a.privateKey, b.publicKeyBase64).equals(x25519SharedSecret(b.privateKey, a.publicKeyBase64))).toBe(true);

    const lowOrder = [
      "00".repeat(32),
      "01" + "00".repeat(31),
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
    ];
    for (const hex of lowOrder) {
      expectCode(() => x25519SharedSecret(a.privateKey, Buffer.from(hex, "hex").toString("base64")), "bad_identity");
    }
    expectCode(() => x25519SharedSecret(a.privateKey, b64(Buffer.alloc(31, 1))), "bad_identity");
    expectCode(() => x25519SharedSecret(a.privateKey, b64(Buffer.alloc(33, 1))), "bad_identity");
    expectCode(() => x25519SharedSecret(a.privateKey, "not base64 !!!"), "bad_identity");
  });

  test("a low-order public key that OpenSSL might accept is rejected by the raw-length check", () => {
    const a = generateEphemeralKeyPair();
    const thirtyThree = Buffer.concat([Buffer.alloc(33, 0)]);
    expectCode(() => x25519SharedSecret(a.privateKey, b64(thirtyThree)), "bad_identity");
  });
});

describe("HKDF-SHA256 session keys", () => {
  test("three independent, deterministic keys derived from the transcript", () => {
    const shared = Buffer.alloc(32, 3);
    const th = transcriptHash({ hello: "a" });
    const k1 = deriveSessionKeys(shared, th);
    const k2 = deriveSessionKeys(shared, th);
    expect(k1.c2s.equals(k2.c2s)).toBe(true);
    expect(k1.s2c.equals(k2.s2c)).toBe(true);
    expect(k1.authorization.equals(k2.authorization)).toBe(true);
    expect(k1.c2s.length).toBe(32);
    expect(new Set([k1.c2s.toString("hex"), k1.s2c.toString("hex"), k1.authorization.toString("hex")]).size).toBe(3);
    const other = deriveSessionKeys(shared, transcriptHash({ hello: "b" }));
    expect(other.c2s.equals(k1.c2s)).toBe(false);
    const otherSecret = deriveSessionKeys(Buffer.alloc(32, 4), th);
    expect(otherSecret.c2s.equals(k1.c2s)).toBe(false);
    wipe(k1.c2s);
    expect(k1.c2s.toString("hex")).toBe("00".repeat(32));
  });
});

describe("AES-256-GCM frames", () => {
  const sessionId = "1".repeat(32);
  const msgId = "2".repeat(32);
  const base = { sessionId, direction: "c2s" as const, seq: 1, msgId, type: "connection_request" as const };

  test("roundtrip and every binding is authenticated", () => {
    const plaintext = Buffer.from(canonical("hello"), "utf8");
    const { ciphertext } = sealFrame(KEY, { ...base, plaintext });
    expect(openFrame(KEY, { ...base, ciphertext }).toString()).toBe(canonical("hello"));

    expectCode(() => openFrame(KEY, { ...base, seq: 2, ciphertext }), "bad_ciphertext");
    expectCode(() => openFrame(KEY, { ...base, sessionId: "3".repeat(32), ciphertext }), "bad_ciphertext");
    expectCode(() => openFrame(KEY, { ...base, direction: "s2c", ciphertext }), "bad_ciphertext");
    expectCode(() => openFrame(KEY, { ...base, msgId: "4".repeat(32), ciphertext }), "bad_ciphertext");
    expectCode(() => openFrame(KEY, { ...base, type: "approved", ciphertext }), "bad_ciphertext");
    expectCode(() => openFrame(Buffer.alloc(32, 8), { ...base, ciphertext }), "bad_ciphertext");

    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0xff;
    expectCode(() => openFrame(KEY, { ...base, ciphertext: tampered }), "bad_ciphertext");
    expectCode(() => openFrame(KEY, { ...base, ciphertext: ciphertext.subarray(0, ciphertext.length - 1) }), "bad_ciphertext");
  });

  test("frame header is strict", () => {
    const { ciphertext } = sealFrame(KEY, { ...base, plaintext: Buffer.from("x") });
    const frame = encodeFrame({ type: base.type, seq: 1, msgId: Buffer.from(msgId, "hex"), ciphertext });
    const decoded = decodeFrame(frame);
    expect(decoded.seq).toBe(1);
    expect(decoded.type).toBe("connection_request");
    expect(decoded.msgId.toString("hex")).toBe(msgId);
    expect(digestHex(decoded.ciphertext)).toBe(digestHex(ciphertext));

    const badMagic = Buffer.from(frame);
    badMagic.write("XXXX", 0, "ascii");
    expectCode(() => decodeFrame(badMagic), "malformed");
    const badVersion = Buffer.from(frame);
    badVersion[4] = 2;
    expectCode(() => decodeFrame(badVersion), "unsupported_version");
    const badType = Buffer.from(frame);
    badType[5] = 99;
    expectCode(() => decodeFrame(badType), "unsupported_type");
    const badLength = Buffer.from(frame);
    badLength.writeUInt16BE(1, 30);
    expectCode(() => decodeFrame(badLength), "malformed");
    expectCode(() => decodeFrame(frame.subarray(0, 10)), "malformed");
    expectCode(() => decodeFrame(frame, 16), "oversize");
    const zeroSeq = Buffer.from(frame);
    zeroSeq.writeBigUInt64BE(0n, 6);
    expectCode(() => decodeFrame(zeroSeq), "malformed");
    const hugeSeq = Buffer.from(frame);
    hugeSeq.writeBigUInt64BE(BigInt("9007199254740992"), 6);
    expectCode(() => decodeFrame(hugeSeq), "malformed");
    expect(frameAad(base).toString()).toContain(sessionId);
  });
});

describe("authorization sealing", () => {
  const provider = { nodeId: "bbbb2222", fingerprint: "f".repeat(64) };
  const consumer = { nodeId: "aaaa1111", fingerprint: "e".repeat(64) };
  const document: P2pAuthorizationDocument = {
    schema: "ohmyaihub.authorization/v2",
    createdAt: "2026-10-31T12:00:00.000Z",
    provider: { nodeId: "bbbb2222", mappedCidr: "10.66.1.2/32", gatewayPort: 3425 },
    consumer: { nodeId: "aaaa1111", fingerprint: "e".repeat(64) },
    approvalId: "a".repeat(32),
    requestHash: "b".repeat(64),
    models: ["alpha/x"],
    capUsd: 2,
    quote: { contentHash: "c".repeat(64), identityFingerprint: "f".repeat(64), priceVersion: "d".repeat(64), priceLocked: false },
    keyId: "key-lab-1",
    keyName: "ohmyaihub-bbbb2222",
    keyHash: keyHashOf("sk-ohmy-" + "a".repeat(32)),
    key: "sk-ohmy-" + "a".repeat(32),
  };
  const hash = authorizationHashOf(document, document.keyHash);
  const ctx = {
    sessionId: "1".repeat(32),
    approvalId: document.approvalId,
    requestHash: document.requestHash,
    authorizationHash: hash,
    recipientFingerprint: consumer.fingerprint,
  };
  const expected = { providerNodeId: provider.nodeId, consumerNodeId: consumer.nodeId, consumerFingerprint: consumer.fingerprint };

  test("only the addressed session opens it, and the hash binds the key", () => {
    const sealed = sealAuthorization(KEY, ctx, document);
    const opened = openAuthorization(KEY, ctx, sealed, expected);
    expect(opened.document.key).toBe(document.key);
    expect(opened.authorizationHash).toBe(hash);

    expectCode(() => openAuthorization(Buffer.alloc(32, 1), ctx, sealed, expected), "bad_ciphertext");
    expectCode(() => openAuthorization(KEY, { ...ctx, sessionId: "2".repeat(32) }, sealed, expected), "bad_ciphertext");
    expectCode(() => openAuthorization(KEY, { ...ctx, approvalId: "9".repeat(32) }, sealed, expected), "bad_ciphertext");
    expectCode(() => openAuthorization(KEY, { ...ctx, recipientFingerprint: "0".repeat(64) }, sealed, expected), "bad_ciphertext");
    expectCode(() => openAuthorization(KEY, ctx, { ...sealed, nonce: "AAAAAAAAAAAAAAAA" }, expected), "bad_ciphertext");
  });

  test("the authorization hash ignores createdAt/key but covers the key hash and scope", () => {
    const later = { ...document, createdAt: "2026-10-31T12:30:00.000Z" };
    expect(authorizationHashOf(later, document.keyHash)).toBe(hash);
    expect(authorizationHashOf(document, keyHashOf("sk-ohmy-" + "b".repeat(32)))).not.toBe(hash);
    expect(authorizationHashOf({ ...document, capUsd: 3 }, document.keyHash)).not.toBe(hash);
    expect(authorizationHashOf({ ...document, models: ["alpha/x", "beta/y"] }, document.keyHash)).not.toBe(hash);
  });

  test("the document validation refuses a key that does not match keyHash", () => {
    const wrongHash = keyHashOf("sk-ohmy-" + "b".repeat(32));
    const doc2 = { ...document, keyHash: wrongHash };
    const hash2 = authorizationHashOf(doc2, wrongHash);
    const ctx2 = { ...ctx, authorizationHash: hash2 };
    const sealed = sealAuthorization(KEY, ctx2, doc2);
    expectCode(() => openAuthorization(KEY, ctx2, sealed, expected), "malformed");
  });
});

function canonical(value: unknown): string {
  return JSON.stringify(value);
}
