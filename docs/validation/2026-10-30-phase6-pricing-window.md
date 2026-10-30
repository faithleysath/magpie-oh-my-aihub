# Phase 6 — prepaid credit, price changes and window rollover

Status: **research + minimal implementation complete; testnet-accounting GO, real-funds NO-GO.**
This note is the evidence behind PR `feature/pricing-window-reconciliation`. It does not claim that
Magpie can pin a price; it measures what Magpie 0.1.2038 actually does, then implements the smallest
fail-closed accounting layer that does not depend on the native `used` number being immutable.

| Item | Value |
| --- | --- |
| Platform | macOS 26.6.2 (25G83), arm64 (Apple Silicon) |
| Magpie | `0.1.2038`, tag `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| Source worktree | `~/Projects/lab/magpie-2038` (clean worktree at the tag) |
| Lab | portable copy at `~/Projects/lab/magpie-pricing-2038`, gateway `127.0.0.1:3446`, its own `data/` |
| Upstream | deterministic local mock, `127.0.0.1:19080`; no vendor, wallet, chain or real key |
| EasyTier | unchanged from the phase-3/4/5 work (`2.6.4`); this phase did not touch it |
| PR #6 precondition | PR #6 was still **open** at the start; it was merged into `main` as `f90bfa4` (containing `2da1c3e`, whose parent is the security commit `30384bb`) before this branch was created |

The lab costs are synthetic: the mock reports the token counts in the request body, and Magpie's
own effective price is set with `magpie model price`. No real Gateway Key or provider API key was
used. Secrets are not printed by the harness.

---

## 1. Source: where price, cost and windows come from

All paths below are in the pinned Magpie tree, not in this repository.

### 1.1 Price sources

| Source | File / function | What it means |
| --- | --- | --- |
| User's explicit price | `internal/settings/settings.go:741-760` (`ModelPrices`) | `"<provider>/<model>"`, `"<provider>/*"` or `"*/<model>"`, USD per 1M tokens; every part must be present or the price is unusable |
| Effective price order | `internal/provider/models.go:2189-2240` (`EffectivePriceIn`, `priceOf`) | explicit `provider/model` → `provider/*` → `*/model` → provider list price → maker (models.dev) price → `ModelSameAs` → `PriceRate` |
| Maker / upstream list | `internal/provider/models.go:2147` (`MakerPrice`), `internal/catalog/fresh.go:1-60` | models.dev cache, refreshed at most daily (or after 6 h when a call has no price); a **vendor price change reaches Magpie only through this catalog refresh**, not live |
| What `/v1/models` publishes | `internal/gateway/gateway.go:1262` | with `X-Magpie-Prices: 1`, `magpie_price` is the same `provider.EntryPricer` / `EffectivePriceIn` result |
| Cost arithmetic | `internal/catalog/catalog.go:307-324` (`At`, `OneHour`), `336-341` (`CostSplit`) | tier selected by `input+cache_read+cache_write > tier.above`; cache read/write and 1-hour cache write are separate parts |
| Historical cost | `internal/usage/ledger.go:526-560` (`Pricer`), `1125-1134` (`NewCoster`) | every read calls `settings.Load()` now; `Pricer` caches per query, not across queries |
| Aliases | `internal/usage/usage.go:238-253` (`renameBy`, `priceID`), `settings.go` `ModelNames` / `UsageAliases` / `ModelSameAs` | a display name or usage alias does not change `provider/model` pricing; `ModelSameAs` is only a last-resort maker-price fallback; `UsageAliases` only groups the Usage page |

There is **no per-key price**, no price-version field, and no immutable per-call cost in a gateway
usage record. `Record.OwnCost` exists only for calls a client *reported* itself
(`internal/usage/usage.go:204-218`, `464-470`); a gateway call has only tokens, and Magpie prices
those tokens at read time.

### 1.2 Gateway Key used cost

| Step | File / function | Behavior |
| --- | --- | --- |
| Request gate | `internal/gateway/key_limit.go:36-77` (`keyLimited`) | only keyed POSTs with at least one limit; reserves before the upstream; 429 with `Retry-After` and `X-Magpie-Limit-Reset` |
| Reservation | `internal/budget/budget.go:341-431` (`Reserve`) | `body_bytes/4 + mean output` tokens; cost at mean cost/token or model input price; refused when `used + reserved >= cap` for **any** limit |
| Window sums | `budget.go:108-151` (`sumsFor`, `read`) | first read of a window calls `usage.Visit(start)` and `usage.NewCoster()`; the result is kept in `state.sums` |
| Settlement | `budget.go:155-183` (`Append`) | writes `usage.jsonl`, then adds the record at **today's** cost to every kept window whose start is before the record time |
| Status endpoint | `internal/gateway/key_limit.go:116-126` (`keyLimit`) | `GET /v1/magpie/limit` calls `budget.All`, which reads the file afresh, not the gateway's kept sums |
| Key store | `internal/access/access.go:635-653` (`save`) | atomic `caller-keys.json`; the key, its limits and secrets are one document |

Two different numbers therefore exist while a process is running:

- `GET /v1/magpie/limit` recomputes history at the **current** price on every call;
- admission uses the **kept** `state.sums` from the first time that window was read, plus new calls
  appended at the price they had when they settled.

A price change inside a live window can make the two disagree until the process restarts or a new
window is read. This was measured, not inferred (section 3.2).

### 1.3 Windows

| Rule | File / function | Consequence |
| --- | --- | --- |
| Periods | `internal/access/limit.go:13-40`, `94-95` | `day`, `week`, `month` are calendar windows; `days`/`hours` are cycles of N from `Since`; `MaxDays = 3650` |
| Grid | `internal/access/limit.go:117-147` (`Valid`) | cost is `round(cost*1e4)/1e4` USD; a value that rounds to 0 is **no limit**, not "blocked" |
| Keeping the anchor | `internal/access/limit.go:167-183` (`sinceOf`) | changing only the cap keeps `Since`; changing period/day/hour count starts a new cycle now |
| Reset | `internal/access/access.go:421-445` | `reset` sets `Since = now`, so prior usage stops counting; never a top-up |
| Window math | `internal/access/limit.go:187-229` (`Window`) | a `days` cycle is absolute 24 h time; a restart or time-zone change keeps it; a hand edit without `Since` anchors at the Unix epoch |
| In-flight | `budget.go` comment at the `window` type, `375-414` | a reservation stays in the window where the request began; the usage record's `Time` is the request start, not completion |

The last rule is the subtle one: a request that starts before a boundary and finishes after it is
charged to the **old** window. The new window's `read(start)` excludes it. The native "used" of the
new window is therefore zero even though real work was done and money was spent.

---

## 2. Lab setup

```sh
LAB=~/Projects/lab/magpie-pricing-2038
cp -R /Applications/magpie.app "$LAB/Magpie.app"
python3 docs/validation/lab/phase6/mock_upstream.py 19080 &
cd "$LAB"
export MAGPIE_NO_ACCOUNTS=1 HOME="$LAB/home"
BIN="$LAB/Magpie.app/Contents/MacOS/magpie"
$BIN provider add labmock url=http://127.0.0.1:19080/v1 key=sk-lab models=lab-model id=labmock
$BIN model price labmock/lab-model 1,2,0.1,0.2
MAGPIE_ADDR=127.0.0.1:3446 $BIN serve
```

The full command set and the state-injection restriction are in
[`lab/phase6/README.md`](lab/phase6/README.md). The reproducible real-Magpie check is
[`lab/phase6/real-integration.ts`](lab/phase6/real-integration.ts).

---

## 3. Measurements

### 3.1 Baseline and where the cost is

Key: one model `labmock/lab-model`, price `$1/$2/$0.1/$0.2` per 1M in/out/cache read/cache write,
limit `days 3650 --cost 10`. Request: 1000 prompt tokens, 100 completion tokens.

```text
HTTP 200
/v1/magpie/limit:
  calls 1, tokens 1100, cost 0.0012, costLimit 10, costLeft 9.9988, spent false
