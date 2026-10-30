# Phase 8 — management-boundary inventory before the onboarding UX

Read-only inventory first; implementation follows the plan in §5 and the tests in §7. No web console,
no billing change; `service.ts`, `index.ts`, `wallet.ts`, `page/`, `bin/` and existing tests are not
edited by this task.

- Platform: macOS 26.6.2 (25G83), arm64; Bun 1.4.3; repo `bf7a27d` on `feature/mvp-onboarding-operator-ux`
  plus the shared uncommitted Phase-8 working tree (named where it matters).
- Magpie source read at tag **v0.1.2038**, worktree commit `8c63c5b7873c6aa7aa797aa17f481d5fa8301876`
  (`/Users/laysath/Projects/lab/magpie-2038`). The plugin pins 0.1.2038 (`plugin/README.md`).
- EasyTier is not involved in this surface; no overlay or Magpie binary was run for these findings
  beyond the plugin host's own loopback API reproduced in §2.

Status words: **VERIFIED** = read in the named source, **REPRODUCED** = run here with the command
shown, **UNKNOWN** = not proven.

## 1. What the boundary is today (baseline)

| Boundary | State | Evidence |
| --- | --- | --- |
| Host API bind | `127.0.0.1` only, hardcoded | `plugin/src/server.ts:58` **VERIFIED** |
| Mutations | `Authorization: Bearer <api-token>` | `plugin/src/server.ts:134-136` **VERIFIED** |
| Reads | **no token at all** on loopback | `plugin/src/server.ts:83-132` **VERIFIED** |
| Browser guard | any `Origin` header is refused | `plugin/src/server.ts:80-81` **VERIFIED** |
| Host header | never read | `plugin/src/server.ts` (no `host` reference) **VERIFIED** |
| Token file | `<data>/oh-my-aihub/api-token`, 0600 on create | `plugin/src/server.ts:22-34` **VERIFIED** |
| Page snapshot | whole `lightStatus()` `JSON.stringify` into `page/status.js`, mode 0644 | `plugin/src/log.ts:81-86`; caller `plugin/src/service.ts:3033-3036` **VERIFIED** |
| Page load | Magpie serves the page folder with `connect-src 'none'`; `status.js` is loaded as a sibling script | `internal/gui/pluginpage.go:243,294-396` **VERIFIED** |
| `magpie web` | plugin-page files bypass the web cookie/key, authenticated only by a per-run 32-hex path token | `internal/gui/web.go:211-218`, `internal/gui/pluginpage.go:294-310` **VERIFIED**; `magpie web` defaults to `127.0.0.1:3430`, `--lan` switches to `0.0.0.0` (`internal/cli/web_cli.go:19,38-42`) **VERIFIED** |
| Plugin options | `plugins.json` is 0600 on this machine; the page form can read/set them | `~/.config/magpie/plugins.json` **VERIFIED**; `page/app.js`, `page/settings.js` **VERIFIED** |

## 2. Findings

### F1 — Unauthenticated `/status` and `/wallet/*` (HIGH) — REPRODUCED, fixed in §10

Every GET is answered before the token check. `/status` returns the whole status **plus
`recentLogs(40)`**; `/wallet/intents` returns every deposit intent with `consumerId` and
`payerAddress`; `/wallet/events` returns `txHash`/`fromAddress`; `/wallet` returns all of it.
`/consumers` returns caps and balances. None of them needs the token.

Reproduction (disposable fake `Service`, real `startApi`; the probe file is in `/tmp`, nothing in the
repo was changed):

```
$ curl -s -o s1 -w '%{http_code}\n' http://127.0.0.1:45681/status          # no Authorization
200
$ jq -c '.wallet.intents[0] | {consumerId,payerAddress}' s1
{"consumerId":"c1","payerAddress":"0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"}
$ curl -s -o s3 -w '%{http_code}\n' http://127.0.0.1:45681/wallet/intents  # no Authorization
200
```

The probe's only log line was the real credit line from `plugin/src/watcher.ts:777`:

```
chain 97: 1000000 of tMOCK6 from 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf credited as 2000000000 nanos to c1 (…)
```

`GET /status` returned it verbatim in `logs[]` — a direct consumer↔payer-address link. The same line
is in this checkout's own `plugin/oh-my-aihub/plugin.log` (184 such lines), mode 0600, from the
phase-7 lab. **The plugin's 0600 state files protect the address; the unauthenticated GET hands it
out.** REPRODUCED.

### F2 — No `Host` check, so DNS rebinding reaches the reads (HIGH) — REPRODUCED, fixed in §10

