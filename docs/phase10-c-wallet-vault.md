# Phase 10 C — 内置钱包核心（BIP39 / BIP44 / keystore-v3 / 受限签名）

> 状态：**核心模块与隔离测试完成，draft PR 待审查；不合并、不接真实资金**。
> 本文只描述本分支实际实现和实际运行结果。它**不是**安全验收，也不是生产 GO。
> 关键结论：**能力已开发 ≠ 真实资金获准**；生产真实资产内置钱包仍为 **NO-GO**。

## 0. 基线、分支与平台

| 项 | 值 | 证据 |
| --- | --- | --- |
| 基线 main | `8ce5c57f565fb1b835021a9b730b61014eb47d5f`（PR13 合并） | `git rev-parse HEAD` |
| 工作树 | `/Users/laysath/.paseo/worktrees/1z728cdk/c-wallet` | 本任务独立 worktree |
| 分支 | `feature/phase10-c-wallet-vault` | `git branch --show-current` |
| 平台 | macOS 26.6.2（25G83），Darwin arm64 | `sw_vers` / `uname -m` |
| Bun | 1.4.3 | `bun --version` |
| 目标运行版本（上游） | Magpie 0.1.2289 + EasyTier 2.6.4，隔离副本 | 主调度决定；本模块未启动它们 |
| 真实资金 | **NO-GO** | 用户/ARCHITECTURE 约束 |

本分支只新增：

- `plugin/src/wallet-vault.ts`
- `plugin/test/wallet-vault.test.ts`
- `plugin/package.json` / `plugin/bun.lock` 中的 `ethers@6.17.0` 及其锁定依赖
- 本文件

**没有修改** `plugin/src/service.ts`、console UI、network registry、Magpie、EasyTier 或用户数据目录。

## 1. 已实现与明确未实现

### 已实现（源码 + 本地测试）

- BIP39 英文助记词创建（12/15/18/21/24 词可导入；创建默认 12 词）与校验。
- 标准 BIP44 EVM 派生路径 `m/44'/60'/0'/0/0`；同一助记词恢复到同一地址。
- 标准 Web3 Secret Storage v3 keystore 文件（ethers `x-ethers` 扩展在同一文件内加密保存 BIP39 entropy）。
- 静态加密、scrypt KDF、密码策略、CSPRNG、0600 文件、0700 新建目录、临时文件 + `fsync` + 原子发布。
- 锁定/解锁；固定短 TTL（默认 5 分钟、最大 15 分钟）；重启后必须重新解锁；手动 lock/dispose。
- 加密备份导出与恢复；替换已有钱包必须重新验证旧密码。
- 修改密码（重新生成 salt/IV/UUID，旧密码失效）。
- 敏感导出：助记词、私钥。必须同时满足：
  1. 当前有未过期的解锁会话；
  2. 专用一次性 capability（不可序列化、绑定 vault/session/kind/purpose/expiry）；
  3. 重新输入钱包密码并重新解密验证。
- 普通 snapshot 只有版本、公开地址、状态、会话过期时间；不含助记词、私钥、keystore 或密码。
- EIP-712：
  - `previewTypedData()` 只构造/哈希，**永不签名**，主网 56/8453 也可预览；
  - `prepareTypedData()` 需要显式 purpose，绑定 chainId、verifyingContract、primaryType、domain name/version 和字段集合；
  - `signTypedData()` 只接受本 vault 生成的 prepared 对象，并需要一次性/有界 `SigningPermit`。
- 模拟/testnet EIP-1559 付款签名：
  - `preparePayment()` 绑定 chainId/to/value/nonce/gas/fee/data；
  - `signPayment()` 只返回已签名 raw tx/hash，**不广播**；
  - 签名后解析回读并核对 chain/to/value/nonce/from。
- 主网 56/8453 硬拒绝：所有签名路径、付款准备、自动充值策略验证都拒绝；typed data 只能 preview。
- 自动充值只定义严格短 session policy 形状与校验，**没有执行器、没有定时器、没有余额读取**。
- `signingFacade()`：给 P2P/外部适配器的窄接口，只有 snapshot/prepare/sign，没有 unlock、导出、改密码、mint permit。

### 未实现（不在本核心单元）

