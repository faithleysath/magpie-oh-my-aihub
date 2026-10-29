# Architecture decision record — updated 2026-10-30 (phase 5)

Phase 5 adds opt-in peer discovery and a read-only quote catalogue, and does not add a wallet, a
central directory or an automatic key issuer. Phase 4 turned the two mutually exclusive roles into
two independent capabilities on one node (share my Magpie, consume other Magpies) and replaced the
single consumer wiring with a set of remote providers. Everything measured in phase 3 still holds;
the phase-4 decisions are 5–12 and the phase-5 decisions are 13–17. Evidence is in
[`validation/2026-10-29-phase4-multi-role-multi-provider.md`](validation/2026-10-29-phase4-multi-role-multi-provider.md)
and [`validation/2026-10-30-phase5-peer-catalog.md`](validation/2026-10-30-phase5-peer-catalog.md).

Supersedes the 2026-10-29 draft. Every claim below is backed by a measured result in
[`validation/2026-10-29-local-lab.md`](validation/2026-10-29-local-lab.md) or
[`validation/2026-10-29-acl-fix-and-two-host.md`](validation/2026-10-29-acl-fix-and-two-host.md);
source references are in those notes. UNCERTAINTIES.md's open questions are answered or listed
as UNKNOWN there.

## Goal

Private peer-to-peer AI API sharing using **Magpie**, **EasyTier no-TUN** and prepaid consumer
credit. Provider wallets and balances stay independent; there is no central account system and no
central business server. Consumers register a provider as a native Remote Magpie and use Magpie's
own model lists and routing groups.

## Decision 1 — Magpie is the only AI data path and the only charging point

- Admission, per-model scoping, per-request cost/token enforcement, stream forwarding, usage
  accounting and 429 responses are **Magpie's** (`internal/gateway`, `internal/budget`).
- The plugin never proxies an AI request, never counts tokens, never meters a call, never freezes a
  per-request balance and never writes a second usage ledger.
- The Phase 0 standalone HTTP admission/pricing proxy is **superseded** and must not be carried
  forward (`prototype/phase0/` stays as a historical reference only).
- A minimal network adapter (local relay, header-injecting proxy, provider-side TUN) is **not
  needed**: the corrected no-TUN ingress below is authenticated end to end.

## Decision 2 — Ingress: provider-owned address, never the virtual IP

A consumer reaches a provider's gateway only through EasyTier's **subnet-proxy (Forward)** path,
addressed to a per-provider overlay address:

| Piece | Value |
| --- | --- |
| Provider `proxy_network` | `cidr = <provider LAN IP>/32`, `mapped_cidr = 10.66.<a>.<b>/32` |
| Consumer `port-forward` | `tcp 127.0.0.1:<local> -> 10.66.<a>.<b>:3425` |
| Magpie `Remote Magpie` | `url = http://127.0.0.1:<local>` with the consumer's Gateway Key |

Why: a no-TUN flow addressed to the provider's **virtual IP** is rewritten to `127.0.0.1:<port>`
(EasyTier `wrapped_tcp_proxy.rs:81-86`), where Magpie treats the caller as local and skips both the
key and the budget. The Forward path arrives from the provider's own **non-loopback** address, so
Magpie sees a remote caller and enforces the key. Measured 401 / 401 / for no key / wrong key, 200
for a valid key, 429 when spent, from two remote hosts and a LAN peer.

## Decision 3 — ACL invariants (non-negotiable)

Every EasyTier node the plugin starts gets:

- **Inbound chain: `default_action = Drop`, no rules at all.** No rule may ever allow a Magpie port
  (or any other loopback service) on the Inbound chain. `tcp_whitelist` must **not** be used: it
  compiles to Inbound allow rules (`easytier-core/src/config/peers.rs:75-121`) and reopens the
  bypass. Omitting the Inbound chain is worse still: with no chain EasyTier's inbound default is
  Allow (`peers/acl/processor.rs:274-285`).