The only browser guard is `Origin`. A page on `evil.example` that rebinds its DNS to `127.0.0.1`
fetches `http://evil.example:<port>/status`: the request is same-origin, so the browser sends **no
Origin** on a GET, and the API answers. `Host` is never inspected.

```
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example:45681' http://127.0.0.1:45681/status
200
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' http://127.0.0.1:45681/status
403
```

REPRODUCED; the 403 shows the existing guard works only when the browser labels the request
cross-origin. A port scan is cheap; `34517` is the first port tried (`plugin/src/server.ts:50`).

### F3 — `page/status.js` publishes the consumer↔payment-address correlation (HIGH) — REPRODUCED, fixed in §10

`Service.lightStatus()` puts `consumers` and the **whole cached `WalletStatus`** into the page
snapshot (`plugin/src/service.ts:2982-3031`): `intents[].consumerId` + `payerAddress` +
`recipientAddress`, `events[].invoiceId` + `txHash` + `fromAddress`, and `receiving[]`
(`plugin/src/wallet.ts:78-93`). `writePageStatus` serialises it unchanged into
`plugin/page/status.js` with mode **0644** (`plugin/src/log.ts:81-86`). Reproduced with the same
function:

```
$ bun /tmp/…/snapshot-probe.ts
$ stat -f '%Sp' /tmp/…/page/status.js
-rw-r--r--                     # 0644
$ grep -o '"payerAddress":"0x[0-9a-f]*"' /tmp/…/page/status.js | head -1
"payerAddress":"0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
$ grep -o '"consumerId":"c1"' /tmp/…/page/status.js | head -1
"consumerId":"c1"
```

The cache is filled by `GET /wallet` (`plugin/src/service.ts:520-527`, called only from
`plugin/src/server.ts:106`), so any operator or onboarding flow that loads the wallet once makes the
next `writeSnapshot()` (supervisor state change, provider change, start) write the addresses to the
shared page file. REPRODUCED.

Who can read the file:

1. **Any local user/process**: 0644 in the plugin package directory. `state.json`, `api-token` and
   `plugin.log` are 0600. This is an asymmetric boundary, not a page-only file.
2. **Magpie's window**: the page's own sandboxed frame, `script-src` limited to the page folder,
   `connect-src 'none'` (`internal/gui/pluginpage.go:243`). No extra reader.
3. **`magpie web` (incl. `--lan`)**: plugin-page files are served *before* the web key check, with a
   per-run token in the path as the only capability (`internal/gui/web.go:211-218`). Anyone who has
   the plugin page URL (browser history, a copied URL, a support screenshot) can `GET
   …/_magpie/plugin/<token>/status.js`; the CSP is attached to the response, it does not restrict who
   may fetch it. The token is per-run and unguessable, so this is a capability-URL boundary, not a
   network guess.
4. `page/status.js` is gitignored (`plugin/.gitignore`), so it cannot be committed by accident; npm's
   `.gitignore` fallback also keeps it out of a pack. **VERIFIED** (no `files` field in
   `plugin/package.json`).

Also in the snapshot and outside the "public node state" class: `wallet.registry.networks[].endpoints`
(operator RPC URLs can carry provider API keys; `setRpcEndpoints` only checks the scheme,
`plugin/src/networks.ts:328-344`), `plugin.dataDir` (a local absolute path), `wiring` (loopback URL),
and `logs` in the API copy. `logs` is `[]` in `lightStatus`, but `GET /status` adds the raw tail (F1).

### F4 — Page permissions are the wrong class for the operator's money data (MEDIUM)

The page is a read-only renderer inside the operator's UI; it is not a publication surface. But once
the snapshot contains per-consumer balances and payment identifiers, the file becomes a *database
export* readable by any local account, by backup/indexing tools, and by a leaked capability URL in
web mode. The operator's per-consumer accounting already has a token-protected path (`GET /status`,
`GET /wallet`, `GET /wallet/intents`, and the CLI); the page does not need a second one. This is the
reason for the allowlist in §6.

### F5 — plugin options vs the CLI configuration (MEDIUM; mitigated in the uncommitted tree)

Historical risk (still the reason the rule exists): the old `index.ts` rebuilt the whole
configuration from `plugins.json` on every boot, so an empty `peers`/`publishedPorts` from a page
save could clear the CLI configuration or make `configure()` throw and leave the supervisor down —
the exact onboarding trap. Reproduced with the old expressions; a save with a name and secret but
no peers/ports produced `{peers: [], listenAddr: null, publishedPorts: []}` and
`configure()` would throw `a node that shares its Magpie must publish at least one port`
(`plugin/src/service.ts:920` in the committed tree).

