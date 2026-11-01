# Oh My AIHub 插件（维护者速查）

用户文档在 [`page/doc.md`](page/doc.md)（构建产物 `page/index.html`，也就是 Magpie 里那一页）。产品规格和上游事实在 [`../docs/DESIGN-V2.md`](../docs/DESIGN-V2.md)。这里只写维护者需要知道的东西。

自检：

```sh
cd plugin
bun run typecheck      # tsc --noEmit，src 全部通过
bun run build:page     # page/doc.md -> page/index.html，并校验 18 个工具名与 MCP 地址都在文档里
```

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口。默认导出同步返回 `{tool}` 的 18 个工具，真实工作在后台 `boot()`；Magpie 加载插件时等的就是这个返回值。 |
| `src/runtime.ts` | 一个宿主进程一个运行时：boot 顺序、30 秒目录重签、`cap`/Key 的后台重同步、`wallet_import` 后的身份替换、退出钩子。 |
| `src/config.ts` | `state.json`（version 3）的读写：网络、共享选择、覆盖网导出、消费方连接、hostname。 |
| `src/db.ts` | `ledger.sqlite`：`deposits`、`requests`、`consumers`、`payouts`、`meta` 五张表和金额换算（整数 micro-USD）。 |
| `src/grants.ts` | 申请、批准、拒绝、撤销，以及 Gateway Key 的签发/收窄/删除；`D → cap → key` 的唯一实现。 |
| `src/http-router.ts` | 本插件唯一的监听：`<lan>:3426`，只有 `GET /catalog`、`POST /request`、`GET /request?…` 三个端点。 |
| `src/catalog-service.ts` | `omai/catalog/1` 目录文档的构建、签名、解析；改共享只重签内存里的文档，不重启 EasyTier。 |
| `src/signing.ts` | 规范化 JSON 与 EIP-191 `personal_sign`/验签，三种文档共用。 |
| `src/overlay.ts` | EasyTier no-TUN 生命周期：下载校验、生成 TOML、导出 LAN 地址、分配转发口、重启与停止。 |
| `src/socks.ts` | 经本机 EasyTier SOCKS5（`127.0.0.1:13400`）发一个 HTTP 请求，用来读别人的目录/交申请。 |
| `src/lan.ts` | 探测要导出的 LAN IPv4（`OH_MY_AIHUB_LAN_IP` 可覆盖，仅供隔离测试）。 |
| `src/addresses.ts` | 稳定的 `10.66.a.b/32` 覆盖网导出前缀。 |
| `src/easytier-manifest.ts` | 固定 EasyTier 2.6.4 各平台资产与 SHA-256。 |
| `src/chain.ts` | BSC/Base 注册表、USDC 精度、JSON-RPC 读取与唯一写路径（ERC-20 `transfer`，只广播一次）。 |
| `src/chain-watcher.ts` | 每链一个扫描循环：读头、算最终块、按块取 `Transfer` 日志、凭 receipt 入账、复查重组回滚。 |
| `src/magpie.ts` | Magpie CLI 封装（模型、Gateway Key、Remote Magpie），以及"这个价格能不能被冻结"的判断。 |
| `src/paths.ts` | 插件数据目录与 `magpie` 可执行文件的解析（`OH_MY_AIHUB_MAGPIE` 可覆盖）。 |
| `src/store.ts` | 原子写 JSON（临时文件 + fsync + rename，保留 `.prev`）。 |
| `src/run.ts` | 唯一启动外部程序的地方：argv 数组，没有 shell。 |
| `src/log.ts` | 脱敏日志（私钥、Key、网络密码、bearer 不落盘）。 |
| `src/tools/*.ts` | 18 个工具，按提供方/消费方/钱/节点分组；`types.ts` 是工具定义类型，`node-wallet.ts` 是钱包生命周期（不是工具）。 |
| `scripts/build-page.ts` | 把 `page/doc.md` 渲染成 `page/index.html`，渲染器是很小的 Markdown 子集，产物不带脚本、不发请求。 |

`plugin/` 里没有别的东西了：没有控制台前端、没有 CLI、没有 P2P 模块、没有旧钱包/账本。

## 状态文件

都在 Magpie 的插件数据目录（`<magpie 数据目录>/oh-my-aihub/`）：

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `state.json` | `{version:3, network:{name,secret,initialNode}, share:{models}, publish:{mappedCidr}, connections:[{provider, localPort, mappedHost}], hostname}`；上一版留 `.prev` | `0600` |
| `wallet/key.hex` | 节点私钥。工具永远不返回它 | `0600` |
| `ledger.sqlite` | 入账、申请、消费者、出金、扫描游标；WAL，`-wal`/`-shm` 同行 | `0600` |
| `easytier/current.toml` | 生成的 EasyTier 配置（导出、ACL、SOCKS5、逐连接转发） | `0600` |
| `plugin.log` | 脱敏日志（私钥、Gateway Key、网络密码不落盘） | `0600` |

