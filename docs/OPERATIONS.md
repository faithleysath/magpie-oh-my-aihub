# Operations — the daily loop, anomalies, exit and recovery

This is the day-to-day guide for a Magpie user whose node has already completed
[onboarding](ONBOARDING.md). It keeps Magpie as the only AI data path and the only charging point;
the plugin never proxies a request.

**Safety rules**

- Testnet only for chain credit. Real funds are NO-GO.
- Never expose Magpie's administrative interface (`magpie web` or `/api/*`), even to overlay members.
  Do not use `magpie web --lan`, and do not share the plugin page URL or screenshots: the page is a
  capability URL and its snapshot can contain operator/accounting data.
- A Gateway Key is a bearer secret. Do not paste it into a ticket, a screenshot or a chat. Use the
  0600-file handover path (`share handover` / `remote add --key-file`), not `--key` on the command
  line.
- Stop Magpie completely before copying its data directory. A live SQLite copy can be inconsistent.
- Do not hand-edit `state.json`, `consumers.json`, `caller-keys.json`, `providers.json` or the
  generated EasyTier TOML. Use the CLI/page; a hand edit can silently change what a key can reach.

The examples use `~/.config/magpie`; substitute the real Magpie data directory (a portable Magpie
uses its own `data/`).

## 1. The daily check

Run these from the repository root (or use the installed plugin path). A shell function keeps paths
with spaces and repeated `--data` correct in zsh and bash:

```sh
REPO="$HOME/Projects/magpie-oh-my-aihub-import"
MAGPIE_DATA="$HOME/.config/magpie"
ohmyaihub() { bun "$REPO/plugin/bin/ohmyaihub.ts" --data "$MAGPIE_DATA" "$@"; }

ohmyaihub status                 # JSON summary: both capabilities, node, export, peers, checks
ohmyaihub checks                 # PASS/FAIL; exits 1 on any failure
ohmyaihub setup --check          # read-only preflight: host, Magpie, EasyTier, LAN
ohmyaihub accounting             # periodic accounting state, failures, paused consumers, serving
ohmyaihub remote list            # one line per remote provider, status and native limit
ohmyaihub consumers              # provider-owned keys, cap, used, ledger balance, pause
ohmyaihub wallet status          # only if a testnet chain is enabled; per-consumer view
```

What to look for:

| Field | Healthy | What it means |
| --- | --- | --- |
| `checks` | every line `PASS`, exit 0 | The effective ACL, gateway 401, mapped prefix, published port, key scoping, provider ownership and forwards were verified |
| `sharingActive` | `true` while sharing | The export is published; `false` can mean sharing is off or the safety guard withdrew it |
| `shareSuspended` | `null` | A non-null value is a fail-closed withdrawal with a reason; see §3 |
| `accounting.uncertain` | `false` | A failed accounting check; after the failure budget the export is withdrawn |
| `accounting.paused` | `[]` | A consumer is paused for a price/window/log reason; see §2 |
| `providers[].status` | `connected` | `degraded` is that provider only; other providers keep working |
| `consumers[].paused` | `null` | A non-null pause includes the enforcement level; only `keyRevoked`/`secretRotated` are enforced |
| `wallet.chains[].lastError` | `null` | A chain RPC/scan error; it does not stop the other chain |
| `wallet.totals.unclaimed/uncertain` | `0` unless there is a real anomaly | These are never credited automatically |

Do not use `magpie gateway-key limit reset` or `limit off` to "fix" a spent key. A reset erases
usage and breaks the ledger; `topup` raises the same key's cumulative cap.

## 2. Balance anomalies

The plugin's ledger is the balance of record. It never silently adjusts or reconstructs a charge.

### 2.1 A paused consumer

`consumers` shows a `paused` reason. The common cases:

