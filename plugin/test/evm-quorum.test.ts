import { describe, expect, test } from "bun:test";
import { EvmClient, QuorumError } from "../src/evm.ts";

const A = "http://127.0.0.1:1";
const B = "http://127.0.0.1:2";

function client(handler: (url: string, method: string, params: unknown[]) => unknown, minimum = 2): EvmClient {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    if (body.method === "eth_chainId") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x38" }));
    }
    const result = handler(String(url), body.method, body.params);
    if (result instanceof Error) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: result.message } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as typeof fetch;
  return new EvmClient({ chainId: 56, endpoints: [A, B], fetchImpl, timeoutMs: 1000 });
}

describe("EVM quorum", () => {
  test("requires one agreed answer from at least two endpoints", async () => {
    const c = client((_url, method) => {
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_call") return "0x0000000000000000000000000000000000000000000000000000000000000006";
      return null;
    });
    expect(await c.callQuorum("eth_blockNumber", [], 2)).toBe("0x10");
    expect(await c.callDataQuorum("0x" + "1".repeat(40), "0x313ce567", 2)).toBe("0x0000000000000000000000000000000000000000000000000000000000000006");
  });

  test("refuses a contradictory answer even when the minimum otherwise agree", async () => {
    const c = client((url, method) => {
      if (method === "eth_blockNumber") return url === A ? "0x10" : "0x11";
      return null;
    });
    await expect(c.callQuorum("eth_blockNumber", [], 2)).rejects.toBeInstanceOf(QuorumError);
  });

  test("uses the lowest head and the lowest finalized height", async () => {
    const c = client((url, method) => {
      if (method === "eth_blockNumber") return url === A ? "0x10" : "0x12";
      if (method === "eth_getBlockByNumber") return { number: "0x10", hash: "0x" + "1".repeat(64), parentHash: "0x" + "2".repeat(64), timestamp: "0x1" };
      return null;
    });
    expect(await c.blockNumberQuorum(2)).toBe(16);
    expect(await c.finalizedNumberQuorum(2)).toBe(16);
  });

  test("refuses a log set that differs between endpoints", async () => {
    const log = (blockHash: string) => ({
      address: "0x" + "1".repeat(40),
      topics: ["0x" + "a".repeat(64), "0x" + "b".repeat(64), "0x" + "c".repeat(64)],
      data: "0x" + "0".repeat(63) + "1",
      blockNumber: "0x10",
      blockHash,
      transactionHash: "0x" + "d".repeat(64),
      logIndex: "0x0",
    });
    const c = client((url, method) => {
      if (method === "eth_getLogs") return [log(url === A ? "0x" + "1".repeat(64) : "0x" + "2".repeat(64))];
      return null;
    });
    await expect(c.logsQuorum({ address: "0x" + "1".repeat(40), topics: [], fromBlock: 1, toBlock: 2 }, 2)).rejects.toBeInstanceOf(QuorumError);
  });

  test("a receipt present on one endpoint and absent on the other is not a quorum", async () => {
    const receipt = { transactionHash: "0x" + "a".repeat(64), blockNumber: "0x10", blockHash: "0x" + "1".repeat(64), status: "0x1", logs: [] };
    const c = client((url, method) => {
      if (method === "eth_getTransactionReceipt") return url === A ? receipt : null;
      return null;
    });
    await expect(c.receiptQuorum("0x" + "a".repeat(64), 2)).rejects.toBeInstanceOf(QuorumError);
  });

  test("quantityQuorum is identical/max/min as asked and refuses a shortage", async () => {
    const c = client((url, method) => {
      if (method === "eth_getBalance") return url === A ? "0x10" : "0x20";
      if (method === "eth_maxPriorityFeePerGas") return url === A ? "0x10" : "0x20";
      return null;
    });
    await expect(c.quantityQuorum("eth_getBalance", [], 2, "identical")).rejects.toBeInstanceOf(QuorumError);
    expect(await c.quantityQuorum("eth_getBalance", [], 2, "max")).toBe(32n);
    expect(await c.quantityQuorum("eth_maxPriorityFeePerGas", [], 2, "min")).toBe(16n);
    const onlyOne = client((url, method) => (url === A && method === "eth_getBalance" ? "0x10" : new Error("down")));
    await expect(onlyOne.quantityQuorum("eth_getBalance", [], 2, "max")).rejects.toBeInstanceOf(QuorumError);
  });
});
