# Architecture decision record — updated 2026-10-30 (phase 7; phase 8 onboarding note)

Phase 7 adds the **testnet chain wallet**: a registry in which every network is a peer, a per-chain
deposit watcher, signed deposit attribution and one bridge into the existing ledger and provisioner.
It does **not** add a second AI gateway, a second balance, a custodian, a buy/swap/bridge feature or
any mainnet asset. Phase 6 added a local immutable prepaid ledger and fail-closed key reissue for
price changes and window boundaries. Phase 5 added opt-in peer discovery and a read-only quote
catalogue. Phase 4 turned the two mutually exclusive roles into two independent capabilities on one
node (share my Magpie, consume other Magpies) and replaced the single consumer wiring with a set of
remote providers. Everything measured in phase 3 still holds; the phase-4 decisions are 5–12, the
phase-5 decisions are 13–17, the phase-6 decisions are 18–20, the phase-6 review patch's are 21–24,
the final targeted patch's are 25–26, and the phase-7 decisions are 27–33. Evidence is in
[`validation/2026-10-29-phase4-multi-role-multi-provider.md`](validation/2026-10-29-phase4-multi-role-multi-provider.md),
[`validation/2026-10-30-phase5-peer-catalog.md`](validation/2026-10-30-phase5-peer-catalog.md) and
[`validation/2026-10-30-phase6-pricing-window.md`](validation/2026-10-30-phase6-pricing-window.md) and
[`validation/2026-10-30-phase7-multichain-wallet.md`](validation/2026-10-30-phase7-multichain-wallet.md).
The fresh cross-host payment/EasyTier/Remote Magpie acceptance is in
[`validation/2026-10-30-fresh-twohost-wallet.md`](validation/2026-10-30-fresh-twohost-wallet.md); the
original-payment replay into the real ledger and Magpie key is in
[`validation/2026-10-30-live-magpie-chain-credit.md`](validation/2026-10-30-live-magpie-chain-credit.md).
The phase-7 report's earlier “no real-testnet run” section and its older “fresh combined remains
UNKNOWN” sentence are historical; the current scope is the one in those two reports, and real vendor
execution is still UNKNOWN.

Phase 8 does not change this architecture. It documents and validates the first-use and operator
journeys. The page/bridge files were compared with Magpie 0.1.2120, but the host/CLI and the
pricing/billing pin stay at **0.1.2038**; 0.1.2120 host/CLI behaviour is UNKNOWN.

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

Top-up = raise the same key's cumulative cost cap while its window is open; the phase-6 ledger
recomputes the cap as `native used + ledger balance`, never as `old cap + amount` (Decision 18).
Changing the period or cycle restarts the window - it is never a top-up. Never `reset` for a
top-up (it erases usage). Revocation is `gateway-key remove <id>` (or `rotate` to invalidate the
secret while keeping the key).

`GET /v1/magpie/limit` with the consumer key (loopback, managed key) is the authoritative read-back
for the key's own numbers; every write is verified by reading it back.

Semantics the product must accept (measured):

- The cap is a **soft ceiling**: one call, or one concurrent burst, can overshoot it. Overshoot is
  bounded by in-flight reservations and by output length versus the reservation, not by one call.
- A refused call is a native **429** with `Retry-After` and `X-Magpie-Limit-Reset`; the plugin adds
  no refusal of its own.
- Cost is Magpie's estimate at its **current** prices, recomputed over history. Measured in phase 6:
  `/v1/magpie/limit` reprices old calls immediately, while the running admission sums stay at the
  price they were first read at until a restart/new window/key change. A price change can therefore
  both deny credit that is still there and admit calls the read endpoint already calls spent. There
  is no native price pin or per-key price. The plugin's ledger preserves the USD balance and fails
  closed after detection, but it **cannot prevent** a call in the detection gap from being repriced;
  see Decision 20 and the phase-6 note. Real funds remain blocked until this is solved upstream or
  by a request-path guard.
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
  forwards, restart), the Gateway Key provisioner, the remote-provider registry, manual simulated
  top-ups, the testnet chain wallet (registry, per-chain watcher, EIP-712 attribution and the
  ledger bridge), status and the read-only page snapshot.
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
hijacks the prefix still cannot answer with our Gateway Key. Phase 7's testnet wallet binds a
deposit to the payer's EIP-712 signature, not to a peer key; binding funds to a peer still needs
the public key exposed upstream (or a signed statement), and stays out.

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
- no database service is introduced: `state.json`, `consumers.json` and the key store are small,
  local and single-writer (the host lock), and continue to use the backup/rename. Phase 6 adds one
  embedded SQLite file for the money ledger only (`ledger.sqlite`, WAL, `FULL` sync), because a
  deposit, a cap write and a usage import need multi-row uniqueness and transactions; Bun ships
  SQLite, so there is no server and no new dependency.

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
  `identity-changed`, the pending fingerprint is shown, `connect`/`catalog request` and
  `catalog connect` refuse, and only an explicit local acceptance (guided `connect --trust` with the
  exact fingerprint and quote, or `catalog trust`) accepts the new key.
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
is: discover -> browse -> guided `connect` displays the full TOFU fingerprint, quote hash,
`priceLocked:false`, `priceVersion` and models, and requires explicit `--trust --fingerprint …
--quote …` -> `connect --request-out` writes a structured request with the consumer's node id, the
provider's mapped address, models, quote hash and a **structured** approval block (no shell command)
-> the provider reviews it and runs `share approve <request.json> --cap <usd> --yes` with a native
model whitelist and a provider-chosen positive cap -> `share handover --key-file` writes the key to
a 0600 file -> the consumer runs `connect --key-file` or `remote add --key-file`. The catalogue
itself has no endpoint that accepts a key, a deposit or a write.

