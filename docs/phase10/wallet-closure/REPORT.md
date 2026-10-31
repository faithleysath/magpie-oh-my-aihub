# Phase 10 C — wallet, BSC/Base read-only, zero-file recharge and auto-recharge closure

Status tags: **VERIFIED** (source/config/read), **REPRODUCED** (run and observed here),
**UNKNOWN** (not measured or blocked), **LIMITATION** (a real, stated boundary).

- Branch: `feature/phase10-wallet-closure`
- Base: PR #49 `6b4d7d2f6e243b8ae8dfd074842cd71985850876` (A stop-share + B zero-file closure)
- Final functional head (code, before this docs commit): `56370a6`
- PR: https://github.com/faithleysath/magpie-oh-my-aihub/pull/50 (draft, not merged)
- This report is the integration and acceptance record for this branch. The older
  `docs/phase10-c-*.md` files are their own units' reports; their integration status is
  superseded by this file.
- No real funds were used. Real mainnet access is **read-only public RPC** only. No mainnet
  send, credit or automatic recharge is enabled anywhere.

## 0. One-page status

| Area | Status | Evidence |
| --- | --- | --- |
| C wallet vault/UI (create, lock, unlock, backup, export, restore) | **REPRODUCED** in a real Magpie 0.1.2289 UI + ego-lite | `evidence/wallet-journey.json`, two wallet screenshots (the mainnet result is in the JSON, below the wallet section) |
| Mainnet BSC 56 / Base 8453 equal read-only | **REPRODUCED** (real public RPC and browser UI) | `evidence/mainnet-readonly.json` |
| BSC USDC | **UNKNOWN / refused** (issuer evidence absent) | reader refuses the unregistered contract |
| B zero-file request → human approval → encrypted delivery → native Remote | **REPRODUCED** on two real portable Magpie nodes | `evidence/lab-partial.json` |
| Real end-to-end C P2P **payment** (terms → signature → send → watcher → credit) | **UNKNOWN / BLOCKED in this lab** | provider payment requests stayed empty; host instability after the request |
| Manual built-in-wallet send (preview → confirm → ERC-20 broadcast) | **VERIFIED by tests**, not exercised on the real lab chain | `wallet-payment-send.ts`, vault tests |
| Automatic recharge | **NOT FULL AUTO** — reminder + one-click confirm only | policy schema and UI explicitly say FULL AUTO is not implemented |
| Mainnet send / credit / auto-recharge | **CLOSED** by the hard gate | `mainnet-gate.ts`, tests |

## 1. Integration provenance

The branch is built on PR #49, not on a merge-base guess. Each unit below was applied as a
delta from its reviewed source and resolved against the A/B closure tree; shared files were
kept as the current A/B versions (no old clock, module or transport was replayed).

