#!/usr/bin/env bun
// Isolated BSC/Base mainnet-fork payment lab.
//
// This script NEVER sends a real transaction. It starts a local Anvil fork of a
// public RPC at a pinned block, impersonates a real USDC holder *on the fork*
// only, and moves fork-local USDC to a test payer. The plugin then runs its
// normal Wallet -> ChainWatcher -> Ledger -> Provisioner -> Magpie path against
// two loopback endpoints that expose the same fork node (the second endpoint is
// a loopback proxy on 127.0.0.2). A real, isolated portable Magpie 0.1.2516
// serves the cost/token limit readback on its own port; the user's 3425/profile
// is not touched.
//
// The quorum is therefore a code-path exercise (two distinct hosts answering
// from one isolated chain), not a claim about independent public providers.
// Disagreement/insufficiency is covered by unit tests with fake endpoints.

import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Contract, JsonRpcProvider, Wallet as EthersWallet, getAddress, parseUnits } from "ethers";
import { Ledger } from "../src/ledger.ts";
import { ChainStore } from "../src/chainstore.ts";
import { Wallet } from "../src/wallet.ts";
import { Provisioner } from "../src/provisioner.ts";
import { Magpie } from "../src/magpie.ts";
import { NetworkRegistry, PRODUCT_NETWORKS, MAINNET_ASSETS } from "../src/networks.ts";
import { priceSnapshot } from "../src/pricing.ts";
import { signDigest, addressOf } from "../test/support/signer.ts";
import type { CreditSink } from "../src/watcher.ts";

const CHAINS = {
  56: {
    name: "BSC",
    rpc: process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
    native: "BNB",
    knownHolders: [
      "0xF977814e90dA44bFA03b6295A0616a897441aceC",
      "0x28C6c06298d514Db089934071355E5743bf21d60",
      "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3",
    ],
  },
  8453: {
    name: "Base",
    rpc: process.env.BASE_RPC || "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    native: "ETH",
    knownHolders: [
      "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A",
      "0x28C6c06298d514Db089934071355E5743bf21d60",
    ],
  },
} as const;

const ANVIL = process.env.ANVIL_BIN || "anvil";
const MAGPIE_APP = process.env.MAGPIE_APP || "/Applications/magpie.app";
const OUT = join(import.meta.dir, "..", "..", "docs", "production", "mainnet-payments", "evidence");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20 = new Contract("0x0000000000000000000000000000000000000000", [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
], null);

type Proc = ReturnType<typeof Bun.spawn>;

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function waitForRpc(url: string, chainId: number, timeoutMs = 60_000): Promise<void> {
  const at = Date.now();
  while (Date.now() - at < timeoutMs) {
    try {
      const got = Number(BigInt((await rpc(url, "eth_chainId")) as string));
      if (got === chainId) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  throw new Error(`anvil for chain ${chainId} did not become ready`);
}

async function waitForHttp(url: string, timeoutMs = 90_000): Promise<void> {
  const at = Date.now();
  while (Date.now() - at < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  throw new Error(`service at ${url} did not become ready`);
}

async function startAnvil(chainId: number, port: number, forkBlock: number): Promise<Proc> {
  const spec = CHAINS[chainId as keyof typeof CHAINS];
  const proc = Bun.spawn([
    ANVIL,
    "--fork-url", spec.rpc,
    "--fork-block-number", String(forkBlock),
    "--chain-id", String(chainId),
    "--port", String(port),
    "--host", "127.0.0.1",
    "--gas-limit", "30000000",
    "--code-size-limit", "100000",
    "--steps-tracing",
  ], { stdout: "pipe", stderr: "pipe" });
  await waitForRpc(`http://127.0.0.1:${port}`, chainId);
  return proc;
}

function startProxy(port: number, targetPort: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const body = await req.text();
      const res = await fetch(`http://127.0.0.1:${targetPort}`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: body || undefined,
      });
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
    },
  });
}

