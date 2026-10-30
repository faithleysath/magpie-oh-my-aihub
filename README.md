# Magpie Oh My AI Hub

A private-community P2P AI API sharing project based on Magpie, EasyTier no-TUN networking, and wallet-funded Gateway Key quotas.

**Status: phase 5 — one Magpie node can share its own channels, consume several remote Magpies, and discover signed read-only model/price catalogues from peers in the same EasyTier network. Verified against Magpie 0.1.2038 and EasyTier 2.6.4. No wallet, no chain, no real payments.**

## Current planned division of responsibilities

- **Magpie**: upstream providers, Remote Magpie, routing, Gateway Key authentication, quotas, usage accounting and model forwarding.
- **EasyTier**: private peer transport, discovery via Peer list, encrypted no-TUN networking and targeted port forwarding.
- **Plugin/local helper**: overlay and port-forward supervisor, per-consumer Gateway Keys, the set of remote providers this node consumes, simulated deposits, and later wallet binding, verified chain deposits, reconciliation and automatic top-up.
- **HK VPS**: EasyTier bootstrap/relay only. No centralized business server.

Do **not** implement a second AI API proxy, token router or charging gateway unless real integration tests demonstrate a hard security/compatibility limit in the native path.

Read [architecture](docs/ARCHITECTURE.md), [verification tasks](docs/VALIDATION.md), and [agent instructions](AGENTS.md).

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
  change never alters a key's cost cap.
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
