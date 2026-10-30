import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stateDir, statePath } from "./paths.ts";
import { logger, recentLogs, redact } from "./log.ts";
import type { Service } from "./service.ts";

export interface ApiOptions {
  port?: number;
  service: Service;
}

interface ApiHandle {
  port: number;
  stop: () => void;
  token: string;
}

function apiToken(): string {
  const file = statePath("api-token");
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  }
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("hex");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The host service: a loopback-only HTTP API for scripts and the operator.
 *
 * The plugin's page cannot reach it (Magpie serves plugin pages with
 * `connect-src 'none'`), so the page reads a generated snapshot instead. Mutating
 * calls need the bearer token from the plugin state directory; read-only status
 * does not.
 *
 * Phase-4 additions: the two capabilities can be switched (`/sharing`,
 * `/consuming`), remote providers have their own endpoints (`/providers` …
 * `/providers/rm`), and the phase-3 `/connect` and `/disconnect` stay as thin
 * aliases so an older CLI or script keeps working.
 */
export function startApi(opts: ApiOptions): ApiHandle {
  const token = apiToken();
  const preferred = opts.port ?? 34517;
  let port = preferred;
  let lastError: unknown = null;
  for (let i = 0; i < 30; i++) {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => handle(req, opts.service, token),
      });
      writeFileSync(statePath("api-port"), String(port) + "\n", { mode: 0o600 });
      logger.info(`host API listening on http://127.0.0.1:${port}`);
      return { port, token, stop: () => server.stop(true) };
    } catch (e) {
      // Bun's bind error text differs by platform ("Is port … in use?",
      // "EADDRINUSE", "failed to listen"): try the next port either way and
      // only fail when the range is exhausted.
      lastError = e;
      port += 1;
      continue;
    }
  }
  throw new Error(`no free port for the host API near ${preferred}: ${String(lastError)}`);
}

