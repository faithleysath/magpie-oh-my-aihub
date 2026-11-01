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
| D4 | 不做应用层 E2E；传输层的加密程度交给网络：secure mode 是每对节点独立的 E2EE，普通模式是共享密码的 AES-GCM | 不在插件里重新实现一层加密 |
| D5 | 只「加入」网络：网络名、密码、初始节点（可选）、secureMode（可选） | 不承担组网产品的复杂度；secure mode 的密钥本机自生成，不做公钥交换 |
| D6 | 没有「共享开关」「发布开关」「发现开关」：配好网络就自动公布、自动发现 | 开关是旧产品的历史包袱 |
| D6b | 价格能写进目录就共享，写不进就不共享：四段价签 `omai/catalog/1`，带阶梯价或高峰价签 `omai/catalog/2` | 公布价必须能被读者自己算出来；装不下就发 /2，而不是猜一个数 |
| D7 | 只共享原生模型：非 `remote-magpie`、非 `group/…`、非 `auto/…`，且价格完整 | 不转售别人的通道，价格必须可算 |
| D8 | 批准只给模型范围，不给额度；额度 = 充值余额；申请与打钱互相独立 | 只有一个钱来源，cap 可推导 |
| D9 | 任何人往我的地址打钱都按 `from` 记账，不需要申请、单据或认领 | 熟人网络，付款是自愿行为 |
| D10 | 余额多少就能用多少；提供方不想被用就撤销 | 不需要 per-consumer 上限 |
| D11 | 付款工具一次调用即转，无二次确认，收款地址不限 | agent 原生；出金也要方便 |
| D12 | 链 RPC 内置默认值 | 没有界面配置 RPC |
| D13 | 价格变更接受按新价重算（不锁价、不暂停、不重签） | 删掉整套价格版本机制 |
| D14 | 一个节点只有一个钱包地址，即它的全部身份 | 去掉第二种身份和两套信任存储 |
| D15 | 地址簿是 `alias → 地址` 的本机映射，所有收地址的工具都直接接受别名 | 用户不必来回粘贴 0x；只是省打字，不进签名、不进目录、不参与授权，也不改 D11 的无确认转账 |

D13 的后果：Magpie 改价会重算历史用量，「剩余额度」会自己变。`cap` 不变，`used` 变，剩余跟着变。这是接受的语义，不做补偿、不做暂停。

## 运行时

```
Magpie 进程
 └─ 插件宿主（Bun）
     ├─ boot：读 state.json → 钱包 → SQLite → EasyTier（有网络时）
     │        → 3426 目录服务 → 链观察器 → 19 个工具
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
| `state.json` | `{version:3, network:{name,secret,initialNode,secureMode}, share:{models}, publish:{mappedCidr}, connections:[{provider,localPort,mappedHost}], hostname}`；上一版留 `.prev` | `0600` |
| `wallet/key.hex` | 节点私钥。工具永远不返回它 | `0600` |
| `ledger.sqlite` | 入账、申请、消费者、出金、扫描游标；WAL，`-wal`/`-shm` 同行 | `0600` |
| `easytier/current.toml` | 生成的 EasyTier 配置（导出、ACL、SOCKS5、secure mode、逐连接转发） | `0600` |
| `easytier/secure-key.json` | 本节点的 X25519 密钥对（只在 secure mode 下生成）。换了它就不是同一个节点 | `0600` |
| `plugin.log` | 脱敏日志（私钥、Gateway Key、网络密码不落盘） | `0600` |

`consumers.key_secret` 必须落盘（要交给对方），和 Magpie 自己的 `caller-keys.json` 同级敏感度。

`ledger.sqlite` 六张表：

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

contacts(alias TEXT PRIMARY KEY, address TEXT NOT NULL,
         note TEXT, created_at TEXT);  -- 地址簿：不签名、不发布、不参与授权
```

## 覆盖网与协议

EasyTier 用 **no-TUN** 模式。插件用 `[[proxy_network]]` 把本机 LAN 地址导出成稳定的 `10.66.a.b/32`（首次分配后持久化），Forward ACL 只放行 **3426** 和 **3425**。改共享模型只重签内存里的目录，不重启核心。`[[port_forward]]` 只用于消费方本机（本地端口 → 覆盖网远端端口），不用于入站。

