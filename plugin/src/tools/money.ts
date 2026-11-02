// The money tools: `send_payment` and `history`.
//
// Sending is agent-native by design (D11): no confirmation step, no target
// allowlist, no journal. One call is one ERC-20 transfer, broadcast once. If the
// broadcast cannot be confirmed the answer is `unknown` with the hash of the
// signed bytes — never a resend, because a second send is a second payment.
//
// `history` is the local view: credited (and reverted) deposits plus the payouts
// this wallet made. It is not a statement and not a reconciliation: the chain is
// the truth, this is just what this node has seen.

import type { Database } from "bun:sqlite";
import { formatEther, type Wallet } from "ethers";
import {
  PRODUCT_CHAINS,
  TxUnknownError,
  chainByKey,
  clientFor,
  formatTokenAmount,
  parseAmountRaw,
  prepareNativeTransfer,
  prepareUsdcTransfer,
  sendPreparedNative,
  sendPreparedUsdc,
  type ChainRecord,
  type RpcClient,
} from "../chain.ts";
import { enqueueDepositClaim, listDeposits, listPayouts, recordPayout, setPayoutState } from "../db.ts";
import { flushClaims } from "../claims.ts";
import { getRuntime } from "../runtime.ts";
import {
  fail,
  jsonText,
  objectArgs,
  optionalBoolean,
  optionalString,
  requiredString,
  type ToolDef,
} from "./types.ts";
import { resolveTarget } from "./resolve.ts";
import { knownPeer } from "./discover.ts";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

export interface SendPaymentResult {
  state: "sent" | "unknown";
  /** which asset moved: USDC has a claim path; native is gas money only */
  asset: "usdc" | "native";
  txHash: string;
  chain: string;
  chainId: number;
  to: string;
  amountRaw: string;
  /** present for `unknown` only: what to do instead of calling again */
  detail?: string;
}

export interface SendDeps {
  ledger: Database;
  wallet: Wallet;
  /** injection point for a self-check; production uses the chain registry */
  client?: (chain: ChainRecord) => RpcClient;
  now?: () => string;
}

/**
 * Validates the wallet's funds and sends one transfer.
 *
 * Order matters: the gas check comes first because "no BNB for fees" is the most
 * common failure and needs its own message, and the USDC balance is
 * checked before signing so a doomed transaction is never broadcast.
 */
export async function executeSendPayment(
  chain: ChainRecord,
  to: string,
  amountText: string,
  deps: SendDeps,
): Promise<SendPaymentResult> {
  const amountRaw = parseAmountRaw(amountText, chain.decimals);
  const client = (deps.client ?? ((record) => clientFor(record)))(chain);
  const from = deps.wallet.address;
  const now = deps.now ?? (() => new Date().toISOString());

  const native = await client.balance(from);
  if (native === 0n) {
    fail(
      "E_BALANCE",
      `the node wallet ${from} has no ${chain.nativeSymbol} on ${chain.label} for gas; ` +
        `send a small amount of ${chain.nativeSymbol} to it and try again`,
    );
  }

  // Checked before the estimate: `eth_estimateGas` on a transfer that would
  // overdraw reverts, and "not enough USDC" is the honest answer to that.
  const balance = await client.erc20Balance(chain.usdc, from);
  if (balance < amountRaw) {
    fail(
      "E_BALANCE",
      `the node wallet holds ${formatTokenAmount(balance, chain.decimals)} USDC on ${chain.label} but the ` +
        `transfer asks for ${formatTokenAmount(amountRaw, chain.decimals)}`,
    );
  }

  const prepared = await prepareUsdcTransfer(client, chain, from, to, amountRaw);
  if (native < prepared.fee) {
    fail(
      "E_BALANCE",
      `the node wallet has ${formatEther(native)} ${chain.nativeSymbol} on ${chain.label} but this transfer ` +
        `needs about ${formatEther(prepared.fee)} ${chain.nativeSymbol} of gas; top it up and try again`,
    );
  }

  try {
    const sent = await sendPreparedUsdc({ chain, wallet: deps.wallet, client, prepared });
    recordPayout(deps.ledger, {
      txHash: sent.txHash,
      chainId: chain.chainId,
      token: chain.usdc,
      to,
      amountRaw,
      state: "sent",
      at: now(),
    });
    return {
      state: "sent",
      asset: "usdc",
      txHash: sent.txHash,
      chain: chain.key,
      chainId: chain.chainId,
      to,
      amountRaw: amountRaw.toString(),
    };
  } catch (error) {
    if (error instanceof TxUnknownError) {
      recordPayout(deps.ledger, {
        txHash: error.txHash,
        chainId: chain.chainId,
        token: chain.usdc,
        to,
        amountRaw,
        state: "unknown",
        at: now(),
      });
      return {
        state: "unknown",
        asset: "usdc",
        txHash: error.txHash,
        chain: chain.key,
        chainId: chain.chainId,
        to,
        amountRaw: amountRaw.toString(),
        detail:
          "the broadcast could not be confirmed. The signed transaction may still be mined — check the hash " +
          "on a block explorer or with history before sending again. This tool never resends.",
      };
    }
    throw error;
  }
}

