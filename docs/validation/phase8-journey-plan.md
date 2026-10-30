# Phase 8 — onboarding and operator-journey acceptance plan

**Status: plan, with the execution result now in
[`2026-10-30-phase8-onboarding-ux.md`](2026-10-30-phase8-onboarding-ux.md).** This file records the
pre-run acceptance design and claim boundaries; the final report is the evidence. No new lab run is
needed for the documentation task.

This plan covers the documentation and user-journey part of phase 8. It does not change production
code, the Magpie/EasyTier pins, the plugin page implementation (the UI/CSP agent owns that), the
wallet/CSP inventory, or another agent's validation note.

## 1. Ownership and files

Owned by this task:

- `README.md`, `plugin/README.md`, `docs/ARCHITECTURE.md`
- `docs/ONBOARDING.md`, `docs/OPERATIONS.md`
- `docs/validation/phase8-journey-plan.md` (this file)
- `docs/validation/2026-10-30-phase8-onboarding-ux.md` (evidence report, initially a skeleton)
- `docs/validation/lab/phase8/*` (a light journey harness, after the CLI interface is stable)

Not touched here: `plugin/src/**`, `plugin/page/**`, `plugin/bin/**`, `plugin/test/**`,
`.github/workflows/**`, other agents' `docs/validation/phase8-*.md`.

## 2. Evidence base and claim boundaries

| Claim | Status | Evidence |
| --- | --- | --- |
| Fresh BSC and Base Sepolia payments credited the same real Gateway Key through two independent hosts, real EasyTier no-TUN and a real native Remote Magpie, with automatic watchers, restart recovery, duplicate scans and cleanup | **VERIFIED** | [`2026-10-30-fresh-twohost-wallet.md`](2026-10-30-fresh-twohost-wallet.md), merged by PR #11 (`bf7a27d`) |
| Original finalized BSC/Base payments replayed into a fresh real SQLite ledger and the real pinned Magpie key, producing 200 → 429 → credit → 200 | **VERIFIED**, replay not a new payment | [`2026-10-30-live-magpie-chain-credit.md`](2026-10-30-live-magpie-chain-credit.md) |
| Real-testnet payment/finality and the corrected Base 18-decimal amount | **VERIFIED** | [`2026-10-30-testnet-handoff.md`](2026-10-30-testnet-handoff.md), [`2026-10-30-phase7-multichain-wallet.md`](2026-10-30-phase7-multichain-wallet.md) §9 and its status addendum |
| Local EVM pipeline, including a real reorg freeze | **REPRODUCED** | phase-7 local chain lab; not a public-chain claim |
| Real vendor/paid model execution through the whole path | **UNKNOWN** | every two-host run used a deterministic local mock upstream |
| Real money, mainnet assets, production custody | **NO-GO** | unchanged price-lock, overshoot, interrupted-call and RPC-trust blockers |
| Magpie 0.1.2120 page/bridge compatibility | **VERIFIED by source comparison only** | UI/CSP note: page-facing files are byte-identical to 0.1.2038; the page bridge still exposes `magpie.options.get/set` |
| Magpie 0.1.2120 full host/CLI compatibility | **UNKNOWN** | not measured; do not claim it |
| Pricing/billing behaviour | **pinned to Magpie 0.1.2038** | phase-6 measurements stay on 0.1.2038; 0.1.2120 is a UI/bridge comparison, not a new billing verification |
| Linux Magpie GUI or Linux provider behaviour | **UNKNOWN** | Linux consumer container 0.1.2057 was measured; Linux GUI/provider was not |
| Linux EasyTier | **VERIFIED** | CI and earlier lab evidence |

The phase-7 note's earlier sentences that call the fresh combined payment/EasyTier run “UNKNOWN”
are historical. They are superseded by the PR #11 report for the mock-upstream scope described
above; real vendor execution remains UNKNOWN.

## 3. Inventory of stale or incomplete statements

Line numbers are from `bf7a27d` and will be re-checked before the final diff.

