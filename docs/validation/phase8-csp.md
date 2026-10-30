# Phase 8 — the plugin page, the official settings bridge, and CSP

**Scope.** What a Magpie community plugin's page can actually do on the Magpie we install, what
`Save` really does, which settings the official bridge supports, and what the read-only operator
page may therefore claim. This is a research record; the code that follows it is
`plugin/src/plugin-options.ts`, `plugin/src/index.ts` and `plugin/page/*`.

Everything below is tagged **VERIFIED** (read in a named file at a named version), **REPRODUCED**
(observed on this machine, command and output recorded) or **UNKNOWN** (not measured).

---

## 1. Platform and versions

| Item | Value |
| --- | --- |
| Machine | macOS (arm64), user `laysath`, 2026-10-30 |
| Installed Magpie | `/Applications/magpie.app/Contents/MacOS/magpie`; `magpie --version` printed `magpie 0.1.2120` when the source research began (2026-10-30 14:07), and the app updated itself during the work: the browser acceptance runs below report the revision they actually ran (§10.1) |
| Tag `v0.1.2120` | `eed140c4d9a7916a77e382d8a9c8b3f071f602b2` (annotated tag object `6d89fe26ab0a9d813da1fbb91bcf3b06aa7b8a48`, tagged 2026-10-30T01:24:04Z) |
| Pinned price/billing version | `v0.1.2038` = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876` — **unchanged by this phase** |
| Local upstream source used for reading | `/Users/laysath/Projects/lab/magpie-upstream` = `0745db93` (`v0.1.2051-1-g0745db93`) |
| Plugin under test | this repository, `@oh-my-aihub/magpie-plugin` 0.4.0 |

### 1.1 The page-facing files did not change across these versions

`cmp` on the files fetched from each tag (`https://raw.githubusercontent.com/yetone/magpie/<tag>/<path>`):

Each file was fetched from each tag and compared byte for byte (`cmp`). "same" means identical to
the file in the other two places:

| Path | v0.1.2038 | v0.1.2120 | local 0745db93 |
| --- | --- | --- | --- |
| `internal/gui/pluginpage.go` | same | baseline | same |
| `internal/gui/pagebridge.js` | same | baseline | same |
| `internal/plugin/page.go` | same | baseline | same |
| `internal/plugin/store.go` | same | baseline | same |
| `internal/plugin/host.js` | same | baseline | same |
| `internal/plugin/host.go` | same | baseline | same |

**VERIFIED.** The page, the bridge, the options write path and the host restart path are
byte-identical in the version Phase 5–7 were verified against and the version installed here.
The pricing/billing pin stays at **0.1.2038**; 0.1.2120 is the *UI/bridge* version measured here.

### 1.2 The installed binary carries the same policy (REPRODUCED)

```sh
B=/Applications/magpie.app/Contents/MacOS/magpie
for s in "connect-src 'none'" "sandbox allow-scripts" "form-action 'none'" \
         "a page sets its options once a second at most" "plugin-pages/options" "options.set"; do
  printf '%-50s' "$s"; LC_ALL=C grep -c -a -F "$s" "$B" >/dev/null && echo FOUND || echo MISSING
done
```

```
connect-src 'none'                                FOUND
sandbox allow-scripts                             FOUND
form-action 'none'                                FOUND
a page sets its options once a second at most     FOUND
plugin-pages/options                              FOUND
options.set                                       FOUND
```

`LC_ALL=C grep -a -o 'v0\.1\.21[0-9][0-9]' "$B"` → `v0.1.2120` only: the running app is that build.

---

## 2. What the official bridge gives a page

`internal/gui/pagebridge.js` (v0.1.2120, `window.magpie`):

| API | Behaviour | Used by this plugin |
| --- | --- | --- |
| `magpie.ready` / `theme` / `onTheme(fn)` | the window's theme, once it answers `hello` | yes (automatic) |
| `magpie.options.get()` | this plugin's entry in `plugins.json` | yes |
| `magpie.options.set(obj)` | **replaces** that entry wholesale, answers with the stored object | yes |
| `magpie.read(name, params)` | only `providers:list`, `usage:summary`, and only if `package.json`'s `magpie.permissions` declares them | no (`permissions: []`) |
| `magpie.context` | `{provider:{id,name}}` inside a provider editor's panel; `{}` on a page | no |
| `magpie.service` | address of the page's own local service — **only under `magpie web`**; `""` in the desktop window and on an old magpie | no |
| `magpie.onAction(fn)` | a pick from `magpie.actions` | no |

