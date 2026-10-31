/* Testnet wallet presentation only. Existing Wallet/Ledger/Provisioner own every
 * financial decision. No wallet key, RPC URL or signature is kept in storage. */
import { capLabel, parseTransportDocument } from "./providers.js";
const rows = (value) => Array.isArray(value) ? value : [];
const obj = (value) => value && typeof value === "object" ? value : {};
const usd = (value) => typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "未知";
const stamp = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未验证";
const TEST_CHAINS = [97, 84532];
export function validTokenAmount(value, decimals) {
  return typeof value === "string" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 && /^(0|[1-9]\d*)(\.\d+)?$/.test(value) && (value.split(".")[1]?.length || 0) <= decimals && /[1-9]/.test(value);
}
export function explicitNetwork(value) { return TEST_CHAINS.includes(Number(value)) && value !== "" ? Number(value) : null; }
export function depositLabel(state) {
  return ({ "awaiting-signature": "等待外部钱包签名", "payment-not-seen": "等待匹配的转账", observed: "已观察到链事件", verifying: "正在验证交易回执", confirming: "等待网络确认", "finality-reached": "已达最终性，等待记账", crediting: "正在入账并核验额度", unproven: "入账结果尚未证实", credited: "已记录入账证据", unclaimed: "无法归属到申请", uncertain: "证据不确定", reverted: "链事件已回退", "manual-review": "需要人工核对", failed: "处理未完成", expired: "申请已过期", cancelled: "申请已取消", requested: "等待外部钱包签名", signed: "已签名，等待转账", matched: "已匹配链事件", void: "申请已失效" })[state] || "状态未知";
}
export function keyLabel(state) {
  return ({ usable: "最近核验可用", "usable-but-export-withdrawn": "密钥已核验，共享发布已撤回", spent: "额度已用尽（429）", paused: "计费保护暂停", revoked: "授权已撤销（401）", "no-key": "尚无有效密钥", unverified: "尚未核验密钥", unproven: "额度证据不完整", unknown: "状态未知" })[state] || "状态未知";
}
export function journeyNext(state) {
  if (["awaiting-signature", "requested"].includes(state)) return "下载申请交给付款方，使用自己的外部钱包签名，再把签名文件交回共享方。";
  if (["payment-not-seen", "signed"].includes(state)) return "签名已验证。付款方核对准确网络、代币合约、金额和收款地址后，在自己的钱包转账。";
  if (["observed", "verifying", "confirming", "finality-reached", "crediting", "matched"].includes(state)) return "等待该网络的回执、确认与最终性，再检查账本入账和原生密钥回读。";
  if (state === "credited") return "查看账本应用、密钥回读时间和计费状态；链事件入账不等于当前远程调用一定可用。";
  if (["cancelled", "expired", "void"].includes(state)) return "此申请不能继续。确认旧申请状态后，再明确创建新的申请。";
  return "刷新证据并检查异常或计费保护原因；不要重复转账或把未知状态当作成功。";
}
const stepLabels = { signature: "付款方签名", payment: "观察链事件", verification: "验证回执", confirmations: "网络确认", finality: "最终性", ledger: "账本应用", key: "原生额度回读" };
const stepStates = { done: "已验证", current: "处理中", pending: "等待", blocked: "受阻", unknown: "未知", "not-applicable": "不适用" };

