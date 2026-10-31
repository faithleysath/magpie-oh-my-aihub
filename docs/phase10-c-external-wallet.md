# Phase 10 C — 外置钱包标准适配（external-wallet）

- 分支：`feature/phase10-c-external-wallet`
- 原基线：`origin/main` = `8ce5c57f565fb1b835021a9b730b61014eb47d5f`（PR13 已合并）
- 重建基线：已批准的 P0-clock `889973f55ca3a72da99ae0091e50ecd5ea428207`（PR #15，独立待审）；本分支只重放 C commits，不再 cherry-pick clock。旧 head `837bacb` 已保存为 `archive/phase10-c-external-wallet-837bacb`，上一 review target `d533e6f` 保存为 `archive/phase10-c-external-wallet-d533e6f` 审计点。
- PR #30 base 已改为 `fix/phase10-validation-clock`，因此 GitHub diff 只显示 C 模块相对 approved clock 的 delta；不再把 clock 混入 C review。
- 模块：`plugin/console/external-wallet.js`（纯浏览器 ESM，无构建步骤、无运行时框架）
- 测试：`plugin/console/external-wallet.test.js`
- 本机目标版本：Magpie **0.1.2289** + EasyTier **2.6.4**，隔离副本；本模块不读写用户 Magpie 安装/数据。
- 结论：**模块与合成 provider 单测完成；真实 MetaMask 13.55.0 / Rabby 0.94.14 兼容性仍是 UNKNOWN**。没有主网发送、没有真实资金、没有安装扩展到用户默认 profile。

> 本文所有“已通过”均指**本地合成 EIP-1193 provider 单测**，不是真实扩展验收，也不代表主网安全。
> 真实扩展测试计划与隔离实验见 `/tmp/oma-research/EXTERNAL-WALLET-TEST-PLAN.md` 和
> `/tmp/oma-research/EXTERNAL-WALLET-ISOLATION-EXPERIMENT.md`（只读参考，不在仓库内）。

## 1. 范围与明确不做

本单元只提供**可集成的外置钱包标准适配模块**，供 A-ui 后续接入现有控制台：

- EIP-6963 多钱包发现（`announceProvider` + 主动 `requestProvider`）；
- 用户明确选择一个扩展后，建立 EIP-1193 会话；
- 账户/网络/原生与 ERC-20 余额查询；
- 用户明确请求 `wallet_switchEthereumChain`；不自动切链；
- 服务已校验的 EIP-712 充值请求，用 `eth_signTypedData_v4` 签名，并在本机 `recoverAddress`；
- 模拟/测试网 ERC-20 转账的准确预览、逐笔确认、`eth_sendTransaction` 与回执状态。

不做：

- 不实现 C-registry 的资产/网络注册表；只消费它的窄快照（见 §5）；
- 不实现内置钱包核心（C-wallet 的创建/恢复/加密存储）；只预留可对接的签名与转账边界；
- 不新增 DHT、mDNS、路由、中心化中转、法币或代币发行；
- 不桥接、不 swap、不 `wallet_watchAsset`、不 `wallet_addEthereumChain`、不做代币授权；
- 不暴露任意 RPC 方法或任意 calldata 给 P2P/用户输入；
- 不把广播哈希、回执成功或扩展 `info` 当作已入账/身份认证；
- 不保存账户、provider 对象、签名、助记词或私钥到任何浏览器持久存储。

## 2. 公开 API（供 A-ui 集成）

模块导出：

```js
import {
  createWalletDiscovery, createExternalWallet,
  validateDepositDocument, typedDataDigest, recoverTypedDataSigner,
  formatUnits, safeWalletIcon, sanitizeWalletInfo,
  isMainnetChainId, assertNoMainnetSend,
  EIP6963_ANNOUNCE, EIP6963_REQUEST, TESTNET_CHAIN_IDS, MAINNET_CHAIN_IDS,
  WALLET_ERROR, ExternalWalletError,
} from "./external-wallet.js";
```

### 2.1 发现：`createWalletDiscovery({ target?, now? })`

