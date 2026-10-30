# Phase 7 — multichain testnet wallet and deposit reconciliation

Status: **implementation complete and tested; local-chain lab PASS; real-testnet end-to-end UNKNOWN
(testnet gas could not be obtained).** Real funds remain **NO-GO** for the reasons in §13, which are
the phase-6 blockers plus the new ones this phase measured.

This note does not claim a testnet run happened. §9 states exactly which steps of the requested
end-to-end experiment were executed on a real chain, which were executed against a local EVM node,
and which could not be executed at all.

| Item | Value |
| --- | --- |
| Platform | macOS 26.6.2 (25G83), arm64 (Apple Silicon) |
| Bun | 1.4.3 |
| Foundry (`anvil`, `cast`, `forge`) | 1.8.6, commit `6bad0a66de7c83f7b33695044138f0f5fa4c5990` |
| Solidity | 0.8.24 (via forge) |
| Magpie | unchanged from phase 6: `0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| EasyTier | unchanged: `2.6.4` = `8428a89d2dabc94c97d370ec607c6ca142473626` |
| Base commit | `4f264d3` (merge of PR #7, whose head was the accepted `2fdd6b2`) |
| Chains | BNB Smart Chain testnet 97, Base Sepolia 84532 |

---

## 1. Multichain architecture and its extension points

Four modules, each with one job, plus one bridge:

| File | Responsibility |
| --- | --- |
| `plugin/src/networks.ts` | `NetworkRegistry`, `NetworkRecord`, `AssetRecord`, `FinalityPolicy`. Chain and token identity, enable/disable, RPC list, allowlist. No chain-specific code. |
| `plugin/src/evm.ts` | `EvmClient`: `eth_chainId` verification, blocks, `eth_getLogs`, receipts, `eth_call`. Refuses a wrong chain id; never infers from a missing field. |
| `plugin/src/chainstore.ts` | `ChainStore`: SQLite for events, intents, cursors, anomalies, decimals checks. Every uniqueness rule is a database constraint. |
| `plugin/src/watcher.ts` | `ChainWatcher`: one instance per chain. Scan → observe → attribute → finality → credit, with `finalityVerdict()` and `convertRawToNanos()` as pure functions. |
| `plugin/src/deposits.ts` | `DepositIntent`, the EIP-712 document, signature verification, and `matchesTransfer()`. |
| `plugin/src/wallet.ts` | The module's public surface: registry administration, receiving addresses, intents, watcher lifecycle, status. |
| `plugin/src/keccak.ts`, `secp256k1.ts`, `eip712.ts` | The three primitives needed to verify a consumer's signature without a wallet dependency. |

The integration point with the existing accounting is exactly one method,
`Provisioner.applyChainDeposit()`. It takes a deposit the ledger already holds and applies it the
same way `topUpLedger()` does: cap = `native used + ledger balance`, write, read back, then mark
applied. Nothing in the chain modules can reach a Magpie Gateway Key any other way.

**Why the primitives are hand-written.** Bun's `node:crypto` exposes `sha3-256`, which is a different
function from Keccak-256, and has no secp256k1 curve (`getCurves()` has no `secp256k1`). Verifying a
consumer's EIP-712 signature is therefore either a new native dependency inside the code that guards
credit, or ~200 lines of checked arithmetic. The latter was chosen and is verified against
`cast keccak`, `cast wallet sign --data` and `cast wallet verify`, plus the EIP-712 specification's own
Mail example (§10).

## 2. Evidence that BSC and Base are peers, not a primary and a fallback

The claim is testable, so it is tested (`plugin/test/networks.test.ts`):

- **No privileged vocabulary.** `JSON.stringify(registry.networks())` is asserted not to contain
  `primary`, `secondary`, `preferred`, `fallbackChain`, `isDefault` or `priority`.
- **Identical shape.** Both records are asserted to have the same key set, so neither carries a field
  the other lacks.
- **No chain branching in business logic.** `grep` over `ledger.ts`, `provisioner.ts`,
  `chainstore.ts`, `deposits.ts` and `watcher.ts` finds no `97`, `84532`, `56` or `8453` literal. The
  only chain ids in the tree are in `DEFAULT_NETWORKS`/`RESERVED_MAINNETS` (data) and in the two lab
  scripts, which name their chain explicitly.
- **Independent enable/disable.** Disabling 97 leaves 84532 enabled, and vice versa, and the choice
  survives a reload (a seeded default is never silently re-enabled).
- **A third chain is data.** `plugin/test/networks.test.ts` registers chain 31337 by adding a record
  and then registers an asset on it, with no change to the ledger or the deposit state machine. The
  local lab (`scripts/chain-lab.ts`) runs the *whole* pipeline on that third chain, which is the
  strongest available evidence: the code that credits a Base deposit is the code that credited an
  anvil deposit.
- **Mainnet is refused, twice.** `RESERVED_MAINNETS` (56, 8453) exist so the shape is complete and
  are always `enabled: false`. `NetworkRegistry` throws if a document enables one, `setNetworkEnabled`
  throws, and `requireEnabledNetwork` throws — three independent refusals, each tested.

## 3. Networks and assets actually enabled

| Network | chainId | Type | Enabled | Finality policy |
| --- | --- | --- | --- | --- |
| BNB Smart Chain Testnet | 97 | testnet | yes | `confirmations`, 15 |
| Base Sepolia | 84532 | testnet | yes | `finalized-tag` |
| BNB Smart Chain | 56 | mainnet | **no** | reserved |
| Base | 8453 | mainnet | **no** | reserved |

Assets: **none are shipped in the repository.** An asset is registered at runtime, after the chain
has been asked for `decimals()`, and only then can a deposit name it. The repository contains no
contract address, because inventing one would be exactly the mistake §4 of the brief forbids. The
addresses this phase actually deployed are in §9.

Asset identity is `eip155:<chainId>:<contract>`, lower-cased. Two chains may both have a token called
`tMOCK6` at the same address and they are different assets — tested. `registerTestAsset()` refuses a
symbol or name that does not say it is a mock or a test token, so `USDC` cannot be registered on a
testnet through this path — tested.

## 4. Mock token deployment

`plugin/lab/chain/src/MockERC20.sol`, Solidity 0.8.24, no imports, no proxy, `decimals` immutable and
set at construction. It is not a fork of any real token and the symbol is `tMOCK6` / `tMOCK18`.

```bash
mise x foundry -- forge build --root plugin/lab/chain
mise x foundry -- forge create src/MockERC20.sol:MockERC20 --root plugin/lab/chain \
  --rpc-url <rpc> --private-key <key> --broadcast \
  --constructor-args "Mock Test Dollar" tMOCK6 6
