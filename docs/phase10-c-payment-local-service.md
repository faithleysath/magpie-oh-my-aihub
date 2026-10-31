# Phase 10 C — authenticated local payment service

- Branch: `feature/phase10-c-payment-local-service`
- Base: PR #35 @ `fdb4383ca85978111832724a740ededd6f962ff8` / code `ead291f7342263a7d5ffea2f8b0d6f79897f3f7e`
- Scope: connect the core payment journal to the existing authenticated local console. No new server, no transaction send, no Ledger/cap write, no automatic top-up.
- Status: **local service + browser action port implemented and tested; not wired into the page UI; real P2P/extension/chain UNKNOWN; mainnet and real funds NO-GO.**

> The contract shared with the wallet UI (`3820537e`), local vault (`01060df1`) and B assembly (`8dd0cf10`) is `/tmp/oma-research/C-PAYMENT-LOCAL-ACTION-CONTRACT.md` (not committed; the repository contract is this document plus the code). The local vault's PR #38 uses the same `ConsoleActionContext` shape; the overlapping `console-server.ts`/`console-api.ts` hunks are a merge point for the integrator.

## 1. Server-owned session context

The existing console server now passes a context to every action callback:

```ts
interface ConsoleActionContext {
  sessionId: string;            // opaque secret; never returned/logged/persisted
  assertActive(): boolean;      // false after logout, idle/absolute TTL, stop, replacement
  isActive(): boolean;          // vault compatibility alias; same server closure
}
```

- The browser cannot send `sessionId`, `ownerInstanceId`, `providerIdentityFingerprint`, `authorizationGeneration` or any trusted-obligation field. The action body field allowlists reject them.
- The payment service maps one authenticated browser session to one session state/port facade. A session may have one active obligation/preview; a different obligation requires a new authenticated session (log out/in).
- Missing context is default-deny. The existing cookie/CSRF/Origin/Idempotency-Key UUID checks and idle/absolute TTL are unchanged; no session mechanism was loosened.
- Journal rows are service-owned and persist across logout/TTL: `reserved/broadcasting/broadcast/unknown` are visible via `pending`/`query` and never become a new send permit after re-login.

## 2. Actions

All actions use the existing `POST /ui/api/action/<name>` transport and `plugin/console/session.js`; no new HTTP route/server. Body fields are exact; extra fields are rejected.

| Action | Body | Result |
| --- | --- | --- |
| `payment-obligation-preview` | `{ obligationId }` | `{ obligationId, previewRef, previewExpiresAt, payment }` |
| `payment-operation-reserve` | `{ obligationId, previewRef, operation }` | journal reservation |
| `payment-operation-mark` | `{ obligationId, previewRef, reservationId, operation }` | `{ ok:true }` |
| `payment-operation-hash` | `{ obligationId, previewRef, reservationId, operation, hash }` | `{ ok:true }` |
| `payment-operation-unknown` | `{ obligationId, previewRef, reservationId, operation, reason }` | `{ ok:true }` |
| `payment-operation-query` | `{ obligationId, operation }` | journal query or `null` |
| `payment-operation-pending` | `{}` | sanitized pending records |

- `operation` is the exact approved external-wallet object. The server rebuilds the expected operation from the trusted binding and compares; the client operation is evidence, not authority. The server passes its own expected operation to the journal.
- `previewRef` is a UUID capability generated in server memory, bound to the session + obligation, with a 10-minute TTL. A fresh preview for the same obligation refreshes it; a different obligation is denied while the session has an active port.
- `reservationId` is the opaque journal reservation. The session must have won `reserved`; `claimed` rows from another session cannot mark/hash/unknown.
- No release action is exposed. Unknown/4001 release remains closed; reserved release stays a Service-side method with fresh owner-bound no-send evidence. 4001 is never independent release evidence.

## 3. Trusted obligation source

The service never trusts client-declared provider/recipient/amount/price. The read-only interface is:

```ts
interface TrustedObligationResolver {
  resolve(obligationId: string): {
    obligationId: string;
    binding: PaymentBinding;
    source: "local-wallet-intent" | "p2p-authenticated-request";
    verifiedAt: string;
  } | null;
}
```

Default local path (`LocalWalletObligationResolver`, restricted local testnet flow):

