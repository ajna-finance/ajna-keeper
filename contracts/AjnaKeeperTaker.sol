// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Pool, IERC20Taker, PoolDeployer } from "./AjnaInterfaces.sol";
import { IAggregationExecutor, IERC20, IGenericRouter, SwapDescription } from "./OneInchInterfaces.sol";
import { KeeperTakerBase } from "./base/KeeperTakerBase.sol";
import { TakerTakeScaling } from "./libraries/TakerTakeScaling.sol";

/// @notice Allows a keeper to take auctions using external liquidity sources.
/// @dev Standalone (non-factory) taker. Inherits KeeperTakerBase but deliberately
///      NOT FactoryAuthorizedTakerBase: AjnaKeeperTakerFactory's legacy-taker
///      detection identifies this contract family by the absence of an
///      `authorizedFactory()` getter.
contract AjnaKeeperTaker is IERC20Taker, KeeperTakerBase {
    /// @notice Identifies the source of liquidity to use for the swap.
    enum LiquiditySource {
        None, // (do not use)
        OneInch
    }

    /// @notice Use this to pass configuration data from the keeper to the callback function.
    struct SwapData {
        LiquiditySource source; // determines which type of AMM, which the callback function interacts with
        address router;         // address of the AMM router to interact with
        bytes details;          // source-specific data needed to perform the swap,
                                // which may be populated by an external API
    }

    struct OneInchSwapDetails {
        address aggregationExecutor;     // 1inch executor which will receive collateral
        SwapDescription swapDescription; // identifies tokens and amounts to swap
        bytes opaqueData;                // passed through from 1inch API to router
    }

    // sig: 0xf54a7ed9
    /// @notice Emitted when the requested liquidity source is not available on this deployment of the contract.
    error UnsupportedLiquiditySource();

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment of Ajna the keeper is interacting with.
    constructor(PoolDeployer ajnaErc20PoolFactory) KeeperTakerBase(ajnaErc20PoolFactory) {}

    /// @notice Owner may call to recover legitimate ERC20 tokens sent to this contract.
    function recover(IERC20 token) public onlyOwner {
        _recoverToken(token);
    }

    /// @notice Called by keeper to invoke `Pool.take`, passing `IERC20Taker` callback data.
    /// @param pool ERC20 pool with an active auction.
    /// @param borrowerAddress Identifies the liquidation to take.
    /// @param auctionPrice Last known price of the auction, in `WAD` precision, used for quote token approval.
    /// @param maxAmount Limit collateral to take from the auction, in `WAD` precision.
    /// @param source Identifies the source of liquidity to use for the swap (e.g. 1inch).
    /// @param swapRouter Address of the router to use for the swap.
    /// @param swapDetails Source-specific data needed to perform the swap, which may be populated by an external API.
    function takeWithAtomicSwap(
        IERC20Pool pool,
        address borrowerAddress,
        uint256 auctionPrice,
        uint256 maxAmount,
        LiquiditySource source,
        address swapRouter,
        bytes calldata swapDetails
    ) external onlyOwner {
        if (!_validatePool(pool)) revert InvalidPool();

        // configuration passed through to the callback function instructing this contract how to swap
        bytes memory data = abi.encode(
            SwapData({
                source: source,
                router: swapRouter,
                details: swapDetails
            })
        );

        _approveQuoteForTake(pool, maxAmount, auctionPrice);

        // invoke the take
        pool.take(borrowerAddress, maxAmount, address(this), data);

        // Clears the pool allowance and sweeps quote profit plus any collateral a
        // 1inch route under-consumed (would otherwise strand here).
        _settleAfterTake(pool);
    }

    /// @dev Called by `Pool` to allow a taker to externally swap collateral for quote token.
    /// @param data Determines where external liquidity should be sourced to swap collateral for quote token.
    /// @dev `nonReentrant` blocks a malicious router/executor from re-entering this callback through a
    ///      SECOND pool's `take` while a swap is in flight. `_validatePool` only verifies the caller is
    ///      *a* registered pool, and the pool's own reentrancy guard only covers same-pool re-entry, so
    ///      neither stops that cross-pool path on its own.
    function atomicSwapCallback(uint256 collateral, uint256 quoteAmountDue, bytes calldata data) external override nonReentrant {
        SwapData memory swapData = abi.decode(data, (SwapData));

        // Ensure msg.sender is a valid Ajna pool and matches the pool in the data
        IERC20Pool pool = IERC20Pool(msg.sender);
        if (!_validatePool(pool)) revert InvalidPool();

        if (swapData.source == LiquiditySource.OneInch)
        {
            OneInchSwapDetails memory details = abi.decode(swapData.details, (OneInchSwapDetails));
            _swapWithOneInch(
                pool,
                IGenericRouter(swapData.router),
                details.aggregationExecutor,
                details.swapDescription,
                details.opaqueData,
                collateral, // Already in token precision from Ajna
                quoteAmountDue
            );
        } else {
            revert UnsupportedLiquiditySource();
        }
    }

    /// @dev Called by atomicSwapCallback to swap collateral for quote token using 1inch.
    /// @param swapRouter 1inch router to which transaction will be sent
    /// @param aggregationExecutor 1inch executor which will receive collateral
    /// @param swapDescription 1inch swap description
    /// @param swapData opaque calldata from 1inch API
    /// @param actualCollateralAmount collateral received from take, in token precision
    function _swapWithOneInch(
        IERC20Pool pool,
        IGenericRouter swapRouter,
        address aggregationExecutor,
        SwapDescription memory swapDescription,
        bytes memory swapData,
        uint256 actualCollateralAmount,
        uint256 quoteAmountDue
    ) private {
        if (
            address(swapDescription.srcToken) != pool.collateralAddress() ||
            address(swapDescription.dstToken) != pool.quoteTokenAddress() ||
            swapDescription.dstReceiver != address(this)
        ) revert InvalidSwapDetails();

        IERC20 quoteToken = IERC20(pool.quoteTokenAddress());
        uint256 quoteBalanceBefore = quoteToken.balanceOf(address(this));
        (, uint256 normalizedMinReturnAmount) = _normalizeOneInchSwapAmounts(
            swapDescription,
            actualCollateralAmount
        );
        uint256 quoteAmountDueCeiling = TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue);
        uint256 requiredQuoteReceived =
            normalizedMinReturnAmount > quoteAmountDueCeiling
                ? normalizedMinReturnAmount
                : quoteAmountDueCeiling;

        _executeOneInchSwap(
            swapRouter,
            aggregationExecutor,
            swapDescription,
            swapData,
            actualCollateralAmount
        );

        uint256 quoteReceived = quoteToken.balanceOf(address(this)) - quoteBalanceBefore;
        if (quoteReceived < requiredQuoteReceived) revert InsufficientQuoteReceived();

        // AUDIT FIX: this taker previously emitted no events at all, leaving direct
        // 1inch takes invisible to per-swap monitoring (factory-taker parity).
        emit SwapExecuted(pool.collateralAddress(), pool.quoteTokenAddress(), actualCollateralAmount, quoteReceived);
    }

    function _executeOneInchSwap(
        IGenericRouter swapRouter,
        address aggregationExecutor,
        SwapDescription memory swapDescription,
        bytes memory swapData,
        uint256 actualCollateralAmount
    ) private {
        _safeApproveWithReset(swapDescription.srcToken, address(swapRouter), actualCollateralAmount);

        // scale the return amount to the actual amount
        (uint256 normalizedAmount, uint256 normalizedMinReturnAmount) = _normalizeOneInchSwapAmounts(
            swapDescription,
            actualCollateralAmount
        );
        if (normalizedAmount != swapDescription.amount) {
            swapDescription.amount = normalizedAmount;
            swapDescription.minReturnAmount = normalizedMinReturnAmount;
        }

        // execute the swap
        swapRouter.swap(
            IAggregationExecutor(aggregationExecutor),
            swapDescription,
            swapData
        );

        _safeApproveWithReset(swapDescription.srcToken, address(swapRouter), 0);
    }

    function _normalizeOneInchSwapAmounts(
        SwapDescription memory swapDescription,
        uint256 actualCollateralAmount
    ) private pure returns (uint256 normalizedAmount, uint256 normalizedMinReturnAmount) {
        normalizedAmount = swapDescription.amount;
        normalizedMinReturnAmount = swapDescription.minReturnAmount;

        if (normalizedAmount != actualCollateralAmount) {
            if (normalizedAmount == 0) revert InvalidSwapDetails();
            // AUDIT FIX: round the pro-rated floor up (was floor division), matching
            // TakerTakeScaling semantics used by the factory takers so an
            // underdelivering route cannot pass here by the rounding wei.
            normalizedMinReturnAmount = TakerTakeScaling.scaleAmountOutMinimum(
                normalizedMinReturnAmount,
                actualCollateralAmount,
                normalizedAmount
            );
            normalizedAmount = actualCollateralAmount;
        }
    }


    /// @dev Called by query-1inch.ts to test mutating calldata to send to 1inch GenericRouter.swap.
    ///      Owner-gated tooling that approves and calls an arbitrary owner-supplied router with no
    ///      output check; it grants nothing beyond what the owner already controls, but consider
    ///      deploying without these helpers if the tooling flow is not needed in production.
    function testOneInchSwapBytes(
        IGenericRouter swapRouter,
        bytes calldata swapDetails,
        uint256 actualCollateralAmount
    ) external onlyOwner {
        OneInchSwapDetails memory details = abi.decode(swapDetails, (OneInchSwapDetails));
        testOneInchSwapStruct(swapRouter, details, actualCollateralAmount);
    }

    /// @dev Called by query-1inch.ts to test mutating calldata to send to 1inch GenericRouter.swap
    function testOneInchSwapStruct(
        IGenericRouter swapRouter,
        OneInchSwapDetails memory swapDetails,
        uint256 actualCollateralAmount
    ) public onlyOwner {
        _executeOneInchSwap(
            swapRouter,
            swapDetails.aggregationExecutor,
            swapDetails.swapDescription,
            swapDetails.opaqueData,
            actualCollateralAmount
        );
    }
}
