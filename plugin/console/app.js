import { ConsoleError, consumeTicketFragment, createSessionClient, pollState, waitForPairing } from "./session.js";
import { mountProviders, checkLabel } from "./providers.js";
import { mountWallet } from "./wallet.js";
import { mountWalletVault } from "./wallet-vault-ui.js";
import { mountWalletNetwork } from "./wallet-network-ui.js";

// Remove the one-use credential before any asynchronous work or page rendering.
let ticket = consumeTicketFragment(window.location, window.history);

const THEME_KEY = "aihub-console-theme";
const root = document.documentElement;
function storedTheme() {
  try { const value = window.localStorage.getItem(THEME_KEY); return value === "dark" || value === "light" ? value : null; }
  catch { return null; }
}
function rememberedTheme() {
  try { window.localStorage.setItem(THEME_KEY, root.dataset.theme === "dark" ? "dark" : "light"); } catch { /* theme is a preference, never a requirement */ }
}
/** Light is the shipped paper theme; an explicit choice always wins over the OS. */
function applyTheme(value) {
  const dark = value ? value === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#191612" : "#fbf2dc");
  const button = document.getElementById("theme");
  if (button) {
    button.textContent = dark ? "☀" : "◐";
    button.setAttribute("aria-label", dark ? "切换到浅色主题" : "切换到深色主题");
    button.title = button.getAttribute("aria-label");
  }
}

const $ = (id) => document.getElementById(id);
const show = (id, visible) => { const node = $(id); if (node) node.hidden = !visible; };
const setText = (id, value) => { const node = $(id); if (node) node.textContent = value; };
const list = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === "object" ? value : {};
const time = (value) => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "尚无记录";
};
const money = (value) => typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "未读取";

let consoleState = null;
let poller = null;
let busy = false;
let authenticated = false;
let ended = false;
let everAuthenticated = false;
let initialized = false;
let detectionStarted = false;
let lastUpdate = null;
let currentPage = "home";
let pairingController = null;
let pairingCountdown = null;

/** The five product pages. Extra panels are merged into these, never separate nav items. */
const PAGES = {
  home: { label: "首页", sections: ["overview"] },
  discovery: { label: "发现", sections: ["discovery-page"] },
  sharing: { label: "我的共享", sections: ["sharing-panel"] },
  wallet: { label: "钱包", sections: ["wallet-page"] },
  network: { label: "网络", sections: ["settings-panel"] },
};
const ALL_PANELS = ["overview", "discovery-page", "sharing-panel", "wallet-page", "settings-panel"];

function stopPairing() {
  pairingController?.abort();
  pairingController = null;
  if (pairingCountdown !== null) clearInterval(pairingCountdown);
  pairingCountdown = null;
  client.cancelPairing();
  setText("pairing-code", "");
  show("pairing-pending", false);
  if ($("pair-browser")) $("pair-browser").disabled = false;
}

function notice(message = "", tone = "info") {
  setText("notice", message);
  $("notice").className = `notice ${tone}`;
  show("notice", Boolean(message));
}
function connection(label, tone = "") {
  setText("connection", label);
  $("connection").className = `pill ${tone}`;
}
function updated(stale = false) {
  setText("last-update", `${stale ? "连接中断 · " : ""}${lastUpdate ? `读取于 ${time(lastUpdate)}` : "尚未成功读取"}`);
  setText("footer-state", lastUpdate ? `证据时间：${time(lastUpdate)}` : "还没有成功读取本机状态");
}

/**
 * Never-authenticated, expired and explicit logout are different states. A fresh
 * browser must not be told that its session "ended", because it never had one.
 */
