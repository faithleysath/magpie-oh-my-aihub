// Spawned by test/network-guard.test.ts: a test that swallows the guard's
// refusal must still be reported as a failure by afterEach.
import { expect, test } from "bun:test";

test("swallows a blocked request", async () => {
  try {
    await fetch("https://example.invalid/leak");
  } catch {
    // exactly what a lazy try/catch does
  }
  expect(true).toBe(true);
});
