// Public read-only RPC evidence, kept separate from the production watcher.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../../../plugin/src/store.ts";
const root = realpathSync(process.env.LAB_ROOT ?? "/tmp/phase7-twohost-wallet");
if (!/^\/(private\/)?tmp\/phase7-twohost-wallet/.test(root))
    throw Error("isolated lab required");
const payments = JSON.parse(readFileSync(join(root, "payments.json"), "utf8")) as {
    chainId: number;
    rpc: string;
}[];
const output: unknown[] = [];
for (const payment of payments) {
    if (![97, 84532].includes(payment.chainId))
        throw Error("testnet only");
    const request = async (method: string, params: unknown[]) => {
        const body = { jsonrpc: "2.0", id: 1, method, params };
        const response = await fetch(payment.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        const raw = await response.text();
        if (!response.ok)
            throw Error(`RPC HTTP ${response.status}`);
        const json = JSON.parse(raw);
        if (json.error)
            throw Error(JSON.stringify(json.error));
        return { at: new Date().toISOString(), endpoint: payment.rpc, request: body, response: json };
    };
    const rows: unknown[] = [];
    rows.push(await request("eth_chainId", []));
    rows.push(await request("eth_getBlockByNumber", ["latest", false]));
    rows.push(await request("eth_getBlockByNumber", ["finalized", false]));
    for (const kind of ["mint", "payment"]) {
        const tx = JSON.parse(readFileSync(join(root, `${kind}-${payment.chainId}.json`), "utf8"));
        rows.push(await request("eth_getTransactionReceipt", [tx.txHash]));
    }
    output.push({ chainId: payment.chainId, rows });
}
writeJsonAtomic(join(root, process.argv[2] ?? "raw-rpc.json"), { at: new Date().toISOString(), status: "VERIFIED", operation: "public read-only RPC; no finality assertion in collector", chains: output });
console.log("raw public RPC responses saved; no chain write");
