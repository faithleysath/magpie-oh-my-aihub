# Phase 10 — final handoff (2026-10-31)

Read [`REPORT.md`](REPORT.md) first; this is only the next-session shortcut.

## State

- Branch `feature/phase10-final-acceptance`; functional head `10a3644`; PR
  **#51** (draft) → `feature/phase10-wallet-closure` (#50).
- #50 was retargeted to `feature/phase10-p2p-closure` (#49); #49 stays → `main`.
  Nothing is merged. #14–#48 remain open drafts (history; not closed to avoid
  losing evidence).
- Local gates: typecheck PASS, 1405 tests / 0 fail, secret-scan PASS, boot-check
  PASS. CI result is on PR #51.

## What was proven on real Magpie 0.1.2289 + EasyTier 2.6.4 (one host/LAN)

Three-field join, one explicit share, TOFU, zero-file request, human approval
($0.05 cap), encrypted key delivery, native Remote read-back, 200×5 / 429,
revocation. Evidence in `evidence/`; verdicts in `REPORT.md` §0.

## The one thing to fix first

**F11:** a runtime-added control forward lives only in the Service instance's
memory. Magpie's short-lived plugin-host probes do not expect it, their safety
check stops the shared `easytier-core` about every 64 s, control sessions time
out, and the zero-file payment cannot complete. See
`evidence/runtime-restart-loop.log` and `REPORT.md` §3.4.

Suggested fix: persist the owned control-forward set in the node state (and load
it at Service construction), or make a non-owner Service instance never stop an
adopted core. Then re-run the two-node payment end-to-end (anvil 84532 + mock
ERC-20, no real funds) and re-run the visual matrix at the final commit.

## Also open

- Revocation is terminal for a consumer id (no reactivation path); document or
  implement an explicit new-generation flow.
- Transient overlay hostname/node-id mismatch (F12) — root cause unknown.
- Windows: `test/provisioner.test.ts` excluded, executed floor 360 (comment says
  380).
- External wallets: real MetaMask/Rabby announce EIP-6963 (evidence
  `external-wallet-eip6963.json`), product connect/network/EIP-712 not completed.
- Copy fix `10a3644` needs a visual re-check and re-shoot.

## Never do

No real funds, no mainnet send/credit/auto-recharge, no real wallet secrets, no
upstream Magpie/EasyTier edits, no user Magpie profile/port 3425, no central
server or second gateway.
