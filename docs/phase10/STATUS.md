# Phase 10 — 任务矩阵与调度状态（STATUS）

> 持续调度记录，不是验收报告。每次变化更新并在 §4 追加证据行。
> 状态：`TODO` / `DOING` / `BLOCKED` / `REVIEW` / `DONE` / `NO-GO`。
> **字母严格按用户定义**：A=视觉/交互/三字段/端口/状态邻居；B=无文件 P2P/人工审批/端到端加密授权；C=钱包与主网准备；D=真实资金独立审查。
> 版本复测、测试时钟、峰谷价 fail-closed 是 **P0 基础单元**，不叫 D。
> 签名文件/邀请卡只允许作为 B 的紧急兼容回退，不能代替 B。
> “不合并 PR”是调度约束，不是用户对产品的明文要求。

## 0. 当前快照

| 项 | 值 |
| --- | --- |
| 快照时间 | 2026-10-31 |
| 基线 main | `8ce5c57f565fb1b835021a9b730b61014eb47d5f` |
| PR13 | `#13`，MERGED，merge SHA = 上述 main；CI run `41056993038` success |
| 开发/文档分支 | `feature/phase10-simplified-p2p-ux`（已推送；仅 docs 变更；draft PR #14） |
| 盘点工作树 | `/Users/laysath/Projects/magpie-oh-my-aihub-import` |
| 纯 main 只读工作树 | `/tmp/oma-phase10-main-8ce5c57`（detached @ `8ce5c57`） |
| 目标运行版本（已决定） | **Magpie 0.1.2289 + EasyTier 2.6.4**；隔离副本，不改用户安装 |
| 本机安装 | `/Applications/Magpie.app` 0.1.2289（只做只读来源/复制） |
| 计费/峰谷价 | 0.1.2289 的 `peak` 先 **fail-closed 拒绝**；后续单独实现，不再让用户选 |
| 本地门禁 | typecheck / boot-check / secret-scan 通过；`bun run test` 740 pass / 5 fail（固定时钟，P0-3） |
| 参考研究 | 审查代理 `6a326f2b-2249-4123-8f35-1fe35926e107`：`/tmp/oma-research/REFERENCE-REVIEW.md` |
| 真实资金 | NO-GO；D 本阶段只出 NO-GO 清单，不执行真实资金 |
| 主网发送/授信 | **硬禁止**（C 不实现） |

## 1. 代理与职责

| 角色 | 代理/标识 | 职责 | 禁止 |
| --- | --- | --- | --- |
| 主调度 | 父代理 | 分派、验收、合并决策 | 不把未证结论写成 DONE |
| 文档/集成 | 本代理（INTEGRATION） | 入口/流程/矩阵/文档；**只有本代理改主开发分支 `docs/phase10`** | 不主写应用代码；不建子代理 |
| 设计/Console 审查 | `6a326f2b-2249-4123-8f35-1fe35926e107` | 参考研究、A/B 真实浏览器审查 | 不改应用代码 |
| A-ui | 待分派（独立 worktree） | 5 页 IA、首页 5 块、贴纸风、只读端口/邻居 | 不改 B/C 代码；不自动分享/信任 |
| A-service | 待分派（独立 worktree） | 三字段配置、自动检测模型、一次“分享这些模型”、状态投影 | 不改 UI 视觉；不自动分享 |
| B-core | 待分派（独立 worktree） | 所有节点控制服务、请求/审批/E2E/注册/ACK 状态机 | 文件不能代替目标；不自动批准 |
| C-registry | 待分派（独立 worktree） | 56/8453 只读平权、四元组资产、钱包/扩展/自动充值策略 | 主网发送/授信；真实资金 |
| D 审查 | 独立审查代理（待分派） | 真实资金 NO-GO 清单 | 不改代码；不兼任 C 实现；不执行真实资金 |
| P0 | 待分派（可与 A/B 并行） | 0.1.2289 隔离、peak fail-closed、时钟、最小重测 | 不改用户安装 |

