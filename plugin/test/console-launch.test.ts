import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localDesktop, nativeDesktopParent, openerArgv, parseLaunchOptions, readConsolePort, readOwnPluginOptions, saveConsolePort, startConsoleLauncher } from "../src/console-launch.ts";
import { createConsoleHandler } from "../src/console-server.ts";
import { decideOptions, digestOf, newRecord, parseOptions } from "../src/plugin-options.ts";

const stamp = 1_900_000_000_000;
const nonce = "a".repeat(32);
const request = { nonce, issuedAt: stamp, expiresAt: stamp + 120000 };
const url = "http://127.0.0.1:34567/#ticket=" + "c".repeat(64);
async function isolated(run: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ohmy-launch-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function settle(launcher: ReturnType<typeof startConsoleLauncher>) {
  for (let i = 0; i < 100 && launcher.snapshot().state === "attempting"; i++) await Bun.sleep(1);
  await launcher.poll();
}

describe("local launch option boundary", () => {
  test("official pairing approval is narrowly named and expires within two minutes", () => {
    const approval = { id: "d".repeat(32), code: "01234567", issuedAt: stamp, expiresAt: stamp + 60000 };
    expect(parseLaunchOptions({ consoleLaunch: { approval } }, stamp).approval).toEqual(approval);
    for (const patch of [{ id: url }, { code: "1234567" }, { expiresAt: stamp }, { expiresAt: stamp + 120001 }, { issuedAt: stamp + 6000 }, { code: 12345678 }]) {
      expect(parseLaunchOptions({ consoleLaunch: { approval: { ...approval, ...patch } } }, stamp).approval).toBeUndefined();
    }
    const base = parseOptions({ networkName: "lab", networkSecret: "fixture-secret" }).options;
    expect(digestOf(parseOptions({ ...base, consoleLaunch: { approval } }).options)).toBe(digestOf(base));
  });
  test("nonce is bounded, expiring metadata, never a URL or credential", () => {
    expect(parseLaunchOptions({ consoleLaunch: { request } }, stamp).request).toEqual(request);
    for (const patch of [{ nonce: url }, { expiresAt: stamp }, { issuedAt: stamp + 6000 }, { expiresAt: stamp + 120001 }, { issuedAt: NaN }, { nonce: "../shell" }]) {
      expect(parseLaunchOptions({ consoleLaunch: { request: { ...request, ...patch } } }, stamp).request).toBeUndefined();
    }
  });
  test("launch options never change the network digest or configure decision", () => {
    const base = { networkName: "lab", networkSecret: "fixture-secret" };
    const withRequest = { ...base, consoleLaunch: { request, autoOpen: false } };
    const a = parseOptions(base).options, b = parseOptions(withRequest).options;
    expect(digestOf(a)).toBe(digestOf(b));
    expect(decideOptions({ options: b, configured: true, record: newRecord(a, "seed", new Date(stamp).toISOString()) }).kind).toBe("none");
  });
  test("desktop detection rejects SSH, CI and headless; automatic requires a native parent", () => {
    expect(localDesktop("darwin", {})).toBe(true);
    expect(localDesktop("linux", {})).toBe(false);
    expect(localDesktop("linux", { DISPLAY: ":0" })).toBe(true);
    expect(localDesktop("darwin", { SSH_CONNECTION: "fixture" })).toBe(false);
    expect(localDesktop("win32", { CI: "1" })).toBe(false);
    expect(nativeDesktopParent(process.pid)).toBe(false); // this is Bun test, not Magpie desktop
    expect(nativeDesktopParent(0)).toBe(false);
  });
  test("OS argv are fixed and refuse arbitrary or credential-bearing destinations", () => {
    expect(openerArgv(url, "darwin", {})).toEqual(["/usr/bin/open", url]);
    expect(openerArgv(url, "linux", {})).toEqual(["xdg-open", url]);
    expect(openerArgv(url, "win32", {})).toEqual(["C:\\Windows\\System32\\rundll32.exe", "url.dll,FileProtocolHandler", url]);
    for (const bad of ["https://evil.example/", "http://localhost:34567/#ticket=" + "c".repeat(64), "file:///tmp/hi", url.replace("/#", "/api/#"), url.replace("/#", "/?secret=x#"), "http://me:pass@127.0.0.1:34567/#ticket=" + "c".repeat(64)]) expect(() => openerArgv(bad)).toThrow();
  });
});

describe("read-only official Magpie options observer", () => {
  test("path plugin, off flag, ambiguous match, unrelated options and malformed JSON", () => isolated((dir) => {
    const root = join(dir, "copy"); mkdirSync(root);
    const file = join(dir, "plugins.json");
    const document = { plugins: [{ spec: "/other/plugin", options: { secret: "do-not-read" } }, { spec: root, options: { consoleLaunch: { autoOpen: false, request }, networkSecret: "fixture" } }] };
    writeFileSync(file, JSON.stringify(document));
    const before = readFileSync(file, "utf8");
    expect(readOwnPluginOptions(dir, root)).toEqual(document.plugins[1]!.options);
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, JSON.stringify({ plugins: [{ ...document.plugins[1], off: true }] }));
    expect(readOwnPluginOptions(dir, root)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ plugins: [document.plugins[1], document.plugins[1]] }));
    expect(readOwnPluginOptions(dir, root)).toBeUndefined();
    writeFileSync(file, "{"); expect(readOwnPluginOptions(dir, root)).toBeUndefined();
  }));
  test("npm version and git spec resolve via actual installed target, never fuzzy package names", () => isolated((dir) => {
    const root = join(dir, "copy"); mkdirSync(root);
    const node = join(dir, "plugins/node_modules/@oh-my-aihub"); mkdirSync(node, { recursive: true });
    symlinkSync(root, join(node, "magpie-plugin"));
    const file = join(dir, "plugins.json");
    writeFileSync(file, JSON.stringify({ plugins: [{ spec: "@oh-my-aihub/magpie-plugin@0.4.0", options: { consoleLaunch: { autoOpen: false } } }] }));
    expect(readOwnPluginOptions(dir, root)).toEqual({ consoleLaunch: { autoOpen: false } });
    const spec = "github:fixture/project#abc";
    writeFileSync(join(dir, "plugins/package.json"), JSON.stringify({ dependencies: { "@oh-my-aihub/magpie-plugin": spec } }));
    writeFileSync(file, JSON.stringify({ plugins: [{ spec, options: { consoleLaunch: { request } } }] }));
    expect(readOwnPluginOptions(dir, root)).toEqual({ consoleLaunch: { request } });
  }));
});

