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
let status: any;
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      status = await res.json();
      break;
    }
  } catch {
    /* still starting */
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!status) fail("GET /status did not answer");
if (typeof status.plugin?.version !== "string") fail("status has no plugin version");
if (!String(status.magpie?.gateway).includes("34999")) fail(`unexpected gateway ${status.magpie?.gateway}`);
if (!Array.isArray(status.easytier?.peers)) fail("status has no peers array");

const checks = await fetch(`${base}/checks`, { signal: AbortSignal.timeout(5000) });
if (!checks.ok) fail(`GET /checks answered ${checks.status}`);
const checksBody: unknown = await checks.json();
const checkList = (checksBody as { checks?: unknown })?.checks;
if (!Array.isArray(checkList)) fail("checks did not return a list");
const checkCount = checkList.length;

// The API token is a secret on disk.
const tokenFile = join(data, "oh-my-aihub", "api-token");
if (!existsSync(tokenFile)) fail("no api-token file");
if (process.platform !== "win32" && (statSync(tokenFile).mode & 0o777) !== 0o600) {
  fail(`api-token is mode ${(statSync(tokenFile).mode & 0o777).toString(8)}, expected 600`);
}

// A mutation without the token must be refused.
const denied = await fetch(`${base}/configure`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ role: "provider" }),
});
if (denied.status !== 401) fail(`unauthenticated /configure answered ${denied.status}, expected 401`);

// The user's real config must be untouched.
if (existsSync(join(home, ".pi"))) fail("the boot test wrote into the home directory");

console.log(
  `boot-check PASS: plugin ${status.plugin.version}, magpie ${status.magpie.version}, api ${port}, checks ${checkCount}`,
);
process.exit(0);
