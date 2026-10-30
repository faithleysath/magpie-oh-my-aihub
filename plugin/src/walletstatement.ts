// The consumer statement: an out-of-band, unsigned accounting snapshot.
//
// What this is: the provider's own record for ONE consumer, in an explicit
// allowlist of fields, with a SHA-256 digest over canonical JSON. The operator
// exports it locally and hands it over however they like (file, chat, USB).
//
// What this is not:
//  - not a signature and not proof of payment. The digest only detects a hand
//    edit; a valid digest can be produced by anyone who builds the same file.
//  - not a remote lookup. There is no route, port or handler in this module, and
//    the statement is only produced for a consumer the local operator named.
//  - not a second balance. Every number comes from the ledger and the chain
//    store; nothing here recomputes credit.
//
// The consumer is expected to verify independently: the transactions on a block
// explorer, the rate/price version in the statement, and the key's own limit as
// its own Magpie reports it.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssetRecord, NetworkRecord } from "./networks.ts";
import type { ChainDepositEvent } from "./chainstore.ts";
import type { DepositIntent } from "./deposits.ts";
import type { ConsumerEvidence, KeyReadback, LedgerDepositLike } from "./walletview.ts";
import { nanosToUsd } from "./pricing.ts";
import { formatTokenAmount } from "./walletamount.ts";

export const STATEMENT_VERSION = 1;
export const STATEMENT_KIND = "oh-my-aihub.consumer-statement";

export interface StatementInput {
  providerId: string;
  consumerId: string;
  generatedAt: string;
  networks: NetworkRecord[];
  assets: AssetRecord[];
  intents: DepositIntent[];
  events: ChainDepositEvent[];
  deposits: LedgerDepositLike[];
  consumer: ConsumerEvidence | null;
  accounting: { state: "ok" | "uncertain" | "unknown"; reason: string | null; openSettlements: number };
  readback?: KeyReadback | null;
}

export interface ConsumerStatement {
  statement: {
    version: number;
    kind: string;
    generatedAt: string;
    providerId: string;
    consumerId: string;
    networks: {
      chainId: number;
      displayName: string;
      networkType: string;
      blockExplorer: string;
      finality: { mode: string; confirmations: number; rationale: string };
    }[];
    assets: { assetId: string; chainId: number; symbol: string; decimals: number; nanosPerToken: string; priceVersion: string }[];
    requests: { invoiceId: string; chainId: number; assetId: string; amountRaw: string; requestedAt: string; expiresAt: string; status: string; payerAddress: string | null }[];
    deposits: {
      chainId: number;
      assetId: string | null;
      symbol: string | null;
      amountRaw: string;
      amountTokens: string | null;
      creditedNanos: number | null;
      creditedUsd: number | null;
      txHash: string;
      logIndex: number;
      blockNumber: number;
      blockHash: string;
      status: string;
      firstSeenAt: string;
      updatedAt: string;
      finalizedAt: string | null;
      creditedAt: string | null;
      priceVersion: string | null;
      ledgerDepositId: string | null;
      ledgerStatus: string | null;
      appliedAt: string | null;
    }[];
    totals: {
      creditedUsd: number;
      appliedUsd: number;
      consumedUsd: number | null;
      balanceUsd: number | null;
      overdraftUsd: number | null;
      unsettledUsd: number | null;
      pendingDeposits: number;
      unclaimedEvents: number;
      uncertainEvents: number;
      revertedEvents: number;
    };
    key: {
      keyName: string | null;
      models: string[];
      capUsd: number | null;
      usedUsd: number | null;
      leftUsd: number | null;
      priceVersion: string | null;
      windowEnd: string | null;
      readbackAt: string | null;
      fromGateway: boolean;
      paused: string | null;
      revokedAt: string | null;
    };
    accounting: { state: string; reason: string | null; openSettlements: number };
    verify: string[];
    signed: false;
    digest: string;
    disclaimer: string;
  };
  digest: string;
}

