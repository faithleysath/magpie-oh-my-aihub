# 生产付款：BSC 56 与 Base 8453

Status tags: **VERIFIED** (source/config read), **REPRODUCED** (executed and observed in this work), **UNKNOWN** (not measured), **LIMITATION** (a stated boundary).

This is the production payment build. BSC and Base are first-class, equal payment
networks. The two development testnets remain as development tools; the ordinary
product is no longer described as "testnet only".

- Worktree: `/Users/laysath/.paseo/worktrees/1z728cdk/production-mainnet-payments`
- Branch: `feature/production-mainnet-payments`
- Upstream start: `origin/main` `02098cf0dba5d6c096c912db2840280ffcf4a542`
- Platform used for the measurements: macOS 26.6.2 (Darwin 25.6.0), arm64; Bun 1.4.3; Foundry anvil 1.8.6
- Pinned installed Magpie: **0.1.2516**, tag `v0.1.2516`, commit `72114566bffbf4ef9e573221787b510298b0f0e0`, source <https://github.com/yetone/magpie/tree/v0.1.2516>
- No real funds were used. The only chain transactions in the fork evidence are on local Anvil forks. No mainnet transaction was signed or broadcast.

## 1. What is implemented

### 1.1 Equal production networks and verified assets

The registry seeds both product networks with `support: "credit"`, `receivable: true`,
`enabled: true`, `rpcQuorum: 2` and a real finality policy (`networks.ts`).

| Chain | Asset | Contract | Decimals | Issuer type | Evidence |
| --- | --- | --- | --- | --- | --- |
| BSC 56 | USDC (Binance-Peg) | see `MAINNET_ASSETS` in `plugin/src/networks.ts` (BSC BEP-20 contract) | 18 | `bridged` | BscScan verified BEP-20 contract; CoinGecko chain-56 token list; on-chain `name/symbol/decimals` read 2026-11-01 |
| Base 8453 | USDC (Circle native) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | `native-issuer` | Circle USDC contract-address table; on-chain `name/symbol/decimals` read 2026-11-01 |

Identity is always `(chainId, contract, decimals, symbol/issuer)`. The two USDC
tokens are deliberately different assets: 18/6 decimals, different issuers, different
contracts. A symbol alone never identifies an asset. BSC has **no Circle-native
USDC** in the checked sources; the BSC dollar asset is the Binance-Peg bridged
version, and the UI says so. Never identify it by symbol alone; use the contract
shown by the local registry/UI.

The assets are credited at exactly **1 USD per token** (`stablecoin-usd`). This is
the issuer's redemption/peg claim, not a market oracle. A depeg is a provider risk
that is surfaced, not hidden. A different rate (or a mock issuer) is refused by
`NetworkRegistry` and by the runtime `production-policy.ts`.

### 1.2 No blanket mainnet gate

`mainnet-gate.ts` now only answers the chain-id capability question. BSC 56 and
Base 8453 have `send` and `credit`; automatic recharge has no unattended executor
and is still false on every chain. The real controls are:

- registry asset quadruple + issuer evidence + exactly 1 USD face value;
- product network must be enabled, receivable, have at least two distinct RPC hosts
  and a non-read-only finality policy (`production-policy.ts`);
- the watcher re-verifies receipt, log, recipient, amount, asset and finalized
  block across the quorum before booking a deposit;
- the ledger only accepts `chain:<id>` sources on the credit allowlist;
- the provisioner grants the Magpie cap only after the cap read-back;
- the journal binds the invoice, consumer/provider identity, authorization
  generation, quote expiry and exact ERC-20 calldata before a send.

`ledger.ts` no longer refuses a `chain:56`/`chain:8453` source. It refuses a chain
outside the allowlist (`56, 97, 8453, 84532`).

### 1.3 Multi-RPC quorum

`EvmClient` has a failover reader for development/testnet work and a separate
production quorum reader (`evm.ts`):

- `eth_chainId` is verified on every endpoint;
- head and finalized height use the **minimum** answered height;
- a fixed-height block, receipt, log page or `eth_call` must be byte-identical
  across at least `rpcQuorum` endpoints;
- a contradictory answer refuses the read even when the minimum otherwise agree;
- the watcher records an `rpc-quorum` anomaly, does not advance the cursor and
  credits nothing; the next tick retries.

The product records use `https` endpoints. A loopback endpoint may use `http`
because it is a local node/isolated fork, not a remote trust boundary.

### 1.4 Finality

