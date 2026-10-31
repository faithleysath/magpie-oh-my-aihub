# Phase 10 A — 网络/服务后端报告（A-service）

> 状态标签：**VERIFIED** = 本次在源码/命令中直接核对；**REPRODUCED** = 本次实际运行并看到结果；**UNKNOWN** = 未测或证据不覆盖；**PROPOSED** = 设计建议。
> 平台：macOS 26.6.2 (25G83)，Darwin 25.6.0，arm64。
> 基线：`origin/main = 8ce5c57f565fb1b835021a9b730b61014eb47d5f`（PR13 已合并）。
> 工作树：`/Users/laysath/.paseo/worktrees/1z728cdk/a-service`；分支 `feature/phase10-a-network`。
> 本分支只改 `plugin/src/{service,state,console-api,easytier}.ts` 与新增 `plugin/src/{network,ports}.ts`、测试、本报告；**不改控制台 UI**。
> 本轮未使用真实加密资产、未连接主网、未改用户安装或用户数据目录。

## 0. 结论摘要

1. **三字段入网已实现**：`join-network` 只接受 `networkName` / `networkSecret` / `initialNode`；角色、监听、RPC/目录/转发端口由插件自动分配；加入即“发现 + 消费”，**不自动分享**。编辑网络时可省略密钥（保留已存值），首次必须提供。**REPRODUCED（隔离单元测试）/ UNKNOWN（0.1.2289 真机 GUI）**
2. **一次“分享这些模型”已实现**：服务端重新读取 Magpie 自己的原生模型与完整有效价格，只接受有价原生模型，然后在一个受监督事务里设置允许清单、发布签名目录、重写 ACL；任一步失败回滚上一份配置并返回真实状态，**不创建 Key、不批准申请、不复刻模型设置**。停止分享是单独的显式动作。**REPRODUCED（隔离单元测试）**
3. **只读网络状态已实现**：`status.network` 给出真实 EasyTier supervisor 状态、实际内核版本、读取时间、peer/route、RTT、直连/中继、online 证据；邻居包含没有目录的普通节点；模型数与授权分开；缺口一律 `null`，不伪造在线；端口只读且带真实 `state`。**REPRODUCED（真实 EasyTier 2.6.4 三节点隔离运行 + 纯投影测试）**
4. **自动端口已实现**：原子 bind 预留 + **OS socket owner 校验（lsof/ss → 必须等于本次活子进程 PID）** + 冲突自动迁移 + 持久账本 + 真实失败态；覆盖 RPC、overlay 监听、Catalog 发布、Catalog 查询 SOCKS5、辅助 Forward；网关/控制台/维护 API 只做只读诊断（网关归 Magpie，插件不改其监听）。**REPRODUCED（真实 EasyTier + 真实 lsof）+ REPRODUCED（Service 级迁移，注入 binder/ownership）**
5. **真实冲突事件**：本次隔离实验中，存储 RPC 端口 `17888` 已被**另一个无关的 Magpie preview EasyTier 核心**占用；直接启动的 supervisor 通过 `127.0.0.1:17888` 读到了**别的核心**的配置并在 ACL 校验时 fail-closed（网络名不符、非分享节点却有 proxy/forward）。这正是 A-service 端口单元要在启动前迁移并验证的原因。**REPRODUCED**（见 §5.3）
6. **未做/未知**：真实 Magpie 0.1.2289 GUI、真实跨主机 NAT/relay、真实目录读取/Remote Magpie 注册、真实 Forward 到远端 Magpie、浏览器验收都不在本分支证据内。**UNKNOWN**。未合并 PR。

## 1. 范围

用户 Phase 10 授权的 A 后端单元（A2/A4/A5/A6/A7 的服务侧）：

- 三字段首次/编辑网络；角色与端口自动；所有节点发现 + 消费。
- 自动检测本机模型，一次明确“分享这些模型”，自动发布目录并开授权路径（Key 仍由人工批准流程产生）。
- 真实网络状态/邻居/端口只读诊断；不把邻居当身份或授权。
- 自动端口：OS 原子 bind/预留或验证受控子进程真正持有监听；稳定持久；冲突自动迁移并更新 Catalog/ACL/forward；真实失败；重启不重置身份/账本。

