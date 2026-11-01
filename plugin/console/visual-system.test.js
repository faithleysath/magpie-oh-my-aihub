import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Guards the visual system the AI-slop review asked for. These are source-level
 * rules with a rendered-state check where one is cheap: a page must not quietly
 * reintroduce badges, middle-dot metadata, mono prose, nested stickers, a fifth
 * type size, a colored side bar or a decorative arrow.
 */
const here = new URL(".", import.meta.url);
const read = (name) => readFileSync(new URL(name, here), "utf8");
const html = read("index.html");
const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
const modules = readdirSync(here)
  .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
  .map((name) => [name, read(name)]);

describe("one plain status language", () => {
  test("no pill component is shipped or used", () => {
    expect(css).not.toMatch(/\.pill\b/);
    for (const [name, source] of modules) expect(`${name}:${source.includes('class="pill')}`).toBe(`${name}:false`);
    for (const [name, source] of modules) expect(`${name}:${source.includes("`pill ")}`).toBe(`${name}:false`);
  });

  test("status text is text, and semantic colour is only good/bad", () => {
    expect(css).toContain(".status-text {");
    expect(css).toContain(".status-text.good { color: var(--good); }");
    expect(css).toContain(".status-text.bad { color: var(--bad); }");
    expect(css).toContain(".session-state.good::before");
  });
});

describe("typography and mono scope", () => {
  test("exactly four type sizes, body 16 and helper 14", () => {
    const tokens = [...css.matchAll(/--text-(sm|base|lg|xl): (\d+)px;/g)].map((match) => Number(match[2]));
    expect(tokens).toEqual([14, 16, 20, 26]);
    const sizes = [...css.matchAll(/font-size: ([^;]+);/g)].map((match) => match[1].trim());
    for (const value of sizes) expect(value.startsWith("var(--text-")).toBe(true);
    expect(sizes.some((value) => value === "var(--text-base)")).toBe(true);
    // No small print below 14 px anywhere, including the tokens themselves.
    for (const value of tokens) expect(value).toBeGreaterThanOrEqual(14);
  });

  test("mono is an identifier style, not the default for lists or prose", () => {
    const selectors = [...css.matchAll(/([^{}]+)\{[^}]*font-family: var\(--font-mono\)/g)]
      .flatMap((match) => match[1].split(","))
      .map((selector) => selector.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const allowed = [
      "code", ".fingerprint", ".secret-value", ".mono", ".amount",
      ".workflow-details span.mono", ".wallet-payment-facts dd.mono",
      ".facts dd.mono", ".wallet-vault-facts dd.mono", ".pairing-code",
      ".wallet-vault-secret",
    ];
    for (const selector of selectors) expect(allowed).toContain(selector);
    // The reviewed offenders are gone.
    for (const gone of [".credit-list li", ".home-model-group ul", ".facts dd", ".workflow-details span", ".wallet-payment-list small"]) {
      const start = css.indexOf(`${gone} {`);
      expect(start).toBeGreaterThan(-1);
      expect(css.slice(start, css.indexOf("}", start))).not.toContain("font-family: var(--font-mono)");
    }
  });
});

describe("one sticker layer", () => {
  test("only a card, a dialog, a button and the brand mark carry a hard shadow", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map((match) => [match[1].replace(/\s+/g, " ").trim(), match[2]])
      .filter(([, body]) => body.includes("box-shadow: var("));
    const allowed = [
      ".brand-mark", ".nav-item.active", '.nav-item[aria-current="page"]',
      ".card", ".button", ".icon-button", "dialog.workflow-dialog",
      ".pairing-code", ".wallet-network-card",
      ".field input:focus-visible", ".field textarea:focus-visible",
      ".field select:focus-visible", ".workflow-search:focus-visible",
    ];
    for (const [selector] of rules) {
      for (const part of selector.split(",").map((value) => value.trim())) expect(allowed).toContain(part);
    }
    expect(css).not.toContain(".card .card");
  });

  test("warnings use one full thin border, never a colored left bar", () => {
    expect(css).not.toContain("border-left");
    const rule = css.slice(css.indexOf(".inline-warning {"), css.indexOf("}", css.indexOf(".inline-warning {")));
    expect(rule).toContain("border: 1px solid var(--bad)");
    expect(rule).toContain("background: transparent");
  });

  test("inner lists are flat rows, not second stickers", () => {
    for (const selector of [".wallet-payment-list li", ".wallet-network-assets li", ".wallet-choice", ".discovery-model", ".wallet-timeline > li"]) {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThan(-1);
      const rule = css.slice(start, css.indexOf("}", start));
      expect(rule).not.toContain("box-shadow: var(");
      expect(rule).not.toMatch(/border: var\(--stroke\)/);
    }
  });
});

describe("plain language in ordinary UI", () => {
  test("no middle-dot metadata and no decorative arrows in shipped UI", () => {
    for (const [name, source] of [["index.html", html], ...modules]) {
      expect(`${name}:${source.includes("·")}`).toBe(`${name}:false`);
      expect(`${name}:${source.includes("→")}`).toBe(`${name}:false`);
    }
  });

  test("no shipped module prints the credit jargon 授信", () => {
    for (const [name, source] of modules) expect(`${name}:${source.includes("授信")}`).toBe(`${name}:false`);
  });

  test("the approval copy does not translate internal binding fields into the main view", () => {
    const providers = modules.find(([name]) => name === "providers.js")[1];
    expect(providers).toContain("核对伙伴、模型、价格和额度后再批准。密钥会自动安全交付，无需发送文件。");
    expect(providers).toContain("默认选择全部申请模型。选择变化后，需要重新预览当前报价。");
    expect(providers).toContain("额度必须大于 0；0 表示不限制，不能用于暂停。");
    expect(providers).not.toContain("价格版本与批准代次");
    expect(providers).not.toContain("本页不计算价格版本");
    expect(providers).not.toContain("完整身份指纹：${");
  });

  test("implementation terms stay out of ordinary headings", () => {
    const ordinary = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(ordinary).not.toContain("EIP-6963");
    expect(ordinary).not.toContain("FULL AUTO");
    expect(html).not.toContain("不可授信");
  });

  test("home has one text action per block and no duplicate arrow labels", () => {
    const home = html.slice(html.indexOf('<section id="overview"'), html.indexOf('<section id="discovery-page"'));
    expect([...home.matchAll(/data-goto="/g)]).toHaveLength(4);
    for (const label of ["查看网络", "去发现", "查看共享", "查看钱包"]) expect(home).toContain(`>${label}</button>`);
  });
});

/**
 * The review also found copy that only exists inside dialogs and panels, which
 * a source scan of index.html cannot see. These tests mount the shipped modules
 * in a small DOM and read the text a user can actually see: closed <details>
 * and hidden nodes are excluded, exactly like the browser audit.
 */
class DomNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.handlers = {};
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this._text = "";
    this.classList = {
      toggle: (name, on) => { const set = new Set(this.className.split(" ").filter(Boolean)); if (on) set.add(name); else set.delete(name); this.className = [...set].join(" "); },
      add: (name) => { if (!this.className.split(" ").includes(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: (name) => { this.className = this.className.split(" ").filter((part) => part !== name).join(" "); },
      contains: (name) => this.className.split(" ").includes(name),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((node) => node.textContent || "").join(""); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.unshift(node); } }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; for (const node of nodes) node.parentElement = this; }
  remove() { this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
  async emit(event, payload = { preventDefault() {} }) { for (const handler of this.handlers[event] || []) await handler(payload); }
  click() { return this.emit("click"); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  reportValidity() { return true; }
  scrollIntoView() {}
  reset() {}
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector) {
    const parts = selector.split(",").map((part) => part.trim()).filter(Boolean);
    const matches = (node) => parts.some((part) => {
      if (part.startsWith(".")) return node.classList.contains(part.slice(1));
      const tag = part.replace(/\[.*\]$/, "").toUpperCase();
      return node.tagName === tag;
    });
    return this.descendants().filter(matches);
  }
}
/** Text a user can see: hidden nodes and closed details are not rendered. */
function visibleText(node) {
  if (!node || node.hidden) return "";
  // A closed <details> still shows its summary; only the body is hidden.
  if (node.tagName === "DETAILS" && !node.open) {
    return node.children.filter((child) => child.tagName === "SUMMARY").map((child) => visibleText(child)).join(" ");
  }
  return (node._text || "") + node.children.map((child) => visibleText(child)).join(" ");
}
function dom() {
  const previous = globalThis.document;
  const body = new DomNode("body");
  const nodes = new Map();
  const document = {
    body,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new DomNode(id.startsWith("nav-") ? "button" : "div")); return nodes.get(id); },
    createElement: (tag) => new DomNode(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  globalThis.document = document;
  return { document, body, nodes, restore() { globalThis.document = previous; } };
}
const windowStub = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, ethereum: undefined };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const BANNED_ORDINARY = ["授信", "EIP-6963", "window.ethereum", "chainId", "priceVersion", "FULL AUTO", "价格版本", "批准代次", "代次", "generation"];
const bannedIn = (text) => BANNED_ORDINARY.filter((term) => text.includes(term));
const byText = (root, tag, text) => root.descendants().find((node) => node.tagName === tag.toUpperCase() && node.textContent === text);

describe("visible dialogs and panels carry no implementation terms", () => {
  test("the connect-wallet dialog and the wallet page stay in user language", async () => {
    const env = dom();
    const { mountWalletVault } = await import("./wallet-vault-ui.js");
    const locked = { version: 1, address: "0x" + "1".repeat(40), addressVerified: false, status: "locked", unlockExpiresAt: null };
    const mounted = mountWalletVault({
      client: { action: async () => ({ wallet: locked }) },
      getState: () => ({ configured: true }), notice() {}, refreshState: async () => {}, windowTarget: windowStub,
    });
    try {
      await mounted.onShow(); await flush();
      await byText(env.nodes.get("wallet-vault-panel"), "button", "导入或恢复其他钱包").click(); await flush();
      const dialog = env.body.children.find((node) => node.tagName === "DIALOG");
      expect(dialog.open).toBe(true);
      const text = visibleText(dialog);
      expect(text).toContain("不会自动连接其他钱包");
      expect(bannedIn(text)).toEqual([]);
      const page = visibleText(env.nodes.get("wallet-vault-panel"));
      expect(page).toContain("解锁并验证后才能把地址用作收款地址");
      expect(bannedIn(page)).toEqual([]);
    } finally { mounted.dispose(); env.restore(); }
  });

  test("the read-only network panel shows BSC/Base, never a chain id or 授信", async () => {
    const env = dom();
    const { mountWalletNetwork } = await import("./wallet-network-ui.js");
    const state = {
      schema: "ohmyaihub.network-local/v1", at: "2026-11-01T00:00:00Z", available: true, configured: true, reason: null,
      product: {
        networks: [
          { chainId: 56, displayName: "BNB Smart Chain", support: "read-only", receivable: true, nativeSymbol: "BNB", nativeDecimals: 18, blockExplorer: "https://bscscan.com" },
          { chainId: 8453, displayName: "Base", support: "read-only", receivable: true, nativeSymbol: "ETH", nativeDecimals: 18, blockExplorer: "https://basescan.org" },
        ],
        assets: [{ assetId: "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", chainId: 8453, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6, issuerType: "native-issuer", credit: false }],
      },
      receiving: { providerId: "local-node", chainIds: [], updatedAt: null, available: true, errorCode: null },
      watchAddresses: [], lastBalance: null, readOnly: true, creditEligible: false, usdValue: null,
    };
    const mounted = mountWalletNetwork({ client: { action: async () => state }, getState: () => ({ configured: true }), notice() {}, refreshState: async () => {} });
    try {
      await mounted.onShow(); await flush();
      const text = visibleText(env.nodes.get("wallet-network-panel"));
      expect(text).toContain("BSC");
      expect(text).toContain("Base");
      expect(text).toContain("只查询余额，不能付款或充值");
      expect(text).toContain("不会自动增加可用额度");
      expect(text).not.toContain("链 56");
      expect(text).not.toContain("链 8453");
      expect(bannedIn(text)).toEqual([]);
    } finally { mounted.dispose(); env.restore(); }
  });

  test("the recharge form and payment preview keep chain ids in collapsed details", async () => {
    const env = dom();
    const { mountPaymentP2p } = await import("./payment-p2p-ui.js");
    const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const state = {
      schema: "ohmyaihub.payment-p2p-state/v1", available: true, reason: null,
      provider: { enabled: true, networks: [84532], assets: [{ assetId: `eip155:84532:${USDC}`, chainId: 84532, symbol: "tUSDC", decimals: 6, contractAddress: USDC }], receiving: [], requests: [] },
      consumer: {
        remotes: [{ providerNodeId: "provider-node", generation: 1, capUsd: 5, providerFingerprint: "f".repeat(64) }],
        obligations: [{ invoiceId: "inv_1", amountRaw: "1500000", decimals: 6, chainId: 84532, providerNodeId: "provider-node", signed: true, peerStatus: "waitingpayment", status: "waitingpayment", expiresAt: "2026-11-01T00:10:00Z" }],
        pending: [],
      },
      auto: { enabled: false, mode: "manual-confirm", executor: "none", fullAuto: false, triggerUsd: 1, perPaymentMaxUsd: 5, dailyMaxUsd: 20, gasMaxWei: "2000000000000000", authorizationTtlSec: 600 },
      reminder: null, readOnly: true,
    };
    const mounted = mountPaymentP2p({
      client: { action: async (name) => {
        if (name !== "payment-local-send-preview") throw Object.assign(new Error("not used"), { status: 404 });
        return { invoiceId: "inv_1", chainId: 84532, assetId: `eip155:84532:${USDC}`, recipientAddress: "0x" + "2".repeat(40), amountTokens: "1.5", amountRaw: "1500000", payerAddress: "0x" + "3".repeat(40), nonce: 3, gasLimit: "21000", maxFeePerGas: "1000000000", maxGasCostWei: "21000000000000", nativeSymbol: "ETH", tokenBalanceRaw: "5000000", decimals: 6, digest: "0x" + "a".repeat(64), expiresAt: "2026-11-01T00:10:00Z", previewRef: "0f3f8f0e-1111-4111-8111-111111111111" };
      } },
      getState: () => ({ configured: true }), notice() {}, refreshState: async () => {},
    });
    try {
      mounted.render({ status: { paymentP2p: state } }); await flush();
      const root = env.nodes.get("payment-p2p-panel");
      const before = visibleText(root);
      expect(before).toContain("Base 测试网");
      expect(before).not.toContain("链 84532");
      expect(bannedIn(before)).toEqual([]);
      await byText(root, "button", "预览并付款").click(); await flush();
      const preview = visibleText(root);
      expect(preview).toContain("Base 测试网");
      expect(preview).toContain("技术详情");
      expect(preview).not.toContain("链 84532");
      expect(bannedIn(preview)).toEqual([]);
    } finally { mounted.dispose(); env.restore(); }
  });

  test("the human approval dialog and its selected quote preview are clean by default", async () => {
    const env = dom();
    const { mountProviders } = await import("./providers.js");
    const fingerprint = "a".repeat(64);
    const state = {
      schema: "ohmyaihub/console/1", at: "2026-11-01T00:00:00Z", configured: true,
      status: {
        config: { catalog: { discoveryEnabled: true }, share: { models: [] } },
        catalog: { quote: { models: [{ id: "provider/alpha-model", displayName: "alpha-model", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, unit: "USD per 1M tokens", source: "magpie-settings" } }] }, peers: [] },
        providers: [], consumers: [], readiness: { state: "ready", reasons: [] }, checks: [],
        p2p: {
          inboundRequests: [{ requestId: "req-1", consumerNodeId: "consumer-node", consumerHostname: "consumer-host", consumerFingerprint: fingerprint, quoteHash: "b".repeat(64), priceVersion: "c".repeat(64), models: ["provider/alpha-model"], capUsd: 0.05, expiresAt: "2026-11-01T00:10:00Z", receivedAt: "2026-11-01T00:00:00Z", state: "pending", tofu: "pending" }],
          approvals: [{ approvalId: "appr-1", consumerNodeId: "consumer-node", consumerFingerprint: fingerprint, providerNodeId: "provider-node", providerFingerprint: "d".repeat(64), quoteHash: "b".repeat(64), priceVersion: "c".repeat(64), generation: 1, keyId: "key-1", models: ["provider/alpha-model"], capUsd: 0.05, state: "delivering", delivery: { state: "queued" }, approvedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-01T00:10:00Z" }],
          connections: [],
        },
      },
      workflows: { requests: [] },
    };
    const mounted = mountProviders({
      client: { action: async (name) => {
        if (name !== "p2p-quote-preview") throw Object.assign(new Error("not used"), { status: 404 });
        return { models: ["provider/alpha-model"], pricing: [{ id: "provider/alpha-model", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, unit: "USD per 1M tokens", source: "magpie-settings" } }], quoteHash: "b".repeat(64), priceVersion: "c".repeat(64) };
      } },
      getState: () => state, onState() {}, notice() {}, setBusy() {}, refreshState: async () => {},
    });
    try {
      mounted.render(state); await flush();
      const sharing = visibleText(env.nodes.get("sharing-panel"));
      expect(sharing).toContain("正在交付");
      expect(sharing).not.toMatch(/\b(delivering|queued|pending|approved|connected)\b/);
      expect(bannedIn(sharing)).toEqual([]);
      await byText(env.nodes.get("sharing-panel"), "button", "核对并批准").click(); await flush();
      const dialog = env.body.children.find((node) => node.tagName === "DIALOG");
      const text = visibleText(dialog);
      expect(text).toContain("核对伙伴、模型、价格和额度后再批准");
      expect(text).toContain("密钥会自动安全交付");
      expect(text).toContain("默认选择全部申请模型。选择变化后，需要重新预览当前报价。");
      expect(text).toContain("本次授权的额度");
      expect(text).toContain("额度必须大于 0；0 表示不限制，不能用于暂停。");
      expect(text).toContain("我核对并接受上述完整身份指纹");
      expect(text).toContain("alpha-model");
      expect(text).not.toMatch(/\b(delivering|queued|pending|approved)\b/);
      // One fingerprint and one quote line, not a duplicate pair.
      expect((text.match(/\b[0-9a-f]{64}\b/g) || []).length).toBe(1);
      expect((text.match(/输入 \$/g) || []).length).toBe(1);
      expect(bannedIn(text)).toEqual([]);
    } finally { mounted.dispose(); env.restore(); }
  });
});
