# LATEST FINAL STATE — supersedes every earlier section of this file

> The round-1 report and the "Post-review rework" section below are retained as
> history. Wherever they say **F11 open**, **Zero-file P2P NO-GO**, **re-approval
> delivery PARTIAL**, or **legacy revoke visible**, read this section instead:
> those items were fixed and re-measured. The five final verdicts are at the end
> of this section.

- Functional code head: `4d9619600d38f654e620b31f7d83fd167549181d` (docs/evidence
  and CI-only commits follow on the same branch; PR #51).
- Rework round 2 added: the peer-closed-session recovery, the one-identity
  hardening, the reactivated-account key binding, and the Windows floor cleanup.

## L1. B stale-session HTTP 410 — fixed and reproduced

**Cause:** `P2pNode` kept a locally "live" session after the peer host restarted;
the outbox push (`sendDueFor`/`tick`) sent frames on that session id and the
provider answered **HTTP 410 session_closed**. The row was retried forever on the
same dead session; the consumer never delivered the new request, so a re-approval
could never reach it.

**Fix:** only an explicit `HTTP 410` / `session_closed` / `session closed` verdict
closes that session (`dropStaleSession`); the next authenticated poll hello opens
a fresh one and the **same outbox row** (same message id, idempotency and
generation) is retried after its normal backoff. A 400/403/404/5xx/timeout never
discards a session, never changes generation and never creates a second key.
Regression: `plugin/test/p2p-node.test.ts` "a stale-session 410 drops the closed
session and re-sends the same request on a fresh hello".

**Real two-node path (REPRODUCED, `evidence/reactivation/reactivation-delivery.json`):**
initial approval delivered ($0.05) and a 200 call through native Remote
`p2p-786339993dcbeeb7`; provider B revoke removed the old key; **provider host
restart**; consumer's new request hit the dead session (outbox `attempts=2` after
the 410) and was re-sent on a fresh hello; provider explicit re-approval used the
reactivation path (new key `f12949…`, new ledger window, priceVersion bound);
sealed delivery reached the consumer, which auto-registered new Remote
`p2p-22cf242a21fa71c2` with cap `$0.05` and ACKed; a new model call returned
**200**. The old Remote/key are gone, the old approval is revoked, the ledger old
window is closed and the new window names the new key — **one active key**.

**Payment smoke:** the full real-chain payment was reproduced immediately before
this transport change (see `evidence/payment/`, tx
`0x185f0d451063f26b72c628288a69470e1bb708d867b83c7f87121a0ecbedf336`, one ledger
deposit, cap `$0.05→$1.55`, restart no double credit). The 410 change is additive
to the same outbox path and the full suite + the B re-approval smoke pass; a
second on-chain payment was not re-run in this round (stated, not implied).

## L2. F12 one identity — closed

- `configHostname()` now delegates to the single `overlayHostname()`; ET config,
  catalogue presence, diagnostics and the self-connect guard cannot derive
  different names.
- An adopted core whose own reported `hostname` differs from the current config
  is **not adopted**: it is stopped and restarted from the freshly rendered
  canonical TOML.
- A persisted `nodeId` that is not a valid overlay identity is **refused**
  (fail closed) instead of being used for hostnames/keys/self-connect; regression
  in `plugin/test/state.test.ts`.
- The self-connect guard now also compares the route owner's IPv4 with this
  node's virtual IP, not only the hostname.
- The original transient mismatch was not reproduced after these checks; it is
  covered by the consistency/fail-closed paths, not silently ignored.

## L3. Windows gate

Runner (`MIN_EXECUTED = 360`), workflow comment and
`docs/validation/windows/COVERAGE.md` now all say **360**. `test/provisioner.test.ts`
remains explicitly excluded because it hangs before its first test on the Windows
runner; this is a documented Windows gap, not a complete Windows pass.

## L4. Final five verdicts (this state)

| Area | Verdict | Reason |
| --- | --- | --- |
| Visual UX | **GO** | final 40-image matrix, Chinese states, collapsed history, advanced legacy revoke, fresh-online headline; focus-visible and reduced-motion checked |
| Zero-file P2P | **GO** | original authorization journey + full payment + **revoke → restart → request retry after 410 → manual reactivation → new sealed delivery → new Remote/cap → ACK → 200** all reproduced on real Magpie/ET; one active key, ledger append-only |
| Wallet Usability | **NO-GO** | built-in wallet and recharge work; real MetaMask/Rabby announce EIP-6963 but the product-level connect/network/EIP-712 flow remains UNKNOWN (tooling/onboarding blocked) |
| Mainnet Network Support | **GO — read-only/selection only** | equal BSC 56/Base 8453 read-only, strict assets, hard gate; no mainnet send/credit |
| Real-money Production | **NO-GO** | D review unchanged (soft-cap overshoot etc.); no real funds |

# Post-review rework (2026-10-31 evening) — supersedes the verdicts below

Functional head: `340c378045bf22ed59a24044b75aa8589a0a1736` (this addendum and the
new evidence are committed after it). The round-1 NO-GOs were reworked as asked.

## R1. F11 is fixed at the ownership/root-cause level

