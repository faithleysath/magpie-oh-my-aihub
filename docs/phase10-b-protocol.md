# Phase 10 B1 — the no-file P2P protocol core

Status: **BETA / NOT ACCEPTED**. This document describes the code in
`plugin/src/p2p/` at this commit. It is a protocol and state-machine core, not a
finished product: there is **no HTTP listener**, **no Service/Magpie adapter**,
**no UI**, and **no real two-host EasyTier/Magpie run** yet. Nothing here may be
reported as “zero-file P2P GO”.

- Base: `8ce5c57f565fb1b835021a9b730b61014eb47d5f` (`origin/main`, PR #13 merged)
- Branch: `feature/phase10-b-protocol`
- Identity: the persisted Catalogue Ed25519 key (`catalog-identity.json`), no new root
- Runtime primitives: Node/Bun `node:crypto` only (X25519, HKDF-SHA256, AES-256-GCM, Ed25519)
- Storage: `p2p.sqlite` (0600) beside `ledger.sqlite` / `chain.sqlite`

## 1. What is implemented

| Module | Responsibility | Deliberately absent |
| --- | --- | --- |
| `protocol.ts` | versioned envelope, closed type/field allow-lists, Ed25519 signatures, per-type body validation, size/time bounds, authorization hashes | no transport, no storage, no policy |
| `crypto.ts` | ephemeral X25519, low-order rejection, HKDF domain separation, AES-256-GCM frames, authorization sealing | no long-term X25519 key, no custom curve/AEAD |
| `identity.ts` | binds the Catalogue key to a local overlay binding; TOFU verdicts | no second identity, no file writes |
| `handshake.ts` | signed `hello`/`server_hello`, transcript hash as HKDF salt, target binding | no socket, no retry of its own |
| `session.ts` | sequence numbers, frame AAD, replay/retransmission, session close | no resumption after restart |
| `store.ts` | trust, sessions, messages, tombstones, requests, approvals, deliveries, outbox, inbox, recovery | no key/secret columns |
| `node.ts` | the business state machine, the narrow ports, outbox driving, ACK/revoke ordering | no ledger/wallet/Service/Magpie import |
| `index.ts` | the only public surface for B-service | internals stay private |

The source-scan test asserts that `src/p2p/*` does not import `ledger.ts`,
`wallet.ts`, `provisioner.ts`, `service.ts`, `magpie.ts`, `console-*`,
`node:net`, `node:http`, `Bun.serve`, `child_process`, `eth_send*` or
`signTransaction`.

## 2. Identity and trust

- `from.accountId` **is** `from.fingerprint`, which is SHA-256 of the raw 32-byte
  Ed25519 public key. Any other combination is rejected. There is no account key
  separate from the Catalogue key in B1; adding one would be a reviewed change.
- `hostname` must end with `-<nodeId>`; `nodeId` is the existing 8–64 hex id.
- Consumer → provider trust reuses `catalog-trust.json`:
  `accepted && !pending && fingerprint equal`. The default lookup is
  `catalogProviderTrust(loadCatalogTrust()[nodeId], provider)`; an injected
  `trust` function can replace it in tests.
- Provider → consumer trust is a separate TOFU row in `p2p.sqlite`. A first
  contact is `pending`; a changed key becomes a pending change; a revoked row
  stays revoked. **A valid signature never auto-trusts.** `approve()` requires
  `accepted` unless the same explicit local action also passes
  `acceptConsumer: true`.
- A pending key change blocks the **old** key too. Accepting it requires the
  exact fingerprint the human reviewed (`acceptConsumer(nodeId, fingerprint)` /
  `P2pStore.acceptPendingPeer(nodeId, fingerprint)`); passing the old row cannot
  clear it. Acceptance closes the old key's live sessions, then asks the port to
  revoke **every live old generation's native key**. Only a confirmed revoke
  writes the authorization tombstone and turns the generation `revoked`; a
  refusal/failure leaves it `uncertain` (recoverable, no fake success). Queued
  old approved/delivery frames are marked dead, and an identity tombstone records
  the replacement. A new identity cannot receive a key id or Gateway Key that
  belonged to the replaced identity (core checks over the port's result and the
  actual received key hash). A pending change can be **explicitly rejected**
  (`rejectConsumerIdentityChange(nodeId, fingerprint)` /
  `P2pStore.rejectPendingPeer`), which clears the pending record and keeps the
  previously accepted key. A hello is fully validated (signature, identity,
  target, time) before `recordPeerSeen`, so an unauthenticated hello cannot
  create a pending change or lock the accepted identity.
- The Ed25519 private key is read from the Catalogue file; it is never copied.
  Session X25519 keys exist only in memory and are wiped on close.

## 3. Envelope (the signed unit)

```ts
{
  version: 1,
  protocol: "ohmyaihub/p2p/v1",
  type: <one of the ten below>,
  id: <32 hex>,
  from: { accountId, nodeId, hostname, publicKey, fingerprint },
  to:   { accountId, nodeId, fingerprint },
  time: <ISO-8601>, expires: <ISO-8601>,
  correlation: <32 hex | null>,
  idempotency: <32 hex>,
  body: <type-specific allow-listed object>,
  auth: { algorithm: "ed25519", keyId, signature }
}
```

Signature input: `canonicalJson({ domain: "ohmyaihub/p2p/<type>/v1", ...allFieldsExceptAuth })`.
Extra fields, control characters, non-plain objects, unknown types and unknown
versions are rejected. The body is capped at 12 KiB, the signed JSON at 16 KiB,
a frame at 32 KiB and a hello at 8 KiB. `time` may be at most 120 s in the
future; `expires` may be at most 120 s in the past; lifetime is at most 30 min.

The closed type allow-list is exactly:

`connection_request`, `approved`, `rejected`, `authorization_delivery`, `ack`,
`revoked`, `quote_changed`, `payment_request`, `status`, `credit_updated`.

`payment_request` and `credit_updated` are validated but **refused by B1** with
code `unsupported` and zero side effects (`P2P_B1_UNSUPPORTED`). They exist so a
later wallet/data phase can version them without changing the envelope; B1 does
not call a ledger, a wallet or a cap.

Every business object has a deterministic idempotency key, e.g.
`sha256("p2p:request:" + requestHash)[0..32]`. A message whose idempotency key
does not match its content is rejected (`conflict`). The same content under a new
message id therefore reaches the same row and returns the first result; it
cannot create a second request, approval, key or payment.

## 4. Handshake

```text
consumer                                   provider
  hello  --------------------------------->  validate signature, target, time,
  (clientNonce, clientX25519, target        record peer (TOFU), build server_hello
   nodeId/fingerprint/mapped/port/quote)
  <-------------------------------- server_hello
  (serverNonce, serverX25519, echo sessionId/clientNonce/clientX25519)
  verify provider identity == expected catalogue fingerprint
  transcript = canonicalJson({sessionId, client: {...}, server: {...}})
  shared = X25519(eph, peerEph)             shared = X25519(eph, peerEph)
  prk_c2s = HKDF(shared, salt=SHA256(transcript), info="ohmyaihub/p2p/v1/c2s")
  prk_s2c = HKDF(..., "…/s2c")
  prk_auth = HKDF(..., "…/authorization-seal")
```

- The transcript deliberately excludes the local role: both sides must compute
  the same bytes, or the AEAD fails closed.
- The target is the provider's **full current binding**: `nodeId`, key
  `fingerprint`, `mappedCidr`, `controlPort`, `catalogQuoteHash`. A hello aimed
  at another provider, another key, another port/address or another quote is
  refused (`target_mismatch` / `stale_identity` / `quote_mismatch`). A node
  cannot be used as a jump host.
- Low-order and all-zero X25519 points are refused before and after the
  agreement; the raw length must be exactly 32 bytes.
- Hello nonces are tombstoned for two hours. An identical live retry returns the
  cached `server_hello`; after a restart the same nonce is refused and a new
  session id is required.
- **Sessions are not resumable.** Their keys die with the process; a restart
  expires the row. Business state is recovered by `requestHash`/`approvalId`, not
  by the transport session. This is a deliberate “fail / re-handshake” boundary,
  not a missing feature.

## 5. Frames and replay

Frame: `"OMA1" | version(1) | typeCode(1) | seq uint64be | msgId(16) | len uint16be | GCM ciphertext+tag`.

- AAD = `canonicalJson({domain:"ohmyaihub/p2p/frame/v1", protocol, sessionId, direction, seq, msgId, type})`; nonce = `00000000 || seq`.
- `seq` starts at 1 per direction and must be contiguous. **Sequence numbers are
  unauthenticated header fields:** before the AEAD verifies, a forged gap, an old
  seq or random ciphertext is only dropped and counted (`rejectedFrames`), never
  used to advance `lastSeqIn` or close the session. An exact retransmission of a
  stored frame (same seq, msgId, ciphertext hash) returns the cached result.
- Only an **authenticated** violation closes the session: a replayed frame that
  decrypts but does not match the stored one, an authenticated sequence gap, or
  msgId reuse after decryption. A frame replayed into another session fails the
  AAD and is rejected without touching state.
- Rate limiting is the HTTP layer's job (B-service); this core only counts
  rejected frames so the transport can act on them.
- Session rows, message rows and tombstones are persisted; the ciphertext is
  kept as an opaque hash for retransmission checks, never as a key store.

## 6. Business state machine

Provider:

```text
requested/awaiting-trust/awaiting-approval
  → approving → approved → delivering → delivered → acked
  (+ rejected, expired, revoked, uncertain)
```

Consumer:

```text
requested → approved → delivered → acked
  (+ rejected, expired, revoked, uncertain)
```

- **One key per `(requestHash, generation)`.** A re-approval after a terminal
  state gets a new generation and a new approval id; the old generation is
  revoked/tombstoned and can never be reused.
- **A failed port.approve is an unresolved intent, not a licence to mint a new
  key.** The `approving`/`uncertain` row (same approvalId and generation) is
  persisted before the port call. A later approve, including after a restart,
  must first use the read-only `reconcileApproval` lookup:
  `keyReady` adopts the original key, `noSideEffect` retries the **same**
  approvalId/generation, `unknown`/missing/throw keeps it `uncertain` with
  action-needed. No new generation or second key is created to clear an unknown.
- **Historic-identity gate:** every approve (including after pending is cleared or
  a restart) and every delivery checks all approvals for the consumer node. Any
  approval from a different identity that is not confirmed revoked (typed
  enforcement + authorization tombstone) blocks the new approval/delivery. Only
  a confirmed revoke or explicit reconcile clears it.
- **Human approval is the only authorisation.** `approve()` runs the port's
  approval, binds the key identity, computes the authorization hash, and queues
  the encrypted delivery. There is no second “send key” action.
- **`priceVersion` is bound twice and never conflated:**
  - `request.priceVersion` / `approval.requestedPriceVersion`: the consumer's
    accepted full requested set, validated by the port's `validateRequest`;
  - `approval.priceVersion`: the **selected subset** returned by the approval
    port after the human picks models; it is what the `approved` body and the
    authorization carry.
  The core never compares these two for equality. Only the selected-subset
  version is delivered.
- **Revoke ordering and recovery:** the native key is revoked through the port
  *before* any `revoked` wire message can be queued. Only an explicit typed
  result with `revoked:true`, `enforcement:"keyRevoked"|"secretRotated"` and
  bindings equal to this approval's consumer, approval id, key id and generation
  is success. A throw, `{revoked:false}`, `void`/missing result, a non-binding
  enforcement (cap/network/safety) or any binding mismatch leaves the approval
  `uncertain`, surfaces `action-needed`, and sends nothing. A later explicit retry of the **same
  approval/generation** is allowed: if the port then confirms the key is gone,
  the approval converges to `revoked`, the authorization is tombstoned, the
  request becomes `revoked`, and only then is the notice queued. A restart never
  turns `uncertain` into a success. After a successful revoke, a **new explicit
  human approval** creates generation 2 (new approval id/key scope); nothing is
  auto-reissued, and the old generation's late deliveries are refused by
  approval state, delivery state and tombstone.
- **ACK does not gate registration.** On delivery the consumer opens the seal,
  checks every binding, calls `importAuthorization` (native Remote
  registration + models/cap readback), records `delivered`, and only then queues
  the ACK. A lost ACK leaves the consumer `delivered`/registered and the provider
  `delivered`; bounded re-delivery of the **same** approval generation plus
  `status` queries reconciles it. No second key, no second Remote.
- **Duplicate delivery:** same approval + same authorization hash → no second
  import, ACK is re-enqueued (unique idempotency). Same approval + different
  hash → `conflict`, approval `uncertain`, nothing imported.

## 7. Persistence and transaction boundaries

`p2p.sqlite` tables: `p2p_peer_trust`, `p2p_sessions`, `p2p_messages`,
`p2p_tombstones`, `p2p_requests`, `p2p_approvals`, `p2p_deliveries`,
`p2p_outbox`, `p2p_inbox`.

Key constraints:

- sessions: `session_id` PK, unique `transcript_hash`; no key columns;
- messages: `(session_id, direction, seq)` PK, unique `(session_id, msg_id)`;
- requests: `request_hash` PK (content-addressed);
- approvals: `approval_id` PK, unique `(request_hash, generation)`, partial unique
  index on `request_hash` for live states only;
- deliveries: `approval_id` PK, same authorization hash + key id, plus
  `key_hash = SHA-256(actual received Gateway Key)`; no key column. The hash is
  compared across approvals for the consumer node, so an old secret cannot be
  re-delivered under a new key id/generation; the core computes it from the key
  the port actually returned (a caller-declared hash is never trusted);
- outbox/inbox: unique `(type, idempotency)`; outbox payload is non-sensitive
  business inputs, never an envelope with a key;
- tombstones: `(scope, key)` PK with expiry.

Transaction boundaries:

| Operation | Boundary |
| --- | --- |
| inbound frame accepted | one transaction: bump `last_seq_in` + insert message row |
| outbound frame sealed | one transaction: bump `last_seq_out` + insert message row |
| request accepted | inbox row → request row (insert-or-ignore) → port validation → state |
| approval | approval row `approving` → port approve → CAS `approved` → request `approved` → queue `approved` → prepare delivery (port key read, hash, delivery row, queue) |
| delivery send | read approval/delivery → port key read → verify same key hash → seal in memory → transport |
| delivery receive | inbox → open seal → verify bindings → port import (register + readback) → delivery `delivered` + approval `delivered` in one transaction → queue ACK |
| ACK | inbox → verify identity/hash/readback → CAS `acked` + delivery `acked` + tombstone in one transaction |
| revoke | port revoke confirmed → CAS `revoked` + delivery `revoked` + tombstone → queue notice |

The Gateway Key exists only as a JS string between the port and the seal call.
`assertNoSecretMaterial` runs on every JSON value written to SQLite (payload,
result, metadata) and rejects `key`, `secret`, `privateKey*`, `mnemonic`,
`seedPhrase`, `password`, `token`, `authorization`, PEM markers, `sk-…` and
bearer-looking values. A test scans both SQLite files after a full flow and finds
no key material.

## 8. Retry, backoff, recovery

- Default policy: base 5 s, factor 2, cap 300 s, max 8 attempts; the delay is
  applied after the failed attempt. A dead outbox row is visible, not deleted.
- `tick()` is the only retry driver. It expires sessions by time, re-arms the
  same delivery generation when an ACK is missing (same approval id, key id and
  authorization hash; bounded by attempts and approval expiry), and sends due
  rows to the transport. It never creates a key.
- Boot recovery (`P2pStore.recover`, called by the `P2pNode` constructor):
  open sessions → `expired`; `sending` → `pending`; `processing` → `pending`;
  `approving` approvals → `uncertain`; `preparing` deliveries → `uncertain`;
  `delivering` stays retryable for the same generation. Expired tombstones are
  purged.
- A transient port error on an inbound message abandons the inbox row and caches
  a `retry` result, so the peer's bounded retry (same idempotency key, new
  envelope id) can be processed again. A protocol error is terminal and cached.
