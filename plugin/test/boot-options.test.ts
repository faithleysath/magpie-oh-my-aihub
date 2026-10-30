import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRecord, writeAppliedRecord } from "../src/plugin-options.ts";

const options = {
  networkName: "boot-options-lab",
  networkSecret: "fixture-network-value",
  sharingEnabled: true,
  shareModels: ["native/approved"],
  rpcPort: 15901,
  catalogEnabled: true,
  catalogDiscovery: true,
  catalogDisplayName: "Fixture provider",
  catalogContact: "Private handover",
  catalogPort: 3496,
};

interface Result {
  calls: { method: string; patch?: Record<string, unknown> }[];
  config: Record<string, unknown> | null;
}

async function boot(dir: string, fixture: Record<string, unknown>): Promise<Result> {
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "support/boot-options-probe.ts")], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`entry probe failed (${code}): ${stderr}\n${stdout}`);
  const result = stdout.split("\n").find((line) => line.startsWith("BOOT_RESULT "));
  if (!result) throw new Error(`entry probe returned no result: ${stderr}\n${stdout}`);
  return JSON.parse(result.slice("BOOT_RESULT ".length));
}

async function isolated(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohmyaihub-boot-options-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const starts = (result: Result) => result.calls.filter((call) => call.method === "start");
const patches = (result: Result) => result.calls.filter((call) => call.method === "configure").map((call) => call.patch);

describe("real entry options persistence and startup", () => {
  test("migration then preferences-only Save preserves the running network and policy", () => isolated(async (dir) => {
    const live = { ...options, networkSecret: "fixture-rotated-value", sharingEnabled: false, shareModels: ["native/current"], rpcPort: 15902 };
    const first = await boot(dir, { config: live, options });
    expect(patches(first)).toEqual([]);
    const saved = JSON.parse(readFileSync(join(dir, "oh-my-aihub/applied-options.json"), "utf8"));
    expect(saved.applied.networkSecret).toBe(options.networkSecret);
    const next = await boot(dir, { config: first.config, options: { ...options, pagePrefs: { showAdvanced: true } } });
    expect(patches(next)).toEqual([]);
    expect(next.config).toEqual(live);
    expect(starts(first)).toHaveLength(1);
    expect(starts(next)).toHaveLength(1);
  }));

  test("first-run options apply the explicit model whitelist, RPC and catalogue settings", () => isolated(async (dir) => {
    const result = await boot(dir, { config: null, options });
    expect(patches(result)).toEqual([options]);
    expect(result.config).toEqual(options);
    expect(starts(result)).toHaveLength(1);
    const again = await boot(dir, { config: result.config, options });
    expect(patches(again)).toEqual([]);
    expect(starts(again)).toHaveLength(1);
  }));

  test("a successful options patch still starts recovery and watchers exactly once", () => isolated(async (dir) => {
    writeAppliedRecord(newRecord(options, "seed", new Date().toISOString()), join(dir, "oh-my-aihub/applied-options.json"));
    const result = await boot(dir, { config: options, options: { ...options, peers: ["tcp://relay.invalid:11010"] } });
    expect(patches(result)).toEqual([{ peers: ["tcp://relay.invalid:11010"] }]);
    expect(starts(result)).toHaveLength(1);
    expect(result.calls.map((call) => call.method)).toEqual(["configure", "start"]);
  }));

  test("a refused options patch starts the retained configuration and preserves the retry baseline", () => isolated(async (dir) => {
    writeAppliedRecord(newRecord(options, "seed", new Date().toISOString()), join(dir, "oh-my-aihub/applied-options.json"));
    const result = await boot(dir, { config: options, options: { ...options, peers: ["tcp://relay.invalid:11010"] }, rejectConfigure: true });
    expect(starts(result)).toHaveLength(1);
    expect(result.config).toEqual(options);
    const saved = JSON.parse(readFileSync(join(dir, "oh-my-aihub/applied-options.json"), "utf8"));
    expect(saved.applied).toEqual(options);
    expect(saved.error).toContain("fixture configure rejected");
  }));
});
