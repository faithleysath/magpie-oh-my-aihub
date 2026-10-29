import { describe, expect, test } from "bun:test";
import { existsSync, readlinkSync } from "node:fs";
import { resolveMagpieBin } from "../src/paths.ts";

describe("resolveMagpieBin — Linux /proc/<pid>/exe", () => {
  test("reads the symlink target, never the executable's bytes", () => {
    const calls: string[] = [];
    const path = resolveMagpieBin({
      platform: "linux",
      ppid: 4242,
      exists: () => true,
      readlink: (p) => {
        calls.push(p);
        return "/opt/Magpie Dir/magpie";
      },
      parentCommand: () => "",
      parentCwd: () => "",
      which: () => "",
    });
    expect(calls).toEqual(["/proc/4242/exe"]);
    expect(path).toBe("/opt/Magpie Dir/magpie"); // spaces survive
  });

  test("strips the kernel's ' (deleted)' suffix", () => {
    const path = resolveMagpieBin({
      platform: "linux",
      ppid: 7,
      exists: () => true,
      readlink: () => "/usr/local/bin/magpie (deleted)",
      parentCommand: () => "",
      parentCwd: () => "",
      which: () => "",
    });
    expect(path).toBe("/usr/local/bin/magpie");
  });

  test("a missing /proc entry falls through, not a crash", () => {
    const path = resolveMagpieBin({
      platform: "linux",
      ppid: 7,
      exists: (p) => p === "/usr/bin/magpie",
      readlink: () => {
        throw new Error("ENOENT");
      },
      parentCommand: () => "",
      parentCwd: () => "",
      which: () => "/usr/bin/magpie",
    });
    expect(path).toBe("/usr/bin/magpie");
  });
});

describe("resolveMagpieBin — no silent fallback to another installation", () => {
  test("an explicit override that is gone is an error", () => {
    expect(() =>
      resolveMagpieBin({
        env: "/gone/magpie",
        platform: "darwin",
        exists: () => false, // even the app bundle is "there" below
        parentCommand: () => "",
        parentCwd: () => "",
        which: () => "/Applications/magpie.app/Contents/MacOS/magpie",
      }),
    ).toThrow(/OH_MY_AIHUB_MAGPIE is set to .* does not exist/);
  });

  test("a parent that is a magpie but cannot be resolved is an error, not the app bundle", () => {
    const exists = (p: string) => p === "/Applications/magpie.app/Contents/MacOS/magpie";
    expect(() =>
      resolveMagpieBin({
        platform: "darwin",
        ppid: 9,
        exists,
        parentCommand: () => "./Magpie.app/Contents/MacOS/magpie serve",
        parentCwd: () => "/gone/provider",
        which: () => "/Applications/magpie.app/Contents/MacOS/magpie",
      }),
    ).toThrow(/cannot be resolved/);
  });

  test("a relative parent path is resolved against the parent's own cwd", () => {
    const exists = (p: string) => p === "/Users/x/p3/provider/Magpie.app/Contents/MacOS/magpie";
    const path = resolveMagpieBin({
      platform: "darwin",
      ppid: 9,
      exists,
      parentCommand: () => "./Magpie.app/Contents/MacOS/magpie serve",
      parentCwd: () => "/Users/x/p3/provider",
      which: () => "",
    });
    expect(path).toBe("/Users/x/p3/provider/Magpie.app/Contents/MacOS/magpie");
  });

  test("a parent that is not magpie may fall back to PATH", () => {
    const path = resolveMagpieBin({
      platform: "linux",
      ppid: 9,
      exists: (p) => p === "/usr/local/bin/magpie",
      readlink: () => "/usr/local/bin/bun",
      parentCommand: () => "bun host.js",
      parentCwd: () => "/tmp",
      which: () => "/usr/local/bin/magpie",
    });
    expect(path).toBe("/usr/local/bin/magpie");
  });
});

describe("resolveMagpieBin — the real machine", () => {
  // A CI runner has no Magpie installed; there is nothing to find there.
  const real = (() => {
    try {
      return resolveMagpieBin();
    } catch {
      return null;
    }
  })();

  test.skipIf(real === null)("finds an existing magpie on this host", () => {
    expect(real!.length).toBeGreaterThan(0);
    expect(existsSync(real!)).toBe(true);
    expect(real!.toLowerCase()).toContain("magpie");
  });

  if (process.platform === "linux") {
    test("the real /proc/self/exe is a path, not the executable's content", () => {
      // Runs on the Linux CI runner: bun is the parent of this test process, so
      // the resolver must fall through to `which` but the read itself must give a
      // short path (a byte read would return hundreds of KB of ELF).
      const target = readlinkSync("/proc/self/exe");
      expect(target.length).toBeLessThan(4096);
      expect(target.startsWith("/")).toBe(true);
      expect(target).not.toContain("\u0000");
    });
  }
});
