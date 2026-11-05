// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, TxParam, FrameParam, FrameMode} from "@forshtat/hegota-support/contracts/Params.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// Kabuto paymaster: "the swap pays its own gas".
///
/// It pays an EIP-8141 tx's gas in ETH and is repaid, inside the same tx, in the token the swap produced. Its
/// VERIFY frame only approves payment for this exact shape:
///
///   0 VERIFY  sender   verifyPriceExecution(poolId, min, max)     price pin, execution scope
///   1 VERIFY  this     sponsor(min, max)                          payment scope
///   2 SENDER  tokenIn  approve(router, amountIn)        [atomic]
///   3 SENDER  router   swapExactIn(key, zfo, amountIn, minOut, sender)  [atomic]
///   4 SENDER  tokenOut transfer(this, fee)
///
/// Frames 2-4 are one atomic batch: if the fee transfer fails, the swap rolls back too, and if the swap fails the
/// fee is never owed. The paymaster's risk is a batch that reverts after it agreed to pay, so it rules that out in
/// VERIFY: the pool price is inside the band it was given (EXTSLOAD, needs a staked paymaster), the sender holds
/// amountIn, the swap goes to this pool through this router back to the sender, and the fee is at least the
/// configured amount of the output token. If the price moved, the tx is invalid and nobody pays: the same check
/// that protects the user from a sandwich protects the sponsor from a failed batch.
contract KabutoPaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    address public immutable router;
    address public immutable owner;
    PoolId public immutable poolId;
    address public immutable currency0;
    address public immutable currency1;
    uint256 public immutable fee0; // fee when the output is currency0
    uint256 public immutable fee1; // fee when the output is currency1

    bytes4 private constant APPROVE_SEL = 0x095ea7b3;
    bytes4 private constant TRANSFER_SEL = 0xa9059cbb;
    bytes4 private constant SWAP_SEL = bytes4(keccak256("swapExactIn((address,address,uint24,int24,address),bool,uint256,uint256,address)"));
    bytes4 private constant PIN_SEL = bytes4(keccak256("verifyPriceExecution(bytes32,uint160,uint160)"));

    error BadShape(uint256 code);
    error PriceOutOfBand(uint160 sqrtPriceX96);
    error NotOwner();

    constructor(
        IPoolManager poolManager_, address router_, PoolId poolId_, address currency0_, address currency1_,
        uint256 fee0_, uint256 fee1_
    ) payable {
        poolManager = poolManager_;
        router = router_;
        owner = msg.sender;
        poolId = poolId_;
        currency0 = currency0_;
        currency1 = currency1_;
        fee0 = fee0_;
        fee1 = fee1_;
    }

    receive() external payable {}

    /// Stakes the paymaster itself in the ERC-8421 staking registry (msg.sender of addStake is this contract).
    function stake(address registry, uint32 unstakeDelaySec) external payable {
        if (msg.sender != owner) revert NotOwner();
        (bool ok,) = registry.call{value: msg.value}(abi.encodeWithSignature("addStake(uint32)", unstakeDelaySec));
        require(ok, "stake failed");
    }

    /// Sweeps collected fees (any ERC-20) to the owner.
    function sweep(address token, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        ERC20(token).transfer(owner, amount);
    }

    /// VERIFY entry point (payment scope).
    function sponsor(uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96) external {
        address sender = address(uint160(txparam(TxParam.SENDER)));
        if (txparam(TxParam.FRAME_COUNT) != 5) revert BadShape(1);

        // 0: the sender pins the same pool
        bytes memory d0 = framedatacopy(0, 36, 0);
        if (bytes4(d0) != PIN_SEL || _word(d0, 4) != PoolId.unwrap(poolId)) revert BadShape(2);

        // 2..4: one atomic batch of SENDER frames
        for (uint256 i = 2; i <= 4; i++) {
            if (frameparam(i, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert BadShape(3);
        }
        if (frameparam(2, FrameParam.FLAGS) & 0x4 == 0 || frameparam(3, FrameParam.FLAGS) & 0x4 == 0) revert BadShape(4);

        // 3: swap on this pool through this router, output back to the sender
        if (address(uint160(frameparam(3, FrameParam.RESOLVED_TARGET))) != router) revert BadShape(5);
        bytes memory d3 = framedatacopy(0, 4 + 9 * 32, 3);
        if (bytes4(d3) != SWAP_SEL) revert BadShape(6);
        if (address(uint160(uint256(_word(d3, 4)))) != currency0 || address(uint160(uint256(_word(d3, 36)))) != currency1) revert BadShape(7);
        bool zeroForOne = uint256(_word(d3, 164)) != 0;
        uint256 amountIn = uint256(_word(d3, 196));
        if (address(uint160(uint256(_word(d3, 260)))) != sender) revert BadShape(8);
        (address tokenIn, address tokenOut, uint256 fee) = zeroForOne ? (currency0, currency1, fee1) : (currency1, currency0, fee0);

        // 2: approve of the input token
        if (address(uint160(frameparam(2, FrameParam.RESOLVED_TARGET))) != tokenIn) revert BadShape(9);
        bytes memory d2 = framedatacopy(0, 4, 2);
        if (bytes4(d2) != APPROVE_SEL) revert BadShape(10);

        // 4: the fee, in the output token, to this paymaster
        if (address(uint160(frameparam(4, FrameParam.RESOLVED_TARGET))) != tokenOut) revert BadShape(11);
        bytes memory d4 = framedatacopy(0, 68, 4);
        if (bytes4(d4) != TRANSFER_SEL || address(uint160(uint256(_word(d4, 4)))) != address(this) || uint256(_word(d4, 36)) < fee) {
            revert BadShape(12);
        }

        // the sender can fund the swap (its own balance slot: associated storage)
        if (ERC20(tokenIn).balanceOf(sender) < amountIn) revert BadShape(13);

        // the price is where the sender and the paymaster agreed it would be
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 < minSqrtPriceX96 || sqrtPriceX96 > maxSqrtPriceX96) revert PriceOutOfBand(sqrtPriceX96);

        approve(Scope.PAYMENT);
    }

    function _word(bytes memory b, uint256 offset) private pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), offset))
        }
    }
}