async function findWhale(url: string, usdc: string, decimals: number, head: number, exclude: Set<string>, known: readonly string[]): Promise<string> {
  const amount = 10n * 10n ** BigInt(decimals);
  for (const candidate of known) {
    if (exclude.has(candidate.toLowerCase())) continue;
    try {
      const code = await rpc(url, "eth_getCode", [candidate, "latest"]);
      if (code !== "0x") continue;
      const raw = (await rpc(url, "eth_call", [{ to: usdc, data: ERC20.interface.encodeFunctionData("balanceOf", [candidate]) }, "latest"])) as string;
      if (BigInt(raw) >= amount) return getAddress(candidate);
    } catch {
      /* try the next known holder */
    }
  }
  const ranges = [50, 20, 8];
  for (const span of ranges) {
    let logs: { topics: string[] }[];
    try {
      logs = (await rpc(url, "eth_getLogs", [{
        address: usdc,
        topics: [TRANSFER_TOPIC],
        fromBlock: `0x${Math.max(0, head - span).toString(16)}`,
        toBlock: `0x${head.toString(16)}`,
      }])) as { topics: string[] }[];
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const entry of logs) {
      const topic = entry.topics?.[2];
      if (!topic || topic.length < 66) continue;
      const candidate = getAddress(`0x${topic.slice(26)}`);
      if (seen.has(candidate.toLowerCase()) || exclude.has(candidate.toLowerCase())) continue;
      seen.add(candidate.toLowerCase());
      try {
        const code = await rpc(url, "eth_getCode", [candidate, "latest"]);
        if (code !== "0x") continue;
        const data = ERC20.interface.encodeFunctionData("balanceOf", [candidate]);
        const raw = (await rpc(url, "eth_call", [{ to: usdc, data }, "latest"])) as string;
        if (BigInt(raw) >= amount) return candidate;
      } catch {
        /* try the next candidate */
      }
    }
  }
  throw new Error("no EOA USDC holder with enough balance was found in the recent fork window");
}

async function fundPayer(url: string, usdc: string, decimals: number, whale: string, payer: string): Promise<string> {
  const amount = 5n * 10n ** BigInt(decimals);
  const data = ERC20.interface.encodeFunctionData("transfer", [payer, amount]);
  await rpc(url, "anvil_impersonateAccount", [whale]);
  await rpc(url, "anvil_setBalance", [whale, "0x56bc75e2d63100000"]);
  try {
    const tx = (await rpc(url, "eth_sendTransaction", [{
      from: whale,
      to: usdc,
      data,
      gas: "0x493e0",
      gasPrice: "0x3b9aca00",
      value: "0x0",
    }])) as string;
    const receipt = await waitReceipt(url, tx);
    if (receipt.status !== "0x1") throw new Error(`funding transfer reverted: ${tx}`);
    return tx;
  } finally {
    await rpc(url, "anvil_stopImpersonatingAccount", [whale]).catch(() => {});
  }
}

async function waitReceipt(url: string, hash: string, timeoutMs = 30_000): Promise<{ status: string; blockNumber: string; blockHash: string }> {
  const at = Date.now();
  while (Date.now() - at < timeoutMs) {
    const receipt = (await rpc(url, "eth_getTransactionReceipt", [hash])) as { status: string; blockNumber: string; blockHash: string } | null;
    if (receipt) return receipt;
    await Bun.sleep(200);
  }
  throw new Error(`no receipt for ${hash}`);
}

