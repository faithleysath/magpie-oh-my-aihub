# 真实外置钱包兼容验收 — 准备与可行性（只读预审）

> **证据附录：测试计划，不是验收。** 当前结论为 **BLOCKED/UNKNOWN**；真实 MetaMask/Rabby 未安装、未注入、未签名，不能用 fake provider 单测声称真实兼容。

- 日期：2026-10-31
- 范围：**只准备验收方案，不改应用代码，不安装到用户现有 profile，不读用户扩展数据/恢复短语，不发真实交易。**
- 当前结论：**真实 MetaMask / Rabby 扩展验收 BLOCKED/UNKNOWN**。原因不是“没有测试钱包”，而是 **ego-lite 当前 agent API 没有可创建的隔离 profile，扩展加载是进程/profile 级，不是 Space 级**；在唯一默认 profile 上加载会把扩展注入用户自己的窗口，违反隔离要求。
- 因此：**不能声称已支持真实外置钱包，也不能用假 provider 对象代替验收。**

## 1. 本机 ego-lite 事实

| 项 | 实测/来源 | 状态 |
|---|---|---|
| ego-browser | `0.6.2.5`；Chromium `156.0.8078.74`；Node `v24.22.1` | VERIFIED |
| 当前 profiles | `profiles()` 返回 **1 个默认 profile**（用户默认 profile，名称不写入本报告）；无测试专用 profile | VERIFIED |
| profile 创建 API | `profiles()` 只列出现有 profile；`taskSpace(name,{profileId})` 只能选择已有 profile；源码/文档无 `createProfile`/`newProfile` agent API | VERIFIED（源码 `package/ego-browser/src/helpers.ts`、`docs/native-bindings-api.md`） |
| Space 与 profile | Space 是 BrowserContext，profile 的 cookie/扩展等仍共享；不是安全隔离边界 | VERIFIED（ego-lite issue #262 描述） |
| 扩展加载 | `Extensions.loadUnpacked` 可在浏览器级 CDP 使用，但它是 **profile 级、进程级**，会注入该 profile 的所有 Space 和用户窗口；不是 Space 隔离 | VERIFIED（ego-lite issue #160、#262） |
| 第一方扩展 helper | 当前 `BROWSER_LEVEL` 只识别 `Target.*`/`Browser.*`；`Extensions.*` 没有第一方路由，issue #160 仍 OPEN；只能显式 null session 的 workaround | VERIFIED（源码 `browser-runtime.ts:17`、issue #160） |
| Chrome Web Store 安装 | ego-lite 文档只说明可从其他浏览器导入扩展；没有 Chrome Web Store 安装入口/agent action | VERIFIED（官方 Quick start 文档）；安装流程 UNKNOWN |
| 当前用户生产钱包 | **未检查扩展清单/存储**；仅确认存在 1 个默认 profile。是否存在 MetaMask/Rabby 为 UNKNOWN | 按隔离要求不读取 |

**结论：** 现在不能创建“全新隔离 ego-lite profile + 安装扩展”的 agent 流程。若在默认 profile 上 `Extensions.loadUnpacked`，扩展会进入用户自己的窗口/所有 Space；这既不是隔离测试，也可能干扰用户生产钱包。**不做。**

## 2. 官方版本与安装限制（截至 2026-10-31）

| 钱包 | 官方最新 | 官方安装来源 | 备注 |
|---|---|---|---|
| MetaMask | **13.55.0**（GitHub release `v13.55.0`，2026-10-29） | Chrome Web Store ID `nkbihfbeogaeaoehlefnkodbefgpgknn`；官方 Help Center 指引 Chrome Web Store | Web Store 页面抓取时显示 13.54.x；验收时以商店实际版本/扩展 ID 为准 |
| Rabby | **0.94.14**（GitHub release `v0.94.14`，2026-10-30；Web Store 更新 2026-10-30） | Chrome Web Store ID `acmacodkjbdgmoleebolmdjonilkdbch`；官网 `rabby.io` | 仅 Chrome Web Store / 官方发布包 |

安装限制：

- Chrome 137 起，**官方 Chrome branded build 移除 `--load-extension`**；Chromium/Chrome for Testing 仍支持。该限制针对命令行加载未打包扩展（Chromium Extensions PSA，2025-04）。
- Chrome Web Store 是普通用户唯一官方安装渠道；Windows/macOS 的 self-hosted 扩展只通过企业管理策略。
- `Extensions.loadUnpacked`（CDP）要求 `--remote-debugging-pipe` 且通常要求 `--enable-unsafe-extension-debugging`；它安装到 **profile**，不是 Space。ego-lite 的 issue #262 明确记录该边界，尚无 Space 级隔离。
- 因此“在隔离 profile 里加载官方未打包 zip”在 Chromium 技术上可行，但 ego-lite 当前 **没有 agent 可创建隔离 profile**，也没有文档化的 profile 级扩展加载入口。不能把默认 profile 当作隔离 profile。

