// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {KabutoAccount} from "../src/KabutoAccount.sol";
import {KabutoPaymaster} from "../src/KabutoPaymaster.sol";
import {KabutoFiller} from "../src/KabutoFiller.sol";
import {KabutoRouter} from "../src/KabutoRouter.sol";
import {DevnetToken} from "../src/DevnetToken.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {FrameMode, FrameParam, SigParam, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

// A helper is etched at each CREATE address used by HegotaSupport. Reads come from
// this controller; approve is delegatecalled and emits the scope for assertions.
contract FrameController {
    mapping(bytes32 => uint256) public words;
    mapping(uint256 => bytes) public data;
    function set(uint8 kind, bytes memory args, uint256 value) external { words[keccak256(abi.encode(kind, args))] = value; }
    function setData(uint256 frame, bytes memory value) external { data[frame] = value; }
    function get(uint8 kind, bytes calldata args) external view returns (bytes memory) {
        if (kind == 4) {
            (uint256 offset, uint256 length, uint256 frame) = abi.decode(args, (uint256, uint256, uint256));
            bytes memory source = data[frame];
            bytes memory result = new bytes(length);
            for (uint256 i; i < length && offset + i < source.length; i++) result[i] = source[offset + i];
            return result;
        }
        return abi.encode(words[keccak256(abi.encode(kind, args))]);
    }
}

contract ReadHelper {
    FrameController immutable controller;
    uint8 immutable kind;
    constructor(FrameController c, uint8 k) { controller = c; kind = k; }
    fallback() external payable {
        bytes memory result = controller.get(kind, msg.data);
        assembly { return(add(result, 32), mload(result)) }
    }
}

contract ApproveHelper {
    event Approved(uint256 scope);
    fallback() external payable { emit Approved(abi.decode(msg.data, (uint256))); }
}

