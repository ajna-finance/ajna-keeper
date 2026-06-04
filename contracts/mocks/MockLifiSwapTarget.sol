// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockLifiSwapTarget {
    using SafeERC20 for IERC20;

    event MockSwap(address indexed tokenIn, address indexed tokenOut, address indexed recipient, uint256 amountIn, uint256 amountOut);

    function mockSwap(
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn,
        uint256 amountOut
    ) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit MockSwap(tokenIn, tokenOut, recipient, amountIn, amountOut);
    }

    function mockSwapWithRefund(
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn,
        uint256 amountOut,
        uint256 refundAmount
    ) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn - refundAmount);
        if (refundAmount > 0) {
            IERC20(tokenIn).safeTransferFrom(msg.sender, recipient, refundAmount);
        }
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }

    function mockNoOutput(address tokenIn, uint256 amountIn) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
    }

    function mockReturnFakeOutputNoTransfer(
        address tokenIn,
        uint256 amountIn,
        uint256 fakeAmountOut
    ) external returns (uint256) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        return fakeAmountOut;
    }

    function mockSwapWrongToken(
        address tokenIn,
        address wrongTokenOut,
        address recipient,
        uint256 amountIn,
        uint256 wrongAmountOut
    ) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(wrongTokenOut).safeTransfer(recipient, wrongAmountOut);
    }

    function mockReentrantCallback(
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn,
        uint256 amountOut,
        bytes calldata callbackData
    ) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        (bool success, bytes memory returnData) = recipient.call(
            abi.encodeWithSignature(
                "atomicSwapCallback(uint256,uint256,bytes)",
                uint256(0),
                uint256(0),
                callbackData
            )
        );
        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }

    function mockRevert() external pure {
        revert("mock lifi target revert");
    }
}
