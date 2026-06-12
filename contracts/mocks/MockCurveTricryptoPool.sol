// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Models the tricrypto-family ABI surface: uint256-indexed `exchange`
///         exposed ONLY in its 4-arg base form (plus tricrypto2's 5-arg
///         `use_eth` variant), output sent to msg.sender. There is no 6-arg
///         `exchange(...,bool,address)` selector and no fallback, exactly like
///         tricrypto2 / tricrypto-NG — so the taker's previous 6-arg encoding
///         reverts here while the universal 4-arg form succeeds.
contract MockCurveTricryptoPool {
    IERC20 public immutable tokenIn;
    IERC20 public tokenOut;
    uint256 public immutable fixedAmountOut;

    constructor(address tokenIn_, uint256 fixedAmountOut_) {
        tokenIn = IERC20(tokenIn_);
        fixedAmountOut = fixedAmountOut_;
    }

    function setTokenOut(address tokenOut_) external {
        tokenOut = IERC20(tokenOut_);
    }

    /// @dev Index discovery surface used by the TS curve-router (coins reverts past
    ///      the last index, like Vyper bounds checks, ending the probe loop).
    function coins(uint256 i) external view returns (address) {
        if (i == 0) return address(tokenIn);
        if (i == 1) return address(tokenOut);
        revert("MockTricrypto: index out of range");
    }

    /// @dev Quote surface used by the TS curve-router before executing the swap.
    function get_dy(uint256, uint256, uint256) external view returns (uint256) {
        return fixedAmountOut;
    }

    function exchange(uint256, uint256, uint256 dx, uint256 minDy) external returns (uint256 amountOut) {
        amountOut = _exchange(dx, minDy);
    }

    function exchange(uint256, uint256, uint256 dx, uint256 minDy, bool useEth) external returns (uint256 amountOut) {
        require(!useEth, "MockTricrypto: ETH unsupported");
        amountOut = _exchange(dx, minDy);
    }

    function _exchange(uint256 dx, uint256 minDy) private returns (uint256 amountOut) {
        tokenIn.transferFrom(msg.sender, address(this), dx);
        amountOut = fixedAmountOut;
        require(amountOut >= minDy, "MockTricrypto: slippage");
        if (address(tokenOut) != address(0) && amountOut > 0) {
            tokenOut.transfer(msg.sender, amountOut);
        }
    }
}
