# Phase 10 visual polish — item-by-item checklist

Every item from the review, what changed, and where to see it. Status is
**DONE** only when the shipped source and the real 48-shot matrix both show it.

## The ten review items

| # | Item | How it was eliminated | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Too many status pills | The `.pill` component is deleted. One `.status-text` style (plain text, no border/background) replaces it; colour is only `good`/`bad` for the console session, the network readiness and a real problem. Per-row/per-model/per-card labels are gone; "只读" + "不可授信" is one sentence in user language. | DONE | `plugin/console/style.css` (`.status-text`), `visual-system.test.js` "no pill component is shipped or used"; matrix: `pills: 0` in all 48 pages |
| 2 | Monospace everywhere | Mono is only `.mono`, `.amount`, `code`, `.fingerprint`, `.secret-value`, `.pairing-code`, `.wallet-vault-secret` and explicit identifier cells. Lists, model names, times, network descriptions, node counts and prose are sans. Unknown placeholders never get mono. | DONE | `style.css` mono allowlist test; matrix: `monoProse: []` in all 48 pages; `provider-light-1440-network.png` (engine/time/peer row in sans, only address/hostname in mono) |
| 3 | Cards inside cards | One sticker layer: only `.card`, a dialog, a button, the brand mark and the two top-level network cards have a border plus a hard shadow. Lists, facts, warnings, advanced blocks and payment rows inside a card are flat rows with one hairline. `wallet-choice`, `.discovery-model`, `.wallet-network-card` (inner), `.wallet-payment-list li`, `.wallet-timeline li`, `.wallet-account-grid` and `.soft-note` lost border/background/shadow. Wallet diagnostics moved out of the network card. | DONE | `style.css` "one sticker layer" tests; matrix: `maxStickerDepth: 1` in all 48 pages |
| 4 | Repeated copy and implementation terms first | The wallet page states testnet/encryption/no-payment once; the lock/address limit is one sentence; EIP-6963, `window.ethereum`, TOFU/presence/chainId/priceVersion are in collapsed technical details; "FULL AUTO" is gone; raw protocol states are translated (including `ready`, `delivering`, `delivered`, `uncertain`, `declined`, `operator-revoked`); the home readiness row no longer prints the English check reason. | DONE | `wallet-vault-ui.js`, `wallet-network-ui.js`, `payment-p2p-ui.js`, `providers.js`, `app.js`; matrix: `techTerms: []`, `rawStates: []` in all 48 pages |
| 5 | Middle dots | No `·` in any shipped console source or rendered page. Metadata uses `.meta-list` (layout with gaps), labelled rows, or a natural Chinese sentence. Server prose is normalised at the display boundary. | DONE | `visual-system.test.js` "no middle-dot metadata"; matrix: `middleDots: 0` in all 48 pages |
| 6 | Concentric radii | Two radii: 16 px for a card/dialog, 8 px for a control/code block; a bordered element inside a card keeps ≥16 px distance. Most nesting was removed instead of re-radiusing it. | DONE | `style.css` tokens and the flat inner-list rules; screenshots |
| 7 | Font-size sprawl | Exactly four sizes: 14 / 16 / 20 / 26 px. Body 16, helper never below 14. No component introduces a fifth size. | DONE | `style.css` tokens + test "exactly four type sizes"; matrix: `fontSizes: ['14px','16px','20px','26px']` on every page |
| 8 | Coloured left bar | `.inline-warning` is a single thin full border with transparent background; `border-left` no longer appears in the stylesheet. | DONE | `visual-system.test.js` "warnings use one full thin border"; `style.css` |
| 9 | Repeated arrows | The four home text actions and the todo action lost `→`; navigation is underlined text only. No decorative arrows anywhere in the shipped console. | DONE | `visual-system.test.js` "no decorative arrows"; matrix: `arrows: 0` in all 48 pages |
| 10 | No regressions of the already-good parts | No third font, no italics, no purple gradient/glass, no hero, no all-caps eyebrow, no body emoji, no charts, no scroll animation; one border language (2 px ink outer, 1 px hairline inner). | DONE | source tests + matrix checks; `provider-light-1440-home.png`, `provider-dark-1440-wallet.png` |

## What must still work (checked, not assumed)

| Area | Check | Evidence |
| --- | --- | --- |
| Five pages | nav is exactly 首页/发现/我的共享/钱包/网络 on desktop and the narrow bottom bar | `shell.test.js`; every `*-390-*` shot |
| Three-field join | form has only 网络名称 / 网络密钥 / 初始节点 and one `join-network` write | `shell.test.js`, `app.test.js`; `provider-light-1440-network.png` |
| Security session | pairing, one-use ticket, logout/expiry states unchanged; ended session clears the active nav | `app.test.js`, `session.test.js`; `consumer-light-1440-session-ended.png` |
| CSP / local assets | no remote font/image/script, no new runtime dependency | `console-security.test.ts`; `secret-scan`; pack contents |
| Keyboard | Tab from the network name shows a 3 px ink ring at 2 px offset | `focus-and-motion` in `matrix.json`; `provider-light-1440-focus.png` |
| Reduced motion | `prefers-reduced-motion: reduce` → button `transition-duration: 0s` | `focus-and-motion` in `matrix.json` |
| Touch / narrow | no horizontal overflow at 390 px on any page | matrix `overflowX: 0` |
| Light and dark | both themes render the same components with token values | 24 dark shots + 24 light shots |
| Two nodes | real provider + consumer on one overlay, 1 online neighbour each, real catalogue, real zero-file request/approval UI | `provider-*`, `consumer-*` shots; `lab-manifest.json` |

## What this round did not re-run

- A full on-chain recharge was not repeated (frontend-only round). The recharge
  panel is shown in its real state on both nodes, including the real validation
  error (`consumer-light-1440-recharge-error.png`). The P2P delivery in this lab
  stayed `正在交付 / 排队中`; that is a transport/lab condition, not a UI state,
  and is reported as such in `REPORT.md`.
- The external MetaMask/Rabby product flow remains UNKNOWN, as at PR #51.
