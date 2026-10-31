#!/usr/bin/env bun
// Phase-7 local chain lab: a real ERC-20 deposit against a real EVM node.
//
// This is **not** a testnet run and the report says so. It exercises every step
// of the pipeline against `anvil` (foundry 1.8.6) with a real deployed ERC-20,
// real `eth_getLogs` output and real receipts, which is what a unit test cannot
// prove: that the decoding, the receipt check, the finality read and the ledger
// booking work against bytes a node actually produced.
//
//   mise x foundry -- anvil --port 8547 --host 127.0.0.1
//   bun scripts/chain-lab.ts --rpc http://127.0.0.1:8547 \
//        --provider-key 0x... --consumer-key 0x...
//
// The provider key is the receiving address's key (used here only to deploy the
// mock token and mine); the consumer key signs the deposit intent. Both are
// throwaway anvil keys, passed on the command line, never written to disk.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvmClient } from "../src/evm.ts";
import { ChainStore } from "../src/chainstore.ts";
import { buildIntent, intentDigest, intentTypedData, verifyIntentSignature } from "../src/deposits.ts";
import { assetIdOf, DEFAULT_NETWORKS, NetworkRegistry, NETWORK_REGISTRY_VERSION, type NetworkRecord } from "../src/networks.ts";
import { ChainWatcher, convertRawToNanos, TRANSFER_TOPIC, type CreditSink } from "../src/watcher.ts";
import { keccak256, toHex } from "../src/keccak.ts";
import { checksumAddress } from "../src/secp256k1.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const RPC = arg("rpc", "http://127.0.0.1:8547");
/**
 * Keys come from files, never from argv: a command line is visible to `ps` and
 * ends up in shell history, and this script's output is quoted into a report.
 * The files are throwaway anvil keys; they are read once and never logged.
 */
function keyFrom(flag: string): string {
  const file = arg(flag);
  const text = require("node:fs").readFileSync(file, "utf8") as string;
  const match = /0x[0-9a-fA-F]{64}/.exec(text);
  if (!match) throw new Error(`${file} holds no 32-byte private key`);
  return match[0];
}
const PROVIDER_KEY = keyFrom("provider-key-file");
const CONSUMER_KEY = keyFrom("consumer-key-file");
const TOKEN = arg("token", "");
const OUT = arg("out", "");
const DECIMALS = Number(arg("decimals", "6"));
const AMOUNT_RAW = BigInt(arg("amount", "2500000"));

const log = (...parts: unknown[]) => console.log(...parts);

/** Signs with `cast wallet sign --data`, which is the wallet behaviour being verified. */
function signTypedData(typedData: unknown, privateKey: string): string {
  const json = JSON.stringify(typedData);
  const out = Bun.spawnSync(["mise", "x", "foundry", "--", "cast", "wallet", "sign", "--data", json, "--private-key", privateKey], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = out.stdout.toString().trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(text)) throw new Error(`cast wallet sign failed: ${out.stderr.toString().slice(0, 300)}`);
  return text;
}

function run(bin: "cast" | "forge", args: string[]): string {
  const out = Bun.spawnSync(["mise", "x", "foundry", "--", bin, ...args], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    // Never echo the argv: it carries a private key.
    throw new Error(`${bin} ${args[0] ?? ""} failed: ${out.stderr.toString().slice(0, 400)}`);
  }
  return out.stdout.toString().trim();
}
const cast = (args: string[]): string => run("cast", args);
const forge = (args: string[]): string => run("forge", args);

function addressOf(privateKey: string): string {
  return cast(["wallet", "address", "--private-key", privateKey]);
}

/**
 * A chain record for the local node. It is deliberately a *third* chain, not
 * BSC or Base, which is the point: the ledger and the watcher take it as data.
 */