There is **no** event, call or postMessage by which a page asks the host to do something, and
nothing the page can call to learn the host's state. **VERIFIED** in the whole of `pagebridge.js`.

---

## 3. CSP: `connect-src 'none'` and its consequences

`internal/gui/pluginpage.go` `pagePolicy()`, sent as `Content-Security-Policy` on every page asset
(`h.Set("Content-Security-Policy", pagePolicy(r, tok))`):

```
sandbox allow-scripts
default-src 'none'
script-src <host>/_magpie/plugin/<token>/
style-src <host>/_magpie/plugin/<token>/ 'unsafe-inline'
img-src <host>/_magpie/plugin/<token>/ data:
font-src <host>/_magpie/plugin/<token>/
media-src <host>/_magpie/plugin/<token>/
connect-src 'none'
frame-src 'none'
worker-src 'none'
object-src 'none'
form-action 'none'
base-uri 'none'
frame-ancestors 'self'
```

Consequences, all of which the page must be written around:

1. `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` — all blocked. The page
   cannot reach the loopback API, not even `127.0.0.1`.
2. `form-action 'none'`: a real form submission navigates nowhere. The current page's
   `preventDefault()` is not cosmetic, it is required.
3. `frame-src 'none'`: no nested frames.
4. Scripts must be files under the page's own folder — an inline `<script>` is refused. Inline
   `<style>` and `data:` images are fine.
5. `sandbox allow-scripts` **without** `allow-same-origin`: the frame's origin is opaque, so
   `localStorage`, `sessionStorage` and `document.cookie` throw or are absent. State cannot be
   carried across a reload by storage.
6. The frame talks to the window by `postMessage`; the window answers only its own frame
   (`ev.source`) and only the methods above.

`apiFramed()` additionally refuses every `/api/` request a sandboxed frame or another site could
send (`Origin: null`, a frame destination, a cross-site subresource). The desktop window's `/api`
has no key, so this is the guard that keeps a plugin page out of it.

---

## 4. `Save` and `Reload`: the real chain (VERIFIED, line by line)

```
page: magpie.options.set(next)
  → postMessage {magpie:1, id, method:"options.set"} → the window (its own frame only)
  → POST /api/plugin-pages/options            (pluginpage.go L448)
      · spec bound by the window, not by the page
      · at most once a second per plugin, else 429
      · plugin.SetPageOptions(spec, opts)     (plugin/page.go L342)
          ├─ a plugin whose page/panels are all it has: write plugins.json, host untouched
          └─ anything with a host part (ours): SetOptions()   (plugin/store.go L677)
                · replaces `plugins.json`'s options for this spec
                · Restart()                                    (plugin/host.go L690)
                    · current = nil; a busy host is retired after its calls (≤10 min)
                    · otherwise stop(): close the host's stdin, wait stopWait = 2s,
                      then Kill() (SIGKILL)                    (plugin/host.go L800-L810)
```

The host process exits on its own when stdin closes and nothing is pending
(`host.js`, `if (--pending === 0 && closed) process.exit(0)`), which runs this plugin's
`process.on("exit")` handler and therefore `SIGTERM`s the EasyTier core it started
(`plugin/src/index.ts`, `shutdown`).

So one `Save` from the page means, on a real node:

1. `plugins.json` is replaced with what the page sent;
2. **every** Bun-host plugin is restarted (the host is shared, not per plugin);
3. the EasyTier core is stopped (or, if the host was killed after 2s, is left for the next host
   to adopt) — the overlay, its port forwards, the mapped prefix and the ACL config are rebuilt;
4. the loopback operator API dies with the host;
5. the host comes back **only when something asks it**. Opening the plugin page warms it
   (`pageHost`, `host.go` L762 + `pluginpage.go` L272-L300: served because our plugin has a host
   part, waiting at most 7s), and so does a Magpie restart. Nothing else does;
6. while it is down, `bun plugin/bin/ohmyaihub.ts …` fails to connect (`api-port` points at a dead
   port).

