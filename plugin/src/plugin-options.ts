// Plugin options: what Magpie hands this plugin from `plugins.json`, and the one
// rule that keeps them from overwriting what the operator set with the CLI.
//
// Magpie's page bridge (`magpie.options.set`) and `magpie plugin options <name>`
// both replace the whole options object, and `plugin.SetOptions` restarts the
// plugin host for a plugin that has a host part (ours does). So an options blob
// left in `plugins.json` must never be re-applied blindly on every boot: that is
// how a stale `networkSecret` silently reverted a later `configure --secret` and
// disconnected every peer (docs/validation/phase8-csp.md §6.1).
//
// The rule, in one paragraph: options **seed** a node that has no configuration
// yet. Once a configuration exists, the stored state wins; a change to the
// options is applied only when it is a *new* change — a digest different from the
// one this host last applied or observed — and then only as a **patch** of the
// keys that actually changed, so an untouched secret, ports or model policy are
// never re-sent over the ones the CLI set. The first time this module runs on an
// existing node (no record yet) the current options are recorded as "seen" and
// nothing is applied.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger, redact } from "./log.ts";
import { writeJsonAtomic } from "./store.ts";
import { maskSensitiveText } from "./page-snapshot.ts";
import { pluginRoot, statePath } from "./paths.ts";

/** What the page may change about its own presentation. Never touches the overlay. */
export interface PagePrefs {
  /** show the CLI reference and the long detail rows */
  showAdvanced?: boolean;
}

/** The options this plugin reads. Everything else in `plugins.json` is ignored. */
export interface PluginOptions {
  /** phase-3 shorthand: provider = share only, consumer = consume only */
  role?: "provider" | "consumer";
  sharingEnabled?: boolean;
  consumingEnabled?: boolean;
  networkName?: string;
  networkSecret?: string;
  peers?: string[];
  listenAddr?: string | null;
  publishedPorts?: number[];
  secureMode?: boolean;
  shareModels?: string[];
  rpcPort?: number;
  apiPort?: number;
  catalogEnabled?: boolean;
  catalogDiscovery?: boolean;
  catalogDisplayName?: string | null;
  catalogContact?: string | null;
  catalogPort?: number;
  pagePrefs?: PagePrefs;
}

/** A value that cannot be sent through `configure` unchanged. */
type Patch = Record<string, unknown>;

/**
 * The keys that describe the overlay and its two capabilities. A change to one of
 * these is what a patch may hand to `Service.configure`.
 */
export const CONFIG_KEYS = [
  "role",
  "sharingEnabled",
  "consumingEnabled",
  "networkName",
  "networkSecret",
  "peers",
  "listenAddr",
  "publishedPorts",
  "secureMode",
  "shareModels",
  "rpcPort",
  "catalogEnabled",
  "catalogDiscovery",
  "catalogDisplayName",
  "catalogContact",
  "catalogPort",
] as const;

/** The page's own preferences: recorded, but never applied to the overlay. */
export const PAGE_KEYS = ["pagePrefs"] as const;

/**
 * Everything a digest covers. A preferences-only save still counts as a save (it
 * updates the digest), it just produces an empty patch.
 */
export const DIGEST_KEYS: readonly string[] = [...CONFIG_KEYS, ...PAGE_KEYS];

/**
 * The keys the first-run wizard may seed. Sharing and consuming are here because
 * a brand-new node has no other way to choose them; once a configuration exists
 * they belong to `share on|off` / `consume on|off` and the page shows them
 * read-only.
 */
export const SEED_KEYS = [
  "role",
  "sharingEnabled",
  "consumingEnabled",
  "networkName",
  "networkSecret",
  "peers",
  "listenAddr",
  "publishedPorts",
  "secureMode",
] as const;

/**
 * How long a failed attempt with the same digest is left alone before the next
 * boot tries it again. A failure is usually the environment (EasyTier could not
 * be downloaded, no LAN address yet), not the values.
 */
export const RETRY_AFTER_MS = 2 * 60 * 1000;

/** How a record came to be, shown on the page. */
export type AppliedSource = "seed" | "patch" | "migrated";

/**
 * Where an attempt stood when the record was written. `pending` is written
 * *before* `Service.configure` is called: a crash in between leaves a record that
 * says "this was being applied", so the next boot retries instead of believing a
 * configuration that was never made.
 */
export type AppliedPhase = "pending" | "done";

