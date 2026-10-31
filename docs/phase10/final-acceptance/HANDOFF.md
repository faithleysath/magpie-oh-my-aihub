# Phase 10 — final handoff (2026-10-31)

Read [`REPORT.md`](REPORT.md) first; this is only the next-session shortcut.

## State

- Branch `feature/phase10-final-acceptance`; rework functional head `340c378` (docs/CI at `d7ee008`);
  PR **#51** (draft) → `feature/phase10-wallet-closure` (#50).
- #50 was retargeted to `feature/phase10-p2p-closure` (#49); #49 stays → `main`.
  Nothing is merged. #14–#48 remain open drafts (history; not closed to avoid
  losing evidence).
- Local gates: typecheck PASS, 1405 tests / 0 fail, secret-scan PASS, boot-check
  PASS. CI result is on PR #51.

## What was proven on real Magpie 0.1.2289 + EasyTier 2.6.4 (one host/LAN)

Three-field join, one explicit share, TOFU, zero-file request, human approval
($0.05 cap), encrypted key delivery, native Remote read-back, 200×5 / 429,
revocation. Evidence in `evidence/`; verdicts in `REPORT.md` §0.

## Current state (rework)

**F11 fixed:** the restart was `discover()` retiring/re-adding the control
forward on every presence refresh near its TTL (EasyTier 2.6.4 cannot close a
live forward, so each retire restarted the core). The forward is reused while
the signed endpoint is unchanged, the owned set is persisted across hosts, and
non-owner Service/supervisor instances cannot start/adopt/restart/stop the core.
Two 5-minute runs: `deltaP=0 deltaC=0` (`evidence/stability-5min-run*.txt`).

**Payment reproduced end-to-end** on real Magpie/ET + isolated anvil 84532:
request → terms → EIP-712 → preview → broadcast →
`0x185f0d451063f26b72c628288a69470e1bb708d867b83c7f87121a0ecbedf336` →
watcher/finality → one ledger deposit → cap `$0.05→$1.55` → 已到账; restart does
not double-credit. Evidence `evidence/payment/`.

**Re-approval after revoke:** implemented + unit-tested (new key, one active,
append-only ledger, price version). Real provider-side issuance works; the B key
delivery after re-approval hits a stale-session HTTP 410 (open transport bug).

## Still open

- B outbox/session retry after a peer host restart can return HTTP 410 instead of
  a fresh handshake; this blocks the consumer delivery after re-approval.
- External wallets: real MetaMask/Rabby announce EIP-6963 (evidence
  `external-wallet-eip6963.json`); product connect/network/EIP-712 still not
  completed.
- F12 transient overlay hostname/node-id mismatch (not reproduced after a
  restart; root cause unknown).
- Windows: `test/provisioner.test.ts` excluded, executed floor 360 (comment says
  380).

## Never do

No real funds, no mainnet send/credit/auto-recharge, no real wallet secrets, no
upstream Magpie/EasyTier edits, no user Magpie profile/port 3425, no central
server or second gateway.