Price display is read from Magpie's own `settings.json` `modelPrices` (and from
the local gateway's `magpie_price` when the gateway answers on loopback), in USD
per 1M tokens, with cache read/write and tiers when present. A model with no
configured price is published as "no published price", never invented. The
minimum top-up is a simulated display field (`simulated: true`). Phase 7 adds a
separate testnet watcher that credits mock test tokens after finality; there is
still no fiat or mainnet payment path. A quote change does not call the
provisioner and cannot change a
Gateway Key's cost cap. Since phase 6 the quote also carries
`billing.priceVersion` (recomputed by the reader) and `billing.priceLocked:
false`; a consumer's accepted quote hash/price version is bound to its key, and
a mismatch pauses it for an explicit reissue (Decision 20). Real charging still
depends on the price-lock work in Decision 4/known blockers.

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

## Decision 18 — Prepaid credit is a local immutable ledger, not native `used`

Magpie has no immutable per-call cost: a key's used cost is summed from `usage.jsonl` and each
record is priced at the **current** effective price (`internal/budget/budget.go`, `internal/usage/
ledger.go`). A price change therefore reprices history, and a window end makes the old used cost
zero. The plugin's balance of record is a local SQLite ledger (`plugin/src/ledger.ts`, 0600, WAL,
`FULL` sync); Magpie remains the only enforcement point and the only source of token counts.

Money is integer nano-USD. For a consumer:

```text
T = sum of applied deposits (the opening credit is one deposit)
L = sum of settled usage snapshots, each priced at its window's bound price
B = T - L                         (negative is an overdraft)
U = Magpie's native cost in the current window
while open: native cap = floorGrid(U + B)
new window: native cap = floorGrid(B)
```

A top-up never uses `old cap + amount`; it recomputes from `U + B + amount`. A cap is floored to
Magpie's `$0.0001` grid, never rounded up. `0 <= B < $0.0001` is dust and cannot produce a usable
key; it stays in the ledger. Consumption rows are copied from Magpie's own `usage.jsonl` with a
stable id and a byte offset advanced in the same transaction. The plugin does not count tokens,
route requests or meter a second time.

Deposits are idempotent intents: the intent is written first, the cap is written, the gateway is
read back, and only then is the deposit applied. A crash leaves an intent; `reconcile()` applies it
only if the read-back shows exactly that cap, otherwise it marks it failed. The same id with another
amount is refused. A top-up, a usage import and a key change for one consumer are serialized.

## Decision 19 — Long window, but every boundary is a reissue

The default window is `days 3650` (Magpie's maximum), so a day/week reset cannot re-grant credit
every midnight. It is **not** treated as permanent: `Limit.Window` still ends it, and a 3650-day
test was made to end by state injection. At a boundary, or if the native window start differs from
the ledger's, the plugin removes the key and pauses the consumer. `reissue` then:

1. imports the old window's settled usage (including a request that started before the boundary and
   finished after it; Magpie records its start time);
2. removes the old key, so no new request can enter;
3. waits a bounded drain for in-flight streams;
4. closes the old window and recomputes `B`;
5. if `B < $0.0001`, leaves the consumer paused as `overdraft`/`dust` and issues no key;
6. otherwise creates a new key with `cap = floorGrid(B)` and a new price version.

