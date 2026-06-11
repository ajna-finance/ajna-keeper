// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IERC20Pool } from "../AjnaInterfaces.sol";

/// @notice Shared take-size scaling math for keeper taker contracts.
/// @dev Ajna's take() may clamp the collateral actually purchased below the
///      requested maxAmount on debt-constrained auctions. Keepers quote their
///      output floor for the full planned size, so takers pro-rate that floor
///      to the collateral Ajna actually sent. Internal functions are inlined
///      by the compiler, so using this library does not change call semantics.
library TakerTakeScaling {
    /// @dev Planned swap input for maxAmount, in collateral token precision;
    ///      the scaling basis callbacks use to pro-rate the encoded
    ///      amountOutMinimum.
    function plannedTakeAmount(IERC20Pool pool, uint256 maxAmount) internal view returns (uint256 plannedAmountIn) {
        plannedAmountIn = maxAmount / pool.collateralScale();
        require(plannedAmountIn > 0, "Zero planned amount");
    }

    /// @dev Pro-rates the full-size output floor to the collateral Ajna
    ///      actually sent. Enforcing the unscaled floor would reject valid
    ///      debt-constrained partial fills; rounding up preserves the quoted
    ///      per-unit floor at any fill size, and quoteAmountDue remains a
    ///      separate repayment backstop in each taker.
    function scaleAmountOutMinimum(
        uint256 fullSizeAmountOutMinimum,
        uint256 actualAmountIn,
        uint256 plannedAmountIn
    ) internal pure returns (uint256) {
        if (actualAmountIn == plannedAmountIn) return fullSizeAmountOutMinimum;
        return Math.mulDiv(fullSizeAmountOutMinimum, actualAmountIn, plannedAmountIn, Math.Rounding.Up);
    }
}
