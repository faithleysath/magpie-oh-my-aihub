// Handshake tests: mutual authentication, target binding and transcript equality.
// No sockets; the hello objects are data.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateCatalogIdentity } from "../src/catalog.ts";
import { p2pIdentityFromCatalog, type P2pIdentity, type P2pLocalBinding } from "../src/p2p/identity.ts";
import {
  buildClientHello,
  buildServerHello,
  completeHandshake,
  validateClientHello,
  validateServerHello,
  type P2pHelloTarget,
} from "../src/p2p/handshake.ts";
import { generateEphemeralKeyPair } from "../src/p2p/crypto.ts";
import { P2pError, type P2pErrorCode } from "../src/p2p/protocol.ts";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const QUOTE = "aa".repeat(32);

let A: P2pIdentity;
let B: P2pIdentity;

function bindingOf(identity: P2pIdentity): P2pLocalBinding {
  return identity.binding;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "p2p-handshake-"));
  process.chdir(dir);
  const a = loadOrCreateCatalogIdentity();
  const bDir = mkdtempSync(join(tmpdir(), "p2p-handshake-b-"));
  const cwd = process.cwd();
  process.chdir(bDir);
  const b = loadOrCreateCatalogIdentity();
  process.chdir(cwd);
  A = p2pIdentityFromCatalog(a, { nodeId: "aaaa1111", hostname: "ohmyaihub-aaaa1111", mappedCidr: null, controlPort: null, gatewayPort: null, catalogQuoteHash: null });
  B = p2pIdentityFromCatalog(b, { nodeId: "bbbb2222", hostname: "ohmyaihub-bbbb2222", mappedCidr: "10.66.1.2/32", controlPort: 3427, gatewayPort: 3425, catalogQuoteHash: QUOTE });
});