- **Forward chain: `default_action = Drop`,** one allow rule per published port only (default:
  `tcp/3425`). This is what restricts a provider's exported address to the gateway.
- **RPC portal pinned to loopback** with `-r 127.0.0.1:<port>`. The TOML key `rpc_portal` is ignored
  by 2.6.4 and the default binds `0.0.0.0:15888`.
- **Unique `mapped_cidr` per provider** (persisted random, `10.66.x.y/32`, never 0/255 octets).
  Without mapping, two providers exporting the same LAN subnet produce two identical routes and the
  consumer cannot choose one.
- Export **`/32` of the provider's own address** by default, not a whole `/24`. A `/24` is an
  explicit option for a provider whose LAN address changes inside its subnet.
- **No TUN, no system routes, no global firewall changes.** The plugin only writes its own TOML,
  spawns `easytier-core`, and talks to its loopback RPC.

Runtime ACL changes are **not available** in EasyTier 2.6.4 (`easytier-cli acl set` exists only in
newer source). Any ACL / port / proxy-network change therefore rewrites the config and performs a
**supervised restart** (graceful stop, start, re-verify), never a hot edit.

## Decision 4 — Gateway Key is the consumer's account

One provider-owned Gateway Key per consumer, always **held**:

- a non-empty model whitelist (`gateway-key models <id> <provider>/<model> …`),
- a positive cost cap on a window (`gateway-key limit <id> day --cost <USD>`), never zero,
- caps are written on Magpie's **$0.0001 grid**; a smaller value silently becomes *unlimited*.

Top-up = raise the same key's cumulative cost cap (`limit <id> day --cost <newTotal>`), which keeps
the used cost and takes effect immediately. Never `reset` for a top-up (it erases usage). Revocation
is `gateway-key remove <id>` (or `rotate` to invalidate the secret while keeping the key).

`GET /v1/magpie/limit` with the consumer key (loopback, managed key) is the authoritative read-back
for the key's own numbers; every write is verified by reading it back.

Semantics the product must accept (measured):

- The cap is a **soft ceiling**: one call, or one concurrent burst, can overshoot it. Overshoot is
  bounded by in-flight reservations and by output length versus the reservation, not by one call.
- A refused call is a native **429** with `Retry-After` and `X-Magpie-Limit-Reset`; the plugin adds
  no refusal of its own.
- Cost is Magpie's estimate at its **current** prices, recomputed over history. The MVP therefore
  **must not change the price of a shared model while prepaid credit is outstanding**; a price
  change can move a consumer over budget retroactively. Whether Magpie can pin a price is an
  **open blocker** (see below), not something a ledger snapshot may paper over.
- An interrupted request (Magpie restart, crash) is **lost from both sides' accounting**; the
  vendor still bills it. Reconciliation must treat unfinished calls as unbillable and never invent
  a charge.
- Usage recorded while a key had no cap counts as soon as a cap exists.

## Decision 5 — Roles: two independent capabilities, one core

A node has `sharingEnabled` and `consumingEnabled`; both may be on. The phase-3 `role`
(`provider`/`consumer`) is kept only as a migration input and CLI shorthand.

- **Sharing** publishes this node's Magpie on the overlay: one `proxy_network` export (the node's
  own LAN address `/32`, mapped to a per-node `10.66.a.b/32`) and a Forward chain that allows
  exactly the published gateway ports. Turning sharing off withdraws the export and the Forward
  chain and touches no Magpie provider, model or Gateway Key.
- **Consuming** is a set of remote providers, each with its own loopback forward, Remote Magpie
  registration, Gateway Key and status. Turning consuming off unregisters only the Remote Magpie
  entries this plugin created; a provider the operator added by hand is never touched.
- **One EasyTier core, one identity.** The export/ACL and the consumer forwards are written into
  the same generated TOML. A second core on the same machine would fight over the network name,
  the `instance_id` and the listener ports, so it is not an option.

