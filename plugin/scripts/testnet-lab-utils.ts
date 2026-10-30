// Pure checks for the disposable testnet lab, not production payment policy.
export function labAmount(decimals: number, raw?: string): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid token decimals");
  if (raw !== undefined && !/^[0-9]+$/.test(raw)) throw new Error("--amount must be positive base units");
  const amount = raw === undefined ? 10n ** BigInt(decimals) : BigInt(raw);
  // The lab uses one test USD per token. Reject dust before sending anything.
  const nanos = (amount * 1_000_000_000n) / 10n ** BigInt(decimals);
  if (amount <= 0n || nanos <= 0n || nanos > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("the test amount must convert to a positive, safe nano-USD amount");
  }
  return amount;
}

export function castReceipt(text: string): { transactionHash: string; status: string; [key: string]: unknown } {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.success === false) {
    const errors = Array.isArray(value.errors) ? value.errors : [];
    throw new Error(`cast send failed: ${errors.map((e) => String(e?.message ?? e)).join("; ") || "unknown error"}`);
  }
  if (typeof value.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash)) {
    throw new Error("cast send returned no transaction hash; inspect chain state before retrying");
  }
  if (value.status !== "0x1" && value.status !== "1" && value.status !== 1) {
    throw new Error(`transaction ${value.transactionHash} did not return a successful receipt`);
  }
  return value as { transactionHash: string; status: string; [key: string]: unknown };
}
