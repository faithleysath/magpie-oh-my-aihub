# Architecture decision record — 2026-10-29

## Goal

Private peer-to-peer AI API sharing using **Magpie**, **EasyTier no-TUN** and **on-chain wallet-funded prepaid use**. Provider wallets and balances are independent; no central accounts or business server. Consumers register remote Magpie providers and use native route groups.

## Current decision: Native Gateway Key limits for admission and charging

Assign each consumer a separate provider-owned Gateway Key; restrict models and privileges. After verified stablecoin deposits, increase the cumulative **cost limit** of that Key without resetting consumption. Magpie performs request authentication, pre-request budget enforcement, stream forwarding and native token cost recording. The plugin manages deposits, one-time transaction attribution, adjustments, reconciliation, balance display, limit updates and wallet/payment states.

The prior Phase 0 standalone HTTP admission + pricing proxy duplicates Magpie quota functionality and is **superseded**. Preserve code only as a historical test reference.

### Important uncertainties requiring proof

1. **Remote auth path:** A no-TUN TCP forwarding connection reaching provider Magpie on loopback might be classified as local and bypass caller authentication or cost enforcement. Test unauthenticated, invalid-key and valid-key requests via the overlay; find an ingress route that cannot be reached from the physical LAN/WAN. Only if impossible, consider minimal network/auth adaptation, not a new accounting gateway.
2. **Quota semantics:** Determine precise behavior when cost limit is zero/unset, request exceeds remaining budget, multiple requests run concurrently, and quota windows expire/restart. Do not assume negative balances behave identically to the original desired no-reservation model.
3. **Limit updates:** Verify CLI/API command syntax for the pinned Magpie version, whether changing a window amount preserves used cost, when the update takes effect, precision and ordering.
4. **Pricing:** Confirm native model price estimates, price overrides, cached tokens, price changes that recompute historical usage, and whether sales pricing can be expressed without corrupting the provider's own internal cost reporting.
5. **Usage durability:** Confirm actual request usage API fields and persistence across failure/stream cancellations.
6. **EasyTier inbound reachability:** Distinguish local no-TUN outbound mapping (SOCKS / port-forward) from actual provider ingress and LAN exposure. Verify real socket binds and CLI JSON on Windows/macOS/Linux.
7. **Magpie plugin UI:** Determine whether a scoped, writable UI-to-host bridge exists in installed source. Page sandbox may forbid ordinary fetch.

## Preferred dataflow

Consumer app -> consumer Magpie Remote Magpie -> EasyTier no-TUN mapping -> provider Magpie Gateway Key guard / limit -> provider's native model/routing -> upstream API.

On-chain USDC transfer -> provider's verified receipt watcher -> idempotent deposit event -> update mapped Key's cumulative cost limit -> consumer balance view and reconcilable records.

Do not write a second AI data path unless a test proves strictly necessary.

## Payment invariants (future development)

- Wallet identity signed and bound to Peer ID/service endpoint, not inferred from changing IP.
- Base native USDC (mainnet chain 8453) is the candidate payment asset; testnet-only during development.
- Credit only confirmed ERC-20 Transfer receipt to intended provider, from a registered sender or explicit signed invoice mapping.
- Deposit dedupe key: (chain ID, token contract, transaction hash, log index).
- Durable intent state machine for auto-topups; unknown broadcasts must be reconciled before any retry; spending caps and single outstanding top-up per counterparty.
- No per-request blockchain write and no claim that a signed bill proves actual upstream token usage.
- Quota window rollover and price changes require explicit ledger reconciliation, not blind reset.

## References for independent verification

- https://github.com/yetone/magpie
- https://usemagpie.ai/docs/plugins
- https://github.com/yetone/magpie/blob/main/internal/gateway/key_limit.go
- https://github.com/yetone/magpie/blob/main/internal/budget/budget.go
- https://github.com/yetone/magpie/blob/main/internal/gateway/lan.go
- https://github.com/EasyTier/EasyTier
- https://easytier.cn/en/guide/network/no-root.html
- https://easytier.cn/en/guide/network/port-forward.html

These are reading pointers, not a statement that any unpinned upstream revision has been tested.
