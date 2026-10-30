// Maintainer-only local fixture. Never loaded by the product plugin.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createConsoleHandler, ConsoleInputError } from "../../../../../plugin/src/console-server.ts";
import { acquireHostLock } from "../../../../../plugin/src/lock.ts";
import { atomicPrivateJson, chainId, fields, FixtureInputError, FixtureModel, object, SIMULATION_LABEL } from "./model.ts";
import { reviewDeposit, reviewTransfer, SyntheticSigner } from "./signer.ts";

const ROOT = import.meta.dir;
const PLUGIN = resolve(ROOT, "../../../../../plugin");
const BODY_LIMIT = 64 * 1024;
const CONTROL_ACTIONS = ["wallet-generate", "wallet-reset", "wallet-review", "wallet-sign", "transfer-review", "chain-control", "evidence-export"] as const;
function json(input: unknown, status = 200): Response {
  return Response.json(input, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" } });
}
async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new FixtureInputError("JSON required");
  if (request.headers.has("content-encoding") || Number(request.headers.get("content-length") ?? 0) > BODY_LIMIT) throw new FixtureInputError("bounded plain JSON required");
  const reader = request.body?.getReader();
  if (!reader) throw new FixtureInputError("JSON required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { size += value.byteLength; if (size > BODY_LIMIT) { await reader.cancel(); throw new FixtureInputError("body exceeds64KiB"); } chunks.push(value); }
    }
  } finally { reader.releaseLock(); }
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
  catch { throw new FixtureInputError("single JSON object required"); }
}

function prepareAssets(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [from, to] of [["wallet.html", "index.html"], ["wallet.js", "app.js"], ["wallet.css", "style.css"]]) copyFileSync(join(ROOT, from!), join(directory, to!));
  copyFileSync(join(PLUGIN, "console/session.js"), join(directory, "session.js"));
  // Transport requires its exact product module manifest. No product UI is
  // shipped here: this empty module belongs only to the private fixture copy.
  writeFileSync(join(directory, "providers.js"), "export {};\n", { mode: 0o600 });
  for (const file of ["index.html", "app.js", "style.css", "session.js"]) chmodSync(join(directory, file), 0o600);
}

export interface FixtureRuntime {
  schema: "ohmyaihub.private-wallet-fixture/v1";
  label: string;
  pid: number;
  origin: string;
  rpc: { chainId: 97 | 84532; url: string }[];
  /** Private launch capability; runtime file only, never console snapshots/logs. */
  launchUrl: string;
  stopCapability: string;
  stateFile: string;
}
export interface RunningFixture { runtimePath: string; runtime: FixtureRuntime; stop(): void }

