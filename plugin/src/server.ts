import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Bodies are small operator commands: a 64 KiB cap is generous and bounded. */
const MAX_BODY_BYTES = 64 * 1024;

function apiToken(): string {
  const file = statePath("api-token");
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 32) {
      // A token written by an older version (or restored from a backup) may not
      // be 0600 yet; the read path is also the one that gets the chance to fix it.
      try {
        chmodSync(file, 0o600);
      } catch {
        /* read-only data directory: the token still works */
      }
      return t;
    }
  }
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("hex");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The only Host values this API answers to: its own loopback socket. A browser
 * page that DNS-rebinds its own name to 127.0.0.1 sends no Origin on a GET but
 * always sends its own Host; this is what makes that request a 403.
 */
export function hostAllowed(hostHeader: string | null, port: number): boolean {
  const host = (hostHeader ?? "").trim().toLowerCase();
  const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(host);
  if (!match) return false;
  return Number(match[2]) === port;
}

/** Constant-time bearer comparison; a wrong length is never compared. */
export function tokenMatches(header: string | null, token: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * The host service: a loopback-only HTTP API for scripts and the operator.
 *
 * The plugin's page cannot reach it (Magpie serves plugin pages with
 * `connect-src 'none'`), so the page reads a generated snapshot instead. Every
 * route except `GET /health` needs the bearer token from the plugin state
 * directory: the status carries consumer ids, caps, wallet intents and the
 * credit log tail, and DNS rebinding makes "loopback only" insufficient on its
 * own (see docs/validation/phase8-security.md).
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
      let bound = port;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => handle(req, opts.service, token, bound),
      });
      bound = server.port ?? port;
      writeFileSync(statePath("api-port"), String(bound) + "\n", { mode: 0o600 });
      logger.info(`host API listening on http://127.0.0.1:${bound}`);
      return { port: bound, token, stop: () => server.stop(true) };
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

/** The request handler, exported so tests exercise the real routes without a socket. */
export function createHandler(service: Service, token: string, port: number): (req: Request) => Promise<Response> {
  return (req) => handle(req, service, token, port);
}

/** Reads at most MAX_BODY_BYTES from the stream, so a chunked body cannot grow without bound. */
async function readBodyText(req: Request): Promise<string | Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return json({ error: "body too large" }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: "body could not be read" }, 400);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* a cancelled reader cannot be released again */
    }
  }
  return total === 0 ? "" : new TextDecoder().decode(Buffer.concat(chunks));
}

/** Reads a bounded JSON object body; a `Response` means the request was refused. */
async function readBody(req: Request): Promise<{ body: Record<string, unknown> } | Response> {
  const contentType = req.headers.get("content-type");
  if (contentType && !/^application\/json\b/i.test(contentType.trim())) {
    return json({ error: "content-type must be application/json" }, 415);
  }
  const text = await readBodyText(req);
  if (text instanceof Response) return text;
  if (!text) return { body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "body must be a JSON object" }, 400);
  }
  return { body: parsed as Record<string, unknown> };
}

/**
 * The token-protected reads. `/status` still carries the log tail and the full
 * wallet status: the operator and the CLI are its legitimate readers. The page
 * gets the allowlisted projection (src/page-snapshot.ts) instead.
 */
async function handleGet(req: Request, url: URL, svc: Service): Promise<Response> {
  const path = url.pathname;
  if (path === "/status" || path === "/") {
    const s = await svc.status();
    return json({ ...s, logs: recentLogs(40) });
  }
  if (path === "/checks") return json({ checks: await svc.checks() });
  if (path === "/providers") {
    return json({ sharingEnabled: svc.config()?.sharingEnabled ?? false, consumingEnabled: svc.config()?.consumingEnabled ?? false, providers: svc.providers() });
  }
  if (path === "/share/candidates") return json({ candidates: await svc.shareCandidates() });
  if (path === "/catalog") return json({ catalog: svc.catalogStatus() });
  if (path === "/catalog/peers") return json({ peers: svc.peersInDirectory() });
  if (path === "/accounting") return json({ accounting: svc.accountingStatus() });
  if (path === "/consumers") {
    const s = await svc.status();
    return json({ consumers: s.consumers });
  }
  if (path === "/wallet") return json({ wallet: await svc.walletStatus() });
  if (path === "/wallet/evidence") return json((await svc.walletEvidence()) ?? null);
  if (path === "/wallet/statement") {
    const consumerId = url.searchParams.get("consumerId");
    if (!consumerId || !consumerId.trim() || consumerId.length > 200) {
      return json({ error: "consumerId is required" }, 400);
    }
    return json((await svc.walletStatement(consumerId)) ?? null);
  }
  if (path === "/wallet/networks") {
    const w = svc.walletModule();
    return json({ networks: w ? w.networks() : [] });
  }
  if (path === "/wallet/assets") {
    const w = svc.walletModule();
    return json({ assets: w ? w.allAssets() : [] });
  }
  if (path === "/wallet/intents") {
    const w = svc.walletModule();
    if (!w) return json({ intents: [] });
    return json({ intents: w.intents(url.searchParams.get("consumerId") ?? undefined) });
  }
  if (path === "/wallet/events") {
    const w = svc.walletModule();
    if (!w) return json({ events: [] });
    const tx = url.searchParams.get("tx");
    if (tx) return json({ events: w.chainStore().eventByTx(tx) });
    const chainId = url.searchParams.get("chainId");
    return json({ events: chainId ? w.chainStore().eventsForChain(Number(chainId)) : (await w.status()).events });
  }
  if (path === "/wallet/anomalies") {
    const w = svc.walletModule();
    return json({ anomalies: w ? w.chainStore().anomalies() : [] });
  }
  return json({ error: `no such endpoint: ${path}` }, 404);
}

