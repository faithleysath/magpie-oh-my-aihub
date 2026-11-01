# 开发文档：Agent 原生版（v2）

**状态**：产品决策已锁定，尚未实现。本文替代 `docs/ARCHITECTURE.md` 中的产品决策部分。
**决策日期**：2026-11-01。
**替代关系**：旧版（浏览器控制台 + CLI + P2P + 存款意图/付款 journal）的文档已删除；`ARCHITECTURE.md` 保留在 `docs/history/ARCHITECTURE-pre-v2.md`，**只作为历史证据阅读**。用户手册是插件页 `plugin/page/doc.md`。
**当前代码状态**：工作树仍是旧实现，约 48,000 行 TypeScript + 6,461 行浏览器前端 + 2,124 行 CLI。按第 11 节的清单大部分要删除。

读法：先读第 1–6 节（产品与钱），再看第 7–8 节（对外接口），动手前看第 11–13 节（复用、删除、实施顺序）。

**环境与版本（接手时先核对这些）**

| 项 | 值 |
|---|---|
| 仓库 | `/Users/laysath/Projects/magpie-oh-my-aihub-import` |
| 插件安装 spec | `github:faithleysath/magpie-oh-my-aihub` |
| Magpie 源码 checkout | `~/Projects/lab/magpie-upstream`（`git fetch --tags` 后可看 `v0.1.2171` / `v0.1.2516` / `v0.1.2606`） |
| 已实测 Magpie | 0.1.2171（GUI/配对/原生 Remote Magpie）、0.1.2516（成本与 token 上限、生产付款） |
| EasyTier | 2.6.4，commit `8428a89d2dabc94c97d370ec607c6ca142473626` |
| Bun | 1.4.3（开发与类型检查） |

---

## 1. 产品定义

一个 **Magpie 插件的纯后端**：让同一个 EasyTier 私有覆盖网里的几台 Magpie，互相把对方的**原生模型**当作 Remote Magpie 来用，用链上 USDC 预付结算。

- 插件不做 AI 网关，不转发、不计 token、不做第二套计费。AI 请求始终是「你的应用 → 你的 Magpie → EasyTier → 伙伴的 Magpie」。
- 插件不提供任何图形界面、不开本机 HTTP 控制台、不提供 CLI。**唯一交互方式是 Magpie 暴露给 agent 的 MCP 工具**。
- Magpie 里只加一页文档（Markdown 渲染后的静态页），教用户怎么把自己的 agent 接上这些工具。
- 节点身份是内置钱包地址。钱包由插件生成，也可以从文件导入/导出；**私钥永远不出现在工具返回值里**。
- 信任边界完全交给 EasyTier 网络密码。覆盖网内传输明文，不做二次加密、不做 TOFU、不做证书、不做配对。

明确不是：模型市场、代币、撮合、托管、跨链、法币通道、公网服务、多租户 SaaS。

---

## 2. 锁定决策

| # | 决策 | 一句话理由 |
|---|---|---|
| D1 | 砍掉浏览器控制台、本机回环 API、CLI；只留后端 + MCP 工具 | 用户用 agent 操作，界面是负担 |
| D2 | Magpie 里加一页 Markdown 文档（渲染为静态 HTML） | 教用户接 agent，而不是当控制台 |
| D3 | 内置钱包；生成 / 文件导入 / 文件导出；私钥不进 agent，地址可以给 | 地址要给用户去交易所提币 |
| D4 | 覆盖网内明文 HTTP，不做 E2E | EasyTier 本身端到端加密，网络密码就是门 |
| D5 | 只「加入」网络：网络名、密码、初始节点（可选） | 不承担组网产品的复杂度 |
| D6 | 没有「共享开关」「发布开关」「发现开关」：配好网络就自动公布模型、自动发现别人 | 开关是旧产品的历史包袱 |
| D7 | 只共享原生模型：非 `remote-magpie`、非 `group/…`、非 `auto/…`，且 Magpie 里有完整价格 | 不转售别人的通道，价格必须可算 |
| D8 | 批准只给模型范围，不给额度；额度=充值余额；申请与打钱互相独立 | 只有一个钱来源，cap 可推导 |
| D9 | 任何人往我的地址打钱都按 `from` 记账，不需要申请、不需要单据 | 熟人网络，付款是自愿行为 |
| D10 | 余额多少就能用多少；提供方不想被用就撤销 | 不需要 per-consumer 上限 |
| D11 | 付款工具一次调用即转，无二次确认，收款地址不限 | agent 原生；出金也要方便 |
| D12 | 链 RPC 内置默认值 | 没有界面配置 RPC |
| D13 | 价格变更接受按新价重算（不锁价、不暂停、不重签） | 删掉整套价格版本机制 |
| D14 | 一个节点只有一个钱包地址，即它的全部身份 | 去掉第二种身份和两套信任存储 |

D13 的后果要写清楚：Magpie 改价会重算历史用量，所以「剩余额度」会自己变。cap 不变，`used` 变，剩余跟着变。这是接受的语义，不做补偿、不做暂停。

---

## 3. 身份、信任与边界

**身份 = 钱包地址**。节点 ID、目录签名、申请签名、收款地址、账本账户键，全部是同一个 EVM 地址。

