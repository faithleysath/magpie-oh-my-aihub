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
| PR14 | `#14` draft；主审文档范围审查通过，作为实现前置；**内容仅计划，无 GO**；不合并 |
| 改动前 UI 证据 | `docs/phase10/evidence/`：3 份事实报告 + 16 张实拍 + SHA256SUMS；0.1.2289 真实宿主**空网络**；可标 REPRODUCED/已审查，**不能标 Visual UX GO** |
| 实现代理模型 | `pi/magpie/group/deepseek-v4.1-flash`（max） |
| 真实资金 | NO-GO；D 本阶段只出 NO-GO 清单，不执行真实资金 |
| 主网发送/授信 | **硬禁止**（C 不实现） |

## 1. 代理与职责

| 角色 | 代理/标识 | 职责 | 禁止 |
| --- | --- | --- | --- |
| 主调度 | 父代理 | 分派、验收、合并决策 | 不把未证结论写成 DONE |
| 文档/集成 | 本代理（INTEGRATION） | 入口/流程/矩阵/文档；**只有本代理改主开发分支 `docs/phase10`** | 不主写应用代码；不建子代理 |
| 设计/Console 审查 | `6a326f2b-2249-4123-8f35-1fe35926e107` | 参考研究、A/B 真实浏览器审查 | 不改应用代码 |
| A-ui | `ccb08749-badc-4512-9604-e93ce7bd76b9` | 5 页 IA、首页 5 块、贴纸风、只读端口/邻居 | 不改 B/C 代码；不自动分享/信任 |
| A-service | `c51de818-13dd-4df6-ba68-2e48155eeb63` | 三字段配置、自动检测模型、一次“分享这些模型”、状态投影 | 不改 UI 视觉；不自动分享 |
| B-core | `0185d02c-b0c4-49a9-b9bb-7242c31d6a04` | 所有节点控制服务、请求/审批/E2E/注册/ACK 状态机 | 文件不能代替目标；不自动批准 |
| B-service | `8dd0cf10-548b-45fb-88c0-9b8a7cb5abe3` | 有限 HTTP transport、业务集成接口；依赖 B-core/A-service 批准后的 stacked base | 不重复密码模块；不另起协议 |
| C-registry | `0c94d106-6442-470f-8f14-374c38ea20f7` | 56/8453 只读平权、四元组资产、注册表 | 主网发送/授信；真实资金 |
| C-wallet | `01060df1-e5e8-4de8-b6cb-70ca932c7b1e` | 隔离测试创建/恢复/加密存储/短解锁/敏感导出/EIP712 模拟签名 | 尚未 UI 集成；不接生产资金；不声称生产级安全 |
| C-external | `3820537e-5840-4926-ba00-5975805b2df6` | EIP-1193/6963 发现、明确选钱包、受限签名、模拟 testnet 付款 | 尚未 UI 集成；不得用 fake provider 声称真实扩展兼容 |
| D 审查 | 独立审查代理（待分派） | 真实资金 NO-GO 清单 | 不改代码；不兼任 C 实现；不执行真实资金 |
| P0-clock | `f63b644e-40df-4174-afd4-c4f43da87927` | 测试时钟、`bun run test` 全绿 | 不改用户安装 |
| P0-peak | `187ccdcb-8f0b-40f3-8276-939334de4412` | `peak` fail-closed | 不实现峰谷价 |

> 本代理是子代理：**不创建任何子代理**。

## 2. 工作流与 worktree（主调度分配）

