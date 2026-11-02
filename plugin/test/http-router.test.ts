import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import type { CatalogService } from "../src/catalog-service.ts";
import type { DepositClaimInput } from "../src/deposit-claim.ts";
import type { Grants } from "../src/grants.ts";
import { DirectoryServer, depositPayload } from "../src/http-router.ts";
import { signCanonical } from "../src/signing.ts";

const TX = `0x${"bb".repeat(32)}`;

describe("deposit route", () => {
  test("verifies the signature, maps the body and returns the claimer answer", async () => {
    const wallet = Wallet.createRandom();
    let seen: DepositClaimInput | null = null;
    const server = new DirectoryServer({
      catalog: { current: null, detail: null } as unknown as CatalogService,
      grants: {} as unknown as Grants,
      deposits: {
        async claim(input) {
          seen = input;
          return { state: "pending", chainId: input.chainId, txHash: input.txHash, ts: new Date().toISOString() };
        },
      },
      controlPort: 0,
    });
    expect(server.start("127.0.0.1")).toBe(true);
    try {
      const ts = new Date().toISOString();
      const payload = depositPayload(wallet.address.toLowerCase(), 56, TX, 1, ts);
      const sig = await signCanonical(wallet, payload);
      const response = await fetch(`http://127.0.0.1:${server.port}/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, sig }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "pending", chainId: 56, txHash: TX });
      expect(seen).toMatchObject({
        payer: wallet.address.toLowerCase(),
        chainId: 56,
        txHash: TX,
        logIndex: 1,
      });
    } finally {
      server.stop();
    }
  });

  test("rejects a bad signature before the claimer is called", async () => {
    let called = false;
    const server = new DirectoryServer({
      catalog: { current: null, detail: null } as unknown as CatalogService,
      grants: {} as unknown as Grants,
      deposits: {
        async claim() {
          called = true;
          return { state: "failed", chainId: 56, txHash: TX, ts: new Date().toISOString() };
        },
      },
      controlPort: 0,
    });
    expect(server.start("127.0.0.1")).toBe(true);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: "omai/deposit/1",
          address: `0x${"11".repeat(20)}`,
          chainId: 56,
          txHash: TX,
          ts: new Date().toISOString(),
          sig: `0x${"00".repeat(65)}`,
        }),
      });
      expect(response.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      server.stop();
    }
  });
});
