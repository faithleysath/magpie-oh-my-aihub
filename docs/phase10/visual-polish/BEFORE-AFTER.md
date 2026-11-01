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

## Dialogs and ordinary rows (the second review)

The first matrix only opened pages, so the review found copy inside dialogs and
rows that the page audit could not see. These are the same fixes, now with a
visible-DOM test and real dialog frames.

| Where | Before (source at `0db687c`) | After | Evidence |
| --- | --- | --- | --- |
| Wallet network section | "这里不会付款、授信或产生可消费额度"; "主网发送、授信、自动充值…"; "不开启主网发送或授信" | "这里只查询余额，不能付款或充值"; "主网付款、自动充值和资金流仍未开放…不会自动增加可用额度"; "这不会开放主网付款" | `provider-light-1440-wallet.png`, `consumer-light-1440-wallet.png`; `wallet-network-ui.js` |
| Network cards / receiving | "链 56", "链 8453", "BSC 56 与 Base 8453" | "BSC", "Base", "BSC 与 Base"; chain id in collapsed 技术详情 | `provider-light-1440-wallet.png`; matrix `chainIdText: []` |
| Browser-wallet dialog | "浏览器扩展必须由你在下一屏选择具体钱包，不会自动使用 window.ethereum" | "连接浏览器钱包时，你需要在下一屏明确选择具体钱包，不会自动连接其他钱包" | `consumer-light-1440-connect-wallet-dialog.png`, dark + narrow |
| External wallet area | EIP-6963 / chainId in an open details | visible account/status only; protocol and chain id in collapsed 技术详情 | `consumer-light-1440-external-wallet.png` |
| Human approval | top copy bound "价格版本与批准代次"; model copy said "selected version"; full fingerprint twice (paragraph + checkbox); model+price shown in the choice and again in the preview; "0 在 Magpie 中表示不限制" | top copy "核对伙伴、模型、价格和额度后再批准。密钥会自动安全交付，无需发送文件。"; model copy "默认选择全部申请模型。选择变化后，需要重新预览当前报价。"; one fingerprint; checkbox "我核对并接受上述完整身份指纹"; one "当前报价" area; "0 表示不限制，不能用于暂停"; priceVersion/generation only in collapsed details | `provider-light-1440-approval-dialog.png`, dark + narrow; `dialogs.json` fingerprints 1 / priceLines 1 |
| Payment preview | "网络 链 84532", gas/nonce/digest as visible rows | "网络 Base 测试网"; chain id, nonce, gas, digest in collapsed 技术详情 | `fixture-payment-preview.png` (labelled fixture); `consumer-light-1440-recharge-error-dialog.png` (real form/error) |

Full 48-shot matrix: [`evidence/final/`](final/) and the machine-readable
[`matrix.json`](final/matrix.json). The base screenshots are the honest pre-fix
source; they are not copied here, so the before set keeps one home.
