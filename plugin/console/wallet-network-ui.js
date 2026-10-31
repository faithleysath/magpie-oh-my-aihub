/* Read-only mainnet network/asset view for the wallet page.
 *
 * It consumes only the approved C-network local action contract. It never
 * watches, signs, sends, credits or changes the wallet. Ordinary renders make
 * no RPC; only an explicit balance-refresh action does, for an explicitly
 * watched address.
 */
const PRODUCT_CHAINS = new Set([56, 8453]);

export function formatTokenUnits(raw, decimals) {
  if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) throw new Error("raw amount must be an unsigned integer string");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("unusable decimals");
  const value = BigInt(raw).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return value;
  const whole = value.slice(0, -decimals);
  const fraction = value.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function productNetworks(state) {
  return Array.isArray(state?.product?.networks) ? state.product.networks.filter((network) => PRODUCT_CHAINS.has(network.chainId)) : [];
}
export function productAssets(state, chainId) {
  return Array.isArray(state?.product?.assets) ? state.product.assets.filter((asset) => asset.chainId === chainId) : [];
}
export function receivingChainIds(state) {
  return Array.isArray(state?.receiving?.chainIds) ? state.receiving.chainIds.filter((id) => PRODUCT_CHAINS.has(id)) : [];
}

export function mountWalletNetwork({ client, getState, notice = () => {}, refreshState = async () => {} } = {}) {
  const root = document.getElementById("wallet-network-panel");
  if (!root) return { render() {}, onShow() {}, reset() {}, dispose() {} };
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (className) node.className = className; return node; };
  const p = (text, className = "muted") => el("p", text, className);
  const button = (text, callback, primary = false) => { const node = el("button", text, `button ${primary ? "primary" : "secondary"}`); node.type = "button"; node.addEventListener("click", callback); return node; };
  const field = (text, type = "text") => { const label = el("label", null, "field"); const input = el("input"); input.type = type; input.autocomplete = "off"; label.append(el("span", text), input); return { label, input }; };
  const select = (text, placeholder = "请明确选择") => { const label = el("label", null, "field"); const input = el("select"); input.setAttribute("aria-label", text); const option = (value, title) => { const node = el("option", title); node.value = String(value); return node; }; input.append(option("", placeholder)); label.append(el("span", text), input); return { label, input }; };
  const check = (text) => { const label = el("label", null, "workflow-check"); const input = el("input"); input.type = "checkbox"; label.append(input, el("span", text)); return { label, input }; };
  const pill = (text, tone = "neutral") => el("span", text, `pill ${tone}`);
  const section = (title, text) => { const node = el("section", null, "card workflow-section wallet-network-section"); node.append(el("h2", title)); if (text) node.append(p(text)); return node; };
  const details = (title, values) => { const node = el("details", null, "workflow-details"); node.append(el("summary", title)); for (const [label, value] of values) { const row = el("div"); row.append(el("strong", label), el("span", value ?? "未知")); node.append(row); } return node; };
  const errorLine = el("p", null, "form-error"); errorLine.hidden = true; errorLine.setAttribute("role", "alert");

  let state = null;
  let service = "unknown";
  let serviceError = "";
  let loading = false;
  let working = false;
  let loaded = false;
  let selectedWatch = "";
  let selectedChain = "";
  let selectedAsset = "";
  let lastBalance = null;
  let disposed = false;

  function report(message, tone = "warn") { try { notice(message, tone); } catch { /* advisory */ } }
  function fail(message) { errorLine.textContent = message; errorLine.hidden = false; }
  function clearError() { errorLine.textContent = ""; errorLine.hidden = true; }
  function apply(next) {
    if (!next || typeof next !== "object") return;
    if (next.schema === "ohmyaihub.network-local/v1") {
      state = next;
      lastBalance = next.lastBalance || lastBalance;
      const watch = Array.isArray(next.watchAddresses) ? next.watchAddresses : [];
      if (selectedWatch && !watch.includes(selectedWatch)) selectedWatch = "";
      const chains = new Set(productNetworks(next).map((network) => String(network.chainId)));
      if (selectedChain && !chains.has(selectedChain)) selectedChain = "";
      if (selectedChain && selectedAsset && !availableAssets(Number(selectedChain)).some((asset) => asset.key === selectedAsset)) selectedAsset = "";
      return;
    }
    if (next.schema === "ohmyaihub.network-local-balance/v1") lastBalance = next;
  }
  function availableAssets(chainId) {
    if (!PRODUCT_CHAINS.has(chainId)) return [];
    return [{ key: "native", assetId: null, symbol: productNetworks(state).find((network) => network.chainId === chainId)?.nativeSymbol || "原生", decimals: productNetworks(state).find((network) => network.chainId === chainId)?.nativeDecimals ?? 18, asset: null }]
      .concat(productAssets(state, chainId).map((asset) => ({ key: asset.assetId, assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, asset })));
  }
  async function request(name, input = {}) {
    if (working) throw new Error("正在处理上一步只读操作");
    working = true; clearError();
    try {
      const result = await client.action(name, input);
      apply(result);
      if (result?.balance) apply(result.balance);
      if (result?.state) apply(result.state);
      return result;
    } catch (error) {
      if (error?.status === 404) {
        service = "unavailable"; loaded = true;
        serviceError = "只读网络服务未接入或当前版本不支持；请更新 Magpie 中的 Oh My AIHub 插件后重试。";
        render(); throw new Error(serviceError);
      }
      throw error;
    } finally { working = false; render(); }
  }
  async function loadState() {
    if (loading || disposed || !getState()?.configured) return;
    loading = true; render();
    try {
      const result = await client.action("network-local-state", {});
      apply(result); service = "available"; serviceError = ""; loaded = true;
    } catch (error) {
      loaded = true;
      service = "unavailable";
      serviceError = error?.status === 404 || error?.status === 400
        ? "只读网络服务未接入或当前版本不支持；请更新 Magpie 中的 Oh My AIHub 插件后重试。"
        : "暂时无法读取只读网络状态；未知状态没有按零处理。";
      report(serviceError);
    } finally { loading = false; render(); }
  }
  function addWatch() {
    const value = watchInput?.input.value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) { fail("请填写非零的完整公开 watch 地址；它不是收款/签名授权。"); return; }
    if ((Array.isArray(state?.watchAddresses) ? state.watchAddresses : []).length >= 32) { fail("最多只能显式 watch 32 个公开地址；不会自动扩展地址簿。"); return; }
    watchInput.input.value = "";
    void request("network-local-watch-address", { address: value }).then(() => { selectedWatch = value.toLowerCase(); render(); report("已加入显式 watch 地址；仅用于只读余额查询。", "good"); }).catch((error) => fail(error?.message || "添加 watch 地址未完成"));
  }
  function setReceiving(chainId, selected) {
    void request("network-local-receiving-set", { chainId, selected }).then(() => report("已更新充值匹配网络；这不开启主网发送或授信。", "good")).catch((error) => fail(error?.message || "更新充值匹配网络未完成"));
  }
  function refreshBalance() {
    if (!selectedChain || !selectedAsset || !selectedWatch) { fail("请先选择明确的网络、资产和已 watch 地址；不会自动使用钱包连接地址。"); return; }
    const chainId = Number(selectedChain);
    const asset = selectedAsset ? selectedAsset : null;
    const assetId = asset && asset !== "native" ? asset : undefined;
    clearError();
    void request("network-local-balance-refresh", { chainId, address: selectedWatch, addressSource: "watch", ...(assetId ? { assetId } : {}) }).then((result) => {
      apply(result?.balance || result);
      if (lastBalance?.state === "unknown") report("余额未知；没有把缺失或错误结果填成 0。", "warn");
      else if (lastBalance?.state === "ok") report("只读余额已更新；它不是可消费信用。", "good");
      refreshState();
    }).catch((error) => fail(error?.message || "只读余额读取未完成"));
  }

  let watchInput = null;
  function renderNetworkCard(network) {
    const card = el("article", null, "wallet-network-card");
    const head = el("div", null, "section-heading");
    head.append(el("h3", network.displayName), pill("只读", "neutral"), pill("不可授信", "warn"));
    card.append(head, p(`${network.nativeSymbol} · ${network.nativeDecimals} 位原生小数 · 与另一网络平权，无 primary`));
    const assets = productAssets(state, network.chainId);
    if (!assets.length) card.append(p("注册表没有列出该网络的只读代币；不会按 symbol 猜测或补造。", "muted small"));
    else {
      const list = el("ul", null, "wallet-network-assets");
      for (const asset of assets) {
        const item = el("li");
        item.append(el("strong", `${asset.symbol} · ${asset.decimals} 位`), el("small", `${asset.assetId} · ${asset.issuerType} · credit:false · ${asset.pricingKind}`));
        list.append(item);
      }
      card.append(list);
    }
    if (network.chainId === 56) card.append(p("BSC USDC 未在只读注册表列出时不支持；不会按 symbol 推断或添加。", "muted small"));
    card.append(details("技术详情（只读）", [["chainId", network.chainId], ["support", network.support], ["receivable", network.receivable], ["nativeDecimals", network.nativeDecimals], ["blockExplorer", network.blockExplorer]]));
    return card;
  }
  function renderBalance() {
    const card = section("只读余额（显式 watch 地址）", "普通状态轮询不发起 RPC；只有你明确选择网络、资产和已 watch 地址后才会读取。");
    const watch = Array.isArray(state?.watchAddresses) ? state.watchAddresses : [];
    card.append(p(`已 watch：${watch.length ? watch.join(" · ") : "尚未添加"}。钱包连接地址不会自动成为 watch/收款地址。`, "muted small"));
    const addRow = el("div", null, "wallet-network-inline");
    watchInput = field("公开 watch 地址（0x + 40 hex，非零）");
    addRow.append(watchInput.label, button("添加 watch 地址", addWatch));
    card.append(addRow);
    const form = el("div", null, "wallet-network-refresh");
    const chain = select("网络", "请选择网络");
    for (const network of productNetworks(state)) { const option = el("option", `${network.displayName} · ${network.nativeSymbol}`); option.value = String(network.chainId); chain.input.append(option); }
    chain.input.value = selectedChain;
    chain.input.addEventListener("change", () => {
      selectedChain = chain.input.value; selectedAsset = "";
      asset.input.replaceChildren(); asset.input.append(el("option", "请先选择网络"));
      if (selectedChain) { const placeholder = el("option", "请选择资产"); placeholder.value = ""; asset.input.append(placeholder); for (const item of availableAssets(Number(selectedChain))) { const option = el("option", `${item.symbol} · ${item.decimals} 位`); option.value = item.key; asset.input.append(option); } }
      asset.input.value = "";
    });
    const asset = select("资产", "请先选择网络");
    if (selectedChain) { const placeholder = el("option", "请选择资产"); placeholder.value = ""; asset.input.append(placeholder); for (const item of availableAssets(Number(selectedChain))) { const option = el("option", `${item.symbol} · ${item.decimals} 位`); option.value = item.key; asset.input.append(option); } asset.input.value = selectedAsset; }
    asset.input.addEventListener("change", () => { selectedAsset = asset.input.value; });
    const address = select("已 watch 地址", "请先添加并选择 watch 地址");
    for (const item of watch) { const option = el("option", item); option.value = item; address.input.append(option); }
    address.input.value = selectedWatch;
    address.input.addEventListener("change", () => { selectedWatch = address.input.value; });
    form.append(chain.label, asset.label, address.label, button("读取所选只读余额", refreshBalance, true));
    card.append(form);
    if (!lastBalance) card.append(p("尚未读取余额；未知不会显示为 0。", "muted small"));
    else if (lastBalance.state === "unknown") card.append(p(`余额未知（${lastBalance.errorCode || "balance_unavailable"}）；未按 0 处理，也没有美元估值。`, "inline-warning"));
    else if (lastBalance.state === "ok") {
      const decimals = lastBalance.asset?.decimals ?? lastBalance.decimals;
      let amount = "未知";
      try { amount = formatTokenUnits(lastBalance.balanceRaw, decimals); } catch { /* malformed stays unknown */ }
      const freshness = balanceFreshness(lastBalance);
      const freshnessText = freshness === "fresh" ? "5 分钟内的只读证据，仍需按观察/过期时间判断" : freshness === "stale" ? "历史已知余额，已过期或需手动刷新；不是实时，也不是可消费额度" : "新鲜度未知；请手动刷新，不显示为实时绿";
      if (freshness !== "fresh") card.append(p(freshnessText, "inline-warning"));
      card.append(details("最近一次只读查询", [["网络", lastBalance.chainId], ["地址", lastBalance.address], ["地址来源", lastBalance.addressSource === "watch" ? "显式 watch" : "非 watch（不应作为可信余额）"], ["资产", lastBalance.asset?.symbol || lastBalance.nativeSymbol], ["原始余额", lastBalance.balanceRaw], ["显示余额", amount], ["小数位", decimals], ["区块", lastBalance.blockNumber], ["只读", lastBalance.readOnly === true ? "是" : "未知"], ["可授信", lastBalance.creditEligible === true ? "是" : "否"], ["美元估值", lastBalance.usdValue === null ? "未估值（不伪造 $）" : lastBalance.usdValue], ["观察时间", lastBalance.observedAt], ["过期时间", lastBalance.expiresAt], ["新鲜度", freshnessText]], true));
      card.append(p("只读余额不是可消费额度，也不等于 provider 信用；主网资金当前未开放。", "muted small"));
    }
    return card;
  }
  function renderReceiving() {
    const card = section("接受哪些网络充值", "默认不选择。BSC/Base 可单选、双选或清空，仅用于付款请求与自动授信匹配设置。");
    if (state?.receiving?.available === false || state?.receiving?.errorCode) {
      card.append(p(`充值网络选择当前无法读取（${state?.receiving?.errorCode || "receiving_unavailable"}）。chainIds=[] 不代表你清空了选择；不会自动覆盖或猜链。`, "inline-warning"));
      card.append(button("重新读取状态", () => { service = "unknown"; loaded = true; void loadState(); }));
      return card;
    }
    const chains = receivingChainIds(state);
    const list = el("div", null, "wallet-network-receiving");
    for (const network of productNetworks(state)) {
      const item = check(`${network.displayName}（chainId ${network.chainId}）`);
      item.input.checked = chains.includes(network.chainId);
      item.input.disabled = working;
      item.input.addEventListener("change", () => setReceiving(network.chainId, item.input.checked));
      list.append(item.label);
    }
    card.append(list, p("主网发送、授信、自动充值和资金流当前未开放；选择充值网络不会解除这些门禁。此设置只影响本机付款请求/自动授信匹配，不宣称链上禁止其他人转账。", "inline-warning"));
    return card;
  }
  function balanceFreshness(balance) {
    if (!balance || balance.state !== "ok") return "unknown";
    if (balance.fresh === false || balance.stale === true || balance.needsRefresh === true) return "stale";
    const expires = Date.parse(balance.expiresAt || "");
    if (Number.isFinite(expires)) return Date.now() < expires ? (balance.fresh === true ? "fresh" : "unknown") : "stale";
    if (balance.fresh === true) return "fresh";
    return "unknown";
  }
  function render() {
    if (disposed) return;
    root.replaceChildren();
    const heading = el("div", null, "section-heading");
    heading.append(el("h2", "只读网络与资产"), pill(service === "unavailable" ? "服务未接入" : loading ? "正在读取" : "只读", service === "unavailable" ? "warn" : "neutral"));
    root.append(heading, p("BSC 56 与 Base 8453 平权只读；与 provider 信用/钱包资产分开，不伪造余额。", "muted"));
    if (loading || service === "unknown") { root.append(p("正在读取只读网络状态…")); return; }
    if (service === "unavailable") { const card = section("只读网络服务未接入", serviceError || "当前服务没有提供只读网络动作。"); card.append(button("重新读取", () => { service = "unknown"; loaded = true; void loadState(); }), p("未接入时不会显示 mock 成功、余额或可授信状态。", "inline-warning")); root.append(card); return; }
    if (!state || state.available !== true) { const card = section("只读网络暂不可用", state?.reason || "服务返回 available:false；没有把未知当作零资产。"); card.append(button("重新读取", () => { service = "unknown"; loaded = true; void loadState(); })); root.append(card); return; }
    const networks = productNetworks(state);
    if (networks.length !== 2) { root.append(p("只读注册表没有同时提供 BSC 56 与 Base 8453；不会补造缺失网络。", "inline-warning")); }
    const grid = el("div", null, "wallet-network-grid");
    for (const network of networks) grid.append(renderNetworkCard(network));
    root.append(grid, renderReceiving(), renderBalance(), errorLine);
  }
  async function onShow() {
    if (disposed) return;
    if (!loaded && !loading) await loadState();
    else render();
  }
  function reset() { state = null; lastBalance = null; loaded = false; loading = false; service = "unknown"; serviceError = ""; selectedWatch = ""; selectedChain = ""; selectedAsset = ""; render(); }
  function dispose() { disposed = true; root.replaceChildren(); }
  render();
  return { render(next) { if (next?.networkLocal) { apply(next.networkLocal); service = "available"; loaded = true; } if (!loading) render(); }, onShow, reset, dispose };
}
