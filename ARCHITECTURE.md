# Architecture

Oh My AIHub 是 Magpie 的一个纯后端插件：让同一个 EasyTier 私有网里的几台 Magpie 互相把对方的**原生模型**当作 Remote Magpie 来用，用链上 USDC 预付结算。

插件不做 AI 网关，不转发、不计 token、不做第二套计费。AI 请求始终是「你的应用 → 你的 Magpie → EasyTier → 伙伴的 Magpie」。插件不提供控制台、CLI 或本机管理 API；唯一交互方式是 Magpie 暴露给 agent 的 18 个 MCP 工具。Magpie 里只有一页静态文档（`plugin/page/doc.md`），教用户把 agent 接上这些工具。

明确不是：模型市场、代币、撮合、托管、跨链、法币通道、公网服务、多租户 SaaS。

## 产品决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 砍掉浏览器控制台、本机回环 API、CLI；只留后端 + MCP 工具 | 用户用 agent 操作，界面是负担 |
| D2 | Magpie 里只加一页 Markdown 文档（渲染成静态 HTML） | 教用户接 agent，而不是当控制台 |
| D3 | 内置钱包；生成 / 文件导入 / 文件导出；私钥不进 agent，地址可以给 | 地址要给用户去交易所提币 |
| D4 | 覆盖网内明文 HTTP，不做 E2E | EasyTier 本身端到端加密，网络密码就是门 |
| D5 | 只「加入」网络：网络名、密码、初始节点（可选） | 不承担组网产品的复杂度 |
| D6 | 没有「共享开关」「发布开关」「发现开关」：配好网络就自动公布、自动发现 | 开关是旧产品的历史包袱 |
| D7 | 只共享原生模型：非 `remote-magpie`、非 `group/…`、非 `auto/…`，且价格完整 | 不转售别人的通道，价格必须可算 |
| D8 | 批准只给模型范围，不给额度；额度 = 充值余额；申请与打钱互相独立 | 只有一个钱来源，cap 可推导 |
| D9 | 任何人往我的地址打钱都按 `from` 记账，不需要申请、单据或认领 | 熟人网络，付款是自愿行为 |
| D10 | 余额多少就能用多少；提供方不想被用就撤销 | 不需要 per-consumer 上限 |
| D11 | 付款工具一次调用即转，无二次确认，收款地址不限 | agent 原生；出金也要方便 |
| D12 | 链 RPC 内置默认值 | 没有界面配置 RPC |
| D13 | 价格变更接受按新价重算（不锁价、不暂停、不重签） | 删掉整套价格版本机制 |
| D14 | 一个节点只有一个钱包地址，即它的全部身份 | 去掉第二种身份和两套信任存储 |

D13 的后果：Magpie 改价会重算历史用量，「剩余额度」会自己变。`cap` 不变，`used` 变，剩余跟着变。这是接受的语义，不做补偿、不做暂停。

## 运行时

```
Magpie 进程
 └─ 插件宿主（Bun）
     ├─ boot：读 state.json → 钱包 → SQLite → EasyTier（有网络时）
     │        → 3426 目录服务 → 链观察器 → 18 个工具
     ├─ EasyTier no-TUN 子进程：3426 目录/控制、3425 网关、
     │                          13400 SOCKS5、13425+ 本地转发
     ├─ 内置钱包（ethers）：keygen / 地址 / 签名 / 验签 / ERC-20 transfer
     └─ 工具层 ← MCP ← 用户 agent
```

- 一个宿主进程一个运行时；`src/runtime.ts` 管 boot 顺序、30 秒目录重签、`cap`/Key 的后台重同步、`wallet_import` 后的身份替换、退出钩子。
- Magpie 的工具超时是 **55 秒**。首次下载 EasyTier、入网这类长操作返回 `{state:"starting"}`，由 `status` 轮询；不要在工具里做同步长等待。
- 端口固定：**3425** Magpie 网关，**3426** 目录/申请/轮询，**13400** EasyTier SOCKS5（回环），**13425 起**每个 Remote Magpie 一个本地转发口。
- 覆盖网地址不是身份。EasyTier 2.6.4 的 `peer_id` 每次重启都变，CLI 也不暴露对端静态公钥；身份只能来自钱包签名。