usage.jsonl:
  in 1000, out 100, cache_read 0, cache_write 0, callerKeyId lab-…
```

`cost = (1000*1 + 100*2)/1e6 = 0.0012`. The native number is an estimate at the price Magpie
shows, not the vendor's invoice.

### 3.2 Price increase: read endpoint reprices immediately, admission does not

Same key, change only the local price to `$10/$20/$1/$2` (10×):

| Moment | `/v1/magpie/limit` | Admission of the next call |
| --- | --- | --- |
| after price change, before a new call | `calls 1, cost 0.012, left 9.988` | still uses the kept old sum (`0.0012`) |
| after a new 1000/100 call | `calls 2, cost 0.024` | **HTTP 200** |
| cap lowered to `0.014` | `cost 0.024, spent true` | **HTTP 200** — the kept sum is `0.0132`, so the old key still lets a call through |
| after that third call | `calls 3, cost 0.036, spent true` | the kept sum is now `0.0252` and the key is refused |
| restart `serve` | `calls 3, cost 0.036` | the sums are rebuilt at `0.036`; next call **429** |

Log excerpt (sanitized):

```text
LIMIT AFTER 10x, BEFORE NEXT CALL:
  {'calls': 1, 'tokens': 1100, 'cost': 0.012, 'costLimit': 10, 'costLeft': 9.988, 'spent': False}
