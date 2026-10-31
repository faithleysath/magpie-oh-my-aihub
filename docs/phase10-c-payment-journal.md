# Phase 10 C — 付款操作 journal（durable payment-operation journal）

- 分支：`feature/phase10-c-payment-journal`
- worktree：`/Users/laysath/.paseo/worktrees/1z728cdk/c-payment-journal`
- base：已批准 P0-17 `49e8c0ff64c8fcaf28da472e664bee482fd5e843`（含 P0-15；`origin/main` = `8ce5c57f565fb1b835021a9b730b61014eb47d5f`）
- 代码提交：`42589a1ec8b8f940b769a1e410060bf4c08f24e6`
- 依赖的已批准外置模块：PR #30 head `90c32f8cfd1b98e6705c31ca6e91cfef606dc894`（单独隔离模块；本分支不把它的 JS import 进生产代码）
- 本模块：`plugin/src/payment-operations.ts`；测试：`plugin/test/payment-operations.test.ts`、`plugin/test/support/payment-operation-race-child.ts`
- 结论：**核心可审、可测试；未接 Service/UI，未发送真实交易，未接账本授信，主网仍 NO-GO。** 本文不把任何模拟结果写成产品 GO。

> 状态口径
>
> - **VERIFIED**：在本机按文中命令实际执行，有可复查输出。
> - **REPRODUCED**：用真实 SQLite/真实批准代码复现了指定场景；合成 provider、无真实链、无真实资金。
> - **UNKNOWN**：未在本轮验证，不能用推测补齐。
>
> 真实 Magpie 0.1.2289 + EasyTier 2.6.4、真实 MetaMask/Rabby、真实测试网交易、主网、真实资金：本单元**都没有**执行。本机目标版本是隔离副本；本模块不读写用户安装或数据。

## 1. 范围与明确不做

本单元只做**付款执行状态的持久化的本地核心**：在钱包真正发送前，给一次已核验的测试网付款建立单赢家 claim；在发送前持久化 `broadcasting`；之后只接受哈希或 unknown 证据；跨 session/刷新/第二 tab/进程重启都不能把同一业务意图重新变成可发送。

已实现：

- 原子 `reserve`：同一 `invoice + 已认证 consumer 地址` 只有一个赢家；
- `markBroadcasting`：`reserved → broadcasting` 的 CAS，绑定 `reservationId`、精确 operation payload 和当前钱包 session；
- `recordHash` / `recordUnknown`：CAS、幂等、哈希冲突拒绝、unknown 不覆盖已知哈希；
- 显式、带证据的 release：只用于“确定没有广播”的 reserved 或钱包明确拒绝的 unknown；
- `query` / `lookup` / `pending`：Service/UI 恢复读取；
- 测试网硬 allowlist、注入式资产注册表、注入式身份/授权代检查；
- SQLite 事务、WAL、`synchronous=FULL`、0600/0700、审计事件；
- 真实多进程 SQLite 并发测试。

明确不做（本轮）：

- **不接 Service、不接 UI、不接 CLI**；没有把 `operationPort` 注入任何现有 Service 发送流程；
- **不发送交易**、不签名、不碰 nonce、不持有密钥、不创建钱包；
- **不做自动充值执行器**、不做策略、不做上限/暂停；
- **不写 Ledger、不申请/修改 Magpie cap、不把 receipt 当 credited**；
- 不实现 Watcher 的 from/to/input/log 回执核验；本模块只保存付款执行状态；
- 不接真实扩展/真实测试网/主网；不做真实资金；
- 不新增 DHT/mDNS/路由/中心 API/HTTP server/proxy；
- 不把未审的 C-registry/C-wallet/C-external 代码 import 进生产模块。资产检查只通过窄注入接口；生产适配器用仓库已有的 `NetworkRegistry`。

## 2. 与 C-external approved 模块的契约

批准的 external-wallet 模块（`plugin/console/external-wallet.js`，PR #30 head `90c32f8`）在发送时需要注入：

