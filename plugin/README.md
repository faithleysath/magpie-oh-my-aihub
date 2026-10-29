# Oh My AIHub — Magpie plugin

A Magpie community plugin that runs a private **EasyTier no-TUN** overlay and issues
**Magpie Gateway Keys** to consumers. It is not an AI gateway: every AI request goes
consumer agent → consumer Magpie → EasyTier → provider Magpie, and Magpie itself does the
authentication, cost/token accounting and 429s.

- Verified against Magpie **0.1.2038** and EasyTier **2.6.4** (pinned; see
  `src/easytier-manifest.ts`).
- macOS is tested. Linux uses the same code paths and the same pinned EasyTier build, but was
  not run end to end here; Windows is untested.
- No wallet, no chain, no automatic top-up in this version. "Top up" is a local, simulated
  credit.

## Install

The plugin is a local package; Magpie installs it with `bun add` and runs its `src/index.ts`
in the plugin host:

```sh
# the binary Magpie already runs
magpie plugin add /absolute/path/to/this/repo/plugin
magpie plugin list          # shows "Oh My AIHub (reads nothing)"
```

Two things happen on install:

1. Magpie imports `src/index.ts` in its plugin host and calls the default export. The host
   starts with Magpie (its startup provider read asks the plugins), runs with Magpie's
   settings directory as its working directory, and lives as long as Magpie.
2. The plugin takes a lock in `<magpie data>/oh-my-aihub/host.lock`, writes its state there,
   starts the EasyTier supervisor if a configuration exists, and serves a loopback API.

Turn it off and on with `magpie plugin off|on <spec>`. A host whose Magpie is gone (or a
plugin that is off) stops its EasyTier and exits within a few seconds.

Requirements: Magpie's own Bun (`magpie plugin add` downloads it) and a network path between
the nodes. The plugin downloads EasyTier itself on first start (see below).

## Configure

Either the plugin page (**Oh My AIHub** in Magpie's sidebar: role, network name, secret,
initial peers, listen address, published ports, Secure Mode), or the loopback API/CLI.
Options in the page are read when the plugin host starts; Magpie restarts the host when a
plugin is set, installed or updated.

**Provider** (the computer that serves a Magpie gateway):

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie configure \
  --role provider --network my-private-net --secret 'a long network secret' \
  --listen 127.0.0.1:11010
```

The provider exports **its own LAN address as a `/32`** (never a subnet) under a random,
persisted overlay prefix `10.66.a.b/32`, and the Forward ACL opens exactly its published
gateway port (3425 unless Magpie listens elsewhere). The Inbound chain drops everything: no
rule may ever name a Magpie port, because in no-TUN a flow to the node's virtual IP is
rewritten to `127.0.0.1`, where Magpie would trust it as a local caller.

**Consumer** (the computer that uses a provider):

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie configure \
  --role consumer --network my-private-net --secret 'the same secret' \
  --peer tcp://relay.example.com:11010
```

Then hand the provider's `mappedCidr` and the consumer's Gateway Key over (out of band; the
provider operator reads both with `secret <consumer>`):

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie connect \
  --id provider-a --cidr 10.66.12.34/32 --key 'sk-…' --port 3425
```

`connect` adds a `127.0.0.1:<port>` → `10.66.12.34:<provider port>` forward through EasyTier,
registers the provider as a native **Remote Magpie** in the consumer's Magpie, and refuses to
finish unless the ingress answers 401 without a key.

## Consumers and simulated credit

```sh
# one provider-owned key per consumer: model whitelist + positive cost cap
bun bin/ohmyaihub.ts --data ~/.config/magpie consumers add alice deepseek/deepseek-flash 1
# the key to hand to the consumer (never printed in logs)
bun bin/ohmyaihub.ts --data ~/.config/magpie secret alice
# add credit: raises the SAME key's cumulative cap, keeps its usage
bun bin/ohmyaihub.ts --data ~/.config/magpie topup alice 1
# stop a consumer
bun bin/ohmyaihub.ts --data ~/.config/magpie revoke alice
```

What the plugin enforces on every key (the architecture's non-negotiables):

- one operation per consumer at a time, and a deposit id makes a replayed top-up a no-op,
- a cap recorded as pending before Magpie is written, so a crash between the write and the
  local commit is reconciled from what the gateway actually holds,
- a key whose whitelist or cap cannot be applied is **deleted**, never handed over,
- a non-empty model whitelist; an empty one is refused,
- a positive cost cap of at least **$0.0001** on Magpie's exact grid, finite and bounded
  (a smaller value silently means *unlimited*),
- every write is read back from `GET /v1/magpie/limit` and must match,
- top-ups raise the cumulative cap and never `reset` usage,
- revoking removes the key from Magpie and wipes the stored secret.

Magpie's own 429 is the only refusal: the plugin adds no per-request budget, proxy or gate.

## Status

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie status     # JSON summary
bun bin/ohmyaihub.ts --data ~/.config/magpie checks     # PASS/FAIL, exits 1 on failure
bun bin/ohmyaihub.ts --data ~/.config/magpie stop|start # supervisor only
```

The host API listens on `127.0.0.1:<port>` (port file `<data>/oh-my-aihub/api-port`) and
requires `Authorization: Bearer <token>` (`<data>/oh-my-aihub/api-token`, mode 0600) for
mutations. Read-only `GET /status` and `GET /checks` are open on loopback.

Checks include: the core is running; the **effective** ACL (read back from the running core,
not just the file) has Inbound Drop with no rules and Forward Drop with the published ports;
the gateway answers 401 without a key from the provider's own address; the mapped prefix is
announced; and, on a consumer, the local ingress answers 401.