| Reason | Meaning | Action |
| --- | --- | --- |
| `price-mismatch` | Magpie's effective price differs from the accepted version | Confirm the new price; run `consumers reissue <id> --accept-price-version <sha256>`. Settled usage stays at its old snapshot |
| `window-rollover` | The native limit window ended or differs from the ledger's | `consumers reissue <id>`; it imports the old window, closes it, and issues a new key with the ledger balance |
| `unpriced` | A shared model has no complete effective price | Fix the model price in Magpie; then `consumers reissue <id>`. Do not hand out a key for an unpriced model |
| `overdraft` / `dust` | The balance is negative or below $0.0001 | Do not issue a key; top up or write off explicitly; a reissue will keep the consumer paused |
| `log-gap` | `usage.jsonl` shrank, disappeared or had an unparsable line | Do not guess. Audit the log, then `consumers resolve-gap <id> --log-id <id> --by <who> --note <what happened>`; a reissue is refused until then |
| `manual` with detail `chain-reorg: …` | A credited deposit's block hash moved | The deposit stays for audit and the consumer is frozen; review `wallet anomalies`; reissue only after the reorg is understood |
| `manual` | Recovery found a ledger window with no key, or a key changed outside the plugin | Keep the balance; explain the missing/foreign key before issuing a new one |
| `drift` | Native used and the ledger's recorded consumption differ beyond tolerance | Do not reset Magpie usage; inspect the usage log and ledger, then reissue only after the evidence is understood |

`consumers reissue` may return a new secret for a legacy `sk-magpie-…` key. Hand the new secret over;
a plugin-owned `sk-ohmy-…` key keeps its secret. A window boundary is not a top-up; `reissue` carries
the recorded balance, never `old cap + amount`.

### 2.2 Accounting uncertainty

```sh
ohmyaihub accounting
ohmyaihub status
ohmyaihub checks
```

- `uncertain: true` or `failures > 0` means a check threw, timed out or could not read
  `GET /v1/magpie/limit`. An unreadable limit endpoint is a **failed** check, not a healthy one.
- After the failure budget the export is withdrawn (`serving: false`). Fix the Magpie/gateway first.
- Do not reissue a consumer while its charges are `ledgerUncertain`; a read outage is not proof of
  fraud, but it is not a pass either.
- A pause whose enforcement is `capRestricted` or `safetyUncertain` did **not** fully stop a local
  caller. The export is withdrawn and the status says so; do not report the consumer as stopped.

### 2.3 Sharing suspended

`checks` shows `sharing-suspended` when Magpie's provider list cannot be read or a shared key names a
model that is not native/allowed. The export and Forward chain are withdrawn; no key is revoked on a
transient read error.

1. Inspect `status.config.nativeProviders`/`remoteProviders`, `plugin.log`, and Magpie's own
   provider list.
2. Fix the provider entry or the share allow list. Do not delete a provider that a consumer is using.
3. Run `ohmyaihub guard` (or wait for the reconcile pass), then `ohmyaihub checks`.
4. Sharing republishes only when the guard can prove every issued key is native and allowed.

### 2.4 Spent, revoked and exhausted

