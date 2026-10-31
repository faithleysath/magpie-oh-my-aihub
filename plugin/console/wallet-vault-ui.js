/* Local wallet + external-wallet UI.
 *
 * This module renders the approved local vault adapter actions and the approved
 * EIP-6963 adapter. It never persists or caches a password, mnemonic, private
 * key, keystore or signing response. Sensitive values exist only in a dialog-
 * local reference while the user explicitly reveals them; closing, leaving the
 * page, locking or session expiry clears the DOM and reference.
 *
 * Payment sending is intentionally absent: the durable journal is not wired to
 * this console, so no send button or mock sender exists here.
 */
import { createWalletDiscovery, createExternalWallet } from "./external-wallet.js";

const TEST_CHAINS = new Set([97, 84532]);
const STATUS_LABEL = { absent: "尚未创建", locked: "已锁定", unlocked: "已解锁" };
const REVEAL_PURPOSES = {
  mnemonic: [["wallet-recovery", "恢复钱包"], ["wallet-migration", "迁移钱包"]],
  "private-key": [["eip155-external-wallet", "导入另一钱包"], ["wallet-migration", "迁移钱包"]],
};

export function walletStatusLabel(status) {
  return STATUS_LABEL[status] || "状态未知";
}

/** A locked/absent address is never a trusted receiving address. */
export function walletAddressView(wallet) {
  if (!wallet || typeof wallet !== "object" || !wallet.address) return { address: null, trusted: false, label: "尚无公开地址" };
  if (wallet.status === "unlocked" && wallet.addressVerified === true) return { address: wallet.address, trusted: true, label: "当前会话已验证" };
  return { address: wallet.address, trusted: false, label: "未验证地址，不能作为收款地址" };
}

