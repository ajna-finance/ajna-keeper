// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAggregationExecutor, IGenericRouter, SwapDescription } from "../OneInchInterfaces.sol";

interface IMockTakePool {
    function take(address borrowerAddress_, uint256 maxAmount_, address callee_, bytes calldata data_)
        external
        returns (uint256 collateralTaken_);
}

/// @notice Malicious 1inch-compatible router that re-enters the taker's
///         atomicSwapCallback by starting a second pool.take while the first
///         swap is still in flight. Used to prove the taker's ReentrancyGuard
///         blocks the cross-pool re-entry path.
contract MockReentrantOneInchRouter is IGenericRouter {
    IMockTakePool public reentryPool;
    address public reentryBorrower;
    uint256 public reentryMaxAmount;
    address public reentryCallee;
    bytes public reentryData;

    function setReentry(
        IMockTakePool pool_,
        address borrower_,
        uint256 maxAmount_,
        address callee_,
        bytes calldata data_
    ) external {
        reentryPool = pool_;
        reentryBorrower = borrower_;
        reentryMaxAmount = maxAmount_;
        reentryCallee = callee_;
        reentryData = data_;
    }

    function swap(
        IAggregationExecutor,
        SwapDescription calldata,
        bytes calldata
    ) external override returns (uint256 returnAmount, uint256 spentAmount) {
        // Second take against the (mock) pool re-invokes the taker's callback;
        // the taker's nonReentrant guard must revert, bubbling up through here.
        reentryPool.take(reentryBorrower, reentryMaxAmount, reentryCallee, reentryData);
        return (0, 0);
    }
}