New ledger-managed keys use a plugin-owned secret (`sk-ohmy-…`) so reissue can keep the same
credential. Magpie's generated `sk-magpie-…` secret cannot be passed back through `gateway-key add
--key`; a legacy key gets a new secret on its first reissue and must be handed over again. The
plugin never calls `limit reset`, never changes a window to top up, and never issues a key with a
zero cap (zero means unlimited).

The drain is bounded, not an atomic proof against an arbitrarily long stream. A stream that settles
after reissue is imported on the next reconcile and reduces the balance then; it is an explicit
operational uncertainty, never treated as free.

## Decision 20 — A quote binds a price version, but Magpie cannot lock a price

Each signed catalogue quote carries `billing.priceVersion` (SHA-256 of sorted model prices) and
`billing.priceLocked: false`. A reader recomputes the version from the quoted models; a wrong value
is refused. A consumer's accepted `contentHash` and price version are stored with its key, and a key
is refused if the live effective price at issuance differs from the accepted version.

A later mismatch pauses the key. `reissue` requires `acceptPriceVersion=<new>` explicitly; settled
consumption stays at the old snapshot, so the carried balance is not repriced. A new quote may be
published at any time, but it is an accurate billing promise only after active keys are paused and
reissued at the new version; otherwise the quote is marked `priceLocked:false` and must not be
presented as a lock. Detection is polled. A call made between an external price edit and the next
reconcile can still be charged at the new price: this is **not real-time price protection**, and it
is the blocker in section "Known blockers". The same applies to a price decrease: the native read
endpoint can show more credit while the running admission sums still hold the old, higher cost;
only a key change/restart/new window clears them.

## Decision 21 — The accounting check runs on its own cadence, and stops serving when it cannot prove the books

`Provisioner.ledgerCheck` used to run only when somebody asked for a status or opened the page.
A price edit or a window boundary with nobody watching therefore went unnoticed. The service now
runs `accountingTick()` every `ACCOUNTING_TICK_MS` (10 s) plus once at start and once at configure,
serialized per consumer with `topUp`/`reissue`/`revoke`/`handOver` by the same lock.

- It is a **poll**, not a price lock. `accountingStatus()` reports `intervalMs`,
  `maxDetectionMs` (interval + timeout), the last check and its duration, so the real exposure is
  visible instead of implied.
- A check that throws, times out (20 s) or cannot read the price source counts as a failure. After
  `accountingFailureBudget` (3) consecutive failures the export is withdrawn with a reason prefixed
  `accounting-uncertain:`, which `guardSharedKeys` may **not** clear. Only a passing check
  re-validates every key and republishes, and it refuses while any consumer's charges are still
  uncertain.
- `configure()` installs the loops as well as `start()`: a node configured through the loopback API
  is not left without the check.

Measured on the isolated Magpie: an external `magpie model price` edit was detected and the key
revoked in 146 ms of check time; the next remote call was 401.

## Decision 22 — Consumption identity is the log position, and old windows keep being audited

Magpie's `usage.jsonl` has **no unique request id**. `route_id` is a per-process counter seeded from
`UnixMilli` (`internal/gateway/trace.go`, `trace.begin`), it restarts near the same value on the next
run, and a rejected row carries none; `rid` is the vendor's id and absent for most calls. A content
hash therefore collides two genuinely identical calls and cannot distinguish them from a re-read of
one line.

A consumption event is identified by `(usage-log id, byte offset of the line, caller key id)`, hashed
into the row's primary key. The log id is the SHA-256 of the resolved path, so a replaced file cannot
collide with the old one. Consequences, all tested:

- two byte-identical lines at different offsets are two charges;
- re-reading from offset 0 charges nothing twice;
- a log that shrank below the cursor, or disappeared, is a **gap**: the consumer is paused
  (`log-gap`) and the export stays withdrawn rather than treating missing rows as zero;
- the rows and the cursor advance in one SQLite transaction.

`reissue` no longer treats a short drain as proof that an old window is finished. Every unsettled
window, and every window closed within the audit horizon (30 min), is re-read for late rows at each
check; a late row is charged at that window's frozen price snapshot, reopens a window that had been
called settled, and **tightens the live key's cap** to `native used + balance` — or pauses it when
the balance is negative or below one grid unit. A window is marked settled only on evidence: the
gateway reports no request in flight (`GET /v1/magpie/concurrency`) and the log has no unread bytes.
That evidence can still be overtaken by a request that ends immediately afterwards, which is why the
audit horizon exists; the status shows `openSettlements` and `uncertain` instead of claiming a clean
close.

## Decision 23 — A pause is only "enforced" at the level it really reached

A removed key is 401 for a remote caller, but Magpie serves a **loopback** caller with the same
secret (loopback is trusted by construction, `internal/gateway/lan.go`). A `$0.0001` cap is not a
stop either: measured, a 10/10-token call still returned 200 with 6e-05 used of 0.0001. Both facts
are now recorded instead of assumed.

`paused.enforcement` is one of:

| Level | Meaning |
| --- | --- |
| `keyRevoked` | the key is gone; a remote call with its secret is 401 |
| `secretRotated` | removal failed, so `gateway-key rotate` replaced the secret; the old one is 401 and the usage is kept |
| `capRestricted` | only the cap was lowered; the key still answers 200 |
| `networkWithdrawn` | the overlay publication was withdrawn as well |
| `safetyUncertain` | none of the above could be proven; the status says the consumer may still be served |

`enforced` is true only for the first two. If any paused consumer is not enforced, the accounting
check withdraws the export too, and a withdrawal that fails is reported, never treated as a stop.
`--cost 0` is never used: Magpie reads a zero cap as unlimited.

## Decision 24 — The three stores are reconciled before serving

`Provisioner.recover()` runs at start and reconciles Magpie's key list, `ledger.sqlite` and
`consumers.json`:

| Crash point | Recovery |
| --- | --- |
| ledger account + window, key alive, record missing | adopt the record from the ledger and the key (a reissue whose file write was lost) |
| ledger window, key gone | keep the balance, report the consumer as uncertain, serve nothing |
| key named `ohmyaihub-*` with no ledger account | remove it: an unbound key has no balance behind it |
| record with no ledger account | seed from `cap - used` and start reading the log at its current end |
| `consumers.json` unreadable | refuse to start with an empty list; recover `.prev` when it is valid |

`consumers.json` now uses the same atomic writer as `state.json` (temp file, fsync, rename,
directory fsync, `.prev`). It used a plain `writeFileSync`, which a crash could truncate.

## Decision 25 — An unverifiable check is a failed check

`ledgerCheck` used to return `reason: "unreadable"` when `GET /v1/magpie/limit` threw, and
`checkConsumer` turned that into a normal view. The periodic check therefore counted an unreadable
key as **healthy**: a gateway that kept accepting AI calls while its limit endpoint failed could
serve indefinitely with nobody able to prove the books.

- `ledgerCheck` now reports `verified: false` with the reason, and `checkConsumer` throws
  `VerificationUnavailableError`. A transient read error and a real cap mismatch stay different
  things (the first does not pause a key; the second does), but **neither is a pass**.
- The service counts every throw as a failure. `lastOkAt` only moves on a check that verified every
  consumer; `failures`, `uncertain`, `uncertainReason` and `serving` are updated from the real
  result. After `accountingFailureBudget` consecutive failures the export is withdrawn.
- A passing check re-verifies every consumer before republishing. A paused consumer has no key to
  read and is verified by absence, not by a read that cannot fail.
- A key whose charges cannot be read is not paused for that alone (a read outage is not evidence of
  fraud), but it is marked `ledgerUncertain`, so it is not reported as healthy either.

Measured on the isolated Magpie with the plugin pointed at a closed port: `checkConsumer` rejected,
the gateway still answered a real AI call `200` during the outage, and the state returned to healthy
only after the read worked again.

## Decision 26 — A usage-log gap is persistent and blocks reissue

A gap means the log no longer holds what the cursor had already passed, or a complete line cannot be
parsed: charges may be missing. It used to live only in a function's return value, so `reissue()`
could ignore it and grant a balance the plugin could not prove.

- Gaps are stored in SQLite (`usage_gaps`, per consumer and log, with first/last seen and an
  occurrence count) on **every** path that finds one, including an early return.
- `reissue()` refuses while any gap is unresolved, before creating a key and without touching the
  recorded balance. The refusal survives a restart because the row does.
- The log coming back, or reading some rows again, does not clear it: only
  `resolveGap()` does, and only with `resolvedBy` and a note. It records the accepted byte offset as
  the new baseline (otherwise the next read would rediscover the same truncation) and keeps the
  previous offset in the event log. **No money is reconstructed or compensated** in this phase; the
  reissue that follows carries the recorded balance only.
- A complete line that is not valid JSON marks the same uncertainty instead of being skipped as a
  zero-cost call.


## Decision 27 — Every network is a peer; nothing names a primary chain

BSC and Base are the first two **registered** networks, not a privileged pair. The registry
(`plugin/src/networks.ts`) has no `primary`, `secondary`, `preferred`, `default` or `priority` field,
and a test asserts that the serialized registry contains none of those words. Both records have the
same key set. Disabling one leaves the other enabled, and the choice survives a restart.

Consequences that are enforced rather than documented:

- No chain id appears in `ledger.ts`, `provisioner.ts`, `chainstore.ts`, `deposits.ts` or
  `watcher.ts`. Adding a chain is a registry record.
- A third EVM chain was added by data alone and the **whole** pipeline ran on it
  (`scripts/chain-lab.ts`, chain 31337), which is the practical proof that the crediting path is not
  BSC- or Base-specific.
- Mainnet 56 and 8453 are present as `RESERVED_MAINNETS` with `enabled: false`, and three separate
  code paths refuse to enable them or to watch them.

## Decision 28 — Assets are `(chainId, contract)`, never a symbol

Two chains may both have a token called `tMOCK6` at the same address; they are different assets
(`eip155:97:0x…` vs `eip155:84532:0x…`). Nothing compares symbols, and no conversion crosses a chain.

- A test asset can only be registered after the chain has answered `decimals()`, and the value must
  match what the operator claims, because every later conversion depends on it.
- `registerTestAsset()` refuses a symbol or name that does not say it is a mock or a test token, so
  `USDC` cannot be introduced on a testnet through this path.
- No contract address ships in the repository: a deployment is recorded with its transaction hash in
  a lab report, never typed in from expectation.

## Decision 29 — Finality is a per-network policy with its measurement attached

A single global confirmation count would either over-credit one chain or needlessly delay the other.
Measured 2026-10-30: BSC testnet's `finalized` tag equals `latest` on every endpoint tried, so it
proves nothing there; Base Sepolia's `finalized` lags ~5,100–7,200 blocks (~17–24 min) and three
providers agree, so it is the real condition.

- `FinalityPolicy` is a field of the network record: `mode` (`finalized-tag` or `confirmations`),
  the depth, the known reorg depth, a `rationale`, and the measurement it rests on.
- BSC testnet uses 15 confirmations as a **stated substitute** for a tag that carries no depth
  information; Base Sepolia uses the tag.
- `finalityVerdict()` is pure, so both policies are tested at the same heights and produce different
  answers.
- A chain that cannot answer the tag never finalises under a tag policy: unknown is not final.

## Decision 30 — A transfer is credited only when one signed intent matches it exactly

A provider publishes one receiving address per chain; many consumers pay it. Attribution is
therefore cryptographic, not heuristic:

- The plugin issues a deposit intent with a single-use nonce and an expiry, and hands the consumer an
  EIP-712 document whose **domain carries the chain id** and whose message carries invoice, consumer,
  provider, chain, asset, token contract, recipient, exact raw amount, nonce and both timestamps.
- The consumer signs with their own wallet and states the address they signed with. The plugin
  recovers the signer locally and requires the recovered address to equal the stated one.
- **Stating the payer is mandatory, not defensive.** A signature over a different document still
  recovers to *some* address; binding on recovery alone would attach an invoice to an address nobody
  controls and make the real payment unclaimable. This was found by a failing test.
- A `Transfer` claims the intent only if chain, token, recipient, amount and sender all match, the
  intent is unexpired, and exactly one candidate matches. Zero candidates means `unclaimed`; two or
  more means `uncertain`. Neither is ever credited.
- A payer who cannot sign (an exchange withdrawal, a contract, a third-party relay) stays `unclaimed`
  and is visible in the anomaly list. The plugin does not guess.

## Decision 31 — Uniqueness is a database constraint, not a set in memory

`deposit_events` is unique on `(chain_id, token_contract, tx_hash, log_index)` — not on the tx hash,
because one transaction may contain several `Transfer`s. `deposit_id`, `claimed_event_id` and
`intent.nonce` are separately unique. A rescan finds the same row and only increments an observation
count; a second claimer's transaction fails instead of overwriting.

The deposit id is derived from the chain event (`chain:<chain>:<contract>:<tx>:<log>`), so a crash at
any point retries the **same** deposit rather than creating a new one. `applyChainDeposit()` is the
only way into the ledger, and it marks the deposit applied only after Magpie's read-back shows the
cap — the phase-6 rule, unchanged.

## Decision 32 — A reorg freezes; it never deletes or adjusts

A credited event whose block hash is no longer canonical becomes `reverted`, an anomaly row is
written, and the consumer's ledger account is paused through the same `pause()` a price change uses,
so the enforcement level is measured rather than assumed. The deposit row stays, the balance is not
edited, and `reissue()` is the only way back. Proven with `anvil_reorg` on a real node: two credits,
two freezes, two deposits still present.

## Decision 32a — Stored, verified and credited are three different states

A chain log becomes credit in three steps that can each fail, so they are recorded separately:

- **stored** — the log exists in `deposit_events` with its `(chain, token, tx, logIndex)` key. The
  page's rows and the scan cursor commit in **one** transaction, so a failure re-reads the range
  instead of skipping it.
- **verified** — the transaction receipt exists, is successful, and contains this log at this block.
  A provider that cannot serve the receipt is a *retryable* condition, not a refusal: the event stays
  in `pendingVerification()` (a query, so it survives a restart) and is re-examined on the next pass,
  including a pass with no new blocks. Only a reverted transaction is permanent.
- **credited** — the finality policy holds, the amount is converted at the rate the **intent** was
  issued at, and the ledger has accepted the deposit.

A `crediting` row means the ledger intent exists; it does **not** mean the block still does. Every
credit, including a retry, first re-reads the block hash and re-evaluates the finality policy. A
reorg marks the event `reverted`, keeps the deposit for audit and freezes the consumer; a chain that
cannot answer pauses the retry rather than assuming the payment is still good.

## Decision 32b — A deposit is converted at the rate it was requested at

The rate (and its version) is snapshotted into the deposit intent at issue time and frozen onto the
event before the ledger is asked for anything. A registry edit afterwards cannot change the value of
an amount the consumer already signed for; an intent with no snapshot is converted only if the
registry still reports the version it was issued with, and otherwise goes to manual review. This is
the same rule the phase-6 ledger applies to consumption: a settled amount is never repriced.

## Decision 33 — No buy, swap, bridge or fiat path; two plain external links

The product does not sell, buy, swap, bridge or exchange any token. There is no buy button, order
form, price comparison, account linking, embedded browser, exchange SDK, fiat order tracking or
referral parameter, and no code path credits on a "payment complete" page.

The page carries exactly two external documentation links — BNB Chain's guide to moving assets to
BSC, and Peer's guide to buying with Alipay — as fixed HTTPS URLs with no query string, opened with
`rel="noopener noreferrer external"`, labelled as third-party sites that are not part of this
product, with an explicit statement that Peer and Alipay have no partnership with this project and
that the guides are about real mainnet assets and do not obtain test tokens. Tests assert there are
exactly two such links, that no URL is built at runtime, and that the only buttons on the page are
"Reload snapshot" and the settings form's "Save".

## Preferred dataflow

```
consumer agent -> consumer Magpie (Remote Magpie provider)
   -> http://127.0.0.1:<forward>            (consumer's EasyTier port forward)
   -> EasyTier overlay (Forward chain)      -> provider's own LAN address:3425
   -> provider Magpie: Gateway Key guard -> budget/limit -> native routing -> upstream
