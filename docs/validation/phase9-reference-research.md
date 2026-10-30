# Phase 9 reference-source research

**VERIFIED source**, unless explicitly marked otherwise. Research platform: macOS 26.6.2
(25G83), Darwin arm64, Bun 1.4.3 and Node 24.21.0. No third-party implementation was copied into
this plugin; the lifecycle and authentication ideas were independently implemented.

## Exact revisions and files read

| Source | Revision | Files inspected |
| --- | --- | --- |
| [Our Free Model](https://github.com/mu-zi-lee/magpie-our-free-model/tree/e1a9b25ddb910acaf97df09ed23e08a08b93fcc5) 0.9.2 | `e1a9b25ddb910acaf97df09ed23e08a08b93fcc5` | README.md; src/managed-console.mjs, remote-console.mjs, managed.mjs, cloudflare-console.mjs, managed-runtime.mjs; runner/ownership helpers; vendored standalone management.mjs; licenses and notice |
| [Busy Magpie](https://github.com/yimi1mi/busy-magpie/tree/5b15937308569666a89ab317f2adac1ab07467f1) 1.4.3 | `5b15937308569666a89ab317f2adac1ab07467f1` | README.md; plugin/launch.hooks.mjs, install.mjs; src/main.js, preload.js, launch-policy.cjs; web/app.js; licenses and relevant tests |
| [Magpie v0.1.2171](https://github.com/yetone/magpie/tree/244d80e23f91ab4e2b37b4e045d61fda5f7bca50) | `244d80e23f91ab4e2b37b4e045d61fda5f7bca50` | internal/plugin/{host.go,host.js,page.go,store.go,github.go}; internal/gui/{pluginpage.go,pagebridge.js,pageservice.go,plugins.go,assets/pluginpages.js,assets/plugins.js}; internal/proc/browser.go |

Magpie 0.1.2038 remains the previous host/pricing evidence baseline. Studying or displaying
0.1.2171 does not by itself prove its billing behavior. EasyTier remains pinned to 2.6.4,
`8428a89d2dabc94c97d370ec607c6ca142473626`.

## Our Free Model: useful handoff, provider-specific entry

- **VERIFIED:** `managed-console.mjs:7-45` creates a separate 127.0.0.1 handoff listener. It issues
  32-byte random tickets, limits outstanding tickets to 32, expires them after ten minutes and
  deletes the ticket before exchanging a server-held service key for an HttpOnly cookie. It checks
  Host/Origin and uses no-store/no-referrer headers. The administrative service key is absent from
  the initial URL.
- **VERIFIED:** `managed.mjs:34-44,75-82` returns that URL through a genuine provider's OAuth
  authorization hook. Magpie's `plugins.go:763-806` opens provider login URLs. This is a
  provider-only hook, not a general external-open API. Oh My AIHub must not register a fake AI
  provider to gain it, nor copy its loader/request forwarding/model admission machinery.
- **VERIFIED:** the ordinary bridge (`pagebridge.js:102-124`) exposes theme, options, permissioned
  reads and action notifications, but no external-open/host-command method. Menu actions open the
  same sandboxed page. Magpie page CSP keeps `sandbox allow-scripts` and `connect-src 'none'`.
- **VERIFIED:** the newer `magpie.page.service` route (`pageservice.go:64-129`) removes request
  Cookie and response Set-Cookie and adds a sandbox. It is an embedded service route, not a
  compatible cookie-session entry for an independent console.
- **VERIFIED:** `managed-runtime.mjs` deduplicates by runtime identity and supervises its runner
  with stdin ownership, signals and parent-death detection. `lifecycle.dispose` in OFM does not
  establish a native host lifecycle hook: this pinned Magpie host exits on stdin EOF and does not
  dispatch such a hook. Runtime ownership needs direct verification.
- **VERIFIED:** OFM's local management cookie lasts eight hours, has HttpOnly/SameSite=Strict and
  no Secure on HTTP loopback. Remote-console uses a separate Secure cookie for its HTTPS tunnel.
  Those are different deployments, not evidence that HTTP Secure cookies work everywhere.
- **VERIFIED:** the literal claim that service keys never reach browser JavaScript is too broad.
  The authenticated vendored `management.mjs:207,239-251` can return its own forwarding key; the
  remote gateway allows those management routes. Oh My AIHub exposes neither that API nor its
  own CLI Bearer token. Any Gateway Key handover needs a separate explicit private UI action.
- **VERIFIED:** Cloudflare Quick Tunnel, bundled provider engine, account channels and model
  forwarding are OFM-specific. None is required for this local browser console.

**REPRODUCED:** OFM `node --test tests/remote-console.test.mjs tests/cloudflare.test.mjs` gave
10 pass / 1 fail. The failing 400ms Quick Tunnel expiry fixture failed again in isolation with
“临时通道已关闭，请重新打开远程控制台”. A separate remote-console test passed. The short fixture's
startup/expiry interaction is **UNKNOWN** as a production cause; this is neither evidence for nor
against a real 30-minute tunnel. No real tunnel, provider login or external model was used.

## Busy Magpie: state and process boundaries

- **VERIFIED:** `launch.hooks.mjs` starts or finds the installed UI from the plugin host, without
  changing the model request. It tracks launched/installing state, uses a heartbeat, throttles
  retries and respects stopped/paused/keep-alive settings. A hidden UI and an exited UI differ.
- **VERIFIED:** `src/main.js:1258-1505` owns backend connections, reconnect backoff and watchdog;
  the renderer receives bounded projections through explicit `preload.js` IPC methods. It keeps
  connection state separate from usage freshness and retains last successful data with a stale
  indication. This is the pattern used for console polling/reconnect; no Electron IPC is copied.
- **VERIFIED:** the Electron renderer has `nodeIntegration:false` and `contextIsolation:true`,
  but `sandbox:false`. It is not evidence that browser code can safely receive full system access.
- **VERIFIED:** settings changes validate and persist before applying; busy controls and errors
  distinguish pending from successful work. Its installer, app updater, tray/widget layout and
  detached desktop executable are not part of Oh My AIHub.
- **VERIFIED:** plugin and UI lifetimes are distinct. Oh My AIHub's browser can close while the
  Magpie-owned Service/EasyTier/watchers continue, and repeated AI requests must not reopen tabs.

**REPRODUCED:** Node tests for plugin-launch, plugin-install, launch-policy and gateway-config:
24 pass / 0 fail. These use mocked process/network behavior; real Busy desktop installation and
window behavior remain **UNKNOWN** here.

## Entry consequences for this project

**VERIFIED source:** Magpie's options bridge replaces the complete plugin options object and
restarts the shared host. A busy retired host can live for up to ten minutes; loading a hosted
page warms the next host. This requires preserved options, single-owner handoff and bounded retry.
It cannot be treated as a harmless per-plugin RPC. The console uses direct Service callbacks for
ordinary business operations, reserving the official options bridge for explicit launch/approval.

**VERIFIED source:** normal installation is available in Magpie's Discover tab when its top search
is empty: bottom “Have one in mind?” form accepts an npm package, `github:owner/repo#ref` or a
folder (`assets/plugins.js:921-938,997-1023`). A repository needs a root package.json for the GitHub
package path (`internal/plugin/github.go:394`). A local folder is only the development fixture;
normal installation uses the repository address and Magpie-managed Bun, without a PATH installer.

The chosen first implementation is a host-owned numeric-loopback server and a primary native
page request that opens a short-lived ticket in the OS default browser. A separate browser
pairing fallback requires explicit matching-code approval in Magpie; it cannot turn an anonymous
localhost visit into an administrator. Its pending bootstrap may survive the intentional approval
restart, while established sessions remain bound to one host instance. Browser and lifecycle
measurements belong in the Phase 9 acceptance report, not in these source-only findings.

## Licenses and scope

Both reference roots use MIT: OFM copyright 2026 木子不是木子狸; Busy copyright 2026 Busy Magpie.
OFM's vendored runtime and Busy brand assets carry additional notices. Any future substantial
copy must preserve the relevant notices; a wrapper's MIT license does not relicense every bundled
binary or image. This implementation uses independent code and existing project assets.

No Electron, Cloudflare tunnel, fake provider, second AI gateway, extra balance database or upstream
Magpie/EasyTier modification is introduced by this architecture.
