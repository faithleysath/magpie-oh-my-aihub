# Oh My AIHub — Magpie plugin

A Magpie community plugin that runs a private **EasyTier no-TUN** overlay, publishes this node's
Magpie to peers that hold a **Gateway Key**, and connects this node to **several remote Magpies**
at once. It is not an AI gateway: every AI request goes consumer agent → consumer Magpie →
EasyTier → provider Magpie, and Magpie itself does the authentication, cost/token accounting and
429s.

- Verified against Magpie **0.1.2038** and EasyTier **2.6.4** (pinned; see
  `src/easytier-manifest.ts`).
- macOS is tested end to end (phase 3 and the phase-4 lab). Linux uses the same code paths and the
  same pinned EasyTier build and runs in CI; Windows is untested.
- No wallet, no chain, no automatic top-up. "Top up" is a local, simulated credit.

## The two capabilities (both may be on)

| Capability | What it does |
| --- | --- |
| `sharingEnabled` | Publishes this node's Magpie on the overlay: one export of the node's own LAN address `/32` under a persisted `10.66.a.b/32`, and a Forward chain that allows exactly the published gateway ports. |
| `consumingEnabled` | Uses remote providers: one `ProviderConnection` per remote Magpie, each with its own loopback forward, Remote Magpie registration, Gateway Key and status. |

They share **one** EasyTier core and one network identity: a second core on the same machine would
fight over the network name, the instance id and the listener ports. Phase-3 configurations
migrate automatically (`provider` → sharing, `consumer` → consuming).

## Install

The plugin is a local package; Magpie installs it with `bun add` and runs its `src/index.ts` in the
plugin host:

```sh
magpie plugin add /absolute/path/to/this/repo/plugin
magpie plugin list          # shows "Oh My AIHub (reads nothing)"
```

Two things happen on install:

1. Magpie imports `src/index.ts` in its plugin host and calls the default export. The host starts
   with Magpie (its startup provider read asks the plugins), runs with Magpie's settings directory
   as its working directory, and lives as long as Magpie.
2. The plugin takes a lock in `<magpie data>/oh-my-aihub/host.lock`, writes its state there, starts
   the EasyTier supervisor if a configuration exists, and serves a loopback API.

Turn it off and on with `magpie plugin off|on <spec>`. A host whose Magpie is gone (or a plugin
that is off) stops its EasyTier and exits within a few seconds.

Requirements: Magpie's own Bun (`magpie plugin add` downloads it) and a network path between the
nodes. The plugin downloads EasyTier itself on first start (see below).

## Configure

Either the plugin page (**Oh My AIHub** in Magpie's sidebar: both capabilities, network name,
secret, initial peers, listen address, published ports, shared models, Secure Mode), or the
loopback API/CLI. Options in the page are read when the plugin host starts; Magpie restarts the host
when a plugin is set, installed or updated.

```sh
# a node that both shares its Magpie and uses remote ones
bun bin/ohmyaihub.ts --data ~/.config/magpie configure \
  --network my-private-net --secret 'a long network secret' \
  --peer tcp://relay.example.com:11010 \
  --share --consume --listen 127.0.0.1:11010 --ports 3425

bun bin/ohmyaihub.ts --data ~/.config/magpie share on|off
bun bin/ohmyaihub.ts --data ~/.config/magpie share models 'provider/*,other/model'
bun bin/ohmyaihub.ts --data ~/.config/magpie consume on|off
```

`--role provider` / `--role consumer` still work as shorthand, and an existing phase-3 state is
migrated in place (with a backup) on the first start.

### Sharing

The provider exports **its own LAN address as a `/32`** (never a subnet) under a random, persisted
overlay prefix `10.66.a.b/32`, and the Forward ACL opens exactly its published gateway port (3425
unless Magpie listens elsewhere). The Inbound chain drops everything: no rule may ever name a
Magpie port, because in no-TUN a flow to the node's virtual IP is rewritten to `127.0.0.1`, where
Magpie would trust it as a local caller.

Which models may be shared:

- only this node's **own** providers (Magpie's `providers.json` entry without the `remote-magpie`
  preset); a Remote Magpie is somebody else's channel and is refused, so a shared key can never
  resell a peer's models;
- the per-key whitelist is mandatory and must also be inside the operator's `share.models` allow
  list (`*` by default, `provider/*` or `provider/model` globs);
- `group/…` and `auto/…` entries are refused for shared keys, because a native group may contain
  imported models;
- issued keys are re-checked when a provider changes and at every hand-over: unshareable entries
  are removed from the key, and a key with nothing left is revoked.

