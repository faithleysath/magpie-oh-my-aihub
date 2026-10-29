#!/usr/bin/env bun
// Phase-5 end-to-end lab: three isolated Magpie instances on one machine, one
// real EasyTier 2.6.4 overlay, the real plugin host and CLI.
//
//   bun docs/validation/lab/phase5/lab.ts [--keep]
//
// A consumes and discovers; B and C share and publish. A finds B and C through
// EasyTier's peer/route data and reads their signed catalogues through
// EasyTier's own loopback SOCKS5 listener. No mapped_cidr is typed by hand.
// Results are written to docs/validation/phase5-lab-report.json.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { socksHttpGet } from "../../../../plugin/src/catalog.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const LAB = process.env.PHASE5_LAB_DIR || `/tmp/ohmyaihub-phase5-${process.pid}`;
const KEEP = process.argv.includes("--keep");
const MAGPIE = process.env.MAGPIE_BIN || which("magpie");
const PLUGIN_BIN = join(ROOT, "plugin", "bin", "ohmyaihub.ts");
const HOST_TS = join(ROOT, "docs", "validation", "lab", "phase4", "host.ts");
const MOCK_TS = join(ROOT, "docs", "validation", "lab", "phase4", "mock-upstream.ts");
const NETWORK = "phase5-lab";
const NETWORK_SECRET = `phase5-${randomUUID()}`;

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
async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 45_000, everyMs = 500): Promise<T> {
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
}
function start(cmd: string[], opts: { cwd: string; env: Record<string, string>; log: string }): Proc {
  mkdirSync(join(opts.log, ".."), { recursive: true });
  writeFileSync(opts.log, "");
  const p = Bun.spawn({ cmd, cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
      }, 2500);
    },
  };
}

async function http(url: string, opts: { key?: string; method?: string; body?: unknown; timeoutMs?: number } = {}) {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain */
    }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: String((e as Error).message ?? e), json: null };
  }
}

