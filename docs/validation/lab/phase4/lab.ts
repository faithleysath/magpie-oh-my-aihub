#!/usr/bin/env bun
// Phase-4 end-to-end lab: three isolated Magpie instances (A, B, C) on one
// machine, one EasyTier 2.6.4 overlay, the real plugin host and CLI.
//
//   bun docs/validation/lab/phase4/lab.ts [--keep]
//
// It exercises the acceptance criteria that cannot be proven by a unit test:
// A consumes B and C at the same time, A shares its own channel to B and C,
// every hop uses the provider's own Gateway Key, a revoked or exhausted key
// affects exactly one connection, and mutual sharing does not loop.
//
// Results are written to docs/validation/phase4-lab-report.json and printed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const LAB = process.env.PHASE4_LAB_DIR || `/tmp/ohmyaihub-phase4-${process.pid}`;
const KEEP = process.argv.includes("--keep");
const MAGPIE = process.env.MAGPIE_BIN || which("magpie");
const PLUGIN_BIN = join(ROOT, "plugin", "bin", "ohmyaihub.ts");
const HOST_TS = join(ROOT, "docs", "validation", "lab", "phase4", "host.ts");
const MOCK_TS = join(ROOT, "docs", "validation", "lab", "phase4", "mock-upstream.ts");
const NETWORK = "phase4-lab";
const NETWORK_SECRET = `phase4-${randomUUID()}`;

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: Result[] = [];

function which(cmd: string): string {
  const r = Bun.spawnSync(["which", cmd]);
  const p = r.stdout.toString().trim();
  if (!p) throw new Error(`${cmd} is not on PATH`);
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 30_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = String((e as Error).message ?? e);
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last error: ${last})` : ""}`);
}

