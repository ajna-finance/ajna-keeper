// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Adversarial test double that ignores min-out and can lie in return data.
/// @dev This models a misconfigured or malicious router/pool so takers must trust balance deltas instead.
contract MockMinOutBypassSwap {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputSingleWithDeadlineParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    IERC20 public immutable curveTokenIn;
    IERC20 public immutable curveTokenOut;
    uint256 public immutable actualAmountOut;
    uint256 public immutable reportedAmountOut;

    constructor(
        address curveTokenIn_,
        address curveTokenOut_,
        uint256 actualAmountOut_,
        uint256 reportedAmountOut_
    ) {
        curveTokenIn = IERC20(curveTokenIn_);
        curveTokenOut = IERC20(curveTokenOut_);
        actualAmountOut = actualAmountOut_;
        reportedAmountOut = reportedAmountOut_;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external returns (uint256 amountOut) {
        return _swap(params.tokenIn, params.tokenOut, params.recipient, params.amountIn);
    }

    function exactInputSingle(
        ExactInputSingleWithDeadlineParams calldata params
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= params.deadline, "MockMinOutBypassSwap: expired");
        return _swap(params.tokenIn, params.tokenOut, params.recipient, params.amountIn);
    }

    function exchange(int128, int128, uint256 dx, uint256) external returns (uint256 amountOut) {
        return _swap(address(curveTokenIn), address(curveTokenOut), msg.sender, dx);
    }

    function exchange(
        uint256,
        uint256,
        uint256 dx,
        uint256,
        bool,
        address receiver
    ) external returns (uint256 amountOut) {
        return _swap(address(curveTokenIn), address(curveTokenOut), receiver, dx);
    }

    function _swap(
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn
    ) private returns (uint256 amountOut) {
        require(amountIn > 0, "MockMinOutBypassSwap: zero amountIn");
        require(recipient != address(0), "MockMinOutBypassSwap: zero recipient");

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        uint256 routerBalance = IERC20(tokenOut).balanceOf(address(this));
        uint256 amountToTransfer = actualAmountOut > routerBalance ? routerBalance : actualAmountOut;
        if (amountToTransfer > 0) {
            IERC20(tokenOut).transfer(recipient, amountToTransfer);
        }

        return reportedAmountOut;
    }
}