- **Magpie**: providers, models, Remote Magpie, routing groups, Gateway Keys, limits, usage, 429s.
- **EasyTier**: private encrypted overlay, no-TUN, subnet proxy, port forwards, ACLs.
- **Plugin** (`plugin/`): one EasyTier supervisor (download/pin/verify, config, lifecycle, peers,
  forwards, restart), the Gateway Key provisioner, the remote-provider registry, simulated
  deposits, status, and later the wallet, chain watcher and reconciliation.
- **Relay host** (e.g. an HK VPS): only `easytier-core`. No business service runs there.

## Decision 6 — Product rules

- No usable Gateway Key without credit.
- Never create a shared key without a model whitelist, never an unlimited key, never treat a cap of
  0 as "out of money" (0 means no cap), never write a cap below `$0.0001`, never `reset` to top up.
- A top-up that does not lift the cap above what is already spent leaves the key refused (measured).
- Mock top-ups only in an isolated environment; no public endpoint may change a real key's cap.
- Wallet identity binds to the EasyTier **peer public key** (or a signed statement), never to a
  virtual IP or a LAN address: peer IDs change on restart and addresses move.
- No DHT, no mDNS, no new routing algorithm, no central intermediary API, no second AI gateway.
- The Magpie administrative interface (`magpie web`'s page and `/api/*`) is never exposed to anyone,
  overlay members included.

## Decision 7 — the plugin's control surface is the CLI plus read-back

Magpie 0.1.2038 has **no public management API**. Key writes go through
`magpie gateway-key add|models|limit|quotas|remove|rotate`, which is the product's own path
(`internal/access.Update`: lock, atomic `caller-keys.json`); reads of a key's numbers go
through `GET /v1/magpie/limit` with that key. The window's admin API
(`POST /api/caller-keys/…`) exists only inside the app's webview or behind `magpie web`'s
cookie, and the in-tree `pluginrt` gateway service is closed to community plugins
(`TestPluginsImportOnlyCore`). The admin interface is never exposed to anyone.

The CLI is stable as a write path but not as an interface: no `--json` for `gateway-key`, and
its syntax has changed across releases. Therefore the plugin (a) parses only the `sk-…` secret
line from `add`, (b) treats `caller-keys.json` and `/v1/magpie/limit` as the source of truth,
(c) verifies every write by reading it back, (d) serializes and time-limits every CLI call,
and (e) never calls `magpie --version` at boot (macOS reads the bundle's `Info.plist`; other
platforms get one cached 3 s call when a status is requested). A `--json` output, or a
token-gated loopback management endpoint, is the smallest upstream change that would remove
the last text dependency; it is proposed upstream, not required.

## Decision 8 — A remote provider is a record, not a global "wiring"

Each consumed provider is one `ProviderConnection`:

| Field | Meaning |
| --- | --- |
| `id` | local key of the record; also the CLI/API handle |
| `remoteMagpieId` | the Remote Magpie provider id inside this node's Magpie (equal to `id` in this phase) |
| `mappedCidr` + `providerPort` | the overlay address and the **real published port** the provider listens on |
| `localPort` | the loopback port this node's EasyTier forwards; one per provider |
| `keyRef` | `provider-keys.json#<id>` — the Gateway Key lives in a separate 0600 store, never in `state.json` |
| `fingerprint` | overlay identity observed at connect time: hostname, virtual IPv4, session `peer_id` |
| `status` / `detail` | `connected`, `degraded`, `identity-mismatch`, `disabled` |
| `createdAt` / `updatedAt` / `lastConnectedAt` | timestamps |

Ownership is part of the record, not a separate permission system: the plugin may replace or
remove a Magpie provider only when a `ProviderConnection` exists **and** the entry is a Remote
Magpie whose `chat` is exactly `http://127.0.0.1:<localPort>/v1` **and** whose key equals the key in
the key store. Everything else — a same-named native provider, a different Remote Magpie, or an
entry the operator edited by hand — is `foreign` and is refused, reported, and left untouched by
connect, update, delete, consumption-off and restart recovery.

Rules the service enforces:

- adding the same `id` again is idempotent (same record, one registration, one forward);
- a mapped prefix may belong to exactly one local provider, and to exactly one overlay peer at
  connect time (two peers announcing it are refused);
- each provider has its own key: a key is never reused for another provider, and swapping keys is
  refused by the remote gateway's own 401;
- a failed connect rolls back exactly what that call added (its registration, its forward) and
  keeps every other provider; the previous registration of the same id is restored with its key;
- removing or updating one provider restarts the core only to drop a forward 2.6.4 cannot drop at
  runtime, then re-verifies the remaining providers (measured: they recover);
- every remote provider's health is checked separately, so one provider being down degrades only
  itself.

## Decision 9 — Identity: the mapped address is a selector, not an identity

`mappedCidr` can collide, move, or be announced by someone else, so it is never treated as the
provider's identity. What 2.6.4 actually exposes and what the plugin does with it:

| Signal | Readable in 2.6.4? | Use |
| --- | --- | --- |
| `proxy_cidrs` per route | yes (`easytier-cli -o json route`) | routing selector; must have a single owner at connect time |
| hostname + virtual IPv4 | yes (`route`, `peer list`) | recorded fingerprint; a different hostname on the same prefix is `identity-mismatch` and the provider is unregistered until it comes back |
| numeric `peer_id` | yes (`peer list`) | recorded; **changes on every EasyTier start**, so it cannot identify a node across restarts |
| `instance_id` | own node only (`node`) | persisted in this node's TOML; not readable for a peer through the CLI |
| `RoutePeerInfo.noise_static_pubkey` (X25519) | **no** — present in the RPC protobuf (`peer_rpc.proto:46`) but the CLI's route/peer JSON does not print it | UNKNOWN / upstream gap; a stable cryptographic peer identity cannot be read in 2.6.4 |
| Gateway Key enforcement | yes | the actual guard: no key or a wrong key must be 401, and the valid key must list models |

The connect path therefore proves, in order: one overlay owner for the prefix, the endpoint
refuses no key **and a wrong key**, the valid key lists at least one model, and Magpie lists the
provider's models. The hostname check is a drift alarm, not authentication: a different peer that
hijacks the prefix still cannot answer with our Gateway Key. Binding a wallet to a peer will need
the public key exposed upstream (or a signed statement), which is why the wallet phase stays out.

## Decision 10 — Share native models only (no resale, no A→B→A)

A Gateway Key issued by this node may name only models of this node's **own** providers:

- the provider segment of each whitelist entry must be a native Magpie provider
  (`providers.json` entry without `preset = "remote-magpie"`);
- an entry naming a Remote Magpie is refused with an explicit error;
- `group/…` and `auto/…` entries are refused for shared keys, because a native Magpie group may
  contain models imported from another peer;
- the operator's `share.models` allow list (globs, default `*`) bounds every key;
- issued keys are re-checked whenever a provider is added/removed and at every handover: a key
  whose models stopped being native is narrowed, and revoked if nothing shareable remains.

Consequence for loops: with A↔B sharing, A lists `peer-b/...` and B lists `peer-a/...`, but a key
A gives B can never name `peer-b/...`, so B cannot route a request back to A through a shared key.
Measured with one upstream hit per cross-node request and no `/v1/models` model from the other
side in any whitelist.

Enforcement is continuous but **polled**: the guard runs at start, after every reconcile (45 s and
manual) and on a 15 s tick that compares a native/remote fingerprint, and it compares Magpie's own key store (an
empty model list means "every model") with the operator's shareable set. A key that was widened by
hand is narrowed; a key with nothing shareable left is revoked. When `providers.json` cannot be
read the guard does **not** revoke on a transient error, but it does not treat "unknown" as safe:
sharing is suspended (the export and Forward chain are withdrawn, `state.shareSuspended`) and
republished automatically once the check passes again. The protection window is therefore bounded
by the poll interval, not zero: a request already in flight or made inside that window could
still use a channel whose provider id was just replaced. Two different changes have two different
deadlines: a provider **id/type** change is seen by the 15 s fingerprint, while a direct edit of a
Gateway Key's **model whitelist** is seen by the full guard on the ~45 s reconcile pass (or at the
next hand-over). Absolute real-time prevention would need Magpie to make a key's provider set
immutable or a request-path intermediary; **LIMITATION**, see
[`validation/2026-10-29-pr5-review-fixes.md`](validation/2026-10-29-pr5-review-fixes.md).