const LOCAL_CHAIN_ID = 31337;
const localNetwork: NetworkRecord = {
  chainId: LOCAL_CHAIN_ID,
  displayName: "Anvil (local EVM)",
  family: "evm",
  networkType: "testnet",
  support: "credit",
  receivable: false,
  rpcEndpoints: [RPC],
  blockExplorer: "",
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  enabled: true,
  finality: { mode: "confirmations", confirmations: 1, reorgDepth: 1, rationale: "a local dev chain cannot reorganise; one confirmation is the whole rule" },
  scanIntervalSec: 2,
  maxBlockRange: 5000,
  notes: "local lab only",
  evidence: null,
};

interface LabResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
}

class LedgerSink implements CreditSink {
  deposits = new Map<string, { consumerId: string; amountNanos: number; source: string }>();
  applied = new Set<string>();
  frozen: string[] = [];
  depositIntent(input: { id: string; consumerId: string; amountNanos: number; source: string }): { created: boolean } {
    if (this.deposits.has(input.id)) return { created: false };
    this.deposits.set(input.id, { consumerId: input.consumerId, amountNanos: input.amountNanos, source: input.source });
    return { created: true };
  }
  async applyDeposit(input: { id: string; consumerId: string; amountNanos: number }): Promise<void> {
    this.applied.add(input.id);
  }
  async freezeConsumer(consumerId: string, reason: string): Promise<void> {
    this.frozen.push(`${consumerId}: ${reason}`);
  }
  balance(): { depositedNanos: number; consumedNanos: number; balanceNanos: number } {
    let total = 0;
    for (const id of this.applied) total += this.deposits.get(id)?.amountNanos ?? 0;
    return { depositedNanos: total, consumedNanos: 0, balanceNanos: total };
  }
}

/** A throwaway key for one lab consumer, from foundry's own generator. */
function newKey(): string {
  const out = JSON.parse(cast(["wallet", "new", "--json"])) as { data: { private_key: string }[] };
  const key = out.data[0]?.private_key;
  if (!key) throw new Error("cast wallet new returned no key");
  return key;
}

/** Deploys the mock token and returns its address. */
function deployToken(providerKey: string): string {
  const root = join(import.meta.dir, "..", "lab", "chain");
  const out = forge([
    "create",
    "src/MockERC20.sol:MockERC20",
    "--root",
    root,
    "--rpc-url",
    RPC,
    "--private-key",
    providerKey,
    "--broadcast",
    "--constructor-args",
    "Mock Test Dollar",
    "tMOCK6",
    String(DECIMALS),
  ]);
  const line = out.split("\n").find((l) => l.startsWith("Deployed to:"));
  if (!line) throw new Error(`forge create printed no address: ${out.slice(0, 300)}`);
  return line.replace("Deployed to:", "").trim();
}