```

Deployment addresses: see §9. The repository ships **no** address; a deployment is recorded only with
its transaction hash in a lab report.

## 5. Deposit-event uniqueness

The unique key is `(chainId, tokenContract, txHash, logIndex)`, and it is a **database index**, not a
JavaScript set:

```sql
CREATE UNIQUE INDEX one_event_per_log
  ON deposit_events(chain_id, token_contract, tx_hash, log_index);
CREATE UNIQUE INDEX one_deposit_per_event
  ON deposit_events(deposit_id) WHERE deposit_id IS NOT NULL;
CREATE UNIQUE INDEX one_intent_per_nonce ON deposit_intents(nonce);
CREATE UNIQUE INDEX one_intent_per_event
  ON deposit_intents(claimed_event_id) WHERE claimed_event_id IS NOT NULL;
```

Consequences, each tested in `plugin/test/deposits.test.ts`:

| Situation | Result |
| --- | --- |
| The same log scanned 1×, 2×, 3× | one row; `observations` = 3 |
| Two `Transfer`s in one transaction | two rows (different `log_index`) |
| The same tx hash on BSC and on Base | two rows |
| A rescan from block 0 after a credit | zero new events, zero new credits |
| Two consumers claiming one event | the second claim throws; the first is kept |
| One intent claiming two events | the second claim throws |
| One event backing two ledger deposits | the second `markCredited` throws |

Dedupe is **not** by tx hash: `plugin/test/deposits.test.ts` stores three logs from one transaction and
asserts three rows.

## 6. Consumer attribution

The mechanism is a signed deposit request, not a guess:

1. `wallet intent` writes a row with `invoiceId`, single-use `nonce`, exact `chainId`, `assetId`,
   `tokenContract`, `recipientAddress`, `expectedAmountRaw`, `requestedAt`, `expiresAt`.
2. The plugin returns the EIP-712 document. Its domain carries `chainId` and a fixed
   `verifyingContract` (`0x…a1b2`, not a deployed contract: it only separates this signature space);
   its message carries every field above plus `consumerId` and `providerId`.
3. The consumer signs with their own wallet and returns the 65-byte signature **and the address they
   signed with**.
4. The plugin recovers the signer locally and requires the recovered address to equal the stated one,
   then stores it as `payerAddress`.
5. A `Transfer` claims the intent only when chain, token, recipient, amount and `from` all match
   exactly, the intent is unexpired, and **exactly one** candidate matches.

Every refusal is tested (`plugin/test/deposits.test.ts`, 30 tests):

| Attempt | Result |
| --- | --- |
| Cross-chain replay (sign Base, bind BSC) | refused |
| Sign a different amount or invoice | refused |
| Consumer bound to wallet A, signature from B | refused |
| Garbage / empty / all-zero signature | refused, no address returned |
| High-s (malleable) signature | refused (EIP-2) |
| Swap a signature onto an already-signed intent | refused |
| Reuse a nonce | refused |
| Two identical intents from one payer | event marked `uncertain`, nothing credited |
| Transfer from an unsigned payer (exchange, contract) | `unclaimed`, never credited |

**A finding worth stating plainly.** A signature over a *different* document still recovers to *some*
address — it does not fail. An earlier version of `signIntent` therefore bound an invoice to a random
address that nobody controls, which would have made the real consumer's payment unclaimable. The fix
is that the caller must state the payer address and it must equal the recovered one. This is why the
CLI takes `wallet sign <invoiceId> <signature> <payerAddress>`, and it is the reason the test
"a signature over another document recovers a different address" exists.

## 7. Finality per chain, with the measurements

Measured 2026-10-30 from three endpoints per chain:

| Chain | `latest` | `safe` | `finalized` | lag(`finalized`) | block time |
| --- | --- | --- | --- | --- | --- |
| BSC testnet 97 | 139,727,894 | 139,727,894 | 139,727,893 | 1 | 0.44 s |
| Base Sepolia 84532 | 52,032,487 | 52,032,235 | 52,026,916 | 5,571 | 0.20 s |

- **BSC testnet reports `finalized` ≈ `latest` on every endpoint tried** (publicnode, the bnbchain
  seed node, thirdweb). The tag therefore carries no depth information on this chain, whatever the
  consensus argument for one-block Parlia finality is. A `finalized-tag` policy here would credit at
  depth 0, which is not a verifiable condition. The implemented policy is `confirmations: 15`
  (≈6.6 s), stated as a conservative substitute rather than as a chain guarantee.
- **Base Sepolia's `finalized` lags by ~5,100–7,200 blocks (≈17–24 min) and three independent
  providers agree on the value.** That is the L2's inherited L1 finality, so the tag *is* meaningful
  here and is used directly (`finalized-tag`).
- A single global confirmation count would either credit BSC at a depth Base considers unsafe or
  delay BSC by ~17 minutes for no reason. Each policy is a field of its own `NetworkRecord`, with its
  `rationale` and its `measured` block recorded alongside it, and `plugin/test/networks.test.ts`
  asserts the two policies differ and that a third chain brings its own.

`finalityVerdict()` is pure and tested against both policies at the same heights, including "a chain
that cannot answer the finalized tag never finalises under that policy".

## 8. Idempotency, crashes and reorgs

The distinction the brief requires — *the chain confirmed a payment* vs *Magpie's credit went up* —
is modelled as `observed → confirming → finalized → crediting → credited`, with `unclaimed`,
`uncertain`, `reverted`, `failed` and `manualReview` as branches. Only `finalized` may be credited.

The deposit id is derived from the chain event: `chain:<chainId>:<contract>:<txHash>:<logIndex>`. So:

| Crash point | What happens on restart |
| --- | --- |
| After the event row, before the ledger booking | the next scan sees `finalized`, books the same id |
| After `depositIntent`, before the cap write | the ledger row exists as `intent`; `applyChainDeposit` completes it |
| After the cap write, before the local commit | `rec.pending` is on disk; `Provisioner.reconcile()` finishes it |
| After `credited`, before anything else | the event is `credited`; nothing is retried |
| Mid-scan RPC failure | the cursor does not advance; the page is re-read on the next scan |

Tested in `plugin/test/watcher.test.ts` (36 tests) and `plugin/test/chain-credit.test.ts` (7 tests),
including: a failed `applyDeposit` retried with the same id; a ledger that refuses the booking leaving
the event for later; an RPC outage leaving the cursor untouched; a corrupt cursor repaired by an
explicit `rewindCursor` that also writes an anomaly.

**Reorgs.** A credited event whose block hash changed is set to `reverted`, an anomaly row is written,
and the ledger account is paused. The deposit row is **not** deleted and the balance is **not**
adjusted: `ledger.balance()` is asserted unchanged after a revert, and the consumer is asserted
paused. Anvil's `anvil_reorg` proves this on a real node (§9).

**A bug this testing found in my own code.** `applyChainDeposit()` first read
`ledger.balance()` without the deposit it was applying — the deposit is still an `intent` at that
point, and `balance()` counts applied deposits only. With two deposits in flight the cap was set too
low, leaving the newer credit unenforced. Fixed by adding the amount explicitly; the two-chain test
now asserts the cap covers both.

## 9. What was actually executed on a chain

### 9.1 Local EVM node — REPRODUCED (17/17 steps)

`plugin/scripts/chain-lab.ts` against `anvil` (chain id 31337), with a real deployed ERC-20, real
`eth_getLogs` output and real receipts. Raw report: `docs/validation/phase7-chain-lab-report.json`.

```
mise x foundry -- anvil --port 8547 --host 127.0.0.1
bun plugin/scripts/chain-lab.ts --provider-key-file <keys> --consumer-key-file <keys> \
    --out docs/validation/phase7-chain-lab-report.json
