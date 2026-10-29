#!/usr/bin/env bun
// Refuses a commit that carries a credential. Scans the repository (not only the
// plugin) for gateway keys, private keys, mnemonics and real network secrets.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repo = join(import.meta.dir, "..", "..");
// prototype/ is the archived Phase 0 experiment (explicitly not the product);
// its tests carry made-up keys for its own sidecar, never a Magpie credential.
const skipDirs = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "prototype"]);
const skipFiles = new Set(["package-lock.json", "bun.lock", "status.js"]);

const patterns: { name: string; re: RegExp }[] = [
  { name: "gateway key", re: /\bsk-[A-Za-z0-9._-]{20,}\b/g },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "network secret", re: /network_secret\s*=\s*"(?!<|\$|\.\.\.)[^"]{8,}"/g },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/g },
];

// Placeholders a rule may legitimately mention.
const allow = [/\bsk-magpie-key-…/, /\bsk-…/, /\bsk-test-/, /\bBearer\s+<[^>]+>\b/, /\bsk-<[^>]+>/];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name) || skipFiles.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.size < 2_000_000) yield p;
  }
}

const hits: string[] = [];
for (const file of walk(repo)) {
  if (!/\.(ts|js|json|toml|md|sh|yml|yaml|py|html|css)$/.test(file)) continue;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { name, re } of patterns) {
    for (const m of text.matchAll(re)) {
      const value = m[0];
      if (allow.some((a) => a.test(value))) continue;
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      hits.push(`${relative(repo, file)}:${line}: ${name}`);
    }
  }
}

if (hits.length) {
  console.error("secret-scan FAIL: potential credentials found\n" + hits.join("\n"));
  process.exit(1);
}
console.log("secret-scan PASS: no credentials in the working tree");