function lan(): string {
  const r = Bun.spawnSync(["ipconfig", "getifaddr", "en0"]);
  const a = r.stdout.toString().trim();
  if (a) return a;
  const r2 = Bun.spawnSync(["ipconfig", "getifaddr", "en1"]);
  const b = r2.stdout.toString().trim();
  if (b) return b;
  const r3 = Bun.spawnSync(["hostname", "-I"]);
  const c = r3.stdout.toString().trim().split(/\s+/)[0];
  if (c && !c.startsWith("127.")) return c;
  throw new Error("no LAN address");
}
async function portFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", lan()]) {
    try {
      const s = await Bun.connect({ hostname: host, port, socket: { data() {}, open() {}, close() {} } });
      s.end();
      return false;
    } catch {
      /* free */
    }
  }
  return true;
}
interface Ports {
  gateway: number;
  ui: number;
  upstream: number;
  listen: number;
  catalog: number;
  socks: number;
}
async function freePorts(catalog: number, socks: number): Promise<Ports> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const base = 21000 + Math.floor(Math.random() * 25000);
    const ports = [base, base + 1, base + 2, base + 3, catalog, socks];
    if (ports.some((p) => p > 65535)) continue;
    const free = await Promise.all(ports.map(portFree));
    if (free.every(Boolean)) return { gateway: ports[0], ui: ports[1], upstream: ports[2], listen: ports[3], catalog, socks };
  }
  throw new Error("no free ports for the lab");
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
  readonly catalogPort: number;
  readonly socksPort: number;
  readonly upstreamName: string;
  readonly model: string;
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
    this.catalogPort = ports.catalog;
    this.socksPort = ports.socks;
    this.upstreamName = name.toLowerCase();
    this.model = `${this.upstreamName}-model`;
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
      env: { PORT: String(this.upstreamPort), UPSTREAM_NAME: this.upstreamName, MODELS: this.model },
      log: join(this.logDir, "upstream.log"),
    });
    await waitFor(`${this.name} upstream`, async () => ((await http(`http://127.0.0.1:${this.upstreamPort}/v1/models`)).status === 200 ? true : null));
    this.magpieReq([
      "provider",
      "add",
      `mock${this.upstreamName}`,
      `url=http://127.0.0.1:${this.upstreamPort}/v1`,
      `responses=http://127.0.0.1:${this.upstreamPort}/v1`,
      `anthropic=http://127.0.0.1:${this.upstreamPort}`,
      `key=sk-test-upstream-${this.name.toLowerCase()}`,
      `models=${this.model}`,
      `name=mock${this.upstreamName}`,
    ]);
    this.magpieReq(["model", "price", `mock${this.upstreamName}/${this.model}`, "1000,1000,0,0"]);
    await this.startGateway();
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
        await sleep(1200);
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
    const r = Bun.spawnSync([MAGPIE, ...args], { cwd: this.data, env: { ...process.env, ...this.env() }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`magpie ${args.join(" ")} failed: ${(r.stderr.toString() || r.stdout.toString()).trim().slice(0, 400)}`);
    return r.stdout.toString();
  }
  async cli(args: string[]): Promise<any> {
    const r = Bun.spawnSync(["bun", PLUGIN_BIN, "--data", this.data, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...this.env() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString();
    if (r.exitCode !== 0) throw new Error(`plugin ${args.join(" ")} failed: ${(r.stderr.toString() || out).trim().slice(0, 800)}`);
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
    // The raw /status snapshot, not the CLI's flattened summary: the lab needs
    // config, providers, consumers and the full catalogue peer list.
    const port = readFileSync(join(this.stateDir, "api-port"), "utf8").trim();
    const token = readFileSync(join(this.stateDir, "api-token"), "utf8").trim();
    const r = await http(`http://127.0.0.1:${port}/status`, { key: token });
    if (r.status !== 200 || !r.json) throw new Error(`GET /status answered ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json;
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

const A = new Instance("A", await freePorts(3426, 13405));
const B = new Instance("B", await freePorts(3427, 13406));
const C = new Instance("C", await freePorts(3428, 13407));

function peerOf(status: any, host: string): any {
  return (status.catalog?.peers ?? []).find((p: any) => p.hostname === host);
}
function nodeIdOf(status: any, host: string): string {
  const p = peerOf(status, host);
  if (!p?.nodeId) throw new Error(`no node id for ${host}`);
  return p.nodeId;
}
function stateOf(inst: Instance): any {
  return JSON.parse(readFileSync(join(inst.stateDir, "state.json"), "utf8")).config;
}
async function aCatalog(): Promise<any> {
  return (await A.cli(["catalog", "status", "--json"])).catalog;
}

try {
  await step("three isolated Magpie gateways enforce keys", async () => {
    await A.setup();
    await B.setup();
    await C.setup();
    const a = await http(`http://${lan()}:${A.gatewayPort}/v1/models`);
    const b = await http(`http://${lan()}:${B.gatewayPort}/v1/models`);
    return `A ${a.status}, B ${b.status} without a key (both 401)`;
  }, { required: true });

  await step("the three plugin hosts boot on one real EasyTier overlay", async () => {
    await A.startHost();
    await B.startHost();
    await C.startHost();
    await A.cli(["configure", "--network", NETWORK, "--secret", NETWORK_SECRET, "--peer", `tcp://127.0.0.1:${B.listenPort}`, "--no-share", "--consume", "--listen", `127.0.0.1:${A.listenPort}`]);
    await B.cli(["configure", "--network", NETWORK, "--secret", NETWORK_SECRET, "--peer", `tcp://127.0.0.1:${A.listenPort}`, "--share", "--no-consume", "--listen", `127.0.0.1:${B.listenPort}`]);
    await C.cli(["configure", "--network", NETWORK, "--secret", NETWORK_SECRET, "--peer", `tcp://127.0.0.1:${A.listenPort}`, "--share", "--no-consume", "--listen", `127.0.0.1:${C.listenPort}`]);
    const status = await waitFor("three peers", async () => {
      const s = await A.status();
      return s.easytier?.peers?.length >= 3 ? s : null;
    });
    return `A sees ${status.easytier.peers.length} peers: ${status.easytier.peers.map((p: any) => p.hostname).join(", ")}`;
  }, { required: true });

  await step("B and C publish signed catalogues; A discovers both without a typed mapped_cidr", async () => {
    await B.cli(["catalog", "config", "--port", String(B.catalogPort), "--display-name", "B lab"]);
    await C.cli(["catalog", "config", "--port", String(C.catalogPort), "--display-name", "C lab"]);
    await B.cli(["catalog", "publish", "on"]);
    await C.cli(["catalog", "publish", "on"]);
    await A.cli(["catalog", "config", "--port", "3426", "--socks-port", String(A.socksPort)]);
    await A.cli(["catalog", "discover", "on"]);
    const bNode = stateOf(B).nodeId;
    const cNode = stateOf(C).nodeId;
    const s = await waitFor("A sees B and C catalogues", async () => {
      const st = await A.status();
      const b = peerOf(st, "ohmyaihub-" + bNode);
      const c = peerOf(st, "ohmyaihub-" + cNode);
      return b?.quote && c?.quote ? st : null;
    }, 60_000);
    const b = peerOf(s, "ohmyaihub-" + bNode);
    const c = peerOf(s, "ohmyaihub-" + cNode);
    if (!b.mappedCidr || !c.mappedCidr) throw new Error("a peer has no mapped address");
    if (b.status === "identity-changed" || c.status === "identity-changed") throw new Error("unexpected identity change on first contact");
    if (!b.quote.models.some((m: any) => m.id === "mockb/b-model")) throw new Error("B's model is missing");
    if (!c.quote.models.some((m: any) => m.id === "mockc/c-model")) throw new Error("C's model is missing");
    if (b.quote.models.some((m: any) => m.id.startsWith("peer-"))) throw new Error("a remote model leaked into B's catalogue");
    const price = b.quote.models.find((m: any) => m.id === "mockb/b-model")?.pricing;
    if (price?.input !== 1000 || price.output !== 1000) throw new Error(`B's price is ${JSON.stringify(price)}`);
    if (s.providers.length !== 0) throw new Error("A has a provider before a key was exchanged");
    return `B ${b.mappedCidr} v${b.quote.publication.version} ${b.status}; C ${c.mappedCidr} v${c.quote.publication.version} ${c.status}; models and prices match`;
  }, { required: true });

  await step("the catalogue is reachable on mapped_cidr through SOCKS5, not on the virtual IP", async () => {
    const st = await A.status();
    const b = peerOf(st, "ohmyaihub-" + stateOf(B).nodeId);
    const mapped = await socksHttpGet({ socksPort: A.socksPort, host: b.mappedCidr.replace(/\/32$/, ""), port: b.catalogPort, path: "/catalog/v1", timeoutMs: 5000 });
    if (mapped.status !== 200) throw new Error(`mapped catalogue answered ${mapped.status}`);
    let virtual = "no answer";
    try {
      const v = await socksHttpGet({ socksPort: A.socksPort, host: b.virtualIpv4, port: b.catalogPort, path: "/catalog/v1", timeoutMs: 3000 });
      virtual = `answered ${v.status}`;
    } catch (e) {
      virtual = `blocked: ${(e as Error).message.slice(0, 80)}`;
    }
    if (!virtual.startsWith("blocked")) throw new Error(`the virtual-IP path ${virtual}`);
    return `mapped ${b.mappedCidr}:${b.catalogPort} 200; virtual ${b.virtualIpv4}:${b.catalogPort} ${virtual}`;
  });

  await step("the catalogue port exposes no management API", async () => {
    const st = await A.status();
    const b = peerOf(st, "ohmyaihub-" + stateOf(B).nodeId);
    const host = b.mappedCidr.replace(/\/32$/, "");
    const status = await socksHttpGet({ socksPort: A.socksPort, host, port: b.catalogPort, path: "/status", timeoutMs: 5000 });
    const providers = await socksHttpGet({ socksPort: A.socksPort, host, port: b.catalogPort, path: "/providers", timeoutMs: 5000 });
    const configure = await socksHttpGet({ socksPort: A.socksPort, host, port: b.catalogPort, path: "/configure", timeoutMs: 5000 });
    if (status.status !== 404 || providers.status !== 404 || configure.status !== 404) {
      throw new Error(`management paths answered ${status.status}/${providers.status}/${configure.status}`);
    }
    return "GET /status, /providers and /configure on the catalogue port all answer 404";
  });

  await step("A requests a connection; B issues a capped key by hand; A connects through the existing provider flow", async () => {
    const a = await A.status();
    const bHost = "ohmyaihub-" + stateOf(B).nodeId;
    const bNode = nodeIdOf(a, bHost);
    const req = await A.cli(["catalog", "request", bNode]);
    if (JSON.stringify(req).includes("sk-")) throw new Error("the request contains a secret");
    const consumerId = `a-${a.config.nodeId}`;
    await B.cli(["consumers", "add", consumerId, "mockb/b-model", "1"]);
    const secret = (await B.cli(["secret", consumerId])).trim();
    await A.cli(["catalog", "connect", bNode, "--key", secret, "--id", "peer-b"]);
    const connected = await waitFor("A provider connected", async () => {
      const st = await A.status();
      const p = st.providers.find((x: any) => x.id === "peer-b");
      return p?.status === "connected" ? st : null;
    });
    const p = connected.providers.find((x: any) => x.id === "peer-b");
    if (!p.limit) throw new Error("the provider has no native limit readout");
    if (p.limit.costLimit !== 1) throw new Error(`unexpected key cap ${p.limit.costLimit}`);
    return `request had no key; B issued a key; A peer-b connected at ${p.mappedCidr}:${p.providerPort}; native limit ${p.limit.cost}/${p.limit.costLimit} USD`;
  });

  await step("a quote price change does not alter B's key cost cap", async () => {
    const aNode = (await A.status()).config.nodeId;
    const before = (await B.status()).consumers.find((c: any) => c.consumerId === `a-${aNode}`);
    B.magpieReq(["model", "price", `mockb/${B.model}`, "2000,2000,0,0"]);
    await B.cli(["catalog", "config", "--display-name", "B lab (new price)"]);
    await A.cli(["catalog", "refresh"]);
    const st = await A.status();
    const b = peerOf(st, "ohmyaihub-" + stateOf(B).nodeId);
    const price = b.quote.models.find((m: any) => m.id === `mockb/${B.model}`)?.pricing;
    if (price?.input !== 2000) throw new Error(`A still sees ${price?.input}`);
    const after = (await B.status()).consumers.find((c: any) => c.consumerId === `a-${st.config.nodeId}`);
    if (after.capUsd !== before.capUsd) throw new Error(`cap changed ${before.capUsd} -> ${after.capUsd}`);
    return `quote input 1000 -> 2000; key cap stayed ${after.capUsd}`;
  });

  await step("B goes offline: A keeps the last quote and marks B offline; B returns", async () => {
    const bNode = stateOf(B).nodeId;
    B.stopHost();
    await sleep(2500);
    const offline = await waitFor("B offline in A's directory", async () => {
      await A.cli(["catalog", "refresh"]);
      const st = await A.status();
      const p = peerOf(st, "ohmyaihub-" + bNode);
      return p && (p.status === "offline" || p.status === "unreachable") ? st : null;
    }, 60_000);
    const p = peerOf(offline, "ohmyaihub-" + bNode);
    if (!p.quote) throw new Error("the last quote was dropped");
    await sleep(1500);
    await B.startHost();
    await waitFor("B back online", async () => {
      await A.cli(["catalog", "refresh"]);
      const st = await A.status();
      const q = peerOf(st, "ohmyaihub-" + bNode);
      return q && q.status !== "offline" && q.quote ? true : null;
    }, 30_000);
    return `B was ${p.status} with its quote kept, then returned`;
  });

  await step("a changed catalogue key is warned about; A accepts it explicitly", async () => {
    const bNode = stateOf(B).nodeId;
    // Replacing the identity file while the host runs is a new key on the next
    // publish: exactly what a different operator or a restored backup looks like.
    rmSync(join(B.stateDir, "catalog-identity.json"), { force: true });
    await B.cli(["catalog", "config", "--display-name", "B lab (new identity)"]);
    await A.cli(["catalog", "refresh"]);
    const changed = await waitFor("A warns about B's changed key", async () => {
      const st = await A.status();
      const p = peerOf(st, "ohmyaihub-" + bNode);
      return p?.status === "identity-changed" ? st : null;
    });
    const p = peerOf(changed, "ohmyaihub-" + bNode);
    if (!p.pendingFingerprint) throw new Error("no pending fingerprint");
    const refused = await A.cliMayFail(["catalog", "request", bNode]);
    if (refused.ok) throw new Error("a request was generated despite the changed key");
    await A.cli(["catalog", "trust", bNode, "--fingerprint", p.pendingFingerprint]);
    const trusted = await waitFor("A accepts the new key", async () => {
      const st = await A.status();
      const q = peerOf(st, "ohmyaihub-" + bNode);
      return q && (q.status === "verified" || q.status === "connected") ? true : null;
    });
    return `identity-changed with pending ${p.pendingFingerprint.slice(0, 16)}…, request refused, then trusted`;
  });

  await step("C unpublishes: its listener stops and its Forward port is withdrawn", async () => {
    const cNode = stateOf(C).nodeId;
    await C.cli(["catalog", "publish", "off"]);
    const cStatus = await C.status();
    if (cStatus.catalog.publishing || cStatus.catalog.server.running) throw new Error("C still publishes");
    const ports = cStatus.easytier.publishedPorts ?? [];
    if (ports.includes(C.catalogPort)) throw new Error(`C still allows catalogue port ${C.catalogPort}`);
    await A.cli(["catalog", "refresh"]);
    const st = await A.status();
    const p = peerOf(st, "ohmyaihub-" + cNode);
    if (p?.quote && p.status !== "unreachable" && p.status !== "offline") throw new Error(`C is ${p?.status}`);
    return `C catalogue off; Forward ports [${ports.join(", ")}] exclude ${C.catalogPort}`;
  });

  await step("A's host restart restores discovery, its trusted peer and the cached quote", async () => {
    const bNode = stateOf(B).nodeId;
    await A.status();
    A.stopHost();
    await sleep(2500);
    await A.startHost();
    await A.cli(["catalog", "refresh"]);
    const after = await waitFor("A directory after restart", async () => {
      const st = await A.status();
      const p = peerOf(st, "ohmyaihub-" + bNode);
      return p?.quote ? st : null;
    }, 30_000);
    const p = peerOf(after, "ohmyaihub-" + bNode);
    if (p.status !== "verified" && p.status !== "connected") throw new Error(`B is ${p.status}`);
    if (!after.providers.find((x: any) => x.id === "peer-b")) throw new Error("the provider record was lost on restart");
    return `discovery enabled, B ${p.status}, quote v${p.quote.publication.version}, provider record kept`;
  }, { required: true });

  const report = {
    at: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    bun: Bun.version,
    magpie: MAGPIE,
    network: NETWORK,
    instances: { A: A.gatewayPort, B: B.gatewayPort, C: C.gatewayPort },
    catalogPorts: { A: A.catalogPort, B: B.catalogPort, C: C.catalogPort },
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
  writeFileSync(join(ROOT, "docs", "validation", "phase5-lab-report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${report.failed} failed · report docs/validation/phase5-lab-report.json`);
  if (report.failed) process.exitCode = 1;
} finally {
  A.stopAll();
  B.stopAll();
  C.stopAll();
  if (KEEP) console.log(`kept ${LAB}`);
  else rmSync(LAB, { recursive: true, force: true });
}