## 数据文件

都在 `<magpie 数据目录>/oh-my-aihub/`：

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `state.json` | `{version:3, network:{name,secret,initialNode}, share:{models}, publish:{mappedCidr}, connections:[{provider,localPort,mappedHost}], hostname}`；上一版留 `.prev` | `0600` |
| `wallet/key.hex` | 节点私钥。工具永远不返回它 | `0600` |
| `ledger.sqlite` | 入账、申请、消费者、出金、扫描游标；WAL，`-wal`/`-shm` 同行 | `0600` |
| `easytier/current.toml` | 生成的 EasyTier 配置（导出、ACL、SOCKS5、逐连接转发） | `0600` |
| `plugin.log` | 脱敏日志（私钥、Gateway Key、网络密码不落盘） | `0600` |

`consumers.key_secret` 必须落盘（要交给对方），和 Magpie 自己的 `caller-keys.json` 同级敏感度。

`ledger.sqlite` 五张表：

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

## 覆盖网与协议

EasyTier 用 **no-TUN** 模式。插件用 `[[proxy_network]]` 把本机 LAN 地址导出成稳定的 `10.66.a.b/32`（首次分配后持久化），Forward ACL 只放行 **3426** 和 **3425**。改共享模型只重签内存里的目录，不重启核心。`[[port_forward]]` 只用于消费方本机（本地端口 → 覆盖网远端端口），不用于入站。

三个端点都监听 `<lan>:3426`，走覆盖网明文 HTTP。

**签名**（三处共用）：原文是规范化 JSON（键排序、无空白、UTF-8），签名是 EIP-191 `personal_sign`，65 字节 hex，`v` 为 27/28；被签对象带 `schema` 做域分离（`omai/catalog/1`、`omai/request/1`、`omai/poll/1`）；验签得到的地址必须等于 `payload.address`。`request`/`poll` 的 `ts` 要求 ±5 分钟。

### `GET /catalog`

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

`sig` 覆盖除 `sig` 外的全部字段。读取方检查：`schema` 精确匹配、验签通过、`address` 与签名者一致、`models` 字段类型与长度受限（≤200 个，id ≤200 字符，价格非负有限）、`gatewayPort` 为 `null` 或 1–65535、响应 ≤64 KiB、超时 5 秒。**未知字段一律拒绝**。不共享模型时 `models: []`、`gatewayPort: null`。目录不落盘；内存缓存 30 秒，按 `address` 存，兼记最后一次可用的覆盖网地址。

### `POST /request`

```json
{ "schema": "omai/request/1", "address": "0x…", "models": ["provider/model"], "ts": "…", "sig": "0x…" }
```

按 `address` 覆盖写一条申请（每地址一条，不排队、不生成请求 id）。提供方把它记成 `requestedModels`，不改变已有授权。响应 `{"state":"pending"|"approved"|"revoked","grantedModels":[…],"requestedModels":[…],"ts":"…"}`，不签名。限制：请求体 ≤16 KiB，每地址 30 次/分钟，模型列表非空。

### `GET /request?address=&ts=&sig=`

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

`key` 只在 `state = approved` 且 `balanceUsd ≥ 0.0001` 时出现。`connect_provider` 看到的 `waiting-deposit` 由「`state = approved` 且 `balanceUsd < 0.0001`」推出，协议里不单独设这个状态。提供方先验签，再按地址查库；地址不匹配直接 403。响应不签名：Key 本身就是要交给对方的东西，链上余额与授权状态都能被对方核对。

## 授权与钱

```
D(地址)     = Σ 已确认入账金额（同一付款方地址、跨 BSC/Base 求和）
cap         = floor_0.0001(D)
remaining   = D − Magpie 原生 used（当前窗口）
```

