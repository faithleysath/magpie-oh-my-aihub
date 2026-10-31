// Real model read-back evidence: written only by connect/provider-models/
// reconcile, projected locally on polling, invalidated by expiry, key changes,
// identity changes and disconnect. Authorization lists are never evidence.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { EasytierConfig, ForwardSpec, Peer, PortForward, RouteRow, SupervisorState } from "../src/easytier.ts";
import { FakeBinder, FakeOwnership } from "./support/fake-ports.ts";
import { MODELS_EVIDENCE_TTL_MS, loadState, projectModelsEvidence, saveState, type ProviderConnection } from "../src/state.ts";

const KEY = "sk-labmodel01";
const KEY2 = "sk-labmodel02";
const MODELS = ["peer-model-a", "peer-model-b"];
const PORT = 13640;

class FakeMagpie {
  providers = new Map<string, { id: string; preset: string; chat: string; key: string }>();
  providersReadable() { return true; }
  nativeProviderIds() { return new Set<string>(); }
  remoteProviderIds() { return new Set([...this.providers.keys()]); }
  providerById(id: string) { return this.providers.get(id); }
  keyById() { return undefined; }
  async modelIds() { return ["peer/peer-model-a"]; }
  async addRemoteProvider(o: { id: string; url: string; key: string }) {
    this.providers.set(o.id, { id: o.id, preset: "remote-magpie", chat: `${o.url}/v1`, key: o.key });
  }
  async replaceRemoteProvider(o: { id: string; url: string; key: string }) {
    await this.addRemoteProvider(o);
  }
  async removeProvider(id: string) { this.providers.delete(id); }
}

class FakeSupervisor implements SupervisorLike {
  cfg: EasytierConfig | null = null;
  forwards: PortForward[] = [];
  peerRows: Peer[] = [];
  routeRows: RouteRow[] = [];
  async start(cfg: EasytierConfig) {
    this.cfg = { ...cfg };
    this.forwards = (cfg.portForwards ?? []).map((f: ForwardSpec) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr }));
    return this.snapshot();
  }
  async stop() { this.cfg = null; }
  async refresh() { return this.snapshot(); }
  async listPortForwards() { return [...this.forwards]; }
  async addPortForward(bindAddr: string, dstAddr: string) { this.forwards.push({ protocol: "tcp", bindAddr, dstAddr }); return true; }
  async removePortForward() {}
  setForwards(forwards: ForwardSpec[]) { this.forwards = forwards.map((f) => ({ protocol: "tcp", bindAddr: f.bindAddr, dstAddr: f.dstAddr })); }
  async peers() { return [...this.peerRows]; }
  async routes() { return [...this.routeRows]; }
  snapshot(): SupervisorState {
    const cfg = this.cfg;
    return {
      sharingEnabled: cfg?.sharingEnabled ?? false, consumingEnabled: cfg?.consumingEnabled ?? false,
      hostname: cfg ? `ohmyaihub-${cfg.nodeId}` : null, running: Boolean(cfg), pid: cfg ? 4242 : null,
      startedAt: cfg ? "2026-10-31T00:00:00.000Z" : null, restarts: 0, lastError: null,
      coreVersion: cfg ? "easytier-core 2.6.4-fake" : null, rpcPort: cfg?.rpcPort ?? null,
      networkName: cfg?.networkName ?? null, virtualIpv4: cfg?.virtualIpv4 ?? null,
      proxyCidr: null, mappedCidr: null, publishedPorts: [], peers: [], peersAt: null,
      routes: [], routesAt: null, secureMode: false, socks5Port: null,
      aclOk: Boolean(cfg), aclProblems: [], lanIp: "127.0.0.1", lastCheckAt: null,
    };
  }
}

let dir: string;
let services: Service[] = [];
let magpie: FakeMagpie;
let sup: FakeSupervisor;
let binder: FakeBinder;
let ownership: FakeOwnership;
let clockMs: number;
let probes: { status: number; models: number; limit: number; local: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ohmyaihub-models-evidence-"));
  process.chdir(dir);
  for (const s of services.splice(0)) void s.stop();
  magpie = new FakeMagpie();
  sup = new FakeSupervisor();
  binder = new FakeBinder();
  ownership = new FakeOwnership();
  ownership.defaultPids = [4242, process.pid];
  clockMs = Date.parse("2026-10-31T00:00:00.000Z");
  probes = { status: 0, models: 0, limit: 0, local: 0 };
});

