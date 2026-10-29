# Local AI development contract

1. Treat docs/ARCHITECTURE.md as the current product decision and docs/VALIDATION.md as the first task.
2. Study the **pinned installed versions and actual source** of Magpie and EasyTier; provide links, commit SHAs, reproducible commands, raw sanitized responses, and platform information. Do not assume previous model claims are true.
3. First verify remote Gateway Key enforcement through EasyTier no-TUN and dynamic cost limit semantics. No code development is authorized in the first verification task beyond minimal disposable experiments.
4. Do not reuse prototype/phase0/p2pshare/server.py as production; its duplicate admission and pricing logic is deprecated.
5. No DHT, mDNS, new routing algorithm, centralized intermediary API server, C2C fiat trading or token issuance.
6. Avoid changes to upstream Magpie/EasyTier until minimal integration is measured. Never expose the Magpie administrative interface, regardless of VPN membership.
7. Never use real crypto assets or hot wallet secrets in experiments. Base Sepolia only for future wallet tests.
8. Output each finding with VERIFIED / REPRODUCED / UNKNOWN, exact platform and source/version, and test logs or failures. Make a small branch/PR for each subsequent implementation task, avoid broad speculative rewrites.
