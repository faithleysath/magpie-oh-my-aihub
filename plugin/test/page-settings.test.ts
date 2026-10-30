import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = join(import.meta.dir, "..", "page");
const html = readFileSync(join(PAGE, "index.html"), "utf8");
const appJS = readFileSync(join(PAGE, "app.js"), "utf8");
const settingsJS = readFileSync(join(PAGE, "settings.js"), "utf8");

type Settings = {
  SEED_FIELDS: string[];
  PREF_FIELDS: string[];
  canonical: (v: unknown) => string;
  same: (a: unknown, b: unknown) => boolean;
  list: (v: unknown) => string[];
  portList: (v: unknown) => number[];
  draftToOptions: (d: unknown) => Record<string, unknown>;
  mergeSaved: (base: Record<string, unknown>, draft: unknown) => { merged: Record<string, unknown>; changed: string[] };
  changedBetween: (a: Record<string, unknown>, b: Record<string, unknown>) => string[];
  seedReady: (o: Record<string, unknown>) => boolean;
};

/** Loads page/settings.js the way the page does: a classic script, no modules. */
function loadSettings(): Settings {
  const sandbox: Record<string, unknown> = {};
  new Function("window", settingsJS)(sandbox);
  return sandbox.OHMYAIHUB_SETTINGS as Settings;
}

const S = loadSettings();

describe("mergeSaved: a save must never erase what the page did not touch", () => {
  test("keeps every key the page does not own, including ones a newer version wrote", () => {
    const base = {
      networkName: "lab",
      networkSecret: "overlay-secret-1",
      peers: ["tcp://relay:11010"],
      rpcPort: 13400,
      apiPort: 34517,
      role: "provider",
      futureKey: { nested: true },
    };
    const { merged, changed } = S.mergeSaved(base, { peers: "tcp://other:11010" });
    expect(merged.rpcPort).toBe(13400);
    expect(merged.apiPort).toBe(34517);
    expect(merged.role).toBe("provider");
    expect(merged.futureKey).toEqual({ nested: true });
    expect(merged.networkSecret).toBe("overlay-secret-1");
    expect(merged.peers).toEqual(["tcp://other:11010"]);
    expect(changed).toEqual(["peers"]);
  });

  test("an empty secret field means keep the stored one, not clear it", () => {
    const base = { networkSecret: "overlay-secret-1", networkName: "lab" };
    const { merged, changed } = S.mergeSaved(base, { networkSecret: "", networkName: "lab" });
    expect(merged.networkSecret).toBe("overlay-secret-1");
    expect(changed).toEqual([]);
  });

  test("a typed secret replaces it, and the change is reported", () => {
    const base = { networkSecret: "overlay-secret-1" };
    const { merged, changed } = S.mergeSaved(base, { networkSecret: "txnpkry-jbozkv-2" });
    expect(merged.networkSecret).toBe("txnpkry-jbozkv-2");
    expect(changed).toEqual(["networkSecret"]);
  });

  test("an unchanged save produces no change at all, so no host restart is asked for", () => {
    const base = { networkName: "lab", networkSecret: "overlay-secret-1", peers: ["tcp://relay:11010"], secureMode: true };
    const { changed } = S.mergeSaved(base, {
      networkName: "lab",
      networkSecret: "",
      peers: "tcp://relay:11010",
      secureMode: true,
    });
    expect(changed).toEqual([]);
  });

  test("a blank network name is not a rename", () => {
    const base = { networkName: "lab" };
    const { merged, changed } = S.mergeSaved(base, { networkName: "   " });
    expect(merged.networkName).toBe("lab");
    expect(changed).toEqual([]);
  });

  test("text fields turn an empty string into null, lists into []", () => {
    for (const key of S.SEED_FIELDS) {
      if (key === "networkName" || key === "networkSecret") continue;
      const options = S.draftToOptions({ [key]: "" });
      expect(options).toHaveProperty(key);
      const value = options[key];
      if (Array.isArray(value)) expect(value).toEqual([]);
      else if (typeof value === "boolean") expect(value).toBe(false);
      else expect(value).toBeNull();
    }
  });

  test("preferences merge without dropping the other preference keys", () => {
    const base = { pagePrefs: { showAdvanced: false, somethingElse: 1 } };
    const { merged, changed } = S.mergeSaved(base, { pagePrefs: { showAdvanced: true } });
    expect(merged.pagePrefs).toEqual({ showAdvanced: true, somethingElse: 1 });
    expect(changed).toEqual(["pagePrefs"]);
  });

  test("lists are de-duplicated and ports drop what is not a port", () => {
    expect(S.list("tcp://a:1, tcp://a:1  tcp://b:2")).toEqual(["tcp://a:1", "tcp://b:2"]);
    expect(S.portList("3425, 3426, 0, nope, 70000")).toEqual([3425, 3426]);
  });

  test("seedReady demands a name and a secret of at least 8 characters", () => {
    expect(S.seedReady({ networkName: "lab", networkSecret: "12345678" })).toBe(true);
    expect(S.seedReady({ networkName: "lab", networkSecret: "1234567" })).toBe(false);
    expect(S.seedReady({ networkName: "l", networkSecret: "12345678" })).toBe(false);
    expect(S.seedReady({})).toBe(false);
  });

  test("a save with no options at all is a no-op", () => {
    expect(S.mergeSaved({}, {})).toEqual({ merged: {}, changed: [] });
  });
});

