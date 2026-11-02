// The consumer's side of a deposit claim: "please look at this transaction".
//
// The payment is already on chain when this queue gets an entry, so a failed
// delivery is never a failed payment. The row stays pending, is retried with
// backoff, and survives a restart; the provider verifies the transaction when it
// is next reachable. This module deliberately has no authority to credit
// anything.

import { catalogTimestamp } from "./catalog-service.ts";
import {
  listPendingDepositClaims,
  markDepositClaimAttempt,
  markDepositClaimCredited,
  markDepositClaimFailed,
  type DepositClaimRow,
} from "./db.ts";
import { depositPayload } from "./http-router.ts";
import { logger } from "./log.ts";
import { CONTROL_PORT, SOCKS_PORT } from "./overlay.ts";
import { getRuntime } from "./runtime.ts";
import { signCanonical } from "./signing.ts";
import { socksHttpRequest } from "./socks.ts";
import { peerEndpoint } from "./tools/discover.ts";

const CLAIM_TIMEOUT_MS = 12_000;
const MAX_PEER_BYTES = 64 * 1024;
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;
/** A claim is the provider's hint to look at a receipt; never let it flood. */
const FLUSH_BATCH = 50;

let flushing = false;
let timer: ReturnType<typeof setInterval> | null = null;

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

function due(row: DepositClaimRow, now: number): boolean {
  if (!row.last_at) return true;
  const last = Date.parse(row.last_at);
  if (!Number.isFinite(last)) return true;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(row.attempts, 5));
  return now >= last + delay;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Sends every due pending claim once. A row whose provider is offline stays
 * pending; a row whose transaction is not visible yet stays pending; only a
 * provider that says "failed" ends it. The queue is cleared by credit, not by
 * an arbitrary retry budget.
 */
export async function flushClaims(force = false, only?: string): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const runtime = await getRuntime();
    const rows = listPendingDepositClaims(runtime.db, only ? 500 : FLUSH_BATCH).filter((row) => !only || row.id === only);
    for (const row of rows) {
      if (!force && !due(row, Date.now())) continue;

      let endpoint;
      try {
        endpoint = await peerEndpoint(row.provider);
      } catch (error) {
        markDepositClaimAttempt(runtime.db, row.id, nowIso(), `provider offline: ${shortError(error)}`);
        continue;
      }

      const ts = catalogTimestamp();
      const payload = depositPayload(
        runtime.wallet.address.toLowerCase(),
        row.chain_id,
        row.tx_hash,
        row.log_index ?? undefined,
        ts,
      );
      let response: { status: number; body: string };
      try {
        const sig = await signCanonical(runtime.wallet, payload);
        response = await socksHttpRequest({
          socksPort: SOCKS_PORT,
          host: endpoint.host,
          port: CONTROL_PORT,
          path: "/deposit",
          method: "POST",
          body: JSON.stringify({ ...payload, sig }),
          timeoutMs: CLAIM_TIMEOUT_MS,
          maxBytes: MAX_PEER_BYTES,
        });
      } catch (error) {
        markDepositClaimAttempt(runtime.db, row.id, nowIso(), `cannot reach provider: ${shortError(error)}`);
        continue;
      }

      let ack: { state?: unknown; detail?: unknown; error?: unknown };
      try {
        ack = JSON.parse(response.body) as typeof ack;
      } catch {
        ack = {};
      }
      if (response.status !== 200) {
        const detail =
          typeof ack.error === "string" ? ack.error : response.body.trim().slice(0, 200) || `HTTP ${response.status}`;
        markDepositClaimAttempt(runtime.db, row.id, nowIso(), `provider answered HTTP ${response.status}: ${detail}`);
        continue;
      }
      const state = typeof ack.state === "string" ? ack.state : "pending";
      if (state === "credited" || state === "already") {
        markDepositClaimCredited(runtime.db, row.id, nowIso());
        logger.info(`claim: provider <= ${row.provider} ${state} ${row.tx_hash}`);
        continue;
      }
      if (state === "failed") {
        const detail = typeof ack.detail === "string" ? ack.detail : "provider says the transaction failed";
        markDepositClaimFailed(runtime.db, row.id, nowIso(), detail);
        logger.warn(`claim: provider <= ${row.provider} rejected ${row.tx_hash}: ${detail}`);
        continue;
      }
      const detail = typeof ack.detail === "string" ? ack.detail : `state ${state}`;
      markDepositClaimAttempt(runtime.db, row.id, nowIso(), detail);
    }
  } catch (error) {
    logger.warn(`claim queue: flush failed: ${shortError(error)}`);
  } finally {
    flushing = false;
  }
}

/** Starts the 30-second retry loop. A second call is a no-op. */
export function startClaimRetry(): void {
  if (timer) return;
  timer = setInterval(() => void flushClaims(), 30_000);
  timer.unref?.();
  void flushClaims();
}