HTTP 200
LIMIT AFTER 2ND CALL:
  {'calls': 2, 'tokens': 2200, 'cost': 0.024, 'costLimit': 10, 'costLeft': 9.976, 'spent': False}
after cap 0.014:
  {'calls': 2, 'cost': 0.024, 'costLimit': 0.014, 'costLeft': 0, 'spent': True}
ADMISSION:
  HTTP 200
after third call:
  {'calls': 3, 'cost': 0.036000000000000004, 'costLimit': 0.014, 'costLeft': 0, 'spent': True}
```

**Consequence:** a monitor that only watches `/v1/magpie/limit` cannot enforce a price change. The
admission path can be more permissive than the number the monitor reads. Only a restart, a new
window or a key change removes the stale sum.

### 3.3 Price decrease: the old admission sum is now too expensive

Price lowered to `$0.1/$0.2`:

```text
/v1/magpie/limit: calls 3, cost 0.00036, costLimit 0.014, left 0.01364, spent false
next call before restart: 429 ("used $0.03 of its $0.01")
after restart:            200; cost 0.00036
```

So a decrease can **reduce** a consumer's access until restart even though the read endpoint says
there is credit. A native `used` number alone is not a safe basis for a prepaid balance in either
direction.

### 3.4 Historical calls are repriced; two keys share the same price

Two keys (`labkey`, `labkey2`) on the same model, each with one call. At `$1/$2`:

```text
labkey  cost 0.0024 (two calls), cap 0.014
labkey2 cost 0.0012 (one call),  cap 10
```

After changing the model price to `$2/$4`:

```text
labkey  cost 0.0048
labkey2 cost 0.0024
```

The change is global per model, applies to every key, and rewrites existing charges. There is no
per-key tariff and no historical price stored in `usage.jsonl`.

### 3.5 3650-day window still ends

A 3650-day key with `$0.036` used was given a `Since` anchor 3650 days + 5 s in the past (labelled
state injection). The native window then started 5 s ago:

```text
before: calls 4, cost 0.036, costLimit 0.014, spent true
after:  calls 0, cost 0, costLimit 0.014, costLeft 0.014, spent false
next call: HTTP 200, cost 0.0012, left 0.0128
```

A ten-year window only postpones the re-grant; it does not remove it.

### 3.6 A daily window re-grants consumed credit

Key: `days 1 --cost 10`, one call of 4M prompt + 2M completion = `$8`.

```text
before boundary: start 2026-10-30T08:21:05…, calls 1, cost 8, left 2
injected Since = now - 2 days (state injection):
  start 2026-10-30T08:21:22…, calls 0, cost 0, left 10
