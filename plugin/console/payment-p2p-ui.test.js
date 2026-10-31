import { describe, expect, test } from "bun:test";
import { mountPaymentP2p, obligationActions, parseTokenAmount, paymentStatusLabel, formatRawAmount } from "./payment-p2p-ui.js";

class Node {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.handlers = {};
    this.attributes = {};
    this.className = "";
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.type = "";
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
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; for (const node of nodes) node.parentElement = this; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
  async emit(event) { for (const handler of this.handlers[event] || []) await handler({ preventDefault() {} }); }
  querySelectorAll() { return []; }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  focus() {}
  scrollIntoView() {}
  async click() { if (this.disabled) return; await this.emit("click"); }
}
const all = (root, tag) => root.descendants().filter((node) => node.tagName === tag.toUpperCase());
const find = (root, tag, text) => all(root, tag).find((node) => node.textContent === text);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function browser() {
  const previous = { document: globalThis.document };
  const nodes = new Map();
  const body = new Node("body");
  const document = {
    body,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node("div")); return nodes.get(id); },
    createElement: (tag) => new Node(tag),
  };
  globalThis.document = document;
  return { document, nodes, restore() { globalThis.document = previous.document; } };
}

const ASSET = "eip155:84532:0x5fbdb2315678afecb367f032d93f642f64180aa3";
const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const RECIPIENT = "0x3d80c477021e3fa568e91c73baec8e806518d9a6";
const PAYER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const now = new Date().toISOString();

function state(overrides = {}) {
  return {
    status: {
      paymentP2p: {
        schema: "ohmyaihub.payment-p2p-state/v1",
        at: now,
        available: true,
        nodeId: "consumer-node",
        fingerprint: "a".repeat(64),
        provider: {
          enabled: true,
          networks: [84532],
          assets: [{ chainId: 84532, assetId: ASSET, contractAddress: CONTRACT, decimals: 6, symbol: "tUSDC" }],
          receiving: [],
          requests: [{
            requestId: "req-provider", invoiceId: "inv_11111111-1111-4111-8111-111111111111",
            consumerNodeId: "consumer-node", consumerFingerprint: "b".repeat(64),
            chainId: 84532, assetId: ASSET, contractAddress: CONTRACT, decimals: 6, amountRaw: "1500000",
            recipientAddress: RECIPIENT, status: "waitingpayment", peerStatus: null,
            signaturePresent: true, payerAddress: PAYER, expiresAt: now, error: null,
          }],
        },
        consumer: {
          remotes: [{ providerNodeId: "provider-node", providerFingerprint: "c".repeat(64), approvalId: "approval-1", generation: 3, capUsd: 5 }],
          obligations: [{
            requestId: "req-consumer", invoiceId: "inv_22222222-2222-4222-8222-222222222222",
            providerNodeId: "provider-node", providerFingerprint: "c".repeat(64), authorizationGeneration: 3,
            quoteHash: "d".repeat(64), priceVersion: "v1", chainId: 84532, assetId: ASSET,
            contractAddress: CONTRACT, decimals: 6, amountRaw: "1500000", recipientAddress: RECIPIENT,
            status: "waitingpayment", peerStatus: "waitingpayment", signed: true, payerAddress: PAYER,
            expiresAt: now, error: null,
          }],
          pending: [],
        },
        auto: {
          enabled: false, mode: "manual-confirm", executor: "none", fullAuto: false,
          providerNodeId: "provider-node", providerFingerprint: "c".repeat(64), chainId: 84532, assetId: ASSET,
          triggerUsd: 1, perPaymentMaxUsd: 5, dailyMaxUsd: 20, gasMaxWei: "2000000000000000", authorizationTtlSec: 600,
          updatedAt: now,
        },
        reminder: { active: true, reason: "remaining provider credit $0.20 is below the $1.0000 trigger", providerNodeId: "provider-node", costLeftUsd: 0.2 },
        readOnly: true,
        ...overrides,
      },
    },
  };
}

function mount({ actions = {}, view = state() } = {}) {
  const env = browser();
  const calls = [];
  const notices = [];
  const client = { action: async (name, input) => { calls.push({ name, input: structuredClone(input) }); if (!actions[name]) throw new Error(`unexpected action ${name}`); return actions[name](input); } };
  const mounted = mountPaymentP2p({ client, getState: () => view, notice: (...args) => notices.push(args), refreshState: async () => {} });
  mounted.render(view);
  return { ...env, calls, notices, mounted, root: env.nodes.get("payment-p2p-panel"), restore() { mounted.dispose(); env.restore(); } };
}

describe("P2P payment UI helpers", () => {
  test("exact decimal parsing and formatting never round", () => {
    expect(parseTokenAmount("1.5", 6)).toBe("1500000");
    expect(parseTokenAmount("0.000001", 6)).toBe("1");
    expect(parseTokenAmount("0.0000001", 6)).toBeNull();
    expect(parseTokenAmount("0", 6)).toBeNull();
    expect(parseTokenAmount("-1", 6)).toBeNull();
    expect(parseTokenAmount("1e6", 6)).toBeNull();
    expect(formatRawAmount("1500000", 6)).toBe("1.5");
    expect(formatRawAmount("1", 6)).toBe("0.000001");
  });

  test("status labels and actions require the provider waitingpayment acknowledgement", () => {
    expect(paymentStatusLabel("received")).toBe("已到账");
    expect(obligationActions({ signed: true, status: "waitingpayment", peerStatus: null })).toEqual(["resend-signature"]);
    expect(obligationActions({ signed: true, status: "waitingpayment", peerStatus: "waitingpayment" })).toEqual(["preview"]);
    expect(obligationActions({ signed: false, status: "actionneeded", peerStatus: null })).toEqual(["sign"]);
    expect(obligationActions({ signed: true, status: "waitingpayment", peerStatus: "confirming" })).toEqual([]);
  });

  test("unavailable service shows no form or send button", () => {
    const ui = mount({ view: state({ available: false }) });
    try {
      expect(ui.root.textContent).toContain("尚未启动");
      expect(find(ui.root, "button", "预览并付款")).toBeUndefined();
      expect(ui.calls).toEqual([]);
    } finally { ui.restore(); }
  });
});

