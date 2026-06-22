// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Pool } from "../AjnaInterfaces.sol";
import { TakerTakeScaling } from "../libraries/TakerTakeScaling.sol";

/// @notice Test-only external wrapper around the internal TakerTakeScaling
///         library so its pure/view math (partial-fill floor pro-rating, the
///         ceil-rounded quote-due backstop, the planned-amount basis) can be
///         unit-tested directly, instead of only transitively through a full
///         take. Not deployed in production.
contract TakerTakeScalingHarness {
    function plannedTakeAmount(IERC20Pool pool, uint256 maxAmount) external view returns (uint256) {
        return TakerTakeScaling.plannedTakeAmount(pool, maxAmount);
    }

    function scaleAmountOutMinimum(
        uint256 fullSizeAmountOutMinimum,
        uint256 actualAmountIn,
        uint256 plannedAmountIn
    ) external pure returns (uint256) {
        return
            TakerTakeScaling.scaleAmountOutMinimum(
                fullSizeAmountOutMinimum,
                actualAmountIn,
                plannedAmountIn
            );
    }

    function quoteAmountDueCeiling(IERC20Pool pool, uint256 quoteAmountDue) external view returns (uint256) {
        return TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue);
    }
}
