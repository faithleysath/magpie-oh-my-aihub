/**
 * Development-only screenshot script for the console preview.
 *
 * It drives ego-lite (ego-browser) against plugin/scripts/console-preview.ts and
 * writes a fixed matrix: five pages × light/dark × 1440/390 plus the first-run
 * form, the sharing confirmation and a focus sample. Nothing here talks to a
 * real Magpie or a real network.
 *
 *   bun run plugin/scripts/console-preview.ts --scenario configured --port 61390 &
 *   bun run plugin/scripts/console-preview.ts --scenario first-run  --port 61391 &
 *   ego-browser nodejs < plugin/scripts/console-shots.mjs
 */
const CONFIGURED = "http://127.0.0.1:61390/";
const FIRST_RUN = "http://127.0.0.1:61391/";
const OUT = "/tmp/oma-ui-shots";
const PAGES = [["home", "#nav-home"], ["discovery", "#nav-discovery"], ["sharing", "#nav-sharing"], ["wallet", "#nav-wallet"], ["network", "#nav-network"]];

const space = await taskSpace("phase10-a-ui-shots");
const page = space.page("p1");
const shots = [];
async function shoot(name) { shots.push(await page.screenshot({ path: `${OUT}/${name}.png` })); }
async function viewport(width, height) {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
}
async function theme(value) {
  await page.evaluate((v) => localStorage.setItem("aihub-console-theme", v), value);
  await page.reload();
  await page.waitForSelector("#private-content:not([hidden])");
  await page.waitForTimeout(400);
}

await viewport(1440, 900);
await page.goto(CONFIGURED);
await page.waitForSelector("#private-content:not([hidden])");
await theme("light");
for (const [name, nav] of PAGES) { await page.click(nav); await page.waitForTimeout(300); await shoot(`${name}-1440-light`); }

await page.click("#nav-sharing");
await page.evaluate(() => [...document.querySelectorAll("#sharing-panel button")].find((button) => button.textContent === "分享这些模型").click());
await page.waitForTimeout(250);
await shoot("sharing-dialog-1440-light");
await page.evaluate(() => document.querySelector("dialog.workflow-dialog")?.close());

await theme("dark");
for (const [name, nav] of PAGES) { await page.click(nav); await page.waitForTimeout(250); await shoot(`${name}-1440-dark`); }

await theme("light");
await viewport(390, 844);
await page.reload(); await page.waitForSelector("#private-content:not([hidden])"); await page.waitForTimeout(400);
for (const [name, nav] of PAGES) { await page.click(nav); await page.waitForTimeout(250); await shoot(`${name}-390-light`); }

await viewport(1440, 900);
await page.goto(FIRST_RUN); await page.waitForSelector("#private-content:not([hidden])"); await page.waitForTimeout(500);
await shoot("first-run-1440-light");
await page.click("#network-name");
await page.keyboard.press("Tab");
await shoot("focus-1440-light");
await viewport(390, 844); await page.reload(); await page.waitForSelector("#private-content:not([hidden])"); await page.waitForTimeout(400);
await shoot("first-run-390-light");

console.log(JSON.stringify({ shots, space: space.spaceId }, null, 2));
