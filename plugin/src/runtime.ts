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
//
// The ledger (`ledger.sqlite`) and the authorization store are opened before the
// overlay starts, and both are reachable from tools as `runtime.db` /
// `runtime.grants`. The single listener on 3426 (the overlay address in TUN,
// loopback otherwise) is owned by
// `http-router.ts`; this module only decides when to bind it.
//
// Deposits are discovered on demand: a consumer sends a signed claim naming one
// transaction, and the provider verifies that receipt. There is no background
// block scanner; the chain is never polled for logs.

import { mkdirSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Wallet } from "ethers";
import { CatalogService, type CatalogModel } from "./catalog-service.ts";
import { hostnameForAddress, readConfig, writeConfig, type HubConfig } from "./config.ts";
import { clearDepositClaims, metaDelete, metaEntries, metaSet, openLedger } from "./db.ts";
import { Grants } from "./grants.ts";
import { DirectoryServer } from "./http-router.ts";
import { DepositClaimService } from "./deposit-claim.ts";
import { logger } from "./log.ts";
import { CONTROL_PORT, GATEWAY_PORT, Overlay } from "./overlay.ts";
import { NO_REENTRY_ENV, magpieClient } from "./magpie.ts";
import { isOurRemoteProvider, remoteProviderId } from "./remote-provider.ts";
import { stateDir } from "./paths.ts";
import { listNativeModels } from "./tools/native-models.ts";
import { loadOrCreateWallet } from "./tools/node-wallet.ts";

export interface Runtime {
  config: HubConfig;
  wallet: Wallet;
  overlay: Overlay;
  catalog: CatalogService;
  /** the single 3426 listener (directory + request + poll) */
  server: DirectoryServer;
  /** ledger.sqlite: requests, consumers, deposits, payouts, meta */
  db: Database;
  /** applications, approvals, revocations and Gateway Keys */
  grants: Grants;
}

const GLOBAL_KEY = "__ohMyAiHubRuntimeV3__";
const globalState = globalThis as unknown as Record<string, unknown>;
let hooksInstalled = false;

