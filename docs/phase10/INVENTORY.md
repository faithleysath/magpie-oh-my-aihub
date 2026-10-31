# Phase 10 — 代码盘点与开始条件（INVENTORY）

> 本文件只记录**实际检查到的事实**与**明确的未知**。状态标签：
> **VERIFIED** = 本次在仓库/源码/CLI 中直接核对；**REPRODUCED** = 本次实际运行并看到结果；
> **UNKNOWN** = 未测或证据不覆盖；**PROPOSED** = Phase 10 建议，不是已实现。
> 所有命令和路径可复现。本文不包含任何真实秘密：没有读取或输出 Gateway Key、网络密码、钱包私钥、RPC 凭据或会话票据。

- 生成时间：2026-10-31（本机时钟，Asia/Shanghai 环境）
- 平台：macOS 26.6.2（25G83），Darwin 25.6.0，arm64，MacBook Air
- 仓库：`/Users/laysath/Projects/magpie-oh-my-aihub-import`（remote `git@github.com:faithleysath/magpie-oh-my-aihub.git`）
- 工作分支：`feature/phase10-simplified-p2p-ux`（从 `origin/main` 创建，未推送）
- 基线 main：`8ce5c57f565fb1b835021a9b730b61014eb47d5f`
- 工作树：创建前 `git status --porcelain` 为空；未修改用户已有文件，未使用独立 worktree（不是必需）

## 0. 结论摘要

1. **PR13 已合并**：`#13 feat: make Oh My AI Hub a local browser-managed Magpie plugin`，merge commit 就是当前 main `8ce5c57`，合并时间 `2026-10-30T12:39:28Z`，head 分支 `feature/local-web-console`，CI（run `41056993038`）在该 SHA 上通过。**VERIFIED**
2. Phase 9 的浏览器控制台、EasyTier no-TUN、原生 Remote Magpie、测试网钱包链路均已实现并被 PR13 带入 main；本次盘点确认代码、动作白名单、持久化文件和测试与报告一致。**VERIFIED**
3. **本轮目标版本已决定：本机 Magpie 0.1.2289 + EasyTier 2.6.4，使用隔离副本，不修改用户安装**。它不是已测试的 0.1.2171，也不是计费 pin 0.1.2038；0.1.2171→0.1.2289 相差 165 个上游提交，其中 `access`、`budget`、`gateway-key` CLI、`lan` 网关有实质变化。不得把 Phase 9 的 0.1.2171 结论直接套到本机；P0 负责最小重测。**VERIFIED（源码对比）/ UNKNOWN（0.1.2289 运行时）**
4. 0.1.2289 新增 **DeepSeek 峰谷价**（`internal/catalog/peak.go`，峰时 ×2），`budget.priceOf` 与 `usage.Record.CostAt` 都按调用时间计价；插件的 `plugin/src/pricing.ts` 会丢弃 `peak` 字段且 `priceVersion` 不含它。结果可能是“原生成本按峰时翻倍、插件账本按静态价结算”，进而触发暂停或低估。**决定：本轮 P0-2 先 fail-closed 拒绝含 `peak` 的价格，后续单独实现峰谷价。VERIFIED（源码）/ UNKNOWN（运行时）**
5. 本机 `bun run test` 当前 **740 pass / 5 fail**（52 个文件，5909 断言）。5 个失败都来自测试夹具固定时钟 `2026-10-30T12:00Z` 与真实墙钟（2026-10-31）不一致导致的“已过期”，不是产品逻辑回归；合并时 CI 是绿的。Phase 10 必须先把测试时钟注入修好，否则不能把 `bun run test` 当门禁。**REPRODUCED**
6. 现有普通用户路径仍然偏长：提供方需 **共享开关 → 读取本机模型 → 选模型 → 保存 → 发布目录 → 出示身份**，使用方需 **开启发现 → 刷新 → 核对指纹 → 选模型 → 生成申请**，提供方再 **导入申请 → 选模型/填正额度 → 批准 → 交付授权**，使用方再 **导入授权 → 确认连接**。A 的三字段交互必须在不删除这些安全确认的前提下压缩配置步骤；B 的无文件 P2P 必须替换文件往返，而不是把文件做得更漂亮。**VERIFIED（代码与报告）**
7. 主网在代码里是“注册但永远禁用”的记录：`RESERVED_MAINNETS`（56、8453）、`networkType: mainnet` 的多处硬拒绝、UI 的 `TEST_CHAINS = [97,84532]`、只允许 `testnetOnly` 资产与固定测试汇率。C 不是“打开一个开关”，而是一次跨注册表、观察器、账本、UI 与价格语义的改造。**VERIFIED**
8. 真实资金、主网自动授信、自动充值仍是 **NO-GO**；主网代码路径即使实现，也只能在没有真实资产的环境验证，并保留人工确认与硬上限。**约束来自任务与 ARCHITECTURE**
9. Phase 10 的字母严格按用户定义：**A=视觉/交互/三字段/端口/状态邻居；B=无文件 P2P/人工审批/端到端加密授权；C=钱包与主网准备；D=真实资金独立审查**。版本复测、测试时钟与最小证据不是 D，而是所有实现前的**P0 基础单元**。签名文件/邀请卡只允许作为 B 的紧急兼容回退，不能代替 B。**用户定义 / 本盘点按此执行**
10. 本盘点未重新盲测任何 Phase 9 实验，也未接触真实资产。下面“已测/未知”全部引用既有证据范围，并单独标出本次新核实的内容。

## 1. 起点、分支与 PR13

| 项目 | 值 | 状态 |
| --- | --- | --- |
| `origin` | `git@github.com:faithleysath/magpie-oh-my-aihub.git` | VERIFIED |
| 起始分支 | `main`，跟踪 `origin/main`，工作树干净 | VERIFIED |
| 基线 SHA | `8ce5c57f565fb1b835021a9b730b61014eb47d5f` | VERIFIED |
| PR13 | `#13`，`MERGED`，`2026-10-30T12:39:28Z` | VERIFIED |
| PR13 标题 | `feat: make Oh My AI Hub a local browser-managed Magpie plugin` | VERIFIED |
| PR13 head/base | `feature/local-web-console` → `main` | VERIFIED |
| PR13 merge commit | `8ce5c57f565fb1b835021a9b730b61014eb47d5f` | VERIFIED |
| PR13 规模 | 129 files changed，+18206 / −4014 | VERIFIED |
| PR13 合并后 CI | run `41056993038`，`plugin`，success，head `8ce5c57` | VERIFIED |
| 开发分支 | `feature/phase10-simplified-p2p-ux`（本地，基于上述 main，尚未 push） | VERIFIED |
| 开放 PR | 无 | VERIFIED |
| 既有 Phase10 分支/文档 | 无（`git ls-remote --heads origin 'feature/phase10*'` 为空，`docs/phase10` 本次新建） | VERIFIED |

保护措施：创建分支前确认无未提交改动；未切换到别的项目目录；未改 `~/Projects` 下其他仓库；未运行会改写用户 Magpie 配置的实验。

## 2. 版本基线与复测风险（P0，不是 D）

