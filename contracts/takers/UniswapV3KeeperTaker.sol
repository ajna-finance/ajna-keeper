// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Pool, PoolDeployer } from "../AjnaInterfaces.sol";
import { IERC20 } from "../OneInchInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { ISwapRouter02 } from "../interfaces/ISwapRouter02.sol";
import { KeeperTakerBase } from "../base/KeeperTakerBase.sol";
import { TakerTakeScaling } from "../libraries/TakerTakeScaling.sol";

/// @notice Uniswap V3 implementation for Ajna keeper takes using direct SwapRouter02 execution.
/// @dev Shared wiring, helpers, errors, and the SwapExecuted event live in
///      KeeperTakerBase.
contract UniswapV3KeeperTaker is KeeperTakerBase {
    /// @notice Direct Uniswap V3 swap configuration encoded by the keeper.
    struct UniswapV3SwapDetails {
        address swapRouter;
        address targetToken;
        uint24 feeTier;
        uint256 amountOutMinimum;
        uint256 deadline;
    }

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment
    /// @param authorizedRouter_ Router contract address that can also call functions.
    ///        May be zero to deploy the taker in standalone (owner-only) mode; the
    ///        keeper router refuses to register a taker whose router does not match.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedRouter_)
        KeeperTakerBase(ajnaErc20PoolFactory, authorizedRouter_)
    {}

    /// @inheritdoc IAjnaKeeperTaker
    function takeWithAtomicSwap(
        IERC20Pool pool,
        address borrowerAddress,
        uint256 auctionPrice,
        uint256 maxAmount,
        LiquiditySource source,
        address swapRouter,
        bytes calldata swapDetails
    ) external onlyOwnerOrRouter {
        if (source != LiquiditySource.UniswapV3) revert UnsupportedSource();
        if (!_validatePool(pool)) revert InvalidPool();

        UniswapV3SwapDetails memory details = abi.decode(swapDetails, (UniswapV3SwapDetails));
        require(swapRouter != address(0) && details.swapRouter == swapRouter, "Router mismatch");
        require(details.targetToken == pool.quoteTokenAddress(), "Invalid target");
        require(details.deadline > block.timestamp, "Expired deadline");
        require(details.amountOutMinimum > 0, "Invalid minimum amount");

        // Ajna's take() may clamp the collateral actually purchased below maxAmount on
        // debt-constrained auctions, so the callback pro-rates amountOutMinimum (quoted for
        // the full planned size) against this on-chain derived planned input.
        bytes memory data = abi.encode(details, TakerTakeScaling.plannedTakeAmount(pool, maxAmount));

        _approveQuoteForTake(pool, maxAmount, auctionPrice);

        _beginCallbackBinding(address(pool), data);
        pool.take(borrowerAddress, maxAmount, address(this), data);
        _endCallbackBinding();

        _settleAfterTake(pool);
    }

    /// @notice Called by Pool to swap collateral for quote tokens
    function atomicSwapCallback(uint256 collateral, uint256 quoteAmountDue, bytes calldata data) external override nonReentrant {
        IERC20Pool pool = IERC20Pool(msg.sender);
        if (!_validatePool(pool)) revert InvalidPool();
        // Authoritative callback gate: only the pool this taker just called take()
        // on, with the exact bytes it handed over, may reach the swap below. Blocks
        // out-of-band pool.take(...,thisTaker,craftedData) by a third party.
        _requireActiveCallback(data);

        (UniswapV3SwapDetails memory details, uint256 plannedAmountIn) =
            abi.decode(data, (UniswapV3SwapDetails, uint256));
        if (
            details.swapRouter == address(0) ||
            details.targetToken != pool.quoteTokenAddress() ||
            details.deadline <= block.timestamp ||
            details.amountOutMinimum == 0 ||
            plannedAmountIn == 0
        ) revert InvalidSwapDetails();
        _swapWithUniswapV3(
            pool.collateralAddress(),
            details.targetToken,
            collateral,
            TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue),
            plannedAmountIn,
            details
        );
    }

    /// @inheritdoc IAjnaKeeperTaker
    function getSupportedSources() external pure returns (LiquiditySource[] memory sources) {
        sources = new LiquiditySource[](1);
        sources[0] = LiquiditySource.UniswapV3;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function isSourceSupported(LiquiditySource source) external pure returns (bool supported) {
        return source == LiquiditySource.UniswapV3;
    }

    /// @dev Execute an exact-input Uniswap V3 swap using collateral held by this taker.
    /// @param quoteAmountDueCeiling Ajna repayment backstop, already adjusted for the
    ///        pool's ceil-rounded quote pull (TakerTakeScaling.quoteAmountDueCeiling).
    function _swapWithUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 quoteAmountDueCeiling,
        uint256 plannedAmountIn,
        UniswapV3SwapDetails memory details
    ) private {
        if (amountIn == 0 || block.timestamp >= details.deadline) {
            revert SwapFailed();
        }

        uint256 amountOutMinimum =
            TakerTakeScaling.scaleAmountOutMinimum(details.amountOutMinimum, amountIn, plannedAmountIn);

        IERC20 tokenInContract = IERC20(tokenIn);
        uint256 quoteBalanceBefore = IERC20(tokenOut).balanceOf(address(this));

        _safeApproveWithReset(tokenInContract, details.swapRouter, amountIn);
        ISwapRouter02(details.swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: details.feeTier,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
        _safeApproveWithReset(tokenInContract, details.swapRouter, 0);

        uint256 quoteReceived = IERC20(tokenOut).balanceOf(address(this)) - quoteBalanceBefore;
        if (quoteReceived < amountOutMinimum || quoteReceived < quoteAmountDueCeiling) {
            revert InsufficientQuoteReceived();
        }
        emit SwapExecuted(tokenIn, tokenOut, amountIn, quoteReceived);
    }
}