- 只监听 `eip6963:announceProvider`，并主动派发 `eip6963:requestProvider`。
- **不读取、不自动选择 `window.ethereum`**；旧式 provider 只作为 `"legacy"` 显式选项出现。
- `start()` 注册监听并请求一次；`stop()/dispose()` 移除监听并清空缓存。
- `list()` 返回 sanitized 展示项：`id, uuid, name, rdns, icon, initial, identity:"unverified", source, warnings, announcedAt`。**`icon` 恒为 null，`initial` 是名称首字符；不含 provider 对象。**
- `select(id)` 是显式选择：返回 `{ id, provider, info }`；不调用 provider。`select("legacy")` 才使用 `window.ethereum`。
- 同一 provider 重新 announce 时保留内部 `id` 和 provider 引用；不同 provider 使用同一 `uuid` 时不合并，标记 `uuid-claimed-by-multiple-providers`。
- `info` 永远不是身份认证；`identity` 固定为 `"unverified"`。

**A-ui 要求**：必须渲染钱包选择列表并让用户点击一个；不得在页面加载时调用 `eth_requestAccounts`，不得从 `window.ethereum` 自动挑一个。

### 2.2 会话：`createExternalWallet({ discovery, selectionId, registry, ... })`

构造时**不调用 provider**；只有 `connect({ userInitiated: true })` 才发送 `eth_requestAccounts`。

```js
const session = createExternalWallet({
  discovery,
  selectionId,                         // 用户明确选择的 id
  registry,                            // { networks, assets } 或 () => 该快照
  allowMainnetRead: false,             // 默认 false；主网只读需显式打开
  allowedChainIds: [97, 84532],        // 默认测试网
  timeouts: { rpcMs, connectMs, signMs, switchMs, sendMs },
  previewTtlMs: 120000,
  now: () => Date.now(),               // 测试可注入
  operationPort: null,                 // 必须注入 Service 持久 journal 才能发送
});
```

方法（全部为固定操作，无 `request(method, params)` 透传）：

| 方法 | 作用 | 前置 |
| --- | --- | --- |
| `connect({userInitiated:true})` | `eth_requestAccounts` + `eth_chainId` | 用户明确连接 |
| `refresh()` | 只用 `eth_accounts` + `eth_chainId` 刷新 | 已明确连接 |
| `readBalances({assetId?})` | `eth_getBalance` / 固定 `balanceOf` `eth_call` | 已连接；主网只读需 `allowMainnetRead`；**不切链** |
| `requestSwitchChain(chainId,{userInitiated:true})` | 只调用 `wallet_switchEthereumChain` | 用户明确请求；不自动添加网络 |
| `signDeposit(document,{userInitiated:true, expectedIntentHash?})` | 精确校验 EIP-712 后签名并本地恢复地址 | 已连接、网络匹配、未过期；**必须本地已登记可授信资产** |
| `prepareTransfer({userInitiated:true, assetId, amountRaw, recipientAddress})` | 准确余额/gas/calldata 预览 | 已连接、测试网、已注册 mock 资产 |
| `confirmTransfer(preview,{userInitiated:true, acknowledged:true, previewId})` | 逐笔确认 + Service journal 预留/记录后 `eth_sendTransaction` | 预览未过期、无 blocker、状态未变、**已注入 operationPort** |
| `getReceipt(hash)` | `eth_getTransactionReceipt` | 只读链证据；不代表预期转账/入账 |
| `snapshot()` | 无 provider 的状态快照 | 任意 |
| `subscribe(fn)` | 状态变化（账户/网络/断开） | 任意 |
| `isCurrent(generation)` | 检查旧 generation 是否仍有效 | 任意 |
| `dispose()` | 移除事件监听并清空内存中的账户/provider | 任意 |

`connect`、`signDeposit`、`prepareTransfer`、`requestSwitchChain`、`confirmTransfer` 均要求 `userInitiated: true`；`confirmTransfer` 还要求 `acknowledged: true`、完全相同的 `previewId`，并且**必须注入 `operationPort`**。缺失时返回 `EXPLICIT_ACTION_REQUIRED` / `PREVIEW_CONFIRMATION_REQUIRED` / `OPERATION_JOURNAL_REQUIRED`，且不调用 provider。

事件：

- `accountsChanged` / `chainChanged` / `disconnect` 会更新会话并递增 `generation`；
- 旧 `generation` 的签名结果、预览和确认一律失效；
- 签名过程中切账户/切链，签名被丢弃并返回 `WALLET_STATE_CHANGED`；
- 发送期间状态变化时仍返回交易哈希，但带 `staleAfterSend: true`，提示只按哈希查链、不要重发。

### 2.3 充值签名：`signDeposit`

`document` 必须是服务端 `deposit-document-preview` 返回的 **`result.document` 本体**，不是外层 `{document, verified}` 包装。模块会再次校验：

