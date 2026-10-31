# Phase 10 B assembly (in progress)

This branch is the **explicit assembly** of approved, independently reviewed
pieces. It is not a new protocol and must not be treated as B GO.

## Exact combination

| Role | Source | Commit / head |
| --- | --- | --- |
| A network base | A-service PR #22 | `56d05f7f611b44fcf661f38aa191827c64a8ceab` |
| A owner gate | A PR #33 | `e5b364df8dfbf6ac0e1ca13f5ddd1c2112ea6063` |
| A share consent | A PR #34 | `b1946b8d5efe3eddfc73e45c47a637ac53d4d9c1` |
| A forward recovery | A PR #32 | `f9c75bbbf0df37a970c99990949c7df0cf6c3d6c` |
| B transport | PR #19 | `6fa9877a9b963e748ea60e6a21fa37d7d97371eb` (via adapter) |
| B adapter | PR #20 | `9b52b4379d064a431f0edf8e9d7b7db476506dbf` |
| B core | PR #26 | `eccb144002647f8a5d2a3385cf16df05c8934306` |

Merge order and parents are visible in this branch's history: A base → A fixes
(#33, #34, #32) → A merge into B adapter → B core. No frozen branch was modified.
The adapter's test fixture is adapted only for A's full `statusSnapshotForTest`
projection; product behavior is unchanged.

## Verified so far

- `bun install --frozen-lockfile`
- `tsc --noEmit`: PASS
- `secret-scan`: PASS
- targeted A+B tests: 200 total, 199 pass / 1 fail before the fixture adaptation;
  after adapting the fixture, the adapter suite is 23/23 and the combined targeted
  set is expected green (rerun recorded in the PR/CI).

## Added after the scaffold

- `plugin/src/control/presence.ts`: separate `ohmyaihub.presence/v1` signed by the
  Catalogue Ed25519 identity; strict fields, short expiry, no model ids/key/secret;
  endpoint only when a caller marks a real ready listener.
- A separate `/p2p/v1/presence` route on the read-only catalog listener (opt-in
  callback), so strict Catalogue v1 is unchanged.
- Narrow core poll extension: `P2pNode.pullFrames()` and `P2pNode.poll()` plus an
  optional `P2pTransport.poll`; a fresh signed hello is the poll authentication,
  frames are normal AEAD session frames, and ACK/outbox/seq/replay semantics are
  reused. Provider HTTP supports `POST /p2p/v1/poll` (hello body, bounded response).
- Tests: presence sign/verify/tamper/expiry; HTTP poll auth/media/query; in-process
  two-node pull after a failed push (consumer registers before ACK, same Key).
- Assembly app/lifecycle, console `p2p-*` actions, presence-driven endpoint
  discovery wiring, and real HTTP two-node Service test are still **not** in this
  commit.

The original reverse-delivery blocker is addressed for pull: the consumer does not
need a reverse endpoint. Discovery still needs the assembly app to fetch/verify
presence and register the endpoint; unshared/control-only provider presence remains
to be wired. No real Magpie/EasyTier run, no LAN/overlay exposure claim, no real
funds.
