#!/usr/bin/env bun
// The first-use wallet wizard.
//
// It is a separate module on purpose: `bin/ohmyaihub.ts` owns argument parsing
// and the HTTP client, and wires this function in. Everything here goes through
// the injected loopback API — this module never opens a socket, reads a key,
// signs anything or broadcasts a transaction.
//
// Safety rules it enforces:
//  - an amount is a token decimal parsed exactly into base units; there is no
//    implicit rounding and no USD inverse that could silently change the amount;
//  - no chain and no provider is ever chosen silently: a missing `--chain` or
//    `--provider` is an error in non-interactive mode, and an empty answer in
//    interactive mode;
//  - a pending request is listed before a new one is created, because two
//    identical requests make a matching transfer ambiguous;
//  - a request whose POST result is unknown (timeout, transport error) is never
//    retried blindly: the operator is told to check the request list first;
//  - the typed data comes from the host response (or is rebuilt with the
//    production EIP-712 code when resuming) and is never printed empty;
//  - creating a request without a signature is a success that says
//    "awaiting signature", and nothing is sent before a signature is recorded;
//  - the wizard only reports success when the view model can prove the credit
//    applied to the key AND was read back from Magpie.

import { readFileSync } from "node:fs";
import { decodeSignatureText } from "../src/wallet-workflows.ts";
import type { WalletStatus } from "../src/wallet.ts";
import type { WalletViewInput } from "../src/walletview.ts";
import { accountingLine, journeyLines, walletView } from "../src/walletview.ts";
import { formatTokenAmount, parseTokenAmount, usdForRaw } from "../src/walletamount.ts";
import { intentDigest, intentTypedData, type DepositIntent } from "../src/deposits.ts";
import type { AssetRecord, NetworkRecord } from "../src/networks.ts";

export interface WizardApi {
  get(path: string): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
}

export interface WizardIO {
  prompt(question: string, opts?: { default?: string }): Promise<string>;
  print(line: string): void;
}

export interface WizardDeps {
  api: WizardApi;
  io: WizardIO;
  argv?: string[];
  now?: () => Date;
  /** no-op in tests; used between status polls */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Host-supplied evidence (ledger deposits + gateway read-backs). The CLI must
   * pass `() => api.get("/wallet/evidence")`. Without it the wizard can show
   * request/event state but can never prove a credit landed.
   */
  evidence?: () => Promise<WalletViewInput | null>;
  /** how many status polls before giving up */
  attempts?: number;
}

/**
 * An API failure. `status === null` means the outcome is unknown (timeout,
 * connection reset, no response). The CLI adapter must map transport failures to
 * that, and must not map an HTTP 4xx/5xx to it.
 */
export class WizardApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "WizardApiError";
  }
}

interface IntentRecord extends DepositIntent {}

interface ConsumerRecordView {
  consumerId: string;
  models: string[];
  paused: { reason: string; enforcement: string; enforced: boolean; detail: string } | null;
  revokedAt: string | null;
}

const TERMINAL = new Set(["unclaimed", "uncertain", "reverted", "manual-review", "failed", "cancelled", "expired"]);

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function usdLine(raw: string, decimals: number, nanosPerToken: string): string {
  try {
    const usd = usdForRaw({ raw, decimals, nanosPerToken });
    return `≈ ${usd.toFixed(6)} test USD at the recorded test rate`;
  } catch {
    return "USD value unavailable at the recorded test rate";
  }
}

function signatureFromFile(path: string): { signature: string; payerAddress: string | null } {
  return decodeSignatureText(readFileSync(path, "utf8"));
}

function validSignature(value: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(value);
}

