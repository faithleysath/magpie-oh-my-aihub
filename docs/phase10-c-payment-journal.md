# Phase 10 C — 付款操作 journal（durable payment-operation journal）

- 分支：`feature/phase10-c-payment-journal`
- worktree：`/Users/laysath/.paseo/worktrees/1z728cdk/c-payment-journal`
- base：已批准 P0-17 `49e8c0ff64c8fcaf28da472e664bee482fd5e843`（含 P0-15；`origin/main` = `8ce5c57f565fb1b835021a9b730b61014eb47d5f`）
- 代码提交：
  - `42589a1ec8b8f940b769a1e410060bf4c08f24e6` 核心 journal；
  - `450936ddffd17d23477321a9dd94666af9ddd7a6` release 绑定 payload、迟到哈希、旧证据年龄；
  - `b2ab34bd360a9b60e625ce0dce245e261fda0d41` `-wal`/`-shm` 0600（独立审已核实）；
  - `ead291f7342263a7d5ffea2f8b0d6f79897f3f7e` 本轮 A/B/C/D/E 修复（per-attempt/hash 历史、unknown release 关闭、provider-scoped key、持久 expiry）。
- docs commit 在代码 head 之上；PR head 以 GitHub 为准。
- 依赖的已批准外置模块：PR #30 head `90c32f8cfd1b98e6705c31ca6e91cfef606dc894`（单独隔离模块；本分支不把它的 JS import 进生产代码）。
- 本模块：`plugin/src/payment-operations.ts`；测试：`plugin/test/payment-operations.test.ts`、`plugin/test/support/payment-operation-race-child.ts`。
- 结论：**发送门 + 持久操作记录的核心可审；未知结果的重试能力本轮关闭，只保留“从未进入 broadcasting 的 reserved”释放。未接 Service/UI，未发送真实交易，未接账本授信，主网仍 NO-GO。**

> 状态口径
>
> - **VERIFIED**：在本机按文中命令实际执行，有可复查输出。
> - **REPRODUCED**：用真实 SQLite/真实批准代码复现了指定场景；合成 provider、无真实链、无真实资金。
> - **UNKNOWN**：未在本轮验证，不能用推测补齐。
>
> 真实 Magpie 0.1.2289 + EasyTier 2.6.4、真实 MetaMask/Rabby、真实测试网交易、主网、真实资金：本单元**都没有**执行。本机目标版本是隔离副本；本模块不读写用户安装或数据。

## 1. 范围与明确不做

本单元只做**付款执行状态的持久化本地核心**：在钱包真正发送前，给一次已核验的测试网付款建立单赢家 claim；在发送前持久化 `broadcasting`；之后只接受哈希或 unknown 证据；跨 session/刷新/第二 tab/进程重启都不能把同一业务意图重新变成可发送。

已实现：

- 原子 `reserve`：稳定键是 **provider 稳定身份 + invoice + 已认证 consumer 地址**；
- `markBroadcasting`：`reserved → broadcasting` 的 CAS，绑定 `reservationId`、精确 operation payload、当前钱包 session，并检查行上持久化的 expiry；
- `recordHash` / `recordUnknown`：CAS、幂等、同一操作可保留多个真实哈希、跨 invoice 哈希冲突拒绝、unknown 不覆盖已知哈希；
- **per-attempt 历史**：旧 reservation 的迟到 hash 在 re-claim 后仍可记录，并能阻止尚未发送的新 claim；已进入 `broadcasting` 的新尝试无法被“事后记录”撤回，文档不声称能防已经发生的第二笔；
- 仅保留 **reserved 释放**（`releaseUnsentReservation`）：证据必须 fresh、owner 绑定、来自 `service-flow` / chain / node / wallet-pending 而非钱包 4001 本身；
- **unknown release 本轮关闭**（`releaseRejectedUnknown` 明确抛 `PAYMENT_OPERATION_RELEASE_REFUSED`）；4001 仍是终态 unknown，UI 不接重试；
- 同一 tx hash 全局唯一（hash ledger 主键 + 主表 partial unique index + 写入前查重）；
- 测试网硬 allowlist、注入式资产注册表、注入式身份/授权代检查；
- SQLite 事务、WAL、`synchronous=FULL`、DB/`-wal`/`-shm` 0600、审计事件；
- 真实多进程 SQLite 并发测试。

