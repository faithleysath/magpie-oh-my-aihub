# Phase 10 C1 — 主网只读注册表、收款网络选择与硬门禁

> 状态：**独立审查 fixes 已应用，待 re-review/合并**。本文只报告本单元（C1 registry + C2 选择 + C3 资产四元组 + C9 主网硬门禁）的实际结果，不代表 C 整体、UI 或真实资金验收。
>
> **真实资金：NO-GO。** 本单元没有发送、授信、自动充值、签名或广播路径；没有任何真实资产被移动。
>
> 基线：`origin/main` = `8ce5c57f565fb1b835021a9b730b61014eb47d5f`（PR13 已合并）
> 工作树：`/Users/laysath/.paseo/worktrees/1z728cdk/c-registry`
> 分支：`feature/phase10-c-mainnet-registry`
> 本单元原始 head：`5ef4430`（base `main` `8ce5c57`；CI run `41158999333` 仅 5 个已知时钟失败）。
> 已显式 stack 到 PR15 clock fix `889973f55ca3a72da99ae0091e50ecd5ea428207`（base branch `fix/phase10-validation-clock`）。stack 后 CI run `41159282548` 双平台 **pass**；原始 head 的 5 个已知 clock 失败记录见 run `41158999333`，原 head 保留在 `archive/phase10-c-registry-5ef4430`。最终 head/CI 以 PR #21 与 `/tmp/oma-research/C-REGISTRY-REVIEW-HANDOFF.md` 为准。
> 本单元代码 commit：`efc554f`（hard gate）、`70f28ee`（v2 registry）、`30ea31c`（selection/read-only/ledger guards）；本文档随后单独 commit
> 平台：macOS 26.6.2 (Darwin 25.6.0, arm64)；Bun 1.4.3；TypeScript 5.9.3
> 版本上下文：Magpie 0.1.2289 + EasyTier 2.6.4（本单元不启动宿主，不接触用户安装/数据）

标签约定：**VERIFIED** = 本次直接核对官方来源/源码/链上只读结果；**REPRODUCED** = 本次实际运行命令并记录结果；**UNKNOWN** = 未测/不覆盖；**NO-GO** = 明确禁止。

---

## 1. 本单元交付

| 项 | 实现 | 证据 |
| --- | --- | --- |
| 56/8453 作为一等产品网络元数据 | `PRODUCT_NETWORKS`：同形记录、无 primary/default、`enabled:false`、`support:"read-only"`、`receivable:true`、官方来源 + 日期 | 源码 + `test/phase10-c-registry.test.ts` |
| 只读余额查询 | `ReadOnlyChainReader`：`eth_chainId` 校验、原生 `eth_getBalance`、ERC-20 `decimals()/symbol()/balanceOf()`、未知合约拒绝、无 USD 估值 | 模拟 RPC 测试；真实主网只读 RPC 证据见 §4 |
| 收款网络选择 | `ReceivingNetworkPolicy`：默认空集合、单 BSC/单 Base/双选/清空独立、显式持久化、无自动选链 | 6 个选择/持久化负向测试 |
| 付款请求/事件授信策略 | `paymentRequestVerdict` / `creditVerdict`：未选链拒绝；主网即使已选也拒绝授信；错误码可区分 | 策略测试 + Wallet 负向 |
| 主网硬禁止 | `MAINNET_CHAIN_IDS=[56,8453]` 常量 + `assertNoMainnetSend/Credit/AutoRecharge` + ledger source 检查 + 注册表/钱包多入口 | 多入口负向测试；env 不能绕过 |
| 严格资产四元组 | `chainId + tokenContract + decimals + issuerType` + `evidence` 完整性、on-chain decimals/symbol 复核、mainnet 禁止固定测试汇率 | Base USDC 正例；BSC USDC 明确 unsupported |
| 迁移 | v1 → v2：补只读主网记录/资产与新能力字段；不重写旧 chainId、不改变旧 enabled、不自动启用 | 迁移回归测试 |
| 窄 API 契约 | `plugin/src/mainnet-surface.ts` + 本文 §5，供 C-external/C-wallet 复用，避免各自复制链判定 | 本文件 |

**没有做（后续单元）**：内置钱包、外置扩展选择、直接签名、P2P 付款、自动充值执行、Console UI 改造、真实主网发送/授信、D 审查。主网发货按钮/文案由 A-ui/后续 C 单元接入；本单元只提供核心判定。

---

## 2. 官方来源与链上只读证据

### 2.1 网络元数据（VERIFIED，核对日 2026-10-31 UTC）

