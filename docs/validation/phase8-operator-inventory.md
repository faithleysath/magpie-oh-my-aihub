# Phase 8 — operator onboarding inventory (pre-change)

Date: 2026-10-30
Branch: `feature/mvp-onboarding-operator-ux` at `bf7a27d` (`main` merge of PR11), clean tree.
Scope of this note: what the operator surface can do today, what is missing for a first-run
`setup → share → connect → remote` loop, and the exact files this owner will change.
No code behaviour is changed by this note.

## 1. Environment measured for this inventory

| Item | Value | Evidence |
| --- | --- | --- |
| Host | macOS 26.6.2 (25G83), arm64 | `sw_vers`, `uname -m` |
| Bun | 1.4.3 | `bun --version` |
| Node (not the plugin runtime) | v24.21.0 | `node --version` |
| Magpie installed on this machine | **0.1.2120** at first check; **0.1.2154** observed later (auto-update) | `/Applications/magpie.app/Contents/Info.plist`, `magpie --version` |
| Magpie accepted by the project | **0.1.2038** (`8c63c5b7873c6aa7aa797aa17f481d5fa8301876`) | `docs/ARCHITECTURE.md`, `README.md`; source checkout `~/Projects/lab/magpie-2038` |
| EasyTier accepted by the project | **2.6.4** (`8428a89d2dabc94c97d370ec607c6ca142473626`) | `plugin/src/easytier-manifest.ts`, `docs/ARCHITECTURE.md` |
| Installed plugin state | none (`~/.config/magpie/oh-my-aihub` absent) | `ls` |
| Plugin package | `@oh-my-aihub/magpie-plugin@0.4.0` | `plugin/package.json` |

**VERIFIED** the local Magpie is newer than the only version the project has tested (0.1.2120, then
0.1.2154). A setup preflight reports `tested=0.1.2038, found=<actual>, compatibility=UNKNOWN`; it
does not silently call the newer build verified and does not hard-fail without a clear message.

**UNKNOWN** whether Magpie 0.1.2120 keeps the CLI/read-back behaviour this plugin depends on
(`gateway-key add|models|limit`, `provider add remote-magpie`, `caller-keys.json`,
`/v1/magpie/limit`). It must not be claimed as verified until measured.

## 2. Existing operator surface

### 2.1 Commands that already exist (`plugin/bin/ohmyaihub.ts`, 605 lines)

| Area | Commands | What is already proven |
| --- | --- | --- |
| Host / state | `status`, `checks`, `accounting`, `guard`, `start`, `stop` | status JSON, PASS/FAIL checks, accounting state, supervisor start/stop |
| Sharing | `share on|off`, `share models`, `configure` | publishes/withdraws this Magpie, sets the native-model allow list, writes overlay config |
| Catalogue | `catalog publish|discover on|off`, `catalog config`, `catalog refresh`, `catalog peers`, `catalog trust`, `catalog request`, `catalog connect` | signed read-only quote, TOFU trust, structured connection request, connect through the normal provider path |
| Consumer keys | `consumers add|models|reissue|resolve-gap`, `secret`, `topup`, `revoke` | positive cap, native-only whitelist, ledger, hand-over guard |
| Remote providers | `providers`, `provider add|update|rm|reconcile`, `connect`, `disconnect` | per-provider forward/key/registration/status, rollback of the provider being changed |
| Wallet | `wallet …` (networks, assets, receiving, intent, sign, events, scan, anomalies, credit) | testnet-only deposit path |

`status` already reports core, ACL, peers, native/remote provider ids, consumers, catalogue and
checks. `checks` already covers `core-running`, `acl` (effective ACL, RPC loopback and forwards),
`gateway-key-required`, `mapped-cidr`, `published-gateway`, `shared-models-native-only`,
catalogue and per-provider forward/registration/status.