The 64 s restart was **not** a probe killing the core. `ControlApp.discover()`
dropped and recreated the owned control forward whenever the signed presence was
within 60 s of its TTL (the presence is refreshed near half-life). EasyTier 2.6.4
cannot close a live forward, so `retireControlForward` did a supervised core
restart; the next discovery added the forward again — a restart every ~64 s.
Round-1's trace (`trace applyConfig at retireControlForward`) proved it.

Fixes:
- a presence refresh with the same signed mapped address, control port and
  identity **reuses** the owned forward (only the evidence timestamps update);
- the owned control-forward set is persisted in `state.json`
  (`controlForwards`, validated on load) so a successor host expects the same
  canonical set and can rebuild it; add/retire persists atomically;
- only the host-lock owner may start, adopt, restart or stop the core or rewrite
  its config. `Service`/`EasytierSupervisor` take an `ownsHost` proof, a
  non-owner `stop()`/`start()`/`applyConfig()`/`haltUnsafe()` is a no-op/refusal,
  and a non-owner read-only refresh never stops the core;
- a foreign/manual forward still fails closed (no restart, evidence retained).

Regression: `plugin/test/phase10-owner-gate.test.ts` (two Service instances on
one state: non-owner cannot start/stop; an owned control forward survives a new
Service; a foreign forward refuses the restart).

**Stability evidence:** two consecutive 5-minute samples of both nodes, spanning
many former 64 s periods: `evidence/stability-5min-run2.txt` and
`stability-5min-run3.txt`, both `deltaP=0 deltaC=0` and the same core PIDs for
the whole window. Control polling and the payment session stayed live.

## R2. The full zero-file payment is REPRODUCED

On the same real Magpie 0.1.2289 + EasyTier 2.6.4 two-node lab and an isolated
anvil chain id 84532 with a local mock ERC-20:

request → provider terms → built-in wallet EIP-712 signature → explicit preview
(nonce/gas/fees/balances/digest) → confirm → journal reserve → broadcast
(`0x185f0d451063f26b72c628288a69470e1bb708d867b83c7f87121a0ecbedf336`, receipt
status 1, block 3) → provider watcher → finality (lab: one confirmation) →
ledger deposit applied once (1.5 tUSDC = 1_500_000_000 nanos) → Magpie key cap
`$0.05 → $1.55` → consumer **已到账**. A provider host restart re-scanned the
chain: one chain deposit, one credited event, cap unchanged (no double credit).

The local mock token contract, deployment receipt, preview/send bodies, the
chain event, the ledger row and the consumer record are in
`evidence/payment/` with SHA-256 in `evidence/SHA256SUMS`. No real funds.

A lab-only wallet-registry finality override (confirmations=1) was needed
because anvil reports `finalized`/`safe` at block 0; the product Base Sepolia
record remains `finalized-tag` and was not changed in the code.

The first payment attempt also found and fixed a real defect: the provider's
payment host read the registry once at startup, so an asset registered after the
host started was refused ("provider does not allow this payment network"). It now
re-reads the registry at frame time.

## R3. Re-approval after revocation — implemented, delivery still partial