- 覆盖网地址（EasyTier 的虚拟 IP、mapped CIDR、hostname、peer_id）**不是身份**，只是路由线索。EasyTier 2.6.4 的 CLI 不暴露对端 `noise_static_pubkey`，`peer_id` 每次重启都变，所以任何"网络层身份"都不成立。身份只能来自签名。
- 谁在某个覆盖网地址上回答，只说明"那里有个节点"；它是不是它声称的地址，由它签的文档证明。冒名者签不出别人的地址，因此无法冒充收款方。
- 一个钱包被两台机器使用 = 同一个账户，余额共享。这是允许的，也是可解释的。

**信任边界**：知道网络名和密码 = 网络内的人。除此之外不设门：目录可读、申请可发、充值可打。安全靠三件事：Gateway Key（Magpie 自己拒未授权）、余额（没钱不能用）、撤销（提供方随时断）。

**隐私边界**：模型与价格在网络内公开。不发布联系方式、不发布本机路径、不发布交易以外的身份信息。

---

## 4. 功能对象

| 对象 | 键 | 说明 |
|---|---|---|
| 节点 | 钱包地址 | 一台 Magpie 一个地址 |
| 网络 | 网络名 + 密码 | 一个节点只属于一个网络 |
| 共享条目 | 地址 | 我公布的原生模型 + 价格 |
| 申请 | 消费方地址 | 我要哪些模型；每地址一条，可覆盖 |
| 授权 | 消费方地址 | 提供方批准的模型子集 + 一个 Gateway Key |
| 余额 | (提供方地址, 消费方地址) | 累计确认的 USDC |
| 连接 | 提供方地址 | 消费方 Magpie 里的一条 Remote Magpie + 本地转发口 |
| 入账 | (链, 合约, tx, logIndex) | 唯一，重复扫描不重复记账 |

---

## 5. 主流程

**入网**
1. 用户让 agent 调用 `join_network {networkName, networkSecret, initialNode?}`。
2. 插件写配置、启 EasyTier no-TUN 核心、加入覆盖网。
3. 插件用 `[[proxy_network]]` 把自己 LAN 地址映射成一个稳定的覆盖网地址（`10.66.a.b/32`，首次分配后持久化），并用 Forward ACL 固定放行 **3426**（目录 + 申请 + 轮询）和 **3425**（Magpie 网关）；改共享模型不重启核心，只改目录内容。
4. 之后不再需要任何用户动作。

**共享（提供方）**
1. `native_models` 看本机模型和价格。
2. `share_models {models:[…]}` 选定要公布的模型。
3. 目录 `GET /catalog` 立刻反映新选择，签名由节点钱包完成。
4. 不需要"发布"动作，也不需要重启核心（目录内容是内存里的签名文档）。

**发现与申请（消费方）**
1. `discover`：对覆盖网里每个非自身节点，通过本机 EasyTier SOCKS5 读 `http://<peer>:3426/catalog`，验签，得到地址、模型、价格。
2. `request_access {provider: 地址, models:[…]}`：向提供方 `POST /request`（签名）。
3. `connect_provider {provider: 地址}`：幂等轮询 `GET /request?address=…`；拿到 Key 后，在本机建立转发并注册 Remote Magpie，验证模型可读。

**批准（提供方）**
1. `consumers` 看到待批申请（地址、想要的模型、累计充值、已用、剩余）。
2. `approve_request {address, models?}`：批准或改模型。余额 > 0 时同时签发/更新 Gateway Key（cap = 累计充值）。
3. 余额为 0 时只记录批准，状态「等待充值」；第一笔入账后自动签发。
4. `revoke_consumer {address}`：删 Key，余额保留。重新批准会签发新 Key，消费方再次 `connect_provider` 取回。
5. 申请不是批准的前提：提供方可以直接批准一个已经有余额的地址（他在 `consumers.unclaimed` 里看得到）。

**付款（消费方给自己在提供方处的账户充值）**
1. `wallet` 拿到自己节点的地址。
2. 用户从交易所或自己的钱包把 USDC 提到**自己的插件钱包**（BSC 或 Base），顺手提一点原生币（BNB / ETH）当手续费。
3. `send_payment {chain, to: 提供方地址, amount}`：从自己的插件钱包转给提供方。
4. 提供方观察链，确认后按 `from`（= 消费方地址）记账，重算该地址在该提供方的 cap。
5. 消费方 `connect_provider` 或 `history` 看到余额。

不要把交易所的提币直接发到提供方地址：那笔钱的 `from` 是交易所地址，账会记在交易所名下，拿不到 Key。必须是「自己的钱包 → 提供方」。

**出金**
`send_payment {chain, to, amount}` 直接把 USDC 转到任意地址（包括交易所充值地址）。不限目标，不二次确认。

---

## 6. 钱的模型

全部金额是整数最小单位（USDC raw），显示时按链的小数位换算；**BSC USDC 18 位，Base USDC 6 位，永不混用**。

```
D(地址)     = Σ 已确认入账金额（同一付款方地址、跨 BSC/Base 求和）
cap         = floor_0.0001( D )        // Magpie 只接受 $0.0001 网格
remaining   = D − Magpie 原生 used（当前窗口）
```

实施规则：

