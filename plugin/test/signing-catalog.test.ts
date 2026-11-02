import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { canonicalJson, signCanonical, signerOf } from "../src/signing.ts";
import {
  CATALOG_MAX_AGE_MS,
  buildCatalogBody,
  parseCatalogDocument,
  type CatalogPrice,
} from "../src/catalog-service.ts";
import { depositPayload } from "../src/http-router.ts";

const PRICE: CatalogPrice = { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 0.2 };

describe("canonicalJson", () => {
  test("sorts object keys and omits undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
    expect(canonicalJson([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
  });
});

describe("EIP-191 signatures", () => {
  test("signs the exact deposit-claim payload", async () => {
    const wallet = Wallet.createRandom();
    const payload = depositPayload(wallet.address.toLowerCase(), 56, "0x" + "ab".repeat(32), 1, new Date().toISOString());
    const signature = await signCanonical(wallet, payload);
    expect(signerOf(payload, signature)).toBe(wallet.address.toLowerCase());
    expect("logIndex" in depositPayload(wallet.address, 56, "0x" + "ab".repeat(32), undefined, payload.ts)).toBe(false);
  });

  test("round-trips and rejects a different payload", async () => {
    const wallet = Wallet.createRandom();
    const payload = { schema: "omai/test/1", address: wallet.address, n: 1 };
    const signature = await signCanonical(wallet, payload);
    expect(signerOf(payload, signature)).toBe(wallet.address.toLowerCase());
    expect(signerOf({ ...payload, n: 2 }, signature)).not.toBe(wallet.address.toLowerCase());
    expect(signerOf(payload, "0x1234")).toBeNull();
  });
});

describe("catalog documents", () => {
  const wallet = Wallet.createRandom();
  const body = buildCatalogBody({
    address: wallet.address,
    hostname: "omai-12345678",
    controlPort: 3426,
    gatewayPort: 3425,
    models: [{ id: "devin/swe-2", price: PRICE }],
    ts: new Date().toISOString(),
  });

  test("signs and parses its own document", async () => {
    const sig = await signCanonical(wallet, body);
    const parsed = parseCatalogDocument({ ...body, sig });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.doc.models[0]?.id).toBe("devin/swe-2");
      expect(parsed.doc.address).toBe(wallet.address);
    }
  });

  test("rejects unknown fields", async () => {
    const sig = await signCanonical(wallet, body);
    const parsed = parseCatalogDocument({ ...body, sig, extra: true });
    expect(parsed.ok).toBe(false);
  });

  test("rejects a stale signature", async () => {
    const stale = buildCatalogBody({
      address: wallet.address,
      hostname: "omai-12345678",
      controlPort: 3426,
      gatewayPort: 3425,
      models: [{ id: "devin/swe-2", price: PRICE }],
      ts: new Date(Date.now() - CATALOG_MAX_AGE_MS - 1_000).toISOString(),
    });
    const sig = await signCanonical(wallet, stale);
    const parsed = parseCatalogDocument({ ...stale, sig });
    expect(parsed.ok).toBe(false);
  });
});
