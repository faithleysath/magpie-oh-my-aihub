# Phase 10 C wallet closure — index

- [REPORT.md](REPORT.md) — integration provenance, review fixes, real wallet/mainnet evidence,
  B authorization evidence, the payment blocker, auto-recharge downgrade and boundaries.
- [evidence/](evidence/) — sanitized JSON and screenshots:
  - `wallet-journey.json` — create/lock/unlock/export/restore outcomes and the zero secret-leak
    scan.
  - `mainnet-readonly.json` — BSC/Base read-only public RPC results and the BSC USDC refusal.
  - `lab-partial.json` — pins, two-node topology, B approval/delivery and the blocked payment.
  - `secret-scan.json` — exact-byte scan of the lab tree.
  - `provider-wallet-mainnet-readonly.png`, `consumer-wallet-locked-restored.png`.
  - `lab-cleanup-proof.json` — exported cleanup proof (added at the end of the run).

The short version: the wallet and mainnet read-only surfaces are real and tested; the B
zero-file authorization flow is real; the C P2P payment did not complete in this single-host lab
and is reported as UNKNOWN, not as a pass. Automatic recharge is a reminder + one-click confirm,
not an unattended signer.