明确不做：不改 Magpie Gateway 监听配置；不改 no-TUN Forward 安全路径；不新增中心服务；不实现 B 的 P2P 控制服务；不改控制台 UI 视觉；不自动分享/信任/批准/发 Key；不宣布全部 GO。

## 2. 实现

### 2.1 三字段入网 — `join-network`

`plugin/src/service.ts:joinNetwork()` + `plugin/src/console-api.ts`。

| 项 | 行为 |
| --- | --- |
| 输入 | `networkName`、`networkSecret`、`initialNode?`；出现 `role`/端口/`listenAddr` 等字段 → 400 |
| 角色 | `consumingEnabled=true`、`catalog.discoveryEnabled=true`；**不打开 sharing / 不发布目录** |
| 监听 | 首次自动分配 `tcp://0.0.0.0:<11010–11059>` 并持久化；已有则保留 |
| 身份 | 首次生成 `nodeId`/`instanceId`/`secureIdentity`；再次加入、重启均复用；目录身份与账本不重置 |
| 编辑 | `configured=true` 时 `networkSecret` 可省略（保留存储值），`initialNode` 省略保留原 `peers` |
| 失败 | 通过现有 `configure()` 事务回滚上一份配置；返回 500，真实状态从 `status.network` / `config` 读取 |
| 端口 | RPC 由新的端口单元选择（原子预留后释放）；启动前冲突则迁移 |

### 2.2 一次“分享这些模型” — `share-native-models` / `stop-sharing`

`service.ts:shareNativeModels()` / `stopSharing()`。

事务顺序（全部成功才返回成功）：

1. 重新读取 Magpie 原生模型与有效价格（`shareCandidates()`；不复制模型设置，只写 `config.share.models` 允许清单）。
2. 拒绝：非本机原生、`group/*`/`auto/*`、价格不完整、Magpie provider 列表不可读（fail-closed）。
3. 一次性写入：`sharingEnabled=true` + 精确模型集合 + `catalog.enabled=true` + 网关发布端口 + 映射地址 + LAN 导出地址。
4. `applyConfig()`：重写 TOML、受监督重启、目录端口进入 Forward ACL。
5. `applyCatalog()`：启动目录 HTTP（真实 bind；冲突迁移端口并重写 ACL）。
6. `guardSharedKeys()`：按原生/远程划分复检已发放 Key（只收窄/撤销，不放宽）。
7. `publishCatalogNow()`：签名目录发布。
8. 任一步失败：恢复上一份配置并重新应用；返回 500；`config.sharingEnabled` / `catalog.publishing` 反映真实结果。

`stop-sharing`：`sharingEnabled=false` + `catalog.enabled=false`，撤下 ACL Forward 与目录监听；保留模型选择、Key、消费者与账本。

**边界**：分享动作本身不创建 Gateway Key、不批准申请、不改变 Magpie 的模型/Provider 设置；Key 仍由“申请 → 人工选模型 + 正额度 → 批准”产生。

### 2.3 只读网络投影 — `status.network`

`plugin/src/network.ts:projectNetwork()`（纯函数）+ `Service.networkView()/refreshNetwork()`。

- `state`：`unconfigured | starting | online | degraded | offline | failed | unknown`；`summary`、`at`、`evidence{coreVersion, readAt, staleMs, complete, problems}`。
- `core`：`running/pid/version/startedAt/restarts/state/lastError/aclOk`（实际版本来自 `easytier-core --version`）。
- `thisNode`：`nodeId/hostname/virtualIpv4/networkName`（覆盖网地址不是身份证明）。
- `neighbors[]`：EasyTier peer list ∪ 目录发现的普通节点；`latencyMs`、`lossRatePct`、`link(self/direct/relay/unknown)`、`linkBasis`、`relayVia`、`online(boolean|null)`、`tunnel`、`natType`、`catalogNodeId`、`catalogStatus`、`modelsPublished`（仅签名目录）、`modelsAuthorizedForMe`（仅本机 provider 记录）、`relation`、`lastCatalogReadAt`。
- `ports[]`：`purpose/label/host/port/owner/editable:false/reachability/state/verifiedAt/detail`。
- `catalog`：`publishing/address/port/error/modelCount`；`catalogPeers`。

不伪造规则：

