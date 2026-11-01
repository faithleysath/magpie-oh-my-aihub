# Local AI development contract

1. Treat `ARCHITECTURE.md` as the current product and architecture decision; `plugin/page/doc.md` is the user manual. The remaining verification work is listed in `ARCHITECTURE.md` → 验证.
2. Study the **pinned installed versions and actual source** of Magpie and EasyTier; provide links, commit SHAs, reproducible commands, raw sanitized responses, and platform information. Do not assume previous model claims are true.
3. Remote Gateway Key enforcement through EasyTier no-TUN and dynamic cost limit semantics remain the highest-risk integration points; verify them before changing them. Do not build new features on unverified assumptions.
4. Do not revive the pre-v2 prototype's duplicate admission or pricing logic; it is deprecated and deleted.
5. No DHT, mDNS, new routing algorithm, centralized intermediary API server, C2C fiat trading or token issuance.
6. Avoid changes to upstream Magpie/EasyTier until minimal integration is measured. Never expose the Magpie administrative interface, regardless of VPN membership.
7. Never use real crypto assets or hot wallet secrets in experiments. Base Sepolia only for future wallet tests.
8. Output each finding with VERIFIED / REPRODUCED / UNKNOWN, exact platform and source/version, and test logs or failures. Make a small branch/PR for each subsequent implementation task, avoid broad speculative rewrites.
9. The plugin page is built from `plugin/page/doc.md`. Before committing, run `cd plugin && bun run typecheck && bun run build:page`.