**Current uncommitted tree (by another agent):** `plugin/src/index.ts` now delegates to
`plugin/src/plugin-options.ts`:

- options **seed** only a node with no configuration; an already-configured node records them as
  `migrated` and keeps `state.json`;
- a later save is applied only when its digest differs from the last applied/observed one, and only
  as a **patch of the keys that changed** (`diffPatch`), so untouched peers/ports/secret are not
  re-sent;
- booleans and integers are normalized/validated (`normalizeOptions`), and a failed apply records the
  error, does not retry the same digest, and falls back to `await service.start()` on the existing
  state (`plugin/src/index.ts:105-120`).

VERIFIED against the current working tree. Remaining risks for that owner:

- `page/options.js` (new, 0644) carries `reason`/`error` free text from `plugin-options.ts`
  `writePageOptions` **without** `redact()`; a config error is normally innocuous, but the path/URL
  scrubbing from §5 should apply there too. Audit item.
- A *deliberate* page save with empty peers/ports is still a real patch; the settings form must
  pre-fill from the applied record/`status.js` (the UI agent is being told).
- Two copies of the network secret remain (0600 `state.json` and 0600 `plugins.json`); the page's
  password field is pre-filled from `options.get()` (F7).

### F6 — Body handling: no size bound, no object check (LOW–MEDIUM) — VERIFIED, fixed in §10

`plugin/src/server.ts:138-144` reads `req.text()` unbounded and casts the parsed value. `[]`, `null`,
`"x"`, `1` are accepted as `{}`-shaped bodies by TS only; `JSON.parse("null")` then
`body as Record<string, unknown>` makes every `body.x` throw. Oversize bodies are buffered fully.
Mutations are token-gated, so this is a robustness/DoS-of-self issue, not a remote bypass. The
`/publish` route also casts `body.ports` without `Array.isArray`, and `providerInput` only checks
truthiness (no string/port types).

### F7 — A stale/foreign page capability URL exposes the network secret (LOW, by design)

The page's settings form reads `networkSecret` from `magpie.options.get()` and writes it into the
password input (`page/app.js`). In `magpie web --lan`, anyone holding the plugin page's token URL can
read it, so the plugin page URL is a capability that includes the overlay secret. This is Magpie's
own design; not changed here. Phase 8 must not put the secret into `status.js`, a QR code, a log
line, or any URL of its own. The snapshot allowlist in §6 keeps it out.

## 3. Reproduction environment (sanitized)

- `plugin/src/server.ts` imported unmodified into a temporary directory with a fake `Service` that
  returns one consumer and one intent; `startApi({ service, port: 45681 })`.
- `GET /status` without `Authorization`: 200, body contained `"payerAddress":"0x7e5f…5bdf"` under
  `"consumerId":"c1"` and the log line above.
- `GET /status` with `Host: evil.example:45681`, no `Origin`: 200.
- `GET /status` with `Origin: https://evil.example`: 403.
- `POST /configure` without token: 401.
- `page/status.js` produced by the unmodified `writePageStatus` from a `lightStatus`-shaped object:
  mode 0644, contained the payer address, the tx hash, the receiving address, an RPC URL carrying
  `SECRETKEY123`, `dataDir`, and consumer balances.

No real key, address, secret or network name from this machine was used; the addresses are the
public lab fixture `0x7e5f4552…5bdf` from `plugin/oh-my-aihub/plugin.log`.

## 4. What is explicitly not changed

- No Web console, no browser-side actions, CSP untouched, no new remote identity endpoint.
- `service.ts`, `index.ts`, `wallet.ts`, `page/`, `bin/`, existing tests: untouched. F5 is reported to
  its owner; the page UI update is the UI agent's task.
- No change to pricing, caps, ledger, admission or Magpie CLI usage.
- `/health` stays the only anonymous route, and stays `{ok:true}`.
- The authenticated API keeps returning the full status (including logs and wallet intents): the
  operator and the CLI are the legitimate readers. The page snapshot is the only projection.
- No new read-only route is needed: `GET /status` and `GET /wallet` behind the token already serve the
  operator, and the CLI can render a whitelisted statement from them.

## 5. Minimal patch set (this task)

1. `plugin/src/page-snapshot.ts` (new): schema constant, `maskSensitiveText()`, and
   `projectPageStatus()` with the §6 allowlist; no imports, so `log.ts` can use it without a cycle.
