# 2026-10-29 — PR #5 targeted review fixes

Four issues found in review of PR #5, fixed without adding features. Each issue is marked
**CONFIRMED** (the behaviour existed), **FIXED** (with the test that proves it), **NOT REPRODUCED**
or **UNKNOWN**.

Environment: macOS 26.6.2 (arm64), Bun 1.4.3, Magpie 0.1.2038, EasyTier 2.6.4
(`8428a89d…`). Unit tests run against the fake Magpie/supervisor from `plugin/test/service.test.ts`;
the minimal real regression reuses the phase-4 lab (`docs/validation/lab/phase4/lab.ts`) with one
new retarget step.

---

## A. Protecting a provider the plugin does not own — CONFIRMED, FIXED

**What was wrong.** `Magpie.ensureRemoteProvider()` removed *any* provider with the same id and
re-added it as a Remote Magpie. `Service.removeProvider()`, `dropRemoteRegistrations()` (consumption
off) and reconcile used the same unconditional remove, so a native provider, a foreign Remote
Magpie, or an entry the user had edited by hand could be deleted or overwritten.

**Fix.** Ownership is derived from the existing `ProviderConnection` state, with no new permission
system:

- The plugin wrote an entry iff the connection record exists, the entry is a Remote Magpie, its
  `chat` is exactly `http://127.0.0.1:<connection.localPort>/v1`, **and** its key equals the key in
  the key store for that connection (`Service.ownershipOf`). Anything else is `foreign`.
- `Magpie` no longer has `ensureRemoteProvider`: only `addRemoteProvider` (never removes) and
  `replaceRemoteProvider` (called after the ownership proof) exist. Every add/replace/remove path
  goes through the ownership check: connect/update, rollback, reconcile, delete, consumption off,
  restart recovery.
- Adding a new connection whose id already exists (native or foreign Remote Magpie) is refused with
  an explicit error before anything is touched.
- A user-edited entry is detected as `foreign`: update is refused, reconcile reports `degraded`
  with "changed outside this plugin" and leaves it alone, delete/consumption-off leave it in
  Magpie and clear only the plugin's record/key/forward.
- Rollback only removes an entry that still matches what the failed call wrote, then restores the
  previous registration only if the id is absent (never over a foreign entry).

**Evidence.** `plugin/test/service.test.ts`, `describe("provider ownership")` — six tests:
same-named native refused and untouched; same-named foreign Remote Magpie refused; hand-edited key
not overwritten by update/reconcile; delete leaves the edited entry; consumption off leaves it;
restart reconcile rewrites nothing (add/replace call counters unchanged) and never overwrites a
foreign entry.

---

## B. External provider changes and the no-resale guard — CONFIRMED, FIXED (bounded), LIMITATION

**What was wrong.** `guardSharedKeys()` ran only after a connect, `share models`, or hand-over. A
provider list changed outside the plugin (e.g. a native provider replaced by a Remote Magpie under
the same id) could leave an already issued key naming that remote channel until one of those
actions happened. A transient unreadable `providers.json` was treated as "leave everything as is",
and the export stayed published.

**Fix.**

- The guard runs **at start** (before serving), on **every reconcile** (45 s, and on a manual
  `/providers/reconcile`), and on a **15 s poll** (`tick`) that compares a native/remote
  fingerprint so a provider-list change is caught quickly.
- The guard compares the **key Magpie actually holds** (`caller-keys.json`) with the operator's
  shareable set, not only the plugin's local record. An empty `models` list (Magpie's "every
  model") or an extra model is rewritten to the safe list; a key with nothing shareable left is
  revoked.
- If `providers.json` cannot be read, **sharing is suspended**: the export and Forward chain are
  withdrawn with a supervised restart (`state.shareSuspended`), while no consumer key is revoked.
  `checks` reports `sharing-suspended` and `shared-models-native-only` fails. When the file is
  readable again and the keys pass, the export is republished automatically. The operator's
  `sharingEnabled` intent is kept.

**What is still a window.** The external change is detected by polling every 15 s (or by a manual
reconcile). Between the change and the guard there is a window of up to ~15 s in which a key such as
`alpha/*` could still resolve to a remote Magpie that took the id `alpha`. A request through the
consumer's own Magpie during that window is not distinguishable from a native call by the plugin
(it does not proxy requests, by design). **LIMITATION / UNKNOWN for absolute guarantees:** resale is
prevented at the next check, not instantaneously. Closing the window completely would require
Magpie to make provider identity/visibility immutable per key, or a request-path intermediary, which
this project forbids.

**Evidence.** `plugin/test/service.test.ts`, `describe("the share guard reacts to changes made outside the plugin")`:

