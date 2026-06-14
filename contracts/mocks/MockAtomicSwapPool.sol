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
    /// @dev When nonzero, take() pulls this raw quote amount instead of quoteAmountDue.
    ///      Real Ajna passes floor(quoteWad/scale) to the callback but pulls
    ///      ceil(quoteWad/scale) — set this to quoteAmountDue + 1 to model that gap.
    uint256 public quotePullOverride;
    /// @dev When true, take() delivers callback data that differs from the bytes the
    ///      taker handed to take(), modeling a compromised pool. Calldata-aggregator
    ///      takers must reject this via their callback data-hash binding.
    bool public mutateCallbackData;
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

    function setQuotePullOverride(uint256 quotePullOverride_) external {
        quotePullOverride = quotePullOverride_;
    }

    function setMutateCallbackData(bool mutateCallbackData_) external {
        mutateCallbackData = mutateCallbackData_;
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
            mutateCallbackData ? bytes.concat(data_, hex"00") : data_
        );
        // Real Ajna pulls from msg.sender (the take caller), not the callee, and pulls
        // the ceil-divided amount which can exceed the callback's floored due by 1 wei.
        IERC20(quoteTokenAddress).safeTransferFrom(
            msg.sender,
            address(this),
            quotePullOverride != 0 ? quotePullOverride : quoteAmountDue
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
