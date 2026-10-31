import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mountWallet, explicitNetwork, validTokenAmount, depositLabel, keyLabel } from "./wallet.js";

const contract = "0x" + "2".repeat(40), recipient = "0x" + "3".repeat(40);
const assetId = `eip155:97:${contract}`;
const stateFixture = () => ({ schema: "ohmyaihub/console/1", configured: true, status: { consumers: [{ consumerId: "friend", models: ["native/demo"], capUsd: 0.0001, ledger: { balanceUsd: 0, depositedUsd: 0, consumedUsd: 0, gaps: [] } }] }, wallet: {
  availability: "available", source: "local", viewAt: null, evidenceAt: null,
  registry: { networks: [{ chainId: 97, displayName: "BSC Testnet", enabled: true, finality: { mode: "confirmations", confirmations: 15 }, rpcConfigured: true, rpcCount: 1 }, { chainId: 84532, displayName: "Base Sepolia", enabled: true, finality: { mode: "finalized-tag" }, rpcConfigured: true, rpcCount: 1 }], assets: [{ chainId: 97, assetId, contractAddress: contract, symbol: "tMOCK6", decimals: 6, enabled: true, pricing: { nanosPerToken: "1000000000" } }, { chainId: 84532, assetId: "asset18", contractAddress: contract, symbol: "tMOCK18", decimals: 18, enabled: true }] }, receiving: [{ chainId: 97, address: recipient }], consumers: [{ consumerId: "friend", models: ["native/demo"] }], intents: [], intentOperations: [], anomalies: [], view: { chains: [], deposits: [], consumers: [], alerts: [] },
} });
const requestDocument = { schema: "ohmyaihub.deposit-request/v1", invoiceId: "invoice-fixture", consumerId: "friend", providerId: "provider", chainId: 97, asset: { assetId, contractAddress: contract, symbol: "tMOCK6", decimals: 6 }, amount: { tokens: "1.000001", raw: "1000001" }, recipientAddress: recipient, expiresAt: "2099-01-01T00:00:00Z", digest: "0x" + "d".repeat(64), typedData: { primaryType: "DepositIntent" } };
const previewFixture = () => ({ previewHash: "a".repeat(64), consumerId: "friend", providerId: "provider", chainId: 97, assetId, amountRaw: "1000001", amountTokens: "1.000001", recipientAddress: recipient, estimatedUsd: 1.000001, decimals: 6, symbol: "tMOCK6", ttlSec: 3600, pending: [], blockers: [] });
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.dataset = {}; this.value = ""; this._text = ""; this.disabled = false; this.checked = false; this.open = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((node) => node.textContent || "").join(""); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
  async emit(event) { for (const fn of this.handlers[event] || []) await fn({ preventDefault() {} }); }
  querySelectorAll(selector) { return descendants(this).filter((node) => selector.split(",").some((tag) => node.tagName === tag.trim())); }
  showModal() { this.open = true; }
  close() { this.open = false; queueMicrotask(() => { void this.emit("close"); }); }
  remove() {}
  click() { return this.emit("click"); }
}
function descendants(root) { return root.children.flatMap((node) => [node, ...descendants(node)]); }
const all = (root, tag) => descendants(root).filter((node) => node.tagName === tag);
const find = (root, tag, text) => descendants(root).find((node) => node.tagName === tag && node.textContent === text);
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function runtime(state = stateFixture(), action = async () => ({})) {
  const previous = globalThis.document;
  const roots = { "wallet-panel": new Node("section"), "accounting-panel": new Node("section"), "wallet-diagnostics": new Node("section") };
  const body = new Node("body"); body.append(...Object.values(roots));
  globalThis.document = { body, getElementById: (id) => roots[id], createElement: (tag) => new Node(tag) };
  const calls = [], notices = [];
  let current = state;
  let mounted;
  mounted = mountWallet({ client: { action: async (name, input) => { calls.push({ name, input: structuredClone(input) }); return action(name, input); } }, getState: () => current, onState: (next) => { current = next; mounted.render(next); }, setBusy: () => {}, notice: (...args) => notices.push(args), refreshState: async () => {} });
  mounted.render(state);
  const dialog = body.children.find((node) => node.tagName === "dialog");
  return { mounted, body, roots, dialog, calls, notices, render(next) { current = next; mounted.render(next); }, end() { current = null; mounted.clearSecrets(); }, cleanup() { mounted.dispose(); globalThis.document = previous; } };
}
async function fillCreation(r, amount = "1.000001") {
  await find(r.roots["wallet-panel"], "button", "创建测试网入账申请").click();
  const selects = all(r.dialog, "select"); selects[0].value = "friend"; selects[1].value = "97"; await selects[1].emit("change"); selects[2].value = assetId;
  all(r.dialog, "input").find((node) => node.inputMode === "decimal").value = amount;
}

