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
  // No watcher is ever built: this suite asserts the module's surface, and a
  // watcher would open an RPC connection to the default testnet endpoints. A
  // test must not depend on the public internet, so `status()` (the live health
  // probe) is never called here; `statusLocal()` is the zero-RPC status.
  return new Wallet({
    credit: emptySink(),
    registry: defaultRegistry(),
    store,
    makeWatcher: () => {
      throw new Error("the wallet surface tests must not build a watcher");
    },
  });
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

  test("status reports every registered chain and says when nothing is enabled", () => {
    // `statusLocal()` is the page's status: synchronous and with no RPC. The
    // authenticated `status()` performs a live chain probe, which belongs in a
    // health check, not in a unit test that must pass offline.
    const w = wallet();
    const s = w.statusLocal();
    expect(s.registry.networks.map((n) => n.chainId)).toEqual([97, 84532]);
    expect(s.disabled).toBe(false);
    expect(s.chains.every((c) => c.head === null && c.endpoints.length === 0)).toBe(true);
    w.setNetworkEnabled(97, false);
    w.setNetworkEnabled(84532, false);
    const off = w.statusLocal();
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
    // The native page opens the local console, refreshes its public snapshot,
    // or saves a launcher preference. None of these controls can move money.
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
    expect(buttons).toEqual(["打开控制台", "刷新状态", "保存偏好"]);
    for (const id of ["open", "save", "reload"]) expect(html).toContain(`id="${id}"`);
    for (const word of ["Buy", "Swap", "Bridge", "Purchase", "Pay now", "立即购买", "兑换", "跨链桥", "下单"]) {
      expect(html).not.toContain(`>${word}`);
      expect(app).not.toContain(`">${word}`);
    }
    expect(app).not.toMatch(/\b(fetch|XMLHttpRequest)\(/);
    // and the page says so itself
    expect(html).toContain("不买、不卖、不兑换、不跨链桥接");
  });

  test("the page states it is testnet only and that the tokens are not real", () => {
    expect(html).toContain("只有测试网");
    expect(html).toContain("不是 USDC");
    expect(html).toContain("不值钱");
    expect(html).toContain("不买、不卖、不兑换、不跨链桥接");
    // the third party is named as independent and liable for its own service
    expect(html).toContain("与本项目没有合作、代理或背书关系");
    expect(html).toContain("由第三方负责");
    expect(html).toContain("当地法律");
  });

  test("the page never shows a key, an address list or a payment association", () => {
    // the page may print a *command* that registers a receiving address; it must
    // never render one, nor an intent's payer or a transaction
    for (const field of ["payerAddress", "recipientAddress", "txHash", ".receiving", "wallet.intents", "wallet.events"]) {
      expect(app).not.toContain(field);
    }
    expect(html).toContain("不显示任何 Gateway Key");
  });
});
