import { createExternalWallet, createWalletDiscovery, typedDataDigest } from "./external-wallet.js";

/* P2P payment UI: zero-file recharge over the authenticated B channel.
 *
 * The page only renders server-owned state and calls fixed console actions. It
 * never holds a key, signature, password or private RPC URL, and it cannot
 * credit, announce a payment as received or run an unattended signature. A send
 * is always: preview -> explicit confirmation of network/asset/recipient/amount
 * -> one signed transfer through the built-in wallet and the journal gate.
 */

const STATUS_LABEL = {
  actionneeded: "需要处理",
  waitingpayment: "等待付款",
  confirming: "确认中",
  received: "已到账",
  "request-sent": "等待提供方条件",
  signed: "已签名，等待提供方确认",
  unknown: "状态未知",
};
const CHAIN_NAMES = { 56: "BSC", 8453: "Base", 97: "BSC 测试网", 84532: "Base 测试网" };
/** Ordinary network name; the numeric chain id stays in technical details. */
const chainName = (id) => CHAIN_NAMES[Number(id)] || "未知网络";

const TONE = {
  received: "good",
  waitingpayment: "info",
  confirming: "info",
  actionneeded: "warn",
};

export function paymentStatusLabel(status) {
  return STATUS_LABEL[status] || STATUS_LABEL.unknown;
}

export function paymentStatusTone(status) {
  return TONE[status] || "neutral";
}

/** Parse a decimal token amount into the exact raw integer, or null. */
export function parseTokenAmount(value, decimals) {
  if (typeof value !== "string" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const text = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,36})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  const raw = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return /^[0-9]+$/.test(raw) && raw !== "0" ? raw : null;
}

export function formatRawAmount(raw, decimals) {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0) return "未知";
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function obligationActions(obligation) {
  if (!obligation || typeof obligation !== "object") return [];
  const actions = [];
  // The resolver requires a provider waitingpayment acknowledgement before any
  // send; the UI must not offer a pay button before that evidence exists.
  if (obligation.signed === true && obligation.peerStatus === "waitingpayment" && obligation.status === "waitingpayment") actions.push("preview");
  if (obligation.signed === true && obligation.peerStatus === null) actions.push("resend-signature");
  if (obligation.signed === false && obligation.status === "actionneeded") actions.push("sign");
  return actions;
}