function sessionEnded(reason = "expired") {
  ended = true;
  authenticated = false;
  busy = false;
  poller?.stop();
  stopPairing();
  providers.clearSecrets();
  wallet.clearSecrets();
  walletVault.reset();
  walletNetwork.reset();
  client.reset();
  initialized = false;
  lastUpdate = null;
  consoleState = null;
  if ($("network-secret")) $("network-secret").value = "";
  $("settings-form")?.reset();
  show("private-content", false);
  show("session-panel", true);
  show("retry", false);
  show("pairing-entry", true);
  setBusy(false);
  notice();
  const copy = {
    logout: ["已退出本机会话", "需要继续时，请从 Magpie 重新打开控制台。"],
    expired: ["本次会话已结束", "会话过期或已被本机服务结束。请回到 Magpie 的 Oh My AIHub 页面重新打开控制台。"],
    unauthorized: ["这个浏览器还没有访问权限", "请从 Magpie 打开控制台，或在下方向 Magpie 申请配对并批准。"],
    pairing: ["此次配对未完成", "配对码已过期或被取消。需要继续时请重新点击配对此浏览器，并在 Magpie 中核对新的配对码。"],
  }[reason] || ["需要从 Magpie 打开控制台", "请回到 Magpie 的 Oh My AIHub 页面重新打开控制台。"];
  setText("session-title", copy[0]);
  setText("session-detail", copy[1]);
  connection(reason === "logout" ? "已退出" : "未连接", "neutral");
  for (const id of ["nav-home", "nav-discovery", "nav-sharing", "nav-wallet", "nav-network"]) $(id).disabled = true;
}

const client = createSessionClient({ onExpired: () => sessionEnded(everAuthenticated ? "expired" : "unauthorized") });
const providers = mountProviders({ client, getState: () => consoleState, onState: renderState, notice, setBusy, refreshState: () => poller?.refresh() });
const wallet = mountWallet({ client, getState: () => consoleState, onState: renderState, notice, setBusy, refreshState: () => poller?.refresh() });
const walletVault = mountWalletVault({ client, getState: () => consoleState, notice, refreshState: () => poller?.refresh(), windowTarget: window });
const walletNetwork = mountWalletNetwork({ client, getState: () => consoleState, notice, refreshState: () => poller?.refresh() });

function setBusy(value) {
  busy = value;
  for (const id of ["save", "run-checks", "logout", "network-name", "network-peers"]) if ($(id)) $(id).disabled = value;
  setText("save", value ? "正在连接，请稍候…" : "连接网络");
  if ($("run-checks")) $("run-checks").setAttribute("aria-busy", String(value));
  if ($("save")) $("save").setAttribute("aria-busy", String(value));
}

