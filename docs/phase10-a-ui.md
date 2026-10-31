# Phase 10 A — 本机控制台 UI（A-ui 交付说明）

> 范围：`plugin/console/`（静态前端）＋ `plugin/scripts/` 下的**开发预览**夹具；不改 `plugin/src/service.ts`、不改 EasyTier/网络实现、不改钱包资金行为、不改 CSP 与静态白名单。
> 状态标签：**VERIFIED** = 本轮直接读源码或在真实浏览器中实测；**REPRODUCED** = 本轮实际运行并看到结果（标注是对 mock 还是真实后端）；**UNKNOWN** = 未做或证据不覆盖。
> 基线：`origin/main` = `8ce5c57f565fb1b835021a9b730b61014eb47d5f`；分支 `feature/phase10-a-console`。
> 本文不含任何真实密钥、密码、地址或账目。所有截图来自 `plugin/scripts/console-preview.ts` 的**夹具数据**，不是真实节点。

---

## 0. 一句话结论

**VERIFIED（源码 + 单测）**：控制台已从 7 项导航改为用户要求的 5 页（首页 / 发现 / 我的共享 / 钱包 / 网络），首次连接只有 3 个字段和一个主操作，分享是一次明确的“分享这些模型”，钱包资产与提供者信用分开显示，端口/检查/RPC/观察器全部收进只读诊断。
**REPRODUCED（mock + ego-lite）**：19 张截图（五页 × 浅/深 @1440、五页浅色 @390、分享确认弹窗、首次连接 @1440/@390、焦点），正文 16px、控件与导航 44px、无横向滚动、减动效生效、焦点可见。
**UNKNOWN**：本轮**没有**在真实 Magpie 0.1.2289 + EasyTier 2.6.4 上跑新 UI。`join-network` / `share-native-models` / `stop-sharing` / `network-refresh` 四个动作由 A-service 实现；缺少这些动作时 UI **fail-closed**（提示更新插件，不写旧动作），真实联调要等 A-service 合入后再验。

---

## 1. 五页信息架构

| 页 | 内容 | 明确的“不要” |
| --- | --- | --- |
| 首页 | 网络连接 / 可用模型 / 我的共享 / 钱包 / 待办（5 行，单张卡片内的列表） | 无英雄卡、无统计卡、无图表、无能力徽标堆叠、无端口/ACL/检查明细；“可用模型”只统计已授权伙伴服务，本机可分享数量不出现在首页 |
| 发现 | Tab：伙伴目录 / 我的连接（原生 Remote Magpie） | 不再有独立“我的连接”导航项 |
| 我的共享 | 自动检测本机模型 → 勾选 → **一次**“分享这些模型”确认；“停止共享”单独；目录身份、申请、已授权伙伴 | 无角色开关、无“保存模型范围/保存目录说明/发布目录”多步保存 |
| 钱包 | 网络、资产与提供者信用（平铺只读）→ 入账申请 → 使用方付款；“高级恢复 · 账本与离线账单” | 无网络卡套卡、无每网络 5 按钮、不在主视图放 RPC/观察器/扫描/注册代币 |
| 网络 | 三字段表单 + “连接网络” → 实际连接结果（只读）→ 邻居（只读）→ 诊断（端口只读 + 安全检查）→ 会话 | 无角色/端口/监听编辑、无“保存并连接”多步向导 |

**VERIFIED**：`plugin/console/index.html` 的 `nav` 只有 `nav-home / nav-discovery / nav-sharing / nav-wallet / nav-network`；`plugin/console/shell.test.js` 断言这一点，也断言首页恰好 5 块、首次表单恰好 3 个输入、每页 ≤1 个 primary。
**VERIFIED（布局）**：桌面 `220px` 侧栏；`≤767px` 时侧栏变固定底栏（同一 `nav`，5 项），主内容加底部安全区；无横向滚动（390×844 实测 `scrollWidth=390`）。

---

## 2. 视觉系统（贴纸风）

