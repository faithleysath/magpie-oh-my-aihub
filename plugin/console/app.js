import { ConsoleError, consumeTicketFragment, createSessionClient, pollState, waitForPairing } from "./session.js";
import { mountProviders, checkLabel } from "./providers.js";
import { mountWallet } from "./wallet.js";

// Remove the one-use credential before any asynchronous work or page rendering.
let ticket = consumeTicketFragment(window.location, window.history);
const $ = (id) => document.getElementById(id);
const show = (id, visible) => { $(id).hidden = !visible; };
const setText = (id, value) => { $(id).textContent = value; };
const list = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === "object" ? value : {};
const time = (value) => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "尚无记录";
};
let consoleState = null;
let poller = null;
let step = 0;
let firstRun = true;
let editing = false;
let initialized = false;
let busy = false;
let authenticated = false;
let ended = false;
let lastUpdate = null;
const changed = new Set();
const inputs = ["sharing", "consuming", "network-name", "network-secret", "network-peers", "accept-incoming", "network-listen", "network-rpc-port", "network-catalog-port", "network-socks-port"];
let pairingController = null;
let pairingCountdown = null;
function stopPairing() {
  pairingController?.abort();
  pairingController = null;
  if (pairingCountdown !== null) clearInterval(pairingCountdown);
  pairingCountdown = null;
  client.cancelPairing();
  setText("pairing-code", "");
  show("pairing-pending", false);
  $("pair-browser").disabled = false;
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
  setText("last-update", `${stale ? "连接中断 · " : ""}最后更新：${lastUpdate ? time(lastUpdate) : "尚未成功读取"}`);
}
function sessionEnded(title = "会话已结束", detail = "请回到 Magpie 的 Oh My AIHub 页面，重新打开控制台。") {
  ended = true;
  authenticated = false;
  busy = false;
  poller?.stop();
  stopPairing();
  providers.clearSecrets();
  wallet.clearSecrets();
  client.reset();
  initialized = false;
  lastUpdate = null;
  changed.clear();
  consoleState = null;
  $("network-secret").value = "";
  $("settings-form").reset();
  show("private-content", false);
  show("session-panel", true);
  show("retry", false);
  show("logout", false);
  show("pairing-entry", true);
  setBusy(false);
  notice();
  setText("session-title", title);
  setText("session-detail", detail);
  connection("未连接", "neutral");
  for (const name of ["overview", "settings", "discovery", "sharing", "connections", "wallet", "accounting"]) $("nav-" + name).disabled = true;
}
const client = createSessionClient({ onExpired: () => sessionEnded() });
const providers = mountProviders({ client, getState: () => consoleState, onState: renderState, notice, setBusy, refreshState: () => poller?.refresh() });
const wallet = mountWallet({ client, getState: () => consoleState, onState: renderState, notice, setBusy, refreshState: () => poller?.refresh() });

