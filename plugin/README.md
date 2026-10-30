# Oh My AIHub 插件

此目录包含 Magpie 插件、私有网络监督器和独立浏览器控制台。普通用户从 Magpie 的 **Plugins → Discover** 底部手动添加 `github:faithleysath/magpie-oh-my-aihub`，不用下载此目录，也不用填写源码或数据路径。Magpie 管理 Bun；只有选择维护者 CLI 或开发测试时才另行需要命令行工具。

[首次使用](../docs/ONBOARDING.md) · [日常操作](../docs/OPERATIONS.md) · [高级维护与灾难恢复](../docs/ADVANCED-CLI.md) · [架构与历史证据](../docs/ARCHITECTURE.md)

## 打开与登录

在 Magpie 打开 **Oh My AIHub → 打开控制台**，由系统默认浏览器进入本机控制台。想用其他浏览器时，复制插件页的普通 `http://127.0.0.1:端口` 地址，选择 **配对此浏览器**，再回到 Magpie 刷新、核对完整八位码、勾选确认并批准。请求两分钟内有效；普通地址和八位码都不能单独换取登录。

控制台只绑定本机回环，不暴露 Magpie 管理界面。SSH 转发属于[高级使用](../docs/OPERATIONS.md#通过-ssh-转发使用控制台)。不创建公网临时通道，也不通过虚构模型服务商、Electron 或新的 AI 请求代理打开页面。

## 目录与职责

| 位置 | 职责 |
| --- | --- |
| `src/index.ts`、`lock.ts` | 每个 Magpie 数据目录的唯一宿主；等待旧宿主退出，不抢占存活 owner；同步停止自己拥有的核心后释放锁 |
| `src/console-launch.ts`、`page/` | Magpie 沙箱页的打开与配对审批入口、无凭据公开快照、固定系统浏览器 opener |
| `src/console-server.ts`、`console-pairing.ts` | 独立回环静态页面、短期凭证、内存会话、CSRF、幂等请求边界；配对预授权跨批准重启保留，已登录会话不保留 |
| `console/`、`src/console-api.ts` | 浏览器界面与白名单 Service 操作，普通页面读取不主动探测远端 |
| `src/service.ts`、`easytier.ts` | 一套 EasyTier no-TUN 核心、多提供方连接、目录和原生共享限制 |
| `src/provisioner.ts`、`ledger.ts` | 沿用现有 Gateway Key 写入/读回与本地不可变预付账本 |
| `src/wallet.ts`、`watcher.ts`、`networks.ts` | 现有测试网注册表、签名归属、逐链最终性和账本桥接；浏览器操作与证据边界见钱包验证报告 |
| `bin/` | 保留的高级 CLI，不是普通用户界面的执行后端 |

所有 AI 请求仍经消费方 Magpie → EasyTier → 提供方 Magpie；插件不转发 AI 内容、不计 token、不另写请求账单。Magpie 管理界面从不映射到覆盖网。只共享本机、完整定价的原生模型，拒绝 Remote Magpie、`group/…` 和 `auto/…` 转售。

## 生命周期与隐私

原生插件页的官方选项桥会替换本插件的完整选项并重启共用宿主。因此打开/审批只合并对应字段，保留未知选项及网络设置。默认首次本机桌面自动打开一次，可关闭；CLI、SSH、无桌面环境不自动循环打开。普通控制台按钮直接调用 Service，不启动 CLI、不保存 Magpie 选项。改网络、移除或重定向连接可能重启同一个 EasyTier 核心并短暂中断其他连接。

插件自己的状态在 Magpie 管理的数据目录内，用户不必手工寻找。`host.lock.sqlite` 使用系统文件锁随进程崩溃释放；`host.lock` 保留兼容 owner 元数据。不得在节点运行时删除锁或手改账本、Magpie Key 文件及生成的 TOML。备份先完整停止 Magpie，按高级参考执行。

页面不持久化会话、浏览器配对秘密或钱包私钥。原生页快照不包含 Gateway Key、账目明细、付款关联、RPC 凭据或会话票据。授权文件只在明确交付操作中显示/下载；下载文件的权限由浏览器和系统控制，不能承诺 `0600`。

## 已测版本与未测范围

本轮普通 GUI 安装/更新、浏览器入口/配对、真实网络、双节点申请审批/授权导入、原生 Remote Magpie 及 Test models 的 200→429 在两份全新 **Magpie 0.1.2171** 环境与 **EasyTier 2.6.4** 上实测；模型上游为受控模拟服务。EasyTier 二进制通过 `src/easytier-manifest.ts` 的 SHA-256 校验。

Ego 已完成 BSC/Base 受控本地模拟 RPC、实际 EIP-712 合成外部签名、生产观察器/账本/原生额度读回（1.0001→2.0001）、重复扫描、无签名账单交接与 RPC503未知状态；原生模型调用从429恢复200。WebKit 第二提供方完整手动流程，以及字面文本注入不执行、提供方暂停隔离/恢复已通过。[共享报告](../docs/validation/phase9-stage2.md)、[钱包报告](../docs/validation/phase9-wallet.md)、[安全报告](../docs/validation/phase9-security.md)给出逐项范围。本地模拟没有新的公链转账；WebKit钱包9步真实UI复测亦已通过新增0.5BSC模拟入账、最终性/重放和原生Test models200，见[WebKit记录](../docs/validation/phase9-browser/webkit-wallet.json)。最终清理与全面结论由最终报告记录。

历史价格/计费基线仍为 Magpie **0.1.2038**，0.1.2171 未重测全部计费语义。历史 Linux0.1.2057 消费容器及 PR11 真实测试网证据保留独立范围。真实浏览器钱包扩展、原生 WKWebView、Linux/Windows 桌面与 SSH 端到端仍未知。账单上限48KiB；未知入账申请预留需要高级人工恢复，普通界面不清除此阻止。钱包只处理测试代币，真实资金与主网不开放。

维护者开发检查从此目录运行 `bun run ci`；需要 Magpie、EasyTier 源码及平台证据时，使用[架构参考](../docs/ARCHITECTURE.md)中的精确版本和验证报告，而非依赖界面显示推断安全性。