| 链 | chainId | RPC | 官方来源 | 证据 |
| --- | --- | --- | --- | --- |
| BNB Smart Chain | 56 | `https://bsc-dataseed.bnbchain.org`、`https://bsc-dataseed-public.bnbchain.org` | BNB Smart Chain Docs — JSON-RPC Endpoint：<https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/> | 文档原文 “BSC Mainnet (ChainID 0x38, 56 in decimal)”；`eth_chainId` 返回 `0x38` |
| Base | 8453 | `https://mainnet.base.org` | Base Docs — Connect to Base：<https://docs.base.org/get-started/connect-to-base> | 文档原文 “RPC endpoint https://mainnet.base.org / Chain ID 8453 / Currency ETH / Block explorer basescan.org”；`eth_chainId` 返回 `0x2105` |

两条链的 `NetworkRecord` 字段完全相同；数组顺序只是展示顺序，没有 primary/preferred/default 字段，也没有“第一条健康链优先”的业务逻辑。

### 2.2 Base native USDC（VERIFIED + REPRODUCED）

- 发行方：Circle；来源：Circle Docs — USDC contract addresses（Mainnet）
  <https://developers.circle.com/stablecoins/usdc-contract-addresses>
- 核对日：2026-10-31。页面 Mainnet 表 Base 行：
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- 链上复核（只读 `eth_call`，`https://mainnet.base.org`）：

```text
eth_chainId                                      -> 0x2105 (8453)
USDC 0x833589...a02913 decimals()                -> 0x...06 (6)
USDC 0x833589...a02913 symbol()                  -> "USDC"
USDC 0x833589...a02913 name()                    -> "USD Coin"
USDC balanceOf(0x000...0001)                     -> 0x000...00147aebf7
ETH  eth_getBalance(0x000...0001)                -> 0x178c92eafafe2875
```

- 记录写入：`assetId=eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`、`decimals=6`、`issuerType="native-issuer"`、`testnetOnly=false`、`credit=false`、`pricing.kind="not-creditable"`、`nanosPerToken="0"`。
- **不是桥接资产**：Base 是 Circle 官方主网 USDC 列表中的链；`issuerType` 明确为 `native-issuer`。
- **生产 reader 真实只读实测（REPRODUCED，2026-10-31T02:03Z）**：用 `ReadOnlyChainReader` + `productRegistry()` 直接查询主网（脚本在 `/tmp`，未提交；无签名/无广播）：

```json
{"label":"bsc-native","chainId":56,"balanceRaw":"35112206951246628897","decimals":18,"creditEligible":false,"usdValue":null,"asset":null,"block":130773684}
{"label":"base-native","chainId":8453,"balanceRaw":"1696892697542797429","decimals":18,"creditEligible":false,"usdValue":null,"asset":null,"block":53311415}
{"label":"base-usdc","chainId":8453,"balanceRaw":"343600119","decimals":6,"creditEligible":false,"usdValue":null,"asset":"USDC","block":53311415}
BSC_USDC_REFUSED asset eip155:56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d is not registered; an unknown contract cannot be read or credited
```

这证明的是**只读能力**（原生币、Base USDC、BSC USDC 拒绝），不是授信或发送。

### 2.3 BSC USDC：**UNSUPPORTED，不猜测**

- Circle 官方 Mainnet USDC 表（2026-10-31 核对）**没有 BNB Smart Chain**。因此不能把 BSC 上的 USDC 标成 `native-issuer`。
- BSC 上常见 USDC 合约 `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` 本次只读观察到：
  - `decimals()` = 18
  - `symbol()` = `"USDC"`
  - 与 Base 的 6 位不同；这是桥接/第三方资产（Binance-Peg 类）的典型差异。
- 但本次**没有**取得发行方（Binance）官方合约地址证据；按仓库合同，未知发行方不能进入美元资产白名单，也不能获得美元信用。因此：
  - 不注册 BSC USDC 资产；
  - `requireReadableAsset("eip155:56:0x8ac76...")` 直接拒绝；
  - UI 应显示“暂不支持/未验证”，不能显示成可用 USDC 收款网络。
- 如果后续要支持，必须先补：官方发行/桥接来源 URL + 日期、`issuerType: "bridged"`、桥接风险说明、独立审查；仍不得开启主网授信。

### 2.4 最终性：不用于主网授信

- BSC：BEP-126 Fast Finality（官方 BEP）：<https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP126.md>；BSC 文档 JSON-RPC 页的 Finality 段也指向 BSC Finality API。本次只读观察 `finalized` 与 `latest` 相差 0–1 个块（同一时刻的连续查询会受出块影响）。
- Base：本次只读观察 `finalized` 落后 `latest` 约 473 个块（2026-10-31T02:00:55Z，约 15.8 分钟，按 2s 块时间）。
- 但本单元**不使用**这些最终性做任何入账：主网 `finality.mode="read-only"`，`finalityVerdict()` 对 read-only 返回 `final=false` 且说明“不主张最终性”。因此不存在“主网读到就算最终”的路径。
- **UNKNOWN**：BSC 的 finalized 标签在不同 RPC/时刻的稳定性未做多源长期测量；本单元不需要它。

### 2.5 只读命令（可复现，脱敏）

