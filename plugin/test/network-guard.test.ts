import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectBlocked, guardInstalled, isTestServerAllowed, registerTestServer } from "./support/network-guard.ts";

describe("hermetic network guard", () => {
  test("is installed by the test preload", () => {
    expect(guardInstalled()).toBe(true);
  });

  test("a server started by the test is reachable at exactly its own origin", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      expect(isTestServerAllowed(`http://127.0.0.1:${server.port}`)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
    expect(isTestServerAllowed(`http://127.0.0.1:${server.port}`)).toBe(false);
  });

  test("another loopback port is not allowed just because it is loopback", async () => {
    const registered = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = registered.port!;
    try {
      const other = port + 1;
      expect(isTestServerAllowed(`http://127.0.0.1:${other}`)).toBe(false);
      const refused = await expectBlocked(() => fetch(`http://127.0.0.1:${other}/`));
      expect(refused).toBe(true);
    } finally {
      registered.stop(true);
    }
  });

  test("the production gateway port 3425 and LAN addresses are refused", async () => {
    expect(await expectBlocked(() => fetch("http://127.0.0.1:3425/v1/models"))).toBe(true);
    expect(await expectBlocked(() => fetch("http://192.168.43.86:3425/v1/models"))).toBe(true);
  });

  test("public testnet RPC endpoints are refused", async () => {
    for (const url of [
      "https://bsc-testnet-rpc.publicnode.com",
      "https://sepolia.base.org",
      "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    ]) {
      expect(await expectBlocked(() => fetch(url))).toBe(true);
    }
  });

  test("explicit registration is exact and scoped", () => {
    registerTestServer("http://127.0.0.1:43210");
    expect(isTestServerAllowed("http://127.0.0.1:43210")).toBe(true);
    expect(isTestServerAllowed("http://127.0.0.1:43211")).toBe(false);
    expect(isTestServerAllowed("http://localhost:43210")).toBe(false);
  });

  test("a swallowed request still fails a test in a real bun run", async () => {
    const probe = join(import.meta.dir, "support/hermetic-probe.fixture.ts");
    const child = Bun.spawn([process.execPath, "test", probe], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const text = out + err;
    expect(code).not.toBe(0);
    expect(text).toContain("hermetic network guard");
    expect(text).toContain("example.invalid");
  });
});
