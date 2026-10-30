# Phase 9 — browser and business security review

Reviews used GPT-6.1-Sol high subagents plus parent inspection and failing-before/passing-after
regressions. They are source/test reviews, not a third-party security certification. Platform:
macOS26.6.2 arm64, Bun1.4.3; actual browser runs use real Magpie0.1.2171 and its managed Bun1.4.4.

## Boundaries preserved

**VERIFIED source / REPRODUCED tests:** the standalone console binds `127.0.0.1` only and has its
own browser authentication. No cookie authorizes the old Bearer API; browser routes reject Bearer
credentials. Static routes are an exact shipped-asset allowlist, not a filesystem path mapping.
There is no shell-command endpoint, transparent Magpie admin proxy, AI request forwarding or new
balance ledger. Money, Key, identity and network actions reach the existing validated Service,
Wallet, Watcher and Provisioner.

**REPRODUCED tests:** Host includes the exact numeric loopback address and bound port. Origin is
exact, mutating requests require JSON and CSRF, private reads require a non-simple custom header,
and Fetch Metadata rejects cross-site navigations/subresources. No CORS permission is emitted.
Requests are bounded64KiB; state/result/cache/session/ticket capacities are bounded. Errors do not
reflect raw submitted credentials or backend exception text. Sensitive responses are no-store.
CSP loads only local shipped resources and denies framing, inline scripts, objects and forms.

Tickets use32random bytes, expire after2minutes, are consumed once and exist only in host memory.
Browser code removes the fragment before async work. Sessions use independent32-byte identifiers
and CSRF secrets; absolute timeout8h/idle30min, with passive polling unable to renew human idle.
Logout and process restart invalidate sessions. Cookie names are stable per port, preventing old
cookies accumulating across restarts while isolating multiple local profiles; random in-memory
session lookup supplies instance binding. Browser HTTP Secure-cookie behavior was measured,
[including WebKit's rejection on127.0.0.1](phase9-stage1.md).

Alternative-browser pairing is not anonymous authorization. The anonymous requester receives a
public eight-digit comparison code and a256-bit secret held only in page memory. An operator must
confirm the matching code in Magpie. The private pre-auth journal stores only its hash, a bounded
2minute lifetime and a consumed tombstone; approval can survive the official options restart,
but the eventual cookie session belongs to the new host. Durable consumption precedes session
issuance. Corrupt stores and failed writes fail closed. No pairing secret/hash is written to the
native page snapshot.

Key handover is an explicit sensitive action. Its operation UUID is claimed once, concurrent and
later replays return409, and the server keeps a fingerprint/tombstone rather than a secret response
Promise/cache. The browser clears the document/input on close, navigation and session expiry.
Files remain a deliberate private handover; the browser makes no Unix0600 download guarantee.

## Concrete findings fixed during this phase

| Finding | Reproduction | Final behavior |
| --- | --- | --- |
| Constructor failure retained the live host lock | Actual entry fixture threw before cleanup was installed; same-process retry waited | Cleanup and termination guards precede construction; retry releases ownership safely |
| Orphan/waiting host could start after parent exit | Injected parent-death while waiting/starting reached Service startup | Parent-aware lock wait and early signal/orphan guards prevent abandoned startup |
| Crash-left reclaim directory blocked ownership | Dead metadata owner plus abandoned reclaim directory never recovered | Kernel-released SQLite exclusive transaction serializes ownership; atomic hardlink publishes complete metadata, no reclaim directory |
| Replacement browser dialog closed itself | Native queued close event from previous dialog closed the new download dialog | Cleanup checks current dialog is actually closed; async-event regression and actual file journey pass |
| Existing connection bypassed first catalogue trust | Manual addProvider followed by first discovery yielded connected with trust.accepted=false | Persisted explicit acceptance plus exact fingerprint is checked independently of connection status; refresh failures preserve warnings |
| Authorization file understated actual Key models | File A with actual Key A+B registered both models | Exact actual model set is checked before native registration; missing/extra/duplicate entries rejected; unrelated providers retained |
| Old managed consumer could not accept a current quote through UI | Handover required new quote binding but active consumer had no reissue entry | Explicit backend price preview and acceptance/reissue available for active legacy accounts; no silent acceptance |
| Numeric overflow poisoned intent reservation | Huge decimal amount previewed, then uint256/ledger conversion failed after reserved record | Existing conversion bounds checked before preview/reservation; invalid input creates no invoice/journal |
| Statement export/import limits disagreed | A valid36KiB export failed32KiB import | Dedicated48KiB limit on both paths, >40KiB roundtrip tested; oversized documents rejected without truncation |
| RPC replacement reused old measurements | Old public head/finality/scan cache survived endpoint replacement | Cache generations invalidate old results and late completions; durable cursor/history retained |
| Old test clock preceded real credit | After12:00 a fixed12:00 readback became older than actual ledger appliedAt | Test readback records real measurement time; genuinely stale evidence remains refused |

These fixes do not change native cap arithmetic, settled prices, chain finality policies or ledger
credit identifiers. The lock SQLite file contains only coordination state and is not a balance
database. No upstream Magpie or EasyTier source was changed.

## Wallet and approval audit

**VERIFIED / REPRODUCED regressions:** imported requests are bounded, normalized and stored without
keys. Human approval selects a positive executable cap and native priced model subset; current
identity/quote and model price are revalidated inside Service serialization and the existing
per-consumer lock. Auth-file connection checks the recipient node, accepted identity/current
quote and actual model scope, then rechecks after asynchronous probes.

Wallet creation requires an explicit consumer, network, registered test asset, decimal amount and
current preview. Durable request UUID records reserve before creating an invoice; replay returns
the same invoice and a changed payload conflicts. All live pending intents are checked, not only
the latest50. An uncertain reservation blocks new attempts for that consumer rather than inventing
success. EIP-712 documents are reconstructed from stored domain data, with exact wrapper/domain/
chain/token/recipient/amount consistency checks. Signature import cryptographically recovers and
checks the payer, including repeated import. No wallet private key enters the product.

Readback evidence is tied to Key/window/price/quote/models/cap/usage and ledger state before and
after the measurement, expires after60seconds and is invalidated by state changes. Receipt,
finality, ledger application and native cap proof are separate steps. RPC failure is unknown
evidence, not payment failure. Browser account selection never exposes one provider's balances
to unauthenticated peers or consumers.

Optional injected-wallet signing is user-gesture-only: validated document review/consent precedes
`eth_requestAccounts`, exact chain comparison and `eth_signTypedData_v4`. It never automatically
switches chains or sends a transaction. Its injected-provider tests cover rejection/wrong chain/
exact bytes/no pre-gesture account request. Real MetaMask/Rabby extension compatibility remains
**UNKNOWN**; actual acceptance used a separate synthetic external-wallet fixture, clearly marked
local simulation with an unfunded ephemeral key.

## Remaining explicit limits

- A crash after an intent reservation but before its durable result can leave an unknown reservation.
  It stays blocked for manual advanced recovery; no ordinary UI clears an uncertain reservation.
- Browser statement import/export is bounded48KiB. Larger historical statements need advanced
  maintenance; no truncated statement is presented as complete.
- First-enable native auto-open, Windows/Linux desktop launch, ten-minute busy-host retirement and
  SSH tunnel interaction are source/test-covered or documented, not all live-measured.
- Native price lock/overshoot/log-gap/RPC-trust limitations remain. Self-signed TOFU is continuity
  of a key, not real-world identity. Real-money Production remains **NO-GO**.

Final credential scans, exact source hashes, final CI and owned-process/port cleanup are recorded
in the final Phase9 acceptance report, after the live lab ends.
