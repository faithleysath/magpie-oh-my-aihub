// `share setup`, `share list` and `share status`.
//
// Sharing has three different jobs and they must not be collapsed:
//   1. choose native models that actually exist and have a complete price;
//   2. optionally publish the signed catalogue (priceLocked is always false);
//
// The CLI never invents a model, a price, a cap or a key. It asks the service for
// the candidates and reuses the existing `/share/models` path.

import { catalogPriceVersion } from "../src/pricing.ts";
import {
  OperatorApi,
  boolFlag,
  defaultWizardIO,
  fail,
  line,
  listFlag,
  parseArgs,
  printJson,
  type WizardIO,
} from "./operator-lib.ts";
import type { ShareCandidate, ShareCandidatesView } from "../src/service.ts";

const USAGE = `usage:
  ohmyaihub share setup [--models a,b|--all-priced] [--enable-sharing]
    [--publish|--no-publish] [--display-name <name>] [--contact <text>] [--json]
  ohmyaihub share list [--json]
  ohmyaihub share status [--json]`;

export async function runShare(argv: string[], dataDir: string, io: WizardIO = defaultWizardIO()): Promise<number> {
  const first = argv[0];
  const sub = first && !first.startsWith("--") ? first : undefined;
  const args = parseArgs(sub ? argv.slice(1) : argv);
  if (args.has("help") || !sub) {
    line(USAGE);
    return args.has("help") ? 0 : 2;
  }
  const api = new OperatorApi({ dataDir, timeoutMs: args.one("timeout-ms") ? Number(args.one("timeout-ms")) : 180_000 });
  switch (sub) {
    case "setup":
      return shareSetup(api, args, io);
    case "list":
    case "status":
      return shareList(api, args);
    default:
      line(USAGE);
      fail(`unknown share command: ${sub}`);
  }
}

function priceText(pricing: ShareCandidate["pricing"]): string {
  if (!pricing || typeof pricing.input !== "number" || typeof pricing.output !== "number") return "NO COMPLETE PRICE";
  const cache =
    typeof pricing.cacheRead === "number" || typeof pricing.cacheWrite === "number"
      ? ` · cache ${pricing.cacheRead ?? "?"}/${pricing.cacheWrite ?? "?"}`
      : "";
  return `$${pricing.input}/$${pricing.output} per 1M in/out${cache}`;
}

function priced(models: ShareCandidate[]): ShareCandidate[] {
  return models.filter((m) => m.allowedByPolicy && m.completePrice);
}

function parseSelection(answer: string, models: ShareCandidate[], defaultItems: ShareCandidate[]): string[] {
  const text = answer.trim();
  if (!text) return defaultItems.map((m) => m.id);
  if (/^all$/i.test(text)) return models.filter((m) => m.allowedByPolicy && m.completePrice).map((m) => m.id);
  const tokens = text.split(/[,\s]+/).filter(Boolean);
  const chosen: ShareCandidate[] = [];
  for (const token of tokens) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > models.length || from > to) fail(`selection ${token} is outside 1-${models.length}`);
      for (let i = from; i <= to; i++) chosen.push(models[i - 1]);
      continue;
    }
    if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (index < 1 || index > models.length) fail(`selection ${token} is outside 1-${models.length}`);
      chosen.push(models[index - 1]);
      continue;
    }
    const byId = models.find((m) => m.id === token);
    if (!byId) fail(`unknown model or selection: ${token}`);
    chosen.push(byId);
  }
  if (!chosen.length) fail("choose at least one model; an invalid selection is not replaced by 'all'");
  for (const m of chosen) {
    if (!m.allowedByPolicy) fail(`${m.id} is outside the current sharing allow list`);
    if (!m.completePrice) fail(`${m.id} has no complete effective price; it cannot back a capped key`);
  }
  return [...new Set(chosen.map((m) => m.id))];
}