test("root GitHub package identity must resolve main to this exact entry", () => isolated((dir) => {
  const root = join(dir, "installed/plugin"); mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), "// fixture");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@fixture/hub", main: "src/index.ts" }));
  const outer = join(dir, "installed");
  writeFileSync(join(outer, "package.json"), JSON.stringify({ name: "@fixture/hub", main: "plugin/src/index.ts" }));
  writeFileSync(join(dir, "plugins.json"), JSON.stringify({ plugins: [{ spec: outer, options: { consoleLaunch: { autoOpen: false } } }] }));
  expect(readOwnPluginOptions(dir, root)).toEqual({ consoleLaunch: { autoOpen: false } });
  writeFileSync(join(outer, "package.json"), JSON.stringify({ name: "@fixture/hub", main: "foreign.ts" }));
  writeFileSync(join(outer, "foreign.ts"), "// foreign");
  expect(readOwnPluginOptions(dir, root)).toBeUndefined();
}));

describe("single owner browser launch journal", () => {
  // Windows cannot open a directory for fsync, so the durable pairing journal
  // fails closed with 503 (see scripts/platform-report.ts). The product path is
  // a known gap, not a pass; the rest of this file still runs on win32.
  test.skipIf(process.platform === "win32")("browser pairing survives official approval restart through real handler + launcher, never revives old session or opens browser", () => isolated(async (dir) => {
    const pairingFile = join(dir, "pairing.json");
    const serverOptions = { pairingFile, state: async () => ({ configured: false }), action: async () => ({}), allowedActions: [] };
    const make = () => createConsoleHandler(serverOptions, 34567, { now: () => stamp });
    const first = make();
    function post(server: ReturnType<typeof make>, path: string, body: unknown) {
      return server.handle(new Request(server.origin + path, { method: "POST", headers: {
        host: "127.0.0.1:34567", origin: server.origin, "content-type": "application/json", "X-Ohmyaihub-Request": "1", "sec-fetch-site": "same-origin",
      }, body: JSON.stringify(body) }));
    }
    const ticket = new URL(first.issueTicket()).hash.slice("#ticket=".length);
    const oldSession = await post(first, "/ui/session", { ticket });
    expect(oldSession.status).toBe(200);
    const oldCookie = oldSession.headers.get("set-cookie")!.split(";")[0]!;
    const response = await post(first, "/ui/pairing", {}); expect(response.status).toBe(200);
    const pairing = await response.json() as { id: string; code: string; secret: string; expiresAt: string };
    const waiting = await post(first, "/ui/pairing/exchange", { id: pairing.id, secret: pairing.secret }); expect(waiting.status).toBe(202);
    // The only durable approval input is the same object written by the native
    // official-options handler. Reconstruct the owner exactly as restart does.
    first.stop(); const second = make();
    let opens = 0;
    const launcher = startConsoleLauncher({ port: second.port, issueTicket: () => second.issueTicket(),
      options: { consoleLaunch: { approval: { id: pairing.id, code: pairing.code, issuedAt: stamp, expiresAt: Date.parse(pairing.expiresAt) } } },
      readOptions: () => undefined, now: () => stamp, desktop: true, autoDesktop: true,
      pendingPairings: () => second.pendingPairings(), approvePairing: (id, code) => second.approvePairing(id, code),
      journalFile: join(dir, "launch.json"), pageDir: join(dir, "page"), pollMs: 100000, open: async () => { opens++; return true; } });
    await settle(launcher); expect(opens).toBe(0); expect(launcher.snapshot().approval?.accepted).toBe(true);
    const stale = await second.handle(new Request(second.origin + "/ui/session", { headers: { host: "127.0.0.1:34567", cookie: oldCookie, "X-Ohmyaihub-Request": "1" } }));
    expect(stale.status).toBe(401);
    const exchanged = await post(second, "/ui/pairing/exchange", { id: pairing.id, secret: pairing.secret }); expect(exchanged.status).toBe(200);
    const info = await exchanged.json() as { instance: string; csrf: string }; expect(info.instance).toBeTruthy(); expect(info.csrf).toBeTruthy();
    expect(exchanged.headers.get("set-cookie")).not.toBe(oldCookie);
    await launcher.poll(); expect(opens).toBe(0);
    const snapshot = readFileSync(join(dir, "page/launcher.js"), "utf8");
    expect(snapshot).not.toContain(pairing.secret); expect(snapshot).not.toContain("secretHash"); expect(snapshot).not.toContain(info.csrf);
    launcher.stop(); second.stop();
    const third = make(); expect(third.approvePairing(pairing.id, pairing.code)).toBe(false);
    const replay = await post(third, "/ui/pairing/exchange", { id: pairing.id, secret: pairing.secret }); expect(replay.status).toBe(401); third.stop();
  }));
  test("official approval watcher calls only matching id/code and publishes public projection without opening browser", () => isolated(async (dir) => {
    const approval = { id: "d".repeat(32), code: "01234567", issuedAt: stamp, expiresAt: stamp + 60000 };
    let options: unknown = { consoleLaunch: { approval } };
    let approved = false, attempts = 0, currentTime = stamp;
    const calls: string[][] = [];
    const launcher = startConsoleLauncher({ port: 34567, issueTicket: () => url, readOptions: () => options, desktop: true, autoDesktop: true, now: () => currentTime,
      journalFile: join(dir, "journal"), pageDir: join(dir, "page"), pollMs: 100000,
      pendingPairings: () => approved ? [] : [{ id: approval.id, code: approval.code, expiresAt: new Date(approval.expiresAt).toISOString(), secret: "DO_NOT_COPY_SECRET", hash: "DO_NOT_COPY_HASH" }],
      approvePairing: (id, code) => { calls.push([id, code]); approved = true; return true; }, open: async () => { attempts++; return true; } });
    await settle(launcher); expect(calls[0]).toEqual([approval.id, approval.code]); expect(attempts).toBe(0);
    expect(launcher.snapshot().approval?.accepted).toBe(true); expect(launcher.snapshot().origin).toBe("http://127.0.0.1:34567");
    const page = readFileSync(join(dir, "page/launcher.js"), "utf8");
    expect(page).not.toContain("DO_NOT_COPY"); expect(page).not.toContain("ticket");
    options = { consoleLaunch: { approval: { ...approval, code: "bad" } } };
    const count = calls.length; await launcher.poll(); expect(calls.length).toBe(count);
    currentTime = stamp + 120001; await launcher.poll(); expect(attempts).toBe(0); launcher.stop();
  }));
  test("request journals before one attempt; reload, restart and replay never retry it", () => isolated(async (dir) => {
    let attempts = 0;
    const journalFile = join(dir, "journal.json");
    const input = { port: 34567, issueTicket: () => url, options: { consoleLaunch: { autoOpen: false, request } },
      readOptions: () => undefined, desktop: true, autoDesktop: false, now: () => stamp, journalFile, pageDir: join(dir, "page"), pollMs: 100000,
      open: async () => { attempts++; expect(JSON.parse(readFileSync(journalFile, "utf8")).consumed[0].nonce).toBe(nonce); return true; } };
    const first = startConsoleLauncher(input);
    await settle(first); expect(attempts).toBe(1); expect(first.snapshot().state).toBe("opened"); first.stop();
    const second = startConsoleLauncher(input);
    await settle(second); second.stop(); expect(attempts).toBe(1);
    const page = readFileSync(join(dir, "page/launcher.js"), "utf8");
    expect(page).not.toContain("ticket"); expect(page).not.toContain(url); expect(page).not.toContain("fixture-secret");
  }));
  test("active retired owner observes new official options without Service reconfigure", () => isolated(async (dir) => {
    let options: unknown = { consoleLaunch: { autoOpen: false } };
    let attempts = 0;
    const launcher = startConsoleLauncher({ port: 34567, issueTicket: () => url, options,
      readOptions: () => options, desktop: true, autoDesktop: false, now: () => stamp, journalFile: join(dir, "journal"), pageDir: join(dir, "page"),
      open: async () => { attempts++; return true; }, pollMs: 100000 });
    await settle(launcher); expect(attempts).toBe(0);
    options = { consoleLaunch: { autoOpen: false, request } };
    await launcher.poll(); await settle(launcher); expect(attempts).toBe(1);
    expect(launcher.snapshot().requestNonce).toBe(nonce); launcher.stop();
  }));
  test("fresh native desktop enable opens once; CLI, optout and headless never auto-retry", () => isolated(async (dir) => {
    for (const [name, desktop, autoDesktop, autoOpen, expected] of [
      ["native", true, true, true, 1], ["cli", true, false, true, 0], ["optout", true, true, false, 0], ["headless", false, false, true, 0],
    ] as const) {
      let attempts = 0;
      const input = { port: 34567, issueTicket: () => url, options: { consoleLaunch: { autoOpen } }, readOptions: () => undefined,
        desktop, autoDesktop, now: () => stamp, journalFile: join(dir, name + ".json"), pageDir: join(dir, name), pollMs: 100000,
        open: async () => { attempts++; return true; } };
      const first = startConsoleLauncher(input); await settle(first); first.stop();
      const next = startConsoleLauncher(input); await settle(next); next.stop();
      expect(attempts).toBe(expected);
    }
  }));
  test("failed/throwing opener is sanitized and cannot replay; fresh nonce recovers", () => isolated(async (dir) => {
    let options: unknown = { consoleLaunch: { autoOpen: false, request } };
    let attempts = 0;
    const launcher = startConsoleLauncher({ port: 34567, issueTicket: () => url, readOptions: () => options,
      desktop: true, autoDesktop: false, now: () => stamp, journalFile: join(dir, "journal"), pageDir: join(dir, "page"), pollMs: 100000,
      open: async () => { attempts++; if (attempts === 1) throw new Error(url); return true; } });
    await settle(launcher); expect(launcher.snapshot().state).toBe("failed");
    await launcher.poll(); expect(attempts).toBe(1);
    expect(readFileSync(join(dir, "page/launcher.js"), "utf8")).not.toContain(url);
    options = { consoleLaunch: { request: { ...request, nonce: "b".repeat(32) } } };
    await launcher.poll(); expect(attempts).toBe(2); expect(launcher.snapshot().state).toBe("opened"); launcher.stop();
  }));
  test("unwritable journal and corrupt journal fail closed, not repeated opening", () => isolated(async (dir) => {
    for (const corrupt of [false, true]) {
      const file = join(dir, corrupt ? "corrupt" : "directory");
      if (corrupt) writeFileSync(file, "{"); else mkdirSync(file);
      let attempts = 0;
      const launcher = startConsoleLauncher({ port: 34567, issueTicket: () => url, options: { consoleLaunch: { request } }, readOptions: () => undefined,
        desktop: true, autoDesktop: true, now: () => stamp, journalFile: file, pageDir: join(dir, corrupt ? "page1" : "page2"), pollMs: 100000,
        open: async () => { attempts++; return true; } });
      await settle(launcher); await launcher.poll(); launcher.stop(); expect(attempts).toBe(0);
      expect(launcher.snapshot().state).toBe("failed");
    }
  }));
  test("new owner acknowledges old attempt without replay and asks to reopen expired session", () => isolated(async (dir) => {
    const file = join(dir, "journal.json");
    writeFileSync(file, JSON.stringify({ version: 1, firstEnableSeen: true, consumed: [{ nonce, expiresAt: request.expiresAt }], last: { nonce, ownerPid: 99999999, state: "opened" } }));
    let attempts = 0;
    const launcher = startConsoleLauncher({ port: 34567, issueTicket: () => url, options: { consoleLaunch: { request } }, readOptions: () => undefined, desktop: true, autoDesktop: false, now: () => stamp,
      journalFile: file, pageDir: join(dir, "page"), pollMs: 100000, open: async () => { attempts++; return true; } });
    await settle(launcher); expect(attempts).toBe(0); expect(launcher.snapshot().requestNonce).toBe(nonce);
    expect(launcher.snapshot().state).toBe("failed"); expect(launcher.snapshot().message).toContain("旧页面需要重新登录"); launcher.stop();
  }));
  test("a prior CLI-only import does not consume first native desktop enable", () => isolated(async (dir) => {
    let attempts = 0;
    const input = { port: 34567, issueTicket: () => url, options: {}, readOptions: () => undefined, desktop: true, now: () => stamp,
      journalFile: join(dir, "journal"), pageDir: join(dir, "page"), pollMs: 100000, open: async () => { attempts++; return true; } };
    const cli = startConsoleLauncher({ ...input, autoDesktop: false }); await settle(cli); cli.stop(); expect(attempts).toBe(0);
    const native = startConsoleLauncher({ ...input, autoDesktop: true }); await settle(native); native.stop(); expect(attempts).toBe(1);
  }));
  test("stable port metadata contains only port and validates bounds", () => isolated((dir) => {
    const file = join(dir, "port.json");
    expect(readConsolePort(file)).toBeUndefined(); saveConsolePort(34567, file); expect(readConsolePort(file)).toBe(34567);
    for (const p of [0, 65536, "34567", -5]) { writeFileSync(file, JSON.stringify({ port: p })); expect(readConsolePort(file)).toBeUndefined(); }
    expect(existsSync(file)).toBe(true);
  }));
});
