# Magpie Oh My AI Hub

A private-community P2P AI API sharing project based on Magpie, EasyTier no-TUN networking, and wallet-funded Gateway Key quotas.

**Status: phase 7 — one Magpie node can share its own channels, consume several remote Magpies, discover signed read-only model/price catalogues, keep a local immutable prepaid ledger with fail-closed key reissue, and watch **testnet** deposits on BNB Smart Chain testnet and Base Sepolia as two equal networks. Verified against Magpie 0.1.2038, EasyTier 2.6.4 and foundry 1.8.6. Testnet only: no mainnet asset is watched or credited, and real funds are still blocked by the native price-lock finding. The real-testnet deposit run is UNKNOWN — testnet gas could not be obtained; the pipeline is proven on a local EVM node with a real deployed ERC-20.**

## Current planned division of responsibilities

- **Magpie**: upstream providers, Remote Magpie, routing, Gateway Key authentication, quotas, usage accounting and model forwarding.
- **EasyTier**: private peer transport, discovery via Peer list, encrypted no-TUN networking and targeted port forwarding.
- **Plugin/local helper**: overlay and port-forward supervisor, per-consumer Gateway Keys, the set of remote providers this node consumes, the network/asset registry, signed deposit attribution, per-chain deposit watching with per-chain finality, and the ledger that the provisioner turns into a Magpie cap.
- **HK VPS**: EasyTier bootstrap/relay only. No centralized business server.

Do **not** implement a second AI API proxy, token router or charging gateway unless real integration tests demonstrate a hard security/compatibility limit in the native path.

Read [architecture](docs/ARCHITECTURE.md), [verification tasks](docs/VALIDATION.md), and [agent instructions](AGENTS.md).

## Phase 7: testnet chain deposits into the existing ledger

A provider publishes one receiving address **per chain**. A consumer asks for a deposit intent, signs
it with their own wallet, sends the test tokens, and the plugin credits them — but only after that
chain's own finality condition, and only when exactly one signed intent matches the transfer.

- **Every network is a peer.** `plugin/src/networks.ts` is a registry with no primary, secondary or
  preferred chain. BSC testnet (97) and Base Sepolia (84532) are two records of the same shape; a
  third EVM chain was added by data alone and the whole pipeline ran on it. Mainnet 56/8453 exist as
  always-disabled reserved records and are refused on three separate paths.
- **Assets are `(chainId, contract)`.** Two chains with a token called `tMOCK6` at the same address
  are two assets. A test asset is registered only after the chain answers `decimals()`, and a symbol
  that pretends to be a real token is refused.
- **Finality is per chain, with its measurement attached.** BSC testnet's `finalized` tag equals
  `latest` (measured), so it uses 15 confirmations as a stated substitute; Base Sepolia's `finalized`
  lags ~17 minutes across three providers, so it uses the tag.
- **Attribution is a signature, not a guess.** The EIP-712 document carries the chain id, invoice,
  nonce, exact amount and recipient. The plugin recovers the payer locally and requires it to match
  the address the consumer says they signed with — because a signature over a *different* document
  still recovers to *some* address. An unsigned payer stays `unclaimed` and is never credited.
- **Uniqueness is a database index**, `(chain, token, tx, logIndex)`, not a set in memory, and the
  ledger deposit id is derived from the event so a crash retries the same deposit.
- **A reorg freezes, never deletes.** A credited event whose block hash moved becomes `reverted`, an
  anomaly is recorded and the consumer is paused; the deposit stays and the balance is not edited.
- **No buy, swap, bridge or fiat path.** Two plain external documentation links (BNB Chain, Peer) and
  an explicit statement that Peer and Alipay have no partnership with this project.

```sh
bun plugin/bin/ohmyaihub.ts --data <magpie config dir> wallet networks
bun plugin/bin/ohmyaihub.ts --data <magpie config dir> wallet receiving provider-a 97 0x…
bun plugin/bin/ohmyaihub.ts --data <magpie config dir> wallet intent provider-a alice 97 eip155:97:0x… 2500000
bun plugin/bin/ohmyaihub.ts --data <magpie config dir> wallet events --tx 0x…
```

Evidence, including the measurements behind each finality policy, the local-chain lab with a real
reorg, and exactly which testnet steps are UNKNOWN, is in
[`docs/validation/2026-10-30-phase7-multichain-wallet.md`](docs/validation/2026-10-30-phase7-multichain-wallet.md).
**GO for continued testnet wallet development; NO-GO for real funds.**

## Phase 6: prepaid credit that survives price changes and window ends

Magpie remains the only charging point. Magpie 0.1.2038 has no price pinning and recomputes a key's
used cost at today's price, so the plugin now keeps the balance of record itself:

- a local SQLite ledger in `oh-my-aihub/ledger.sqlite` (integer nano-USD, unique deposit and usage
  ids, immutable price snapshot per window);
- top-up = `native used + ledger balance`, never `old cap + amount`; the deposit is credited only
  after Magpie's cap read-back;
- a price-version mismatch, a native window boundary or native-vs-ledger drift **pauses** the key
  (`gateway-key remove`, falling back to `gateway-key rotate`) instead of pretending the old cap is
  still safe, and records how far the stop really went;
- the check runs on its own 10 s cadence, not only when the page is opened; a check that cannot
  verify the books withdraws the overlay publication;
- a row that settles after a rotation is charged at the old window's frozen price and tightens the
  live key; consumption identity is the usage-log line position, not a content hash;
