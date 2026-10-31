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
| 集成分支 | `feature/phase10-integration` @ `cc0d740`（worktree `/tmp/oma-phase10-integration`；含批准 15/29/17/16/18/27/25/30/24/31） |
| 冻结证据 HEAD | `cc0d740876e5a667f1789e1ae3b4966ecf8cef9f`：f63b 独立临时组合测试 + `6a326f2b` 干净真实 Magpie 仅会话/5页/布局空态；**禁止 join/share/payment；22 未批**；本轮不接新业务 |
| cc0 组合验证 | 845 pass/8 fail（EADDRNOTAVAIL，TIME_WAIT 16244/16384）→ 恢复后 853/0；frozen install/typecheck/boot/secret PASS；**非产品 GO**；报告 `docs/phase10/evidence/2026-10-31-integration-cc0d740-validation.md` |
| cc0 真实宿主 | 本地目录直链安装（非 GitHub 升级包）；5 UI 文件 hash + ownerPid/status.pid/listener/argv 一致；三字段/主题/焦点/390/logout PASS；**5 页/join/share/payment UNKNOWN**；**非 Visual GO** |
| next integration（28） | `feature/phase10-integration-next` @ `87a72c6`（worktree `/tmp/oma-phase10-integration-next`；从 cc0 开发，只接 28 自身 delta；**与 cc0 证据分开**） |
| 盘点工作树 | `/Users/laysath/Projects/magpie-oh-my-aihub-import` |
| 纯 main 只读工作树 | `/tmp/oma-phase10-main-8ce5c57`（detached @ `8ce5c57`） |
| 目标运行版本（已决定） | **Magpie 0.1.2289 + EasyTier 2.6.4**；隔离副本，不改用户安装 |
| 本机安装 | `/Applications/Magpie.app` 0.1.2289（只做只读来源/复制） |
| 计费/峰谷价 | 0.1.2289 的 `peak` 先 **fail-closed 拒绝**；后续单独实现，不再让用户选 |
| 本地门禁 | typecheck / boot-check / secret-scan 通过；clock 集成本地仅跑 typecheck + 4 个纯钱包测试 32/0；**未跑全量**（防旧测试访问生产网关/公共 RPC，等 PR17 guard） |
| 参考研究 | 审查代理 `6a326f2b-2249-4123-8f35-1fe35926e107`：`/tmp/oma-research/REFERENCE-REVIEW.md` |
| PR14 | `#14` draft，head = docs 最新提交；**仅 docs，未含应用代码**；内容仅计划，无 GO；不合并 |
| P0-clock 集成 | 15；29；17；16；18；27；25；30；24；31；均独立审通过并本地集成，**非产品 GO** |
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
| A-ui | `/tmp/oma-phase10-integration`（集成） | `ccb08749-badc-4512-9604-e93ce7bd76b9` | PR #25 `b1a4838d` base `8ce5c57` → `f6c329e` | DONE（UI 单元集成） | 六项独立 PASS；73 console/0；console-security+api 36/0；typecheck；旧 `cbce700` 阻断留历史 | 非 Visual GO；ProviderView 无 models 字段→模型计数分支不可达（未知非虚报）；真实 host 746de60 五文件同 hash，但 b1a4838 干净安装/真实 join/share UNKNOWN |
| A-service | `/Users/laysath/.paseo/worktrees/1z728cdk/a-service` | `c51de818-13dd-4df6-ba68-2e48155eeb63` | PR #22 `56d05f7` + #32/33/34 targets | REVIEW | 22 四残余 fix；32/33/34 待审；modelsEvidence 后端/UI 独立已授权实施 | 旧 db0a4c2b/77/feeddec 历史；未集成 |
| B-core | `/Users/laysath/.paseo/worktrees/1z728cdk/b-core` | `0185d02c-b0c4-49a9-b9bb-7242c31d6a04` | PR #26 `eccb1440` | DONE（仅 20 技术依赖） | 独立最终 PASS；主审批准仅作 20 技术依赖 | **不是整个 B/默认产品 GO**；旧 cdee/4304/d2d 历史 |
| B-service | `/Users/laysath/.paseo/worktrees/1z728cdk/b-service` | `8dd0cf10-548b-45fb-88c0-9b8a7cb5abe3` | PR #20 `9f51c078` | BLOCKED | independent unique keyReady adopt 阻断 fix 中；noSideEffect 已 PASS | 旧 7c/f779/715 历史；未集成 |
| C-wallet | `/Users/laysath/.paseo/worktrees/1z728cdk/c-wallet` | `01060df1-e5e8-4de8-b6cb-70ca932c7b1e` | PR #23 `9393b12c` | REVIEW | 五 fix 已交 `b97887e5…` 短复审 | 旧 325b81a 历史；未集成 |
| C-registry | `/Users/laysath/.paseo/worktrees/1z728cdk/c-registry` | `0c94d106-6442-470f-8f14-374c38ea20f7` | PR #21 `20461b1` | BLOCKED | 四 actual money fix 中 | 旧 917 历史；不准正式集成 |
| PR31 | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #31 `ac7bfd0`+`659d8b3` → `cc0d740` | DONE（测试集成） | service 41/0；CLI 35/0；typecheck；secret-scan；动态端口/guard 已含；只取 service.test delta | 非产品 GO；未混 C21 资金改动 |
| C-external | `/tmp/oma-phase10-integration`（模块集成） | `3820537e-5840-4926-ba00-5975805b2df6` | PR #30 行为 `90c32f8c`；PR head `ae596c3`（仅 docs 2 行）→ `6440876` | DONE（隔离模块集成） | 52 module/0；chain1 deny/SVG null/无 operationPort 零 provider call/unknown 跨 session 阻重发；actual journal 未做，default send off | **非 WalletGO**；不接 Service journal/UI；真实扩展 UNKNOWN；资金 NO-GO |
| Windows CI | `/tmp/oma-phase10-integration`（子集集成） | P0 测试代理 | PR #24 `ed60ce19` → `6440876` | DONE（Windows 子集证据） | workflow + tests；真实 windows-latest 证据；本机 typecheck/platform/networkloopback 48/0；未在本机模拟 Windows | 仅 Windows 子集/真实 runner 证据；**不是 Windows 产品支持/平台 GO** |
| P0-clock | `/Users/laysath/Projects/magpie-oh-my-aihub-clock-fix` | `f63b644e-40df-4174-afd4-c4f43da87927` | `fix/phase10-validation-clock` @ `889973f5` / PR #15 (draft) | DONE（集成） | 独立审通过；本地集成到 `feature/phase10-integration` @ `877d0bc5`；PR14 仍 docs-only |
| P0-integration | `/tmp/oma-phase10-integration` | INTEGRATION | `feature/phase10-integration` @ `cc0d740`（冻结） | DONE（冻结证据） | 只接已批准 15+29+17+16+18+27+25+30+24+31；20/21/22/23/26 未接；非产品 GO |
| Security gates | `/tmp/oma-phase10-integration-next` | 安全工具代理 | PR #28 `10ca2e7` → `87a72c6` | DONE（工具集成） | gitleaks 12 selftest PASS；pack --selftest PASS；组合 worktree scan 0；typecheck；synthetic fixture 精确指纹 | 非产品 GO；不与 cc0 证据混称 |
| P0-peak | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #16 `10e46a13` base `889973f` → `343dae2` | DONE（集成） | 自身 commits `0661bede` + `9a46cc`；跳过 clock `10e46a`；typecheck；87 定向/0；secret-scan PASS | 旧 `0661bede` 阻断历史留存；非产品 GO |
| P0-hermetic | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #17 `49e8c0ff` base `889973f` → `6c267d6` | DONE（集成） | 四 commits 依次 pick（60d0d04, 3ce22ee, 66d19e4, 49e8c0f）；CI `41160096921` 双绿；typecheck；network-guard 7/0；phase8 35/0 | scope 仅 global fetch + Bun.serve；socket/subprocess 受控 seam；register 生命周期如实；非全网络 sandbox/非产品 GO |
| P0-pin | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #18 `5f771764` base `889973f` → `b873b0d` | DONE（限定工具/证据） | 五 commits（c121da6, 934e679, d3c066c, 3826fad, 5f77176）；exact mac arm hash 强制；unittest 12/0；typecheck；secret-scan；proof SHA 匹配 | 不改用户安装；非产品 GO；非真实双主机 |
|
| P0-overlay | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #27 `3b55491a` base 18 → `b873b0d` | DONE（限定证据） | 三 commits（8b82e9e, af3098d, 3b55491）；sanitized proof 入库；proof SHA `f4fbcef7…` 与文档一致 | 缺 raw HTTP/PID startup manifest/copy cleanup before 空；不能标真实双主机/全面安全 |
|
| P0-pure-tests | `/tmp/oma-phase10-integration`（集成） | P0 测试代理 | PR #29 `0093279` → `d1922f4` | DONE（集成） | 独立审 PASS（含删 TTL/改 <= 变异失败）；`console-wallet.test.ts` +64/−1；定向 15/0；typecheck 通过 | 非产品 GO；只 pick 29 delta，不重复 clock；PR14 docs-only |

