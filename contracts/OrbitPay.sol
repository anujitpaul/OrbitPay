// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title OrbitPay
/// @notice Non-custodial USDC payments intended for Arc Mainnet (chain ID 5042).
/// @dev Approve this contract on USDC before paying. Payments transfer directly
/// from payer to recipient; this contract does not take custody during payment.
/// Recipients track incoming payments through PaymentSent events filtered by `to`.
contract OrbitPay {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    error ZeroUSDCAddress();
    error USDCAddressHasNoCode(address token);
    error ZeroRecipient();
    error SelfPayment();
    error ContractRecipient();
    error ZeroAmount();

    event PaymentSent(address indexed from, address indexed to, uint256 amount, bytes32 memo);

    /// @param usdcAddress USDC token address. On Arc Mainnet this is
    /// 0x3600000000000000000000000000000000000000 (6 decimals).
    constructor(address usdcAddress) {
        if (usdcAddress == address(0)) revert ZeroUSDCAddress();
        if (usdcAddress.code.length == 0) revert USDCAddressHasNoCode(usdcAddress);
        usdc = IERC20(usdcAddress);
    }

    /// @notice Send USDC directly from your wallet to a recipient.
    /// @dev First approve this contract on USDC for at least `amount`.
    /// Receiving requires no contract call: recipients observe PaymentSent events
    /// indexed by `to`, and receive USDC directly in their wallets.
    /// @param to Recipient, excluding zero, the payer, this contract, and the USDC token itself.
    /// @param amount USDC base units (1 USDC = 1_000_000 on Arc Mainnet).
    /// @param memo Optional payment reference; use bytes32(0) for no reference.
    function pay(address to, uint256 amount, bytes32 memo) external {
        if (to == address(0)) revert ZeroRecipient();
        if (to == msg.sender) revert SelfPayment();
        if (to == address(this) || to == address(usdc)) revert ContractRecipient();
        if (amount == 0) revert ZeroAmount();

        usdc.safeTransferFrom(msg.sender, to, amount);
        emit PaymentSent(msg.sender, to, amount, memo);
    }
}
