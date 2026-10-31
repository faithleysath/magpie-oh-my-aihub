import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EIP6963_ANNOUNCE, EIP6963_REQUEST } from "./external-wallet.js";
import { mountWalletVault, walletAddressView, walletStatusLabel } from "./wallet-vault-ui.js";

class Node {
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
  remove() { this.removed = true; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
  async emit(event, payload = { preventDefault() {} }) { for (const handler of this.handlers[event] || []) await handler(payload); }
  querySelectorAll(selector) {
    const parts = selector.split(",").map((part) => part.trim().toUpperCase()).filter(Boolean);
    return this.descendants().filter((node) => parts.includes(node.tagName));
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.emit("click"); }
}
const descendants = (root) => root.descendants();
const all = (root, tag) => descendants(root).filter((node) => node.tagName === tag.toUpperCase());
const find = (root, tag, text) => descendants(root).find((node) => node.tagName === tag.toUpperCase() && node.textContent === text);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ADDRESS = "0x" + "1".repeat(40);

const absent = { version: 1, address: null, addressVerified: false, status: "absent", unlockExpiresAt: null };
const locked = { version: 1, address: ADDRESS, addressVerified: false, status: "locked", unlockExpiresAt: null };
const unlocked = { version: 1, address: ADDRESS, addressVerified: true, status: "unlocked", unlockExpiresAt: "2099-01-01T00:00:00.000Z" };

function browser() {
  const previous = { document: globalThis.document, window: globalThis.window };
  const nodes = new Map();
  const body = new Node("body");
  const document = {
    body,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node("div")); return nodes.get(id); },
    createElement: (tag) => new Node(tag),
  };
  const target = new EventTarget();
  globalThis.document = document;
  return { document, target, nodes, restore() { globalThis.document = previous.document; globalThis.window = previous.window; } };
}

function mount({ actions = {}, targetEthereum = null } = {}) {
  const env = browser();
  const calls = [];
  const notices = [];
  const client = {
    action: async (name, input) => {
      calls.push({ name, input: structuredClone(input) });
      const handler = actions[name];
      if (!handler) throw Object.assign(new Error("action_not_allowed"), { status: 404 });
      return await handler(input);
    },
  };
  if (targetEthereum) env.target.ethereum = targetEthereum;
  const mounted = mountWalletVault({ client, getState: () => ({ configured: true }), notice: (...args) => notices.push(args), refreshState: async () => {}, windowTarget: env.target });
  const root = env.nodes.get("wallet-vault-panel");
  const dialog = env.document.body.children.find((node) => node.tagName === "DIALOG");
  return { ...env, root, dialog, calls, notices, mounted, async show() { mounted.onShow(); await flush(); }, restore() { mounted.dispose(); env.restore(); } };
}

function fillPasswordDialog(dialog, password = "correct-horse-battery") {
  const inputs = all(dialog, "input").filter((node) => node.type === "password");
  inputs[0].value = password;
  if (inputs[1]) inputs[1].value = password;
  return inputs;
}
function checkAgree(dialog) { const checkbox = all(dialog, "input").find((node) => node.type === "checkbox"); checkbox.checked = true; return checkbox; }

