# Phase 10 visual polish — result

- Branch `feature/phase10-visual-polish`, base
  `0db687ccb25d974261bd5f8694a5c04545239f14` (PR #51 final acceptance head).
- UI head `2442a87` (this round's approval-dialog rework; the 48 page shots and
  8 dialog shots are this tree); the previous UI head was `55634de`, the first
  round's `9859b2f`; CI-green head `2442a87`; this report and its hashes are the
  docs-only commit after it.
- Draft PR **#52** → `feature/phase10-final-acceptance`, **not merged**:
  <https://github.com/faithleysath/magpie-oh-my-aihub/pull/52>
- Scope: console structure, styles, copy, their tests and evidence only. No P2P,
  payment, wallet, EasyTier, Ledger or Magpie behaviour changed; no runtime
  dependency added.
- Reviewed checklist: [`AUDIT.md`](AUDIT.md) (before) and
  [`CHECKLIST.md`](CHECKLIST.md) (what changed, item by item).

## Verdict

| Area | Verdict | Basis |
| --- | --- | --- |
| AI-slop rework (10 review items) | **DONE — VERIFIED + REPRODUCED** | Source rules locked by `visual-system.test.js`; 48 real screenshots with 0 violations in the page audit |
| Visual UX (five pages, light/dark, desktop/narrow) | **GO** | 48-shot page matrix + 8 real dialog shots on Magpie 0.1.2289 + EasyTier 2.6.4, two nodes; no overflow, one sticker layer, four type sizes, no pills/dots/arrows/raw states/chain ids in ordinary rows |
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
   Chinese task instead of an English check string; "授信" is gone from ordinary
   UI ("不能付款或充值", "不会开放主网付款", "不会自动增加可用额度"); network
   cards/checkboxes/recharge rows say BSC/Base and keep the chain id in the
   collapsed technical details.
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
| `bun run test` (plugin + console + phase-9 fixture) | **1427 pass / 0 fail** (94 files) |
| `bun run boot-check` | PASS (`magpie 0.1.2038` stub, api 34517, page snapshot 0600) |
| `bun run secret-scan` | PASS |
| `bun run scripts/pack-check.ts --selftest` | PASS (root 99 files / plugin 97, no tests/docs/secrets, static assets complete) |
| Console behaviour tests | 225 pass / 0 fail (12 files), including the visible-DOM dialog checks |
| CI (PR #52) | all six checks green at `2442a87`: plugin linux, plugin macos, windows subset, secrets working tree, secrets history, package contents |

## Real matrix

`docs/phase10/visual-polish/evidence/final/` — 48 page images, two real nodes,
light/dark × 1440×900/390×844 × five pages, plus 我的连接, full wallet/recharge,
the real recharge validation error, focus and ended session. A second set of 8
real dialog images covers the browser-wallet connection dialog (light/dark/
narrow), the external-wallet area, the human approval with its selected quote
preview (light/dark/narrow) and the real recharge error. The approval dialog
shows one full fingerprint and one "当前报价" block (model + price); the
checkbox says "我核对并接受上述完整身份指纹"; 价格版本/批准代次/代次/generation
exist only inside the collapsed "请求身份与绑定"/"选中报价的技术绑定" details.
`dialogs.json` records `fingerprints: 1`, `priceLines: 1`, `modelChoices: 1`
for the one-model approval fixture.

**Default-visible approval dialog:** the compressed purpose line ("核对伙伴、
模型、价格和额度后再批准。密钥会自动安全交付，无需发送文件。"), one full
partner fingerprint, the model checkbox list (names only), the "当前报价" block
(model + price, refreshed by preview), the cap field with "额度必须大于 0；0 表示
不限制，不能用于暂停。", "我核对并接受上述完整身份指纹", "我确认批准这次请求，
并接受当前报价、模型与额度", and the approve button.

**Only behind collapsed details:** "请求身份与绑定" (partner node/name, quote
hash, approval generation, expiry) and "选中报价的技术绑定" (selected price
version, quote hash, model count). No 价格版本/批准代次/代次/generation/
priceVersion appears before the user expands them. `dialogs.json` records
the same visible-text audit for each; `fixture-payment-preview.png` +
`fixture-payment.json` are a clearly labelled fixture render of the payment
preview (the on-chain lab was not re-run).
`matrix.json` records per page: `middleDots 0`, `arrows 0`, `pills 0`,
`overflowX 0`, `maxStickerDepth 1`, `monoProse []`, `techTerms []`,
`rawStates []`, `chainIdText []`, `fontSizes ["14px","16px","20px","26px"]`;
all dialogs: no 授信/EIP-6963/window.ethereum/chainId/priceVersion/FULL AUTO and
no raw protocol word in the default-visible text.

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
- The first CI run exposed a pre-existing 1/254 test flake: the self-connect
  guard (added in PR #51) compares a peer's virtual IPv4 with a randomly
  allocated local one, and two backend fixtures used 10.77.0.2/10.77.0.3 without
  pinning the local address. Two test files now pin `virtualIpv4:
  "10.77.0.99/24"`, the same fix already present in `catalog-service.test.ts`.
  This is test-only: no product code changed. 15× models-evidence and 12×
  service runs pass after the pin; the full suite is green.
- The zero-file request and human approval were real; sealed delivery stayed
  `正在交付 / 排队中` in this lab (transport/lab condition). The delivered path is
  evidenced at the PR #51 SHA, not claimed again here.
- No on-chain recharge was re-run in this frontend-only round. The recharge panel
  is shown in its real empty state and with its real validation error; the
  payment preview dialog is a labelled fixture render using the shipped assets.
- External MetaMask/Rabby product flow remains **UNKNOWN**, unchanged.
- Windows `test/provisioner.test.ts` gap is inherited from PR #51 and untouched.