describe("P2P payment UI actions", () => {
  test("a request sends the exact raw amount for the chosen asset/chain", async () => {
    const ui = mount({ actions: { "payment-p2p-request": () => ({ requestId: "r1", invoiceId: null, status: "actionneeded", code: "queued" }) } });
    try {
      const selects = all(ui.root, "select");
      selects[0].value = "provider-node";
      selects[1].value = "84532";
      await selects[1].emit("change");
      selects[2].value = ASSET;
      const amount = all(ui.root, "input").find((node) => node.placeholder === "例如 1.5");
      amount.value = "1.5";
      await find(ui.root, "button", "申请充值条件").click();
      await flush();
      expect(ui.calls).toEqual([{ name: "payment-p2p-request", input: { providerNodeId: "provider-node", chainId: 84532, assetId: ASSET, amountRaw: "1500000" } }]);
    } finally { ui.restore(); }
  });

  test("signing needs the explicit confirmation checkbox", async () => {
    const unsigned = state();
    const obligation = unsigned.status.paymentP2p.consumer.obligations[0];
    obligation.signed = false;
    obligation.status = "actionneeded";
    obligation.peerStatus = null;
    obligation.payerAddress = null;
    const ui = mount({ view: unsigned, actions: { "payment-p2p-sign": () => ({ status: "waitingpayment", code: "queued" }) } });
    try {
      await find(ui.root, "button", "核对并签名").click();
      await flush();
      expect(ui.calls).toEqual([]);
      const checks = all(ui.root, "input").filter((node) => node.type === "checkbox");
      const signCheck = checks.find((node) => node.parentElement?.textContent.includes("签署这次付款条件"));
      expect(signCheck).toBeDefined();
      signCheck.checked = true;
      await signCheck.emit("change");
      await find(ui.root, "button", "签署 1.5").click();
      await flush();
      expect(ui.calls[0].name).toBe("payment-p2p-sign");
      expect(ui.calls[0].input).toEqual({ invoiceId: "inv_22222222-2222-4222-8222-222222222222" });
    } finally { ui.restore(); }
  });

  test("preview then an explicit send confirmation carries the exact preview reference", async () => {
    let sent = null;
    const ui = mount({
      actions: {
        "payment-local-send-preview": () => ({
          schema: "ohmyaihub.wallet-send-preview/v1", invoiceId: "inv_22222222-2222-4222-8222-222222222222",
          previewRef: "0f3f8f0e-1111-4111-8111-111111111111", expiresAt: now, chainId: 84532, assetId: ASSET,
          tokenAddress: CONTRACT, recipientAddress: RECIPIENT, amountRaw: "1500000", amountTokens: "1.5", decimals: 6,
          payerAddress: PAYER, nonce: 4, gasLimit: "80000", maxFeePerGas: "3000000000", maxPriorityFeePerGas: "1000000000",
          maxGasCostWei: "240000000000000", nativeBalanceWei: "1000000000000000000", tokenBalanceRaw: "5000000",
          calldataHash: "e".repeat(64), digest: `0x${"f".repeat(64)}`, nativeSymbol: "ETH", note: "preview",
        }),
        "payment-local-send": (input) => { sent = input; return { state: "broadcast", hash: `0x${"1".repeat(64)}`, broadcast: true }; },
      },
    });
    try {
      await find(ui.root, "button", "预览并付款").click();
      await flush();
      expect(ui.calls[0].name).toBe("payment-local-send-preview");
      const confirm = all(ui.root, "input").find((node) => node.parentElement?.textContent.includes("只发送这一笔"));
      expect(confirm).toBeDefined();
      const send = find(ui.root, "button", "确认并从本机钱包付款");
      expect(send.disabled).toBe(true);
      confirm.checked = true;
      await confirm.emit("change");
      expect(send.disabled).toBe(false);
      await send.click();
      await flush();
      expect(sent).toEqual({ invoiceId: "inv_22222222-2222-4222-8222-222222222222", previewRef: "0f3f8f0e-1111-4111-8111-111111111111", confirm: true });
    } finally { ui.restore(); }
  });

  test("the reminder is labelled manual and no automatic signature button exists", () => {
    const ui = mount();
    try {
      expect(ui.root.textContent).toContain("FULL AUTO 未实现");
      expect(ui.root.textContent).toContain("余额不足提醒");
      expect(ui.root.textContent).toContain("系统不会自动签名");
      expect(find(ui.root, "button", "自动充值")).toBeUndefined();
      expect(find(ui.root, "button", "立即自动充值")).toBeUndefined();
    } finally { ui.restore(); }
  });
});