## Decision 11 — State: versioned, atomic, backed up, with the keys elsewhere

`state.json` (0600) is versioned (`version: 2`) and migrated from phase 3 exactly once:

- a backup `state.json.bak-<timestamp>` is written before the first v2 write;
- `providerWiring` becomes the first provider record; its key moves to `provider-keys.json`
  (0600) and the record keeps only `keyRef`;
- `role` becomes `sharingEnabled`/`consumingEnabled`; `mappedCidr`, `proxyCidr`, the virtual IP,
  the RPC port and the Secure Mode identity are preserved (a re-enabled share keeps the address
  consumers already know);
- writes go to a temporary file, are fsynced, renamed over the target and the directory is
  fsynced; the previous document is kept as `.prev`, and an unreadable `state.json` is recovered
  from it;
- a provider's forward set is written into the generated TOML, so an EasyTier restart restores
  every listener without a second source of truth;
- no database service is introduced: the document is small, local and single-writer (the host
  lock), and SQLite would add a dependency without removing the need for the backup/rename.

## Decision 12 — EasyTier 2.6.4 cannot remove a port forward at runtime

Measured (`port-forward remove` prints success, the rule and listener stay) and explained by the
source: the CLI sends a `PortForwardPatch` with only `bind_addr` and no `dst_addr`
(`easytier/src/easytier-cli.rs:1957-1962`), while the patcher removes by whole-struct equality
(`easytier/src/proto/api.rs:53-75`), so the default `0.0.0.0:0` never matches. The plugin
therefore:

