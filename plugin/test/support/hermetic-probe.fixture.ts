// Spawned by test/network-guard.test.ts: a test that swallows the guard's
// refusal must still be reported as a failure by afterEach.
//
// The guard is imported explicitly as well as preloaded, so this fixture fails
// the same way whether or not bunfig.toml preload reached the child process.
import { expect, test } from "bun:test";
import { guardInstalled } from "./network-guard.ts";

test("swallows a blocked request", async () => {
  expect(guardInstalled()).toBe(true);
  try {
    await fetch("https://example.invalid/leak");
  } catch {
    // exactly what a lazy try/catch does
  }
  expect(true).toBe(true);
});
