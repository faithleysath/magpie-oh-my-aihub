#!/usr/bin/env bun
// Operator CLI for the plugin host API. It never talks to Magpie directly for
// state changes: Magpie's own plugin does, with its binary and argv arrays.
//
//   bun bin/ohmyaihub.ts --data <magpie config dir> setup [--resume|--check|--reconfigure]
//   ... share setup | share approve <request.json> --cap <usd> | share handover <id> --key-file <0600>
//   ... connect [--node <id>] [--fingerprint <sha256> --quote <sha256>] [--key-file <0600>]
//   ... remote list|test|models|update-key|add|remove|recover
//   ... status
//   ... providers                                   list remote providers
//   ... provider add <id> --cidr 10.66.a.b/32 --key sk-… [--port 3425] [--local-port 13425]
//   ... provider update <id> [--cidr …] [--key …] [--port …]
//   ... provider rm <id>
//   ... provider reconcile
//   ... share on|off            publish (or withdraw) this node's own Magpie
//   ... share models [<glob>…]  the native models that may be shared
//   ... consume on|off          use (or stop using) remote providers
//   ... configure --network <name> --secret <secret> --peer tcp://host:11010 [--share|--no-share] [--consume|--no-consume]
//   ... consumers add <id> <model[,model]> <capUsd> [--quote-hash <sha256> --quote-price-version <sha256>]
//   ... consumers models <id> <model[,model]>
//   ... consumers reissue <id> [--accept-price-version <sha256>] [--accept-quote-hash <sha256>]
//   ... consumers resolve-gap <id> --log-id <id> --by <who> --note <text> [--accepted-offset N]
//   ... topup <id> <usd> [--deposit-id <id>]
//   ... revoke <id>
//   ... accounting                the periodic accounting check's state
//   ... checks
//
// Chain wallet (phase 7). Every network is a peer; none is a default.
//   ... wallet                          registry, chain health, totals
//   ... wallet networks                 every registered network
//   ... wallet network <chainId> [--enable|--disable] [--rpc <url>[,<url>]]
//   ... wallet assets [<chainId>]
//   ... wallet asset-register <chainId> <contract> <symbol> <name> <decimals> [--nanos-per-token N] [--note <text>]
//   ... wallet asset <assetId> [--enable|--disable]
//   ... wallet receiving <providerId> <chainId> <address>
//   ... wallet intents [<consumerId>]
//   ... wallet intent <providerId> <consumerId> <chainId> <assetId> <amountRaw> [--ttl <sec>]
//   ... wallet sign <invoiceId> <signature> <payerAddress> [--expect <address>]
//   ... wallet cancel <invoiceId> [--reason <text>]
//   ... wallet events [--chain <chainId>] [--tx <hash>]
//   ... wallet scan <chainId>
//   ... wallet start | wallet stop
//   ... wallet anomalies [--chain <chainId>] | wallet resolve <id> --note <text>
//   ... wallet status                    view model from local evidence
//   ... wallet statement <consumerId> [--out <directory>] [--print]
//   ... wallet credit <consumerId>       chain credit as the ledger sees it
//   ... wallet wizard                    guided one-deposit request (needs host evidence)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, fail, limitDisplay, promptText, readSecretFile, writeSecretFile } from "./operator-lib.ts";
import { runSetup } from "./operator-setup.ts";
import { runShare } from "./operator-share.ts";
import { runConnect } from "./operator-connect.ts";
import { runRemote } from "./operator-remote.ts";
import { redact } from "../src/log.ts";

const argv = process.argv.slice(2);
let dataDir = process.env.OH_MY_AIHUB_DATA || "";
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--data") dataDir = argv[++i];
  else rest.push(argv[i]);
}
if (!dataDir) {
  console.error("pass --data <magpie config dir> (the folder holding plugins.json)");
  process.exit(2);
}

