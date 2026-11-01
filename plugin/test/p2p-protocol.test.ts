// Envelope and body validation. The wire format is the contract: anything not
// explicitly allowed must fail before a handler sees it.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, loadOrCreateCatalogIdentity, sha256Hex } from "../src/catalog.ts";
import { p2pIdentityFromCatalog, type P2pIdentity } from "../src/p2p/identity.ts";
import {
  P2P_B1_UNSUPPORTED,
  P2P_CLOCK_SKEW_MS,
  P2P_MESSAGE_TYPES,
  P2P_MAX_JSON_BYTES,
  P2P_MAX_TTL_MS,
  P2P_PROTOCOL,
  P2P_VERSION,
  P2pError,
  envelopeSigningValue,
  requestHashOf,
  signatureDomain,
  signingBytesFor,
  validateEnvelope,
  verifyEd25519,
  type P2pEnvelope,
  type P2pErrorCode,
  type P2pMessageType,
  type P2pRequestDocument,
} from "../src/p2p/protocol.ts";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const QUOTE = "aa".repeat(32);
const PRICE = "bb".repeat(32);

let A: P2pIdentity;
let B: P2pIdentity;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "p2p-protocol-"));
  process.chdir(dir);
  const a = loadOrCreateCatalogIdentity();
  const b = loadOrCreateCatalogIdentity();
  A = p2pIdentityFromCatalog(a, { nodeId: "aaaa1111", hostname: "ohmyaihub-aaaa1111", mappedCidr: null, controlPort: null, gatewayPort: null, catalogQuoteHash: null });
  B = p2pIdentityFromCatalog(b, { nodeId: "bbbb2222", hostname: "ohmyaihub-bbbb2222", mappedCidr: "10.66.1.2/32", controlPort: 3427, gatewayPort: 3425, catalogQuoteHash: QUOTE });
});

function requestDocument(overrides: Partial<P2pRequestDocument> = {}): P2pRequestDocument {
  return {
    consumer: { nodeId: "aaaa1111", hostname: "ohmyaihub-aaaa1111" },
    provider: { nodeId: "bbbb2222", hostname: "ohmyaihub-bbbb2222", mappedCidr: "10.66.1.2/32", gatewayPort: 3425, catalogPort: 3426 },
    models: ["alpha/x"],
    quote: { contentHash: QUOTE, priceVersion: PRICE, identityFingerprint: B.peer.fingerprint, priceLocked: false },
    acceptance: { fingerprint: B.peer.fingerprint, quoteHash: QUOTE, priceVersion: PRICE },
    ...overrides,
  };
}

describe("a request nonce distinguishes a new request from an idempotent retry", () => {
  test("the hash changes with the nonce and a malformed nonce is refused", () => {
    const a = requestHashOf(requestDocument({ nonce: "a".repeat(16) }));
    const b = requestHashOf(requestDocument({ nonce: "b".repeat(16) }));
    expect(a).not.toBe(b);
    expect(requestHashOf(requestDocument({ nonce: "a".repeat(16) }))).toBe(a);
    // A document without a nonce (legacy shape) still hashes deterministically.
    expect(requestHashOf(requestDocument())).toBe(requestHashOf(requestDocument()));
    const request = requestDocument({ nonce: "a".repeat(16) });
    const body = { requestHash: requestHashOf(request), request };
    expect(() => verify(sign(unsignedFor("connection_request", body)))).not.toThrow();
    const bad = { ...request, nonce: "zz" };
    expectCode(() => verify(sign(unsignedFor("connection_request", { requestHash: requestHashOf(bad as never), request: bad }))), "malformed");
  });
});

function unsignedFor(type: P2pMessageType = "connection_request", body?: unknown, options: { from?: P2pIdentity; to?: P2pIdentity; time?: string; expires?: string } = {}): Omit<P2pEnvelope, "auth"> {
  const from = options.from ?? A;
  const to = options.to ?? B;
  const request = requestDocument();
  return {
    version: P2P_VERSION,
    protocol: P2P_PROTOCOL,
    type,
    id: "1".repeat(32),
    // Clone: a mutation in a negative test must never leak into the identity.
    from: structuredClone(from.peer),
    to: { accountId: to.peer.fingerprint, nodeId: to.peer.nodeId, fingerprint: to.peer.fingerprint },
    time: options.time ?? NOW.toISOString(),
    expires: options.expires ?? new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    correlation: null,
    idempotency: "2".repeat(32),
    body: body ?? { requestHash: requestHashOf(request), request },
  };
}