2. `plugin/src/log.ts`: `writePageStatus` writes `projectPageStatus(snapshot, s => maskSensitiveText(redact(s)))`
   atomically (temp + rename) with mode **0600**; no other change.
3. `plugin/src/server.ts`:
   - `hostAllowed(host, port)`: only `127.0.0.1:<port>` and `localhost:<port>`, port must equal the
     bound port; 403 otherwise (checked before auth).
   - keep the `Origin` refusal; add `x-content-type-options: nosniff` to JSON.
   - `GET /health` anonymous and minimal; **every other route, GET and POST, requires the bearer
     token**, compared with `timingSafeEqual`.
   - body: a streaming bounded reader stops at 64 KiB (413) even for a chunked body with no
     content-length; require `application/json` (415), require a JSON **object** (reject `null`,
     arrays, scalars) with 400; no payload echo in errors, messages redacted and truncated.
   - validate every `/configure` field by type (booleans are real booleans, ports are 1..65535
     integers, arrays are string arrays, optional strings/`null` are not coerced) and refuse unknown
     fields; the same for `/catalog/configure`, `/topup`, `/share/models` and the wallet intent
     routes. A wrong shape is a 400, never a truthy string enabled as a boolean.
   - `apiToken()` chmods an existing token file to 0600.
   - `createHandler(service, token, port)` exported for tests; `startApi` uses the port the socket
     actually bound (so `port: 0` works and the port file is truthful).
4. `plugin/scripts/boot-check.ts`: send the token on `/status` and `/checks`; assert the anonymous
   `/status` is 401 and a foreign `Host` is 403; assert `page/status.js` is mode 0600.
5. `plugin/README.md`: correct the line that says read-only GETs are open on loopback.
6. `plugin/test/security-journey.test.ts` (new): the cases in §7, written first.
7. The CLI owner's authenticated reads `GET /wallet/evidence` and `GET /wallet/statement?consumerId=…`
   are added behind the same rule; they return the service object directly (token-only, never the
   page).

## 6. Page snapshot allowlist (`schema: "oh-my-aihub/page/2"`)

Allowed: public node configuration, the peer directory, and **aggregate** node status. Forbidden:
per-consumer balances or keys, deposit orders, payer/tx linkage, receiving addresses, RPC endpoints,
local paths, raw logs.

