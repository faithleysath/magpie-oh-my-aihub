// Real index and real kernel-backed host lock; external services only are fixtures.
import { mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const src = resolve(import.meta.dir, "../../src");
const mode = process.argv[2];
const dir = process.cwd();
let parent = process.ppid;
Object.defineProperty(process, "ppid", { get: () => parent });
const calls: string[] = [];
mock.module(join(src, "paths.ts"), () => ({ statePath: (...p: string[]) => join(dir, ...p), stateDir: () => dir,
  pluginRoot: () => dir, magpieDataDir: () => dir, resolveMagpieBin: () => "/fixture/magpie" }));
mock.module(join(src, "log.ts"), () => ({ redact: (s: string) => s, logger: { info() {}, warn() {}, error() {} } }));
mock.module(join(src, "magpie.ts"), () => ({ Magpie: class { version() { return "fixture"; } } }));
mock.module(join(src, "easytier.ts"), () => ({ ownsProcess: () => false }));
mock.module(join(src, "console-api.ts"), () => ({ CONSOLE_ACTIONS: [], consoleState: async () => ({}), consoleAction: async () => ({}) }));
const consoleFixture = () => {
  calls.push("console");
  return { port: 12346, issueTicket: () => "unused", pendingPairings: () => [], approvePairing: () => false, stop() {} };
};
mock.module(join(src, "console-server.ts"), () => ({
  startConsoleServer: consoleFixture,
  startConsoleServerWithFallback: () => ({ server: consoleFixture(), fallback: false }),
}));
mock.module(join(src, "console-launch.ts"), () => ({ readOwnPluginOptions: () => undefined, readConsolePort: () => undefined,
  saveConsolePort() {}, publishUnavailableLauncher() {}, startConsoleLauncher: () => ({ stop() {} }) }));
mock.module(join(src, "server.ts"), () => ({ startApi: () => { calls.push("api"); return { port: 12345, stop() {} }; } }));
let constructors = 0;
mock.module(join(src, "service.ts"), () => ({ Service: class {
  supervisor = { snapshot: () => ({ pid: null }) };
  constructor() { calls.push("construct"); constructors++; if (mode === "constructor" && constructors === 1) throw new Error("fixture constructor fail"); }
  config() { return null; }
  async start() {
    calls.push("start");
    if (mode === "pending-signal") { console.log("START_PENDING"); await new Promise(() => {}); }
    if (mode === "parent-during-start") parent = 1;
  }
  async stop() { calls.push("stop"); }
  writeSnapshot() {}
} }));
const { boot } = await import(join(src, "index.ts"));
const { acquireHostLock } = await import(join(src, "lock.ts"));
if (mode === "orphan") parent = 1;
let rejected = false;
try { await boot(); } catch { rejected = true; }
if (mode === "constructor") await boot();
const owner = acquireHostLock();
console.log(JSON.stringify({ mode, rejected, calls, lockAvailable: owner !== null, lockExists: existsSync(join(dir, "host.lock")) }));
owner?.release();
process.exit(0);