next 4M/2M call: HTTP 200, calls 1, cost 8, left 2
```

Total native spend: **$16** against a **$10** cap. The ledger still has both usage rows, but the
native used number does not.

### 3.7 In-flight request at the boundary

A one-hour key, `Since` set 6 s before its boundary, request delay 8 s and `$8` of usage:

```text
before: start 07:22:25, reset 08:22:25, calls 0, cost 0, left 10
request starts 08:22:19, completes 08:22:27 (HTTP 200, 8.0 s)
after:  start 08:22:25, calls 0, cost 0, left 10
usage:  t=08:22:19 (old window), in 4M, out 2M
next 4M/2M call: HTTP 200, calls 1, cost 8, left 2
```

The $8 call is in the old window's record (`t` = request start) and disappears from the new
window's native used cost. A second $8 was accepted. This is exactly why the ledger must import the
usage row even when it belongs to the closed window, and why reissue waits for the old key to drain.

### 3.8 Top-up at the boundary

Key: `days 1 --cost 10`, spend `$8`, then raise the cap to `$12` while still inside the window:

```text
before top-up: cost 8, cap 10, left 2
after +2:      cost 8, cap 12, left 4
after boundary (Since injection):
               start now, calls 0, cost 0, cap 12, left 12
next $8 call:  HTTP 200, cost 8, cap 12, left 4
```

The consumer paid for `$12`; native accounting shows `$16` consumed (8 + 8) and still reports
`$4` left. The `$4` was already spent before the boundary. This is the double-credit the phase-6
ledger prevents.

### 3.9 Changing the window restarts it; changing the cap does not

`labkey2` was a 1-hour key with `cost 0.0024`. Changing to 2 hours reset `start` and `used`:

```text
before: hours 1, start 08:22:42, calls 2, cost 0.0024
after `gateway-key limit <id> 2h --cost 10`:
        hours 2, start 08:23:43, calls 0, cost 0, left 10