- **cap = 累计充值**，每次入账/回滚后重算并写入 Magpie：`gateway-key limit <id> 3650d --cost <cap>`。
- **不签发 cap = 0 的 Key**：Magpie 把 `0` 当无限额。`D < $0.0001` 时不发 Key，状态「等待充值」。
- **不再有**「旧 cap + 金额」、窗口边界、价格快照、usage 导入、缺口、重签、暂停五态。
- **窗口**用 `3650d`。理论上窗口结束会让 `used` 归零、剩余回到 D；十年内不处理，接受。
- **价格变更**：不做任何动作。Magpie 重算 `used`，剩余自己变。剩余为负时 Magpie 会拒（429），Key 保留，充钱即恢复。
- **链上回滚**：入账行标记 reverted，重算 D，把 cap 调低（不删记录，不退款，不自动补偿）。
- **最终性**：沿用已实测策略 —— BSC 用 15 个确认（其 `finalized` 标签等于 `latest`，没有深度信息），Base 用 `finalized` 标签。
- **归属**：`Transfer.to = 我的地址` 且 `from = 某个地址`；`from` 就是账户。交易所提币地址会成为那个账户（它拿不到 Key，所以用不上），这是接受的。
- **对的不是账单，是链**：插件不记"应收"，只记"已收到"。谁付了谁的账，不猜、不摊派。
- **出金**记录在本地 `payouts` 表（仅用于 `history`），不影响任何余额。

---

## 7. 工具规格

工具由 Magpie 的 plugin-tools MCP server 暴露。**名字 = `<插件短名>_<工具名>`**。按 `github:faithleysath/magpie-oh-my-aihub` 安装时短名是 `magpie-oh-my-aihub`，即：

```
magpie-oh-my-aihub_status
magpie-oh-my-aihub_wallet
…
```

MCP 地址：

- 全部插件：`http://127.0.0.1:3425/mcp/magpie/tools`
- 只本插件（Magpie 0.1.2516+）：`http://127.0.0.1:3425/mcp/magpie/tools/magpie-oh-my-aihub`

**通用约定**

- 参数是 JSON Schema（可直接写原生 JSON Schema，不必引 zod）。
- 成功返回 JSON 文本；失败抛错，MCP 侧标 `isError`，错误文本格式 `E_XXX: 人话`。
- 单次调用上限 55 秒（Magpie 的 `ToolTimeout`）。长操作（首次下载 EasyTier、入网）返回 `{state:"starting"}`，由 `status` 轮询进度。
- 写操作幂等；重复调用得到同一结果。
- 工具永不返回私钥、Gateway Key 之外的其他秘密；`status` 不返回任何 Key。

错误码：`E_NO_WALLET` `E_WALLET_EXISTS` `E_PATH` `E_NO_NETWORK` `E_NETWORK_TIMEOUT` `E_PEER_OFFLINE` `E_NOT_SHARING` `E_NOT_APPROVED` `E_REVOKED` `E_BALANCE` `E_MAGPIE` `E_RPC` `E_TX_UNKNOWN` `E_INPUT`。

### 7.1 节点与钱包

| 工具 | 参数 | 返回 |
|---|---|---|
| `status` | `section?`: `network`\|`wallet`\|`sharing`\|`consuming` | 结构化快照；见下 |
| `wallet` | — | `{address, chains:[{chain:"bsc"\|"base", chainId, usdcRaw, usdcUsd, nativeRaw, gasOk}]}` |
| `wallet_import` | `path`, `force?` | `{address, changed:boolean}` |
| `wallet_export` | `path`, `overwrite?` | `{address, path}` |
| `join_network` | `networkName`, `networkSecret`, `initialNode?` | `{state:"starting"\|"online"}` |

`status.network`：`{configured, networkName, state:"offline"|"starting"|"online"|"error", step, detail, overlayIp, hostname, peers:[{hostname, ipv4, online}], publishedPorts:[3426,3425?]}`

`status.wallet`：同 `wallet`。

`status.sharing`：`{address, models:[{id, price}], catalogTs, consumers:[…]}`，其中 consumers 每项 `{address, grantedModels, requestedModels, state, depositsUsd, usedUsd, remainingUsd}`，state ∈ `pending`\|`waiting-deposit`\|`active`\|`revoked`。

`status.consuming`：`{requests:[{provider, models, state, ts}], connections:[{provider, models, remainingUsd, state, gatewayPort, localPort}]}`。

`wallet_import`：读绝对路径的 32 字节 hex 私钥，写入 0600 文件。**已有入账/消费者/连接时默认拒绝**（身份变更会让旧账目悬空），只有 `force:true` 才覆盖。返回值只有地址。

`wallet_export`：把私钥写到用户指定的绝对路径，0600；文件已存在需要 `overwrite:true`；拒绝写在插件数据目录内。**返回值只有地址和路径，不含私钥**。

`join_network`：写配置 → 启核心 → 入网。已经在线时再次调用视为改配置（会重启核心，别的连接短暂中断）。不提供"退出网络"独立工具；清空配置由卸载插件完成。

### 7.2 提供方

| 工具 | 参数 | 返回 |
|---|---|---|
| `native_models` | — | `{models:[{id, price, shareable, reason?}]}` |
| `share_models` | `models: string[]` | `{models, catalogTs}` |
| `consumers` | — | 同 `status.sharing.consumers`，外加 `unclaimed:[{address, depositsUsd}]` |
| `approve_request` | `address`, `models?` | `{address, grantedModels, state, keyIssued}` |
| `reject_request` | `address`, `note?` | `{address, state:"revoked"}` |
| `revoke_consumer` | `address` | `{address, state:"revoked", keyRemoved}` |