export async function runWalletWizard(deps: WizardDeps): Promise<number> {
  const { api, io } = deps;
  const argv = deps.argv ?? [];
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nonInteractive = has(argv, "non-interactive") || has(argv, "batch");

  const ask = async (question: string): Promise<string | null> => {
    if (nonInteractive) return null;
    return (await io.prompt(question)).trim();
  };

  // 1. Is there a wallet at all?
  let wallet: WalletStatus | null = null;
  try {
    wallet = (await api.get("/wallet")).wallet ?? null;
  } catch (e) {
    io.print(`Cannot read the wallet status: ${(e as Error).message}`);
    io.print("Is the plugin host running? The wizard talks only to the loopback API.");
    return 2;
  }
  if (!wallet) {
    io.print("No chain wallet on this node: no testnet is enabled, so no deposit can be requested.");
    io.print("Enable one of the peer networks first (they are equal, pick any):");
    io.print("  bun plugin/bin/ohmyaihub.ts --data <magpie config dir> wallet networks");
    io.print("  bun plugin/bin/ohmyaihub.ts --data <magpie config dir> wallet network <chainId> --enable");
    return 2;
  }
  if (wallet.disabled) {
    io.print("Every registered testnet is disabled on this node, so nothing is watched or credited.");
    io.print("Enable one of them: wallet network <chainId> --enable");
    return 2;
  }

  // 2. Which consumer?
  let status: any = null;
  try {
    status = await api.get("/status");
  } catch (e) {
    io.print(`Cannot read the consumers: ${(e as Error).message}`);
    return 2;
  }
  const consumers: ConsumerRecordView[] = Array.isArray(status?.consumers) ? status.consumers : [];
  if (!consumers.length) {
    io.print("There is no consumer yet. Create the key and its opening credit first:");
    io.print("  bun plugin/bin/ohmyaihub.ts --data <magpie config dir> consumers add <id> <model[,model]> <capUsd>");
    return 2;
  }
  let consumerId = flag(argv, "consumer");
  if (!consumerId) {
    io.print("Consumers:");
    consumers.forEach((c, i) => io.print(`  ${i + 1}) ${c.consumerId}${c.paused ? `  (paused: ${c.paused.reason})` : c.revokedAt ? "  (revoked)" : ""}`));
    const answer = await ask("Consumer id or number");
    if (answer === null || answer === "") {
      io.print("A consumer is required: pass --consumer <id>.");
      return 2;
    }
    consumerId = /^\d+$/.test(answer) ? consumers[Number(answer) - 1]?.consumerId ?? answer : answer;
  }
  const consumer = consumers.find((c) => c.consumerId === consumerId);
  if (!consumer) {
    io.print(`No consumer ${consumerId}.`);
    return 2;
  }
  if (consumer.revokedAt) {
    io.print(`${consumer.consumerId} is revoked; a new key needs a new consumer id.`);
    return 1;
  }

  // 3. Existing requests, before a second one is created. A resume (`--invoice`)
  // is not a creation and must not be blocked by its own pending request.
  const resumeId = flag(argv, "invoice");
  let intents: IntentRecord[] = [];
  try {
    intents = (await api.get(`/wallet/intents?consumerId=${encodeURIComponent(consumer.consumerId)}`)).intents ?? [];
  } catch (e) {
    io.print(`Cannot read the existing requests: ${(e as Error).message}`);
    return 2;
  }
  const pending = intents.filter((i) => ["requested", "signed"].includes(i.status) && Date.parse(i.expiresAt) > now().getTime());
  if (pending.length && !resumeId) {
    io.print("This consumer already has pending deposit requests:");
    for (const p of pending) {
      io.print(
        `  ${p.invoiceId}  chain ${p.chainId}  ${p.expectedAmountRaw} base units  ${p.status}/${p.attributionStatus}` +
          `  payer ${p.payerAddress ?? "unsigned"}  expires ${p.expiresAt}`,
      );
    }
    io.print("Two identical requests make a matching transfer ambiguous (the plugin will not guess).");
    if (!has(argv, "force")) {
      const answer = (await ask("Create another request anyway? [y/N]"))?.toLowerCase() ?? "n";
      if (answer !== "y" && answer !== "yes") {
        io.print("Nothing was created. Review or cancel the pending request first:");
        io.print(`  wallet intents ${consumer.consumerId}`);
        io.print("  wallet cancel <invoiceId> --reason <text>");
        return 1;
      }
    }
  }

  if (consumer.paused) {
    io.print(
      `${consumer.consumerId} is paused: ${consumer.paused.reason} (${consumer.paused.enforcement}${consumer.paused.enforced ? "" : ", NOT stopped"}).`,
    );
    io.print("A chain deposit is still booked while paused, but it only becomes usable after `consumers reissue`.");
    io.print("A top-up does not unpause the key.");
    if (!resumeId && !has(argv, "force")) {
      const answer = (await ask("Continue and create a request anyway? [y/N]"))?.toLowerCase() ?? "n";
      if (answer !== "y" && answer !== "yes") return 1;
    }
  }

  // 4-6. Resume the request named by --invoice, or choose a network and create
  // one. A resume never re-selects a chain, a provider or an asset: the request
  // already fixed all of them.
  let created: IntentRecord;
  let typedData: unknown;
  let digest: string | null = null;

  const resumeIntent = resumeId ? intents.find((i) => i.invoiceId === resumeId) : undefined;
  if (resumeId && !resumeIntent) {
    io.print(`No request ${resumeId} for ${consumer.consumerId}.`);
    return 2;
  }
  if (resumeIntent && ["cancelled", "expired", "void"].includes(resumeIntent.status)) {
    io.print(`Request ${resumeId} is ${resumeIntent.status}; create a new one.`);
    return 1;
  }

  if (resumeIntent) {
    created = resumeIntent;
    const network = networkRecord(wallet, resumeIntent.chainId);
    const assetRecord = assetRecordById(wallet, resumeIntent.assetId);
    typedData = intentTypedData(resumeIntent, network, assetRecord);
    digest = intentDigest(resumeIntent, network, assetRecord);
    io.print(`Resuming ${resumeIntent.invoiceId} (${resumeIntent.status}/${resumeIntent.attributionStatus}) on chain ${resumeIntent.chainId}.`);
    io.print(`  signed   ${resumeIntent.payerAddress ?? "no"}`);
    io.print(`  expires  ${resumeIntent.expiresAt}`);
    io.print(
      `  amount   ${formatTokenAmount(resumeIntent.expectedAmountRaw, assetRecord.decimals)} ${assetRecord.symbol} = ${resumeIntent.expectedAmountRaw} base units`,
    );
    if (resumeIntent.payerAddress) {
      io.print("This request is already signed; the wizard will not ask for a signature again.");
    } else {
      io.print("Sign this EIP-712 document with the wallet that will pay:");
      io.print(JSON.stringify(typedData, null, 2));
      io.print(`digest ${digest}`);
    }
  } else {
    // Which network? Both networks are peers; nothing is pre-selected. The
    // provider is never taken from the first receiving address either.
    let providerId = flag(argv, "provider");
    if (!providerId) {
      const providers = [...new Set(wallet.receiving.map((r) => r.providerId))].sort();
      if (providers.length) io.print(`Providers with a receiving address: ${providers.join(", ")}`);
      const answer = await ask("Provider id (the receiving address owner)");
      if (answer === null || answer === "") {
        io.print("A provider id is required: pass --provider <id>. Nothing is chosen silently.");
        return 2;
      }
      providerId = answer;
    }
    const options = wallet.registry.networks
      .filter((n) => n.enabled)
      .map((n) => {
        const assets = wallet!.registry.assets.filter((a) => a.chainId === n.chainId && a.enabled);
        const receiving = wallet!.receiving.find((r) => r.providerId === providerId && r.chainId === n.chainId);
        const why = !assets.length ? "no enabled test asset" : !receiving ? `no receiving address for ${providerId}` : null;
        return { network: n, assets, receiving, why };
      });
    const usable = options.filter((o) => o.why === null);
    if (!usable.length) {
      io.print("No network can receive a deposit yet:");
      for (const o of options) io.print(`  chain ${o.network.chainId} ${o.network.displayName}: ${o.why}`);
      io.print("Register a test asset and a receiving address first (see `wallet asset-register` and `wallet receiving`).");
      return 2;
    }
    io.print("Networks (equal peers, no default):");
    options.forEach((o, i) => {
      io.print(
        `  ${i + 1}) chain ${o.network.chainId} ${o.network.displayName} — ${o.network.networkType} — finality ${o.network.finality.mode}` +
          `${o.network.finality.confirmations ? `(${o.network.finality.confirmations})` : ""} — ` +
          (o.why ? `unavailable: ${o.why}` : o.assets.map((a) => `${a.symbol} (${a.decimals} decimals)`).join(", ")),
      );
    });
    let chainIdText = flag(argv, "chain");
    if (chainIdText === undefined) {
      chainIdText = (await ask("Chain number or chain id")) ?? undefined;
      if (chainIdText === undefined || chainIdText === "") {
        io.print("A chain is required: pass --chain <chainId>. There is no default chain.");
        return 2;
      }
    }
    const chainId =
      /^\d+$/.test(chainIdText) && Number(chainIdText) >= 1 && Number(chainIdText) <= options.length
        ? options[Number(chainIdText) - 1]!.network.chainId
        : Number(chainIdText);
    const chosen = usable.find((o) => o.network.chainId === chainId);
    if (!chosen) {
      io.print(`Chain ${chainIdText} cannot receive a deposit right now.`);
      return 1;
    }

    // Which asset? Only an ambiguous list needs a choice; a single asset is not
    // a "default", it is the only option.
    let asset = chosen.assets[0]!;
    if (chosen.assets.length > 1) {
      io.print("Test assets on this chain:");
      chosen.assets.forEach((a, i) => io.print(`  ${i + 1}) ${a.symbol} (${a.decimals} decimals) ${a.contractAddress}`));
      const wanted = flag(argv, "asset");
      let answer = wanted;
      if (answer === undefined) {
        const typed = await ask("Asset id, symbol or number");
        if (typed === null || typed === "") {
          io.print("This chain has several assets; pass --asset <assetId|symbol>.");
          return 2;
        }
        answer = typed;
      }
      const byIndex = /^\d+$/.test(answer) ? chosen.assets[Number(answer) - 1] : undefined;
      const found =
        byIndex ??
        chosen.assets.find((a) => a.assetId.toLowerCase() === answer!.toLowerCase()) ??
        chosen.assets.find((a) => a.symbol.toLowerCase() === answer!.toLowerCase()) ??
        chosen.assets.find((a) => a.contractAddress.toLowerCase() === answer!.toLowerCase());
      if (!found) {
        io.print(`No such asset: ${answer}`);
        return 1;
      }
      asset = found;
    } else if (flag(argv, "asset") && flag(argv, "asset") !== asset.assetId && flag(argv, "asset") !== asset.symbol) {
      io.print(`Chain ${chosen.network.chainId} only has ${asset.symbol} (${asset.assetId}).`);
      return 1;
    }

    // Amount, exactly.
    let amountText = flag(argv, "amount");
    if (amountText === undefined) {
      io.print(`The transfer must be exactly one amount; any other amount does not match and stays unclaimed.`);
      const typed = await ask(`Amount in ${asset.symbol} (${asset.decimals} decimals)`);
      if (typed === null || typed === "") {
        io.print("An amount is required: pass --amount <token amount>.");
        return 2;
      }
      amountText = typed;
    }
    const parsed = parseTokenAmount(String(amountText), asset.decimals);
    if (!parsed.ok) {
      io.print(`Refused: ${parsed.reason}`);
      return 1;
    }
    const ttlSec = flag(argv, "ttl") ? Number(flag(argv, "ttl")) : 3600;
    io.print(
      `Request: ${parsed.normalised} ${asset.symbol} — raw ${parsed.raw} base units — ${usdLine(parsed.raw, asset.decimals, asset.nanosPerToken)}`,
    );
    io.print(
      `Recipient: ${chosen.receiving!.address} on chain ${chosen.network.chainId} (${chosen.network.displayName}), asset ${asset.assetId}`,
    );
    if (!has(argv, "yes") && !nonInteractive) {
      const ok = (await ask("Create this deposit request? [Y/n]"))?.toLowerCase() ?? "y";
      if (ok === "n" || ok === "no") {
        io.print("Nothing was created.");
        return 1;
      }
    }

    // Create it. An unknown outcome is never retried blindly.
    let response: any;
    try {
      response = await api.post("/wallet/intent", {
        providerId,
        consumerId: consumer.consumerId,
        chainId: chosen.network.chainId,
        assetId: asset.assetId,
        amountRaw: parsed.raw,
        ttlSec,
      });
    } catch (e) {
      const err = e as WizardApiError;
      if (err instanceof WizardApiError && err.status === null) {
        io.print(`The request may or may not have been created: ${err.message}`);
        io.print("Do NOT retry blindly. Check first, then cancel the duplicate if it exists:");
        io.print(`  wallet intents ${consumer.consumerId}`);
        io.print("  wallet cancel <invoiceId> --reason duplicate");
        return 3;
      }
      io.print(`The request was refused: ${(e as Error).message}`);
      return 1;
    }
    if (!response?.intent || typeof response.intent !== "object") {
      io.print("The host returned no intent; refusing to continue with an unknown request id.");
      return 2;
    }
    created = response.intent as IntentRecord;
    typedData = response.typedData;
    digest = typeof response.digest === "string" ? response.digest : null;
    io.print("");
    io.print(response.summary ? String(response.summary) : `Created ${created.invoiceId}.`);
    io.print(`invoice ${created.invoiceId}`);
    io.print(`expires ${created.expiresAt}`);
    if (!typedData || typeof typedData !== "object") {
      io.print("The host did not return the EIP-712 typed data; refusing to show an empty document.");
      io.print(`Run \`wallet intents ${consumer.consumerId}\` and inspect ${created.invoiceId} before signing anything.`);
      return 2;
    }
    io.print("Sign this EIP-712 document with the wallet that will pay:");
    io.print(JSON.stringify(typedData, null, 2));
    if (digest) io.print(`digest ${digest}`);
  }

  // 7. The external signature comes back here. No key is handled.
  let signature: string | null = null;
  let payer: string | null = null;
  if (created.payerAddress) {
    payer = created.payerAddress;
  } else {
    const sigFlag = flag(argv, "signature");
    const fileFlag = flag(argv, "signature-file");
    if (sigFlag) signature = sigFlag;
    if (fileFlag) {
      const fromFile = signatureFromFile(fileFlag);
      signature = fromFile.signature;
      payer = fromFile.payerAddress;
    }
    const payerFlag = flag(argv, "payer");
    if (payerFlag) payer = payerFlag;

    if (!signature) {
      const typed = await ask("Signature (0x…), or empty to sign later");
      if (typed) signature = typed;
    }
    if (!payer) {
      const typed = await ask("Payer address (the one that produced the signature)");
      if (typed) payer = typed;
    }
    if (!signature) {
      io.print("");
      io.print("AWAITING SIGNATURE — the request exists and nothing was signed.");
      io.print("Nothing must be sent before a signature is recorded: an unsigned transfer is unclaimed and is never credited.");
      io.print("Resume with the signature later:");
      io.print(`  wallet wizard --consumer ${consumer.consumerId} --invoice ${created.invoiceId} --signature <0x…> --payer <0x…>`);
      return 0;
    }
    if (!validSignature(signature)) {
      io.print("Refused: a signature is 65 bytes of hex (0x + 130 hex characters). Nothing was submitted.");
      return 1;
    }
    if (!payer) {
      io.print("A payer address is required: it is the address the plugin recovers from your signature.");
      return 2;
    }
    try {
      await api.post("/wallet/intent/sign", { invoiceId: created.invoiceId, signature, payerAddress: payer });
      io.print("Signature verified and recorded.");
    } catch (e) {
      io.print(`The signature was refused: ${(e as Error).message}`);
      io.print("Nothing was credited. Do not send the transfer until a signature over this request is accepted.");
      return 1;
    }
  }

  // 8. Payment instructions, exact.
  const payAsset = assetRecordById(wallet, created.assetId);
  io.print("");
  io.print("Send exactly this transfer, from the signing wallet:");
  io.print(`  chain      ${created.chainId} (${networkRecord(wallet, created.chainId).displayName})`);
  io.print(`  token      ${payAsset.symbol} at ${payAsset.contractAddress} (${payAsset.decimals} decimals)`);
  io.print(`  amount     ${formatTokenAmount(created.expectedAmountRaw, payAsset.decimals)} ${payAsset.symbol} = ${created.expectedAmountRaw} base units`);
  io.print(`  recipient  ${created.recipientAddress}`);
  io.print(`  expires    ${created.expiresAt}`);
  io.print("If you send a different amount, a different token or from a different wallet, the transfer is unclaimed.");

  // 9. Watch. Success is only claimed with evidence.
  if (has(argv, "no-watch")) {
    io.print(`Later: wallet intents ${consumer.consumerId}, or wallet scan ${created.chainId}.`);
    return 0;
  }
  if (!deps.evidence) {
    // The plain CLI API cannot prove the ledger deposit or the gateway read-back,
    // so it must not fake a success. One status read is shown, then it stops.
    const fallback = await localInput(api, wallet, consumer.consumerId);
    const journey = walletView(fallback).deposits.find((d) => d.invoiceId === created.invoiceId);
    if (journey) for (const line of journeyLines(journey)) io.print(line);
    io.print(
      "This CLI has no wallet evidence source, so it cannot prove the ledger deposit and the gateway read-back. " +
        "The host must expose GET /wallet/evidence on the authenticated loopback API (see docs/validation/phase8-wallet-ux.md).",
    );
    io.print("A credit is never called usable without that evidence.");
    return 1;
  }
  const attempts = Math.max(1, deps.attempts ?? 6);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const input = await deps.evidence();
    if (!input) {
      io.print("The host returned no wallet evidence; the wizard will not call the key usable.");
      return 1;
    }
    const view = walletView(input);
    const journey = view.deposits.find((d) => d.invoiceId === created.invoiceId);
    if (!journey) {
      io.print(`(${attempt}/${attempts}) the request is not in the wallet view yet; waiting…`);
      await sleep(5000);
      continue;
    }
    io.print("");
    io.print(`(${attempt}/${attempts})`);
    for (const line of journeyLines(journey)) io.print(line);
    const account = view.consumers.find((c) => c.consumerId === consumer.consumerId);
    if (account) io.print(`accounting: ${accountingLine(account)}`);
    if (journey.keyUsable) {
      io.print("Done: the credit is applied to the key and its cap was read back from Magpie.");
      return 0;
    }
    if (TERMINAL.has(journey.state)) {
      io.print("This request needs a human decision; the wizard stops here and does not retry anything.");
      return 1;
    }
    if (attempt < attempts) await sleep(5000);
  }
  io.print("Still in progress. Nothing is lost: re-run `wallet` or the journey later. Do not resend the transfer.");
  return 1;
}

