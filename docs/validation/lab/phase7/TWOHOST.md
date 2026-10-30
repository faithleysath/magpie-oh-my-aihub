# Two-host fresh-payment lab

This is a disposable acceptance harness. It uses the production wallet and accounting modules directly, a real portable provider Magpie, and a native consumer Remote Magpie on a second host. It is not a deployment script. The [report](../../2026-10-30-fresh-twohost-wallet.md) records the measured addresses, versions, new transaction hashes and evidence boundaries.

## Fixed versions

- Bun 1.4.3.
- Provider: Magpie 0.1.2038, revision `8c63c5b7873c6aa7aa797aa17f481d5fa8301876`.
- Consumer: `ghcr.io/yetone/magpie@sha256:900711e2867299e6dbc7d9b02112e86d0a00add626f61bacfad83be0da5fbe5e` (`magpie v0.1.2057`).
- EasyTier 2.6.4, revision `8428a89d2dabc94c97d370ec607c6ca142473626`. Verify both platform zips against `plugin/src/easytier-manifest.ts` before extracting.
- Foundry 1.8.6, revision `6bad0a66de7c83f7b33695044138f0f5fa4c5990`.

The run used `/tmp/phase7-twohost-wallet` on the provider and `/tmp/phase7-twohost-network` on both hosts. Preserve an earlier lab for audit and choose a new `/tmp/phase7-twohost-wallet-*` directory for another run; never point the harness at an installed Magpie profile. Example commands below use the recorded run's paths. Obtain testnet-only gas independently before broadcasting.

## Provider bootstrap

Use an independently verified portable copy of the pinned app, with empty `data/` and `home/` directories and a `.portable` marker at the lab root. The release can be fetched with:

```sh
gh release download v0.1.2038 --repo yetone/magpie \
  --pattern magpie-darwin-arm64.zip --pattern SHA256SUMS --dir <temporary-download-dir>
```

Verify the archive against the release checksum, extract into the disposable lab, and confirm the executable with `go version -m`. Do not copy a newer installed application and label it 0.1.2038.

Set the isolated `data/settings.json` to `{"lan":true,"noAccountDiscovery":true}`. Start the existing local non-billable mock on `127.0.0.1:19082`:

```sh
python3 -I docs/validation/lab/phase6/mock_upstream.py 19082
```

For every provider CLI/gateway process, use these **process-local** environment values:

```text
HOME=/tmp/phase7-twohost-wallet/home
MAGPIE_NO_ACCOUNTS=1
MAGPIE_ADDR=192.168.132.218:3448
MAGPIE_ALLOW_IPS=192.168.132.218/32
MAGPIE_TRUST_PROXY=0
```

Use `env HOME=... MAGPIE_ADDR=... ... <binary> ...`, without changing the operator's shell HOME. Create the local provider and prices, then start `serve`:

```text
<lab>/Magpie.app/Contents/MacOS/magpie provider add labmock url=http://127.0.0.1:19082/v1 key=sk-lab models=lab-model id=labmock
<lab>/Magpie.app/Contents/MacOS/magpie model price labmock/lab-model 1,2,0,0
<lab>/Magpie.app/Contents/MacOS/magpie serve
```

`sk-lab` is an unusable mock placeholder, never a vendor credential. Run only `serve`; do not start `magpie web`.

## Overlay and native consumer

Use the [existing corrected provider ACL template](../provider-acl.toml). The recorded run used:

```text
B provider virtual: 10.78.0.1
B export: 192.168.132.218/32 -> 10.66.137.8/32
B Forward: default Drop, allow only TCP 3448
B Inbound: default Drop, no allow rules
B listener: none; peer tcp://<consumer-host>:11078
B RPC launch argument: -r 127.0.0.1:15897

A consumer virtual: 10.78.0.2
A listener: tcp://0.0.0.0:11078
A Inbound and Forward: default Drop, no allow rules
A forward: tcp 127.0.0.1:13448 -> 10.66.137.8:3448
A RPC launch argument: -r 127.0.0.1:15898
Both: no_tun=true, disable_udp_hole_punching=true
```

Both TOMLs use the same freshly generated private `network_identity`. Keep them 0600 and do not print the raw EasyTier startup log, which echoes that identity. The run temporarily allowed only `11078/tcp` in A's existing UFW configuration and removed that exact rule during cleanup. No system route, TUN or global firewall policy was changed.

Run the consumer's pinned image with host networking, `MAGPIE_ADDR=127.0.0.1:3449`, `MAGPIE_NO_ACCOUNTS=1`, and a fresh isolated configuration volume. The image runs as UID/GID 65532; the volume must be writable by that user. Verify `docker exec phase7-consumer-magpie /magpie --version` and the actual socket listeners.

Start only the two lab cores:

```text
<mac-easytier-core> -c /tmp/phase7-twohost-network/provider.toml -r 127.0.0.1:15897
ssh us-west-vps '<linux-easytier-core> -c /tmp/phase7-twohost-network/consumer.toml -r 127.0.0.1:15898'
```

Before issuing any AI call, verify the mapped gateway refuses no key and a wrong key with 401. Provider virtual IP access must time out. Do not continue on an authentication bypass.

## Sign before paying, then use automatic watchers

Import the disposable consumer wallet into an **encrypted** Foundry keystore interactively. Do not put the private key or keystore password in command arguments:

```text
cast wallet import consumer -i --keystore-dir /tmp/phase7-twohost-wallet/keystores
```

