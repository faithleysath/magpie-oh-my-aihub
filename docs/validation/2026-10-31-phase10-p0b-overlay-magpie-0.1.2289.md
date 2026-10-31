# P0-B — Magpie 0.1.2289 + EasyTier 2.6.4 no-TUN overlay, two isolated nodes

This is the overlay run that P0-A (LAN-direct) deliberately did not cover.
Both EasyTier cores are real and supervised by the plugin; the provider exports
its LAN `/32` as a unique mapped `/32`, the consumer reaches the gateway **only**
through a loopback forward, and the inbound chain is `Drop` with zero rules.

**Transport limit, stated up front:** both nodes run on one macOS host, so the
EasyTier peers connect over `tcp://127.0.0.1` (loopback). This proves the
ACL/proxy/forward path, key enforcement and restart behaviour with two real
cores; it does **not** prove NAT/relay or a cross-internet path, and it is not
a substitute for the Phase 9 three-node WAN evidence.

## Versions and provenance — VERIFIED

| item | value |
| --- | --- |
| Magpie | `0.1.2289`, source `5c637f17b25dad63c490b1edf242c11a83b1b059`, app binary `c534dbcdb92031aa42ef6e4429d558f16d7e679b8508f82fcfde2bc07c45080c` |
| EasyTier | `2.6.4`, commit `8428a89d2dabc94c97d370ec607c6ca142473626`; core `6478a522b8637e2bd2ad3adad66ed04a71b35f832bd9889bffaf1863262f6ddf`, cli `c700c4fee1a7f35fcc1a048520d40cea477b6cf7bf6d75f423fe1642c1ebc75d` (fixture refuses any other bytes) |
| Host Bun (Magpie-managed) | `1.4.4`, `0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc` |
| Platform | macOS 26.6.2 (25G83), Darwin 25.6.0, arm64 |
| Fixture | `docs/validation/lab/phase9/harness.py` at the pin in this branch; lab root `/tmp/oma-p0b-100718` (0700), deleted after cleanup |
| Plugin under test | the repo package at this branch's HEAD, installed into each node with `magpie plugin add <node>/package` (no GUI, no npm, no GitHub fetch) |

Each node: fresh copied `Magpie.app` + `.portable`, private `data/`, `home/`,
`logs/`, isolated `HOME`/`XDG_*`/`MAGPIE_*`; controlled **mock upstream**
(price `1000,1000,0,0`) — no vendor account, no real cost.

## What was actually run (reproducible shape)

1. `harness.py prepare --nodes 2 --app /Applications/Magpie.app` → two portable nodes.
2. `harness.py start` both → `magpie web` owns UI + gateway; keyless/invalid on the
   LAN gateway already assert **401/401** before anything else.
3. `magpie plugin add <node>/package` on both, restart the nodes → the plugin host
   boots (`<data>/oh-my-aihub/api-port`, `api-token`, 0600).
4. Provider `POST /configure` (plugin host API, Bearer token): `role=provider`,
   `sharingEnabled`, same network name/secret, peer = consumer listener,
   `listenAddr=tcp://127.0.0.1:<provider listen>`, `publishedPorts=[<gateway>]`,
   `shareModels=[<fixture model>]`.
5. Consumer `POST /configure`: `role=consumer`, `consumingEnabled`, same network,
   peer = provider listener, `listenAddr=tcp://127.0.0.1:<consumer listen>`.
6. Provider `magpie gateway-key add|models|limit` (dedicated key, one model,
   `$0.0001` day cap).
7. Consumer `POST /providers/add {id, mappedCidr=<provider mapped /32>, key,
   providerPort=<provider gateway>}` → plugin allocates the loopback forward and
   registers the native Remote Magpie, then reads models and the limit back.

## Generated config and live topology — VERIFIED (redacted where secret)

Provider `current.toml` (network secret and secure-mode keys redacted):

```toml
instance_name = "ohmyaihub-<provider nodeId>"
hostname      = "ohmyaihub-<provider nodeId>"     # stable: same value before and after restart
ipv4          = "10.77.0.42/24"
listeners     = ["tcp://127.0.0.1:52004"]
peer          = [{ uri = "tcp://127.0.0.1:54413" }]
proxy_network = [{ cidr = "192.168.43.86/32", mapped_cidr = "10.66.194.82/32" }]
[flags] no_tun = true
[acl.acl_v1] Forward: default_action = Drop, one rule: ports = ["41651"] (the published gateway)
             Inbound: default_action = Drop, **zero rules**
```

Consumer `current.toml`:

```toml
ipv4      = "10.77.0.170/24"
listeners = ["tcp://127.0.0.1:54413"]
peer      = [{ uri = "tcp://127.0.0.1:52004" }]
[[port_forward]] bind_addr = "127.0.0.1:13425"  dst_addr = "10.66.194.82:41651"  proto = "tcp"
[flags] no_tun = true
[acl.acl_v1] Inbound: default_action = Drop, zero rules
```

Live core and chain (from `easytier-cli`, captured during the run):

