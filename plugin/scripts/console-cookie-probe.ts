// Maintainer-only browser experiment. Starts the production session transport
// with a tiny fixture page; emits no credentials to stdout.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { startConsoleServer } from "../src/console-server.ts";

const root = process.argv[2];
if (!root?.startsWith("/tmp/")) throw new Error("supply an isolated /tmp directory");
const assets = join(root, "assets");
mkdirSync(assets, { recursive: true, mode: 0o700 });
writeFileSync(join(assets, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地 Cookie 验证</title><h1>本地 Cookie 验证</h1><p>仅用于开发验收；没有业务数据。</p></html>');
for (const name of ["app.js", "session.js", "providers.js", "style.css"]) writeFileSync(join(assets, name), "");
const servers = [false, true].map((secureCookie) => ({
  secureCookie,
  server: startConsoleServer({ assetsDir: assets, state: async () => ({ ok: true }), action: async () => ({}), allowedActions: [], secureCookie }),
}));
function credentials() {
  const file = join(root, "runtime.json");
  writeFileSync(file, JSON.stringify(servers.map(({ secureCookie, server }) => ({ secureCookie, origin: server.origin, ticket: new URL(server.issueTicket()).hash.slice("#ticket=".length) }))), { mode: 0o600 });
  chmodSync(file, 0o600);
}
credentials();
console.log(JSON.stringify({ ready: true, runtimeFile: join(root, "runtime.json"), ports: servers.map((item) => item.server.port) }));
process.on("SIGUSR1", credentials);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { for (const { server } of servers) server.stop(); process.exit(0); });
