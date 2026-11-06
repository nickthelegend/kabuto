# Uniswap developer feedback (Kabuto, ETHGlobal Mumbai 2026)

Kabuto builds unsandwichable swaps and open intents on Uniswap v4, on the Ethereum Foundation's EIP-8141 frame-transaction devnet (chain 1337), where the v4 PoolManager, V4 Quoter, StateView and Permit2 are predeployed (we used the first three; addresses in [`deployments/1337.json`](deployments/1337.json) and the README).

## What we used

- **PoolManager** (`0x6bF9…9848` on the devnet): `initialize`, `unlock` + `IUnlockCallback`, `swap`, `modifyLiquidity`, `sync`/`settle`/`take` in our own minimal router ([`KabutoRouter.sol:48-113`](packages/contracts/src/KabutoRouter.sol#L48)) and in the reference filler ([`KabutoFiller.sol:50-77`](packages/contracts/src/KabutoFiller.sol#L50)).
- **Hooks**: `KabutoGuardHook.beforeSwap` ([`KabutoGuardHook.sol:59`](packages/contracts/src/KabutoGuardHook.sol#L59)), deployed at a CREATE2-mined BEFORE_SWAP address with its own WETH/kUSD pool.
- **StateLibrary / `extsload`**: `KabutoAccount.verifyPrice` (`packages/contracts/src/KabutoAccount.sol`) and `KabutoPaymaster.sponsor` read `slot0` straight from the PoolManager inside a transaction's VERIFY frame ([`KabutoAccount.sol:179`](packages/contracts/src/KabutoAccount.sol#L179), [`KabutoPaymaster.sol:125`](packages/contracts/src/KabutoPaymaster.sol#L125)). This is the core of the project: the price check has to run during validation, before execution, and `extsload` made that a single storage read.
- **V4 Quoter** (`quoteExactInputSingle`): the DEX's quotes, the intent minimums, and the filler's profitability check.
- **StateView** (`getSlot0`): live pool price in the UI and scripts.

## What worked well

- `extsload` + `StateLibrary.getSlot0` is the right primitive for "validate against the pool without executing anything". It is a single storage read, deterministic, and needs no hook. A price pin in a VERIFY frame fits under the devnet's 100k validation-gas cap; the same cap also fits our full intent shape check.
- The flash-accounting model (`unlock` → `swap` → `sync`/`settle`/`take`) made a 115-line router and a filler that swaps tokens it received earlier in the same transaction straightforward.
- Having v4 predeployed on a research devnet meant we never had to mock Uniswap on chain; our Foundry tests deploy a PoolManager compiled from `v4-core` instead of a mock.

## Friction

1. **No minimal swap router in the official repos.** For a non-hook integration the choices were the Universal Router (command encoding is heavy for a 30-hour build), the v4-core test routers (`PoolSwapTest`, labelled as test code), or writing our own. We wrote our own. A small audited "single-pool exact-in router" in v4-periphery would save most integrators the same hour.
2. **Reading slot0 without a helper contract.** `StateLibrary` is a library, so contracts outside Solidity (or code that wants the raw slot) have to rederive `keccak256(poolId, POOLS_SLOT)` and the bit layout. A documented "storage layout for integrators" page (the `POOLS_SLOT = 6` constant, the `Slot0` packing) would help validation-time and off-chain readers.
3. **Quoter is `nonpayable` and reverts internally.** It works with `eth_call`, but typed clients (viem) treat it as a write. Marking the docs with "call it with simulateContract / eth_call" up front would avoid a common first-time error.
4. **Price-band math.** Every integration that pins a price re-implements "±x% of price → sqrtPriceX96 bounds". A tiny helper in the SDK (`sqrtPriceBand(sqrtPriceX96, bps)`) would prevent off-by-two mistakes (a price band of ±x% is roughly ±x/2% in sqrt space).

## A hook that reads the transaction it runs in

`KabutoGuardHook` is a v4 `beforeSwap` hook that inspects the enclosing EIP-8141 frame transaction and only admits swaps whose price was pinned in an earlier VERIFY frame (a pool that cannot be sandwiched; live on the EF devnet). Two v4 notes from building it:
- **Hook errors are wrapped.** A revert in `beforeSwap` surfaces as `WrappedError(hook, selector, reason, details)`; viem's estimate path couldn't decode it ("Failed to convert string_length"). A short docs note on decoding wrapped hook errors client-side would help.
- **Hook address mining.** We mined a CREATE2 salt for the BEFORE_SWAP flag with a ten-line loop; a canonical miner in v4-periphery that doesn't pull in the whole test toolchain would save time.

## What we would love next

- Hooks have `beforeSwap`; frame transactions add a step **before the transaction exists**. A guide on using `extsload` from account-abstraction validation (EIP-8141 VERIFY frames, ERC-4337 `validateUserOp` with staked entities) would open a new class of "validate against Uniswap state, pay nothing on failure" integrations.
- Official v4 deployments on frame-transaction devnets (as on this one) as Hegotá approaches.

## Uniswap Developer Feedback Form: paste-ready answers

Link to paste into the form: https://github.com/nickthelegend/kabuto/blob/main/FEEDBACK.md

- **Project:** Kabuto (ETHGlobal Mumbai 2026), https://github.com/nickthelegend/kabuto, live at https://kabuto-self.vercel.app.
- **What we built with Uniswap:** swaps that are only valid at the price you signed. A frame transaction's VERIFY frame reads the v4 pool's `slot0` with `extsload`; if a sandwich bot moves the price first, the swap is dropped before inclusion and costs nothing. Plus open intents filled through v4, a minimal v4 router and filler, and KabutoGuard, a `beforeSwap` hook that only admits price-pinned frame transactions.
- **Uniswap products used:** v4-core PoolManager (unlock, swap, modifyLiquidity, sync/settle/take, extsload via StateLibrary), hooks (beforeSwap), V4 Quoter, StateView. Not used: Uniswap API, Universal Router, v4-periphery PositionManager, CCA.
- **What worked well:** `extsload` + `StateLibrary.getSlot0` for validation-time reads; flash accounting for a short router and for a filler that swaps tokens it received earlier in the same transaction.
- **Biggest friction:** no minimal audited exact-in router for non-hook integrations; wrapped hook errors (`WrappedError`) that viem's gas estimate couldn't decode; no small canonical hook-address miner; the Quoter is `nonpayable` and must be called with `eth_call` / `simulateContract`.
- **Docs we wished existed:** a storage-layout page for integrators (`POOLS_SLOT`, `Slot0` packing); a `sqrtPriceBand(sqrtPriceX96, bps)` helper; a guide to reading v4 state from account-abstraction validation (EIP-8141 VERIFY, ERC-4337 `validateUserOp` with staked entities).
