# Phase 10 B — 无文件发现 / 审批 / 连接 UI 小单元

> 状态标签：**VERIFIED** = 读源码/跑测试确认；**REPRODUCED** = 浏览器 fixture 实际看到；**UNKNOWN** = 未覆盖。
> 分支：`feature/phase10-b-zero-file-ui`，从 **approved PR25 `b1a4838`** 独立开出（未改冻结 25/37/42）。
> 契约：B assembly 最终接口 `/tmp/oma-research/B-ASSEMBLY-ACTION-CONTRACT.md`；后端实际代码：PR #40 `3ddf583` + PR #45 overlay `37bde2f5e85f1b2ed1f24ffc408246af4b85f665`（均 draft/未合并）。
> 本分支只做 UI + mock 契约测试，**未接线真实后端**；不宣称 E2E/GO。

---

## 0. 结论

**VERIFIED**：普通路径已是零文件——发现页「申请使用（无文件）」→ `p2p-request`；共享页收到请求后一次「核对并批准」→ `p2p-approve`；消费者连接状态由 `status.p2p.outboundRequests/connections` 自动投影。主路径无 JSON 下载/导入、无手工 Key、无内部 ID/CLI/端口输入；旧文件流程仅在「高级应急」。

**VERIFIED**：首次连接/身份变化不再被“已验证才能点”锁死——签名 `valid` + endpoint 可信 + 未过期 + `control` + `providesModels` 即可进入完整指纹确认；确认必须由服务（`trust-peer`）成功后才发送 `p2p-request`；签名 `invalid`/`unknown` 永不发送。

**VERIFIED**：批准支持安全子集——选择变化会使旧预览失效，显式「预览选中报价」调用 `p2p-quote-preview`，`p2p-approve` 使用服务返回的 `priceVersion`/`quoteHash` 与完整绑定；409 只显示一次并要求人工重新预览，不自动重试，前端不算哈希。

**REPRODUCED（fixture，合成）**：共享页顶部待批准请求；批准弹窗显示完整指纹、TOFU 提示、模型子集、选中报价预览（价格 + 技术绑定）、正额度、一次确认；「我的连接」显示控制通道/申请/ACK/连接状态；网络诊断显示只读 P2P 控制通道。

**UNKNOWN**：真实 HTTP 两节点 + FakeMagpie Service 完整旅程、EasyTier no-TUN overlay 传输、未分享 provider presence 发现、真实 Magpie 读回；本分支不宣称 E2E/GO。

---

## 1. 契约字段

### 动作

| 动作 | 触发 | 请求 |
| --- | --- | --- |
| `p2p-request` | 发现页「申请使用（无文件）」/「核对身份并申请使用」 | `{ nodeId, fingerprint, quoteHash, models }` |
| `p2p-quote-preview` | 批准弹窗「预览选中报价」（只读） | `{ requestId, models }` → `{ requestId, quoteHash, priceVersion, models, pricing }` |
| `p2p-approve` | 「确认批准」 | `{ requestId, consumerFingerprint, quoteHash, priceVersion, generation, models, capUsd, acceptFingerprint? }` |
| `p2p-reject` | 「拒绝」 | `{ requestId, note? }` |
| `p2p-revoke` | 「撤销此授权」（确认） | `{ approvalId }` |
| `p2p-recover` | 授权/连接 `uncertain`/`action-needed` 技术详情 | `{ approvalId? }`（有界续传/对账，不是纯只读） |

`p2p-refresh` 已省略：后台有界 pull/poll 更新 `status.p2p`，UI 只轮询只读 state。

### 状态

`status.p2p`：`listener`、`presence[]`、`inboundRequests[]`、`outboundRequests[]`、`approvals[]`、`connections[]`、`counts`。

- `presence[]` 是独立签名文档：`signature:"valid"`、`tofu:"accepted"|"pending"|"changed"|"unknown"`、`verified`（签名/时间有效）、`endpoint`、`capability`、`expiresAt`。**签名有效 ≠ TOFU accepted**。
- `inboundRequests[].generation` 是当前 approval generation（首次 `null`），批准时原样回传。
- `null` 一律显示未知，不当 0；`keyId`/`providerId` 只在折叠技术详情里作为不透明引用，不展示 secret。

---

## 2. 交互

### 发现
- 可进入条件：presence 存在、`signature === "valid"`、endpoint 有 host+合法 controlPort、未过期、`capability.control === true`、`providesModels === true`、目录在线。
- `tofu` pending/changed 不阻止进入：按钮变为「核对身份并申请使用」，弹窗显示完整 64hex 指纹，勾选“我核对并接受此完整身份指纹”后先调用 `trust-peer`；**服务确认成功后**才发 `p2p-request`。确认失败则申请不发送、可重试。
- `signature` invalid/unknown：按钮禁用，弹窗也不会发送；端口/IP 只读展示在折叠技术详情。
- 旧「生成文件 / 已有密钥连接」在「高级应急」。

