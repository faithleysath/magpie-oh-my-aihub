// Runs the real plugin entry in a fresh process, replacing only external
// dependencies. Options parsing, decisions and disk records are production code.
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "../../src");
const fixture = JSON.parse(readFileSync(join(process.cwd(), "fixture.json"), "utf8"));
const calls: { method: string; patch?: Record<string, unknown> }[] = [];
let config: Record<string, unknown> | null = fixture.config;
const stateDir = () => join(process.cwd(), "oh-my-aihub");
mock.module(join(src, "paths.ts"), () => ({
  resolveMagpieBin: () => "/fixture/magpie",
  magpieDataDir: () => process.cwd(),
  stateDir,
  statePath: (...parts: string[]) => join(stateDir(), ...parts),
  pluginRoot: () => join(process.cwd(), "package"),
}));
mock.module(join(src, "easytier.ts"), () => ({ ownsProcess: () => false }));
mock.module(join(src, "magpie.ts"), () => ({
  Magpie: class { version() { return "fixture"; } },
}));
mock.module(join(src, "lock.ts"), () => ({ waitForHostLock: async () => ({ release() {} }) }));
mock.module(join(src, "console-launch.ts"), () => ({
  publishUnavailableLauncher() {}, readOwnPluginOptions: () => undefined, readConsolePort: () => undefined, saveConsolePort() {},
  startConsoleLauncher: () => ({ stop() {} }),
}));
mock.module(join(src, "console-server.ts"), () => ({
  ConsoleInputError: class ConsoleInputError extends Error { code: string; status: number; constructor(message: string, code = "invalid_input", status = 400) { super(message); this.code = code; this.status = status; } },
  startConsoleServer: () => ({ port: 12346, origin: "http://127.0.0.1:12346", issueTicket: () => "unused-fixture", pendingPairings: () => [], approvePairing: () => false, stop() {} }),
  startConsoleServerWithFallback: () => ({ server: { port: 12346, origin: "http://127.0.0.1:12346", issueTicket: () => "unused-fixture", pendingPairings: () => [], approvePairing: () => false, stop() {} }, fallback: false }),
}));
mock.module(join(src, "console-api.ts"), () => ({
  CONSOLE_ACTIONS: ["configure", "checks"], consoleState: async () => ({}), consoleAction: async () => ({}),
}));
mock.module(join(src, "server.ts"), () => ({ startApi: () => ({ port: 12345, stop() {} }) }));
mock.module(join(src, "control", "app.ts"), () => ({ startControlApp: async () => null, controlAppFor: () => null }));
mock.module(join(src, "service.ts"), () => ({
  catalogQuoteUsability: () => ({ usable: false, detail: "fixture" }),
  Service: class {
    supervisor = { snapshot: () => ({ pid: null }) };
    config() { return config; }
    async configure(patch: Record<string, unknown>) {
      calls.push({ method: "configure", patch });
      if (fixture.rejectConfigure) throw new Error("fixture configure rejected");
      config = { ...config, ...patch };
      return {};
    }
    async start() { calls.push({ method: "start" }); }
    async stop() {}
    setTopologyListener() {}
    async ensureControlPort() { return null; }
    writeSnapshot() {}
  },
}));
const { boot } = await import(join(src, "index.ts"));
await boot(undefined, fixture.options);
console.log("BOOT_RESULT " + JSON.stringify({ calls, config }));