```js
operationPort = {
  reserve(operation) -> { reservationId, state, hash? },
  markBroadcasting({ reservationId, operation }) -> void,
  recordHash({ reservationId, operation, hash }) -> void,
  recordUnknown({ reservationId, operation, reason }) -> void,
  query(operation) -> { state, hash? } | null,
}
```

`operation` 是模块自己生成的精确对象，**不含 previewId**：

```js
{
  schema: "ohmyaihub.external-wallet.operation/v1",
  intentHash: string | null,
  account, chainId, assetId, contractAddress,
  recipientAddress, amountRaw, calldata, calldataHash
}
```

模块的调用顺序是 `reserve → markBroadcasting → eth_sendTransaction → recordHash`；任何 send 错误/无效哈希 → `recordUnknown`。本模块严格实现这五个方法，并额外提供 Service 专用的 release/查询方法（不暴露给钱包模块）。

来源证据：

- `90c32f8` 的 `plugin/console/external-wallet.js` blob SHA：`639556977acf98e66098437734ac901743f608f3`；工作树文件 SHA-256：`55e65ab63ef2924ad5f9b198902187f0657524f96c0a46b6679929a338a8f4a2`。
- 冻结接口 `d533e6f` 与最新 fix 的 operationPort 方法名/参数一致（差异只在 chain/icon/docs，不在 port 语义）。
- 模块要求自己默认发送关闭；本模块不改变它的默认，也不把“注入 port”当作已接线。

## 3. 状态机

持久化状态只有五种：

| 状态 | 含义 | 还能发送？ |
| --- | --- | --- |
| `reserved` | 本次 claim 赢家，尚未通过发送门 | 只有该 claim 的 `markBroadcasting` 可以进入下一态 |
| `broadcasting` | 发送门已提交；钱包可能已被调用 | **不能**；重启/刷新/新 session 都拒绝 |
| `broadcast` | 已记录交易哈希；只是广播证据 | **不能**；后续只读/回执核验 |
| `unknown` | 结果未知（超时、RPC/500、无效哈希、钱包拒绝等） | **不能**；只有带证据的 release 才可重新 claim |
| `released` | 已由 Service 明确证明“没有广播”后释放 | 下一条 `reserve` 可重新 claim，attempt+1 |

关键转移：

```text
(no row) --reserve--> reserved
reserved --markBroadcasting(reservationId, exact payload)--> broadcasting
broadcasting --recordHash(hash)--> broadcast
broadcasting --recordUnknown(reason)--> unknown
unknown --recordHash(hash)--> broadcast          # 后来找到哈希是证据，不是重发
unknown --releaseRejectedUnknown(evidence)--> released   # 仅 4001 类
reserved --releaseUnsentReservation(evidence)--> released # 仅确定未广播
released --reserve(new explicit try)--> reserved (attempt+1)
```

`reserve` 的原子性：先做乐观读取；真正 claim 时在 `BEGIN IMMEDIATE` 事务里再次读取/插入/更新。已存在且非 `released` 时：

- payload 不一致 → `PAYMENT_OPERATION_PAYLOAD_MISMATCH`（不新建行、不发送）；
- `reserved` → 返回 `state:"claimed"`（external 模块会拒绝）；
- `broadcasting` / `broadcast` / `unknown` → 返回该终态（external 模块会拒绝）；
- 只有 `released` 才允许新 claim。

`markBroadcasting` 的 SQL 形状：

```sql
UPDATE payment_operations
   SET state = 'broadcasting', updated_at_ms = ?
 WHERE idem_key = ? AND state = 'reserved'
   AND reservation_id = ? AND payload_hash = ?
```

`changes !== 1` 即失败；函数只在事务 `COMMIT` 之后返回。连接设置 `journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=5000`，因此返回时 WAL 已按 FULL 同步。外部模块在 `markBroadcasting` 抛错时不会调用 `eth_sendTransaction`。

`reservationId` 另外绑定到发起 claim 的 `BoundPaymentOperationPort` 实例：即使另一个 tab 拿到了旧的 id，也不能用它的 port 过发送门。数据库 CAS 仍然会再校验一次 reservation id 和 payload。

## 4. 幂等键与 payload

稳定键（不是 preview UUID、不是每次新生成的 intentHash）：