- **`cap = D`**：每次入账/回滚后重算并写入 Magpie：`gateway-key limit <id> 3650d --cost <cap>`。
- **不发 `cap = 0` 的 Key**：Magpie 把 `0` 当无限额。`D < $0.0001` 时不发 Key，状态「等待充值」。
- **申请与批准是两件事**：消费方签名申请；提供方批准模型子集。批准不改变余额，余额也不自动产生授权。
- **状态**：申请 `pending | approved | revoked`；消费者 `waiting-deposit | active | revoked`。
- **撤销**：删除 Magpie 里的 Gateway Key（失败时用 rotate 兜底），账目保留；重新批准会发新 Key，消费方再 `connect_provider` 取一次。
- **入账归属**：`Transfer.to` 是本节点地址，付款方是 `from`；不需要申请、单据或认领。交易所直接提币到提供方地址时，`from` 是交易所地址，那笔钱记在交易所名下，拿不到 Key。
- **最终性**：BSC 用 15 个确认（它的 `finalized` 标签等于 `latest`，没有深度信息），Base 用 `finalized` 标签。两条都拿不到就不入账，等下一轮。
- **回滚**：已入账行所在块不再 canonical 时标 `reverted`，`D` 重算、`cap` 调低（`D` 归零就删 Key）；记录不删、不退款。
- **出金**：`send_payment` 从节点钱包发 USDC 到任意地址，记录在 `payouts`，不影响任何余额；只广播一次，`E_TX_UNKNOWN` 要用哈希人工核对，不自动重发。
- **金额**：全部是整数最小单位；BSC USDC 18 位，Base USDC 6 位，**永不混用**。

## Magpie 集成

**MCP 名字**：短名是安装后 `package.json` 的包名去掉 scope（以及 `middleware-`/`opencode-`/`tools-`/`page-`/`agent-` 前缀和 `-auth` 后缀）。本插件是 `@oh-my-aihub/magpie-plugin`，所以短名是 `magpie-plugin`。

| 接入方式 | 地址 | 工具名 |
| --- | --- | --- |
| 全部插件 | `http://127.0.0.1:3425/mcp/magpie/tools` | `magpie-plugin_<tool>` |
| 只本插件（0.1.2516+） | `http://127.0.0.1:3425/mcp/magpie/tools/magpie-plugin` | `<tool>` |
| MCP 路由 | `http://127.0.0.1:3425/mcp/magpie/hub/<agent>` | `magpie-plugin__<tool>` |

**插件契约**：入口只导出 default 插件函数；测试辅助放在 `_internal` 对象里，因为 Magpie 会把每个导出函数都当插件调用。工具名匹配 `^[A-Za-z0-9_-]{1,48}$`，MCP 名是 `<短名>_<工具名>`（≤64 字符）；`args` 是 JSON Schema，`execute(args, ctx)` 返回字符串；单次工具最多 55 秒。

**Magpie CLI**：

- `gateway-key limit <id> 3650d --cost <usd>`，`--cost` ≥ `0.0001`；`0` 表示无限额。
- `provider add remote-magpie <key> url=<…> id=omai-<地址后 8 位>`。
- 本机 agent 默认免 Gateway Key；别的机器上的 agent 需要 Magpie 打开 **Share on local network** 并持有 Gateway Key。
- Magpie 的模型网关默认 `127.0.0.1:3425`；要让覆盖网里的伙伴访问，必须打开局域网共享（绑定 LAN）。

**页面**：

- `plugin/page/doc.md` → `bun run build:page` → `plugin/page/index.html`。产物提交进仓库，页面运行时不带 markdown 库、不发网络请求。
- 页面是 sandbox iframe、`connect-src 'none'`，够不到 `/api`，所以它只能是文档，不能显示实时状态。
- **必须加载 `_magpie/bridge.js`**：Magpie 的窗口要求页面在 10 秒内 say hello，否则整页被替换成「此页面已停止工作」。bridge 只负责握手和主题，页面本身仍是静态 HTML。
- 构建时校验 18 个工具名和两个 MCP 地址都在 `page/doc.md` 里；前缀从根 `package.json` 推导，改包名要同步改页面。

**上游事实**（已核实，Magpie `v0.1.2516`，EasyTier `2.6.4`）：

