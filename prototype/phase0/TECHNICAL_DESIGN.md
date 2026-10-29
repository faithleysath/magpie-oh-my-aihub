# Source-grounded MVP technical design (2026-10-29)

The primary design requirement is *no second intelligent router*. The provider Magpie remains the source of truth for model routing, protocol conversion, streaming, native token counts, gateway keys and quotas. EasyTier is only the overlay; the peer-owned sidecar is only for discovery, payment, external admission and ledgers.

## Source evidence / version boundary

1. Magpie plugin guide: https://usemagpie.ai/docs/plugins. Plugin pages have `connect-src 'none'`, only `magpie.read` (e.g. `providers:list`, `usage:summary`), and `magpie.options`; async gateway hooks are best effort and cannot reliably charge completed streams. The high-permission Bun host does have file/process APIs but is lazily started and shared among plugins; it is **not an authenticated page-to-host bridge**.
2. Magpie gateway source: https://github.com/yetone/magpie/blob/main/internal/gateway/gateway.go. Route declarations include `/v1/models`, Chat Completions, Responses, Messages, quotas and `GET /v1/magpie/usage/requests`. `callerGuard`, `keyLimited`, and `usageRequests` attach to native gateway processing.
3. Remote provider implementation: https://github.com/yetone/magpie/blob/main/internal/provider/remote_magpie.go, https://usemagpie.ai/docs/remote. The native `remote-magpie` provider uses four API protocol bases and remote model metadata; a thin proxy must preserve those routes and headers before claiming full compatibility.
4. Magpie reference: https://github.com/yetone/magpie/blob/main/docs/reference.md. `magpie provider add remote-magpie <key> url=<url> id=<id>` and `magpie provider refresh <id>` work; `magpie gateway-key add`, `models`, `accounts` enforce per-key model exposure. `GET /v1/magpie/usage/requests` filters by caller key. The returned shape and timing must be integration-tested on the pinned Magpie build.
5. EasyTier core CLI: https://github.com/EasyTier/EasyTier/blob/main/easytier/src/core.rs. Actual `port_forward` URLs are parsed into local `bind_addr` and overlay IPv4 `dst_addr`, and `socks5` is supported. This is an *outbound* mapping.
6. EasyTier no-TUN/forward docs: https://easytier.cn/en/guide/network/no-root.html and https://easytier.cn/en/guide/network/port-forward.html. `--no-tun` does not let a local program directly open arbitrary overlay IPs; outbound uses SOCKS5 or `--port-forward tcp://127.0.0.1:localPort/overlayIp:remotePort`. Inbound can be accessed over overlay, but the precise socket binding and per-OS physical interface exposure must be lab-verified with Windows/macOS/Linux.
7. EasyTier Secure Mode: https://easytier.cn/en/guide/network/secure-mode.html. New Secure Mode independently negotiates E2E keys; the older shared network-secret mode does not make the same relay confidentiality guarantee. Pin the bootstrap relay identity.
8. EasyTier peer CLI example: https://github.com/EasyTier/EasytierGame/issues/26, `easytier-cli -v -o json peer`; parse strict versioned fields. Port mappings can be patched through management RPC (`ConfigRpcService/PatchConfig`) in https://easytier.cn/en/guide/network/port-forward.html.
9. Circle official native Base USDC contract list: https://help.circle.com/support/en/usdc-supported-blockchains-minting-redemption-faqs?id=kb_article_view&sysparm_article=KB0010590. Chain 8453, native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; avoid bridged USDbC.
10. Live Base gas tracker on 2026-10-29: https://swiftnodes.io/base-rpc/gas. At sample 0.006 gwei, ~65,000 execution gas => 0.00000039 ETH **without L1 data fees**; this is not the final fee. For all real payments dynamically simulate, estimate gas, quote both components, and read actual receipt.

## Network layout

```
                             Hong Kong VPS
                           [EasyTier Peer ONLY]
                              bootstrap/relay
                             /              \\
  Computer A (provider)    EasyTier Secure Overlay   Computer B (consumer)
  ┌──────────────────────┐                     ┌────────────────────────┐
  │ Magpie gateway       │                     │ Magpie gateway         │
  │ 127.0.0.1:3425       │                     │ 127.0.0.1:3425         │
  │  upstream providers  │                     │ remote-magpie provider │
  │ keys/usage/routing   │                     │ local routing/groups   │
  │ ↑                    │                     │            ↓           │
  │ P2P sidecar ingress  │ ⇐ EasyTier ⇐       │ local loopback mapping │
  │ TCP overlay port     │                     │ 127.0.0.1:<localport>  │
  │ ↑ admission + journal│                     │          ↑             │
  │ wallet/RPC watcher   │                     │ wallet/autopay         │
  └──────────────────────┘                     └────────────────────────┘
```