export const STATEMENT_KEYS = [
  "version",
  "kind",
  "generatedAt",
  "providerId",
  "consumerId",
  "networks",
  "assets",
  "requests",
  "deposits",
  "totals",
  "key",
  "accounting",
  "verify",
  "signed",
  "digest",
  "disclaimer",
] as const;

const NESTED_KEYS: Record<string, readonly string[]> = {
  network: ["chainId", "displayName", "networkType", "blockExplorer", "finality"],
  finality: ["mode", "confirmations", "rationale"],
  asset: ["assetId", "chainId", "symbol", "decimals", "nanosPerToken", "priceVersion"],
  request: ["invoiceId", "chainId", "assetId", "amountRaw", "requestedAt", "expiresAt", "status", "payerAddress"],
  deposit: [
    "chainId",
    "assetId",
    "symbol",
    "amountRaw",
    "amountTokens",
    "creditedNanos",
    "creditedUsd",
    "txHash",
    "logIndex",
    "blockNumber",
    "blockHash",
    "status",
    "firstSeenAt",
    "updatedAt",
    "finalizedAt",
    "creditedAt",
    "priceVersion",
    "ledgerDepositId",
    "ledgerStatus",
    "appliedAt",
  ],
  totals: [
    "creditedUsd",
    "appliedUsd",
    "consumedUsd",
    "balanceUsd",
    "overdraftUsd",
    "unsettledUsd",
    "pendingDeposits",
    "unclaimedEvents",
    "uncertainEvents",
    "revertedEvents",
  ],
  key: ["keyName", "models", "capUsd", "usedUsd", "leftUsd", "priceVersion", "windowEnd", "readbackAt", "fromGateway", "paused", "revokedAt"],
  accounting: ["state", "reason", "openSettlements"],
};

