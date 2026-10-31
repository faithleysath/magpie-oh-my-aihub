// Real Bun HTTP two-Service journey: two isolated child processes, each with a
// real Service/Provisioner/Ledger/P2pStore and a real ControlApp listener.
// Cross-node traffic goes through the control HTTP endpoints via a loopback
// proxy; the local test-control endpoint only invokes local app/Service actions.
//
// Fake Magpie/supervisor only; no EasyTier, no real Magpie, no public RPC.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "support", "http-node-runner.ts");
const TOKEN = "test-" + Math.random().toString(36).slice(2);
const QUOTE_HASH = "ab".repeat(32);
const MODEL = "lab/lab-model";
const CAP = 1;

interface NodeInfo {
  role: string;
  nodeId: string;
  fingerprint: string;
  controlPort: number;
  testPort: number;
  quoteHash: string;
  publicKey: string;
  models: string[];
  sharingEnabled: boolean;
  mappedCidr: string | null;
  gatewayPort: number;
  catalogPort: number;
  providerId: string;
}

class NodeProc {
  constructor(
    readonly proc: ReturnType<typeof Bun.spawn>,
    readonly info: NodeInfo,
    readonly logs: string[],
  ) {}
  async action(name: string, input: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${this.info.testPort}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-token": TOKEN },
      body: JSON.stringify({ name, input }),
    });
    const body = (await res.json()) as { error?: string } & Record<string, unknown>;
    if (!res.ok || body.error) throw new Error(`${name} failed: ${body.error ?? res.status}`);
    return body;
  }
  async infoDoc(): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${this.info.testPort}/info`, { headers: { "x-test-token": TOKEN } });
    return res.json();
  }
  async stop(): Promise<void> {
    try {
      await this.action("stop");
    } catch {
      /* already gone */
    }
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    await Promise.race([this.proc.exited, Bun.sleep(1000)]);
  }
}

async function spawnNode(role: "provider" | "consumer", env: Record<string, string>): Promise<NodeProc> {
  const dir = mkdtempSync(join(tmpdir(), `http-${role}-`));
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", RUNNER],
    cwd: dir,
    env: {
      ...process.env,
      ROLE: role,
      DIR: dir,
      TEST_TOKEN: TOKEN,
      QUOTE_HASH,
      PROVIDER_NODE_ID: env.PROVIDER_NODE_ID ?? "aa11bb22",
      PROVIDER_FINGERPRINT: env.PROVIDER_FINGERPRINT ?? "",
      CAP_USD: String(CAP),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const logs: string[] = [];
  const reader = proc.stdout.getReader();
  const errReader = proc.stderr.getReader();
  const readErr = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await errReader.read();
      if (done) break;
      logs.push("ERR " + dec.decode(value));
    }
  })();
  const deadline = Date.now() + 15_000;
  let buffer = "";
  const dec = new TextDecoder();
  for (;;) {
    if (Date.now() > deadline) throw new Error(`node did not become ready: ${logs.join("")}`);
    const { value, done } = await Promise.race([
      reader.read(),
      Bun.sleep(1000).then(() => ({ value: undefined, done: false })),
    ]);
    if (done) throw new Error(`node exited before ready: ${logs.join("")}`);
    if (!value) continue;
    buffer += dec.decode(value);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      logs.push(line);
      if (line.startsWith("READY ")) {
        const info = JSON.parse(line.slice(6)) as NodeInfo;
        void readErr;
        return new NodeProc(proc, info, logs);
      }
    }
  }
}

async function until<T>(fn: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (check(last)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`condition not met; last=${JSON.stringify(last)}`);
}

const nodes: NodeProc[] = [];
const proxies: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(async () => {
  for (const node of nodes.splice(0)) await node.stop();
  for (const proxy of proxies.splice(0)) proxy.stop(true);
});

describe("real HTTP two-Service journey", () => {
  test("request -> provider HTTP -> human approve -> consumer pull -> native Remote readback -> ACK", async () => {
    const provider = await spawnNode("provider", { NODE_ID: "aa11bb22" });
    nodes.push(provider);
    expect(provider.info.sharingEnabled).toBe(true);

    let dropNextPoll = false;
    const counts = new Map<string, number>();
    const frames: Array<{ path: string; body: Buffer }> = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname + url.search;
        counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
        const target = `http://127.0.0.1:${provider.info.controlPort}${path}`;
        const headers = new Headers();
        const ct = req.headers.get("content-type");
        if (ct) headers.set("content-type", ct);
        headers.set("host", `127.0.0.1:${provider.info.controlPort}`);
        const body = req.method === "POST" ? Buffer.from(await req.arrayBuffer()) : undefined;
        if (url.pathname === "/p2p/v1/frame" && body) frames.push({ path, body });
        const upstream = await fetch(target, { method: req.method, headers, body });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (url.pathname === "/p2p/v1/poll" && dropNextPoll) {
          dropNextPoll = false;
          return new Response("lost poll response", { status: 502 });
        }
        return new Response(bytes, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        });
      },
    });
    proxies.push(proxy);

    const consumer = await spawnNode("consumer", {
      NODE_ID: "cc33dd44",
      PROVIDER_NODE_ID: provider.info.nodeId,
      PROVIDER_FINGERPRINT: provider.info.fingerprint,
      PROVIDER_PUBLIC_KEY: provider.info.publicKey,
      PROVIDER_CONTROL_PORT: String(provider.info.controlPort),
    });
    nodes.push(consumer);
    expect(consumer.info.sharingEnabled).toBe(false);
    expect(consumer.info.mappedCidr).toBeNull();

    await consumer.action("registerPeer", {
      nodeId: provider.info.nodeId,
      fingerprint: provider.info.fingerprint,
      quoteHash: provider.info.quoteHash,
      host: "127.0.0.1",
      port: proxy.port,
      hostHeader: `127.0.0.1:${provider.info.controlPort}`,
      controlPort: provider.info.controlPort,
    });

    const requested = await consumer.action("request", {
      nodeId: provider.info.nodeId,
      fingerprint: provider.info.fingerprint,
      quoteHash: provider.info.quoteHash,
      models: [MODEL],
    });
    expect(requested.state).toBe("pending");
    const requestId = String(requested.requestId);

    const inbound = await until(
      () => provider.action("requests"),
      (rows: any[]) => Array.isArray(rows) && rows.some((r) => r.requestHash === requestId),
    );
    expect(inbound.some((r) => r.requestHash === requestId)).toBe(true);

    const preview = await provider.action("quotePreview", { requestId, models: [MODEL] });
    const approval = await provider.action("approve", {
      requestId,
      consumerFingerprint: consumer.info.fingerprint,
      quoteHash: provider.info.quoteHash,
      priceVersion: preview.priceVersion,
      generation: null,
      models: [MODEL],
      capUsd: CAP,
      acceptFingerprint: consumer.info.fingerprint,
    });
    expect(approval.state).not.toBe("rejected");

    let providers: any = { service: [] };
    for (let i = 0; i < 8; i++) {
      try {
        await consumer.action("poll");
      } catch (e) {
      }
      providers = await consumer.action("providers");
      if (providers.service?.some((x: any) => x.status === "connected")) break;
      await Bun.sleep(1500);
    }
    expect(providers.service.some((p: any) => p.status === "connected")).toBe(true);

    const acked = await until(
      () => provider.action("approvals"),
      (rows: any[]) => Array.isArray(rows) && rows.some((a) => a.approvalId === approval.approvalId && a.ackState === "acked"),
    );
    expect(acked.some((a) => a.approvalId === approval.approvalId && a.ackState === "acked")).toBe(true);

    const keys = await provider.action("keys");
    expect(keys).toHaveLength(1);
    expect(keys[0].models).toEqual([MODEL]);

    // Real HTTP was used for hello, request frame and poll.
    expect(counts.get("/p2p/v1/hello") ?? 0).toBeGreaterThan(0);
    expect(counts.get("/p2p/v1/frame") ?? 0).toBeGreaterThan(0);
    expect(counts.get("/p2p/v1/poll") ?? 0).toBeGreaterThan(0);
    expect(frames.length).toBeGreaterThan(0);

    // Replaying an exact captured request frame must not create a second request.
    const first = frames[0];
    const replay = await fetch(`http://127.0.0.1:${provider.info.controlPort}${first.path}`, {
      method: "POST",
      headers: { host: `127.0.0.1:${provider.info.controlPort}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(first.body),
    });
    expect([200, 204, 409]).toContain(replay.status);
    const requestsAfterReplay = await provider.action("requests");
    expect(requestsAfterReplay.filter((r: any) => r.requestHash === requestId)).toHaveLength(1);

    // A duplicate local approval must not mint a second key.
    try {
      await provider.action("approve", {
        requestId,
        consumerFingerprint: consumer.info.fingerprint,
        quoteHash: provider.info.quoteHash,
        priceVersion: preview.priceVersion,
        generation: null,
        models: [MODEL],
        capUsd: CAP,
        acceptFingerprint: consumer.info.fingerprint,
      });
    } catch {
      /* idempotent or conflict; both are acceptable */
    }
    expect(await provider.action("keys")).toHaveLength(1);

  }, 30_000);
});
