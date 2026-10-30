// A controllable EVM for the wallet-UX journey.
//
// It answers exactly the JSON-RPC calls `EvmClient` makes and nothing else. It
// can mine, finalise, add transfers, run out of receipts and reorganise, so the
// whole journey can be driven without a node, a key or a payment.

import type { EvmBlock, EvmLog, EvmReceipt } from "../../src/evm.ts";
import { keccak256 } from "../../src/keccak.ts";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function bytes32(seed: string): string {
  const h = keccak256(seed);
  let out = "0x";
  for (const b of h) out += b.toString(16).padStart(2, "0");
  return out;
}

export interface FakeTransferInput {
  from: string;
  to: string;
  amount: bigint;
  contract?: string;
  logIndex?: number;
  status?: "0x1" | "0x0";
  block?: number;
}

interface FakeTx {
  hash: string;
  block: number;
  status: "0x1" | "0x0";
  logs: EvmLog[];
}

export interface FakeChainOptions {
  chainId: number;
  contract: string;
  decimals: number;
  height?: number;
  /** `finalized` reports this block; `null` means "same as head" */
  finalizedAt?: number | null;
}

export class FakeChain {
  readonly chainId: number;
  readonly contract: string;
  readonly decimals: number;
  blocks: EvmBlock[] = [];
  txs = new Map<string, FakeTx>();
  finalizedAt: number | null;
  failAll = false;
  failLogs = false;
  failReceipts = false;
  /** counts every RPC attempt, so a test can prove a path made none */
  calls = 0;

  constructor(opts: FakeChainOptions) {
    this.chainId = opts.chainId;
    this.contract = opts.contract.toLowerCase();
    this.decimals = opts.decimals;
    this.finalizedAt = opts.finalizedAt === undefined ? null : opts.finalizedAt;
    for (let i = 0; i < (opts.height ?? 20); i++) this.mine();
  }

  mine(parent?: string): EvmBlock {
    const number = this.blocks.length;
    const block: EvmBlock = {
      number: `0x${number.toString(16)}`,
      hash: bytes32(`${this.chainId}:${number}:${parent ?? ""}:${this.txs.size}`),
      parentHash: parent ?? (number === 0 ? `0x${"00".repeat(32)}` : this.blocks[number - 1]!.hash),
      timestamp: `0x${(1_700_000_000 + number).toString(16)}`,
    };
    this.blocks.push(block);
    return block;
  }

  mineN(n: number): void {
    for (let i = 0; i < n; i++) this.mine();
  }

  get head(): number {
    return this.blocks.length - 1;
  }

  transfer(input: FakeTransferInput): { txHash: string; logIndex: number; block: number } {
    const block = input.block ?? this.head;
    const b = this.blocks[block]!;
    const txHash = bytes32(`${b.hash}:${this.txs.size}:${input.from}:${input.amount}`);
    const logIndex = input.logIndex ?? this.txs.get(txHash)?.logs.length ?? 0;
    const log: EvmLog = {
      address: (input.contract ?? this.contract).toLowerCase(),
      topics: [
        TRANSFER_TOPIC,
        `0x${input.from.slice(2).toLowerCase().padStart(64, "0")}`,
        `0x${input.to.slice(2).toLowerCase().padStart(64, "0")}`,
      ],
      data: `0x${input.amount.toString(16).padStart(64, "0")}`,
      blockNumber: b.number,
      blockHash: b.hash,
      transactionHash: txHash,
      logIndex: `0x${logIndex.toString(16)}`,
    };
    const existing = this.txs.get(txHash);
    if (existing) existing.logs.push(log);
    else this.txs.set(txHash, { hash: txHash, block, status: input.status ?? "0x1", logs: [log] });
    return { txHash, logIndex, block };
  }

  /** Replaces `atBlock` and everything after it, as a reorg would. */
  reorg(atBlock: number): void {
    const height = this.blocks.length;
    this.blocks = this.blocks.slice(0, atBlock);
    this.mine(bytes32(`fork:${atBlock}:${height}`));
    while (this.blocks.length < height) this.mine();
    for (const tx of this.txs.values()) {
      if (tx.block >= atBlock) {
        const b = this.blocks[tx.block]!;
        tx.logs = tx.logs.map((l) => ({ ...l, blockHash: b.hash }));
      }
    }
  }

  fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    this.calls += 1;
    if (this.failAll) return new Response("boom", { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params: unknown[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    const error = (message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message } }), { status: 200 });
    switch (body.method) {
      case "eth_chainId":
        return reply(`0x${this.chainId.toString(16)}`);
      case "eth_blockNumber":
        return reply(`0x${this.head.toString(16)}`);
      case "eth_getBlockByNumber": {
        const tag = body.params[0] as string;
        if (tag === "finalized") {
          const at = this.finalizedAt ?? this.head;
          return reply(this.blocks[at] ?? null);
        }
        if (tag === "safe" || tag === "latest") return reply(this.blocks[this.head] ?? null);
        return reply(this.blocks[Number(BigInt(tag))] ?? null);
      }
      case "eth_getLogs": {
        if (this.failLogs) return error("rate limited");
        const filter = body.params[0] as { address: string | string[]; fromBlock: string; toBlock: string; topics: (string | null)[] };
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        const wanted = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
        const out: EvmLog[] = [];
        for (const tx of this.txs.values()) {
          if (tx.block < from || tx.block > to) continue;
          for (const log of tx.logs) {
            if (!wanted.includes(log.address.toLowerCase())) continue;
            if (filter.topics[0] && log.topics[0] !== filter.topics[0]) continue;
            out.push(log);
          }
        }
        return reply(out);
      }
      case "eth_getTransactionReceipt": {
        if (this.failReceipts) return new Response("unavailable", { status: 503 });
        const tx = this.txs.get(body.params[0] as string);
        if (!tx) return reply(null);
        const b = this.blocks[tx.block]!;
        const receipt: EvmReceipt = { transactionHash: tx.hash, blockNumber: b.number, blockHash: b.hash, status: tx.status, logs: tx.logs };
        return reply(receipt);
      }
      case "eth_call": {
        const to = String((body.params[0] as { to?: string })?.to ?? "").toLowerCase();
        if (to && to !== this.contract && to !== "0x00000000000000000000000000000000000000ff") {
          return reply("0x");
        }
        return reply(`0x${this.decimals.toString(16).padStart(64, "0")}`);
      }
      default:
        return error(`unexpected method ${body.method}`);
    }
  };
}
