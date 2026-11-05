// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// Minimal Uniswap v4 router: exact-input swaps and liquidity for ERC-20 pools, settled inside one unlock.
/// Tokens are pulled from the caller with transferFrom, so the caller approves this router first.
contract KabutoRouter is IUnlockCallback {
    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error TooLittleReceived(uint256 amountOut, uint256 minAmountOut);
    error NativeNotSupported();

    event Swapped(address indexed payer, address indexed recipient, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    enum Action { Swap, Liquidity }

    struct SwapData {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minAmountOut;
    }

    struct LiquidityData {
        address payer;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        bytes memory res = poolManager.unlock(
            abi.encode(Action.Swap, abi.encode(SwapData(msg.sender, recipient, key, zeroForOne, amountIn, minAmountOut)))
        );
        amountOut = abi.decode(res, (uint256));
        emit Swapped(msg.sender, recipient, zeroForOne, amountIn, amountOut);
    }

    function modifyLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)
        external
    {
        poolManager.unlock(
            abi.encode(Action.Liquidity, abi.encode(LiquidityData(msg.sender, key, tickLower, tickUpper, liquidityDelta, salt)))
        );
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory inner) = abi.decode(raw, (Action, bytes));
        if (action == Action.Swap) return _swap(abi.decode(inner, (SwapData)));
        _liquidity(abi.decode(inner, (LiquidityData)));
        return "";
    }

    function _swap(SwapData memory d) internal returns (bytes memory) {
        BalanceDelta delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency inC, Currency outC) = d.zeroForOne ? (d.key.currency0, d.key.currency1) : (d.key.currency1, d.key.currency0);
        int128 inDelta = d.zeroForOne ? delta.amount0() : delta.amount1();
        int128 outDelta = d.zeroForOne ? delta.amount1() : delta.amount0();
        uint256 paid = uint256(uint128(-inDelta));
        uint256 amountOut = uint256(uint128(outDelta));
        if (amountOut < d.minAmountOut) revert TooLittleReceived(amountOut, d.minAmountOut);
        _settle(inC, d.payer, paid);
        poolManager.take(outC, d.recipient, amountOut);
        return abi.encode(amountOut);
    }

    function _liquidity(LiquidityData memory d) internal {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            d.key, ModifyLiquidityParams(d.tickLower, d.tickUpper, d.liquidityDelta, d.salt), ""
        );
        _resolve(d.key.currency0, d.payer, delta.amount0());
        _resolve(d.key.currency1, d.payer, delta.amount1());
    }

    function _resolve(Currency c, address payer, int128 amount) internal {
        if (amount < 0) _settle(c, payer, uint256(uint128(-amount)));
        else if (amount > 0) poolManager.take(c, payer, uint256(uint128(amount)));
    }

    function _settle(Currency c, address payer, uint256 amount) internal {
        if (c.isAddressZero()) revert NativeNotSupported();
        poolManager.sync(c);
        ERC20(Currency.unwrap(c)).transferFrom(payer, address(poolManager), amount);
        poolManager.settle();
    }
}