| File:line | Current statement | Problem | Correction |
| --- | --- | --- | --- |
| `README.md:5` | “The real-testnet deposit run is UNKNOWN — testnet gas could not be obtained” | Contradicted by the merged PR #11 fresh two-host run | State fresh BSC/Base testnet deposits/credit are VERIFIED; real vendor execution remains UNKNOWN; real funds NO-GO |
| `README.md:5` | “Verified against Magpie 0.1.2038 …” as the only version | Omits the 0.1.2057 Linux consumer and the 0.1.2120 UI/bridge comparison; could imply 0.1.2120 host/CLI is verified | Add an explicit version/scope matrix |
| `README.md:52-54` | Phase-7 evidence link and “which testnet steps are UNKNOWN” | Does not link the fresh two-host and real-Magpie replay reports | Link both, label the phase-7 section historical where it says “UNKNOWN” |
| `plugin/README.md:13` | “No wallet, no chain, no automatic top-up. ‘Top up’ is a local, simulated credit.” | False after phase 7 | Separate manual simulated top-up from the testnet chain wallet; state mainnet/real funds are not enabled |
| `plugin/README.md:9-12` | Version and Linux claims | 0.1.2120 UI/bridge and 0.1.2057 Linux consumer are missing; “Linux uses the same code paths” overstates Magpie coverage | Use the same matrix as ARCHITECTURE; say Linux GUI/provider untested |
| `plugin/README.md:178-230` | “Consumers and simulated credit” only | Omits the chain wallet, its signing flow, finality and unclaimed/uncertain cases | Add a concise wallet subsection and link to `docs/ONBOARDING.md`/`docs/OPERATIONS.md` |
| `plugin/README.md:310-320` | State-on-disk table | Missing `networks.json`, `chain.sqlite`, `catalog-identity.json`, `catalog-publish.json`, `catalog-trust.json`, `easytier-state.json`; no backup warning | List every store; say a backup must stop the host and include Magpie's own key/provider files |
| `plugin/README.md:327-348` | Layout | Missing wallet modules, page app, new docs; stale lab path | Update the layout and mark the phase-4 lab as historical |
| `plugin/README.md:357-390` | Known limits | No wallet/onboarding/backup/version limits; Linux line is imprecise | Add the limits below; correct Linux wording |
| `docs/ARCHITECTURE.md:139-140` | “and later the wallet, chain watcher and reconciliation” | Phase 7 implemented them | State they are implemented for testnet |
| `docs/ARCHITECTURE.md:228-229` | “which is why the wallet phase stays out” | Testnet wallet exists; only peer-key binding/real funds stay out | Say testnet wallet uses a signed EIP-712 payer; binding to a peer key remains future work |
| `docs/ARCHITECTURE.md:420-421` | “no wallet is connected” | False after phase 7 | Say the minimum is still simulated display data; a separate testnet watcher credits test tokens; no fiat/mainnet |
| `docs/ARCHITECTURE.md:810` | “simulated credit only” | Wrong label for testnet chain credit | “Testnet credit only; real funds remain blocked” |
| `docs/ARCHITECTURE.md:822-923` | Known blockers: phase-7 additions restart at 14 after phase-6 items 14-22; item 14 says fresh cross-host is not verified | Duplicate numbering and stale item | Renumber once; merge the phase-6 and phase-7 lists; replace item 14 with the PR #11 result and the real-vendor UNKNOWN |
| `docs/ARCHITECTURE.md:835` | “Windows and Linux Magpie provider behaviour is untested” | Linux consumer container 0.1.2057 was tested; Linux GUI/provider was not | “Linux Magpie consumer container 0.1.2057 verified; Linux GUI/provider untested; Windows untested” |
| `docs/ARCHITECTURE.md:812-820` | Pinned versions table | Only 0.1.2038, no scope | Add 0.1.2057 consumer container and 0.1.2120 UI/bridge scope; keep the billing pin at 0.1.2038 |
| `plugin/page/app.js` (phase-7 line 306) | “simulated only — no wallet or payment is connected” | The UI owner has rewritten the page; the statement was stale after phase 7 | UI-owned; this task verifies the final copy, no edit here |
| `plugin/src/service.ts` catalog top-up note | “No wallet, payment network … is connected” in the signed quote | Still present in the working tree at the last check; production code is outside this task | Flag to the owning agent for the final sync; no edit here |

