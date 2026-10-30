# Oh My AIHub — Magpie plugin

A Magpie community plugin that runs a private **EasyTier no-TUN** overlay, publishes this node's
Magpie to peers that hold a **Gateway Key**, connects this node to **several remote Magpies** at
once, and optionally discovers peers' read-only catalogues. It is not an AI gateway: every AI
request goes consumer agent → consumer Magpie → EasyTier → provider Magpie, and Magpie itself does
the authentication, cost/token accounting and 429s.

- Magpie **0.1.2038** is the host/CLI and pricing/billing pin; EasyTier **2.6.4** is pinned by
  SHA-256 in `src/easytier-manifest.ts`. A Linux Magpie **0.1.2057** official container was verified
  as a consumer. Magpie **0.1.2120** is compared for the page/bridge source; an isolated `magpie web`
  browser run on **0.1.2171** verified the page/CSP/Save flow, but full host/CLI behaviour on
  0.1.2120/0.1.2171 is **UNKNOWN** (desktop WKWebView not measured).
- macOS is tested end to end (phase 3 and the phase-4 lab). Linux EasyTier and the Linux consumer
  container are tested; Linux Magpie GUI/provider behaviour is **untested**. Windows is untested.
- Manual `topup` is simulated credit. A separate **testnet chain wallet** can credit mock test tokens
  after that chain's own finality; it holds no private key and never touches a mainnet asset. Real
  funds remain blocked.

Start with [onboarding](../docs/ONBOARDING.md) for the five-minute install and the two roles, then
keep [operations](../docs/OPERATIONS.md) for the daily loop, anomalies, revocation, backup/restore
and network exit. The phase-8 acceptance evidence is in
[`../docs/validation/2026-10-30-phase8-onboarding-ux.md`](../docs/validation/2026-10-30-phase8-onboarding-ux.md).
The page is the read-only view; the loopback API/CLI is the operator interface.

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

Requirements:

- Magpie 0.1.2038 for the verified host/CLI path (0.1.2120 page/bridge only; see above), and a
  network path between the nodes. Magpie must let its gateway listen on a non-loopback address
  (Settings → Share on local network), or the plugin's `gateway-key-required` check fails.
- **Bun 1.4.3 on `PATH`** for the operator CLI (`bun bin/ohmyaihub.ts …`). Magpie's internal Bun is
  not installed as a shell command; `magpie plugin add` does not create one.

The plugin downloads EasyTier itself on first start (see below).

After the first start, the page shows the snapshot and the setup form. **The form submits the whole
options object; leaving a field unchanged is fine, but blanking a field is a real change, not a way
to keep the old value.** The host records the applied options and applies only changed keys, so a
stale page does not silently revert a later CLI change. The network secret is part of that object
and is shown as a password field; never screenshot or share the page.

A save makes Magpie restart the shared plugin host: the EasyTier core, the overlay and the local
operator API disappear for a few seconds, and Magpie starts the host again only when something asks
it (opening the page does). Reload the page after the restart. Do not save while an AI request is in
flight. After onboarding, use the CLI for state changes.

## Configure

Either the plugin page (**Oh My AIHub** in Magpie's sidebar: both capabilities, network name,
secret, initial peers, listen address, published ports, shared models, Secure Mode), or the
loopback API/CLI. Options in the page are read when the plugin host starts; a save of the page's
setup options also restarts the shared plugin host (the overlay and loopback API are briefly gone),
and Magpie restarts it when a plugin is set, installed or updated. After onboarding, use the CLI for
state changes.