- `spent: true` / a native `429` means the key's cap is exhausted. `topup <consumer> <usd>
  --deposit-id <unique>` raises the same cap; a replayed deposit id is a no-op. A native window
  boundary is **not** an automatic refill: it pauses the consumer as `window-rollover`, and the
  provider must run `consumers reissue <id>` (accepting a price version if it changed). Waiting for
  the next window does not restore the key.
- `revoked` means the key was removed and its secret wiped. A revoked consumer id cannot be reused;
  create a new id and hand over a new key.
- A `401` with a key that should work means the key was revoked, rotated or never handed over. Re-run
  `share handover` on the provider, then `remote update-key <id> --key-file <file>` on the consumer.

### 2.5 Chain anomalies

```sh
ohmyaihub wallet status
ohmyaihub wallet networks
ohmyaihub wallet assets
ohmyaihub wallet intents
ohmyaihub wallet events
ohmyaihub wallet anomalies
ohmyaihub wallet statement <consumer> --out "$HOME/<consumer>-statement.json"
ohmyaihub wallet resolve <id> --note '<what you checked>'
```

- **unclaimed** — the transfer did not match a signed intent (unsigned payer, exchange withdrawal,
  wrong amount/recipient/chain). It is never credited. Do not send a second payment to "fix" it.
- **uncertain** — two or more candidates match, or an event is ambiguous. It is never credited.
- **reverted** — a credited event's block hash moved; the deposit stays, the consumer is frozen.
- **finalized but not credited** — the credit path/ledger is waiting; run `wallet scan <chainId>`,
  then check `wallet credit <consumer>` and `status`. A retry is bounded per tick; a backlog drains
  over several scans.
- **RPC error / no head** — fix the endpoint in `wallet network <chainId> --rpc …`; the other chain
  is independent. A chain that cannot answer never finalises under a `finalized` policy.
- **Cap write failed after the deposit was booked** — keep the same deposit and retry the credit
  path (`wallet scan`, then `wallet credit`); do not create a second deposit. A reorg still freezes
  the consumer and keeps the deposit for audit. Historical `failed` rows do not automatically turn
  back into credits; they need a manual audit.
- A chain's configured finality is not a suggestion. BSC testnet uses 15 confirmations; Base
  Sepolia waits for the real `finalized` tag (~17–24 minutes). Do not resend while waiting.

The wallet wizard and watcher run on the **provider** node. The consumer only signs the typed data
externally and sends back a `signature`/`payerAddress` file; the consumer does not run the provider's
wizard and does not access the provider's loopback API. The provider then resumes with
`wallet wizard --batch --invoice <id> --signature-file <file>` and sends the exact transfer instructions.
`wallet statement` is an **unsigned** file with a digest; it proves only that the file was not
edited by hand, not that a payment happened. `wallet resolve` records an operator note; it does not
create credit, adjust a balance or delete a deposit. That is deliberate.

## 3. Stop sharing, revoke and remove a provider

### 3.1 Provider: stop sharing

```sh
ohmyaihub share off
ohmyaihub checks
```

This withdraws the export, the Forward chain and the published catalogue. It deletes **nothing** in
Magpie: local providers, models and issued Gateway Keys stay. A remote consumer can no longer reach
the gateway, but a key that leaked may still work on a local/LAN caller; revoke keys if the stop is
about access, not just publication.

To pause all new business temporarily, `share off` is enough. To stop one consumer:

```sh
ohmyaihub revoke alice
ohmyaihub consumers
ohmyaihub checks
```

`revoke` removes the key from Magpie and wipes the stored secret. It is not reversible and the same
consumer id cannot be reused. If removal fails, the command reports it; inspect Magpie's key list and
retry; do not assume the key is gone.

To resume:

```sh
ohmyaihub share on
ohmyaihub checks
```

A new `share on` republishes the same persisted export/mapped address, so existing consumers can
reconnect. A key revoked while sharing was off is still revoked.

### 3.2 Consumer: remove one remote provider

```sh
ohmyaihub remote remove peer-p
ohmyaihub remote list
ohmyaihub checks
```

This removes C's loopback forward, the Remote Magpie entry the plugin owns and C's stored key. It
does **not** revoke the key at P; ask P to `revoke` that consumer. Other providers are re-verified
and keep working. A failed removal leaves a recorded orphan; the next core start drops it.

`consume off` unregisters every plugin-owned Remote Magpie and drops the forwards, but keeps the
connection records and keys so `consume on` can restore them. A provider added by hand in Magpie is
never touched.

### 3.3 Retarget or rotate a provider key

```sh
ohmyaihub remote update-key peer-p --key-file "$HOME/peer-p-new.key"
ohmyaihub provider update peer-p --cidr 10.66.12.35/32 --port 3425   # retarget; no key on argv
ohmyaihub remote test peer-p
ohmyaihub remote list
```

A key update proves the new key before replacing the registration. A CIDR/port change moves to a
fresh loopback port and restarts EasyTier once so the old listener is gone; other providers' in-flight
requests may be interrupted and recover immediately. A failed switch restores the old registration.
Reusing the same loopback port for a new target is refused (EasyTier 2.6.4 cannot retarget a live
forward).

## 4. Leave the network or remove the plugin

### 4.1 Provider leaving

1. `share off` (cut publication first).
2. `revoke` every consumer listed by `consumers`.
3. `catalog publish off` if the catalogue is on.
4. `remote remove` every remote provider if this node also consumes.
5. `consume off`.
6. `ohmyaihub stop` (stop the EasyTier supervisor).
7. `magpie plugin off <spec>` (find the spec with `magpie plugin list`).
8. Quit Magpie completely; verify no plugin host or `easytier-core` process remains.
9. Keep a backup; only then remove `<magpie data>/oh-my-aihub/`. `magpie plugin rm <spec>` removes
   the installed plugin package.

### 4.2 Consumer leaving

1. `remote remove` every remote provider.
2. `consume off`.
3. `catalog discover off`.
4. `ohmyaihub stop`.
5. `magpie plugin off <spec>`; quit Magpie.
6. Ask each provider to `revoke` your consumer id. Removing your provider does not revoke the key at
   the provider.

### 4.3 Changing or leaving the overlay

There is no separate "leave network" command. A node leaves by stopping its EasyTier core and
removing its provider/catalog state; it joins a different network by configuring the new name,
secret and peers. Because the node id and mapped address are persisted, do not run the old and new
copies at the same time.

To rotate the overlay secret, keep the existing provider records and keys unless they are actually
broken:

1. `share off` to stop new remote ingress. Do **not** remove every remote provider or revoke keys
   just to rotate the overlay.
2. On every node, run `setup --reconfigure --secret-file <0600 file>` with the same new secret. The
   page cannot change a configured node's network; use the CLI. This restarts EasyTier.
3. `share on`; on each consumer run `remote recover` so the existing records reconnect. A provider
   that is still stale after both sides have the new secret can be updated/removed individually;
   keys are not part of the overlay secret.

If the secret itself leaked, rotate it this way and treat any exposed Gateway Key separately
(`revoke`/`share handover`).

Removing the plugin does not remove Magpie's own providers, models or Gateway Keys. Remove those in
Magpie deliberately, or keep them for a later reinstall.

## 5. Backup and restore

There is no supported `backup` command in this release. Use this stopped-host procedure.

### 5.1 What must be in the backup

Back up the **whole Magpie data directory**, not just `oh-my-aihub/`. The plugin's ledger and chain
store must match Magpie's own keys, providers and usage:

- `oh-my-aihub/` — `state.json`, `provider-keys.json`, `consumers.json`, `ledger.sqlite`,
  `networks.json`, `chain.sqlite`, catalogue identity/trust, EasyTier state, logs;
- Magpie's `caller-keys.json`, `providers.json`, `settings.json`, `usage.jsonl`;
- the installed plugin state/config (`plugins.json`/`plugins.yml`, depending on the Magpie version)
  and any `plugins/` package that must be restored.

A backup contains Gateway Keys, the network secret, the ledger and the chain store. Treat it as a
secret. Encrypt it at rest and keep it off the repository.

### 5.2 Make a backup

```sh
# 1. Stop publication and the host, then quit Magpie completely.
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie share off
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie stop
magpie plugin off <spec>
# Quit the Magpie app/menu bar; do not leave the plugin host alive.
pgrep -fl 'easytier-core|ohmyaihub|plugin/src/index.ts' || true

