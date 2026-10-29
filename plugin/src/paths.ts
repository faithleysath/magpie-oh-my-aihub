import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";

/** Magpie runs the plugin host with the settings directory as its working directory. */
export function magpieDataDir(): string {
  return process.cwd();
}

export function stateDir(): string {
  return join(magpieDataDir(), "oh-my-aihub");
}

export function statePath(...parts: string[]): string {
  return join(stateDir(), ...parts);
}

/** The plugin's own folder (the installed copy), used for the page snapshot. */
export function pluginRoot(): string {
  return join(import.meta.dir, "..");
}

/**
 * The magpie binary running this host.
 *
 * The host is a child of the magpie process, so its parent's executable is the
 * same binary with the same data directory (portable or installed). Falling back
 * to a path lookup keeps a manually started supervisor working too.
 */
export function resolveMagpieBin(): string {
  const override = process.env.OH_MY_AIHUB_MAGPIE;
  if (override && existsSync(override)) return override;

  if (process.platform === "linux") {
    try {
      const exe = readFileSync(`/proc/${process.ppid}/exe`); // symlink target
      const p = exe.toString().replace(/\0+$/, "");
      if (p) return p;
    } catch {
      /* not readable */
    }
  }

  if (process.platform === "darwin") {
    // The parent's argv[0] may be relative to the parent's working directory
    // (`./Magpie.app/Contents/MacOS/magpie serve` from a portable copy), so ask
    // lsof for that directory before trusting existsSync. Falling back to the
    // installed app here would silently manage another Magpie's data directory.
    try {
      const cmd = Bun.spawnSync(["ps", "-p", String(process.ppid), "-o", "command="]).stdout.toString().trim();
      const argv0 = cmd.split(/\s+/)[0] ?? "";
      if (argv0) {
        if (argv0.startsWith("/") && existsSync(argv0)) return argv0;
        const lsof = Bun.spawnSync(["lsof", "-a", "-p", String(process.ppid), "-d", "cwd", "-Fn"]).stdout.toString();
        const cwdLine = lsof.split("\n").find((l) => l.startsWith("n"));
        const cwd = cwdLine ? cwdLine.slice(1) : "";
        if (cwd) {
          const candidate = join(cwd, argv0);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
      /* ps/lsof unavailable */
    }
    const app = "/Applications/magpie.app/Contents/MacOS/magpie";
    if (existsSync(app)) return app;
  }

  try {
    const r = Bun.spawnSync(["which", "magpie"]);
    const p = r.stdout.toString().trim();
    if (p && existsSync(p)) return p;
  } catch {
    /* no PATH */
  }
  throw new Error("cannot locate the magpie binary (set OH_MY_AIHUB_MAGPIE)");
}

function isUsableIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 0 || parts[0] === 127) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return false; // proxy TUN ranges
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false; // CGNAT (VPN)
  return true;
}

/**
 * The provider address EasyTier exports. The plugin exports exactly this /32 by
 * default (never a whole subnet), so it must be the interface a consumer can
 * reach after the overla'.
 */
export function lanIPv4(): string {
  const preferred = /^(en0|en1|eth0|eth1|ens[0-9]|enp[0-9]|wlan0|Wi-?Fi)$/;
  const candidates: { name: string; ip: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!isUsableIPv4(a.address)) continue;
      candidates.push({ name, ip: a.address });
    }
  }
  if (candidates.length === 0) throw new Error("no usable LAN IPv4 address");
  candidates.sort((a, b) => Number(preferred.test(b.name)) - Number(preferred.test(a.name)));
  return candidates[0].ip;
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}
