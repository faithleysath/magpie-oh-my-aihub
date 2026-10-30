# Phase 6 review patch — accounting safety, late charges and real stops

Scope: the five defects raised against PR #7 at `b000e84`. Every finding below was **reproduced**
against the reviewed HEAD or the real Magpie before it was fixed, and re-checked after. Nothing here
adds a wallet, a chain watcher, a market feature or a second AI gateway.

| Item | Value |
| --- | --- |
| Platform | macOS 26.6.2 (25G83), arm64 |
| Magpie | `0.1.2038`, tag `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| Lab | portable copy, gateway `127.0.0.1:3446`, deterministic mock upstream `127.0.0.1:19080` |
| Reviewed HEAD | `b000e844dc9ea70ddf2d0e9e6cc426e370897f36` |
| Fixed HEAD | see the PR's last commit |
| Money | simulated deposits and synthetic usage only; no real funds, wallet or chain |

---

## 1. Summary

| # | Defect | Status |
| --- | --- | --- |
| A | the accounting check never ran periodically | **CONFIRMED → FIXED** |
| B | a late row from an old key could be lost | **CONFIRMED → FIXED** |
| C | consumption identity was a content hash | **CONFIRMED → FIXED** |
| D | a pause could be claimed while the key still served | **CONFIRMED → FIXED** |
| E | SQLite / consumers.json / Magpie could disagree after a crash | **CONFIRMED → FIXED** |

Remaining unknowns are listed in §8. Nothing in this patch is called a price lock.

---

## 2. A — the check had no cadence

**CONFIRMED.** `Service.start()` installed the 15 s supervisor tick, but `ledgerCheck` ran only from
`status()`, `refreshAll()` and the money operations. A node configured through the loopback API
(`index.ts` calls `configure()`, not `start()`) had **no** periodic accounting check at all, and even
a started node only checked when somebody opened the page or asked for status. Measured: after an
external `magpie model price` edit with no status call, `paused` stayed `null` indefinitely.

**FIXED.** `accountingTick()` runs at start, at configure, and every `ACCOUNTING_TICK_MS` (10 s),
serialized per consumer with the money operations by the existing per-consumer lock.

- A failing check (throw, 20 s timeout, unreadable price source) is a **failure**, not a pass.
  After `accountingFailureBudget` (3) consecutive failures the export is withdrawn with an
  `accounting-uncertain:` reason that `guardSharedKeys` may not clear; only a passing check that
  re-validates every key republishes, and it refuses while any consumer's charges are uncertain.
- `accountingStatus()` reports `intervalMs`, `maxDetectionMs` (interval + timeout), the last check
  and its duration, the failure count and whether the export is published. The page and
  `GET /accounting` show it.

Measured on the real binary, no status or page call:

```text
AUTO_PAUSE {"ms":146,"reason":"price-mismatch","enforcement":"keyRevoked","enforced":true,"balance":0.7,"consumed":0.3}
CALL_AFTER_PAUSE 401        # a remote-style caller, see §5
```

Detection is a poll. `maxDetectionMs` is the honest bound: interval plus one check.

---

## 3. B — late rows from an old window

**CONFIRMED.** `reissue()` imported the old window once, waited `drainMs` (1.5 s), closed the window
and never looked at it again; `ledgerCheck` only read the open window. A row written after that
short drain was lost from the balance. The real run shows the exposure: a request still in flight at
reissue (reported as `inFlightDuringReissue: 1`) settled afterwards with $4 of usage.

**FIXED.**

- `settleWindows()` imports every **unsettled** window and every window closed within the audit
  horizon (30 min), each with its own frozen price snapshot.
- A late row reopens a window that had been called settled (`reopened … for a late row`), so the
  charge is never dropped by a stale flag.
- Late charges tighten the live key's cap to `floorGrid(native used + balance)`, or pause the
  consumer when the balance is negative or below `$0.0001`.
- A window is marked settled **only on evidence**: `GET /v1/magpie/concurrency` reports
  `requests: 0` and the usage log has no unread bytes for that key. A fixed wait is never used as a
  settlement proof.
- The status reports `openSettlements` and `uncertain`, so a window that is not proven settled is
  visible instead of implied.

Real run, in-flight request during reissue:

```text
INFLIGHT_LATE {"inFlightDuringReissue":1,"lateCallStatus":200,"reissueCap":0.4,"capNow":0.4,
 "balance":-3.6,"consumed":4.6,"paused":"overdraft",
 "windows":[{"status":"closed","settled":true,"cap":1},
            {"status":"closed","settled":true,"cap":0.7},
            {"status":"closed","settled":false,"cap":0.4}]}