```bash
curl -s -X POST https://mainnet.base.org \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0x2105"}

curl -s -X POST https://bsc-dataseed.bnbchain.org \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0x38"}

# Base USDC decimals()：0x313ce567
curl -s -X POST https://mainnet.base.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","data":"0x313ce567"},"latest"]}'
# result 0x...06
```

这些调用全部是只读 `eth_chainId` / `eth_call` / `eth_getBalance` / `eth_getBlockByNumber`；没有 `eth_sendRawTransaction`、没有私钥、没有真实资产移动。

---

## 3. 实现要点与边界

### 3.1 注册表：能力与 `enabled` 分离

`NetworkRecord` 新增（`plugin/src/networks.ts`）：

| 字段 | 含义 | 主网值 | 测试网值 |
| --- | --- | --- | --- |
| `support` | `credit`（可观察/入账）或 `read-only`（展示/查余额/可被选为收款） | `read-only` | `credit` |
| `receivable` | 是否允许用户显式选为收款网络 | `true` | `false`（内部测试） |
| `enabled` | **旧语义不变**：watcher 是否可扫描、ledger 是否可入账 | `false`（永远） | 保持原值 |
| `nativeDecimals` | 原生币精度（BSC/Base 均 18） | 18 | 18 |
| `evidence` | 官方来源/URL/核对日/说明 | 必填 | `null` |
| `finality.mode` | 新增 `read-only`，不主张最终性 | `read-only` | 原值 |

关键方法：

- `requireEnabledNetwork(chainId)`：旧的 watcher/credit 入口；主网永远抛错。
- `requireCreditableNetwork(chainId)`：先检查硬 chainId 集合，再检查 enabled/support。
- `requireReadableNetwork(chainId)`：只允许已注册、有 RPC、且 `support=read-only` 或 `enabled=true`；**不产生任何 credit**。主网/只读网络的 RPC 端点强制 `https`（测试网本地 http 仍允许）。
- `receivableNetworks()` / `readableNetworks()`：无 primary/default。
- `setNetworkEnabled(56|8453, true)`：抛错。

硬 chainId 集合在 `plugin/src/mainnet-gate.ts`，不在注册表文档里；即使有人把 `networks.json` 中 56 的 `networkType` 改成 `testnet`、`support` 改成 `credit`、`enabled` 改成 `true`，注册表构造会拒绝，且 gate 仍按 chainId 拒绝 send/credit/autoRecharge。

### 3.2 严格资产四元组

`AssetRecord`（`plugin/src/networks.ts`）：

```ts
type AssetIssuerType = "mock" | "native-issuer" | "bridged";

interface AssetRecord {
  assetId: string;              // eip155:<chainId>:<contract lowercase>
  chainId: number;
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;             // must match on-chain decimals()
  issuerType: AssetIssuerType;  // mainnet: native-issuer | bridged; testnet: mock
  testnetOnly: boolean;
  credit: boolean;              // true only for the testnet fixed-rate path
  enabled: boolean;
  pricing: {
    nanosPerToken: string;      // "0" for not-creditable
    version: string;
    kind: "fixed-test-rate" | "not-creditable";
    note: string;
  };
  evidence: null | {
    issuer: string;
    source: string;
    url: string;                // https
    checkedAt: string;          // YYYY-MM-DD
    onchainChainId: number;
    onchainContract: string;
    onchainDecimals: number;
    onchainSymbol: string;
    note: string;
  };
}
```

校验规则（构造/写入时强制执行）：

1. `assetId` 必须等于 `eip155:<chainId>:<contract.toLowerCase()>`。
2. 可授信资产（`credit=true`）必须：`testnetOnly=true`、所在链 `testnet + support=credit`、`issuerType="mock"`、`pricing.kind="fixed-test-rate"`、费率正整数、且**不能**带 issuer evidence。
3. 不可授信资产（`credit=false`）必须：`testnetOnly=false`、所在链 `mainnet + support=read-only`、`issuerType!="mock"`、`pricing.kind="not-creditable"`、`nanosPerToken="0"`、且 evidence 完整并与四元组一致（chain/contract/decimals/symbol）。
4. `testnetOnly` 与 `credit` 必须一致；拒绝“测试网资产却可授信但不是 mock”或“主网资产复用固定测试汇率”。
5. `requireEnabledAsset` 仍只服务测试网授信；主网资产只能通过 `requireReadableAsset` 读取，且读取结果 `creditEligible:false`。

### 3.3 收款网络选择

`plugin/src/receiving-networks.ts`，持久化文件默认 `statePath("receiving-networks.json")`：