- `start()` revokes a key whose native provider became a Remote Magpie (restart path);
- `reconcileProviders()` detects the same change while running;
- an unreadable provider list withdraws the export (`sup.cfg.sharingEnabled === false`), keeps the
  key and the consumer, and `checks` reports both failures; restoring readability republishes the
  export and clears `shareSuspended`;
- a key widened by hand (empty list, or an extra remote model) is narrowed back to the operator's
  shareable list;
- a key deleted outside the plugin does not fail the guard or revoke any other consumer.

---

## C. Retargeting a provider while keeping the local port — CONFIRMED, FIXED

**What was wrong.** `updateProvider()` defaulted to `existing.localPort`. When only `mappedCidr` or
`providerPort` changed, `addPortForward` hit the existing bind and failed ("already forwarding to
…"), or an in-place retarget would have been attempted on a version that cannot do it.

**Fix.** On a destination change:

- without an explicit `localPort`, the plugin allocates a **fresh** loopback port, adds the forward,
  proves it (401 without key, 401 with a wrong key, the valid key lists models, Magpie lists the
  provider), then replaces the Remote Magpie registration and commits;
- the old listener cannot be closed live in EasyTier 2.6.4, so the plugin performs **one supervised
  restart** from the new generated config; the old listener is gone and the remaining providers are
  re-verified;
- a failed switch removes the new registration (only if it is still the plugin's), restores the
  previous registration and keeps the old forward, so the old provider stays usable; the failed new
  listener is recorded as an orphan (reported by `checks`, dropped at the next core start);
- an explicit **same** loopback port with a changed destination is refused with an actionable error
  instead of half-switching.

**Evidence (unit).** `plugin/test/service.test.ts`, `describe("several remote providers")`:
a fresh-port retarget is verified before the old one retires and leaves exactly one forward; a
failed retarget keeps the old record/registration/status and the other provider; the same-port
retarget is refused; a retarget whose new path never answers keeps the old connection and records
the failed listener; a repeated add with the same target keeps the same listener (no needless
restart); the success path leaves no orphan.

**Evidence (real EasyTier regression).** One new step in `docs/validation/lab/phase4/lab.ts`
(“retargeting a provider moves to a fresh port…”): A retargets `peer-b` from B to a fourth real
provider **E** and back. It asserts the new port is used, the request reaches the new target,
`peer-c` stays up, exactly two provider listeners remain after the supervised restarts (no
unregistered old port), and A's `checks` still pass. Result: **PASS**, `peer-b 13425 -> 13430 ->
13425; peer-c stayed up; 2 listeners remain`.

---

## D. Hand-over ordering — CONFIRMED, FIXED

**What was wrong.** `handover()` verified the key, then ran `guardSharedKeys()`, and returned the
pre-guard local record. If the guard revoked or narrowed the key during that call, the operator was
still handed the key and a stale model list.

**Fix.** The order is now: guard → re-read the consumer (refuse if revoked) → verify the cap
(`/v1/magpie/limit`) → read the model list from Magpie's own key store → repair an empty
(all-models) list from the guarded record → `assertShareable` on the final list → only then return.
The returned `models` are the ones Magpie holds at that moment, and the cap was read back. Errors
never include the key.

**Evidence.** `plugin/test/service.test.ts`, `describe("handover reflects what Magpie actually holds")`:
a key narrowed during the check returns the narrowed list (equal to Magpie's `models`); a key
revoked during the check throws and the error contains no secret; an empty list is repaired before
delivery.

---

## Unit and CI results

- `cd plugin && bun run ci`: typecheck, **133 unit tests**, boot-check, secret-scan — PASS.
- GitHub Actions (Linux + macOS, Bun 1.4.3): link and SHA in the PR comment / final report.

## Minimal real regression (retarget step)

```
PASS  retargeting a provider moves to a fresh port, verifies it, and drops the old listener —
      peer-b 13425 -> 13430 -> 13425; peer-c stayed up; 2 listeners remain
```

Full lab: **25 passed, 0 failed**, run 2026-10-29T17:54Z on macOS 26.6.2 arm64
(`docs/validation/phase4-lab-report.json`).

## Remaining limits

- The no-resale guard is polled (≤15 s window), not instantaneous (B).
- An entry with a lost `ProviderConnection` record (e.g. `state.json` recovered from `.prev` after
  the provider was registered) is treated as foreign and refuses to be overwritten; the operator
  must remove it in Magpie before re-adding it. This is deliberate (A).
- A failed retarget leaves the failed listener as a loopback orphan until the next core start
  (EasyTier 2.6.4 cannot close it live); it is reported by `checks` and never registered in Magpie.
- All earlier phase-4 limits (identity not cryptographic, single-host lab, Linux/Windows Magpie
  untested) still apply.