## 3. 真实扩展验收前置条件（未满足）

1. 一个**全新 ego-lite profile**，不导入用户数据/扩展/cookie；由用户或新工具显式创建，agent API 只能选择已有 profile。
2. 扩展安装只进入该测试 profile；验证不会注入默认 profile/用户窗口。当前 `Extensions.loadUnpacked` 是 profile 级，若该 profile 是新建且独立，可接受；但创建 profile 的工具缺口未解决。
3. 只安装官方来源：
   - MetaMask 官方 Chrome Web Store 或官方 GitHub release 的 `metamask-chrome-13.55.0.zip`；
   - Rabby 官方 Chrome Web Store 或官方 GitHub release `Rabby_v0.94.14.zip`。
4. 在扩展内**新建**测试钱包；不导入、不导出、不读取恢复短语；只记录公开地址；不充值、不连接主网、不广播交易。
5. 本地静态 dApp 页面（`127.0.0.1`）加载；不依赖生产站点；CSP 明确。
6. 验收证据只含公开信息：扩展 ID、EIP-6963 `rdns/name/uuid`、公开地址、chainId、签名与恢复地址、截图；不含 seed/私钥/扩展存储。

## 4. EIP-1193 / EIP-6963 验收矩阵

### 4.1 EIP-1193（Provider JavaScript API）

官方：https://eips.ethereum.org/EIPS/eip-1193

必须验证：

- `window.ethereum` 是否存在只是**约定**，不是标准；不能只靠它判断兼容。
- `provider.request({ method, params })` 返回 Promise；`eth_requestAccounts` 触发用户授权；`eth_accounts` 不弹窗；`eth_chainId` 返回十六进制 chainId。
- 事件：`connect`、`disconnect`、`chainChanged`、`accountsChanged`。
- 用户拒绝：`4001`；未授权：`4100`；不支持方法：`4200`；未连接：`4900`；目标链未连接：`4901`。
- 扩展锁定/解锁、账户切换、链切换后事件与 `eth_accounts` 一致。

### 4.2 EIP-6963（多钱包发现）

官方：https://eips.ethereum.org/EIPS/eip-6963

必须验证：

- 钱包监听 `eip6963:requestProvider` 并派发 `eip6963:announceProvider`；`detail = { info, provider }`，`info` 至少含 `uuid/name/icon/rdns`，`provider` 是 EIP-1193 provider。
- dApp 同时监听 announcement，并主动 dispatch request；不能只读 `window.ethereum`。
- 同时安装 MetaMask + Rabby 时，两个 provider 都能被发现，`rdns`/`name`/`uuid` 可区分；不能靠“最后一个 `window.ethereum`”猜。
- 刷新/扩展重载后重新 announce；扩展禁用/卸载后不再 announce；不能把缓存 provider 当仍可用。
- 对每个 provider 分别做 `eth_chainId`、`eth_accounts`、`eth_signTypedData_v4`；不能把 A 钱包的签名归到 B。

### 4.3 真实签名用例

- 使用现有 `ohmyaihub.deposit-request` EIP-712 文档（Base Sepolia 84532 / BSC Testnet 97；不接主网）。
- 让真实扩展显示并签署 `eth_signTypedData_v4`；插件侧 `recoverAddress` 必须等于公开地址。
- 负向：改 chainId/金额/收款/asset/expiry/domain 后，签名必须失效；用户拒绝必须是 4001；锁定钱包必须失败。
- **不调用 `eth_sendTransaction` / `eth_sendRawTransaction`；不广播任何交易。**
- 不能用“注入假 provider 对象”通过该用例；假 provider 只能做纯前端单元测试，不能作为兼容验收。

## 5. 可执行的验收步骤（等隔离 profile 可用后）

1. 创建全新 ego profile（不导入任何数据），确认 `profiles()` 只多出该测试 profile，默认 profile 不被选中。
2. 在该 profile 的 Space 中安装官方 MetaMask 13.55.0（先单独测），验证扩展 ID/`rdns`；再单独测 Rabby 0.94.14；最后两者共存。
3. 扩展内新建测试钱包；记录公开地址；不导出 seed；不充值。
4. 打开本地静态页面：
   - 记录 `window.ethereum` 是否存在；
   - 监听 `eip6963:announceProvider` 并 dispatch `eip6963:requestProvider`；
   - 输出所有 `info` 与 provider 数量。