- `online:true` 只表示“最近一次成功的 peer 读取里在”；读取失败或核心已停 → `null`，不是 `false`。
- 直连/中继依据 EasyTier 自己的 `cost` 或 route `next_hop_hostname`/`path_len`；无 route 且无 cost → `unknown`。
- `modelsPublished` 只来自签名目录；`modelsAuthorizedForMe` 只来自本机 provider 记录；`relation` 的 `none` 表示“本机没有关联记录”，不是“全网未授权”。
- 邻居永远不显示为“已授权/已验证身份”。

### 2.4 自动端口 — `plugin/src/ports.ts`

**选端口规则**：

- 插件自有监听（Catalog）直接 `Bun.serve` 原子 bind；失败（端口被占）→ 迁移，不“试到成功”。
- 受 EasyTier 核心拥有的端口（RPC、overlay 监听、Catalog SOCKS5、Forward）：先用 `claimFreePort()` 原子 bind 预留，立即释放给真实监听；启动后再验证“受控子进程确实持有监听”。
- 验证规则（`verifyOwnedPort`，v2 修正后）：**不再以“配置自报 + bind 探测”作为持有证明**。由 OS 查询监听 socket 的 PID（macOS `lsof`，Linux `ss` 优先、`lsof` 回退），并要求该 PID 属于本次**活着的**受控进程（EasyTier 核心 pid；插件自有监听则是本进程 pid）：

| 条件 | 结论 |
| --- | --- |
| OS 报出的监听 PID ∈ 期望 PID 集合 | `stable` |
| OS 报出的 PID 全是别人 | `conflict`，拒绝使用并迁移/失败 |
| 声称在听但 OS 报无监听 | `failed` |
| 没有活进程 PID / 没有配置声明 | `unverified` |
| 平台没有 lsof/ss（如 Windows）或查询失败 | `unverified`（**永不 stable**），核心启动直接 fail-closed |

- **启动前**：存储的 RPC / overlay 监听 / Catalog SOCKS5 端口被占 → 先原子预留新端口、写账本、迁移，再启动。
- **启动中**：`waitForRpc()` 在**任何** `easytier-cli` 调用之前先做 OS owner 校验；只有“监听 PID = 刚 spawn 的 pid”才允许读 RPC，且读到的 `instance_id` / `network_name` 必须与本节点配置一致。外人抢到同一端口并返回我们完全相同的配置也会被 PID 校验挡住（负向测试见 §5）。首次启动失败不会进入崩溃重启循环：`startupPending` 期间不安排重启，错误原样返回。
- **Forward**：`addPortForward` 之后、**任何带 Gateway Key 的探针之前**，先证明该 loopback 监听的 PID = 受控核心 PID；否则拒绝、记录 `failed`、不发送 Key（连接与 reconcile 都一样）。`connectProvider` 的无 key 401 探针也在 ownership 之后。
- **持续校验**：每次 `refresh()` 都重新核对 RPC 与 SOCKS5 监听 PID = 本核心 pid；不符/无法查询即记入 `aclProblems`，连续两次 fail-closed 停核心。Service 的 `forwards-owned` 检查同样用 OS PID 验证每个 Forward。

- 迁移前先原子预留新端口，写入 state，记录迁移；随后重写 TOML/ACL/Forward 并受监督重启。迁移用途与目的：
  - `easytier-rpc`（17888–17959）：启动前检测到被占 → 迁移；
  - `catalog`（3426–3460）：bind 报“in use/EADDRINUSE” → 迁移并更新 Forward ACL 与发布端口；
  - `catalog-socks`（13400–13424）：启动前被占 → 迁移；
  - `forward`（13425–13499）：原子选择 + Keyed/wrong-key 实拨验证；失败记录 `failed` 证据，下一次重试自动避开该端口；
  - `overlay-listen`（11010–11059）：首次入网自动分配；重启前发现被占 → 自动迁移并更新 `listenAddr`；
  - `gateway`：归 Magpie，只读诊断，插件**永不**改其监听；
  - `console` / `api`：插件自有回环服务，**已经自动避让**——控制台 `Bun.serve({port: 0})` 由 OS 分配（`console-server.ts:460-470`），维护 API 从 34517 起逐个 `Bun.serve` 绑定并把实际端口写入 `api-port`（`server.ts:89-115`）；两者只做只读诊断，不提供编辑。