async function step(name: string, fn: () => Promise<string | void>, opts: { required?: boolean } = {}): Promise<void> {
  const started = Date.now();
  process.stderr.write(`\n=== ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "ok", ms: Date.now() - started });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: String((e as Error).message ?? e), ms: Date.now() - started });
    console.log(`FAIL  ${name} — ${String((e as Error).message ?? e)}`);
    if (opts.required) throw e;
  }
}

interface Proc {
  pid: number;
  kill: () => void;
  log: string;
}

function start(cmd: string[], opts: { cwd: string; env: Record<string, string>; log: string }): Proc {
  mkdirSync(join(opts.log, ".."), { recursive: true });
  writeFileSync(opts.log, "");
  const p = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      try {
        appendFileSync(opts.log, dec.decode(value, { stream: true }));
      } catch {
        /* lab only */
      }
    }
  };
  void drain(p.stdout as ReadableStream<Uint8Array>);
  void drain(p.stderr as ReadableStream<Uint8Array>);
  return {
    pid: p.pid,
    log: opts.log,
    kill: () => {
      try {
        p.kill("SIGTERM");
      } catch {
        /* gone */
      }
      setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, 1500).unref?.();
    },
  };
}

interface HttpResult {
  status: number;
  text: string;
  json: any;
}

async function http(
  url: string,
  opts: { method?: string; key?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE or plain text */
  }
  return { status: res.status, text, json };
}

interface Ports {
  gateway: number;
  ui: number;
  upstream: number;
  listen: number;
}

class Instance {
  readonly home: string;
  readonly data: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly gatewayPort: number;
  readonly uiPort: number;
  readonly upstreamPort: number;
  readonly listenPort: number;
  readonly upstreamName: string;
  readonly model: string;
  /** every instance also serves this model id, so two providers share a name */
  readonly servedModels: string[];
  private gatewayProc: Proc | null = null;
  private hostProc: Proc | null = null;
  private upstreamProc: Proc | null = null;
  labKey = "";

  constructor(
    readonly name: string,
    ports: Ports,
  ) {
    this.home = join(LAB, name, "home");
    this.data = join(this.home, ".config", "magpie");
    this.stateDir = join(this.data, "oh-my-aihub");
    this.logDir = join(LAB, name, "logs");
    this.gatewayPort = ports.gateway;
    this.uiPort = ports.ui;
    this.upstreamPort = ports.upstream;
    this.listenPort = ports.listen;
    this.upstreamName = name.toLowerCase();
    this.model = `${this.upstreamName}-model`;
    this.servedModels = [this.model, "common-model"];
  }

  env(): Record<string, string> {
    return {
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      MAGPIE_ADDR: `${lan()}:${this.gatewayPort}`,
      OH_MY_AIHUB_MAGPIE: MAGPIE,
    };
  }

  async setup(): Promise<void> {
    mkdirSync(this.data, { recursive: true });
    mkdirSync(this.logDir, { recursive: true });
    this.upstreamProc = start(["bun", MOCK_TS], {
      cwd: LAB,
      env: { PORT: String(this.upstreamPort), UPSTREAM_NAME: this.upstreamName, MODELS: this.servedModels.join(",") },
      log: join(this.logDir, "upstream.log"),
    });
    await waitFor(`${this.name} upstream`, async () => (await http(`http://127.0.0.1:${this.upstreamPort}/v1/models`)).status === 200);
    this.magpieReq([
      "provider",
      "add",
      `mock${this.upstreamName}`,
      `url=http://127.0.0.1:${this.upstreamPort}/v1`,
      `responses=http://127.0.0.1:${this.upstreamPort}/v1`,
      `anthropic=http://127.0.0.1:${this.upstreamPort}`,
      `key=sk-test-upstream-${this.name.toLowerCase()}`,
      `models=${this.servedModels.join(",")}`,
      `name=mock${this.upstreamName}`,
    ]);
    for (const m of this.servedModels) this.magpieReq(["model", "price", `mock${this.upstreamName}/${m}`, "1000,1000,0,0"]);
    await this.startGateway();
    // A lab key: agents reach the gateway over its LAN address, so every HTTP
    // call (including this lab's) needs one. It is not part of the plugin.
    this.magpieReq(["gateway-key", "add", "laball"]);
    const keys = JSON.parse(readFileSync(join(this.data, "caller-keys.json"), "utf8")) as { name: string; secret: string; id: string }[];
    const k = keys.find((x) => x.name === "laball")!;
    this.magpieReq(["gateway-key", "models", k.id, "all"]);
    this.labKey = k.secret;
  }

  async startGateway(): Promise<void> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.gatewayProc = start([MAGPIE, "web", "--gateway", "--addr", `127.0.0.1:${this.uiPort}`, "--no-open"], {
        cwd: this.data,
        env: this.env(),
        log: join(this.logDir, "gateway.log"),
      });
      try {
        await waitFor(
          `${this.name} gateway 401`,
          async () => ((await http(`http://${lan()}:${this.gatewayPort}/v1/models`, { timeoutMs: 2000 })).status === 401 ? true : null),
          15_000,
        );
        return;
      } catch (e) {
        last = e;
        this.gatewayProc.kill();
        await sleep(1500);
      }
    }
    throw new Error(`magpie gateway for ${this.name} did not start: ${String((last as Error)?.message ?? last)}`);
  }

  stopGateway(): void {
    this.gatewayProc?.kill();
    this.gatewayProc = null;
  }

  async startHost(): Promise<void> {
    this.hostProc = start(["bun", HOST_TS], { cwd: this.data, env: this.env(), log: join(this.logDir, "host.log") });
    await waitFor(
      `${this.name} plugin API`,
      async () => {
        if (!existsSync(join(this.stateDir, "api-port"))) return null;
        const r = await http(`http://127.0.0.1:${readFileSync(join(this.stateDir, "api-port"), "utf8").trim()}/health`, { timeoutMs: 1000 });
        return r.status === 200 ? true : null;
      },
      30_000,
    );
  }

  stopHost(): void {
    this.hostProc?.kill();
    this.hostProc = null;
  }

  stopAll(): void {
    this.stopHost();
    this.stopGateway();
    this.upstreamProc?.kill();
    this.upstreamProc = null;
  }

  magpieReq(args: string[]): string {
    const r = Bun.spawnSync([MAGPIE, ...args], {
      cwd: this.data,
      env: { ...process.env, ...this.env() },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(`magpie ${args[0]} ${args[1] ?? ""} failed: ${(r.stderr.toString() || r.stdout.toString()).trim().slice(0, 400)}`);
    }
    return r.stdout.toString();
  }

  /** The operator CLI from the repo, pointed at this instance's data dir. */
  async cli(args: string[]): Promise<any> {
    const r = Bun.spawnSync(["bun", PLUGIN_BIN, "--data", this.data, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...this.env() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString();
    if (r.exitCode !== 0) {
      throw new Error(`plugin ${args.join(" ")} failed: ${(r.stderr.toString() || out).trim().slice(0, 600)}`);
    }
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  }

  async cliMayFail(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    const r = Bun.spawnSync(["bun", PLUGIN_BIN, "--data", this.data, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...this.env() },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  async status(): Promise<any> {
    return this.cli(["status"]);
  }

  async models(): Promise<string[]> {
    const out = this.magpieReq(["models"]);
    return out
      .split("\n")
      .map((l) => l.trim().split(/\s{2,}/)[0])
      .filter((t) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._*,/-]+$/.test(t));
  }

  async gatewayModelIds(): Promise<string[]> {
    const r = await http(`http://${lan()}:${this.gatewayPort}/v1/models`, { key: this.labKey });
    return (r.json?.data ?? []).map((m: { id: string }) => m.id);
  }

  upstreamCount(): number {
    const r = Bun.spawnSync(["curl", "-s", `http://127.0.0.1:${this.upstreamPort}/count`]);
    return Number(JSON.parse(r.stdout.toString() || "{}").requests ?? 0);
  }

  async resetUpstream(): Promise<void> {
    await http(`http://127.0.0.1:${this.upstreamPort}/reset`);
  }

  easytierCli(args: string[]): string {
    const dir = join(this.stateDir, "easytier", "v2.6.4", `${process.platform}-${process.arch}`);
    const bin = join(dir, "easytier-cli");
    const status = JSON.parse(readFileSync(join(this.stateDir, "easytier-state.json"), "utf8"));
    const port = status?.process?.rpcPort ?? status?.config?.rpcPort;
    const r = Bun.spawnSync([bin, "-p", `127.0.0.1:${port}`, ...args], { stdout: "pipe", stderr: "pipe" });
    return (r.stdout.toString() + r.stderr.toString()).trim();
  }
}

function lan(): string {
  const r = Bun.spawnSync(["ipconfig", "getifaddr", "en0"]);
  const a = r.stdout.toString().trim();
  if (a) return a;
  const r2 = Bun.spawnSync(["ipconfig", "getifaddr", "en1"]);
  const b = r2.stdout.toString().trim();
  if (b) return b;
  // Linux
  const r3 = Bun.spawnSync(["hostname", "-I"]);
  const c = r3.stdout.toString().trim().split(/\s+/)[0];
  if (c && !c.startsWith("127.")) return c;
  throw new Error("no LAN address");
}

/** A port nothing listens on, checked on loopback and on the LAN address. */
async function portFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", lan()]) {
    try {
      const s = await Bun.connect({ hostname: host, port, socket: { data() {}, open() {}, close() {} } });
      s.end();
      return false;
    } catch {
      /* nothing there */
    }
  }
  return true;
}

/** Four free ports for one node: gateway, web page, mock upstream, overlay listener. */
async function freePorts(): Promise<Ports> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    const ports = [base, base + 1, base + 2, base + 3];
    if (ports[3] > 65535) continue;
    const free = await Promise.all(ports.map(portFree));
    if (free.every(Boolean)) return { gateway: ports[0], ui: ports[1], upstream: ports[2], listen: ports[3] };
  }
  throw new Error("no four free ports for the lab");
}