- Unknown is not zero: `uncertain` + `action-needed` is surfaced in the approval
  view; it is never auto-reissued.

## 9. Ports (what B-service must implement)

```ts
interface P2pBusinessPort {
  providerContext(): Promise<P2pProviderContext>;
  validateRequest(input): Promise<{ models; quoteHash; priceVersion; expiresAt }>;
  recordRequest(input): Promise<boolean>;
  approve(input): Promise<P2pApprovedMaterials>;   // selected models/cap/key
  takeAuthorization(input): Promise<P2pAuthorizationDocument>; // key in memory only
  recordAck(input): Promise<void>;
  reconcileApproval?({ requestHash, approvalId, generation, consumer, keyId }): Promise<
    | { state: "keyReady"; keyId; keyName; models; capUsd; priceVersion; expiresAt; detail? }
    | { state: "noSideEffect"; detail? }
    | { state: "unknown"; detail: string | null }
  >; // read-only: must not create or rotate a key
  revoke(input: { consumerNodeId, approvalId, keyId, generation, reason }): Promise<
    | { revoked: true; enforcement: "keyRevoked" | "secretRotated";
        consumerNodeId; approvalId; keyId; generation; detail: string | null }
    | { revoked: false; enforcement: "none" | "capRestricted" | "networkWithdrawn" | "safetyUncertain" | "failed";
        detail: string | null }
  >; // void/null is not success; the core marks the approval uncertain
  recordApproval(input): Promise<void>;
  importAuthorization(input): Promise<{ models; capUsd }>; // register before ACK
  dropAuthorization(input): Promise<void>;
}

interface P2pTransport {
  hello(target, hello): Promise<unknown>;   // POST signed hello
  frame(session, frame: Buffer): Promise<void>;
}
```

