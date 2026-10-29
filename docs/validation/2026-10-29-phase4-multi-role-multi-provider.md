# 2026-10-29 — Phase 4: simultaneous sharing, multiple remote providers

Phase 4 removes the phase-3 "provider **or** consumer" choice. One Magpie node now shares its own
channels **and** consumes two or more remote Magpies at the same time, with one EasyTier core and
one network identity, one loopback port and one Gateway Key per remote provider.

Evidence marks: **VERIFIED** (read from source), **REPRODUCED** (ran here), **UNKNOWN**.

## 1. Environment

| Component | Value |
| --- | --- |
| Host | macOS 26.6.2 (build 25G83), arm64 |
| Bun | 1.4.3 |
| Magpie | 0.1.2038 (`magpie --version`), three isolated data directories |
| EasyTier | 2.6.4, tag `v2.6.4` = `8428a89d2dabc94c97d370ec607c6ca142473626`, downloaded and SHA-256 verified by the plugin |
| Plugin | branch `feature/multi-role-multi-provider` (this PR) |
| Upstreams | three local OpenAI-compatible mocks (`docs/validation/lab/phase4/mock-upstream.ts`), priced at $1000/Mtok in and out so a $0.03 cap is exhausted by a few calls |

No second physical machine, no real wallet, no real key, no real model vendor. Every key in this
note is a lab key (`sk-test-…` / redacted). All three Magpie instances were isolated with
`HOME`/`XDG_CONFIG_HOME`, each gateway bound to the host's LAN address so it treats the plugin's
forwarded calls as remote (loopback would be trusted: see phase 3).

## 2. Topology

```
          +--------------------- A (dual) ---------------------+
          | Magpie 192.168.10.84:<A>  export 192.168.10.84/32   |
          |   -> 10.66.x.y/32      share: mocka, common-model  |
          | EasyTier 10.77.0.11    forwards 127.0.0.1:13425/26 |
          +-----------+---------------------------+------------+
                      |                           |
        peer-b key /  |                           | peer-c key
        a-node key    |                           |
          +-----------v----------- B -----------+   +----------- C -----------+
          | Magpie LAN:<B>   share: mockb      |   | Magpie LAN:<C> share: mockc|
          | EasyTier 10.77.0.12                |   | EasyTier 10.77.0.13        |
          +------------------------------------+   +----------------------------+
```

- A connects to B and C; B and C both consume A. A↔B is the mutual-sharing case used for the loop
  test.
- Each node runs the **real** plugin host (`docs/validation/lab/phase4/host.ts` imports
  `plugin/src/index.ts` exactly as Magpie does) and is driven through the real CLI/API.
- The lab script is `docs/validation/lab/phase4/lab.ts`; it writes
  [`phase4-lab-report.json`](phase4-lab-report.json) (machine readable).

## 3. Result summary

`bun docs/validation/lab/phase4/lab.ts` → **24 passed, 0 failed** (REPRODUCED, 2026-10-29T15:46:45.680Z,
macOS 26.6.2 arm64).

`cd plugin && bun run ci` → typecheck, **111 unit tests**, boot-check, secret-scan all pass.

| # | Test | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Three isolated Magpie gateways start; key enforced on the LAN address | PASS | `401` without a key, `200` with one |
| 2 | The pinned EasyTier 2.6.4 is SHA-256 verified and reused | PASS | binaries from the manifest, copied to B/C |
| 3 | Three plugin hosts boot; one overlay sees three nodes | PASS | `A sees 3 nodes` (peer list) |
| 4 | A issues independent keys for B and C and shares its own model | PASS | two distinct `sk-…` per consumer |
| 5 | A consumes B and C simultaneously | PASS | `connected` × 2, local ports `13425`, `13426` |
| 6 | Every node lists the models it consumes under the remote id | PASS | `peer-b/mockb/b-model`, `peer-c/mockc/c-model`, `peer-a/mocka/a-model` |
| 7 | Two providers with the same upstream model name stay distinct | PASS | `peer-b/mockb/common-model` and `peer-c/mockc/common-model` both answer, one upstream hit each |
| 8 | One cross-node request crosses exactly one overlay hop | PASS | B upstream `1×`, A upstream `0×` |
| 9 | Streaming, `/v1/responses`, `/v1/messages` through the keyed chain | PASS | SSE chunks + `[DONE]`, native responses/messages |
| 10 | Remote models join a native Magpie routing group | PASS | `group/labmix` served by a remote model |
| 11 | Exhausting B's key does not touch C's key or B's own model | PASS | B `429` after 3 calls, C `200`, B native `200` |
| 12 | A simulated top-up lifts only B's key; a replayed deposit is a no-op | PASS | cap `1.03`, credited exactly `1` |
| 13 | Revoking one provider's key leaves the other; re-issuing restores | PASS | C `401`, B `200`, then C `200` after a new key + `provider update` |
| 14 | Shared keys cannot name a remote Magpie's models (no resale / A→B→A) | PASS | both A and B refuse with “remote Magpie” |
| 15 | One provider offline degrades alone | PASS | `peer-b degraded` while A→C `200`; recovered after B returned |
| 16 | Deleting one provider leaves the other intact | PASS | `peer-c` removed, A→B `200` |
| 17 | Adding the same provider twice is idempotent | PASS | one record, one registration, `connected` |
| 18 | EasyTier restart restores all forwards from the generated config | PASS | core stopped, then A→B `200` |
| 19 | Full Magpie + plugin restart restores the connection set | PASS | same `mapped_cidr`, `peer-b connected`, A→B `200` |
| 20 | A provider's own Magpie + plugin restart is recovered by the consumer | PASS | B restarted; A re-registered `peer-b` and answered |
| 21 | The overlay virtual-IP path is dropped by Inbound (no loopback bypass) | PASS | forward to `10.77.0.12:<B gateway>` times out; mapped address `401` |
| 22 | Sharing off withdraws the export, keeps local providers/models | PASS | no export, both native models still listed; same mapped address returns |
| 23 | Consuming off unregisters only the plugin's remote providers | PASS | no `Remote magpie` left, turned back on with `peer-b` restored |
| 24 | A phase-3 `state.json` migrates on boot and keeps working | PASS | v2, backup, key moved to `provider-keys.json`, old provider answered |

