// Magpie community plugin entry.
//
// Magpie starts a Bun host when it boots (its startup provider read asks the
// plugins), imports this file, and calls the default export with OpenCode's
// plugin input and this plugin's options. The host runs with Magpie's settings
// directory as its working directory and lives as long as the Magpie process, so
// this is where the EasyTier supervisor and the host API belong.
//
// Verified against Magpie 0.1.2038: `internal/plugin/host.js` (the import and the
// call), `internal/plugin/host.go` (the host outlives the request; cwd is the
// settings directory). The plugin page cannot reach the network
// (`internal/gui/pluginpage.go`, `connect-src 'none'`), so status for the page is
// written to `page/status.js`.

import { logger } from "./log.ts";
import { Magpie } from "./magpie.ts";
import { resolveMagpieBin } from "./paths.ts";
import { acquireHostLock } from "./lock.ts";
import { Service } from "./service.ts";
import { startApi } from "./server.ts";
import {
  decideOptions,
  newRecord,
  parseOptions,
  pageOptionsView,
  readAppliedRecord,
  withPreviousApplied,
  writeAppliedRecord,
  writePageOptions,
  type AppliedRecord,
} from "./plugin-options.ts";

interface PluginInput {
  directory?: string;
  $?: unknown;
  magpie?: {
    option?: (provider: string, key: string) => unknown;
    options?: (provider: string) => Record<string, unknown>;
  };
}

interface Running {
  service: Service;
  api: { port: number; stop: () => void };
}

const g = globalThis as unknown as { __ohMyAIHub?: Promise<Running>; __ohMyAIHubStopped?: boolean };

/** Starts the plugin once per host process. */
export async function boot(input?: PluginInput, optionsRaw?: unknown): Promise<Running> {
  if (g.__ohMyAIHub) return g.__ohMyAIHub;
  g.__ohMyAIHub = (async () => {
    const bin = resolveMagpieBin();
    const magpie = new Magpie(bin);
    const version = magpie.version();
    logger.info(`plugin boot: magpie ${version} (${bin}), cwd ${process.cwd()}`);

    const lock = acquireHostLock();
    if (!lock) {
      logger.info("another plugin host already owns this Magpie data directory; standing by (no supervisor, no API)");
      return { service: null as unknown as Service, api: { port: 0, stop: () => {} } };
    }
    process.on("exit", () => lock.release());

    const startedAt = new Date().toISOString();
    const service = new Service({ magpie, magpieVersion: version });

    // What to do with plugins.json's options is decided in plugin-options.ts:
    // seed a node that has no configuration, apply a *new* save as a patch of
    // the keys that actually changed, or leave an already-configured node alone
    // (the state that is serving wins over a stale blob). A value this plugin
    // cannot use is refused, never quietly rewritten.
    const parsed = parseOptions(optionsRaw);
    const opt = parsed.options;
    const before = readAppliedRecord();
    const decision = decideOptions({
      options: opt,
      configured: Boolean(service.config()),
      record: before,
      problems: parsed.problems,
    });
    if (parsed.problems.length) logger.warn(`plugin options refused: ${parsed.problems.join("; ")}`);
    let failure: string | null = null;
    let finalRecord: AppliedRecord | null = decision.record ?? before;
    if (decision.kind === "seed" || decision.kind === "patch") {
      // Two writes: "pending" now, the result after configure. A crash in
      // between leaves a record that says the attempt did not finish, so the
      // next boot retries it instead of believing a configuration never made.
      // Neither write may move `applied` before configure succeeded: the retry
      // diffs against the configuration that is actually running.
      const attempt = withPreviousApplied(decision.record, before);
      writeAppliedRecord({ ...attempt, phase: "pending" });
      logger.info(
        `plugin options: ${decision.kind} from plugins.json (${Object.keys(decision.patch).join(",") || "nothing"})`,
      );
      try {
        await service.configure(decision.patch as Parameters<Service["configure"]>[0]);
        // Read back: a key this plugin does not actually accept must not pass
        // silently, so the seed has to be visible in the stored configuration.
        const cfg = service.config();
        const want = decision.patch as { networkName?: string };
        if (want.networkName && cfg?.networkName !== want.networkName) {
          throw new Error(`the overlay did not take networkName ${want.networkName} (stored ${String(cfg?.networkName)})`);
        }
        finalRecord = { ...decision.record, phase: "done" };
        writeAppliedRecord(finalRecord);
        logger.info(
          `plugin options: ${decision.kind} applied; network ${cfg?.networkName ?? "?"}, ` +
            `sharing ${cfg?.sharingEnabled ? "on" : "off"}, consuming ${cfg?.consumingEnabled ? "on" : "off"}`,
        );
      } catch (e) {
        failure = String((e as Error)?.message ?? e);
        finalRecord = { ...attempt, phase: "done", error: failure.slice(0, 300) };
        writeAppliedRecord(finalRecord);
        logger.error(`plugin options (${decision.kind}) were not applied: ${failure}; the stored state stays in force`);
        await service.start();
      }
    } else {
      if (decision.record) {
        // "preferences only", a migration, or a save that changed only page
        // preferences: the running configuration is still the previous snapshot.
        finalRecord = withPreviousApplied(decision.record, before);
        writeAppliedRecord(finalRecord);
      }
      if (decision.reason) logger.info(`plugin options not applied: ${decision.reason}`);
      await service.start();
    }

    const api = startApi({ port: opt.apiPort ? Number(opt.apiPort) : undefined, service });
    service.writeSnapshot();
    writePageOptions(
      pageOptionsView({
        options: opt,
        record: finalRecord,
        decision: failure ? { kind: "none", reason: `the saved values were not applied: ${failure}` } : decision,
        problems: parsed.problems,
        networkConfigured: Boolean(service.config()),
        secretSet: Boolean(service.config()?.networkSecret),
        nodeId: service.config()?.nodeId ?? null,
        hostPid: process.pid,
        hostStartedAt: startedAt,
      }),
    );

    // Disabling the plugin (or quitting Magpie) stops the EasyTier this host
    // started: a plugin that is off must not leave a VPN behind. A core that
    // survives a crash is adopted by the next host instead.
    const shutdown = () => {
      const pid = service.supervisor.snapshot().pid;
      if (pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    };
    process.on("exit", shutdown);
    // A host can outlive the Magpie that started it (Magpie's host outlives the
    // request; a killed Magpie leaves it reparented). Without this, disabling the
    // plugin or quitting Magpie would leave the VPN running with nobody to stop
    // it, and the host lock would keep the next Magpie out.
    const orphanWatch = setInterval(() => {
      if (process.ppid <= 1) {
        logger.info("Magpie is gone (reparented); stopping the supervisor and exiting");
        shutdown();
        process.exit(0);
      }
    }, 5000);
    orphanWatch.unref?.();
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => {
        shutdown();
        process.exit(0);
      });
    }
    return { service, api };
  })();
  return g.__ohMyAIHub;
}

/**
 * Magpie imports the package's main and calls what it exports with OpenCode's
 * plugin input. Returning quickly matters: the host waits for it while it loads.
 */
export default function plugin(input: PluginInput, options?: unknown): Record<string, never> {
  boot(input, options).catch((e) => logger.error(`plugin failed to start: ${String(e)}`));
  return {};
}