**持久化**：`state.json` v4 新增 `ports: {version, migrations[], evidence[]}`（迁移最多 50、证据最多 64；读取时逐项校验，坏数据丢弃而不是信任）。`nodeId/instanceId/secureIdentity/consumer/ledger` 全部保留；v3→v4 迁移沿用现有“先备份再写”的流程。

**失败语义**：验证不通过/迁移失败 → 真实 `failed`/`conflict`/`unverified` 状态；不把“没验证”写成稳定，不把“端口被占”转成“连接别的进程”。`applyConfig()` / `start()` 的 ownership 校验失败会抛出并回滚（或停核心），不再“记日志后继续 online”。

**旧证据不冒充新状态（H1）**：持久账本里的 `stable` 只代表“当时的进程证明过”。Service 构造时把上一进程留下的所有 evidence 改成 `unverified`（detail = not re-proven since this host started），本进程重新验证后才回到 `stable`；`network.ports` 的实时 `failed`/`conflict` 永远优先于账本记录，旧 `stable` 不能遮盖当前失败。console/API 端口只记录、不探测，因此投影为 `unverified`，不再伪造 `stable`。

**平台差异**：Windows 没有 `lsof`/`ss` 时 `verifyOwnedPort` 返回 `unverified`，`waitForRpc` 直接拒绝启动（fail-closed）。这不是“Windows 已支持”，而是明确拒绝把未证明的监听当作自己的；要恢复 Windows 支持必须补原生 socket→PID 查询（未来工作）。

### 2.5 未改动的安全边界

- `renderConfig` 的 `no_tun=true`、Inbound `Drop`、Forward 只放已发布端口、所有 `port_forward` 必须回环：未改。
- Magpie 原生 Gateway 监听、ACL 的 allow-IP 逻辑、Provisioner/账本/钱包语义：未改。
- 控制台会话/配对/CSRF/CSP/动作幂等/敏感响应缓存语义：未改；新增动作仍走同一传输。

## 3. 控制台动作契约（与 A-ui 共同维护）

完整契约：`/tmp/oma-research/A-ACTION-CONTRACT.md`（A-service 起草，已发给 A-ui；UI 侧按此实现，仍在并行验收）。

| 动作 | 请求 | 响应 | 语义 |
| --- | --- | --- | --- |
| `join-network` | `{networkName, networkSecret?, initialNode?}` | `{result: consoleState}` | 三字段；角色/端口/监听自动；不分享；编辑可省略密钥 |
| `share-native-models` | `{models: string[], confirm: true}` | `{result: consoleState}` | 串行事务；guard 先行；只收有价原生模型；目录/quote 必须成功；失败回滚 |
| `stop-sharing` | `{confirm: true}` | `{result: consoleState}` | 撤分享 + 目录；保留选择/Key/记录 |
| `network-refresh` | `{}` | `{result: consoleState}` | 显式刷新 EasyTier + 目录（轮询不含主动探测，≥2s 节流） |

新增只读字段：`status.network`（见 §2.3）；`share-candidates` 追加 `detectedAt`、`source:"magpie-native"`。
**公共入口收紧**：`share-toggle`、`catalog-publish` 已从 `CONSOLE_ACTIONS` 白名单移除（旧 UI 会 404，CLI/维护者 API 不受影响）；控制台 `share-models` 拒绝任何 `*`；控制台 `configure` 拒绝 wildcard，且不能在没有任何精确选择时打开分享。首次 `join-network` 的允许清单是**空集**，不会自动分享当前或未来模型。
错误：400 `{error:"invalid_action_input",message}`；500 `{error:"action_outcome_unknown"}`（不自动重试）；404 `action_not_allowed`；409 `idempotency_conflict`。

A-ui 确认过的三点：编辑网络可省略密钥（已实现）；四个动作都返回 `{result: consoleState}`（传输层统一封装）；分享成功后 `status.catalog.publishing===true` 且 `status.catalog.quote.modelCount` 存在（测试已断言）。

## 4. 真实 EasyTier 2.6.4 证据

### 4.1 方法