describe("wallet presentation semantics", () => {
  test("requires explicit registered network and exact positive decimal precision", () => {
    for (const input of ["", "56", "8453", "garbage", undefined]) expect(explicitNetwork(input)).toBeNull();
    expect(explicitNetwork("97")).toBe(97); expect(explicitNetwork("84532")).toBe(84532);
    for (const amount of ["0", "0.000000", "-1", "1e3", "1.0000001", "01", "1."]) expect(validTokenAmount(amount, 6)).toBeFalse();
    expect(validTokenAmount("1.000001", 6)).toBeTrue();
    expect(validTokenAmount("0.000000000000000001", 18)).toBeTrue();
    expect(depositLabel("unproven")).toContain("尚未证实");
    expect(keyLabel("usable-but-export-withdrawn")).toContain("已撤回");
  });
  test("both networks use equal controls, passive render never probes and unknown accounting is not zero", async () => {
    const r = runtime();
    try {
      const wallet = r.roots["wallet-panel"];
      expect(wallet.textContent).toContain("BSC Testnet"); expect(wallet.textContent).toContain("Base Sepolia");
      const diagnostics = r.roots["wallet-diagnostics"];
      expect(all(wallet, "button").filter((node) => node.textContent === "编辑 RPC")).toHaveLength(0);
      expect(all(diagnostics, "button").filter((node) => node.textContent === "编辑 RPC")).toHaveLength(2);
      expect(all(diagnostics, "button").filter((node) => node.textContent === "扫描此网络")).toHaveLength(2);
      expect(r.calls).toHaveLength(0);
      const select = all(r.roots["accounting-panel"], "select")[0]; expect(select.value).toBe(""); select.value = "friend"; await select.emit("change");
      const root = r.roots["accounting-panel"];
      expect(root.textContent).toContain("账目尚未主动核验");
      expect(root.textContent).toContain("最近核验额度上限未知");
      expect(root.textContent).toContain("账本余额$0.0000");
      expect(root.textContent).toContain("已结算消耗未知");
    } finally { r.cleanup(); }
  });
});

test("verified timeline step without timestamp stays verified and missing evidence elsewhere stays unknown", async () => {
  const state = stateFixture();
  state.wallet.intents = [{ invoiceId: "signed-invoice", consumerId: "friend", chainId: 97, status: "signed" }];
  state.wallet.view.deposits = [{ invoiceId: "signed-invoice", state: "payment-not-seen", steps: [{ id: "signature", state: "done", at: null, detail: "signature verified" }, { id: "payment", state: "pending", at: null }] }];
  const r = runtime(state);
  try {
    const root = r.roots["wallet-panel"];
    const signature = all(root, "li").find((node) => node.className === "timeline-done");
    expect(signature.textContent).toContain("付款方签名已验证未记录核验时间");
    expect(signature.textContent).not.toContain("尚未验证");
    expect(r.roots["wallet-diagnostics"].textContent).toContain("最近主动核验：尚未验证");
    await all(r.roots["wallet-diagnostics"], "button").find((node) => node.textContent === "注册测试代币").click();
    expect(r.dialog.textContent).toContain("1 USD = 1,000,000,000 nanoUSD");
    expect(r.calls).toHaveLength(0);
  } finally { r.cleanup(); }
});

