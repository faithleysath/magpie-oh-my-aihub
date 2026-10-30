# Phase 9 real browser-journey fixture (maintainer only)

This harness **prepares the lab, not the user journey**. The actor installs/enables the package in
Magpie's real GUI, opens the plugin entry, and performs every Oh My AIHub action in the standalone
browser console. Do not fill missing features using `ohmyaihub` CLI, plugin Bearer HTTP API or
Magpie HTTP admin. Do not launch browsers from this harness.

## Isolation / versions

- Each node gets a **fresh copied app**, `.portable` marker, sibling `data/`, isolated `HOME` and
  caches, **separate copied root plugin package**. No real Magpie settings are read or copied.
- Default: Magpie **0.1.2171** for both web UI and gateway/plugin host in **one process**. Its upstream
  tag source is `244d80e23f91ab4e2b37b4e045d61fda5f7bca50`; binary hashes are recorded. Host/price
  compatibility stays **UNKNOWN until measured**, and the billing baseline stays **0.1.2038**.
  `--app /path/to/0.1.2038/Magpie.app` allows a separate fresh baseline lab; do not mix binaries on one
  profile. Source: `internal/appdir/appdir.go:1-20,94-110` portable isolation;
  `internal/cli/web_cli.go:27-113` web starts the gateway unless another owner exists.
- Magpie-managed Bun **1.4.4** is copied from its local cache into each portable `data/cache/bun/`;
  the host resolves it itself. No PATH Bun or `MAGPIE_BUN` override, no independent Bun command in
  the userflow. This is a fixture cache optimization, not a claim that Magpie embeds Bun in its app.
- EasyTier **2.6.4** (`8428a89d2dabc94c97d370ec607c6ca142473626`) binary hashes are checked before
  seeding isolated plugin caches. The plugin itself starts and supervises the real core after GUI
  setup. No preconfigured overlay, plugin install, key provisioner or balance is faked.
- Only the deterministic mock provider/model and its effective price (`1000,1000,0,0`, deliberately
  expensive so a tiny simulated cap can exhaust quickly) are fixture-provisioned using Magpie CLI.
  No vendor account, credential, wallet, chain write or user prompt goes to an external service.
- Magpie admin web always binds `127.0.0.1`, never `--lan`. The **gateway** binds the host LAN IPv4
  with allow-IP limited to that IPv4; this is necessary for real Gateway Key enforcement and the
  EasyTier mapped-subnet path. The harness verifies keyless and wrong-key **401**, and inability to
  reach the admin web through LAN. No firewall, route or TUN changes.

## Maintainer commands

Python is only a lab process runner, not a product prerequisite. Measured on macOS arm64, Python
3.14.7, macOS26.6.2/Darwin25.6.0. All runtime files are private under `/tmp` (root0700, JSON0600).
Commands print **only the runtime file path**, never a credential or login/ticket URL.

```sh
python3 docs/validation/lab/phase9/harness.py prepare --nodes 3
# Optional --root /tmp/unique-fresh-root
# --app /Applications/magpie.app
# --host-bun "$HOME/.cache/magpie/bun/1.4.4/magpie-bun"
# --easytier-cache "$HOME/Projects/lab/et/easytier-macos-aarch64"
# --lan <actual host IPv4>

python3 docs/validation/lab/phase9/harness.py start --runtime /tmp/<root>/runtime.json --node provider
# After Stage1 gate, start the second/third actual node explicitly:
python3 docs/validation/lab/phase9/harness.py start --runtime /tmp/<root>/runtime.json --node consumer
python3 docs/validation/lab/phase9/harness.py start --runtime /tmp/<root>/runtime.json --node provider2

python3 docs/validation/lab/phase9/harness.py status --runtime /tmp/<root>/runtime.json
python3 docs/validation/lab/phase9/harness.py stop --runtime /tmp/<root>/runtime.json --node provider2

# Sync concurrent production source fixes only at a coordinated restart point.
# Changes copied package, preserving profile/keys/ledger. Requires stopped node or --restart.
python3 docs/validation/lab/phase9/harness.py refresh-copy --runtime /tmp/<root>/runtime.json --node all --restart

# Only allowlisted sanitized metadata/hashes (not raw logs/state/login URLs).
python3 docs/validation/lab/phase9/harness.py export-evidence --runtime /tmp/<root>/runtime.json \
  --out docs/validation/lab/phase9/evidence/<run>-manifest.json

# Stop all lab-owned processes, record process/port cleanup; retain private data by default.
python3 docs/validation/lab/phase9/harness.py cleanup --runtime /tmp/<root>/runtime.json
# After parent finishes its browser session/evidence, delete runtime data as well.
# Preserves sanitized proof beside removed lab root; export/copy that proof deliberately.
python3 docs/validation/lab/phase9/harness.py cleanup --runtime /tmp/<root>/runtime.json --delete

PYTHONDONTWRITEBYTECODE=1 python3 docs/validation/lab/phase9/test_harness.py -v
```

## Actor handoff (do not print raw runtime)

The parent reads selected fields from private `runtime.json` in local tool/browser code, not into a
public transcript. `nodes.<name>.webLoginUrl` is the private real-Magpie sign-in capability;
`pluginCopy` is the **per-node root package** to paste into actual Magpie GUI's install input.
The normal user install must use the GitHub URL; a local path is maintainer fixture only. Parent
must also test the pushed GitHub branch install once packaging is available.

`networkName`/`networkSecret` are a fresh lab invitation. Per-node `ports.listen`, `ports.catalog`
and `ports.socks` are setup suggestions, not pre-applied plugin options. All catalogues use one
five-port window: consumer at base, provider at base+1, provider2 at base+2, preserving current
bounded discovery semantics without product changes. Use actual gateway ports from the manifest.

Stage1: provider Magpie GUI → install/enable plugin → plugin page nonterminal entry → loopback
console → authenticated session → actual configure/read state. Keep actor acceptance separate from
fixture readiness; a 401 fixture gateway is **not** proof that the console/overlay journey passed.
No plugin is installed or enabled by `prepare`/`start`. Opening console can auto-open an OS browser
through the real plugin launcher; the parent coordinates ego-browser, not the fixture runner.

## Evidence / cleanup

`sanitized-manifest.json` records platform/pins, per-node binary and shipped-source hashes,
non-sensitive ports/PIDs/readiness, and cleanup results. `copy-manifest.json` records exact copied
production files; no `node_modules`, tests, generated `page/status.js`/`options.js`/`launcher.js`, real profile or
existing peer/consumer state is copied. Root layout and all shipped source/console/page files are
preserved. Each source refresh is independently rehashed.

Raw Magpie/plugin logs may include web capabilities or overlay secrets: they stay under private
`<node>/logs/`; **never attach or commit them unreviewed**. The runtime file contains live keys and
must never enter Git. Sanitized manifests use an explicit allowlist, not regex-only redaction.
Cleanup checks PID argv before signalling to avoid killing the user's app or a reused PID; it
checks expected and observed API/console/RPC ports on loopback/LAN and refuses `--delete` while any
owned process/listener remains. Do not stop the provider until the parent finishes browser work.

**UNKNOWN until parent evidence:** real console/session/launcher across refresh/restart, GUI install,
real native Remote Magpie billing path on0.1.2171, public testnet wallet UX, Windows/Linux. This
harness never upgrades the0.1.2038 billing baseline merely because a newer admin UI loaded.