function navigate(page) {
  if (!PAGES[page] || !authenticated) return;
  if (currentPage === "wallet" && page !== "wallet") walletVault.clearSecrets();
  currentPage = page;
  for (const panel of ALL_PANELS) show(panel, PAGES[page].sections.includes(panel));
  for (const name of Object.keys(PAGES)) {
    const button = $("nav-" + name);
    const active = name === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (page === "network") renderNetwork(consoleState);
  if (page === "home") renderHome(consoleState);
  if (page === "wallet") { walletVault.onShow(); void walletNetwork.onShow(); }
  window.scrollTo({ top: 0, behavior: "auto" });
  $("main")?.focus({ preventScroll: true });
}

function fillNetworkForm(state) {
  const c = object(state?.status?.config);
  const node = object(c.peers)[0] || "";
  if ($("network-name")) { $("network-name").value = c.networkName || ""; $("network-name").disabled = false; }
  if ($("network-peers")) $("network-peers").value = Array.isArray(c.peers) ? (c.peers[0] || "") : String(node || "");
  if ($("network-secret")) {
    $("network-secret").value = "";
    $("network-secret").required = !state?.configured;
    $("network-secret").placeholder = state?.configured ? "留空保持当前密钥" : "至少 8 位字符";
  }
  setText("peers-help", state?.configured
    ? "填写一个已知节点即可。留空保持已保存的节点地址。"
    : "填写一个已知节点即可加入。也可以留空，等伙伴连入或稍后补上。");
  setText("network-save-hint", state?.configured
    ? "保存只表示配置已写入；修改网络会重连，正在使用的远程请求可能中断。"
    : "保存只表示配置已写入；是否在线看下方实际结果。");
}

function badge(text, tone = "neutral") {
  const node = document.createElement("span");
  node.className = `pill ${tone}`;
  node.textContent = text;
  return node;
}

function renderChecks(container, checks) {
  const target = $(container);
  if (!target) return;
  target.replaceChildren();
  if (!checks.length) {
    const li = document.createElement("li");
    li.className = "muted check-empty";
    li.textContent = "还没有主动检查记录。自动刷新不会代替安全检查。";
    target.append(li);
    return;
  }
  for (const check of checks) {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = check.ok === true ? "check-icon good" : "check-icon warn";
    icon.textContent = check.ok === true ? "✓" : "!";
    icon.setAttribute("aria-label", check.ok === true ? "通过" : "未通过");
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = checkLabel(check.name || "");
    const detail = document.createElement("small");
    detail.textContent = check.ok === true ? "实际检查已通过" : "需要处理，展开查看检查证据";
    const technical = document.createElement("details");
    technical.className = "check-technical";
    const summary = document.createElement("summary");
    summary.textContent = "查看技术详情";
    const evidence = document.createElement("small");
    evidence.textContent = `${check.name || "check"} · ${check.detail || "没有更多说明"}`;
    technical.append(summary, evidence);
    content.append(title, detail, technical);
    li.append(icon, content);
    target.append(li);
  }
}

/* ---------------- home ---------------- */
function networkSummary(state) {
  const s = object(state.status);
  const network = object(s.network);
  const et = object(s.easytier);
  const c = object(s.config);
  const neighbors = list(network.neighbors).filter((row) => row?.link !== "self");
  const others = neighbors.length ? neighbors : list(et.peers).filter((peer) => peer?.hostname !== c.hostname);
  const states = { unconfigured: "尚未加入网络", starting: "正在连接", online: "已连接", degraded: "部分可用", offline: "未连接", failed: "连接失败", unknown: "尚未验证" };
  if (network.state) {
    return [states[network.state] || "尚未验证", network.summary || `${c.networkName || "私有网络"} · ${others.length} 个其他节点`];
  }
  const readiness = object(s.readiness).state;
  if (!state.configured) return ["尚未加入网络", "在“网络”页填写网络名称、密钥和初始节点后连接。"];
  if (!et.running) return ["未连接", "本机网络引擎没有运行，点“查看网络”看实际原因。"];
  if (readiness === "ready") return ["已连接", `${c.networkName || "私有网络"} · ${others.length} 个其他节点`];
  if (readiness === "blocked") return ["需要处理", list(object(s.readiness).reasons).join("；") || "安全检查没有通过，点“查看网络”。"];
  return ["已加入，等待验证", `${c.networkName || "私有网络"} · ${others.length} 个其他节点；安全检查尚未通过。`];
}

function homeNetwork(state) { return networkSummary(state); }

function homeModels(state) {
  const providers = list(object(state.status).providers);
  const connected = providers.filter((provider) => provider?.status === "connected");
  if (!providers.length) return ["尚未连接", "还没有连接伙伴服务；在“发现”核对身份后申请模型。"];
  if (!connected.length) return ["待确认", `${providers.length} 个伙伴服务未连接；在“发现 → 我的连接”核对。`];
  // Only models actually available through an authorized native Remote provider count.
  const known = connected.reduce((total, provider) => total + (Array.isArray(provider?.models) ? provider.models.length : 0), 0);
  if (known) return [`${known} 个已授权模型`, `${connected.length} 个伙伴服务已连接；只统计已确认可用的模型。`];
  return [`${connected.length} 个伙伴服务已连接`, "模型清单要在“发现 → 我的连接”读取确认；确认前不算可用。"];
}

function homeSharing(state) {
  const c = object(state.status.config);
  const consumers = list(state.status.consumers).filter((consumer) => !consumer.revokedAt);
  const networkCatalog = object(object(state.status.catalog));
  const published = typeof networkCatalog.publishing === "boolean" ? networkCatalog.publishing : object(c.catalog).enabled === true;
  const shared = list(object(c.share).models);
  if (!c.sharingEnabled) return ["未开启", "分享是明确动作；点“查看共享”选择本机模型。"];
  if (!c.sharingActive) return ["已暂停", `${object(c.shareSuspended).reason || "安全条件未满足"}；没有发布模型。`];
  return [
    `正在共享 ${shared.length || 0} 个模型`,
    `${published ? "目录已发布" : "目录尚未发布"} · ${consumers.length} 个已授权伙伴`,
  ];
}

/**
 * Chain deposits are cumulative incoming transfers, not the current token
 * balance. Without a balance read the only honest answer is "尚未查询".
 */
function homeWallet(state) {
  const walletState = object(state.wallet);
  if (walletState.availability !== "available") {
    return { status: "资产余额尚未查询", detail: walletState.error || "钱包记录未初始化；在钱包页初始化或刷新。", credit: [] };
  }
  const consumers = list(object(walletState.view).consumers);
  const credit = consumers
    .filter((consumer) => typeof consumer?.ledger?.balanceUsd === "number")
    .map((consumer) => ({ id: consumer.consumerId, amount: consumer.ledger.balanceUsd }));
  const deposits = list(object(walletState.view).deposits)
    .filter((deposit) => typeof deposit?.creditedUsd === "number" && deposit.creditedUsd > 0)
    .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")));
  const latest = deposits[0];
  return {
    status: latest ? `最近入账 ${money(latest.creditedUsd)}（累计，非余额）` : "资产余额尚未查询",
    detail: latest
      ? `最近一笔充值 ${time(latest.updatedAt)} · 观察器与 RPC 在“网络 → 诊断”`
      : "还没有已确认的充值记录；观察器与 RPC 在“网络 → 诊断”",
    credit,
  };
}

function todos(state) {
  const s = object(state.status);
  const c = object(s.config);
  const items = [];
  const pending = list(state.workflows?.requests).filter((request) => request?.status === "pending");
  if (pending.length) items.push({ text: `${pending.length} 份伙伴申请待审批`, goto: "sharing" });
  if (!s.checksAt) items.push({ text: "还没有运行过安全检查", goto: "network" });
  const readiness = object(s.readiness);
  if (s.checksAt && readiness.state && readiness.state !== "ready") {
    items.push({ text: `就绪检查：${list(readiness.reasons).join("；") || readiness.state}`, goto: "network" });
  }
  if (c.sharingEnabled && c.sharingActive === false) items.push({ text: `共享已暂停：${object(c.shareSuspended).reason || "原因未知"}`, goto: "sharing" });
  if (!c.sharingEnabled && state.configured) items.push({ text: "还没有分享任何本机模型", goto: "sharing" });
  const unverified = list(object(s.catalog).peers).filter((peer) => ["unverified", "identity-changed", "first-seen"].includes(peer?.status));
  if (unverified.length) items.push({ text: `${unverified.length} 个伙伴身份待核对`, goto: "discovery" });
  const operations = list(object(state.wallet).intentOperations).filter((operation) => ["pending", "reserved", "unknown"].includes(operation?.status || operation?.state));
  if (operations.length) items.push({ text: `${operations.length} 个入账申请状态待核对`, goto: "wallet" });
  if (object(s.accounting).uncertain) items.push({ text: `计费检查存在不确定性：${object(s.accounting).uncertainReason || "暂时无法验证"}`, goto: "wallet" });
  return items;
}

function renderHome(state) {
  if (!state || !$("home-network")) return;
  const [network, networkDetail] = homeNetwork(state);
  setText("home-network", network);
  setText("home-network-detail", networkDetail);
  const [models, modelsDetail] = homeModels(state);
  setText("home-models", models);
  setText("home-models-detail", modelsDetail);
  const [sharing, sharingDetail] = homeSharing(state);
  setText("home-sharing", sharing);
  setText("home-sharing-detail", sharingDetail);
  const wallet = homeWallet(state);
  setText("home-wallet-assets", wallet.status);
  setText("home-wallet-detail", wallet.detail);
  const creditList = $("home-wallet-credit");
  creditList.replaceChildren();
  if (!wallet.credit.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "还没有提供者账目";
    creditList.append(li);
  } else {
    for (const entry of wallet.credit.slice(0, 4)) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = entry.id;
      const amount = document.createElement("strong");
      amount.textContent = money(entry.amount);
      li.append(name, amount);
      creditList.append(li);
    }
    if (wallet.credit.length > 4) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = `另有 ${wallet.credit.length - 4} 个伙伴账目，见钱包页`;
      creditList.append(li);
    }
  }
  const listNode = $("home-todos");
  listNode.replaceChildren();
  const entries = todos(state);
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "todo-empty";
    li.textContent = "没有待办。";
    listNode.append(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = entry.text;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = "去处理 →";
    button.addEventListener("click", () => navigate(entry.goto));
    li.append(label, button);
    listNode.append(li);
  }
}