- 二进制：`/Users/laysath/Projects/lab/et/easytier-macos-aarch64/{easytier-core,easytier-cli}`，`--version` = `2.6.4-8428a89d`。**VERIFIED**
- 用本仓库真实代码 `EasytierSupervisor.start()/refresh()/peers()/routes()/snapshot()` 启动 3 个隔离节点；每节点独立数据目录、随机测试网络名/密钥、`no_tun=true`、loopback 传输、仅 loopback RPC/SOCKS。
- 拓扑：A(10.77.0.2) ↔ B(10.77.0.3) ↔ C(10.77.0.4)，C 只连 B。A/B/C 的 RPC 27888/27889/27890，SOCKS 13500/13501/13502，listen 31434/31435/31436。
- 脚本：`/tmp/oma-phase10-evidence/{node.ts,run.sh}`（仓库外临时夹具）；每节点每 2s 把真实 `snapshot()` 写入 `snap.json`。

### 4.2 结果（2026-10-31T02:02:57Z–02:02:59Z，本地输出脱敏）

```
node-a running=true core=easytier-core 2.6.4-8428a89d rpc=27888 socks=13500 aclOk=true
  peer ohmyaihub-p10b0002 ipv4=10.77.0.3 cost=p2p    rtt=0.06ms loss=0.0% tunnel=tcp
  peer ohmyaihub-p10c0003 ipv4=10.77.0.4 cost=relay(2) rtt=2.00ms loss=0.0% tunnel=-
  route ohmyaihub-p10b0002 pathLen=1 nextHop=DIRECT
  route ohmyaihub-p10c0003 pathLen=2 nextHop=ohmyaihub-p10b0002
node-c running=true core=easytier-core 2.6.4-8428a89d rpc=27890 socks=13502 aclOk=true
  peer ohmyaihub-p10a0001 ipv4=10.77.0.2 cost=relay(2) rtt=2.00ms loss=0.0% tunnel=-
  route ohmyaihub-p10a0001 pathLen=2 nextHop=ohmyaihub-p10b0002
  peer ohmyaihub-p10b0002 ipv4=10.77.0.3 cost=p2p    rtt=0.10ms
```

真实监听与所有权（`lsof -nP -iTCP:<port> -sTCP:LISTEN`）：

```
easytier- 92585 127.0.0.1:27888     easytier- 92585 127.0.0.1:13500
easytier- 93458 127.0.0.1:27889     easytier- 93458 127.0.0.1:13501
easytier- 93548 127.0.0.1:27890     easytier- 93548 127.0.0.1:13502
```

用本分支 `SocketBinder.verifyOwnedPort()` 对真实进程复验：

```
easytier-rpc 27888 {"state":"stable","inUse":true,"reported":true}
catalog-socks 13500 {"state":"stable","inUse":true,"reported":true}
```

清理：只对本次启动的 3 个 `bun run node.ts` 父进程发 SIGTERM；3 个 `easytier-core` 子进程随后退出；复查 6 个端口无监听。未触碰其它既有 EasyTier 进程。**REPRODUCED**

### 4.3 真实冲突事件（重要的 fail-closed 证据）

第一次尝试把 RPC 固定为 17888 时（本机已有另一个 Magpie preview 的 EasyTier 核心在 17888）：

```
ERROR easytier: Address already in use (os error 48)
ERROR unsafe runtime state (2/2): network name is aihub-alpha, expected <our-test-net>;
  a node that is not sharing must not export a network, found 1 proxy_network entr(ies);
  a node that is not sharing must not allow any forwarded port, found [3425]
ERROR stopping easytier-core: refusing to serve: ...
```

解释：新核心没抢到 RPC，`waitForRpc` 连到了**别人的** 17888 并读到对方配置；ACL 校验发现网络名不符且非分享节点出现 proxy/forward，于是 fail-closed 停核心。**REPRODUCED**。这条证据支持两点：不要 probe-close-bind 后盲目使用端口；启动前必须迁移/启动后必须验证“是我们的子进程持有”。本分支的 `ensureConfiguredPorts()` + `verifyOwnedPort()` 就是对此的实现（Service 级迁移在注入 binder 的测试中复现，见 §5）。

### 4.3b 受控的真实“外部核心占用 RPC”负向实验（修正后）