/**
 * Sends the chain's native coin (BNB/ETH). This is deliberately separate from
 * the deposit claim path: native money is gas for a human, not provider credit,
 * and it never enters `localSentUsd`/`providerBehind`.
 */
export async function executeSendNative(
  chain: ChainRecord,
  to: string,
  amountText: string,
  deps: SendDeps,
): Promise<SendPaymentResult> {
  const amountRaw = parseAmountRaw(amountText, 18);
  const client = (deps.client ?? ((record) => clientFor(record)))(chain);
  const from = deps.wallet.address;
  const now = deps.now ?? (() => new Date().toISOString());

  const native = await client.balance(from);
  if (native < amountRaw) {
    fail(
      "E_BALANCE",
      `the node wallet holds ${formatEther(native)} ${chain.nativeSymbol} on ${chain.label} but the ` +
        `transfer asks for ${formatEther(amountRaw)} ${chain.nativeSymbol}`,
    );
  }

  const prepared = await prepareNativeTransfer(client, chain, from, to, amountRaw);
  if (native < amountRaw + prepared.fee) {
    fail(
      "E_BALANCE",
      `the node wallet has ${formatEther(native)} ${chain.nativeSymbol} on ${chain.label} but this transfer ` +
        `needs ${formatEther(amountRaw + prepared.fee)} ${chain.nativeSymbol} including gas; top it up and try again`,
    );
  }

  try {
    const sent = await sendPreparedNative({ chain, wallet: deps.wallet, client, prepared });
    recordPayout(deps.ledger, {
      txHash: sent.txHash,
      chainId: chain.chainId,
      token: "native",
      to,
      amountRaw,
      state: "sent",
      at: now(),
    });
    return {
      state: "sent",
      asset: "native",
      txHash: sent.txHash,
      chain: chain.key,
      chainId: chain.chainId,
      to,
      amountRaw: amountRaw.toString(),
    };
  } catch (error) {
    if (error instanceof TxUnknownError) {
      recordPayout(deps.ledger, {
        txHash: error.txHash,
        chainId: chain.chainId,
        token: "native",
        to,
        amountRaw,
        state: "unknown",
        at: now(),
      });
      return {
        state: "unknown",
        asset: "native",
        txHash: error.txHash,
        chain: chain.key,
        chainId: chain.chainId,
        to,
        amountRaw: amountRaw.toString(),
        detail:
          "the broadcast could not be confirmed. The signed transaction may still be mined — check the hash " +
          "on a block explorer or with history before sending again. This tool never resends.",
      };
    }
    throw error;
  }
}

export interface HistoryDeps {
  ledger: Database;
  /** this node's address: deposits are credited to it */
  address: string;
  addressFilter?: string;
  limit?: number;
  now?: () => string;
}