| 组件 | 代码/文档中的 pin | 本机实际 | 状态 |
| --- | --- | --- | --- |
| Magpie 计费/CLI pin | 0.1.2038 = `8c63c5b7873c6aa7aa797aa17f481d5fa8301876`（`docs/ARCHITECTURE.md`） | — | VERIFIED（文档） |
| Magpie Phase 9 实测 | 0.1.2171，源码 `244d80e23f91ab4e2b37b4e045d61fda5f7bca50` | — | VERIFIED（报告） |
| Magpie 本机安装 | — | `/Applications/Magpie.app` **0.1.2289**；`Contents/MacOS/magpie` SHA256 `c534dbcdb92031aa42ef6e4429d558f16d7e679b8508f82fcfde2bc07c45080c` | VERIFIED |
| 0.1.2289 上游身份 | tag `v0.1.2289` = `5c637f17b25dad63c490b1edf242c11a83b1b059` | — | VERIFIED（`gh api repos/yetone/magpie/tags`） |
| 上游最新 | `v0.1.2290` = `a808c31a7545b8627ecb620e1ccb18d8be6e9304`，release `2026-10-31T01:20:41Z`；`v0.1.2291` tag 也已存在 | — | VERIFIED |
| EasyTier | 2.6.4 = `8428a89d2dabc94c97d370ec607c6ca142473626` | 本机缓存 `~/Projects/lab/et/easytier-macos-aarch64` | VERIFIED（路径存在） |
| Bun | 1.4.3（开发/CI） | `1.4.3`（mise） | VERIFIED |
| Magpie 管理的 Bun | Phase 9：1.4.4 | `~/.cache/magpie/bun/1.4.4` 存在 | VERIFIED |
| Python（仅实验夹具） | 3.14.7 | `3.14.7` | VERIFIED |
| Foundry | 1.8.6 | `1.8.6` | VERIFIED |

**0.1.2171 → 0.1.2289 的上游变化（`gh api .../compare/244d80e...5c637f17`）：** `ahead_by: 165`；GitHub 比较接口最多列 300 个文件，列表本身不完整。已确认与插件直接相关的变更：

| 上游文件 | 变化 | 对插件的意义 |
| --- | --- | --- |
| `internal/access/access.go` | +44/−4，新增 `Identity.Default`、`On(id)`、`move-key` | 默认/共享 Key 的标记方式变化；插件读 `caller-keys.json`、按 id/name 找 Key 的假设需要重新核对 |
| `internal/cli/gateway_keys_cli.go` | +31/−1，新增 `gateway-key move` | CLI 语法只增不改；但 Phase 10 若依赖新命令需版本门 |
| `internal/budget/budget.go` | `priceOf` 改为 `pr.In(time.Now())` | 准入/成本估算按调用时刻计价 |
| `internal/usage/usage.go` | `Record.CostAt` 改为 `p.In(r.Time).CostSplit(...)`（0.1.2171 为 `p.CostSplit(...)`） | **已发生的调用也按调用时刻的峰谷价重算**；用量/limit 汇总的 cost 口径随之变化（未实机对比） |
| `internal/catalog/peak.go`（新增） | DeepSeek 峰时（UTC 周一至周五 01–04、06–10）价格 ×2，中国节假日除外 | 新价格语义 |
| `internal/gateway/lan.go` | +13，新增 `/me` Key 自助页与图片 token 例外 | 网关新增匿名可读页面；与插件无关但属暴露面变化 |
| `internal/plugin/host.js`、`internal/gui/pluginpage.go` | 本次 compare 列表未见变化（列表截断，需另证） | `UNKNOWN`：不能仅凭截断列表断言未变 |

**插件侧的对应缺口（VERIFIED 读源码）：**

- `plugin/src/pricing.ts:normalizePrice` 只读取 `input/output/cache_read/cache_write/cache_write_1h/tiers`，**不读取 `peak`**。
- `canonicalPrices` / `priceVersionOf` 因此不包含峰谷信息；`settle`/账单计算也不乘峰时系数。
- `plugin/src/magpie.ts:limitStatus` 直接把 `/v1/magpie/limit` JSON 当类型断言返回；新增字段不会报错，但语义变化不会被发现。
- 结果：在 0.1.2289 上，DeepSeek 峰时调用可能“Magpie 原生已用 = 2× 静态价，插件账本 = 1× 静态价”。`Provisioner` 的 `native used + balance` 复算会看到漂移 → `pause(drift)`；或在未检测窗口内少记费用。**UNKNOWN：未在 0.1.2289 实机复现。**

> P0 已决定：**本轮目标 Magpie 0.1.2289 + EasyTier 2.6.4，隔离副本，不改用户安装**。`peak` 先 fail-closed 拒绝，后续单独实现；不得把 0.1.2038/0.1.2171 的结论混用为 0.1.2289 的结论。

## 3. 运行面、数据面与端口

### 3.1 进程与宿主

| 层 | 入口/文件 | 说明 |
| --- | --- | --- |
| Magpie 插件宿主 | `plugin/src/index.ts`（`boot` + 默认导出） | Magpie 用自己管理的 Bun 启动；`process.cwd()` 是 Magpie 数据目录；一个数据目录只允许一个 owner |
| 宿主互斥 | `plugin/src/lock.ts` | `host.lock` 元数据 + `host.lock.sqlite` 独占事务；候补最多 11 分钟；旧宿主最多 10 分钟退役；不抢活 owner |
| 本机 HTTP API（维护者/CLI） | `plugin/src/server.ts:startApi` | 随机回环端口，Bearer `api-token`（0600）；**浏览器控制台不读取、不转发该 token** |
| 浏览器控制台 | `plugin/src/console-server.ts:startConsoleServer` | 独立 `Bun.serve`，`127.0.0.1:随机端口`，静态资源白名单 + `/ui/*` |
| EasyTier 核心 | `plugin/src/easytier.ts` | 每节点一个 `easytier-core`，插件监督；no-TUN |
| 原生插件页 | `plugin/page/*` | Magpie 沙箱页；只做打开/配对批准/公开快照/偏好；`connect-src 'none'` |

### 3.2 数据目录（`<Magpie data>/oh-my-aihub/`，`plugin/src/paths.ts:stateDir`）

