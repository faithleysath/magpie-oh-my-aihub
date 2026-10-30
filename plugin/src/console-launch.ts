// Local browser entry only. No CLI, shell, provider hooks or Magpie JSON writes.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { pluginRoot, magpieDataDir, statePath } from "./paths.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export interface OpenRequest { nonce: string; issuedAt: number; expiresAt: number }
export interface PairingApproval { id: string; code: string; issuedAt: number; expiresAt: number }
export interface PendingPairing { id: string; code: string; expiresAt: string }
export interface LaunchOptions { autoOpen: boolean; request?: OpenRequest; approval?: PairingApproval }
export interface LauncherSnapshot {
  at: string; ownerPid: number; port: number; state: "ready" | "attempting" | "opened" | "failed" | "unavailable";
  requestNonce: string | null; message: string; autoOpen: boolean; desktop: boolean;
  origin: string | null; pendingPairings: PendingPairing[];
  approval: { id: string; accepted: boolean; at: string } | null;
}
interface Journal {
  version: 1; firstEnableSeen: boolean; consumed: { nonce: string; expiresAt: number }[];
  last?: { nonce: string | null; ownerPid: number; state: "attempting" | "opened" | "failed" | "unavailable" };
}

export function parseLaunchOptions(raw: unknown, now = Date.now()): LaunchOptions {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>).consoleLaunch : null;
  const p = o && typeof o === "object" ? o as Record<string, unknown> : {};
  const r = p.request as Partial<OpenRequest> | undefined;
  const valid = r && typeof r.nonce === "string" && /^[a-f0-9]{32}$/.test(r.nonce) &&
    typeof r.issuedAt === "number" && typeof r.expiresAt === "number" &&
    Number.isSafeInteger(r.issuedAt) && Number.isSafeInteger(r.expiresAt) &&
    r.issuedAt <= now + 5000 && r.expiresAt > now && r.expiresAt > r.issuedAt &&
    r.expiresAt - r.issuedAt <= 120000;
  const a = p.approval as Partial<PairingApproval> | undefined;
  const validApproval = a && typeof a.id === "string" && /^[a-f0-9]{32}$/.test(a.id) &&
    typeof a.code === "string" && /^\d{8}$/.test(a.code) &&
    typeof a.issuedAt === "number" && typeof a.expiresAt === "number" &&
    Number.isSafeInteger(a.issuedAt) && Number.isSafeInteger(a.expiresAt) &&
    a.issuedAt <= now + 5000 && a.expiresAt > now && a.expiresAt > a.issuedAt && a.expiresAt - a.issuedAt <= 120000;
  return { autoOpen: p.autoOpen !== false, ...(valid ? { request: r as OpenRequest } : {}),
    ...(validApproval ? { approval: a as PairingApproval } : {}) };
}

/** Availability hint, not proof that a Magpie web viewer is on this machine. */
export function localDesktop(platform = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT || env.CI) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return platform === "linux" && Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Automatic launch requires a verified native Magpie desktop parent, not just DISPLAY. */
export function nativeDesktopParent(ppid = process.ppid): boolean {
  if (!localDesktop() || process.platform === "win32" || ppid <= 1) return false;
  try {
    const result = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(ppid)], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return false;
    const command = result.stdout.toString().trim();
    // The app executable may contain spaces. All automatic entry argv must be
    // desktop-only: never --version, web, plugin or provider enumeration.
    const match = command.match(/^(.*\/Contents\/MacOS\/(?:Magpie|magpie))(?:\s+(.*))?$/) ?? command.match(/^(\S*magpie)(?:\s+(.*))?$/i);
    if (!match || !/^(?:magpie)$/i.test(basename(match[1]!))) return false;
    return !match[2] || /^(?:app|gui|panel|-Embedding)$/.test(match[2]);
  } catch { return false; }
}

