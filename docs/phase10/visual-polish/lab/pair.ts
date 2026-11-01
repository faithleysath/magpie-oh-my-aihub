#!/usr/bin/env bun
/**
 * Pair one browser session to each lab console through the real pairing flow.
 *
 *   bun docs/phase10/visual-polish/lab/pair.ts --root /tmp/ohmyaihub-visual-1234
 *
 * It asks the console for a pairing request, marks that exact pending record
 * approved in the console's own durable pairing journal (the state the human
 * approval writes, without restarting the plugin host), then exchanges id+secret
 * for a session cookie. Cookies are written to <root>/<node>-session.json (0600)
 * and are never printed, committed or screenshotted. Browser pairing is lab
 * tooling here; the product flow under test is the model request/approval.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const ROOT = arg("root", "");
if (!ROOT) throw new Error("pass --root <lab>");
const lab = JSON.parse(readFileSync(join(ROOT, "lab.json"), "utf8"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const node of lab.nodes) {
  const origin = `http://127.0.0.1:${node.consolePort}`;
  const headers = { "content-type": "application/json", "X-Ohmyaihub-Request": "1", Origin: origin };
  const created = await fetch(`${origin}/ui/pairing`, { method: "POST", headers, body: "{}" });
  if (created.status !== 200) throw new Error(`${node.name}: pairing request ${created.status}`);
  const pairing = await created.json();
  const journalFile = join(node.config, "magpie", "oh-my-aihub", "console-pairing.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  const record = journal.records.find((entry: any) => entry.id === pairing.id);
  if (!record) throw new Error(`${node.name}: pairing record is not in the journal`);
  record.state = "approved";
  writeFileSync(journalFile, JSON.stringify(journal) + "\n", { mode: 0o600 });
  let cookie = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500);
    const res = await fetch(`${origin}/ui/pairing/exchange`, { method: "POST", headers, body: JSON.stringify({ id: pairing.id, secret: pairing.secret }) });
    if (res.status === 202) continue;
    if (res.status !== 200) throw new Error(`${node.name}: pairing exchange ${res.status}`);
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    break;
  }
  if (!cookie) throw new Error(`${node.name}: pairing was not approved`);
  writeFileSync(join(ROOT, `${node.name}-session.json`), JSON.stringify({ origin, cookie }, null, 2) + "\n", { mode: 0o600 });
  console.error(`${node.name}: paired on ${origin}`);
}
process.exit(0);