```jsonc
{
  "schema": "oh-my-aihub/page/2",
  "generatedAt": "ISO-8601",
  "plugin": { "version": "0.4.0", "pid": 123, "startedAt": "…", "stateVersion": 3 },
  "magpie": { "version": "…", "gateway": "http://127.0.0.1:3425" },
  "config": {
    "role": "provider|consumer|null",
    "sharingEnabled": true, "sharingActive": true,
    "shareSuspended": { "at": "…", "reason": "…scrubbed…" },
    "consumingEnabled": true,
    "nodeId": "…", "hostname": "ohmyaihub-…",
    "networkName": "…", "virtualIpv4": "10.77.0.1",
    "proxyCidr": "…/32", "mappedCidr": "10.66.a.b/32",
    "publishedPorts": [3425], "secureMode": true, "rpcPort": 17888,
    "listenAddr": "tcp://0.0.0.0:11010",
    "share": { "models": ["*"] },
    "nativeProviders": ["…"], "remoteProviders": ["…"],
    "catalog": { "enabled": false, "discoveryEnabled": false, "displayName": null,
                 "contact": null, "port": 3426, "socksPort": 13400,
                 "refreshSec": 20, "minTopUpUsd": 1 }
  },
  "easytier": {
    "sharingEnabled": true, "consumingEnabled": true, "hostname": "…",
    "running": true, "pid": 123, "startedAt": "…", "restarts": 0,
    "lastError": "…scrubbed…", "coreVersion": "…",
    "networkName": "…", "virtualIpv4": "…", "proxyCidr": "…", "mappedCidr": "…",
    "publishedPorts": [3425], "secureMode": true, "socks5Port": 13400,
    "aclOk": true, "aclProblems": ["…scrubbed…"], "lastCheckAt": "…",
    "peers": [ { "hostname": "…", "ipv4": "10.77.0.2", "cost": "p2p",
                 "route": "p2p", "tunnel": null, "latencyMs": 3 } ]
  },
  "consumers": [                       // status only; no cap, used, left, ledger, calls
    { "consumerId": "alice", "models": ["provider/model"], "revokedAt": null,
      "spent": false,
      "paused": { "at": "…", "reason": "price-mismatch", "enforced": true,
                  "enforcement": "keyRevoked" } }
  ],
  "consumersSummary": { "total": 1, "open": 1, "paused": 0, "spent": 0, "revoked": 0 },
  "accounting": { "intervalMs": 10000, "maxDetectionMs": 30000, "lastCheckAt": "…",
                  "lastCheckMs": 5, "lastOkAt": "…", "failures": 0, "uncertain": false,
                  "uncertainReason": "…scrubbed…", "serving": true,
                  "paused": [ { "consumerId": "alice", "reason": "…", "enforcement": "…",
                                "enforced": true } ] },
  "providers": [ { "id": "peer-b", "remoteMagpieId": "…", "mappedCidr": "…",
                   "providerPort": 3425, "localPort": 13425, "status": "connected",
                   "detail": "…scrubbed…", "lastConnectedAt": "…", "updatedAt": "…",
                   "fingerprint": { "hostname": "…", "peerId": "…" },
                   "limit": { "spent": false } } ],          // only the flag; the
                                     // node's own remote spend is CLI accounting
  "providersSummary": { "total": 1, "connected": 1, "degraded": 0, "spent": 0 },
  "catalog": { "publishing": false, "server": { "running": false, "port": null,
               "address": null, "error": "…scrubbed…" },
               "quote": { "…the published signed quote, as-is…" } | null,
               "config": { "…as config.catalog…" }, "peers": [ "…directory view…" ],
               "lastRefreshAt": null, "refreshing": false, "error": "…scrubbed…" },
  "checks": [ { "name": "gateway-key-required", "ok": true,
                "detail": "…scrubbed…", "kind": "local", "at": "…" } ],
  "checksAt": "…", "checksDurationMs": 12,
  "readiness": { "state": "ready|degraded|blocked|unknown", "checkedAt": "…",
                 "ageMs": 0, "source": "cached|none", "reasons": ["…scrubbed…"],
                 "providers": [ { "id": "peer-b", "reachability": "reachable" } ] },
  "wallet": {                          // null when the node has no wallet
    "disabled": false,
    "networks": [ { "chainId": 97, "displayName": "…", "networkType": "testnet",
                    "enabled": true, "finality": { "mode": "confirmations",
                                                   "confirmations": 15 },
                    "cursor": 1, "lastScanAt": "…", "lastError": "…scrubbed…" } ],
    "assets": [ { "assetId": "eip155:97:0x…", "chainId": 97, "symbol": "tMOCK6",
                  "name": "…", "decimals": 6, "contractAddress": "0x…",
                  "enabled": true, "nanosPerToken": "…", "priceVersion": "…",
                  "onchainDecimals": 6 } ],
    "totals": { "credited": 0, "finalized": 0, "pending": 0, "unclaimed": 0,
                "uncertain": 0, "reverted": 0 }               // counts, not amounts
  }
}
```

Dropped from the snapshot (all present in `lightStatus()` today): `plugin.dataDir`, `logs`,
`config.peers`, `wiring`, `consumers[].keyName/keyId/capUsd/creditedUsd/usedUsd/leftUsd/calls/ledger/
priceVersion/acceptedQuoteHash`, `wallet.registry`, `wallet.intents`, `wallet.events`,
`wallet.receiving`, `wallet.anomalies[].eventId`, `wallet.chains`, `wallet.chains[].lastError` at the
top level (folded into `wallet.networks[].lastError`), every RPC `endpoints` array, and
`providers[].limit`'s money fields (`cost`, `costLimit`, `costLeft`, `calls`) — only `spent` and
`providersSummary` counts remain. The signed catalogue is projected field by field (free-text
`displayName`/`contact`/notes scrubbed) instead of passed through, so a credential pasted into a
public display field is still redacted.

`maskSensitiveText()` masks `0x`+40 hex (addresses), `0x`+64 hex (hashes/digests), `http(s)://…`
URLs (an RPC URL can carry an API key), and absolute paths (`/Users/…`, `/home/…`, `/private/…`,
`/tmp/…`, `C:\…`). It is applied to free text only (errors, details, suspension reasons, check
details); public contract addresses, the gateway URL and catalogue signatures are copied field-by-
field, not scrubbed.

## 7. Tests (written before the implementation)

`plugin/test/security-journey.test.ts`, using `createHandler()` directly (no socket, no cwd, no repo
writes):

- anonymous: `/health` 200 and exactly `{ok:true}`; `/status`, `/consumers`, `/wallet`,
  `/wallet/intents`, `/wallet/events`, `/wallet/networks`, `/wallet/assets`, `/wallet/anomalies`,
  `/providers`, `/checks`, `/accounting`, `/catalog`, `/catalog/peers` → 401; `POST /configure` → 401;
  no response body contains the fake consumer or payer address.