| 工作流 | 独立 worktree | 负责代理 | 分支 / PR | 状态 | 集成条件 |
| --- | --- | --- | --- | --- | --- |
| A-ui | `/Users/laysath/.paseo/worktrees/1z728cdk/a-ui` | `ccb08749-badc-4512-9604-e93ce7bd76b9` | PR #25 head `cbce7004` | REVIEW | fixture 截图非真实 Magpie；66 前端测试/0；CI 5 既有 clock 失败；视觉审 `6a326f2b…` 进行中；主审阻断项待 fix；**不能 Visual GO** |
| A-service | `/Users/laysath/.paseo/worktrees/1z728cdk/a-service` | `c51de818-13dd-4df6-ba68-2e48155eeb63` | PR #22 head `77d71b2`（完整 SHA 待 handoff） | BLOCKED | 主审发现 reported+bind 占用不能证明 PID ownership、RPC 先用后验；review `84ba711e…` + 实现者修；未集成 |
| B-core | `/Users/laysath/.paseo/worktrees/1z728cdk/b-core` | `0185d02c-b0c4-49a9-b9bb-7242c31d6a04` | PR #26 head `fdc7d4c4` base `8ce5c57`（draft） | REVIEW | 47 模块测试；**REVIEW 不叫 reviewed**；handoff `/tmp/oma-research/B-CORE-REVIEW-HANDOFF.md`；预审项待冻结 SHA 核验 |
| B-service | `/Users/laysath/.paseo/worktrees/1z728cdk/b-service` | `8dd0cf10-548b-45fb-88c0-9b8a7cb5abe3` | PR #19 head `0988c85a` / PR #20 head `277ed665` | BLOCKED | 独立审 `5d386756` 判不可集成（超时放槽/后台继续、旧接口/内存 generation/旧授权覆盖）；19fix 在做 |
| C-registry | `/Users/laysath/.paseo/worktrees/1z728cdk/c-registry` | `0c94d106-6442-470f-8f14-374c38ea20f7` | PR #21 head `5ef4430`（完整 SHA 待 handoff） | REVIEW | 真实只读主网余额 REPRODUCED；主网资金仍 NO-GO；未集成 |
| C-wallet | `/Users/laysath/.paseo/worktrees/1z728cdk/c-wallet` | `01060df1-e5e8-4de8-b6cb-70ca932c7b1e` | `feature/phase10-c-wallet-vault` / draft PR 待记录 | DOING | 主审明确 commit + 安全评审 |
| C-external | `/Users/laysath/.paseo/worktrees/1z728cdk/c-external-wallet` | `3820537e-5840-4926-ba00-5975805b2df6` | `feature/phase10-c-external-wallet` / draft PR 待记录 | DOING | 主审明确 commit + 安全评审；真实扩展验收 BLOCKED/UNKNOWN |
| P0-clock | `/Users/laysath/Projects/magpie-oh-my-aihub-clock-fix` | `f63b644e-40df-4174-afd4-c4f43da87927` | `fix/phase10-validation-clock` @ `889973f5` / PR #15 (draft) | REVIEW | 独立审代理 `27dcd09b-8ab1-4989-aecd-aa5d70e530ac`；未集成 |
| P0-peak | `/Users/laysath/Projects/magpie-oh-my-aihub-p0` | `187ccdcb-8f0b-40f3-8276-939334de4412` | `fix/phase10-unsupported-pricing-guard` @ `0661bede` / PR #16 (draft) | REVIEW | 独立审 `27dcd09b…` 排队 15→17→16→18；未集成 |
| P0-hermetic | 独立 worktree（待补） | P0 测试代理（待补） | PR #17 head `3ce22ee7` base `889973f` | REVIEW | CI `41158230737` 双平台绿；未集成 |
| P0-pin | 独立 worktree（待补） | P0 测试代理（待补） | PR #18 head `3826fad1` base `889973f` | REVIEW | 明确 **LAN-direct ET not started**；仅原生 LAN 实测；未集成 |
| P0-overlay | 独立 worktree（待补） | P0 测试代理（待补） | PR #27 head `af3098d` base `test/phase10-harness-pin`（#18） | REVIEW | docs-only 无 CI；同机两节点回环 TCP noTUN overlay 401/401/200/429/topup/Remote/revoke/restart/ACL 拒管理端口 **REPRODUCED（开发方报告）**；独立审 `27dcd09b…` 待核 |

> B-core 与 B-service 共同维护合同 `/tmp/oma-research/B-CONTROL-CONTRACT.md`；B-service 只做有限 HTTP transport 与业务集成接口，不重复密码模块。
>
> C-wallet 只做隔离测试核心（创建/恢复/加密存储/短解锁/敏感导出/EIP712 模拟签名）；**尚未 UI 集成，也不代表生产资金认可**。

**集成规则**

1. 只有 INTEGRATION 在本仓库 `feature/phase10-simplified-p2p-ux` 上改 `docs/phase10`。
2. 实现代理在各自独立 worktree/分支；**不主动 cherry-pick 尚未审查的实现**。
3. 只按主审明确给出的 commit 做集成；每次集成更新本表（代理、branch、PR、commit、证据）。
4. 文档分支的 draft PR 只含 docs；实现 PR 另开，不合并且不混入。
5. 本轮只登记分派与 worktree；**不集成任何待审实现 commit**。

## 3. 任务矩阵