export interface HistoryResult {
  deposits: {
    chain: string | null;
    chainId: number;
    token: string;
    from: string;
    to: string;
    amountRaw: string;
    amountUsd: string;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    state: string;
    creditedAt: string | null;
    revertedAt: string | null;
  }[];
  payouts: {
    chain: string | null;
    chainId: number;
    token: string;
    asset: "usdc" | "native";
    to: string;
    amountRaw: string;
    amountUsd: string;
    state: string;
    txHash: string;
    createdAt: string;
  }[];
  asOf: string;
}

/**
 * Local deposits and payouts, newest first. `amountUsd` is the raw amount with
 * the chain's own decimals — never a converted or rounded value.
 */
export function paymentHistory(deps: HistoryDeps): HistoryResult {
  const limit = clampLimit(deps.limit);
  const deposits = listDeposits(deps.ledger, {
    toAddr: deps.address,
    ...(deps.addressFilter ? { fromAddr: deps.addressFilter } : {}),
    limit,
  }).map((row) => {
    const chain = PRODUCT_CHAINS.find((record) => record.chainId === row.chain_id) ?? null;
    return {
      chain: chain?.key ?? null,
      chainId: row.chain_id,
      token: row.token,
      from: row.from_addr,
      to: row.to_addr,
      amountRaw: row.amount_raw,
      amountUsd: formatTokenAmount(row.amount_raw, chain?.decimals ?? 0),
      txHash: row.tx_hash,
      logIndex: row.log_index,
      blockNumber: row.block_number,
      state: row.state,
      creditedAt: row.credited_at,
      revertedAt: row.reverted_at,
    };
  });
  const payouts = listPayouts(deps.ledger, limit).map((row) => {
    const chain = PRODUCT_CHAINS.find((record) => record.chainId === row.chain_id) ?? null;
    const native = row.token.toLowerCase() === "native";
    return {
      chain: chain?.key ?? null,
      chainId: row.chain_id,
      token: row.token,
      asset: (native ? "native" : "usdc") as "native" | "usdc",
      to: row.to_addr,
      amountRaw: row.amount_raw,
      amountUsd: formatTokenAmount(row.amount_raw, native ? 18 : chain?.decimals ?? 0),
      state: row.state,
      txHash: row.tx_hash,
      createdAt: row.created_at,
    };
  });
  return { deposits, payouts, asOf: (deps.now ?? (() => new Date().toISOString()))() };
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("E_INPUT", `limit must be a positive integer, got ${String(value)}`);
  }
  return Math.min(value, MAX_HISTORY_LIMIT);
}

const SEND_ARGS = {
  type: "object",
  properties: {
    chain: {
      type: "string",
      enum: ["bsc", "base"],
      description: "bsc (56) or base (8453)",
    },
    to: {
      type: "string",
      description: "收款地址：任意 EVM 地址（包括交易所充值地址），或地址簿里的名字（contacts）",
    },
    amount: {
      type: "string",
      description: 'USDC 数量，十进制字符串，例如 "1.25"；不接受浮点数，不接受超过该链小数位的位数',
    },
    asset: {
      type: "string",
      enum: ["usdc", "native"],
      description: '可选；默认 "usdc"。native = 该链原生币（BSC 的 BNB / Base 的 ETH），只用于给地址转 gas',
    },
    claim: {
      type: "boolean",
      description:
        "已知提供方默认 true：付款后自动投递入账 claim；传 false 则只转账、不通知提供者（赠送/不记额度），以后仍可用 claim_deposit 手动补",
    },
  },
  required: ["chain", "to", "amount"],
  additionalProperties: false,
};

