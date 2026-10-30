// `connect` — the consumer-side catalogue journey.
//
// The wizard never treats "first seen" as accepted. It shows the full TOFU
// fingerprint, the quote and the real model prices, then requires the operator
// to name/confirm both (non-interactive) or select and type them (interactive).
// The service enforces the same rule, so a hand-written HTTP call cannot skip it.

import {
  OperatorApi,
  defaultWizardIO,
  fail,
  line,
  listFlag,
  parseArgs,
  printJson,
  readSecretFile,
  writeSecretFile,
  type WizardIO,
} from "./operator-lib.ts";

const USAGE = `usage:
  ohmyaihub connect [--node <node-id|hostname>] [--trust] [--fingerprint <sha256>] [--quote <sha256>]
    [--models a,b] [--request-out <file>] [--key-file <0600 path>] [--id <provider-id>] [--json]

Without --key-file the command prints/writes the structured request for the provider.
With --key-file it connects using the provider's Gateway Key.`;

interface Peer {
  hostname: string;
  virtualIpv4: string;
  nodeId: string | null;
  status: string;
  detail: string | null;
  mappedCidr: string | null;
  online: boolean;
  identity: { keyId: string; fingerprint: string; publicKey: string } | null;
  pendingFingerprint: string | null;
  quote: any;
  quoteHash: string | null;
  catalogPort: number | null;
}

function priceText(pricing: any): string {
  if (!pricing || typeof pricing.input !== "number" || typeof pricing.output !== "number") return "NO COMPLETE PRICE";
  const cache =
    typeof pricing.cacheRead === "number" || typeof pricing.cacheWrite === "number"
      ? ` · cache ${pricing.cacheRead ?? "?"}/${pricing.cacheWrite ?? "?"}`
      : "";
  return `$${pricing.input}/$${pricing.output} per 1M in/out${cache}`;
}