> B-core 与 B-service 共同维护合同 `/tmp/oma-research/B-CONTROL-CONTRACT.md`；B-service 只做有限 HTTP transport 与业务集成接口，不重复密码模块。
>
> C-wallet 只做隔离测试核心（创建/恢复/加密存储/短解锁/敏感导出/EIP712 模拟签名）；**尚未 UI 集成，也不代表生产资金认可**。

### 2.0 当前 review target 与历史发现（以此为准）

| PR | 当前 target | 状态 | 当前事实 | 历史（不当前） |
| --- | --- | --- | --- | --- |
| 26 | `eccb144002647f8a5d2a3385cf16df05c8934306` | DONE（仅 20 技术依赖） | 独立最终 PASS；主审批准仅作 20 技术依赖 | cdee/4304/d2d 阻断历史；**不是整个 B/默认产品 GO** |
| 20 | `9f51c0780410512e5a233684539efe9ea55e63a6` | BLOCKED | unique keyReady adopt 阻断 fix 中；noSideEffect 已 PASS | 7c/f779/715 历史 |
| 23 | `9393b12ce033b5c564f10c6a41e232aafccd749a` | REVIEW | 五 fix 交 `b97887e5…` 短复审 | 325b81a/1a8a53d 历史 |
| 21 | `20461b1` | BLOCKED | 四 actual money fix 中 | 917c429 历史；不准正式集成 |
| 22 | `56d05f7` | REVIEW | 四残余 fix；32/33/34 targets 待审；modelsEvidence 后端/UI 独立已授权 | db0a4c2b/77/feeddec 历史 |
| 32/33/34 | 待 handoff | REVIEW | 独立审 | — |
| 30 | 行为 `90c32f8c` / final docs `ae596c3` | DONE（隔离模块） | 已集成；default send off；非 WalletGO | 837/d533 历史 |
| 31 | `ac7bfd0`+`659d8b3` | DONE（测试） | 已集成；service 41/0 | — |
| 24 | `ed60ce19` | DONE（Windows 子集） | 已集成；非平台 GO | 927c71a 历史 |
| 28 | `10ca2e7` → next `87a72c6` | DONE（安全工具） | gitleaks/pack/scan 通过 | 927c71a 历史 |

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
| P0-2 | `peak` fail-closed | P0-peak `187ccdcb…` + C | DONE（集成） | P0-1 | PR #16 `10e46a13`；自身 `0661bede` + `9a46cc`；typecheck；87/0；secret-scan PASS | 旧 `0661bede` 阻断历史留存；非产品 GO |
| P0-3 | 测试时钟 | P0-clock `f63b644e…` | DONE（集成） | — | 独立审通过 `889973f5`；集成 `877d0bc5`；typecheck 通过；4 个纯钱包测试 32/0 | 非产品 GO；PR14 不含代码；其他 P0 未接 |
| P0-6 | hermetic tests（隔离旧测试对生产网关/公共 RPC 的访问） | P0 测试代理 | DONE（集成） | P0-3 | PR #17 exact `49e8c0ff` → `6c267d6`；四 commits；typecheck；network-guard 7/0；phase8 35/0 | 仅 global fetch/Bun.serve；socket/subprocess 受控 seam；非全网络 sandbox/非产品 GO |
| P0-7 | 精确 pin 支持 0.1.2289 实际实验 | P0 测试代理 | DONE（限定工具/证据） | P0-1 | PR #18 `5f771764` → `b873b0d`；exact mac arm hash 强制；unittest 12/0 | 非产品 GO；不改用户安装 |
| P0-8 | 真实 no-TUN EasyTier overlay/forward | P0 测试代理 | DONE（限定证据） | P0-7 | PR #27 `3b55491a` → `b873b0d`；同机 ET noTUN；sanitized proof | 缺 raw HTTP/PID startup/copy cleanup before；不能标真实双主机/全面安全 |
| P0-9 | Windows 子集 CI | P0 测试代理 | DONE（集成） | P0-1 | PR #24 `ed60ce19` → `6440876`；explicit 22-file subset；MIN_EXECUTED 380 未放宽；本机 platform/networkloopback 48/0 | 真实 windows-latest 证据；本机未模拟；非 Windows 产品支持/平台 GO |
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
| A10 | A-ui 独立审阻断修复 | A-ui | DONE（UI 单元集成） | A9 | PR #25 `b1a4838d` → `f6c329e`；73 console/0；security+api 36/0；typecheck | 非 Visual GO；ProviderView 无 models 字段分支不可达；干净安装/真实 join share UNKNOWN |
| A14 | A-ui 六项 fix 复验 | A-ui | DONE（独立 PASS） | A10 | 六项 PASS 报告 `/tmp/oma-research/A-UI-REVIEW-b1a4838.md` | 仅 UI 单元；非 Visual GO；两缺口保留 |
| A13 | A-ui 已通过项（不覆盖阻断） | 审查代理 | DONE（仅事实） | A10 | 五导航/3 字段/只读 port/无 role/self 不计/未知非 0/theme/焦点/reduceMotion | 不能据此判 Visual GO；新 head 真实会话 UNKNOWN |
| A11 | A-service ownership/proof/share 并发 | A-service | REVIEW | P0 | PR #22 latest `56d05f7`；原五组 PASS；allCLI 活 context/wildcard 剩余 fix | 旧 db0a4c2b/77/feeddec 历史；不自动批准 |
| A12 | A-service 最新复核目标 | A-service | REVIEW | A11 | PR #22 latest `56d05f7`；allCLI/wildcard 剩余 fix | 旧 db0a4c2b/feeddec 历史；未集成 |