`share_models`：只接受第 D7 条允许的模型；空数组 = 不共享。立刻重签目录，不重启核心（ACL 已经固定放行 3426/3425）。

`approve_request`：`models` 省略时用申请里的模型，只保留共享范围内有效的部分；结果为空则报 `E_INPUT`。余额 > 0 → 签发/更新 Key（cap = D）；余额 = 0 → 只记录批准。

`revoke_consumer`：删 Magpie key（`gateway-key remove`），保留账目。删除失败时用 `gateway-key rotate` 兜底，并把真实结果写进返回值（`keyRemoved:false, rotated:true`）。

### 7.3 消费方

| 工具 | 参数 | 返回 |
|---|---|---|
| `discover` | `refresh?` | `{peers:[{address, hostname, online, models:[{id, price}]}]}` |
| `request_access` | `provider`, `models: string[]` | `{provider, state, requestedModels}` |
| `connect_provider` | `provider` | `{provider, state:"pending"\|"waiting-deposit"\|"ready"\|"revoked", models?}` |
| `disconnect_provider` | `provider` | `{provider, removed:boolean}` |
| `connections` | — | `{connections:[{provider, models, remainingUsd, state, localPort}]}` |

`discover`：并行读取，全局预算 20 秒；读不完的标 `online:false, stale:true`，不假装成功。缓存 30 秒。

`connect_provider` 幂等，可反复调用：

1. 轮询提供方 `GET /request`。
2. `pending` → 等批准；`waiting-deposit` → 等入账；`revoked` → 报 `E_REVOKED`。
3. `approved` 且拿到 Key → 分配本地转发口（13425+，记入 `state.json.connections`，重启后由 TOML 恢复）→ 用 EasyTier CLI 加「`127.0.0.1:<本地口>` → 提供方 mapped 地址:`gatewayPort`」的转发（加转发不需要重启）→ `magpie provider add remote-magpie <key> url=http://127.0.0.1:<本地口> id=<id>` → 读回模型列表 → `ready`。
4. 已连接再调用 = 刷新 Key/模型（提供方重新批准后走这条）。

`disconnect_provider`：只删除本插件建的那条 Remote Magpie 和转发，不动用户手工创建的服务。删除转发需要重启 EasyTier 核心（EasyTier 2.6.4 的 `port-forward remove` 是坏的，见第 10 节），所以其他连接会短暂中断，这是已知代价。

### 7.4 钱

| 工具 | 参数 | 返回 |
|---|---|---|
| `send_payment` | `chain:"bsc"\|"base"`, `to`, `amount`（十进制字符串，USDC）, `asset?` | `{state:"sent"\|"unknown", txHash?, chain, to, amountRaw}` |
| `history` | `address?`, `limit?`（默认 50，上限 200） | `{deposits:[…], payouts:[…], asOf}` |

`send_payment`：无二次确认、无目标白名单。链上广播成功返回 `sent`；广播后 RPC 报错但可能已发出时返回 `unknown` 并带上已知哈希（可能为空），提示用 `history` 或区块浏览器核对。**没有 journal、没有重发**。

`history`：本地已确认的入账、回滚、出金。`address` 用来过滤某个付款方的入账。

---

## 8. 覆盖网协议

监听：绑定本机 LAN 地址（不是 `0.0.0.0`、不是回环），端口 **3426**。EasyTier 通过 `[[proxy_network]]` 把这个 LAN 地址导出成 `mapped_cidr`，Forward ACL 只放行 3426；消费者拨的是 mapped 那一侧的地址。`[[port_forward]]` **不用于入站**，它只在消费方本机把「本地端口 → 覆盖网远端端口」接起来（见 §7.3）。三个端点全部走覆盖网明文 HTTP。

**签名格式**（三处共用）

- 原文 = 规范化 JSON：键排序、无空白、UTF-8（复用 `catalog.ts` 的 `canonicalJson`）。
- 被签对象里带 `schema` 做域分离：`omai/catalog/1`、`omai/request/1`、`omai/poll/1`。
- 签名 = EIP-191 `personal_sign`（`\x19Ethereum Signed Message:\n<len><msg>`），65 字节 hex，`v` 为 27/28。
- 验签 = `ethers.verifyMessage(canonicalJson(payload), sig)`，得到的地址必须等于 `payload.address`。
- 时间戳 ISO-8601 UTC；`request`/`poll` 要求 ±5 分钟，防止无意义重放（重放本身是幂等的）。

### 8.1 `GET /catalog`

```json
{
  "schema": "omai/catalog/1",
  "address": "0x…",
  "hostname": "omai-…",
  "controlPort": 3426,
  "gatewayPort": 3425,
  "models": [{ "id": "provider/model", "price": { "in": 1.0, "out": 2.0, "cacheRead": 0, "cacheWrite": 0 } }],
  "ts": "2026-11-01T10:00:00Z",
  "sig": "0x…"
}
```

- `sig` 覆盖除 `sig` 外的全部字段。
- 读取方检查：`schema` 精确匹配、验签通过、`address` 与签名者一致、`models` 字段类型与长度受限（≤200 个，id ≤200 字符，价格是非负有限数）、`gatewayPort` 为 `null` 或 1–65535、响应 ≤64 KiB、超时 5 秒。**未知字段一律拒绝**（严格解析）。
- 不共享模型时 `models: []`，`gatewayPort: null`。
- 目录不缓存到磁盘；内存缓存 30 秒，按 `address` 存，兼记最后一次可用的覆盖网地址。

