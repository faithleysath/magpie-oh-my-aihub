# 参考研究：Oh-My-AIHub 设计体系（只读，固定 SHA）— 事实版

> 本报告只记录**可核对的事实**：版本、许可证、真实渲染、源码结构、可测的视觉规则。
> **目标信息架构、页面划分、交互与流程不在本报告定义**，一律以主任务与 `docs/phase10/FLOWS.md` 为准；本报告不提供产品方案。
> 状态标签：**VERIFIED** = 直接核对源码/远端/真机；**REPRODUCED** = 实际运行并看到结果；**UNKNOWN** = 证据不覆盖。
> 不含任何真实凭据：未登录生产实例，未提交表单，截图前清空浏览器自动填充。

- 研究时间：2026-10-31（Asia/Shanghai）；平台 macOS 26.6.2 (25G83) arm64
- 浏览器：ego-lite（Chromium 内核，ego-browser 2.2.0）
- 参考仓库（只读）：`~/Projects/Oh-My-AIHub`，工作树 0 改动
- 构建全部在隔离的 `<build-dir>`/`<compare-dir>`，未写目标仓库

---

## 0. 结论

**VERIFIED**：`NexusAgentX/Oh-My-AIHub` @ `bc47f41d763b59ba956f36b661f88d9a54892490` 的贴纸风由「110 个 token + 42 个 UI 文件 + 13 个导航项 + 6.2 MB 自托管字体 + 191 KB CSS」构成。
**VERIFIED**：仓库**没有 LICENSE**，GitHub `license=null`，README："项目本身的许可证待维护者补充。"
**结论**：可读、可参照风格；**源码与品牌素材不可复制**（§6）。

---

## 1. 截图边界

参考站点的实拍截图**未入库**（第三方界面，仓库无 LICENSE，避免转载）；本报告只保留可核对的事实、token/源码数值与真机渲染描述。仓库内的 16 张截图全部是 **Oh My AIHub 当前 Console** 的修改前证据，不是参考站点截图。完整参考站点截图留在实验目录，未提交。

## 2. 版本、许可证与同源核对

| 项 | 值 | 状态 |
|---|---|---|
| 远端 HEAD | `bc47f41d763b59ba956f36b661f88d9a54892490`，`2026-10-28T06:36:54Z`，PR #577 merge | VERIFIED |
| 本地参考仓库 | `HEAD == origin/main == bc47f41`，`git status --porcelain` 0 行 | VERIFIED |
| 关键文件同源 | `DESIGN.md`、`tokens.css`、`AppFrame.tsx`、`navigation.ts`、`HomePage.tsx`、`market/Pages.tsx`、`points/PointsPage.tsx`、`account/AccountPage.tsx` 共 8 个 blob SHA 与远端 `?ref=bc47f41` 逐一致 | VERIFIED |
| 许可证 | 根目录无 LICENSE/COPYING；`gh api ... --jq .license` = `null` | VERIFIED |
| 第三方许可 | `frontend/public/licenses/fonts.txt`（Baloo 2 / 源泉圆体，SIL OFL 1.1）、`map.txt`、`markdown.txt` | VERIFIED |
| 生产实例 | `https://ai.isok.dev`（SECURITY.md 声明由发布工作流部署），nginx，CSP 全 `'self'` | VERIFIED |

---

## 3. 真机渲染事实（元素级）

| 证据 | 浅色 | 深色 |
|---|---|---|
| `--paper` / `--canvas` | `#fbf2dc` / `#fffaf0` | `#191612` / `#24201a` |
| `--ink` / `--muted` | `#1f1c16` / `#6f6656` | `#efe7d6` / `#a59a87` |
| `--mustard` / `--line` / `--shadow-ink` | `#f2c14e` / `#1f1c16` / `#1f1c16` | `#c99a3e` / `#e6dcc8` / `#050403` |
| 与 `tokens.css` 比对 | 逐值一致 | 逐值一致 |
| 主按钮 | 40px 高、`2px solid ink`、`radius 999px`、`3px 3px 0` 硬投影、700 字重 | 同结构 |
| 登录卡片 | 440px、`radius 14px`、2px 墨线、`6px 6px 0` 投影、padding 40 | — |
| 输入框 桌面/手机 | 40px / 14px 字号、radius 10 | 手机 16px、44px 高 |
| H1 | 桌面 38px / 手机 26px，`Baloo 2, GenSen Rounded`，800 | 同 |
| `meta theme-color` | `#fbf2dc` | 跟随 `--paper` |

**REPRODUCED**：纸面 20px 点阵铺满 `html`；侧栏与顶栏不铺色；顶栏吸顶用纯纸色 + 1px `--hairline`；卡片/按钮统一 2px 墨线 + 不模糊硬投影；按下位移 2–3px 且投影归零；手机端登录卡片降级为无卡片全宽表单。

**对比度实测（REPRODUCED，WCAG 公式）**：浅色 ink 15.24 / body 10.62 / muted 5.08 / link 5.08 / on-color-on-mustard 10.12 / rose 11.02 / sky 11.19 / mint 12.15；深色全部 ≥ 6.3。

