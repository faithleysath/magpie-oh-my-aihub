// Maintainer acceptance: actual visible UI only. No API/fetch/Service injection.
// Usage: bun scripts/console-webkit-wallet.ts <private Magpie runtime.json> <private fixture runtime.json> [output directory]
import { webkit, type Locator, type Page } from "playwright";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function privateRuntime(path: string | undefined): Record<string, any> {
  if (!path || !/^(\/private)?\/tmp\//.test(path)) throw new Error("isolated private runtime required");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0) throw new Error("runtime must be private0600 regular file");
  return JSON.parse(readFileSync(path, "utf8"));
}
const runtime = privateRuntime(process.argv[2]);
const fixture = privateRuntime(process.argv[3]);
const output = resolve(process.argv[4] ?? "../docs/validation/phase9-browser");
const files = join(runtime.root, "webkit-wallet-" + Date.now());
mkdirSync(files, { recursive: true, mode: 0o700 }); chmodSync(files, 0o700);
mkdirSync(output, { recursive: true });
const provider = runtime.nodes.provider, consumer = runtime.nodes.consumer;
if (!provider?.webLoginUrl || !consumer?.webLoginUrl || fixture.schema !== "ohmyaihub.private-wallet-fixture/v1" || !/^http:\/\/127\.0\.0\.1:\d+\/#ticket=[0-9a-f]{64}$/.test(fixture.launchUrl)) throw new Error("prepared real lab and fresh private fixture launch required");
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const steps: { name: string; ok: boolean }[] = [];
let phase = "initialization";
const evidence: Record<string, unknown> = { scope: "UI file exchange + LOCAL SYNTHETIC CHAIN + real production ledger/native cap + native Remote Magpie Test models; no public payment", cliBusinessOperations: false, manualAdminHttp: false, publicPayment: false };
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function pass(name: string) { steps.push({ name, ok: true }); console.log("PASS " + name); }
async function idle(page: Page) {
  await page.locator("#notice").filter({ hasText: "操作已返回，请以证据状态、核验时间和原生额度回读为准。" }).waitFor({ timeout: 120_000 });
}
async function closeDialog(page: Page) { await page.locator("dialog[open]").getByRole("button", { name: "关闭", exact: true }).click(); }
async function download(page: Page, button: Locator, name: string) {
  const waiting = page.waitForEvent("download"); await button.click();
  const saved = join(files, name); await (await waiting).saveAs(saved); chmodSync(saved, 0o600); return saved;
}
async function native(page: Page, url: string) {
  await page.goto(url);
  const news = page.getByRole("dialog", { name: /What's new/ });
  if (await news.isVisible()) await news.getByRole("button", { name: "Close", exact: true }).click();
}
async function pairedConsole(magpie: Page) {
  await magpie.getByRole("button", { name: "Oh My AIHub", exact: true }).click();
  const frame = magpie.frameLocator("iframe");
  await frame.locator("#console-origin").filter({ hasText: /^http:\/\/127\.0\.0\.1:/ }).waitFor({ timeout: 30_000 });
  const origin = (await frame.locator("#console-origin").innerText()).trim();
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), "local console origin absent");
  const page = await context.newPage(); await page.goto(origin + "/");
  await page.getByRole("button", { name: "配对此浏览器", exact: true }).click();
  await page.locator("#pairing-code").filter({ hasText: /\d{4}\s?\d{4}/ }).waitFor();
  const code = (await page.locator("#pairing-code").innerText()).replace(/\s/g, "");
  check(/^\d{8}$/.test(code), "pairing code absent");
  let found = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await frame.getByRole("button", { name: "刷新状态", exact: true }).click();
    try { await frame.locator(".pairing-code").filter({ hasText: code }).waitFor({ timeout: 1500 }); found = true; break; } catch { /* Read-only native snapshot refresh only. */ }
  }
  check(found, "native pairing request absent");
  const row = frame.locator(".pairing-request").filter({ hasText: code });
  await row.getByRole("checkbox").check();
  await row.getByRole("button", { name: "批准此浏览器", exact: true }).click();
  await page.getByText("本机已连接", { exact: true }).waitFor({ timeout: 45_000 });
  return page;
}
async function account(page: Page, id: string) {
  await page.locator("#nav-accounting").click();
  await page.getByLabel("伙伴账目", { exact: true }).selectOption(id);
  await page.getByRole("button", { name: "核验此伙伴账目与额度", exact: true }).click(); await idle(page);
  const grid = page.locator("#accounting-panel .wallet-account-grid");
  const totalText = await grid.locator(":scope > div").filter({ has: page.locator("p", { hasText: /^累计入账$/ }) }).locator("strong").innerText();
  const details = page.locator("#accounting-panel details").filter({ has: page.locator("summary", { hasText: /^原生额度、模型与价格窗口$/ }) });
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
  const capText = await details.locator(":scope > div").filter({ has: page.locator("strong", { hasText: /^最近核验额度上限$/ }) }).locator("span").innerText();
  const money = (text: string) => { const found = /\$([0-9]+(?:\.[0-9]+)?)/.exec(text); check(found, "missing verified UI financial value"); return Number(found[1]); };
  return { cumulativeCreditUsd: money(totalText), capUsd: money(capText) };
}
async function wallet(page: Page) { await page.locator("#nav-wallet").click(); }
async function scan97(page: Page) {
  const card = page.locator("#wallet-panel .wallet-network-card").filter({ hasText: "chainId 97" });
  await card.getByRole("button", { name: "扫描此网络", exact: true }).click();
  const dialog = page.locator("dialog[open]"); await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "扫描此网络", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 120_000 }); await idle(page);
}
try {
  phase = "provider native pairing";
  const pm = await context.newPage(); await native(pm, provider.webLoginUrl);
  const p = await pairedConsole(pm);
  pass("provider browser authorized by explicit matching code in actual Magpie UI");
  phase = "fixture private session";
  const f = await context.newPage(); await f.goto(fixture.launchUrl);
  await f.locator("#main").waitFor({ state: "visible", timeout: 20_000 });
  await f.locator("#generate").click();
  await f.locator("#payer").filter({ hasText: /^0x[0-9a-fA-F]{40}$/ }).waitFor();
  const cm = await context.newPage(); await native(cm, consumer.webLoginUrl);
  // The actor already exchanged this public request during the sharing journey.
  // Read no product state/key files; bind this run to that intended pair.
  const connectionRequest = JSON.parse(readFileSync(join(runtime.root, "connection-request.json"), "utf8"));
  const consumerId = connectionRequest.consumer?.nodeId;
  const remoteProviderId = "peer-" + String(connectionRequest.provider?.nodeId ?? "");
  check(typeof consumerId === "string" && /^[a-z0-9-]+$/.test(consumerId) && /^peer-[a-z0-9-]+$/.test(remoteProviderId), "sharing request identity required");
  phase = "baseline accounting";
  const before = await account(p, consumerId); evidence.before = before;
  pass("baseline cumulative credit and native cap read from explicit accounting refresh");
  phase = "explicit BSC intent preview and creation";
  await wallet(p); await p.getByRole("button", { name: "创建测试网入账申请", exact: true }).click();
  let dialog = p.locator("dialog[open]");
  await dialog.getByLabel("本机已授权伙伴", { exact: true }).selectOption(consumerId);
  await dialog.getByLabel("测试网络", { exact: true }).selectOption("97");
  const assetOption = dialog.getByLabel("测试代币", { exact: true }).locator("option").filter({ hasText: /^tFIX6 ·/ });
  check(await assetOption.count() === 1, "exact BSC fixture asset selection required");
  await dialog.getByLabel("测试代币", { exact: true }).selectOption((await assetOption.getAttribute("value"))!);
  await dialog.getByLabel("准确 token 数量（十进制）", { exact: true }).fill("0.5");
  await dialog.getByRole("button", { name: "预览精确申请内容", exact: true }).click();
  await dialog.getByRole("heading", { name: "核对并创建入账申请", exact: true }).waitFor();
  check((await dialog.innerText()).includes("500000"), "preview raw6decimal amount mismatch");
  await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "确认创建一次申请", exact: true }).click();
  await dialog.getByRole("button", { name: "下载入账申请文件", exact: true }).waitFor({ timeout: 45_000 });
  const depositFile = await download(p, dialog.getByRole("button", { name: "下载入账申请文件", exact: true }), "deposit-request.json");
  // Read only an actor-downloaded public request to bind UI assertions to this invoice.
  const deposit = JSON.parse(readFileSync(depositFile, "utf8"));
  check(deposit.schema === "ohmyaihub.deposit-request/v1" && deposit.consumerId === consumerId && deposit.chainId === 97 && deposit.amount.raw === "500000", "downloaded intent differs from visible selection");
  await closeDialog(p); pass("explicit consumer97tFIX6 amount0.5 preview consent and production request download");
  phase = "external wallet review and signature download";
  await f.locator("#deposit-file").setInputFiles(depositFile);
  await f.locator("#deposit-review").filter({ hasText: deposit.digest }).waitFor();
  await f.locator("#sign-consent").check();
  const signatureFile = await download(f, f.locator("#sign"), "signature.json");
  await f.locator("#deposit-review").filter({ hasText: "签名文件已下载" }).waitFor();
  pass("external fixture wallet visibly reviews exact EIP712 document and signs only after consent");
  phase = "production signature import";
  let row = p.locator("#wallet-panel article.workflow-row").filter({ hasText: deposit.invoiceId });
  await row.getByRole("button", { name: "导入付款方签名", exact: true }).click();
  dialog = p.locator("dialog[open]"); await dialog.locator('input[type="file"]').setInputFiles(signatureFile);
  await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "核验签名并读取转账指引", exact: true }).click();
  await dialog.getByRole("button", { name: "下载准确转账指引", exact: true }).waitFor({ timeout: 45_000 });
  const instructionsFile = await download(p, dialog.getByRole("button", { name: "下载准确转账指引", exact: true }), "transfer-instructions.json");
  await closeDialog(p);
  pass("production signature verification yields exact transfer-instructions file");
  phase = "synthetic event before finality";
  await f.locator("#transfer-file").setInputFiles(instructionsFile);
  await f.locator("#transfer-review").filter({ hasText: deposit.invoiceId }).waitFor();
  await f.locator("#event-consent").check(); await f.locator("#event").click();
  await f.locator("#event-result").filter({ hasText: /txHash/ }).waitFor();
  const event = JSON.parse(await f.locator("#event-result").innerText());
  await scan97(p);
  await p.getByRole("button", { name: "刷新链与入账证据", exact: true }).click(); await idle(p);
  row = p.locator("#wallet-panel article.workflow-row").filter({ hasText: deposit.invoiceId });
  await row.getByText("等待网络确认", { exact: true }).waitFor({ timeout: 30_000 });
  const unfinalized = await account(p, consumerId);
  check(Math.abs(unfinalized.cumulativeCreditUsd - before.cumulativeCreditUsd) < 0.00001 && Math.abs(unfinalized.capUsd - before.capUsd) < 0.00001, "pre-finality changed credit or native cap");
  evidence.preFinality = { cumulativeCreditUsd: unfinalized.cumulativeCreditUsd, capUsd: unfinalized.capUsd, eventBlock: event.block };
  pass("synthetic event observed through production watcher while prefinality ledger and cap unchanged");
  phase = "15confirmations and production credit";
  await f.locator("#chain").selectOption("97"); await f.locator("#blocks").fill("15");
  const priorState = await f.locator("#state").innerText(); await f.locator("#mine").click();
  await f.waitForFunction((old) => document.getElementById("state")?.textContent !== old, priorState);
  await wallet(p); await scan97(p);
  let after = await account(p, consumerId);
  check(Math.abs(after.cumulativeCreditUsd - before.cumulativeCreditUsd - 0.5) < 0.00001 && Math.abs(after.capUsd - before.capUsd - 0.5) < 0.00011, "finalized credit/native cap did not increase by0.5");
  evidence.after = after;
  await wallet(p); await p.getByRole("button", { name: "刷新链与入账证据", exact: true }).click(); await idle(p);
  row = p.locator("#wallet-panel article.workflow-row").filter({ hasText: deposit.invoiceId });
  await row.getByText("已记录入账证据", { exact: true }).waitFor();
  const timeline = await row.locator(".wallet-timeline").innerText();
  check(/账本应用[\s\S]*已验证/.test(timeline) && /原生额度回读[\s\S]*已验证/.test(timeline), "production ledger and native key evidence not both verified");
  check(await row.locator(".wallet-timeline .timeline-done").filter({ hasText: "账本应用" }).count() === 1 && await row.locator(".wallet-timeline .timeline-done").filter({ hasText: "原生额度回读" }).count() === 1, "exact ledger/key steps must be done");
  pass("production15confirm policy credits0.5 and verifies ledger plus native Magpie cap");
  phase = "duplicate event and scan";
  await f.locator("#event-replay").click();
  await f.locator("#notice").filter({ hasText: "同一操作编号返回同一事件" }).waitFor();
  const replay = JSON.parse(await f.locator("#event-result").innerText());
  check(replay.txHash === event.txHash && replay.block === event.block, "event replay generated another event");
  await scan97(p); after = await account(p, consumerId);
  check(Math.abs(after.cumulativeCreditUsd - (before.cumulativeCreditUsd + 0.5)) < 0.00001, "duplicate scan changed cumulative credit");
  evidence.duplicateCreditUnchanged = true;
  pass("same fixture operation and repeated production scan do not duplicate credit");
  phase = "native consumer Remote Magpie model test";
  await cm.getByRole("button", { name: /^(Providers|模型服务|供应商)$/ }).click();
  await cm.locator(`#providers .provider[data-id="${remoteProviderId}"]`).click();
  const test = cm.getByRole("button", { name: /^(Test models|测试模型)$/ });
  await test.click();
  await cm.locator(".mchips .tdot.ok").waitFor({ timeout: 60_000 });
  check(await cm.locator(".mchips .tdot.bad").count() === 0, "native model test returned failure");
  evidence.nativeModelTest = { successfulChip: true, boundary: "native provider TestModels via configured Remote Magpie; mock upstream; not a separate consumer-gateway call" };
  pass("consumer native Magpie Test models succeeds through actual configured Remote provider");
  phase = "complete";
  writeFileSync(join(output, "webkit-wallet.json"), JSON.stringify({ at: new Date().toISOString(), engine: "WebKit", version: browser.version(), platform: process.platform, arch: process.arch, ...evidence, steps, pass: true }, null, 2));
} catch (error) {
  // Raw Playwright errors may contain URLs, secrets, imported documents or DOM.
  // Keep only the fixed phase and generic error category in shareable evidence.
  writeFileSync(join(output, "webkit-wallet-failure.json"), JSON.stringify({ at: new Date().toISOString(), engine: "WebKit", version: browser.version(), phase, errorKind: error instanceof Error ? error.name : "UnknownError", steps, pass: false }, null, 2));
  throw new Error("WebKit wallet journey failed at " + phase + "; inspect sanitized evidence and private UI");
} finally { await context.close(); await browser.close(); }