Options reach the plugin at load time, confirmed end to end:
`host.go` puts `e.Options` in the `init` payload (`Options map[string]any \`json:"options,omitempty"\``,
`items = append(items, item{e.Spec, Target(e.Spec), e.Options, …})`), and `host.js` calls
`await fn(input, p.options)`.

**Therefore the old page text — "Saved. Restart magpie (or reopen this page) so the host reads
them." — is wrong on both counts:** Magpie does not need restarting, and the sentence hides that the
overlay and the operator API dropped.

**UNKNOWN (not measured in this phase):** whether a `Save` during an in-flight overlay request
drops that request. The mechanical stop is source-verified; a two-host interruption measurement is
not.

---

## 5. Which settings the official mechanism supports

| Operation | Official path | Page? |
| --- | --- | --- |
| The plugin's own options object | `magpie.options.set` (page), `magpie plugin options <name> <json>` (CLI), `plugin.SetOptions` | page: yes, but wholesale |
| Magpie's Plugins-page "Options" editor | rendered **only** for middleware / gateway plugins (`assets/plugins.js`: `if ((e.isGateway \|\| (mw && !mw.error)) …)` with `mw = e.middleware`) | **not for us** — this plugin is host + page, no middleware, no gateway hook |
| Sharing on/off, share-model policy, published ports, catalogue publish/discover/trust/connect, remote providers, consumer keys, credit, wallet | **none** — CLI and the loopback API only | no |
| `magpie.service` (page → its own loopback service through Magpie) | `magpie web` only; the desktop window gets `""`, and this plugin's API rejects any request with an `Origin` header | no |

**VERIFIED.** There is no supported way for a page to change this plugin's state on the desktop.
Anything the official mechanism cannot do is printed as a copyable CLI line, never as a button that
does nothing.

---

## 6. Existing entry points, as they are today

`plugin/page/index.html` + `app.js` (0.4.0):

| Section | Source | Problem found |
| --- | --- | --- |
| Status | `status.js` snapshot | Prefilled from `plugins.json`, not from what is running; no timestamps; no local/remote distinction; an unconfigured node reads `ACL FAILED: ` (empty detail) |
| This node (form) | `magpie.options.get/set` | **replaces** options: `role`/`rpcPort`/`apiPort` are dropped, `networkSecret` is sent as `""` when the field is empty, and untouched CLI-owned values (`sharingEnabled`, `shareModels`, `catalogEnabled`) are re-sent as if the page owned them |
| Catalogue | snapshot | fingerprint truncated to 16 chars, no `priceVersion`, no `priceLocked: false`, no TOFU state |
| Peer directory | snapshot | same truncation; `quote` shown without `priceVersion` |
| Testnet credit | snapshot `wallet` | `wallet` is a *cache* filled only by a status/wallet call — `boot` never fills it, so a running node shows "no chain wallet on this node" (a false statement) |
| Operations | static text | a wall of commands, unrelated to the state above it |

### 6.1 The real "options overwrite CLI state" bug

`plugin/src/index.ts` (0.4.0) computed `fromOptions` from `plugins.json` and, whenever it differed
from the stored config, called `service.configure(...)`. On every host start. Consequences:

- a `networkSecret` left in `plugins.json` from an earlier page save silently **reverts** a later
  `configure --secret …`, disconnecting every peer;
- `sharingEnabled: true` in options reverts `share off`;
- `shareModels`/`publishedPorts`/`catalogEnabled` in options revert `share models`, `publish`,
  `catalog publish off`;
- and every such revert restarts the EasyTier core (config changed).

This fires with the page closed and with no user action, which is why fixing the page's `Save`
alone would not have been enough.

---

## 7. Decisions for phase 8

