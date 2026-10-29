# 2026-10-30 — Plugin skeleton: EasyTier supervisor and Gateway Key provisioner

Phase 3. The first product code: a Magpie community plugin that runs the EasyTier overlay and
issues consumer Gateway Keys, plus the mock top-up loop with no blockchain and no real money.
The ingress and quota semantics it relies on were measured in
[`2026-10-29-local-lab.md`](2026-10-29-local-lab.md) and
[`2026-10-29-acl-fix-and-two-host.md`](2026-10-29-acl-fix-and-two-host.md); this note records
what the plugin itself did on a real Magpie.

Everything below ran on **one macOS 26.6.2 (25G83, arm64) host** with **two isolated Magpie
0.1.2038 instances** ("provider" on `192.168.10.84:3441`, "consumer" on `127.0.0.1:3442`,
each a portable copy with its own data directory) and two `easytier-core 2.6.4` processes
downloaded by the plugin itself. No second physical machine was used in this phase; the
two-host run over the internet is in the previous note.

Evidence marks as before: **VERIFIED** (source), **REPRODUCED** (ran here), **UNKNOWN**.
Keys, secrets and e-mails are redacted.

---

## 1. What was built

A real Magpie community plugin (npm-shaped package with a Magpie page), not a side application:

| File | What it does |
| --- | --- |
| `plugin/src/index.ts` | the plugin entry Magpie imports and calls; host lifecycle, lock, orphan watchdog |
| `plugin/src/service.ts` | orchestration: configure, checks, connect a consumer, key operations |
| `plugin/src/easytier.ts` | supervisor: pinned download + SHA-256, TOML generation, ACL invariants, process control, peers, port forwards, LAN re-export, Secure Mode identity |
| `plugin/src/easytier-manifest.ts` | EasyTier 2.6.4 assets and their SHA-256 for 5 platforms |
| `plugin/src/magpie.ts` | argv-only Magpie CLI wrapper + `/v1/magpie/limit` client |
| `plugin/src/provisioner.ts` | consumer keys: model whitelist, positive cap, read-back, top-up, revoke |
| `plugin/src/server.ts` | loopback HTTP API (token for mutations) |
| `plugin/src/lock.ts` | one host per Magpie data directory, stale/orphan takeover |
| `plugin/src/run.ts` | process runner with no shell anywhere |
| `plugin/src/log.ts` | redacting log, page snapshot writer |
| `plugin/page/*` | the plugin page: settings through Magpie's bridge + a status snapshot |
| `plugin/bin/ohmyaihub.ts` | operator CLI |
| `plugin/demo/mock-topup.sh` | the simulated deposit → 429 → top-up → 200 loop |

No AI request passes through the plugin. Magpie keeps doing authentication, cost accounting and
429s; the plugin only manages the overlay and the keys.

---

## 2. Install, start, disable, enable, crash (REPRODUCED)

Installed into both instances with the product's own command and a local path (Magpie's
`plugin.Add` accepts a path: `internal/plugin/store.go`, `IsPath`/`Target`):

```
$ (cd provider && magpie plugin add /Users/laysath/Projects/magpie-oh-my-aihub-import/plugin)
✔ /…/plugin  on
  page  Oh My AIHub (reads nothing)

$ magpie plugin list
/…/plugin  on
  page  Oh My AIHub (reads nothing)
```

At Magpie boot the plugin host starts (Magpie's startup provider read asks the plugins) and the
plugin logs:

```
plugin boot: magpie 0.1.2038 (/…/p3/provider/Magpie.app/Contents/MacOS/magpie), cwd /…/p3/provider/data
host API listening on http://127.0.0.1:34517          # provider
host API listening on http://127.0.0.1:34518          # consumer (the next free port)
```

The binary is resolved from the parent process' argv and its working directory (a relative
`./Magpie.app/…` must not fall back to the installed app, which would manage the wrong data
directory). One host per data directory: a second one logs "another plugin host already owns
this Magpie data directory; standing by" and starts nothing.

| Step | Command | Observed |
| --- | --- | --- |
| install | `magpie plugin add <path>` | plugin listed with its page |
| provider configure | `ohmyaihub.ts --data provider/data configure --role provider --network magpie-p3 --secret … --listen 127.0.0.1:11011` | EasyTier 2.6.4 downloaded, SHA-256 verified, core started, `mappedCidr 10.66.239.57/32`, virtual IP `10.77.0.191/24` |
| consumer configure | `… --role consumer --network magpie-p3 --secret … --peer tcp://127.0.0.1:11011` | core started, peer `p2p 0.1 ms` |
| restart Magpie | kill the `serve`, start it again | both cores and both APIs came back from the persisted state |
| disable | `magpie plugin off <path>` then restart Magpie | plugin not loaded (`"off": true`), no host, **no EasyTier**, gateway still answers 401, consumer call times out |
| enable | `magpie plugin on <path>` then restart Magpie | checks pass again, consumer call 200 |
| crash | `kill -9 <easytier-core pid>` | supervisor restarted it in ~1 s (`exited unexpectedly (code 137)`), checks pass |