function target(overrides: Partial<P2pHelloTarget> = {}): P2pHelloTarget {
  return {
    accountId: B.peer.fingerprint,
    nodeId: "bbbb2222",
    fingerprint: B.peer.fingerprint,
    mappedCidr: "10.66.1.2/32",
    controlPort: 3427,
    catalogQuoteHash: QUOTE,
    ...overrides,
  };
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

describe("signed hello / server_hello", () => {
  test("both sides derive the same transcript and keys", () => {
    const client = buildClientHello({ identity: A, target: target(), now: NOW });
    const hello = validateClientHello(client.hello, { now: NOW, local: { identity: B, binding: bindingOf(B) } });
    const ephemeral = generateEphemeralKeyPair();
    const serverHello = buildServerHello({ hello, identity: B, ephemeral, now: NOW });
    const provider = completeHandshake({ role: "provider", clientHello: hello, serverHello, ephemeral, now: NOW });
    const consumer = completeHandshake({ role: "consumer", clientHello: client.hello, serverHello, ephemeral: client.ephemeral, now: NOW });
    expect(consumer.transcriptHash).toBe(provider.transcriptHash);
    expect(consumer.keys.c2s.equals(provider.keys.c2s)).toBe(true);
    expect(consumer.keys.s2c.equals(provider.keys.s2c)).toBe(true);
    expect(consumer.keys.authorization.equals(provider.keys.authorization)).toBe(true);
    expect(consumer.peer.fingerprint).toBe(B.peer.fingerprint);
    expect(provider.peer.fingerprint).toBe(A.peer.fingerprint);
    expect(Date.parse(consumer.expiresAt)).toBeLessThanOrEqual(Date.parse(client.hello.expires));
    expect(consumer.catalogQuoteHash).toBe(QUOTE);

    const validated = validateServerHello(serverHello, {
      now: NOW,
      client: client.hello,
      expectedProvider: { nodeId: "bbbb2222", fingerprint: B.peer.fingerprint },
    });
    expect(validated.sessionId).toBe(client.sessionId);
  });

  test("the hello is bound to the provider's full current target", () => {
    const client = buildClientHello({ identity: A, target: target(), now: NOW });
    const local = { identity: B, binding: bindingOf(B) };
    const cases: Array<[P2pHelloTarget, P2pErrorCode]> = [
      [target({ nodeId: "cccc3333" }), "target_mismatch"],
      [target({ fingerprint: "0".repeat(64), accountId: "0".repeat(64) }), "stale_identity"],
      [target({ mappedCidr: "10.66.9.9/32" }), "target_mismatch"],
      [target({ controlPort: 9999 }), "target_mismatch"],
      [target({ catalogQuoteHash: "d".repeat(64) }), "quote_mismatch"],
    ];
    for (const [bad, code] of cases) {
      const hello = buildClientHello({ identity: A, target: bad, now: NOW });
      expectCode(() => validateClientHello(hello.hello, { now: NOW, local }), code);
    }
    expectCode(() => validateClientHello(client.hello, { now: NOW, local: { identity: B, binding: { ...bindingOf(B), catalogQuoteHash: null } } }), "quote_mismatch");
  });

  test("time windows, nonces and the ephemeral key are strict", () => {
    const client = buildClientHello({ identity: A, target: target(), now: NOW });
    const local = { identity: B, binding: bindingOf(B) };
    expectCode(() => validateClientHello(client.hello, { now: new Date(NOW.getTime() + 5 * 60_000), local }), "expired");
    expectCode(() => validateClientHello({ ...client.hello, clientNonce: "nope" }, { now: NOW, local }), "malformed");
    expectCode(() => validateClientHello({ ...client.hello, clientX25519: "AAAA" }, { now: NOW, local }), "malformed");
    expectCode(() => validateClientHello({ ...client.hello, sessionId: "z".repeat(32) }, { now: NOW, local }), "malformed");
    expectCode(() => validateClientHello({ ...client.hello, extra: 1 }, { now: NOW, local }), "malformed");
    expectCode(() => validateClientHello({ ...client.hello, auth: { ...client.hello.auth, signature: client.hello.auth.signature.slice(0, -4) } }, { now: NOW, local }), "bad_signature");
  });

  test("a low-order client ephemeral key cannot complete a session", () => {
    const client = buildClientHello({ identity: A, target: target(), now: NOW });
    const value = { ...client.hello, clientX25519: Buffer.alloc(32, 0).toString("base64") } as Record<string, any>;
    delete value.auth;
    const hello = validateClientHello(
      { ...value, auth: A.signHandshake("hello", value) },
      { now: NOW, local: { identity: B, binding: bindingOf(B) } },
    );
    const ephemeral = generateEphemeralKeyPair();
    const serverHello = buildServerHello({ hello, identity: B, ephemeral, now: NOW });
    expectCode(() => completeHandshake({ role: "provider", clientHello: hello, serverHello, ephemeral, now: NOW }), "bad_identity");
  });

  test("server hello echo and domain separation are checked", () => {
    const client = buildClientHello({ identity: A, target: target(), now: NOW });
    const hello = validateClientHello(client.hello, { now: NOW, local: { identity: B, binding: bindingOf(B) } });
    const ephemeral = generateEphemeralKeyPair();
    const serverHello = buildServerHello({ hello, identity: B, ephemeral, now: NOW });
    const expectedProvider = { nodeId: "bbbb2222", fingerprint: B.peer.fingerprint };
    for (const bad of [
      { ...serverHello, clientNonce: "0".repeat(64) },
      { ...serverHello, clientX25519: generateEphemeralKeyPair().publicKeyBase64 },
      { ...serverHello, sessionId: "1".repeat(32) },
    ]) {
      expectCode(() => validateServerHello(bad, { now: NOW, client: client.hello, expectedProvider }), "conflict");
    }
    // A changed provider node id no longer matches its hostname, so it is a bad
    // identity before it can be compared with the pinned provider.
    expectCode(
      () => validateServerHello({ ...serverHello, from: { ...serverHello.from, nodeId: "cccc3333" } }, { now: NOW, client: client.hello, expectedProvider }),
      "bad_identity",
    );
    expectCode(() => validateServerHello({ ...serverHello, from: A.peer }, { now: NOW, client: client.hello, expectedProvider }), "stale_identity");
    // A client hello signature cannot be replayed as a server hello.
    const swapped = { ...serverHello, auth: { ...serverHello.auth, signature: client.hello.auth.signature } };
    expectCode(() => validateServerHello(swapped, { now: NOW, client: client.hello, expectedProvider }), "bad_signature");
  });
});
