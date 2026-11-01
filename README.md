# Oh My AIHub

Magpie 的纯后端插件：把自己的 Magpie 模型共享给同一个 EasyTier 私有网里的伙伴，或使用伙伴共享的模型。没有界面、没有本机控制台、不开第二个 AI 网关——所有操作由 agent 通过 MCP 工具完成。

节点身份是一个内置的 EVM 钱包地址。共享的模型和价格由这把私钥签名发布；别人向你地址转入的 USDC 就是可用额度（`cap = 已确认入账总额 D`）；谁批准谁发 Gateway Key。AI 请求始终走「你的应用 → 你的 Magpie → EasyTier → 伙伴的 Magpie」，插件只负责组网、签名目录、申请/审批和记账。

## 安装

1. 打开 Magpie 的 **Plugins → Discover**。
2. 如果搜不到，在列表底部用手动添加入口填：`github:faithleysath/magpie-oh-my-aihub`
3. 打开 **Oh My AIHub** 插件页——那一页就是用户手册（这是什么、快速开始、常用说法、需要知道的、工具名）。
4. 让 agent 用 `join_network` 加入网络，其余按插件页走。

插件装好后会自动生成节点钱包，私钥在插件数据目录的 `wallet/key.hex`（`0600`）。插件不写 Magpie 选项，也不读它的管理接口。

## 把工具接给 agent

| 用途 | MCP 地址 |
| --- | --- |
| 全部插件 | `http://127.0.0.1:3425/mcp/magpie/tools` |
| 只本插件 | `http://127.0.0.1:3425/mcp/magpie/tools/magpie-plugin` |

Magpie 0.1.2516 起插件自动成为 Library 里的一个 MCP server，按 agent 打开即可；更早的版本手工填上面的 URL。开了 MCP 路由时，agent 拿到的是 `magpie` 一个服务器（`/mcp/magpie/hub/<agent>`），工具名是 `magpie-plugin__<tool>`；关掉路由时，每个服务器单独一条，本插件是 `/mcp/magpie/tools/magpie-plugin`，工具名不带前缀。本机 agent 免 Gateway Key；别的机器上的 agent 需要 Magpie 打开 **Share on local network** 并拿到 Gateway Key。

18 个工具。只本插件的地址没有前缀；全部插件地址是 `magpie-plugin_<tool>`；走 MCP 路由时是 `magpie-plugin__<tool>`：

| 分类 | 工具 |
| --- | --- |
| 节点 | `status`、`wallet`、`wallet_import`、`wallet_export`、`join_network` |
| 提供方 | `native_models`、`share_models`、`consumers`、`approve_request`、`reject_request`、`revoke_consumer` |
| 消费方 | `discover`、`request_access`、`connect_provider`、`disconnect_provider`、`connections` |
| 钱 | `send_payment`、`history` |

## 安全边界

- **网络密码是唯一的入网门**。同一个 EasyTier 私有网里的节点彼此可达，覆盖网内是明文 HTTP，插件不做二次加密、不做配对、不做节点信任列表。
- **私钥只在本机**。工具永远不返回私钥；`wallet_export` 只写到本机文件。导出之后能读到那个文件的人（包括 agent）就能拿走它，这是本机权限问题，插件挡不住。
- **插件不转发 AI 请求**。它不代理、不计 token、不另写请求账单；用量和限额都在 Magpie 自己的 Gateway Key 上。
- 覆盖网地址不是身份，只是路由线索。目录和申请靠签名证明「这份模型和价格确实是这个地址公布的」，签名者必须等于文档里的 `address`。
- 对外只开两个端口：`3426` 目录/申请/轮询，`3425` Magpie 模型网关。Magpie 管理界面永远不映射到覆盖网。
- Gateway Key 只通过「提供方 → 消费方」的签名轮询交付给对应地址，不落日志、不进 `status`。
- 一个钱包就是一台节点的全部身份；两台机器用同一个私钥就是同一个账户，余额共享。

## 文档

| 文档 | 是什么 |
| --- | --- |
| [README.md](README.md) | 安装、MCP 接线、工具列表、安全边界。 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **架构与维护者参考**。产品决策、协议、数据文件、Magpie 集成事实、已知限制、验证状态。 |
| [AGENTS.md](AGENTS.md) | 本地开发约定。 |

插件页 `plugin/page/doc.md` 是用户手册（构建产物 `plugin/page/index.html`，也就是 Magpie 里那一页）。

类型检查：`cd plugin && bun run typecheck`。文档页由 `cd plugin && bun run build:page` 从 `page/doc.md` 渲染。