async function handle(req: Request, svc: Service, token: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const origin = req.headers.get("origin");
  if (origin) return json({ error: "cross-origin requests are not accepted" }, 403);

  if (req.method === "GET" && (path === "/status" || path === "/")) {
    const s = await svc.status();
    return json({ ...s, logs: recentLogs(40) });
  }
  if (req.method === "GET" && path === "/health") return json({ ok: true });
  if (req.method === "GET" && path === "/checks") return json({ checks: await svc.checks() });
  if (req.method === "GET" && path === "/providers") {
    return json({ sharingEnabled: svc.config()?.sharingEnabled ?? false, consumingEnabled: svc.config()?.consumingEnabled ?? false, providers: svc.providers() });
  }
  if (req.method === "GET" && path === "/catalog") {
    return json({ catalog: svc.catalogStatus() });
  }
  if (req.method === "GET" && path === "/catalog/peers") {
    return json({ peers: svc.peersInDirectory() });
  }
  if (req.method === "GET" && path === "/accounting") {
    return json({ accounting: svc.accountingStatus() });
  }
  if (req.method === "GET" && path === "/consumers") {
    const s = await svc.status();
    return json({ consumers: s.consumers });
  }
  if (req.method === "GET" && path === "/wallet") {
    return json({ wallet: await svc.walletStatus() });
  }
  if (req.method === "GET" && path === "/wallet/networks") {
    const w = svc.walletModule();
    return json({ networks: w ? w.networks() : [] });
  }
  if (req.method === "GET" && path === "/wallet/assets") {
    const w = svc.walletModule();
    return json({ assets: w ? w.allAssets() : [] });
  }
  if (req.method === "GET" && path === "/wallet/intents") {
    const w = svc.walletModule();
    if (!w) return json({ intents: [] });
    return json({ intents: w.intents(url.searchParams.get("consumerId") ?? undefined) });
  }
  if (req.method === "GET" && path === "/wallet/events") {
    const w = svc.walletModule();
    if (!w) return json({ events: [] });
    const tx = url.searchParams.get("tx");
    if (tx) return json({ events: w.chainStore().eventByTx(tx) });
    const chainId = url.searchParams.get("chainId");
    return json({ events: chainId ? w.chainStore().eventsForChain(Number(chainId)) : (await w.status()).events });
  }
  if (req.method === "GET" && path === "/wallet/anomalies") {
    const w = svc.walletModule();
    return json({ anomalies: w ? w.chainStore().anomalies() : [] });
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${token}`) return json({ error: "unauthorized: send the plugin API token" }, 401);

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  try {
    switch (path) {
      case "/configure":
        return json(await svc.configure(body as Parameters<Service["configure"]>[0]));
      case "/sharing": {
        const { enabled } = body as { enabled?: unknown };
        if (typeof enabled !== "boolean") return json({ error: "enabled (boolean) is required" }, 400);
        return json(await svc.setSharing(enabled));
      }
      case "/consuming": {
        const { enabled } = body as { enabled?: unknown };
        if (typeof enabled !== "boolean") return json({ error: "enabled (boolean) is required" }, 400);
        return json(await svc.setConsuming(enabled));
      }
      case "/share/models": {
        const { models } = body as { models?: unknown };
        if (!Array.isArray(models)) return json({ error: "models (string[]) is required" }, 400);
        return json(await svc.setShareModels(models.map(String)));
      }
      case "/catalog/publish": {
        const { enabled } = body as { enabled?: unknown };
        if (typeof enabled !== "boolean") return json({ error: "enabled (boolean) is required" }, 400);
        return json(await svc.setCatalogPublishing(enabled));
      }
      case "/catalog/discover": {
        const { enabled } = body as { enabled?: unknown };
        if (typeof enabled !== "boolean") return json({ error: "enabled (boolean) is required" }, 400);
        return json(await svc.setCatalogDiscovery(enabled));
      }
      case "/catalog/configure": {
        const { displayName, contact, port, socksPort, refreshSec, minTopUpUsd } = body as {
          displayName?: string | null;
          contact?: string | null;
          port?: number;
          socksPort?: number;
          refreshSec?: number;
          minTopUpUsd?: number;
        };
        return json(await svc.setCatalogOptions({ displayName, contact, port, socksPort, refreshSec, minTopUpUsd }));
      }
      case "/catalog/refresh":
        return json({ peers: await svc.refreshCatalog() });
      case "/catalog/trust": {
        const { nodeId, fingerprint } = body as { nodeId?: string; fingerprint?: string };
        if (!nodeId) return json({ error: "nodeId is required" }, 400);
        return json({ trust: await svc.trustCatalogPeer(nodeId, fingerprint) });
      }
      case "/catalog/request": {
        const { nodeId, models } = body as { nodeId?: string; models?: string[] };
        if (!nodeId) return json({ error: "nodeId is required" }, 400);
        return json(svc.catalogRequest(nodeId, Array.isArray(models) ? models.map(String) : undefined));
      }
      case "/catalog/connect": {
        const { nodeId, key, id } = body as { nodeId?: string; key?: string; id?: string };
        if (!nodeId || !key) return json({ error: "nodeId and key are required" }, 400);
        return json(await svc.catalogConnect(nodeId, key, { id }));
      }
      case "/publish":
        return json(await svc.publishPorts((body.ports as number[]) ?? []));
      case "/providers/add": {
        const input = providerInput(body);
        if (typeof input === "string") return json({ error: input }, 400);
        return json(await svc.addProvider(input));
      }
      case "/providers/update": {
        // A patch: only what the operator names is changed, the rest is kept.
        const { id, mappedCidr, key, localPort, providerPort } = body as {
          id?: string;
          mappedCidr?: string;
          key?: string;
          localPort?: number;
          providerPort?: number;
        };
        if (!id) return json({ error: "id is required" }, 400);
        return json(await svc.updateProvider(id, { mappedCidr, key, localPort, providerPort }));
      }
      case "/providers/rm": {
        const { id } = body as { id?: string };
        if (!id) return json({ error: "id is required" }, 400);
        return json(await svc.removeProvider(id));
      }
      case "/providers/reconcile":
        return json({ providers: await svc.reconcileProviders({ verifyModels: Boolean(body.verifyModels) }) });
      case "/connect": {
        // phase-3 alias
        const input = providerInput(body);
        if (typeof input === "string") return json({ error: input }, 400);
        return json(await svc.addProvider(input));
      }
      case "/disconnect": {
        const { id } = body as { id?: string };
        if (id) return json(await svc.removeProvider(id));
        return json(await svc.disconnectProvider());
      }
      case "/supervisor/stop":
        await svc.supervisor.stop();
        return json({ ok: true, running: false });
      case "/supervisor/start":
        await svc.start();
        return json({ ok: true, running: svc.supervisor.snapshot().running });
      case "/consumers/add": {
        const { consumerId, models, capUsd, quoteHash, quotePriceVersion } = body as {
          consumerId?: string;
          models?: string[];
          capUsd?: number;
          quoteHash?: string;
          quotePriceVersion?: string;
        };
        if (!consumerId || !Array.isArray(models) || typeof capUsd !== "number") {
          return json({ error: "consumerId, models and capUsd are required" }, 400);
        }
        return json(
          await svc.ensureConsumer(consumerId, models, capUsd, {
            hash: typeof quoteHash === "string" ? quoteHash : undefined,
            priceVersion: typeof quotePriceVersion === "string" ? quotePriceVersion : undefined,
          }),
        );
      }
      case "/consumers/models": {
        const { consumerId, models } = body as { consumerId?: string; models?: string[] };
        if (!consumerId || !Array.isArray(models)) return json({ error: "consumerId and models are required" }, 400);
        return json(await svc.provisioner.setModels(consumerId, models));
      }
      case "/consumers": {
        const { consumerId, models, capUsd } = body as { consumerId?: string; models?: string[]; capUsd?: number };
        if (!consumerId || !Array.isArray(models) || typeof capUsd !== "number") {
          return json({ error: "consumerId, models and capUsd are required" }, 400);
        }
        return json(await svc.ensureConsumer(consumerId, models, capUsd));
      }
      case "/topup": {
        const { consumerId, usd, depositId } = body as { consumerId?: string; usd?: number; depositId?: string };
        if (!consumerId || typeof usd !== "number") return json({ error: "consumerId and usd are required" }, 400);
        return json(await svc.topUp(consumerId, usd, depositId));
      }
      case "/consumers/resolve-gap": {
        const { consumerId, logId, resolvedBy, note, acceptedOffset } = body as {
          consumerId?: string;
          logId?: string;
          resolvedBy?: string;
          note?: string;
          acceptedOffset?: number;
        };
        if (!consumerId || !logId || !resolvedBy || !note) {
          return json({ error: "consumerId, logId, resolvedBy and note are required" }, 400);
        }
        return json(
          await svc.resolveConsumerGap(consumerId, {
            logId,
            resolvedBy,
            note,
            ...(typeof acceptedOffset === "number" ? { acceptedOffset } : {}),
          }),
        );
      }
      case "/consumers/reissue": {
        const { consumerId, acceptPriceVersion, acceptQuoteHash } = body as {
          consumerId?: string;
          acceptPriceVersion?: string;
          acceptQuoteHash?: string;
        };
        if (!consumerId) return json({ error: "consumerId is required" }, 400);
        return json(
          await svc.reissueConsumer(
            consumerId,
            typeof acceptPriceVersion === "string" ? acceptPriceVersion : undefined,
            typeof acceptQuoteHash === "string" ? acceptQuoteHash : undefined,
          ),
        );
      }
      case "/secret": {
        const { consumerId } = body as { consumerId?: string };
        if (!consumerId) return json({ error: "consumerId is required" }, 400);
        return json(await svc.handover(consumerId));
      }
      case "/revoke": {
        const { consumerId } = body as { consumerId?: string };
        if (!consumerId) return json({ error: "consumerId is required" }, 400);
        return json(await svc.revokeConsumer(consumerId));
      }
      case "/guard": {
        const { consumerId } = body as { consumerId?: string };
        if (consumerId) return json({ consumerId, guard: await svc.guardSharedKeys() });
        return json(await svc.guardSharedKeys());
      }
      case "/wallet/network": {
        const { chainId, enabled, rpcEndpoints } = body as { chainId?: number; enabled?: boolean; rpcEndpoints?: string[] };
        if (typeof chainId !== "number") return json({ error: "chainId is required" }, 400);
        const w = svc.requireWallet();
        if (Array.isArray(rpcEndpoints)) w.setRpcEndpoints(chainId, rpcEndpoints.map(String));
        if (typeof enabled === "boolean") w.setNetworkEnabled(chainId, enabled);
        return json({ network: w.registryView().network(chainId) });
      }
      case "/wallet/asset": {
        const { assetId, enabled } = body as { assetId?: string; enabled?: boolean };
        if (!assetId || typeof enabled !== "boolean") return json({ error: "assetId and enabled are required" }, 400);
        return json({ asset: svc.requireWallet().setAssetEnabled(assetId, enabled) });
      }
      case "/wallet/asset/register": {
        const { chainId, contractAddress, symbol, name, expectedDecimals, nanosPerToken, pricingNote } = body as {
          chainId?: number;
          contractAddress?: string;
          symbol?: string;
          name?: string;
          expectedDecimals?: number;
          nanosPerToken?: string;
          pricingNote?: string;
        };
        if (typeof chainId !== "number" || !contractAddress || !symbol || !name || typeof expectedDecimals !== "number" || !nanosPerToken) {
          return json({ error: "chainId, contractAddress, symbol, name, expectedDecimals and nanosPerToken are required" }, 400);
        }
        return json(
          await svc.requireWallet().registerTestAsset({
            chainId,
            contractAddress,
            symbol,
            name,
            expectedDecimals,
            nanosPerToken,
            pricingNote: pricingNote ?? "fixed test rate",
          }),
        );
      }
      case "/wallet/receiving": {
        const { providerId, chainId, address } = body as { providerId?: string; chainId?: number; address?: string };
        if (!providerId || typeof chainId !== "number" || !address) return json({ error: "providerId, chainId and address are required" }, 400);
        return json({ receiving: svc.requireWallet().setReceivingAddress(providerId, chainId, address) });
      }
      case "/wallet/intent": {
        const { providerId, consumerId, chainId, assetId, amountRaw, ttlSec, recipientAddress } = body as {
          providerId?: string;
          consumerId?: string;
          chainId?: number;
          assetId?: string;
          amountRaw?: string;
          ttlSec?: number;
          recipientAddress?: string;
        };
        if (!providerId || !consumerId || typeof chainId !== "number" || !assetId || !amountRaw) {
          return json({ error: "providerId, consumerId, chainId, assetId and amountRaw are required" }, 400);
        }
        return json(
          svc.requireWallet().requestIntent({
            providerId,
            consumerId,
            chainId,
            assetId,
            amountRaw: String(amountRaw),
            ...(typeof ttlSec === "number" ? { ttlSec } : {}),
            ...(recipientAddress ? { recipientAddress } : {}),
          }),
        );
      }
      case "/wallet/intent/sign": {
        const { invoiceId, signature, payerAddress, expectedPayer } = body as {
          invoiceId?: string;
          signature?: string;
          payerAddress?: string;
          expectedPayer?: string;
        };
        if (!invoiceId || !signature || !payerAddress) return json({ error: "invoiceId, signature and payerAddress are required" }, 400);
        return json(svc.requireWallet().signIntent({ invoiceId, signature, payerAddress, expectedPayer: expectedPayer ?? null }));
      }
      case "/wallet/intent/cancel": {
        const { invoiceId, reason } = body as { invoiceId?: string; reason?: string };
        if (!invoiceId) return json({ error: "invoiceId is required" }, 400);
        return json({ intent: svc.requireWallet().cancelIntent(invoiceId, reason ?? "operator cancelled") });
      }
      case "/wallet/scan": {
        const { chainId } = body as { chainId?: number };
        if (typeof chainId !== "number") return json({ error: "chainId is required" }, 400);
        return json({ scan: await svc.requireWallet().scanNow(chainId) });
      }
      case "/wallet/start": {
        svc.startWallet();
        return json({ ok: true, running: svc.walletModule()?.runningChains() ?? [] });
      }
      case "/wallet/stop": {
        svc.walletModule()?.stop();
        return json({ ok: true, running: [] });
      }
      case "/wallet/anomaly/resolve": {
        const { id, note } = body as { id?: number; note?: string };
        if (typeof id !== "number" || !note) return json({ error: "id and note are required" }, 400);
        svc.requireWallet().chainStore().resolveAnomaly(id, note);
        return json({ ok: true });
      }
      case "/verify": {
        const s = await svc.status();
        return json({ checks: s.checks, easytier: s.easytier });
      }
      default:
        return json({ error: `no such endpoint: ${path}` }, 404);
    }
  } catch (e) {
    // Never let a key or a network secret ride out on an error line, even if a
    // tool or a URL mentions it.
    const message = redact(String((e as Error)?.message ?? e));
    logger.error(`${path}: ${message}`);
    return json({ error: message }, 400);
  }
}

/** Reads a provider input, returning `null` for a bad one (handled as 400). */
function providerInput(body: Record<string, unknown>): Parameters<Service["addProvider"]>[0] | string {
  const { id, mappedCidr, key, localPort, providerPort } = body as {
    id?: string;
    mappedCidr?: string;
    key?: string;
    localPort?: number;
    providerPort?: number;
  };
  if (!id || !mappedCidr || !key) return "id, mappedCidr and key are required";
  return { id, mappedCidr, key, localPort, providerPort };
}