### 我的共享
- 顶部「来自网络的使用请求」：伙伴、模型数、建议额度、到期、TOFU 状态；完整指纹/报价在详情；`pending`/`waiting-tofu` 才能批准/拒绝。
- 批准弹窗（单层，无第二层弹窗）：
  - 完整指纹直接可见 + TOFU 警告；
  - 模型子集复选框（默认全部请求模型；只列当前报价里存在的请求模型）；
  - 选择变化 → 旧预览失效、批准禁用；
  - 「预览选中报价」→ `p2p-quote-preview`，显示每个模型当前价格 + 折叠的技术绑定（选中 `priceVersion`、`quoteHash`、模型数）；
  - 正额度必填；TOFU pending/changed 额外勾选身份接受，与业务确认同一个提交；
  - 批准只发一次 `p2p-approve`，`quoteHash/priceVersion/models` 取预览返回值，`generation` 取请求行。
- 预览 409 → “报价已变化，请重新预览”，批准禁用；批准 409 → 显示一次、旧预览失效，需要人工重新预览再决定。
- 「网络授权与交付」：交付状态；`uncertain`/`action-needed` 显示“不会自动重发或创建第二个密钥”，只给有界「技术恢复（有界续传/对账）」；撤销走确认。
- 旧申请文件导入在「高级应急」。

### 我的连接（发现页 tab）
- 控制通道（state/host/port/reachability/verified，LAN 与 overlay 诚实区分）、出站申请、ACK 回读（已注册模型/额度）、连接状态；`action-needed` 不自动重试。
- 旧「导入伙伴授权」在「高级应急」。

### 首页 / 网络诊断
- 首页 `status.p2p.counts` 待办，等待批准/需要处理直达 发现→我的连接（不新增页面）。
- 网络 → 诊断新增只读「P2P 控制通道」。

---

## 3. 安全与失败语义

- 不显示/复制 Key，不提供 JSON 下载或导入作为主路径；旧文件仅高级应急。
- 完整指纹 64 hex 在申请/批准弹窗直接可见；TOFU pending/changed 必须人工确认且由服务先接受。
- 批准始终回传 `requestId/consumerFingerprint/quoteHash/priceVersion/generation/models/capUsd`；`acceptFingerprint` 只在 TOFU pending/changed 时作为人工接受标记。
- 写动作只在用户明确确认时发送一次；400/403/404/409/429/500 不自动重试；404 不回退旧文件动作。
- `p2p-recover` 只在技术详情显式触发：有界续传/读取对账，可同代次重发已封装交付；不会重新批准、不改额度、不建第二密钥、不付款、不自动接受新报价。文案不写“只读”。
- 未知/缺失显示未知，不显示 0；额度仍是正数校验，0 不作为暂停。

---

## 4. 测试

```bash
cd plugin
bun test ./console     # 92 pass / 0 fail / 636 assertions
bun run typecheck      # clean
bun run secret-scan    # PASS
```

新增行为用例（mock DOM + mock action 序列，非真实后端）：

- 首信任：valid signature + tofu pending → 入口可用；确认后调用序列 `trust-peer` → `p2p-request`；`trust-peer` 失败则不发送申请。
- 身份变化：tofu changed → 必须重新确认，序列同上。
- 已接受：tofu accepted → 只发 `p2p-request`。
- 签名 invalid/unknown：入口禁用、强制点击也不发送。
- 子集预览：默认全部请求模型并自动预览一次；取消一个模型后旧预览失效、批准禁用；重新预览只带子集；批准回传预览的 `priceVersion/quoteHash` 与子集模型及完整绑定。
- 预览 409：显示“报价已变化”，批准禁用、无 approve 调用。
- 批准 409：只发一次，旧预览失效，再次点击仍不会重发（需重新预览）。
- presence 缺失/过期/仅控制能力：禁用并给出准确原因。
- 400/500：只显示一次、不重试；404 不回退旧文件动作。
- 批准弹窗默认全选、TOFU accepted 不重复勾选指纹但仍发绑定字段。

`app.test.js` 断言首页 `status.p2p.counts` 待办与“发现 → 我的连接”tab 路由。

---

## 5. 截图（fixture，合成数据）

`docs/phase10-b-zero-file-ui/`：

- `sharing-requests-1440-light.png`：共享页请求/授权；
- `approve-all-1440-light.png`：批准弹窗默认全部模型 + 预览；
- `approve-subset-preview-1440-light.png`：取消一个模型后重新预览的子集；
- `connections-1440-light.png`：我的连接；
- `sharing-requests-390-light.png`：窄屏。

复现：`bun run plugin/scripts/console-preview.ts --scenario configured --port 61392`（fixture 内 `status.p2p` 为合成数据，含 `signature/tofu` 与预览 mock）。

---

## 6. 未覆盖（UNKNOWN）

- 真实 HTTP 两节点 + FakeMagpie Service 完整旅程（request → approve → poll → Remote readback → ACK → revoke/restart/identity/price）未跑。
- EasyTier 2.6.4 no-TUN overlay、控制端口 ACL/Forward 发布、未分享 provider 的 presence 发现未验。
- 真实 Magpie/remote 401、真实身份变化与额度组合未验；无 B GO/资金。
- 旧文件应急路径未在本分支重新验证；WebKit/真机未测。
