#!/usr/bin/env bun
/**
 * Windows capability report. This is a report, not a compatibility claim: it
 * probes the platform-dependent paths the plugin uses and states plainly what
 * this job does and does not prove. Exit code 0 means "the report was produced",
 * never "Windows is supported".
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { localDesktop, nativeDesktopParent, openerArgv } from "../src/console-launch.ts";
import { assetFor } from "../src/easytier-manifest.ts";
import { ownsProcess, rpcListeners } from "../src/easytier.ts";
import { resolveMagpieBin } from "../src/paths.ts";

type State = "VERIFIED" | "FAIL-CLOSED" | "UNKNOWN";
interface Row {
  capability: string;
  state: State;
  evidence: string;
}
const rows: Row[] = [];
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 220);

if (process.platform !== "win32") {
  console.error(`platform report only runs on win32 (this is ${process.platform})`);
  process.exit(1);
}
rows.push({ capability: "runner platform", state: "VERIFIED", evidence: `${process.platform}-${process.arch}, Bun ${Bun.version}` });

try {
  const bound = await rpcListeners(1);
  rows.push({
    capability: "EasyTier listener ownership (rpcListeners)",
    state: bound.length === 0 ? "UNKNOWN" : "VERIFIED",
    evidence: `returned ${JSON.stringify(bound)}; source uses lsof on darwin and ss elsewhere (src/easytier.ts)`,
  });
} catch (e) {
  rows.push({ capability: "EasyTier listener ownership (rpcListeners)", state: "FAIL-CLOSED", evidence: `refuses on win32: ${message(e)}` });
}

try {
  const owned = ownsProcess(process.pid, "C:\\oh-my-aihub\\none.toml");
  rows.push({
    capability: "EasyTier process ownership (ownsProcess)",
    state: owned ? "VERIFIED" : "FAIL-CLOSED",
    evidence: `ownsProcess(self)=${owned}; win32 verification shells out to ps (src/easytier.ts)`,
  });
} catch (e) {
  rows.push({ capability: "EasyTier process ownership (ownsProcess)", state: "FAIL-CLOSED", evidence: message(e) });
}

try {
  const bin = resolveMagpieBin();
  rows.push({ capability: "Magpie binary discovery", state: "VERIFIED", evidence: bin });
} catch (e) {
  rows.push({
    capability: "Magpie binary discovery",
    state: "FAIL-CLOSED",
    evidence: `needs OH_MY_AIHUB_MAGPIE on win32; ${message(e)} (src/paths.ts uses ps/lsof/which)`,
  });
}

const autoOpen = nativeDesktopParent();
rows.push({
  capability: "console auto-open",
  state: autoOpen ? "VERIFIED" : "FAIL-CLOSED",
  evidence: `localDesktop(win32)=${localDesktop("win32", {})}, nativeDesktopParent=${autoOpen}; win32 always refuses (src/console-launch.ts)`,
});

try {
  const argv = openerArgv(`http://127.0.0.1:34567/#ticket=${"a".repeat(64)}`, "win32", {});
  rows.push({ capability: "win32 opener argv", state: "VERIFIED", evidence: argv.join(" ") });
} catch (e) {
  rows.push({ capability: "win32 opener argv", state: "UNKNOWN", evidence: message(e) });
}

const asset = assetFor("win32", "x64");
rows.push({ capability: "EasyTier win32 release pin", state: "VERIFIED", evidence: `${asset.file} sha256=${asset.sha256.slice(0, 12)}...` });

try {
  const tar = Bun.spawnSync(["tar", "--version"]);
  rows.push({
    capability: "zip extraction prerequisite",
    state: tar.exitCode === 0 ? "VERIFIED" : "FAIL-CLOSED",
    evidence: tar.exitCode === 0 ? tar.stdout.toString().split("\n")[0]!.trim() : `tar exited ${tar.exitCode}`,
  });
} catch (e) {
  rows.push({ capability: "zip extraction prerequisite", state: "FAIL-CLOSED", evidence: message(e) });
}

const lines = [
  "# Windows capability report (informational)",
  "",
  "This job runs a curated, loopback-only subset. It does **not** prove Windows support.",
  "",
  "| capability | result | evidence |",
  "| --- | --- | --- |",
  ...rows.map((r) => `| ${r.capability} | ${r.state} | ${r.evidence.replace(/\|/g, "\\|")} |`),
  "",
  "## Not covered by this job",
  "",
  "- Real EasyTier 2.6.4 core: no-TUN overlay, RPC/SOCKS listeners, process adoption after restart.",
  "- Real Magpie 0.1.2289: Gateway Key enforcement, pricing, remote journeys.",
  "- Windows desktop auto-launch (nativeDesktopParent is hard-coded false on win32).",
  "- POSIX file-mode semantics (0600/0700) and shell-script test fixtures.",
  "",
  "## Verdict",
  "",
  "**PARTIAL / fail-closed.** Listener and process ownership checks cannot verify on win32 and refuse;",
  "binary discovery requires OH_MY_AIHUB_MAGPIE. Do not describe the plugin as Windows-supported",
  "until those paths are implemented and measured against a real EasyTier core.",
];
const report = lines.join("\n") + "\n";
writeFileSync("windows-platform-report.md", report);
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
