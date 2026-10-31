import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { capLabel, checkLabel, modelEvidenceSummary, mountProviders, parseTransportDocument, peerAcceptance, peerNextStep, priceText, selectableModels, validCap } from "./providers.js";

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
  close() { this.open = false; queueMicrotask(() => { void this.emit("close"); }); }
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

  test("own published identity exposes full fingerprints and current price version for comparison and public copy", async () => {
    const state = baseState();
    const priceVersion = "c".repeat(64);
    state.status.catalog.quote.billing = { priceVersion, priceLocked: false };
    state.status.catalog.quote.updatedAt = "2026-10-30T10:00:00Z";
    state.status.catalog.quote.publishedAt = "2026-10-30T10:01:00Z";
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => copied.push(text) } });
    const r = runtime(state);
    try {
      const root = r.roots["sharing-panel"];
      const own = find(root, "summary", "查看完整目录身份与报价");
      expect(own).toBeDefined();
      const identity = descendants(root).find((node) => node.tagName === "details" && node.children.includes(own));
      expect(identity.open).toBeFalse();
      for (const value of [fingerprint, quoteHash, priceVersion, "2026-10-30T10:00:00Z", "2026-10-30T10:01:00Z", "自签名", "priceLocked: false"]) expect(identity.textContent).toContain(value);
      await find(root, "button", "复制完整身份指纹").click();
      expect(copied).toEqual([fingerprint]);
      expect(r.calls).toHaveLength(0);
      const next = structuredClone(state); next.status.catalog.quote.contentHash = "d".repeat(64);
      r.render(next); expect(root.textContent).toContain("d".repeat(64));
    } finally {
      r.cleanup();
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else delete navigator.clipboard;
    }
  });

  test("the share action follows selection, filtering and busy state", async () => {
    const state = baseState();
    state.shareCandidates = { models: [model, { ...model, id: "native/second", displayName: "第二个模型" }] };
    const r = runtime(state);
    try {
      const sharing = r.roots["sharing-panel"];
      const save = find(sharing, "button", "分享这些模型");
      const boxes = () => all(sharing, "input").filter((node) => node.type === "checkbox");
      expect(save.disabled).toBeFalse();
      for (const box of boxes()) { box.checked = false; await box.emit("change"); }
      expect(save.disabled).toBeTrue();
      boxes()[0].checked = true; await boxes()[0].emit("change");
      expect(save.disabled).toBeFalse();
      boxes()[1].checked = true; await boxes()[1].emit("change");
      expect(save.disabled).toBeFalse();

      const search = all(sharing, "input").find((node) => node.type === "search");
      search.value = "second"; await search.emit("input");
      expect(save.disabled).toBeFalse();
      expect(boxes().filter((box) => box.checked)).toHaveLength(1);
      search.value = ""; await search.emit("input");
      expect(boxes().filter((box) => box.checked)).toHaveLength(2);
      expect(save.disabled).toBeFalse();
    } finally { r.cleanup(); }
  });

  test("a running share action blocks a second confirmation", async () => {
    const state = baseState();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const r = runtime(state, () => pending);
    try {
      const sharing = r.roots["sharing-panel"];
      void find(sharing, "button", "重新检测").click();
      for (let i = 0; i < 8; i++) await Promise.resolve();
      find(sharing, "button", "分享这些模型").click();
      await flush();
      expect(r.dialog.open).toBeFalse();
      release({});
      await flush();
      expect(r.calls.map((call) => call.name)).toEqual(["share-candidates"]);
    } finally { r.cleanup(); }
  });

  test("the stop action is hidden unless the node is sharing", async () => {
    const state = baseState();
    state.status.config.sharingEnabled = false;
    const r = runtime(state);
    try {
      expect(find(r.roots["sharing-panel"], "button", "停止共享").hidden).toBeTrue();
      const sharingState = baseState();
      r.render(sharingState);
      expect(find(r.roots["sharing-panel"], "button", "停止共享").hidden).toBeFalse();
    } finally { r.cleanup(); }
  });

  test("several peers never put more than one primary action on the catalogue screen", async () => {
    const state = baseState();
    state.status.catalog.peers = [structuredClone(peer), { ...structuredClone(peer), nodeId: "b".repeat(16), hostname: "伙伴乙", quote: { ...structuredClone(peer.quote), node: { displayName: "伙伴乙" } } }];
    const r = runtime(state);
    try {
      const primaries = all(r.roots["discovery-panel"], "button").filter((node) => String(node.className).split(" ").includes("primary"));
      expect(primaries).toHaveLength(0);
      // The single primary lives inside the request dialog.
      await find(r.roots["discovery-panel"], "button", "选择模型并申请").click(); await flush();
      const dialogPrimaries = all(r.dialog, "button").filter((node) => String(node.className).split(" ").includes("primary"));
      expect(dialogPrimaries).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test("catalogue next steps are Chinese and raw CLI diagnostics remain in collapsed technical details", () => {
    expect(peerNextStep("unverified")).toContain("核对并接受身份");
    expect(peerNextStep("identity-changed")).toContain("核对新身份");
    const state = baseState();
    state.status.catalog.peers[0].detail = "first seen; use catalog trust before connecting";
    const r = runtime(state);
    try {
      const root = r.roots["discovery-panel"];
      const technical = descendants(root).find((node) => node.tagName === "details" && node.textContent.includes(state.status.catalog.peers[0].detail));
      expect(technical).toBeDefined(); expect(technical.open).toBeFalse();
      expect(technical.children[0].textContent).toBe("查看目录技术详情");
      expect(all(root, "p").some((node) => node.textContent.includes("catalog trust"))).toBeFalse();
      expect(all(root, "p").some((node) => node.textContent.includes("核对并接受身份"))).toBeTrue();
    } finally { r.cleanup(); }
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

  test("actual model details show one-hour cache, every tier price, unit and source without injecting model HTML", () => {
    const state = baseState();
    const tiered = { ...model, displayName: '<img src=x onerror="steal()">', pricing: { ...pricing, unit: "USD per 1M tokens", source: "magpie-settings", cacheWrite1h: 1.5, tiers: [{ above: 128000, input: 3, output: 4, cacheRead: 0.3, cacheWrite: 3.5, cacheWrite1h: 5.25 }, { above: 256000, input: 6, output: 8, cacheRead: 0, cacheWrite: 7, cacheWrite1h: null }] } };
    state.status.catalog.peers[0].quote.models = [tiered]; state.shareCandidates.models = [tiered];
    const r = runtime(state);
    try {
      expect(priceText(tiered.pricing)).toContain("有阶梯价格，查看详情");
      for (const name of ["discovery", "sharing"]) {
        const root = r.roots[name + "-panel"];
        const prices = all(root, "details").find((node) => node.children[0]?.textContent === "价格与能力详情");
        const cells = Object.fromEntries(prices.children.slice(1).map((row) => [row.children[0].textContent, row.children[1].textContent]));
        expect(cells["一小时缓存写入"]).toBe("$1.5 / 百万 token");
        expect(cells["价格单位"]).toBe("USD per 1M tokens"); expect(cells["价格来源"]).toContain("Magpie 模型设置");
        expect(cells["阶梯 1 · 门槛"]).toBe("超过 128000 token");
        for (const [field, value] of [["输入", 3], ["输出", 4], ["缓存读取", 0.3], ["缓存写入", 3.5], ["一小时缓存写入", 5.25]]) expect(cells[`阶梯 1 · ${field}`]).toBe(`$${value} / 百万 token`);
        expect(cells["阶梯 2 · 门槛"]).toBe("超过 256000 token");
        expect(cells["阶梯 2 · 缓存读取"]).toBe("$0 / 百万 token");
        expect(cells["阶梯 2 · 一小时缓存写入"]).toBe("未提供");
        expect(cells["价格锁定"]).toContain("priceLocked: false");
        expect(root.textContent).toContain(tiered.displayName); expect(all(root, "img")).toHaveLength(0);
      }
    } finally { r.cleanup(); }
  });

  test("null and omitted optional cache price stay missing rather than zero", () => {
    const state = baseState();
    state.status.catalog.peers[0].quote.models = [{ ...model, pricing: { ...pricing, cacheWrite1h: null, tiers: [{ above: 0, input: 1, output: 2, cacheRead: null, cacheWrite: undefined }] } }];
    const r = runtime(state);
    try {
      const prices = all(r.roots["discovery-panel"], "details").find((node) => node.children[0]?.textContent === "价格与能力详情");
      const cells = Object.fromEntries(prices.children.slice(1).map((row) => [row.children[0].textContent, row.children[1].textContent]));
      expect(cells["一小时缓存写入"]).toBe("未提供");
      for (const field of ["缓存读取", "缓存写入", "一小时缓存写入"]) expect(cells[`阶梯 1 · ${field}`]).toBe("未提供");
      expect(cells["价格单位"]).toBe("未提供"); expect(cells["价格来源"]).toBe("未提供");
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
      await find(sharing, "button", "分享这些模型").click(); await flush();
      expect(r.calls).toHaveLength(0);
      expect(r.notices.at(-1)[0]).toContain("至少勾选");
    } finally { r.cleanup(); }
  });

  test("sharing fails closed instead of writing several legacy actions", async () => {
    const r = runtime(baseState(), async (name) => {
      if (name === "share-native-models") throw Object.assign(new Error("missing"), { status: 404 });
      return {};
    });
    try {
      await find(r.roots["sharing-panel"], "button", "分享这些模型").click(); await flush();
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await find(r.dialog, "button", "确认分享").click(); await flush();
      expect(r.calls.map((call) => call.name)).toEqual(["share-native-models"]);
      expect(r.notices.at(-1)[0]).toContain("更新 Magpie");
      expect(r.notices.at(-1)[0]).toContain("没有做任何修改");
    } finally { r.cleanup(); }
  });

  test("stopping sharing fails closed without legacy toggles", async () => {
    const r = runtime(baseState(), async (name) => {
      if (name === "stop-sharing") throw Object.assign(new Error("missing"), { status: 404 });
      return {};
    });
    try {
      await find(r.roots["sharing-panel"], "button", "停止共享").click(); await flush();
      const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
      await find(r.dialog, "button", "确认停止").click(); await flush();
      expect(r.calls.map((call) => call.name)).toEqual(["stop-sharing"]);
      expect(r.notices.at(-1)[0]).toContain("更新 Magpie");
    } finally { r.cleanup(); }
  });

  test("catalogue metadata saves on its own and never publishes", async () => {
    const r = runtime();
    try {
      const sharing = r.roots["sharing-panel"];
      await find(sharing, "button", "保存展示信息").click(); await flush();
      expect(r.calls.map((call) => call.name)).toEqual(["catalog-settings"]);
      expect(r.calls[0].input.displayName).toBeNull();
      expect(r.calls.some((call) => ["share-models", "share-toggle", "catalog-publish"].includes(call.name))).toBeFalse();
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

  test("generated request download dialog stays open after the prior dialog's queued close event", async () => {
    const state = baseState(); state.status.catalog.peers[0].status = "verified";
    const requestDocument = { schema: "ohmyaihub.connection-request/v1", models: [model.id] };
    const r = runtime(state, async () => requestDocument);
    try {
      await find(r.roots["discovery-panel"], "button", "选择模型并申请").click();
      const choices = all(r.dialog, "input").filter((node) => node.type === "checkbox");
      choices.forEach((node) => { node.checked = true; });
      await find(r.dialog, "button", "生成连接申请").click(); await flush();
      expect(r.calls).toEqual([{ name: "connection-request", input: { nodeId: peer.nodeId, fingerprint, quoteHash, models: [model.id] } }]);
      expect(r.dialog.open).toBeTrue();
      expect(r.dialog.textContent).toContain("连接申请已生成");
      expect(find(r.dialog, "button", "下载连接申请")).toBeDefined();
      await flush();
      expect(r.dialog.open).toBeTrue();
      expect(find(r.dialog, "button", "下载连接申请")).toBeDefined();
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

  test("active legacy and changed-quote authorizations offer explicit backend-derived reissue without autoacceptance", async () => {
    for (const acceptedQuoteHash of [null, "e".repeat(64)]) {
      const state = baseState(); state.status.consumers = [{ consumerId: "friend", models: [model.id], acceptedQuoteHash, priceVersion: "old-version", paused: null }];
      const currentPriceVersion = "c".repeat(64);
      const r = runtime(state, async () => ({ consumer: state.status.consumers[0], currentPriceVersion, currentQuoteHash: quoteHash }));
      try {
        await find(r.roots["sharing-panel"], "button", "检查授权").click(); await flush();
        expect(r.dialog.open).toBeTrue(); expect(r.dialog.textContent).toContain("尚未绑定当前目录报价");
        expect(r.calls).toEqual([{ name: "consumer-check", input: { consumerId: "friend" } }]);
        const submit = find(r.dialog, "button", "接受并重新签发"); expect(submit.disabled).toBeTrue();
        await submit.click(); await flush(); expect(r.calls).toHaveLength(1);
        const agree = all(r.dialog, "input")[0]; agree.checked = true; await agree.emit("change");
        await submit.click(); await flush();
        expect(r.calls[1]).toEqual({ name: "consumer-reissue", input: { consumerId: "friend", acceptPriceVersion: currentPriceVersion, acceptQuoteHash: quoteHash } });
      } finally { r.cleanup(); }
    }
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
      expect(r.dialog.open).toBeTrue();
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
  expect(html).toContain("已保存的密码不会回显");
  expect(html).toContain("不会写入浏览器存储");
});

describe("available-model evidence (simulated status.providers, no backend)", () => {
  const NOW = Date.parse("2026-10-31T00:10:00.000Z");
  const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
  const evidence = (over = {}) => ({
    status: "current", source: "provider-models", readAt: iso(-60_000), expiresAt: iso(4 * 60_000),
    models: ["qwen/qwen3-32b", "deepseek/deepseek-chat"], modelCount: 2, callable: "yes",
    identity: { hostname: "partner-harbor", virtualIpv4: null, fingerprint: null },
    generation: 3, keyRef: "provider-keys.json#p1", keyGeneration: 2, error: null, ...over,
  });
  const provider = (over = {}) => ({ id: "p1", status: "connected", fingerprint: { hostname: "partner-harbor" }, modelsEvidence: evidence(), ...over });
  const summaryOf = (rows) => modelEvidenceSummary(rows, NOW);

  test("only a current, fresh, connected record with finite count counts", () => {
    const summary = summaryOf([provider()]);
    expect(summary).toMatchObject({ state: "current", count: 2, providers: 1 });
    expect(summary.label).toBe("2 个当前可见模型");
    expect(summary.detail).toContain("最近真实读回");
    expect(summary.detail).toContain("推理额度与 429 另计");
    expect(summary.entries[0].models).toEqual(["qwen/qwen3-32b", "deepseek/deepseek-chat"]);
    expect(summary.entries[0].counted).toBeTrue();
    expect(summaryOf([provider(), provider({ id: "p2", modelsEvidence: evidence({ modelCount: 5, models: [] }) })])).toMatchObject({ count: 7, providers: 2 });
  });

  test("legacy provider.models and authorization lists never become a callable count", () => {
    expect(summaryOf([{ id: "p1", status: "connected", models: ["a/one", "b/two"] }]))
      .toMatchObject({ state: "unknown", count: 0, label: "尚未确认" });
    expect(summaryOf([{ id: "p1", models: ["a/one"], modelsEvidence: evidence({ status: "unknown", callable: "unknown", modelCount: null }) }]))
      .toMatchObject({ state: "unknown", count: 0 });
    expect(summaryOf([{ id: "p1", models: ["a/one"], modelsEvidence: evidence({ callable: "unknown" }) }]))
      .toMatchObject({ state: "unknown", count: 0 });
    expect(summaryOf([{ id: "p1", models: ["a/one"], modelsEvidence: evidence({ modelCount: null }) }]))
      .toMatchObject({ state: "unknown", count: 0 });
  });

  test("stale evidence shows unknown plus the exact next step", () => {
    const summary = summaryOf([provider({ modelsEvidence: evidence({ status: "stale" }) })]);
    expect(summary).toMatchObject({ state: "stale", count: 0, label: "模型清单已过期" });
    expect(summary.detail).toContain("重新读取可用模型");
    expect(summary.detail).toContain("过期清单不算可用");
    expect(summaryOf([])).toMatchObject({ state: "none", label: "尚未连接" });
  });

  test("readAt must be a real past time inside a 5 minute window", () => {
    // exactly 5 minutes is the contract boundary and is accepted
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: iso(-4 * 60_000), expiresAt: iso(60_000) }) })])).toMatchObject({ state: "current", count: 2 });
    // future readAt is not trusted by this client, even if the backend tolerates a small skew
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: iso(60_000), expiresAt: iso(5 * 60_000) }) })])).toMatchObject({ state: "unknown", count: 0 });
    // invalid or missing readAt
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: "not-a-date" }) })])).toMatchObject({ state: "unknown", count: 0 });
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: null }) })])).toMatchObject({ state: "unknown", count: 0 });
    // expiry before readAt
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: iso(60_000), expiresAt: iso(30_000) }) })])).toMatchObject({ state: "unknown", count: 0 });
    // window longer than the backend TTL is unknown, not silently current
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: iso(-6 * 60_000), expiresAt: iso(60_000) }) })])).toMatchObject({ state: "unknown", count: 0 });
    // an ordinary expiry in the past is stale
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: iso(-6 * 60_000), expiresAt: iso(-60_000) }) })])).toMatchObject({ state: "stale", count: 0 });
    // missing or unparsable expiry
    expect(summaryOf([provider({ modelsEvidence: evidence({ expiresAt: null }) })])).toMatchObject({ state: "unknown", count: 0 });
    expect(summaryOf([provider({ modelsEvidence: evidence({ expiresAt: "not-a-date" }) })])).toMatchObject({ state: "unknown", count: 0 });
    // a future expiry is normal TTL and still counts
    expect(summaryOf([provider({ modelsEvidence: evidence({ readAt: iso(-60_000), expiresAt: iso(4 * 60_000) }) })])).toMatchObject({ state: "current", count: 2 });
  });

  test("paused, disabled, degraded or identity-mismatched connections do not count", () => {
    for (const status of ["paused", "disabled", "degraded", "identity-mismatch", "revoked"]) {
      const summary = summaryOf([provider({ status })]);
      expect(summary, status).toMatchObject({ state: "inactive", count: 0, label: "0 个当前可见模型" });
      expect(summary.detail, status).toContain("恢复连接并重新读取");
      expect(summary.entries[0]).toMatchObject({ counted: false, status });
      expect(summary.entries[0].models.length, status).toBeGreaterThan(0);
    }
    // The UI is a pure projection: after the Service marks the old evidence
    // stale/unknown (pause, resume, identity change), a new current readback
    // counts again. The client has no resume epoch of its own.
    expect(summaryOf([provider()])).toMatchObject({ state: "current", count: 2 });
  });

  test("a paused provider does not hide a connected one", () => {
    const summary = summaryOf([provider({ id: "paused", status: "paused" }), provider({ id: "live", modelsEvidence: evidence({ modelCount: 3, models: ["c/three"] }) })]);
    expect(summary).toMatchObject({ state: "current", count: 3, providers: 1 });
    expect(summary.detail).toContain("另有 1 个伙伴连接已暂停或降级，仅诊断");
    expect(summary.entries.filter((row) => row.counted === false)).toHaveLength(1);
  });

  test("a visible list never overwrites an exhausted or unread quota", () => {
    const spent = summaryOf([{ ...provider(), limit: { costLimit: 2, cost: 2, costLeft: 0, spent: true } }]);
    expect(spent).toMatchObject({ state: "current", count: 2, label: "2 个当前可见模型" });
    expect(spent.detail).toContain("额度已用尽（原生 429）");
    expect(spent.entries[0]).toMatchObject({ quota: "spent" });
    expect(spent.entries[0].quotaText).toContain("429");

    const unknown = summaryOf([provider()]);
    expect(unknown.detail).toContain("额度待确认");
    expect(unknown.entries[0]).toMatchObject({ quota: "unknown" });
  });

  test("an empty or rejected readback gets its own next step, never a zero", () => {
    const empty = summaryOf([provider({ modelsEvidence: evidence({ models: [], modelCount: 0 }) })]);
    expect(empty).toMatchObject({ state: "empty", count: 0, label: "已连接，但没有发现模型" });
    expect(empty.detail).toContain("核对模型范围与额度");

    const denied = summaryOf([provider({ modelsEvidence: evidence({ status: "unknown", callable: "no", modelCount: null, error: "401 rejected" }) })]);
    expect(denied).toMatchObject({ state: "denied", count: 0, label: "授权未通过" });
    expect(denied.detail).toContain("401/撤销");
    expect(denied.detail).not.toContain("0 个");
  });

  test("a changed key only counts after a new current readback", () => {
    expect(summaryOf([provider({ modelsEvidence: evidence({ status: "stale", keyGeneration: 3, generation: 1 }) })])).toMatchObject({ state: "stale", count: 0 });
    expect(summaryOf([provider({ modelsEvidence: evidence({ status: "current", keyGeneration: 3, generation: 2 }) })])).toMatchObject({ state: "current", count: 2 });
  });
});