### B — 无文件 P2P / 人工审批 / 端到端加密授权

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 所有节点独立有限控制服务 | B-core | DONE（仅 20 技术依赖） | P0 | PR #26 `eccb1440` 独立最终 PASS；仅批准作 20 技术依赖 | 不是整个 B/默认产品 GO；旧 cdee/4304 历史 |
| B2 | `connection_request` 结构化消息 | B-core | TODO | B1 | schema/限长/字段白名单；无 Key/无文件 | 不落文件 |
| B3 | 提供方人工批准 | B-core | TODO | B2 | 选模型+正额度+明确勾选；审计 | 不自动批准 |
| B4 | E2E 加密授权 | B-core | TODO | B3 | 密文/解密/错身份负向 | 提供方不持久化明文 |
| B5 | 注册状态机（不依赖 ACK） | B-core | TODO | B4 | 注册成功+模型/额度回读 → registered | 不以 ACK 为前置门 |
| B6 | ACK 丢失有限幂等恢复 | B-core | TODO | B5 | 同 id 重发/查询；不重造 Key/不重复计费 | 不“一律不重试” |
| B7 | 原生 Remote Magpie 注册 + 回读 | B-core | TODO | B5 | 模型/额度回读；只注册本插件连接 | 不注册外部连接 |
| B8 | 首次/变化 TOFU 人工 | B-core | TODO | B2 | 未接受/身份变化禁止 | 不跳过 |
| B9 | 重放/篡改/过期 | B-core | TODO | B1..B7 | 负向测试 | 不自动文件回退 |
| B10 | 紧急文件兼容 | B-core + 审查 | TODO | B9 | 显式选择/警告；默认关 | 不作为目标/验收替代 |
| B11 | 有限 HTTP transport + 业务集成接口 | B-service | BLOCKED | B1,B3 + A-service stacked base | PR #20 `f779d46d` base 19 `6fa9877a`；四项阻断；原代理小修中 | B 整体 NO-GO；loopback 不能证明远端 401；旧 715/277 历史留存 |