async function service(): Promise<Service> {
  const svc = new Service({
    magpie: magpie as never,
    magpieVersion: "magpie 0.1.2289",
    supervisor: sup,
    lanIp: () => "127.0.0.1",
    probeTimeoutMs: 100,
    ports: { binder, ownership, now: () => new Date(clockMs) },
    probes: {
      statusWith: async () => { probes.status += 1; return true; },
      remoteModelIds: async () => { probes.models += 1; return [...MODELS]; },
      localModelIds: async () => { probes.local += 1; return ["peer/peer-model-a"]; },
      remoteLimit: async () => { probes.limit += 1; return null; },
      catalogModels: async () => [] as never,
    },
  });
  services.push(svc);
  await svc.configure({ sharingEnabled: false, consumingEnabled: true, networkName: "evidence-lab", networkSecret: "evidence-secret" });
  sup.routeRows = [{ ipv4: "10.77.0.3/24", hostname: "peer-host", proxyCidrs: "192.0.2.84->10.66.1.2", nextHop: "DIRECT", pathLen: 1 }];
  return svc;
}

async function connected(): Promise<Service> {
  const svc = await service();
  await svc.addProvider({ id: "peer", mappedCidr: "10.66.1.2/32", key: KEY, providerPort: 3425, localPort: PORT });
  return svc;
}

function evidence(svc: Service) {
  return svc.providers()[0].modelsEvidence;
}