describe("dirty tracking: a form nobody touched is not a save", () => {
  const freshDraft = {
    networkName: "",
    networkSecret: "",
    peers: "",
    secureMode: true,
    sharingEnabled: false,
    consumingEnabled: false,
    pagePrefs: { showAdvanced: false },
  };

  test("the form as filled differs from plugins.json but not from itself", () => {
    const base = {};
    const first = S.mergeSaved(base, freshDraft).merged;
    const again = S.mergeSaved(base, freshDraft).merged;
    expect(S.mergeSaved(base, freshDraft).changed.length).toBeGreaterThan(0); // differs from {}
    expect(S.changedBetween(first, again)).toEqual([]); // but not from the filled form
  });

  test("typing one field reports exactly that field", () => {
    const base = {};
    const baseline = S.mergeSaved(base, freshDraft).merged;
    const typed = S.mergeSaved(base, { ...freshDraft, networkName: "lab" }).merged;
    expect(S.changedBetween(baseline, typed)).toEqual(["networkName"]);
  });

  test("typing a secret reports only the secret", () => {
    const base = { networkSecret: "overlay-secret-1" };
    const baseline = S.mergeSaved(base, freshDraft).merged;
    const typed = S.mergeSaved(base, { ...freshDraft, networkSecret: "new-secret-here" }).merged;
    expect(S.changedBetween(baseline, typed)).toEqual(["networkSecret"]);
  });

  test("a preference toggle reports only the preference", () => {
    const base = { networkName: "lab", pagePrefs: { showAdvanced: false } };
    const baseline = S.mergeSaved(base, { ...freshDraft, pagePrefs: { showAdvanced: false } }).merged;
    const toggled = S.mergeSaved(base, { ...freshDraft, pagePrefs: { showAdvanced: true } }).merged;
    expect(S.changedBetween(baseline, toggled)).toEqual(["pagePrefs"]);
  });
});

