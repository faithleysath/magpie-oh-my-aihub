// Phase 10 A-service: the automatic-port unit on its own.
//
// These tests never create a listener except where the real binder is under
// test, so no host port and no overlay is touched.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PORT_EVIDENCE_LIMIT,
  PORT_MIGRATION_LIMIT,
  SocketBinder,
  claimFreePort,
  emptyPortLedger,
  evidenceFor,
  normalizePortLedger,
  portRange,
  proofEvidence,
  reachabilityOf,
  recordPortEvidence,
  recordPortMigration,
  verifyOwnedPort,
} from "../src/ports.ts";
import { FakeBinder } from "./support/fake-ports.ts";

describe("port ledger", () => {
  test("a persisted ledger is validated instead of trusted", () => {
    const ledger = normalizePortLedger({
      version: 1,
      migrations: [
        { at: "2026-10-31T00:00:00.000Z", purpose: "easytier-rpc", from: 17888, to: 17889, reason: "in use" },
        { at: "2026-10-31T00:00:00.000Z", purpose: "not-a-purpose", from: 1, to: 2, reason: "junk" },
        { at: "2026-10-31T00:00:00.000Z", purpose: "catalog", from: 0, to: 70000, reason: "bad port" },
        null,
      ],
      evidence: [
        { purpose: "catalog", port: 3427, host: "192.0.2.5", owner: "plugin", state: "conflict", verifiedAt: "2026-10-31T00:00:00.000Z", detail: "taken" },
        { purpose: "forward", port: "x", host: "127.0.0.1", owner: "easytier", state: "stable" },
      ],
    });
    expect(ledger.migrations).toHaveLength(1);
    expect(ledger.migrations[0]).toMatchObject({ purpose: "easytier-rpc", from: 17888, to: 17889 });
    expect(ledger.evidence).toHaveLength(1);
    expect(ledger.evidence[0]).toMatchObject({ purpose: "catalog", port: 3427, state: "conflict", reachability: "lan" });
  });

  test("migrations and evidence are capped, newest kept", () => {
    let ledger = emptyPortLedger();
    for (let i = 0; i < PORT_MIGRATION_LIMIT + 5; i++) {
      ledger = recordPortMigration(ledger, {
        at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        purpose: "catalog",
        from: 3400 + i,
        to: 3500 + i,
        reason: "test",
      });
    }
    expect(ledger.migrations).toHaveLength(PORT_MIGRATION_LIMIT);
    expect(ledger.migrations.at(-1)!.to).toBe(3500 + PORT_MIGRATION_LIMIT + 4);

    let withEvidence = emptyPortLedger();
    for (let i = 0; i < PORT_EVIDENCE_LIMIT + 5; i++) {
      withEvidence = recordPortEvidence(withEvidence, {
        purpose: "forward",
        port: 13000 + i,
        host: "127.0.0.1",
        owner: "easytier",
        state: "stable",
        verifiedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        detail: null,
      });
    }
    expect(withEvidence.evidence).toHaveLength(PORT_EVIDENCE_LIMIT);
  });

  test("the newest proof for one port replaces the older one", () => {
    let ledger = emptyPortLedger();
    ledger = recordPortEvidence(ledger, {
      purpose: "catalog",
      port: 3426,
      host: "192.0.2.5",
      owner: "plugin",
      state: "failed",
      verifiedAt: "2026-10-31T00:00:00.000Z",
      detail: "not bound",
    });
    ledger = recordPortEvidence(ledger, {
      purpose: "catalog",
      port: 3426,
      host: "192.0.2.5",
      owner: "plugin",
      state: "stable",
      verifiedAt: "2026-10-31T00:01:00.000Z",
      detail: null,
    });
    expect(ledger.evidence).toHaveLength(1);
    expect(evidenceFor(ledger, "catalog", 3426)!.state).toBe("stable");
    expect(evidenceFor(ledger, "catalog", 3427)).toBeNull();
  });
});

