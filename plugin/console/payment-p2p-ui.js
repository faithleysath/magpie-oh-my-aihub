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
  const pill = (text, tone = "neutral") => el("span", text, `pill ${tone}`);
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
  shell.append(el("h2", "无文件充值（P2P 付款）"));
  shell.append(p("由已认证的伙伴连接交换付款条件；签名只在本机钱包确认，付款只在明确预览后发送。没有 JSON 文件或签名文件步骤。"));
  const unavailable = p("本机 P2P 付款服务尚未启动。", "inline-warning");
  unavailable.hidden = true;
  const providerBox = el("div", null, "wallet-payment-group");
  const consumerBox = el("div", null, "wallet-payment-group");
  const autoBox = el("div", null, "wallet-payment-group");
  shell.append(unavailable, providerBox, consumerBox, autoBox);
  root.replaceChildren(shell);

  const requestForm = el("div", null, "wallet-payment-form");
  const requestProvider = selectField("伙伴提供方");
  const requestChain = selectField("网络（测试链）");
  const requestAsset = selectField("资产");
  const requestAmount = field("金额（代币单位）", "text", "例如 1.5");
  const requestError = p("", "form-error");
  requestError.hidden = true;
  const requestButton = button("申请充值条件", () => void requestPayment(), true);
  const requestRow = el("div", null, "wallet-payment-actions");
  requestRow.append(requestButton);
  requestForm.append(requestProvider.wrap, requestChain.wrap, requestAsset.wrap, requestAmount.wrap, requestRow, requestError);
  consumerBox.append(requestForm);

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

  autoBox.append(el("h3", "自动充值：提醒 + 一键确认（FULL AUTO 未实现）"));
  autoBox.append(p("本阶段不执行无人值守签名。开启后只在提供方剩余额度低于触发值时提醒；真正付款仍需上面的预览和确认。主网 56/8453 永远关闭。"));
  const autoEnabled = el("input");
  autoEnabled.type = "checkbox";
  const autoLabel = el("label", null, "workflow-check");
  autoLabel.append(autoEnabled, el("span", "启用余额不足提醒"));
  const autoProvider = selectField("伙伴提供方");
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
    return remotes.map((remote) => [remote.providerNodeId, `${remote.providerNodeId} · 授权 ${remote.generation} · 上限 $${remote.capUsd}`]);
  }

  function assetChoices(s, chainId) {
    const assets = Array.isArray(s?.provider?.assets) ? s.provider.assets : [];
    return assets.filter((asset) => !chainId || asset.chainId === Number(chainId)).map((asset) => {
      const network = (s?.provider?.networks || []).includes(asset.chainId) ? `链 ${asset.chainId}` : "未知网络";
      return [asset.assetId, `${asset.symbol} · ${network} · ${asset.contractAddress.slice(0, 10)}…`];
    });
  }

  function renderForm() {
    if (!state) return;
    setOptions(requestProvider.select, providerChoices(state), "选择已授权的伙伴");
    const chains = [...new Set((state.provider?.assets || []).map((a) => a.chainId))].sort((a, b) => a - b);
    setOptions(requestChain.select, chains.map((chain) => [chain, `链 ${chain}`]), "选择网络");
    setOptions(requestAsset.select, assetChoices(state, requestChain.select.value), "选择资产");
    setOptions(autoProvider.select, providerChoices(state), "选择伙伴");
    setOptions(autoChain.select, chains.map((chain) => [chain, `链 ${chain}`]), "选择网络");
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
      try { notice(`已发送充值申请${result.invoiceId ? `（${result.invoiceId}）` : ""}，等待提供方付款条件`, "good"); } catch { /* advisory */ }
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
    signButton.textContent = `签署 ${formatRawAmount(obligation.amountRaw, obligation.decimals)}`;
  }

  async function signInvoice() {
    if (busy || !pendingSignInvoice) return;
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

  function renderPreview(obligation, preview) {
    previewBox.replaceChildren();
    previewBox.hidden = false;
    previewBox.append(el("h4", "付款预览（只读）"));
    const facts = el("dl", null, "facts wallet-payment-facts");
    const rows = [
      ["发票", preview.invoiceId],
      ["网络", `链 ${preview.chainId}`],
      ["资产", `${preview.assetId}`],
      ["收款地址", preview.recipientAddress],
      ["金额", `${preview.amountTokens}（原始 ${preview.amountRaw}）`],
      ["付款地址", preview.payerAddress],
      ["Nonce", String(preview.nonce)],
      ["Gas 上限", `${preview.gasLimit} × ${preview.maxFeePerGas} wei`],
      ["最坏 Gas 花费", `${preview.maxGasCostWei} wei（${preview.nativeSymbol}）`],
      ["代币余额", formatRawAmount(preview.tokenBalanceRaw, preview.decimals)],
      ["EIP-712 摘要", preview.digest],
      ["预览有效期", preview.expiresAt],
    ];
    for (const [label, value] of rows) {
      const row = el("div");
      row.append(el("dt", label), el("dd", value));
      facts.append(row);
    }
    const confirm = el("input");
    confirm.type = "checkbox";
    const label = el("label", null, "workflow-check");
    label.append(confirm, el("span", "我已核对以上网络、资产、收款地址、金额和 Gas 上限；只发送这一笔。"));
    const send = button("确认并从本机钱包付款", () => void sendPayment(obligation, preview.previewRef), true);
    send.disabled = true;
    confirm.addEventListener("change", () => { send.disabled = !confirm.checked; });
    const actions = el("div", null, "wallet-payment-actions");
    actions.append(send, button("关闭预览", () => { previewBox.hidden = true; previewBox.replaceChildren(); }));
    previewBox.append(facts, label, actions);
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
      head.append(el("strong", `${formatRawAmount(request.amountRaw, request.decimals)} · 链 ${request.chainId}`), pill(paymentStatusLabel(request.status), paymentStatusTone(request.status)));
      const detail = el("small", `发票 ${request.invoiceId} · 顾客 ${request.consumerNodeId} · ${request.signaturePresent ? "已验签" : "未签名"} · ${request.expiresAt}`);
      li.append(head, detail);
      if (request.payerAddress) li.append(el("small", `付款地址 ${request.payerAddress}`));
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
      head.append(el("strong", `${formatRawAmount(obligation.amountRaw, obligation.decimals)} · 链 ${obligation.chainId}`), pill(paymentStatusLabel(status), paymentStatusTone(status)));
      li.append(head);
      li.append(el("small", `伙伴 ${obligation.providerNodeId} · 发票 ${obligation.invoiceId} · ${obligation.signed ? "已签名" : "未签名"} · 到期 ${obligation.expiresAt}`));
      if (obligation.payerAddress) li.append(el("small", `付款地址 ${obligation.payerAddress}`));
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
  }

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
    },
    snapshot() { return { state, pendingSignInvoice, hasSignature: signature !== null }; },
  };
}