/* ---------------- network ---------------- */
const NEIGHBOR_LINK = { self: "本机", direct: "直连", relay: "中继", unknown: "未知路径" };
const NETWORK_STATE = { unconfigured: ["尚未加入网络", "neutral"], starting: ["正在连接", "info"], online: ["已连接", "good"], degraded: ["部分可用", "warn"], offline: ["未连接", "bad"], failed: ["连接失败", "bad"], unknown: ["尚未验证", "neutral"] };

function renderNetwork(state) {
  if (!state || !$("network-readiness")) return;
  const s = object(state.status);
  const c = object(s.config);
  const et = object(s.easytier);
  const network = object(s.network);
  const evidence = object(network.evidence);
  const core = object(network.core);
  const readiness = object(s.readiness);
  const networkState = typeof network.state === "string" ? network.state : null;
  const [stateLabel, stateTone] = networkState
    ? (NETWORK_STATE[networkState] || ["尚未验证", "neutral"])
    : [readiness.state === "ready" ? "检查通过" : readiness.state === "blocked" ? "需要处理" : "尚未验证", readiness.state === "ready" ? "good" : "neutral"];
  setText("network-readiness", stateLabel);
  $("network-readiness").className = `pill ${stateTone}`;
  setText("network-result-detail", networkState
    ? (network.summary || "本机网络引擎没有返回摘要。")
    : (state.configured
      ? (et.running ? `网络引擎正在运行${et.coreVersion ? ` · EasyTier ${et.coreVersion}` : ""}；每一项都来自本机实际读取。` : "网络引擎当前没有运行；配置已保存不等于在线。")
      : "还没有加入网络；填好左侧三个字段后点“连接网络”。"));

  const node = object(network.thisNode);
  const facts = [
    ["网络名称", node.networkName || c.networkName || "未配置"],
    ["本机节点名", node.hostname || c.hostname || "等待生成"],
    ["虚拟地址", node.virtualIpv4 || c.virtualIpv4 || "未分配"],
    ["网络引擎", core.version || et.coreVersion ? `EasyTier ${core.version || et.coreVersion} · no-TUN` : (core.running ?? et.running ? "运行中" : "未运行")],
    ["目录发布", typeof object(network.catalog).publishing === "boolean" ? (object(network.catalog).publishing ? `已发布 · ${object(network.catalog).modelCount ?? "未知"} 个模型` : "未发布") : (object(c.catalog).enabled ? "已发布" : "未发布")],
    ["状态证据", evidence.readAt ? `${time(evidence.readAt)}${evidence.staleMs ? ` · ${Math.round(evidence.staleMs / 1000)} 秒前` : ""}` : (s.checksAt ? time(s.checksAt) : "尚未读取")],
  ];
  const factList = $("network-facts");
  factList.replaceChildren();
  for (const [label, value] of facts) {
    const div = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value; dd.setAttribute("aria-readonly", "true");
    div.append(dt, dd);
    factList.append(div);
  }

  const neighbors = Array.isArray(network.neighbors)
    ? network.neighbors
    : list(et.peers).map((peer) => ({ hostname: peer.hostname, virtualIpv4: peer.ipv4, latencyMs: peer.latencyMs, tunnel: peer.tunnel || peer.route, link: peer.hostname === c.hostname ? "self" : "unknown", online: null }));
  const peersList = $("network-peers-list");
  peersList.replaceChildren();
  show("network-peers-empty", neighbors.length === 0);
  for (const peer of neighbors) {
    const li = document.createElement("li");
    const self = peer.link === "self";
    const avatar = document.createElement("span");
    avatar.className = "peer-avatar";
    avatar.textContent = (peer.hostname || "N").slice(0, 1).toUpperCase();
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${peer.hostname || "网络节点"}${self ? "（本机）" : ""}`;
    const bits = [
      peer.virtualIpv4 || null,
      peer.tunnel || null,
      NEIGHBOR_LINK[peer.link] || NEIGHBOR_LINK.unknown,
      peer.relayVia ? `经由 ${peer.relayVia}` : null,
      peer.lossRatePct === null || peer.lossRatePct === undefined ? null : `丢包 ${peer.lossRatePct}%`,
    ].filter(Boolean);
    const detail = document.createElement("small");
    detail.textContent = bits.join(" · ") || "未提供地址";
    body.append(title, detail);
    li.append(avatar, body);
    // A missing value is shown as unknown, never as zero or false.
    if (peer.online === true) li.append(badge("在线", "good"));
    else if (peer.online === false) li.append(badge("离线", "warn"));
    if (typeof peer.latencyMs === "number") li.append(badge(`${peer.latencyMs} ms`, "info"));
    peersList.append(li);
  }

  const ports = Array.isArray(network.ports) ? network.ports : [
    { purpose: "listen", label: "网络监听地址", host: c.listenAddr || null, port: null, editable: false, state: c.listenAddr ? "stable" : "unverified" },
    { purpose: "rpc", label: "本机管理端口", host: "127.0.0.1", port: c.rpcPort ?? null, editable: false, state: c.rpcPort ? "stable" : "unverified" },
    { purpose: "catalog", label: "目录发布端口", host: "127.0.0.1", port: object(c.catalog).port ?? null, editable: false, state: object(c.catalog).port ? "stable" : "unverified" },
    { purpose: "catalog-socks", label: "目录查询端口", host: "127.0.0.1", port: object(c.catalog).socksPort ?? null, editable: false, state: object(c.catalog).socksPort ? "stable" : "unverified" },
  ];
  const REACHABILITY = { loopback: "本机回环", overlay: "覆盖网", lan: "局域网", unknown: "范围未知" };
  const PORT_STATE = { stable: "地址稳定", migrated: "已迁移", conflict: "冲突", unverified: "未验证", failed: "失败", unknown: "未知" };
  const portList = $("network-ports");
  portList.replaceChildren();
  for (const port of ports) {
    const div = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = port.label || port.purpose;
    const where = port.host ? `${port.host}${port.port ? `:${port.port}` : ""}` : "未报告";
    const dd = document.createElement("dd");
    const scope = port.reachability && port.reachability !== "unknown" ? ` · ${REACHABILITY[port.reachability] || port.reachability}` : "";
    // The word comes from the read-only projection: never upgraded to "verified" by the UI.
    const stateWord = port.state ? ` · ${PORT_STATE[port.state] || port.state}` : "";
    const readAt = port.verifiedAt ? ` · 读取 ${time(port.verifiedAt)}` : "";
    dd.textContent = `${where}${scope}${stateWord}${readAt}`;
    dd.setAttribute("aria-readonly", "true");
    div.append(dt, dd);
    portList.append(div);
  }

  const checksAt = evidence.readAt || s.checksAt;
  setText("checks-time", checksAt ? `最近读取：${time(checksAt)}` : "尚未运行主动检查");
  renderChecks("checks-list", list(s.checks));
}

/* ---------------- state plumbing ---------------- */
function renderState(value) {
  if (value?.schema !== "ohmyaihub/console/1" || !value.status || typeof value.configured !== "boolean") {
    throw new ConsoleError("控制台状态格式不匹配，请从 Magpie 重新打开。", 502);
  }
  if (ended) return;
  consoleState = value;
  lastUpdate = value.at;
  authenticated = true;
  everAuthenticated = true;
  show("session-panel", false);
  show("pairing-entry", false);
  show("private-content", true);
  show("logout", true);
  for (const id of ["nav-home", "nav-discovery", "nav-sharing", "nav-wallet", "nav-network"]) $(id).disabled = !value.configured;
  $("nav-network").disabled = false;
  providers.render(value);
  wallet.render(value);
  walletVault.render(value);
  walletNetwork.render(value);
  connection("控制台已连接", "good");
  updated();
  if (!busy) notice();
  if (!initialized) {
    initialized = true;
    fillNetworkForm(value);
    navigate(value.configured ? "home" : "network");
  }
  if (currentPage === "home") renderHome(value);
  if (currentPage === "network") renderNetwork(value);
  if (consoleState.configured) show("logout", true);
  detectModels();
}

/** Detection is a local read; it never shares or publishes anything. */
async function detectModels() {
  if (detectionStarted || !consoleState?.configured || !authenticated) return;
  detectionStarted = true;
  try {
    const result = await client.action("share-candidates", {});
    if (!authenticated || !consoleState) return;
    const candidates = result?.candidates || result;
    if (candidates?.models) {
      consoleState = { ...consoleState, shareCandidates: candidates };
      providers.render(consoleState);
      if (currentPage === "home") renderHome(consoleState);
    }
  } catch (error) {
    if (error.status === 404) return; // old backend: sharing page offers an explicit detect button
    detectionStarted = false;
  }
}

function pollError(error) {
  if (ended || error.status === 401) return;
  if (error.status === 403) {
    sessionEnded("expired");
    return;
  }
  connection("连接中断", "warn");
  updated(true);
  notice(`${error.message} 页面保留最后一次成功读取的状态，将自动重连。`, "warn");
}

async function connect() {
  show("retry", false);
  show("pairing-entry", false);
  setText("session-title", "正在连接你的工作空间");
  setText("session-detail", "正在验证本机会话，请稍候。");
  const openingTicket = ticket;
  ticket = null;
  try {
    await client.open(openingTicket);
    if (ended) return;
    poller?.stop();
    poller = pollState(client, { onState: renderState, onError: pollError });
    await poller.start();
    if (!consoleState && !ended) {
      setText("session-title", "正在等待本机服务");
      setText("session-detail", "会话已连接，状态读取暂时失败。正在自动重试。");
    }
  } catch (error) {
    if (ended) return;
    if (error.status === 401 || error.status === 403) {
      sessionEnded(everAuthenticated ? "expired" : "unauthorized");
    } else {
      setText("session-title", "暂时无法连接本机服务");
      setText("session-detail", "确认 Magpie 仍在运行，然后重新连接。若打开凭证未生效，请从 Magpie 重新打开控制台。");
      show("retry", true);
      show("pairing-entry", true);
      connection("连接中断", "warn");
    }
  }
}

async function checks() {
  if (busy || !authenticated) return;
  setBusy(true);
  notice("正在检查本机安全配置与已连接的服务…");
  try {
    const result = await client.action("checks", {});
    if (result?.schema === "ohmyaihub/console/1") renderState(result);
    await poller.refresh();
    if (!ended) notice("检查已完成，结果和检查时间已更新。", "good");
  } catch (error) {
    if (!ended) notice(error.message, "warn");
  } finally { if (!ended) setBusy(false); }
}

/**
 * Three fields, one write. `join-network` is the Phase 10 action; the legacy
 * `configure` accepts the same three fields, so an older backend still works.
 * A 404 for the action itself is the only fallback trigger: nothing ran.
 */
async function saveNetwork({ networkName, networkSecret, initialNode }) {
  const input = { networkName };
  if (networkSecret) input.networkSecret = networkSecret;
  if (initialNode) input.initialNode = initialNode;
  try {
    return await client.action("join-network", input);
  } catch (error) {
    if (error.status !== 404) throw error;
    // An older backend would need several other writes with different defaults
    // (role, ports, listen address). Fail closed instead of writing half a network.
    throw new ConsoleError("当前插件版本不提供一次完成的三字段连接。为避免只写入一半配置，本页没有修改任何设置；请更新 Magpie 中的 Oh My AIHub 插件后重试。", 404);
  }
}

$("settings-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !authenticated) return;
  if (!$("settings-form").reportValidity()) return;
  const networkName = $("network-name").value.trim();
  const networkSecret = $("network-secret").value.trim();
  const initialNode = $("network-peers").value.trim();
  const input = { networkName, networkSecret, initialNode };
  if (!consoleState?.configured && !networkSecret) {
    setText("form-error", "首次加入网络需要填写网络密钥。");
    show("form-error", true);
    return;
  }
  show("form-error", false);
  const wasUnconfigured = !consoleState?.configured;
  setBusy(true);
  notice("正在写入配置并连接私有网络。首次准备网络引擎可能需要几分钟，请保持 Magpie 运行。");
  try {
    const result = await saveNetwork(input);
    if (result?.schema === "ohmyaihub/console/1") renderState(result);
    $("network-secret").value = "";
    await poller.refresh();
    if (ended) return;
    notice("配置已写入。这只表示保存成功；是否在线看下方实际连接结果。", "warn");
    if (consoleState) fillNetworkForm(consoleState);
    // First run only: land on the home blocks, which show the real state.
    if (wasUnconfigured && consoleState?.configured) navigate("home");
  } catch (error) {
    if (!ended) {
      const message = error.status === 0
        ? "连接中断，保存结果暂时不明。请先刷新状态确认，不要立即重复提交。"
        : error.message;
      setText("form-error", message);
      show("form-error", true);
      notice(message, "warn");
      await poller.refresh();
    }
  } finally {
    $("network-secret").value = "";
    if (!ended) setBusy(false);
  }
});

for (const name of Object.keys(PAGES)) $("nav-" + name)?.addEventListener("click", () => navigate(name));
for (const button of document.querySelectorAll("[data-goto]")) {
  button.addEventListener("click", () => navigate(button.dataset.goto));
}
$("run-checks")?.addEventListener("click", checks);
$("network-refresh")?.addEventListener("click", async () => {
  if (busy || !authenticated) return;
  try {
    const result = await client.action("network-refresh", {});
    if (result?.schema === "ohmyaihub/console/1") renderState(result);
    else await poller.refresh();
    if (!ended) notice("已请求刷新本机网络状态。", "good");
  } catch (error) {
    if (error.status === 404) { await poller.refresh(); notice("此版本没有主动刷新动作，状态随自动轮询更新。"); return; }
    if (!ended) notice(error.message, "warn");
  }
});
$("retry")?.addEventListener("click", connect);

for (const [tab, panel] of [["tab-catalog", "discovery-panel"], ["tab-connections", "connections-panel"]]) {
  $(tab)?.addEventListener("click", () => {
    for (const [otherTab, otherPanel] of [["tab-catalog", "discovery-panel"], ["tab-connections", "connections-panel"]]) {
      const selected = otherTab === tab;
      $(otherTab).setAttribute("aria-selected", String(selected));
      show(otherPanel, selected);
    }
    $(panel)?.focus?.({ preventScroll: true });
  });
}

$("theme")?.addEventListener("click", () => {
  applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
  rememberedTheme();
});

$("pair-browser")?.addEventListener("click", async () => {
  if (pairingController || authenticated) return;
  poller?.stop();
  client.reset();
  const controller = new AbortController();
  pairingController = controller;
  $("pair-browser").disabled = true;
  show("retry", false);
  setText("session-title", "正在申请浏览器配对");
  setText("session-detail", "配对需要你在 Magpie 中明确批准。此页不会自动获得管理权限。");
  try {
    const request = await client.requestPairing(controller.signal);
    if (controller.signal.aborted) return;
    show("pairing-entry", false);
    show("pairing-pending", true);
    setText("session-title", "批准后，即可连接工作空间");
    setText("session-detail", "保持此页打开，回到 Magpie 核对配对码。批准后会自动连接。");
    setText("pairing-code", request.code.slice(0, 4) + " " + request.code.slice(4));
    setText("pairing-progress", "等待你在 Magpie 中批准…");
    const countdown = () => {
      const remaining = Math.max(0, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 1000));
      setText("pairing-countdown", `配对码将在 ${remaining} 秒后失效`);
    };
    countdown();
    pairingCountdown = setInterval(countdown, 1000);
    await waitForPairing(client, { expiresAt: request.expiresAt, signal: controller.signal, onWaiting: (reconnecting) => {
      setText("pairing-progress", reconnecting ? "正在等待 Magpie 恢复连接，批准后将继续配对…" : "等待你在 Magpie 中批准…");
    } });
    if (controller.signal.aborted) return;
    stopPairing();
    ended = false;
    initialized = false;
    show("pairing-entry", false);
    setText("session-title", "配对成功，正在读取工作空间");
    setText("session-detail", "已通过 Magpie 批准，正在获取实际状态。");
    poller = pollState(client, { onState: renderState, onError: pollError });
    await poller.start();
  } catch (error) {
    if (controller.signal.aborted) return;
    const detail = error.status === 401
      ? "配对已过期、失效或已被使用。需要继续时，请重新点击配对此浏览器，并在 Magpie 中核对批准。"
      : error.status === 0
        ? "连接中断，未能确认配对请求。请保持 Magpie 运行，稍后重新点击配对此浏览器。"
        : error.message;
    sessionEnded("pairing");
    setText("session-detail", detail);
  }
});

$("pairing-cancel")?.addEventListener("click", () => {
  sessionEnded("pairing");
});

$("logout")?.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  poller?.stop();
  let complete = false;
  try { await client.logout(); complete = true; }
  catch { /* Local state is cleared even if the server cannot be reached. */ }
  sessionEnded("logout");
  if (!complete) setText("session-detail", "未能确认服务器退出。本页已清除会话信息，请关闭此页；需要继续时从 Magpie 重新打开。");
});

window.addEventListener("pagehide", () => { poller?.stop(); stopPairing(); providers.clearSecrets(); wallet.clearSecrets(); walletVault.dispose(); walletNetwork.dispose(); client.dispose(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });

applyTheme(storedTheme());
void connect();
