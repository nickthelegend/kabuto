# Uniswap developer feedback (Kabuto, ETHGlobal Mumbai 2026)

Kabuto builds unsandwichable swaps and open intents on Uniswap v4, on the Ethereum Foundation's EIP-8141 frame-transaction devnet (chain 1337), where v4-core, the Quoter, StateView, the PositionManager, the Universal Router and Permit2 are predeployed from real mainnet bytecode.

## What we used

- **PoolManager** (`0x6bF9…9848` on the devnet): `initialize`, `unlock` + `IUnlockCallback`, `swap`, `modifyLiquidity`, `sync`/`settle`/`take` in our own minimal router (`packages/contracts/src/KabutoRouter.sol`) and in the reference filler (`packages/contracts/src/KabutoFiller.sol`).
- **StateLibrary / `extsload`**: `KabutoAccount.verifyPrice` (`packages/contracts/src/KabutoAccount.sol`) and `KabutoPaymaster.sponsor` read `slot0` straight from the PoolManager inside a transaction's VERIFY frame. This is the core of the project: the price check has to run during validation, before execution, and `extsload` made that a single storage read.
- **V4 Quoter** (`quoteExactInputSingle`): the DEX's quotes, the intent minimums, and the filler's profitability check.
- **StateView** (`getSlot0`): live pool price in the UI and scripts.

## What worked well

- `extsload` + `StateLibrary.getSlot0` is the right primitive for "validate against the pool without executing anything". It is cheap (one SLOAD-equivalent), deterministic, and needs no hook. We pinned a price band in a VERIFY frame under a 100k validation-gas cap with room to spare.
- The flash-accounting model (`unlock` → `swap` → `sync`/`settle`/`take`) made a 120-line router and a filler that swaps tokens it received earlier in the same transaction straightforward.
- Having real v4 bytecode on a research devnet meant we never had to mock Uniswap.

## Friction

1. **No minimal swap router in the official repos.** For a non-hook integration the choices were the Universal Router (command encoding is heavy for a 30-hour build), the v4-core test routers (`PoolSwapTest`, labelled as test code), or writing our own. We wrote our own. A small audited "single-pool exact-in router" in v4-periphery would save most integrators the same hour.
2. **Reading slot0 without a helper contract.** `StateLibrary` is a library, so contracts outside Solidity (or code that wants the raw slot) have to rederive `keccak256(poolId, POOLS_SLOT)` and the bit layout. A documented "storage layout for integrators" page (the `POOLS_SLOT = 6` constant, the `Slot0` packing) would help validation-time and off-chain readers.
3. **Quoter is `nonpayable` and reverts internally.** It works with `eth_call`, but typed clients (viem) treat it as a write. Marking the docs with "call it with simulateContract / eth_call" up front would avoid a common first-time error.
4. **Price-band math.** Every integration that pins a price re-implements "±x% of price → sqrtPriceX96 bounds". A tiny helper in the SDK (`sqrtPriceBand(sqrtPriceX96, bps)`) would prevent off-by-two mistakes (a price band of ±x% is roughly ±x/2% in sqrt space).

## What we would love next

- Hooks have `beforeSwap`; frame transactions add a step **before the transaction exists**. A guide on using `extsload` from account-abstraction validation (EIP-8141 VERIFY frames, ERC-4337 `validateUserOp` with staked entities) would open a new class of "validate against Uniswap state, pay nothing on failure" integrations.
- Official v4 deployments on frame-transaction devnets (as on this one) as Hegotá approaches.
