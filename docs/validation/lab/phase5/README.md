# Phase-5 lab — three peers, one real overlay, one read-only catalogue each

```sh
# Needs Magpie 0.1.2038 (or MAGPIE_BIN=…), Bun 1.4.3, macOS.
bun docs/validation/lab/phase5/lab.ts            # 11 steps, writes ../phase5-lab-report.json
bun docs/validation/lab/phase5/lab.ts --keep     # keep /tmp/ohmyaihub-phase5-<pid>
```

A is a consumer with discovery; B and C share and publish. The lab boots three isolated Magpie
instances (own `HOME`/`XDG_CONFIG_HOME`), three real plugin hosts, one real EasyTier 2.6.4 no-TUN
overlay, and the real CLI/API. B and C publish on different catalogue ports because all three
instances share one LAN address; a real three-machine deployment uses the default 3426.

It reuses the phase-4 mock upstream and host entry (`../phase4/mock-upstream.ts`,
`../phase4/host.ts`). It is not run in CI: it needs a real Magpie desktop binary. CI runs the unit
suite, boot-check and secret scan; the measured run and its limits are in
[`../../2026-10-30-phase5-peer-catalog.md`](../../2026-10-30-phase5-peer-catalog.md).
