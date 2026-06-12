// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { MockERC20 } from "./MockERC20.sol";

/// @notice USDT-style approval semantics: approving a non-zero amount while a
///         non-zero allowance is outstanding reverts. Exercises the takers'
///         _safeApproveWithReset zero-first pattern at the taker boundary —
///         a taker that skipped the reset would brick on its second take once
///         a worst-case approval leaves residual allowance after the pull.
contract MockStrictApprovalToken is MockERC20 {
    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function approve(address spender, uint256 amount) public override returns (bool) {
        require(
            amount == 0 || allowance(msg.sender, spender) == 0,
            "StrictToken: non-zero to non-zero approval"
        );
        return super.approve(spender, amount);
    }
}