/** Deterministic JSON: object keys sorted, arrays in the order given. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function digestOf(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

export function buildStatement(input: StatementInput): ConsumerStatement {
  if (!input.consumerId) throw new Error("a statement needs one consumer id");
  // The builder guards its own input. The caller may pass a whole store, and a
  // statement that silently includes another consumer's rows would be a data
  // leak, so mixed input is refused rather than filtered where ambiguity is
  // possible.
  if (input.consumer && input.consumer.consumerId !== input.consumerId) {
    throw new Error(`the consumer record is ${input.consumer.consumerId}, not ${input.consumerId}`);
  }
  for (const intent of input.intents) {
    if (intent.consumerId !== input.consumerId) throw new Error(`intent ${intent.invoiceId} belongs to another consumer`);
  }
  const myInvoices = new Set(input.intents.filter((i) => i.consumerId === input.consumerId).map((i) => i.invoiceId));
  for (const event of input.events) {
    if (event.invoiceId !== null && !myInvoices.has(event.invoiceId)) {
      throw new Error(`event ${event.txHash}:${event.logIndex} belongs to another consumer`);
    }
  }
  for (const deposit of input.deposits) {
    if (deposit.consumerId !== input.consumerId) throw new Error(`deposit ${deposit.id} belongs to another consumer`);
  }
  // An event with no invoice is not attributable to any consumer; it is not this
  // consumer's deposit and is never included.
  const events = input.events.filter((e) => e.invoiceId !== null && myInvoices.has(e.invoiceId));

  const networks = input.networks.map((n) => ({
    chainId: n.chainId,
    displayName: n.displayName,
    networkType: n.networkType,
    blockExplorer: n.blockExplorer,
    finality: { mode: n.finality.mode, confirmations: n.finality.confirmations, rationale: n.finality.rationale },
  }));
  const assets = input.assets.map((a) => ({
    assetId: a.assetId,
    chainId: a.chainId,
    symbol: a.symbol,
    decimals: a.decimals,
    nanosPerToken: a.pricing.nanosPerToken,
    priceVersion: a.pricing.version,
  }));
  const assetById = new Map(input.assets.map((a) => [a.assetId, a]));

  const requests = input.intents
    .filter((i) => i.consumerId === input.consumerId)
    .map((i) => ({
      invoiceId: i.invoiceId,
      chainId: i.chainId,
      assetId: i.assetId,
      amountRaw: i.expectedAmountRaw,
      requestedAt: i.requestedAt,
      expiresAt: i.expiresAt,
      status: i.status,
      payerAddress: i.payerAddress,
    }));

  const depositById = new Map(input.deposits.map((d) => [d.id, d]));
  const deposits = events.map((e) => {
    const asset = input.assets.find((a) => a.chainId === e.chainId && a.contractAddress.toLowerCase() === e.tokenContract.toLowerCase()) ?? null;
    const ledger = e.depositId ? depositById.get(e.depositId) ?? null : null;
    return {
      chainId: e.chainId,
      assetId: asset?.assetId ?? null,
      symbol: asset?.symbol ?? null,
      amountRaw: e.amountRaw,
      amountTokens: asset ? formatTokenAmount(e.amountRaw, asset.decimals) : null,
      creditedNanos: e.creditedNanos,
      creditedUsd: e.creditedNanos === null ? null : roundUsd(nanosToUsd(e.creditedNanos)),
      txHash: e.txHash,
      logIndex: e.logIndex,
      blockNumber: e.blockNumber,
      blockHash: e.blockHash,
      status: e.status,
      firstSeenAt: e.firstSeenAt,
      updatedAt: e.updatedAt,
      finalizedAt: e.finalizedAt,
      creditedAt: e.creditedAt,
      priceVersion: e.rateVersion,
      ledgerDepositId: e.depositId,
      ledgerStatus: ledger?.status ?? null,
      appliedAt: ledger?.appliedAt ?? null,
    };
  });

  const applied = input.deposits.filter((d) => d.status === "applied");
  const creditedNanos = deposits.reduce((sum, d) => sum + (d.creditedNanos ?? 0), 0);
  const totals = {
    creditedUsd: roundUsd(nanosToUsd(creditedNanos)),
    appliedUsd: roundUsd(nanosToUsd(applied.reduce((s, d) => s + d.amountNanos, 0))),
    /** settled consumption, priced by the ledger at each window's snapshot */
    consumedUsd: input.consumer?.ledger?.consumedUsd ?? null,
    balanceUsd: input.consumer?.ledger?.balanceUsd ?? null,
    overdraftUsd: input.consumer?.ledger?.overdraftUsd ?? null,
    unsettledUsd: input.consumer?.ledger?.unsettledUsd ?? null,
    pendingDeposits: input.deposits.filter((d) => d.status === "intent").length,
    // Only attributable events are counted: an unclaimed transfer belongs to no
    // consumer and is not in this statement.
    unclaimedEvents: events.filter((e) => e.status === "unclaimed").length,
    uncertainEvents: events.filter((e) => e.status === "uncertain").length,
    revertedEvents: events.filter((e) => e.status === "reverted").length,
  };

  const key = {
    keyName: input.consumer?.keyName ?? null,
    models: input.consumer ? [...input.consumer.models] : [],
    capUsd: input.readback?.capUsd ?? input.consumer?.capUsd ?? null,
    usedUsd: input.readback?.usedUsd ?? null,
    leftUsd: input.readback?.leftUsd ?? null,
    priceVersion: input.consumer?.priceVersion ?? input.consumer?.ledger?.priceVersion ?? null,
    windowEnd: input.consumer?.reset ?? input.consumer?.ledger?.reset ?? null,
    readbackAt: input.readback?.at ?? null,
    fromGateway: input.readback?.fromGateway === true,
    paused: input.consumer?.paused ? `${input.consumer.paused.reason} (${input.consumer.paused.enforcement})` : null,
    revokedAt: input.consumer?.revokedAt ?? null,
  };

  const body = {
    version: STATEMENT_VERSION,
    kind: STATEMENT_KIND,
    generatedAt: input.generatedAt,
    providerId: input.providerId,
    consumerId: input.consumerId,
    networks,
    assets,
    requests,
    deposits,
    totals,
    key,
    accounting: { ...input.accounting },
    verify: [
      "Check every transaction hash and amount on the chain's block explorer, not in this file.",
      "Recompute the credit from amountRaw, the asset decimals and the priceVersion recorded here.",
      "Compare capUsd/usedUsd/leftUsd with what your own Magpie reports for this key; they are the provider's read-back, not an independent authority.",
      "A transfer that does not match a signed request exactly (chain, token, recipient, amount, payer) is unclaimed and is not credit.",
    ],
    signed: false as const,
    digest: "",
    disclaimer:
      "Unsigned statement. The SHA-256 digest detects hand edits only; it is not a signature, not proof of payment and not an identity claim.",
  };

  // The digest covers the body *without* the digest field, so verification can
  // strip it and recompute the same value.
  const { digest: _placeholder, ...withoutDigest } = body;
  const digest = digestOf(withoutDigest);
  return { statement: { ...body, digest }, digest };
}