The guard that keeps shared keys native runs at start, after every reconcile, and on a 15 s poll:
it compares Magpie's own key store (an empty model list means "every model") with the operator's
shareable set, narrows keys that were widened by hand and revokes a key with nothing shareable
left. If Magpie's provider list cannot be read, sharing is **suspended** — the export and Forward
chain are withdrawn, no key is revoked on a transient error — and republished automatically when
the check passes again. `checks` reports `sharing-suspended` and `shared-models-native-only`.
The protection window is bounded by the poll interval (~15 s), not zero; see the known limits.

Turning sharing off withdraws the export and the Forward chain, and deletes nothing in Magpie:
local providers, models and issued Gateway Keys stay.

### Consuming

Hand the provider's `mappedCidr` and this consumer's Gateway Key over (out of band; the provider
operator reads both with `secret <consumer>`):

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie provider add peer-b \
  --cidr 10.66.12.34/32 --key 'sk-…' --port 3425 [--local-port 13425]

bun bin/ohmyaihub.ts --data ~/.config/magpie providers
bun bin/ohmyaihub.ts --data ~/.config/magpie provider update peer-b --key 'sk-…'
bun bin/ohmyaihub.ts --data ~/.config/magpie provider rm peer-b
```

`provider add` adds a `127.0.0.1:<port>` → `<mappedCidr>:<provider port>` forward through EasyTier,
registers the provider as a native **Remote Magpie**, and refuses to finish unless the ingress
answers 401 without a key **and** with a wrong key, and the valid key lists at least one model.
Each provider gets its own loopback port and its own key; adding the same id again is idempotent.
A failure restores the previous registration of that id and leaves the other providers alone.

**Ownership.** The plugin only replaces or removes a Magpie provider it can prove it wrote: the
connection record must exist, the entry must be a Remote Magpie, its URL must be exactly this
connection's loopback forward, and its key must be the one in the key store. A same-named native
provider, a different Remote Magpie, or an entry edited by hand is refused, reported as `degraded`
("changed outside this plugin") and left untouched — by connect, update, delete, `consume off` and
restart recovery alike. To take over an entry the plugin does not own, remove it in Magpie first.

**Retargeting.** `provider update` that changes `mappedCidr` or `providerPort` moves the connection to
a **fresh** loopback port, proves the new path, replaces the registration and restarts EasyTier once
so the old listener is gone. A failed switch restores the old registration and keeps the old
connection working. Reusing the same loopback port for a new target is refused (2.6.4 cannot
retarget a live forward).

Every provider is checked independently: one that goes down is `degraded` while the others keep
serving; one that is removed or updated does not delete the others' registrations. If the overlay
starts announcing a provider's mapped prefix from a different hostname, that provider is
`identity-mismatch` and is unregistered until its own hostname is back (the Gateway Key is the real
guard; see the identity note below).

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

- only native, allowed models (above), one operation per consumer at a time, and a deposit id that
  makes a replayed top-up a no-op,
- a cap recorded as pending before Magpie is written, so a crash between the write and the local
  commit is reconciled from what the gateway actually holds,
- a key whose whitelist or cap cannot be applied is **deleted**, never handed over,
- a hand-over runs the share guard first, then re-reads the key from Magpie: a key revoked during
  the check is never delivered, an empty (all-models) whitelist is repaired first, and the returned
  model list is the one Magpie holds (the cap is the one just read back),
- a non-empty model whitelist; an empty one is refused,
- a positive cost cap of at least **$0.0001** on Magpie's exact grid, finite and bounded,
- every write is read back from `GET /v1/magpie/limit` and must match,
- top-ups raise the cumulative cap and never `reset` usage,
- revoking removes the key from Magpie and wipes the stored secret.

Magpie's own 429 is the only refusal: the plugin adds no per-request budget, proxy or gate.

## Status

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie status     # JSON summary
bun bin/ohmyaihub.ts --data ~/.config/magpie checks     # PASS/FAIL, exits 1 on failure
bun bin/ohmyaihub.ts --data ~/.config/magpie providers  # one line per remote provider
bun bin/ohmyaihub.ts --data ~/.config/magpie provider reconcile
bun bin/ohmyaihub.ts --data ~/.config/magpie stop|start # supervisor only
```

The host API listens on `127.0.0.1:<port>` (port file `<data>/oh-my-aihub/api-port`) and requires
`Authorization: Bearer <token>` (`<data>/oh-my-aihub/api-token`, mode 0600) for mutations.
Read-only `GET /status`, `/checks`, `/providers` and `/consumers` are open on loopback.