- 默认每个 provider 的选择是**空集合**；读取不会创建文件，也不会补默认链。
- `setSelected(providerId, chainId, selected)` 只接受 `receivableNetworks()`（当前只有 56/8453）；97/84532 被拒绝为内部测试网络。
- 单 BSC、单 Base、双选、清空互相独立；清空 BSC 不会自动选 Base。
- 文件不可读/形状不对/包含测试网或未注册链 → 抛错（fail closed），不静默变成空集或默认集。
- `paymentRequestVerdict` 的 code：
  - `receiving-network-not-selected`：未选链，拒绝付款请求；
  - `mainnet-credit-forbidden`：主网即使已选，也不签发可授信的付款请求；
  - `not-a-product-network`：测试网走旧测试路径，不属于产品收款选择；
  - `unknown-network`。
- `creditVerdict` 先调用 `assertNoMainnetCredit`：主网事件授信无条件拒绝，选择无法解锁；测试网不在该产品策略内，继续走既有 watcher 路径。
- 链上别人在其他链的转账无法被本插件阻止；本插件只决定“不开发票、不入账”，并在 reason 文案里明确这一点。

### 3.4 只读余额

`plugin/src/readonly-balance.ts`：

- `ReadOnlyBalance` 固定 `readOnly:true`、`creditEligible:false`、`usdValue:null`、`asset.credit:false`。
- 查询前先 `eth_chainId` 与注册表 chainId 比对；不匹配直接拒绝（BSC 节点不能回答 Base）。
- ERC-20：必须已注册；`decimals()` 与 `symbol()` 与记录一致才返回余额；未知合约（含 BSC USDC）直接拒绝。
- 原生币：`eth_getBalance`；不产生 USD 估值。
- 该 reader 只服务 `support="read-only"` 的产品网络（56/8453）；测试网仍走既有测试网钱包/watcher 路径，不会被这个只读 API 当成产品余额。
- 没有 `eth_getLogs`、没有 watcher、没有 ledger、没有签名/发送方法。

### 3.5 硬门禁入口（本单元实际覆盖）

| 入口 | 行为 | 测试 |
| --- | --- | --- |
| `setNetworkEnabled(56/8453,true)` | 抛 `mainnet` | 注册表测试 |
| `requireEnabledNetwork(56/8453)` | 抛 mainnet/read-only | 注册表测试 |
| `requireCreditableNetwork(56/8453)` | 抛 mainnet | 注册表测试 |
| `Wallet.start()` / `startChain(56)` | 不启动；startChain 先 gate | 钱包测试 |
| `Wallet.scanNow(56)` | 抛 mainnet | 钱包测试 |
| `Wallet.setReceivingAddress(56,...)` | 抛 mainnet | 钱包测试 |
| `Wallet.requestIntent(56/8453)` | 未选 → 选择错误；已选 → read-only 拒绝；不创建 intent | 钱包测试 |
| `Ledger.depositIntent(source:"chain:56"/"chain:8453")` | 抛 mainnet，不写行 | ledger 测试 |
| `Provisioner.applyChainDeposit` | 对已记账 source 再做 gate | 源码 + ledger 测试（无法构造主网已记账行） |
| `ReceivingNetworkPolicy.creditVerdict` | 主网先抛 gate，选择无法解锁 | 策略测试 |
| `assertNoMainnetSend/Credit/AutoRecharge` | 直接 gate，供未来路径调用 | 多入口测试 |
| env `OH_MY_AIHUB_ALLOW_MAINNET*` | 不读取、无效 | env 负向测试 |
| 伪造 `networks.json`（改 networkType/support/enabled） | 构造时拒绝 | spoof 测试 |

**autoRecharge**：本单元没有自动充值执行路径；`assertNoMainnetAutoRecharge` 已提供，C8 必须在执行前调用。当前负向测试证明主网请求会被拒绝。

### 3.6 迁移与隔离

- `NETWORK_REGISTRY_VERSION=2`。
- v1 文档（只有 97/84532，资产只有 mock）加载时：
  - 补 56/8453 只读记录和 Base USDC 记录；
  - 旧 chainId 不重写，旧 `enabled` 不改变，旧测试资产 `assetId/chainId/decimals` 保持不变；
  - 新字段填安全默认（测试网 `support=credit`、`receivable=false`；主网 `read-only`）；
  - 不启用任何主网。
- v2 文档视为操作者权威：删除的产品网络不会被自动加回。
- 主网资产 `credit=false`、`testnetOnly=false`，不会进入 `enabledAssets()`、`deposit_intents`、`chain_deposits` 或 Magpie cap；测试信用/审计保持原有测试网路径。
- 事件匹配仍按 `(chainId, tokenContract, recipient, amount, payer)` 严格匹配，跨链不混账（既有 `deposits.ts` 语义未放松）。

---

## 4. 窄 API / 字段契约（给 C-external、C-wallet 及其他 C 单元）

> 目的：浏览器适配、内置钱包不要各自复制 `[56,8453]` 常量、`enabled` 解释或资产白名单。所有链判定必须来自核心层；UI 只消费结果与 reason code。
>
> 推荐唯一 import：`plugin/src/mainnet-surface.ts`。若其他工作树尚未合并本分支，按本文契约适配，合并后改为 import。

### 4.1 只读查询