export const sendPaymentTool: ToolDef = {
  description:
    "从节点钱包发送 USDC（BSC 或 Base）到任意地址：出金、给提供方充值都用它。无二次确认、无目标白名单。" +
    '成功返回 state:"sent"；广播无法确认时返回 state:"unknown" 并给出已签名交易的哈希，工具不会重发——' +
    "先核对再决定。需要该链的原生币付 gas。目标是已知提供方时默认自动排队一条入账 claim（claim:queued），" +
    "提供者离线也不影响付款，后台会重试；传 claim:false 则不投递、当赠送，之后仍可用 claim_deposit 手动补；" +
    "外部钱包转账用 claim_deposit。",
  args: SEND_ARGS,
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const chainKey = requiredString(args, "chain", 16).toLowerCase();
    const chain = chainByKey(chainKey);
    if (!chain || !PRODUCT_CHAINS.includes(chain)) {
      fail("E_INPUT", `chain must be one of ${PRODUCT_CHAINS.map((record) => record.key).join(", ")}`);
    }
    const asset = (optionalString(args, "asset", 16) ?? "usdc").toLowerCase();
    if (asset !== "usdc" && asset !== "native") {
      fail("E_INPUT", `asset must be "usdc" or "native", not ${JSON.stringify(asset)}`);
    }
    const to = await resolveTarget(requiredString(args, "to", 64), "to");
    const amount = requiredString(args, "amount", 80);
    const claimEnabled = args.claim === undefined || args.claim === null ? true : optionalBoolean(args, "claim");

    const runtime = await getRuntime();
    const result =
      asset === "native"
        ? await executeSendNative(chain, to, amount, { ledger: runtime.db, wallet: runtime.wallet })
        : await executeSendPayment(chain, to, amount, { ledger: runtime.db, wallet: runtime.wallet });
    let claimQueued = false;
    if (result.asset === "usdc" && (result.state === "sent" || result.state === "unknown")) {
      if (!claimEnabled) {
        // Deliberate gift: keep the on-chain payout in history, but exclude it
        // from "local sent vs provider balance" so it is not reported as a
        // provider lag. claim_deposit can still claim it later.
        try {
          setPayoutState(runtime.db, result.txHash, "gift");
        } catch {
          /* the payment is already on chain; a label failure is not fatal */
        }
      } else {
        // A payment is already on chain; the claim is just a hint. Queue it only
        // when the target is a known provider, so sending to an arbitrary
        // address does not leave forever-pending claim rows. The background
        // retry delivers it even if the provider is offline now.
        const knownProvider =
          runtime.config.connections.some((connection) => connection.provider === to) || knownPeer(to);
        if (knownProvider) {
          try {
            enqueueDepositClaim(runtime.db, {
              provider: to,
              chainId: chain.chainId,
              txHash: result.txHash,
              at: new Date().toISOString(),
            });
            claimQueued = true;
            void flushClaims();
          } catch {
            // The payment is already on chain; a local queue failure must not turn
            // a successful send into an error. claim_deposit can retry by hand.
          }
        }
      }
    }
    return jsonText({
      ...result,
      ...(claimQueued ? { claim: "queued" } : {}),
      ...(!claimEnabled && result.asset === "usdc" && (result.state === "sent" || result.state === "unknown")
        ? { claim: "suppressed" }
        : {}),
      ...(result.asset === "native" ? { claim: "not_applicable" } : {}),
    });
  },
};

export const historyTool: ToolDef = {
  description:
    "本地账目：已确认（以及已回滚）的入账，加上本钱包的出金。limit 默认 50、上限 200；" +
    "address 只过滤某个付款方的入账。金额是该链资产的十进制值（USDC 或原生币），不做换算。",
  args: {
    type: "object",
    properties: {
      address: { type: "string", description: "只看这个付款方的入账：0x… 地址，或地址簿里的名字" },
      limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY_LIMIT, description: "默认 50，上限 200" },
    },
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const addressFilter =
      args.address === undefined || args.address === null
        ? undefined
        : await resolveTarget(requiredString(args, "address", 64), "address");
    const rawLimit = args.limit;
    let limit: number | undefined;
    if (rawLimit !== undefined && rawLimit !== null) {
      const parsed = typeof rawLimit === "string" ? Number(rawLimit) : rawLimit;
      if (typeof parsed !== "number") fail("E_INPUT", "limit must be an integer");
      limit = parsed;
    }
    const runtime = await getRuntime();
    return jsonText(
      paymentHistory({
        ledger: runtime.db,
        address: runtime.wallet.address,
        ...(addressFilter ? { addressFilter } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
  },
};
