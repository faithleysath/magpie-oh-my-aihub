# 2026-10-30 — Phase 5: peer discovery and read-only catalogue

Phase 5 adds two independent, opt-in capabilities to the phase-4 node:

- **discovery** — read EasyTier's own peer/route data, classify self / connected /
  unknown peers, and read peers' catalogues;
- **publication** — serve one signed, read-only JSON quote of this node's
  shareable **native** models and explicit prices.

No wallet, chain, central directory, DHT, mDNS, broadcast discovery, new routing
algorithm, AI gateway or automatic key issuer was added.

Evidence marks: **VERIFIED** (read from the pinned source), **REPRODUCED** (ran
here), **UNKNOWN**.

## 1. Environment

| Component | Value |
| --- | --- |
| Host | macOS 26.6.2 (build 25G83), arm64 |
| Bun | 1.4.3 |
| Magpie | 0.1.2038, tag `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` |
| EasyTier | 2.6.4, tag `v2.6.4` = `8428a89d2dabc94c97d370ec607c6ca142473626`, SHA-256 verified by the plugin |
| Plugin | branch `feature/peer-discovery-catalog` (this PR) |
| Lab | three isolated Magpie data dirs (A consumer, B/C publishers), three plugin hosts, one real EasyTier no-TUN overlay, three local OpenAI-compatible mocks |
| Network | one private EasyTier network, isolated `HOME`/`XDG_CONFIG_HOME`, no real vendor key, no wallet |

The lab runs three instances on one machine, so each publishes on a distinct
catalogue port (A probes 3426, B 3427, C 3428). A real deployment defaults every
node to 3426; the bounded probe range (`base … base+4`) exists only because the
lab shares one LAN address and one catalogue port would collide. This is a
single-host limitation, not a claim about three physical machines.

## 2. Commands

```sh
# unit tests, typecheck, boot check, credential scan
cd plugin && bun run ci

# real end-to-end lab (needs Magpie 0.1.2038 and Bun 1.4.3)
bun docs/validation/lab/phase5/lab.ts --keep

# focus on the transport alone (consumer's real EasyTier SOCKS5 listener)
#   socks5_proxy = "socks5://127.0.0.1:<port>"
#   curl --socks5-hostname 127.0.0.1:<port> http://<mapped_cidr>:<catalog_port>/catalog/v1
```

The lab report is [`phase5-lab-report.json`](phase5-lab-report.json). It is
machine-readable; every step's detail is from that run.

## 3. Result summary

`bun docs/validation/lab/phase5/lab.ts` → **11 passed, 0 failed**
(REPRODUCED, 2026-10-29T23:15:57.280Z, macOS arm64).

`cd plugin && bun run ci` → typecheck, **158 unit tests**, boot-check and
secret-scan all pass. CI (Linux + macOS, Bun 1.4.3) is green at commit
`0d89eb4`: https://github.com/faithleysath/magpie-oh-my-aihub/actions/runs/40972860093

| # | Test | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Three isolated Magpie gateways enforce keys | PASS | keyless `/v1/models` on A and B → `401` |
| 2 | Three plugin hosts boot on one real overlay | PASS | A's peer list holds three nodes |
| 3 | B and C publish; A discovers both **without a typed mapped_cidr** | PASS | A's directory has B `10.66.216.180/32` v1 and C `10.66.233.27/32` v1; models and prices match |
| 4 | Catalogue via mapped_cidr; virtual IP is blocked | PASS | mapped `…:3427` → `200`; virtual `10.77.0.6:3427` → read timed out (Inbound Drop) |
| 5 | Catalogue port is not the management API | PASS | `/status`, `/providers`, `/configure` on the catalogue port → `404` |
| 6 | Manual connection request, capped key, existing connect flow | PASS | request contains no `sk-`; B `consumers add` + `secret`; A `catalog connect` → `connected`; native limit `0/1 USD` |
| 7 | A quote price change does not change the key cap | PASS | B input quote `1000 → 2000`; B key cap stayed `1` |
| 8 | B offline → last quote kept; B returns | PASS | A shows B offline with quote retained; B returns |
| 9 | Changed catalogue key is warned about, then accepted locally | PASS | `identity-changed`, pending fingerprint, `catalog request` refused; `catalog trust` accepts; status verified/connected |
| 10 | C unpublishes: listener stops, Forward port withdrawn | PASS | C `publishing=false`, `server.running=false`, Forward ports exclude `3428` |
| 11 | A host restart restores discovery, trusted peer and quote | PASS | discovery enabled, B connected, quote v3, provider record kept |

## 4. What the implementation actually uses

### 4.1 Peer discovery — EasyTier's own data (VERIFIED + REPRODUCED)

`Service.refreshCatalogPeers` calls the supervisor's:

- `easytier-cli -o json peer list` — `hostname`, `ipv4`, `id`, `cost`
  (`Local`/`p2p`/`relay(N)`), `lat_ms`, `loss_rate`, `tunnel_proto`,
  `nat_type`;
- `easytier-cli -o json route` — `ipv4`, `hostname`, `proxy_cidrs`
  (`real->mapped`), `next_hop_hostname` (`DIRECT`/a relay), `path_len`.