### 8.2 `POST /request`

```json
{ "schema": "omai/request/1", "address": "0x…", "models": ["provider/model"], "ts": "…", "sig": "0x…" }
```

- 按 `address` 覆盖写一条申请（每地址一条，不排队、不生成请求 id）。
- 提供方把它记成 `requestedModels`，不改变已有授权。
- 响应：`{"state":"pending"|"approved"|"revoked","grantedModels":[…],"requestedModels":[…],"ts":"…"}`（不签名；内容由消费方后续轮询核对）。
- 限制：请求体 ≤16 KiB，每地址 30 次/分钟，模型列表非空。

### 8.3 `GET /request?address=&ts=&sig=`

查询串自身被签：`{schema:"omai/poll/1", address, ts}`。

```json
{
  "state": "none" | "pending" | "approved" | "revoked",
  "grantedModels": ["provider/model"],
  "balanceUsd": "0.5000",
  "usedUsd": "0.1000",
  "remainingUsd": "0.4000",
  "gatewayPort": 3425,
  "key": "sk-…",
  "ts": "…"
}
```

- `key` 只在 `state = approved` 且 `balanceUsd ≥ 0.0001` 时出现。
- `connect_provider` 看到的 `waiting-deposit` 由「`state = approved` 且 `balanceUsd < 0.0001`」推出，协议里不单独设这个状态。
- 提供方先验签，再按地址查库；地址不匹配直接 403。
- 响应不签名：Key 本身就是要交给对方的东西，链上余额与授权状态都能被对方核对。

---

## 9. 运行时与数据

```
Magpie 进程
 └─ 插件宿主（Bun，随 Magpie 启动）
     ├─ 启动顺序：读 state.json → 有钱包？→ 打开 SQLite → 启 EasyTier（若有网络配置）
     │            → 开 3426 目录服务并公布 → 启动链观察器 → 注册 18 个工具
     ├─ EasyTier 子进程（no-TUN）：固定端口 3426（目录/控制）、3425（共享时的 Magpie 网关）、
     │                              SOCKS5 13400（读别人目录用）、每连接一个本地转发口 13425+
     ├─ 内置钱包（ethers）：keygen / 地址 / 签名 / 验签 / ERC-20 转账
     └─ 工具层 ← MCP ← 用户 agent
```

固定的端口约定（不再动态分配、不做端口证明）：

| 用途 | 端口 |
|---|---|
| Magpie 网关 | 3425（Magpie 自己的） |
| 目录 + 申请 + 轮询（`proxy_network` + ACL 放行） | 3426 |
| EasyTier SOCKS5（本机回环） | 13400 |
| 每个 Remote Magpie 的本地转发 | 13425 起 |

数据文件（都在 Magpie 插件数据目录）：

| 文件 | 内容 |
|---|---|
| `state.json` | `{version:3, network:{name,secret,initialNode}, share:{models:[]}, publish:{mappedCidr:null}, connections:[{provider, localPort}], hostname}` |
| `wallet/key.hex` | 私钥，`0600` |
| `ledger.sqlite` | 入账、申请、消费者、出金 |
| `easytier/current.toml` | 生成的 EasyTier 配置 |
| `plugin.log` | 日志（脱敏：私钥、Key、网络密码不落日志） |

`ledger.sqlite` 表：

```sql
deposits(id TEXT PRIMARY KEY,      -- chain:token:tx:logIndex
         chain_id INTEGER, token TEXT, from_addr TEXT, to_addr TEXT,
         amount_raw TEXT, block_number INTEGER, block_hash TEXT,
         tx_hash TEXT, log_index INTEGER,
         state TEXT,               -- stored | verified | credited | reverted
         first_seen TEXT, credited_at TEXT, reverted_at TEXT);
-- UNIQUE(chain_id, token, tx_hash, log_index)

requests(address TEXT PRIMARY KEY, models TEXT, ts TEXT,
         state TEXT);              -- pending | approved | revoked

consumers(address TEXT PRIMARY KEY, granted_models TEXT, requested_models TEXT,
          key_name TEXT, key_secret TEXT,
          state TEXT,              -- waiting-deposit | active | revoked
          created_at TEXT, revoked_at TEXT);

payouts(tx_hash TEXT PRIMARY KEY, chain_id INTEGER, token TEXT, to_addr TEXT,
        amount_raw TEXT, state TEXT, created_at TEXT);

meta(k TEXT PRIMARY KEY, v TEXT);
```

`key_secret` 必须落盘（要交付给对方），与 Magpie 自己的 `caller-keys.json` 同级敏感度，文件 0600。

从旧版升级时，如果 `ledger.sqlite` 还是旧 schema（旧 `deposits` 没有 `token` 列），它会被改名成 `ledger.sqlite.pre-v2-<时间>`（连同 `-wal`/`-shm`）并新建一个空账本；不删数据，也不会因为 `CREATE TABLE IF NOT EXISTS` 修不了旧表而启动失败。

### 9.1 文档页（Magpie 里唯一可见的东西）

