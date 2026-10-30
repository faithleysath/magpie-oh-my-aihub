import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { capLabel, checkLabel, mountProviders, parseTransportDocument, peerAcceptance, priceText, selectableModels, validCap } from "./providers.js";

const pricing = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const model = { id: "native/demo", displayName: "本机模型", pricing, completePrice: true, allowedByPolicy: true };
const fingerprint = "a".repeat(64), quoteHash = "b".repeat(64);
const peer = { nodeId: "a".repeat(16), hostname: "伙伴甲", status: "unverified", online: true, identity: { fingerprint }, quoteHash, quote: { node: { displayName: "伙伴甲" }, models: [model], publication: { version: 1 }, identity: { fingerprint } } };
const baseState = () => ({ schema: "ohmyaihub/console/1", at: "2026-10-30T00:00:00Z", configured: true, status: { config: { sharingEnabled: true, consumingEnabled: true, catalog: {} }, catalog: { peers: [structuredClone(peer)], quote: { contentHash: quoteHash, identity: { fingerprint }, models: [model] } }, consumers: [], providers: [] }, workflows: { requests: [] }, shareCandidates: { models: [model] } });

// Minimal DOM records node properties and dispatches real module listeners.
// It deliberately has no HTML parser: untrusted content must remain text nodes.
class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.dataset = {}; this.value = ""; this._text = ""; this.disabled = false; this.checked = false; this.open = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((node) => node.textContent || "").join(""); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
  async emit(event) { for (const handler of this.handlers[event] || []) await handler({ preventDefault() {} }); }
  querySelectorAll(selector) {
    const matches = (node) => selector.split(",").some((part) => { const name = part.trim(); if (name === "input[type=password]") return node.tagName === "input" && node.type === "password"; return node.tagName === name; });
    return descendants(this).filter(matches);
  }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit("close"); }
  remove() {}
  reportValidity() { return true; }
  click() { return this.emit("click"); }
}
function descendants(root) { return root.children.flatMap((node) => [node, ...descendants(node)]); }
function find(root, tag, text) { return descendants(root).find((node) => node.tagName === tag && node.textContent === text); }
function all(root, tag) { return descendants(root).filter((node) => node.tagName === tag); }
function runtime(initial = baseState(), action = async () => ({})) {
  const previous = globalThis.document;
  const roots = Object.fromEntries(["discovery", "sharing", "connections"].map((name) => [name + "-panel", new Node("section")]));
  const body = new Node("body"); body.append(...Object.values(roots));
  globalThis.document = { body, createElement: (tag) => new Node(tag), getElementById: (id) => roots[id] };
  let state = initial;
  const calls = [], notices = [];
  let refreshes = 0;
  const mounted = mountProviders({ client: { action: async (name, input) => { calls.push({ name, input: structuredClone(input) }); return action(name, input); } }, getState: () => state, onState: (next) => { state = next; }, notice: (...args) => notices.push(args), setBusy: () => {}, refreshState: async () => { refreshes++; } });
  mounted.render(state);
  const dialog = body.children.find((node) => node.tagName === "dialog");
  return { roots, body, dialog, calls, notices, mounted, get refreshes() { return refreshes; }, render(next) { state = next; mounted.render(next); }, end() { mounted.clearSecrets(); state = null; }, cleanup() { mounted.dispose(); globalThis.document = previous; } };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("workflow input rules", () => {
  test("prices require complete native values; cap uses the actual Magpie grid", () => {
    expect(priceText(pricing)).toContain("输入 $1 / 输出 $2");
    expect(priceText({ input: 1, output: 2 })).toContain("不能授权");
    expect(selectableModels([model, { ...model, id: "remote/no-price", completePrice: false }], ["native/demo", "remote/no-price", "missing"])).toEqual(["native/demo"]);
    for (const value of [0, -1, 0.00001, 0.00015, Infinity, "", "word"]) expect(validCap(value)).toBeFalse();
    for (const value of [0.0001, 1, "1.2345"]) expect(validCap(value)).toBeTrue();
  });
  test("cap labels distinguish unlimited unsafe from unknown and positive limits", () => {
    for (const value of [0, -1]) expect(capLabel(value)).toBe("无限制 / 不安全配置");
    for (const value of [undefined, null, NaN, Infinity, "0"]) expect(capLabel(value)).toContain("未知");
    expect(capLabel(0.0001)).toBe("$0.0001");
    expect(capLabel(1)).toBe("$1.0000");
  });
  test("current changed fingerprint is selected exactly and check labels are Chinese", () => {
    expect(peerAcceptance({ ...peer, pendingFingerprint: "c".repeat(64) })).toEqual({ nodeId: peer.nodeId, fingerprint: "c".repeat(64), quoteHash });
    expect(checkLabel("gateway-key-required")).toBe("未授权访问拒绝");
    expect(checkLabel("provider:peer-demo:registered")).toBe("Magpie 远程服务注册");
    expect(checkLabel("new-unrecognized-check")).toBe("服务检查");
  });
  test("transport files are bounded objects with readable errors", () => {
    expect(parseTransportDocument('{"schema":"ohmyaihub.authorization/v1"}').schema).toBe("ohmyaihub.authorization/v1");
    for (const text of ["not json", "[]", "null", "中".repeat(30_000)]) expect(() => parseTransportDocument(text)).toThrow();
  });
});

describe("real mounted workflow handlers", () => {
  test("zero or missing limits show warnings, never green solely for connected, while zero balance remains money", async () => {
    for (const cap of [0, undefined, null]) {
      const state = baseState();
      state.status.consumers = [{ consumerId: "friend", models: [model.id], capUsd: cap, usedUsd: 0, leftUsd: 0 }];
      state.status.providers = [{ id: "remote", status: "connected", limit: { costLimit: cap, cost: 0, costLeft: 0 } }];
      const r = runtime(state);
      try {
        for (const name of ["sharing", "connections"]) {
          const root = r.roots[name + "-panel"];
          expect(root.textContent).toContain(capLabel(cap));
          expect(root.textContent).toContain("剩余 $0.0000");
          const status = all(root, "span").filter((node) => node.className?.includes("pill") && ["额度上限不安全", "额度上限待核验", "已授权", "已连接"].includes(node.textContent));
          expect(status).toHaveLength(1);
          expect(status[0].className).toContain("warn");
          expect(descendants(root).some((node) => node.className === "inline-warning")).toBeTrue();
        }
        await find(r.roots["connections-panel"], "button", "检查连接与额度").click(); await flush();
        expect(r.calls[0]).toEqual({ name: "provider-check", input: { id: "remote" } });
        await find(r.roots["sharing-panel"], "button", "检查授权").click(); await flush();
        expect(r.calls[1]).toEqual({ name: "consumer-check", input: { consumerId: "friend" } });
      } finally { r.cleanup(); }
    }
  });

  test("TOFU requires explicit checkbox and submits exact shown fingerprint without manual IDs", async () => {
    const r = runtime();
    try {
      await find(r.roots["discovery-panel"], "button", "核对并接受身份").click();
      expect(r.dialog.textContent).toContain(fingerprint);
      const submit = find(r.dialog, "button", "接受此身份");
      expect(submit.disabled).toBeTrue();
      await submit.click(); await flush(); expect(r.calls).toHaveLength(0);
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await submit.click(); await flush();
      expect(r.calls).toEqual([{ name: "trust-peer", input: { nodeId: peer.nodeId, fingerprint } }]);
      expect(r.dialog.open).toBeFalse();
    } finally { r.cleanup(); }
  });

  test("remote catalogue HTML remains literal text and controls stay safe", () => {
    const state = baseState(); state.status.catalog.peers[0].quote.node.displayName = '<img src=x onerror="steal()">';
    const r = runtime(state);
    try {
      expect(r.roots["discovery-panel"].textContent).toContain('<img src=x onerror="steal()">');
      expect(all(r.body, "img")).toHaveLength(0);
      expect(all(r.body, "script")).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test("model choices and active publication form survive passive state refresh", async () => {
    const r = runtime();
    try {
      const sharing = r.roots["sharing-panel"];
      const selected = all(sharing, "input").find((node) => node.type === "checkbox");
      expect(selected.checked).toBeTrue(); selected.checked = false; await selected.emit("change");
      const name = all(sharing, "input").find((node) => node.type === "text"); name.value = "正在填写的名称"; await name.emit("input");
      const next = baseState(); next.at = "2026-10-30T00:00:05Z"; next.status.config.catalog.displayName = "后端旧名称";
      r.render(next);
      expect(selected.checked).toBeFalse();
      expect(name.value).toBe("正在填写的名称");
      await find(sharing, "button", "保存模型范围").click(); await flush();
      expect(r.calls).toHaveLength(0);
      expect(r.notices.at(-1)[0]).toContain("至少选择一个");
    } finally { r.cleanup(); }
  });

  test("approval refuses zero cap and requires selected model plus human confirmation", async () => {
    const state = baseState();
    state.workflows.requests = [{ id: "request-id", status: "pending", eligible: true, reasons: [], document: { consumer: { nodeId: "consumer-id", hostname: "申请者" }, provider: { nodeId: "provider-id" }, models: [model.id], quote: { identityFingerprint: fingerprint, contentHash: quoteHash } }, currentQuote: { identityFingerprint: fingerprint, contentHash: quoteHash } }];
    const r = runtime(state);
    try {
      await find(r.roots["sharing-panel"], "button", "核对并审批").click();
      const cap = all(r.dialog, "input").find((node) => node.type === "number"); cap.value = "0";
      const checks = all(r.dialog, "input").filter((node) => node.type === "checkbox"); checks.at(-1).checked = true;
      await find(r.dialog, "button", "批准此申请").click(); await flush(); expect(r.calls).toHaveLength(0);
      cap.value = "0.2500";
      await find(r.dialog, "button", "批准此申请").click(); await flush();
      expect(r.calls).toEqual([{ name: "request-approve", input: { requestId: "request-id", capUsd: 0.25, models: [model.id] } }]);
    } finally { r.cleanup(); }
  });

  test("secret reveal is explicit, cleared on close, and session expiry discards late secret response", async () => {
    let finish;
    const state = baseState(); state.status.consumers = [{ consumerId: "friend", models: [model.id], capUsd: 1 }];
    const r = runtime(state, async () => new Promise((resolve) => { finish = resolve; }));
    try {
      await find(r.roots["sharing-panel"], "button", "交付访问授权").click();
      const reveal = find(r.dialog, "button", "显示本次授权文件");
      await reveal.click(); await flush(); expect(r.calls).toHaveLength(0);
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await reveal.click(); await flush(); expect(r.calls[0].name).toBe("key-reveal");
      r.end();
      finish({ schema: "ohmyaihub.authorization/v1", key: "fixture-private-authorization" });
      await flush();
      expect(r.body.textContent).not.toContain("fixture-private-authorization");
      expect(all(r.dialog, "textarea")).toHaveLength(0);
      expect(r.dialog.open).toBeFalse();
    } finally { r.cleanup(); }
  });

  test("paused authorization uses backend subset price preview and explicit consent for reissue", async () => {
    const state = baseState(); state.status.consumers = [{ consumerId: "friend", models: [model.id], paused: { reason: "price-changed" } }];
    const currentPriceVersion = "c".repeat(64);
    const r = runtime(state, async () => ({ consumer: state.status.consumers[0], currentPriceVersion, currentQuoteHash: quoteHash }));
    try {
      await find(r.roots["sharing-panel"], "button", "检查授权").click(); await flush();
      expect(r.dialog.textContent).toContain(currentPriceVersion);
      const submit = find(r.dialog, "button", "接受并重新签发");
      expect(submit.disabled).toBeTrue(); await submit.click(); await flush(); expect(r.calls).toHaveLength(1);
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await submit.click(); await flush();
      expect(r.calls[1]).toEqual({ name: "consumer-reissue", input: { consumerId: "friend", acceptPriceVersion: currentPriceVersion, acceptQuoteHash: quoteHash } });
    } finally { r.cleanup(); }
  });

  test("authorization file import previews before a second explicit confirmation creates the connection", async () => {
    const authorization = { schema: "ohmyaihub.authorization/v1", provider: { nodeId: peer.nodeId, hostname: peer.hostname }, consumer: { nodeId: "local-consumer" }, models: [model.id], quote: { identityFingerprint: fingerprint, contentHash: quoteHash }, key: "fixture-delivered-key", capUsd: 1 };
    const r = runtime(baseState(), async (name) => name === "connection-preview" ? { document: { ...authorization, key: undefined } } : {});
    try {
      await find(r.roots["connections-panel"], "button", "导入伙伴授权").click();
      all(r.dialog, "textarea")[0].value = JSON.stringify(authorization);
      const agreeImport = all(r.dialog, "input").find((node) => node.type === "checkbox"); agreeImport.checked = true;
      await find(r.dialog, "button", "验证并连接").click(); await flush();
      expect(r.calls).toHaveLength(1); expect(r.calls[0].name).toBe("connection-preview");
      expect(r.dialog.textContent).toContain(fingerprint);
      expect(all(r.dialog, "textarea")).toHaveLength(0);
      const connect = find(r.dialog, "button", "创建此伙伴连接"); expect(connect.disabled).toBeTrue();
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await connect.click(); await flush();
      expect(r.calls[1]).toEqual({ name: "connection-import", input: { document: authorization } });
      expect(r.dialog.open).toBeFalse();
    } finally { r.cleanup(); }
  });

  test("successful reveal clears textarea and all secret UI when user closes dialog", async () => {
    const state = baseState(); state.status.consumers = [{ consumerId: "friend", models: [model.id], capUsd: 1 }];
    const r = runtime(state, async () => ({ schema: "ohmyaihub.authorization/v1", key: "fixture-private-authorization" }));
    try {
      await find(r.roots["sharing-panel"], "button", "交付访问授权").click();
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await find(r.dialog, "button", "显示本次授权文件").click(); await flush();
      const key = all(r.dialog, "textarea")[0]; expect(key.value).toBe("fixture-private-authorization");
      await find(r.dialog, "button", "完成并隐藏").click();
      expect(key.value).toBe(""); expect(all(r.dialog, "textarea")).toHaveLength(0);
      expect(r.dialog.open).toBeFalse();
    } finally { r.cleanup(); }
  });
});

test("all shipped workflow DOM avoids HTML injection, remote resources and browser persistence", () => {
  const source = readFileSync(new URL("./providers.js", import.meta.url), "utf8");
  expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|document\.cookie|eval\(/);
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  expect(html).toContain("data-1p-ignore data-bwignore");
  expect(html).toContain("本应用不会回显已保存的密码");
});