## 4. What each guarantee rests on

### 4.1 One node, two capabilities, one core

`sharingEnabled` / `consumingEnabled` (state version 2). The generated TOML carries the export and
Forward chain **and** the consumer `[[port_forward]]` entries, so a core restart is enough to
restore everything. The lab confirms both can be on together and toggled independently
(#21, #22). Toggling sharing off does not touch `providers.json` or `caller-keys.json`; toggling
consuming off removes only entries whose `preset` is `remote-magpie`.

### 4.2 Several providers, each an independent record

Each remote provider has its own `id`, `remoteMagpieId`, `mappedCidr`, real `providerPort`,
`localPort`, `keyRef` (into a separate 0600 key store), overlay fingerprint, status and timestamps
(`plugin/src/state.ts`). The lab shows two records with distinct loopback ports and keys (#5),
per-provider health (#15), deletion isolation (#16) and idempotence (#17). A failed connect is
verified to restore the previous registration and leave the other providers connected (unit test
`service.test.ts`, “a failed connect keeps the working providers…”).

### 4.3 Same model name, different remote Magpie

Both B and C serve `common-model`. A lists `peer-b/mockb/common-model` and
`peer-c/mockc/common-model`; each request reaches the matching upstream exactly once (#7). Magpie
additionally created its own `auto/common-model` group (native behaviour, not the plugin's). The
failure mode “second provider overwrites the first model” does not occur because Magpie's remote
model ids are namespaced by the Remote Magpie id.

### 4.4 Key isolation, native 429, top-up, revocation

A issued separate keys to B (`cap $0.03`) and C (`cap $0.30`). Three calls from B exhausted its
key (`429`); C's next call returned `200` and B's own native model kept working (#11). A simulated
deposit raised only B's cumulative cap; replaying the same `depositId` did not credit twice (#12).
Revoking C's key produced `401` on C while B stayed `200`; a re-issued key plus `provider update`
restored C (#13). No plugin-level request accounting exists anywhere in the path.

### 4.5 No resale, no A→B→A

`Provisioner` validates every whitelist through `Service.assertShareable`: the provider segment
must be a native Magpie provider (`providers.json` without `preset = remote-magpie`),
`group/*`/`auto/*` entries are refused, and the operator's `share.models` allow list bounds it.
Issued keys are re-checked on provider changes and before every hand-over; unshareable entries are
narrowed and empty keys revoked (unit tests). In the mutual-sharing lab, A lists B's models and B
lists A's, but both refuse a consumer key naming the other side's remote model (#14), and a
cross-node request touches one upstream only (#8).

### 4.6 Recovery

- **Provider EasyTier restart**: the forward set is in the generated TOML; a `stop`/`start`
  restored the listener and the request succeeded (#18).
- **Magpie + plugin restart**: the v2 state (with the key store) restored the same mapped address,
  re-registered the Remote Magpie and answered (#19).
- **Provider offline/online**: only that provider went `degraded`; reconcile restored it when its
  Magpie returned (#15).
- **Provider-side full restart**: B's Magpie *and* plugin host were restarted; A re-registered
  `peer-b` and answered (#20).
- **Orphan forwards**: EasyTier 2.6.4 cannot close a forward live (below), so a removed/relocated
  provider's listener is recorded as an orphan, reported by `checks`, and dropped on the next core
  start. The unit test `service.test.ts` exercises the update path and the orphan's removal.

### 4.7 Ingress bypass negative test

With the real plugin core on A, a `port-forward` to B's **virtual IP** (`10.77.0.12:<B gateway>`)
was added and dialled: the request timed out (Inbound Drop). The control, the mapped address
`10.66.x.y:<B gateway>`, answered `401` without a key. This is the phase-3 invariant re-measured on
a dual-role node (#20, REPRODUCED).

### 4.8 Migration

A fourth isolated node was seeded with a phase-3 document (`role: "consumer"`, `providerWiring`
with a real key). On boot the plugin wrote `state.json.bak-<timestamp>`, produced version 2 with one
provider record, moved the key into `provider-keys.json` (absent from `state.json`), started
`consumingEnabled: true`, `sharingEnabled: false`, re-registered the old provider and answered a
model call (#23). Unit tests additionally cover a provider-only document, idempotent re-load and
recovery from a corrupt `state.json` via `.prev` (`plugin/test/state.test.ts`).

## 5. EasyTier 2.6.4 findings (source + measurement)

1. **`port-forward remove` does not remove anything** (REPRODUCED + VERIFIED source). The CLI
   prints success and the rule/listener stay. Source: the remove patch carries only `bind_addr`
   and no `dst_addr` (`easytier/src/easytier-cli.rs:1957-1962`), while the patcher removes by
   whole-struct equality (`easytier/src/proto/api.rs:53-75`), so the default `0.0.0.0:0` never
   matches. Consequence: the plugin puts forwards in the generated TOML and removes one with a
   supervised restart.
2. **`port-forward list -o json` returns the protobuf `SocketAddr`**, not the table's string:
   `{"bind_addr":{"port":13425,"ip":{"Ipv4":{"addr":2130706433}}}}` (REPRODUCED). The phase-3
   parser read `String(obj)` and therefore saw `[object Object]`; fixed with a decoder and tests
   (`plugin/test/forward.test.ts`).
3. **`[[port_forward]]` in TOML is honoured at startup** (`config.rs:551,1486`; REPRODUCED), which
   is what makes restart-based restoration and removal possible.
4. **Per provider identity signals** (REPRODUCED): `route -o json` exposes `hostname`, `ipv4`,
   `proxy_cidrs`; `peer list -o json` exposes a numeric `id`; `node` exposes the node's own
   `inst_id`. A peer's `peer_id` changed across restarts (`3253394585` → `4147543021`), while a
   persisted `instance_id` in the TOML survived (`1111…`). **No CLI output exposes a peer's
   X25519 public key**, although `RoutePeerInfo.noise_static_pubkey` exists in the RPC protobuf
   (`peer_rpc.proto:46`) — the CLI structs (`easytier-cli.rs:1309-1364`, `1709-1780`) omit it.
   Therefore the plugin records hostname + virtual IPv4 + session `peer_id` as a drift alarm and
   relies on the Gateway Key for authentication. A stable cryptographic peer identity is
   **UNKNOWN/unavailable in 2.6.4**.
5. **A duplicate `port-forward add` creates a second listener** (REPRODUCED), so the plugin lists
   first and only adds a missing rule.

## 6. Known limits and open questions

- **One physical host, three isolated instances.** The overlay is real (three `easytier-core`
  processes, real TCP between them), but no test crossed two physical machines in phase 4. The
  phase-3 two-host run covers the WAN path.
- **Linux/macOS CI** runs the unit suite, not the lab (the lab needs a real Magpie binary). Linux
  Magpie and Windows remain **UNKNOWN** for this phase.
- **Remote identity is not cryptographic** (section 5.4). A peer that hijacks a mapped prefix with a
  different hostname is detected and unregistered, but a peer that also copies the hostname would
  only be stopped by the Gateway Key (calls fail, no leak) — not by proving which machine it is.
- **Forward removal restarts the core**, briefly interrupting the other providers' in-flight
  requests (they recover; measured). A hot removal would need an upstream fix or an ACL/forward
  patch that matches the full rule.
- **Provider-driven model visibility**: a remote Magpie only sees the models a consumer key allows.
  The same-name test initially failed because B's key exposed one model only; that is correct
  key-scoping behaviour and is now part of the test.
- **`auto/*` groups** created by Magpie can contain remote models. They are never shareable: the
  plugin refuses `group/*` and `auto/*` entries for shared keys, because Magpie's key read-back
  does not prove a group's membership.
- Magpie's price is recomputed at current prices; changing a shared model's price while credit is
  outstanding remains a blocker for the wallet phase (unchanged from phase 3).

## 7. Reproduction

```sh
# Prereqs: macOS with Magpie 0.1.2038 installed, Bun 1.4.3, network access for the first
# EasyTier download (cached afterwards at /tmp/ohmyaihub-et-cache-…)
cd plugin && bun install && bun run ci
cd .. && bun docs/validation/lab/phase4/lab.ts          # 23 steps, writes the JSON report
```

The lab creates its own temporary directories under `/tmp/ohmyaihub-phase4-*`, uses random free
ports, and removes them at the end unless `--keep` is passed. Gateway keys are printed truncated in
the step output; the full values live only in the temporary Magpie data directories.

## 8. CI

GitHub Actions `plugin` workflow (Linux + macOS, Bun 1.4.3) runs typecheck, the unit tests, the
plugin boot check and the secret scan on this branch. Links are in the PR description.