- 源文件 `plugin/page/doc.md`；`bun run build:page` 用 `scripts/build-page.ts` 渲染成 `page/index.html`（产物提交进仓库，页面运行时不带 markdown 库、不发网络请求）。
- 页面是 sandbox iframe、`connect-src 'none'`、够不到 `/api`，所以它只能是文档，不能显示实时状态。
- 必须写清：这是什么；三步装好（装插件 / 填网络 / 把 MCP 接给 agent）；MCP 地址与打开方式（0.1.2516+ 在 Library 里按 agent 打开，更早版本手工填 URL）；18 个工具表（写真实 MCP 名）；首次使用（拿地址、从交易所提 USDC、补一点 gas、共享模型、申请、connect）；安全边界（私钥、网络密码、覆盖网地址不是身份）；常见错误（429 余额不足 / 401 已撤销 / 对方离线 / 没有 gas）。
- 工具名必须与安装后的真实名字一致（默认 `magpie-oh-my-aihub_<tool>`）。改仓库名或包名要同步改文档页，否则 agent 按文档找不到工具。

---

## 10. Magpie 集成事实（已核实）

以下结论来自本地 checkout `~/Projects/lab/magpie-upstream`，标签 `v0.1.2516` / `v0.1.2606`。

**工具机制**

| 事项 | 事实 | 源码 |
|---|---|---|
| 声明 | 插件函数返回 `{tool: {名字: {description, args, execute}}}`；`args` 可以是 zod shape，也可以是原生 JSON Schema（原样透传） | `internal/plugin/host.js` `toolsOf` / `argsSchema` |
| 加载 | `await fn(input, options)`，返回值的 `.tool` 被收集；一个插件加载失败不影响其他插件 | 同上 `loadPlugins` |
| 名字 | MCP 名 `<短名>_<工具名>`，短名取安装 spec 最后一段（GitHub 装 = 仓库名），≤24 字符，工具名 ≤48 | `internal/gateway/tools_mcp.go` `toolPrefix`、`internal/plugin/store.go` `ShortName` |
| 地址 | `/mcp/magpie/tools`（全部）；`/mcp/magpie/tools/<短名>`（0.1.2516 起，单个插件） | `ToolsMCPPath` / `ToolsMCPOne` |
| 认证 | 本机回环免 key；带 `Origin` 的网页请求拒绝；远程需 Magpie 局域网共享 + Gateway Key | `internal/gateway/search_mcp.go` `serveMCP`、`lan.go` `local` |
| 执行 | 插件宿主进程、用户权限；`ctx = {agent, abort, directory}`；超时 **55 秒** | `internal/plugin/tools.go` `ToolTimeout`、`host.js` `runTool` |
| 返回 | 字符串原样 / `{output}` 取 output / 其它对象转 JSON；错误 → `isError` | `host.js` `runTool` |
| 开关 | 内置插件 `plugins/tools` 是 Essential，`InUse` = 有插件给工具，自动打开 | `docs/subsystems/plugin-tools.md` |
| agent 接线 | 0.1.2171：只能手工填 URL。**0.1.2516 起**：插件自动成为 Library 里的 MCP server（`/mcp/magpie/tools/<短名>`），按 agent 打开；开了 MCP hub 就进 hub | `internal/library/plugin_tools.go` |

**页面机制**

| 事项 | 事实 | 源码 |
|---|---|---|
| 声明 | `package.json` 的 `magpie.page = {title, titles, icon, file}`；`file` 必须是 **HTML** | `internal/plugin/page.go` |
| 渲染环境 | sandbox iframe；CSP `default-src 'none'`、`script-src`/`style-src` 只允许自己目录、`connect-src 'none'`、`form-action 'none'` | `internal/gui/pluginpage.go` `pagePolicy` |
| 文件 | 页面目录下任意文件都能被加载（`plugin.FileIn`），但 CSP 禁止 fetch，所以 Markdown 必须预渲染成 HTML 或在页面内自带渲染器 | 同上 `servePluginPage` |
| 读 Magpie 数据 | 只能通过 `magpie.permissions` 声明的只读项，经窗口桥接；本文档页不需要任何读权限 | `PageReads` |

**复核命令**

```sh
git -C ~/Projects/lab/magpie-upstream show v0.1.2516:internal/gateway/tools_mcp.go | sed -n '30,120p'
git -C ~/Projects/lab/magpie-upstream show v0.1.2516:internal/library/plugin_tools.go | sed -n '1,60p'
git -C ~/Projects/lab/magpie-upstream show v0.1.2516:internal/gui/pluginpage.go | sed -n '227,260p'
go -C ~/Projects/lab/magpie-upstream test ./internal/plugin/ -run Tool
```

**其他必须遵守的上游事实**