/** What the host last applied (or, on migration, last observed). */
export interface AppliedRecord {
  version: 1;
  phase: AppliedPhase;
  at: string;
  /** sha256 over DIGEST_KEYS, hex */
  digest: string;
  source: AppliedSource;
  /** the config keys as they were when this record was written, for the next diff */
  applied: Patch;
  /** set when this exact digest failed to apply; the same blob is not retried */
  error?: string | null;
}

export type Decision =
  | { kind: "none"; reason: string; record?: AppliedRecord }
  | { kind: "seed"; patch: Patch; record: AppliedRecord }
  | { kind: "patch"; patch: Patch; record: AppliedRecord };

// --- reading what Magpie handed over ----------------------------------------
//
// A value this plugin cannot use is **rejected and reported**, never quietly
// rewritten: truncating a secret, clamping a name or dropping one bad port would
// hand `Service.configure` a different value than the operator saved, and the
// network would come up with a secret nobody chose.

const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
const PEER = /^(tcp|udp|ws|wss|quic|wg):\/\/[A-Za-z0-9._:-]+(:\d+)?$/;
const MAX_SECRET = 512;

export interface ParsedOptions {
  options: PluginOptions;
  /** what was refused, in the operator's words; the page shows these */
  problems: string[];
}

function str(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  return v.trim();
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * A list from an array or from the page's comma/space separated text. An entry
 * that is not a string is a problem, not something to coerce.
 */
function list(v: unknown, field: string, problems: string[]): string[] | undefined {
  let items: unknown[];
  if (Array.isArray(v)) items = v;
  else if (typeof v === "string") items = v.split(/[\s,]+/);
  else return undefined;
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" && typeof item !== "number") {
      problems.push(`${field} has an entry that is not text`);
      return undefined;
    }
    const s = String(item).trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function ports(v: unknown, problems: string[]): number[] | undefined {
  const items = list(v, "publishedPorts", problems);
  if (items === undefined) return undefined;
  const out: number[] = [];
  for (const s of items) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      problems.push(`publishedPorts: ${JSON.stringify(s)} is not a port (1-65535)`);
      return undefined;
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The options this plugin understands, plus everything it refused. Unknown keys
 * are left to Magpie: the page merges over what it read, so a key this plugin
 * does not read survives a save untouched.
 */
export function parseOptions(raw: unknown): ParsedOptions {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: PluginOptions = {};
  const problems: string[] = [];

  const role = str(o.role);
  if (role !== undefined) {
    if (role === "provider" || role === "consumer") out.role = role;
    else problems.push(`role: ${JSON.stringify(role)} is not provider or consumer`);
  }
  for (const k of ["sharingEnabled", "consumingEnabled", "secureMode", "catalogEnabled", "catalogDiscovery"] as const) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    const b = asBool(o[k]);
    if (b === undefined) problems.push(`${k}: expected true or false, got ${JSON.stringify(o[k])}`);
    else out[k] = b;
  }

  if (Object.prototype.hasOwnProperty.call(o, "networkName")) {
    const name = str(o.networkName);
    if (name === undefined) problems.push("networkName: expected text");
    else if (name && !NETWORK_NAME.test(name)) {
      problems.push(`networkName: ${JSON.stringify(name)} is not 2-63 characters of letters, digits, dot, dash or underscore`);
    } else if (name) out.networkName = name;
  }

  if (Object.prototype.hasOwnProperty.call(o, "networkSecret")) {
    const secret = typeof o.networkSecret === "string" ? o.networkSecret.trim() : undefined;
    if (secret === undefined) problems.push("networkSecret: expected text");
    else if (secret && secret.length < 8) problems.push("networkSecret: must be at least 8 characters");
    else if (secret.length > MAX_SECRET) problems.push(`networkSecret: longer than ${MAX_SECRET} characters`);
    else if (secret) out.networkSecret = secret;
  }

  const peers = list(o.peers, "peers", problems);
  if (peers !== undefined) {
    const bad = peers.filter((p) => !PEER.test(p.includes("://") ? p : `tcp://${p}`));
    if (bad.length) problems.push(`peers: ${bad.map((p) => JSON.stringify(p)).join(", ")} is not tcp://host:port`);
    else out.peers = peers;
  }

  if (Object.prototype.hasOwnProperty.call(o, "listenAddr")) {
    if (o.listenAddr === null) out.listenAddr = null;
    else {
      const listen = str(o.listenAddr);
      if (listen === undefined) problems.push("listenAddr: expected text or null");
      else if (listen.length > 64) problems.push("listenAddr: longer than 64 characters");
      else out.listenAddr = listen || null;
    }
  }

  const published = ports(o.publishedPorts, problems);
  if (published !== undefined) out.publishedPorts = published;
  const models = list(o.shareModels, "shareModels", problems);
  if (models !== undefined) out.shareModels = models;

  for (const k of ["rpcPort", "apiPort", "catalogPort"] as const) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    const n = Number(o[k]);
    const min = k === "catalogPort" ? 1024 : 1;
    if (!Number.isInteger(n) || n < min || n > 65535) {
      problems.push(`${k}: ${JSON.stringify(o[k])} is not a port (${min}-65535)`);
      continue;
    }
    out[k] = n;
  }

  for (const k of ["catalogDisplayName", "catalogContact"] as const) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    if (o[k] === null) out[k] = null;
    else {
      const text = str(o[k]);
      if (text === undefined) problems.push(`${k}: expected text or null`);
      else if (text.length > 200) problems.push(`${k}: longer than 200 characters`);
      else out[k] = text;
    }
  }

  const prefs = normalizePagePrefs(o.pagePrefs);
  if (prefs) out.pagePrefs = prefs;
  return { options: out, problems };
}

