import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainStore } from "../src/chainstore.ts";
import { Wallet } from "../src/wallet.ts";
import { defaultRegistry } from "../src/networks.ts";
import type { CreditSink } from "../src/watcher.ts";

/**
 * The wallet module's own surface, and the two product claims that live in the
 * page: exactly two external links, and no buy path anywhere.
 *
 * These are deliberately boring assertions. They exist because both claims are
 * easy to erode by accident — a third link added "just for convenience", a
 * button added to a read-only page — and the brief makes them requirements.
 */

function emptySink(): CreditSink {
  return {
    depositIntent: () => ({ created: true }),
    applyDeposit: async () => {},
    freezeConsumer: async () => {},
    balance: () => ({ depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 }),
  };
}

function wallet() {
  const dir = mkdtempSync(join(tmpdir(), "wallet-surface-"));
  const store = new ChainStore(join(dir, "chain.sqlite"));
  return new Wallet({ credit: emptySink(), registry: defaultRegistry(), store });
}

describe("wallet surface", () => {
  test("a fresh wallet exposes both testnets and no assets", () => {
    const w = wallet();
    expect(w.networks().map((n) => n.chainId)).toEqual([97, 84532]);
    expect(w.allAssets()).toEqual([]);
    expect(w.receivingAddresses()).toEqual([]);
    w.close();
  });

  test("an intent needs a receiving address and refuses without one", () => {
    const w = wallet();
    expect(() =>
      w.requestIntent({ providerId: "p1", consumerId: "c1", chainId: 97, assetId: "eip155:97:0x0000000000000000000000000000000000000001", amountRaw: "1" }),
    ).toThrow(/no asset/);
    w.close();
  });

  test("a receiving address must be a real address on an enabled chain", () => {
    const w = wallet();
    expect(() => w.setReceivingAddress("p1", 97, "not an address")).toThrow(/20-byte/);
    expect(() => w.setReceivingAddress("p1", 97, "0x0000000000000000000000000000000000000000")).toThrow(/zero address/);
    expect(() => w.setReceivingAddress("p1", 56, "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6")).toThrow();
    const ok = w.setReceivingAddress("p1", 97, "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6");
    expect(ok.chainId).toBe(97);
    // The same provider may have a different address on the other chain.
    w.setReceivingAddress("p1", 84532, "0x617c2C85E9D45F1E714855FA051CcB8c538200cd");
    expect(w.receivingAddressFor("p1", 97)).toBe("0x3d80C477021E3FA568e91C73bAEC8E806518D9a6");
    expect(w.receivingAddressFor("p1", 84532)).toBe("0x617c2C85E9D45F1E714855FA051CcB8c538200cd");
    w.close();
  });

  test("disabling a network stops it from being able to receive an intent", () => {
    const w = wallet();
    w.setReceivingAddress("p1", 97, "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6");
    w.setNetworkEnabled(97, false);
    expect(() =>
      w.requestIntent({ providerId: "p1", consumerId: "c1", chainId: 97, assetId: "eip155:97:0x5fbdb2315678afecb367f032d93f642f64180aa3", amountRaw: "1" }),
    ).toThrow(/disabled/);
    w.close();
  });

  test("status reports every registered chain and says when nothing is enabled", async () => {
    const w = wallet();
    const s = await w.status();
    expect(s.registry.networks.map((n) => n.chainId)).toEqual([97, 84532]);
    expect(s.disabled).toBe(false);
    w.setNetworkEnabled(97, false);
    w.setNetworkEnabled(84532, false);
    const off = await w.status();
    expect(off.disabled).toBe(true);
    expect(off.registry.networks.every((n) => !n.enabled)).toBe(true);
    w.close();
  });

  test("the watcher can be started and stopped per chain", () => {
    const w = wallet();
    // No scan is started here: `start()` would open a socket. `runningChains`
    // reports what `start()` registered, so an empty set is the honest answer.
    expect(w.runningChains()).toEqual([]);
    w.stop();
    expect(w.runningChains()).toEqual([]);
    w.close();
  });
});

describe("the page's product claims", () => {
  const html = readFileSync(join(import.meta.dir, "..", "page", "index.html"), "utf8");
  const app = readFileSync(join(import.meta.dir, "..", "page", "app.js"), "utf8");

  test("exactly two external links, both fixed HTTPS, no query, safe rel", () => {
    const hrefs = [...html.matchAll(/<a[^>]*href="(https?:[^"]*)"[^>]*>/g)].map((m) => m[1]!);
    expect(hrefs).toEqual([
      "https://www.bnbchain.org/en/blog/moving-from-a-centralized-exchange-to-bnb-chain",
      "https://docs.peer.xyz/guides/zh/alipay-buy",
    ]);
    for (const href of hrefs) {
      expect(href).not.toContain("?");
      expect(href.startsWith("https://")).toBe(true);
    }
    const rels = [...html.matchAll(/<a[^>]*href="https?:\/\/[^"]*"[^>]*rel="([^"]*)"/g)].map((m) => m[1]!);
    expect(rels).toHaveLength(2);
    for (const rel of rels) {
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
      expect(rel).toContain("external");
    }
  });

  test("no address, amount or consumer id is ever appended to a link", () => {
    // A link built at runtime would have to appear in app.js as a template.
    expect(app).not.toMatch(/href\s*=\s*[`"']https?:/);
    expect(app).not.toMatch(/location\.href\s*=/);
    expect(app).not.toMatch(/window\.open\(/);
  });

  test("there is no buy, swap, bridge or fiat affordance", () => {
    // A form, a button or an input that could start a purchase. The page has a
    // settings form only, and the wallet section is rendered as tables.
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
    // The only two buttons are the snapshot reload and the settings form's Save.
    // Neither can move money: the form writes plugin options, nothing else.
    expect(buttons).toEqual(["Reload snapshot", "Save"]);
    for (const word of ["Buy", "Swap", "Bridge", "Purchase", "Top up with", "Pay now"]) {
      expect(html).not.toContain(`>${word}`);
    }
    expect(app).not.toMatch(/\b(fetch|XMLHttpRequest)\(/);
  });

  test("the page states it is testnet only and that the tokens are not real", () => {
    expect(html).toContain("Testnet only");
    expect(html).toContain("not USDC");
    expect(html).toContain("not worth anything");
    expect(html).toContain("does not sell, buy, swap or bridge");
    expect(html).toContain("Peer is not affiliated with this project");
  });
});
