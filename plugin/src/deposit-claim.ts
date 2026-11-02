// A consumer's "please look at this transaction" hint, verified on chain.
//
// A consumer that paid while the provider was offline sends the tx hash (and,
// when it has one, the log index). This module turns that pointer into the same
// deposit row, using one receipt read instead of a block-range scan. The claim
// itself is never trusted: the payer, amount, token and recipient all come from
// the receipt's Transfer log.

import type { Database } from "bun:sqlite";
import {
  TRANSFER_TOPIC,
  chainById,
  clientFor,
  finalBlockFor,
  topicToAddress,
  type ChainRecord,
  type RpcClient,
  type RpcLog,
} from "./chain.ts";
import { insertCreditedDeposit, recreditDeposit, type NewDeposit } from "./db.ts";
import { logger } from "./log.ts";
import type { AccountSummary, Grants } from "./grants.ts";

export interface DepositClaimInput {
  /** the signer, already recovered by the HTTP route */
  payer: string;
  chainId: number;
  txHash: string;
  /** optional: select one Transfer when the transaction carries several */
  logIndex?: number;
}

export interface ClaimedLog {
  logIndex: number;
  from: string;
  amountRaw: string;
  /** true when this claim created or revived the row */
  newlyCredited: boolean;
}

export interface DepositClaimResult {
  state: "credited" | "already" | "pending" | "failed" | "not_found";
  chainId: number;
  txHash: string;
  chain?: string;
  detail?: string;
  blockNumber?: number;
  finalBlock?: number | null;
  credited?: ClaimedLog[];
  account?: AccountSummary;
  ts: string;
}

export interface DepositClaimOptions {
  db: Database;
  /** the provider's address; a getter because wallet_import can replace it */
  address: () => string;
  grants: Grants;
  /** test seam; production uses the registered chain endpoints */
  client?: (chain: ChainRecord) => RpcClient;
  now?: () => string;
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

/**
 * Verifies and credits one claimed transaction. A missing receipt, an unfinal
 * block or an unavailable RPC is `pending`: the consumer retries, and nothing is
 * credited until the chain can prove it.
 */
export class DepositClaimService {
  constructor(private readonly opts: DepositClaimOptions) {}

  private get db(): Database {
    return this.opts.db;
  }

  private now(): string {
    return (this.opts.now ?? (() => new Date().toISOString()))();
  }

  async claim(input: DepositClaimInput): Promise<DepositClaimResult> {
    const ts = this.now();
    const payer = input.payer.toLowerCase();
    const txHash = input.txHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      return { state: "failed", chainId: input.chainId, txHash, detail: "txHash is not a 32-byte hex hash", ts };
    }
    const chain = chainById(input.chainId);
    if (!chain) {
      return { state: "failed", chainId: input.chainId, txHash, detail: `chain ${input.chainId} is not registered`, ts };
    }
    if (input.logIndex !== undefined && (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0)) {
      return { state: "failed", chainId: chain.chainId, chain: chain.key, txHash, detail: "logIndex is invalid", ts };
    }

    const client = (this.opts.client ?? ((record) => clientFor(record)))(chain);
    const receipt = await client.receipt(txHash);
    if (!receipt) {
      return {
        state: "pending",
        chainId: chain.chainId,
        chain: chain.key,
        txHash,
        detail: "the transaction is not visible yet",
        ts,
      };
    }
    if (receipt.status !== "0x1") {
      return {
        state: "failed",
        chainId: chain.chainId,
        chain: chain.key,
        txHash,
        detail: `the transaction is not successful (status ${String(receipt.status)})`,
        ts,
      };
    }

    const blockNumber = hexToNumber(receipt.blockNumber);
    const blockHash = typeof receipt.blockHash === "string" ? receipt.blockHash.toLowerCase() : "";
    if (blockNumber === null || !blockHash) {
      return {
        state: "pending",
        chainId: chain.chainId,
        chain: chain.key,
        txHash,
        detail: "the receipt has no final block yet",
        ts,
      };
    }

    const head = await client.head();
    const finalBlock = await finalBlockFor(chain, client, head);
    if (finalBlock === null || blockNumber > finalBlock) {
      return {
        state: "pending",
        chainId: chain.chainId,
        chain: chain.key,
        txHash,
        blockNumber,
        finalBlock,
        detail: "waiting for finality",
        ts,
      };
    }

    const provider = this.opts.address().toLowerCase();
    const entries = Array.isArray(receipt.logs) ? receipt.logs : [];
    const rows: NewDeposit[] = [];
    for (const entry of entries) {
      if (typeof entry.address !== "string" || entry.address.toLowerCase() !== chain.usdc.toLowerCase()) continue;
      if (!Array.isArray(entry.topics) || entry.topics.length !== 3) continue;
      if (entry.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
      if (topicToAddress(entry.topics[2]) !== provider) continue;
      const from = topicToAddress(entry.topics[1]);
      if (!from || from !== payer) continue;
      const amountRaw = bigOrNull(entry.data);
      if (amountRaw === null || amountRaw <= 0n) continue;
      const logIndex = hexToNumber(entry.logIndex);
      if (logIndex === null) continue;
      if (input.logIndex !== undefined && input.logIndex !== logIndex) continue;
      rows.push({
        chainId: chain.chainId,
        token: chain.usdc,
        from,
        to: provider,
        amountRaw,
        blockNumber,
        blockHash,
        txHash,
        logIndex,
        seenAt: ts,
      });
    }

    if (rows.length === 0) {
      return {
        state: "not_found",
        chainId: chain.chainId,
        chain: chain.key,
        txHash,
        blockNumber,
        finalBlock,
        detail: input.logIndex === undefined
          ? "no Transfer to this provider from the claimed address in that transaction"
          : `no Transfer with logIndex ${input.logIndex} to this provider from the claimed address`,
        ts,
      };
    }

    const db = this.db;
    const credited: ClaimedLog[] = [];
    let created = 0;
    db.transaction(() => {
      for (const row of rows) {
        const inserted = insertCreditedDeposit(db, row);
        const revived = inserted ? false : recreditDeposit(db, row);
        if (inserted || revived) created += 1;
        credited.push({ logIndex: row.logIndex, from: row.from, amountRaw: row.amountRaw.toString(), newlyCredited: inserted || revived });
        logger.info(
          `claim: ${chain.label} ${inserted ? "credited" : revived ? "re-credited" : "already credited"} ` +
            `${row.amountRaw.toString()} raw from ${row.from} in ${row.txHash}#${row.logIndex}`,
        );
      }
    })();

    if (created > 0) {
      try {
        await this.opts.grants.onDeposit(payer);
      } catch (error) {
        logger.error(`claim: ${payer} was credited but its cap/key could not be updated: ${String(error)}`);
      }
    }
    const account = this.opts.grants.summary(payer);
    return {
      state: created > 0 ? "credited" : "already",
      chainId: chain.chainId,
      chain: chain.key,
      txHash,
      blockNumber,
      finalBlock,
      credited,
      account,
      ts,
    };
  }
}

/** A route-facing interface, kept small so the HTTP module has no chain logic. */
export interface DepositClaimer {
  claim(input: DepositClaimInput): Promise<DepositClaimResult>;
}

/** Re-exported for tests and tools that only need the log shape. */
export type { RpcLog };