describe("explicit model readback (simulated backend response shape)", () => {
  const providerView = { id: "provider-1", remoteMagpieId: "magpie-1", status: "connected", fingerprint: { hostname: "partner-harbor" }, limit: { costLimit: 2, cost: 0, costLeft: 2 } };
  const state = () => {
    const base = baseState();
    base.status.providers = [structuredClone(providerView)];
    return base;
  };
  const evidence = (over = {}) => {
    const now = Date.now();
    return { status: "current", source: "provider-models", readAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 4 * 60_000).toISOString(), models: ["qwen/qwen3-32b"], modelCount: 1, callable: "yes", identity: null, generation: 1, keyRef: "provider-keys.json#provider-1", keyGeneration: 1, error: null, ...over };
  };

  test("provider-models refreshes the console state exactly like the contract asks", async () => {
    let refreshes = 0;
    const r = runtime(state(), async (name) => name === "provider-models" ? { ...providerView, models: ["qwen/qwen3-32b"], modelsEvidence: evidence() } : {});
    try {
      const before = r.refreshes;
      await find(r.roots["connections-panel"], "button", "读取可用模型").click(); await flush();
      expect(r.calls.map((call) => call.name)).toEqual(["provider-models"]);
      expect(r.refreshes).toBeGreaterThan(before);
      expect(r.dialog.textContent).toContain("qwen/qwen3-32b");
      expect(r.dialog.textContent).not.toContain("只作诊断");
    } finally { r.cleanup(); }
  });

  test("a read without current evidence is shown as diagnostic only", async () => {
    const r = runtime(state(), async () => ({ ...providerView, models: ["qwen/qwen3-32b"], modelsEvidence: evidence({ status: "stale", callable: "unknown", modelCount: null }) }));
    try {
      await find(r.roots["connections-panel"], "button", "读取可用模型").click(); await flush();
      expect(r.dialog.textContent).toContain("只作诊断");
      expect(r.dialog.textContent).toContain("首页不会把它计为可用");
    } finally { r.cleanup(); }
  });
});
