# Phase 10 A/B 修改前证据交付包

本目录由 Phase 10 审查/验证代理提供材料、文档代理统一收录；**不含应用代码改动**。文中 `$MAIN_WORKTREE`、`<lab-root>`、`<integration-worktree>` 是已脱敏的实验路径占位符。

## 目录

```
docs/phase10/evidence/
├── README.md                               ← 本文件（来源/索引/脱敏/边界）
├── 2026-10-31-current-console-before.md     ← 当前 Console 修改前 UI 审查（事实版）
├── 2026-10-31-reference-review.md           ← 参考仓库设计体系研究（事实版）
├── 2026-10-31-external-wallet-test-plan.md  ← 外置钱包真实扩展验收计划（附录；BLOCKED/UNKNOWN）
├── 2026-10-31-integration-cc0d740-validation.md      ← cc0 组合软件验证（845/8→853/0；非产品 GO）
├── 2026-10-31-integration-cc0d740-host.md             ← cc0 真实宿主加载/首配/会话证据（非 Visual GO）
├── 2026-10-31-integration-cc0d740-host-env.txt        ← PID/端口/argv 脱敏摘录
├── 2026-10-31-integration-cc0d740-console.sha256     ← cc0 Console 5 文件 hash
├── 2026-10-31-integration-cc0d740-host.SHA256SUMS    ← 上述文件 + 7 图 hash
├── 2026-10-31-a-lab-1c14ec4-e2e.md                    ← A-lab 同机 loopback E2E（协议 PASS / UX NO-GO）
├── 2026-10-31-a-lab-1c14ec4-browser.md                ← A-lab 真实宿主浏览器验收（F1/F2）
├── a-lab-1c14ec4/                                    ← sanitized protocol/PID/cleanup evidence + SHA256SUMS
└── a-lab-1c14ec4/screenshots/                        ← 10 张 A-lab 精选图
├── screenshots/                             ← 16 张修改前实拍 + SHA256SUMS
└── screenshots/cc0d740/                     ← cc0 真实宿主 7 张（hash 见 host.SHA256SUMS）
```

两份主报告均已删除自拟产品方案；目标信息架构、页面划分与流程一律指向主任务与 `docs/phase10/FLOWS.md`。

## 来源

| 项 | 值 |
|---|---|
| 仓库/提交 | `$MAIN_WORKTREE`（detached worktree @ `8ce5c57f565fb1b835021a9b730b61014eb47d5f`，与 `origin/main` 一致，只读使用） |
| 采集时间 | 2026-10-31 09:37–09:52（Asia/Shanghai） |
| 平台 | macOS 26.6.2 (25G83)，Darwin arm64 |
| 浏览器 | ego-lite（Chromium 内核，ego-browser 2.2.0） |
| Magpie | 0.1.2289，从 `/Applications/Magpie.app` 复制到 `<lab-root>/Magpie.app`，`HOME` 指向隔离目录 |
| 插件 | Oh My AIHub 0.5.0（本项目 main），通过 Magpie UI 以本地文件夹安装 |
| 网络 | 新建随机网络，无伙伴；EasyTier 2.6.4 下载到隔离目录并校验 |
| 登录 | 真实配对流程（Console 生成 8 位码 → Magpie 插件页核对批准 → 宿主重启 → 会话） |

## 截图索引

| 文件 | 内容 | 原文件名（实验目录，未入库） |
|---|---|---|
| `01-first-run-environment-1440.png` | 首次进入：向导第 1 步（环境检查） | `00-first-run-setting-1440-light.png` |
| `02-first-run-capabilities-1440.png` | 第 2 步：两个能力卡片 | `01-wizard-roles-1440-light.png` |
| `03-first-run-network-fields-1440.png` | 第 3 步：网络名称/密码/节点/高级设置（字段为空） | `02-wizard-network-1440-light.png` |
| `04-error-form-validation-1440.png` | 表单校验错误 | `04-wizard-validation-error-1440-light.png` |
| `05-home-light-1440.png` | 首页（总览）浅色 | `10-overview-1440-light.png` |
| `06-home-dark-1440.png` | 首页深色 | `20-overview-1440-dark.png` |
| `07-home-light-390.png` | 首页窄屏 390 | `30-overview-390-light.png` |
| `08-discovery-light-1440.png` | 发现页浅色 | `11-discovery-1440-light.png` |
| `09-sharing-light-1440.png` | 我的共享浅色（全页 1979px） | `12-sharing-1440-light.png` |
| `10-sharing-light-390.png` | 我的共享窄屏 | `32-sharing-390-light.png` |
| `11-wallet-light-1440.png` | 钱包浅色（全页 1726px） | `14-wallet-1440-light.png` |
| `12-wallet-dark-1440.png` | 钱包深色 | `24-wallet-1440-dark.png` |
| `13-wallet-light-390.png` | 钱包窄屏 | `34-wallet-390-light.png` |
| `14-network-light-1440.png` | 网络与设置（向导第 4 步/保存后） | `16-settings-1440-light.png` |
| `15-error-session-ended-1440.png` | 退出会话后的结束态 | `42-session-ended-1440-light.png` |
| `16-error-anonymous-shell-1440.png` | 匿名首访（"会话已结束" + 配对入口） | `43-anonymous-shell-1440-light.png` |

完整 30 张原始截图与 7 页 innerText 留在实验目录（`<lab-root>`），**未纳入本包**（体积与信息密度）；本包只收录 16 张精选图。

> 边界：截图来自 **0.1.2289 真实宿主的空网络**，没有真实伙伴、真实 P2P 授权或钱包交易。它是**修改前审查证据**，可标 REPRODUCED/已审查，**不能标 Visual UX GO**，也不能当作 Phase 10 验收。

