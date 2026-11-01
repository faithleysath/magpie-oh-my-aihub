// One runtime per plugin host process.
//
// Magpie waits for the default export while it loads, so the export returns
// immediately and this module does the real work in the background. Tool calls
// await the same promise; a failed boot is not memoized, so the next call can
// retry.

import { mkdirSync } from "node:fs";
import type { Wallet } from "ethers";
import { hostnameForAddress, readConfig, writeConfig, type HubConfig } from "./config.ts";
import { logger } from "./log.ts";
import { Overlay } from "./overlay.ts";
import { stateDir } from "./paths.ts";
import { loadOrCreateWallet } from "./tools/node-wallet.ts";

export interface Runtime {
  config: HubConfig;
  wallet: Wallet;
  overlay: Overlay;
}

const GLOBAL_KEY = "__ohMyAiHubRuntimeV3__";
const globalState = globalThis as unknown as Record<string, unknown>;
let hooksInstalled = false;

function installHooks(overlay: Overlay): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const stop = () => {
    try {
      overlay.stopSync();
    } catch {
      /* an exit hook has nothing left to report to */
    }
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  // A killed host never runs its exit handlers. This unref'd watchdog notices a
  // vanished parent and stops only the child this host started.
  const parentPid = process.ppid;
  if (parentPid > 1) {
    const timer = setInterval(() => {
      let alive = process.ppid === parentPid;
      if (alive) {
        try {
          process.kill(parentPid, 0);
        } catch (error) {
          // ESRCH is "gone"; a platform that rejects signal 0 must not make a
          // live parent look dead.
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
      }
      if (!alive) {
        stop();
        process.exit(0);
      }
    }, 5_000);
    timer.unref?.();
  }
}

async function bootOnce(): Promise<Runtime> {
  try {
    return await bootOnceInner();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^E_[A-Z_]+:/.test(message)) throw error;
    throw new Error(`E_PATH: plugin bootstrap failed: ${message}`);
  }
}

async function bootOnceInner(): Promise<Runtime> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const config = readConfig();
  const wallet = loadOrCreateWallet();
  const hostname = hostnameForAddress(wallet.address);
  if (config.hostname !== hostname) {
    config.hostname = hostname;
    writeConfig(config);
  }

  const overlay = new Overlay(config);
  installHooks(overlay);
  logger.info(
    `boot: wallet ${wallet.address}, hostname ${hostname}, network ${config.network?.name ?? "none"}`,
  );

  const runtime: Runtime = { config, wallet, overlay };
  if (config.network) overlay.beginStart(config);
  return runtime;
}

export function boot(): Promise<Runtime> {
  const existing = globalState[GLOBAL_KEY] as Promise<Runtime> | undefined;
  if (existing) return existing;
  const started = bootOnce();
  globalState[GLOBAL_KEY] = started;
  started.catch(() => {
    if (globalState[GLOBAL_KEY] === started) delete globalState[GLOBAL_KEY];
  });
  return started;
}

export function getRuntime(): Promise<Runtime> {
  return boot();
}

/**
 * Applies a wallet that wallet_import just installed. The overlay hostname is
 * derived from the address, so a changed identity also restarts a configured
 * overlay instead of leaving the old hostname running.
 */
export function replaceWallet(runtime: Runtime, wallet: Wallet): void {
  runtime.wallet = wallet;
  const hostname = hostnameForAddress(wallet.address);
  if (runtime.config.hostname === hostname) return;
  runtime.config = { ...runtime.config, hostname };
  try {
    writeConfig(runtime.config);
  } catch (error) {
    // The key on disk is already the new one; a failed hostname write must not
    // turn a successful import into an error. The next boot derives it again.
    logger.error(`cannot persist the new hostname: ${error instanceof Error ? error.message : String(error)}`);
  }
  runtime.overlay.configure(runtime.config);
  if (runtime.config.network) runtime.overlay.beginStart(runtime.config);
}
