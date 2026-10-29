import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EasytierSupervisor, renderConfig, type EasytierConfig } from "../src/easytier.ts";

// A fake easyTier: a "core" that sleeps until signalled and a "cli" that answers
// from a configuration file the test controls. This is how a runtime check is
// proven to stop the process, not merely to set a flag.

const cfg: EasytierConfig = {
  role: "provider",
  networkName: "runtime-lab",
  networkSecret: "runtime-secret",
  peers: [],
  virtualIpv4: "10.79.0.5/24",
  overlayCidr: "10.79.0.0/24",
  listenAddr: "tcp://127.0.0.1:11021",
  rpcPort: 17901,
  proxyCidr: "192.0.2.84/32",
  mappedCidr: "10.66.9.9/32",
  publishedPorts: [3425],
  secureMode: true,
  secureIdentity: { privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
  instanceName: "runtime-provider",
};

let dir: string;
let bins: { core: string; cli: string; verified: boolean };
let configFile: string;

async function gone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-runtime-"));
  process.chdir(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const core = join(binDir, "easytier-core");
  const cli = join(binDir, "easytier-cli");
  writeFileSync(
    core,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "easytier-core 2.6.4-fake"; exit 0; fi\ntrap "exit 0" TERM INT\nwhile :; do sleep 0.2; done\n',
  );
  writeFileSync(
    cli,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const cfg = await Bun.file(process.env.FAKE_CONFIG).text();
if (args.includes("node")) {
  console.log(JSON.stringify({ peer_id: 1, ipv4_addr: "10.79.0.5/24", proxy_cidrs: ["192.0.2.84->10.66.9.9"], hostname: "runtime-provider", listeners: [], config: cfg }));
} else if (args.includes("route") || args.includes("peer")) {
  console.log("[]");
} else if (args.includes("port-forward")) {
  console.log(JSON.stringify({ cfgs: [] }));
} else {
  console.log("");
}
`,
  );
  chmodSync(core, 0o755);
  chmodSync(cli, 0o755);
  bins = { core, cli, verified: true };
  configFile = join(dir, "running.toml");
  process.env.FAKE_CONFIG = configFile;
});

afterEach(() => {
  delete process.env.FAKE_CONFIG;
});

function goodRunning(): string {
  return renderConfig(cfg);
}

describe("runtime fail closed", () => {
  test("a running config that fails the ACL check stops the owned core", async () => {
    // The generated file is fine; the *running* core reports an Inbound chain
    // that allows everything — the case a file check cannot see.
    const bad = goodRunning().replace(/(name = "Inbound"[\s\S]*?)default_action = 2/, "$1default_action = 1");
    writeFileSync(configFile, bad);
    const sup = new EasytierSupervisor({ onState: () => {} }, { binaries: bins, lanIp: () => "192.0.2.84", probe: { rpcListeners: async () => ["127.0.0.1"] } });

    const state = await sup.start(cfg);
    expect(state.running).toBe(true); // the generated config passed and the core is up
    const pid = state.pid!;
    expect(alive(pid)).toBe(true);

    await sup.refresh(); // second strike
    const after = sup.snapshot();
    expect(after.running).toBe(false);
    expect(after.aclOk).toBe(false);
    expect(after.lastError).toContain("refusing to serve");
    expect(await gone(pid)).toBe(true); // the process is really gone
  });

  test("an RPC portal on a non-loopback address stops the core", async () => {
    writeFileSync(configFile, goodRunning());
    const sup = new EasytierSupervisor(
      { onState: () => {} },
      { binaries: bins, lanIp: () => "192.0.2.84", probe: { rpcListeners: async () => ["0.0.0.0"] } },
    );
    const pid = (await sup.start(cfg)).pid!;
    await sup.refresh();
    expect(sup.snapshot().aclProblems.join(" ")).toContain("not loopback");
    expect(await gone(pid)).toBe(true);
  });

  test("an RPC portal that cannot be verified stops the core", async () => {
    writeFileSync(configFile, goodRunning());
    const sup = new EasytierSupervisor(
      { onState: () => {} },
      { binaries: bins, lanIp: () => "192.0.2.84", probe: { rpcListeners: async () => [] } },
    );
    const pid = (await sup.start(cfg)).pid!;
    await sup.refresh();
    expect(sup.snapshot().aclProblems.join(" ")).toContain("cannot be verified");
    expect(await gone(pid)).toBe(true);
  });

  test("a configuration that cannot be read stops the core after the retry", async () => {
    writeFileSync(configFile, goodRunning());
    let reads = 0;
    const sup = new EasytierSupervisor(
      { onState: () => {} },
      {
        binaries: bins,
        lanIp: () => "192.0.2.84",
        probe: {
          rpcListeners: async () => ["127.0.0.1"],
          nodeInfo: async () => {
            reads += 1;
            if (reads >= 2) throw new Error("rpc closed");
            return { peerId: 1, proxyCidrs: ["192.0.2.84->10.66.9.9"], listeners: [], config: goodRunning() };
          },
        },
      },
    );
    const pid = (await sup.start(cfg)).pid!;
    await sup.refresh(); // strike 1
    await sup.refresh(); // strike 2 → stop
    const s = sup.snapshot();
    expect(s.running).toBe(false);
    expect(s.lastError).toContain("cannot read the running configuration");
    expect(await gone(pid)).toBe(true);
  });

  test("an export that is not announced stops the core", async () => {
    const withoutExport = goodRunning().replace(/proxy_network = .*\n/, "");
    writeFileSync(configFile, withoutExport);
    const sup = new EasytierSupervisor({ onState: () => {} }, { binaries: bins, lanIp: () => "192.0.2.84", probe: { rpcListeners: async () => ["127.0.0.1"] } });
    const pid = (await sup.start(cfg)).pid!;
    await sup.refresh();
    expect(sup.snapshot().aclProblems.join(" ")).toContain("proxy_network");
    expect(await gone(pid)).toBe(true);
  });

  test("a healthy core keeps running", async () => {
    writeFileSync(configFile, goodRunning());
    const sup = new EasytierSupervisor({ onState: () => {} }, { binaries: bins, lanIp: () => "192.0.2.84", probe: { rpcListeners: async () => ["127.0.0.1"] } });
    const pid = (await sup.start(cfg)).pid!;
    const s = await sup.refresh();
    expect(s.running).toBe(true);
    expect(s.aclOk).toBe(true);
    expect(alive(pid)).toBe(true);
    await sup.stop();
    expect(await gone(pid)).toBe(true);
  });

  test("an unsafe core is not restarted, and a new start validates again", async () => {
    const bad = goodRunning().replace(/(name = "Inbound"[\s\S]*?)default_action = 2/, "$1default_action = 1");
    writeFileSync(configFile, bad);
    const sup = new EasytierSupervisor({ onState: () => {} }, { binaries: bins, lanIp: () => "192.0.2.84", probe: { rpcListeners: async () => ["127.0.0.1"] } });
    const pid = (await sup.start(cfg)).pid!;
    await sup.refresh();
    expect(alive(pid)).toBe(false);
    // no supervised restart after an unsafe stop
    await new Promise((r) => setTimeout(r, 1200));
    expect(sup.snapshot().running).toBe(false);
    // a start with a good running config serves again
    writeFileSync(configFile, goodRunning());
    const again = await sup.start(cfg);
    expect(again.running).toBe(true);
    expect(again.aclOk).toBe(true);
    await sup.stop();
  });

  test("the supervisor never signals a pid it does not own", async () => {
    // a stand-in process whose command line is not our easytier-core
    const other = Bun.spawn({ cmd: ["sleep", "5"], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const sup = new EasytierSupervisor({ onState: () => {} }, { binaries: bins, lanIp: () => "192.0.2.84" });
    // put the foreign pid where an adopted state would have it
    const state = sup.snapshot();
    (sup as unknown as { state: typeof state }).state = { ...state, running: true, pid: other.pid };
    await sup.stop();
    expect(alive(other.pid)).toBe(true);
    other.kill();
  });
});
