# Phase 10 — A share/share-stop closure + B zero-file P2P (real two-node run)

Status tags: **VERIFIED** (read in source/config/CLI), **REPRODUCED** (run and observed here),
**UNKNOWN** (not measured or outside this run), **LIMITATION** (a real, stated boundary).

- Date: 2026-10-31 (Asia/Shanghai), branch `feature/phase10-p2p-closure`
- Integration base at start: `58645bb92fc003cbc7cef92b037acc9676c3034f`
  (A share-fix real-run head; F3/F4/F5 unfixed at that point)
- Final functional head before the CI-fix commit: `2f27002`; the CI fix adds a sorted
  expectation in one test and a two-line, finding-scoped gitleaks allowlist for the canonical
  public BIP39 test vector. PR: https://github.com/faithleysath/magpie-oh-my-aihub/pull/49
  (draft, not merged).
- Evidence index: [`evidence/`](evidence/) with SHA-256 in [`evidence/SHA256SUMS`](evidence/SHA256SUMS).
- This is **not** a Phase-10 GO for wallet/mainnet (C/D are not in this run) and not a WAN test.

## 0. What was integrated

The A line (three-field join, one explicit share, five-page console, model read-back evidence,
owner gate, share controls) and the B line (P2P protocol core, signed presence, authenticated
pull/poll, control app, zero-file UI) had both been rebuilt from `main 8ce5c57`, so they were
merged here as reviewable units instead of replayed as a giant squash:

| Merge commit | Content |
| --- | --- |
| `f94562d` | B assembly base (PR40 `3ddf583`): protocol core, presence, control app/actions |
| `2b09e15` | B overlay transport/lifecycle (PR45 `f1eaa16`): presence TTL/identity, owned control forward, bounded pull/poll, shutdown degradation |
| `af7418d` | Zero-file UI (PR42 `4ebafd1`): discovery/approval/connection panels, emergency file flow moved behind a disclosure; kept the newer A controls/evidence and both test groups |
| `838bb0b` | Real HTTP two-Service journey tests (PR47 `d86af7f`), adapted to the hermetic network guard; the two lifecycle tests that failed on PR47's older base pass on this runtime |

The only merge conflicts were A regressions if taken from the B copy (`state.ts`/`service.ts`
evidence/price fields; older A test fixtures); no B file was dropped. `typecheck` and the full
suite were green after each merge.

## 1. Platform, pins and lab isolation

| Item | Value |
| --- | --- |
| Host | macOS 26.6.2 (Darwin 25.6.0), arm64 |
| Magpie | **0.1.2289**, tag commit `5c637f17b25dad63c490b1edf242c11a83b1b059`, app binary SHA-256 `c534dbcdb92031aa42ef6e4429d558f16d7e679b8508f82fcfde2bc07c45080c` |
| EasyTier | **2.6.4**, commit `8428a89d2dabc94c97d370ec607c6ca142473626`; core SHA-256 `6478a522b8637e2bd2ad3adad66ed04a71b35f832bd9889bffaf1863262f6ddf`, CLI `c700c4fee1a7f35fcc1a048520d40cea477b6cf7bf6d75f423fe1642c1ebc75d` |
| Bun | 1.4.3 dev/CI; 1.4.4 Magpie-managed host |
| Lab | two fresh `.portable` copies under `/private/tmp/phase10-closure-lab` (deleted after evidence), isolated `HOME`/caches, one portable root package per node |
| Upstream model | deterministic loopback mock (`docs/validation/lab/phase9/mock-upstream.py`), price 1000/1000 per 1M so a tiny cap exhausts quickly |

This is a **single-host loopback/LAN experiment** (both nodes share one LAN IP; distinct
catalogue ports `54923`/`54924` were assigned via the maintainer API because two instances cannot
bind the same port on one address). It exercises the real EasyTier Forward path and the real
Magpie gateway/budget, but **not** a WAN/NAT/relay topology and not two physical hosts.

Build provenance of the measured paths: the three-field join, share, request, approval,
encrypted delivery, native Remote, 200/429 and revoke→401 were measured on the build at
`d66fc6a` (all B runtime fixes up to and including the per-request nonce). The later three
commits (`801fe82`, `ca6b31d`, `2f27002`) touch only catalogue-display withdrawal and the console
network projection; the stop-share, core-stop and control-only evidence was then measured on
`2f27002`. No authorization, delivery, key or gateway code changed after `d66fc6a`.

## 2. A — the three real stop-share defects

### F3 — a withdrawn catalogue stayed an applicable online offer

