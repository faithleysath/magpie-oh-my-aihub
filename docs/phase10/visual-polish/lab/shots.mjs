/**
 * Phase 10 visual-polish final matrix (ego-lite).
 *
 *   ego-browser nodejs < docs/phase10/visual-polish/lab/shots.mjs
 *
 * Reads the newest /tmp/ohmyaihub-visual-* lab (lab.json + <node>-session.json),
 * signs each console in with its paired cookie, and writes the real matrix to
 * docs/phase10/visual-polish/evidence/final. It also records objective page
 * checks (overflow, nested stickers, visible middle dots/arrows, font sizes,
 * mono prose, technical terms outside details, reduced motion, focus ring).
 * Cookies are never printed or screenshotted.
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

const task = await taskSpace("phase10-visual-polish-final");
// Keep the matrix on two pages; a previous run may have left extras.
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

const report = { schema: "ohmyaihub-phase10-visual-matrix/v1", at: new Date().toISOString(), lab: labRoot, magpie: lab.magpie, network: lab.network, shots: [], checks: [] };
const audit = () => {
  const visible = (node) => {
    // Chrome keeps a layout box for closed <details> content; it is not shown.
    if (node.closest("details:not([open])")) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const text = document.body.innerText;
  // A button/logo is a control, not a container: only bordered containers
  // count when checking for stickers inside stickers.
  const shadowed = [...document.querySelectorAll("body *")].filter((node) => {
    if (!visible(node) || node.closest("button, a")) return false;
    const style = getComputedStyle(node);
    return parseFloat(style.borderTopWidth) >= 2 && style.boxShadow !== "none";
  });
  let maxStickerDepth = 0;
  for (const node of shadowed) {
    let depth = 0;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) if (shadowed.includes(parent)) depth++;
    maxStickerDepth = Math.max(maxStickerDepth, depth + 1);
  }
  const fontSizes = [...new Set([...document.querySelectorAll("body *")].filter((node) => visible(node) && node.textContent.trim()).map((node) => getComputedStyle(node).fontSize))].sort();
  const mono = [...document.querySelectorAll("body *")].filter((node) => visible(node) && /monospace/.test(getComputedStyle(node).fontFamily) && node.children.length === 0 && node.textContent.trim());
  const monoProse = mono.filter((node) => /[\u4e00-\u9fff]/.test(node.textContent)).map((node) => node.textContent.trim().slice(0, 40));
  // A summary is visible even when its details is closed; the body is not.
  const inClosedDetails = (node) => Boolean(node.closest("details:not([open])")) && !node.closest("summary");
  const rendered = (node) => {
    if (node.hidden || inClosedDetails(node)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const ordinary = [...document.querySelectorAll("body *")].filter((node) => rendered(node) && node.children.length === 0 && node.textContent.trim());
  const tech = ["EIP-6963", "TOFU", "presence", "priceVersion", "chainId", "FULL AUTO", "授信", "不可授信", "window.ethereum"];
  const techTerms = tech.filter((term) => ordinary.some((node) => node.textContent.includes(term)));
  // Raw protocol words that must be translated before they reach a normal row.
  const rawWords = ["ready", "delivering", "approved", "revoked", "unverified", "pending", "failed", "unknown", "enabled", "disabled"];
  const rawStates = rawWords.filter((word) => ordinary.some((node) => new RegExp(`\\b${word}\\b`).test(node.textContent)));
  // A chain id in an ordinary row is the same defect as the word "chainId".
  const chainIdText = ordinary.filter((node) => /(^|\s)链\s*\d{2,}/.test(node.textContent)).map((node) => node.textContent.trim().slice(0, 40));
  const wide = [...document.querySelectorAll("body *")].filter((node) => visible(node) && node.getBoundingClientRect().right > window.innerWidth + 1).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).split(" ")[0]}`).slice(0, 8);
  return {
    middleDots: (text.match(/·/g) || []).length,
    arrows: (text.match(/[→←↑↓]/g) || []).length,
    statusTexts: [...document.querySelectorAll(".status-text")].filter(visible).length,
    pills: document.querySelectorAll(".pill").length,
    maxStickerDepth,
    fontSizes,
    monoProse,
    techTerms,
    rawStates,
    chainIdText,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    wide,
    pageHeight: document.documentElement.scrollHeight,
  };
};

async function setTheme(page, theme) {
  await page.evaluate((value) => localStorage.setItem("aihub-console-theme", value), theme);
  await page.reload();
  await page.waitForSelector("#private-content:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(700);
}
async function viewport(page, width, height) {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
}
async function shoot(page, file) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, file), fullPage: true });
  report.shots.push(file);
  report.checks.push({ file, ...(await page.evaluate(audit)) });
}

const NAV = [["home", "#nav-home"], ["discovery", "#nav-discovery"], ["sharing", "#nav-sharing"], ["wallet", "#nav-wallet"], ["network", "#nav-network"]];
for (const node of lab.nodes) {
  const { page, origin } = pages[node.name];
  await page.goto(origin + "/");
  await page.waitForSelector("#private-content:not([hidden])", { timeout: 20000 });
  for (const [theme, width, height] of [["light", 1440, 1000], ["dark", 1440, 1000], ["light", 390, 844], ["dark", 390, 844]]) {
    await viewport(page, width, height);
    await setTheme(page, theme);
    for (const [name, nav] of NAV) {
      await page.click(nav);
      await page.waitForTimeout(450);
      await shoot(page, `${node.name}-${theme}-${width}-${name}.png`);
    }
  }
  // The consumer's connections tab and both recharge panels at desktop/light.
  await viewport(page, 1440, 1000);
  await setTheme(page, "light");
  await page.click("#nav-discovery");
  await page.waitForTimeout(400);
  await page.click("#tab-connections");
  await page.waitForTimeout(400);
  await shoot(page, `${node.name}-light-1440-connections.png`);
  await page.click("#nav-wallet");
  await page.waitForTimeout(400);
  await shoot(page, `${node.name}-light-1440-wallet-full.png`);
  const error = await page.evaluate(() => {
    const button = [...document.querySelectorAll("#payment-p2p-panel button")].find((node) => node.textContent === "申请充值条件");
    button?.click();
    return Boolean(button);
  });
  if (error) {
    await page.waitForTimeout(500);
    await shoot(page, `${node.name}-light-1440-recharge-error.png`);
  }
}

// Keyboard focus and reduced motion on the provider console.
{
  const { page } = pages[lab.nodes[0].name];
  await viewport(page, 1440, 1000);
  await setTheme(page, "light");
  await page.click("#nav-network");
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById("network-name")?.focus());
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const node = document.activeElement;
    const style = node ? getComputedStyle(node) : null;
    return { tag: node?.tagName, outline: style?.outlineStyle, width: style?.outlineWidth, offset: style?.outlineOffset };
  });
  await page.screenshot({ path: path.join(OUT, "provider-light-1440-focus.png"), fullPage: false });
  report.shots.push("provider-light-1440-focus.png");
  await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const motion = await page.evaluate(() => {
    const button = document.querySelector(".button");
    return button ? getComputedStyle(button).transitionDuration : null;
  });
  report.checks.push({ file: "focus-and-motion", focus, reducedMotionTransition: motion });
  await page.cdp("Emulation.setEmulatedMedia", { features: [] });
}

// A real ended-session state, last, so it cannot disturb the matrix.
{
  const { page } = pages[lab.nodes[1].name];
  await viewport(page, 1440, 1000);
  await setTheme(page, "light");
  await page.click("#nav-network");
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById("logout")?.click());
  await page.waitForTimeout(1200);
  await shoot(page, "consumer-light-1440-session-ended.png");
}

await fs.writeFile(path.join(OUT, "matrix.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ lab: labRoot, shots: report.shots.length, checks: report.checks.length }));
