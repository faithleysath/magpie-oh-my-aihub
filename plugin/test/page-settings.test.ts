import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const PAGE = join(import.meta.dir, "../page");
const html = readFileSync(join(PAGE, "index.html"), "utf8");
const app = readFileSync(join(PAGE, "app.js"), "utf8");
const settings = readFileSync(join(PAGE, "settings.js"), "utf8");
function helper() { const w: any = {}; new Function("window", settings)(w); return w.OHMYAIHUB_SETTINGS; }

test("launch-only whole-options merge preserves every network/unknown option", () => {
  const base = { networkName: "fixture", networkSecret: "fixture-kept-secret", rpcPort: 15999, future: { x: true }, consoleLaunch: { future: 9, autoOpen: false } };
  const request = { nonce: "a".repeat(32), issuedAt: 1, expiresAt: 2 };
  const merged = helper().mergeLaunch(base, { request });
  expect(merged).toEqual({ ...base, consoleLaunch: { ...base.consoleLaunch, request } });
  expect(base.consoleLaunch).toEqual({ future: 9, autoOpen: false });
  expect(helper().mergeLaunch(base, { autoOpen: true }).networkSecret).toBe(base.networkSecret);
});

describe("native sandbox page boundary", () => {
  test("external scripts only, no inline handlers, shipped/generated files exist", () => {
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son(click|load|change|submit|error)\s*=/i);
    const generated = new Set(["status.js", "options.js", "launcher.js"]);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const path = m[1]!;
      if (/^(https?:|#|_magpie\/)/.test(path) || generated.has(path)) continue;
      expect(existsSync(join(PAGE, path))).toBe(true);
    }
  });
  test("three real type=button controls; no network, storage or sandbox escape", () => {
    expect([...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map(m => m[1])).toEqual(["open", "reload", "save"]);
    for (const source of [app, settings]) {
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|localStorage|sessionStorage|document\.cookie|window\.open\(|innerHTML/);
    }
    for (const id of ["open", "reload", "save"]) {
      expect(html).toMatch(new RegExp('<button[^>]*type="button"[^>]*id="' + id + '"'));
      expect(app).toContain('$(' + JSON.stringify(id) + ').addEventListener');
    }
    expect(html).not.toContain("bun plugin/"); expect(html).not.toContain("终端执行");
  });
  test("snapshot has no credentials or network form; local-only caveat and optout are visible", () => {
    expect(html).toContain("首次在本机桌面启用时自动打开一次");
    expect(html).toContain("通过远端 Magpie web 访问不能打开你这边的浏览器");
    expect(html).toContain("不显示任何 Gateway Key");
    expect(html).not.toMatch(/name="networkSecret"|name="networkName"/);
    expect(app).not.toMatch(/sk-[A-Za-z0-9._-]{8,}|api-token|issueTicket|console-port/);
  });
});

function runtime(base: any, fail = false, query = "", launcher?: any) {
  const nodes: Record<string, any> = {};
  const created: any[] = [];
  function element(tag = "div"): any { return { tag, children: [], disabled: true, checked: false, textContent: "", handlers: {},
    appendChild(child: any) { this.children.push(child); }, addEventListener(name: string, fn: any) { this.handlers[name] = fn; } }; }
  const ids = ["open", "reload", "save", "auto-open", "launch-status", "node-status", "snapshot-time", "saved", "console-origin", "pairing-status", "pairing-requests"];
  ids.forEach(id => { nodes[id] = element(); });
  const calls: any[] = [], replacements: string[] = [], timers: (() => void)[] = [];
  const window: any = { crypto, __OH_MY_AIHUB_LAUNCHER__: launcher, OHMYAIHUB_SETTINGS: helper(), location: { pathname: "/plugin/page/index.html", search: query, replace: (s: string) => replacements.push(s), reload: () => calls.push("reload") },
    magpie: { ready: Promise.resolve(), options: { get: async () => base, set: async (o: any) => { calls.push(o); if (fail) throw new Error("private fixture secret"); } } } };
  new Function("window", "document", "URLSearchParams", "setTimeout", app)(window, { getElementById: (id: string) => nodes[id], createElement: (tag: string) => { const n = element(tag); created.push(n); return n; } }, URLSearchParams, (f: () => void) => timers.push(f));
  return { nodes, calls, replacements, timers, created };
}

describe("actual launcher page handlers", () => {
  test("pairing requires explicit matched-code checkbox; preserves old request and all other options", async () => {
    const at = Date.now();
    const request = { id: "d".repeat(32), code: "01234567", expiresAt: new Date(at + 60000).toISOString() };
    const launcher = { at: new Date(at).toISOString(), origin: "http://127.0.0.1:34567", pendingPairings: [request] };
    const oldRequest = { nonce: "a".repeat(32), issuedAt: at, expiresAt: at + 120000 };
    const base = { networkSecret: "fixture-kept", future: 1, consoleLaunch: { request: oldRequest, autoOpen: false } };
    const r = runtime(base, false, "", launcher); await Bun.sleep(0);
    expect(r.nodes["console-origin"].textContent).toBe(launcher.origin);
    const button = r.created.find(n => n.tag === "button")!;
    const check = r.created.find(n => n.tag === "input")!;
    expect(button.disabled).toBe(true); await button.handlers.click(); expect(r.calls).toEqual([]);
    check.checked = true; check.handlers.change(); expect(button.disabled).toBe(false);
    await Promise.all([button.handlers.click(), button.handlers.click()]);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].networkSecret).toBe(base.networkSecret);
    expect(r.calls[0].future).toBe(1); expect(r.calls[0].consoleLaunch.request).toEqual(oldRequest);
    const approval = r.calls[0].consoleLaunch.approval;
    expect(approval.id).toBe(request.id); expect(approval.code).toBe(request.code);
    expect(approval.expiresAt).toBe(Date.parse(request.expiresAt));
    expect(r.replacements[0]).toContain("?approval=" + request.id);
    expect(JSON.stringify(r.calls)).not.toContain("browserSecret");
  });
  test("fallback origin refuses ticket-bearing URLs and stale pairing requests", async () => {
    const at = Date.now();
    for (const origin of ["http://127.0.0.1:34567/#ticket=bad", "http://evil.example", "http://127.0.0.1:65536"]) {
      const r = runtime({}, false, "", { at: new Date(at).toISOString(), origin, pendingPairings: [{ id: "a".repeat(32), code: "12345678", expiresAt: new Date(at - 1).toISOString() }] });
      await Bun.sleep(0); expect(r.nodes["console-origin"].textContent).not.toBe(origin);
      expect(r.created.filter(n => n.tag === "button")).toHaveLength(0); expect(r.calls).toEqual([]);
    }
  });
  test("one click writes nonce over fresh whole options then warms hosted HTML, duplicate click suppressed", async () => {
    const base = { networkName: "lab", networkSecret: "fixture-secret", future: { keep: 1 }, consoleLaunch: { autoOpen: false } };
    const r = runtime(base); await Bun.sleep(0);
    expect(r.nodes.open.disabled).toBe(false);
    await Promise.all([r.nodes.open.handlers.click(), r.nodes.open.handlers.click()]);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].networkSecret).toBe(base.networkSecret);
    expect(r.calls[0].future).toEqual(base.future);
    const req = r.calls[0].consoleLaunch.request;
    expect(req.nonce).toMatch(/^[a-f0-9]{32}$/); expect(req.expiresAt - req.issuedAt).toBe(120000);
    expect(r.calls[0].consoleLaunch.autoOpen).toBe(false);
    expect(r.replacements[0]).toContain("?open=" + req.nonce);
  });
  test("save optout preserves unrelated fields; failure never echoes raw bridge error", async () => {
    const r = runtime({ future: true, consoleLaunch: { autoOpen: true, future: "kept" } }); await Bun.sleep(0);
    r.nodes["auto-open"].checked = false; await r.nodes.save.handlers.click();
    expect(r.calls[0]).toEqual({ future: true, consoleLaunch: { autoOpen: false, future: "kept" } });
    const bad = runtime({}, true); await Bun.sleep(0); await bad.nodes.open.handlers.click();
    expect(bad.nodes["launch-status"].textContent).not.toContain("private fixture secret");
    expect(bad.nodes.open.disabled).toBe(false); expect(bad.replacements).toHaveLength(0);
  });
  test("pending refresh never resubmits options, expired requests never auto retry", async () => {
    const nonce = "a".repeat(32);
    const r = runtime({}, false, "?open=" + nonce + "&until=" + (Date.now() + 60000)); await Bun.sleep(0);
    expect(r.timers).toHaveLength(1); r.timers[0]!(); expect(r.replacements).toHaveLength(1); expect(r.calls).toEqual([]);
    const expired = runtime({}, false, "?open=" + nonce + "&until=1"); await Bun.sleep(0);
    expect(expired.timers).toEqual([]); expect(expired.calls).toEqual([]);
  });
});