```

Changing only the cap on the same period kept the anchor (seen in every top-up above). Therefore a
top-up must never write a different period, and changing the period is a reissue, not a cap change.

### 3.10 Multiple limits

A key with a 1-day `$10` cost limit **and** a 1-hour 1000-token limit:

```text
limits: [days 1, cost cap 10; hours 1, token cap 1000]
call 1 (1100 tokens): 200
call 2: 429, "used 1100 of its 1000 input, output and cache-write tokens for this 1-hour cycle"
limits: [days 1: tokens 1100; hours 1: tokens 1100, tokenLimit 1000, spent true]
```

All limits are checked; the binding one is reported. A request is let in only while **every** window
has room. This does not provide a lifetime cap: each window still resets on its own.

### 3.11 Cache, tiers, streaming

At price `$10/$20/$1/$2`:

| Request | Native result |
| --- | --- |
| 1000 prompt, 600 reported cached | `in 400, cache_read 600, tokens 500, cost 0.0066` |
| 200k input, tier `>100k: $10/$20` | `cost 2.002`, tokens 200100 |
| streaming 1000/100 | HTTP 200, final usage, `cost 0.0012`, `ttft_ms` set |

Cache reads cost the cache price but are **not** in the token count unless the limit sets
`--cache-reads` (`budget.sums.tokens`). Tiers are chosen by total prompt tokens, strictly `>` the
threshold. Streaming settles on the final usage event; a cut stream counts what was recorded.

### 3.12 Local price vs upstream vendor price

- With an explicit local price, every call and every historical read uses that local price. The
  vendor's live price is not consulted.
- After `magpie model price … --reset`, the lab model became "no price is known"; two calls
  returned 200, `cost 0`, `unpriced 2`. An unpriced model is free unless a token cap applies. A
  cost cap cannot protect an unpriced model.
- If no explicit price exists, `EffectivePriceIn` falls back to the provider list, then the maker's
  models.dev price. That catalog is refreshed at most daily (or after six hours for an unpriced
  call), so an upstream price change affects local billing only on that schedule, and then it
  reprices history as in 3.2.
- `ModelSameAs` is only a fallback when no list price exists; display names and usage aliases do not
  change the price key.

---

## 4. What cannot be guaranteed without changing Magpie

1. **No price pinning or price version.** A model price is a mutable entry in `settings.json` (or a
   mutable models.dev cache). Changing it changes the cost of calls already recorded.
2. **No immutable per-call cost.** A gateway usage record has tokens but no price or cost snapshot.
   `OwnCost` is only for client-reported calls.
3. **No atomic "cap = balance at the boundary".** `Window()` changes the start at a computed time;
   `used` is derived from records from that start. There is no hook, transaction or API to rebase a
   cap at the same instant.
4. **No real-time external-edit guard.** An operator can change `settings.json` or the models.dev
   cache outside the plugin. The plugin can detect it on its next reconcile and remove the key, but
   a call between the edit and the detection can be priced at the new price. This is **not** a
   price lock; it is fail-closed detection with a finite window.
5. **Stale admission sums.** Even a read of `/v1/magpie/limit` is not proof of what the admission
   path will do after a price change; only restart/key-change/new-window resets the kept sums.

The safe statement is therefore: *after detection*, the ledger can preserve a consumer's remaining
USD credit and refuse further use; *during the detection gap*, Magpie's native price is
authoritative and the plugin cannot prevent a reprice.

---

## 5. Strategies compared

| | A — fixed price + long key | B — price-version key rotation | C — immutable ledger + native key |
| --- | --- | --- | --- |
| Price change handling | operator must not change; no native enforcement | detect, stop, settle, new key at new version | records old prices; still needs B to stop native repricing |
| Window end | 3650 d postpones; eventual re-grant | reissue before/at boundary with carried balance | ledger balance is the source; reissue carries it |
| Key/secret distribution | one key, no rotation | new key; secret reuse needs a plugin-owned secret | same as B |
| In-flight request | native old-window charge can vanish | must drain/settle old key | imports the row from the old window |
| Ops burden | low until a price/window event | medium: pause + reissue | medium: SQLite + reconcile |
| Correctness without Magpie changes | **fails** on any price change or window end | good after detection; gap remains | good for accounting; enforcement needs B |
| Failure visibility | silent re-grant | paused, enforced flag, audit events | paused + ledger balance/overdraft |

**Chosen: a minimal A+B+C combination.** Keep the longest native window (`days 3650`) so rotation is
rare, keep an immutable SQLite ledger as the balance of record, and make every price/window/drift
event fail closed with an explicit `reissue`. This is the smallest set that is actually testable.
It does **not** turn Magpie into a price-locked system; it ensures the plugin never uses the native
`used` number as a substitute for historical consumption.

Why not B alone: rotating on price changes without a ledger leaves no trustworthy carried balance
when the old window's usage is repriced or when an in-flight call settles late.
Why not C alone: a ledger that only observes cannot stop a native key from being used after a
window reset; the key must be revoked at the event.

---

## 6. Implemented design

### 6.1 Money and ledger

New files:

- `plugin/src/pricing.ts` — complete-price validation, canonical price version, integer-nano cost
  arithmetic matching `catalog.Price.CostSplit`, grid flooring.
- `plugin/src/ledger.ts` — SQLite (`plugin/data/ledger.sqlite`, 0600) with WAL and `FULL`
  sync. Tables: `accounts`, `windows`, `deposits`, `consumption`, `events`, `usage_offsets`.
- `plugin/src/provisioner.ts` — ledger-backed issuance/top-up, price/window checks, pause, reissue.
- `plugin/src/catalog.ts` — optional `billing.priceVersion` / `priceLocked:false`, recomputed and
  verified; `plugin/src/service.ts` publishes it and accepts a quote hash/price version.

All money is integer **nano-USD** (`1e-9`), safe for the maximum cap (`$1,000,000`) and finer than
Magpie's `$0.0001` grid. A cap is always `floorGrid(cap)`, never rounded up. Credit below one grid
unit is kept in the ledger and cannot produce a key (`paused: dust`); it is not silently dropped.

### 6.2 Balance formula

Let:

- `T` = sum of applied deposits (the initial `opening:<consumer>` deposit is one of them),
- `L` = sum of immutable settled consumption snapshots (each priced at the window's bound price),
- `B = T - L` (can be negative),
- `U` = Magpie's native `cost` in the current window,
- `G = $0.0001` in nanos.

Invariants:

```text
while a window is open:   native cap = floorGrid(U + B)
                           native remaining = cap - U ≈ B (down to one grid)