| # | Decision | Why |
| --- | --- | --- |
| D1 | `plugins.json` options seed a **new** node only (`config === null`); an already-configured node's network settings are read-only in the page, with the CLI shown | removes the silent revert of `configure`/`share`/`consume`/`publish` |
| D2 | A genuine save is detected by comparing the options' **digest** with the digest this host last applied/observed, stored in `oh-my-aihub/applied-options.json`; the first time that file is missing, the existing state wins and the event is recorded (never applied) | "real user save" vs "stale blob", without guessing |
| D3 | A detected save is applied as a **patch**: only keys whose value differs from the applied snapshot go to `configure`, so an untouched secret or untouched ports are never re-sent | one edit cannot clobber the rest |
| D4 | The page's own mutable settings are **display preferences** (`pagePrefs`), saved through the official bridge; the page applies them itself and the host ignores them | `Save` stays a real, observable write on a configured node without touching the overlay |
| D5 | After onboarding the page is read-only for state, and every state change is a copyable CLI line; there are no fake buttons | the official mechanism cannot do it (§5) |
| D6 | `Save` reports exactly one of: saving → **submitted, unverified** → (after reload) **verified by pid/startedAt change** or **not verified**; a timeout says "cannot be confirmed here", never success or failure | the page cannot reach the host; claiming either would be a lie |
| D7 | The page never displays a Gateway Key, the network secret, the API token, or a consumer↔payment-address association | the snapshot file is a plain file on disk (0644) and the page is screenshot-able |
| D8 | Nothing new listens, no second web console, CSP untouched, `magpie web`'s service bridge unused | keeps every ACL/listener invariant of phases 3–7 |

### 7.1 Restart wording (exact, used by the page)

> Saving writes this plugin's options and makes Magpie restart the plugin host — the Bun process
> every plugin shares. The host stops the EasyTier core it started, so the overlay and the local
> operator API disappear for a few seconds, and Magpie starts the host again only when something
> asks it (opening this page does). Then reload this page: `pid` and `startedAt` in Status prove
> whether the restart really happened.

---

## 8. Snapshot field protocol (contract with the other agents)

The page reads only what is listed here and renders `未提供` (not provided) for anything missing.
`service.ts` (readiness, cached checks, wallet summary), `log.ts` (allowlist projection) and
`wallet.ts`/`walletview.ts` (pure projection) own the producing side; this list is the requirement.

```ts
type Snapshot = {
  generatedAt: string
  plugin: { version: string; pid: number; dataDir: string; startedAt: string; stateVersion: number }
  magpie: { version: string; gateway: string }

  // what this page wrote / what the host applied — NEW
  optionsApplied?: {
    at: string
    digest: string                       // sha256 of the owned keys, hex
    source: "seed" | "patch" | "migrated"
    drift: boolean                       // options changed since, deliberately not applied
  }
  secretSet?: boolean                    // NEW: never the value

  config: {
    role: "provider" | "consumer" | null
    sharingEnabled: boolean; sharingActive: boolean
    shareSuspended: { at: string; reason: string } | null
    consumingEnabled: boolean
    nodeId: string | null; hostname: string | null
    networkName: string | null; peers: string[]; listenAddr: string | null
    virtualIpv4: string | null; proxyCidr: string | null; mappedCidr: string | null
    publishedPorts: number[]; secureMode: boolean; rpcPort: number | null
    share: { models: string[] }
    nativeProviders: string[]; remoteProviders: string[]
    catalog: { enabled: boolean; discoveryEnabled: boolean; displayName: string | null;
               contact: string | null; port: number; socksPort: number; refreshSec: number;
               minTopUpUsd: number }
  }

  easytier: { running: boolean; pid: number | null; coreVersion: string | null; restarts: number;
              lastError: string | null; networkName: string | null; hostname: string | null;
              virtualIpv4: string | null; proxyCidr: string | null; mappedCidr: string | null;
              publishedPorts: number[]; peers: { hostname: string; ipv4: string; cost: string;
              latencyMs: number }[]; secureMode: boolean; socks5Port: number | null;
              aclOk: boolean; aclProblems: string[]; lanIp: string | null; lastCheckAt: string | null }

  consumers: { consumerId: string; models: string[]; capUsd: number; usedUsd?: number;
               leftUsd?: number; ledger?: { balanceUsd: number; uncertain: boolean;
               openSettlements?: number; gaps?: { resolvedAt?: string }[] };
               calls?: number; spent?: boolean; revokedAt?: string | null;
               paused?: { reason: string; enforcement: string; enforced: boolean } | null }[]

  accounting: { intervalMs: number; maxDetectionMs: number; lastCheckAt: string | null;
                lastCheckMs: number | null; lastOkAt: string | null; failures: number;
                uncertain: boolean; uncertainReason: string | null;
                paused: { consumerId: string; reason: string; enforcement: string; enforced: boolean }[];
                serving: boolean }

  providers: { id: string; remoteMagpieId: string; mappedCidr: string; providerPort: number;
               localPort: number; url: string; keyRef: string; status: string;
               detail: string | null; fingerprint: { hostname: string; peerId: string | null } | null;
               limit: { period?: string; calls?: number; cost?: number; costLimit?: number;
                        costLeft?: number; tokens?: number; spent?: boolean; reset?: string } | null;
               createdAt: string; updatedAt: string; lastConnectedAt: string | null }[]

  catalog: { config: {…as above}; publishing: boolean;
             server: { running: boolean; port: number | null; address: string | null; error: string | null };
             quote: { version: number; updatedAt: string; publishedAt: string; contentHash: string;
                      modelCount: number; models: CatalogModel[];
                      identity: { fingerprint: string; keyId: string; publicKey: string } | null } | null
             peers: { hostname: string; virtualIpv4: string; mappedCidr: string | null;
                      catalogPort: number | null; route: string; latencyMs?: number; tunnel?: string;
                      status: string; detail: string | null;
                      identity: { keyId: string; fingerprint: string; publicKey: string } | null;
                      pendingFingerprint: string | null;
                      quote: { publication: { version: number; updatedAt?: string };
                               billing?: { priceVersion?: string | null; priceLocked?: false };
                               models: CatalogModel[] } | null }[]
             lastRefreshAt: string | null; refreshing: boolean; error: string | null }

  // NEW: every check carries where its evidence came from
  checks?: { name: string; ok: boolean; detail: string; kind?: "local" | "remote"; at?: string }[]

  // projection only: no payerAddress, no per-consumer tx, no receiving addresses
  wallet?: { disabled: boolean
             networks: { chainId: number; displayName: string; networkType: string; enabled: boolean;
                         finality: { mode: string; confirmations: number };
                         head?: number | null; finalizedBlock?: number | null;
                         cursor?: number | null; lastScanAt?: string | null; lastError?: string | null }[]
             assets: { assetId: string; chainId: number; symbol: string; decimals: number;
                       contractAddress: string; nanosPerToken: string; priceVersion: string;
                       enabled: boolean; onchainDecimals?: number | null }[]
             totals: { credited: number; finalized: number; pending: number; unclaimed: number;
                       uncertain: number; reverted: number } }

  logs?: string[]                        // redacted tail, optional
}
```