- 控制台/Service 集成、页面、钱包创建向导、导出 UI。
- C-registry 的链/资产注册表与主网只读页；本模块只消费注入的 `WalletChainPolicy`。
- 外置钱包 EIP-6963/1193 适配；本模块只提供窄签名接口和严格 intent/prepared 绑定。
- 自动充值执行器、余额监控、nonce 管理、上限暂停；只提供 policy 校验和 permit 接口。
- 真实链广播、真实 testnet 付款、真实 Magpie/EasyTier 端到端。
- 多账户/账户发现、BIP39 passphrase、PBKDF2 keystore、硬件钱包、Keychain/TPM。
- 生产级安全声明、独立审计、真实资金 GO。

## 2. 依赖与来源（实际检索，不凭记忆）

直接依赖只有 **`ethers@6.17.0`（精确 pin，无 `^`）**。

| 项 | 值 |
| --- | --- |
| npm 包 | `ethers@6.17.0` |
| tarball | `https://registry.npmmirror.com/ethers/-/ethers-6.17.0.tgz`（当前 bun registry） |
| integrity | `sha512-BpyrpIPJ3ydEVow8zGaz1DuPS7YU8DcWxuBnY9a0UA/lvAPwrMr+EPXsfrul628SRaekPNeIM4UFh/91GWZang==` |
| npm `gitHead` | `b48bfe34b11e059c4418718f9cad4e6cbe4c0680` |
| GitHub tag | `v6.17.0` → commit `3ea4c226dd0b3a074abf90748de9d11192027f4f`（tag 与 npm gitHead 不是同一 SHA，release 构建差异；UNKNOWN 具体发布流水线） |
| 许可证 | MIT |
| 仓库 | https://github.com/ethers-io/ethers.js |
| 源码审查范围 | `lib.esm/wallet/json-keystore.js`（V3 + x-ethers）、`wallet/hdwallet.js`、`wallet/mnemonic.js`、`crypto/scrypt.js`；核对 BIP39/BIP44、V3 加密/解密、scrypt 参数与 `x-ethers` mnemonic 布局 |
| 已知安全公告 | GitHub `security-advisories` 返回空数组；`search/issues` 无 open security 标签（2026-10-31 查询） |
| npm audit | 使用公共 registry `npm audit --omit=dev`：0 个 known vulnerabilities（prod 10 / total 9 计数来自 npm 输出）；npmmirror 镜像的 audit endpoint 404，不能作为证据 |
| 正式审计 | 未找到针对本集成的独立第三方审计；UNKNOWN。本文只声明“审查了这些源码路径”，不声明 ethers 整体经过审计 |

锁定依赖（`bun.lock` 记录 integrity）：

- `@adraffy/ens-normalize@1.11.1`
- `@noble/curves@1.2.0`
- `@noble/hashes@1.3.2`
- `@types/node@22.7.5`
- `aes-js@4.0.0-beta.5`
- `tslib@2.7.0`
- `ws@8.21.0`

说明：`ws` 是 ethers 包依赖，但本模块不使用 provider/WebSocket；`aes-js` 是 ethers keystore 的 AES-CTR 实现；`@noble/*` 是 ethers 的曲线/哈希依赖。Bun 宿主仍能看到这些包以及解密后的内存。

复现安装：

```bash
cd plugin
bun install --frozen-lockfile
```

## 3. 设计与不变量

### 3.1 文件格式

文件就是 ethers 生成的 Web3 keystore v3 JSON，不是自定义外层容器：

- `version: 3`
- `crypto.cipher: "aes-128-ctr"`
- `crypto.kdf: "scrypt"`
- `crypto.kdfparams`: `n/r/p/dklen=32/salt`
- `crypto.ciphertext`: 32 字节私钥密文
- `x-ethers`: `version "0.1"`、`path "m/44'/60'/0'/0/0"`、`locale "en"`、加密后的 BIP39 entropy
- `address`: 公开地址（解锁时用解密出的地址复核）

`x-ethers` 是 ethers 的扩展，不是 Web3 v3 规范本身；标准 V3 工具可以读取私钥，但可能忽略/丢弃助记词元数据。**跨工具保留助记词是 UNKNOWN**；本 vault 只保证 ethers 写入/读取自己的备份。

### 3.2 KDF、密码和 DoS 约束