环境里恰好还有另一个无关的 Magpie preview EasyTier 核心占用 `127.0.0.1:17888`（pid 39806，非本任务进程，只读观察，不触碰）。用修正后的 supervisor 以 `rpcPort=17888` 启动一个自己的真实 `easytier-core`（不同随机测试网络），并用一个“计数包装”的 `easytier-cli` 记录任何 RPC 读取：

```
run.log: ERROR easytier-core exited unexpectedly (code 1)
          ERROR easytier-core exited before its RPC answered on 127.0.0.1:17888
result.json: {"error":"easytier-core exited before its RPC answered on 127.0.0.1:17888","running":false}
cli.calls: 文件不存在（0 次调用）
foreign pid 39806: 实验前后均存活、命令行未变
```

结论：自己的核心抢占失败即退出；`waitForRpc` **没有**向外部核心发出任何 CLI 读取，也没有进入崩溃重启循环，直接以明确错误失败。原始（脱敏）文件保留在 `/tmp/oma-phase10-evidence/foreign/{run.log,result.json}`；`cli.calls` 不存在即零调用。**REPRODUCED**

### 4.4 审查修正后的真实复测（OS owner 必须先于 CLI）

在收到主审“verifyOwnedPort 仅 reported+bind 不可用就 stable、waitForRpc 先 CLI 后校验”的阻断后，本分支新增修正提交（不改写历史，原审 head 保留）：`waitForRpc()` 在**任何** CLI 调用前要求 OS 把 RPC 监听 socket 归属到刚 spawn 的 PID，并要求返回配置的 `instance_id`/`network_name` 一致；`refresh()` 每次复核 RPC/SOCKS5 的监听 PID；Service 的 `forwards-owned` 检查同样按 PID；OS 查询不可用即 fail-closed。

用修正后的真实代码重跑同一三节点隔离实验（2026-10-31T02:15Z，EasyTier 2.6.4-8428a89d）：

```
node-a pid=86611 running=true aclOk=true problems=[] rpc 27888 owner=[86611] match=true socks 13500 owner=[86611] match=true
  peer node-b cost=p2p     rtt=0.67ms tunnel=tcp
  peer node-c cost=relay(2) rtt=2.00ms
  route node-b pathLen=1 nextHop=DIRECT
  route node-c pathLen=2 nextHop=node-b
node-b pid=86880 running=true aclOk=true problems=[] rpc 27889 owner=[86880] match=true socks 13501 owner=[86880] match=true
node-c pid=86946 running=true aclOk=true problems=[] rpc 27890 owner=[86946] match=true socks 13502 owner=[86946] match=true
```

`methods`：`OsSocketOwnership.listenerPids()` 直接调用 `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`；输出与 `snapshot().pid` 逐一比较。三个节点的 `aclProblems` 均为空说明持续校验通过；随后只对本轮 3 个 `bun run node.ts` 父进程发 SIGTERM，复查 6 个端口无监听。**REPRODUCED**（真实 EasyTier + 真实 lsof + 修正后代码）。

注意：`refresh()` 的 aclProblems 为空不是“ACL 网络名相同所以放行”，而是先满足 PID 归属；网络名/`instance_id` 只是第二道校验。

## 5. 测试与本地门禁

只跑**定向**测试；按主调度隔离要求，**没有跑全量 `bun run test`**（已知旧测试会探测本机 LAN:3425 与公共测试网 RPC；P0 记录基线 746 通过/时钟问题另由 PR15 处理）。

| 命令 | 结果 |
| --- | --- |
| `cd plugin && ./node_modules/.bin/tsc --noEmit` | PASS（0 错误，含 test/scripts） |
| `bun test ./test/phase10-network.test.ts ./test/phase10-ports.test.ts` | **28 pass / 0 fail**（123 断言） |
| `bun test ./test/state.test.ts ./test/paths.test.ts ./test/acl.test.ts ./test/forward.test.ts ./test/console-api.test.ts ./test/console-workflows.test.ts ./test/console-security.test.ts` | **100 pass / 0 fail**（2187 断言） |
| `bun run boot-check` | PASS（隔离目录、stub magpie、无网络） |
| `bun run secret-scan` | PASS |

新增测试覆盖（`plugin/test/phase10-*.test.ts`）：

