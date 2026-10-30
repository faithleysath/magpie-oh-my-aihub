#!/usr/bin/env bun
// The real-testnet half of phase 7: BSC testnet (97) and Base Sepolia (84532).
//
// Chain reads, writes and wallet signatures are real testnet operations. The
// accounting destination is an IN-MEMORY TEST SINK, not Ledger/Provisioner or
// a live Magpie Gateway Key: this lab does not prove an AI call resumes.
// It deploys/reuses a mock token, verifies decimals, signs a deposit intent,
// sends a real ERC-20 transfer and waits for the network's finality policy.
// It refuses to run against a mainnet chain id.
//
//   bun scripts/testnet-lab.ts --keys <file with two private keys> [--chains 97,84532]
//
// The keys file holds throwaway testnet keys, one per line (provider, consumer).
// It is read once and never logged; the report quotes addresses and tx hashes
// only.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvmClient } from "../src/evm.ts";
import { ChainStore } from "../src/chainstore.ts";
import { NetworkRegistry, NETWORK_REGISTRY_VERSION, type NetworkRecord } from "../src/networks.ts";
import { buildIntent, intentDigest, intentTypedData, verifyIntentSignature } from "../src/deposits.ts";
import { ChainWatcher, convertRawToNanos, type CreditSink } from "../src/watcher.ts";
import { checksumAddress } from "../src/secp256k1.ts";
import { castReceipt, labAmount } from "./testnet-lab-utils.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const KEYS_FILE = arg("keys");
const CHAINS = arg("chains", "97,84532").split(",").map((s) => Number(s.trim()));
const RAW_AMOUNT = arg("amount", "");
const RPC = arg("rpc", "");
if (RPC && CHAINS.length !== 1) throw new Error("--rpc requires exactly one --chains value");
const OUT = arg("out", join(mkdtempSync(join(tmpdir(), "testnet-lab-")), "report.json"));
/** An already-deployed mock token, so a retry reuses it instead of deploying twice. */
const TOKEN = arg("token", "");

const log = (...p: unknown[]) => console.log(...p);

function keys(): { provider: string; consumer: string } {
  const text = readFileSync(KEYS_FILE, "utf8");
  // A foundry `cast wallet new` dump repeats the key on two lines, so the same
  // key must not be mistaken for two different ones.
  const found = [...new Set([...text.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]))];
  if (found.length < 2) throw new Error("the keys file needs two distinct 32-byte private keys (provider, consumer)");
  const provider = found[0]!;
  const consumer = found[1]!;
  if (addressOf(provider) === addressOf(consumer)) throw new Error("the provider and consumer keys are the same account");
  return { provider, consumer };
}

/**
 * Gas flags for a write.
 *
 * The price is read from the chain rather than hardcoded: BSC testnet asks
 * ~0.1 gwei and Base Sepolia ~0.006 gwei, so a fixed 1 gwei is both needlessly
 * expensive on BSC and unaffordable on a Base wallet holding 0.0001 ETH
 * (300 000 × 1 gwei = 0.0003 ETH, more than the whole balance).
 */
function gasFlags(rpc: string): string[] {
  const price = run("cast", ["gas-price", "--rpc-url", rpc]).trim();
  return ["--legacy", "--gas-price", `${price}wei`];
}

function send(input: { rpc: string; to?: string; value?: string; signature?: string; args?: string[]; key: string; json?: boolean }): Record<string, unknown> {
  const args = ["send"];
  if (input.to) args.push(input.to);
  if (input.signature) args.push(input.signature, ...(input.args ?? []));
  if (input.value) args.push("--value", input.value);
  args.push("--rpc-url", input.rpc, "--private-key", input.key, ...gasFlags(input.rpc));
  args.push("--gas-limit", "300000");
  if (input.json) args.push("--json");
  const out = run("cast", args);
  if (!input.json) return {};
  return castReceipt(out);
}