```ts
import type { ReadOnlyBalance, ReadOnlyBalanceInput } from ".../mainnet-surface.ts";

const balance: ReadOnlyBalance = await wallet.readOnlyBalance({
  chainId: 56 | 8453,
  address: "0x...",          // 20-byte, non-zero
  assetId?: string | null,   // 省略 = 原生币
});
```

`ReadOnlyBalance` 关键字段：

```ts
{
  schema: "ohmyaihub.readonly-balance/v1";
  chainId: number;
  displayName: string;
  networkType: string;
  blockExplorer: string;
  address: string;
  asset: null | {
    assetId: string;
    contractAddress: string;
    symbol: string;
    name: string;
    decimals: number;
    issuerType: "native-issuer" | "bridged" | "mock";
    credit: false;
  };
  nativeSymbol: string;
  balanceRaw: string;        // bigint decimal string
  decimals: number;
  balanceTokens: string;     // exact decimal formatting
  blockNumber: number;
  readOnly: true;
  creditEligible: false;     // NEVER true for a mainnet in this build
  usdValue: null;            // no rate is defined; do not compute one in UI
  note: string;
  observedAt: string;
}
```

UI 约束：
- 不得把 `creditEligible:false` 的余额展示为“可消费余额”或加入信用汇总；
- `usdValue:null` 时显示“未估值/只读”，不要用 0 或 mock 汇率填充；
- 不显示“发送/充值到账”动作；
- 错误直接展示，不自动切换链、不自动重试到另一条链。

### 4.2 收款网络选择

```ts
wallet.productNetworks(): NetworkRecord[];              // 当前 [56, 8453]，无 primary
wallet.receivingSelection(providerId): {
  providerId: string;
  chainIds: number[];        // 默认 []
  updatedAt: string | null;
};
wallet.setReceivingNetwork(providerId, chainId, selected): ReceivingSelection;
wallet.paymentRequestVerdict(providerId, chainId): PaymentRequestVerdict;
```

`PaymentRequestVerdict`：

```ts
type PaymentRequestCode =
  | "allowed"
  | "unknown-network"
  | "not-a-product-network"
  | "receiving-network-not-selected"
  | "mainnet-credit-forbidden";
{ allowed: boolean; code: PaymentRequestCode; reason: string }
```

使用规则：
- 默认空集合；必须由用户显式打开 BSC/Base 之一或两者；
- 单选/双选独立，清除一个不影响另一个；
- 未选链 → 拒绝付款请求（`receiving-network-not-selected`）；
- 主网即使已选 → 拒绝可授信付款请求（`mainnet-credit-forbidden`），文案说明“只读/不能授信”，不能写成“已开通”；
- 不要在前端自行判断 chainId 是否为 56/8453；调用核心方法。

### 4.3 主网硬门禁

```ts
import {
  assertNoMainnetSend,
  assertNoMainnetCredit,
  assertNoMainnetAutoRecharge,
  assertCreditSourceNotMainnet,
  isMainnetChainId,
  mainnetCapabilities,
  MAINNET_CHAIN_IDS,
  MainnetGateError,
} from ".../mainnet-surface.ts";

assertNoMainnetSend({ chainId, operation: "browser send" });
assertNoMainnetCredit({ chainId, operation: "event credit" });
assertNoMainnetAutoRecharge({ chainId, operation: "policy execution" });
assertCreditSourceNotMainnet("chain:56");
```

- 主网调用抛 `MainnetGateError`，code 为 `mainnet-send-forbidden` / `mainnet-credit-forbidden` / `mainnet-auto-recharge-forbidden`；这是**不可重试**的拒绝，UI 不要吞掉或转成“稍后再试”。
- 只有 `read-metadata`、`read-balance`、`select-receiving` 对主网可用；`send/credit/auto-recharge` 永远 false。
- 不要新增“UI 已确认所以放行”“env/config 覆盖”分支；核心 gate 不接受这些输入。

### 4.4 注册表字段（只读消费）

```ts
NetworkRecord {
  chainId, displayName, family, networkType,
  support: "credit" | "read-only",  // 能力
  receivable: boolean,              // 可被选为收款网络
  enabled: boolean,                 // 仅表示 watcher/credit 开关；主网永远 false
  rpcEndpoints, blockExplorer, nativeSymbol, nativeDecimals,
  finality: { mode: "finalized-tag" | "confirmations" | "read-only", ... },
  notes,
  evidence: null | { source, url, checkedAt, note }
}
```

**语义铁律**：
- `enabled` 不是“UI 可见”；`support` 不是“已启用”；`receivable` 不是“已选”。
- 主网 `enabled` 永远 false；不要用“打开 enabled”实现主网展示。
- 97/84532 仍是 `support=credit`、`receivable=false`，避免 UI 把内部测试网当产品收款网络。
- 没有 primary/default；不要按数组第一条自动选。

### 4.5 资产四元组（只读消费）

参见 §3.2。给 UI/钱包的最小校验：