| Chain | Policy | Measurement (2026-11-01) |
| --- | --- | --- |
| BSC 56 | `finalized-tag` | `finalized` lagged `latest` by 1 block on `bsc-dataseed.bnbchain.org`, `bsc-rpc.publicnode.com`, `bsc-dataseed1.defibit.io`, `bsc-dataseed1.ninicoin.io`; BEP-126 is the chain's own fast-finality rule. |
| Base 8453 | `finalized-tag` | `finalized` lagged `latest` by about 600 blocks (~20 min); `mainnet.base.org` and `base-rpc.publicnode.com` agreed on the finalized height. Base inherits L1 finality. |

A credit waits for the chain's `finalized` tag, and the event block hash must still
be canonical. BSC's extra `confirmations: 1` field is documentation of the measured
depth; the tag is the actual condition. The policy is per chain, not a global
confirmation count.

### 1.5 Post-credit reorg

`ledger.ts` has an append-only `deposit_reversals` table. When a credited event's
block hash changes, the watcher:

1. marks the chain event `reverted` and writes a `reorg` anomaly;
2. records a reversal for the exact credited deposit (`reverseChainDeposit`), so the
   spendable balance drops (possibly below zero), while the deposit row, amount and
   history remain;
3. freezes the consumer through the same key-removal/rotation path as a price
   change;
4. refuses reactivation while the reversal leaves an overdraft; a covering deposit
   is required first.

A rescan cannot double-reverse (unique `deposit_id`). An RPC outage is not treated
as a reorg: an unavailable block is retried, never silently reverted.

### 1.6 Price/quote and the Magpie soft cap

Magpie has no price lock. The plugin snapshots Magpie's effective price when the key
is issued and binds the provider quote hash + price version + authorization
generation to the payment terms. A changed quote/price requires a new terms
exchange; the journal's `PaymentIdentityAuthority` re-checks the exact binding at
reserve and at the send gate, and the persisted intent expiry closes the gate.

Magpie's own budget is a **soft cap**: it admits a request while `used + reserved`
is under the cap, and settles at the recorded cost. The plugin therefore does not
claim an absolute hard cap. It writes two limits on the same key:

