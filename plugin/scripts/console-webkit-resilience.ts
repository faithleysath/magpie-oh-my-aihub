// Maintainer-only actor acceptance against existing isolated Magpie profiles.
// Business operations ONLY use visible GUI clicks/forms. No product CLI, manual
// HTTP, Service calls, evaluation-based mutations, or product state-file access.
import assert from "node:assert/strict";
import { webkit, type Page } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const runtimeFile = process.env.PHASE9_RESILIENCE_RUNTIME ?? "/private/tmp/ohmyaihub-phase9-real-console/runtime.json";
const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
const out = resolve(import.meta.dir, "../../docs/validation/phase9-browser");
const inspect = process.argv.includes("--inspect");
const inspectNative = process.argv.includes("--inspect-native");
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "zh-CN" });
context.setDefaultTimeout(20_000);
const pages = new Map<string, Page>();
const scenarios: unknown[] = [];
const results: Record<string, unknown> = {
  schema: "ohmyaihub.webkit-resilience/v1", at: new Date().toISOString(), playwright: "1.64.1", browser: "WebKit", browserVersion: browser.version(),
  platform: `${process.platform}/${process.arch}`, magpie: runtime.magpieVersion, magpieSource: runtime.magpieSourceSha,
  installedSources: { provider2: { webPort: 29747, source: "8b86115", provenance: "parent installed via actual Magpie GUI" }, consumer: { webPort: 51417, source: "03d9981", provenance: "parent installed via actual Magpie GUI" } },
  boundary: "Visible Magpie GUI and console clicks/forms, private runtime login URL reads, and DOM-only assertions. No CLI business operations, manual HTTP, Service calls, product state edits, key reveal or P1 pairing. Parent services left running.",
  scenarios,
};
const report = (name: string, data: unknown) => console.log(JSON.stringify({ name, data }));
const plugin = (page: Page) => page.frameLocator("iframe");
async function magpie(key: string) {
  const page = await context.newPage(); pages.set(key, page);
  await page.goto(runtime.nodes[key].webLoginUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Oh My AIHub", exact: true }).click();
  await page.locator("iframe").waitFor({ state: "visible" });
  return page;
}
async function pair(key: string) {
  const native = await magpie(key);
  let frame = plugin(native);
  let origin = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    await frame.getByRole("button", { name: "刷新状态", exact: true }).click();
    origin = (await frame.locator("#console-origin").innerText()).trim();
    if (/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin)) break;
    await native.waitForTimeout(1000);
  }
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
  const consolePage = await context.newPage(); pages.set(key + "-console", consolePage);
  await consolePage.goto(origin, { waitUntil: "domcontentloaded" });
  await consolePage.getByRole("button", { name: "配对此浏览器", exact: true }).click();
  await consolePage.locator("#pairing-code").waitFor({ state: "visible" });
  const code = (await consolePage.locator("#pairing-code").innerText()).replace(/\s/g, "");
  assert.match(code, /^\d{8}$/);
  for (let attempt = 0; attempt < 12; attempt++) {
    await frame.getByRole("button", { name: "刷新状态", exact: true }).click();
    if (await frame.locator(".pairing-request").filter({ hasText: code }).count()) break;
    await native.waitForTimeout(1000);
  }
  frame = plugin(native);
  const matching = frame.locator(".pairing-request").filter({ hasText: code });
  await matching.getByRole("checkbox").check();
  await matching.getByRole("button", { name: "批准此浏览器", exact: true }).click();
  await consolePage.locator("#private-content").waitFor({ state: "visible", timeout: 90_000 });
  assert.equal(await consolePage.locator("#connection").innerText(), "本机已连接");
  scenarios.push({ name: `${key} explicit browser pairing`, result: "VERIFIED", codeMatched: true, nativeCheckboxAndApproval: true, privateStateVisibleAfterApproval: true });
  report("paired", key);
  return consolePage;
}
async function screenshot(page: Page, name: string) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, name), fullPage: true });
}
async function waitNotice(page: Page) {
  await page.locator("#notice.good").waitFor({ state: "visible", timeout: 180_000 });
}
function sharingForm(page: Page) { return page.locator("#sharing-panel form").filter({ has: page.getByRole("heading", { name: "对伙伴展示的目录", exact: true }) }); }
async function setDisplayName(page: Page, value: string) {
  await page.locator("#nav-sharing").click();
  const form = sharingForm(page);
  await form.locator("label").filter({ hasText: "展示名称" }).locator("input").fill(value);
  await form.getByRole("button", { name: "保存目录说明", exact: true }).click();
  await waitNotice(page);
}
async function refreshDirectory(page: Page) {
  await page.locator("#nav-discovery").click();
  await page.getByRole("button", { name: "刷新目录", exact: true }).click();
  await waitNotice(page);
}
async function nativeProviderOneTest() {
  const native = pages.get("consumer")!;
  await native.getByRole("button", { name: "供应商", exact: true }).click();
  await native.getByText("Remote magpie", { exact: true }).click();
  const model = native.getByRole("button", { name: "provider-model · provider", exact: true });
  await native.getByRole("button", { name: "测试模型", exact: true }).click();
  await native.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(node => node.textContent?.trim() === "provider-model · provider" && /Answered via|通过 OpenAI.*响应|OpenAI.*(?:429|401)|Failed|failed/.test(node.getAttribute("title") ?? "")), undefined, { timeout: 25_000 });
  const result = await model.getAttribute("title");
  assert.match(result ?? "", /Answered via OpenAI|通过 OpenAI.*响应/);
  await model.screenshot({ path: join(out, "webkit-resilience-native-p1-model.png") });
  scenarios.push({ name: "native Magpie P1 model during P2 sharing pause", result: "VERIFIED", surface: "C Magpie Providers → Remote magpie (not Remote magpie 2) → 测试模型", model: "provider/provider-model", title: result, screenshot: "webkit-resilience-native-p1-model.png", equivalence: "Native UI model test successful via OpenAI protocol; no manual HTTP request" });
  await native.getByRole("button", { name: "取消", exact: true }).click();
}
async function checkConnection(page: Page, port: number) {
  await page.locator("#nav-connections").click();
  const card = page.locator("#connections-panel article").filter({ hasText: `127.0.0.1:${port}` });
  await card.getByRole("button", { name: "检查连接与额度", exact: true }).click();
  await waitNotice(page);
  return card;
}
let provider: Page | null = null;
let consumer: Page | null = null;
let originalDisplay: string | null = null;
let displayChanged = false;
let sharingPaused = false;
try {
  if (inspectNative) {
    const page = await context.newPage();
    await page.goto(runtime.nodes.consumer.webLoginUrl, { waitUntil: "domcontentloaded" });
    await page.getByText("Remote magpie", { exact: true }).click();
    await page.getByRole("button", { name: "测试模型", exact: true }).click();
    await page.waitForTimeout(3000);
    report("native-model-results", await page.locator("button").evaluateAll(nodes => nodes.filter(node => node.textContent?.includes("provider-model")).map(node => ({ text: node.textContent?.trim(), title: node.getAttribute("title"), outer: node.outerHTML.slice(0, 2500) }))));
  } else if (inspect) {
    for (const key of ["provider2", "consumer"]) {
      const page = await magpie(key);
      report(key + "-plugin", await plugin(page).locator("body").innerText());
    }
  } else {
    provider = await pair("provider2");
    consumer = await pair("consumer");
    await provider.locator("#nav-sharing").click();
    originalDisplay = await sharingForm(provider).locator("label").filter({ hasText: "展示名称" }).locator("input").inputValue();
    report("provider-display-before", originalDisplay);
    const payload = '<img src=x onerror="document.body.dataset.xss=1">';
    const dialogs: string[] = [];
    const images: { resource: string; external: boolean }[] = [];
    consumer.on("dialog", async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    consumer.on("request", (request) => { if (request.resourceType() === "image") images.push({ resource: "image", external: new URL(request.url()).origin !== new URL(consumer!.url()).origin }); });
    await setDisplayName(provider, payload); displayChanged = true;
    await refreshDirectory(consumer);
    const malicious = consumer.locator("#discovery-panel article").filter({ has: consumer.getByRole("heading", { name: payload, exact: true }) });
    await malicious.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await malicious.locator("img").count(), 0);
    assert.equal(await consumer.locator("#discovery-panel img").count(), 0);
    assert.equal(await consumer.locator("body").getAttribute("data-xss"), null);
    assert.equal(dialogs.length, 0);
    assert.equal(images.length, 0);
    await screenshot(consumer, "webkit-resilience-literal-catalog.png");
    scenarios.push({ name: "malicious catalogue display name", result: "VERIFIED", payload, literalHeading: true, injectedImageElements: 0, bodyXssMarker: false, javascriptDialogs: 0, imageRequests: 0, screenshot: "webkit-resilience-literal-catalog.png" });
    await setDisplayName(provider, originalDisplay); displayChanged = false;
    await refreshDirectory(consumer);
    await consumer.locator("#discovery-panel").getByRole("heading", { name: originalDisplay, exact: true }).waitFor({ state: "visible" });
    scenarios.push({ name: "restore provider display name", result: "VERIFIED", restored: originalDisplay });
    await provider.locator("#nav-sharing").click();
    await provider.getByRole("button", { name: "暂停共享", exact: true }).click();
    const dialog = provider.getByRole("dialog");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "暂停共享", exact: true }).click();
    await waitNotice(provider); sharingPaused = true;
    const p2 = await checkConnection(consumer, 13426);
    report("provider2-paused-card", await p2.innerText());
    const p1 = await checkConnection(consumer, 13425);
    report("provider1-unaffected-card", await p1.innerText());
    await screenshot(consumer, "webkit-resilience-peer-isolation.png");
    assert.match(await p2.innerText(), /需要处理/);
    assert.match(await p1.innerText(), /已连接/);
    scenarios.push({ name: "provider2 pause isolation", result: "VERIFIED", provider2: await p2.innerText(), provider1: await p1.innerText(), screenshot: "webkit-resilience-peer-isolation.png" });
    await nativeProviderOneTest();
    await provider.locator("#nav-sharing").click();
    await provider.getByRole("button", { name: "开启共享", exact: true }).click();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "开启共享", exact: true }).click();
    await waitNotice(provider); sharingPaused = false;
    const recoveryStart = Date.now();
    let recovered = await checkConnection(consumer, 13426);
    let recoveryChecks = 1;
    while (!(await recovered.innerText()).includes("已连接") && Date.now() - recoveryStart < 70_000) {
      await consumer.waitForTimeout(2000);
      recovered = await checkConnection(consumer, 13426); recoveryChecks++;
    }
    assert.match(await recovered.innerText(), /已连接/, "P2 sharing resumed but native Remote connection did not recover within 70s");
    await recovered.getByRole("button", { name: "读取可用模型", exact: true }).click();
    const modelsDialog = consumer.getByRole("dialog");
    await modelsDialog.getByText("provider2/provider2-model", { exact: true }).waitFor({ state: "visible" });
    scenarios.push({ name: "provider2 sharing resumed and real models recovered", result: "VERIFIED", checks: recoveryChecks, elapsedMs: Date.now() - recoveryStart, model: "provider2/provider2-model" });
    await screenshot(consumer, "webkit-resilience-p2-recovered.png");
    await modelsDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await consumer.reload({ waitUntil: "domcontentloaded" });
    await consumer.locator("#private-content").waitFor({ state: "visible" });
    scenarios.push({ name: "refresh resumes HttpOnly-cookie session", result: "VERIFIED", privateStateVisible: true });
    await consumer.getByRole("button", { name: "退出会话", exact: true }).click();
    await consumer.getByRole("heading", { name: "已退出本机会话", exact: true }).waitFor({ state: "visible" });
    await consumer.reload({ waitUntil: "domcontentloaded" });
    await consumer.getByRole("button", { name: "配对此浏览器", exact: true }).waitFor({ state: "visible" });
    assert.equal(await consumer.locator("#private-content").isVisible(), false);
    scenarios.push({ name: "logout followed by reload denies private state", result: "VERIFIED", explicitPairingRequired: true, privateStateHidden: true });
    results.result = "VERIFIED";
  }
} catch (error) {
  results.result = "BLOCKED";
  results.failure = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[URL]") : "unknown browser failure";
  if (consumer) await screenshot(consumer, "webkit-resilience-blocked.png").catch(() => {});
  report("blocked", results.failure);
} finally {
  // Restore only through ordinary UI controls. Never alter profile files.
  if (displayChanged && provider && originalDisplay !== null) {
    try { await setDisplayName(provider, originalDisplay); scenarios.push({ name: "display restored after stop", result: "VERIFIED" }); }
    catch { scenarios.push({ name: "display restore", result: "UNKNOWN", operatorFollowupRequired: true }); }
  }
  if (sharingPaused && provider) {
    try {
      await provider.locator("#nav-sharing").click(); await provider.getByRole("button", { name: "开启共享", exact: true }).click();
      const dialog = provider.getByRole("dialog"); await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "开启共享", exact: true }).click(); await waitNotice(provider);
      scenarios.push({ name: "sharing restored after stop", result: "VERIFIED" });
    } catch { scenarios.push({ name: "sharing restore", result: "UNKNOWN", operatorFollowupRequired: true }); }
  }
  if (!inspect && !inspectNative) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "webkit-resilience.json"), JSON.stringify(results, null, 2) + "\n"); }
  await browser.close();
  if (results.result === "BLOCKED") process.exitCode = 1;
}
