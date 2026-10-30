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
  if (req.method === "GET" && path === "/consumers") {
    const s = await svc.status();
    return json({ consumers: s.consumers });
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
