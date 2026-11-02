import { describe, expect, test } from "bun:test";
import { RpcClient, parseAmountRaw } from "../src/chain.ts";

describe("amounts", () => {
  test("keeps exact decimal places and refuses floats/exponents", () => {
    expect(parseAmountRaw("1.25", 18)).toBe(1_250_000_000_000_000_000n);
    expect(parseAmountRaw("1.25", 6)).toBe(1_250_000n);
    expect(() => parseAmountRaw("1e3", 6)).toThrow("E_INPUT");
    expect(() => parseAmountRaw("1.1234567", 6)).toThrow("E_INPUT");
    expect(() => parseAmountRaw("-1", 6)).toThrow("E_INPUT");
    expect(() => parseAmountRaw("0", 6)).toThrow("E_INPUT");
  });
});

describe("RpcClient", () => {
  test("fails over from a 429 and remembers the working endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("a.example")) {
        return new Response("slow down", { status: 429, statusText: "Too Many Requests" });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new RpcClient({
      urls: ["https://a.example", "https://b.example"],
      fetchImpl,
      rounds: 1,
    });

    expect(await client.head()).toBe(16);
    expect(calls).toEqual(["https://a.example", "https://b.example"]);
    expect(await client.head()).toBe(16);
    expect(calls).toEqual(["https://a.example", "https://b.example", "https://b.example"]);
  });
});