```sh
# a node that both shares its Magpie and uses remote ones; secret is hidden or 0600-file input
bun bin/ohmyaihub.ts --data ~/.config/magpie setup \
  --network my-private-net --prompt-secret \
  --peer tcp://relay.example.com:11010 \
  --share --consume --listen 0.0.0.0:11010 --ports 3425

bun bin/ohmyaihub.ts --data ~/.config/magpie share setup --all-priced
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

The guard that keeps shared keys native runs at start, after every reconcile (about every 45 s),
after configure/connect/update/remove, at every hand-over, and whenever the 15 s provider-id
fingerprint changes. It compares Magpie's own key store (an empty model list means "every model")
with the operator's shareable set, narrows keys that were widened by hand and revokes a key with
nothing shareable left. If Magpie's provider list cannot be read, sharing is **suspended** — the
export and Forward chain are withdrawn, no key is revoked on a transient error — and republished
automatically when the check passes again. `checks` reports `sharing-suspended` and
`shared-models-native-only`.

Two changes have two deadlines, and they are not both 15 s:

- a provider **id/type** replacement changes the 15 s fingerprint and is seen on that tick;
- a direct edit of a **Gateway Key's model whitelist** does not change that fingerprint; the full
  guard sees it on the ~45 s reconcile pass, or at the next hand-over. The protection window is
  bounded by those intervals, not zero; see the known limits.

Turning sharing off withdraws the export and the Forward chain, and deletes nothing in Magpie:
local providers, models and issued Gateway Keys stay.

### Catalogue (read-only, opt-in)

A node may publish a small signed JSON document of its shareable native models, API capabilities,
explicit prices, simulated minimum top-up, mapped address and gateway port. Another node may
discover it from EasyTier's peer/route list and read it through EasyTier's loopback SOCKS5 portal.

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie catalog config --display-name "My Magpie" --port 3426
bun bin/ohmyaihub.ts --data ~/.config/magpie catalog publish on
bun bin/ohmyaihub.ts --data ~/.config/magpie catalog discover on
bun bin/ohmyaihub.ts --data ~/.config/magpie catalog peers
bun bin/ohmyaihub.ts --data ~/.config/magpie connect
bun bin/ohmyaihub.ts --data ~/.config/magpie connect --node <node-id> \
  --trust --fingerprint <64-hex> --quote <64-hex> --request-out "$HOME/request.json"
```

- It is **not** a gateway and **not** the management API: one `GET /catalog/v1`, bound to the
  provider's LAN address, no write path, no AI request, no key. Its port is added to the Forward
  ACL only while published; Inbound stays Drop, so the virtual-IP/loopback path cannot reach it.
- It is one document in `catalog-identity.json` signed with a persisted Ed25519 key. First sight is
  **unverified (TOFU)**; a changed fingerprint is `identity-changed` and is never accepted silently.
  The signature is not a real-world identity.
- A quote never issues a key, charges, deposits or changes a Magpie provider. The guided `connect`
  shows the full TOFU fingerprint and quote hash, requires an explicit `--trust --fingerprint …
  --quote …` acceptance, and writes a structured request with `--request-out`. The provider approves
  it with `share approve <request.json> --cap <usd> --yes` and hands the key over with `share handover`
  (a 0600 file); the consumer then uses `connect --key-file` or `remote add --key-file`. The legacy
  `catalog request`/`catalog connect --key` path fails closed until the same acceptance is supplied.
- The discovery client uses EasyTier's own SOCKS5 listener (`socks5_proxy = socks5://127.0.0.1:…`),
  so a catalogue read creates no port forward and no listener EasyTier 2.6.4 cannot remove. The
  listener is loopback-only and off unless discovery is enabled. Discovery probes the configured
  base port and the next four only; the default **3426** is the interoperable choice.

### Consuming

Hand the provider's `mappedCidr` and the Gateway Key over out of band. The provider writes the key
with `share handover`; the consumer reads it from that 0600 file:

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie remote add peer-b \
  --cidr 10.66.12.34/32 --key-file "$HOME/peer-b.key" --port 3425 [--local-port 13425]

