// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IERC20Pool, PoolDeployer } from "../AjnaInterfaces.sol";
import { IERC20 } from "../OneInchInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { ISwapRouter02 } from "../interfaces/ISwapRouter02.sol";
import { TakerTakeScaling } from "../libraries/TakerTakeScaling.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Uniswap V3 implementation for Ajna keeper takes using direct SwapRouter02 execution.
contract UniswapV3KeeperTaker is IAjnaKeeperTaker, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256; 
   
    /// @notice Direct Uniswap V3 swap configuration encoded by the keeper.
    struct UniswapV3SwapDetails {
        address swapRouter;
        address targetToken;
        uint24 feeTier;
        uint256 amountOutMinimum;
        uint256 deadline;
    }

    /// @dev Hash used for all ERC20 pools
    bytes32 public constant ERC20_NON_SUBSET_HASH = keccak256("ERC20_NON_SUBSET_HASH");
    /// @dev Actor allowed to take auctions
    address public immutable owner;
    /// @dev Identifies the Ajna deployment
    PoolDeployer public immutable poolFactory;
    /// @dev Factory contract that can also call functions
    address public immutable authorizedFactory;

    // Production events
    event TakeExecuted(address indexed pool, address indexed borrower, uint256 collateralAmount, uint256 quoteAmount, LiquiditySource source, address indexed caller);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    // Errors
    error Unauthorized();
    error InvalidPool();
    error UnsupportedSource();
    error SwapFailed();
    error InvalidSwapDetails();
    error InsufficientQuoteReceived();

    constructor(PoolDeployer ajnaErc20PoolFactory, address _authorizedFactory) {
        owner = msg.sender;
        poolFactory = ajnaErc20PoolFactory;
        authorizedFactory = _authorizedFactory;
    }

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

        uint256 approvalAmount = Math.ceilDiv(_ceilWmul(maxAmount, auctionPrice), pool.quoteTokenScale());
        
        _safeApproveWithReset(IERC20(pool.quoteTokenAddress()), address(pool), approvalAmount);

        pool.take(borrowerAddress, maxAmount, address(this), data);
        
        _safeApproveWithReset(IERC20(pool.quoteTokenAddress()), address(pool), 0);

        _recoverToken(IERC20(pool.quoteTokenAddress()));
    }

    /// @notice Called by Pool to swap collateral for quote tokens
    function atomicSwapCallback(uint256 collateral, uint256 quoteAmountDue, bytes calldata data) external override nonReentrant {
        IERC20Pool pool = IERC20Pool(msg.sender);
        if (!_validatePool(pool)) revert InvalidPool();


        (UniswapV3SwapDetails memory details, uint256 plannedAmountIn) =
            abi.decode(data, (UniswapV3SwapDetails, uint256));
        if (
            details.swapRouter == address(0) ||
            details.targetToken != pool.quoteTokenAddress() ||
            details.deadline <= block.timestamp ||
            details.amountOutMinimum == 0 ||
            plannedAmountIn == 0
        ) revert InvalidSwapDetails();
        _swapWithUniswapV3(pool.collateralAddress(), details.targetToken, collateral, quoteAmountDue, plannedAmountIn, details);
    }

    /// @inheritdoc IAjnaKeeperTaker
    function recover(IERC20 token) external onlyOwnerOrFactory {
        _recoverToken(token);
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
    function _swapWithUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 quoteAmountDue,
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
        if (quoteReceived < amountOutMinimum || quoteReceived < quoteAmountDue) {
            revert InsufficientQuoteReceived();
        }
        emit SwapExecuted(tokenIn, tokenOut, amountIn, quoteReceived);
    }

    function _recoverToken(IERC20 token) private {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(owner, balance);
        }
    }

    function _validatePool(IERC20Pool pool) private view returns(bool) {
        return poolFactory.deployedPools(ERC20_NON_SUBSET_HASH, pool.collateralAddress(), pool.quoteTokenAddress()) == address(pool);
    }

    function _ceilWmul(uint256 x, uint256 y) internal pure returns (uint256) {
        return (x * y + 1e18 - 1) / 1e18;
    }

    function _safeApproveWithReset(IERC20 token, address spender, uint256 amount) private {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance != 0) {
            token.safeApprove(spender, 0);
        }
        if (amount != 0) {
            token.safeApprove(spender, amount);
        }
    }

    modifier onlyOwnerOrFactory() {
        if (msg.sender != owner && msg.sender != authorizedFactory) revert Unauthorized();
        _;
    }
}