describe("the page respects the CSP Magpie serves it with", () => {
  test("every script is a file, never inline", () => {
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain("src=");
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/i);
  });

  test("no inline event handlers (script-src has no 'unsafe-inline')", () => {
    expect(html).not.toMatch(/\son(click|load|change|input|submit|error)\s*=/i);
  });

  test("every file the page loads exists beside it, or is one the host generates", () => {
    // status.js and options.js are written by the running host; everything else
    // is a file of this repository.
    const generated = new Set(["status.js", "options.js"]);
    const refs = html.match(/(?:src|href)="([^"]+)"/gi) ?? [];
    let checked = 0;
    for (const ref of refs) {
      const value = ref.slice(ref.indexOf('"') + 1, -1);
      if (/^(https?:|#|\/)/.test(value) || value.startsWith("_magpie/")) continue;
      if (generated.has(value)) continue;
      expect(existsSync(join(PAGE, value))).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(3); // style.css, settings.js, app.js
  });

  test("Save is a plain button, because a sandboxed page never fires submit", () => {
    // Measured in a real browser: with `sandbox allow-scripts` and no allow-forms,
    // clicking a submit button inside the page focuses it and fires nothing — no
    // submit event, no navigation, no error. See docs/validation/phase8-csp.md §10.
    expect(html).toMatch(/<button[^>]*type="button"[^>]*id="save"/);
    expect(appJS).toContain('save.addEventListener("click"');
    expect(appJS).toContain('form.addEventListener("submit"');
  });

  test("the page never pretends it can reach the network", () => {
    for (const source of [appJS, settingsJS]) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/XMLHttpRequest/);
      expect(source).not.toMatch(/new\s+WebSocket/);
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });

  test("there are exactly two buttons, and both do something", () => {
    const buttons = html.match(/<button\b[^>]*>/gi) ?? [];
    expect(buttons.length).toBe(2);
    const ids = buttons.map((b) => (b.match(/id="([^"]+)"/) ?? [])[1]).sort();
    expect(ids).toEqual(["reload", "save"]);
    // both are wired in app.js
    expect(appJS).toContain('$("reload").addEventListener');
    expect(appJS).toContain('addEventListener("submit"');
  });

  test("the two external guides are plain links with no parameters and no opener", () => {
    const links = html.match(/<a\b[^>]*href="https?:[^"]*"[^>]*>[^<]*<\/a>/gi) ?? [];
    expect(links.length).toBe(2);
    const labels = links.map((l) => l.replace(/<[^>]+>/g, "").trim());
    expect(labels).toEqual(["BNB Chain 官方教程", "Peer 中文购买教程"]);
    for (const link of links) {
      expect(link).toContain('rel="noopener noreferrer external"');
      expect(link).toContain('target="_blank"');
      expect(link).not.toMatch(/[?&](address|amount|consumer|ref|utm)/i);
    }
    expect(html).toContain("不买、不卖、不兑换、不跨链桥接");
    expect(html).toContain("不适用于");
    expect(html).toContain("由第三方负责");
    expect(html).toContain("当地法律");
    // there is no third place to buy anything
    expect((html.match(/href="https?:/g) ?? []).length).toBe(2);
  });

  test("the first screen is the operator's state, not a spec sheet", () => {
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(header).not.toContain("connect-src");
    expect(header).not.toContain("JSON");
    expect(header).not.toContain("pid");
    // the jargon lives in the advanced block
    const advanced = html.slice(html.indexOf('class="advanced-only"'));
    expect(advanced).toContain("connect-src 'none'");
    // the page renders the plain-language card from the snapshot, not from markup
    expect(appJS).toContain("这台机器还没有接入覆盖网");
    expect(appJS).toContain("已接入 ");
    expect(appJS).toContain("share setup");
  });

  test("it says out loud that the page is read-only and that changes are CLI", () => {
    expect(html).toContain("所有改动都在终端里用命令完成");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("不显示任何 Gateway Key");
  });

  test("delivering a key writes a 0600 file instead of printing it", () => {
    expect(appJS).toContain("share handover alice --key-file");
    expect(appJS).not.toContain('"secret alice"');
    expect(html).toContain("写进你指定的 0600 文件");
    // no command in the page asks for the old `secret <id>` print-the-key path
    expect(html).not.toMatch(/ohmyaihub\.ts[^<]*\bsecret\b/);
    expect(appJS).not.toMatch(/cli\("secret/);
  });

  test("the restart text says what actually happens, and the save text does not promise success", () => {
    expect(html).toContain("重启插件宿主");
    expect(html).toContain("覆盖网和本地运维 API 会消失几秒");
    expect(appJS).toContain("已提交，未验证");
    expect(appJS).not.toMatch(/保存成功|已生效(?!；)/);
  });

  test("the page does not display a gateway key, a secret or an api token", () => {
    for (const source of [html, appJS]) {
      expect(source).not.toMatch(/sk-[A-Za-z0-9._-]{8,}/);
      expect(source).not.toMatch(/api-token/i);
      expect(source).not.toContain("__OH_MY_AIHUB_STATUS__.config.networkSecret");
    }
    // the secret input is a password field and is never pre-filled from options
    expect(html).toMatch(/name="networkSecret"[^>]*type="password"|type="password"[^>]*name="networkSecret"/);
    expect(appJS).not.toMatch(/f\.networkSecret\.value\s*=\s*String/);
  });
});