export function mountWallet({ client, getState, onState, notice, setBusy, refreshState }) {
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (className) node.className = className; return node; };
  const p = (text) => el("p", text, "muted");
  const button = (text, callback, primary = false) => { const node = el("button", text, `button ${primary ? "primary" : "secondary"}`); node.type = "button"; node.addEventListener("click", callback); return node; };
  const field = (text, type = "text", value = "") => { const label = el("label", null, "field"); const input = el("input"); input.type = type; input.value = value; input.autocomplete = "off"; label.append(el("span", text), input); return { label, input }; };
  const check = (text) => { const label = el("label", null, "workflow-check"); const input = el("input"); input.type = "checkbox"; label.append(input, el("span", text)); return { label, input }; };
  const select = (text, choices, placeholder) => {
    const label = el("label", null, "field"); const input = el("select"); input.setAttribute("aria-label", text);
    input.append(option("", placeholder || "请明确选择")); for (const [value, title] of choices) input.append(option(value, title)); input.value = ""; label.append(el("span", text), input); return { label, input };
  };
  const option = (value, title) => { const node = el("option", title); node.value = String(value); return node; };
  const details = (title, values, open = false) => { const node = el("details", null, "workflow-details"); node.open = open; node.append(el("summary", title)); for (const [label, value] of values) { const row = el("div"); row.append(el("strong", label), el("span", value ?? "未知")); node.append(row); } return node; };
  const section = (title, text) => { const node = el("section", null, "card workflow-section"); node.append(el("div", null, "section-heading")); node.children[0].append(el("h2", title)); if (text) node.append(p(text)); return node; };
  const empty = (title, text) => { const node = el("div", null, "workflow-empty"); node.append(el("h3", title), p(text)); return node; };
  const pill = (text, tone = "neutral") => el("span", text, `pill ${tone}`);
  const walletRoot = document.getElementById("wallet-panel");
  const accountingRoot = document.getElementById("accounting-panel");
  let state = null;
  let generation = 0;
  let working = false;
  let currentDialog = null;
  let retainedDocument = null;
  const urls = new Set();
  const caches = new Map();
  let selectedConsumer = "";
  let externalStatement = null;
  let creationPending = false;

  const dialog = el("dialog", null, "workflow-dialog wallet-dialog");
  const title = el("h2"); title.id = "wallet-dialog-title"; dialog.setAttribute("aria-labelledby", title.id);
  const head = el("div", null, "section-heading"); head.append(title, button("关闭", () => closeDialog()));
  const body = el("div", null, "dialog-content");
  const error = el("p", null, "form-error"); error.hidden = true; error.setAttribute("role", "alert");
  dialog.append(head, body, error); document.body.append(dialog);
  function closeDialog() {
    generation++;
    retainedDocument = null;
    dialog.querySelectorAll("input,textarea").forEach((node) => { node.value = ""; });
    body.replaceChildren(); error.textContent = ""; error.hidden = true; currentDialog = null;
    if (dialog.open) dialog.close();
    for (const url of urls) URL.revokeObjectURL(url); urls.clear();
  }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener("close", () => { if (!dialog.open && currentDialog) closeDialog(); });
  function openDialog(text, build) { closeDialog(); title.textContent = text; currentDialog = text; build(body); dialog.showModal(); }
  function fail(message) { error.textContent = message; error.hidden = false; }
  function download(document, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2) + "\n"], { type: "application/json" })); urls.add(url);
    const link = el("a"); link.href = url; link.download = name; link.rel = "noopener"; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
  }
  function applyWallet(result) {
    if (result?.schema === "ohmyaihub/console/1") onState(result);
    else if (result?.wallet && getState()) {
      creationPending = rows(result.wallet.intentOperations).some((operation) => ["pending", "reserved", "unknown"].includes(operation.status || operation.state));
      onState({ ...getState(), wallet: result.wallet });
    }
  }
  async function run(name, input = {}, success, { refresh = true } = {}) {
    if (working || !getState()?.configured) return;
    const expected = generation;
    working = true; setBusy(true); error.hidden = true;
    const controls = [walletRoot, accountingRoot, dialog].flatMap((root) => [...root.querySelectorAll("button,input,textarea,select")]).map((node) => [node, node.disabled]);
    controls.forEach(([node]) => { node.disabled = true; });
    notice("正在读取或处理测试网证据，请稍候…");
    try {
      const result = await client.action(name, input);
      if (generation !== expected || !getState()) return;
      applyWallet(result);
      if (success) await success(result);
      if (refresh && getState()) await refreshState();
      if (getState()) notice("操作已返回，请以证据状态、核验时间和原生额度回读为准。", "good");
      return result;
    } catch (cause) {
      if (generation !== expected || !getState()) return;
      const unknown = !cause.status || cause.status >= 500;
      if (unknown && name === "wallet-intent-create") creationPending = true;
      const message = unknown ? "操作结果暂时未知。请刷新状态并查看已有申请与待核对操作，不要重复创建申请、签名或转账。" : cause.message;
      notice(message, "warn"); if (dialog.open) fail(message);
      if (unknown && name === "wallet-intent-create") {
        for (const node of dialog.querySelectorAll("button")) if (node.dataset.createsIntent) node.dataset.blockedUnknown = "true";
      }
    } finally {
      controls.forEach(([node, disabled]) => { node.disabled = node.dataset.blockedUnknown ? true : disabled; });
      working = false; if (getState()) setBusy(false);
    }
  }
  function confirm(title, explanation, name, input, wording = "我已核对并确认此操作") {
    openDialog(title, (root) => {
      root.append(p(explanation)); const agree = check(wording); const submit = button(title, () => { if (agree.input.checked) void run(name, input, () => closeDialog()); }, true);
      submit.disabled = true; agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; }); root.append(agree.label, submit);
    });
  }
  const refreshButton = button("初始化 / 刷新钱包", () => void run("wallet-refresh", { probeRpc: false }));
  const overview = section("钱包概览", "充值记录与提供者信用分开显示；资产余额需要单独查询。");
  const overviewFacts = el("dl", null, "facts wallet-facts"); overview.append(overviewFacts);
  overview.append(el("h3", "提供者信用（按伙伴）", "subhead"));
  const creditList = el("ul", null, "credit-list"); overview.append(creditList);
  walletRoot.append(overview);
  const walletEvidence = el("div", null, "wallet-evidence");
  const intents = section("共享方 · 发起与追踪入账申请", "为本机管理的伙伴创建入账申请；转账与签名由付款方在自己的钱包完成。");
  const intentActions = el("div", null, "workflow-actions");
  const createButton = button("创建测试网入账申请", () => createIntent(), true);
  const refreshButtonInline = refreshButton;
  intentActions.append(createButton);
  intents.append(intentActions);
  const intentRows = el("div", null, "workflow-list"); intents.append(intentRows); walletRoot.append(intents);
  const guide = section("使用方 · 用自己的外部钱包付款", "导入共享方给的申请文件，核对网络、金额与收款地址，再把自己的钱包签名交回对方。");
  const guideActions = el("div", null, "workflow-actions"); guideActions.append(button("导入并核对入账申请", () => importFile("deposit"))); guide.append(guideActions);
  guide.append(p("不向此页面提供钱包私钥、助记词或钱包备份文件。签名是归属证明，不能替代转账，也不代表已经入账。"));
  const tutorials = el("details", null, "workflow-details"); tutorials.append(el("summary", "第三方真实资产参考教程"), p("以下是第三方的真实主网资产教程，不会获取测试币，也不适用于本地模拟代币。本项目与 Peer、支付宝无合作关系。"));
  for (const [name, href] of [["BNB Chain 官方教程", "https://www.bnbchain.org/en/blog/moving-from-a-centralized-exchange-to-bnb-chain"], ["Peer 中文购买教程", "https://docs.peer.xyz/guides/zh/alipay-buy"]]) { const link = el("a", name); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer external"; tutorials.append(link); }
  guide.append(tutorials); walletRoot.append(guide);
  // Diagnostics live on the network page, not in the wallet's everyday view.
  const diagnosticsRoot = document.getElementById("wallet-diagnostics");
  const alertRows = el("div", null, "workflow-list");
  const diagnosticRows = el("div", null, "workflow-list");
  if (diagnosticsRoot) {
    const diagSection = section("钱包与链诊断", "RPC、观察器、扫描、测试代币、对账与审计都在这里；每项都会明确写清它改变了什么。");
    const watcherActions = el("div", null, "workflow-actions");
    watcherActions.append(button("启动已启用网络的观察", () => confirm("启动链上观察", "将联系已配置的 RPC。只有生产观察器确认、账本应用和原生额度回读后，才可判断入账结果。", "wallet-start", {})), button("停止自动观察", () => confirm("停止自动观察", "停止后不再启动新的定时扫描；正在执行的扫描可能仍需完成。不会取消申请或撤销已记账记录。", "wallet-stop", {})), refreshButtonInline, button("刷新链与入账证据", () => void run("wallet-refresh", { probeRpc: true })));
    diagSection.append(walletEvidence, watcherActions, diagnosticRows);
    const alerts = section("链上异常与审计记录", "标记已审阅只保存说明，不会补记余额、撤销入账、解冻授权或重建缺失费用。"); alerts.append(alertRows);
    diagnosticsRoot.append(diagSection, alerts);
  }

  function renderEvidence() {
    const wallet = obj(state.wallet); walletEvidence.replaceChildren();
    const text = wallet.availability === "available" ? "钱包配置已读取" : wallet.availability === "unavailable" ? "钱包暂时不可读取" : "尚未初始化钱包";
    walletEvidence.append(pill(text, wallet.availability === "available" ? "neutral" : "warn"), p(`本地视图：${stamp(wallet.viewAt)} · 最近主动核验：${stamp(wallet.evidenceAt)} · ${wallet.source === "explicit-refresh" ? "主动刷新证据" : "本地缓存，不代表实时链状态"}`));
    if (wallet.error) walletEvidence.append(el("p", "钱包当前无法核验，请明确点击初始化 / 刷新钱包重试。", "inline-warning"));
    if (wallet.truncated || wallet.view?.truncated) walletEvidence.append(el("p", "当前只显示有界历史，未显示的旧记录不能视为不存在。创建安全检查由服务端完整记录决定。", "inline-warning"));
    createButton.disabled = wallet.availability !== "available";
    refreshButton.textContent = wallet.availability === "available" ? "刷新本地钱包视图" : "初始化 / 刷新钱包";
  }
  function money0(value) { return typeof value === "number" && Number.isFinite(value) ? usd(value) : "尚未读取"; }
  function renderOverview() {
    overviewFacts.replaceChildren();
    creditList.replaceChildren();
    const wallet = obj(state.wallet);
    const available = wallet.availability === "available";
    const chains = rows(wallet.view?.chains);
    const deposits = rows(wallet.view?.deposits).filter((row) => typeof row?.creditedUsd === "number" && row.creditedUsd > 0)
      .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")));
    const latest = deposits[0];
    const fact = (label, value) => { const div = el("div"); div.append(el("dt", label), el("dd", value)); overviewFacts.append(div); };
    // There is no balance read in this phase: never print 0 as if it were one.
    fact("资产余额", available ? "尚未查询" : "尚未读取");
    fact("最近入账（累计，非余额）", !available ? "尚未读取" : latest ? `${money0(latest.creditedUsd)} · ${stamp(latest.updatedAt)}` : "尚无记录");
    const networks = rows(wallet.registry?.networks).filter((network) => TEST_CHAINS.includes(network.chainId));
    const assets = rows(wallet.registry?.assets);
    fact("测试网络", networks.length
      ? networks.map((network) => `${network.displayName}${assets.some((asset) => asset.chainId === network.chainId) ? `（${assets.filter((asset) => asset.chainId === network.chainId).map((asset) => asset.symbol).join("、")}）` : ""}`).join(" · ")
      : "尚未读取");
    const consumers = rows(wallet.view?.consumers);
    if (!available || !consumers.length) {
      creditList.append(el("li", available ? "还没有提供者账目" : "尚未读取", "muted"));
      return;
    }
    for (const consumer of consumers) {
      const li = el("li");
      li.append(el("span", consumer.consumerId), el("strong", money0(consumer?.ledger?.balanceUsd)));
      creditList.append(li);
    }
  }
  function renderDiagnostics() {
    diagnosticRows.replaceChildren();
    const wallet = obj(state.wallet);
    const configs = rows(wallet.registry?.networks).filter((network) => TEST_CHAINS.includes(network.chainId));
    if (!configs.length) { diagnosticRows.append(empty("还没有可诊断的网络", "初始化钱包后，这里会列出每个测试网的 RPC、观察与代币配置。")); }
    for (const network of configs) {
      const chain = rows(wallet.view?.chains).find((row) => row.chainId === network.chainId) || {};
      const policy = obj(network.finality);
      const row = el("article", null, "workflow-row");
      const top = el("div", null, "section-heading"); top.append(el("h3", network.displayName), pill(network.enabled ? "已启用" : "已停用"));
      row.append(top, p(`chainId ${network.chainId} · RPC ${network.rpcConfigured ? `已配置 ${network.rpcCount} 个` : "尚未配置"} · 最近扫描 ${stamp(chain.lastScanAt)}`), p(`最终性：${policy.mode === "finalized-tag" ? "等待 finalized 标签" : `等待 ${policy.confirmations} 次确认`}`));
      row.append(details("收款地址与观察进度", [["本机收款地址", receivingAddress(network)], ["链头", chain.head], ["最终块", chain.finalizedBlock], ["观察游标", chain.cursor], ["最终性依据", policy.rationale]]));
      const assets = rows(wallet.registry?.assets).filter((asset) => asset.chainId === network.chainId);
      for (const asset of assets) {
        const assetRow = el("div", null, "wallet-asset");
        assetRow.append(el("strong", `${asset.symbol} · ${asset.enabled ? "已启用" : "已停用"}`), details("代币合约与固定测试汇率", [["完整代币合约", asset.contractAddress], ["资产身份", asset.assetId], ["小数位", asset.decimals], ["链上小数位", asset.onchainDecimals], ["汇率（nanoUSD / token）", asset.nanosPerToken ?? asset.pricing?.nanosPerToken], ["价格版本", asset.priceVersion ?? asset.pricing?.version], ["测试网限制", asset.testnetOnly === false ? "需要核验" : "仅测试网"]]), button(asset.enabled ? "停用此测试代币" : "启用此测试代币", () => confirm(asset.enabled ? "停用此测试代币" : "启用此测试代币", "资产身份由网络和合约共同确定。此操作不会修改历史入账。", "wallet-asset-toggle", { assetId: asset.assetId, enabled: !asset.enabled })));
        row.append(assetRow);
      }
      const actions = el("div", null, "workflow-actions");
      actions.append(button("编辑 RPC", () => editRpc(network)), button(network.enabled ? "停用网络" : "启用网络", () => confirm(network.enabled ? "停用网络" : "启用网络", "只调整当前测试网配置。停止定时观察不代表已中断正在执行的扫描。", "wallet-network", { chainId: network.chainId, enabled: !network.enabled })), button("设置收款地址", () => editReceiving(network)), button("注册测试代币", () => registerAsset(network)), button("扫描此网络", () => confirm("扫描此网络", "主动扫描可能通过既有观察器验证、归属并应用真实账本入账。扫描返回不代表密钥额度已验证，请随后刷新证据。", "wallet-scan", { chainId: network.chainId })));
      row.append(actions);
      diagnosticRows.append(row);
    }
  }
  function receivingAddress(network) { return rows(obj(state.wallet).receiving).find((row) => row.chainId === network.chainId)?.address; }
  function editRpc(network) {
    openDialog(`编辑 ${network.displayName} RPC`, (root) => {
      root.append(p("已有 RPC 地址不会回显。仅在需要替换时填写，每行一个 HTTP(S) 地址；内容只提交给本机服务。留空不更改。"));
      const endpoints = el("textarea"); endpoints.rows = 4; endpoints.autocomplete = "off"; endpoints.maxLength = 8192; endpoints.setAttribute("aria-label", "新的 RPC 地址，每行一个"); endpoints.setAttribute("data-1p-ignore", ""); endpoints.setAttribute("data-bwignore", "");
      const agree = check("我确认这些 RPC 属于所选测试网，并明确替换已有端点");
      root.append(endpoints, agree.label, button("保存 RPC 配置", () => {
        const values = [...new Set(endpoints.value.split(/\s+/).filter(Boolean))];
        if (!values.length) { closeDialog(); return; }
        if (!agree.input.checked) { fail("请确认要替换此网络的 RPC 配置。"); return; }
        if (values.some((value) => { try { return !["http:", "https:"].includes(new URL(value).protocol); } catch { return true; } })) { fail("RPC 需要有效的 HTTP(S) 地址。"); return; }
        endpoints.value = ""; const input = { chainId: network.chainId, rpcEndpoints: values };
        void run("wallet-network", input, () => closeDialog()).finally(() => { input.rpcEndpoints = []; values.fill(""); });
      }, true));
    });
  }
  function editReceiving(network) {
    openDialog(`设置 ${network.displayName} 收款地址`, (root) => {
      root.append(p("填写你在该测试网上控制的公开收款地址。这里不需要私钥；更新不会改变既有申请已绑定的收款地址。"));
      const address = field("公开收款地址"); address.input.maxLength = 42;
      const agree = check("我已核对完整地址与所选测试网");
      root.append(address.label, agree.label, button("保存此网络收款地址", () => {
        const value = address.input.value.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value) || !agree.input.checked) { fail("请填写非零的完整公开地址，并确认所选网络。"); return; }
        void run("wallet-receiving", { chainId: network.chainId, address: value }, () => closeDialog());
      }, true));
    });
  }
  function registerAsset(network) {
    openDialog(`注册 ${network.displayName} 测试代币`, (root) => {
      root.append(p("服务将从所选网络读取 decimals 并核对。只允许明确的测试 / mock 资产；固定测试换算率不会跨链或自动随价格变化。"));
      const contract = field("完整代币合约地址"); const symbol = field("测试代币符号（test / mock 或 t 前缀）"); const name = field("测试代币名称");
      const decimals = field("预期小数位", "number"); decimals.input.min = "0"; decimals.input.max = "36"; decimals.input.step = "1";
      const rate = field("每个完整 token 的 nanoUSD（正整数字符串）"); rate.input.inputMode = "numeric";
      rate.label.append(el("small", "单位换算：1 USD = 1,000,000,000 nanoUSD。例如每个 token 按 1 USD 计，填写 1,000,000,000 对应的纯数字（去掉逗号）。此处仅设置固定测试汇率。"));
      const note = field("固定测试汇率说明"); const agree = check("我确认这是所选测试网上的测试代币，且已核对合约和汇率");
      root.append(contract.label, symbol.label, name.label, decimals.label, rate.label, note.label, agree.label, button("核对链上小数位并注册", () => {
        if (!agree.input.checked || !/^0x[0-9a-fA-F]{40}$/.test(contract.input.value.trim()) || !/^\d+$/.test(decimals.input.value) || !/^[1-9]\d*$/.test(rate.input.value.trim()) || !symbol.input.value.trim() || !name.input.value.trim() || !note.input.value.trim()) { fail("请完整填写测试代币字段并明确确认，汇率必须是正整数字符串。"); return; }
        void run("wallet-asset-register", { chainId: network.chainId, contractAddress: contract.input.value.trim(), symbol: symbol.input.value.trim(), name: name.input.value.trim(), expectedDecimals: Number(decimals.input.value), nanosPerToken: rate.input.value.trim(), pricingNote: note.input.value.trim() }, () => closeDialog());
      }, true));
    });
  }
  function networkChoices() { return rows(state.wallet?.registry?.networks).filter((row) => TEST_CHAINS.includes(row.chainId) && row.enabled).map((row) => [row.chainId, row.displayName]); }
  function createIntent() {
    if (creationPending) { notice("上次创建结果尚未确认。请先刷新视图，检查已有申请或待核对操作，再继续。", "warn"); return; }
    openDialog("明确选择入账申请", (root) => {
      const consumers = rows(state.wallet?.consumers).filter((consumer) => !consumer.revokedAt);
      const consumer = select("本机已授权伙伴", consumers.map((row) => [row.consumerId, `${row.consumerId}${row.paused ? " · 已暂停" : ""}`]), "请选择伙伴");
      const chain = select("测试网络", networkChoices(), "请选择网络，不会自动选择");
      const providerOwners = [...new Map(rows(state.wallet?.receiving).filter((row) => row.providerId).map((row) => [row.providerId, row.providerId])).entries()];
      const legacyOwner = select("收款配置归属（兼容已有配置）", providerOwners, "使用本机节点的收款配置");
      const asset = select("测试代币", [], "请先选择网络");
      const amount = field("准确 token 数量（十进制）"); amount.input.inputMode = "decimal"; amount.input.placeholder = "例如 1.000001";
      const ttl = field("有效期（秒，60–604800）", "number", "3600"); ttl.input.min = "60"; ttl.input.max = "604800"; ttl.input.step = "1";
      chain.input.addEventListener("change", () => {
        asset.input.replaceChildren(option("", "请选择此网络的测试代币")); asset.input.value = "";
        for (const row of rows(state.wallet?.registry?.assets).filter((row) => row.chainId === explicitNetwork(chain.input.value) && row.enabled)) asset.input.append(option(row.assetId, `${row.symbol} · ${row.decimals} 位小数`));
      });
      root.append(p("网络、伙伴和代币均需手动选择。这里只提交十进制数量；服务端负责精度、原始金额、收款人和汇率核验。"), consumer.label, chain.label, asset.label, amount.label, ttl.label);
      if (providerOwners.length) root.append(legacyOwner.label);
      root.append(button("预览精确申请内容", () => {
        const selectedAsset = rows(state.wallet?.registry?.assets).find((row) => row.assetId === asset.input.value && row.chainId === explicitNetwork(chain.input.value));
        if (!consumer.input.value || !explicitNetwork(chain.input.value) || !selectedAsset || !validTokenAmount(amount.input.value.trim(), selectedAsset.decimals) || !Number.isInteger(Number(ttl.input.value)) || Number(ttl.input.value) < 60 || Number(ttl.input.value) > 604800) { fail("请明确选择伙伴、网络和代币，输入大于零且不超出代币精度的十进制数量，并检查有效期。"); return; }
        const input = { consumerId: consumer.input.value, chainId: explicitNetwork(chain.input.value), assetId: asset.input.value, amount: amount.input.value.trim(), ttlSec: Number(ttl.input.value), ...(legacyOwner.input.value ? { providerId: legacyOwner.input.value } : {}) };
        void run("wallet-intent-preview", input, (result) => confirmIntent(input, result.preview), { refresh: false });
      }, true));
    });
  }
  function confirmIntent(input, preview) {
    openDialog("核对并创建入账申请", (root) => {
      root.append(details("精确申请内容", [["伙伴", preview.consumerId], ["网络 chainId", preview.chainId], ["代币", `${preview.symbol} · ${preview.assetId}`], ["完整收款地址", preview.recipientAddress], ["token 数量", preview.amountTokens], ["原始金额", preview.amountRaw], ["小数位", preview.decimals], ["固定测试换算", usd(preview.estimatedUsd)], ["有效期（秒）", preview.ttlSec], ["预览指纹", preview.previewHash]], true));
      if (rows(preview.pending).length || rows(preview.blockers).length) root.append(el("p", [...rows(preview.blockers), ...(rows(preview.pending).length ? ["已有未完成申请，请关闭窗口后从申请列表恢复或明确取消。"] : [])].join("；"), "inline-warning"));
      if (preview.paused) root.append(el("p", "此伙伴已暂停。收到入账也不会自动解除计费保护或重新签发密钥。", "inline-warning"));
      const agree = check(preview.paused ? "我已核对申请，知晓伙伴暂停会保留，并明确创建此申请" : "我已核对网络、代币、金额、收款地址和有效期，明确创建此申请");
      const requestId = crypto.randomUUID(); let submitted = false;
      const submit = button("确认创建一次申请", () => {
        if (submitted || !agree.input.checked) return;
        submitted = true; submit.disabled = true;
        void run("wallet-intent-create", { ...input, requestId, previewHash: preview.previewHash, ...(preview.paused ? { ackPaused: true } : {}) }, (result) => { creationPending = false; showDocument(result.document, result.transfer); });
      }, true);
      submit.dataset.createsIntent = "true"; submit.disabled = true;
      agree.input.addEventListener("change", () => { submit.disabled = submitted || !agree.input.checked || rows(preview.pending).length > 0 || rows(preview.blockers).length > 0; });
      root.append(agree.label, submit);
    });
  }
  function documentDetails(document) {
    return details("完整网络、金额与签名内容", [["申请编号", document.invoiceId], ["付款伙伴", document.consumerId], ["共享方", document.providerId], ["测试网络 chainId", document.chainId], ["完整代币合约", document.asset?.contractAddress], ["代币", document.asset?.symbol], ["小数位", document.asset?.decimals], ["准确 token 数量", document.amount?.tokens], ["原始金额", document.amount?.raw], ["完整收款地址", document.recipientAddress], ["有效期", document.expiresAt], ["签名摘要", document.digest], ["签名类型", "EIP-712 DepositIntent，签名不执行转账"]], true);
  }
  function showDocument(document, transfer) {
    openDialog(transfer ? "签名已验证 · 准确转账指引" : "入账申请已生成 · 等待付款方签名", (root) => {
      root.append(p(transfer ? "签名已验证。下方是此申请绑定的准确转账指引，由付款方在自己的外部钱包核对并执行；此页不广播转账。" : "把申请文件交给付款方，由对方在自己的外部钱包中核对并签名。此阶段没有付款，也没有入账；不要在签名核验前使用任何转账指引。"), documentDetails(document));
      const actions = el("div", null, "workflow-actions"); actions.append(button("下载入账申请文件", () => { if (retainedDocument) download(retainedDocument, "aihub-deposit-request.json"); }, true), button("下载外部钱包签名数据", () => { if (retainedDocument) download(retainedDocument.typedData, "aihub-eip712-signing-data.json"); }));
      root.append(actions);
      if (transfer) root.append(transferDetails(transfer), button("下载准确转账指引", () => download({ schema: "ohmyaihub.transfer-instructions/v1", ...transfer }, "aihub-transfer-instructions.json"), true));
    });
    retainedDocument = document;
  }
  function transferDetails(transfer) {
    return details("已验证签名对应的准确转账指引", [["网络 chainId", transfer.chainId], ["完整代币合约", transfer.contractAddress], ["代币", transfer.symbol], ["准确 token 数量", transfer.amountTokens], ["原始金额", transfer.amountRaw], ["完整收款地址", transfer.recipientAddress], ["已验证付款地址", transfer.payerAddress], ["申请编号", transfer.invoiceId], ["有效期", transfer.expiresAt], ["执行位置", "付款方自己的钱包；本应用不签发或广播转账"]], true);
  }
  function importSignature(intent) {
    openDialog("导入付款方签名文件", (root) => {
      root.append(p("选择付款方外部钱包导出的签名文件。服务端将针对本机保存的这份申请恢复并核对付款地址，文件中的其他签名域不能覆盖原申请。"));
      const file = fileInput(root, "签名文件");
      const agree = check("我已核对签名文件对应此申请，并明确验证付款地址");
      root.append(agree.label, button("核验签名并读取转账指引", async () => {
        if (!agree.input.checked) { fail("请先确认签名文件用途。"); return; }
        try {
          const document = await readFile(file, 8 * 1024);
          file.value = "";
          await run("wallet-signature-import", { consumerId: intent.consumerId, invoiceId: intent.invoiceId, document }, (result) => {
            openDialog("签名核验已返回", (body) => {
              if (!result.transfer) { body.append(el("p", "尚未取得可执行的转账指引，请刷新申请状态，不要再次提交签名或转账。", "inline-warning")); return; }
              body.append(p("共享方已验证签名归属。请把准确指引交给付款方，由其在自己的钱包中核对并执行转账。"), transferDetails(result.transfer), button("下载准确转账指引", () => download({ schema: "ohmyaihub.transfer-instructions/v1", ...result.transfer }, "aihub-transfer-instructions.json"), true));
            });
          });
          delete document.signature;
        } catch (cause) { fail(cause.message); }
      }, true));
    });
  }
  function fileInput(root, label) { const wrapper = el("label", null, "field"); wrapper.append(el("span", label)); const input = el("input"); input.type = "file"; input.accept = ".json,application/json"; wrapper.append(input); root.append(wrapper); return input; }
  async function readFile(input, max = 64 * 1024) {
    const file = input.files?.[0]; if (!file) throw new Error("请选择收到的 AIHub 文件。");
    if (file.size > max) throw new Error("文件过大，请选择此步骤对应的完整文件。");
    return parseTransportDocument(await file.text());
  }
  function importFile(kind) {
    openDialog(kind === "deposit" ? "使用方核对入账申请" : "导入共享方账单", (root) => {
      root.append(p(kind === "deposit" ? "请选择共享方提供的完整入账申请文件。将先核对真实 EIP-712 类型、摘要及申请字段一致性；不会连接对方管理接口，也不会创建付款。" : "账单只代表共享方提供的未签名记录。摘要校验只能发现内容变化，不能证明付款或对方身份。"));
      const file = fileInput(root, kind === "deposit" ? "共享方入账申请文件" : "共享方账单文件");
      root.append(button("验证文件并预览", async () => {
        try {
          const document = await readFile(file); file.value = "";
          await run(kind === "deposit" ? "deposit-document-preview" : "wallet-statement-preview", { document }, (result) => {
            if (kind === "deposit") {
              const verified = result.document || result.preview?.document;
              if (!verified) { fail("未收到通过验证的申请，请向共享方重新索取文件。"); return; }
              openDialog("使用方 · 外部钱包签名指南", (body) => {
                body.append(p("文件的一致性已核验。请通过可信渠道确认共享方身份和收款地址，再用自己的外部钱包查看并签署 EIP-712 数据。只签名不会转账；将签名文件交回共享方后，等待其核验并给出转账指引。"), documentDetails(verified), button("下载已核验的入账申请", () => { if (retainedDocument) download(retainedDocument, "aihub-reviewed-deposit-request.json"); }, true), button("下载外部钱包签名数据", () => { if (retainedDocument) download(retainedDocument.typedData, "aihub-eip712-signing-data.json"); }), button("把钱包签名整理为交付文件", () => { if (retainedDocument) packageSignature(retainedDocument); }));
              });
              retainedDocument = verified;
              if (typeof globalThis.window?.ethereum?.request === "function") body.append(button("使用浏览器钱包签名", () => { if (retainedDocument) signWithBrowserWallet(retainedDocument); }));
            } else {
              externalStatement = result.statement || result.document || result;
              closeDialog(); renderExternalStatement();
            }
          }, { refresh: false });
        } catch (cause) { fail(cause.message); }
      }, true));
    });
  }
  function showSignatureDelivery(document) {
    openDialog("签名文件已生成 · 交回共享方", (root) => {
      root.append(p("本机已核验申请与签名付款地址一致。请通过私密渠道将文件交回共享方，等待其验证并提供准确转账指引。此文件不是付款回执。"), details("签名交付信息", [["申请编号", document.invoiceId], ["核验付款地址", document.payerAddress]]), button("下载签名交付文件", () => { if (retainedDocument) download(retainedDocument, "aihub-deposit-signature.json"); }, true));
    });
    retainedDocument = document;
  }
  function signWithBrowserWallet(document) {
    const provider = globalThis.window?.ethereum;
    if (typeof provider?.request !== "function") { notice("此浏览器没有可用钱包，请使用外部钱包签名数据与文件交接流程。", "warn"); return; }
    openDialog("使用方 · 浏览器钱包签名", (root) => {
      root.append(p("此操作只签署归属申请，不发起转账。点击后才会请求钱包账户；请在钱包确认界面核对网络、合约、收款地址与准确金额。网络不匹配时，请自行在钱包中切换，再重新点击。"), documentDetails(document));
      const agree = check("我已核对完整申请，明确请求钱包签署这份 EIP-712 数据");
      let signing = false;
      const sign = button("连接钱包并请求签名", async () => {
        if (signing || !agree.input.checked) return;
        signing = true; sign.disabled = true;
        const expected = generation;
        let signature = null;
        let payerAddress = null;
        try {
          if (Date.parse(document.expiresAt) <= Date.now()) { fail("申请已过期，请向共享方索取新的申请。"); return; }
          const accounts = await provider.request({ method: "eth_requestAccounts" });
          if (generation !== expected || !getState()) return;
          payerAddress = rows(accounts)[0];
          if (typeof payerAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) { fail("钱包未返回有效公开账户，请检查钱包后再试。"); return; }
          const chainId = await provider.request({ method: "eth_chainId" });
          if (generation !== expected || !getState()) return;
          if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId) || BigInt(chainId) !== BigInt(document.chainId)) { fail(`钱包当前网络与申请的 chainId ${document.chainId} 不一致。请手动在钱包中切换到此测试网，再重新点击；本应用不会自动切换网络。`); return; }
          signature = await provider.request({ method: "eth_signTypedData_v4", params: [payerAddress, JSON.stringify(document.typedData)] });
          if (generation !== expected || !getState()) return;
          if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) { fail("钱包返回的签名格式无法识别，尚未生成签名文件。"); return; }
          const input = { document, signature, payerAddress };
          await run("deposit-signature-document", input, (result) => showSignatureDelivery(result.document), { refresh: false });
          delete input.signature;
        } catch (cause) {
          if (generation === expected && getState()) fail(cause?.code === 4001 || cause?.code === "ACTION_REJECTED" ? "你已取消钱包连接或签名。未提交签名，也未执行转账。" : "钱包连接或签名未完成。请检查钱包，或使用外部钱包文件流程；不要重复转账。");
        } finally {
          signature = null; payerAddress = null; signing = false;
          if (generation === expected) sign.disabled = !agree.input.checked;
        }
      }, true);
      sign.disabled = true; agree.input.addEventListener("change", () => { sign.disabled = signing || !agree.input.checked; }); root.append(agree.label, sign);
    });
    retainedDocument = document;
  }
  function packageSignature(document) {
    openDialog("使用方 · 整理外部钱包签名", (root) => {
      root.append(p("先在自己的外部钱包中查看并签署该申请的 EIP-712 数据，再填入钱包给出的签名和公开付款地址。此页面不需要私钥、助记词或钱包备份。会核对签名确实属于此申请与付款地址。"), documentDetails(document));
      const payer = field("签名钱包的公开付款地址"); payer.input.maxLength = 42;
      const signature = field("钱包返回的 65 字节签名（0x 开头）"); signature.input.maxLength = 132;
      const agree = check("我已在自己的钱包核对并签名，仅整理签名文件，不执行转账");
      root.append(payer.label, signature.label, agree.label, button("核验并生成签名交付文件", async () => {
        if (!agree.input.checked || !/^0x[0-9a-fA-F]{40}$/.test(payer.input.value.trim()) || !/^0x[0-9a-fA-F]{130}$/.test(signature.input.value.trim())) { fail("请填写完整公开付款地址与钱包返回的签名，并确认用途；不要输入私钥。"); return; }
        const input = { document: retainedDocument, payerAddress: payer.input.value.trim(), signature: signature.input.value.trim() };
        payer.input.value = ""; signature.input.value = "";
        await run("deposit-signature-document", input, (result) => {
          showSignatureDelivery(result.document);
        }, { refresh: false });
        delete input.signature;
      }, true));
    });
    retainedDocument = document;
  }
  function renderIntents() {
    intentRows.replaceChildren();
    const wallet = obj(state.wallet);
    const operations = rows(wallet.intentOperations).filter((operation) => ["pending", "reserved", "unknown"].includes(operation.status || operation.state));
    creationPending = operations.length > 0;
    for (const operation of operations) intentRows.append(el("p", `待核对的创建操作：${operation.consumerId} · ${operation.requestId} · ${operation.status || operation.state}。请核对已有申请；不会自动补建。`, "inline-warning"));
    const existing = rows(wallet.intents);
    if (!existing.length && !operations.length) { intentRows.append(empty("还没有入账申请", "先注册所选测试网代币与收款地址，再为已授权伙伴明确创建申请。")); return; }
    for (const intent of existing) {
      const journey = rows(wallet.view?.deposits).find((row) => row.invoiceId === intent.invoiceId);
      const row = el("article", null, "workflow-row");
      const top = el("div", null, "section-heading"); top.append(el("h3", `${intent.consumerId} · 入账申请`), pill(depositLabel(journey?.state || intent.status), ["uncertain", "unproven", "failed", "reverted"].includes(journey?.state) ? "warn" : "neutral"));
      row.append(top, details("申请、地址与金额", [["申请编号", intent.invoiceId], ["网络 chainId", intent.chainId], ["资产身份", intent.assetId], ["原始金额", intent.expectedAmountRaw], ["完整收款地址", intent.recipientAddress], ["付款地址", intent.payerAddress], ["有效期", intent.expiresAt], ["更新时间", journey?.updatedAt]]), p(journeyNext(journey?.state || intent.status)));
      if (journey) {
        const timeline = el("ol", null, "wallet-timeline");
        for (const step of rows(journey.steps)) { const item = el("li", null, `timeline-${step.state}`); item.append(el("strong", stepLabels[step.id] || "核验步骤"), pill(stepStates[step.state] || "未知"), p(step.at ? stamp(step.at) : "未记录核验时间")); if (step.detail) item.append(details("核验详情", [["证据", step.detail]])); timeline.append(item); }
        row.append(timeline);
        if (journey.keyUsable) row.append(el("p", "最近证据曾核验密钥覆盖本次入账；仍需查看当前计费状态与共享发布状态。", "soft-note"));
      }
      const actions = el("div", null, "workflow-actions");
      if (["requested", "signed"].includes(intent.status)) {
        actions.append(button(intent.status === "signed" ? "恢复申请与转账指引" : "恢复并下载申请", () => void run("wallet-intent-document", { consumerId: intent.consumerId, invoiceId: intent.invoiceId }, (result) => showDocument(result.document, result.transfer), { refresh: false })));
        if (intent.status === "requested") actions.append(button("导入付款方签名", () => importSignature(intent)));
        actions.append(button("取消此申请", () => confirm("取消此申请", "取消后保留历史记录。若付款方已经发起转账，请先核对，取消不会撤回链上转账。", "wallet-intent-cancel", { consumerId: intent.consumerId, invoiceId: intent.invoiceId, reason: "操作者已核对并明确取消此申请" })));
      }
      actions.append(button("刷新此伙伴入账证据", () => void run("wallet-refresh", { consumerId: intent.consumerId, probeRpc: true })));
      row.append(actions); intentRows.append(row);
    }
    for (const journey of rows(wallet.view?.deposits).filter((row) => !row.invoiceId || !existing.some((intent) => intent.invoiceId === row.invoiceId))) {
      const row = el("article", null, "workflow-row"); row.append(el("h3", `${journey.chainName || journey.chainId} · ${depositLabel(journey.state)}`), p(journeyNext(journey.state)), details("独立链事件证据", [["交易哈希", journey.txHash], ["原始金额", journey.amountRaw], ["账本入账", usd(journey.creditedUsd)], ["更新时间", journey.updatedAt]])); intentRows.append(row);
    }
  }
  function renderAlerts() {
    alertRows.replaceChildren();
    for (const alert of rows(state.wallet?.view?.alerts)) {
      const row = el("article", null, "workflow-row"); row.append(el("h3", alert.kind || "核验提醒"), p(journeyNext(alert.kind)), details("异常证据详情", [["网络", alert.chainId], ["伙伴", alert.consumerId], ["记录时间", alert.at], ["诊断", alert.detail]])); alertRows.append(row);
    }
    for (const anomaly of rows(state.wallet?.anomalies)) {
      const row = el("article", null, "workflow-row"); row.append(el("h3", `审计异常 · ${anomaly.kind || anomaly.type || anomaly.id}`), details("审计证据", [["网络", anomaly.chainId], ["时间", anomaly.createdAt || anomaly.at], ["说明", anomaly.detail || anomaly.reason], ["审阅时间", anomaly.resolvedAt], ["审阅说明", anomaly.resolutionNote || anomaly.note]]));
      if (!anomaly.resolvedAt) row.append(button("记录审阅说明", () => auditAnomaly(anomaly)));
      alertRows.append(row);
    }
    if (!alertRows.children.length) alertRows.append(empty("当前视图没有异常记录", "没有显示异常不代表链或账目已经核验，请同时查看主动核验时间。"));
  }
  function auditAnomaly(anomaly) {
    openDialog("记录审阅说明", (root) => {
      root.append(p("此操作仅标记审阅并写入审计说明，不补记、不回滚、不解冻。")); const note = field("说明"); const agree = check("我理解这只记录审计处理，不改变财务状态");
      root.append(note.label, agree.label, button("保存审阅说明", () => {
        if (!note.input.value.trim() || !agree.input.checked) { fail("请填写具体说明并确认处理边界。"); return; }
        void run("wallet-anomaly-resolve", { id: anomaly.id, note: note.input.value.trim() }, () => closeDialog());
      }, true));
    });
  }

  // Private per-consumer accounting and unsigned statement exchange.
  const accountingHeading = el("div", null, "section-heading");
  accountingHeading.append(el("h2", "账本与离线账单"), button("刷新账目检查", () => void run("accounting-refresh", selectedConsumer ? { consumerId: selectedConsumer } : {})));
  accountingRoot.append(accountingHeading, p("累计入账、已结算用量、余额和原生额度来自既有账本；未知状态不会按零计算。这是既有会计路径，不是 Phase 10 的无文件目标。", "muted"));
  const accountingIntro = section("选择本机管理的伙伴", "共享方只查看自己管理的伙伴账目。使用方可导入共享方交付的未签名账单，并在“我的连接”查看对方原生限额回读。");
  const consumerSelect = select("伙伴账目", [], "请选择伙伴，不会自动选择"); accountingIntro.append(consumerSelect.label);
  consumerSelect.input.addEventListener("change", () => { closeDialog(); selectedConsumer = consumerSelect.input.value; renderAccounting(); });
  const accountContent = el("div"); accountingRoot.append(accountingIntro, accountContent);
  const external = section("使用方 · 已导入的共享方账单（离线文件）", "这是共享方提供的未签名快照。摘要只验证内容一致性，不证明身份、付款或链上最终性；请独立核对。"), externalContent = el("div");
  external.append(button("导入共享方账单", () => importFile("statement")), externalContent); accountingRoot.append(external);
  function renderConsumerOptions() {
    const value = selectedConsumer;
    consumerSelect.input.replaceChildren(option("", "请选择伙伴，不会自动选择"));
    for (const consumer of rows(state.status.consumers)) consumerSelect.input.append(option(consumer.consumerId, `${consumer.consumerId}${consumer.revokedAt ? " · 已撤销" : consumer.paused ? " · 已暂停" : ""}`));
    selectedConsumer = rows(state.status.consumers).some((consumer) => consumer.consumerId === value) ? value : "";
    consumerSelect.input.value = selectedConsumer;
    if (value !== selectedConsumer) closeDialog();
  }
  function showConsumptionHistory(consumerId, cursor = null, previous = []) {
    openDialog("消费记录", (root) => {
      root.append(p(`伙伴：${consumerId}。每页最多 50 条；显示账本已记录的费用与价格版本，不按当前价格重新计算。`), p("正在读取消费记录…"));
      void run("accounting-history", { consumerId, ...(cursor ? { cursor } : {}) }, (result) => {
        root.replaceChildren(p(`伙伴：${consumerId}。每页最多 50 条；显示账本已记录的费用与价格版本，不按当前价格重新计算。`));
        const entries = rows(result.rows);
        if (!entries.length) root.append(p("此页没有已记录的消费。缺失或未结算用量仍需结合账目状态判断，不能据此推断为零。"));
        for (const row of entries) {
          const amount = typeof row.amountUsd === "number" && Number.isFinite(row.amountUsd) ? `$${row.amountUsd.toFixed(9)}` : "未知";
          const tokens = obj(row.tokens);
          root.append(details(`${stamp(row.recordedAt)} · ${row.kind === "adjustment" ? "历史调整" : "模型调用"} · ${amount}`, [
            ["模型", row.model], ["记录费用", amount], ["精确费用（nanoUSD）", row.amountNanos],
            ["记录时间", row.recordedAt], ["价格版本", row.priceVersion], ["原账期窗口", row.windowId],
            ["价格已核验", row.priceVerified === true ? "已核验" : "未核验，记录金额不能视为最终费用"],
            ["输入 token", tokens.input], ["输出 token", tokens.output], ["缓存读取 token", tokens.cacheRead],
            ["缓存写入 token", tokens.cacheWrite], ["一小时缓存写入 token", tokens.cacheWrite1h],
          ]));
        }
        const controls = el("div", null, "workflow-actions");
        const back = button("上一页", () => showConsumptionHistory(consumerId, previous.at(-1), previous.slice(0, -1)));
        back.disabled = previous.length === 0;
        const next = button("下一页", () => showConsumptionHistory(consumerId, result.nextCursor, [...previous, cursor]));
        next.disabled = typeof result.nextCursor !== "string" || !result.nextCursor;
        controls.append(back, next); root.append(controls);
      }, { refresh: false });
    });
  }
  function renderAccounting() {
    accountContent.replaceChildren();
    const consumer = rows(state.status.consumers).find((row) => row.consumerId === selectedConsumer);
    if (!consumer) { accountContent.append(empty("请选择伙伴查看私有账目", "不会自动选择伙伴，也不会向使用方公开共享方的其他账户。")); return; }
    const account = rows(state.wallet?.view?.consumers).find((row) => row.consumerId === selectedConsumer);
    const ledger = obj(consumer.ledger);
    const card = section(consumer.consumerId);
    const verifiedCap = account?.capUsd;
    const unsafe = typeof verifiedCap === "number" && verifiedCap <= 0;
    const label = unsafe ? "额度上限不安全" : account ? keyLabel(account.state) : "账目尚未主动核验";
    const healthy = account?.state === "usable" && account?.accounting?.state === "ok" && account?.accounting?.serving === true && typeof verifiedCap === "number" && verifiedCap > 0 && account?.readback?.fromGateway === true;
    card.append(pill(label, healthy ? "good" : "warn"), p(`本地视图 ${stamp(state.wallet?.viewAt)} · 最近主动证据 ${stamp(state.wallet?.evidenceAt)} · 原生额度回读 ${stamp(account?.readback?.at)}`));
    const values = el("div", null, "wallet-account-grid");
    for (const [name, value] of [["累计入账", account?.cumulativeCreditUsd ?? ledger.depositedUsd], ["累计消耗", account?.consumedUsd ?? ledger.consumedUsd], ["已结算消耗", account?.settledUsd], ["账本余额", account?.balanceUsd ?? ledger.balanceUsd], ["超支", account?.overdraftUsd ?? ledger.overdraftUsd], ["尚未结算", account?.unsettledUsd ?? ledger.unsettledUsd]]) { const tile = el("div"); tile.append(p(name), el("strong", usd(value))); values.append(tile); }
    card.append(values, details("原生额度、模型与价格窗口", [["最近核验额度上限", capLabel(verifiedCap)], ["最近核验已用", usd(account?.usedUsd)], ["最近核验剩余", usd(account?.leftUsd)], ["记录的额度上限（非当前回读）", capLabel(consumer.capUsd)], ["允许模型", rows(consumer.models).join("、")], ["价格版本", account?.priceVersion || consumer.priceVersion], ["已接受报价", consumer.acceptedQuoteHash], ["窗口结束", account?.windowEnd || consumer.reset], ["待结算窗口", account?.openSettlements ?? ledger.openSettlements], ["计费状态", account?.accounting?.state || "unknown"], ["共享发布", account?.accounting?.serving === true ? "最近证据中发布" : "未知或已撤回"], ["暂停原因", consumer.paused?.reason], ["暂停执行层级", consumer.paused?.enforcement], ["保护已执行", consumer.paused ? consumer.paused.enforced === true ? "已证实撤销或轮换旧密钥" : "未证实完全阻止，需检查网络发布" : "未暂停"], ["计费不确定性", ledger.uncertain]]));
    card.append(el("p", "401 表示访问授权未被接受；429 是 Magpie 原生限额拒绝；RPC 不可读表示链证据未知；计费保护暂停需要核对原因，不能靠重复转账或清零额度解除。", "soft-note"));
    const actions = el("div", null, "workflow-actions");
    actions.append(button("查看消费记录", () => showConsumptionHistory(consumer.consumerId)));
    actions.append(button("核验此伙伴账目与额度", () => void run("wallet-refresh", { consumerId: consumer.consumerId, probeRpc: false })), button("导出此伙伴账单", () => void run("wallet-statement", { consumerId: consumer.consumerId }, (result) => {
      const document = result.statement?.statement ? result.statement : result.document || result;
      openDialog("导出未签名账单", (root) => { root.append(p("此账单来自本机账本与已获取的核验记录。文件摘要只能用于内容完整性核对，不是签名或付款证明。只包含此伙伴的记录，不包含访问密钥。"), button("下载此伙伴账单", () => download(document, "aihub-consumer-statement.json"), true)); });
    }, { refresh: false })));
    if (!consumer.revokedAt) actions.append(button("核对并重新签发", () => void run("consumer-check", { consumerId: consumer.consumerId }, (preview) => reissue(consumer, preview))));
    if (!consumer.revokedAt) actions.append(button("撤销旧版伙伴授权（高级）", () => confirm("撤销旧版伙伴授权（高级）", "原有访问密钥会失效，账目保留。撤销不会退还或重建任何费用。", "consumer-revoke", { consumerId: consumer.consumerId })));
    card.append(actions);
    for (const gap of rows(ledger.gaps).filter((gap) => !gap.resolvedAt)) {
      const node = el("div", null, "wallet-gap"); node.append(el("p", "存在尚未解决的使用日志缺口，历史费用可能缺失。", "inline-warning"), details("日志缺口证据", [["日志标识", gap.logId], ["原因", gap.reason]]), button("审计并接受当前基线", () => resolveGap(consumer, gap))); card.append(node);
    }
    accountContent.append(card);
    const depositRows = section("此伙伴的入账过程与链记录");
    for (const deposit of rows(state.wallet?.view?.deposits).filter((row) => row.consumerId === selectedConsumer)) depositRows.append(details(`${deposit.chainName || deposit.chainId} · ${depositLabel(deposit.state)}`, [["申请", deposit.invoiceId], ["交易哈希", deposit.txHash], ["原始金额", deposit.amountRaw], ["准确 token 数量", deposit.amountTokens], ["记录入账", usd(deposit.creditedUsd)], ["最近证据", deposit.updatedAt]]));
    if (depositRows.children.length === 1) depositRows.append(p("当前有界视图没有此伙伴的链记录。账本余额不能由此推断为零。"));
    accountContent.append(depositRows);
  }
  function reissue(consumer, preview) {
    openDialog("核对价格并重新签发", (root) => {
      root.append(p("重新签发不会重置使用记录、补建费用或增加余额。缺口与不确定性必须先核对。"), details("精确价格绑定", [["伙伴", consumer.consumerId], ["模型", rows(consumer.models).join("、")], ["原价格版本", consumer.priceVersion], ["当前价格版本", preview.currentPriceVersion], ["当前报价", preview.currentQuoteHash]], true));
      if (!preview.currentPriceVersion || !preview.currentQuoteHash) { root.append(el("p", "当前没有覆盖此伙伴模型的完整价格报价，暂时不能重新签发。", "inline-warning")); return; }
      const agree = check("我明确接受当前完整价格与报价，并要求重新签发"); const submit = button("确认接受并重新签发", () => { if (agree.input.checked) void run("consumer-reissue", { consumerId: consumer.consumerId, acceptPriceVersion: preview.currentPriceVersion, acceptQuoteHash: preview.currentQuoteHash }, () => closeDialog()); }, true);
      submit.disabled = true; agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; }); root.append(agree.label, submit);
    });
  }
  function resolveGap(consumer, gap) {
    openDialog("审计使用日志缺口", (root) => {
      root.append(p("接受当前日志位置作为后续基线。缺失费用不会自动重建或补偿；历史缺口与审计说明保留，此操作也不会自动重新签发密钥。"), details("当前缺口", [["伙伴", consumer.consumerId], ["日志", gap.logId], ["原因", gap.reason]]));
      const by = field("审计责任人"); const note = field("接受此基线的具体审计说明"); const agree = check("我已审计缺失范围，并接受当前基线，知晓不会重建缺失费用");
      root.append(by.label, note.label, agree.label, button("记录审计并接受基线", () => {
        if (!agree.input.checked || !by.input.value.trim() || !note.input.value.trim()) { fail("请填写责任人与具体说明，并明确接受处理边界。"); return; }
        void run("usage-gap-resolve", { consumerId: consumer.consumerId, logId: gap.logId, resolvedBy: by.input.value.trim(), note: note.input.value.trim() }, () => closeDialog());
      }, true));
    });
  }
  function renderExternalStatement() {
    externalContent.replaceChildren();
    if (!externalStatement) { externalContent.append(empty("尚未导入共享方账单", "文件只在此页内存中展示，关闭或会话结束后清除。")); return; }
    const statement = externalStatement.statement || externalStatement;
    externalContent.append(pill("未签名快照 · 不代表付款证明", "warn"), details("共享方账单摘要", [["共享方", statement.providerId], ["伙伴", statement.consumerId], ["生成时间", statement.generatedAt], ["完整摘要", statement.digest || externalStatement.digest], ["累计入账", usd(statement.totals?.creditedUsd)], ["消耗", usd(statement.totals?.consumedUsd)], ["余额", usd(statement.totals?.balanceUsd)], ["原生上限", capLabel(statement.key?.capUsd)], ["原生回读", statement.key?.readbackAt], ["价格版本", statement.key?.priceVersion], ["计费状态", statement.accounting?.state]]), button("清除此页账单", () => { externalStatement = null; renderExternalStatement(); }));
  }
  function render(next) {
    state = next; renderEvidence();
    const keys = [
      ["overview", [next.wallet?.availability, next.wallet?.registry, next.wallet?.view?.chains, next.wallet?.view?.deposits, next.wallet?.view?.consumers], renderOverview],
      ["diagnostics", [next.wallet?.registry, next.wallet?.receiving, next.wallet?.view?.chains], renderDiagnostics],
      ["intents", [next.wallet?.intents, next.wallet?.intentOperations, next.wallet?.view?.deposits], renderIntents],
      ["alerts", [next.wallet?.anomalies, next.wallet?.view?.alerts], renderAlerts],
      ["consumers", next.status.consumers, renderConsumerOptions],
      ["accounting", [next.status.consumers, next.wallet?.view?.consumers, next.wallet?.view?.deposits, next.wallet?.evidenceAt], renderAccounting],
    ];
    for (const [key, value, update] of keys) { const hash = JSON.stringify(value ?? null); if (caches.get(key) !== hash) { caches.set(key, hash); update(); } }
  }
  renderExternalStatement();
  return {
    render,
    clearSecrets() { closeDialog(); state = null; selectedConsumer = ""; consumerSelect.input.value = ""; externalStatement = null; renderExternalStatement(); creationPending = false; caches.clear(); walletRoot.querySelectorAll("input,textarea").forEach((node) => { node.value = ""; }); },
    dispose() { closeDialog(); externalStatement = null; dialog.remove(); },
  };
}