导出的那个本地地址由 `detectLanIPv4()` 选：排除容器网卡（`docker*`、`br-*`、`veth*`、`virbr*`、`podman*`、`cni*`、`flannel*`），因为它们看起来像私网。而私网优先正是排序规则；在一台真实地址是公网的 VPS 上，`docker0` 会赢过 `ens17`，导出就指向对端永远连不上的地址。网卡名按 `en0/en1/eth0/eth1/ens<数字>/enp<数字>s<数字>/wlan<数字>` 优先。真的选错时用 `OH_MY_AIHUB_LAN_IP` 覆盖。

默认不写 `listeners`：EasyTier 一个端口都不开，节点只能透过已经连着的对端到达，实际就是种子。`join_network` 的 `listen: true` 会写 `listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]`，两个传输都开才能直连（TCP 和 UDP 两种都可用），主机防火墙要放行；只在入站端口真的可达时开，否则对端会先试直连再回退到中继，白白多一轮。

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

#### `omai/catalog/2`：阶梯价与高峰价

四个数字装不下「超过 272k tokens 涨价」和「供应商高峰时段翻倍」，/2 在同样的四段价上加了两个可选字段：

```json
{
  "id": "codex/gpt-6-astra",
  "price": {
    "in": 10, "out": 50, "cacheRead": 1, "cacheWrite": 12.5,
    "tiers": [{ "above": 272000, "in": 20, "out": 75, "cacheRead": 2, "cacheWrite": 25 }],
    "peak": { "multiplier": 2, "note": "weekdays" }
  }
}
```

语义（读取方必须按这个算，不是提示）：

- `tiers`：按 `above` 升序，门槛唯一且为正整数，最多 10 档。请求的输入 tokens **超过**某档 `above` 时，**整笔请求**按该档计价（与供应商的长上下文计价一致）；`above` 或以下用四段基础价。
- `peak`：`multiplier` 是高峰时段四个数字的倍数（>1，≤100）；`note` 是供应商的时段标签（Magpie 自己写的 `weekdays` / `deepseek` 之类），因为时段表本身不在文档里，读取方只能知道「最多贵几倍、按谁的时段」，不能算出某一刻的确切价。
- 归一律：价格打成 /2 时，缺 `tiers` 就是没有阶梯，缺 `peak` 就是不分时段。

**什么时候签 /2**：至少一个共享模型需要 `tiers` 或 `peak` 才签 /2；全是四段价就继续签 /1，让 0.8.0 及更早的读者照旧能读。读取方两种都收，其它 schema 一律拒。

**为什么可以这样发**：计费由提供方 Magpie 按它自己的价目表完成，目录只是**签名的价格承诺**。/1 时代的规则是「写不下就不发」；/2 把阶梯和高峰写清楚之后，「公布的价 = 至少不高于实际扣的价」这个约定才能被读者自己算出来。

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
- 构建时校验 19 个工具名和两个 MCP 地址都在 `page/doc.md` 里；前缀从根 `package.json` 推导，改包名要同步改页面。

**上游事实**（已核实，Magpie `v0.1.2516`，EasyTier `2.6.4`）：