- 严格字段集合（多/少字段都拒绝）；
- `schema === "ohmyaihub.deposit-request/v1"`；
- chainId 在允许测试网内；56/8453 直接 `MAINNET_BLOCKED`；
- 资产四元组：`assetId = eip155:<chainId>:<contract>`，合约地址、decimals 0..36；
- `amount.tokens === formatUnits(amount.raw, decimals)`；raw > 0 且 ≤ uint256；
- `expiresAt` 未过期，且与 EIP-712 message 的秒级时间一致；
- EIP-712 `types` 与固定 `DEPOSIT_TYPES` 完全一致、`primaryType = DepositIntent`；
- `domain` 精确等于 `{name:"Oh My AI Hub", version:"1", chainId, verifyingContract:0x...a1b2}`；
- `message` 的 invoice/consumer/provider/chain/asset/contract/recipient/amount/nonce/requestedAt/expiresAt 全部与显示字段一致；
- 本地重算 `typedDataDigest`，必须等于 `document.digest`；如传入 `expectedIntentHash`，也必须相等。

签名后：

- 校验 65 字节 `r||s||v`；
- 用本地 secp256k1 从 digest 恢复地址；
- 恢复地址必须等于当前选择的公开账户，否则 `INVALID_SIGNATURE` 并丢弃签名；
- 返回 `{signature, payerAddress, digest, chainId, expiresAt, generation}`；模块不持久化签名。

**重要边界**：签名只证明“该测试网账户同意这份归属请求”，不产生转账、不授信、不入账。入账由服务端 Wallet/Ledger 在验证 EIP-712 签名和链事件后决定。

`signDeposit` **始终**要求请求资产在本地注册表中已登记、启用、`testnetOnly`、`issuerType === "mock"`、`credit === true`、`pricingKind === "fixed-test-rate"`，并逐项核对 decimals 与资产四元组；未知资产、未知发行方、禁用或不可授信资产一律拒绝。原 `allowUnregisteredAsset` 布尔绕过已移除；如果未来要支持远方注册资产，必须走明确经认证的 provider/签名报价/资产元数据审阅的独立导入协议，不在本模块用 bool 假装已信任（当前不实现）。服务端入账前仍必须以自己的注册表拒绝未知资产/发行方。

### 2.4 测试网 ERC-20 预览与发送

`prepareTransfer` 只接受 `assetId`、`amountRaw`、`recipientAddress` 和可选 `intentHash`（32-byte 摘要，仅写入 operation/journalkey，不是身份证明），不接受 method/calldata/to 等动态字段。它固定执行：

1. 重新读 `eth_accounts` / `eth_chainId`；
2. 从注册表严格取网络与资产（见 §5）；
3. `eth_call` 读 ERC-20 `balanceOf`；
4. `eth_getBalance` 读原生余额；
5. `eth_estimateGas` 估算固定 `transfer(address,uint256)` 调用；
6. `eth_gasPrice` 取当前 legacy gas price；
7. 计算 `estimatedFeeRaw = gasLimit * gasPrice`，生成不可变预览。

预览包含：`chainId`、`account`、资产四元组、`amountRaw/amountTokens`、`tokenBalance`、`nativeBalance`、`gasLimit`、`gasPrice`、`estimatedFeeNative`、完整 `call.data`、`calldataHash`、`intentHash`、`blockers`、`canSend`、`previewId`、`expiresAt`。余额不足是显式 blocker，不会伪造为 0 成功，也不会发送。

`confirmTransfer`：

- **没有注入 `operationPort` 时直接返回 `OPERATION_JOURNAL_REQUIRED`，不调用 provider。** 当前 PR 不包含 Service journal 实现，所以发送功能默认不可用。
- 只接受本模块 `WeakMap` 中登记过的预览对象，伪造预览返回 `PREVIEW_NOT_ISSUED`；
- 再次读账户/网络/余额/gas；账户、链、gas 估算或 gas price 任一变化 → `PREVIEW_STALE`，不发送；
- 再次检查 blockers 与有效期；
- 以精确 operation（intentHash、account、chainId、assetId、contract、recipient、amountRaw、calldata、calldataHash）调用 `operationPort.reserve`；journal 返回 `unknown`/`broadcasting`/`broadcast` 时拒绝发送；
- 发送前调用 `operationPort.markBroadcasting`；失败则不发送；
- 只调用一次固定 `eth_sendTransaction`，参数仅含 `from/to/value/data/gas/gasPrice`；
- 返回哈希后调用 `operationPort.recordHash`；超时/无效哈希/钱包错误调用 `operationPort.recordUnknown` 并进入 unknown，不允许同一 preview 重发；
- 同一预览重复/并发确认只发送一次，后续返回 `alreadySent: true` 与同一哈希；
- 返回 `broadcast: true`、`credited: false`、`transferVerified: false`、`finality: "unknown"`。**广播不是入账，也不是预期转账确认。**

