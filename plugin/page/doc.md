# Oh My AIHub

让你的 Magpie 加入一个私有的 EasyTier 网络，并在网络里和其他节点共享原生模型。

当前版本（阶段 3）提供：**节点钱包、入网、目录与发现、申请与批准、连接伙伴**。节点入网后会自动把本机 LAN 地址导出到覆盖网，并在固定的 3426 端口公布一份签名的目录；同网络里的其他节点用 `discover` 读到你的模型和价格后，可以签名申请访问，你批准后对方用 `connect_provider` 在自己的 Magpie 里生成一条 Remote Magpie。插件没有自己的图形控制台，所有操作都由 agent 通过 Magpie 的 MCP 工具完成。

## 这是什么

- 一个 Magpie 纯后端插件：不加界面、不开本机控制台、不转发 AI 请求。
- 节点身份是一个内置的 EVM 钱包地址。私钥由插件生成，也可以从文件导入或导出；工具永远不会返回私钥。目录和访问申请都用这把私钥签名，所以别人能证明「这份模型和价格确实是你公布的」。
- 入网就是加入一个 EasyTier 私有覆盖网。网络密码是唯一的入网门，覆盖网内传输是明文 HTTP，不做二次加密或配对。
- 端口是固定的：3426 公布目录、接收申请和轮询，3425 是 Magpie 的模型网关；消费方每个连接用一个本地转发口（13425 起）。改共享模型只改目录内容，不重启 EasyTier 核心。
- 批准只是「给你这些模型」，额度是对方在你这里的充值余额。**阶段 3 没有链观察器**，所以余额永远是 0，批准后状态是「等待充值」，Key 不会发出；这是预期行为。

## 三步装好

### 1. 装插件

在 Magpie 的插件里安装：

```
github:faithleysath/magpie-oh-my-aihub
```

装好后插件会自动生成节点钱包。私钥保存在插件数据目录的 `wallet/key.hex`（权限 0600），任何工具都不会把它返回给你。

### 2. 加入网络

让 agent 调用 `magpie-oh-my-aihub_join_network`，参数是网络名、网络密码，以及可选的初始节点。网络名和密码必须和网络里的其他节点一致。

入网时会探测本机 LAN 地址，并分配一个固定的覆盖网导出地址（首次分配后不再变化）。如果本机没有可用的 LAN 地址（例如只有回环），插件不会导出，`status.network.detail` 会说明，其他功能照常。

### 3. 把 MCP 接给 agent

**Magpie 0.1.2516 及以上**：打开 Library，在 MCP server 里按 agent 打开这个插件。

**更早的版本**：手工把 MCP 地址填进 agent。

全部插件：

```
http://127.0.0.1:3425/mcp/magpie/tools
```

只本插件：

```
http://127.0.0.1:3425/mcp/magpie/tools/magpie-oh-my-aihub
```

本机 agent 默认免 Gateway Key。别的机器上的 agent 要调用这些工具，需要在 Magpie 里打开 **Share on local network**，并给它 Gateway Key。

## 工具

| MCP 名 | 作用 | 参数 |
| --- | --- | --- |
| `magpie-oh-my-aihub_status` | 查看网络、钱包、共享和消费状态 | `section?` |
| `magpie-oh-my-aihub_wallet` | 查看节点地址与 BSC/Base 余额 | 无 |
| `magpie-oh-my-aihub_wallet_import` | 从文件导入私钥 | `path`, `force?` |
| `magpie-oh-my-aihub_wallet_export` | 把私钥导出到文件 | `path`, `overwrite?` |
| `magpie-oh-my-aihub_join_network` | 加入或修改 EasyTier 网络，并公布目录 | `networkName`, `networkSecret`, `initialNode?` |
| `magpie-oh-my-aihub_native_models` | 列出本机原生模型、价格和可否共享 | 无 |
| `magpie-oh-my-aihub_share_models` | 选择要共享的模型，立刻重签目录 | `models` |
| `magpie-oh-my-aihub_discover` | 读取网络里其他节点公布的模型和价格 | `refresh?` |
| `magpie-oh-my-aihub_request_access` | 向一个提供方签名申请模型访问 | `provider`, `models` |
| `magpie-oh-my-aihub_connect_provider` | 轮询批准结果，拿到 Key 后建立连接 | `provider` |
| `magpie-oh-my-aihub_disconnect_provider` | 删除本插件建的 Remote Magpie 和转发 | `provider` |
| `magpie-oh-my-aihub_connections` | 列出本机持有的连接 | 无 |
| `magpie-oh-my-aihub_consumers` | 列出申请者/消费者和余额 | 无 |
| `magpie-oh-my-aihub_approve_request` | 批准申请（可改模型） | `address`, `models?` |
| `magpie-oh-my-aihub_reject_request` | 拒绝还没批准的申请 | `address`, `note?` |
| `magpie-oh-my-aihub_revoke_consumer` | 撤销授权并删除 Gateway Key | `address` |