`CatalogModel.pricing` already carries `source`; a quote's `billing` carries
`priceVersion` and `priceLocked: false` (`catalog.ts` rejects any other value). The page prints
`priceVersion` (full, or `—`) and always `priceLocked: false` next to it, and the **full**
fingerprint (`identity.fingerprint`, 64 hex) with its TOFU state, never a truncated one.

---

## 9. How the page was verified in a real browser

An isolated Magpie configuration only — the user's running Magpie (pid 11599, `~/.config/magpie`)
is never written to:

```sh
export HOME=/tmp/magpie-iso-home            # Magpie reads $HOME/.config/magpie
magpie plugin list                           # "No plugins." → isolation confirmed
magpie plugin add /…/magpie-oh-my-aihub-import/plugin
MAGPIE_WEB_KEY=… magpie web --addr 127.0.0.1:34599 --no-open
```

`magpie web` serves the same window in a browser through the same `pluginPageRoutes`, so the page
is loaded with the real CSP and the real bridge. Then, in ego-browser: open the printed URL, open
Plugins → Oh My AIHub, and check

- the page renders with **no CSP violation** in the console (`connect-src`, `form-action`,
  inline-script refusals are all observable there);
- `Save` on an unconfigured node writes `plugins.json` (read back with
  `HOME=… magpie plugin options <spec>`), the host restarts (`pid` changes), and the page's
  verification line says so;
- a second `Save` with nothing edited sends nothing (no restart);
- a save with the secret field left blank keeps the stored secret (read back again);
- `Reload` shows the new snapshot, and the page's `pid`/`generatedAt` changed.

Results of that run are recorded in §10.

**UNKNOWN / not measured here:** the desktop WKWebView frame itself (this run uses
`magpie web`). The policy is identical (`pagePolicy`), and the only difference is the scheme of
`script-src`, which `ownWindow` adds for the native window.

---

## 10. Browser and rendering run

### 10.1 What actually ran (the binary is not the tag)

The app updates itself, so the version a browser run sees is recorded separately from the source
research. Nothing below equates a tag with a binary revision.

