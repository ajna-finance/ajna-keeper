// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoolDeployer } from "../AjnaInterfaces.sol";
import { BaseAggregatorCalldataTaker } from "../base/BaseAggregatorCalldataTaker.sol";

/// @notice 1inch calldata-aggregator implementation for Ajna keeper takes.
/// @dev Thin provider wrapper over BaseAggregatorCalldataTaker. This uses
///      exact-fill calldata aggregator semantics: source-amount drift is
///      rejected instead of resizing provider calldata on-chain. This wrapper
///      contributes only construction, forwarding the 1inch source identity to
///      the base.
contract OneInchAggregatorKeeperTaker is BaseAggregatorCalldataTaker {
    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    /// @param authorizedRouter_ Router contract address that can also call functions.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedRouter_)
        BaseAggregatorCalldataTaker(ajnaErc20PoolFactory, authorizedRouter_, LiquiditySource.OneInch)
    {}
}