# 2. Copy the whole config directory. Use a private umask.
umask 077
tar -C ~/.config -czf "$HOME/magpie-backup-$(date +%F-%H%M).tgz" magpie
chmod 600 "$HOME"/magpie-backup-*.tgz
# Encrypt with your normal tool (age/gpg) before moving it off the machine.
```

If the node uses a portable Magpie, archive its `data/` directory instead of `~/.config/magpie`.
Do not copy a live `ledger.sqlite`/`chain.sqlite` while the host is running.

**Restore to the same absolute path.** The ledger identifies Magpie's usage log by a hash of the
log's resolved absolute path (`usageLogId`). Restoring the same files under a different root can make
the ledger see a different log and re-identify/re-read usage. Moving a ledger to a new directory is
**untested and unsupported**; this procedure restores to the original Magpie data path. This is a
documentation constraint, not a change to the ledger algorithm.

### 5.3 Restore

```sh
# 1. Stop Magpie and all plugin/EasyTier processes.
magpie plugin off <spec>        # if the current install still has it
# Quit Magpie; verify with pgrep as above.
# After a restore, re-enable it explicitly; starting Magpie alone does not turn an off plugin on.

# 2. Move the current directory aside instead of deleting it.
mv ~/.config/magpie ~/.config/magpie.before-restore-$(date +%F-%H%M)
mkdir -p ~/.config

