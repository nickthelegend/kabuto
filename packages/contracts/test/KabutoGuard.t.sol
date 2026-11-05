// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FrameController, ReadHelper} from "./Kabuto.t.sol";
import {KabutoGuardHook} from "../src/KabutoGuardHook.sol";
import {KabutoRouter} from "../src/KabutoRouter.sol";
import {DevnetToken} from "../src/DevnetToken.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FrameMode, FrameParam, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

contract KabutoGuardTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 constant PRICE = 79228162514264337593543950336;
    address constant ACCOUNT = address(0xA11CE);
    address constant HOOK_ADDRESS = address(0x80); // only BEFORE_SWAP among v4's low 14 bits

    IPoolManager manager;
    KabutoRouter router;
    KabutoGuardHook hook;
    DevnetToken token0;
    DevnetToken token1;
    PoolKey key;
    PoolId id;
    FrameController ctrl;

    function setUp() public {
        bytes memory creation = abi.encodePacked(
            vm.parseJsonBytes(vm.readFile("test/PoolManager.creation.json"), ".bytecode.object"), abi.encode(address(this))
        );
        address deployed;
        assembly { deployed := create(0, add(creation, 32), mload(creation)) }
        require(deployed != address(0), "PoolManager deployment failed");
        manager = IPoolManager(deployed);

        KabutoGuardHook implementation = new KabutoGuardHook(manager, 200);
        vm.etch(HOOK_ADDRESS, address(implementation).code);
        hook = KabutoGuardHook(HOOK_ADDRESS);
        ctrl = new FrameController();
        vm.etch(vm.computeCreateAddress(address(implementation), 2), address(new ReadHelper(ctrl, 2)).code);
        vm.etch(vm.computeCreateAddress(address(implementation), 4), address(new ReadHelper(ctrl, 4)).code);
        vm.etch(vm.computeCreateAddress(address(implementation), 5), address(new ReadHelper(ctrl, 5)).code);

        token0 = new DevnetToken("A", "A", 18, 1000 ether);
        token1 = new DevnetToken("B", "B", 18, 1000 ether);
        if (address(token0) > address(token1)) (token0, token1) = (token1, token0);
        key = PoolKey(Currency.wrap(address(token0)), Currency.wrap(address(token1)), 3000, 60, IHooks(HOOK_ADDRESS));
        id = key.toId();
        manager.initialize(key, PRICE);
        router = new KabutoRouter(manager);
        token0.mint(address(this), 2_000 ether);
        token1.mint(address(this), 2_000 ether);
        token0.approve(address(router), type(uint256).max);
        token1.approve(address(router), type(uint256).max);
        router.modifyLiquidity(key, -887220, 887220, 1_000 ether, bytes32(0));

        _tx(TxParam.TYPE, 6);
        _tx(TxParam.SENDER, uint160(ACCOUNT));
        _tx(TxParam.FRAME_COUNT, 3);
        _tx(TxParam.CURRENT_FRAME_INDEX, 2);
        _pin(id, PRICE - PRICE / 250, PRICE + PRICE / 250);
    }

    function _tx(TxParam p, uint256 value) internal { ctrl.set(2, abi.encode(p), value); }
    function _frame(uint256 i, FrameParam p, uint256 value) internal { ctrl.set(5, abi.encode(i, p), value); }
    function _pin(PoolId pool, uint160 min, uint160 max) internal {
        _frame(0, FrameParam.MODE, uint256(FrameMode.VERIFY));
        _frame(0, FrameParam.STATUS, 1);
        _frame(0, FrameParam.RESOLVED_TARGET, uint160(ACCOUNT));
        bytes memory data = abi.encodeWithSignature("verifyPrice(bytes32,uint160,uint160)", PoolId.unwrap(pool), min, max);
        ctrl.setData(0, data);
        _frame(0, FrameParam.DATA_LENGTH, data.length);
    }
    function _direct() internal {
        vm.prank(address(manager));
        hook.beforeSwap(address(router), key, SwapParams(true, -1 ether, PRICE - 1), "");
    }
    function _swap() internal { router.swapExactIn(key, true, 1 ether, 1, address(this)); }

    function testPinnedFrameSwapSucceeds() public {
        uint256 beforeBalance = token1.balanceOf(address(this));
        _swap();
        assertGt(token1.balanceOf(address(this)), beforeBalance);
    }

    function testNoVerifyPinReverts() public {
        _frame(0, FrameParam.MODE, uint256(FrameMode.DEFAULT));
        vm.expectRevert(KabutoGuardHook.NoPricePin.selector); _direct();
        vm.expectRevert(); _swap();
    }

    function testDifferentPoolPinReverts() public {
        _pin(PoolId.wrap(bytes32(uint256(123))), PRICE - PRICE / 200, PRICE + PRICE / 200);
        vm.expectRevert(KabutoGuardHook.NoPricePin.selector); _direct();
        vm.expectRevert(); _swap();
    }

    function testFuturePinReverts() public {
        _tx(TxParam.CURRENT_FRAME_INDEX, 0);
        vm.expectRevert(KabutoGuardHook.NoPricePin.selector); _direct();
        vm.expectRevert(); _swap();
    }

    function testPriorVerifyFailureReverts() public {
        _frame(0, FrameParam.STATUS, 0);
        vm.expectRevert(KabutoGuardHook.NoPricePin.selector); _direct();
        vm.expectRevert(); _swap();
    }

    function testWideBandReverts() public {
        _pin(id, PRICE - PRICE / 50, PRICE + PRICE / 50);
        vm.expectRevert(KabutoGuardHook.BandTooWide.selector); _direct();
        vm.expectRevert(); _swap();
    }

    function testNonFrameReverts() public {
        _tx(TxParam.TYPE, 0);
        vm.expectRevert(KabutoGuardHook.NotFrameTx.selector); _direct();
        vm.expectRevert(); _swap();
    }

    function testAnyAccountWithItsOwnPinSucceeds() public {
        address other = address(0xB0B);
        _tx(TxParam.SENDER, uint160(other));
        _frame(0, FrameParam.RESOLVED_TARGET, uint160(other));
        vm.prank(address(manager));
        (bytes4 sel,,) = hook.beforeSwap(address(router), key, SwapParams(true, -1 ether, PRICE - 1), "");
        assertEq(sel, IHooks.beforeSwap.selector);
    }

    function testPinOnAnotherAccountReverts() public {
        _tx(TxParam.SENDER, uint160(address(0xB0B)));
        vm.expectRevert(KabutoGuardHook.NoPricePin.selector); _direct();
        vm.expectRevert(); _swap();
    }
}