- Host: `127.0.0.1:<port>` and `localhost:<port>` with the token → 200; `evil.example:<port>`,
  `127.0.0.1:<other port>`, `127.0.0.1` (no port), missing → 403 even with a valid token.
- Origin: `https://evil.example` → 403 even with a valid token.
- body: `[]`, `null`, `"x"`, `1`, `true`, and invalid JSON → 400 with a message that does not contain
  the sent payload; a declared or **streamed/chunked** body over 64 KiB → 413; `content-type` other
  than JSON → 415.
- `/configure`: `sharingEnabled: "false"`, `rpcPort: "17888"`, `publishedPorts: ["3425"]`,
  `peers: "tcp://…"`, `shareModels: [{}]`, a negative `catalogMinTopUpUsd` and an unknown field are
  all 400 and never reach the service; a valid patch is forwarded unchanged.
- error redaction: a service error containing `sk-…` comes back as `<redacted-key>`, and the raw
  secret never appears in the response.
- `projectPageStatus`: given a `lightStatus` with intents/events/receiving/RPC endpoints/dataDir/
  logs/balances, the output has the `schema` marker and keeps `consumers[].consumerId/models/
  revokedAt/paused/spent`, `consumersSummary`, `accounting`, `providers`, `checks`, `readiness`, the
  catalogue, `wallet.networks/assets/totals`; it contains no `payerAddress`,
  `recipientAddress`, `txHash`, `fromAddress`, `toAddress`, `intents`, `events`, `receiving`,
  `endpoints`, `dataDir`, `logs`, `capUsd`, `usedUsd`, `leftUsd`, `ledger`, and no string matching
  `0x[0-9a-fA-F]{40}` or `https://…/v2/key`.
- `maskSensitiveText`: masks an address, a 64-hex digest, `https://…/v2/SECRET`, and `/Users/me/x`;
  leaves the field-by-field `contractAddress` untouched.

`plugin/scripts/boot-check.ts` also asserts the real file mode and the anonymous-401/foreign-Host-403
journey end to end (it already boots the real entry against a stub Magpie).

## 8. Residual risk / UNKNOWN

- **UNKNOWN**: whether every browser a Magpie user runs suppresses `Origin` for a same-origin GET
  after DNS rebinding exactly as assumed. The Host allowlist makes the answer irrelevant.
- **UNKNOWN**: no measurement of backup/sync tools that index the plugin folder; the 0600 mode and the
  allowlist bound the content either way.
- The authenticated API still returns full status, logs and wallet intents. A stolen API token is
  equivalent to the operator; this task does not add token scopes.
- `magpie web --lan` still exposes the plugin page (and its options, including the network secret) to
  anyone with the page token URL. That is Magpie's capability model (F7); Phase 8 does not widen it.
- F5's *deliberate save* path and `page/options.js` free text remain with their owner; the onboarding
  UI must not save empty peers/ports and must not display a data directory or raw logs.

## 9. Audit of other agents' new entry points (follow-up)

After their changes land, re-read the new page/CLI/host surfaces for: secret redaction (no
`networkSecret`, `sk-`, API token or consumer secret in output), retry semantics (idempotent
top-up/scan/intent, no double credit, no lost deposit on a retry), and TOFU safety (never silently
accept a changed catalogue fingerprint, never auto-trust). Findings go to the owning agent first;
this file records the final state.


## 10. Implemented on this branch (uncommitted working tree)

`server.ts`, `log.ts`, the new `page-snapshot.ts`, the new `security-journey.test.ts` and
`scripts/boot-check.ts` were changed test-first; `service.ts`/`index.ts`/`wallet.ts`/`page/`/`bin/` and
existing tests were not touched.

**`plugin/src/server.ts`**

- `Host` allowlist (`hostAllowed`): `127.0.0.1:<bound port>` or `localhost:<bound port>` only; checked
  before auth, so a rebinding page gets 403 even with a valid token.
- `Origin` refusal kept; JSON responses now carry `x-content-type-options: nosniff`.
- `GET /health` is the only anonymous route and returns exactly `{ok:true}`. **Every other GET and
  every POST requires the bearer token**, compared with `timingSafeEqual` (`tokenMatches`).
- Body: a streaming reader with a hard 64 KiB cap (a chunked body cannot grow unbounded),
  `application/json` only when a content type is sent (415), JSON **object** only — `null`, arrays and
  scalars are 400 — and no payload echo; errors are `redact()`ed and truncated to 300 characters.