| Moment (local, 2026-10-30) | Revision reported by the running binary | What it was used for |
| --- | --- | --- |
| 14:07 | `magpie 0.1.2120` | `magpie --version`, binary string probe (§1.2) |
| ~15:20 | `magpie 0.1.2154` | first isolated `magpie web` run; seed path exercised, EasyTier download failed on a TLS error, `configure` rolled back |
| 15:30–15:34 | `magpie 0.1.2171` | the acceptance runs in §10.2/§10.3 |

The page-facing source is byte-identical across 2038/2051/2120 (§1.1); 0.1.2154 and 0.1.2171 were
not diffed file by file, they were measured end to end. **UNKNOWN:** a source diff for 2154/2171.

### 10.2 CSP and Save → host restart, in a real browser (PASS)

An isolated profile only (`HOME=/tmp/…`, package copied to `/tmp/phase8-pkg` so the user's
`~/.config/magpie` and the repository were never the served package):

```sh
HOME=/tmp/magpie-phase8b-home OH_MY_AIHUB_MAGPIE=/Applications/magpie.app/Contents/MacOS/magpie \
  MAGPIE_WEB_KEY=… magpie web --addr 127.0.0.1:34601 --no-open
```

The header the browser received on the page (curl to the same tokenised URL, 0.1.2171):

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src 127.0.0.1:34601/_magpie/plugin/<token>/;
  style-src … 'unsafe-inline'; img-src … data:; font-src …; media-src …;
  connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none';
  form-action 'none'; base-uri 'none'; frame-ancestors 'self'