function fatal(e: unknown): never {
  const message = (e as Error)?.message ?? String(e);
  if (process.env.OH_MY_AIHUB_DEBUG === "1") console.error(e);
  else console.error(`error: ${redact(message)}`);
  process.exit(1);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

let credentials: { port: string; token: string } | null = null;
function apiCredentials(): { port: string; token: string } {
  if (credentials) return credentials;
  try {
    const port = readFileSync(join(dataDir, "oh-my-aihub", "api-port"), "utf8").trim();
    const token = readFileSync(join(dataDir, "oh-my-aihub", "api-token"), "utf8").trim();
    if (!port || !token) fail(`the plugin host credentials in ${join(dataDir, "oh-my-aihub")} are empty`);
    credentials = { port, token };
    return credentials;
  } catch (e) {
    if (e instanceof CliError) throw e;
    fail(
      `the plugin host is not running for ${dataDir} (no api-port/api-token). ` +
        `Install it with \`magpie plugin add <plugin path>\`, restart Magpie, then retry.`,
    );
  }
}

async function call(method: string, path: string, body?: unknown, timeoutOverride?: number): Promise<any> {
  const { port, token } = apiCredentials();
  const timeoutMs = Number(timeoutOverride ?? flag("timeout-ms") ?? process.env.OH_MY_AIHUB_API_TIMEOUT_MS ?? 60_000);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(100, timeoutMs)),
    });
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (/abort|timeout|timed\s*out/i.test(message)) {
      fail(`the plugin host did not answer ${method} ${path} within ${timeoutMs}ms; it may still be applying the change — run status/checks before retrying`);
    }
    fail(`cannot reach the plugin host on 127.0.0.1:${port}: ${redact(message)}`);
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const safe = typeof json?.error === "string" ? redact(json.error).split("\n")[0].slice(0, 400) : "";
    fail(`HTTP ${res.status}${safe ? `: ${safe}` : " (no safe error message)"}`);
  }
  return json ?? text;
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
function has(name: string): boolean {
  return rest.includes(`--${name}`);
}
function allFlags(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== `--${name}`) continue;
    const value = rest[i + 1];
    if (value !== undefined && !value.startsWith("--")) out.push(value);
  }
  return out;
}
/** A key may come from argv for compatibility or from an owner-only file. */
function keyFlag(): string | undefined {
  const direct = flag("key");
  if (direct) return direct;
  const file = flag("key-file");
  return file ? readSecretFile(file, "Gateway Key") : undefined;
}
function positional(offset: number): string[] {
  return rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--"))).slice(offset);
}

async function statementFromEvidence(evidence: any, consumerId: string, providerId: string): Promise<any> {
  const consumer = (evidence.consumers ?? []).find((c: any) => c.consumerId === consumerId);
  if (!consumer) fail(`no consumer ${consumerId}`);
  const { buildStatement } = await import("../src/walletstatement.ts");
  const networks = (evidence.wallet.registry?.networks ?? []).map((n: any) => ({
    ...n,
    family: "evm",
    rpcEndpoints: n.endpoints ?? [],
    nativeSymbol: "",
    reorgDepth: n.finality?.confirmations ?? 0,
    scanIntervalSec: 0,
    maxBlockRange: 0,
    notes: null,
  }));
  const assets = (evidence.wallet.registry?.assets ?? []).map((a: any) => ({
    ...a,
    pricing: { nanosPerToken: a.nanosPerToken, version: a.priceVersion, kind: "fixed-test-rate", note: "" },
  }));
  return buildStatement({
    providerId,
    consumerId,
    generatedAt: new Date().toISOString(),
    networks,
    assets,
    intents: evidence.wallet.intents ?? [],
    events: evidence.wallet.events ?? [],
    deposits: evidence.deposits?.[consumerId] ?? [],
    consumer,
    // The statement allowlist is state/reason/openSettlements; `serving` is a
    // live view field and is deliberately not written into a historical file.
    accounting: {
      state: evidence.accounting.state,
      reason: evidence.accounting.reason,
      openSettlements: consumer.ledger?.openSettlements ?? 0,
    },
    readback: evidence.readbacks?.[consumerId] ?? null,
  } as never);
}

function printProviders(providers: any[]): void {
  if (!providers.length) {
    console.log("no remote providers");
    return;
  }
  for (const p of providers) {
    const fp = p.fingerprint ? ` peer=${p.fingerprint.hostname}${p.fingerprint.peerId ? `#${p.fingerprint.peerId}` : ""}` : "";
    const lim = ` ${limitDisplay(p.limit).text}`;
    console.log(
      `${p.id}  ${p.mappedCidr}:${p.providerPort} -> 127.0.0.1:${p.localPort}  ${p.status}` +
        `${p.detail ? ` (${p.detail})` : ""}${fp}${lim}`,
    );
  }
}

function printCatalogPeers(peers: any[]): void {
  if (!peers.length) {
    console.log("no catalogue peers (enable discovery, or wait for a refresh)");
    return;
  }
  for (const p of peers) {
    const where = p.mappedCidr ? `${p.mappedCidr}:${p.catalogPort ?? "?"}` : "no exported address";
    const route = p.route ? `${p.route}${p.latencyMs ? ` ${p.latencyMs}ms` : ""}` : "?";
    const fp = p.identity ? ` id=${p.identity.keyId} ${p.identity.fingerprint.slice(0, 12)}…` : " id=—";
    const quote = p.quote ? ` quote v${p.quote.publication.version} (${p.quote.models.length} models)` : " quote=—";
    console.log(`${p.hostname}  ${p.virtualIpv4}  ${where}  ${route}  ${p.status}${fp}${quote}${p.detail ? `  — ${p.detail}` : ""}`);
  }
}