/**
 * Magpie has no price-change notification, and D13 accepts that a new
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

function installHooks(overlay: Overlay, server: DirectoryServer, db: Database): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const stop = () => {
    clearCatalogTimer();
    try {
      server.stop();
    } catch {
      /* an exit hook has nothing left to report to */
    }
    try {
      overlay.stopSync();
    } catch {
      /* an exit hook has nothing left to report to */
    }
    try {
      db.close();
    } catch {
      /* already closed */
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
    if (runtime.config.network) {
      // Where a peer's connection lands depends on the mode, and the mode can
      // change between passes (a join restarts the core): with a device the kernel
      // delivers it to whatever address it was sent to, so the listener takes every
      // interface. Through the user-space stack EasyTier rewrites it to 127.0.0.1.
      // `start` rebinds only when the host differs, so this is cheap to repeat.
      const mode = runtime.overlay.currentMode();
      // With a device the peer dials our overlay address; bind that address, not
      // 0.0.0.0, so the same port is not also exposed on LAN or public
      // interfaces. Without a device EasyTier rewrites inbound to loopback.
      runtime.server.start(mode === "tun" ? runtime.overlay.status().virtualIp : "127.0.0.1");
    }

    const selected = runtime.config.share.models;
    if (!runtime.server.listening && selected.length === 0) return;

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

/**
 * Re-derives `D → cap → key` for every authorized consumer, then cleans up keys
 * this plugin owns but no longer points at, in the background.
 *
 * Two gaps close here, and both come from the same fact: the Magpie write happens
 * after the ledger write, so a crash can separate them.
 *  - a `credited` row whose cap was never applied (the claim path already
 *    returned);
 *  - a key created by `gateway-key add` and never narrowed — Magpie's default for
 *    a new key is all models and no cost limit.
 *
 * Boot never waits for either. One summary line, and a failure in one phase does
 * not skip the other.
 */
function resyncCapAndKeys(runtime: Runtime, reason: string): Promise<void> {
  return (async () => {
    let resync: string;
    try {
      const summary = await runtime.grants.resyncAll();
      resync =
        `checked=${summary.checked} updated=${summary.updated} failed=${summary.failed}` +
        (summary.detail ? ` (${summary.detail})` : "");
    } catch (error) {
      resync = `failed (${detailOf(error)})`;
    }

    let sweep: string;
    try {
      const summary = await runtime.grants.sweepOrphanKeys();
      sweep =
        `checked=${summary.checked} removed=${summary.removed} clamped=${summary.clamped} failed=${summary.failed}` +
        (summary.detail ? ` (${summary.detail})` : "");
    } catch (error) {
      sweep = `failed (${detailOf(error)})`;
    }

    logger.info(`${reason}: cap/key resync ${resync}; orphan key sweep ${sweep}`);
  })();
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
    displayName: config.displayName,
    controlPort: CONTROL_PORT,
    gatewayPort: GATEWAY_PORT,
  });

  const db = openLedger();

  let runtime: Runtime | null = null;
  const grants = new Grants({
    db,
    // wallet_import replaces the identity; the store must follow it.
    address: () => runtime?.wallet.address ?? wallet.address,
    gatewayPort: GATEWAY_PORT,
    // A grant can only name a model this node publishes. share_models writes the
    // selection before re-signing, so disk is the truthful source here.
    published: () => readConfig().share.models,
  });
  const deposits = new DepositClaimService({
    db,
    address: () => runtime?.wallet.address ?? wallet.address,
    grants,
  });
  const server = new DirectoryServer({ catalog, grants, deposits, controlPort: CONTROL_PORT });

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
  runtime = { config, wallet, overlay, catalog, server, db, grants };

  installHooks(overlay, server, db);
  // The tick runs from boot: a node whose LAN address or Magpie came up late
  // must still start publishing, and a price change must reach peers without a
  // tool call.
  startCatalogRefresh(runtime);
  // A deposit booked just before a crash may have left its cap unwritten.
  // Reconcile in the background so boot stays fast and a missing Magpie only
  // costs a log line.
  //
  // Never from a host that exists only to answer one of this plugin's own CLI
  // calls: the reconciliation writes keys through that same CLI, magpie answers
  // by loading the plugins, and this file boots again. That recursion is why a
  // node with one issued key ran at a load of 70.
  const nested = Boolean(process.env[NO_REENTRY_ENV]);
  if (nested) logger.info("boot: answering a CLI call; the cap/key resync is left to the host that owns the node");
  else void resyncCapAndKeys(runtime, "boot");
  logger.info(
    `boot: wallet ${wallet.address}, hostname ${hostname}, network ${config.network?.name ?? "none"}, ` +
      `ledger ${stateDir()}/ledger.sqlite${nested ? " (nested)" : ""}`,
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
 * Drops state that belonged to the old wallet. Consumer-side connections carry
 * Gateway Keys issued to the old address, and their cached poll/request rows are
 * signed answers about that address; none of them should silently keep working
 * under a new identity. The Remote Magpie entries this plugin created are
 * removed first (the forward disappears when the overlay config is rewritten).
 */
async function clearConsumingState(runtime: Runtime): Promise<{ clearedConnections: number; removedProviders: number; detail?: string }> {
  const connections = runtime.config.connections;
  let removedProviders = 0;
  const notes: string[] = [];
  if (connections.length > 0) {
    try {
      const magpie = magpieClient();
      for (const connection of connections) {
        const id = remoteProviderId(connection.provider);
        try {
          const record = magpie.providerById(id);
          if (record && isOurRemoteProvider(record, id, connection.localPort)) {
            await magpie.removeProvider(id, 10_000);
            removedProviders += 1;
          }
        } catch (error) {
          notes.push(`${id}: ${detailOf(error)}`);
        }
      }
    } catch (error) {
      notes.push(`Magpie cannot be located: ${detailOf(error)}`);
    }
  }

  if (connections.length > 0) {
    const next = { ...runtime.config, connections: [] };
    try {
      writeConfig(next);
      runtime.config = next;
    } catch (error) {
      notes.push(`cannot persist the cleared connections: ${detailOf(error)}`);
    }
  }
  for (const row of [...metaEntries(runtime.db, "poll:"), ...metaEntries(runtime.db, "request:")]) {
    metaDelete(runtime.db, row.k);
  }
  clearDepositClaims(runtime.db);
  return {
    clearedConnections: connections.length,
    removedProviders,
    ...(notes.length > 0 ? { detail: notes.join("; ") } : {}),
  };
}

/**
 * Applies a wallet that wallet_import just installed. The overlay hostname is
 * derived from the address, so a changed identity also restarts a configured
 * overlay instead of leaving the old hostname running. The directory is re-signed
 * with the new key without waiting for the core.
 */
export async function replaceWallet(
  runtime: Runtime,
  wallet: Wallet,
): Promise<{ clearedConnections: number; removedProviders: number; detail?: string }> {
  runtime.wallet = wallet;
  // Usage bases belong to the old provider identity; a new identity starts clean.
  runtime.grants.beginWalletChange();
  try {
    metaSet(runtime.db, "wallet:since", new Date().toISOString());
  } catch (error) {
    logger.warn(`wallet change: cannot record the new payout epoch: ${detailOf(error)}`);
  }
  let cleared: { clearedConnections: number; removedProviders: number; detail?: string } = {
    clearedConnections: 0,
    removedProviders: 0,
  };
  try {
    cleared = await clearConsumingState(runtime);
    if (cleared.detail) logger.warn(`wallet change: ${cleared.detail}`);
    if (cleared.clearedConnections > 0) {
      logger.info(
        `wallet change: cleared ${cleared.clearedConnections} connection(s), ` +
          `removed ${cleared.removedProviders} Remote Magpie provider(s)`,
      );
    }
    // The new identity has its own `D` per payer (deposits were addressed to the
    // old wallet), so every cap has to be re-derived for it. Finish the wallet
    // change only after the old keys have been dropped, so their usage is not
    // rolled into the new identity.
    await resyncCapAndKeys(runtime, "wallet change");
  } finally {
    runtime.grants.finishWalletChange();
  }
  const hostname = hostnameForAddress(wallet.address);
  runtime.catalog.setWallet(wallet, hostname);
  void runtime.catalog
    .resign()
    .catch((error) => logger.error(`catalogue: cannot re-sign after the wallet change: ${detailOf(error)}`));

  if (runtime.config.hostname === hostname) return cleared;
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
  return cleared;
}