```ts
// 不要用 symbol 判断资产；只接受注册表返回的 assetId。
const asset = registry.requireReadableAsset(assetId);
// asset: { chainId, contractAddress, decimals, issuerType, credit:false, evidence }
```

- Base USDC：`eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`，6 位，`native-issuer`，只读。
- BSC USDC：**无记录**；UI 应显示 unsupported/未验证，不要用 18 位合约自行拼一个“USDC”。
- 任何未知合约 → `requireReadableAsset` 抛错；不要降级成“按 symbol 显示”。

### 4.6 状态投影字段

`Wallet.statusLocal().registry` 已包含：

- network: `chainId, displayName, networkType, support, receivable, enabled, blockExplorer, finality, endpoints`
- asset: `assetId, chainId, symbol, name, decimals, contractAddress, enabled, credit, testnetOnly, issuerType, pricingKind, nanosPerToken, priceVersion`

UI 应使用 `support/receivable/enabled/credit` 而不是自己推断；`priceVersion` 以 `not-creditable:` 开头表示不可估值。页面快照（`page-snapshot.ts`）也投影 `support/receivable` 与 `credit/testnetOnly/issuerType`，旧页面忽略新字段，后续 UI 直接消费这些字段即可。

### 4.7 C-external 现有 snapshot 字段的差异

C-external 计划消费：

```ts
networks: [{ chainId, displayName, family?, networkType, enabled, nativeSymbol, nativeDecimals? }]
assets:   [{ assetId, chainId, contractAddress, symbol, decimals, issuerType, testnetOnly, enabled }]
```

这些字段**不足以**安全决定发送。必须补充/改变：

| 现有/计划 | 必须补充或修正 | 原因 |
| --- | --- | --- |
| `enabled` | 增加 `support`、`receivable` | `enabled` 只是 watcher/credit 开关；主网永远 false，不能用它判断展示或可收款 |
| `networkType` | 不能单独判主网；增加硬 chainId 检查 | 56/8453 即使被伪造成 testnet 也必须拒绝发送 |
| `testnetOnly` | 增加 `credit`、`pricingKind`（状态投影） | v1 资产可能缺字段；发送必须是 `credit && pricingKind==="fixed-test-rate"` |
| `issuerType` | 发送要求 `mock`，主网只允许 `native-issuer`/`bridged` | 主网 mock/未知发行方不能进入授信 |
| `allowMainnetRead` | 只影响展示；send/credit/auto-recharge 永远拒绝 | 可读 ≠ 可授信 |
| `assetId` | 必须与 `chainId`/`contractAddress` 一致，decimals 用 registry 值 | 不用 symbol 推断资产 |

发送/签名前置条件（C-external 必须全部满足）：`networkType==="testnet"`、`enabled===true`、`support==="credit"`、`asset.testnetOnly===true`、`asset.credit===true`、`asset.pricingKind==="fixed-test-rate"`、`asset.issuerType==="mock"`、`asset.chainId===network.chainId`。主网 send/sign 由 `assertNoMainnetSend` 拒绝，不看 env/config/`allowMainnetRead`。

---

## 5. 测试与结果

### 5.1 本次实际运行（REPRODUCED）

```bash
cd plugin
bun install --frozen-lockfile          # 本工作树依赖安装；lock 未改
bun run typecheck                      # PASS (tsc --noEmit)
bun run secret-scan                    # PASS: no credentials in the working tree
bun test --preload /tmp/phase10-prep/guard.ts \
  ./test/networks.test.ts ./test/phase10-c-registry.test.ts
# 69 pass / 0 fail（351 expect）

bun test --preload /tmp/phase10-prep/guard.ts \
  ./test/networks.test.ts ./test/phase10-c-registry.test.ts \
  ./test/wallet-surface.test.ts ./test/deposits.test.ts ./test/ledger.test.ts
# 310 pass / 0 fail（1673 expect，17 files，旧简化 guard）
```

覆盖：

| 场景 | 用例 |
| --- | --- |
| 单选 BSC | `setSelected(p,56,true)` → `[56]`，Base 仍空 |
| 单选 Base | `setSelected(p,8453,true)` → `[8453]`，BSC 不受影响 |
| 双选 | `[56,8453]` |
| 空选 | 新 provider `[]`，读取不创建文件 |
| 错误 chain | 97/84532 选为收款 → 拒绝；未注册链 → 拒绝；RPC 返回其他 chainId → 拒绝 |
| 错 token | BSC USDC/未知合约 → 拒绝；跨链资产 id → 拒绝 |
| decimals | 链上 18 vs 记录 6 → 拒绝；evidence 不一致 → 拒绝 |
| issuer | 主网 mock issuer → 拒绝；测试网非 mock 可授信资产 → 拒绝 |
| 硬门禁多入口 | registry enabled/requireEnabled/requireCreditable、Wallet start/scan/receiving/intent、Ledger source、env、伪造 networkType/support |
| 只读能力 | 56/8453 原生+Base USDC 余额；`creditEligible:false`、`usdValue:null`；无 `eth_getLogs`/发送 |
| 迁移 | v1 → v2 保留旧 chainId/enabled/asset；补主网只读记录；v2 文档权威性 |
| 测试网回归 | 既有 `networks.test.ts` 24 用例仍通过；`wallet-surface`/`deposits`/`ledger`/`watcher`/`chain-credit` 目标测试通过 |

