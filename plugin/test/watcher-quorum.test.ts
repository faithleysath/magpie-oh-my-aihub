import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainWatcher, TRANSFER_TOPIC, type CreditSink } from "../src/watcher.ts";
import { ChainStore } from "../src/chainstore.ts";
import { EvmClient } from "../src/evm.ts";
import { NetworkRegistry } from "../src/networks.ts";

const A = "http://127.0.0.1:11";
const B = "http://127.0.0.1:12";
const TOKEN = "0x" + "5".repeat(40);

function registry() {
  return new NetworkRegistry({
    version: 3,
    networks: [{
      chainId: 97,
      displayName: "Quorum test chain",
      family: "evm",
      networkType: "testnet",
      support: "credit",
      receivable: true,
      rpcQuorum: 2,
      rpcEndpoints: [A, B],
      blockExplorer: "",
      nativeSymbol: "tBNB",
      nativeDecimals: 18,
      enabled: true,
      finality: { mode: "confirmations", confirmations: 1, reorgDepth: 1, rationale: "test" },
      scanIntervalSec: 1,
      maxBlockRange: 100,
      notes: null,
      evidence: null,
    }],
    assets: [{
      assetId: `eip155:97:${TOKEN.toLowerCase()}`,
      chainId: 97,
      contractAddress: TOKEN,
      symbol: "tMOCK",
      name: "Mock",
      decimals: 6,
      issuerType: "mock",
      testnetOnly: true,
      credit: true,
      enabled: true,
      pricing: { nanosPerToken: "1000000000", version: "fixed:1", kind: "fixed-test-rate", note: "test" },
      evidence: null,
    }],
  });
}

function sink(): CreditSink {
  return {
    depositIntent: () => ({ created: true }),
    applyDeposit: async () => {},
    freezeConsumer: async () => {},
    reverseDeposit: async () => {},
    balance: () => ({ depositedNanos: 0, consumedNanos: 0, balanceNanos: 0 }),
  };
}

const LOG = {
  address: TOKEN,
  topics: [TRANSFER_TOPIC, "0x" + "1".repeat(64), "0x" + "2".repeat(64)],
  data: "0x" + "0".repeat(63) + "1",
  blockNumber: "0x5",
  blockHash: "0x" + "3".repeat(64),
  transactionHash: "0x" + "4".repeat(64),
  logIndex: "0x0",
};

function fetchDisagreeing(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    if (body.method === "eth_chainId") return reply("0x61");
    if (body.method === "eth_blockNumber") return reply("0x6");
    if (body.method === "eth_getBlockByNumber") {
      return reply({ number: "0x6", hash: "0x" + "6".repeat(64), parentHash: "0x" + "3".repeat(64), timestamp: "0x1" });
    }
    if (body.method === "eth_getLogs") return reply(String(url) === A ? [LOG] : []);
    if (body.method === "eth_getTransactionReceipt") return reply({ transactionHash: LOG.transactionHash, blockNumber: "0x5", blockHash: LOG.blockHash, status: "0x1", logs: [LOG] });
    return reply(null);
  }) as typeof fetch;
}

describe("watcher quorum", () => {
  test("endpoint disagreement pauses the scan: no events, no cursor advance, an auditable anomaly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quorum-"));
    const store = new ChainStore(join(dir, "chain.sqlite"));
    const reg = registry();
    const network = reg.requireEnabledNetwork(97);
    const watcher = new ChainWatcher({ network, registry: reg, store, ledger: sink(), initialLookback: 0 });
    (watcher as unknown as { client: EvmClient }).client = new EvmClient({
      chainId: 97,
      endpoints: [A, B],
      fetchImpl: fetchDisagreeing(),
    });
    const result = await watcher.scan();
    expect(result.partial).toBe(true);
    expect(result.credited).toBe(0);
    expect(result.errors.join(" ")).toMatch(/disagree/);
    expect(store.eventsForChain(97)).toEqual([]);
    expect(store.cursor(97)).toBeNull();
    expect(store.anomalies().some((a) => a.kind === "rpc-quorum")).toBe(true);
    store.close();
  });
});
