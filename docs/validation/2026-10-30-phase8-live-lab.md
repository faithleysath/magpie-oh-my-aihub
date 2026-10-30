# Phase-8 live acceptance — two isolated Magpies, real CLI journey

**Status: measured on the frozen tree.** This note is the sanitized evidence report for the phase-8
operator loop, produced by [`lab/phase8/journey.ts`](lab/phase8/journey.ts). The raw report, transcript,
source manifest and cleanup record are in [`phase8-live/`](phase8-live/). Failed attempts and their
corrections are kept in [`phase8-live/ATTEMPTS.md`](phase8-live/ATTEMPTS.md) so a passing report cannot
hide a changed harness.

The claim boundaries for the whole phase are in [`phase8-journey-plan.md`](phase8-journey-plan.md);
this note only records what the run measured.

## 0. Environment and identities

| Item | Value |
| --- | --- |
| Platform | macOS 26.6.2 (25G83), arm64 |
| Bun | 1.4.3 |
| Magpie app | `~/Projects/lab/magpie-iso/Magpie.app`, `magpie 0.1.2038` |
| Magpie binary SHA-256 | `0640889d004edfc1da0cd12bf8995e134968ea9b8ac4887d295d8989dadd4e15` (Go build metadata `vcs.revision=8c63c5b7873c6aa7aa797aa17f481d5fa8301876`, `vcs.modified=false`) |
| EasyTier | 2.6.4; release zip SHA-256 `4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b`; core reports `easytier-core 2.6.4-8428a89d` |
| Plugin source | branch `feature/mvp-onboarding-operator-ux`, base `bf7a27d`, working tree **dirty** (phase-8 changes uncommitted) |
| Tested plugin copies | three independent copies (P/C/P2); per-file SHA-256 in [`phase8-live/source-manifest.json`](phase8-live/source-manifest.json), all `ok:true` |
| Network | disposable overlay `phase8-lab-<pid>`, random 24-hex secret in a 0600 file, deleted with the lab |
| Nodes | P `5aa55370` (export `10.66.174.141/32`), C `3aaeaa82`, P2 `8be7f841` (export `10.66.53.235/32`) |
| Upstream | deterministic local mock, one native model per node (`p/p-model`, `c-model`, `p2-model`), price 1000/1000 |
| UI browser evidence | not in this note; the UI agent owns the page/browser run |

No Gateway Key, overlay secret, API token, wallet private key or keystore password is in this file or
in the evidence directory.

## 1. What was measured, and how

The harness starts every node as a **real Magpie**: a copied app bundle per node, `magpie plugin add`
with a per-node copy of the plugin package, then `magpie serve`. Magpie itself starts the plugin host,
so the run exercises the shipped lock/API/supervisor/provisioner path rather than importing the
plugin. Every state change goes through the operator CLI (`bun plugin/bin/ohmyaihub.ts --data …`) or
the consumer's own Magpie gateway; the harness never calls a service method directly.

Two gates in front of the run: the app must report `0.1.2038`, and each node's EasyTier binaries are
re-hashed against the pinned manifest before the core starts.

## 2. Journey A — a new provider

| Step | Command | Expected | Actual | Mark |
| --- | --- | --- | --- | --- |
| A1 | fresh profile + `setup --check` | host/Magpie/EasyTier identified, no overlay yet | `Magpie 0.1.2038`, EasyTier `2.6.4` verified, host reachable, `configured:false` | REPRODUCED |
| A2 | `setup --network … --secret-file … --share --ports …` | overlay comes up, export appears | P `5aa55370`, export `10.66.174.141/32`, gateway keyed probe 401 | REPRODUCED |
| A3 | `share setup --all-priced --publish` | only priced native models, signed quote, `priceLocked:false` | one model `p/p-model`, quote v1, `priceVersion 148dca96…`, published verified | REPRODUCED |
| A4 | `consumers add` + `share handover --key-file` | model whitelist, positive cap, 0600 file, no key on stdout | `cap $0.0001`, models `[p/p-model]`, file 0600, `keyPrinted:false` | REPRODUCED |
| A5 | gateway probes from the overlay side | 401 / 401 / 200 | `401` no key, `401` wrong key, `200` handed key | REPRODUCED |
| A6 | spend the cap, then `topup` | native 429, then 200 | first call 200, second `429 Remote magpie: … used $0.01 of $0.00`, `topup` cap `$1.0001`, third call 200 | REPRODUCED |
| A7 | repeated `setup` | no reset | `nodeId`, `instanceId`, mapped CIDR and secure public key unchanged | REPRODUCED |
| A8 | restart both Magpies | same identity, provider recovers | same identities, `peer-p` connected, call 200 | REPRODUCED |

