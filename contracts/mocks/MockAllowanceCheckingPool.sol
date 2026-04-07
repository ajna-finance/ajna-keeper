// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "../OneInchInterfaces.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract MockAllowanceCheckingPool {
    address public immutable collateralAddress;
    address public immutable quoteTokenAddress;
    uint256 public immutable quoteTokenScale;
    uint256 public immutable auctionPrice;
    uint256 public constant collateralScale = 1e18;

    error InsufficientQuoteAllowance(uint256 allowance, uint256 requiredAllowance);

    constructor(
        address collateralAddress_,
        address quoteTokenAddress_,
        uint256 quoteTokenScale_,
        uint256 auctionPrice_
    ) {
        collateralAddress = collateralAddress_;
        quoteTokenAddress = quoteTokenAddress_;
        quoteTokenScale = quoteTokenScale_;
        auctionPrice = auctionPrice_;
    }

    function take(
        address,
        uint256 maxAmount,
        address callee,
        bytes calldata
    ) external returns (uint256 collateralTaken_) {
        uint256 quoteDueWad = (maxAmount * auctionPrice + 1e18 - 1) / 1e18;
        uint256 requiredQuoteAllowance = Math.ceilDiv(quoteDueWad, quoteTokenScale);
        uint256 allowance = IERC20(quoteTokenAddress).allowance(callee, address(this));
        if (allowance < requiredQuoteAllowance) {
            revert InsufficientQuoteAllowance(allowance, requiredQuoteAllowance);
        }

        IERC20(quoteTokenAddress).transferFrom(callee, address(this), requiredQuoteAllowance);
        return maxAmount;
    }
}