### P0 — 基础单元（所有实现前/并行）

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| P0-1 | 0.1.2289 + EasyTier 2.6.4 隔离副本 | P0 | TODO | — | 版本/哈希/平台；隔离 data dir；不改 `/Applications` | 已决定，不再选版本 |
| P0-2 | `peak` fail-closed | P0-peak `187ccdcb…` + C | REVIEW | P0-1 | 目标 48 pass/0 fail + typecheck/secret/boot stub PASS；CI `41157220963` linux/mac **753 pass/1 skip/5 fail（既有 clock）**；报告 `/tmp/oma-research/P0-PRICING-GUARD-REPORT.md` | **REVIEW**；不可写 CI 全绿，不可 DONE；未集成 |
| P0-3 | 测试时钟 | P0-clock `f63b644e…` | REVIEW | — | 本地 746/0；CI `41156933911` linux/macos success；PR #15 draft | 独立审另派；**REVIEW 不是 DONE**；未集成 |
| P0-6 | hermetic tests（隔离旧测试对生产网关/公共 RPC 的访问） | P0 测试代理 | REVIEW | P0-3 | PR #17 head `3ce22ee7` base `889973f`；CI `41158230737` 双平台绿 | 未集成 |
| P0-7 | 精确 pin 支持 0.1.2289 实际实验 | P0 测试代理 | REVIEW | P0-1 | PR #18 head `3826fad1` base `889973f`；明确 LAN-direct ET not started | 未集成；不能 P0-overlay DONE |
| P0-8 | 真实 no-TUN EasyTier overlay/forward | P0 测试代理 | REVIEW | P0-7 | PR #27 docs-only；同机两节点回环 TCP noTUN overlay 401/401/200/429/topup/Remote/revoke/restart/ACL 拒管理端口 REPRODUCED（开发方报告） | **不是跨主机 NAT/relay/WAN；不是浏览器无文件 GO**；独立审待核；不能总 P0 DONE |
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
| A10 | A-ui 主审阻断修复 | A-ui | REVIEW | A9 | PR #25 head `cbce7004`；66 前端测试/0；CI 5 既有 clock 失败 | 404 自动多步回旧 share/configure 可能部分成功；可用模型混本机可分享；累计 chain 入账误称资产余额；钱包首屏技术状态过密 |

### B — 无文件 P2P / 人工审批 / 端到端加密授权

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 所有节点独立有限控制服务 | B-core | REVIEW | P0 | PR #26 head `fdc7d4c4`，47 模块测试；handoff 已交 | 未集成；需冻结 SHA 核验 |
| B2 | `connection_request` 结构化消息 | B-core | TODO | B1 | schema/限长/字段白名单；无 Key/无文件 | 不落文件 |
| B3 | 提供方人工批准 | B-core | TODO | B2 | 选模型+正额度+明确勾选；审计 | 不自动批准 |
| B4 | E2E 加密授权 | B-core | TODO | B3 | 密文/解密/错身份负向 | 提供方不持久化明文 |
| B5 | 注册状态机（不依赖 ACK） | B-core | TODO | B4 | 注册成功+模型/额度回读 → registered | 不以 ACK 为前置门 |
| B6 | ACK 丢失有限幂等恢复 | B-core | TODO | B5 | 同 id 重发/查询；不重造 Key/不重复计费 | 不“一律不重试” |
| B7 | 原生 Remote Magpie 注册 + 回读 | B-core | TODO | B5 | 模型/额度回读；只注册本插件连接 | 不注册外部连接 |
| B8 | 首次/变化 TOFU 人工 | B-core | TODO | B2 | 未接受/身份变化禁止 | 不跳过 |
| B9 | 重放/篡改/过期 | B-core | TODO | B1..B7 | 负向测试 | 不自动文件回退 |
| B10 | 紧急文件兼容 | B-core + 审查 | TODO | B9 | 显式选择/警告；默认关 | 不作为目标/验收替代 |
| B11 | 有限 HTTP transport + 业务集成接口 | B-service | BLOCKED | B1,B3 + A-service stacked base | PR #19/#20；独立审 `5d386756` 判不可集成；19fix 在做 | 超时放槽/后台继续、旧接口/内存 generation/旧授权覆盖；无真实双节点 GO |