- writes `[[port_forward]]` into the generated TOML (supported: `config.rs:551,1486`);
- adds a forward live (idempotently — a duplicate rule really does create a second listener);
- removes one by a supervised restart with the new config, after which the remaining providers are
  re-verified;
- records a listener it could not close as an orphan, reports it in `checks`, and clears it on the
  next core start;
- **retargets a provider** (new `mappedCidr` or `providerPort`) on a fresh loopback port, proves it,
  replaces the registration, then restarts once so the old listener is gone. A failed retarget
  restores the old registration and keeps the old forward; an explicit request to reuse the same
  port for a new target is refused.

## Decision 13 — Discovery is EasyTier's own peer and route data

The directory is rebuilt from `easytier-cli -o json peer list` and `route` on a
10 s supervisor refresh plus a 15 s service tick (the catalogue refresh itself
is at most every `refreshSec`, default 20 s). No DHT, mDNS, broadcast,
central directory or new routing algorithm is introduced.

- A peer row carries `hostname`, `ipv4`, `id` (session peer id), `cost`
  (`Local`/`p2p`/`relay(N)`), `lat_ms`, `loss_rate`, `tunnel_proto`, `nat_type`.
- A route row carries the peer's virtual IPv4, `proxy_cidrs` (`real->mapped`)
  and `next_hop_hostname` (`DIRECT` or an intermediate peer). The mapped side is
  the only address a consumer dials.
- The self row (`cost = Local`) and the node's own hostname/virtual IP are
  classified as `self`; a peer whose route owns a `ProviderConnection.mappedCidr`
  is `connected`; the rest are `unknown` until a catalogue is read.
- Duplicate virtual addresses and duplicate mapped prefixes are `conflict` and
  are never probed. A catalogue whose signed `node.mappedCidr` does not match
  the address it was read through is refused.