bun bin/ohmyaihub.ts --data ~/.config/magpie remote list
bun bin/ohmyaihub.ts --data ~/.config/magpie remote test peer-b
bun bin/ohmyaihub.ts --data ~/.config/magpie remote models peer-b
bun bin/ohmyaihub.ts --data ~/.config/magpie remote update-key peer-b --key-file "$HOME/peer-b-new.key"
bun bin/ohmyaihub.ts --data ~/.config/magpie remote remove peer-b
```

`remote add` adds a `127.0.0.1:<port>` → `<mappedCidr>:<provider port>` forward through EasyTier,
registers the provider as a native **Remote Magpie**, and refuses to finish unless the ingress
answers 401 without a key **and** with a wrong key, and the valid key lists at least one model.
Each provider gets its own loopback port and its own key; adding the same id again is idempotent.
A failure restores the previous registration of that id and leaves the other providers alone.
`remote test`/`remote models` are read-only and touch only the named provider; `remote recover`
re-runs reconcile. The low-level `provider add --key`/`secret` path remains for compatibility but
puts the key in shell history; prefer the file-based path.

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

## Consumers, manual top-up and the testnet wallet

```sh
# one provider-owned key per consumer: model whitelist + positive cost cap
bun bin/ohmyaihub.ts --data ~/.config/magpie consumers add alice deepseek/deepseek-flash 1
# the key to hand to the consumer: a new 0600 file, never stdout
bun bin/ohmyaihub.ts --data ~/.config/magpie share handover alice --key-file "$HOME/alice.key"
# add credit: recomputes cap = native used + ledger balance, keeps the window
bun bin/ohmyaihub.ts --data ~/.config/magpie topup alice 1 --deposit-id mock-2026-10-30-1
# fail-closed recovery after a price change or window boundary
bun bin/ohmyaihub.ts --data ~/.config/magpie consumers reissue alice --accept-price-version <sha256>
# stop a consumer
bun bin/ohmyaihub.ts --data ~/.config/magpie revoke alice
```

What the plugin enforces on every key (the architecture's non-negotiables):

- only native, allowed models (above), one operation per consumer at a time, and a deposit id that
  makes a replayed top-up a no-op,
- a cap recorded as pending before Magpie is written, so a crash between the write and the local
  commit is reconciled from what the gateway actually holds,
- phase 6: an immutable SQLite ledger (`oh-my-aihub/ledger.sqlite`, integer nano-USD) is the
  balance of record; a top-up is `native used + ledger balance`, never `old cap + amount`; a price
  mismatch, window boundary or native/ledger drift pauses the key and `consumers reissue` carries
  only the ledger balance (same secret for a plugin-owned key);
- the accounting check runs every 10 s by itself (`bun bin/ohmyaihub.ts accounting`), so an external
  price edit or a window boundary is acted on without anyone opening the page. It is a poll, not a
  price lock; a check that cannot verify the books withdraws the overlay publication;
- a pause records the level it really reached (`keyRevoked`, `secretRotated`, `capRestricted`,
  `networkWithdrawn`, `safetyUncertain`); only the first two are called enforced. A `$0.0001` cap is
  not a stop — measured, it still admits calls;
- usage identity is the `usage.jsonl` line position, so two identical calls are two charges and a
  re-read is none. A truncated or replaced log is a `log-gap`: the consumer is paused and the export
  stays down;
- a row that settles after a rotation is charged at that window's frozen price, reopens a window that
  had been called settled, and tightens the live key's cap or pauses it;
- an unreadable `GET /v1/magpie/limit` is a **failed** accounting check (it counts against the
  failure budget and withdraws the export at the threshold), never a healthy one;
- a usage-log gap is stored in SQLite and blocks `consumers reissue` — across a restart, and even if
  the log comes back — until an operator records an audited resolution
  (`consumers resolve-gap <id> --log-id <id> --by <who> --note <text>`); it never reconstructs or
  compensates the missing charges;
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

### Testnet chain credit

The manual `topup` above is simulated. The optional chain wallet is a separate, **testnet-only**
path: a provider publishes one receiving address per chain, a consumer signs an EIP-712 deposit
intent with their own wallet, sends mock test tokens, and the plugin credits the ledger only after
that chain's own finality condition and only when exactly one signed intent matches the transfer.

The wizard runs on the **provider's** node, never on the consumer's:

1. P creates the typed data (`wallet wizard --batch … --no-watch`) and sends it to C. One pending
   request per consumer is the safe default; cancel it or complete it before creating another, or
   use `--force` only when the chain/amount differ and you accept the ambiguity warning.
2. C signs externally and returns a file with `signature` and `payerAddress`.
3. P resumes with `wallet wizard --batch --consumer … --invoice … --signature-file … --payer …`, then sends
   the exact transfer instructions to C; C sends the transfer from their wallet.
4. P observes `wallet status`/`wallet scan`/`wallet credit` and may send C an unsigned
   `wallet statement` (a digest is not proof of payment).

C does not run P's wizard and does not access P's loopback API. The explicit commands below remain
the two-chain reference path.

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet networks
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet assets
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet wizard --batch \
  --consumer alice --provider provider-p --chain 97 --asset <assetId> --amount 1 --no-watch
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet wizard --batch --consumer alice --invoice <id> \
  --signature-file "$HOME/alice-signature.json" --payer 0x<payer>
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet status
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet statement alice --out "$HOME/alice-statement.json"
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet receiving provider-a 97 0x…
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet intent provider-a alice 97 eip155:97:0x… 2500000
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet sign <invoiceId> 0x… 0x…
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet events --chain 97
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet anomalies
```