async function startMagpie(root: string): Promise<{ proc: Proc; bin: string; gateway: string; web: string; dataDir: string; version: string }> {
  const app = join(root, "Magpie.app");
  cpSync(MAGPIE_APP, app, { recursive: true });
  writeFileSync(join(root, ".portable"), "");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const gatewayPort = 39_900 + Math.floor(Math.random() * 50);
  const gateway = `127.0.0.1:${gatewayPort}`;
  const web = `127.0.0.1:${gatewayPort + 100}`;
  const bin = join(app, "Contents", "MacOS", "magpie");
  const proc = Bun.spawn([bin, "web", "--addr", web, "--no-open", "--gateway"], {
    cwd: dataDir,
    env: { ...process.env, MAGPIE_ADDR: gateway, MAGPIE_NO_ACCOUNTS: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHttp(`http://${gateway}/`, 90_000);
  const version = existsSync(join(dataDir, "last-version")) ? readFileSync(join(dataDir, "last-version"), "utf8").trim() : readFileSync(join(app, "Contents", "Info.plist"), "utf8").match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1] ?? "unknown";
  return { proc, bin, gateway, web, dataDir, version };
}

async function runChain(chainId: number): Promise<Record<string, unknown>> {
  const spec = CHAINS[chainId as keyof typeof CHAINS];
  const root = mkdtempSync(join(tmpdir(), `aihub-fork-${chainId}-`));
  const lab = join(root, "lab");
  mkdirSync(lab, { recursive: true });
  const port = 38_500 + Math.floor(Math.random() * 400) * 2;
  const proxyPort = port + 1;
  const head = Number(BigInt((await rpc(spec.rpc, "eth_blockNumber")) as string));
  log(`chain ${chainId} (${spec.name}): forking ${spec.rpc} at block ${head}`);
  const anvil = await startAnvil(chainId, port, head);
  let proxy: ReturnType<typeof startProxy> | null = null;
  let magpie: Awaited<ReturnType<typeof startMagpie>> | null = null;
  const cleanup = () => {
    try { proxy?.stop(true); } catch { /* already stopped */ }
    try { anvil.kill(); } catch { /* already stopped */ }
    if (magpie) { try { magpie.proc.kill(); } catch { /* already stopped */ } }
  };
  try {
    proxy = startProxy(proxyPort, port);
    const local = `http://127.0.0.1:${port}`;
    const second = `http://127.0.0.1:${proxyPort}`;
    const payerKey = 1n;
    const payer = addressOf(payerKey);
    const recipient = "0x3d80C477021E3FA568e91C73bAEC8E806518D9a6";
    const whale = await findWhale(local, spec.usdc, spec.decimals, head, new Set([payer.toLowerCase(), recipient.toLowerCase()]), spec.knownHolders);
    log(`chain ${chainId}: fork whale ${whale}; funding test payer ${payer}`);
    const fundTx = await fundPayer(local, spec.usdc, spec.decimals, whale, payer);
    // The payer needs native gas on the fork too; this is fork-only balance.
    await rpc(local, "anvil_setBalance", [payer, "0x56bc75e2d63100000"]);
    const funded = BigInt((await rpc(local, "eth_call", [{ to: spec.usdc, data: ERC20.interface.encodeFunctionData("balanceOf", [payer]) }, "latest"])) as string);
    log(`chain ${chainId}: payer USDC balance after funding = ${funded.toString()} raw`);
    if (funded < 10n ** BigInt(spec.decimals)) throw new Error("the isolated payer has less than 1 USDC after funding");

    const base = PRODUCT_NETWORKS.find((n) => n.chainId === chainId)!;
    const network = {
      ...base,
      rpcEndpoints: [local, second],
      rpcQuorum: 2,
      finality: { mode: "confirmations" as const, confirmations: 1, reorgDepth: 1, rationale: "isolated Anvil fork: public finalized tag is not reproduced" },
      scanIntervalSec: 1,
      maxBlockRange: 500,
    };
    const asset = MAINNET_ASSETS.find((a) => a.chainId === chainId)!;
    const registry = new NetworkRegistry({ version: 3, networks: [network], assets: [asset] });

    magpie = await startMagpie(join(root, "magpie"));
    process.env.MAGPIE_ADDR = magpie.gateway;
    process.chdir(magpie.dataDir);
    const magpieClient = new Magpie(magpie.bin);
    const ledger = new Ledger(join(lab, "ledger.sqlite"));
    const store = new ChainStore(join(lab, "chain.sqlite"));
    // Anvil cannot serve logs for blocks before its fork point; start the
    // watcher exactly at the pinned fork block.
    const forkHeader = (await rpc(local, "eth_getBlockByNumber", [`0x${head.toString(16)}`, false])) as { hash: string };
    store.advanceCursor({ chainId, block: head, blockHash: forkHeader.hash, at: new Date().toISOString() });
    const snap = priceSnapshot([{ id: "lab/model", price: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, contextWindow: 128_000, maxOutputTokens: 8_192 }], ["lab/model"])!;
    const provisioner = new Provisioner(magpieClient, {
      ledger,
      prices: async () => snap,
      usageLog: () => join(magpie!.dataDir, "usage.jsonl"),
      drainMs: 0,
      save: () => {},
    });
    const credit: CreditSink = {
      depositIntent: (input) => {
        const r = ledger.depositIntent({ ...input, assetId: input.assetId, chainId: input.chainId });
        return { created: r.created };
      },
      applyDeposit: async (input) => { await provisioner.applyChainDeposit(input); },
      freezeConsumer: async (consumerId, reason) => {
        ledger.setPaused(consumerId, `chain-reorg: ${reason}`);
      },
      reverseDeposit: async (input) => { ledger.reverseChainDeposit(input); },
      balance: (consumerId) => {
        const b = ledger.balance(consumerId);
        return { depositedNanos: b.depositedNanos, consumedNanos: b.consumedNanos, balanceNanos: b.balanceNanos };
      },
    };
    const wallet = new Wallet({ credit, registry, store, receivingPath: join(lab, "receiving.json"), now: () => new Date() });
    wallet.setReceivingNetwork("provider", chainId, true);
    wallet.setReceivingAddress("provider", chainId, getAddress(recipient));

    const opening = await provisioner.ensure("consumer", { models: ["lab/model"], capUsd: 0.01 });
    const openingCap = opening.capUsd;

    const amountTokens = 1n;
    const amountRaw = amountTokens * 10n ** BigInt(spec.decimals);
    const signable = wallet.requestIntent({ providerId: "provider", consumerId: "consumer", chainId, assetId: asset.assetId, amountRaw: amountRaw.toString() });
    const quoteDigest = signable.digest;
    const signature = signDigest(quoteDigest, payerKey);
    wallet.signIntent({ invoiceId: signable.intent.invoiceId, signature, payerAddress: payer });
    if (store.intent(signable.intent.invoiceId)?.status !== "signed") throw new Error("the deposit intent did not become signed");

    const provider = new JsonRpcProvider(local, chainId, { staticNetwork: true });
    const ethersWallet = new EthersWallet(`0x${payerKey.toString(16).padStart(64, "0")}`, provider);
    const token = new Contract(spec.usdc, ERC20.interface.fragments, ethersWallet);
    const tx = await token.transfer!(recipient, amountRaw, { gasLimit: 200_000n, gasPrice: parseUnits("1", "gwei") });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`payment transfer failed: ${tx.hash}`);
    await rpc(local, "anvil_mine", ["0x1"]);
    const txHash = tx.hash;

    const scan = await wallet.scanNow(chainId);
    const deadline = Date.now() + 30_000;
    let event = store.eventsForChain(chainId).find((e) => e.txHash.toLowerCase() === txHash.toLowerCase());
    while (Date.now() < deadline && event?.status !== "credited") {
      await wallet.scanNow(chainId);
      event = store.eventsForChain(chainId).find((e) => e.txHash.toLowerCase() === txHash.toLowerCase());
      if (event?.status === "reverted" || event?.status === "failed" || event?.status === "manualReview") break;
      await Bun.sleep(500);
    }
    if (!event || event.status !== "credited") throw new Error(`the fork event was not credited: ${JSON.stringify({ scan, event })}`);
    const intent = store.intent(signable.intent.invoiceId);
    const balance = ledger.balance("consumer");
    const rec = provisioner.find("consumer")!;
    const status = await magpieClient.limitStatus(rec.secret);
    if (!status.limited || !status.limit?.costLimit || !status.limit?.tokenLimit) throw new Error("Magpie did not report both limits after the deposit");
    const expectedCap = rec.capUsd;
    if (Math.abs((status.limit.costLimit ?? 0) - expectedCap) > 1e-9) throw new Error(`Magpie cap ${status.limit.costLimit} != expected ${expectedCap}`);
    if ((status.limit.cost ?? 0) !== 0) throw new Error(`isolated Magpie unexpectedly has usage ${status.limit.cost}`);

    const evidence = {
      schema: "ohmyaihub.production-fork-evidence/v1",
      at: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}`,
      chainId,
      chainName: spec.name,
      publicRpc: spec.rpc,
      forkBlock: head,
      endpoints: [local, second],
      quorum: 2,
      quorumNote: "both endpoints are loopback views (two ports) of the same isolated Anvil fork; this exercises the quorum code path, not independent public providers",
      finality: network.finality,
      usdc: { address: spec.usdc, decimals: spec.decimals, issuerType: asset.issuerType, symbol: asset.symbol },
      whale,
      fundTx,
      payer,
      payerFundedRaw: funded.toString(),
      recipient,
      invoiceId: signable.intent.invoiceId,
      quoteDigest,
      signature,
      amountRaw: amountRaw.toString(),
      txHash,
      receipt: { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash },
      scan,
      chainEvent: event,
      intent: intent ? { status: intent.status, invoiceId: intent.invoiceId, payerAddress: intent.payerAddress, chainId: intent.chainId, assetId: intent.assetId, amountRaw: intent.expectedAmountRaw } : null,
      ledger: balance,
      consumer: { capUsd: rec.capUsd, openingCap, priceVersion: rec.priceVersion, models: rec.models },
      magpie: { version: magpie.version, gateway: magpie.gateway, gatewayKeyId: rec.keyId, limit: status.limit },
      noRealFunds: "The only chain was an Anvil fork; the holder was impersonated on the fork only. No mainnet transaction was signed or broadcast.",
    };
    const digest = sha256(evidence);
    writeFileSync(join(OUT, `fork-${chainId}-evidence.json`), `${JSON.stringify({ ...evidence, sha256: digest }, null, 2)}\n`);
    log(`chain ${chainId}: credited ${amountRaw} raw USDC; cap ${rec.capUsd}; Magpie tokenLimit ${status.limit.tokenLimit}; tx ${txHash}`);
    return { chainId, txHash, capUsd: rec.capUsd, ledgerBalance: balance.balanceNanos, sha256: digest };
  } finally {
    try { process.chdir(tmpdir()); } catch { /* best effort */ }
    cleanup();
    if (!process.env.KEEP_FORK_LAB) {
      await Bun.sleep(300);
      rmSync(root, { recursive: true, force: true });
    }
  }
}

const arg = process.argv[2] || "both";
const chains = arg === "both" ? [56, 8453] : [Number(arg)];
if (chains.some((id) => !(id in CHAINS))) {
  console.error("usage: bun run scripts/production-fork-lab.ts [56|8453|both]");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const results = [];
for (const chainId of chains) results.push(await runChain(chainId));
const manifest = { schema: "ohmyaihub.production-fork-manifest/v1", at: new Date().toISOString(), results };
writeFileSync(join(OUT, "fork-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
