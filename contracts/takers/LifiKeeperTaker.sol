// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoolDeployer } from "../AjnaInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { BaseAggregatorCalldataTaker } from "../base/BaseAggregatorCalldataTaker.sol";

/// @notice LI.FI same-chain implementation for Ajna keeper factory takes.
/// @dev Thin provider wrapper over BaseAggregatorCalldataTaker, which owns the
///      calldata-aggregator mechanics (allowlists, callback binding, exact-fill
///      source-balance check, allowlisted low-level call, and the
///      quoteAmountDueCeiling output backstop). This wrapper contributes only
///      construction, the LI.FI source identity, and the provider-distinct
///      execution event.
contract LifiKeeperTaker is BaseAggregatorCalldataTaker {
    /// @dev LI.FI executions log the allowlisted call target, so this taker emits its own
    ///      distinctly-named event instead of the base 4-arg SwapExecuted. The distinct name
    ///      keeps the ABI free of same-name overloads (which ethers v5 warns on) and makes
    ///      the topic0 divergence explicit: monitoring must subscribe to THIS signature for
    ///      LI.FI takes.
    event LifiSwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed target, uint256 amountIn, uint256 amountOut);

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    /// @param authorizedFactory_ Factory contract address that can also call functions.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedFactory_)
        BaseAggregatorCalldataTaker(ajnaErc20PoolFactory, authorizedFactory_)
    {}

    /// @inheritdoc IAjnaKeeperTaker
    function getSupportedSources() external pure returns (LiquiditySource[] memory sources) {
        sources = new LiquiditySource[](1);
        sources[0] = LiquiditySource.Lifi;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function isSourceSupported(LiquiditySource source) external pure returns (bool supported) {
        return source == LiquiditySource.Lifi;
    }

    function _isSupportedSource(LiquiditySource source) internal pure override returns (bool) {
        return source == LiquiditySource.Lifi;
    }

    function _emitAggregatorSwapExecuted(
        address tokenIn,
        address tokenOut,
        address target,
        uint256 amountIn,
        uint256 amountOut
    ) internal override {
        emit LifiSwapExecuted(tokenIn, tokenOut, target, amountIn, amountOut);
    }
}