- cost cap = `native used + ledger balance` (on Magpie's $0.0001 grid);
- token cap = `used tokens + floor((balance - one-call reserve) / max nanos per token)`,
  using the bound price snapshot. The reserve is the max output-token cost plus 10%
  of the context window at the most expensive input-side price, per shared model.

The token limit is a second, price-independent bound. It reduces normal concurrent
overshoot to at most the in-flight calls that were already admitted; it is not a
mathematical hard cap, and the plugin/UI says so. The Magpie `gateway-key limit`
write is read back (`costLimit` and `tokenLimit`) before the deposit is marked
applied.

Magpie source used for the semantics: `internal/access/limit.go`,
`internal/budget/budget.go`, `internal/gwbudget/gwbudget.go` at tag `v0.1.2516`.
The real isolated Magpie in the fork lab reported both `costLimit` and `tokenLimit`
over `GET /v1/magpie/limit`.

### 1.7 Journal, unknown broadcast and recovery

`payment-operations.ts` keeps the single-winner state machine:
`reserved -> broadcasting -> broadcast`, with `unknown` and `released` terminal
states. The send gate is a SQLite CAS with `synchronous=FULL`; a crash after
`broadcasting` leaves a non-sendable row. An ambiguous wallet/RPC result is
`unknown`; it is never retried automatically. A known hash can be adopted with
`recordHash`, which is what `payment-operation-adopt` does after independently
verifying:

- the transaction's `from`, token contract, calldata and zero native value;
- a successful receipt;
- the exact ERC-20 `Transfer` log to the bound recipient for the bound amount.

The console's "付款恢复" section lists pending/unknown rows and accepts a known hash;
it does not create a second payment. Replacement transactions with the same nonce
and same calldata can be adopted only through the same verified-hash path. A user
who has no hash stays in `unknown`/`broadcasting` and must inspect their wallet or
explorer; no second send is offered.

### 1.8 UI

The ordinary UI offers BSC and Base directly; there is no hidden product flag and
no amount cap. The provider selects receiving networks independently (BSC, Base,
both or empty). The consumer chooses only a provider network/asset that the
provider actually advertises and the registry verifies. The UI shows the real
network, asset, address, amount and progress; technical chain ids/digests remain in
collapsed details.

The built-in wallet signs EIP-712 and ERC-20 transfers on 56/8453 (manual, per
payment, unlocked vault). The external-wallet adapter supports EIP-6963 selection,
explicit connect, explicit network switch/add and `eth_signTypedData_v4` /
`eth_sendTransaction` with the same journal port. Both paths use the same
server-owned obligation and journal; neither auto-signs or auto-broadcasts.

## 2. Fork evidence (REPRODUCED)

Script: `plugin/scripts/production-fork-lab.ts`
Command: `cd plugin && bun run scripts/production-fork-lab.ts both`
Evidence: `docs/production/mainnet-payments/evidence/fork-56-evidence.json`,
`fork-8453-evidence.json`, `fork-manifest.json`; SHA-256 in `SHA256SUMS`.

What the script does:

1. pins a public mainnet block and starts an Anvil fork with the real chain id;
2. exposes the same isolated fork on two loopback ports so the product's
   `rpcQuorum: 2` path runs; this is a code-path exercise, not a claim of
   independent public providers (disagreement/insufficiency is covered by unit
   tests with fake endpoints);
3. finds a real USDC holder on the fork (BSC `0xF977…aceC`, Base `0x3304…566A`),
   impersonates it **on the fork only**, and moves 5 USDC to the test payer;
4. starts an isolated portable **Magpie 0.1.2516** (`MAGPIE_ADDR` on its own
   port; no user profile, no 3425);
5. creates the Gateway Key, signs the provider terms with the test payer,
   transfers 1 USDC to the provider receiving address, and runs the real
   `ChainWatcher -> Ledger -> Provisioner -> Magpie cap` path;
6. requires the event to be `credited`, the ledger to hold the credit, the cap to
   be `$1.01` (opening $0.01 + $1.00), Magpie to report both `costLimit` and
   `tokenLimit`, and the real Magpie usage to be zero.

Result on 2026-11-01:

| Chain | Fork block | Payer transfer tx | Final event | Ledger | Magpie cap | Token limit |
| --- | --- | --- | --- | --- | --- | --- |
| BSC 56 | 131,000,009 | `0xadd5dd36dbdd27bcce0d184fdeb81e8cfef839bf51632cd4e6e9109d1943fbc1` | `credited` | 1.01 USD | $1.01 | 490,408 |
| Base 8453 | 53,362,356 | `0xbc6764af1be5f3a4b258bbed876fce1b881469cc6941b3e7c6bfccbc830716a2` | `credited` | 1.01 USD | $1.01 | 490,408 |

The fork finality policy is `confirmations: 1` because Anvil does not reproduce the
public `finalized` tag. The production records keep their measured `finalized-tag`
policies; the same `finalityVerdict` code path is exercised, with a test-only depth.
The real Magpie limit readback is the same endpoint/CLI code the product uses.

Reproduce (requires network, Foundry, and `/Applications/magpie.app` 0.1.2516):

```bash
cd plugin
bun run scripts/production-fork-lab.ts both
```

The script deletes its temporary Anvil/Magpie data after the run unless
`KEEP_FORK_LAB=1` is set. It never writes to the user's Magpie profile or port 3425.

## 3. Production controls and remaining risks

| Control | Status | Detail |
| --- | --- | --- |
| Verified asset identity | **Implemented** | `(chainId, contract, decimals, symbol)` + issuer/bridge evidence; symbol-only matching refused. |
| BSC/Base equal selection | **Implemented** | No default/primary chain; provider selection is explicit; consumer cannot auto-switch. |
| Quote/price/generation binding | **Implemented** | Terms carry quote hash, price version and authorization generation; journal rechecks; quote change needs new terms. |
| Magpie soft-cap overshoot | **Bounded, not hard** | Cost cap + token cap + one-call reserve; residual overshoot is limited to in-flight admitted calls and is stated, not hidden. |
| Multi-RPC inconsistency | **Controlled** | Quorum >= 2, identical answers, min head/finalized; disagreement pauses the scan. |
| Finality | **Per-chain** | BSC finalized tag (measured 1 block), Base finalized tag (measured ~600 blocks). |
| Post-credit reorg | **Controlled** | Append-only reversal, negative balance/overdraft, key freeze, reactivation blocked until covered. |
| Unknown broadcast | **Controlled** | No auto retry; verified-hash adoption; pending/unknown UI recovery; explicit limitation when no hash exists. |
| Duplicate/concurrent credit | **Controlled** | Chain event id is the ledger deposit id; unique deposit/reversal; watcher single-flight; provisioner per-consumer lock. |
| Custody | **No custody claim** | Built-in vault is local and encrypted; same-host plugin code can read unlocked state. External wallet keeps keys in the extension. |
| Stablecoin valuation | **Peg assumption** | 1 USD per USDC by issuer redemption; depeg risk is a provider risk and is surfaced. |
| Automatic recharge | **Not full auto** | Reminder + one-click confirmation; no unattended mainnet signer. This does not block manual real payments. |
| Public RPC independence | **LIMITATION** | The default endpoints are public providers; quorum protects against one bad answer but does not prove independent operators. A provider can configure their own endpoints. |
| Browser wallet end-to-end | **UNKNOWN (stopped by user instruction)** | The adapter/UI code, EIP-6963 discovery, connect/network flow and EIP-712 screen were exercised with real Rabby in an isolated Chrome for Testing profile. The user stopped further extension automation; completion is left to the user. MetaMask under Chrome for Testing hit a LavaMoat/`eth_requestAccounts` error in this environment. No fake provider is shipped. |

## 4. User's small real-money test (the user executes this, not the agent)

Do not use the agent's test keys or any hot-wallet secret in a chat/session. Use a
small amount you can afford to lose.

### 4.1 Provider

1. Install/update the plugin at the delivered package or branch (see §5). Open the
   console from Magpie on the provider machine.
2. Wallet → 收款地址: add a BSC address and a Base address you control. The address
   is public; never paste a private key.
3. 接受哪些网络充值: select BSC, Base, or both. Do not select a chain you do not
   want to accept.
4. 我的共享: select a priced local model and publish. Approve the consumer's
   request with a small positive cap after checking the full fingerprint and quote.
5. Keep the provider online; the watcher needs to see the payment reach the
   chain's finalized tag.

### 4.2 Consumer

1. 发现: verify the provider's full fingerprint and current quote.
2. 充值: choose the provider, the network the provider actually accepts (BSC or
   Base), the verified USDC asset, and a small amount (for example 0.50 USDC).
3. 申请充值条件. Check the network, asset contract/decimals, exact amount, recipient
   address and the provider's authorization generation/quote.
4. Sign the EIP-712 terms with the built-in wallet or your browser wallet. The
   provider must verify the signature and return `waitingpayment`.
5. Preview the transfer. Check the chain, token, recipient, amount, nonce, gas and
   fee ceiling. Confirm once. The built-in path signs and broadcasts exactly one
   ERC-20 transfer; the browser-wallet path asks the extension to send it.
6. Keep the tx hash. The provider's watcher needs the receipt and the chain's
   finalized tag. Then the ledger books one deposit and raises the Magpie key cap.
7. Confirm in the consumer UI that the status is 已到账 and check the provider's
   native key cap. A broadcast is not a credit; a finalized, matched event is.

### 4.3 If something is unclear

- **No hash / wallet timeout:** open 付款恢复, refresh pending rows, and paste the
  hash from the wallet or explorer. The service verifies the exact transaction,
  receipt and Transfer before adopting it. Do not send a second transfer.
- **Reorg after credit:** the provider freezes the key and records a reversal. The
  consumer must not keep using the reverted credit; a covering deposit is needed
  before reactivation.
- **RPC disagreement/timeout:** the watcher pauses and retries. Do not change the
  receiving address or send a second payment because a scan is delayed.

## 5. Build and install

Build (run from the repository root):

```bash
cd plugin
bun install
bun run typecheck
bun run test
bun run boot-check
bun run secret-scan
cd ..
npm pack --pack-destination dist
shasum -a 256 dist/*.tgz
```

The package is `@oh-my-aihub/magpie-plugin`; install it through Magpie's local
package/Plugins flow, or use the branch GitHub address after the draft PR is
reviewed. The exact tarball name and SHA-256 are in `BUILD.md` next to this file.

## 6. What is not claimed

- The fork evidence is not a real mainnet payment. The agent did not sign, broadcast
  or spend real funds.
- Magpie's cap is not an absolute hard cap; the token limit and reserve reduce
  normal overshoot, they do not eliminate it.
- USDC is credited at face value; a depeg is not hedged.
- The public RPC quorum is not a proof of independent infrastructure.
- Browser-wallet completion (MetaMask/Rabby popups) was stopped by user
  instruction; the current code and observed limitations are retained.
- Automatic recharge is a reminder + one explicit confirmation, not a full-auto
  signer.
