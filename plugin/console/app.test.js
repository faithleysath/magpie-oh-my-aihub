import { expect, test } from "bun:test";

/**
 * Behavioural test for the shell: a mocked browser (generic DOM records, real
 * module listeners) plus a mocked HTTP client. These assertions are about the
 * request sequence the page actually sends, not about its source text.
 */
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
  remove() {}
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  hasAttribute(key) { return key in this.attributes; }
  addEventListener(event, handler) { (this.handlers[event] ||= []).push(handler); }
  async emit(event, payload = { preventDefault() {} }) { for (const handler of this.handlers[event] || []) await handler(payload); }
  querySelectorAll(selector) {
    const parts = selector.split(",").map((part) => part.trim()).filter(Boolean);
    const matches = (node) => parts.some((part) => node.tagName === part.toUpperCase() || (part.includes("[") && part.replace(/\[.*\]/, "").toUpperCase() === node.tagName));
    return this.descendants().filter(matches);
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  reportValidity() { return true; }
  reset() { for (const node of this.descendants()) if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") { node.value = ""; node.checked = false; } }
  click() { return this.emit("click"); }
}

function browser() {
  // Tests in one process share globals: restore fetch so a later suite is not
  // served by this mock.
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes = new Map();
  const body = new Node("body");
  const documentElement = new Node("html");
  const document = {
    body,
    documentElement,
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node(id.startsWith("nav-") ? "button" : "div")); return nodes.get(id); },
    createElement: (tag) => new Node(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const windowHandlers = {};
  const window = {
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {} },
    scrollTo() {},
    addEventListener: (event, handler) => { (windowHandlers[event] ||= []).push(handler); },
    emit: async (event, payload) => { for (const handler of windowHandlers[event] || []) await handler(payload); },
  };
  globalThis.document = document;
  globalThis.window = window;
  return { document, window, body, nodes, restore() { globalThis.document = previous.document; globalThis.window = previous.window; globalThis.fetch = previous.fetch; } };
}

const unconfigured = () => ({
  schema: "ohmyaihub/console/1", at: "2026-10-31T00:00:00.000Z", configured: false,
  status: { config: { catalog: {}, share: { models: [] } }, easytier: {}, providers: [], consumers: [], catalog: { enabled: false, peers: [] }, readiness: { state: "unknown", reasons: [] }, checks: [] },
  workflows: { requests: [] }, shareCandidates: null,
  wallet: { availability: "uninitialized", registry: { networks: [], assets: [] }, receiving: [], intents: [], intentOperations: [], anomalies: [], view: { chains: [], consumers: [], deposits: [], alerts: [] } },
});
const configured = () => {
  const state = unconfigured();
  state.configured = true;
  state.status.config = { networkName: "studio-ai", hostname: "node-1", peers: ["tcp://198.51.100.7:11010"], sharingEnabled: false, consumingEnabled: true, catalog: { enabled: false } };
  state.status.network = { state: "online", summary: "已连接 0 个其他节点", neighbors: [], ports: [], thisNode: { hostname: "node-1", virtualIpv4: "10.126.126.1", networkName: "studio-ai" }, core: { running: true, version: "2.6.4" }, evidence: { readAt: "2026-10-31T00:00:00.000Z" } };
  // Simulated readback evidence: the home count must come from here, never from
  // a legacy provider.models snapshot or an authorization list.
  state.status.providers = [{
    id: "provider-1", status: "connected", fingerprint: { hostname: "partner-harbor" },
    models: ["legacy/not-callable"],
    modelsEvidence: {
      status: "current", source: "provider-models", readAt: "2026-10-31T00:00:00.000Z",
      models: ["qwen/qwen3-32b", "deepseek/deepseek-chat"], modelCount: 2, callable: "yes",
      identity: { hostname: "partner-harbor", virtualIpv4: null, fingerprint: null },
      generation: 2, keyRef: "provider-keys.json#provider-1", keyGeneration: 1, error: null,
    },
  }];
  state.status.catalog = { ...state.status.catalog, peers: [{ nodeId: "x".repeat(16), status: "verified", quote: { models: [{ id: "authorized/but-not-called" }] } }] };
  return state;
};