### 5.2 更大范围目标测试（REPRODUCED，含已知基线失败）

```bash
bun test --preload /tmp/phase10-prep/guard.ts \
  ./test/wallet-view.test.ts ./test/wallet-reliability.test.ts \
  ./test/wallet-journey.test.ts ./test/console-wallet.test.ts \
  ./test/chain-credit.test.ts ./test/watcher.test.ts
# 101 tests / 98 pass / 3 fail
```

3 个失败均为**已知测试时钟缺陷**（PR #15，commit `889973f55ca3a72da99ae0091e50ecd5ea428207`，待独立审查，未 cherry-pick）：

- `browser wallet workflows > preview/create/document/signature/import ...` → “请求已过期或到期时间不一致”
- `browser wallet workflows > pending older than 50-row preview ...` → 过期导致 0 行
- `browser wallet workflows > production watcher credit ...` → “请求已失效或无法再次签名”

基线 `VALIDATION-PREP.md` 记录全量 740 pass / 5 fail；原始 head `5ef4430` 的 CI（run `41158999333`）两个平台均恰好 5 fail，全部是同一已知时钟缺陷（wallet wizard 1 + numeric admission 1 + browser wallet workflows 3），无本单元新增失败。显式 stack 到 PR15 `889973f` 后，CI run `41159282548`（head `9fd8be7`）双平台 **pass**；本地同一 guard 下 261 pass / 0 fail（15 文件）。早期 run 另有 4 个 fixture 资产字段失败，已用 `0c94c08` 修正（fixture 显式 `credit:true`/`fixed-test-rate`），不再出现。

全量本地测试仍可能受本机端口占用/生产网关影响（本次本地全量看到 `EADDRINUSE 13650/31589` 与既有 guard 拦截，不是本分支回归）；全量前按协调方要求使用已审查的 guard preload，避免 `phase8-prompt-journey.test.ts` 读取本机 LAN:3425 生产 Magpie、`service.test.ts` 访问公共测试网 RPC。

### 5.3 未运行 / UNKNOWN

- 未跑全量 `bun run test`（网络隔离另建 PR；本次只用 guard 跑目标文件）。
- 未跑真实浏览器/ego-lite UI 验收（本单元不做 UI）。
- 未做真实 Magpie 0.1.2289 宿主集成（本单元不启动宿主）。
- 未做真实主网交易/签名/广播；只做只读 RPC。
- 未验证 BSC USDC 的官方发行方；故保持 unsupported。
- 未验证多 RPC 提供商对 BSC `finalized` 的长期一致性；本单元不需要。

---

## 6. Mainnet Network Support 尚需什么

本单元完成的是“核心只读 + 选择 + 硬门禁”，不是“用户可在 UI 使用主网收款”。仍缺：

1. **UI 接线（A-ui/后续 C）**：钱包页展示 BSC/Base 只读网络、默认空选、显式单选/双选、`paymentRequestVerdict` reason code 文案；不得出现发送/充值/自动充值按钮。
2. **真实只读读取验收**：用实际 UI/钱包读取 56/8453 原生与 Base USDC 余额，确认 `creditEligible:false`/`usdValue:null` 文案；本单元只用模拟 RPC 单测 + curl 只读证据。
3. **真实 Magpie 宿主集成**：0.1.2289 隔离副本下的 UI/状态投影；本单元未启动。
4. **C-external/C-wallet 适配**：扩展选择、直接签名、付款请求 UI 必须遵守 §4 契约；不得复制链判定；仍禁止主网 send/credit/autoRecharge。
5. **BSC USDC 资产证据**：若产品要支持，需官方发行/桥接来源、`issuerType:"bridged"`、桥接风险文案、D 审查；在补齐前保持 unsupported。
6. **价格/估值**：主网没有美元估值；任何“余额≈USD”展示都需要独立价格来源和审查。本单元明确 `usdValue:null`。
7. **D 独立审查**：密钥/导出/扩展/归属/策略/主网只读；本单元不替代 D。

---

## 7. 真实资金 NO-GO

- 主网 **send**：无实现；`assertNoMainnetSend` 硬拒绝。
- 主网 **credit / 抬 cap / 入账**：无实现；registry/ledger/provisioner/策略多入口拒绝；`chain:56`/`chain:8453` ledger source 被拒。
- 主网 **autoRecharge**：无执行路径；gate 已提供，C8 必须调用。
- 未使用任何真实资产、热钱包、私钥、助记词；未连接真实钱包扩展；未发送交易。
- 未声称“主网可用”“USDC 已支持”“自动充值可用”“已完成真实资金验收”。
- 真实资金仍为 **NO-GO**，需用户明确授权 + D 独立审查 + 价格锁定/峰谷价等前置；本单元不放行。