- reads `Wallet.chainStore().intent(obligationId)`;
- requires `status:"signed"`, `attributionStatus:"signed"`, recovered non-zero `payerAddress`, 32-byte `digest`, future `expiresAt`, enabled testnet chain 97/84532;
- requires the intent recipient to be a receiving address **published by this wallet** (`Wallet.receivingAddresses()`), with `addedAt <= intent.requestedAt`;
- provider identity = the persisted receiving-address authorization:
  `sha256("ohmyaihub.payment.local-provider/v1\n" + providerId + "\n" + chainId + "\n" + addressLower)`;
  `authorizationGeneration = floor(Date.parse(addedAt)/1000)`;
- asset contract/decimals must match the enabled registry asset; `intentHash = intent.digest`; `consumerAddress = intent.payerAddress`; `calldataHash` is recomputed from the fixed ERC-20 transfer;
- no signed local intent / no published address / unsigned / expired / cancelled / matched / mainnet / disabled asset → `null`; preview/reserve deny.

The journal's `identityAuthority` re-runs the resolver at reserve and mark. A changed/cancelled/expired request or a re-registered receiving address (new authorization epoch) fails closed. This is a restricted local testnet path, not a remote P2P payment and not a credit source.

Future B integration: B assembly persists authenticated P2P payment requests and supplies a resolver with `source:"p2p-authenticated-request"` and the real provider fingerprint/generation, invoice, chain/asset, recipient/amount/expiry. No offline JSON is accepted as the main path; until such a record exists, reserve is default-deny.

## 4. Browser port

`plugin/console/payment-local-port.js`:

```js
const operationPort = createConsolePaymentPort({
  callAction: (name, body) => session.action(name, body), // existing ConsoleSession
  obligationId,
  previewRef,
});
```

It exposes only `reserve`, `markBroadcasting`, `recordHash`, `recordUnknown`, `query`, and a UI-only `pending`; it never stores cookie/CSRF, never adds session/owner/provider fields, and has no release method. The approved external-wallet adapter consumes it as its `operationPort`.

## 5. Tests and evidence

Targeted (this branch, macOS arm64, Bun 1.4.3, SQLite 3.50.6):

```text
bun test ./test/payment-local-service.test.ts      9 pass / 0 fail / 80 expect
bun test ./console/payment-local-port.test.js      2 pass / 0 fail / 41 expect
bun test ./test/payment-operations.test.ts ./test/console-api.test.ts \
  ./test/console-security.test.ts ./test/console-wallet.test.ts \
  ./test/console-workflows.test.ts ./test/payment-local-service.test.ts \
  ./console/payment-local-port.test.js             110 pass / 0 fail / 2514 expect
```

Covered:

- real console authentication with two independent sessions on the same obligation: exactly one `reserved`, the other `claimed`; the second cannot mark/hash;
- logout and idle/absolute TTL: no new permit; a new session sees the persisted `unknown`/`broadcasting` row via `pending`/`query`; a fresh reserve stays blocked by that row;
- no trusted obligation: preview denied before any journal write; mainnet/unknown chain/expired/unsigned denied;
- client-declared `ownerInstanceId`/`sessionId`/`providerIdentityFingerprint` and operation tampering/extras rejected; the operation is compared to the server-built expected operation;
- one active obligation/port per authenticated session;
- default resolver unit cases plus a **real `Wallet` + `ChainStore` + signed intent** integration test;
- browser port fixed action names/bodies, no session/owner fields, no release.

Full local hermetic suite (same run):

```text
bun test ./test ./console ../docs/validation/lab/phase9/wallet-fixture
806 pass / 0 fail / 6396 expect / 56 files / 33.75s
```

Not covered / UNKNOWN: real MetaMask/Rabby extension, real testnet transaction, real P2P request from B, page UI wiring, receipt/credit. Mainnet 56/8453, real funds, automatic top-up: **NO-GO**.

## 6. Remaining integration work

- Wallet UI `3820537e`: render the signed local intent, call `payment-obligation-preview`, pass the returned fields to `createExternalWallet`, and use `createConsolePaymentPort`. Do not add a second session/context hook.
- Local vault `01060df1`: PR #38 already uses `{sessionId, assertActive, isActive}`; the console-server/console-api hunk overlap is a merge point. The default resolver reads the wallet/receiving-address persistence; no vault secret is exposed.
- B assembly `8dd0cf10`: persist authenticated P2P payment requests and implement the resolver. Do not use an offline JSON document as the production obligation path.
- Service/UI page integration, receipt verification and Ledger credit remain separate units. This service does not send, sign, credit or release unknown rows.
