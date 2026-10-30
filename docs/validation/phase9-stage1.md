# Phase 9 — entry/session slice acceptance

**REPRODUCED, stage 1 only.** Magpie 0.1.2171 on macOS 26.6.2 (25G83), arm64;
real Magpie-managed Bun 1.4.4; real EasyTier 2.6.4 (`8428a89d`); deterministic local model fixture.
This proves browser entry, sessions, real network configuration and safety readback. It does not
claim that sharing/approval/connection/wallet UI or the final no-CLI MVP journey is complete.

## Prerequisite and installed source

PR #12 was reviewed and repaired at `1897e243a2fda9ffbcc3fd7e5e2c067038c2ebb9`, then merged **with
explicit user authorization** as `98056d7b17cf6292f9f7db6028d41a1125ddb2bc`. Phase 9 branches from
that main commit. Source was still a working tree at this measurement; exact copied production
hashes are in [stage1-provider-manifest.json](lab/phase9/evidence/stage1-provider-manifest.json).
The final Phase 9 commit must be re-verified separately.

Each lab node has its own copied Magpie app, portable data, home, plugin package and verified
EasyTier cache. The provider fixture has a mock native model and LAN Gateway configuration;
**the fixture did not install the plugin or configure the P2P network**. No user Magpie profile,
real vendor account, wallet private key or chain transaction was used.

## Visible actor path

**REPRODUCED in Chromium through ego-browser task space 21:**

1. Open the fresh provider's actual Magpie web UI, bound only to `127.0.0.1:42743`.
2. In Plugins → Discover, clear search, use the bottom “Have one in mind?” installer and click
   Install. This run uses the per-node copied root package as a maintainer fixture; normal GitHub
   repository installation is a separate packaging acceptance item.
3. Open Oh My AIHub in Magpie's sidebar. The real sandbox/CSP page displays host status and
   “打开控制台”. No custom Provider or relaxed Magpie CSP is used.
4. Click “打开控制台”. The official options bridge saves a non-secret request, the plugin host
   restarts/warms, and its fixed OS argv opener opens the **actual default Google Chrome**.
   The window showed the authenticated welcome screen with Magpie 0.1.2171/plugin 0.5.0; the URL
   had already lost its ticket fragment. [Native-browser screenshot](phase9-browser/native-default-chrome-welcome.png).
5. Open the displayed ordinary console origin in a separate ego Chromium page. It is anonymous
   and offers pairing; no private state is available. Click “配对此浏览器”.
6. Return to Magpie, refresh the plugin page, compare the same complete eight-digit code, tick
   the confirmation checkbox and click “批准此浏览器”. The official save restarts the host;
   the waiting browser exchanges its in-memory secret for a new host-instance cookie session.
7. Use the welcome wizard to choose sharing, enter the private network invitation, explicitly
   enable a network listener and choose the isolated catalogue ports. Click Save. This calls
   production `Service.configure`, starts the real pinned EasyTier core and persists the network.
8. The console reports actual checks: core running, Inbound Drop/Forward allowlist ACL, gateway
   without a Key returns 401, mapped address, published gateway and native-only sharing guard.
   The native provider is the pre-existing fixture; setup adds no model provider.

No actor step above ran an operator CLI, called HTTP admin manually or edited JSON/SQLite. The
agent's browser automation sends normal clicks and form inputs. Maintainer fixture preparation
and source-copy restarts are recorded separately, not counted as normal user actions.

**REPRODUCED in WebKit 27.2, Playwright 1.64.1:** the actual Magpie page and actual console completed
anonymous pairing → explicit matching-code approval → new host session → visible configuration
write (toggle consuming independently of sharing) → refresh resumes current session → logout →
refresh remains unauthorized. [Six-step result](phase9-browser/webkit-stage1.json),
[light](phase9-browser/webkit-stage1-provider.png), [dark](phase9-browser/webkit-stage1-dark.png),
[mobile](phase9-browser/webkit-stage1-mobile.png). The first automation attempt read the code before
its asynchronous response and failed; [failure retained](phase9-browser/webkit-stage1-failure.json).
The script now waits for a rendered eight-digit code. No product bypass was added.