- 插件工具由 Magpie 的 plugin-tools MCP server 暴露；工具超时 55 秒；本机回环免 Key，带 `Origin` 的网页请求拒绝。
- EasyTier 2.6.4 的 `port-forward remove` 会打印成功但监听不消失，所以 `disconnect_provider` 要重启核心，其他连接短暂中断。
- EasyTier 2.6.4 的 SOCKS5 在 TOML 里绑 `127.0.0.1`；`--socks5` 会绑 `0.0.0.0`，所以只能用 TOML 的 `socks5_proxy`。
- 没有 `listeners` 时 EasyTier 默认监听 `tcp://0.0.0.0:11010`，入网不需要额外配置监听地址。
- **无 TUN 模式没有虚拟 IPv4**：`no_tun = true` 下 EasyTier 2.6.4 不给任何节点分配虚拟 IP（`--ipv4` 也不行），`peer list` 的 `ipv4` 字段恒为空。所以邻居的身份是 hostname，要拨的地址是它导出的 mapped CIDR（`proxy_cidrs`），不能用 ipv4 做过滤条件。
- 不写 `listeners` 时 EasyTier 2.6.4 **一个端口都不开**（`node.listeners` 里只有内部 `ring://`），`peer list` 里对方的 `cost` 会是 `relay`；写了 `listeners` 之后要么直达（`p2p`），要么仍然回退到中继，取决于两边入站端口是否真的可达。
- Magpie 的 `peak` 是「低谷价 + 高峰时段翻倍」（0.1.2289），倍率按 2 处理；`tiers` 是整笔请求按档计价。两者都原样进 `omai/catalog/2`。
- **网关 `/v1/models` 才是“真会路由”的清单**：路由组 `unlists` 藏起来的副本不在选择器里，但网关照样按 `provider/model` 路由（实测用未勾选的 `deepseek/deepseek-v4-pro` 打到了 DeepSeek 上游）。所以插件取候选 id 用网关（2 ms），`magpie models` 只当网关不在回环上时的回落（它现场查所有 provider 的目录，约 10 秒）。
- EasyTier 2.6.4 的 secure mode：同网节点必须都开，没开的一方会被对端反复踢掉（官方文档说服务端能接旧客户端，实测不行）；`local_public_key` 必须显式给，否则报 `local public key is not set`；`peer_public_key` 写了不生效（填一个假公钥照样能连上），所以现在不做公钥 pin。
- 复核：`git -C ~/Projects/lab/magpie-upstream show v0.1.2516:internal/gateway/tools_mcp.go`、`internal/library/plugin_tools.go`、`internal/gui/pluginpage.go`。

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口。默认导出同步返回 `{tool}` 的 19 个工具；测试辅助放在 `_internal` 对象里，不额外导出函数。 |
| `src/runtime.ts` | 一个宿主进程一个运行时：boot 顺序、30 秒目录重签、`cap`/Key 重同步、身份替换、退出钩子。 |
| `src/config.ts` | `state.json`（version 3）的读写。 |
| `src/db.ts` | `ledger.sqlite` 六张表和金额换算（整数 micro-USD）。 |
| `src/grants.ts` | 申请、批准、拒绝、撤销，以及 Gateway Key 的签发/收窄/删除；`D → cap → key` 的唯一实现。 |
| `src/http-router.ts` | 本插件唯一的监听：`<lan>:3426`，只有三个端点。 |
| `src/catalog-service.ts` | `omai/catalog/1` 的构建、签名、解析；改共享只重签内存里的文档。 |
| `src/signing.ts` | 规范化 JSON 与 EIP-191 `personal_sign`/验签。 |
| `src/overlay.ts` | EasyTier no-TUN 生命周期：下载校验、生成 TOML、导出 LAN 地址、分配转发口、重启与停止。 |
| `src/socks.ts` | 经本机 EasyTier SOCKS5 发一个 HTTP 请求。 |
| `src/lan.ts` | 探测要导出的 LAN IPv4（`OH_MY_AIHUB_LAN_IP` 可覆盖，仅供隔离测试）。 |
| `src/addresses.ts` | 稳定的 `10.66.a.b/32` 覆盖网导出前缀。 |
| `src/contacts.ts` | 地址簿：`alias → 地址` 的读写与归一化（去空格、转小写）。 |
| `src/easytier-manifest.ts` | 固定 EasyTier 2.6.4 各平台资产与 SHA-256。 |
| `src/chain.ts` | BSC/Base 注册表、USDC 精度、JSON-RPC 读取与唯一写路径。 |
| `src/chain-watcher.ts` | 每链一个扫描循环：读头、算最终块、按块取 `Transfer` 日志、凭 receipt 入账、复查回滚。 |
| `src/magpie.ts` | Magpie CLI 封装（模型、Gateway Key、Remote Magpie），以及价格能否被冻结的判断。 |
| `src/paths.ts` | 插件数据目录与 `magpie` 可执行文件的解析（`OH_MY_AIHUB_MAGPIE` 可覆盖）。 |
| `src/store.ts` | 原子写 JSON（临时文件 + fsync + rename，保留 `.prev`）。 |
| `src/run.ts` | 唯一启动外部程序的地方：argv 数组，没有 shell。 |
| `src/secure-key.ts` | secure mode 的 X25519 密钥对：首用生成、持久化、注册为日志敏感值。 |
| `src/log.ts` | 脱敏日志（私钥、Key、网络密码、bearer 不落盘）。 |
| `src/tools/*.ts` | 19 个工具；`types.ts` 是工具定义类型，`resolve.ts` 把地址参数里的别名解析成地址，`node-wallet.ts` 是钱包生命周期（不是工具）。 |
| `scripts/build-page.ts` | 把 `page/doc.md` 渲染成 `page/index.html`，渲染器是很小的 Markdown 子集。 |