export function statementText(statement: ConsumerStatement): string {
  return JSON.stringify(statement.statement, null, 2);
}

/**
 * Checks the digest and the field allowlist. A statement with an unexpected
 * field is refused rather than ignored: a silently accepted extra field is how a
 * secret would travel.
 */
export function verifyStatement(input: ConsumerStatement | ConsumerStatement["statement"] | unknown): { ok: boolean; reason: string | null } {
  try {
    // Accept both the wrapper the host builds and the bare document written to
    // disk, so a consumer can verify the file exactly as received. Every access
    // is type-checked: a malformed JSON file must produce a refusal, never a
    // thrown TypeError.
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "no statement body" };
    const wrapper = input as { statement?: unknown; digest?: unknown };
    const wrapped = wrapper.statement;
    const body = (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped) ? wrapped : input) as Record<string, unknown>;
    if (body.kind !== STATEMENT_KIND) return { ok: false, reason: `not a ${STATEMENT_KIND}` };
    if (body.version !== STATEMENT_VERSION) return { ok: false, reason: `unsupported statement version ${String(body.version)}` };
    if (body.signed !== false) return { ok: false, reason: "a statement must say it is unsigned" };
    const keys = Object.keys(body);
    for (const key of keys) {
      if (!(STATEMENT_KEYS as readonly string[]).includes(key)) return { ok: false, reason: `unexpected field ${key}` };
    }
    for (const key of STATEMENT_KEYS) {
      if (!keys.includes(key)) return { ok: false, reason: `missing field ${key}` };
    }

    const requiresString = (value: unknown, label: string): string | null => {
      if (typeof value === "string") return null;
      return `${label} must be a string`;
    };
    for (const [label, value] of [
      ["generatedAt", body.generatedAt],
      ["providerId", body.providerId],
      ["consumerId", body.consumerId],
      ["digest", body.digest],
      ["disclaimer", body.disclaimer],
    ] as const) {
      const problem = requiresString(value, label);
      if (problem) return { ok: false, reason: problem };
    }
    if (!Array.isArray(body.verify) || body.verify.some((v) => typeof v !== "string")) {
      return { ok: false, reason: "verify must be a list of strings" };
    }

    const list = (value: unknown, label: string): unknown[] | null => {
      if (!Array.isArray(value)) return null;
      return value;
    };
    const object = (value: unknown, label: string): Record<string, unknown> | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return value as Record<string, unknown>;
    };
    const arrays: [string, unknown, readonly string[]][] = [
      ["networks", body.networks, NESTED_KEYS.network!],
      ["assets", body.assets, NESTED_KEYS.asset!],
      ["requests", body.requests, NESTED_KEYS.request!],
      ["deposits", body.deposits, NESTED_KEYS.deposit!],
    ];
    for (const [label, rawList, allowed] of arrays) {
      const entries = list(rawList, label);
      if (!entries) return { ok: false, reason: `${label} must be a list` };
      for (const item of entries) {
        const obj = object(item, label);
        if (!obj) return { ok: false, reason: `${label} has a non-object entry` };
        const extra = Object.keys(obj).find((k) => !allowed.includes(k));
        if (extra) return { ok: false, reason: `${label} has an unexpected field ${extra}` };
        const missing = allowed.find((k) => !(k in obj));
        if (missing) return { ok: false, reason: `${label} is missing ${missing}` };
      }
    }
    for (const network of body.networks as Record<string, unknown>[]) {
      const finality = object(network.finality, "finality");
      if (!finality) return { ok: false, reason: "network.finality must be an object" };
      const extra = Object.keys(finality).find((k) => !NESTED_KEYS.finality!.includes(k));
      if (extra) return { ok: false, reason: `finality has an unexpected field ${extra}` };
    }
    for (const [label, raw, allowed] of [
      ["totals", body.totals, NESTED_KEYS.totals!],
      ["key", body.key, NESTED_KEYS.key!],
      ["accounting", body.accounting, NESTED_KEYS.accounting!],
    ] as const) {
      const obj = object(raw, label);
      if (!obj) return { ok: false, reason: `${label} must be an object` };
      const extra = Object.keys(obj).find((k) => !(allowed as readonly string[]).includes(k));
      if (extra) return { ok: false, reason: `${label} has an unexpected field ${extra}` };
    }

    const { digest, ...withoutDigest } = body;
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, reason: "the digest is malformed" };
    const recomputed = digestOf(withoutDigest);
    if (recomputed !== digest) return { ok: false, reason: "the digest does not match the body" };
    if (wrapped && wrapper.digest !== digest) return { ok: false, reason: "the outer digest does not match the body" };
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: `unreadable statement: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
}

/**
 * Writes the statement for a local operator.
 *
 * Two shapes: `{ dir }` generates a name from the sanitised consumer id and
 * timestamp; `{ path }` writes to the exact file the operator named (the CLI's
 * `--out`). Both create exclusively (`O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, mode
 * 0600) so an existing file or a planted symlink is refused, never followed. The
 * parent directory must exist and must not be a symlink.
 */
