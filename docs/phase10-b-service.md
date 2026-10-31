# Phase 10 B — control service / Service integration

Status: **DOING**. This document is an implementation report, not an acceptance
certificate. It separates what is implemented from what is only simulated and from
what has not been run against the real Magpie 0.1.2289 / EasyTier 2.6.4 pair.

Branch: `feature/phase10-b-control-service` in
`/Users/laysath/.paseo/worktrees/1z728cdk/b-service`.
The branch **does not** copy, modify or run the user's installed Magpie app or data.

## 1. Scope and boundary

B-service owns the part of B that turns B-core's protocol/session state machine into
a real local control endpoint and wires it to the existing plugin service:

- a bounded HTTP transport with three exact routes, no CORS, no browser origins, an
  exact Host allow-list, pre-authentication rate limits, body/time/concurrency caps
  and sanitised error codes (`plugin/src/control/http.ts`);
- a narrow `P2pApprovalPort` adapter over the existing Service/Provisioner paths
  (`plugin/src/control/service-port.ts`):
  - quote/policy validation and human approval reuse
    `Service.approveConnectionRequest` (which itself calls
    `validateRequestApproval`, `assertShareable`, `shareCandidates` and the consumer
    generation checks);
  - the one-time key uses `Service.handover` (share guard + Provisioner read-back),
    never a second key store;
  - consumer registration uses `Service.addProvider` (overlay probe → native Remote
    Magpie registration → model read-back) and `Service.providerModels` for the
    model/cap read-back;
  - revoke uses `Service.revokeConsumer`.
- B-core still owns every cryptographic operation, envelope, handshake, session,
  SQLite replay/idempotency/outbox row and business transition. B-service does not
  add a crypto or identity module.

The control plane is **not** the Magpie administrative API, not the AI gateway, and
not a new central service. The Catalog stays read-only (`GET`). Inbound remains Drop
with zero rules; Forward only targets a listener that is actually ready.

## 2. Message flow (target; end-to-end still UNKNOWN)

```
consumer                                     provider
  catalog quote + accepted fingerprint
  POST /p2p/v1/hello           ─────────────▶  signed TOFU verdict
  ◀──────────── server_hello + session
  signed connection_request    ─────────────▶  validate quote/models/policy
                                               (no key yet)
  ◀──────────── status: awaiting-approval
                                               human: models + positive cap
                                               one action = approve + key + delivery
  ◀──────────── approved (metadata only)
  ◀──────────── authorization_delivery (sealed to this session)
  open AEAD, validate approval/quote/models/cap/key
  Service.addProvider + providerModels readback
  signed ack (registered + readback) ───────▶  approval acked
```

ACK is after registration, never a prerequisite. A lost ACK leaves the Remote
registered; retry uses the same approval/authorization and never creates a second
Recovery uses B-core's stored approval/delivery state, not a transport session.
Sessions are not resumed after restart; a new handshake reuses the same business
approval and the same key, or reports `action-needed`.

## 3. HTTP boundary (implemented)

| Method | Route | Body | Result |
| --- | --- | --- | --- |
| GET | `/p2p/v1/health` | none | `{ok, protocol}` (no listener/identity/port) |
| POST | `/p2p/v1/hello` | signed hello, ≤8 KiB JSON | signed server_hello |
| POST | `/p2p/v1/frame?session=<32hex>` | binary frame, ≤32 KiB | `204` or `{code}` |

Implemented policy:

- exact route strings only; trailing slash, unknown method, percent-encoded path and
  extra/duplicate query parameters are refused;
- exact `Host` match (case-insensitive, port included); missing Host, wrong port, DNS
  name, comma list, userinfo and trailing dot are refused;
- any `Origin` or `Sec-Fetch-*` header is refused; no CORS header is ever emitted;
- `Content-Type` exact (`application/json` with optional utf-8 for hello,
  `application/octet-stream` for frames); compressed bodies refused;
- declared and streamed body limits; invalid `Content-Length` refused;
- global token bucket first, then per-peer/route bucket, before body read and before
  the node call; bounded global/per-peer concurrency; bounded work timeout;
- node errors are reduced to the stable B-core code allow-list; unknown codes and
  plain errors become `internal` with no message; successful frame responses carry
  no business metadata;