- token：`plugin/console/style.css` 顶部一套浅色 + 一套深色；纸面 `#fbf2dc`、点阵 `radial-gradient` 20px、2px 墨线、单层硬投影（2/3/4/6px，无模糊）、胶囊按钮。
- 语义色只有三块：薄荷=成功/可用、粉=危险/支出/失败、天蓝=进行中/信息；“颜色 + 墨线”，不发光、不做装饰性用色。
- 零 Web 字体（`-apple-system / PingFang SC / Noto Sans CJK SC`），无外部请求，CSP 不变。
- 字号：正文 16px、标题 18/22/28、表格与标签 14px、无 12/13px 正文。
- 触控：按钮、导航、输入统一 44px 最小高度。
- 交互：按钮按下位移 3px 且投影归零；`focus-visible` 3px 墨色轮廓 + 2px offset；`prefers-reduced-motion` 全量降级。
- 主题：跟随系统，用户选择写入 `localStorage["aihub-console-theme"]`（**唯一**持久化的值；会话/密钥仍在内存）。

**REPRODUCED（ego-lite 实测，1440×900）**：`body` = `16px / 25.6px`；侧栏导航 = `186×44`；首次表单输入 = `44px` 高、`16px` 字号；卡片 = `border 2px` + `box-shadow 4px 4px 0` + `radius 14px`；页面 h1 = 28px；减动效下 `transition-duration: 0s`；焦点在 Tab 后为 `outline 3px`。
**REPRODUCED（对比度，WCAG 公式）**：浅色 ink 16.33、body 11.38、muted 5.44、accent-text 5.45、good 5.10、bad 6.32、info 6.75；色块内 on-color on mint/rose/sky = 12.15/11.02/11.19，on-accent 10.12；深色全部 ≥ 6.3。全部 ≥ AA。

---

## 3. 首次连接（A2 的 UI 侧）

表单只有三个输入：**网络名称 / 网络密钥 / 初始节点**，外加一个 `连接网络`。

- 首次提交必须带密钥；再次编辑可留空（A-service v2 契约已确认：`configured=true` 时 `networkSecret` 可省略 = 保留已存密钥）。
- `初始节点` 是单行 `initialNode`（契约字段）；为空表示稍后补。
- 提交文案明确“保存只表示配置已写入；是否在线看下方实际结果”，不会把保存当在线。
- 成功后首次会跳到首页；网络页始终能用 `刷新网络状态` 触发一次显式读取。

**fail-closed**：`join-network` 返回 404（旧后端）时**不做任何写入**，直接提示“本页没有修改任何设置；请更新 Magpie 中的 Oh My AIHub 插件后重试”。旧 `configure` 的默认角色/端口/监听与三字段语义不等价，因此不自动降级。
**REPRODUCED（mock）**：空提交被 `reportValidity` 拦下（`network-name`、`network-secret` 为 invalid），无请求发出；填好后提交返回 `{result: state}`，页面显示“配置已写入…”，`network-readiness` 变为“已连接”。
**UNKNOWN**：真实 `join-network` 的端到端行为（端口自动分配、监听自动生成、失败回滚展示）。UI 只消费 `status.network`，不自行推导。

---

## 4. 分享、发现、钱包

### 4.1 一次分享（不自动公开）

1. 进入共享页自动调用只读 `share-candidates`（**不分享**），列出本机模型、价格与“价格完整/缺少价格”。
2. 用户勾选后点 `分享这些模型` → 弹窗列出**确切模型清单**并声明“会开启共享并把这份清单发布到网络目录” → 勾选确认 → 一个事务动作 `share-native-models {models, confirm:true}`。
3. **不做多步降级**：`share-native-models` 返回 404 时只提示“请更新 Magpie 中的 Oh My AIHub 插件”，不写 `share-models` / `share-toggle` / `catalog-publish`，避免部分公开或 ACL 与目录不一致。
4. `停止共享` 单独一个确认；`stop-sharing` 404 同样 fail-closed，不写旧开关。
5. 目录展示名/联系方式/建议额度收进折叠块，**单独**“保存展示信息”（只改文案，不分享、不发布）；分享时不再附带这次写入，避免“分享失败但展示信息已改”的半写状态。

**VERIFIED（单测）**：未选模型时点击只提示“请至少勾选…”，不发请求；确认弹窗需要显式勾选才启用提交。
**REPRODUCED（mock）**：确认分享后 `notice` = “已分享所选模型；目录发布状态以下方真实状态为准。”，弹窗关闭。