`consumers.key_secret` 必须落盘（要交给对方），和 Magpie 自己的 `caller-keys.json` 同级敏感度。

## 数据流

**出站目录（提供方）。** 共享选择写进 `state.json` → `CatalogService` 用节点私钥签一份 `omai/catalog/1` → `http-router.ts` 在 `<lan>:3426` 上 `GET /catalog` 返回它。EasyTier 用 `[[proxy_network]]` 把这个 LAN 地址导出成 `publish.mappedCidr`，Forward ACL 只放行 `3426` 和 `3425`。`runtime.ts` 每 30 秒重读一次 Magpie 的价格并重签（Magpie 没有价格变更通知，而规格接受新价格适用于旧用量），所以改价一个 tick 内就到对端；重签在内存里完成，从不重启核心。

**三个端点。**

- `GET /catalog` —— 目录。读取方校验 `schema`、验签、要求签名者等于 `address`、字段与长度上限、≤64 KiB、5 秒超时，未知字段直接拒绝。
- `POST /request` —— 签名申请，按 `address` 覆盖写一条，`≤16 KiB`，每地址 30 次/分钟。
- `GET /request?address=&ts=&sig=` —— 签名轮询。批准且余额 `≥ $0.0001` 时返回 `key`，否则 `key: null`；`waiting-deposit` 只是「已批准但没有钱」的读法，协议里没有这个状态。

**入站目录（消费方）。** `discover` 经 `127.0.0.1:13400` 的 SOCKS5 拨对方 `10.66.x.y:3426`，不建转发、不开自己的监听（EasyTier 2.6.4 的转发删不掉，能不开就不开）。结果缓存 30 秒。

**钱。** `chain-watcher.ts` 从 boot 就开始扫，不等 `join_network`：入账是发到钱包地址的，跟覆盖网无关。每 15 秒读一次头、算最终块（BSC 用 15 个确认，因为它的 `finalized` 等于 `latest`；Base 用 `finalized` 标签），从游标扫到最终块，只认 `to` 是本节点地址、合约是该链 USDC 的 `Transfer`，并且必须有 receipt（拿不到就停在原游标重试）。入账行和游标在同一个 SQLite 事务里写，唯一键 `(chain_id, token, tx_hash, log_index)` 挡住重复。最近窗口内的已入账块会复查 `block_hash`，不再规范就标 `reverted`（不删、不退款）并把额度往下重算。

`cap = D`：`grants.ts` 把某个付款方地址在两条链上已确认入账的总额 `D` 换成 micro-USD，再向下取到 Magpie 的 `$0.0001` 网格，写进那个人 Gateway Key 的 cost limit。`D < $0.0001` 时不发 Key（Magpie 把 `--cost 0` 当无限额）。每次入账、回滚、撤销、身份变更都会重算整条链，boot 时也会再跑一次，补上"账本写了但 Magpie 没写"的缺口，并清掉本插件留下的、不指向任何授权消费者的 Key。

## 已知限制（代码里能看到的）

1. **55 秒**。Magpie 的工具超时是 55 秒，所以首次下载 EasyTier、入网这类长操作一律返回 `{state:"starting"}`，由 `status` 轮询进度。不要在工具里做同步长等待。
2. **删除转发要重启核心**。EasyTier 2.6.4 的 `port-forward remove` 会打印成功但监听不消失，所以 `disconnect_provider` 会重启 EasyTier，其他连接短暂中断——返回值里必须说明这点。
3. **价格变更按新价重算**。目录 30 秒重签一次，`cap` 不动、`used` 会变；剩余为负时 Magpie 自己返回 429，Key 保留，充值即恢复。被撤销的地址返回 401，需要提供方重新批准。
4. `discover` 有 30 秒缓存（`refresh:true` 强制重读）；`connections` 每次实时轮询，对方离线时回退到上次结果。
5. 没有初始节点或邻居时核心仍会起来、`state` 是 `online`，但 `overlayIp` 可能为空。
6. BSC 的 USDC 是 18 位、Base 是 6 位，金额不混用；`send_payment` 只广播一次，`E_TX_UNKNOWN` 要用哈希人工核对，不自动重发。
7. EasyTier 首次下载依赖网络，几十秒很正常；下载的资产必须匹配 `easytier-manifest.ts` 里的 SHA-256，不匹配不运行。

## 重新验证

`build:page` 会在渲染前检查 `page/doc.md` 里 18 个 `magpie-oh-my-aihub_<tool>` 名和 MCP 地址都在，改工具名或仓库名要同步改文档页，否则构建直接失败。