- An offline peer keeps its last quote in memory for at most one hour, marked
  `offline`; a peer that returns is re-read.
- Hostname, virtual IP, `mapped_cidr` and peer id are routing hints, **not**
  cryptographic identities. `peer_id` changes on every EasyTier start.

The default catalogue port is 3426. A host may publish on another port; discovery
probes the configured base and the next four ports only until one answers, then
remembers the port. This is a bounded compatibility range, not a port sweep.

## Decision 14 — The catalogue is one read-only GET over SOCKS5

The catalogue is a separate, thin HTTP server in the plugin host, bound to the
provider's **LAN address** (not `0.0.0.0`, not loopback), one path
`GET /catalog/v1`, one signed JSON body. It is never an AI gateway, never proxies
a chat/responses/messages request and has no write path. Its only data source is
a cached quote built from Magpie's native models and explicit settings.

The consumer reads it through EasyTier 2.6.4's own SOCKS5 portal, configured as
`socks5_proxy = "socks5://127.0.0.1:<port>"` in the generated TOML. The source
binds `proxy_url.host_str()` (`gateway/socks5.rs:661-670`), unlike `--socks5`,
which hardcodes `0.0.0.0` (`launcher.rs:666-670`). The plugin's client dials only
the peer's mapped IPv4 address, never a DNS name, caps the response at 64 KiB and
uses a 5 s timeout. The SOCKS5 listener is loopback-only and is verified as such
at runtime (the same lsof/ss check as the RPC portal).

Why not a port forward per read: EasyTier 2.6.4 `port-forward remove` prints
success and keeps the listener (Decision 12), so a per-read forward would leak an
undelatable port. SOCKS5 creates no forward and no listener of its own; one
persistent loopback listener serves every on-demand read. A local process on the
consumer could use that listener to reach the private overlay; it is off unless
discovery is enabled, bound to loopback, and its port is stored in a 0600 config.
This is a local-trust boundary, not a network-exposed service.

Publication rules:

- The user must explicitly enable publishing; a phase-4 state migrates with both
  catalogue switches off.
- The catalogue port is appended to the Forward ACL's published ports only while
  the catalogue is published; turning publication off stops the server and
  rewrites the TOML without that port (supervised restart).
- Inbound stays `Drop` with zero rules. A request addressed to the provider's
  virtual IP on the catalogue port is dropped (and would hit no listener: the
  server binds the LAN address, not `127.0.0.1`).
- The server caps concurrency (8), request rate (60/min, burst 10), idle time
  (5 s), body size (64 KiB) and model count (200); it accepts only `GET` on its
  one path. `/status`, `/providers`, `/configure` and every other path are 404 or
  405. No CORS header is added.
- Enabling/disabling publication, changing its port, or enabling discovery is a
  config change and a supervised core restart. A quote refresh is not: it only
  re-signs the cached document and never restarts EasyTier or touches a key.

## Decision 15 — Quotes are self-signed; identity is TOFU, never PKI

The provider persists an Ed25519 key in `catalog-identity.json` (0600). The
quote's bytes (canonical JSON, sorted keys, no whitespace) are signed; the
consumer verifies the signature, recomputes the key fingerprint (`SHA-256` of the
raw 32-byte public key) and stores the first-seen key per signed `node.id` in
`catalog-trust.json` (0600).

- First sight is displayed as **unverified (self-signed, TOFU)**.
- A later quote with the same key is still only "same key as before"; the
  operator can mark it accepted locally (`catalog trust <node-id>`), after which
  the page calls it verified-by-TOFU.
- A different key is never accepted silently: the peer becomes
  `identity-changed`, the pending fingerprint is shown, `catalog request` and
  `catalog connect` refuse, and only a local, authenticated `catalog trust`
  accepts the new key.
- A signature proves only that the same key signed the document. It does not
  prove a real-world identity, and there is no certificate server or PKI.
