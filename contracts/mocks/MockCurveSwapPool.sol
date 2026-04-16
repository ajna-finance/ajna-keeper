// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockCurveSwapPool {
    IERC20 public immutable tokenIn;
    uint256 public immutable fixedAmountOut;

    constructor(address tokenIn_, uint256 fixedAmountOut_) {
        tokenIn = IERC20(tokenIn_);
        fixedAmountOut = fixedAmountOut_;
    }

    function exchange(int128, int128, uint256 dx, uint256) external returns (uint256 amountOut) {
        tokenIn.transferFrom(msg.sender, address(this), dx);
        return fixedAmountOut;
    }

    function exchange(uint256, uint256, uint256 dx, uint256, bool, address) external returns (uint256 amountOut) {
        tokenIn.transferFrom(msg.sender, address(this), dx);
        return fixedAmountOut;
    }
}