- 插件工具由 Magpie 的 plugin-tools MCP server 暴露；工具超时 55 秒；本机回环免 Key，带 `Origin` 的网页请求拒绝。
- EasyTier 2.6.4 的 `port-forward remove` 会打印成功但监听不消失，所以 `disconnect_provider` 要重启核心，其他连接短暂中断。
- EasyTier 2.6.4 的 SOCKS5 在 TOML 里绑 `127.0.0.1`；`--socks5` 会绑 `0.0.0.0`，所以只能用 TOML 的 `socks5_proxy`。
- 没有 `listeners` 时 EasyTier 默认监听 `tcp://0.0.0.0:11010`，入网不需要额外配置监听地址。
- 复核：`git -C ~/Projects/lab/magpie-upstream show v0.1.2516:internal/gateway/tools_mcp.go`、`internal/library/plugin_tools.go`、`internal/gui/pluginpage.go`。

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口。默认导出同步返回 `{tool}` 的 18 个工具；测试辅助放在 `_internal` 对象里，不额外导出函数。 |
| `src/runtime.ts` | 一个宿主进程一个运行时：boot 顺序、30 秒目录重签、`cap`/Key 重同步、身份替换、退出钩子。 |
| `src/config.ts` | `state.json`（version 3）的读写。 |
| `src/db.ts` | `ledger.sqlite` 五张表和金额换算（整数 micro-USD）。 |
| `src/grants.ts` | 申请、批准、拒绝、撤销，以及 Gateway Key 的签发/收窄/删除；`D → cap → key` 的唯一实现。 |
| `src/http-router.ts` | 本插件唯一的监听：`<lan>:3426`，只有三个端点。 |
| `src/catalog-service.ts` | `omai/catalog/1` 的构建、签名、解析；改共享只重签内存里的文档。 |
| `src/signing.ts` | 规范化 JSON 与 EIP-191 `personal_sign`/验签。 |
| `src/overlay.ts` | EasyTier no-TUN 生命周期：下载校验、生成 TOML、导出 LAN 地址、分配转发口、重启与停止。 |
| `src/socks.ts` | 经本机 EasyTier SOCKS5 发一个 HTTP 请求。 |
| `src/lan.ts` | 探测要导出的 LAN IPv4（`OH_MY_AIHUB_LAN_IP` 可覆盖，仅供隔离测试）。 |
| `src/addresses.ts` | 稳定的 `10.66.a.b/32` 覆盖网导出前缀。 |
| `src/easytier-manifest.ts` | 固定 EasyTier 2.6.4 各平台资产与 SHA-256。 |
| `src/chain.ts` | BSC/Base 注册表、USDC 精度、JSON-RPC 读取与唯一写路径。 |
| `src/chain-watcher.ts` | 每链一个扫描循环：读头、算最终块、按块取 `Transfer` 日志、凭 receipt 入账、复查回滚。 |
| `src/magpie.ts` | Magpie CLI 封装（模型、Gateway Key、Remote Magpie），以及价格能否被冻结的判断。 |
| `src/paths.ts` | 插件数据目录与 `magpie` 可执行文件的解析（`OH_MY_AIHUB_MAGPIE` 可覆盖）。 |
| `src/store.ts` | 原子写 JSON（临时文件 + fsync + rename，保留 `.prev`）。 |
| `src/run.ts` | 唯一启动外部程序的地方：argv 数组，没有 shell。 |
| `src/log.ts` | 脱敏日志（私钥、Key、网络密码、bearer 不落盘）。 |
| `src/tools/*.ts` | 18 个工具；`types.ts` 是工具定义类型，`node-wallet.ts` 是钱包生命周期（不是工具）。 |
| `scripts/build-page.ts` | 把 `page/doc.md` 渲染成 `page/index.html`，渲染器是很小的 Markdown 子集。 |

## 已知限制