- responses are `no-store` + `nosniff`; health contains only `{ok, protocol}` — no
  node id, key, fingerprint, consumer, cap, listener/port or catalogue data. Listener
  exposure is reported only through the authenticated local status projection.

The server wrapper refuses a wildcard bind unless the caller explicitly allows it,
and refuses to label a non-loopback bind `loopback-only`. A LAN-reachable bind must
be reported as `lan-reachable`; the diagnostic must not claim overlay-only.

## 4. Service integration (implemented at adapter level)

- `validateRequest` is read-only. It checks the current signed quote hash and identity
  fingerprint, the provider's mapped `/32` and gateway port, the request's accepted
  price version, and the current `shareCandidates()` policy/complete-price list. It
  returns only models the provider could currently approve; it creates no key.
- `approveRequest` converts the v2 request into the existing v1 request shape **only
  for the Service call**, then calls `Service.approveConnectionRequest`. The human
  selected models are a subset of the request. The adapter returns the selected-model
  price version; B-core must persist it **alongside**, not instead of, the full quote
  `billing.priceVersion` and the selected model snapshot. The current B-core code
  stores the all-eligible validation version, which is a required fix in the
  contract. Full quote hash, full quote price version, requested-subset version,
  approved-subset version and the selected model list are distinct bindings; the
  delivered authorization carries the full `contentHash` plus the selected version.
- `readKeyMaterial` rechecks the Provisioner record (key id/name, models, cap,
  accepted quote hash, price version) before and after `Service.handover`; a changed
  quote, cap, model scope, key generation or paused consumer fails before a key is
  returned for sealing.
- `registerAuthorization` validates the v2 document binding (provider/consumer
  identity, approvalId/requestHash, quote, models, cap, key id/name/hash), then calls
  `Service.addProvider` with a deterministic provider id derived from the provider
  node id. It reads the model list and `costLimit` back with
  `Service.providerModels`. A mismatch removes only that Remote and throws; no ACK is
  produced.
- `revokeConsumer` calls `Service.revokeConsumer`. A vanished consumer is idempotent;
  a real Magpie failure propagates so B-core must not send a “revoked” claim.
- The Gateway Key is passed to B-core only for sealing. It is not written to
  `p2p.sqlite`, not logged, not placed in a generic response cache, and not included
  in the action API.

## 5. Action API contract for B-ui

B-ui integrates later; this branch only defines and tests the backend contract.
Normal UI shows three buckets — `pending`, `connected`, `action-needed` — and folds
technical details.

Read-only state (`b-control-status`):

```ts
{
  schema: "ohmyaihub/control-status/1",
  at: string,
  self: { nodeId, hostname, fingerprint, quoteHash: string | null },
  listener: { host, port, kind: "loopback-only" | "lan-reachable", verified: boolean },
  requests: [{
    requestHash, consumerNodeId, consumerHostname, consumerFingerprint,
    models: string[], quoteHash, priceVersion, expiresAt,
    tofu: "accepted" | "pending" | "changed",
    state: "awaiting-trust" | "awaiting-approval" | "rejected" | "expired" | "approved",
    technical: { sessionId, receivedAt, note }          // collapsed by default
  }],
  approvals: [{
    approvalId, requestHash, consumerNodeId, state,
    models, capUsd, quoteHash, priceVersion, expiresAt,
    keyId, keyName,
    delivery: { state: "queued"|"delivering"|"delivered"|"uncertain"|"revoked", attempts, lastError },
    ack: { state: "none"|"registered"|"delivery-failed", models, capUsd, at } | null,
    bucket: "pending" | "connected" | "action-needed",
    actionNeeded: string | null,
    technical: { authorizationHash, keyHashPrefix }      // no key
  }],
  connections: [{
    providerNodeId, providerId, state, models, capUsd, lastError,
    bucket: "pending" | "connected" | "action-needed"
  }]
}
```

Actions (exact names, no arbitrary dispatch, no key/port/file/CLI parameters):