/** The options alone, for callers that only read shapes. */
export function normalizeOptions(raw: unknown): PluginOptions {
  return parseOptions(raw).options;
}

export function normalizePagePrefs(raw: unknown): PagePrefs | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: PagePrefs = {};
  const adv = asBool(o.showAdvanced);
  if (adv !== undefined) out.showAdvanced = adv;
  return Object.keys(out).length ? out : undefined;
}

// --- digest -----------------------------------------------------------------

/** Deterministic JSON: objects by sorted key, so a reordering is not a change. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** Only the keys a decision cares about, in a fixed shape. */
export function ownedOptions(options: PluginOptions, keys: readonly string[] = DIGEST_KEYS): Patch {
  const out: Patch = {};
  for (const k of keys) {
    const v = (options as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function digestOf(options: PluginOptions): string {
  return createHash("sha256").update(canonical(ownedOptions(options))).digest("hex");
}

// --- the decision -----------------------------------------------------------

/**
 * A record for these options. `pending` is written by the caller *before*
 * `Service.configure` and finished after it, so a crash in between cannot be
 * mistaken for a made configuration.
 */
export function newRecord(
  options: PluginOptions,
  source: AppliedSource,
  at: string,
  error?: string,
  phase: AppliedPhase = "done",
): AppliedRecord {
  return {
    version: 1,
    phase,
    at,
    digest: digestOf(options),
    source,
    applied: ownedOptions(options, CONFIG_KEYS),
    ...(error ? { error } : {}),
  };
}

/**
 * The same record, but keeping the configuration the *previous* record was made
 * from. Only a finished, successful `Service.configure` may advance `applied` to
 * the new options: a `pending` record (or a failed attempt) that carried the new
 * snapshot would diff to nothing after a crash, and the real patch would never be
 * applied again.
 */
export function withPreviousApplied(record: AppliedRecord, previous: AppliedRecord | null): AppliedRecord {
  return { ...record, applied: previous?.applied ?? {} };
}

/** The patch a first run seeds from; null when the options cannot configure a node yet. */
export function seedPatch(options: PluginOptions): Patch | null {
  const name = (options.networkName ?? "").trim();
  const secret = (options.networkSecret ?? "").trim();
  if (name.length < 2 || secret.length < 8) return null;
  const patch: Patch = { networkName: name, networkSecret: secret };
  for (const k of SEED_KEYS) {
    if (k === "networkName" || k === "networkSecret") continue;
    const v = (options as Record<string, unknown>)[k];
    if (v !== undefined) patch[k] = v;
  }
  return patch;
}

/**
 * The keys whose value differs from what this host last applied. A key that is
 * gone from the options is not a change: nothing here can unset a config field,
 * and treating a deletion as a change would rewrite the overlay for no reason.
 */
export function diffPatch(applied: Patch, options: PluginOptions): Patch {
  const patch: Patch = {};
  for (const k of CONFIG_KEYS) {
    const now = (options as Record<string, unknown>)[k];
    if (now === undefined) continue;
    if (canonical(now) !== canonical(applied[k])) patch[k] = now;
  }
  return patch;
}

/**
 * What to do with these options on this boot. Pure: the caller reads and writes
 * the record.
 */
export function decideOptions(input: {
  options: PluginOptions;
  configured: boolean;
  record: AppliedRecord | null;
  /** values this plugin refused; nothing is applied while any is listed */
  problems?: string[];
  now?: string;
}): Decision {
  const at = input.now ?? new Date().toISOString();
  const digest = digestOf(input.options);
  const { record, configured } = input;
  const problems = input.problems ?? [];
  // A record written before `Service.configure` that never got its final write:
  // the attempt was cut short (a crash, a kill), so the state is unknown and the
  // same values are worth another attempt.
  const unfinished = record?.phase === "pending";
  const refuse = (): Decision | null =>
    problems.length ? { kind: "none", reason: `the saved options were refused: ${problems.join("; ")}` } : null;

  if (!record) {
    if (!configured) {
      const refused = refuse();
      if (refused) return refused;
      const patch = seedPatch(input.options);
      if (!patch) {
        return { kind: "none", reason: "not enough to seed a node yet: a network name and a secret of at least 8 characters" };
      }
      return { kind: "seed", patch, record: newRecord(input.options, "seed", at) };
    }
    // First run of this rule on a node that already has a configuration: the
    // state that is serving wins, and the options are only recorded as seen.
    return {
      kind: "none",
      reason: "existing state wins on first migration: the options are recorded, never applied",
      record: newRecord(input.options, "migrated", at),
    };
  }

  if (record.digest === digest && !record.error && !unfinished) {
    // Same blob, and the last time it was seen it worked (or was only observed):
    // there is nothing to do and nothing to say.
    return { kind: "none", reason: "unchanged since this host last applied or observed it" };
  }

  // A digest that differs from the recorded one is a save somebody made after the
  // last boot: the page's Save, or `magpie plugin options <name> <json>`.
  const configPatch = diffPatch(record.applied ?? {}, input.options);
  const configChanged = Object.keys(configPatch).length > 0;
  const failure = typeof record.error === "string" && record.error ? record.error : null;
  const age = Date.parse(at) - Date.parse(record.at);
  const cooldownMs = failure && Number.isFinite(age) ? RETRY_AFTER_MS - age : 0;
  const cooling = (why: string): Decision => ({
    kind: "none",
    reason: `${why}: ${failure} (retrying the same save in ${Math.ceil(cooldownMs / 1000)}s)`,
  });

  if (!configured) {
    // A node with no configuration: seed one. The only thing worth waiting for is
    // the *same* values that just failed — a new set is tried at once.
    if (!configChanged) {
      if (!failure && !unfinished) {
        return {
          kind: "none",
          reason: "only the page's own preferences changed; the overlay is untouched",
          record: newRecord(input.options, record.source, at),
        };
      }
      if (cooldownMs > 0) return cooling("the last attempt failed");
      // cooled down: the same values are worth another attempt
    }
    const refused = refuse();
    if (refused) return refused;
    const patch = seedPatch(input.options);
    if (!patch) {
      return { kind: "none", reason: "the saved options cannot seed a node (a network name and a secret of 8+ characters are required)" };
    }
    return { kind: "seed", patch, record: newRecord(input.options, "seed", at) };
  }

  // An already-configured node: the state that is serving wins unless these options
  // name a configuration key that really changed.
  if (!configChanged) {
    return {
      kind: "none",
      reason: failure
        ? `the last attempt with these values failed: ${failure}; nothing is retried because the values did not change`
        : "only the page's own preferences changed; the overlay is untouched",
      record: newRecord(input.options, record.source, at, failure ?? undefined),
    };
  }
  const refused = refuse();
  if (refused) return refused;
  return { kind: "patch", patch: configPatch, record: newRecord(input.options, "patch", at) };
}

// --- the record on disk -----------------------------------------------------

export function appliedRecordPath(): string {
  return statePath("applied-options.json");
}

export function readAppliedRecord(file = appliedRecordPath()): AppliedRecord | null {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.version !== 1 || typeof r.digest !== "string" || typeof r.at !== "string") return null;
    const source = r.source === "seed" || r.source === "patch" || r.source === "migrated" ? r.source : "migrated";
    // A record written before this phase field existed is a finished attempt.
    const phase: AppliedPhase = r.phase === "pending" ? "pending" : "done";
    return {
      version: 1,
      phase,
      at: r.at,
      digest: r.digest,
      source,
      applied: r.applied && typeof r.applied === "object" && !Array.isArray(r.applied) ? (r.applied as Patch) : {},
      error: typeof r.error === "string" ? r.error : null,
    };
  } catch {
    // An unreadable record is not a reason to re-apply a stale blob: treat it as
    // "never seen", which makes the next boot record the current options as a
    // migration instead of writing them over the stored state.
    return null;
  }
}

export function writeAppliedRecord(record: AppliedRecord, file = appliedRecordPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // The store's atomic writer: a record half written would say "pending" for a
    // configuration that never had the chance to be made.
    writeJsonAtomic(file, record, 0o600);
  } catch (e) {
    logger.warn(`cannot write the applied-options record: ${String(e)}`);
  }
}