```

Steps, all PASS:

1. the node answers chainId 31337;
2. the deployed token reports 6 decimals;
3. the asset registers as `eip155:31337:0x…`;
4. the consumer is funded;
5. the EIP-712 signature recovers to the consumer's own address (signed with `cast wallet sign --data`);
6. a real `transfer()` is sent from the consumer's wallet;
7. `eth_getLogs` returns the log, decoded to the exact base-unit amount;
8. the scan stores, claims, finalises and credits it once;
9. `2500000` raw → `2500000000` nanos, dust 0;
10. the ledger holds exactly one deposit, applied once;
11. a deliberate full rescan from block 0 adds nothing and credits nothing;
12. a second consumer paying the *same* provider address is attributed to itself;
13. an unsigned stranger's transfer stays `unclaimed` and credits nothing;
14. `anvil_reorg` rewrites the credited block;
15. the credited event becomes `reverted`, the consumer is frozen twice (two credited events), the
    deposits stay.

The reorg step's `deposits 2` is the assertion that matters: two credits existed, two freezes were
recorded, and no deposit row was removed.

### 9.2 Real testnet — UNKNOWN

Both chains answer RPC and report the expected chain id:

```
BSC Testnet  chainId 97     head 139727894  finalized 139727893
Base Sepolia chainId 84532  head 52032487   finalized 52026916
```

`plugin/scripts/testnet-lab.ts` was written for the real run and was executed. It reached the gas
check and stopped:

```
PASS  [97]    rpc chainId: BNB Smart Chain Testnet: the endpoint answers chainId 97
FAIL  [97]    provider gas: provider holds 0 wei of tBNB
UNKNOWN [97]  deploy mock token: no testnet gas, so nothing could be deployed on this chain
PASS  [84532] rpc chainId: Base Sepolia: the endpoint answers chainId 84532
FAIL  [84532] provider gas: provider holds 0 wei of ETH
UNKNOWN [84532] deploy mock token: no testnet gas, so nothing could be deployed on this chain
```

Getting testnet gas was attempted and failed for reasons outside the code:

| Faucet | Outcome |
| --- | --- |
| `bnbchain.org/en/testnet-faucet` | hCaptcha image challenge; needs a human |
| `faucet.chainstack.com/bnb-testnet-faucet` | requires ≥ 0.08 ETH on Ethereum **mainnet** |
| `alchemy.com/faucets/base-sepolia` | Cloudflare Turnstile passed, then "Insufficient balance! You need at least 0.001 ETH on Ethereum Mainnet" |
| `faucets.chain.link/base-sepolia` | requires a wallet connection / account |
| `faucet.quicknode.com` | requires a wallet connection |
| `console.optimism.io/faucet` | requires sign-in |
| `bsc-testnet-faucet.pk910.de` | the hostname does not resolve (NXDOMAIN on 1.1.1.1 and 8.8.8.8) |
| `hackquest.io/faucets/97` | drips 0.001 TBNB/day and its own balance is nearly empty |

So **§14C of the brief is UNKNOWN**: no testnet token was deployed, no testnet transfer was sent, and
no testnet tx hash is quoted in this document. Claiming otherwise would be exactly the failure mode
the brief forbids ("do not pass a local mock RPC off as a real-chain verification").

What *is* REPRODUCED against the real chains is read-only and non-trivial: `eth_chainId` verification,
block/`safe`/`finalized` reads, `eth_getLogs`, `eth_getTransactionReceipt` and `eth_call` `decimals()`
against live BSC and Base Sepolia endpoints, with the measured numbers in §7. Those are the code paths
the watcher uses on every scan.

To finish §14C once gas exists:

```bash
bun plugin/scripts/testnet-lab.ts --keys <file with provider and consumer keys> \
    --chains 97,84532 --out docs/validation/phase7-testnet-report.json