async function keysOf(inst: Instance): Promise<Record<string, string>> {
  const raw = JSON.parse(readFileSync(join(inst.data, "caller-keys.json"), "utf8")) as { name: string; secret: string }[];
  const out: Record<string, string> = {};
  for (const k of raw) out[k.name] = k.secret;
  return out;
}

async function waitConnected(inst: Instance, ids: string[], timeoutMs = 45_000): Promise<void> {
  await waitFor(
    `${inst.name} providers ${ids.join(",")} connected`,
    async () => {
      const s = await inst.status();
      const map = new Map<string, string>((s.providers ?? []).map((p: any) => [p.id, p.status]));
      return ids.every((id) => map.get(id) === "connected") ? true : null;
    },
    timeoutMs,
  );
}

function check(label: string, ok: boolean, detail = ""): string {
  if (!ok) throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  return detail || label;
}

// ---------------------------------------------------------------------------

if (!existsSync(MAGPIE)) throw new Error(`magpie not found at ${MAGPIE}`);
rmSync(LAB, { recursive: true, force: true });
mkdirSync(LAB, { recursive: true });
const a = new Instance("A", await freePorts());
const b = new Instance("B", await freePorts());
const c = new Instance("C", await freePorts());
let d: Instance | null = null;
let e: Instance | null = null;

/** The verified EasyTier tree cached by the first step. */
function easyTierCache(): string {
  return `/tmp/ohmyaihub-et-cache-v2.6.4-${process.platform}-${process.arch}`;
}

function installEasytier(inst: Instance): void {
  mkdirSync(inst.stateDir, { recursive: true });
  const to = join(inst.stateDir, "easytier");
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  Bun.spawnSync(["cp", "-R", easyTierCache(), to]);
}

