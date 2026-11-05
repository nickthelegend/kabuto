// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam, TxParam, FrameParam, FrameMode} from "@forshtat/hegota-support/contracts/Params.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
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
    error BadIntentSignature();
    error BadIntentShape(uint256 code);
    error IntentExpired(uint256 deadline);
    error IntentUnderfilled(uint256 received, uint256 required);
    error OnlySelf();

    /// An open intent: "anyone may take up to maxIn of tokenIn from me if, in the same transaction, I end up with at
    /// least the decayed minimum of tokenOut". The minimum decays linearly from startOut (at startTime) to endOut (at
    /// deadline), a Dutch auction enforced by the account itself: fillers fill as soon as it pays them.
    struct Intent {
        address tokenIn;
        uint256 maxIn;
        address tokenOut;
        uint256 startOut;
        uint256 endOut;
        uint64 startTime;
        uint64 deadline;
        uint256 nonce;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "KabutoIntent(uint256 chainId,address account,address tokenIn,uint256 maxIn,address tokenOut,uint256 startOut,uint256 endOut,uint64 startTime,uint64 deadline,uint256 nonce)"
    );
    bytes4 private constant TRANSFER_SEL = 0xa9059cbb;

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

    /// The digest the owner signs (as an explicit 32-byte signature `msg`, not the tx signature hash).
    function intentDigest(Intent memory i) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                INTENT_TYPEHASH, block.chainid, address(this), i.tokenIn, i.maxIn, i.tokenOut, i.startOut, i.endOut,
                i.startTime, i.deadline, i.nonce
            )
        );
    }

    /// VERIFY entry point for an open intent (execution scope; the filler's own VERIFY frame approves payment).
    ///
    /// EIP-8141's security considerations warn that an approval based on an explicit `msg` signature authorizes an
    /// open-ended list of SENDER frames unless validation "constrain[s] every subsequent SENDER frame". This does:
    ///   frame 0       VERIFY  this account (this call)
    ///   frame 1       VERIFY  the filler, payment scope
    ///   frame 2       SENDER  tokenIn.transfer(anyone, amount <= maxIn)          [atomic]
    ///   frames 3..n-2 DEFAULT the filler's own calls (caller is ENTRY_POINT, they cannot act as this account) [atomic]
    ///   frame n-1     SENDER  this.settleIntent(tokenOut, balanceBefore, startOut, endOut, startTime, deadline)
    /// Any other SENDER frame, a missing atomic flag, a value transfer, or a different settle call is rejected, so the
    /// signature cannot be reused with other frames, and the transfer cannot survive a failed settlement.
    function verifyIntent(Intent calldata i) external {
        // the owner signed exactly this intent, as an explicit digest
        if (sigparam(0, SigParam.MSG) != uint256(intentDigest(i))) revert BadIntentSignature();
        _checkSigner();
        if (txparam(TxParam.NONCE) != i.nonce) revert BadIntentShape(1);

        uint256 n = txparam(TxParam.FRAME_COUNT);
        if (n < 4) revert BadIntentShape(2);
        if (frameparam(1, FrameParam.MODE) != uint256(FrameMode.VERIFY)) revert BadIntentShape(3);

        // frame 2: pay tokenIn, at most maxIn
        if (frameparam(2, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert BadIntentShape(4);
        if (address(uint160(frameparam(2, FrameParam.RESOLVED_TARGET))) != i.tokenIn) revert BadIntentShape(5);
        bytes memory d2 = framedatacopy(0, 68, 2);
        if (bytes4(d2) != TRANSFER_SEL || uint256(_word(d2, 36)) > i.maxIn) revert BadIntentShape(6);

        // frames 2..n-2: atomic with the settlement, no value; frames 3..n-2 must be DEFAULT
        for (uint256 f = 2; f < n - 1; f++) {
            if (frameparam(f, FrameParam.FLAGS) & 0x4 == 0) revert BadIntentShape(7);
            if (frameparam(f, FrameParam.VALUE) != 0) revert BadIntentShape(8);
            if (f > 2 && frameparam(f, FrameParam.MODE) != uint256(FrameMode.DEFAULT)) revert BadIntentShape(9);
        }

        // frame n-1: this account settles against the balance it holds right now
        uint256 last = n - 1;
        if (frameparam(last, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert BadIntentShape(10);
        if (address(uint160(frameparam(last, FrameParam.RESOLVED_TARGET))) != address(this)) revert BadIntentShape(11);
        if (frameparam(last, FrameParam.VALUE) != 0) revert BadIntentShape(12);
        uint256 before = ERC20(i.tokenOut).balanceOf(address(this));
        bytes memory expected = abi.encodeCall(
            this.settleIntent, (i.tokenOut, before, i.startOut, i.endOut, i.startTime, i.deadline)
        );
        if (frameparam(last, FrameParam.DATA_LENGTH) != expected.length) revert BadIntentShape(13);
        if (keccak256(framedatacopy(0, expected.length, last)) != keccak256(expected)) revert BadIntentShape(14);

        approve(Scope.EXECUTION);
    }

    /// The last frame of an intent fill: reverts the whole atomic batch unless this account received at least the
    /// Dutch-decayed minimum of tokenOut before the deadline. Only callable by the account itself (a SENDER frame).
    function settleIntent(
        address tokenOut, uint256 balanceBefore, uint256 startOut, uint256 endOut, uint64 startTime, uint64 deadline
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        if (block.timestamp > deadline) revert IntentExpired(deadline);
        uint256 required = decayedMinOut(startOut, endOut, startTime, deadline, block.timestamp);
        uint256 received = ERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        if (received < required) revert IntentUnderfilled(received, required);
    }

    /// Linear Dutch decay from startOut at startTime to endOut at deadline.
    function decayedMinOut(uint256 startOut, uint256 endOut, uint64 startTime, uint64 deadline, uint256 t)
        public
        pure
        returns (uint256)
    {
        if (t <= startTime || deadline <= startTime) return startOut;
        if (t >= deadline) return endOut;
        return startOut - ((startOut - endOut) * (t - startTime)) / (deadline - startTime);
    }

    function _word(bytes memory b, uint256 offset) private pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), offset))
        }
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
