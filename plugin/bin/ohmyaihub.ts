#!/usr/bin/env bun
// Operator CLI for the plugin host API. It never talks to Magpie directly for
// state changes: Magpie's own plugin does, with its binary and argv arrays.
//
//   bun bin/ohmyaihub.ts --data <magpie config dir> status
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
//   ... wallet credit <consumerId>       chain credit as the ledger sees it

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function read(file: string): string {
  return readFileSync(join(dataDir, "oh-my-aihub", file), "utf8").trim();
}
const port = read("api-port");
const token = read("api-token");
const base = `http://127.0.0.1:${port}`;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${typeof json === "string" ? json : json.error || JSON.stringify(json)}`);
    process.exit(1);
  }
  return json;
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
function has(name: string): boolean {
  return rest.includes(`--${name}`);
}
function positional(offset: number): string[] {
  return rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--"))).slice(offset);
}

function printProviders(providers: any[]): void {
  if (!providers.length) {
    console.log("no remote providers");
    return;
  }
  for (const p of providers) {
    const fp = p.fingerprint ? ` peer=${p.fingerprint.hostname}${p.fingerprint.peerId ? `#${p.fingerprint.peerId}` : ""}` : "";
    const lim = p.limit
      ? ` limit=${p.limit.cost ?? "?"}/${p.limit.costLimit ?? "?"} USD${p.limit.spent ? " spent" : ""}`
      : "";
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
          providers: s.providers,
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
          key: flag("key"),
          providerPort: flag("port") ? Number(flag("port")) : undefined,
          localPort: flag("local-port") ? Number(flag("local-port")) : undefined,
        });
        console.log(JSON.stringify(p, null, 2));
      } else {
        const p = await call("POST", "/providers/update", {
          id,
          mappedCidr: flag("cidr"),
          key: flag("key"),
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
    const peers = flag("peer") ? [flag("peer")!] : [];
    const role = flag("role");
    const s = await call("POST", "/configure", {
      role: role || undefined,
      sharingEnabled: has("share") ? true : has("no-share") ? false : role ? role === "provider" : undefined,
      consumingEnabled: has("consume") ? true : has("no-consume") ? false : role ? role === "consumer" : undefined,
      networkName: flag("network"),
      networkSecret: flag("secret"),
      peers,
      listenAddr: flag("listen") ?? null,
      publishedPorts: flag("ports") ? flag("ports")!.split(",").map(Number) : undefined,
      virtualIpv4: flag("virtual-ip"),
      shareModels: flag("share-models") ? flag("share-models")!.split(",") : undefined,
    });
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
    console.log(c.key);
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
    if (sub === "network") {
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
        nanosPerToken: flag("nanos-per-token") ?? "1000000000",
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
        console.log(`${a.assetId}  ${a.symbol} (${a.decimals}d) ${a.enabled ? "enabled" : "disabled"}  ${a.nanosPerToken} nanos/token  ${a.contractAddress}`);
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
      const credited = (w?.events ?? []).filter((e: any) => e.status === "credited");
      console.log(
        JSON.stringify(
          {
            consumerId,
            ledgerCredit: w?.consumers?.find?.((c: any) => c.consumerId === consumerId)?.ledger ?? null,
            totals: w?.totals ?? null,
            creditedEvents: credited.length,
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
      if (!nodeId) throw new Error("catalog trust <node-id> [--fingerprint <sha256>]");
      const r = await call("POST", "/catalog/trust", { nodeId, fingerprint: flag("fingerprint") });
      console.log(JSON.stringify(r, null, 2));
    } else if (sub === "request") {
      const [nodeId] = positional(2);
      if (!nodeId) throw new Error("catalog request <node-id> [--models a,b]");
      const models = flag("models") ? flag("models")!.split(",") : undefined;
      console.log(JSON.stringify(await call("POST", "/catalog/request", { nodeId, models }), null, 2));
    } else if (sub === "connect") {
      const [nodeId] = positional(2);
      if (!nodeId || !flag("key")) throw new Error("catalog connect <node-id> --key sk-… [--id <provider-id>]");
      const p = await call("POST", "/catalog/connect", { nodeId, key: flag("key"), id: flag("id") });
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
