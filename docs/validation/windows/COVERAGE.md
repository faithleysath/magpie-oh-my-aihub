# Windows CI coverage (Phase 10)

Status: **PARTIAL / fail-closed, not a Windows support claim.**
This page records what the new `windows` workflow actually proves, with the
run ID and head SHA. It does not replace a real Magpie 0.1.2289 + EasyTier 2.6.4
test on Windows.

## CI evidence (real Windows runner)

| item | value | label |
| --- | --- | --- |
| workflow | `.github/workflows/windows.yml` (`windows`) | VERIFIED |
| run | `41159690290` https://github.com/faithleysath/magpie-oh-my-aihub/actions/runs/41159690290 | VERIFIED |
| head | `55ea3f3c911208f38d6d3e6938e40a1a2bb81715` (this file is a docs-only commit after it) | VERIFIED |
| runner | GitHub-hosted `windows-2025-vs2026`, Microsoft Windows Server 2025, x64 | VERIFIED |
| runtime | Bun 1.4.3, `process.platform = win32` (asserted in-job) | VERIFIED |
| install | `bun install --frozen-lockfile` | VERIFIED |
| typecheck | `bun run typecheck` | VERIFIED |
| tests | 22 files, 389 tests: **385 executed, 4 reviewed skips, 0 failures, 3551 assertions** | REPRODUCED (job log + artifact) |
| artifacts | `windows-test-summary.md`, `windows-platform-report.md` | VERIFIED |
| local baseline | macOS 26.6.2 arm64, same subset: 389 executed / 0 failed (skips are win32-only) | REPRODUCED |

The job fails if the report is missing, if fewer than 380 tests execute, if any
test fails, if the file count differs, or if an unreviewed skip appears
(`plugin/scripts/run-windows-subset.ts`). No `continue-on-error` is used.

Bun 1.4.3 on win32 did not write a JUnit file with
`--reporter=junit --reporter-outfile=...` (runs `41159217309`, `41159363198`),
so the gate now parses Bun's console summary instead and keeps an explicit
allowlist of the four reviewed skips.

## Covered (loopback only, no production network)

`plugin/scripts/offline-guard.ts` preload blocks the real Magpie gateway
(`:3425`) and every non-loopback `fetch`. Fixture servers bind `127.0.0.1`.

- **Schema / registry / ACL:** `test/networks.test.ts`, `test/acl.test.ts`
- **Pricing / ledger / state:** `test/pricing.test.ts`, `test/ledger.test.ts`,
  `test/state.test.ts`, `test/wallet-view.test.ts`
- **Crypto / intents:** `test/keccak-eip712.test.ts`, `test/deposits.test.ts`
- **Catalog / provisioner / watcher (in-memory fakes):**
  `test/catalog.test.ts`, `test/catalog-service.test.ts`,
  `test/provisioner.test.ts`, `test/provisioner-ledger.test.ts`,
  `test/chain-credit.test.ts`, `test/watcher.test.ts`
- **Console boundary / security / launch argv:**
  `test/console-api.test.ts`, `test/console-security.test.ts`,
  `test/console-launch.test.ts`, `console/providers.test.js`,
  `console/session.test.js`, `console/wallet.test.js`
- **Path resolution (pure injection):** `test/paths.test.ts`
- **Runtime smoke (new):** `test/platform-runtime.test.ts` starts a real
  `Bun.serve` HTTP server on `127.0.0.1:0` (GET + JSON POST echo) and a real raw
  TCP socket echo, then closes both. This is Bun's loopback HTTP/socket path on
  Windows, not a mock.

`test/console-api.test.ts` now uses `os.tmpdir()` instead of a hard-coded
`/tmp/...` fixture path (test-only change; no product code).

## Reviewed skips (the only four)

These are **gaps, not passes**. Two additional tests are environment-conditional
on any runner (`finds an existing magpie on this host`).