new window / reissue:     native cap = floorGrid(B)
credit:                   B < 0 is an overdraft; top-ups first repay it
                          0 <= B < G is dust; no key can be issued
```

A top-up **never** uses `old cap + amount`; it recomputes from `U + B + amount`. That is what makes
a price change or a boundary irrelevant to the credit balance. A top-up while the window is open
keeps the same key and window; a boundary or price change revokes the key and `reissue` opens a new
window with `cap = B`.

### 6.3 Deposit state machine

```text
            ┌──────────── intent (indexed by caller-supplied id, unique) ────────────┐
            │                                                                       │
            ▼                                                                       │
  [intent] ── Magpie cap write ── read-back shows exactly the target cap ──► [applied]
     │                                                                          │
     └── write refused / cap unchanged ─────────────────────────────────► [failed]
```

- The intent is on disk before Magpie is touched.
- The deposit is credited only after a read-back shows the exact cap. A crash between the write and
  the local commit leaves an intent; `reconcile()` applies it **only** if the cap matches. If the cap
  is still the old one, it marks the intent failed, never retries a blind `+= amount`.
- Repeating the same id and amount is a no-op; the same id with another amount is refused.
- A top-up that would leave the cap below `$0.0001` is refused and its intent is failed; nothing is
  silently rounded up.
- `deposits` and `consumption` are unique by id; the ledger transaction and the usage byte offset
  advance together.

### 6.4 Price version and quote binding

`billing.priceVersion` is `SHA-256` of sorted `{id, input, output, cache_read, cache_write,
cache_write_1h, tiers}` for the quoted models. The reader recomputes it, so a signature covers the
actual displayed prices. `billing.priceLocked` is always `false`: Magpie has no pinning, and the
plugin must not claim one.

- A consumer's key records the signed quote's `contentHash` and the price version at issuance.
- `quotePriceVersion` is compared with Magpie's live effective price at issuance; a mismatch refuses
  the key.
- A later mismatch pauses the key. `reissue` requires `acceptPriceVersion=<new>`; old consumption
  stays at the old snapshot, so the new key's cap is `B`, not a repriced history.
- A new quote can be published at any time, but it is only an accurate billing promise if the
  provider has not changed the effective price underneath existing keys. The operational rule is:
  **pause and reissue every active key at the new version before publishing the new quote**, or
  publish while clearly marked `priceLocked:false`. The plugin does not silently rewrite an active
  key's price version.

### 6.5 Pause / reissue state machine

```text
                       price version ≠ bound
  [active] ─────────── native window start changed / reset passed ─────────► [paused]
      │                native used ≠ ledger consumption (drift)
      │                no complete effective price
      │                balance < 0 or dust at reissue
      │
      │  top-up (intent → cap → read-back)          reissue(accept new version)
      └──────────────────────────────► [active] ◄──────────────────────────────┘
                                             │
                                             └── old key removed, same secret for
                                                 plugin-owned keys; new cap = B
  any ── revoke ─────────────────────────────────────────────────────────────► [revoked]
