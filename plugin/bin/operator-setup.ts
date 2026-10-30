// `setup`, `resume`, `preflight` and `doctor`.
//
// The wizard is deliberately conservative: a node that already has a config is
// never reconfigured unless the operator passes --reconfigure. It only sends
// fields the operator named, so a partial change cannot clear peers or the
// listen address. The service owns the apply/rollback transaction.

import { OperatorApi, boolFlag, defaultWizardIO, fail, line, listFlag, parseArgs, preflight, printJson, printPreflight, readSecretFile, type ParsedArgs, type WizardIO } from "./operator-lib.ts";
import type { Service } from "../src/service.ts";

const USAGE = `usage:
  ohmyaihub setup [--resume|--check|--reconfigure] [--json]
    --network <name> [--secret-file <0600 file>|--prompt-secret]
    [--peer tcp://host:11010]... [--listen host:port] [--ports 3425]
    [--share|--no-share] [--consume|--no-consume]
    [--catalog-publish|--no-catalog-publish]
    [--catalog-discover|--no-catalog-discover]
    [--share-models a,b] [--magpie-bin <path>] [--timeout-ms <n>]
  ohmyaihub resume
  ohmyaihub preflight [--live-checks] [--json]
  ohmyaihub doctor [--json]`;

export async function runSetup(argv: string[], dataDir: string, io: WizardIO = defaultWizardIO()): Promise<number> {
  const args = parseArgs(argv);
  if (args.has("help")) {
    line(USAGE);
    return 0;
  }
  const checkOnly = args.has("check");
  const resume = args.has("resume");
  const reconfigure = args.has("reconfigure");
  if (checkOnly || resume) {
    return resumeOrCheck(dataDir, args, { checkOnly });
  }

  const pf = await preflight({
    dataDir,
    magpieBin: args.one("magpie-bin"),
    gatewayPort: args.one("gateway-port") ? Number(args.one("gateway-port")) : undefined,
    timeoutMs: args.one("timeout-ms") ? Number(args.one("timeout-ms")) : undefined,
  });
  if (args.has("json")) printJson(pf);
  else printPreflight(pf);
  if (pf.blockers.length) return 1;
  if (pf.state.configured && !reconfigure) {
    line("");
    line("This node already has a configuration. Nothing was changed.");
    line("Use `setup --reconfigure` to submit a change, or `resume` to start/check it.");
    return 0;
  }

  const host = new OperatorApi({ dataDir, timeoutMs: args.one("timeout-ms") ? Number(args.one("timeout-ms")) : 180_000 });
  let networkName = args.one("network") ?? pf.state.networkName ?? "";
  if (!networkName && io.isTTY) {
    networkName = await io.prompt("Overlay network name", { default: "ohmyaihub" });
  }
  if (!networkName) fail("a first setup needs --network <name>; no existing network name was found");

  let sharing = boolFlag(args, "share", "no-share");
  let consuming = boolFlag(args, "consume", "no-consume");
  if (!pf.state.configured && sharing === undefined && consuming === undefined && io.isTTY) {
    const role = await io.prompt(
      "Role: 1) share this Magpie 2) use remote Magpies 3) both",
      { default: "1" },
    );
    const choice = role.charAt(0);
    if (choice !== "1" && choice !== "2" && choice !== "3") fail("choose role 1, 2 or 3");
    sharing = choice === "1" || choice === "3";
    consuming = choice === "2" || choice === "3";
  }

  let networkSecret: string | undefined;
  if (args.one("secret-file")) {
    networkSecret = readSecretFile(args.one("secret-file")!, "network secret");
  } else if (args.has("prompt-secret") || (!pf.state.configured && io.isTTY)) {
    networkSecret = await io.prompt("Overlay network secret (input hidden)", { secret: true });
  }
  if (!pf.state.configured && !networkSecret) {
    fail("a first setup needs the overlay secret: pass --secret-file <0600 file> (non-interactive) or --prompt-secret");
  }
  if (networkSecret !== undefined && networkSecret.length < 8) fail("the overlay network secret must be at least 8 characters");

  const body: Parameters<Service["configure"]>[0] = { networkName };
  if (networkSecret !== undefined) body.networkSecret = networkSecret;
  let peers = listFlag(args, "peer");
  if (!peers && !args.has("clear-peers") && !pf.state.configured && io.isTTY) {
    const answer = await io.prompt("Initial peer/relay (tcp://host:11010; blank to skip)", { default: "" });
    if (answer) peers = [answer];
  }
  if (peers) body.peers = peers;
  else if (args.has("clear-peers")) body.peers = [];
  if (args.has("listen")) body.listenAddr = args.one("listen") ?? "";
  else if (!pf.state.configured && io.isTTY) {
    const answer = await io.prompt("Listen address (host:port; blank = dial only)", { default: "" });
    if (answer) body.listenAddr = answer;
  }

  if (sharing !== undefined) body.sharingEnabled = sharing;
  else if (!pf.state.configured) body.sharingEnabled = consuming !== true;
  if (consuming !== undefined) body.consumingEnabled = consuming;
  else if (!pf.state.configured) body.consumingEnabled = false;

  let ports = listFlag(args, "ports");
  if (!ports && body.sharingEnabled === true && !pf.state.configured && io.isTTY) {
    const answer = await io.prompt("Published gateway port", { default: String(pf.network.gatewayPort) });
    if (answer) ports = [answer];
  }
  if (ports) body.publishedPorts = ports.map(Number);

  const shareModels = listFlag(args, "share-models");
  if (shareModels) body.shareModels = shareModels;

  let catalogPublish = boolFlag(args, "catalog-publish", "no-catalog-publish");
  if (catalogPublish === undefined && body.sharingEnabled === true && !pf.state.configured && io.isTTY) {
    const answer = await io.prompt("Publish a read-only catalogue? [y/N]", { default: "n" });
    catalogPublish = /^y(es)?$/i.test(answer.trim());
    body.catalogEnabled = catalogPublish;
  } else if (catalogPublish !== undefined) body.catalogEnabled = catalogPublish;

  let catalogDiscover = boolFlag(args, "catalog-discover", "no-catalog-discover");
  if (catalogDiscover === undefined && body.consumingEnabled === true && !pf.state.configured && io.isTTY) {
    const answer = await io.prompt("Discover peers' catalogues? [y/N]", { default: "n" });
    catalogDiscover = /^y(es)?$/i.test(answer.trim());
    body.catalogDiscovery = catalogDiscover;
  } else if (catalogDiscover !== undefined) body.catalogDiscovery = catalogDiscover;

  line("");
  line(
    `applying: network ${networkName}, share=${String(body.sharingEnabled ?? "unchanged")}, ` +
      `consume=${String(body.consumingEnabled ?? "unchanged")}, peers=${peers ? peers.join(",") || "none" : "unchanged"}`,
  );
  const status = await host.post("/configure", body, args.one("timeout-ms") ? Number(args.one("timeout-ms")) : 180_000);
  const checks = await host.get<{ checks: any[] }>("/checks", 60_000).catch((e) => {
    fail(`configured, but checks could not run: ${(e as Error).message}`);
  });
  if (args.has("json")) {
    printJson({ configured: true, status, checks: checks.checks });
  } else {
    line("configured. checks:");
    for (const c of checks.checks) line(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
    line("");
    line("next: `share setup` to choose native models and optionally publish a catalogue;");
    line("      `connect` to use a peer's catalogue (needs the peer's Gateway Key out of band).");
  }
  return checks.checks.some((c) => !c.ok && critical(c.name)) ? 1 : 0;
}

/** `resume` and `setup --check`: never submit a configuration. */
async function resumeOrCheck(dataDir: string, args: ParsedArgs, opts: { checkOnly: boolean }): Promise<number> {
  const pf = await preflight({
    dataDir,
    magpieBin: args.one("magpie-bin"),
    gatewayPort: args.one("gateway-port") ? Number(args.one("gateway-port")) : undefined,
    liveChecks: args.has("live-checks"),
    timeoutMs: args.one("timeout-ms") ? Number(args.one("timeout-ms")) : undefined,
  });
  if (args.has("json")) printJson(pf);
  else printPreflight(pf);
  if (opts.checkOnly) return pf.blockers.length ? 1 : 0;
  if (!pf.host.reachable) return 1;
  const host = new OperatorApi({ dataDir, timeoutMs: args.one("timeout-ms") ? Number(args.one("timeout-ms")) : 180_000 });
  // Resume is allowed to start a stopped supervisor, but never to rewrite
  // config and never to restart a core that is already running: the latter
  // would interrupt live provider requests for no reason.
  if (pf.easytier.running === false) {
    await host.post("/supervisor/start", {}, 60_000).catch((e) => fail(`the host is reachable, but the supervisor did not start: ${(e as Error).message}`));
  }
  const checks = await host.get<{ checks: any[] }>("/checks", 60_000);
  if (args.has("json")) printJson({ resumed: true, checks: checks.checks });
  else {
    line("resumed without changing the configuration. checks:");
    for (const c of checks.checks) line(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  }
  return checks.checks.some((c) => !c.ok && critical(c.name)) ? 1 : 0;
}

function critical(name: string): boolean {
  return new Set([
    "configured",
    "core-running",
    "acl",
    "sharing-suspended",
    "gateway-key-required",
    "mapped-cidr",
    "published-gateway",
    "shared-models-native-only",
    "catalog-published",
    "catalog-forward-port",
    "catalog-quote",
    "catalog-identity",
    "catalog-socks5-loopback",
    "forwards-match",
    "no-orphan-forwards",
  ]).has(name);
}
