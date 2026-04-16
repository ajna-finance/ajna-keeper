// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Taker } from "../AjnaInterfaces.sol";

contract MockAtomicSwapPool {
    address public immutable collateralAddress;
    address public immutable quoteTokenAddress;
    uint256 public immutable quoteTokenScale;

    constructor(address collateralAddress_, address quoteTokenAddress_, uint256 quoteTokenScale_) {
        collateralAddress = collateralAddress_;
        quoteTokenAddress = quoteTokenAddress_;
        quoteTokenScale = quoteTokenScale_;
    }

    function callAtomicSwapCallback(
        address taker,
        uint256 collateralAmount,
        uint256 quoteAmountDue,
        bytes calldata data
    ) external {
        IERC20Taker(taker).atomicSwapCallback(collateralAmount, quoteAmountDue, data);
    }
}