The plugin page cannot fetch any of this: Magpie serves plugin pages with
`connect-src 'none'`. The host writes `page/status.js` and the page reloads to show it. This
is a Magpie limitation, not a choice (see `docs/ARCHITECTURE.md`).

## EasyTier supervisor

- Pins EasyTier **2.6.4** (`8428a89d…`); downloads the release asset for the platform,
  verifies its **SHA-256** against `src/easytier-manifest.ts`, and refuses a mismatch or an
  unlisted platform.
- Generates the TOML itself, with `no_tun = true`, the ACL invariants above, `mapped_cidr` for
  providers, and Secure Mode with a **persisted X25519 identity** so the peer's public key
  survives restarts.
- Runs the management RPC on `-r 127.0.0.1:<port>` (the TOML key is ignored by 2.6.4 and the
  default binds `0.0.0.0`), and checks that the RPC is not on another address.
- Verifies the **installed binaries' own SHA-256** on every start (a recorded hash per binary,
  not only the archive marker) and reinstalls from the pinned archive on a mismatch.
- Restarts a crashed core with backoff (5 attempts), adopts a core that survived a host
  restart (pid file, only when its command line runs *our* config, so a recycled pid is never
  touched), and stops its core when Magpie (or the plugin) goes away.
- Watches the provider's own address: a change seen twice, at least a minute after the previous
  move, rewrites the export with a supervised restart (2.6.4 has no hot ACL/proxy edit).
- Detects a change of the provider's LAN address and rewrites the export with a supervised
  restart (2.6.4 has no runtime ACL/proxy-network edit).
- Port forwards are added/removed through `easytier-cli`, always bound to `127.0.0.1`.

## How it talks to Magpie

Magpie 0.1.2038 has **no public management API**. What exists, and what this plugin uses:

| Surface | What it does | Used? |
| --- | --- | --- |
| `magpie gateway-key add\|models\|limit\|quotas\|remove\|rotate` | the only supported write path; same code as the GUI (`internal/access.Update`: in-process lock, atomic write of `caller-keys.json`) | **yes**, with argv arrays only, serialized, time-limited |
| `GET /v1/magpie/limit` (with the consumer key) | the key's own cap, usage, reset | **yes**, every write is verified by reading it back |
| `GET /v1/magpie/usage`, `/usage/requests`, `/quotas`, `/route` | read-only reporting | only for diagnostics |
| `POST /api/caller-keys/…` (the window's admin API) | the same writes | **no**: it exists only inside the app's webview (`wails://`) or behind `magpie web`'s cookie/key, and the admin surface must never be exposed |
| in-tree `pluginrt` gateway service (`plugins/gateway`) | key management in Go | **no**: only packages under `plugins/` may import it |

Two consequences:

- The plugin parses **one** line of human output (the `sk-…` secret from `gateway-key add`).
  Everything else comes from `caller-keys.json` and the read-only API, and a write that does
  not read back is an error. Calls are serialized so a stuck CLI cannot pile up.
- The CLI is the product's own path but not a contract: there is no `--json` for
  `gateway-key` in 0.1.2038 (nor in the latest source at the time of writing). Adding one — or
  a token-gated loopback management endpoint — is the smallest upstream change that would
  remove the last text dependency. It is a suggestion, not a blocker.

The Magpie version is a label and never a reason to start a process: on macOS it is read from
the app bundle's `Info.plist` (what Magpie itself does in `internal/update/cli_path.go`); on
Linux/Windows the plugin falls back to `magpie --version` with a 3 s timeout, once, cached, and
only when a status is asked for.

## Layout

```
src/index.ts            plugin entry (Magpie's OpenCode-style export), host lifecycle
src/service.ts          orchestration: configure, checks, connect, key operations
src/easytier.ts         supervisor, TOML generation, ACL checks, addresses, identity
src/easytier-manifest.ts pinned release assets and SHA-256
src/magpie.ts           argv-only Magpie CLI wrapper + /v1/magpie/limit client
src/provisioner.ts      consumer keys: create, cap, verify, top-up, revoke
src/server.ts           loopback HTTP API
src/lock.ts             one host per data directory, stale takeover
src/run.ts              process runner without a shell
src/log.ts              redacting log + page snapshot writer
page/                   the plugin page (settings + status snapshot)
bin/ohmyaihub.ts        operator CLI
test/                   bun tests (ACL invariants, keys, addresses, binary hashes)
```

## CI

`bun run ci` (= `bun run typecheck && bun test && bun run boot-check && bun run secret-scan`)
runs the TypeScript check, the unit tests, a boot of the real plugin entry against a stub
Magpie in an isolated HOME/data directory, and a credential scan. GitHub Actions runs the
same on Linux and macOS for every pull request that touches `plugin/`.

## Known limits

- `magpie plugin off` stops the host, and the host stops EasyTier; but Magpie starts the host
  only when it boots, its plugins page asks, or its plugin page is opened. After `on`, restart
  Magpie (or open the page) before the supervisor runs again.
- A host that a `magpie` CLI started (e.g. `plugin add`) is adopted by the next Magpie start
  if it is still alive; the lock plus the orphan watchdog keep one owner per data directory.
- Plugin pages cannot reach the network, so there is no live status in the page and no button
  that performs an action. The loopback API/CLI is the operator interface.
- The provider must let its Magpie listen on a non-loopback address (Settings → Share on
  local network) for the subnet-proxy path to reach it; the check `gateway-key-required`
  fails loudly if it does not.
- Model pricing is Magpie's estimate at its current prices; changing a shared model's price
  recomputes past charges. Do not change prices while credit is outstanding (blocker for the
  wallet phase).
- Windows is untested; Linux EasyTier is tested, Linux Magpie is not (its release binary needs
  a desktop stack; the official container works).
