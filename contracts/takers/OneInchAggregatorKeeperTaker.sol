// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoolDeployer } from "../AjnaInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { BaseAggregatorCalldataTaker } from "../base/BaseAggregatorCalldataTaker.sol";

/// @notice 1inch calldata-aggregator implementation for Ajna keeper takes.
/// @dev Thin provider wrapper over BaseAggregatorCalldataTaker. This uses
///      exact-fill calldata aggregator semantics: source-amount drift is
///      rejected instead of resizing provider calldata on-chain.
contract OneInchAggregatorKeeperTaker is BaseAggregatorCalldataTaker {
    /// @dev 1inch calldata-aggregator executions log the allowlisted call
    ///      target through a provider-distinct event. Monitoring must subscribe
    ///      to this signature for migrated 1inch takes.
    event OneInchAggregatorSwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed target, uint256 amountIn, uint256 amountOut);

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    /// @param authorizedRouter_ Router contract address that can also call functions.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedRouter_)
        BaseAggregatorCalldataTaker(ajnaErc20PoolFactory, authorizedRouter_)
    {}

    /// @inheritdoc IAjnaKeeperTaker
    function getSupportedSources() external pure returns (LiquiditySource[] memory sources) {
        sources = new LiquiditySource[](1);
        sources[0] = LiquiditySource.OneInch;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function isSourceSupported(LiquiditySource source) external pure returns (bool supported) {
        return source == LiquiditySource.OneInch;
    }

    function _isSupportedSource(LiquiditySource source) internal pure override returns (bool) {
        return source == LiquiditySource.OneInch;
    }

    function _emitAggregatorSwapExecuted(
        address tokenIn,
        address tokenOut,
        address target,
        uint256 amountIn,
        uint256 amountOut
    ) internal override {
        emit OneInchAggregatorSwapExecuted(tokenIn, tokenOut, target, amountIn, amountOut);
    }
}