```

The script deploys 6-decimal `tMOCK6` on BSC and 18-decimal `tMOCK18` on Base, registers each after
reading `decimals()`, signs an intent, transfers from the consumer, waits for that chain's own finality
policy (5 s polling on BSC, 15 s on Base), asserts one ledger booking, and asserts a rescan adds
nothing. It refuses a mainnet chain id outright.

### 9.3 Gateway Key, 429 and 200 — REPRODUCED against a contract-faithful fake

The requested "real Magpie call, 429 at the cap, 200 after a new deposit" was executed against the
fake in `plugin/test/chain-credit.test.ts`, which models Magpie's reservation rule (a call that cannot
be afforded is refused before the upstream). The sequence asserted:

1. `ensure()` opens a key with a $0.0001 opening credit;
2. a finalized chain deposit raises the cap to $2.0001 and `pending` is null;
3. a call costing $0.0012 is admitted (it could not be at $0.0001);
4. a call costing $1.50 is admitted, `used` = $1.5012;
5. the next $1.50 call is refused with 429 ($0.4989 left);
6. a second chain deposit raises the cap and a call is admitted again.

This is a test of the plugin's arithmetic and ordering, not of Magpie. The real-Magpie half is the
phase-6 lab plus the not-yet-run testnet step.

## 10. Crypto primitives: the vectors

| Function | Verified against |
| --- | --- |
| `keccak256` | `cast keccak ""`, `"abc"`, the Transfer topic, `"Hello, Bob!"`, 136 zero bytes, 1 zero byte |
| not SHA3 | asserts the empty-string digest is **not** `0xa7ffc6f8…` |
| EIP-712 `encodeType` / `typeHash` | `cast keccak "Mail(address from,address to,string contents)"` |
| EIP-712 domain separator | the specification's own Mail example: `0xf2cee375…` |
| EIP-712 full digest | the specification's `0xbe609aee…` is *not* reproduced because alloy (and therefore `cast`, MetaMask and every modern wallet) hashes the domain as declared; the digest is instead verified two ways: the signer recovers correctly, and an independent `cast keccak` composition of `0x1901 ‖ domain ‖ message` gives the same 32 bytes |
| `recoverAddress` | `cast wallet sign "hello"` + `cast wallet verify`, and `cast wallet sign --data` on the Mail document |
| EIP-2 high-s | a mirrored signature is refused |
| EIP-55 checksums | the five reference vectors |

One honest note on the Mail example: the published expected digest in EIP-712's prose does not match
what current implementations produce for that document (the domain hash differs), and alloy's output —
which is what real wallets do — is what the plugin matches. The test asserts the value that a wallet
actually signs, verified by recovering the known signer, rather than the prose value.

## 11. Ledger and provisioner integration

Dataflow, as required, with no shortcut:

```
chain log → observeEvent (unique row) → claim (one intent) → finalityVerdict (per-chain policy)
  → convertRawToNanos (bigint, floor, dust recorded)
  → Ledger.depositIntent(id = chain:<event>)      ← the only booking
  → Provisioner.applyChainDeposit(id)             ← cap = native used + ledger balance, write, read back
  → Ledger.markDepositApplied                     ← only after the read-back
  → Magpie Gateway Key
