import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";

/**
 * The Windows job must exercise more than pure functions: Bun's HTTP server and
 * raw TCP sockets are the runtime pieces the plugin relies on on every host.
 * Everything here is loopback-only and uses an ephemeral port, so it is safe to
 * run on Windows, macOS and Linux with no external network.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("cross-platform loopback runtime", () => {
  test("Bun.serve answers HTTP and echoes JSON on 127.0.0.1", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/health") return Response.json({ ok: true });
        if (url.pathname === "/echo" && request.method === "POST") {
          return Response.json({ method: request.method, body: await request.json() });
        }
        return new Response("not found", { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    expect(server.hostname).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    const echo = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: process.platform }),
      signal: AbortSignal.timeout(5000),
    });
    expect(echo.status).toBe(200);
    expect(await echo.json()).toEqual({ method: "POST", body: { platform: process.platform } });
  });

  test("raw TCP loopback carries bytes in both directions", async () => {
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    const client = connect({ host: "127.0.0.1", port: address.port });
    cleanups.push(() => client.destroy());
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const payload = Buffer.from(`oh-my-aihub loopback ${process.platform} ${Date.now()}\n`, "utf8");
    const echoed = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        if (Buffer.concat(chunks).length >= payload.length) resolve(Buffer.concat(chunks));
      });
      client.once("error", reject);
    });
    client.write(payload);
    expect((await echoed).equals(payload)).toBe(true);
    client.end();
  }, 10000);
});