Checks include: the core is running; the **effective** ACL (read back from the running core, not
just the file) has Inbound Drop with no rules, Forward Drop with exactly the published ports, and
only loopback forwards; the gateway answers 401 without a key from the provider's own address; the
mapped prefix is announced; the published ports contain the gateway; every issued key names only
native, allowed models (and sharing is withdrawn, with `sharing-suspended`, if that cannot be
proven); each remote provider has a loopback forward, a Remote Magpie entry the plugin owns and a
healthy status; and no loopback listener is left without a provider.

The plugin page cannot fetch any of this: Magpie serves plugin pages with `connect-src 'none'`.
The host writes `page/status.js` and the page reloads to show it. This is a Magpie limitation, not a
choice (see `docs/ARCHITECTURE.md`).

## EasyTier supervisor

- Pins EasyTier **2.6.4** (`8428a89d…`); downloads the release asset for the platform, verifies its
  **SHA-256** against `src/easytier-manifest.ts`, and refuses a mismatch or an unlisted platform.
- Generates the TOML itself, with `no_tun = true`, the ACL invariants above, `mapped_cidr` while
  sharing, `[[port_forward]]` entries while consuming, a persisted **instance id** and a
  **hostname** (`ohmyaihub-<nodeId>`), and Secure Mode with a persisted X25519 identity.
- Runs the management RPC on `-r 127.0.0.1:<port>` (the TOML key is ignored by 2.6.4 and the
  default binds `0.0.0.0`), and checks that the RPC is not on another address.
- Verifies the **installed binaries' own SHA-256** on every start and reinstalls from the pinned
  archive on a mismatch.
- Restarts a crashed core with backoff (5 attempts), adopts a core that survived a host restart (pid
  file, only when its command line runs *our* config, so a recycled pid is never touched), and
  stops its core when Magpie (or the plugin) goes away.
- Watches the provider's own address: a change seen twice, at least a minute after the previous
  move, rewrites the export with a supervised restart (2.6.4 has no hot ACL/proxy edit).
- Port forwards are part of the generated config, added live (idempotently) and removed by a
  supervised restart: EasyTier 2.6.4 prints success for `port-forward remove` but keeps the
  listener (source and measurement in `docs/ARCHITECTURE.md`, Decision 12).

## How it talks to Magpie

Magpie 0.1.2038 has **no public management API**. What exists, and what this plugin uses:

