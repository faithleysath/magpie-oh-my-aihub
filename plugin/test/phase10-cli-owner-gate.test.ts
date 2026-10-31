// Every EasyTier CLI call (node/peer/route/port-forward list|add|remove) is a
// read of an unauthenticated RPC portal. It may only run when the live spawned
// child handle, its OS start marker and the socket owner all still agree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EasytierSupervisor, type EasytierConfig, type SupervisorOptions } from "../src/easytier.ts";

const cfg: EasytierConfig = {
  sharingEnabled: false,
  consumingEnabled: false,
  nodeId: "gate0001",
  instanceId: "77777777-6666-4555-8444-333333333333",
  networkName: "cli-gate-lab",
  networkSecret: "cli-gate-secret",
  peers: [],
  virtualIpv4: "10.78.0.7/24",
  overlayCidr: "10.78.0.0/24",
  listenAddr: null,
  rpcPort: 27997,
  proxyCidr: null,
  mappedCidr: null,
  publishedPorts: [],
  socks5Proxy: null,
  portForwards: [],
  secureMode: false,
  secureIdentity: null,
};

let dir: string;
let bins: { core: string; cli: string; verified: boolean };
let pidFile: string;
let callsFile: string;
let nodeJson: string;
let ownerPids: number[];
let startMarker: string | null;
const supervisors: EasytierSupervisor[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-cli-gate-"));
  process.chdir(dir);
  const binDir = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", binDir]);
  const core = join(binDir, "easytier-core");
  const cli = join(binDir, "easytier-cli");
  writeFileSync(
    core,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "easytier-core 2.6.4-fake"; exit 0; fi\n' +
      'echo $$ > "$CORE_PID_FILE"\ntrap "exit 0" TERM INT\nwhile :; do sleep 0.1; done\n',
  );
  writeFileSync(cli, '#!/bin/sh\necho call >> "$CLI_CALLS"\ncat "$NODE_JSON"\n');
  chmodSync(core, 0o755);
  chmodSync(cli, 0o755);
  bins = { core, cli, verified: true };
  pidFile = join(dir, "core.pid");
  callsFile = join(dir, "cli.calls");
  nodeJson = join(dir, "node.json");
  process.env.CORE_PID_FILE = pidFile;
  process.env.CLI_CALLS = callsFile;
  process.env.NODE_JSON = nodeJson;
  writeFileSync(
    nodeJson,
    JSON.stringify({
      peer_id: 1,
      proxy_cidrs: [],
      listeners: [],
      config: `hostname = "x"\ninstance_id = "${cfg.instanceId}"\n[network_identity]\nnetwork_name = "${cfg.networkName}"\n`,
    }),
  );
  ownerPids = [];
  startMarker = "start-A";
});

afterEach(async () => {
  delete process.env.CORE_PID_FILE;
  delete process.env.CLI_CALLS;
  delete process.env.NODE_JSON;
  for (const sup of supervisors.splice(0)) await sup.stop().catch(() => {});
});

function cliCalls(): number {
  if (!existsSync(callsFile)) return 0;
  return readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length;
}

function ownPid(): number[] {
  try {
    return [Number(readFileSync(pidFile, "utf8").trim())];
  } catch {
    return [];
  }
}

function supervisor(): EasytierSupervisor {
  const probe: NonNullable<SupervisorOptions["probe"]> = {
    socketOwner: {
      async listenerPids() {
        return { supported: true, pids: [...ownerPids], detail: null };
      },
    },
    processStart: async () => startMarker,
  };
  const sup = new EasytierSupervisor({ onState: () => {} }, { binaries: bins, rpcTimeoutMs: 900, probe });
  supervisors.push(sup);
  return sup;
}

async function started(): Promise<EasytierSupervisor> {
  const sup = supervisor();
  // waitForRpc itself uses the gate; give it the live pid as owner first.
  const timer = setInterval(() => {
    if (!ownerPids.length) ownerPids = ownPid();
  }, 50);
  try {
    await sup.start(cfg);
  } finally {
    clearInterval(timer);
  }
  return sup;
}

describe("unified CLI owner gate", () => {
  test("node/peer/route/port-forward all refuse a foreign RPC owner without invoking the CLI", async () => {
    const sup = await started();
    const before = cliCalls();
    ownerPids = [999_999];
    await expect(sup.peers()).rejects.toThrow(/owned by pid 999999|not 4242|not .*pid/);
    await expect(sup.routes()).rejects.toThrow(/owned by pid/);
    await expect(sup.listPortForwards()).rejects.toThrow(/owned by pid/);
    await expect(sup.addPortForward("127.0.0.1:13425", "10.66.1.2:3425")).rejects.toThrow(/owned by pid/);
    await expect(sup.removePortForward("127.0.0.1:13425")).rejects.toThrow(/owned by pid/);
    expect(cliCalls()).toBe(before);
  });

  test("a changed OS start marker is a PID-reuse refusal", async () => {
    const sup = await started();
    ownerPids = ownPid();
    const before = cliCalls();
    startMarker = "start-B"; // same pid, different process instance
    await expect(sup.peers()).rejects.toThrow(/start marker changed/);
    expect(cliCalls()).toBe(before);
  });

  test("an unreadable start marker fails closed", async () => {
    const sup = await started();
    ownerPids = ownPid();
    startMarker = null;
    await expect(sup.listPortForwards()).rejects.toThrow(/start marker changed or cannot be read/);
  });

  test("the monitor refresh cannot read a foreign core and stops it after the strikes", async () => {
    const sup = await started();
    ownerPids = [999_999];
    const before = cliCalls();
    await sup.refresh().catch(() => {});
    await sup.refresh().catch(() => {});
    const snap = sup.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.lastError).toMatch(/refusing to query|owner|not this core/);
    expect(cliCalls()).toBe(before);
  });
});
