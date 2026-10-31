// Real Bun HTTP two-Service journey: two isolated child processes, each with a
// real Service/Provisioner/Ledger/P2pStore and a real ControlApp listener.
// Cross-node traffic goes through the control HTTP endpoints via a loopback
// proxy; the local test-control endpoint only invokes local app/Service actions.
//
// Fake Magpie/supervisor only; no EasyTier, no real Magpie, no public RPC.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { registerTestServer, unregisterTestServer } from "./support/network-guard.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "support", "http-node-runner.ts");
const TOKEN = "test-" + Math.random().toString(36).slice(2);
const QUOTE_HASH = "ab".repeat(32);
const MODEL = "lab/lab-model";
const CAP = 1;
const MAPPED = "10.66.1.2/32";

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
  private stopped = false;
  constructor(
    readonly dir: string,
    readonly proc: ReturnType<typeof Bun.spawn>,
    readonly info: NodeInfo,
    readonly logs: string[],
  ) {}
  /** The child is a real server this test started; register its exact origins. */
  get origin(): string { return `http://127.0.0.1:${this.info.testPort}`; }
  get controlOrigin(): string { return `http://127.0.0.1:${this.info.controlPort}`; }
  async action(name: string, input: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(`${this.origin}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-token": TOKEN },
      body: JSON.stringify({ name, input }),
    });
    const body = (await res.json()) as { error?: string } & Record<string, unknown>;
    if (!res.ok || body.error) throw new Error(`${name} failed: ${body.error ?? res.status}`);
    return body;
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
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
    unregisterTestServer(this.origin);
    unregisterTestServer(this.controlOrigin);
  }
}

async function spawnNode(role: "provider" | "consumer", env: Record<string, string>, dir?: string, attempts = 2): Promise<NodeProc> {
  const stateDir = dir ?? mkdtempSync(join(tmpdir(), `http-${role}-`));
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", RUNNER],
    cwd: stateDir,
    env: {
      ...process.env,
      ROLE: role,
      DIR: stateDir,
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
  void (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await errReader.read();
      if (done) break;
      logs.push("ERR " + dec.decode(value));
    }
  })();
  try {
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
        const node = new NodeProc(stateDir, proc, JSON.parse(line.slice(6)) as NodeInfo, logs);
        // Both listeners live in the child process, so the preloaded guard in
        // this process has to be told they are test-owned before any fetch.
        registerTestServer(node.origin);
        registerTestServer(node.controlOrigin);
        return node;
      }
    }
  }
  } catch (e) {
    try { proc.kill(); } catch { /* gone */ }
    if (attempts > 1) {
      await Bun.sleep(250);
      return spawnNode(role, env, undefined, attempts - 1);
    }
    throw e;
  }
}

async function until<T>(fn: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
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

interface Journey {
  provider: NodeProc;
  consumer: NodeProc;
  proxy: ReturnType<typeof Bun.serve>;
  target: { port: number };
  control: { dropNextPoll: boolean; dropped: number };
  counts: Map<string, number>;
  frames: Array<{ path: string; body: Buffer }>;
  requestId: string;
  approval: any;
  preview: any;
}

async function setupJourney(approve = true): Promise<Journey> {
  const provider = await spawnNode("provider", { NODE_ID: "aa11bb22" });
  nodes.push(provider);
  const target = { port: provider.info.controlPort };
  const control = { dropNextPoll: false, dropped: 0 };
  const counts = new Map<string, number>();
  const frames: Array<{ path: string; body: Buffer }> = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname + url.search;
      counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
      const upstreamUrl = `http://127.0.0.1:${target.port}${path}`;
      const headers = new Headers();
      const ct = req.headers.get("content-type");
      if (ct) headers.set("content-type", ct);
      headers.set("host", `127.0.0.1:${target.port}`);
      const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
      if (url.pathname === "/p2p/v1/frame" && body) frames.push({ path, body: Buffer.from(body) });
      const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (url.pathname === "/p2p/v1/poll" && control.dropNextPoll) {
        control.dropNextPoll = false;
        control.dropped += 1;
        return new Response("lost poll response", { status: 502 });
      }
      return new Response(new Uint8Array(bytes), {
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
  const requestId = String(requested.requestId);
  await until(
    () => provider.action("requests"),
    (rows: any[]) => Array.isArray(rows) && rows.some((r) => r.requestHash === requestId),
  );
  const preview = await provider.action("quotePreview", { requestId, models: [MODEL] });
  let approval: any = null;
  if (approve) {
    approval = await provider.action("approve", {
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
  }
  return { provider, consumer, proxy, target, control, counts, frames, requestId, approval, preview };
}

async function pollUntilConnected(j: Journey, controlPort = j.provider.info.controlPort): Promise<any> {
  let providers: any = { service: [] };
  for (let i = 0; i < 10; i++) {
    try {
      await j.consumer.action("poll", { controlPort });
    } catch {
      /* the next bounded poll retries; a dropped response is intentional in one test */
    }
    providers = await j.consumer.action("providers");
    if (providers.service?.some((p: any) => p.status === "connected")) return providers;
    await Bun.sleep(1200);
  }
  throw new Error(`consumer Remote did not connect; providers=${JSON.stringify(providers)}`);
}

describe("real HTTP two-Service journey", () => {
  test("request -> approve -> consumer pull -> native Remote readback -> ACK", async () => {
    const j = await setupJourney();
    expect(j.consumer.info.sharingEnabled).toBe(false);
    expect(j.consumer.info.mappedCidr).toBeNull();

    await pollUntilConnected(j);
    try { await j.consumer.action("poll"); } catch { /* already acked */ }
    const acked = await until(
      () => j.provider.action("approvals"),
      (rows: any[]) => Array.isArray(rows) && rows.some((a) => a.approvalId === j.approval.approvalId && a.ackState === "acked"),
    );
    expect(acked.some((a) => a.approvalId === j.approval.approvalId && a.ackState === "acked")).toBe(true);
    expect(await j.provider.action("keys")).toHaveLength(1);
    expect(j.counts.get("/p2p/v1/hello") ?? 0).toBeGreaterThan(0);
    expect(j.counts.get("/p2p/v1/frame") ?? 0).toBeGreaterThan(0);
    expect(j.counts.get("/p2p/v1/poll") ?? 0).toBeGreaterThan(0);

    // Exact captured frame replay: no second request.
    const first = j.frames[0];
    const replay = await fetch(`http://127.0.0.1:${j.provider.info.controlPort}${first.path}`, {
      method: "POST",
      headers: { host: `127.0.0.1:${j.provider.info.controlPort}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(first.body),
    });
    expect([200, 204, 409]).toContain(replay.status);
    expect((await j.provider.action("requests")).filter((r: any) => r.requestHash === j.requestId)).toHaveLength(1);

    // Duplicate approval: no second key.
    try {
      await j.provider.action("approve", {
        requestId: j.requestId,
        consumerFingerprint: j.consumer.info.fingerprint,
        quoteHash: j.provider.info.quoteHash,
        priceVersion: j.preview.priceVersion,
        generation: null,
        models: [MODEL],
        capUsd: CAP,
        acceptFingerprint: j.consumer.info.fingerprint,
      });
    } catch {
      /* idempotent/conflict; both acceptable */
    }
    expect(await j.provider.action("keys")).toHaveLength(1);
  }, 30_000);

  test("a lost poll response is recovered by the next authenticated poll without a second key", async () => {
    const j = await setupJourney();
    j.control.dropNextPoll = true;
    await pollUntilConnected(j);
    expect(j.control.dropped).toBeGreaterThanOrEqual(1);
    expect(await j.provider.action("keys")).toHaveLength(1);
    const acked = await until(
      () => j.provider.action("approvals"),
      (rows: any[]) => Array.isArray(rows) && rows.some((a) => a.approvalId === j.approval.approvalId && a.ackState === "acked"),
    );
    expect(acked.some((a) => a.ackState === "acked")).toBe(true);
  }, 30_000);

  test("revocation removes the native key and the consumer Remote; a restart keeps the state", async () => {
    const j = await setupJourney();
    await pollUntilConnected(j);

    // Restart the provider over the same state dir; the consumer follows the new
    // control port through its explicit test registration (same proxy).
    const oldProvider = j.provider;
    await oldProvider.stop();
    const provider = await spawnNode("provider", { NODE_ID: "aa11bb22" }, oldProvider.dir);
    nodes.push(provider);
    j.provider = provider;
    j.target.port = provider.info.controlPort;
    await j.consumer.action("registerPeer", {
      nodeId: provider.info.nodeId,
      fingerprint: provider.info.fingerprint,
      quoteHash: provider.info.quoteHash,
      host: "127.0.0.1",
      port: j.proxy.port,
      hostHeader: `127.0.0.1:${provider.info.controlPort}`,
      controlPort: provider.info.controlPort,
    });
    await j.consumer.action("poll", { controlPort: provider.info.controlPort });
    expect(await provider.action("keys")).toHaveLength(1);
    expect((await j.consumer.action("providers")).service.some((p: any) => p.status === "connected")).toBe(true);

    await provider.action("revoke", { approvalId: j.approval.approvalId });
    let providers: any = { service: [] };
    for (let i = 0; i < 6; i++) {
      try {
        await j.consumer.action("poll", { controlPort: provider.info.controlPort });
      } catch {
        /* bounded retry */
      }
      providers = await j.consumer.action("providers");
      if (providers.service.length === 0) break;
      await Bun.sleep(1200);
    }
    expect(providers.service).toHaveLength(0);
    expect(await provider.action("keys")).toHaveLength(0);
    expect((await provider.action("approvals"))[0]?.state).toBe("revoked");
  }, 40_000);

  test("stale quote and wrong identity fail closed before any key", async () => {
    const j = await setupJourney(false);
    await j.provider.action("mutateQuote", { quoteHash: "cd".repeat(32) });
    await expect(
      j.provider.action("approve", {
        requestId: j.requestId,
        consumerFingerprint: j.consumer.info.fingerprint,
        quoteHash: j.provider.info.quoteHash,
        priceVersion: j.preview.priceVersion,
        generation: null,
        models: [MODEL],
        capUsd: CAP,
        acceptFingerprint: j.consumer.info.fingerprint,
      }),
    ).rejects.toThrow();
    expect(await j.provider.action("keys")).toHaveLength(0);

    await expect(
      j.consumer.action("request", {
        nodeId: j.provider.info.nodeId,
        fingerprint: "0".repeat(64),
        quoteHash: j.provider.info.quoteHash,
        models: [MODEL],
      }),
    ).rejects.toThrow();
  }, 30_000);
});
