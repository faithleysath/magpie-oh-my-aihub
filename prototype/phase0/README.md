# Magpie P2P market — Phase 0 runnable slice (not the finished plugin)

This is intentionally a **working development slice**, not a full economic network. It demonstrates the provider's SQLite journal, positive-balance admission, negative-after-completion accounting, duplicate payment/usage suppression, and a streaming HTTP bridge into a **real local Magpie**. It contains a **native Magpie page preview** that illustrates the current read-only UI bridge restriction.

**Not yet implemented**: actual EasyTier process management, overlay peer enumeration, chain RPC receipt verification, wallet generation, secure auto-pay, automatic Magpie usage-row normalizer, full Remote Magpie compatibility (non-chat APIs / all metadata endpoints), true one-click marketplace UI and cross-platform packaging. Never use `dev-credit` for real balances.

## Local setup

```bash
python -m venv .venv
. .venv/bin/activate          # On Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
pytest -q
```

Enable a real Magpie gateway listening on `127.0.0.1:3425`, create a dedicated **valid** gateway key for a test consumer, and record its ID from `magpie gateway-key list`. Configure provider-side model restrictions with `magpie gateway-key models <id> <provider/model>`. (The caller-key ID printed by your Magpie version must be used for later usage import.)

```bash
export P2P_DB="$PWD/ledger.sqlite"
export P2P_WALLET="0xYourProviderWalletAddress"
export P2P_OFFERS='{"anthropic/claude-sonnet-4-6":{"input":"3","output":"15"}}'
python -m p2pshare.admin register 0x1111111111111111111111111111111111111111 caller-1 'sk-magpie-key-for-consumer'
python -m p2pshare.admin dev-credit 0x1111111111111111111111111111111111111111 0xTESTTX01 1.00
python -m uvicorn p2pshare.server:app --host 127.0.0.1 --port 38741
```

Run `curl -H 'Authorization: Bearer sk-magpie-key-for-consumer' http://127.0.0.1:38741/v1/models`. This adapter forwards to the local Magpie and retains streaming replies. For the real overlay, bind the sidecar on a controlled interface and ensure the **OS firewall** or ingress isolation forbids physical LAN / WAN access, while permitting overlay traffic. Do not just blindly bind `0.0.0.0` on a public computer.

## Local accounting demonstration

```bash
python -m p2pshare.admin charge 0x1111111111111111111111111111111111111111 request-A 1.10
python -m p2pshare.admin balance 0x1111111111111111111111111111111111111111
# negative balance; later calls refused with HTTP 402
```

The code does NOT bill automatically. The source-of-truth Magpie usage API is `GET /v1/magpie/usage/requests`. A version-specific adapter must normalize each finalized request to `usage-normalized.example.json` from the provider's trusted local API. The test importer uses:

```bash
python -m p2pshare.admin import-normalized usage-normalized.example.json offers.example.json
```

The transaction store has a unique `(chain_id, token, tx_hash, log_index)` key. **A real watcher must first verify** ERC-20 Transfer receipt token address, buyer `from`, provider `to`, decimals, confirmation depth, chain ID and finality/reorg before it is allowed to call `confirmed_deposit`. The current `dev-credit` method is a test-only bypass.

## Plugin page preview

```bash
magpie plugin add ./magpie-plugin
```

The page only reads `providers:list`. Magpie page sandboxes have `connect-src 'none'`. A fully interactive embedded marketplace will require a **very small upstream bridge extension** with authenticated local commands and explicit permissions, or an external local UI as a compatibility fallback. The page does not falsely claim it is a working marketplace.

## Technical choices / bounds

- Use Magpie `remote-magpie` provider on consumers as the official integration target; provider-side proxy needs more remote-specific paths in the next stage.
- No rerouting or token retokenization inside this app. Sync the actual Magpie row after completion.
- Every consumer has one Magpie Gateway Key and one wallet mapping. Do not expose Magpie's admin API.
- Balance precision: 1e-9 USD. Price calculation separately accounts for input/output/cache; the **actual Magpie usage field mapping is version specific and must be verified on a real instance**.
- Secure EasyTier Mode and relay key pinning are required for E2E confidentiality across relays.
- Use Base native USDC in the next stage; on mainnet gas is paid in ETH, and receiver funds/transactions must not be simulated.
- Keep the wallet key out of Magpie plugin page and out of peer communications. Implement using OS protected storage + explicit backup/recovery in the later wallet phase.
