#!/usr/bin/env bun
// The real-testnet half of phase 7: BSC testnet (97) and Base Sepolia (84532).
//
// Nothing here is simulated. The script deploys the mock token on each chain,
// registers it after reading `decimals()` from the chain, asks the wallet module
// for a deposit intent, signs it with a consumer key, sends a real ERC-20
// transfer, waits for that chain's own finality condition, and then shows the
// ledger booking. It refuses to run against a mainnet chain id.
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
import { assetIdOf, loadRegistry, NetworkRegistry, NETWORK_REGISTRY_VERSION, type NetworkRecord } from "../src/networks.ts";
import { buildIntent, intentDigest, intentTypedData, verifyIntentSignature } from "../src/deposits.ts";
import { ChainWatcher, convertRawToNanos, TRANSFER_TOPIC, finalityVerdict, type CreditSink } from "../src/watcher.ts";
import { checksumAddress } from "../src/secp256k1.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const KEYS_FILE = arg("keys");
const CHAINS = arg("chains", "97,84532").split(",").map((s) => Number(s.trim()));
const AMOUNT_RAW = BigInt(arg("amount", "1000000"));
const OUT = arg("out", join(mkdtempSync(join(tmpdir(), "testnet-lab-")), "report.json"));

const log = (...p: unknown[]) => console.log(...p);

function keys(): { provider: string; consumer: string } {
  const text = readFileSync(KEYS_FILE, "utf8");
  const found = [...text.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]);
  if (found.length < 2) throw new Error("the keys file needs two 32-byte private keys (provider, consumer)");
  return { provider: found[0]!, consumer: found[1]! };
}

function run(bin: "cast" | "forge", args: string[]): string {
  const out = Bun.spawnSync(["mise", "x", "foundry", "--", bin, ...args], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`${bin} ${args[0] ?? ""} failed: ${out.stderr.toString().slice(0, 500)}`);
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

  const registry = new NetworkRegistry({ version: NETWORK_REGISTRY_VERSION, networks: [], assets: [] });
  const seeded = loadRegistry(join(mkdtempSync(join(tmpdir(), "reg-")), "networks.json"));
  void registry;
  void seeded;

  const report: Record<string, unknown>[] = [];

  for (const chainId of CHAINS) {
    if (chainId === 56 || chainId === 8453) throw new Error(`chain ${chainId} is mainnet; this lab is testnet only`);
    const perChain: Record<string, unknown> = { chainId };
    const base = (await import("../src/networks.ts")).DEFAULT_NETWORKS.find((n) => n.chainId === chainId);
    if (!base) {
      record(chainId, "network registered", false, `chain ${chainId} is not one of the seeded testnets`);
      continue;
    }
    const client = new EvmClient({ chainId, endpoints: base.rpcEndpoints });
    try {
      await client.verifyChain();
      record(chainId, "rpc chainId", true, `${base.displayName}: the endpoint answers chainId ${chainId}`);
    } catch (e) {
      record(chainId, "rpc chainId", false, String((e as Error).message ?? e).slice(0, 300));
      continue;
    }

    // Gas must already be there: this lab never buys or transfers native coin.
    const balance = BigInt(await client.call<string>("eth_getBalance", [providerAddress, "latest"]));
    record(chainId, "provider gas", balance > 0n, `provider holds ${balance} wei of ${base.nativeSymbol}`);
    if (balance === 0n) {
      record(chainId, "deploy mock token", null, "UNKNOWN: no testnet gas, so nothing could be deployed on this chain");
      perChain.unknown = "no gas";
      report.push(perChain);
      continue;
    }

    // Deploy the mock token: 6 decimals on BSC, 18 on Base, so both precisions
    // are exercised on a real chain rather than only in a unit test.
    const decimals = chainId === 97 ? 6 : 18;
    const symbol = `tMOCK${decimals}`;
    const root = join(import.meta.dir, "..", "lab", "chain");
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
      "--constructor-args",
      "Mock Test Dollar",
      symbol,
      String(decimals),
    ]);
    const deployed = created.split("\n").find((l) => l.startsWith("Deployed to:"))?.replace("Deployed to:", "").trim();
    const deployTx = created.split("\n").find((l) => l.startsWith("Transaction hash:"))?.replace("Transaction hash:", "").trim();
    if (!deployed) {
      record(chainId, "deploy mock token", false, `forge create printed no address: ${created.slice(0, 200)}`);
      continue;
    }
    record(chainId, "deploy mock token", true, `${symbol} at ${deployed}`, `${base.blockExplorer}/tx/${deployTx}`);

    const onchain = Number(BigInt(await client.callData(deployed, "0x313ce567")));
    record(chainId, "decimals() on chain", onchain === decimals, `${deployed} reports ${onchain}`);

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
    const mint = run("cast", ["send", deployed, "mint(address,uint256)", consumerAddress, (AMOUNT_RAW * 2n).toString(), "--rpc-url", base.rpcEndpoints[0]!, "--private-key", provider, "--json"]);
    const mintHash = (JSON.parse(mint) as { transactionHash: string }).transactionHash;

    const store = new ChainStore(join(mkdtempSync(join(tmpdir(), `chain-${chainId}-`)), "chain.sqlite"));
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

    const sent = run("cast", ["send", deployed, "transfer(address,uint256)", providerAddress, AMOUNT_RAW.toString(), "--rpc-url", base.rpcEndpoints[0]!, "--private-key", consumer, "--json"]);
    const txHash = (JSON.parse(sent) as { transactionHash: string }).transactionHash;
    record(chainId, "transfer sent", true, `${AMOUNT_RAW} base units of ${symbol}`, `${base.blockExplorer}/tx/${txHash}`);

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
      if (event) lastEvent = `${event.status} (${event.confirmations} confirmations, ${event.reason ?? "—"})`;
      if (scan.credited > 0 || event?.status === "credited") {
        credited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, chainId === 97 ? 5_000 : 15_000));
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const event = store.eventByTx(txHash)[0];
    record(chainId, "finality reached and credited", credited, credited ? `${elapsed}s; ${lastEvent}` : `after ${elapsed}s: ${lastEvent || "the event was never observed"}`);
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
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