describe("individual consumption history", () => {
  test("real selected-consumer button opens immutable rows and pages opaque cursors without background mutation", async () => {
    const entry = { id: "row-1", kind: "call", model: "native/demo", amountNanos: 1234, amountUsd: .000001234,
      recordedAt: "2026-10-30T01:00:00.000Z", priceVersion: "frozen-price", windowId: "original-window", priceVerified: true,
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 50 } };
    const r = runtime(stateFixture(), async (name, input) => ({ rows: [{ ...entry, model: input.cursor ? "native/older" : "native/demo" }], nextCursor: input.cursor ? null : "opaque-page-two" }));
    try {
      const select = all(r.roots["accounting-panel"], "select")[0];
      expect(find(r.roots["accounting-panel"], "button", "查看消费记录")).toBeUndefined();
      select.value = "friend"; await select.emit("change");
      await find(r.roots["accounting-panel"], "button", "查看消费记录").click(); await flush();
      expect(r.calls[0]).toEqual({ name: "accounting-history", input: { consumerId: "friend" } });
      expect(r.dialog.open).toBeTrue();expect(r.dialog.textContent).toContain("native/demo");expect(r.dialog.textContent).toContain("0.000001234");
      expect(r.dialog.textContent).toContain("frozen-price");expect(r.dialog.textContent).toContain("original-window");
      expect(find(r.dialog,"button","上一页").disabled).toBeTrue();
      await find(r.dialog,"button","下一页").click();await flush();
      expect(r.calls[1]).toEqual({name:"accounting-history",input:{consumerId:"friend",cursor:"opaque-page-two"}});
      expect(r.dialog.textContent).toContain("native/older");expect(find(r.dialog,"button","下一页").disabled).toBeTrue();
      await find(r.dialog,"button","上一页").click();await flush();
      expect(r.calls[2]).toEqual({name:"accounting-history",input:{consumerId:"friend"}});
      select.value="";await select.emit("change");expect(r.dialog.open).toBeFalse();expect(r.dialog.textContent).not.toContain("native/demo");
      r.end();expect(r.dialog.textContent).not.toContain("original-window");
    } finally {r.cleanup();}
  });
});