### 2.2 Gaps that block a first-run MVP loop

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | No `setup`, no `resume`, no preflight. The CLI reads `api-port`/`api-token` before it knows the command, so even a diagnostic dies with ENOENT/ECONNREFUSED stacks when the host is not up. | `bin/ohmyaihub.ts:57-69`; **REPRODUCED**: `status` against an empty temp dir printed `ENOENT … api-port`, and against port 1 printed `ECONNREFUSED` with a Bun stack trace |
| G2 | `configure` writes `state.config` and `saveState` **before** `applyConfig`; a failed EasyTier start leaves the new config persisted. | `src/service.ts:979-984`; **VERIFIED** by source |
| G3 | The CLI `configure` always sends `peers` (empty when `--peer` is absent) and `listenAddr: null`, while the service treats those as explicit values. A partial reconfigure therefore clears peers/listen. | `bin/ohmyaihub.ts` `configure` case; `service.ts` `input.peers ?? prev.peers`, `input.listenAddr === undefined ? prev : …`; **VERIFIED** by source |
| G4 | No way to list the node's **actual native shareable models** (and whether each has a complete price) before choosing a share list or publishing a quote. Catalogue models are only available after publishing. | `catalogModels()` is used internally; no route/CLI |
| G5 | `catalog request` and `catalog connect` accept `unverified` first-seen identities. They do not require the operator to pass the fingerprint/quote hash they reviewed. A signed quote can change between display and action without an explicit acceptance. | `src/service.ts:1291-1381`; **VERIFIED** by source |
| G6 | `secret` prints the Gateway Key to stdout; `provider add/update` and `catalog connect` take `--key sk-…` on the command line. Both land in shell history/process lists and logs. | `bin/ohmyaihub.ts` help and cases; `README`/phase-5 lab use `--key` |
| G7 | No hidden secret input and no 0600 file input for the network secret or a Gateway Key. | no `readline`/`isTTY`/mode check under `plugin/` |
| G8 | Host HTTP calls have no timeout; a hung host hangs the CLI. Failures print the raw server error/body. | `bin/ohmyaihub.ts:64-80`; no `AbortSignal` |
| G9 | No targeted `remote test` / model list. `provider reconcile` rechecks every provider and can mutate unrelated statuses; there is no read-only per-provider probe. | `src/service.ts` `reconcileProviders` loops all providers |
| G10 | `share` has no guided flow that shows the quote's `priceLocked:false`, price version, missing-price models, and optional publish in one place. | only low-level `share models` + `catalog publish` |
| G11 | `connect` has no guided flow that displays TOFU fingerprint/quote and obtains explicit acceptance before calling `catalog connect`. | source G5 |
| G12 | No approval step that consumes the structured request JSON and reuses `consumers add` with a provider-chosen positive cap and model list. | request JSON exists; provider approval is manual |
| G13 | The page snapshot has no cached checks/readiness; `writeSnapshot()` writes `checks: []`. Provider-side reachability is therefore absent from the page unless somebody calls `/status`. | `src/service.ts` `lightStatus()` and `writeSnapshot()` |
| G14 | The page wallet section reads `walletStatusCache`, which is filled by an RPC-backed `Wallet.status()`. A page write must not trigger RPC. | `src/service.ts` `walletStatus()` / `lightStatus()` |

### 2.3 Existing safety boundaries that must not be weakened

- Magpie remains the only AI path and charging point; the plugin never proxies a request.
- Sharing exports the node's own LAN `/32`; Inbound stays `Drop` with no rules; Forward opens only
  published ports; the virtual-IP path is never offered.
- A shared key names only native providers/models, has a non-empty whitelist and a positive cap on
  Magpie's `$0.0001` grid. Remote models and `group/…`/`auto/…` are refused.
- A remote provider is a record with its own loopback port, Gateway Key and registration; the plugin
  only edits an entry it can prove it wrote. One provider's failure must not remove another's.
- A quote is display data. It creates no key/account/charge. `billing.priceLocked` is always
  `false`.
- Testnet only; no mainnet, real payment, upstream fork or admin interface exposure in this phase.

## 3. Proposed operator loop (minimum, no new business logic)

All new commands are thin clients of the existing local API. They never talk to Magpie for a state
change; the service keeps that path. New commands print JSON with `--json` or a short human view.

### 3.1 `setup` / `resume` / `preflight`

