// `remote` — targeted management of one remote provider.
//
// Every command names exactly one provider. `test` and `models` are read-only.
// `update-key` never moves the loopback port when the target did not change, and
// a failure restores that provider's previous registration. `remove` restarts
// EasyTier only because 2.6.4 cannot close a forward live; the service then
// re-verifies every remaining provider.

import { OperatorApi, fail, limitDisplay, line, parseArgs, printJson, readSecretFile } from "./operator-lib.ts";

const USAGE = `usage:
  ohmyaihub remote list [--json]
  ohmyaihub remote test <id> [--json]
  ohmyaihub remote models <id> [--json]
  ohmyaihub remote update-key <id> --key-file <0600 path>
  ohmyaihub remote add <id> --cidr 10.66.a.b/32 --key-file <0600 path> [--port 3425] [--local-port N]
  ohmyaihub remote remove <id>
  ohmyaihub remote recover [<id>]`;

export async function runRemote(argv: string[], dataDir: string): Promise<number> {
  const first = argv[0];
  const sub = first && !first.startsWith("--") ? first : undefined;
  const args = parseArgs(sub ? argv.slice(1) : argv);
  if (args.has("help") || !sub) {
    line(USAGE);
    return args.has("help") ? 0 : 2;
  }
  const api = new OperatorApi({ dataDir, timeoutMs: args.one("timeout-ms") ? Number(args.one("timeout-ms")) : 180_000 });
  switch (sub) {
    case "list":
      return remoteList(api, args);
    case "test":
      return remoteTest(api, args);
    case "models":
      return remoteModels(api, args);
    case "update-key":
      return remoteUpdateKey(api, args);
    case "add":
      return remoteAdd(api, args);
    case "remove":
    case "rm":
      return remoteRemove(api, args);
    case "recover":
      return remoteRecover(api, args);
    default:
      line(USAGE);
      fail(`unknown remote command: ${sub}`);
  }
}

async function remoteList(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const r = await api.get<any>("/providers", 30_000);
  if (args.has("json")) {
    printJson(r);
    return 0;
  }
  const providers = r.providers ?? [];
  if (!providers.length) line("no remote providers");
  for (const p of providers) {
    line(
      `${p.id}  ${p.mappedCidr}:${p.providerPort} -> 127.0.0.1:${p.localPort}  ${p.status}` +
        `${p.detail ? ` (${p.detail})` : ""}  ${limitDisplay(p.limit).text}`,
    );
  }
  return 0;
}

async function remoteTest(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) fail("remote test <id>");
  const r = await api.post<any>("/providers/reconcile", { id, verifyModels: true }, 120_000);
  const list = (r.providers ?? []) as any[];
  const one = list.find((p) => p.id === id);
  if (!one) fail(`no remote provider ${id}`);
  const shown = limitDisplay(one.limit);
  if (args.has("json")) {
    printJson({
      provider: { ...one, limitText: shown.text, limitUnsafe: shown.unsafe, limitUnknown: shown.unknown },
      providers: list,
    });
  } else {
    line(`${one.id}  ${one.status}${one.detail ? `: ${one.detail}` : ""}`);
    line(`address ${one.mappedCidr}:${one.providerPort} -> 127.0.0.1:${one.localPort}`);
    line(shown.text);
    if (shown.unsafe) line("UNSAFE: this provider's cap is not positive; it is not out of credit and is not a healthy limited key.");
    const others = list.filter((p) => p.id !== id);
    if (others.length) line(`other providers untouched: ${others.map((p) => `${p.id}=${p.status}`).join(", ")}`);
  }
  return one.status === "connected" && !shown.unsafe && !shown.unknown ? 0 : 1;
}

async function remoteModels(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) fail("remote models <id>");
  const r = await api.post<any>("/providers/models", { id }, 60_000);
  if (args.has("json")) printJson(r);
  else {
    line(`${r.id}: ${r.models?.length ?? 0} model(s)`);
    for (const m of r.models ?? []) line(`  ${m}`);
  }
  return 0;
}

async function remoteUpdateKey(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  const keyFile = args.one("key-file");
  if (!id) fail("remote update-key <id> --key-file <0600 path>");
  if (!keyFile) fail("remote update-key needs --key-file <0600 path>; the key is never put on argv");
  const key = readSecretFile(keyFile, "Gateway Key");
  const p = await api.post<any>("/providers/update", { id, key }, 180_000);
  if (args.has("json")) printJson(p);
  else line(`updated ${p.id}: ${p.status}${p.detail ? ` (${p.detail})` : ""} · 127.0.0.1:${p.localPort}`);
  return p.status === "connected" ? 0 : 1;
}

async function remoteAdd(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  const cidr = args.one("cidr");
  const keyFile = args.one("key-file");
  if (!id) fail("remote add <id> --cidr 10.66.a.b/32 --key-file <0600 path>");
  if (!cidr) fail("remote add needs --cidr 10.66.a.b/32");
  if (!keyFile) fail("remote add needs --key-file <0600 path>; the key is never put on argv");
  const key = readSecretFile(keyFile, "Gateway Key");
  const p = await api.post<any>("/providers/add", {
    id,
    mappedCidr: cidr,
    key,
    ...(args.one("port") ? { providerPort: Number(args.one("port")) } : {}),
    ...(args.one("local-port") ? { localPort: Number(args.one("local-port")) } : {}),
  }, 180_000);
  if (args.has("json")) printJson(p);
  else line(`connected ${p.id}: ${p.mappedCidr}:${p.providerPort} -> 127.0.0.1:${p.localPort} ${p.status}`);
  return p.status === "connected" ? 0 : 1;
}

async function remoteRemove(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) fail("remote remove <id>");
  const removed = await api.post<any>("/providers/rm", { id }, 120_000);
  const after = await api.get<any>("/providers", 30_000).catch(() => ({ providers: [] }));
  if (args.has("json")) printJson({ removed, providers: after.providers ?? [] });
  else {
    line(`removed ${removed.id}; its loopback port ${removed.localPort} is gone`);
    const others = (after.providers ?? []) as any[];
    line(others.length ? `remaining: ${others.map((p) => `${p.id}=${p.status}`).join(", ")}` : "no remote providers remain");
  }
  return 0;
}

async function remoteRecover(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  const body = id ? { id, verifyModels: true } : { verifyModels: true };
  const r = await api.post<any>("/providers/reconcile", body, 180_000);
  const list = (r.providers ?? []) as any[];
  if (args.has("json")) printJson({ providers: list });
  else {
    if (!list.length) line("no remote providers");
    for (const p of list) line(`${p.id}  ${p.status}${p.detail ? `: ${p.detail}` : ""}  127.0.0.1:${p.localPort}`);
  }
  return list.every((p) => p.status === "connected") ? 0 : 1;
}
