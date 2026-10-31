# A-lab 真实浏览器验收（HEAD 1c14ec4）

> 环境：两个隔离 Magpie 0.1.2289 + EasyTier 2.6.4（f63b644e 提供并持有；同机 lab，不代表 NAT/WAN）。
> 方式：只用 Magpie UI 安装/打开/配对；真实 join/share/discovery；未用 CLI 补步骤，未换 fixture。
> 结论：**真实 E2E 主路径 PASS**（安装/配对/三字段 join/peer/一次分享/对端目录发现），但发现 **2 个真实 UI 缺陷**（分享按钮 disabled 不同步、停止共享按钮未分享时可见），另有 1 个邻居计数观察项。

## 0. 版本与身份证明

| 项 | provider | consumer |
|---|---|---|
| HEAD | `1c14ec4d4accf68dfef161c5f85bc8a18e6f6bf8` | 同 |
| console 5 文件 hash | 与 HEAD 逐一相等（`alab-1c14ec4.sha256`） | 同 |
| ownerPid == status.pid == console 监听 | 40211 == 40211 == 55659 | 72808 == 72808 == 56555 |
| Magpie web pid（f63b 提供） | 17798 | 17876 |
| 节点 | ohmyaihub-5252ffc0 / 10.77.0.141/24 | ohmyaihub-9551aff0 / 10.77.0.196/24 |

## 1. 主路径（PASS）

| 步骤 | 观察 |
|---|---|
| provider 安装 → 打开控制台 → 匿名壳 → 8 位配对 | `控制台已连接`；配对批准后宿主重启并恢复 |
| 首配三字段（名称/密钥/初始节点留空）→ 连接网络 | loading 文案「正在写入配置并连接私有网络…」；结果 `检查通过`、`网络引擎正在运行 · EasyTier easytier-core 2.6.4-8428a89d`；无错误 |
| consumer 安装 → 配对 → 三字段 + `tcp://127.0.0.1:11010` | `检查通过`；ET 2.6.4 运行；无错误 |
| 双向 peer | provider 看到 B（tcp / 未知路径），consumer 看到 A；都带「本机」行 |
| 目录发现默认开 | 发现页按钮为「关闭目录发现」，无需额外开关 |
| 一次分享（服务结果） | 我的共享已自动检测 `provider/provider-model`；确认框「将要分享 1 个本机模型…」→ 勾选确认 → `确认分享`；notice「已分享所选模型；目录发布状态以下方真实状态为准。」。**注意：点击前必须先触发搜索重渲染（见 F1），不是正常控件路径** |
| 分享后状态 | 首页「正在共享 1 个模型 / 目录已发布 · 0 个已授权伙伴」；网络页「目录发布 已发布」；我的目录身份可查看/复制指纹 |
| 对端发现 | consumer 刷新目录即见 `ohmyaihub-5252ffc0 / 身份待确认 / 1 个模型 · 在线 / 未提供联系方式` + `provider/provider-model $1000/$1000`；三个动作可见 |
| 可见 ≠ 可用 | consumer 首页「可用模型：尚未连接」（目录可见但没有 Remote 连接），钱包「资产余额 尚未查询」，提供者信用单列 |
| 端口只读 | 网络 → 诊断：listen/RPC/目录/查询四项均为 `dl` 文本（无输入） |
| 窄屏 / 主题 / 键盘 / 减动效 | 390 无横向滚动、底栏 5 项；深色可切换且刷新保持；Tab 顺序 skip-link→5 导航→主题→页面动作，outline 3px；`prefers-reduced-motion` 下动效计数 0 |

## 1.5 Remote / forward 迁移后的 UI 复核（f63b 实验 fixture，独立 PASS）

| 项 | UI 观察 |
|---|---|
| 我的连接 | `ohmyaihub-5252ffc0` · 已连接 · 原生 Remote Magpie · **peer-a-synth** |
| 本机接入地址 | `http://127.0.0.1:13426`（迁移后新端口） |
| 伙伴网络地址 | `10.66.164.176/32` |
| 额度 | 上限 $0.0500 · 已用 $0.0120 · 剩余 $0.0380；原生限额状态「已读取」 |
| 读取可用模型 | 一次成功；弹窗「真实读回于 2026/10/31 12:00:48 · provider/provider-model」 |
| 首页模型证据 | `1 个当前可见模型` + 「推理额度与 429 另计，不代表可调用」 |