- A valid signature is **not** sufficient: the document is structurally
  validated field by field (node id, hostname/id binding, virtual IP, mapped CIDR,
  ports, model ids, prices, timestamps, version, sizes and enum values) before
  any value is stored or displayed. Unknown fields and control characters are
  refused.
- Trust is held in a null-prototype map keyed only by the strict node id, so
  `__proto__`, `constructor` and `prototype` cannot reach `Object.prototype`; a
  corrupt or unknown-version trust file fails closed.
- A node that presents another node's `mappedCidr` is refused; a node that
  presents another node's `node.id` with its own key becomes a pending identity
  change, not a silent replacement. The last accepted quote version and content
  hash are stored; an older version or the same version with different content
  is marked stale and cannot replace the newer cached quote.

## Decision 16 — The catalogue is display data; connection stays manual

A quote never creates a key, a balance, a charge or a Magpie provider. The flow
is: discover -> browse -> `catalog request <node>` (a JSON request with the
consumer's node id, the provider's mapped address, models, quote hash and a
**structured** approval block; it deliberately contains no shell command) ->
provider operator approves out of band and runs `consumers add` with a native
model whitelist and a positive cap -> provider runs `secret` -> consumer runs the
existing `provider add`/`catalog connect` with that key. The catalogue itself
has no endpoint that accepts a key, a deposit or a write.

Price display is read from Magpie's own `settings.json` `modelPrices` (and from
the local gateway's `magpie_price` when the gateway answers on loopback), in USD
per 1M tokens, with cache read/write and tiers when present. A model with no
configured price is published as "no published price", never invented. The
minimum top-up is a simulated display field (`simulated: true`); no wallet is
connected. A quote change does not call the provisioner and cannot change a
Gateway Key's cost cap. Real charging still depends on the price-lock work in
Decision 4/known blockers.

The provider page cannot fetch (`connect-src 'none'`); it renders a generated
`status.js` snapshot with the peer directory, quotes, connected providers,
native `/v1/magpie/limit` numbers, identity warnings, errors and timestamps. The
CSP is not relaxed and the host API is not exposed on the LAN.

## Decision 17 — Share-guard detection has two different deadlines

The 15 s provider fingerprint compares only the **ids and types** of Magpie's
providers (native/remote) to detect a replacement, addition or removal. A direct
edit of a Gateway Key's model whitelist does not change that fingerprint; it is
found by the full guard on the reconcile pass (about every 45 s), at start, on
configure, on connect/update/remove, and at every hand-over. The real upper bound
is therefore ~15 s for provider id/type changes and ~45 s for a direct key-store
whitelist edit, not 15 s for both. Catalogue refresh never invokes the guard and
never changes a key.

## Preferred dataflow

```
consumer agent -> consumer Magpie (Remote Magpie provider)
   -> http://127.0.0.1:<forward>            (consumer's EasyTier port forward)
   -> EasyTier overlay (Forward chain)      -> provider's own LAN address:3425
   -> provider Magpie: Gateway Key guard -> budget/limit -> native routing -> upstream
```

Deposits (future): chain -> provider's verified receipt watcher -> idempotent deposit event ->
`cap += credit` on the mapped key -> read back `/v1/magpie/limit` -> consumer balance view.

## Payment invariants (unchanged, future phase)

- Wallet identity signed and bound to the peer public key, not to an IP or a peer ID.
- Base native USDC (8453) is the candidate asset; testnet only during development.
- Credit only a confirmed ERC-20 `Transfer` receipt to the intended provider, from a registered
  sender or an explicit signed invoice.
- Deposit dedupe key: `(chain ID, token contract, tx hash, log index)`.
- Durable intent state machine; an unknown broadcast must be reconciled before any retry; one
  outstanding top-up per counterparty.
- No per-request chain write; the provider's Magpie estimate is the billing basis.
- Store a **price snapshot per charge**; never recompute a settled invoice from current prices.
- Window rollover and price changes need explicit reconciliation, not a blind reset.