export function mountWalletVault({ client, getState, notice = () => {}, refreshState = async () => {}, windowTarget = globalThis.window } = {}) {
  const root = document.getElementById("wallet-vault-panel");
  if (!root) return { render() {}, onShow() {}, clearSecrets() {}, dispose() {}, snapshot() { return null; } };
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (className) node.className = className; return node; };
  const localRoot = el("div", null, "wallet-vault-local");
  const externalRoot = el("div", null, "wallet-external-root");
  root.append(localRoot, externalRoot);
  const p = (text, className = "muted") => el("p", text, className);
  const button = (text, callback, primary = false) => { const node = el("button", text, `button ${primary ? "primary" : "secondary"}`); node.type = "button"; node.disabled = false; node.addEventListener("click", callback); return node; };
  const field = (text, type = "text", value = "") => {
    const label = el("label", null, "field");
    const input = el("input"); input.type = type; input.value = value; input.autocomplete = type === "password" ? "new-password" : "off";
    if (type === "password") { input.setAttribute("data-1p-ignore", ""); input.setAttribute("data-bwignore", ""); }
    label.append(el("span", text), input); return { label, input };
  };
  const area = (text, placeholder = "") => {
    const label = el("label", null, "field");
    const input = el("textarea"); input.value = ""; input.placeholder = placeholder; input.autocomplete = "off"; input.rows = 4;
    input.setAttribute("data-1p-ignore", ""); input.setAttribute("data-bwignore", "");
    label.append(el("span", text), input); return { label, input };
  };
  const check = (text) => { const label = el("label", null, "workflow-check"); const input = el("input"); input.type = "checkbox"; label.append(input, el("span", text)); return { label, input }; };
  const select = (text, choices, placeholder = "请明确选择") => {
    const label = el("label", null, "field"); const input = el("select"); input.setAttribute("aria-label", text);
    const option = (value, title) => { const node = el("option", title); node.value = String(value); return node; };
    input.append(option("", placeholder)); for (const [value, title] of choices) input.append(option(value, title)); input.value = "";
    label.append(el("span", text), input); return { label, input };
  };
  const details = (title, values, open = false) => {
    const node = el("details", null, "workflow-details"); node.open = open; node.append(el("summary", title));
    for (const [label, value] of values) { const row = el("div"); row.append(el("strong", label), el("span", value ?? "未知")); node.append(row); }
    return node;
  };
  const section = (title, text) => { const node = el("section", null, "card workflow-section wallet-vault-section"); node.append(el("h2", title)); if (text) node.append(p(text)); return node; };
  const pill = (text, tone = "neutral") => el("span", text, `pill ${tone}`);
  const choice = (title, text, action) => { const card = el("div", null, "wallet-choice"); card.append(el("h3", title), p(text), action); return card; };

  const dialog = el("dialog", null, "workflow-dialog wallet-vault-dialog");
  const dialogTitle = el("h2"); dialogTitle.id = "wallet-vault-dialog-title";
  const dialogHead = el("div", null, "section-heading");
  dialogHead.append(dialogTitle, button("关闭", () => closeDialog()));
  const dialogBody = el("div", null, "dialog-content");
  const dialogError = el("p", null, "form-error"); dialogError.hidden = true; dialogError.setAttribute("role", "alert");
  dialog.append(dialogHead, dialogBody, dialogError); document.body.append(dialog);
  dialog.setAttribute("aria-labelledby", dialogTitle.id);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener("close", () => { if (!dialog.open && (secret || dialogBody.children.length)) closeDialog({ bump: false }); });

  let wallet = null;
  let service = "unknown";
  let serviceError = "";
  let loaded = false;
  let loading = false;
  let working = false;
  let secret = null;
  let secretKind = null;
  let secretVisible = false;
  let selectedProviderId = null;
  let externalSession = null;
  let externalState = null;
  let discovery = null;
  let discoveryStarted = false;
  let disposed = false;
  let generation = 0;

  function report(message, tone = "warn") { try { notice(message, tone); } catch { /* notice is advisory */ } }
  function fail(message) { dialogError.textContent = message; dialogError.hidden = false; }
  function clearInputs(node = dialogBody) { for (const input of node.querySelectorAll?.("input,textarea") || []) { input.value = ""; input.checked = false; } }
  function closeDialog({ bump = true } = {}) {
    secret = null; secretKind = null; secretVisible = false;
    if (dialogBody) dialogBody.replaceChildren();
    if (dialogError) { dialogError.textContent = ""; dialogError.hidden = true; }
    if (dialog.open) dialog.close();
    if (bump) generation++;
  }
  function openDialog(title, build) {
    closeDialog();
    dialogTitle.textContent = title; dialogError.hidden = true;
    build(dialogBody);
    dialog.showModal();
  }
  function openSecretDialog(value, kind, warning, token = generation) {
    // A late response from a closed/navigated/disposed flow must never reopen
    // the secret dialog or restore a secret reference.
    if (disposed || token !== generation) return false;
    if (!wallet || wallet.status !== "unlocked" || wallet.addressVerified !== true) return false;
    closeDialog({ bump: false });
    secret = value; secretKind = kind; secretVisible = false;
    dialogTitle.textContent = kind === "mnemonic" ? "恢复助记词 · 仅显示一次" : kind === "private-key" ? "私钥 · 仅显示一次" : "加密备份";
    dialogError.hidden = true;
    const body = dialogBody;
    body.append(el("p", warning, "inline-warning"));
    const pre = el("pre", "", "wallet-vault-secret"); pre.setAttribute("aria-label", "敏感内容，默认隐藏");
    const status = el("p", "默认隐藏。显示后请在本页核对，不要截图、粘贴到聊天或保存到日志。", "muted small");
    const actions = el("div", null, "workflow-actions");
    const toggle = button("显示内容", () => {
      secretVisible = !secretVisible;
      pre.textContent = secretVisible ? secret : "";
      status.textContent = secretVisible ? "内容已显示。完成后点“结束并清除”。" : "内容已隐藏。";
      toggle.textContent = secretVisible ? "隐藏内容" : "显示内容";
    }, true);
    const end = button("结束并清除", () => closeDialog());
    actions.append(toggle, end);
    body.append(pre, status, actions);
    try { dialog.showModal(); } catch { secret = null; secretKind = null; secretVisible = false; dialogBody.replaceChildren(); return false; }
    return true;
  }

  async function action(name, input = {}, token = generation) {
    if (working) throw new Error("正在处理上一步操作");
    working = true;
    try {
      const result = await client.action(name, input);
      if (disposed || token !== generation) return result;
      if (result?.wallet) applyWallet(result.wallet);
      return result;
    } catch (error) {
      if (disposed || token !== generation) throw error;
      if (error?.status === 404) {
        service = "unavailable";
        serviceError = "本地钱包服务未接入或当前版本不支持；请更新 Magpie 中的 Oh My AIHub 插件后重试。";
        loaded = true;
        render();
        throw new Error(serviceError);
      }
      throw error;
    } finally {
      working = false;
    }
  }

  function applyWallet(next, renderNow = true) {
    if (!next || typeof next !== "object") return;
    const wasTrusted = wallet?.status === "unlocked" && wallet.addressVerified === true;
    wallet = { version: next.version, address: next.address ?? null, addressVerified: next.addressVerified === true, status: next.status, unlockExpiresAt: next.unlockExpiresAt ?? null };
    const invalid = wallet.status !== "unlocked" || wallet.addressVerified !== true;
    if (invalid && (wasTrusted || secret !== null || dialog.open)) {
      generation++;
      closeDialog({ bump: false });
      clearInputs();
    }
    if (renderNow) render();
  }

  async function loadStatus() {
    if (loading || disposed || !getState()?.configured) return;
    const token = generation;
    loading = true; render();
    try {
      const result = await client.action("wallet-vault-status", {});
      if (disposed || token !== generation) return;
      if (result?.wallet) applyWallet(result.wallet, true);
      service = "available"; serviceError = ""; loaded = true;
    } catch (error) {
      if (disposed || token !== generation) return;
      loaded = true;
      service = "unavailable";
      serviceError = error?.status === 404 || error?.status === 400
        ? "本地钱包服务未接入或当前版本不支持；请更新 Magpie 中的 Oh My AIHub 插件后重试。"
        : "暂时无法读取本地钱包状态；没有把未知状态当作未创建。";
      report(serviceError);
    } finally {
      loading = false;
      if (!disposed && token === generation) render();
    }
  }

  const SAFE_ERRORS = {
    "wallet-invalid-input": "输入不符合本地钱包要求。",
    "wallet-session-required": "需要当前已认证的本地浏览器会话。",
    "wallet-unlock-required": "请先解锁并验证钱包。",
    "wallet-password-invalid": "钱包密码验证失败。",
    "wallet-locked": "钱包已锁定。",
    "wallet-exists": "本机已有钱包；请使用导入/恢复或当前密码替换。",
    "wallet-absent": "本机还没有钱包。",
    "wallet-keystore-invalid": "钱包文件无效或不可安全读取。",
    "wallet-mnemonic-invalid": "恢复助记词无效。",
    "wallet-reveal-invalid": "敏感导出授权无效或已过期。",
    "wallet-operation-failed": "本地钱包操作未完成；未自动重试。",
  };
  function actionError(error) { fail(SAFE_ERRORS[error?.code] || "本地钱包操作未完成；未自动重试。"); }
  function passwordPair() {
    const password = field("钱包密码（至少 12 位）", "password");
    const confirm = field("再次输入密码", "password");
    password.input.minLength = 12; password.input.maxLength = 1024; confirm.input.minLength = 12; confirm.input.maxLength = 1024;
    return { password, confirm };
  }
  function validPasswordPair(password, confirm) {
    return typeof password.input.value === "string" && password.input.value.length >= 12 && password.input.value === confirm.input.value;
  }
  function replaceFields() {
    if (!wallet || wallet.status === "absent") return null;
    const replace = check("替换本机已有钱包（需要当前密码）");
    const current = field("当前钱包密码", "password"); current.input.minLength = 1; current.input.maxLength = 1024;
    const wrap = el("div", null, "wallet-vault-replace");
    wrap.append(replace.label, current.label);
    current.label.hidden = true;
    replace.input.addEventListener("change", () => { current.label.hidden = !replace.input.checked; });
    return { wrap, replace, current, active: () => replace.input.checked };
  }

  function createWalletDialog() {
    openDialog("创建本地钱包", (body) => {
      body.append(p("钱包密钥只加密保存在这台设备。创建后会一次性显示恢复助记词；本页不会把它写入浏览器存储、日志或普通状态。", "inline-warning"));
      const pair = passwordPair();
      const strength = select("助记词强度", [[128, "128 位（12 词）"], [160, "160 位（15 词）"], [192, "192 位（18 词）"], [224, "224 位（21 词）"], [256, "256 位（24 词）"]], "默认 128 位");
      strength.input.value = "128";
      const agree = check("我理解恢复助记词只显示一次，必须离线备份；丢失后无法由本应用恢复");
      const submit = button("创建钱包", async () => {
        if (!validPasswordPair(pair.password, pair.confirm)) { fail("两次密码必须一致，且至少 12 位。"); return; }
        if (!agree.input.checked) { fail("请确认恢复信息保护提醒。"); return; }
        const password = pair.password.input.value; pair.password.input.value = ""; pair.confirm.input.value = "";
        const token = generation;
        submit.disabled = true;
        try {
          const result = await action("wallet-vault-create", { password, strength: Number(strength.input.value) || 128 }, token);
          if (disposed) return;
          if (token !== generation) {
            if (result?.wallet && getState()?.configured) applyWallet(result.wallet);
            report("钱包已创建；恢复助记词未显示。请重新解锁后导出助记词，不能自动重复创建钱包。", "warn");
            return;
          }
          if (typeof result?.mnemonic !== "string" || !result.mnemonic) throw new Error("钱包已创建，但没有收到一次性恢复助记词；请立即检查钱包状态并按恢复流程处理。");
          openSecretDialog(result.mnemonic, "mnemonic", result.warning || "这是唯一一次显示恢复助记词。请立即离线备份；不要粘贴到网站、聊天或日志。", token);
        } catch (error) { actionError(error); submit.disabled = false; }
      }, true);
      agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      submit.disabled = true;
      body.append(pair.password.label, pair.confirm.label, strength.label, agree.label, submit);
    });
  }

  function importWalletDialog(restore = false) {
    openDialog(restore ? "恢复加密备份" : "导入已有助记词", (body) => {
      body.append(p(restore ? "只在本机内存中读取加密备份；提交后不保留文件或明文。备份密码只用于本次恢复。" : "助记词只在本机内存中用于导入；提交后不保留明文。不会把助记词发送到网络或写入普通状态。", "inline-warning"));
      const secretInput = restore ? area("加密备份内容（JSON，最多 32 KiB）", "粘贴加密备份") : area("恢复助记词（12–24 个词）", "按钱包给出的顺序输入");
      secretInput.input.maxLength = restore ? 32768 : 4096;
      const pair = passwordPair();
      const replacement = replaceFields();
      const agree = check(restore ? "我已核对备份来源，明确恢复此钱包" : "我已核对助记词来源，明确导入此钱包");
      const submit = button(restore ? "恢复钱包" : "导入钱包", async () => {
        if (!secretInput.input.value.trim()) { fail(restore ? "请粘贴加密备份。" : "请输入恢复助记词。"); return; }
        if (!validPasswordPair(pair.password, pair.confirm)) { fail("两次密码必须一致，且至少 12 位。"); return; }
        if (replacement?.active() && !replacement.current.input.value) { fail("覆盖已有钱包需要当前密码。"); return; }
        if (!agree.input.checked) { fail("请确认钱包恢复信息来源与操作范围。"); return; }
        const secretValue = secretInput.input.value;
        const password = pair.password.input.value;
        const currentPassword = replacement?.active() ? replacement.current.input.value : undefined;
        secretInput.input.value = ""; pair.password.input.value = ""; pair.confirm.input.value = ""; if (replacement) replacement.current.input.value = "";
        submit.disabled = true;
        try {
          const input = restore
            ? { encryptedBackup: secretValue, password, ...(replacement?.active() ? { replace: true, currentPassword } : {}) }
            : { mnemonic: secretValue, password, ...(replacement?.active() ? { replace: true, currentPassword } : {}) };
          await action(restore ? "wallet-vault-restore" : "wallet-vault-import", input);
          closeDialog();
          report(restore ? "钱包已从加密备份恢复；请核对地址是否可信。" : "钱包已导入；请核对地址是否可信。", "good");
          await refreshState();
        } catch (error) { actionError(error); submit.disabled = false; }
      }, true);
      submit.disabled = true; agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      body.append(secretInput.label, pair.password.label, pair.confirm.label);
      if (replacement) body.append(replacement.wrap);
      body.append(agree.label, submit);
    });
  }

  function unlockDialog() {
    openDialog("解锁本地钱包", (body) => {
      body.append(p("解锁后只在当前控制台会话内保持短时可用；离开页面、锁定或会话过期后需要重新输入密码。"));
      const password = field("钱包密码", "password"); password.input.maxLength = 1024;
      const submit = button("解锁", async () => {
        if (!password.input.value) { fail("请输入钱包密码。"); return; }
        const value = password.input.value; password.input.value = ""; submit.disabled = true;
        try { await action("wallet-vault-unlock", { password: value }); closeDialog(); report("钱包已解锁；地址仅在当前解锁会话内可视为已验证。", "good"); }
        catch (error) { actionError(error); submit.disabled = false; }
      }, true);
      body.append(password.label, submit);
    });
  }

  function backupDialog() {
    openDialog("生成加密备份", (body) => {
      body.append(p("加密备份仍包含可使用密码解开的钱包材料。只在本机生成，默认隐藏；不要粘贴到聊天、日志或普通状态。", "inline-warning"));
      const agree = check("我理解这是敏感文件，准备保存到离线位置");
      const submit = button("生成加密备份", async () => {
        if (!agree.input.checked) { fail("请确认保存边界。"); return; }
        const token = generation;
        submit.disabled = true;
        try {
          const result = await action("wallet-vault-backup", {}, token);
          if (disposed || token !== generation) return;
          const value = typeof result.keystore === "string" ? result.keystore : JSON.stringify(result.keystore ?? result, null, 2);
          openSecretDialog(value, "backup", "这是密码保护的加密备份。请保存到离线位置；本页不会自动下载、复制或写入浏览器存储。", token);
        } catch (error) { actionError(error); submit.disabled = false; }
      }, true);
      submit.disabled = true; agree.input.addEventListener("change", () => { submit.disabled = !agree.input.checked; });
      body.append(agree.label, submit);
    });
  }

  function revealDialog(kind) {
    openDialog(kind === "mnemonic" ? "导出恢复助记词" : "导出私钥", (body) => {
      body.append(p("敏感导出是独立操作：需要先确认用途并生成一次性授权，再输入密码复验。默认隐藏，关闭/结束/离页/会话过期会清除内容。", "inline-warning"));
      const purpose = select("明确用途", REVEAL_PURPOSES[kind], "请选择用途");
      const agree = check(kind === "mnemonic" ? "我已核对这是本地设备上的钱包，并明确请求显示恢复助记词" : "我已核对这是本地设备上的钱包，并明确请求显示私钥");
      const authorize = button("生成一次性导出授权", async () => {
        if (!purpose.input.value) { fail("请选择明确的导出用途。"); return; }
        if (!agree.input.checked) { fail("请先确认导出范围与风险。"); return; }
        const value = purpose.input.value; const token = generation; authorize.disabled = true;
        try {
          const result = await action("wallet-vault-reveal-authorize", { kind, purpose: value, confirmation: "local-user-confirmed" }, token);
          if (disposed || token !== generation) return;
          if (!result?.authorizationId) throw new Error("没有收到一次性导出授权，请重新操作。");
          passwordRevealDialog(kind, result.authorizationId, value);
        } catch (error) { actionError(error); authorize.disabled = false; }
      }, true);
      authorize.disabled = true; agree.input.addEventListener("change", () => { authorize.disabled = !agree.input.checked; });
      body.append(purpose.label, agree.label, authorize);
    });
  }

  function passwordRevealDialog(kind, authorizationId, purpose) {
    openDialog("密码复验 · 一次性敏感导出", (body) => {
      body.append(p("授权已生成，且只绑定当前会话。密码错误会消耗授权并可能锁定钱包；不会自动重试。", "inline-warning"));
      const password = field("再次输入钱包密码", "password"); password.input.maxLength = 1024;
      const submit = button("显示一次", async () => {
        if (!password.input.value) { fail("请输入钱包密码。"); return; }
        const value = password.input.value; password.input.value = ""; const token = generation; submit.disabled = true;
        try {
          const result = await action(kind === "mnemonic" ? "wallet-vault-reveal-mnemonic" : "wallet-vault-reveal-private-key", { authorizationId, password: value }, token);
          if (disposed || token !== generation) return;
          const secretValue = kind === "mnemonic" ? result?.mnemonic : result?.privateKey;
          if (typeof secretValue !== "string" || !secretValue) throw new Error("没有收到敏感内容；授权可能已失效，请重新开始。");
          openSecretDialog(secretValue, kind, `用途：${purpose}。内容默认隐藏；显示后请在本页核对，不要截图、粘贴到聊天或保存到日志。`, token);
        } catch (error) { actionError(error); submit.disabled = false; }
      }, true);
      body.append(password.label, submit);
    });
  }

  function render(next = null) {
    if (disposed) return;
    if (next?.walletVault?.wallet) {
      service = "available"; loaded = true;
      applyWallet(next.walletVault.wallet, false);
    }
    if (disposed) return;
    localRoot.replaceChildren();
    const heading = el("div", null, "section-heading");
    heading.append(el("h2", "本地钱包"), pill(service === "unavailable" ? "服务未接入" : loading ? "正在读取" : wallet ? walletStatusLabel(wallet.status) : "尚未读取", service === "unavailable" || wallet?.status === "locked" ? "warn" : wallet?.status === "unlocked" ? "good" : "neutral"));
    localRoot.append(heading, p("测试网本地钱包。密钥加密保存在本机；这里不发起付款，也不把资产余额当成提供者信用。", "muted"));
    if (loading || service === "unknown") { localRoot.append(p("正在读取本地钱包状态…")); renderExternal(); return; }
    if (service === "unavailable") {
      const card = section("本地钱包服务未接入", serviceError || "当前服务没有提供钱包动作。");
      card.append(button("重新读取状态", () => { loaded = true; service = "unknown"; void loadStatus(); }), p("在服务接入前，本页不会创建钱包、不会假装已创建，也不会提供模拟发送。", "inline-warning"));
      localRoot.append(card); renderExternal(); return;
    }
    if (!wallet || wallet.status === "absent") {
      localRoot.append(section("还没有本地钱包", "选择下面一项明确开始；创建和导入都需要密码与恢复信息保护确认。"));
      const choices = el("div", null, "wallet-choice-grid");
      choices.append(
        choice("创建新钱包", "生成新的本地测试网钱包，并一次性显示恢复助记词。", button("创建钱包", () => createWalletDialog(), true)),
        choice("连接已有钱包", "导入助记词、恢复加密备份，或连接已安装的 EIP-6963 浏览器钱包扩展。", button("选择已有钱包方式", () => connectChoiceDialog())),
      );
      localRoot.append(choices);
    } else {
      const view = walletAddressView(wallet);
      const card = section("本地钱包状态", wallet.status === "unlocked" ? "钱包已解锁；地址仅在当前解锁会话内可视为已验证。" : "钱包已锁定；公开地址不代表已验证，不能用于收款或转账目标。");
      const facts = el("dl", null, "facts wallet-vault-facts");
      const fact = (label, value) => { const row = el("div"); row.append(el("dt", label), el("dd", value)); facts.append(row); };
      fact("状态", walletStatusLabel(wallet.status));
      fact("公开地址", view.address || "未提供");
      fact("地址可信状态", view.label);
      fact("解锁到期", wallet.unlockExpiresAt ? new Date(wallet.unlockExpiresAt).toLocaleString("zh-CN", { hour12: false }) : "未解锁");
      card.append(facts);
      if (!view.trusted) card.append(p("不要把此地址当作可信收款地址。只有解锁后本机验证通过，才可在明确的收款流程中显示。", "inline-warning"));
      const actions = el("div", null, "workflow-actions");
      if (wallet.status === "locked") actions.append(button("解锁", () => unlockDialog(), true));
      if (wallet.status === "unlocked") actions.append(button("锁定", async () => { try { await action("wallet-vault-lock", {}); closeDialog(); report("钱包已锁定；敏感导出授权已失效。", "good"); } catch { report("钱包锁定未完成；未自动重试。", "warn"); } }));
      actions.append(button("刷新状态", () => { service = "unknown"; void loadStatus(); }));
      if (wallet.status === "unlocked") actions.append(button("生成加密备份", () => backupDialog()), button("导出恢复助记词", () => revealDialog("mnemonic")), button("导出私钥", () => revealDialog("private-key")));
      actions.append(button("导入或恢复其他钱包", () => connectChoiceDialog()));
      card.append(actions); localRoot.append(card);
    }
    renderExternal();
  }

  function connectChoiceDialog() {
    openDialog("连接已有钱包", (body) => {
      body.append(p("选择一种明确方式。导入/恢复只在本机处理；浏览器扩展必须由你在下一屏选择具体钱包，不会自动使用 window.ethereum。", "inline-warning"));
      const choices = el("div", null, "wallet-choice-grid");
      choices.append(
        choice("导入助记词", "用已有钱包的恢复助记词在本机创建加密副本。", button("导入助记词", () => importWalletDialog(false), true)),
        choice("恢复加密备份", "用密码保护的 keystore 备份恢复。", button("恢复加密备份", () => importWalletDialog(true))),
        choice("连接浏览器扩展", "使用已安装的 EIP-6963 钱包，不索取助记词。", button("查看浏览器钱包", () => { closeDialog(); externalRoot?.scrollIntoView?.({ block: "start" }); })),
      );
      body.append(choices);
    });
  }

  // ---------- external EIP-6963 wallet ----------
  function ensureDiscovery() {
    if (discovery) return discovery;
    discovery = createWalletDiscovery({ target: windowTarget || globalThis.window, now: Date.now });
    discovery.subscribe(() => { if (externalRoot) renderExternal(); });
    return discovery;
  }
  function renderExternal() {
    if (!externalRoot) return;
    externalRoot.replaceChildren();
    const card = section("连接浏览器钱包（EIP-6963）", "只在用户明确选择后连接；不自动读取 window.ethereum，不索取助记词，不使用钱包提供的 SVG/data 图标。");
    if (!discoveryStarted) { card.append(p("打开钱包页后才开始发现扩展。")); externalRoot.append(card); return; }
    const entries = discovery.list();
    const legacy = discovery.legacy();
    if (!entries.length && !legacy) {
      card.append(p("没有发现 EIP-6963 钱包。请安装/解锁扩展后刷新；本页不会回退到自动 window.ethereum。", "inline-warning"));
      card.append(button("重新发现", () => discovery.request()));
      externalRoot.append(card); return;
    }
    const list = el("div", null, "wallet-external-list");
    for (const entry of entries) {
      const row = el("article", null, "wallet-external-row");
      const avatar = el("span", entry.initial || "?", "wallet-external-avatar"); avatar.setAttribute("aria-hidden", "true");
      const body = el("div"); body.append(el("strong", entry.name), el("small", `${entry.rdns || "未提供来源"} · 信息未验证`));
      const pick = button(selectedProviderId === entry.id ? "已选择" : "选择此钱包", () => { selectedProviderId = entry.id; externalState = null; renderExternal(); });
      row.append(avatar, body, pick); list.append(row);
    }
    if (legacy) {
      const row = el("article", null, "wallet-external-row");
      const avatar = el("span", legacy.initial || "旧", "wallet-external-avatar"); avatar.setAttribute("aria-hidden", "true");
      const body = el("div"); body.append(el("strong", legacy.name), el("small", "旧式注入钱包 · 仅在你明确选择时使用，信息未验证"));
      row.append(avatar, body, button(selectedProviderId === "legacy" ? "已选择" : "显式选择旧式钱包", () => { selectedProviderId = "legacy"; externalState = null; renderExternal(); }));
      list.append(row);
    }
    card.append(list);
    if (selectedProviderId) {
      card.append(p(`已选择：${selectedProviderId === "legacy" ? "旧式注入钱包" : entries.find((entry) => entry.id === selectedProviderId)?.name || "钱包"}。点击连接前不会请求账户。`, "muted small"));
      if (externalSession) {
        const snapshot = externalState || externalSession.snapshot();
        card.append(details("已连接外部钱包", [["账户", snapshot.account || "未返回"], ["chainId", snapshot.chainId ?? "未返回"], ["状态", snapshot.status], ["连接方式", snapshot.selection?.source === "legacy" ? "显式旧式注入" : "EIP-6963 显式选择"]], true));
        card.append(p("外部钱包余额查询需要已接入的资产注册表；本页不伪造余额，也不发起付款。", "muted small"));
        card.append(button("断开外部钱包", () => { externalSession?.dispose(); externalSession = null; externalState = null; renderExternal(); }));
      } else {
        card.append(button("连接所选钱包", async () => {
          try {
            const session = createExternalWallet({ discovery, selectionId: selectedProviderId, now: Date.now });
            await session.connect({ userInitiated: true });
            externalSession = session; externalState = session.snapshot();
            session.subscribe((next) => { externalState = next; if (externalRoot) renderExternal(); });
            renderExternal();
          } catch { report("外部钱包连接未完成；未自动重试。", "warn"); }
        }, true));
      }
    } else {
      card.append(p("请先选择一个钱包；选择不会连接，也不会请求账户。", "muted small"));
    }
    externalRoot.append(card);
  }

  function onShow() {
    if (disposed) return;
    if (!discoveryStarted) { ensureDiscovery().start(); discoveryStarted = true; }
    if (!loaded && !loading) void loadStatus();
    render();
    renderExternal();
  }

  function clearSecrets() {
    closeDialog();
    if (dialogBody) clearInputs(dialogBody);
    secret = null; secretKind = null; secretVisible = false;
  }
  function disconnectExternal() {
    externalSession?.dispose(); externalSession = null; externalState = null;
    if (externalRoot) renderExternal();
  }
  function reset() {
    clearSecrets();
    disconnectExternal();
    wallet = null; service = "unknown"; serviceError = ""; loaded = false; loading = false; selectedProviderId = null;
    render();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    clearSecrets();
    disconnectExternal();
    discovery?.stop(); discovery = null; discoveryStarted = false;
    windowTarget?.removeEventListener?.("pagehide", onPageHide);
    dialog.remove();
  }

  const onPageHide = () => { clearSecrets(); externalSession?.dispose(); externalSession = null; discovery?.stop(); };
  windowTarget?.addEventListener?.("pagehide", onPageHide);

  render();
  return { render, onShow, clearSecrets, disconnectExternal, reset, dispose, snapshot() { return wallet; } };
}