export async function runConnect(argv: string[], dataDir: string, io: WizardIO = defaultWizardIO()): Promise<number> {
  const args = parseArgs(argv);
  if (args.has("help")) {
    line(USAGE);
    return 0;
  }
  const api = new OperatorApi({ dataDir, timeoutMs: args.one("timeout-ms") ? Number(args.one("timeout-ms")) : 180_000 });
  const catalog = await api.get<any>("/catalog", 30_000);
  const peers: Peer[] = (catalog?.catalog?.peers ?? []).filter((p: Peer) => p.status !== "self");
  let wanted = args.one("node") ?? args.positionals[0];
  if (!wanted) {
    printPeerList(peers);
    if (args.has("json")) printJson({ peers });
    if (!io.isTTY) return 2;
    if (!peers.length) fail("no catalogue peers to select");
    const answer = (await io.prompt(`Select peer by number [1-${peers.length}]`, { default: "1" })).trim();
    if (!/^\d+$/.test(answer)) fail(`invalid peer selection: ${answer}`);
    const index = Number(answer);
    if (index < 1 || index > peers.length) fail(`peer selection ${index} is outside 1-${peers.length}`);
    wanted = peers[index - 1].hostname;
  }
  const peer = findPeer(peers, wanted);
  if (!peer) fail(`no catalogue peer ${wanted}; run \`connect\` without --node to refresh/list, or check discovery`);

  const identity = peer.identity;
  const quote = peer.quote;
  if (!identity || !quote || !peer.quoteHash || !peer.mappedCidr) {
    fail(`${peer.hostname} has no complete catalogue: status ${peer.status}${peer.detail ? ` (${peer.detail})` : ""}`);
  }
  if (peer.status === "stale") fail(`${peer.hostname} offered an older/replayed quote; refresh the catalogue first`);
  if (!peer.online) fail(`${peer.hostname} is offline; refresh the directory when it returns`);

  let fingerprint = args.one("fingerprint");
  let quoteHash = args.one("quote");
  const needsTrust = peer.status === "unverified" || peer.status === "identity-changed";
  let trust = args.has("trust");
  if (needsTrust || !fingerprint || !quoteHash) showPeer(peer);
  if (needsTrust) {
    if (!trust) {
      if (!io.isTTY) {
        fail(
          `${peer.hostname} is ${peer.status}. First sight is self-signed TOFU, not an identity. ` +
            `Review the fingerprint/quote above, then re-run with --trust --fingerprint <sha256> --quote <sha256>.`,
        );
      }
      const accepted = await io.prompt("Accept this first-seen catalogue key? [y/N]", { default: "n" });
      if (!/^y(es)?$/i.test(accepted.trim())) fail("catalogue identity not accepted");
      trust = true;
    }
    if (!trust) fail("catalogue identity not accepted");
    const target = peer.status === "identity-changed" ? peer.pendingFingerprint : identity.fingerprint;
    if (!target) fail(`${peer.hostname} did not present a fingerprint to accept`);
    if (!fingerprint) {
      if (!io.isTTY) fail(`non-interactive trust needs --fingerprint ${target}`);
      const typed = (await io.prompt(`Type the first 12 hex of the full fingerprint ${target}`, { default: "" })).trim();
      if (typed.length !== 12 || !target.startsWith(typed)) fail("fingerprint confirmation did not match");
      fingerprint = target;
    }
    if (!quoteHash) {
      if (!io.isTTY) fail(`non-interactive trust needs --quote ${peer.quoteHash}`);
      const typed = (await io.prompt(`Type the first 12 hex of quote hash ${peer.quoteHash}`, { default: "" })).trim();
      if (typed.length !== 12 || !peer.quoteHash!.startsWith(typed)) fail("quote confirmation did not match");
      quoteHash = peer.quoteHash;
    }
    if (fingerprint !== target) fail(`the accepted fingerprint is not ${target}`);
    if (quoteHash !== peer.quoteHash) fail(`the accepted quote hash is not ${peer.quoteHash}`);
    await api.post("/catalog/trust", { nodeId: peer.nodeId ?? identity.keyId, fingerprint }, 30_000);
    const refreshed = await api.get<any>("/catalog", 30_000);
    const after = findPeer((refreshed?.catalog?.peers ?? []) as Peer[], wanted);
    if (!after) fail("the peer disappeared after trusting it");
    if (after.identity?.fingerprint !== fingerprint) fail("the trusted fingerprint changed while refreshing the catalogue");
    if (after.quoteHash !== quoteHash) fail("the accepted quote changed while refreshing the catalogue");
    return continueWith(api, after, args, { fingerprint, quoteHash }, io);
  }

  if (!fingerprint || !quoteHash) {
    if (!io.isTTY) {
      fail("non-interactive connect needs --fingerprint <sha256> and --quote <sha256> from the display above");
    }
    const confirm = (await io.prompt(`Type the first 12 hex of fingerprint ${identity.fingerprint}`, { default: "" })).trim();
    if (!identity.fingerprint.startsWith(confirm) || confirm.length !== 12) fail("fingerprint confirmation did not match");
    const quoteConfirm = (await io.prompt(`Type the first 12 hex of quote hash ${peer.quoteHash}`, { default: "" })).trim();
    if (!peer.quoteHash.startsWith(quoteConfirm) || quoteConfirm.length !== 12) fail("quote confirmation did not match");
    fingerprint = identity.fingerprint;
    quoteHash = peer.quoteHash;
  }
  if (fingerprint !== identity.fingerprint) fail(`the accepted fingerprint is not ${identity.fingerprint}`);
  if (quoteHash !== peer.quoteHash) fail(`the accepted quote hash is not ${peer.quoteHash}`);
  return continueWith(api, peer, args, { fingerprint, quoteHash }, io);
}

