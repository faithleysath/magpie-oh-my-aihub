#!/usr/bin/env bun
/**
 * Package-content gate. Fails when a release tarball contains tests, docs,
 * lab files, generated page snapshots, secret-shaped filenames or gitleaks
 * findings, and when a tracked runtime file under page/ or console/ is missing
 * from the tarball (A/B UI work must not silently drop static assets).
 *
 * `--selftest` (on by default) proves the checker is not vacuous.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const pluginRoot = join(repoRoot, "plugin");
const gitleaks = process.env.GITLEAKS_BIN || "gitleaks";

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "node_modules", re: /(?:^|\/)node_modules\// },
  { name: "test file", re: /\.(?:test|spec)\.(?:js|ts|mjs|cjs)$/ },
  { name: "test/lab/docs directory", re: /(?:^|\/)(?:test|tests|__tests__|lab|docs)\// },
  { name: "generated page snapshot", re: /(?:^|\/)page\/(?:status|options|launcher)\.js$/ },
  { name: "secret-shaped file", re: /\.(?:env|pem|key|log|sqlite|sqlite3|db)$/i },
  { name: "keystore/mnemonic file", re: /(?:^|\/)(?:keystore|mnemonic)[^/]*$/i },
  { name: "nested archive", re: /\.(?:tgz|tar\.gz|zip)$/ },
];

const REQUIRED_ROOT = [
  "package.json",
  "README.md",
  "plugin/package.json",
  "plugin/src/index.ts",
  "plugin/bin/ohmyaihub.ts",
  "plugin/console/index.html",
  "plugin/console/app.js",
  "plugin/console/providers.js",
  "plugin/console/session.js",
  "plugin/console/style.css",
  "plugin/console/wallet.js",
  "plugin/page/index.html",
  "plugin/page/app.js",
  "plugin/page/settings.js",
  "plugin/page/style.css",
  "plugin/page/icon.svg",
];
const REQUIRED_PLUGIN = REQUIRED_ROOT.filter((p) => p.startsWith("plugin/")).map((p) => p.slice("plugin/".length));

export function checkEntries(entries: string[], required: string[]): void {
  const files = entries.filter((e) => !e.endsWith("/"));
  for (const entry of files) {
    const rel = entry.startsWith("package/") ? entry.slice("package/".length) : entry;
    for (const rule of FORBIDDEN) {
      if (rule.re.test(rel)) throw new Error(`forbidden ${rule.name} in tarball: ${rel}`);
    }
  }
  const set = new Set(files.map((e) => (e.startsWith("package/") ? e.slice("package/".length) : e)));
  const missing = required.filter((p) => !set.has(p));
  if (missing.length > 0) throw new Error(`required runtime file(s) missing from tarball: ${missing.join(", ")}`);
}

function run(cmd: string[], cwd: string): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function relevantTrackedFiles(): { root: string[]; plugin: string[] } {
  const listing = run(["git", "ls-files", "plugin/page", "plugin/console"], repoRoot);
  if (listing.code !== 0) throw new Error(`git ls-files failed: ${listing.err}`);
  const tracked = listing.out.split("\n").map((l) => l.trim()).filter(Boolean);
  const runtime = tracked.filter(
    (p) => !/\.(?:test|spec)\.(?:js|ts|mjs|cjs)$/.test(p) && !/^plugin\/page\/(?:status|options|launcher)\.js$/.test(p),
  );
  return { root: runtime, plugin: runtime.map((p) => p.slice("plugin/".length)) };
}

function selftest(): void {
  const valid = ["package/package.json", "package/console/app.js", "package/page/style.css", "package/page/index.html"];
  checkEntries(valid, ["console/app.js", "page/style.css"]);
  const cases: Array<[string, string[]]> = [
    ["test file", ["package/console/wallet.test.js"]],
    ["docs", ["package/docs/evidence.json"]],
    ["generated snapshot", ["package/page/status.js"]],
    ["secret-shaped", ["package/plugin/.env"]],
    ["node_modules", ["package/node_modules/x/index.js"]],
  ];
  for (const [name, entries] of cases) {
    let threw = false;
    try {
      checkEntries(entries, []);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`selftest: the gate did not reject ${name}`);
  }
  let missingThrew = false;
  try {
    checkEntries(valid, ["page/stickers.svg"]);
  } catch {
    missingThrew = true;
  }
  if (!missingThrew) throw new Error("selftest: the gate did not reject a missing static asset");
  console.log("pack-check selftest PASS: 5 forbidden cases and 1 missing asset rejected");
}

function checkPack(label: string, cwd: string, required: string[], tracked: string[]): void {
  const work = mkdtempSync(join(tmpdir(), `pack-check-${label}-`));
  try {
    const packed = run(["bun", "pm", "pack", "--ignore-scripts", "--destination", work], cwd);
    if (packed.code !== 0) throw new Error(`${label}: bun pm pack failed: ${packed.err || packed.out}`);
    const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`${label}: bun pm pack produced no tarball`);
    const tarball = join(work, tgz);
    const listed = run(["tar", "-tzf", tarball], work);
    if (listed.code !== 0) throw new Error(`${label}: tar -tzf failed: ${listed.err}`);
    const entries = listed.out.split("\n").map((l) => l.trim()).filter(Boolean);
    checkEntries(entries, required);
    const files = entries.filter((e) => !e.endsWith("/"));
    const present = new Set(files.map((e) => (e.startsWith("package/") ? e.slice("package/".length) : e)));
    const dropped = tracked.filter((p) => !present.has(p));
    if (dropped.length > 0) throw new Error(`${label}: tracked runtime file(s) dropped from the package: ${dropped.join(", ")}`);

    const extracted = join(work, "extract");
    mkdirSync(extracted);
    const untar = run(["tar", "-xzf", tarball, "-C", extracted], work);
    if (untar.code !== 0) throw new Error(`${label}: tar -xzf failed: ${untar.err}`);
    const scan = run(
      [gitleaks, "dir", ".", "--config", join(repoRoot, ".gitleaks.toml"), "--redact", "--no-banner", "--exit-code", "1"],
      extracted,
    );
    if (scan.code !== 0) throw new Error(`${label}: secret scan of the tarball failed: ${scan.err || scan.out}`);

    const size = (statSync(tarball).size / 1024).toFixed(1);
    console.log(`pack-check PASS (${label}): ${files.length} files, ${size} KiB, no tests/docs/secrets, static assets complete`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (Bun.argv.includes("--selftest")) selftest();
const tracked = relevantTrackedFiles();
checkPack("root", repoRoot, REQUIRED_ROOT, tracked.root);
checkPack("plugin", pluginRoot, REQUIRED_PLUGIN, tracked.plugin);
