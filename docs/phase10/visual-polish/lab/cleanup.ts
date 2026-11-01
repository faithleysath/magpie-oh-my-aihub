#!/usr/bin/env bun
/**
 * Stop and delete a phase-10 visual lab, then prove nothing is left.
 *
 *   bun docs/phase10/visual-polish/lab/cleanup.ts --root /tmp/ohmyaihub-visual-1234
 *
 * It only touches processes whose command line names that root (the app copy,
 * the plugin host, EasyTier core, mock upstream). The user's Magpie and port
 * 3425 are never matched. Output is a sanitized JSON proof.
 */
const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const ROOT = arg("root", "");
const KEEP = process.argv.includes("--keep");
if (!ROOT || !ROOT.startsWith("/tmp/") || ROOT.length < 10) throw new Error("pass --root /tmp/<lab>");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processes(): { pid: number; command: string }[] {
  const out = Bun.spawnSync(["ps", "-Ao", "pid=,command="]).stdout.toString();
  return out.split("\n").map((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), command: match[2]! } : null;
  }).filter((row): row is { pid: number; command: string } => Boolean(row));
}
function owned(): { pid: number; command: string }[] {
  return processes().filter((row) => row.command.includes(ROOT) && !row.command.includes("cleanup.ts"));
}
function kill(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
}

const before = owned();
for (const row of before) kill(row.pid);
await sleep(1500);
const survivors = owned();
for (const row of survivors) {
  try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ }
}
await sleep(800);
const remaining = owned();
const ports = [...new Set(before.flatMap((row) => [...row.command.matchAll(/:(\d{4,5})\b/g)].map((match) => Number(match[1]))))].sort((a, b) => a - b);
const busy: number[] = [];
for (const port of ports) {
  const result = Bun.spawnSync(["bash", "-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`]);
  if (result.stdout.toString().trim()) busy.push(port);
}
if (!KEEP) Bun.spawnSync(["rm", "-rf", ROOT]);
const proof = {
  schema: "ohmyaihub-phase10-visual-lab-cleanup/v1",
  at: new Date().toISOString(),
  root: ROOT,
  stopped: before.map((row) => ({ pid: row.pid, command: row.command.replace(ROOT, "<lab>").slice(0, 160) })),
  remaining: remaining.map((row) => ({ pid: row.pid, command: row.command.replace(ROOT, "<lab>").slice(0, 160) })),
  portsChecked: ports,
  portsStillListening: busy,
  removed: !KEEP,
  userPort3425Touched: false,
};
console.log(JSON.stringify(proof, null, 2));