| Action | Params | Behaviour |
| --- | --- | --- |
| `b-control-status` | — | read-only projection; no probe, no key |
| `b-connect-request` | `providerNodeId`, `models[]`, `fingerprint`, `quoteHash` | consumer sends a signed request; returns `{requestHash, state:"pending"}` |
| `b-request-approve` | `requestHash`, `models[]`, `capUsd`, `acceptConsumer?` | **one** human action: TOFU acceptance (when needed), quote/model/cap binding, key creation and automatic encrypted delivery; no second “send key” click |
| `b-request-reject` | `requestHash`, `note?` | rejects without a key |
| `b-approval-revoke` | `approvalId`, `reason?` | revokes the Provisioner key first, then queues the revocation notice |
| `b-retry-recovery` | `approvalId?` | technical-details only; retries bounded delivery/recovery; never reissues a key |

`b-request-approve` must bind and display the request hash, both fingerprints, the
current quote hash/price version, the selected models, the positive cap and the
expiry in the confirmation. `acceptConsumer` is required only when B-core says the
consumer fingerprint is pending/changed; it is part of the same approval, not a
second approval layer.

## 6. Negative tests (implemented in this branch)

`plugin/test/control-http.test.ts` (13 pass):

- wrong/missing/DNS/comma/userinfo Host; browser Origin and Sec-Fetch; OPTIONS;
- unknown routes, trailing slash, encoded path, wrong methods, queries on
  health/hello, missing/invalid/duplicate frame session;
- wrong content type, gzip, empty/malformed/array JSON, declared and streamed
  oversize, invalid Content-Length;
- node errors: allow-listed codes → status; unknown code/plain error → `internal`
  without message or secret; late rejection after timeout does not escape;
- per-peer and global rate limit before the node call; global/per-peer concurrency;
- timeout; wildcard bind and false loopback claims refused.

`plugin/test/control-service-port.test.ts` (12 pass):

- approval reuses the real Service/Provisioner and creates exactly one key;
- a cap change or quote change after approval refuses hand-over;
- the selected-subset price version is distinct from the whole eligible set;
- wrong consumer/provider fingerprint, quote hash, models, cap, key id, key hash or
  provider identity refuses before registration;
- a provider serving a different model scope or cap is removed and not ACKed;
- consumer drop is idempotent and removes only the deterministic provider id;
- revocation is idempotent for a vanished consumer and propagates a real failure.

Commands:

```
cd plugin
bun run typecheck
bun test test/control-http.test.ts test/control-service-port.test.ts
```

## 7. Evidence and remaining gates

| Claim | Status | Evidence |
| --- | --- | --- |
| HTTP transport policy and limits | VERIFIED (unit) | 13 pass, typecheck |
| Approval/handover/import adapter reuses Service | VERIFIED (unit with fake Magpie / loopback gateway) | 12 pass |
| Full `bun run test` | PASS in a **temporary verification copy**, not integrated | 778 pass / 0 fail with PR #15 `889973f55ca3a72da99ae0091e50ecd5ea428207` + PR #17 `60d0d04`/`3ce22ee7358ef6f3817b7d4957c4696fbd9a4144`; temp worktree deleted; no P0 commit is part of this branch |
| Real B-core `P2pService` stacked and compiled | UNKNOWN | B-core has not committed a reviewed base |
| Real Magpie 0.1.2289 approval + Remote read-back | UNKNOWN | no isolated 0.1.2289 run in this branch |
| Real EasyTier 2.6.4 two-node hello/frame/TOFU | UNKNOWN | no two-node overlay run |
| LAN exposure boundary on this machine | UNKNOWN | listener not started with real host/port yet; diagnostic must prove it |
| Control port from A-service | PLANNED | A-service `reservePort`/`verifyOwnedPort`; no fixed 3427/user port |
| Real funds / mainnet | **NO-GO** | out of scope; no wallet or real asset used |

The 778/0 full-suite run was made in an isolated `/tmp` worktree that combined this
branch's head with the two P0 review branches; the temporary worktree and branch were
deleted afterwards. It is evidence that this branch does not regress the hermetic
suite, not an approval to integrate P0 or a claim that the guard is part of B.
No real two-node pass is claimed. The next gates are: B-core's
reviewed commit + contract confirmation, explicit stacked base approval, A-service's
port API, then an isolated Magpie/EasyTier two-node run with sanitised logs. The full
test suite must run only with P0-clock's hermetic guard.
