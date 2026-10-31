/* Provider/consumer workflows. Every action goes through the existing session
 * client. Remote strings are text nodes; secrets exist only in an explicit dialog. */
const items = (value) => Array.isArray(value) ? value : [];
const record = (value) => value && typeof value === "object" ? value : {};
const money = (value) => typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "未读取";
const knownCap = (value) => typeof value === "number" && Number.isFinite(value);
const safeCap = (value) => knownCap(value) && value > 0;
export function capLabel(value) {
  if (!knownCap(value)) return "未知（尚未验证额度上限）";
  return value <= 0 ? "无限制 / 不安全配置" : money(value);
}
export function priceText(pricing) {
  if (!pricing || ![pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return "价格不完整，不能授权";
  return `输入 $${pricing.input} / 输出 $${pricing.output} · 每百万 token${items(pricing.tiers).length ? " · 有阶梯价格，查看详情" : ""}`;
}
export function validCap(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0.0001 && amount <= 1_000_000 && Math.abs(Math.round(amount * 1e4) / 1e4 - amount) < 1e-9;
}
export function selectableModels(models, selected) {
  const chosen = new Set(selected);
  return items(models).filter((model) => chosen.has(model.id) && model.completePrice !== false && priceText(model.pricing) !== "价格不完整，不能授权").map((model) => model.id);
}
/**
 * A peer is a network neighbour and a catalogue publisher at the same time, so
 * "online" never implies "offering". Mirrors service.catalogQuoteUsability: a
 * withdrawn catalogue or an expired quote cannot be requested or connected.
 */
export function peerQuoteUsability(peer, now = Date.now()) {
  if (!peer || peer.status === "self") return { usable: false, detail: "self" };
  if (peer.online !== true) return { usable: false, detail: "offline" };
  if (peer.catalog === "withdrawn" || peer.status === "no-catalog") return { usable: false, detail: "withdrawn" };
  if (peer.catalog !== "published" || !peer.quote) return { usable: false, detail: "no-quote" };
  if (peer.status === "identity-changed") return { usable: false, detail: "identity-changed" };
  const expires = peer.quoteExpiresAt ? Date.parse(peer.quoteExpiresAt) : NaN;
  // `quoteFresh` comes from the service's own clock; the expiry timestamp is a
  // fallback for snapshots written by an older plugin.
  const fresh = typeof peer.quoteFresh === "boolean" ? peer.quoteFresh : Number.isFinite(expires) && expires > now;
  if (!fresh) return { usable: false, detail: "expired" };
  if (peer.status === "stale") return { usable: false, detail: "stale" };
  return { usable: true, detail: null };
}

const QUOTE_UNUSABLE_TEXT = {
  offline: "伙伴当前离线；目录里的是上次看到的内容，不能申请。",
  withdrawn: "伙伴已停用共享或撤下目录；旧模型与报价不再可申请，刷新后会消失。",
  "no-quote": "伙伴还没有发布可验证的目录报价，不能申请。",
  expired: "伙伴的报价已过期；请刷新目录并核对当前报价后再申请。",
  "identity-changed": "伙伴身份已变化，确认新指纹前不能申请。",
  stale: "伙伴的报价已过期或出现回退，请刷新目录并确认最新报价。",
};

export function peerAcceptance(peer) {
  return { nodeId: peer.nodeId || peer.quote?.node?.id, fingerprint: peer.pendingFingerprint || peer.identity?.fingerprint || peer.quote?.identity?.fingerprint, quoteHash: peer.quoteHash || peer.quote?.contentHash };
}
export function peerNextStep(status, peer = null, presence = null) {
  if (presence && presence.capability?.providesModels === false && (peer?.catalog === "withdrawn" || status === "no-catalog")) {
    return "这个伙伴在网络中，但尚未共享模型；现在没有可申请的模型。";
  }
  if (peer && peer.catalog === "withdrawn") {
    return "伙伴网络在线，但已停止共享或撤下目录；旧模型与报价不能再申请，刷新后这一步会消失。";
  }
  const guidance = {
    unverified: "请先通过可信渠道核对完整指纹，再点击“核对并接受身份”。",
    "identity-changed": "伙伴身份已变化。请联系对方核对新指纹，再点击“核对新身份”；确认前不能申请或连接。",
    verified: "身份已在本机接受，可以选择模型生成申请，或使用伙伴交付的授权连接。",
    connected: "此伙伴已有连接，可在“我的连接”中检查模型、密钥与额度。",
    stale: "报价已过期或发生回退，请刷新目录并向伙伴确认最新报价。",
    unreachable: "暂时无法读取伙伴目录，请检查网络连接后刷新。",
    offline: "伙伴当前离线，请等待对方上线后刷新目录。",
    "no-catalog": "伙伴尚未发布模型目录，请联系对方在“我的共享”中发布。",
    conflict: "伙伴网络地址存在冲突，请与对方确认各自的网络设置。",
  };
  return guidance[status] || "请刷新目录，确认伙伴的当前状态后继续。";
}
export function checkLabel(name) {
  const labels = { configured: "私有网络配置", "core-running": "网络引擎", acl: "网络访问规则", "sharing-suspended": "共享安全保护", "gateway-key-required": "未授权访问拒绝", "mapped-cidr": "共享专用地址", "published-gateway": "模型网关发布", "shared-models-native-only": "仅共享本机模型", "share-guard-cadence": "共享保护巡检", "catalog-published": "模型目录发布", "catalog-forward-port": "目录访问规则", "catalog-quote": "签名目录与报价", "catalog-identity": "目录身份签名", "catalog-socks5-loopback": "本机目录查询", "catalog-peers": "伙伴目录身份", "forwards-match": "远程连接归属", "no-orphan-forwards": "过期连接清理" };
  if (labels[name]) return labels[name];
  if (/^provider:.+:forward$/.test(name)) return "伙伴网络连接";
  if (/^provider:.+:registered$/.test(name)) return "Magpie 远程服务注册";
  if (/^provider:.+:status$/.test(name)) return "伙伴服务状态";
  return "服务检查";
}
export function parseTransportDocument(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 64 * 1024) throw new Error("文件内容超过 64 KB，请使用 AIHub 导出的申请或授权文件。");
  let document;
  try { document = JSON.parse(text); } catch { throw new Error("文件内容无法识别，请选择 AIHub 导出的申请或授权文件。"); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("请选择有效的 AIHub 文件。");
  return document;
}
const statusNames = { connected: "已连接", verified: "身份已接受", unverified: "身份待确认", "identity-changed": "身份已变化", stale: "报价已过期", unreachable: "暂时无法连接", "no-catalog": "未发布目录", conflict: "地址冲突", offline: "离线", self: "本机", pending: "待审批", approved: "已批准", rejected: "已拒绝", paused: "已暂停", auth: "授权失效", error: "需要处理", unknown: "尚未验证" };

/**
 * Home "available models" is a real-readback question, never an authorization
 * question, and a 200 model list is not a promise that inference quota remains.
 * Only a current, unexpired evidence record for the current key/identity is
 * shown; quota is reported separately (native 429 / unknown / not read).
 */
/** Mirrors the backend's 5 minute evidence TTL; the client only narrows trust. */
const EVIDENCE_TTL_MS = 5 * 60 * 1000;

function quotaEvidence(provider) {
  const limit = record(provider?.limit);
  const knownCap = typeof limit.costLimit === "number" && Number.isFinite(limit.costLimit);
  const left = typeof limit.costLeft === "number" && Number.isFinite(limit.costLeft);
  if (limit.spent === true) return { state: "spent", text: "额度已用尽（原生 429）" };
  if (left && left <= 0) return { state: "spent", text: "额度已用尽（原生 429）" };
  if (!knownCap) return { state: "unknown", text: "额度待确认（未读取原生限额）" };
  return { state: "ok", text: `额度上限 ${capLabel(limit.costLimit)} · 已用 ${money(limit.cost)} · 剩余 ${money(limit.costLeft)}` };
}

export function modelEvidenceSummary(providers, now = Date.now()) {
  const rows = items(providers).map((provider) => {
    const evidence = record(provider?.modelsEvidence);
    const hostname = provider?.fingerprint?.hostname || provider?.hostname || provider?.id || "伙伴服务";
    // The backend promises a 5 minute TTL. A record can only be trusted when
    // both timestamps exist, are ordered, are not in the future and fit that
    // window; everything else stays unknown rather than guessing freshness.
    const readMs = typeof evidence.readAt === "string" ? Date.parse(evidence.readAt) : NaN;
    const expMs = typeof evidence.expiresAt === "string" ? Date.parse(evidence.expiresAt) : NaN;
    let freshness = "unknown";
    if (Number.isFinite(readMs) && readMs <= now && Number.isFinite(expMs) && expMs >= readMs) {
      if (expMs - readMs > EVIDENCE_TTL_MS) freshness = "unknown";
      else freshness = expMs <= now ? "expired" : "fresh";
    }
    return {
      hostname,
      evidence,
      freshness,
      status: typeof provider?.status === "string" ? provider.status : "unknown",
      quota: quotaEvidence(provider),
    };
  });
  if (!rows.length) {
    return { state: "none", count: 0, providers: 0, entries: [], label: "尚未连接", detail: "还没有连接伙伴服务；在“发现”核对身份后申请模型。" };
  }
  const eligible = rows.filter((row) => row.evidence.status === "current" && row.freshness === "fresh" && row.evidence.callable === "yes" && typeof row.evidence.modelCount === "number" && Number.isFinite(row.evidence.modelCount) && row.evidence.modelCount >= 0);
  // A paused, disabled, degraded or identity-mismatched connection keeps its
  // historical list for diagnosis, but it is not a current usable model source.
  const usable = eligible.filter((row) => row.status === "connected");
  const inactive = eligible.filter((row) => row.status !== "connected");
  const entry = (row, counted) => ({
    hostname: row.hostname,
    count: row.evidence.modelCount,
    models: items(row.evidence.models).filter((model) => typeof model === "string"),
    readAt: typeof row.evidence.readAt === "string" ? row.evidence.readAt : null,
    source: typeof row.evidence.source === "string" ? row.evidence.source : null,
    quota: row.quota.state,
    quotaText: row.quota.text,
    counted,
    status: row.status,
  });
  if (usable.length) {
    const count = usable.reduce((total, row) => total + row.evidence.modelCount, 0);
    const spent = usable.some((row) => row.quota.state === "spent");
    const unknownQuota = usable.some((row) => row.quota.state === "unknown");
    const quotaNote = spent ? "；有伙伴额度已用尽（原生 429）" : unknownQuota ? "；额度待确认" : "";
    const pausedNote = inactive.length ? `；另有 ${inactive.length} 个伙伴连接已暂停或降级，仅诊断` : "";
    if (count === 0) {
      return {
        state: "empty", count: 0, providers: usable.length,
        entries: [...usable.map((row) => entry(row, true)), ...inactive.map((row) => entry(row, false))],
        label: "已连接，但没有发现模型",
        detail: "真实读回成功但清单为空；请在共享方核对模型范围与额度，或稍后重新读取。",
      };
    }
    return {
      state: "current",
      count,
      providers: usable.length,
      label: `${count} 个当前可见模型`,
      detail: `${usable.length} 个伙伴服务 · 最近真实读回；推理额度与 429 另计，不代表可调用${quotaNote}${pausedNote}`,
      entries: [...usable.map((row) => entry(row, true)), ...inactive.map((row) => entry(row, false))],
    };
  }
  if (inactive.length) {
    return {
      state: "inactive",
      count: 0,
      providers: inactive.length,
      entries: inactive.map((row) => entry(row, false)),
      label: "0 个当前可见模型",
      detail: "伙伴连接已暂停、降级或身份不匹配；恢复连接并重新读取后再计入，历史清单只作诊断。",
    };
  }
  const denied = rows.some((row) => row.evidence.callable === "no" && row.evidence.status !== "stale");
  if (denied) {
    const stale = rows.some((row) => row.evidence.status === "stale" || row.freshness === "expired");
    return {
      state: "denied",
      count: 0,
      providers: rows.length,
      entries: [],
      label: stale ? "模型清单已过期" : "授权未通过",
      detail: stale
        ? "到「发现 → 我的连接」重新读取可用模型；过期清单不算可用。"
        : "最近一次读回被拒绝（401/撤销）；到「发现 → 我的连接」核验密钥与额度，不会用 0 代替。",
    };
  }
  const stale = rows.some((row) => row.evidence.status === "stale" || row.freshness === "expired");
  return {
    state: stale ? "stale" : "unknown",
    count: 0,
    providers: rows.length,
    entries: [],
    label: stale ? "模型清单已过期" : "尚未确认",
    detail: stale
      ? "到「发现 → 我的连接」重新读取可用模型；过期清单不算可用。"
      : "到「发现 → 我的连接」读取可用模型；读取前不会计入可用数。",
  };
}
// Zero-file P2P states (B assembly contract, draft). Labels only; no secrets.
const P2P_INBOUND_LABELS = { pending: "待批准", "waiting-tofu": "需要核对身份", approved: "已批准", rejected: "已拒绝", expired: "已过期" };
const P2P_OUTBOUND_LABELS = { pending: "等待批准", "awaiting-approval": "等待批准", approved: "正在交付", delivering: "正在交付", connected: "已连接", "action-needed": "需要处理", rejected: "已拒绝", expired: "已过期", revoked: "已撤销" };
const P2P_DELIVERY_LABELS = { none: "未交付", queued: "排队中", delivering: "正在交付", delivered: "已交付", uncertain: "结果未知", revoked: "已撤销" };
const P2P_CONNECTION_LABELS = { connected: "已连接", registering: "正在注册", "action-needed": "需要处理", disconnected: "已离线", revoked: "已撤销" };
const P2P_TOFU_LABELS = { accepted: "身份已核对", pending: "首次连接，需要核对身份", changed: "身份已变化，必须重新核对" };

export function mountProviders({ client, getState, onState, notice, setBusy, refreshState }) {
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const button = (text, callback, primary = false) => {
    const node = el("button", text, `button ${primary ? "primary" : "secondary"}`);
    node.type = "button";
    node.addEventListener("click", callback);
    return node;
  };
  const paragraph = (text) => el("p", text, "muted");
  const empty = (title, text) => {
    const node = el("div", null, "workflow-empty");
    node.append(el("h3", title), paragraph(text));
    return node;
  };
  const field = (title, type = "text", value = "") => {
    const label = el("label", null, "field");
    const input = el("input");
    input.type = type;
    input.value = value;
    if (type === "password") { input.autocomplete = "new-password"; input.setAttribute("data-1p-ignore", ""); input.setAttribute("data-bwignore", ""); }
    label.append(el("span", title), input);
    return { label, input };
  };
  const checkbox = (text, checked = false) => {
    const label = el("label", null, "workflow-check");
    const input = el("input"); input.type = "checkbox"; input.checked = checked;
    label.append(input, el("span", text));
    return { label, input };
  };
  const details = (title, entries) => {
    const node = el("details", null, "workflow-details");
    node.append(el("summary", title));
    for (const [label, value] of entries) {
      const line = el("div"); line.append(el("strong", label), el("span", value ?? "未提供")); node.append(line);
    }
    return node;
  };
  const priceValue = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `$${value} / 百万 token` : "未提供";
  function priceDetails(model) {
    const pricing = model.pricing;
    const entries = [
      ["模型", model.id], ["输入 / 输出", priceText(pricing)],
      ["缓存读取", priceValue(pricing?.cacheRead)],
      ["缓存写入", priceValue(pricing?.cacheWrite)],
    ];
    if (pricing && Object.hasOwn(pricing, "cacheWrite1h")) entries.push(["一小时缓存写入", priceValue(pricing.cacheWrite1h)]);
    entries.push(["价格单位", pricing?.unit ?? "未提供"], ["价格来源", ({ "magpie-gateway": "Magpie 网关（magpie-gateway）", "magpie-settings": "Magpie 模型设置（magpie-settings）" })[pricing?.source] || pricing?.source || "未提供"]);
    for (const [index, tier] of items(pricing?.tiers).entries()) {
      const name = `阶梯 ${index + 1}`;
      entries.push(
        [`${name} · 门槛`, typeof tier.above === "number" && Number.isFinite(tier.above) ? `超过 ${tier.above} token` : "未提供"],
        [`${name} · 输入`, priceValue(tier.input)],
        [`${name} · 输出`, priceValue(tier.output)],
        [`${name} · 缓存读取`, priceValue(tier.cacheRead)],
        [`${name} · 缓存写入`, priceValue(tier.cacheWrite)],
        [`${name} · 一小时缓存写入`, priceValue(tier.cacheWrite1h)],
      );
    }
    entries.push(
      ["上下文", model.contextWindow ?? "未提供"], ["最大输出", model.maxOutputTokens ?? "未提供"],
      ["图像输入", model.images === true ? "支持" : model.images === false ? "不支持" : "未提供"],
      ["调用接口", items(model.gatewayApis).join("、") || "未提供"],
      ["推理级别", items(model.reasoningLevels).join("、") || "未提供"],
      ["价格锁定", "否（priceLocked: false），以 Magpie 原生计费为准"],
    );
    return details("价格与能力详情", entries);
  }
  const badge = (text, tone = "neutral") => el("span", text, `pill ${tone}`);
  const roots = Object.fromEntries(["discovery", "sharing", "connections"].map((name) => [name, document.getElementById(name + "-panel")]));
  let state = null;
  let working = false;
  let generation = 0;
  let candidates = null;
  let selectedModels = new Set();
  let modelDirty = false;
  let publicationDirty = false;
  let currentDialog = null;
  let secretDocument = null;
  const urls = new Set();
  const caches = new Map();
  const search = { discovery: "", sharing: "" };

  const dialog = el("dialog", null, "workflow-dialog");
  const dialogHeader = el("div", null, "section-heading");
  const dialogTitle = el("h2"); dialogTitle.id = "workflow-dialog-title";
  dialog.setAttribute("aria-labelledby", dialogTitle.id);
  dialogHeader.append(dialogTitle, button("关闭", () => closeDialog()));
  const dialogContent = el("div", null, "dialog-content");
  const dialogError = el("p", null, "form-error"); dialogError.hidden = true; dialogError.setAttribute("role", "alert");
  dialog.append(dialogHeader, dialogContent, dialogError);
  document.body.append(dialog);
  function closeDialog() {
    generation++;
    if (secretDocument) delete secretDocument.key;
    secretDocument = null;
    dialog.querySelectorAll("input,textarea").forEach((node) => { node.value = ""; });
    dialogContent.replaceChildren();
    dialogError.textContent = "";
    dialogError.hidden = true;
    currentDialog = null;
    if (dialog.open) dialog.close();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  // Native close events are queued: an older event may arrive after this same
  // dialog has already opened the next workflow step. Keep that new step intact.
  dialog.addEventListener("close", () => { if (!dialog.open && currentDialog) closeDialog(); });
  function openDialog(title, build) {
    closeDialog();
    currentDialog = title;
    dialogTitle.textContent = title;
    build(dialogContent);
    dialog.showModal();
  }
  function download(document, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2) + "\n"], { type: "application/json" }));
    urls.add(url);
    const link = el("a"); link.href = url; link.download = filename; link.rel = "noopener"; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
  }
  async function run(name, input = {}, success, { refresh = true } = {}) {
    if (working || !getState()?.configured) return;
    const expectedGeneration = generation;
    working = true;
    setBusy(true);
    const controls = [...Object.values(roots), dialog].flatMap((root) => [...root.querySelectorAll("button,input,textarea,select")]).map((node) => ({ node, disabled: node.disabled }));
    controls.forEach(({ node }) => { node.disabled = true; });
    dialogError.hidden = true;
    notice("正在处理，请稍候…");
    try {
      const result = await client.action(name, input);
      if (generation !== expectedGeneration || !getState()) return;
      if (result?.schema === "ohmyaihub/console/1") onState(result);
      if (success) await success(result);
      if (refresh && getState()) await refreshState();
      if (getState()) notice("操作已完成，状态已更新。", "good");
      return result;
    } catch (error) {
      if (generation !== expectedGeneration || !getState()) return;
      const message = error.status === 0 ? "连接中断，操作结果暂时不明。请刷新状态确认后再决定，系统不会自动重复提交。" : error.message;
      notice(message, "warn");
      if (dialog.open) { dialogError.textContent = message; dialogError.hidden = false; }
    } finally {
      controls.forEach(({ node, disabled }) => { node.disabled = disabled; });
      working = false;
      updateSelectionControls();
      if (getState()) setBusy(false);
    }
  }
  function confirmAction(title, explanation, action, input, confirmText = "确认继续") {
    openDialog(title, (root) => {
      root.append(paragraph(explanation));
      const agree = checkbox(confirmText);
      const submit = button(title, () => { if (agree.input.checked) void run(action, input, () => closeDialog()); }, true);
      submit.disabled = true;
      agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      root.append(agree.label, submit);
    });
  }
  function toolbar(title) { const node = el("div", null, "section-heading"); node.append(el("h2", title)); return node; }
  function searchInput(kind, container, rerender) {
    const input = el("input", null, "workflow-search"); input.type = "search"; input.placeholder = kind === "discovery" ? "搜索模型或伙伴" : "搜索本机模型"; input.setAttribute("aria-label", input.placeholder);
    input.addEventListener("input", () => { search[kind] = input.value; rerender(); }); container.append(input);
  }

  // Discovery and consumer request export.
  const discoveryIntro = el("div", null, "card workflow-section");
  const discoveryControls = toolbar("伙伴目录");
  const discoverToggle = button("开启目录发现", () => void run("catalog-discover", { enabled: !state.status.config.catalog?.discoveryEnabled }));
  discoveryControls.append(button("刷新目录", () => void run("catalog-refresh")), discoverToggle);
  discoveryIntro.append(discoveryControls, paragraph("目录只用于展示报价，申请不会自动产生账户或扣费。首次使用前，请通过可信渠道核对对方的完整身份指纹。"));
  searchInput("discovery", discoveryIntro, renderDiscovery);
  const discoveryList = el("div", null, "workflow-card-grid");
  roots.discovery.append(discoveryIntro, discoveryList);
  function renderDiscovery() {
    if (!state) return;
    // Control-only neighbours have no signed catalogue node id yet, so the
    // presence index also carries the overlay hostname.
    const presence = new Map();
    for (const row of items(p2pOf().presence)) {
      if (row.nodeId) presence.set(row.nodeId, row);
      if (row.hostname) presence.set(row.hostname, row);
    }
    discoverToggle.textContent = state.status.config.catalog?.discoveryEnabled ? "关闭目录发现" : "开启目录发现";
    discoveryList.replaceChildren();
    const peers = items(state.status.catalog?.peers).filter((peer) => peer.status !== "self");
    const query = search.discovery.toLowerCase().trim();
    const matches = peers.filter((peer) => !query || [peer.hostname, peer.quote?.node?.displayName, ...items(peer.quote?.models).map((model) => model.displayName || model.id)].join(" ").toLowerCase().includes(query));
    if (!matches.length) {
      discoveryList.append(empty(peers.length ? "没有找到匹配的模型" : "伙伴还没有出现在目录中", peers.length ? "尝试其他模型名称或伙伴名称。" : "开启目录发现并刷新；伙伴需要启用共享并发布目录。"));
      return;
    }
    for (const peer of matches) {
      const card = el("article", null, "card workflow-section");
      const presenceEntry = presence.get(peer.nodeId) || presence.get(peer.hostname) || null;
      const top = toolbar(peer.quote?.node?.displayName || peer.hostname || "网络伙伴");
      top.append(badge(statusNames[peer.status] || "尚未验证", peer.status === "verified" || peer.status === "connected" ? "good" : "warn"));
      const catalogFact = peer.catalog === "withdrawn"
        ? "已撤下目录"
        : peer.catalog === "published" && peer.quote
          ? `${items(peer.quote.models).length} 个模型`
          : "目录未读取";
      const networkFact = peer.online === true ? "网络在线" : peer.online === false ? "网络离线" : "在线状态未确认";
      card.append(top, paragraph(`${catalogFact} · ${networkFact} · ${peer.quote?.node?.contact || "未提供联系方式"}`));
      const acceptance = peerAcceptance(peer);
      card.append(details("查看完整身份与报价", [["身份指纹", acceptance.fingerprint], ["报价指纹", acceptance.quoteHash], ["报价版本", peer.quote?.publication?.version], ["更新时间", peer.quote?.publication?.updatedAt], ["身份说明", "自签名 TOFU，仅证明同一密钥签名，不代表现实身份。"], ["价格锁定", "否（priceLocked: false）"]]));
      card.append(paragraph(peerNextStep(peer.status, peer, presenceEntry)));
      if (peer.detail) card.append(details("查看目录技术详情", [["原始诊断", peer.detail]]));
      const models = el("div", null, "discovery-models");
      for (const model of items(peer.quote?.models).filter((model) => !query || [model.id, model.displayName, peer.hostname, peer.quote?.node?.displayName].join(" ").toLowerCase().includes(query))) {
        const row = el("div", null, "discovery-model"); row.append(el("strong", model.displayName || model.id), paragraph(priceText(model.pricing)), priceDetails(model)); models.append(row);
      }
      card.append(models);
      const actions = el("div", null, "workflow-actions");
      if (acceptance.fingerprint && peer.nodeId && !["verified", "connected"].includes(peer.status)) actions.append(button(peer.status === "identity-changed" ? "核对新身份" : "核对并接受身份", () => trustPeer(peer)));
      if (peer.quote && peer.nodeId) {
        // Zero-file requests need a signed, fresh presence with control ready.
        // Catalog trust alone is not enough, and no port is ever user-entered.
        const presenceFresh = Boolean(presenceEntry) && (!presenceEntry.expiresAt || Date.parse(presenceEntry.expiresAt) > Date.now());
        const security = presenceEntry ? presenceSecurity(presenceEntry, peer) : { signature: "unknown", tofu: "pending" };
        const endpoint = record(presenceEntry?.endpoint);
        const endpointTrusted = Boolean(endpoint.host) && Number.isInteger(endpoint.controlPort) && endpoint.controlPort >= 1 && endpoint.controlPort <= 65535;
        const controlReady = Boolean(presenceEntry) && security.signature === "valid" && endpointTrusted && presenceFresh && presenceEntry.capability?.control === true;
        const providesModels = presenceEntry ? presenceEntry.capability?.providesModels !== false : false;
        const online = peer.online === true;
        const trusted = ["verified", "connected"].includes(peer.status) && online;
        // No zero-file request without a published, unexpired quote: a peer that
        // stopped sharing stays a neighbour and must not offer its old models.
        const quote = peerQuoteUsability(peer);
        const allowed = controlReady && providesModels && online && quote.usable;
        const needsIdentity = Boolean(presenceEntry) && security.tofu !== "accepted";
        const request = button(needsIdentity ? "核对身份并申请使用" : "申请使用（无文件）", () => requestUsage(peer));
        request.disabled = !allowed;
        actions.append(request);
        if (!presenceEntry) actions.append(paragraph("此伙伴还没有可用的签名控制通道；无文件申请暂不可用，可使用下方高级应急文件流程。"));
        else if (!quote.usable && QUOTE_UNUSABLE_TEXT[quote.detail]) actions.append(paragraph(QUOTE_UNUSABLE_TEXT[quote.detail]));
        else if (security.signature === "invalid") actions.append(paragraph("此伙伴的签名无效，不能发起申请。"));
        else if (security.signature !== "valid") actions.append(paragraph("此伙伴的签名状态未知；确认签名前不会发送申请。"));
        else if (!endpointTrusted) actions.append(paragraph("此伙伴的控制端点不可信或未报告；无文件申请暂不可用。"));
        else if (!presenceFresh) actions.append(paragraph("此伙伴的签名控制通道已过期；等待新的签名 presence 后再申请。"));
        else if (presenceEntry.capability?.control !== true) actions.append(paragraph("此伙伴没有开放控制通道；无文件申请暂不可用。"));
        else if (!providesModels) actions.append(paragraph("此伙伴可请求，但不提供模型；无文件申请需要伙伴先分享模型。"));
        else if (needsIdentity) actions.append(paragraph("首次连接或身份已变化：可以先核对完整指纹，服务确认后再发送申请。"));
        if (presenceEntry) {
          actions.append(details("控制通道与能力（只读）", [
            ["控制端点", presenceEntry.endpoint?.host ? `${presenceEntry.endpoint.host}${presenceEntry.endpoint.controlPort ? `:${presenceEntry.endpoint.controlPort}` : ""}` : "未报告"],
            ["覆盖网地址", presenceEntry.endpoint?.mappedCidr || "未报告"],
            ["共享状态", presenceEntry.capability?.sharing || "未报告"],
            ["提供模型", presenceEntry.capability?.providesModels === true ? "是" : presenceEntry.capability?.providesModels === false ? "否" : "未报告"],
            ["presence 到期", presenceEntry.expiresAt ? when(presenceEntry.expiresAt) : "未报告"],
          ]));
        }
        const legacy = el("details", null, "workflow-details");
        legacy.append(el("summary", "高级应急：旧版文件流程"));
        const usable = peerQuoteUsability(peer);
        const fileRequest = button("选择模型并生成文件", () => requestConnection(peer));
        const connect = button("已有密钥，连接此伙伴", () => connectPeer(peer));
        fileRequest.disabled = !trusted || !usable.usable;
        connect.disabled = !trusted || !usable.usable;
        if (!usable.usable && QUOTE_UNUSABLE_TEXT[usable.detail]) legacy.append(paragraph(QUOTE_UNUSABLE_TEXT[usable.detail]));
        const legacyActions = el("div", null, "workflow-actions"); legacyActions.append(fileRequest, connect);
        legacy.append(paragraph("旧版需要下载/导入 JSON 或手工交付密钥；仅在没有可用的无文件连接时使用。"), legacyActions);
        card.append(legacy);
      } else if (presenceEntry) {
        // Signed control-only presence: the node is here and reachable, but it
        // offers no models. Nothing here can request or connect.
        const security = presenceSecurity(presenceEntry, peer);
        actions.append(paragraph("控制通道签名有效；对方没有开放模型。"));
        if (security.tofu !== "accepted") {
          const trust = button(security.tofu === "changed" ? "核对新身份" : "核对身份", async () => {
            await run("trust-peer", { nodeId: presenceEntry.nodeId, fingerprint: presenceEntry.fingerprint }, () => notice("已记录这个伙伴的身份指纹。", "good"));
          });
          actions.append(trust, paragraph(`完整指纹：${presenceEntry.fingerprint}`));
        }
        actions.append(details("控制通道与能力（只读）", [
          ["控制端点", presenceEntry.endpoint?.host ? `${presenceEntry.endpoint.host}${presenceEntry.endpoint.controlPort ? `:${presenceEntry.endpoint.controlPort}` : ""}` : "未报告"],
          ["覆盖网地址", presenceEntry.endpoint?.mappedCidr || "未报告"],
          ["共享状态", presenceEntry.capability?.sharing || "未报告"],
          ["提供模型", presenceEntry.capability?.providesModels === true ? "是" : "否"],
          ["身份", P2P_TOFU_LABELS[security.tofu] || "尚未确认"],
          ["presence 到期", presenceEntry.expiresAt ? when(presenceEntry.expiresAt) : "未报告"],
        ]));
      }
      card.append(actions); discoveryList.append(card);
    }
  }
  function trustPeer(peer) {
    const acceptance = peerAcceptance(peer);
    openDialog("核对伙伴身份", (root) => {
      root.append(paragraph("请通过你信任的联系方式向伙伴核对以下完整指纹。目录签名本身不能证明现实身份。"), el("code", acceptance.fingerprint, "fingerprint"));
      if (peer.status === "identity-changed") root.append(el("p", "此伙伴的身份已变化。确认原因并重新核对后，再接受新身份。", "inline-warning"));
      const agree = checkbox("我已通过可信渠道核对上述完整指纹，并接受此身份");
      const submit = button("接受此身份", () => { if (agree.input.checked) void run("trust-peer", { nodeId: acceptance.nodeId, fingerprint: acceptance.fingerprint }, () => closeDialog()); }, true);
      submit.disabled = true; agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      root.append(agree.label, submit);
    });
  }
  function modelChoices(root, models, selected = []) {
    const choices = [];
    for (const model of items(models)) {
      const value = typeof model === "string" ? { id: model } : model;
      const choice = checkbox(value.displayName ? `${value.displayName} · ${value.id}` : value.id, selected.includes(value.id));
      choice.input.dataset.modelId = value.id;
      choice.input.disabled = value.completePrice === false;
      const row = el("div", null, "choice-row"); row.append(choice.label);
      if (value.pricing !== undefined) row.append(paragraph(priceText(value.pricing)));
      root.append(row); choices.push({ id: value.id, input: choice.input });
    }
    return () => choices.filter((choice) => choice.input.checked && !choice.input.disabled).map((choice) => choice.id);
  }
  function requestConnection(peer) {
    const acceptance = peerAcceptance(peer);
    openDialog("选择想使用的模型", (root) => {
      root.append(paragraph("申请会绑定你当前看到的伙伴身份、报价和模型。下载申请文件后，将它发送给共享方审批。"));
      const getModels = modelChoices(root, items(peer.quote.models).map((model) => ({ ...model, completePrice: priceText(model.pricing) !== "价格不完整，不能授权" })));
      const agree = checkbox("我已查看模型价格；价格未锁定（priceLocked: false）");
      root.append(agree.label, button("生成连接申请", () => {
        if (!agree.input.checked || !getModels().length) { dialogError.textContent = "请选择至少一个有完整价格的模型，并确认报价。"; dialogError.hidden = false; return; }
        void run("connection-request", { ...acceptance, models: getModels() }, (result) => {
          const document = result.document || result;
          openDialog("连接申请已生成", (body) => {
            body.append(paragraph("将下载的申请文件发送给共享方。对方导入并批准后，会另行交付授权文件；此申请不包含密钥，也不会自动扣费。"), button("下载连接申请", () => download(document, "aihub-connection-request.json"), true));
          });
        });
      }, true));
    });
  }
  function connectPeer(peer) {
    const acceptance = peerAcceptance(peer);
    openDialog("使用伙伴交付的密钥连接", (root) => {
      root.append(paragraph("请优先导入共享方提供的授权文件；只有在对方单独交付密钥时才使用此入口。连接将绑定当前已接受的身份和报价。"));
      const key = field("伙伴提供的 Gateway Key", "password"); key.input.required = true;
      const agree = checkbox("我已确认密钥来自上述伙伴，并接受当前报价");
      root.append(key.label, agree.label, button("连接此伙伴", () => {
        if (!key.input.value.trim() || !agree.input.checked) { dialogError.textContent = "请填写密钥并确认伙伴和报价。"; dialogError.hidden = false; return; }
        const input = { ...acceptance, key: key.input.value.trim() };
        key.input.value = "";
        void run("catalog-connect", input, () => closeDialog()).finally(() => { delete input.key; });
      }, true));
    });
  }

  // Sharing policy, catalogue publication and manual imported approvals.
  // One explicit action: choose detected native models, confirm once, and the
  // service re-checks price/ACL then enables sharing and publishes the catalogue.
  const shareIntro = el("div", null, "card workflow-section");
  const shareTop = toolbar("检测到的本机模型");
  const detectButton = button("重新检测", () => loadCandidates());
  const stopShareButton = button("停止共享", () => stopSharing());
  const modelSave = button("分享这些模型", () => confirmShare(), true);
  shareTop.append(detectButton, modelSave, stopShareButton);
  const modelsList = el("div", null, "shared-model-list");
  shareIntro.append(shareTop, paragraph("自动读取本机 Magpie 中的原生模型。勾选后点一次“分享这些模型”，服务会再核对价格与共享策略，然后把这份清单发布到网络目录。"));
  searchInput("sharing", shareIntro, renderModels);
  shareIntro.append(modelsList, paragraph("价格未锁定（priceLocked: false）。模型价格变化时，现有授权可能暂停并要求重新确认。"));
  const publication = el("details", null, "workflow-details");
  publication.append(el("summary", "目录展示信息（分享时一起保存）"));
  const displayName = field("展示名称"); displayName.input.maxLength = 120;
  const contact = field("联系说明"); contact.input.maxLength = 200;
  const minimum = field("建议申请额度（USD）", "number"); minimum.input.min = "0.0001"; minimum.input.step = "0.0001";
  const pubFields = el("div", null, "form-grid"); pubFields.append(displayName.label, contact.label, minimum.label);
  const pubSave = el("button", "保存展示信息", "button secondary"); pubSave.type = "button";
  pubSave.addEventListener("click", () => { if (state) void run("catalog-settings", catalogueOptions(), () => { publicationDirty = false; }); });
  const pubActions = el("div", null, "workflow-actions"); pubActions.append(pubSave);
  publication.append(pubFields, paragraph("这些字段只改目录展示文案，不会分享模型或发布目录；分享仍要点“分享这些模型”。"), pubActions);
  for (const input of [displayName.input, contact.input, minimum.input]) input.addEventListener("input", () => { publicationDirty = true; });
  const ownIdentity = el("div", null, "card workflow-section");
  ownIdentity.append(toolbar("我的目录身份"), paragraph("让伙伴在其“发现”页面展开身份信息，与你通过可信渠道逐字核对完整指纹。以下均为公开目录信息。"));
  const identityContent = el("div");
  ownIdentity.append(identityContent);
  function renderOwnIdentity() {
    identityContent.replaceChildren();
    const quote = state?.status.catalog?.quote;
    const fingerprint = quote?.identity?.fingerprint;
    if (!fingerprint) {
      identityContent.append(empty("尚未生成目录身份", "分享模型后，这里会显示可供伙伴核对的完整身份和报价。"));
      return;
    }
    identityContent.append(details("查看完整目录身份与报价", [["完整身份指纹", fingerprint], ["完整报价指纹", quote.contentHash], ["完整价格版本", quote.billing?.priceVersion], ["目录版本", quote.version ?? quote.publication?.version], ["更新时间", quote.updatedAt ?? quote.publication?.updatedAt], ["发布时间", quote.publishedAt ?? quote.publication?.publishedAt], ["身份签名", "自签名 Ed" + "25519；只证明同一密钥签署，不代表现实身份。"], ["价格未锁定", "是（priceLocked: false）；伙伴看到的价格可能随 Magpie 设置变化。"]]));
    const actions = el("div", null, "workflow-actions");
    actions.append(button("复制完整身份指纹", async () => {
      try { await navigator.clipboard.writeText(fingerprint); notice("完整身份指纹已复制，请通过可信渠道交给伙伴核对。", "good"); }
      catch { notice("浏览器未允许复制，请展开目录身份并选择完整指纹进行复制。", "warn"); }
    }));
    identityContent.append(actions);
  }
  // Zero-file requests and approvals (B assembly draft contract).
  const p2pRequestsCard = el("div", null, "card workflow-section");
  p2pRequestsCard.append(toolbar("来自网络的使用请求"));
  const p2pInboundList = el("div", null, "workflow-list"); p2pRequestsCard.append(p2pInboundList);
  const p2pApprovalsCard = el("div", null, "card workflow-section");
  p2pApprovalsCard.append(toolbar("网络授权与交付"));
  const p2pApprovalsList = el("div", null, "workflow-list"); p2pApprovalsCard.append(p2pApprovalsList);
  const requestCard = el("div", null, "card workflow-section"); requestCard.append(toolbar("连接申请"));
  const importRequest = button("导入伙伴的申请文件", () => importDocument("request"));
  requestCard.append(paragraph("导入仅用于核对；每份申请都需要你明确选择额度和模型，再手动批准。"), importRequest);
  const requestsList = el("div", null, "workflow-list"); requestCard.append(requestsList);
  const consumersCard = el("div", null, "card workflow-section"); consumersCard.append(toolbar("已授权的伙伴"));
  const consumersList = el("div", null, "workflow-list"); consumersCard.append(consumersList);
  const legacyRequests = el("details", null, "advanced-recovery");
  legacyRequests.append(el("summary", "高级应急：旧版申请文件"));
  legacyRequests.append(requestCard);
  roots.sharing.append(p2pRequestsCard, p2pApprovalsCard, shareIntro, publication, ownIdentity, legacyRequests, consumersCard);
  function policySelection(models) {
    const policy = state?.status.config.share?.models;
    return items(models).filter((model) => model.completePrice && (Array.isArray(policy) ? policy.some((rule) => rule === "*" || rule === model.id || (rule.endsWith("/*") && model.id.startsWith(rule.slice(0, -1)))) : model.allowedByPolicy)).map((model) => model.id);
  }
  async function loadCandidates() {
    return run("share-candidates", {}, (result) => {
      candidates = result.candidates || result;
      if (!modelDirty) selectedModels = new Set(policySelection(candidates.models));
      renderModels();
    }, { refresh: false });
  }
  function catalogueOptions() {
    const input = { displayName: displayName.input.value.trim() || null, contact: contact.input.value.trim() || null };
    if (minimum.input.value) input.minTopUpUsd = Number(minimum.input.value);
    return input;
  }
  /**
   * An older plugin would need several separate writes (models, sharing, publish)
   * with different defaults and no rollback. Sharing must be all-or-nothing, so
   * the UI refuses instead of leaving a half-published catalogue.
   */
  function outdated(action) {
    return Object.assign(new Error(`当前插件版本不提供「${action}」，无法保证一次完成。为避免只公开一部分模型或留下不一致的共享状态，本页没有做任何修改；请更新 Magpie 中的 Oh My AIHub 插件后重试。`), { status: 404 });
  }
  function updateSelectionControls() {
    const chosen = selectableModels(candidates?.models, [...selectedModels]);
    // One place decides whether the single share action is available: no
    // selection, only unpriced models, or a running action all disable it.
    modelSave.disabled = working || chosen.length === 0;
    stopShareButton.hidden = state?.status?.config?.sharingEnabled !== true;
  }
  function confirmShare() {
    if (working) return;
    const chosen = selectableModels(candidates?.models, [...selectedModels]);
    if (!chosen.length) { notice("请至少勾选一个有完整价格的本机模型。", "warn"); return; }
    const names = chosen.map((id) => items(candidates?.models).find((model) => model.id === id)?.displayName || id);
    openDialog("分享这些模型", (root) => {
      root.append(paragraph(`将要分享 ${chosen.length} 个本机模型：${names.join("、")}。确认后服务会再次核对价格与共享策略，然后开启共享并把这份清单发布到网络目录；访问仍需伙伴逐一获得你的授权。`));
      const agree = checkbox("我确认分享这些模型，并把模型与价格发布到目录");
      const submit = button("确认分享", () => { if (agree.input.checked) void runShare(chosen); }, true);
      submit.disabled = true;
      agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      root.append(agree.label, submit);
    });
  }
  async function runShare(models) {
    if (working || !state) return;
    working = true; setBusy(true); notice("正在核对并分享所选模型…");
    try {
      try {
        await client.action("share-native-models", { models, confirm: true });
      } catch (error) {
        if (error.status === 404) throw outdated("share-native-models");
        throw error;
      }
      modelDirty = false;
      closeDialog();
      await refreshState();
      notice("已分享所选模型；目录发布状态以下方真实状态为准。", "good");
    } catch (error) {
      const message = error.status === 0
        ? "连接中断，分享结果暂时不明。请刷新状态确认后再决定，系统不会自动重复提交。"
        : error.message;
      notice(message, "warn");
      if (dialog.open) { dialogError.textContent = message; dialogError.hidden = false; }
    } finally {
      working = false;
      if (state) setBusy(false);
    }
  }
  function stopSharing() {
    if (working) return;
    openDialog("停止共享", (root) => {
      root.append(paragraph("会停止共享并撤下目录。已授权的伙伴记录与账目保留；需要时可再次分享。"));
      const agree = checkbox("我确认停止共享并撤下目录");
      const submit = button("确认停止", async () => {
        if (!agree.input.checked || working) return;
        working = true; setBusy(true);
        try {
          try { await client.action("stop-sharing", { confirm: true }); }
          catch (error) {
            if (error.status === 404) throw outdated("stop-sharing");
            throw error;
          }
          closeDialog();
          await refreshState();
          notice("已停止共享并撤下目录。", "good");
        } catch (error) {
          const message = error.status === 0 ? "连接中断，停止结果暂时不明。请刷新状态确认。" : error.message;
          notice(message, "warn");
          dialogError.textContent = message; dialogError.hidden = false;
        } finally { working = false; if (state) setBusy(false); }
      }, true);
      submit.disabled = true;
      agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      root.append(agree.label, submit);
    });
  }
  function renderModels() {
    modelsList.replaceChildren();
    if (!candidates) { modelsList.append(empty("还没有检测到模型", "点“重新检测本机模型”读取 Magpie 当前的模型与价格。")); updateSelectionControls(); return; }
    const models = items(candidates.models).filter((model) => [model.id, model.displayName].join(" ").toLowerCase().includes(search.sharing.toLowerCase()));
    if (!models.length) modelsList.append(empty("没有可分享的本机模型", "在 Magpie 添加本机服务和模型并设置完整价格后，再重新检测。"));
    for (const model of models) {
      const row = el("div", null, "shared-model-row");
      const choice = checkbox(model.displayName || model.id, selectedModels.has(model.id));
      choice.input.disabled = !model.completePrice;
      choice.input.addEventListener("change", () => {
        modelDirty = true;
        if (choice.input.checked) selectedModels.add(model.id); else selectedModels.delete(model.id);
        updateSelectionControls();
      });
      const body = el("div"); body.append(choice.label, paragraph(model.id), paragraph(priceText(model.pricing)), priceDetails(model));
      row.append(body, badge(model.completePrice ? "价格完整" : "缺少价格", model.completePrice ? "good" : "warn"));
      modelsList.append(row);
    }
    updateSelectionControls();
  }
  // ---- zero-file P2P (B assembly draft contract) ----
  const when = (value) => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间未知";
  };
  function p2pOf() { return record(state?.status?.p2p); }
  /**
   * Signature validity and TOFU acceptance are different questions. A valid
   * signature only proves the presence document is authentic; TOFU pending or
   * changed still needs an explicit human (and service-confirmed) acceptance
   * before any business request.
   */
  function presenceSecurity(presence, peer) {
    const rawSignature = presence?.signature ?? presence?.signatureStatus;
    const signature = ["valid", "invalid", "unknown"].includes(rawSignature)
      ? rawSignature
      : presence?.verified === true ? "valid" : "unknown";
    const rawTofu = presence?.tofu ?? presence?.tofuStatus;
    let tofu = ["accepted", "pending", "changed"].includes(rawTofu) ? rawTofu : null;
    if (!tofu) {
      const status = peer?.status;
      tofu = status === "verified" || status === "connected" ? "accepted" : status === "identity-changed" ? "changed" : "pending";
    }
    return { signature, tofu };
  }
  function listenerText(listener) {
    if (!listener || typeof listener.state !== "string") return "控制通道未读取";
    const where = listener.state === "ready"
      ? `${listener.reachability === "overlay" ? "覆盖网" : listener.reachability === "lan" ? "局域网（非覆盖网专属）" : "本机"}${listener.verified ? " · 已验证" : " · 未验证"}`
      : "不可用";
    return where;
  }
  function requestUsage(peer) {
    const acceptance = peerAcceptance(peer);
    const presenceEntry = items(p2pOf().presence).find((row) => row.nodeId === peer.nodeId) || null;
    const security = presenceSecurity(presenceEntry, peer);
    const needsIdentity = security.tofu !== "accepted";
    openDialog("申请使用伙伴的模型", (root) => {
      if (security.signature !== "valid") {
        root.append(el("p", "此伙伴的签名无效或未验证，不能发送申请。", "inline-warning"));
        return;
      }
      root.append(paragraph("请求通过覆盖网直接发送；不需要下载或导入文件，也不需要手工交付密钥。"));
      const identify = el("p", "完整身份指纹（请逐字核对）：");
      identify.append(el("code", acceptance.fingerprint, "fingerprint"));
      root.append(identify, details("身份与报价", [["伙伴", peer.quote?.node?.displayName || peer.hostname || "伙伴"], ["报价指纹", acceptance.quoteHash], ["价格版本", peer.quote?.publication?.version], ["价格未锁定", "是（priceLocked: false）"]]));
      if (needsIdentity) root.append(el("p", P2P_TOFU_LABELS[security.tofu] || "首次连接，需要核对身份", "inline-warning"));
      const getModels = modelChoices(root, items(peer.quote.models).map((model) => ({ ...model, completePrice: priceText(model.pricing) !== "价格不完整，不能授权" })), []);
      const accept = needsIdentity ? checkbox(`我核对并接受此完整身份指纹：${acceptance.fingerprint}`) : null;
      const agree = checkbox("我已核对完整身份指纹与报价，并发送一次使用申请");
      const submit = button(needsIdentity ? "核对身份并发送申请" : "发送使用申请", async () => {
        const chosen = getModels();
        if (security.signature !== "valid") { dialogError.textContent = "签名无效或未验证，不能发送申请。"; dialogError.hidden = false; return; }
        if (!agree.input.checked || !chosen.length) { dialogError.textContent = "请选择至少一个有完整价格的模型，并核对身份与报价。"; dialogError.hidden = false; return; }
        if (accept && !accept.input.checked) { dialogError.textContent = "请先核对并接受此完整身份指纹。"; dialogError.hidden = false; return; }
        // The service must confirm the identity before any business request; a
        // failed confirmation leaves the request unsent so it can be retried.
        if (needsIdentity) {
          const trusted = await run("trust-peer", { nodeId: peer.nodeId, fingerprint: acceptance.fingerprint });
          if (!trusted) { dialogError.textContent = "身份确认未完成；申请没有发送，可以重试。"; dialogError.hidden = false; return; }
        }
        await run("p2p-request", { nodeId: peer.nodeId, fingerprint: acceptance.fingerprint, quoteHash: acceptance.quoteHash, models: chosen }, () => closeDialog());
      }, true);
      submit.disabled = true;
      agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      if (accept) root.append(accept.label);
      root.append(agree.label, submit);
    });
  }
  function approveP2p(request) {
    const current = items(state.status.catalog?.quote?.models).filter((model) => items(request.models).includes(model.id));
    const requested = items(request.models).filter((id) => current.some((model) => model.id === id));
    const selected = new Set(requested);
    let preview = null;
    let previewing = false;
    let previewGeneration = 0;
    openDialog("核对并批准使用请求", (root) => {
      root.append(paragraph("一次确认会绑定这次请求、对方完整身份指纹、当前报价、选中模型的价格版本与批准代次。批准后密钥通过加密会话自动交付，不需要再发文件或复制密钥。"));
      const identify = el("p", "对方完整身份指纹（请逐字核对）：");
      identify.append(el("code", request.consumerFingerprint, "fingerprint"));
      root.append(identify, details("请求身份与绑定", [
        ["伙伴节点", request.consumerNodeId],
        ["伙伴名称", request.consumerHostname || "未提供"],
        ["报价指纹", request.quoteHash],
        ["批准代次", request.generation === null || request.generation === undefined ? "首次批准" : String(request.generation)],
        ["到期", when(request.expiresAt)],
      ]));
      if (request.detail) root.append(el("p", request.detail, "inline-warning"));
      if (request.tofu && request.tofu !== "accepted") root.append(el("p", P2P_TOFU_LABELS[request.tofu] || request.tofu, "inline-warning"));
      if (current.length !== items(request.models).length) {
        root.append(el("p", "当前报价缺少请求中的模型，不能批准；请拒绝或让伙伴重新申请。", "inline-warning"));
      }
      root.append(paragraph("选择要批准的模型（默认全部请求模型）。客户端不计算价格版本，选中后由服务返回当前报价的 selected version。"));
      const choices = [];
      for (const model of current) {
        const choice = checkbox(model.displayName || model.id, selected.has(model.id));
        choice.input.addEventListener("change", () => {
          if (choice.input.checked) selected.add(model.id); else selected.delete(model.id);
          invalidatePreview();
          updateApprove();
        });
        const row = el("div", null, "choice-row");
        row.append(choice.label, paragraph(priceText(model.pricing)));
        root.append(row);
        choices.push(choice);
      }
      const previewButton = button("预览选中报价", () => { void refreshPreview(); });
      const previewBox = el("div", null, "workflow-list");
      root.append(previewButton, previewBox);
      const cap = field("本次授权的正额度（USD）", "number", typeof request.capUsd === "number" && request.capUsd > 0 ? String(request.capUsd) : "");
      cap.input.min = "0.0001"; cap.input.max = "1000000"; cap.input.step = "0.0001"; cap.input.required = true;
      cap.label.append(el("small", "额度必须是 $0.0001 的整数倍；0 在 Magpie 中表示不限制，不能当作暂停。"));
      const accept = request.tofu === "accepted" ? null : checkbox(`我核对并接受此完整身份指纹：${request.consumerFingerprint}`);
      const agree = checkbox("我确认批准这次请求，并接受当前报价、模型与额度");
      const submit = button("确认批准", () => {
        const chosen = [...selected];
        if (!preview || !sameSet(preview.models, chosen)) { dialogError.textContent = "请先预览当前选择，再批准。"; dialogError.hidden = false; return; }
        if (current.length !== items(request.models).length) { dialogError.textContent = "当前报价缺少请求中的模型，不能批准。"; dialogError.hidden = false; return; }
        if (!agree.input.checked || !validCap(cap.input.value)) { dialogError.textContent = "请填写正额度，并明确确认批准。"; dialogError.hidden = false; return; }
        if (accept && !accept.input.checked) { dialogError.textContent = "请先核对并接受对方的完整身份指纹。"; dialogError.hidden = false; return; }
        const input = {
          requestId: request.requestId,
          consumerFingerprint: request.consumerFingerprint,
          quoteHash: preview.quoteHash,
          priceVersion: preview.priceVersion,
          generation: request.generation === undefined ? null : request.generation,
          models: chosen,
          capUsd: Number(cap.input.value),
        };
        // acceptFingerprint is only the human first-trust/identity-change marker;
        // the binding fields above are always sent, including when TOFU accepted.
        if (accept) input.acceptFingerprint = request.consumerFingerprint;
        void (async () => {
          const result = await run("p2p-approve", input, () => closeDialog());
          // A stale quote/generation means the human must review again; the UI
          // never retries the write on its own.
          if (!result && dialog.open) invalidatePreview();
        })();
      }, true);
      function sameSet(left, right) { return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]); }
      function invalidatePreview() {
        preview = null;
        // Invalidate any in-flight preview as well: a late response for an old
        // selection must never restore its price or re-enable approval.
        previewGeneration++;
        previewing = false;
        previewBox.replaceChildren(paragraph("选择已变化，请重新预览当前报价。"));
        updateApprove();
      }
      function updateApprove() {
        submit.disabled = !agree.input.checked || previewing || !preview || selected.size === 0 || !sameSet(preview.models, [...selected]);
        previewButton.disabled = previewing || selected.size === 0;
      }
      function renderPreview() {
        previewBox.replaceChildren();
        if (!preview) return;
        for (const model of preview.models) {
          const pricing = items(preview.pricing).find((row) => row.id === model)?.pricing;
          const row = el("div", null, "choice-row");
          row.append(el("strong", model), paragraph(pricing ? priceText(pricing) : "当前报价未提供价格"));
          previewBox.append(row);
        }
        previewBox.append(details("选中报价的技术绑定", [["选中价格版本", preview.priceVersion], ["报价指纹", preview.quoteHash], ["模型数", String(preview.models.length)]]));
      }
      async function refreshPreview() {
        if (!selected.size) { dialogError.textContent = "请至少选择一个模型。"; dialogError.hidden = false; return; }
        const generation = ++previewGeneration;
        previewing = true;
        preview = null;
        previewBox.replaceChildren(paragraph("正在读取选中模型的当前报价…"));
        updateApprove();
        try {
          const result = await client.action("p2p-quote-preview", { requestId: request.requestId, models: [...selected] });
          if (generation !== previewGeneration || !dialog.open) return;
          // A response for a selection that is no longer current is ignored.
          if (!sameSet(items(result.models), [...selected])) return;
          preview = { quoteHash: result.quoteHash, priceVersion: result.priceVersion, models: items(result.models), pricing: items(result.pricing) };
          renderPreview();
        } catch (error) {
          if (generation !== previewGeneration || !dialog.open) return;
          preview = null;
          dialogError.textContent = error.status === 409 ? "报价已变化，请重新预览后再决定。" : error.message;
          dialogError.hidden = false;
          previewBox.replaceChildren(paragraph(error.status === 409 ? "报价已变化；请重新预览。" : "读取选中报价失败；请重试预览。"));
        } finally {
          if (generation === previewGeneration) { previewing = false; updateApprove(); }
        }
      }
      agree.input.addEventListener("change", updateApprove);
      if (accept) accept.input.addEventListener("change", updateApprove);
      root.append(cap.label);
      if (accept) root.append(accept.label);
      root.append(agree.label, submit);
      updateApprove();
      void refreshPreview();
    });
  }
  function rejectP2p(request) {
    openDialog("拒绝这次使用请求", (root) => {
      root.append(paragraph("拒绝不会创建密钥，也不会影响其他伙伴。"));
      root.append(details("请求身份", [["伙伴节点", request.consumerNodeId], ["完整身份指纹", request.consumerFingerprint], ["请求的模型", items(request.models).join("、") || "未提供"]]));
      const note = field("拒绝说明（可选）"); note.input.maxLength = 300;
      const submit = button("确认拒绝", () => void run("p2p-reject", { requestId: request.requestId, ...(note.input.value.trim() ? { note: note.input.value.trim() } : {}) }, () => closeDialog()), true);
      root.append(note.label, submit);
    });
  }
  function recoverP2p(approvalId) {
    confirmAction("技术恢复（有界续传/对账）", "只对同一授权代次做有界恢复、读取对账或重发已封装的交付；不会重新批准、不会更改额度、不会创建第二个密钥或付款，也不会自动接受新报价。", "p2p-recover", approvalId ? { approvalId } : {}, "我确认执行一次有界恢复");
  }
  function renderP2pInbound() {
    p2pInboundList.replaceChildren();
    const rows = items(p2pOf().inboundRequests);
    if (!rows.length) { p2pInboundList.append(empty("还没有收到使用请求", "伙伴在“发现”里直接申请后，会在这里出现；不需要文件、端口或密钥。")); return; }
    for (const request of rows) {
      const actionable = ["pending", "waiting-tofu"].includes(request.state);
      const row = el("article", null, "workflow-row");
      const top = toolbar(request.consumerHostname || request.consumerNodeId || "伙伴");
      top.append(badge(P2P_INBOUND_LABELS[request.state] || request.state || "需要处理", actionable ? (request.tofu === "changed" ? "warn" : "info") : "neutral"));
      row.append(top, paragraph(`${items(request.models).length} 个模型 · 建议额度 ${request.capUsd === null || request.capUsd === undefined ? "未提供" : money(request.capUsd)} · 到期 ${when(request.expiresAt)}`));
      row.append(details("完整身份与报价", [["伙伴节点", request.consumerNodeId], ["完整身份指纹", request.consumerFingerprint], ["报价指纹", request.quoteHash], ["价格版本", request.priceVersion], ["身份状态", P2P_TOFU_LABELS[request.tofu] || request.tofu || "未提供"], ["收到时间", when(request.receivedAt)]]));
      if (request.tofu && request.tofu !== "accepted") row.append(el("p", P2P_TOFU_LABELS[request.tofu] || request.tofu, "inline-warning"));
      if (request.detail) row.append(el("p", request.detail, "inline-warning"));
      if (actionable) {
        const actions = el("div", null, "workflow-actions");
        actions.append(button("核对并批准", () => approveP2p(request)), button("拒绝", () => rejectP2p(request)));
        row.append(actions);
      }
      p2pInboundList.append(row);
    }
  }
  const P2P_APPROVAL_LABELS = { pending: "待交付", approved: "已批准", delivering: "正在交付", delivered: "已交付", revoked: "已撤销", rejected: "已拒绝", expired: "已过期", uncertain: "结果未知" };
  function renderP2pApprovals() {
    p2pApprovalsList.replaceChildren();
    const rows = items(p2pOf().approvals);
    if (!rows.length) { p2pApprovalsList.append(empty("还没有网络授权", "批准一次无文件请求后，这里显示交付状态、模型与额度。")); return; }
    for (const approval of rows) {
      const needsAction = ["uncertain", "action-needed"].includes(approval.state) || ["uncertain"].includes(approval.delivery?.state);
      const row = el("article", null, "workflow-row");
      const top = toolbar(approval.consumerNodeId || "伙伴");
      top.append(badge(P2P_APPROVAL_LABELS[approval.state] || approval.state || "需要处理", needsAction ? "warn" : "neutral"));
      row.append(top, paragraph(`${items(approval.models).length} 个模型 · 额度上限 ${capLabel(approval.capUsd)} · 交付 ${P2P_DELIVERY_LABELS[approval.delivery?.state] || approval.delivery?.state || "未提供"}`));
      row.append(details("授权、交付与身份", [["伙伴节点", approval.consumerNodeId], ["伙伴身份指纹", approval.consumerFingerprint], ["本机节点", approval.providerNodeId], ["本机身份指纹", approval.providerFingerprint], ["报价指纹", approval.quoteHash], ["价格版本", approval.priceVersion], ["代次", approval.generation], ["密钥引用（不透明）", approval.keyId], ["批准时间", when(approval.approvedAt)], ["到期", when(approval.expiresAt)], ["最近错误", approval.delivery?.lastError]]));
      if (approval.detail) row.append(el("p", approval.detail, "inline-warning"));
      if (needsAction) {
        row.append(el("p", "交付结果未知或需要人工处理；不会自动重发或创建第二个密钥。", "inline-warning"));
        const tech = el("div", null, "workflow-actions");
        tech.append(button("技术恢复（有界续传/对账）", () => recoverP2p(approval.approvalId)));
        row.append(tech);
      }
      if (!["revoked", "rejected", "expired"].includes(approval.state)) {
        const actions = el("div", null, "workflow-actions");
        actions.append(button("撤销此授权", () => confirmAction("撤销此授权", "会先撤销本机原生密钥；只有确认密钥已失效才会显示已撤销，否则会保持“需要处理”。账目保留。", "p2p-revoke", { approvalId: approval.approvalId }, "我确认撤销此网络授权")));
        row.append(actions);
      }
      p2pApprovalsList.append(row);
    }
  }
  function renderP2pConnections() {
    p2pConnectionsList.replaceChildren();
    const p2p = p2pOf();
    const listener = record(p2p.listener);
    const summary = el("article", null, "workflow-row");
    summary.append(toolbar("控制通道"), paragraph(`${P2P_CONNECTION_LABELS[listener.state] || listener.state || "未读取"} · ${listenerText(listener)}${listener.port ? ` · 端口 ${listener.port}` : ""}`));
    if (listener.detail) summary.append(el("p", listener.detail, "inline-warning"));
    p2pConnectionsList.append(summary);
    const outbound = items(p2p.outboundRequests);
    if (!outbound.length) p2pConnectionsList.append(empty("还没有发出使用申请", "在“发现”里选择伙伴并申请使用；批准后会自动连接，不需要文件。"));
    for (const request of outbound) {
      const row = el("article", null, "workflow-row");
      const top = toolbar(request.providerHostname || request.providerNodeId || "伙伴");
      top.append(badge(P2P_OUTBOUND_LABELS[request.state] || request.state || "需要处理", request.state === "connected" ? "good" : request.state === "action-needed" ? "warn" : "info"));
      const ack = record(request.ack);
      row.append(top, paragraph(`${items(request.models).length} 个模型 · ${ack.state === "registered" ? `已注册 ${items(ack.models).length} 个 · 额度 ${capLabel(ack.capUsd)}` : ack.state === "failed" ? "注册失败" : "等待注册回读"}`));
      row.append(details("申请身份与报价", [["伙伴节点", request.providerNodeId], ["完整身份指纹", request.providerFingerprint], ["报价指纹", request.quoteHash], ["价格版本", request.priceVersion], ["申请时间", when(request.createdAt)], ["更新时间", when(request.updatedAt)], ["最近说明", request.detail]]));
      if (request.state === "action-needed") {
        row.append(el("p", "需要人工处理；不会自动重发申请或创建第二个密钥。", "inline-warning"));
        const tech = el("div", null, "workflow-actions");
        tech.append(button("技术恢复（有界续传/对账）", () => recoverP2p(null)));
        row.append(tech);
      }
      p2pConnectionsList.append(row);
    }
    for (const connection of items(p2p.connections)) {
      const row = el("article", null, "workflow-row");
      const top = toolbar(connection.providerHostname || connection.providerNodeId || "伙伴");
      top.append(badge(P2P_CONNECTION_LABELS[connection.state] || connection.state || "需要处理", connection.state === "connected" ? "good" : "warn"));
      row.append(top, paragraph(`${items(connection.models).length} 个模型 · 额度 ${capLabel(connection.capUsd)} · 回读 ${when(connection.readbackAt)}`));
      row.append(details("连接与回读", [["伙伴节点", connection.providerNodeId], ["原生 Remote id", connection.providerId], ["最近说明", connection.detail]]));
      p2pConnectionsList.append(row);
    }
  }

  function importDocument(kind) {
    openDialog(kind === "request" ? "导入连接申请" : "导入伙伴授权", (root) => {
      root.append(paragraph(kind === "request" ? "选择伙伴从 AIHub 导出的申请文件，导入后先核对内容，再手动审批。" : "选择共享方交付的授权文件。文件包含访问密钥，本应用只在本机发送给服务验证；请妥善保存与传递。"));
      const fileLabel = el("label", null, "field"); fileLabel.append(el("span", "选择 AIHub 文件"));
      const file = el("input"); file.type = "file"; file.accept = ".json,application/json"; fileLabel.append(file);
      const advanced = el("details", null, "workflow-details"); advanced.append(el("summary", "或粘贴已收到的完整文件内容"));
      const paste = el("textarea"); paste.rows = 5; paste.maxLength = 65536; paste.autocomplete = "off"; paste.setAttribute("aria-label", "粘贴 AIHub 文件内容"); paste.setAttribute("data-1p-ignore", ""); paste.setAttribute("data-bwignore", ""); advanced.append(paste);
      const agree = checkbox(kind === "request" ? "我确认只导入此申请，尚未授权任何访问" : "我已核对共享方身份和报价，并确认此授权是交付给本机的");
      root.append(fileLabel, advanced, agree.label, button(kind === "request" ? "导入并核对申请" : "验证并连接", async () => {
        if (!agree.input.checked) { dialogError.textContent = "请先确认文件用途与来源。"; dialogError.hidden = false; return; }
        try {
          const selected = file.files?.[0];
          if (selected && selected.size > 64 * 1024) throw new Error("文件超过 64 KB，请选择有效的 AIHub 文件。");
          const document = parseTransportDocument(selected ? await selected.text() : paste.value);
          if (kind === "request" && document.schema !== "ohmyaihub.connection-request/v1") throw new Error("这不是 AIHub 连接申请文件。");
          if (kind === "authorization" && document.schema !== "ohmyaihub.authorization/v1") throw new Error("这不是 AIHub 授权文件。");
          paste.value = ""; file.value = "";
          const input = { document };
          await run(kind === "request" ? "request-import" : "connection-preview", input, (result) => {
            if (kind === "request") { closeDialog(); renderRequests(); }
            else previewConnection(document, result.document || result);
          }, { refresh: kind === "request" });
          if (kind !== "request" && secretDocument !== document) delete document.key;
        } catch (error) { dialogError.textContent = error.message; dialogError.hidden = false; }
      }, true));
    });
  }
  function previewConnection(document, preview) {
    openDialog("核对授权并连接", (root) => {
      root.append(paragraph("本机已验证此文件的申请方、共享方身份和当前报价。请再次核对以下信息，确认后才会创建原生 Remote Magpie 连接。"), details("授权身份与模型", [["共享方", preview.provider?.hostname || preview.provider?.nodeId], ["接受方", preview.consumer?.nodeId], ["模型范围", items(preview.models).join("、")], ["额度", capLabel(preview.capUsd)], ["完整身份指纹", preview.quote?.identityFingerprint], ["完整报价指纹", preview.quote?.contentHash], ["完整价格版本", preview.quote?.priceVersion], ["价格锁定", "否（priceLocked: false）"]]));
      const agree = checkbox("我已核对上述伙伴、模型与价格，并确认连接");
      const submit = button("创建此伙伴连接", () => {
        if (!agree.input.checked || !secretDocument) return;
        const input = { document: secretDocument };
        void run("connection-import", input, () => closeDialog());
      }, true);
      submit.disabled = true; agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      root.append(agree.label, submit);
    });
    secretDocument = document;
  }
  function requestDocument(request) { return request.document || request.request || request; }
  function renderRequests() {
    requestsList.replaceChildren();
    const requests = items(state?.workflows?.requests);
    if (!requests.length) { requestsList.append(empty("还没有收到申请", "让伙伴在“发现模型”中选择你的模型，生成申请并将文件发送给你。")); return; }
    for (const request of requests) {
      const doc = requestDocument(request);
      const row = el("article", null, "workflow-row");
      const title = toolbar(doc.consumer?.hostname || doc.consumer?.nodeId || "伙伴申请"); title.append(badge(statusNames[request.status] || "待审批"));
      row.append(title, paragraph(`${items(doc.models).length} 个模型 · ${doc.createdAt || request.importedAt || "待核对"}`));
      const actions = el("div", null, "workflow-actions");
      actions.append(button(request.status === "pending" ? "核对并审批" : "查看申请", () => approveRequest(request)));
      row.append(actions); requestsList.append(row);
    }
  }
  function approveRequest(request) {
    const doc = requestDocument(request);
    openDialog("核对伙伴申请", (root) => {
      const reasons = items(request.reasons || request.comparison?.reasons);
      root.append(details("申请身份与报价", [["申请方", doc.consumer?.hostname || doc.consumer?.nodeId], ["共享方", doc.provider?.hostname || doc.provider?.nodeId], ["申请身份指纹", doc.quote?.identityFingerprint], ["申请报价指纹", doc.quote?.contentHash], ["申请价格版本", doc.quote?.priceVersion], ["当前报价指纹", request.currentQuote?.contentHash || state.status.catalog?.quote?.contentHash], ["当前身份指纹", request.currentQuote?.identityFingerprint || state.status.catalog?.quote?.identity?.fingerprint], ["价格锁定", "否（priceLocked: false）"]]));
      if (reasons.length) root.append(el("p", reasons.join("；"), "inline-warning"));
      const currentModels = items(state.status.catalog?.quote?.models);
      const getModels = modelChoices(root, items(doc.models).map((id) => ({ ...(currentModels.find((model) => model.id === id) || {}), id, completePrice: currentModels.some((model) => model.id === id && priceText(model.pricing) !== "价格不完整，不能授权") })), items(doc.models));
      if (request.status !== "pending") { root.append(paragraph(`此申请${statusNames[request.status] || "已处理"}。`)); return; }
      const cap = field("本次明确授权的额度（USD）", "number", ""); cap.input.min = "0.0001"; cap.input.max = "1000000"; cap.input.step = "0.0001"; cap.input.required = true; cap.input.placeholder = "请输入大于等于 0.0001 的金额";
      cap.label.append(el("small", "额度必须是 $0.0001 的整数倍。0 在 Magpie 中表示不设上限，不能作为暂停。"));
      const agree = checkbox("我已核对申请方、当前报价、模型与额度，明确批准此次授权");
      const submit = button("批准此申请", () => {
        if (!agree.input.checked || !validCap(cap.input.value) || !getModels().length) { dialogError.textContent = "请选择至少一个当前可授权模型，填写有效正额度，并明确确认批准。"; dialogError.hidden = false; return; }
        void run("request-approve", { requestId: request.id || request.requestId, capUsd: Number(cap.input.value), models: getModels() }, () => closeDialog());
      }, true);
      submit.disabled = request.eligible === false || request.approvable === false;
      const rejectNote = field("拒绝说明（可选）"); rejectNote.input.maxLength = 300;
      root.append(cap.label, agree.label, submit, rejectNote.label, button("拒绝此申请", () => void run("request-reject", { requestId: request.id || request.requestId, note: rejectNote.input.value.trim() }, () => closeDialog())));
    });
  }
  function renderConsumers() {
    consumersList.replaceChildren();
    const consumers = items(state?.status.consumers);
    if (!consumers.length) { consumersList.append(empty("还没有授权伙伴", "导入并手动批准申请后，伙伴的模型范围、使用量和授权状态会显示在这里。")); return; }
    for (const consumer of consumers) {
      const row = el("article", null, "workflow-row");
      const top = toolbar(consumer.consumerId);
      const capVerified = safeCap(consumer.capUsd);
      top.append(badge(consumer.revokedAt ? "已撤销" : consumer.paused ? "已暂停" : !capVerified ? (knownCap(consumer.capUsd) ? "额度上限不安全" : "额度上限待核验") : consumer.spent ? "额度已用尽" : "已授权", consumer.revokedAt || consumer.paused || consumer.spent || !capVerified ? "warn" : "good"));
      row.append(top, paragraph(`${items(consumer.models).length} 个模型 · 额度上限 ${capLabel(consumer.capUsd)} · 已用 ${money(consumer.usedUsd)} · 剩余 ${money(consumer.leftUsd)}`), details("模型、计费与授权详情", [["模型范围", items(consumer.models).join("、")], ["价格版本", consumer.priceVersion], ["接受的报价", consumer.acceptedQuoteHash], ["累计调用", consumer.calls], ["下次窗口", consumer.reset], ["暂停原因", consumer.paused?.reason], ["计费不确定性", consumer.ledger?.uncertain], ["价格锁定", "否（priceLocked: false）"]]));
      if (!capVerified && !consumer.revokedAt) row.append(el("p", `${capLabel(consumer.capUsd)}。请点击“检查授权”核验当前上限；这不表示剩余额度为零。`, "inline-warning"));
      if (!consumer.revokedAt) {
        const actions = el("div", null, "workflow-actions");
        actions.append(button("检查授权", () => void run("consumer-check", { consumerId: consumer.consumerId }, (result) => {
          const current = result.consumer || consumer;
          if (current.paused || !current.acceptedQuoteHash || current.acceptedQuoteHash !== result.currentQuoteHash || current.priceVersion !== result.currentPriceVersion) reissueConsumer(current, result);
        })), button("交付访问授权", () => revealAuthorization(consumer)), button("调整模型范围", () => editConsumerModels(consumer)), button("撤销授权", () => confirmAction("撤销伙伴授权", "撤销后，此伙伴原有密钥将失效。已有账目会保留。", "consumer-revoke", { consumerId: consumer.consumerId }, "我确认撤销此伙伴的访问授权")));
        row.append(actions);
      }
      consumersList.append(row);
    }
  }
  function editConsumerModels(consumer) {
    openDialog("调整伙伴模型范围", (root) => {
      root.append(paragraph("只允许选择当前共享的有完整价格的本机模型。模型范围不能为空；停止访问请使用撤销授权。"));
      const models = items(state.status.catalog?.quote?.models).filter((model) => items(consumer.models).includes(model.id)).map((model) => ({ ...model, completePrice: priceText(model.pricing) !== "价格不完整，不能授权" }));
      const getModels = modelChoices(root, models, items(consumer.models));
      const agree = checkbox("我确认更新此伙伴的模型范围");
      root.append(agree.label, button("保存模型范围", () => {
        if (!agree.input.checked || !getModels().length) { dialogError.textContent = "请选择模型并明确确认。"; dialogError.hidden = false; return; }
        void run("consumer-models", { consumerId: consumer.consumerId, models: getModels() }, () => closeDialog());
      }, true));
    });
  }
  function reissueConsumer(consumer, preview) {
    openDialog("重新确认并恢复授权", (root) => {
      root.append(paragraph(consumer.paused ? "此伙伴的授权已暂停。只有当前模型价格、报价与账目都能验证时，才可重新签发授权。该操作不会增加余额，也不会重置历史使用量。" : "此伙伴的授权尚未绑定当前目录报价，或接受的报价与当前版本不同。只有明确核对并接受当前价格与报价后，才可重新签发并交付授权。该操作不会增加余额，也不会重置历史使用量。"), details("当前待接受的价格绑定", [["伙伴", consumer.consumerId], ["模型", items(consumer.models).join("、")], ["当前价格版本", preview.currentPriceVersion], ["当前报价指纹", preview.currentQuoteHash], ["暂停原因", preview.consumer?.paused?.reason || consumer.paused?.reason], ["价格锁定", "否（priceLocked: false）"]]));
      if (!preview.currentPriceVersion || !preview.currentQuoteHash) { root.append(el("p", "当前报价缺少完整价格或模型范围，暂时不能重新签发。请先检查模型目录和价格。", "inline-warning")); return; }
      const agree = checkbox("我已核对上述完整报价与模型，并接受新的价格绑定");
      const submit = button("接受并重新签发", () => {
        if (!agree.input.checked) return;
        void run("consumer-reissue", { consumerId: consumer.consumerId, acceptPriceVersion: preview.currentPriceVersion, acceptQuoteHash: preview.currentQuoteHash }, () => closeDialog());
      }, true);
      submit.disabled = true; agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      root.append(agree.label, submit);
    });
  }
  function revealAuthorization(consumer) {
    openDialog("交付访问授权", (root) => {
      root.append(paragraph("授权文件包含 Gateway Key，持有者可使用指定模型与额度。请只通过可信的私密渠道交付给该伙伴。关闭窗口会清除本页显示的密钥。"));
      const agree = checkbox("我确认要向此伙伴交付访问密钥");
      const reveal = button("显示本次授权文件", () => {
        if (!agree.input.checked) return;
        void run("key-reveal", { consumerId: consumer.consumerId }, (result) => {
          secretDocument = result.document || result;
          root.replaceChildren(paragraph("此文件包含访问密钥。只交付给对应伙伴；下载的文件和主动复制的内容需要由你妥善保管。"));
          const key = el("textarea", null, "secret-value"); key.readOnly = true; key.value = secretDocument.key || ""; key.rows = 3; key.setAttribute("aria-label", "本次授权的访问密钥"); key.autocomplete = "off";
          const actions = el("div", null, "workflow-actions");
          actions.append(button("下载授权文件", () => { if (secretDocument) download(secretDocument, "aihub-authorization.json"); }, true), button("复制授权文件", async () => {
            if (!secretDocument) return;
            try { await navigator.clipboard.writeText(JSON.stringify(secretDocument, null, 2)); notice("授权文件已复制，请仅通过私密渠道交付。", "good"); }
            catch { notice("浏览器未允许复制，请下载授权文件。", "warn"); }
          }), button("完成并隐藏", () => closeDialog()));
          root.append(key, actions);
        }, { refresh: false });
      }, true);
      reveal.disabled = true; agree.input.addEventListener("change", () => { reveal.disabled = !agree.input.checked; });
      root.append(agree.label, reveal);
    });
  }

  // Native Remote Magpie connections, key replacement and removal.
  const p2pConnectionsCard = el("div", null, "card workflow-section");
  p2pConnectionsCard.append(toolbar("无文件连接状态"));
  const p2pConnectionsList = el("div", null, "workflow-list"); p2pConnectionsCard.append(p2pConnectionsList);
  const connectionsIntro = el("div", null, "card workflow-section");
  const connectionsTop = toolbar("已连接的伙伴");
  connectionsIntro.append(connectionsTop, paragraph("伙伴模型注册为本机 Magpie 的原生远程服务后显示在这里。每个共享方的身份、模型与额度保持独立。"));
  const legacyImport = el("details", null, "advanced-recovery");
  legacyImport.append(el("summary", "高级应急：导入伙伴授权文件"));
  const legacyImportButton = button("导入伙伴授权", () => importDocument("authorization"));
  legacyImport.append(paragraph("只有伙伴无法使用无文件交付时才使用；文件里含访问密钥，不在普通流程里出现。"), legacyImportButton);
  connectionsIntro.append(legacyImport);
  const connectionsList = el("div", null, "workflow-card-grid"); roots.connections.append(p2pConnectionsCard, connectionsIntro, connectionsList);
  function renderConnections() {
    connectionsList.replaceChildren();
    const providers = items(state?.status.providers);
    if (!providers.length) { connectionsList.append(empty("还没有连接伙伴", "先在“发现模型”中核对身份并申请模型；收到授权文件后，点击“导入伙伴授权”。")); return; }
    for (const provider of providers) {
      const row = el("article", null, "card workflow-section"); const top = toolbar(provider.fingerprint?.hostname || provider.id);
      const limit = record(provider.limit);
      const capVerified = safeCap(limit.costLimit);
      top.append(badge(!capVerified ? (knownCap(limit.costLimit) ? "额度上限不安全" : "额度上限待核验") : limit.spent === true ? "额度已用尽" : statusNames[provider.status] || "需要处理", provider.status === "connected" && capVerified && limit.spent !== true ? "good" : "warn"));
      row.append(top, paragraph(`原生 Remote Magpie · ${provider.remoteMagpieId || provider.id}`), paragraph(`额度上限 ${capLabel(limit.costLimit)} · 已用 ${money(limit.cost)} · 剩余 ${money(limit.costLeft)}`));
      if (!capVerified) row.append(el("p", `${capLabel(limit.costLimit)}。请点击“检查连接与额度”核验；网络已连接不代表额度上限安全。`, "inline-warning"));
      if (provider.detail) row.append(el("p", provider.detail, "inline-warning"));
      row.append(details("连接与核验信息", [["本机接入地址", provider.url], ["伙伴网络地址", provider.mappedCidr], ["最近连接", provider.lastConnectedAt], ["原生限额状态", limit.spent === true ? "额度已用尽，原生调用可能返回 429" : provider.limit ? "已读取" : "尚未读取"], ["授权说明", "401 表示密钥未被接受；429 表示原生限额拒绝。两者不是网络连通证明。"]]));
      const actions = el("div", null, "workflow-actions");
      // Both reads persist a new evidence record, so refresh the state once after
      // the explicit action (the polling endpoint itself never probes).
      actions.append(button("读取可用模型", () => void run("provider-models", { id: provider.id }, (result) => showProviderModels(provider, result))), button("检查连接与额度", () => void run("provider-check", { id: provider.id })), button("更新访问密钥", () => updateKey(provider)), button("移除此连接", () => confirmAction("移除此连接", "会移除本插件创建的本机远程服务与转发。对方的授权和账目不会被删除，其他连接可能短暂重连。", "provider-remove", { id: provider.id }, "我确认移除此伙伴连接")));
      row.append(actions); connectionsList.append(row);
    }
  }
  function showProviderModels(provider, result) {
    const models = items(result.models || result.modelIds || result);
    const evidence = record(result.modelsEvidence);
    openDialog("此连接的实际可用模型", (root) => {
      root.append(paragraph(`来自 Magpie 原生远程服务：${provider.remoteMagpieId || provider.id}`));
      if (evidence.status && evidence.status !== "current") {
        root.append(el("p", "这次读取没有留下当前证据，清单只作诊断；首页不会把它计为可用。", "inline-warning"));
      } else if (evidence.readAt) {
        root.append(paragraph(`真实读回于 ${new Date(evidence.readAt).toLocaleString("zh-CN", { hour12: false })}。`));
      }
      if (!models.length) root.append(empty("尚未读取到模型", "检查此连接的身份、密钥与额度后重新读取。"));
      for (const model of models) {
        const data = typeof model === "string" ? { id: model } : model;
        root.append(el("div", data.displayName || data.id, "choice-row"));
      }
    });
  }
  function updateKey(provider) {
    openDialog("更新伙伴访问密钥", (root) => {
      root.append(paragraph("填写共享方重新交付的密钥。更新后会重新验证此连接，不会修改其他伙伴的密钥。"));
      const key = field("新的 Gateway Key", "password");
      const agree = checkbox("我确认密钥来自此共享方");
      root.append(key.label, agree.label, button("验证并更新", () => {
        if (!key.input.value.trim() || !agree.input.checked) { dialogError.textContent = "请填写密钥并确认来源。"; dialogError.hidden = false; return; }
        const input = { id: provider.id, key: key.input.value.trim() }; key.input.value = "";
        void run("provider-update-key", input, () => closeDialog()).finally(() => { delete input.key; });
      }, true));
    });
  }
  function render(next) {
    state = next;
    // Stopping only exists while something is shared; sharing itself is the single confirm action.
    stopShareButton.hidden = next.status.config.sharingEnabled !== true;
    if (!publicationDirty) {
      const config = record(next.status.config.catalog);
      displayName.input.value = config.displayName || "";
      contact.input.value = config.contact || "";
      minimum.input.value = config.minTopUpUsd ?? "";
    }
    if (next.shareCandidates && !modelDirty) {
      candidates = next.shareCandidates;
      selectedModels = new Set(policySelection(candidates.models));
      renderModels();
    }
    updateSelectionControls();
    for (const [key, value, update] of [["identity", next.status.catalog?.quote, renderOwnIdentity], ["discovery", [next.status.catalog, next.status.config.catalog?.discoveryEnabled], renderDiscovery], ["requests", next.workflows?.requests, renderRequests], ["consumers", next.status.consumers, renderConsumers], ["connections", next.status.providers, renderConnections], ["p2pInbound", next.status.p2p?.inboundRequests, renderP2pInbound], ["p2pApprovals", next.status.p2p?.approvals, renderP2pApprovals], ["p2pConnections", next.status.p2p, renderP2pConnections]]) {
      const digest = JSON.stringify(value ?? null);
      if (caches.get(key) !== digest) { caches.set(key, digest); update(); }
    }
  }
  renderModels();
  renderP2pInbound();
  renderP2pApprovals();
  renderP2pConnections();
  return {
    render,
    clearSecrets() {
      closeDialog();
      state = null;
      caches.clear();
      for (const root of Object.values(roots)) root.querySelectorAll("input[type=password],textarea").forEach((node) => { node.value = ""; });
    },
    dispose() { closeDialog(); dialog.remove(); },
  };
}