- 三字段入网：自动消费/发现、不分享、监听自动、编辑可省密钥、首次必须密钥、拒绝 role/端口字段、再次加入/重启保持身份与账本。
- 分享事务：confirm 必需、拒绝非原生/无完整价格、成功只发布选中模型、失败回滚并显示真实失败、停止分享保留选择。
- 网络投影：直连/中继/未知（真实字段形状）、无 peer 读取时 `online=null`、邻居不当授权、端口只读、网关标为 Magpie 所有。
- 端口：持久账本校验/容量、原子占用与释放、耗尽范围真实失败、`stable/conflict/failed/unverified`、可达性、真实 socket 持有、RPC 冲突启动前迁移并记账、Catalog bind 冲突迁移并更新 ACL、Forward 失败记录后重试避开、overlay 监听冲突迁移。
- RPC ownership 负向测试（`phase10-rpc-ownership.test.ts`）：外人持有端口且返回**我们的 instance_id** → 不调用 CLI、启动失败；活着的子进程不拥有端口 → 有界等待后失败、零 CLI；自己拥有但 instance_id 不同 → 拒绝；自己拥有且一致 → 接受；OS owner 查询不可用 → fail-closed；首次启动失败只尝试 1 次、不进入重启循环。
- Forward key 门禁（`phase10-network.test.ts`）：外人监听 forward 端口时 `addProvider` 被拒绝、外部监听收到 **0** 个请求；reconcile 在 owner 变foreign 后不再发送 Key。
- 共享事务：首次入网空清单、wildcard 不能从控制台重新开启、`share-toggle`/`catalog-publish` 不在白名单、guard 暂停→回滚、目录非端口错误→回滚。
- 证据新鲜度：持久 `stable` 在重启后变为 `unverified`；实时 `failed` 覆盖旧 `stable`；console/API 不再是伪造 `stable`。

## 6. 状态矩阵

| 项 | 状态 | 范围/证据 |
| --- | --- | --- |
| 三字段服务/控制台动作/状态持久化 | **REPRODUCED** | 隔离单元测试；控制台动作经 `consoleAction` 校验 |
| 一次分享事务（含 ACL/目录/回滚） | **REPRODUCED（模拟 Magpie/EasyTier 子进程接口）** | 注入 probes + 假 supervisor；真实 Magpie 0.1.2289 未跑 |
| 真实 EasyTier supervisor 状态/版本/peer/route/rtt/直连/中继 | **REPRODUCED** | 3 节点隔离；2.6.4-8428a89d |
| 自动端口：原子 bind、OS PID 持有证明、账本、RPC/Catalog/overlay 迁移 | **REPRODUCED** | 真实 EasyTier + 真实 lsof；Service 级迁移用注入 binder/ownership；负向用注入 owner |
| RPC 抢占（返回相同配置）不误用 | **REPRODUCED** | 独立审脚本 `/tmp/oma-phase10-evidence/repro-fixed/race.ts`：B 0.55s 抛 “exited before its RPC answered”；`phase10-rpc-ownership.test.ts` 零 CLI |
| Forward 外占时 Gateway Key 不外泄 | **REPRODUCED** | 独立审脚本复跑 `repro-fixed/forward-capture.ts`：REFUSED，外部监听收到 0 请求，Key observed=false |
| 分享事务：serialize / guard 先行 / 目录失败 | **REPRODUCED** | `share-concurrency` 复跑：仅 1 次 applyConfig 进入；`guard-swallow` 复跑：threw、published=0；本地测试覆盖 |
| 持久 stable 不遮盖新失败 | **REPRODUCED** | 新测试 + 构造时重标 `unverified`；`network.ports` 实时失败优先 |
| Windows 原生 socket→PID | **UNKNOWN / fail-closed** | 无 lsof/ss 时 `unverified`；未实现原生查询 |
| Forward 端口冲突自动迁移 | **VERIFIED（机制）/ UNKNOWN（真实远端）** | 失败证据+重试避让已实现；真实远端 Magpie 未接 |
| 真实跨主机 NAT/relay/目录读取/Remote Magpie 注册 | **UNKNOWN** | 本轮仅 loopback 三节点 |
| 真实 Magpie 0.1.2289 GUI/浏览器 5 页验收 | **UNKNOWN** | 属 A-ui/P0/R2 范围 |
| B 控制 listener 端口机制 | **PROPOSED（已预留）** | `purpose:"control"`、`controlEnabled/controlPort`、`reachability`；未实现服务 |
| 主网/真实资金 | **NO-GO（不在本分支）** | 未触及钱包网络/转账/授信 |