Also missing entirely: a quick start, a two-role handover, catalog TOFU approval, a test call,
backup/restore, stop-sharing/key-revocation/network-exit, balance-anomaly recovery and a
troubleshooting index. Those are the new docs' job, not just line edits.

## 4. Minimal viable acceptance (MVA)

The MVA is deliberately smaller than the phase-4 lab and much smaller than phase 7:

- Two **fresh isolated Magpie configurations** on this machine, provider P and consumer C, each with
  its own `HOME`/portable `data` and no user profile.
- One real EasyTier 2.6.4 no-TUN overlay, real native Remote Magpie registration, real plugin hosts
  and the real CLI. A deterministic local upstream supplies one priced native model.
- No public chain transaction. Journey C uses the already-finalized PR #11 evidence and, if useful,
  a local `anvil` two-chain run; it must not send a new BSC/Base transaction.
- UI/browser evidence is the UI agent's run. This task checks page copy/flow consistency and the
  CLI side; it does not duplicate the browser harness.
- All journey scripts are maintainer evidence, not user instructions. The docs use only the
  operator CLI, `magpie` and ordinary wallet/foundry commands.

Every MVA item must record: command, sanitized output, expected/actual, platform, binary identities,
cleanup and an explicit `VERIFIED` / `REPRODUCED` / `UNKNOWN` mark.

## 5. Journey A–E

### A. New provider

Preconditions: empty isolated Magpie; plugin installed/booted; one native provider/model with a
complete price; Magpie LAN sharing enabled.

Acceptance:

1. Fresh `status` explains “no configuration yet”; `checks` fails the `configured` check, not a
   misleading ACL failure.
2. Set network name/secret/peer/listen, enable sharing; after the host restart, `status` shows the
   export and `checks` passes `core-running`, `acl`, `gateway-key-required`, `mapped-cidr`,
   `published-gateway` and `shared-models-native-only`.
3. `consumers add` creates a key with a model whitelist and a positive cap; `share handover` writes
   the key to a fresh 0600 file/test path, never to stdout or a committed log.
4. From C through the real overlay: no key → 401, wrong key → 401, valid key → a model list/200;
   a request spends the cap and the next one is a native 429; a manual top-up restores 200.
5. `share off` withdraws the export and the catalog; a remote request no longer reaches the gateway;
   the key is still in Magpie (documented), and `revoke` makes the valid key 401.
6. Re-enable sharing and a second consumer key to prove the stop was reversible; then revoke.

### B. New consumer

Preconditions: P publishes a catalog; C has a configured overlay and discovery enabled.

Acceptance:

1. `catalog peers` shows P with a full Ed25519 fingerprint and `unverified` first sight.
2. `catalog trust <node-id>` moves it to accepted/verified-by-TOFU; a changed fingerprint becomes
   `identity-changed` and is never silently accepted.
3. `catalog request` returns the structured request (consumer id, model ids, quote hash, price
   version, approval block, no shell command). P approves out of band with `consumers add`, passing
   the quote hash/price version when the CLI supports it, and hands over the key.
4. C uses `connect --key-file` (or `remote add --key-file` for a direct handover); `remote list`
   is `connected`; `checks` passes the provider's forward/ownership/status checks; a real Remote
   Magpie call returns 200 and a spent key returns 429.
5. Wrong key is refused by the gateway; `remote remove` removes only that provider; `consume off`
   unregisters the plugin-owned Remote Magpie and leaves hand-made entries alone.
6. The direct handover path (mapped CIDR + key, no catalog) is documented as the fallback.

### C. Two-chain recharge and signing

No new public testnet payment. Evidence layers:

- **VERIFIED (prior):** PR #11 fresh BSC 97 and Base Sepolia 84532 payments, automatic credit,
  finality, duplicate scans and cleanup; the live replay of original payments into the real ledger
  and Magpie key.
- **REPRODUCED (new, no payment):** the production wizard on both chain records returns real typed
  data after a typed-data request; no transfer is sent. A local `anvil` two-chain credit run remains
  optional and is not a public-chain claim.