| 文件 | 内容 | 关键约束 |
| --- | --- | --- |
| `state.json` | `PluginState` v3：config、providers、orphanForwards、shareSuspended | 0600；临时文件+fsync+rename；`.prev` 恢复；`networkSecret`/`secureIdentity` 只在这里 |
| `state.json.bak-*` / `.prev` | 迁移/恢复备份 | 不手工编辑 |
| `provider-keys.json` | 每个远程提供方的 Gateway Key | 0600，单独存放；`state.json` 只有 `keyRef` |
| `consumers.json` | `ConsumerRecord[]`（含 secret、cap、window、pause、deposits） | 0600；原子写 |
| `ledger.sqlite` | 本地不可变预付账本 | WAL + `FULL`；见 §7 |
| `chain.sqlite` | 链事件、intent、cursor、异常、收款地址 | 唯一约束见 §8 |
| `networks.json` | 网络/资产注册表 | 只含测试网与禁用主网记录 |
| `catalog-identity.json` | Ed25519 目录身份（私钥） | 0600；首次生成 |
| `catalog-trust.json` | TOFU（按 node id 的首次公钥指纹） | 0600；null-prototype 读取 |
| `catalog-publish.json` | 已发布报价缓存 | 读回/恢复 |
| `console-requests.json` | 申请日志（不含 Key/余额） | 0600；200 条上限；损坏 fail-closed |
| `console-wallet-operations.json` | 入账申请创建预留（UUID/输入哈希/状态） | 0600；500 条；未知结果阻止再建 |
| `console-pairing.json` | 浏览器配对预授权（哈希/状态/墓碑） | 0600；2 分钟、8 条 |
| `console-port.json` / `console-launch.json` | 控制台端口 / 打开请求与批准 | 不含票据；票据只在 URL fragment，一次性 |
| `api-token` / `api-port` | CLI API 凭据/端口 | 0600；控制台不使用 |
| `easytier/`、`easytier-state.json` | 生成的 TOML、持久化状态、二进制缓存 | 0600/0700；`current.toml` 含网络秘密，禁止外传 |
| `page/status.js`、`page/options.js`、`page/launcher.js` | 给原生沙箱页的公开快照 | 每次生成；不得含 Key/账目/RPC/会话 |

### 3.3 默认端口/监听

| 用途 | 地址 | 来源 |
| --- | --- | --- |
| Magpie Gateway | `127.0.0.1:3425`（被共享时也监听 LAN IP，ACL allow-IP） | `gatewayBaseURL()`；默认 3425 |
| 目录发布 | 提供方 LAN IP:3426 起，最多探测 base…base+4 | `state.ts:CATALOG_PORT` |
| 消费方本地转发 | `127.0.0.1:13425–13499` | `state.ts:FORWARD_PORT_FROM/TO` |
| 目录查询 SOCKS5 | `127.0.0.1:13400–13424` | `state.ts:CATALOG_SOCKS_FROM/TO` |
| EasyTier RPC portal | `127.0.0.1:随机持久化` | `configure()` 分配；不以 TOML `rpc_portal` 为准 |
| 控制台 | `127.0.0.1:随机`（保存到 `console-port.json`） | `console-launch.ts` |
| CLI API | `127.0.0.1:随机`（`api-port`） | `server.ts` |

覆盖网自身：`virtualIpv4` 默认 `10.77.0.0/24`；共享导出 `proxyCidr = <本机 LAN IP>/32`，`mappedCidr = 10.66.x.y/32`（持久随机，避开 0/255）。

## 4. 入口清单

| 入口 | 位置 | 认证 | 用途 | 状态 |
| --- | --- | --- | --- | --- |
| Magpie 原生插件页 | `plugin/page/index.html` + `app.js`/`settings.js` | Magpie 沙箱 + 官方 options bridge | 打开控制台、核对并批准浏览器配对、关闭自动打开、看公开快照 | VERIFIED |
| 系统浏览器控制台 | `plugin/console/index.html` + `app.js` | 一次性 ticket → HttpOnly Cookie + 内存 CSRF | 全部普通用户业务动作 | VERIFIED |
| 控制台匿名壳 | 同一 `/`（无 ticket） | 无 | 显示配对入口；不返回私人状态 | VERIFIED |
| 浏览器配对 | `/ui/pairing`、`/ui/pairing/exchange` | 浏览器持有的 256-bit secret；Magpie 页批准八位码 | 第二浏览器登录 | VERIFIED |
| Bearer CLI API | `plugin/src/server.ts` | `Authorization: Bearer <api-token>` | 维护者/脚本；页面不使用 | VERIFIED |
| 维护者 CLI | `plugin/bin/ohmyaihub.ts` 等 | 本机 + API token | 高级操作、灾难恢复 | VERIFIED |
| 实验脚本 | `plugin/scripts/*`、`docs/validation/lab/phase9/harness.py` | 本机夹具 | 隔离实验（非产品入口） | VERIFIED |

**原生页的硬约束**：CSP 由 Magpie 提供（`connect-src 'none'`），页面不能 fetch；不得放宽 CSP、不得伪造 Provider、不得注入 host API。官方 `options.set` 会替换整个 options 并重启**所有插件共用的 Bun 宿主**，所以打开/配对批准只合并 `consoleLaunch` 字段，其他网络选项与未知字段保留（`plugin/page/settings.js:mergeLaunch`）。

## 5. 控制台：页面、数据与动作

传输实现：`plugin/src/console-server.ts`；动作入口：`plugin/src/console-api.ts:CONSOLE_ACTIONS`；钱包动作：`plugin/src/console-wallet.ts:WALLET_CONSOLE_ACTIONS`。

### 5.1 页面（现状 7 页；A 的目标是 5 页）

| 页面（导航 id） | 主要展示 | 数据来源（轮询只做本地读） | 动作（动作名 → 适配器） |
| --- | --- | --- | --- |
| 总览 `overview` | 就绪/安全检查、EasyTier 状态、节点数、共享/使用状态、伙伴列表 | `consoleState()` → `service.consoleSnapshot()` + `consoleWorkflows().snapshot()` + `consoleWalletState()` | `checks`；`refresh` 仅重读 `/ui/api/state` |
| 发现模型 `discovery` | 伙伴目录、在线/离线、完整身份指纹、报价与价格、模型能力/阶梯价 | `status.catalog.peers`（被动缓存） | `catalog-discover`、`catalog-refresh`、`trust-peer`、`connection-request`、`catalog-connect` |
| 我的共享 `sharing` | 共享开关、可共享本机模型、目录展示字段、自己的目录身份、申请审批、已授权伙伴 | `status.config.share`、`status.catalog.quote`、`workflows.requests`、`status.consumers`、`shareCandidates` | `share-toggle`、`share-candidates`、`share-models`、`catalog-publish`、`catalog-settings`、`request-import`、`request-approve`、`request-reject`、`key-reveal`、`consumer-check`、`consumer-models`、`consumer-reissue`、`consumer-revoke` |
| 我的连接 `connections` | 每个 Remote Magpie 的 id/地址/状态/额度/模型 | `status.providers` | `consume-toggle`、`connection-preview`、`connection-import`、`provider-models`、`provider-check`、`provider-update-key`、`provider-remove` |
| 测试网钱包 `wallet` | 网络/资产/收款/观察器、入账申请、签名/转账指引、异常审计 | `wallet.registry/view/intents/anomalies/receiving` | 21 个 `wallet-*` / `deposit-*` / `accounting-*`（见下） |
| 用量与账单 `accounting` | 按消费者隔离的入账/消耗/余额/超支/窗口/原生额度/价格版本、消费分页、日志缺口、账单导入导出 | `status.consumers` + `wallet.view` | `accounting-refresh`、`accounting-history`、`wallet-statement`、`wallet-statement-preview`、`usage-gap-resolve`、`wallet-refresh`、`consumer-*` |
| 网络与设置 `settings` | 4 步首次向导 / 编辑；能力、网络名、密码、节点、监听、高级端口 | `status.config` | `configure` |

