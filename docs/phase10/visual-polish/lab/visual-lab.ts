#!/usr/bin/env bun
/**
 * Phase 10 visual-polish lab: two isolated Magpie nodes on one host.
 *
 * Maintainer evidence only. It never touches the user's Magpie data, default
 * browser profile or port 3425: each node gets its own HOME and XDG_CONFIG_HOME
 * under a disposable root, its own copy of the app bundle, its own plugin copy,
 * mock OpenAI upstream, EasyTier core and console port.
 *
 *   bun docs/phase10/visual-polish/lab/visual-lab.ts [--root <dir>] [--keep]
 *
 * What it does: installs this worktree's plugin into both nodes, prices one
 * native mock model per node, joins both to one private overlay (A listens, B
 * connects), shares the model and publishes/discoveries the catalogue. It does
 * not approve anything, move money or run a chain; the browser step does the
 * zero-file request/approval against these nodes.
 *
 * Output (stdout, one JSON object): root, app/version, network name, per-node
 * console/api ports, listen addresses and PIDs. No secret or network key.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT_REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const ROOT = arg("root", `/tmp/ohmyaihub-visual-${process.pid}`);
const KEEP = process.argv.includes("--keep");
const MAGPIE_APP = arg("magpie", "/Applications/magpie.app");
const MAGPIE_BIN = join(MAGPIE_APP, "Contents", "MacOS", "magpie");
const PLUGIN = join(ROOT_REPO, "plugin");
const MOCK = join(ROOT_REPO, "docs", "validation", "lab", "phase8", "mock-upstream.ts");
const NETWORK = `visual-${createHash("sha256").update(`${process.pid}-${Date.now()}`).digest("hex").slice(0, 10)}`;
const SECRET = createHash("sha256").update(`secret-${process.pid}-${Date.now()}`).digest("hex").slice(0, 32);

interface Node {
  name: string;
  home: string;
  config: string;
  apiPort: number;
  consolePort: number;
  gatewayPort: number;
  listen: string;
  upstreamPort: number;
  model: string;
  pid?: number;
  upstreamPid?: number;
}

const nodes: Node[] = [
  { name: "provider", home: join(ROOT, "provider", "home"), config: join(ROOT, "provider", ".config"), apiPort: 34617, consolePort: 0, gatewayPort: 34311, listen: "tcp://127.0.0.1:11010", upstreamPort: 39011, model: "alpha-model" },
  { name: "consumer", home: join(ROOT, "consumer", "home"), config: join(ROOT, "consumer", ".config"), apiPort: 34618, consolePort: 0, gatewayPort: 34312, listen: "tcp://127.0.0.1:11011", upstreamPort: 39012, model: "beta-model" },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A loopback port nobody is listening on, starting at the preferred one. */
