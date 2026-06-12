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
    /// @dev MEV note: the keeper quotes fullSizeAmountOutMinimum with slippage
    ///      against the FULL planned size. A partial fill has less price impact,
    ///      so this linear pro-rate is a LOOSE (lower) floor than the partial
    ///      fill could achieve, widening the sandwich window on a public-mempool
    ///      take. This is bounded below by quoteAmountDue (the auction is always
    ///      repaid; no principal loss) and is mitigated operationally by the
    ///      keeper's private-RPC / relay submission. Tightening on-chain would
    ///      require the partial-fill spot price, which is not available in the
    ///      callback.
    function scaleAmountOutMinimum(
        uint256 fullSizeAmountOutMinimum,
        uint256 actualAmountIn,
        uint256 plannedAmountIn
    ) internal pure returns (uint256) {
        if (actualAmountIn == plannedAmountIn) return fullSizeAmountOutMinimum;
        return Math.mulDiv(fullSizeAmountOutMinimum, actualAmountIn, plannedAmountIn, Math.Rounding.Up);
    }

    /// @dev Ajna's callback reports `quoteAmountDue` floor-divided to quote
    ///      token precision, but the pool then pulls the ceil-divided amount
    ///      from the taker (`Pool._transferQuoteTokenFrom`), which can exceed
    ///      the reported due by 1 token-wei whenever quoteTokenScale > 1.
    ///      Guarding against this ceiling makes the swap-output check honest:
    ///      a swap that only covers the floored due would otherwise pass the
    ///      taker's guard and then revert inside the pool's pull with an
    ///      opaque token error.
    /// @dev The +1 is unconditional because the callback cannot observe the
    ///      WAD amount to detect exact division. When the division IS exact
    ///      (pull == floored due) this over-asks by one token-wei, rejecting
    ///      only a take whose swap output exactly equals the due — a
    ///      zero-margin fill the keeper never plans for: the off-chain sizer
    ///      already prices every route against the ceil-rounded due
    ///      (getQuoteAmountDueRaw / "below auction repayment floor" gate).
    function quoteAmountDueCeiling(IERC20Pool pool, uint256 quoteAmountDue) internal view returns (uint256) {
        return pool.quoteTokenScale() > 1 ? quoteAmountDue + 1 : quoteAmountDue;
    }
}