| Unit | Source head | Integration commit (this branch) |
| --- | --- | --- |
| C1 registry, mainnet gate, read-only reader, receiving policy, ledger provenance | `d96ac56` (PR #21 delta over `889973f`) | `11b4381` |
| Network-local read-only console actions | `59d73bf` (PR #41) | `b683d8c` |
| Wallet-vault local service (`#38`) | `635bf41` | `31f795e` |
| Wallet vault UI + read-only network UI (`#39`, `#43`) | `23c9480`, `012c486` | `ed6381c` |
| Payment-operation journal (`#35`) | `fdb4383` | `60358b1` |
| Authenticated local payment service (`#44`) | `a50e068` | `1d55b3a` |
| P2P payment protocol/store/service (`#48`), reviewed and fixed | `2be033b` | `f66fd8a` |
| B `payment_message` hook on the existing B transport | new reviewed unit | `648c3f2` |
| C host wiring, built-in wallet signing, manual ERC-20 send, payment UI, auto reminder | new reviewed unit | `bfc2116` |
| Wallet create-dialog regression fix found in the real lab | — | `0b33899` |

`#23` (vault core) and `#30` (external wallet) were already present in PR #49 with identical
file content; they were not replayed. The old `payment_request` type and `credit_updated`
remain B1-unsupported.

## 2. Review findings fixed before product wiring

### #48 review (not accepted just because CI was green)

1. **Duplicate invoice risk.** A new consumer request id for the same consumer/network/asset/
   amount could mint a second payable invoice. The provider now reuses the one open invoice;
   a crash after the ChainStore intent but before the P2P row reuses that unchanged intent.
2. **Consumer adoption.** A lost terms reply is recoverable: the consumer adopts an already-open
   invoice only when every selection term still matches, then stores the obligation by invoice.
3. **Cross-invoice signature binding.** A signature frame with request id A and invoice B used to
   find A by request id and verify B. The provider now requires the request id and invoice to
   belong to the same stored request; a test proves the refusal.
4. **Store failures looked like signature refusals.** Only the wallet verification is wrapped as
   `actionneeded`; a database failure stays retryable.
5. **Expired status frames could not be sent.** Status updates get a short positive frame
   lifetime after invoice expiry; the resolver still denies by `expiresAtMs`.
6. **Unbounded dedupe.** The payment idempotency rows are pruned (24 h / 1024 rows) and the
   SQLite WAL/SHM sidecars are now 0600 like the main file.
7. **Correlation/resume.** Envelope correlation is checked against the frame request id, and a
   stored request or signature can be resumed without re-signing.

### B hook

- One new type, `payment_message` (code 11), on the same signed envelope/AEAD session/outbox/poll.
- B validates only wrapper shape/size, idempotency/correlation, target, time and one bounded
  inbox row. The C body is opaque; B has no Ledger/Provisioner/Wallet/cap/credit call.
- A replay returns the cached C result; a reused key with a different frame is a conflict; a node
  without a hook answers `unsupported` with no effect.

### Wallet UI

- **Real bug found in the lab:** a background status poll closed the create/import dialog on a
  fresh profile (it was treated as a secret-bearing lifecycle close). The dialog now stays open
  until a secret or a real lifecycle change; regression test added.
- The vault gained exact ERC-20 signing: `prepareErc20Payment` binds selector/recipient/amount in
  calldata with zero native value, and the permit binds the exact calldata hash. Mainnet is
  refused by the existing vault chain gate.

## 3. What was verified

### 3.1 Automated

- `bun run typecheck` PASS.
- `bun run test` **1397 pass / 0 fail** (includes the wallet fixture and console JS tests).
- `bun run secret-scan` PASS; `bun run boot-check` PASS.
- `npm pack --dry-run`: 99 files, no `test/` and no `node_modules/`.
- Coverage relevant to this stick: C registry/gate/read-only (phase10-c-registry), network-local,
  wallet vault (incl. ERC-20 preparation/signing and permit binding), wallet local service,
  payment journal, payment local service, P2P payment protocol/store/service (14 tests),
  B `payment_message` transport (2 tests), protocol allow-list, UI helpers and console shell.

### 3.2 Real wallet journey (REPRODUCED)

Two fresh portable Magpie 0.1.2289 nodes + real EasyTier 2.6.4, driven in ego-lite. On the
isolated provider wallet (and the consumer wallet for restore):

- create with password and one-time 12-word seed, then locked;
- unlock and verify the address for the session;
- mnemonic export after purpose + confirmation + fresh password; the revealed seed equals the
  lab-private backup;
- private-key export after the same reauthentication; the derived ethers address equals the
  wallet address;
- restore from the exported mnemonic (replace with current password) yields the **same** address;
- an exact byte scan of the entire lab tree (logs, state, sqlite, browser-visible files) found
  **0** matches for the mnemonic or private key; the two 0600 lab-private files were the only
  copies and are deleted in cleanup.

Sensitive values were never printed, screenshotted, written to the repo or included in state.

### 3.3 Mainnet read-only (REPRODUCED)

Public address `0x0000000000000000000000000000000000000001`, real RPCs, no signature/broadcast:

- BSC 56 native BNB, block 130851888, `creditEligible:false`;
- Base 8453 ETH, block 53329015, `creditEligible:false`;
- Base 8453 USDC (registered Circle contract), 6 decimals, block 53329016, no USD valuation;
- BSC USDC contract refused as unregistered; no symbol guess;
- the browser also shows chain 8453 ETH at block 53328995 with `readOnly:true`,
  `creditEligible:false`, `usdValue:null`.

BSC and Base are equal records; no primary/default chain. The receiving-network UI defaults to
empty and never selects a chain automatically.

### 3.4 B zero-file authorization (REPRODUCED on two real nodes)

Consumer discovered the provider, verified and accepted the full fingerprint, sent a no-file
request; provider selected the model, previewed the selected price version, set a $0.05 cap,
accepted the consumer fingerprint and confirmed; the consumer pulled the encrypted delivery,
registered a native Remote and ACKed; the provider shows `acked` with cap/used/remaining and the
consumer shows one connected provider. No file, CLI or manual key copy was used.

**Lab setup disclosure.** The isolated anvil chain (`--chain-id 84532`), its mock tUSDC asset in
the node registry and the provider's receiving address were configured before/around the UI run
with the maintainer API/server (the UI has no anvil-RPC/asset-deployment controls). The wallet
create/unlock/export/restore, network join, share, discovery, B request/approval and all payment
UI actions were performed in the real browser. This is a lab prerequisite, not a consumer
business step; a production deployment still needs an operator-facing asset/network setup.

## 4. Blocker / UNKNOWN: real C payment end-to-end

After the B authorization, the consumer's payment request action returned `200 queued` with
request id `bcde682d-632f-4254-bd78-9b6a13745ac4`. The provider's payment state remained empty
(no terms, no invoice, no signature, no send). Observed in the same lab:

- the EasyTier peers are connected (1 peer, direct, 0% loss);
- the provider's catalogue/presence is readable through the consumer SOCKS5 **and** through a raw
  `socksHttpGet` (HTTP 200, 1822 bytes);
- the consumer's directory refresh intermittently timed out at 5 s while the raw read succeeded;
  after setting both nodes to catalogue port 3426 the peer read succeeded (this is a real
  multi-instance-on-one-LAN-IP lab constraint: the directory probe uses the local configured
  catalogue port and two nodes cannot both bind the same LAN address/port);
- after the payment request the provider's plugin host booted repeatedly (roughly every 5–10 s)
  and never exposed a provider payment request.

Root cause of the host restart/payment stall is **not established**. It is not classified as a
passing payment. The C protocol/store/service and B hook are covered by unit/integration tests,
but a real two-node payment, chain observation, credit and consumer `已到账` are **UNKNOWN** in
this environment. This is the honest boundary of this stick; the report does not claim a
completed no-file recharge.

## 5. Automatic recharge: downgraded, not faked

- The policy schema stores provider/network/asset, trigger, per-payment and daily caps, gas cap and
  authorization TTL, and refuses 56/8453 and unknown chains.
- `executor: "none"`, `fullAuto: false`, `mode: "manual-confirm"` are constants. The UI says
  **FULL AUTO 未实现** and only shows a reminder when the provider's remaining credit is below
  the trigger; the actual send is the same preview + explicit confirm path.
- No plaintext key is kept for unattended signing; the vault session is short and expiring.
- No mainnet auto-recharge path exists.

## 6. Security boundaries kept

- Mainnet 56/8453 are read-only: the hard gate refuses send/credit/auto-recharge independently of
  the registry, options or environment; the ledger refuses mainnet sources.
- Payment networks are 97/84532 only; 56/8453 and unknown chains are refused before a store row.
- The journal is the only send gate: reserve → sign → markBroadcasting → broadcast → recordHash;
  an ambiguous broadcast is `unknown` and never retried automatically.
- The provider's terms bind the consumer's current B approval generation and accepted quote; the
  consumer authority re-checks the current signed catalogue quote and its local approved Remote.
- A peer status can never credit, and a local watcher failure cannot cause a second payment.
- The Magpie administrative interface is never exposed; B's control plane remains the narrow
  authenticated transport only.

## 7. Boundaries

1. Single-host loopback/LAN lab; no WAN/NAT/relay or two physical hosts.
2. Two Magpie instances on one LAN address cannot both bind catalogue port 3426; setting both to
   3426 allowed discovery but the consumer cannot publish its presence on the same address. The
   product's per-node catalogue port is a real deployment consideration; the UI does not expose a
   port choice.
3. No vendor model execution; the shared model is the deterministic local fixture.
4. No browser wallet extension (MetaMask/Rabby) was installed or tested; the built-in wallet is
   the tested local signer. A real extension remains UNKNOWN.
5. No real mainnet payment, credit or auto-recharge; no real funds.
6. The P2P payment real-wire journey is blocked as described in §4.
7. The C payment store, like the journal, is a local SQLite file; no second server is introduced.

## 8. Quality gates and evidence

| Gate | Result |
| --- | --- |
| typecheck | PASS |
| full test suite | 1397 pass / 0 fail |
| secret-scan | PASS |
| boot-check | PASS |
| pack contents | 99 files, no tests/node_modules |
| GitHub CI (head `56370a6`) | plugin Linux PASS, plugin macOS PASS, windows subset PASS, secrets (working tree) PASS, secrets (git history) PASS, package contents PASS |
| evidence | `evidence/` with JSON + 2 screenshots |
| cleanup | all owned processes stopped; every lab port free; lab root, seeds, private keys and the anvil token lab deleted; `evidence/lab-cleanup-proof.json` |

Evidence files are sanitized. The lab root, seeds and private keys are deleted after the run;
only public addresses, node ids, block numbers, hashes and outcomes remain.

## 9. Verdict for this stick

- **C integration and wallet/mainnet read-only: VERIFIED/REPRODUCED** within the boundaries above.
- **B zero-file authorization/approval/delivery: REPRODUCED** on two real Magpie/EasyTier nodes.
- **Real P2P payment/no-file recharge: UNKNOWN/BLOCKED**; not claimed as complete.
- **Automatic recharge: reminder + one-click only; FULL AUTO not implemented.**
- **Mainnet real funds: NO-GO**, unchanged.