/** Records every HTTP call and answers with a scripted response per path. */
function http(routes) {
  const calls = [];
  const fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    const route = routes(path, options);
    const status = route.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => route.json };
  };
  return { fetch, calls };
}

let actionStatus = 404;

async function mount(state) {
  const env = browser();
  let current = state;
  const routes = (path) => {
    if (path === "/ui/session") return { json: { csrf: "c".repeat(32), instance: "test", expiresAt: "2099-01-01T00:00:00.000Z" } };
    if (path === "/ui/api/state") return { json: current };
    if (path.startsWith("/ui/api/action/")) {
      if (actionStatus !== 200) return { status: actionStatus, json: { error: "action_not_allowed" } };
      current = configured();
      return { json: { result: current } };
    }
    return { status: 404, json: { error: "not_found" } };
  };
  const server = http(routes);
  globalThis.fetch = server.fetch;
  await import(new URL("./app.js", import.meta.url).href);
  // Let the initial session + first state read finish.
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...env, ...server, nodes: env.nodes };
}

const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const actions = (world) => world.calls.filter((call) => call.path.startsWith("/ui/api/action/")).map((call) => call.path.slice("/ui/api/action/".length));

test("three-field connect is atomic: one join-network, no configure fallback, then a real render", async () => {
  actionStatus = 404;
  const world = await mount(unconfigured());
  try {
    world.nodes.get("network-name").value = "studio-ai";
    world.nodes.get("network-secret").value = "correct-horse-battery";
    world.nodes.get("network-peers").value = "tcp://198.51.100.7:11010";
    await world.nodes.get("settings-form").emit("submit");
    await flush();
    expect(actions(world)).toEqual(["join-network"]);
    expect(world.calls.find((call) => call.path === "/ui/api/action/join-network")?.body).toEqual({
      networkName: "studio-ai",
      networkSecret: "correct-horse-battery",
      initialNode: "tcp://198.51.100.7:11010",
    });
    expect(world.nodes.get("form-error").textContent).toContain("更新 Magpie");
    expect(world.nodes.get("form-error").textContent).toContain("没有修改任何设置");
    expect(world.nodes.get("network-secret").value).toBe("");

    // The same page, once the backend has the action: one write, then home.
    actionStatus = 200;
    world.nodes.get("network-name").value = "studio-ai";
    world.nodes.get("network-secret").value = "correct-horse-battery";
    await world.nodes.get("settings-form").emit("submit");
    await flush();
    // The extra read is automatic model detection for the home page.
    expect(actions(world)).toEqual(["join-network", "join-network", "share-candidates"]);
    expect(world.calls.filter((call) => call.path.includes("configure"))).toHaveLength(0);
    expect(world.nodes.get("overview").hidden).toBe(false);
    expect(world.nodes.get("settings-panel").hidden).toBe(true);
    expect(world.nodes.get("nav-home").attributes["aria-current"]).toBe("page");
    expect(world.nodes.get("home-network").textContent).toBe("已连接");
    // Available models come from current readback evidence only.
    expect(world.nodes.get("home-models").textContent).toBe("2 个当前可见模型");
    expect(world.nodes.get("home-models-detail").textContent).toContain("最近真实读回");
    expect(world.nodes.get("home-models-detail").textContent).toContain("推理额度与 429 另计");
    expect(world.nodes.get("home-models-evidence").hidden).toBe(false);
    const listText = world.nodes.get("home-models-list").textContent;
    expect(listText).toContain("partner-harbor");
    expect(listText).toContain("qwen/qwen3-32b");
    expect(listText).toContain("deepseek/deepseek-chat");
    expect(listText).not.toContain("legacy/not-callable");
    expect(listText).not.toContain("authorized/but-not-called");
  } finally {
    await world.window.emit("pagehide");
    world.restore();
  }
});
