import { closeSync, chmodSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { statePath } from "./paths.ts";

export interface HostLock { release: () => void }

/**
 * Kernel-backed SQLite exclusive transaction serializes owners and stale-file
 * cleanup. Crash/SIGKILL automatically releases it; no reclaim-directory mutex
 * can be abandoned. host.lock remains compatibility metadata: a live legacy
 * owner is never stolen or signalled. No PID is used to kill another process.
 */
export function acquireHostLock(file = statePath("host.lock")): HostLock | null {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const guardFile = `${file}.sqlite`;
  let guard: Database | undefined;
  try {
    guard = new Database(guardFile, { create: true });
    chmodSync(guardFile, 0o600);
    guard.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (e) {
    try { guard?.close(); } catch { /* no transaction */ }
    if (/locked|busy/i.test(String(e))) return null;
    throw e;
  }
  const releaseGuard = () => {
    try { guard!.exec("ROLLBACK"); } finally { guard!.close(); }
  };
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").trim();
      // An incomplete legacy lock may belong to a writer; fail closed.
      if (!/^\d+(?: [a-f0-9]{32})?$/.test(raw)) { releaseGuard(); return null; }
      const pid = Number(raw.split(" ")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || aliveOrUnknown(pid)) { releaseGuard(); return null; }
      unlinkSync(file);
    }
    const token = `${process.pid} ${randomBytes(16).toString("hex")}`;
    // Publish complete metadata with an atomic non-overwriting link. A crash
    // between open(wx) and write must not leave an empty permanent legacy lock.
    const staged = `${file}.${randomBytes(16).toString("hex")}.tmp`;
    const fd = openSync(staged, "wx", 0o600);
    try {
      try { writeSync(fd, token); } finally { closeSync(fd); }
      linkSync(staged, file);
    } finally { try { unlinkSync(staged); } catch { /* crash residue is inert */ } }
    let released = false;
    return { release() {
      if (released) return;
      released = true;
      try { if (readFileSync(file, "utf8").trim() === token) unlinkSync(file); } catch { /* gone */ }
      finally { releaseGuard(); }
    } };
  } catch (e) {
    releaseGuard();
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
}
function aliveOrUnknown(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Retired shared hosts drain for up to ten minutes (Magpie v0.1.2171). */
export async function waitForHostLock(input: {
  file?: string; timeoutMs?: number; intervalMs?: number; waiting?: () => void;
  stopped?: () => boolean;
} = {}): Promise<HostLock | null> {
  const deadline = Date.now() + (input.timeoutMs ?? 11 * 60 * 1000);
  do {
    if (input.stopped?.()) return null;
    const lock = acquireHostLock(input.file);
    if (lock) {
      if (input.stopped?.()) { lock.release(); return null; }
      return lock;
    }
    input.waiting?.();
    const left = deadline - Date.now();
    if (left <= 0 || input.stopped?.()) break;
    await Bun.sleep(Math.min(input.intervalMs ?? 500, left));
  } while (Date.now() <= deadline);
  return null;
}
