/**
 * Dev-fixture capture of the payment preview dialog.
 *
 *   bun plugin/scripts/console-preview.ts --scenario payment --port 61395 &
 *   ego-browser nodejs < docs/phase10/visual-polish/lab/fixture-payment.mjs
 *
 * The on-chain payment lab was not re-run in this frontend-only round, so the
 * preview *dialog* is rendered by the shipped console against the dev fixture
 * (same app.js/style.css) and labelled as a fixture. The real recharge form and
 * its validation error are in the real two-node matrix.
 */
const fs = await import("node:fs/promises");
const path = await import("node:path");
const OUT = "/Users/laysath/.paseo/worktrees/1z728cdk/phase10-visual-polish/docs/phase10/visual-polish/evidence/final";
const task = await taskSpace("phase10-visual-polish-fixture");
const page = task.page("p1");
await page.goto("http://127.0.0.1:61395/");
await page.waitForSelector("#private-content:not([hidden])", { timeout: 20000 });
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await page.evaluate(() => localStorage.setItem("aihub-console-theme", "light"));
await page.reload();
await page.waitForSelector("#private-content:not([hidden])");
await page.click("#nav-wallet");
await page.waitForTimeout(900);
const clicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll("#payment-p2p-panel button")].find((node) => node.textContent === "预览并付款");
  button?.click();
  return Boolean(button);
});
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector(".wallet-payment-preview")?.scrollIntoView({ block: "center" }));
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, "fixture-payment-preview.png"), fullPage: false });
const audit = await page.evaluate(() => {
  const inClosed = (node) => Boolean(node.closest("details:not([open])")) && !node.closest("summary");
  const rendered = (node) => {
    if (node.hidden || inClosed(node)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const scope = document.querySelector("#payment-p2p-panel");
  const leaves = [...scope.querySelectorAll("*")].filter((node) => rendered(node) && node.children.length === 0 && node.textContent.trim());
  const text = leaves.map((node) => node.textContent).join(" ");
  const tech = ["授信", "EIP-6963", "window.ethereum", "chainId", "priceVersion", "FULL AUTO", "TOFU", "presence"];
  const raw = ["ready", "delivering", "approved", "revoked", "unverified", "pending", "failed", "unknown", "enabled", "disabled"];
  return {
    schema: "ohmyaihub-phase10-visual-fixture-payment/v1",
    at: new Date().toISOString(),
    source: "dev fixture (plugin/scripts/console-preview.ts --scenario payment), shipped console assets",
    screenshot: "fixture-payment-preview.png",
    techTerms: tech.filter((term) => text.includes(term)),
    rawStates: raw.filter((word) => new RegExp(`\\b${word}\\b`).test(text)),
    chainIdText: leaves.filter((node) => /(^|\s)链\s*\d{2,}/.test(node.textContent)).map((node) => node.textContent.trim().slice(0, 40)),
    hasTechnicalDetails: text.includes("技术详情"),
    text: text.replace(/\s+/g, " ").slice(0, 600),
  };
});
audit.clicked = clicked;
await fs.writeFile(path.join(OUT, "fixture-payment.json"), JSON.stringify(audit, null, 2) + "\n");
console.log(JSON.stringify({ clicked, bad: audit.techTerms.length + audit.rawStates.length + audit.chainIdText.length, hasTechnicalDetails: audit.hasTechnicalDetails }));
