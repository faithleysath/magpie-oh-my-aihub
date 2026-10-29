import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stateDir, statePath } from "./paths.ts";
import { logger, recentLogs } from "./log.ts";
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
      case "/publish":
        return json(await svc.publishPorts((body.ports as number[]) ?? []));
      case "/connect": {
        const { id, mappedCidr, key, localPort, providerPort } = body as {
          id?: string;
          mappedCidr?: string;
          key?: string;
          localPort?: number;
          providerPort?: number;
        };
        if (!id || !mappedCidr || !key) return json({ error: "id, mappedCidr and key are required" }, 400);
        return json(await svc.connectProvider({ id, mappedCidr, key, localPort, providerPort }));
      }
      case "/supervisor/stop":
        await svc.supervisor.stop();
        return json({ ok: true, running: false });
      case "/supervisor/start":
        await svc.start();
        return json({ ok: true, running: svc.supervisor.snapshot().running });
      case "/disconnect":
        return json(await svc.disconnectProvider());
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
      case "/secret": {
        const { consumerId } = body as { consumerId?: string };
        if (!consumerId) return json({ error: "consumerId is required" }, 400);
        return json(await svc.handover(consumerId));
      }
      case "/revoke": {
        const { consumerId } = body as { consumerId?: string };
        if (!consumerId) return json({ error: "consumerId is required" }, 400);
        return json(await svc.provisioner.revoke(consumerId));
      }
      case "/verify": {
        const s = await svc.status();
        return json({ checks: s.checks, easytier: s.easytier });
      }
      default:
        return json({ error: `no such endpoint: ${path}` }, 404);
    }
  } catch (e) {
    logger.error(`${path}: ${String(e)}`);
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
}
