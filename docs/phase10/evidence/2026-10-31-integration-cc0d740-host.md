# Integration cc0d740 — 真实宿主加载与首配证据（sanitized）

> **边界**：本地目录直链安装，不是 GitHub 升级包验收；源目录只保证 tracked clean，ignored 运行时文件由宿主实际写入；不是 Visual UX GO；5 页业务/join/share/payment 均 UNKNOWN。

交付给文档代理，用于收录进 `docs/phase10/evidence/`。由 Console 验收代理生成，不含应用代码改动。

## 来源

| 项 | 值 |
|---|---|
| HEAD | `cc0d740876e5a667f1789e1ae3b4966ecf8cef9f` |
| 源目录 | `<integration-worktree>`（`git status --porcelain` 空；ignored 运行时文件由宿主写入） |
| 含 | approved UI #25（b1a4838）、external #30 default-send-off、P0、Windows #24、动态测试端口 #31（两项独立） |
| 不含 | #22 / #20 / #21 / #23 / #26 |
| 环境 | Magpie 0.1.2289 全新副本 + 独立 HOME；Magpie web 39051、Console 57261 |

## 证明与范围

- **已证**：本地目录安装使宿主直接读取该源目录；`plugin/console` 五个文件 sha256 与源目录逐一相等；`launcher.ownerPid` == `status.pid` == 监听 57261 的 PID（宿主重启前后各一次）；argv 为隔离 HOME 下的 magpie-bun。
- **不证**：GitHub 更新后的包内容/完整性（本次是本地目录直链，不是安装包）；源目录"字节全树未修改"（只保证 tracked clean，`status.js`/`launcher.js` 等 ignored 文件由宿主实际写入）。
- **不是 Visual UX GO**；5 页真实渲染、会话过期、错误态、钱包/模型值均 UNKNOWN（未入网，join 属未批写）。

## 目录（仓库内实际文件）

```
docs/phase10/evidence/
├── 2026-10-31-integration-cc0d740-host.md
├── 2026-10-31-integration-cc0d740-host-env.txt
├── 2026-10-31-integration-cc0d740-console.sha256
├── 2026-10-31-integration-cc0d740-host.SHA256SUMS
└── screenshots/cc0d740/  (7 张 PNG)
```

原始交付包共 11 个文件（README、report、ENV、SHA256SUMS、7 PNG）；仓库只收录上表，不含 tar、原 logs、运行 HOME。`<integration-worktree>`/`<lab-root>` 为脱敏占位符。

## 脱敏

- 无票据、Cookie、配对码、网络密钥、Gateway Key、私钥。
- 截图内只有占位符与状态文案；首配字段为空。
- ENV 摘录把用户名与绝对路径替换为 `<user>` / `<isolated-app>` / `<isolated-home>`。

---

# Integration HEAD `cc0d740` 真实宿主浏览器验收

> 对象：`cc0d740876e5a667f1789e1ae3b4966ecf8cef9f`，worktree `<integration-worktree>`（分支 `feature/phase10-integration`，工作树干净）。
> 目的：补上"真实宿主是否真的加载了目标 commit"的证据，不是 Visual UX 总验收。
> 结论：**加载证据 PASS；真实会话/首配/主题/键盘/匿名-退出 PASS；5 页与过期 = UNKNOWN（未入网，按约束不做 join）。**

## 0. 版本与范围

| 项 | 值 |
|---|---|
| HEAD | `cc0d740876e5a667f1789e1ae3b4966ecf8cef9f` |
| 来源目录 | `<integration-worktree>`（`git status --porcelain` 空） |
| 包含 | approved UI #25（b1a4838）、external #30 default-send-off、P0、Windows #24、动态测试端口 #31（两项独立） |
| 不含 | #22 / #20 / #21 / #23 / #26 |
| console 5 文件 sha256 | `index db52d31…`、`app 77c9a12…`、`style f53358c…`、`providers 103d0bd…`、`wallet daf6835…`（`2026-10-31-integration-cc0d740-console.sha256`） |
| Magpie | 0.1.2289，全新复制 `<lab-root>/Magpie.app`，独立 `HOME=<lab-root>/home`（运行期宿主在源目录写入 ignored 运行时文件，属实际写入） |
| 端口 | Magpie web `127.0.0.1:39051`；Console `127.0.0.1:57261` |

## 1. 加载证明（PASS）