Reproduction (maintainer only):

```sh
python3 docs/validation/lab/phase9/harness.py prepare --nodes 3
python3 docs/validation/lab/phase9/harness.py start --runtime /tmp/<lab>/runtime.json --node provider
# Actor installs via Magpie UI and opens/configures the console as above.
cd plugin
bun scripts/console-webkit-stage1.ts /tmp/<lab>/runtime.json ../docs/validation/phase9-browser
```

## Cookie experiment: localhost HTTP is browser-dependent

The production session transport was started twice on numeric loopback HTTP, once with Secure and
once without it. A minimal fixture page exercised normal same-origin session exchange and private
state read. No product credentials were used. Both engines considered the origin a secure context,
which did **not** mean equal Secure-cookie behavior:

| Browser | Cookie | Exchange | Subsequent private state |
| --- | --- | --- | --- |
| Chromium 156 (ego) | HttpOnly, SameSite=Strict, no Secure | 200 | 200 |
| Chromium 156 (ego) | HttpOnly, SameSite=Strict, Secure | 200 | 200 |
| WebKit 27.2 | HttpOnly, SameSite=Strict, no Secure | 200 | 200 |
| WebKit 27.2 | HttpOnly, SameSite=Strict, Secure | 200 | **401; cookie not accepted** |

Raw sanitized results: [Chromium](phase9-browser/chromium-cookie.json),
[WebKit](phase9-browser/webkit-cookie.json). Production therefore uses HttpOnly/SameSite=Strict
without Secure **only on its exclusively 127.0.0.1 HTTP listener**, with exact Origin/Host/port,
custom read header and CSRF checks. It does not apply this policy to any public HTTP deployment.
Cookies are scoped `/ui/`; the stable per-port name overwrites obsolete cookies on reauthorization.
Random session IDs and the in-memory map bind authority to the current host instance.

## Security/lifecycle evidence and limits

**REPRODUCED automated regressions:** 256-bit single-use ticket expiry/replay/capacity, independent
Cookie/Bearer boundaries, exact Host/Origin/Fetch Metadata/CSRF, anonymous private reads, session
idle/absolute timeout/logout/restart, operation idempotency and capacity, request/result limits,
static-path allowlist and traversal/symlink checks. Pairing tests cover hash-only private journal,
manual code approval, expiration, wrong secret, consumption before session creation, replay after
restart, malformed journal and failed durable writes. These unit/integration tests are separate
from actual browser behavior.

The actual stage-1 tree's local `bun run ci` passed **647 tests, 0 failures, 5014 assertions across
42 files**, plus typecheck, boot-check and secret scan. Later stage changes have their own counts.
Linux/macOS GitHub CI for the final Phase 9 commit remains **UNKNOWN at this checkpoint**.

**VERIFIED design:** normal browser close leaves the Magpie-owned node running. Explicit logout
ends its session; host shutdown invalidates all sessions. The approval journal stores only
short-lived pre-auth data and a hash of a browser-generated capability; it stores no browser
session or CLI token. Snapshot files contain only public pending pairing identifiers/codes,
not the browser secret/hash/cookie or a ticket URL.

**UNKNOWN:** first-enable automatic native desktop launch (the explicit button was measured via
real Magpie web); a busy host retirement lasting ten minutes; Windows/Linux desktop launch; a real
SSH-tunnel actor run. Default-Chrome screenshot proves launch/authentication, while the complete
configuration interaction was measured in ego Chromium and WebKit through the explicit pairing
fallback. Desktop WKWebView itself is not measured by these browser runs.

The lab remains running for stages 2–4; final process/port/data cleanup evidence is still pending.
Real-money Production remains **NO-GO**.