```

Deposits (phase 7, testnet only):

```
consumer wallet --ERC-20 transfer--> provider's receiving address on chain N
   -> ChainWatcher(N): eth_getLogs -> deposit_events (unique) -> signed intent claims it
   -> finalityVerdict(N's own policy) -> convertRawToNanos (bigint, floor, dust recorded)
   -> Ledger.depositIntent(id = chain:<event>)         <- the only booking
   -> Provisioner.applyChainDeposit: cap = native used + ledger balance
   -> Magpie read-back -> markDepositApplied
   -> Magpie Gateway Key
```

The chain module cannot reach a Gateway Key: its whole interface to the accounting side is four
methods, none of which is a key operation.

## Payment invariants (phase 6 accounting + phase 7 testnet wallet)

- Wallet identity is proven by an EIP-712 signature over a deposit intent that carries the chain id;
  binding it to the peer public key remains future work (EasyTier 2.6.4 does not expose it).
- Only testnet assets are creditable. Mainnet 56/8453 are registered and always disabled; no mainnet
  transfer is watched, confirmed or credited in this phase.
- Every network is equal: no primary chain, no automatic network choice for the consumer.
- Credit only a confirmed ERC-20 `Transfer` receipt to the intended provider, from a registered
  sender or an explicit signed invoice.
- Deposit dedupe key: `(chain ID, token contract, tx hash, log index)`; the local ledger uses the
  same unique-id intent.
- Durable intent state machine; an unknown broadcast must be reconciled before any retry; one
  outstanding top-up per counterparty. The plugin's `depositIntent`/`markDepositApplied` is the
  local half of this and is already tested across a crash.
- No per-request chain write; the provider's Magpie estimate is the billing basis.
- Store a **price snapshot per charge**; never recompute a settled invoice from current prices. The
  phase-6 ledger does this for every imported usage row.
- Window rollover and price changes need explicit reconciliation, not a blind reset. A boundary is a
  key reissue with `cap = ledger balance`; a price change is a pause plus explicit version accept.
- Real funds stay blocked until the price-lock blocker is solved; testnet chain credit only, no
  mainnet asset.

## Pinned versions

| Component | Version | Scope and identity |
| --- | --- | --- |
| Magpie | 0.1.2038 | **host/CLI and pricing/billing pin**; tag `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| Magpie | 0.1.2057 | official Linux no-GUI container, **consumer only**; `ghcr.io/yetone/magpie@sha256:900711e2867299e6dbc7d9b02112e86d0a00add626f61bacfad83be0da5fbe5e`; see the fresh two-host report |
| Magpie | 0.1.2120 | **page/bridge source comparison**; tag `v0.1.2120` = `eed140c4d9a7916a77e382d8a9c8b3f071f602b2`; full host/CLI UNKNOWN |
| Magpie | 0.1.2171 | isolated `magpie web` **page/CSP/Save browser evidence only**; no host/CLI verification; desktop WKWebView UNKNOWN |
| EasyTier | 2.6.4 | tag `v2.6.4` = `8428a89d2dabc94c97d370ec607c6ca142473626` |
| Bun | 1.4.3 | operator CLI and CI |
| Foundry | 1.8.6 | testnet wallet labs; commit `6bad0a66de7c83f7b33695044138f0f5fa4c5990` |

The plugin pins the EasyTier release assets by SHA-256 in `plugin/src/easytier-manifest.ts` and
refuses an unlisted platform or a hash mismatch. The 0.1.2120 comparison does not change the
0.1.2038 billing pin. The 0.1.2171 browser run is page evidence, not a host/CLI compatibility claim.

## Known blockers / open questions

1. **Pricing lock (real-funds blocker):** Magpie has no price pinning, no per-key price and no
   immutable cost per call; changing a model's price recomputes past charges. Phase 6 measured that
   `/v1/magpie/limit` reprices immediately while running admission sums keep the old price until a
   restart/new window/key change. The ledger preserves the balance and pauses after detection, but
   a call in the detection gap can still be repriced. Must be solved upstream or by a request-path
   guard before real credit is outstanding.
2. **Overshoot tolerance** has no closed form (in-flight burst, output length). Prepaid credit needs
   an explicit tolerance or the provider accepts the overrun.
3. **Interrupted calls** that never produce a usage row are unbilled on both sides. A call that
   completes after a window boundary does produce a row with the request-start time; the ledger
   imports it, but the native new window does not count it (Decision 19).
4. **Platform coverage is not symmetric.** Linux EasyTier is verified; the official Linux Magpie
   0.1.2057 **consumer** container is verified; Linux Magpie **GUI/provider** behaviour is untested;
   Windows is untested. Magpie 0.1.2120 is a page/bridge comparison; 0.1.2171 has an isolated `magpie web` page run only (desktop WKWebView UNKNOWN).
5. `easytier-cli acl set` is absent in 2.6.4 (restart required).
6. The community plugin **page cannot reach the network** (`internal/gui/pluginpage.go`, CSP
   `connect-src 'none'`). It is read-only after onboarding and renders a generated snapshot; the
   official options bridge is only for the initial setup and display preferences. A live fetch needs
   a future first-class bridge.
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

Phase-6 ledger and accounting additions:

14. **A native window boundary is not atomic with a cap rebase.** Phase 6 removes the key and
    requires `reissue`; it does not silently adjust the cap at the computed reset time. A consumer
    is therefore briefly refused at a boundary (and after a price change) until reissue. A 3650-day
    default makes this rare, not permanent.
15. **Stale admission sums after a price change** are a Magpie-internal property, not something the
    plugin can flush. A read of `/v1/magpie/limit` is not proof of the admission result; only
    revoking/rotating the key (or restarting Magpie) clears the kept sums.
16. **Legacy `sk-magpie-` secrets cannot be reused by `gateway-key add --key`.** New ledger-managed
    keys use `sk-ohmy-…`; a legacy consumer's first reissue gets a different secret and must be
    handed over again.
17. **`reissue` still drains for a bounded time** (`drainMs`, default 1.5 s) before it closes the old
    window, but that is no longer how a late row is handled: every unsettled window, and every one
    closed within 30 min, is re-read at each accounting check and its late rows are charged at the
    frozen price and tighten the live cap (Decision 22). The drain only shortens the window in
    which a late row can arrive.
18. **"Settled" is evidence-based, not a guarantee.** A window is marked settled when the gateway
    reports nothing in flight and the log has no unread bytes. A request can end immediately after
    that check; the audit horizon catches it and reopens the window. The status reports
    `openSettlements` rather than claiming every window is closed.
19. **The accounting check is polled at 10 s** (plus its own duration, reported as
    `maxDetectionMs`). A price edit inside that window can still be repriced by Magpie. This is
    detection, not a price lock.
20. **A pause may not fully stop a local caller.** Removing a key is 401 for a remote caller, but
    Magpie serves a loopback caller with the same secret. If removal and rotation both fail, the
    level is `capRestricted` (the key still answers 200) or `safetyUncertain`; the export is then
    withdrawn and the failure is reported instead of being called a stop.
21. **A usage-log gap is permanent until an operator resolves it.** The missing charges are never
    reconstructed: resolution records who accepted what and the byte offset treated as accounted
    for, and the reissue that follows carries the recorded balance. A gap inside the accounting
    check's own read path is not silently retried into health.
22. **An unreadable limit endpoint is a failed check, not a healthy one.** It does not pause the key
    by itself (an outage is not evidence of fraud), but it counts against the failure budget and
    withdraws the export after the threshold.

Phase-7 testnet-wallet additions:

23. **Fresh cross-host payment acceptance is VERIFIED for the mock-upstream scope.** New BSC and Base
    Sepolia payments credited the same real Gateway Key through two independent hosts, real EasyTier
    no-TUN and a real native Remote Magpie, with automatic watchers, restart recovery, duplicate
    scans and cleanup. See
    [`validation/2026-10-30-fresh-twohost-wallet.md`](validation/2026-10-30-fresh-twohost-wallet.md).
    The earlier original-payment replay into the real ledger/Magpie key is a separate VERIFIED
    claim ([`validation/2026-10-30-live-magpie-chain-credit.md`](validation/2026-10-30-live-magpie-chain-credit.md)).
    Real vendor/paid model execution and a local EVM reorg remain separate; the two-host run used a
    deterministic mock upstream.
24. **BSC testnet's finality policy is a substitute.** Its RPCs report `finalized` == `latest`, so 15
    confirmations is a conservative choice, not a measured chain guarantee. No BSC testnet reorg
    distribution was observed.
25. **The verification retry set is bounded per tick** (100 verify, 50 credit). A large backlog
    drains over several scans; the deposit is never lost, but it can take time.
26. **Two identical intents from one payer are ambiguous by design.** The plugin marks the event
    `uncertain` and credits nothing. Safe, but a real usability limit; per-consumer addresses or
    amount uniqueness would fix it and are explicitly out of scope for this phase.
27. **Attribution depends on the consumer keeping their wallet key.** A payment from an exchange
    withdrawal address is `unclaimed` forever without manual review. There is an anomaly table and a
    CLI, not a resolution workflow.
28. **The watcher trusts the configured RPC for a log's existence.** It cross-checks the receipt and
    re-reads the block at finality time, and reports endpoint health, but a provider that lies
    consistently about a block and its hash would not be caught. There is no consensus read.
29. **The wallet page is read-only.** Enabling a network, registering an asset, creating or signing an
    intent are CLI/API operations, because the page cannot reach the network (`connect-src 'none'`).
30. **No HD wallet, no per-consumer addresses, no key custody.** The plugin stores no private key for
    either side; the provider's receiving address is one they already own.

## References

- Magpie: https://github.com/yetone/magpie (pin above)
- EasyTier: https://github.com/EasyTier/EasyTier (pin above)
- Validation: [`validation/2026-10-29-local-lab.md`](validation/2026-10-29-local-lab.md),
  [`validation/2026-10-29-acl-fix-and-two-host.md`](validation/2026-10-29-acl-fix-and-two-host.md),
  [`validation/2026-10-30-plugin-phase3.md`](validation/2026-10-30-plugin-phase3.md),
  [`validation/2026-10-29-phase4-multi-role-multi-provider.md`](validation/2026-10-29-phase4-multi-role-multi-provider.md),
  [`validation/2026-10-30-phase5-peer-catalog.md`](validation/2026-10-30-phase5-peer-catalog.md),
  [`validation/2026-10-30-phase6-pricing-window.md`](validation/2026-10-30-phase6-pricing-window.md),
  [`validation/2026-10-30-phase7-multichain-wallet.md`](validation/2026-10-30-phase7-multichain-wallet.md),
  [`validation/2026-10-30-testnet-handoff.md`](validation/2026-10-30-testnet-handoff.md),
  [`validation/2026-10-30-live-magpie-chain-credit.md`](validation/2026-10-30-live-magpie-chain-credit.md),
  [`validation/2026-10-30-fresh-twohost-wallet.md`](validation/2026-10-30-fresh-twohost-wallet.md),
  [`validation/phase8-journey-plan.md`](validation/phase8-journey-plan.md),
  [`validation/2026-10-30-phase8-onboarding-ux.md`](validation/2026-10-30-phase8-onboarding-ux.md)
- Corrected provider config: [`validation/lab/provider-acl.toml`](validation/lab/provider-acl.toml)