```

Measured in ego-browser inside Magpie's real sandboxed frame:

- the page renders and every script runs (all content is JS-drawn, so a blocked `script-src` would
  have shown an empty page);
- **a `<button type=submit>` in this frame focuses and fires nothing.** With
  `sandbox allow-scripts` and no `allow-forms`, the form submission algorithm stops before the
  `submit` event: no event, no navigation, no error, no CSP report. The first version of this page
  therefore had a Save that did nothing. Save is now a plain `type="button"` with a click handler,
  and the page test asserts it (`page-settings.test.ts`, "Save is a plain button").
- Save wrote `plugins.json` (`pagePrefs.showAdvanced: true`, and nothing invented: no
  `networkName` was added from an empty field) and the host restarted (new `pid`, new
  `startedAt`; `apply` log line at 15:33:57 against 15:30:49);
- after the automatic reload the page compared the pid it had saved with the fresh snapshot and
  said **"宿主已重启，保存的选项已重读 — 保存前 pid 86260，现在 91553"**. It never claims success
  before that comparison; a slow first start shows "宿主还没写出新快照" and stops after 6 tries
  with "无法在本页确认", not "failed".
- the options file the host writes is now **0600** (`page/options.js`), like `status.js`; free text
  in it is masked (`<path>`, `<url>`, `<address>`) and bounded.
- the second Save with nothing edited sends nothing (the button is disabled): no pointless host
  restart.

### 10.3 Rendering the projected snapshot with content (PASS, one field gap)

`page/status.js` is rewritten by the host on every accounting tick, so a hand-placed file is
clobbered within seconds. The rendering check therefore used two pieces:

1. a **real `Service.writeSnapshot()`** with test doubles (fake Magpie, supervisor, probes and a
   wallet stub) driven to a configured sharing+consuming node, one consumer, one remote provider, a
   published catalogue and two testnet networks — the resulting `status.js` was `schema
   "oh-my-aihub/page/2"`, 1 consumer, 1 provider, `quote.version 1 / modelCount 2`, 2 wallet
   networks, 17 checks, and it contained none of the harness's payer address, Gateway Key, absolute
   path or RPC URL;
2. a static server that serves the package's `page/` with **Magpie's exact policy**, so the file
   cannot be rewritten mid-test (a peer entry was appended to the same document to exercise the
   signed-quote path; the peer view had the projection's own shape).

In ego-browser, with no `undefined`/`NaN` outside one host-supplied check string:

| Section | Rendered |
| --- | --- |
| first screen | "已接入 phase8-lab：正在共享这台 Magpie，正在使用 1 台远端 Magpie（1 台最近一次远端实测可用）" |
| sharing | 开关 开 / 实际在服务 是 / 没有撤下 — three separate rows, each tagged 本地 |
| consumers | "共 1 把：可用 1、暂停 0、用完 0、撤销 0"; no money columns |
| remote providers | one row \(peer-b\), status tagged 远端实测 with its timestamp, forward/registered tagged 本地, the key column reads **还有额度** (not 0, not undefined) |
| catalogue | 引用版本 **v1 · 2 个模型**, 内容摘要 **full 64-hex contentHash**, 报价时间, identity with the **full** fingerprint and TOFU note, `priceLocked: false` on every model, "报价到期 … UNKNOWN" |
| peer quote | v3 · 1 个模型 · full priceVersion · `priceLocked: false` · 发布/读取 times · "无到期时间（UNKNOWN）" |
| wallet | 2 networks with finality mode and cursor, one test asset with its on-chain decimals, totals 3/1/2/0/0/0 |

**Field gap, and what happened to it.** At the time of the run above (0.1.2171) the *local* (flat)
quote carried no `billing`, so the model table showed "报价未提供" in its price-version cell while a
peer's signed quote did show one. That is what the browser saw; it is not re-verified in a browser
afterwards. The projection owner has since added the quote's own billing to the flat view
(`plugin/src/service.ts` `catalogStatus()`: `billing: { ...this.catalogQuote.billing }`, comment
"the page needs the quote's real billing"), and `plugin/test/catalog-service.test.ts` now asserts
`st.quote!.billing.priceVersion === quote.billing.priceVersion`, `priceLocked === false` and
`quoteOnly === true` — a model with no price keeps `priceVersion: null`, which the page still shows
as "报价未提供" on purpose. The page needed no change for this: it already reads
`quote.billing.priceVersion` and falls back to the model's own `pricing.priceVersion`. **UNKNOWN:**
that the fixed field reaches a browser — this was verified by source and test, not by re-running the
browser acceptance.

`publication` is `null` on the flat quote, so the page reads the flat `version`/`updatedAt` through
`quoteVersion()`/`quotePublishedAt()`; the first page version crashed on `quote.publication.version`
and that is fixed.

### 10.4 The crash boundary the review found (fixed)

A `pending` record exists so a crash before `Service.configure` is retried, but the first version
wrote it with `applied` already set to the **new** options. On the next boot the node is configured,
the digest matches, and the diff against `applied` is empty — so the real patch was dropped for good.
Only a finished, successful `configure` may advance `applied` now:

- the `pending` record and a *failed* attempt both keep the **previous** `applied` snapshot
  (`withPreviousApplied`), so the retry re-derives the same patch (only the changed keys);
- the `done` record after a successful `configure` advances `applied` to the candidate;
- a "preferences only" / "migrated" record also keeps the previous snapshot, so the meaning of
  `applied` is always "the configuration that is running", never "what plugins.json says".

Covered by `plugin-options.test.ts` §"a crash between the pending write and Service.configure": an
existing node with old network/peers, a save of new peers, a pending write, a crash, a restart →
the same `peers`-only patch; after success nothing is left to do; a failed patch retries the same
patch; the same crash on a first run still seeds.

### 10.4 Cleanup

- the two `magpie web` instances, the static server and their hosts were stopped;
- `/tmp/magpie-phase8-home`, `/tmp/magpie-phase8b-home`, `/tmp/phase8-pkg`,
  `/tmp/phase8-static-page` and the harness scripts were removed;
- `plugin/page/status.js` and `plugin/page/options.js` are generated, are in `.gitignore`
  (`**/page/status.js`, `**/page/options.js`), are absent from `npm pack` (`package.json`'s
  `files`), and are not committed;
- the user's `~/.config/magpie` and the running Magpie were never the profile under test.

---

## 11. What phase 8 changes, and what it deliberately does not

Changed, and only these:

- `plugin/src/plugin-options.ts` (new): key ownership, digest, patch, the applied-options record.
- `plugin/src/index.ts`: the options rule (seed / patch / migrate / drift) instead of
  "options win on boot".
- `plugin/page/*`: read-only six sections, first-use wizard, copyable CLI, explicit restart and
  save-verification wording, preferences through the official bridge.
- `plugin/test/plugin-options.test.ts`, `plugin/test/page-settings.test.ts` (new).

Not changed: `server.ts`, `log.ts`, `service.ts`, `wallet.ts`, `chainstore.ts`, `bin/*`, any
listener, any ACL rule, the CSP, the Magpie pin, the ledger.
