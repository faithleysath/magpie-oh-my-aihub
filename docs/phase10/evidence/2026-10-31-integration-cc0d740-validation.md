# Integration HEAD cc0d740 — combined software validation

- **Object**: `<integration-worktree>` @ `cc0d740876e5a667f1789e1ae3b4966ecf8cef9f` (branch `feature/phase10-integration`), read-only; no file was modified there (`git status --porcelain` empty before and after).
- **Method**: `git archive HEAD` snapshot, extracted to a private temp dir. Source tar sha256
  `4c45d1ea233fc162c74f5369f2918535bac00970fbc3fdeaa3e08a8e3593eb3f` (389 files). The extracted tree was deleted after the run; the tar is kept for audit.
- **Platform**: macOS 26.6.2 (25G83), Darwin 25.6.0, arm64; bun 1.4.3; `net.inet.ip.portrange` = 49152–65535 (16 384 ports).
- **Scope**: combined software checks only. No Magpie, EasyTier or P0 experiment was started; this is not a product GO.

## Included sources (content-verified)

The integration branch is a rebuilt/cherry-picked tree, so the original PR head
SHAs are **not ancestors**; inclusion was verified by content markers instead.

| source | marker found | status |
| --- | --- | --- |
| #15 `889973f…` clock | `ConsoleWallet(..., private now = Date.now)` | present |
| #29 `0093279…` expiry regressions | test `the read-back window is 60 s of the console clock` | present |
| #17 `49e8c0f…` guard | `plugin/bunfig.toml`, `network-guard.ts`, `child-network-spy.ts`, `resumeOrCheck(..., { checkOnly, deps })`, in-process check/resume test | present |
| #16 `0661bede…` peak guard | `pricing.ts` `UnsupportedPriceReason = "peak" \| "rate-window" \| "tier-limit"`; `pricing.test.ts` refuses peak/rate-window | present |
| #18 `5f7717…` app pin | `MEASURED_APP_BINARIES` with 0.1.2289 Darwin/arm64 hash | present |
| #27 `3b55491…` evidence | `docs/validation/lab/phase10/2026-10-31-p0b-sanitized-cleanup-proof.json`, sha256 `f4fbcef7863bc1d50283f5bc911017802208bdc289be0bbe9b58e197a4566fe3` | present |
| #31 `659d8b3…` dynamic ports | `service.test.ts`: `port: 0`, `FORWARD_PORT_FROM`, `afterAll(async …)` | present |
| #24 `ed60ce1…` windows subset | `.github/workflows/windows.yml` (`windows-latest`, curated loopback subset) | present |
| #25 `b1a4838…` five-page UI | five-page shell commit content in `plugin/console` | present |
| #30 `ae596c3…` external wallet adapter | external wallet adapter commits/content | present |
| #20, #21, #22, #23, #26 | no `p2p`/`control`/`vault` modules; no new mainnet gate module; per orchestrator not integrated | absent |

## Commands and results (serial)

| step | command | result |
| --- | --- | --- |
| frozen install | `bun install --frozen-lockfile` (plugin/) | exit 0, 8 packages |
| typecheck | `bun run typecheck` | **exit 0** (log `typecheck.log`) |
| full test, run 1 | `bun run test` (guard preloaded by `bunfig.toml`) | **845 pass / 8 fail** in 27.0 s — see below |
| full test, run 2 (after epilogue) | `bun run test` | **853 pass / 0 fail** in 24.1 s (log `test-run2.log`) |
| boot-check | `bun run boot-check` | **PASS** (log `bootcheck.log`) |
| secret-scan | `bun run secret-scan` | **PASS** (log `secscan.log`) |

### Run 1 failures: exact tests

All eight failed with `EADDRNOTAVAIL` on a loopback connect to a freshly bound
**ephemeral-range** port; none is an assertion or product-code difference:

- `test/console-security.test.ts`: `body bounds and real loopback listener > real server binds127, serves static and cookie state, no CLI route or bearer access`
- `test/phase8-prompt-journey.test.ts` ×3 (`connect lists peers…`, `connect shows a first-seen quote…`, `share approve shows the full request…`) — `cannot reach the plugin host on 127.0.0.1:63081/63082: EADDRNOTAVAIL`
- `docs/validation/lab/phase9/wallet-fixture/fixture.test.ts` ×4 — `eth_chainId failed … http://127.0.0.1:61068/rpc/97: EADDRNOTAVAIL`

### Attribution (isolation vs product)

