# Onboarding — from zero to a first shared model

This is the short path for a Magpie user who can copy a few commands; no coding is required. It
uses the real Magpie gateway, the guided plugin commands and one EasyTier no-TUN overlay. It does
**not** use a laboratory script, a public testnet payment or real money.

Phase 8 adds the guided entries `setup`, `share setup`, `connect`, `share approve`, `share handover`,
`remote`, `wallet wizard`, `wallet status` and `wallet statement`. The explicit two-chain commands in
§6 remain the reference for debugging and for a fully manual run. The CLI's `--help` is the final
authority.

**Scope and safety**

- Sharing and consuming are for a private community. Never expose Magpie's administrative interface
  (`magpie web` or `/api/*`), even to overlay members. Do not use `magpie web --lan`, and do not share
  the plugin page URL: it is a capability URL for the page, and the setup form can contain the
  overlay secret.
- The chain wallet is **testnet only**. It credits mock test tokens on BSC testnet (97) and Base
  Sepolia (84532). It is not money and it is not a buy/swap/bridge service. Real funds are NO-GO.
- A Gateway Key is a bearer secret. Hand it over out of band (a password manager or an encrypted
  message), never in a group chat, a screenshot, a commit or a shell history line. The phase-8
  commands write a key to a 0600 file; use that file, do not echo it.
- `magpie plugin add` installs a local package. `bun` must be on `PATH` for the operator CLI;
  Magpie's internal Bun is not a shell command.

## 1. What you need

| Item | What it is |
| --- | --- |
| Two Magpie nodes | Provider P shares its own Magpie; consumer C uses it. They can be two machines or two fresh isolated profiles for a trial. |
| Magpie 0.1.2038 | The verified host/CLI and pricing/billing pin. A Linux 0.1.2057 container was verified as a consumer. 0.1.2120 is page/bridge source and 0.1.2171 has isolated `magpie web` page evidence; their host/CLI is UNKNOWN, so `setup` reports a warning, not a silent pass. |
| Bun 1.4.3 | Runs `plugin/bin/ohmyaihub.ts`. |
| A reachable peer path | A LAN address, or an EasyTier relay such as `tcp://relay.example.com:11010`. |
| A native model with a price | P's own Magpie provider, for example `deepseek/deepseek-flash`, with a complete effective price. A model without a price cannot back a cost-capped key. |
| A test token (only for §6) | A mock ERC-20 on 97/84532. No contract address ships in this repository. |

The plugin stores state in `<magpie config dir>/oh-my-aihub/`. On macOS and Linux the usual
directory is `~/.config/magpie`; a portable Magpie uses its own `data/` directory. The examples use
`~/.config/magpie`; substitute the real path.

Set a portable shell function so paths with spaces and repeated `--data` stay correct (works in
zsh and bash):

```sh
REPO="$HOME/Projects/magpie-oh-my-aihub-import"
MAGPIE_DATA="$HOME/.config/magpie"
ohmyaihub() { bun "$REPO/plugin/bin/ohmyaihub.ts" --data "$MAGPIE_DATA" "$@"; }
```

Substitute your clone path and your Magpie data directory. Do not use `CLI="bun …"` and `$CLI`: zsh
(the macOS default) does not word-split an unquoted variable, so the command would be passed as one
word.

## 2. Five-minute provider start

### 2.1 Install and verify the host

1. Install Magpie and turn on **Settings → Share on local network** (the gateway must listen on a
   non-loopback address; otherwise the key check is meaningless).
2. Install Bun 1.4.3. From the repository root:

   ```sh
   magpie plugin add /absolute/path/to/this/repo/plugin
   magpie plugin list
   ```

3. Open the plugin page **Oh My AIHub** once. If Magpie has not started the host yet, opening the
   page does. Then run the read-only preflight:

   ```sh
   ohmyaihub setup --check
   ```

   `setup --check` (or `preflight`/`doctor`) reports the platform, Bun, the Magpie version and
   whether it matches the tested 0.1.2038, the host's `api-port`/`api-token`/lock, EasyTier's pinned
   hashes and the LAN gateway's 401 probe. It never changes a configuration. On a brand-new node the
   host may not be running yet; if it says the host is not reachable, open the page or restart
   Magpie and retry.