### C — 钱包与主网准备

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 56/8453 只读网络平权 | C-registry | REVIEW | P0 | PR #21 head `5ef4430`；真实只读主网余额 REPRODUCED | 主网资金 NO-GO；未集成 |
| C2 | 收款网络默认空选 | C-registry | TODO | C1 | 默认无链/资产；必须明确选 | 不自动选链 |
| C3 | 严格资产四元组 | C-registry | TODO | C1 | `chainId+tokenContract+decimals+issuerType`；拒绝符号推断 | 任意代币 |
| C4 | 内置钱包：隔离模拟创建/恢复/加密存储/短解锁 | C-wallet | DOING | P0 | 隔离测试记录；明确非生产级 | 真实资产/生产级声明/UI 集成 |
| C5 | 敏感导出/助记词 | C-wallet | DOING | C4 | 警告 + **重新验证钱包密码**；不落日志/快照 | 明文泄漏/绕过密码 |
| C6 | 外置钱包/多扩展明确选择 | C-external | DOING | P0 | EIP-1193/6963 夹具；用户明确选一个 | 自动挑/自动切链 |
| C7 | P2P 付款/签名 | C-wallet + C-external | DOING | C2,C3 | 测试网/模拟；直接签名；普通钱包无签名文件 | 主网广播/签名文件路径 |
| C8 | 自动充值策略（上限/暂停/条件） | C-wallet | TODO | C4..C7 | 策略 + 负向测试；可模拟/测试执行 | 主网执行 |
| C9 | 主网硬禁止 | C-registry + C-wallet + C-external | TODO | C1..C8 | 负向测试：send/credit/cap 全拒绝 | 任何例外 |
| C11 | 真实 MetaMask/Rabby 扩展验收 | C-external | BLOCKED | 隔离 profile 工具 | 计划见 `docs/phase10/evidence/2026-10-31-external-wallet-test-plan.md`；**BLOCKED/UNKNOWN** | 不得用 fake provider 单测声称兼容；不碰默认 profile |
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
| R1 | 改动前当前 Console 真浏览器审查 | 审查代理 | DONE（仅事实） | 本文 §4 | 证据已入库 `docs/phase10/evidence/`；REPRODUCED；0.1.2289 空网络 | **不是 Visual UX GO/产品验收**；产品方案不抄入 FLOWS |
| R2 | A/B 改动后真浏览器审查 | 审查代理 | TODO | A9/B10 + R1 | 前后对比 + 步骤回归 | 不改代码；仍非 Visual UX GO |
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

**启动方案（A/B UI 审查，推荐）**：复制 app → 同级 `.portable` + `data/` + 独立 `HOME` → 设 `MAGPIE_ADDR`/`MAGPIE_WEB_KEY`/`OH_MY_AIHUB_MAGPIE` → `.../magpie web --addr 127.0.0.1:<free> --no-open` → 安装 `$MAIN_WORKTREE`（本地路径仅 UI 审查）→ 插件页打开/配对控制台。不碰 `~/Library/Application Support/Magpie`；0.1.2289 的 UI 审查不得写成验收。

## 4.1 改动前 UI 审查证据入库（已完成）

- 客观事实报告 + 精选实拍已入库 `docs/phase10/evidence/`：`README.md`、`2026-10-31-current-console-before.md`、`2026-10-31-reference-review.md`、`screenshots/`（16 张）+ `SHA256SUMS`；外置钱包测试计划作为附录 `2026-10-31-external-wallet-test-plan.md`（BLOCKED/UNKNOWN，不是验收）。
- **未收录**：HOME 副本、app 包、`data/`、Gateway Key、网络密钥、会话/配对票据、RPC 凭据、个人路径/用户名。
- 覆盖：首页、我的共享、钱包、网络/安全状态、错误/退出/匿名壳，以及浅色/深色/390 窄屏；完整 30 张未入库。
- 审查报告已删自拟产品方案；INVENTORY/FLOWS 只采纳可核对事实，不抄产品方案。
- 来源边界：0.1.2289 真实宿主、**空网络**；无真实伙伴/P2P 授权/钱包交易。可标 REPRODUCED/已审查，**不能标 Visual UX GO**。
- 已与 P0-clock/P0-peak/B-service 等待审记录一起批量提交 PR14。

## 5. 证据记录