# 3. Extract the backup and keep it private.
umask 077
tar -C ~/.config -xzf "$HOME/magpie-backup-YYYY-MM-DD-HHMM.tgz"
chmod -R go-rwx ~/.config/magpie

# 4. Re-enable the plugin, then start Magpie and open the page once so the host starts.
magpie plugin on <spec>
# Start Magpie, open the plugin page once, wait for the host, then verify.
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie setup --check
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie status
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie checks
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie accounting
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie remote list
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie consumers
bun plugin/bin/ohmyaihub.ts --data ~/.config/magpie wallet
```

Then make one real test call and compare the ledger balance with the backup. The restore is only
verified when:

- `checks` passes (ACL, gateway 401, mapped prefix, keys, providers, forwards);
- `accounting` is not uncertain and the paused list is what you expect;
- the same consumer key still answers 200 and the ledger balance is unchanged;
- a duplicate wallet scan adds zero credits.

### 5.4 Restore caveats

- **Restore to the original absolute Magpie data path.** Do not treat this as a directory-migration
  procedure: the ledger's usage-log identity is tied to the resolved path, and a new root may be read
  as a different log. Cross-root migration is untested and unsupported.
- Do not run the original and the restored copy at the same time on the same overlay. They share the
  node id, virtual IP and mapped CIDR; two copies can steal routes and double-serve.
- A backup from an older plugin/Magpie version may migrate on first start. Read the log and the
  migration backup; do not delete the old directory until the migration is verified.
- `easytier/` contains platform-specific binaries. Restoring on a different OS/architecture may
  require removing that folder and letting the plugin download and SHA-256 verify the pinned build.
- Restoring only `oh-my-aihub/` without Magpie's `caller-keys.json`/`providers.json`/`usage.jsonl`
  can leave the ledger ahead of or behind Magpie. That is why the whole config directory is the
  unit of backup.
- A stale `host.lock` is taken over only when its owner is gone. Make sure no old host is still
  running before starting the restored copy.

## 6. Troubleshooting

Start with `checks`, then `status`, then `plugin.log`. The log redacts registered secrets and
`sk-…` patterns, but treat the whole file as sensitive.

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `checks` exits 1 on `core-running` | EasyTier failed to start or was stopped | `stop`, then `start`; read the detail and `plugin.log`; check the pinned binary hash/cache |
| `acl` fails | Running core does not match the generated ACL, or a hand edit changed the TOML | Do not edit the TOML; `stop`/`start`; if it persists, keep the log and report the generated/current values |
| `gateway-key-required` fails | Magpie is loopback-only, wrong port, or another process owns the port | Enable LAN sharing; fix `--ports`; `checks` detail names the URL/port |
| `mapped-cidr` fails | The export is not announced, or the core is down | Check the peer/route, `share on`, `remote list`; wait for reconcile |
| `sharing-suspended` | Provider list unreadable or a shared key is non-native | §2.3; `guard`, `checks`; do not delete keys blindly |
| `provider:<id>:forward` fails | No loopback listener | `remote recover`; if an orphan is reported, restart the core once |
| `provider:<id>:registered` fails | Magpie entry is absent or was edited by hand | Inspect `remote list`; remove a foreign entry in Magpie before re-adding; do not overwrite it |
| `provider:<id>:status` fails | Peer offline, mapped address moved, wrong key | `remote list`, `remote test <id>`, `remote recover`; check the overlay peer list; retry after the peer returns |
| `forwards-match` fails | A loopback listener has no provider | `remote recover`; restart the core to drop it; report an orphan if it persists |
| `catalog`/peer offline | The catalogue is not published, its port is outside the bounded probe range, or the peer is offline | `catalog status`; use port 3426 (or 3427–3430) on the provider or match C's base; `catalog refresh` |
| `degraded`/`identity-mismatch` | The provider is down or its hostname no longer owns the mapped prefix | Other providers keep serving; wait for the real peer; do not reuse its key elsewhere |
| `429` | Native cap spent, or a native window boundary paused the key | `topup` raises the cap; a `window-rollover` pause needs `consumers reissue <id>` (and the new price version if it changed). Waiting does not auto-resume |
| `401` | Wrong/revoked key, or a loopback caller bypass | Re-handover with `share handover`; `remote update-key`; check `consumers`/Magpie key list |
| `connection refused` from CLI | Plugin host not running or page save restart in progress | Open the page/restart Magpie; wait for `api-port`; retry |
| Page has old data | Snapshot is read-only; it updates on host writes/reload | Press **Reload snapshot**; `pid`/`generatedAt` show freshness |
| Page says “no chain wallet” when enabled | The snapshot was written before the wallet was enabled, or an older host filled its cache only after a `wallet` call | Run `ohmyaihub wallet status` and press **Reload snapshot**; the phase-8 host writes the wallet projection into the snapshot |
| `wallet` RPC error | Endpoint down/wrong chain id | `wallet networks`; `wallet network <id> --rpc …`; the other chain is independent |
| `unclaimed`/`uncertain` deposit | No exact signed intent, or ambiguity | Do not send again; inspect `wallet anomalies`; resolve with a note |
| `reverted` deposit | A credited block moved | Keep the deposit; review the anomaly; reissue only after the reorg is understood |
| `checks` says `no snapshot yet` on a fresh node | The host has not written `status.js`; no configuration yet | Open the page once; configure the node; `status` |

### Logs and evidence

- `<magpie data>/oh-my-aihub/plugin.log` — redacted, best effort.
- `status`/`checks`/`accounting`/`providers`/`consumers`/`wallet` JSON — the first evidence to keep.
- Magpie's own `usage.jsonl` — the source of token/cost rows; do not edit it.
- `ledger.sqlite`/`chain.sqlite` — audit stores; copy only with the host stopped.
- Never include a Gateway Key, network secret, API token, wallet private key or keystore password in
  a report. Public testnet transaction hashes and addresses are fine.

## 7. Emergency stop and key compromise

If a key may have leaked or a consumer must be stopped immediately:

```sh
ohmyaihub share off                 # cut new remote ingress first
ohmyaihub revoke <consumer>         # remove the key and wipe the stored secret
ohmyaihub checks
```

If `share off` or `revoke` cannot prove the stop, `checks`/`status` report the real enforcement level
and withdraw the export. Do not describe a `capRestricted` or `safetyUncertain` pause as stopped.
If removal keeps failing, stop the plugin host and the EasyTier core, then fix Magpie's key store
deliberately.

For a compromised remote-provider key:

1. Provider: `revoke <consumer>` and issue a new key for a new consumer id.
2. Consumer: `remote update-key <id> --key-file <new-file>`; verify `remote list` and `checks`.
3. The old key is refused by the provider; C's local record no longer stores it.

For a compromised network secret:

1. `share off`, `consume off`, `remote remove` all remote providers.
2. Rotate the secret on every node with `setup --reconfigure --secret-file <0600 file>` (or the
   page).
3. Re-add providers and keys. A peer that still has the old secret cannot join.

## 8. Upgrade and version policy

- The host/CLI and pricing/billing pin is Magpie **0.1.2038**. Magpie **0.1.2120** is page/bridge
  source and **0.1.2171** has isolated `magpie web` page/CSP/Save evidence only; do not assume their
  host/CLI commands, limits or prices behave the same. Desktop WKWebView is UNKNOWN.
- Linux Magpie **0.1.2057** official container was verified as a consumer; Linux GUI/provider is
  untested. Windows is untested.
- EasyTier **2.6.4** is pinned and SHA-256 verified. Do not replace the binary by hand; the
  supervisor reinstalls the pinned archive on a hash mismatch.
- Before an upgrade: back up the whole Magpie config directory, run `checks`, and keep the old
  directory. After an upgrade: `setup --check`, `status`, `checks`, `accounting`, a real test call and a
  duplicate wallet scan. A schema migration writes a timestamped backup; verify it before deleting anything.
- Real funds remain NO-GO on every version until the price-lock and other architecture blockers are
  solved and re-measured.
