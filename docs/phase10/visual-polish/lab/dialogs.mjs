/**
 * Phase 10 visual-polish dialog evidence (ego-lite).
 *
 *   ego-browser nodejs < docs/phase10/visual-polish/lab/dialogs.mjs
 *
 * Opens the real console dialogs the page matrix cannot see — browser-wallet
 * connection, external-wallet area, the human approval with its selected quote
 * preview, the recharge form and its error — and records the visible text audit
 * for each. A closed <details> contributes only its summary, like a browser.
 * Cookies and secrets are never printed or screenshotted.
 */
const fs = await import("node:fs/promises");
const path = await import("node:path");

const REPO = "/Users/laysath/.paseo/worktrees/1z728cdk/phase10-visual-polish";
const OUT = path.join(REPO, "docs/phase10/visual-polish/evidence/final");
const roots = (await fs.readdir("/tmp")).filter((name) => name.startsWith("ohmyaihub-visual-")).sort();
let labRoot = null;
for (const name of roots.reverse()) {
  try {
    const lab = JSON.parse(await fs.readFile(path.join("/tmp", name, "lab.json"), "utf8"));
    if (lab.nodes?.every((node) => node.consolePort)) { labRoot = path.join("/tmp", name); break; }
  } catch { /* not a lab */ }
}
if (!labRoot) throw new Error("no lab found");
const lab = JSON.parse(await fs.readFile(path.join(labRoot, "lab.json"), "utf8"));
await fs.mkdir(OUT, { recursive: true });

