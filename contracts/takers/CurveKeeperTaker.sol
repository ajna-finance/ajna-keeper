// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { IERC20Pool, PoolDeployer } from "../AjnaInterfaces.sol";
import { IERC20 } from "../OneInchInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { RouterAuthorizedTakerBase } from "../base/KeeperTakerBase.sol";
import { TakerTakeScaling } from "../libraries/TakerTakeScaling.sol";

/// @notice Curve DEX implementation for Ajna keeper takes using Curve pools
/// @dev Follows the SushiSwap pattern for decimal handling and pre-calculated minimums.
///      Shared wiring, helpers, errors, and the SwapExecuted event live in
///      RouterAuthorizedTakerBase / KeeperTakerBase.
contract CurveKeeperTaker is RouterAuthorizedTakerBase {
    /// @notice Configuration for Curve swaps with pre-calculated minimum and pre-discovered indices
    struct CurveSwapDetails {
        address poolAddress;        // Curve pool contract address (from config)
        address tokenIn;           // Token input address (from Ajna pool.collateralAddress())
        address tokenOut;          // Token output address (from Ajna pool.quoteTokenAddress())
        uint8 poolType;           // 0=STABLE(int128), 1=CRYPTO(uint256)
        uint8 tokenInIndex;       // Pre-discovered by TypeScript
        uint8 tokenOutIndex;      // Pre-discovered by TypeScript
        uint256 amountOutMinimum; // Pre-calculated minimum output (replaces slippage calculation)
        uint256 deadline;         // Swap deadline timestamp
    }

    /// @dev Pool type constants
    uint8 private constant POOL_TYPE_STABLE = 0; // StableSwap pools use int128 indices
    uint8 private constant POOL_TYPE_CRYPTO = 1; // CryptoSwap pools use uint256 indices

    /// @notice The configured Curve pool type is not supported.
    error InvalidPoolType();    // sig: 0x2946cbf1

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment
    /// @param authorizedRouter_ Router contract address that can also call functions.
    ///        May be zero to deploy the taker in standalone (owner-only) mode; the
    ///        keeper router refuses to register a taker whose router does not match.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedRouter_)
        RouterAuthorizedTakerBase(ajnaErc20PoolFactory, authorizedRouter_)
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
        // Validate inputs
        if (source != LiquiditySource.Curve) revert UnsupportedSource();
        if (!_validatePool(pool)) revert InvalidPool();

        // Decode poolAddress first to validate against swapRouter
        if (swapDetails.length < 192) revert InvalidSwapDetails(); // 6 static fields x 32 bytes
        (address poolAddress,,,,,) = abi.decode(swapDetails, (address, uint8, uint8, uint8, uint256, uint256));

        // Validate swapRouter matches poolAddress (Curve has no central router)
        require(swapRouter == poolAddress, "Router must match pool address");

        // Use internal function to avoid stack depth issues
        _executeCurveTake(pool, borrowerAddress, auctionPrice, maxAmount, swapDetails);
    }

    /// @dev Internal function to handle Curve take logic and avoid stack depth issues
    function _executeCurveTake(
        IERC20Pool pool,
        address borrowerAddress,
        uint256 auctionPrice,
        uint256 maxAmount,
        bytes calldata swapDetails
    ) internal {
        (address poolAddress, uint8 poolType, uint8 tokenInIndex, uint8 tokenOutIndex, uint256 amountOutMinimum, uint256 deadline) =
            abi.decode(swapDetails, (address, uint8, uint8, uint8, uint256, uint256));

        // Basic validation (like SushiSwap)
        require(poolAddress != address(0) && poolType <= POOL_TYPE_CRYPTO && deadline > block.timestamp && amountOutMinimum > 0, "Invalid params");

        // Ajna's take() may clamp the collateral actually purchased below maxAmount on
        // debt-constrained auctions, so the callback pro-rates amountOutMinimum (quoted for
        // the full planned size) against this on-chain derived planned input.
        bytes memory data = abi.encode(CurveSwapDetails({
            poolAddress: poolAddress,
            tokenIn: pool.collateralAddress(),
            tokenOut: pool.quoteTokenAddress(),
            poolType: poolType,
            tokenInIndex: tokenInIndex,
            tokenOutIndex: tokenOutIndex,
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
        (CurveSwapDetails memory details, uint256 plannedAmountIn) =
            abi.decode(data, (CurveSwapDetails, uint256));
        if (plannedAmountIn == 0) revert InvalidSwapDetails();
        // Re-bind swap tokens to the calling pool. Anyone may invoke pool.take with this
        // taker as callee and arbitrary data; without this check crafted details could
        // point tokenOut at an attacker-minted token so the balance-delta guard below
        // measures the wrong asset (no taker funds at risk, but events get spoofed and
        // the contract acts as a swap conduit). Mirrors UniswapV3KeeperTaker.
        if (
            details.tokenIn != pool.collateralAddress() ||
            details.tokenOut != pool.quoteTokenAddress()
        ) revert InvalidSwapDetails();

        // Execute Curve swap
        _swapWithCurve(
            pool.collateralAddress(),
            details,
            collateral, // This is already in native token amount that Ajna Core knows
            TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue),
            plannedAmountIn
        );
    }

    /// @inheritdoc IAjnaKeeperTaker
    function getSupportedSources() external pure returns (LiquiditySource[] memory sources) {
        sources = new LiquiditySource[](1);
        sources[0] = LiquiditySource.Curve;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function isSourceSupported(LiquiditySource source) external pure returns (bool supported) {
        return source == LiquiditySource.Curve;
    }

    /// @dev Executes swap using Curve pools with pool-type-specific ABI calls
    /// @param quoteAmountDueCeiling Ajna repayment backstop, already adjusted for the
    ///        pool's ceil-rounded quote pull (TakerTakeScaling.quoteAmountDueCeiling).
    function _swapWithCurve(
        address tokenIn,
        CurveSwapDetails memory details,
        uint256 amountIn,
        uint256 quoteAmountDueCeiling,
        uint256 plannedAmountIn
    ) private {
        if (amountIn == 0) revert SwapFailed();
        if (block.timestamp > details.deadline) revert SwapFailed();
        if (details.poolType > POOL_TYPE_CRYPTO) revert InvalidPoolType();

        // Validate token addresses match (additional safety check)
        require(tokenIn == details.tokenIn, "Token input mismatch");

        IERC20 tokenInContract = IERC20(tokenIn);
        uint256 quoteBalanceBefore = IERC20(details.tokenOut).balanceOf(address(this));

        _safeApproveWithReset(tokenInContract, details.poolAddress, amountIn);

        // Pro-rate the full-size minimum to the collateral Ajna actually sent (mirrors the
        // 1inch _normalizeOneInchSwapAmounts pattern for debt-constrained partial fills).
        uint256 amountOutMin =
            TakerTakeScaling.scaleAmountOutMinimum(details.amountOutMinimum, amountIn, plannedAmountIn);

        bytes memory swapCalldata;
        if (details.poolType == POOL_TYPE_STABLE) {
            // StableSwap pools use int128 indices. The 4-arg base form exists on every
            // StableSwap generation (legacy and -NG, whose optional receiver defaults to
            // msg.sender via Vyper default arguments).
            swapCalldata = abi.encodeWithSignature(
                "exchange(int128,int128,uint256,uint256)",
                int128(uint128(details.tokenInIndex)),  // Cast to int128 for StableSwap
                int128(uint128(details.tokenOutIndex)), // Cast to int128 for StableSwap
                amountIn,
                amountOutMin
            );
        } else {
            // CryptoSwap pools use uint256 indices. AUDIT FIX: call the 4-arg base form,
            // which every CryptoSwap generation exposes (Vyper emits one selector per
            // default-argument arity). The previous 6-arg encoding only exists on newer
            // -NG pools — tricrypto2 (use_eth, no receiver) and V2 factory crypto pools
            // lack it, so documented tricrypto targets always reverted.
            // Defaults are what we want anyway: use_eth=false, receiver=msg.sender=this
            // taker; the balance-delta check below verifies the output actually arrived.
            swapCalldata = abi.encodeWithSignature(
                "exchange(uint256,uint256,uint256,uint256)",
                uint256(details.tokenInIndex),   // uint256 for CryptoSwap
                uint256(details.tokenOutIndex),  // uint256 for CryptoSwap
                amountIn,
                amountOutMin
            );
        }

        // Execute the swap; Address.functionCall bubbles reverts and fails loudly on a
        // non-contract pool address. The balance-delta check below is the output guard.
        Address.functionCall(details.poolAddress, swapCalldata, "Curve swap failed");

        _safeApproveWithReset(tokenInContract, details.poolAddress, 0);

        uint256 quoteReceived = IERC20(details.tokenOut).balanceOf(address(this)) - quoteBalanceBefore;
        if (quoteReceived < amountOutMin || quoteReceived < quoteAmountDueCeiling) {
            revert InsufficientQuoteReceived();
        }

        emit SwapExecuted(details.tokenIn, details.tokenOut, amountIn, quoteReceived);
    }
}