默认：`scrypt N=2^17, r=8, p=1`（约 128 MiB 内存；本机约 0.3–0.8 秒，随负载变化）。

读取 keystore 时强制：

- 只接受 scrypt；拒绝 PBKDF2 备份（本实验模块不做弱 KDF 兼容）。
- `N` 必须是 2 的幂，范围 `2^15 .. 2^18`。
- `r` 1..16，`p` 1..4。
- `128*N*r <= 256 MiB`，`N*p <= 2^20`。
- `dklen === 32`；salt 16..64 字节；IV 16 字节；ciphertext/MAC 32 字节。
- JSON 最大 128 KiB；超限在 KDF 前拒绝。
- 拒绝未知字段、大小写重复字段、错误 cipher、错误 x-ethers 版本/路径/locale。
- 新密码至少 12 个字符、最多 1024 UTF-8 字节；不允许全空白。

这只能限制本地 KDF 资源消耗，不能阻止攻击者复制 keystore 后离线猜密码；密码强度仍是主要边界。

### 3.3 会话、锁定和重启

- `unlock(password)` 先锁定旧会话，再解密；失败不会留下新会话。
- 会话 TTL 固定，不因普通读 snapshot/签名自动续期；默认 5 分钟，最大 15 分钟。
- 每次 `snapshot()` 都会检查过期并清理；`lock()`/`dispose()` 立即丢弃引用。
- 所有 permit/capability 绑定 `vaultId + sessionId`；锁定、重新解锁、重启、TTL 过期后全部失效。
- 文件只保存密文；重启后 `WalletVault.open()` 状态是 `locked`，必须重新输入密码。
- 失败密码、错误导出密码、过期敏感操作会锁定会话（capability 在密码验证前消耗）。
- 敏感导出会在 KDF 后再次核对 session；签名付款在异步签名前后核对 session id。

**不承诺**：JavaScript 能完美清除内存、V8/Bun 堆、swap、core dump、崩溃快照或同宿主读取。`dispose()` 只是丢弃引用和会话许可。

### 3.4 文件权限与原子写

- 新目录 `0700`；文件 `0600`；POSIX 读取时拒绝 group/other 可读位。
- 拒绝符号链接钱包文件和目录。
- 临时文件同目录、`wx` + `0600`、写入后 `fsync`，再用 hard-link（不覆盖）或 rename（显式 replace）发布，最后 fsync 目录。
- 不使用 `.prev` 备份：避免密码更换后旧密码仍能解开旧副本。代价是旧 inode 可能留在磁盘/快照；**不承诺安全擦除**。
- 写入失败会清理临时文件并保留旧文件（rename 前的失败）。
- Windows 的 `0600`/目录 fsync 语义未验证；本分支只在 macOS 实测，Linux 预期相同但本轮未跑，Windows **UNKNOWN**。

### 3.5 敏感导出能力

`createExportCapability({kind, purpose, confirmation: "local-user-confirmed", ttlMs})`：

- 只能在已解锁会话中创建；TTL 1–120 秒（默认 60 秒）。
- 返回对象使用模块私有 brand/WeakMap；`JSON.stringify()` 为 `undefined`，不能伪造、不能跨 vault/跨 session 使用。
- `kind` 只能是 `mnemonic` 或 `private-key`；`purpose` 受限：
  - 助记词：`wallet-recovery` / `wallet-migration`
  - 私钥：`eip155-external-wallet` / `wallet-migration`
- `exportMnemonic` / `exportPrivateKey` 是唯一返回明文的专用方法；必须同时传入 capability + 当前密码。capability 在密码验证前被标记使用，因此错误密码也消耗它。
- 私钥导出结果包含 `address`、`path`、`purpose`；助记词导出同样包含地址/路径/用途。
- 普通 snapshot、错误、日志、异常不包含助记词/私钥/密码/ciphertext。

`createExportCapability` 仍是同进程 API，不是沙箱。P2P 适配器只应拿到 `signingFacade()`；本地 UI/Service 才持有完整 `WalletVault`，且必须只在用户明确点击后创建 capability。

### 3.6 EIP-712 作用域与 permit

