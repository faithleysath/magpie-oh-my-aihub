// Disposable two-host acceptance harness. No production module modifications.
// Run modes separately; `pay` refuses every previous broadcast attempt, even unknown ones.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Magpie } from "../../../../plugin/src/magpie.ts";
import { Ledger } from "../../../../plugin/src/ledger.ts";
import { Provisioner } from "../../../../plugin/src/provisioner.ts";
import { Wallet } from "../../../../plugin/src/wallet.ts";
import { ChainStore } from "../../../../plugin/src/chainstore.ts";
import { DEFAULT_NETWORKS, NetworkRegistry, NETWORK_REGISTRY_VERSION, type RegistryDocument } from "../../../../plugin/src/networks.ts";
import { EvmClient } from "../../../../plugin/src/evm.ts";
import { priceSnapshot } from "../../../../plugin/src/pricing.ts";
import { writeJsonAtomic } from "../../../../plugin/src/store.ts";
import type { CreditSink } from "../../../../plugin/src/watcher.ts";
const root = realpathSync(process.env.LAB_ROOT ?? "/tmp/phase7-twohost-wallet");
if (!/^\/(private\/)?tmp\/phase7-twohost-wallet/.test(root) || !existsSync(join(root, ".portable")))
    throw Error("isolated portable lab required");
const data = join(root, "data");
process.chdir(data);
process.env.MAGPIE_NO_ACCOUNTS = "1";
process.env.MAGPIE_ADDR = process.env.LAB_GATEWAY_ADDR ?? "192.168.132.218:3448";
process.env.HOME = join(root, "home");
const magpie = new Magpie(join(root, "Magpie.app/Contents/MacOS/magpie"));
if (magpie.version() !== "magpie 0.1.2038")
    throw Error("pinned Magpie required");
if (magpie.providerById("labmock")?.chat !== "http://127.0.0.1:19082/v1")
    throw Error("local nonbillable mock required");
const foundCast = process.env.LAB_CAST_BIN ?? Bun.which("cast");
if (!foundCast)
    throw Error("set LAB_CAST_BIN to pinned Foundry cast");
const cast: string = foundCast;
function run(args: string[], signed = false): string {
    const r = Bun.spawnSync([cast, ...args, ...(signed ? ["--keystore", join(root, "keystores/consumer"), "--password-file", join(root, "keystore-password")] : [])], { stdout: "pipe", stderr: "pipe", timeout: 45000 });
    if (r.exitCode)
        throw Error(`cast ${args[0]} failed (${r.exitCode}); reconcile before retry: ${r.stderr.toString().replace(/0x[a-fA-F0-9]{64}/g, "<redacted-32-byte>").slice(0, 400)}`);
    return r.stdout.toString().trim();
}
const version = run(["--version"]);
if (!version.includes("1.8.6") || !version.includes("6bad0a66de7c83f7b33695044138f0f5fa4c5990"))
    throw Error("pinned Foundry required");
