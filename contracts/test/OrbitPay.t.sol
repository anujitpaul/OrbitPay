// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OrbitPay} from "../OrbitPay.sol";

/// @dev Minimal 6-decimal ERC20. `falseMode` makes transfer/transferFrom return false.
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    bool public falseMode;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setFalseMode(bool v) external {
        falseMode = v;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
        emit Transfer(address(0), to, amt);
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        emit Approval(msg.sender, spender, amt);
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        if (falseMode) return false;
        _move(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (falseMode) return false;
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        _move(from, to, amt);
        return true;
    }

    function _move(address from, address to, uint256 amt) internal {
        require(balanceOf[from] >= amt, "balance");
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
    }
}

contract OrbitPayTest is Test {
    event PaymentSent(address indexed from, address indexed to, uint256 amount, bytes32 memo);

    MockUSDC internal usdc;
    OrbitPay internal pay;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant FUNDS = 1_000e6;

    function setUp() public virtual {
        usdc = new MockUSDC();
        pay = new OrbitPay(address(usdc));
        usdc.mint(alice, FUNDS);
        vm.prank(alice);
        usdc.approve(address(pay), type(uint256).max);
    }

    // ---------------- constructor ----------------

    function test_Constructor_StoresUsdc() public view {
        assertEq(address(pay.usdc()), address(usdc));
    }

    function test_Constructor_RevertsOnZeroAddress() public {
        vm.expectRevert(OrbitPay.ZeroUSDCAddress.selector);
        new OrbitPay(address(0));
    }

    function test_Constructor_RevertsOnNoCodeAddress() public {
        vm.expectRevert(abi.encodeWithSelector(OrbitPay.USDCAddressHasNoCode.selector, bob));
        new OrbitPay(bob);
    }

    // ---------------- send happy path ----------------

    function test_Pay_MovesFundsDirectly() public {
        vm.prank(alice);
        pay.pay(bob, 100e6, bytes32(0));
        assertEq(usdc.balanceOf(alice), FUNDS - 100e6);
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(address(pay)), 0);
    }

    function test_Pay_DecreasesAllowance() public {
        vm.prank(alice);
        usdc.approve(address(pay), 500e6);
        vm.prank(alice);
        pay.pay(bob, 120e6, bytes32(0));
        assertEq(usdc.allowance(alice, address(pay)), 380e6);
    }

    function test_Pay_EmitsPaymentSent() public {
        bytes32 memo = keccak256("invoice-1");
        vm.expectEmit(true, true, false, true, address(pay));
        emit PaymentSent(alice, bob, 42e6, memo);
        vm.prank(alice);
        pay.pay(bob, 42e6, memo);
    }

    function test_Pay_EmitsPaymentSentWithZeroMemo() public {
        vm.expectEmit(true, true, false, true, address(pay));
        emit PaymentSent(alice, bob, 1, bytes32(0));
        vm.prank(alice);
        pay.pay(bob, 1, bytes32(0));
    }

    function test_Pay_MemoNonZeroDoesNotAffectTransfer() public {
        vm.prank(alice);
        pay.pay(bob, 10e6, bytes32(uint256(0xdead)));
        assertEq(usdc.balanceOf(bob), 10e6);
        assertEq(usdc.balanceOf(alice), FUNDS - 10e6);
    }

    function test_Pay_EntireBalance() public {
        vm.prank(alice);
        pay.pay(bob, FUNDS, bytes32(0));
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(bob), FUNDS);
    }

    function test_Pay_ToEOAWithNoCodeWorks() public {
        address eoa = address(0xBEEF1234);
        assertEq(eoa.code.length, 0);
        vm.prank(alice);
        pay.pay(eoa, 5e6, bytes32(0));
        assertEq(usdc.balanceOf(eoa), 5e6);
    }

    function test_Pay_MultiplePaymentsAccumulate() public {
        vm.startPrank(alice);
        pay.pay(bob, 1e6, bytes32(0));
        pay.pay(bob, 2e6, bytes32(uint256(1)));
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob), 3e6);
        assertEq(usdc.balanceOf(address(pay)), 0);
    }

    // ---------------- receive side ----------------

    function test_Receive_RecipientBalanceIncreasesWithoutAction() public {
        uint256 before = usdc.balanceOf(bob);
        vm.prank(alice);
        pay.pay(bob, 7e6, bytes32(0));
        assertEq(usdc.balanceOf(bob), before + 7e6);
    }

    function test_Receive_EventFilterableByTo() public {
        address carol = makeAddr("carol");
        bytes32 memoB = bytes32("for-bob");
        bytes32 memoC = bytes32("for-carol");
        vm.recordLogs();
        vm.startPrank(alice);
        pay.pay(bob, 3e6, memoB);
        pay.pay(carol, 4e6, memoC);
        pay.pay(bob, 5e6, bytes32(0));
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PaymentSent(address,address,uint256,bytes32)");
        bytes32 bobTopic = bytes32(uint256(uint160(bob)));
        uint256 matches;
        uint256 total;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(pay) || logs[i].topics[0] != sig) continue;
            if (logs[i].topics[2] == bobTopic) {
                matches++;
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(alice))));
                (uint256 amt, bytes32 memo) = abi.decode(logs[i].data, (uint256, bytes32));
                total += amt;
                if (matches == 1) assertEq(memo, memoB);
            }
        }
        assertEq(matches, 2);
        assertEq(total, 8e6);
    }

    // ---------------- reverts ----------------

    function test_Revert_ZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(OrbitPay.ZeroRecipient.selector);
        pay.pay(address(0), 1e6, bytes32(0));
    }

    function test_Revert_SelfPayment() public {
        vm.prank(alice);
        vm.expectRevert(OrbitPay.SelfPayment.selector);
        pay.pay(alice, 1e6, bytes32(0));
    }

    function test_Revert_RecipientIsOrbitPay() public {
        vm.prank(alice);
        vm.expectRevert(OrbitPay.ContractRecipient.selector);
        pay.pay(address(pay), 1e6, bytes32(0));
    }

    function test_Revert_RecipientIsUsdcToken() public {
        vm.prank(alice);
        vm.expectRevert(OrbitPay.ContractRecipient.selector);
        pay.pay(address(usdc), 1e6, bytes32(0));
    }

    function test_Revert_ZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(OrbitPay.ZeroAmount.selector);
        pay.pay(bob, 0, bytes32(0));
    }

    function test_Revert_ZeroRecipientCheckedBeforeZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(OrbitPay.ZeroRecipient.selector);
        pay.pay(address(0), 0, bytes32(0));
    }

    function test_Revert_InsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(bytes("balance"));
        pay.pay(bob, FUNDS + 1, bytes32(0));
    }

    function test_Revert_InsufficientAllowance() public {
        vm.prank(alice);
        usdc.approve(address(pay), 10e6);
        vm.prank(alice);
        vm.expectRevert(bytes("allowance"));
        pay.pay(bob, 10e6 + 1, bytes32(0));
    }

    function test_Revert_NoAllowanceAtAll() public {
        address dave = makeAddr("dave");
        usdc.mint(dave, 10e6);
        vm.prank(dave);
        vm.expectRevert(bytes("allowance"));
        pay.pay(bob, 1e6, bytes32(0));
    }

    function test_Revert_TokenReturnsFalse() public {
        usdc.setFalseMode(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
        pay.pay(bob, 1e6, bytes32(0));
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_Revert_NoEventOnFailedPayment() public {
        vm.recordLogs();
        vm.prank(alice);
        vm.expectRevert(bytes("balance"));
        pay.pay(bob, FUNDS + 1, bytes32(0));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // ---------------- ETH handling ----------------

    function test_NoEthBalanceAtDeploy() public view {
        assertEq(address(pay).balance, 0);
    }

    function test_RejectsPlainEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(pay).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(pay).balance, 0);
        assertEq(alice.balance, 1 ether);
    }

    function test_RejectsEthWithCalldata() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(pay).call{value: 1 ether}(abi.encodeWithSignature("nonexistent()"));
        assertFalse(ok);
        assertEq(address(pay).balance, 0);
    }

    function test_PayIsNotPayable() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(pay).call{value: 1}(abi.encodeCall(OrbitPay.pay, (bob, 1e6, bytes32(0))));
        assertFalse(ok);
        assertEq(address(pay).balance, 0);
        assertEq(usdc.balanceOf(bob), 0);
    }

    // ---------------- fuzz ----------------

    function testFuzz_Pay(address payer, address to, uint256 amount, bytes32 memo) public {
        vm.assume(payer != address(0) && payer != to);
        vm.assume(to != address(0) && to != address(pay) && to != address(usdc));
        vm.assume(payer != address(pay) && payer != address(usdc));
        vm.assume(uint160(to) > 0xffff && uint160(payer) > 0xffff);
        amount = bound(amount, 1, type(uint128).max);

        usdc.mint(payer, amount);
        vm.prank(payer);
        usdc.approve(address(pay), amount);

        uint256 toBefore = usdc.balanceOf(to);

        vm.expectEmit(true, true, false, true, address(pay));
        emit PaymentSent(payer, to, amount, memo);
        vm.prank(payer);
        pay.pay(to, amount, memo);

        assertEq(usdc.balanceOf(to), toBefore + amount);
        assertEq(usdc.balanceOf(payer), 0);
        assertEq(usdc.allowance(payer, address(pay)), 0);
        assertEq(usdc.balanceOf(address(pay)), 0);
    }

    function testFuzz_PayRevertsWhenAmountExceedsBalance(uint256 extra, bytes32 memo) public {
        extra = bound(extra, 1, type(uint128).max);
        vm.prank(alice);
        vm.expectRevert(bytes("balance"));
        pay.pay(bob, FUNDS + extra, memo);
    }
}
