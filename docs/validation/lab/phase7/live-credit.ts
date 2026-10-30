// Real testnet reads -> real Ledger/Provisioner -> portable Magpie 0.1.2038.
// LAB ONLY. Replays the ORIGINAL pre-payment intents into a fresh isolated
// database, re-signing the same documents with the same throwaway wallet.
// No payment, deployment, block, receipt or finality response is fabricated.
// No chain write occurs. The model upstream is deterministic and NON-BILLABLE.
// This proves integration/replay, not a fresh payment created after provisioning.
//
// MAGPIE_DATA=<new portable data> MAGPIE_BIN=<portable binary> \
// MAGPIE_ADDR=127.0.0.1:3447 LAB_INPUTS=<inputs.json> \
// LAB_CONSUMER_KEY_FILE=<throwaway key> LAB_REPORT=<report.json> bun <this file>
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Magpie } from "../../../../plugin/src/magpie.ts";
import { Ledger } from "../../../../plugin/src/ledger.ts";
import { Provisioner, type ConsumerView } from "../../../../plugin/src/provisioner.ts";
import { Wallet } from "../../../../plugin/src/wallet.ts";
import { ChainStore } from "../../../../plugin/src/chainstore.ts";
import { DEFAULT_NETWORKS, NetworkRegistry, NETWORK_REGISTRY_VERSION } from "../../../../plugin/src/networks.ts";
import { EvmClient } from "../../../../plugin/src/evm.ts";
import { intentDigest } from "../../../../plugin/src/deposits.ts";
import { priceSnapshot, usdToNanos } from "../../../../plugin/src/pricing.ts";
import type { CreditSink } from "../../../../plugin/src/watcher.ts";
import { writeJsonAtomic } from "../../../../plugin/src/store.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}
const data = realpathSync(env("MAGPIE_DATA"));
const bin = realpathSync(env("MAGPIE_BIN"));
const root = dirname(data);
// Refuse an installed/old lab: this run requires a newly created portable copy.
if (!root.startsWith("/private/tmp/phase7-live-magpie-") && !root.startsWith("/tmp/phase7-live-magpie-")) throw new Error("a fresh /tmp/phase7-live-magpie-* lab is required");
if (resolve(dirname(dirname(dirname(dirname(bin)))) + "/data") !== data) throw new Error("binary and data must belong to the same portable lab");
if (!existsSync(join(root, ".portable"))) throw new Error("missing portable marker");
const addr = env("MAGPIE_ADDR");
if (!/^127\.0\.0\.1:\d+$/.test(addr)) throw new Error("the lab gateway must be loopback-only");
process.env.MAGPIE_NO_ACCOUNTS = "1";
process.env.MAGPIE_TRUST_PROXY = "0";
process.chdir(data);
const input = JSON.parse(readFileSync(env("LAB_INPUTS"), "utf8")) as { chainId: number; txHash: string; storePath: string; invoiceId: string }[];
if (input.length !== 2 || input[0]!.chainId !== 97 || input[1]!.chainId !== 84532) throw new Error("this replay requires the original BSC and Base payments, in order");
const cast = realpathSync(env("LAB_CAST_BIN"));
const castVersion = Bun.spawnSync([cast, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 }).stdout.toString();
if (!castVersion.includes("Version: 1.8.6") || !castVersion.includes("6bad0a66de7c83f7b33695044138f0f5fa4c5990")) throw new Error("the signing tool must be pinned Foundry 1.8.6");
const keyText = readFileSync(env("LAB_CONSUMER_KEY_FILE"), "utf8");
const key = /0x[0-9a-fA-F]{64}/.exec(keyText)?.[0];
if (!key) throw new Error("no throwaway consumer key in the supplied file");
const model = "labmock/lab-model";
const magpie = new Magpie(bin);
if (magpie.version() !== "magpie 0.1.2038") throw new Error("this lab pins Magpie 0.1.2038");
const provider = magpie.providerById("labmock");
if (!provider?.chat?.startsWith("http://127.0.0.1:19081/")) throw new Error("only the non-billable local mock upstream is allowed");
const steps: { name: string; status: "VERIFIED" | "UNKNOWN"; detail: unknown }[] = [];
const record = (name: string, detail: unknown) => { steps.push({ name, status: "VERIFIED", detail }); console.log(name, JSON.stringify(detail)); };
const ledger = new Ledger(join(data, "oh-my-aihub", "ledger.sqlite"));
const p = new Provisioner(magpie, { ledger, prices: async (models) => priceSnapshot(await magpie.catalogModels(), models), usageLog: () => join(data, "usage.jsonl"), drainMs: 200 });
const sink: CreditSink = {
  depositIntent: (i) => ({ created: ledger.depositIntent(i).created }),
  applyDeposit: async (i) => { await p.applyChainDeposit(i); },
  freezeConsumer: async (id, reason) => { ledger.setPaused(id, `chain-reorg: ${reason}`); await p.pauseForChain(id, reason); },
  balance: (id) => ledger.balance(id),
};
const networks = DEFAULT_NETWORKS.map((n) => ({ ...n, rpcEndpoints: [n.chainId === 97 ? "https://bsc-testnet-rpc.publicnode.com" : "https://base-sepolia-rpc.publicnode.com"] }));
const registry = new NetworkRegistry({ version: NETWORK_REGISTRY_VERSION, networks, assets: [] });
const store = new ChainStore(join(data, "oh-my-aihub", "chain.sqlite"));
// Replaying older public payments needs an explicit lookback; a brand-new
// store intentionally has no completed-scan cursor. Do not pretend otherwise.
const wallet = new Wallet({ credit: sink, registry, store, initialLookback: 20_000 });
let consumerId = "";
let secret = "";
const chainEvidence: unknown[] = [];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function call(prompt: number, completion: number, expectedStatus: number): Promise<void> {
  const res = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "local non-billable acceptance probe" }], lab_prompt_tokens: prompt, lab_completion_tokens: completion }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as Record<string, unknown>;
  record(`gateway ${expectedStatus}`, { status: res.status, body, retryAfter: res.headers.get("retry-after"), limitReset: res.headers.get("x-magpie-limit-reset") });
  check(res.status === expectedStatus, `expected HTTP ${expectedStatus}, got ${res.status}`);
}
async function waitUsage(expected: number): Promise<ConsumerView> {
  for (let i = 0; i < 40; i++) {
    const native = await magpie.limitStatus(secret);
    if (usdToNanos(native.limit?.cost ?? 0) === usdToNanos(expected)) {
      const status = await p.status(consumerId);
      check(!status.paused && !status.ledger?.uncertain, "accounting became uncertain or paused");
      check(usdToNanos(status.ledger?.consumedUsd ?? -1) === usdToNanos(expected), "ledger and real Magpie usage disagree");
      return status;
    }
    await Bun.sleep(100);
  }
  throw new Error(`real Magpie usage never reached ${expected}`);
}
let outcome = "UNKNOWN";
let failure: string | null = null;
try {
  const authProbes: Record<string, string>[] = [{ "X-Forwarded-For": "203.0.113.9" }, { "X-Forwarded-For": "203.0.113.9", Authorization: "Bearer invalid-lab-credential" }];
  for (const headers of authProbes) {
    const r = await fetch(`http://${addr}/v1/models`, { headers });
    await r.arrayBuffer(); check(r.status === 401, "unauthenticated remote-branch request succeeded");
  }
  record("remote authentication", { missingKey: 401, wrongKey: 401, ingress: "loopback with X-Forwarded-For, remote-key branch; no EasyTier in this run" });
  const originals = input.map((i) => {
    const source = new ChainStore(i.storePath);
    try { const intent = source.intent(i.invoiceId); check(intent, "original pre-payment intent missing"); return { ...i, intent }; }
    finally { source.close(); }
  });
  consumerId = originals[0]!.intent.consumerId;
  check(originals.every((i) => i.intent.consumerId === consumerId), "both payments must belong to one original consumer");
  const issued = await p.ensure(consumerId, { models: [model], capUsd: 0.0001 });
  secret = p.find(consumerId)!.secret;
  const keyId = issued.keyId;
  record("bootstrap", { keyId, capUsd: issued.capUsd, ledger: issued.ledger, note: "explicit simulated opening credit of 0.0001 test USD, not chain-funded" });
  await call(100, 0, 200);
  record("opening credit spent", await waitUsage(0.0001));
  await call(1000, 100, 429);

  for (const original of originals) {
    const { intent, chainId, txHash } = original;
    const net = registry.requireEnabledNetwork(chainId);
    const client = new EvmClient({ chainId, endpoints: net.rpcEndpoints });
    await client.verifyChain();
    const receipt = await client.receipt(txHash);
    check(receipt?.status === "0x1", "the original payment is not successful");
    const { asset } = await wallet.registerTestAsset({ chainId, contractAddress: intent.tokenContract, symbol: chainId === 97 ? "tMOCK6" : "tMOCK18", name: "Mock Test Dollar", expectedDecimals: intent.rateDecimals, nanosPerToken: intent.rateNanosPerToken, pricingNote: "fixed test rate: 1 mock token = 1 test USD" });
    check(asset.pricing.version === intent.priceVersion, "original rate version must match exactly");
    wallet.setReceivingAddress(intent.providerId, chainId, intent.recipientAddress);
    const digest = intentDigest(intent, net, asset);
    check(digest === intent.digest, "the ORIGINAL signed document must be unchanged");
    // Original timestamps/consumer/invoice/nonce/amount/rate are preserved.
    // Only the local replay's claim status is reset before verifying again.
    store.insertIntent({ ...intent, status: "requested", attributionStatus: "unsigned", payerAddress: null, digest: null });
    const signable = (await import("../../../../plugin/src/deposits.ts")).intentTypedData(intent, net, asset);
    const signed = Bun.spawnSync([cast, "wallet", "sign", "--data", JSON.stringify(signable), "--private-key", key], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const signature = signed.stdout.toString().trim();
    check(signed.exitCode === 0 && /^0x[0-9a-fA-F]{130}$/.test(signature), `throwaway wallet signing failed (exit ${signed.exitCode}, signal ${signed.signalCode})`);
    wallet.signIntent({ invoiceId: intent.invoiceId, signature, payerAddress: intent.payerAddress!, expectedPayer: intent.payerAddress });
    record(`original signed intent ${chainId}`, { invoiceId: intent.invoiceId, requestedAt: intent.requestedAt, expiresAt: intent.expiresAt, digest, payer: intent.payerAddress, txHash });
    store.rewindCursor(chainId, Math.max(0, Number(BigInt(receipt.blockNumber)) - 1), "isolated lab replay of original signed invoice and existing real payment");
    // A closed RPC on the other network must not prevent this scan.
    const other = chainId === 97 ? 84532 : 97;
    const otherEndpoints = registry.network(other)!.rpcEndpoints;
    wallet.setRpcEndpoints(other, ["http://127.0.0.1:9"]);
    const scan = await wallet.scanNow(chainId);
    wallet.setRpcEndpoints(other, otherEndpoints);
    const event = store.eventByTx(txHash).find((e) => e.invoiceId === intent.invoiceId);
    check(scan.errors.length === 0 && event?.status === "credited", `real payment did not credit: ${event?.reason ?? JSON.stringify(scan)}`);
    const booked = ledger.deposit(event.depositId!);
    check(booked?.status === "applied" && booked.amountNanos === 1_000_000_000, "expected a durable one-token credit");
    const after = await p.status(consumerId);
    check(after.keyId === keyId && p.find(consumerId)!.secret === secret, "top-up must preserve the SAME key and secret");
    check(!after.paused && !after.pending && !after.ledger?.uncertain, "credit must be confirmed, not pending");
    const native = await magpie.limitStatus(secret);
    record(`real chain -> Ledger -> same Gateway Key ${chainId}`, { scan, event, booked, status: after, native });
    chainEvidence.push({ chainId, txHash, event, booked, native });
    const cap = after.capUsd;
    store.rewindCursor(chainId, Math.max(0, event.blockNumber - 1), "live Magpie lab: deliberate duplicate scan");
    const again = await wallet.scanNow(chainId);
    check(again.credited === 0 && (await p.status(consumerId)).capUsd === cap, "rescan raised the live cap twice");
    record(`rescan ${chainId}`, { credited: again.credited, capUnchanged: cap });
    if (chainId === 97) {
      await call(1_000_000, 0, 200);
      record("BSC credit spent", await waitUsage(1.0001));
      await call(1000, 100, 429);
    } else {
      await call(1000, 100, 200);
      record("Base restored service", await waitUsage(1.0013));
    }
  }
  outcome = "VERIFIED";
} catch (e) {
  failure = String((e as Error).message).replace(/sk-[A-Za-z0-9._-]+/g, "<redacted-key>");
  console.error("UNKNOWN", failure);
} finally {
  if (consumerId) {
    await p.revoke(consumerId).catch((e) => { failure = `cleanup failed: ${String(e)}`; outcome = "UNKNOWN"; });
    const keyGone = !magpie.keyByName(`ohmyaihub-${consumerId}`);
    record("cleanup", { keyRemoved: keyGone });
    if (!keyGone) outcome = "UNKNOWN";
  }
  wallet.close(); ledger.close();
  writeJsonAtomic(env("LAB_REPORT"), { at: new Date().toISOString(), status: outcome, failure, platform: `${process.platform} ${process.arch}`, bun: Bun.version, magpie: magpie.version(), magpieSource: "8c63c5b7873c6aa7aa797aa17f481d5fa8301876", modelUpstream: "local deterministic mock; no vendor call/bill", chainWrites: 0, replay: "original pre-payment signed intents and already-finalized public testnet transfers into fresh isolated SQLite", ingress: "loopback + forwarding header; NOT a new EasyTier/P2P test", steps, chainEvidence });
}
if (outcome !== "VERIFIED") process.exit(1);
console.log(`VERIFIED real Magpie sequence 200 -> 429 -> BSC credit -> 200 -> 429 -> Base credit -> 200. ${env("LAB_REPORT")}`);