| item | provider | consumer |
| --- | --- | --- |
| core pid / argv | `easytier-core -c …/provider/data/oh-my-aihub/easytier/current.toml -r 127.0.0.1:17889` | `…/consumer/…/current.toml -r 127.0.0.1:17890` |
| own listeners | `127.0.0.1:17889` (RPC), `127.0.0.1:52004` (peer) | `127.0.0.1:17890`, `127.0.0.1:54413`, `127.0.0.1:13425` (forward) + one EasyTier wildcard socket |
| `peer list` | sees `10.77.0.170`, tunnel `tcp`, latency ~0.1 ms | sees `10.77.0.42`, tunnel `tcp`, ~0.1 ms |
| `route` | `10.77.0.42/24` local, proxy `192.168.43.86->10.66.194.82`; `10.77.0.170/24` DIRECT | `10.77.0.42/24` proxy `10.66.194.82`, DIRECT |
| `port-forward list` | none (proxy path) | `127.0.0.1:13425 -> 10.66.194.82:41651` |

## Security matrix over the overlay — REPRODUCED

| # | probe | result |
| --- | --- | --- |
| 1 | `GET http://127.0.0.1:13425/v1/models` (forward, no key) | **401** |
| 2 | same with a wrong key | **401** |
| 3 | same with the dedicated key | **200** |
| 4 | chat via the forward, cap `$0.0001` | **200**, cost `$0.0120` (12 tokens) |
| 5 | second chat | **429**, `Retry-After: 49876` |
| 6 | `GET /v1/magpie/limit` via the forward | **200**, `cost 0.012`, `costLimit 0.0001`, `spent true` |
| 7 | top-up `--cost 0.0500` | `calls 1 → 2` with `cost 0.012` **preserved** (no reset); `costLeft 0.026`; chat **200** |
| 8 | native Remote Magpie `provider test peer-p0b` | chat/responses/anthropic **200**, model `peer-p0b/provider/provider-model` |
| 9 | revoke the key on the provider | forward `GET /v1/models` → **401**; remote `provider test` → **401** on all three APIs |
| 10 | register a second key, `POST /providers/update {id,key}` | status `connected`; forward **401** keyless / **200** valid; remote test **200** |
| 11 | restart the provider node (plugin host, Magpie, ET core), then `reconcile` | ET peer re-formed; forward **401/200**; provider `connected`; same peer id and mapped `/32`; limit still `$0.036 / $0.05` |
| 12 | restart the consumer node | `127.0.0.1:13425` forward re-created from state; **401/200** again |
| 13 | reach the gateway by **virtual IP** through an extra ET forward (`10.77.0.42:41651`) | **timeout** (no listener / inbound `Drop`) — the key cannot be bypassed this way |
| 14 | provider **web** port by virtual IP (`10.77.0.42:<web>`) | **timeout** (web is loopback-only) |
| 15 | provider **web** port by mapped IP (`10.66.194.82:<web>`) | **timeout** (nothing on the LAN web port; proxy target refuses) |
| 16 | provider **RPC** port by virtual IP (`10.77.0.42:17889`) | **timeout** (loopback-only) |
| 17 | sanctioned mapped path with no key (`10.66.194.82:41651` via a temp forward) | **401** (the only path that answers, and it enforces the key) |

Manual ET forwards added for 13–17 were removed with `port-forward remove`; as
Decisions 12/… already recorded, the **listeners survive** the removal
(`127.0.0.1:13601-13615` still listening), and only the supervised restart of
the consumer cleared them. That was confirmed on 2.6.4 (listener list after
restart: only `13425`, `17890`, `54413` + one EasyTier wildcard socket). No
product code was changed for this.

## Cleanup and ownership — REPRODUCED

- Before: pre-existing orphan cores/mock upstreams/`*:3425` as listed in
  `/tmp/oma-research/p0b/pre-snapshot.txt` — none touched.
- `cleanup` stopped exactly the 8 lab-owned PIDs (4 per node: web host, plugin
  host tree, ET core, upstream), `remaining: []`, and **every** lab port free
  (`web`, `gateway`, `upstream`, `listen`, `catalog`, `socks`, `api-port`,
  `console-port`, `rpc`).
- `cleanup --delete` wrote `/tmp/oma-p0b-100718-cleanup.json` (0600) and removed
  the lab root; the post-run snapshot contains only pre-existing/other agents'
  processes (a new `oma-a-ui-audit` Magpie web and a `oma-phase10-evidence` ET
  core appeared meanwhile from another workstream and were left alone).

## Not covered

- Single host, loopback transport between cores: no NAT, relay, firewall or
  WAN conditions; that remains Phase 9 evidence scope, not this run.
- No real funds, no mainnet, no wallet; the upstream is the fixture mock.
- Catalogue publish/discovery was not exercised (not needed for key/overlay path).
- The browser console journey was not exercised.

## Related finding (not fixed here)

F1 from P0-A still stands: a 0.1.2289 price carrying `peak` is silently
flattened by `plugin/src/pricing.ts` and shares one `priceVersion` with the flat
price. The fix lives in PR #16 (pending independent review) and was not
re-implemented in this branch.
