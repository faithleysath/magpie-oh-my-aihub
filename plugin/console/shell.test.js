import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

/** The shipped shell is a source artifact; these assertions keep the IA honest. */
describe("five page shell", () => {
  test("navigation is exactly the five product pages on both layouts", () => {
    const nav = html.slice(html.indexOf('<nav aria-label="主导航">'), html.indexOf("</nav>"));
    const ids = [...nav.matchAll(/id="nav-([a-z-]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["home", "discovery", "sharing", "wallet", "network"]);
    expect(nav).toContain(">首页<");
    expect(nav).toContain(">发现<");
    expect(nav).toContain(">我的共享<");
    expect(nav).toContain(">钱包<");
    expect(nav).toContain(">网络<");
    for (const gone of ["nav-connections", "nav-accounting", "nav-settings", "nav-overview"]) expect(html).not.toContain(gone);
    // One nav element serves desktop sidebar and the mobile bottom bar.
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain(".sidebar {");
  });

  test("home has only the five agreed blocks", () => {
    const home = html.slice(html.indexOf('<section id="overview"'), html.indexOf('<section id="discovery-page"'));
    const blocks = [...home.matchAll(/<h2 id="home-([a-z-]+)-title"/g)].map((match) => match[1]);
    expect(blocks).toEqual(["network", "models", "sharing", "wallet", "todo"]);
    for (const gone of ["stats-grid", "overview-hero", "network-art", "readiness", "engine-status", "peer-count", "checks-list"]) {
      expect(home).not.toContain(gone);
    }
    // Available models must come from real readback evidence, not a legacy
    // snapshot or an authorization list.
    expect(app).toContain("modelEvidenceSummary");
    expect(app).not.toContain("Array.isArray(provider?.models)");
    expect(app).not.toContain("provider.models");
    // Deposits are cumulative, not a balance, and credit is per provider.
    expect(home).toContain("资产余额尚未查询");
    expect(home).toContain("提供者信用（按伙伴）");
    expect(home).not.toContain("链上入账（资产）");
    expect(home).not.toContain("资产余额</dt>");
  });

  test("the wallet page states the testnet scope exactly once", () => {
    expect(html).toContain("测试网环境；本应用不持有私钥，不执行转账。");
    expect(html.split("测试网环境").length - 1).toBe(1);
    expect(html).not.toContain("仅支持测试网资产。BSC Testnet 与 Base Sepolia");
  });

  test("discovery merges native connections and wallet merges bills", () => {
    const discovery = html.slice(html.indexOf('<section id="discovery-page"'), html.indexOf('<section id="sharing-panel"'));
    expect(discovery).toContain('id="discovery-panel"');
    expect(discovery).toContain('id="connections-panel"');
    expect(discovery).toContain('role="tablist"');
    const wallet = html.slice(html.indexOf('<section id="wallet-page"'), html.indexOf('<section id="settings-panel"'));
    expect(wallet).toContain('id="wallet-panel"');
    const advanced = wallet.slice(wallet.indexOf('<details class="advanced-recovery"'));
    expect(advanced).toContain('id="accounting-panel"');
  });

  test("first run is exactly three fields and one connect action", () => {
    const form = html.slice(html.indexOf('<form id="settings-form"'), html.indexOf("</form>"));
    const fields = [...form.matchAll(/<input[^>]*id="([a-z-]+)"|<textarea[^>]*id="([a-z-]+)"/g)].map((match) => match[1] || match[2]);
    expect(fields).toEqual(["network-name", "network-secret", "network-peers"]);
    expect(form).toContain('type="password"');
    expect(form).toContain('id="save"');
    expect(form).toContain("保存只表示配置已写入");
    for (const gone of ["sharing", "consuming", "roles-step", "stepper", "accept-incoming", "network-listen", "network-rpc-port"]) {
      expect(html).not.toContain(`id="${gone}"`);
    }
  });

  test("ports are read-only diagnostics and never form inputs", () => {
    const network = html.slice(html.indexOf('<section id="settings-panel"'));
    expect(network).toContain('id="network-ports"');
    expect(network).toContain("地址或端口被占用不等于由本插件验证");
    const diagnostics = network.slice(network.indexOf('<details class="diagnostics"'), network.indexOf("</details>"));
    expect(diagnostics).not.toMatch(/type="number"/);
    expect(network).not.toContain("编辑端口");
  });

  test("one primary action per page and no sticker-per-button regression", () => {
    for (const page of ['<section id="overview"', '<section id="discovery-page"', '<section id="sharing-panel"', '<section id="wallet-page"', '<section id="settings-panel"']) {
      const body = html.slice(html.indexOf(page), html.indexOf("</section>", html.indexOf(page)));
      const primaries = (body.match(/class="button primary"/g) || []).length;
      expect(primaries).toBeLessThanOrEqual(1);
    }
  });

  test("theme is a persisted preference while credentials never persist", () => {
    expect(app).toContain('const THEME_KEY = "aihub-console-theme"');
    expect(app).toContain("root.dataset.theme");
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("prefers-reduced-motion: reduce");
    // A component display rule must never make a hidden control visible/focusable.
    expect(css).toContain("[hidden] { display: none !important; }");
    expect(app).toContain("consumeTicketFragment(window.location, window.history)");
  });

  test("session copy distinguishes never-authenticated, expired and logout", () => {
    expect(app).toContain('unauthorized: ["这个浏览器还没有访问权限"');
    expect(app).toContain('expired: ["本次会话已结束"');
    expect(app).toContain('logout: ["已退出本机会话"');
    expect(app).toContain('sessionEnded(everAuthenticated ? "expired" : "unauthorized")');
  });

  test("the connect write sends only the three agreed fields", () => {
    const save = app.slice(app.indexOf("async function saveNetwork"), app.indexOf('$("settings-form")?.addEventListener'));
    expect(save).toContain('client.action("join-network", input)');
    expect(save).toContain("initialNode");
    expect(save).toContain("networkSecret");
    expect(save).not.toContain("sharingEnabled");
    expect(save).not.toContain("rpcPort");
    expect(save).not.toContain("listenAddr");
    // Fail closed on an older backend: no multi-write join, no configure fallback.
    expect(save).toContain("if (error.status !== 404) throw error;");
    expect(save).toContain("本页没有修改任何设置");
    expect(save).not.toContain('client.action("configure"');
    expect(save).not.toContain("peers: initialNode");
  });

  test("network status prefers the read-only network projection and unknown stays unknown", () => {
    expect(app).toContain("object(s.network)");
    expect(app).toContain("network.neighbors");
    expect(app).toContain("network.ports");
    // The "unknown is never online/offline" rule lives in the pure network
    // projection module, which the page imports.
    const network = readFileSync(new URL("./network.js", import.meta.url), "utf8");
    expect(app).toContain("./network.js");
    expect(network).toContain('peer.online === true');
    expect(network).toContain('peer.online === false');
    expect(network).toContain('peer.stale === true');
    expect(app).not.toMatch(/latencyMs\s*\?\?/);
    expect(app).not.toContain("editable: true");
    // The topbar reports the console session, never P2P membership.
    expect(app).toContain('connection("控制台已连接"');
    expect(app).not.toContain('connection("本机已连接"');
  });

  test("sharing is one explicit action with automatic publish, and stop is separate", () => {
    const providers = readFileSync(new URL("./providers.js", import.meta.url), "utf8");
    expect(providers).toContain('button("分享这些模型"');
    expect(providers).toContain('client.action("share-native-models", { models, confirm: true })');
    expect(providers).toContain('client.action("stop-sharing", { confirm: true })');
    const sharingSection = providers.slice(providers.indexOf("const shareIntro"), providers.indexOf("function importDocument"));
    expect(sharingSection).not.toContain('button("保存模型范围"');
    expect(sharingSection).not.toContain('button("发布目录"');
    expect(sharingSection).not.toContain('button("保存目录说明"');
    expect(providers).not.toContain("consume-toggle");
    // Stopping is only offered while something is actually shared.
    expect(providers).toContain('stopShareButton.hidden = next.status.config.sharingEnabled !== true');
  });

});
