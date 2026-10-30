# Real-testnet payment replay into real Magpie — isolated lab

This is a **validation harness**, not a plugin feature. It uses production `Wallet`, `ChainWatcher`, `ChainStore`, `Ledger`, `Provisioner` and `Magpie` classes without modifications.

## Precisely what is real

- The original BSC/Base testnet transfers, public RPC reads, logs, receipts and finality checks.
- The original pre-payment invoice fields, wallet signer and EIP-712 digest (re-signed offline by the same disposable wallet).
- SQLite ledger deposits, Magpie CLI cap writes and native HTTP read-back.
- The pinned Magpie binary's authentication, cost accounting and HTTP 200/429 responses.

## What is not claimed

- A new transfer initiated after the Gateway Key was provisioned: this replays existing finalized transfers into a **fresh isolated ledger**.
- A paid vendor/model execution: the upstream is the deterministic local `../phase6/mock_upstream.py`.
- A new EasyTier or second-host test: loopback with a forwarding header exercises Magpie's remote-key branch; the listener never leaves loopback.
- Mainnet safety, real stablecoin pricing or a live user account. The $0.0001 opening credit is explicitly simulated, spent before either chain credit is applied.

The sequence is:

```
opening 0.0001 test USD -> 200 -> spent -> 429
original finalized BSC payment -> Ledger -> SAME Gateway Key -> 200 -> spent -> 429
original finalized Base payment -> Ledger -> SAME Gateway Key -> 200
```

Each chain is rescanned and must add zero further credits; the original key ID and secret must remain unchanged. The other network's RPC is pointed at a closed loopback port while each chain is scanned independently. This tests manual-scan independence, not latency of a scheduled concurrent outage.

## Prerequisites

- macOS arm64, Bun 1.4.3 and pinned Foundry 1.8.6.
- Portable Magpie **0.1.2038**, revision `8c63c5b7873c6aa7aa797aa17f481d5fa8301876`. The currently installed application may be newer; do not silently substitute it.
- A **new** private temporary directory `/tmp/phase7-live-magpie-*`, containing a copied `Magpie.app`, `.portable`, empty `data/`, isolated `home/`. Do not copy user configuration or credentials.
- Original ChainStore files from the two real testnet runs, or their explicitly prepared local copies; original one-hour intent expiry is enforced, not bypassed. Running this exact replay after expiry may refuse attribution and must not be reported as a pass.
- The original disposable **consumer** key file, outside the repo, mode 0600. Never use a real wallet.

The harness resolves the signing binary **before** changing HOME. Calling `mise x foundry` after replacing HOME caused a 15-second signing timeout in the first attempt; a direct, version-checked `LAB_CAST_BIN` avoids that configuration dependency.

## Setup

See `../phase6/README.md` for portable mode and deterministic upstream details. For this experiment use unused ports **3447** and **19081**, not the user's normal gateway.

In the isolated `settings.json`, set `lan: true` (remote-key branch enabled) and `noAccountDiscovery: true`, while pinning `MAGPIE_ADDR=127.0.0.1:3447`. Do not run `magpie web` or expose `/api/*`.

```sh
python3 docs/validation/lab/phase6/mock_upstream.py 19081

# In another supervised terminal; $LAB must be the new disposable lab.
HOME="$LAB/home" MAGPIE_NO_ACCOUNTS=1 MAGPIE_ADDR=127.0.0.1:3447 \
  "$LAB/Magpie.app/Contents/MacOS/magpie" provider add labmock \
  url=http://127.0.0.1:19081/v1 key=sk-lab models=lab-model id=labmock
HOME="$LAB/home" MAGPIE_NO_ACCOUNTS=1 \
  "$LAB/Magpie.app/Contents/MacOS/magpie" model price labmock/lab-model 1,2,0,0
HOME="$LAB/home" MAGPIE_NO_ACCOUNTS=1 MAGPIE_ADDR=127.0.0.1:3447 MAGPIE_TRUST_PROXY=0 \
  "$LAB/Magpie.app/Contents/MacOS/magpie" serve
```

`LAB_INPUTS` is a local JSON array (not secrets):

```json
[
  {"chainId":97,"txHash":"<original-payment-hash>","storePath":"<original-BSC-chain.sqlite>","invoiceId":"<original-invoice>"},
  {"chainId":84532,"txHash":"<original-payment-hash>","storePath":"<original-Base-chain.sqlite>","invoiceId":"<original-invoice>"}
]
```

```sh
CAST_BIN="$(mise which cast)"
HOME="$LAB/home" MAGPIE_NO_ACCOUNTS=1 \
MAGPIE_DATA="$LAB/data" MAGPIE_BIN="$LAB/Magpie.app/Contents/MacOS/magpie" \
MAGPIE_ADDR=127.0.0.1:3447 LAB_INPUTS="$LAB/inputs.json" \
LAB_CAST_BIN="$CAST_BIN" LAB_CONSUMER_KEY_FILE=<throwaway-consumer-key-file> \
LAB_REPORT="$LAB/live-credit-report.json" \
bun docs/validation/lab/phase7/live-credit.ts
```

No chain transaction is sent by this script. The original signed invoices are imported into an empty ChainStore and reverified, without creating fictitious new invoices for old payments. An explicit 20,000-block first-scan lookback includes the existing transfers; a brand-new store does not claim its `rewindCursor` was a completed historical scan.

The report never prints the Gateway Key or private key. It records sanitized native HTTP bodies, public chain events and applied ledger deposits. `finally` revokes the lab key; stop only the supervised gateway/mock processes you started, preserve the private temporary state for audit, and run `secret-scan` before copying public evidence into git.

## Typecheck

The docs harness is included in the plugin's TypeScript check and its path triggers CI on pull requests. It is not executed by CI (which has no disposable wallet or running portable Magpie). You can also typecheck it explicitly:

```sh
cd plugin
bun x tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
  --types bun --strict --skipLibCheck --allowImportingTsExtensions \
  ../docs/validation/lab/phase7/live-credit.ts
bun run ci
```

## Fresh two-host acceptance

The subsequent [two-host lab](TWOHOST.md) creates new signed intents and sends new BSC/Base testnet payments while the production watchers run. It uses a real native Remote Magpie on an independent consumer host and the corrected EasyTier no-TUN ingress. See the [separate report](../../2026-10-30-fresh-twohost-wallet.md); the replay-only claims above continue to describe `live-credit.ts`.