### C — 钱包与主网准备

| ID | 单元 | 负责 | 状态 | 依赖 | 验收/证据 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 56/8453 只读网络平权 | C-registry | BLOCKED | P0 | PR #21 frozen `917c429`；独立审 `93febdd5…` 窄能力 PASS；3 项 fix | 不准正式集成；send/sign/autorecharge 无入口 → 端到端 UNKNOWN；资金 NO-GO |
| C12 | C21 修复复审 | C-registry | BLOCKED | C1 | chain1 watcher/testnet 可启、FundsClass/reconcile 来源、RPC v2 https/307/body/failover 校验 | 3 小 fix 不扩功能；仍无 C 总 GO；不作远端盗款夸大 |
| C2 | 收款网络默认空选 | C-registry | TODO | C1 | 默认无链/资产；必须明确选 | 不自动选链 |
| C3 | 严格资产四元组 | C-registry | TODO | C1 | `chainId+tokenContract+decimals+issuerType`；拒绝符号推断 | 任意代币 |
| C4 | 内置钱包：隔离模拟创建/恢复/加密存储/短解锁 | C-wallet | REVIEW | P0 | PR #23 `9393b12c`；五 fix 交 `b97887e5…` 短复审 | 旧 325 历史；未 UI/真实金；未集成 |
| C5 | 敏感导出/助记词 | C-wallet | REVIEW | C4 | PR #23；警告 + **重新验证钱包密码**；不落日志/快照 | 未集成；独立审进行中 |
| C6 | 外置钱包/多扩展明确选择 | C-external | BLOCKED | P0 | PR #30 行为 `90c32f8c` 已模块集成；default send off；Service journal/UI 未接 | chain1/SVG 已修；真实扩展 UNKNOWN；非 WalletGO |
| C7 | P2P 付款/签名 | C-wallet + C-external | DOING | C2,C3 | 测试网/模拟；直接签名；普通钱包无签名文件 | 主网广播/签名文件路径 |
| C8 | 自动充值策略（上限/暂停/条件） | C-wallet | TODO | C4..C7 | 策略 + 负向测试；可模拟/测试执行 | 主网执行 |
| C9 | 主网硬禁止 | C-registry + C-wallet + C-external | TODO | C1..C8 | 负向测试：send/credit/cap 全拒绝 | 任何例外 |
| C11 | 真实 MetaMask/Rabby 扩展兼容 | C-external | BLOCKED | 隔离 profile 工具 | PR #30 行为 `90c32f8c`；真实扩展 UNKNOWN | 不得用 fake provider 单测声称兼容；付款 UI 仍 BLOCK；资金 NO-GO |
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
| 2026-10-31 | P0-18/27 集成 | 18 `5f771764`、27 `3b55491a` → `b873b0d`；unittest 12/0；typecheck；secret-scan；proof SHA `f4fbcef7…` 匹配 | PR #18/#27 / integration | 限定证据；缺 raw HTTP/PID startup/copy cleanup before；非真实双主机 |
| 2026-10-31 | P0-clock 集成 | 源 `889973f5` → `877d0bc5`；独立审通过；仅本地 integration 分支；PR14 仍 docs-only | `feature/phase10-integration` | 非产品 GO |
| 2026-10-31 | A-ui 六项 PASS/UI 集成 | PR #25 `b1a4838d` → `f6c329e`；73 console/0；security+api 36/0；typecheck；六项独立 PASS | PR #25 / integration | UI 单元集成；非 Visual GO |
| 2026-10-31 | A-ui 两缺口保留 | ProviderView 无 models 字段→模型计数分支不可达；真实 host 746de60 五文件同 hash，但 b1a4838 干净安装/真实 join share UNKNOWN | 主审/独立审 | 未知非虚报；不能 Visual GO |
| 2026-10-31 | P0-clock 独立审 | 精确 `889973f5` 无产品/安全阻断；746/0；CI 双绿；boot 32 次未复现 flake；主审批准仅该 commit 本地集成 | PR #15 / 独立审报告 | 通过（非产品 GO） |
| 2026-10-31 | P0 纯测试集成 | PR #29 `0093279` → `d1922f4`；独立审 PASS（含删 TTL/改 <= 变异失败）；定向 console-wallet 15/0；typecheck | PR #29 / integration | 非产品 GO |
| 2026-10-31 | P0 最终结论 | 15/29 集成；17/16 阻断待原代理修；18 PASS 限定 pin/LAN（hash 未强制、cleanup 不足）；27 PASS-as-evidence（raw HTTP 未入库、8 pid proof 不足） | PR #15/16/17/18/27/29 | 仅 15/29 集成；其余未授权 |
| 2026-10-31 | P0-hermetic 独立 FAIL | PR #17 `3ce22ee7`；check/resume seam 未透传、仍读生产 | PR #17 | BLOCKED；原实现修；不准集成 |
| 2026-10-31 | P0-peak 独立 FAIL | PR #16 `0661bede`；tier/canonical 一致性 + 覆盖缺口 | PR #16 | BLOCKED；原实现修；不准集成 |
| 2026-10-31 | C21 历史 917 | 只读窄能力 PASS；主审不准正式集成；未发现远端 credit 绕过；/topup 本地 bearer | PR #21 | 历史；当前 20461b1 四 actual money fix |
| 2026-10-31 | A-service 复审仍阻断 | `feeddecad`：启动 foreignRPC 修复 PASS；presecret 先泄 syntheticKey；allCLI/start 不统一 gate；share 并发/吞 suspended/catalog；stalepeer/ledgerstable；CI 76 fail（约 71 新回归） | PR #22 | BLOCKED（历史）；未集成 |
| 2026-10-31 | A-service 当前 target | PR #22 `56d05f7`；四残余 fix；32/33/34 targets；modelsEvidence 独立实施 | PR #22 | REVIEW；旧 db0a4c2b/77/feeddec 历史 |
| 2026-10-31 | B26 最终 PASS | PR #26 `eccb1440`；独立最终 PASS；主审批准仅作 20 技术依赖 | PR #26 | 非整个 B/默认产品 GO |
| 2026-10-31 | B20 当前 target | PR #20 `9f51c078`；unique keyReady adopt 阻断 fix；noSideEffect 已 PASS | PR #20 | BLOCKED；旧 f779 历史；loopback 不能证明远端 401 |
| 2026-10-31 | C23 当前 target | PR #23 `9393b12c`；五 fix 交 `b97887e5…` 短复审 | PR #23 | REVIEW；旧 325 历史 |
| 2026-10-31 | C30 隔离模块集成 | 行为 `90c32f8c`；PR head `ae596c3` 仅 docs 2 行 → `6440876`；external 52/0；console 73/0；security/api 36/0；typecheck；default send off | PR #30 / integration | 非 WalletGO；未接 Service journal/UI；资金 NO-GO |
| 2026-10-31 | Windows 子集集成 | PR #24 `ed60ce19` → `6440876`；workflow explicit 22 files，MIN 380 未放宽；typecheck；platform/loopback 48/0 | PR #24 / integration | 非 Windows 产品支持；真实 Windows job 未在本机重跑 |
| 2026-10-31 | 当前 review targets | 22 `56d05f7`；20 `9f51c078`；23 `9393b12c`；21 `20461b1`；26 `eccb1440`（仅 20 依赖）；32/33/34 待审 | 各自 PR | 见 §2.0；历史不覆盖当前 |
| 2026-10-31 | A32/33/34 独立审重派 | 先前调用失败，已重派 | 独立审 | 待结果；不据此通过 |
| 2026-10-31 | 28 安全工具集成 | 源 `10ca2e7` → next `87a72c6`；gitleaks 12 selftest PASS；pack --selftest PASS；组合 worktree scan 0；typecheck；synthetic fixture 精确指纹 | PR #28 / integration-next | 工具集成；非产品 GO；与 cc0 证据分开 |
| 2026-10-31 | PR31 测试集成 | 源 `ac7bfd0`+`659d8b3` base approved17 → `cc0d740`；service 41/0；CLI 35/0；typecheck；secret-scan；clean | PR #31 / integration | 非产品 GO；动态端口意图 |
| 2026-10-31 | cc0 组合软件验证 | 报告 sha256 `aaf8a1dbe44af1dc3f04edbf9a8e17501d2686b66b643a90affce8cc58d6c5ba`；845/8→853/0；EADDRNOTAVAIL/TIME_WAIT 归因；frozen/typecheck/boot/secret PASS | `docs/phase10/evidence/2026-10-31-integration-cc0d740-validation.md` | 非产品 GO；未起 Magpie/ET |
| 2026-10-31 | cc0 真实宿主证据 | 报告 sha256 `58271a2fd365e132b05624bf21486e9b0eeaf904e8e16b2f23edd2889c82feb0`；本地目录安装；5 UI hash/PID/argv；三字段/主题/焦点/390/logout PASS；5 页/join/share/payment UNKNOWN | `docs/phase10/evidence/2026-10-31-integration-cc0d740-host.md` + `host-env.txt` + `console.sha256` + `screenshots/cc0d740/` + `host.SHA256SUMS` | 非 Visual GO；非 GitHub 升级包验收；tracked clean 但 ignored 运行期文件由宿主写入 |
| 2026-10-31 | 证据包统计 | 原始 11 files（README/report/ENV/SHA/7 PNG）；仓库只收 md/env/hash/7 PNG，不含 tar/logs/HOME | `docs/phase10/evidence/` | 按真实 find 清单，不用错误“10 个” |
| 2026-10-31 | C-wallet 历史 1a8a | 41 模块测试；未 UI/真实资金 | PR #23 | 历史；当前 9393b12c |
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