`status` 不传 `section` 时返回完整快照；传 `network`、`wallet`、`sharing`、`consuming` 只返回对应部分。`status.network.publishedPorts` 在成功导出后是 `[3426, 3425]`，没有导出时为空。`status` 永远不返回 Key。

## 共享与发现

共享是本机的事，发现是网络的事。

1. 调 `native_models` 看本机有哪些原生模型。只有 Magpie 自己的 provider（非 `remote-magpie`）且价格完整的模型才是 `shareable: true`；缺价格的模型会带 `reason: "no-price"`。
2. 调 `share_models`，参数是你想公布的模型 id 列表。空数组表示不共享。写好后目录立刻生效：`GET http://<你的导出地址>:3426/catalog` 里出现这些模型和价格，签名由节点钱包完成，**不重启 EasyTier**。
3. 网络里其他节点调 `discover`，通过本机 EasyTier 的 SOCKS5 读取并严格验签，就能看到你的地址、hostname、模型和价格。改价格或增减模型后，对方再 `discover` 一次（或等 30 秒缓存过期）即可看到新内容。

目录里只有模型、价格、地址、hostname、端口和时间戳，没有联系方式、本机路径和 Key。不共享模型时目录是 `models: []`、`gatewayPort: null`。

## 申请与批准

申请和批准是两个独立动作，各由一方决定：

1. 消费方先 `discover`，然后调 `request_access`，参数是提供方地址和想要的模型 id。插件用消费方钱包对 `{schema, address, models, ts}` 做 personal_sign 后 `POST /request`；提供方验签、记成一条申请。同一个地址重复申请只覆盖「想要什么」，不会撤销已有授权。
2. 提供方用 `consumers` 看到申请（地址、想要的模型、余额、已用、剩余）。调 `approve_request` 批准，可以改模型；只保留当前已共享且有价格的模型，空结果会报 `E_INPUT`。不想给就 `reject_request`。
3. 消费方调 `connect_provider`，它会签名轮询 `GET /request`：
   - `pending`：等批准；
   - `approved` 但没有 Key（`waiting-deposit`）：提供方批了，但余额不足 $0.0001，等充值；
   - `ready`：拿到 Key，本机已有转发和 Remote Magpie；
   - `revoked`：报 `E_REVOKED`。
4. 提供方 `revoke_consumer`：删掉 Magpie 里的 Gateway Key（删除失败会用 rotate 让旧 Key 失效），账目保留。重新批准会再发新 Key，消费方再调一次 `connect_provider` 即可。

## 连接

`connect_provider` 是幂等的，可以反复调用。拿到 Key 后它会：

1. 分配一个本地转发口（13425 起），记进 `state.json.connections`；
2. 用 EasyTier CLI 加一条 `127.0.0.1:<本地口>` → `<对方导出地址>:3425` 的转发（加转发不需要重启）；
3. 在 Magpie 里注册一条 Remote Magpie：`provider add remote-magpie <key> url=http://127.0.0.1:<本地口> id=omai-<地址后 8 位>`；
4. 读回模型列表，确认至少一个被批准的模型可见，才返回 `ready`。

`disconnect_provider` 只删除本插件建的那条 Remote Magpie（id 以 `omai-` 开头），然后重启 EasyTier 核心让本地转发真正消失——EasyTier 2.6.4 无法在运行时删除转发，所以**其他连接会短暂中断**，返回值里会说明。

## 首次使用

1. 调 `wallet` 看自己的地址（当前只是看，不要充值）。
2. 调 `join_network` 加入网络。
3. 调 `status`，看到 `state: "online"` 就表示 EasyTier 核心已经跑起来；`publishedPorts` 里有 3426 和 3425 表示导出成功。
4. 调 `native_models`，再调 `share_models` 选几个 `shareable` 的模型。
5. 调 `discover` 看同网络里的其他节点公布了什么。
6. 想用别人的模型：`request_access`，等对方 `approve_request`，再 `connect_provider`。对方的余额为 0 时你会拿到 `waiting-deposit`，这是正常的。
7. 想给别人用：用 `consumers` 看申请，`approve_request` 批准。

