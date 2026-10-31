# P0-A — Magpie 0.1.2289 LAN-direct isolated run (EasyTier NOT started)

> **Read this first — scope limit.** Two isolated Magpie processes were run on
> one Mac and reached each other over the **LAN address** with a native Remote
> Magpie provider. **EasyTier was not started**: no overlay, no `port_forward`,
> no mapped `/32`, no virtual IP. This is **not** an overlay/P0 two-node pass
> and must not be quoted as one. The EasyTier binaries were only seeded and
> hash-checked by the fixture. Overlay results are a separate run
> (P0-B), recorded separately when it exists.

Scope: the **target version** only. No real funds, no mainnet, no user Magpie
profile, no user network. This run answers "does the gateway/Key semantics the
Phase 10 work depends on still hold on 0.1.2289", not "is Phase 10 complete".

## Versions and provenance — VERIFIED

| item | value |
| --- | --- |
| Magpie app | `0.1.2289` (`CFBundleShortVersionString`) |
| Magpie source | `5c637f17b25dad63c490b1edf242c11a83b1b059` (tag `v0.1.2289`) |
| Magpie binary | `c534dbcdb92031aa42ef6e4429d558f16d7e679b8508f82fcfde2bc07c45080c` (same sha in both nodes' `runtime.json`) |
| Host Bun (Magpie-managed) | `1.4.4`, `0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc` |
| EasyTier | `2.6.4` binaries seeded by the fixture and hash-checked against `ET_PIN` (`6478a522b8637e2bd2ad3adad66ed04a71b35f832bd9889bffaf1863262f6ddf` core, `c700c4fe…` cli). **Not started in this run** — see "Not covered". |
| Platform | macOS 26.6.2 (25G83), Darwin 25.6.0, arm64 |
| Fixture | `docs/validation/lab/phase9/harness.py` at `474e403` (this branch: measured-version map with 0.1.2289) |
| Lab root | `/tmp/oma-p0-2289-095922` (0700), deleted after cleanup; proof `/tmp/oma-p0-2289-095922-cleanup.json` |

Each node: fresh copied `Magpie.app`, `.portable` marker, private `data/`,
`home/`, `logs/`; env fixed by `harness.env_for` (no user tokens, no PATH Bun,
`HOME`/`TMPDIR`/`XDG_*` all inside the lab). Provider gateway bound to the LAN
IPv4 with `MAGPIE_ALLOW_IPS=<lan>/32`; admin web on `127.0.0.1` only.
The controlled upstream is the fixture's local mock (price `1000,1000,0,0`, no
vendor account, no cost).

## Results — REPRODUCED

All HTTP below is against `http://<provider LAN>:<gateway port>/…`.

| # | case | observed | verdict |
| --- | --- | --- | --- |
| 1 | `GET /v1/models` without a key | **401** | PASS |
| 2 | same with `Authorization: Bearer sk-invalid-fixture-key` | **401** | PASS |
| 3 | same with the dedicated key | **200** | PASS |
| 4 | `GET /v1/magpie/limit` with the key | **200**, shape below | PASS |
| 5 | first real chat to the fixture model with cap `$0.0001` | **200**, cost `$0.0120` (12 tokens) | PASS (overrun known) |
| 6 | second chat with the same cap | **429**, `Retry-After: 50384` | PASS |
| 7 | top-up `--cost 0.0220` | `cost $0.012` and `calls 1` **unchanged**; `costLimit 0.022`; `spent false` | PASS (no reset) |
| 8 | chat after top-up | **200**; final `cost 0.024 > costLimit 0.022`, `spent true` | PASS (cap is not a hard stop) |
| 9 | stop + start the provider node | `calls 2 / cost 0.024 / costLimit 0.022` preserved; keyless **401**, key **200** | PASS |
| 10 | native Remote Magpie on the consumer: `provider add remote-magpie <key> url=… id=oma-p0-remote` | **1 model** discovered (`oma-p0-remote/provider/provider-model`) | PASS |
| 11 | `provider test oma-p0-remote` with a funded key | chat/responses/anthropic **200** through the remote gateway (mock upstream) | PASS |
| 12 | revoke the provider key (`gateway-key remove`) | remote chat/responses/anthropic **401** ("not an enabled magpie gateway key") | PASS |
| 13 | register a new key, restart the consumer | provider record survived; `provider test` **200** chat/responses (anthropic then **429**, new key spent by the earlier probes) | PASS |
| 14 | keyless model list after every restart | **401** | PASS |

