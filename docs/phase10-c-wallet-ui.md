# Phase 10 C — 钱包 UI（本地钱包 + 外置钱包入口）

- 分支：`feature/phase10-c-wallet-ui`
- worktree：`/Users/laysath/.paseo/worktrees/1z728cdk/c-wallet-ui`
- 基线：approved PR25 `b1a4838`（明确 base25，不修改冻结的 main/其他 worktree）
- CI clock：在 UI commits 之后显式 cherry-pick 已批准的 P0-clock `889973f`（commit `5510aa6`），仅用于清除 base25 上既有 5 个固定测试时钟失败；不改 UI 行为。PR base 仍是 `feature/phase10-a-console`。
- 本地钱包服务契约：`/tmp/oma-research/C-WALLET-LOCAL-ACTION-CONTRACT.md`（PR #38 draft，head `58a92c5b3f479bc066cb752d8976f938764eca48`，未合并、本 UI 不 import 其实现）
- 外置钱包依赖：approved external 30 行为 `90c32f8` / final docs `ae596c3`；仅复制 `plugin/console/external-wallet.js`（SHA-256 `55e65ab63ef2924ad5f9b198902187f0657524f96c0a46b6679929a338a8f4a2`），未修改冻结分支
- 结论：**UI + 合成行为测试完成，可审；真实服务/真实扩展未验收，不是 Wallet GO，没有真实资金/付款发送。**

## 1. 范围

新增钱包页顶部的本地钱包卡片和 EIP-6963 外置钱包选择器，保留既有测试网钱包/账本区域作为下方高级流程：

- **创建钱包**：密码 + 确认、恢复信息保护提醒、一次性显示助记词；默认隐藏，显示/隐藏/结束清除。
- **连接已有钱包**：导入助记词、恢复加密备份（32 KiB 前端上限）、浏览器 EIP-6963 扩展三种明确入口。
- **锁定/解锁**：密码解锁，短时控制台会话；锁定/离页/会话结束清除敏感 DOM 与引用。
- **敏感导出**：助记词/私钥独立屏；先 `wallet-vault-reveal-authorize`，再密码复验调用一次 reveal action；默认隐藏、主动显示/隐藏、结束后清除；不自动剪贴板、不自动下载、不写普通 state/cache。
- **地址可信状态**：`addressVerified !== true` 时明确显示“未验证地址，不能作为收款地址”；不生成收款/转账指引。
- **外置钱包**：EIP-6963 announcement + 主动 request；必须用户选择后再连接；不自动读取/使用 `window.ethereum`；legacy 只作为显式选项；不索取助记词；只显示名称/initial，不使用 SVG/data 图标。
- **服务未接入**：显示“本地钱包服务未接入/当前版本不支持”，不创建、不伪造钱包、不提供模拟发送；可重试读取。
- **付款发送**：本 UI **没有发送按钮、没有 mock sender、没有 operationPort 注入**。durable journal 未接线，发送保持关闭。

不改 Service/Network 核心，不接真实资金，不扩自动充值/P2P 付款。

## 2. 使用的精确 action

全部通过既有认证 console transport 的 `client.action(name, input)`，不新增路由、不绕过 CSRF/回环/session：

- `wallet-vault-status`
- `wallet-vault-create`（sensitive；返回一次性 mnemonic）
- `wallet-vault-import`
- `wallet-vault-restore`
- `wallet-vault-backup`（sensitive；加密 keystore）
- `wallet-vault-unlock`
- `wallet-vault-lock`
- `wallet-vault-reveal-authorize`（`confirmation:"local-user-confirmed"`）
- `wallet-vault-reveal-mnemonic`（sensitive；authorizationId + password）
- `wallet-vault-reveal-private-key`（sensitive；authorizationId + password）

UI 不包含任意 action/method 透传；action 名称固定。

## 3. 敏感数据边界

