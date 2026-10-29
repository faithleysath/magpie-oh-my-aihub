#!/usr/bin/env bun
// Operator CLI for the plugin host API. It never talks to Magpie directly for
// state changes: Magpie's own plugin does, with its binary and argv arrays.
//
//   bun bin/ohmyaihub.ts --data <magpie data dir> status
//   ... consumers add <id> <model[,model]> <capUsd>
//   ... topup <id> <usd> [--deposit-id <id>]
//   ... revoke <id>
//   ... configure --role provider --network <name> --secret <secret> --peer tcp://host:11010 [--listen 127.0.0.1:11010]
//   ... connect --id <provider> --cidr 10.66.a.b/32 --key sk-... [--local-port 13425]
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
  console.error("pass --data <magpie data dir> (the folder holding plugins.json)");
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
function positional(offset: number): string[] {
  return rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--"))).slice(offset);
}

const cmd = rest[0];
switch (cmd) {
  case "status": {
    const s = await call("GET", "/status");
    console.log(
      JSON.stringify(
        {
          role: s.config?.role,
          network: s.config?.networkName,
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
          wiring: s.wiring,
          consumers: s.consumers,
          checks: s.checks,
        },
        null,
        2,
      ),
    );
    break;
  }
  case "configure": {
    const peers = flag("peer") ? [flag("peer")!] : [];
    const s = await call("POST", "/configure", {
      role: flag("role") || "provider",
      networkName: flag("network"),
      networkSecret: flag("secret"),
      peers,
      listenAddr: flag("listen") ?? null,
      publishedPorts: flag("ports") ? flag("ports")!.split(",").map(Number) : undefined,
    });
    console.log(JSON.stringify({ ok: true, role: s.config.role, mappedCidr: s.config.mappedCidr, virtualIpv4: s.config.virtualIpv4 }, null, 2));
    break;
  }
  case "connect": {
    const s = await call("POST", "/connect", {
      id: flag("id"),
      mappedCidr: flag("cidr"),
      key: flag("key"),
      localPort: flag("local-port") ? Number(flag("local-port")) : undefined,
      providerPort: flag("port") ? Number(flag("port")) : undefined,
    });
    console.log(JSON.stringify({ ok: true, wiring: s.wiring }, null, 2));
    break;
  }
  case "consumers": {
    if (rest[1] === "add") {
      const [id, models, cap] = positional(2);
      if (!id || !models || !cap) throw new Error("consumers add <id> <model[,model]> <capUsd>");
      const c = await call("POST", "/consumers", { consumerId: id, models: models.split(","), capUsd: Number(cap) });
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
    console.error("usage: status | configure | connect | consumers [add] | topup | revoke | checks");
    process.exit(2);
}