`getReceipt(hash)` 返回 `pending | success | reverted | unknown`，固定 `evidence: "chain-receipt"`、`credited: false`、`transferVerified: false`、`finality: "unknown"`；回执只证明该哈希的链上执行结果，**不核验 from/to/input/logs，不证明预期转账或入账**。from/to/input/Transfer 日志验证仍由既有 service Watcher 负责；RPC 错误或未知结果不会触发任何重发。

### 2.5 Service 持久 operation journal：窄接口

浏览器模块不保存跨刷新状态，也不使用 localStorage/sessionStorage/indexedDB。发送必须注入：

```ts
interface ExternalWalletOperationPort {
  reserve(operation): Promise<{
    reservationId: string;
    state: "reserved" | "broadcasting" | "broadcast" | "unknown";
    hash?: string | null;
  }>;
  markBroadcasting(input: { reservationId: string; operation: Operation }): Promise<void>;
  recordHash(input: { reservationId: string; operation: Operation; hash: string }): Promise<void>;
  recordUnknown(input: { reservationId: string; operation: Operation; reason: string }): Promise<void>;
  query(operation): Promise<{ state: string; hash?: string | null } | null>; // recovery UI/service
}

type Operation = {
  schema: "ohmyaihub.external-wallet.operation/v1";
  intentHash: string | null;      // 调用方传入的 32-byte 摘要；不是身份证明
  account: string;
  chainId: number;
  assetId: string;
  contractAddress: string;
  recipientAddress: string;
  amountRaw: string;
  calldata: string;
  calldataHash: string;
};
```

- `reserve` 必须按精确 operation 幂等；不得只按 `previewId` 建键。已有 `reserved/broadcasting/broadcast/unknown` 时，后到调用不得再获得 `state:"reserved"`（service 必须单赢家/原子）。
- `markBroadcasting` 必须是 `reserved -> broadcasting` 的 CAS，校验 `reservationId`，并在返回前已持久化（事务/fsync）。失败则模块不发送；否则两个 tab 可能各发一笔。
- `recordHash`/`recordUnknown` 失败时模块进入 unknown 并报 `OPERATION_JOURNAL_FAILED`，不自动重发。`4001/USER_REJECTED` 也走 `recordUnknown`；service 决定是否安全释放该 reservation（否则同 intentHash 可能被 bricked）。
- `intentHash` 可省略；省略时 service 按 `(account,chain,asset,contract,recipient,amountRaw,calldataHash)` 合并。service 必须校验 `intentHash` 对应已存 intent 的 tuple 与 operation 一致；origin/provider 身份校验属 service scope，模块不验证。
- `query` 用于服务/UI 恢复；本模块当前不替代 service 的恢复状态机。
- **当前状态**：journal 实现不在本 PR；测试中的 `memoryOperationPort` 是模拟，不是 Service 接线，且其 `reserve` 不是原子单赢家。刷新/新 session 只有在同一持久 journal 实现下才能阻止同 intent 再次发送；模块自身内存幂等不等于跨刷新安全。
- `query` 模块当前不调用，仅供 service/UI 恢复。

## 3. 安全与门禁

### 3.1 扩展信息不可信

- `name`：去控制字符/双向控制字符，去 `<`/`>`，限长 80；空名显示“未命名钱包”。
- `rdns`：只允许 DNS 形状，非法则清空并标记 `invalid-rdns`。
- `uuid`：必须是 UUID 形状；非法则清空并标记 `invalid-uuid`；重复时两个 provider 都保留并标记，不合并。
- `icon`：**不渲染任何钱包提供的 `data:`/SVG 图标**。`safeWalletIcon()` 恒返回 null；`sanitizeWalletInfo()` 返回 `icon:null` 和 `initial`（名称首字符），有图标时记 `icon-not-rendered`。UI 只用名称/首字母或内置静态图标；不放宽 CSP，不做完整 SVG sanitizer。
- `identity` 固定 `"unverified"`；`info` 永远不能用于授权、额度或身份判断。真正身份由既有目录指纹/服务层授权决定。
- provider 引用只保存在发现记录/会话内存中；重新 announce 不会丢失它，也不写入存储。

### 3.2 方法面与参数面

模块源码中出现的 RPC 方法集合固定为：