`/v1/magpie/limit` on 0.1.2289 (sanitized; no secret fields exist in it):

```json
{"key":"<name>","limit":{"period":"day","start":"2026-10-31T00:00:00+08:00",
 "reset":"2026-11-01T00:00:00+08:00","calls":1,"tokens":12,"cost":0.012,
 "costLimit":0.0001,"tokensLeft":0,"costLeft":0,"spent":true},
 "limited":true,"limits":[ … same object … ]}
```

This is the same key set the plugin reads (`cost`, `costLimit`, `costLeft`,
`period`, `reset`, `calls`, `tokens`, `spent`); no new mandatory field broke the
shape. `caller-keys.json` on 0.1.2289 still stores `{id, name, secret}` for a
normal key — no `default`/`readOnly` flag appears on a key created this way, so
the plugin's id/name ownership lookup is unchanged for this path (`move`/LAN
"Default" semantics were not exercised).

## Findings

1. **The cap is not a hard stop (VERIFIED again on 0.1.2289).** A `$0.0001` cap
   admitted a call that cost `$0.0120`, and the same overrun repeated after a
   top-up. Phase 6 knew this; C must not describe a cap as a guarantee.
2. **F1 — peak pricing fails open in the plugin (VERIFIED, source-level).**
   `plugin/src/pricing.ts:normalizePrice` reads only
   `input/output/cache_read/cache_write/cache_write_1h/tiers`; given the 0.1.2289
   price shape `{…, "peak":"deepseek"}` it drops the field, and
   `priceVersionOf(flat) === priceVersionOf(peak)`. So a peak-bearing price is
   invisible to the ledger and to the price version. The safe Phase 10 behavior
   is to **refuse** a price that carries `peak` until it is modelled (or include
   it in the version/settlement); today it silently flattens.
   Checked without waiting for peak hours: the defect is in normalisation, not
   in the clock (`/tmp/oma-research/p0/peak-check.ts`).
3. CLI surface for the pieces the plugin uses is unchanged on 0.1.2289:
   `gateway-key add|models|limit|quotas|access|remove|rotate|move`,
   `provider add remote-magpie <key> url=… id=…`, `provider key|models|test|rm`.
   `gateway-key move` is new and unused by the plugin.

## Cleanup and ownership — REPRODUCED

- Before: 6 pre-existing `easytier-core`/`mock-upstream`/`magpie` processes and
  listeners on `13400`, `17888`, `19081-19083`, `*:3425`. **None were touched.**
- `cleanup` stopped exactly the lab-owned PIDs (4: web+upstream per node),
  `remaining: []`, and every lab port (`web`, `gateway`, `upstream`, `listen`,
  `catalog`, `socks`) reported free — for both nodes.
- `cleanup --delete` wrote `/tmp/oma-p0-2289-095922-cleanup.json` (0600) and
  removed the lab root; the post-run snapshot is byte-for-byte the same set of
  pre-existing processes/listeners as the pre-run snapshot.

## Not covered (do not read this as broader evidence)

- **EasyTier overlay was not exercised at all**: binaries were seeded and hash-checked,
  but no overlay, no `port_forward`, no mapped-subnet forward. The Remote Magpie
  above used the provider's LAN address directly. Cross-node overlay 401/429
  still needs the Phase 9 forward path on 0.1.2289.
- No plugin host was started; this measured Magpie-native gateway/Key semantics,
  which is what the plugin depends on, not the plugin's console journey.
- No peak-hour call was made (0.1.2289 applies peak only Mon–Fri 01–04/06–10 UTC
  and never on a weekend); F1 is a normalisation defect and is date-independent.
- No real funds, no mainnet, no wallet.
