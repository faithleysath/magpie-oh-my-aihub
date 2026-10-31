# Phase 10 A — 首页「可用模型」真实证据（modelsEvidence UI 小单元）

> 状态标签：**VERIFIED** = 本轮读源码/跑测试确认；**REPRODUCED** = 本轮在浏览器里实际看到（标注是 fixture）；**UNKNOWN** = 未覆盖。
> 分支：`feature/phase10-a-model-evidence-ui`，**显式 base = 已批准的 PR25 head `b1a4838d4707c4b8885a3a7902a26dfb0f33bd82`**（`feature/phase10-a-console`，冻结不改）。
> 后端契约来源：A-service PR #36（`3d8a6ac894ecb9988d089409435b2905d901a9bb`，base `56d05f7`，未合并）；字段与 A-service handoff §9 最终确认。
> 本分支只改 renderer + 一处只读动作的刷新 + 测试 + fixture 预览；不扩 C 钱包、不改后端、不加假 models。测试中的后端均为模拟。

---

## 0. 结论

**VERIFIED**：首页「可用模型」不再读 `provider.models`、也不再数授权/目录清单。它只认 `status.providers[].modelsEvidence` 中 `status==="current" && callable==="yes" && Number.isFinite(modelCount)` 且未过期的记录；`stale`/`unknown`/过期显示未知与下一步，`modelCount` 为 null 不显示 0。

**VERIFIED（语义边界）**：`callable:"yes"` 只证明当前 Key 成功读到了远端 `/v1/models` 清单，**不代表推理可用或额度充足**。因此首页计数文案是「N 个当前可见模型」，详情明确“推理额度与 429 另计，不代表可调用”；`limit.spent` / `costLeft<=0` / 429 仍用既有 `provider.limit` 单独显示“额度已用尽（原生 429）”，不会被清单的 current 覆盖，也不会把 paused/revoked 洗成可用。

**REPRODUCED（fixture）**：current → 首页显示「2 个当前可见模型」，展开可见 `qwen/qwen3-32b`、`deepseek/deepseek-chat`，每行带读回来源/时间与“额度上限 $2.5000 · 已用 $0.4200 · 剩余 $2.0800”；stale → 「模型清单已过期」+“到「发现 → 我的连接」重新读取可用模型；过期清单不算可用。”，列表入口隐藏。

**UNKNOWN**：真实 Magpie 0.1.2289 的读回、真实 `provider-models`/`provider-check` 响应、TTL 失效后的实际表现。PR #36 未合并，本分支没有接真实后端。

---

## 1. 消费的字段（最终，A-service PR #36）

```ts
status.providers[].modelsEvidence = {
  status: "current" | "stale" | "unknown";
  source: "connect-readback" | "provider-models" | "reconcile";
  readAt: string | null;
  expiresAt: string | null;      // TTL 5 分钟，后端写
  models: string[];
  modelCount: number | null;     // current 时严格等于 models.length
  callable: "yes" | "no" | "unknown"; // current ⇒ yes
  identity: { hostname: string | null; virtualIpv4: string | null; fingerprint: string | null } | null;
  generation: number;
  keyRef: string;                // provider-keys.json#<id> 这类不透明引用，不含 Key
  keyGeneration: number;
  error: string | null;
};
```

响应形状（已确认）：

- `provider-models` → 扁平 `{ id, models, status, detail, limit, modelsEvidence }`（不包 provider），**不返回完整 state**；UI 成功后主动 refresh 一次 `/ui/api/state`。
- `provider-check` → `{ provider, semantics }`，evidence 在 `result.provider.modelsEvidence`；同样 refresh。
- 没有新增动作。

---

## 2. 判定规则（`providers.js:modelEvidenceSummary`）

1. 只取 `status.providers[]`；无 provider → `none`。
2. 可用计数 = 满足以下**全部**条件的 provider 的 `modelCount` 之和：
   - `modelsEvidence.status === "current"`
   - `modelsEvidence.callable === "yes"`
   - `modelCount` 是有限非负数
   - 未过期：`expiresAt` 存在且 `Date.parse(expiresAt) > now`（页面长时间停留的兜底；后端仍拥有 freshness 定义）
