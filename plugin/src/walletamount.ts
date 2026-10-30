// Exact token amounts: decimal text <-> integer base units.
//
// Token amounts are never floats. A wrong last base unit is not a rounding
// difference here: `matchesTransfer()` requires the transferred amount to equal
// the intent's `expectedAmountRaw` exactly, so an amount that is off by one unit
// becomes `unclaimed` rather than "slightly less credit".
//
// USD is deliberately the secondary input. The product cannot offer a USD
// inverse price (the registry rate is a test display rate, not an oracle), so the
// wizard asks for a token amount and only *shows* the USD estimate. `rawForUsd`
// exists for an operator who insists, and it reports whether the conversion was
// exact instead of silently rounding.

import { nanosToUsd, usdToNanos } from "./pricing.ts";

export type ParsedAmount = { ok: true; raw: string; normalised: string; decimals: number } | { ok: false; reason: string };

/**
 * Parses a plain decimal amount ("1", "1.5", "0.000001") into base units.
 *
 * Rejected rather than silently normalised: a sign, an exponent, a comma, a
 * negative value, or more fraction digits than the token has. Trailing zeros are
 * allowed and trimmed.
 */
export function parseTokenAmount(text: string, decimals: number): ParsedAmount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { ok: false, reason: `unusable decimals value ${decimals}` };
  const value = String(text ?? "").trim();
  if (!value) return { ok: false, reason: "an amount is required" };
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return { ok: false, reason: "write the amount as plain digits, optionally with one decimal point (no sign, exponent or separator)" };
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    return {
      ok: false,
      reason:
        decimals === 0
          ? "this token has no decimals; a fractional amount cannot be paid exactly"
          : `this token has ${decimals} decimals; ${fraction.length} fraction digits cannot be represented exactly`,
    };
  }
  const raw = BigInt(whole + fraction.padEnd(decimals, "0")).toString();
  return { ok: true, raw, normalised: formatTokenAmount(raw, decimals), decimals };
}

/** Renders base units as the exact decimal amount, without trailing zeros. */
export function formatTokenAmount(raw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`unusable decimals value ${decimals}`);
  if (!/^\d+$/.test(String(raw))) throw new Error("a raw amount must be a non-negative integer string");
  const value = BigInt(raw).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return value;
  const whole = value.slice(0, -decimals);
  const fraction = value.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The raw amount that best represents `usd` at a fixed test rate.
 *
 * `exact` is false when the rate cannot represent the amount in whole base
 * units, and the caller must show that instead of pretending. The resulting raw
 * converts back to *at most* `usd` nano-USD, never more.
 */
export function rawForUsd(input: { usd: number; decimals: number; nanosPerToken: string }): { raw: string; exact: boolean; note: string } {
  if (typeof input.usd !== "number" || !Number.isFinite(input.usd) || input.usd <= 0) {
    throw new Error("a USD amount must be a positive finite number");
  }
  const perToken = BigInt(input.nanosPerToken);
  if (perToken <= 0n) throw new Error("the asset has no usable test rate");
  const scale = 10n ** BigInt(input.decimals);
  const nanos = BigInt(usdToNanos(input.usd));
  const numerator = nanos * scale;
  const raw = numerator / perToken;
  const remainder = numerator % perToken;
  // Zero base units is never a payable request, even when the division is exact.
  const exact = remainder === 0n && raw > 0n;
  if (raw === 0n) {
    return {
      raw: "0",
      exact: false,
      note: "the recorded test rate cannot represent this USD amount in whole base units; it is below one base unit",
    };
  }
  return {
    raw: raw.toString(),
    exact,
    note: exact
      ? `${formatTokenAmount(raw.toString(), input.decimals)} tokens at the recorded test rate`
      : `${formatTokenAmount(raw.toString(), input.decimals)} tokens; the recorded test rate cannot represent this USD amount exactly, so the credit is lower by less than one base unit`,
  };
}

/** The ledger's nano-USD value of a raw amount, at a fixed rate (floor). */
export function usdForRaw(input: { raw: string; decimals: number; nanosPerToken: string }): number {
  const perToken = BigInt(input.nanosPerToken);
  if (perToken <= 0n) throw new Error("the asset has no usable test rate");
  if (!/^\d+$/.test(String(input.raw))) throw new Error("a raw amount must be a non-negative integer string");
  const scale = 10n ** BigInt(input.decimals);
  return nanosToUsd(Number((BigInt(input.raw) * perToken) / scale));
}
