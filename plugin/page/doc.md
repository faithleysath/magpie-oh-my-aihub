# Oh My AIHub

让你的 Magpie 加入一个私有的 EasyTier 网络，并在网络里和其他节点共享原生模型。

当前版本（阶段 2）提供：**节点钱包、入网、目录与发现**。节点入网后会自动把本机 LAN 地址导出到覆盖网，并在固定的 3426 端口公布一份签名的目录；同网络里的其他节点用 `discover` 就能读到你的模型和价格。插件没有自己的图形控制台，所有操作都由 agent 通过 Magpie 的 MCP 工具完成。

## 这是什么

- 一个 Magpie 纯后端插件：不加界面、不开本机控制台、不转发 AI 请求。
- 节点身份是一个内置的 EVM 钱包地址。私钥由插件生成，也可以从文件导入或导出；工具永远不会返回私钥。目录用这把私钥签名，所以别人能证明「这份模型和价格确实是你公布的」。
- 入网就是加入一个 EasyTier 私有覆盖网。网络密码是唯一的入网门，覆盖网内传输是明文 HTTP，不做二次加密或配对。
- 端口是固定的：3426 公布目录，3425 是 Magpie 的模型网关。入网时生成的 ACL 只放行这两个端口；改共享模型只改目录内容，不重启 EasyTier 核心。
- 审批、Gateway Key 和链上预付结算还在后续版本，当前版本不涉及付款。

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

`status` 不传 `section` 时返回完整快照；传 `network`、`wallet`、`sharing`、`consuming` 只返回对应部分。`status.network.publishedPorts` 在成功导出后是 `[3426, 3425]`，没有导出时为空。

## 共享与发现

共享是本机的事，发现是网络的事。

1. 调 `native_models` 看本机有哪些原生模型。只有 Magpie 自己的 provider（非 `remote-magpie`）且价格完整的模型才是 `shareable: true`；缺价格的模型会带 `reason: "no-price"`。
2. 调 `share_models`，参数是你想公布的模型 id 列表。空数组表示不共享。写好后目录立刻生效：`GET http://<你的导出地址>:3426/catalog` 里出现这些模型和价格，签名由节点钱包完成，**不重启 EasyTier**。
3. 网络里其他节点调 `discover`，通过本机 EasyTier 的 SOCKS5 读取并严格验签，就能看到你的地址、hostname、模型和价格。改价格或增减模型后，对方再 `discover` 一次（或等 30 秒缓存过期）即可看到新内容。

目录里只有模型、价格、地址、hostname、端口和时间戳，没有联系方式、本机路径和 Key。不共享模型时目录是 `models: []`、`gatewayPort: null`。

## 首次使用

1. 调 `wallet` 看自己的地址（当前只是看，不要充值）。
2. 调 `join_network` 加入网络。
3. 调 `status`，看到 `state: "online"` 就表示 EasyTier 核心已经跑起来；`publishedPorts` 里有 3426 和 3425 表示导出成功。
4. 调 `native_models`，再调 `share_models` 选几个 `shareable` 的模型。
5. 调 `discover` 看同网络里的其他节点公布了什么。

> **当前版本不要往这个地址充值。** 还没有链观察器、记账和余额，钱到了不会变成任何可用额度。充值、申请、批准、付款都在后续版本上线后再用。

## 后续版本（现在不可用）

- 申请访问（`request_access`）、批准与撤销、Gateway Key 签发。
- 连接伙伴（`connect_provider`），在本机生成 Remote Magpie。
- 充值、链上记账、出金；gas 和结算说明要等阶段 4 的链观察器上线后再补。
- 当前 `status.consuming` 恒为空，是正常的。

## 安全边界

- 工具永远不返回私钥。`wallet_export` 只返回地址和路径；导出后，如果 agent 能读本机文件，它仍然能读到那个文件。这是本机权限问题，插件挡不住。
- 网络密码是唯一的入网门。覆盖网内是明文 HTTP，不做二次加密、不做配对。
- 覆盖网地址不是身份，只是路由线索。目录里的地址由签名证明，签名者必须就是目录里的 `address`；验不过的节点在 `discover` 里显示 `online: false`。
- 一个钱包就是一台节点的全部身份。两台机器用同一个私钥，就是同一个账户，余额共享。
- 插件不会把 Magpie 管理界面暴露到覆盖网。对外只开放 3426 目录和 3425 模型网关两个端口。

## 常见错误

| 错误 | 意思 | 怎么办 |
| --- | --- | --- |
| `E_NO_NETWORK` | 还没有加入网络 | 先调 `join_network` |
| `E_NETWORK_TIMEOUT` | EasyTier 下载、启动或入网失败/超时 | 调 `status` 看 `step` 和 `detail`；首次下载可能需要更久 |
| `E_PEER_OFFLINE` | EasyTier 核心没在跑，读不到邻居 | 调 `status` 确认 `state` 是 `online` |
| `E_MAGPIE` | 找不到或读不到本机 Magpie | 确认 Magpie 正在运行；必要时设置 `OH_MY_AIHUB_MAGPIE` 指向它的可执行文件 |
| `E_WALLET_EXISTS` | 已有钱包，且导入的地址不同 | 确认要换身份后传 `force: true` |
| `E_PATH` | 路径不是绝对路径、文件已存在、或写进了插件数据目录 | 换一个绝对路径；导出已存在的文件要传 `overwrite: true` |
| `E_INPUT` | 参数不合法，或共享了不可共享的模型 | 用 `native_models` 里 `shareable: true` 的 id |

## 已知限制

- EasyTier 首次下载受网络影响，可能要几十秒。`join_network` 会先返回 `{state:"starting"}`，用 `status` 轮询。
- 目录只在同一个覆盖网内可读。对方没有导出地址、核心没起来、或端口被占时，`discover` 会把该节点标成 `online: false` 并给出原因。
- `discover` 结果缓存 30 秒；想看最新目录传 `refresh: true`。
- 没有初始节点或邻居时，EasyTier 核心仍会启动，`status.state` 是 `online`，但 `overlayIp` 可能为空；连上邻居后覆盖网地址才会出现。
- 当前版本没有转账功能。后续版本转账 USDC 需要 gas，`wallet` 会显示 `gasOk`。
- BSC 的 USDC 是 18 位，Base 的 USDC 是 6 位，金额不混用。
- 目录里的价格单位是「USD / 1M tokens」，和 Magpie 自己记录的价格一致。
