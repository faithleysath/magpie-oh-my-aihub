#!/usr/bin/env bun
// Starts the plugin entry the way Magpie does, in an isolated directory, and
// checks that the host comes up and answers. No real Magpie, no user config,
// no network: the binary is a stub and the data directory is temporary.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ohmyaihub-boot-"));
const home = join(root, "home");
const data = join(root, "data");
const bin = join(root, "bin", "magpie");
mkdirSync(home, { recursive: true });
mkdirSync(data, { recursive: true });
mkdirSync(join(root, "bin"), { recursive: true });
writeFileSync(bin, '#!/bin/sh\necho "magpie 0.1.2038"\n');
chmodSync(bin, 0o755);

process.env.HOME = home;
process.env.OH_MY_AIHUB_MAGPIE = bin;
process.env.MAGPIE_ADDR = "127.0.0.1:34999";
process.chdir(data);

const fail: (m: string) => never = (m) => {
  console.error(`boot-check FAIL: ${m}`);
  process.exit(1);
};

const entry = await import("../src/index.ts").catch((e) => fail(`import: ${String(e)}`));
const started = (entry.default as (input: unknown, options: unknown) => Record<string, never>)({}, {});
if (!started || typeof started !== "object") fail("the default export did not return an object");

const portFile = join(data, "oh-my-aihub", "api-port");
let port = "";
for (let i = 0; i < 100; i++) {
  if (existsSync(portFile)) {
    port = readFileSync(portFile, "utf8").trim();
    if (port) break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!port) fail("the host API never wrote its port file");

const base = `http://127.0.0.1:${port}`;
const tokenFile = join(data, "oh-my-aihub", "api-token");
if (!existsSync(tokenFile)) fail("no api-token file");
const token = readFileSync(tokenFile, "utf8").trim();
if (token.length < 32) fail("the api-token is too short");
if (process.platform !== "win32" && (statSync(tokenFile).mode & 0o777) !== 0o600) {
  fail(`api-token is mode ${(statSync(tokenFile).mode & 0o777).toString(8)}, expected 600`);
}
const auth = { authorization: `Bearer ${token}` };

// Health is the only anonymous route, and it says nothing.
const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).catch((e) => fail(`GET /health: ${String(e)}`));
if (health.status !== 200) fail(`GET /health answered ${health.status}`);
if (JSON.stringify(await health.json()) !== '{"ok":true}') fail("GET /health is not the minimal body");

// A read without the token must be refused, including the status and the wallet.
const anonymous = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2000) });
if (anonymous.status !== 401) fail(`anonymous GET /status answered ${anonymous.status}, expected 401`);

let status: any;
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`${base}/status`, { headers: auth, signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      status = await res.json();
      break;
    }
  } catch {
    /* still starting */
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!status) fail("GET /status with the token did not answer");
if (typeof status.plugin?.version !== "string") fail("status has no plugin version");
if (!String(status.magpie?.gateway).includes("34999")) fail(`unexpected gateway ${status.magpie?.gateway}`);
if (!Array.isArray(status.easytier?.peers)) fail("status has no peers array");

const checks = await fetch(`${base}/checks`, { headers: auth, signal: AbortSignal.timeout(5000) });
if (!checks.ok) fail(`GET /checks answered ${checks.status}`);
const checksBody: unknown = await checks.json();
const checkList = (checksBody as { checks?: unknown })?.checks;
if (!Array.isArray(checkList)) fail("checks did not return a list");
const checkCount = checkList.length;

// A mutation without the token must be refused too.
const denied = await fetch(`${base}/configure`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ role: "provider" }),
});
if (denied.status !== 401) fail(`unauthenticated /configure answered ${denied.status}, expected 401`);

// The page snapshot is the allowlisted projection: 0600, a schema marker, and
// none of the fields that would publish balances, addresses, paths or logs.
const pageStatus = join(import.meta.dir, "..", "page", "status.js");
let waited = 0;
while (!existsSync(pageStatus) && waited < 5000) {
  await new Promise((r) => setTimeout(r, 100));
  waited += 100;
}
if (!existsSync(pageStatus)) fail("the host never wrote page/status.js");
if (process.platform !== "win32" && (statSync(pageStatus).mode & 0o777) !== 0o600) {
  fail(`page/status.js is mode ${(statSync(pageStatus).mode & 0o777).toString(8)}, expected 600`);
}
const snapshot = readFileSync(pageStatus, "utf8");
if (!snapshot.includes('"schema":"oh-my-aihub/page/2"')) fail("page/status.js has no page schema marker");
for (const banned of ['"dataDir"', '"logs"', '"payerAddress"', '"endpoints"', '"intents"']) {
  if (snapshot.includes(banned)) fail(`page/status.js still carries ${banned}`);
}

// The user's real config must be untouched.
if (existsSync(join(home, ".pi"))) fail("the boot test wrote into the home directory");

console.log(
  `boot-check PASS: plugin ${status.plugin.version}, magpie ${status.magpie.version}, api ${port}, checks ${checkCount}, page snapshot 0600`,
);
process.exit(0);
