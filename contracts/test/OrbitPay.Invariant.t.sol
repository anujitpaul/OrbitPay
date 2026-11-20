// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrbitPay} from "../OrbitPay.sol";
import {MockUSDC} from "./OrbitPay.t.sol";

contract OrbitPayHandler is Test {
    OrbitPay public pay;
    MockUSDC public usdc;
    address[] public actors;
    uint256 public ghostPaid;
    uint256 public ghostMinted;
    uint256 public calls;

    constructor(OrbitPay _pay, MockUSDC _usdc) {
        pay = _pay;
        usdc = _usdc;
        for (uint256 i; i < 4; i++) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    function doPay(uint256 payerSeed, uint256 toSeed, uint256 amount, bytes32 memo) external {
        address payer = actors[payerSeed % actors.length];
        // recipient may be any actor (incl. payer / zero / pay / usdc) so reverting paths get exercised too
        address[] memory cands = new address[](7);
        for (uint256 i; i < 4; i++) cands[i] = actors[i];
        cands[4] = address(0);
        cands[5] = address(pay);
        cands[6] = address(usdc);
        address to = cands[toSeed % cands.length];
        amount = bound(amount, 0, 1e12);

        usdc.mint(payer, amount);
        ghostMinted += amount;
        vm.startPrank(payer);
        usdc.approve(address(pay), amount);
        try pay.pay(to, amount, memo) {
            ghostPaid += amount;
            calls++;
        } catch {}
        vm.stopPrank();
    }

    function doDirectDonation(uint256 amount) external {
        // Someone sends USDC straight to a non-pay address; irrelevant to pay's balance
        amount = bound(amount, 0, 1e12);
        usdc.mint(actors[0], amount);
        ghostMinted += amount;
    }

    function sumActors() external view returns (uint256 s) {
        for (uint256 i; i < actors.length; i++) s += usdc.balanceOf(actors[i]);
    }
}

contract OrbitPayInvariantTest is Test {
    MockUSDC internal usdc;
    OrbitPay internal pay;
    OrbitPayHandler internal handler;

    function setUp() public {
        usdc = new MockUSDC();
        pay = new OrbitPay(address(usdc));
        handler = new OrbitPayHandler(pay, usdc);
        targetContract(address(handler));
    }

    /// PROPERTY: OrbitPay never custodies USDC.
    function invariant_OrbitPayUsdcBalanceAlwaysZero() public view {
        assertEq(usdc.balanceOf(address(pay)), 0);
    }

    /// PROPERTY: OrbitPay never holds ETH.
    function invariant_OrbitPayEthBalanceAlwaysZero() public view {
        assertEq(address(pay).balance, 0);
    }

    /// PROPERTY: payments conserve supply — all minted USDC sits with actors (nothing leaks to pay/usdc/zero).
    function invariant_ConservationAcrossActors() public view {
        assertEq(handler.sumActors(), handler.ghostMinted());
        assertEq(usdc.totalSupply(), handler.ghostMinted());
    }
}