```text
eth_accounts, eth_call, eth_chainId, eth_estimateGas, eth_gasPrice,
eth_getBalance, eth_getTransactionReceipt, eth_requestAccounts,
eth_sendTransaction, eth_signTypedData_v4, wallet_switchEthereumChain
```

单测会静态断言该集合，且断言不存在 `eth_sign`、`eth_signTransaction`、`eth_sendRawTransaction`、`wallet_addEthereumChain`、`wallet_watchAsset`、`wallet_requestPermissions`。

### 3.3 不作弊的门禁

- **未知网络/代币/decimals/发行方**：注册表查找失败即拒绝；发送仅允许 `testnetOnly` 且 `issuerType === "mock"`。
- **核心 credit 链路 allowlist**：`CREDIT_CHAIN_IDS = [97,84532]`；`allowedChainIds` 只能是显式 switch 的收窄集合，不能扩大核心集合。chain 1 即使 `networkType:"testnet"`、`enabled/support/receivable/credit` 全伪造成可授信，`prepareTransfer`/`signDeposit`/`requestSwitchChain` 仍 `UNKNOWN_CHAIN`；56/8453 仍由 `assertNoMainnetSend` 先行阻断。
- **主网 56/8453**：`prepareTransfer`、`confirmTransfer`、`signDeposit` 默认硬拒绝；`requestSwitchChain` 默认也拒绝，主网只读需 `allowMainnetRead: true` + 记录 `support: "read-only"` + 用户显式 `requestSwitchChain(...,{userInitiated:true})`，且仍然不能发送。`readBalances` **不会**因 `allowMainnetRead` 自动切链；普通余额查询只读当前链。`allowMainnetRead` 只影响只读展示，不能解锁发送/授信/自动充值。浏览器模块是 defense-in-depth，**不是唯一门禁**；服务层必须保持同样的主网硬阻断。
- **不自动切链**：网络不匹配时返回 `CHAIN_MISMATCH`，由用户显式调用 `requestSwitchChain`。
- **不自动添加网络**：`wallet_switchEthereumChain` 返回 4901 时只报 `CHAIN_NOT_ADDED`，不调用 `wallet_addEthereumChain`。
- **未接线不发送**：没有注入 `operationPort` 时 `confirmTransfer` 返回 `OPERATION_JOURNAL_REQUIRED`，不调用 provider。
- **不自动重发**：注入 journal 后，发送超时/无效哈希/钱包错误 → `recordUnknown` + `UNKNOWN_BROADCAST/OPERATION_UNKNOWN`，第二次确认/新 session 同 operation 直接拒绝；只允许用户用已知哈希查回执。
- **跨刷新安全**：模块内存 `previewId` 墓碑不等于跨刷新安全；只有 Service 持久 journal 能阻止刷新/换扩展后同 intent 再次发送。当前 PR 不含 journal 实现。
- **不把广播当入账**：所有发送/回执结果都固定 `credited: false`；只读余额返回 `readOnly:true`、`creditEligible:false`、`usdValue:null`（主网/只读记录），不会并入可消费额度。入账需要服务层账本与最终性证据。

### 3.4 无持久化/无秘密

模块不访问 `localStorage`、`sessionStorage`、`indexedDB`、`document.cookie` 或 `window.name`；不包含助记词/私钥输入字段；签名只在调用返回值中存在，`dispose()` 会清空内存中的账户与 provider 引用。单测静态断言这些属性。**当前 module 只做内存幂等；跨刷新/换扩展的防重复必须依赖注入的 Service journal，不能靠浏览器存储。**

## 4. 验证状态

### 4.1 本次已执行（合成 provider，非真实扩展）

