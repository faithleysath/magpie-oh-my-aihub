#!/usr/bin/env bun
/**
 * Proves the gitleaks policy is not vacuous.
 *
 * Real-looking synthetic secrets are generated at runtime (nothing secret is
 * committed) and planted in docs/ and production-like paths. They must be
 * reported even though the repository's own evidence files are allowlisted.
 * Public identifiers (EVM addresses, manifest digests, the one lab fixture)
 * must stay quiet, and every allowlist entry is checked to be rule-scoped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const config = join(repoRoot, ".gitleaks.toml");
const gitleaks = process.env.GITLEAKS_BIN || "gitleaks";

function fail(message: string): never {
  console.error(`gitleaks self-test FAIL: ${message}`);
  process.exit(1);
}

const randomAlnum = (n: number): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
};
const randomHex = (bytes: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const fakeSk = (): string => `sk-${randomAlnum(5)}-${randomAlnum(5)}-${randomAlnum(5)}-${randomAlnum(5)}`;
const fakePem = (): string => {
  // Built at runtime on purpose: this file must never contain key material.
  const header = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
  const footer = ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");
  const body = Buffer.from(crypto.getRandomValues(new Uint8Array(96)))
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trim();
  return `${header}\n${body}\n${footer}`;
};

function write(root: string, path: string, lines: string[]): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
}

const scanDir = mkdtempSync(join(tmpdir(), "gitleaks-selftest-"));
const reportDir = mkdtempSync(join(tmpdir(), "gitleaks-selftest-report-"));
const report = join(reportDir, "report.json");
try {
  // --- must be reported -----------------------------------------------------
  write(scanDir, "docs/validation/phase10-synthetic/leak.md", [`api_key = "${fakeSk()}"`]);
  write(scanDir, "plugin/oh-my-aihub/config.toml", [`network_secret = "${randomAlnum(40)}"`]);
  write(scanDir, "plugin/lab/private.pem", fakePem().split("\n"));
  write(scanDir, "plugin/src/notes.ts", [`const privateKey = "${randomHex(32)}";`]);
  // A 32-byte key accidentally written into a token field must be reported.
  write(scanDir, "plugin/src/token-64.ts", [`const tokenContract = "0x${randomHex(32)}";`]);
  // A legitimate 40-hex token must not swallow a 64-hex privateKey on the same line.
  write(scanDir, "plugin/src/token-mixed.ts", [
    `const token = "0x${randomHex(20)}"; const privateKey = "0x${randomHex(32)}";`,
  ]);
  // Non-allowlisted line in an allowlisted file: the allowlist is line-scoped.
  write(scanDir, "plugin/test/page-settings.test.ts", [
    `const x = { networkSecret: "${randomAlnum(40)}" };`,
    `const merged = S.mergeSaved(base, { networkSecret: "${randomAlnum(40)}" });`,
  ]);
  // .gitleaksignore entries are commit-scoped, so a worktree secret is caught.
  write(scanDir, "plugin/test/wallet-vault.test.ts", [`const VECTOR_12_PRIVATE_KEY = "${randomHex(32)}";`]);
  // The same digest line in another file is allowed by its line shape only.
  write(scanDir, "docs/validation/other/manifest.json", ["{", `  "auth-responses.json": "${randomHex(32)}"`, "}"]);
  // A line rule must not hide another secret on another line of that file.
  write(scanDir, "docs/validation/lab/phase8/journey.ts", [
    'const wrong = await http(`http://127.0.0.1:3410/v1/models`, { key: "' + fakeSk() + '", timeoutMs: 8000 });',
    ...fakePem().split("\n"),
  ]);
  // The curl placeholder allowlist is line-scoped, not file- or rule-wide.
  const curlLine = `Run \`curl -H 'Authorization: Bearer ${randomAlnum(26)}' http://127.0.0.1:38741/v1/models\`. This adapter forwards.`;
  write(scanDir, "prototype/phase0/README.md", [curlLine, `api_key = "${randomAlnum(40)}"`]);
  write(scanDir, "prototype/phase0/other.md", [
    `curl -H 'Authorization: Bearer ${randomAlnum(26)}' http://127.0.0.1:38741/v1/models`,
  ]);

  // --- must stay quiet ------------------------------------------------------
  write(scanDir, "README.md", [`tokenContract = "0x${randomHex(20)}"`]);
  write(scanDir, "docs/validation/phase7-twohost/manifest.json", [
    "{",
    `  "auth-responses.json": "${randomHex(32)}",`,
    `  "privateKey": "${randomHex(32)}"`,
    "}",
  ]);

  const expected = [
    "generic-api-key docs/validation/phase10-synthetic/leak.md:1",
    "generic-api-key plugin/oh-my-aihub/config.toml:1",
    "private-key plugin/lab/private.pem:1",
    "generic-api-key plugin/src/notes.ts:1",
    "generic-api-key plugin/src/token-64.ts:1",
    "generic-api-key plugin/src/token-mixed.ts:1",
    "generic-api-key plugin/test/page-settings.test.ts:1",
    "generic-api-key plugin/test/wallet-vault.test.ts:1",
    "generic-api-key docs/validation/phase7-twohost/manifest.json:3",
    "private-key docs/validation/lab/phase8/journey.ts:2",
    "curl-auth-header prototype/phase0/other.md:1",
    "generic-api-key prototype/phase0/README.md:2",
  ].sort();

  const proc = Bun.spawn({
    cmd: [gitleaks, "dir", ".", "--config", config, "--redact", "--no-banner", "--exit-code", "1", "--report-format", "json", "--report-path", report],
    cwd: scanDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (!(await Bun.file(report).exists())) fail(`gitleaks wrote no report (exit ${code}): ${stderr.slice(0, 300)}`);
  const findings = (await Bun.file(report).json()) as Array<{ RuleID: string; File: string; StartLine: number; Match?: string }>;
  if (code === 0) fail("planted secrets produced exit code 0");
  const actual = findings.map((f) => `${f.RuleID} ${f.File}:${f.StartLine}`).sort();
  const missing = expected.filter((e) => !actual.includes(e));
  const unexpected = actual.filter((a) => !expected.includes(a));
  if (missing.length > 0) fail(`not reported (policy too permissive or fixture missing): ${missing.join(", ")}`);
  if (unexpected.length > 0) fail(`unreviewed findings (policy too broad or false positive): ${unexpected.join(", ")}`);
  // File:line alone cannot distinguish two findings on one line; require the
  // privateKey finding itself, not just the token finding that is allowed.
  const mixed = findings.filter((f) => f.File === "plugin/src/token-mixed.ts");
  if (!mixed.some((f) => /privateKey/i.test(f.Match ?? ""))) {
    fail("same-line privateKey was swallowed by the token/tokenContract allowlist");
  }

  console.log(`gitleaks self-test PASS: ${expected.length} synthetic secrets reported, public fixtures quiet, rules stay scoped`);
} finally {
  rmSync(scanDir, { recursive: true, force: true });
  rmSync(reportDir, { recursive: true, force: true });
}