```

The $4 late charge was charged at the **old** window's frozen price, the balance went to `-$3.60`,
and the consumer was paused with `enforcement: keyRevoked`. Unit tests cover a row written 5 s and
30 s after reissue, and a row that lands after the window was already called settled.

A second pass found the complementary hole: `ledgerCheck` returned early for a **paused** consumer,
so a request that was in flight when the key was stopped and settled afterwards was never imported.
A paused consumer now imports its unsettled windows too (no key is touched), so the charge and the
resulting overdraft stay visible for the next reissue. Regression test: "a paused consumer still
gets late charges".

---

## 4. C — consumption identity

**CONFIRMED.** `usageId()` hashed the request's content (key, route id, time, model, tokens, status).
Two genuinely identical calls produced the same id and were charged once; the id also proved nothing
about which log line it came from.

**Source finding.** Magpie's `usage.jsonl` has **no unique request id**:

| Field | Source | Unique? |
| --- | --- | --- |
| `route_id` | `internal/gateway/trace.go`, `trace.begin`: `t.ids = time.Now().UnixMilli()`, then `++` | **no** — a per-process counter seeded near the same value each run; absent on rejected rows |
| `rid` | vendor response id (`internal/usage/usage.go`) | **no** — absent for most calls |
| `t` | request start, second + nanosecond precision | **no** — two calls can share a timestamp |
| tokens/model/status | the call's own values | **no** |

Measured in the lab log: 32 rows, `route_id` absent on both rejected rows, and the counter restarts
near `UnixMilli` on every run.

**FIXED.** The event identity is `(usage-log id, byte offset of the line, caller key id)`:
`usageEventId()` = SHA-256 of those three. The log id is SHA-256 of the resolved path, so a replaced
file cannot collide with the old one. Verified:

- two byte-identical lines at different offsets → **two** charges ($0.0024 for two $0.0012 calls);
- re-reading from offset 0 → **zero** new charges;
- a log that shrank below the cursor, or disappeared → `gap`, the consumer is paused `log-gap`, the
  export stays withdrawn; missing rows are never treated as free;
- rows and cursor advance in **one** SQLite transaction (`importUsage`).

---

## 5. D — a pause must really stop consumption

**CONFIRMED, with an important distinction.**

| Situation | Loopback caller | Remote caller |
| --- | --- | --- |
| valid key | 200 | 200 |
| key removed | **200** | **401** |
| key rotated | 200 with old secret? no — 401 for the old secret, 200 for the new | 401 for the old secret |

Magpie trusts a loopback caller by construction (`internal/gateway/lan.go`: `local(r)`), so a removed
key's secret still answers 200 from this machine. A consumer reaches the gateway through EasyTier's
Forward path, which arrives from a non-loopback address — the branch a forwarding header reproduces.
A `$0.0001` cap is **not** a stop either: measured, a 10/10-token call returned 200 with `6e-05` used
of `0.0001`.

**FIXED.** `paused.enforcement` records the level actually reached: `keyRevoked`, `secretRotated`,
`capRestricted`, `networkWithdrawn` or `safetyUncertain`. `enforced` is true only for the first two.
Removal is the strong stop; if it fails, `gateway-key rotate` replaces the secret (the old one is
401, the usage is kept); a minimum cap is only ever `capRestricted` and is described as still
admitting calls. When any paused consumer is not enforced, the accounting check withdraws the export
as well, and a withdrawal that fails is reported as a failure, not a stop. `--cost 0` is never used.

Real run: `CALL_AFTER_PAUSE 401` for a remote-style caller; unit tests cover remove-fails (rotate),
remove-and-rotate-fail (`capRestricted`, `enforced:false`), and even the cap failing
(`safetyUncertain`).

---

## 6. E — crash between the three stores

**CONFIRMED.** `consumers.json` was written with a plain `writeFileSync` (truncatable), and an
unparseable document was silently read as **zero consumers** — which would orphan every live key.
A ledger window could exist with no record, or a Magpie key with no ledger account.

**FIXED.**

| Crash point | Recovery (`Provisioner.recover()`, at start) |
| --- | --- |
| ledger account + window, key alive, record missing | adopt the record from the ledger and the key |
| ledger window, key gone | keep the balance, report the consumer as uncertain, serve nothing |
| `ohmyaihub-*` key with no ledger account | remove it: no balance backs it |
| record with no ledger account | seed from `cap − used`, read the log from its current end |
| `consumers.json` unreadable | refuse to start with an empty list; recover `.prev` when valid |

`consumers.json` now uses `writeJsonAtomic` (temp file, fsync, rename, directory fsync, `.prev`), the
same writer as `state.json`.

---

## 7. Verification

`cd plugin && bun run ci`:

```text
typecheck PASS
229 tests, 0 failures (16 files)
boot-check PASS: plugin 0.4.0, magpie magpie 0.1.2038, api 34517, checks 1
secret-scan PASS: no credentials in the working tree
```

New file `plugin/test/review-fixes.test.ts` holds 21 tests, one or more per defect, written to fail
on the reviewed HEAD: identical-line double charge, repeated import, truncated log, late row at 5 s
and 30 s, in-flight at settlement, restart re-scan, late row after settlement, the three enforcement
levels, the four crash points, tick-only price detection, failure budget withdrawal and recovery, and
a log gap.

Real Magpie run, `docs/validation/lab/phase6/review-verification.ts`, one consolidated pass:

```text
ISSUED    cap 1, window 3650d, price version 2f7b988d…
CALL_0_3  200
BEFORE    used 0.3, balance 0.7
PRICE_SET ✓ labmock/lab-model costs $2/$4 per 1M in/out
AUTO_PAUSE 146 ms, price-mismatch, keyRevoked, enforced, balance 0.7, consumed 0.3
CALL_AFTER_PAUSE 401
REISSUED  new key, same secret, cap 0.7, consumed 0.3 (old price, not 0.6)
CALL_ON_NEW_KEY 200
INFLIGHT_LATE  in-flight 1 at reissue; late $4 charged; balance -3.6; paused overdraft
```

Cleanup: every lab key was removed (`gateway-key list` empty), the isolated `serve` and the mock
upstream were stopped, and the user's own Magpie on `:3425` was never touched.

---

## 8. What is still unknown or limited

| Item | Status |
| --- | --- |
| Price edit inside the 10 s check interval | **UNKNOWN bound** — detection, not a lock; `maxDetectionMs` reports it |
| A request that ends just after the settlement evidence | **BOUNDED** — the 30 min audit horizon reopens the window; after that horizon it is not re-read |
| A log rotated or deleted entirely | **DETECTED** as a gap and paused; the missing charges are not reconstructed |
| `route_id` reuse across two runs of the same log | **NOT AN ISSUE** for identity (offset-based), but a `usage.jsonl` replaced *in place* with the same size and different rows is only caught when the cursor later disagrees |
| A local (loopback) caller with a removed secret | **STILL SERVED by Magpie** — a native limitation; a pause is a remote stop, and the status says `keyRevoked` rather than "unusable everywhere" |
| Windows/Linux Magpie | **UNKNOWN** — this lab is macOS arm64 |
| Native soft-cap overshoot | **UNCHANGED** — the cap is a soft ceiling; no closed form |

No path in this patch can mint credit twice: a deposit is credited only after a cap read-back, and
every charge is keyed by a log position. The one way to lose a charge is a log gap, which is
detected and paused rather than ignored.

---

## 9. Answers to the review's questions

**How are old-window charges finally settled?** By re-reading every unsettled window and every
window closed within the audit horizon at each accounting check, each at its frozen price. A window
is marked settled only when the gateway reports nothing in flight and the log has no unread bytes;
a later row reopens it and tightens the live cap or pauses the consumer.

**On what is consumption uniqueness based?** The usage log's identity and the line's byte offset
(plus the key), not a content hash and not `route_id`.

**Does an uncertain accounting state really stop remote consumption?** Yes for a remote consumer: the
key is removed (401) or its secret rotated (401 with the old secret). If neither works the level is
`capRestricted` or `safetyUncertain`, the export is withdrawn, and the failure is reported. It does
**not** stop a loopback caller, which Magpie serves regardless.

**Can credit still be granted twice or a charge lost?** Credit: no — intent, read-back, unique ids
and the ledger balance prevent it. Charges: only through a detected log gap, which pauses the
consumer and keeps the export down.

---

## 10. Merge recommendation

Merge into PR #7 once Linux and macOS CI are green. It fixes five confirmed accounting-safety
defects without touching Magpie or EasyTier. **The real-funds decision does not change:** this is
still detection with a measured interval, not a price lock, so the phase-6 NO-GO for real USDC
stands.