```

On pause the old key is removed (`gateway-key remove`). If removal fails, the plugin falls back to
the smallest enforceable cap (`$0.0001`) and records `enforced:false` if even that cannot be
verified. The page and API show `paused.reason` and `paused.enforced`; a failed enforcement is never
hidden.

`reissue`:

1. marks the old window draining;
2. imports settled rows from `usage.jsonl` again;
3. removes the old key (no new request can enter);
4. waits a bounded drain (`drainMs`, default 1.5 s) for in-flight streams;
5. recomputes `B` and closes the old window;
6. if `B < G`, leaves the consumer paused (`overdraft`/`dust`) and issues no key;
7. otherwise creates a new key with the same name and, for a plugin-owned secret, the same secret;
   writes `cap = floorGrid(B)`, verifies it, opens a new window at the current price version.

The drain is bounded, not a proof against an arbitrarily long stream. A stream longer than
`drainMs` can settle after reissue; it is imported on the next reconcile and reduces the balance
then. This is an explicit residual risk (section 8), not a claim of atomicity.

### 6.6 Legacy keys

New ledger-managed keys use a plugin-owned secret `sk-ohmy-<64 hex>`. Magpie's own generated
`sk-magpie-…` secret cannot be passed back through `gateway-key add --key`, so a legacy consumer's
first reissue creates a new secret and must be handed over again. The record keeps the old secret
only until reissue; the pause/reissue response and `secret` hand-over expose the new one.

---

## 7. Tests and real-lab integration

### 7.1 Unit/CI

`cd plugin && bun run ci` on this machine:

```text
typecheck PASS
206 tests, 0 failures (15 files)
boot-check PASS
secret-scan PASS
```

New test files:

- `test/pricing.test.ts` — complete-price refusal, deterministic version, cache/tier/1-hour cost,
  grid floor, quote version recomputation.
- `test/ledger.test.ts` — integer credit, idempotent/conflicting deposits, overdraft, usage import
  once, partial line, unpriced row, window carry, reopen, pause/audit.
- `test/provisioner-ledger.test.ts` — 3650d issuance, unpriced refusal, used+balance top-up, replay,
  racing deposits, overdraft, price change pause + explicit accept + old-price consumption, window
  rollover + carried balance + dust, crash between cap write and commit, failed write never credited,
  quote price-version binding.
- `test/catalog.test.ts` — `billing.priceVersion` signed, wrong version and repriced content refused,
  false `priceLocked` refused, old quote without the field still readable.
- `test/catalog-service.test.ts` — published quote carries `priceLocked:false` and a null version
  when any model is unpriced; a priced-only quote carries a version; Service→Provisioner→ledger
  top-up integration.

### 7.2 Real Magpie 0.1.2038 run

`docs/validation/lab/phase6/real-integration.ts` against the portable instance, price `$1/$2`,
cap `$1`, one 600k/100k call (`$0.8`):

```text
ISSUED    keyId lab-…, cap 1, window 3650d, priceVersion 2f7b988d…, balance 1
CALL      200
STATUS    used 0.8, cap 1, balance 0.2, consumed 0.8
TOPUP     used 0.8, cap 1.1, credited 0.1, balance 0.3
INJECTED  since 2026-10-30T08:55:26… -> 2016-11-01T00:55:21… (lab state injection)
BOUNDARY  paused window-rollover, enforced true, balance 0.3
REISSUED  old key → new key, sameSecret true, cap 0.3, balance 0.3
```

A second real run changed the local price from `$1/$2` to `$2/$4` after a `$0.3` call:

```text
BEFORE_PRICE  used 0.3, balance 0.7, priceVersion 2f7b988d…
AFTER_PRICE   paused price-mismatch, enforced true, balance 0.7, consumed 0.3
REISSUE       refused without acceptPriceVersion; with it, cap 0.7, consumed 0.3,
              sameSecret true, priceVersion e845fe97…