- `previewTypedData()`：任意合法 typed data 的哈希预览，返回 `signable:false`；主网 56/8453 也只到这里。
- `prepareTypedData({purpose, typedData})`：
  - purpose 配置固定 chainId、primaryType、domain name/version、1..8 个 verifyingContract、字段顺序和原始类型；
  - domain 必须恰好是 `name/version/chainId/verifyingContract`；
  - `EIP712Domain` 类型必须恰好是标准四字段；
  - 不允许额外 types、额外/缺失 message 字段、未知 domain 字段；
  - 文档 chainId 先经过 chain policy 和 56/8453 硬拒绝；
  - 返回的对象由模块 WeakMap 登记，伪造对象不可签名。
- `signTypedData({prepared, permit})`：
  - 重新计算 digest 并与登记值比较；
  - 重新检查 purpose/chain policy；
  - 消耗 permit 后签名；返回 digest/address/chainId/purpose/primaryType/verifyingContract；
  - 不返回交易，不广播。

`SigningPermit`：

- 只能由本地 `WalletVault.createSigningPermit()` 在解锁会话中创建；
- 绑定 `vaultId/sessionId/kind/purpose/chainId`；
- TTL 1–300 秒（默认 60 秒），最多 8 次；
- 付款 permit 还绑定 `maxPerPaymentWei`、`maxTotalWei`，累计 `spentWei`；
- 失败的限制检查不消耗次数；签名前的成功消耗在异常时不退款（fail closed）；
- 锁定/重新解锁/重启/过期后失效；不能序列化。

### 3.7 主网与自动充值

- `MAINNET_SIGNING_DENIED_CHAIN_IDS = [56, 8453]` 在 `assertSignableChain()` 中硬拒绝；即使注入的 policy 把 56 标成 simulation/testnet，也会拒绝。
- 其他主网/未知链由注入的 `WalletChainPolicy` 拒绝；默认策略 `DENY_ALL_CHAIN_POLICY` 拒绝一切，避免“没接线就能签”。
- `preparePayment()` 只允许 policy 分类为 simulation/testnet 的链；主网 56/8453 连准备都拒绝。
- `signPayment()` 再次检查 chain policy，并解析回读 raw tx；没有 `send`/`broadcast` API，模块没有 RPC/fetch 代码。
- `validateAutoRechargePolicy()` 只校验 policy 形状：chain/asset 四元组、per-payment/total 上限、最多 8 次、≤5 分钟、nonce、余额阈值；不读余额、不执行、不自动签名。未来执行器必须把它转换成上述 `SigningPermit`，并由本地用户 opt-in 创建。

### 3.8 窄接口

`WalletVault.signingFacade()` 返回：

```ts
{
  snapshot,
  prepareTypedData,
  preparePayment,
  signTypedData,
  signPayment,
}
```

没有 `unlock`、`exportMnemonic`、`exportPrivateKey`、`exportEncryptedBackup`、`changePassword`、`createSigningPermit`。P2P/外部钱包适配器应只持有这个对象；permit 由本地 Service/UI 在用户确认后创建。再次强调：这是 API 隔离，不是对同进程恶意代码的安全边界。

## 4. 测试与证据

### 运行命令（可复现）

```bash
cd plugin
bun run typecheck
bun test test/wallet-vault.test.ts
bun run secret-scan
bun install --frozen-lockfile
```

### 本机结果（2026-10-31，macOS arm64，Bun 1.4.3）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `bun run typecheck` | PASS | `tsc --noEmit` 无输出 |
| `bun test test/wallet-vault.test.ts` | **39 pass / 0 fail / 201 expect** | 纯模块，临时目录，无网络 |
| `bun run secret-scan` | PASS | 工作树无凭据模式 |
| `bun install --frozen-lockfile` | PASS（no changes） | lock 可复现 |
| `npm audit --omit=dev`（公共 registry） | 0 known vulnerabilities | 不是完整供应链审计 |

**没有运行完整 `bun run test` 作为本轮门禁**：仓库存在已知固定时钟失败（P0-3）和会探测生产 Magpie/公共 RPC 的旧测试；网络 guard 由另一个小 PR 处理。本模块只跑针对性纯测试，不把旧失败或旧网络访问写成通过。

### 覆盖矩阵

