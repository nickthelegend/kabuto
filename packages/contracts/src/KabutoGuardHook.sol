// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam, FrameParam, FrameMode} from "@forshtat/hegota-support/contracts/Params.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// A v4 pool whose swaps require its own price to have been pinned in an EIP-8141 VERIFY frame.
/// The VERIFY frame runs before execution and invalidates the transaction if the pool moves out
/// of the signed band. Every swap through this hook also checks that the pin is present.
///
/// Trust model: the hook does not decide whether the sending account's `verifyPrice` is honest.
/// It does not need to. An honest swapper is protected by its own account (a KabutoAccount whose
/// VERIFY reverts when the price leaves the band). An account with a fake `verifyPrice` only fails
/// to protect itself; it still cannot sandwich an honest swapper, because its front-run moves the
/// price out of the honest swapper's band and that transaction becomes invalid. What the hook adds
/// at the pool level: plain transactions (a typical sandwich bot) cannot swap here at all, the pin
/// must be on this pool, by the sender, earlier in the same transaction and successful, and no
/// swapper may use a band wider than MAX_BAND_BPS.
contract KabutoGuardHook is IHooks, HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    uint16 public immutable MAX_BAND_BPS;

    bytes4 private constant PRICE_SELECTOR = bytes4(keccak256("verifyPrice(bytes32,uint160,uint160)"));
    bytes4 private constant EXECUTION_PRICE_SELECTOR = bytes4(keccak256("verifyPriceExecution(bytes32,uint160,uint160)"));

    error NotPoolManager();
    error NotFrameTx();
    error NoPricePin();
    error BandTooWide();
    error InvalidMaxBand();
    error UnsupportedHook();

    constructor(IPoolManager poolManager_, uint16 maxBandBps_) {
        if (maxBandBps_ == 0 || maxBandBps_ > 10_000) revert InvalidMaxBand();
        poolManager = poolManager_;
        MAX_BAND_BPS = maxBandBps_;
    }

    /// Called through a gas-capped external call so an invalid opcode on a legacy transaction
    /// becomes a catchable failure in beforeSwap rather than an opaque out-of-gas revert.
    function frameContext() external view returns (uint256 txType, address account, uint256 frameCount, uint256 currentFrame) {
        txType = txparam(TxParam.TYPE);
        account = address(uint160(txparam(TxParam.SENDER)));
        frameCount = txparam(TxParam.FRAME_COUNT);
        currentFrame = txparam(TxParam.CURRENT_FRAME_INDEX);
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        address account;
        uint256 currentFrame;
        try this.frameContext{gas: 80_000}() returns (uint256 txType, address senderAccount, uint256 count, uint256 index) {
            if (txType != 6 || senderAccount == address(0) || count == 0 || index >= count) revert NotFrameTx();
            account = senderAccount;
            currentFrame = index;
        } catch {
            revert NotFrameTx();
        }
        PoolId id = key.toId();
        // A later VERIFY frame could check the price only after this swap moves it.
        // A previous failed VERIFY cannot protect a swap either.
        for (uint256 i; i < currentFrame; ++i) {
            if (frameparam(i, FrameParam.MODE) != uint256(FrameMode.VERIFY)) continue;
            if (frameparam(i, FrameParam.STATUS) != 1) continue;
            if (address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != account) continue;
            if (frameparam(i, FrameParam.DATA_LENGTH) != 100) continue;

            bytes memory data = framedatacopy(0, 100, i);
            bytes4 selector = bytes4(data);
            if (selector != PRICE_SELECTOR && selector != EXECUTION_PRICE_SELECTOR) continue;
            if (_word(data, 4) != PoolId.unwrap(id)) continue;

            uint256 minWord = uint256(_word(data, 36));
            uint256 maxWord = uint256(_word(data, 68));
            if (minWord == 0 || maxWord < minWord || maxWord > type(uint160).max) revert BandTooWide();
            // price = sqrtPriceX96² / 2^192. Thus max/min price ratio is
            // (maxSqrt/minSqrt)². For 200 bps this permits at most a 1.02
            // high/low price ratio, roughly a ±1% band around its midpoint.
            if (maxWord >= minWord * 2) revert BandTooWide();
            uint256 highestImpliedPrice = FullMath.mulDivRoundingUp(maxWord, maxWord, minWord);
            uint256 allowed = minWord + FullMath.mulDiv(minWord, MAX_BAND_BPS, 10_000);
            if (highestImpliedPrice > allowed) revert BandTooWide();
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        revert NoPricePin();
    }

    function _word(bytes memory data, uint256 offset) private pure returns (bytes32 word) {
        assembly ("memory-safe") { word := mload(add(add(data, 0x20), offset)) }
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) { revert UnsupportedHook(); }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) { revert UnsupportedHook(); }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure override returns (bytes4) { revert UnsupportedHook(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure override returns (bytes4, BalanceDelta) { revert UnsupportedHook(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure override returns (bytes4) { revert UnsupportedHook(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure override returns (bytes4, BalanceDelta) { revert UnsupportedHook(); }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata) external pure override returns (bytes4, int128) { revert UnsupportedHook(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure override returns (bytes4) { revert UnsupportedHook(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure override returns (bytes4) { revert UnsupportedHook(); }
}