**A 的目标 IA（5 页）**：首页（仅网络状态/可用模型/我的共享/钱包/待办）、发现（目录 + 我的连接）、我的共享（自动检测 + 一次“分享这些模型” + 审批/已授权）、钱包（钱包 + 用量与账单）、网络（三字段 + **只读诊断**：端口/邻居；端口不可编辑）。首页不显示端口/引擎内部检查；旧的独立“我的连接”“用量与账单”“网络与设置”并入上述 5 页，不保留 7 页。
| 会话/配对壳 `session-panel` | 打开票据、配对码、过期、重试、退出 | `/ui/session`、`/ui/pairing*` | 客户端 `session.js` |

### 5.2 动作总数与分组

`CONSOLE_ACTIONS`（含展开的钱包动作）共 **48** 个：**27** 个非钱包动作 + `WALLET_CONSOLE_ACTIONS` **21** 个（`console-server.ts` 只接受这些名字；未知名字 404）。

| 组 | 动作 |
| --- | --- |
| 网络/检测 | `configure`, `checks`, `share-toggle`, `consume-toggle` |
| 模型/目录 | `share-candidates`, `share-models`, `catalog-publish`, `catalog-discover`, `catalog-refresh`, `catalog-settings` |
| 信任/申请 | `trust-peer`, `connection-request`, `request-import`, `request-approve`, `request-reject` |
| 授权/连接 | `key-reveal`, `connection-preview`, `connection-import`, `catalog-connect`, `provider-models`, `provider-check`, `provider-update-key`, `provider-remove` |
| 消费者 | `consumer-check`, `consumer-models`, `consumer-reissue`, `consumer-revoke` |
| 钱包设置 | `wallet-refresh`, `wallet-network`, `wallet-start`, `wallet-stop`, `wallet-asset-register`, `wallet-asset-toggle`, `wallet-receiving` |
| 充值/文件 | `wallet-intent-preview`, `wallet-intent-create`, `wallet-intent-document`, `wallet-signature-import`, `wallet-intent-cancel`, `deposit-document-preview`, `deposit-signature-document` |
| 证据/账务 | `wallet-scan`, `wallet-anomaly-resolve`, `wallet-statement`, `wallet-statement-preview`, `accounting-refresh`, `accounting-history`, `usage-gap-resolve` |

### 5.3 控制台传输与安全边界（不可回归）

- 只监听 `127.0.0.1`；校验精确 `Host`（`127.0.0.1:<port>`）与 `URL.origin`；拒绝其他回环别名、LAN、DNS rebinding。
- 浏览器请求必须带 `X-Ohmyaihub-Request: 1`；写入还必须带 `X-Ohmyaihub-CSRF`（由内存会话提供）。
- 拒绝任何 `Authorization` 头（浏览器与控制台 Bearer 通道隔离）；拒绝 query string；拒绝跨站 `Sec-Fetch-Site`；只接受同源 JSON（`application/json`、无 content-encoding、64 KiB 上限）。
- 静态资源为显式白名单（`index.html`、`app.js`、`style.css`、`session.js`、`providers.js` + 宿主声明的模块）；无文件系统路径路由；CSP `default-src 'none'`。
- 票据：32 字节、2 分钟、最多 32 个；兑换即消费；无 ticket 只能得到匿名壳。
- 会话：`ohmyaihub_ui_<port>`，HttpOnly、SameSite=Strict、`Path=/ui/`，默认不加 `Secure`（HTTP 回环，WebKit 拒绝 Secure）；最多 16 会话；空闲 30 分钟、绝对 8 小时；只读轮询不续期。
- 写入：必须 UUID `Idempotency-Key`；动作结果缓存上限 128/会话、256 KiB/结果、2 MiB/会话、8 MiB/总；敏感动作（`key-reveal`）只留 UUID 墓碑，**不缓存含密钥的响应**；未知失败统一 500 `action_outcome_unknown`，不自动重试。
- 配对：2 分钟、最多 8 条、只存哈希、`consume` 先持久化再建会话；已消费不可复活；批准只能来自 Magpie 官方 options 桥，浏览器输入不能批准。
- 状态输出会做敏感文本遮盖（`console-api.ts:clean` + `page-snapshot.ts`）；RPC URL 在钱包视图里被清空；日志不返回。

### 5.4 控制台测试覆盖（与 B 直接相关）

`plugin/console/*.test.js` 不是浏览器 DOM 测试，而是对渲染/校验纯函数与真实传输的测试；它们**断言中文文案、控件数量、动作名、指纹/额度显示**：

- `providers.test.js`（20）：价格完整性、cap 0=无限制/不安全、TOFU 必须勾选并提交原样指纹、未知额度不显示绿色、技术详情折叠等。
- `wallet.test.js`（17）：测试链选择、精确金额、被动渲染不探测、未知不按 0、分页、未知创建不重试、签名后才有转账指引。
- `session.test.js`（17）：fragment 同步移除、单次兑换、CSRF/UUID、未知写不重试、401 清理、取消/销毁。
- `test/console-security.test.ts`（32）、`console-api.test.ts`、`console-wallet.test.ts`、`console-workflows.test.ts`、`console-launch.test.ts`、`console-pairing.test.ts`、`page-settings.test.ts`：宿主/Origin/资源/配对/原生页边界。

**B（重设计）必须保留**：动作名、幂等键、敏感响应语义、CSP、无外部资源、中文安全提示与这些断言的可观察文本/结构；否则先改测试再改界面，不得直接放宽。

## 6. EasyTier

| 主题 | 位置 | 事实 |
| --- | --- | --- |
| 版本/校验 | `plugin/src/easytier-manifest.ts`、`ensureBinaries` | 2.6.4 明细到平台 SHA-256；未列平台/哈希不符即拒绝 |
| 配置生成 | `easytier.ts:renderConfig` | `no_tun = true`；`secure_mode`；`network_identity`；`proxy_network`（仅共享时）；`[[port_forward]]`（仅消费时）；`socks5_proxy`（环回） |
| ACL | `easytier.ts:renderConfig`、`plugin/src/acl.ts:checkConfig` | Inbound：`default_action = Drop`、**零规则**；Forward：`Drop` + 仅已发布 TCP 端口；`tcp_whitelist` 禁止；Forward 规则不得带地址/源端口限制 |
| 外部监听 | `renderConfig` + `checkConfig` | 所有 `port_forward` 必须 `127.0.0.1`/`localhost`；共享导出只导出本机 `/32` |
| RPC | `easytier.ts:start` | `-r 127.0.0.1:<port>`（2.6.4 忽略 TOML `rpc_portal`） |
| 运行期变更 | `easytier.ts` | 2.6.4 `acl set` 不存在；删除/重定向 forward 需**受监督重启**；`port-forward remove` 打印成功但监听仍在（Decision 12） |
| 生命周期 | `EasytierSupervisor` | `start/stop/refresh/relocateProxy`、`listPortForwards/addPortForward/removePortForward/setForwards/peers/routes/nodeInfo`；不可关闭的监听记为 orphan 并在下次启动清理 |
| 发现 | `peers()`/`routes()` | 只用 EasyTier 自己的 peer/route JSON；`peer_id` 每次启动变；无 DHT/mDNS |
| 目录查询 | `socks5_proxy` + `catalog.ts` | 环回 SOCKS5；源绑定 `proxy_url.host_str()`；只拨 mapped IPv4 |
| 检查项 | `service.ts:runChecks` | `core-running`、`acl`、`gateway-key-required`（LAN 地址无 Key 必须 401）、`mapped-cidr`、`published-gateway`、`shared-models-native-only`、`share-guard-cadence`、目录 4 项、`catalog-socks5-loopback`、`catalog-peers`、每提供方 3 项、`forwards-match`、`no-orphan-forwards` |
| 测试 | `test/acl.test.ts`、`forward.test.ts`、`binaries.test.ts`、`host-lock.test.ts`、`service.test.ts`、`final-fixes.test.ts` | ACL 反向用例、端口/转发、校验和、锁、重启恢复 |