5. 对每个 provider：`eth_requestAccounts` → `eth_chainId` → 切到 84532/97（或拒绝）→ `eth_signTypedData_v4` → 恢复地址比对。
6. 测锁定、账户切换、链切换、刷新、扩展禁用/卸载、用户拒绝。
7. 截图 + JSON 证据；清理测试 profile/扩展；不触碰默认 profile。
8. 验收判定：只有真实扩展注入 + EIP-6963 发现 + 真实签名/拒绝路径全部通过，才能说“兼容 MetaMask/Rabby”；否则 UNKNOWN/FAIL。

## 6. 当前判定与缺口

| 项 | 判定 | 说明 |
|---|---|---|
| 隔离 ego-lite profile | **BLOCKED** | 当前只有 1 个默认 profile；agent API 无 create profile |
| 扩展安装到测试 profile | **BLOCKED/UNKNOWN** | `Extensions.loadUnpacked` 是 profile/进程级；无第一方 helper；Chrome Web Store 入口未文档化 |
| 真实 MetaMask 13.55.0 | **UNKNOWN** | 未安装、未注入、未签名；不能声称兼容 |
| 真实 Rabby 0.94.14 | **UNKNOWN** | 同上 |
| 双钱包 EIP-6963 | **UNKNOWN** | 未安装；不能用假 provider 代替 |
| 当前用户生产钱包 | **UNKNOWN，未读取** | 仅知默认 profile 存在；不检查扩展数据/恢复短语 |
| 假 provider 单测 | 可做，但**不是验收** | 只能验证页面逻辑/签名解码；不能声称真实扩展兼容 |

## 7. 建议的最小工具缺口（交给 B-core/ego-lite，不在本任务实现）

1. agent 可创建/销毁**独立 profile**，或提供等价的一次性 browser data dir；默认 profile 永不被测试选中。
2. 允许 `Extensions.loadUnpacked` 限定到该测试 profile，且不影响用户窗口/其他 Space；验收时能证明注入范围。
3. 记录扩展 ID/`rdns` 与官方来源校验；支持从官方 Chrome Web Store 或官方 release zip 安装。
4. 测试结束可销毁 profile/扩展，不触碰默认 profile。
5. 在工具缺口关闭前，真实扩展验收保持 **BLOCKED/UNKNOWN**；不用现有 profile 降级。

## 8. 来源

- ego-browser skill / 本机 CLI：`ego-browser 0.6.2.5`，Chromium `156.0.8078.74`；`profiles()` 实测。
- ego-lite 官方 docs：<https://lite.ego.app/document/en/docs/quick-start>（导入扩展/数据；Space 隔离）。
- ego-lite issue #160（Extensions.loadUnpacked routing）：<https://github.com/citrolabs/ego-lite/issues/160>。
- ego-lite issue #262（扩展是 profile 级，非 Space 级）：<https://github.com/citrolabs/ego-lite/issues/262>。
- ego-lite `docs/native-bindings-api.md`、`package/ego-browser/src/helpers.ts`（profiles 只列出现有 profile；taskSpace 只选择 profile）。
- EIP-1193：<https://eips.ethereum.org/EIPS/eip-1193>。
- EIP-6963：<https://eips.ethereum.org/EIPS/eip-6963>。
- MetaMask release v13.55.0：<https://github.com/MetaMask/metamask-extension/releases/tag/v13.55.0>；Web Store `nkbihfbeogaeaoehlefnkodbefgpgknn`。
- Rabby release v0.94.14：<https://github.com/RabbyHub/Rabby/releases/tag/v0.94.14>；Web Store `acmacodkjbdgmoleebolmdjonilkdbch`。
- Chrome Extensions PSA（Chrome 137 移除 branded `--load-extension`）：<https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY>。
- Chrome alternative installation：<https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions>。
- Chromium `Extensions.loadUnpacked` 需要 remote debugging pipe / unsafe extension debugging：<https://github.com/chromium/chromium/commit/225b2eaa7f23c33b7c4e30c1bfc58f1bd99cbe1c>。

**未执行：** 未安装任何扩展到默认 profile，未读取用户扩展数据/恢复短语，未创建测试钱包，未发交易，未改应用代码。
