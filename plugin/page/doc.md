# Oh My AIHub

Oh My AIHub 让 Magpie 加入一个私有的 EasyTier 网络，和网络里的人互相共享模型。共享的模型按 Magpie 里的价格计费；用别人的模型，按对方的价格从你充值的额度里扣。没有自己的界面，所有操作都由 agent 通过 MCP 工具完成。

## 整体思路

- **共享**：把本机原生模型和价格公布到网络。
- **使用**：发现别人的模型，申请、对方批准，自动变成你 Magpie 里的一条 Remote Magpie。
- **付费**：往对方地址转 USDC，插件按付款地址记账，额度 = 累计充值。
- **身份**：每个节点一个 EVM 钱包，目录和申请都用它签名。

## 快速开始

### 1. 把工具接给 agent

打开 Magpie，进 **资源库 → MCP 服务器**，找到 `magpie-plugin`（本插件），点 agent 圆点，把常用的 agent 点亮。改完重启 agent。

agent 拿到的工具名取决于 **MCP 路由**：

- **关闭**：本插件单独一条，工具名是 `status`、`wallet`…。
- **开启**：agent 只拿到一个 `magpie` 服务器，工具名是 `magpie-plugin__status`。

手工加服务器：

- 全部插件：`http://127.0.0.1:3425/mcp/magpie/tools`
- 只本插件：`http://127.0.0.1:3425/mcp/magpie/tools/magpie-plugin`
- MCP 路由：`http://127.0.0.1:3425/mcp/magpie/hub/<agent>`

本机 agent 默认免 Gateway Key。别的机器上的 agent 要调这些工具，需要在 Magpie 里打开 **Share on local network**，并给它一个 Gateway Key。

### 2. 第一次对话

准备网络名、网络密码，想好共享哪些模型。把下面这段发给 agent：

```text
用 Oh My AIHub 帮我做首次设置，一步一步来：
1. 先 status 和 wallet，
   把地址和网络状态告诉我；
2. 我加入网络：
   名字 <网络名>，密码 <网络密码>，
   初始节点 <可选>；
   入网后用 status 确认 online；
3. 用 native_models 列出可共享的模型和价格，
   问我共享哪些，再 share_models；
4. 用 discover 汇总网络里别人的模型和价格。
不要动钱，不要导出私钥；参数不确定先问我。
```

好的 agent 会先读状态，再问你要网络名和密码；入网后才列模型、做发现。

入网成功的标志是 `network.state` 为 `online`、`publishedPorts` 为 `[3426, 3425]`。`publishedPorts` 为空只说明本机没有可用的 LAN 地址，别人看不到你，其他功能正常。

> 首次入网要下载 EasyTier，几十秒很正常。`join_network` 返回 `starting` 时继续用 `status` 轮询。

只想用别人的模型？第 3 步回答「不共享」就行。

## 常用说法

不用记工具名，直接说目的。下面每一条都可以发给 agent；把 `A`、`B`、`张三`、`0xabc…` 换成你的模型、名字和地址。先把它存进地址簿，后面就只说名字。

### 看状态

- 「用一句话总结现在的状态：网络、共享、连接。」
- 「我的节点钱包地址是什么？两条链上还有多少 USDC 和 gas？」

### 入网和身份

- 「帮我加入 EasyTier 网络：名字 X，密码 Y，初始节点 Z。」
- 「把节点私钥导出到 /Users/me/omai.key，不要打印私钥；换机器时告诉我怎么导入。」

### 地址簿

- 「把 0xabc… 存成“张三”，备注“提供方 · Base”。」
- 「地址簿里都有谁？把名字和地址列出来。」
- 「张三换成新地址 0xdef… 了，改一下地址簿。」
- 「删掉地址簿里的张三。」
- 「给张三充 5 USDC（Base）。」——直接说名字就行，agent 会先把名字换成地址再转。

名字只有本机认识：不进签名、不进目录，对方看不到，也不是转账白名单。同名重写会立刻改指向，返回里的 `previousAddress` 是它换掉的旧地址。