| 项 | 命令 | 结果 | 标签 |
| --- | --- | --- | --- |
| 模块单测 | `bun test plugin/console/external-wallet.test.js` | **52 pass / 0 fail / 336 assertions** | REPRODUCED（合成 provider） |
| 既有控制台测试 | `bun test plugin/console` | **106 pass / 0 fail / 783 assertions** | REPRODUCED |
| 服务端安全/静态文件测试 | `bun test plugin/test/console-security.test.ts` | **32 pass / 0 fail / 1967 assertions** | REPRODUCED |
| TypeScript 类型检查 | `cd plugin && bun run typecheck` | exit 0 | REPRODUCED |
| 旧 head `837bacb` + 新行为测试 | 同文件复制到旧 head | **42 pass / 8 fail**（证明旧 bool 绕过、无 journal 发送、receipt 文案在旧 head 失败） | REPRODUCED（旧 head，预期失败） |
| 上一 review target `d533e6f` + 最新测试 | 同文件复制到 d533e6f | **48 pass / 4 fail**（chain 1 伪装、SVG/data 图标、receipt executionStatus 断言失败） | REPRODUCED（旧 target，预期失败） |
| 旧 head 临时 guard 全量（历史） | `bun test --max-concurrency=1 ./test ./console ../docs/validation/lab/phase9/wallet-fixture`（临时 `60d0d04`） | **799 pass / 0 fail / 6248 assertions**（54 files） | REPRODUCED，仅旧 head 历史；新 head 未按主审要求重跑全量 |
| CI（GitHub Actions） | run `41161185158`（code head `5875d44`） | **linux 798 pass / 1 skip / 0 fail；macOS 797 pass / 1 skip / 0 fail** | REPRODUCED（CI，合成 fixture） |
| boot-check | `bun run boot-check` | PASS | REPRODUCED |
| secret-scan | `bun run secret-scan` | PASS | REPRODUCED |
| Keccak/EIP-712/recover 与 `plugin/src/{keccak,eip712,secp256k1}.ts` 对照 | 单测内 | 相同 digest、相同恢复地址 | REPRODUCED |

单测覆盖（逐条）：

- EIP-6963 双 provider 发现、主动 request、显式选择、provider 引用保留、重新 announce；
- legacy `window.ethereum` 显式选择、未选择前不调用 `eth_requestAccounts`；
- 名称/rdns/uuid 注入、重复 uuid、伪装/非法字段；**不渲染任何 data/SVG 图标，只返回名称 initial**；
- 4001 / 4100 / 4900 / 超时；账户/网络/断开事件；旧 generation 失效；
- `signDeposit` 精确 typed data、digest/intentHash、错误 chain、主网拒绝、本地资产/发行方/精度/credit/pricing、未知资产/发行方一律拒绝（旧 bool 绕过已删）、用户拒绝/锁定/超时、签名账户不符、签名期间切账户/切链；
- `prepareTransfer` 精确 token/native 余额、gas、fee、calldata、blockers、未知 chain/token/decimals/issuer/disabled、缺 support/receivable/credit/pricing、伪造 testnet 主网、**chain 1 + client allowedChainIds 仍拒绝**；
- 显式逐笔确认、伪造预览、缺确认、主网拒绝、余额不足、切账户/切链/gas 变化导致 `PREVIEW_STALE`；
- 未注入 `operationPort` 时拒绝发送且零 provider 调用；模拟 journal 的 reserve → markBroadcasting → send → recordHash 顺序、markBroadcasting 失败不发、已有 broadcasting 不发送、跨新 session 同 operation unknown 不重发；
- 重复/并发确认只发一次；发送超时/无效哈希/用户拒绝进入 unknown 并记录 journal，不自动重试；
- 回执 pending/success/reverted/unknown、哈希不匹配、`executionStatus`、`transferVerified:false`、`paymentStatus:"unverified"`、广播不等于预期转账/入账；
- 余额查询不切链；无通用方法透传、无存储、dispose 清理监听。

### 4.2 真实扩展：UNKNOWN / BLOCKED

| 项 | 状态 | 说明 |
| --- | --- | --- |
| MetaMask 13.55.0 真实扩展 | **UNKNOWN** | 未安装到任何测试 profile，未连接，未签名 |
| Rabby 0.94.14 真实扩展 | **UNKNOWN** | 同上 |
| 双扩展 EIP-6963 共存 | **UNKNOWN** | 只用合成 provider 验证了发现逻辑，不能替代真实扩展 |
| 锁定/解锁、真实拒绝 UI | **UNKNOWN** | 合成 provider 只模拟错误码 |
| ego-lite 隔离 profile | **BLOCKED/UNKNOWN** | 预审时只有 1 个默认 profile；后续独立 data-dir 进程能启动，但 ego-lite onboarding 阻塞 agent CLI，未进入扩展安装/EIP-6963 阶段。未安装扩展、未创建钱包、未读默认 profile |
| 用户生产钱包 | **UNKNOWN，未读取** | 不检查扩展清单、存储或恢复短语 |

**不得声称“兼容 MetaMask/Rabby”**。真实兼容验收需要独立、干净、可销毁的浏览器 profile，且必须实际看到扩展注入、EIP-6963 announcement、真实签名与拒绝路径；当前条件不满足。

### 4.3 主网/真实资金

