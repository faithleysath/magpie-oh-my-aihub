# Oh My AIHub

让你的 Magpie 加入一个私有的 EasyTier 网络，并在网络里和其他节点共享原生模型。

这个版本只提供骨架：**节点钱包、入网、状态**。目录、共享、审批、付款会在后续版本加入。插件没有自己的图形控制台，所有操作都由 agent 通过 Magpie 的 MCP 工具完成。

## 这是什么

- 一个 Magpie 纯后端插件：不加界面、不开本机控制台、不转发 AI 请求。
- 节点身份是一个内置的 EVM 钱包地址。私钥由插件生成，也可以从文件导入或导出；工具永远不会返回私钥。
- 入网就是加入一个 EasyTier 私有覆盖网。网络密码是唯一的入网门，覆盖网内传输是明文 HTTP，不做二次加密或配对。
- 后续版本会让同一个网络里的节点互相公布原生模型，并用链上 USDC 预付结算。当前版本还没有这些功能。

## 三步装好

### 1. 装插件

在 Magpie 的插件里安装：

```
github:faithleysath/magpie-oh-my-aihub
```

装好后插件会自动生成节点钱包。私钥保存在插件数据目录的 `wallet/key.hex`（权限 0600），任何工具都不会把它返回给你。

### 2. 加入网络

让 agent 调用 `magpie-oh-my-aihub_join_network`，参数是网络名、网络密码，以及可选的初始节点。网络名和密码必须和网络里的其他节点一致。

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
| `magpie-oh-my-aihub_join_network` | 加入或修改 EasyTier 网络 | `networkName`, `networkSecret`, `initialNode?` |

本阶段只注册上面 5 个工具。设计里的其余工具会在后续阶段加入，名字保持不变。

`status` 不传 `section` 时返回完整快照；传 `network`、`wallet`、`sharing`、`consuming` 只返回对应部分。

## 首次使用

1. 调 `wallet` 看自己的地址（当前只是看，不要充值）。
2. 调 `join_network` 加入网络。
3. 调 `status`，看到 `state: "online"` 就表示 EasyTier 核心已经跑起来。

> **当前版本不要往这个地址充值。** 还没有链观察器、记账和余额，钱到了不会变成任何可用额度。充值、记账、共享、申请都在后续版本上线后再用。

## 后续版本（现在不可用）

- 共享模型、申请访问、付款、连接伙伴。
- 充值、gas 和链上结算的说明要等阶段 4 的链观察器与记账上线后再补，现在不要按旧文档操作。

## 安全边界

- 工具永远不返回私钥。`wallet_export` 只返回地址和路径；导出后，如果 agent 能读本机文件，它仍然能读到那个文件。这是本机权限问题，插件挡不住。
- 网络密码是唯一的入网门。覆盖网内是明文 HTTP，不做二次加密、不做配对。
- 覆盖网地址不是身份。后续版本的授权靠钱包签名、Gateway Key 和余额。
- 一个钱包就是一台节点的全部身份。两台机器用同一个私钥，就是同一个账户，余额共享。
- 插件不会把 Magpie 管理界面暴露到覆盖网。

## 常见错误

| 错误 | 意思 | 怎么办 |
| --- | --- | --- |
| `E_NO_NETWORK` | 还没有加入网络 | 先调 `join_network` |
| `E_NETWORK_TIMEOUT` | EasyTier 下载、启动或入网失败/超时 | 调 `status` 看 `step` 和 `detail`；首次下载可能需要更久 |
| `E_WALLET_EXISTS` | 已有钱包，且导入的地址不同 | 确认要换身份后传 `force: true` |
| `E_PATH` | 路径不是绝对路径、文件已存在、或写进了插件数据目录 | 换一个绝对路径；导出已存在的文件要传 `overwrite: true` |
| `E_INPUT` | 参数不合法 | 检查参数类型和必填项 |

## 已知限制

- EasyTier 首次下载受网络影响，可能要几十秒。`join_network` 会先返回 `{state:"starting"}`，用 `status` 轮询。
- 没有初始节点或邻居时，EasyTier 核心仍会启动，`status.state` 是 `online`，但 `overlayIp` 可能为空；连上邻居后覆盖网地址才会出现。
- 当前版本没有转账功能。后续版本转账 USDC 需要 gas，`wallet` 会显示 `gasOk`。
- BSC 的 USDC 是 18 位，Base 的 USDC 是 6 位，金额不混用。
- 当前版本还没有共享、申请、付款和 3426 目录服务；看到 `status.sharing` 和 `status.consuming` 为空是正常的。
