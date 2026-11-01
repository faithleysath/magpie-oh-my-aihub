# Final visual matrix — how it was made

This directory is the real-browser evidence for the AI-slop rework. It is not a
fixture render: two isolated Magpie nodes ran on one macOS host, joined one real
EasyTier overlay, published their catalogues, and the console was driven by
ego-lite (Chromium).

## Environment

| Item | Value |
| --- | --- |
| Platform | macOS 26.6.2 (Darwin 25.6.0) arm64 |
| Magpie | **0.1.2289**, release `yetone/magpie-releases` tag `v0.1.2289` |
| Magpie zip | SHA-256 `c704be0d96ccaef64d5b6d7cdadd92b6bc0b650b5ca0b0a119b1c5d8900fc6a0` |
| Magpie binary | SHA-256 `c534dbcdb92031aa42ef6e4429d558f16d7e679b8508f82fcfde2bc07c45080c` |
| EasyTier | 2.6.4, commit `8428a89d2dabc94c97d370ec607c6ca142473626`, no-TUN |
| Browser | ego-lite via `ego-browser nodejs` |
| Nodes | provider `ohmyaihub-30c37d6f`, consumer `ohmyaihub-adefaf25`, one overlay `visual-eeeb50c5e1` |
| Console | real plugin host, random loopback ports (55504 / 55586) |
| Lab root | final run `/tmp/ohmyaihub-visual-25450` (deleted after the run; see `cleanup-proof.json`) |

The lab copy of the app was re-signed ad hoc with a unique bundle id so a launch
cannot hand over to the user's running Magpie. The user's Magpie data, default
browser profile and port 3425 were never used. The network secret existed only
in the disposable lab root and is not in any committed file.

## Reproduce

```bash
# 1. two isolated nodes, one overlay, real catalogue
bun docs/phase10/visual-polish/lab/visual-lab.ts --magpie /path/to/Magpie-0.1.2289.app

# 2. pair a browser session to each console through the real pairing journal
bun docs/phase10/visual-polish/lab/pair.ts --root /tmp/ohmyaihub-visual-<pid>

# 3. 48 screenshots + objective page checks
ego-browser nodejs < docs/phase10/visual-polish/lab/shots.mjs

# 4. stop every owned process and delete the root
bun docs/phase10/visual-polish/lab/cleanup.ts --root /tmp/ohmyaihub-visual-<pid>
```

`lab-manifest.json` is the sanitized report of this lab setup (versions, hashes,
ports, PIDs, model names; no secret); `final/matrix.json` and
`final/dialogs.json` name the final run root. `final/matrix.json` is the per-shot audit: overflow, sticker
nesting depth, pills, visible middle dots/arrows, raw protocol words, technical
terms outside details, mono prose, font-size set, status-text count.

## What the matrix contains (48 page images + 8 dialog images + 1 fixture)

- 5 pages × light/dark × 1440×900 and 390×844 × 2 nodes = 40
- 我的连接 on both nodes = 2
- full wallet page (including the recharge panel) on both nodes = 2
- real recharge validation error on both nodes = 2
- keyboard focus ring = 1
- ended session = 1

Dialog evidence (`dialogs.json`, 8 images): the real browser-wallet connection
dialog (light/dark/narrow), the external-wallet area, the real human approval
with its selected quote preview (light/dark/narrow), and the real recharge form
with its validation error. The approval modal is captured at a tall viewport
with the modal's internal scroll expanded so the whole dialog is visible; the
content is the real DOM, only the scroll container is expanded for the frame.

The payment preview itself (`fixture-payment-preview.png`) is a **dev fixture**
render: `plugin/scripts/console-preview.ts --scenario payment` serves the
shipped `app.js`/`style.css` with a synthetic obligation, because the on-chain
payment lab was not re-run in this frontend-only round. `fixture-payment.json`
records the same visible-text audit for it. The real recharge form and its
error are in the two-node matrix.

The narrow captures are `fullPage`; the fixed bottom navigation appears at its
viewport position in the middle of a long capture. That is a screenshot-tool
artifact, not a layout overlap: the in-page check records `overflowX: 0` and no
element wider than the viewport on every narrow page, and the viewport itself
shows the bar at the bottom.

## Result of the automated page checks

All 48 pages: `middleDots: 0`, `arrows: 0`, `pills: 0`, `overflowX: 0`,
`maxStickerDepth: 1`, `monoProse: []`, `techTerms: []`, `rawStates: []`,
`chainIdText: []`, `fontSizes: ["14px","16px","20px","26px"]`.
All 8 dialogs and the fixture preview: `techTerms: []`, `rawStates: []`,
`chainIdText: []` in the default-visible text; technical fields are only behind
a collapsed `技术详情`. The approval dialog also records `fingerprints: 1`,
`priceLines: 1`, `modelChoices: 1`, so a duplicated full fingerprint or a second
model/price row fails the audit.
Focus: `outline: solid 3px`, offset `2px`. Reduced motion:
`transition-duration: 0s`.

## Honest limits

- The zero-file request and human approval were performed against the real
  provider; delivery stayed `正在交付 / 排队中` in this lab, so the final
  connected-call state is not claimed here. That is a transport/lab condition
  (the PR #51 report has the delivered path at its own SHA), not a visual change.
- No on-chain recharge was run in this frontend-only round. The recharge panel
  is shown in its real empty state and with its real validation error; the
  payment preview dialog is a labelled fixture render (same shipped assets).
- The two-node overlay ran on one host (loopback listen + LAN discovery), as in
  the PR #51 final lab. It is not a WAN test.
