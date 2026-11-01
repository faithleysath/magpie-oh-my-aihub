# Phase 10 — final handoff (2026-10-31)

Read [`REPORT.md`](REPORT.md) first; this is only the next-session shortcut.

## State

- Branch `feature/phase10-final-acceptance`; functional head `4d96196`;
  PR **#51** (draft) → `feature/phase10-wallet-closure` (#50).
- #50 was retargeted to `feature/phase10-p2p-closure` (#49); #49 stays → `main`.
  Nothing is merged. #14–#48 remain open drafts (history; not closed to avoid
  losing evidence).
- Local gates: typecheck PASS, 1411 tests / 0 fail, secret-scan PASS, boot-check
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

**Re-approval after revoke: REPRODUCED end-to-end.** The B stale-session 410 is
fixed (only explicit 410 drops the session; fresh hello; same row/idempotency
retried). Real path: revoke → provider restart → request retried after 410 →
manual re-approval → new key/ledger window → new Remote `p2p-22cf…`, cap $0.05,
ACK → 200 call. One active key; ledger append-only; evidence
`evidence/reactivation/reactivation-delivery.json`.

**F12:** one identity function, adopted-core hostname mismatch restart, invalid
persisted nodeId fail-closed, self-connect also compares the IPv4. Windows floor
is 360 everywhere with `provisioner.test.ts` a documented gap.

## Still open

- External wallets: real MetaMask/Rabby announce EIP-6963; product
  connect/network/EIP-712 remains UNKNOWN (browser onboarding/popup blocked).
- Windows: `test/provisioner.test.ts` is a documented gap; floor is 360
  everywhere now.


## Never do

No real funds, no mainnet send/credit/auto-recharge, no real wallet secrets, no
upstream Magpie/EasyTier edits, no user Magpie profile/port 3425, no central
server or second gateway.
