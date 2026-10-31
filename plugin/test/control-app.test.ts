import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlApp, type ControlApp } from "../src/control/app.ts";
import { verifyPresence } from "../src/control/presence.ts";
import type { Service } from "../src/service.ts";

const prev = process.cwd();
let apps: ControlApp[] = [];
beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), "control-app-"))); });
afterAll(() => {
  for (const app of apps.splice(0)) app.stop();
  process.chdir(prev);
});

function fakeService() {
  let presence: (() => unknown | null) | null = null;
  const cfg = { nodeId: "abcd1234", hostname: "ohmyaihub-abcd1234", mappedCidr: null, controlEnabled: true, controlPort: null, sharingEnabled: false, catalog: { port: 3426, socksPort: 13400 } };
  const service = {
    config: () => cfg,
    catalogStatus: () => ({ quote: null, peers: [] }),
    setControlPresence: (fn: (() => unknown | null) | null) => { presence = fn; },
    gatewayPort: () => 3425,
    providers: () => [],
    statusSnapshotForTest: () => ({ config: { sharingEnabled: false, shareSuspended: null } }),
    approveConnectionRequest: async () => { throw new Error("not used"); },
    handover: async () => { throw new Error("not used"); },
    addProvider: async () => { throw new Error("not used"); },
    providerModels: async () => { throw new Error("not used"); },
    removeProvider: async () => { throw new Error("not used"); },
    provisioner: {},
  } as unknown as Service;
  return { service, presence: () => presence };
}

describe("control app lifecycle", () => {
  test("starts a bounded control listener and publishes signed presence only through the callback", async () => {
    const { service, presence } = fakeService();
    const app = await startControlApp(service, { host: "127.0.0.1" });
    expect(app).not.toBeNull();
    apps.push(app!);
    const health = await fetch(`http://127.0.0.1:${app!.port}/p2p/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
    const fn = presence();
    expect(typeof fn).toBe("function");
    const doc = fn!() as Record<string, unknown>;
    const verified = verifyPresence(doc, new Date(), { allowLoopback: true });
    expect(verified.node.nodeId).toBe("abcd1234");
    expect(verified.endpoint.controlPort).toBe(app!.port);
    expect(verified.capability.providesModels).toBe(false);
    const state = await app!.state();
    expect(state.schema).toBe("ohmyaihub/p2p-state/1");
    expect((state.listener as Record<string, unknown>).reachability).toBe("loopback");
  });
});