async function handle(req: Request, svc: Service, token: string, port: number): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!hostAllowed(req.headers.get("host"), port)) {
    return json({ error: "unexpected Host: this API answers only on 127.0.0.1 or localhost at its own port" }, 403);
  }
  const origin = req.headers.get("origin");
  if (origin) return json({ error: "cross-origin requests are not accepted" }, 403);

  // The one anonymous route: liveness only, no status. Everything else, reads
  // included, needs the token.
  if (req.method === "GET" && path === "/health") return json({ ok: true });
  if (!tokenMatches(req.headers.get("authorization"), token)) {
    return json({ error: "unauthorized: send the plugin API token" }, 401);
  }

  try {
    if (req.method === "GET") return await handleGet(req, url, svc);
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    const parsed = await readBody(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed.body;

    switch (path) {
      case "/configure": {
        const requestedModels = (body as { shareModels?: unknown }).shareModels;
        if (Array.isArray(requestedModels) && requestedModels.some((m) => typeof m === "string" && m.includes("*"))) {
          return json(
            { error: "a wildcard shareModels is refused; choose exact native models with reviewed prices (`share models --confirm-exact` after reviewing)" },
            400,
          );
        }
        const input = configureInput(body);
        if (typeof input === "string") return json({ error: input }, 400);
        return json(await svc.configure(input, { strictShareModels: true }));
      }
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
        const { models, confirmExact } = body as { models?: unknown; confirmExact?: unknown };
        if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) {
          return json({ error: "models must be an array of strings" }, 400);
        }
        if (confirmExact !== undefined && typeof confirmExact !== "boolean") {
          return json({ error: "confirmExact must be a boolean" }, 400);
        }
        return json(await svc.setShareModels(models as string[], { confirmExact: confirmExact === true, strict: true }));
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
        const options = catalogOptionsInput(body);
        if (typeof options === "string") return json({ error: options }, 400);
        return json(await svc.setCatalogOptions(options));
      }
      case "/catalog/refresh":
        return json({ peers: await svc.refreshCatalog() });
      case "/catalog/trust": {
        const { nodeId, fingerprint } = body;
        if (typeof nodeId !== "string" || !nodeId) return json({ error: "nodeId is required" }, 400);
        // The exact fingerprint the operator reviewed is mandatory: a missing or
        // made-up value must never accept a first-seen or changed identity.
        if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
          return json({ error: "fingerprint must be the exact 64 lowercase hex characters you reviewed" }, 400);
        }
        return json({ trust: await svc.trustCatalogPeer(nodeId, fingerprint) });
      }
      case "/catalog/request": {
        const { nodeId, models } = body as { nodeId?: string; models?: unknown };
        if (typeof nodeId !== "string" || !nodeId) return json({ error: "nodeId is required" }, 400);
        if (models !== undefined && (!Array.isArray(models) || models.some((m) => typeof m !== "string"))) {
          return json({ error: "models must be an array of provider/model ids" }, 400);
        }
        const acceptance = acceptanceFrom(body);
        if ("error" in acceptance) return json({ error: acceptance.error }, 400);
        return json(svc.catalogRequest(nodeId, models === undefined ? undefined : (models as string[]), acceptance.acceptance));
      }
      case "/catalog/connect": {
        const { nodeId, key, id } = body as { nodeId?: unknown; key?: unknown; id?: unknown };
        if (typeof nodeId !== "string" || !nodeId || typeof key !== "string" || !key) {
          return json({ error: "nodeId and key are required" }, 400);
        }
        if (id !== undefined && typeof id !== "string") return json({ error: "id must be a string" }, 400);
        const acceptance = acceptanceFrom(body);
        if ("error" in acceptance) return json({ error: acceptance.error }, 400);
        return json(await svc.catalogConnect(nodeId, key, { id: id as string | undefined, acceptance: acceptance.acceptance }));
      }
      case "/publish": {
        const ports = body.ports;
        if (!Array.isArray(ports) || ports.some((p) => typeof p !== "number" || !Number.isInteger(p) || p <= 0 || p > 65535)) {
          return json({ error: "ports must be an array of integers in 1..65535" }, 400);
        }
        return json(await svc.publishPorts(ports as number[]));
      }
      case "/providers/add": {
        const input = providerInput(body);
        if (typeof input === "string") return json({ error: input }, 400);
        return json(await svc.addProvider(input));
      }
      case "/providers/update": {
        // A patch: only what the operator names is changed, the rest is kept.
        const { id, mappedCidr, key, localPort, providerPort } = body;
        if (typeof id !== "string" || !id) return json({ error: "id is required" }, 400);
        if (mappedCidr !== undefined && (typeof mappedCidr !== "string" || !mappedCidr.trim())) {
          return json({ error: "mappedCidr must be a non-empty string" }, 400);
        }
        if (key !== undefined && (typeof key !== "string" || !key)) return json({ error: "key must be a non-empty string" }, 400);
        const badPort = [localPort, providerPort].some(
          (p) => p !== undefined && (typeof p !== "number" || !Number.isInteger(p) || p <= 0 || p > 65535),
        );
        if (badPort) return json({ error: "localPort and providerPort must be integers in 1..65535" }, 400);
        return json(
          await svc.updateProvider(id, {
            mappedCidr: mappedCidr as string | undefined,
            key: key as string | undefined,
            localPort: localPort as number | undefined,
            providerPort: providerPort as number | undefined,
          }),
        );
      }
      case "/providers/rm": {
        const { id } = body as { id?: string };
        if (!id) return json({ error: "id is required" }, 400);
        return json(await svc.removeProvider(id));
      }
      case "/providers/reconcile": {
        const { id, verifyModels } = body as { id?: unknown; verifyModels?: unknown };
        if (id !== undefined && (typeof id !== "string" || !id)) return json({ error: "id must be a non-empty string" }, 400);
        const providers = await svc.reconcileProviders({
          verifyModels: verifyModels === true,
          ...(typeof id === "string" ? { only: id } : {}),
        });
        return json({ providers: id === undefined ? providers : providers.filter((p) => p.id === id) });
      }
      case "/providers/models": {
        const { id } = body as { id?: unknown };
        if (typeof id !== "string" || !id) return json({ error: "id is required" }, 400);
        return json(await svc.providerModels(id));
      }
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
        if (typeof consumerId !== "string" || !consumerId || !Array.isArray(models) || models.some((m) => typeof m !== "string") || typeof capUsd !== "number") {
          return json({ error: "consumerId, models and capUsd are required" }, 400);
        }
        return json(
          await svc.ensureConsumer(consumerId, models as string[], capUsd, {
            hash: typeof quoteHash === "string" ? quoteHash : undefined,
            priceVersion: typeof quotePriceVersion === "string" ? quotePriceVersion : undefined,
          }),
        );
      }
      case "/consumers/models": {
        const { consumerId, models } = body as { consumerId?: string; models?: unknown };
        if (typeof consumerId !== "string" || !consumerId || !Array.isArray(models) || models.some((m) => typeof m !== "string")) {
          return json({ error: "consumerId and models are required" }, 400);
        }
        return json(await svc.provisioner.setModels(consumerId, models as string[]));
      }
      case "/consumers": {
        const { consumerId, models, capUsd } = body as { consumerId?: string; models?: unknown; capUsd?: number };
        if (typeof consumerId !== "string" || !consumerId || !Array.isArray(models) || models.some((m) => typeof m !== "string") || typeof capUsd !== "number") {
          return json({ error: "consumerId, models and capUsd are required" }, 400);
        }
        return json(await svc.ensureConsumer(consumerId, models as string[], capUsd));
      }
      case "/topup": {
        const { consumerId, usd, depositId } = body;
        if (typeof consumerId !== "string" || !consumerId || !isNumber(usd) || usd <= 0) {
          return json({ error: "consumerId and a positive usd are required" }, 400);
        }
        if (depositId !== undefined && (typeof depositId !== "string" || !depositId)) {
          return json({ error: "depositId must be a non-empty string" }, 400);
        }
        return json(await svc.topUp(consumerId, usd, depositId as string | undefined));
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
        const { consumerId } = body;
        if (typeof consumerId !== "string" || !consumerId) return json({ error: "consumerId is required" }, 400);
        return json(await svc.handover(consumerId));
      }
      case "/revoke": {
        const { consumerId } = body;
        if (typeof consumerId !== "string" || !consumerId) return json({ error: "consumerId is required" }, 400);
        return json(await svc.revokeConsumer(consumerId));
      }
      case "/guard": {
        const { consumerId } = body as { consumerId?: string };
        if (consumerId) return json({ consumerId, guard: await svc.guardSharedKeys() });
        return json(await svc.guardSharedKeys());
      }
      case "/wallet/network": {
        const { chainId, enabled, rpcEndpoints } = body;
        if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) {
          return json({ error: "chainId must be a positive integer" }, 400);
        }
        if (enabled !== undefined && typeof enabled !== "boolean") return json({ error: "enabled must be a boolean" }, 400);
        if (rpcEndpoints !== undefined && (!Array.isArray(rpcEndpoints) || rpcEndpoints.some((e) => typeof e !== "string"))) {
          return json({ error: "rpcEndpoints must be an array of URLs" }, 400);
        }
        const w = svc.requireWallet();
        if (Array.isArray(rpcEndpoints)) w.setRpcEndpoints(chainId, rpcEndpoints as string[]);
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
        const { providerId, consumerId, chainId, assetId, amountRaw, ttlSec, recipientAddress } = body;
        if (
          typeof providerId !== "string" || !providerId ||
          typeof consumerId !== "string" || !consumerId ||
          !isInt(chainId, 1, Number.MAX_SAFE_INTEGER) ||
          typeof assetId !== "string" || !assetId ||
          typeof amountRaw !== "string" || !amountRaw
        ) {
          return json({ error: "providerId, consumerId, chainId, assetId and amountRaw are required" }, 400);
        }
        if (ttlSec !== undefined && !isInt(ttlSec, 1, 30 * 24 * 3600)) return json({ error: "ttlSec must be an integer in 1..2592000" }, 400);
        if (recipientAddress !== undefined && (typeof recipientAddress !== "string" || !recipientAddress)) {
          return json({ error: "recipientAddress must be a non-empty string" }, 400);
        }
        return json(
          svc.requireWallet().requestIntent({
            providerId,
            consumerId,
            chainId,
            assetId,
            amountRaw,
            ...(ttlSec !== undefined ? { ttlSec } : {}),
            ...(recipientAddress !== undefined ? { recipientAddress } : {}),
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
    // tool or a URL mentions it; and never echo the request body.
    const message = redact(String((e as Error)?.message ?? e)).slice(0, 300);
    logger.error(`${path}: ${message}`);
    return json({ error: message }, 400);
  }
}

/** The exact identity/quote a human accepted; the service checks it against the peer. */
function acceptanceFrom(
  body: Record<string, unknown>,
): { acceptance: { fingerprint: string; quoteHash: string; priceVersion?: string } } | { error: string } {
  const hex64 = /^[0-9a-f]{64}$/;
  const { fingerprint, quoteHash, priceVersion } = body;
  if (typeof fingerprint !== "string" || !hex64.test(fingerprint)) {
    return { error: "fingerprint must be 64 lowercase hex characters" };
  }
  if (typeof quoteHash !== "string" || !hex64.test(quoteHash)) {
    return { error: "quoteHash must be 64 lowercase hex characters" };
  }
  if (priceVersion !== undefined && (typeof priceVersion !== "string" || !hex64.test(priceVersion))) {
    return { error: "priceVersion must be 64 lowercase hex characters" };
  }
  return { acceptance: { fingerprint, quoteHash, ...(priceVersion !== undefined ? { priceVersion } : {}) } };
}

/** Reads a provider input, returning a message for a bad one (handled as 400). */
function providerInput(body: Record<string, unknown>): Parameters<Service["addProvider"]>[0] | string {
  const { id, mappedCidr, key, localPort, providerPort } = body;
  if (typeof id !== "string" || !id.trim()) return "id is required";
  if (typeof mappedCidr !== "string" || !mappedCidr.trim()) return "mappedCidr is required";
  if (typeof key !== "string" || !key) return "key is required";
  const port = (value: unknown, name: string): number | undefined | string => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 65535) {
      return `${name} must be an integer in 1..65535`;
    }
    return value;
  };
  const local = port(localPort, "localPort");
  if (typeof local === "string") return local;
  const remote = port(providerPort, "providerPort");
  if (typeof remote === "string") return remote;
  return { id, mappedCidr, key, ...(local !== undefined ? { localPort: local } : {}), ...(remote !== undefined ? { providerPort: remote } : {}) };
}

