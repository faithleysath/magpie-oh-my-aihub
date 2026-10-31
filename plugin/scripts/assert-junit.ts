#!/usr/bin/env bun
/**
 * CI gate for the Windows subset: the JUnit report must show a real run on the
 * expected platform with failures=0 and skipped=0. A suite that skipped every
 * test, or a report from a different OS, must never look like a pass.
 */
import { appendFileSync } from "node:fs";

const [file, expectedPlatform, minTestsRaw, ...allowedSkipNames] = Bun.argv.slice(2);
if (!file || !expectedPlatform || !minTestsRaw) {
  console.error("usage: bun run scripts/assert-junit.ts <junit.xml> <platform> <min-executed-tests> [allowed-skip-title ...]");
  process.exit(2);
}
const minTests = Number(minTestsRaw);
if (!Number.isInteger(minTests) || minTests <= 0) {
  console.error(`invalid minimum test count: ${minTestsRaw}`);
  process.exit(2);
}
if (process.platform !== expectedPlatform) {
  console.error(`FAIL: the suite ran on ${process.platform}, expected ${expectedPlatform}`);
  process.exit(1);
}

const xml = await Bun.file(file).text();
const opening = /<testsuites\b([^>]*)>/.exec(xml)?.[1];
if (!opening) {
  console.error(`FAIL: ${file} has no <testsuites> summary`);
  process.exit(1);
}
const number = (name: string): number | null => {
  const m = new RegExp(`\\b${name}="(\\d+)"`).exec(opening);
  return m ? Number(m[1]) : null;
};
const tests = number("tests");
const failures = number("failures");
const errors = number("errors") ?? 0;
const skipped = number("skipped");
const assertions = number("assertions");
if (tests === null || failures === null || skipped === null) {
  console.error("FAIL: the JUnit summary is missing tests/failures/skipped counts");
  process.exit(1);
}
if (tests - skipped < minTests) {
  console.error(`FAIL: only ${tests - skipped} tests executed (${tests} total, ${skipped} skipped), expected at least ${minTests}`);
  process.exit(1);
}
if (failures !== 0 || errors !== 0) {
  console.error(`FAIL: ${failures} failures and ${errors} errors in ${file}`);
  process.exit(1);
}
const skippedNames = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*>\s*<skipped\b/g)].map((m) => m[1]!);
if (skippedNames.length !== skipped) {
  console.error(`FAIL: JUnit reports ${skipped} skipped tests but ${skippedNames.length} skipped cases were parsed; refusing to guess`);
  process.exit(1);
}
const unexpected = skippedNames.filter((name) => !allowedSkipNames.includes(name));
if (unexpected.length > 0) {
  console.error(`FAIL: unreviewed skipped tests on ${expectedPlatform}: ${unexpected.join(" | ")}`);
  process.exit(1);
}

const line = `${process.platform}: ${tests - skipped} executed (${tests} total, ${skipped} reviewed skips), ${assertions ?? "?"} assertions, 0 failures`;
console.log(`PASS: ${line}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "### Windows subset result",
      "",
      "| platform | tests | assertions | failures | skipped |",
      "| --- | --- | --- | --- | --- |",
      `| ${process.platform} | ${tests - skipped} | ${assertions ?? "?"} | 0 | ${skipped} reviewed |`,
      "",
    ].join("\n"),
  );
}