async function shareSetup(api: OperatorApi, args: ReturnType<typeof parseArgs>, io: WizardIO): Promise<number> {
  const view = await candidates(api);
  const selectable = priced(view.models);
  if (!view.models.length) fail("this node has no native models to share; add a native provider/model in Magpie first");
  if (!selectable.length) {
    fail(
      "no native model has a complete effective price, so a capped Gateway Key cannot be issued. " +
        "Set a complete price in Magpie first: " +
        view.blocking.map((b) => b.id).join(", "),
    );
  }

  const status = await api.get<any>("/status", 60_000);
  if (!status.config) fail("configure this node first: run `setup`");
  if (!status.config.sharingEnabled) {
    const enable =
      args.has("enable-sharing") ||
      (io.isTTY && /^y(es)?$/i.test((await io.prompt("Sharing is off. Share this Magpie now? [Y/n]", { default: "y" })).trim()));
    if (!enable) fail("sharing is disabled; run `share on` (or `setup --reconfigure --share`) or pass --enable-sharing");
    await api.post("/sharing", { enabled: true }, 180_000);
  }

  for (const [i, m] of view.models.entries()) {
    line(
      `  ${String(i + 1).padStart(2)}. ${m.id}  ${priceText(m.pricing)}` +
        `${m.completePrice ? "" : "  [cannot back a key]"}` +
        `${m.allowedByPolicy ? "" : "  [outside allow list]"}`,
    );
  }
  let selected = listFlag(args, "models");
  if (selected) {
    const byId = new Map(view.models.map((m) => [m.id, m]));
    for (const id of selected) {
      const m = byId.get(id);
      if (!m) fail(`${id} is not a native model on this node`);
      if (!m.allowedByPolicy) fail(`${id} is outside the current sharing allow list`);
      if (!m.completePrice) fail(`${id} has no complete effective price; it cannot back a capped key`);
    }
  } else if (args.has("all-priced")) {
    selected = selectable.map((m) => m.id);
  } else if (io.isTTY) {
    const answer = await io.prompt(
      `Select models by number/range (comma-separated), or Enter for all priced [${selectable.length}]`,
      { default: "" },
    );
    selected = parseSelection(answer, view.models, selectable);
  } else {
    selected = selectable.map((m) => m.id);
  }
  if (!selected?.length) fail("choose at least one priced native model");

  line(`selected ${selected.length} native model(s): ${selected.join(", ")}`);
  if (view.blocking.length) {
    line(`warning: ${view.blocking.length} allowed model(s) have no complete price and cannot back a key:`);
    for (const b of view.blocking) line(`  - ${b.id}: ${b.reason}`);
  }
  const after = await api.post<any>("/share/models", { models: selected }, 120_000);
  const policy = after?.config?.share?.models ?? selected;

  let publish = boolFlag(args, "publish", "no-publish");
  if (publish === undefined && io.isTTY) {
    publish = /^y(es)?$/i.test((await io.prompt("Publish the signed catalogue now? [y/N]", { default: "n" })).trim());
  }
  let displayName: string | undefined = args.one("display-name") ?? undefined;
  let contact: string | undefined = args.one("contact") ?? undefined;
  if (publish) {
    if (io.isTTY && displayName === undefined) {
      displayName = await io.prompt("Catalogue display name", {
        default: status.config.catalog?.displayName ?? status.config.hostname ?? "",
      });
    }
    if (io.isTTY && contact === undefined) {
      contact = await io.prompt("Manual contact (optional; never dialled)", {
        default: status.config.catalog?.contact ?? "",
      });
    }
    if (displayName !== undefined || contact !== undefined) {
      await api.post(
        "/catalog/configure",
        { ...(displayName !== undefined ? { displayName } : {}), ...(contact !== undefined ? { contact } : {}) },
        60_000,
      );
    }
    await api.post("/catalog/publish", { enabled: true }, 120_000);
  }

  const catalogResponse = await api.get<any>("/catalog", 30_000);
  const catalog = catalogResponse?.catalog;
  const quote = catalog?.quote ?? null;
  const checksResponse = publish ? await api.get<{ checks: any[] }>("/checks", 60_000).catch(() => ({ checks: [] })) : null;
  const quotePriceVersion =
    quote && Array.isArray(quote.models)
      ? catalogPriceVersion(quote.models.filter((m: any) => selected.includes(String(m.id))))
      : view.priceVersion;
  const quoteCoversSelection =
    Boolean(quote) &&
    Array.isArray(quote.models) &&
    selected.every((id) => quote.models.some((m: any) => String(m.id) === id));
  const readyChecks = (checksResponse?.checks ?? []).filter((c: any) => ["acl", "catalog-published", "catalog-quote", "catalog-identity"].includes(c.name));
  const checksOk =
    readyChecks.length === 4 &&
    readyChecks.every((c: any) => c.ok === true);
  const published =
    publish === true &&
    catalog?.server?.running === true &&
    Boolean(quote) &&
    /^[0-9a-f]{64}$/.test(String(quote.contentHash ?? "")) &&
    /^[0-9a-f]{64}$/.test(String(quote.identity?.fingerprint ?? "")) &&
    /^[0-9a-f]{64}$/.test(String(quotePriceVersion ?? "")) &&
    quoteCoversSelection &&
    checksOk;

  const result = {
    models: selected,
    policy,
    priceVersion: quotePriceVersion,
    priceLocked: false,
    published,
    serverRunning: catalog?.server?.running === true,
    quote: quote
      ? {
          version: quote.version ?? null,
          contentHash: quote.contentHash ?? null,
          updatedAt: quote.updatedAt ?? null,
          identityFingerprint: quote.identity?.fingerprint ?? null,
          modelCount: quote.models?.length ?? quote.modelCount ?? null,
        }
      : null,
    blocking: view.blocking,
  };
  if (args.has("json")) {
    printJson(result);
  } else {
    line(`share allow list: ${policy.join(", ")}`);
    line(
      quote
        ? `quote: v${quote.version ?? "?"} · ${quote.models?.length ?? quote.modelCount ?? 0} model(s) · hash ${String(quote.contentHash ?? "").slice(0, 16)}…`
        : "quote: not published yet",
    );
    line(`billing: priceVersion ${result.priceVersion ?? "UNPRICED"} · priceLocked false`);
    if (quote?.identity?.fingerprint) line(`catalogue identity: ${quote.identity.fingerprint} (self-signed TOFU)`);
    line(`catalogue server: ${catalog?.server?.running ? `running on ${catalog.server.address ?? "?"}` : "not running"}`);
    if (publish) {
      if (published) line("catalogue publishing verified by server + signed quote + ACL/quote checks.");
      else line("PUBLISH NOT VERIFIED: server, signed quote, model coverage or checks are incomplete; do not treat this as published.");
    } else {
      line("catalogue publishing: not requested (use --publish to opt in)");
    }
    line("");
    line("next: `share approve <request.json> --cap <usd>` for a consumer, then `share handover <id> --key-file <0600 file>`.");
  }
  return publish && !published ? 1 : 0;
}