Disabling runs the orphan watchdog: a host whose Magpie is gone (`ppid` 1) stops its core and
exits within ~5 s, so an "off" plugin leaves no VPN behind. A core that survives a host crash is
adopted by the next host through the pid file instead of fighting it.

---

## 3. EasyTier supervisor (REPRODUCED)

- Version and integrity: the plugin downloaded `easytier-macos-aarch64-v2.6.4.zip`, compared its
  SHA-256 with the pinned `4be1882d…`, extracted it, and wrote the hash next to the binaries. A
  unit test stubs `fetch` to return bytes and asserts the download is **refused** on a hash
  mismatch; an unlisted platform is refused before any download.
- Generated TOML (provider, secret redacted):

  ```toml
  ipv4 = "10.77.0.191/24"
  listeners = ["tcp://127.0.0.1:11011"]
  proxy_network = [{ cidr = "192.168.10.84/32", mapped_cidr = "10.66.239.57/32" }]
  [flags]
  no_tun = true
  [secure_mode]
  enabled = true
  local_private_key = "<redacted>"
  local_public_key = "<redacted>"
  [acl.acl_v1]  # Forward: default Drop, allow tcp/3441 · Inbound: default Drop, no rules
  ```

- RPC: always spawned with `-r 127.0.0.1:<port>` (the TOML key is ignored by 2.6.4), and the
  status check fails if the RPC is bound anywhere else.
