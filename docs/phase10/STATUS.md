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
| 开发/文档分支 | `feature/phase10-simplified-p2p-ux` @ docs 最新提交（= PR14 head；仅 docs） |
| 集成分支 | `feature/phase10-integration` @ `6c267d6`（worktree `/tmp/oma-phase10-integration`；含批准 15 `889973f` + 29 `0093279` + 17 `49e8c0ff`） |
| 盘点工作树 | `/Users/laysath/Projects/magpie-oh-my-aihub-import` |
| 纯 main 只读工作树 | `/tmp/oma-phase10-main-8ce5c57`（detached @ `8ce5c57`） |
| 目标运行版本（已决定） | **Magpie 0.1.2289 + EasyTier 2.6.4**；隔离副本，不改用户安装 |
| 本机安装 | `/Applications/Magpie.app` 0.1.2289（只做只读来源/复制） |
| 计费/峰谷价 | 0.1.2289 的 `peak` 先 **fail-closed 拒绝**；后续单独实现，不再让用户选 |
| 本地门禁 | typecheck / boot-check / secret-scan 通过；clock 集成本地仅跑 typecheck + 4 个纯钱包测试 32/0；**未跑全量**（防旧测试访问生产网关/公共 RPC，等 PR17 guard） |
| 参考研究 | 审查代理 `6a326f2b-2249-4123-8f35-1fe35926e107`：`/tmp/oma-research/REFERENCE-REVIEW.md` |
| PR14 | `#14` draft，head = docs 最新提交；**仅 docs，未含应用代码**；内容仅计划，无 GO；不合并 |
| P0-clock 集成 | 源 15 `889973f5` → `877d0bc5`；29 `0093279` → `d1922f4`；17 `49e8c0ff` → `6c267d6`；均独立审通过；**非产品 GO** |
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
| A-ui | `/Users/laysath/.paseo/worktrees/1z728cdk/a-ui` | `ccb08749-badc-4512-9604-e93ce7bd76b9` | PR #25 new `b1a4838d` base `8ce5c57` | REVIEW | 六项 fix；73 前端 0；CI 仅 5 旧 clock；fixture 非真实；`6a326f2b…` 固定六项复验中；**不能自动通过/Visual GO**；旧 `cbce700` 阻断留历史 |
| A-service | `/Users/laysath/.paseo/worktrees/1z728cdk/a-service` | `c51de818-13dd-4df6-ba68-2e48155eeb63` | PR #22 frozen `db0a4c2b` base `8ce5c57` + `-x` approved clock15 | REVIEW | CI `41160417732` linux/mac 绿；开发方 246 定向 0 fail；foreign 0 CLI / forward 0 request / shared serialized guard fail；`84ba711e…` 原五组复审中 | 旧 `77d71b2`/`feeddecad` 阻断历史保留；不自动批准；CI 绿 ≠ A 总 GO |
| B-core | `/Users/laysath/.paseo/worktrees/1z728cdk/b-core` | `0185d02c-b0c4-49a9-b9bb-7242c31d6a04` | PR #26 `d2d3b4f` | REVIEW | typed revoked + B1 PASS，但 uncertain 旧 Key 仍新批准 / 审批 unknown 再 Key 两阻断；fix 中 | 不准 stack；B 整体 NO-GO/未验证 |
| B-service | `/Users/laysath/.paseo/worktrees/1z728cdk/b-service` | `8dd0cf10-548b-45fb-88c0-9b8a7cb5abe3` | PR #19 `6fa9877a` / PR #20 `715491f7` | BLOCKED | 19 已独立等价复核，主审批准仅作 20 技术 base；20 仍 BLOCKED 修中 | B 整体 NO-GO/未验证；不自动集成 |
| C-registry | `/Users/laysath/.paseo/worktrees/1z728cdk/c-registry` | `0c94d106-6442-470f-8f14-374c38ea20f7` | PR #21 frozen `917c429` | BLOCKED | 独立审 `93febdd5…`：56/8453 只读窄能力 PASS；但主审不准正式集成；3 项小 fix：chain1 改 testnet 可启 watcher、可信 FundsClass 缺失/reconcile 把 chain 来源记 simulated、RPC v2 https 绕过 307/无界 body/failover 链未校验 | 未发现远端可达 56/8453 credit 绕过；/topup 本地 bearer；不作主网远程盗款结论；资金 NO-GO；未集成 |
| C-wallet | `/Users/laysath/.paseo/worktrees/1z728cdk/c-wallet` | `01060df1-e5e8-4de8-b6cb-70ca932c7b1e` | PR #23 head `1a8a53d`（完整 SHA 待 handoff） | REVIEW | 41 模块测试；未 UI/真实资金；独立审 `b97887e5…` 进行中 | 未集成；主审明确 commit + 安全评审 |
| C-external | `/Users/laysath/.paseo/worktrees/1z728cdk/c-external-wallet` | `3820537e-5840-4926-ba00-5975805b2df6` | PR #30 frozen `837bacba` | BLOCKED | 46 合成 tests/CI 双绿；未 UI/真扩展；主审 BLOCK 付款 UI 接入；需移除 unknown asset 普通签名例外 + 发送默认需服务 durable journal port；独立审 `baeaa46d…` | 真实 MetaMask/Rabby UNKNOWN；资金 NO-GO；不自动集成 |
| P0-clock | `/Users/laysath/Projects/magpie-oh-my-aihub-clock-fix` | `f63b644e-40df-4174-afd4-c4f43da87927` | `fix/phase10-validation-clock` @ `889973f5` / PR #15 (draft) | DONE（集成） | 独立审通过；本地集成到 `feature/phase10-integration` @ `877d0bc5`；PR14 仍 docs-only |
| P0-integration | `/tmp/oma-phase10-integration` | INTEGRATION | `feature/phase10-integration` @ `6c267d6` | DONE（集成） | 只接已批准 15 + 29 + 17；16/18/其它未接；非产品 GO |
| P0-peak | `/Users/laysath/Projects/magpie-oh-my-aihub-p0` | `187ccdcb-8f0b-40f3-8276-939334de4412` | PR #16 old `0661bede` | BLOCKED | 独立审 FAIL：tier canonical 丢 dynamic；原代理修；**不准集成** |
| P0-hermetic | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #17 `49e8c0ff` base `889973f` → `6c267d6` | DONE（集成） | 四 commits 依次 pick（60d0d04, 3ce22ee, 66d19e4, 49e8c0f）；CI `41160096921` 双绿；typecheck；network-guard 7/0；phase8 35/0 | scope 仅 global fetch + Bun.serve；socket/subprocess 受控 seam；register 生命周期如实；非全网络 sandbox/非产品 GO |
| P0-pin | 独立 worktree（待补） | P0 测试代理（待补） | PR #18 new `5f771764` exact mac arm hash | REVIEW | exact mac arm hash 强制/12 自检/CI 双绿 | 未集成；待审；不能总 P0 DONE |
| P0-overlay | 独立 worktree（待补） | P0 测试代理（待补） | PR #27 new `3b55491a` | REVIEW | 入库 sanitized proof；明确 raw/PID 证据缺失并降级，无补造 | 非 GO；未授权应用集成；不能标真实双主机/全面安全验收 |
| P0-pure-tests | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #29 `0093279` → `d1922f4` | DONE（集成） | 独立审 PASS（含删 TTL/改 <= 变异失败）；`console-wallet.test.ts` +64/−1；定向 15/0；typecheck 通过 | 非产品 GO；只 pick 29 delta，不重复 clock；PR14 docs-only |

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
| P0-2 | `peak` fail-closed | P0-peak `187ccdcb…` + C | BLOCKED | P0-1 | PR #16 old `0661bede`；独立审 FAIL：tier canonical 丢 dynamic；报告 `/tmp/oma-research/P0-PRICING-GUARD-REPORT.md` | **不准集成**；原代理修 |
| P0-3 | 测试时钟 | P0-clock `f63b644e…` | DONE（集成） | — | 独立审通过 `889973f5`；集成 `877d0bc5`；typecheck 通过；4 个纯钱包测试 32/0 | 非产品 GO；PR14 不含代码；其他 P0 未接 |
| P0-6 | hermetic tests（隔离旧测试对生产网关/公共 RPC 的访问） | P0 测试代理 | DONE（集成） | P0-3 | PR #17 exact `49e8c0ff` → `6c267d6`；四 commits；typecheck；network-guard 7/0；phase8 35/0 | 仅 global fetch/Bun.serve；socket/subprocess 受控 seam；非全网络 sandbox/非产品 GO |
| P0-7 | 精确 pin 支持 0.1.2289 实际实验 | P0 测试代理 | DONE（限定证据） | P0-1 | PR #18 exact `3826fad14690acb14663754b3cf3749354356bc7`；PASS 限定 pin/LAN | hash 仅记录未强制；cleanup exact 4 pid 不足；未集成 |
| P0-8 | 真实 no-TUN EasyTier overlay/forward | P0 测试代理 | PASS-as-evidence | P0-7 | PR #27 exact `af3098d6faffa4d8916934db4a5af10cee8a8fc4`；同机 ET noTUN 通过 | raw HTTP 未入库；exact 8 pid proof 不足；**不能标真实双主机/全面安全验收**；未授权应用集成；先补证/降级 |
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
| A10 | A-ui 独立审阻断修复 | A-ui | REVIEW | A9 | PR #25 new `b1a4838d` base `8ce5c57`；73 前端 0；CI 仅 5 旧 clock；`6a326f2b…` 复验六项 | 旧 `cbce700` 阻断留历史；fixture 非真实；未自动通过 |
| A14 | A-ui 六项 fix 复验 | A-ui | REVIEW | A10 | 可用模型、credited/资产、wallet 密度、404 多步、discover primary、14px | 复验未出结论前不 Visual GO |
| A13 | A-ui 已通过项（不覆盖阻断） | 审查代理 | DONE（仅事实） | A10 | 五导航/3 字段/只读 port/无 role/self 不计/未知非 0/theme/焦点/reduceMotion | 不能据此判 Visual GO；新 head 真实会话 UNKNOWN |
| A11 | A-service ownership/proof/share 并发 | A-service | REVIEW | P0 | PR #22 frozen `db0a4c2b`；246 定向 0 fail；CI `41160417732` 双绿；`84ba711e…` 五组复审 | 原 `77d71b2`/`feeddecad` 阻断历史保留；不自动批准 |
| A12 | A-service 新 SHA 复核 | A-service | REVIEW | A11 | `db0a4c2b05102f403b284a9cc2a34efe9e0763bd` base `8ce5c57` + `-x` approved clock15 | 待 `84ba711e…` 明确结论；CI 绿不算 A GO |
| A12 | A-service 新 SHA 复核 | A-service | BLOCKED | A11 | CI 76 fail（约 71 新回归），不能写仅 5 基线 | 3 批小 fix；production 默认 owner 不可绕；`84ba711e…` 新 SHA 后复核；未提交 dirty seam 不算证据 |
| A12 | A-service 新 head 复审 | A-service | REVIEW | A11 | `feeddecad4c161654a1e426e68b62abe4098bf42` | 不能凭 fix message 通过；报告不输出 secret |