- 密码、助记词、私钥、keystore 明文只存在于当前 dialog 的局部 DOM/闭包；不写入 `consoleState`、不写 localStorage/sessionStorage/indexedDB/cookie、不写日志、不缓存 action result。
- 输入字段在提交前读取，随后立即清空 password/mnemonic/backup；关闭、`pagehide`、离开钱包页、`sessionEnded`、`dispose` 都清理 dialog 和引用。
- 敏感导出必须先 authorize，再 password 复验；授权由 service 绑定当前 session、一次性、60s TTL；UI 不保存 authorizationId 到普通 state。
- `create`/`backup`/`reveal-*` 是 sensitive action；service/transport 负责 tombstone，本 UI 不重放、不缓存。
- 助记词/私钥不提供复制/下载按钮；加密备份显示也默认隐藏，不自动下载。
- `addressVerified` 为 false 的地址只能作为“未验证公开地址”展示，不能用于收款/转账目标。

## 4. 外置钱包

- 使用 approved `external-wallet.js` 的 `createWalletDiscovery` / `createExternalWallet`；未修改模块。
- `onShow()` 只启动发现并 dispatch `eip6963:requestProvider`；不调用 `eth_requestAccounts`。
- 列表显示 `name`, `rdns`, `initial`，标记“信息未验证”；不渲染 icon。
- 用户点“选择此钱包”后只是选择；再点“连接所选钱包”才 `connect({userInitiated:true})`。
- 无 EIP-6963 时不回退自动 `window.ethereum`；若存在 legacy，显示“显式选择旧式钱包”单独按钮。
- 外部钱包连接后只显示账户/chainId/状态；**不查询/伪造资产余额**，不发起付款。

## 5. 服务未接入与测试模拟

- 当前 PR #38 未批准/未合并；页面在 `wallet-vault-status` 返回 404 时 fail closed，不显示创建/导入/导出成功。
- 行为测试注入 mock client，仅证明 UI 调用顺序、字段、清理和拒绝行为；**mock 不是真实 service 验收**。
- 真实 Service 联调、真实加密存储、真实助记词生成/导入、真实扩展连接均为 **UNKNOWN**，需 backend approved 后单独验收。

## 6. 测试

| 项 | 结果 |
| --- | --- |
| `bun test plugin/console/wallet-vault-ui.test.js` | **11 pass / 0 fail / 71 assertions**（mock） |
| `bun test plugin/console` | **84 pass / 0 fail / 654 assertions** |
| `bun run typecheck` | pass |

覆盖：

- 服务未接入 fail closed，无创建/模拟发送按钮；
- 创建密码确认、提醒、助记词默认隐藏/显示/隐藏/结束清除；
- 导入/恢复字段清空、不 echo；
- 锁定/解锁 action 与地址可信状态；
- 敏感导出 authorize→password→reveal 顺序、默认隐藏、结束后 DOM/引用清除；
- 加密备份默认隐藏、无自动下载；
- EIP-6963 显式选择、未选择/未连接前 0 provider 调用、只名称/initial、无 textarea/mnemonic 输入；
- legacy 显式选择，不自动调用；
- pagehide 清除敏感 DOM；
- 源码无 localStorage/sessionStorage/indexedDB/cookie/clipboard/download/`eth_sendTransaction`/`wallet-vault-send`/`operationPort`。

## 7. 文件

- `plugin/console/wallet-vault-ui.js`（新增）
- `plugin/console/wallet-vault-ui.test.js`（新增）
- `plugin/console/external-wallet.js`（从 approved 90c32f8 复制，SHA-256 见上）
- `plugin/console/index.html`（本地钱包容器、钱包范围文案）
- `plugin/console/app.js`（挂载、页面进入/离开、session/pagehide 清理）
- `plugin/console/style.css`（钱包卡片/外部钱包/敏感内容样式）
- `plugin/console/shell.test.js`（钱包范围文案与容器断言）
- `plugin/src/index.ts`（仅静态模块白名单）
- `docs/phase10-c-wallet-ui.md`

## 8. 未做 / 明确不声称

- 未接 Service/UI 真实钱包流程；没有把 mock 成功称为真实钱包完成。
- 未接 durable journal；没有付款发送/自动充值/P2P 付款 UI。
- 未接 C21 主网只读；没有主网余额/资产/收款。
- 真实 MetaMask/Rabby、真实助记词/keystore、真实扩展锁定/拒绝：UNKNOWN。
- 既有测试网钱包/账本/文件流程仍在下方高级区域；本 UI 不把文件交接作为新主路径。
- 独立视觉审 `6a326f2b` 与敏感安全审 `b97887e5` 另派；本 PR 不自行批准。
