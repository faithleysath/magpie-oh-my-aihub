# First local AI assignment: prove native limit-based P2P sharing

**Do not start the wallet implementation or rewrite the router.** Test against the actual installed Magpie and EasyTier binaries, recording full version strings and upstream commit IDs.

## Lab

- Two computers A(provider) and B(consumer), each with Magpie, and one HK VPS running EasyTier Peer only.
- EasyTier **no-TUN**, Secure Mode, one private overlay; isolated test Gateway Keys and a mock or nonbillable upstream model.
- No real money, private keys or public exposure.

## Acceptance tests (record commands, sanitized output and exact versions)

1. On A create 1 dedicated Gateway Key and bind only one test model. Confirm that authentication and quota checking occur for the **same ingress path** B will use.
2. Discover Peer overlay IP via EasyTier CLI, establish no-TUN B->A access using documented local port forwarding/SOCKS. Document all required local/inbound socket listeners and firewall rules, and verify A's other ports are not reachable.
3. With no Authorization / invalid Key / valid Key, call A from B through the overlay. Expected no or invalid key => rejected; valid key => success. If unauthorized requests succeed, stop: do not proceed until the bypass is resolved.
4. Set a small cost limit, issue real or controlled model requests, observe native usage and rejection after quota exhaustion; inspect response codes and cost. Test 1 request consuming more than remaining budget and multiple concurrent requests.
5. Increase the limit using official CLI/native API WITHOUT a reset. Observe used cost preserved and immediate resumed access. Determine how a zero-cost limit differs from disabled/unlimited.
6. Test long quota-window support, expiration/renewal, process restart behavior and changed pricing. Identify a safe rollover strategy.
7. From B create Remote Magpie provider pointed at the no-TUN local forwarded endpoint, verify model discovery, chat streaming and responses/messages APIs as applicable, and test native routing group behavior (no custom routes).
8. Investigate writable Magpie plugin/host bridge availability; identify exact limitations without assuming page has network access.

## Deliverables

- docs/validation/YYYY-MM-DD-local-lab.md with test matrix: command, observed outcome, log excerpt, version, source file/function, PASS/FAIL/UNKNOWN.
- A minimal diagram of actual socket endpoints and how they are restricted to overlay access.
- Final decision: native direct ingress feasible YES/NO; if NO, smallest safe adapter proposal with evidence.
- GitHub PR limited to validation evidence and any minimal reproducible test harness; do not modify architecture spec silently.

Security: redact actual Key values, network passwords, wallet secrets and any user prompts before committing logs.