- `consumers reissue` creates a new key with `cap = ledger balance`, preserving a plugin-owned
  secret, and requires an explicit `acceptPriceVersion` after a price change;
- quotes carry `billing.priceVersion` and `priceLocked: false`, so a signed quote is a record of
  what was quoted, not a claim that Magpie will keep that price.

The measured price/window behaviour, the three candidate strategies and the exact GO/NO-GO are in
[`docs/validation/2026-10-30-phase6-pricing-window.md`](docs/validation/2026-10-30-phase6-pricing-window.md).
The accounting-safety review patch (periodic check, late-row settlement, log-position identity,
enforcement levels, crash recovery) is in
[`docs/validation/2026-10-30-phase6-review-fixes.md`](docs/validation/2026-10-30-phase6-review-fixes.md).
The final targeted patch (an unreadable limit fails the check; a usage-log gap blocks reissue until
an audited resolution) is in
[`docs/validation/2026-10-30-phase6-final-fixes.md`](docs/validation/2026-10-30-phase6-final-fixes.md).
**GO for testnet accounting development; NO-GO for real USDC until the native price-lock blocker is
solved.**

```sh
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie consumers reissue <consumer-id> --accept-price-version <sha256>
```

## Phase 5: peer discovery and a read-only catalogue

A node can opt in to **publish** a small signed JSON catalogue of its shareable **native** models,
API capabilities, explicit prices, simulated minimum top-up, mapped address and gateway port. A
node can opt in to **discover** peers, reading their catalogues through EasyTier's own loopback
SOCKS5 listener. No mapped_cidr is typed by hand; hostname, virtual IP and mapped_cidr remain
routing hints, not verified identities.

```sh
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie catalog config --display-name "My Magpie" --port 3426
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie catalog publish on
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie catalog discover on
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie catalog peers
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie catalog request <node-id>
```

- The catalogue is one read-only `GET /catalog/v1`, bound to the provider's LAN address, not a
gateway and not the management API. Its port is added to the Forward ACL only while published;
Inbound stays Drop with no rules, so the virtual-IP/loopback path is not a way in.
- Quotes are self-signed Ed25519 (TOFU). The first sight is **unverified**; a changed fingerprint is
  a warning and requires a local `catalog trust`, never silent acceptance. A signature is not a
  real-world identity.
- Quotes are display data: they do not create a key, a balance or a charge. The existing manual
  `consumers add` → `secret` → `provider add` flow still issues every Gateway Key, and a quote price
  change never alters a key's cost cap. Since phase 6 a quote also carries a recomputable
  `billing.priceVersion` and `priceLocked: false`; a key is bound to the accepted version.
- The plugin page stays read-only and CSP-compatible: it renders a generated snapshot with the peer
  directory, quotes, native key limits and warnings.

## Phase 4: two capabilities, several providers

`plugin/` is a real Magpie community plugin (a package with a Magpie page). One node can now:

- **share** its own Magpie on the overlay (`sharingEnabled`), issuing one **held** Gateway Key per
  consumer (native-only model whitelist + positive cost cap), and
- **consume** any number of remote Magpies (`consumingEnabled`), each with its own loopback port,
  Remote Magpie registration, Gateway Key and status.

Both run on one EasyTier core and one network identity. A shared key may only name this node's own
models, so a remote channel is never resold and an A→B→A chain cannot form through a shared key.
It never touches an AI request: Magpie keeps authentication, accounting and 429s. Phase-3
`provider`/`consumer` state migrates automatically, with a backup.

```sh
magpie plugin add /absolute/path/to/plugin          # install into Magpie
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie status
```

- Sharing: exports **its own LAN address as a `/32`** under a unique `10.66.a.b/32`, with the
  Inbound ACL dropping everything and the Forward ACL opening only its gateway port. The
  virtual-IP path (which would be rewritten to loopback and bypass the key) is never offered.
- Consuming: adds a `127.0.0.1` port forward to the provider's mapped address, registers it as a
  native Remote Magpie, and refuses to finish unless the ingress answers 401 without a key and
  with a wrong key, and the valid key lists a model.

```sh
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie providers
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie provider add peer-b --cidr 10.66.1.2/32 --key sk-… --port 3425
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie share on
```
- EasyTier 2.6.4 is downloaded and **SHA-256 verified** by the plugin, Secure Mode with a
  persisted X25519 identity, RPC pinned to `127.0.0.1`.

See [plugin/README.md](plugin/README.md) for install, configuration, operations and limits,
[`docs/validation/2026-10-30-plugin-phase3.md`](docs/validation/2026-10-30-plugin-phase3.md) for the
phase-3 matrix and [`docs/validation/2026-10-29-phase4-multi-role-multi-provider.md`](docs/validation/2026-10-29-phase4-multi-role-multi-provider.md)
for the phase-4 three-instance lab, and [`docs/validation/2026-10-30-phase5-peer-catalog.md`](docs/validation/2026-10-30-phase5-peer-catalog.md) for the phase-5 lab.

The older [Phase 0 prototype](prototype/phase0/README.md) is archived as a working experimental slice, **not the target architecture**. It contains an independent HTTP admission/charging proxy which should not be carried forward without evidence.

## Security

No keys, mnemonic phrases, real Gateway Keys, EasyTier network secrets, RPC credentials, personal records or payment databases in Git. A GitHub repository may be public. Wallet and payment code must stay on testnet until authenticated networking, quota semantics and double-credit protection are verified.