try {
  await step("three isolated Magpie gateways start and enforce keys", async () => {
    for (const inst of [a, b, c]) await inst.setup();
    const noKey = await http(`http://${lan()}:${a.gatewayPort}/v1/models`);
    const withKey = await http(`http://${lan()}:${a.gatewayPort}/v1/models`, { key: a.labKey });
    return check(`A: ${noKey.status} without a key, ${withKey.status} with one`, noKey.status === 401 && withKey.status === 200);
  }, { required: true });

  await step("the pinned EasyTier is verified once and reused by the other nodes", async () => {
    const cache = easyTierCache();
    const install = (inst: Instance) => installEasytier(inst);

    if (existsSync(cache)) {
      for (const inst of [a, b, c]) install(inst);
      return `reused the verified 2.6.4 cache at ${cache}`;
    }

    let last: string | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const fetch = Bun.spawnSync(
        ["bun", "-e", `import { ensureBinaries } from "${join(ROOT, "plugin", "src", "easytier.ts")}"; await ensureBinaries(() => {});`],
        { cwd: a.data, env: { ...process.env, ...a.env() }, stdout: "pipe", stderr: "pipe" },
      );
      if (fetch.exitCode === 0) {
        const from = join(a.stateDir, "easytier");
        Bun.spawnSync(["cp", "-R", from, cache]);
        install(b);
        install(c);
        const dir = readdirSync(join(from, "v2.6.4"))[0];
        return `verified 2.6.4 binaries in ${dir}, cached and copied to B and C`;
      }
      last = fetch.stderr.toString().slice(0, 300);
      await sleep(2000 * attempt);
    }
    throw new Error(`could not fetch the pinned EasyTier after 4 attempts: ${last}`);
  }, { required: true });

  await step("the three plugin hosts boot and the overlay finds every peer", async () => {
    for (const inst of [a, b, c]) await inst.startHost();
    const peers = [a, b, c];
    for (const inst of peers) {
      await inst.cli([
        "configure",
        "--network",
        NETWORK,
        "--secret",
        NETWORK_SECRET,
        "--share",
        "--consume",
        "--listen",
        `127.0.0.1:${inst.listenPort}`,
        "--virtual-ip",
        `10.77.0.${11 + peers.indexOf(inst)}/24`,
        "--ports",
        String(inst.gatewayPort),
        "--share-models",
        "*",
        ...peers.filter((p) => p !== inst).flatMap((p) => ["--peer", `tcp://127.0.0.1:${p.listenPort}`]),
      ]);
    }
    for (const inst of peers) {
      await waitFor(
        `${inst.name} sees 3 overlay nodes`,
        async () => {
          const s = await inst.status();
          const n = (s.easytier?.peers ?? []).length;
          return n >= 3 ? true : null;
        },
        60_000,
      );
    }
    const s = await a.status();
    return `A sees ${s.easytier.peers.length} nodes, exports ${s.easytier.export}`;
  }, { required: true });

  await step("A opens independent Gateway Keys for B and C, and shares its own model", async () => {
    const bView = await b.cli(["consumers", "add", "a-node", `mock${b.upstreamName}/${b.model},mock${b.upstreamName}/common-model`, "1"]);
    const cView = await c.cli(["consumers", "add", "a-node", `mock${c.upstreamName}/${c.model},mock${c.upstreamName}/common-model`, "1"]);
    await a.cli(["consumers", "add", "b-node", `mock${a.upstreamName}/${a.model}`, "0.03"]);
    await a.cli(["consumers", "add", "c-node", `mock${a.upstreamName}/${a.model}`, "0.30"]);
    const keys = await keysOf(a);
    const bKey = await b.cli(["secret", "a-node"]);
    const cKey = await c.cli(["secret", "a-node"]);
    return check(
      `B key ${bKey.slice(0, 8)}…, C key ${cKey.slice(0, 8)}… (different: ${bKey !== cKey}); A issued b-node and c-node`,
      bKey !== cKey && Boolean(keys["ohmyaihub-b-node"]) && Boolean(keys["ohmyaihub-c-node"]) && bView.keyId !== cView.keyId,
    );
  }, { required: true });

  await step("A connects to B and to C at the same time (distinct ports, distinct keys)", async () => {
    const sa = await a.status();
    const sb = await b.status();
    const sc = await c.status();
    const keys = await keysOf(a);
    const bKey = await b.cli(["secret", "a-node"]);
    const cKey = await c.cli(["secret", "a-node"]);
    const aKeyForB = keys["ohmyaihub-b-node"];
    const aKeyForC = keys["ohmyaihub-c-node"];
    if (!aKeyForB || !aKeyForC) throw new Error("A did not issue both keys");

    await a.cli(["provider", "add", "peer-b", "--cidr", sb.node.mappedCidr, "--key", bKey, "--port", String(b.gatewayPort)]);
    await a.cli(["provider", "add", "peer-c", "--cidr", sc.node.mappedCidr, "--key", cKey, "--port", String(c.gatewayPort)]);
    await b.cli(["provider", "add", "peer-a", "--cidr", sa.node.mappedCidr, "--key", aKeyForB, "--port", String(a.gatewayPort)]);
    await c.cli(["provider", "add", "peer-a", "--cidr", sa.node.mappedCidr, "--key", aKeyForC, "--port", String(a.gatewayPort)]);
    await waitConnected(a, ["peer-b", "peer-c"]);
    await waitConnected(b, ["peer-a"]);
    await waitConnected(c, ["peer-a"]);
    const st = await a.status();
    const ports = st.providers.map((p: any) => p.localPort);
    return check(`A: ${ports.join(", ")} (unique: ${new Set(ports).size === 2}); keys differ`, new Set(ports).size === 2 && bKey !== cKey);
  }, { required: true });

  await step("each node lists the models it consumes, prefixed by the remote id", async () => {
    await waitFor("A lists peer-b and peer-c models", async () => {
      const ms = await a.models();
      return ms.some((m) => m.startsWith("peer-b/mock")) && ms.some((m) => m.startsWith("peer-c/mock")) ? true : null;
    }, 30_000);
    await waitFor("B lists peer-a models", async () => {
      const ms = await b.models();
      return ms.some((m) => m.startsWith("peer-a/mock")) ? true : null;
    });
    const am = await a.models();
    const bm = await b.models();
    const cm = await c.models();
    return `A: ${am.join(", ")} · B: ${bm.join(", ")} · C: ${cm.join(", ")}`;
  });

  await step("two providers serving the same model name stay distinct", async () => {
    const models = await a.models();
    const bId = `peer-b/mock${b.upstreamName}/common-model`;
    const cId = `peer-c/mock${c.upstreamName}/common-model`;
    check(`both ids listed: ${models.filter((m) => m.endsWith("common-model")).join(", ")}`, models.includes(bId) && models.includes(cId));
    await b.resetUpstream();
    await c.resetUpstream();
    const rb = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: bId, messages: [{ role: "user", content: "same name" }] },
    });
    const rc = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: cId, messages: [{ role: "user", content: "same name" }] },
    });
    check(
      `peer-b answered ${rb.status} with B, peer-c answered ${rc.status} with C`,
      rb.status === 200 && rc.status === 200 && rb.text.includes("hello from b") && rc.text.includes("hello from c") && b.upstreamCount() === 1 && c.upstreamCount() === 1,
      `${rb.text.slice(0, 120)} | ${rc.text.slice(0, 120)}`,
    );
    return "the same upstream model id is addressable as peer-b/... and peer-c/... with no overwrite";
  });

  await step("one request crosses exactly one overlay hop (no routing loop)", async () => {
    await b.resetUpstream();
    await a.resetUpstream();
    const req = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-b/mock${b.upstreamName}/${b.model}`, messages: [{ role: "user", content: "hi" }] },
    });
    check(`A->B model answered ${req.status}`, req.status === 200, req.text.slice(0, 200));
    const bCount = b.upstreamCount();
    const aCount = a.upstreamCount();
    return check(`B upstream hit ${bCount}x, A upstream hit ${aCount}x (expected 1 / 0)`, bCount === 1 && aCount === 0);
  });

  await step("streaming, Responses and Messages API pass through the keyed chain", async () => {
    const model = `peer-b/mock${b.upstreamName}/${b.model}`;
    const stream = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model, messages: [{ role: "user", content: "hi" }], stream: true },
      timeoutMs: 20_000,
    });
    check(`stream status ${stream.status}`, stream.status === 200 && stream.text.includes("data:") && stream.text.includes("[DONE]"), stream.text.slice(0, 160));
    const responses = await http(`http://${lan()}:${a.gatewayPort}/v1/responses`, {
      key: a.labKey,
      body: { model, input: "hi" },
    });
    check(`responses status ${responses.status}`, responses.status === 200 && /responses from|hello from/.test(responses.text), responses.text.slice(0, 200));
    const messages = await http(`http://${lan()}:${a.gatewayPort}/v1/messages`, {
      key: a.labKey,
      body: { model, max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    });
    check(`messages status ${messages.status}`, messages.status === 200 && /messages from|hello from/.test(messages.text), messages.text.slice(0, 200));
    return "SSE chunks + [DONE], /v1/responses and /v1/messages answered through peer-b";
  });

  await step("remote models join a native Magpie routing group and are used through it", async () => {
    a.magpieReq(["group", "add", "labmix", `models=peer-b/mock${b.upstreamName}/${b.model},peer-c/mock${c.upstreamName}/${c.model}`, "routing=order"]);
    const models = await a.models();
    check("group/labmix is listed", models.includes("group/labmix"), models.join(", "));
    const r = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: "group/labmix", messages: [{ role: "user", content: "hi" }] },
    });
    check(`group request ${r.status}`, r.status === 200 && (r.text.includes("hello from b") || r.text.includes("hello from c")), r.text.slice(0, 200));
    return "group/labmix served by a remote model through Magpie's own routing";
  });

  await step("exhausting B's key on A leaves C's key and both nodes' own models working", async () => {
    const model = `peer-a/mock${a.upstreamName}/${a.model}`;
    let statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await http(`http://${lan()}:${b.gatewayPort}/v1/chat/completions`, {
        key: b.labKey,
        body: { model, messages: [{ role: "user", content: "spend" }] },
      });
      statuses.push(r.status);
      if (r.status !== 200) break;
    }
    const blocked = statuses[statuses.length - 1] !== 200;
    const cStill = await http(`http://${lan()}:${c.gatewayPort}/v1/chat/completions`, {
      key: c.labKey,
      body: { model, messages: [{ role: "user", content: "still" }] },
    });
    const bOwn = await http(`http://${lan()}:${b.gatewayPort}/v1/chat/completions`, {
      key: b.labKey,
      body: { model: `mock${b.upstreamName}/${b.model}`, messages: [{ role: "user", content: "own" }] },
    });
    check(`B blocked (${statuses.join(",")}), C ${cStill.status}, B's own ${bOwn.status}`, blocked && cStill.status === 200 && bOwn.status === 200);
    return `B's key refused after ${statuses.filter((s) => s === 200).length} calls (last ${statuses[statuses.length - 1]}); C 200; B's native model 200`;
  });

  await step("a simulated top-up raises only B's key and B can call A again", async () => {
    await a.cli(["topup", "b-node", "1", "--deposit-id", "lab-deposit-1"]);
    const r = await http(`http://${lan()}:${b.gatewayPort}/v1/chat/completions`, {
      key: b.labKey,
      body: { model: `peer-a/mock${a.upstreamName}/${a.model}`, messages: [{ role: "user", content: "after topup" }] },
    });
    check(`B after top-up ${r.status}`, r.status === 200, r.text.slice(0, 200));
    const replay = await a.cli(["topup", "b-node", "1", "--deposit-id", "lab-deposit-1"]);
    const view = await a.cli(["consumers"]);
    const bView = view.find((x: any) => x.consumerId === "b-node");
    return check(`deposit replayed without a second credit (cap ${bView.capUsd})`, replay.capUsd === bView.capUsd && bView.creditedUsd === 1);
  });

  await step("revoking one provider's key leaves the other provider untouched, then re-issuing restores it", async () => {
    await a.cli(["revoke", "c-node"]);
    const cBroken = await http(`http://${lan()}:${c.gatewayPort}/v1/chat/completions`, {
      key: c.labKey,
      body: { model: `peer-a/mock${a.upstreamName}/${a.model}`, messages: [{ role: "user", content: "after revoke" }] },
    });
    const bOk = await http(`http://${lan()}:${b.gatewayPort}/v1/chat/completions`, {
      key: b.labKey,
      body: { model: `peer-a/mock${a.upstreamName}/${a.model}`, messages: [{ role: "user", content: "unaffected" }] },
    });
    check(`C refused ${cBroken.status}, B still ${bOk.status}`, cBroken.status !== 200 && bOk.status === 200);

    await a.cli(["consumers", "add", "c-node2", `mock${a.upstreamName}/${a.model}`, "0.30"]);
    const newKey = await a.cli(["secret", "c-node2"]);
    await c.cli(["provider", "update", "peer-a", "--key", newKey]);
    const cBack = await http(`http://${lan()}:${c.gatewayPort}/v1/chat/completions`, {
      key: c.labKey,
      body: { model: `peer-a/mock${a.upstreamName}/${a.model}`, messages: [{ role: "user", content: "back" }] },
    });
    check(`C after update ${cBack.status}`, cBack.status === 200, cBack.text.slice(0, 200));
    return `C was refused (${cBroken.status}) while B stayed 200; a re-issued key + provider update restored C (${cBack.status})`;
  });

  await step("sharing refuses to resell a remote Magpie's models (no A->B->A)", async () => {
    const refused = await a.cliMayFail(["consumers", "add", "reseller", `peer-b/mock${b.upstreamName}/${b.model}`, "1"]);
    check(
      `A refused a whitelist naming peer-b (${(refused.err || refused.out).split("\n").slice(-2).join(" ").slice(0, 200)})`,
      !refused.ok && /remote Magpie/i.test(refused.err + refused.out),
    );
    const alsoRefused = await b.cliMayFail(["consumers", "add", "reseller", `peer-a/mock${a.upstreamName}/${a.model}`, "1"]);
    check("B refused a whitelist naming peer-a", !alsoRefused.ok && /remote Magpie/i.test(alsoRefused.err + alsoRefused.out));
    const am = await a.models();
    const bm = await b.models();
    return `mutual sharing lists A: ${am.filter((m) => m.startsWith("peer-")).join(",")} / B: ${bm.filter((m) => m.startsWith("peer-")).join(",")} but no shared key may name them`;
  });

  await step("a provider that goes offline degrades alone; the other keeps serving", async () => {
    b.stopGateway();
    await waitFor(
      "A marks peer-b degraded",
      async () => {
        const s = await a.status();
        return s.providers.find((p: any) => p.id === "peer-b")?.status === "degraded" ? true : null;
      },
      60_000,
    );
    const cReq = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-c/mock${c.upstreamName}/${c.model}`, messages: [{ role: "user", content: "c alive" }] },
    });
    check(`A->C still ${cReq.status} while peer-b is down`, cReq.status === 200, cReq.text.slice(0, 200));
    await b.startGateway();
    await waitConnected(a, ["peer-b"], 90_000);
    return "peer-b degraded while peer-c answered; peer-b recovered after its Magpie came back";
  });

  await step("retargeting a provider moves to a fresh port, verifies it, and drops the old listener", async () => {
    e = new Instance("E", await freePorts());
    await e.setup();
    installEasytier(e);
    await e.startHost();
    await e.cli([
      "configure",
      "--network", NETWORK,
      "--secret", NETWORK_SECRET,
      "--share",
      "--listen", `127.0.0.1:${e.listenPort}`,
      "--virtual-ip", "10.77.0.15/24",
      "--share-models", "*",
      ...[a, b, c].flatMap((p) => ["--peer", `tcp://127.0.0.1:${p.listenPort}`]),
    ]);
    await waitFor("E joins the overlay", async () => {
      const s = await e!.status();
      return (s.easytier?.peers ?? []).length >= 3 ? true : null;
    }, 60_000);
    await e.cli(["consumers", "add", "a-node", `mock${e.upstreamName}/${e.model},mock${e.upstreamName}/common-model`, "1"]);
    const eKey = await e.cli(["secret", "a-node"]);
    const se = await e.status();
    const eMapped = se.node.mappedCidr.replace(/\/32$/, "");
    await waitFor("A has a route to E's mapped prefix", async () => {
      const table = a.easytierCli(["route"]);
      return table.includes(eMapped) ? true : null;
    }, 60_000);

    const before = await a.status();
    const old = before.providers.find((p: any) => p.id === "peer-b")!;
    const sb = await b.status();
    const bKey = await b.cli(["secret", "a-node"]);

    let moved: any;
    try {
      moved = await a.cli(["provider", "update", "peer-b", "--cidr", se.node.mappedCidr, "--key", eKey, "--port", String(e.gatewayPort)]);
    } catch (err) {
      const sa = await a.status().catch(() => null);
      const pa = a.magpieReq(["providers"]);
      const seAgain = await e.status().catch(() => null);
      throw new Error(
        `retarget failed: ${String((err as Error).message)} | A providers: ${pa.replace(/\n/g, " ")} | ` +
          `A connections: ${JSON.stringify((sa as any)?.providers)} | E: ${JSON.stringify({ sharing: (seAgain as any)?.sharing, export: (seAgain as any)?.easytier?.export, ports: (seAgain as any)?.node?.publishedPorts })}`,
      );
    }
    if (moved.localPort === old.localPort) throw new Error("the retarget reused the old loopback port");
    await waitConnected(a, ["peer-b"], 60_000);
    await waitFor("peer-b lists E's model", async () => {
      const ms = await a.models();
      return ms.some((m) => m === `peer-b/mock${e!.upstreamName}/${e!.model}`) ? true : null;
    }, 30_000);
    const viaNew = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-b/mock${e.upstreamName}/${e.model}`, messages: [{ role: "user", content: "after retarget" }] },
    });
    if (viaNew.status !== 200 || !viaNew.text.includes("hello from e")) throw new Error(`retargeted peer-b did not reach E: ${viaNew.status} ${viaNew.text.slice(0, 160)}`);

    const cCheck = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-c/mock${c.upstreamName}/${c.model}`, messages: [{ role: "user", content: "unaffected" }] },
    });
    if (cCheck.status !== 200) throw new Error(`peer-c broke during the retarget: ${cCheck.status} ${cCheck.text.slice(0, 160)}`);

    const back = await a.cli(["provider", "update", "peer-b", "--cidr", sb.node.mappedCidr, "--key", bKey, "--port", String(b.gatewayPort)]);
    if (back.localPort === moved.localPort) throw new Error("the way back reused the moved port");
    await waitConnected(a, ["peer-b"], 60_000);
    await waitFor("peer-b lists B's model again", async () => {
      const ms = await a.models();
      return ms.some((m) => m === `peer-b/mock${b.upstreamName}/${b.model}`) ? true : null;
    }, 30_000);
    const viaOld = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-b/mock${b.upstreamName}/${b.model}`, messages: [{ role: "user", content: "back home" }] },
    });
    if (viaOld.status !== 200 || !viaOld.text.includes("hello from b")) throw new Error(`peer-b did not return to B: ${viaOld.status} ${viaOld.text.slice(0, 160)}`);

    const checks = await a.cliMayFail(["checks"]);
    if (!checks.ok) throw new Error(`A's checks failed after the retarget: ${checks.out}${checks.err}`);
    const forwards = a.easytierCli(["port-forward", "list"]);
    const listeners = forwards.match(/127\.0\.0\.1:\d+/g) ?? [];
    if (new Set(listeners).size !== 2) throw new Error(`expected exactly two provider listeners, saw: ${listeners.join(", ")}`);
    e.stopAll();
    e = null;
    return `peer-b ${old.localPort} -> ${moved.localPort} -> ${back.localPort}; peer-c stayed up; ${new Set(listeners).size} listeners remain`;
  });

  await step("deleting one provider leaves the other's connection intact", async () => {
    const before = (await a.status()).providers.map((p: any) => p.id);
    await a.cli(["provider", "rm", "peer-c"]);
    const after = (await a.status()).providers.map((p: any) => p.id);
    const bReq = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-b/mock${b.upstreamName}/${b.model}`, messages: [{ role: "user", content: "still here" }] },
    });
    check(`before ${before.join(",")} after ${after.join(",")}; A->B ${bReq.status}`, after.join(",") === "peer-b" && bReq.status === 200, bReq.text.slice(0, 200));
    return "peer-c removed, peer-b still connected and answering";
  });

  await step("the same provider added twice is idempotent", async () => {
    const sb = await b.status();
    const bKey = await b.cli(["secret", "a-node"]);
    await a.cli(["provider", "add", "peer-b", "--cidr", sb.node.mappedCidr, "--key", bKey, "--port", String(b.gatewayPort)]);
    const s = await a.status();
    const bEntries = s.providers.filter((p: any) => p.id === "peer-b");
    return check(`one peer-b entry, ${s.providers.length} provider(s), status ${bEntries[0].status}`, bEntries.length === 1 && s.providers.length === 1 && bEntries[0].status === "connected");
  });

  await step("an EasyTier restart restores every forward from the generated config", async () => {
    await a.cli(["stop"]);
    const stopped = (await a.status()).easytier.running;
    await a.cli(["start"]);
    await waitConnected(a, ["peer-b"], 60_000);
    const req = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-b/mock${b.upstreamName}/${b.model}`, messages: [{ role: "user", content: "after restart" }] },
    });
    return check(`core was stopped (${stopped}), then A->B answered ${req.status}`, stopped === false && req.status === 200, req.text.slice(0, 200));
  });

  await step("a full Magpie + plugin restart restores the connection set", async () => {
    const mapped = (await a.status()).node.mappedCidr;
    a.stopHost();
    a.stopGateway();
    await sleep(1500);
    await a.startGateway();
    await a.startHost();
    await waitConnected(a, ["peer-b"], 90_000);
    const s = await a.status();
    const req = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-b/mock${b.upstreamName}/${b.model}`, messages: [{ role: "user", content: "after full restart" }] },
    });
    return check(
      `A restarted; mapped ${s.node.mappedCidr} (unchanged ${s.node.mappedCidr === mapped}), peer-b ${s.providers[0].status}, request ${req.status}`,
      s.node.mappedCidr === mapped && s.providers[0].status === "connected" && req.status === 200,
      req.text.slice(0, 200),
    );
  });

  await step("a provider's own Magpie + plugin restart is recovered by the consumer", async () => {
    b.stopHost();
    b.stopGateway();
    await sleep(1500);
    await b.startGateway();
    await b.startHost();
    await waitConnected(a, ["peer-b"], 120_000);
    const req = await http(`http://${lan()}:${a.gatewayPort}/v1/chat/completions`, {
      key: a.labKey,
      body: { model: `peer-b/mock${b.upstreamName}/${b.model}`, messages: [{ role: "user", content: "after provider restart" }] },
    });
    return check(`peer-b restarted; A->B answered ${req.status}`, req.status === 200, req.text.slice(0, 160));
  });

  await step("the overlay's virtual-IP path is dropped by the Inbound ACL (no loopback bypass)", async () => {
    // Dial the provider's *virtual* IP through the same core. In no-TUN that is
    // the path EasyTier rewrites to 127.0.0.1 at the provider, where Magpie would
    // treat the caller as local; the Inbound chain must drop it.
    a.easytierCli(["port-forward", "add", "tcp", "127.0.0.1:13999", `10.77.0.12:${b.gatewayPort}`]);
    await sleep(1000);
    const direct = await http(`http://127.0.0.1:13999/v1/models`, { timeoutMs: 6000 }).catch((e) => ({ status: -1, text: String(e), json: null }));
    const mappedOk = await http(`http://${lan()}:${b.gatewayPort}/v1/models`, { timeoutMs: 6000 }).catch(() => ({ status: -1, text: "", json: null }));
    return check(
      `virtual IP answered ${direct.status} (must not be 200/401), mapped address answered ${mappedOk.status}`,
      direct.status !== 200 && direct.status !== 401 && mappedOk.status === 401,
      direct.text.slice(0, 120),
    );
  });

  await step("sharing off withdraws the export but keeps every local provider and model", async () => {
    const before = await a.models();
    await a.cli(["share", "off"]);
    const s = await a.status();
    const after = await a.models();
    const native = after.filter((m) => m.startsWith(`mock${a.upstreamName}/`));
    check(
      `sharing=${s.sharing}, export=${s.easytier.export}, native models ${native.join(",")}`,
      s.sharing === false && !s.easytier.export && native.length === before.filter((m) => m.startsWith(`mock${a.upstreamName}/`)).length,
    );
    await a.cli(["share", "on"]);
    await waitConnected(a, ["peer-b"], 60_000);
    return `export withdrawn while ${native.length} native model(s) stayed; sharing came back with the same mapped address`;
  });

  await step("a phase-3 state.json migrates on boot, keeps its wiring and moves the key out", async () => {
    d = new Instance("D", await freePorts());
    await d.setup();
    await a.cli(["consumers", "add", "d-node", `mock${a.upstreamName}/${a.model}`, "1"]);
    const keyForD = await a.cli(["secret", "d-node"]);
    const sa = await a.status();
    const legacy = {
      config: {
        role: "consumer",
        networkName: NETWORK,
        networkSecret: NETWORK_SECRET,
        peers: [a, b, c].map((p) => `tcp://127.0.0.1:${p.listenPort}`),
        listenAddr: `tcp://127.0.0.1:${d.listenPort}`,
        virtualIpv4: "10.77.0.14/24",
        overlayCidr: "10.77.0.0/24",
        rpcPort: 17950,
        mappedCidr: null,
        proxyCidr: null,
        publishedPorts: [],
        secureMode: true,
        secureIdentity: null,
      },
      consumers: [],
      providerWiring: {
        id: "peer-a",
        mappedCidr: sa.node.mappedCidr,
        providerPort: a.gatewayPort,
        key: keyForD,
        localPort: 13470,
        createdAt: new Date().toISOString(),
      },
    };
    mkdirSync(d.stateDir, { recursive: true });
    writeFileSync(join(d.stateDir, "state.json"), JSON.stringify(legacy, null, 1), { mode: 0o600 });
    await d.startHost();
    await waitConnected(d, ["peer-a"], 90_000);
    const state = JSON.parse(readFileSync(join(d.stateDir, "state.json"), "utf8"));
    const backups = readdirSync(d.stateDir).filter((n) => n.startsWith("state.json.bak-"));
    const keyStore = JSON.parse(readFileSync(join(d.stateDir, "provider-keys.json"), "utf8"));
    const raw = readFileSync(join(d.stateDir, "state.json"), "utf8");
    const migrated = await d.status();
    const req = await http(`http://${lan()}:${d.gatewayPort}/v1/chat/completions`, {
      key: d.labKey,
      body: { model: `peer-a/mock${a.upstreamName}/${a.model}`, messages: [{ role: "user", content: "migrated" }] },
    });
    d.stopAll();
    check(`version ${state.version}, providers ${state.providers.length}, backup ${backups.length}, request ${req.status}`,
      state.version === 2 &&
        state.providers.length === 1 &&
        state.providers[0].id === "peer-a" &&
        keyStore.keys["peer-a"] === keyForD &&
        !raw.includes(keyForD) &&
        backups.length >= 1 &&
        migrated.sharing === false &&
        migrated.consuming === true &&
        req.status === 200,
      req.text.slice(0, 160));
    return "role=consumer + providerWiring became a v2 record, its key moved to provider-keys.json, a backup was written, and the old provider answered";
  });

  await step("consuming off unregisters only the plugin's remote providers", async () => {
    const before = a.magpieReq(["providers"]);
    await a.cli(["consume", "off"]);
    const s = await a.status();
    const providersAfterOff = a.magpieReq(["providers"]);
    check(`consuming=${s.consuming}, still listed: ${providersAfterOff.replace(/\n/g, " ").slice(0, 120)}`, s.consuming === false && !/Remote magpie/.test(providersAfterOff));
    await a.cli(["consume", "on"]);
    await waitConnected(a, ["peer-b"], 60_000);
    return `turned off (was: ${before.split("\n").filter(Boolean).length} providers), turned back on with peer-b restored`;
  });
} finally {
  for (const inst of [a, b, c, d, e]) inst?.stopAll();
  const report = {
    ranAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    magpie: MAGPIE,
    network: NETWORK,
    labDir: LAB,
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
  mkdirSync(join(ROOT, "docs", "validation"), { recursive: true });
  writeFileSync(join(ROOT, "docs", "validation", "phase4-lab-report.json"), JSON.stringify(report, null, 1) + "\n");
  console.log(`\n${report.passed} passed, ${report.failed} failed`);
  console.log(`report: docs/validation/phase4-lab-report.json`);
  if (!KEEP) {
    // keep the report, drop the lab's temporary state
    rmSync(LAB, { recursive: true, force: true });
  } else {
    console.log(`lab kept at ${LAB}`);
  }
  if (report.failed) process.exit(1);
}