**UNKNOWN**：本机 EasyTier 二进制是否能通过 manifest 哈希并启动、0.1.2289 下 Magpie 与 EasyTier 的组合、真实跨主机 NAT/relay 行为，本次都未重测；Phase 9 的 EasyTier 2.6.4 证据有效但版本组合不同。

## 7. 目录（Catalog）

| 主题 | 位置 | 事实 |
| --- | --- | --- |
| 服务 | `plugin/src/catalog.ts` | 独立 HTTP server，绑提供方 **LAN IP**（非 0.0.0.0/回环），只 `GET /catalog/v1` |
| 文档 | `CatalogQuoteBody` / `SignedCatalog` | schema `ohmyaihub.catalog/v1`；Ed25519 自签名；`identity` 含公钥/指纹/keyId |
| 限制 | 常量 | 64 KiB 响应、200 模型、并发 8、60 req/min（burst 10）、空闲 5 s、无 CORS、无写路径 |
| 价格 | `pricing.ts` | USD/1M tokens；输入/输出/缓存读/缓存写/1h 缓存写/阶梯；`priceVersion` = 排序后价格文档 SHA-256；`priceLocked:false` |
| 信任 | `catalog.ts` | 首次 TOFU；同 key 仍需显式接受；换 key → `identity-changed`；`catalog-trust.json` null-prototype；旧版本/同版本不同内容 → stale |
| 发现 | `service.refreshCatalogPeers` | 通过 EasyTier SOCKS5 拉取；超时/大小上限；离线保留 1 小时；重复虚拟地址/mapped 前缀 `conflict` 不探测 |
| 展示状态 | `CatalogPeerView.status` | `self/unverified/verified/identity-changed/stale/unreachable/offline/no-catalog/conflict/connected` |
| 申请/授权文档 | `connection-request.ts`、`console-workflows.ts` | `ohmyaihub.connection-request/v1`、`ohmyaihub.authorization/v1`；48 KiB 上限；approval 块是结构化数据，不是 shell |
| 连接 | `service.catalogConnect/connectProvider` | 核验身份/报价/模型/端口 → 分配环回端口 → 添加 forward → 注册 Remote Magpie → 回读模型与 limit；失败回滚本连接 |
| 检查 | `runChecks` 目录 4 项 + 伙伴身份 | 发布、Forward 端口、报价、身份、SOCKS 环回、身份变化 |
| 测试 | `catalog.test.ts`、`catalog-service.test.ts`、`console-workflows.test.ts`、`security-journey.test.ts` | 签名/结构/TOFU/伪造/过期/注入/无写路径 |

**边界**：目录只展示，不创建 Key、不入账、不转账、不自动信任；申请导入本身不授权；批准必须人选模型 + 正额度。

## 8. 钱包（测试网现状）

### 8.1 注册表（`plugin/src/networks.ts`）

| 项 | 事实 |
| --- | --- |
| 测试网 | `97 BNB Smart Chain Testnet`、`84532 Base Sepolia`，均 `enabled: true`，无 primary/preferred/default 字段 |
| 主网 | `RESERVED_MAINNETS = 56 BNB Smart Chain、8453 Base`，`enabled: false`，无 RPC |
| 硬拒绝 | `NetworkRegistry.validate`（enabled mainnet 直接抛错）、`requireEnabledNetwork`、`setNetworkEnabled`、`registerTestAsset` 只允许 testnet |
| 资产身份 | `eip155:<chainId>:<contract>`（小写）；符号不参与比较 |
| 测试资产 | 必须与链上 `decimals()` 一致；符号/名称必须含 Mock/Test；`issuerType: mock`、`testnetOnly: true` |
| 汇率 | `pricing.nanosPerToken`（固定测试汇率）+ version；不随外部价格变化 |
| 最终性 | BSC 97：`confirmations: 15`（`finalized` 标签无深度信息）；Base 84532：`finalized-tag`；每条链独立 `measured` 依据 |
| UI 限制 | `plugin/console/wallet.js:TEST_CHAINS = [97, 84532]`；`explicitNetwork()` 只接受这两个 |

### 8.2 观察器与链存储

| 主题 | 位置 | 事实 |
| --- | --- | --- |
| RPC | `plugin/src/evm.ts` | 只读 JSON-RPC；`eth_getLogs`、 receipt、block、`decimals()` |
| Watcher | `plugin/src/watcher.ts` | `scan()` → 游标+事件同事务；`verifyPending()`（回执/成功/日志在块内，可重试）；`creditFinalized()`（最终性+汇率+账本）；`health()`；`onchainDecimals()` |
| 最终性 | `finalityVerdict()` | 纯函数；未知标签不 final；按每条链策略 |
| 换算 | `convertRawToNanos()` | bigint、向下取整、dust 记录；汇率在 intent 签发时冻结（`rateNanosPerToken/rateDecimals/rateAssetId`） |
| 事件唯一 | `chainstore.ts` | `(chain_id, token_contract, tx_hash, log_index)`；`deposit_id`/`claimed_event_id`/`nonce` 各自唯一 |
| 归属 | `plugin/src/deposits.ts` | EIP-712 `DepositIntent`，domain 带 chainId；必须声明付款地址并恢复签名者；金额/收款/链/代币/发送方全匹配且唯一才 claim |
| 回退 | `watcher.ts` + `chainstore.ts` | 已入账块哈希不再 canonical → `reverted` + 异常 + `pause`；余额不删不改；只有 `reissue` 能恢复 |
| 状态 | `chainstore.ts` | stored / verified / credited 三态；`crediting` 不等于已入账 |

### 8.3 浏览器钱包适配

`plugin/src/console-wallet.ts`：一个串行队列（避免预览/创建竞态）；`snapshot()` 只做本地投影；`refresh()` 才读取证据；`KeyReadback` 60 秒绑定（key/window/cap/pause/ledger 任一变化即失效）；`wallet-statement` 48 KiB 上限；`intentOperations` 持久化预留/结果，未知结果阻止新建（不盲重试）；RPC URL 在视图中清空；错误文本 `scrub`。