3. 有可用 → `current`，标题「N 个当前可见模型」，详情「M 个伙伴服务 · 最近真实读回；推理额度与 429 另计，不代表可调用」，可展开列表；额度状态单独标注（正常/已用尽/待确认）。`modelCount === 0` 时为 `empty`：「已连接，但没有发现模型」+ 核对模型范围与额度。
4. 有证据但 `callable === "no"`（401/撤销）→ `denied`：「授权未通过」+ 核验密钥与额度，不用 0 代替；若同时 stale 则显示过期。
5. 无可用但存在 `stale` 或已过期 → 「模型清单已过期」+ 下一步“到「发现 → 我的连接」重新读取可用模型；过期清单不算可用。”
6. 其余 → 「尚未确认」+ 下一步“到「发现 → 我的连接」读取可用模型；读取前不会计入可用数。”
7. **明确忽略**：legacy `provider.models`（老快照只作兼容）、`status.catalog.peers[].quote.models`（目录）、`status.consumers[].models`（授权白名单）、`share.models`。它们都不代表可调用。
8. **额度独立**：`provider.limit.spent === true` 或 `costLeft <= 0` → “额度已用尽（原生 429）”；未读到 `costLimit` → “额度待确认（未读取原生限额）”；有额度 → 上限/已用/剩余。模型可见数与推理额度永远分开展示，不合并成“可用”结论。

`modelCount` 与 `models.length` 不一致时以 `modelCount` 计数；列表只展示真实返回的 `models`，为空且有计数时提示“服务报告有可用模型，但没有返回清单；以计数为准”。

---

## 3. UI 改动

| 位置 | 改动 |
| --- | --- |
| 首页「可用模型」 | 计数/文案来自 `modelEvidenceSummary`；新增折叠「查看可用模型」列出每个伙伴的真实读回清单、来源与读回时间；`stale/unknown` 时隐藏列表并给下一步 |
| `plugin/console/providers.js` | 新增导出 `modelEvidenceSummary(providers, now)`；删除 `provider.models` 死分支引用；`provider-models` 成功后恢复 refresh（原为 `refresh:false`） |
| 我的连接 →「读取可用模型」 | 仍读扁平 `result.models`（兼容旧形状）；若返回的 `modelsEvidence.status !== "current"` 显示“只作诊断，首页不会把它计为可用”，并显示读回时间 |
| `index.html` / `style.css` | 首页折叠列表容器与行样式（单层，不进卡片套卡片） |

未改：钱包、网络、分享、CSP、动作白名单、任何后端文件。

---

## 4. 测试（模拟后端，明确标注）

```bash
cd plugin
bun test ./console     # 83 pass / 0 fail / 632 assertions
bun run typecheck      # clean
bun run secret-scan    # PASS
```

新增/更新的行为断言：

- `providers.test.js`（6 个新用例，全是数据/交互行为，不是源码字符串）：
  - current + callable yes + 有限 count → 计数与列表；
  - legacy `provider.models` 存在但无 evidence → `unknown`、0；evidence 非 current / callable 非 yes / count null 同样不计；
  - stale → 「模型清单已过期」+ 下一步文案；
  - 一个 stale + 一个 current → 只计 current；
  - 页面停留超过 `expiresAt` → 自动转为 stale；
  - current + `limit.spent` / `costLeft<=0` → 仍显示清单数，但额度行明确“额度已用尽（原生 429）”；未读额度 → “额度待确认”；
  - current 但 `modelCount === 0` → “已连接，但没有发现模型”；`callable:"no"`（401/撤销）→ “授权未通过”，不用 0；
  - 换 Key（`keyGeneration` 变化）→ `stale` 不计，只有新的 current 读回才重新计数；
  - 点击「读取可用模型」→ 只发 `provider-models`、触发一次 refresh、弹窗显示真实清单；非 current 证据显示“只作诊断”。
- `app.test.js`：mock DOM + mock HTTP 驱动真实 `app.js`；首页断言显示「2 个可用模型」、列表含 `qwen/qwen3-32b`/`deepseek/deepseek-chat`，且**不包含** legacy `legacy/not-callable` 与目录 `authorized/but-not-called`。
- `shell.test.js`：首页不再引用 `provider.models` / `Array.isArray(provider?.models)`，改为 `modelEvidenceSummary`。

**这些测试的后端是模拟状态**，不代表真实 Magpie 读回已通过。

---

## 5. 截图（fixture）

`docs/phase10-a-model-evidence-ui/`：

- `current-1440-light.png`：展开的可用模型列表（来源 `provider-models`、读回时间）；
- `stale-1440-light.png`：过期态与下一步；
- `current-390-light.png`：窄屏展开列表。

复现：`bun run plugin/scripts/console-preview.ts --scenario configured --port 61392` / `--scenario stale --port 61393`（预览服务器是开发夹具，合成数据，不是真实节点）。

---

## 6. 未覆盖（UNKNOWN）

- 真实 A-service PR #36 未合并，本分支未接真实 `modelsEvidence`；字段按最终契约实现，但真实响应/状态迁移未验。
- 真实 Magpie 0.1.2289 + EasyTier 2.6.4 的零费用模型读回、TTL 过期、换 Key/身份变化后的 `stale` 表现未验。
- `provider-models` 失败返回 400/500 时的真实文案与 evidence 迁移未验（UI 不自动重试）。
- WebKit/真机未测。

**不宣称 Visual/功能 GO**：这是 UI 单元，等后端 PR #36 合并与真实回读验收后再谈。
