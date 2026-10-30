// Maintainer actor acceptance. Business operations ONLY use visible Magpie and
// console controls. No fetch/API/Service calls, CLI business commands or state edits.
import { webkit, type Page, type BrowserContext } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const runtimeFile = process.env.PHASE9_RESILIENCE_RUNTIME ?? "/private/tmp/ohmyaihub-phase9-real-console/runtime.json";
const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
const out = resolve(import.meta.dir, "../../docs/validation/phase9-browser");
const inspect = process.argv.includes("--inspect");
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "zh-CN" });
const pages = new Map<string, Page>();
const results: Record<string, unknown> = { schema: "ohmyaihub.webkit-resilience/v1", at: new Date().toISOString(), playwright: "1.64.1", browser: "WebKit", browserVersion: browser.version(), platform: `${process.platform}/${process.arch}`, magpie: runtime.magpieVersion, magpieSource: runtime.magpieSourceSha, boundary: "Visible Magpie GUI, console clicks/forms and DOM assertions only; no CLI business operations, manual HTTP, Service calls, product-state edits or P1 pairing.", scenarios: [] };
const report = (name: string, data: unknown) => { console.log(JSON.stringify({ name, data })); };
const cleanBody = async (page: Page) => (await page.locator("body").innerText()).replace(/https?:\/\/\S+/g, "[URL]").replace(/(?:sk-[\w.-]+|[a-f0-9]{64,})/g, "[identifier]");
try {
  for (const key of ["provider2", "consumer"]) {
    const page = await context.newPage(); pages.set(key, page);
    await page.goto(runtime.nodes[key].webLoginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    report(`${key}-initial`, (await cleanBody(page)).slice(0, 12000));
    report(`${key}-controls`, await page.locator("a,button").evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, text: (node.textContent ?? "").trim(), href: node instanceof HTMLAnchorElement ? node.getAttribute("href")?.replace(/\?.*$/, "") : null })).filter(node => node.text)));
  }
} finally {
  await browser.close();
}