- 本次没有使用任何真实 RPC、主网资产、热钱包或真实资金。
- 主网 56/8453 的拒绝是**代码路径单测**（合成 provider），不是主网实测；服务层硬门禁仍需 C-registry/C-wallet/D 审核。
- 自动充值策略、真实发送、真实授信仍未实现/未授权。

## 5. 与 C-registry / C-wallet 的窄接口

不重复实现注册表。模块只消费以下字段（其他字段忽略）：

```ts
type RegistrySnapshot = {
  networks: Array<{
    chainId: number;
    displayName: string;
    family?: "evm";                 // 出现且非 evm 时拒绝
    networkType: "testnet" | "mainnet";
    enabled: boolean;               // watcher/credit 开关，不是展示开关
    support: "credit" | "read-only";
    receivable: boolean;
    nativeSymbol: string;
    nativeDecimals?: number;        // 缺省 18；非法则拒绝
  }>;
  assets: Array<{
    assetId: string;                // eip155:<chainId>:<contract lowercase>
    chainId: number;
    contractAddress: string;
    symbol: string;
    decimals: number;               // 0..36
    issuerType: "mock" | "native-issuer" | "bridged";
    testnetOnly: boolean;
    enabled: boolean;
    credit: boolean;
    // 内部 AssetRecord 用 pricing.kind；页面/WalletStatus 投影用 pricingKind。
    // 两者只接受一个，且必须与 credit 一致；不得从 priceVersion 子串推断。
    pricing?: { kind: "fixed-test-rate" | "not-creditable" };
    pricingKind?: "fixed-test-rate" | "not-creditable";
  }>;
};
```

- 发送/签名额外要求：`networkType === "testnet"`、`enabled === true`、`support === "credit"`、`receivable === true`、资产 `testnetOnly === true`、`credit === true`、`pricing.kind`/`pricingKind === "fixed-test-rate"`、`issuerType === "mock"`。旧记录缺 `support/receivable/credit/pricing` 时不默认安全，直接 `INVALID_REGISTRY`；不接受用 `priceVersion` 子串猜测。这是本阶段钱包边界，不是对 C-registry 的替代。
- 主网 56/8453 以 **chainId 硬集合**拒绝发送/签名；即使记录把 `networkType` 伪造成 `"testnet"`、`enabled: true`、`support: "credit"`，仍返回 `MAINNET_BLOCKED`。`isMainnetChainId` / `assertNoMainnetSend` 先作为 `plugin/src/mainnet-surface.ts`（C-registry PR #21 draft，未合并）合并前的本地副本；合并后应改为引用该文件。`allowMainnetRead` 只影响只读展示，不能解锁发送/授信/自动充值。
- 主网只读可通过 `allowMainnetRead: true` + `readBalances` 使用；发送仍拒绝。C-registry 负责主网只读平权、默认空选与严格四元组。
- C-wallet 内置钱包后续可复用同一 `validateDepositDocument` / `prepareTransfer` / `confirmTransfer` 语义；本模块不持有内置钱包密钥，也不实现其加密存储。

## 6. 集成注意（A-ui）

1. 增加 `/external-wallet.js` 到控制台静态文件白名单（本分支已在 `plugin/src/index.ts` 的 `staticModules` 增加，未改 `app.js/index.html/style.css/wallet.js`）。
   - A-ui 传入的 `registry` 必须是 C-registry 新快照（含 `support/receivable/credit/pricing` 或 `pricingKind`）。旧快照缺字段会 fail closed；不得用 `priceVersion` 子串推断可授信。
2. 页面加载只 `discovery.start()` 并展示发现列表；不要自动 `select`，不要自动 `connect`，不要读 `window.ethereum` 作为默认。
3. 钱包项必须显示 `name/rdns` 和“信息未验证”提示；图标只用 `safeWalletIcon` 返回值赋给 `<img src>`。**注意：现有 CSP 是 `img-src 'self'`，`data:` 图标会被浏览器拦截；A-ui 不要为了显示图标擅自放宽 CSP，先用名称首字母/默认图标，是否允许 `img-src data:` 需单独安全评审。**
4. 用户点击“连接”后才 `connect({userInitiated:true})`；连接后显示账户与 chainId。
5. 网络不一致时显示“请在钱包中切换”并给一个明确的切换按钮；按钮才调用 `requestSwitchChain(target,{userInitiated:true})`，失败不自动重试。
6. 签名流程：服务端返回的 `result.document` 交给 `signDeposit`，把 `expectedIntentHash` 传服务端已核验的 digest；不要用用户可编辑字段重新拼 typed data。
7. 转账流程：先 `prepareTransfer` 展示完整预览（网络、合约、收款地址、raw 金额、余额、gas、fee、blockers），用户逐笔勾选后再 `confirmTransfer`；**必须注入 Service journal，未接线时发送不可用**；不要复用旧预览，不要在 unknown 后自动重发。
8. 发送后只显示“已广播，未入账/未核验预期转账”；`getReceipt` 的 success 只是链证据，未核验 from/to/input/logs；入账/额度仍以服务端 Ledger/Watcher 和原生额度回读为准。
9. 会话结束/切换钱包时调用 `session.dispose()` 和 `discovery.stop()`；不要把账户、provider、签名写入 localStorage/sessionStorage。

