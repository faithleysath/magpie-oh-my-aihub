# Phase 8 — wallet UX, out-of-band statement and a first-use wizard

Status: **specification + inventory, written before implementation.** No production behaviour is
changed by this document. Wallet UX is a presentation layer over the phase-6/7 accounting: it reuses
`Wallet`, `ChainWatcher`, `ChainStore`, `Ledger` and `Provisioner` and adds **no payment path, no
second balance, no new listener and no new credit rule**.

| Item | Value |
| --- | --- |
| Base | `bf7a27d` (merge of PR #11), branch `feature/mvp-onboarding-operator-ux` |
| Platform of this round | macOS 26.6.2 (25G83), arm64, Bun 1.4.3 |
| Baseline tests | **392 pass / 0 fail / 1438 assertions / 25 files** (`bun test`, reproduced 2026-10-30) |
| Pinned upstream | Magpie `0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876`; EasyTier `2.6.4` = `8428a89d2dabc94c97d370ec607c6ca142473626`; Foundry `1.8.6` = `6bad0a66de7c83f7b33695044138f0f5fa4c5990` (from the phase-7 reports; not re-measured here) |
| Chain writes this round | **none**; every test uses a fake EVM transport and a fake Magpie, or local SQLite only |
| Real funds | still **NO-GO**; unchanged from phase 7 |

## 1. Decisions taken for this phase

1. Explorer links are **plain text URLs** (copyable), never an `<a href>` built at runtime. The page's
   "exactly two external documentation links" claim and `ARCHITECTURE.md` Decision 33 stay intact.
2. **No manual-credit path** is added for `unclaimed` / `manualReview`. The UX shows the evidence, the
   reason and the manual next step. Attribution rules do not change.
3. A consumer statement is **unsigned**. It carries a SHA-256 digest over canonical JSON and says in
   its own body that the digest proves only that the file was not edited by hand. It is not proof of
   payment, not a signature, and not an identity claim.
4. `wallet credit` is kept and fixed (CLI wiring is a separate owner's job). The data comes from a
   read-only aggregation over `deposit_events` joined to `deposit_intents`, plus the ledger balance.
5. Cumulative counters use **read-only SQL aggregation**, not the last 100 rows that the page used
   to count.
6. Tests may add `plugin/test/support/` helpers. Existing tests are not rewritten.
7. Pause and top-up keep their measured behaviour. A credit is booked while a consumer is paused and
   is spent only by `consumers reissue`; **a top-up never unpauses a key**, and the UX must not
   promise that it does.
8. `Wallet.statusLocal()` is a **synchronous, zero-RPC** status for the page snapshot.
   `Wallet.status()` keeps its authenticated health probe for the CLI.

## 2. Inventory: where credit actually enters and where it is read

### 2.1 Credit entry points (two, both without any payment UI)

| Entry | Path | What is written |
| --- | --- | --- |
| Simulated top-up | `topup <id> <usd>` → `POST /topup` → `Provisioner.topUp()` | `ledger.deposits` row with `source="simulated"` → native cap write → read-back → `markDepositApplied` |
| Testnet deposit | `wallet intent` → external wallet signs EIP-712 → ERC-20 transfer → watcher | `chain:<event-id>` deposit → `Provisioner.applyChainDeposit()` → cap write → read-back → applied, then the event becomes `credited` |

`applyChainDeposit()` is the only bridge from chain to credit. The chain modules cannot reach a
Gateway Key.

### 2.2 Read paths today

| Reader | Data | Known limit |
| --- | --- | --- |
| `GET /status` → `consumers[].ledger` | deposited / consumed / balance / overdraft / unsettled / priceVersion / window end | not joined to chain events; `all()` has no gateway read-back |
| `GET /wallet` → `WalletStatus` | registry, chain health, intents, events, anomalies, receiving, totals | no per-consumer ledger; totals counted over the last 100 events per chain |
| page snapshot | `wallet: walletStatusCache` | the cache is only filled by `GET /wallet`, so the page section stays empty until someone calls it (**reproduced**) |
| `wallet credit <id>` | intended chain credit view | reads a non-existent `wallet.consumers`, prints `null` (**reproduced**) |

## 3. Journey state specification

One deposit request, one event and one key read-back produce exactly one UX state. The mapping is
pure (no I/O) and lives in `src/walletview.ts`.

| State | Condition (actual fields) | Timestamps shown | Next step | Forbidden claim |
| --- | --- | --- | --- | --- |
| `awaiting-signature` | intent `status=requested`, `payerAddress=null` | `requestedAt`, `expiresAt` | sign the EIP-712 document, then `wallet sign` | "payment sent" |
| `payment-not-seen` | intent signed (`attributionStatus=signed`) and no event for the invoice | `requestedAt`, `expiresAt`, `updatedAt` | wait / `wallet scan <chain>` | "failed" |
| `observed` | event `status=observed` | `firstSeenAt` | wait for receipt verification | "confirmed" |
| `verifying` | event `status=uncertain` with a receipt/transport reason | `updatedAt`, `verifyAttempts` | next scan; RPC error is retryable | **"payment failed"** |
| `confirming` | event `status=confirming` | `confirmations` vs policy, `finalizedBlock`, ETA only as a stated estimate | wait | "credited" |
| `finality-reached` | event `status=finalized` | `finalizedAt` | wait for the ledger step | **"top-up complete"** |
| `crediting` | event `status=crediting`, or ledger deposit `intent`/`failed` | `updatedAt`, deposit `error` | `wallet scan` retry / operator review | "success" |
| `credited` | event `credited` **and** ledger deposit `applied` **and** gateway cap read-back matches | `creditedAt`, `appliedAt`, `readback.at` | use the key | "success" without read-back |
| `unproven` | event `credited` but deposit not applied, or no read-back | `creditedAt` | re-read the key (`wallet` / `wallet credit`) | "key is usable" |
| `unclaimed` | event `status=unclaimed` | `firstSeenAt`, tx | inspect the tx, contact the provider, never resend | **"funds lost"** |
| `uncertain` | event `status=uncertain` with two or more matching intents | `updatedAt` | manual review | any guess |
| `reverted` | event `status=reverted` (reorg) | `updatedAt`, anomaly | `consumers reissue`; balance is not edited | "refunded" |
| `manual-review` | event `status=manualReview` | `updatedAt` | operator review | automatic credit |
| `failed` | event `status=failed` (reverted transaction) | `updatedAt` | nothing to retry on this tx | "retry the payment" |
| `expired` | intent `status=expired`, no event | `expiresAt` | create a new request; a transfer sent anyway is `unclaimed` | "no funds arrived" |
| `cancelled` | intent `status=cancelled` | `createdAt` | new request | — |

Rule: when an event exists, the event state wins; the intent state is shown as a step. A receipt that
is only *verified* is never `credited`. An event that is only *finalized* is never `credited`.

### 3.1 Accounting panel per consumer

Required fields, all from existing reads: cumulative credit (`depositedNanos`), **settled consumption
(`consumedUsd`) and the priced part of it (`settledUsd` = consumed − unsettled, never negative)**,
applied credit, balance, overdraft, unsettled amount, pending deposits, `cap` / `used` / `left`,
`priceVersion`, window end (`reset`), accounting state (`ok` / `uncertain` + reason), open
settlements, unpriced calls, key state, per-chain chain-credit rows, `updatedAt`. The CLI view exposes
them through `accountingLine(consumer)`; the page may render a subset.

Key state is one of `usable`, `usable-but-export-withdrawn`, `spent`, `paused`, `revoked`,
`no-key`, `unverified`, `unknown`. `usable` requires a **gateway read-back**
(`Provisioner.verify()` / the `lim` half of `ledgerCheck`), a non-zero cap, `pending === false`,
no pause, no revoke, and a ledger deposit `applied` for the credited event. `lastCheck` alone is not
evidence.

### 3.2 Chain parity

BSC testnet 97 and Base Sepolia 84532 render with the same columns, the same state words and the same
aggregate shape. No text added by this phase may contain `primary`, `secondary`, `preferred`,
`default` or `fallback` as a chain choice. Differences appear only inside the finality
`mode`/`confirmations`/`rationale`/`measured` fields. A test runs the same journey on both chains and
compares normalised output, and swaps registry order to prove the set is equal.

## 4. Module contract (for the main, CLI, UI and security agents)

Owned by this phase, all in `plugin/`:

```ts
// src/walletview.ts — pure mapping, no I/O, no clock except the injected `now`
export interface KeyReadback { at: string; capUsd: number; usedUsd: number; leftUsd: number; fromGateway: boolean }
export interface LedgerDepositLike {
  id: string; consumerId: string; amountNanos: number; source: string;
  status: "intent" | "applied" | "failed";
  priceVersion: string | null; capAfterNanos: number | null;
  createdAt: string; appliedAt: string | null; error: string | null;
}
export interface ConsumerEvidence { /* structural subset of ConsumerView */ }
export interface WalletViewInput {
  wallet: WalletStatus;
  consumers?: ConsumerEvidence[];                 // Provisioner views
  deposits?: Record<string, LedgerDepositLike[]>; // Ledger.depositsFor(id)
  readbacks?: Record<string, KeyReadback>;        // from Provisioner.verify(), never lastCheck
  accounting?: { state: "ok" | "uncertain" | "unknown"; reason: string | null; serving: boolean } | null;
  now?: Date;
}
export function walletView(input: WalletViewInput): WalletView;
export function explorerTxUrl(blockExplorer: string, txHash: string): string; // plain text, no anchor
export function journeyLines(journey: DepositJourney): string[];              // CLI text
export function accountingLine(a: ConsumerAccounting): string;                // one CLI line, 11 fields

// src/walletamount.ts — exact decimal <-> raw base units
export function parseTokenAmount(text: string, decimals: number): { ok: true; raw: string; normalised: string } | { ok: false; reason: string };
export function formatTokenAmount(raw: string, decimals: number): string;
export function rawForUsd(input: { usd: number; decimals: number; nanosPerToken: string }): { raw: string; exact: boolean; note: string };
export function usdForRaw(input: { raw: string; decimals: number; nanosPerToken: string }): number;

// src/walletstatement.ts — out-of-band, unsigned, explicit allowlist
export interface StatementInput { /* providerId, consumerId, networks, assets, intents, events, deposits, consumer, accounting, readback?, generatedAt */ }
export function buildStatement(input: StatementInput): ConsumerStatement;   // { statement, digest }
export function statementText(statement: ConsumerStatement): string;        // pretty JSON
export function writeStatementFile(statement: ConsumerStatement, opts: { dir: string }): { path: string };
export function verifyStatement(statement: ConsumerStatement): { ok: boolean; reason: string | null };
export const STATEMENT_KEYS: readonly string[];                             // the allowlist itself

// bin/wallet-wizard.ts — interactive, transport injected, no key material
export interface WizardApi { get(path: string): Promise<any>; post(path: string, body: unknown): Promise<any> }
export interface WizardIO { prompt(q: string, opts?: { default?: string }): Promise<string>; print(line: string): void }
export interface WizardDeps { api: WizardApi; io: WizardIO; evidence?: () => Promise<WalletViewInput | null>; argv?: string[] }
export function runWalletWizard(deps: WizardDeps): Promise<number>;
```

Host wiring (owner: UI agent):

```ts
import { walletView } from "../src/walletview.ts";
const consumers = await provisioner.refreshAll();                    // real gateway read-back
const readbacks = {};                                                // from the same lim values
for (const c of consumers) readbacks[c.consumerId] = { at: new Date().toISOString(), capUsd: c.capUsd, usedUsd: c.usedUsd!, leftUsd: c.leftUsd!, fromGateway: c.usedUsd !== null };
const deposits = Object.fromEntries(consumers.map((c) => [c.consumerId, ledger.depositsFor(c.consumerId)]));
const view = walletView({ wallet: wallet.statusLocal({ consumerIds: consumers.map((c) => c.consumerId) }), consumers, deposits, readbacks, accounting });
```

`statusLocal()` must be used for the page snapshot: it performs no RPC. `status()` may run only on an
authenticated CLI health request.

CLI wiring (owner: CLI agent):

- `wallet credit <consumerId>` reads `wallet.consumers[].{chainCredit, ledger}` (now present).
- `wallet statement <consumerId> [--out <file>]`: the host builds the statement (it owns the ledger),
  the CLI writes it with `writeStatementFile` (mode 0600) or prints `statementText`. There is **no**
  new remote lookup endpoint; the statement is produced locally for an explicitly named consumer.
- `wallet wizard`: `runWalletWizard({ api, io, evidence })`.

## 5. Evidence rules (what may and may not be claimed)

1. `keyUsable` is true only with event `credited` **and** deposit `applied` **and** a gateway read-back
   whose cap matches `deposit.capAfterNanos`.
2. A successful receipt never becomes "credited"; the three states (`stored`, `verified`, `credited`)
   are separate steps.
3. A transport/RPC failure is `verifying`/`retryable`, never `failed`. Only a reverted transaction is
   `failed`.
4. An expired intent is `expired`; funds sent afterwards are `unclaimed`, not lost and not credited.
5. Cap `0` (or `limited=false`) means *unlimited*, never "zero credit". The UI shows `UNKNOWN —
   Magpie reports no limit` and the plugin refuses to treat it as usable.
6. `reverted` never changes the balance; it freezes the consumer and the fix is `consumers reissue`.
7. A paused consumer can still receive a deposit, but the credit is only spendable after `reissue`.
   No top-up, and no chain deposit, unpauses a key.

## 6. Test plan (journey first, then unit; zero payments)

Harness: `plugin/test/support/` — a controllable fake EVM transport (blocks, logs, receipts, reorg,
outage), a fake Magpie with the real observable contract (cap, used, 429, rotate/remove), the tiny
test signer already used by the existing suites, and a lab builder that wires the **real** `Wallet`,
`ChainWatcher`, `ChainStore`, `Ledger`, `Provisioner` and the production credit-sink shape.

1. `test/wallet-journey.test.ts` — the whole journey on both chains: signature → payment not seen →
   observed → receipt outage (retryable) → confirming → finality → credit failure (cap unchanged) →
   retry → credited → read-back → usable; plus expired-but-paid, unclaimed, two candidates, reorg
   freeze, `limited=false`, and no duplicate credit on rescan.
2. `test/wallet-view.test.ts` — pure mapping edge cases, wording guards, parity, aggregates.
3. `test/wallet-statement.test.ts` — allowlist exactness, digest stability, per-consumer filtering,
   0600 output, no network imports.
4. `test/wallet-wizard.test.ts` — injected API: exact raw amounts, existing-pending refusal, unknown
   POST result stops without a blind retry, success only with evidence.

Not tested and not claimed here: a real RPC, a real Magpie call, a real testnet transfer, mainnet.

## 7. Verification status of this document

- **VERIFIED** — 392/0 baseline; `WalletStatus` has no `consumers`; `walletStatusCache` is written only
  by `GET /wallet`; `Wallet.status()` performs live RPC through `health()`; totals are counted over the
  last 100 events per chain; `verify()` throws when Magpie reports `limited=false`.
- **REPRODUCED** — `wallet credit` prints `ledgerCredit: null` (local probe, no network, no writes).
- **UNKNOWN** — page rendering of the new view model (owner: UI agent); whether the host exposes the
  statement through a route (owner: CLI agent).
- **No chain write, no payment, no upstream change, no ACL change, no admin exposure.**

## 8. Security review checklist

- No new listener, route, port, ACL rule or overlay publication.
- No private key, mnemonic, secret or Gateway Key in a statement, a view model or a log line.
- Statement fields are an explicit allowlist; unknown fields are refused by `verifyStatement`.
- `wallet statement` operates on one explicitly named consumer, locally; there is no remote
  consumer-id query and the catalogue server is untouched.
- Amounts stay exact integers (`raw` base units); no float arithmetic on token amounts.
- No retry of a payment or of an unknown broadcast result; the wizard stops and says so.
- Wording never turns "finalized", "receipt ok" or "credited event" into "key is usable".

---

# Phase 8 implementation record

Written after the spec, in the order the brief requires: journey tests first (they failed with
`Cannot find module '../src/walletview.ts'`), then the modules, then the unit tests.

## Delivered modules (this phase's ownership only)

| File | What it is | Tests |
| --- | --- | --- |
| `plugin/src/walletview.ts` | Pure presentation model: journey states, per-consumer accounting, per-chain totals, alerts, plain-text explorer URL, CLI lines. No I/O. | `test/wallet-journey.test.ts` (13), `test/wallet-view.test.ts` (14) |
| `plugin/src/walletstatement.ts` | Unsigned consumer statement: allowlist, canonical-JSON SHA-256 digest, safe verify, exclusive 0600 write. | `test/wallet-statement.test.ts` (9) |
| `plugin/src/walletamount.ts` | Exact decimal ↔ base-unit conversion, USD helper that reports non-exactness. | `test/wallet-wizard.test.ts` (amount section) |
| `plugin/bin/wallet-wizard.ts` | Interactive/non-interactive wizard over the injected loopback API. No key, no broadcast. | `test/wallet-wizard.test.ts` (9) |
| `plugin/src/wallet.ts` | `statusLocal()` (sync, zero RPC), SQL totals, per-consumer chain credit, fixed `consumerChainCredit()`. | above + `test/wallet-view.test.ts` |
| `plugin/src/chainstore.ts` | Read-only aggregates only: `eventTotals`, `eventTotalsForConsumer`, `eventsForConsumer`. | `test/wallet-view.test.ts` |
| `plugin/test/support/*` | Fake EVM transport, fake Magpie, test signer, lab builder. New files; existing tests untouched. | — |

`bin/ohmyaihub.ts`, `src/server.ts`, `src/service.ts`, `page/*` and `plugin/README.md` were **not**
changed by this phase; their wiring is owned by the CLI, security and UI agents (see §Host wiring).

## Exact wizard contract

```ts
runWalletWizard({
  api,            // injected loopback client; GET/POST only
  io,             // prompt/print
  argv,           // flags below
  evidence,       // MUST be `() => api.get("/wallet/evidence")`; without it the wizard never claims success
  sleep?, attempts?, now?,
}): Promise<0 | 1 | 2 | 3>
```

Flags: `--consumer`, `--provider`, `--chain`, `--asset`, `--amount`, `--ttl`, `--invoice`,
`--signature`, `--signature-file`, `--payer`, `--force`, `--yes`, `--no-watch`,
`--non-interactive` (alias `--batch`).

- **No default chain and no silent provider.** A missing `--chain`/`--provider` is an error in
  non-interactive mode (exit 2) and an empty answer in interactive mode. The provider is never taken
  from `receiving[0]`.
- **Typed data comes from the host response** (`response.typedData`). On `--invoice` resume it is
  rebuilt with the production `intentTypedData()`/`intentDigest()`, so the document is never empty.
- **Amounts are token decimals**, parsed exactly to base units; `--amount 1.0000001` for a 6-decimal
  token is refused rather than rounded.
- **Create without signing is a success** (exit 0) that prints `AWAITING SIGNATURE` and a resume
  command. Nothing is told to be sent before a signature is recorded.
- **Unknown POST outcome** (`WizardApiError` with `status === null`) prints "Do NOT retry blindly"
  and exits 3 without a second POST.
- Exit codes: `0` created/signed/usable, `1` refused or needs a human, `2` missing/invalid input or
  unavailable network, `3` unknown outcome (check before retrying).

The CLI adapter must construct `new WizardApiError(message, status)` where `status` is the HTTP status
for a real response and **`null` for a transport/timeout failure**. Mapping a timeout to 5xx would
turn an unknown outcome into a definite one.

## Host wiring required (owners: CLI / security / UI)

The wizard and `wallet status` need evidence the plain `/wallet` status does not carry. The only
acceptable source is the **authenticated loopback API**; no remote consumer lookup is added.

`GET /wallet/evidence` (Bearer token, loopback only) →

```json
{
  "wallet": WalletStatus,
  "consumers": ConsumerView[],
  "deposits": { "<consumerId>": LedgerDeposit[] },
  "readbacks": { "<consumerId>": { "at": "ISO", "capUsd": 1.0001, "usedUsd": 0, "leftUsd": 1.0001, "fromGateway": true } },
  "accounting": { "state": "ok|uncertain|unknown", "reason": null, "serving": true }
}
```

that is exactly `WalletViewInput` minus `now`. Service method (owner: CLI agent, `service.ts`):

```ts
async walletEvidence(): Promise<{
  wallet: WalletStatus;
  consumers: ConsumerView[];
  deposits: Record<string, LedgerDeposit[]>;
  readbacks: Record<string, KeyReadback>;
  accounting: { state: "ok" | "uncertain" | "unknown"; reason: string | null; serving: boolean };
} | null>
```

- `wallet: w.statusLocal({ consumerIds })` — synchronous, no RPC, safe for a page snapshot.
- `consumers: await this.provisioner.refreshAll()` — this is what performs the gateway read-back.
- `readbacks`: take the `lim` from `Provisioner.verify(rec)` (or a successful `ledgerCheck`), **not**
  `lastCheck`; omit a consumer whose read failed. `fromGateway: true` only for a real read.
- `deposits`: `this.ledger.depositsFor(id)` per consumer.
- `accounting`: `{ state: uncertain ? "uncertain" : lastCheckAt ? "ok" : "unknown", reason: uncertainReason, serving }`.

`GET /wallet/statement?consumerId=<id>` → `{ "statement": ConsumerStatement }`, built by
`buildStatement()` in the host (it owns the ledger). Service method:

```ts
async walletStatement(consumerId: string): Promise<ConsumerStatement | null>
```

It must use `w.intents(consumerId)` and `w.chainStore().eventsForConsumer(consumerId)`; the builder
now **refuses** foreign intents, foreign events and foreign deposits, so a host bug cannot leak
another consumer's row. The CLI writes the response with
`writeStatementFile(statement, { dir: --out ?? <magpie data>/oh-my-aihub/statements })`; `--out` is a
directory, the file is `0600`, and an existing file is refused (new timestamp → new name).

`wallet status` = `GET /wallet/evidence` → `walletView(input)`; print chains/totals/consumers/alerts
and `journeyLines()` for each deposit. `wallet credit` reads `wallet.consumers[].{chainCredit, ledger}`
from `/wallet`.

## Statement hardening (after review)

- The builder checks `consumer.consumerId`, every intent, every event's `invoiceId` and every
  deposit's `consumerId`. Mixed input throws; events with no invoice are excluded (not attributable).
- `verifyStatement()` accepts the wrapper or the bare file, type-checks every level, and returns
  `{ok:false}` for `null`/wrong shapes instead of throwing.
- The writer uses `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` mode 0600, refuses an existing file, refuses a
  symlinked output directory, and sanitises `generatedAt` so it cannot contain a path separator.
- `totals.consumedUsd` (settled consumption) is included next to credited/applied/balance/overdraft/
  unsettled. The statement stays unsigned; its digest is explicitly not proof of payment.

## Provisioner fix: a refused cap write no longer strands a chain deposit (approved)

**Trigger, exactly.** `applyChainDeposit()` books the chain deposit as an `intent`, then sets
`rec.pending`, then writes the cap. If `setCostLimit()` throws (Magpie refused the write), the
pending record stays. The next `reconcile()` — from the page, a status read, or the next scan — saw
that Magpie did not hold the pending cap and called `markDepositFailed(chain:<event>)`. The chain path
cannot mint a new deposit id, so `applyChainDeposit()` then refused it forever ("it needs a new id"):
the payment stayed `crediting` with no operator path back.

**Old state:** event `crediting`, ledger deposit `failed`, balance unchanged, cap unchanged, retry
blocked permanently.
**New state:** event `crediting`, ledger deposit **`intent` with the same `chain:<event>` id**, then
the next scan credits it once.

**The fix** (`provisioner.ts`, ~15 lines): `reconcile()` now distinguishes the provenance of the
pending deposit. If it is still `intent` and chain-derived (`source`/id starts with `chain:`), it
clears the pending and logs that the deposit stays booked; it does **not** mark it failed. Simulated
top-ups keep the old semantics (their caller can retry with a new id). The helper is
`isChainDerivedDeposit()`.

**What is preserved, explicitly:**
- the deposit id is unchanged (`chain:<event id>`); no second deposit is created;
- the retry goes through `ChainWatcher.creditFinalized()` → `reconfirmChain()`, which re-reads the
  canonical block and re-evaluates finality before `applyDeposit()`; a reorg now marks the event
  `reverted` and applies nothing (regression test covers this);
- the credit is booked only after `setCap` + `verify()` read-back; nothing is "assumed applied";
- a ledger deposit row is never deleted; a reverted event keeps its intent row for audit;
- signature attribution (`invoiceId`, recovered payer) is untouched;
- `reconcile()`'s crash path (the pending cap *is* in force) still books it applied — that is a
  proven read-back, not a guess.

**Why `failed` is terminal here, and why that matters:** `applyChainDeposit()` refuses a `failed`
deposit and no CLI command can un-fail one. For chain deposits `failed` must therefore mean "this
deposit can never be valid" (amount conflict, below the enforceable minimum, above the maximum) —
not "the cap write was refused once". Those genuine cases are unchanged.

**Regression tests** (`test/wallet-journey.test.ts`):
1. *REGRESSION: a cap write Magpie refused keeps the same chain deposit booked, and the retry credits
   once* — old code failed at `expect(booked.status).toBe("intent")` (got `failed`); new code passes,
   and the same id is applied exactly once with cap `1.0001`.
2. *REGRESSION: a failed cap write followed by a reorg is never credited — the retry re-checks the
   chain* — the event becomes `reverted`, the deposit stays `intent`, the balance and cap do not move.

Targeted suites after the fix: `chain-credit`, `wallet-reliability`, `provisioner-ledger`,
`provisioner`, `review-fixes`, `final-fixes`, `ledger` → **102 pass / 0 fail**; the four wallet
suites → **49 pass / 0 fail**; full `tsc --noEmit` clean.

## Consumer vs provider: what crosses the boundary (out-of-band only)

The wallet flow is two people, and the docs must not read as if the payer runs the provider's node.

| | Provider P | Consumer C |
| --- | --- | --- |
| Runs | the Magpie that shares models, the plugin host, its loopback management API, the ledger, the watcher, the wizard, the statement export | its own Magpie, its own wallet, an ordinary browser/explorer |
| Never | — | calls P's loopback API, runs P's wizard, reads P's ledger, or sees P's `consumerId` balance remotely |
| Receives | C's signature + payer address, returned as a file | P's EIP-712 deposit request as a file; later an unsigned statement as a file |

The handoff is three files, no API:

1. **P → C: deposit request.** P runs
   `wallet wizard --consumer <id> --provider <id> --chain <id> --amount <tokens> --non-interactive --no-watch`
   and hands over the printed JSON: `typedData`, `invoiceId`, `digest`, `expiresAt`, chain, asset,
   token contract, recipient, exact `expectedAmountRaw`. C verifies the document offline (domain,
   chainId, verifyingContract `0x…a1b2`, token contract, recipient, amount, nonce, expiry) and signs
   it with their own wallet. There is no need for C to reach P's API: the document is self-contained.
2. **C → P: signature.** C sends `{ "signature": "0x…", "payerAddress": "0x…" }` (or a bare
   signature plus the address) as a file, or pastes it into the provider terminal. P submits it with
   `wallet wizard --consumer <id> --invoice <id> --signature-file <file> --non-interactive` (or
   `--signature`/`--payer`). The plugin recovers the signer locally and requires it to equal the
   stated payer; a signature over another document is refused.
3. **P → C: statement.** P runs
   `wallet statement <consumer> --out <file>` (loopback + token, one named consumer) and hands over
   the unsigned JSON. C verifies the digest, checks every tx on the explorer, recomputes the credit at
   the recorded `priceVersion`, and compares `capUsd`/`usedUsd` with what C's own Magpie reports for
   its own key. The statement is not proof, and it is not a lookup service.

Non-interactive exit codes are part of this contract: creating a request without a signature is a
success (exit 0, `AWAITING SIGNATURE`); an unknown POST outcome is exit 3 and must be checked before
any retry; a missing `--chain`/`--provider` is exit 2. The CLI adapter maps a transport timeout to
`WizardApiError(message, null)` — never to a 5xx — so the wizard can tell "unknown" from "refused".

**Review of the shared docs (`docs/ONBOARDING.md`, `docs/OPERATIONS.md`; owned by the CLI/UI agents):**

- `ONBOARDING.md` §6 currently reads as a single operator ("you sign with your own wallet", "the
  wizard … records your signature"). In the two-party model the payer is C: P only creates the
  request and submits C's signature. Add the three-file handoff above and say explicitly that C does
  not run P's wizard or call P's API.
- Both docs use `wallet statement <consumer> --out "$HOME/<consumer>-statement.json"` (a **file**
  path). The module now supports `writeStatementFile(statement, { path })` for exactly that, and
  `{ dir }` for a generated name. The CLI should map `--out` to `{ path }`.
- `OPERATIONS.md` "finalized but not credited" says a retry is bounded per tick. With the fix, a
  refused cap write keeps the same deposit booked and retries the same id; a reorg turns it
  `reverted` instead. That sentence should mention both outcomes.
- `wallet status` must print `accountingLine()` per consumer (see below), not only cap/used, so
  `consumedUsd`/`settledUsd` are visible as the eleven-field view the operator asked for.

## Verification of this round

- **VERIFIED (local, 2026-10-30, macOS 26.6.2 arm64, Bun 1.4.3):**
  `bun test test/wallet-journey.test.ts test/wallet-view.test.ts test/wallet-statement.test.ts test/wallet-wizard.test.ts`
  → **49 pass, 0 fail, 321 assertions, 4 files**; targeted `chain-credit`/`wallet-reliability`/
  `provisioner*`/`review-fixes`/`final-fixes`/`ledger` → **102 pass, 0 fail**.
- **VERIFIED:** `tsc --noEmit` clean for `walletview.ts`, `walletstatement.ts`, `walletamount.ts`,
  `wallet.ts`, `chainstore.ts`, `bin/wallet-wizard.ts`; `bun run boot-check` PASS;
  `bun run secret-scan` PASS.
- **REPRODUCED:** the wizard test prints `{}` before the fix (typedData source) and the real
  `primaryType: DepositIntent` document after it; the chain-default test fails before the fix.
- **CI blocker fixed (`test/wallet-surface.test.ts`):** the surface test called `await w.status()`,
  which performs a live `eth_chainId`/`eth_blockNumber`/`eth_call` probe against the default public
  testnet endpoints. Under `bun run ci` it hit the 5 s test timeout once and then passed on retry —
  a network dependency, not a product bug. It now calls `statusLocal()` (the page's synchronous,
  zero-RPC status) and asserts the honest un-probed shape (`head === null`, no endpoints). The
  suite's `wallet()` helper also injects a `makeWatcher` that throws, and the two `wallet-view.ts`
  fixtures that build a bare `Wallet` do the same, so **no wallet test can open a socket**. Verified
  by five consecutive runs of `wallet-surface` + `wallet-view` with 0 failures.
- **Shared tree:** a concurrent UI change re-localised `page/index.html`; the pre-existing
  `wallet-surface.test.ts` page assertions were updated by the UI agent. One `page-settings.test.ts`
  assertion was failing at the time of writing and is outside this phase's files.
- **No chain write, no payment, no signer for a chain transaction, no new listener or route in this
  phase's files.**
