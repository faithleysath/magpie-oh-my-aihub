# Phase 10 — 任务矩阵与调度状态（STATUS）

> 这是持续调度记录，不是验收报告。每次状态变化追加/更新一行，并写明证据路径与日期。
> 状态值：`TODO`（未开始）、`DOING`（进行中）、`BLOCKED`（前置未满足）、`REVIEW`（待审）、`DONE`（证据齐全）、`NO-GO`（明确不做）。
> 任何 `DONE` 必须能指向可复现的命令、日志或截图；不得用“看起来可以”代替证据。

## 0. 当前快照

| 项 | 值 |
| --- | --- |
| 快照时间 | 2026-10-31 |
| 基线 main | `8ce5c57f565fb1b835021a9b730b61014eb47d5f` |
| PR13 | `#13`，MERGED，merge SHA = 上述 main；CI run `41056993038` success |
| 开发分支 | `feature/phase10-simplified-p2p-ux`（本地，未推送） |
| 文档提交 | 见 `git log --oneline -- docs/phase10`（INVENTORY / FLOWS / STATUS 同一提交） |
| 盘点工作树 | `/Users/laysath/Projects/magpie-oh-my-aihub-import`（唯一工作树；未另开分支 worktree） |
| 纯 main 只读工作树 | `/tmp/oma-phase10-main-8ce5c57`（detached @ `8ce5c57`，供审查代理只读） |
| 本机 Magpie | `/Applications/Magpie.app` **0.1.2289**（≠ pin 0.1.2038，≠ Phase 9 实测 0.1.2171） |
| EasyTier | 2.6.4；本机缓存 `~/Projects/lab/et/easytier-macos-aarch64` |
| Bun | 1.4.3；`plugin/node_modules` 已装 |
| 本地门禁 | `typecheck` / `boot-check` / `secret-scan` 通过；`bun run test` 740 pass / 5 fail（固定时钟 time-bomb，见 INVENTORY §13） |
| 参考研究 | 设计/审查代理 `6a326f2b-2249-4123-8f35-1fe35926e107` 已产出 `/tmp/oma-research/REFERENCE-REVIEW.md` |
| 真实资金 | **NO-GO**（始终） |
| 主网自动授信/自动充值 | **NO-GO**（始终） |

## 1. 代理与职责

| 角色 | 代理/标识 | 职责 | 禁止 |
| --- | --- | --- | --- |
| 主调度 | 父代理 | 分派、合并决策、最终验收 | 不得把未证结论写成 DONE |
| 盘点/集成 | 本代理（INTEGRATION） | 入口清单、流程图、任务矩阵、分支/文档 | 不跳过审查直接实现 C |
| 设计/Console 审查 | `6a326f2b-2249-4123-8f35-1fe35926e107` | 参考研究、改动前/后真实浏览器审查 | **不得修改应用代码**；只读仓库 + `/tmp` 脚本 |
| A 实现 | 待分派 | 极简 P2P | 不得放宽信任/审批/额度 |
| B 实现 | 待分派 | 贴纸风视觉 | 不得改动作名/传输/CSP |
| C 实现 | 待分派 | 主网能力（默认禁用 + 人工授信） | 不得接真实资金/自动授信/热钱包 |
| D 验证 | 待分派（独立于实现） | 版本重钉、最小重测、门禁证据 | 不得用模拟冒充公链/真实 Magpie |
| 最终验收 | 父代理 | 对照 FLOWS 矩阵逐项签字 | 不得合并 PR（本阶段要求） |

> 本代理是子代理：**不创建任何子代理**。上表“待分派”由父代理调度。

## 2. 任务矩阵

### D — 版本重钉与证据门（最先启动）

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | NO-GO / 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| D0 | 记录 main/PR13/CI 与工作分支 | INTEGRATION | DONE | — | 本文 §0；INVENTORY §1 | 不改代码 |
| D1 | 决定目标 Magpie 版本（0.1.2171 或 0.1.2289） | 父代理 + D 实现 | BLOCKED | 用户/主代理确认 | 决策记录：tag/commit/二进制 SHA/平台 | 未决定前 C 不落地 |
| D2 | 隔离夹具最小重测：401/429/limit/top-up/restart | D 实现 | TODO | D1 | 脱敏日志 + 版本/平台；真实 Magpie + EasyTier 2.6.4 | 不得复用 0.1.2038 结论冒充 |
| D3 | 峰谷价 `peak` 处理 | D 实现 + C | TODO | D1 | 单元 + 实机：价格版本/结算与原生一致，或显式拒绝 | 未处理前 C 阻塞 |
| D4 | 修复测试固定时钟 | D 实现 | TODO | — | `bun run test` 全绿（本机 + CI） | 不改变产品语义 |
| D5 | 证据归档 + 双平台 CI | D 实现 | TODO | D2–D4 | PR/run 链接、命令、原始脱敏输出 | 不合并 PR |
| D6 | 更新 ARCHITECTURE pin 与限制 | INTEGRATION | TODO | D1–D5 | 文档 diff | 不静默改历史结论 |