> 本代理是子代理：**不创建任何子代理**。

## 2. 工作流与 worktree（主调度分配）

| 工作流 | 独立 worktree（待主审填） | 负责代理 | 分支/PR（待记录） | 状态 | 集成条件 |
| --- | --- | --- | --- | --- | --- |
| A-ui | `TBD` | TBD | `TBD` | TODO | 主审明确 commit + R2 审查 |
| A-service | `TBD` | TBD | `TBD` | TODO | 主审明确 commit + P0 |
| B-core | `TBD` | TBD | `TBD` | TODO | 主审明确 commit + 安全评审 |
| C-registry | `TBD` | TBD | `TBD` | TODO | 主审明确 commit + D 前置 |
| P0 | `TBD` | TBD | `TBD` | TODO | 证据齐全 |

**集成规则**

1. 只有 INTEGRATION 在本仓库 `feature/phase10-simplified-p2p-ux` 上改 `docs/phase10`。
2. 实现代理在各自独立 worktree/分支；**不主动 cherry-pick 尚未审查的实现**。
3. 只按主审明确给出的 commit 做集成；每次集成更新本表（代理、branch、PR、commit、证据）。
4. 文档分支的 draft PR 只含 docs；实现 PR 另开，不合并且不混入。

## 3. 任务矩阵

### P0 — 基础单元（所有实现前/并行）

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| P0-1 | 0.1.2289 + EasyTier 2.6.4 隔离副本 | P0 | TODO | — | 版本/哈希/平台；隔离 data dir；不改 `/Applications` | 已决定，不再选版本 |
| P0-2 | `peak` fail-closed | P0 + C | TODO | P0-1 | 含不支持价格 → 拒绝发布/签发；负向测试 | 后续再实现峰谷价 |
| P0-3 | 测试时钟 | P0 | TODO | — | `bun run test` 全绿；可注入时钟 | 不改产品语义 |
| P0-4 | 最小重测 401/429/limit/top-up/restart | P0 | TODO | P0-1 | 脱敏日志 + 命令 | 0.1.2289 实际结果 |
| P0-5 | 证据/CI/pin | P0 | TODO | P0-2..4 | 双平台 CI + 文档 | 不合并是调度约束 |

### A — 视觉/交互/三字段/端口/状态邻居

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 5 页 IA：首页/发现/我的共享/钱包/网络 | A-ui | TODO | P0 | 截图矩阵；旧连接/账单/设置页不再独立 | 不保留 7 页 |
| A2 | 首次仅三字段：网络名称/密钥/初始节点 | A-service | TODO | A1 | UI + state；角色/端口自动 | 不让用户选角色/端口 |
| A3 | 首页只显示 5 块 | A-ui | TODO | A2 | 首页截图 | 网络状态/可用模型/我的共享/钱包/待办；无端口/引擎内部检查 |
| A4 | 端口只读诊断 | A-ui + A-service | TODO | A2 | 网络页截图 | 仅诊断可见、不可编辑；首页不显示 |
| A5 | 邻居状态 | A-service | TODO | A2 | 真实 EasyTier | 邻居摘要/详情；非身份、非授权 |
| A6 | 自动检测 + 一次“分享这些模型” | A-service | TODO | A2 | 两节点 UI + 目录 | 无“共享开关+目录发布”常规动作 |
| A7 | 默认发现+消费 | A-service | TODO | A2 | 两节点 UI | 不分享也能发现/消费；分享才发布 |
| A8 | 贴纸风视觉/深浅/窄屏/可访问性 | A-ui | TODO | A1 | 截图 + 对比度/焦点/ARIA | 无外部资源/CSP 不变 |
| A9 | 回归 | A-ui + A-service + 审查 | TODO | A1..A8 | console/security 测试 | 不放宽动作/幂等/敏感响应 |