- At that moment the host had **16 244 `TIME_WAIT` sockets against a 16 384-port ephemeral range**; `connect()` therefore failed to assign a local port (`EADDRNOTAVAIL`). The failures are exactly the tests that connect to servers bound in that range.
- Each failing file passes alone immediately afterwards: `console-security` 32/32, `phase8-prompt-journey` 8/8, wallet fixture 11/11.
- Run 2, started after the transient count fell to 178, is **853/0**.
- Classification: **test-environment / loopback socket churn (macOS ephemeral exhaustion), not a product diff**. Both runs are reported; run 2 was only to test the environmental hypothesis, not to hide run 1. This is a real full-suite reliability hazard under concurrent loops (it also explains the earlier one-off `boot-check: EADDRNOTAVAIL`), and belongs to test isolation work, not to this validation.

## Network discipline during the run

- Guard is installed by default for `bun run test` (`plugin/bunfig.toml` preloads `test/support/network-guard.ts`); its self-tests pass inside the full run, including “3425 is refused”, “LAN address refused”, “public RPC refused”.
- Guard scope (as documented): `globalThis.fetch` + `Bun.serve` in the test process only. It is **not** a full network sandbox; socket/subprocess paths use their own controlled endpoints, and the child CLI tests use `child-network-spy.ts` with an exact-origin allowlist.
- No test read the user Magpie (`:3425`) or a public RPC endpoint: an unexpected attempt would be refused and fail the test, and the full run’s only external failures are the kernel `EADDRNOTAVAIL` above.
- No socket/subprocess was pointed at production; no user process was killed.

## Independent gitleaks (not a GO signal)

`gitleaks 8.30.1 dir .` on the snapshot: **116 findings**, all classified as known fixtures/public values (values not printed):

- `generic-api-key` ×115: 113 in `docs/validation/**` (public `tokenContract`/`token` hashes across 32 evidence files, e.g. phase7 two-host events), 2 in `plugin/test/wallet-view.test.ts` lines 130/167 (fixture literals).
- `curl-auth-header` ×1: `prototype/phase0/README.md:27` — archived tutorial placeholder (`sk-magpie-key-for-consumer`), non-product.
- Summary: `gitleaks-summary.json`; no real credential identified.
- **#28 status correction**: #28 exact `10ca2e7ceb2361aea3142c9c22aaf005cdceee5c` has independently PASSed and was approved by the main review, integrated into next `87a72c69a3df74b29a7688b90e8fcd2721b11658`. cc0 itself does not contain #28, so this scan did not use its rules — that is a **scope fact**, not an approval status.
- The 116 raw findings above are a **scope signal only**. The next integration applies narrow rules and reports a worktree scan of zero; the two results must not be mixed. Pack/security on next was independently verified; no full-history scan was performed here, and none is needed for this unit.

## Evidence, ports and cleanup

- Evidence dir: `<private-evidence-dir>` (files 0600): `typecheck.log`, `test.log`, `test-run2.log`, `bootcheck.log`, `secscan.log`, `gitleaks-summary.json`, `logs.sha256`, `source.sha256`. Logs contain no `sk-…`, `network_secret` or ticket patterns (grep count 0).
- Log hashes: `test.log e21b7ece…`, `test-run2.log 7adc9584…`, `typecheck.log b1e4adac…`, `bootcheck.log 515f7b33…`, `secscan.log a96983f7…`, `gitleaks-summary.json bc2a1eb3…`.
- Ports/processes: no process from the snapshot remained after the runs (`ps` filtered on the snapshot path = empty); 31 listeners were present at the end and none belongs to this validation (checked by process path/owner); `TIME_WAIT` fell from 16 244 to 163 within ~20 s and was 365 at the end.
- The extracted snapshot tree was removed; the immutable tar remains with the hash above.

## Verdict

- The integrated tree passes frozen install, typecheck, boot-check, secret-scan, and a full guarded test run (**853/0**) once the host’s ephemeral-port table is not exhausted.
- Run 1’s 8 failures are an environment-level loopback exhaustion (`TIME_WAIT` 16 244/16 384), reproducible as `EADDRNOTAVAIL` only under that pressure, and each affected file passes standalone; no product-code regression is attributed to cc0d740.
- **Not a product GO.** No Magpie/EasyTier/P0 run, no real funds, no wallet/mainnet action. The ephemeral-port hazard remains a separate test-isolation item. #28's pack/security rules are approved and integrated in next `87a72c69…`, not in cc0, and were not used here.