function run(bin: "cast" | "forge", args: string[]): string {
  const out = Bun.spawnSync(["mise", "x", "foundry", "--", bin, ...args], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  if (out.exitCode !== 0) {
    const detail = `${out.stderr.toString()} ${out.stdout.toString()}`.replace(/0x[0-9a-fA-F]{64}/g, "<redacted-32-byte-value>").slice(0, 700);
    throw new Error(`${bin} ${args[0] ?? ""} failed (exit ${out.exitCode}, signal ${out.signalCode}): ${detail}; inspect chain state before retrying`);
  }
  return out.stdout.toString().trim();
}

function addressOf(key: string): string {
  return checksumAddress(run("cast", ["wallet", "address", "--private-key", key]));
}

function signTypedData(typedData: unknown, key: string): string {
  const out = Bun.spawnSync(
    ["mise", "x", "foundry", "--", "cast", "wallet", "sign", "--data", JSON.stringify(typedData), "--private-key", key],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = out.stdout.toString().trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(text)) throw new Error(`cast wallet sign failed: ${out.stderr.toString().slice(0, 300)}`);
  return text;
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
  async applyDeposit(input: { id: string }): Promise<void> {
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

interface Step {
  chain: number | null;
  name: string;
  ok: boolean | null;
  detail: string;
  evidence?: string;
}

async function main(): Promise<void> {
  const { provider, consumer } = keys();
  const providerAddress = addressOf(provider);
  const consumerAddress = addressOf(consumer);
  const steps: Step[] = [];
  const record = (chain: number | null, name: string, ok: boolean | null, detail: string, evidence?: string) => {
    steps.push({ chain, name, ok, detail, ...(evidence ? { evidence } : {}) });
    log(`${ok === null ? "UNKNOWN" : ok ? "PASS" : "FAIL"}  [${chain ?? "-"}] ${name}: ${detail}`);
  };

  log(`provider ${providerAddress}`);
  log(`consumer ${consumerAddress}`);

  const report: Record<string, unknown>[] = [];

  for (const chainId of CHAINS) {
    if (chainId === 56 || chainId === 8453) throw new Error(`chain ${chainId} is mainnet; this lab is testnet only`);
    const perChain: Record<string, unknown> = { chainId };
    const seeded = (await import("../src/networks.ts")).DEFAULT_NETWORKS.find((n) => n.chainId === chainId);
    const base = seeded && { ...seeded, rpcEndpoints: RPC ? [RPC] : seeded.rpcEndpoints };
    if (!base) {
      record(chainId, "network registered", false, `chain ${chainId} is not one of the seeded testnets`);
      continue;
    }
    const decimals = chainId === 97 ? 6 : 18;
    const AMOUNT_RAW = labAmount(decimals, RAW_AMOUNT || undefined);
    const client = new EvmClient({ chainId, endpoints: base.rpcEndpoints });
    try {
      await client.verifyChain();
      record(chainId, "rpc chainId", true, `${base.displayName}: the endpoint answers chainId ${chainId}`);
    } catch (e) {
      record(chainId, "rpc chainId", false, String((e as Error).message ?? e).slice(0, 300));
      continue;
    }

    // Gas must already be there: the lab never buys assets or uses a mainnet.
    const balance = BigInt(await client.call<string>("eth_getBalance", [providerAddress, "latest"]));
    record(chainId, "provider gas", balance > 0n, `provider holds ${balance} wei of ${base.nativeSymbol}`);
    if (balance === 0n) {
      record(chainId, "deploy mock token", null, "UNKNOWN: no testnet gas, so nothing could be deployed on this chain");
      perChain.unknown = "no gas";
      report.push(perChain);
      continue;
    }

    // The consumer pays for its own ERC-20 transfer, so it needs a little native
    // coin too. Sending it from the provider means only ONE address per chain
    // has to be funded from outside, which is what an operator can actually do.
    const consumerBalance = BigInt(await client.call<string>("eth_getBalance", [consumerAddress, "latest"]));
    const providerBalance = BigInt(await client.call<string>("eth_getBalance", [providerAddress, "latest"]));
    const gasPrice = BigInt(await client.call<string>("eth_gasPrice", []));
    // Match the send's maximum execution allowance with a 2x reserve. This is
    // testnet budgeting, not an assertion that L1 data fees are always zero.
    const targetConsumerBalance = 600_000n * gasPrice;
    const consumerTopUp = targetConsumerBalance > consumerBalance ? targetConsumerBalance - consumerBalance : 0n;
    if (consumerTopUp > 0n) {
      if (consumerTopUp + 300_000n * gasPrice >= providerBalance) throw new Error("insufficient testnet gas to fund the consumer safely");
      const topUp = send({ rpc: base.rpcEndpoints[0]!, to: consumerAddress, value: `${consumerTopUp.toString()}wei`, key: provider, json: true });
      const topUpHash = String(topUp.transactionHash);
      record(chainId, "fund the consumer for its own transfer", true, `${consumerTopUp} wei from the provider to ${consumerAddress}`, `${base.blockExplorer}/tx/${topUpHash}`);
    } else {
      record(chainId, "consumer already has gas", true, `${consumerBalance} wei on ${consumerAddress} (provider ${providerBalance} wei)`);
    }

    // Deploy the mock token: 6 decimals on BSC, 18 on Base, so both precisions
    // are exercised on a real chain rather than only in a unit test.
    const symbol = `tMOCK${decimals}`;
    const root = join(import.meta.dir, "..", "lab", "chain");
    let deployed: string;
    let deployTx: string | undefined;
    if (TOKEN) {
      deployed = TOKEN;
      record(chainId, "reuse a deployed mock token", true, `${symbol} at ${deployed}`, `${base.blockExplorer}/address/${deployed}`);
    } else {
      const created = run("forge", [
        "create",
        "src/MockERC20.sol:MockERC20",
        "--root",
        root,
        "--rpc-url",
        base.rpcEndpoints[0]!,
        "--private-key",
        provider,
        "--broadcast",
        ...gasFlags(base.rpcEndpoints[0]!),
        // BSC testnet estimates 200 000 gas for a creation, far too low, so the
        // limit is stated explicitly.
        "--gas-limit",
        "2000000",
        "--constructor-args",
        "Mock Test Dollar",
        symbol,
        String(decimals),
      ]);
      deployed = created.split("\n").find((l) => l.startsWith("Deployed to:"))?.replace("Deployed to:", "").trim() ?? "";
      deployTx = created.split("\n").find((l) => l.startsWith("Transaction hash:"))?.replace("Transaction hash:", "").trim();
      if (!deployed) {
        record(chainId, "deploy mock token", false, `forge create printed no address: ${created.slice(0, 200)}`);
        continue;
      }
      record(chainId, "deploy mock token", true, `${symbol} at ${deployed}`, `${base.blockExplorer}/tx/${deployTx}`);
    }

    const onchain = Number(BigInt(await client.callData(deployed, "0x313ce567")));
    record(chainId, "decimals() on chain", onchain === decimals, `${deployed} reports ${onchain}`);
    if (onchain !== decimals) throw new Error("token decimals mismatch; refusing to mint or transfer");

    // Register only after the chain agreed.
    const reg = new NetworkRegistry({
      version: NETWORK_REGISTRY_VERSION,
      networks: (await import("../src/networks.ts")).DEFAULT_NETWORKS,
      assets: [],
    });
    const asset = reg.registerTestAsset({
      chainId,
      contractAddress: deployed,
      symbol,
      name: "Mock Test Dollar",
      decimals: onchain,
      nanosPerToken: "1000000000",
      pricingNote: "fixed test rate: 1 mock token = 1 test USD",
    });

    // Mint to the consumer and send the transfer from their own wallet.
    const mint = send({ rpc: base.rpcEndpoints[0]!, to: deployed, signature: "mint(address,uint256)", args: [consumerAddress, (AMOUNT_RAW * 2n).toString()], key: provider, json: true });
    const mintHash = String(mint.transactionHash);

    const storePath = join(mkdtempSync(join(tmpdir(), `chain-${chainId}-`)), "chain.sqlite");
    const store = new ChainStore(storePath);
    const network: NetworkRecord = { ...base, rpcEndpoints: base.rpcEndpoints };
    const intent = store.insertIntent(
      buildIntent({
        request: {
          providerId: "lab-provider",
          consumerId: "lab-consumer",
          chainId,
          assetId: asset.assetId,
          recipientAddress: providerAddress,
          expectedAmountRaw: AMOUNT_RAW.toString(),
          ttlSec: 3600,
        },
        network,
        asset,
        priceVersion: asset.pricing.version,
      }),
    );
    const typed = intentTypedData(intent, network, asset);
    const signature = signTypedData(typed, consumer);
    const check = verifyIntentSignature({ intent, network, asset, signature, expectedPayer: consumerAddress });
    record(chainId, "EIP-712 signature", check.ok, `digest ${intentDigest(intent, network, asset)} recovered ${check.payer}`);
    if (!check.ok) continue;
    store.setPayer({ invoiceId: intent.invoiceId, payerAddress: check.payer!, digest: intentDigest(intent, network, asset) });

    const sent = send({ rpc: base.rpcEndpoints[0]!, to: deployed, signature: "transfer(address,uint256)", args: [providerAddress, AMOUNT_RAW.toString()], key: consumer, json: true });
    const txHash = String(sent.transactionHash);
    record(chainId, "transfer sent", true, `${AMOUNT_RAW} base units of ${symbol}`, `${base.blockExplorer}/tx/${txHash}`);
    // Keep enough public state to resume read-only after interruption, without
    // deploying or paying again. No private keys or signatures are persisted.
    const checkpointPath = `${OUT}.checkpoint.json`;
    const checkpoint = { network, asset, storePath, txHash, deployTx, mintHash, providerAddress, consumerAddress, steps, invoiceId: intent.invoiceId, ledgerKind: "in-memory-test-sink", liveMagpieVerified: false };
    await Bun.write(checkpointPath, JSON.stringify(checkpoint, null, 2));
    log(`checkpoint: ${checkpointPath}`);

    // Wait for this chain's own finality policy. This is the part that differs
    // between the two chains, and the reason each has its own policy.
    const ledger = new LedgerSink();
    const watcher = new ChainWatcher({ network, registry: reg, store, ledger, initialLookback: 200 });
    (watcher as unknown as { client: EvmClient }).client = client;
    const startedAt = Date.now();
    let credited = false;
    let lastEvent = "";
    for (let i = 0; i < 90; i++) {
      const scan = await watcher.scan();
      const event = store.eventByTx(txHash)[0];
      if (i % 4 === 0 || scan.errors.length) log(`waiting ${chainId}: ${event?.status ?? "unobserved"}; ${event?.reason ?? ""}; ${scan.errors.join("; ")}`);
      if (event && ["failed", "manualReview", "reverted", "unclaimed"].includes(event.status)) throw new Error(`deposit ${event.status}: ${event.reason}`);
      if (event) lastEvent = `${event.status} (${event.confirmations} confirmations, ${event.reason ?? "—"})`;
      if (scan.credited > 0 || event?.status === "credited") {
        credited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, chainId === 97 ? 5_000 : 15_000));
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const event = store.eventByTx(txHash)[0];
    record(chainId, "finality reached and credited", credited ? true : null, credited ? `${elapsed}s; ${lastEvent}` : `UNKNOWN after ${elapsed}s: ${lastEvent || "the event was never observed"}; checkpoint ${checkpointPath}`);
    if (!credited) {
      store.close();
      report.push({ chainId, txHash, contract: deployed, checkpointPath, unknown: "awaiting finality" });
      continue;
    }
    if (event) {
      const conversion = convertRawToNanos({ rawAmount: BigInt(event.amountRaw), asset });
      record(chainId, "conversion", true, `${event.amountRaw} raw → ${conversion.nanos} nanos at ${conversion.priceVersion} (dust ${conversion.dustRaw})`);
      record(chainId, "ledger booked once", ledger.deposits.size === 1 && ledger.applied.size === 1, `${ledger.deposits.size} deposit(s), ${ledger.applied.size} applied`);
      // A deliberate full rescan must not credit twice.
      store.rewindCursor(chainId, Math.max(0, event.blockNumber - 5), "lab: deliberate rescan");
      const again = await watcher.scan();
      record(chainId, "rescan is idempotent", again.credited === 0 && ledger.deposits.size === 1, `rescan credited ${again.credited}; deposits ${ledger.deposits.size}`);
      perChain.assetId = asset.assetId;
      perChain.contract = deployed;
      perChain.decimals = onchain;
      perChain.txHash = txHash;
      perChain.deployTx = deployTx;
      perChain.mintTx = mintHash;
      perChain.eventId = event.id;
      perChain.depositId = event.depositId;
      perChain.conversion = conversion;
      perChain.explorer = `${base.blockExplorer}/tx/${txHash}`;
      perChain.finality = base.finality;
    }
    store.close();
    report.push(perChain);
  }

  const failed = steps.filter((s) => s.ok === false);
  const unknown = steps.filter((s) => s.ok === null);
  log(`\n${steps.length - failed.length - unknown.length}/${steps.length} passed, ${unknown.length} unknown, ${failed.length} failed`);
  const doc = {
    at: new Date().toISOString(),
    ledgerKind: "in-memory-test-sink",
    liveMagpieVerified: false,
    providerAddress,
    consumerAddress,
    platform: `${process.platform} ${process.arch}`,
    bun: Bun.version,
    foundry: run("cast", ["--version"]).split("\n")[0],
    chains: CHAINS,
    steps,
    perChain: report,
  };
  await Bun.write(OUT, JSON.stringify(doc, null, 2));
  log(`report: ${OUT}`);
  process.exit(failed.length > 0 ? 1 : unknown.length > 0 ? 2 : 0);
}

await main();