## 脱敏说明

- 不含私钥、助记词、API Key、Gateway Key、会话票据、URL 票据、Cookie、`.config/magpie` 副本或任何 HOME 目录副本。
- 截图中没有密码明文：网络密钥输入框在截图前为空；登录会话通过 8 位配对码建立，票据只出现在浏览器地址栏，不在截图范围内。
- 图中可见的 `audit-lab-7f3c`、`ohmyaihub-ebab4c62`、`10.77.0.59/24` 是本次实验的**临时网络名、节点 ID 与覆盖网地址**，不是密钥，也不足以加入网络（加入需要未显示、未落盘的网络密钥）。
- 登录账号来自本机 Magpie 的隔离实例，无第三方个人数据；生产实例 `ai.isok.dev` 只做了未登录只读浏览（见 REFERENCE 报告）。

## 边界

- 这是 **UI 审查**，不是 Phase 10 验收：Magpie 0.1.2289 仅用于界面，计费/版本结论仍以既有 pin 和报告为准。
- 空网络截图只能证明空态与结构，**不能**证明完整 UX、真实伙伴流程或真实链上入账（后者见各报告 UNKNOWN 节）。
- 参考报告只提供可核对事实与视觉规则；不定义本项目页面、流程或交互。

## 仓库内位置（已收录）

- `docs/phase10/evidence/2026-10-31-current-console-before.md`
- `docs/phase10/evidence/2026-10-31-reference-review.md`
- `docs/phase10/evidence/2026-10-31-external-wallet-test-plan.md`（外置钱包测试计划；BLOCKED/UNKNOWN，不是验收）
- `docs/phase10/evidence/screenshots/`（16 张 PNG + `SHA256SUMS`）
- `docs/phase10/evidence/2026-10-31-integration-cc0d740-validation.md`
- `docs/phase10/evidence/2026-10-31-integration-cc0d740-host.md`
- `docs/phase10/evidence/2026-10-31-integration-cc0d740-host-env.txt`
- `docs/phase10/evidence/2026-10-31-integration-cc0d740-console.sha256`
- `docs/phase10/evidence/2026-10-31-integration-cc0d740-host.SHA256SUMS`
- `docs/phase10/evidence/screenshots/cc0d740/`（7 张 PNG）
- `docs/phase10/evidence/2026-10-31-a-lab-1c14ec4-e2e.md`
- `docs/phase10/evidence/2026-10-31-a-lab-1c14ec4-browser.md`
- `docs/phase10/evidence/a-lab-1c14ec4/`（sanitized evidence + `SHA256SUMS`）
- `docs/phase10/evidence/a-lab-1c14ec4/screenshots/`（10 张）

## cc0 与 next 证据边界

- **cc0 `cc0d740`**：组合软件验证 845 pass/8 fail（全部 `EADDRNOTAVAIL`，`TIME_WAIT` 16 244/16 384）→ 恢复后 853/0；frozen install/typecheck/boot/secret PASS。真实宿主以**本地目录**安装，5 个 UI 文件 hash、ownerPid/status.pid/listener/argv 一致；三字段/主题/焦点/390/logout PASS；**5 页业务/join/share/payment UNKNOWN**。tracked 源 clean，但宿主会写 ignored 运行期文件，不能称“源完全未写”。**非产品 GO**。
- **next `87a72c6`**：只接 #28 安全工具 delta；gitleaks 12 selftest、pack --selftest、组合 worktree scan 0。**与 cc0 的 116 raw findings 分开记**，不混称。
- **#24 Windows 子集**与 **#31 dynamic ports** 是两项独立证据；报告列表不得写成“Windows #31”。

## A-lab 1c14ec4 证据边界

- 同机 loopback ET 链路，**不是 NAT/relay/WAN**；真实 Magpie 0.1.2289 + EasyTier 2.6.4。
- 协议层：三字段双 join、目录真实发现、ACL/管理隔离、401/401/200、原生 429、同 key cap forward 13425→13426 再 restart、evidence gen3 PASS。
- Remote 由 f63b 内部实验动作准备，是 **synthetic fixture**，不是 B 文件/ZeroFile GO，也不是普通用户授权路径。
- 浏览器：F1 勾选后分享按钮不同步、F2 hidden CSS 让停止共享可见，**A 总 UX NO-GO**；分享结果不能标正常路径 PASS。
- 清理：8 PID manifest、9 lab ports free、lab root 删除；原始 secret/state 不入库。
- 原始报告 hash：E2E `d5c9a9eb…`，browser `5f025b97…`；仓库脱敏副本 hash：E2E `65d6f70d…`，browser `6a6d2803…`；证据文件 hash 见 `a-lab-1c14ec4/SHA256SUMS`。
- `copy-manifest-reconstructed.json` = `130542f5…`，是从冻结 HEAD 在 lab root 删除后重建，**不是原始 per-node manifest**；删除前 76 文件 0 mismatch 记录在 E2E 报告。
- `cleanup-proof.json` = `e0c2787b…`，第二次 cleanup 覆盖导致 `before` 为空；真实 PID 在 `cleanup-last.json`/`pid-manifest.json`。`http-transcript-sanitized.json` 是摘要，不是 byte-exact raw。
- 只收录 8 张精选图；未精选 22 张未入库。A-lab 无活动环境，协议主路径 PASS 但 F1/F2 使 A 分享 UX 不判 PASS。

收录时保留“实验临时标识非密钥”的说明，并注明完整原始截图与 innerText 未入库。