On **each** peer, EasyTier manages transport and encrypted overlay. The sidecar publishes an explicit list of offered `provider/model` names only, never upstream API keys. Every consumer has a provider-issued Magpie gateway key, restricted to exactly the offered models. The sidecar authenticates this key, associates it with a wallet, checks positive balance (no reservation), forwards to the local Magpie gateway, and asynchronously bills from completed native usage rows. The physical server must not expose its app ingress on untrusted interfaces. Use overlay ACL (`tcp-whitelist` or explicit ACL rules) *plus* OS firewall: overlay ACL alone does not close a physical listening port.

## Discovery without DHT

- `easytier-cli -n <instance> -o json peer`: poll peer list, use `ipv4` where present, ignore malformed/zero virtual IPs.
- Per peer access `http://127.0.0.1:<allocated_port>/p2p/manifest` through a dynamically added `tcp://127.0.0.1:<allocated_port>/<peer-overlay-ip>:38741` mapping. Use one unique local port per peer; EasyTier forbids two mappings with the same bind address. Or route the requests through its local SOCKS5, carefully binding/isolating the unauthenticated SOCKS listener.
- Stable `wallet + EasyTier peer identity + public manifest + signed nonce/expiry` identifies providers independently of ephemeral IPs. Refresh every 15-60 seconds; mark stale and remove on expiry, preserve subscriptions until manually deleted (or pause them).
- Only peer-list enumeration. No mDNS, no DHT, no broadcast protocol.

## Provider add/remove

- Provider issues a unique Magpie gateway key to each buyer (CLI `gateway-key add`, `gateway-key models`). Do not reveal provider's upstream keys.
- Consumer uses `magpie provider add remote-magpie <issued-gateway-key> url=http://127.0.0.1:<consumer-local-port> id=p2p-<provider-short-id>`; `magpie provider refresh <id>` on updates. Native model groups unchanged.
- A single wallet may advertise several offers, but one remote Magpie provider per remote peer suffices. To limit to a single model, provider key allowlist limits `/v1/models` and model usage.
- For unsubscribe, revoke/remove the gateway key and remove only the peer-owned provider using native Magpie CLI; **exact delete syntax needs pinned-version validation**. Prefer Magpie CLI to directly writing `providers.json`.
- Cross-platform CLI invocations must whitelist arguments, never use shell interpolation; never log bearer keys.

## Accounting / pricing invariants

- Money is integer nano-USD; deposit is native USDC amounts (6 decimals) multiplied by 1000. v1 fixes 1 USDC = 1 USD; there is no RMB conversion oracle. UI may show indicative local currency only.
- Provider admission: if `balance > 0` when a call **begins**, allow (concurrent calls each see prior positive balance), no reservations. On finalized Magpie usage row, debit actual tokens, allowing balance to become negative. Next admission rejects if nonpositive.
- Use buyer-specific Magpie gateway key ID to attribute native usage rows to payer and `rid` to deduplicate. This must be validated for partial streams, retries, provider failovers and row persistence on the actual binary before live money.
- Provider price `price_version` is pinned at **request start**, and the ledger stores the tokens and version. A changed advertised price cannot retroactively alter prior accepted requests. The phase-0 code does not yet snapshot price versions.
- Price per million distinct input, output, cache-read, cache-write tokens; if Magpie reports an extra token class or unknown amount, mark `unrated` and review instead of guessing zero.
- Ledger journal unique refs: `deposit:<chain>:<token>:<txhash>:<logIndex>`, `usage:<request-id>`, refunds as independent journal entries.
- On first run, replay chain events from deployment/start block and Magpie usage from a persisted cursor, overlapping a safety window. Unique keys make replays idempotent.
- Never accept consumer-supplied raw token or cost values as authoritative. Prover/signer signs provider's finalized invoice canonical serialization with domain + chain/network + buyer + provider + id + tokens + price version + UTC time + amount + previous receipt digest. Consumer independently checks signature and exported rows; can identify mismatches but **cannot cryptographically prove actual upstream token use** without a trusted upstream attestation.

## Blockchain state machine

