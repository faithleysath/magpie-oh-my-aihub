# Phase 10 B — 无文件发现 / 审批 / 连接 UI 小单元

> 状态标签：**VERIFIED** = 本轮读源码/跑测试确认；**REPRODUCED** = 浏览器 fixture 实际看到；**UNKNOWN** = 未覆盖。
> 分支：`feature/phase10-b-zero-file-ui`，从 **approved PR25 `b1a4838d4707c4b8885a3a7902a26dfb0f33bd82`** 独立开出（未改冻结 25；37 的 evidence 改动不在本分支）。
> 契约：B-service assembly **最终接口** `/tmp/oma-research/B-ASSEMBLY-ACTION-CONTRACT.md`；后端实际代码 target `3ddf583e6fba43b731d3bf34c1c028cca8c231f0`（PR #40，draft，未合并）。本分支只做 UI + mock 契约测试，**未接线真实后端**。
> 范围：发现 / 共享审批 / 连接状态；**不含钱包页**（钱包由另一代理负责），不新增导航页，不改后端。

---

## 0. 结论

**VERIFIED**：普通路径已是零文件——发现页「申请使用（无文件）」→ `p2p-request`；共享页收到请求后一次「核对并批准」→ `p2p-approve`；消费者连接状态由 `status.p2p.outboundRequests/connections` 自动投影。主路径没有 JSON 下载/导入、没有手工 Key、没有内部 ID/CLI/端口输入。

**VERIFIED**：旧文件流程保留但收进「高级应急」折叠区（发现页旧请求/连接、共享页申请文件导入、连接页授权导入），默认折叠，不在主路径。

**REPRODUCED（fixture，合成数据）**：共享页顶部直接显示待批准请求与网络授权/交付；批准弹窗显示**完整**身份指纹、TOFU 提示、当前报价模型、正额度、显式确认；「我的连接」显示控制通道与已连接/已注册状态；网络诊断显示只读 P2P 控制通道。

**UNKNOWN**：UI 已按最终字段适配，但真实 HTTP 两节点 + FakeMagpie Service 完整旅程、EasyTier no-TUN overlay 路径、真实 Magpie 读回均未验；本分支不宣称 E2E/GO。

---

## 1. 消费的契约

### 动作（B assembly draft）

| 动作 | 触发 | 请求 |
| --- | --- | --- |
| `p2p-request` | 发现页伙伴卡「申请使用（无文件）」→ 选模型 + 核对身份 → 发送 | `{ nodeId, fingerprint, quoteHash, models }` |
| `p2p-approve` | 共享页「核对并批准」→ 核对绑定 + 正额度 | `{ requestId, consumerFingerprint, quoteHash, priceVersion, generation, models, capUsd, acceptFingerprint? }`（始终绑定；`acceptFingerprint` 仅 TOFU 未接受时作为人工接受标记） |
| `p2p-reject` | 共享页「拒绝」 | `{ requestId, note? }` |
| `p2p-revoke` | 共享页「撤销此授权」（确认） | `{ approvalId }` |
| `p2p-recover` | 授权/连接 `uncertain` 或 `action-needed` 的技术详情 | `{ approvalId? }`（有界续传/对账，不是纯只读） |

`p2p-refresh` 已由后端省略：后台有界 consumer pull/poll 更新 `status.p2p`，UI 只轮询只读 state。

### 状态（`status.p2p`）

`listener`、`presence[]`、`inboundRequests[]`、`outboundRequests[]`、`approvals[]`、`connections[]`、`counts`。`presence` 是独立签名文档（node/fingerprint/endpoint/capability/expiry），不含模型或 Key。`null` 一律显示未知，不当 0；`keyId`/`providerId` 只在折叠技术详情里作为不透明引用，不展示 secret。

---

## 2. 页面与交互

### 发现
- 只有同时满足「目录身份已接受/在线」+「`status.p2p.presence` 里 `verified:true`、未过期、`capability.control:true`、`providesModels:true`」的伙伴才启用「申请使用（无文件）」；缺 presence / presence 过期 / 仅控制能力时按钮禁用并说明原因（“可请求，但不提供模型”等）。
- 弹窗先显示**完整身份指纹**（`<code>` 直接可见）、报价指纹、价格版本，再选模型，勾选确认后**一次** `p2p-request`。
- presence 的控制端点/能力/到期只在折叠「控制通道与能力（只读）」里显示；UI 不让用户输入 IP/端口。
- 旧「选择模型并生成文件 / 已有密钥连接」收进卡内「高级应急：旧版文件流程」。
- 身份未接受/变化时仍需先「核对并接受身份」（TOFU），不跳过。

