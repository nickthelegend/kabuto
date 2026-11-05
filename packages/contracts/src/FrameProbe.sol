// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam, FrameParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// Tests whether frame introspection survives a call made by a SENDER frame.
contract FrameProbe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    struct Reading {
        uint256 sender;
        uint256 frameCount;
        uint256 currentFrame;
        uint256 resolvedTarget;
        uint256 mode;
    }

    Reading public lastReading;
    bytes public lastFailure;
    bool public lastSucceeded;

    event Observed(uint256 sender, uint256 frameCount, uint256 currentFrame, uint256 resolvedTarget, uint256 mode);
    event Caught(bool succeeded, bytes failure);

    function inspect() external view returns (Reading memory r) {
        r.sender = txparam(TxParam.SENDER);
        r.frameCount = txparam(TxParam.FRAME_COUNT);
        r.currentFrame = txparam(TxParam.CURRENT_FRAME_INDEX);
        r.resolvedTarget = frameparam(r.currentFrame, FrameParam.RESOLVED_TARGET);
        r.mode = frameparam(r.currentFrame, FrameParam.MODE);
    }

    function observe() external {
        Reading memory r = this.inspect();
        lastReading = r;
        lastSucceeded = true;
        delete lastFailure;
        emit Observed(r.sender, r.frameCount, r.currentFrame, r.resolvedTarget, r.mode);
    }

    /// Event-only variant: isolates frame opcode reads from SSTORE state gas.
    function emitReading() external {
        Reading memory r = this.inspect();
        emit Observed(r.sender, r.frameCount, r.currentFrame, r.resolvedTarget, r.mode);
    }

    function emitCaught() external {
        try this.inspect{gas: 80_000}() returns (Reading memory r) {
            emit Observed(r.sender, r.frameCount, r.currentFrame, r.resolvedTarget, r.mode);
            emit Caught(true, "");
        } catch (bytes memory reason) {
            emit Caught(false, reason);
        }
    }

    function observeCaught() external {
        // An unsupported opcode consumes all gas in its call. Cap this nested
        // call so the outer frame can persist the caught failure.
        try this.inspect{gas: 80_000}() returns (Reading memory r) {
            lastReading = r;
            lastSucceeded = true;
            delete lastFailure;
            emit Observed(r.sender, r.frameCount, r.currentFrame, r.resolvedTarget, r.mode);
            emit Caught(true, "");
        } catch (bytes memory reason) {
            lastSucceeded = false;
            lastFailure = reason;
            emit Caught(false, reason);
        }
    }
}
