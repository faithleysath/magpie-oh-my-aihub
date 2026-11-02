// The root daemon that can give EasyTier a TUN device.
//
// A process running as the user cannot create a device, and the plugin never asks
// for root. Instead macOS gets one LaunchDaemon, installed once behind the
// system's administrator prompt, which runs `easytier-core` as root from a copy
// of the plugin's config (`plugin/scripts/omai-easytier-daemon.sh`). After that
// the plugin only writes `current.toml`: the daemon notices the hash change and
// restarts the core, so no further privilege is ever needed.
//
// `install` and `uninstall` are the only places that ask for a password, and they
// do it through `osascript ... with administrator privileges`, which is the
// standard macOS admin sheet. It needs a graphical session: over SSH it fails and
// says so rather than hanging.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "./paths.ts";
import { run } from "./run.ts";

export const DAEMON_LABEL = "dev.omai.easytier";
export const DAEMON_PLIST = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;
export const DAEMON_WRAPPER = "/usr/local/libexec/omai-easytier-daemon";
/** Where the root side keeps its copy of the config, the core's log, its own log. */
export const DAEMON_STATE_DIR = "/var/run/omai-easytier";

export interface DaemonStatus {
  /** the LaunchDaemon plist is in place */
  installed: boolean;
  /** launchd reports the job loaded (it may still be starting) */
  loaded: boolean;
  label: string;
  plist: string;
  wrapper: string;
  detail: string | null;
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

/** The wrapper shipped inside the plugin, copied to a root-owned path on install. */
export function wrapperSource(): string {
  return join(import.meta.dir, "..", "scripts", "omai-easytier-daemon.sh");
}

/**
 * `launchctl print system/<label>` is the honest question: a plist on disk tells
 * nothing about whether launchd accepted it.
 */
export function daemonLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const r = Bun.spawnSync(["launchctl", "print", `system/${DAEMON_LABEL}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

export function daemonStatus(): DaemonStatus {
  const installed = existsSync(DAEMON_PLIST);
  const loaded = daemonLoaded();
  return {
    installed,
    loaded,
    label: DAEMON_LABEL,
    plist: DAEMON_PLIST,
    wrapper: DAEMON_WRAPPER,
    detail: loaded
      ? null
      : installed
        ? "installed but not loaded: run launchctl bootstrap system, or install again"
        : "not installed: TUN needs the daemon (or root)",
  };
}

/** The LaunchDaemon launchd will run. Paths are fixed; nothing here is user input. */
export function renderPlist(core: string, config: string, rpc: string): string {
  const args = [DAEMON_WRAPPER, config, core, rpc]
    .map((value) => `    <string>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/** POSIX single-quote a value; a quote inside becomes `'\''`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A double-quoted AppleScript string literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Runs a script as root through the standard admin sheet. The script lives in the
 * plugin's own directory (0700, this user only), which is the same trust boundary
 * as the plugin itself.
 */
async function runAsRoot(body: string, label: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("E_PLATFORM: the root daemon is a macOS mechanism");
  const dir = statePath("easytier");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${label}.sh`);
  writeFileSync(file, body, { mode: 0o700 });
  chmodSync(file, 0o700);
  try {
    // `quoted form of` asks AppleScript for a shell-safe path, so spaces, quotes
    // and `$` in a user's data directory cannot become shell syntax.
    const script = `do shell script "/bin/sh " & quoted form of ${appleScriptString(file)} with administrator privileges`;
    const r = await run(["osascript", "-e", script], { timeoutMs: 180_000 });
    if (r.code !== 0) {
      const message = shortError(r.stderr || r.stdout);
      // -128 is the user closing the sheet; say that plainly.
      if (/-128|User canceled/i.test(message)) throw new Error("E_CANCELLED: the administrator prompt was dismissed");
      throw new Error(`E_ROOT: ${message}`);
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Installs the daemon and starts it. Idempotent: re-running replaces the wrapper
 * and the plist, then kicks the job.
 */
export async function installDaemon(core: string, config: string, rpc: string): Promise<void> {
  const src = wrapperSource();
  if (!existsSync(src)) throw new Error(`E_PATH: the plugin's daemon script is missing: ${src}`);
  const dir = statePath("easytier");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plistTmp = join(dir, `${DAEMON_LABEL}.plist`);
  writeFileSync(plistTmp, renderPlist(core, config, rpc), { mode: 0o644 });

  const body = `#!/bin/sh
set -eu
install -d -m 0755 /usr/local/libexec
install -m 0755 -o root -g wheel ${shQuote(src)} ${shQuote(DAEMON_WRAPPER)}
install -m 0644 -o root -g wheel ${shQuote(plistTmp)} ${shQuote(DAEMON_PLIST)}
mkdir -p ${shQuote(DAEMON_STATE_DIR)}
chmod 700 ${shQuote(DAEMON_STATE_DIR)}
# launchd answers EIO when a previous job of the same label is still going away,
# so replacing a running daemon needs a retry rather than a single attempt.
launchctl bootout system/${DAEMON_LABEL} 2>/dev/null || true
i=0
while [ "$i" -lt 10 ]; do
  if launchctl bootstrap system ${shQuote(DAEMON_PLIST)} 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 1
done
launchctl enable system/${DAEMON_LABEL} || true
launchctl kickstart -k system/${DAEMON_LABEL} || true
`;
  await runAsRoot(body, "install-daemon");
}

/** Stops the job and removes the wrapper, the plist and the root-side state. */
export async function uninstallDaemon(): Promise<void> {
  const body = `#!/bin/sh
set -eu
launchctl bootout system/${DAEMON_LABEL} 2>/dev/null || true
rm -f ${shQuote(DAEMON_PLIST)} ${shQuote(DAEMON_WRAPPER)}
rm -rf ${shQuote(DAEMON_STATE_DIR)}
`;
  await runAsRoot(body, "uninstall-daemon");
}
