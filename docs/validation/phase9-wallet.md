# Phase 9 — testnet wallet browser evidence

**REPRODUCED:** real Magpie0.1.2171, Magpie-managed Bun1.4.4, EasyTier2.6.4 and the plugin's
production Wallet → ChainWatcher → ChainStore → Ledger → Provisioner → native Gateway Key.
Browser actor: ego Chromium156, macOS26.6.2 arm64. The separate external-wallet/RPC fixture uses
synthetic unfunded keys and local chain IDs97/84532 only. **No public-chain payment occurred.**
Historical real BSC/Base payments remain [PR11's separate evidence](2026-10-30-fresh-twohost-wallet.md).

## Actors and trust boundary

The provider creates requests and owns its private ledger. The consumer receives a file, verifies
it in its own console, signs in a separate external test-wallet page and privately returns the
signature. It has no provider-admin session or remote balance API. The product never receives a
wallet private key, broadcasts a transaction, swaps assets or contacts a payment intermediary.
The fixture's ephemeral unfunded scalar lives only in its separate process, not the product host
or browser storage, and is discarded on restart/reset/idle timeout.

All product operations below were visible UI actions, normal file selection/download and actual
Magpie browser pairing. The actor used no operator CLI, manual HTTP admin calls or state/database
edits. Maintainer preparation of a deterministic model and RPC simulator is distinct from the
business journey. The fixture says “本地模拟链，仅复用 chainId；未连接公链，未付款” on every page.

## Registry configuration and cursor handling

The provider's normal default RPC watchers had already recorded public heights before the local
fixture test. A local head19 would be behind those cursors. The fixture therefore uses a sparse
logical starting height1,000,000,000 while storing only20 blocks. This changes only test RPC data,
not production policy or the existing ledger/cursor.

Through the provider UI, the actor stopped observation, replaced each network's RPC with its
local simulation endpoint, and explicitly scanned while no assets were registered. The existing
no-assets path moved the cursor to the reported head. The actor then registered the fixture's
6-decimal BSC asset and18-decimal Base asset, with explicit contracts/decimals/fixed rate, and set
public receiving addresses. No asset/network was silently selected for a deposit. BSC and Base
use the same controls. The original contract/price data is recorded in the sanitized fixture
manifest, not inferred from a token symbol.

## BSC/97: complete visible journey

1. Select the existing consumer `17d77921`, explicitly select97, its registered6-decimal test
   asset and amount1. Preview shows exact raw1000000, recipient, rate, lifetime and request digest.
2. Confirm once and download the real EIP-712 deposit-request document. No invoice or Key credit
   is produced by preview alone.
3. Import the file in the separate synthetic wallet, inspect the exact document, check consent,
   sign and download the signature file. Import that file in the provider console and explicitly
   verify attribution. Only then does the product offer exact transfer instructions.
4. Import those instructions in the separate fixture and explicitly generate one **synthetic**
   Transfer in a new block1000000020. This is a local log/receipt, not a blockchain payment.
5. Start the production watchers through the console. The page discovers the event, validates
   its receipt and displays **0/15 confirmations**, with ledger application still waiting.
   [Before finality](phase9-browser/bsc-before-finality.txt).
6. Advance the local head15 blocks. Production policy reaches finality and applies one `$1`
   test credit. Until an explicit native Key readback, the UI remains **入账结果尚未证实**.
7. Refresh that consumer's evidence. The page independently verifies ledger application and
   native cap `$1.0001`, used `$0.0120`, remaining `$0.9881`.
   [After finality/readback](phase9-browser/bsc-after-finality.txt).
8. In consumer Magpie's own Remote provider “Test models” UI, the previously429 model succeeds.
   [Native restored result](phase9-browser/native-model-restored.json). The plugin did not proxy
   that model request.

## Base/84532: equal workflow, different finality

The actor created a new request for the same managed consumer by explicitly selecting84532,
its18-decimal test asset and amount1 (raw1000000000000000000). Consumer console imported and
verified the real wrapper/domain/digest before handing it to the external synthetic signer.
Provider signature verification and transfer-instruction export followed the same UI path.

The fixture generated a new Base event in block1000000020. Advancing head20 blocks while leaving
`finalized` behind **did not credit**; the page continued waiting for network finality.
[Before finalized](phase9-browser/base-before-finalized.txt). Only after explicitly advancing the
fixture's finalized block did production policy apply the second `$1` test credit.
[After finalized/readback](phase9-browser/base-after-finalized.txt).

## Duplicate, outage and account privacy

- **REPRODUCED duplicate protection:** the fixture's repeat button returned the same event, and
  an explicit production rescan left cumulative deposited credit at `$2.0001` (opening credit
  `$0.0001` plus two `$1` events). After two native model calls, consumed was `$0.0240`, balance
  `$1.9761`; no second credit was added by replay.
  [Account text](phase9-browser/accounting-after-duplicate.txt),
  [private account screenshot](phase9-browser/accounting-two-chain-credit.png).
- **REPRODUCED RPC outage:**97 RPC503 displayed an unverified RPC/scan warning while Base remained
  independently configured. It did not turn an earlier payment into “failed”. The fault was
  removed via the fixture and evidence refreshed through the product UI.
  [Outage state](phase9-browser/rpc-failure.txt).
- **REPRODUCED statement exchange:** provider selected that consumer, exported its unsigned
  statement, and consumer imported/verified its digest in its own console. The result is explicitly
  a private unsigned snapshot, not identity/payment/finality proof. No other consumer's account
  data or Gateway Key is present in the statement.

## Evidence limits and follow-up

This Chromium journey used installed candidate03d9981. Later narrow review fixes reject numeric
overflow before reservations, align statement import/export bounds, invalidate RPC evidence
caches and correct a missing-timestamp label; final-tree confirmation and WebKit financial run
are separately recorded in the final Phase9 report. The tests do not weaken existing native cap,
ledger idempotency, finality or reorg handling.

**REPRODUCED final WebKit follow-up:** [the nine-step UI result](phase9-browser/webkit-wallet.json)
created a new0.5BSC request through the same production file/signature path. Before finality,
cumulative credit/cap stayed2.0001; after15confirmations both reached2.5001, repeated event/scan
kept that total, and the consumer native model test succeeded. This run used provider39c297a
and consumer03d9981. All three installed production trees were subsequently updated and hashed
against cf9833e, and final consumption-history/security UI passed separately.

The fixture proves GUI → production business code → native credit behavior for controlled chain
responses. It does not measure RPC consensus, a real external wallet extension, a new public-chain
payment, chain reorganization probability or production-fund safety. Native overshoot and pricing
lock limits remain. **Real-money Production: NO-GO.**

The fixture source and reproduction/cleanup instructions are in
[wallet-fixture/README.md](lab/phase9/wallet-fixture/README.md). Final owned-process, listener,
private-file cleanup and source identity belong to the final acceptance report.