// --- request-shape validation -------------------------------------------------
//
// `/configure` is the one route that can change the overlay, so a value that is
// only *cast* is not enough: `sharingEnabled: "false"` is truthy in JavaScript.
// Each field is checked here by type before the service sees it, and unknown
// fields are refused instead of silently ignored.

const isString = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function unknownFields(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  return extra.length ? `unknown field${extra.length > 1 ? "s" : ""}: ${extra.slice(0, 5).join(", ")}` : null;
}

const CONFIGURE_FIELDS = [
  "role",
  "sharingEnabled",
  "consumingEnabled",
  "networkName",
  "networkSecret",
  "peers",
  "listenAddr",
  "publishedPorts",
  "secureMode",
  "rpcPort",
  "virtualIpv4",
  "shareModels",
  "catalogEnabled",
  "catalogDiscovery",
  "catalogDisplayName",
  "catalogContact",
  "catalogPort",
  "catalogSocksPort",
  "catalogRefreshSec",
  "catalogMinTopUpUsd",
] as const;

type ConfigureInput = Parameters<Service["configure"]>[0];

export function configureInput(body: Record<string, unknown>): ConfigureInput | string {
  const unknown = unknownFields(body, CONFIGURE_FIELDS);
  if (unknown) return unknown;
  const out: Record<string, unknown> = {};
  if (body.role !== undefined) {
    if (body.role !== "provider" && body.role !== "consumer") return "role must be provider or consumer";
    out.role = body.role;
  }
  for (const key of ["sharingEnabled", "consumingEnabled", "secureMode", "catalogEnabled", "catalogDiscovery"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isBool(value)) return `${key} must be a boolean`;
    out[key] = value;
  }
  for (const key of ["networkName", "networkSecret", "virtualIpv4"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isString(value)) return `${key} must be a string`;
    out[key] = value;
  }
  for (const key of ["listenAddr", "catalogDisplayName", "catalogContact"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && !isString(value)) return `${key} must be a string or null`;
    out[key] = value;
  }
  for (const key of ["peers", "shareModels"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => !isString(v))) return `${key} must be an array of strings`;
    out[key] = value;
  }
  if (body.publishedPorts !== undefined) {
    const value = body.publishedPorts;
    if (!Array.isArray(value) || value.some((p) => !isInt(p, 1, 65535))) return "publishedPorts must be integers in 1..65535";
    out.publishedPorts = value;
  }
  for (const key of ["rpcPort", "catalogPort", "catalogSocksPort"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isInt(value, 1, 65535)) return `${key} must be an integer in 1..65535`;
    out[key] = value;
  }
  if (body.catalogRefreshSec !== undefined) {
    const value = body.catalogRefreshSec;
    if (!isNumber(value) || value < 1 || value > 86_400) return "catalogRefreshSec must be a number in 1..86400";
    out.catalogRefreshSec = value;
  }
  if (body.catalogMinTopUpUsd !== undefined) {
    const value = body.catalogMinTopUpUsd;
    if (!isNumber(value) || value < 0 || value > 1_000_000) return "catalogMinTopUpUsd must be a number in 0..1000000";
    out.catalogMinTopUpUsd = value;
  }
  return out as ConfigureInput;
}

type CatalogOptionsInput = Parameters<Service["setCatalogOptions"]>[0];

function catalogOptionsInput(body: Record<string, unknown>): CatalogOptionsInput | string {
  const unknown = unknownFields(body, ["displayName", "contact", "port", "socksPort", "refreshSec", "minTopUpUsd"]);
  if (unknown) return unknown;
  const out: Record<string, unknown> = {};
  for (const key of ["displayName", "contact"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && !isString(value)) return `${key} must be a string or null`;
    out[key] = value;
  }
  for (const key of ["port", "socksPort"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isInt(value, 1, 65535)) return `${key} must be an integer in 1..65535`;
    out[key] = value;
  }
  for (const key of ["refreshSec"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isNumber(value) || value < 1 || value > 86_400) return `${key} must be a number in 1..86400`;
    out[key] = value;
  }
  for (const key of ["minTopUpUsd"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (!isNumber(value) || value < 0 || value > 1_000_000) return `${key} must be a number in 0..1000000`;
    out[key] = value;
  }
  return out as CatalogOptionsInput;
}
