# Independent secret and package gates (Phase 10)

Two gates added outside `plugin.yml`, both run on GitHub-hosted Linux with
gitleaks **8.30.1** downloaded from the pinned release and verified against a
pinned SHA-256 (`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`).

## CI evidence

| item | value | label |
| --- | --- | --- |
| workflow | `.github/workflows/security-gates.yml` | VERIFIED |
| prior audit run | `41159927918` https://github.com/faithleysath/magpie-oh-my-aihub/actions/runs/41159927918 | VERIFIED |
| prior audit head | `010c40cb71cb` (before the token/trigger fix) | VERIFIED |
| fixed-head run | linked in the PR comment for this revision; this page is committed before that run | — |
| `secrets (working tree)` | success | VERIFIED |
| `secrets (git history)` | success | VERIFIED |
| `package contents` | success | VERIFIED |

The jobs fail closed: a missing report, a nonzero gitleaks exit, a forbidden
tarball entry or a missing static asset fails the run. There is no
`continue-on-error`.

## Secret scan policy

- `.gitleaks.toml` extends the default rules and adds **only finding-level
  `match` / `line` rules**. Global allowlists with `paths` are deliberately
  avoided: gitleaks treats those as whole-file skips for every rule (observed
  with 8.30.1 debug logs), which would hide a real secret in an evidence
  manifest. Old approach (rejected): allowlist `docs/validation/**`.
- The workflow has **no path filter**: every PR and every push to `main` runs
  the worktree, history and package jobs, so a `docs/**` or `prototype/**`-only
  change cannot skip the gate.
- Allowlisted shapes, each labelled in the config:
  1. `token` / `tokenContract` + `0x` + exactly 40 hex, matched **per finding**
     with `regexTarget = "match"` and an RE2 boundary
     (`(?:[^0-9a-fA-F]|$)`); a 64-hex key in the field is reported, and a
     `privateKey` on the same line is a separate finding and is reported.
  2. Evidence digest lines whose key is exactly `plugin/src/console-api.ts` or
     `auth-responses.json` and whose value is 64 hex.
  3. One lab line that deliberately sends a wrong Gateway Key.
  4. The phase-0 README documented curl placeholder line.
  5. Historical `mergeSaved(... networkSecret:)` line (history only).
- `.gitleaksignore` carries commit+file+rule+line fingerprints, never secret
  content:
  - two for the **published BIP-39 "abandon … about" test vector** on an
    unmerged wallet-vault branch (file not in `main`);
  - one for a synthetic fault-injection key in `plugin/test/p2p-node.test.ts`
    on an unmerged protocol test branch (test data, not a credential). Other
    lines/commits in that file still report; the fixture should be renamed to a
    non-secret shape before that branch merges.

## Self-test (not vacuous)

`plugin/scripts/gitleaks-selftest.ts` generates everything at runtime and plants:

- real-looking `sk-…` keys in `docs/validation/…` and in production-like
  `plugin/` paths;
- a synthetic PEM private key;
- a `network_secret` value;
- a 64-hex `privateKey` value;
- a 32-byte key written into a `tokenContract` field (must report);
- a legitimate 40-hex token and a 64-hex `privateKey` on the same line (the
  `privateKey` finding must remain; the test asserts its `Match` contains
  `privateKey`, not just the file:line);
- a non-allowlisted line inside `plugin/test/page-settings.test.ts`;
- a secret in a worktree copy of the ignored `wallet-vault.test.ts` path;
- a non-allowlisted manifest digest line and a curl token on a different line.

Expected: **12 findings**. It also checks that EVM addresses and the reviewed
manifest digest line stay quiet, and that line/match rules do not hide a secret
on another line of the same file. Local result: `PASS: 12 synthetic secrets
reported, public fixtures quiet, rules stay scoped`.

## Package-content gate

`plugin/scripts/pack-check.ts` packs **both** entry points (repo root, which is
the Magpie install entry, and `plugin/`) and:

- rejects `*.test.*`, `test/`, `lab/`, `docs/`, `node_modules/`, generated
  `page/status|options|launcher.js`, `.env/.pem/.key/.log`, keystore/mnemonic
  names and nested archives;
- requires every tracked runtime file under `plugin/page` and `plugin/console`
  to be present (new UI assets cannot be dropped silently);
- runs gitleaks on the extracted tarball;
- compares the packed root manifest with the packed `plugin/package.json`: every
  plugin runtime dependency must also be declared at the root. When dependencies
  exist, it performs a clean `bun install --production --ignore-scripts` and
  resolves each one with `Bun.resolveSync`.

The workflow invokes `bun run scripts/pack-check.ts --selftest` explicitly, so
the forbidden-entry, missing-static-asset and missing-root-dependency negative
cases run in CI (the flag is not implicit). Current branch result: root 62
files / 340.3 KiB, plugin 60 files / 337.5 KiB, no tests/docs/secrets, static
assets complete. `files` in both manifests gains a
negated test pattern (`!console/*.test.js` / `!plugin/console/*.test.js`);
Bun 1.4.3 and npm both honor it, and no directory whitelist is hard-coded.

### Dependency finding (reported to PR #23)

PR #23 head `1a8a53d` adds `ethers@6.17.0` only to `plugin/package.json` and
`plugin/bun.lock`. **REPRODUCED** in a clean temp dir: root pack → extract →
`bun install --ignore-scripts` reports "No packages!" → importing
`plugin/src/wallet-vault.ts` fails with
`Cannot find package 'ethers'`. The `plugin/` tarball installs and imports fine.
Adding `ethers` to the root `dependencies` fixes the clean root install. The
Magpie host-side install behavior itself remains **UNKNOWN** (no real Magpie
install executed); the pack/npm resolution failure is REPRODUCED.

## Limitations / UNKNOWN

- gitleaks scans text; secrets embedded in binaries/images are out of scope.
- History scan runs over all branches fetched by the workflow; an unpushed local
  commit is not covered.
- The line allowlists are field-shaped. A new evidence field name will fail the
  scan until reviewed; that is intentional (fail closed).
- History findings are only reported by file/commit/fingerprint, never content.
- The dependency clean-install check only runs when `plugin/package.json`
  declares runtime dependencies; it does not install the root **dev**
  dependencies or exercise Magpie.
- Real Magpie/EasyTier runtime, mainnet and real funds remain out of scope.

## Reproduce

```sh
gh run view 41159927918 --log

gitleaks version   # 8.30.1
gitleaks dir . --config .gitleaks.toml --redact --no-banner --exit-code 1
git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'
gitleaks git . --config .gitleaks.toml --redact --no-banner --exit-code 1

cd plugin
bun run scripts/gitleaks-selftest.ts
bun run scripts/pack-check.ts
```
