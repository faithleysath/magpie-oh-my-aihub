# 2026-10-29 — The Inbound/loopback bypass, the corrected ACL, and a real two-host run

Sequel to [`2026-10-29-local-lab.md`](2026-10-29-local-lab.md) (PR #1). That note measured
the Forward path and left one thing untested: what happens to a flow addressed to the
provider's **virtual IP** once the ACL is in force. This note tests it, fixes the config,
and then repeats the whole gateway matrix from a second computer over the public internet,
with a third host acting as relay, and from a real LAN machine.

Marks: **VERIFIED** (pinned source), **REPRODUCED** (ran here, command and output quoted),
**UNKNOWN** (not tested). Keys, secrets, account e-mails and provider keys are redacted.
Layer-2 addresses and public IPs are recorded because they are operational evidence, not
secrets of the project.

---

## 1. Verdict first

**PR #1's `docs/validation/lab/provider-acl.toml` is exploitable, and the test that would
have caught it was missing.** `tcp_whitelist = ["3425"]` (line 8 of that file) compiles to
an **Inbound** allow rule for the gateway port
(`easytier-core/src/config/peers.rs:75-121`). In no-TUN mode a flow to the provider's own
virtual IP is rewritten to `127.0.0.1:<port>`
(`easytier-core/src/gateway/proxy/wrapped_tcp_proxy.rs:81-86`), and Magpie treats loopback
as a local, unauthenticated caller (`internal/gateway/lan.go:634-641`,
`internal/budget/budget.go:28-30`). Measured: **HTTP 200 with no key and with a wrong key**
through `provider-virtual-IP:3425`, while the same gateway through the Forward path
correctly answered 401/401/200.

The correction is not "delete the whitelist". Measured: deleting it and keeping only the
Forward chain is **worse** — with no Inbound chain EasyTier's inbound default is *Allow*
(`easytier-core/src/peers/acl/processor.rs:274-285`), so every loopback service on the
provider becomes reachable (verified against a loopback HTTP probe on port 19000: 200).
The fix is an explicit **Inbound chain with `default_action = 2` and no rules**, plus the
Forward chain for the gateway port. That is now in
[`lab/provider-acl.toml`](lab/provider-acl.toml).

With the corrected config, every remote path that reaches the AI gateway is authenticated:
the Inbound chain drops 100 % of inbound packets (measured ACL counters), the Forward chain
reaches only `tcp/3425`, and Magpie answers 401 without a key, 401 with a wrong key, 200
with a valid key, 429 when the key's limit is spent — from two remote hosts and from a
different LAN machine.

---

## 2. Environment and topology

| Item | Value |
| --- | --- |
| Provider | Mac (macOS 26.6.2, build 25G83, arm64), `en0` 192.168.10.84/24 |
| Magpie provider | 0.1.2038, `/Applications/magpie.app`, tag `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| EasyTier | 2.6.4-8428a89d on all three hosts, tag `v2.6.4` = `8428a89d2dabc94c97d370ec607c6ca142473626`; Linux binaries from `easytier-linux-x86_64-v2.6.4.zip`, macOS from `easytier-macos-aarch64-v2.6.4.zip` |
| Relay host | `hk-vps`, Debian 13 x86_64, public `221.128.249.18`, 4 vCPU / 16 GiB, UFW default-deny inbound |
| Consumer host | `us-west-vps`, Debian 12 x86_64, public `38.22.237.209`, 2 vCPU / 2 GiB |
| Consumer Magpie | container `ghcr.io/yetone/magpie:latest`, digest `sha256:900711e2867299e6dbc7d9b02112e86d0a00add626f61bacfad83be0da5fbe5e`, `magpie v0.1.2057`, `--network host`, `MAGPIE_ADDR=127.0.0.1:3427` |
| LAN peer | Windows 11 VM (Parallels, bridged on Wi-Fi), 192.168.10.81/24 |
| Overlay | `magpie-p2`, 10.77.0.0/24: Mac `10.77.0.1`, us-west `10.77.0.2`, HK `10.77.0.254`; encrypted, TCP tunnels |
| Provider export | `proxy_network = [{ cidr = "192.168.10.84/32", mapped_cidr = "10.66.137.1/32" }]` |
| Temporary firewall | UFW `11010/tcp`, `11010/udp` on both VPS hosts for the session, removed afterwards (verified: only 22/80/443 remain) |

Why a container on us-west: the released Linux binary (`magpie-linux-amd64`, SHA-256
`53c5f699b459729fc62507e1c6fb63c6bee1122337e733bade88d8632f4187d6`, matching the release's
`SHA256SUMS`) links `libwebkit2gtk-4.1`, `libgtk-3`, `libsoup-3`, `libwayland-client` and
cannot start on a headless Debian without a desktop stack; the official image is the
headless gateway build. Version skew (consumer 0.1.2057 → provider 0.1.2038) is a normal
upgrade case and is recorded here as such.

Also recorded: the Mac's egress goes through a local proxy (EasyTier reports interface
`198.18.0.1`, the benchmarking range, and public IPv4 `183.210.196.220` /
`103.135.100.150`). So "p2p DIRECT" below means *a direct TCP tunnel from this computer*,
not necessarily a direct last-mile path; the relay test in §4.3 exists for that reason.

---

## 3. The Inbound bypass

### 3.1 Mechanism (VERIFIED)

1. No-TUN rewrite: `easytier-core/src/gateway/proxy/wrapped_tcp_proxy.rs:81-86` — a flow
   whose destination is the node's own virtual IP is dialled to `127.0.0.1:<port>`.
2. Chain type: same file `:100-104` — that plan's ACL chain is **Inbound**.
3. ACL defaults: `easytier-core/src/peers/acl/processor.rs:274-285` takes each chain type's
   default from the **first** chain of that type, and `unwrap_or(Action::Allow)` when there
   is none; `:323-351` merges the rules of every chain of a type and sorts by priority;
   `:578-606` applies the type default when no rule matches.
4. Whitelist: `easytier-core/src/config/peers.rs:75-121` turns `tcp_whitelist` into an
   Inbound chain with `default_action = Allow`, an allow rule for the listed ports and a
   drop rule for the rest of TCP.
5. Magpie: loopback is local (`internal/gateway/lan.go:634-641`), and an unkeyed local
   request is neither authenticated nor charged (`internal/budget/budget.go:28-30`).

So `tcp_whitelist = ["3425"]` on a no-TUN provider is, precisely, a rule that says "let
peers reach the unauthenticated gateway".

### 3.2 Four variants, one local overlay, one valid key (REPRODUCED)

Provider = one EasyTier node on the Mac with `proxy_network = [{cidr = "192.168.10.84/32"}]`;
consumer = a second node on the same host, forwards to `10.55.0.1:3425` (virtual IP) and
`192.168.10.84:3425` (Forward path). Echo probes on `127.0.0.1:19000` and
`192.168.10.84:19002` stand in for "other local services". Commands:
`easytier-core -c <variant>.toml -r 127.0.0.1:16888`, `easytier-cli port-forward add tcp …`,
`curl -m 6`. A `000` is a TCP connect that never completed (dropped by the ACL).

| Variant (what the provider runs) | T1 virt:3425 no key | T2 virt:3425 wrong key | T3 LAN:3425 no key | T4 LAN:3425 valid key | T5a virt:19000 loopback echo | T5b LAN:19002 | T5c/d ssh |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A. PR #1** (`tcp_whitelist=["3425"]` + Forward allow 3425, no Inbound chain) | **200** | **200** | 401 | 200 | 000 | 000 | 000 |
| **A′.** no whitelist, Forward only, no Inbound chain | **200** | **200** | 401 | 200 | **200** | 000 | 000 |
| **B. corrected** (Forward allow 3425 + Inbound default Drop, no rules) | **000** | **000** | 401 | 200 | 000 | 000 | 000 |
| **C.** Inbound default Drop **+ allow 3425** | **200** | **200** | 401 | 200 | 000 | 000 | 000 |

Reading:

- **A** is PR #1 and is exploitable (T1, T2).
- **A′** shows that deleting the whitelist does not fix it: without an Inbound chain the
  default is Allow, which exposes *more* (T5a: any loopback service, not just the gateway).
  This is exactly the trap the assignment warned about.
- **B** is the fix: the virtual-IP path is dropped for everyone, key or no key.
- **C** shows the cause is the allow rule itself, not the chain's existence: one Inbound
  allow for 3425 brings the bypass back.

ACL counters from the two-host provider (same ACL shape as B) at the end of the session:

```
InboundPacketsDropped: 24   InboundPacketsTotal: 24      # nothing got in
ForwardPacketsAllowed: 62   ForwardPacketsDropped: 16
DefaultDrops: 10            DefaultAllows: 9
```

### 3.3 What this means for PR #1

- The file to fix: `docs/validation/lab/provider-acl.toml`, **line 8**
  (`tcp_whitelist = ["3425"]`) and the missing Inbound chain.
- The PR #1 text is not wrong about what it measured (Forward path 401/401/200, other
  ports blocked); it simply never sent a request to the provider's **virtual IP** after the
  ACL was applied. The row "inbound 19000 refused" was true and, unfortunately, hid the
  fact that inbound 3425 was allowed.
- The corrected file is in this PR; the rest of PR #1's conclusions stand.

---

## 4. Two hosts over the internet, plus a relay and a LAN peer

### 4.1 Topology and paths (REPRODUCED)

```
Mac provider 10.77.0.1 ──tcp── hk-vps 10.77.0.254        (44–66 ms, p2p)
Mac provider 10.77.0.1 ──tcp── us-west 10.77.0.2         (200–224 ms, p2p)
us-west consumer 10.77.0.2 ──tcp── hk-vps                (157–167 ms, p2p)
provider exports: 192.168.10.84/32 -> 10.66.137.1/32
consumer reaches the gateway at 10.66.137.1:3425 (mapped) — never through the provider's
own LAN address, which keeps the address stable when the LAN changes.
```

`easytier-cli route` on the Mac (trimmed):

```
| 10.77.0.1/24 | mac-provider | 192.168.10.84->10.66.137.1 | -              | Local | 0   |
| 10.77.0.2/24 | usw-consumer |                            | DIRECT         | DIRECT| 224 |
| 10.77.0.254/24 | hk-relay   |                            | DIRECT         | DIRECT| 66  |
```

The provider's accepted socket during a request (the address Magpie sees):

```
$ netstat -an -p tcp | grep '\.3425' | grep ESTABLISHED
tcp4  0  0  192.168.10.84.3425   192.168.10.84.62491   ESTABLISHED
```

Source = the provider's own LAN address, non-loopback ⇒ `local()` false ⇒ key required and
quota applied. (In the failing variant the same socket would read `127.0.0.1:x`.)

### 4.2 Gateway matrix from the US-West VPS and from the HK VPS (REPRODUCED)

Script on each remote host: add `port-forward` rules, then `curl -m 8`; `000` = dropped.

```
  W1 mapped-overlay:3425      no key           401  {"error":{"message":"no API key was sent…"}}
  W2 mapped-overlay:3425      wrong key        401  {"error":{"message":"the API key ending in rong is not an enabled…"}}
  W3 mapped-overlay:3425      valid key        200  {"data":[{"context_length":1048576…}
  W4 mapped-overlay /v1/magpie/limit  valid key 200 {"key":"p2-lab-…","limit":{…"spent":false}}
  V1 provider-virt-IP:3425    no key           000
  V2 provider-virt-IP:3425    valid key        000
  N1 mapped-overlay:22        no key           000
  N2 provider-virt-IP:22      no key           000
  N3 mapped-overlay:19002     no key           000
```

Identical on both remote hosts (`us-west-vps`, `hk-vps`). Key limit over the internet:

```
wan call 1: 200
wan call 2: 429
Retry-After: 12695
X-Magpie-Limit-Reset: 2026-10-30T00:00:00+08:00
X-Should-Retry: false
{"error":{"type":"rate_limit_error","message":"magpie gateway key \"p2-lab-…\" has used 40 of
 its 40 input, output and cache-write tokens for this day; it resets at 2026-10-30 00:00 CST"}}
```

### 4.3 Relay through the HK VPS (REPRODUCED)

To force relaying both endpoints were started with `disable_p2p = true`, the consumer with
`no_listener = true` (a real NAT'd client), both seeded only by the HK host:

```
Mac    → usw-consumer  cost relay(2)   latency 215 ms   path_len 2  next_hop 10.77.0.254 (hk-relay)
us-west→ mac-provider  cost relay(2)   latency 205 ms   path_len 2  next_hop 10.77.0.254 (hk-relay)
```

Consumer Magpie through the relay: `HTTP 200 4.084 s` (first call, path setup) then
`HTTP 200 0.719 s`; direct path was `0.877 s`. Same model, same key.

### 4.4 Reverse direction (REPRODUCED)

- Provider → consumer loopback service, with the consumer's Inbound chain allowing that one
  port (`19000`): `200`, and the service saw **`127.0.0.1`** — the same rewrite, in the
  other direction. So the rule "never allow a Magpie port Inbound" applies to every node,
  consumer included.
- Provider → consumer **Magpie** `10.77.0.2:3427` with the Inbound chain dropping
  everything: `000`, although that Magpie listens on the consumer's `127.0.0.1:3427`.
  Without the Inbound chain this would have been an unauthenticated gateway too.

### 4.5 Remote Magpie over the WAN (REPRODUCED)

Consumer Magpie 0.1.2057 on us-west, provider added with
`magpie provider add remote-magpie <key> url=http://127.0.0.1:13425 id=mac-a`
(`13425` is the consumer's EasyTier forward to `10.66.137.1:3425`):

| Case | Result |
| --- | --- |
| model discovery | `✓ 1 models from 127.0.0.1:13425`, id `mac-a/deepseek/deepseek-flash`, remote `pricing` present |
| `POST /v1/chat/completions` | 200, 0.877 s |
| streaming | 200, SSE `chat.completion.chunk` |
| `POST /v1/responses` | 200, `object:"response"` |
| `POST /v1/messages` (Anthropic) | 200, `type:"message"` |
| native group `group/wangroup` | 200 |

Through the HK relay the same four APIs answered 200. No protocol or path incompatibility
was found in either mode.

### 4.6 Findings that belong in the design

- **`rpc_portal` in the TOML file is ignored** by 2.6.4 (`easytier-core/src/config/toml.rs:409-455`
  has no such key). The management RPC then binds **`0.0.0.0:15888`** — measured on the
  Mac and on us-west (`ss -lntp`), while both config files asked for `127.0.0.1`. Always
  pass `-r 127.0.0.1:<port>` on the command line. A public VPS should never expose that
  port; here UFW blocked it, but the bind is wrong.
- Restarting a node with the same virtual IP produces **stale peer entries** on its peers
  (`relay(2)` rows for the node's own address, `0 B`) until they time out, and a route for
  its own proxy CIDR via the relay. The plugin must not identify a provider by virtual IP;
  bind wallet identity to the peer's public key, and make the supervisor disconnect
  cleanly instead of `kill -9`.

---

## 5. Physical LAN exposure

### 5.1 Measured from another LAN machine

Windows 11 VM (Parallels, **bridged** on Wi-Fi), `192.168.10.81`, to the Mac's
`192.168.10.84:3425`:

| Request | Result |
| --- | --- |
| `GET /v1/models`, no key | **401** `no API key was sent…` |
| same, wrong key | 401 `the API key ending in … is not an enabled magpie gateway key` |
| same, valid key | **200** |
| `Test-NetConnection 192.168.10.84 -Port 3425` | `True` (TCP reaches the gateway) |

So the gateway **is reachable from other LAN devices** (`*:3425`, as in PR #1), and the key
is what stops them. Internet exposure was also checked from both VPSes against the Mac's
observed public addresses on 3425: `000` (the router forwards nothing).

### 5.2 Native allow list (REPRODUCED)

Second, portable Magpie on the Mac at `0.0.0.0:3426` with
`MAGPIE_ALLOW_IPS=10.77.0.0/24`:

| Caller | Result |
| --- | --- |
| VM 192.168.10.81 | **403** `magpie answers only the addresses on its allow list …, and this request came from 192.168.10.81` |
| Mac loopback | 200 |
| Mac → its own LAN address | 401 (own addresses are always allowed by the list — `internal/gateway/allow.go:137-155` — but the request is still remote for authentication) |

So `MAGPIE_ALLOW_IPS` (or Settings → Allowed addresses) blocks LAN hosts while leaving the
overlay path working, because that path arrives from the provider's own address.

### 5.3 OS firewall (REPRODUCED)

Temporary macOS `pf` rule, loaded with `pfctl -f /tmp/p2-pf.conf` and reverted with
`pfctl -f /etc/pf.conf`:

```
block drop in quick on en0 proto tcp from any to any port { 3425, 3426 }
```

| Caller | Before | With the rule |
| --- | --- | --- |
| VM → 192.168.10.84:3425 | 401 (reachable) | **`TcpTestSucceeded: False`**, curl `000` |
| us-west → mapped overlay:3425, no key / valid key | 401 / 200 | **401 / 200** (unchanged) |
| Mac → own LAN address:3425 with key | 200 | 200 (routes over `lo0`, not `en0`) |

The Application Firewall on this Mac is disabled (`State = 0`), so it was not a factor.
Both mitigations work without touching EasyTier or Magpie: the plugin can offer "LAN access
off" as either an allow-list entry or a firewall rule, and the overlay keeps working.

### 5.4 What is still exposed

With the corrected ACL the provider exposes exactly one overlay port (tcp/3425) and one LAN
port (`*:3425`, keyed). Everything else is closed by the Forward chain, including the
provider's own loopback services. The EasyTier RPC portal is the one thing that must be
fixed at launch (`-r 127.0.0.1:<port>`), not by the ACL.

---

## 6. Addressing: same LAN IP, LAN changes, multi-NIC

All three measured on one host, with two provider instances and one consumer.

### 6.1 Two providers that export the same LAN subnet (REPRODUCED)

With `mapped_cidr`, each provider owns a distinct overlay prefix:

```
consumer routes:
| 10.56.0.1/24 | m-provider-1 | 10.66.137.0/24 | DIRECT |
| 10.56.0.2/24 | m-provider-2 | 10.66.138.0/24 | DIRECT |
```

Both `10.66.137.84:3425` and `10.66.138.84:3425` answered 401 without a key and 200 with a
valid key. Without `mapped_cidr` both announce `192.168.10.0/24` and the consumer ends up
with **two routes for the same prefix** — no way to choose the provider:

```
| 10.56.0.1/24 | m-provider-nm1 | 192.168.10.0/24 | DIRECT |
| 10.56.0.2/24 | m-provider-nm2 | 192.168.10.0/24 | DIRECT |
```

**Conclusion: `mapped_cidr` is required, not optional.**

### 6.2 A provider's LAN address changing inside its subnet (REPRODUCED)

Provider exports `192.168.10.0/24 -> 10.66.137.0/24`; a service was bound to
`192.168.10.99` (a second address on the host) and reached at `10.66.137.99:19000`:

```
{"client": "192.168.10.99", "client_port": 63795, "path": "/probe"}
```

The exported prefix did not change when the served address did; only the last octet on the
consumer side follows the provider's address. That is the operational answer to DHCP
changes inside the LAN: export the subnet, allocate one stable prefix per provider, and
derive the host part. A change **across** subnets still needs a new exported prefix.

### 6.3 Multi-NIC (UNKNOWN)

Only one non-overlay interface (plus the proxy's TUN `198.18.0.1`) existed; exporting
several prefixes for several interfaces was not tested.

---

## 7. Quota supplements

All on the portable Magpie (0.1.2038) with a remote-magpie provider to the real Mac
gateway, so every call also crossed the gateway; costs are Magpie's estimate at its
displayed prices.

### 7.1 A price change rewrites history (REPRODUCED)

`magpie model price mac-real/deepseek/deepseek-flash 1,2,0,0` (USD per 1M in/out), one call
of 32 in + 4 out = **$0.00004**, then the price changed to `10,20,0,0` **without a new
call**:

```
price $1/$2   → {"calls":1,"tokens":36,"cost":4e-05}
price $10/$20 → {"calls":1,"tokens":36,"cost":0.0004}     # 10x, same call
price $1/$2   → {"calls":1,"tokens":36,"cost":4e-05}
```

`budget.read` recomputes each record with today's prices
(`internal/budget/budget.go:132-142`, `usage.NewCoster`). A price increase can
retroactively put a consumer over budget; a decrease can give room back. For billing this
means **store the price version with every charge** (already a project decision) and never
recompute a settled invoice from the current price.

### 7.2 Window expiry (REPRODUCED, simulated clock)

A 1-hour cycle with a call recorded in the current window; `since` moved back two hours
(the exact state a rollover produces):

```
before: start 20:40:25  calls 1  tokens 36  cost 4e-05
after : start 20:40:37  calls 0  tokens 0   cost 0        # old call is simply out of the window
next call: calls 1, tokens 36, cost 4e-05                 # new window counts from zero
```

Usage records are not deleted (`usage.jsonl` keeps them); only the window sum moves. A real
wall-clock rollover was not waited for; the code path is the same `Window()` computation.

### 7.3 A request in flight when Magpie restarts (REPRODUCED)

Streamed 74 KB (~2.5 s) and `kill -9`'d the gateway mid-stream:

```
client: curl (18) transfer closed with outstanding read data remaining
after restart: {"calls":0,"tokens":0,"cost":0}
usage.jsonl: no new record (delta 0)
provider side: no record for that call either
```

**Both sides lose the charge.** A restart (or crash) mid-request leaves the call unbilled;
the upstream vendor still billed it. The wallet must either reconcile against the
provider's own records or accept that cut-off streams are free; it must not infer a charge
from "a request started".

### 7.4 Precision and rounding (REPRODUCED)

| Value | Stored as | Effect |
| --- | --- | --- |
| `--cost 0.000024` | (none) | **key becomes unlimited** — `Valid()` rounds to 4 decimals and drops a zero limit (`internal/access/limit.go:147`) |
| `--cost 0.00005` | `0.0001` | rounded up to the grid |
| `--cost 0.0001` | `0.0001` | smallest usable cap (1/100 cent) |
| `--cost 0` | error | a zero cap cannot be set; `Cost: 0` in the file means no cap |
| `off` | removed | `{"limited":false}` |

The plugin must (a) never write a cap below `0.0001`, (b) read `spent`/`limited` back after
writing, and (c) treat "no limit" as a failure, never as "blocked".

### 7.5 Overdraft, and a top-up that does not cover it (REPRODUCED)

Cap `$0.0001`, used `$0.00004`; a call whose real cost (170 output tokens) was ≈9× the
reservation was admitted and pushed the window to `$0.000414` — **4.1× the cap**:

```
cap 0.0001, used 0.00004 → call → 200, used 0.000414, spent true
next call                        → 429
top up to 0.0003 (< used)        → 429        ← the answer to the question
top up to 0.0007 (> used)        → 200, used 0.000462
```

So: a top-up that does not lift the cap above what is already spent leaves the key refused,
exactly as required. Reservation underestimates are the source of the overdraft (the
reservation is body/4 tokens plus the window's mean output — `budget.go:387`), and output
length is not bounded by the reservation.

---

## 8. Final assessment of the current route

- **Native Gateway Key is sufficient.** Admission, per-model scoping, per-request
  enforcement, 429 with reset time, usage accounting, restart-safe windows and instant
  top-ups all work through the corrected ingress, from two remote hosts and a LAN peer.
  No second AI gateway is needed.
- **The corrected ingress is:** provider `--no-tun` + `proxy_network` (real `/32` or `/24`
  → a unique `mapped_cidr`) + **Inbound chain default Drop with no rules** + Forward chain
  allowing only tcp/3425. The gateway is reached by the provider's own non-loopback
  address, so Magpie enforces the key.
- **No Inbound allow rule may name a Magpie port.** That single rule is the bypass, in
  every direction, for every node (provider or consumer).
- **`mapped_cidr` is mandatory** for a multi-provider world: it removes same-LAN-IP
  ambiguity and survives LAN changes inside the subnet.
- **Cap semantics are a soft ceiling.** Overshoot is bounded by the in-flight burst and by
  output length vs. reservation, not by one call; $0.0001 granularity; a smaller cap
  silently disables the limit. A prepaid design must reserve a tolerance and verify the
  written cap.
- **Historical cost is price-dependent.** Store a price snapshot per charge.
- **Interrupted requests are free.** Both sides lose the record on a restart.
- **LAN exposure is a policy choice**, and both native mechanisms (allow list, firewall)
  work while keeping the overlay. The default (`lan: true`, `*:3425`) is reachable by any
  LAN device but requires a key.
- **The management RPC must be pinned to loopback on the command line.**

**Do we still need a minimal network adapter?** **No.** With the Inbound chain corrected,
EasyTier no-TUN plus Magpie's own Gateway Key covers every entry point that reaches the
gateway. The earlier fallback ideas (a local TCP relay to a loopback alias, provider-side
TUN, header-injecting proxy) are not needed and should not be built.

---

## 9. Still UNKNOWN

- Windows and Linux **Magpie** behaviour for the gateway (only macOS ran as a provider; the
  Linux consumer was the official container). The Linux binary needs a desktop stack.
- Multi-NIC providers and exporting several prefixes (§6.3).
- Long-running stability, reconnection when the provider's public egress changes (this
  Mac's public IP changed between `103.135.100.150` and `183.210.196.220` during the day
  because its traffic goes through a local proxy), and UDP/QUIC/WireGuard transports.
- Runtime ACL edits: `easytier-cli acl set` exists in the repository's newer CLI but **not
  in 2.6.4**; ACL changes today mean rewriting the config and restarting the node.
- A real wall-clock window rollover (simulated here by moving `since`), and multi-limit keys
  (5 h + week).
- Whether the peer-id/virtual-IP collisions seen on ungraceful restarts can be avoided by a
  supervisor-level clean shutdown alone.

## 10. Reproduction materials

- [`lab/provider-acl.toml`](lab/provider-acl.toml) — corrected provider config (Inbound
  Drop, Forward allow 3425, mapped export).
- [`lab/peer_echo.py`](lab/peer_echo.py) — the probe that prints the observed peer address.
- Commands are quoted in each section; the lab itself (two VPS nodes, the container, the
  Windows VM, the temporary UFW rules) was dismantled afterwards and the temporary
  gateway keys were deleted.