describe("claiming a port", () => {
  test("skip taken and excluded candidates, hold the chosen one", async () => {
    const binder = new FakeBinder();
    binder.occupy("127.0.0.1", 13425);
    const claim = await claimFreePort(binder, "127.0.0.1", portRange(13425, 13430), { exclude: [13426] });
    expect(claim.reservation.port).toBe(13427);
    expect(claim.skipped).toEqual([13425, 13426]);
    expect(await binder.isFree("127.0.0.1", 13427)).toBe(false);
    await claim.reservation.release();
    expect(await binder.isFree("127.0.0.1", 13427)).toBe(true);
  });

  test("an exhausted range is a real failure, not a fallback", async () => {
    const binder = new FakeBinder();
    binder.occupy("127.0.0.1", 13425);
    binder.occupy("127.0.0.1", 13426);
    await expect(claimFreePort(binder, "127.0.0.1", [13425, 13426])).rejects.toThrow(/no free port/);
  });
});

describe("proving the controlled listener owns the port", () => {
  test("reported + in use is stable", async () => {
    const binder = new FakeBinder();
    binder.occupy("127.0.0.1", 17888);
    const proof = await verifyOwnedPort({
      binder,
      purpose: "easytier-rpc",
      host: "127.0.0.1",
      port: 17888,
      owner: "easytier",
      reported: true,
    });
    expect(proof).toMatchObject({ state: "stable", inUse: true, reported: true });
  });

  test("reported + nothing listening is a conflict, never green", async () => {
    const binder = new FakeBinder();
    const proof = await verifyOwnedPort({
      binder,
      purpose: "catalog",
      host: "192.0.2.5",
      port: 3426,
      owner: "plugin",
      reported: true,
    });
    expect(proof.state).toBe("conflict");
    expect(proof.detail).toMatch(/refusing to use it/);
  });

  test("the child not holding the port is a failure", async () => {
    const binder = new FakeBinder();
    const proof = await verifyOwnedPort({
      binder,
      purpose: "catalog-socks",
      host: "127.0.0.1",
      port: 13400,
      owner: "easytier",
      reported: false,
    });
    expect(proof).toMatchObject({ state: "failed", reported: false });
  });

  test("no evidence is unverified, not stable", async () => {
    const binder = new FakeBinder();
    const proof = await verifyOwnedPort({
      binder,
      purpose: "forward",
      host: "127.0.0.1",
      port: 13425,
      owner: "easytier",
      reported: null,
    });
    expect(proof.state).toBe("unverified");
    const evidence = proofEvidence({ purpose: "forward", host: "127.0.0.1", port: 13425, owner: "easytier", proof });
    expect(evidence.reachability).toBe("loopback");
    expect(evidence.state).toBe("unverified");
  });
});

describe("reachability is stated, not assumed", () => {
  test("loopback, LAN and overlay addresses are different boundaries", () => {
    expect(reachabilityOf("127.0.0.1")).toBe("loopback");
    expect(reachabilityOf("::1")).toBe("loopback");
    expect(reachabilityOf("0.0.0.0")).toBe("lan");
    expect(reachabilityOf("192.0.2.5")).toBe("lan");
    expect(reachabilityOf("10.77.0.4")).toBe("overlay");
    expect(reachabilityOf(null)).toBe("unknown");
  });
});

describe("the real binder", () => {
  test("holds a real socket, reports the assigned port and releases it", async () => {
    const binder = new SocketBinder();
    const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-port-"));
    process.chdir(dir);
    const held = await binder.reserve("127.0.0.1", 0);
    expect(held).not.toBeNull();
    expect(held!.port).toBeGreaterThan(0);
    expect(await binder.isFree("127.0.0.1", held!.port)).toBe(false);
    await held!.release();
    expect(await binder.isFree("127.0.0.1", held!.port)).toBe(true);
  });
});