- Only testnet 97 (BSC) and 84532 (Base Sepolia) are enabled; mainnet 56/8453 exist only as
  always-disabled reserved records and are refused on three separate paths.
- No private key or mnemonic is stored. The provider's receiving address is one they already own;
  the consumer signs with their own wallet. There is no HD wallet and no per-consumer address.
- A test token must be registered only after the chain answers `decimals()`. A symbol that pretends
  to be a real token is refused; no contract address ships in this repository.
- Base Sepolia waits for the real `finalized` tag (measured ~17–24 minutes); BSC testnet uses 15
  confirmations as a stated substitute because its `finalized` tag equals `latest`.
- An unsigned payer, an exchange withdrawal, a contract payer or two identical intents stay
  `unclaimed`/`uncertain` and are **never** credited automatically.
- The statement is unsigned: its digest proves only that the file was not edited by hand, not that a
  payment happened. `wallet statement --out` treats a `.json` path as an exact exclusive 0600 file;
  any other path is a directory (the parent must exist). The wizard never signs, sends or retries a
  transfer for you.
- If a cap write fails after the deposit was booked, keep the same deposit and retry `wallet scan` /
  `wallet credit`; do not create a second deposit. A reorg freezes the consumer and keeps the
  deposit for audit. Historical `failed` rows do not automatically turn back into credits; they
  need a manual audit.
- This is not a buy, swap, bridge, fiat or mainnet path, and real funds remain **NO-GO**.