**Root cause (VERIFIED in source, REPRODUCED before the fix).** The peer view carried the
EasyTier peer's `online` flag and the last catalogue quote/status independently of whether the
mapped export still existed, and a failed probe advanced `fetchedAt`, so an old quote never
expired while the peer kept answering 503. The stop-share report's `status=unverified, online=true,
mappedCidr=null` with a retained quote was exactly this.

**Fix (`ec6ec05`, `801fe82`, `ca6b31d`).**
- A peer now has a network fact (`online`) and a publication fact (`catalog` =
  `published | withdrawn | none | conflict | unknown`, `quoteFresh`, `quoteExpiresAt`,
  `lastQuoteAt`). A live neighbour with no mapped export becomes `no-catalog`/`withdrawn` and its
  quote/hash are cleared; identity and last quote time stay as last-known metadata.
- A quote is applicable only inside `CATALOG_QUOTE_TTL_MS` (120 s); a failed probe records
  `lastAttemptAt` instead of renewing `fetchedAt`. One pure rule (`catalogQuoteUsability`) is used
  by the file request, the direct connect (including its re-validation), the zero-file control
  request and the console, so an expired or withdrawn quote cannot be requested by any path.
- The signed presence is authoritative about `providesModels`: when a verified presence says the
  peer stopped sharing, the consumer clears the quote immediately (matched by node id or overlay
  hostname), not only after the TTL. Presence is re-read near half-life (≤2 peers/tick, no forward
  churn), and a real catalogue read restores the offer.

**Real evidence (REPRODUCED).** Provider shared one priced model; consumer read the quote
(`catalog=published`, `quoteFresh=true`). Provider clicked 停止共享 and confirmed at
`2026-10-31T08:56:28Z`. Consumer peer state polled every 5 s:

```
5s..30s: connected published quote
35s:     no-catalog withdrawn no-quote
```

The provider's own status after stop: `sharing=false`, `catalog.publishing=false`,
`core running=true`, `aclOk=true`, `publishedPorts=[54924, 35000]` (presence + control only; the
gateway port `28982` is absent). So the old quote stopped being an offer within 35 s while the
node stayed a discoverable neighbour.

### F4 — stop-share could stop the node's own core

**Root cause (VERIFIED in source; the original report saw "RPC owned by pid nobody, not 72133").**
`stopSharing` restarts the core (the export/ACL change is a config change). During the supervised
restart, the 15 s service tick and the 10 s supervisor monitor call `refresh()` while the new
core's RPC portal is not yet attributable. One such read contributes both "cannot read the running
configuration" and "RPC portal held by nobody", reaching `MAX_UNSAFE_STRIKES = 2` in a single
pass; `haltUnsafe` then stops the freshly started core, and `stopping=true` prevents an automatic
restart.

**Fix (`ec6ec05`).** No owner check was relaxed: `refresh()` returns the snapshot while
`startupPending`/`stopping` (a window that `start()` owns and fully proves before returning), and
overlapping refreshes share one in-flight probe so one transient condition counts one strike. A
core that is nevertheless stopped by a failed safety check stays honestly degraded and receives a
bounded full supervised restart (3 attempts, 5/10/20 s backoff, then stop) that re-validates the
TOML/ACL/owner/RPC identity; a normal stop never triggers it. Tests: the start-race and
concurrent-refresh regressions in `test/phase10-rpc-ownership.test.ts`, plus bounded recovery in
`test/catalog-service.test.ts`.

**Real evidence (REPRODUCED).** Across every share → stop-share → re-share cycle in this run the
provider's core stayed running (`core running=true`, `aclOk=true`, `lastError=null`), including
the stop at `08:56:28`. No false halt occurred; the only core stops were the deliberate
`/supervisor/stop` used for F5.

### F5 — stale facts after a stopped/unproven core

**Root cause (REPRODUCED before the fix).** The page's headline said "未连接", but the identity,
EasyTier version and neighbour rows were still rendered as if live; additionally `consoleState`
never copied `snapshot.network` into `status`, so the page silently fell back to raw config
values ("配置值，未在线确认", "尚未读取") even when the projection was live.

**Fix (`ec6ec05`, `2f27002`).** The projection carries `evidence.live/stale`,
`thisNode.observedAt/stale` and per-neighbour `stale/evidenceAt`; labels are a pure module
(`console/network.js`, in the console asset whitelist) and are unit-tested without a DOM. The
console now projects `status.network`, so evidence times, stale markers, port diagnostics and
neighbour link types actually reach the page.

**Real evidence (REPRODUCED).** Consumer core stopped through the maintainer
`/supervisor/stop` (a lab action, not the user journey):

```
headline: 未连接
result:   The overlay core is not running; the identity, ports and neighbours below are last known.
facts:    网络名称 …（最后已知） · 本机节点名 …（最后已知） · 虚拟地址 10.77.0.196/24（最后已知）
          网络引擎 EasyTier 2.6.4 · 已停止（最后已知版本） · 状态证据 … · 最后已知，非实时