```

This confirms the two critical properties against the real binary: the old consumption is not
repriced in the new key, and the window boundary does not re-grant the old cap.

### 7.3 What the tests deliberately do not claim

- The native cap is still a **soft ceiling**; concurrent in-flight calls can overshoot.
- The mock and the real-lab state injection are not a natural wall-clock day/week/month passage.
- No Windows/Linux Magpie run; only macOS arm64.
- No real vendor bill. The cost is Magpie's estimate at synthetic prices.

---

## 8. Residual risks / blockers

| Risk | Status | Mitigation |
| --- | --- | --- |
| External price edit between reconciles | **UNKNOWN bound** | pause on next check; no real-time lock; documented blocker |
| Stale admission sums after a price change | **REPRODUCED** | only restart/key change/new window clears them; a read endpoint is not proof |
| In-flight stream longer than `drainMs` at reissue | **UNKNOWN** | imported on next reconcile and reduces balance; reissue is available; not atomic |
| Native soft-cap overshoot / concurrency | **REPRODUCED in phase 3** | provider must accept an overdraft tolerance; no closed form |
| Unpriced model | **REPRODUCED** | a cost cap does not stop it; plugin refuses issuance and pauses on unpriced, but an external price removal after issuance is detected only on reconcile |
| Provider disabled / model deleted | **UNKNOWN** for the ledger path | key read-back fails; pause is not automatic on a provider deletion unless the key status becomes unreadable; operator must reissue |
| Legacy `sk-magpie-` secret | **REPRODUCED** | first reissue creates a new secret; consumer must reconfigure |
| Quote published while an old key is still at the old price | design rule | publish after pause/reissue, or mark `priceLocked:false`; not automatically enforced |
| Magpie admin interface reachable | unchanged | never expose it; out of scope |
| Full disk / SQLite failure | **UNKNOWN** | intent/read-back design; a failed local write leaves intent and no credit; needs operator reconcile |
| A pending deposit is followed by a pause before `reconcile` | **FAIL CLOSED** | `reissue` refuses while `pending` exists; no blind retry, no silent credit; needs operator reconciliation |

---

## 9. Answers to the four required questions

**1. Can prepaid credit be guaranteed against price changes without modifying Magpie?**

**No, not in real time.** Magpie has no price pinning, no per-key price and no immutable cost
snapshot; a price change reprices history and can immediately alter the native used number. The
implemented ledger preserves the USD balance and refuses further use after a detected mismatch, but
a call in the detection gap can still be repriced. Calling that a price lock would be false.

**2. How is credit carried across a Gateway Key window so spent credit is not re-granted?**

The ledger computes `B = Σ applied deposits − Σ immutable consumption`. At a boundary the plugin
removes the old key and `reissue` creates a new key with `cap = floorGrid(B)`, never with the old
cap. It imports the old window's usage first, including a request that started before the boundary
and finished after it. The new window's native `used` starts at zero, but its cap is only the
remaining balance. A ten-year window is used to make this rare; it is not treated as permanent.

**3. Can accounting and native limits stay recoverable under overdraft, concurrency and crashes?**

For the tested crash points, yes: deposits are intents until the cap read-back confirms them;
usage rows have stable ids and an offset advanced in the same transaction; a paused key is removed
or frozen; a failed enforcement is reported. The residual limits are the native soft cap (parallel
overshoot), a stream longer than the drain window, and an external price edit before detection. The
plugin never silently invents a charge or a credit; it can leave a consumer paused and requires an
explicit `reissue`.

**4. What must be verified before real Base USDC?**

At minimum: (a) a native or request-path price lock, or an accepted real-time guard with a measured
maximum detection delay; (b) an explicit overdraft tolerance for the native soft cap and a policy
for who bears it; (c) a drain/reconciliation proof for in-flight calls at every rotation; (d) a
pinned, signed price source and a publication rule tying quotes to actual charging; (e) idempotent
chain deposit events with finality/reorg handling; (f) an audited key-secret rotation/revocation
path; (g) crash and disk-failure tests on Linux; (h) a legal/operational decision on refunds, dust
and negative balances. None of these is a real-money implementation in this phase.

---

## 10. GO / NO-GO

- **GO — testnet accounting development.** The ledger, fail-closed pause/reissue, quote price
  version and the crash/idempotency paths are implemented and tested; the isolated Magpie run
  confirms the balance carry and the old-price consumption invariant.
- **NO-GO — any real USDC, mainnet, or production credit.** Price changes are still authoritative
  in Magpie and cannot be locked without an upstream change or a request-path guard. The detection
  gap, native soft-cap overshoot, in-flight drain bound and external price edits are unresolved for
  real funds. This is a technical blocker, not a UI warning.

The next upstream proposal, if the project continues, is the smallest one that removes the blocker:
a per-key immutable price snapshot (or a key-level price version) in Magpie's budget/usage path, so
the native used cost and the admission check read the same frozen tariff. Until then, testnet only.
