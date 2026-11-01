// One runtime per plugin host process.
//
// Magpie waits for the default export while it loads, so the export returns
// immediately and this module does the real work in the background. Tool calls
// await the same promise; a failed boot is not memoized, so the next call can
// retry.
//
// The directory service starts only after the overlay core is online: before
// that there is no export to reach it through. Its document is built from the
// saved share selection and re-signed in memory whenever the selection or the
// node wallet changes — never by restarting EasyTier.

import { mkdirSync } from "node:fs";
import type { Wallet } from "ethers";
import { CatalogService, type CatalogModel } from "./catalog-service.ts";
import { hostnameForAddress, readConfig, writeConfig, type HubConfig } from "./config.ts";
import { detectLanIPv4 } from "./lan.ts";
import { logger } from "./log.ts";
import { CONTROL_PORT, GATEWAY_PORT, Overlay } from "./overlay.ts";
import { stateDir } from "./paths.ts";
import { listNativeModels } from "./tools/native-models.ts";
import { loadOrCreateWallet } from "./tools/node-wallet.ts";

export interface Runtime {
  config: HubConfig;
  wallet: Wallet;
  overlay: Overlay;
  catalog: CatalogService;
}

const GLOBAL_KEY = "__ohMyAiHubRuntimeV3__";
const globalState = globalThis as unknown as Record<string, unknown>;
let hooksInstalled = false;

/**
 * Magpie has no price-change notification, and DESIGN-V2 D13 accepts that a new
 * price applies to old usage. The published document therefore has to follow the
 * live price without anyone calling a tool: one 30-second re-sign while the
 * directory is being served.
 */
const CATALOG_REFRESH_MS = 30_000;
let catalogTimer: ReturnType<typeof setInterval> | null = null;
let catalogRefreshing = false;

function clearCatalogTimer(): void {
  if (!catalogTimer) return;
  clearInterval(catalogTimer);
  catalogTimer = null;
}

