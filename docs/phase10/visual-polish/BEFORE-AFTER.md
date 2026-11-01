# Before / after

"Before" is the reviewed state at `0db687c` (PR #51 head), photographed on real
Magpie 0.1.2289 + EasyTier 2.6.4 and committed under
[`../final-acceptance/evidence/visual/`](../final-acceptance/evidence/visual/).
"After" is this branch, same two-node lab and the same 1440×900 / 390×844,
light/dark matrix, under [`evidence/final/`](final/).

The images are not pixel-diffed: the layout and copy changed on purpose. Read the
pair for the same page.

| Page | Before (base) | After (this branch) | What changed |
| --- | --- | --- | --- |
| 首页 light 1440 | [`c-desktop-light-home.png`](../final-acceptance/evidence/visual/c-desktop-light-home.png) | [`provider-light-1440-home.png`](final/provider-light-1440-home.png) | Four "→" actions removed; one card with flat rows; the readiness todo is Chinese instead of a raw English check reason; 4 sizes instead of 5 |
| 发现 light 1440 | [`c-desktop-light-discover.png`](../final-acceptance/evidence/visual/c-desktop-light-discover.png) | [`consumer-light-1440-discovery.png`](final/consumer-light-1440-discovery.png) | Status is text, not a pill; `·` metadata is a layout row; per-model price badge removed; explanation and technical details get their own lines |
| 我的共享 light 1440 | [`c-desktop-light-share.png`](../final-acceptance/evidence/visual/c-desktop-light-share.png) | [`provider-light-1440-sharing.png`](final/provider-light-1440-sharing.png) | One status per request/approval; flat rows; per-model "价格完整" badge removed; publication fields grouped inside the sharing card |
| 钱包 light 1440 | [`c-desktop-light-wallet.png`](../final-acceptance/evidence/visual/c-desktop-light-wallet.png) | [`provider-light-1440-wallet.png`](final/provider-light-1440-wallet.png) | Two pills in one heading and a third above are gone; one wallet scope sentence; EIP-6963/`window.ethereum` in details; wallet/network/payment cards flat inside; no nested asset cards; "只读" + "不可授信" is one user-language sentence |
| 网络 light 1440 | [`c-desktop-light-network.png`](../final-acceptance/evidence/visual/c-desktop-light-network.png) | [`provider-light-1440-network.png`](final/provider-light-1440-network.png) | Readiness pill and per-peer pills removed; facts/times/engine in sans; peer metadata on one layout row; diagnostics are flat details, not nested cards |
| 钱包 dark 1440 | [`c-desktop-dark-wallet.png`](../final-acceptance/evidence/visual/c-desktop-dark-wallet.png) | [`provider-dark-1440-wallet.png`](final/provider-dark-1440-wallet.png) | Same system in dark: one sticker layer, no pill, four sizes |
| 钱包 narrow light | [`c-narrow-light-wallet.png`](../final-acceptance/evidence/visual/c-narrow-light-wallet.png) | [`provider-light-390-wallet.png`](final/provider-light-390-wallet.png) | No card-in-card, no rose block inside a card, no repeated lock sentence; actions stay inside their card |
| 首页 narrow light | [`c-narrow-light-home.png`](../final-acceptance/evidence/visual/c-narrow-light-home.png) | [`provider-light-390-home.png`](final/provider-light-390-home.png) | No arrows; todo text fits and its action no longer wraps; flat rows |
| 错误/会话结束 | [`c-desktop-light-payment-received.png`](../final-acceptance/evidence/visual/c-desktop-light-payment-received.png) (payment state) | [`consumer-light-1440-session-ended.png`](final/consumer-light-1440-session-ended.png) | Ended session clears the active nav; one status language. The recharge error state is [`consumer-light-1440-recharge-error.png`](final/consumer-light-1440-recharge-error.png) |

Full 48-shot matrix: [`evidence/final/`](final/) and the machine-readable
[`matrix.json`](final/matrix.json). The base screenshots are the honest pre-fix
source; they are not copied here, so the before set keeps one home.
