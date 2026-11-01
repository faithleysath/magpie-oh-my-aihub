# Phase 10 visual polish — current AI-slop inventory

Base: `0db687ccb25d974261bd5f8694a5c04545239f14` (PR #51 final acceptance head),
branch `feature/phase10-visual-polish`. This page is the working checklist for the
rework; every item is fixed or explicitly kept with a reason in
[`CHECKLIST.md`](CHECKLIST.md).

Source of truth for "before": the 40 real screenshots committed at
`docs/phase10/final-acceptance/evidence/visual/` (real Magpie 0.1.2289 + EasyTier
2.6.4, two nodes) plus the shipped console source at the base commit.

## 1. Status pills on almost everything

| Where | Evidence at base |
| --- | --- |
| Top bar | `#connection` is a bordered pill (`index.html`, `app.js:87`) |
| Network page | readiness pill plus one pill per neighbour (online + latency), `app.js:449`, `app.js:196` |
| Discovery | one pill per peer card, `providers.js:430` |
| Sharing | one pill per model row ("价格完整"), per inbound request, per approval, per connection, per consumer |
| Wallet | "已锁定" pill in the section heading, "只读" pill on every network card **and** "不可授信" next to it, `wallet-vault-ui.js:430`, `wallet-network-ui.js:139,228` |
| Payment | one pill per request and per obligation, `payment-p2p-ui.js:406,426` |

The screenshot `c-desktop-light-wallet.png` shows two pills in one heading row
("只读" + "不可授信") and a third ("已锁定") 40 px above it.

## 2. Monospace outside identifiers

`style.css` puts `--font-mono` on: `.credit-list li` (whole row, including the
partner id and amount), `.home-model-group ul` (model names), `.facts dd` (network
name, node name, engine description, timestamps), `.workflow-details span` (all
technical values, including times and status words), `.wallet-vault-facts dd`,
`.wallet-payment-list small` (whole sentence), `.wallet-payment-facts dd`.
The network screenshot renders "EasyTier easytier-core 2.6.4-8428a89d · no-TUN" and
"2026/10/31 23:44:37 · 8 秒前" in mono.

## 3. Stickers inside stickers

`c-desktop-light-wallet.png`: page card → "本地钱包状态" card → facts → rose alert
block. Payment page: card → bordered `.wallet-payment-list li` → bordered
`.wallet-payment-preview`. Network page: card → bordered `.diagnostics` with its
own shadow. Discovery: card → `.discovery-model` sunken block. Wallet network:
card → `.wallet-network-card` (border + `--shadow-xs`) → `.wallet-network-assets li`
(border + sunken). `.soft-note`, `.inline-warning`, `.workflow-empty` add a third
layer in several places.

## 4. Duplicated copy and implementation terms up front

- Wallet page says "测试网环境…不执行主网或自动付款" (page heading), then "测试网本地
  钱包…这里不发起付款" (vault), then "钱包已锁定；公开地址不代表已验证，不能用于收款或
  转账目标" (card), then "地址可信状态：未验证地址，不能作为收款地址" (fact), then
  "不要把此地址当作可信收款地址。只有解锁后…" (alert): the same limit five times.
- "EIP-6963" is a section heading and appears in ordinary copy; "不可授信",
  "TOFU", "presence", "provider 信用", "chainId", "priceVersion" appear in
  normal rows.
- "FULL AUTO 未实现" is an English state in a Chinese page.

## 5. Middle dots in ordinary UI

`app.js`, `providers.js`, `wallet.js`, `wallet-network-ui.js`,
`wallet-vault-ui.js`, `payment-p2p-ui.js`, `network.js` join nearly every metadata
line with ` · ` (peer address/path/latency, model count/online/contact, wallet
evidence times, payment id/expiry, account state/times). The network screenshot has
four in one card.

## 6. Concentric radii and line weights

Outer cards are 14 px; nested `.wallet-choice`, `.wallet-network-card`,
`.wallet-payment-list li`, `.workflow-empty`, `.fingerprint` are 10 px/8 px with
16–20 px padding, so the corners never share a centre. `--stroke` is 2 px on cards,
`.inline-warning` uses a 2 px left bar, `.wallet-external-row` uses 1 px, and
`.soft-note` is dashed: four border languages on one page.

## 7. Font sizes

Five sizes ship (14, 16, 18, 22, 28 px) plus the 28 px pairing code; the home page
uses four of them in one card. `--text-2xl` exists only for `h1`.

## 8. Colored left bar

`.inline-warning { border-left: var(--stroke) solid var(--bad) }` — a decorative
colored bar, used 30+ times.

## 9. Repeated arrows

Home renders "查看网络 →", "去发现 →", "查看共享 →", "查看钱包 →" and every todo row
renders "去处理 →". The screenshots show four arrows in one card.

## 10. Things that must not regress

No purple/gradient/glass, no hero, no all-caps eyebrow, no body emoji, no charts,
no scroll animation, no italic abuse, no sub-14 px text, one primary action per
screen, five pages, three-field join, CSP/session/security unchanged.

## Scope

Only console structure, styles, copy and their tests/evidence change. No P2P,
payment, wallet, EasyTier, Ledger or Magpie behaviour is touched; no runtime
dependency is added.
