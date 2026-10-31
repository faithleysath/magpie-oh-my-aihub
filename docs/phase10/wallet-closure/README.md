# Phase 10 C wallet closure — index

- [REPORT.md](REPORT.md) — integration provenance, the real payment root causes and fixes, the
  complete two-node no-file payment, wallet/mainnet evidence, the extension attempt, boundaries
  and cleanup.
- [evidence/](evidence/):
  - `wallet-journey.json` — create/lock/unlock/export/restore and the zero secret-leak scan.
  - `mainnet-readonly.json` — BSC/Base public read-only results and the BSC USDC refusal.
  - `payment-journey.json` — the real payment: invoice, tx hash, receipt, ledger deposit, cap
    change, duplicate/restart result and screenshot.
  - `consumer-payment-received.png`, `provider-wallet-locked.png`,
    `consumer-wallet-locked-restored.png`.
  - `lab-partial.json`, `secret-scan.json`, `lab-cleanup-proof.json`.

The short version: the wallet and read-only surfaces are real; the B zero-file authorization and
the C zero-file payment completed on two real portable Magpie/EasyTier nodes with an isolated
anvil chain — request, terms, built-in EIP-712 signature, explicit send, watcher finality, one
ledger deposit, Magpie cap from $0.05 to $1.55 and consumer `已到账`. Automatic recharge remains
a reminder plus one-click confirm, and mainnet real funds remain NO-GO.