### B — 无文件 P2P / 人工审批 / 端到端加密授权

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 所有节点独立有限控制服务 | B-core | TODO | P0 | 端口/ACL/监听证据；不分享节点也可接收 | 不新增中心服务；不是 Magpie 管理面/AI 网关 |
| B2 | `connection_request` 结构化消息 | B-core | TODO | B1 | schema/限长/字段白名单；无 Key/无文件 | 不落文件 |
| B3 | 提供方人工批准 | B-core | TODO | B2 | 选模型+正额度+明确勾选；审计 | 不自动批准 |
| B4 | E2E 加密授权 | B-core | TODO | B3 | 密文/解密/错身份负向 | 提供方不持久化明文 |
| B5 | 注册状态机（不依赖 ACK） | B-core | TODO | B4 | 注册成功+模型/额度回读 → registered | 不以 ACK 为前置门 |
| B6 | ACK 丢失有限幂等恢复 | B-core | TODO | B5 | 同 id 重发/查询；不重造 Key/不重复计费 | 不“一律不重试” |
| B7 | 原生 Remote Magpie 注册 + 回读 | B-core | TODO | B5 | 模型/额度回读；只注册本插件连接 | 不注册外部连接 |
| B8 | 首次/变化 TOFU 人工 | B-core | TODO | B2 | 未接受/身份变化禁止 | 不跳过 |
| B9 | 重放/篡改/过期 | B-core | TODO | B1..B7 | 负向测试 | 不自动文件回退 |
| B10 | 紧急文件兼容 | B-core + 审查 | TODO | B9 | 显式选择/警告；默认关 | 不作为目标/验收替代 |

### C — 钱包与主网准备

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 56/8453 只读网络平权 | C-registry | TODO | P0 | 注册表/UI；无 primary；不扫描/入账/发送 | 主网发送/授信 |
| C2 | 收款网络默认空选 | C-registry | TODO | C1 | 默认无链/资产；必须明确选 | 不自动选链 |
| C3 | 严格资产四元组 | C-registry | TODO | C1 | `chainId+tokenContract+decimals+issuerType`；拒绝符号推断 | 任意代币 |
| C4 | 内置钱包：隔离模拟创建/恢复/锁定 | C-registry | TODO | P0 | 隔离记录；明确非生产级 | 真实资产/生产级声明 |
| C5 | 敏感导出/助记词 | C-registry | TODO | C4 | 警告 + **重新验证钱包密码**；不落日志/快照 | 明文泄漏/绕过密码 |
| C6 | 外置钱包/多扩展明确选择 | C-registry | TODO | P0 | 多扩展夹具；用户明确选一个 | 自动挑/自动切链 |
| C7 | P2P 付款/签名 | C-registry | TODO | C2,C3 | 测试网/模拟；直接签名；普通钱包无签名文件 | 主网广播/签名文件路径 |
| C8 | 自动充值策略（上限/暂停/条件） | C-registry | TODO | C4..C7 | 策略 + 负向测试；可模拟/测试执行 | 主网执行 |
| C9 | 主网硬禁止 | C-registry | TODO | C1..C8 | 负向测试：send/credit/cap 全拒绝 | 任何例外 |
| C10 | 真实资金 | — | NO-GO | — | — | 禁止 |

### D — 真实资金独立审查

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 独立审查计划 | D | TODO | C9 | 审查范围/威胁模型 | 兼任实现 |
| D2 | 密钥/导出/扩展/归属/策略/主网只读审查 | D | TODO | D1 | 报告 PASS/FAIL/UNKNOWN + 复现 | 改代码 |
| D3 | 本阶段产出 NO-GO 清单 | D | TODO | D2 | NO-GO 清单 + 阻塞项 | **不执行真实资金；不产出 GO 放行** |

### 审查/交付

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 改动前当前 Console 真浏览器审查 | 审查代理 | TODO | 本文 §4 | 截图/问题清单；不改代码 | 0.1.2289 只做 UI 审查 |
| R2 | A/B 改动后真浏览器审查 | 审查代理 | TODO | A9/B10 | 前后对比 + 步骤回归 | 不改代码 |
| R3 | C 钱包/主网准备安全评审 | 审查代理 | TODO | C9 | 设计/威胁模型评审 | 不等于 D |
| R4 | 最终验收对照 FLOWS | 父代理 | TODO | 全部 | 逐项证据 | 不合并是调度约束 |
| R5 | 文档 draft PR（仅 docs） | INTEGRATION | DONE | — | https://github.com/faithleysath/magpie-oh-my-aihub/pull/14 | 不合并；不含实现/验收 |

