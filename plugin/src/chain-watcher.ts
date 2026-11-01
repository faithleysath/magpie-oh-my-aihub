// The chain watcher: one scanner loop per chain.
//
// What it does, exactly:
//
//  - every 15 seconds, for each registered chain, read the head and compute the
//    last *final* block. BSC needs 15 confirmations (its `finalized` tag equals
//    `latest`, so the tag says nothing about depth); Base uses the `finalized`
//    tag. If finality cannot be read, the chain credits nothing this pass.
//  - scan from the stored cursor to that block in chunks of ≤5000, filtered to
//    `Transfer` logs whose `to` is this node's address and whose contract is the
//    chain's USDC.
//  - for every matching log, require the receipt: it must exist, have status 1
//    and contain that exact log. A receipt that is not available yet is a
//    *retry* condition — the cursor stays where it was, so nothing is skipped and
//    nothing is double-booked.
//  - insert the credit row and advance `meta.scan:<chainId>` in the **same**
//    SQLite transaction. Uniqueness `(chain_id, token, tx_hash, log_index)` is
//    the duplicate protection, so a re-scan of the same block is a no-op and
//    never re-issues a key.
//  - re-check the `block_hash` of credited rows inside the recent window; a block
//    that is no longer canonical means the deposit reverted. The row is marked
//    reverted (never deleted, never refunded) and the payer's cap is recomputed
//    downwards by `credit.onRevert`.
//
// One chain failing never stops the other: each pass is a separate task and only
// the broken chain keeps its cursor.

import type { Database } from "bun:sqlite";
import {
  PRODUCT_CHAINS,
  TRANSFER_TOPIC,
  addressTopic,
  clientFor,
  topicToAddress,
  type ChainRecord,
  type RpcClient,
  type RpcLog,
} from "./chain.ts";
import {
  creditedBlocksSince,
  insertCreditedDeposit,
  markDepositReverted,
  recreditDeposit,
  scanCursor,
  setScanCursor,
  type NewDeposit,
} from "./db.ts";
import { LogTail, wsUrlFor, type LogTailStatus } from "./chain-ws.ts";
import { logger } from "./log.ts";

/** `eth_getLogs` range per request; a hard endpoint may force less. */
export const CHUNK_BLOCKS = 5_000;
/** How far back a credited row is re-checked for a reorg each pass. */
export const REORG_WINDOW_BLOCKS = 3_000;
/** The scan interval. */
export const SCAN_INTERVAL_MS = 15_000;
/**
 * One pass stops after this many RPC requests, not this many blocks: a provider
 * that only allows 25 blocks per `eth_getLogs` (a real BSC endpoint does) would
 * otherwise turn a 24h backfill into an unbounded loop. Progress is committed per
 * chunk, so the next pass continues where this one stopped.
 */
const MAX_REQUESTS_PER_PASS = 400;

/** The payer whose cap must be recomputed, as `grants` understands it. */
export interface CreditSink {
  onDeposit(payer: string): Promise<unknown>;
  onRevert(payer: string): Promise<unknown>;
}

export interface WatcherOptions {
  db: Database;
  /** the node's own address; a getter because wallet_import can replace it */
  address: () => string;
  /** recomputes D → cap → Gateway Key after a change */
  credit: CreditSink;
  /** production default: the two product chains */
  chains?: readonly ChainRecord[];
  /** injection point for a self-check: a client per chain record */
  client?: (chain: ChainRecord) => RpcClient;
  intervalMs?: number;
  /** how far back the first scan starts when no cursor exists */
  lookbackBlocks?: (chain: ChainRecord) => number;
  /** how far back credited rows are re-checked */
  reorgWindow?: number;
  /** clock, injectable for deterministic tests */
  now?: () => string;
}

export interface ChainPassResult {
  chain: string;
  chainId: number;
  head: number;
  /** last final block this pass could trust, or null */
  finalBlock: number | null;
  /** the first block actually scanned, or null when nothing was due */
  fromBlock: number | null;
  /** the last block fully scanned, or null */
  scannedThrough: number | null;
  scannedBlocks: number;
  credited: number;
  reverted: number;
  detail?: string;
}