function sign(unsigned: Omit<P2pEnvelope, "auth">): P2pEnvelope {
  return { ...unsigned, auth: A.sign(unsigned.type, unsigned as unknown as Record<string, unknown>) };
}

function verify(envelope: unknown, now = NOW) {
  return validateEnvelope(envelope, {
    now,
    expectedFrom: { nodeId: "aaaa1111", fingerprint: A.peer.fingerprint },
    expectedTo: { nodeId: "bbbb2222", fingerprint: B.peer.fingerprint },
  });
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

function reseal(mutate: (value: Record<string, any>) => void, type: P2pMessageType = "connection_request", body?: unknown): P2pEnvelope {
  const value = unsignedFor(type, body) as Record<string, any>;
  mutate(value);
  const auth = A.sign(type, value);
  return { ...value, auth } as P2pEnvelope;
}

function paymentBody(): unknown {
  return {
    paymentId: "7".repeat(32),
    amountUsd: 1.5,
    network: { chainId: 84532, tokenContract: "0x" + "1".repeat(40), decimals: 6, issuerType: "mock" },
    memo: null,
  };
}

function creditBody(): unknown {
  return { creditId: "8".repeat(32), consumerNodeId: "aaaa1111", fundsClass: "test", amountUsd: 1, state: "observed" };
}

describe("signed envelope", () => {
  test("a valid request verifies and exposes its content hash", () => {
    const request = requestDocument();
    const signed = sign(unsignedFor());
    const verified = verify(signed);
    expect(verified.envelope.from.nodeId).toBe("aaaa1111");
    expect(verified.envelope.to.fingerprint).toBe(B.peer.fingerprint);
    expect(verified.requestHash).toBe(requestHashOf(request));
    expect(verified.bodyHash).toBe(sha256Hex(canonicalJson(verified.envelope.body)));
    expect(signatureDomain("approved")).toBe("ohmyaihub/p2p/approved/v1");
  });

  test("the signature covers every envelope field, including the target and body", () => {
    const base = sign(unsignedFor());
    const tamper = (mutate: (value: Record<string, any>) => void) => {
      const copy = structuredClone(base) as Record<string, any>;
      mutate(copy);
      return copy;
    };
    expectCode(() => verify(tamper((v) => { v.id = "3".repeat(32); })), "bad_signature");
    expectCode(() => verify(tamper((v) => { v.time = new Date(NOW.getTime() + 1_000).toISOString(); })), "bad_signature");
    expectCode(() => verify(tamper((v) => { v.expires = new Date(NOW.getTime() + 6 * 60_000).toISOString(); })), "bad_signature");
    expectCode(() => verify(tamper((v) => { v.to.nodeId = "cccc3333"; })), "target_mismatch");
    expectCode(() => verify(tamper((v) => { v.idempotency = "4".repeat(32); })), "bad_signature");
    expectCode(() => verify(tamper((v) => { v.body.request.models = ["beta/y"]; })), "conflict" /* requestHash is checked before the signature */);
  });

  test("a signature is domain separated: an approval cannot be replayed as another type", () => {
    const approved = sign(
      unsignedFor("approved", {
        requestHash: "5".repeat(64),
        approvalId: "6".repeat(32),
        generation: 1,
        consumerNodeId: "aaaa1111",
        consumerFingerprint: A.peer.fingerprint,
        models: ["alpha/x"],
        capUsd: 2,
        quoteHash: QUOTE,
        priceVersion: PRICE,
        expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
        keyId: "key-1",
        keyName: "key-name",
      }),
    );
    // The signature is computed over a per-type domain, so a signature made for
    // one type never verifies under another type's domain.
    expect(verifyEd25519(A.peer.publicKey, signingBytesFor("approved", envelopeSigningValue(approved)), approved.auth.signature)).toBe(true);
    expect(verifyEd25519(A.peer.publicKey, signingBytesFor("rejected", envelopeSigningValue(approved)), approved.auth.signature)).toBe(false);
  });

  test("strict shape: no extra fields, no unknown type or version", () => {
    expectCode(() => verify({ ...sign(unsignedFor()), extra: true }), "malformed");
    expectCode(() => verify({ ...sign(unsignedFor()), version: 2 }), "unsupported_version");
    expectCode(() => verify({ ...sign(unsignedFor()), type: "configure" }), "unsupported_type");
    const badId = sign(unsignedFor());
    badId.id = "not-hex";
    expectCode(() => verify(badId), "malformed");
    const badProtocol = sign(unsignedFor());
    (badProtocol as { protocol: string }).protocol = "ohmyaihub/p2p/v2";
    expectCode(() => verify(badProtocol), "malformed");
    const text = JSON.stringify(sign(unsignedFor()));
    const withPrototype = JSON.parse(text.replace("{", '{"__proto__":{"polluted":true},')) as Record<string, unknown>;
    expectCode(() => verify(withPrototype), "malformed");
  });

  test("size, lifetime and clock window are bounded", () => {
    const big = sign(unsignedFor());
    (big.body as { padding: string }).padding = "x".repeat(P2P_MAX_JSON_BYTES);
    expectCode(() => verify(big), "oversize");
    expectCode(() => verify(sign(unsignedFor("connection_request", undefined, { time: new Date(NOW.getTime() + P2P_CLOCK_SKEW_MS + 1_000).toISOString() }))), "clock_skew");
    expectCode(() => verify(sign(unsignedFor("connection_request", undefined, { expires: new Date(NOW.getTime() - P2P_CLOCK_SKEW_MS - 1_000).toISOString() }))), "malformed" /* expires before it was issued */);
    expectCode(() => verify(sign(unsignedFor("connection_request", undefined, { expires: new Date(NOW.getTime() + P2P_MAX_TTL_MS + 60_000).toISOString() }))), "malformed");
    expectCode(() => verify(sign(unsignedFor("connection_request", undefined, { expires: NOW.toISOString() }))), "malformed");
    // already expired but within the skew
    const expired = new Date(NOW.getTime() - P2P_CLOCK_SKEW_MS - 5_000).toISOString();
    expectCode(() => verify(sign(unsignedFor("connection_request", undefined, { time: new Date(NOW.getTime() - 10 * 60_000).toISOString(), expires: expired }))), "expired");
  });

  test("identity binding: accountId, fingerprint, hostname and the pinned session key", () => {
    const wrongAccount = unsignedFor();
    wrongAccount.from = { ...A.peer, accountId: "0".repeat(64) };
    expectCode(() => verify(wrongAccount), "bad_identity");
    const wrongFingerprint = unsignedFor();
    wrongFingerprint.from = { ...A.peer, fingerprint: "0".repeat(64) };
    expectCode(() => verify(wrongFingerprint), "bad_identity");
    const wrongHostname = unsignedFor();
    wrongHostname.from = { ...A.peer, hostname: "not-the-node" };
    expectCode(() => verify(wrongHostname), "bad_identity");
    const stale = sign(unsignedFor());
    expectCode(
      () => validateEnvelope(stale, { now: NOW, expectedFrom: { nodeId: "aaaa1111", fingerprint: "9".repeat(64) } }),
      "stale_identity",
    );
    const wrongTarget = sign(unsignedFor());
    expectCode(
      () => validateEnvelope(wrongTarget, { now: NOW, expectedTo: { nodeId: "bbbb2222", fingerprint: "9".repeat(64) } }),
      "target_mismatch",
    );
  });
});

describe("connection_request body", () => {
  test("requestHash must be the content hash of the request", () => {
    const request = requestDocument();
    expectCode(() => verify(reseal((v) => { v.body.requestHash = "0".repeat(64); })), "conflict");
    expectCode(() => verify(reseal((v) => { v.body.request.models = ["beta/y"]; })), "conflict");
    expect(verify(sign(unsignedFor("connection_request", { requestHash: requestHashOf(request), request }))).requestHash).toBe(requestHashOf(request));
  });

  test("acceptance, target, consumer and provider cannot be swapped", () => {
    expectCode(() => verify(reseal((v) => { v.body.request.acceptance.fingerprint = "0".repeat(64); })), "quote_mismatch");
    expectCode(() => verify(reseal((v) => { v.body.request.acceptance.quoteHash = "0".repeat(64); })), "quote_mismatch");
    expectCode(() => verify(reseal((v) => { v.body.request.quote.identityFingerprint = "0".repeat(64); })), "quote_mismatch");
    expectCode(() => verify(reseal((v) => {
      v.body.request.provider.nodeId = "cccc3333";
      v.body.request.provider.hostname = "ohmyaihub-cccc3333";
      v.body.requestHash = requestHashOf(v.body.request);
    })), "target_mismatch");
    expectCode(() => verify(reseal((v) => { v.from.nodeId = "cccc3333"; v.from.hostname = "ohmyaihub-cccc3333"; })), "stale_identity");
    expectCode(() => verify(reseal((v) => { v.body.request.quote.priceLocked = true; })), "quote_mismatch");
    expectCode(() => verify(reseal((v) => { v.body.request.provider.mappedCidr = "192.168.1.2/32"; })), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.request.provider.gatewayPort = 70000; })), "malformed");
  });

  test("model ids and duplicates are rejected, and no secret field is allowed", () => {
    expectCode(() => verify(reseal((v) => { v.body.request.models = ["alpha/x; rm -rf /"]; })), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.request.models = ["alpha/x", "alpha/x"]; })), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.request.models = []; })), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.request.extra = 1; })), "malformed");
    const secretShaped = "sk-" + "x".repeat(24);
    expectCode(() => verify(reseal((v) => { v.body.request.key = secretShaped; })), "malformed");
  });
});