- Strict runtime checks on the fields that reach state/Magpie: every `/configure` and
  `/catalog/configure` field (booleans stay booleans, ports are 1..65535 integers, arrays are string
  arrays, unknown fields are refused), `/publish` ports, `/providers/add` and `/providers/update`
  (strings + integers), consumer model arrays, `/topup` (positive finite usd), `/share/models`
  (string array), `/wallet/network` (positive integer chain id, string endpoints).
- `apiToken()` chmods an existing token file to 0600; the port file records the port the socket
  actually bound (`server.port`), so `port: 0` is truthful.
- `createHandler(service, token, port)` is exported for tests; `startApi` uses it.
- Phase-8 operator routes requested by the CLI owner, all behind the same rules:
  `GET /share/candidates` → `{candidates}`; `POST /providers/models {id}`;
  `POST /providers/reconcile {id?, verifyModels?}` → `{providers}` filtered to `id` when given;
  `POST /catalog/request` and `/catalog/connect` require `fingerprint` and `quoteHash` as 64
  lowercase hex (optional `priceVersion`) and forward them as `CatalogAcceptance`.

**`plugin/src/page-snapshot.ts`** (new) — the allowlist in §6. `maskSensitiveText()` masks `0x`+40
(address), `0x`+64 (hash), `http(s)://…` (RPC credentials) and absolute paths; it is applied to free
text only. Public contract addresses are copied field by field. Wallet is flattened to
`networks`/`assets`/`totals` (event counts); consumer balances, intents/events, receiving
addresses, RPC endpoints, `dataDir`, `wiring` and `logs` cannot appear. `providers[].limit` keeps only
`spent`; `providersSummary` carries the counts. The signed catalogue is projected field by field, with
its free-text display name/contact/notes scrubbed, rather than passed through.

**`plugin/src/log.ts`** — `writePageStatus` writes the projection with `redact()` + `maskSensitiveText`,
atomically (temp + rename) and mode **0600** (was 0644).

**`plugin/scripts/boot-check.ts`** — health is anonymous and minimal; anonymous `/status` is 401;
token `/status`/`/checks` are 200; page snapshot exists, is 0600, has the schema marker and none of
`dataDir`/`logs`/`payerAddress`/`endpoints`/`intents`.

**`plugin/README.md`** — the host-API paragraph (already updated in the shared tree) now states that
every route except `/health` needs the token and that a non-loopback `Host` is refused.

Verification run here (Bun 1.4.3, macOS 26.6.2):

```
$ bun test test/security-journey.test.ts        # 25 pass, 0 fail
$ bun test test/security-journey.test.ts test/phase8-cli.test.ts test/page-settings.test.ts
                                                # 55 pass, 0 fail
$ bun run typecheck                             # exit 0
$ bun run boot-check                            # PASS … page snapshot 0600
```

Follow-ups (status at the end of this task):

- `plugin-options.ts` `writePageOptions` — **fixed by its owner**: `page/options.js` is 0600 and
  `reason`/`error`/`problems` are `redact()`ed + `maskSensitiveText()`ed before writing.
- `bin/ohmyaihub.ts` `catalog request|connect` — still permits omitting the acceptance, which the
  service now refuses; README line ~146 still shows the old form. The new `connect` command and
  `operator-connect.ts` do it correctly (explicit fingerprint/quote, no auto-trust). CLI owner.
- Page UI — **fixed by its owner**: consumer balance columns, the data-directory row and the logs
  block are gone; the page renders only the allowlisted snapshot (see §11 for the real render).

## 11. Final read-only audit: wallet evidence/statement and the real page run

**Lab-found integration fix in `server.ts` (my file).** `Service.trustCatalogPeer` now requires the
exact 64-hex fingerprint; `POST /catalog/trust` therefore rejects a missing, wrong-case or malformed
fingerprint with 400 and type-checks before the call (it previously passed `undefined`). Covered by a
security-journey case.