describe("provider models evidence", () => {
  test("connect writes current evidence bound to id/key generation/read time", async () => {
    const svc = await connected();
    const e = evidence(svc);
    expect(e).toMatchObject({ status: "current", source: "connect-readback", callable: "yes", modelCount: MODELS.length });
    expect(e.models).toEqual(MODELS);
    expect(Date.parse(e.readAt!)).toBe(clockMs);
    expect(Date.parse(e.expiresAt!)).toBe(clockMs + MODELS_EVIDENCE_TTL_MS);
    expect(e.generation).toBeGreaterThan(0);
    expect(e.keyGeneration).toBe(svc.providers()[0].keyGeneration);
    expect(e.keyRef).toContain("provider-keys.json#peer");
    expect(e.keyRef).not.toContain(KEY);
  });

  test("polling the projection never probes the remote", async () => {
    const svc = await connected();
    const before = { ...probes };
    for (let i = 0; i < 3; i++) {
      svc.providers();
      svc.consoleSnapshot();
    }
    expect(probes).toEqual(before);
  });

  test("expired evidence is stale with no count, still without probing", async () => {
    const svc = await connected();
    const before = { ...probes };
    clockMs += MODELS_EVIDENCE_TTL_MS + 1;
    const e = evidence(svc);
    expect(e.status).toBe("stale");
    expect(e.modelCount).toBeNull();
    expect(e.callable).toBe("unknown");
    expect(e.error).toMatch(/expired/);
    expect(probes).toEqual(before);
  });

  test("a new key increments the key generation and invalidates old evidence", async () => {
    const svc = await connected();
    const old = evidence(svc);
    await svc.updateProvider("peer", { key: KEY2 });
    const after = svc.providers()[0];
    expect(after.keyGeneration).toBe(2);
    expect(after.modelsEvidence.keyGeneration).toBe(2);
    expect(after.modelsEvidence.generation).toBeGreaterThan(old.generation);
    expect(after.modelsEvidence.status).toBe("current");
  });

  test("an identity change makes the evidence stale", async () => {
    const svc = await connected();
    const rec = (svc as unknown as { state: ReturnType<typeof loadState>["state"] }).state.providers[0]!;
    rec.fingerprint = { hostname: "someone-else", virtualIpv4: "10.77.0.9", peerId: "x" };
    const e = evidence(svc);
    expect(e.status).toBe("stale");
    expect(e.error).toMatch(/identity changed/);
  });

  test("provider-models performs a fresh read and updates the evidence", async () => {
    const svc = await connected();
    const before = evidence(svc);
    clockMs += 1000;
    const result = await svc.providerModels("peer");
    expect(result.models).toEqual(MODELS);
    expect(result.modelsEvidence).toMatchObject({ status: "current", source: "provider-models", callable: "yes", modelCount: MODELS.length });
    expect(result.modelsEvidence.generation).toBe(before.generation + 1);
    expect(Date.parse(result.modelsEvidence.readAt!)).toBe(clockMs);
    expect(probes.models).toBeGreaterThan(0);
  });

  test("a failed read marks evidence unknown and callable no for 401", async () => {
    const svc = await connected();
    const real = (svc as unknown as { probes: { remoteModelIds: unknown } }).probes.remoteModelIds;
    (svc as unknown as { probes: { remoteModelIds: unknown } }).probes.remoteModelIds = async () => {
      throw new Error("401 unauthorized");
    };
    await expect(svc.providerModels("peer")).rejects.toThrow(/401/);
    const e = evidence(svc);
    expect(e.status).toBe("stale"); // provider degraded after failure
    expect(e.callable).toBe("no");
    expect(e.error).toMatch(/401/);
    expect(e.modelCount).toBeNull();
    (svc as unknown as { probes: { remoteModelIds: unknown } }).probes.remoteModelIds = real;
  });

  test("reconcile verifyModels records a reconcile-source evidence", async () => {
    const svc = await connected();
    const before = evidence(svc);
    clockMs += 2000;
    await svc.reconcileProviders({ only: "peer", verifyModels: true });
    const e = evidence(svc);
    expect(e).toMatchObject({ status: "current", source: "reconcile", callable: "yes" });
    expect(e.generation).toBe(before.generation + 1);
  });

  test("a restart keeps keyGeneration, accepted fingerprint and evidence generation", async () => {
    const svc = await connected();
    const before = svc.providers()[0];
    const saved = loadState().state.providers[0]!;
    expect(saved.keyGeneration).toBe(before.keyGeneration);
    expect(saved.modelsEvidence?.generation).toBe(before.modelsEvidence.generation);
    expect(saved.modelsEvidence?.status).toBe("current");
    const restarted = new Service({
      magpie: magpie as never,
      magpieVersion: "magpie 0.1.2289",
      supervisor: sup,
      lanIp: () => "127.0.0.1",
      probeTimeoutMs: 100,
      ports: { binder, ownership, now: () => new Date(clockMs) },
      probes: { catalogModels: async () => [] as never },
    });
    services.push(restarted);
    const after = restarted.providers()[0];
    expect(after.keyGeneration).toBe(before.keyGeneration);
    expect(after.modelsEvidence.status).toBe("current");
    expect(after.modelsEvidence.generation).toBe(before.modelsEvidence.generation);
    expect(after.modelsEvidence.models).toEqual(before.modelsEvidence.models);
  });

  test("future read times and invalid expiry are stale, never current", async () => {
    const svc = await connected();
    const rec = (svc as unknown as { state: ReturnType<typeof loadState>["state"] }).state.providers[0]!;
    const now = Date.parse("2026-10-31T00:00:00.000Z");
    const base = rec.modelsEvidence!;
    const future = projectModelsEvidence(
      { ...rec, modelsEvidence: { ...base, readAt: new Date(now + 86_400_000).toISOString(), expiresAt: new Date(now + 172_800_000).toISOString() } },
      now,
    );
    expect(future.status).toBe("stale");
    expect(future.error).toMatch(/future/);
    const invalid = projectModelsEvidence({ ...rec, modelsEvidence: { ...base, expiresAt: "not-a-date" } }, now);
    expect(invalid.status).toBe("stale");
    expect(invalid.modelCount).toBeNull();
    const missingRead = projectModelsEvidence(
      { ...rec, modelsEvidence: { ...base, readAt: null, expiresAt: new Date(now + 60_000).toISOString() } },
      now,
    );
    expect(missingRead.status).toBe("stale");
    expect(missingRead.callable).toBe("unknown");
  });

  test("a keyRef mismatch makes the evidence unknown", async () => {
    const svc = await connected();
    const rec = (svc as unknown as { state: ReturnType<typeof loadState>["state"] }).state.providers[0]!;
    rec.modelsEvidence = { ...rec.modelsEvidence!, keyRef: "provider-keys.json#someone-else" };
    const e = evidence(svc);
    expect(e.status).toBe("unknown");
    expect(e.modelCount).toBeNull();
    expect(e.callable).toBe("unknown");
    expect(e.error).toMatch(/key reference/);
  });

  test("TTL at the limit is current, longer than the limit is stale", async () => {
    const svc = await connected();
    const rec = (svc as unknown as { state: ReturnType<typeof loadState>["state"] }).state.providers[0]!;
    const readAt = Date.parse(rec.modelsEvidence!.readAt!);
    rec.modelsEvidence = { ...rec.modelsEvidence!, expiresAt: new Date(readAt + MODELS_EVIDENCE_TTL_MS).toISOString() };
    expect(evidence(svc).status).toBe("current");
    rec.modelsEvidence = { ...rec.modelsEvidence!, expiresAt: new Date(readAt + MODELS_EVIDENCE_TTL_MS + 1).toISOString() };
    const e = evidence(svc);
    expect(e.status).toBe("stale");
    expect(e.modelCount).toBeNull();
    expect(e.error).toMatch(/TTL/);
  });

  test("save/load preserves the evidence and remains idempotent", async () => {
    const svc = await connected();
    const first = loadState().state.providers[0]!;
    const serialized = JSON.stringify(first.modelsEvidence);
    const again = loadState().state.providers[0]!;
    expect(JSON.stringify(again.modelsEvidence)).toBe(serialized);
    expect(again.keyRef).toBe(first.keyRef);
    const state = loadState().state;
    saveState(state);
    const reloaded = loadState().state.providers[0]!;
    expect(JSON.stringify(reloaded.modelsEvidence)).toBe(serialized);
    expect(reloaded.modelsEvidence?.status).toBe("current");
  });

  test("disconnecting the provider never leaves current evidence", async () => {
    const svc = await connected();
    const removed = await svc.removeProvider("peer");
    expect(removed.status).toBe("disabled");
    expect(removed.modelsEvidence.status).toBe("stale");
  });
});
