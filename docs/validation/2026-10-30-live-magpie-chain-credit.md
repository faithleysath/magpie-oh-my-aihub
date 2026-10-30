# Real testnet → real Ledger → real Magpie credit replay

## Result and boundaries

**VERIFIED** on macOS: the two existing finalized public-testnet payments were replayed, using their original pre-payment intents, into a fresh isolated SQLite Ledger and the real pinned Magpie binary. The same Gateway Key was raised from `0.0001` to `1.0001` to `2.0001` test USD, with native read-back. Actual gateway responses were **200 → 429 → BSC credit → 200 → 429 → Base credit → 200**. Each chain's rescan added zero credits and left the native cap unchanged.

This is **not** a fresh live payment initiated after consumer provisioning, **not** a new cross-host EasyTier run, and **not** a paid vendor model call. The upstream was a deterministic local mock returning token usage. The real Magpie gateway performed authentication, routing, accounting and rejection. Mainnet/real funds remain **NO-GO**.

## Exact platform, versions and source

| Item | Verified identity |
| --- | --- |
| Platform | macOS 26.6.2 (25G83), Darwin arm64 |
| Bun | 1.4.3 |
| Portable Magpie used | 0.1.2038, Go module `github.com/yetone/magpie v0.1.2038` |
| Binary VCS revision | `8c63c5b7873c6aa7aa797aa17f481d5fa8301876`, `vcs.modified=false` |
| Binary SHA-256 | `0640889d004edfc1da0cd12bf8995e134968ea9b8ac4887d295d8989dadd4e15` |
| Current installed Magpie | 0.1.2120, read from `/Applications/magpie.app/Contents/Info.plist`; **not used or modified** |
| Foundry signing tool | 1.8.6, commit `6bad0a66de7c83f7b33695044138f0f5fa4c5990` |
| Plugin base | `3165ac9`, including PR #9; follow-up branch `test/live-magpie-chain-credit` |

Version commands:

```sh
plutil -extract CFBundleShortVersionString raw "$LAB/Magpie.app/Contents/Info.plist"
go version -m "$LAB/Magpie.app/Contents/MacOS/magpie"
mise which cast
mise x foundry -- cast --version
```

The pinned source checkout at `/tmp/magpie-src` was clean and at the exact binary revision. Source inspected:

