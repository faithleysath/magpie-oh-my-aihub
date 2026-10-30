# Phase-8 real two-Magpie journey

This is maintainer evidence, not a user instruction. It runs the shipped operator CLI against
**real, fully isolated Magpie 0.1.2038 profiles** on one machine, with a real EasyTier 2.6.4 no-TUN
overlay, real native Remote Magpie registrations, real plugin hosts started by Magpie itself, and a
deterministic local mock upstream. It does not use a vendor, a paid model, a public payment, a
private key, or the operator's installed Magpie data directory.

Every node gets its own copy of the Magpie app bundle and its own copy of the plugin package. The
plugin writes `page/status.js` and `page/options.js` under its package directory, so sharing one
plugin folder between nodes would make the page evidence meaningless. The journey uses Magpie's own
`plugin add` + `serve` path; it does not import the plugin or boot a host from the repository.

## Prerequisites

- macOS arm64 (the measured platform) with Bun 1.4.3.
- A Magpie **0.1.2038** app bundle. The script verifies `magpie --version` before running and refuses
  any other version. It copies the bundle per node; it never runs the source path in place.
- A verified EasyTier **2.6.4** `easytier-core`/`easytier-cli` pair. The script seeds the plugin's
  pinned cache from `EASYTIER_CACHE` and the plugin re-hashes both binaries before running. If the
  cache is absent, the plugin would download and verify the pinned release (network required).
- Free ports; the script checks both loopback and the LAN address and allocates its own gateway,
  mock-upstream, EasyTier-listen and catalogue-window ports.
- Network access to the public BSC testnet and Base Sepolia RPC endpoints for the **read-only**
  wallet typed-data step. No transaction is sent.

## Run

```sh
cd /path/to/magpie-oh-my-aihub-import

# optional:
# export MAGPIE_APP="$HOME/Projects/lab/magpie-iso/Magpie.app"
# export EASYTIER_CACHE="$HOME/Projects/lab/et/easytier-macos-aarch64"
# export PHASE8_LAB_DIR="/tmp/my-phase8-lab"
# export PHASE8_EVIDENCE_DIR="$PWD/docs/validation/phase8-live"

bun docs/validation/lab/phase8/journey.ts
bun docs/validation/lab/phase8/journey.ts --keep                    # keep the lab root for diagnosis
bun docs/validation/lab/phase8/journey.ts --no-second-provider     # skip the P2 fault-isolation step
bun docs/validation/lab/phase8/journey.ts --no-wallet              # skip the testnet typed-data step
```

The run takes about two minutes on the measured host. It prints one `PASS`/`FAIL` line per step and
writes only sanitized evidence:

- `docs/validation/phase8-live/lab-report.json` — steps, HTTP status lines, environment, wallet
  typed-data digests, cleanup and claims.
- `docs/validation/phase8-live/transcript.log` — sanitized command/output transcript (0600).
- `docs/validation/phase8-live/source-manifest.json` — SHA-256 of the exact per-node copies of
  `service.ts`, `provisioner.ts`, `server.ts`, `catalog.ts`, `walletview.ts`, `wallet.ts`,
  `bin/ohmyaihub.ts`, `operator-*.ts` and `wallet-wizard.ts`, compared with the repo at report time.
- `docs/validation/phase8-live/cleanup.json` — owned PIDs before/after, every lab port and whether it
  is free after the run.
- `docs/validation/phase8-live/lab-report-attempt1-*.json`, `attempt2-*.json` — preserved failed
  attempts and their sanitized transcripts. They are failures of the harness configuration, not
  product successes.

The evidence directory must never receive raw state: `state.json`, `caller-keys.json`,
`provider-keys.json`, the overlay secret, API tokens and Gateway Keys stay in the disposable
`/tmp` root. The script redacts known secrets and key-shaped strings; it does not copy those files.

## What the run covers

1. Two fresh Magpie gateways enforce a key; each has its own plugin copy.
2. Provider `setup`, `share setup --all-priced --publish`, and a real signed catalogue.
3. Consumer `setup`, discovery in a five-port catalogue window, full TOFU fingerprint/quote display.
4. Unverified and wrong-fingerprint refusal; exact fingerprint acceptance; structured 0600 request.
5. Provider `share approve --cap 0.0001 --yes`; stale-hash request refused with no key; 0600 handover.
6. Consumer `connect --key-file --id peer-p --fingerprint --quote`; `remote test|models`.
7. A real consumer-Magpie → Remote Magpie → provider-Magpie call: **200 → native 429 → `topup` → 200**,
   with the mock upstream count proving one request crossed the overlay each time.
8. Provider gateway probes: no key 401, wrong key 401, handed key 200.
9. Repeated `setup` leaves the same `nodeId`/`instanceId`/mapped CIDR/secure identity; restart recovers
   the same identity, provider and a 200 call.
10. `consume off` keeps a hand-made provider, removes only the plugin-owned one; `consume on` restores it.
11. Optional second provider P2: independent identity/key/overlay; targeted `remote test` keeps peer-p
    healthy while peer-p2 degrades; `remote remove peer-p2` leaves peer-p connected.
12. Wallet wizard on chain 97 and 84532 with `--batch` produces real EIP-712 typed data, stops at
    `AWAITING SIGNATURE`, and both intents are cancelled. No signature, transfer, scan or chain write is
    performed. Test-asset registration reads `decimals()` from the public RPC read-only.

## What it does not cover / UNKNOWN

- Magpie 0.1.2120/0.1.2157 host/CLI compatibility. The run is pinned to 0.1.2038.
- Linux GUI/provider behaviour and Windows. The measured phase-7 Linux consumer container is separate.
- A real vendor/paid model. The upstream is a deterministic local mock; no vendor request leaves the host.
- A public testnet payment. The wallet step stops before a signature; the prior PR #11 BSC/Base payment
  evidence is cited, not repeated.
- Browser/page rendering and CSP. That is the UI owner's separate evidence.
- Real-money production. The price-lock, oversell, interrupted-call and RPC-trust blockers are unchanged.

## Cleanup

Without `--keep`, the `finally` block stops every process whose command names the lab root, kills the
per-node mock upstreams, waits, checks every allocated gateway/upstream/listen/catalogue/SOCKS port on
both loopback and the LAN address, deletes the lab root, and records the owned-PID list, remaining
processes and port-free map in `cleanup.json`. With `--keep`, the root is printed and the same map is
recorded; the root contains live secrets until deleted, so do not copy it into the repository.