Source (`v2.6.4`):

- `easytier/src/easytier-cli.rs:1307-1395` — the peer table, the `Local` self
  row, and `cost_to_str`/`lat_ms`/`loss_rate`/`tunnel_proto`/`nat_type`;
- `easytier/src/utils/string.rs:1-7` — `p2p` vs `relay(N)`;
- `easytier/src/easytier-cli.rs:1764-1795` — the route table, `DIRECT` at cost 1,
  `proxy_cidrs`.

Classification rules (`plugin/src/catalog.ts`):

- `self` — `cost = Local` or the node's own hostname/virtual IP;
- `direct` / `relay` — `p2p`+`DIRECT` / `relay(N)` or a non-`DIRECT` next hop;
- `connected` — the mapped prefix owns a `ProviderConnection`;
- `unknown` — a live peer with no catalogue read yet;
- `conflict` — duplicate virtual address, duplicate mapped prefix, or a route
  whose hostname does not match the peer; conflicting rows are **never probed**;
- `offline` — kept with its last quote for at most one hour after EasyTier stops
  listing it.

No DHT, mDNS, broadcast, central directory or new routing algorithm exists in the
path. `hostname`, virtual IP, `mapped_cidr` and `peer_id` are routing hints, not
cryptographic identities; `peer_id` changes on every EasyTier start.

### 4.2 Catalogue transport — SOCKS5, not a port forward (VERIFIED + REPRODUCED)

EasyTier 2.6.4's config field `socks5_proxy` is a URL (`common/config.rs:549`),
and the server binds `proxy_url.host_str()` (`gateway/socks5.rs:661-670`). The
plugin writes `socks5_proxy = "socks5://127.0.0.1:<port>"`. The `--socks5` CLI
flag is not used because it hardcodes `0.0.0.0` (`launcher.rs:666-670`).

Why this path:

- `port-forward remove` prints success and keeps the listener (`port-forward
  patch` with no `dst_addr`; `easytier/src/proto/api.rs:53-75`), so one forward
  per catalogue read would leak an undelatable listener. The plugin creates
  **no** forward and **no** listener for a read; one loopback SOCKS5 listener is
  part of the generated TOML and serves every read.
- The client (`plugin/src/catalog.ts`) does a SOCKS5 CONNECT to the peer's
  **mapped IPv4** only (no DNS), then one HTTP GET, with a 5 s timeout and a
  64 KiB response cap.
- The SOCKS5 listener is verified loopback-only at runtime with the same
  `lsof`/`ss` check as the RPC portal. It is off unless discovery is enabled.

Runtime proof:

- `curl --socks5-hostname` against real EasyTier reached the mapped catalogue
  (`HTTP 200`);
- the plugin's own `socksHttpGet` reached a real Bun HTTP server through the real
  EasyTier SOCKS5 listener (`200 {"ok":true,"via":"catalog"}`);
- the same request to the provider's **virtual IP** timed out (Inbound Drop);
- the lab's step #4 repeated both from A's plugin listener.

### 4.3 Catalogue server (VERIFIED + REPRODUCED)

`plugin/src/catalog.ts`:

- one `GET /catalog/v1`; every other path is `404`, every other method `405`;
- bound to the provider's LAN address, **not** `0.0.0.0`, **not** loopback;
- no write path, no AI request, no key, no Magpie admin call;
- 64 KiB body cap, 200 model cap, 8 concurrent requests, 60 requests/min with a
  burst of 10, 5 s idle timeout; no CORS header; `no-store`/`nosniff`;
- the provider's Forward ACL gets the catalogue port only while published;
  `setCatalogPublishing(false)` stops the listener and rewrites the TOML without
  the port (supervised restart). The lab verified both the listener and the
  Forward port are gone.
- Inbound remains `Drop` with zero rules. The lab's virtual-IP request timed out.

The catalogue is not the host API: the host API still binds `127.0.0.1` with its
bearer token; the catalogue has no reference to it. The page still uses the
generated `status.js` snapshot because Magpie serves plugin pages with
`connect-src 'none'`; CSP was not relaxed.

### 4.4 What is published

`Service.publishCatalogNow` reads Magpie's own READ-ONLY data:

- model ids from `magpie models` (filtered to **native** providers only);
- capabilities and explicit prices from the local loopback `/v1/models` when the
  gateway answers there, else from `settings.json` (`modelPrices`, `modelAPIs`,
  `modelImages`, `modelOutputs`, `modelReasonless`) and the provider's configured
  endpoints;
- price unit `USD per 1M tokens`, with cache read/write and tiers when present;
  no price is invented — an unpriced model is published as `null`;
- a simulated minimum top-up (`topUp.simulated = true`), never a wallet;
- an explicit `billing` block (`quoteOnly: true`, `charged: false`) saying the
  document is display data and real charging depends on the later price lock and
  a manually issued capped key;
- mapped_cidr, gateway port, catalogue port, display name, optional manual
  contact, publication version/updated time, and the self-signed identity.