`plugin/src/wallet-workflows.ts`：`ohmyaihub.deposit-request/v1`、`ohmyaihub.deposit-signature/v1`、转账指引；严格字段白名单；金额十进制/精度；`deposit-document-preview` 与 `deposit-signature-document` 纯校验，不广播。

`plugin/src/walletview.ts`：有界 UI 视图（历史/告警/时间线），未知不按 0。

`plugin/src/walletstatement.ts`：未签名账单；摘要只证明内容一致，不证明付款/身份/最终性。

### 8.4 C 的准备清单（钱包与主网准备，不是真实资金上线）

要把 C 做成，至少同时改：

1. `networks.ts`：56/8453 从 `RESERVED_MAINNETS` 变为**一等公民的只读网络**（同形展示、无 primary、用户收款网络可选但**默认空选**）；新增“可展示/可收款”与“可观察/可入账”分离的判定。主网记录不得进入 `ChainWatcher`、不得 `applyDeposit`、不得抬 Key cap。
2. `asset` 模型：严格 **`chainId + tokenContract + decimals + issuerType` 四元组**白名单 + 链上 decimals 校验；主网资产只用于展示/收款，不进入入账；拒绝符号推断与任意代币。测试资产仍按 `testnetOnly`；主网资产不能复用固定测试汇率。
3. `watcher.ts`/`chainstore.ts`：主网 reorg/最终性/RPC 多源只作为**只读展示或未来准备**，不得成为入账路径；测试网/隔离模拟链沿用既有 finality→ledger→cap。
4. `console-wallet.ts`：`wallet-network`/`wallet-scan`/`plan` 从硬编码 testnet 改为“注册表 + readOnly/creditable”判定；主网 `scan`/`intent`/`credit` 全部拒绝；`console/wallet.js` 的 `TEST_CHAINS = [97,84532]` 改为注册表驱动。
5. `wallet-workflows.ts`/`walletview.ts`：测试网/模拟链的 P2P 付款/签名/账单语义；**普通钱包不提供签名文件路径**（内置或用户明确选择的外置钱包直接签名；旧文件签名仅高级兼容）；主网只读展示；不得生成主网转账指引或广播。
6. **内置钱包**：隔离/模拟环境实现创建、恢复、锁定、敏感导出；**助记词导出必须重新验证钱包密码**；明确标注“非生产级安全”，默认不承载真实资产；密钥存储/导出方案单独安全评审。
7. **外置钱包/多扩展**：检测到多个浏览器钱包扩展时必须由用户明确选择一个；不自动挑、不自动切链；签名前核对链/合约/收款人/金额。
8. **自动充值策略**：上限、暂停条件、审批条件可配置；**可在隔离/模拟/测试网执行；主网禁止执行**（只展示策略，不发送、不入账、不授信）。
9. **主网红线**：56/8453 发送/授信（含人工逐笔确认）一律禁止；不新增任何主网入账或抬 cap 路径。C 不实现“人工逐笔授信”。
10. **价格锁定阻塞**（ARCHITECTURE Known blocker #1）与峰谷价：未解决前不得承载真实资金；本轮 `peak` 先 fail-closed。

### 8.5 B 的准备清单（无文件 P2P，不是文件加壳）

1. **独立有限控制服务**：所有已配置节点常驻，不只分享节点；只处理 `connection_request`/`authorization`/ACK，不是 Magpie 管理面、不是 AI 网关、不是第二计费点；覆盖网内开放，Inbound 仍 Drop，限并发/限长/限速。
2. **请求/授权**：结构化、限长、字段白名单、无文件；首次/身份变化人工 TOFU；提供方人工选模型 + 正额度。
3. **E2E 加密**：每请求临时密钥对 + HKDF + AEAD；授权只对使用方临时公钥加密；提供方不长期保存明文 Key。
4. **状态机**：`requested → approved → delivered → registered → acked`；**注册成功 + 模型/额度回读**即进入 `registered`，不以 ACK 为前提。
5. **ACK 恢复**：ACK 丢失允许**同 id 有界幂等重发/查询**；不重造 Key、不重复计费；一次性 nonce/幂等键防重放。
6. **业务幂等**：审批、授权、注册各自有 idempotency key；未知结果可恢复，不能“一律不重试”造成不可恢复。
7. **紧急文件回退**：现有申请/授权文件保留，但仅用户显式选择；默认不使用，不作为 B 的验收替代。

## 9. 账本（Ledger）

`plugin/src/ledger.ts`（SQLite，WAL，`FULL`）：

| 表 | 作用 |
| --- | --- |
| `accounts` | 每消费者状态 `active/paused/revoked` |
| `windows` | 账期、价格版本、密钥、`open/draining/closed`、settled |
| `deposits` | 入账 intent/applied/failed、cap、窗口 |
| `consumption` | 从 Magpie `usage.jsonl` 导入的不可变消费行（按窗口绑价） |
| `events` | 审计事件（暂停、缺口、接受的基线等） |
| `usage_offsets` / `usage_cursors` | 日志 id + 字节 offset + key id，防重读/防漏读 |
| `usage_gaps` | 持久缺口；`resolveGap` 记录责任人与接受的基线；不重建费用 |

不变量（与 ARCHITECTURE Decision 18/22 一致）：

- 金额整数 nano-USD；`B = 已应用入账 − 已结算用量`；`cap = floorGrid(native used + B)`（新窗口 `floorGrid(B)`）。
- 充值永不用 `old cap + amount`，永不 `limit reset`，窗口/周期变化是重签发而非充值。
- 已结算行用当时的价格快照，不按当前价重算；`0 ≤ B < 0.0001` 是 dust，不能发 Key。
- 消费行身份 = `(usage log id, 行字节 offset, key id)`；日志缩小/消失是 gap，暂停并拒绝重签发，直到人工 `resolveGap`。
- `reissue` 前必须无未解决 gap；drain 有界，晚到行在 30 分钟审计窗内补记并收紧 cap。
- 0 cap 在 Magpie 表示**无限额**；插件永不写 0。

## 10. Provisioner 与 Key 生命周期

`plugin/src/provisioner.ts` + `plugin/src/magpie.ts`：

- 记录：`consumers.json` 的 `ConsumerRecord`（secret、models、window、cap、credited、deposits、pending、paused、priceVersion、acceptedQuoteHash、lastCheck）。
- 写入：`magpie gateway-key add|models|limit|remove|rotate`（`magpie.ts`），每次写后 `GET /v1/magpie/limit` 回读；CLI 串行 + 超时；不调用 `--version`（macOS 从 Info.plist 读）。
- 关键方法：`ensure`、`topUp`、`applyChainDeposit`、`reissue`、`revoke`、`setModels`、`verify`、`checkConsumer`、`reconcile`、`recover`、`handover`、`guardSharedKeys`。
- 计费巡检：`Service.accountingTick()` 每 10 s + 启动/配置；连续 3 次失败撤回共享发布；`PauseReason` 与 `enforcement` 级别（`keyRevoked/secretRotated/capRestricted/networkWithdrawn/safetyUncertain`）。
- 默认窗口 `days 3650`；新 Key 用 `sk-ohmy-…`；legacy `sk-magpie-…` 首次重签发会换 secret。
- 共享限制：key 只能命名本机 native provider 的模型；拒绝 Remote Magpie / `group/` / `auto/`；`guardSharedKeys` 在启动、每次 reconcile、15 s tick 巡检；provider id/type 变化约 15 s、Key 白名单直改约 45 s 才被发现（轮询，不实时）。