function freePort(preferred: number): number {
  for (let port = preferred; port < preferred + 40; port++) {
    const out = Bun.spawnSync(["bash", "-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`]).stdout.toString().trim();
    if (!out) return port;
  }
  throw new Error(`no free port near ${preferred}`);
}
function envOf(node: Node): Record<string, string> {
  // Each node needs its own gateway address; 3425 is the user's Magpie.
  return { ...process.env as Record<string, string>, HOME: node.home, XDG_CONFIG_HOME: node.config, MAGPIE_ADDR: `127.0.0.1:${node.gatewayPort}` };
}
/** Start a long-lived process with its output appended to a lab log. */
function start(node: Node, command: string, log: string): number {
  const child = Bun.spawn(["bash", "-c", `exec ${command} >> ${JSON.stringify(log)} 2>&1`], { cwd: dataDir(node), env: envOf(node) });
  return child.pid;
}
function dataDir(node: Node): string {
  return join(node.config, "magpie");
}
function run(node: Node, bin: string, args: string[], timeoutMs = 120_000): { code: number; out: string; err: string } {
  const result = Bun.spawnSync([bin, ...args], { cwd: dataDir(node), env: envOf(node), timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? 1, out: result.stdout.toString(), err: result.stderr.toString() };
}
async function waitFor(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = String(error); }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last}` : ""}`);
}
async function http(url: string, init?: RequestInit): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function killTree(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

async function main(): Promise<void> {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const appCopy = join(ROOT, "Magpie.app");
  const copied = Bun.spawnSync(["cp", "-R", MAGPIE_APP, appCopy]);
  if (copied.exitCode !== 0) throw new Error("could not copy the app bundle");
  // A copy with the installed bundle id can hand a launch over to the user's
  // running Magpie. Give the lab copy its own identity and an ad-hoc signature.
  Bun.spawnSync(["plutil", "-replace", "CFBundleIdentifier", "-string", "dev.local.omavisual.lab", join(appCopy, "Contents", "Info.plist")]);
  Bun.spawnSync(["plutil", "-replace", "CFBundleName", "-string", "Magpie Visual Lab", join(appCopy, "Contents", "Info.plist")]);
  Bun.spawnSync(["codesign", "--force", "--deep", "--sign", "-", appCopy]);
  const version = Bun.spawnSync([MAGPIE_BIN, "--version"]).stdout.toString().trim().split("\n").pop();

  for (const node of nodes) {
    node.gatewayPort = freePort(node.gatewayPort);
    node.apiPort = freePort(node.apiPort);
    node.upstreamPort = freePort(node.upstreamPort);
    mkdirSync(node.home, { recursive: true });
    mkdirSync(join(node.config, "magpie"), { recursive: true });
    node.upstreamPid = Bun.spawn(["bash", "-c", `exec env PORT=${node.upstreamPort} UPSTREAM_NAME=${node.name} MODELS=${node.model} bun ${JSON.stringify(MOCK)} >> ${JSON.stringify(join(ROOT, `${node.name}-upstream.log`))} 2>&1`], { cwd: ROOT, env: process.env as Record<string, string> }).pid;
    await waitFor(`${node.name} upstream`, async () => (await http(`http://127.0.0.1:${node.upstreamPort}/v1/models`)).status === 200, 20_000);

    const add = run(node, join(appCopy, "Contents", "MacOS", "magpie"), ["plugin", "add", PLUGIN], 180_000);
    const pluginsFile = join(dataDir(node), "plugins.json");
    const listed = existsSync(pluginsFile) && (JSON.parse(readFileSync(pluginsFile, "utf8")).plugins ?? []).some((entry: any) => entry.spec === PLUGIN);
    if (!listed) throw new Error(`${node.name}: plugin add failed: ${(add.err || add.out).slice(0, 400)}`);
    // Pin a distinct host API port and keep the launcher from opening a browser.
    const list = JSON.parse(readFileSync(pluginsFile, "utf8"));
    for (const entry of list.plugins) if (entry.spec === PLUGIN) entry.options = { apiPort: node.apiPort, consoleLaunch: { autoOpen: false } };
    writeFileSync(pluginsFile, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
    // `plugin add` starts its own host; stop it so the serve process owns the lock.
    const lock = join(dataDir(node), "oh-my-aihub", "host.lock");
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (pid > 0) killTree(pid);
      await sleep(800);
      rmSync(lock, { force: true });
    }

    const magpie = join(appCopy, "Contents", "MacOS", "magpie");
    run(node, magpie, ["provider", "add", node.name, `url=http://127.0.0.1:${node.upstreamPort}/v1`, `responses=http://127.0.0.1:${node.upstreamPort}/v1`, `anthropic=http://127.0.0.1:${node.upstreamPort}`, `key=sk-test-${node.name}`, `models=${node.model}`, `name=${node.name}`]);
    run(node, magpie, ["model", "price", `${node.name}/${node.model}`, "1000,1000,0,0"]);

    node.pid = start(node, `${JSON.stringify(magpie)} serve`, join(ROOT, `${node.name}-serve.log`));
    await waitFor(`${node.name} host api`, async () => (await http(`http://127.0.0.1:${node.apiPort}/health`)).status === 200, 90_000);
  }

  const secretFile = join(ROOT, "network-secret");
  writeFileSync(secretFile, SECRET + "\n", { mode: 0o600 });
  const cli = join(PLUGIN, "bin", "ohmyaihub.ts");
  const provider = nodes[0]!;
  const consumer = nodes[1]!;
  const setupArgs = (node: Node, extra: string[]) => ["--data", dataDir(node), "setup", "--network", NETWORK, "--secret-file", secretFile, "--listen", node.listen, "--share", "--catalog-publish", "--catalog-discover", "--share-models", `${node.name}/${node.model}`, ...extra];
  // The gateway is loopback-only in the lab; the LAN probe would fail a check
  // that does not apply here. This is the documented isolated-fixture switch.
  const env = { ...process.env as Record<string, string>, OH_MY_AIHUB_MAGPIE: join(appCopy, "Contents", "MacOS", "magpie"), OH_MY_AIHUB_PREFLIGHT_LAN: "none" };
  const setup = (node: Node, extra: string[]) => Bun.spawnSync(["bun", cli, ...setupArgs(node, extra)], { cwd: dataDir(node), env: { ...env, ...envOf(node) }, timeout: 240_000, stdout: "pipe", stderr: "pipe" });
  // `setup` exits 1 when a preflight check fails even though it applied the
  // configuration. The lab gateway is loopback-only and answers without a key,
  // so the key-required probe fails by design here; a configured state is the
  // condition this lab needs. The failing check is recorded, not hidden.
  const warnings: Record<string, string[]> = {};
  const apply = (node: Node, extra: string[]) => {
    const result = setup(node, extra);
    const output = result.stdout.toString() + result.stderr.toString();
    warnings[node.name] = output.split("\n").filter((line) => /FAIL|BLOCKER|warning/.test(line)).map((line) => line.trim().slice(0, 200));
    const stateFile = join(dataDir(node), "oh-my-aihub", "state.json");
    let configured = false;
    try { configured = Boolean(JSON.parse(readFileSync(stateFile, "utf8")).config?.networkName); } catch { /* absent */ }
    if (!configured) throw new Error(`${node.name} setup did not configure: ${output.slice(-1200)}`);
  };
  apply(provider, []);
  apply(consumer, ["--peer", provider.listen]);

  // Console ports are allocated by the plugin and saved per node.
  await waitFor("console ports", () => nodes.every((node) => existsSync(join(dataDir(node), "oh-my-aihub", "console-port.json"))), 120_000);
  for (const node of nodes) node.consolePort = JSON.parse(readFileSync(join(dataDir(node), "oh-my-aihub", "console-port.json"), "utf8")).port;

  const report = {
    schema: "ohmyaihub-phase10-visual-lab/v1",
    at: new Date().toISOString(),
    root: ROOT,
    platform: { os: process.platform, arch: process.arch },
    magpie: { version, binarySha256: createHash("sha256").update(readFileSync(join(appCopy, "Contents", "MacOS", "magpie"))).digest("hex"), isolatedCopy: appCopy },
    network: NETWORK,
    setupWarnings: warnings,
    nodes: nodes.map((node) => ({
      name: node.name, home: node.home, config: node.config, apiPort: node.apiPort, consolePort: node.consolePort, gatewayPort: node.gatewayPort,
      listen: node.listen, upstreamPort: node.upstreamPort, model: `${node.name}/${node.model}`, pid: node.pid, upstreamPid: node.upstreamPid,
    })),
    keep: KEEP,
  };
  writeFileSync(join(ROOT, "lab.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.error("lab left running for the browser step; stop it with the cleanup script");
  // The serve/upstream children must outlive this script; do not wait on them.
  process.exit(0);
}

await main();
