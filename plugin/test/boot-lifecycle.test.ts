import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const probe = join(import.meta.dir, "support/boot-lifecycle-probe.ts");
async function isolated(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "hub-lifecycle-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function run(dir: string, mode: string) {
  const c = Bun.spawn([process.execPath, probe, mode], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [text, err, code] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text(), c.exited]);
  if (code !== 0) throw new Error(err + text);
  return JSON.parse(text.trim());
}
test("Service constructor failure releases real lock and same-process second boot succeeds", () => isolated(async dir => {
  const r = await run(dir, "constructor");
  expect(r.rejected).toBe(true); expect(r.calls).toEqual(["construct", "construct", "start", "api", "console"]);
  expect(existsSync(join(dir, "host.lock"))).toBe(false);
}));
test("already orphaned host cannot acquire or construct Service", () => isolated(async dir => {
  const r = await run(dir, "orphan"); expect(r.rejected).toBe(true); expect(r.calls).toEqual([]); expect(r.lockAvailable).toBe(true);
}));
test("parent loss while awaiting start aborts before API/console and stops partial service", () => isolated(async dir => {
  const r = await run(dir, "parent-during-start"); expect(r.rejected).toBe(true);
  expect(r.calls).toEqual(["construct", "start", "stop"]); expect(r.lockAvailable).toBe(true);
}));
test("SIGTERM while Service.start is pending releases ownership via early exit guard", () => isolated(async dir => {
  const c = Bun.spawn([process.execPath, probe, "pending-signal"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const reader = c.stdout.getReader();
  let text = "";
  while (!text.includes("START_PENDING")) {
    const r = await reader.read(); if (r.done) throw new Error("probe exited before pending start"); text += new TextDecoder().decode(r.value);
  }
  c.kill("SIGTERM"); expect(await c.exited).toBe(0);
  expect(existsSync(join(dir, "host.lock"))).toBe(false);
}));
