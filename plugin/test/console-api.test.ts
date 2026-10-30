import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { consoleAction, consoleState } from "../src/console-api.ts";
import { ConsoleInputError } from "../src/console-server.ts";
import { registerSecret } from "../src/log.ts";
import type { Service, StatusSnapshot } from "../src/service.ts";

function fixture() {
  process.chdir(mkdtempSync("/tmp/console-api-fixture-"));
  const calls: string[] = [];
  const snapshot = {
    plugin: { version: "0.5.0", startedAt: "2026-10-30T00:00:00Z", stateVersion: 3, pid: 999, dataDir: "/private/host/data" },
    magpie: { version: "fixture", gateway: "http://127.0.0.1:3425" },
    config: { nodeId: "local-node", networkName: "private-network", sharingEnabled: false, consumingEnabled: false },
    easytier: { running: false, peers: [], lastError: null },
    providers: [], catalog: { peers: [] }, consumers: [], accounting: { uncertain: false },
    checks: [], checksAt: null, checksDurationMs: null, readiness: { state: "unknown" },
    logs: ["must not be included"], wallet: { privateInternalField: "must not be included" },
  } as unknown as StatusSnapshot;
  const service = {
    consoleSnapshot() { calls.push("snapshot"); return snapshot; },
    requestApprovalContext() { return {provider:{nodeId:"local-node",mappedCidr:null,gatewayPort:3425},quote:null}; },
    async configure(input: Record<string, unknown>) { calls.push("configure"); Object.assign(snapshot.config, input); return snapshot; },
    async checks() { calls.push("checks"); return []; },
    async status() { throw new Error("polling must never run active status"); },
  } as unknown as Service;
  return { service, snapshot, calls };
}

describe("console business boundary", () => {
  test("polling projects only operator view fields without probes, paths or logs", async () => {
    const f = fixture();
    const state = await consoleState(f.service);
    expect(f.calls).toEqual(["snapshot"]);
    expect(state.configured).toBe(true);
    expect(state.status.plugin).not.toHaveProperty("dataDir");
    expect(state.status).not.toHaveProperty("logs");
    expect(state.status).not.toHaveProperty("wallet");
    expect(JSON.stringify(state)).not.toContain("/private/host/data");
  });

  test("registered credentials are removed even from diagnostic text", async () => {
    const f = fixture();
    const secret = "fixture-sensitive-console-diagnostic";
    registerSecret(secret);
    f.snapshot.easytier.lastError = `connection failed: ${secret}`;
    expect(JSON.stringify(await consoleState(f.service))).not.toContain(secret);
  });

  test("browser configure shares runtime validation and never calls Service on rejected input", async () => {
    const f = fixture();
    for (const input of [{ sharingEnabled: "false" }, { execute: "anything" }, { rpcPort: 0 }]) {
      await expect(consoleAction(f.service, "configure", input)).rejects.toBeInstanceOf(ConsoleInputError);
    }
    expect(f.calls).toEqual([]);
    await consoleAction(f.service, "configure", { sharingEnabled: false });
    expect(f.calls).toEqual(["configure", "snapshot"]);
  });

  test("unknown operations cannot turn the browser adapter into an arbitrary host proxy", async () => {
    const f = fixture();
    for (const name of ["/api/providers", "exec", "secret", "topup"]) {
      await expect(consoleAction(f.service, name, {})).rejects.toBeInstanceOf(ConsoleInputError);
    }
    await expect(consoleAction(f.service, "checks", { command: "anything" })).rejects.toBeInstanceOf(ConsoleInputError);
    expect(f.calls).toEqual([]);
    await consoleAction(f.service, "checks", {});
    expect(f.calls).toEqual(["checks", "snapshot"]);
  });
});