See [onboarding](../docs/ONBOARDING.md#6-advanced-testnet-credit-two-chains) for the full two-chain
walkthrough and [operations](../docs/OPERATIONS.md#2-balance-anomalies) for anomaly recovery.

## Status

```sh
bun bin/ohmyaihub.ts --data ~/.config/magpie status     # JSON summary
bun bin/ohmyaihub.ts --data ~/.config/magpie checks     # PASS/FAIL, exits 1 on failure
bun bin/ohmyaihub.ts --data ~/.config/magpie remote list       # one line per remote provider
bun bin/ohmyaihub.ts --data ~/.config/magpie remote recover    # targeted/all reconcile
bun bin/ohmyaihub.ts --data ~/.config/magpie setup --check     # read-only preflight
bun bin/ohmyaihub.ts --data ~/.config/magpie accounting # periodic accounting state
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet     # testnet registry, health, totals
bun bin/ohmyaihub.ts --data ~/.config/magpie wallet networks
bun bin/ohmyaihub.ts --data ~/.config/magpie stop|start # supervisor only
```

The host API listens on `127.0.0.1:<port>` (port file `<data>/oh-my-aihub/api-port`). Every route
except `GET /health` requires `Authorization: Bearer <token>` (`<data>/oh-my-aihub/api-token`, mode
0600), and a non-loopback `Host` is refused. The status still exposes operator data to the token
holder, so do not port-forward, proxy or expose the API, and do not share the plugin page capability
URL or screenshots.

Checks include: the core is running; the **effective** ACL (read back from the running core, not
just the file) has Inbound Drop with no rules, Forward Drop with exactly the published ports, and
only loopback forwards; the gateway answers 401 without a key from the provider's own address; the
mapped prefix is announced; the published ports contain the gateway; every issued key names only
native, allowed models (and sharing is withdrawn, with `sharing-suspended`, if that cannot be
proven); each remote provider has a loopback forward, a Remote Magpie entry the plugin owns and a
healthy status; and no loopback listener is left without a provider.

The plugin page cannot fetch any of this: Magpie serves plugin pages with `connect-src 'none'`.
The host writes an allowlisted `page/status.js` (no payer addresses, keys or secrets) and the page
reloads to show it. This is a Magpie limitation, not a choice (see `docs/ARCHITECTURE.md`).

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
| `consumers.json` | provider-owned consumer keys: whitelist, cap, deposits, pending intent, pause |
| `ledger.sqlite` | immutable prepaid ledger: deposits, windows, settled usage snapshots, events |
| `networks.json` | testnet registry: enabled chains, RPC endpoints, registered test assets and rates |
| `chain.sqlite` | deposit intents, observed transfer events, scan cursors, receiving addresses, anomalies |
| `catalog-identity.json`, `catalog-publish.json`, `catalog-trust.json` | the Ed25519 catalogue identity, the signed publication state and the TOFU trust records |
| `applied-options.json` | the page-options digest the host last applied/observed, so a stale page save cannot silently revert the CLI |
| `easytier/`, `easytier-state.json` | the verified binaries, the generated `current.toml` and the supervisor's pid state |
| `api-token`, `api-port` | loopback API credentials |
| `host.lock` | the single owner of this data directory |
| `plugin.log` | redacted log |

Writes are atomic (temporary file + fsync + rename + directory fsync), the previous document is kept
as `.prev`, and a `state.json` that cannot be parsed is recovered from it. A migration to the
current schema writes `state.json.bak-<timestamp>` first. The key store is separate so a status
view, a log line or a page snapshot never has to touch a secret.

**Backup warning.** This directory contains Gateway Keys, the network secret, the ledger and the
chain store. A backup is a secret. Stop Magpie completely before copying it, and include Magpie's
own `caller-keys.json`, `providers.json`, `settings.json` and `usage.jsonl`; copying only
`oh-my-aihub/` can restore a ledger that no longer matches Magpie. See
[operations](../docs/OPERATIONS.md#5-backup-and-restore).

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
src/wallet.ts           testnet registry, receiving addresses, intents, watchers, status
src/watcher.ts          one chain watcher: scan, attribute, finality, credit
src/chainstore.ts       SQLite deposit events, intents, cursors, receiving addresses, anomalies
src/deposits.ts         EIP-712 deposit intent and signature verification
src/networks.ts         equal testnet registry, assets, finality policies, mainnet refusal
src/evm.ts              chain-id verification, blocks, logs, receipts, decimals()
src/keccak.ts, secp256k1.ts, eip712.ts  signature primitives (no wallet dependency)
src/server.ts           loopback HTTP API
src/acl.ts              strict verifier of the generated and the running configuration
src/lock.ts             one host per data directory, stale takeover
src/run.ts              process runner without a shell
src/log.ts              redacting log + page snapshot writer
page/                   the plugin page (read-only status snapshot + settings form)
bin/ohmyaihub.ts        operator CLI
test/                   bun tests (state, ACL, keys, providers, catalog, ledger, wallet, chain)
docs/validation/lab/phase4/  historical three-instance end-to-end lab
../docs/ONBOARDING.md    the first-use/provider/consumer/testnet-wallet journey
../docs/OPERATIONS.md    the daily loop, anomalies, exit and backup/restore
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
- Plugin pages cannot fetch, so status is a generated snapshot rather than a live read, and only
  the official setup options can be written from the page. The loopback API/CLI is the operator
  interface for sharing, keys, providers and the wallet.
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
  recomputes past charges, and the running admission sums may stay at the old price until restart.
  Do not change prices while credit is outstanding. The plugin's ledger preserves the USD balance
  and pauses after detection, but this is **not a real-time price lock**; real funds remain blocked
  (see `docs/validation/2026-10-30-phase6-pricing-window.md`).
- Linux EasyTier is tested, and the official Linux Magpie 0.1.2057 **consumer** container is
  tested. Linux Magpie **GUI/provider** behaviour is untested; Windows is untested. The phase-4 lab
  ran on macOS with three isolated Magpie instances, not three physical machines.
- Magpie 0.1.2120/0.1.2171 are page/browser evidence only (0.1.2171 via isolated `magpie web`;
  desktop WKWebView unmeasured). The host/CLI and billing pin stay at 0.1.2038; a new Magpie may
  change a command, price or limit semantic and must be re-measured first.
- The chain wallet is testnet-only. Base Sepolia finality takes ~17–24 minutes; an unsigned payer,
  an exchange withdrawal, an ambiguous amount or a duplicate intent is `unclaimed`/`uncertain` and
  is never credited automatically. There is no HD wallet or per-consumer address.
- There is no supported backup/restore command in this release. Use the stopped-host procedure in
  [operations](../docs/OPERATIONS.md#5-backup-and-restore); a live copy of `ledger.sqlite` or
  `chain.sqlite` can be inconsistent.
- The page cannot fetch and cannot perform state changes except the official setup options. Saving
  them restarts the shared plugin host; the overlay and loopback API are briefly gone. The CLI is
  the operator interface for the daily loop.