```text
ohmyaihub setup [--resume|--check|--reconfigure] [--json]
  [--network <name>] [--secret-file <0600 file>|--prompt-secret]
  [--peer tcp://…]… [--listen <addr>] [--ports 3425] [--gateway-port 3425]
  [--share|--no-share] [--consume|--no-consume]
  [--catalog-publish|--no-catalog-publish] [--catalog-discover|--no-catalog-discover]
  [--magpie-bin <path>] [--timeout-ms <n>]
```

- **Preflight (no mutation):** platform/arch, Bun, Magpie binary/path/version vs tested 0.1.2038,
  plugin host (`api-port`/`api-token`/`host.lock` + `/health`), `state.json` version/config presence,
  EasyTier pinned manifest + installed binary hashes + running core version, LAN address, gateway
  `LAN:port` keyed probe (401 without a key), `rpcPort`, and the cached `checks` if the host is up.
- **Resume rule:** if `state.json` already has a `config` and `--reconfigure` was not passed,
  `setup` never calls `/configure`. It reports the existing config and runs/prints `checks`. This is
  the guard against an accidental reset. `--reconfigure` is the only path that submits `configure`.
- **Partial reconfigure:** only fields explicitly present are sent; `peers` and `listenAddr` are
  omitted rather than sent empty/null. (Fixes G3.)
- **No reset:** the service already preserves `nodeId`, `instanceId`, `mappedCidr`,
  `virtualIpv4`, `rpcPort` and the Secure Mode identity when they are absent from the input.
- **Failure:** the service applies the candidate in a transaction (G2); on failure it restores the
  previous config, re-applies that config, and leaves providers/keys/ledger untouched. The CLI
  reports both errors if the restore itself fails.
- **Secrets:** interactive hidden prompt only when stdin is a TTY; non-interactive requires
  `--secret-file` with mode 0600, owner-only, regular file, no symlink. No `--secret` in the new path
  (the old low-level `configure --secret` stays for compatibility, documented as unsafe).

### 3.2 `share setup`

```text
ohmyaihub share setup [--models a,b|--all-priced] [--publish|--no-publish] [--json]
ohmyaihub share handover <consumer> --key-file <0600 path> [--force]
ohmyaihub share approve <request.json> --cap <usd> [--consumer <id>] [--models a,b] [--json]
```

- Lists **native** providers/models from the service, marks each with its effective price and
  `completePrice`. Remote models, `group/…` and `auto/…` are never candidates.
- Writes the allow list through the existing `share models` path. Then shows the quote preview:
  model count, `priceVersion`, `priceLocked:false`, and every model that cannot back a capped key.
- Publishing is opt-in (`--publish`/prompt, default no). Publishing uses the existing
  `catalog publish on`; it is not silently enabled by sharing.
- `share approve` validates `schema: ohmyaihub.connection-request/v1`, re-reads the request's
  consumer/models/hash/price version, forces the provider to choose a positive cap, and calls the
  existing `/consumers/add` route. It never accepts the consumer's cap as authoritative and never
  prints a key.
- `share handover` calls `/secret` and writes the key to a new 0600 file (`O_EXCL`), printing only
  the consumer id, models, cap and path. A one-way SHA-256 prefix may be shown for verification.

### 3.3 `connect` wizard

```text
ohmyaihub connect [--node <id>] [--fingerprint <sha256> --quote <sha256>]
  [--request-out <file>] [--key-file <0600 path>] [--id <provider-id>] [--json]
```

1. Refresh and show catalogue peers with status, **full** TOFU fingerprint, quote version/hash,
   `priceVersion`, `priceLocked:false`, model count and prices.
2. Display which models have complete prices; the operator selects.
3. Require explicit acceptance: interactive types/confirms the fingerprint, non-interactive passes
   `--fingerprint` and `--quote`. An `unverified` or `identity-changed` peer is refused until
   `catalog trust` is run with that exact fingerprint.
4. `--request-out` writes the existing structured request JSON; otherwise print it. No shell command
   is generated.
5. After the provider returns a key file, `--key-file --fingerprint --quote` calls
   `/catalog/connect`. The service re-checks the accepted fingerprint/hash and the existing
   `addProvider` probe/rollback path. The key is never printed; other providers are kept.