### A — 极简 P2P

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | NO-GO / 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| A0 | 盘点现状与步骤数 | INTEGRATION | DONE | — | FLOWS §2 | — |
| A1 | 邀请卡 schema/导出（无 Key；密码默认不含） | A 实现 | TODO | D4 | 文件 + 字段快照 + 负向测试 | 不得含 Gateway Key；含密码需二次确认 |
| A2 | 导入邀请卡 + 预填 `configure` | A 实现 | TODO | A1 | 两节点 UI 步骤 + state 回读 | 不自动信任；失败回滚 |
| A3 | 实时目录 + 指纹门 | A 实现 | TODO | A2 | `identity-changed/conflict/stale` 负向 | 不得用卡片指纹替代实时目录 |
| A4 | 一键申请（同 schema） | A 实现 | TODO | A3 | `ohmyaihub.connection-request/v1`；48 KiB 校验 | 不新增授权语义 |
| A5 | 一键批准（仍人工选模型+正额度） | A 实现 | TODO | A4 | UI + `consumer-check`/Key 回读 | 不自动批准/不自动充值 |
| A6 | 授权导入/连接 | A 实现 | TODO | A5 | 原生 Remote Magpie + 模型集合回读 | 不注册非本插件连接 |
| A7 | 回归 | A 实现 + 审查 | TODO | A1–A6 | `providers.test.js`、`console-workflows.test.ts`、`console-security.test.ts` | 不放宽白名单 |

### B — 贴纸风重设计

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | NO-GO / 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| B0 | 参考研究与 token 方向 | 设计/审查代理 | DOING | — | `/tmp/oma-research/REFERENCE-REVIEW.md` + 设计稿 | 不复制第三方品牌资产 |
| B1 | 设计 token（色/描边/阴影/圆角/字阶） | B 实现 | TODO | B0 | `style.css` diff + 截图 | 无远程资源 |
| B2 | 7 页 + 弹窗 + 空/错/加载态 | B 实现 | TODO | A 页面稳定 | 深/浅/窄屏截图矩阵 | 不改 DOM id/动作名 |
| B3 | 安全提示保留与层级 | B 实现 | TODO | B2 | 截图 + 测试 | 价格未锁定/真实资产未开放/未知≠0 不得删 |
| B4 | 可访问性 | B 实现 + 审查 | TODO | B2 | 键盘/对比度/ARIA/减少动效 | 不只用颜色表意 |
| B5 | 行为零回归 | 审查 + D | TODO | B1–B4 | console/security 测试 + DevTools 无外部请求 | 不放宽 CSP/传输 |

### C — 主网钱包（真实资金 NO-GO）

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | NO-GO / 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 主网记录默认禁用 + 显式启用门 | C 实现 | TODO | D1 | 注册表测试：56/8453 默认 false；启用需确认 | 无确认不得启用 |
| C2 | 真实资产身份（链+合约） | C 实现 | TODO | C1 | 合约/decimals/issuer 证据 | 不用符号；Mock 拒绝 |
| C3 | 主网最终性/多 RPC | C 实现 + D | BLOCKED | C2, D2 | 每链实测 + rationale | 未知不 final |
| C4 | 真实价格/汇率 + 峰谷价 | C 实现 + D | BLOCKED | D3 | 价格版本/已结算不重算/原生一致 | 未解决价格锁定不承载资金 |
| C5 | 最终性后人工逐笔授信 | C 实现 | TODO | C3 | 审计记录 + 账本/Key 回读 | 不自动抬 cap |
| C6 | 无自动充值/自动重发/自动解冻 | C 实现 | TODO | C5 | 负向测试 | 收到转账不自动恢复 |
| C7 | 隔离/fork 验证（无真实资产） | D 实现 | TODO | C1–C6 | 明确“本地模拟/未上主网” | 不得写成公链付款 |
| C8 | 真实主网转账/真实资金 | — | NO-GO | — | — | **禁止执行** |

### 审查与交付

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | NO-GO / 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 改动前真实浏览器审查（当前 UI） | 设计/审查代理 | TODO | 本文 §3 环境 | 截图/问题清单；不修改应用代码 | 不得把 0.1.2289 UI 审查写成验收 |
| R2 | A/B 改动后真实浏览器审查 | 设计/审查代理 | TODO | A7/B5 | 前后对比截图 + 步骤回归 | 不改代码 |
| R3 | C 安全评审（设计层） | 审查代理 + 父代理 | TODO | C1–C6 | 威胁模型/失败关闭清单 | 不批准真实资金 |
| R4 | 最终验收（对照 FLOWS 矩阵） | 父代理 | TODO | 全部 | 逐项 VERIFIED/REPRODUCED/UNKNOWN | 不合并 PR |

## 3. 审查代理环境交接（只读）

### 3.1 路径