/** A full `NetworkRecord` built from the status view, for the production EIP-712 code. */
function networkRecord(wallet: WalletStatus, chainId: number): NetworkRecord {
  const n = wallet.registry.networks.find((x) => x.chainId === chainId);
  if (!n) throw new Error(`chain ${chainId} is not in the wallet view`);
  return {
    chainId: n.chainId,
    displayName: n.displayName,
    family: "evm",
    networkType: n.networkType as NetworkRecord["networkType"],
    support: "credit",
    receivable: false,
    rpcEndpoints: [...n.endpoints],
    blockExplorer: n.blockExplorer,
    nativeSymbol: "",
    nativeDecimals: 18,
    enabled: n.enabled,
    finality: {
      mode: n.finality.mode as NetworkRecord["finality"]["mode"],
      confirmations: n.finality.confirmations,
      reorgDepth: n.finality.confirmations,
      rationale: n.finality.rationale,
    },
    scanIntervalSec: 0,
    maxBlockRange: 0,
    notes: null,
    evidence: null,
  };
}

/** A full `AssetRecord` built from the status view, for the production EIP-712 code. */
function assetRecordById(wallet: WalletStatus, assetId: string): AssetRecord {
  const a = wallet.registry.assets.find((x) => x.assetId === assetId);
  if (!a) throw new Error(`asset ${assetId} is not in the wallet view`);
  return {
    assetId: a.assetId,
    chainId: a.chainId,
    contractAddress: a.contractAddress,
    symbol: a.symbol,
    name: a.name,
    decimals: a.decimals,
    issuerType: a.issuerType as AssetRecord["issuerType"],
    testnetOnly: a.testnetOnly,
    credit: true,
    enabled: a.enabled,
    pricing: { nanosPerToken: a.nanosPerToken, version: a.priceVersion, kind: "fixed-test-rate", note: "" },
    evidence: null,
  };
}

/**
 * The fallback when the host supplies no evidence. It can show the request and
 * event states, but it cannot prove the deposit applied or the cap read back, so
 * the resulting view deliberately reports `unproven`.
 */
async function localInput(api: WizardApi, wallet: WalletStatus, consumerId: string): Promise<WalletViewInput> {
  const [fresh, status] = await Promise.all([api.get("/wallet"), api.get("/status")]);
  const consumers = Array.isArray(status?.consumers) ? status.consumers : [];
  return {
    wallet: (fresh.wallet as WalletStatus) ?? wallet,
    consumers,
    deposits: {},
    readbacks: {},
    accounting: null,
  };
}

/** Exported for the CLI's `wallet statement` helper: exact formatting. */
export function amountLine(raw: string, decimals: number): string {
  return `${formatTokenAmount(raw, decimals)} (${raw} base units)`;
}
