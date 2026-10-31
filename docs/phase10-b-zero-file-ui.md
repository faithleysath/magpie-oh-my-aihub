# Phase 10 B — 无文件发现 / 审批 / 连接 UI 小单元

> 状态标签：**VERIFIED** = 本轮读源码/跑测试确认；**REPRODUCED** = 浏览器 fixture 实际看到；**UNKNOWN** = 未覆盖。
> 分支：`feature/phase10-b-zero-file-ui`，从 **approved PR25 `b1a4838d4707c4b8885a3a7902a26dfb0f33bd82`** 独立开出（未改冻结 25；37 的 evidence 改动不在本分支）。
> 契约：B-service assembly **draft v0** `/tmp/oma-research/B-ASSEMBLY-ACTION-CONTRACT.md`（动作名/字段在 assembly fixed head 前可能变）。本分支只做 UI + mock 契约测试，**未接真实后端**。
> 范围：发现 / 共享审批 / 连接状态；**不含钱包页**（钱包由另一代理负责），不新增导航页，不改后端。

---

## 0. 结论

**VERIFIED**：普通路径已是零文件——发现页「申请使用（无文件）」→ `p2p-request`；共享页收到请求后一次「核对并批准」→ `p2p-approve`；消费者连接状态由 `status.p2p.outboundRequests/connections` 自动投影。主路径没有 JSON 下载/导入、没有手工 Key、没有内部 ID/CLI/端口输入。

**VERIFIED**：旧文件流程保留但收进「高级应急」折叠区（发现页旧请求/连接、共享页申请文件导入、连接页授权导入），默认折叠，不在主路径。

**REPRODUCED（fixture，合成数据）**：共享页顶部直接显示待批准请求与网络授权/交付；批准弹窗显示**完整**身份指纹、TOFU 提示、当前报价模型、正额度、显式确认；「我的连接」显示控制通道与已连接/已注册状态；网络诊断显示只读 P2P 控制通道。

**UNKNOWN**：assembly 后端尚未落地（B-service 报告当前阻塞于 consumer 控制端点发现与反向交付），真实 `status.p2p` 字段、动作响应、真实 Magpie/EasyTier 端到端均未验。动作/字段以最终契约和真实实现为准，本分支不宣称 E2E/GO。

---

## 1. 消费的契约

### 动作（B assembly draft）

| 动作 | 触发 | 请求 |
| --- | --- | --- |
| `p2p-request` | 发现页伙伴卡「申请使用（无文件）」→ 选模型 + 核对身份 → 发送 | `{ nodeId, fingerprint, quoteHash, models }` |
| `p2p-approve` | 共享页「核对并批准」→ 选模型 + 正额度 + 身份确认 | `{ requestId, models, capUsd, acceptFingerprint? }`（TOFU 未接受时必须带完整指纹） |
| `p2p-reject` | 共享页「拒绝」 | `{ requestId, note? }` |
| `p2p-revoke` | 共享页「撤销此授权」（确认） | `{ approvalId }` |
| `p2p-recover` | 授权/连接 `uncertain` 或 `action-needed` 的技术详情 | `{ approvalId? }` |

未使用 `p2p-refresh`（可选）；轮询 `GET /ui/api/state` 即可。

### 状态（`status.p2p`）

`listener`、`inboundRequests`、`outboundRequests`、`approvals`、`connections`、`counts`。`null` 一律显示未知，不当 0；`keyId`/`providerId` 只在折叠技术详情里作为不透明引用，不展示 secret。

---

## 2. 页面与交互

### 发现
- 伙伴卡主操作改为「申请使用（无文件）」；弹窗先显示**完整身份指纹**（`<code>` 直接可见）、报价指纹、价格版本，再选模型，勾选确认后**一次**发送。
- 旧「选择模型并生成文件 / 已有密钥连接」收进卡内「高级应急：旧版文件流程」。
- 身份未接受/变化时仍需先「核对并接受身份」（TOFU），不跳过。