describe("local wallet UI", () => {
  test("status labels and address trust never promote a locked address", () => {
    expect(walletStatusLabel("absent")).toBe("尚未创建");
    expect(walletStatusLabel("locked")).toBe("已锁定");
    expect(walletAddressView(locked).trusted).toBe(false);
    expect(walletAddressView(locked).label).toContain("不能作为收款地址");
    expect(walletAddressView(unlocked).trusted).toBe(true);
    expect(walletAddressView(null).address).toBeNull();
  });

  test("service not wired fails closed with no create or mock-send controls", async () => {
    const ui = mount();
    try {
      await ui.show();
      expect(ui.root.textContent).toContain("本地钱包服务未接入");
      expect(find(ui.root, "button", "创建钱包")).toBeUndefined();
      expect(find(ui.root, "button", "发送交易")).toBeUndefined();
      expect(find(ui.root, "button", "模拟发送")).toBeUndefined();
      expect(ui.calls.map((call) => call.name)).toEqual(["wallet-vault-status"]);
    } finally { ui.restore(); }
  });

  test("create requires password confirmation and warning, then shows a hidden one-time mnemonic", async () => {
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: absent }), "wallet-vault-create": async () => ({ wallet: unlocked, mnemonic: "test only words for ui", warning: "only once" }) } });
    try {
      await ui.show();
      await find(ui.root, "button", "创建钱包").click(); await flush();
      fillPasswordDialog(ui.dialog);
      const agree = checkAgree(ui.dialog); await agree.emit("change");
      await find(ui.dialog, "button", "创建钱包").click(); await flush();
      const create = ui.calls.find((call) => call.name === "wallet-vault-create");
      expect(create.input).toMatchObject({ strength: 128 });
      expect(typeof create.input.password).toBe("string");
      expect(ui.dialog.textContent).toContain("恢复助记词");
      const pre = all(ui.dialog, "pre")[0];
      expect(pre.textContent).toBe("");
      await find(ui.dialog, "button", "显示内容").click();
      expect(pre.textContent).toBe("test only words for ui");
      await find(ui.dialog, "button", "隐藏内容").click();
      expect(pre.textContent).toBe("");
      await find(ui.dialog, "button", "结束并清除").click(); await flush();
      expect(ui.dialog.open).toBe(false);
      expect(ui.dialog.textContent).not.toContain("test only words for ui");
      expect(ui.root.textContent).toContain("已解锁");
    } finally { ui.restore(); }
  });

  test("import and restore clear secret inputs, never echo them, and require explicit confirmation", async () => {
    for (const [label, action, fieldName] of [["导入助记词", "wallet-vault-import", "mnemonic"], ["恢复加密备份", "wallet-vault-restore", "encryptedBackup"]]) {
      const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: absent }), [action]: async () => ({ wallet: locked }) } });
      try {
        await ui.show();
        await find(ui.root, "button", "选择已有钱包方式").click(); await flush();
        await find(ui.dialog, "button", label).click(); await flush();
        const secret = all(ui.dialog, "textarea")[0]; secret.value = fieldName === "mnemonic" ? "one two three" : '{"crypto":{}}';
        fillPasswordDialog(ui.dialog);
        const agree = checkAgree(ui.dialog); await agree.emit("change");
        await find(ui.dialog, "button", label === "导入助记词" ? "导入钱包" : "恢复钱包").click(); await flush();
        const call = ui.calls.find((entry) => entry.name === action);
        expect(call.input[fieldName]).toBe(fieldName === "mnemonic" ? "one two three" : '{"crypto":{}}');
        expect(secret.value).toBe("");
        expect(ui.dialog.textContent).not.toContain("one two three");
        expect(ui.root.textContent).toContain("未验证地址");
      } finally { ui.restore(); }
    }
  });

  test("unlock and lock use the exact actions and clear sensitive state", async () => {
    let state = locked;
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: state }), "wallet-vault-unlock": async () => { state = unlocked; return { wallet: state }; }, "wallet-vault-lock": async () => { state = locked; return { wallet: state }; } } });
    try {
      await ui.show();
      await find(ui.root, "button", "解锁").click(); await flush();
      const password = all(ui.dialog, "input").find((node) => node.type === "password"); password.value = "correct-horse-battery";
      await find(ui.dialog, "button", "解锁").click(); await flush();
      expect(ui.calls.find((call) => call.name === "wallet-vault-unlock").input.password).toBe("correct-horse-battery");
      expect(ui.root.textContent).toContain("当前会话已验证");
      await find(ui.root, "button", "锁定").click(); await flush();
      expect(ui.calls.some((call) => call.name === "wallet-vault-lock")).toBe(true);
      expect(ui.root.textContent).toContain("未验证地址");
    } finally { ui.restore(); }
  });

  test("encrypted backup is explicit, hidden by default, and never auto-downloaded", async () => {
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: unlocked }), "wallet-vault-backup": async () => ({ wallet: unlocked, format: "web3-keystore-v3", address: ADDRESS, keystore: '{"crypto":"ciphertext"}' }) } });
    try {
      await ui.show();
      await find(ui.root, "button", "生成加密备份").click(); await flush();
      const agree = checkAgree(ui.dialog); await agree.emit("change");
      await find(ui.dialog, "button", "生成加密备份").click(); await flush();
      expect(ui.calls.find((call) => call.name === "wallet-vault-backup")).toBeDefined();
      expect(ui.dialog.textContent).toContain("加密备份");
      const pre = all(ui.dialog, "pre")[0];
      expect(pre.textContent).toBe("");
      await find(ui.dialog, "button", "显示内容").click();
      expect(pre.textContent).toContain("ciphertext");
      expect(find(ui.dialog, "button", "下载")).toBeUndefined();
      expect(ui.dialog.textContent).toContain("不会自动下载");
    } finally { ui.restore(); }
  });

  test("reveal requires authorize then password, defaults hidden, and clears on end", async () => {
    const ui = mount({ actions: {
      "wallet-vault-status": async () => ({ wallet: unlocked }),
      "wallet-vault-reveal-authorize": async () => ({ authorizationId: "a".repeat(64), kind: "mnemonic", expiresAt: "2099-01-01T00:00:00.000Z" }),
      "wallet-vault-reveal-mnemonic": async () => ({ kind: "mnemonic", address: ADDRESS, path: "m/44'/60'/0'/0/0", purpose: "wallet-recovery", mnemonic: "secret words never in state", warning: "keep safe" }),
    } });
    try {
      await ui.show();
      await find(ui.root, "button", "导出恢复助记词").click(); await flush();
      const purpose = all(ui.dialog, "select")[0]; purpose.value = "wallet-recovery";
      const agree = checkAgree(ui.dialog); await agree.emit("change");
      await find(ui.dialog, "button", "生成一次性导出授权").click(); await flush();
      expect(ui.calls.find((call) => call.name === "wallet-vault-reveal-authorize").input).toEqual({ kind: "mnemonic", purpose: "wallet-recovery", confirmation: "local-user-confirmed" });
      const password = all(ui.dialog, "input").find((node) => node.type === "password"); password.value = "correct-horse-battery";
      await find(ui.dialog, "button", "显示一次").click(); await flush();
      const reveal = ui.calls.find((call) => call.name === "wallet-vault-reveal-mnemonic");
      expect(reveal.input).toMatchObject({ authorizationId: "a".repeat(64), password: "correct-horse-battery" });
      const pre = all(ui.dialog, "pre")[0];
      expect(pre.textContent).toBe("");
      await find(ui.dialog, "button", "显示内容").click();
      expect(pre.textContent).toBe("secret words never in state");
      await find(ui.dialog, "button", "隐藏内容").click();
      expect(pre.textContent).toBe("");
      await find(ui.dialog, "button", "显示内容").click();
      await find(ui.dialog, "button", "结束并清除").click(); await flush();
      expect(ui.dialog.open).toBe(false);
      expect(ui.dialog.textContent).not.toContain("secret words never in state");
      expect(ui.root.textContent).not.toContain("secret words never in state");
    } finally { ui.restore(); }
  });

  test("late create after close is discarded and never reopens a secret dialog", async () => {
    let resolveCreate;
    const pending = new Promise((resolve) => { resolveCreate = resolve; });
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: absent }), "wallet-vault-create": async () => pending } });
    try {
      await ui.show();
      await find(ui.root, "button", "创建钱包").click(); await flush();
      fillPasswordDialog(ui.dialog); const agree = checkAgree(ui.dialog); await agree.emit("change");
      void find(ui.dialog, "button", "创建钱包").click(); await flush();
      await find(ui.dialog, "button", "关闭").click(); await flush();
      resolveCreate({ wallet: unlocked, mnemonic: "late create secret", warning: "once" }); await flush();
      expect(ui.dialog.open).toBe(false);
      expect(ui.dialog.textContent).not.toContain("late create secret");
      expect(ui.root.textContent).not.toContain("late create secret");
      expect(ui.notices.some(([message]) => message.includes("钱包已创建；恢复助记词未显示"))).toBeTrue();
      expect(ui.root.textContent).toContain("已解锁");
    } finally { ui.restore(); }
  });

  test("late reveal after clearSecrets/pagehide/dispose is discarded", async () => {
    for (const cancel of ["clear", "pagehide", "dispose"]) {
      let resolveReveal;
      const pending = new Promise((resolve) => { resolveReveal = resolve; });
      const ui = mount({ actions: {
        "wallet-vault-status": async () => ({ wallet: unlocked }),
        "wallet-vault-reveal-authorize": async () => ({ authorizationId: "d".repeat(64), kind: "private-key" }),
        "wallet-vault-reveal-private-key": async () => pending,
      } });
      try {
        await ui.show();
        await find(ui.root, "button", "导出私钥").click(); await flush();
        all(ui.dialog, "select")[0].value = "eip155-external-wallet";
        const agree = checkAgree(ui.dialog); await agree.emit("change");
        await find(ui.dialog, "button", "生成一次性导出授权").click(); await flush();
        all(ui.dialog, "input").find((node) => node.type === "password").value = "correct-horse-battery";
        void find(ui.dialog, "button", "显示一次").click(); await flush();
        if (cancel === "clear") ui.mounted.clearSecrets();
        else if (cancel === "pagehide") ui.target.dispatchEvent(new Event("pagehide"));
        else ui.mounted.dispose();
        resolveReveal({ privateKey: "late reveal secret", warning: "w" }); await flush();
        expect(ui.dialog.open).toBeFalse();
        expect(ui.dialog.textContent).not.toContain("late reveal secret");
      } finally { if (cancel !== "dispose") ui.restore(); else ui.restore(); }
    }
  });

  test("state-pushed locked snapshot closes secret DOM and removes trusted address", async () => {
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: unlocked }), "wallet-vault-reveal-authorize": async () => ({ authorizationId: "e".repeat(64), kind: "mnemonic" }), "wallet-vault-reveal-mnemonic": async () => ({ mnemonic: "state push secret", warning: "w" }) } });
    try {
      await ui.show();
      await find(ui.root, "button", "导出恢复助记词").click(); await flush();
      all(ui.dialog, "select")[0].value = "wallet-recovery";
      const agree = checkAgree(ui.dialog); await agree.emit("change");
      await find(ui.dialog, "button", "生成一次性导出授权").click(); await flush();
      all(ui.dialog, "input").find((node) => node.type === "password").value = "correct-horse-battery";
      await find(ui.dialog, "button", "显示一次").click(); await flush();
      await find(ui.dialog, "button", "显示内容").click();
      expect(ui.dialog.textContent).toContain("state push secret");
      ui.mounted.render({ walletVault: { wallet: locked } }); await flush();
      expect(ui.dialog.open).toBeFalse();
      expect(ui.dialog.textContent).not.toContain("state push secret");
      expect(ui.root.textContent).toContain("未验证地址");
      expect(ui.root.textContent).not.toContain("当前会话已验证");
    } finally { ui.restore(); }
  });

  test("repeated render does not append duplicate headings", async () => {
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: locked }) } });
    try {
      await ui.show();
      ui.mounted.render({}); ui.mounted.render({}); await flush();
      expect(all(ui.root, "h2").filter((node) => node.textContent === "本地钱包")).toHaveLength(1);
      expect(ui.root.textContent).toContain("未验证地址");
    } finally { ui.restore(); }
  });

  test("error text is a stable code mapping, not reflected input or secret", async () => {
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: absent }), "wallet-vault-create": async () => { throw Object.assign(new Error("password=super-secret input"), { code: "wallet-invalid-input" }); } } });
    try {
      await ui.show();
      await find(ui.root, "button", "创建钱包").click(); await flush();
      fillPasswordDialog(ui.dialog); const agree = checkAgree(ui.dialog); await agree.emit("change");
      await find(ui.dialog, "button", "创建钱包").click(); await flush();
      expect(ui.dialog.textContent).not.toContain("super-secret");
      expect(ui.dialog.textContent).toContain("输入不符合本地钱包要求");
    } finally { ui.restore(); }
  });

  test("EIP-6963 discovery is explicit, uses only name/initial, and never auto-connects", async () => {
    const calls = [];
    const provider = { request: async (call) => { calls.push(structuredClone(call)); if (call.method === "eth_requestAccounts") return [ADDRESS]; if (call.method === "eth_chainId") return "0x61"; throw Object.assign(new Error("unsupported"), { code: 4200 }); } };
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: absent }) } });
    try {
      const wallet = { info: { uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "MetaMask", rdns: "io.metamask", icon: "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+" }, provider };
      const announce = () => ui.target.dispatchEvent(new CustomEvent(EIP6963_ANNOUNCE, { detail: wallet }));
      ui.target.addEventListener(EIP6963_REQUEST, announce);
      await ui.show();
      expect(calls).toHaveLength(0);
      expect(ui.root.textContent).toContain("MetaMask");
      expect(ui.root.textContent).toContain("信息未验证");
      expect(ui.root.textContent).not.toContain("<svg");
      await find(ui.root, "button", "选择此钱包").click(); await flush();
      expect(calls).toHaveLength(0);
      await find(ui.root, "button", "连接所选钱包").click(); await flush();
      expect(calls.map((call) => call.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
      expect(ui.root.textContent).toContain("已连接外部钱包");
      expect(all(ui.root, "textarea")).toHaveLength(0);
      await find(ui.root, "button", "断开外部钱包").click();
    } finally { ui.restore(); }
  });

  test("legacy window.ethereum is an explicit choice, not an automatic fallback", async () => {
    const calls = [];
    const legacy = { request: async (call) => { calls.push(call.method); if (call.method === "eth_requestAccounts") return [ADDRESS]; if (call.method === "eth_chainId") return "0x61"; throw Object.assign(new Error("unsupported"), { code: 4200 }); } };
    const ui = mount({ targetEthereum: legacy, actions: { "wallet-vault-status": async () => ({ wallet: absent }) } });
    try {
      await ui.show();
      expect(calls).toHaveLength(0);
      expect(ui.root.textContent).toContain("旧式注入钱包");
      await find(ui.root, "button", "显式选择旧式钱包").click(); await flush();
      expect(calls).toHaveLength(0);
      await find(ui.root, "button", "连接所选钱包").click(); await flush();
      expect(calls).toEqual(["eth_requestAccounts", "eth_chainId"]);
    } finally { ui.restore(); }
  });

  test("pagehide and clearSecrets remove sensitive DOM and references", async () => {
    const ui = mount({ actions: { "wallet-vault-status": async () => ({ wallet: unlocked }), "wallet-vault-reveal-authorize": async () => ({ authorizationId: "c".repeat(64), kind: "private-key" }), "wallet-vault-reveal-private-key": async () => ({ privateKey: "0x" + "d".repeat(64), warning: "w" }) } });
    try {
      await ui.show();
      await find(ui.root, "button", "导出私钥").click(); await flush();
      all(ui.dialog, "select")[0].value = "eip155-external-wallet";
      const agree = checkAgree(ui.dialog); await agree.emit("change");
      await find(ui.dialog, "button", "生成一次性导出授权").click(); await flush();
      all(ui.dialog, "input").find((node) => node.type === "password").value = "correct-horse-battery";
      await find(ui.dialog, "button", "显示一次").click(); await flush();
      await find(ui.dialog, "button", "显示内容").click();
      expect(ui.dialog.textContent).toContain("0x" + "d".repeat(64));
      ui.target.dispatchEvent(new Event("pagehide")); await flush();
      expect(ui.dialog.open).toBe(false);
      expect(ui.dialog.textContent).not.toContain("0x" + "d".repeat(64));
    } finally { ui.restore(); }
  });

  test("wallet UI source has no storage, clipboard, download or send path", () => {
    const source = readFileSync(new URL("./wallet-vault-ui.js", import.meta.url), "utf8");
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "navigator.clipboard", "clipboard.writeText", ".download", "eth_sendTransaction", "wallet-vault-send", "operationPort"]) expect(source.includes(forbidden)).toBe(false);
  });
});
