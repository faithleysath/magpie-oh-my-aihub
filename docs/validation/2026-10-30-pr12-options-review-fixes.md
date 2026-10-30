# PR #12 pre-merge review — plugin options and host startup

Date: 2026-10-30. Reviewed source: `59a02ce515b49e58e558a1ceefa3f16cc8810331`.
Platform: macOS 26.6.2 (25G83), Darwin arm64; Bun 1.4.3.
This is a prerequisite repair for Phase 9, not browser-console acceptance.

## Findings and repairs

| Finding | Before | Repair and regression evidence |
| --- | --- | --- |
| Migration discarded the observed options baseline | **REPRODUCED.** `decideOptions` returned a migrated record containing the old options, but the entry replaced its `applied` field with `{}`. A later preferences-only save then replayed stale network secrets, sharing policy and ports over the running configuration. | The entry keeps the migrated record when there is no previous record. A two-process regression migrates a node with a newer live secret, disabled sharing and a different whitelist/port, then saves only a page preference. No configuration write occurs, and the live values remain intact. |
| First-run options silently lost explicit settings | **REPRODUCED.** `seedPatch` omitted `shareModels`, `rpcPort` and catalogue fields while the completed record marked them applied. Unchanged later boots never retried them. | First-run seeding includes all supported configuration keys; preferences and the separate API port remain outside the Service configuration. A regression checks that the explicit whitelist, RPC port and catalogue configuration reach `configure`, persist and are not re-applied on the next boot. |
| Successful option application skipped startup recovery | **REPRODUCED.** On a new host, successful `configure` bypassed `Service.start`; key recovery, Remote Magpie reconciliation and chain-watcher startup were skipped. Only unchanged-options and failed-configuration paths called it. | A common `start` call now follows every options decision. The entry regressions verify one startup call after success, migration, unchanged options and rejected configuration. The Service's existing recovery and watcher implementations remain unchanged. |

`plugin/test/boot-options.test.ts` executes the actual entry, option parser, decision code and
record persistence in separate Bun processes. Its helper replaces external transport and Service
dependencies; this specifically tests entry orchestration, not a live Magpie or chain transfer.
Each test removes its isolated directory in `finally`. No user profile, real wallet or external
network is used by these new regressions.

## Validation

**REPRODUCED before the repair:** the four new entry regressions gave **1 pass, 3 fail** on the
reviewed source. The failures correspond to the three findings above.

**REPRODUCED after the repair:**

```sh
cd plugin
bun test test/boot-options.test.ts test/plugin-options.test.ts
bun run ci
```

- Targeted options/entry tests: **41 pass, 0 fail**.
- Full suite: **577 pass, 0 fail, 2510 assertions, 36 test files**.
- Strict TypeScript, boot-check and credential scan: **PASS**.
- `git diff --check`: **PASS**.

An independent fixture also ran production `boot`, `Service.configure` and `Service.start`,
with external Magpie/EasyTier transports and lifecycle leaves instrumented. It observed:

```json
{"case":"successful option patch on restart","calls":{"recover":1,"walletStarts":1,"reconcile":1,"configure":1,"starts":1}}
{"case":"unchanged-options restart","calls":{"recover":1,"walletStarts":1,"reconcile":1,"configure":0,"starts":1}}
```

The frozen Phase 8 live journey remains the earlier 18/18 run described in
[the Phase 8 report](2026-10-30-phase8-onboarding-ux.md). It was not re-run for this small
entry repair. Actual desktop browser opening, independent-console sessions, WebKit, and the
Phase 9 no-CLI journey remain **UNKNOWN / not implemented** at this prerequisite step.
The updated commit and its Linux/macOS CI are recorded on PR #12; old green checks must not be
used as evidence for the repaired commit.

Real-money Production remains **NO-GO**.
