/* Magpie sandbox launcher: official options bridge + generated public snapshots.
 * No network, browser storage, raw credentials, shell, or invented host API.
 */
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  var bridge = window.magpie;
  var busy = false;
  var settings = window.OHMYAIHUB_SETTINGS;
  var launcher = window.__OH_MY_AIHUB_LAUNCHER__;
  var status = window.__OH_MY_AIHUB_STATUS__;
  var options = window.__OH_MY_AIHUB_OPTIONS__;
  var params = new URLSearchParams(window.location.search);
  var pending = params.get("open");
  var until = Number(params.get("until"));
  function say(text) { $("launch-status").textContent = text; }
  var pairingButtons = [];
  var ready = false;
  function disable(value) {
    $("open").disabled = value; $("save").disabled = value;
    pairingButtons.forEach(function (entry) { entry.button.disabled = value || !entry.check.checked || Date.parse(entry.request.expiresAt) <= Date.now(); });
  }
  function reloadPending(nonce, expiresAt, attempt) {
    window.location.replace(window.location.pathname + "?open=" + encodeURIComponent(nonce) + "&until=" + expiresAt + "&try=" + attempt);
  }
  $("reload").addEventListener("click", function () { window.location.reload(); });
  if (status) {
    var cfg = status.config || {};
    var core = status.easytier || {};
    $("node-status").textContent = cfg.networkName
      ? "已配置网络：" + cfg.networkName + " · 覆盖网核心" + (core.running ? "正在运行" : "未运行")
      : "尚未配置网络。在控制台完成首次设置。";
    $("snapshot-time").textContent = "快照时间：" + (status.generatedAt || "未知") + "（本地记录）";
  }
  var fresh = launcher && Date.now() - Date.parse(launcher.at) < 15000;
  var coherent = !status || !status.plugin || !launcher || Number(status.plugin.pid) === Number(launcher.ownerPid);
  if (!coherent) say("状态来自不同的宿主，请刷新后再打开。每个 Magpie 配置需要独立的插件副本。");
  else if (fresh) say(launcher.message);
  else say("尚未收到新鲜的控制台状态；可点打开发出请求，或刷新等待宿主启动。");
  // The fallback address is public origin only. Never render a ticket, fragment
  // or credential from a snapshot as a link/address.
  var ordinaryOrigin = launcher && typeof launcher.origin === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(launcher.origin) && Number(launcher.origin.split(":")[2]) <= 65535;
  $("console-origin").textContent = coherent && fresh && ordinaryOrigin ? launcher.origin : "等待新鲜的控制台地址，请刷新状态。";
  function node(tag, text, cls) {
    var n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  var pairingList = $("pairing-requests");
  var rows = coherent && fresh && launcher && Array.isArray(launcher.pendingPairings) ? launcher.pendingPairings : [];
  rows.filter(function (r) {
    var expiry = Date.parse(r.expiresAt);
    return /^[a-f0-9]{32}$/.test(r.id) && /^\d{8}$/.test(r.code) && expiry > Date.now() && expiry <= Date.now() + 120000;
  }).slice(0, 8).forEach(function (request) {
    var row = node("div", "", "pairing-request");
    row.appendChild(node("p", "浏览器配对码"));
    row.appendChild(node("code", request.code, "pairing-code"));
    row.appendChild(node("p", "有效期至 " + new Date(request.expiresAt).toLocaleTimeString(), "muted"));
    var label = node("label", "", "row");
    var check = node("input"); check.type = "checkbox";
    label.appendChild(check); label.appendChild(node("span", "我已核对，浏览器上的八位码与此处完全一致"));
    var button = node("button", "批准此浏览器"); button.type = "button"; button.disabled = true;
    pairingButtons.push({ button: button, check: check, request: request });
    check.addEventListener("change", function () { disable(busy || !ready); });
    button.addEventListener("click", async function () {
      var expiry = Date.parse(request.expiresAt);
      if (busy || !ready || !check.checked || expiry <= Date.now()) return;
      busy = true; disable(true);
      try {
        var base = await latest();
        var at = Date.now();
        if (expiry <= at) { $("pairing-status").textContent = "配对请求已过期，请在浏览器重新发起。"; busy = false; disable(false); return; }
        await bridge.options.set(settings.mergeLaunch(base, { approval: {
          id: request.id, code: request.code, issuedAt: at, expiresAt: Math.min(expiry, at + 120000),
        } }));
        $("pairing-status").textContent = "批准已提交，尚未验证。请保持浏览器页面打开，等待新宿主完成配对。";
        window.location.replace(window.location.pathname + "?approval=" + encodeURIComponent(request.id));
      } catch (e) {
        $("pairing-status").textContent = "批准未能确认，请刷新查看状态后重试。";
        busy = false; disable(false);
      }
    });
    row.appendChild(label); row.appendChild(button); pairingList.appendChild(row);
    setTimeout(function () { button.disabled = true; check.disabled = true; }, Math.max(1, Date.parse(request.expiresAt) - Date.now()));
  });
  if (pairingButtons.length) $("pairing-status").textContent = "只有你刚刚发起并核对过配对码的浏览器才能批准。";
  var approvalId = params.get("approval");
  if (approvalId && /^[a-f0-9]{32}$/.test(approvalId)) {
    var observed = coherent && fresh && launcher.approval && launcher.approval.id === approvalId;
    $("pairing-status").textContent = observed && launcher.approval.accepted
      ? "宿主已接受此配对批准。浏览器持有的临时凭据完成验证后才会登录。"
      : "批准已提交；请保持浏览器页面打开。若请求已用完或过期，请在浏览器重新发起并核对新码。";
  }
  if (pending && /^[a-f0-9]{32}$/.test(pending)) {
    var acknowledged = coherent && fresh && launcher.requestNonce === pending && launcher.state !== "attempting";
    if (acknowledged) say(launcher.message);
    else if (until > Date.now() && until <= Date.now() + 125000) {
      say("打开请求已提交，正在等待唯一宿主处理。忙碌的旧宿主可能正在交接；不会启动第二个节点。");
      setTimeout(function () { reloadPending(pending, until, Number(params.get("try") || 0) + 1); }, 2000);
    } else say("尚未确认打开结果。请求已过期，不会自动重试；请重新点打开控制台。");
  }
  async function latest() {
    var value = await bridge.options.get();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  $("open").addEventListener("click", async function () {
    if (busy) return;
    busy = true; disable(true);
    try {
      var base = await latest();
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      var nonce = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      var at = Date.now();
      var request = { nonce: nonce, issuedAt: at, expiresAt: at + 120000 };
      await bridge.options.set(settings.mergeLaunch(base, { request: request }));
      say("打开请求已提交，未验证；正在重新打开插件页以唤醒宿主。");
      // options.set is lazy: reload the hosted HTML to warm the new host.
      reloadPending(nonce, request.expiresAt, 0);
    } catch (e) {
      // Bridge errors may carry raw option values. Never reflect them.
      say("打开请求未能确认。请刷新查看状态后重试，不会自动重复提交。");
      busy = false; disable(false);
    }
  });
  $("save").addEventListener("click", async function () {
    if (busy) return;
    busy = true; disable(true);
    try {
      var base = await latest();
      var wanted = $("auto-open").checked;
      if ((base.consoleLaunch || {}).autoOpen === wanted) {
        $("saved").textContent = "偏好没有变化，未重启宿主。";
        busy = false; disable(false); return;
      }
      await bridge.options.set(settings.mergeLaunch(base, { autoOpen: wanted }));
      $("saved").textContent = "已提交，未验证；正在重新加载宿主。";
      window.location.replace(window.location.pathname);
    } catch (e) {
      $("saved").textContent = "偏好未能保存，请刷新后重试。";
      busy = false; disable(false);
    }
  });
  if (!bridge || !bridge.options) { say("Magpie 官方桥未加载；请从 Magpie 插件页重新打开。"); return; }
  Promise.resolve(bridge.ready).then(latest).then(function (base) {
    $("auto-open").checked = (base.consoleLaunch || {}).autoOpen !== false;
    ready = true;
    disable(!coherent);
    if (options && options.problems && options.problems.length) $("saved").textContent = "旧插件选项含无效设置；打开控制台后检查设置。";
  }).catch(function () { say("无法读取插件选项；请刷新后重试。"); });
})();
