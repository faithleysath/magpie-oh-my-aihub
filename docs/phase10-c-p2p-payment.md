# Phase 10 C — P2P payment request, signature exchange and verified obligation

- Branch: `feature/phase10-c-p2p-payment`
- Base: approved PR #44 `a50e0688375632bf28c08b0da16f45a91cd4d3f8` (base PR35 `fdb4383`)
- Scope: first small P2P unit only — authenticated payment request/terms/signature exchange, a durable consumer verified-obligation store/resolver, and payment status projection. **No UI, no real send, no automatic recharge, no Ledger/cap write, no mainnet/funds.**
- B reference: PR #45 commit `f39975c89f28aed32bf0f1458edb4735789f7507` was read only to align the narrow hook; no B transport code was copied and no B code is imported.

> Status: the C protocol/store/service is implemented and tested through a **synthetic authenticated port**. The actual B `payment_message` hook and real HTTP/EasyTier two-node path are **NOT installed** — this unit is incomplete as an actual remote P2P payment until that separate B extension lands. No `offline JSON` path is accepted as an obligation.

## 1. Coordination with B

B's payment-hook draft (`/tmp/oma-research/B-PAYMENT-HOOK-CONTRACT.md`) exposes
`P2pPaymentPort.onPaymentRequest(ctx)` / an outbound `queuePaymentRequest(sessionId, ...)`,
with an authenticated context carrying `from/to/sessionId/catalogQuoteHash/idempotency/
correlation/messageId/receivedAt/body`. B never interprets the body, never calls
`topUp`/`setCap`/Ledger/wallet/provider, and `credit_updated` stays B/ledger.

B confirmed a frozen-protocol conflict: `payment_request` currently has a strict
`{paymentId, amountUsd, network, memo}` body and is marked unsupported. C therefore
proposes a **new reviewed B type `payment_message`** (same signed envelope/AEAD/
session/outbox) with an opaque, bounded C body. This branch does not modify B core
#26 or the frozen B assembly; the actual hook is a separate B branch/review. C tests
use the `P2pPaymentMessagePort` interface; no B transport is duplicated.