| 用途 | 路径 | 说明 |
| --- | --- | --- |
| 纯 main 只读 | `/tmp/oma-phase10-main-8ce5c57` | detached @ `8ce5c57`；应用代码与 main 一致；不需要 node_modules 即可运行插件 |
| 开发分支 | `/Users/laysath/Projects/magpie-oh-my-aihub-import` | 当前含 `docs/phase10/*`；A/B/C 实现开始后不要把它当纯 main |
| 0.1.2038 app（可选） | `~/Projects/lab/magpie-iso/Magpie.app`、`~/Projects/lab/magpie-pricing-2038/Magpie.app` | 已测量 pin 的旧版本；launcher/options 行为与 0.1.2171/0.1.2289 有差异 |
| 本机安装 app | `/Applications/Magpie.app` | **0.1.2289**；只可用复制出的便携副本，不碰用户数据 |

### 3.2 启动方案（B，推荐）

目标：真实 Magpie + 真实 console + 隔离 `data/`，不读写 `~/Library/Application Support/Magpie`，不改应用代码。

1. 在 `/tmp/<review-root>/` 复制 `Magpie.app`，同级创建 `.portable`（空文件，0600）、`data/`、`home/`。
2. 用最小环境启动（示例占位，不打印真实值）：
   ```sh
   HOME=/tmp/<review-root>/home \
   XDG_CONFIG_HOME=/tmp/<review-root>/home/.config \
   XDG_CACHE_HOME=/tmp/<review-root>/home/.cache \
   MAGPIE_ADDR=127.0.0.1:<free-gateway> \
   MAGPIE_WEB_KEY=<random-24-byte-hex> \
   OH_MY_AIHUB_MAGPIE=/tmp/<review-root>/Magpie.app/Contents/MacOS/magpie \
   /tmp/<review-root>/Magpie.app/Contents/MacOS/magpie web --addr 127.0.0.1:<free-web> --no-open
   ```
3. 只把登录 URL（`http://127.0.0.1:<web>/?k=…`）放进本地工具/ego-browser，不写进报告。
4. Plugins → Discover → 安装 `/tmp/oma-phase10-main-8ce5c57`（本地路径仅 UI 审查）或合并后的 `github:faithleysath/magpie-oh-my-aihub`。
5. 插件页 → 打开控制台（或配对）→ 审查 7 页、弹窗、空/错态、深/浅/窄屏。
6. 结束：停止该便携实例，删除 `/tmp/<review-root>`；不触碰用户 Magpie。

**已知限制**：0.1.2289 的 launcher/options 与 Phase 9 的 0.1.2171 不完全相同；本方案只用于 **UI 审查**，不能作为安装/计费/主网验收。若用 0.1.2038，同样只用于 UI。

### 3.3 备选

- **A（假 state fixture）**：`startConsoleServer` + 真实 `plugin/console` 资源 + 静态 `ohmyaihub/console/1` state。适合快速看视觉，但没有真实 Service/文件；不得用于安全/计费判断。
- **C（我来准备隔离 fixture）**：若 B 在 0.1.2289 上启动失败，父代理可指派本代理在 `/tmp` 写启动脚本（不提交、不改应用代码），再交给审查代理。

## 4. 证据与状态记录

| 日期 | 事项 | 结论 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| 2026-10-31 | PR13 合并/CI | MERGED @ `8ce5c57`；run `41056993038` success | `gh pr view 13`；`gh run list` | VERIFIED |
| 2026-10-31 | 安装版本 vs pin | 本机 0.1.2289；pin 0.1.2038；Phase 9 0.1.2171；相差 165 commits | `PlistBuddy`；`gh api compare` | VERIFIED |
| 2026-10-31 | 峰谷价缺口 | `peak` 进入 Magpie 计价，插件 `pricing.ts` 未处理 | `internal/catalog/peak.go`、`internal/usage/usage.go`、`plugin/src/pricing.ts` | VERIFIED（源码）/ UNKNOWN（运行时） |
| 2026-10-31 | 本地测试 | 740 pass / 5 fail；固定时钟 time-bomb | `bun run test` 输出 | REPRODUCED |
| 2026-10-31 | 初始 VALIDATION 前置 | A/B 可开始；C 不可；0.1.2289 未测 | INVENTORY §14 | VERIFIED |
| 2026-10-31 | 盘点文档提交 | 3 文件，959 行 | `git show --stat HEAD -- docs/phase10` | VERIFIED |
| 待补 | D2 最小重测 | — | — | TODO |
| 待补 | R1 审查截图/问题清单 | — | — | TODO |

## 5. 调度规则（本阶段）

1. 每次只推进一个可验收单元；实现与验证分离。
2. 任何涉及真实链/真实 Magpie 的运行，必须有隔离目录、版本/平台记录、脱敏输出；否则只能标 UNKNOWN。
3. 审查代理只读应用代码；需要启动时只用 `/tmp` 便携副本与 `/tmp` 脚本。
4. 不合并 PR；每个实现任务一个分支/PR（或按父代理指示的单一 Phase 10 分支）。
5. 不把“设计稿/截图/UI 审查”写成“功能验收”；不把“本地模拟”写成“公链付款”。
6. NO-GO 项（真实资金、主网自动授信、自动充值、热钱包、管理界面暴露）不得以“实验”为名绕过。