### 部署版本与 HEAD 不一致

| 尝试 | 结果 |
|---|---|
| 本地对 HEAD `bc47f41` 构建 | `index-hgk1Fqtf.js` / `index-B-7vULze.css` |
| 线上 `index.html` | `index-COAeJUxP.js` / `index-BhPONH1b.css` |
| 再构建 `6afc0fc`、`c526eb3`、`7c5b8f3`、`d42c778`、`954cab5`、`2b07354` | 无一匹配 |

→ **UNKNOWN**：线上构建对应 commit。线上截图只证明风格与 token 一致，不证明登录后页面等于 HEAD 渲染。

---

## 4. 源码事实

| 指标 | 数值 |
|---|---|
| `tokens.css` 自定义属性 | 110 个（两套值，按用途命名） |
| `src/ui/` | 42 个文件，16 个 CSS |
| 桌面导航 | 13 项 / 4 组；手机底部 5 Tab |
| 入口 CSS（线上） | 191,546 B（minified） |
| 自托管字体 | 6.2 MB、中文 77 个 unicode-range 切片 + 1 个拉丁；`fonts.css` 95.1 KB |
| `DESIGN.md` | 18.3 KB |

- **token 分层**：纸面/表面 6 → 文字与线 11 → 墨线/投影/色块 12 → 状态 4 → 代码 2 → 遮罩 1 → tint（`color-mix`）→ 四级硬投影 → 字号 8 档 → 间距 8 档 → 圆角 5 档 → 外壳 7 → `--duration`。组件禁写十六进制、禁写 `[data-theme]` 分支。
- **外壳**：`grid: 240px | 1fr`；sticky 侧栏 `100dvh`；sticky 顶栏 60px、纯纸色遮滚；内容 `min(100%,1240px)` 居中、`min-height` 撑满使分页贴底；断点 `960px`/`767px`；手机底栏 fixed 62px + 安全区。
- **无障碍实现**：skip-link、路由切换后 `main.focus()`、标题滚出后顶栏淡入且读屏不重复、`scroll-padding-top`、`prefers-reduced-motion` 全局降级、手机输入 16px、44px 触控、`:focus-visible` 2px 外框。
- **主题实现**：`public/theme-init.js` 首屏前读 `localStorage['oma-theme']` 写 `<html data-theme>`；`theme/theme.ts` 负责切换与 `theme-color`；用测试保证两者一致（CSP 禁内联脚本，因此是独立文件）。
- **组件状态**：按钮按下 `translate(2,2)` + 投影归零；输入 focus = 墨线 + 3px 硬投影；禁用/只读 = 凹底 + 虚线；表格外层是卡片、内部分隔只用 `--hairline`、窄屏转同卡片列表。

### 页面结构（事实，不是模板）

| 页面 | 结构 |
|---|---|
| 首页 | 问候标题 → 待处理 Notice → `StartCard`（接口地址 + 默认 Key 显隐/复制）→ 余额卡 + 今日四张糖果色贴纸 → 最近调用 5 行 |
| 模型市场 | `Toolbar`（搜索 + 3 下拉 + 供应商双栏 + 仅在线开关）→ 模型卡网格 → 分页；详情 = 报价卡 + 调用方式编辑 + 逐分组渠道 |
| 积分 | 余额卡（信用额度进度条 + 走势）→ Tabs（买/交易/卖单/账单）→ DataTable + Drawer |
| 账户 | 左卡 `detail-list`（显示名原地编辑、用户名、角色）+ 右卡改密码 |

参考产品是中心化积分平台，包含 C2C 买卖、论坛/工单、管理后台与 13 项导航；这些是**它的产品**，不是本项目的目标。

---

## 5. 视觉规则（可从渲染结果核对的客观项）

以下每一条都能在真机或源码里复核，属于"贴纸风"的可观察构成，不是页面方案：

| 规则 | 可核对值 |
|---|---|
| 纸面 | `html` 背景 `--paper` + `radial-gradient` 点阵，20px 间距，1.2px 半径 |
| 墨线 | 贴纸 `2px solid --line`；小元素 1.5px；卡片内部分隔用 `--hairline`（16% 墨） |
| 硬投影 | 四级 `2/3/4/6px` 偏移、0 模糊、墨色；不使用模糊阴影（遮罩除外） |
| 胶囊 | 按钮、徽标、分段控件、标签页 `radius 999px`；卡片 14px、输入 10px |
| 按压 | 可点击贴纸按下平移至投影位置、投影归零；可点卡片悬停抬 2px、投影升一级 |
| 单一强调 | 每屏一个芥末主按钮；其余次按钮/安静按钮 |
| 语义色 | 粉=危险/支出，蓝=信息/进行中，绿=成功/收入；色块内文字统一 `--on-color` |
| 数字 | 余额与指标用展示字体 + `tabular-nums`，字号独立于正文阶梯 |
| 层级 | 贴纸不套贴纸：卡片内部只用细线，表格行不带投影 |
| 主题 | 唯一开关是 `<html data-theme>`；浅/深两套值；组件不写主题分支 |
| 无障碍 | 焦点 2px 外框 offset 2px；手机输入 ≥16px；触控 ≥44px；减动效下无位移 |
| 排版纪律 | 正文 14px（参考自身），标题 18/26/38，辅助 12/13；**该字号不满足本项目 16px 正文要求** |