### B — 无文件 P2P / 人工审批 / 端到端加密授权

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 所有节点独立有限控制服务 | B-core | REVIEW | P0 | PR #26 `d2d3b4f`；typed revoked + B1 PASS；uncertain 旧 Key 仍新批准/审批 unknown 再 Key 两阻断 | fix 中；不准 stack；不称 B GO |
| B2 | `connection_request` 结构化消息 | B-core | TODO | B1 | schema/限长/字段白名单；无 Key/无文件 | 不落文件 |
| B3 | 提供方人工批准 | B-core | TODO | B2 | 选模型+正额度+明确勾选；审计 | 不自动批准 |
| B4 | E2E 加密授权 | B-core | TODO | B3 | 密文/解密/错身份负向 | 提供方不持久化明文 |
| B5 | 注册状态机（不依赖 ACK） | B-core | TODO | B4 | 注册成功+模型/额度回读 → registered | 不以 ACK 为前置门 |
| B6 | ACK 丢失有限幂等恢复 | B-core | TODO | B5 | 同 id 重发/查询；不重造 Key/不重复计费 | 不“一律不重试” |
| B7 | 原生 Remote Magpie 注册 + 回读 | B-core | TODO | B5 | 模型/额度回读；只注册本插件连接 | 不注册外部连接 |
| B8 | 首次/变化 TOFU 人工 | B-core | TODO | B2 | 未接受/身份变化禁止 | 不跳过 |
| B9 | 重放/篡改/过期 | B-core | TODO | B1..B7 | 负向测试 | 不自动文件回退 |
| B10 | 紧急文件兼容 | B-core + 审查 | TODO | B9 | 显式选择/警告；默认关 | 不作为目标/验收替代 |
| B11 | 有限 HTTP transport + 业务集成接口 | B-service | BLOCKED | B1,B3 + A-service stacked base | PR #19 `6fa9877a` 已独立等价复核，仅批准作 20 技术 base；PR #20 `715491f7` 仍 BLOCKED 修中 | B 整体 NO-GO；旧 `277ed66` 阻断历史留存 |