describe("the closed type allow-list", () => {
  test("all types are known; legacy payment/credit are refused by B1, payment_message is a narrow hook", () => {
    expect([...P2P_MESSAGE_TYPES]).toEqual([
      "connection_request",
      "approved",
      "rejected",
      "authorization_delivery",
      "ack",
      "revoked",
      "quote_changed",
      "payment_request",
      "status",
      "credit_updated",
      "payment_message",
    ]);
    expect(P2P_B1_UNSUPPORTED).toEqual(["payment_request", "credit_updated"]);

    const payment = sign(unsignedFor("payment_request", paymentBody()));
    expect(verify(payment).requestHash).toBeNull();
    expect(verify(payment).envelope.type).toBe("payment_request");
    expectCode(() => verify(reseal((v) => { v.body.amountUsd = 0; }, "payment_request", paymentBody())), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.network.tokenContract = "not-an-address"; }, "payment_request", paymentBody())), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.network.issuerType = "unknown"; }, "payment_request", paymentBody())), "malformed");

    const credit = sign(unsignedFor("credit_updated", creditBody()));
    expect(verify(credit).envelope.type).toBe("credit_updated");
    expectCode(() => verify(reseal((v) => { v.body.fundsClass = "prod"; }, "credit_updated", creditBody())), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.amountUsd = -1; }, "credit_updated", creditBody())), "malformed");

    // B's payment hook transports one opaque C object. B checks its own
    // wrapper shape/size and never interprets any C field.
    const wrapper = {
      schema: "ohmyaihub/p2p-payment/v1",
      idempotency: "request:0f3f8f0e-1111-4111-8111-111111111111",
      correlation: "0f3f8f0e-1111-4111-8111-111111111111",
      payment: { schema: "ohmyaihub/payment/v1", kind: "request", anyFutureField: { amount: "1" } },
    };
    const message = sign(unsignedFor("payment_message", wrapper));
    expect(verify(message).envelope.type).toBe("payment_message");
    expect((verify(message).envelope.body as any).payment).toEqual(wrapper.payment);
    expect(P2P_B1_UNSUPPORTED).not.toContain("payment_message");
    expectCode(() => verify(reseal((v) => { v.body.payment = [1, 2]; }, "payment_message", wrapper)), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.schema = "ohmyaihub/p2p-payment/v2"; }, "payment_message", wrapper)), "malformed");
    expectCode(() => verify(reseal((v) => { v.body.idempotency = ""; }, "payment_message", wrapper)), "malformed");
  });
});