- [Portable data selection](https://github.com/yetone/magpie/blob/8c63c5b7873c6aa7aa797aa17f481d5fa8301876/internal/appdir/appdir.go): `Resolve`, `.portable`, a copied bundle and its adjacent `data/` isolate the app from the installed configuration.
- [Remote-key classification](https://github.com/yetone/magpie/blob/8c63c5b7873c6aa7aa797aa17f481d5fa8301876/internal/gateway/lan.go#L634-L665): `local`/`proxied`; forwarding headers disable the loopback trust bypass unless `MAGPIE_TRUST_PROXY` is enabled.
- [Native budget reservation](https://github.com/yetone/magpie/blob/8c63c5b7873c6aa7aa797aa17f481d5fa8301876/internal/budget/budget.go#L337-L410): rejects when used+held reaches the cap, then estimates reservations. This lab spends the cap exactly before expecting 429; it does **not** assume an oversized request is always rejected in advance.
- [Native usage log](https://github.com/yetone/magpie/blob/8c63c5b7873c6aa7aa797aa17f481d5fa8301876/internal/usage/usage.go): `callerKeyId` and token usage written by the gateway, then imported by the existing Ledger.

EasyTier 2.6.4 is not run or changed by this task. Prior no-TUN/ACL/two-host evidence remains separate in `2026-10-29-acl-fix-and-two-host.md`; it is not claimed as freshly repeated here.

## Isolation and ingress — VERIFIED

Created a private `/tmp/phase7-live-magpie-*` lab with a copied **pinned portable** bundle, empty data, separate HOME, account discovery disabled, and **only** a localhost mock provider. The user's currently installed app/configuration was not reused.

```text
local client + forwarding header
    -> 127.0.0.1:3447 (real Magpie, remote-key branch)
    -> 127.0.0.1:19081 (non-billable deterministic mock)

public BSC/Base RPC (read only)
    -> production Wallet/ChainWatcher -> SQLite Ledger
    -> production Provisioner -> Magpie CLI -> native limit read-back
```

`lsof` confirmed both listeners were loopback-only. No `magpie web`, admin interface, VPN membership, vendor credential or public listener was introduced. Missing key and wrong key both returned **401** before the funded probe.

## Original payment attribution, not fabricated invoices — VERIFIED replay

The original intent fields were loaded from the preceding runs' temporary ChainStore databases. Consumer/provider, invoice, nonce, raw amount, rate, timestamps and digest were preserved. The original disposable consumer re-signed the **same** EIP-712 document; its digest was checked against the original persisted digest. Signature verification and `Wallet.signIntent()` ran normally; the original expiry was not changed and remained valid at execution time.

Only claim state in the **fresh local replay database** was reset to unsigned before verification. The source databases were not edited, and neither payment was sent again. A 20,000-block initial lookback covered the historical payments. Current receipt/canonical-block/finality checks were real RPC reads with real time.

This explicitly does not claim the Gateway Key existed when these original transfers were mined.

### Payments

| Chain | Existing finalized payment | Raw amount / precision |
| --- | --- | --- |
| BSC testnet 97 | [0x52a600…b9879](https://testnet.bscscan.com/tx/0x52a600d99c3f2578d01c303044439110400a46e07769a30bec0531c48f6b9879) | `1000000` / 6 |
| Base Sepolia 84532 | [0x6c192c…0abe9](https://sepolia.basescan.org/tx/0x6c192c2aed807871e962f4655860e5f5eda2d6a9eff32e81de04612b01a0abe9) | `1000000000000000000` / 18 |

Both are exactly one mock token at the recorded fixed test rate; each creates a separate **1,000,000,000 nano-USD** ledger deposit. These are not real USDC balances.

## Measured sequence — VERIFIED

Successful consolidated run: `2026-10-30T04:40:10Z`–`04:40:27Z`, process exit 0.

| Step | Native cap | Native used | HTTP / outcome |
| --- | ---: | ---: | --- |
| Provision a model-whitelisted key with explicit simulated opening credit | 0.0001 | 0 | held key, 3650-day cycle |
| Spend 100 input tokens at $1 per million | 0.0001 | 0.0001 | **200**, mock content `lab` |
| Request after opening credit spent | 0.0001 | 0.0001 | **429**, native `Retry-After` and reset headers |
| Scan original finalized BSC payment | 1.0001 | 0.0001 | one SQLite deposit applied, same key ID/secret |
| Rescan BSC | 1.0001 | 0.0001 | zero new credits, cap unchanged |
| Spend 1,000,000 input tokens | 1.0001 | 1.0001 | **200**, exactly 1 test USD consumed |
| Request after BSC credit spent | 1.0001 | 1.0001 | **429**, not 401 and not synthetic refusal |
| Scan original finalized Base payment | 2.0001 | 1.0001 | second SQLite deposit applied, same key ID/secret |
| Rescan Base | 2.0001 | 1.0001 | zero new credits, cap unchanged |
| Request 1000 input + 100 output tokens | 2.0001 | 1.0013 | **200**, service restored |

Final durable balance: deposited **2.0001**, consumed **1.0013**, remaining **0.9988 test USD**. No pending application, paused state or usage uncertainty was reported. The ledger database was closed and reopened separately: exactly three applied deposits were present (one explicit opening deposit and two distinct chain deposits); exactly three priced consumption rows totalled 1.0013 test USD.

Each active-chain scan succeeded while the other chain's configured endpoint was a closed loopback port. This verifies per-chain manual-scan independence; it does not measure scheduled outage latency.

## Raw evidence and reproduction

- `phase7-live-magpie-report.json`: full sanitized gateway bodies/headers, scan results, original-intent digests, chain events, durable ledger deposits and native limit read-backs.
- `phase7-live-magpie.log`: successful run output, no keys or signatures.
- `phase7-live-magpie-audit.json`: binary hash, separately reopened SQLite rows, cleanup checks and failed-attempt descriptions.
- Original public chain receipts: `phase7-testnet-handoff-receipts.json`, `phase7-testnet-base-finality.json`.
- Harness and exact setup: [`lab/phase7/README.md`](lab/phase7/README.md), [`lab/phase7/live-credit.ts`](lab/phase7/live-credit.ts).

No production modules were modified. The harness is included in TypeScript checking and its path triggers PR CI. CI does not rerun a wallet lab or expose credentials.

## Failures preserved rather than called a pass — REPRODUCED

1. The first attempt reached a real 200/429 but timed out invoking `mise` after HOME isolation. It made no chain writes or chain credit and removed the lab key. Using the absolute, version-checked Foundry binary fixed the harness environment.
2. The second attempt signed correctly but the new store's 5-block lookback missed a 38-minute-old payment. `rewindCursor()` on an unscanned store does not constitute a completed scan and is deliberately not returned by `cursor()`. The lab now sets an explicit historical lookback, without editing production cursor semantics or inventing a successful scan. That attempt credited nothing and removed its key.
3. The third run completed the whole measured sequence. The first two isolated plugin-state directories/reports remain in the private temporary lab for diagnosis; their errors are not erased from the report.

## Cleanup / validation / remaining UNKNOWN

- VERIFIED: consumer's native key revoked in `finally`, no `ohmyaihub-lab-consumer` key remains.
- VERIFIED: only the owned portable gateway and mock-upstream processes stopped; ports **3447/19081 free**.
- VERIFIED: throwaway wallet keys remain outside the repository, no new chain writes or test-coin spending.
- VERIFIED: **392 tests, 0 failures, 1438 assertions, 25 files**; local full `bun run ci`, harness strict typecheck, boot-check, secret-scan and `git diff --check` pass.
- UNKNOWN: this new follow-up's Linux/macOS GitHub run until attached checks complete.
- UNKNOWN: one fresh experiment combining newly initiated payments, original EasyTier no-TUN/two-host ingress and a real vendor/model execution. This run closes the narrower real-Magpie credit integration gap, not those additional claims.
- Mainnet and real funds remain **NO-GO**: Magpie price-lock/detection gaps, cap soft-ceiling/in-flight risks, RPC trust and chain-specific finality limits are unchanged.