```text
idemKey = sha256("..../idem/v1\n" + canonical({
  invoice,
  consumerAddress          // 本地认证的 consumer 钱包公开地址，小写
}))
```

payload 指纹：

```text
payloadHash = sha256("..../payload/v1\n" + canonical({
  intentHash, account, chainId, assetId, contractAddress, decimals,
  recipientAddress, amountRaw, calldataHash,
  providerIdentityFingerprint, authorizationGeneration
}))
```

设计要点：

- **换 UUID / 新 preview / 新 tab / 新 session 仍是同一操作**：它们不影响 idemKey。
- **intentHash 不参与 idemKey**：避免每次 preview 造一个新 hash 绕过唯一约束。`intentHash` 仍进入 payload 指纹；如果第二次调用与第一次不同（包括从 `null` 变成某个 hash），会被 `PAYLOAD_MISMATCH` 拒绝。这是“安全误挡”，优于把新哈希当成新付款。
- **报价/收款人/金额/资产/链/合约/精度/identity/generation 变化**：同一 invoice 下 payload 不再相等 → 拒绝，不生成第二行。报价变化必须先走释放/重新核验流程。
- `different invoice` 是不同 obligation；本模块不会把它们合并。Service 必须保证一个真实付款义务只对应一个已核验 invoice；这是 Service 的责任边界，不是 journal 的账务判断。
- 固定 ERC-20 `transfer(address,uint256)` calldata 由本模块重新编码并与 `calldataHash`、recipient、amount 交叉校验；不接受任意 calldata/selector。

## 5. 发送门、崩溃点与“永不重发”

| 崩溃/失败点 | 持久化结果 | 之后 |
| --- | --- | --- |
| `reserve` 前 | 无行 | 可重新明确确认 |
| `reserve` 后、`markBroadcasting` 前 | `reserved` | 不会自动变成可发送；Service 必须确认该 claim 未广播，再用 `releaseUnsentReservation` 释放 |
| `markBroadcasting` 事务中失败 | 仍 `reserved` | external 不发送；同上 |
| `markBroadcasting` COMMIT 后、钱包调用前 | `broadcasting` | **不重发**；作为未知/已开始处理，按哈希或节点侧恢复 |
| 钱包调用后、`recordHash` 前 | `broadcasting` | **不重发**；可以补录哈希（`unknown` 也允许补录为 `broadcast`） |
| `recordHash` 写失败 | journal 仍 `broadcasting`；external 报 `OPERATION_JOURNAL_FAILED` 且带真实 hash | **不重发** |
| `recordUnknown` 写失败 | journal 仍 `broadcasting`；external 进入 unknown | **不重发** |

即：**发送许可只在 `markBroadcasting` 成功返回后存在**；任何异常路径都不会释放 nonce 或再发。`recordHash` 只在 `broadcasting/unknown` 上 CAS，已存在的不同哈希一律 `PAYMENT_OPERATION_HASH_CONFLICT`；`recordUnknown` 不会把已有哈希降级。

## 6. unknown / 4001 的释放语义

- `4001` / `ACTION_REJECTED` / `USER_REJECTED`：external 模块同样走 `recordUnknown`，journal 先记为 `unknown`；**不是自动释放**。
- 只有 Service（不是浏览器、不是 external 模块）能调用 `releaseRejectedUnknown`，且必须同时满足：
  - 当前状态 `unknown`、`tx_hash IS NULL`、reservation id 精确匹配；
  - 记录的 reason 属于钱包拒绝类；
  - evidence 里 `confirmedNoBroadcast === true`、`userConfirmedRetry === true`；
  - 提供 `noBroadcastObservation`：`method` 只接受 `chain-nonce | provider-response | node-mempool | wallet-pending-set`，带有限时区的 `observedAt` 和 opaque reference（reference 只存 SHA-256，不存原文）。
- 超时、RPC/500、无效哈希、`WALLET_ERROR` 等一律**不能**走这个 release；测试逐项覆盖。
- `releaseUnsentReservation` 只接受 `reserved`，必须精确 reservation id；`owner-restarted-before-broadcast` 还要求 previous owner 与当前 owner 不同。`service-recovered-unsent` 是 Service 已确认未广播的显式判断，仍需 `confirmedNoBroadcast: true`。
- 没有定时器、没有“N 分钟后自动释放”、没有浏览器 release API。释放后重新 claim 仍需要用户重新明确确认（external 的 `userInitiated` + `acknowledged`）。