**Lab-found bug fixed in `page-snapshot.ts` (my file).** `quoteView` was written for the signed
catalogue body (`schema/node/publication/…`), but `Service.catalogStatus().quote` is a **flat view**
(`version`, `updatedAt`, `publishedAt`, `contentHash`, `modelCount`, `models`, `identity`;
`service.ts:307-324,1509-1535`). The first projection would have dropped `version`/`modelCount`/
`contentHash`. It now accepts both shapes (flat node status and a peer's signed body) and the
security test covers both. VERIFIED by tests and by the service types.

**VERIFIED good**

- `walletEvidence` read-back is real: `provisioner.verify()` reads `GET /v1/magpie/limit`
  (`provisioner.ts:1062-1080`), and the evidence records a read-back only when `costLimit`, `cost`,
  `costLeft` are all numbers; a failed read is omitted, never filled with zeroes (`service.ts:660-677`).
- `walletStatement` never mixes rows: `intents` are fetched by consumer (`chainstore.ts:346-350`),
  events by the invoice→consumer join (`chainstore.ts:558-566`), deposits by consumer, and
  `buildStatement` refuses a foreign consumer record/intent/event/deposit outright
  (`walletstatement.ts:197-220`); tests cover the refusals.
- `page/options.js` is now 0600 and `reason`/`error`/`problems` go through
  `maskSensitiveText(redact(...))` before writing (`plugin-options.ts:611-636`). VERIFIED.
- The page no longer reads consumer money columns (it shows state + `consumersSummary`), and
  `renderProviders` uses only `limit.spent` + `providersSummary`. VERIFIED in `page/app.js`.

**Sent to the owning agents (not edited here)**

1. CLI/service owner — `walletEvidence` is documented read-only but `provisioner.verify()` persists
   `lastCheck` and `refreshAll()` may reconcile a pending deposit; a GET therefore writes
   `consumers.json`. Use a non-persisting `limitStatus` probe for evidence, or document the write.
2. CLI/service owner — `walletStatement` calls `walletEvidence()`, which live-reads the key limit of
   **every** consumer; the statement should look up only the named local consumer (scoped evidence).
3. CLI/service owner — `walletStatement` falls back to `evidence.wallet.receiving[0]?.providerId`
   when the consumer has no intent; that can name another provider in the statement header. Refuse or
   derive it from the consumer's own deposits.
4. UI owner — **fixed**: the `w.orders` table was removed from `page/app.js`; the snapshot has no
   `orders` and the page no longer expects one.
5. UI owner — **fixed**: the data-directory row was removed and commands use a `<magpie data>`
   placeholder; no local path is rendered or interpolated.

**Real page evidence (from the UI owner; no operator config touched; `phase8-csp.md` §10)**

- Tested on the actual **Magpie web 0.1.2171** page policy (the same `pagePolicy` function as the
  pinned 0.1.2038 source): response CSP is `sandbox allow-scripts`, `connect-src 'none'`,
  `form-action 'none'`; a Save writes `plugins.json`, the host restarts and reloads the snapshot; the
  UI suite is 70 targeted pass.
- Served a real `Service.writeSnapshot()` under that policy (static server, not a hand-made old
  snapshot). Rendered: catalogue quote `v1` with 2 models and the full `contentHash`, full fingerprint
  + TOFU label, `priceLocked: false`, a peer's signed quote `v3` with `priceVersion` and
  published/read times, a provider row showing the remote key as "还有额度", and wallet 2 networks +
  assets + event counts. **No `undefined`/`NaN`** in the projected sections; the only two `undefined`
  strings come from the host's own check-detail text (cosmetic, service owner).
- `w.orders` and the data-directory row are gone; commands use `<magpie data>`. The real page reload
  after a Save showed "host restarted, saved options re-read" only after the pid changed.
- Flat node quote has no `billing.priceVersion`, so the page shows "报价未提供" in that one column; it
  handles both flat and signed shapes. Adding a price version to the flat `CatalogStatus.quote` would
  be a `service.ts` change (owner's call), not a security defect.

**UNKNOWN / out of the tested scope**

- The desktop **WKWebView frame** itself was not run (the same `pagePolicy` function generates the
  policy for both; the evidence used `magpie web` 0.1.2171).
- Whether one Save interrupts an in-flight overlay request is not measured on two hosts.
- No per-file source diff between the 0.1.2038 pin and 0.1.2154/0.1.2171 was made; the page-policy
  behavior was measured end to end on 0.1.2171 and the source conclusion is unchanged for the pin
  (`phase8-csp.md` §10).
- Static check against a real `service.writeSnapshot()` from `test/catalog-service.test.ts` (not a
  hand-made fixture) also showed schema `oh-my-aihub/page/2`, no `plugin.dataDir`, no `logs`, no
  `wallet.orders`, and a flat quote with `version/modelCount/contentHash`.
- Full CI is the CLI owner's/main agent's run; this document records only the targeted checks in §10
  (security tests, typecheck, boot-check, secret-scan) and the UI owner's 70 targeted cases.
