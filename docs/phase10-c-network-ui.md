# Phase 10 C — 钱包页只读主网网络/资产视图

- 分支：`feature/phase10-c-network-ui`
- worktree：`/Users/laysath/.paseo/worktrees/1z728cdk/c-network-ui`
- 基线：最终 wallet UI 39 head `23c94804f75c6deeaefbd1c4b32a74f779cb64b2`（明确作为开发依赖，不修改 39）
- 服务契约：`/tmp/oma-research/C-NETWORK-LOCAL-ACTION-CONTRACT.md`（C-network 41 head `cc0dd210e1cc20f5e4f48cb961e5c280b1a98bf6`，未合并/未 import 实现）
- 结论：**只读网络/资产 UI + mock 行为测试完成；真实 C-network service 未接线，真实 RPC/余额未验收，不是 Wallet GO。**

## 1. 范围

钱包页新增“只读网络与资产”面板，位于本地钱包卡片下方、旧文件流程之上：

- **BSC 56 / Base 8453 平权只读**：两列等权卡片，无 primary/default；各显示原生 BNB/ETH、只读代币、不可授信标记。
- **资产精度**：原生和代币分别使用 `nativeDecimals`/`decimals`，用 BigInt 精确格式化；不按 symbol 推断资产。
- **Base USDC**：若只读注册表列出 `eip155:8453:0x8335...`，按 6 位显示；**BSC USDC 未列出时不支持**，不补造、不按 symbol 猜测。
- **receiving 不可读**：`receiving.available:false` 或 `errorCode` 时显示“无法读取”，不把 `chainIds:[]` 当用户清空，不自动覆盖/猜链；只提供重新读取。
- **watch 地址**：必须显式输入 `0x`+40 hex 非零地址并点击添加；钱包连接地址、本地钱包地址**不会自动**成为 watch 或收款地址；最多 32 个，第 33 个只报错，不做地址簿。
- **余额读取**：必须明确选择网络、资产、已 watch 地址，才调用 `network-local-balance-refresh`；普通状态渲染/轮询不触发 RPC。
- **unknown 不造零**：余额错误/未知显示“余额未知”，不显示 `0`、不伪造美元估值；`usdValue` 只显示空/未估值。
- **5 分钟 TTL/fresh/stale**：`lastBalance` 的 `addressSource`、`observedAt`、`expiresAt`、`fresh/stale/needsRefresh` 参与展示；过期只显示“历史已知余额，需手动刷新”，不作为实时绿，不续 TTL。
- **充值网络选择**：默认空集合；BSC/Base 独立复选框，单选/双选/清空分别调用 `network-local-receiving-set`；只影响本机付款请求与自动授信匹配设置，不解禁主网发送/授信/自动充值。
- **provider 信用分离**：本面板只显示钱包/链只读资产，不使用 provider 信用或余额推断信用。
- **技术详情折叠**：chainId/support/receivable/nativeDecimals/blockExplorer 放在折叠详情；不暴露 RPC URL/credentials/私有账务。
- **服务未接**：`network-local-state` 404 时显示“只读网络服务未接入”，不显示 mock 成功/余额/USDC。
- **无付款**：没有发送、自动充值、文件交接或 `operationPort`；不允许 mock 发真实交易。

## 2. 使用的精确 action

- `network-local-state`：普通状态读取，契约规定不做 RPC。
- `network-local-watch-address`：显式加入 watch 公开地址。
- `network-local-receiving-set`：显式切换单网络充值匹配。
- `network-local-balance-refresh`：显式 `{chainId,address,assetId?,addressSource:"watch"}` 只读余额。

不新增 HTTP 路由；复用现有 console session/loopback/CSRF/UUID/body 限制。

## 3. 安全/边界

- watch 地址不是收款地址、不签名、不解锁；`addressSource` 固定 `"watch"`。
- 只读余额 `readOnly:true`、`creditEligible:false`、`usdValue:null`；不并入可消费额度。
- 主网 56/8453 只读，不等于发送/授信；选择充值网络不会解除主网门禁，也不声称链上禁止他人转账。
- BSC/Base 无 primary；不会默认选择网络/资产/地址。
- 没有本地存储、CSP 修改、runtime 框架、RPC client 或收费逻辑。
- 真实 UI/RPC 集成等待 C-network 41 approved；当前 mock 测试只是行为验证。

## 4. 测试

| 项 | 结果 |
| --- | --- |
| `bun test plugin/console/wallet-network-ui.test.js` | **11 pass / 0 fail / 60 assertions**（mock） |
| `bun test plugin/console` | **103 pass / 0 fail / 757 assertions** |
| `bun run typecheck` | pass |

覆盖：平权网络/原生与 Base USDC/BSC USDC unsupported、精确 6/18 decimals、默认空充值选择、单/双选独立、显式 watch、错误地址不调用 action、余额刷新精确输入、unknown 不显示 0、普通 onShow 不调用余额 action、服务 404 fail closed、源码无 RPC/存储/付款/自动充值。

## 5. 未做 / 不声称

- C-network 41 未合并；真实 service、真实 RPC、真实余额、真实主网只读未验收；receiving unavailable/errorCode 和 fresh/stale 目前是 mock 契约测试。
- 未接 C21 主网发送/授信；主网资金仍关闭。
- 未接 #35 付款 journal / payment-local-service；不实现付款预览、发送、自动充值或文件主路径。
- 真实扩展/钱包 UI 39 仍待视觉/安全 review；本分支不修改冻结 39。
- 视觉 `6a326f2b` 与安全/链 review 另派；本 PR 不自行批准。