async function continueWith(
  api: OperatorApi,
  peer: Peer,
  args: ReturnType<typeof parseArgs>,
  accepted: { fingerprint: string; quoteHash: string },
  io: WizardIO,
): Promise<number> {
  const identity = peer.identity!;
  const quote = peer.quote;
  if (accepted.fingerprint !== identity.fingerprint) fail(`the accepted fingerprint changed to ${identity.fingerprint}; re-read the catalogue`);
  if (accepted.quoteHash !== peer.quoteHash) fail(`the accepted quote changed to ${peer.quoteHash}; re-read the catalogue`);
  const available = (quote.models ?? []).map((m: any) => String(m.id));
  let models = listFlag(args, "models");
  if (!models) {
    if (io.isTTY) {
      (quote.models ?? []).forEach((m: any, i: number) => {
        line(`  ${String(i + 1).padStart(2)}. ${m.id}  ${priceText(m.pricing)}`);
      });
      const answer = (await io.prompt(`Select models by number/range (comma-separated), or Enter for all`, { default: "" })).trim();
      models = parseModelSelection(answer, quote.models ?? []);
    } else {
      models = available;
    }
  }
  const selectedModels: string[] = models ?? available;
  const missing = selectedModels.filter((m) => !available.includes(m));
  if (missing.length) fail(`${peer.hostname} does not offer: ${missing.join(", ")}`);
  if (!selectedModels.length) fail("choose at least one model");

  const nodeRef = peer.nodeId ?? identity.keyId;
  const keyFile = args.one("key-file");
  const requestFile = args.one("request-out");
  let request: any = null;
  if (!keyFile || requestFile) {
    request = await api.post<any>(
      "/catalog/request",
      {
        nodeId: nodeRef,
        models: selectedModels,
        fingerprint: accepted.fingerprint,
        quoteHash: accepted.quoteHash,
      },
      30_000,
    );
    if (requestFile) {
      const file = writeSecretFile(requestFile, JSON.stringify(request, null, 2), { force: args.has("force") });
      line(`request written to ${file} (mode 0600). Send it to ${peer.hostname} out of band.`);
    } else if (!keyFile) {
      printJson(request);
    }
  }

  if (!keyFile) {
    if (args.has("json")) printJson({ request, connected: false });
    else {
      line("");
      line("next: the provider approves it with `share approve <request.json> --cap <usd>` and hands over a key file;");
      line(`      then re-run: connect --node ${nodeRef} --key-file <0600 file> --fingerprint ${accepted.fingerprint} --quote ${accepted.quoteHash}`);
    }
    return 0;
  }
  const key = readSecretFile(keyFile, "Gateway Key");
  const provider = await api.post<any>(
    "/catalog/connect",
    {
      nodeId: nodeRef,
      key,
      id: args.one("id"),
      fingerprint: accepted.fingerprint,
      quoteHash: accepted.quoteHash,
    },
    180_000,
  );
  if (args.has("json")) {
    printJson({ connected: true, provider });
  } else {
    line(`connected ${provider.id}: ${provider.mappedCidr}:${provider.providerPort} -> 127.0.0.1:${provider.localPort}`);
    line(`status ${provider.status}${provider.detail ? ` (${provider.detail})` : ""} · models ${selectedModels.join(", ")}`);
    line("the key was read from the file and is not printed; other providers were kept.");
  }
  return provider.status === "connected" ? 0 : 1;
}

function parseModelSelection(answer: string, models: any[]): string[] {
  const text = answer.trim();
  if (!text || /^all$/i.test(text)) return models.map((m) => String(m.id));
  const chosen: string[] = [];
  for (const token of text.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > models.length || from > to) fail(`selection ${token} is outside 1-${models.length}`);
      for (let i = from; i <= to; i++) chosen.push(String(models[i - 1].id));
      continue;
    }
    if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (index < 1 || index > models.length) fail(`selection ${token} is outside 1-${models.length}`);
      chosen.push(String(models[index - 1].id));
      continue;
    }
    if (!models.some((m) => String(m.id) === token)) fail(`unknown model or selection: ${token}`);
    chosen.push(token);
  }
  if (!chosen.length) fail("choose at least one model; an invalid selection is not replaced by 'all'");
  return [...new Set(chosen)];
}

function showPeer(peer: Peer): void {
  const identity = peer.identity!;
  const quote = peer.quote;
  line(`peer        ${peer.hostname} (${peer.nodeId ?? identity.keyId})`);
  line(`status      ${peer.status}`);
  line(`fingerprint ${identity.fingerprint}  (self-signed, local TOFU)`);
  line(`quote       v${quote.publication?.version ?? "?"} · hash ${peer.quoteHash ?? "?"}`);
  line(
    `billing     priceVersion ${quote.billing?.priceVersion ?? "UNPRICED"} · priceLocked ${String(quote.billing?.priceLocked ?? false)}`,
  );
  line(`address     ${peer.mappedCidr}:${quote.node?.gatewayPort ?? 3425} · catalogue port ${peer.catalogPort ?? quote.node?.catalogPort ?? "?"}`);
  line(`models      ${(quote.models ?? []).length}`);
  for (const m of quote.models ?? []) line(`  - ${m.id}  ${priceText(m.pricing)}`);
}

function printPeerList(peers: Peer[]): void {
  if (!peers.length) {
    line("no catalogue peers. Enable discovery and wait for a refresh, or connect with a mapped CIDR + key.");
    return;
  }
  for (const [i, p] of peers.entries()) {
    line(
      `  ${String(i + 1).padStart(2)}. ${p.hostname}  ${p.mappedCidr ?? "no export"}:${p.quote?.node?.gatewayPort ?? "?"}` +
        `  ${p.status}  fp=${p.identity?.fingerprint ?? "—"}  quote=${p.quote?.publication?.version ?? "—"}` +
        `${p.detail ? `  ${p.detail}` : ""}`,
    );
  }
}

function findPeer(peers: Peer[], wanted: string): Peer | undefined {
  return peers.find(
    (p) =>
      p.nodeId === wanted ||
      p.identity?.keyId === wanted ||
      p.hostname === wanted ||
      p.identity?.fingerprint === wanted,
  );
}