/** Fixed program/argv only. The input must come from the already-bound console. */
export function openerArgv(url: string, platform = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port || u.pathname !== "/" ||
      u.search || u.username || u.password || !/^#ticket=[A-Za-z0-9_-]{43,64}$/.test(u.hash)) throw new Error("invalid local console handoff");
  if (platform === "darwin") return ["/usr/bin/open", url];
  if (platform === "linux") return ["xdg-open", url];
  if (platform === "win32") {
    const root = env.SystemRoot || "C:\\Windows";
    if (!win32.isAbsolute(root)) throw new Error("invalid system directory");
    return [win32.join(root, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", url];
  }
  throw new Error("unsupported desktop");
}

export async function openLocalConsole(url: string): Promise<boolean> {
  // Never let spawn errors (which can include argv/ticket) reach the logger.
  try {
    const child = Bun.spawn(openerArgv(url), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timeout = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 10000);
    const force = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 11000);
    try { return (await child.exited) === 0; } finally { clearTimeout(timeout); clearTimeout(force); }
  } catch { return false; }
}

/**
 * Magpie v0.1.2171 store.go: Entry{spec,off,options}, List{plugins}; cwd is
 * settings.Dir. Target(path)=absolute path; npm strips @version; git resolves
 * through plugins/package.json dependencies. Exact canonical target matching
 * avoids consuming a different plugin's options. This function is READ ONLY.
 */
export function readOwnPluginOptions(dataDir = magpieDataDir(), root = pluginRoot()): unknown | undefined {
  try {
    const list = JSON.parse(readFileSync(join(dataDir, "plugins.json"), "utf8"));
    if (!Array.isArray(list.plugins)) return undefined;
    const canonicalRoot = realpathSync(root);
    const allowedRoots = new Set([canonicalRoot]);
    // Root GitHub packaging uses main=plugin/src/index.ts, while historical
    // local installs use plugin/main=src/index.ts. Check main resolves to this
    // exact entry; a matching package name alone never establishes identity.
    try {
      const outer = dirname(canonicalRoot);
      const pkg = JSON.parse(readFileSync(join(outer, "package.json"), "utf8"));
      const inner = JSON.parse(readFileSync(join(canonicalRoot, "package.json"), "utf8"));
      if (pkg.name === inner.name && typeof pkg.main === "string" &&
          realpathSync(resolve(outer, pkg.main)) === realpathSync(join(canonicalRoot, "src/index.ts"))) allowedRoots.add(realpathSync(outer));
    } catch { /* nested-only installation */ }
    let deps: Record<string, unknown> = {};
    try { deps = JSON.parse(readFileSync(join(dataDir, "plugins/package.json"), "utf8")).dependencies ?? {}; } catch { /* path installs need no deps */ }
    const matches = list.plugins.filter((e: unknown) => {
      if (!e || typeof e !== "object") return false;
      const entry = e as Record<string, unknown>;
      if (entry.off || typeof entry.spec !== "string") return false;
      const spec = entry.spec;
      let target: string;
      if (isAbsolute(spec) || spec.startsWith(".") || spec.startsWith("file://")) target = resolve(dataDir, spec.replace(/^file:\/\//, ""));
      else {
        const dep = Object.keys(deps).find((name) => deps[name] === spec);
        const at = spec.lastIndexOf("@");
        const name = dep ?? (at > 0 ? spec.slice(0, at) : spec);
        if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(name)) return false;
        target = join(dataDir, "plugins/node_modules", name);
      }
      try { return allowedRoots.has(realpathSync(target)); } catch { return false; }
    });
    return matches.length === 1 ? matches[0].options ?? {} : undefined;
  } catch { return undefined; }
}

export function readConsolePort(file = statePath("console-port.json")): number | undefined {
  const p = readJson<{ port?: number }>(file)?.port;
  return Number.isInteger(p) && p! > 0 && p! <= 65535 ? p : undefined;
}
export function saveConsolePort(port: number, file = statePath("console-port.json")): void {
  writeJsonAtomic(file, { port });
}

export function publishUnavailableLauncher(pageDir = join(pluginRoot(), "page")): void {
  mkdirSync(pageDir, { recursive: true, mode: 0o700 });
  const view: LauncherSnapshot = { at: new Date().toISOString(), ownerPid: process.pid, port: 0, state: "failed",
    requestNonce: null, message: "控制台暂时未能启动；覆盖网仍在运行。请重新打开插件页后再试。", autoOpen: false, desktop: localDesktop(), origin: null, pendingPairings: [], approval: null };
  writeFileSync(join(pageDir, "launcher.js"), "window.__OH_MY_AIHUB_LAUNCHER__ = " + JSON.stringify(view) + ";\n", { mode: 0o600 });
}

export interface LauncherInput {
  port: number; issueTicket: () => string; options?: unknown;
  readOptions?: () => unknown | undefined;
  pendingPairings?: () => PendingPairing[];
  approvePairing?: (id: string, code: string) => boolean;
  open?: (url: string) => Promise<boolean>; desktop?: boolean; autoDesktop?: boolean; now?: () => number;
  journalFile?: string; pageDir?: string; pollMs?: number;
}

export function startConsoleLauncher(input: LauncherInput): { stop(): void; snapshot(): LauncherSnapshot; poll(): Promise<void> } {
  const journalFile = input.journalFile ?? statePath("console-launch.json");
  const pageDir = input.pageDir ?? join(pluginRoot(), "page");
  const now = input.now ?? Date.now;
  const desktop = input.desktop ?? localDesktop();
  const autoDesktop = input.autoDesktop ?? nativeDesktopParent();
  const open = input.open ?? openLocalConsole;
  const readOptions = input.readOptions ?? readOwnPluginOptions;
  const prior = readJson<Journal>(journalFile);
  // An unreadable journal must not replay first-enable or an uncertain request.
  let corrupt = existsSync(journalFile) && (!prior || prior.version !== 1 || typeof prior.firstEnableSeen !== "boolean" || !Array.isArray(prior.consumed) || prior.consumed.some((r) => !r || typeof r.nonce !== "string" || typeof r.expiresAt !== "number"));
  let journal: Journal = !corrupt && prior?.version === 1 && Array.isArray(prior.consumed) ? prior : { version: 1, firstEnableSeen: corrupt, consumed: [] };
  let raw = input.options;
  let busy = false;
  let stopped = false;
  let view: LauncherSnapshot = { at: new Date(now()).toISOString(), ownerPid: process.pid, port: input.port,
    state: desktop ? "ready" : "unavailable", requestNonce: null, message: desktop ? "控制台已就绪。" : "此宿主没有可用的本机桌面；不会自动打开浏览器。", autoOpen: true, desktop, origin: `http://127.0.0.1:${input.port}`, pendingPairings: [], approval: null };
  if (journal.last && journal.last.ownerPid !== process.pid &&
      (journal.last.nonce === null || /^[a-f0-9]{32}$/.test(journal.last.nonce))) {
    view.requestNonce = journal.last.nonce;
    view.state = "failed";
    view.message = "宿主已重新启动；上次打开尝试不会重放，旧页面需要重新登录。请重新点打开控制台。";
  }
  function publish() {
    // Re-project every record instead of copying callback objects: even an
    // accidental backend extra field must never expose a hash/browser secret.
    view.pendingPairings = (input.pendingPairings?.() ?? []).filter((r) =>
      /^[a-f0-9]{32}$/.test(r.id) && /^\d{8}$/.test(r.code) &&
      Number.isFinite(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt) > now() && Date.parse(r.expiresAt) <= now() + 120000
    ).slice(0, 8).map((r) => ({ id: r.id, code: r.code, expiresAt: r.expiresAt }));
    view.at = new Date(now()).toISOString();
    mkdirSync(pageDir, { recursive: true, mode: 0o700 });
    // Only fixed messages and allowlisted data; no URL, ticket, cookie or key.
    writeFileSync(join(pageDir, "launcher.js"), "window.__OH_MY_AIHUB_LAUNCHER__ = " + JSON.stringify(view).replace(/</g, "\\u003c") + ";\n", { mode: 0o600 });
  }
  async function poll() {
    if (busy || stopped) return;
    busy = true;
    try {
      const latest = readOptions();
      if (latest !== undefined) raw = latest;
      const opts = parseLaunchOptions(raw, now());
      view.autoOpen = opts.autoOpen;
      // Only explicit official options approve one named pending request.
      // The server persists approval and retains consumed tombstones; repeated
      // observations must never revive an exchanged request.
      if (opts.approval && input.approvePairing) {
        // Pairing is an explicit alternate-browser entry. It must also consume
        // the once-only native welcome marker, so expiry of this approval does
        // not unexpectedly open the default browser two minutes later.
        if (!journal.firstEnableSeen && !corrupt) {
          journal = { ...journal, firstEnableSeen: true };
          writeJsonAtomic(journalFile, journal);
        }
        const accepted = input.approvePairing(opts.approval.id, opts.approval.code);
        view.approval = { id: opts.approval.id, accepted, at: new Date(now()).toISOString() };
      }
      const request = opts.request;
      const fresh = request && !journal.consumed.some((r) => r.nonce === request.nonce);
      const first = !journal.firstEnableSeen && autoDesktop && !opts.approval;
      // Consume before minting/opening: crashes can lose an attempt, never repeat it.
      if (first || fresh) {
        if (corrupt) {
          // Quarantine an uncertain current request, then allow a NEW explicit
          // click. Never replay whatever might have opened before corruption.
          journal = { version: 1, firstEnableSeen: true, consumed: request ? [{ nonce: request.nonce, expiresAt: request.expiresAt }] : [] };
          writeJsonAtomic(journalFile, journal);
          corrupt = false;
          view.requestNonce = request?.nonce ?? null;
          view.state = "failed"; view.message = "打开记录已修复；本次结果不明，未重复打开。请重新点打开控制台。"; publish(); return;
        }
        journal = { version: 1, firstEnableSeen: journal.firstEnableSeen || first || Boolean(fresh),
          consumed: journal.consumed.filter((r) => r.expiresAt > now()),
          last: { nonce: request?.nonce ?? null, ownerPid: process.pid, state: "attempting" } };
        if (fresh) journal.consumed.push({ nonce: request.nonce, expiresAt: request.expiresAt });
        // Bound journal while retaining all requests that could still be replayed.
        if (journal.consumed.length > 256) { view.state = "failed"; view.message = "打开请求过于频繁，请稍后重试。"; publish(); return; }
        writeJsonAtomic(journalFile, journal);
        if (fresh) view.requestNonce = request.nonce;
        if ((fresh || (first && opts.autoOpen && autoDesktop)) && desktop) {
          view.state = "attempting"; view.message = "正在请求本机默认浏览器打开控制台。"; publish();
          let ok = false;
          try { ok = await open(input.issueTicket()); } catch { /* never expose secret-bearing errors */ }
          view.state = ok ? "opened" : "failed";
          view.message = ok ? "已请求默认浏览器打开；这不代表页面已经显示或已登录。" : "浏览器未能打开。请检查默认浏览器后，再点打开控制台。";
        } else if (fresh && !desktop) {
          view.state = "unavailable"; view.message = "此宿主不在本机桌面中；不会在远端服务器上重试打开浏览器。";
        }
        if (journal.last) {
          journal.last.state = view.state === "ready" || view.state === "attempting" ? "unavailable" : view.state;
          writeJsonAtomic(journalFile, journal);
        }
      }
      publish();
    } catch {
      view.state = "failed"; view.message = "无法保存打开记录；未重试打开浏览器。";
      try { publish(); } catch { /* no unsafe retry */ }
    } finally { busy = false; }
  }
  publish();
  void poll();
  const timer = setInterval(() => { void poll(); }, input.pollMs ?? 500);
  timer.unref?.();
  return { stop() { stopped = true; clearInterval(timer); }, snapshot: () => ({ ...view, pendingPairings: view.pendingPairings.map((r) => ({ ...r })), approval: view.approval ? { ...view.approval } : null }), poll };
}