peer:     ohmyaihub-b4c5b52c · 直连 · 最后已知  (not 在线)
```

After `/supervisor/start` the page returned to live facts (`直连`, `在线`, evidence 1 s old) with
no manual repair.

## 3. B — the zero-file P2P closed loop

### 3.1 Runtime review of `f1eaa16` and what the real run found

The reviewed `f1eaa16` delta (control forward ownership/retirement, bounded poll sessions,
presence TTL/identity binding, shutdown degradation) was read file by file. Real-lab and
integration defects found and fixed on top of it:

| Id | Finding | Fix |
| --- | --- | --- |
| B-1 | **The control plane was never started by the host.** `startControlApp` was imported in `index.ts` and never called, so no node could receive a request and the console's P2P panel had no state. | `7f65c03`: boot allocates/persists the control port before the core starts, starts the app after the Service, stops it before the Service, and re-syncs on topology changes. |
| B-2 | **`consoleState` spread the control app state at the top level**, overwriting the console schema and leaving `status.p2p` undefined. | Same commit: nested under `status`. |
| B-3 | **No control-only publication.** Unshared nodes published nothing, so they were invisible to the control plane. | Same commit: a configured unshared node exports its address and forwards exactly presence + control ports; ACL/config checks keyed on "exports?" not "shares models?"; Inbound stays Drop with zero rules; the presence endpoint is the catalogue server with a null document. |
| B-4 | **A discovered control forward looked foreign to the supervisor**: one live forward the config did not expect produced "consumes nothing but has 1 forward", two strikes and a core stop. | `1abfaa6`: `Service.addControlForward` registers/persists the forward in the canonical set; retirement keeps other owned control forwards; expected-forward checks use the combined set. |
| B-5 | The presence named the bind host (`127.0.0.1` when the LAN probe ran early) while carrying a mapped CIDR, so every verifier refused it. | `9eea7ef`: the endpoint host is derived from the mapped export. The one share action also re-syncs the control plane. |
| B-6 | A published provider's presence was discovered only after a request existed, so the zero-file button stayed disabled. | `7ff4ce5`: the control tick discovers up to two published peers per pass (verified path, no model request). |
| B-7 | A migrated catalogue/presence port made a provider undiscoverable forever. | `cf174a5`: remembered/local port first, then one bounded window of ≤7 candidates; all signature/identity/address/port checks unchanged. |
| B-8 | An expired/rejected request was permanently idempotent to its own dead row (same document hash), so it could never be asked again. | `d66fc6a`: a fresh client nonce per human request; the outbox retry reuses the stored document (retries stay idempotent). |
| B-9 | `awaiting-trust` / `requested` inbound/outbound states were unknown to the UI, so a received request had no approve action. | `3008da2`: labels/actionable set cover requested / awaiting-trust / awaiting-approval. |
| B-10 | Presence changes did not invalidate the discovery render cache. | `1abfaa6`: the presence is part of the discovery digest. |
| B-11 | A withdrawn catalogue was withdrawn at once only after the TTL. | `801fe82`/`ca6b31d`: presence-driven withdrawal (see F3). |
| B-12 | `consoleState` dropped `status.network`. | `2f27002`: projected and asserted. |

Control-only consumer side: presence is TOFU-pinned in `p2p-presence-trust.json` (0600, atomic,
null-prototype); first sight, changed key and explicit acceptance are distinct; accepting the
still-trusted old key cannot confirm the new one. A control-only neighbour is shown with its full
fingerprint, channel details and no request action, because `providesModels=false` is never a
model offer. The consumer's outbound pull and the provider's inbound control listener have
separate, explicit boundaries: the consumer may poll/receive, the provider may receive
hello/frame/poll, and neither exposes Magpie's admin surface or a second gateway.

### 3.2 Real journey (REPRODUCED)

Two fresh portable Magpie 0.1.2289 + EasyTier 2.6.4 no-TUN nodes; every business action below was
performed in the real console UI driven by ego-lite, with the native Magpie pages used only for
install/pairing. No service was operated through the CLI for a business step.

1. **Install + open (real GUI).** Plugin installed from the local package folder in Magpie's
   Plugins UI, plugin host booted, console opened through browser pairing (the one-time native
   launcher ticket was not reused; the explicit eight-digit pairing path was used and verified
   against the native page).
2. **Three fields only.** Network name, network secret and one initial node; no role, no port, no
   `mappedCidr`, no ACL field. The provider joined with an empty initial node, the consumer with
   `tcp://<provider LAN>:11010`. Both cores came up; both saw each other as `p2p` peers.