async function candidates(api: OperatorApi): Promise<ShareCandidatesView> {
  try {
    const r = await api.get<any>("/share/candidates", 30_000);
    const view = r?.candidates ?? r;
    if (view && Array.isArray(view.models)) return view as ShareCandidatesView;
    fail("/share/candidates answered without a model list");
  } catch (e) {
    // The route is newer than the host: fall back to a published quote, which
    // contains only native, policy-filtered models but no explicit completeness
    // flag. Never invent a price; a null pricing stays blocking.
    if (!/HTTP 404/.test((e as Error).message)) throw e;
    const c = await api.get<any>("/catalog", 30_000);
    const q = c?.catalog?.quote;
    if (!q) fail("this host has no /share/candidates route and no published catalogue; update the plugin host or publish once");
    const models = (q.models ?? []).map((m: any) => ({
      id: String(m.id),
      displayName: m.displayName ?? null,
      provider: String(m.id).split("/")[0],
      pricing: m.pricing ?? null,
      completePrice: Boolean(m.pricing),
      allowedByPolicy: true,
    }));
    return {
      policy: [],
      models,
      priceVersion: catalogPriceVersion(q.models ?? []),
      priceLocked: false,
      blocking: models.filter((m: any) => !m.completePrice).map((m: any) => ({ id: m.id, reason: "no published price" })),
    };
  }
}

async function shareList(api: OperatorApi, args: ReturnType<typeof parseArgs>): Promise<number> {
  const status = await api.get<any>("/status", 60_000);
  if (args.has("json")) {
    printJson({ consumers: status.consumers ?? [], share: status.config?.share ?? null, catalog: status.catalog ?? null });
    return 0;
  }
  line(`share allow list: ${(status.config?.share?.models ?? []).join(", ") || "—"}`);
  line(`catalogue: ${status.catalog?.publishing ? "publishing" : "off"}`);
  const consumers = status.consumers ?? [];
  if (!consumers.length) line("no consumers");
  for (const c of consumers) {
    line(
      `${c.consumerId}  ${c.models?.join(",") ?? "?"}  cap $${Number(c.capUsd ?? 0).toFixed(4)}` +
        `  used $${Number(c.usedUsd ?? 0).toFixed(4)}  ${c.paused ? `paused:${c.paused.reason}` : c.revokedAt ? "revoked" : "open"}`,
    );
  }
  return 0;
}
