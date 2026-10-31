# Phase 10 C — wallet, mainnet read-only and the real zero-file payment loop

Status tags: **VERIFIED** (source/config/read), **REPRODUCED** (run and observed here),
**UNKNOWN** (not measured or blocked), **LIMITATION** (a real, stated boundary).

- Branch: `feature/phase10-wallet-closure`
- Base: PR #49 `6b4d7d2f6e243b8ae8dfd074842cd71985850876`
- Functional code head: `d09efe1`; measured final head (this docs commit): `722d67a1cc15df32f0cd4c3d14ec8f6b53e401b5`
- PR: https://github.com/faithleysath/magpie-oh-my-aihub/pull/50 (draft, not merged)
- No real funds. Real mainnet access is read-only public RPC only. Mainnet send, credit and
  automatic recharge remain closed.

## 0. One-page status

| Area | Status | Evidence |
| --- | --- | --- |
| C wallet (create/lock/unlock/backup/mnemonic/key export/restore) | **REPRODUCED** in the real Magpie 0.1.2289 UI | `wallet-journey.json`, screenshots, zero secret-leak scan |
| BSC 56 / Base 8453 equal read-only | **REPRODUCED** (public RPC and browser) | `mainnet-readonly.json` |
| B zero-file request → human approval → encrypted delivery → native Remote | **REPRODUCED** on two real nodes | B approval `acked`, remote generation 1 |
| **C zero-file payment: request → terms → EIP-712 → send → watcher → ledger → Magpie cap → 已到账** | **REPRODUCED end-to-end on the real two-node lab** | `payment-journey.json`; tx `0x4f7f…0489e`; cap `$0.05 → $1.55` |
| Manual built-in-wallet ERC-20 send on anvil | **REPRODUCED** | preview → confirm → signed broadcast → receipt status 1 → provider event credited |
| Duplicate / restart recovery | **REPRODUCED** | provider host restart: one chain deposit, cap unchanged, event still one credited row |
| Automatic recharge | **NOT FULL AUTO** — reminder + one-click confirm only | policy/UI explicitly say so; no unattended signer |
| Mainnet send/credit/auto-recharge | **CLOSED** by the hard gate | unit/integration and registry gate |
| External MetaMask/Rabby connection + signature | **UNKNOWN / tool-blocked** | MetaMask 13.54 loaded and imported in isolated Chromium; EIP-1193 present; popup automation did not complete |

## 1. Integration provenance

Built on PR #49 by applying each reviewed delta and keeping the current A/B files:

