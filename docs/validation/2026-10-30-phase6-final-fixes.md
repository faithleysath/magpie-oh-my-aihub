# Phase 6 final targeted patch — an unverifiable check and an unresolved log gap

Scope: the two ways an uncertain state could still be reported as safe, raised against PR #7 at
`9bd99fa`. Both were reproduced against that HEAD before being fixed. No wallet, chain watcher,
market feature or new proxy is added; this is the last patch on PR #7.

| Item | Value |
| --- | --- |
| Platform | macOS 26.6.2 (25G83), arm64 |
| Magpie | `0.1.2038`, tag `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| Lab | portable copy, gateway `127.0.0.1:3446`, deterministic mock upstream `127.0.0.1:19080` |
| Reviewed HEAD | `9bd99fa99c5df8b90f9d66915ea90a17f5eb101f` |
| Fixed HEAD | the PR's last commit |
| Money | simulated deposits and synthetic usage only |

---

## 1. Summary

| # | Defect | Status |
| --- | --- | --- |
| A | an unreadable limit read was counted as a healthy check | **CONFIRMED → FIXED** |
| B | `reissue()` ignored a usage-log gap | **CONFIRMED → FIXED** |

No item in this round was a false positive; both reproductions are quoted below.

---

## 2. A — an unreadable limit must fail the check

**CONFIRMED.** `ledgerCheck()` caught a `verify()` throw and returned `reason: "unreadable"`.
`checkConsumer()` turned that into a normal `ConsumerView`, so `runAccountingCheck()` saw no
exception, reset `failures` to 0 and set `lastOkAt`. A gateway that keeps accepting AI calls while
`GET /v1/magpie/limit` fails could therefore serve indefinitely while nobody could prove the books.

Reproduction (unit, on `9bd99fa`): with `limitReadFails = true` and a settled call, `checkConsumer`
resolved instead of rejecting, and the periodic check reported `failures: 0`.

**FIXED.**

- `ledgerCheck()` now returns `verified: false` plus the reason. A transient read error and a real
  cap mismatch stay different things — the first does not pause a key, the second does — but neither
  is a pass.
- `checkConsumer()` throws `VerificationUnavailableError`, so the service counts it as a failure.
  `lastOkAt` only moves on a check that verified every consumer; `failures`, `uncertain`,
  `uncertainReason` and `serving` come from the real result.
- After `accountingFailureBudget` (3) consecutive failures the export is withdrawn with an
  `accounting-uncertain:` reason. Recovery republishes only after a full re-validation of every
  consumer, and it refuses while any consumer's charges are still uncertain.
- A consumer whose limit cannot be read is marked `ledgerUncertain` (not reported as healthy) but is
  not paused for an outage alone: an unreadable endpoint is not evidence of fraud.

Real Magpie, plugin pointed at a closed port while the gateway kept serving:

```text
CALL_OK              200
READ_FAILURE_CHECK   rejected: finallab1: cannot verify the gateway key's limit: … ECONNREFUSED …
CALL_DURING_OUTAGE   200          # the gateway really was still accepting AI calls
AFTER_RESTORE        {"paused":null,"balance":0.6988}
```

Unit coverage: the failure propagates, three failures withdraw sharing while calls still succeed,
and recovery restores service only after re-verification and still allows a normal top-up.

---

## 3. B — a log gap must block reissue

**CONFIRMED.** `reissue()` called `ledger.importUsage()` and discarded the returned `gap`, and the
gap only existed in that return value. A truncated log therefore produced no persisted uncertainty,
and `reissue()` created a key with a balance the plugin could not prove.

Reproduction (unit, on `9bd99fa`): record a charge, roll the window, truncate `usage.jsonl`, then
`reissue()` — it **succeeded** and issued a new key.

**FIXED.**

- Gaps are persisted in SQLite (`usage_gaps`: consumer, log, reason, first/last seen, occurrences,
  resolution), on **every** path that finds one, including the early returns for a missing or
  shrunk log.
- `reissue()` reads the old window, then refuses while any gap is unresolved — before creating a
  key, without touching the recorded balance. The row survives a restart, so the refusal does too.
- The log reappearing, or reading rows again, does not clear it. Only `resolveGap()` does, with
  `resolvedBy` and a note. It records the accepted byte offset as the new baseline (otherwise the
  next read would rediscover the same truncation) and keeps the previous offset in the event log.
  **No charge is reconstructed and no balance is adjusted.**
- A complete line that is not valid JSON marks the same uncertainty instead of being skipped as a
  zero-cost call.

Real Magpie:

```text
BEFORE_GAP              {"consumed":0.3012,"balance":0.6988}
REISSUE_WITH_GAP        rejected: … unresolved gap (… shrank from 22260 to 0 bytes …)
REISSUE_AFTER_RESTART   rejected: … unresolved gap …
OPEN_GAPS               [{"occurrences":2,"reason":"… shrank from 22260 to 0 byte…"}]
REISSUE_AFTER_REAPPEAR  rejected: … unresolved gap …
AFTER_RESOLUTION        {"capUsd":0.6988,"balance":0.6988,"unchanged":true,"sameSecret":true,"openGaps":0}
```

The balance after the audited resolution is exactly the recorded one: the write-off is a statement,
not a credit.

---

## 4. Interface

`bun bin/ohmyaihub.ts --data <dir> consumers resolve-gap <id> --log-id <id> --by <who> --note <text> [--accepted-offset N]`,
`POST /consumers/resolve-gap`, and `GET /status` / the page now show each consumer's gaps (resolved
and unresolved) and the accounting state.

---

## 5. Verification

`cd plugin && bun run ci`:

```text
typecheck PASS
239 tests, 0 failures (17 files)
boot-check PASS: plugin 0.4.0, magpie magpie 0.1.2038, api 34517, checks 1
secret-scan PASS: no credentials in the working tree
```

`plugin/test/final-fixes.test.ts` holds 10 tests, all written to fail on `9bd99fa`: read-failure
propagation, failure budget with a live gateway, recovery with re-validation and a working top-up,
truncation blocking reissue, the gap surviving a restart, the log reappearing not clearing it, an
unparsable complete line, an audited resolution that does not invent money, and two regression
guards (healthy reissue/top-up, late-row charging from an older window).

One consolidated real-Magpie run: `docs/validation/lab/phase6/final-verification.ts`.
Cleanup: the consumer was revoked, `gateway-key list` is empty, the isolated `serve` and mock
upstream were stopped, and the user's own Magpie on `:3425` was never touched.

---

## 6. Answers

**Does an unverifiable limit read still count as health?** No. It throws out of `checkConsumer`,
increments `failures`, leaves `lastOkAt` alone, and withdraws the export at the threshold.

**How is an old window's late charge finally settled?** As before: every unsettled window and every
window closed within the audit horizon is re-read at its frozen price; a late row reopens a settled
window and tightens the live cap or pauses on overdraft. What changed is that a *gap* in that log is
now persistent and blocks a new key instead of being ignored.

**What is consumption identity based on?** `(usage-log id, line byte offset, key)` — not a content
hash, not `route_id`.

**Can credit still be granted twice or a charge lost?** Credit: no. Charges: only through a gap, and
a gap now blocks reissue and stays recorded until an operator resolves it with a note.

---

## 7. Merge recommendation

Merge into PR #7 once Linux and macOS CI are green. The real-funds decision is unchanged: this is a
polled detection layer with a measured interval, not a price lock, so the phase-6 **NO-GO for real
USDC** stands.
