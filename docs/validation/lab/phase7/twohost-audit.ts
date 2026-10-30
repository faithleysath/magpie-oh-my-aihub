// Read-only audit of the completed fresh two-host experiment; no RPC or chain writes.
import { Database } from "bun:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { NetworkRegistry, type RegistryDocument } from "../../../../plugin/src/networks.ts";
import { verifyIntentSignature, intentDigest, type SignableIntent } from "../../../../plugin/src/deposits.ts";
import { writeJsonAtomic } from "../../../../plugin/src/store.ts";
const root = realpathSync(process.env.LAB_ROOT ?? "/tmp/phase7-twohost-wallet");
if (!/^\/(private\/)?tmp\/phase7-twohost-wallet/.test(root))
    throw Error("isolated lab required");
const read = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));
function check(ok: unknown, message: string): asserts ok { if (!ok)
    throw Error(message); }
const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const opening = events.find(e => e.name === "opening simulated credit").detail;
const snapshot = read("snapshot.json");
const calls = readFileSync(join(root, "acceptance-calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
check(calls.map(c => c.status).join(",") === "200,429,200,429,429,200", "unexpected Remote Magpie sequence");
check(snapshot.status.keyId === opening.keyId, "key id changed");
check(snapshot.status.ledger.windowId === opening.ledger.windowId, "native window changed");
check(snapshot.native.limited === true && snapshot.native.limit.start === opening.ledger.start, "native cap/window no longer enforced");
check(snapshot.status.capUsd === 2.0001, "unexpected cumulative cap");
check(snapshot.status.usedUsd === 1.0013, "unexpected native usage");
check(snapshot.status.ledger.balanceUsd === 0.9988, "unexpected ledger balance");
check(!snapshot.status.paused && !snapshot.status.pending && !snapshot.status.ledger.uncertain, "accounting uncertain");
const consumers = JSON.parse(readFileSync(join(root, "data/oh-my-aihub/consumers.json"), "utf8"));
const consumer = consumers.consumers.find((c: {
    consumerId: string;
}) => c.consumerId === "fresh-twohost");
const secret = readFileSync("/tmp/phase7-twohost-network/gateway-key.txt", "utf8").trim();
check(consumer.secret === secret, "original consumer secret changed");
const keys = JSON.parse(readFileSync(join(root, "data/caller-keys.json"), "utf8"));
check(Array.isArray(keys) && keys.some(k => k.id === opening.keyId && k.secret === secret), "native key/secret mismatch");
const registry = new NetworkRegistry(read("data/oh-my-aihub/networks.json") as RegistryDocument);
const beforeRestart = read("before-restart-watch.json");
check(beforeRestart.events.some((e: {
    chainId: number;
    status: string;
}) => e.chainId === 84532 && e.status === "confirming"), "no pending Base before restart");
const restarted = events.filter(e => e.name === "automatic watchers started");
check(restarted.length === 2 && restarted[0].detail.pid !== restarted[1].detail.pid, "no real watcher restart");
const signatures = [];
const rawRpc = read("raw-rpc.json");
const finalityChecks = [];
for (const chainId of [97, 84532]) {
    const signed = read(`signed-intent-${chainId}.json`) as SignableIntent & {
        signature: string;
        payer: string;
    };
    const network = registry.requireEnabledNetwork(chainId);
    const asset = registry.asset(signed.intent.assetId)!;
    const verified = verifyIntentSignature({ intent: signed.intent, network, asset, signature: signed.signature, expectedPayer: signed.payer });
    check(verified.ok && intentDigest(signed.intent, network, asset) === signed.digest, "original signed document mismatch");
    const payment = read(`payment-${chainId}.json`);
    const event = snapshot.events.find((e: {
        txHash: string;
        chainId: number;
    }) => e.txHash === payment.txHash && e.chainId === chainId);
    check(event?.status === "credited" && event.invoiceId === signed.intent.invoiceId && event.creditedNanos === 10 ** 9, "payment not credited exactly once");
    check(Date.parse(signed.intent.requestedAt) < Date.parse(calls[1].at) && Date.parse(calls[1].at) < Date.parse(payment.at), "payment not after original intent and first 429");
    const signedRecord = events.find(e => e.name === "fresh original intent signed before payment" && e.detail.chainId === chainId);
    const broadcast = events.find(e => e.name === "fresh payment broadcast" && e.detail.chainId === chainId);
    check(Date.parse(signedRecord.at) < Date.parse(broadcast.at), "signature was not recorded before broadcast");
    const rpc = rawRpc.chains.find((c: { chainId: number }) => c.chainId === chainId);
    const observedChain = rpc.rows.find((r: { request: { method: string } }) => r.request.method === "eth_chainId");
    check(Number(BigInt(observedChain.response.result)) === chainId, "raw RPC chain mismatch");
    const latest = rpc.rows.find((r: { request: { method: string; params: unknown[] } }) => r.request.method === "eth_getBlockByNumber" && r.request.params[0] === "latest");
    const finalized = rpc.rows.find((r: { request: { method: string; params: unknown[] } }) => r.request.method === "eth_getBlockByNumber" && r.request.params[0] === "finalized");
    const head = Number(BigInt(latest.response.result.number));
    const finalHeight = Number(BigInt(finalized.response.result.number));
    check(chainId === 97 ? head - event.blockNumber + 1 >= 15 : finalHeight >= event.blockNumber, "raw RPC does not prove configured finality");
    finalityChecks.push({ chainId, paymentBlock: event.blockNumber, observedHead: head, observedFinalized: finalHeight, policySatisfied: true });
    const stored = snapshot.intents.find((i: {
        invoiceId: string;
    }) => i.invoiceId === signed.intent.invoiceId);
    check(stored.digest === signed.digest && stored.payerAddress.toLowerCase() === signed.payer.toLowerCase(), "stored attribution differs");
    signatures.push({ chainId, invoiceId: stored.invoiceId, digest: signed.digest, signatureVerified: true, txHash: payment.txHash, requestedAt: signed.intent.requestedAt, broadcastAfterFirst429: true });
}
check(snapshot.events.filter((e: {
    status: string;
}) => e.status === "credited").length === 2, "unexpected chain credits");
check(snapshot.events.filter((e: {
    status: string;
}) => e.status === "unclaimed").length === 2, "mint logs must stay uncredited");
const rescans = events.filter(e => e.name === "zero duplicate credits");
check(rescans.length === 2 && rescans.every(e => e.detail.scan.credited === 0), "missing duplicate scan evidence");
const db = new Database(join(root, "data/oh-my-aihub/ledger.sqlite"), { readonly: true });
const deposits = db.query("SELECT * FROM deposits ORDER BY created_at").all() as {
    amount_nanos: number;
    status: string;
    id: string;
}[];
const consumption = db.query("SELECT * FROM consumption ORDER BY recorded_at").all() as {
    amount_nanos: number;
    price_verified: number;
}[];
check(deposits.length === 3 && deposits.every(d => d.status === "applied"), "expected opening credit plus two applied chain deposits");
check(deposits.reduce((n, d) => n + d.amount_nanos, 0) === 2000100000, "deposit total mismatch");
check(consumption.length === 3 && consumption.every(c => c.price_verified === 1) && consumption.reduce((n, c) => n + c.amount_nanos, 0) === 1001300000, "consumption mismatch");
const result = { at: new Date().toISOString(), status: "VERIFIED", platform: `${process.platform} ${process.arch}`, sameGatewayKeyId: true, sameGatewaySecret: true, sameNativeWindow: true, httpStatuses: calls.map(c => c.status), signatures, finalityChecks, deposits, consumption, balance: snapshot.balance, rescans: rescans.map(e => e.detail), restart: read("restart.json"), mintLogsUncredited: 2 };
db.close();
writeJsonAtomic(join(root, "audit.json"), result);
console.log(JSON.stringify(result, null, 2));