### 4.2 发现 = 伙伴目录 + 我的连接

- 一个页面、两个 Tab（`role=tablist`），`aria-selected` 与面板 `hidden` 同步。
- 目录卡展示身份状态、模型、价格；危险动作（接受身份、连接）仍需各自勾选。
- 不再有“使用能力”开关；消费默认开启由服务端负责。

**REPRODUCED（mock）**：点击“我的连接”后 `discovery-panel.hidden=true`、`connections-panel.hidden=false`、`aria-selected=true`。

### 4.3 钱包

- 首屏只有一句“测试网环境；本应用不持有私钥，不执行转账”，没有免责声明墙、证据徽标或缓存时间。
- `钱包概览`：**资产余额 = 尚未查询**（本阶段没有余额读取，不打印 0）；`最近入账（累计，非余额）`单独标金额与时间；`测试网络`列网络与资产；`提供者信用（按伙伴）`逐伙伴显示，不做统一池。
- 证据徽标、`viewAt/evidenceAt`、chainId、观察器状态、RPC、扫描、测试代币、审计异常全部在 `网络 → 诊断 → 钱包与链诊断`。
- 未初始化/不可读时给出下一步（初始化 / 刷新），不伪装成完整钱包。
- `共享方 · 发起与追踪入账申请`：主操作 `创建测试网入账申请`（原有 5 字段流程不变）。
- `使用方 · 用自己的外部钱包付款`：`导入并核对入账申请`。
- `高级恢复 · 账本与离线账单`：原有账单伙伴选择、消费记录、离线账单导入全部保留；文案标注“这是既有会计路径，不是 Phase 10 的无文件目标”。
- RPC、观察器启停、扫描、测试代币、审计异常 → **网络 → 诊断 → 钱包与链诊断**（每项保留原有确认与动作）。

**VERIFIED（单测）**：钱包面板内不再出现“编辑 RPC / 扫描此网络”（诊断根节点各 2 个）；`wallet-network-card` 不再被使用；离线账单按钮不在付款区块。
**UNKNOWN**：真实钱包数据下的布局与长列表（本轮只有夹具）。

---

## 5. 与 A-service 的契约（`/tmp/oma-research/A-ACTION-CONTRACT.md`）

UI 只依赖这些字段/动作：

| 用途 | 来源 |
| --- | --- |
| 网络状态/邻居/端口 | `status.network`（`state/summary/evidence/core/thisNode/neighbors[]/ports[]/catalog`）；缺失时退化读 `status.easytier` + `status.config` |
| 分享 | `share-candidates`（只读）、`share-native-models {models, confirm:true}`、`stop-sharing {confirm:true}` |
| 连接 | `join-network {networkName, networkSecret, initialNode}`；404 → 提示更新插件，**不写** `configure` |
| 刷新 | `network-refresh {}`；404 → 仅重新轮询 |
| 目录发布状态 | 优先 `status.catalog.publishing`，退化 `status.config.catalog.enabled` |

**空值纪律**：`latencyMs === null` 不显示、`online === null` 不显示在线/离线、`lossRatePct === null` 不显示 0、端口 `state !== "stable"` 时追加状态词、`catalog.modelCount === null` 显示“未知”。
**404 规则**：只识别“动作不存在”，一律提示更新插件；不换旧动作、不做多步写入。400/500/0 显示真实错误并提示刷新，不自动重试。
**已确认（A-service v2）**：`configured=true` 时 `networkSecret` 可省略/空串，保留已存密钥；`initialNode` 省略 = 保持当前节点。响应统一 `{result: consoleState}`；分享成功后 `status.catalog.publishing === true` 且 `status.catalog.quote.modelCount` 存在。
**无多步降级（主审要求）**：任何 404 只提示“更新插件”，不自动写旧动作。`configure` 的默认角色/端口/监听与三字段不等价，`share-models`+`share-toggle`+`catalog-publish` 也不是一个事务；两者都不作为兼容路径。
**端口字段**：`ports[].reachability`（`loopback/overlay/lan/unknown`）与 `purpose` 枚举（`overlay-listen/easytier-rpc/catalog/catalog-socks/gateway/forward/console/api/control`）只用作只读展示，`gateway` 恒为 `unknown`（Magpie 自己持有该监听）。
**不宣称端口已验证**：UI 原样显示后端 `state`（稳定/已迁移/冲突/未验证/失败/未知）与 `verifiedAt`，并写明“地址或端口被占用不等于由本插件验证”；没有 `editable: true`，也没有把 `stable` 升级成“已验证”。A-service 的 PR #22 仍在独立审查（端口 ownership 存疑），本分支不依赖它、不把它的端口管理当作已验收。