| 日期 | 事项 | 结论 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| 2026-10-31 | PR13 合并/CI | MERGED @ `8ce5c57`；CI success | `gh pr view 13`；`gh run list` | VERIFIED |
| 2026-10-31 | 版本决定 | 目标 0.1.2289 + EasyTier 2.6.4；隔离副本 | 用户/主审决定；`PlistBuddy` | VERIFIED |
| 2026-10-31 | 峰谷价缺口 | `peak` 进入原生计价；插件未处理 → P0-2 fail-closed | `internal/catalog/peak.go`、`internal/usage/usage.go`、`plugin/src/pricing.ts` | VERIFIED（源码）/ UNKNOWN（运行时） |
| 2026-10-31 | 本地测试 | 740 pass / 5 fail；固定时钟 | `bun run test` | REPRODUCED |
| 2026-10-31 | 初始 VALIDATION 前置 | A/B 可开始；C 不接真实资金 | INVENTORY §14 | VERIFIED |
| 2026-10-31 | 文档 draft PR | #14，draft，仅 3 个 docs 文件；主审文档范围审查通过，作为实现前置；**计划无 GO** | `gh pr view 14` | VERIFIED |
| 2026-10-31 | 实现分派登记 | A-ui/A-service/B-core/C-registry/C-wallet + P0-clock/P0-peak 独立 worktree | 本节 §2 | VERIFIED（登记）|
| 2026-10-31 | P0-clock 交付待审 | PR #15 draft；commit `889973f5`；CI `41156933911` success；本地 746/0；**REVIEW，未集成** | PR #15 / CI | 待独立审 |
| 2026-10-31 | P0-peak 交付待审 | PR #16 draft；commit `0661bede`；CI `41157220963` linux/mac 753 pass/1 skip/5 fail（既有 clock）；本地目标 48/0；**REVIEW，未集成** | PR #16 / CI / 报告 | 待独立审 15→17→16→18 |
| 2026-10-31 | P0-hermetic 交付待审 | PR #17 head `3ce22ee7` base `889973f`；CI `41158230737` 双平台绿；**REVIEW，未集成** | PR #17 / CI | 待独立审 |
| 2026-10-31 | P0-pin/LAN 交付待审 | PR #18 head `3826fad1` base `889973f`；**LAN-direct ET not started**；仅原生 LAN 通过 | PR #18 | REVIEW；不能 P0-overlay DONE |
| 2026-10-31 | P0-overlay 同机回环实验 | PR #27 draft head `af3098d` base `test/phase10-harness-pin`（#18）；docs-only 无 CI；同机两节点回环 TCP noTUN 401/401/200/429/topup/Remote/revoke/restart/ACL 拒管理端口 REPRODUCED（开发方报告） | PR #27 | REVIEW；非跨主机/NAT/relay/WAN；非浏览器无文件 GO；独立审待核 |
| 2026-10-31 | A-service 集成阻断 | PR #22 head `77d71b2`；PID ownership 不能证明、RPC 先用后验；review `84ba711e…` + 修复中 | PR #22 | BLOCKED；未集成 |
| 2026-10-31 | B-service 不可集成 | PR #19 `0988c85a` / #20 `277ed665`；独立审 `5d386756` 判不可集成；19fix 在做 | PR #19/#20 | BLOCKED；未集成 |
| 2026-10-31 | B-core 待审 | PR #26 draft head `fdc7d4c4` base `8ce5c57`；47 模块测试；handoff 已交 | PR #26 / handoff | REVIEW；未集成 |
| 2026-10-31 | A-ui 待审/阻断 | PR #25 head `cbce7004`；fixture 截图非真实 Magpie；66 前端测试/0；CI 5 既有 clock 失败；4 项主审阻断待 fix | PR #25 | REVIEW；不能 Visual GO |
| 2026-10-31 | P0-clock 独立审 | 精确 `889973f5` 无产品/安全阻断；746/0；CI 双绿；boot 32 次未复现 flake；主审批准仅该 commit 本地集成 | PR #15 / 独立审报告 | 通过（非产品 GO） |
| 2026-10-31 | C-registry 待审 | PR #21 head `5ef4430`；真实只读主网余额 REPRODUCED；完整 SHA 待 handoff | PR #21 | REVIEW；主网资金 NO-GO；未集成 |
| 2026-10-31 | P0 报告命名 | P0-clock 属 P0，不沿用 D2 名称 | 主审说明 | VERIFIED |
| 2026-10-31 | 改动前 UI 审查证据 | 3 份事实报告 + 16 张截图 + SHA256SUMS 已入库；无 HOME/app/凭据；0.1.2289 空网络 | `docs/phase10/evidence/` | REPRODUCED / 已审查；非 Visual UX GO |
| 2026-10-31 | 外置钱包测试计划 | 真实 MetaMask/Rabby 验收 **BLOCKED/UNKNOWN**（隔离 profile 工具缺口）；不碰默认 profile | `docs/phase10/evidence/2026-10-31-external-wallet-test-plan.md` | 附录；非验收 |
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