**UNKNOWN**：0.1.2289 下 `gateway-key` CLI 的 `list` 输出、`caller-keys.json` 新字段、`Default/LAN` 标记对插件 `ownershipOf` 的影响；必须实测。

## 11. 安全约束清单（Phase 10 不得削弱）

1. Magpie 始终是唯一 AI 数据路径与唯一计费点；插件不代理、不计 token、不写第二份用量。
2. Ingress 必须是提供方 LAN 地址的 Forward 路径，绝不用虚拟 IP；Inbound Drop 且零规则；不得使用 `tcp_whitelist`。
3. 永不暴露 Magpie 管理界面（含 `/api/*`）给任何覆盖网成员；原生页 CSP 不放宽。
4. 无 Key/错 Key 必须 401；用尽必须 429；任何“连上=已授权”的推断都不允许。
5. Key 必须有模型白名单、正额度、$0.0001 网格；永不 `reset` 充值；0 不等于“没钱”。
6. 共享只限本机 native 有价模型；拒绝转售/回环。
7. 不引入 DHT/mDNS/新路由/中心化中转/第二网关；不买不卖不换不桥接。
8. 私钥/助记词不得出现在状态、日志、页面或快照中；内置钱包的隔离模拟密钥只在其受控存储，助记词导出必须重新验证密码；真实热钱包秘密不进入实验；主网真实资金 NO-GO。
9. 浏览器秘密不落 localStorage/sessionStorage/IndexedDB；票据一次性；敏感响应不缓存；写操作不自动重试。
10. 状态/日志/快照不含 Gateway Key、网络密码、RPC 凭据、会话票据；页脚“真实资产未开放”等提示不得被 B 删除。

## 12. 已测 / 未知矩阵

| 领域 | 已测（REPRODUCED/VERIFIED，引用） | 未知 / 限制 |
| --- | --- | --- |
| 安装/更新 | 0.1.2171 两份全新 GUI，GitHub URL 安装、Check for updates（`docs/validation/phase9-stage2.md`、`phase9-browser/github-install-update.png`） | 0.1.2289 GUI 安装/更新未测；Linux/Windows 未测 |
| 打开/配对/会话 | 0.1.2171 默认 Chrome 打开、WebKit 配对、CSRF/Origin/Cookie 差异（`phase9-stage1.md`、`webkit-cookie.json`） | 原生 WKWebView、SSH 端到端、10 分钟忙宿主交接未测 |
| 配置/网络 | 真实 EasyTier 2.6.4 双/三节点 no-TUN、ACL、映射、转发 | 0.1.2289 组合、真实 NAT/relay 变体未重测 |
| 共享/授权/Remote Magpie | 提供方发布目录、TOFU 核对、申请/人工批准/正额度、私密 Key 文件、原生 Remote Magpie、Test models 200→429（`phase9-stage2.md`） | 外部客户端经消费者网关的完整 HTTP 旅程、chat streaming/responses/messages 未在新版本重测 |
| 计费语义 | 0.1.2038 的额度、充值、窗口、重定价、并发超支（`2026-10-30-phase6-pricing-window.md` 等） | 0.1.2171 只证明指定模型 200/429；0.1.2289 峰谷价完全未测；价格锁定仍是真实资金阻塞 |
| 钱包（链/账本） | 生产 Wallet→Watcher→ChainStore→Ledger→Provisioner；BSC/Base 最终性、重复扫描、reorg、RPC503、真实 Key 回读（Phase 9 本地模拟 + PR11 真实测试网历史） | 主网（56/8453）从未入账；本地模拟 RPC 不等于公链；真实浏览器扩展未验收 |
| 账务/账单 | 消费者隔离、消费分页、未签名账单导入/导出、缺口审计（`phase9-wallet.md`、`final-consumption-history.png`） | 48 KiB 上限；未知创建预留需高级人工恢复 |
| 控制台安全 | Host/Origin/CSRF/幂等/CSP/敏感响应/配对（`test/console-security.test.ts` 32 项等） | 浏览器扩展、真实恶意站点、平台差异未穷尽 |
| 测试/CI | main `8ce5c57` CI 双平台成功；本机 typecheck/boot-check/secret-scan 通过 | 本机 `bun run test` 5 个时钟相关失败（见 §13）；CI 绿不等于当前时钟下可复现 |

## 13. 本机测试环境与本次实测

**可用环境（VERIFIED）**

- `bun 1.4.3`（mise）；`plugin/node_modules` 已安装；`bun run typecheck` **exit 0**；`bun run boot-check` **PASS**（stub Magpie 0.1.2038，API 随机端口，快照 0600）；`bun run secret-scan` **PASS**。
- `python3 3.14.7`；`forge 1.8.6`；`/Applications/Magpie.app 0.1.2289`；`~/.cache/magpie/bun/1.4.4`；`~/Projects/lab/et/easytier-macos-aarch64`。
- Phase 9 夹具：`python3 docs/validation/lab/phase9/harness.py prepare|start|status|stop|cleanup`（维护者专用；只在隔离目录运行；不得打印 runtime）。

**本次 `bun run test`（REPRODUCED）**

```text
745 tests across 52 files
740 pass
5 fail
5909 expect() calls
23.83s
```

失败项：

1. `wallet wizard > an existing pending request is listed and no second one is created`
2. `numeric admission precedes durable wallet intent reservation > imported signing fields and payer cannot drift from the exact typed data`
3. `browser wallet workflows > preview/create/document/signature/import use real domain and durable same-invoice replay`
4. `browser wallet workflows > pending older than 50-row preview still blocks new request`
5. `browser wallet workflows > production watcher credit stays unproven until explicit gateway evidence and duplicate scan cannot recredit`

根因（VERIFIED）：`plugin/test/support/wallet-lab.ts:84` 把夹具时钟固定在 `2026-10-30T12:00:00Z`，而真实墙钟已是 `2026-10-31`；wizard/console 的 pending 过滤与签名文件校验使用真实 `now`/`Date.now`，于是旧的 1 小时 intent 被判定过期。示例：测试期望“不匹配”，实际得到“请求已过期或到期时间不一致”。这是**测试时钟耦合（time bomb）**，不是本次代码变更造成的产品回归；PR13 合并时（2026-10-30）CI 通过。**Phase 10 必须先注入可控时钟或改夹具，才能恢复可靠的本地门禁。**

## 14. PR13 既有验证是否满足最初 VALIDATION 前置

`docs/VALIDATION.md` 的 8 条是 Phase 0 的验收清单。逐条核对如下（不重跑、不假定）：