---

## 9. 独立审查 fixes（2026-10-31）

审查对象为 `917c429`；以下修复针对其 F1–F6，当前 code head `ee62255`（CI run `41160995832` 双平台 pass），随后 docs commit 只改本文，不改代码。真实资金仍 NO-GO；F7/F8（send/sign/autoRecharge 无生产调用点、无主网事件路径）保持 UNKNOWN，不宣称端到端。

| 审查项 | 修复 |
| --- | --- |
| F1 任意真实主网可伪装 testnet | `CREDIT_CHAIN_ALLOWLIST=[97,84532]`；`enabled+credit` 必须在该 allowlist。chain 1/未知链伪装 testnet/credit/enabled 构造即拒绝；`loadRegistry` v2 文件同样拒绝。本地 fork 只能 `simulationRegistry(..., [1337/31337/31338])`，不能靠改 `networkType` 进入生产。 |
| F2 FundsClass / reconcile | `LedgerDeposit` 增加 `fundsClass/chainId/assetId`；`depositIntent` 接受并校验 provenance。pending 在 Magpie 写前持久化 `fundsClass/chainId/assetId/source`；`reconcile` 缺 ledger 行时只恢复同一来源，chain pending 缺失/冲突则 fail-closed 人工恢复，绝不重记 `simulated`。`topUp` 拒绝 `chain*`/`opening*` id 且不能复用 chain ledger 行；`applyChainDeposit` 拒绝非 chain 行，`setCap` 校验 pending provenance。历史行不重写 source/chainId/amount。 |
| F3 文件绕过 https | `NetworkRegistry.validate()` 校验所有 loaded endpoint：协议、主网/只读 https、无 credentials、无 fragment；v2 `http://` 主网文件加载即拒绝。 |
| F4 redirect/响应上限 | `EvmClient` 请求 `redirect:"error"`；响应体默认上限 8 MiB（流式计数，chunked 也拒绝）；超时沿用 `AbortSignal.timeout`。 |
| F5 failover 未验链 | 每个实际 endpoint 首次使用前独立 `eth_chainId` 验证；A 验证后失败切 B，B 必须先验链，不能把 B 的余额当 A。测试证明 B 的 `eth_getBalance` 零调用。 |
| F6 source 变体 | mainnet gate 归一化 trim/lower/空白；`Chain:56`、` chain : 56 `、`CHAIN:8453` 拒绝；ledger 对 `evm:56`、`chain:0x38` 等未分类 source 直接拒绝。 |

新增/更新测试：chain 1/unknown chain、v2 chain1 文件、`Load v2 http`、307、超长响应、错链 failover、pending chain 缺行、pending class 冲突、manual 同源恢复、topUp chain/opening id、applyChainDeposit 非 chain 行。测试使用受控 mockRPC；没有重跑公网 RPC，旧 raw log 仍是原只读证据。

当前本地目标集：`310 pass / 0 fail / 1673 expect / 17 files`，使用旧简化 guard（仅阻断 `:3425`/non-loopback）；这不等于 PR17 精确 origin 登记 guard，不能用它宣称全量 hermetic。CI 是提交者 CI，不是独立审查通过。

## 8. 变更文件

- `plugin/src/mainnet-gate.ts`（新）：硬 chainId 能力矩阵与 gate。
- `plugin/src/networks.ts`：v2 注册表、只读主网记录、Base USDC、严格四元组/证据、迁移。
- `plugin/src/receiving-networks.ts`（新）：默认空选、独立选择、付款/授信策略。
- `plugin/src/readonly-balance.ts`（新）：只读原生/ERC-20 余额。
- `plugin/src/mainnet-surface.ts`（新）：给其他 C 单元的窄 API。
- `plugin/src/wallet.ts`：选择/只读 API、Intent/scan/receiving gate、状态字段。
- `plugin/src/ledger.ts`、`provisioner.ts`：主网 ledger source 防御。
- `plugin/src/watcher.ts`：read-only finality 分支、非可授信资产拒绝换算。
- `plugin/src/deposits.ts`、`wallet-workflows.ts`：只允许可授信测试资产。
- `plugin/test/phase10-c-registry.test.ts`（新）、`test/networks.test.ts`、`wallet-view.test.ts`、`watcher.test.ts`、`wallet-reliability.test.ts`：测试/字段适配。
- `plugin/bin/wallet-wizard.ts`、`plugin/scripts/chain-lab.ts`：构造完整记录字段（行为不变）。

PR：draft，未合并。审查重点：§3.5 多入口、§3.6 迁移、§4 契约、§5.2 已知时钟失败是否与本改动无关。