### 我的共享
- 顶部「来自网络的使用请求」：显示伙伴、模型数、建议额度、到期、TOFU 状态；完整指纹/报价在详情；`pending`/`waiting-tofu` 才能批准/拒绝。
- 批准弹窗：完整指纹直接可见 + TOFU 警告；模型只列**请求的且当前报价存在**的模型（缺价格禁用）；正额度必填；TOFU 未接受时额外勾选“我核对并接受此完整身份指纹”，与业务确认**同一个**提交，不出现第二步密钥交付。
- 「网络授权与交付」：显示模型/额度/交付状态（已交付/结果未知等）；`uncertain`/`action-needed` 显示“不会自动重发或创建第二个密钥”并提供「技术恢复（只读优先）」；撤销走确认。
- 旧申请文件导入收进「高级应急：旧版申请文件」。

### 我的连接（发现页 tab）
- 「无文件连接状态」：控制通道（state/host/port/reachability/verified，诚实标 LAN vs overlay）、已发出的申请、ACK 回读（已注册模型/额度）、连接状态（connected/registering/action-needed/disconnected/revoked）。
- `action-needed` 只提供技术恢复，不自动重试；`connected` 不是新授权。
- 旧「导入伙伴授权」收进「高级应急」。

### 首页
- 待办加入 `status.p2p.counts`：待批准请求 → 共享；等待批准 / 需要处理 → 发现→我的连接（自动切到该 tab，不新增页面）；控制通道失败 → 网络。

### 网络 → 诊断
- 新增只读「P2P 控制通道」：状态/地址/可达范围/说明，`aria-readonly`，无编辑入口。

---

## 3. 安全与失败语义

- 不显示/复制 Key，不提供 JSON 下载或导入作为主路径；旧文件仅高级应急。
- 完整指纹 64 hex 在批准/申请弹窗中**直接可见**，不做缩短；TOFU 未接受时业务动作被阻止。
- 写动作只在用户明确确认时发送一次；404 只显示错误，不回退旧文件动作；400/409/429/500 不自动重试。
- `p2p-recover` 只在技术详情里显式触发，有界、只读优先。
- 状态字段缺失时显示“未读取/未提供”，不把未知当 0；额度仍是正数校验，0 不作为暂停。

---

## 4. 测试（mock 契约，非真实后端）

```bash
cd plugin
bun test ./console     # 80 pass / 0 fail / 598 assertions
bun run typecheck      # clean
bun run secret-scan    # PASS
```

新增行为用例（`providers.test.js`，mock DOM + mock action 序列）：

- 首次请求批准：只发一次 `p2p-approve`，输入含 `requestId`、选中模型、正额度、`acceptFingerprint`（完整 64 hex）。
- 已接受身份：不重复发送指纹。
- 拒绝：只发 `p2p-reject`。
- 发现页申请：只发一次 `p2p-request`，带 `nodeId`/`fingerprint`/`quoteHash`/模型。
- `uncertain` 授权：显示“不会自动重发/第二密钥”，技术恢复只发 `p2p-recover {approvalId}`，撤销只发 `p2p-revoke`。
- 出站 connected + ACK 回读：显示已注册模型/额度，不出现 Gateway Key。
- `p2p-approve` 返回 404：只发一次，不回退旧文件动作。

`app.test.js` 另断言首页 `status.p2p.counts` 待办与“发现 → 我的连接”tab 路由。

---

## 5. 截图（fixture，合成数据）

`docs/phase10-b-zero-file-ui/`：`sharing-requests-1440-light.png`、`approve-dialog-1440-light.png`、`connections-1440-light.png`、`sharing-requests-390-light.png`。
复现：`bun run plugin/scripts/console-preview.ts --scenario configured --port 61395`（fixture 内 `status.p2p` 为合成数据）。

---

## 6. 未覆盖（UNKNOWN）

- B assembly 后端尚未落地：当前阻塞于 consumer 控制端点发现与交付路径；`status.p2p` 字段、动作响应、错误码可能随最终契约调整。
- 真实 Magpie 0.1.2289 + EasyTier 2.6.4 的两节点申请/批准/加密交付/注册回读/撤销，未验。
- 真实身份变化、离线恢复、ACK 丢失、跨主机 NAT/中继场景，未验。
- 旧文件应急路径未在本分支重新验证；不改其既有行为。
- WebKit/真机未测。

**不宣称 B GO / 真实 E2E**；本分支是 UI 单元，供契约稳定后与 assembly 配对。