### 2.2 Configure the overlay and sharing

A first setup can prompt for the network secret without echoing it:

```sh
ohmyaihub setup \
  --network my-private-net \
  --peer tcp://relay.example.com:11010 \
  --listen 0.0.0.0:11010 \
  --ports 3425 \
  --share --no-consume \
  --prompt-secret
```

- `--secret-file <0600 file>` is the non-interactive alternative. The file must be a regular,
  owner-only file (mode 0600, no symlink) and is checked before use. Do not pass the secret as an
  argument; it would land in shell history and process lists.
- `--peer` may be repeated. `--listen 0.0.0.0:11010` accepts peers; use `127.0.0.1:11010` only for a
  dial-only node. `--clear-peers` is the explicit way to remove peers.
- `--ports 3425` must be Magpie's gateway port. If Magpie listens elsewhere, set the real port.
- `--share --no-consume` is a provider-only node. A node may do both; see §3.
- A node that already has a configuration is **not** changed by `setup`; it prints `resume` /
  `--reconfigure` instead. Use `--reconfigure` only when you mean to change the overlay.

A save from the page makes Magpie restart the shared plugin host: the EasyTier core, the overlay and
the local operator API disappear for a few seconds. Magpie starts the host again only when
something asks it (opening the page does). Reload the page and check `status`; `pid` and
`startedAt` prove the restart. Do not save while an AI request is in flight.

### 2.3 Publish only your own models

```sh
ohmyaihub share setup --all-priced --publish
ohmyaihub checks
```

`share setup` lists **native** models with their effective price, refuses a model without a complete
price, writes the allow list through the existing `share models` path and optionally publishes the
catalogue. Publishing is opt-in (`--publish`); sharing alone does not publish a quote. It prints the
quote's `priceVersion` and always `priceLocked:false`. A Remote Magpie, `group/…` or `auto/…` is never
a share candidate.

Expected healthy checks: `core-running`, `acl`, `gateway-key-required`, `mapped-cidr`,
`published-gateway`, `shared-models-native-only` and the catalogue checks if publishing. `checks`
exits `1` if any check fails.

### 2.4 Issue one key for one consumer

For a direct handover without a catalogue request:

```sh
ohmyaihub consumers add alice deepseek/deepseek-flash 1
ohmyaihub share handover alice --key-file "$HOME/alice.key"
```

- `consumers add` creates a Magpie Gateway Key with a non-empty model whitelist and a positive cost
  cap (here $1). The plugin owns the key and records the cap in its ledger.
- `share handover` writes the key to a **new 0600 file** (`O_EXCL`; use `--force` only to replace
  your own file) and prints only the consumer, models, cap and path. It never prints the key.
- `topup alice 1 --deposit-id <unique-id>` adds simulated credit. The deposit id makes a replay a
  no-op. The chain wallet is separate (§6).
- Do not reuse a consumer id after `revoke`; create a new id. A revoked key is not reissued under
  the same name.

If the consumer sent a catalogue request, use the approval path instead:

```sh
ohmyaihub share approve request.json --cap 1 --yes
ohmyaihub share handover <consumer-id> --key-file "$HOME/<consumer>.key"
```

`share approve` validates the `ohmyaihub.connection-request/v1` document against this node: the
request's provider, mapped address/gateway port, current catalogue fingerprint/content hash, current
selected price version and models must match. It requires **you** to choose a positive cap, shows the
request for confirmation, and in a non-interactive shell requires `--yes`. It never accepts the
consumer's suggested cap as authoritative and never prints a key.

### 2.5 What to give the consumer

The **network invitation** and the **Gateway Key** are two different handovers:

- The network name and secret are needed by every node before setup. P sends that invitation to C
  once, through a trusted private channel (a password manager entry, an encrypted message, or a
  face-to-face transfer). If that channel is not private, choose a new network secret before adding
  anyone. The consumer needs the invitation to join; it is not optional.
- After C has joined and requested a key, P sends only the **mapped address** from `ohmyaihub status`
  (`node.mappedCidr`, for example `10.66.12.34/32`), the gateway port (normally 3425), and the
  **key file** produced by `share handover`, through an encrypted channel.

