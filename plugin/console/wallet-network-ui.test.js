import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatTokenUnits, mountWalletNetwork, productAssets, productNetworks, receivingChainIds } from "./wallet-network-ui.js";

class Node {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.handlers = {}; this.attributes = {}; this.dataset = {};
    this.className = ""; this.value = ""; this.checked = false; this.hidden = false; this.disabled = false; this._text = "";
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((node) => node.textContent || "").join(""); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; for (const node of nodes) node.parentElement = this; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
  async emit(event, payload = { preventDefault() {} }) { for (const handler of this.handlers[event] || []) await handler(payload); }
  querySelectorAll(selector) { const tags = selector.split(",").map((part) => part.trim().toUpperCase()); return this.descendants().filter((node) => tags.includes(node.tagName)); }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  click() { return this.emit("click"); }
  focus() {}
}
const all = (root, tag) => root.descendants().filter((node) => node.tagName === tag.toUpperCase());
const find = (root, tag, text) => root.descendants().find((node) => node.tagName === tag.toUpperCase() && node.textContent === text);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ADDRESS = "0x" + "2".repeat(40);
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_ID = `eip155:8453:${USDC}`;

const baseState = () => ({
  schema: "ohmyaihub.network-local/v1", at: "2026-10-31T00:00:00Z", available: true, configured: true, reason: null,
  product: {
    networks: [
      { chainId: 56, displayName: "BNB Smart Chain", networkType: "mainnet", support: "read-only", receivable: true, nativeSymbol: "BNB", nativeDecimals: 18, blockExplorer: "https://bscscan.com" },
      { chainId: 8453, displayName: "Base", networkType: "mainnet", support: "read-only", receivable: true, nativeSymbol: "ETH", nativeDecimals: 18, blockExplorer: "https://basescan.org" },
    ],
    assets: [{ assetId: USDC_ID, chainId: 8453, contractAddress: USDC, symbol: "USDC", decimals: 6, issuerType: "native-issuer", testnetOnly: false, credit: false, pricingKind: "not-creditable" }],
  },
  receiving: { providerId: "local-node", chainIds: [], updatedAt: null, available: true, errorCode: null }, watchAddresses: [], lastBalance: null,
  readOnly: true, creditEligible: false, usdValue: null,
});

function browser() {
  const previous = globalThis.document;
  const nodes = new Map(); const body = new Node("body");
  const document = { body, getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node("div")); return nodes.get(id); }, createElement: (tag) => new Node(tag) };
  globalThis.document = document;
  return { document, nodes, restore() { globalThis.document = previous; } };
}
function mount(actions = {}) {
  const env = browser(); const calls = []; const notices = [];
  const client = { action: async (name, input) => { calls.push({ name, input: structuredClone(input) }); const handler = actions[name]; if (!handler) throw Object.assign(new Error("action_not_allowed"), { status: 404 }); return await handler(input); } };
  const mounted = mountWalletNetwork({ client, getState: () => ({ configured: true }), notice: (...args) => notices.push(args), refreshState: async () => {} });
  const root = env.nodes.get("wallet-network-panel");
  return { ...env, root, calls, notices, mounted, async show() { await mounted.onShow(); await flush(); }, restore() { mounted.dispose(); env.restore(); } };
}
function selectByLabel(root, label) {
  const field = root.descendants().find((node) => node.tagName === "LABEL" && node.textContent.startsWith(label));
  return field?.descendants().find((node) => node.tagName === "SELECT");
}
function inputByLabel(root, label) {
  const field = root.descendants().find((node) => node.tagName === "LABEL" && node.textContent.startsWith(label));
  return field?.descendants().find((node) => node.tagName === "INPUT");
}

