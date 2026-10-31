# Phase 10 A-share/B-P2P closure — index

- [REPORT.md](REPORT.md) — what was integrated, the real two-node run, F3/F4/F5 root causes and
  fixes, B runtime findings, quality gates, boundaries and cleanup.
- [evidence/](evidence/) — sanitized lab manifest, cleanup proof, gateway call bodies
  (200/429/401), screenshots (network live, network stopped/last-known, control-only neighbour,
  consumer sharing), SHA-256 sums.

The short version: on two fresh portable Magpie 0.1.2289 + EasyTier 2.6.4 no-TUN nodes (one host,
loopback/LAN, not WAN), the real UI drove three-field join, one explicit share, zero-file request,
manual approval, encrypted delivery, automatic native Remote registration, model 200 → 429, revoke
→ 401, stop-share with the core still running and a 35 s catalogue withdrawal, a stopped core with
last-known facts, and an unshared node's signed control-only presence. `bun test` 1195/0,
typecheck/secret-scan/boot-check PASS. Wallet/mainnet (C/D) are out of scope here.