```

- The chain module **cannot** call `Magpie` at all: `CreditSink` has four methods and none of them is
  a key operation.
- There is no second balance. `Wallet.consumerChainCredit()` reads `Ledger.balance()`.
- Amounts are `bigint` from the log data to the nano-USD conversion. `convertRawToNanos` takes
  `bigint` and returns `{ nanos, dustRaw }`; an 18-decimal amount of `12345678901234567890` base units
  converts without precision loss (tested), which a `Number` could not do above 2^53.
- The conversion records `assetId`, `rawAmount`, `decimals`, `nanosPerToken`, `priceVersion`, `rateAt`,
  `rounding: "floor"` and the leftover `dustRaw`. A fixed test rate is a versioned
  `AssetPricing` (`fixed:<chain>:<symbol>:<rate>:v1`), so changing it cannot silently reprice history.

## 12. The two external links, and the absence of any buy feature

The links appear in `plugin/page/index.html`, section `how-to-get-assets`, as plain `<a>` elements:

```html
<a href="https://www.bnbchain.org/en/blog/moving-from-a-centralized-exchange-to-bnb-chain"
   target="_blank" rel="noopener noreferrer external">BNB Chain: how to move assets to BSC and obtain stablecoins</a>
<a href="https://docs.peer.xyz/guides/zh/alipay-buy"
   target="_blank" rel="noopener noreferrer external">Peer: buyer's guide — buying with Alipay</a>