### 共享

- 「列出可以共享的模型和价格，我选 A、B 共享。」
- 「停止共享所有模型，保留网络连接。」
- 「列出所有申请者，谁在等我批准？」
- 「批准张三使用 A、B；余额不够就告诉我还差多少。」
- 「拒绝张三的申请，备注“暂时不开放”。」
- 「撤销张三的访问，确认 Key 已经删掉。」

### 用别人的模型

- 「discover 一下，把在线节点、模型和价格整理成表。」
- 「我想用张三的 A 模型，帮我申请；批了就直接连接。」
- 「看看 0xabc… 批了没有；批了但没 Key 就告诉我还差多少充值。」
- 「列出我所有的外部连接：模型、剩余额度、状态。」
- 「断开 0xabc…，告诉我会不会影响其他连接。」
- 「对方换了地址，discover 加 refresh 重新找，再重连。」
- 「连接成功了，但 Magpie 里看不到模型，查一下差在哪。」

### 钱

- 「给张三充 5 USDC（Base），先查余额和 gas 再发。」
- 「把 10 USDC 转到 0xdef…（BSC），先告诉我余额和预计 gas。」
- 「列出最近的入账和出金，标出 unknown 和 reverted。」

### 出问题

- 「status 看 network 的 step 和 detail，告诉我卡在哪。」
- 「我的调用被 429 或 401 了，查剩余额度和授权状态，告诉我该充值还是重新申请。」
- 「连接断了，先 discover 看对方在不在，再决定重连。」
- 「这笔交易的哈希是 0x…，帮我核对上链没有；不要重发。」
- 「wallet 显示哪条链 gas 不够？告诉我补哪种原生币。」

agent 报 `E_` 开头的错误时，把错误原文贴回去，让它按上面的顺序查。

## 需要知道的

- **充值**：必须从自己的节点钱包付给提供方。交易所直接提到提供方地址，钱记在交易所名下，你用不上。
- **到账**：不是即时。BSC 15 个确认，Base `finalized`，插件每 15 秒扫一次。
- **私钥**：不会通过工具返回；`wallet_export` 只给地址和路径。导出后，能读本机文件的 agent 仍然能读到它。
- **网络**：密码是唯一入网门；覆盖网里是明文 HTTP。地址不是身份，目录和申请靠签名。
- **转账和断开**：`send_payment` 没有二次确认、没有白名单；断开连接会重启 EasyTier，其他连接短暂中断。
- **地址簿**：只是本机的名字→地址表，存在 `ledger.sqlite`。它不参与签名、不进目录、不参与授权，也不挡转账——改了指向下一次调用就生效。
- **额度**：价格改了，剩余额度会跟着变。429 是额度用完，充值即恢复；401 是被撤销，要提供方重新批准。
- **身份**：同一个钱包 = 同一个账户；两台机器用同一个私钥，余额共享。

## 工具

需要查工具名时看这里。工具名取决于接入方式：路由关闭时是 `status`，路由开启时是 `magpie-plugin__status`，手工加全部插件地址时是 `magpie-plugin_status`。

- 节点：`magpie-plugin_status`、`magpie-plugin_wallet`、`magpie-plugin_wallet_import`、`magpie-plugin_wallet_export`、`magpie-plugin_join_network`
- 地址簿：`magpie-plugin_contacts`（`action` 为 `list` / `add` / `remove`，三个动作一个工具）
- 共享：`magpie-plugin_native_models`、`magpie-plugin_share_models`
- 发现与申请：`magpie-plugin_discover`、`magpie-plugin_request_access`、`magpie-plugin_connect_provider`、`magpie-plugin_disconnect_provider`、`magpie-plugin_connections`
- 审批：`magpie-plugin_consumers`、`magpie-plugin_approve_request`、`magpie-plugin_reject_request`、`magpie-plugin_revoke_consumer`
- 钱：`magpie-plugin_send_payment`、`magpie-plugin_history`