It never reads or publishes Gateway Keys, upstream API keys, network secrets,
admin tokens, wallet secrets, usage ledgers, or a Remote Magpie's models. Unit
tests assert the JSON has no `sk-`, network secret, provider URL or private key.
The lab verified B's catalogue contains `mockb/b-model` and not a remote model.

### 4.5 Identity (VERIFIED by unit test + REPRODUCED in the lab)

- `catalog-identity.json` (0600) holds a persisted Ed25519 key; the quote body is
  canonical JSON and is signed (`plugin/src/catalog.ts`).
- A reader verifies the signature, recomputes the fingerprint (`SHA-256` of the
  32-byte public key) and stores the first-seen key per signed `node.id` in
  `catalog-trust.json` (0600).
- First sight is **unverified (self-signed, TOFU)**. `catalog trust` is the only
  way to mark it accepted; a same-key later read is still TOFU.
- A different key is `identity-changed`, shows the pending fingerprint, and
  refuses `catalog request`/`catalog connect`. The lab replaced B's identity
  file, saw `identity-changed` with a pending fingerprint, observed the refused
  request, then accepted it locally and re-read it as verified/connected.
- A catalogue whose signed `node.mappedCidr` does not match the address it was
  read through is refused.

This is not PKI and not a real-world identity: a self-signed document proves only
that the same key signed it. The Gateway Key remains the guard on the AI path.

### 4.6 Connection stays manual

`catalog request` produces a JSON request (`consumer`, `provider` mapped address,
gateway/catalogue ports, models, quote version/hash, identity status/warning,
simulated minimum, and the exact provider command). It contains no key and no
account. The lab then ran the existing flow:

1. B: `consumers add a-<A node id> mockb/b-model 1`;
2. B: `secret a-<A node id>`;
3. A: `catalog connect <B node id> --key sk-… --id peer-b` (which calls the
   existing `addProvider` path: forward, 401 probes, Remote Magpie, models);
4. A's status showed the native `/v1/magpie/limit` numbers (`0/1 USD`).

No automatic key, no deposit, no charge, no remote write path. A quote price
change (`1000 → 2000`) changed the display only; B's key cap stayed `1`.

## 5. Detection deadlines (correcting the phase-4 claim)

The phase-4 note said the no-resale guard is polled every ~15 s. That is only
true for the **provider id/type** fingerprint:

- **Provider list change** — `Service.providerFingerprint()` compares
  `nativeProviderIds()`/`remoteProviderIds()`; `tick()` runs every **15 s** and
  calls `guardSharedKeys()` when it differs.
- **Direct Gateway Key whitelist edit** — `caller-keys.json` is not part of that
  fingerprint. The full guard (`guardSharedKeys` → `magpie.keyById` vs native
  providers/share policy) runs at start, after `reconcileProviders` (about every
  **45 s**), after configure/connect/update/remove, and at each hand-over. A
  hand-widened key is therefore seen within ~45 s, or sooner if the provider list
  also changed or a hand-over happens.

Unit test `catalog-service.test.ts` "the full guard narrows an externally widened
key; catalogue refresh does not" proves the key-store path; the existing
provider-ownership tests prove the 15 s fingerprint path. Catalogue refresh never
calls either guard and never writes a key.

## 6. Security boundaries kept

- Inbound: `Drop`, zero rules (lab virtual-IP request timed out).
- Forward: `Drop`, only the gateway port(s) and the catalogue port while
  published.
- No key → no AI call; existing Gateway Key probe/limits/429s unchanged.
- No Remote Magpie model in any published catalogue or shared key.
- A manually created Magpie provider is untouched by catalogue/discovery; the
  phase-4 ownership check remains.
- No second token counter, no AI request metering, no USDC/wallet/chain code.
- The catalogue has no management endpoints and no write path; the host API is
  loopback + bearer token.

## 7. Limits / UNKNOWN

1. **Identity is self-signed TOFU**, not a verified real-world identity. A
   malicious overlay member can publish its own catalogue or copy another's; the
   Gateway Key still guards the AI path. No PKI or certificate server was added.
2. **The consumer SOCKS5 listener is loopback-only but unauthenticated.** A local
   process on the consumer could use it to reach the private overlay while
   discovery is on. It creates no forward and is off when discovery is off; local
   process isolation is out of scope.
3. **Discovery needs a mapped address and a catalogue port in the bounded probe
   range** (base and next four). A provider with no export, a conflicting route,
   or an unusual port is shown but not read.
4. **Single-host lab**: three instances share one LAN address, so their catalogue
   ports differ. A real three-machine deployment defaults to 3426 and does not
   need the probe range. A physical three-host run is still UNKNOWN.
5. **Price display is not billing.** Real charging still needs the price-lock
   validation from Decision 4; a quote price change never changes a key cap.
6. **`peer_id` is session-scoped**, and `noise_static_pubkey` is still not exposed
   by the 2.6.4 CLI; binding funds to a peer still needs that upstream capability
   or an operator-signed statement.
7. Catalogue publication/unpublication and discovery enable/disable are config
   changes and perform a supervised core restart (2.6.4 has no hot ACL edit).
   Discovery/quotes refresh without a restart.