| Unit | Source head | Commit |
| --- | --- | --- |
| C1 registry, mainnet gate, read-only reader, receiving policy, ledger provenance | `d96ac56` (PR #21) | `11b4381` |
| Network-local read-only console actions | `59d73bf` (PR #41) | `b683d8c` |
| Wallet-vault local service (#38) | `635bf41` | `31f795e` |
| Wallet UI + read-only network UI (#39, #43) | `23c9480`, `012c486` | `ed6381c` |
| Payment journal (#35) | `fdb4383` | `60358b1` |
| Authenticated local payment service (#44) | `a50e068` | `1d55b3a` |
| P2P payment protocol/store/service (#48), reviewed and fixed | `2be033b` | `f66fd8a` |
| B `payment_message` hook | new unit | `648c3f2` |
| C host, built-in wallet signing, manual ERC-20 send, payment UI | new unit | `bfc2116` |
| Wallet create-dialog poll regression | found in the real lab | `0b33899` |
| Dual-instance catalogue/presence + payment outbound session fixes | found in the rework lab | `e5a7c42` |
| Payment protocol/host fixes below (real payment closure) | found in the real payment lab | `d09efe1` |

## 2. Root causes found by the rework (and fixed)

These were not unit-test failures; each was observed in the real two-node lab, then fixed and
re-run until the payment completed.

1. **Provider control 403 after sharing.** The control listener's allowed Host list was
   captured at start; enabling sharing later created the mapped host, but the listener still
   rejected it. The list is now read per request and updated by `ControlApp.sync`. Evidence:
   the consumer's B request returned `control endpoint HTTP 403`; after the fix the provider
   received the request.
2. **C envelope id mismatch.** B's envelope id is 32-hex; the C coordinator required a UUID and
   answered `invalid`. It now accepts the real 32-hex id (and the synthetic UUID), and logs the
   exact protocol refusal.
3. **Checksummed addresses.** The payment protocol accepted only lowercase addresses while the
   wallet/registry produce checksummed values; the provider rejected its own terms with
   `terms.recipientAddress must be a non-zero address`. Address validation now accepts mixed case
   and normalizes; the typed-data comparison normalizes the address fields too (a checksummed
   EIP-712 document hashes like its lowercase form).
4. **B approval expiry vs payment.** The B approval's `expiresAt` is the one-time key-delivery
   window, not the lifetime of the consumer relationship. A payment after that window was
   rejected as `no current authorization`. The provider now uses the latest **approved**
   generation/quote until it is revoked; a revoked approval is still refused.
5. **Control-only consumer delivery.** A provider enqueued terms but had no catalogue endpoint to
   push to the consumer; the consumer's poll set was empty after a host restart. The C port now
   watches the peer, rebuilds poll targets from durable obligations on start, and falls back to
   the B outbox when `ensureSession` cannot discover a catalogue peer. The consumer's authenticated
   poll then pulls the terms/status.
6. **Preview balance selector.** The preview read the token balance with the transfer selector
   (`0xa9059cbb`) instead of `balanceOf` (`0x70a08231`), causing `execution reverted`. Fixed;
   the preview then produced nonce/gas/fee/balance values.
7. **Console panel starvation.** One panel throwing during a render could leave the payment panel
   empty; each panel render is now isolated.
8. **Single LAN IP catalogue.** The reader probed its own configured port, so two instances on one
   LAN address could not find each other. The probe window is fixed at `3426..3430`, and a
   presence-only node migrates on `EADDRINUSE` inside the same window; normal users never enter a
   port. Lab: provider 3426, consumer 3427, both discovered; the whole payment ran.

### 2.1 The repeated plugin-host boot lines

The provider log contained ~380 `plugin boot` + `host shutdown requested` pairs at the same
millisecond, but **no `uncaught exception`, `unhandled rejection`, `plugin failed to start` or
parent-gone line**, and one active owner PID remained. Magpie starts short-lived processes that
invoke the plugin entry (page/host probes); they exit before taking the host lock, and their
`onExit` cleanup logs the shutdown. They are not restarts of the active owner: the owner's
`payment-p2p host started` line, the control listener and the payment frames all belong to the
long-lived process, and the owner processed the real payment. This is a Magpie host-manager probe
behavior, not a crash and not a reason to disable a safety check. The earlier payment stall was
caused by the protocol/lifecycle bugs above, not by the log pairs. The new host diagnostics
(signal/parent/exception/payment-host start-stop) are permanent and can distinguish a real crash
from a probe.

## 3. The real zero-file payment (REPRODUCED)

Two fresh portable Magpie 0.1.2289 nodes + real EasyTier 2.6.4 no-TUN on one host/LAN, an
isolated anvil chain id 84532 and a local MockToken (6 decimals). Course:

1. Consumer UI: choose the approved provider, chain 84532, tUSDC, `1.5`; `申请充值条件`.
2. Provider receives `payment_message`, creates one real `DepositIntent` (invoice
   `inv_68716e30-8c0e-411d-999f-8dcb748bb300`), signs/serves terms; consumer's authenticated poll
   pulls the terms and shows an unsigned obligation.
3. Consumer: explicit confirmation → built-in wallet EIP-712 signature (payer
   `0xe744…5599`); provider verifies with `Wallet.signIntent` and returns a waitingpayment ack;
   only then does the resolver offer `预览并付款`.
4. Preview: nonce, gas limit, EIP-1559 fees, native/token balances, exact recipient/amount, EIP-712
   digest; explicit confirmation.
5. Send: journal reserve → vault ERC-20 signature → journal `markBroadcasting` → anvil
   `eth_sendRawTransaction` → hash recorded. Transaction
   `0x4f7f160d92189fbf70a79768e2b8c392a2c1fb7a60da4d9cf3d6d00e6cd0489e`, status `0x1`, block 4.
6. Provider watcher stores the Transfer, matches the signed intent, requires the chain's own
   finality (one mined block in the isolated chain), re-reads the block, books the ledger deposit
   once and raises the Magpie key cap from `$0.05` to `$1.55` (used `$0`).
7. Provider sends `received`; the consumer's poll stores it; UI shows **已到账**.

Evidence: `payment-journey.json`, `consumer-payment-received.png`, provider consumer view
`capUsd=1.55, usedUsd=0`, ledger `chain:84532:…:0` applied `1500000000` nanos, chain event
`credited`.

- **Duplicate/restart:** provider host restart; re-scan produced no second deposit, cap stayed
  `$1.55`, the same event stayed one credited row.
- **Reorg attempt:** anvil `anvil_reorg 6 []` was issued after the credit; the transaction was
  replayed as canonical in the reorg (receipt still valid), so no freeze was observed. A
  post-credit reorg that actually removes the transaction was not achieved in this lab; the
  watcher's credited-event recheck/freeze path remains covered by the unit tests and the earlier
  Phase 7 `anvil_reorg` evidence, not claimed as a new real-lab result.
- **Unknown broadcast:** not induced in the lab; the journal's `unknown` terminal send gate and
  the "no automatic retry" tests cover it.
- **Wrong network/asset/identity/quote:** the payment host only exposes 84532/tUSDC for this
  provider; 56/8453/unknown chains are refused before a store row; the B identity/quote/generation
  and the selection are bound and unit-tested. The real UI offered no mainnet asset.

## 4. Real wallet and mainnet evidence

- Wallet: create → one-time 12-word seed → locked; unlock → address verified; mnemonic export after
  purpose + confirmation + password equals the lab backup; private-key export derives the same
  address; restore from the exported mnemonic yields the same address; exact-byte scan of the lab
  tree found **0** seed/key matches (only the two 0600 lab-private files).
- Mainnet read-only: BSC 56 native BNB block 130851888, Base 8453 ETH block 53329015, Base USDC
  block 53329016, `creditEligible:false`, no USD value; BSC USDC refused as unregistered. Browser
  also read Base ETH at block 53328995. No signature, no broadcast, no funds.

## 5. Automatic recharge: downgraded honestly

The policy stores provider/network/asset, trigger, per-payment and daily caps, gas cap and
authorization TTL; 56/8453/unknown chains are refused. It has `executor:"none"`,
`fullAuto:false`, `mode:"manual-confirm"` as constants; the UI says **FULL AUTO 未实现** and only
shows a reminder when the remaining provider credit is below the trigger; the actual payment is
the same preview + explicit confirm. No plaintext key is kept for an unattended signer. Mainnet
auto-recharge has no path.

## 6. External MetaMask/Rabby attempt (UNKNOWN)

- MetaMask **13.54.0** CRX was downloaded and loaded unpacked into an **isolated** Playwright
  Chromium profile `/tmp/oma-extension-profile` (`--load-extension=/tmp/metamask-ext`); the user's
  default ego profile and Magpie data were not touched.
- The lab consumer mnemonic was imported into MetaMask; the extension home shows Account 1
  `0xE7441…95599` (the lab consumer address); the test page sees `window.ethereum` with one
  provider.
- `eth_requestAccounts` from a local test page opened MetaMask's locked `home.html#/unlock`
  page; after a scripted password unlock the connect request stayed pending/no accounts were
  returned. `eth_signTypedData_v4` then returned
  `Invalid parameters: must provide an Ethereum address.` No connection or signature is claimed.
- Rabby was not attempted after this tool limitation. This is **UNKNOWN**, not a fake-provider
  compatibility pass; the built-in wallet is the tested signer.

## 7. Boundaries

1. Single-host loopback/LAN lab; no WAN/NAT/relay or two physical hosts.
2. Two instances on one LAN address use catalogue ports 3426/3427 from the fixed window; a third
   instance would need the next window port (bounded 5). Normal UI never asks for a port.
3. No vendor model; the shared model is the deterministic local fixture. The anvil chain is
   isolated, not Base Sepolia.
4. Post-credit reorg removal was not reproduced in this lab (the anvil reorg replayed the tx).
5. Unknown broadcast, process crash at the exact broadcast boundary and a true mainnet RPC
   disagreement remain unit/prior-phase evidence, not new real-lab claims.
6. Real Magpie/ET GUI on Linux/Windows, WAN and external wallet extension connection remain
   UNKNOWN. No real mainnet payment/credit/auto-recharge.

## 8. Quality gates

| Gate | Result |
| --- | --- |
| typecheck | PASS |
| full test suite | 1402 pass / 0 fail |
| secret-scan | PASS |
| boot-check | PASS |
| pack | 99 files, no tests/node_modules |
| GitHub CI (`722d67a`) | plugin Linux PASS, plugin macOS PASS, Windows subset PASS, secrets working tree PASS, secrets git history PASS, package contents PASS |

## 9. Evidence and cleanup

`docs/phase10/wallet-closure/evidence/`: `wallet-journey.json`, `mainnet-readonly.json`,
`payment-journey.json`, `secret-scan.json`, `lab-partial.json`, `lab-cleanup-proof.json`,
`consumer-payment-received.png`, `provider-wallet-locked.png`,
`consumer-wallet-locked-restored.png`. Sanitized only: public addresses, tx hashes, block
numbers, node ids, invoice ids, cap numbers; no seed/key/session.

Cleanup: lab3 runs an owned manifest export, then stops every owned process, verifies all lab
ports free and deletes the lab root (seeds/private keys included); the anvil process and token
lab, the extension profile and `/tmp/metamask-ext` are deleted. The user's Magpie/profile/3425
were never touched; only the isolated portable nodes and an isolated Chromium profile were used.

## 10. Verdict

- **Wallet / mainnet read-only: VERIFIED/REPRODUCED.**
- **B zero-file authorization and C zero-file payment: REPRODUCED end-to-end** on the real
  two-node lab, including the chain send, watcher, ledger, native cap and consumer `已到账`.
- **Manual built-in-wallet anvil send: REPRODUCED.**
- **Duplicate/restart: REPRODUCED; post-credit reorg removal and unknown broadcast: UNKNOWN in
  this lab (unit/prior evidence).**
- **Automatic recharge: reminder + one-click only; FULL AUTO not implemented.**
- **Mainnet real funds: NO-GO. External extension connection: UNKNOWN/tool-blocked.**