The B-core real HTTP two-Service fixture (PR #47, base assembly45 `f39975c`) was not
copied; it is a collaboration reference for later real-wire tests only.

## 2. C payment frame (independent version)

`ohmyaihub/payment/v1`, kinds `request | terms | signature | status`, with
`requestId`, `invoiceId` (null for a request), authenticated `from/to`, bounded
`createdAt/expiresAt`, and a strict body:

- `request` (consumer → provider): explicit selection
  `{consumerId, providerNodeId, providerFingerprint, chainId, asset:{assetId,
  contractAddress, decimals}, amountRaw}`. No default chain, no symbol lookup.
- `terms` (provider → consumer): provider identity (node/fingerprint/current
  authorization generation/quoteHash/priceVersion), consumer id, chain/asset,
  recipient/amount, the public `DepositIntent`, EIP-712 typed data/digest and expiry.
- `signature` (consumer → provider): `{invoiceId, requestId, signature, payerAddress}`.
  The consumer's local wallet signs the EIP-712 digest; the provider verifies with the
  existing `Wallet.signIntent`/`verifyIntentSignature` and stores the payer in its
  ChainStore attribution.
- `status`: `waitingpayment | confirming | received | actionneeded`, bounded detail.

Hard network gate: **97/84532 only**. Product networks 56/8453 are rejected at a
request/terms/preview before any store; unknown chains are rejected. The provider
config also binds its allowed network/asset four-tuple; the provider wallet registry
must match the selected asset tuple exactly. There is no default mainnet chain and no
same-symbol contract guessing.

## 3. Provider terms and consumer obligation

Provider: `ProviderPaymentService.createTerms()` uses the existing local
`Wallet.requestIntent`/`DepositIntent`/EIP-712 to create terms; it validates the
consumer selection, provider identity/network/asset tuple, and the wallet registry. A
provider request is stored before the terms frame is sent; a retry with the same
`requestId` returns the same invoice/terms, and a different consumer fingerprint or
selection is a conflict.

Consumer: `ConsumerPaymentService.requestPayment()` persists the explicit selection
and sends a request. On authenticated `terms`, it requires the sender to be the
selected provider, validates the terms against the selection, checks the provider's
current quote/identity/authorization through the injected `PaymentPeerAuthority`, and
persists a verified obligation (status `actionneeded`, no binding yet). The user's
local wallet then signs the EIP-712 digest (`PaymentSigner` boundary); the signed
payer/address and binding are stored, status becomes `waitingpayment`, and the
signature frame is sent. A provider-side verification failure becomes
`actionneeded`; no received/credit state is created.

The consumer's `obligationResolver()` returns a `TrustedPaymentObligation`
(`source:"p2p-authenticated-request"`) only when the stored obligation is signed,
locally `waitingpayment`, the provider has acknowledged `waitingpayment` after
verifying the signature (peer status), and it is unexpired. A local signature alone
does not permit a send; confirming/received/actionneeded and a missing provider ack
deny the resolver. That resolver plugs into the approved `PaymentLocalService`,
whose existing preview/reserve/mark actions and journal remain the send gate. The
journal, not this module, decides the send permit.

## 4. Store and status

SQLite `p2p-payment.sqlite` (0600, WAL, FULL) stores selections, provider requests,
consumer obligations, and `(peerNodeId, idempotency)` message results. It contains
only public payment terms, public wallet addresses, the business signature/payer,
provider fingerprint/quote/generation and status/error codes. No seed, private key,
Gateway Key, ciphertext or raw transaction; no console/log/snapshot secret. Terms and
store JSON are size-bounded; a message idempotency key cannot be reused for a
different payload.

Status rules:

- a consumer signature only reaches local `waitingpayment`; the provider sends a
  `waitingpayment` status only after it verifies the signature, and the consumer
  resolver requires that peer ack before a send;
- `confirming`/`received` come only from a **local** `PaymentObservation` (the
  provider's Watcher/chain service), never from a remote message; peer status cannot
  regress from confirming/received to waitingpayment;
- the provider sends the status over P2P; the consumer stores it as `peerStatus`, not
  as local credit; its resolver denies a new payment once the peer reports
  confirming/received/actionneeded;
- `actionneeded` covers invalid signatures, authority/selection/terms mismatch,
  expiry and unknown local failures; no automatic re-send, no “unknown -> retry”.
- `received` never downgrades; a remote status cannot credit or reserve a cap.

## 5. Tests

Platform: macOS arm64, Bun 1.4.3, SQLite 3.50.6.

```text
bun test ./test/p2p-payment.test.ts
10 pass / 0 fail / 99 expect
```

Covered with a real local `Wallet`/`ChainStore`/`DepositIntent`/EIP-712 and a test
signer, over a synthetic authenticated two-endpoint port:

- provider terms create a real intent; consumer signs; provider verifies; the exact
  consumer binding is accepted by `PaymentLocalService` preview/reserve/mark (journal
  row `broadcasting`, no send);
- mainnet 56/8453, unknown chains and 31337 are gated before request/terms;
- stale provider quote, authorization generation, provider fingerprint and a
  self-consistent different-amount terms object are rejected; authority failure
  leaves no obligation;
- signature only reaches `waitingpayment`; provider local observation reaches
  `confirming`/`received`; the consumer's resolver denies new payment and no
  Ledger/cap is touched;
- expiry, invalid signature (provider `actionneeded`), same request/idempotency and
  duplicate signature do not create a second invoice; bounded outbound retry keeps
  one request; store is 0600 and contains no key/seed/private material.

Full local hermetic suite before the final two idempotency assertions:
**818 pass / 0 fail / 6503 expect / 57 files**. CI `41169827983` @ `f061ad4`:
**linux 818 pass / 0 fail / 6505 expect / 819 tests; macOS 817 pass / 0 fail /
6502 expect / 818 tests; both success**.

NOT verified: actual B HTTP/EasyTier two-node delivery, real MetaMask/Rabby, real
chain transfer/finality/reorg, receipt/Watcher integration, Ledger credit, page UI.
All are UNKNOWN / out of this first unit.

## 6. Non-goals and next integration

- No page UI, no automatic recharge executor, no real send, no Ledger/cap write.
- No real funds; real wallet signatures are only business evidence; a signature is
  never “received”.
- Mainnet 56/8453 and real funds: **NO-GO**.
- Next unit: B `payment_message` hook/outbound send with real HTTP/EasyTier; UI
  wiring using the approved external wallet/local signer; Watcher receipt/finality
  integration under the existing Ledger authority; independent review before any
  real testnet send.