const cmd = rest[0];
// Phase-8 journeys. They are separate modules so the legacy switch below stays
// small; each journey owns its own file and tests.
// `OH_MY_AIHUB_PREFLIGHT_LAN=none` is for isolated fixtures: it skips the
// best-effort LAN gateway probe so a test process never opens a socket to a real
// gateway. It changes a warning only; it never relaxes an enforcement check.
const preflightDeps = { preflight: { lan: process.env.OH_MY_AIHUB_PREFLIGHT_LAN === "none" ? null : undefined } };
if (cmd === "setup") process.exit(await runSetup(rest.slice(1), dataDir, undefined, preflightDeps));
if (cmd === "resume") process.exit(await runSetup(["--resume", ...rest.slice(1)], dataDir, undefined, preflightDeps));
if (cmd === "preflight" || cmd === "doctor") process.exit(await runSetup(["--check", ...rest.slice(1)], dataDir, undefined, preflightDeps));
if (cmd === "connect") process.exit(await runConnect(rest.slice(1), dataDir));
if (cmd === "remote") process.exit(await runRemote(rest.slice(1), dataDir));
if (
  cmd === "share" &&
  (!rest[1] || rest[1].startsWith("--") || ["setup", "approve", "handover", "list", "status"].includes(rest[1]))
) {
  process.exit(await runShare(rest.slice(1), dataDir));
}
switch (cmd) {
  case "status": {
    const s = await call("GET", "/status");
    console.log(
      JSON.stringify(
        {
          sharing: s.config?.sharingEnabled ?? false,
          sharingActive: s.config?.sharingActive ?? false,
          shareSuspended: s.config?.shareSuspended ?? null,
          consuming: s.config?.consumingEnabled ?? false,
          node: {
            id: s.config?.nodeId,
            hostname: s.config?.hostname,
            virtualIpv4: s.config?.virtualIpv4,
            mappedCidr: s.config?.mappedCidr,
            publishedPorts: s.config?.publishedPorts,
          },
          network: s.config?.networkName,
          shareModels: s.config?.share?.models,
          nativeProviders: s.config?.nativeProviders,
          remoteProviders: s.config?.remoteProviders,
          easytier: {
            running: s.easytier?.running,
            pid: s.easytier?.pid,
            version: s.easytier?.coreVersion,
            virtualIpv4: s.easytier?.virtualIpv4,
            export: s.easytier?.proxyCidr ? `${s.easytier.proxyCidr} -> ${s.easytier.mappedCidr}` : null,
            aclOk: s.easytier?.aclOk,
            aclProblems: s.easytier?.aclProblems,
            peers: (s.easytier?.peers || []).map((p: any) => `${p.hostname || p.ipv4} ${p.ipv4} ${p.cost} ${p.latencyMs}ms`),
          },
          providers: (s.providers ?? []).map((p: any) => {
            const lim = limitDisplay(p.limit);
            return { ...p, limitText: lim.text, limitUnsafe: lim.unsafe };
          }),
          consumers: s.consumers,
          catalog: s.catalog
            ? {
                publishing: s.catalog.publishing,
                server: s.catalog.server,
                quote: s.catalog.quote,
                peers: s.catalog.peers,
                lastRefreshAt: s.catalog.lastRefreshAt,
              }
            : null,
          checks: s.checks,
          checksAt: s.checksAt ?? null,
          readiness: s.readiness ?? null,
        },
        null,
        2,
      ),
    );
    break;
  }
  case "providers": {
    const r = await call("GET", "/providers");
    if (has("json")) console.log(JSON.stringify(r, null, 2));
    else printProviders(r.providers);
    break;
  }
  case "provider": {
    const sub = rest[1];
    if (sub === "add" || sub === "update") {
      const [id] = positional(2);
      if (!id) throw new Error(`provider ${sub} <id> --cidr … --key …`);
      if (sub === "add") {
        const p = await call("POST", "/providers/add", {
          id,
          mappedCidr: flag("cidr"),
          key: keyFlag(),
          providerPort: flag("port") ? Number(flag("port")) : undefined,
          localPort: flag("local-port") ? Number(flag("local-port")) : undefined,
        });
        console.log(JSON.stringify(p, null, 2));
      } else {
        const p = await call("POST", "/providers/update", {
          id,
          mappedCidr: flag("cidr"),
          key: keyFlag(),
          providerPort: flag("port") ? Number(flag("port")) : undefined,
          localPort: flag("local-port") ? Number(flag("local-port")) : undefined,
        });
        console.log(JSON.stringify(p, null, 2));
      }
    } else if (sub === "rm") {
      const [id] = positional(2);
      if (!id) throw new Error("provider rm <id>");
      console.log(JSON.stringify(await call("POST", "/providers/rm", { id }), null, 2));
    } else if (sub === "reconcile") {
      const r = await call("POST", "/providers/reconcile", { verifyModels: true });
      printProviders(r.providers);
    } else if (sub === "list" || sub === undefined) {
      printProviders((await call("GET", "/providers")).providers);
    } else {
      throw new Error("provider add|update|rm|reconcile|list");
    }
    break;
  }
  case "share": {
    const sub = rest[1];
    if (sub === "on" || sub === "off") {
      const s = await call("POST", "/sharing", { enabled: sub === "on" });
      console.log(JSON.stringify({ ok: true, sharing: s.config.sharingEnabled, export: s.easytier?.proxyCidr, mappedCidr: s.config.mappedCidr }, null, 2));
    } else if (sub === "models") {
      const models = positional(2);
      if (!models.length) {
        const s = await call("GET", "/status");
        console.log((s.config?.share?.models ?? []).join("\n"));
      } else {
        const s = await call("POST", "/share/models", { models });
        console.log(JSON.stringify({ ok: true, shareModels: s.config.share.models }, null, 2));
      }
    } else {
      throw new Error("share on|off|models");
    }
    break;
  }
  case "consume": {
    const sub = rest[1];
    if (sub !== "on" && sub !== "off") throw new Error("consume on|off");
    const s = await call("POST", "/consuming", { enabled: sub === "on" });
    console.log(JSON.stringify({ ok: true, consuming: s.config.consumingEnabled, providers: s.providers }, null, 2));
    break;
  }
  case "configure": {
    const peers = allFlags("peer");
    const role = flag("role");
    const secretFile = flag("secret-file");
    const body: Record<string, unknown> = {
      role: role || undefined,
      sharingEnabled: has("share") ? true : has("no-share") ? false : role ? role === "provider" : undefined,
      consumingEnabled: has("consume") ? true : has("no-consume") ? false : role ? role === "consumer" : undefined,
      networkName: flag("network"),
      publishedPorts: flag("ports") ? flag("ports")!.split(",").map(Number) : undefined,
      virtualIpv4: flag("virtual-ip"),
      shareModels: flag("share-models") ? flag("share-models")!.split(",") : undefined,
    };
    if (secretFile) body.networkSecret = readSecretFile(secretFile, "network secret");
    else if (flag("secret")) body.networkSecret = flag("secret");
    if (peers.length) body.peers = peers;
    if (has("listen")) body.listenAddr = flag("listen") ?? "";
    const s = await call("POST", "/configure", body);
    console.log(
      JSON.stringify(
        {
          ok: true,
          sharing: s.config.sharingEnabled,
          consuming: s.config.consumingEnabled,
          mappedCidr: s.config.mappedCidr,
          virtualIpv4: s.config.virtualIpv4,
        },
        null,
        2,
      ),
    );
    break;
  }
  case "connect": {
    const s = await call("POST", "/providers/add", {
      id: flag("id"),
      mappedCidr: flag("cidr"),
      key: flag("key"),
      localPort: flag("local-port") ? Number(flag("local-port")) : undefined,
      providerPort: flag("port") ? Number(flag("port")) : undefined,
    });
    console.log(JSON.stringify({ ok: true, provider: s }, null, 2));
    break;
  }
  case "disconnect": {
    const id = flag("id");
    const r = await call("POST", "/disconnect", id ? { id } : {});
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case "consumers": {
    if (rest[1] === "add") {
      const [id, models, cap] = positional(2);
      if (!id || !models || !cap) throw new Error("consumers add <id> <model[,model]> <capUsd>");
      const c = await call("POST", "/consumers/add", {
        consumerId: id,
        models: models.split(","),
        capUsd: Number(cap),
        quoteHash: flag("quote-hash"),
        quotePriceVersion: flag("quote-price-version"),
      });
      console.log(JSON.stringify(c, null, 2));
    } else if (rest[1] === "reissue") {
      const id = positional(2)[0];
      if (!id) throw new Error("consumers reissue <id> [--accept-price-version <sha256>] [--accept-quote-hash <sha256>]");
      const c = await call("POST", "/consumers/reissue", {
        consumerId: id,
        acceptPriceVersion: flag("accept-price-version"),
        acceptQuoteHash: flag("accept-quote-hash"),
      });
      console.log(JSON.stringify(c, null, 2));
    } else if (rest[1] === "resolve-gap") {
      const id = positional(2)[0];
      const logId = flag("log-id");
      const resolvedBy = flag("by");
      const note = flag("note");
      if (!id || !logId || !resolvedBy || !note) {
        throw new Error("consumers resolve-gap <id> --log-id <id> --by <who> --note <what happened> [--accepted-offset N]");
      }
      const offset = flag("accepted-offset");
      const c = await call("POST", "/consumers/resolve-gap", {
        consumerId: id,
        logId,
        resolvedBy,
        note,
        ...(offset ? { acceptedOffset: Number(offset) } : {}),
      });
      console.log(JSON.stringify(c, null, 2));
    } else if (rest[1] === "models") {
      const [id, models] = positional(2);
      if (!id || !models) throw new Error("consumers models <id> <model[,model]>");
      const c = await call("POST", "/consumers/models", { consumerId: id, models: models.split(",") });
      console.log(JSON.stringify(c, null, 2));
    } else {
      const s = await call("GET", "/status");
      console.log(JSON.stringify(s.consumers, null, 2));
    }
    break;
  }
  case "accounting": {
    const r = await call("GET", "/accounting");
    console.log(JSON.stringify(r.accounting, null, 2));
    break;
  }
  case "topup": {
    const [id, usd] = positional(1);
    const c = await call("POST", "/topup", {
      consumerId: id,
      usd: Number(usd),
      depositId: flag("deposit-id"),
    });
    console.log(JSON.stringify(c, null, 2));
    break;
  }
  case "secret": {
    const [id] = positional(1);
    const c = await call("POST", "/secret", { consumerId: id });
    const keyFile = flag("key-file");
    if (keyFile) {
      const file = writeSecretFile(keyFile, c.key, { force: has("force") });
      console.log(JSON.stringify({ consumerId: id, keyFile: file, keyName: c.keyName, keyPrinted: false }, null, 2));
    } else {
      console.log(c.key);
    }
    break;
  }
  case "revoke": {
    const [id] = positional(1);
    const c = await call("POST", "/revoke", { consumerId: id });
    console.log(JSON.stringify(c, null, 2));
    break;
  }
  case "guard": {
    console.log(JSON.stringify(await call("POST", "/guard", {}), null, 2));
    break;
  }
  case "stop":
  case "start": {
    const r = await call("POST", cmd === "stop" ? "/supervisor/stop" : "/supervisor/start", {});
    console.log(JSON.stringify(r));
    break;
  }
  case "wallet": {
    const sub = rest[1];
    if (sub === "wizard") {
      // The wizard is its own module; this entry only adapts the loopback client
      // and the visible prompt. A POST whose outcome is unknown is surfaced as
      // such so the wizard never blindly retries an intent.
      const { runWalletWizard, WizardApiError } = await import("./wallet-wizard.ts");
      const wrap = async (run: () => Promise<any>): Promise<any> => {
        try {
          return await run();
        } catch (e) {
          const message = (e as Error)?.message ?? String(e);
          const status = Number(/HTTP\s+(\d+)/.exec(message)?.[1] ?? NaN);
          throw new WizardApiError(message, Number.isFinite(status) ? status : null);
        }
      };
      const code = await runWalletWizard({
        api: {
          get: (path) => wrap(() => call("GET", path)),
          post: (path, body) => wrap(() => call("POST", path, body)),
        },
        io: {
          prompt: async (question, opts) => {
            const answer = (await promptText(`${question}${opts?.default ? ` [${opts.default}]` : ""}: `)).trim();
            return answer || opts?.default || "";
          },
          print: (text) => console.log(text),
        },
        argv: rest.slice(2),
        evidence: async () => {
          try {
            return await call("GET", "/wallet/evidence", undefined, 15_000);
          } catch {
            return null;
          }
        },
      });
      process.exit(code);
    }
    if (sub === "statement") {
      const consumerId = positional(2)[0];
      if (!consumerId) throw new Error("wallet statement <consumerId> [--out <directory|file.json>] [--provider <id>] [--print]");
      let statement: any = null;
      try {
        const response = await call("GET", `/wallet/statement?consumerId=${encodeURIComponent(consumerId)}`, undefined, 60_000);
        statement = response?.statement?.statement ? response.statement : response;
      } catch (e) {
        if (!/HTTP 404/.test((e as Error).message)) throw e;
      }
      if (!statement) {
        const evidence = await call("GET", "/wallet/evidence", undefined, 60_000);
        if (!evidence || !evidence.wallet) fail("the host did not return wallet evidence; update the plugin host");
        const providerId = flag("provider") ?? evidence.wallet.receiving?.[0]?.providerId;
        if (!providerId) fail("this node has no receiving provider; pass --provider <id>");
        statement = await statementFromEvidence(evidence, consumerId, providerId);
      }
      const { statementText, writeStatementFile, verifyStatement } = await import("../src/walletstatement.ts");
      const check = verifyStatement(statement);
      if (!check.ok) fail(`statement verification failed: ${check.reason}`);
      const out = flag("out");
      let statementFile: string;
      if (out && /\.json$/i.test(out)) {
        // Exact file path: use the statement writer's hardened {path} branch.
        // --force keeps the older exact-file overwrite escape hatch.
        statementFile = has("force")
          ? writeSecretFile(out, statementText(statement), { force: true })
          : writeStatementFile(statement, { path: out }).path;
      } else {
        const outDir = out ?? join(dataDir, "oh-my-aihub", "statements");
        statementFile = writeStatementFile(statement, { dir: outDir }).path;
      }
      console.log(JSON.stringify({ consumerId, statementFile, digest: statement.digest, keyPrinted: false }, null, 2));
      if (has("print")) console.log(statementText(statement));
    } else if (sub === "status") {
      let evidence: any = null;
      try {
        evidence = await call("GET", "/wallet/evidence", undefined, 60_000);
      } catch (e) {
        if (!/HTTP 404/.test((e as Error).message)) throw e;
      }
      if (evidence?.wallet) {
        const { accountingLine, walletView } = await import("../src/walletview.ts");
        const view = walletView(evidence);
        console.log(
          JSON.stringify(
            {
              generatedAt: view.generatedAt,
              disabled: view.disabled,
              chains: view.chains,
              deposits: view.deposits,
              // The view model already carries every field; the line is the
              // same accounting sentence the wizard prints, so a status reader
              // sees credit/consumed/settled/balance/overdraft/unsettled/cap/
              // used/price/window/key without reconstructing it.
              consumers: view.consumers.map((c) => ({ ...c, line: accountingLine(c) })),
              alerts: view.alerts,
              truncated: view.truncated,
              evidence: view.evidence,
            },
            null,
            2,
          ),
        );
        break;
      }
      const r = await call("GET", "/wallet");
      const w = r.wallet;
      if (!w) {
        console.log("no chain wallet: no network is enabled on this node");
        break;
      }
      console.log(JSON.stringify({
        disabled: w.disabled,
        registry: w.registry,
        chains: w.chains,
        totals: w.totals,
        consumers: w.consumers ?? [],
      }, null, 2));
    } else if (sub === "network") {
      const chainId = Number(positional(2)[0]);
      if (!Number.isInteger(chainId)) throw new Error("wallet network <chainId> [--enable|--disable] [--rpc url[,url]]");
      const body: Record<string, unknown> = { chainId };
      if (has("enable")) body.enabled = true;
      if (has("disable")) body.enabled = false;
      if (flag("rpc")) body.rpcEndpoints = flag("rpc")!.split(",").map((x) => x.trim()).filter(Boolean);
      console.log(JSON.stringify(await call("POST", "/wallet/network", body), null, 2));
    } else if (sub === "asset-register") {
      const [chainId, contract, symbol, name, decimals] = positional(2);
      if (!chainId || !contract || !symbol || !name || !decimals) {
        throw new Error("wallet asset-register <chainId> <contract> <symbol> <name> <decimals> [--nanos-per-token N] [--note text]");
      }
      const r = await call("POST", "/wallet/asset/register", {
        chainId: Number(chainId),
        contractAddress: contract,
        symbol,
        name,
        expectedDecimals: Number(decimals),
        nanosPerToken: flag("nanos-per-token") ?? String(1_000_000_000),
        pricingNote: flag("note") ?? "fixed test rate: 1 token = 1 test USD",
      });
      console.log(JSON.stringify(r, null, 2));
    } else if (sub === "asset") {
      const [assetId] = positional(2);
      if (!assetId) throw new Error("wallet asset <assetId> [--enable|--disable]");
      if (has("enable") || has("disable")) {
        console.log(JSON.stringify(await call("POST", "/wallet/asset", { assetId, enabled: has("enable") }), null, 2));
      } else {
        const r = await call("GET", "/wallet/assets");
        const one = (r.assets as any[]).find((a) => a.assetId === assetId);
        console.log(JSON.stringify(one ?? { error: "no such asset" }, null, 2));
      }
    } else if (sub === "assets") {
      const chainId = positional(2)[0];
      const r = await call("GET", "/wallet/assets");
      const list = (r.assets as any[]).filter((a) => (chainId ? a.chainId === Number(chainId) : true));
      if (!list.length) console.log("no assets registered");
      for (const a of list) {
        const rate = a.pricing?.nanosPerToken ?? a.nanosPerToken ?? "UNKNOWN";
        console.log(`${a.assetId}  ${a.symbol} (${a.decimals}d) ${a.enabled ? "enabled" : "disabled"}  ${rate} nanos/token  ${a.contractAddress}`);
      }
    } else if (sub === "networks") {
      const r = await call("GET", "/wallet/networks");
      for (const n of r.networks as any[]) {
        console.log(
          `${n.chainId}  ${n.displayName}  ${n.networkType}  ${n.enabled ? "enabled" : "disabled"}  finality=${n.finality.mode}${n.finality.confirmations ? `(${n.finality.confirmations})` : ""}  rpc=${n.rpcEndpoints.length}`,
        );
      }
    } else if (sub === "receiving") {
      const [providerId, chainId, address] = positional(2);
      if (!providerId || !chainId || !address) throw new Error("wallet receiving <providerId> <chainId> <address>");
      console.log(JSON.stringify(await call("POST", "/wallet/receiving", { providerId, chainId: Number(chainId), address }), null, 2));
    } else if (sub === "intent") {
      const [providerId, consumerId, chainId, assetId, amountRaw] = positional(2);
      if (!providerId || !consumerId || !chainId || !assetId || !amountRaw) {
        throw new Error("wallet intent <providerId> <consumerId> <chainId> <assetId> <amountRaw> [--ttl sec]");
      }
      const r = await call("POST", "/wallet/intent", {
        providerId,
        consumerId,
        chainId: Number(chainId),
        assetId,
        amountRaw,
        ...(flag("ttl") ? { ttlSec: Number(flag("ttl")) } : {}),
        ...(flag("to") ? { recipientAddress: flag("to") } : {}),
      });
      console.log(r.summary);
      console.log(JSON.stringify({ invoiceId: r.intent.invoiceId, nonce: r.intent.nonce, digest: r.digest, expiresAt: r.intent.expiresAt }, null, 2));
      console.log("\nsign this EIP-712 document with the wallet that will pay:");
      console.log(JSON.stringify(r.typedData, null, 2));
    } else if (sub === "sign") {
      const [invoiceId, signature, payerAddress] = positional(2);
      if (!invoiceId || !signature || !payerAddress) throw new Error("wallet sign <invoiceId> <signature> <payerAddress> [--expect address]");
      console.log(
        JSON.stringify(
          await call("POST", "/wallet/intent/sign", { invoiceId, signature, payerAddress, expectedPayer: flag("expect") ?? null }),
          null,
          2,
        ),
      );
    } else if (sub === "cancel") {
      const [invoiceId] = positional(2);
      if (!invoiceId) throw new Error("wallet cancel <invoiceId> [--reason text]");
      console.log(JSON.stringify(await call("POST", "/wallet/intent/cancel", { invoiceId, reason: flag("reason") }), null, 2));
    } else if (sub === "intents") {
      const consumerId = positional(2)[0];
      const r = await call("GET", consumerId ? `/wallet/intents?consumerId=${encodeURIComponent(consumerId)}` : "/wallet/intents");
      if (has("json")) console.log(JSON.stringify(r, null, 2));
      else if (!r.intents.length) console.log("no deposit intents");
      else {
        for (const i of r.intents as any[]) {
          console.log(
            `${i.invoiceId}  chain=${i.chainId}  ${i.status}/${i.attributionStatus}  ${i.expectedAmountRaw} of ${i.assetId}  payer=${i.payerAddress ?? "—"}  expires=${i.expiresAt}`,
          );
        }
      }
    } else if (sub === "events") {
      const chain = flag("chain");
      const tx = flag("tx");
      const q = tx ? `?tx=${tx}` : chain ? `?chainId=${chain}` : "";
      const r = await call("GET", `/wallet/events${q}`);
      if (has("json")) console.log(JSON.stringify(r, null, 2));
      else if (!r.events.length) console.log("no deposit events");
      else {
        for (const e of r.events as any[]) {
          console.log(
            `${e.chainId}  ${e.status.padEnd(11)}  ${e.txHash}:${e.logIndex}  block ${e.blockNumber}  ${e.amountRaw}  ${e.fromAddress} → ${e.toAddress}  ${e.invoiceId ?? "—"}${e.reason ? `  (${e.reason})` : ""}`,
          );
        }
      }
    } else if (sub === "scan") {
      const chainId = Number(positional(2)[0]);
      if (!Number.isInteger(chainId)) throw new Error("wallet scan <chainId>");
      console.log(JSON.stringify(await call("POST", "/wallet/scan", { chainId }), null, 2));
    } else if (sub === "start" || sub === "stop") {
      console.log(JSON.stringify(await call("POST", `/wallet/${sub}`, {}), null, 2));
    } else if (sub === "anomalies") {
      const r = await call("GET", "/wallet/anomalies");
      const chain = flag("chain");
      const list = (r.anomalies as any[]).filter((a) => (chain ? a.chainId === Number(chain) : true));
      if (!list.length) console.log("no chain anomalies");
      for (const a of list) {
        console.log(`#${a.id}  chain ${a.chainId}  ${a.kind}  ${a.at}  ${a.detail}${a.resolvedAt ? `  [resolved: ${a.resolutionNote}]` : ""}`);
      }
    } else if (sub === "resolve") {
      const id = Number(positional(2)[0]);
      if (!Number.isInteger(id) || !flag("note")) throw new Error("wallet resolve <id> --note <text>");
      console.log(JSON.stringify(await call("POST", "/wallet/anomaly/resolve", { id, note: flag("note") }), null, 2));
    } else if (sub === "credit") {
      const consumerId = positional(2)[0];
      if (!consumerId) throw new Error("wallet credit <consumerId>");
      const r = await call("GET", "/wallet");
      const w = r.wallet;
      const consumers = Array.isArray(w?.consumers) ? w.consumers : [];
      const credit = consumers.find((c: any) => c.consumerId === consumerId) ?? null;
      const chainCredit = Array.isArray(credit?.chainCredit) ? credit.chainCredit : [];
      const creditedEvents = chainCredit.reduce((n: number, c: any) => n + Number(c.credited ?? 0), 0);
      console.log(
        JSON.stringify(
          {
            consumerId,
            chainCredit,
            chainCreditedNanos: credit?.chainCreditedNanos ?? 0,
            ledger: credit?.ledger ?? null,
            updatedAt: credit?.updatedAt ?? null,
            totals: w?.totals ?? null,
            creditedEvents,
          },
          null,
          2,
        ),
      );
    } else {
      const r = await call("GET", "/wallet");
      const w = r.wallet;
      if (!w) {
        console.log("no chain wallet: no network is enabled on this node");
        break;
      }
      console.log(JSON.stringify({ registry: w.registry.networks, chains: w.chains, totals: w.totals, disabled: w.disabled }, null, 2));
    }
    break;
  }
  case "checks": {
    const s = await call("GET", "/checks");
    for (const c of s.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    if (s.checks.some((c: any) => !c.ok)) process.exit(1);
    break;
  }
  case "catalog": {
    const sub = rest[1];
    if (sub === "publish" || sub === "discover") {
      const on = rest[2];
      if (on !== "on" && on !== "off") throw new Error(`catalog ${sub} on|off`);
      const r = await call("POST", sub === "publish" ? "/catalog/publish" : "/catalog/discover", { enabled: on === "on" });
      console.log(JSON.stringify({ ok: true, catalog: r.catalog }, null, 2));
    } else if (sub === "config") {
      const r = await call("POST", "/catalog/configure", {
        displayName: flag("display-name"),
        contact: flag("contact"),
        port: flag("port") ? Number(flag("port")) : undefined,
        socksPort: flag("socks-port") ? Number(flag("socks-port")) : undefined,
        refreshSec: flag("refresh") ? Number(flag("refresh")) : undefined,
        minTopUpUsd: flag("min-topup") ? Number(flag("min-topup")) : undefined,
      });
      console.log(JSON.stringify({ ok: true, catalog: r.catalog }, null, 2));
    } else if (sub === "refresh") {
      const r = await call("POST", "/catalog/refresh", {});
      printCatalogPeers(r.peers);
    } else if (sub === "trust") {
      const [nodeId] = positional(2);
      if (!nodeId) throw new Error("catalog trust <node-id> --fingerprint <64hex>");
      if (!flag("fingerprint")) throw new Error("catalog trust requires the exact --fingerprint <64hex> you reviewed");
      const r = await call("POST", "/catalog/trust", { nodeId, fingerprint: flag("fingerprint") });
      console.log(JSON.stringify(r, null, 2));
    } else if (sub === "request") {
      const [nodeId] = positional(2);
      if (!nodeId) throw new Error("catalog request <node-id> --fingerprint <64hex> --quote <64hex> [--models a,b]");
      if (!flag("fingerprint") || !flag("quote")) {
        throw new Error(
          "catalog request now requires the exact --fingerprint and --quote you reviewed; " +
            "use the guided `connect` command (or pass both flags) — nothing is accepted implicitly",
        );
      }
      const models = flag("models") ? flag("models")!.split(",") : undefined;
      const acceptance = flag("fingerprint") && flag("quote")
        ? { fingerprint: flag("fingerprint"), quoteHash: flag("quote"), ...(flag("price-version") ? { priceVersion: flag("price-version") } : {}) }
        : undefined;
      console.log(JSON.stringify(await call("POST", "/catalog/request", { nodeId, models, ...(acceptance ?? {}) }), null, 2));
    } else if (sub === "connect") {
      const [nodeId] = positional(2);
      const key = keyFlag();
      if (!nodeId || !key) throw new Error("catalog connect <node-id> --key-file <0600 file> [--id <provider-id>] --fingerprint <64hex> --quote <64hex>");
      if (!flag("fingerprint") || !flag("quote")) {
        throw new Error(
          "catalog connect now requires the exact --fingerprint and --quote you reviewed; " +
            "use the guided `connect` command (or pass both flags) — nothing is accepted implicitly",
        );
      }
      const p = await call("POST", "/catalog/connect", {
        nodeId,
        key,
        id: flag("id"),
        ...(flag("fingerprint") ? { fingerprint: flag("fingerprint") } : {}),
        ...(flag("quote") ? { quoteHash: flag("quote") } : {}),
        ...(flag("price-version") ? { priceVersion: flag("price-version") } : {}),
      });
      console.log(JSON.stringify({ ok: true, provider: p }, null, 2));
    } else if (sub === "peers" || sub === undefined || sub === "status") {
      const r = await call("GET", "/catalog");
      if (has("json")) console.log(JSON.stringify(r, null, 2));
      else {
        const c = r.catalog;
        console.log(
          `catalogue: ${c.publishing ? "publishing" : "off"}` +
            (c.quote ? ` · version ${c.quote.version} · ${c.quote.modelCount} model(s) · identity ${c.quote.identity?.fingerprint ?? "—"}` : "") +
            (c.server?.error ? ` · ERROR ${c.server.error}` : "") +
            (c.error ? ` · ERROR ${c.error}` : ""),
        );
        if (sub === "peers" || sub === undefined) printCatalogPeers(c.peers || []);
      }
    } else {
      throw new Error("catalog [status|peers|publish on|off|discover on|off|config|refresh|trust|request|connect]");
    }
    break;
  }
  default:
    console.error(
      "usage: status | providers | provider add|update|rm|reconcile | share on|off|models | consume on|off | " +
        "configure | consumers [add|models|reissue|resolve-gap] | topup | accounting | secret | revoke | guard | checks | start | stop | " +
        "wallet [networks|network|assets|asset|asset-register|receiving|intent|sign|cancel|intents|events|scan|start|stop|anomalies|resolve|credit]",
    );
    process.exit(2);
}