- **DOC JOURNEY:** P enables each chain, registers a test token after `decimals()`, publishes a
  receiving address per chain, and creates the typed data with `wallet wizard --batch`; **C signs
  externally** and returns a `{signature,payerAddress}` file; P resumes with
  `wallet wizard --invoice --signature-file`, sends C the exact transfer, waits for that chain's own
  finality, inspects `wallet events`/`wallet credit`, and may send C an unsigned statement. C never
  runs P's wizard or accesses P's loopback API. No public payment is sent.
- **UNKNOWN:** a novice completing this without a test token, test gas or a funded disposable
  wallet; real vendor execution; mainnet.

Acceptance for the phase-8 wizard run: both chains produce real typedData with no default chain,
the provider records the consumer's external signature, no payment is sent, and the statement is
unsigned. Both-chain credit, duplicate-scan zero and cap rise remain **VERIFIED only in the prior
public testnet reports**; the docs must clearly separate test tokens from money.

### D. Failure, recovery, backup/restore, exit

Acceptance:

1. Provider offline: C's provider becomes `degraded`; another provider keeps serving; recovery
   returns to `connected`.
2. Wrong key 401; spent key 429; revoked key 401; `revoke` removes the key and cannot reuse the
   same consumer id.
3. Price change: the accounting check pauses the key; `checks`/status show the reason; `consumers
   reissue --accept-price-version` restores a 200 without repricing settled usage.
4. Usage-log gap: the consumer is paused; `consumers reissue` is refused; `resolve-gap` records the
   audit and the next reissue proceeds on the recorded balance.
5. Chain anomaly: an unsigned transfer stays `unclaimed`; a duplicate/ambiguous match stays
   `uncertain`; neither credits; `wallet anomalies` shows it; a resolution note does not invent
   credit.
6. Backup/restore: stop Magpie and the host; archive the **whole** Magpie config directory (not
   just `oh-my-aihub`); restore into a fresh isolated directory; `status`, `checks`, `accounting`,
   `providers`, `consumers` and `wallet` match; a remote call and ledger balance are unchanged.
7. Network exit: `share off`, revoke each consumer, `remote remove` each remote provider, `consume
   off`, `stop`, `magpie plugin off`; no EasyTier core/listener remains; the state directory is
   retained or removed only after the backup; re-enable works.

### E. Page and CLI

Page (UI agent runs the browser; this task checks the contract):

- The page is read-only after onboarding; the only mutations are the official options bridge and
  display preferences available through it.
- A save makes Magpie restart the shared plugin host; the overlay and loopback API disappear for a
  few seconds; the page must say that, not “restart Magpie”.
- Six sections render from the snapshot: status, this node, catalog, directory, testnet credit,
  operations; missing fields show “not provided”, never a fabricated value.
- Wallet status is produced by the host snapshot, not only by a manual `wallet` call after the UI
  fix; no payer address, key, secret or consumer↔address association is displayed.
- Exactly two external documentation links; only “Reload snapshot” and the settings save are
  buttons; no buy/swap/bridge action.

CLI:

- Every command in `docs/ONBOARDING.md`/`docs/OPERATIONS.md` runs as written with `--data` and Bun.
- `checks` exits 1 on a failed check and 0 when all pass; `status` is parseable JSON; `providers`,
  `consumers`, `accounting` and `wallet` print actionable state.
- Missing configuration, missing key, wrong chain and mainnet enablement fail with an error a new
  operator can act on.
- No command prints a secret except the explicit `secret` handover; logs redact keys and the network
  secret.

## 6. Harness plan (after the CLI interface is stable)

`docs/validation/lab/phase8/journey.ts` (name to be finalized) will:

1. Create two isolated portable Magpie 0.1.2038 data directories and two plugin hosts, reusing the
   phase-4 `host.ts` pattern and a small mock upstream; no phase-7 wallet lab, no third host, no
   public RPC, no chain write.
2. Drive the real CLI (`plugin/bin/ohmyaihub.ts`) and HTTP endpoint exactly as a user would, not
   by calling service methods directly.
3. Run A, B and the non-chain parts of D; record JSON and a sanitized transcript.
4. For C, either attach the existing PR #11 evidence or start two local `anvil` nodes; never
   broadcast a public testnet transaction.