| # | VALIDATION 要求 | PR13/既有证据 | 判定 |
| --- | --- | --- | --- |
| 1 | 专用 Key 只绑一个测试模型；确认与 B 使用同一入口 | Phase 9：UI 创建 `$0.0001` cap、原生 Remote Magpie、模型回读（`phase9-stage2.md` §4–6） | **部分满足**：同入口的“有效 Key 200/用尽 429”已测；“同一 ingress 的无效/无 Key 401”由 Phase 3/4 的 0.1.2038 证据覆盖，Phase 9 未在本轮重测 |
| 2 | 发现 Peer 覆盖 IP；no-TUN B→A；记录监听/防火墙；A 其他端口不可达 | Phase 3/4 的 ACL + 双主机 + `easytier-cli route` 证据；Phase 9 再次使用真实 EasyTier 2.6.4 | **满足（0.1.2038 范围）**；0.1.2171/0.1.2289 只部分重测，未逐端口复测 |
| 3 | 无/错/有效 Key 经覆盖网调用：拒绝/拒绝/成功 | Phase 3/4 实测 401/401/200；Phase 9 实测有效 200、用尽 429 | **满足（0.1.2038）**；0.1.2171 未重测 401 的两条；0.1.2289 未测 |
| 4 | 小额度、真实请求、额度耗尽拒绝；单请求超剩余、并发请求 | Phase 6 在 0.1.2038 上测量 429/Retry-After、软上限与超支；Phase 9 观察 `$0.0120 > $0.0001` 的既定超支 | **满足（0.1.2038）**；0.1.2171/0.1.2289 未重测并发/超支 |
| 5 | 官方 CLI/API 提高额度而不 reset；used 保留；0 vs 无限 | Phase 6 测量；插件 `topUp` 走 `native used + balance` | **满足（0.1.2038）**；0.1.2289 CLI/access 变化后 UNKNOWN |
| 6 | 长窗口、过期/续期、重启、改价；安全 rollover | Phase 6 测量 3650 天、窗口边界、重启、改价/暂停/重签发 | **满足（0.1.2038）**；0.1.2171 明示未重测全部计费语义；0.1.2289 新增峰谷价，**不满足** |
| 7 | B 建 Remote Magpie；模型发现；chat streaming/responses/messages；原生 routing group | Phase 9 完成 Remote Magpie、模型发现、原生 Test models；Phase 3/4 有跨主机请求证据 | **部分满足**：本轮没有外部客户端经消费者网关的 streaming/responses/messages 新证据；routing group 未重测 |
| 8 | 插件/host bridge 能力与限制 | Phase 8/9 的 CSP、options bridge、宿主重启、页面不能联网证据；`docs/validation/phase8-csp.md`、`phase9-security.md` | **满足（0.1.2120/0.1.2171 范围）**；0.1.2289 未重测，`host.js/pluginpage.go` 是否变化未证实 |

**结论**：PR13 的既有验证**足以支撑开始 Phase 10 的 A/B 实现**（安全入口、ACL、Key 路径、控制台隔离都有可引用证据），但**不足以支撑把 C 直接推向主网真实资金**，也**不足以把 0.1.2289 当作已测版本**。所有实现前需要 **P0 基础单元**做一次“0.1.2289 隔离副本 + 峰谷价 fail-closed + 测试时钟 + 401/429/限额/重启”的最小重测，而不是重跑全部 Phase 6；**D 是 C 之后的真实资金独立审查，本阶段只产出 NO-GO 清单、不执行真实资金**；版本门是 P0。

## 15. Phase 10 开始条件（建议门）

**可以立即开始（P0 并行）**

- A：5 页 IA、三字段首次、首页 5 块、自动检测+一次分享、只读端口/邻居、贴纸视觉；不改 Service 的安全判定。
- B：所有节点独立有限控制服务、加密/请求 schema、注册/ACK 状态机与幂等恢复的设计/单元测试；真实联调等 P0。
- C：钱包/主网准备（四元组资产、内置/外置钱包、助记词复验、直接签名、自动充值策略）的抽象与隔离模拟；主网发送/授信仍不实现。

**必须先满足才能开始（P0）**

- P0-1：0.1.2289 + EasyTier 2.6.4 隔离副本（不改用户安装）。
- P0-2：含 `peak` 的价格先 fail-closed 拒绝；后续单独实现峰谷价。
- P0-3：测试时钟；`bun run test` 全绿。
- P0-4：目标版本最小 401/429/limit/top-up/restart 证据。
- C 的主网只读边界、内置/外置钱包、敏感导出与自动充值策略通过安全评审；主网发送/授信不实现。

**仍然 NO-GO（任何阶段）**

- 真实资金、主网发送/授信（含人工逐笔）、C2C 法币、代币发行、中心化中转 API、暴露 Magpie 管理界面。
- 隔离模拟钱包、内置钱包、敏感导出、自动充值策略是 C 的开发范围，**不能**一并禁止。
- 用本地模拟 RPC/签名器冒充公链付款；用 Test models 结果冒充完整外部客户端 streaming 证据。
- 把 0.1.2038/0.1.2171 的结论写成 0.1.2289 的结论。

## 16. 常用命令（不读取秘密）

```sh
# 代码/CI（在 plugin/）
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun run test          # 注意：2026-10-31 起有 5 个时钟相关失败，见 §13
bun run boot-check
bun run secret-scan

# 版本/来源
git rev-parse HEAD origin/main
gh pr view 13 --json number,state,mergedAt,mergeCommit,headRefName,baseRefName
gh api repos/yetone/magpie/tags --jq '.[0:5][] | .name + " " + .commit.sha'
sw_vers; uname -m
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Magpie.app/Contents/Info.plist

# 隔离实验（维护者，绝不在真实配置上跑）
python3 docs/validation/lab/phase9/harness.py prepare --nodes 3
python3 docs/validation/lab/phase9/harness.py start --runtime /tmp/<lab>/runtime.json --node provider
python3 docs/validation/lab/phase9/harness.py status --runtime /tmp/<lab>/runtime.json
python3 docs/validation/lab/phase9/harness.py cleanup --runtime /tmp/<lab>/runtime.json
```

## 17. 需要主代理/用户确认的问题

1. **A 的“三字段”具体是哪三个**：本盘点按“网络名称、网络密码、连接节点”记录，端口与邻居状态是展示/高级项。若用户指的是别的三字段，只需改 FLOWS 的 A 小节。
2. **B 的加密授权通道**：允许新增一个覆盖网内、非 Magpie 管理、非 AI 网关的插件控制端口吗？还是必须复用现有目录/转发路径？这决定 B 的实现形态。
3. **C 的主网准备边界**：56/8453 只读平权、默认空选、四元组严格资产、内置/外置钱包、敏感导出+密码复验、直接签名、自动充值策略；主网发送/授信硬禁止，真实资金由 D 独立审查并产出 NO-GO 清单。
4. **目标版本**：已决定 0.1.2289 + EasyTier 2.6.4（隔离副本）；0.1.2038/0.1.2171 只作历史证据。
5. **是否允许在 Phase 10 修测试时钟**（`test/support/wallet-lab.ts` + 相关断言）：这是恢复本地门禁的最小改动，但会触碰既有测试。