const consumerId = "fresh-twohost";
const ledger = new Ledger(join(data, "oh-my-aihub/ledger.sqlite"));
const p = new Provisioner(magpie, { ledger, prices: async (models) => priceSnapshot(await magpie.catalogModels(), models), usageLog: () => join(data, "usage.jsonl"), drainMs: 200 });
const registryFile = join(data, "oh-my-aihub/networks.json");
const doc: RegistryDocument = existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, "utf8")) : { version: NETWORK_REGISTRY_VERSION, networks: DEFAULT_NETWORKS.map(n => ({ ...n, rpcEndpoints: [n.chainId === 97 ? "https://bsc-testnet-rpc.publicnode.com" : "https://base-sepolia-rpc.publicnode.com"] })), assets: [] };
const registry = new NetworkRegistry(doc, d => writeJsonAtomic(registryFile, d));
const store = new ChainStore(join(data, "oh-my-aihub/chain.sqlite"));
function record(name: string, detail: unknown): void {
    const row = { at: new Date().toISOString(), name, detail };
    writeFileSync(join(root, "events.jsonl"), JSON.stringify(row) + "\n", { flag: "a", mode: 0o600 });
    console.log(JSON.stringify(row));
}
const sink: CreditSink = {
    depositIntent: i => ({ created: ledger.depositIntent(i).created }),
    applyDeposit: async i => {
        await p.applyChainDeposit(i);
        record("automatic credit applied", { ...i, status: await p.status(consumerId) });
    },
    freezeConsumer: async (id, reason) => {
        ledger.setPaused(id, reason);
        await p.pauseForChain(id, reason);
    },
    balance: id => ledger.balance(id),
};
const wallet = new Wallet({ credit: sink, registry, store, initialLookback: 5 });
const mode = process.argv[2];
const publicFile = join(root, "payments.json");
type Payment = {
    chainId: number;
    token: string;
    decimals: number;
    rpc: string;
    invoiceId: string;
    amountRaw: string;
    recipient: string;
    payer: string;
};
let keep = false;
try {
    if (mode === "init") {
        if (p.find(consumerId))
            throw Error("already initialized");
        const issued = await p.ensure(consumerId, { models: ["labmock/lab-model"], capUsd: 0.0001 });
        const secret = p.find(consumerId)!.secret;
        const keyFile = process.env.LAB_GATEWAY_KEY_FILE ?? "/tmp/phase7-twohost-network/gateway-key.txt";
        writeFileSync(keyFile, secret + "\n", { mode: 0o600 });
        record("opening simulated credit", issued);
    }
    else if (mode === "prepare") {
        if (existsSync(publicFile))
            throw Error("intents already prepared");
        const payer = run(["wallet", "address"], true);
        const assets = JSON.parse(readFileSync(process.env.LAB_ASSETS ?? join(root, "assets.json"), "utf8")) as {
            chainId: number;
            token: string;
            decimals: number;
            recipient: string;
        }[];
        if (assets.length !== 2 || new Set(assets.map(a => a.chainId)).size !== 2 || assets.some(a => ![97, 84532].includes(a.chainId)))
            throw Error("exactly BSC testnet and Base Sepolia required");
        const payments: Payment[] = [];
        for (const input of assets) {
            const token = input.token;
            const provider = input.recipient;
            const net = registry.requireEnabledNetwork(input.chainId);
            const rpc = net.rpcEndpoints[0]!;
            const client = new EvmClient({ chainId: input.chainId, endpoints: [rpc] });
            await client.verifyChain();
            const decimals = input.decimals;
            const { asset } = await wallet.registerTestAsset({ chainId: input.chainId, contractAddress: token, symbol: input.chainId === 97 ? "tMOCK6" : "tMOCK18", name: "Mock Test Dollar", expectedDecimals: decimals, nanosPerToken: String(10 ** 9), pricingNote: "1 mock token = 1 test USD; no real value" });
            wallet.setReceivingAddress("twohost-provider", input.chainId, provider);
            const amountRaw = (10n ** BigInt(decimals)).toString();
            const signable = wallet.requestIntent({ providerId: "twohost-provider", consumerId, chainId: input.chainId, assetId: asset.assetId, amountRaw, ttlSec: 7200 });
            const signature = run(["wallet", "sign", "--data", JSON.stringify(signable.typedData)], true);
            const signed = wallet.signIntent({ invoiceId: signable.intent.invoiceId, signature, payerAddress: payer, expectedPayer: payer });
            writeJsonAtomic(join(root, `signed-intent-${input.chainId}.json`), { ...signable, signature, payer, verified: signed });
            const balance = run(["balance", payer, "--rpc-url", rpc]);
            payments.push({ chainId: input.chainId, token, decimals, rpc, invoiceId: signable.intent.invoiceId, amountRaw, recipient: provider, payer });
            record("fresh original intent signed before payment", { chainId: input.chainId, signable, payer, gasWei: balance });
        }
        writeJsonAtomic(publicFile, payments);
    }
    else if (mode === "pay") {
        const payments = JSON.parse(readFileSync(publicFile, "utf8")) as Payment[];
        const chainId = Number(process.argv[3]);
        const payment = payments.find(n => n.chainId === chainId);
        if (!payment || ![97, 84532].includes(chainId))
            throw Error("testnet only");
        const intent = store.intent(payment.invoiceId);
        if (!intent || intent.attributionStatus !== "signed" || intent.payerAddress?.toLowerCase() !== payment.payer.toLowerCase() || Date.parse(intent.expiresAt) <= Date.now())
            throw Error("a valid original signed intent is required BEFORE sending");
        const client = new EvmClient({ chainId, endpoints: [payment.rpc] });
        await client.verifyChain();
        for (const kind of ["mint", "payment"]) {
            const marker = join(root, `${kind}-${chainId}.json`);
            if (existsSync(marker))
                throw Error(`${kind} already attempted; reconcile this file, NEVER blindly resend`);
            const gasPrice = run(["gas-price", "--rpc-url", payment.rpc]);
            const balance = BigInt(run(["balance", payment.payer, "--rpc-url", payment.rpc]));
            if (balance < 100000n * BigInt(gasPrice))
                throw Error("insufficient testnet gas");
            const nonce = run(["nonce", payment.payer, "--block", "pending", "--rpc-url", payment.rpc]);
            writeJsonAtomic(marker, { at: new Date().toISOString(), status: "broadcast-unknown", kind, payment, nonce });
            const args = kind === "mint" ? ["mint(address,uint256)", payment.payer, payment.amountRaw] : ["transfer(address,uint256)", payment.recipient, payment.amountRaw];
            const txHash = run(["send", payment.token, ...args, "--rpc-url", payment.rpc, "--chain", String(chainId), "--nonce", nonce, "--legacy", "--gas-price", `${gasPrice}wei`, "--gas-limit", "100000", "--async"], true);
            if (!/^0x[a-fA-F0-9]{64}$/.test(txHash))
                throw Error("unknown broadcast result; reconcile before retry");
            writeJsonAtomic(marker, { at: new Date().toISOString(), status: "broadcast", kind, payment, nonce, txHash });
            record(`fresh ${kind} broadcast`, { chainId, txHash, nonce, payment });
            let receipt = null;
            for (let i = 0; i < 60; i++) {
                receipt = await client.receipt(txHash);
                if (receipt)
                    break;
                await Bun.sleep(1000);
            }
            if (receipt?.status !== "0x1")
                throw Error("receipt missing or reverted; no resend");
            writeJsonAtomic(marker, { at: new Date().toISOString(), status: "mined", kind, payment, nonce, txHash, receipt });
            record(`fresh ${kind} mined`, { chainId, receipt });
        }
    }
    else if (mode === "watch") {
        record("automatic watchers started", { pid: process.pid, existingEvents: store.allIntents().map(i => ({ invoiceId: i.invoiceId, status: i.status })), cursors: registry.enabledNetworks().map(n => ({ chainId: n.chainId, cursor: store.cursor(n.chainId) })) });
        wallet.start();
        keep = true;
        let closing = false;
        const close = () => {
            if (closing) return;
            closing = true;
            wallet.stop();
            record("watcher stop requested", { pid: process.pid });
            // Allow the current bounded RPC to drain before closing SQLite.
            setTimeout(() => {
                wallet.close();
                ledger.close();
                process.exit(0);
            }, 20_000);
        };
        process.on("SIGTERM", close);
        process.on("SIGINT", close);
        setInterval(() => { writeJsonAtomic(join(root, "watch-status.json"), { at: new Date().toISOString(), pid: process.pid, chains: wallet.runningChains(), scans: registry.enabledNetworks().map(n => wallet.lastScanResult(n.chainId)), events: registry.enabledNetworks().flatMap(n => store.eventsForChain(n.chainId, 50)) }); }, 3000);
    }
    else if (mode === "snapshot" || mode === "rescan") {
        const before = await p.status(consumerId);
        if (mode === "rescan")
            for (const net of registry.enabledNetworks()) {
                const events = store.eventsForChain(net.chainId, 100);
                const height = Math.min(...events.map(e => e.blockNumber));
                if (Number.isFinite(height))
                    store.rewindCursor(net.chainId, height - 1, "deliberate twohost idempotence acceptance");
                const scan = await wallet.scanNow(net.chainId);
                if (scan.credited !== 0)
                    throw Error("duplicate credit");
                record("zero duplicate credits", { chainId: net.chainId, scan });
            }
        const status = await p.status(consumerId);
        if (mode === "rescan" && status.capUsd !== before.capUsd)
            throw Error("cap changed on duplicate scan");
        const result = { at: new Date().toISOString(), status, native: await magpie.limitStatus(p.find(consumerId)!.secret), balance: ledger.balance(consumerId), events: registry.enabledNetworks().flatMap(n => store.eventsForChain(n.chainId, 50)), intents: store.allIntents() };
        writeJsonAtomic(join(root, "snapshot.json"), result);
        record(mode, result);
    }
    else if (mode === "revoke") {
        await p.revoke(consumerId);
        record("lab key revoked", { removed: !magpie.keyByName(`ohmyaihub-${consumerId}`) });
    }
    else
        throw Error("use init | prepare | pay <chainId> | watch | snapshot | rescan | revoke");
}
finally {
    if (!keep) {
        wallet.close();
        ledger.close();
    }
}