export function writeStatementFile(statement: ConsumerStatement, opts: { dir: string } | { path: string }): { path: string } {
  const verified = verifyStatement(statement);
  if (!verified.ok) throw new Error(`refusing to write an invalid statement: ${verified.reason}`);
  const holder = statement.statement;
  if (!holder || typeof holder !== "object") throw new Error("refusing to write an invalid statement: no body");

  let target: string;
  let parent: string;
  if ("path" in opts) {
    if (typeof opts.path !== "string" || !opts.path) throw new Error("a statement path is required");
    target = opts.path;
    parent = dirname(target);
    if (!target.endsWith(".json")) throw new Error("a statement file must end with .json");
  } else {
    const safe = String(holder.consumerId).replace(/[^a-z0-9._-]/gi, "_").slice(0, 41) || "consumer";
    const stamp = String(holder.generatedAt)
      .replace(/[^0-9A-Za-z_-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 64) || "unknown";
    parent = opts.dir;
    target = join(parent, `statement-${safe}-${stamp}.json`);
  }

  if (existsSync(parent)) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${parent} is not a real directory`);
  } else if ("dir" in opts) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } else {
    throw new Error(`${parent} does not exist`);
  }

  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(target, flags, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") throw new Error(`refusing to overwrite ${target}`);
    throw e;
  }
  try {
    writeSync(fd, `${statementText(statement)}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(target, 0o600);
  return { path: target };
}