3. **One explicit share.** Provider's 我的共享 auto-detected the priced native mock model; one
   checkbox, one 分享这些模型 confirmation (with the second human confirmation) published the
   catalogue and the export. Quote v2, price version `dcedd5b3…`, full identity fingerprint shown
   for out-of-band comparison.
4. **Zero-file request.** Consumer's 发现 showed the provider (TOFU first sight) with the full
   Ed25519 fingerprint; accepted it, chose the model and sent 申请使用（无文件）. No file was
   created, downloaded or imported; the consumer's outbound row showed `requested`.
5. **Provider manual approval.** Provider's 我的共享 received it as `awaiting-trust` with the
   consumer's full fingerprint, one model and the quote binding. The approval dialog required:
   model selection (pre-selected request subset), a positive cap on the $0.0001 grid ($0.05), the
   exact consumer fingerprint acceptance, an explicit confirm, and a quote preview returning the
   selected price version. Approve produced one capped key (`额度上限 $0.05`).
6. **Encrypted delivery + native Remote.** The consumer's control tick pulled the sealed
   authorization, decrypted it locally, registered a native Remote Magpie
   (`p2p-830ee3f6aed079dd` at `http://127.0.0.1:13425`), read back the model list and the $0.05 cap,
   and ACKed. The consumer's Magpie Providers page shows the Remote with one model; no key was
   displayed in the console, logs or page.
