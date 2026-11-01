import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Guards the visual system the AI-slop review asked for. These are source-level
 * rules with a rendered-state check where one is cheap: a page must not quietly
 * reintroduce badges, middle-dot metadata, mono prose, nested stickers, a fifth
 * type size, a colored side bar or a decorative arrow.
 */
const here = new URL(".", import.meta.url);
const read = (name) => readFileSync(new URL(name, here), "utf8");
const html = read("index.html");
const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
const modules = readdirSync(here)
  .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
  .map((name) => [name, read(name)]);

describe("one plain status language", () => {
  test("no pill component is shipped or used", () => {
    expect(css).not.toMatch(/\.pill\b/);
    for (const [name, source] of modules) expect(`${name}:${source.includes('class="pill')}`).toBe(`${name}:false`);
    for (const [name, source] of modules) expect(`${name}:${source.includes("`pill ")}`).toBe(`${name}:false`);
  });

  test("status text is text, and semantic colour is only good/bad", () => {
    expect(css).toContain(".status-text {");
    expect(css).toContain(".status-text.good { color: var(--good); }");
    expect(css).toContain(".status-text.bad { color: var(--bad); }");
    expect(css).toContain(".session-state.good::before");
  });
});

describe("typography and mono scope", () => {
  test("exactly four type sizes, body 16 and helper 14", () => {
    const tokens = [...css.matchAll(/--text-(sm|base|lg|xl): (\d+)px;/g)].map((match) => Number(match[2]));
    expect(tokens).toEqual([14, 16, 20, 26]);
    const sizes = [...css.matchAll(/font-size: ([^;]+);/g)].map((match) => match[1].trim());
    for (const value of sizes) expect(value.startsWith("var(--text-")).toBe(true);
    expect(sizes.some((value) => value === "var(--text-base)")).toBe(true);
    // No small print below 14 px anywhere, including the tokens themselves.
    for (const value of tokens) expect(value).toBeGreaterThanOrEqual(14);
  });

  test("mono is an identifier style, not the default for lists or prose", () => {
    const selectors = [...css.matchAll(/([^{}]+)\{[^}]*font-family: var\(--font-mono\)/g)]
      .flatMap((match) => match[1].split(","))
      .map((selector) => selector.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const allowed = [
      "code", ".fingerprint", ".secret-value", ".mono", ".amount",
      ".workflow-details span.mono", ".wallet-payment-facts dd.mono",
      ".facts dd.mono", ".wallet-vault-facts dd.mono", ".pairing-code",
      ".wallet-vault-secret",
    ];
    for (const selector of selectors) expect(allowed).toContain(selector);
    // The reviewed offenders are gone.
    for (const gone of [".credit-list li", ".home-model-group ul", ".facts dd", ".workflow-details span", ".wallet-payment-list small"]) {
      const start = css.indexOf(`${gone} {`);
      expect(start).toBeGreaterThan(-1);
      expect(css.slice(start, css.indexOf("}", start))).not.toContain("font-family: var(--font-mono)");
    }
  });
});

describe("one sticker layer", () => {
  test("only a card, a dialog, a button and the brand mark carry a hard shadow", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map((match) => [match[1].replace(/\s+/g, " ").trim(), match[2]])
      .filter(([, body]) => body.includes("box-shadow: var("));
    const allowed = [
      ".brand-mark", ".nav-item.active", '.nav-item[aria-current="page"]',
      ".card", ".button", ".icon-button", "dialog.workflow-dialog",
      ".pairing-code", ".wallet-network-card",
      ".field input:focus-visible", ".field textarea:focus-visible",
      ".field select:focus-visible", ".workflow-search:focus-visible",
    ];
    for (const [selector] of rules) {
      for (const part of selector.split(",").map((value) => value.trim())) expect(allowed).toContain(part);
    }
    expect(css).not.toContain(".card .card");
  });

  test("warnings use one full thin border, never a colored left bar", () => {
    expect(css).not.toContain("border-left");
    const rule = css.slice(css.indexOf(".inline-warning {"), css.indexOf("}", css.indexOf(".inline-warning {")));
    expect(rule).toContain("border: 1px solid var(--bad)");
    expect(rule).toContain("background: transparent");
  });

  test("inner lists are flat rows, not second stickers", () => {
    for (const selector of [".wallet-payment-list li", ".wallet-network-assets li", ".wallet-choice", ".discovery-model", ".wallet-timeline > li"]) {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThan(-1);
      const rule = css.slice(start, css.indexOf("}", start));
      expect(rule).not.toContain("box-shadow: var(");
      expect(rule).not.toMatch(/border: var\(--stroke\)/);
    }
  });
});

describe("plain language in ordinary UI", () => {
  test("no middle-dot metadata and no decorative arrows in shipped UI", () => {
    for (const [name, source] of [["index.html", html], ...modules]) {
      expect(`${name}:${source.includes("·")}`).toBe(`${name}:false`);
      expect(`${name}:${source.includes("→")}`).toBe(`${name}:false`);
    }
  });

  test("implementation terms stay out of ordinary headings", () => {
    const ordinary = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(ordinary).not.toContain("EIP-6963");
    expect(ordinary).not.toContain("FULL AUTO");
    expect(html).not.toContain("不可授信");
  });

  test("home has one text action per block and no duplicate arrow labels", () => {
    const home = html.slice(html.indexOf('<section id="overview"'), html.indexOf('<section id="discovery-page"'));
    expect([...home.matchAll(/data-goto="/g)]).toHaveLength(4);
    for (const label of ["查看网络", "去发现", "查看共享", "查看钱包"]) expect(home).toContain(`>${label}</button>`);
  });
});