> **当前版本不要往这个地址充值。** 阶段 3 还没有链观察器、记账和入账，钱到了不会变成任何可用额度，也不会自动发 Key。充值、付款、出金在阶段 4 上线后再用。

## 后续版本（现在不可用）

- 充值、链上观察、按付款方记账、cap 重算、回滚（阶段 4）。
- 付款与出金（`send_payment`）、历史（`history`）。
- 现在 `consumers.unclaimed` 恒为空、余额恒为 `0.0000`，是正常的。

## 安全边界

- 工具永远不返回私钥。`wallet_export` 只返回地址和路径；导出后，如果 agent 能读本机文件，它仍然能读到那个文件。这是本机权限问题，插件挡不住。
- Gateway Key 只通过「提供方 → 消费方」的签名轮询交付给对应地址，不写日志、不进 `status`、不出现在任何其他工具返回值里。
- 网络密码是唯一的入网门。覆盖网内是明文 HTTP，不做二次加密、不做配对。
- 覆盖网地址不是身份，只是路由线索。目录与申请都由签名证明，签名者必须就是文档里的 `address`；验不过的节点在 `discover` 里显示 `online: false`，`request_access` 会报 `E_PEER_OFFLINE`。
- 一个钱包就是一台节点的全部身份。两台机器用同一个私钥，就是同一个账户，余额共享。
- 插件不会把 Magpie 管理界面暴露到覆盖网。对外只开放 3426 目录/申请/轮询和 3425 模型网关两个端口。

## 常见错误

| 错误 | 意思 | 怎么办 |
| --- | --- | --- |
| `E_NO_NETWORK` | 还没有加入网络 | 先调 `join_network` |
| `E_NETWORK_TIMEOUT` | EasyTier 下载、启动或入网失败/超时 | 调 `status` 看 `step` 和 `detail`；首次下载可能需要更久 |
| `E_PEER_OFFLINE` | 对方不在线、没有导出地址、目录验签不过，或读不到邻居 | 调 `status` 确认 `state` 是 `online`，再 `discover` 看谁在线 |
| `E_NOT_APPROVED` | 对方没有你的申请 | 先调 `request_access` |
| `E_REVOKED` | 对方撤销了授权 | 请对方重新批准，再 `connect_provider` |
| `E_MAGPIE` | 找不到/读不到本机 Magpie，或 Key、Remote Magpie 注册失败 | 确认 Magpie 正在运行；必要时设置 `OH_MY_AIHUB_MAGPIE` 指向它的可执行文件 |
| `E_WALLET_EXISTS` | 已有钱包，且导入的地址不同 | 确认要换身份后传 `force: true` |
| `E_PATH` | 路径不是绝对路径、文件已存在，或写不进状态文件 | 换一个绝对路径；导出已存在的文件要传 `overwrite: true` |
| `E_INPUT` | 参数不合法、批准的模型都不在共享范围里、或对方限流 | 用 `native_models` 里 `shareable: true` 的 id，先 `share_models` |

## 已知限制

- EasyTier 首次下载受网络影响，可能要几十秒。`join_network` 会先返回 `{state:"starting"}`，用 `status` 轮询。
- 目录只在同一个覆盖网内可读。对方没有导出地址、核心没起来、或端口被占时，`discover` 会把该节点标成 `online: false` 并给出原因。
- `discover` 结果缓存 30 秒；想看最新目录传 `refresh: true`。申请与连接复用的是这份缓存里的对方导出地址，所以对方换地址后要重新 `discover`。
- 没有初始节点或邻居时，EasyTier 核心仍会启动，`status.state` 是 `online`，但 `overlayIp` 可能为空；连上邻居后覆盖网地址才会出现。
- `disconnect_provider` 会重启 EasyTier 核心（上游 2.6.4 的 bug），其他连接短暂中断。
- `used`（已用额度）由 Magpie 自己的 Key 用量读出，`consumers` 会刷新并缓存；`status` 和轮询只报最近一次的值。阶段 3 没有真实用量，都是 0。
- BSC 的 USDC 是 18 位，Base 的 USDC 是 6 位，金额不混用。
- 目录里的价格单位是「USD / 1M tokens」，和 Magpie 自己记录的价格一致。
