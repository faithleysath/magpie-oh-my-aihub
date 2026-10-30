// Maintainer browser acceptance against the real isolated Magpie fixture.
// Every authorization and business write below is a visible GUI action.
import { webkit } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const runtimePath = process.argv[2];
const output = resolve(process.argv[3] ?? "../docs/validation/phase9-browser");
if (!runtimePath || !/^(\/private)?\/tmp\//.test(runtimePath)) throw new Error("isolated runtime path required");
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
const node = runtime.nodes.provider;
const consolePort = JSON.parse(readFileSync(join(node.data, "oh-my-aihub/console-port.json"), "utf8")).port;
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const steps: { name: string; ok: boolean }[] = [];
const record = (name: string) => { steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
mkdirSync(output, { recursive: true });
try {
  const magpie = await context.newPage();
  await magpie.goto(node.webLoginUrl);
  await magpie.getByRole("button", { name: "Oh My AIHub", exact: true }).click();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${consolePort}/`);
  await page.getByRole("button", { name: "配对此浏览器", exact: true }).click();
  await page.locator("#pairing-code").filter({ hasText: /\d{4}\s?\d{4}/ }).waitFor();
  const code = (await page.locator("#pairing-code").innerText()).replace(/\s/g, "");
  if (!/^\d{8}$/.test(code)) throw new Error("no pairing code");
  record("anonymous browser requires pairing approval");
  const frame = magpie.frameLocator("iframe");
  let matched = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await frame.getByRole("button", { name: "刷新状态", exact: true }).click();
    try { await frame.locator(".pairing-code").filter({ hasText: code }).waitFor({ timeout: 1500 }); matched = true; break; }
    catch { /* Read-only page snapshot may precede the request; refresh again. */ }
  }
  if (!matched) throw new Error("matching request absent in Magpie");
  const row = frame.locator(".pairing-request").filter({ hasText: code });
  await row.getByRole("checkbox").check();
  await row.getByRole("button", { name: "批准此浏览器", exact: true }).click();
  await page.getByText("本机已连接", { exact: true }).waitFor({ timeout: 30000 });
  record("Magpie code confirmation and host restart establish new browser session");
  await page.getByRole("button", { name: "网络与设置", exact: false }).click();
  const consume = page.locator("#consuming");
  if (!(await consume.isChecked())) await consume.check();
  else await consume.uncheck();
  await page.getByRole("button", { name: "保存并连接网络", exact: false }).click();
  await page.getByText("配置已保存。请查看安全状态，确认网络是否就绪。", { exact: true }).waitFor({ timeout: 60000 });
  record("visible settings form invokes production configure with real EasyTier");
  await page.reload();
  await page.getByText("本机已连接", { exact: true }).waitFor({ timeout: 15000 });
  record("refresh resumes current host cookie session");
  await page.getByRole("button", { name: "总览", exact: false }).click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(output, "webkit-stage1-provider.png"), fullPage: true });
  await page.getByRole("button", { name: "切换深色模式", exact: true }).click();
  await page.screenshot({ path: join(output, "webkit-stage1-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "webkit-stage1-mobile.png"), fullPage: true });
  record("dark theme and mobile layout rendered");
  await page.getByRole("button", { name: "退出会话", exact: true }).click();
  await page.getByText("已退出本机会话", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "配对此浏览器", exact: true }).waitFor();
  record("logout persists refusal across refresh");
  writeFileSync(join(output, "webkit-stage1.json"), JSON.stringify({ engine: "WebKit", version: browser.version(), platform: process.platform, arch: process.arch, steps, pass: true }, null, 2));
} catch (error) {
  writeFileSync(join(output, "webkit-stage1-failure.json"), JSON.stringify({ engine: "WebKit", version: browser.version(), steps, pass: false, error: String(error).replace(/https?:\/\/[^\s]+/g, "<url>").slice(0, 500) }, null, 2));
  throw new Error("WebKit stage1 failed; see sanitized failure artifact");
} finally { await context.close(); await browser.close(); }