---

## 6. 会话与安全边界

- 首访（从未认证）显示“这个浏览器还没有访问权限”，过期显示“本次会话已结束”，主动退出显示“已退出本机会话”，配对失败显示“此次配对未完成”。会话期限、CSP、认证语义均未改。
- 顶栏状态胶囊只表示**浏览器 ↔ 本机控制台会话**（“控制台已连接”），不再写成“本机已连接”，避免被读成已加入 P2P 网络。
- 网络密钥不写浏览器存储、不回显；页面明确写出这一点。
- 唯一持久化的是主题偏好；单测把 `localStorage` 的键限定为 `THEME_KEY`，`sessionStorage/indexedDB/innerHTML/document.cookie` 仍然禁止。

---

## 7. 测试

```bash
cd plugin
bun test ./console                       # 前端模块 + 外壳契约 + 钱包/工作流
bun test ./test/console-api.test.ts ./test/console-security.test.ts \
         ./test/console-wallet.test.ts ./test/console-workflows.test.ts
```

**REPRODUCED（2026-10-31，Bun 1.4.3）**

- `bun test ./console`：**71 pass / 0 fail**（4 个文件、569 断言）。新增 `shell.test.js` 覆盖：5 项导航、首页 5 块、三字段、端口只读、每页 ≤1 primary、主题持久化边界、会话文案区分、`join-network` 只发三字段、`status.network` 空值纪律、单次分享、钱包诊断拆分。
- 四个 console TS 用例：**55 pass / 3 fail**，失败均为既有时钟固定导致“请求已过期”（P0-3 已知基线问题），与本轮前端改动无关；本轮**未**运行会探测生产 Magpie/RPC 的 `phase8-prompt-journey`、`service` 等重型用例。

---

## 8. 截图与复现

夹具预览（**不是**真实节点；CSP 也只在真实控制台生效）：

```bash
bun run plugin/scripts/console-preview.ts --scenario configured --port 61390 &
bun run plugin/scripts/console-preview.ts --scenario first-run  --port 61391 &
ego-browser nodejs < plugin/scripts/console-shots.mjs   # 输出到 /tmp/oma-ui-shots
```

仓库内保留 4 张（`docs/phase10-a-ui/`）：首页 1440 浅色、网络 1440 浅色、钱包 390、首次连接 390。完整 19 张在 `/tmp/oma-ui-shots/`：五页 × 浅/深 @1440（10）、五页浅色 @390（5）、分享确认弹窗（1）、首次连接 @1440 与 @390（2）、键盘焦点（1）。

**清理**：预览服务器只监听 `127.0.0.1`，用 `lsof -nP -iTCP:61390 -sTCP:LISTEN` 找到 PID 后 `kill` 即可；未接触用户 Magpie 安装、数据目录或任何真实凭据。

---

## 9. 未做 / 未验证

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实 `join-network` / `share-native-models` / `stop-sharing` / `network-refresh` | UNKNOWN | 等 A-service 分支；UI 的退化路径已按 404 设计，但真实事务结果未验 |
| 真实 EasyTier 2.6.4 邻居/端口投影 | UNKNOWN | 只用 A-service 契约字段渲染；真实字段完整性由 A-service 的证据负责 |
| 真实伙伴数据（目录/申请/授权/账单/链上入账） | UNKNOWN | 本轮只有夹具空态与合成数据 |
| WebKit / 真实手机 | UNKNOWN | 仅 Chromium 内核的 ego-lite |
| 服务端 unit/E2E 回归 | 非本分支范围 | 未合并的 A-service 改动不在本分支 |

**不宣称 GO**：本分支只交付 A 的界面与交互；真实后端联调、版本重测、网络隔离测试仍需主审按门禁推进。
