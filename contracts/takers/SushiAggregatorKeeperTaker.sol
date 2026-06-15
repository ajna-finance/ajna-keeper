// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoolDeployer } from "../AjnaInterfaces.sol";
import { BaseAggregatorCalldataTaker } from "../base/BaseAggregatorCalldataTaker.sol";

/// @notice Sushi same-chain aggregator implementation for Ajna keeper factory takes.
/// @dev Thin provider wrapper over BaseAggregatorCalldataTaker, which owns the
///      calldata-aggregator mechanics (allowlists, callback binding, exact-fill
///      source-balance check, allowlisted low-level call, the
///      quoteAmountDueCeiling output backstop, the source getters, and the
///      parameterized AggregatorSwapExecuted event). This wrapper contributes
///      only construction, forwarding the Sushi aggregator source identity to
///      the base. Its allowlists are isolated from every other taker
///      deployment.
contract SushiAggregatorKeeperTaker is BaseAggregatorCalldataTaker {
    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    /// @param authorizedRouter_ Router contract address that can also call functions.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedRouter_)
        BaseAggregatorCalldataTaker(ajnaErc20PoolFactory, authorizedRouter_, LiquiditySource.SushiAggregator)
    {}
}