function setBusy(value) {
  busy = value;
  for (const id of ["save", "run-checks", "wizard-run-checks", "refresh", "logout", "wizard-next", "wizard-back", "wizard-done", ...inputs]) $(id).disabled = value;
  setText("save", value ? "正在保存，请稍候…" : "保存并连接网络 →");
  $("network-listen").disabled = value || !$("accept-incoming").checked;
  for (const id of ["run-checks", "wizard-run-checks"]) $(id).setAttribute("aria-busy", String(value));
}
function navigate(target) {
  if (!authenticated) return;
  editing = target === "settings";
  const labels = { overview: "总览", discovery: "发现模型", sharing: "我的共享", connections: "我的连接", wallet: "测试网钱包", accounting: "用量与账单", settings: firstRun ? "开始设置" : "网络与设置" };
  show("overview", target === "overview");
  for (const name of ["settings", "discovery", "sharing", "connections", "wallet", "accounting"]) show(name + "-panel", name === target);
  setText("breadcrumb", labels[target]);
  for (const name of Object.keys(labels)) {
    const active = name === target;
    $("nav-" + name).classList.toggle("active", active);
    if (active) $("nav-" + name).setAttribute("aria-current", "page");
    else $("nav-" + name).removeAttribute("aria-current");
  }
  if (editing) renderWizard();
}
function renderWizard() {
  show("stepper", firstRun);
  setText("wizard-eyebrow", firstRun ? "LET’S GET CONNECTED" : "MAKE IT YOURS");
  setText("wizard-title", firstRun ? "欢迎来到你的 AI 工作空间" : "网络与设置");
  setText("wizard-subtitle", firstRun ? "几个简单步骤，建立属于你的私有 AI 网络。" : "调整设备能力与私有网络，未改动的配置会保持不变。");
  for (const [index, id] of ["environment-step", "roles-step", "network-step", "safety-step"].entries()) show(id, firstRun ? step === index : index === 1 || index === 2);
  document.querySelectorAll("#stepper li").forEach((node, index) => {
    node.classList.toggle("current", index === step);
    node.classList.toggle("complete", index < step);
    if (index === step) node.setAttribute("aria-current", "step");
    else node.removeAttribute("aria-current");
  });
  show("wizard-back", firstRun && step > 0 && step < 3);
  show("wizard-next", firstRun && step < 2);
  show("save", !firstRun || step === 2);
  show("wizard-done", firstRun && step === 3);
  show("step-caption", firstRun);
  setText("step-caption", `第 ${step + 1} 步，共 4 步`);
  setText("wizard-next", step === 0 ? "继续选择能力 →" : "继续连接网络 →");
  $("network-secret").required = !consoleState?.configured;
  $("network-secret").placeholder = consoleState?.configured ? "留空保留已保存的密码" : "至少 8 位字符";
  setText("secret-help", consoleState?.configured ? "已保存的密码不会回显。留空保持不变，只在需要更换时输入。" : "只用于加入私有网络，不是 Magpie 访问密钥。");
}
function fillForm(state) {
  const c = object(state.status.config);
  $("sharing").checked = c.sharingEnabled === true;
  $("consuming").checked = c.consumingEnabled === true;
  $("network-name").value = c.networkName || "";
  $("network-peers").value = list(c.peers).join("\n");
  $("network-secret").value = "";
  $("accept-incoming").checked = Boolean(c.listenAddr);
  $("network-listen").value = c.listenAddr || "";
  $("network-listen").disabled = !$("accept-incoming").checked;
  $("network-listen").required = $("accept-incoming").checked;
  $("network-rpc-port").value = c.rpcPort || "";
  $("network-catalog-port").value = object(c.catalog).port || "";
  $("network-socks-port").value = object(c.catalog).socksPort || "";
  changed.clear();
}
function badge(text, tone = "neutral") {
  const node = document.createElement("span");
  node.className = `pill ${tone}`;
  node.textContent = text;
  return node;
}
function summary(container, status) {
  const target = $(container);
  target.replaceChildren();
  const readiness = object(status.readiness);
  const labels = { ready: "检查通过", degraded: "部分可用", blocked: "需要处理", unknown: "尚未验证" };
  const tones = { ready: "good", degraded: "warn", blocked: "warn", unknown: "neutral" };
  target.append(badge(labels[readiness.state] || "尚未验证", tones[readiness.state] || "neutral"));
  const reasons = list(readiness.reasons);
  const p = document.createElement("p");
  p.className = "muted safety-detail";
  p.textContent = reasons.length ? reasons.join("；") : "点击运行检查，获取本机安全配置和已连接服务的实际结果。";
  target.append(p);
  const c = object(status.config);
  const accounting = object(status.accounting);
  const warnings = [
    c.shareSuspended?.reason ? `共享已暂停：${c.shareSuspended.reason}` : null,
    accounting.uncertain ? `计费检查存在不确定性：${accounting.uncertainReason || "暂时无法验证"}` : null,
    object(status.easytier).lastError,
  ].filter(Boolean);
  for (const warning of warnings) {
    const line = document.createElement("p");
    line.className = "inline-warning";
    line.textContent = warning;
    target.append(line);
  }
}
function renderChecks(container, checks) {
  const target = $(container);
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
function renderState(value) {
  if (value?.schema !== "ohmyaihub/console/1" || !value.status || typeof value.configured !== "boolean") throw new ConsoleError("控制台状态格式不匹配，请从 Magpie 重新打开。", 502);
  if (ended) return;
  consoleState = value;
  lastUpdate = value.at;
  const s = value.status;
  const c = object(s.config);
  const et = object(s.easytier);
  authenticated = true;
  show("session-panel", false);
  show("pairing-entry", false);
  show("private-content", true);
  show("logout", true);
  $("nav-settings").disabled = false;
  for (const name of ["overview", "discovery", "sharing", "connections", "wallet", "accounting"]) $("nav-" + name).disabled = !value.configured;
  providers.render(value);
  wallet.render(value);
  connection("本机已连接", "good");
  updated();
  if (!busy) notice();
  setText("environment-magpie", object(s.magpie).version || "版本未提供");
  setText("environment-plugin", object(s.plugin).version || "版本未提供");
  setText("environment-engine", et.coreVersion || (et.running ? "运行中" : "配置后启动"));
  setText("network-title", c.networkName || "你的私有网络");
  setText("network-detail", c.hostname ? `${c.hostname} · ${c.virtualIpv4 || "等待分配网络地址"}` : "连接属于你的私有 AI 网络。");
  const readinessLabels = { ready: "检查通过", degraded: "部分可用", blocked: "需要处理", unknown: "尚未验证" };
  const ready = object(s.readiness).state;
  setText("readiness", readinessLabels[ready] || "尚未验证");
  $("readiness").className = `pill ${ready === "ready" ? "good" : ready === "unknown" ? "neutral" : "warn"}`;
  const capabilities = $("capabilities");
  capabilities.replaceChildren(badge(c.sharingEnabled ? "↗ 共享能力已开启" : "共享未开启"), badge(c.consumingEnabled ? "↙ 使用能力已开启" : "使用未开启"));
  setText("engine-status", et.running ? "运行中" : "未运行");
  setText("engine-detail", `EasyTier ${et.coreVersion || ""} · no-TUN`);
  const peers = list(et.peers);
  setText("peer-count", String(peers.length));
  setText("share-status", c.sharingEnabled ? (c.sharingActive ? "已启用" : "已暂停") : "未启用");
  setText("share-detail", c.sharingEnabled ? (c.sharingActive ? "共享发布中 · 访问仍需授权" : "安全条件未满足，未发布共享") : "只共享你允许的能力");
  setText("consume-status", c.consumingEnabled ? "已启用" : "未启用");
  setText("consume-detail", `${list(s.providers).length} 个已配置远程服务`);
  summary("safety-summary", s);
  summary("wizard-safety", s);
  renderChecks("checks-list", list(s.checks));
  renderChecks("wizard-checks", list(s.checks));
  setText("checks-time", s.checksAt ? `检查时间：${time(s.checksAt)}` : "尚未运行主动检查");
  $("peers-list").replaceChildren();
  show("peers-empty", peers.length === 0);
  for (const peer of peers) {
    const li = document.createElement("li");
    const avatar = document.createElement("span");
    avatar.className = "peer-avatar";
    avatar.textContent = (peer.hostname || "N").slice(0, 1).toUpperCase();
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = peer.hostname || "网络节点";
    const detail = document.createElement("small");
    detail.textContent = [peer.ipv4, peer.tunnel || peer.route].filter(Boolean).join(" · ");
    body.append(title, detail);
    li.append(avatar, body);
    if (peer.latencyMs !== undefined && peer.latencyMs !== null) li.append(badge(`${peer.latencyMs} ms`));
    $("peers-list").append(li);
  }
  if (!initialized) {
    initialized = true;
    firstRun = !value.configured;
    fillForm(value);
    navigate(firstRun ? "settings" : "overview");
  }
  if (editing) renderWizard();
}
function pollError(error) {
  if (ended || error.status === 401) return;
  if (error.status === 403) {
    sessionEnded("需要重新打开控制台", "当前会话无法继续，请回到 Magpie 重新打开。");
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
      sessionEnded("请从 Magpie 打开控制台", "打开凭证已失效或会话已结束。请回到 Magpie 的 Oh My AIHub 页面，重新打开控制台。");
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
function formInput() {
  const out = {};
  const c = object(consoleState?.status.config);
  if (!consoleState.configured || changed.has("sharing")) out.sharingEnabled = $("sharing").checked;
  if (!consoleState.configured || changed.has("consuming")) out.consumingEnabled = $("consuming").checked;
  if (!consoleState.configured || changed.has("network-name")) out.networkName = $("network-name").value.trim();
  const secret = $("network-secret").value.trim();
  if (secret) out.networkSecret = secret;
  if (!consoleState.configured || changed.has("network-peers")) out.peers = [...new Set($("network-peers").value.split(/[\s,]+/).filter(Boolean))];
  if (!consoleState.configured || c.secureMode !== true) out.secureMode = true;
  if (changed.has("accept-incoming") || changed.has("network-listen")) out.listenAddr = $("accept-incoming").checked ? $("network-listen").value.trim() : null;
  for (const [id, key] of [["network-rpc-port", "rpcPort"], ["network-catalog-port", "catalogPort"], ["network-socks-port", "catalogSocksPort"]]) {
    if (changed.has(id) && $(id).value.trim()) out[key] = Number($(id).value);
  }
  return out;
}
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !authenticated || (firstRun && step !== 2)) return;
  if (!$("settings-form").reportValidity()) return;
  if (!$("network-peers").value.trim() && !$("accept-incoming").checked) {
    setText("form-error", "请填写至少一个连接节点，或在高级网络设置中开启接受其他网络节点连接并填写监听地址。");
    show("form-error", true);
    $("advanced-network").open = true;
    return;
  }
  const input = formInput();
  if (!Object.keys(input).length) { notice("没有需要保存的改动。"); return; }
  show("form-error", false);
  setBusy(true);
  notice("正在保存配置并连接私有网络。首次准备网络引擎可能需要约 3 分钟，请保持 Magpie 运行。");
  try {
    const result = await client.action("configure", input);
    if (result?.schema === "ohmyaihub/console/1") renderState(result);
    $("network-secret").value = "";
    delete input.networkSecret;
    changed.clear();
    await poller.refresh();
    if (ended) return;
    if (consoleState?.configured) {
      fillForm(consoleState);
      if (firstRun) step = 3;
      renderWizard();
      notice("配置已保存。请查看安全状态，确认网络是否就绪。", "good");
    } else notice("操作已返回，正在等待最新配置状态。", "warn");
  } catch (error) {
    if (!ended) {
      const message = error.status === 0 ? "连接中断，保存结果暂时不明。请先刷新状态确认，不要立即重复提交。" : error.message;
      setText("form-error", message);
      show("form-error", true);
      notice(message, "warn");
      await poller.refresh();
    }
  } finally {
    $("network-secret").value = "";
    delete input.networkSecret;
    if (!ended) setBusy(false);
  }
});
for (const id of inputs) $(id).addEventListener("input", () => changed.add(id));
$("accept-incoming").addEventListener("change", () => {
  $("network-listen").disabled = !$("accept-incoming").checked;
  $("network-listen").required = $("accept-incoming").checked;
});
$("wizard-next").addEventListener("click", () => { if (!busy) { step = Math.min(2, step + 1); renderWizard(); } });
$("wizard-back").addEventListener("click", () => { if (!busy) { step = Math.max(0, step - 1); renderWizard(); } });
$("wizard-done").addEventListener("click", () => { firstRun = false; navigate("overview"); });
for (const name of ["overview", "discovery", "sharing", "connections", "wallet", "accounting"]) $("nav-" + name).addEventListener("click", () => navigate(name));
for (const id of ["nav-settings", "edit-network"]) $(id).addEventListener("click", () => navigate("settings"));
for (const id of ["run-checks", "wizard-run-checks"]) $(id).addEventListener("click", checks);
$("refresh").addEventListener("click", () => { if (!busy) poller?.refresh(); });
$("retry").addEventListener("click", connect);
$("pair-browser").addEventListener("click", async () => {
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
    const detail = error.status === 401 ? "配对已过期、失效或已被使用。需要继续时，请重新点击配对此浏览器，并在 Magpie 中核对批准。" : error.status === 0 ? "连接中断，未能确认配对请求。请保持 Magpie 运行，稍后重新点击配对此浏览器。" : error.message;
    sessionEnded("此次配对未完成", detail);
  }
});
$("pairing-cancel").addEventListener("click", () => {
  sessionEnded("已取消此次配对", "需要继续时，请重新点击配对此浏览器，并在 Magpie 中核对新的配对码。原请求会自动过期。");
});
$("logout").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  poller?.stop();
  let complete = false;
  try { await client.logout(); complete = true; }
  catch { /* Local state is cleared even if the server cannot be reached. */ }
  sessionEnded(complete ? "已退出本机会话" : "本页已锁定", complete ? "需要继续时，请从 Magpie 重新打开控制台。" : "未能确认服务器退出。本页已清除会话信息，请关闭此页；需要继续时从 Magpie 重新打开。");
});
$("theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  $("theme").setAttribute("aria-label", dark ? "切换深色模式" : "切换浅色模式");
});
window.addEventListener("pagehide", () => { poller?.stop(); stopPairing(); providers.clearSecrets(); wallet.clearSecrets(); client.dispose(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
void connect();