## 已知限制

1. **私钥只保证「工具不返回」**。导出到文件后，如果 agent 有本机文件读权限，它还是能读到那个文件。这是本机权限问题，插件挡不住。
2. **转 USDC 需要 gas**。地址上没有 BNB/ETH 时 `send_payment` 会失败，`wallet` 会显示 gas 余额。
3. **同一个钱包 = 同一个账户**。两台机器用同一个私钥，余额共享。
4. **价格变更会改变剩余额度**（D13），可能出现剩余为负、Magpie 拒服务，充值即恢复。
5. **覆盖网地址不是身份**。安全靠签名 + Gateway Key + 余额；链路加密由网络决定（secure mode 下中继也不可解密，普通模式下中继能解）。
6. **一笔转错地址的付款无法找回**。`send_payment` 不限目标、不二次确认。
7. **交易所提币地址会成为账户**，但它拿不到 Key，所以那笔钱用不上。
8. **移除连接会重启 EasyTier 核心**（上游 bug），其他连接短暂中断。
9. **一个数据目录一个宿主**。同时开两个 Magpie 指向同一数据目录不成立；没有 host lock，快速重启时会有一段 EasyTier 重试期。
10. **0.1.2171 及更早版本没有 Library 自动接线**，只能手工把 MCP 地址填进 agent。
11. **目录价格最多落后一个 tick**：Magpie 没有改价通知，目录每 30 秒重签。
12. **首次扫描只回溯 24 小时**：全新安装的钱包地址是刚生成的，正常不会有更早的入账；导入一个早已收过钱的私钥则可能漏掉旧记录。
13. **别的机器上的 agent** 要调这些工具，需要 Magpie 打开局域网共享并持有 Gateway Key；本机 agent 默认免 Key。
14. **地址簿不跟钱包走**。别名存在本机 `ledger.sqlite`，换机器或换数据目录要重新录；同一个私钥在两台机器上不共享别名。

## 验证

```sh
cd plugin
bun run typecheck      # tsc --noEmit
bun run build:page     # page/doc.md -> page/index.html，校验 19 个工具名与两个 MCP 地址
```

临时目录 boot 冒烟：`OH_MY_AIHUB_MAGPIE=/nonexistent/magpie OH_MY_AIHUB_LAN_IP=127.0.0.1`，import `plugin/src/index.ts`；默认导出应返回 19 个工具，生成 `wallet/key.hex`（0600）与六张表，`status.network.state = "offline"`。

链上实验只在本地 anvil 或受控模拟 RPC 上做；真实链只做只读。测试文件不提交。

## 明确不做

- 不做控制台、不做 CLI、不做本机管理 API、不做配对。
- 不做 TOFU、证书、PIN、二维码、指纹核对。
- 不做价格锁、价格版本、重签、窗口边界处理、usage 日志导入。
- 不做存款意图、EIP-712 单据、归属认领、对账单、离线账单文件。
- 不做浏览器钱包、托管、多钱包、HD 账户、每消费者独立地址。
- 不做退款、争议、仲裁、撮合、代币、跨链、法币。
- 不做 DHT、mDNS、新路由、中心目录服务器。
- 不做 ENS/域名解析、不做全网友好名、不做跨机同步的通讯录：地址簿只解决本机打字。
- 不把 Magpie 管理界面暴露到覆盖网（唯一例外是 Magpie 自己的模型网关，它本来就要给伙伴用）。

## 工作方式

1. 只信这份文档的产品决策和 `plugin/page/doc.md` 的用户说明；两者冲突时先改文档再改代码。
2. 地址簿（D15）已经落地。下一步先让人在真网里用起来，卡在哪修哪；不要先加新功能。
3. 动代码前先读「授权与钱」和「覆盖网与协议」，两者是唯一对外契约；改它们要先改这份文档。
4. 任何「为了安全再加一层」的想法，先看 D4/D9/D10/D13：这一版是故意不做那些层的。
5. 每次改动一个分支、一个 PR，不做大范围重写。