| 要求 | 测试 | 结果 |
| --- | --- | --- |
| 公开 BIP39 12 词向量 → 公开地址/私钥 | `published 12-word vector...` | REPRODUCED |
| 公开 BIP39 24 词向量 | `published 24-word vector...` | REPRODUCED |
| 随机创建 → 助记词 → 第二 vault 同地址 | `created mnemonic...` | REPRODUCED |
| 标准 V3 文件、0600/0700、ethers 可解密 | `the file is a standard Web3 keystore-v3...` | REPRODUCED |
| 默认 KDF 强参数 | `default KDF...` | REPRODUCED（默认 N=2^17） |
| 0644 文件 / 符号链接拒绝 | `a 0644 wallet file...` | REPRODUCED |
| 篡改 ciphertext/MAC/KDF/未知字段 | `tampered ciphertext...` | REPRODUCED |
| 错密码、锁定、会话过期、重启 | `unlock expires...` | REPRODUCED |
| 改密码旧密码失效 | `changing the password...` | REPRODUCED |
| 覆盖保护/旧密码复验 | `create/import/restore will not overwrite...` | REPRODUCED |
| 加密备份恢复同地址/助记词 | `backup restores...` | REPRODUCED |
| 备份错密码/篡改不落地 | `a backup with a wrong password...` | REPRODUCED |
| 敏感导出 capability 一次性/过期/伪造/跨 vault | `capabilities expire...` | REPRODUCED |
| 导出错误密码消耗 capability 并锁定 | `a wrong password consumes...` | REPRODUCED |
| 普通 snapshot 无 secret | `the ordinary snapshot...` | REPRODUCED |
| 公开 EIP-712 Mail 向量 | `the published EIP-712 Mail vector...` | REPRODUCED |
| purpose 签名 + 地址恢复验证 | `a prepared purpose can sign...` | REPRODUCED |
| 主网 56/8453 只 preview，prepare/sign 拒绝 | `mainnet domains...` / `hard deny...` | REPRODUCED |
| 伪造 prepared / 跨 vault prepared | `forged prepared...` / `prepared documents...` | REPRODUCED |
| 模拟链 EIP-1559 付款签名、不广播 | `signs a bounded EIP-1559...` | REPRODUCED |
| permit 上限/次数/锁定拒绝 | `value limits...` / `signing while locked...` | REPRODUCED |
| 自动充值 policy 形状拒绝主网/长 TTL/坏上限 | `auto-recharge policy shape...` | REPRODUCED |
| 并发 unlock/export/sign | `concurrency...` | REPRODUCED |

测试中的密钥来源：

- BIP39 公开向量（Trezor/社区标准向量）与运行时由 `HDNodeWallet.fromPhrase()` 派生的公开私钥；
- 其他 key 均在 `mkdtemp` 临时目录中随机创建；
- **没有读取任何真实钱包 secret、用户配置、Magpie/EasyTier 数据或网络**。

## 5. 可信安全设计与无法验证的边界

### 可以合理声明

- 私钥/助记词不写明文文件；文件是 ethers V3 + `x-ethers` 密文。
- 密码 KDF 参数有下限/上限；读取前有 JSON/字段/长度校验，避免无界 KDF 内存。
- POSIX 文件模式 0600、目录 0700、逐文件 fsync + 目录 fsync、原子发布（hard-link/rename）。
- 会话短 TTL、锁定/重启失效、permit/capability 绑定 session、敏感导出密码复验、普通 snapshot 不含 secret。
- 主网 56/8453 在代码中硬拒绝；签名与预览分离；没有发送 API；自动充值没有执行器。
- P2P 推荐只拿 `signingFacade()`；导出方法不在该接口中。

### 无法验证/不应声称

- **共享 Bun 宿主可读解密内存**：任何同进程插件/扩展都能在解锁期间读取 HDNodeWallet；capability/facade 不是沙箱。
- **JS 无法保证内存擦除**：GC、堆快照、swap、core dump、崩溃转储可能保留 key；没有 Keychain/TPM/安全 enclave。
- **离线暴力破解**：keystore 被复制后，密码强度决定安全；scrypt 只提高成本，不阻止弱密码。
- **文件系统/OS**：Windows 权限与目录 fsync 未测；磁盘/SSD 安全擦除、备份软件、Time Machine、云同步可能复制旧密文。
- **标准互操作**：`x-ethers` 扩展的助记词保留只验证了 ethers；geth/MetaMask/Rabby 等对 x-ethers 的行为 UNKNOWN。仅私钥的 V3 读取是标准，但本 vault 的 `restore()` 要求 x-ethers mnemonic。
- **真实链**：没有真实 testnet RPC、没有广播、没有 Magpie/EasyTier、没有真实资金；所有签名结果只是本地模拟/离线签名。
- **时序/侧信道**：未做 KDF/签名时序分析；未做故障注入、功耗、冷启动。
- **依赖审计**：只审查了 ethers 的 keystore/BIP39/scrypt 相关源码；没有完整供应链审计，没有正式第三方审计。
- **UI/Service 集成**：尚未实现；导出结果不能进入幂等缓存/日志/普通响应，这需要后续集成审查。