async function main(): Promise<void> {
  const steps: LabResult["steps"] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  };

  const providerAddress = checksumAddress(addressOf(PROVIDER_KEY));
  const consumerAddress = checksumAddress(addressOf(CONSUMER_KEY));
  log(`provider ${providerAddress}  consumer ${consumerAddress}  rpc ${RPC}`);

  const client = new EvmClient({ chainId: LOCAL_CHAIN_ID, endpoints: [RPC] });
  await client.verifyChain();
  record("rpc chainId", true, `the node answers chainId ${LOCAL_CHAIN_ID}`);

  // 1. The token must be deployed and its decimals must match the claim.
  const token = TOKEN || deployToken(PROVIDER_KEY);
  const decimalsRaw = await client.callData(token, "0x313ce567");
  const onchain = Number(BigInt(decimalsRaw));
  record("token decimals()", onchain === DECIMALS, `${token} reports ${onchain} decimals`);

  // 2. Registry: a third chain, its asset, a receiving address.
  // The seeded two chains stay registered; the local chain is added alongside
  // them, which is the "a third chain is data, not code" claim in practice.
  const registry = new NetworkRegistry({ version: NETWORK_REGISTRY_VERSION, networks: [...DEFAULT_NETWORKS, localNetwork], assets: [] });
  const asset = registry.registerTestAsset({
    chainId: LOCAL_CHAIN_ID,
    contractAddress: token,
    symbol: "tMOCK6",
    name: "Mock Test Dollar",
    decimals: onchain,
    nanosPerToken: "1000000000",
    pricingNote: "1 tMOCK6 = 1 test USD (local lab rate)",
  });
  record("asset registered", asset.assetId === assetIdOf(LOCAL_CHAIN_ID, token), asset.assetId);

  // 3. Mint to the consumer so it can pay.
  cast(["send", token, "mint(address,uint256)", consumerAddress, (AMOUNT_RAW * 4n).toString(), "--rpc-url", RPC, "--private-key", PROVIDER_KEY]);
  const balanceOf = cast(["call", token, "balanceOf(address)(uint256)", consumerAddress, "--rpc-url", RPC]).split(" ")[0]!;
  record("consumer funded", BigInt(balanceOf) >= AMOUNT_RAW, `consumer holds ${balanceOf} base units`);

  // 4. Intent + EIP-712 signature, verified locally and by the signer's address.
  const store = new ChainStore(join(mkdtempSync(join(tmpdir(), "chain-lab-")), "chain.sqlite"));
  const intent = store.insertIntent(
    buildIntent({
      request: {
        providerId: "lab-provider",
        consumerId: "lab-consumer",
        chainId: LOCAL_CHAIN_ID,
        assetId: asset.assetId,
        recipientAddress: providerAddress,
        expectedAmountRaw: AMOUNT_RAW.toString(),
        ttlSec: 3600,
      },
      network: localNetwork,
      asset,
      priceVersion: asset.pricing.version,
    }),
  );
  const typedData = intentTypedData(intent, localNetwork, asset);
  const signature = signTypedData(typedData, CONSUMER_KEY);
  const check = verifyIntentSignature({ intent, network: localNetwork, asset, signature, expectedPayer: consumerAddress });
  record("EIP-712 signature", check.ok && check.payer?.toLowerCase() === consumerAddress.toLowerCase(), `digest ${intentDigest(intent, localNetwork, asset).slice(0, 18)}… recovered ${check.payer}`);
  if (!check.ok) throw new Error(`signature refused: ${check.reason}`);
  store.setPayer({ invoiceId: intent.invoiceId, payerAddress: check.payer!, digest: intentDigest(intent, localNetwork, asset) });

  // 5. The consumer pays from their own wallet: a real ERC-20 transfer.
  const txOut = cast(["send", token, "transfer(address,uint256)", providerAddress, AMOUNT_RAW.toString(), "--rpc-url", RPC, "--private-key", CONSUMER_KEY, "--json"]);
  const txHash = (JSON.parse(txOut) as { transactionHash: string }).transactionHash;
  record("transfer sent", /^0x[0-9a-f]{64}$/.test(txHash), `tx ${txHash}`);
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);

  // 6. The raw log the node returns, decoded by the same code the watcher uses.
  const head = await client.blockNumber();
  const logs = await client.logs({ address: [token], topics: [TRANSFER_TOPIC], fromBlock: Math.max(0, head - 20), toBlock: head });
  // The range also holds the mints, which are `Transfer(0x0, …)`; the deposit
  // under test is the one from the consumer's own address.
  const mine = logs.filter((l) => `0x${l.topics[1]!.slice(26)}` === consumerAddress.toLowerCase() && l.transactionHash === txHash);
  record("eth_getLogs", mine.length === 1, `${logs.length} Transfer log(s) in range, ${mine.length} from the consumer's tx`);
  if (mine.length !== 1) throw new Error("expected exactly one Transfer log from the consumer's transaction");
  const raw = mine[0]!;
  const decodedAmount = BigInt(raw.data);
  record("log amount", decodedAmount === AMOUNT_RAW, `data decodes to ${decodedAmount} base units`);

  // 7. The watcher pipeline: observe → claim → finality → credit.
  const ledger = new LedgerSink();
  const watcher = new ChainWatcher({ network: localNetwork, registry, store, ledger, initialLookback: 30 });
  (watcher as unknown as { client: EvmClient }).client = client;
  const scan = await watcher.scan();
  // The range also contains the mint's `Transfer(0x0, …)`; it is stored, has no
  // matching intent and is therefore `unclaimed`. The deposit under test is the
  // one that was claimed.
  record("scan", scan.errors.length === 0 && scan.newEvents === 2 && scan.claimed === 1 && scan.unclaimed === 1 && scan.credited === 1, JSON.stringify(scan));
  const event = store.eventByTx(txHash)[0]!;
  record("event credited", event.status === "credited", `${event.id} → ${event.depositId}`);
  const conversion = convertRawToNanos({ rawAmount: BigInt(event.amountRaw), asset });
  record("conversion", conversion.nanos === Number((AMOUNT_RAW * 1_000_000_000n) / 10n ** BigInt(onchain)), `${event.amountRaw} raw → ${conversion.nanos} nanos (dust ${conversion.dustRaw})`);
  record("ledger booked once", ledger.deposits.size === 1 && ledger.applied.size === 1, `${ledger.deposits.size} deposit(s), ${ledger.applied.size} applied`);

  // 8. Rescan from scratch: the same event, no second credit.
  store.rewindCursor(LOCAL_CHAIN_ID, 0, "lab: deliberate full rescan");
  const again = await watcher.scan();
  record("rescan is idempotent", again.newEvents === 0 && again.credited === 0 && ledger.deposits.size === 1, `rescan: ${JSON.stringify(again)}`);

  // 9. A temporary receipt outage must not lose a payment, and its recovery
  //    must credit exactly once. This is the phase-7 review's defect A on a real
  //    node: the first build marked the event uncertain and never looked again.
  const outageIntent = store.insertIntent(
    buildIntent({
      request: { providerId: "lab-provider", consumerId: "lab-consumer-3", chainId: LOCAL_CHAIN_ID, assetId: asset.assetId, recipientAddress: providerAddress, expectedAmountRaw: AMOUNT_RAW.toString(), ttlSec: 3600 },
      network: localNetwork,
      asset,
      priceVersion: asset.pricing.version,
    }),
  );
  const outageSig = signTypedData(intentTypedData(outageIntent, localNetwork, asset), CONSUMER_KEY);
  const outageCheck = verifyIntentSignature({ intent: outageIntent, network: localNetwork, asset, signature: outageSig, expectedPayer: consumerAddress });
  store.setPayer({ invoiceId: outageIntent.invoiceId, payerAddress: outageCheck.payer!, digest: intentDigest(outageIntent, localNetwork, asset) });
  const outageTx = JSON.parse(cast(["send", token, "transfer(address,uint256)", providerAddress, AMOUNT_RAW.toString(), "--rpc-url", RPC, "--private-key", CONSUMER_KEY, "--json"])) as { transactionHash: string };
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);

  let receiptCalls = 0;
  const flaky = new ChainWatcher({ network: localNetwork, registry, store, ledger, initialLookback: 30 });
  (flaky as unknown as { client: unknown }).client = {
    verifyChain: () => client.verifyChain(),
    blockNumber: () => client.blockNumber(),
    maybeBlock: (tag: "latest" | "safe" | "finalized" | number) => client.maybeBlock(tag),
    block: (tag: "latest" | "safe" | "finalized" | number) => client.block(tag),
    logs: (input: Parameters<EvmClient["logs"]>[0]) => client.logs(input),
    callData: (to: string, data: string) => client.callData(to, data),
    receipt: async (txHash: string) => {
      receiptCalls += 1;
      if (receiptCalls <= 2) throw new Error("the receipt index is catching up");
      return client.receipt(txHash);
    },
  };
  const depositsBefore = ledger.deposits.size;
  await flaky.scan();
  const outageEvent = store.eventByTx(outageTx.transactionHash)[0]!;
  record("receipt outage keeps the event", outageEvent.status === "uncertain" && ledger.deposits.size === depositsBefore, `${outageEvent.status}: ${outageEvent.reason}`);
  const recovered = await flaky.scan();
  const recoveredEvent = store.eventByTx(outageTx.transactionHash)[0]!;
  record(
    "receipt recovery finishes the payment",
    recoveredEvent.status === "credited" && ledger.deposits.size === depositsBefore + 1,
    `${recoveredEvent.status} (reverified ${recovered.reverified}); ${ledger.deposits.size} deposit(s) total`,
  );

  // 10. A rate change between the request and the confirmation must not change
  //     the amount. This is defect C on a real node.
  const rateIntent = store.insertIntent(
    buildIntent({
      request: { providerId: "lab-provider", consumerId: "lab-consumer-4", chainId: LOCAL_CHAIN_ID, assetId: asset.assetId, recipientAddress: providerAddress, expectedAmountRaw: AMOUNT_RAW.toString(), ttlSec: 3600 },
      network: localNetwork,
      asset,
      priceVersion: asset.pricing.version,
    }),
  );
  const rateSig = signTypedData(intentTypedData(rateIntent, localNetwork, asset), CONSUMER_KEY);
  const rateCheck = verifyIntentSignature({ intent: rateIntent, network: localNetwork, asset, signature: rateSig, expectedPayer: consumerAddress });
  store.setPayer({ invoiceId: rateIntent.invoiceId, payerAddress: rateCheck.payer!, digest: intentDigest(rateIntent, localNetwork, asset) });
  // Double the rate in the registry *after* the intent was signed.
  const originalPricing = { ...asset.pricing };
  registry.upsertAsset({ ...asset, pricing: { nanosPerToken: "4000000000", version: "fixed:31337:tMOCK6:4000000000:v1", kind: "fixed-test-rate", note: "doubled after the request" } });
  const rateTx = JSON.parse(cast(["send", token, "transfer(address,uint256)", providerAddress, AMOUNT_RAW.toString(), "--rpc-url", RPC, "--private-key", CONSUMER_KEY, "--json"])) as { transactionHash: string };
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  const rateWatcher = new ChainWatcher({ network: localNetwork, registry, store, ledger, initialLookback: 30 });
  (rateWatcher as unknown as { client: EvmClient }).client = client;
  await rateWatcher.scan();
  const rateEvent = store.eventByTx(rateTx.transactionHash)[0]!;
  const rateDeposit = rateEvent.depositId ? ledger.deposits.get(rateEvent.depositId) : undefined;
  record(
    "a rate change does not reprice a signed request",
    rateEvent.status === "credited" && rateDeposit?.amountNanos === Number((AMOUNT_RAW * 1_000_000_000n) / 10n ** BigInt(onchain)),
    `credited ${rateDeposit?.amountNanos} nanos at ${rateEvent.rateNanosPerToken} (registry now 4000000000)`,
  );
  registry.upsertAsset({ ...asset, pricing: originalPricing });

  // 11. A second consumer paying the same provider is attributed to itself.
  const depositsBeforeSecond = ledger.deposits.size;
  const otherKey = newKey();
  const otherAddress = checksumAddress(addressOf(otherKey));
  cast(["rpc", "anvil_setBalance", otherAddress, "0x21e19e0c9bab2400000", "--rpc-url", RPC]);
  cast(["send", token, "mint(address,uint256)", otherAddress, (AMOUNT_RAW * 2n).toString(), "--rpc-url", RPC, "--private-key", PROVIDER_KEY]);
  const otherIntent = store.insertIntent(
    buildIntent({
      request: { providerId: "lab-provider", consumerId: "lab-consumer-2", chainId: LOCAL_CHAIN_ID, assetId: asset.assetId, recipientAddress: providerAddress, expectedAmountRaw: AMOUNT_RAW.toString(), ttlSec: 3600 },
      network: localNetwork,
      asset,
      priceVersion: asset.pricing.version,
    }),
  );
  const otherSig = signTypedData(intentTypedData(otherIntent, localNetwork, asset), otherKey);
  const otherCheck = verifyIntentSignature({ intent: otherIntent, network: localNetwork, asset, signature: otherSig, expectedPayer: otherAddress });
  store.setPayer({ invoiceId: otherIntent.invoiceId, payerAddress: otherCheck.payer!, digest: intentDigest(otherIntent, localNetwork, asset) });
  const otherTx = JSON.parse(cast(["send", token, "transfer(address,uint256)", providerAddress, AMOUNT_RAW.toString(), "--rpc-url", RPC, "--private-key", otherKey, "--json"])) as { transactionHash: string };
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  const third = await watcher.scan();
  const otherEvent = store.eventByTx(otherTx.transactionHash)[0]!;
  record(
    "two consumers, one provider address",
    third.claimed === 1 && otherEvent.invoiceId === otherIntent.invoiceId && ledger.deposits.size === depositsBeforeSecond + 1,
    `consumer 2 claimed ${otherEvent.invoiceId} (${otherEvent.status}); ${ledger.deposits.size} deposits total`,
  );

  // 12. An unsigned payer is unclaimed, never credited.
  const depositsBeforeStranger = ledger.deposits.size;
  const strangerKey = newKey();
  const strangerAddress = checksumAddress(addressOf(strangerKey));
  cast(["rpc", "anvil_setBalance", strangerAddress, "0x21e19e0c9bab2400000", "--rpc-url", RPC]);
  cast(["send", token, "mint(address,uint256)", strangerAddress, AMOUNT_RAW.toString(), "--rpc-url", RPC, "--private-key", PROVIDER_KEY]);
  const strangerTx = JSON.parse(cast(["send", token, "transfer(address,uint256)", providerAddress, AMOUNT_RAW.toString(), "--rpc-url", RPC, "--private-key", strangerKey, "--json"])) as { transactionHash: string };
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  cast(["rpc", "anvil_mine", "--rpc-url", RPC]);
  const fourth = await watcher.scan();
  const strangerEvent = store.eventByTx(strangerTx.transactionHash)[0]!;
  record("unsigned payer stays unclaimed", strangerEvent.status === "unclaimed" && ledger.deposits.size === depositsBeforeStranger, `${fourth.unclaimed} unclaimed; deposits still ${ledger.deposits.size}`);

  // 13. A reorg of a credited event freezes instead of deleting.
  const firstEvent = store.eventByTx(txHash)[0]!;
  const blockHashBefore = firstEvent.blockHash;
  const depositsBeforeReorg = ledger.deposits.size;
  // anvil's ReorgOptions is a 2-tuple: [depth, txBlockDepth[]].
  const reorgArgs = `[${Math.max(1, (await client.blockNumber()) - firstEvent.blockNumber + 1)}, []]`;
  const reorg = Bun.spawnSync(["mise", "x", "foundry", "--", "cast", "rpc", "anvil_reorg", reorgArgs, "--raw", "--rpc-url", RPC], { stdout: "pipe", stderr: "pipe" });
  record("reorg performed", reorg.exitCode === 0, `anvil_reorg ${reorgArgs}: ${reorg.stderr.toString().slice(0, 160) || "ok"}`);
  const fifth = await watcher.scan();
  const afterReorg = store.eventByTx(txHash)[0]!;
  record(
    "reorg freezes, never deletes",
    afterReorg.status === "reverted" && ledger.frozen.length >= 1 && ledger.deposits.size === depositsBeforeReorg,
    `block ${blockHashBefore.slice(0, 12)}… → ${afterReorg.blockHash.slice(0, 12)}…; status ${afterReorg.status}; frozen ${ledger.frozen.length}; deposits ${ledger.deposits.size}; scan ${JSON.stringify(fifth)}`,
  );

  store.close();
  const failed = steps.filter((s) => !s.ok);
  log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
  const doc = { at: new Date().toISOString(), rpc: RPC, chainId: LOCAL_CHAIN_ID, token, decimals: onchain, txHash, steps };
  if (OUT) await Bun.write(OUT, JSON.stringify(doc, null, 2));
  log(JSON.stringify(doc, null, 1));
  // An anvil reorg leaves the node in a state where the lab cannot be re-run
  // without restarting it, so the exit code reflects the assertions only.
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
