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

interface PluginInput {
  directory?: string;
  $?: unknown;
  magpie?: {
    option?: (provider: string, key: string) => unknown;
    options?: (provider: string) => Record<string, unknown>;
  };
}

interface PluginOptions {
  /** phase-3 shorthand: provider = share only, consumer = consume only */
  role?: "provider" | "consumer";
  sharingEnabled?: boolean;
  consumingEnabled?: boolean;
  networkName?: string;
  networkSecret?: string;
  peers?: string[] | string;
  listenAddr?: string;
  publishedPorts?: number[] | string;
  secureMode?: boolean;
  shareModels?: string[] | string;
  rpcPort?: number;
  apiPort?: number;
  catalogEnabled?: boolean;
  catalogDiscovery?: boolean;
  catalogDisplayName?: string;
  catalogContact?: string;
  catalogPort?: number;
}

interface Running {
  service: Service;
  api: { port: number; stop: () => void };
}

const g = globalThis as unknown as { __ohMyAIHub?: Promise<Running>; __ohMyAIHubStopped?: boolean };

/** Starts the plugin once per host process. */
export async function boot(input?: PluginInput, options?: PluginOptions): Promise<Running> {
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

    const service = new Service({ magpie, magpieVersion: version });

    const opt = options ?? {};
    const current = service.config();
    const sharingEnabled = opt.sharingEnabled ?? (opt.role === "provider" ? true : opt.role === "consumer" ? false : (current?.sharingEnabled ?? true));
    const consumingEnabled = opt.consumingEnabled ?? (opt.role === "consumer" ? true : opt.role === "provider" ? false : (current?.consumingEnabled ?? false));
    const fromOptions = {
      sharingEnabled,
      consumingEnabled,
      networkName: opt.networkName ? String(opt.networkName) : "",
      networkSecret: opt.networkSecret ? String(opt.networkSecret) : "",
      peers: toList(opt.peers),
      listenAddr: opt.listenAddr ? String(opt.listenAddr) : null,
      publishedPorts: toList(opt.publishedPorts).map(Number).filter(Boolean),
      secureMode: opt.secureMode !== false,
      shareModels: toList(opt.shareModels),
      catalogEnabled: opt.catalogEnabled ?? current?.catalog.enabled ?? false,
      catalogDiscovery: opt.catalogDiscovery ?? current?.catalog.discoveryEnabled ?? false,
      catalogDisplayName: opt.catalogDisplayName ?? current?.catalog.displayName ?? null,
      catalogContact: opt.catalogContact ?? current?.catalog.contact ?? null,
      catalogPort: opt.catalogPort ?? current?.catalog.port ?? 3426,
    };
    const changed =
      !current ||
      current.sharingEnabled !== fromOptions.sharingEnabled ||
      current.consumingEnabled !== fromOptions.consumingEnabled ||
      current.networkName !== fromOptions.networkName ||
      current.networkSecret !== fromOptions.networkSecret ||
      JSON.stringify(current.peers) !== JSON.stringify(fromOptions.peers.map((p) => (p.includes("://") ? p : `tcp://${p}`))) ||
      (current.listenAddr ?? null) !== (fromOptions.listenAddr ? (fromOptions.listenAddr.includes("://") ? fromOptions.listenAddr : `tcp://${fromOptions.listenAddr}`) : null) ||
      JSON.stringify(current.publishedPorts) !== JSON.stringify(fromOptions.sharingEnabled ? fromOptions.publishedPorts : current.publishedPorts) ||
      current.secureMode !== fromOptions.secureMode ||
      current.catalog.enabled !== fromOptions.catalogEnabled ||
      current.catalog.discoveryEnabled !== fromOptions.catalogDiscovery ||
      current.catalog.displayName !== fromOptions.catalogDisplayName ||
      current.catalog.contact !== fromOptions.catalogContact ||
      current.catalog.port !== fromOptions.catalogPort ||
      (fromOptions.shareModels.length > 0 && JSON.stringify(current.share.models) !== JSON.stringify(fromOptions.shareModels));

    if (opt.networkName && opt.networkSecret && changed) {
      await service
        .configure({
          sharingEnabled,
          consumingEnabled,
          networkName: String(opt.networkName),
          networkSecret: String(opt.networkSecret),
          peers: toList(opt.peers),
          listenAddr: opt.listenAddr ? String(opt.listenAddr) : null,
          publishedPorts: toList(opt.publishedPorts).map(Number).filter(Boolean),
          secureMode: opt.secureMode !== false,
          shareModels: fromOptions.shareModels.length ? fromOptions.shareModels : undefined,
          rpcPort: opt.rpcPort ? Number(opt.rpcPort) : undefined,
          catalogEnabled: fromOptions.catalogEnabled,
          catalogDiscovery: fromOptions.catalogDiscovery,
          catalogDisplayName: fromOptions.catalogDisplayName,
          catalogContact: fromOptions.catalogContact,
          catalogPort: fromOptions.catalogPort,
        })
        .catch((e) => logger.error(`configure from plugin options failed: ${String(e)}`));
    } else {
      await service.start();
    }

    const api = startApi({ port: opt.apiPort ? Number(opt.apiPort) : undefined, service });
    service.writeSnapshot();

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

function toList(v: string[] | string | number[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Magpie imports the package's main and calls what it exports with OpenCode's
 * plugin input. Returning quickly matters: the host waits for it while it loads.
 */
export default function plugin(input: PluginInput, options?: PluginOptions): Record<string, never> {
  boot(input, options).catch((e) => logger.error(`plugin failed to start: ${String(e)}`));
  return {};
}
