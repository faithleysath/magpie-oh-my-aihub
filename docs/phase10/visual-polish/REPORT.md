# Phase 10 visual polish — result

- Branch `feature/phase10-visual-polish`, base
  `0db687ccb25d974261bd5f8694a5c04545239f14` (PR #51 final acceptance head).
- Scope: console structure, styles, copy, their tests and evidence only. No P2P,
  payment, wallet, EasyTier, Ledger or Magpie behaviour changed; no runtime
  dependency added.
- Reviewed checklist: [`AUDIT.md`](AUDIT.md) (before) and
  [`CHECKLIST.md`](CHECKLIST.md) (what changed, item by item).

## Verdict

| Area | Verdict | Basis |
| --- | --- | --- |
| AI-slop rework (10 review items) | **DONE — VERIFIED + REPRODUCED** | Source rules locked by `visual-system.test.js`; 48 real screenshots with 0 violations in the page audit |
| Visual UX (five pages, light/dark, desktop/narrow) | **GO** | 48-shot matrix on real Magpie 0.1.2289 + EasyTier 2.6.4, two nodes; no overflow, one sticker layer, four type sizes, no pills/dots/arrows/raw states |
| Keyboard / reduced motion | **GO** | 3 px ink focus ring at 2 px offset; `transition-duration: 0s` under `prefers-reduced-motion: reduce` |
| Existing functionality | **unchanged, tests green** | console behaviour tests + full plugin suite; session, CSP, three-field join and payment/wallet actions untouched |
| Zero-file P2P (visual states) | **REPRODUCED (request + human approval)** | Real catalogue, real request, real approval with `$0.05` cap and authorized partner row; delivery stayed `正在交付 / 排队中` in this lab (see limits) |
| Real-money production | **NO-GO (inherited)** | Unchanged from PR #51; this round did not touch it |

## What was removed, not just recoloured

1. **Pills** — the `.pill` component is deleted; plain `.status-text` with
   `good`/`bad` only for the session, readiness and a real problem. Per-card,
   per-row and per-model labels are gone. "只读" + "不可授信" is one sentence.
2. **Mono** — only identifiers: `.mono`, `.amount`, code, fingerprint, secret,
   pairing code, and explicit identifier cells. Lists, model names, times,
   network/engine descriptions and node counts are sans. Unknown placeholders
   never get mono.
3. **Nesting** — one sticker layer. Only `.card`, a dialog, a button, the brand
   mark and the two top-level network cards carry border + hard shadow. Inner
   lists/facts/warnings/payment rows are flat hairlines. Wallet diagnostics moved
   out of the network card. `maxStickerDepth: 1` on all 48 pages.
4. **Copy** — wallet scope once; lock/address limit once; EIP-6963,
   `window.ethereum`, TOFU/presence/chainId/priceVersion in collapsed details;
   "FULL AUTO" gone; raw protocol states translated; the home readiness row is a
   Chinese task instead of an English check string.
5. **Middle dots** — none in shipped source or rendered pages; metadata is a
   layout row or a natural sentence.
6. **Radii** — 16 px outer / 8 px inner with ≥16 px nested distance; most nesting
   was removed instead of re-radiused.
7. **Type** — exactly 14/16/20/26 px; body 16; helper never below 14.
8. **Left bar** — `.inline-warning` is a single thin full border, transparent
   fill; no `border-left` in the stylesheet.
9. **Arrows** — the four home actions and the todo action lost `→`; no decorative
   arrow remains.
10. **No regressions** — no third font, italics, gradient/glass, hero, eyebrow,
    emoji, charts or scroll animation; one border language.

## Tests and gates (local, this working tree)

| Gate | Result |
| --- | --- |
| `bun run typecheck` | PASS |
| `bun run test` (plugin + console + phase-9 fixture) | see below |
| `bun run boot-check` | PASS (`magpie 0.1.2038` stub, api 34517, page snapshot 0600) |
| `bun run secret-scan` | PASS |
| `bun run scripts/pack-check.ts --selftest` | PASS (root 99 files / plugin 97, no tests/docs/secrets, static assets complete) |
| Console behaviour tests | 219 pass / 0 fail (12 files), including the new `visual-system.test.js` |
| CI (PR) | linked on the draft PR after push |

## Real matrix

`docs/phase10/visual-polish/evidence/final/` — 48 images, two real nodes,
light/dark × 1440×900/390×844 × five pages, plus 我的连接, full wallet/recharge,
the real recharge validation error, focus and ended session.
`matrix.json` records per page: `middleDots 0`, `arrows 0`, `pills 0`,
`overflowX 0`, `maxStickerDepth 1`, `monoProse []`, `techTerms []`,
`rawStates []`, `fontSizes ["14px","16px","20px","26px"]`.

Environment and reproduction: [`evidence/README.md`](evidence/README.md);
sanitized lab report [`evidence/lab-manifest.json`](evidence/lab-manifest.json);
before/after [`BEFORE-AFTER.md`](BEFORE-AFTER.md); cleanup
[`evidence/cleanup-proof.json`](evidence/cleanup-proof.json).

## Limits (stated, not hidden)

- The visual lab used Magpie **0.1.2289** (the PR #51 pinned version, hash
  verified) on one host: two isolated nodes, loopback listen + LAN discovery.
  It is not a WAN test. The installed 0.1.2516 was not used: a copied bundle on
  this machine repeatedly restarted the plugin host, so sessions could not stay
  alive long enough for a matrix. The 0.1.2289 lab was stable.
- The zero-file request and human approval were real; sealed delivery stayed
  `正在交付 / 排队中` in this lab (transport/lab condition). The delivered path is
  evidenced at the PR #51 SHA, not claimed again here.
- No on-chain recharge was re-run in this frontend-only round. The recharge panel
  is shown in its real empty state and with its real validation error.
- External MetaMask/Rabby product flow remains **UNKNOWN**, unchanged.
- Windows `test/provisioner.test.ts` gap is inherited from PR #51 and untouched.
