// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// Reference filler for Kabuto open intents. Anyone can deploy their own and compete.
///
/// In an intent fill it is two things:
///   - the payer: its VERIFY frame approves payment only when the tx carries a second signature from this filler's
///     operator over the full tx signature hash, so nobody else can spend its ETH on gas;
///   - the router: a DEFAULT frame calls fill(), which swaps the tokenIn it just received through Uniswap v4 and pays
///     the intent account; it keeps whatever the swap returns above what it pays out.
contract KabutoFiller is HegotaSupport(Devnet.ERC8421_WORKSHOP), IUnlockCallback {
    IPoolManager public immutable poolManager;
    address public immutable operator;
    address public constant ENTRY_POINT = address(0xaa);

    error NotOperator(address signer);
    error NotEntryPoint();
    error NotPoolManager();
    error Short(uint256 out, uint256 owed);

    event Filled(address indexed account, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, uint256 paid);

    constructor(IPoolManager poolManager_, address operator_) payable {
        poolManager = poolManager_;
        operator = operator_;
    }

    receive() external payable {}

    /// VERIFY entry point, payment scope: signature entry 1 must be the operator over the canonical tx hash.
    function pay() external {
        address signer = address(uint160(sigparam(1, SigParam.RESOLVED_SIGNER)));
        if (signer != operator || sigparam(1, SigParam.MSG) != 0) revert NotOperator(signer);
        approve(Scope.PAYMENT);
    }

    /// DEFAULT frame: swap `amountIn` of the input currency held here and pay `pay` of the output to `account`.
    function fill(PoolKey calldata key, bool zeroForOne, uint256 amountIn, address account, uint256 payOut) external {
        if (msg.sender != ENTRY_POINT && msg.sender != operator) revert NotEntryPoint();
        uint256 out = abi.decode(poolManager.unlock(abi.encode(key, zeroForOne, amountIn)), (uint256));
        if (out < payOut) revert Short(out, payOut);
        address tokenOut = Currency.unwrap(zeroForOne ? key.currency1 : key.currency0);
        ERC20(tokenOut).transfer(account, payOut);
        emit Filled(account, Currency.unwrap(zeroForOne ? key.currency0 : key.currency1), amountIn, tokenOut, out, payOut);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(raw, (PoolKey, bool, uint256));
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency inC, Currency outC) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        uint256 paid = uint256(uint128(-(zeroForOne ? d.amount0() : d.amount1())));
        uint256 out = uint256(uint128(zeroForOne ? d.amount1() : d.amount0()));
        poolManager.sync(inC);
        ERC20(Currency.unwrap(inC)).transfer(address(poolManager), paid);
        poolManager.settle();
        poolManager.take(outC, address(this), out);
        return abi.encode(out);
    }

    /// Operator withdraws profit.
    function sweep(address token, address to, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (token == address(0)) payable(to).transfer(amount);
        else ERC20(token).transfer(to, amount);
    }
}