## 3. Journey B — a new consumer

| Step | Command | Expected | Actual | Mark |
| --- | --- | --- | --- | --- |
| B1 | `setup --consume --catalog-discover` | joins the overlay, no key from discovery | C `3aaeaa82` joined; discovery base port 34945 | REPRODUCED |
| B2 | `connect` (list) | full fingerprint and `unverified` first sight | fingerprint `f7ecd55ee951d412e6d9c9e44c250c59fb5f17bdcd37a3375eda3ae43e7639c2`, quote `0ada21af…`, status `unverified` | REPRODUCED |
| B3 | `connect` without acceptance; wrong fingerprint | refused | `unverified` refused; `11…` fingerprint refused | REPRODUCED |
| B4 | `connect --trust --fingerprint --quote --request-out` | exact acceptance, 0600 request, no shell command | request written 0600, schema `ohmyaihub.connection-request/v1`, quote hash equals the provider's | REPRODUCED |
| B5 | `share approve request.json --cap 0.0001 --yes` | key scoped to the request, no key printed | approved, models `[p/p-model]`, cap `$0.0001`, `keyPrinted:false` | REPRODUCED |
| B6 | `share approve` on a tampered request | refused, no key | stale quote hash refused, no consumer created | REPRODUCED |
| B7 | `share handover <consumer> --key-file` | 0600 handover | 0600 file, `keyPrinted:false` | REPRODUCED |
| B8 | `connect --key-file --id peer-p --fingerprint --quote` | connected through the provider path | `peer-p` `10.66.174.141/32:52745 -> 127.0.0.1:13425`, cap `0.0001` | REPRODUCED |
| B9 | `remote test` / `remote models` | read-only, target only | `connected`; models `[p/p-model]` | REPRODUCED |
| B10 | real consumer-Magpie call | 200 | `200` with the mock completion; P's upstream counter rose by one | REPRODUCED |
| B11 | `consume off` / `consume on` | hand-made provider kept, plugin-owned one removed and restored | `manual-local` kept, `peer-p` unregistered then reconnected, call 200 | REPRODUCED |
| B12 | second provider P2 + `remote test` while P2 is down | only the named provider degrades | `peer-p` connected/200, `peer-p2` `degraded`; `remote remove peer-p2` leaves `peer-p` connected/200 | REPRODUCED |

## 4. Journey C — wallet typed data and statement (no payment)

No public-chain transaction, signature or scan was performed. Test-asset registration is the only
chain interaction and it is read-only (`decimals()` through a public testnet RPC).