Write its password to a separate 0600 `<lab>/keystore-password`, outside git. The harness invokes `--keystore <path> --password-file <path>`. The funded wallet used in the measured run was a previously created throwaway testnet account; no personal/hot-wallet key was used.

Create `<lab>/assets.json` with public inputs. The contracts must be the test-only `MockERC20` deployment, with unrestricted `mint`, on these testnets. `prepare` verifies the RPC chain and actual `decimals()`:

```json
[
  {"chainId":97,"token":"<existing-mock-6-decimal-contract>","decimals":6,"recipient":"<provider-test-address>"},
  {"chainId":84532,"token":"<existing-mock-18-decimal-contract>","decimals":18,"recipient":"<provider-test-address>"}
]
```

The measured inputs are in the public evidence `assets.json`. Copying those inputs does **not** import a historical invoice or payment. `prepare` always creates new invoices/nonces and signs the actual original typed documents before a transaction. No previous SQLite store is needed.

Run from the repository with `LAB_ROOT=<lab>` and `LAB_CAST_BIN=<pinned-cast>`. Set `LAB_GATEWAY_ADDR` if B's own address differs; default is the measured address. Set `LAB_GATEWAY_KEY_FILE` if changing the local private key handoff path. `LAB_ASSETS` can override `<lab>/assets.json`.

```sh
bun docs/validation/lab/phase7/fresh-twohost.ts init
bun docs/validation/lab/phase7/fresh-twohost.ts prepare
bun docs/validation/lab/phase7/fresh-twohost.ts watch
```

`init` creates the explicitly simulated $0.0001 opening credit, one scoped key and a 3650-day native cap. The secret handoff is a 0600 file, not stdout. On A, register one native Remote Magpie id `twohost-provider`, URL `http://127.0.0.1:13448`, using that secret; verify the model `twohost-provider/labmock/lab-model` is discovered. The measured pinned CLI has no secret-from-stdin option. The run used a placeholder CLI record followed by replacement of only that record's key while the **isolated consumer container was stopped**, then restart/`provider refresh`; it never edited an installed consumer profile. The retained helper is [register-twohost-consumer.py](register-twohost-consumer.py).

The watcher starts the production `Wallet.start()` timers. It must be running before the new payments. The sequence below uses [twohost-call.py](twohost-call.py) on A; it never reads a key and does not add forwarding headers:

```text
A: python3 twohost-call.py 100 0 200              # consumes opening $0.0001
B: bun fresh-twohost.ts snapshot                 # confirms native usage and settlement
A: python3 twohost-call.py 1000 100 429           # BEFORE new payment
B: bun fresh-twohost.ts pay 97                   # new mint + new payment
B: bun fresh-twohost.ts pay 84532                # new mint + new payment; await real finality
A: python3 twohost-call.py 1000000 0 200          # only AFTER automatic BSC credit
B: bun fresh-twohost.ts snapshot
A: python3 twohost-call.py 1000 100 429
```

Use the full script paths from the previous examples. Both real transaction attempts have a pre-broadcast marker with nonce; a successful asynchronous broadcast saves its hash, then a successful raw receipt is required. Any attempt marker blocks rerunning `pay`, even if the earlier subprocess timed out. Reconcile on-chain state and the nonce instead of deleting a marker and resending.

Before Base finalizes, preserve `watch-status.json` as `before-restart-watch.json`; verify BSC is `credited` and Base `confirming`. Gracefully stop the watcher, allow any RPC in flight to finish, restart B's **isolated** `serve`, restart A's **isolated** container, then start `watch` again against the same SQLite files. Save old/new owned process IDs as `restart.json`. Confirm A still returns 429; do not re-run `init`, `prepare` or `pay`.

When `watch-status.json` shows the Base event as `credited`, call A once more:

```text
A: python3 twohost-call.py 1000 100 200
```

There is no manual cap edit or forced finality. A successful receipt alone is not a Base credit. A finite finality wait that expires reports UNKNOWN and leaves the same payment available for read-only continuation.

## Duplicate scans and read-only audit

Stop the watch process gracefully before deliberate rescans to avoid two scanners competing for one chain. With both original payments already credited:

```sh
bun docs/validation/lab/phase7/fresh-twohost.ts rescan
```

This rewinds each local scan cursor to before the run's first event; each scan must add zero credits and leave the cap unchanged. It records a new snapshot and leaves the deposits intact.

Copy A's `acceptance-calls.jsonl` into the private lab directory, retain the original key handoff until the audit completes, and run:

```sh
bun docs/validation/lab/phase7/twohost-audit.ts
```

The audit fails unless the six HTTP results are `200,429,200,429,429,200`, both original signatures verify, exactly two new payment events credit, both mint logs stay uncredited, both duplicate scans add zero, the key ID/secret/window stay the same, and SQLite holds exactly three applied deposits plus three priced consumption rows. Expected totals are $2.0001 deposited, $1.0013 consumed, and $0.9988 remaining.

## Cleanup

Audit **before** revoking, so it can prove the key stayed the same. Then:

```sh
bun docs/validation/lab/phase7/fresh-twohost.ts revoke
```

Use only the saved PIDs belonging to this run to stop the mock, provider gateway and local EasyTier. On A, remove only `phase7-consumer-magpie`, terminate only the saved consumer EasyTier PID, and remove the temporary `11078/tcp` UFW rule. Verify the lab ports are free and UFW matches the saved baseline. Remove the remote handoff key and temporary consumer config containing the revoked key. Preserve private local SQLite/keystore state outside git for audit; only copy allowlisted public evidence after exact-secret checks and `bun run secret-scan` pass.