/**
 * The page's own view of what happened, written beside the status snapshot. The
 * page cannot fetch and cannot read the state directory, so this is the only way
 * it can say "your save was applied as a patch" or "your save is drift and was
 * not applied" without guessing.
 */
export interface PageOptionsView {
  at: string;
  digest: string;
  currentDigest: string;
  source: AppliedSource | "none";
  applied: boolean;
  drift: boolean;
  reason: string;
  error: string | null;
  /** values this plugin refused; nothing was applied */
  problems: string[];
  /** the host that wrote this file: the page compares it with the snapshot's pid */
  hostPid: number;
  hostStartedAt: string;
  networkConfigured: boolean;
  secretSet: boolean;
  nodeId: string | null;
  pagePrefs: PagePrefs;
  generatedAt: string;
}

export function pageOptionsView(input: {
  options: PluginOptions;
  record: AppliedRecord | null;
  decision: Decision;
  networkConfigured: boolean;
  secretSet: boolean;
  nodeId: string | null;
  problems?: string[];
  hostPid?: number;
  hostStartedAt?: string;
  now?: string;
}): PageOptionsView {
  const at = input.now ?? new Date().toISOString();
  const currentDigest = digestOf(input.options);
  const record = input.record;
  const applied = input.decision.kind === "seed" || input.decision.kind === "patch";
  return {
    at: record?.at ?? at,
    digest: record?.digest ?? "",
    currentDigest,
    source: record?.source ?? "none",
    applied,
    // drift = the options on disk are not what this host applied and are not a
    // save it just acted on: the page says so instead of pretending.
    drift: Boolean(record) && record!.digest !== currentDigest,
    reason:
      input.decision.kind === "none"
        ? input.decision.reason
        : `${input.decision.kind} applied from plugins.json`,
    problems: input.problems ?? [],
    hostPid: input.hostPid ?? process.pid,
    hostStartedAt: input.hostStartedAt ?? "",
    error: record?.error ?? null,
    networkConfigured: input.networkConfigured,
    secretSet: input.secretSet,
    nodeId: input.nodeId,
    pagePrefs: input.options.pagePrefs ?? {},
    generatedAt: at,
  };
}