`INVOICE_CREATED -> TX_PREPARED -> TX_SENT/UNKNOWN -> RECEIPT_OBSERVED -> CONFIRMED -> CREDITED`, with explicit branches `REPLACED/FAILED/REORGED`. `UNKNOWN` must query local nonce + transaction pool + chain receipts before any new send to prevent double-paying. UNIQUE chain/token/tx/log index prevents double credit. A provider credits only after verifying ERC20 `Transfer` receipt, exact native USDC contract, exact recipient, known sender, amount, finality depth. A wallet sending from a third-party custodial address is **not self-attributing**; require a different invoice or manual reconciliation.

Auto-recharge per recipient has durable `IDLE / ELIGIBLE / PREPARING / SENT / WAIT_CONFIRM / DONE / FAILED_REVIEW` and a unique operation ID. Maximum auto-spend per recipient/day/month, single in-flight transfer, enough ETH for gas, manual first activation, cooldown and explicit unlock are mandatory. Never continuously retry an uncertain broadcast. RPC fail-closed on balance and payment state.

## Wallet

- EVM secp256k1 account generated locally (viem privateKeyToAccount or HD wallet). Prefer OS Keychain/Credential Manager/libsecret for encrypted wrapping. Linux headless fallback encrypted keystore requiring user unlock; no plain private key in plugin settings.
- Separate Ed25519 node signing key is unnecessary in the MVP: sign EIP-191/EIP-712 with wallet account, domain-separate `MagpieP2P`, instance, peer ID, chain ID, offer digest, nonce and expiry. Validate chain ID, freshness and signature locally.
- Backup mnemonic/keystore, recovery dry run and UI warnings; a long-running auto-pay needs a locally unlocked hot-wallet with explicit limits. A hardware wallet alone is not sufficient for unattended signing.
- Base mainnet native USDC (chain 8453) and ETH for gas; test on Base Sepolia first. Use two RPC endpoints and compare block hashes for critical confirmations; public free RPC endpoints are rate-limited.

## App/plugin boundaries

- Magpie page: `magpie.read('providers:list')` can show rows. Sandboxed page cannot directly `fetch` local helper; options are not an RPC channel.
- Best experience needs an upstream `magpie.p2p.call(...)` style permission-scoped bridge backed by a trusted helper, OR opening an external local management UI until such a bridge exists.
- Bun plugin hosts can launch children but are lazily started and may restart; they are not a durable lifecycle guarantee. Package an idempotent helper launcher and EasyTier binary in a signed, OS-specific install bundle; a single-instance lock prevents double running. Start at Magpie app startup only after a supported lifecycle hook is added or an installed per-user launcher runs.
- Version-pin EasyTier and Magpie during integration. Preserve CLI JSON output and flags with smoke tests on Windows/macOS/Linux; do not rely on an unversioned npm postinstall to download EasyTier.

## Privacy

Magpie privacy masking happens on each local gateway before outgoing provider requests, with placeholder restoration on the local return. With nested Magpie requests, the consumer-side masks first and restores last; provider-side masks can apply to the consumer's already-masked body and restores before returning to the consumer. Provider still sees the intermediate request body, and neither user's masking can be assumed to hide all sensitive content. Cross-instance placeholder interactions must be tested; no extra masking engine in the P2P layer.

## Delivery checkpoints

**P0 (the attached code)**: SQLite idempotent ledger, negative balances, provider allowlist, minimal streaming proxy, native plugin page preview. Unit tests pass locally; Magpie and EasyTier E2E tests have **not** been run.

**P1**: Pin EasyTier release, package two EasyTier binaries, peer JSON, no-TUN P2P connectivity, socket exposure audit on 3 OSs, signed manifest.

**P2**: Remote Magpie end-to-end (all native protocol endpoints), gateway key lifecycle, real Magpie usage adapter with deterministic price snapshots, native routing groups unchanged.

**P3**: Wallet init/recovery, Base Sepolia USDC deposit receipt scanner, on-chain mainnet opt-in, durable automatic top-up + retry caps.

**P4**: Authenticated helper-to-page bridge or external UI, address book and audit receipts, installation and power/restart tests.

## Risk acceptance criteria

- Gateway surface blocked from physical LAN/WAN; only intended ports reachable over overlay.
- Hong Kong relay cannot inspect app data in Secure Mode (with pinned relay identity); enforce that all participants use Secure Mode.
- No billing without a finalized, attributable native Magpie usage row; unknown usage is flagged, not made up.
- Battery sleep, process crash, relay failure, RPC outage, transaction reorg and concurrent calls have deterministic behavior; no duplicate top-ups or credits.
- No claim of full one-click installation until the app startup and sandbox bridge constraints are resolved.