| 证据 | 值 |
|---|---|
| 安装 | 通过 Magpie UI：Plugins → Discover → `<integration-worktree>` → Install（**本地目录直链**，非 GitHub 包） |
| 插件路径 | 宿主写入 `<integration-worktree>/plugin/page/launcher.js` 与 `status.js` |
| 文件 hash | 安装后 `plugin/console/{index,app,style,providers,wallet}` 与来源目录逐一相等（`INSTALLED UI == INTEGRATION SOURCE`） |
| ownerPid ↔ argv | 首次 `ownerPid 78241`；宿主重启后 `ownerPid 88922`；`ps -p 88922` = `<lab-root>/home/.cache/magpie/bun/1.4.4/magpie-bun run …/host-57e4026712e7.js`，父进程 `75721` = 隔离 Magpie |
| status.pid | 与 launcher `ownerPid` 同为 `88922`（重启前同为 `78241`） |
| 端口归属 | `lsof :57261` 的监听 PID 同为 `88922` |
| 结论 | 目标 commit 的 UI 文件被真实宿主加载并以隔离 HOME 运行 |
| 范围 | 本地目录安装使宿主直接读取该源目录并回写运行时文件；hash 证明**运行中的代码 = 该源目录文件**，**不**独立证明 GitHub 更新后包内容/完整性；源目录只保证 `git status` 为空（tracked clean），`status.js`/`launcher.js`/`options.js` 等 ignored 运行时文件由宿主实际写入 |

## 2. 真实会话与首配（PASS）

| 项 | 观察 |
|---|---|
| 匿名首访 | 「未连接 / 请从 Magpie 打开控制台，或在下方向 Magpie 申请配对并批准」+「配对此浏览器」；侧栏 5 项禁用 |
| 真实配对 | Console 8 位码 → Magpie 插件页核对 → 批准 → `控制台已连接` |
| 首次配置 | 仅 `#network-name` / `#network-secret` / `#network-peers` 三个输入；导航只有「网络」可点（其余 disabled）；无角色卡片、无端口输入 |
| 空输入提交 | 浏览器原生校验，`#network-name:invalid = true`；无 `#form-error`、无动作请求、无状态变化（未写入任何配置） |
| 主题 | `#theme` 切换后 `data-theme=dark`，`localStorage['aihub-console-theme']='dark'`；刷新后保持 |
| 键盘 | 真实 Tab 顺序：skip-link → 品牌 → 网络 → 主题 → 网络名称 → 网络密钥 → 初始节点 → 连接网络 → 刷新网络状态 → 「诊断与端口（只读）」 |
| 窄屏 | 390×844 无横向滚动（`scrollWidth = clientWidth = 390`）；底部 5 项 Tab 栏 |
| 退出 | 「已退出本机会话 / 需要继续时，请从 Magpie 重新打开控制台」+ 配对入口；顶栏显示「已退出」 |
| 退出后刷新 | 「未连接 / 请从 Magpie 打开控制台，或在下方向 Magpie 申请配对并批准」 |

## 3. UNKNOWN（未覆盖，按约束不执行）

| 项 | 原因 |
|---|---|
| 5 页（首页/发现/我的共享/钱包）真实渲染 | 未入网时导航 disabled；`join-network` 属未批后端写，未执行 |
| 会话过期（30 分钟空闲 / 8 小时绝对） | 未等待，不做时间伪造 |
| 错误态（join/share/钱包失败） | 未触发写动作，无可信错误证据 |
| 模型数与余额 | `status.providers.models` 缺字段、钱包资产需查询；未造值 |
| CWalletUI | 未接入，未验证 |
| 真实 join / share / Key 导入 / 付款 / 扫描 / 钱包扩展 | 明确禁止，未执行 |

## 4. 截图（`<lab-root>/shots/`）

| 文件 | 内容 |
|---|---|
| `anonymous-1440.png` | 匿名壳（未配对） |
| `first-run-1440-light.png` | 配对后首次配置，三字段，浅色 |
| `first-run-1440-dark.png` | 同上，深色 |
| `first-run-empty-submit-1440.png` | 空输入提交（原生 invalid，无写入） |
| `first-run-390-dark.png` | 窄屏 390（深色；浅色窄屏未拍，UNKNOWN） |
| `logout-1440.png` | 退出会话 |
| `anonymous-after-reload-1440.png` | 退出后刷新 |
| `ENV.txt` | 清理前的 PID / 端口 / argv 记录 |

## 5. 清理（先导出证据，后删除）

```text
清理前：magpie_pid=75721；host_pid 78241 → 重启后 88922；端口 39051、57261
清理后：39051/57261 均 0 监听；pgrep 'oma-int-cc0d740' 无输出
已删除：Magpie.app 副本、隔离 HOME、logs、.magpie-update（63 MB）
保留：shots/（含 ENV.txt）、本报告、integration-console.sha256
未触碰：<integration-worktree> 源目录、用户 Magpie 配置与 profile
```

## 6. 判定

- **真实宿主加载 cc0d740：PASS**（路径 + 5 文件 hash + ownerPid/argv + status.pid + 端口 pid 全对；宿主重启后再次对账一致）。
- **不是 Visual UX GO**：5 页、过期、错误态、钱包/模型值均 UNKNOWN。
- 下一步需要 #22 安全通过并在新干净宿主做两节点验收，才能覆盖入网/分享/钱包链路。