contract KabutoTest is Test {
    using PoolIdLibrary for PoolKey;
    IPoolManager manager;
    KabutoRouter router;
    KabutoAccount account;
    KabutoPaymaster paymaster;
    KabutoFiller filler;
    DevnetToken token0;
    DevnetToken token1;
    PoolKey key;
    PoolId id;
    FrameController ctrl;
    address owner = address(0x1111);
    address operator = address(0x2222);
    uint160 constant PRICE = 79228162514264337593543950336;

    function setUp() public {
        // PoolManager has an exact 0.8.26 pragma. This is its real v4-core
        // creation bytecode, compiled separately and checked in beside the test.
        bytes memory creation = abi.encodePacked(vm.parseJsonBytes(vm.readFile("test/PoolManager.creation.json"), ".bytecode.object"), abi.encode(address(this)));
        address deployed;
        assembly { deployed := create(0, add(creation, 32), mload(creation)) }
        require(deployed != address(0), "PoolManager deployment failed");
        manager = IPoolManager(deployed);
        token0 = new DevnetToken("A", "A", 18, 1000 ether);
        token1 = new DevnetToken("B", "B", 18, 1000 ether);
        key = PoolKey(Currency.wrap(address(token0)), Currency.wrap(address(token1)), 3000, 60, IHooks(address(0)));
        id = key.toId();
        manager.initialize(key, PRICE);
        router = new KabutoRouter(manager);
        account = new KabutoAccount(owner, manager);
        paymaster = new KabutoPaymaster(manager, address(router), id, address(token0), address(token1), 10, 20);
        filler = new KabutoFiller(manager, operator);
        ctrl = new FrameController();
        _etch(address(account)); _etch(address(paymaster)); _etch(address(filler));
        _sig(0, SigParam.RESOLVED_SIGNER, uint160(owner));
    }

    function _etch(address target) internal {
        vm.etch(vm.computeCreateAddress(target, 1), address(new ApproveHelper()).code);
        vm.etch(vm.computeCreateAddress(target, 2), address(new ReadHelper(ctrl, 2)).code);
        vm.etch(vm.computeCreateAddress(target, 4), address(new ReadHelper(ctrl, 4)).code);
        vm.etch(vm.computeCreateAddress(target, 5), address(new ReadHelper(ctrl, 5)).code);
        vm.etch(vm.computeCreateAddress(target, 6), address(new ReadHelper(ctrl, 6)).code);
    }
    function _tx(TxParam p, uint256 v) internal { ctrl.set(2, abi.encode(p), v); }
    function _frame(uint256 i, FrameParam p, uint256 v) internal { ctrl.set(5, abi.encode(i, p), v); }
    function _sig(uint256 i, SigParam p, uint256 v) internal { ctrl.set(6, abi.encode(i, p), v); }
    function _data(uint256 i, bytes memory b) internal { ctrl.setData(i, b); _frame(i, FrameParam.DATA_LENGTH, b.length); }
    function _mode(uint256 i, FrameMode m) internal { _frame(i, FrameParam.MODE, uint256(m)); }
    function _target(uint256 i, address a) internal { _frame(i, FrameParam.RESOLVED_TARGET, uint160(a)); }
    function _badIntent(uint256 code) internal { vm.expectRevert(abi.encodeWithSelector(KabutoAccount.BadIntentShape.selector, code)); account.verifyIntent(_intent()); }
    function _intent() internal view returns (KabutoAccount.Intent memory i) {
        i = KabutoAccount.Intent(address(token0), 100, address(token1), 80, 40, 100, 200, 7);
    }
    function _canonicalIntent() internal {
        KabutoAccount.Intent memory i = _intent();
        _sig(0, SigParam.MSG, uint256(account.intentDigest(i))); _tx(TxParam.NONCE, i.nonce); _tx(TxParam.FRAME_COUNT, 5);
        _mode(1, FrameMode.VERIFY);
        _mode(2, FrameMode.SENDER); _target(2, address(token0)); _frame(2, FrameParam.FLAGS, 4);
        _data(2, abi.encodeWithSignature("transfer(address,uint256)", address(filler), 100));
        _mode(3, FrameMode.DEFAULT); _frame(3, FrameParam.FLAGS, 4);
        _mode(4, FrameMode.SENDER); _target(4, address(account));
        _data(4, abi.encodeCall(account.settleIntent, (address(token1), 0, 80, 40, 100, 200)));
    }

    function testAccountSignerAndPrice() public {
        account.verify(); account.verifyPrice(id, PRICE, PRICE); account.verifyPriceExecution(id, PRICE, PRICE);
        _sig(0, SigParam.RESOLVED_SIGNER, uint160(operator));
        vm.expectRevert(abi.encodeWithSelector(KabutoAccount.BadSigner.selector, operator)); account.verify();
        vm.expectRevert(abi.encodeWithSelector(KabutoAccount.BadSigner.selector, operator)); account.verifyPrice(id, 1, PRICE);
        vm.expectRevert(abi.encodeWithSelector(KabutoAccount.BadSigner.selector, operator)); account.verifyPriceExecution(id, 1, PRICE);
        _sig(0, SigParam.RESOLVED_SIGNER, uint160(owner));
        vm.expectPartialRevert(KabutoAccount.PriceOutOfBand.selector); account.verifyPrice(id, PRICE + 1, PRICE + 2);
        vm.expectPartialRevert(KabutoAccount.PriceOutOfBand.selector); account.verifyPriceExecution(id, 1, PRICE - 1);
    }

    function testIntentShapeCodes() public {
        _canonicalIntent(); account.verifyIntent(_intent());
        _sig(0, SigParam.MSG, 0); vm.expectPartialRevert(KabutoAccount.BadIntentSignature.selector); account.verifyIntent(_intent());
        _sig(0, SigParam.MSG, uint256(account.intentDigest(_intent())));
        _sig(0, SigParam.RESOLVED_SIGNER, uint160(operator)); vm.expectPartialRevert(KabutoAccount.BadSigner.selector); account.verifyIntent(_intent());
        _sig(0, SigParam.RESOLVED_SIGNER, uint160(owner));
        _tx(TxParam.NONCE, 8); _badIntent(1); _tx(TxParam.NONCE, 7);
        _tx(TxParam.FRAME_COUNT, 3); _badIntent(2); _tx(TxParam.FRAME_COUNT, 5);
        _mode(1, FrameMode.DEFAULT); _badIntent(3); _mode(1, FrameMode.VERIFY);
        _mode(2, FrameMode.DEFAULT); _badIntent(4); _mode(2, FrameMode.SENDER);
        _target(2, address(token1)); _badIntent(5); _target(2, address(token0));
        _data(2, abi.encodeWithSignature("approve(address,uint256)", address(filler), 100)); _badIntent(6);
        _data(2, abi.encodeWithSignature("transfer(address,uint256)", address(filler), 101)); _badIntent(6);
        _data(2, abi.encodePacked(abi.encodeWithSignature("transfer(address,uint256)", address(filler), 100), bytes1(0))); _badIntent(6);
        _data(2, abi.encodeWithSignature("transfer(address,uint256)", address(filler), 100));
        _frame(2, FrameParam.FLAGS, 0); _badIntent(7); _frame(2, FrameParam.FLAGS, 4);
        _frame(3, FrameParam.FLAGS, 0); _badIntent(7); _frame(3, FrameParam.FLAGS, 4);
        _frame(2, FrameParam.VALUE, 1); _badIntent(8); _frame(2, FrameParam.VALUE, 0);
        _frame(3, FrameParam.VALUE, 1); _badIntent(8); _frame(3, FrameParam.VALUE, 0);
        _mode(3, FrameMode.SENDER); _badIntent(9); _mode(3, FrameMode.DEFAULT);
        _mode(4, FrameMode.DEFAULT); _badIntent(10); _mode(4, FrameMode.SENDER);
        _target(4, address(filler)); _badIntent(11); _target(4, address(account));
        _frame(4, FrameParam.VALUE, 1); _badIntent(12); _frame(4, FrameParam.VALUE, 0);
        _frame(4, FrameParam.DATA_LENGTH, 1); _badIntent(13);
        _data(4, abi.encodeCall(account.settleIntent, (address(token1), 1, 80, 40, 100, 200))); _badIntent(14);
    }

    function testSettleAndDecay() public {
        vm.expectPartialRevert(KabutoAccount.OnlySelf.selector);
        account.settleIntent(address(token1), 0, 80, 40, 100, 200);
        vm.warp(201); vm.prank(address(account)); vm.expectPartialRevert(KabutoAccount.IntentExpired.selector);
        account.settleIntent(address(token1), 0, 80, 40, 100, 200);
        vm.warp(150); vm.prank(address(account)); vm.expectPartialRevert(KabutoAccount.IntentUnderfilled.selector);
        account.settleIntent(address(token1), 0, 80, 40, 100, 200);
        token1.mint(address(account), 60);
        vm.prank(address(account)); account.settleIntent(address(token1), 0, 80, 40, 100, 200);
    }

    function testFuzzDecay(uint64 start, uint64 duration, uint64 step, uint96 hi, uint96 lo) public view {
        duration = uint64(bound(duration, 1, 1_000_000)); start = uint64(bound(start, 0, type(uint64).max - duration));
        hi = uint96(bound(hi, 1, type(uint96).max)); lo = uint96(bound(lo, 0, hi));
        uint256 t1 = uint256(start) + (step % duration);
        uint256 t2 = t1 + (uint256(start) + duration - t1) / 2;
        uint256 a = account.decayedMinOut(hi, lo, start, start + duration, t1);
        uint256 b = account.decayedMinOut(hi, lo, start, start + duration, t2);
        assertGe(a, b); assertLe(a, hi); assertGe(a, lo);
    }

    function testFillerRestrictions() public {
        _sig(1, SigParam.RESOLVED_SIGNER, uint160(operator)); filler.pay();
        _sig(1, SigParam.MSG, 1); vm.expectPartialRevert(KabutoFiller.NotOperator.selector); filler.pay();
        _sig(1, SigParam.MSG, 0); _sig(1, SigParam.RESOLVED_SIGNER, uint160(owner));
        vm.expectPartialRevert(KabutoFiller.NotOperator.selector); filler.pay();
        vm.expectPartialRevert(KabutoFiller.NotEntryPoint.selector); filler.fill(key, true, 1, owner, 1);
        vm.expectPartialRevert(KabutoFiller.NotPoolManager.selector); filler.unlockCallback("");
    }

    function _canonicalPaymaster() internal {
        _tx(TxParam.SENDER, uint160(owner)); _tx(TxParam.FRAME_COUNT, 5);
        _data(0, abi.encodeWithSelector(account.verifyPriceExecution.selector, id, PRICE - 1, PRICE + 1));
        _mode(2, FrameMode.SENDER); _mode(3, FrameMode.SENDER); _mode(4, FrameMode.SENDER);
        _frame(2, FrameParam.FLAGS, 4); _frame(3, FrameParam.FLAGS, 4);
        _target(2, address(token0)); _target(3, address(router)); _target(4, address(token1));
        _data(2, abi.encodeWithSignature("approve(address,uint256)", address(router), 100));
        _data(3, abi.encodeCall(router.swapExactIn, (key, true, 100, 0, owner)));
        _data(4, abi.encodeWithSignature("transfer(address,uint256)", address(paymaster), 20));
        token0.mint(owner, 100);
    }
    function _badPaymaster(uint256 code) internal {
        vm.expectRevert(abi.encodeWithSelector(KabutoPaymaster.BadShape.selector, code));
        paymaster.sponsor(PRICE - 1, PRICE + 1);
    }
    function testPaymasterShapeCodesAndPrice() public {
        _canonicalPaymaster(); paymaster.sponsor(PRICE - 1, PRICE + 1);
        _tx(TxParam.FRAME_COUNT, 4); _badPaymaster(1); _tx(TxParam.FRAME_COUNT, 5);
        _data(0, abi.encodeWithSelector(account.verifyPrice.selector, id, PRICE - 1, PRICE + 1)); _badPaymaster(2);
        _data(0, abi.encodeWithSelector(account.verifyPriceExecution.selector, bytes32(uint256(1)), PRICE - 1, PRICE + 1)); _badPaymaster(2);
        _data(0, abi.encodeWithSelector(account.verifyPriceExecution.selector, id, PRICE - 1, PRICE + 1));
        for (uint256 j = 2; j <= 4; j++) { _mode(j, FrameMode.DEFAULT); _badPaymaster(3); _mode(j, FrameMode.SENDER); }
        _frame(2, FrameParam.FLAGS, 0); _badPaymaster(4); _frame(2, FrameParam.FLAGS, 4);
        _frame(3, FrameParam.FLAGS, 0); _badPaymaster(4); _frame(3, FrameParam.FLAGS, 4);
        _target(3, address(filler)); _badPaymaster(5); _target(3, address(router));
        _data(3, abi.encodeWithSignature("fill()")); _badPaymaster(6);
        _data(3, abi.encodeCall(router.swapExactIn, (key, true, 100, 0, owner)));
        PoolKey memory wrong = key; wrong.currency0 = Currency.wrap(address(filler));
        _data(3, abi.encodeCall(router.swapExactIn, (wrong, true, 100, 0, owner))); _badPaymaster(7);
        wrong = key; wrong.fee = 500;
        _data(3, abi.encodeCall(router.swapExactIn, (wrong, true, 100, 0, owner))); _badPaymaster(7);
        wrong = key; wrong.tickSpacing = 10;
        _data(3, abi.encodeCall(router.swapExactIn, (wrong, true, 100, 0, owner))); _badPaymaster(7);
        wrong = key; wrong.hooks = IHooks(address(filler));
        _data(3, abi.encodeCall(router.swapExactIn, (wrong, true, 100, 0, owner))); _badPaymaster(7);
        _data(3, abi.encodeCall(router.swapExactIn, (key, true, 100, 0, address(filler)))); _badPaymaster(8);
        _data(3, abi.encodeCall(router.swapExactIn, (key, true, 100, 0, owner)));
        _target(2, address(token1)); _badPaymaster(9); _target(2, address(token0));
        _data(2, abi.encodeWithSignature("transfer(address,uint256)", address(router), 100)); _badPaymaster(10);
        _data(2, abi.encodeWithSignature("approve(address,uint256)", address(filler), 100)); _badPaymaster(10);
        _data(2, abi.encodeWithSignature("approve(address,uint256)", address(router), 99)); _badPaymaster(10);
        _data(2, abi.encodeWithSignature("approve(address,uint256)", address(router), 100));
        _target(4, address(token0)); _badPaymaster(11); _target(4, address(token1));
        _data(4, abi.encodeWithSignature("transfer(address,uint256)", address(filler), 20)); _badPaymaster(12);
        _data(4, abi.encodeWithSignature("transfer(address,uint256)", address(paymaster), 19)); _badPaymaster(12);
        _data(4, abi.encodeWithSignature("transfer(address,uint256)", address(paymaster), 20));
        _data(2, abi.encodeWithSignature("approve(address,uint256)", address(router), 101));
        _data(3, abi.encodeCall(router.swapExactIn, (key, true, 101, 0, owner))); _badPaymaster(13);
        _data(2, abi.encodeWithSignature("approve(address,uint256)", address(router), 100));
        _data(3, abi.encodeCall(router.swapExactIn, (key, true, 100, 0, owner)));
        vm.expectPartialRevert(KabutoPaymaster.PriceOutOfBand.selector); paymaster.sponsor(PRICE + 1, PRICE + 2);
    }

    function testPaymasterOwnerStakeSweep() public {
        token1.mint(address(paymaster), 50);
        vm.prank(operator); vm.expectPartialRevert(KabutoPaymaster.NotOwner.selector); paymaster.sweep(address(token1), 1);
        paymaster.sweep(address(token1), 50); assertEq(token1.balanceOf(address(this)), 50);
        vm.deal(operator, 1 ether);
        vm.prank(operator); vm.expectPartialRevert(KabutoPaymaster.NotOwner.selector); paymaster.stake{value: 1}(address(this), 1);
        MockRegistry registry = new MockRegistry();
        paymaster.stake{value: 1}(address(registry), 1); assertEq(address(registry).balance, 1);
    }

    function _liquidity() internal {
        token0.mint(address(this), 2000 ether); token1.mint(address(this), 2000 ether);
        token0.approve(address(router), type(uint256).max); token1.approve(address(router), type(uint256).max);
        router.modifyLiquidity(key, -887220, 887220, 1000 ether, bytes32(0));
    }

    function testRouterRealPoolSwapLiquidityAndSlippage() public {
        _liquidity();
        uint256 before = token1.balanceOf(address(this));
        uint256 out = router.swapExactIn(key, true, 1 ether, 1, address(this));
        assertGt(out, 0); assertEq(token1.balanceOf(address(this)) - before, out);
        vm.expectPartialRevert(KabutoRouter.TooLittleReceived.selector);
        router.swapExactIn(key, true, 1 ether, type(uint256).max, address(this));
        router.modifyLiquidity(key, -887220, 887220, -100 ether, bytes32(0));
    }

    function testFillerRealPoolFill() public {
        _liquidity();
        token0.mint(address(filler), 1 ether);
        vm.prank(operator); filler.fill(key, true, 1 ether, owner, 1);
        assertGt(token1.balanceOf(owner), 0);
    }

    function testFuzzIntentRandomFrameMutations(uint16 mask) public {
        _canonicalIntent();
        mask = uint16(bound(mask, 0, 511));
        if ((mask & 1) != 0) _mode(1, FrameMode.DEFAULT);
        if ((mask & 2) != 0) _target(2, address(token1));
        if ((mask & 4) != 0) _frame(2, FrameParam.FLAGS, 0);
        if ((mask & 8) != 0) _frame(3, FrameParam.FLAGS, 0);
        if ((mask & 16) != 0) _mode(3, FrameMode.SENDER);
        if ((mask & 32) != 0) _frame(3, FrameParam.VALUE, 1);
        if ((mask & 64) != 0) _mode(4, FrameMode.DEFAULT);
        if ((mask & 128) != 0) _target(4, address(filler));
        if ((mask & 256) != 0) _data(4, abi.encodeCall(account.settleIntent, (address(token1), 1, 80, 40, 100, 200)));
        if (mask == 0) { account.verifyIntent(_intent()); return; }
        vm.expectPartialRevert(KabutoAccount.BadIntentShape.selector); account.verifyIntent(_intent());
    }
}

contract MockRegistry {
    function addStake(uint32) external payable {}
}