/** A pass-local "not yet" that must not advance the cursor. */
class Retryable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Retryable";
  }
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

/** The env override for the 24h lookback, shared by both chains. */
function envLookback(): number | null {
  const raw = process.env.OH_MY_AIHUB_LOOKBACK_BLOCKS;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hexToNumber(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function bigOrNull(value: string | undefined): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
  try {
    return BigInt(value === "0x" ? "0x0" : value);
  } catch {
    return null;
  }
}

export class Watcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  /**
   * Largest `eth_getLogs` span this process has made work per chain. Providers
   * differ wildly (5000 blocks, 25 blocks, or "the method is not supported"), so
   * the first chunk of a pass probes high and halves until one succeeds; the
   * working span is then reused, which keeps the steady state at one request per
   * chunk instead of a bisect per chunk.
   */
  private readonly logSpan = new Map<number, number>();
  /**
   * Blocks a subscription told us about. They are recorded out of band — the
   * cursor still moves only contiguously — so a deposit is credited within a pass
   * of its block becoming final instead of waiting for a sweep to reach it.
   */
  private readonly hints = new Map<number, Set<number>>();
  /** One live log subscription per chain, when the provider offers one. */
  private readonly tails = new Map<number, LogTail>();
  /** Last head seen per chain, for `sync()` and for the hints' finality gate. */
  private readonly heads = new Map<number, number>();

  constructor(private readonly opts: WatcherOptions) {}

  private get db(): Database {
    return this.opts.db;
  }

  private chains(): readonly ChainRecord[] {
    return this.opts.chains ?? PRODUCT_CHAINS;
  }

  private client(chain: ChainRecord): RpcClient {
    return (this.opts.client ?? ((record) => clientFor(record)))(chain);
  }

  private now(): string {
    return (this.opts.now ?? (() => new Date().toISOString()))();
  }

  private lookback(chain: ChainRecord): number {
    const configured = this.opts.lookbackBlocks?.(chain);
    if (configured !== undefined) return configured;
    return envLookback() ?? chain.lookbackBlocks;
  }

  private self(): string {
    const address = this.opts.address().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`invalid node address ${address}`);
    return address;
  }

  /** Starts the 15-second loop; a second call is a no-op. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? SCAN_INTERVAL_MS);
    this.timer.unref?.();
    this.startTails();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
  }

  /**
   * Opens one subscription per chain. The endpoint is derived from the chain's
   * HTTP endpoint (`https://` → `wss://`), so nothing has to be configured; a
   * provider that does not speak `eth_subscribe` simply never connects and the
   * sweep carries on alone.
   */
  private startTails(): void {
    for (const chain of this.chains()) {
      if (this.tails.has(chain.chainId)) continue;
      const http = chain.rpcUrls[0];
      if (!http) continue;
      const url = wsUrlFor(http);
      if (!url) continue;
      let self: string;
      try {
        self = this.self();
      } catch {
        continue;
      }
      const tail = new LogTail({
        url,
        address: chain.usdc,
        toTopic: addressTopic(self),
        onBlock: (block) => this.hint(chain.chainId, block),
      });
      this.tails.set(chain.chainId, tail);
      tail.start();
    }
  }

  /** Remembers a block a subscription reported; the pass sorts them out. */
  private hint(chainId: number, block: number): void {
    let set = this.hints.get(chainId);
    if (!set) {
      set = new Set<number>();
      this.hints.set(chainId, set);
    }
    set.add(block);
    // A burst on a busy token can outrun the pass; keep the newest handful.
    if (set.size > 256) {
      const drop = [...set].sort((a, b) => a - b).slice(0, set.size - 256);
      for (const block of drop) set.delete(block);
    }
  }

  /** What each chain's scanner is doing, for `wallet` and for support. */
  sync(): {
    chain: string;
    chainId: number;
    head: number | null;
    cursor: number | null;
    behind: number | null;
    hints: number;
    tail: LogTailStatus | null;
  }[] {
    return this.chains().map((chain) => {
      const head = this.heads.get(chain.chainId) ?? null;
      const cursor = scanCursor(this.db, chain.chainId);
      return {
        chain: chain.key,
        chainId: chain.chainId,
        head,
        cursor,
        behind: head !== null && cursor !== null ? Math.max(0, head - cursor) : null,
        hints: this.hints.get(chain.chainId)?.size ?? 0,
        tail: this.tails.get(chain.chainId)?.status() ?? null,
      };
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass();
    } finally {
      this.running = false;
    }
  }

  /** One pass over every chain. Exported behaviour: never throws. */
  async pass(): Promise<ChainPassResult[]> {
    let self: string;
    try {
      self = this.self();
    } catch (error) {
      logger.error(`watcher: no usable node address (${shortError(error)})`);
      return [];
    }
    const settled = await Promise.allSettled(
      this.chains().map(async (chain) => {
        try {
          return await this.passChain(chain, self);
        } catch (error) {
          logger.warn(`watcher: ${chain.label} pass failed: ${shortError(error)}`);
          throw error;
        }
      }),
    );
    const results: ChainPassResult[] = [];
    for (const [index, outcome] of settled.entries()) {
      const chain = this.chains()[index];
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        continue;
      }
      results.push({
        chain: chain.key,
        chainId: chain.chainId,
        head: 0,
        finalBlock: null,
        fromBlock: null,
        scannedThrough: null,
        scannedBlocks: 0,
        credited: 0,
        reverted: 0,
        detail: shortError(outcome.reason),
      });
    }
    return results;
  }

  /** One pass over one chain. Exported so a self-check can drive it directly. */
  async passChain(chain: ChainRecord, self = this.self()): Promise<ChainPassResult> {
    const client = this.client(chain);
    const head = await client.head();
    this.heads.set(chain.chainId, head);
    const result: ChainPassResult = {
      chain: chain.key,
      chainId: chain.chainId,
      head,
      finalBlock: null,
      fromBlock: null,
      scannedThrough: null,
      scannedBlocks: 0,
      credited: 0,
      reverted: 0,
    };

    // Rollback first: a reorg that already happened must not survive the pass
    // that scans past it.
    const reverted = await this.recheckRecent(chain, client, head, self);
    result.reverted = reverted.reverted;
    const revertedPayers = reverted.payers;
    if (reverted.detail) result.detail = reverted.detail;

    const finalBlock = await this.finalBlock(chain, client, head);
    result.finalBlock = finalBlock;
    if (finalBlock === null) {
      result.detail = result.detail
        ? `${result.detail}; no final block yet`
        : "no final block yet — nothing is credited from this chain";
      await this.flushCredit(revertedPayers, "revert");
      return result;
    }

    const cursor = scanCursor(this.db, chain.chainId);
    // A cursor ahead of the head means the chain went backwards (a deep reorg or
    // a provider swap). Blocks between the new head and the old cursor were
    // never scanned by this chain's new history, so restart from the lookback
    // instead of silently skipping them; the unique key makes the overlap free.
    const rewound = cursor !== null && cursor > head;
    if (rewound) {
      logger.warn(
        `watcher: ${chain.label} cursor ${cursor} is ahead of head ${head}; rescanning the lookback window`,
      );
    }
    const start = cursor === null || rewound ? Math.max(0, head - this.lookback(chain)) : cursor + 1;
    if (start > finalBlock) {
      await this.flushCredit(revertedPayers, "revert");
      return result;
    }

    result.fromBlock = start;
    let from = start;
    let requests = 0;
    const payers = new Set<string>();
    try {
      while (from <= finalBlock && requests < MAX_REQUESTS_PER_PASS) {
        const hint = this.logSpan.get(chain.chainId) ?? CHUNK_BLOCKS;
        let to = Math.min(from + hint - 1, finalBlock);
        let logs: Awaited<ReturnType<RpcClient["getLogs"]>> | null = null;
        while (logs === null) {
          requests += 1;
          try {
            logs = await client.getLogs({
              address: chain.usdc,
              fromBlock: from,
              toBlock: to,
              topics: [TRANSFER_TOPIC, null, addressTopic(self)],
            });
            this.logSpan.set(chain.chainId, to - from + 1);
          } catch (error) {
            // A provider's log-range limit is a fact about the provider, not a
            // failure of the chain: halve the window and try again. A single
            // block failing is the floor, and that is retryable.
            if (to === from) throw error;
            const span = Math.max(1, Math.floor((to - from + 1) / 2));
            logger.debug(
              `watcher: ${chain.label} getLogs ${from}..${to} failed (${shortError(error)}); retrying ${from}..${from + span - 1}`,
            );
            to = from + span - 1;
            if (requests >= MAX_REQUESTS_PER_PASS) throw error;
          }
        }
        const inserted = await this.commitChunk(chain, client, logs, to, self, payers);
        result.credited += inserted;
        result.scannedThrough = to;
        result.scannedBlocks += to - from + 1;
        from = to + 1;
      }
    } catch (error) {
      // Whatever was already committed stays committed; the cursor points at the
      // last fully scanned chunk, so the next pass resumes there.
      if (error instanceof Retryable) {
        result.detail = `${result.detail ? `${result.detail}; ` : ""}${error.message}`;
        logger.info(`watcher: ${chain.label} waiting — ${error.message}`);
      } else {
        result.detail = `${result.detail ? `${result.detail}; ` : ""}${shortError(error)}`;
        logger.warn(`watcher: ${chain.label} chunk failed: ${shortError(error)}`);
      }
      await this.flushCredit(revertedPayers, "revert");
      await this.flushCredit(payers, "credit");
      return result;
    }

    await this.recordHints(chain, client, finalBlock, self, payers, result);

    if (from <= finalBlock) {
      result.detail = `${result.detail ? `${result.detail}; ` : ""}more blocks pending (next pass continues)`;
    }
    await this.flushCredit(revertedPayers, "revert");
    await this.flushCredit(payers, "credit");
    return result;
  }

  /** The last block this chain can prove final, or null when it cannot today. */
  private async finalBlock(chain: ChainRecord, client: RpcClient, head: number): Promise<number | null> {
    if (chain.finality.mode === "confirmations") {
      const final = head - chain.finality.confirmations;
      return final >= 0 ? final : null;
    }
    try {
      const block = await client.block("finalized");
      const number = hexToNumber(block?.number);
      if (number === null) return null;
      return Math.min(number, head);
    } catch (error) {
      // A provider without the `finalized` tag cannot be used for credit on a
      // chain that needs it: guessing `latest` here would credit unfinal blocks.
      logger.warn(`watcher: ${chain.label} has no finalized block (${shortError(error)})`);
      return null;
    }
  }

  /**
   * Credits the blocks a subscription reported, without moving the cursor.
   *
   * The cursor may only advance contiguously, so a hinted block is recorded on
   * its own: what the sweep will later find there is the same row, and the unique
   * key makes the second visit free. Only blocks at or below `finalBlock` are
   * touched — a subscription reports at the head, and crediting there would be
   * crediting something that can still be reorged away.
   */
  private async recordHints(
    chain: ChainRecord,
    client: RpcClient,
    finalBlock: number,
    self: string,
    payers: Set<string>,
    result: ChainPassResult,
  ): Promise<void> {
    const hinted = this.hints.get(chain.chainId);
    if (!hinted || hinted.size === 0) return;
    const blocks = [...hinted].filter((block) => block <= finalBlock).sort((a, b) => a - b).slice(0, 32);
    if (blocks.length === 0) return;

    for (const block of blocks) {
      try {
        const logs = await client.getLogs({
          address: chain.usdc,
          fromBlock: block,
          toBlock: block,
          topics: [TRANSFER_TOPIC, null, self],
        });
        hinted.delete(block);
        const fresh: NewDeposit[] = [];
        for (const log of logs) {
          const row = this.candidate(chain, log, self);
          if (!row) continue;
          await this.verifyReceipt(client, chain, log, row);
          row.seenAt = this.now();
          fresh.push(row);
        }
        if (fresh.length === 0) continue;
        const db = this.db;
        const inserted = db.transaction(() => {
          let count = 0;
          for (const row of fresh) {
            const isNew = insertCreditedDeposit(db, row);
            const revived = isNew ? false : recreditDeposit(db, row);
            if (!isNew && !revived) continue;
            count += 1;
            payers.add(row.from);
            logger.info(
              `watcher: ${chain.label} ${revived ? "re-credited" : "credited"} ${row.amountRaw.toString()} raw ` +
                `from ${row.from} in ${row.txHash}#${row.logIndex} (block ${row.blockNumber}, via subscription)`,
            );
          }
          return count;
        })();
        result.credited += inserted;
      } catch (error) {
        // Left in the set: the next pass tries again, and the sweep covers it
        // anyway once the cursor gets there.
        logger.debug(`watcher: ${chain.label} hinted block ${block} failed (${shortError(error)})`);
      }
    }
  }

  /**
   * Verifies every candidate against its receipt and commits the rows together
   * with the cursor. Returns how many rows were new.
   */
  private async commitChunk(
    chain: ChainRecord,
    client: RpcClient,
    logs: RpcLog[],
    toBlock: number,
    self: string,
    payers: Set<string>,
  ): Promise<number> {
    const fresh: NewDeposit[] = [];
    const seenAt = this.now();

    for (const log of logs) {
      const row = this.candidate(chain, log, self);
      if (!row) continue;
      await this.verifyReceipt(client, chain, log, row);
      row.seenAt = seenAt;
      fresh.push(row);
    }

    const db = this.db;
    const write = db.transaction(() => {
      let inserted = 0;
      for (const row of fresh) {
        const isNew = insertCreditedDeposit(db, row);
        // A re-included transaction whose row was reverted earlier: the row goes
        // back to credited, because this log is final and receipt-verified.
        const revived = isNew ? false : recreditDeposit(db, row);
        if (!isNew && !revived) continue;
        inserted += 1;
        payers.add(row.from);
        logger.info(
          `watcher: ${chain.label} ${revived ? "re-credited" : "credited"} ${row.amountRaw.toString()} raw ` +
            `from ${row.from} in ${row.txHash}#${row.logIndex} (block ${row.blockNumber})`,
        );
      }
      setScanCursor(db, chain.chainId, toBlock);
      return inserted;
    });
    return write();
  }

  /** A log worth a receipt check, or null when it is not our money. */
  private candidate(chain: ChainRecord, log: RpcLog, self: string): NewDeposit | null {
    if (!log || typeof log !== "object") return null;
    if (log.removed === true) return null; // a reorged log from the provider
    if (typeof log.address !== "string" || log.address.toLowerCase() !== chain.usdc.toLowerCase()) return null;
    if (!Array.isArray(log.topics) || log.topics.length !== 3) return null;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) return null;

    const to = topicToAddress(log.topics[2]);
    if (!to || to !== self) return null;
    const from = topicToAddress(log.topics[1]);
    if (!from || from === "0x0000000000000000000000000000000000000000") return null;

    const amount = bigOrNull(log.data);
    if (amount === null || amount <= 0n) return null;

    const blockNumber = hexToNumber(log.blockNumber);
    const logIndex = hexToNumber(log.logIndex);
    if (blockNumber === null || logIndex === null) return null;
    if (typeof log.blockHash !== "string" || !log.blockHash) return null;
    if (typeof log.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) return null;

    return {
      chainId: chain.chainId,
      token: chain.usdc,
      from,
      to,
      amountRaw: amount,
      blockNumber,
      blockHash: log.blockHash.toLowerCase(),
      txHash: log.transactionHash.toLowerCase(),
      logIndex,
      seenAt: "",
    };
  }

  /**
   * The receipt is the proof that the log belongs to a successful transaction on
   * the block we think it is on. Missing or inconsistent is `Retryable`: the
   * cursor must not move past a log we could not check.
   */
  private async verifyReceipt(client: RpcClient, chain: ChainRecord, log: RpcLog, row: NewDeposit): Promise<void> {
    const receipt = await client.receipt(row.txHash);
    if (!receipt) {
      throw new Retryable(`receipt for ${row.txHash} is not available yet (block ${row.blockNumber})`);
    }
    if (receipt.status !== "0x1") {
      throw new Retryable(`receipt for ${row.txHash} has status ${String(receipt.status)}; not crediting`);
    }
    if (receipt.blockHash && receipt.blockHash.toLowerCase() !== row.blockHash) {
      throw new Retryable(`receipt for ${row.txHash} is on another block hash; waiting for a stable chain`);
    }
    const matched = (receipt.logs ?? []).some((entry) => {
      const index = hexToNumber(entry.logIndex);
      if (index !== row.logIndex) return false;
      if (typeof entry.address !== "string" || entry.address.toLowerCase() !== chain.usdc.toLowerCase()) return false;
      return entry.data === log.data && JSON.stringify(entry.topics) === JSON.stringify(log.topics);
    });
    if (!matched) {
      throw new Retryable(`receipt for ${row.txHash} does not contain log ${row.logIndex}; waiting for a stable chain`);
    }
  }

  /**
   * Re-checks the canonical block hash of recent credited rows. An RPC that
   * cannot answer is *not* a reorg: it is skipped, because reverting money on a
   * failed read would be worse than being late.
   */
  private async recheckRecent(
    chain: ChainRecord,
    client: RpcClient,
    head: number,
    self: string,
  ): Promise<{ reverted: number; payers: Set<string>; detail?: string }> {
    const payers = new Set<string>();
    const minBlock = Math.max(0, head - (this.opts.reorgWindow ?? REORG_WINDOW_BLOCKS));
    let rows;
    try {
      rows = creditedBlocksSince(this.db, self, minBlock).filter((row) => row.chain_id === chain.chainId);
    } catch (error) {
      return { reverted: 0, payers, detail: `cannot read credited rows (${shortError(error)})` };
    }
    if (rows.length === 0) return { reverted: 0, payers };

    const canonical = new Map<number, string | null>();
    const unknown = new Set<number>();
    const doomed = new Set<string>();
    const now = this.now();
    for (const row of rows) {
      if (!canonical.has(row.block_number) && !unknown.has(row.block_number)) {
        try {
          const block = await client.block(row.block_number);
          canonical.set(row.block_number, block?.hash ? block.hash.toLowerCase() : null);
        } catch (error) {
          // Unknown ≠ reorged. Try again next pass.
          logger.debug(`watcher: ${chain.label} cannot re-read block ${row.block_number}: ${shortError(error)}`);
          unknown.add(row.block_number);
        }
      }
      if (unknown.has(row.block_number)) continue;
      const current = canonical.get(row.block_number);
      if (current === undefined) continue;
      if (current === null) {
        logger.warn(`watcher: ${chain.label} block ${row.block_number} disappeared; reverting ${row.id}`);
        doomed.add(row.id);
        payers.add(row.from_addr);
        continue;
      }
      if (current !== row.block_hash.toLowerCase()) {
        logger.warn(
          `watcher: ${chain.label} block ${row.block_number} was reorged (${row.block_hash} → ${current}); ` +
            `reverting ${row.id}`,
        );
        doomed.add(row.id);
        payers.add(row.from_addr);
      }
    }
    if (doomed.size === 0) return { reverted: 0, payers };

    let reverted = 0;
    const db = this.db;
    const apply = db.transaction(() => {
      for (const id of doomed) if (markDepositReverted(db, id, now)) reverted += 1;
    });
    apply();
    return { reverted, payers };
  }

  /** Recomputes caps for the payers a pass touched, one call at a time. */
  private async flushCredit(payers: Set<string>, kind: "credit" | "revert"): Promise<void> {
    for (const payer of payers) {
      try {
        if (kind === "credit") await this.opts.credit.onDeposit(payer);
        else await this.opts.credit.onRevert(payer);
      } catch (error) {
        logger.error(`watcher: cannot resync ${payer} after a ${kind}: ${shortError(error)}`);
      }
    }
  }
}