明确不做（本轮）：

- **不接 Service、不接 UI、不接 CLI**；没有把 `operationPort` 注入任何现有 Service 发送流程；没有重试按钮；
- **不发送交易**、不签名、不碰 nonce、不持有密钥、不创建钱包；
- **不做自动充值执行器**、不做策略、不做上限/暂停；
- **不写 Ledger、不申请/修改 Magpie cap、不把 receipt 当 credited**；
- 不实现 Watcher 的 from/to/input/log 回执核验；本模块只保存付款执行状态；
- 不接真实扩展/真实测试网/主网；不做真实资金；
- 不新增 DHT/mDNS/路由/中心 API/HTTP server/proxy；
- 不把未审的 C-registry/C-wallet/C-external 代码 import 进生产模块。资产检查只通过窄注入接口；生产适配器用仓库已有的 `NetworkRegistry`；
- 不实现完整的 nonce/mempool 协调系统。unknown 重试要等到能提供可信、fresh、独立的 no-broadcast 证据时再单独评审。

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

模块顺序：`reserve → markBroadcasting → eth_sendTransaction → recordHash`；任何 send 错误/无效哈希 → `recordUnknown`。本模块严格实现五个方法，并额外提供 Service 专用 release/查询方法（不暴露给钱包模块）。

来源证据：

- `90c32f8` 的 `plugin/console/external-wallet.js` blob SHA：`639556977acf98e66098437734ac901743f608f3`；工作树文件 SHA-256：`55e65ab63ef2924ad5f9b198902187f0657524f96c0a46b6679929a338a8f4a2`。
- 冻结接口 `d533e6f` 与最新 fix 的 operationPort 方法名/参数一致（差异只在 chain/icon/docs，不在 port 语义）。
- 模块要求自己默认发送关闭；本模块不改变它的默认，也不把“注入 port”当作已接线。

## 3. 状态机与 attempt 历史

当前行状态只有五种：

| 状态 | 含义 | 还能发送？ |
| --- | --- | --- |
| `reserved` | 本次 claim 赢家，尚未通过发送门 | 只有该 claim 的 `markBroadcasting` 可以进入下一态 |
| `broadcasting` | 发送门已提交；钱包可能已被调用 | **不能**；重启/刷新/新 session 都拒绝 |
| `broadcast` | 已记录至少一个交易哈希；只是广播证据 | **不能**；后续只读/回执核验 |
| `unknown` | 结果未知（超时、RPC/500、无效哈希、钱包拒绝等） | **不能**；本轮没有 release 重试路径 |
| `released` | 仅由“reserved 且从未进入 broadcasting”的 release 产生 | 下一条 `reserve` 可重新 claim，attempt+1 |

`payment_operation_attempts` 保存每个 reservation 的 attempt、payload hash、状态和 tx hash；`payment_operation_hashes` 保存同一业务操作的所有真实哈希。当前行是“当前 attempt 的投影”，旧 attempt 不会被 re-claim 覆盖。

关键转移：

```text
(no row) --reserve--> reserved
reserved --markBroadcasting(reservationId, exact payload, row expiry)--> broadcasting
broadcasting --recordHash(hash)--> broadcast
broadcasting --recordUnknown(reason)--> unknown
unknown --recordHash(hash)--> broadcast                # 后来找到哈希是证据，不是重发
unknown --releaseRejectedUnknown(...)--> REFUSED        # 本轮关闭
reserved --releaseUnsentReservation(fresh owner-bound evidence)--> released
released --recordHash(late hash, any attempt)--> broadcast  # 阻止尚未发送的新 claim
released --reserve(new explicit try)--> reserved (attempt+1)
```

`reserve` 的原子性：先做乐观读取；真正 claim 时在 `BEGIN IMMEDIATE` 事务里再次读取/插入/更新。已存在且非 `released` 时：

