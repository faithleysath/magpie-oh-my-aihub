// Ownership gate and canonical control-forward state.
//
// A Magpie host probe or a second Service instance must never adopt, restart or
// stop the shared overlay core; only the host-lock owner may do that. The
// owner's control forwards are persisted so a successor host expects the same
// canonical set, while a foreign forward still fails closed.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, type SupervisorLike } from "../src/service.ts";
import type { ForwardSpec } from "../src/easytier.ts";

class FakeMagpie {
  providersReadable() { return true; }
  nativeProviderIds() { return new Set<string>(); }
  remoteProviderIds() { return new Set<string>(); }
  keyById() { return undefined; }
}

class FakeSupervisor {
  calls: string[] = [];
  forwards: ForwardSpec[] = [];
  snapshot() {
    return { running: false, pid: null, publishedPorts: [], mappedCidr: null, aclOk: true, aclProblems: [], lastError: null } as never;
  }
  async start() { this.calls.push("start"); }
  async stop() { this.calls.push("stop"); }
  async refresh() { this.calls.push("refresh"); return this.snapshot(); }
  setForwards(f: ForwardSpec[]) { this.forwards = f.map((x) => ({ ...x })); }
  async addPortForward(bindAddr: string, dstAddr: string) { this.calls.push(`add:${bindAddr}`); this.forwards.push({ bindAddr, dstAddr }); return true; }
  async removePortForward(bindAddr: string) { this.calls.push(`remove:${bindAddr}`); this.forwards = this.forwards.filter((f) => f.bindAddr !== bindAddr); return true; }
  async listPortForwards() { return this.forwards.map((f) => ({ ...f, proto: "TCP" as const })); }
  async listPortForwardPids() { return []; }
}

function service(supervisor: FakeSupervisor, ownsHost: () => boolean = () => true) {
  return new Service({
    magpie: new FakeMagpie() as never,
    magpieVersion: "test",
    supervisor: supervisor as unknown as SupervisorLike,
    ownsHost,
  });
}

beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), "owner-gate-"))); });

describe("host ownership", () => {
  test("a non-owner Service cannot start, adopt or stop the shared core", async () => {
    const sup = new FakeSupervisor();
    const svc = service(sup, () => false);
    await expect(svc.start()).rejects.toThrow(/does not own the host/);
    await svc.stop();
    expect(sup.calls).not.toContain("start");
    expect(sup.calls).not.toContain("stop");
    expect(svc.controlForwardView()).toEqual([]);
  });

  test("an owned control forward is canonical and loaded by the next owner", async () => {
    const first = new FakeSupervisor();
    const a = service(first);
    await a.addControlForward("127.0.0.1:35101", "10.66.1.2:35001");
    expect(first.calls).toContain("add:127.0.0.1:35101");
    expect(a.controlForwardView()).toEqual([{ bindAddr: "127.0.0.1:35101", dstAddr: "10.66.1.2:35001" }]);
    // A fresh Service is what a restarted Magpie host constructs.
    const second = new FakeSupervisor();
    const b = service(second);
    expect(b.controlForwardView()).toEqual([{ bindAddr: "127.0.0.1:35101", dstAddr: "10.66.1.2:35001" }]);
  });

  test("a foreign forward still refuses the control restart (fail closed)", async () => {
    const sup = new FakeSupervisor();
    sup.forwards = [
      { bindAddr: "127.0.0.1:35101", dstAddr: "10.66.1.2:35001" },
      { bindAddr: "127.0.0.1:39999", dstAddr: "10.66.9.9:35000" },
    ];
    const svc = service(sup);
    const result = await svc.retireControlForward("127.0.0.1:35101", "10.66.1.2:35001");
    expect(result.restarted).toBe(false);
    expect(result.orphan).toBe(true);
    expect(sup.calls).not.toContain("start");
  });
});
