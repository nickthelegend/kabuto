// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// Kabuto: an EIP-8141 smart account whose VERIFY frame can pin a Uniswap v4 pool price.
///
/// A swap tx carries `verifyPrice(poolId, minSqrtPriceX96, maxSqrtPriceX96)` as the data of its VERIFY frame. The
/// frame reads the pool's slot0 from the PoolManager (EXTSLOAD). If the price left the signed band, the frame
/// reverts, so the tx is invalid: it cannot be included, and nobody pays gas for it. A sandwich needs the victim's
/// tx to land after the front-run moved the price; with Kabuto that tx no longer exists.
///
/// Reading the PoolManager's storage is outside the account's own storage, so the canonical mempool rejects it.
/// The account stakes in the ERC-8421 staking registry, and the standard alt-mempool then admits it.
///
/// The bounds sit in the VERIFY frame's data, which the signature hash covers: nobody can widen them.
contract KabutoAccount is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    using StateLibrary for IPoolManager;

    address public immutable owner;
    IPoolManager public immutable poolManager;

    error BadSigner(address signer);
    error PriceOutOfBand(uint160 sqrtPriceX96, uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96);

    constructor(address owner_, IPoolManager poolManager_) payable {
        owner = owner_;
        poolManager = poolManager_;
    }

    /// Lets the account receive ETH (e.g. from WETH withdrawals). Never used as a VERIFY entry point.
    receive() external payable {}

    /// VERIFY entry point without a price pin: owner signature only.
    function verify() external {
        _checkSigner();
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// VERIFY entry point with a price pin: owner signature, and the pool's current sqrt price inside the band.
    function verifyPrice(PoolId poolId, uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96) external {
        _checkSigner();
        _checkPrice(poolId, minSqrtPriceX96, maxSqrtPriceX96);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// VERIFY entry point for a sponsored tx: execution only, a paymaster's VERIFY frame approves payment.
    function verifyPriceExecution(PoolId poolId, uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96) external {
        _checkSigner();
        _checkPrice(poolId, minSqrtPriceX96, maxSqrtPriceX96);
        approve(Scope.EXECUTION);
    }

    function _checkSigner() internal view {
        address signer = address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER)));
        if (signer != owner) revert BadSigner(signer);
    }

    function _checkPrice(PoolId poolId, uint160 minSqrtPriceX96, uint160 maxSqrtPriceX96) internal view {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 < minSqrtPriceX96 || sqrtPriceX96 > maxSqrtPriceX96) {
            revert PriceOutOfBand(sqrtPriceX96, minSqrtPriceX96, maxSqrtPriceX96);
        }
    }
}