**目标信息架构、页面内容与交互以 `docs/phase10/FLOWS.md` 与主任务为准。** 本报告不提出五页划分、不提出组件清单、不提出 token 取值。

---

## 6. 可复制边界

| 对象 | 结论 | 依据 |
|---|---|---|
| 贴纸风（纸面、墨线、硬投影、胶囊、按压） | 可参照 | 风格与配色不受版权保护 |
| 芥末黄、薄荷/粉/天蓝等颜色值 | 可参照 | 同上 |
| 源码文本（.tsx/.css/.svg） | **不可复制** | 无 LICENSE，默认保留所有权利 |
| logo/卷角贴纸 O/吉祥物/favicon/字标/截图 | **不可复制** | 品牌素材 |
| Baloo 2 / 源泉圆体字体文件 | 法律允许（OFL 1.1），但不建议 | 6.2 MB + 77 切片 |
| 中文文案、项目命名 | 不可复制 | 表达与标识 |

---

## 7. 参考系统里明确不属于本项目目标的部分（事实对照）

| 参考系统有 | 本项目目标（见 FLOWS） |
|---|---|
| 13 项导航、4 个分组 | 5 页 |
| 首页 4 张指标卡 + 今日四指标 | 首页只给对外结论（网络状态/可用模型/我的共享/钱包/待办），不含引擎内部检查 |
| 余额卡 Sparkline、多处 Badge | 未要求 |
| C2C 买/卖积分、站外人民币 | 不引入 |
| 论坛、工单、管理后台 | 不引入 |
| 角色开关（共享/使用）与目录发布两步 | 分享是一次"分享这些模型"，不分享也能发现/消费；无角色开关 |
| 端口/网络参数在设置页可编辑 | 端口自动分配，只在网络诊断只读展示 |
| 申请/授权文件往返 | B 目标无文件（覆盖网内结构化消息 + E2E 加密） |
| 只支持测试网 | C 是钱包与主网准备（主网只读、真实资金 NO-GO、隔离钱包与自动充值策略是开发目标） |

---

## 8. UNKNOWN

1. 线上登录后页面的实际渲染（未登录；只用仓库截图与源码）。
2. `ai.isok.dev` 对应 commit（6 个候选构建 hash 均不匹配）。
3. 维护者是否愿意授权代码复用（无 LICENSE）。
4. Firefox/Safari、真实屏幕阅读器与键盘全流程（本轮只用 Chromium）。
5. 参考系统的 110 token 在长文本/极端数据下的表现（未测）。

---

## 9. 复现命令

```bash
gh api repos/NexusAgentX/Oh-My-AIHub --jq '{license:.license}'
gh api repos/NexusAgentX/Oh-My-AIHub/commits/bc47f41d763b59ba956f36b661f88d9a54892490 --jq .sha
git -C ~/Projects/Oh-My-AIHub rev-parse HEAD origin/main
git -C ~/Projects/Oh-My-AIHub rev-parse HEAD:frontend/src/styles/tokens.css
gh api 'repos/NexusAgentX/Oh-My-AIHub/contents/frontend/src/styles/tokens.css?ref=bc47f41d763b59ba956f36b661f88d9a54892490' --jq .sha

git -C ~/Projects/Oh-My-AIHub archive bc47f41 frontend | tar -x -C <build-dir>
ln -s ~/Projects/Oh-My-AIHub/frontend/node_modules <build-dir>/frontend/node_modules
cd <build-dir>/frontend && npx vite build
```

---

## 10. 读过的文件（固定 SHA）

`DESIGN.md`；`docs/adr/0033-*.md`；`docs/stitch/{README,visual-language,product-spec,desktop,mobile}.md`；`frontend/src/styles/{tokens,base,index,fonts}.css`；`frontend/src/theme/{theme.ts,../public/theme-init.js}`；`frontend/src/layouts/{AppFrame.tsx,layout.css,navigation.ts,Brand.tsx}`；`frontend/src/ui/{index.ts,Button.css,Card.css,Table.css,Tabs.css,Form.css,Icon.tsx,Mascot.tsx}`；`frontend/src/home/{HomePage.tsx,StartCard.tsx,home.css,queries.ts}`；`frontend/src/market/{Pages.tsx,Hall.tsx}`；`frontend/src/points/PointsPage.tsx`；`frontend/src/account/{AccountPage.tsx,MePage.tsx}`；`frontend/src/money/*`；`README.md`、`SECURITY.md`、`docs/stitch/README.md`、`compose.yaml`、`mise.toml`、`frontend/package.json`、`frontend/public/licenses/fonts.txt`。