- Magpie 网关默认 `127.0.0.1:3425`；要让覆盖网里的伙伴访问，用户必须在 Magpie 里打开 **Share on local network**（绑定 LAN）。文档页必须写这一步。
- `gateway-key limit <id> <window> --cost <usd>`，window 形如 `3650d`，`--cost` 必须 ≥ `0.0001`；`0` 在 Magpie 里表示无限额。
- `gateway-key models <id> <model…>` 拒绝空列表。
- `provider add remote-magpie <key> url=<…> id=<…>`；替换用 `replaceRemoteProvider` 语义（先证明归属）。
- `[[port_forward]]` 是「本地端口 → 覆盖网远端端口」，**不是入站发布**；对外导出只能用 `[[proxy_network]]`（`cidr` 是本机 LAN 地址 `/32`，`mapped_cidr` 是稳定的 `10.66.a.b/32`）。旧实现正是这样分工：提供方用 `proxy_network`，消费方用 `port_forward`。
- 没有 `listeners` 时 EasyTier 默认监听 `tcp://0.0.0.0:11010`（`easytier/src/common/config.rs`），所以入网不需要额外配置监听地址。
- EasyTier 2.6.4 的 `port-forward remove` 打印成功但监听不消失（`easytier-cli.rs` 只发 `bind_addr`，`api.rs` 按整结构比较删除），所以**移除转发必须重启核心**。
- EasyTier 2.6.4 的 SOCKS5 会把监听绑在 `127.0.0.1`（`gateway/socks5.rs`），而 `--socks5` 会绑 `0.0.0.0`（`launcher.rs`），所以只能用 TOML 里的 `socks5_proxy`。
- Magpie 每个进程只起一个插件宿主；本实现**没有** host.lock。快速重启时旧宿主的 parent-watchdog 会在约 5 秒内退出，新宿主的 EasyTier 在这段时间里会按上限重试；不要同时用两个 Magpie 进程挂同一个数据目录。

---

## 11. 最终代码清单（阶段 5 之后）

`plugin/src` 34 个文件、8,317 行（删前 54,891）。逐文件说明在 `plugin/README.md`，这里只列边界：

| 层 | 文件 |
|---|---|
| 入口与运行时 | `index.ts`、`runtime.ts`、`config.ts`、`paths.ts`、`store.ts`、`run.ts`、`log.ts` |
| 节点身份 | `tools/node-wallet.ts`（ethers 钱包：生成、导入/导出、只读余额） |
| 覆盖网 | `overlay.ts`、`lan.ts`、`addresses.ts`、`easytier-manifest.ts`、`socks.ts` |
| 目录与协议 | `catalog-service.ts`、`http-router.ts`、`signing.ts` |
| 授权与账本 | `db.ts`、`grants.ts` |
| 链 | `chain.ts`、`chain-watcher.ts` |
| Magpie 上游 | `magpie.ts` |
| 工具 | `tools/*.ts`（18 个工具、`types.ts`、`node-wallet.ts`） |
| 文档页 | `page/doc.md` → `scripts/build-page.ts` → `page/index.html` |

已删除（git 历史保留）：浏览器控制台（10 个前端文件 + 8 个服务端文件）、CLI（5 个）、P2P 控制面与核心（14 个）、旧钱包/账本/链/付款（30+ 个）、旧 EasyTier 监督器与旧目录客户端、旧用户手册（4 个）。`ARCHITECTURE.md` 在 `docs/history/ARCHITECTURE-pre-v2.md`。

有意没有搬回来的东西：host.lock（见 §14）、价格快照/窗口/重签、存款意图与 EIP-712、TOFU、presence、加密握手、付款 journal。

---

## 12. 分阶段实施

每个阶段一个分支 + 一个 PR；每阶段的验收都要留证据（第 13 节）。

**实施状态（2026-11-01）**：阶段 0–5 已合并到 `main`（`151cb9e`…`da11d8b`）。阶段 5 只做了删除与文档重写，仓库/包名没有改，所以工具名前缀仍是 `magpie-oh-my-aihub`。阶段 4 验收里的「双机端到端」没有做，见 §13 的 UNKNOWN。

| 阶段 | 分支 | 内容 | 验收 |
|---|---|---|---|
| 0 | `docs/agent-native` | 重写 `ARCHITECTURE.md` 为约 8 条决策；旧文档加历史横幅；`AGENTS.md` 指针改到本文档 | 文档自洽，无代码改动 |
| 1 | `feat/skeleton` | 新 `index.ts`、`config.ts`、`wallet.ts`、`tools/{status,wallet,wallet-import,wallet-export,join-network}`、文档页（含预渲染脚本） | 真 Magpie 0.1.2516+ 里，agent 通过 MCP 看到这 5 个工具，能生成钱包、拿到地址、加入网络并在 `status` 看到 online；Magpie 里能打开文档页，里面的工具名与实际一致 |
| 2 | `feat/catalog` | 探测 LAN 地址 + 分配/持久化 `mappedCidr` + `proxy_network` 与 ACL 固定放行 3426/3425、3426 目录服务、签名、SOCKS5 读取、`share_models`/`native_models`/`discover` | 两台隔离 Magpie 互见模型与价格；篡改任一字段被拒 |
| 3 | `feat/authorization` | `request`/`poll` 端点、SQLite（requests/consumers）、审批/拒绝/撤销、Key 签发路径（余额为 0 时不发）、`connect_provider`/`disconnect_provider`、`consumers`/`connections` | 双机：申请 → 批准（余额 0 → waiting-deposit）→ 轮询拿到 waiting-deposit → 撤销后 poll 返回 revoked；用一行测试存款（见阶段 4）验证 Key 签发、转发与 Remote Magpie 注册路径 |
| 4 | `feat/credit` | 链观察器、按 `from` 记账、`cap = D`、`send_payment`、`history`、回滚 | 本地链实验：入账→cap→原生 200；用尽→429；回滚→cap 下降；出金到任意地址成功；双机端到端：入账后 Key 送达、消费方出现 Remote Magpie 模型、原生调用 200→429 |
| 5 | `feat/cleanup` | 删除旧模块与旧文档，重命名包/仓库（可选，为了短工具名） | `bun run typecheck` 通过；无死代码；`plugin-tools.json` 只剩本插件工具 |

