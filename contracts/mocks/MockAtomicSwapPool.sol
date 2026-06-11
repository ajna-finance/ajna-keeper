// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Taker } from "../AjnaInterfaces.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockAtomicSwapPool {
    using SafeERC20 for IERC20;

    address public immutable collateralAddress;
    address public immutable quoteTokenAddress;
    uint256 public immutable quoteTokenScale;
    uint256 public collateralScale = 1;
    uint256 public quoteAmountDue;
    /// @dev When nonzero, take() sends this raw collateral amount to the callee instead of
    ///      maxAmount, simulating Ajna's debt-constrained clamp. Tests using a collateral
    ///      scale other than 1 must always set this, since maxAmount is WAD-precision.
    uint256 public collateralTakenOverride;
    address public lastBorrower;
    address public lastCallee;
    uint256 public lastCollateralTaken;
    uint256 public takeCount;

    constructor(address collateralAddress_, address quoteTokenAddress_, uint256 quoteTokenScale_) {
        collateralAddress = collateralAddress_;
        quoteTokenAddress = quoteTokenAddress_;
        quoteTokenScale = quoteTokenScale_;
    }

    function setQuoteAmountDue(uint256 quoteAmountDue_) external {
        quoteAmountDue = quoteAmountDue_;
    }

    function setCollateralScale(uint256 collateralScale_) external {
        collateralScale = collateralScale_;
    }

    function setCollateralTakenOverride(uint256 collateralTakenOverride_) external {
        collateralTakenOverride = collateralTakenOverride_;
    }

    function take(
        address borrowerAddress_,
        uint256 maxAmount_,
        address callee_,
        bytes calldata data_
    ) external returns (uint256 collateralTaken_) {
        collateralTaken_ = collateralTakenOverride != 0 ? collateralTakenOverride : maxAmount_;
        lastBorrower = borrowerAddress_;
        lastCallee = callee_;
        lastCollateralTaken = collateralTaken_;
        takeCount += 1;

        IERC20(collateralAddress).safeTransfer(callee_, collateralTaken_);
        IERC20Taker(callee_).atomicSwapCallback(
            collateralTaken_,
            quoteAmountDue,
            data_
        );
        IERC20(quoteTokenAddress).safeTransferFrom(
            callee_,
            address(this),
            quoteAmountDue
        );
    }

    function callAtomicSwapCallback(
        address taker,
        uint256 collateralAmount,
        uint256 quoteAmountDue_,
        bytes calldata data
    ) external {
        IERC20Taker(taker).atomicSwapCallback(collateralAmount, quoteAmountDue_, data);
    }
}
