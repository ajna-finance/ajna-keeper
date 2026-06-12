// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { IERC20Pool, PoolDeployer } from "../AjnaInterfaces.sol";
import { IERC20 } from "../OneInchInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { FactoryAuthorizedTakerBase } from "../base/KeeperTakerBase.sol";
import { TakerTakeScaling } from "../libraries/TakerTakeScaling.sol";

/// @notice SushiSwap V3 implementation for Ajna keeper takes using SushiSwap Router
/// @dev Mirrors the 1inch pattern for decimal handling and pre-calculated minimums.
///      Shared wiring, helpers, errors, and the SwapExecuted event live in
///      FactoryAuthorizedTakerBase / KeeperTakerBase.
contract SushiSwapKeeperTaker is FactoryAuthorizedTakerBase {
    /// @notice Configuration for SushiSwap swaps with pre-calculated minimum (mirrors 1inch)
    struct SushiSwapDetails {
        address swapRouter;         // SushiSwap router contract address
        address targetToken;        // Token to swap collateral for (usually quote token)
        uint24 feeTier;            // SushiSwap fee tier (500, 3000, 10000)
        uint256 amountOutMinimum;  // Pre-calculated minimum output (replaces slippageBps)
        uint256 deadline;          // Swap deadline timestamp
    }

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment
    /// @param authorizedFactory_ Factory contract address that can also call functions.
    ///        May be zero to deploy the taker in standalone (owner-only) mode; the
    ///        keeper factory refuses to register a taker whose factory does not match.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedFactory_)
        FactoryAuthorizedTakerBase(ajnaErc20PoolFactory, authorizedFactory_)
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
    ) external onlyOwnerOrFactory {
        // Validate inputs
        if (source != LiquiditySource.SushiSwap) revert UnsupportedSource();
        if (!_validatePool(pool)) revert InvalidPool();

        // Decode parameter structure (mirrors TypeScript encoding)
        if (swapDetails.length < 96) revert InvalidSwapDetails(); // 3 static fields x 32 bytes
        (uint24 feeTier, uint256 amountOutMinimum, uint256 deadline) = abi.decode(swapDetails, (uint24, uint256, uint256));

        require(swapRouter != address(0), "Invalid router");
        require(deadline > block.timestamp, "Expired deadline");
        require(amountOutMinimum > 0, "Invalid minimum amount");

        // Ajna's take() may clamp the collateral actually purchased below maxAmount on
        // debt-constrained auctions, so the callback pro-rates amountOutMinimum (quoted for
        // the full planned size) against this on-chain derived planned input.
        bytes memory data = abi.encode(SushiSwapDetails({
            swapRouter: swapRouter,
            targetToken: pool.quoteTokenAddress(),
            feeTier: feeTier,
            amountOutMinimum: amountOutMinimum,
            deadline: deadline
        }), TakerTakeScaling.plannedTakeAmount(pool, maxAmount));

        _approveQuoteForTake(pool, maxAmount, auctionPrice);

        // Invoke the take
        pool.take(borrowerAddress, maxAmount, address(this), data);

        _settleAfterTake(pool);
    }

    /// @notice Called by Pool to swap collateral for quote tokens during liquidation
    function atomicSwapCallback(uint256 collateral, uint256 quoteAmountDue, bytes calldata data) external override nonReentrant {
        // Ensure msg.sender is a valid Ajna pool
        IERC20Pool pool = IERC20Pool(msg.sender);
        if (!_validatePool(pool)) revert InvalidPool();

        // Decode swap configuration
        (SushiSwapDetails memory details, uint256 plannedAmountIn) =
            abi.decode(data, (SushiSwapDetails, uint256));
        if (plannedAmountIn == 0) revert InvalidSwapDetails();
        // Re-bind the output token to the calling pool. Anyone may invoke pool.take with
        // this taker as callee and arbitrary data; without this check crafted details
        // could point targetToken at an attacker-minted token so the balance-delta guard
        // measures the wrong asset (no taker funds at risk, but events get spoofed and
        // the contract acts as a swap conduit). Mirrors UniswapV3KeeperTaker.
        if (details.targetToken != pool.quoteTokenAddress()) revert InvalidSwapDetails();

        // Execute SushiSwap swap
        _swapWithSushiSwap(
            pool.collateralAddress(),
            details.targetToken,
            collateral, //this is already in native token amount that Ajna Core Knows
            TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue),
            plannedAmountIn,
            details
        );
    }

    /// @inheritdoc IAjnaKeeperTaker
    function getSupportedSources() external pure returns (LiquiditySource[] memory sources) {
        sources = new LiquiditySource[](1);
        sources[0] = LiquiditySource.SushiSwap;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function isSourceSupported(LiquiditySource source) external pure returns (bool supported) {
        return source == LiquiditySource.SushiSwap;
    }

    /// @dev Executes swap using SushiSwap Router with pre-calculated minimum (mirrors 1inch)
    /// @param quoteAmountDueCeiling Ajna repayment backstop, already adjusted for the
    ///        pool's ceil-rounded quote pull (TakerTakeScaling.quoteAmountDueCeiling).
    function _swapWithSushiSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 quoteAmountDueCeiling,
        uint256 plannedAmountIn,
        SushiSwapDetails memory details
    ) private {
        if (amountIn == 0) revert SwapFailed();
        if (block.timestamp > details.deadline) revert SwapFailed();

        IERC20 tokenInContract = IERC20(tokenIn);
        uint256 quoteBalanceBefore = IERC20(tokenOut).balanceOf(address(this));

        _safeApproveWithReset(tokenInContract, details.swapRouter, amountIn);

        // Pro-rate the full-size minimum to the collateral Ajna actually sent (mirrors the
        // 1inch _normalizeOneInchSwapAmounts pattern for debt-constrained partial fills).
        uint256 amountOutMin =
            TakerTakeScaling.scaleAmountOutMinimum(details.amountOutMinimum, amountIn, plannedAmountIn);

        // Prepare SushiSwap exactInputSingle parameters
        bytes memory swapCalldata = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
            tokenIn,              // tokenIn
            tokenOut,             // tokenOut
            details.feeTier,      // fee
            address(this),        // recipient
            details.deadline,     // deadline
            amountIn,             // amountIn
            amountOutMin,         // pre-calculated, pro-rated minimum
            uint160(0)            // sqrtPriceLimitX96 (no limit)
        );

        // Execute the swap; Address.functionCall bubbles reverts and fails loudly on
        // a non-contract router. The balance-delta check below is the output guard.
        Address.functionCall(
            details.swapRouter,
            swapCalldata,
            "SushiSwap swap failed"
        );

        _safeApproveWithReset(tokenInContract, details.swapRouter, 0);

        uint256 quoteReceived = IERC20(tokenOut).balanceOf(address(this)) - quoteBalanceBefore;
        if (quoteReceived < amountOutMin || quoteReceived < quoteAmountDueCeiling) {
            revert InsufficientQuoteReceived();
        }

        // AUDIT FIX: was declared but never emitted, leaving SushiSwap takes invisible
        // to per-swap monitoring (UniswapV3/Curve/Lifi parity).
        emit SwapExecuted(tokenIn, tokenOut, amountIn, quoteReceived);
    }
}