```

Checked properties: fixed HTTPS URLs with no query string; no address, amount, consumer id, invoice
or referral parameter appended; no auto-redirect; `rel="noopener noreferrer external"`; the section
states "third-party websites, not part of this product"; the page sends nothing to them (it cannot —
`connect-src 'none'`); and a paragraph says the guides are about real mainnet assets and do not buy
test tokens. The page explicitly does not claim Peer or Alipay has any partnership with this project
or is a licensed financial service.

**No buy feature exists.** `grep -ri` over `plugin/` for `swap`, `bridge`, `buy`, `exchange`, `fiat`,
`alipay`, `binance` (as an API), `referral`, `affiliate` finds only the two link URLs and the
disclaimers. There is no SDK, no order form, no price comparison, no account linking, no embedded
browser, no fiat order tracking, and no code path that credits on a "payment complete" page.

## 13. Risks and UNKNOWNs that still block real money

Inherited from phase 6 and unchanged:

1. **No price lock in Magpie.** A price edit recomputes past charges. The ledger pauses on detection,
   but a call inside the detection window can still be repriced.
2. **Overshoot has no closed form.** A reservation-based cap plus a streamed response can exceed the
   cap slightly; the provider absorbs it.
3. **Interrupted calls** that never write a usage row are unbilled on both sides.

New in phase 7:

4. **No real-testnet deposit has been executed** (§9.2). The code paths are the same ones the local
   chain exercised, but "it worked on anvil" is not "it worked on BSC and Base".
5. **BSC's finality policy is a substitute, not a measurement.** The testnet RPCs do not expose a
   meaningful `finalized` tag, so 15 confirmations is a conservative choice; no reorg-depth
   distribution was measured on BSC testnet, because no reorg was observed in the lab window.
6. **A shared receiving address with identical amounts is ambiguous by design.** Two consumers paying
   the same amount from the same wallet to the same address produce `uncertain`, not a credit. That is
   safe but it is a real usability limit; per-consumer addresses or amount uniqueness would fix it and
   are out of scope here.
7. **Attribution depends on the consumer keeping their key.** If a consumer pays from an exchange
   withdrawal address, the transfer is `unclaimed` forever without manual review. There is an anomaly
   table and a CLI, not a resolution workflow.
8. **The watcher trusts the configured RPC for the log's existence.** It cross-checks the receipt and
   the block hash, and re-checks the block at finality time, but a provider that lies consistently
   about a block *and* its hash would not be caught. Multiple endpoints are supported and health is
   reported; there is no consensus read.
9. **`anvil_reorg` and the local chain are not BSC or Base.** The reorg test proves the state machine,
   not the chains' reorg behaviour.
10. **The plugin page is read-only for the wallet.** It shows the snapshot; enabling a network,
    registering an asset, creating or signing an intent are CLI/API operations, because Magpie serves
    plugin pages with `connect-src 'none'`.
11. **No HD wallet, no per-consumer addresses.** Deliberate: the brief forbids expanding scope to
    mnemonic custody, and the plugin stores no private key at all.

## 14. Test counts, CI and PR

- `bun test`: **360 tests, 0 failures, 1307 assertions, 22 files** (was 239 before this phase; +121).
- `bun run typecheck`: clean.
- `bun run boot-check`: PASS.
- `bun run secret-scan`: PASS, and it was proved to still fail on a leaked key: a labelled
  `privateKey = "0x…"` and a bare 64-hex line in a keys file are both reported.

New test files and what they cover:

| File | Tests | Covers |
| --- | --- | --- |
| `test/keccak-eip712.test.ts` | 24 | keccak, EIP-712 encoding, secp256k1 recovery, EIP-55, malleability |
| `test/networks.test.ts` | 24 | registry equality, mainnet refusal, third chain, asset identity, decimals, finality policies |
| `test/deposits.test.ts` | 30 | intent binding, cross-chain/replay/impersonation refusal, claim uniqueness |
| `test/watcher.test.ts` | 36 | scanning, dedupe, reorg, finality, crash/restart, RPC failure, chain independence, decimals check |
| `test/chain-credit.test.ts` | 7 | the closing loop: chain → ledger → cap → 200/429 → new deposit → 200 |

| Item | Value |
| --- | --- |
| PR | https://github.com/faithleysath/magpie-oh-my-aihub/pull/8 |
| Commit | `14b68da8ab68b61e83b4caffc12676d2a0f2e76e` (`feature/multichain-testnet-wallet`) |
| Actions | https://github.com/faithleysath/magpie-oh-my-aihub/actions/runs/40994031453 |
| `plugin (linux, bun 1.4.3)` | SUCCESS |
| `plugin (macos, bun 1.4.3)` | SUCCESS |
| Merge state | `MERGEABLE` / `CLEAN` against `main` at `4f264d3` |
| Tests | 370 passing, 0 failing, 1352 assertions, 23 files |
| Base commit | `4f264d3` — the merge of PR #7, whose head was the accepted `2fdd6b2` |

## 15. Cleanup

- The anvil node used for the lab was a local process on `127.0.0.1:8547`; its chain data is in a
  temporary directory and no key was written to the repository.
- The throwaway provider/consumer keys used by the lab live only in `/tmp` (`0600`) and are not in
  the tree: `bun run secret-scan` passes, and it was proved to fail on a leaked key both as a labelled
  `privateKey = "0x…"` and as a bare 64-hex line in a keys file.
- `plugin/lab/chain/out/` and `cache/` (forge artefacts) are gitignored and were removed.
- The one anvil reorg left that node's chain in a reorged state; it was discarded with the temporary
  directory rather than reused.
- No testnet transaction exists to clean up, because none was made (§9.2).

## 16. GO / NO-GO

**GO for continued development of the multichain testnet deposit flow.** The registry is genuinely
equal-network, the uniqueness and attribution rules are database constraints with tests behind them,
a crash at any point retries the same deposit instead of minting a second one, and the whole pipeline
ran end to end on a real EVM node including a reorg.

**NO-GO for real funds**, unchanged from phase 6 and for the additional reasons in §13: Magpie still
has no price lock, overshoot has no closed form, no real-testnet deposit has ever executed, BSC's
finality policy is a substitute rather than a measurement, in-flight and interrupted calls are still
unbilled, and the watcher has no consensus read.