The port has no method that takes an arbitrary action name and no ledger/wallet
capability. The remote peer can only select one of the ten message types.

**Mapping to the B-service v2 draft contract** (which used the old
`service.ts` names): `validateRequest` is identical; `approve` corresponds to
`approveRequest` + `approveRequest`'s returned key fields;
`takeAuthorization` + core-built document corresponds to `readKeyMaterial`;
`importAuthorization` corresponds to `registerAuthorization` + the provider
session identity; `revoke` corresponds to `revokeConsumer` (returning an
explicit confirmation is stronger than `void`); `recordAck`/`recordApproval`/
`dropAuthorization`/`recordRequest` are local bookkeeping callbacks that v2
folded into the Service adapter or `onNotice`. **This is an integration open
issue, not a settled contract**; B-service must adapt or the two shapes must be
reconciled in a reviewed change.

## 10. Threat model

Assumed:

- the EasyTier overlay may carry hostile members, replay, inject, drop, delay
  and reorder frames;
- the Catalogue trust file is the operator's TOFU decision;
- the plugin host is a single Bun process; a compromised same-UID process can
  read `catalog-identity.json` and the SQLite files (no per-plugin sandbox);
- the network is not trusted; the operator's browser is not a control plane.

Covered:

- impersonation without the Catalogue private key (signature + pinned key);
- key substitution (accountId/fingerprint/hostname/nodeId binding, TOFU pending
  on change, full identity in every envelope);
