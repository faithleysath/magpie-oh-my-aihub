#!/usr/bin/env bun
// Refuses a commit that carries a credential. Scans the repository (not only the
// plugin) for gateway keys, private keys, mnemonics and real network secrets.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repo = join(import.meta.dir, "..", "..");
// prototype/ is the archived Phase 0 experiment (explicitly not the product);
// its tests carry made-up keys for its own sidecar, never a Magpie credential.
const skipDirs = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "prototype", "out", "cache"]);
const skipFiles = new Set(["package-lock.json", "bun.lock", "status.js"]);

const patterns: { name: string; re: RegExp }[] = [
  { name: "gateway key", re: /\bsk-[A-Za-z0-9._-]{20,}\b/g },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "network secret", re: /network_secret\s*=\s*"(?!<|\$|\.\.\.)[^"]{8,}"/g },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/g },
  // A 32-byte hex private key **that is labelled as one**. A bare 64-hex value
  // is almost always a hash (the EasyTier pins, a tx id, a price version), so
  // flagging every one of them would make the scan useless noise. What a leak
  // actually looks like is a key next to the word that says it is a key.
  {
    name: "evm private key",
    re: /(?:private[ _-]?key|privkey|PRIVATE_KEY|secret[ _-]?key)\s*[:=]?\s*["'`]?(?:0x)?[0-9a-fA-F]{64}\b/gi,
  },
  {
    name: "evm private key in a keys file",
    re: /^\s*(?:0x)?[0-9a-fA-F]{64}\s*$/gm,
  },
];

/**
 * The published anvil/hardhat development keys. They are in every foundry
 * tutorial and control nothing, so a lab script may legitimately mention them;
 * a real key must still fail.
 */
const knownDevKeys = new Set([
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
]);

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
      if (name.startsWith("evm private key")) {
        const hex = /(?:0x)?[0-9a-fA-F]{64}/.exec(value)?.[0] ?? "";
        if (knownDevKeys.has(hex.replace(/^0x/, "").toLowerCase())) continue;
      }
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
