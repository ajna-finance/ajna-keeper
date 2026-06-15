// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoolDeployer } from "../AjnaInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { BaseAggregatorCalldataTaker } from "../base/BaseAggregatorCalldataTaker.sol";

/// @notice Sushi same-chain aggregator implementation for Ajna keeper factory takes.
/// @dev Thin provider wrapper over BaseAggregatorCalldataTaker, which owns the
///      calldata-aggregator mechanics (allowlists, callback binding, exact-fill
///      source-balance check, allowlisted low-level call, and the
///      quoteAmountDueCeiling output backstop). This wrapper contributes only
///      construction, the Sushi aggregator source identity, and the
///      provider-distinct execution event. Its allowlists are isolated from
///      every other taker deployment.
contract SushiAggregatorKeeperTaker is BaseAggregatorCalldataTaker {
    /// @dev Sushi executions log the allowlisted call target, so this taker emits its own
    ///      distinctly-named event instead of the base 4-arg SwapExecuted (LifiSwapExecuted
    ///      precedent: same-name overloads create ambiguous ABIs that ethers v5 warns on and
    ///      indexers misdecode). Monitoring must subscribe to THIS signature for Sushi takes.
    event SushiAggregatorSwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed target, uint256 amountIn, uint256 amountOut);

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    /// @param authorizedRouter_ Router contract address that can also call functions.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedRouter_)
        BaseAggregatorCalldataTaker(ajnaErc20PoolFactory, authorizedRouter_)
    {}

    /// @inheritdoc IAjnaKeeperTaker
    function getSupportedSources() external pure returns (LiquiditySource[] memory sources) {
        sources = new LiquiditySource[](1);
        sources[0] = LiquiditySource.SushiAggregator;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function isSourceSupported(LiquiditySource source) external pure returns (bool supported) {
        return source == LiquiditySource.SushiAggregator;
    }

    function _isSupportedSource(LiquiditySource source) internal pure override returns (bool) {
        return source == LiquiditySource.SushiAggregator;
    }

    function _emitAggregatorSwapExecuted(
        address tokenIn,
        address tokenOut,
        address target,
        uint256 amountIn,
        uint256 amountOut
    ) internal override {
        emit SushiAggregatorSwapExecuted(tokenIn, tokenOut, target, amountIn, amountOut);
    }
}