- payload 不一致 → `PAYMENT_OPERATION_PAYLOAD_MISMATCH`（不新建行、不发送）；
- `reserved` → 返回 `state:"claimed"`（本模块非发送扩展态；external 对任何非 `reserved` 都拒绝）；
- `broadcasting` / `broadcast` / `unknown` → 返回该终态（external 会拒绝）；
- 只有 `released` 才允许新 claim；re-claim 更新行上 expiry 并产生新 attempt。

`markBroadcasting` 的 SQL 形状：

```sql
UPDATE payment_operations
   SET state = 'broadcasting', updated_at_ms = ?
 WHERE idem_key = ? AND state = 'reserved'
   AND reservation_id = ? AND payload_hash = ?
```

在事务内还会检查 `row.expires_at_ms`（若 >0）未过期、attempt 历史存在。`changes !== 1` 即失败；函数只在事务 `COMMIT` 之后返回。连接设置 `journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=5000`，因此返回时 WAL 已按 FULL 同步。外部模块在 `markBroadcasting` 抛错时不会调用 `eth_sendTransaction`。

`reservationId` 另外绑定到发起 claim 的 `BoundPaymentOperationPort` 实例：即使另一个 tab 拿到了旧的 id，也不能用它的 port 过发送门。数据库 CAS 仍然会再校验一次 reservation id 和 payload。

### 3.1 迟到 hash 与 re-claim 交错

- 旧 attempt 被释放、尚未产生新 attempt 时：旧 reservation 的 hash 可把行从 `released` 升为 `broadcast`，阻止重试。
- 新 attempt 已 `reserved`、尚未 `markBroadcasting`：旧 reservation 的迟到 hash 通过 `payment_operation_hashes` 记录，并把当前行置为 `broadcast`；新 attempt 的 `markBroadcasting` 随后失败，**不会发送**。
- 新 attempt 已 `broadcasting`（钱包可能已在途）：迟到 hash 只记录到 hash ledger 并留事件，**不声称能撤回/阻止已经发生的第二笔**。若新 attempt 也已广播，两个 hash 都会保留，交 Service 人工核验。
- 旧 attempt 的 `recordUnknown` 在新 attempt 仍 `reserved` 时会把当前行置为 `unknown`（reason `PRIOR_ATTEMPT_UNKNOWN`），阻止新发送；这是 fail-closed，不是可重试状态。

## 4. 幂等键与 payload

稳定键（不是 preview UUID、不是每次新生成的 intentHash）：

