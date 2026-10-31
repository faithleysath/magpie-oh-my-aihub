#!/usr/bin/env bun
/**
 * Windows CI gate. Runs the explicit test files passed after `--` with the
 * offline preload, then asserts the real console summary: non-zero executed
 * tests, zero failures, and only the four reviewed skips. It also writes a
 * summary file for the artifact because Bun 1.4.3 on win32 does not emit the
 * JUnit file (`--reporter=junit --reporter-outfile=...` produced no file in
 * runs 41159217309 / 41159363198).
 */
import { appendFileSync, writeFileSync } from "node:fs";

// The measured curated subset floor. test/provisioner.test.ts hangs before its
// first test on the Windows runner and is a documented platform gap, not a pass.
const MIN_EXECUTED = 360;
const ASSERTIONS = /(\d+)\s+expect\(\)\s+calls/;
const lineCount = (word: string): number => {
  const m = new RegExp(`^\\s*(\\d+)\\s+${word}\\s*$`, "m").exec(text);
  return m ? Number(m[1]) : -1;
};
const ALLOWED_SKIPS = [
  "finds an existing magpie on this host",
  "a relative parent path is resolved against the parent's own cwd",
  "browser pairing survives official approval restart through real handler + launcher, never revives old session or opens browser",
  "real handler only creates a new instance session after explicit approval survives host restart",
];

const args = Bun.argv.slice(2);
if (args[0] === "--") args.shift();
const files = args;
if (process.platform !== "win32") {
  console.error(`this gate only runs on win32 (this is ${process.platform})`);
  process.exit(1);
}
if (files.length === 0) {
  console.error("usage: bun run scripts/run-windows-subset.ts -- <test files...>");
  process.exit(2);
}

const proc = Bun.spawn({
  cmd: ["bun", "test", "--preload", "./scripts/offline-guard.ts", "--timeout", "30000", ...files],
  cwd: `${import.meta.dir}/..`,
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const text = stripAnsi(stdout + "\n" + stderr);
process.stdout.write(text);

const runSummary = /Ran\s+(\d+)\s+tests\s+across\s+(\d+)\s+files/.exec(text);
if (!runSummary) {
  console.error("FAIL: could not read the bun test summary (no tests executed, crash, or truncated output)");
  process.exit(1);
}
const pass = lineCount("pass");
const skip = Math.max(0, lineCount("skip"));
const failures = lineCount("fail");
const total = Number(runSummary[1]);
const ranFiles = Number(runSummary[2]);
if (pass < 0 || failures < 0) {
  console.error("FAIL: the bun test summary has no pass/fail line");
  process.exit(1);
}
const assertions = Number(ASSERTIONS.exec(text)?.[1] ?? 0);
const skipped = [...new Set([...text.matchAll(/^\(skip\)\s+(.+)$/gm)].map((m) => m[1]!.trim()))];
const unexpected = skipped.filter((name) => !ALLOWED_SKIPS.some((allowed) => name.endsWith(allowed)));

const problems: string[] = [];
if (code !== 0) problems.push(`bun test exited ${code}`);
if (failures !== 0) problems.push(`${failures} tests failed`);
if (pass < MIN_EXECUTED) problems.push(`only ${pass} tests passed, expected at least ${MIN_EXECUTED}`);
if (total !== pass + skip + failures) problems.push(`summary is inconsistent: ${total} total vs ${pass}+${skip}+${failures}`);
if (ranFiles !== files.length) problems.push(`${ranFiles} files ran, ${files.length} requested`);
if (skipped.length !== skip) problems.push(`${skip} skips reported but ${skipped.length} skip names parsed`);
if (unexpected.length > 0) problems.push(`unreviewed skips: ${unexpected.join(" | ")}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}

const summary = [
  "# Windows subset result",
  "",
  "| platform | files | tests | executed | assertions | failures | reviewed skips |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  `| ${process.platform}-${process.arch} | ${ranFiles} | ${total} | ${pass} | ${assertions} | 0 | ${skip} |`,
  "",
  "Reviewed skips (each is a POSIX-only gap, not a Windows pass):",
  "",
  ...skipped.map((name) => `- ${name}`),
  "",
].join("\n");
writeFileSync("windows-test-summary.md", summary);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
