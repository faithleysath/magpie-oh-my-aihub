# Magpie Oh My AI Hub

A private-community P2P AI API sharing project based on Magpie, EasyTier no-TUN networking, and wallet-funded Gateway Key quotas.

**Status: research/prototype only. Not ready for deployment or real payments.**

## Current planned division of responsibilities

- **Magpie**: upstream providers, Remote Magpie, routing, Gateway Key authentication, quotas, usage accounting and model forwarding.
- **EasyTier**: private peer transport, discovery via Peer list, encrypted no-TUN networking and targeted port forwarding.
- **Plugin/local helper**: service catalog, peer-wallet binding, verified chain deposits, mapping prepaid funds to cumulative Gateway Key limits, reconciliation, automatic top-up, wallet safety and address book.
- **HK VPS**: EasyTier bootstrap/relay only. No centralized business server.

Do **not** implement a second AI API proxy, token router or charging gateway unless real integration tests demonstrate a hard security/compatibility limit in the native path.

Read [architecture](docs/ARCHITECTURE.md), [verification tasks](docs/VALIDATION.md), and [agent instructions](AGENTS.md).

The older [Phase 0 prototype](prototype/phase0/README.md) is archived as a working experimental slice, **not the target architecture**. It contains an independent HTTP admission/charging proxy which should not be carried forward without evidence.

## Security

No keys, mnemonic phrases, real Gateway Keys, EasyTier network secrets, RPC credentials, personal records or payment databases in Git. A GitHub repository may be public. Wallet and payment code must stay on testnet until authenticated networking, quota semantics and double-credit protection are verified.