- cross-protocol replay (per-type signature domains, separate hello domains);
- target/relay abuse (hello must match the provider's full binding);
- downgrade to another key/quote (approval/authorization bind fingerprint,
  quote hash, price version, request hash, approval id, generation);
- transport replay/reorder (contiguous seq, msg id uniqueness, frame hash,
  session/type/direction in AAD);
- credential leakage into SQLite/log/generic cache (field/value guards, sealed
  key only in memory, no authorization table);
- remote privilege escalation (closed type list, narrow port, source scan);
- key reissue on retry (content-addressed requests, unique approval generations,
  delivery hash equality, revoke tombstone).

Not covered / out of scope:

- a compromised plugin host or a stolen Catalogue private key;
- a malicious operator who approves a request intentionally;
- Denial of service at the HTTP layer (no listener here; B-service must add
  limits before verification);
- metadata privacy (node ids, quote hashes and approval ids are visible to the
  overlay peer and in SQLite);
- post-compromise security, forward secrecy across restarts, deniability;
- real money, mainnet credit, wallet secrets (explicitly NO-GO);
- multi-device account identity (B1 is one node = one Catalogue key).

## 11. Tests (pure modules, no network)

```bash
cd plugin
bun run typecheck
bun test test/p2p-crypto.test.ts test/p2p-protocol.test.ts test/p2p-handshake.test.ts test/p2p-store.test.ts test/p2p-node.test.ts
```

The suite covers: RFC 7748 X25519 vector, low-order/all-zero points, HKDF
separation, AEAD roundtrip/tamper/AAD mismatch, frame header strictness,
authorization seal bindings, envelope field/type/version/size/time/signature
negatives, request body binding, TOFU (including explicit pending acceptance and
old-key blocking), price-version split, approval idempotency/conflict, revoke
confirmed/unconfirmed/throwing, uncertain revoke convergence and generation 2,
duplicate delivery/ACK, unauthenticated seq=1000/old-seq frames not closing the
session (with rejected-frame counting), byte-identical retransmission, restart/
crash recovery, SQLite secret scan and the source scan.
The tests use a temp directory, a fixed clock and an in-process overlay; they do
not resolve the LAN IP, open a port, read the production Magpie state or call a
public RPC.

Expected result at this commit: `70 pass / 0 fail`, typecheck clean.

## 12. Not verified (UNKNOWN)

- No real two-host EasyTier 2.6.4 + Magpie 0.1.2289 run; no overlay, no ACL, no
  listener, no NAT traversal, no control-port allocation (A-service owns the
  port allocator).
- No HTTP transport, rate limiting, body limits, Host/Origin policy or
  concurrency limits (B-service).
- No Service/Provisioner/Magpie adapter; no `approveConnectionRequest`,
  `handover`, `addProvider` or `revokeConsumer` call has been exercised.
- No UI, no console actions, no status projection.
- No multi-node (>2), multi-session, clock-skew or long-running soak test.
- No independent security review or fuzzing; the crypto is standard-library
  based but not audited as an integration.
- Windows behaviour is unverified; only Node/Bun `node:crypto` on this platform.
- The exact price-version semantics of the existing Catalogue/Service
  (`catalogPriceVersion`) were not changed or re-derived here; the split above
  must be validated against the real Service in B-service integration.
- `recordRequest`/`recordApproval`/`recordAck`/`dropAuthorization` duplicate
  some bookkeeping that B-service may already do; the final ownership needs a
  contract decision.
- Approval expiry vs. a long ACK-loss window is bounded but not tuned against a
  real operator workflow.
- The exact Magpie effect of `Service.handover` on a revoked generation and the
  B-service `importAuthorization` cleanup of the old Remote are not exercised
  here; the core only guarantees it never seals/delivers after a confirmed
  revoke and never reuses a replaced key id.
- A node that publishes no model catalogue has a control endpoint in B-service,
  but this core has no signed presence/reverse-reachability message yet. The
  current flow relies on the consumer keeping a session open; if it is lost, the
  consumer must reconnect and query `status`. This is a known gap, not a claim.

## 13. Integration order

1. Review this core (protocol/crypto/handshake/session/store/node) and the
   port shape.
2. B-service adds the HTTP listener + `P2pTransport` + `P2pBusinessPort` adapter
   on top of the reviewed commit (explicit stack, no cherry-pick).
3. A-service supplies the `control` port allocation/diagnostics; the listener
   binds only the intended address and reports true exposure.
4. Real two-host EasyTier/Magpie lab: hello/frame reachability, other ports
   unreachable, catalogue still GET-only, no-file request → approval → delivery
   → ACK, restart and ACK-loss recovery.
5. Independent security review; only then can B move from BETA to accepted.
   Real funds/mainnet remain NO-GO regardless of B.
