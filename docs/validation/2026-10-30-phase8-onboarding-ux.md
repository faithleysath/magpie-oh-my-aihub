# Phase 8 — onboarding and operator UX acceptance

**Status: validation completed, not user acceptance.** The product owner has not accepted this work;
this is the completed validation result. The live lab's **frozen** report is [`phase8-live/lab-report.json`](phase8-live/lab-report.json)
(2026-10-30T08:26:53Z, network `phase8-lab-17425`, 18/18); the browser/page checks passed. The wallet
wizard returned real EIP-712 typed data on both testnets without a signature or a transfer, and the
statement file was produced live. This is not a real-money, real-vendor or desktop-WKWebView claim.

The plan and claim boundaries are in [`phase8-journey-plan.md`](phase8-journey-plan.md). The lab's own
human-readable report is [`2026-10-30-phase8-live-lab.md`](2026-10-30-phase8-live-lab.md); failed
attempts and their corrections are in [`phase8-live/ATTEMPTS.md`](phase8-live/ATTEMPTS.md). The user
documentation is [`../ONBOARDING.md`](../ONBOARDING.md), [`../OPERATIONS.md`](../OPERATIONS.md) and
[`../../plugin/README.md`](../../plugin/README.md).

A subsequent pre-merge entry review found and repaired three options/startup defects. See
[PR #12 options review fixes](2026-10-30-pr12-options-review-fixes.md) for the failing-before/passing-after
regressions and the updated **577-test** local result. The frozen live evidence below is unchanged.

## 1. Result in one screen

| Area | Result | Evidence |
| --- | --- | --- |
| Guided provider/consumer CLI flow | **PASS, 18/18 steps (frozen run)** | [`phase8-live/lab-report.json`](phase8-live/lab-report.json), [`transcript.log`](phase8-live/transcript.log), [`source-manifest.json`](phase8-live/source-manifest.json), [`2026-10-30-phase8-live-lab.md`](2026-10-30-phase8-live-lab.md) |
| Real Magpie / EasyTier / Remote Magpie | **REPRODUCED** on three isolated profiles; real gateway, real native Remote Magpie, real EasyTier 2.6.4, mock upstream | same |
| Setup is idempotent | **PASS** — same node/instance/mapped address/secure key; no reset | lab step |
| Invalid/stale approval JSON | **PASS** — refused; no key or consumer created | lab step |
| No/wrong/valid key | **PASS** — 401 / 401 / 200 | lab step |
| Real model path | **PASS** — C → real Remote Magpie → P mock upstream; 200 → native 429 → topup → 200; upstream count 2 | lab step |
| Independent provider fault | **PASS** — P2 down: peer-p still 200; peer-p2 degraded; targeted removal leaves peer-p 200 | lab step |
| Restart recovery | **PASS** — same identity, provider connected, call 200 | lab step |
| Wallet wizard typed data and statement | **PASS** — real typed data for 97 and 84532, exact raw amounts, no default chain; live unsigned 0600 statement; **no signature and no transfer** | lab step, `phase8-live/wallet-statement.json` |
| Page/browser | **PASS** on an isolated `magpie web` **0.1.2171** run: real CSP, Save writes/restarts (pid 86260 → 91553 → automatic reload), projected snapshot renders; **desktop WKWebView UNKNOWN** | [`phase8-csp.md`](phase8-csp.md) §10 |
| Wallet unit/targeted tests | **PASS** — 49 wallet-suite + 102 accounting/ledger targeted; CLI targeted 21; statement-shape regression added after the live finding | [`phase8-wallet-ux.md`](phase8-wallet-ux.md), CLI owner |
| Full CI | typecheck, boot-check, secret-scan and **573 tests / 0 fail / 35 files** passed on the same frozen tree; final GitHub CI is linked in the PR checks | [`phase8-ci.txt`](phase8-ci.txt) |
| Real funds | **NO-GO** | unchanged architecture blockers |

## 2. Exact environment and evidence identity

| Item | Value |
| --- | --- |
| Platform | macOS 26.6.2 (25G83), Darwin arm64 |
| Bun | 1.4.3 |
| Magpie host/CLI | 0.1.2038; app `/Users/laysath/Projects/lab/magpie-iso/Magpie.app`; binary SHA-256 `0640889d004edfc1da0cd12bf8995e134968ea9b8ac4887d295d8989dadd4e15` |
| EasyTier | 2.6.4; zip SHA-256 `4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b` |
| Plugin | base `bf7a27dfd6cc785db61b22808d5a36f625d13419` plus the phase-8 working tree (`dirty: true` at the run); each node's plugin copy was SHA-256 captured at copy time and proved identical to the repo at report time (13 files, `source-manifest.json`); final commit/PR is the main agent's |
| Lab nodes | P (provider), C (consumer), P2 (second provider for fault isolation) |
| Isolation | per-node Magpie app copy, per-node Magpie data/HOME, **per-node plugin package copy** (no shared `page/status.js`); user `~/.config/magpie` not touched |
| Lab network | `phase8-lab-17425`; frozen report `2026-10-30T08:26:53.746Z`; ports in `lab-report.json` |
| Provider identity | P node `5aa55370`, mapped `10.66.174.141/32`, gateway 52745, quote `0ada21af…`, fingerprint `f7ecd55e…`, `priceVersion 148dca96…` |
| Consumer identity | C node `3aaeaa82`, SOCKS 13587 |
| Second provider | P2 node `8be7f841`, mapped `10.66.53.235/32` |
| Upstream | deterministic local mock, one native model per node (`p/p-model`, `c-model`, `p2-model`), price 1000/1000 |
| Page browser | isolated `magpie web` **0.1.2171**; page-facing source identity separately compared at 2038/2120; desktop WKWebView **UNKNOWN** |
| Chain writes | **none** in phase 8; no public testnet transaction; both wallet intents cancelled after typed data |

The public testnet evidence is **prior, merged evidence**, not re-run here: [fresh two-host BSC/Base
payments](2026-10-30-fresh-twohost-wallet.md), [real-Magpie replay](2026-10-30-live-magpie-chain-credit.md),
and the [testnet handoff](2026-10-30-testnet-handoff.md).

## 3. What each journey actually covered

> The step results below are from the frozen 18/18 run in `phase8-live/lab-report.json`.


### A. New provider — **REPRODUCED**

- Fresh Magpie 0.1.2038, its own plugin copy, real host and EasyTier 2.6.4.
- `setup` preflight matched 0.1.2038 and verified EasyTier; no overlay yet.
- `setup` created the provider overlay and published native `p/p-model`; quote v1, content hash,
  full fingerprint, `priceVersion`, `priceLocked:false`.
- `share setup --all-priced --publish` selected only the native priced model; the native provider
  remained the served provider; P had no Remote Magpie.
- `share approve` issued a model-scoped/capped key and `share handover` wrote a 0600 file without
  printing the key.
- Key enforcement on P's real LAN gateway: no key 401, wrong key 401, handed key 200.
- `topup` raised only that key; P's upstream was hit twice on the measured 200/429/200 sequence.

### B. New consumer — **REPRODUCED**

- C joined the same overlay, consume-only, discovery on; its gateway answered 401 without a key.
- C discovered P through EasyTier; P was `unverified`, with the full Ed25519 fingerprint and quote
  hash. Unverified and wrong-fingerprint acceptance were refused; the exact fingerprint/quote was
  accepted and the request was written 0600.
- P approved the request, wrote a 0600 key file, and C connected with `connect --key-file` and the
  same accepted fingerprint/quote.
- `remote test`/`remote models` touched only peer-p. C's Magpie called the real Remote Magpie:
  200 → native 429 → `topup` → 200; P's mock upstream counted exactly two calls.
- An invalid/stale approval request was refused and created no consumer/key.
- `consume off` removed the plugin-owned Remote Magpie and kept a hand-made provider; `consume on`
  re-registered peer-p and the call returned 200.

### C. Two-chain wallet — **REPRODUCED for typed data and statement; real credit is prior evidence**

- P enabled 97 and 84532 with explicit RPCs, registered the phase-7 test tokens after `decimals()`,
  and published a receiving address per chain.
- `wallet wizard --batch` returned non-empty, real typed data for both chains: 97 raw `1000000`
  (6 decimals) and 84532 raw `1000000000000000000` (18 decimals); exact digests are in the frozen
  report. No chain was chosen by default.
- The intents were left `awaiting signature` and then cancelled; **no signature, transfer, scan or
  chain write** happened. `wallet statement` then produced a named-consumer unsigned 0600 file
  (digest `1e72d3f3278d…`, chains `[84532,97]`, two cancelled requests, `signed:false`). The external
  signature→credit path was **not** exercised.
- The live lab did not re-run a public payment or a finality wait. Those remain **VERIFIED only in
  the prior PR #11/fresh two-host evidence**.
- The wizard/statement design is two-party: P creates the typed data and statement; C signs
  externally and returns `{signature,payerAddress}`; C never runs P's wizard or accesses P's loopback
  API. The docs state this and the three file deliveries. The exported unsigned statement is
  [`phase8-live/wallet-statement.json`](phase8-live/wallet-statement.json) (mode 0600 in the tree).

### D. Failure, restart, isolation — **REPRODUCED**; backup/restore **UNKNOWN**

- Restarting P and C recovered the same node/instance/mapped/secure identity, peer-p connected, and a
  real call returned 200.
- P2 was a genuinely independent Magpie/overlay/key. Stopping P2 made peer-p2 `degraded` while
  peer-p stayed connected and returned 200; removing peer-p2 left peer-p 200.
- A hand-made Magpie provider survived `consume off/on`; only the plugin-owned provider was removed
  and restored.
- **Not run:** backup/restore, a live price-window pause/reissue, a live log-gap resolution, a live
  reorg, or a real wallet signature/credit. Their logic is covered by existing tests and prior
  reports; the stopped-host backup/restore procedure remains a documented procedure, not a phase-8
  execution claim.

### E. Page and CLI — **REPRODUCED / browser PASS; desktop UNKNOWN**

- CLI: all 18 live steps used the shipped CLI entry (`bin/ohmyaihub.ts`) and the real host API; no
  direct service calls in the user journey.
- Page: UI agent's isolated `magpie web` 0.1.2171 run passed 70 checks: real CSP header and sandbox,
  Save wrote `plugins.json` and restarted the shared host (pid 86260 → 91553), the page reloaded and
  verified the new pid, a no-op second Save did nothing, the snapshot rendered all six sections with
  full fingerprints/hashes and no payer address/keys/absolute paths/RPC URLs. The desktop WKWebView
  frame is **UNKNOWN**; the test used `magpie web`.
- The UI run found a `submit` button that did nothing under `sandbox allow-scripts` without
  `allow-forms`; it was changed to a plain click button and is covered by a page test.
- At browser time the local flat quote lacked `billing.priceVersion`; the service now carries the
  billing clone and a catalog-service assertion covers it. **No second browser run after that fix**
  is claimed.
- The page is read-only after onboarding; the CLI is the operator surface. Page URLs/screenshots are
  capability data and must not be shared.

## 4. The nine focused acceptance checks

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `setup` repeated on an existing node does not reset | **PASS** | Same nodeId, instanceId, mapped CIDR and secure public key across the repeat (exact ids in the frozen report); no `/configure` reset |
| 2 | Untrusted/invalid approval JSON is refused; no key | **PASS** | Stale quote hash refused; consumer `deadbeef` not created; existing consumer count stayed 1 |
| 3 | Native provider unchanged | **PASS (observed)** | P's native `p/p-model` remained the shared/served model; P was `--no-consume` and had no Remote Magpie; selected only the native priced model |
| 4 | No key / wrong key / valid key | **PASS** | 401 / 401 / 200 on P's real LAN gateway |
| 5 | Real model/Remote call and 429 | **PASS** | C's Magpie → peer-p → P mock upstream: 200, native 429, topup, 200; upstream count 2 |
| 6 | One provider error does not affect another | **PASS** | P2 down: peer-p connected/200, peer-p2 degraded; removal targeted; peer-p still 200 |
| 7 | Restart recovery | **PASS** | P/C restarted; same identity/provider; call 200 |
| 8 | Wallet wizard real typed data, both chains | **PASS** | 97 and 84532 real typed data/digests, no default chain, no signature/transfer; live `wallet statement` wrote a named-consumer unsigned 0600 file (digest `1e72d3f3…`, chains 84532/97) |
| 9 | Cleanup and isolation | **PASS** | Lab removed, no processes, ports free, `userProfileTouched:false`; per-node plugin copies; no public chain write |

## 4a. Product defects this lab found and their state

These were real integration defects, found by the live run and fixed before the frozen report; each is
covered by a targeted test.

| Defect | Effect | State |
| --- | --- | --- |
| Catalogue `contentHash` was computed over different bytes on the provider (no `publication`) and the consumer (full body) | every real `share approve` failed | **fixed**: the provider publishes the verified full-body hash; re-run passes |
| `connect --trust` could leave the same command's request seeing `unverified` because the trust refresh was swallowed | a correct acceptance needed a retry | **fixed**: trust requires the exact fingerprint and updates the cached peer synchronously only when the cached quote matches; final run shows no race |
| `wallet statement` spread the live `serving` flag into the historical statement | statement verification failed (`unexpected field serving`) | **fixed**: the statement carries exactly `state`/`reason`/`openSettlements`; live 0600 statement now passes |
| `magpie plugin add` can exit non-zero after its host logs a startup error although `plugins.json` recorded the spec | lab harness had to accept the recorded spec | **lab workaround only**; product behaviour unchanged; follow-up candidate |
| One five-port catalogue window for provider and consumer on one machine | discovery only probes `base … base+4` | **lab-only constraint**; a real two-machine deployment uses 3426 |

## 5. What is still UNKNOWN or not tested

- **Backup/restore was not executed** in phase 8. The stopped-host procedure is documented in
  OPERATIONS; it restores to the **original absolute Magpie data path**. The ledger's usage-log
  identity is tied to the resolved path, so cross-root migration is untested and unsupported. A live
  `ledger.sqlite`/`chain.sqlite` copy is explicitly unsupported.
- **No live wallet signature or credit** in phase 8. The wizard returned real typed data and the
  intents were cancelled; real credit is the prior PR #11 evidence. `wallet statement` **was**
  produced live (named consumer, unsigned 0600 file, digest `1e72d3f3…`, chains 84532/97); the
  exported copy is [`phase8-live/wallet-statement.json`](phase8-live/wallet-statement.json).
- **No real vendor execution.** Every measured upstream was a local deterministic mock.
- **No real money/mainnet.** Real-money Production remains NO-GO for the unchanged price-lock,
  overshoot, interrupted-call and RPC-trust reasons.
- **Magpie 0.1.2171 host/CLI is UNKNOWN.** Only the page/browser was measured on 0.1.2171; the
  host/CLI and billing pin remain 0.1.2038. Desktop WKWebView is UNKNOWN; `magpie web` was used.
- **Linux Magpie GUI/provider is UNKNOWN.** Linux EasyTier and the 0.1.2057 Linux consumer container
  are the measured scope.
- **No human user study.** The flow was exercised by agents through the guided CLI/page; ordinary
  Magpie users were not observed. The verdict is about the tested flow, not a human-factors claim.
- **No backup/restore, live reorg, live price-window pause, or live log-gap resolution** in the
  phase-8 live lab. Those remain covered by the phase-6/7 reports and tests, not re-measured here.
- The trust-refresh race was **not observed** in the final run; the first harness attempts and their
  failures are listed in §6.

## 6. Failed attempts and cleanup (honest record)

- **Seven attempts** are recorded in [`phase8-live/ATTEMPTS.md`](phase8-live/ATTEMPTS.md): harness
  isolation (source app vs per-node copy), the five-port catalogue window, a pass with incomplete
  metadata, the real `wallet statement` defect, the harness's wrong statement-file read, a
  `magpie plugin add` exit code, and a source-manifest race while another agent edited the tree. Each
  has its cause, correction and raw evidence.
- The frozen live lab (`lab-report.json`, `transcript.log`, `source-manifest.json`,
  `wallet-statement.json`, `cleanup.json`) removed its temp root; `cleanup.json` shows 6 owned PIDs
  stopped, 0 remaining, all 13 ports free, and no public testnet transaction from phase 8. The source
  manifest is `ok:true` for all 13 files (identical across the three node copies, unchanged since copy,
  identical to the repo at report time).
- The failed attempts are preserved, not used as pass evidence; the final frozen report is the 18/18
  run above. The evidence directory also carries the exported `wallet-statement.json`; the CI record
  is [`phase8-ci.txt`](phase8-ci.txt) and the human-readable lab note is
  [`2026-10-30-phase8-live-lab.md`](2026-10-30-phase8-live-lab.md).

## 7. CI and page evidence boundaries

- CLI owner full CI on the frozen tree: `bun run ci` — typecheck PASS, **573 tests / 0 fail /
  2471 assertions / 35 files**, boot-check PASS (plugin 0.4.0, Magpie 0.1.2038 stub, API 34517,
  `page/status.js` 0600), secret-scan PASS, `git diff --check` 0; recorded in
  [`phase8-ci.txt`](phase8-ci.txt). The final GitHub CI on the main agent's commit is linked in the
  PR checks.
- UI evidence: `phase8-csp.md` §10 — 70-pass isolated `magpie web` 0.1.2171 run, real CSP/Save/pid
  restart/reload, projected snapshot; desktop WKWebView UNKNOWN; post-fix local quote priceVersion
  covered by service/test, no second browser run.
- Wallet evidence: `phase8-wallet-ux.md` — 49 wallet-suite + 102 accounting/ledger targeted tests;
  the live lab adds real typed data for 97/84532 with no payment.

## 8. Verdicts

**MVP Usability: GO (limited to the tested guided flow).** A Magpie user can follow the documented
`setup → share setup → approve/handover → connect → remote test/models → 200/429/topup` flow, and the
page's setup/save/restart/snapshot path passed on an isolated 0.1.2171 `magpie web` run. This is not
a human user study, the desktop WKWebView was not measured, and 0.1.2171 host/CLI remains UNKNOWN;
the verified host/CLI pin is 0.1.2038.

**Testnet E2E: GO (limited).** The phase-8 wizard produced real typed data for both 97 and 84532
with no default chain and no transfer, and produced a live unsigned statement; the prior merged
two-host run is the real BSC/Base credit/finality evidence. Live signature→credit and real vendor
execution were not run in phase 8.

**Real-money Production: NO-GO.** The 0.1.2038 price-lock finding, overshoot, interrupted calls and
RPC trust are unchanged; 0.1.2171 billing is not re-measured; no real vendor execution and no real
funds were used.