## 7. 与 B-service / B-core / P0 的接口

- **B-service**：沿用 `ports.ts` 的 `claimFreePort()` 与 `verifyOwnedPort({purpose:"control", owner:"plugin", reported:true})`；`status.network.ports[]` 已含 `purpose:"control"` 的枚举。`PluginConfig` 新增 `controlEnabled`（默认 true）与 `controlPort`（默认 null，未分配）。
- **可达性必须真实**：`PortView.reachability` 为 `loopback|overlay|lan|unknown`；若 B 实际绑定 LAN 地址，诊断显示 `host` + `lan`，不得写成 overlay-only。
- **B-core**：新增 4 个动作与 B 的审批/授权/ACK 状态机动作分开命名；A 只提供端口/状态机制，不实现 P2P 控制服务。
- **P0 peak**：未改 `pricing.ts`/结算语义；`shareNativeModels()` 复用现有 `shareCandidates()`，`completePrice=false`（含 P0 的 `unsupportedPrice`）会被拒绝，属于 fail-closed，不复制价格逻辑。K 未改 `state` 版本语义之外的内容；本分支 state v4 保留全部身份/账本字段。

## 8. 复现

```bash
cd /Users/laysath/.paseo/worktrees/1z728cdk/a-service/plugin
bun install --frozen-lockfile
./node_modules/.bin/tsc --noEmit
bun test ./test/phase10-network.test.ts ./test/phase10-ports.test.ts
bun run boot-check && bun run secret-scan
```

真实 EasyTier 证据（仓库外夹具，会启动 3 个隔离核心并自行清理）：

```bash
bash /tmp/oma-phase10-evidence/run.sh
# 读取 /tmp/oma-phase10-evidence/{na,nb,nc}/snap.json；脚本只杀自己启动的 PID
```

### 8.5 独立审复现脚本对新 head 的复跑（synthetic、loopback）

用独立审 `/tmp/oma-repro/*` 的原脚本，仅把 import 指向本工作树，结果保留在 `/tmp/oma-phase10-evidence/repro-fixed/`：

| 脚本 | 旧 head 结果 | 新代码结果 |
| --- | --- | --- |
| `forward-capture.ts` | 外部监听拿到真实 Key | `REFUSED: ... not provably owned ... refusing to send the Gateway Key`；captured requests `[]`；Key observed `false` |
| `race/repro.ts` | B 通过 A 的 RPC“启动成功”，读到 A 的配置 | B `start` 0.55s 抛 `exited before its RPC answered on 127.0.0.1:27933`；未读外部配置 |
| `service-false-stable.ts` | 外占 RPC 仍 `stable`，applyConfig 成功 | `applyConfig` 抛 `the overlay core does not own its listeners: conflict ... (999999)` |
| `share-concurrency.ts` | 两个 share 同时进入 applyConfig | 仅 1 次进入（serialize），另一个等待 |
| `guard-swallow.ts` | guard suspended 仍返回成功 | `threw ... the share guard withdrew sharing`；published=0；sharing=false |

这些是 **SIMULATED**（注入 supervisor / 本地 HTTP 对手），Key 是 synthetic 隔离值，日志只保留脱敏片段。

## 9. 未完成 / 后续

1. 真实 Magpie 0.1.2289 下的 `share-native-models`、目录发布、真实 Forward 到远端 Magpie 与 5 页浏览器验收（A-ui + R2）。
2. Forward 端口在真实冲突下的“自动换端口并重注册 Remote Magpie”目前是“失败记录 + 下次分配避开 + 每次 checks 校验 owner”；完整在线迁移需与 B/C 的真实连接流程一起验收。
2a. Windows 需要原生 socket→PID 查询后才能解除 fail-closed（当前明确不支持，不是静默通过）。
3. B 的 control listener 端口/健康诊断由 B-service 实现；本分支只预留字段与可达性语义。
4. P0 的 peak fail-closed 与 `unsupportedPrice` 合并时，`share-native-models` 的拒绝原因应显示真实字段（当前按 `completePrice=false` 拒绝）。
5. 本分支未合并 PR；等主审指定 commit 后再集成。
