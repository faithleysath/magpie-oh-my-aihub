# Isolated local chain and disposable external wallet fixture

This is a **test-only maintainer fixture**, outside the product package and console origin. Every actor page says **“本地模拟链，仅复用 chainId；未连接公链，未付款”**. Chain IDs 97 and 84532 identify two independent local simulations; they are not connections to BSC or Base, public payments, token deployments, explorer confirmations or consensus evidence.

The fixture replaces only chain RPC and the external signer. The acceptance provider must still run the actual plugin Wallet, ChainWatcher, ChainStore, Ledger, Provisioner, native Magpie Gateway Key and EasyTier/Remote Magpie path. This code never reads or edits their files and has no product API client, FakeMagpie, injected credit sink, manual credit action or transaction broadcast method.

The latest Stage3 assignment prefers a synthetic unfunded scalar in the fixture process. That instruction supersedes the earlier browser-scalar/bundling proposal in `STAGE3-acceptance.md`: here a random valid secp256k1 scalar exists only in `SyntheticSigner` process memory, is never returned to the browser, persisted or logged, and is discarded by reset, authenticated logout, stop and a 10-minute signing-idle deadline. Reset also discards the public account identity. Browser pagehide clears its imported document/signature references; it does not promise delivery of a server reset. Reloading can resume the same temporary account until reset/idle/fixture restart. This is test-only non-audited signing using the existing test helper with an explicit random scalar; no real wallet, funds or public-chain use is authorized.

Preparation delivered on Darwin 25.6.0 arm64 / Bun 1.4.3. Automated tests use disposable `/tmp` directories/listeners and clean them in `finally`. **No persistent actor fixture or existing Magpie lab is started or changed by preparing these files. Parent owns later start/browser/cleanup.**

## Start and stop, after parent chooses the private directory

Use the already available Bun runtime; no framework, extra wallet SDK, extension, browser bundle or dependency installation is needed:

```sh
bun docs/validation/lab/phase9/wallet-fixture/server.ts start /absolute/private/fixture-directory
bun docs/validation/lab/phase9/wallet-fixture/server.ts stop /absolute/private/fixture-directory/runtime.json
```

Run `start` as a managed background task, not a product-user instruction. Its only stdout is the absolute `runtime.json` path. Startup errors emit one fixed message without paths, URLs or secrets. SIGINT/SIGTERM also perform cleanup. `stop` reads a private maintainer capability from that file and prints only the same path; it neither signals an arbitrary PID nor invokes a product operation. After stop the listener is closed, runtime file removed and process lock released; durable chain state is retained for restart tests.

The 0600 `runtime.json` in the 0700 chosen directory contains the private one-use `launchUrl`, loopback RPC URLs, PID, state path and stop capability. Open the launch URL only in the parent-owned browser space; never put this file/content/URL in committed evidence, logs or product snapshots. Launch tickets expire after two minutes. If not used in time, stop/restart the fixture and read its new runtime file; persisted events survive and the synthetic signing key does not. No anonymous pairing or credential minting route is enabled. Product tokens are never accepted.

There must be one fixture owner for a directory. The existing kernel-backed exclusive host-lock helper enforces this without lock stealing. The listener binds only `127.0.0.1` on an ephemeral port. UI control routes reuse production console Host/Origin/request-header/session/CSRF/UUID protection and fixed no-store CSP assets. Signature review/sign responses use sensitive one-owner UUID tombstones; they are not retained in response cache. Read-only `/rpc/97` and `/rpc/84532` accept native production EvmClient calls without an Origin but reject cross-origin/browser metadata, arbitrary Host, batches, non-JSON, compressed and over-64KiB bodies. There is no CORS permission.

## Actor workflow

