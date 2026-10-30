# Testnet lab handoff — 2026-10-30

## Scope and exact environment

The previous Paseo agent `d2d89838-3d4b-492f-a841-d78fa6b0bd36` was terminated at the user's request. Its outstanding commands were checked: no `bun`, `forge`, `cast` or `anvil` lab process remained. Existing uncommitted script changes were preserved before correction.

- Platform: macOS 26.6.2 (25G83), Darwin arm64.
- Bun: 1.4.3.
- Foundry: 1.8.6, commit `6bad0a66de7c83f7b33695044138f0f5fa4c5990` (`mise x foundry -- cast --version`).
- Solidity contract: `plugin/lab/chain/src/MockERC20.sol`, pragma 0.8.24.
- Implementation base: `6b6b337` on PR #8; this follow-up is `fix/testnet-lab-handoff`.
- No upstream Magpie/EasyTier or production payment module changed. No mainnet operation, purchase or real asset was used.

## Findings

### VERIFIED — BSC payment exists and the earlier test-sink run completed

The predecessor's preserved report records 11/11 steps, including one test-sink credit and zero additional credits on rescan. It is now saved as `phase7-testnet-bsc-report.json` and explicitly labelled as a test sink, **not** a live Magpie integration.

Independent RPC receipt check: status `0x1`, block `139737879`, token contract `0xd711ca4ecd966bb83b572616ac6008795dd4e26c`, consumer → provider, `1000000` raw units (one 6-decimal token).

- Payment: https://testnet.bscscan.com/tx/0x52a600d99c3f2578d01c303044439110400a46e07769a30bec0531c48f6b9879
- Mint: https://testnet.bscscan.com/tx/0x639c7e4f7f4d76eb97c9d8aca61492ec3fe37f356e7294f7e4db8cdc5ad2beaa
- RPC: `https://bsc-testnet-rpc.publicnode.com`.
- Sanitized raw response: `phase7-testnet-handoff-receipts.json`.

### REPRODUCED — the old Base payment was too small to credit

The predecessor sent `1000000` raw units on an **18-decimal** token. At the lab rate of one test USD per whole token, integer conversion returns **zero nano-USD**. The watcher correctly refuses such dust rather than granting free credit. This is a lab input bug, not evidence that production accounting failed.

- Old Base payment: https://sepolia.basescan.org/tx/0x9389ec22a1b12b779e98c65f98054b68df8a3d0b362f286f2594aa96c9a7bf6d
- `plugin/test/testnet-lab.test.ts` now proves the default is one whole token at either 6 or 18 decimals, and dust is rejected **before** a write.
- No change to finality or the money conversion rule was made to make the test pass.

### VERIFIED — corrected Base payment mined; UNKNOWN — final credit still waiting

Reused the existing Base mock token instead of deploying again. Existing consumer gas was sufficient, so no additional native-coin top-up was sent.

- Corrected mint: https://sepolia.basescan.org/tx/0x4f82db742441f84259b391db14714c252700105d1224be3f2e85081f9d186441
- Corrected payment: https://sepolia.basescan.org/tx/0x6c192c2aed807871e962f4655860e5f5eda2d6a9eff32e81de04612b01a0abe9
- Payment receipt: status `0x1`, block `52058825`, `1000000000000000000` raw units (one 18-decimal token).
- RPC: `https://base-sepolia-rpc.publicnode.com`.
- Original public receipt responses are in `phase7-testnet-handoff-receipts.json`.

Base's configured condition is the `finalized` tag reaching the payment's block, **not** a successful receipt alone. While that tag still lags, the event is `confirming` and must not be called credited. The waiting process is read-only on-chain, writes public checkpoints locally and never retransmits a payment.

### REPRODUCED — gas configuration and weak receipt checks

The inherited script had added a fixed `1gwei` and `300000` gas allowance. Their maximum execution cost is `0.0003 ETH`, more than the Base faucet's `0.0001 ETH`. The inherited replacement reads `eth_gasPrice`; this handoff preserves it and adds successful-receipt validation and a finite subprocess timeout. Error output redacts 32-byte hex values.

A JSON result with `success:false`, a missing transaction hash or a reverted receipt can no longer be treated as success just because a command exits zero.

BSC's measured price `100000000 wei` is **0.1 gwei**, not the previously reported 100 gwei. General txpool volume is not proof that a particular payment is stuck.

### UNKNOWN — real testnet → real Magpie allowance → successful AI call

Both the original `LedgerSink` and the resumable sink are **test destinations**. Neither changes a real Gateway Key. Do not describe this lab as a completed real-Magpie recharge/429/200 acceptance test. Existing fake-gateway tests and the earlier isolated Magpie experiments are separate evidence.

## Reproduce / resume

Keys stay outside the repository and are disposable testnet-only keys. Addresses and transaction hashes are public; no key is required for read-only resume.

```bash
mise x foundry -- cast --version
cd plugin
bun test test/testnet-lab.test.ts
bun run ci

# If intentionally starting another lab payment, reuse the existing token and
# pass its verified address. Omit --amount for one whole token at its precision.
bun scripts/testnet-lab.ts --keys <throwaway-keys-file> --chains 84532 \
  --rpc https://base-sepolia-rpc.publicnode.com --token <verified-existing-mock-token> \
  --out <private-temporary-directory>/base.json

# For the CURRENT payment, do not run the command above: use its checkpoint.
bun scripts/resume-testnet-lab.ts <existing-checkpoint.json>
```

The active checkpoint is `/tmp/phase7-lab/testnet-base-handoff.json.checkpoint.json`. Its local SQLite path is recorded there. The read-only resume report is `<checkpoint>.resume.json`; it labels the sink and `liveMagpieVerified: false`. The sink persists its local deposits so a restart does not forget a recorded test credit. A rescan must return zero new credits. A 40-minute finality timeout reports UNKNOWN, not success, and permits another read-only resume.

## Validation

- VERIFIED: `bun run ci` passed on macOS arm64: **392 tests, 0 failures, 1438 assertions, 25 files**, typecheck, boot-check and secret-scan.
- VERIFIED: additional resume script typecheck and the four lab regression tests pass.
- UNKNOWN: follow-up branch CI on Linux/GitHub, not yet run.
- UNKNOWN: corrected Base payment finality/credit until the waiting process records it.
- Real funds remain NO-GO; pricing-lock and other architecture blockers are unchanged.
