import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireHostLock, waitForHostLock } from "../src/lock.ts";

async function isolated(run: (file: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "hub-lock-"));
  try { await run(join(dir, "host.lock")); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("exclusive token owner, legacy live pid and malformed locks fail closed without signalling", () => isolated((file) => {
  const a = acquireHostLock(file)!; expect(a).not.toBeNull();
  expect(acquireHostLock(file)).toBeNull();
  a.release(); a.release();
  writeFileSync(file, String(process.pid)); expect(acquireHostLock(file)).toBeNull();
  for (const bad of ["", "broken", "-1", "0"]) { writeFileSync(file, bad); expect(acquireHostLock(file)).toBeNull(); }
}));
test("old release never removes a different lock token", () => isolated((file) => {
  const a = acquireHostLock(file)!;
  writeFileSync(file, String(process.pid)); a.release(); expect(readFileSync(file, "utf8")).toBe(String(process.pid));
}));
test("dead owner is reclaimed, only one contender wins", () => isolated((file) => {
  writeFileSync(file, "99999999"); const a = acquireHostLock(file)!; expect(a).not.toBeNull();
  expect(acquireHostLock(file)).toBeNull(); a.release();
}));
test("standby waits and acquires after owner release; bounded timeout is retryable", () => isolated(async (file) => {
  const owner = acquireHostLock(file)!;
  const timed = await waitForHostLock({ file, timeoutMs: 10, intervalMs: 2 }); expect(timed).toBeNull();
  let waits = 0;
  const waiting = waitForHostLock({ file, timeoutMs: 200, intervalMs: 5, waiting: () => { waits++; owner.release(); } });
  const next = await waiting; expect(next).not.toBeNull(); expect(waits).toBe(1); next!.release();
}));
test("abandoned legacy reclaim directory cannot block a dead owner's recovery", () => isolated(file => {
  writeFileSync(file, "99999999"); mkdirSync(file + ".reclaim");
  const owner = acquireHostLock(file); expect(owner).not.toBeNull(); owner!.release();
}));
test("stopped standby does not acquire after owner releases", () => isolated(async file => {
  const owner = acquireHostLock(file)!; let stopped = false;
  const pending = waitForHostLock({ file, intervalMs: 2, timeoutMs: 100, stopped: () => stopped,
    waiting: () => { stopped = true; owner.release(); } });
  expect(await pending).toBeNull(); const fresh = acquireHostLock(file); expect(fresh).not.toBeNull(); fresh!.release();
}));
test("SIGKILL releases exclusive transaction and next owner recovers stale metadata", () => isolated(async file => {
  const module = join(import.meta.dir, "../src/lock.ts");
  const code = 'import {acquireHostLock} from ' + JSON.stringify(module) + '; const l=acquireHostLock(' + JSON.stringify(file) + '); console.log(l ? "owner" : "standby"); await Bun.sleep(60000);';
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader(); const ready = await reader.read(); expect(new TextDecoder().decode(ready.value)).toContain("owner");
  expect(acquireHostLock(file)).toBeNull(); child.kill("SIGKILL"); await child.exited;
  const next = acquireHostLock(file); expect(next).not.toBeNull(); next!.release();
}));
test("parallel processes race a stale owner safely", () => isolated(async (file) => {
  writeFileSync(file, "99999999");
  const module = join(import.meta.dir, "../src/lock.ts");
  const code = 'import {acquireHostLock} from ' + JSON.stringify(module) + '; const l=acquireHostLock(' + JSON.stringify(file) + '); console.log(l ? "owner" : "standby"); if(l){await Bun.sleep(300);l.release();}';
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }));
  const out = await Promise.all(children.map(async c => { const s = await new Response(c.stdout).text(); expect(await c.exited).toBe(0); return s.trim(); }));
  expect(out.filter(s => s === "owner")).toHaveLength(1);
}));