## 6. 与 C-registry / B-core / 外部钱包适配的接口约定

1. **链识别只来自 C-registry**：Service 实现 `WalletChainPolicy.classify(chainId)`，不要在本模块或 UI 复制 56/8453/testnet 清单。vault 自己仍硬拒绝 56/8453，作为第二道门。
2. **prepared/intent 绑定**：typed data 必须经 `prepareTypedData()` 返回的 `PreparedTypedData`；付款必须经 `preparePayment()`。外部钱包适配器应使用同一个 digest/字段集合，不要另造一份付款归属规则或自行计算可签对象。
3. **permit 只在本地创建**：`createSigningPermit()` 不属于 `signingFacade()`。Service 只能在用户明确确认后创建一次性 permit；P2P 消息不能直接产生 permit。
4. **导出只在本地**：完整 `WalletVault` 留在本地 UI/Service；P2P 只拿 facade。`createExportCapability()` 必须在用户点击后调用，导出结果绝不能进入普通响应、幂等缓存、日志或崩溃快照。
5. **主网只读**：56/8453 只允许 `previewTypedData()` 和只读展示；不得调用 `preparePayment`/`sign*`，不得广播，不得自动授信/自动充值。
6. **存储路径**：使用专用目录（建议 `<state-dir>/wallet/keystore.json`），不要放浏览器 storage；Service 停止/重启时调用 `lock()`/`dispose()`；重启后默认 locked。
7. **错误处理**：使用 `WalletVaultError.code` 分类；不要把返回值/错误原文直接回显到 P2P；密码/助记词/私钥永不进日志。
8. **自动充值**：后续执行器只能使用 `validateAutoRechargePolicy()` 校验过的 policy，再创建有 `maxUses/maxPerPaymentWei/maxTotalWei/nonce/expiry` 的 `SigningPermit`；本轮没有执行器。

## 7. 证据标签汇总

| 项 | 标签 |
| --- | --- |
| 文件/分支/基线/版本 | **VERIFIED** |
| BIP39/BIP44/keystore-v3 行为 | **REPRODUCED**（本机临时目录，公开向量） |
| 锁定/TTL/重启/并发/导出/主网拒绝 | **REPRODUCED**（纯模块） |
| ethers 依赖源码审查范围 | **VERIFIED（有限范围）** |
| ethers 整体安全/正式审计 | **UNKNOWN** |
| npm audit 公共 registry 0 known | **REPRODUCED**（快照时点） |
| 真实 Magpie/EasyTier/链/RPC | **UNKNOWN（未运行）** |
| 外部钱包扩展/MetaMask/Rabby | **UNKNOWN（由独立适配模块负责）** |
| Windows/Linux 文件语义 | **UNKNOWN（仅 macOS 实测）** |
| 生产真实资产内置钱包 | **NO-GO** |
| 主网签名/发送/授信/自动充值 | **NO-GO（代码硬拒绝/未实现）** |
| 真实资金 | **NO-GO** |

## 8. 结论

本分支交付的是**可在隔离环境中测试的内置钱包核心能力**：创建/导入 BIP39、同地址恢复、标准 V3 加密、短会话、密码复验的一次性敏感导出、受限模拟/testnet 签名、主网硬拒绝和只读 EIP-712 预览。

它不是生产钱包，也不是安全验收；真实资金、主网发送/授信/自动充值继续 **NO-GO**。下一步应由 Service/UI 集成、C-registry 接线、外部钱包适配和独立安全评审分别接手，且继续保持本地导出与 P2P 窄接口隔离。