describe("real mounted wallet handlers", () => {
  test("create has no automatic chain/consumer/asset and rejects excess precision before any action", async () => {
    const r = runtime();
    try {
      await find(r.roots["wallet-panel"], "button", "创建测试网入账申请").click();
      for (const select of all(r.dialog, "select")) expect(select.value).toBe("");
      await find(r.dialog, "button", "预览精确申请内容").click(); await flush(); expect(r.calls).toHaveLength(0);
      const selects = all(r.dialog, "select"); selects[0].value = "friend"; selects[1].value = "97"; await selects[1].emit("change"); selects[2].value = assetId;
      all(r.dialog, "input").find((node) => node.inputMode === "decimal").value = "0.0000001";
      await find(r.dialog, "button", "预览精确申请内容").click(); await flush(); expect(r.calls).toHaveLength(0);
    } finally { r.cleanup(); }
  });
  test("preview binds exact amount and explicit confirmation creates once, with no presign transfer instruction", async () => {
    const r = runtime(stateFixture(), async (name) => name === "wallet-intent-preview" ? { preview: previewFixture() } : { document: requestDocument, transfer: null });
    try {
      await fillCreation(r);
      await find(r.dialog, "button", "预览精确申请内容").click(); await flush();
      expect(r.calls[0]).toEqual({ name: "wallet-intent-preview", input: { consumerId: "friend", chainId: 97, assetId, amount: "1.000001", ttlSec: 3600 } });
      expect(r.dialog.open).toBeTrue(); expect(r.dialog.textContent).toContain("1000001"); expect(r.dialog.textContent).toContain(recipient);
      const submit = find(r.dialog, "button", "确认创建一次申请"); expect(submit.disabled).toBeTrue();
      await submit.click(); await flush(); expect(r.calls).toHaveLength(1);
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await Promise.all([submit.click(), submit.click()]); await flush();
      expect(r.calls.filter((call) => call.name === "wallet-intent-create")).toHaveLength(1);
      expect(r.calls[1].input.amount).toBe("1.000001"); expect(r.calls[1].input.requestId).toMatch(/^[a-f0-9-]{36}$/); expect(r.calls[1].input.previewHash).toBe("a".repeat(64));
      expect(r.dialog.open).toBeTrue(); expect(find(r.dialog, "button", "下载入账申请文件")).toBeDefined();
      expect(find(r.dialog, "button", "下载准确转账指引")).toBeUndefined();
    } finally { r.cleanup(); }
  });
  test("unknown create outcome never retries or silently replaces its request UUID", async () => {
    const r = runtime(stateFixture(), async (name) => { if (name === "wallet-intent-preview") return { preview: previewFixture() }; throw Object.assign(new Error("offline"), { status: 0 }); });
    try {
      await fillCreation(r); await find(r.dialog, "button", "预览精确申请内容").click(); await flush();
      const submit = find(r.dialog, "button", "确认创建一次申请"); const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await submit.click(); await flush(); await submit.click(); await flush();
      expect(r.calls.filter((call) => call.name === "wallet-intent-create")).toHaveLength(1);
      expect(r.dialog.textContent).toContain("结果暂时未知");
      await find(r.dialog, "button", "关闭").click();
      await find(r.roots["wallet-panel"], "button", "创建测试网入账申请").click(); await flush();
      expect(r.dialog.open).toBeFalse(); expect(r.notices.at(-1)[0]).toContain("上次创建结果尚未确认");
    } finally { r.cleanup(); }
  });
  test("signature file binds selected invoice and transfer instructions appear only after server verification", async () => {
    const state = stateFixture(); state.wallet.intents = [{ invoiceId: requestDocument.invoiceId, consumerId: "friend", chainId: 97, status: "requested", expectedAmountRaw: "1000001" }];
    const signature = { schema: "ohmyaihub.deposit-signature/v1", invoiceId: requestDocument.invoiceId, signature: "0x" + "1".repeat(130), payerAddress: "0x" + "4".repeat(40) };
    const transfer = { chainId: 97, contractAddress: contract, amountTokens: "1.000001", amountRaw: "1000001", recipientAddress: recipient, payerAddress: signature.payerAddress, invoiceId: requestDocument.invoiceId };
    const r = runtime(state, async () => ({ transfer }));
    try {
      await find(r.roots["wallet-panel"], "button", "导入付款方签名").click();
      const file = all(r.dialog, "input").find((node) => node.type === "file"); file.files = [{ size: 500, text: async () => JSON.stringify(signature) }];
      await find(r.dialog, "button", "核验签名并读取转账指引").click(); await flush(); expect(r.calls).toHaveLength(0);
      all(r.dialog, "input").find((node) => node.type === "checkbox").checked = true;
      await find(r.dialog, "button", "核验签名并读取转账指引").click(); await flush();
      expect(r.calls[0]).toEqual({ name: "wallet-signature-import", input: { consumerId: "friend", invoiceId: requestDocument.invoiceId, document: signature } });
      expect(r.dialog.open).toBeTrue(); expect(r.dialog.textContent).toContain(signature.payerAddress); expect(r.dialog.textContent).toContain(recipient);
      expect(find(r.dialog, "button", "下载准确转账指引")).toBeDefined();
      expect(file.value).toBe("");
    } finally { r.cleanup(); }
  });
  test("pending requests block another create, and paused preview requires explicit acknowledgement", async () => {
    for (const pending of [[], [{ invoiceId: "old-open-request" }]]) {
      const preview = { ...previewFixture(), paused: { reason: "price-changed" }, pending, blockers: pending.length ? ["已有未完成申请"] : [] };
      const r = runtime(stateFixture(), async (name) => name === "wallet-intent-preview" ? { preview } : { document: requestDocument });
      try {
        await fillCreation(r); await find(r.dialog, "button", "预览精确申请内容").click(); await flush();
        expect(r.dialog.textContent).toContain("收到入账也不会自动解除");
        const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
        const submit = find(r.dialog, "button", "确认创建一次申请"); expect(submit.disabled).toBe(pending.length > 0);
        if (!pending.length) { await submit.click(); await flush(); expect(r.calls[1].input.ackPaused).toBeTrue(); }
        else expect(r.calls).toHaveLength(1);
      } finally { r.cleanup(); }
    }
  });
  test("invalid signature is refused without transfer guidance and signed resume reads existing instructions", async () => {
    const state = stateFixture(); state.wallet.intents = [{ invoiceId: requestDocument.invoiceId, consumerId: "friend", chainId: 97, status: "requested" }];
    const signature = { invoiceId: "wrong-invoice", signature: "0x" + "1".repeat(130), payerAddress: "0x" + "4".repeat(40) };
    const r = runtime(state, async () => { throw Object.assign(new Error("签名与此申请不匹配"), { status: 400 }); });
    try {
      await find(r.roots["wallet-panel"], "button", "导入付款方签名").click();
      all(r.dialog, "input").find((node) => node.type === "file").files = [{ size: 500, text: async () => JSON.stringify(signature) }];
      all(r.dialog, "input").find((node) => node.type === "checkbox").checked = true;
      await find(r.dialog, "button", "核验签名并读取转账指引").click(); await flush();
      expect(r.dialog.textContent).toContain("签名与此申请不匹配");
      expect(find(r.dialog, "button", "下载准确转账指引")).toBeUndefined();
    } finally { r.cleanup(); }
    state.wallet.intents[0].status = "signed";
    const resumed = runtime(state, async () => ({ document: requestDocument, transfer: { invoiceId: requestDocument.invoiceId, chainId: 97, recipientAddress: recipient, payerAddress: signature.payerAddress } }));
    try {
      expect(find(resumed.roots["wallet-panel"], "button", "导入付款方签名")).toBeUndefined();
      await find(resumed.roots["wallet-panel"], "button", "恢复申请与转账指引").click(); await flush();
      expect(resumed.calls[0].name).toBe("wallet-intent-document");
      expect(resumed.dialog.open).toBeTrue();
      expect(find(resumed.dialog, "button", "下载准确转账指引")).toBeDefined();
    } finally { resumed.cleanup(); }
  });
  test("consumer imported request is server-verified before reviewed signing document is available", async () => {
    const r = runtime(stateFixture(), async () => ({ document: requestDocument, verified: true, canTransfer: false }));
    try {
      await find(r.roots["wallet-panel"], "button", "导入并核对入账申请").click();
      all(r.dialog, "input")[0].files = [{ size: 800, text: async () => JSON.stringify(requestDocument) }];
      await find(r.dialog, "button", "验证文件并预览").click(); await flush();
      expect(r.calls).toEqual([{ name: "deposit-document-preview", input: { document: requestDocument } }]);
      expect(r.dialog.open).toBeTrue(); expect(r.dialog.textContent).toContain("EIP-712");
      expect(find(r.dialog, "button", "下载外部钱包签名数据")).toBeDefined();
      expect(find(r.dialog, "button", "下载准确转账指引")).toBeUndefined();
    } finally { r.cleanup(); }
  });
  test("consumer packages a bare external-wallet signature into a verified file without private-key input or manual JSON", async () => {
    const signature = "0x" + "1".repeat(130), payerAddress = "0x" + "4".repeat(40);
    const r = runtime(stateFixture(), async (name) => name === "deposit-document-preview" ? { document: requestDocument, verified: true, canTransfer: false } : { document: { schema: "ohmyaihub.deposit-signature/v1", invoiceId: requestDocument.invoiceId, payerAddress, signature }, verified: true });
    try {
      await find(r.roots["wallet-panel"], "button", "导入并核对入账申请").click();
      all(r.dialog, "input")[0].files = [{ size: 800, text: async () => JSON.stringify(requestDocument) }];
      await find(r.dialog, "button", "验证文件并预览").click(); await flush();
      await find(r.dialog, "button", "把钱包签名整理为交付文件").click();
      const inputs = all(r.dialog, "input"); inputs[0].value = payerAddress; inputs[1].value = signature;
      await find(r.dialog, "button", "核验并生成签名交付文件").click(); await flush(); expect(r.calls).toHaveLength(1);
      inputs[2].checked = true;
      await find(r.dialog, "button", "核验并生成签名交付文件").click(); await flush();
      expect(r.calls[1]).toEqual({ name: "deposit-signature-document", input: { document: requestDocument, payerAddress, signature } });
      expect(r.dialog.open).toBeTrue(); expect(find(r.dialog, "button", "下载签名交付文件")).toBeDefined();
      expect(r.dialog.textContent).toContain("不是付款回执");
      expect(inputs[1].value).toBe(""); expect(all(r.dialog, "input")).toHaveLength(0);
      r.end(); expect(r.dialog.open).toBeFalse(); expect(r.dialog.textContent).not.toContain(payerAddress);
    } finally { r.cleanup(); }
  });
  test("injected wallet requests accounts only after consent, refuses wrong chain, preserves exact typed data and handles rejection", async () => {
    const oldWindow = globalThis.window;
    const payerAddress = "0x" + "4".repeat(40), signature = "0x" + "1".repeat(130);
    for (const mode of ["wrong-chain", "reject", "success"]) {
      const walletCalls = [];
      globalThis.window = { ethereum: { request: async (call) => {
        walletCalls.push(structuredClone(call));
        if (call.method === "eth_requestAccounts") return [payerAddress];
        if (call.method === "eth_chainId") return mode === "wrong-chain" ? "0x14a34" : "0x61";
        if (mode === "reject") throw Object.assign(new Error("user rejected"), { code: 4001 });
        return signature;
      } } };
      const verifiedDoc = structuredClone(requestDocument);
      verifiedDoc.typedData = { types: { DepositIntent: [{ name: "invoiceId", type: "string" }] }, primaryType: "DepositIntent", domain: { chainId: 97 }, message: { invoiceId: requestDocument.invoiceId } };
      const r = runtime(stateFixture(), async (name) => name === "deposit-document-preview" ? { document: verifiedDoc, verified: true, canTransfer: false } : { document: { schema: "ohmyaihub.deposit-signature/v1", invoiceId: verifiedDoc.invoiceId, payerAddress, signature }, verified: true });
      try {
        await find(r.roots["wallet-panel"], "button", "导入并核对入账申请").click();
        all(r.dialog, "input")[0].files = [{ size: 800, text: async () => JSON.stringify(verifiedDoc) }];
        await find(r.dialog, "button", "验证文件并预览").click(); await flush();
        expect(walletCalls).toHaveLength(0);
        await find(r.dialog, "button", "使用浏览器钱包签名").click();
        expect(walletCalls).toHaveLength(0);
        const sign = find(r.dialog, "button", "连接钱包并请求签名"); await sign.click(); await flush(); expect(walletCalls).toHaveLength(0);
        const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
        await sign.click(); await flush();
        if (mode === "wrong-chain") {
          expect(walletCalls.map((call) => call.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
          expect(r.dialog.textContent).toContain("请手动在钱包中切换"); expect(r.calls).toHaveLength(1);
        } else {
          expect(walletCalls[2]).toEqual({ method: "eth_signTypedData_v4", params: [payerAddress, JSON.stringify(verifiedDoc.typedData)] });
          if (mode === "reject") { expect(r.calls).toHaveLength(1); expect(r.dialog.textContent).toContain("你已取消"); }
          else {
            expect(r.calls[1]).toEqual({ name: "deposit-signature-document", input: { document: verifiedDoc, signature, payerAddress } });
            expect(r.calls[1].input.document.digest).toBe(verifiedDoc.digest);
            expect(find(r.dialog, "button", "下载签名交付文件")).toBeDefined();
          }
        }
        expect(walletCalls.some((call) => ["wallet_switchEthereumChain", "eth_sendTransaction"].includes(call.method))).toBeFalse();
      } finally { r.cleanup(); }
    }
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  });
  test("RPC replacement is explicit, write-only and input clears on close or session expiry", async () => {
    const r = runtime();
    try {
      await all(r.roots["wallet-diagnostics"], "button").find((node) => node.textContent === "编辑 RPC").click();
      const endpoints = all(r.dialog, "textarea")[0]; expect(endpoints.value).toBe(""); endpoints.value = "http://127.0.0.1:4567/private-fixture";
      await find(r.dialog, "button", "保存 RPC 配置").click(); await flush(); expect(r.calls).toHaveLength(0);
      all(r.dialog, "input")[0].checked = true; await find(r.dialog, "button", "保存 RPC 配置").click(); await flush();
      expect(r.calls[0]).toEqual({ name: "wallet-network", input: { chainId: 97, rpcEndpoints: ["http://127.0.0.1:4567/private-fixture"] } });
      expect(endpoints.value).toBe(""); expect(r.body.textContent).not.toContain("private-fixture");
      r.end(); expect(r.dialog.open).toBeFalse();
    } finally { r.cleanup(); }
  });
  test("credited chain data cannot green unknown accounting or unsafe cap and ledger balances stay distinct", async () => {
    for (const cap of [0, undefined, 1]) {
      const state = stateFixture();
      state.wallet.view.consumers = [{ consumerId: "friend", state: "usable", capUsd: cap, usedUsd: 0, leftUsd: 0, readback: { at: "2026-10-30T00:00:00Z", fromGateway: true }, accounting: { state: "unknown", serving: true }, balanceUsd: 0 }];
      state.wallet.view.deposits = [{ consumerId: "friend", chainId: 97, state: "credited", creditedUsd: 1 }];
      const r = runtime(state);
      try {
        const select = all(r.roots["accounting-panel"], "select")[0]; select.value = "friend"; await select.emit("change");
        const root = r.roots["accounting-panel"];
        expect(all(root, "span").filter((node) => node.className?.includes("pill good"))).toHaveLength(0);
        expect(root.textContent).toContain("计费状态unknown");
        expect(root.textContent).toContain("账本余额$0.0000");
        if (cap === 0) expect(root.textContent).toContain("无限制 / 不安全配置");
        if (cap === undefined) expect(root.textContent).toContain("未知（尚未验证额度上限）");
      } finally { r.cleanup(); }
    }
  });
  test("usage gap resolution requires audit identity, explanation and explicit acceptance", async () => {
    const state = stateFixture(); state.status.consumers[0].ledger.gaps = [{ logId: "gap-fixture", reason: "log-shrank", resolvedAt: null }];
    const r = runtime(state);
    try {
      const select = all(r.roots["accounting-panel"], "select")[0]; select.value = "friend"; await select.emit("change");
      await find(r.roots["accounting-panel"], "button", "审计并接受当前基线").click();
      await find(r.dialog, "button", "记录审计并接受基线").click(); await flush(); expect(r.calls).toHaveLength(0);
      const inputs = all(r.dialog, "input"); inputs[0].value = "操作者"; inputs[1].value = "已核对本地日志缺失范围，接受当前记录位置"; inputs[2].checked = true;
      await find(r.dialog, "button", "记录审计并接受基线").click(); await flush();
      expect(r.calls[0]).toEqual({ name: "usage-gap-resolve", input: { consumerId: "friend", logId: "gap-fixture", resolvedBy: "操作者", note: "已核对本地日志缺失范围，接受当前记录位置" } });
    } finally { r.cleanup(); }
  });
});

test("wallet shipped source has no key custody, persistence, unsafe HTML or CLI flow and exactly two fixed guides", () => {
  const source = readFileSync(new URL("./wallet.js", import.meta.url), "utf8");
  expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|document\.cookie|eth_sendRawTransaction|walletconnect|retryCommand|test-credit/);
  expect(source).not.toMatch(/type\s*=\s*["']password/);
  const links = [...source.matchAll(/https:\/\/[^"\s]+/g)].map((match) => match[0]);
  expect(links).toEqual(["https://www.bnbchain.org/en/blog/moving-from-a-centralized-exchange-to-bnb-chain", "https://docs.peer.xyz/guides/zh/alipay-buy"]);
});

test("wallet page is a flat read-only overview; chain tools live in network diagnostics", () => {
  const source = readFileSync(new URL("./wallet.js", import.meta.url), "utf8");
  expect(source).toContain('document.getElementById("wallet-diagnostics")');
  expect(source).toContain("RPC、观察器、扫描、测试代币、对账与审计都在这里");
  expect(source).toContain("这是既有会计路径，不是 Phase 10 的无文件目标。");
  // The overview is a flat fact list, never a card inside a card.
  expect(source).toContain('fact("资产余额"');
  expect(source).toContain('"尚未查询"');
  expect(source).not.toContain('"wallet-network-card"');
  expect(source).not.toContain('"wallet-network-row"');
  // A balance is never rendered unless it was actually read.
  expect(source).toContain('fact("资产余额", available ? "尚未查询" : "尚未读取")');
  expect(source).toContain('fact("最近入账（累计，非余额）"');
  // Offline statement import belongs to the recovery disclosure, not the everyday path.
  const guide = source.slice(source.indexOf("使用方 · 用自己的外部钱包付款"), source.indexOf("钱包与链诊断"));
  expect(guide).not.toContain('button("导入共享方账单"');
  expect(source).toContain('button("导入共享方账单"');
});

test("wallet first screen stays functional, not a monitoring panel", () => {
  const r = runtime();
  try {
    const wallet = r.roots["wallet-panel"];
    // The page heading owns the single environment note; no disclaimer wall here.
    expect(wallet.textContent).not.toContain("测试网环境");
    expect(wallet.textContent).not.toContain("钱包配置已读取");
    expect(wallet.textContent).not.toContain("最近主动核验");
    expect(wallet.textContent).not.toContain("本地视图");
    // No current balance is claimed, and chain ids stay in diagnostics.
    expect(wallet.textContent).toContain("资产余额");
    expect(wallet.textContent).toContain("尚未查询");
    expect(wallet.textContent).not.toContain("chainId 97");
    expect(wallet.textContent).not.toContain("观察运行中");
    expect(r.roots["wallet-diagnostics"].textContent).toContain("最近主动核验");
  } finally { r.cleanup(); }
});