const task = await taskSpace("phase10-visual-polish-dialogs");
for (const page of await task.pages()) if (!["p1", "p2"].includes(page.label)) await page.close();
const pages = {};
for (const node of lab.nodes) {
  const session = JSON.parse(await fs.readFile(path.join(labRoot, `${node.name}-session.json`), "utf8"));
  const page = node.name === lab.nodes[0].name
    ? task.page("p1")
    : ((await task.pages()).some((item) => item.label === "p2") ? task.page("p2") : await task.newPage());
  const [name, ...rest] = session.cookie.split("=");
  await page.cdp("Network.setCookie", { name, value: rest.join("="), domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" });
  pages[node.name] = { page, origin: session.origin };
}

const report = { schema: "ohmyaihub-phase10-visual-dialogs/v1", at: new Date().toISOString(), lab: labRoot, shots: [], checks: [] };

const audit = (scopeSelector) => {
  const inClosedDetails = (node) => Boolean(node.closest("details:not([open])")) && !node.closest("summary");
  const rendered = (node) => {
    if (node.hidden || inClosedDetails(node)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const scope = document.querySelector(scopeSelector) || document.body;
  const leaves = [...scope.querySelectorAll("*")].filter((node) => rendered(node) && node.children.length === 0 && node.textContent.trim());
  const text = leaves.map((node) => node.textContent).join(" ");
  const tech = ["授信", "EIP-6963", "window.ethereum", "chainId", "priceVersion", "FULL AUTO", "TOFU", "presence"];
  const rawWords = ["ready", "delivering", "approved", "revoked", "unverified", "pending", "failed", "unknown", "enabled", "disabled"];
  return {
    scope: scopeSelector,
    techTerms: tech.filter((term) => text.includes(term)),
    rawStates: rawWords.filter((word) => new RegExp(`\\b${word}\\b`).test(text)),
    chainIdText: leaves.filter((node) => /(^|\s)链\s*\d{2,}/.test(node.textContent)).map((node) => node.textContent.trim().slice(0, 40)),
    text: text.replace(/\s+/g, " ").slice(0, 600),
  };
};

async function setTheme(page, theme) {
  await page.evaluate((value) => localStorage.setItem("aihub-console-theme", value), theme);
  await page.reload();
  await page.waitForSelector("#private-content:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(600);
}
async function viewport(page, width, height) {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
}
async function shoot(page, file, scope = "body", { fullPage = true, expand = false } = {}) {
  await page.waitForTimeout(400);
  if (expand) {
    // A modal's content scrolls inside max-height; for the evidence frame show
    // the whole dialog. The backdrop is viewport-sized, so capture the viewport.
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog[open]");
      if (dialog) { dialog.style.maxHeight = "none"; dialog.style.overflow = "visible"; }
    });
  }
  await page.screenshot({ path: path.join(OUT, file), fullPage });
  report.shots.push(file);
  report.checks.push({ file, ...(await page.evaluate(audit, scope)) });
}
async function fillApproval(page) {
  await page.evaluate(() => {
    const cap = document.querySelector("dialog[open] input[type=number]");
    if (cap) { cap.value = "0.05"; cap.dispatchEvent(new Event("input", { bubbles: true })); }
    // Only the consent boxes, never the model choice: toggling an already
    // selected model invalidates the quote preview on purpose.
    for (const box of document.querySelectorAll("dialog[open] .dialog-content > .workflow-check input[type=checkbox]")) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.evaluate(() => {
    const preview = [...document.querySelectorAll("dialog[open] button")].find((node) => node.textContent === "预览选中报价");
    preview?.click();
  });
  await page.waitForTimeout(1200);
}
async function clickText(page, selector, text) {
  return page.evaluate(({ selector, text }) => {
    const node = [...document.querySelectorAll(selector)].find((item) => item.textContent.trim() === text);
    node?.scrollIntoView({ block: "center" });
    node?.click();
    return Boolean(node);
  }, { selector, text });
}

const provider = pages[lab.nodes[0].name];
const consumer = pages[lab.nodes[1].name];
// Both pages need a real origin before localStorage/theme can be read.
for (const { page, origin } of [provider, consumer]) {
  await page.goto(origin + "/");
  await page.waitForSelector("#private-content:not([hidden])", { timeout: 20000 });
}

// 1. The consumer sends one real zero-file request.
await viewport(consumer.page, 1440, 1000);
await setTheme(consumer.page, "light");
await consumer.page.click("#nav-discovery");
await consumer.page.waitForTimeout(3500);
if (await clickText(consumer.page, "#discovery-panel button", "核对并接受身份")) {
  await consumer.page.waitForTimeout(500);
  await consumer.page.evaluate(() => {
    const box = document.querySelector("dialog[open] input[type=checkbox]");
    box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true }));
    const accept = [...document.querySelectorAll("dialog[open] button")].find((node) => node.textContent === "接受此身份");
    accept?.click();
  });
  await consumer.page.waitForTimeout(4000);
}
await consumer.page.evaluate(() => {
  const request = [...document.querySelectorAll("#discovery-panel button")].find((node) => node.textContent.includes("申请使用"));
  request?.click();
});
await consumer.page.waitForTimeout(700);
await consumer.page.evaluate(() => {
  for (const box of document.querySelectorAll("dialog[open] input[type=checkbox]")) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
  const send = [...document.querySelectorAll("dialog[open] button")].find((node) => node.textContent === "发送使用申请");
  send?.click();
});
await consumer.page.waitForTimeout(5000);

// 2. The provider approval dialog, in three layouts; then approve for real.
for (const [theme, width, height, file] of [
  ["light", 1440, 1500, "provider-light-1440-approval-dialog.png"],
  ["dark", 1440, 1500, "provider-dark-1440-approval-dialog.png"],
  ["light", 390, 2000, "provider-light-390-approval-dialog.png"],
]) {
  await viewport(provider.page, width, height);
  await setTheme(provider.page, theme);
  await provider.page.click("#nav-sharing");
  await provider.page.waitForTimeout(3000);
  await clickText(provider.page, "#sharing-panel button", "核对并批准");
  await provider.page.waitForTimeout(2200);
  await fillApproval(provider.page);
  await provider.page.waitForTimeout(200);
  await shoot(provider.page, file, "dialog[open]", { fullPage: false, expand: true });
}
await viewport(provider.page, 1440, 1000);
await setTheme(provider.page, "light");
await provider.page.click("#nav-sharing");
await provider.page.waitForTimeout(2500);
await clickText(provider.page, "#sharing-panel button", "核对并批准");
await provider.page.waitForTimeout(2000);
await fillApproval(provider.page);
await provider.page.evaluate(() => {
  const approve = [...document.querySelectorAll("dialog[open] button")].find((node) => node.textContent === "确认批准");
  approve?.click();
});
await provider.page.waitForTimeout(10000);

// 3. Browser-wallet connection dialog and the external-wallet area.
for (const [theme, width, height, file] of [
  ["light", 1440, 1000, "consumer-light-1440-connect-wallet-dialog.png"],
  ["dark", 1440, 1000, "consumer-dark-1440-connect-wallet-dialog.png"],
  ["light", 390, 900, "consumer-light-390-connect-wallet-dialog.png"],
]) {
  await viewport(consumer.page, width, height);
  await setTheme(consumer.page, theme);
  await consumer.page.click("#nav-wallet");
  await consumer.page.waitForTimeout(900);
  await clickText(consumer.page, "#wallet-vault-panel button", "连接已有钱包");
  await consumer.page.waitForTimeout(500);
  await shoot(consumer.page, file, "dialog[open]", { fullPage: false });
  await consumer.page.evaluate(() => document.querySelector("dialog[open]")?.close());
}
await viewport(consumer.page, 1440, 1000);
await setTheme(consumer.page, "light");
await consumer.page.click("#nav-wallet");
await consumer.page.waitForTimeout(900);
await consumer.page.evaluate(() => document.querySelector(".wallet-external-root")?.scrollIntoView({ block: "center" }));
await consumer.page.waitForTimeout(300);
await consumer.page.screenshot({ path: path.join(OUT, "consumer-light-1440-external-wallet.png"), fullPage: false });
report.shots.push("consumer-light-1440-external-wallet.png");
report.checks.push({ file: "consumer-light-1440-external-wallet.png", ...(await consumer.page.evaluate(audit, "#wallet-vault-panel")) });

// 4. The real recharge form and its validation error.
await consumer.page.click("#nav-wallet");
await consumer.page.waitForTimeout(500);
await clickText(consumer.page, "#payment-p2p-panel button", "申请充值条件");
await consumer.page.waitForTimeout(500);
await shoot(consumer.page, "consumer-light-1440-recharge-error-dialog.png", "#payment-p2p-panel");

await fs.writeFile(path.join(OUT, "dialogs.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ lab: labRoot, shots: report.shots.length, bad: report.checks.filter((check) => check.techTerms.length || check.rawStates.length || check.chainIdText.length).length }));
