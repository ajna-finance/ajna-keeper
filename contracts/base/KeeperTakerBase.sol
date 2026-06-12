// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IERC20Pool, PoolDeployer } from "../AjnaInterfaces.sol";
import { IERC20 } from "../OneInchInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";

/// @notice Shared core for all keeper taker contracts: deployment wiring, pool
///         validation, approval/sweep helpers, and the standard swap event.
/// @dev AUDIT FIX: consolidates the helpers that were previously copy-pasted
///      across the five takers (and had already drifted in comments) so a
///      future fix lands exactly once.
///      Deliberately does NOT expose an `authorizedFactory` getter: the
///      standalone AjnaKeeperTaker inherits this layer directly because
///      AjnaKeeperTakerFactory's legacy-taker detection keys on that getter's
///      absence.
abstract contract KeeperTakerBase is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Hash used for all ERC20 pools, used for pool validation
    bytes32 public constant ERC20_NON_SUBSET_HASH = keccak256("ERC20_NON_SUBSET_HASH");

    /// @dev Actor allowed to take auctions using this contract
    address internal immutable _owner;

    /// @dev Identifies the Ajna deployment, used to validate pools
    PoolDeployer internal immutable _poolFactory;

    /// @dev Standard per-swap monitoring event. LifiKeeperTaker overloads this
    ///      with an extra indexed call-target parameter (different topic0).
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    /// @notice Caller is not authorized for this function.
    error Unauthorized();              // sig: 0x82b42900
    /// @notice Pool is not from the Ajna deployment configured in this contract.
    error InvalidPool();               // sig: 0x2083cd40
    /// @notice The provided swap details are inconsistent with the Ajna pool assets or receiver.
    error InvalidSwapDetails();        // sig: 0x21d83cf6
    /// @notice External swap did not deliver enough quote token to satisfy Ajna's callback requirement.
    error InsufficientQuoteReceived();

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    constructor(PoolDeployer ajnaErc20PoolFactory) {
        // A zero pool factory bricks the taker: _validatePool can never pass.
        require(address(ajnaErc20PoolFactory) != address(0), "Zero pool factory");
        _owner = msg.sender;
        _poolFactory = ajnaErc20PoolFactory;
    }

    /// @notice Returns the owner of this contract.
    function owner() public view virtual returns (address) {
        return _owner;
    }

    /// @notice Returns the Ajna pool factory this taker validates pools against.
    function poolFactory() public view virtual returns (PoolDeployer) {
        return _poolFactory;
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Unauthorized();
        _;
    }

    /// @dev Validates that the pool is from our Ajna deployment
    function _validatePool(IERC20Pool pool) internal view returns (bool) {
        return _poolFactory.deployedPools(ERC20_NON_SUBSET_HASH, pool.collateralAddress(), pool.quoteTokenAddress()) == address(pool);
    }

    /// @dev Multiplies two WADs and rounds up to the nearest decimal
    function _ceilWmul(uint256 x, uint256 y) internal pure returns (uint256) {
        return (x * y + 1e18 - 1) / 1e18;
    }

    /// @dev Safe approval that handles the non-zero to non-zero allowance issue
    ///      by resetting to zero first, the pattern SafeERC20 requires for
    ///      non-standard tokens like USDT.
    function _safeApproveWithReset(IERC20 token, address spender, uint256 amount) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance != 0) {
            token.safeApprove(spender, 0);
        }
        if (amount != 0) {
            token.safeApprove(spender, amount);
        }
    }

    /// @dev Recovers the full token balance to the owner
    function _recoverToken(IERC20 token) internal {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(_owner, balance);
        }
    }

    /// @dev Approves the pool to pull the worst-case quote repayment for a take:
    ///      ceil(maxAmount * auctionPrice) converted to quote token precision,
    ///      rounded up so it always covers the pool's ceil-divided pull.
    function _approveQuoteForTake(IERC20Pool pool, uint256 maxAmount, uint256 auctionPrice) internal {
        uint256 approvalAmount = Math.ceilDiv(_ceilWmul(maxAmount, auctionPrice), pool.quoteTokenScale());
        _safeApproveWithReset(IERC20(pool.quoteTokenAddress()), address(pool), approvalAmount);
    }

    /// @dev Post-take cleanup: clear the pool's quote allowance and sweep both
    ///      pool tokens to the owner (quote profit, plus any collateral a route
    ///      under-consumed or refunded).
    function _settleAfterTake(IERC20Pool pool) internal {
        _safeApproveWithReset(IERC20(pool.quoteTokenAddress()), address(pool), 0);
        _recoverToken(IERC20(pool.quoteTokenAddress()));
        _recoverToken(IERC20(pool.collateralAddress()));
    }
}

/// @notice Base for factory-managed takers: implements the IAjnaKeeperTaker
///         wiring getters, the shared owner-or-factory access control, and
///         token recovery.
abstract contract FactoryAuthorizedTakerBase is IAjnaKeeperTaker, KeeperTakerBase {
    /// @dev Factory contract that is also authorized to call functions.
    ///      May be zero to deploy the taker in standalone (owner-only) mode; the
    ///      keeper factory refuses to register a taker whose factory does not match.
    address internal immutable _authorizedFactory;

    /// @notice Emitted when the requested liquidity source is not handled by this taker.
    error UnsupportedSource();  // sig: 0x79b7ef0d
    /// @notice External swap could not be executed.
    error SwapFailed();         // sig: 0x81ceff30

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    /// @param authorizedFactory_ Factory contract address that can also call functions.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedFactory_)
        KeeperTakerBase(ajnaErc20PoolFactory)
    {
        _authorizedFactory = authorizedFactory_;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function owner() public view override(IAjnaKeeperTaker, KeeperTakerBase) returns (address) {
        return _owner;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function poolFactory() public view override(IAjnaKeeperTaker, KeeperTakerBase) returns (PoolDeployer) {
        return _poolFactory;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function authorizedFactory() public view override returns (address) {
        return _authorizedFactory;
    }

    modifier onlyOwnerOrFactory() {
        if (msg.sender != _owner && msg.sender != _authorizedFactory) revert Unauthorized();
        _;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function recover(IERC20 token) external override onlyOwnerOrFactory {
        _recoverToken(token);
    }
}
