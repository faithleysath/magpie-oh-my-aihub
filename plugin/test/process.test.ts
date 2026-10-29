import { describe, expect, test } from "bun:test";
import { ownsProcess, relocationDecision } from "../src/easytier.ts";

describe("process ownership", () => {
  test("a pid with another command line is not ours", () => {
    // this test runner's command line has no easytier-core and no config path
    expect(ownsProcess(process.pid, "/tmp/oh-my-aihub/easytier/current.toml")).toBe(false);
  });

  test("pid 1 and nonsense pids are never ours", () => {
    expect(ownsProcess(1, "/tmp/x")).toBe(false);
    expect(ownsProcess(0, "/tmp/x")).toBe(false);
    expect(ownsProcess(-5, "/tmp/x")).toBe(false);
    expect(ownsProcess(99_999_999, "/tmp/x")).toBe(false);
  });
});

describe("LAN address relocation", () => {
  const base = { current: "192.0.2.84/32", pending: null as string | null, count: 0, now: 1_000_000, lastAt: 0 };

  test("no change, no relocation", () => {
    expect(relocationDecision({ ...base, observed: "192.0.2.84/32" })).toEqual({ relocate: false, pending: null, count: 0 });
  });

  test("one sighting only arms the change", () => {
    const a = relocationDecision({ ...base, observed: "192.0.2.99/32" });
    expect(a).toEqual({ relocate: false, pending: "192.0.2.99/32", count: 1 });
    const b = relocationDecision({ ...base, observed: "192.0.2.99/32", pending: a.pending, count: a.count });
    expect(b.relocate).toBe(true);
  });

  test("a flapping address does not arm", () => {
    const a = relocationDecision({ ...base, observed: "192.0.2.99/32" });
    const back = relocationDecision({ ...base, observed: "192.0.2.84/32", pending: a.pending, count: a.count });
    expect(back).toEqual({ relocate: false, pending: null, count: 0 });
  });

  test("two relocations within a minute are refused", () => {
    const r = relocationDecision({ ...base, observed: "192.0.2.99/32", pending: "192.0.2.99/32", count: 1, lastAt: 1_000_000 - 30_000 });
    expect(r.relocate).toBe(false);
  });

  test("nothing to compare means nothing happens", () => {
    expect(relocationDecision({ ...base, observed: null }).relocate).toBe(false);
    expect(relocationDecision({ ...base, current: null, observed: "192.0.2.99/32" }).relocate).toBe(false);
  });
});
