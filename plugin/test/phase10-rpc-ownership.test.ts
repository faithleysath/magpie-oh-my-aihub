// The 17888-class incident: an unauthenticated RPC portal on a stored port may
// belong to somebody else's core. The supervisor must prove the OS attributes
// the socket to the live child *before* its first CLI read, and must not accept
// a foreign core even when it returns our own instance id.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EasytierSupervisor, type EasytierConfig, type SupervisorOptions } from "../src/easytier.ts";

const cfg: EasytierConfig = {
  sharingEnabled: false,
  consumingEnabled: false,
  nodeId: "ow000001",
  instanceId: "99999999-8888-4777-8666-555555555555",
  networkName: "ownership-lab",
  networkSecret: "ownership-secret",
  peers: [],
  virtualIpv4: "10.78.0.5/24",
  overlayCidr: "10.78.0.0/24",
  listenAddr: null,
  rpcPort: 27999,
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
const supervisors: EasytierSupervisor[] = [];
const extra: { pid: number }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-rpc-owner-"));
  process.chdir(dir);
  const binDir = join(dir, "bin");
  writeFileSync(join(dir, ".keep"), "");
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
});

afterEach(async () => {
  delete process.env.CORE_PID_FILE;
  delete process.env.CLI_CALLS;
  delete process.env.NODE_JSON;
  for (const sup of supervisors.splice(0)) await sup.stop().catch(() => {});
  for (const p of extra.splice(0)) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

function saveNode(instanceId: string): void {
  const config = `hostname = "x"\ninstance_id = "${instanceId}"\n[network_identity]\nnetwork_name = "ownership-lab"\n`;
  writeFileSync(nodeJson, JSON.stringify({ peer_id: 1, proxy_cidrs: [], listeners: [], config }));
}

function ownerPids(read: () => number[]): NonNullable<SupervisorOptions["probe"]> {
  return {
    socketOwner: {
      async listenerPids() {
        return { supported: true, pids: read().filter((n) => Number.isInteger(n) && n > 0), detail: null };
      },
    },
  };
}

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

function supervisor(probe: NonNullable<SupervisorOptions["probe"]>): EasytierSupervisor {
  const sup = new EasytierSupervisor(
    { onState: () => {} },
    { binaries: bins, rpcTimeoutMs: 900, probe },
  );
  supervisors.push(sup);
  return sup;
}

describe("RPC portal ownership", () => {
  test("a foreign listener is never read, even when it returns our instance id", async () => {
    saveNode(cfg.instanceId); // the strongest false positive: our own config
    const foreign = Bun.spawn({ cmd: ["sleep", "5"], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    extra.push({ pid: foreign.pid });
    const sup = supervisor(ownerPids(() => [foreign.pid]));
    await expect(sup.start(cfg)).rejects.toThrow(/RPC/);
    expect(cliCalls()).toBe(0);
    expect(sup.snapshot().running).toBe(false);
    expect(sup.snapshot().lastError).toMatch(/RPC/);
  });

  test("a live child that does not own the port is refused after a bounded wait", async () => {
    saveNode(cfg.instanceId);
    const foreign = Bun.spawn({ cmd: ["sleep", "5"], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    extra.push({ pid: foreign.pid });
    const sup = supervisor(ownerPids(() => [foreign.pid]));
    await expect(sup.start(cfg)).rejects.toThrow(/RPC/);
    expect(cliCalls()).toBe(0);
    expect(sup.snapshot().running).toBe(false);
  });

  test("an owned port with a different instance id is rejected", async () => {
    saveNode("11111111-2222-4333-8444-555555555555");
    const sup = supervisor(ownerPids(ownPid));
    await expect(sup.start(cfg)).rejects.toThrow(/RPC/);
    expect(cliCalls()).toBeGreaterThan(0);
    expect(sup.snapshot().running).toBe(false);
    expect(sup.snapshot().lastError).toMatch(/different instance id/);
  });

  test("an owned port with our instance id is accepted", async () => {
    saveNode(cfg.instanceId);
    const sup = supervisor(ownerPids(ownPid));
    const state = await sup.start(cfg);
    expect(state.running).toBe(true);
    expect(cliCalls()).toBeGreaterThan(0);
    await sup.stop();
    expect(sup.snapshot().running).toBe(false);
  });

  test("an unavailable OS owner probe fails closed instead of trusting the config", async () => {
    saveNode(cfg.instanceId);
    const sup = supervisor({
      socketOwner: {
        async listenerPids() {
          return { supported: false, pids: [], detail: "test: no socket-owner probe" };
        },
      },
    });
    await expect(sup.start(cfg)).rejects.toThrow(/RPC/);
    expect(cliCalls()).toBe(0);
    expect(sup.snapshot().lastError).toMatch(/cannot prove the RPC portal/);
  });
});
