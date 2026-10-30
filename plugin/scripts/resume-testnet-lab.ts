#!/usr/bin/env bun
// Read-only ON CHAIN: resumes an existing testnet payment, never signs/sends.
// Local mutations affect only the checkpoint's disposable ChainStore and a
// persisted TEST sink. This is not a live Magpie credit integration test.
import { existsSync, readFileSync } from "node:fs";
import { EvmClient } from "../src/evm.ts";
import { ChainStore } from "../src/chainstore.ts";
import { NetworkRegistry, NETWORK_REGISTRY_VERSION, type AssetRecord, type NetworkRecord } from "../src/networks.ts";
import { ChainWatcher, convertRawToNanos, type CreditSink } from "../src/watcher.ts";
import { writeJsonAtomic } from "../src/store.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: bun scripts/resume-testnet-lab.ts <checkpoint.json>");
const checkpoint = JSON.parse(readFileSync(path, "utf8")) as {
  network: NetworkRecord; asset: AssetRecord; storePath: string; txHash: string;
  providerAddress: string; consumerAddress: string; invoiceId: string;
};
const { network, asset, txHash } = checkpoint;
if (network.networkType !== "testnet" || ![97, 84532].includes(network.chainId)) throw new Error("only the two registered testnets are allowed");
const out = `${path}.resume.json`;
const sinkPath = `${path}.sink.json`;
type Entry = { consumerId: string; amountNanos: number; source: string; applied: boolean };
const deposits: Record<string, Entry> = existsSync(sinkPath) ? JSON.parse(readFileSync(sinkPath, "utf8")) : {};
const persist = () => writeJsonAtomic(sinkPath, deposits);
const sink: CreditSink = {
  depositIntent(input) {
    if (deposits[input.id]) return { created: false };
    deposits[input.id] = { consumerId: input.consumerId, amountNanos: input.amountNanos, source: input.source, applied: false };
    persist();
    return { created: true };
  },
  async applyDeposit(input) {
    if (!deposits[input.id]) throw new Error("missing test sink intent");
    deposits[input.id]!.applied = true;
    persist();
  },
  async freezeConsumer(_consumerId, reason) { throw new Error(`test payment reverted: ${reason}`); },
  balance() {
    const total = Object.values(deposits).filter((d) => d.applied).reduce((sum, d) => sum + d.amountNanos, 0);
    return { depositedNanos: total, consumedNanos: 0, balanceNanos: total };
  },
};
const store = new ChainStore(checkpoint.storePath);
const registry = new NetworkRegistry({ version: NETWORK_REGISTRY_VERSION, networks: [network], assets: [asset] });
const client = new EvmClient({ chainId: network.chainId, endpoints: network.rpcEndpoints });
await client.verifyChain();
const receipt = await client.receipt(txHash);
if (!receipt || receipt.status !== "0x1") throw new Error("the existing transfer is not successful; refusing to assume payment");
// Resume from the actual receipt, even when the checkpoint predates the first scan.
if (!store.cursor(network.chainId)) store.rewindCursor(network.chainId, Math.max(0, Number(BigInt(receipt.blockNumber)) - 1), "resume existing lab transfer");
const watcher = new ChainWatcher({ network, registry, store, ledger: sink });
const started = Date.now();
let previous = "";
while (Date.now() - started < 40 * 60_000) {
  const scan = await watcher.scan();
  const event = store.eventByTx(txHash).find((e) => e.invoiceId === checkpoint.invoiceId);
  const state = `${event?.status ?? "unobserved"}: ${event?.reason ?? ""}`;
  if (state !== previous || scan.errors.length) console.log(state, scan.errors);
  previous = state;
  writeJsonAtomic(out, {
    at: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, bun: Bun.version,
    status: event?.status === "credited" ? "VERIFIED" : "UNKNOWN", ledgerKind: "persisted-test-sink", liveMagpieVerified: false,
    network, asset, txHash, event, deposits, scan,
  });
  if (event?.status === "credited") {
    const conversion = convertRawToNanos({ rawAmount: BigInt(event.amountRaw), asset });
    const count = Object.values(deposits).filter((d) => d.applied).length;
    if (count !== 1 || conversion.nanos <= 0) throw new Error("expected exactly one positive test credit");
    store.rewindCursor(network.chainId, Math.max(0, event.blockNumber - 5), "lab resume: deliberate rescan");
    const again = await watcher.scan();
    if (again.credited !== 0 || Object.keys(deposits).length !== 1) throw new Error("rescan credited twice");
    writeJsonAtomic(out, {
      at: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, bun: Bun.version,
      status: "VERIFIED", ledgerKind: "persisted-test-sink", liveMagpieVerified: false,
      network, asset, txHash, event, conversion, deposits, rescanCredited: again.credited,
    });
    store.close();
    console.log(`VERIFIED: one test-sink credit, zero on rescan. Report: ${out}`);
    process.exit(0);
  }
  if (event && ["failed", "manualReview", "reverted", "unclaimed"].includes(event.status)) throw new Error(`payment ${state}`);
  await Bun.sleep(15_000);
}
store.close();
throw new Error(`UNKNOWN: finality not reached within 40 minutes; resume again from ${path}, do not resend`);