/** Tests use disposable directories. Parent alone starts the actual actor fixture. */
export function startFixture(directory: string, port = 0): RunningFixture {
  if (!isAbsolute(directory)) throw new Error("absolute private fixture directory required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("fixture directory must not be a symlink");
  chmodSync(directory, 0o700);
  const lock = acquireHostLock(join(directory, "fixture.lock"));
  if (!lock) throw new Error("fixture directory already owned");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let transport: ReturnType<typeof createConsoleHandler> | undefined;
  const signer = new SyntheticSigner();
  const runtimePath = join(directory, "runtime.json");
  const assets = join(directory, "assets");
  let stopped = false;
  let signerTouchedAt = 0;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let evidence: (() => unknown) | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signer.clear();
    if (idleTimer) clearInterval(idleTimer);
    transport?.stop();
    server?.stop(true);
    try { if (evidence) atomicPrivateJson(join(directory, "fixture-evidence.json"), evidence()); } catch { /* no private diagnostics */ }
    try { rmSync(runtimePath); } catch { /* gone */ }
    lock.release();
  };
  try {
    prepareAssets(assets);
    const model = new FixtureModel(join(directory, "chain-state.json"));
    evidence = () => ({ schema: "ohmyaihub.fixture-run-evidence/v1", at: new Date().toISOString(), ...model.snapshot() });
    const stopCapability = randomBytes(32).toString("hex");
    server = Bun.serve({
      hostname: "127.0.0.1", port,
      fetch: async (request) => {
        const ownPort = server!.port!;
        const origin = `http://127.0.0.1:${ownPort}`;
        const url = new URL(request.url);
        if (request.headers.get("host") !== `127.0.0.1:${ownPort}` || url.origin !== origin) return json({ error: "unexpected_host" }, 403);
        const requestOrigin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if ((requestOrigin !== null && requestOrigin !== origin) || (site !== null && site !== "same-origin" && !(site === "none" && url.pathname === "/"))) return json({ error: "cross_site_denied" }, 403);
        if (url.search) return json({ error: "query_not_allowed" }, 400);
        if (url.pathname === "/maintainer/stop") {
          const provided = request.headers.get("x-fixture-control") ?? "";
          if (request.method !== "POST" || requestOrigin !== null || !/^[0-9a-f]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(stopCapability))) return json({ error: "private_control_required" }, 403);
          const timer = setTimeout(stop, 25); timer.unref();
          return json({ stopping: true });
        }
        if (url.pathname === "/rpc/97" || url.pathname === "/rpc/84532") {
          if (request.method !== "POST") return json({ error: "post_required" }, 405);
          if (request.headers.has("authorization")) return json({ error: "no_product_tokens" }, 403);
          try {
            const body = await bodyObject(request);
            const response = await model.rpc(url.pathname === "/rpc/97" ? 97 : 84532, body);
            return json(response.body, response.status);
          } catch (cause) {
            return json({ error: cause instanceof FixtureInputError ? cause.message : "fixture_rpc_failed" }, 400);
          }
        }
        if (Date.now() - signerTouchedAt > 10 * 60_000) signer.clear();
        const response = await (transport?.handle(request) ?? json({ error: "starting" }, 503));
        if (url.pathname === "/ui/logout" && response.status === 200) signer.clear();
        return response;
      },
    });
    transport = createConsoleHandler({
      assetsDir: assets,
      allowedActions: CONTROL_ACTIONS,
      sensitiveActions: ["wallet-review", "wallet-sign", "transfer-review"],
      state: async () => ({ ...model.snapshot(), wallet: signer.state() }),
      action: async (name, input) => {
        try {
          if (name === "evidence-export") { fields(input, []); return evidence!(); }
          if (name === "wallet-generate") { fields(input, []); signerTouchedAt = Date.now(); return signer.generate(); }
          if (name === "wallet-reset") { fields(input, []); signer.clear(); return { cleared: true }; }
          if (name === "wallet-review") {
            fields(input, ["document"]);
            const reviewed = reviewDeposit(input.document);
            return { document: reviewed.document, digest: reviewed.digest };
          }
          if (name === "wallet-sign") { fields(input, ["document", "consent"]); signerTouchedAt = Date.now(); return signer.sign(input.document, input.consent); }
          if (name === "transfer-review") { fields(input, ["document"]); return reviewTransfer(input.document); }
          if (name === "chain-control") {
            fields(input, ["name", "input", "operationId", "consent"]);
            if (input.consent !== true || typeof input.name !== "string") throw new FixtureInputError("explicit synthetic event/control consent required");
            return model.control(input.name, object(input.input), input.operationId);
          }
          throw new FixtureInputError("unknown fixture action");
        } catch (cause) {
          if (cause instanceof FixtureInputError) throw new ConsoleInputError(cause.message);
          throw new Error("fixture action outcome unknown");
        }
      },
    }, server.port!);
    const runtime: FixtureRuntime = { schema: "ohmyaihub.private-wallet-fixture/v1", label: SIMULATION_LABEL, pid: process.pid, origin: transport.origin,
      rpc: [97, 84532].map((id) => ({ chainId: chainId(id), url: `${transport!.origin}/rpc/${id}` })), launchUrl: transport.issueTicket(), stopCapability, stateFile: join(directory, "chain-state.json") };
    atomicPrivateJson(runtimePath, runtime);
    // Sanitized source manifest has no launch capability, key or signature.
    const sources = ["server.ts", "model.ts", "signer.ts", "wallet.html", "wallet.js", "wallet.css"].map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(ROOT, name))).digest("hex") }));
    const cryptoSources = ["src/eip712.ts", "src/deposits.ts", "src/keccak.ts", "test/support/signer.ts"].map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(PLUGIN, name))).digest("hex") }));
    atomicPrivateJson(join(directory, "source-manifest.json"), { schema: "ohmyaihub.fixture-evidence/v1", label: SIMULATION_LABEL, bun: Bun.version, platform: process.platform, arch: process.arch, cryptoMode: "memory-only disposable process signer; no browser bundle", sources, cryptoSources });
    idleTimer = setInterval(() => { if (Date.now() - signerTouchedAt > 10 * 60_000) signer.clear(); }, 15_000);
    idleTimer.unref();
    return { runtimePath, runtime, stop };
  } catch {
    stop();
    throw new Error("fixture failed to start");
  }
}

async function main() {
  const [command, argument] = Bun.argv.slice(2);
  if (command === "start" && argument && isAbsolute(argument)) {
    const fixture = startFixture(argument);
    // One path only. It contains the private launch URL; do not print its content.
    console.log(fixture.runtimePath);
    process.once("SIGINT", fixture.stop);
    process.once("SIGTERM", fixture.stop);
    return;
  }
  if (command === "stop" && argument && isAbsolute(argument)) {
    const stat = lstatSync(argument);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 || (stat.mode & 0o077) !== 0) throw new Error("private fixture runtime required");
    const runtime = JSON.parse(readFileSync(argument, "utf8")) as FixtureRuntime;
    if (runtime.schema !== "ohmyaihub.private-wallet-fixture/v1" || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(runtime.origin) || !/^[0-9a-f]{64}$/.test(runtime.stopCapability)) throw new Error("invalid fixture runtime");
    const result = await fetch(runtime.origin + "/maintainer/stop", { method: "POST", headers: { "x-fixture-control": runtime.stopCapability }, redirect: "error" });
    if (!result.ok) throw new Error("fixture stop refused");
    console.log(argument);
    return;
  }
  throw new Error("usage: bun server.ts start <absolute-private-directory> | stop <absolute-runtime.json>");
}
if (import.meta.main) void main().catch(() => { console.error("fixture command failed"); process.exitCode = 1; });