A-ui 代理：`ccb08749-badc-4512-9604-e93ce7bd76b9`。

C-registry 代理 `0c94d106-6442-470f-8f14-374c38ea20f7` 的 PR #21（draft，head `5ef4430`，`docs/phase10-c-registry.md` §4/§4.7）要求 `support/receivable/credit/pricing` 与 chainId 硬门禁；内部 `AssetRecord` 是 `pricing.kind`，页面/WalletStatus 投影是 `pricingKind`，本模块两者都接受但拒绝不一致。已按该窄契约适配并在本地复制 `isMainnetChainId`/`assertNoMainnetSend`，未跨工作树写文件。C-wallet 代理 `01060df1-e5e8-4de8-b6cb-70ca932c7b1e` 的 PR #23（draft）确认无接口冲突：内置钱包使用 `PreparedTypedData`/`PreparedPayment`/`SigningPermit`，外置路径继续使用本模块。

## 7. 未决与限制

- 真实扩展兼容、锁定/拒绝 UI、双扩展共存：**UNKNOWN**；需要独立 profile 的真实验收，当前 BLOCKED。
- 主网发送硬门禁在本模块存在，但**服务层仍是权威**；不得以本模块代替 C-registry/C-wallet/D 的服务端门禁。
- `signDeposit` 始终要求本地资产登记；`allowUnregisteredAsset` 绕过已删除。当前不支持远方注册资产；未来必须通过经认证 provider/签名报价/资产元数据审阅的独立导入协议，服务端入账前仍须做资产/发行方门禁。
- `operationPort` 的 Service journal 实现不在本 PR；未接线时 `confirmTransfer` 默认不可用。内存 `memoryOperationPort` 测试只是模拟，不能替代 Service 持久 journal；刷新/新 session 的防重发必须由 Service 实现。
- gas 预览使用 legacy `eth_gasPrice`；真实钱包可能改用 EIP-1559 并在确认界面显示不同费用。gas limit 是 `eth_estimateGas` 的结果，实际消耗可能更低；不把预估值当作最终扣费。
- 没有处理交易替换/加速、nonce 冲突、钱包内 pending 队列；钱包可能改写 gas/fee/nonce，甚至 calldata/recipient；模块不核验交易内容。未知广播只允许按已知哈希查回执，不自动重发。
- 钱包图标一律不使用远端 data/SVG；只显示名称/首字母或内置静态图标。CSP 保持 `img-src 'self'`，不为图标放宽。
- 本次没有真实 RPC 或真实扩展证据；所有“REPRODUCED”均限合成 provider 单测。

## 8. 复现命令

```bash
cd /Users/laysath/.paseo/worktrees/1z728cdk/c-external-wallet
bun test plugin/console/external-wallet.test.js
bun test plugin/console
bun test plugin/test/console-security.test.ts
cd plugin && bun install --frozen-lockfile && bun run typecheck
```

全量测试前必须使用 hermetic network guard，阻止旧测试访问生产 `127.0.0.1:3425` 或公共 RPC。本分支不把该 guard 打进 PR。#17 guard check 路径独立审仍 FAIL/修复中；旧 head 在临时 detached worktree `60d0d04` 的 **799/0/6248（54 files）** 只能作为历史临时结果，不能称为全面 hermetic 验收。按主审要求，新 head 不重复全量，只做定向单测 + CI；CI `41161185158` 为 **linux 798 pass/1 skip/0 fail，macOS 797 pass/1 skip/0 fail**（后续 docs-only head 会另有同代码 CI）。并行默认全量曾与其他代理占用的固定端口 `127.0.0.1:13650` 冲突并出现非产品失败；该冲突 run 不作为代码结论。任务文本中的 `f63b644e` 是 P0-clock 代理 ID，不是 commit；实际 guard 为 `60d0d04`。
