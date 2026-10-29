import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./paths.ts";

export interface HostLock {
  release: () => void;
}

/**
 * One plugin host owns a Magpie data directory.
 *
 * Magpie can leave a host running after the process that started it exits (a CLI
 * `magpie plugin add` starts one), and a second host must not run a second
 * EasyTier alongside the first or bind a second API. The lock file holds the
 * owner's pid; a stale one is taken over.
 */
export function acquireHostLock(): HostLock | null {
  const file = statePath("host.lock");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            if (existsSync(file) && readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
          } catch {
            /* best effort */
          }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw e;
      let pid = 0;
      try {
        pid = Number(readFileSync(file, "utf8").trim());
      } catch {
        /* unreadable: treat as stale */
      }
      if (pid > 0 && pid !== process.pid && alive(pid)) {
        // A host whose Magpie is gone (reparented to init) still holds the data
        // directory and its EasyTier; it is stale, and the new Magpie's host
        // takes over.
        if (parentOf(pid) > 1) return null;
        try {
          process.kill(pid, "SIGTERM");
          for (let i = 0; i < 30 && alive(pid); i++) Bun.sleepSync(50);
          if (alive(pid)) process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      try {
        unlinkSync(file);
      } catch {
        /* raced */
      }
    }
  }
  return null;
}

function parentOf(pid: number): number {
  const r = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
  const n = Number(r.stdout.toString().trim());
  return Number.isFinite(n) ? n : 0;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