**边界（必须如实说明）**：journal 无法自己证明“链上/节点侧没有这笔交易”。`confirmedNoBroadcast` 是 Service 的显式断言；`noBroadcastObservation` 只是把 Service 用的方法和引用留痕。真实接入时，Service 必须用自己可信的链/节点/钱包证据填充它，不能把 UI 的“我没看到”当作证据。

## 7. 链、资产与身份的门

- 生产硬 allowlist：`97`（BSC testnet）、`84532`（Base Sepolia）。与 registry/UI/env 的 `networkType` 无关。
- `56` / `8453` 在任何写入前直接 `PAYMENT_OPERATION_MAINNET_BLOCKED`；`operationPort` 构造时也先检查，不能靠后来“manual confirm”绕过。
- `31337` 只有显式构造 `isolatedTestChains: [31337]` 才可用；该选项只接受 31337；其它值直接拒绝。普通 UI/env/registry 不能打开它。
- 资产检查通过窄接口 `PaymentAssetRegistry.resolveSendableAsset`；生产适配器 `networkRegistryAssetResolver(registry)`：
  - chain 必须 enabled 且 `networkType === "testnet"`；
  - `requireEnabledAsset(chainId, contract)` 成功；
  - asset id、chain、contract、decimals 必须与 binding 完全一致；
  - **不接受任何调用方传入的 `trusted: true` 布尔**。
- 身份/授权通过 `PaymentIdentityAuthority.assertCurrent`：consumer 地址、provider identity fingerprint、authorization generation、invoice、payloadHash 等必须仍被本地 Service 接受；claim 前和发送门前各调用一次。撤销 invoice、换 provider 身份、换授权代、旧 generation 都会在发送前失败。
- 本地的链检查是硬编码集合；registry 只能收紧（asset/network enabled/testnet），不能扩大链集合。

## 8. 存储与敏感信息

表：

- `payment_operations`：一行一个 `idem_key`；保存 invoice、consumer/provider 公开标识、generation、intent hash、chain/asset 四元组、recipient、amountRaw、decimals、calldataHash、state、reservationId、owner instance、txHash、reason、attempt、时间戳。
- `payment_operation_events`：状态转移审计；detail 只放状态/哈希/方法/referenceHash，长度上限 512。

安全：

- 文件 0600、目录 0700；`PRAGMA journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`；`PRAGMA user_version=1`。
- **不存** seed、私钥、签名、raw tx、calldata 本体；输入的额外字段直接拒绝（防夹带 `signature` 等）。
- reason 会脱敏/截断为 `[A-Za-z0-9._:-]{1,64}`；release evidence 的 reference 只存 SHA-256。
- 本模块没有日志输出；不写 console/snapshot。
- 接收方只看 `txHash` 和公开付款元数据；`credited` 不在本模块存在。**receipt 也只是证据**；未来由现有 Watcher 核验 from/to/input/log，仍由现有 Ledger/Provisioner 决定是否授信。本 journal 不写 Ledger、不写 cap、不凭远端 credit。

## 9. Service / UI 集成设计（本轮未接）

已经可以给后续接线使用的窄 API：

```ts
const journal = openPaymentOperationJournal({
  path,                       // 默认 statePath("payment-operations.sqlite")
  ownerInstanceId,            // 每次本地 Service 生命周期一个；不是网络授权
  assetRegistry,              // 生产用 networkRegistryAssetResolver(networkRegistry)
  identityAuthority,          // Service 自己的已认证 consumer + accepted provider + generation
  now,
  // isolatedTestChains: [31337]  // 仅测试构造
});
const port = journal.operationPort(bindingFromVerifiedIntent);
const session = createExternalWallet({ ..., operationPort: port });
```