1. **私钥只保证「工具不返回」**。导出到文件后，如果 agent 有本机文件读权限，它还是能读到那个文件。这是本机权限问题，插件挡不住。
2. **转 USDC 需要 gas**。地址上没有 BNB/ETH 时 `send_payment` 会失败，`wallet` 会显示 gas 余额。
3. **同一个钱包 = 同一个账户**。两台机器用同一个私钥，余额共享。
4. **价格变更会改变剩余额度**（D13），可能出现剩余为负、Magpie 拒服务，充值即恢复。
5. **覆盖网地址不是身份**。安全靠签名 + Gateway Key + 余额，网络密码是唯一入网门。
6. **一笔转错地址的付款无法找回**。`send_payment` 不限目标、不二次确认。
7. **交易所提币地址会成为账户**，但它拿不到 Key，所以那笔钱用不上。
8. **移除连接会重启 EasyTier 核心**（上游 bug），其他连接短暂中断。
9. **一个数据目录一个宿主**。同时开两个 Magpie 指向同一数据目录不成立；没有 host lock，快速重启时会有一段 EasyTier 重试期。
10. **0.1.2171 及更早版本没有 Library 自动接线**，只能手工把 MCP 地址填进 agent。
11. **目录价格最多落后一个 tick**：Magpie 没有改价通知，目录每 30 秒重签。
12. **首次扫描只回溯 24 小时**：全新安装的钱包地址是刚生成的，正常不会有更早的入账；导入一个早已收过钱的私钥则可能漏掉旧记录。
13. **别的机器上的 agent** 要调这些工具，需要 Magpie 打开局域网共享并持有 Gateway Key；本机 agent 默认免 Key。

## 验证

```sh
cd plugin
bun run typecheck      # tsc --noEmit
bun run build:page     # page/doc.md -> page/index.html，校验 18 个工具名与两个 MCP 地址
```

临时目录 boot 冒烟：`OH_MY_AIHUB_MAGPIE=/nonexistent/magpie OH_MY_AIHUB_LAN_IP=127.0.0.1`，import `plugin/src/index.ts`；默认导出应返回 18 个工具，生成 `wallet/key.hex`（0600）与五张表，`status.network.state = "offline"`。

- **已做（REPRODUCED，macOS arm64 / Bun 1.4.3 / ethers 6.17.0 / anvil 1.8.6）**：签名目录与篡改拒绝；申请 → 批准 → 撤销 → Key 交付；connect/disconnect 与同 id 外部 provider 拒绝；入账 → cap → Key、重复扫描、reorg 回滚、`send_payment` 及其拒绝路径、`getLogs` 折半、BSC/Base 只读冒烟；清理后的 18 工具 boot。
- **未做（UNKNOWN）**：真 Magpie 0.1.2516+ 上的 `gateway-key add/limit/remove` 与 `provider add remote-magpie`；两台主机 + 真实 EasyTier 的完整双机流程；真实链入账后原生 200 → 429；Linux/Windows 桌面。

每条结论标 **VERIFIED / REPRODUCED / UNKNOWN**，附平台、组件版本、可复现命令和原始（脱敏）输出。链上实验只在本地 anvil 或受控模拟 RPC 上做；真实链只做只读。测试文件不提交。

## 明确不做

- 不做控制台、不做 CLI、不做本机管理 API、不做配对。
- 不做 TOFU、证书、PIN、二维码、指纹核对。
- 不做价格锁、价格版本、重签、窗口边界处理、usage 日志导入。
- 不做存款意图、EIP-712 单据、归属认领、对账单、离线账单文件。
- 不做浏览器钱包、托管、多钱包、HD 账户、每消费者独立地址。
- 不做退款、争议、仲裁、撮合、代币、跨链、法币。
- 不做 DHT、mDNS、新路由、中心目录服务器。
- 不把 Magpie 管理界面暴露到覆盖网（唯一例外是 Magpie 自己的模型网关，它本来就要给伙伴用）。

## 工作方式

1. 只信这份文档的产品决策和 `plugin/page/doc.md` 的用户说明；两者冲突时先改文档再改代码。
2. 下一步：用真 Magpie 0.1.2516+ 和两台隔离数据目录跑完整双机流程，把「未做」变成证据；不要先加新功能。
3. 动代码前先读「授权与钱」和「覆盖网与协议」，两者是唯一对外契约；改它们要先改这份文档。
4. 任何「为了安全再加一层」的想法，先看 D4/D9/D10/D13：这一版是故意不做那些层的。
5. 每次改动一个分支、一个 PR，附验证证据；不做大范围重写。