### 3.4 `remote` management

```text
ohmyaihub remote list [--json]
ohmyaihub remote test <id> [--json]        # target only, read-only
ohmyaihub remote models <id> [--json]      # target only, read-only
ohmyaihub remote update-key <id> --key-file <0600 path>
ohmyaihub remote remove <id>
ohmyaihub remote recover [<id>]
```

`test`/`models` probe only the named provider through its own forward/key and never re-register,
remove or restart another. `update-key` uses `provider update` (same target keeps the listener;
failure restores that provider's previous registration). `remove` uses `provider rm` and then shows
the remaining providers; EasyTier 2.6.4 may restart once to drop the forward, and the service
re-verifies the others. `recover` is the existing reconcile path, with per-provider results.

## 4. Service changes assigned to this owner (`plugin/src/service.ts` only)

| Change | Minimal shape | Why |
| --- | --- | --- |
| S1 configure transaction | Snapshot `state.config` + `state.shareSuspended`; validate/build; write candidate; `try { applyConfig; applyCatalog; … } catch { restore snapshot; save; re-apply previous config (or stop when there was none); throw original + restore status }`. Do not revert guard narrowing, provider records, keys or ledger. | G2; a failed wizard must keep the old config running |
| S2 cached checks + readiness | Cache the result of `checks()` with `checkedAt`, `startedAt`, `durationMs`, and expose it in `lightStatus()`/`writeSnapshot()`. `readiness` is derived from cached checks (`ready`/`degraded`/`blocked`/`unknown`). Remote provider reachability is `UNKNOWN` until a live probe; never default to reachable. Age is computed from the real check time, not snapshot time. | G13; page has no network |
| S3 page wallet local view | `lightStatus().wallet` uses `Wallet.statusLocal()` when the wallet module provides it (no RPC), else the last cached result. Do not construct a wallet or call `status()` from a snapshot write. | G14; page writes must not open RPC |
| S4 catalogue acceptance | `catalogRequest`/`catalogConnect` gain an acceptance argument `{fingerprint, quoteHash, priceVersion?}`. Require exact identity fingerprint and quote hash; require the peer to be locally trusted (`verified`/`connected`); reject unverified/identity-changed/stale. The request JSON records the acceptance. | G5; explicit TOFU and quote acceptance |
| S5 read-only share candidates | `shareCandidates()` returns native provider/model ids, effective price, `completePrice`, current policy and a `priceVersion` for all priced native models. No Magpie writes. | G4 |
| S6 targeted provider probe | `providerModels(id)` returns the models the named provider serves through its own forward/key; no state mutation. `reconcileProviders({only})` limits a reconcile to one id. | G9; remote test/models must not disturb others |

New server routes for S4–S6 are **not** in this owner's files. They must be added by the security
agent (see §6) and must keep the existing token rule (mutations require bearer; read-only GETs are
loopback).

## 5. Files this owner will change

```text
plugin/bin/ohmyaihub.ts                 thin entry: global args, dispatch, existing switch preserved
plugin/bin/operator-lib.ts              API client with timeout, sanitised errors, 0600 secret I/O,
                                        non-mutating state read, preflight helpers, output
plugin/bin/operator-setup.ts            setup / resume / preflight
plugin/bin/operator-share.ts            share setup / approve / handover
plugin/bin/operator-connect.ts          connect wizard / request output / accepted connect
plugin/bin/operator-remote.ts           remote list / test / models / update-key / remove / recover
plugin/src/service.ts                   S1–S6 only
plugin/test/phase8-setup.test.ts        setup/resume + configure rollback journeys
plugin/test/phase8-share-connect.test.ts share candidates, quote acceptance, request/approve
plugin/test/phase8-remote.test.ts       targeted remote probe/update/remove, other providers intact
docs/validation/phase8-operator-inventory.md  this note
```

Not touched: `plugin/src/server.ts`, `plugin/src/index.ts`, `plugin/src/log.ts`,
`plugin/src/wallet.ts`, `plugin/page/**`, `plugin/bin/wallet-wizard.ts` (wallet owner). The wallet
owner's `wallet-wizard.ts` will be wired into the entry only after its signature is delivered.

## 6. API routes needed from the security agent

| Route | Method | Body/params | Response |
| --- | --- | --- | --- |
| `/catalog/request` (extend) | POST | `nodeId, models?, fingerprint, quoteHash, priceVersion?` | existing request JSON + `acceptance` |
| `/catalog/connect` (extend) | POST | `nodeId, key, id?, fingerprint, quoteHash, priceVersion?` | provider view |
| `/share/candidates` | GET | none | native model list with prices/`completePrice`, policy, `priceVersion`, `priceLocked:false` |
| `/providers/models` | POST | `id` | `{id, models, limit, status, detail}`; target only |
| `/providers/reconcile` (extend) | POST | `id?` | limit the pass to that provider |
| `/status` (extend) | GET | none | cached `checks`, `checksAt`, `readiness`, local wallet snapshot |

The routes must not expose secrets or call Magpie admin APIs. A missing acceptance fingerprint/hash
must be a 400, not a silent connect.

## 7. Acceptance tests to write first (journey level)

1. **Setup never resets an existing config.** With an existing `state.json`, `setup` performs no
   `/configure` call. `setup --reconfigure` sends only named fields (no empty `peers`/`null` listen).
2. **Failed configure keeps the old config.** A supervisor that throws on the new network but starts
   the old one leaves `state.config.networkName` at the old value, re-applies the old config, and
   leaves providers/keys untouched.
3. **Share candidates are native-only.** Remote models, `group/…`, `auto/…` and models without a
   complete price are reported and cannot be selected as priced share models.
4. **Quote acceptance is explicit.** Untrusted, wrong fingerprint, wrong quote hash and stale quote
   are refused; trusted + exact acceptance succeeds; request JSON contains
   `priceLocked:false` and the accepted hashes.
5. **Request/approve.** A request file is validated, converted into `/consumers/add` with a
   provider-chosen positive cap and model list; no key is printed.
6. **Remote isolation.** `remote test/models` touches only the named provider; `update-key` and
   `remove` keep the other provider's record/registration/forward.
7. **CLI failure hygiene.** No host → one-line actionable error, no stack; host hangs → timeout;
   a failing API response never echoes the request body or a secret.

## 8. Status of this note

- Inventory: **VERIFIED** against the branch source and the local binaries listed in §1.
- Gaps G1, G2, G3, G5, G8, G13, G14: **VERIFIED by source**; G1 was also **REPRODUCED** with the CLI.
- Magpie 0.1.2120 compatibility and real provider-side remote reachability without a probe:
  **UNKNOWN**.
- At the time of the inventory above, no code had been changed. The implementation status follows
  in §9; §8 records the pre-change state, not the current tree.

## 9. Implementation status after this note

Code changed by this owner (no `server.ts`, `index.ts`, `log.ts`, `wallet.ts` or `page/**`):

| File | Change |
| --- | --- |
| `plugin/bin/operator-lib.ts` | timed loopback API client with sanitized errors; 0600 secret file reader/writer (symlink and mode checks); hidden TTY prompt; non-mutating state summary; offline/host preflight |
| `plugin/bin/operator-setup.ts` | `setup`, `resume`, `preflight`/`doctor`; resume never submits `configure`; only named fields are sent; preflight reports Magpie/Bun/host/state/EasyTier/LAN/gateway/RPC/ACL |
| `plugin/bin/operator-share.ts` | native share-candidate selection with complete-price gate; quote preview with `priceLocked:false`; optional publish; request approval through `/consumers/add`; 0600 key handover without printing the key |
| `plugin/bin/operator-connect.ts` | peer display, explicit TOFU fingerprint + quote-hash acceptance, trust step, structured request output, 0600-key connect |
| `plugin/bin/operator-remote.ts` | targeted `list/test/models/update-key/add/remove/recover`; keys from 0600 files only; missing cap is UNKNOWN, `<=0` is UNLIMITED/unsafe (never `$0.0000`) |
| `plugin/bin/ohmyaihub.ts` | thin dispatch for the journeys plus secure low-level `--secret-file`, `--key-file`, repeated `--peer`, and no implicit empty peer/listen reset |
| `plugin/src/service.ts` | configure transaction/rollback that keeps a stricter suspension and re-guards before republishing; cached checks with real `checksAt`/`kind`/`at`; readiness with remote reachability default `UNKNOWN`; local wallet projection via `Wallet.statusLocal()`; `walletEvidence({consumerId?})` (statusLocal, ledger deposits, direct limit read; no refresh/verify persistence; failed read omitted) and `walletStatement()` (scoped to one consumer, full intents/events); quote contentHash is the full signed body while version uses a separate material hash; trust requires the exact fingerprint; strict catalogue acceptance; native share candidates; targeted provider models/reconcile |
| `plugin/test/phase8-service.test.ts` | rollback, readiness, local wallet, native candidates, targeted probe |
| `plugin/test/phase8-cli.test.ts` | setup/resume, reconfigure, secret-file mode, share setup/approve/handover, TOFU request/connect, remote models/update, wallet status/credit/statement, no-payload errors and timeout |
| `plugin/test/phase8-prompt-journey.test.ts` | interactive setup role/peer/secret prompts, share model selection + invalid selection, share publish/name/contact, approve confirmation, connect peer/model selection and TTY TOFU acceptance |
| `plugin/test/catalog-service.test.ts` | existing request calls now provide the accepted fingerprint/quote; new strict-acceptance test |

**VERIFIED here:** the targeted suites pass (phase-8 service 9, phase-8 CLI 25, prompt journeys 7,
catalogue 17, existing service suite 40 = 98 tests, 0 failures). The interactive tests use the real
journey functions with a scripted `WizardIO`, so they assert prompt order and the JSON sent to the
host; they do not need a PTY. `bun run typecheck` passes for the whole tree, including `bin/`, the
new operator modules, `src/service.ts` and the statement/evidence methods.

**Routes (security agent, `server.ts`):** `GET /share/candidates`, `POST /providers/models`, the
optional `id` on `POST /providers/reconcile`, acceptance fields on `/catalog/request` and
`/catalog/connect`, and the wallet `GET /wallet/evidence` / `GET /wallet/statement` reads are present
and token-protected. The CLI journeys use a fake host for deterministic request-shape and
secret-handling checks; the security journey suite covers the real handler.

`bun run ci` was run at the end: typecheck PASS, **573 tests pass / 0 fail across 35 files**,
boot-check PASS (stub Magpie 0.1.2038, plugin 0.4.0) and secret-scan PASS. The complete log is
`/tmp/phase8-final-ci.log`; environment: macOS 26.6.2 arm64, Bun 1.4.3, Node v24.21.0, installed
Magpie 0.1.2171 (the boot fixture is 0.1.2038), branch `feature/mvp-onboarding-operator-ux` at
`bf7a27d` plus the uncommitted Phase-8 tree. `git diff --check` exited 0.

**Live two-configuration lab (owner: the lab agent, not this note):** 18/18 steps pass on the frozen
tree with two real Magpie 0.1.2038 nodes and EasyTier 2.6.4, including `share approve`, exact
fingerprint trust, `remote test/models`, and an unsigned named-consumer statement (0600, digest
`1e72d3f3…`). Source manifest: 13 files, `ok:true`, all node copies identical and unchanged since
copy, and byte-identical to the repo at report time. Evidence:
`docs/validation/phase8-live/lab-report.json`, `transcript.log`, `source-manifest.json`,
`wallet-statement.json`, `cleanup.json`, and `docs/validation/2026-10-30-phase8-live-lab.md`.

**Still UNKNOWN / not claimed:** a real Magpie 0.1.2120/0.1.2154 host/CLI run (the lab used the
0.1.2038 pin), a real vendor model call through the overlay (the lab upstream was a deterministic
mock), and real funds/mainnet. One operational observation for follow-up, not a product change:
`magpie plugin add` can exit non-zero after its host logs a startup error even though `plugins.json`
already records the spec.