### C — 钱包与主网准备

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 56/8453 只读网络平权 | C-registry | BLOCKED | P0 | PR #21 frozen `917c429`；独立审 `93febdd5…` 窄能力 PASS；3 项 fix | 不准正式集成；send/sign/autorecharge 无入口 → 端到端 UNKNOWN；资金 NO-GO |
| C12 | C21 修复复审 | C-registry | BLOCKED | C1 | chain1 watcher/testnet 可启、FundsClass/reconcile 来源、RPC v2 https/307/body/failover 校验 | 3 小 fix 不扩功能；仍无 C 总 GO；不作远端盗款夸大 |
| C2 | 收款网络默认空选 | C-registry | TODO | C1 | 默认无链/资产；必须明确选 | 不自动选链 |
| C3 | 严格资产四元组 | C-registry | TODO | C1 | `chainId+tokenContract+decimals+issuerType`；拒绝符号推断 | 任意代币 |
| C4 | 内置钱包：隔离模拟创建/恢复/加密存储/短解锁 | C-wallet | REVIEW | P0 | PR #23 head `1a8a53d`；41 模块测试；独立审 `b97887e5…` | 未 UI/真实资金；未集成 |
| C5 | 敏感导出/助记词 | C-wallet | REVIEW | C4 | PR #23；警告 + **重新验证钱包密码**；不落日志/快照 | 未集成；独立审进行中 |
| C6 | 外置钱包/多扩展明确选择 | C-external | BLOCKED | P0 | PR #30 frozen `837bacba`；46 合成 tests；未 UI/真扩展；独立审 `baeaa46d…` | 删除 unknown asset 普通签名例外；发送需 durable journal；真实扩展 UNKNOWN |
| C7 | P2P 付款/签名 | C-wallet + C-external | DOING | C2,C3 | 测试网/模拟；直接签名；普通钱包无签名文件 | 主网广播/签名文件路径 |
| C8 | 自动充值策略（上限/暂停/条件） | C-wallet | TODO | C4..C7 | 策略 + 负向测试；可模拟/测试执行 | 主网执行 |
| C9 | 主网硬禁止 | C-registry + C-wallet + C-external | TODO | C1..C8 | 负向测试：send/credit/cap 全拒绝 | 任何例外 |
| C11 | 真实 MetaMask/Rabby 扩展兼容 | C-external | BLOCKED | 隔离 profile 工具 | PR #30 `837bacba` 46 合成 tests；真实扩展 UNKNOWN；独立审 `baeaa46d…` | 不得用 fake provider 单测声称兼容；主审 BLOCK 付款 UI 接入；资金 NO-GO |
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
| 2026-10-31 | B-service 新 heads | PR #19 `6fa9877a` 已独立等价复核，主审批准仅作 20 技术 base；PR #20 `715491f` 仍 BLOCKED 修中 | PR #19/#20 | 20 BLOCKED；19 仅技术 base |
| 2026-10-31 | B-core 复审阻断 | PR #26 冻结 `fdc7d4c4`；独立审 `5d386756` BLOCKED（B1/B2/B3）；cross-message idem/价格版本已修复；core fix 中 | PR #26 | BLOCKED（历史）；未集成 |
| 2026-10-31 | B-core 最新 | PR #26 `d2d3b4f`；typed revoked + B1 PASS；uncertain 旧 Key 仍新批准/审批 unknown 再 Key 两阻断；fix 中 | PR #26 | REVIEW；不准 stack；B 整体 NO-GO/未验证 |
| 2026-10-31 | P0-hermetic 集成 | 源 `49e8c0ff` base `889973f`；四 commits → `6c267d6`；typecheck；network-guard 7/0；phase8 35/0；scope 限 global fetch/Bun.serve | PR #17 / integration | 非产品 GO；未全网络 sandbox |
| 2026-10-31 | P0-clock 集成 | 源 `889973f5` → `877d0bc5`；独立审通过；仅本地 integration 分支；PR14 仍 docs-only | `feature/phase10-integration` | 非产品 GO |
| 2026-10-31 | A-ui 新 head 待复验 | PR #25 `b1a4838d` base `8ce5c57`；六项 fix；73/0；CI 仅 5 旧 clock；fixture 非真实；`6a326f2b…` 复验中 | PR #25 | REVIEW；不能自动通过/Visual GO；旧 cbce700 阻断留历史 |
| 2026-10-31 | P0-clock 独立审 | 精确 `889973f5` 无产品/安全阻断；746/0；CI 双绿；boot 32 次未复现 flake；主审批准仅该 commit 本地集成 | PR #15 / 独立审报告 | 通过（非产品 GO） |
| 2026-10-31 | P0 纯测试集成 | PR #29 `0093279` → `d1922f4`；独立审 PASS（含删 TTL/改 <= 变异失败）；定向 console-wallet 15/0；typecheck | PR #29 / integration | 非产品 GO |
| 2026-10-31 | P0 最终结论 | 15/29 集成；17/16 阻断待原代理修；18 PASS 限定 pin/LAN（hash 未强制、cleanup 不足）；27 PASS-as-evidence（raw HTTP 未入库、8 pid proof 不足） | PR #15/16/17/18/27/29 | 仅 15/29 集成；其余未授权 |
| 2026-10-31 | P0-hermetic 独立 FAIL | PR #17 `3ce22ee7`；check/resume seam 未透传、仍读生产 | PR #17 | BLOCKED；原实现修；不准集成 |
| 2026-10-31 | P0-peak 独立 FAIL | PR #16 `0661bede`；tier/canonical 一致性 + 覆盖缺口 | PR #16 | BLOCKED；原实现修；不准集成 |
| 2026-10-31 | C21 frozen 复审 | PR #21 `917c429`；独立审 `93febdd5…`：只读窄能力 PASS；主审不准正式集成；3 项 fix；未发现远端 credit 绕过；/topup 本地 bearer；send/sign/autorecharge 无入口 UNKNOWN | PR #21 | BLOCKED；资金 NO-GO；未集成 |
| 2026-10-31 | A-service 复审仍阻断 | `feeddecad`：启动 foreignRPC 修复 PASS；presecret 先泄 syntheticKey；allCLI/start 不统一 gate；share 并发/吞 suspended/catalog；stalepeer/ledgerstable；CI 76 fail（约 71 新回归） | PR #22 | BLOCKED（历史）；未集成 |
| 2026-10-31 | A-service 新 frozen 待复审 | PR #22 `db0a4c2b` base `8ce5c57` + `-x` approved clock15；CI `41160417732` 双绿；246 定向 0 fail；foreign 0 CLI/forward 0 request/shared serialized guard fail；`84ba711e…` 五组复审 | PR #22 | REVIEW；旧 77/feeddec 阻断保留；不自动批准；未集成 |
| 2026-10-31 | C-external 冻结待审 | PR #30 `837bacba`；46 合成 tests/CI 双绿；未 UI/真扩展；allowUnregisteredAsset 无 issuer 信任、UNKNOWN_BROADCAST 仅内存可重发；主审 BLOCK 付款 UI | PR #30 | BLOCKED；资金 NO-GO；不自动集成 |
| 2026-10-31 | C-wallet 交付待审 | PR #23 head `1a8a53d`；41 模块测试；未 UI/真实资金；独立审 `b97887e5…` | PR #23 | REVIEW；未集成 |
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