- Explicit, human, audited re-approval: `approveConnectionRequest(...,
  {reactivate:true})` is used only by the B human-approval path; a revoked
  consumer gets a new key, one active key (old key removed), `revokedAt` cleared,
  a **new ledger window** while the revoked account/window/deposit/consumption
  rows stay append-only, and the new `priceVersion` is bound. Regression:
  `control-p2p-port.test.ts` ("an externally revoked consumer can be re-approved
  as a new generation") asserts the new key id, exactly one native key, the old
  approval converged to revoked, the ledger reactivation and the price version.
- Real lab: the provider issued a new key and reactivated the ledger after an
  explicit re-approval (log in `evidence/reactivation.json`). The sealed key
  delivery to the consumer was then blocked by a **B stale-session HTTP 410**
  (the consumer's outbox reused a session the restarted provider had closed),
  so the consumer did not register the new Remote in this lab. That transport
  defect is open (see §7); the re-approval service path itself is verified.

## R4. Other product fixes and the final visual matrix

- The network headline counts only **fresh online** neighbours; last-known rows
  are counted separately (`已连接到 N 个伙伴…另有 M 个最后已知邻居`), so a stopped
  core/LAN presence cannot keep a node "online".
- Terminal request history is collapsed under "历史请求（N）"; known states are
  Chinese; raw protocol errors are no longer rendered inline (kept in the
  technical details); the legacy file-flow revoke is behind an explicit
  advanced disclosure ("撤销旧版授权") and the ordinary revoke is the B card.
- New final matrix in `evidence/visual/` (40 images: 首页/发现/我的共享/钱包/网络,
  light/dark × 1440×900/420×820, both nodes). Keyboard focus-visible (3 px ink
  outline) and `prefers-reduced-motion` (the stylesheet's reduce block; no
  animated element under the emulated setting) were spot-checked in the live
  console; touch targets and the narrow bottom navigation are visible in the
  narrow shots.

## R5. Final verdicts (this HEAD)

| Area | Verdict | Reason |
| --- | --- | --- |
| Visual UX | **GO** | final matrix post-fixes; consistent sticker style/IA, Chinese states, collapsed history, single primary action per screen; keyboard focus and reduced-motion verified |
| Zero-file P2P | **GO (reactivation delivery partial)** | the original journey and the full payment are reproduced on real Magpie/ET; re-approval issues a new key provider-side but the B delivery after it hit the stale-session 410 (open) |
| Wallet Usability | **NO-GO** | built-in wallet and recharge are now real and usable; the external MetaMask/Rabby product-level connect/network/EIP-712 flow is still not completed (real EIP-6963 discovery only) |
| Mainnet Network Support | **GO — read-only/selection only** | unchanged: equal BSC 56/Base 8453 read-only, strict assets, hard gate |
| Real-money Production | **NO-GO** | unchanged D report; soft-cap overshoot etc.; no mainnet send/credit |

## R6. Evidence added after the round-1 report

`evidence/payment/` (contract, deployment/funding receipts, preview/send, chain
event, ledger, cap/duplicate), `evidence/visual/` (40 final screenshots),
`evidence/stability-5min-run2.txt`, `evidence/stability-5min-run3.txt`,
`evidence/reactivation.json`, `evidence/lab3-manifest.json` and
`evidence/lab3-cleanup-proof.json`. `evidence/SHA256SUMS` is regenerated for all
of them. The round-1 evidence remains as history.

Final head after the gitleaks allowlist for the public test contract:
`d7ee008b6d88c69e8c51030a8d2a318a30326a36`; PR #51 at that head has all six
GitHub checks green (plugin Linux, plugin macOS, Windows subset, secrets working
tree, secrets history, package contents).

# Phase 10 — Final independent acceptance and Real-money D review

Status tags: **REPRODUCED** (run and observed in this work), **VERIFIED** (read in
source/config/CI), **UNKNOWN** (not measurable or blocked), **LIMITATION** (a real,
stated boundary).

- Date: 2026-10-31 (Asia/Shanghai; lab logs UTC)
- Worktree: `/Users/laysath/.paseo/worktrees/1z728cdk/phase10-final-acceptance`
- Branch: `feature/phase10-final-acceptance`
- Start commit: `7c974d2a4833288795fb2fffe747c1315765e7f0` (PR #50 head, on PR #49
  `6b4d7d2f6e243b8ae8dfd074842cd71985850876`)
- Functional commits added by this work:
  - `8df38b3` — four integration defects found by the final two-node run
  - `10a3644` — Chinese outcome labels instead of raw protocol states
- Platform: macOS 26.6.2 (Darwin 25.6.0) arm64
- Pinned products: **Magpie 0.1.2289**, tag `5c637f17b25dad63c490b1edf242c11a83b1b059`,
  app binary SHA-256 `c534dbcdb92031aa42ef6e4429d558f16d7e679b8508f82fcfde2bc07c45080c`
  (downloaded `v0.1.2289` release; the user's installed 0.1.2374 was not used);
  **EasyTier 2.6.4**, commit `8428a89d2dabc94c97d370ec607c6ca142473626`, core
  `6478a522b8637e2bd2ad3adad66ed04a71b35f832bd9889bffaf1863262f6ddf`, CLI
  `c700c4fee1a7f35fcc1a048520d40cea477b6cf7bf6d75f423fe1642c1ebc75d`
- This report is **not** a GO for real money, not a WAN test, and not a GO for the
  product-level external-wallet requirement. It does not inherit the previous
  reports' conclusions; every claim below is from this work or explicitly labelled
  as prior evidence at a named SHA.

## 0. One-page result

| Area | Verdict | Basis |
| --- | --- | --- |
| Visual UX | **NO-GO** | 20 real screenshots (light/dark × desktop/narrow) show the sticker style and a small IA, but the final pre-fix UI rendered raw protocol states (`revoked`, `operator-revoked`) and an English overlay sentence. Both are fixed in `10a3644`; no clean re-shoot at the final commit was possible because the lab overlay entered a restart loop. |
| Zero-file P2P | **NO-GO** | Join → share → request → human approval → encrypted delivery → native Remote → 200×5/429 → revoke was **REPRODUCED** on real Magpie 0.1.2289 + EasyTier 2.6.4 at the final delta. The payment/long-lived control path is blocked by a **reproduced host-probe/core restart loop** (one stop/start about every 64 s) that makes control sessions time out; see §3.4. |
| Wallet Usability | **NO-GO** | Built-in wallet create/unlock/backup/mnemonic export/restore-with-same-address was reproduced at the C SHA `722d67a` (wallet code unchanged by this delta); create/unlock was repeated at the final HEAD. Real MetaMask and Rabby both announce EIP-6963 in an isolated Chrome-for-Testing profile, but product-level selection/connect/network/EIP-712 was not completed, and the payment journey (the wallet's main task) is blocked. |
| Mainnet Network Support | **GO — read-only and receiving selection only** | BSC 56 / Base 8453 are equal, read-only product networks; strict `chainId+contract+decimals+issuerType`; no fake USD; mainnet send/credit/auto-recharge are refused by a registry-independent gate. This GO does **not** include real credit. |
| Real-money Production | **NO-GO** | §6 checklist: soft Magpie cap overshoot was observed live ($0.06 used on a $0.05 cap), no price lock, no real-asset valuation, no multi-RPC quorum, post-credit reorg removal unproven, plugin-host key boundary, no unattended signing, no real concurrency/crash run. |

**Nothing in this work used real funds, a mainnet signature, a broadcast or a user
wallet.** The only chain was an isolated anvil (chain id 84532) with a local mock
ERC-20; the only browser extensions ran in a fresh Chrome-for-Testing profile; the
user's Magpie data, default browser profile and port 3425 were never touched.

## 1. PR stack and repository state

| Item | Value | Status |
| --- | --- | --- |
| `origin/main` | `8ce5c57f565fb1b835021a9b730b61014eb47d5f` | VERIFIED |
| PR #49 `feature/phase10-p2p-closure` → `main` | head `6b4d7d2f6e243b8ae8dfd074842cd71985850876`, draft/open | VERIFIED |
| PR #50 `feature/phase10-wallet-closure` | head `7c974d2`, draft/open; **base was `main`** (so it also showed PR #49's diff). Retargeted to PR #49's branch as part of this delivery | VERIFIED |
| This delta | `feature/phase10-final-acceptance` → base `feature/phase10-wallet-closure` (PR #50), draft/open: **PR #51**; functional head `970bb44`, docs/evidence commits follow on the same branch | VERIFIED |
| PR #49 checks at its head | plugin Linux PASS, plugin macOS PASS, Windows subset PASS, secrets (tree) PASS, secrets (history) PASS, package contents PASS | VERIFIED |
| PR #50 checks at `722d67a` | same six checks PASS | VERIFIED |
| Local gates at the final code+copy commits | `typecheck` PASS, `bun run test` **1405 pass / 0 fail** (92 files, 9933 expectations), `secret-scan` PASS, `boot-check` PASS | REPRODUCED |

PR #14–#48 remain open drafts. They are **not** merged and are not closed here:
the two closure reports' provenance tables show which of their reviewed deltas
were rebuilt into #49/#50, and closing them would risk discarding evidence or a
not-fully-integrated unit. The final stack for review is #49 → #50 → this PR; the
older PRs should be treated as history, not as merge candidates.

## 2. Independent review: what I found, not what the previous sticks said

I read the final A/B/C deltas file by file (control transport/ACL, B state
machine, payment protocol/journal, watcher/ledger/provisioner, wallet vault,
mainnet gate), then ran the final tree on two fresh portable Magpie/EasyTier
nodes. The following defects were found **at the final HEAD**; four are fixed in
`8df38b3`, one copy defect in `10a3644`, and one runtime blocker is open.

| Id | Finding | Severity | Status |
| --- | --- | --- | --- |
| F6 | `ControlApp.start()` passed a **snapshot** of allowed Host values to the control listener. A node that enabled sharing *after* start kept rejecting the mapped-Host request with 403 until the whole host restarted. This is exactly the "provider control 403 after sharing" class the C report claimed fixed; the fix was not actually wired to the live listener. | blocker for zero-file after share | **FIXED** in `8df38b3`; regression test `control-app.test.ts` ("enabling sharing after start…") |
| F7 | The B hello binds to the published catalogue quote (`to.catalogQuoteHash`). `P2pNode.setBinding()` existed but `ControlApp.sync()` never called it, so a node that shared after start kept a null/old binding and answered every client hello with **HTTP 400 quote_mismatch**. | blocker for zero-file after share | **FIXED** in `970bb44` (same branch); regression test "sharing after start rebinds the live node…" |
| F8 | The control approval journal kept a legacy-revoked approval as `approved`: the provider's other revoke button removed the native key but left `control-approvals.json` saying active, so a retry returned the dead approval's materials and a new generation was refused as "already has an active approval". | money/authorization state | **FIXED (convergence only)** in `8df38b3`: a native-revoked approval is marked revoked, retries are refused with a typed conflict, no second key. Reactivation of a revoked consumer is **not** implemented (see §7). |
| F9 | The authenticated payment context returned **the local node's** catalogue quote (`quoteHashFor: () => catalogStatus().quote`). A payer that also shares a model compared the provider's terms with its own quote and rejected every payment (`authority: terms quote does not match…`). | payment blocker | **FIXED** in `8df38b3`: the sender peer's quote is used. |
| F10 | 我的共享 rendered raw `revoked` / `operator-revoked`, and 首页/网络 said "Connected to 1 peer over the overlay." in a Chinese product. | visual/copy | **FIXED** in `10a3644`; screenshots in evidence are pre-fix |
| F11 | **Open runtime blocker.** With a live control-forward between the two nodes, Magpie's short-lived plugin host probes (visible as `plugin boot` + `host shutdown requested`) are followed about every 64 s by a supervised `easytier-core` stop/start. The runtime-added control forward (e.g. `127.0.0.1:35100 → 10.66.x:35001`) is held only in the Service's **in-memory** `controlForwards`; a probe/other Service instance does not expect it, its safety check fails, and the shared core is stopped. Control polls then time out and the payment terms cannot be delivered. | **blocker** for payment/long-lived flows | **OPEN**; evidence `runtime-restart-loop.log`; recommended fix: persist the owned control-forward set in the node state (or make a non-owner instance never stop an adopted core) and re-run the two-node payment |
| F12 | The consumer's overlay hostname initially appeared as `ohmyaihub-5b3c05b0` while `state.json.nodeId` was `5b3c05b0`; the provider then issued a key named `ohmyaihub-5b3c05b0`. After a later core restart the hostname converged to `ohmyaihub-5b3c05b0`. The same anomaly appeared in the earlier lab (`ohmyaihub-2705b98d`). | identity/display, not exploited | **UNKNOWN** root cause; not reproducible after restart; self-connect guard uses `configHostname`, so the transient mismatch deserves a follow-up (it can only weaken the local self-connect refusal, not the forward/401 checks) |

Additional review notes, no code change:
- `network.ts` still counts stale catalogue-only neighbours in the "Connected to N
  peers" sentence (the online/stale flags are per-row, but the headline uses the
  array length). In lab1 a provider whose core had been stopped through the
  maintainer API was still counted as one peer because its plugin-host presence
  server kept answering on the LAN. Not fixed; report as a bounded UX/diagnostic
  defect (`§7`).
- The provider console exposes two revoke surfaces (the B "撤销此授权" and the
  legacy provisioning "撤销授权"). The B one is the tested path; using the legacy
  one triggered F8. The product should hide the legacy one in the ordinary flow.

## 3. Real final acceptance on Magpie 0.1.2289 + EasyTier 2.6.4

### 3.1 Environment (lab2 — the clean canonical run)

- Two fresh portable Magpie 0.1.2289 copies under `/tmp/phase10-final-lab2`,
  each with its own `.portable` data/home, mock native provider and mock upstream.
- Real EasyTier 2.6.4 **no-TUN**, two nodes on **one host and one LAN IP**
  (`192.168.10.84`) — this is not a WAN/NAT/relay test. Distinct ports were
  allocated by the lab harness (catalog 49952/49951, web 51175/25684, gateway
  31732/36673, control 35000/35001).
- Plugin installed through the Magpie **local package** flow (the GUI install was
  demonstrated in lab1; in lab2 the package was added with Magpie's own
  `plugin add` after the GUI folder-install form was below the fold and the
  headless scroll failed). The plugin page, pairing and all business steps were
  the real console.
- Console pairing used the explicit eight-digit code path; no native launcher
  ticket was reused.

### 3.2 What was reproduced in lab2 at the final delta

1. **Three-field join.** Provider joined with no initial node; consumer with
   `tcp://192.168.10.84:11010`. No role, port, ACL or `mappedCidr` field.
2. **Neighbours and ET state.** Both showed each other (`ohmyaihub-42391759` /
   `ohmyaihub-5b3c05b0`), real EasyTier 2.6.4 no-TUN, virtual IPs, real listener
   and control port.
3. **One explicit share.** Provider selected its priced native mock model and
   confirmed once; the catalogue was published with full Ed25519 fingerprint and
   quote hash.
4. **Zero-file request/approval.** Consumer accepted the full fingerprint
   (TOFU), sent the no-file request; provider reviewed the full consumer
   fingerprint, selected the model, previewed the selected quote, set a **$0.05**
   cap and approved.
5. **Encrypted delivery + native Remote.** The provider's B approval went
   `queued → 已交付`; the consumer pulled/decrypted it, registered native Remote
   `p2p-c1f5b0e59ee74282`, read back the model and `$0.05` cap.
6. **Real calls through EasyTier + Magpie.** Five `POST /v1/chat/completions`
   through the consumer's own Magpie gateway returned **200** with the mock
   upstream's `hello from provider`; call 6 returned **429** with Magpie's own
   budget message ("`ohmyaihub-5b3c05b0` has used $0.06 of its $0.05 …").
   Bodies and SHA-256 are in `evidence/p2p-calls.json`.
7. **Revocation.** Provider used the B "撤销此授权"; the card became 已撤销 after
   the native key was proven gone. Call 7 returned **404** (`magpie knows no model
   p2p-c1f5…`) because the consumer's control node removed the Remote on the
   revocation notice — the consumer cannot continue. (The earlier lab at
   `7c974d2`, which revoked through the legacy path, returned **401** with
   "the API key ending in … is not an enabled magpie gateway key"; that path also
   triggered F8.)
8. **Stop-share / last-known facts / control-only presence** were measured on the
   earlier lab at the start commit (before this delta) and are reported with that
   SHA in §3.3. They were not re-run after the delta because the lab entered F11.

### 3.3 Earlier lab (lab1, start commit 7c974d2) — A closure

- Provider stop-share: consumer card changed to 未发布目录 / 已撤下目录 within
  seconds; the provider core stayed running (`core running=true`, `aclOk=true`);
  no false halt.
- Both nodes unshared: consumer 发现 showed the provider as a signed control-only
  neighbour — “这个伙伴在网络中，但尚未共享模型；现在没有可申请的模型。”, valid
  signature, full fingerprint, no request action.
- Consumer core stopped through the lab-only `/supervisor/stop`: the page showed
  **未连接**, every fact labelled 最后已知/已停止（最后已知版本）, and the
  neighbour 最后已知; `/supervisor/start` restored live facts.

### 3.4 The final runtime blocker (F11) — reproduced

After the successful B approval and Remote registration, both nodes started
stopping their `easytier-core` about every 64 s. The log pattern
(`evidence/runtime-restart-loop.log`) is:

```
plugin boot … / host shutdown requested          (Magpie short-lived host probe)
control poll to <peer> failed: The operation timed out.
… port forward added local=127.0.0.1:3510x remote=10.66.x:3500x
… terminate signal received, exiting...          (the supervised core stops)
… starting easytier-core 2.6.4-8428a89d          (~64 s cycle)
```

The control forward is added by `ControlApp.discover()` via
`Service.addControlForward()`; that method stores it only in the Service
instance's `controlForwards` map and in that instance's supervisor expectation.
A different Service instance (the Magpie host probe) sees the live forward as
unexpected and its safety check stops the shared core. Once the core stops, the
control sessions and the payment terms die. This is the direct reason the
zero-file payment could not be completed at this HEAD in this environment; it is
a production-blocking lifecycle defect, not a test artifact.

### 3.5 Payment journey — BLOCKED

- A consumer-side payment request reached the provider (invoice
  `inv_28bca3ed-87d3-43b5-b0e1-18d2043fb6bd` was created, “等待付款/未签名”).
- The first terms delivery was rejected by the payer with the F9 quote mismatch;
  after the F9 fix the provider's terms send returned `transport` because the
  payer's control endpoint was not reachable / sessions were being killed by the
  restart loop.
- No transaction was broadcast in this final lab. The earlier C stick's payment
  (`docs/phase10/wallet-closure/evidence/payment-journey.json`) is at a different
  SHA (`d09efe1`) and its contract field is not reproduced in this work; per the
  task rule it is **not** copied as final evidence. The isolated anvil deployment
  and its receipts *are* in this evidence (`isolated-anvil-*`), but no final-HEAD
  P2P payment receipt exists.

## 4. Original requirement matrix

Tags: **REPRODUCED**, **VERIFIED**, **PARTIAL**, **UNKNOWN**, **BLOCKED**, **GATE**.

| Original requirement | Result in this work | Tag |
| --- | --- | --- |
| Three fields only on first use (name/secret/initial node) | Real console, two fresh nodes | REPRODUCED |
| No provider/consumer role selection | No role UI; both capabilities implicit | REPRODUCED |
| Auto neighbour/model discovery | Both nodes found each other; catalogue read | REPRODUCED |
| One explicit action shares priced native models | One checkbox + one confirmation; published quote | REPRODUCED |
| Stop sharing withdraws catalogue, core stays up | lab1 at 7c974d2 | REPRODUCED (pre-delta) |
| Last-known facts when core stops | lab1 at 7c974d2 | REPRODUCED (pre-delta) |
| Control-only presence for unshared nodes | lab1 at 7c974d2 | REPRODUCED (pre-delta) |
| No file exchange: request/approve/encrypted key/native Remote | lab2 at final delta | REPRODUCED |
| Native 200 / provider 429 | 200×5, 429 on call 6 | REPRODUCED |
| Revoke → consumer cannot continue | B revoke → Remote removed, call 404; legacy revoke → 401 (pre-delta) | REPRODUCED (both enforce) |
| Human approval of first identity + quote preview + positive cap | Provider dialog; full fingerprint, selected quote version, $0.05 | REPRODUCED |
| Zero-file payment request→terms→EIP-712→preview→send→watcher→ledger→cap | Not completed; terms delivery/transport blocked by F11; F9 fixed | **BLOCKED** |
| Duplicate/restart does not double-credit | Unit/integration tests pass; not re-run in the final lab | UNKNOWN |
| Built-in wallet create/lock/unlock/backup/mnemonic/key export/restore same address | C SHA `722d67a` (wallet code unchanged by this delta); lab1 created/unlocked at final HEAD | REPRODUCED (full at C SHA), PARTIAL (final HEAD) |
| Sensitive values never in UI/log/state/localStorage | C evidence scan + this delta adds no secret output; final lab logs reviewed | VERIFIED (code/evidence), not a full byte scan of every final artifact |
| BSC 56 / Base 8453 equal read-only | C evidence `mainnet-readonly.json`, code unchanged | REPRODUCED (C SHA), VERIFIED |
| Select BSC / Base / both as receiving networks | Wallet page multi-select, default empty, mainnet gate | VERIFIED (UI/code) |
| Unknown chain / wrong asset refused | Mainnet gate, strict quadruple, deposit intent refusal | VERIFIED + tests |
| Real mainnet send/credit/auto-recharge closed | Hard gate `mainnet-gate.ts`; no UI path | VERIFIED/GATE |
| External MetaMask/Rabby discovery + connect + network + EIP-712 | Real EIP-6963 announcements of both; product connect/sign not completed | PARTIAL/UNKNOWN |
| FULL AUTO downgraded to reminder + one-click | `fullAuto:false`, `executor:none`; reminder UI; mainnet refused | VERIFIED (code/UI), reminder path not exercised end-to-end |
| Visual: 5 pages, light/dark, desktop/narrow, keyboard/focus/touch/reduced motion | 20 screenshots; style and layout; two copy defects fixed; no clean re-shoot | PARTIAL/NO-GO |
| Windows compatibility | Curated subset passes, but `test/provisioner.test.ts` is excluded and the floor is **360** while the workflow comment says 380; real Windows gap | LIMITATION |
| Linux/macOS CI, typecheck, boot, secret/gitleaks, pack | Local all pass; CI to be linked from §9 | REPRODUCED locally |
| Clean experiment environment | Both labs exported a manifest then stopped every owned process, verified all ports free and deleted the roots; anvil/browser profiles deleted | REPRODUCED (§8) |
| No DHT/mDNS/central server/second gateway | Code review + actual ACL/topology | VERIFIED |

## 5. Wallet and external-wallet detail

- **Built-in wallet.** Lab1 at final HEAD: create with a 12-word mnemonic shown
  once, clear, locked state ("未验证地址，不能作为收款地址"), unlock with the
  password, address verified. The C stick at `722d67a` reproduced create → backup
  → lock/unlock → mnemonic export after purpose + confirmation + password →
  private-key export → restore from the exported mnemonic to the **same address**,
  and a byte scan of the lab tree found no seed/key. The wallet-vault files are
  not touched by this delta (`git diff 7c974d2..HEAD -- plugin/src/wallet-vault.ts`
  is empty; the copy fix only touched `console/providers.js`, `src/network.ts`,
  the control/payment host and their tests), so the C result remains relevant at
  a named SHA.
- **External wallets.** Real, isolated Chrome-for-Testing (Playwright
  `chromium-1234`) with the official MetaMask and Rabby CRX unpacked:
  - both service workers started; the page received two genuine
    `eip6963:announceProvider` events: `io.metamask` (MetaMask) and `io.rabby`
    (Rabby), with distinct UUIDs (evidence `external-wallet-eip6963.json`);
  - no fake provider was injected; the user's Chrome/default profile was not used.
  - **Not completed:** product-level pairing in that profile, user selection in the
    console, `eth_requestAccounts`, network read/switch and
    `eth_signTypedData_v4`. MetaMask onboarding/vault creation and popup
    automation remain the blocker. Wallet Usability therefore stays NO-GO for the
    original external-wallet requirement.

## 6. Real-money safety review (D) — NO-GO

No real funds were used. The review is code + measured lab evidence. “Controlled”
means a verified control exists; “test-only” means there is unit/integration
evidence but no independent real-money proof; “UNKNOWN” means not measured.

| Area | Finding | Status |
| --- | --- | --- |
| Magpie price lock | Catalogue is `priceLocked:false`; Magpie prices at call time (0.1.2289 peak pricing); the plugin ledger uses a price-version snapshot. A price change mid-cycle can misprice or pause an account; there is no native lock. | **NO control** |
| Concurrent soft cap overspend | Native budget is a soft cap: this work observed a $0.05 key charged **$0.06** (one request over) and returning 429 on the next call. Concurrent requests can overshoot further. | **NO control (measured)** |
| Disconnect / stream settlement | Usage/cost is recorded by Magpie; a cut stream or a failed usage read is reconciled by the existing accounting path. Not measured against a real vendor stream in this work. | UNKNOWN |
| Asset valuation | Mainnet assets are `not-creditable` with no USD value; test assets use a fixed test rate. There is no oracle or issuer price source for real assets. | UNKNOWN (not implemented by design) |
| Multi-RPC inconsistency | `EvmClient` tries endpoints in order and uses the first healthy one; there is no quorum or cross-provider comparison for a credit decision. | **NO control** |
| Finality / reorg vs credited funds | BSC uses 15 confirmations, Base the `finalized` tag; the watcher rechecks a credited event and can freeze. A post-credit reorg that removes the transaction was **not** reproduced (anvil replayed it in the earlier lab); the removal path is unit/prior-phase evidence only. | UNKNOWN / **NO-GO** for real money |
| Key host boundary | The built-in vault runs in the same plugin host as the rest of the plugin; the architecture explicitly cannot prevent same-host plugin code from reading decrypted state. This is acceptable for a test wallet, not a production custody claim. | LIMITATION |
| Auto-transfer permission | No unattended signer; `fullAuto:false`, `executor:none`, reminder + one-click only. Mainnet auto-recharge has no code path. | Control by absence; requirement not met |
| Recovery / backup | Mnemonic restore to the same address and encrypted backup exist; a full recovery drill on a fresh host at the final SHA was not repeated. | PARTIAL |
| Recharge × consumption concurrency | The payment journal is a single-winner send gate; the ledger applies one deposit once and the cap is read back. Real concurrent consumption during a top-up was not measured. | Test-only |
| Crash / power loss | SQLite WAL + journal states + terminal `unknown` broadcast; a real power cut at the broadcast boundary was not induced. | UNKNOWN |

**Verdict: Real-money Production NO-GO.** The observed $0.06/$0.05 overshoot alone
disqualifies a hard-cap claim; price locking, asset valuation, RPC trust and
post-credit reorg are also unresolved. The mainnet gate must stay closed.

## 7. Open issues and recommended next steps

1. **F11 (blocker):** persist the owned control-forward set (or make a non-owner
   Service instance never stop an adopted core), then re-run the two-node payment
   at the final SHA. Until then, no zero-file payment or long-lived control
   session can be called production-ready.
2. **Revocation is terminal for a consumer id.** The provisioner refuses a new
   key for a revoked consumer (ledger account revoked). The product has no
   “new identity for the same node” path, so revoke → later re-approve is a dead
   end. This is a design decision with a real usability cost; either implement an
   explicit, audited reactivation/new-generation flow or state it in the UI.
3. **F12 hostname anomaly:** capture the exact transient state and why the
   overlay hostname can differ from `ohmyaihub-${nodeId}`; the self-connect guard
   uses the derived name.
4. **Headline peer count:** count only fresh, online peers (or say “N known
   neighbours, M online”) instead of the array length; a LAN presence server kept
   a stopped node looking connected in lab1.
5. **Windows:** `test/provisioner.test.ts` still hangs before its first test on
   the runner; the curated subset excludes it and the executed floor is 360 (the
   workflow comment still says 380). Either root-cause the pre-test hang or state
   the Windows gap in the final verdict (this report does).
6. **UI copy/state:** the raw-state fix in `10a3644` needs a visual re-check at the
   final commit; external-wallet selection/connect still needs a real profile run.

## 8. Evidence, hashes and cleanup

Evidence directory: [`evidence/`](evidence/), SHA-256 in
[`evidence/SHA256SUMS`](evidence/SHA256SUMS).

| File | What it shows |
| --- | --- |
| `p2p-calls.json` | five 200 bodies, the 429 body and the post-revoke 404, with per-body SHA-256 |
| `runtime-restart-loop.log` | the 64 s probe/core-stop/restart cycle at the final delta |
| `lab2-manifest.json`, `lab2-cleanup-proof.json` | the clean final lab: installed package hashes, ports, PIDs, readiness; after cleanup no remaining process and every port free |
| `lab1-manifest.json`, `lab1-cleanup-proof.json` | the earlier A-closure lab and its cleanup |
| `external-wallet-eip6963.json` | real MetaMask and Rabby EIP-6963 announcements and service workers in the isolated profile |
| `isolated-anvil-deployment.json`, `isolated-anvil-deploy-receipt.json`, `isolated-anvil-fund-transfer.json` | isolated chain id 84532 deployment/receipt and the mock-token funding transfer (no value) |
| `desktop-*.png`, `narrow-*.png` | light/dark × desktop 1440×900 / narrow 420×820 screenshots of 首页, 发现, 我的共享, 钱包, 网络 (pre-copy-fix) |

Screenshots are **pre-copy-fix** (`10a3644` changed two renderings after they were
taken); they are retained as the honest visual review source, not as a post-fix
acceptance.

**Cleanup (REPRODUCED).** Both lab roots exported an allowlisted manifest, then
`harness cleanup --delete` stopped every owned process, verified all observed
ports free, and removed the root (seeds, keys, session state included). The
isolated anvil, Chrome-for-Testing profile, unpacked extensions and the 0.1.2289
app copy were deleted. No lab `easytier-core`, `magpie web` or plugin-host process
remained. The user's Magpie installation/data and port 3425 were never touched;
no real wallet secret was used.

## 9. Delivery

- Branch `feature/phase10-final-acceptance`, pushed; functional code head
  `10a3644`, docs/evidence commits follow on the same branch.
- Delta draft PR: **https://github.com/faithleysath/magpie-oh-my-aihub/pull/51**,
  base `feature/phase10-wallet-closure` (PR #50), **not merged**.
- PR #50 (https://github.com/faithleysath/magpie-oh-my-aihub/pull/50) was retargeted
  from `main` to `feature/phase10-p2p-closure` (PR #49), so the review stack is
  #49 → #50 → #51. PR #49 stays `feature/phase10-p2p-closure` → `main`.
- CI on PR #51 at the time this report was written: see the PR checks. Local gates:
  typecheck PASS, **1405 tests / 0 fail**, secret-scan PASS, boot-check PASS.
- PR #14–#48 remain open drafts and are not closed; their reviewed deltas are
  recorded in the #49/#50 closure provenance tables, and closing them would risk
  losing evidence or a not-fully-integrated unit.

## 10. Verdict summary

- **Visual UX: NO-GO** — style/IA are close, but the final pre-fix UI showed
  internal protocol words and an English overlay sentence; the copy fix is
  committed but not re-shot on a stable lab.
- **Zero-file P2P: NO-GO** — the full authorization journey is reproduced on real
  Magpie/EasyTier; the payment/long-lived control path is blocked by F11 and no
  final-HEAD payment receipt exists.
- **Wallet Usability: NO-GO** — built-in wallet is usable at the C SHA; real
  MetaMask/Rabby announce EIP-6963, but product-level connect/network/signature
  and the recharge journey are not completed.
- **Mainnet Network Support: GO (read-only + receiving selection)** — equal BSC
  56/Base 8453, strict assets, no fake valuation; send/credit/auto remain gated.
- **Real-money Production: NO-GO** — independent D checklist, with a measured
  soft-cap overshoot and unresolved price/RPC/finality/key-host risks.