1. `resolveMagpieBin — the real machine > finds an existing magpie on this host`
   — no Magpie is installed on the runner.
2. `resolveMagpieBin — no silent fallback ... > a relative parent path is
   resolved against the parent's own cwd` — the resolver uses the host
   `node:path` module, so POSIX parent paths cannot be simulated on win32
   (`src/paths.ts`).
3. `explicit browser pairing > real handler only creates a new instance session
   after explicit approval survives host restart` — durable pairing journal.
4. `single owner browser launch journal > browser pairing survives official
   approval restart ...` — same journal.

## Product gaps found on win32 (fail-closed)

| capability | result | evidence (source) |
| --- | --- | --- |
| EasyTier listener ownership | FAIL-CLOSED | `rpcListeners()` runs `ss`; missing on win32 -> throws, supervisor reports "cannot be verified" (`src/easytier.ts`) |
| EasyTier process ownership | FAIL-CLOSED | `ownsProcess()` shells out to `ps`; win32 returns false, so no adoption after restart (`src/easytier.ts`) |
| Magpie binary discovery | FAIL-CLOSED | `ps`/`lsof`/`which`; win32 requires `OH_MY_AIHUB_MAGPIE`, otherwise throws (`src/paths.ts`) |
| console auto-open | FAIL-CLOSED | `nativeDesktopParent()` hard-codes false on win32; the `rundll32` argv branch is unit-tested but not reachable automatically (`src/console-launch.ts`) |
| durable browser pairing | FAIL-CLOSED | journal opens the directory for `fsync`; win32 refuses -> `/ui/pairing` returns 503 (`src/console-pairing.ts`) |
| EasyTier win32 release pin | VERIFIED | `assetFor("win32","x64")` returns the pinned 2.6.4 zip + SHA-256 (`src/easytier-manifest.ts`) |
| zip extraction prerequisite | VERIFIED | `bsdtar 3.8.9` is present on the runner; EasyTier itself is **not** downloaded or run |

## Not covered

- Real EasyTier 2.6.4 core: no-TUN overlay, RPC/SOCKS listeners, process
  adoption after restart, ACL enforcement on a live core.
- Real Magpie 0.1.2289: Gateway Key enforcement, pricing/peak, remote journeys.
- Windows desktop auto-launch and the durable pairing journal (both refused).
- POSIX 0600/0700 semantics and shell-script fixtures (not exercised).
- The full `bun run test` suite. In particular the wallet clock-bomb tests fail
  on main independent of this PR (see below).

## Unrelated known failure on this branch

The existing `plugin (linux/macos)` job (`41159690285`) fails the same five
wallet tests documented in `/tmp/oma-research/VALIDATION-PREP.md` §5: the
fixture clock is fixed at `2026-10-30T12:00Z` while `ConsoleWallet` uses the wall
clock. PR #15 (`fix/phase10-validation-clock`) addresses it; it is not part of
this PR and was not merged here. The Windows subset excludes the clock-bomb file
and does not claim the full suite passes.

## Reproduce

```sh
# real Windows (GitHub): push a change under plugin/ and open a PR
gh run view 41159690290 --log
gh run download 41159690290   # windows-test-summary.md + windows-platform-report.md

# local (macOS/Linux): same subset, skips stay off
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun test --preload ./scripts/offline-guard.ts test/acl.test.ts test/networks.test.ts \
  test/pricing.test.ts test/state.test.ts test/paths.test.ts test/keccak-eip712.test.ts \
  test/deposits.test.ts test/ledger.test.ts test/wallet-view.test.ts test/catalog.test.ts \
  test/catalog-service.test.ts test/provisioner.test.ts test/provisioner-ledger.test.ts \
  test/chain-credit.test.ts test/watcher.test.ts test/console-api.test.ts \
  test/console-security.test.ts test/console-launch.test.ts test/platform-runtime.test.ts \
  console/providers.test.js console/session.test.js console/wallet.test.js
```
