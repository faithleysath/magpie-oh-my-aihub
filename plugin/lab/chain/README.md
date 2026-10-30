# Mock ERC-20 for the chain lab

A deliberately minimal ERC-20 used only by `scripts/chain-lab.ts` and by the
testnet deployments described in `docs/validation/2026-10-30-phase7-multichain-wallet.md`.

It is **not** USDC, USDT or any real token: the symbol is `tMOCK6` / `tMOCK18`,
the name says "Mock", and the registry refuses to register a test asset whose
symbol or name does not say so.

    mise x foundry -- forge build --root plugin/lab/chain
    mise x foundry -- forge create src/MockERC20.sol:MockERC20 \
        --root plugin/lab/chain --rpc-url <rpc> --private-key <key> --broadcast \
        --constructor-args "Mock Test Dollar" tMOCK6 6

`decimals` is set at construction and immutable, so a deployed token cannot
change precision after the registry has verified it.
