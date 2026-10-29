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
//   ... consumers add <id> <model[,model]> <capUsd>
//   ... consumers models <id> <model[,model]>
//   ... topup <id> <usd> [--deposit-id <id>]
//   ... revoke <id>
//   ... checks

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
    console.log(
      `${p.id}  ${p.mappedCidr}:${p.providerPort} -> 127.0.0.1:${p.localPort}  ${p.status}` +
        `${p.detail ? ` (${p.detail})` : ""}${fp}`,
    );
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
      const c = await call("POST", "/consumers/add", { consumerId: id, models: models.split(","), capUsd: Number(cap) });
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
  case "checks": {
    const s = await call("GET", "/checks");
    for (const c of s.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    if (s.checks.some((c: any) => !c.ok)) process.exit(1);
    break;
  }
  default:
    console.error(
      "usage: status | providers | provider add|update|rm|reconcile | share on|off|models | consume on|off | " +
        "configure | consumers [add|models] | topup | secret | revoke | guard | checks | start | stop",
    );
    process.exit(2);
}