| Surface | What it does | Used? |
| --- | --- | --- |
| `magpie gateway-key add\|models\|limit\|quotas\|remove\|rotate` | the only supported write path; same code as the GUI (`internal/access.Update`: in-process lock, atomic write of `caller-keys.json`) | **yes**, with argv arrays only, serialized, time-limited |
| `GET /v1/magpie/limit` (with the consumer key) | the key's own cap, usage, reset | **yes**, every write is verified by reading it back |
| `magpie providers`, `magpie models`, `providers.json` | native vs Remote Magpie providers, the model list | **yes**, to enforce "share native models only" and to verify registrations |
| `magpie provider add remote-magpie\|rm\|set` | Remote Magpie registration | **yes**, idempotent, key never logged |
| `GET /v1/models` **through the forward** with the provider's key | the strongest health probe: the key is valid and the provider serves models | **yes**, on connect and reconcile |
| `GET /v1/magpie/usage`, `/usage/requests`, `/quotas`, `/route` | read-only reporting | only for diagnostics |
| `POST /api/caller-keys/…` (the window's admin API) | the same writes | **no**: it exists only inside the app's webview (`wails://`) or behind `magpie web`'s cookie/key, and the admin surface must never be exposed |
| in-tree `pluginrt` gateway service (`plugins/gateway`) | key management in Go | **no**: only packages under `plugins/` may import it |

Two consequences:

- The plugin parses **one** line of human output (the `sk-…` secret from `gateway-key add`).
  Everything else comes from `caller-keys.json`, `providers.json` and the read-only API, and a
  write that does not read back is an error. Calls are serialized so a stuck CLI cannot pile up.
- The CLI is the product's own path but not a contract: there is no `--json` for `gateway-key` in
  0.1.2038 (nor in the latest source at the time of writing). Adding one — or a token-gated
  loopback management endpoint — is the smallest upstream change that would remove the last text
  dependency. It is a suggestion, not a blocker.

The Magpie version is a label and never a reason to start a process: on macOS it is read from the
app bundle's `Info.plist` (what Magpie itself does in `internal/update/cli_path.go`); on
Linux/Windows the plugin falls back to `magpie --version` with a 3 s timeout, once, cached, and only
when a status is asked for.

## State on disk

All under `<magpie data>/oh-my-aihub/`, mode 0600:

| File | Contents |
| --- | --- |
| `state.json` | versioned plugin state: config (both capabilities, node id, instance id, network, export, share policy), consumer ids, provider records, orphan forwards |
| `provider-keys.json` | the Gateway Key of each remote provider, by connection id (`keyRef` points here) |
| `consumers.json` | provider-owned consumer keys: whitelist, cap, deposits, pending intent |
| `easytier/` | the verified binaries, the generated `current.toml`, the supervisor's pid state |
| `api-token`, `api-port` | loopback API credentials |
| `plugin.log` | redacted log |

Writes are atomic (temporary file + fsync + rename + directory fsync), the previous document is kept
as `.prev`, and a `state.json` that cannot be parsed is recovered from it. A migration to the
current schema writes `state.json.bak-<timestamp>` first. The key store is separate so a status
view, a log line or a page snapshot never has to touch a secret.

## Layout

```
src/index.ts            plugin entry (Magpie's OpenCode-style export), host lifecycle
src/service.ts          orchestration: capabilities, providers, checks, keys, reconciliation
src/state.ts            versioned state, migration, key-store references
src/store.ts            atomic JSON writes, previous-copy recovery, backups
src/addresses.ts        persisted virtual IP and per-provider mapped prefix
src/easytier.ts         supervisor, TOML generation, ACL checks, addresses, forwards, identity
src/easytier-manifest.ts pinned release assets and SHA-256
src/magpie.ts           argv-only Magpie CLI wrapper + /v1/magpie/limit + provider/model views
src/provisioner.ts      consumer keys: create, cap, verify, top-up, revoke, whitelist updates
src/server.ts           loopback HTTP API
src/acl.ts              strict verifier of the generated and the running configuration
src/lock.ts             one host per data directory, stale takeover
src/run.ts              process runner without a shell
src/log.ts              redacting log + page snapshot writer
page/                   the plugin page (settings + read-only status snapshot)
bin/ohmyaihub.ts        operator CLI
test/                   bun tests (state migration, ACL invariants, keys, providers, addresses)
docs/validation/lab/phase4/  the three-instance end-to-end lab
```

## CI

`bun run ci` (= `bun run typecheck && bun test && bun run boot-check && bun run secret-scan`)
runs the TypeScript check, the unit tests, a boot of the real plugin entry against a stub Magpie in
an isolated HOME/data directory, and a credential scan. GitHub Actions runs the same on Linux and
macOS for every pull request that touches `plugin/`.

## Known limits

- `magpie plugin off` stops the host, and the host stops EasyTier; but Magpie starts the host only
  when it boots, its plugins page asks, or its plugin page is opened. After `on`, restart Magpie (or
  open the page) before the supervisor runs again.
- A host that a `magpie` CLI started (e.g. `plugin add`) is adopted by the next Magpie start if it
  is still alive; the lock plus the orphan watchdog keep one owner per data directory.
- Plugin pages cannot reach the network, so there is no live status in the page and no button that
  performs an action. The loopback API/CLI is the operator interface.
- The provider must let its Magpie listen on a non-loopback address (Settings → Share on local
  network) for the subnet-proxy path to reach it; the check `gateway-key-required` fails loudly if
  it does not.
- Removing or relocating a provider restarts EasyTier (2.6.4 cannot close a forward live), which
  interrupts the other providers' in-flight requests; they recover immediately, and the lab checks
  it.
- A remote provider's identity is the overlay hostname + mapped prefix + its Gateway Key. 2.6.4
  does not expose a peer's public key through the CLI, so this is a drift alarm, not cryptographic
  authentication; see `docs/ARCHITECTURE.md`, Decision 9.
- The no-resale guard is polled (every 15 s and on reconcile), so an external provider replacement is
  blocked within that window, not instantaneously. Absolute real-time prevention is UNKNOWN until
  Magpie can make a key's provider scope immutable (see Decision 10).
- If the plugin's connection record is lost (e.g. `state.json` recovered from `.prev` after a
  provider was registered), the Magpie entry is treated as foreign and is not overwritten; remove it
  in Magpie before re-adding it.
- A shared key cannot name a routing group, even a purely native one: Magpie's group membership is
  not part of the key read-back, so it cannot be proven native.
- Model pricing is Magpie's estimate at its current prices; changing a shared model's price
  recomputes past charges. Do not change prices while credit is outstanding (blocker for the wallet
  phase).
- Windows is untested; Linux EasyTier is tested, Linux Magpie is not (its release binary needs a
  desktop stack; the official container works). The phase-4 lab ran on macOS with three isolated
  Magpie instances, not three physical machines.
