# Phase 10 B — control service / Service integration

Status: **DOING**. This document is an implementation report, not an acceptance
certificate. It separates what is implemented from what is only simulated and from
what has not been run against the real Magpie 0.1.2289 / EasyTier 2.6.4 pair.

Branch: `feature/phase10-b-service-adapter` (PR #20) in
`/Users/laysath/.paseo/worktrees/1z728cdk/b-service`.
The branch **does not** copy, modify or run the user's installed Magpie app or data.

## 1. Scope and boundary

B-service owns the part of B that turns B-core's protocol/session state machine into
a real local control endpoint and wires it to the existing plugin service:

- a bounded HTTP transport with three exact routes, no CORS, no browser origins, an
  exact Host allow-list, pre-authentication rate limits, body/time/concurrency caps
  and sanitised error codes (`plugin/src/control/http.ts`);
- a narrow `P2pBusinessPort` adapter (the reviewed B-core PR #26 shape, mirrored
  locally; `plugin/src/control/p2p-port.ts`) over the existing Service/Provisioner
  paths. The earlier `service-port.ts` remains the shared helper layer:
  - quote/policy validation and human approval reuse
    `Service.approveConnectionRequest` (which itself calls
    `validateRequestApproval`, `assertShareable`, `shareCandidates` and the consumer
    generation checks);
  - the one-time key uses `Service.handover` (share guard + Provisioner read-back),
    never a second key store;
  - consumer registration uses `Service.addProvider` (overlay probe → native Remote
    Magpie registration → model read-back) and `Service.providerModels` for the
    model/cap read-back;
  - revoke uses `Provisioner.revokeEnforced`: remove, then rotate as fallback;
    only a measured keyRevoked/secretRotated is reported as revoked, never a
    cap-only stop;
  - consumer Remote ownership (provider/approval/generation/keyId) is persisted
    atomically in `control-remotes.json` (0600, no key), so a restart removes only
    the revoked approval's Remote and never replaces a newer one.
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
- `approve` converts the v2 request into the existing v1 request shape **only for
  the Service call**, then calls `Service.approveConnectionRequest`. The human
  selected models are a subset of the request. The adapter returns the selected-model
  price version; B-core persists it beside the full quote hash, full quote price
  version, requested-subset version and selected model snapshot. The delivered
  authorization carries the full `contentHash` plus the selected version.
- `takeAuthorization` rechecks the Provisioner record (key id/name, models, cap,
  accepted quote hash, price version) before and after `Service.handover`; a changed
  quote, cap, model scope, key generation or paused consumer fails before a key is
  returned for sealing. It does not add a second lock: approval uses the existing
  `Service` serialization, hand-over uses the Provisioner consumer lock/read-back,
  and the checks fail closed.
- `importAuthorization` validates the v2 document binding (provider/consumer
  identity, approvalId/requestHash, quote, models, cap, key id/name/hash), then calls
  `Service.addProvider` with a per-approval provider id. It reads the model list and
  `costLimit` back with `Service.providerModels`. A mismatch removes only that Remote
  and throws; no ACK is produced. Ownership (provider/approval/generation/keyId) is
  persisted atomically; a different approval cannot replace a live Remote.
- `revoke` returns a typed `P2pRevokeOutcome`, never `void`/untyped success. It
  calls `Provisioner.revokeEnforced`; only a measured `keyRevoked`/`secretRotated`
  with the exact `consumerNodeId`/`approvalId`/`keyId`/`generation` binding is
  confirmed. Removal is the strong stop; if removal fails, rotation must make the old
  secret 401 (read back via `limitStatus`); a $0.0001 cap is not a stop. Anything
  else is `{revoked:false, enforcement: capRestricted|safetyUncertain|failed}` and
  B-core keeps the same generation uncertain/action-needed without sending a
  “revoked” notice.
- `importAuthorization`/`dropAuthorization` use a persistent, non-secret ownership
  record keyed by provider/approval/generation/keyId/providerId. While a provider has
  a live Remote, a different approval for the same provider is refused; an old
  authorization cannot replace a newer Remote. Revocation after restart removes only
  the matching approval; a stale revocation for a superseded approval is ignored.
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

`plugin/test/control-http.test.ts` (20 pass):

- wrong/missing/DNS/comma/userinfo Host; browser Origin and Sec-Fetch; OPTIONS;
- unknown routes, trailing slash, encoded path, wrong methods, queries on
  health/hello, missing/invalid/duplicate frame session;
- wrong content type, gzip, empty/malformed/array JSON, declared and streamed
  oversize, invalid Content-Length;
- node errors: allow-listed codes → status; unknown code/plain error → `internal`
  without message or secret; late rejection after timeout does not escape;
- per-peer and global rate limit before the node call; global/per-peer concurrency;
- timeout; wildcard bind and false loopback claims refused.

`plugin/test/control-p2p-port.test.ts` (9 pass):

- requested-set vs selected-subset price version;
- approval/hand-over through the real Service;
- persistent Remote ownership across a restart;
- a different approval cannot replace a live Remote; the same approval with another
  generation is refused;
- stale revocation does not remove a newer Remote;
- corrupt ownership file fails closed before any Remote call;
- a crash after native add but before final ownership save leaves a pending record;
  the same approval adopts it and a different approval is refused;
- enforced revoke: remove success, rotation fallback, a rotation whose old secret
  is still accepted is not claimed, and both-fail returns `revoked:false` with the
  key/record still active.

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
bun test test/control-http.test.ts test/control-service-port.test.ts test/control-p2p-port.test.ts
```

## 7. Evidence and remaining gates

| Claim | Status | Evidence |
| --- | --- | --- |
| HTTP transport policy and limits | VERIFIED (unit + real socket) | 20 pass, typecheck |
| Approval/handover/import adapter reuses Service | VERIFIED (unit with fake Magpie / loopback gateway) | 12 pass |
| B-core business port mapping + persistent ownership | VERIFIED (unit, fake Magpie) | 9 pass |
| Enforced revoke remove/rotate/old-secret/both-fail | VERIFIED (unit, fake Magpie) | 9 port tests |
| PR #19 transport | PASS (reviewed 7bcf7e0, rebased on approved PR #15) | 20 real/unit tests; see PR #19 |
| PR #20 adapter targeted | PASS (local, rebased branch) | 20 transport + 12 old adapter + 9 new port tests = 41 total |
| Full `bun run test` on PR #20 head `73f7e39` | PASS (CI) | run `41160518919` linux+macOS success; includes the approved PR #15 clock base |
| Real B-core `P2pNode` stacked and compiled | UNKNOWN (not approved) | B-core PR #26 is committed (`fdc7d4c`/`fba73c`) but not approved for stack; the local port mirrors its `P2pBusinessPort` shape and is compile-checked only in a temporary snapshot |
| Real Magpie 0.1.2289 approval + Remote read-back | UNKNOWN | no isolated 0.1.2289 run in this branch |
| Real EasyTier 2.6.4 two-node hello/frame/TOFU | UNKNOWN | no two-node overlay run |
| LAN exposure boundary on this machine | UNKNOWN | listener not started with real host/port yet; diagnostic must prove it |
| Control port from A-service | PLANNED | A-service `reservePort`/`verifyOwnedPort`; no fixed 3427/user port |
| Real funds / mainnet | **NO-GO** | out of scope; no wallet or real asset used |

PR #20's CI run `41160518919` is green on linux and macOS for head
`73f7e394f98fa4a1d2dc86349e9e860c00fba9fd`; it is the PR head, not a temporary
combination. The earlier 773/0 local run was the PR #19 transport combined with the
two P0 branches in /tmp and is recorded separately. Neither is a claim that the
hermetic guard is part of B or an approval to integrate P0. No real two-node pass is
claimed. The next gates are: main approval of the exact
B-core commit, an explicit stacked assembly, A-service's port API, then an isolated
Magpie/EasyTier two-node run with sanitised logs. The full test suite must run only
with the hermetic guard (PR #17 is still temporary evidence, not a dependency).