| Step | Expected | Actual | Mark |
| --- | --- | --- | --- |
| C1 | two equal chain records, no default chain | 97 and 84532 enabled; the wizard requires `--chain` | REPRODUCED |
| C2 | a test token registers only after `decimals()` | BSC token 6 decimals, Base token 18 decimals, both accepted after the read | REPRODUCED |
| C3 | a receiving address per `(provider, chain)` | both written and read back | REPRODUCED |
| C4 | `wallet wizard --batch` returns real typed data | chain 97 raw `1000000`, chain 84532 raw `1000000000000000000`; domain and message chain ids match; token contract and recipient match the registry | REPRODUCED |
| C5 | no implicit signing | both runs stop at `AWAITING SIGNATURE`; both intents were cancelled | REPRODUCED |
| C6 | a named-consumer unsigned statement | 0600 file, digest `1e72d3f3278d474bee4e0e5999d8c56c43e31559db69808eaab11ad478cc5f9a`, chains `[84532,97]`, two cancelled requests, `signed:false`, `keyPrinted:false` | REPRODUCED |
| C7 | real payment, finality, credit | not run in phase 8 | UNKNOWN (cited: PR #11) |

The statement is an accounting snapshot, not proof of payment: its digest only detects a hand edit.

## 5. Journey D — failures, recovery and exit

| Step | Action | Expected | Actual | Mark |
| --- | --- | --- | --- | --- |
| D1 | wrong key / no key / spent cap | 401 / 401 / native 429 | all three observed on the real gateway | REPRODUCED |
| D2 | one provider down | only that provider degrades | `peer-p2` `degraded`, `peer-p` 200 | REPRODUCED |
| D3 | `consume off` then `on` | reversible, hand-made provider untouched | manual provider kept, plugin-owned provider removed and restored | REPRODUCED |
| D4 | host restart | same identity, provider, ledger | same `nodeId`/`instanceId`, `peer-p` connected, call 200, cap `$1.0001` preserved | REPRODUCED |
| D5 | price change, usage-log gap, chain anomaly, backup/restore, full network exit | not re-run here | covered by the phase-6/7 reports and the security suite; not re-measured on this harness | UNKNOWN |
| D6 | cleanup | no process, no listener, no lab directory | 6 owned PIDs stopped, 0 remaining, 13/13 ports free, lab root removed | REPRODUCED |

## 6. Journey E — CLI hygiene (page evidence is the UI agent's)

| Check | Actual | Mark |
| --- | --- | --- |
| No command prints a Gateway Key; handover and statement are 0600 files | `keyPrinted:false` on handover, approve and statement; key-shaped strings redacted from the transcript | REPRODUCED |
| A failing API call is one line, no payload echo | wrong fingerprint, unverified peer and stale request each produced a single `error:` line | REPRODUCED |
| `checks` exit code and status JSON | used by `setup --check` and `share setup`; the publish gate requires `acl`, `catalog-published`, `catalog-quote`, `catalog-identity` | REPRODUCED |
| Page/browser, CSP, snapshot copy | not measured here | UNKNOWN (UI agent) |

## 7. Findings from the run, and their state

| Finding | State |
| --- | --- |
| Catalogue `contentHash` was computed over different bytes on the provider (no `publication`) and the consumer (full body), so every real `share approve` failed. | **Found by this lab; fixed** (provider now publishes the verified full-body hash; the material hash still drives version/dirty). Re-run passes. |
| `connect --trust` could leave the same command's request seeing `unverified` because the trust refresh was swallowed. | **Found by this lab; fixed** (trust now requires the exact fingerprint and updates the cached peer synchronously only when the cached quote matches). The final run shows no race. |
| `wallet statement` failed with `accounting has an unexpected field serving`. | **Found by this lab; fixed** (the live `serving` flag is no longer spread into the historical statement). Re-run produces a valid 0600 statement. |
| `magpie plugin add` can exit non-zero after its host logs a startup error although `plugins.json` recorded the spec. | Lab workaround only (accept the exit code when the spec is recorded); product behaviour unchanged, worth a follow-up. |
| Single-machine labs must put the consumer and provider catalogues in one five-port window, because discovery probes only `cfg.catalog.port … +4`. | Lab-only constraint; a real two-machine deployment uses 3426. No product change. |

## 8. Cleanup

- Every node ran from its own copy of the app and the plugin package; the user's installed Magpie
  profile (`~/.config/magpie`) was never read or written.
- The source lab profile (`~/Projects/lab/magpie-iso/data`) was touched once by the failed attempt 1
  (two dead plugin specs in `plugins.json`); it was restored to its previous spike-only list and no
  other file there was modified by the harness.
- All lab processes were stopped by PID (recorded), 0 remained, all 13 allocated ports were free
  afterwards, and the `/tmp` lab root was deleted.
- Evidence contains no secrets: only public fingerprints, quote hashes, node ids, status lines,
  typed-data digests and the unsigned statement.

## 9. Verdicts for this note

- **Operator loop (A, B, the measured parts of D, CLI side of E): REPRODUCED** on Magpie 0.1.2038 with
  real EasyTier 2.6.4, real plugin hosts and the real CLI. The run used a deterministic local mock
  upstream; real vendor execution remains **UNKNOWN**.
- **Wallet typed data and statement: REPRODUCED**, with no signature, transfer or chain write.
  Real payment/finality is cited from PR #11, not re-run.
- **Page/browser and CSP: UNKNOWN here** — the UI agent's evidence covers it.
- **Real-money production: NO-GO.** Unchanged: no price lock, oversell risk, interrupted-call
  handling and RPC trust are still open on the 0.1.2038 pin.
