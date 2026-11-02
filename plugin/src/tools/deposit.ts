// claim_deposit: ask a provider to look at one transaction.
//
// The normal path is automatic: `send_payment` queues a claim when the target is
// a known provider, and the background retry delivers it. This tool is for the
// cases the automation cannot cover: a payment from an external wallet, a claim
// that exhausted its retries, or a provider that just came back online.

import { chainByKey, PRODUCT_CHAINS } from "../chain.ts";
import { depositClaim, enqueueDepositClaim, resetDepositClaim } from "../db.ts";
import { flushClaims } from "../claims.ts";
import { getRuntime } from "../runtime.ts";
import { fail, jsonText, objectArgs, requiredString, type ToolDef } from "./types.ts";
import { resolveTarget } from "./resolve.ts";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function parseLogIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    fail("E_INPUT", "logIndex must be a non-negative integer");
  }
  return parsed;
}

function claimView(row: Awaited<ReturnType<typeof depositClaim>>): Record<string, unknown> | null {
  if (!row) return null;
  return {
    state: row.state,
    attempts: row.attempts,
    lastAt: row.last_at,
    error: row.error,
  };
}

export const claimDepositTool: ToolDef = {
  description:
    "提醒提供方去链上核对某一笔 USDC 转账（消费者付款时对方离线、外部钱包付款、或自动 claim 失败时用）。" +
    "提供方只按 receipt 里的 Transfer 记账，不信消息里的金额；已入账的交易重复提交是幂等的。" +
    "交易必须是从本节点钱包发到提供方地址的 USDC transfer；外部钱包没有本节点签名，无法自动 claim。",
  args: {
    type: "object",
    properties: {
      provider: { type: "string", description: "提供方地址：0x…，或地址簿里的名字" },
      chain: { type: "string", enum: ["bsc", "base"], description: "bsc (56) 或 base (8453)" },
      txHash: { type: "string", description: "0x… 64 位交易哈希" },
      logIndex: { type: "integer", minimum: 0, description: "可选；一笔交易里有多个 Transfer 时指定" },
    },
    required: ["provider", "chain", "txHash"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const provider = await resolveTarget(requiredString(args, "provider", 64), "provider");
    const chainKey = requiredString(args, "chain", 16).toLowerCase();
    const chain = chainByKey(chainKey);
    if (!chain || !PRODUCT_CHAINS.includes(chain)) {
      fail("E_INPUT", `chain must be one of ${PRODUCT_CHAINS.map((record) => record.key).join(", ")}`);
    }
    const txHash = requiredString(args, "txHash", 80);
    if (!TX_HASH_RE.test(txHash)) fail("E_INPUT", "txHash must be a 0x… 64-hex transaction hash");
    const logIndex = parseLogIndex(args.logIndex);

    const runtime = await getRuntime();
    let row = depositClaim(runtime.db, chain.chainId, txHash);
    if (row?.state === "failed") {
      resetDepositClaim(runtime.db, chain.chainId, txHash);
      row = depositClaim(runtime.db, chain.chainId, txHash);
    }
    if (row?.state !== "credited") {
      row = enqueueDepositClaim(runtime.db, {
        provider,
        chainId: chain.chainId,
        txHash,
        ...(logIndex !== undefined ? { logIndex } : {}),
        at: new Date().toISOString(),
      });
    }
    const claimId = row?.id;
    if (claimId) await flushClaims(true, claimId);
    row = depositClaim(runtime.db, chain.chainId, txHash) ?? row;
    return jsonText({
      provider,
      chain: chain.key,
      chainId: chain.chainId,
      txHash: txHash.toLowerCase(),
      ...(logIndex !== undefined ? { logIndex } : {}),
      claim: claimView(row),
    });
  },
};