## Pinned versions

| Component | Version | Identity |
| --- | --- | --- |
| Magpie | 0.1.2038 (verified) | tag `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| EasyTier | 2.6.4 (verified) | tag `v2.6.4` = `8428a89d2dabc94c97d370ec607c6ca142473626` |

The plugin pins the EasyTier release assets by SHA-256 in `plugin/src/easytier-manifest.ts` and
refuses an unlisted platform or a hash mismatch.

## Known blockers / open questions

1. **Pricing lock:** Magpie has no price pinning for a settled window; changing a model's price
   recomputes past charges. Must be solved before real credit is outstanding (blocker).
2. **Overshoot tolerance** has no closed form (in-flight burst, output length). Prepaid credit needs
   an explicit tolerance or the provider accepts the overrun.
3. **Interrupted calls** are unbilled on both sides.
4. Windows and Linux **Magpie** provider behaviour is untested; Linux EasyTier is verified.
5. `easytier-cli acl set` is absent in 2.6.4 (restart required).
6. The community plugin **page cannot reach the network** (`internal/gui/pluginpage.go`, CSP
   `connect-src 'none'`), so the page is settings-only; live status needs a generated snapshot file
   or a future first-class bridge.
7. **Remote provider identity is not cryptographic in 2.6.4**: the CLI does not expose a peer's
   `noise_static_pubkey`, and `peer_id` changes on every start. The mapped prefix + hostname check +
   Gateway Key is what this phase can prove; binding funds to a peer needs the public key exposed
   upstream (or an operator-signed statement).
8. **Forward removal needs a core restart** (Decision 12), so removing or retargeting one provider
   briefly interrupts the others' in-flight requests; new requests recover as soon as the core is
   back (measured).
9. **The no-resale guard is polled**, not instantaneous; see Decisions 10 and 17. A provider
   id/type change is noticed on the ~15 s tick; a direct edit of a Gateway Key's model whitelist is
   noticed by the full guard on the ~45 s reconcile pass or at a hand-over. Treat absolute
   real-time prevention as UNKNOWN until Magpie offers immutable per-key provider scope.
10. **A provider whose connection record was lost is treated as foreign** and is not overwritten;
    remove it in Magpie before re-adding it with the plugin (deliberate, fail-closed).
11. **Catalogue identity is self-signed TOFU**, not a real-world identity. A malicious overlay
    member can publish its own catalogue or copy another's; the Gateway Key is still what guards
    the AI path, and a changed key is only a warning.
12. **Catalogue discovery needs a reachable mapped address and the published port.** A host with no
    export, a conflicting route, or a catalogue port outside the bounded probe range is shown but
    not read automatically. The range (base … base+4) exists so several lab instances can share a
    LAN address; a real deployment uses 3426.
13. **The consumer's SOCKS5 listener is loopback-only but unauthenticated.** Any local process could
    use it to reach the private overlay while discovery is on. It creates no persistent forward and
    is stopped when discovery is off; local process isolation is out of scope.

## References

- Magpie: https://github.com/yetone/magpie (pin above)
- EasyTier: https://github.com/EasyTier/EasyTier (pin above)
- Validation: [`validation/2026-10-29-local-lab.md`](validation/2026-10-29-local-lab.md),
  [`validation/2026-10-29-acl-fix-and-two-host.md`](validation/2026-10-29-acl-fix-and-two-host.md),
  [`validation/2026-10-30-plugin-phase3.md`](validation/2026-10-30-plugin-phase3.md),
  [`validation/2026-10-29-phase4-multi-role-multi-provider.md`](validation/2026-10-29-phase4-multi-role-multi-provider.md),
  [`validation/2026-10-30-phase5-peer-catalog.md`](validation/2026-10-30-phase5-peer-catalog.md)
- Corrected provider config: [`validation/lab/provider-acl.toml`](validation/lab/provider-acl.toml)
