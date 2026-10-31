# Phase 10 A — 共享控件修复（share controls fix）

> 状态标签：**VERIFIED** = 读源码/跑测试确认；**REPRODUCED** = 真实浏览器实际看到；**UNKNOWN** = 未覆盖。
> 分支：`feature/phase10-a-share-controls-fix`
> 基线：**approved PR37 head `fa20a02e803847cd53d06394992230bcb7f5e3a1`**（`feature/phase10-a-model-evidence-ui`）。未改冻结 25/37/42。
> 来源：A-lab 真实两节点 E2E 报告 `/tmp/oma-research/A-LAB-1c14ec4-BROWSER.md`（F1 分享按钮不同步、F2 停止共享仍可见）。
> 范围：只修 `plugin/console` 共享控件与其测试/夹具；不碰 overlay、钱包、B 无文件流程。

---

## 1. 两个真实阻断与根因

| # | 现象 | 根因 |
| --- | --- | --- |
| F1 | 勾选模型后「分享这些模型」仍 disabled，必须在搜索框输入触发重渲染才可点；取消勾选后仍可点 | `renderModels()` 只在渲染时设置 `modelSave.disabled`；checkbox `change` 只更新 `selectedModels`，没有同步按钮状态 |
| F2 | 未共享时「停止共享」`hidden=true` 但仍显示且可 Tab 聚焦 | 组件样式 `.button { display: inline-flex }` 优先级高于 UA 的 `[hidden] { display: none }`，`hidden` 属性被覆盖 |

---

## 2. 修复

- **统一状态函数** `updateSelectionControls()`：唯一决定
  - `modelSave.disabled = working || 选中且可授权的模型数为 0`；
  - `stopShareButton.hidden = !sharingEnabled`。
  调用点覆盖：每个 checkbox `change`、过滤/搜索重渲染结束、`render(state)`、`run()` 的 `finally`（忙碌结束恢复后）、候选项重载/清空。
- **忙碌不可重入**：`confirmShare()`、`stopSharing()` 在 `working` 时直接返回；`run()` 的 `finally` 先恢复控件再重新同步，避免把“0 选禁用”还原成可点。
- **`[hidden]` 真正生效**：全局 `[hidden] { display: none !important; }`。隐藏控件不再显示、`offsetParent === null`、无法聚焦。检查过现有 `hidden` 用法（面板、notice、pairing、tabs、stop 按钮）均为“不可见即不应交互”，无 `dialog`/`tabindex` 依赖被破坏。
- 过滤/搜索不再丢选择：`selectedModels` 与渲染解耦，重渲染不会清空已选集合。

---

## 3. 测试

### 3.1 行为测试（mock DOM）

```bash
cd plugin
bun test ./console     # 87 pass / 0 fail / 675 assertions
bun run typecheck      # clean
bun run secret-scan    # PASS
```

新增用例：

- 初始有选中 → 分享可用；全部取消 → 禁用；选 1 个 → 启用；再选第 2 个 → 仍启用。
- 搜索过滤到只剩 1 个可见模型 → 已选集合保留、按钮仍可用；清空搜索 → 两个仍选中。
- 运行中的 action（未完成）→ 再次点击分享不会打开确认弹窗；只发出已经在跑的那一次请求。
- 未共享状态 → 停止按钮 `hidden === true`；切回共享状态 → 恢复可见。
- CSS 断言 `[hidden] { display: none !important; }` 存在（实际显示/焦点由浏览器脚本验证）。

### 3.2 真实浏览器检查（REPRODUCED）

脚本：`plugin/scripts/share-controls-check.mjs`（ego-lite，合成 fixture，不接触真实节点）。

```bash
bun run plugin/scripts/console-preview.ts --scenario configured --port 61397 &
bun run plugin/scripts/console-preview.ts --scenario unshared  --port 61398 &
ego-browser nodejs < plugin/scripts/share-controls-check.mjs
```

- **修复前（fa20a02）**：`failed: 3` —— 未共享时停止按钮 `display:flex`、可聚焦（3 项失败）。
- **修复后**：`failed: 0` —— 清理全部选中后分享禁用、选 1 个启用、过滤往返不丢选择、启用后能打开确认弹窗；未共享时停止按钮 `display:none`、`offsetParent === null`、`focus()` 不生效。

截图：`docs/phase10-a-share-controls/`（分享选中、未共享停止按钮不可见）。

---

## 4. 未覆盖（UNKNOWN）

- 真实两节点下的分享/停止分享端到端仍由 A-lab 复验；本分支只修客户端状态与可交互性。
- 键盘完整 tab 顺序在真实设备上的回归由 6a 按原失败场景复核。
- 不涉及钱包、overlay、B 无文件流程；这些分支未改动。