- `bindingFromVerifiedIntent` 必须由 Service 从**本地已核验 intent** 生成；远端/P2P 输入不能改 recipient/amount/asset/price。`intentHash` 传本地 intent 的值；没有就传 `null`，不要让 UI 每次 preview 造新 hash。
- `ownerInstanceId` 应在持有 host lock / 本地认证服务 owner 启动后生成；关闭 Service 时 `journal.close()`。`owner-restarted-before-broadcast` 只用它做“上一个进程已结束”的证据。
- `query` 的现状：approved external 模块**目前从不调用** `query`（源码 VERIFIED）。所以恢复路径实际由 Service 的 status projection 使用：`journal.lookup({invoice, consumerAddress})`、`journal.pending()`、以及同一个 port 的 `query(operation)`；读回 `unknown` 时显示已知 `txHash`/“按哈希核对链上”，**不提供重发按钮**。`query` 是只读的，不会产生新的 send permit。
- release 方法只在 journal 上，不在 port 上；不要把它们暴露成 HTTP 路由或浏览器 API。将来若经 localhost 控制台暴露，必须由已认证的 Service 加 CSRF + 精确 UUID/action allowlist，并保持 release 只能由本机 Service 在证据齐全时调用。本模块不创建 HTTP server，也不做 proxy。
- 构造函数里的 owner/capability 不是网络授权；它只标识本地 Service 生命周期。**未接线 = 不声称 UI/Service 可用。**

后续小 commit（不在本 PR）：Service 注入 port、Service status projection 调 `query/lookup/pending`、UI 的“未知/按哈希核对”视图、真实链/扩展验证。每一步仍需单独审查。

## 10. 测试与证据

### 10.1 本模块测试（VERIFIED）

平台：macOS arm64（本机），Bun `1.4.3`，SQLite `3.50.6`。

```bash
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun test ./test/payment-operations.test.ts
```

结果（本次代码 `42589a1`）：

```text
37 pass
0 fail
243 expect() calls
Ran 37 tests across 1 file. [~1.6s]
```

覆盖：

- 硬 allowlist：97/84532；56/8453 在任何写入前拒绝；未知链拒绝；31337 只有显式 isolated 构造且 registry 也有该链时才可用；其它链不能借 isolated 选项混入。
- 单赢家：同一 journal 两个 port、同一文件两个 journal 实例、reopen/new session、第二 tab；`previewId` 额外字段被拒绝；稳定键只由 invoice+consumer 决定。
- 真实 SQLite 多进程：4 个独立进程同时 `reserve + markBroadcasting`，恰好 1 个发送许可；3 个独立进程对同一行并发 `recordHash(A) / recordHash(B) / recordUnknown(TIMEOUT)`，最终恰好一个哈希获胜且状态为 `broadcast`，不会出现“有哈希却被 unknown 覆盖”。
- 发送门：错误 reservationId、篡改 amount/recipient/chain/asset/contract/intentHash、错误 calldata、过期、旧 provider identity/generation、撤销、asset disabled/unregistered、closed journal、CAS 丢失 → 全部在发送前失败。
- 崩溃恢复：mark 后关闭 journal 再重开 → `broadcasting`，新 session 不能 reserve 成 `reserved`，不能再次 mark；reserved 不会无证据重新 claim；owner-restarted 释放要求精确旧 reservation + previous owner。
- unknown：timeout/500/invalid hash 终态；`recordHash` 可把 unknown 升为 broadcast（recoveredFromUnknown=true）；unknown 不覆盖已有哈希；4001/USER_REJECTED 同类，先 unknown，必须带证据 release 才能 attempt+1；超时/500/WALLET_ERROR 不能走 rejection release。
- 存储：WAL/FULL/0600/0700；DB 中不含 calldata、签名字段或原文 reference；事件表无敏感数据且 detail ≤512。
- 恢复查询：`query/lookup/pending` 读回 `unknown` + 已知 hash；不同 tuple 返回 null；`reserved`/`broadcasting`/`unknown` 都不会因为查询变成可发送。

### 10.2 与 approved external 模块的集成探针（REPRODUCED，未提交）

一次性脚本（在 `/tmp`，不进入仓库、不 import 进生产）：

