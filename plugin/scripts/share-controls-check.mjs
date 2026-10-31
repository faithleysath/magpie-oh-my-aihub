/**
 * Development-only real-browser check for the sharing controls.
 *
 *   bun run plugin/scripts/console-preview.ts --scenario configured --port 61397 &
 *   bun run plugin/scripts/console-preview.ts --scenario unshared  --port 61398 &
 *   ego-browser nodejs < plugin/scripts/share-controls-check.mjs
 *
 * It fails (non-zero) when the share model button does not follow the actual
 * selection, when filtering drops the selection, or when the hidden stop button
 * is still displayed/focusable. Synthetic fixture data only.
 */
const CONFIGURED = "http://127.0.0.1:61397/";
const UNSHARED = "http://127.0.0.1:61398/";
const space = await taskSpace("phase10-a-share-controls");
const page = space.page("p1");
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); };

await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// --- configured node: selection drives the single share action ---
await page.goto(CONFIGURED);
await page.waitForSelector("#private-content:not([hidden])");
await page.click("#nav-sharing");
await page.waitForTimeout(400);
const initial = await page.evaluate(() => {
  const panel = document.getElementById("sharing-panel");
  const save = [...panel.querySelectorAll("button")].find((b) => b.textContent === "分享这些模型");
  const stop = [...panel.querySelectorAll("button")].find((b) => b.textContent === "停止共享");
  return { saveDisabled: save.disabled, stopDisplay: getComputedStyle(stop).display, stopHidden: stop.hidden };
});
check("initial selection keeps share enabled", initial.saveDisabled === false, initial);
check("shared node shows stop", initial.stopHidden === false && initial.stopDisplay !== "none", initial);

const cleared = await page.evaluate(() => {
  const panel = document.getElementById("sharing-panel");
  const boxes = [...panel.querySelectorAll("input[type=checkbox]")];
  for (const box of boxes) { if (box.checked) { box.checked = false; box.dispatchEvent(new Event("change", { bubbles: true })); } }
  const save = [...panel.querySelectorAll("button")].find((b) => b.textContent === "分享这些模型");
  return { saveDisabled: save.disabled, boxes: boxes.length };
});
check("zero selection disables share", cleared.saveDisabled === true, cleared);

const one = await page.evaluate(() => {
  const panel = document.getElementById("sharing-panel");
  const box = [...panel.querySelectorAll("input[type=checkbox]")].find((b) => !b.disabled);
  box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true }));
  const save = [...panel.querySelectorAll("button")].find((b) => b.textContent === "分享这些模型");
  return { saveDisabled: save.disabled };
});
check("one selection enables share", one.saveDisabled === false, one);

const filtered = await page.evaluate(async () => {
  const panel = document.getElementById("sharing-panel");
  const search = panel.querySelector("input[type=search]");
  const chosenBefore = [...panel.querySelectorAll("input[type=checkbox]")].filter((b) => b.checked).length;
  search.value = "deepseek";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  search.value = "zzz-no-match";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const chosenAfter = [...panel.querySelectorAll("input[type=checkbox]")].filter((b) => b.checked).length;
  const save = [...panel.querySelectorAll("button")].find((b) => b.textContent === "分享这些模型");
  return { chosenBefore, chosenAfter, saveDisabled: save.disabled };
});
check("filtering does not drop the selection", filtered.chosenBefore === filtered.chosenAfter && filtered.chosenAfter >= 1, filtered);
check("share stays enabled after filtering back", filtered.saveDisabled === false, filtered);

const dialog = await page.evaluate(() => {
  const panel = document.getElementById("sharing-panel");
  [...panel.querySelectorAll("button")].find((b) => b.textContent === "分享这些模型").click();
  return new Promise((resolve) => setTimeout(() => resolve({ open: Boolean(document.querySelector("dialog.workflow-dialog")?.open) }), 150));
});
check("enabled share opens the confirmation dialog", dialog.open === true, dialog);
await page.evaluate(() => document.querySelector("dialog.workflow-dialog")?.close());

// --- unshared node: stop must be invisible and unreachable ---
await page.goto(UNSHARED);
await page.waitForSelector("#private-content:not([hidden])");
await page.click("#nav-sharing");
await page.waitForTimeout(400);
const unshared = await page.evaluate(() => {
  const panel = document.getElementById("sharing-panel");
  const stop = [...panel.querySelectorAll("button")].find((b) => b.textContent === "停止共享");
  const before = document.activeElement;
  stop.focus();
  const style = getComputedStyle(stop);
  return {
    exists: Boolean(stop), hidden: stop.hidden, display: style.display,
    offsetParent: stop.offsetParent === null, focusable: document.activeElement === stop,
    focusedTag: document.activeElement?.tagName, previousTag: before?.tagName,
  };
});
check("unshared stop is hidden", unshared.hidden === true, unshared);
check("unshared stop is not displayed", unshared.display === "none" && unshared.offsetParent, unshared);
check("unshared stop cannot take focus", unshared.focusable === false, unshared);

const failed = results.filter((row) => !row.ok);
console.log(JSON.stringify({ results, failed: failed.length, space: space.spaceId }, null, 2));
if (failed.length) throw new Error(`share controls check failed: ${failed.map((row) => row.name).join(", ")}`);