### 我的共享
- 顶部「来自网络的使用请求」：显示伙伴、模型数、建议额度、到期、TOFU 状态；完整指纹/报价在详情；`pending`/`waiting-tofu` 才能批准/拒绝。
- 批准弹窗：完整指纹直接可见 + TOFU 警告；展示请求的模型与当前报价（缺模型则禁止批准）；正额度必填；TOFU 未接受时额外勾选“我核对并接受此完整身份指纹”，与业务确认**同一个**提交，不出现第二步密钥交付。
- **本次不提供子集选择**：客户端无法计算“选中子集”的 `priceVersion`，所以批准恰好等于请求的模型集合，使用请求行的 `priceVersion`；后端仍按当前报价重算并拒绝 stale。需要子集批准时，等后端在同一响应返回 selected version 后再做，不猜哈希。
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
- 批准**始终**回传 `requestId / consumerFingerprint / quoteHash / priceVersion / generation / models / capUsd`；`acceptFingerprint` 只在 TOFU pending/changed 时附带，不能替代其它绑定。
- 写动作只在用户明确确认时发送一次；404 只显示错误，不回退旧文件动作；400/409/429/500 不自动重试。**当前后端传输尚未稳定映射 409/404 code，可能返回 400/500 文本；UI 一律“显示一次、不重试、不回退”，不依赖 409 分支**（等后端补稳定 code）。
- `p2p-recover` 只在技术详情里显式触发：有界续传/读取对账，可同代次重发已封装交付；**不会重新批准、不改额度、不建第二个密钥、不付款、不自动接受新报价**。文案不写“只读”。
- 状态字段缺失时显示“未读取/未提供”，不把未知当 0；额度仍是正数校验，0 不作为暂停。

---

## 4. 测试（mock 契约，非真实后端）

```bash
cd plugin
bun test ./console     # 85 pass / 0 fail / 615 assertions
bun run typecheck      # clean
bun run secret-scan    # PASS
```

新增行为用例（`providers.test.js`，mock DOM + mock action 序列）：

- 首次请求批准：只发一次 `p2p-approve`，输入含 `requestId`、`consumerFingerprint`、`quoteHash`、`priceVersion`、`generation:null`、模型、正额度与 `acceptFingerprint`（完整 64 hex）。
- 已接受身份：不再带 `acceptFingerprint`，但**仍发送全部绑定字段**。
- 再次批准：`generation` 取请求行当前值（非 null）。
- presence 缺失/过期/仅控制能力：无文件按钮禁用并给出准确原因。
- 409/400/500：均只显示一次、不重试。
- 拒绝：只发 `p2p-reject`。
- 发现页申请：只发一次 `p2p-request`，带 `nodeId`/`fingerprint`/`quoteHash`/模型。
- `uncertain` 授权：显示“不会自动重发/第二密钥”，技术恢复只发 `p2p-recover {approvalId}`，撤销只发 `p2p-revoke`。
- 出站 connected + ACK 回读：显示已注册模型/额度，不出现 Gateway Key。
- `p2p-approve` 返回 404：只发一次，不回退旧文件动作。

`app.test.js` 另断言首页 `status.p2p.counts` 待办与“发现 → 我的连接”tab 路由。

测试总数：**85 pass / 0 fail / 615 断言**。

---

## 5. 截图（fixture，合成数据）

`docs/phase10-b-zero-file-ui/`：`sharing-requests-1440-light.png`、`approve-dialog-1440-light.png`、`connections-1440-light.png`、`sharing-requests-390-light.png`。
复现：`bun run plugin/scripts/console-preview.ts --scenario configured --port 61395`（fixture 内 `status.p2p` 为合成数据）。

---

## 6. 未覆盖（UNKNOWN）

- 后端代码已落（PR #40 `3ddf583`），但真实 HTTP 两节点 + FakeMagpie Service 完整旅程、EasyTier no-TUN overlay 传输、未分享 provider 的 presence 发现未验。
- 真实 Magpie 0.1.2289 + EasyTier 2.6.4 的两节点申请/批准/加密交付/注册回读/撤销，未验；stable 409/404 code 尚未在 console 传输映射。
- 真实身份变化、离线恢复、ACK 丢失、跨主机 NAT/中继场景，未验。
- 旧文件应急路径未在本分支重新验证；不改其既有行为。
- WebKit/真机未测。

**不宣称 B GO / 真实 E2E**；本分支是 UI 单元，供契约稳定后与 assembly 配对。
