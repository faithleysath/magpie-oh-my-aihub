# Phase-4 lab — three isolated Magpie instances

A local, disposable end-to-end lab. It creates three (and a fourth for the migration check)
isolated Magpie 0.1.2038 instances with their own `HOME`/`XDG_CONFIG_HOME`, three real plugin
hosts, one real EasyTier 2.6.4 overlay, three OpenAI-compatible mock upstreams and a fourth
provider whose `state.json` is a phase-3 document.

```sh
# Needs: macOS with Magpie 0.1.2038 installed (or MAGPIE_BIN=…), Bun 1.4.3.
# The first run downloads the pinned EasyTier release and caches it under /tmp.
bun docs/validation/lab/phase4/lab.ts            # 24 steps, writes ../phase4-lab-report.json
bun docs/validation/lab/phase4/lab.ts --keep     # keep /tmp/ohmyaihub-phase4-<pid> for inspection
```

What it does:

| File | Role |
| --- | --- |
| `lab.ts` | orchestration, assertions, report |
| `host.ts` | boots `plugin/src/index.ts` exactly as Magpie does (cwd = the instance's Magpie config dir) |
| `mock-upstream.ts` | OpenAI-compatible mock with `/v1/chat/completions` (streaming), `/v1/responses`, `/v1/messages` and a request counter |

Ports are chosen at random from free ones (checked on loopback and on the LAN address), so the lab
can be re-run next to a real Magpie. The gateway of each instance binds the host's LAN address:
Magpie treats loopback as local, so a loopback-bound gateway would never require a key and the
whole test would be meaningless.

The lab is **not** run in CI: it needs a real Magpie desktop binary. CI runs the unit suite
(`plugin/`), the boot check and the secret scan. See
[`../2026-10-29-phase4-multi-role-multi-provider.md`](../2026-10-29-phase4-multi-role-multi-provider.md)
for the measured results and the limits of a single-host lab.