说明：该 Remote/key 由 f63b 通过内部受控动作准备，属**实验 fixture**，不是普通 B 文件路径，也不构成 B zero-file GO。

- cap $0.05 / used $0.012 是正确状态：$0.0001 是最初为制造真实 429（cost $0.012 > cap）的极小 cap，随后为迁移/重启测试 top-up 到 $0.05（used 保留、不 reset）；迁移只换 forward 端口，不换 key/cap。
- evidence generation（迁移后 3）是插件内部证据字段；UI 按设计只展示 readAt/来源/模型/额度，不展示 generation。
- two-node lab 只有一个 mapped /32，第二个 Remote 会被 400 拒；迁移只验证同一 ET provider peer 与既有记录，这是 lab 限制。

## 2. 真实 UI 缺陷（FAIL）

### F1 勾选模型后「分享这些模型」仍 disabled（阻断正常分享路径）

复现（HEAD 1c14ec4，provider）：
1. 我的共享 → 勾选 `provider/provider-model`。
2. 观察「分享这些模型」仍为 disabled；等待 7 秒、状态刷新（证据时间变化）后仍 disabled。
3. 在模型搜索框输入任意字符触发重渲染后，按钮立即变为可点。
4. 分享完成后再取消勾选，按钮仍保持可点（反向同样不同步）。

原因定位（源码，只读）：`providers.js` 的 checkbox change 只更新 `selectedModels`，未同步 `modelSave.disabled`；该 disabled 仅在 `renderModels()` 时重算，而状态轮询不会因勾选变化重渲染该区块。

证据：`provider-share-button-disabled-1440.png`、`provider-share-disabled-bug-1440.png`。
影响：用户按正常路径无法完成分享；本次 E2E 是在搜索框输入字符触发重渲染后才点的分享（已如实记录，非正常用户路径）。

### F2 未分享时「停止共享」按钮可见

- 分享前：按钮 `hidden=true`，但 computed `display:flex`（作者样式覆盖了 `hidden` 的 UA 规则），因此可见。
- 证据：分享前 `provider-sharing-1440-light.png`；分享后正常可见（`provider-after-share-1440.png`）。
- 影响：未分享时出现无效/误导操作。

## 3. 观察项（需复核，暂不判 FAIL）

- provider 首页一度显示「已连接 · 0 个其他节点」，同刻网络页邻居列表含 consumer；随后网络页刷新又显示双方。可能是分享触发核心重启后的短暂投影滞后；未稳定复现，标 UNKNOWN，建议在 B 环节观察首页邻居计数与网络页一致性。

## 4. 未覆盖（UNKNOWN）

- 同机 lab，无 NAT/WAN、无跨主机中继。
- 429/额度耗尽、paused/恢复、撤销授权、Key 轮换（本轮不做 Remote 授权）。
- 端口冲突/owned listener 故障恢复（f63b 尚未启动）。
- 旧文件申请/授权流（页面仍有入口，属 B 前现状，未操作）。
- 真实 Remote Magpie 注册（B 未安装）。

## 5. 截图（`a-lab-1c14ec4/screenshots/`，27 张）

provider：anonymous、first-run、join-pending、after-join、home/discovery/sharing/wallet/network（浅）、share confirm dialog、inflight、after-share、home-after-share、share-button-disabled、share-disabled-bug。
consumer：anonymous、first-run、join-pending、after-join、五页浅色、home 深色、home 390 深色。
未截任何网络密钥、票据、Gateway Key；网络名是 lab 标识、密钥未出现。

## 6. 清理

- 两个 lab 进程、data/HOME、root 均归 f63b；我未 kill、未重启、未改端口。
- 我只保留自己的浏览器页与上述截图；最终 stop/delete 由 f63b 统一执行。
- 本报告不含一次性 k= 链接、网络密钥、配对码。

## 7. 判定

**网络与服务结果 PASS**：安装/配对/三字段 join/双向 peer/一次分享的 core 发布与目录结果/对端目录发现/可见≠可用。
**分享控件正常路径 FAIL（F1）**：本次 share 是借搜索重渲染绕过，不能标 share UX PASS。
**F1 阻断正常用户分享**，需实现者最小修复（checkbox change 同步 disabled）；F2 为可见性缺陷。
修掉 F1 后才能宣称 A 的分享路径对普通用户可用；NAT/WAN 与 429/恢复仍 UNKNOWN。