export function mountPaymentP2p({ client, getState, notice = () => {}, refreshState = async () => {} } = {}) {
  const root = document.getElementById("payment-p2p-panel");
  if (!root) {
    return { render() {}, dispose() {}, snapshot() { return null; } };
  }
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const button = (text, handler, primary = false) => {
    const node = el("button", text, `button ${primary ? "primary" : "secondary"}`);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  };
  const p = (text, className = "muted") => el("p", text, className);
  const statusText = (text, tone = "neutral") => el("span", text, `status-text ${tone}`);
  const field = (label, type = "text", placeholder = "") => {
    const wrap = el("label", null, "field");
    const input = el("input");
    input.type = type;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    wrap.append(el("span", label), input);
    return { wrap, input };
  };
  const selectField = (label, options = []) => {
    const wrap = el("label", null, "field");
    const select = el("select");
    select.setAttribute("aria-label", label);
    wrap.append(el("span", label), select);
    return { wrap, select };
  };
  const setOptions = (select, options, placeholder) => {
    const previous = select.value;
    select.replaceChildren();
    const empty = el("option", placeholder);
    empty.value = "";
    select.append(empty);
    for (const [value, title] of options) {
      const option = el("option", title);
      option.value = String(value);
      select.append(option);
    }
    if ([...select.children].some((option) => option.value === previous)) select.value = previous;
  };

  const shell = el("section", null, "card workflow-section wallet-payment-section");
  shell.append(el("h2", "充值"));
  shell.append(p("向已授权的伙伴充值。付款条件通过已认证的连接交换，签名只在本机钱包确认，付款只在明确预览后发送。"));
  const unavailable = p("本机 P2P 付款服务尚未启动。", "inline-warning");
  unavailable.hidden = true;
  const providerBox = el("div", null, "wallet-payment-group");
  const consumerBox = el("div", null, "wallet-payment-group");
  const autoBox = el("details", null, "workflow-details wallet-payment-auto");
  shell.append(unavailable, providerBox, consumerBox, autoBox);
  root.replaceChildren(shell);

  const requestForm = el("div", null, "wallet-payment-form");
  const requestProvider = selectField("伙伴");
  const requestChain = selectField("网络");
  const requestAsset = selectField("资产");
  const requestAmount = field("金额（代币单位）", "text", "例如 1.5");
  const requestError = p("", "form-error");
  requestError.hidden = true;
  const requestButton = button("申请充值条件", () => void requestPayment(), true);
  const requestRow = el("div", null, "wallet-payment-actions");
  requestRow.append(requestButton);
  requestForm.append(requestProvider.wrap, requestChain.wrap, requestAsset.wrap, requestAmount.wrap, requestRow, requestError);
  consumerBox.append(requestForm);

  // ---- payment wallet selection (built-in or a real EIP-6963 wallet) ----
  let walletMode = "builtin";
  let discovery = null;
  let discoveryStarted = false;
  let selectedWalletId = null;
  let externalSession = null;
  let externalState = null;
  let externalError = "";
  let externalNeedsChain = null;
  let externalPaymentContext = null;

  const walletBox = el("section", null, "wallet-payment-group wallet-mode");
  walletBox.append(el("h3", "付款方式"));
  walletBox.append(p("默认使用本机内置钱包。也可以显式选择已安装的浏览器钱包；账户、网络和每一笔签名都由钱包扩展确认。", "muted small"));
  const walletModeRow = el("div", null, "wallet-payment-actions");
  const builtinModeButton = button("本机内置钱包", () => setWalletMode("builtin"));
  const externalModeButton = button("浏览器钱包", () => setWalletMode("external"));
  walletModeRow.append(builtinModeButton, externalModeButton);
  const externalRoot = el("div", null, "wallet-external-root");
  walletBox.append(walletModeRow, externalRoot);
  consumerBox.append(walletBox);

  function ensureDiscovery() {
    if (discovery) return discovery;
    discovery = createWalletDiscovery({ target: globalThis.window, now: Date.now });
    discovery.subscribe(() => { if (!unmounted) renderWalletBox(); });
    return discovery;
  }

  function externalRegistry() {
    const reg = state?.registry;
    return reg && Array.isArray(reg.networks) && Array.isArray(reg.assets) ? reg : { networks: [], assets: [] };
  }

  function setWalletMode(next) {
    walletMode = next;
    if (next === "external" && !discoveryStarted) {
      try { ensureDiscovery().start(); discoveryStarted = true; } catch { externalError = "浏览器钱包发现不可用；未连接任何钱包。"; }
    }
    renderWalletBox();
  }

  function connectExternal(selectionId) {
    if (!discovery) return;
    externalError = "";
    const session = createExternalWallet({
      discovery,
      selectionId,
      registry: () => externalRegistry(),
      allowedChainIds: [56, 97, 8453, 84532],
      now: Date.now,
      operationPort: {
        reserve: (operation) => client.action("payment-operation-reserve", {
          obligationId: externalPaymentContext?.obligationId,
          previewRef: externalPaymentContext?.previewRef,
          operation,
        }),
        markBroadcasting: ({ reservationId, operation }) => client.action("payment-operation-mark", {
          obligationId: externalPaymentContext?.obligationId,
          previewRef: externalPaymentContext?.previewRef,
          reservationId,
          operation,
        }),
        recordHash: ({ reservationId, operation, hash }) => client.action("payment-operation-hash", {
          obligationId: externalPaymentContext?.obligationId,
          previewRef: externalPaymentContext?.previewRef,
          reservationId,
          operation,
          hash,
        }),
        recordUnknown: ({ reservationId, operation, reason }) => client.action("payment-operation-unknown", {
          obligationId: externalPaymentContext?.obligationId,
          previewRef: externalPaymentContext?.previewRef,
          reservationId,
          operation,
          reason,
        }),
        query: (operation) => client.action("payment-operation-query", {
          obligationId: externalPaymentContext?.obligationId,
          operation,
        }),
      },
    });
    externalSession = session;
    session.subscribe((next) => { externalState = next; if (!unmounted) renderWalletBox(); });
    return session.connect({ userInitiated: true }).then(() => {
      externalState = session.snapshot();
      renderWalletBox();
    }).catch((error) => {
      externalError = String(error?.message || error || "钱包连接未完成");
      renderWalletBox();
    });
  }

  function switchExternalChain(chainId, add = false) {
    if (!externalSession) { externalError = "请先连接浏览器钱包"; renderWalletBox(); return; }
    externalError = "";
    const action = add ? externalSession.requestAddChain(chainId, { userInitiated: true }) : externalSession.requestSwitchChain(chainId, { userInitiated: true });
    void action.then(() => {
      externalNeedsChain = null;
      externalState = externalSession.snapshot();
      renderWalletBox();
    }).catch((error) => {
      externalNeedsChain = chainId;
      externalError = String(error?.message || error || "网络切换未完成");
      renderWalletBox();
    });
  }

  function renderWalletBox() {
    if (unmounted) return;
    builtinModeButton.className = `button ${walletMode === "builtin" ? "primary" : "secondary"}`;
    externalModeButton.className = `button ${walletMode === "external" ? "primary" : "secondary"}`;
    externalRoot.replaceChildren();
    if (walletMode === "builtin") {
      externalRoot.append(p("使用本机加密钱包。付款前会要求解锁并在预览中逐笔确认；私钥不会离开本机。", "muted small"));
      return;
    }
    if (!discoveryStarted) {
      try { ensureDiscovery().start(); discoveryStarted = true; } catch { externalError = "浏览器钱包发现不可用；未连接任何钱包。"; }
    }
    if (!discovery) { externalRoot.append(p("正在查找浏览器钱包…")); return; }
    const entries = discovery.list();
    const legacy = discovery.legacy();
    if (!entries.length && !legacy) {
      externalRoot.append(p("没有找到可用的钱包扩展。请安装或解锁 MetaMask / Rabby 后点“重新查找”。", "inline-warning"));
      externalRoot.append(button("重新查找", () => discovery.request()));
      return;
    }
    const list = el("div", null, "wallet-external-list");
    for (const entry of entries) {
      const row = el("article", null, "wallet-external-row");
      const body = el("div");
      body.append(el("strong", entry.name), el("div", entry.rdns || "未提供来源", "muted small"));
      row.append(body, button(selectedWalletId === entry.id ? "已选择" : "选择", () => {
        selectedWalletId = entry.id;
        externalSession?.dispose(); externalSession = null; externalState = null;
        renderWalletBox();
      }));
      list.append(row);
    }
    if (legacy && !entries.length) {
      const row = el("article", null, "wallet-external-row");
      row.append(el("div", null, "旧式注入钱包"), button(selectedWalletId === "legacy" ? "已选择" : "显式选择", () => {
        selectedWalletId = "legacy"; externalSession?.dispose(); externalSession = null; externalState = null; renderWalletBox();
      }));
      list.append(row);
    }
    externalRoot.append(list);
    if (selectedWalletId && !externalSession) {
      externalRoot.append(button("连接所选钱包", () => { void connectExternal(selectedWalletId); }, true));
    }
    if (externalState) {
      const facts = el("dl", null, "facts");
      for (const [label, value] of [["钱包", externalState.selection?.name || "已选择"], ["账户", externalState.account || "未返回"], ["网络", chainName(externalState.chainId)]]) {
        const row = el("div"); row.append(el("dt", label), el("dd", value)); facts.append(row);
      }
      externalRoot.append(facts);
      const switchRow = el("div", null, "wallet-payment-actions");
      for (const chainId of [56, 8453]) switchRow.append(button(chainName(chainId), () => switchExternalChain(chainId)));
      if (externalNeedsChain && externalNeedsChain !== externalState.chainId) switchRow.append(button(`添加 ${chainName(externalNeedsChain)} 并切换`, () => switchExternalChain(externalNeedsChain, true), true));
      switchRow.append(button("断开钱包", () => { externalSession?.dispose(); externalSession = null; externalState = null; externalError = ""; renderWalletBox(); }));
      externalRoot.append(switchRow);
    }
    if (externalError) externalRoot.append(p(externalError, "inline-warning"));
    externalRoot.append(p("浏览器钱包只用于你明确选择的网络；本页不会自动切链、自动签名或自动发送。", "muted small"));
  }

  const signBox = el("div", null, "wallet-payment-confirm");
  const signCheck = el("input");
  signCheck.type = "checkbox";
  const signLabel = el("label", null, "workflow-check");
  signLabel.append(signCheck, el("span", "我已核对提供方、网络、资产、金额和收款地址，确认用本机钱包签署这次付款条件。"));
  const signButton = button("签名并提交", () => void signInvoice(), true);
  signButton.disabled = true;
  signCheck.addEventListener("change", () => { signButton.disabled = !signCheck.checked; });
  const signActions = el("div", null, "wallet-payment-actions");
  signActions.append(signButton);
  signBox.append(signLabel, signActions);
  signBox.hidden = true;
  let pendingSignInvoice = null;
  consumerBox.append(signBox);

  const previewBox = el("div", null, "wallet-payment-preview");
  previewBox.hidden = true;
  consumerBox.append(previewBox);

  const obligations = el("ul", null, "wallet-payment-list");
  const providerRequests = el("ul", null, "wallet-payment-list");
  providerBox.append(el("h3", "提供方：我的收款与发票"), providerRequests);
  consumerBox.append(el("h3", "我的充值"), obligations);

  const recoveryBox = el("details", null, "workflow-details wallet-payment-recovery");
  recoveryBox.append(el("summary", "付款恢复（结果不明的发送）"));
  recoveryBox.append(p("只在这里处理已经产生 journal 记录、但钱包没有返回明确结果的那一笔。不要重复发送；先用钱包或区块浏览器找到已知交易哈希，再让服务核对链上收款人、金额和代币。", "muted small"));
  const recoveryList = el("div");
  const recoveryReload = button("刷新待恢复记录", () => void loadPending());
  recoveryBox.append(recoveryList, recoveryReload);
  recoveryBox.addEventListener("toggle", () => { if (recoveryBox.open) void loadPending(); });
  consumerBox.append(recoveryBox);

  let pendingJournal = [];

  async function loadPending() {
    if (unmounted) return;
    try {
      const rows = await act("payment-operation-pending", {});
      pendingJournal = Array.isArray(rows) ? rows : [];
      renderRecovery();
    } catch {
      pendingJournal = [];
      renderRecovery();
    }
  }

  function renderRecovery() {
    if (unmounted) return;
    recoveryList.replaceChildren();
    if (!pendingJournal.length) {
      recoveryList.append(p("没有待恢复的发送记录。", "muted small"));
      return;
    }
    for (const row of pendingJournal) {
      const card = el("article", null, "wallet-payment-recovery-row");
      card.append(el("strong", `${row.invoice}，状态 ${row.state}`));
      const meta = el("ul", null, "meta-list");
      meta.append(el("li", chainName(row.chainId)), el("li", `保留编号 ${row.reservationId}`));
      if (row.txHash) meta.append(el("li", `已知哈希 ${row.txHash}`));
      if (Array.isArray(row.hashes) && row.hashes.length) meta.append(el("li", `全部哈希 ${row.hashes.join(", ")}`));
      if (row.reason) meta.append(el("li", `原因 ${row.reason}`));
      card.append(meta);
      if (row.state === "unknown" || row.state === "broadcasting") {
        const input = el("input");
        input.type = "text";
        input.placeholder = "0x 开头的已知交易哈希";
        input.autocomplete = "off";
        const adopt = button("按已知哈希恢复", async () => {
          const hash = input.value.trim();
          if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { try { notice("交易哈希格式不正确", "warn"); } catch { /* advisory */ } return; }
          try {
            await act("payment-operation-adopt", { obligationId: row.invoice, reservationId: row.reservationId, hash });
            try { notice("已按链上回执恢复这笔发送；仍需等待提供方观察最终性", "good"); } catch { /* advisory */ }
            await loadPending();
            await refreshState();
          } catch (error) {
            try { notice(String(error?.message || error), "warn"); } catch { /* advisory */ }
          }
        });
        card.append(input, adopt);
      }
      recoveryList.append(card);
    }
  }

  autoBox.append(el("summary", "自动充值提醒（可选）"));
  autoBox.append(p("开启后只在伙伴剩余额度低于触发值时提醒；真正付款仍要上面的预览和确认。BSC 与 Base 都不会自动签名或自动转账。"));
  const autoEnabled = el("input");
  autoEnabled.type = "checkbox";
  const autoLabel = el("label", null, "workflow-check");
  autoLabel.append(autoEnabled, el("span", "启用余额不足提醒"));
  const autoProvider = selectField("伙伴");
  const autoChain = selectField("网络");
  const autoAsset = selectField("资产");
  const autoTrigger = field("触发额度（USD）", "number", "1");
  const autoPer = field("单次上限（USD）", "number", "5");
  const autoDaily = field("每日累计上限（USD）", "number", "20");
  const autoGas = field("Gas 上限（wei）", "text", "2000000000000000");
  const autoTtl = field("授权有效期（秒）", "number", "600");
  const autoError = p("", "form-error");
  autoError.hidden = true;
  const autoRow = el("div", null, "wallet-payment-actions");
  autoRow.append(button("保存提醒策略", () => void savePolicy(), true));
  const autoForm = el("div", null, "wallet-payment-form");
  autoForm.append(autoLabel, autoProvider.wrap, autoChain.wrap, autoAsset.wrap, autoTrigger.wrap, autoPer.wrap, autoDaily.wrap, autoGas.wrap, autoTtl.wrap, autoRow, autoError);
  const reminder = p("", "inline-warning");
  reminder.hidden = true;
  autoBox.append(reminder, autoForm);

  let state = null;
  let unmounted = false;
  let busy = false;
  let signature = null;
  let pendingLoaded = false;

  function showError(node, message) {
    node.textContent = message || "";
    node.hidden = !message;
  }

  async function act(name, input) {
    try {
      return await client.action(name, input);
    } catch (error) {
      const message = String(error?.message || error || "操作失败");
      try { notice(message, "warn"); } catch { /* advisory */ }
      throw error;
    }
  }

  function providerChoices(s) {
    const remotes = Array.isArray(s?.consumer?.remotes) ? s.consumer.remotes : [];
    return remotes.map((remote) => [remote.providerNodeId, `${remote.providerNodeId}，授权 ${remote.generation}，上限 $${remote.capUsd}`]);
  }

  function assetChoices(s, chainId) {
    const assets = Array.isArray(s?.provider?.assets) ? s.provider.assets : [];
    return assets.filter((asset) => !chainId || asset.chainId === Number(chainId)).map((asset) => {
      const network = (s?.provider?.networks || []).includes(asset.chainId) ? chainName(asset.chainId) : "未知网络";
      return [asset.assetId, `${asset.symbol}，${network}，${asset.contractAddress.slice(0, 10)}…`];
    });
  }

  function renderForm() {
    if (!state) return;
    setOptions(requestProvider.select, providerChoices(state), "选择已授权的伙伴");
    const chains = [...new Set((state.provider?.assets || []).map((a) => a.chainId))].sort((a, b) => a - b);
    setOptions(requestChain.select, chains.map((chain) => [chain, chainName(chain)]), "选择网络");
    setOptions(requestAsset.select, assetChoices(state, requestChain.select.value), "选择资产");
    setOptions(autoProvider.select, providerChoices(state), "选择伙伴");
    setOptions(autoChain.select, chains.map((chain) => [chain, chainName(chain)]), "选择网络");
    setOptions(autoAsset.select, assetChoices(state, autoChain.select.value), "选择资产");
  }

  async function requestPayment() {
    if (busy) return;
    showError(requestError, "");
    const providerNodeId = requestProvider.select.value;
    const chainId = Number(requestChain.select.value);
    const assetId = requestAsset.select.value;
    const asset = (state?.provider?.assets || []).find((a) => a.assetId === assetId);
    if (!providerNodeId || !chainId || !asset) return showError(requestError, "请选择已授权的伙伴、网络和资产");
    const amountRaw = parseTokenAmount(requestAmount.input.value, asset.decimals);
    if (!amountRaw) return showError(requestError, `请输入大于 0 且不超过 ${asset.decimals} 位小数的金额`);
    busy = true;
    requestButton.disabled = true;
    try {
      const result = await act("payment-p2p-request", { providerNodeId, chainId, assetId, amountRaw });
      try { notice(`已发送充值申请${result.invoiceId ? `（${result.invoiceId}）` : ""}，等待伙伴给出付款条件`, "good"); } catch { /* advisory */ }
      await refreshState();
    } catch (error) {
      showError(requestError, String(error?.message || error));
    } finally {
      busy = false;
      requestButton.disabled = false;
    }
  }

  function startSign(obligation) {
    if (!obligation) return;
    pendingSignInvoice = obligation.invoiceId;
    signature = obligation;
    signBox.hidden = false;
    signCheck.checked = false;
    signButton.disabled = true;
    signButton.textContent = `${walletMode === "external" ? "用浏览器钱包签署" : "用本机钱包签署"} ${formatRawAmount(obligation.amountRaw, obligation.decimals)}`;
  }

  async function signInvoice() {
    if (busy || !pendingSignInvoice) return;
    if (walletMode === "external") return signExternalInvoice();
    busy = true;
    signButton.disabled = true;
    try {
      await act("payment-p2p-sign", { invoiceId: pendingSignInvoice });
      try { notice("付款条件已用本机钱包签名；等待提供方确认后再付款", "good"); } catch { /* advisory */ }
      pendingSignInvoice = null;
      signature = null;
      signBox.hidden = true;
      await refreshState();
    } catch (error) {
      try { notice(String(error?.message || error), "warn"); } catch { /* advisory */ }
      signButton.disabled = false;
    } finally {
      busy = false;
    }
  }

  async function signExternalInvoice() {
    const invoiceId = pendingSignInvoice;
    const obligation = (state?.consumer?.obligations || []).find((o) => o.invoiceId === invoiceId);
    if (!obligation) return showError(requestError, "找不到这笔付款条件；请刷新状态");
    if (!externalSession || !externalState?.account) return showError(requestError, "请先连接浏览器钱包");
    if (externalState.chainId !== obligation.chainId) return showError(requestError, `请先把钱包切换到 ${chainName(obligation.chainId)}`);
    if (!obligation.typedData || !obligation.digest) return showError(requestError, "这笔付款条件没有可签名的 EIP-712 数据；请让提供方重新发送");
    let digest;
    try { digest = typedDataDigest(obligation.typedData); } catch { return showError(requestError, "付款条件的 EIP-712 数据无效"); }
    if (String(digest).toLowerCase() !== String(obligation.digest).toLowerCase()) return showError(requestError, "付款条件摘要与服务核对值不一致；已拒绝签名");
    busy = true;
    signButton.disabled = true;
    try {
      const signed = await externalSession.signTypedData(obligation.typedData, {
        userInitiated: true,
        expectedDigest: obligation.digest,
        expectedChainId: obligation.chainId,
      });
      await act("payment-p2p-sign-external", { invoiceId, signature: signed.signature, payerAddress: signed.payerAddress });
      try { notice("付款条件已用浏览器钱包签名；等待提供方确认后再付款", "good"); } catch { /* advisory */ }
      pendingSignInvoice = null;
      signature = null;
      signBox.hidden = true;
      await refreshState();
    } catch (error) {
      showError(requestError, String(error?.message || error));
    } finally {
      busy = false;
      signButton.disabled = false;
    }
  }

  async function resendSignature(obligation) {
    if (busy) return;
    busy = true;
    try {
      await act("payment-p2p-resume", { invoiceId: obligation.invoiceId });
      try { notice("已重新发送签名，等待提供方确认", "good"); } catch { /* advisory */ }
      await refreshState();
    } catch (error) {
      try { notice(String(error?.message || error), "warn"); } catch { /* advisory */ }
    } finally {
      busy = false;
    }
  }

  async function previewPayment(obligation) {
    if (busy) return;
    if (walletMode === "external") return previewExternalPayment(obligation);
    busy = true;
    showError(requestError, "");
    try {
      const preview = await act("payment-local-send-preview", { invoiceId: obligation.invoiceId });
      renderPreview(obligation, preview);
    } catch (error) {
      try { notice(String(error?.message || error), "warn"); } catch { /* advisory */ }
    } finally {
      busy = false;
    }
  }

  async function previewExternalPayment(obligation) {
    if (!externalSession || !externalState?.account) { try { notice("请先连接浏览器钱包", "warn"); } catch { /* advisory */ } return; }
    if (externalState.chainId !== obligation.chainId) { try { notice(`请先把钱包切换到 ${chainName(obligation.chainId)}`, "warn"); } catch { /* advisory */ } return; }
    busy = true;
    try {
      const server = await act("payment-obligation-preview", { obligationId: obligation.invoiceId });
      externalPaymentContext = { obligationId: obligation.invoiceId, previewRef: server.previewRef };
      const preview = await externalSession.prepareTransfer({
        userInitiated: true,
        assetId: obligation.assetId,
        recipientAddress: obligation.recipientAddress,
        amountRaw: obligation.amountRaw,
        intentHash: obligation.digest || null,
      });
      renderExternalPreview(obligation, preview, server.previewRef);
    } catch (error) {
      try { notice(String(error?.message || error), "warn"); } catch { /* advisory */ }
    } finally {
      busy = false;
    }
  }

  function renderExternalPreview(obligation, preview, previewRef) {
    previewBox.replaceChildren();
    previewBox.hidden = false;
    previewBox.append(el("h4", "浏览器钱包付款预览"));
    const facts = el("dl", null, "facts wallet-payment-facts");
    for (const [label, value, mono] of [
      ["网络", chainName(preview.chainId), false],
      ["资产", `${preview.symbol}（${preview.contractAddress}）`, true],
      ["金额", preview.amountTokens, true],
      ["收款地址", preview.recipientAddress, true],
      ["付款地址", preview.account, true],
      ["Gas 上限/价格", `${preview.gasLimitRaw} × ${preview.gasPriceRaw} wei`, true],
      ["最坏 Gas 花费", `${preview.estimatedFeeNative} ${preview.nativeSymbol}`, true],
      ["代币余额", `${preview.tokenBalance} ${preview.symbol}`, true],
      ["预览有效期", preview.expiresAt, false],
    ]) {
      const row = el("div");
      const dd = el("dd", value); if (mono) dd.className = "mono";
      row.append(el("dt", label), dd); facts.append(row);
    }
    previewBox.append(facts);
    if (preview.blockers?.length) previewBox.append(p(`钱包预览阻塞：${preview.blockers.join("；")}`, "inline-warning"));
    const confirm = el("input"); confirm.type = "checkbox";
    const label = el("label", null, "workflow-check");
    label.append(confirm, el("span", "我已核对以上网络、资产、收款地址和金额；只发送这一笔。"));
    const send = button("确认并从浏览器钱包付款", () => void sendExternalPayment(obligation, preview, previewRef), true);
    send.disabled = preview.blockers?.length > 0;
    confirm.addEventListener("change", () => { send.disabled = !confirm.checked || preview.blockers?.length > 0; });
    const actions = el("div", null, "wallet-payment-actions");
    actions.append(send, button("关闭预览", () => { previewBox.hidden = true; previewBox.replaceChildren(); }));
    previewBox.append(label, actions);
    previewBox.scrollIntoView?.({ block: "nearest" });
  }

  async function sendExternalPayment(obligation, preview, previewRef) {
    if (busy) return;
    externalPaymentContext = { obligationId: obligation.invoiceId, previewRef };
    busy = true;
    try {
      const result = await externalSession.confirmTransfer(preview, { userInitiated: true, acknowledged: true, previewId: preview.previewId });
      if (result?.broadcast === true) {
        try { notice(`已广播 ${result.hash}；广播不等于到账，等待提供方观察链上最终性`, "good"); } catch { /* advisory */ }
      } else {
        try { notice("钱包没有广播这笔转账", "warn"); } catch { /* advisory */ }
      }
      previewBox.hidden = true;
      previewBox.replaceChildren();
      await loadPending();
      await refreshState();
    } catch (error) {
      try { notice(String(error?.message || error), "warn"); } catch { /* advisory */ }
    } finally {
      busy = false;
    }
  }

  function renderPreview(obligation, preview) {
    previewBox.replaceChildren();
    previewBox.hidden = false;
    previewBox.append(el("h4", "付款预览"));
    // The ordinary confirmation shows only what the user must recognise. Chain
    // id, nonce, gas and the signature digest live in one collapsed block.
    const facts = el("dl", null, "facts wallet-payment-facts");
    const visibleRows = [
      ["网络", chainName(preview.chainId), false],
      ["资产", `${preview.assetId}`, true],
      ["金额", `${preview.amountTokens}`, true],
      ["收款地址", preview.recipientAddress, true],
      ["付款地址", preview.payerAddress, true],
    ];
    for (const [label, value, identifier] of visibleRows) {
      const row = el("div");
      const dd = el("dd", value);
      if (identifier) dd.className = "mono";
      row.append(el("dt", label), dd);
      facts.append(row);
    }
    const technical = el("details", null, "workflow-details");
    technical.append(el("summary", "技术详情"));
    const technicalRows = [
      ["发票", preview.invoiceId, true],
      ["chainId", preview.chainId, true],
      ["资产 ID", `${preview.assetId}`, true],
      ["原始金额", preview.amountRaw, true],
      ["Nonce", String(preview.nonce), true],
      ["Gas 上限", `${preview.gasLimit} × ${preview.maxFeePerGas} wei`, true],
      ["最坏 Gas 花费", `${preview.maxGasCostWei} wei（${preview.nativeSymbol}）`, true],
      ["代币余额", formatRawAmount(preview.tokenBalanceRaw, preview.decimals), true],
      ["EIP-712 摘要", preview.digest, true],
      ["预览有效期", preview.expiresAt, false],
    ];
    for (const [label, value, identifier] of technicalRows) {
      const row = el("div");
      const dd = el("span", value);
      if (identifier) dd.className = "mono";
      row.append(el("strong", label), dd);
      technical.append(row);
    }
    const confirm = el("input");
    confirm.type = "checkbox";
    const label = el("label", null, "workflow-check");
    label.append(confirm, el("span", "我已核对以上网络、资产、收款地址和金额；只发送这一笔。"));
    const send = button("确认并从本机钱包付款", () => void sendPayment(obligation, preview.previewRef), true);
    send.disabled = true;
    confirm.addEventListener("change", () => { send.disabled = !confirm.checked; });
    const actions = el("div", null, "wallet-payment-actions");
    actions.append(send, button("关闭预览", () => { previewBox.hidden = true; previewBox.replaceChildren(); }));
    previewBox.append(facts, technical, label, actions);
    previewBox.scrollIntoView?.({ block: "nearest" });
  }

  async function sendPayment(obligation, previewRef) {
    if (busy) return;
    busy = true;
    try {
      const result = await act("payment-local-send", { invoiceId: obligation.invoiceId, previewRef, confirm: true });
      if (result?.broadcast === true) {
        try { notice(`已广播 ${result.hash}；广播不等于到账，等待提供方观察链上最终性`, "good"); } catch { /* advisory */ }
      } else {
        try { notice(`未发送：${result?.state || "journal 未授权"}`, "warn"); } catch { /* advisory */ }
      }
      previewBox.hidden = true;
      previewBox.replaceChildren();
      await loadPending();
      await refreshState();
    } catch (error) {
      try { notice(String(error?.message || error), "warn"); } catch { /* advisory */ }
    } finally {
      busy = false;
    }
  }

  async function savePolicy() {
    if (busy) return;
    busy = true;
    showError(autoError, "");
    try {
      const chainId = Number(autoChain.select.value) || null;
      const assetId = autoAsset.select.value || null;
      const policy = await act("payment-auto-policy-set", {
        enabled: autoEnabled.checked,
        providerNodeId: autoProvider.select.value || null,
        providerFingerprint: (state?.consumer?.remotes || []).find((r) => r.providerNodeId === autoProvider.select.value)?.providerFingerprint || null,
        chainId,
        assetId,
        triggerUsd: Number(autoTrigger.input.value),
        perPaymentMaxUsd: Number(autoPer.input.value),
        dailyMaxUsd: Number(autoDaily.input.value),
        gasMaxWei: autoGas.input.value.trim(),
        authorizationTtlSec: Number(autoTtl.input.value),
      });
      try { notice(`提醒策略已保存${policy.enabled ? "（仍为一键确认，不会自动签名）" : ""}`, "good"); } catch { /* advisory */ }
      await refreshState();
    } catch (error) {
      showError(autoError, String(error?.message || error));
    } finally {
      busy = false;
    }
  }

  function renderProviderRequests(s) {
    providerRequests.replaceChildren();
    const rows = Array.isArray(s?.provider?.requests) ? s.provider.requests : [];
    if (!rows.length) {
      providerRequests.append(el("li", "还没有收到的充值申请。", "muted"));
      return;
    }
    for (const request of rows) {
      const li = el("li");
      const head = el("div", null, "wallet-payment-row-head");
      const amount = el("strong", formatRawAmount(request.amountRaw, request.decimals));
      amount.className = "amount";
      head.append(amount, statusText(paymentStatusLabel(request.status), paymentStatusTone(request.status)));
      const meta = el("ul", null, "meta-list");
      meta.append(el("li", chainName(request.chainId)), el("li", `发票 ${request.invoiceId}`), el("li", `顾客 ${request.consumerNodeId}`), el("li", request.signaturePresent ? "已验签" : "未签名"), el("li", request.expiresAt));
      li.append(head, meta);
      if (request.payerAddress) { const payer = el("small", `付款地址 ${request.payerAddress}`); payer.className = "mono"; li.append(payer); }
      if (request.error) li.append(el("small", `错误 ${request.error}`));
      providerRequests.append(li);
    }
  }

  function renderObligations(s) {
    obligations.replaceChildren();
    const rows = Array.isArray(s?.consumer?.obligations) ? s.consumer.obligations : [];
    if (!rows.length) {
      obligations.append(el("li", "还没有充值记录。", "muted"));
      return;
    }
    for (const obligation of rows) {
      const li = el("li");
      const head = el("div", null, "wallet-payment-row-head");
      const status = obligation.peerStatus || obligation.status;
      const amount = el("strong", formatRawAmount(obligation.amountRaw, obligation.decimals));
      amount.className = "amount";
      head.append(amount, statusText(paymentStatusLabel(status), paymentStatusTone(status)));
      li.append(head);
      const meta = el("ul", null, "meta-list");
      meta.append(el("li", chainName(obligation.chainId)), el("li", `伙伴 ${obligation.providerNodeId}`), el("li", `发票 ${obligation.invoiceId}`), el("li", obligation.signed ? "已签名" : "未签名"), el("li", `到期 ${obligation.expiresAt}`));
      li.append(meta);
      if (obligation.payerAddress) { const payer = el("small", `付款地址 ${obligation.payerAddress}`); payer.className = "mono"; li.append(payer); }
      const actions = el("div", null, "wallet-payment-actions");
      const available = obligationActions(obligation);
      if (available.includes("sign")) actions.append(button("核对并签名", () => startSign(obligation)));
      if (available.includes("resend-signature")) actions.append(button("重新发送签名", () => void resendSignature(obligation)));
      if (available.includes("preview")) actions.append(button("预览并付款", () => void previewPayment(obligation), true));
      if (actions.children.length) li.append(actions);
      obligations.append(li);
    }
  }

  function renderAuto(s) {
    const policy = s?.auto || {};
    autoEnabled.checked = policy.enabled === true;
    if (policy.providerNodeId) autoProvider.select.value = policy.providerNodeId;
    if (policy.chainId) autoChain.select.value = String(policy.chainId);
    setOptions(autoAsset.select, assetChoices(s, autoChain.select.value), "选择资产");
    if (policy.assetId && !autoAsset.select.value) autoAsset.select.value = policy.assetId;
    if (policy.triggerUsd !== undefined) autoTrigger.input.value = String(policy.triggerUsd);
    if (policy.perPaymentMaxUsd !== undefined) autoPer.input.value = String(policy.perPaymentMaxUsd);
    if (policy.dailyMaxUsd !== undefined) autoDaily.input.value = String(policy.dailyMaxUsd);
    if (policy.gasMaxWei) autoGas.input.value = policy.gasMaxWei;
    if (policy.authorizationTtlSec !== undefined) autoTtl.input.value = String(policy.authorizationTtlSec);
    const reminderState = s?.reminder;
    if (reminderState?.active) {
      reminder.hidden = false;
      reminder.textContent = `余额不足提醒：${reminderState.reason || "提供方剩余额度偏低"}。请在上方预览并确认一笔充值；系统不会自动签名。`;
    } else {
      reminder.hidden = true;
      reminder.textContent = "";
    }
  }

  function render(next) {
    if (unmounted) return;
    state = next?.status?.paymentP2p ?? next ?? null;
    const available = Boolean(state && state.available !== false);
    unavailable.hidden = available;
    shell.classList.toggle("is-unavailable", !available);
    if (!available) {
      providerBox.hidden = true;
      consumerBox.hidden = true;
      autoBox.hidden = true;
      return;
    }
    providerBox.hidden = false;
    consumerBox.hidden = false;
    autoBox.hidden = false;
    renderForm();
    renderProviderRequests(state);
    renderObligations(state);
    renderAuto(state);
    renderWalletBox();
  }

  renderWalletBox();
  requestChain.select.addEventListener("change", () => setOptions(requestAsset.select, assetChoices(state, requestChain.select.value), "选择资产"));
  autoChain.select.addEventListener("change", () => setOptions(autoAsset.select, assetChoices(state, autoChain.select.value), "选择资产"));

  return {
    render,
    dispose() {
      unmounted = true;
      pendingSignInvoice = null;
      signature = null;
      signCheck.checked = false;
      previewBox.replaceChildren();
      previewBox.hidden = true;
      externalSession?.dispose();
      externalSession = null;
      discovery?.stop?.();
      discovery = null;
      discoveryStarted = false;
    },
    snapshot() { return { state, pendingSignInvoice, hasSignature: signature !== null }; },
  };
}
