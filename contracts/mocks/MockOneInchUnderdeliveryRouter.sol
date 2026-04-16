// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAggregationExecutor, IGenericRouter, SwapDescription } from "../OneInchInterfaces.sol";

/// @notice Malicious 1inch-compatible router for testing balance-delta enforcement.
/// @dev Ignores `minReturnAmount` and returns a fixed amount of destination token.
contract MockOneInchUnderdeliveryRouter is IGenericRouter {
    uint256 public immutable forcedReturnAmount;

    constructor(uint256 _forcedReturnAmount) {
        forcedReturnAmount = _forcedReturnAmount;
    }

    function swap(
        IAggregationExecutor,
        SwapDescription calldata desc,
        bytes calldata
    ) external override returns (uint256 returnAmount, uint256 spentAmount) {
        require(desc.amount > 0, "MockUnderdeliveryRouter: zero amount");

        IERC20(desc.srcToken).transferFrom(msg.sender, address(this), desc.amount);
        spentAmount = desc.amount;

        uint256 balance = IERC20(desc.dstToken).balanceOf(address(this));
        returnAmount = forcedReturnAmount > balance ? balance : forcedReturnAmount;

        if (returnAmount > 0) {
            IERC20(desc.dstToken).transfer(desc.dstReceiver, returnAmount);
        }
    }
}