function installHooks(overlay: Overlay): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const stop = () => {
    clearCatalogTimer();
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

function detailOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

/**
 * Builds the published model list from the saved selection.
 *
 * Three outcomes, and they must not be confused:
 *  - `[]`   — there is no selection, so nothing is shared;
 *  - models — Magpie answered, and these are the still-shareable entries;
 *  - `null` — Magpie could not be read, so the answer is unknown. A transient
 *             read failure must never be published as "this node shares nothing"
 *             (that would unpublish every shared model at once).
 *
 * A model that is no longer shareable (price removed, provider turned into a
 * Remote Magpie) drops out of the document; the selection itself is left alone.
 */
async function resolveSharedModels(runtime: Runtime): Promise<CatalogModel[] | null> {
  const selected = runtime.config.share.models;
  if (selected.length === 0) return [];
  try {
    const native = await listNativeModels();
    const byId = new Map(native.filter((model) => model.shareable && model.price).map((model) => [model.id, model]));
    const models: CatalogModel[] = [];
    const missing: string[] = [];
    for (const id of selected) {
      const model = byId.get(id);
      if (model?.price) models.push({ id, price: model.price });
      else missing.push(id);
    }
    if (missing.length > 0) logger.warn(`catalogue: shared models no longer shareable: ${missing.join(", ")}`);
    return models;
  } catch (error) {
    logger.warn(`catalogue: cannot resolve the shared models: ${detailOf(error)}`);
    return null;
  }
}

function probeLan(): string | null {
  try {
    return detectLanIPv4();
  } catch (error) {
    logger.warn(`catalogue: LAN probe failed: ${detailOf(error)}`);
    return null;
  }
}

/** A resolver a test can replace without a real Magpie. */
export type SharedModelResolver = (runtime: Runtime) => Promise<CatalogModel[] | null>;

/**
 * One refresh pass: bind the directory if it is not listening yet, re-resolve the
 * shared models, re-sign. The timestamp moves with every successful pass, so a
 * price change in Magpie reaches peers within one tick.
 *
 * Exported so a self-check can drive it directly instead of waiting for the
 * 30-second timer (and without starting EasyTier).
 */
export async function refreshCatalog(runtime: Runtime, resolve: SharedModelResolver = resolveSharedModels): Promise<void> {
  if (catalogRefreshing) return;
  catalogRefreshing = true;
  try {
    if (runtime.config.network && !runtime.catalog.listening) {
      // The LAN address may have appeared after boot; re-probe before giving up.
      const lan = runtime.overlay.lanAddress() ?? probeLan();
      if (lan) runtime.catalog.start(lan);
    }

    const selected = runtime.config.share.models;
    if (!runtime.catalog.listening && selected.length === 0) return;

    const models = await resolve(runtime);
    if (models === null) {
      runtime.catalog.setDetail("cannot read Magpie's model list; keeping the last signed directory");
      return;
    }
    // A pass can take seconds (Magpie is a subprocess). If `share_models` wrote a
    // new selection meanwhile, that call already re-signed the document with it;
    // this older snapshot must not overwrite it. The next tick picks up the new
    // selection.
    if (runtime.config.share.models !== selected) return;
    await runtime.catalog.update(models);
    runtime.catalog.setDetail(null);
  } catch (error) {
    // A failed re-sign keeps the last good document; the next tick retries.
    runtime.catalog.setDetail(`cannot re-sign the directory: ${detailOf(error)}`);
    logger.error(`catalogue: cannot publish the document: ${detailOf(error)}`);
  } finally {
    catalogRefreshing = false;
  }
}

/** Installs the single 30-second tick; a second call is a no-op. */
function startCatalogRefresh(runtime: Runtime): void {
  if (catalogTimer) return;
  catalogTimer = setInterval(() => {
    void refreshCatalog(runtime);
  }, CATALOG_REFRESH_MS);
  catalogTimer.unref?.();
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

  const catalog = new CatalogService({
    wallet,
    hostname,
    controlPort: CONTROL_PORT,
    gatewayPort: GATEWAY_PORT,
  });

  let runtime: Runtime | null = null;
  const overlay = new Overlay(config, {
    onConfigChange: (next) => {
      try {
        writeConfig(next);
      } catch (error) {
        logger.error(`cannot persist the mapped CIDR: ${detailOf(error)}`);
      }
    },
    onOnline: () => {
      if (runtime) void refreshCatalog(runtime);
    },
  });
  runtime = { config, wallet, overlay, catalog };

  installHooks(overlay);
  // The tick runs from boot: a node whose LAN address or Magpie came up late
  // must still start publishing, and a price change must reach peers without a
  // tool call.
  startCatalogRefresh(runtime);
  logger.info(
    `boot: wallet ${wallet.address}, hostname ${hostname}, network ${config.network?.name ?? "none"}`,
  );

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
 * overlay instead of leaving the old hostname running. The directory is re-signed
 * with the new key without waiting for the core.
 */
export function replaceWallet(runtime: Runtime, wallet: Wallet): void {
  runtime.wallet = wallet;
  const hostname = hostnameForAddress(wallet.address);
  runtime.catalog.setWallet(wallet, hostname);
  void runtime.catalog
    .resign()
    .catch((error) => logger.error(`catalogue: cannot re-sign after the wallet change: ${detailOf(error)}`));

  if (runtime.config.hostname === hostname) return;
  runtime.config = { ...runtime.config, hostname };
  try {
    writeConfig(runtime.config);
  } catch (error) {
    // The key on disk is already the new one; a failed hostname write must not
    // turn a successful import into an error. The next boot derives it again.
    logger.error(`cannot persist the new hostname: ${detailOf(error)}`);
  }
  runtime.overlay.configure(runtime.config);
  if (runtime.config.network) runtime.overlay.beginStart(runtime.config);
}