At the key-approval stage, do not send Magpie admin credentials, the plugin API token, or a new
copy of the network secret. C already has the network secret from the invitation. If the invitation
was exposed, rotate it for both nodes rather than resending it with a key.

### 2.6 Stop sharing safely

```sh
ohmyaihub share off
ohmyaihub revoke alice
```

`share off` withdraws the export and catalogue and stops new remote connections; it **does not**
remove issued keys from Magpie. `revoke alice` removes the key and wipes the stored secret. If you
only want to pause new business, `share off` is enough; if you want to stop a specific consumer,
revoke that key. See [operations](OPERATIONS.md#3-stop-sharing-revoke-and-remove-a-provider).

## 3. Five-minute consumer start

C needs the network name and secret from P's trusted private **network invitation**, and at least one
peer path to P. The invitation is delivered before setup; the Gateway Key is a separate later
handover (§2.5). C may also share its own Magpie; that is a separate capability.

```sh
ohmyaihub setup \
  --network my-private-net \
  --peer tcp://relay.example.com:11010 \
  --listen 0.0.0.0:11011 \
  --consume --no-share \
  --prompt-secret
```

`setup` merges only the fields you name; it does not clear peers or a listen address. A node with an
existing configuration is left alone unless `--reconfigure` is passed.

### 3.1 Catalogue discovery and TOFU approval

The catalogue is a read-only signed document; it is not a key and it does not charge. It is optional.
On P, publishing was enabled by `share setup --publish`. Keep the catalogue port at the default
**3426** (or 3427–3430): discovery probes that base and the next four ports only. If you must use a
port outside that range, set C's catalogue base to match before discovery.

On C:

```sh
ohmyaihub catalog discover on
ohmyaihub connect
```

`connect` without `--node` lists peers with their full TOFU fingerprint, quote version/hash,
`priceVersion`, `priceLocked:false`, mapped address and models. The first sight is **unverified**.
Pick the peer and review it:

```sh
ohmyaihub connect --node <node-id>
```

In a terminal it displays the full fingerprint and quote hash and asks you to type the first 12 hex
of each. Non-interactive use must pass the same values explicitly:

```sh
ohmyaihub connect --node <node-id> \
  --trust --fingerprint <64-hex> --quote <64-hex> \
  --request-out "$HOME/request.json"
```

The request file is written 0600. It contains the consumer id, selected models, mapped address,
quote hash, price version and an approval block; it deliberately contains no shell command. A
changed fingerprint is `identity-changed` and is refused until you review it; `--trust` with the
exact new fingerprint is the only local acceptance.

Send `request.json` to P out of band. P reviews it, runs
`share approve request.json --cap 1 --yes` and
`share handover <consumer> --key-file "$HOME/<consumer>.key"`, then returns the key file.

C connects with the returned file and the **same** accepted fingerprint/quote:

```sh
ohmyaihub connect --node <node-id> \
  --key-file "$HOME/<consumer>.key" \
  --fingerprint <64-hex> --quote <64-hex>
ohmyaihub remote list
```

The service re-checks the accepted fingerprint/hash and the existing provider probe/rollback path.
The key is read from the file and is never printed; other providers are kept.

### 3.2 Direct handover (no catalogue)

If P already sent the mapped address and key file:

```sh
ohmyaihub remote add peer-p --cidr 10.66.12.34/32 --key-file "$HOME/alice.key" --port 3425
ohmyaihub remote test peer-p
ohmyaihub remote models peer-p
```

`remote add` creates the loopback forward, registers P as a native **Remote Magpie**, and refuses to
finish unless P answers 401 without a key **and** with a wrong key, and the valid key lists at least
one model. A failure restores the previous registration and leaves other providers alone.
`remote test`/`remote models` are read-only and touch only the named provider; `remote recover`
re-runs reconcile without changing the others.

### 3.3 Test the real path

There are two different keys; do not mix them up:

| Key | Owner | Used by |
| --- | --- | --- |
| C's own Magpie gateway key | C, created in Magpie's Gateway page or used by C's agent | C's agent → C's Magpie |
| P's Gateway Key for C | P, written by `share handover` | C's plugin → Remote Magpie → P |

`remote test peer-p` proves P's handover key through C's own forward and does not print it. For a
manual ingress check, do not put a key in a shell argument. Create a 0600 curl config with an editor
or password manager:

```sh
umask 077
$EDITOR "$HOME/p-gateway.curl"     # one line: header = "Authorization: Bearer <P-key-for-C>"
curl -sS -o /dev/null -w '%{http_code}\n' --config "$HOME/p-gateway.curl" \
  http://<P-LAN-IP>:3425/v1/models
```

Check no key and a wrong key separately without any secret in argv; both must be `401`. Never
continue if the unauthenticated or wrong-key probe succeeds: the ingress is not enforcing the key.

A full Remote Magpie call uses C's own gateway key and the model id `remote models` showed, normally
`peer-p/<provider>/<model>`. Use your agent, Magpie's Gateway page, or a 0600 curl config:

```sh
$EDITOR "$HOME/c-magpie.curl"      # header = "Authorization: Bearer <C-own-magpie-key>"
curl -sS --config "$HOME/c-magpie.curl" http://127.0.0.1:3425/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"peer-p/deepseek/deepseek-flash","messages":[{"role":"user","content":"hello"}]}'
```

If C's Magpie listens on a LAN address, use that address and a Magpie gateway key; a loopback
caller is treated as local by Magpie. `429` means P's native cost cap is spent; ask P to top up or issue a new key. A native window
boundary is different: it pauses the key and P must run `consumers reissue` (accepting the new price
version if it changed); waiting for the next window does not restore it. `401` means the key is
wrong, revoked or not yet handed over. Do not paste a key
into a command, a history line or a screenshot.

### 3.4 Stop consuming

```sh
ohmyaihub remote remove peer-p
ohmyaihub remote list
ohmyaihub consume off
```

`remote remove` removes C's loopback forward, C's stored key and the Remote Magpie entry the plugin
owns. It does **not** revoke the key at P; ask P to `revoke <consumer>` as well. `consume off`
unregisters all plugin-owned remote providers but keeps their records and keys, so it is reversible;
a hand-made provider is never touched.

## 4. Key ownership and handover rules

- One provider-owned key per consumer. Never share one key between two consumers.
- The key is a bearer secret. Do not put it in a URL, a screenshot, a commit, a log or a chat.
- `share handover` writes a 0600 file; `remote add`/`remote update-key`/`connect --key-file` read
  one. The legacy `secret`/`provider add --key` path still exists for compatibility but exposes the
  key to shell history and process lists; do not use it for a real handover.
- `revoke` wipes the stored secret and the consumer id cannot be reused.
- A changed key is a new handover: P issues a new key, C runs `remote update-key <id> --key-file
  <file>`. The old key may remain valid at P until P revokes it.
- A provider should revoke a consumer when the relationship ends; C removing its provider is not a
  revocation at P.

## 5. First-run troubleshooting

| Symptom | Check | Action |
| --- | --- | --- |
| `setup` says the host is not reachable | `api-port` missing or `/health` does not answer | Open the plugin page once or restart Magpie; retry `setup --check` |
| `setup` warns `Magpie … compatibility is UNKNOWN` | The installed version is not 0.1.2038 | Read the warning; 0.1.2120 is page/bridge-only. Use 0.1.2038 for a verified host/CLI run |
| `setup` refuses a missing secret | No `--secret-file`/`--prompt-secret` on a first setup | Use a 0600 regular file or the hidden prompt; do not pass the secret as an argument |
| `no usable LAN address` | The machine has no non-loopback IPv4 | Connect a network; for a lab, use a loopback profile deliberately |
| `gateway-key-required` fails | Magpie is loopback-only or the gateway port is wrong | Enable Settings → Share on local network; fix `--ports`; restart the plugin host |
| `ACL` fails | The generated config or the running core does not match | Do not edit the generated TOML; `stop` then `start`; read `checks` detail |
| `share setup` says no complete price | A native model has no effective price | Set a complete price in Magpie; rerun `share setup`; do not hand out a key for an unpriced model |
| `connect` says `unverified`/`identity-changed` | First sight or a changed self-signed key | Review the full fingerprint and quote; accept explicitly with `--trust --fingerprint … --quote …`. If the acceptance itself returns `unverified` once, the directory refresh is asynchronous: wait/`catalog refresh` and retry the same command; do not bypass the check |
| `remote test` fails / `degraded` | The peer is offline, the mapped address moved or the key is wrong | `remote list`, `remote test <id>`, `remote recover`; check P's `checks`; do not reuse its key elsewhere |
| `401` on a provider probe | Wrong/revoked key, or key not yet issued | Re-run `share handover` on P; `remote update-key` on C; check P's `consumers` |
| `429` | P's native cap is spent | P: `topup` or a new key; C: no local override exists |
| Page has old data | Status is a generated snapshot, not a live fetch | Press **Reload snapshot**; `pid`/`generatedAt` show freshness; use `ohmyaihub status`/`checks` |
| CLI cannot connect to the API | The page save/restart is still in progress, or the host is off | Wait a few seconds, open the page or restart Magpie, then retry |

For deeper checks see [operations](OPERATIONS.md), especially the accounting and wallet sections.

## 6. Advanced testnet credit (two chains)

**Do not use real funds.** This section is for BSC testnet 97 and Base Sepolia 84532 with mock test
tokens. The plugin stores no private key; the consumer signs with their own wallet. Mainnet 56/8453
are registered only as always-disabled records and are refused.

The roles are separate:

| Role | Runs | Holds |
| --- | --- | --- |
| **P, provider** | Magpie, the plugin host, the wallet watcher, `wallet wizard`, `wallet status`, `wallet statement` | the receiving address, the ledger and the Gateway Key; no consumer private key |
| **C, consumer** | their own wallet | the payer key; signs the typed data and sends the exact transfer |

C does **not** run P's wallet wizard and does **not** access P's loopback API. Every exchange below
is an out-of-band file transfer. The plugin never holds a private key for either side.

### 6.1 P: enable both chains, register a test token, publish receiving addresses

Use RPC endpoints you trust or the public testnet endpoints from the phase-7 evidence. Each chain is
an equal record; there is no primary or preferred chain.

```sh
ohmyaihub wallet networks
ohmyaihub wallet network 97 --rpc https://bsc-testnet-rpc.publicnode.com --enable
ohmyaihub wallet network 84532 --rpc https://base-sepolia-rpc.publicnode.com --enable
```

Register a mock token only after the chain answers `decimals()`. The symbol/name must say it is a
mock or test token; a symbol that pretends to be a real token is refused. No contract address ships
in the repository:

```sh
ohmyaihub wallet asset-register \
  97 0x<test-token> tMOCK6 'Mock Test Dollar' 6 --nanos-per-token 1000000000 --note 'test only'
ohmyaihub wallet asset-register \
  84532 0x<test-token> tMOCK18 'Mock Test Dollar' 18 --nanos-per-token 1000000000 --note 'test only'
ohmyaihub wallet assets
```

`--nanos-per-token 1000000000` means one whole test token = 1,000,000,000 nano-USD (1 test USD at the
fixed test rate). Use the precision the token actually reports. If you need a test token, deploy the
test-only `MockERC20` from `plugin/lab/chain` with Foundry; that is a developer tool, not a product
token, and its address belongs in your own notes, not in this repository.

P publishes an address P already controls; the plugin holds no private key. This assumes P has already
issued a Gateway Key to `alice` (§2.4) and C has connected it with `connect`/`remote add` (§3):

```sh
ohmyaihub wallet receiving provider-p 97 0x<P-address>
ohmyaihub wallet receiving provider-p 84532 0x<P-address>
```

The same provider may use a different address on each chain. The address is part of the deposit
intent at issue time; changing it later does not change an already-issued intent.

### 6.2 P → C, delivery 1: the typed data

P creates the request on P's node. Use the batch form for a copyable document, or the interactive
form; neither signs or sends anything:

```sh
ohmyaihub wallet wizard --batch \
  --consumer alice --provider provider-p --chain 97 \
  --asset <assetId|symbol> --amount 1 --no-watch
```

The wizard prints the real EIP-712 typed data, the invoice id, the exact raw amount, the recipient,
the expiry and a digest. P writes that document to a file (for example `alice-97-typed.json`) and
sends **that file** to C through a trusted private channel. The request is `awaiting signature`;
nothing has been paid. The wizard refuses a second pending request for the same consumer unless
`--force` is passed. For two chains, either complete/cancel the first request before creating the
second, or use `--force` only because the chain and amount differ and you accept the ambiguity
warning. A request you do not intend to pay can be cancelled with `wallet cancel <invoiceId>`.

`--batch` never picks a default chain or provider: `--chain` and `--provider` are required when the
choice is not unique. Run it again for 84532 with the other test asset.

### 6.3 C: sign externally and return delivery 2

C opens the typed data in their own wallet and checks the chain id, token contract, recipient and
exact amount before signing it with the paying account. C writes a small JSON file containing the
signature and the payer address (the address that produced it):

```json
{
  "signature": "0x<65-byte signature>",
  "payerAddress": "0x<payer address>"
}
```

C sends that file back to P out of band. C does not need P's API, P's plugin state or P's wallet
wizard. C must not send the transfer before P has recorded the signature; an unsigned transfer is
`unclaimed` and is never credited.

### 6.4 P: record the signature and give the exact transfer

P records the returned file on P's node:

```sh
ohmyaihub wallet wizard --batch --consumer alice --invoice <invoiceId> \
  --signature-file "$HOME/alice-97-signature.json" \
  --payer 0x<payerAddress>
```

The wizard verifies the signature and the payer binding, then prints the exact transfer: chain,
token contract, raw amount, recipient and expiry. P sends those instructions to C. C sends **exactly**
that amount, token and recipient, from the signing wallet, on the same chain.

If P's cap write fails after the deposit is booked, keep the same deposit and retry the credit path;
do not create a second deposit. A reorg still freezes the consumer and keeps the deposit for audit.
A historical `failed` deposit row is not automatically turned back into a credit; it needs a manual
audit. The plugin never guesses.

### 6.5 P: observe finality and verify credit

```sh
ohmyaihub wallet scan 97
ohmyaihub wallet events --chain 97
ohmyaihub wallet status
ohmyaihub wallet credit alice
```

BSC testnet uses 15 confirmations as its stated finality substitute; Base Sepolia waits for the real
`finalized` tag and can take ~17–24 minutes. A credited event raises the same Gateway Key's cap;
the next call should be `200`. Run the scan again and confirm zero new credits. A reorg freezes the
consumer; it never deletes or silently adjusts the balance.

If the event is `unclaimed` or `uncertain`, do not send a second payment to "fix" it. Inspect
`wallet anomalies`, keep the transaction and the signed document, and resolve it as an operator. The
plugin never guesses a payer. Historical `failed` rows and `unclaimed` transfers stay visible; they
are not automatically reversed or credited.

### 6.6 P → C, delivery 3: the unsigned statement

P can produce a statement for the consumer:

```sh
ohmyaihub wallet statement alice --out "$HOME/alice-statement.json"
```

`--out` ending in `.json` is written exactly at that path; any other value (or no `--out`) is a
directory under `<magpie data>/oh-my-aihub/statements/`. The parent directory must exist; the file is
created exclusively with mode 0600. Use `--force` only for an exact `.json` path you intend to
replace.

The statement is **unsigned**. Its SHA-256 digest proves only that the file was not edited by hand;
it is not proof of payment, a signature or an identity claim. P sends the statement file to C out of
band. C does not need to call P's API.

### 6.7 P: stop the wallet

```sh
ohmyaihub wallet stop
ohmyaihub wallet network 97 --disable
ohmyaihub wallet network 84532 --disable
```

Disabling a chain stops its watcher; existing ledger deposits and balances stay. Do not delete
`chain.sqlite` or `ledger.sqlite` while the host is running.

## 7. Where to go next

- [Operations](OPERATIONS.md): daily checks, balance anomalies, stop sharing, revoke, leave the
  network, backup/restore, troubleshooting.
- [Architecture](ARCHITECTURE.md): the design decisions and the open blockers.
- The phase-7 reports: [fresh two-host](validation/2026-10-30-fresh-twohost-wallet.md),
  [real-Magpie replay](validation/2026-10-30-live-magpie-chain-credit.md) and the
  [multichain evidence](validation/2026-10-30-phase7-multichain-wallet.md). These are testnet
  evidence, not a promise of real-money safety.