/**
 * Free text that reaches the page (a configure failure, a decision reason) can
 * carry an absolute path, an RPC URL or an address, and the page file is readable
 * by any local account. Mask it the same way the status projection does, then
 * redact the plugin's own secrets, then bound it.
 */
export function maskPageText(text: string | null | undefined, limit = 300): string | null {
  if (!text) return null;
  const masked = maskSensitiveText(redact(String(text)));
  return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
}

/**
 * Writes `<plugin>/page/options.js`, the only channel from the host to the page.
 * Mode 0600, like `status.js`: Magpie and the plugin host run as the same user,
 * and nothing else on the machine has business reading it.
 */
export function writePageOptions(view: PageOptionsView, pageDir = join(pluginRoot(), "page")): void {
  try {
    const file = join(pageDir, "options.js");
    const safe: PageOptionsView = {
      ...view,
      reason: maskPageText(view.reason) ?? "",
      error: maskPageText(view.error),
      problems: view.problems.map((p) => maskPageText(p, 200) ?? "").filter(Boolean),
    };
    // JSON.stringify escapes `<` in no way; a value containing "</script>" could
    // end the script early, so escape the two characters that matter.
    const body = JSON.stringify(safe).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    writeFileSync(file, `// generated by the plugin host; do not edit\nwindow.__OH_MY_AIHUB_OPTIONS__ = ${body};\n`, {
      mode: 0o600,
    });
  } catch (e) {
    logger.warn(`cannot write page/options.js: ${String(e)}`);
  }
}