5. Leave a single cleanup section and a `--keep` option for diagnosis, like the phase-4 lab.
6. Be included in TypeScript checking; not run by ordinary CI unless explicitly added to the
   workflow by the owner.

The CLI owner has implemented the operator entries `setup`, `resume`, `preflight`/`doctor`,
`share setup`, `share approve`, `share handover`, `connect`, `remote list|test|models|update-key|
add|remove|recover`, and the wallet entries `wallet wizard`, `wallet status` and `wallet statement`.
The harness drives the real implemented entries from the CLI; the wallet journey must use the wizard
and capture its real typedData, not substitute the old explicit commands.

## 7. Documentation deliverables

Minimum set:

1. `docs/ONBOARDING.md` — five-minute install/provider/consumer start, both roles, direct and
   catalog/TOFU handover, the two key types, a real test call, and the advanced testnet wallet
   flow (test tokens only).
2. `docs/OPERATIONS.md` — daily loop, accounting/balance anomalies, stop sharing, revoke, remove a
   provider, leave the network, backup/restore, troubleshooting and log locations.
3. `README.md` — current status, evidence links, version matrix, “start here”.
4. `plugin/README.md` — accurate capabilities, install prerequisites, wallet/state/layout/limits,
   and the page’s read-only/restart semantics.
5. `docs/ARCHITECTURE.md` — corrected current status, version matrix, Linux wording, stale wallet
   statements and the known-blocker numbering.
6. `docs/validation/2026-10-30-phase8-onboarding-ux.md` — A–E evidence, cleanup, unresolved issues
   and the three verdicts.

Optional only if the CLI agent needs it: a tiny `doctor`/`next-step` command. It is not required
for the MVA and is not in this task’s file ownership.

## 8. Three verdicts (criteria, not results yet)

- **MVP Usability:** GO only if an ordinary Magpie user can complete A, B, the relevant parts of D and
  the guided CLI/page flow without a laboratory script, on the documented version, and the page
  contract is consistent. If only the pinned 0.1.2038 works while the installed 0.1.2120 cannot run
  the host/CLI, the verdict is “GO on 0.1.2038, NO-GO for 0.1.2120”, not a silent general GO.
- **Testnet E2E:** GO (limited) if the guided `wallet wizard` returns real typedData, the signed
  request/credit path is documented, and the prior real BSC/Base evidence is cited without being
  re-run; NO-GO for treating test tokens as money, for unattended onboarding, or where the user
  cannot sign/keep their wallet key.
- **Real-money Production:** **NO-GO** in this phase. The price-lock/oversell/interrupted-call/
  RPC-trust blockers are unchanged, and no real vendor execution has been measured.

## 9. Dependencies and open questions

1. CLI agent: the `setup`/`share`/`connect`/`remote` and wallet wizard/status/statement entries are
   in the working tree; the server routes for explicit quote acceptance, share candidates and
   targeted provider probes are wired. The harness can exercise B/C/E once the tree stops changing.
2. UI agent: final page sections, save/restart wording, wallet snapshot fields, and the browser
   evidence; this task must not duplicate the browser harness.
3. Main agent: whether to include the optional phase-8 lab in CI paths; whether the final report
   may cite the existing PR #11 payments instead of repeating them (the scope here assumes yes).
4. Version wording: 0.1.2120 is UI/bridge source comparison only; the billing pin stays 0.1.2038.
   A full 0.1.2120 host/CLI run is out of scope until separately authorized.
5. Backup/restore is a documented stopped-host procedure for the MVA; a CLI backup command is not
   assumed.

## 10. Order of work

1. This plan.
2. Stale-claim corrections in README/plugin README/ARCHITECTURE.
3. `docs/ONBOARDING.md` and `docs/OPERATIONS.md` with the implemented `setup`/`share`/`connect`/
   `remote` entries; keep the wallet-wizard/statement note until that owner finishes.
4. Wait for the CLI/UI interface sync; replace command names and page wording.
5. Write the phase-8 journey harness; run A/B/D (and the local C dry run) against two fresh isolated
   Magpies; UI agent supplies E browser evidence.
6. Fill `2026-10-30-phase8-onboarding-ux.md`; run the full CI once at the end; clean up all lab
   processes and temporary data.