1. Open the private fixture launch URL. Generate a disposable unfunded account; only its public payer address appears.
2. Use production wallet forms to configure the two explicit local RPC URLs and register the fixture tokens. The authenticated fixture state lists fresh random contract addresses, symbols `tFIX6`/`tFIX18`, names `Local Fixture Mock6`/`Local Fixture Mock18`, decimals 6/18 and the explicit existing fixed test rate of 1,000,000,000 nanoUSD per token. Neither network has default selection in the fixture controls. Keep public RPC fallbacks out of this local run.
3. Create the real intent in the production console, download `ohmyaihub.deposit-request/v1`, import it in the external fixture page. Review the entire production wrapper, typed fields and digest; check consent and click Sign. The fixture requires exact production DEPOSIT_TYPES/domain, both matching chain fields, wrapper/typed-message identity, raw/display amount equality, recipient/token identity and an unexpired lifetime. It never signs an arbitrary hidden digest.
4. Downloaded signature is exactly `{schema:'ohmyaihub.deposit-signature/v1',invoiceId,payerAddress,signature}`. Import it in the production provider console, where production recovery must prove attribution. Then download the production `ohmyaihub.transfer-instructions/v1` file.
5. Import those exact instructions in the separate fixture page and check the synthetic-event consent. The button **“在新块生成模拟 Transfer”** creates one synthetic log and successful receipt in a newly mined block above the existing head. It does not send a transaction or pay anyone. A stable event-operation UUID is persisted with the result before replying; the explicit repeat button returns the same event even after fixture restart, never adds another log.
6. First observe the event through the production watcher/console. Only then advance head depth: initial production lookback is five blocks. Chain 97 retains the production 15-block policy. Advancing head on 84532 leaves finalized unchanged until the separate explicit Finalize button; production `finalized-tag` policy remains unchanged. Blocks use current wallclock timestamps. Invoice attribution still follows the production watcher's wallclock, not an invented block-time rule.
7. Follow production chain→ledger→native cap/readback/accounting evidence and then the real Remote Magpie model call. Receipt existence by itself proves none of those results. Wrong amount/sender/token/other-chain variants generate clearly labelled negative events. Independent controls expose wrong chain ID, wrong decimals, log errors, RPC503 and missing/null/503 receipt responses. These are synthetic failures, never public-chain findings.

Only six methods exist: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_getTransactionReceipt`, `eth_call` for the one registered token's `decimals()` selector. Unsupported methods return JSON-RPC `-32601`. Logs filter contract, range and every supplied topic; receipts match their event/block. No balances, nonce, gas, mempool, `eth_sendRawTransaction` or provider admin proxy.

## Durability, limits and evidence

Chain state is atomic fsync/rename JSON in 0600 `chain-state.json`, under the chosen 0700 directory. Both chains' blocks/events/finality/error flags and consumed control UUID/results survive restart. A corrupt/oversized/inconsistent store fails startup; no `.prev` fallback can revive consumed operations. Writes reserve a cloned next state, validate before changes and publish only after durable save. An uncertain save failure closes that model to further mutations.

Limits: 4096 blocks per chain, 256 event transactions per chain, 512 durable control operations across both chains, 4MiB chain store, 64KiB HTTP body, 48KiB browser file import. No valid control operation is evicted to make a spent UUID replayable. At a cap, finish the acceptance scope or deliberately choose a fresh isolated fixture directory; never delete this run's uncertain state to retry a business action.

`source-manifest.json` contains only source/crypto hashes, Bun/platform/architecture and the process-signing evidence boundary. The authenticated Download Evidence button and stop-time `fixture-evidence.json` contain only the simulation label, explicit fixture contracts, head/finality, synthetic event summaries, operation count and RPC method counts for this process. No scalar, signature, CSRF, cookie, ticket or maintainer capability enters these evidence files. Runtime/state files remain private; inspect/sanitize any chosen evidence before committing. There is no browser crypto bundle in this process-memory design.

Run tests/typecheck without starting the actor fixture:

```sh
bun test docs/validation/lab/phase9/wallet-fixture/fixture.test.ts
cd plugin
bunx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --types bun ../docs/validation/lab/phase9/wallet-fixture/*.ts
```

Historical public-chain evidence remains distinct: `docs/validation/2026-10-30-fresh-twohost-wallet.md` documents prior fresh public BSC/Base payments, and `docs/validation/2026-10-30-live-magpie-chain-credit.md` documents replay of original payments. This fixture does not upgrade either history into a new payment claim. Real Stage3 browser, production watcher/native cap and model-call acceptance remain **UNKNOWN until the parent runs and records them**.
