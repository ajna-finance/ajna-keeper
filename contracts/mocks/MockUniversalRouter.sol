// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MockPermit2 } from "./MockPermit2.sol";

contract MockUniversalRouter {
    MockPermit2 public immutable permit2;
    IERC20 public immutable quoteToken;
    uint256 public immutable quoteAmountOut;

    constructor(address permit2_, address quoteToken_, uint256 quoteAmountOut_) {
        permit2 = MockPermit2(permit2_);
        quoteToken = IERC20(quoteToken_);
        quoteAmountOut = quoteAmountOut_;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external {
        (address recipient, uint256 amountIn,, bytes memory path,) = abi.decode(
            inputs[0],
            (address, uint256, uint256, bytes, bool)
        );

        address tokenIn = _readAddress(path, 0);
        permit2.transferFrom(msg.sender, address(this), uint160(amountIn), tokenIn);

        if (quoteAmountOut > 0) {
            quoteToken.transfer(recipient, quoteAmountOut);
        }
    }

    function _readAddress(bytes memory data, uint256 start) private pure returns (address value) {
        require(data.length >= start + 20, "MockUniversalRouter: short path");
        assembly {
            value := shr(96, mload(add(add(data, 0x20), start)))
        }
    }
}