7. **Real calls through ET + Magpie.** Using a separate consumer-side test gateway key (created
   only to call the consumer's own gateway), six `POST /v1/chat/completions` calls to
   `p2p-…/provider/provider-model`:
   - calls 1–5 → **200**, body `phase9-provider-1`, usage 5 prompt / 7 completion tokens;
   - call 6 → **429**: `Remote magpie: magpie gateway key "<key-id>" has used $0.06 of its $0.05
     estimated cost for this 3650-day cycle`.
   The 200s traverse consumer Magpie → EasyTier Forward → provider Magpie (delivered key) → mock
   upstream; the 429 is Magpie's own budget enforcement.
8. **Revocation.** Provider revoked in 撤销授权; the card became 已撤销. The next call through the
   same consumer path returned **401**: `Remote magpie: the API key ending in fac7 is not an
   enabled magpie gateway key: it is disabled, removed or mistyped`.
9. **Stop-share.** See F3/F4 above: provider core stayed up, export reduced to presence+control,
   consumer no-catalog/withdrawn/no-quote in 35 s.
10. **Control-only presence.** With both nodes unshared, the provider's 发现 shows the consumer as
    a signed presence: “这个伙伴在网络中，但尚未共享模型；现在没有可申请的模型。”, valid signature,
    full fingerprint and a 核对身份 action; no request/connect action exists for it.

Sanitized call bodies and the lab/cleanup manifests are in [`evidence/`](evidence/).

### 3.3 Automated coverage for the same invariants

- `test/control-http-two-service.test.ts` (PR47 content): two real child processes with real
  Service/Provisioner/Ledger/P2pStore/ControlApp over real Bun HTTP; request → approve → sealed
  pull → native Remote read-back → ACK, lost poll without a second key, provider restart +
  revocation, stale quote/wrong identity fail closed. Fake Magpie/supervisor only (no ET/Magpie),
  labelled accordingly.
- `test/p2p-poll.test.ts`, `test/p2p-node.test.ts`, `test/control-app.test.ts`,
  `test/control-presence.test.ts`, `test/catalog-service.test.ts` cover presence TOFU/change,
  encrypted delivery, idempotent retry/no second key, revocation, catalogue withdrawal and the
  bounded recovery paths.
- `test/phase10-rpc-ownership.test.ts` covers the F4 start-race and concurrent-refresh strikes.

## 4. Quality gates

| Gate | Result |
| --- | --- |
| `bun run typecheck` | PASS |
| `bun run test` (the CI script, includes the wallet fixture) | **1206 pass, 0 fail** locally (82 files, 8582 expectations); Linux CI reports 1205 pass + 1 host-specific skip + 0 fail |
| `bun run secret-scan` | PASS (working tree) |
| `bun run boot-check` | PASS (stub Magpie 0.1.2038, random API port, 0600 snapshot) |
| Hermetic network guard | Enforced by `bunfig.toml`; the two-service tests register the exact child origins they started |
| CI | GitHub Actions on PR #49 at the final code commit: **plugin Linux SUCCESS, plugin macOS SUCCESS, windows subset SUCCESS, secrets (working tree) SUCCESS, secrets (git history) SUCCESS, package contents SUCCESS**. Earlier red runs found and fixed: one order-dependent expectation (both sides now sorted), two exact public BIP39 test-vector lines (finding-scoped allowlist), and `test/provisioner.test.ts` hanging before any test on the Windows runner (excluded from the curated platform subset, unchanged by this branch, still run on Linux/macOS; recorded below). |

The two PR47 lifecycle tests (`host.lock` release after a constructor failure; SIGTERM during
`Service.start`) failed on PR47's older base `f39975c`; they pass on this runtime in the full suite
and in the isolated run. They are not classified as clock failures.

## 5. Boundaries and UNKNOWNs (read before accepting)

1. **Not a WAN test.** Both nodes run on one host and one LAN IP; the overlay path is real
   EasyTier Forward but NAT/relay/roaming and two physical hosts are **UNKNOWN** in this run.
2. **Single-host lab port plumbing.** The plugin never asks the user for ports, but two instances
   on one address cannot both bind 3426. The lab assigned catalogue ports 54923/54924 through the
   maintainer API (not through the user journey); the three-field UI itself was used as shipped.
3. **Measured-build delta.** The authorization/delivery/200/429/401 evidence is from `d66fc6a`;
   the last three commits before docs change catalogue display and the console network projection
   only. The final tree passes the full suite, but the full B UI cycle was not re-run on the exact
   last commit because each host restart invalidates the browser session (re-pairing) and the
   runtime code is unchanged.
4. **One active authorization per consumer.** The B store refuses a second active approval; the
   provider must revoke first. Before the console mapping fix that refusal surfaced as “结果未知”
   in the UI; the mapping now returns a known 409 (`active_approval`) with the message. This path
   was observed in the lab but the mapped UI message was not re-run after the final commit.
5. **Presence withdrawal latency** is bounded by the presence TTL refresh (~≤90 s; measured 35 s),
   not instantaneous. A real catalogue read restores the offer after the provider shares again.
6. **Real Magpie/ET paths not re-measured here:** port migration under a real foreign listener
   (previously verified in the A-lab and unit tests; the lab's remote port stayed 13425 across
   restarts), poll loss/no-second-key on real Magpie (covered by the HTTP two-Service test with
   FakeMagpie), streaming/responses/messages vendor paths, WAN/NAT/relay, Windows, Linux GUI.
7. **Wallet/mainnet (C/D)** are outside this run; no real funds, no mainnet credit, no wallet
   extension validation. The mock upstream is a deterministic local fixture, not a vendor model.
8. **Same-host core stop** for F5 was performed through the maintainer `/supervisor/stop`
   endpoint; it is a lab action to create the stopped state, not a user-facing action.
9. **Windows subset scope.** `test/provisioner.test.ts` hangs before its first test on the Windows runner (no output; the 15 s per-test timeout cannot interrupt it because nothing has started). It is unchanged by this branch and passes on Linux/macOS. The curated Windows subset therefore excludes that one file (floor 360 executed) and keeps the other 22 files; this is a documented platform gap, not a skipped failure.
10. **The admin/RPC/console listeners** were not exposed to peers in this run: Inbound is Drop with
   zero rules and only presence/control (unshared) or gateway/catalogue/control (shared) are in the
   Forward chain. The evidence is the generated TOML/ACL checks plus the failed unauthenticated
   access checks from the lab; a second independent port-by-port scan is not repeated here.

## 6. Cleanup

The lab exported an allowlisted manifest before deletion. `harness.py cleanup` reports no
remaining processes and every lab port free (`evidence/lab-cleanup-proof.json`), then
`cleanup --delete` removed `/private/tmp/phase10-closure-lab`. No real Magpie profile, port 3425,
wallet or unrelated process was touched. The sanitized manifest and screenshots are committed
under `evidence/`; the lab root contained the network secret and session state and is gone.

## 7. Verdict for this stick

- **A stop-share defects F3/F4/F5: REPRODUCED fixed on real Magpie 0.1.2289 + EasyTier 2.6.4**
  (within the single-host boundary above).
- **B zero-file P2P: REPRODUCED end-to-end on real Magpie/EasyTier** up to request → human
  approval → encrypted delivery → native Remote → 200/429 → revoke/401, plus control-only
  presence. Not re-run on a WAN and not with a vendor model.
- **Visual UX / Wallet Usability / Mainnet / Real-money: unchanged by this stick.** No GO is
  claimed for C/D; the wallet/mainnet code is present from the integration base but was not the
  subject of this run.
