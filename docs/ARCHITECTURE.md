# Architecture decision record — updated 2026-10-29 (phase 4)

Phase 4 turns the two mutually exclusive roles into two independent capabilities on one node
(share my Magpie, consume other Magpies) and replaces the single consumer wiring with a set of
remote providers. Everything measured in phase 3 still holds; the new decisions are 8–12 and
the evidence is in [`validation/2026-10-29-phase4-multi-role-multi-provider.md`](validation/2026-10-29-phase4-multi-role-multi-provider.md).

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
by the poll interval (~15 s), not zero: a request already in flight or made inside that window could
still use a channel whose provider id was just replaced. Absolute real-time prevention would need
Magpie to make a key's provider set immutable or a request-path intermediary; **LIMITATION**, see
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
9. **The no-resale guard is polled** (~15 s), not instantaneous; see Decision 10. A provider id
   replaced outside the plugin can be used through an existing key inside that window. Treat
   absolute real-time prevention as UNKNOWN until Magpie offers immutable per-key provider scope.
10. **A provider whose connection record was lost is treated as foreign** and is not overwritten;
    remove it in Magpie before re-adding it with the plugin (deliberate, fail-closed).

## References

- Magpie: https://github.com/yetone/magpie (pin above)
- EasyTier: https://github.com/EasyTier/EasyTier (pin above)
- Validation: [`validation/2026-10-29-local-lab.md`](validation/2026-10-29-local-lab.md),
  [`validation/2026-10-29-acl-fix-and-two-host.md`](validation/2026-10-29-acl-fix-and-two-host.md),
  [`validation/2026-10-30-plugin-phase3.md`](validation/2026-10-30-plugin-phase3.md),
  [`validation/2026-10-29-phase4-multi-role-multi-provider.md`](validation/2026-10-29-phase4-multi-role-multi-provider.md)
- Corrected provider config: [`validation/lab/provider-acl.toml`](validation/lab/provider-acl.toml)