- Secure Mode: enabled with a **persisted X25519 keypair** (`[secure_mode] local_private_key` /
  `local_public_key`, base64; EasyTier's own format per `normalize_secure_mode_config`), so the
  peer's public key survives restarts. The pair's validity is unit-tested by deriving the public
  key from the private one.
- Peers: `easytier-cli -p 127.0.0.1:<rpc> -o json peer list` (`ipv4`, `hostname`, `cost`,
  `lat_ms`, `loss_rate`, `tunnel_proto`, `nat_type`, `id`).
- Port forwards: `port-forward add|remove|list` through the same RPC; every bind is checked to be
  `127.0.0.1` before the call and refused otherwise.
- LAN re-export: the provider's exported address is re-read every 15 s; a change rewrites the
  TOML and restarts the core (2.6.4 has no runtime ACL/proxy-network edit).
- **Refuses to publish when reality differs**: the generated config is checked for the ACL
  invariants before starting (tcp/udp whitelists, a missing Inbound chain, an Inbound rule, a
  Forward chain not defaulting to Drop, `forward_by_system`), and the *running* config is read
  back from the core (`easytier-cli … node -o json` → `config`) and checked again. A violation
  is a hard error, not a warning.

---

## 4. Security checks against the running plugin (REPRODUCED)

Provider status (after configure):

```
PASS  core-running: pid 56094
PASS  acl: Inbound Drop (no rules), Forward Drop with published ports
PASS  gateway-key-required: GET http://192.168.10.84:3441/v1/models without a key must answer 401
PASS  mapped-cidr: 10.66.239.57/32
```

Consumer status:

```
PASS  core-running
PASS  acl: Inbound Drop (no rules); nothing exported
PASS  consumer-ingress-keyed: 127.0.0.1:13425 must answer 401 without a key
```

The phase-2 bypass, retested against the **plugin-generated** config, from the consumer's
overlay:

| Request | Result |
| --- | --- |
| provider virtual IP `10.77.0.191:3441`, no key | `000` (dropped) |
| provider virtual IP `10.77.0.191:3441`, valid key | `000` (dropped — Inbound is not offered at all) |
| mapped address `10.66.239.57:3441` through the forward, no key | `401` |
| mapped address with the consumer key | `200` |
| provider ACL counters after the attempt | `InboundPacketsDropped 8 / InboundPacketsTotal 8` |

So the plugin's default export path cannot reopen the loopback rewrite, and the overlay carries
only the gateway port.

---

## 5. Gateway Key provisioner (REPRODUCED)

```
$ ohmyaihub.ts --data provider/data consumers add alice deepseek/deepseek-flash 0.0005
{"consumerId":"alice","keyName":"ohmyaihub-alice","keyId":"e0148b1d2e19b264003e04b2",
 "models":["deepseek/deepseek-flash"],"window":"day","capUsd":0.0005,"usedUsd":0,"leftUsd":0.0005,
 "spent":false,"reset":"2026-10-30T00:00:00+08:00"}

$ (cd provider && magpie gateway-key list)
e0148b1d…  ohmyaihub-alice  enabled  sk-magpie-key-…d4291a  $0.00/$0.00 per day  deepseek/deepseek-flash  all
```

The key was created with a whitelist and a positive cap, `quotas` turned off, and the numbers
above are a **read-back** from `GET /v1/magpie/limit` (not the CLI's text).

Refusals (all measured, HTTP 400 from the host API, nothing written):

| Request | Answer |
| --- | --- |
| models `[]` | `refusing to create a key without a model whitelist` |
| cap `0.000024` | `a consumer key needs a positive cost cap of at least $0.0001` |
| top-up `0.00001` | `the smallest top-up the key can express is $0.0001` |
| `mappedCidr 192.168.1.5/32` | `mappedCidr must look like 10.66.a.b/32` |
| mutation without the API token | `401 unauthorized` |
| a read-back that disagrees with the write | throws `read back costLimit …, wrote …` (unit test) |

---

## 6. The simulated deposit loop (REPRODUCED, end to end)

Consumer: `connect --id provider-a --cidr 10.66.239.57/32 --key … --port 3441` added the forward,
registered the provider as a native Remote Magpie, and verified the ingress. The consumer's model
list is `provider-a/deepseek/deepseek-flash`.

| Step | Result |
| --- | --- |
| chat through consumer → overlay → provider | `200`, 4.7 s first call (path setup), then under a second |
| provider sees the key's usage | 1 call, `$0.0000132` used, `$0.0004868` left |
| 5 calls with 300 output tokens | used `0.00055815` on a `0.0005` cap → **over budget, `spent: true`** (the soft ceiling) |
| next call | **429**, `Retry-After: 9156`, message names `ohmyaihub-alice`, its usage and reset time |
| simulated top-up | `topup alice 1` → `capUsd 1.0005`, `creditedUsd 1`, **used `0.00055815` preserved** |
| next call, **no consumer change** | **200**; used `0.00056775`, calls 7 |
| Magpie's own view | 1133 tokens, `$1.00` cap, `open` |
| revoke | key removed; next call `401 … is not an enabled magpie gateway key` |

This is the whole loop the architecture asks for, with no blockchain and no real money: consume
to the ceiling, native 429, raise the same key's cumulative cap, continue without re-creating the
Remote Magpie provider.

---

## 7. Tests

`bun test` — **26 pass, 0 fail** (3 files):

- ACL invariants: a good config passes; `tcp_whitelist`, a missing Inbound chain, an Inbound rule
  (even an allow for the gateway port), an Inbound/Forward default of Allow, and
  `forward_by_system` are each refused.
- Address allocation: unique `10.66.a.b/32` mapped prefixes, virtual addresses inside the overlay
  `/24` and never `.0/.1/.255`.
- Secure identity: the persisted X25519 private key derives the stored public key.
- Provisioner: no key without a whitelist, no cap below `$0.0001`, top-up keeps usage, a top-up
  below the overdraft leaves the key spent, re-ensuring keeps the cap, a mismatched read-back
  throws, revoke wipes the secret, no sub-grid top-up.
- Binaries: a SHA-256 mismatch is refused before anything is run; an unlisted platform is refused.

---

## 8. Two incidents during this phase (honest record)

1. **CPU saturation.** The first version called `magpie --version` at every host boot. In a
   portable copy whose bundle is already running `magpie serve`, spawning the bundle again for
   `--version` spins (the app tries to hand off to the running instance); with the host being
   restarted by Magpie, dozens of those processes accumulated and saturated the machine. Fixed:
   the version is read from the macOS bundle's `Info.plist` (what Magpie itself does in
   `internal/update/cli_path.go`), the CLI is never spawned at boot, every CLI call is serialized
   with a timeout, and one host per data directory is enforced by a lock. On Linux/Windows the
   fallback is one 3 s `--version` call, cached, only when a status is requested.
2. **Agent configuration was rewritten.** Magpie's agent-catalog sync runs in any instance,
   including a portable copy, and rewrote `~/.pi/agent/models.json` to point at the lab provider
   (`http://192.168.10.84:3441/v1`). Restored with the real Magpie
   (`magpie pi group/deepseek-v4.1-flash` → `http://127.0.0.1:3425/v1`, 29 models, no lab
   entries); Codex/Claude configs were untouched. Lab procedure now isolates `HOME` for a
   portable instance.

Neither is a plugin design choice; both are properties of running a second Magpie instance on a
machine that already has one.

---

## 9. Not implemented / UNKNOWN

- Windows and Linux **Magpie** end to end (Linux EasyTier is verified; Linux Magpie needs a
  desktop stack for its release binary, the container works).
- The plugin page in a real browser: Magpie serves plugin pages with `connect-src 'none'`, so the
  page is settings-only; status comes from the host-written `page/status.js` snapshot. Settings
  are written through Magpie's bridge (`magpie.options.set`).
- Several providers on one consumer beyond the duplicate-prefix check (the plugin refuses when two
  peers announce the same mapped prefix).
- Long-run stability, reconnection after an egress change, and the wallet/chain work (out of
  scope, later phase).
- Price pinning for outstanding credit remains the known blocker (see `docs/ARCHITECTURE.md`).

## 10. Reproduce

```sh
# install
magpie plugin add /absolute/path/to/plugin
# configure (provider shown; consumer swaps --role/--peer)
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie configure \
  --role provider --network my-private-net --secret 'a long network secret' --listen 127.0.0.1:11010
# issue a key and run the simulated deposit loop
PROVIDER_DATA=… CONSUMER_DATA=… MAPPED_CIDR=10.66.a.b/32 PROVIDER_PORT=3425 \
MODEL=deepseek/deepseek-flash CONSUMER_URL=http://127.0.0.1:3425 \
  ./plugin/demo/mock-topup.sh
```