- 真实 approved `plugin/console/external-wallet.js`（`90c32f8`，blob `6395569…`）；
- 真实本分支 SQLite journal + `NetworkRegistry` 适配器；
- 合成 EIP-1193 provider（无扩展、无网络、无资金）；fixed clock；
- 结果：

| 场景 | 结果 |
| --- | --- |
| 正常 prepare + confirm | 1 次 `eth_sendTransaction`，journal `broadcast`，`credited:false` |
| 同一 intent 的新 session | `OPERATION_ALREADY_STARTED`，0 次发送 |
| 两个 live session 并发 confirm 同一 tuple | 1 fulfilled / 1 `OPERATION_JOURNAL_FAILED`，**1 次发送**（旧非原子 mock 的 2 次发送未复现） |
| provider 返回 4001 | external `USER_REJECTED`；journal `unknown`；再 confirm `OPERATION_UNKNOWN`；带证据 release 后新 session 只发送 1 次，最终 `broadcast` |

这证明的是**获批模块 + 真 SQLite journal** 的接口/并发行为，不是真实扩展或真实链兼容性。

### 10.3 门禁（VERIFIED）

```text
bun run boot-check   PASS
bun run secret-scan  PASS: no credentials in the working tree
```

本机全量（预加载 hermetic network guard，`bunfig.toml`）：

```bash
cd plugin
bun test ./test ./console ../docs/validation/lab/phase9/wallet-fixture
```

结果：**792 pass / 0 fail / 6231 expect / 54 files / 34.55s**（macOS arm64，Bun 1.4.3，SQLite 3.50.6；包含本模块 37 个定向测试）。CI（linux/macOS, Bun 1.4.3）结果以 PR head 的 run 为准；历史并行全量曾受其它代理占用固定端口影响，本机这次全量没有出现该冲突。

> 全量通过只说明本机 hermetic 测试通过，不等于真实 Magpie/EasyTier、真实扩展或真实链验收。

## 11. 状态汇总

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 原子 reserve / 单赢家（真实 SQLite，多实例/多进程） | **VERIFIED** | 37 个定向测试；4 进程 race 1 winner |
| `markBroadcasting` CAS + reservationId + exact payload + COMMIT 后返回 | **VERIFIED** | 错误 id/篡改/过期/旧身份均在发送前失败 |
| crash after mark / reopen / new session 不重发 | **VERIFIED** | `broadcasting` 读回并拒绝 |
| unknown 终态、4001 先 unknown、证据释放 | **VERIFIED** | 自动化测试 + external 集成探针 |
| 主网 56/8453 硬阻断；31337 仅 isolated | **VERIFIED** | 构造/port/写入前拒绝 |
| 资产注册表窄接口 + identity/generation 绑定 | **VERIFIED** | 真 `NetworkRegistry` 适配器；disabled/unknown/old identity 负测 |
| 与 approved external 模块的调用顺序/单发送 | **REPRODUCED** | 合成 provider，无真实扩展/链 |
| Service / UI 接线 | **NOT DONE** | 本模块独立；无 HTTP/CSRF/UUID action 接线 |
| 真实 MetaMask/Rabby、真实 97/84532 交易 | **UNKNOWN** | 未做 |
| 回执 from/to/input/log 核验、Ledger credited | **NOT IMPLEMENTED** | 仍由现有 Watcher/Provisioner 负责 |
| 自动充值执行器 / 策略 | **NOT IMPLEMENTED** | 明确不在本单元 |
| 真实资金 / 主网发送 / 主网授信 | **NO-GO** | 禁止；模块只阻止，不提供绕路 |

## 12. 结论

- 对“持久、单赢家、跨 session/崩溃不重发、4001 有证据恢复”的**核心模块**：可以进入独立审查。
- 对“钱包可用/Service 已接/UI 可付款/真实链兼容/真实资金”：**不是 GO**。本单元没有接线，也没有真实扩展、真实链、回执核验或账本授信。
- 任何将本 journal 接入发送路径的后续改动，都必须保持：发送前 `markBroadcasting` 成功且返回；unknown/broadcasting 不接受“再确认”直接重发；主网硬阻断；release 只在 Service 侧且证据齐全。