风险点：

- 阶段 1 的 EasyTier 首次下载可能超过 55 秒 → 必须是后台 job + `status` 轮询。
- 阶段 3 的转发删除需要重启核心 → `disconnect_provider` 必须在返回值里说明"其他连接会短暂中断"。
- 阶段 4 的 BSC 最终性只能靠确认数，链上实验要标清这是替代策略。

---

## 13. 验证与证据规范

- 每条结论标 **VERIFIED / REPRODUCED / UNKNOWN**，附平台、组件版本、可复现命令和原始（脱敏）输出。
- 类型检查：`cd plugin && bun run typecheck`。
- 文档页：`cd plugin && bun run build:page`（渲染前校验 18 个工具名和两个 MCP 地址都在 `page/doc.md` 里）。
- 临时目录 boot 冒烟：`OH_MY_AIHUB_MAGPIE=/nonexistent/magpie OH_MY_AIHUB_LAN_IP=127.0.0.1`，import `plugin/src/index.ts`；默认导出应返回 18 个工具，生成 `wallet/key.hex`（0600）与五张表，`status.network.state = "offline"`。
- 链上实验只在本地 anvil（chainId 31337、注入链记录）或受控模拟 RPC 上做；真实链只做只读。测试文件不提交。
- **已做（REPRODUCED，macOS arm64 / Bun 1.4.3 / ethers 6.17.0 / anvil 1.8.6）**：签名目录与篡改拒绝；申请→批准→撤销→Key 交付；connect/disconnect 与同 id 外部 provider 拒绝；入账→cap→Key、重复扫描、reorg 回滚、`send_payment` 及其拒绝路径、`getLogs` 折半、BSC/Base 只读冒烟；清理后的 18 工具 boot。
- **未做（UNKNOWN）**：真 Magpie 0.1.2516+ 上的 `gateway-key add/limit/remove` 与 `provider add remote-magpie`；两台主机 + 真实 EasyTier 的完整双机流程；真实链入账后原生 200→429；Linux/Windows 桌面。

---

## 14. 已知限制（写进文档页，不许隐藏）

1. **私钥只保证"工具不返回"**。导出到文件后，如果 agent 本身有本机文件读权限，它还是能读到那个文件。这是本机权限问题，插件挡不住。
2. **转 USDC 需要 gas**。地址上没有 BNB/ETH 时 `send_payment` 会失败，`wallet` 会显示 gas 余额。
3. **同一个钱包 = 同一个账户**。两台机器用同一个私钥，余额共享。
4. **价格变更会改变剩余额度**（D13），可能出现剩余为负、Magpie 拒服务，充值即恢复。
5. **覆盖网地址不是身份**。安全靠签名 + Gateway Key + 余额，网络密码是唯一入网门。
6. **一笔转错地址的付款无法找回**。`send_payment` 不限目标、不二次确认。
7. **交易所提币地址会成为账户**，但它拿不到 Key，所以那笔钱用不上。
8. **移除连接会重启 EasyTier 核心**（上游 bug），其他连接短暂中断。
9. **一个数据目录一个宿主**。同时开两个 Magpie 指向同一数据目录不成立。
10. **0.1.2171 及更早版本没有 Library 自动接线**，只能手工把 MCP 地址填进 agent。
11. **没有 host lock**：一个数据目录只应有一个 Magpie 进程，快速重启时会有一段 EasyTier 重试期（见 §10）。
12. **目录价格最多落后一个 tick**：Magpie 没有改价通知，目录每 30 秒重签。
13. **首次扫描只回溯 24 小时**：全新安装的钱包地址是刚生成的，正常不会有更早的入账；导入一个早已收过钱的私钥则可能漏掉旧记录。
11. **别的机器上的 agent** 要调这些工具，需要 Magpie 打开局域网共享并持有 Gateway Key；本机 agent 默认免 key。

---

## 15. 明确不做

- 不做控制台、不做 CLI、不做本机管理 API、不做配对。
- 不做 TOFU、证书、PIN、二维码、指纹核对。
- 不做价格锁、价格版本、重签（reissue）、窗口边界处理、usage 日志导入。
- 不做存款意图、EIP-712 单据、归属认领、对账单、离线账单文件。
- 不做浏览器钱包、托管、多钱包、HD 账户、每消费者独立地址。
- 不做退款、争议、仲裁、撮合、代币、跨链、法币。
- 不做 DHT、mDNS、新路由、中心目录服务器。
- 不把 Magpie 管理界面暴露到覆盖网（唯一例外是 Magpie 自己的模型网关，它本来就要给伙伴用）。

---

## 16. 接手须知

1. 只信这份文档的产品决策；`docs/history/ARCHITECTURE-pre-v2.md` 是历史证据。
2. 下一步：用真 Magpie 0.1.2516+ 和两台隔离数据目录跑完整双机流程，把 §13 的 UNKNOWN 变成证据；不要先加新功能。
3. 动代码前先读第 7 节的工具规格和第 8 节的协议，两者是唯一对外契约；改它们要先改这份文档。
4. 任何"为了安全再加一层"的想法，先看第 2 节的 D4/D9/D10/D13：这一版是故意不做那些层的。
5. 每次改动一个分支、一个 PR，附验证证据；不做大范围重写。