## 4. 审查代理环境交接（只读）

| 用途 | 路径 | 说明 |
| --- | --- | --- |
| 纯 main 只读 | `/tmp/oma-phase10-main-8ce5c57` | detached @ `8ce5c57`；应用代码 = main |
| 开发/文档分支 | `/Users/laysath/Projects/magpie-oh-my-aihub-import` | 含 `docs/phase10/*`；实现开始后勿当纯 main |
| 目标 app 来源 | `/Applications/Magpie.app`（0.1.2289） | **复制**到 `/tmp` 便携副本；不改用户安装 |
| 0.1.2038 历史副本（可选） | `~/Projects/lab/magpie-iso/Magpie.app`、`~/Projects/lab/magpie-pricing-2038/Magpie.app` | 只作历史对照，不作为本轮目标 |

**启动方案（A/B UI 审查，推荐）**：复制 app → 同级 `.portable` + `data/` + 独立 `HOME` → 设 `MAGPIE_ADDR`/`MAGPIE_WEB_KEY`/`OH_MY_AIHUB_MAGPIE` → `.../magpie web --addr 127.0.0.1:<free> --no-open` → 安装 `/tmp/oma-phase10-main-8ce5c57`（本地路径仅 UI 审查）→ 插件页打开/配对控制台。不碰 `~/Library/Application Support/Magpie`；0.1.2289 的 UI 审查不得写成验收。

## 5. 证据记录

| 日期 | 事项 | 结论 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| 2026-10-31 | PR13 合并/CI | MERGED @ `8ce5c57`；CI success | `gh pr view 13`；`gh run list` | VERIFIED |
| 2026-10-31 | 版本决定 | 目标 0.1.2289 + EasyTier 2.6.4；隔离副本 | 用户/主审决定；`PlistBuddy` | VERIFIED |
| 2026-10-31 | 峰谷价缺口 | `peak` 进入原生计价；插件未处理 → P0-2 fail-closed | `internal/catalog/peak.go`、`internal/usage/usage.go`、`plugin/src/pricing.ts` | VERIFIED（源码）/ UNKNOWN（运行时） |
| 2026-10-31 | 本地测试 | 740 pass / 5 fail；固定时钟 | `bun run test` | REPRODUCED |
| 2026-10-31 | 初始 VALIDATION 前置 | A/B 可开始；C 不接真实资金 | INVENTORY §14 | VERIFIED |
| 2026-10-31 | 文档 draft PR | #14，draft，仅 3 个 docs 文件 | `gh pr view 14` | VERIFIED |
| 待补 | P0-1..5 | — | — | TODO |
| 待补 | R1 截图/问题清单 | — | — | TODO |

## 6. 调度规则

1. 实现与验证分离；D 不得由 C 实现者兼任。
2. 真实链/真实 Magpie 运行必须有隔离目录、版本/平台记录、脱敏输出；否则 UNKNOWN。
3. 审查代理只读应用代码；启动只用 `/tmp` 便携副本与 `/tmp` 脚本。
4. 只有 INTEGRATION 改主开发分支 `docs/phase10`；实现代理用独立 worktree/分支。
5. 只按主审明确 commit 集成；**不主动 cherry-pick 未审查实现**。
6. 每个实现任务一个分支/PR；不合并是调度约束（不是用户产品要求）。
7. 当前禁止项仅：真实资金、主网发送/授信。**不要**把它扩大成“所有隔离模拟钱包能力都不开发”。
8. 不把设计稿/UI 审查写成功能验收；不把本地模拟写成公链付款；不把 0.1.2038/0.1.2171 结论写成 0.1.2289 结论。