describe("read-only network/asset UI", () => {
  test("formats native and token decimals exactly and keeps BSC USDC unsupported", () => {
    expect(formatTokenUnits("1234567", 6)).toBe("1.234567");
    expect(formatTokenUnits("1000000000000000000", 18)).toBe("1");
    expect(formatTokenUnits("1", 18)).toBe("0.000000000000000001");
    const state = baseState();
    expect(productNetworks(state).map((n) => n.chainId)).toEqual([56, 8453]);
    expect(productAssets(state, 8453).map((a) => a.symbol)).toEqual(["USDC"]);
    expect(productAssets(state, 56)).toEqual([]);
    expect(receivingChainIds(state)).toEqual([]);
  });

  test("shows both networks equally, native symbols separated, Base USDC, and no BSC USDC guess", async () => {
    const ui = mount({ "network-local-state": async () => baseState() });
    try {
      await ui.show();
      expect(ui.root.textContent).toContain("BNB Smart Chain");
      expect(ui.root.textContent).toContain("Base");
      expect(ui.root.textContent).toContain("BNB");
      expect(ui.root.textContent).toContain("ETH");
      expect(ui.root.textContent).toContain("USDC");
      expect(ui.root.textContent).toContain("BSC USDC 未在只读注册表列出时不支持");
      expect(ui.root.textContent).toContain("不可授信");
      expect(ui.root.textContent).toContain("主网发送、授信、自动充值和资金流当前未开放");
      expect(ui.calls.map((call) => call.name)).toEqual(["network-local-state"]);
      expect(all(ui.root, "button").filter((node) => node.textContent === "读取所选只读余额")).toHaveLength(1);
      expect(ui.root.textContent).not.toContain("$0.00");
    } finally { ui.restore(); }
  });

  test("receiving selection defaults empty and BSC/Base toggles are independent", async () => {
    let state = baseState();
    const ui = mount({
      "network-local-state": async () => state,
      "network-local-receiving-set": async (input) => { const chainIds = new Set(state.receiving.chainIds); if (input.selected) chainIds.add(input.chainId); else chainIds.delete(input.chainId); state = { ...state, receiving: { ...state.receiving, chainIds: [...chainIds] } }; return state; },
    });
    try {
      await ui.show();
      const checks = all(ui.root, "input").filter((node) => node.type === "checkbox");
      expect(checks).toHaveLength(2);
      expect(checks.every((node) => node.checked === false)).toBe(true);
      checks[0].checked = true; await checks[0].emit("change"); await flush();
      expect(ui.calls.at(-1)).toEqual({ name: "network-local-receiving-set", input: { chainId: 56, selected: true } });
      checks[1].checked = true; await checks[1].emit("change"); await flush();
      expect(ui.calls.at(-1).input).toEqual({ chainId: 8453, selected: true });
      const after = all(ui.root, "input").filter((node) => node.type === "checkbox");
      expect(after[0].checked).toBe(true); expect(after[1].checked).toBe(true);
    } finally { ui.restore(); }
  });

  test("watch address is explicit and malformed addresses never call the service", async () => {
    let state = baseState();
    const ui = mount({ "network-local-state": async () => state, "network-local-watch-address": async (input) => { state = { ...state, watchAddresses: [input.address] }; return state; } });
    try {
      await ui.show();
      const input = inputByLabel(ui.root, "公开 watch 地址");
      input.value = "0x0"; await find(ui.root, "button", "添加 watch 地址").click(); await flush();
      expect(ui.calls.filter((call) => call.name === "network-local-watch-address")).toHaveLength(0);
      input.value = ADDRESS; await find(ui.root, "button", "添加 watch 地址").click(); await flush();
      expect(ui.calls.find((call) => call.name === "network-local-watch-address").input).toEqual({ address: ADDRESS });
      expect(ui.root.textContent).toContain(ADDRESS);
      expect(ui.root.textContent).toContain("钱包连接地址不会自动成为 watch/收款地址");
    } finally { ui.restore(); }
  });

  test("explicit refresh sends the exact watch context and shows exact token units, never $", async () => {
    let state = { ...baseState(), watchAddresses: [ADDRESS] };
    const ui = mount({
      "network-local-state": async () => state,
      "network-local-balance-refresh": async (input) => ({ balance: { schema: "ohmyaihub.network-local-balance/v1", state: "ok", chainId: input.chainId, address: input.address, asset: { assetId: USDC_ID, contractAddress: USDC, symbol: "USDC", decimals: 6, issuerType: "native-issuer" }, nativeSymbol: "ETH", balanceRaw: "1234567", decimals: 6, balanceTokens: "1.234567", blockNumber: 42, addressSource: "watch", readOnly: true, creditEligible: false, usdValue: null, observedAt: "2026-10-31T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", fresh: true, stale: false, needsRefresh: false } }),
    });
    try {
      await ui.show();
      const chain = selectByLabel(ui.root, "网络"); chain.value = "8453"; await chain.emit("change");
      const asset = selectByLabel(ui.root, "资产"); expect([...asset.descendants()].some((node) => node.tagName === "OPTION" && node.value === USDC_ID)).toBe(true);
      asset.value = USDC_ID; await asset.emit("change");
      const address = selectByLabel(ui.root, "已 watch 地址"); address.value = ADDRESS; await address.emit("change");
      await find(ui.root, "button", "读取所选只读余额").click(); await flush();
      expect(ui.calls.find((call) => call.name === "network-local-balance-refresh").input).toEqual({ chainId: 8453, address: ADDRESS, addressSource: "watch", assetId: USDC_ID });
      expect(ui.root.textContent).toContain("1.234567");
      expect(ui.root.textContent).toContain("未估值");
      expect(ui.root.textContent).toContain("只读余额不是可消费额度");
      expect(ui.root.textContent).not.toContain("$0");
    } finally { ui.restore(); }
  });

  test("stale/historical balance is labelled and is not shown as real-time", async () => {
    const state = { ...baseState(), watchAddresses: [ADDRESS], lastBalance: { schema: "ohmyaihub.network-local-balance/v1", state: "ok", chainId: 56, address: ADDRESS, addressSource: "watch", asset: null, nativeSymbol: "BNB", balanceRaw: "1000000000000000000", decimals: 18, balanceTokens: "1", blockNumber: 1, readOnly: true, creditEligible: false, usdValue: null, observedAt: "2026-10-31T00:00:00Z", expiresAt: "2026-10-31T00:05:00Z", fresh: false, stale: true, needsRefresh: true } };
    const ui = mount({ "network-local-state": async () => state });
    try {
      await ui.show();
      expect(ui.root.textContent).toContain("历史已知余额");
      expect(ui.root.textContent).toContain("不是实时");
      expect(ui.root.textContent).toContain("显式 watch");
      expect(ui.root.textContent).not.toContain("实时绿");
    } finally { ui.restore(); }
  });

  test("receiving unavailable/errorCode is not rendered as a user-cleared empty selection", async () => {
    const state = baseState();
    state.receiving = { ...state.receiving, available: false, errorCode: "receiving_selection_unreadable", chainIds: [] };
    const ui = mount({ "network-local-state": async () => state });
    try {
      await ui.show();
      expect(ui.root.textContent).toContain("无法读取");
      expect(ui.root.textContent).toContain("不代表你清空了选择");
      expect(all(ui.root, "input").filter((node) => node.type === "checkbox")).toHaveLength(0);
    } finally { ui.restore(); }
  });

  test("watch address list is capped at 32 and never auto-expands", async () => {
    const state = { ...baseState(), watchAddresses: Array.from({ length: 32 }, (_, index) => "0x" + index.toString(16).padStart(40, "0")) };
    const ui = mount({ "network-local-state": async () => state, "network-local-watch-address": async () => state });
    try {
      await ui.show();
      const input = inputByLabel(ui.root, "公开 watch 地址"); input.value = ADDRESS;
      await find(ui.root, "button", "添加 watch 地址").click(); await flush();
      expect(ui.root.textContent).toContain("最多只能显式 watch 32");
      expect(ui.calls.filter((call) => call.name === "network-local-watch-address")).toHaveLength(0);
    } finally { ui.restore(); }
  });

  test("unknown balance stays unknown and is not rendered as zero", async () => {
    let state = { ...baseState(), watchAddresses: [ADDRESS] };
    const ui = mount({ "network-local-state": async () => state, "network-local-balance-refresh": async (input) => ({ balance: { schema: "ohmyaihub.network-local-balance/v1", state: "unknown", chainId: input.chainId, address: input.address, assetId: null, readOnly: true, creditEligible: false, usdValue: null, errorCode: "balance_unavailable", observedAt: "2026-10-31T00:00:00Z" } }) });
    try {
      await ui.show();
      const chain = selectByLabel(ui.root, "网络"); chain.value = "56"; await chain.emit("change");
      const asset = selectByLabel(ui.root, "资产"); asset.value = "native"; await asset.emit("change");
      const address = selectByLabel(ui.root, "已 watch 地址"); address.value = ADDRESS; await address.emit("change");
      await find(ui.root, "button", "读取所选只读余额").click(); await flush();
      expect(ui.root.textContent).toContain("余额未知");
      expect(ui.root.textContent).not.toContain("0 BNB");
      expect(ui.calls.filter((call) => call.name === "network-local-balance-refresh")).toHaveLength(1);
    } finally { ui.restore(); }
  });

  test("service absent fails closed with no mock network data", async () => {
    const ui = mount();
    try {
      await ui.show();
      expect(ui.root.textContent).toContain("只读网络服务未接入");
      expect(ui.root.textContent).not.toContain("USDC");
      expect(all(ui.root, "button").filter((node) => node.textContent === "读取所选只读余额")).toHaveLength(0);
      expect(ui.calls.map((call) => call.name)).toEqual(["network-local-state"]);
    } finally { ui.restore(); }
  });

  test("source has no RPC client, storage, CSP changes, payment or auto-recharge", () => {
    const source = readFileSync(new URL("./wallet-network-ui.js", import.meta.url), "utf8");
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "fetch(", "eth_sendTransaction", "eth_call", "wallet-local", "operationPort", "autoRecharge", "contentSecurityPolicy"]) expect(source.includes(forbidden)).toBe(false);
  });
});