```text
idemKey = sha256("ohmyaihub.payment-operation/idem/v2\n" + canonical({
  providerIdentityFingerprint,   // stable provider/node identity
  invoice,                       // Service-level obligation id, or provider-namespaced
  consumerAddress                // locally authenticated consumer wallet
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
- **provider stable id 在 key 里**：两个 provider 使用各自本地的同一 invoice 字符串时，不会互相误挡；这是主审选择的 D 方案。provider fingerprint 仍保留在 payload 里，换 provider 身份不能悄悄复用同一行。
- **invoice 的唯一域**：Service 必须使用 Service 级唯一 obligation id，或显式 provider-namespaced invoice；consumer↔invoice 的授权由 `identityAuthority` 负责，journal 不能替代。
- **旧库迁移 fail closed**：`user_version` 升到 3；非空 v1/v2 journal 在打开时直接拒绝，不静默重算 key、不合并、不重复。没有旧生产数据；非空旧库必须保留原文件并显式迁移/只读导出，**不要删除数据库后用同一 invoice 重发**。构造器在拒绝前最多新增空的 `payment_operation_attempts`/`payment_operation_hashes` 表，不改现有行、不改 `user_version`；错误可恢复。
- **intentHash 不参与 idemKey**：避免每次 preview 造新 hash 绕过唯一约束；它仍进入 payload，第二次不同（包括 null ↔ hash）会 `PAYLOAD_MISMATCH`。
- **报价/收款人/金额/资产/链/合约/精度/identity/generation 变化**：同一 idemKey 下 payload 不再相等 → 拒绝；报价变化必须先走释放/重新核验。
- 固定 ERC-20 `transfer(address,uint256)` calldata 重新编码，并与 `calldataHash`、recipient、amount 交叉校验；不接受任意 calldata/selector；`amountRaw` 显式限制在 uint256 内。

## 5. 发送门、崩溃点与“永不重发”

| 崩溃/失败点 | 持久化结果 | 之后 |
| --- | --- | --- |
| `reserve` 前 | 无行 | 可重新明确确认 |
| `reserve` 后、`markBroadcasting` 前 | `reserved` | 只有 Service 能带 fresh、owner-bound 证据释放；不会自动变成可发送 |
| `markBroadcasting` 事务中失败 | 仍 `reserved` | external 不发送；同上 |
| `markBroadcasting` COMMIT 后、钱包调用前 | `broadcasting` | **不重发**；作为未知/已开始处理，按哈希或节点侧恢复 |
| 钱包调用后、`recordHash` 前 | `broadcasting` | **不重发**；可以补录哈希（`unknown` 也允许补录为 `broadcast`） |
| `recordHash` 写失败 | journal 仍 `broadcasting`；external 报 `OPERATION_JOURNAL_FAILED` 且带真实 hash | **不重发** |
| `recordUnknown` 写失败 | journal 仍 `broadcasting`；external 进入 unknown | **不重发** |
| 旧 attempt 的 hash 在新 claim 之后到达，且新 claim 未发送 | 当前行 `broadcast`，旧 hash 保留 | 新 claim 的 mark 失败，不发第二笔 |
| 旧 attempt 的 hash 在新 claim 已 broadcasting 后到达 | 两个 hash 保留/事件 | 不能撤回已发生的第二笔；Service 人工核验 |

即：**发送许可只在 `markBroadcasting` 成功返回后存在**；任何异常路径都不会释放 nonce 或再发。`recordUnknown` 不会把已有哈希降级；不同哈希在同一操作中作为额外证据保留，跨 invoice 则 `HASH_CONFLICT`。

## 6. release 语义（本轮只保留 reserved 释放）

`releaseRejectedUnknown`：

- **本轮关闭**：调用直接返回 `PAYMENT_OPERATION_RELEASE_REFUSED`，不读 evidence、不改变行；4001/超时/RPC/无效哈希都保持 `unknown`。
- 原因：journal 只能证明 `reserved` 从未通过发送门；它不能证明 `unknown` 的钱包尝试没有广播。让 Service 用“事后记录 hash”或 owner boolean 自证会制造重试双发窗口。
- 未来重开需要：可信、fresh、独立的 no-broadcast 观察（`chain-nonce` / `node-mempool` / `wallet-pending-set` 之一），绑定原 attempt/payload/owner，UI 必须创建新 preview；这属于后续 nonce/恢复单元，本 PR 不实现。

`releaseUnsentReservation`：

- 只接受 `reserved`（`markBroadcasting` 从未 COMMIT），必须精确 `reservationId` + `payloadHash`；
- evidence 统一使用 `noBroadcastObservation`：
  - `observedAt` 必须 >= 该行进入当前 reserved 的时间（`updated_at_ms`），且不超过 24 小时；
  - `method` 只接受 `service-flow | chain-nonce | node-mempool | wallet-pending-set`；**不接受** `provider-response`（4001 同源不能自证未广播）；
  - `releasedByOwnerInstanceId` 必须等于当前 journal 的 owner；
  - `service-recovered-unsent` 只允许当前 owner 自己的行；重启后使用 `owner-restarted-before-broadcast`，必须给出与行一致的 previous owner（且不同于当前 owner）；
  - reference 只存 SHA-256。
- 没有定时器、没有“N 分钟后自动释放”、没有浏览器 release API；释放后重新 claim 仍需用户重新明确确认（external 的 `userInitiated` + `acknowledged`）。

**边界**：`confirmedNoBroadcast` 仍是 Service 的显式断言；journal 通过“状态是 reserved + fresh 证据 + owner 绑定”把可释放范围限制到“确定没通过发送门”。如果 Service 无法证明，必须保持 unknown/reserved，不能重试。

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

- `payment_operations`：一行一个 `idem_key`；保存 invoice、consumer/provider 公开标识、generation、intent hash、chain/asset 四元组、recipient、amountRaw、decimals、calldataHash、**expires_at_ms**、state、reservationId、owner instance、txHash、reason、attempt、时间戳。
- `payment_operation_attempts`：每个 reservation 的 attempt/payload/state/hash。
- `payment_operation_hashes`：`hash PRIMARY KEY`，同一业务操作的全部真实哈希；写入前还查主表，主表有 partial unique index on `tx_hash WHERE tx_hash IS NOT NULL`。
- `payment_operation_events`：状态转移审计；detail 只放状态/哈希/方法/referenceHash，长度上限 512。

安全：

- 数据库文件及其 `-wal`/`-shm` 都是 0600；目录在本模块创建时 0700（调用方已有目录不改）；`PRAGMA journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`；`PRAGMA user_version=3`。
- SQLite 的 WAL/SHM 最初按 umask 创建，构造器完成 schema 后统一 `secureFiles()`；空库的极短窗口已在独立审记录。
- **不存** seed、私钥、签名、raw tx、calldata 本体；输入的额外字段直接拒绝。
- reason 脱敏/截断为 `[A-Za-z0-9._:-]{1,64}`；release evidence 的 reference 只存 SHA-256。
- 本模块没有日志输出；不写 console/snapshot。
- **只读查询不产生 send permit**；`txHash`/`hashes`/events 只是证据，不代表 credited。未来由现有 Watcher 核验 from/to/input/log，仍由现有 Ledger/Provisioner 决定授信；本 journal 不写 Ledger、不写 cap、不凭远端 credit。

## 9. Service / UI 集成设计（本轮未接）

```ts
const journal = openPaymentOperationJournal({
  path,                       // 默认 statePath("payment-operations.sqlite")
  ownerInstanceId,            // 每次本地 Service 生命周期一个；不是网络授权
  assetRegistry,              // 生产用 networkRegistryAssetResolver(networkRegistry)
  identityAuthority,          // Service 已认证 consumer + accepted provider + generation
  now,
  // isolatedTestChains: [31337]  // 仅测试构造
});
const port = journal.operationPort(bindingFromVerifiedIntent);
const session = createExternalWallet({ ..., operationPort: port });
```

- `bindingFromVerifiedIntent` 必须由 Service 从**本地已核验 intent** 生成；远端/P2P 输入不能改 recipient/amount/asset/price。`intentHash` 传本地 intent 的值；没有就传 `null`，不要让 UI 每次 preview 造新 hash。
- `invoice` 是 Service 级 obligation id（或 provider 命名空间化的 id）；provider stable identity 进入 idemKey，但 consumer↔invoice 的授权仍由 `identityAuthority` 负责。
- **一浏览器/已认证会话一个 `operationPort` 实例**。`BoundPaymentOperationPort.issued` 是进程内 sentinel；如果每请求重建 port，旧 reservation 不能 mark（fail closed，但不可用），只能在 Service 侧 lookup/release。数据库只持久化 reservationId，不持久化浏览器 session；未来若通过 localhost API 暴露，必须由已认证 Service 加 CSRF + 精确 UUID/action allowlist，并把 session 映射写进契约。
- `ownerInstanceId` 每次 Service boot 生成；`service-recovered-unsent` 只在当前 owner 自己的 reserved 行上有效；重启后使用 `owner-restarted-before-broadcast`。`ownerInstanceId` 是生命周期/审计标记，不是网络/身份认证；`path`/`ownerInstanceId` 现在是只读 getter，但类不是安全沙箱。
- `query` 现状：approved external 模块**从不调用** `query`（源码 VERIFIED）。Service 的 status projection 使用 `lookup`/`pending`/`query`；读回 `unknown` 时显示已知 `txHash`/“按哈希核对链上”，**不提供重发按钮**。unknown release 已关闭，UI 不得暴露“已确认未广播，重试”入口。
- release 方法只在 journal 上，不在 port 上；`lookup`/`pending` 返回的 `payloadHash` 就是 Service 在释放时必须回传的“我检查过的那一笔”。不要把它们暴露成 HTTP 路由或浏览器 API。
- 构造函数里的 owner/capability 不是网络授权；本模块不创建 HTTP server，也不做 proxy。**未接线 = 不声称 UI/Service 可用。**

后续小 commit（不在本 PR）：Service 注入 port、status projection、UI 的“未知/按哈希核对”视图、reserved release 的接线、真实链/扩展验证。unknown 重试要等独立的 nonce/mempool 恢复单元。

## 10. 测试与证据

### 10.1 本模块测试（VERIFIED）

平台：macOS arm64（本机），Bun `1.4.3`，SQLite `3.50.6`。

```bash
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun test ./test/payment-operations.test.ts
```

结果（代码 `42589a1 + 450936d + b2ab34b + ead291f`）：

```text
40 pass
0 fail
287 expect() calls
Ran 40 tests across 1 file. [~1.7s]
```

覆盖：

- 硬 allowlist：97/84532；56/8453 在任何写入前拒绝；未知链拒绝；31337 只有显式 isolated 构造且 registry 也有该链时才可用；其它链不能借 isolated 选项混入。
- 单赢家：同一 journal 两个 port、同一文件两个 journal 实例、reopen/new session、第二 tab；`previewId` 额外字段被拒绝；稳定键由 provider+invoice+consumer 决定；两个 provider 同 invoice 不互相误挡。
- 真实 SQLite 多进程：4 个独立进程同时 `reserve + markBroadcasting`，恰好 1 个发送许可；3 个独立进程对同一行并发 `recordHash(A) / recordHash(B) / recordUnknown(TIMEOUT)`，最终恰好一个哈希获胜且状态为 `broadcast`，不会“有哈希却被 unknown 覆盖”。
- 发送门：错误 reservationId、篡改 amount/recipient/chain/asset/contract/intentHash、错误 calldata、过期、旧 provider identity/generation、撤销、asset disabled/unregistered、closed journal、CAS 丢失、`SQLITE_BUSY` → 全部在发送前失败（busy 映射为 `PAYMENT_OPERATION_BUSY`）。
- 崩溃恢复：mark 后关闭 journal 再重开 → `broadcasting`，新 session 不能 reserve 成 `reserved`，不能再次 mark；reserved 不会无证据重新 claim。
- **A**：reserved release → re-claim attempt 2 → 旧 reservation 的 late hash → 当前行 `broadcast`，attempt 2 的 mark 失败；旧 attempt 的 hash 保留在 `hashes`。
- **B**：reserved release 证据必须 >= 行进入 reserved 的时间、<=24h fresh、owner 匹配、method 不含 provider-response；`service-recovered-unsent` 只允许同 owner，`owner-restarted` 要求 previous owner。unknown release（4001/timeout/500/invalid hash）全部 `RELEASE_REFUSED`。
- **C**：同一 tx hash 写入两个 invoice → 第二个 `HASH_CONFLICT`，第二行仍 `broadcasting`、无 hash。
- **D**：同一 invoice+consumer、不同 provider identity → 两个独立 reserved，`lookup` 分别命中；旧库非空 v3 迁移 fail closed（构造器拒绝）。
- **E**：`expiresAtMs` 持久化；过期后 mark 在发送前 `EXPIRED`。
- 存储：WAL/FULL；DB、`-wal`、`-shm` 都 0600，目录 0700；DB 中不含 calldata、签名字段或原文 reference；事件表无敏感数据且 detail ≤512。
- 恢复查询：`query/lookup/pending` 读回 `unknown` + 已知 hash/hashes；不同 tuple 返回 null；`reserved`/`broadcasting`/`unknown` 都不会因为查询变成可发送。

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
| provider 返回 4001 | external `USER_REJECTED`；journal `unknown`；再 confirm `OPERATION_UNKNOWN`；`releaseRejectedUnknown` → `PAYMENT_OPERATION_RELEASE_REFUSED`；**不重试，1 次发送** |

这证明的是**获批模块 + 真 SQLite journal** 的接口/并发行为，不是真实扩展或真实链兼容性。unknown 重试关闭是安全取舍，不是遗漏。

### 10.3 门禁（VERIFIED）

```text
bun run boot-check   PASS
bun run secret-scan  PASS: no credentials in the working tree
```

本机全量（新增 A/B/C/D/E 测试之前）：**794 pass / 0 fail / 6242 expect / 54 files / 29.26s**。按主审要求本轮不重复本机全量，CI 跑全量。CI `41164489619` @ `85b3fc8`（code `ead291f`）：**linux 795 pass / 0 fail / 6275 expect / 796 tests；macOS 794 pass / 0 fail / 6272 expect / 795 tests；均 success**。历史 CI `41163498408` @ `b2ab34b`：linux 795/0/6248，macOS 794/0/6245。

> 全量通过只说明本机 hermetic 测试通过，不等于真实 Magpie/EasyTier、真实扩展或真实链验收。

## 11. 状态汇总

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 原子 reserve / 单赢家（真实 SQLite，多实例/多进程） | **VERIFIED** | 40 个定向测试；4 进程 race 1 winner |
| `markBroadcasting` CAS + reservationId + exact payload + row expiry + COMMIT 后返回 | **VERIFIED** | 错误 id/篡改/过期/旧身份均在发送前失败 |
| crash after mark / reopen / new session 不重发 | **VERIFIED** | `broadcasting` 读回并拒绝 |
| A：late hash after re-claim | **VERIFIED** | per-attempt/hash ledger；未发送的新 claim 被阻止；已发送的第二笔不由 journal 假装撤回 |
| B：reserved release 证据 | **VERIFIED** | fresh/owner/method/统一 observation；unknown release 关闭 |
| C：tx hash 全局唯一 | **VERIFIED** | hash ledger PK + main partial unique + precheck；跨 invoice HASH_CONFLICT |
| D：provider-scoped key / 旧库迁移 | **VERIFIED** | `idem/v2`；两个 provider 同 invoice 不误挡；非空 v1/v2 fail closed |
| E：expiry 持久化 / session 契约 | **VERIFIED / 部分文档** | `expires_at_ms` 存储并在 mark 检查；一 session 一 port 只写入集成契约 |
| 主网 56/8453 硬阻断；31337 仅 isolated | **VERIFIED** | 构造/port/写入前拒绝 |
| 资产注册表窄接口 + identity/generation 绑定 | **VERIFIED** | 真 `NetworkRegistry` 适配器；disabled/unknown/old identity 负测 |
| 与 approved external 模块的调用顺序/单发送 | **REPRODUCED** | 合成 provider；4001 后 unknown 不重试 |
| Service / UI 接线 | **NOT DONE** | 本模块独立；无 HTTP/CSRF/UUID action 接线；无重试按钮 |
| 真实 MetaMask/Rabby、真实 97/84532 交易 | **UNKNOWN** | 未做 |
| 回执 from/to/input/log 核验、Ledger credited | **NOT IMPLEMENTED** | 仍由现有 Watcher/Provisioner 负责 |
| 自动充值执行器 / 策略 | **NOT IMPLEMENTED** | 明确不在本单元 |
| 真实资金 / 主网发送 / 主网授信 | **NO-GO** | 禁止；模块只阻止，不提供绕路 |

## 12. 结论

- 对“持久、单赢家、跨 session/崩溃不重发、reserved-only 释放、late hash 保留、provider-scoped key、持久 expiry”的**核心模块**：可以进入独立审查。
- 独立审确认的 A（late-hash-after-reclaim）已用 per-attempt/hash 历史修复到“阻止尚未发送的新 claim”；对已经 `broadcasting` 的第二笔不声称可撤回。
- unknown/4001 的 release 本轮**关闭**，UI 不接重试；未来只有在可信、fresh、独立 no-broadcast 证据和 nonce/恢复单元完成后才重新评估。
- 对“钱包可用/Service 已接/UI 可付款/真实链兼容/真实资金”：**不是 GO**。本单元没有接线，也没有真实扩展、真实链、回执核验或账本授信。
- 主网 56/8453、真实资金、自动充值：**NO-GO**。
