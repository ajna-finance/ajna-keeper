// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockPermit2 {
    mapping(address => mapping(address => mapping(address => uint160))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[token][msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        uint160 allowed = allowance[token][from][msg.sender];
        require(allowed >= amount, "MockPermit2: insufficient allowance");
        allowance[token][from][msg.sender] = allowed - amount;
        IERC20(token).transferFrom(from, to, amount);
    }
}
