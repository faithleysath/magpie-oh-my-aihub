# Magpie Oh My AI Hub

A private-community P2P AI API sharing project based on Magpie, EasyTier no-TUN networking, and wallet-funded Gateway Key quotas.

**Status: the plugin skeleton works end to end against Magpie 0.1.2038 on macOS (verify, then run). No wallet, no chain, no real payments.**

## Current planned division of responsibilities

- **Magpie**: upstream providers, Remote Magpie, routing, Gateway Key authentication, quotas, usage accounting and model forwarding.
- **EasyTier**: private peer transport, discovery via Peer list, encrypted no-TUN networking and targeted port forwarding.
- **Plugin/local helper**: service catalog, peer-wallet binding, verified chain deposits, mapping prepaid funds to cumulative Gateway Key limits, reconciliation, automatic top-up, wallet safety and address book.
- **HK VPS**: EasyTier bootstrap/relay only. No centralized business server.

Do **not** implement a second AI API proxy, token router or charging gateway unless real integration tests demonstrate a hard security/compatibility limit in the native path.

Read [architecture](docs/ARCHITECTURE.md), [verification tasks](docs/VALIDATION.md), and [agent instructions](AGENTS.md).

## Phase 3: the plugin

`plugin/` is a real Magpie community plugin (a package with a Magpie page). It runs a private
EasyTier no-TUN overlay and issues one **held** Gateway Key per consumer (model whitelist +
positive cost cap), then raises that key's cumulative cap for a simulated deposit. It never
touches an AI request: Magpie keeps authentication, accounting and 429s.

```sh
magpie plugin add /absolute/path/to/plugin          # install into Magpie
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie status
```

- Provider: exports **its own LAN address as a `/32`** under a unique `10.66.a.b/32`, with the
  Inbound ACL dropping everything and the Forward ACL opening only its gateway port. The
  virtual-IP path (which would be rewritten to loopback and bypass the key) is never offered.
- Consumer: adds a `127.0.0.1` port forward to the provider's mapped address, registers it as a
  native Remote Magpie, and refuses to finish unless the ingress answers 401 without a key.
- EasyTier 2.6.4 is downloaded and **SHA-256 verified** by the plugin, Secure Mode with a
  persisted X25519 identity, RPC pinned to `127.0.0.1`.

See [plugin/README.md](plugin/README.md) for install, configuration, operations and limits, and
[`docs/validation/2026-10-30-plugin-phase3.md`](docs/validation/2026-10-30-plugin-phase3.md) for
the test matrix and evidence.

The older [Phase 0 prototype](prototype/phase0/README.md) is archived as a working experimental slice, **not the target architecture**. It contains an independent HTTP admission/charging proxy which should not be carried forward without evidence.

## Security

No keys, mnemonic phrases, real Gateway Keys, EasyTier network secrets, RPC credentials, personal records or payment databases in Git. A GitHub repository may be public. Wallet and payment code must stay on testnet until authenticated networking, quota semantics and double-credit protection are verified.
