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
import { resolveMagpieBin, statePath } from "./paths.ts";
import { ownsProcess } from "./easytier.ts";
import { waitForHostLock, type HostLock } from "./lock.ts";
import { startConsoleServer, type ConsoleServer } from "./console-server.ts";
import { CONSOLE_ACTIONS, consoleAction, consoleState } from "./console-api.ts";
import { readConsolePort, saveConsolePort, readOwnPluginOptions, startConsoleLauncher, publishUnavailableLauncher } from "./console-launch.ts";
import { Service } from "./service.ts";
import { WALLET_VAULT_SENSITIVE_ACTIONS, disposeWalletLocalService, endWalletLocalSession } from "./wallet-local-service.ts";
import { startApi } from "./server.ts";
import {
  decideOptions,
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
  console?: ConsoleServer;
}

const g = globalThis as unknown as { __ohMyAIHub?: Promise<Running>; __ohMyAIHubStopped?: boolean };

/** Starts the plugin once per host process. */
export async function boot(input?: PluginInput, optionsRaw?: unknown): Promise<Running> {
  if (g.__ohMyAIHub) return g.__ohMyAIHub;
  let failedBootCleanup: (() => Promise<void>) | undefined;
  g.__ohMyAIHub = (async () => {
    const bin = resolveMagpieBin();
    const magpie = new Magpie(bin);
    const version = magpie.version();
    logger.info(`plugin boot: magpie ${version} (${bin}), cwd ${process.cwd()}`);

    let lock: HostLock | null = null;
    let service: Service | undefined;
    let api: { port: number; stop(): void } | undefined;
    let consoleServer: ConsoleServer | undefined;
    let launcher: ReturnType<typeof startConsoleLauncher> | undefined;
    let stopped = false;
    const parentPid = process.ppid;
    const parentGone = () => {
      if (parentPid <= 1 || process.ppid !== parentPid) return true;
      try { process.kill(parentPid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    const isStopped = () => stopped || parentGone();
    const ensureRunning = () => { if (isStopped()) throw new Error("plugin host stopped before startup completed"); };
    const shutdown = () => {
      stopped = true;
      launcher?.stop(); consoleServer?.stop(); api?.stop();
      if (service) disposeWalletLocalService(service);
      const pid = service?.supervisor.snapshot().pid;
      const configPath = statePath("easytier", "current.toml");
      if (pid && ownsProcess(pid, configPath)) {
        try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
        for (let i = 0; i < 50 && ownsProcess(pid, configPath); i++) Bun.sleepSync(100);
        if (ownsProcess(pid, configPath)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
        }
      }
    };
    const onExit = () => { try { shutdown(); } finally { lock?.release(); } };
    const onSignal = () => { stopped = true; process.exit(0); };
    // Install before ownership wait, Service construction, or any async startup.
    process.on("exit", onExit);
    process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
    const orphanWatch = setInterval(() => {
      if (parentGone()) { stopped = true; process.exit(0); }
    }, 500);
    orphanWatch.unref?.();
    failedBootCleanup = async () => {
      stopped = true;
      launcher?.stop(); consoleServer?.stop(); api?.stop();
      try { if (service) await service.stop(); }
      finally {
        shutdown(); lock?.release(); clearInterval(orphanWatch);
        process.off("exit", onExit); process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
      }
    };
    ensureRunning();
    let announced = false;
    lock = await waitForHostLock({ stopped: isStopped, waiting: () => {
      if (!announced) logger.info("existing plugin owner is draining; waiting without starting another supervisor or API");
      announced = true;
    } });
    ensureRunning();
    if (!lock) throw new Error("existing plugin owner did not release within 11 minutes; reopen the plugin page to retry");
    // options.set retires a shared host. Read the latest official options only
    // after ownership transfers, not the potentially 10-minute-old input blob.
    optionsRaw = readOwnPluginOptions() ?? optionsRaw;

    const startedAt = new Date().toISOString();
    service = new Service({ magpie, magpieVersion: version });
    ensureRunning();

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
        ensureRunning();
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
      }
    } else {
      if (decision.record) {
        // "preferences only", a migration, or a save that changed only page
        // preferences: the running configuration is still the previous snapshot.
        // A first migration records the options as observed. Dropping that
        // baseline would replay every stale value on the next preference save.
        finalRecord = before ? withPreviousApplied(decision.record, before) : decision.record;
        writeAppliedRecord(finalRecord);
      }
      if (decision.reason) logger.info(`plugin options not applied: ${decision.reason}`);
    }

    // configure() applies an overlay patch; every fresh host must also recover
    // issued keys, reconcile Remote Magpies and start its chain watchers.
    ensureRunning();
    await service.start();
    ensureRunning();

    api = startApi({ port: opt.apiPort ? Number(opt.apiPort) : undefined, service });
    try {
      const consoleOptions = {
        port: readConsolePort(),
        state: () => consoleState(service!),
        action: (name: string, body: Record<string, unknown>, context: Parameters<typeof consoleAction>[3]) => consoleAction(service!, name, body, context),
        allowedActions: CONSOLE_ACTIONS,
        sensitiveActions: ["key-reveal", ...WALLET_VAULT_SENSITIVE_ACTIONS],
        staticModules: ["/session.js", "/providers.js", "/wallet.js"],
        pairingFile: statePath("console-pairing.json"),
        onSessionEnd: (sessionId: string) => endWalletLocalSession(service!, sessionId),
      };
      consoleServer = startConsoleServer(consoleOptions);
      saveConsolePort(consoleServer.port);
      launcher = startConsoleLauncher({
        port: consoleServer.port, issueTicket: () => consoleServer!.issueTicket(), options: optionsRaw,
        pendingPairings: () => consoleServer!.pendingPairings(),
        approvePairing: (id, code) => consoleServer!.approvePairing(id, code),
      });
    } catch {
      // Opening the UI must never stop the overlay or leak a secret URL in an
      // error. A fresh explicit page request can recover on the next host.
      consoleServer?.stop();
      consoleServer = undefined;
      try { publishUnavailableLauncher(); } catch { /* snapshot is best effort */ }
      logger.warn("local console could not start; overlay and script API remain running");
    }
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

    ensureRunning();
    return { service, api, console: consoleServer };
  })().catch(async (error) => {
    // A failed startup must stop its partial Service before another boot can
    // take ownership. Cleanup failure deliberately leaves the lock fail-closed.
    try { await failedBootCleanup?.(); } catch { /* synchronous owned-process fallback already ran */ }
    // Do not memoize a permanent standby/rejected boot.
    delete g.__ohMyAIHub;
    throw error;
  });
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
