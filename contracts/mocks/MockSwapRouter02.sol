// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Uniswap SwapRouter02-compatible router for liquidation tests.
/// @dev Pre-fund this contract with tokenOut before executing swaps.
contract MockSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 public immutable fixedAmountOut;

    constructor(uint256 _fixedAmountOut) {
        fixedAmountOut = _fixedAmountOut;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external returns (uint256 amountOut) {
        require(params.amountIn > 0, "MockSwapRouter02: zero amountIn");
        require(params.recipient != address(0), "MockSwapRouter02: zero recipient");

        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        amountOut = fixedAmountOut;
        uint256 routerBalance = IERC20(params.tokenOut).balanceOf(address(this));
        if (amountOut > routerBalance) {
            amountOut = routerBalance;
        }

        require(
            amountOut >= params.amountOutMinimum,
            "MockSwapRouter02: insufficient output amount"
        );

        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
