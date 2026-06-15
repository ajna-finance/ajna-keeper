// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Pool, PoolDeployer } from "../AjnaInterfaces.sol";
import { IERC20 } from "../OneInchInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";
import { RouterAuthorizedTakerBase } from "./KeeperTakerBase.sol";
import { TakerTakeScaling } from "../libraries/TakerTakeScaling.sol";

/// @notice Shared layer for calldata-aggregator takers: executes one
///         allowlisted, opaque aggregator transaction during the Ajna take
///         callback and trusts only token balance deltas.
/// @dev Promoted out of LifiKeeperTaker (SushiSwap aggregator roadmap, Packet
///      2B) without behavior changes. Every calldata-aggregator taker executes
///      arbitrary allowlisted calldata, so this layer owns the audited
///      mechanics the direct-DEX takers intentionally omit:
///      - per-deployment call-target / approval-spender / per-target selector
///        allowlists (storage, setters, getters, enforcement)
///      - the active-callback binding (pool + calldata hash) set and cleared
///        around pool.take
///      - the exact source-balance check: calldata aggregators are exact-fill
///        by construction (opaque provider calldata cannot be re-sized
///        on-chain), so off-chain sizing debt-clamps the take and this layer
///        rejects any mismatch. Do not port the factory takers' partial-fill
///        pro-rating into this layer.
///      - the allowlisted low-level call with raw revert bubbling, the
///        code-existence check, and the zero-value ERC20 route policy
///      - the output backstop quoteReceived >= max(amountOutMinimum,
///        TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue)); the
///        ceiling (+1 token-wei when quoteTokenScale > 1) covers the pool's
///        ceil-divided quote pull (merged audited invariant — a floored-due
///        comparison reintroduces the failed-take bug PR #17 fixed for
///        non-18-decimal quote tokens)
///      Provider wrappers stay thin: construction, source identity, and a
///      provider-distinct execution event (LifiSwapExecuted precedent — never
///      overload the base SwapExecuted name).
abstract contract BaseAggregatorCalldataTaker is RouterAuthorizedTakerBase {
    struct AggregatorSwapDetails {
        address approvalSpender;
        address srcToken;
        address dstToken;
        address dstReceiver;
        uint256 amountInTokenUnits;
        uint256 amountOutMinimum;
        bytes callData;
    }

    mapping(address => bool) private _callTargets;
    mapping(address => bool) private _approvalSpenders;
    mapping(address => mapping(bytes4 => bool)) private _callSelectors;
    mapping(address => bool) private _knownCallTargets;
    mapping(address => bool) private _knownApprovalSpenders;
    mapping(address => mapping(bytes4 => bool)) private _knownCallSelectors;
    address[] private _callTargetList;
    address[] private _approvalSpenderList;
    mapping(address => bytes4[]) private _callSelectorList;
    address private _activeCallbackPool;
    bytes32 private _activeCallbackDataHash;

    event CallTargetUpdated(address indexed target, bool allowed);
    event ApprovalSpenderUpdated(address indexed spender, bool allowed);
    event CallSelectorUpdated(address indexed target, bytes4 indexed selector, bool allowed);

    error CallTargetNotAllowed();
    error CallTargetHasNoCode();
    error ApprovalSpenderNotAllowed();
    error SelectorNotAllowed();
    error StaleSourceBalance();
    error UnexpectedSourceBalance();
    error SourceNotConsumed();
    error UnexpectedCallback();

    /// @param ajnaErc20PoolFactory Ajna ERC20 pool factory for the deployment.
    /// @param authorizedRouter_ Router contract address that can also call functions.
    ///        Unlike the direct-DEX takers, calldata-aggregator takers are
    ///        router-only by design and refuse standalone (zero router)
    ///        deployment.
    constructor(PoolDeployer ajnaErc20PoolFactory, address authorizedRouter_)
        RouterAuthorizedTakerBase(ajnaErc20PoolFactory, authorizedRouter_)
    {
        require(authorizedRouter_ != address(0), "Zero authorized router");
    }

    /// @dev Provider wrappers declare which single liquidity source they serve.
    function _isSupportedSource(LiquiditySource source) internal pure virtual returns (bool);

    /// @dev Provider wrappers emit their provider-distinct execution event here.
    function _emitAggregatorSwapExecuted(
        address tokenIn,
        address tokenOut,
        address target,
        uint256 amountIn,
        uint256 amountOut
    ) internal virtual;

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
        if (!_isSupportedSource(source)) revert UnsupportedSource();
        if (!_validatePool(pool)) revert InvalidPool();

        AggregatorSwapDetails memory details = abi.decode(swapDetails, (AggregatorSwapDetails));
        _validateSwapDetails(pool, swapRouter, details);
        if (IERC20(details.srcToken).balanceOf(address(this)) != 0) {
            revert StaleSourceBalance();
        }
        if (_activeCallbackPool != address(0)) {
            revert UnexpectedCallback();
        }

        bytes memory data = abi.encode(details, swapRouter);
        _approveQuoteForTake(pool, maxAmount, auctionPrice);

        _activeCallbackPool = address(pool);
        _activeCallbackDataHash = keccak256(data);
        pool.take(borrowerAddress, maxAmount, address(this), data);
        _activeCallbackPool = address(0);
        _activeCallbackDataHash = bytes32(0);

        // srcToken is validated equal to the pool collateral, so the standard
        // settle sweep covers both the quote profit and any unconsumed source.
        _settleAfterTake(pool);
    }

    /// @notice Called by the Ajna pool after it sends callback collateral to this taker.
    function atomicSwapCallback(
        uint256,
        uint256 quoteAmountDue,
        bytes calldata data
    ) external override nonReentrant {
        IERC20Pool pool = IERC20Pool(msg.sender);
        if (!_validatePool(pool)) revert InvalidPool();
        if (msg.sender != _activeCallbackPool || keccak256(data) != _activeCallbackDataHash) {
            revert UnexpectedCallback();
        }

        (AggregatorSwapDetails memory details, address swapRouter) = abi.decode(data, (AggregatorSwapDetails, address));
        _validateSwapDetails(pool, swapRouter, details);
        _executeAggregatorCall(pool, quoteAmountDue, swapRouter, details);
    }

    function setCallTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert InvalidSwapDetails();
        if (!_knownCallTargets[target]) {
            _knownCallTargets[target] = true;
            _callTargetList.push(target);
        }
        _callTargets[target] = allowed;
        emit CallTargetUpdated(target, allowed);
    }

    function setApprovalSpender(address spender, bool allowed) external onlyOwner {
        if (spender == address(0)) revert InvalidSwapDetails();
        if (!_knownApprovalSpenders[spender]) {
            _knownApprovalSpenders[spender] = true;
            _approvalSpenderList.push(spender);
        }
        _approvalSpenders[spender] = allowed;
        emit ApprovalSpenderUpdated(spender, allowed);
    }

    function setCallSelector(address target, bytes4 selector, bool allowed) external onlyOwner {
        if (target == address(0) || selector == bytes4(0)) revert InvalidSwapDetails();
        if (!_knownCallSelectors[target][selector]) {
            _knownCallSelectors[target][selector] = true;
            _callSelectorList[target].push(selector);
        }
        _callSelectors[target][selector] = allowed;
        emit CallSelectorUpdated(target, selector, allowed);
    }

    function isCallTargetAllowed(address target) external view returns (bool) {
        return _callTargets[target];
    }

    function isApprovalSpenderAllowed(address spender) external view returns (bool) {
        return _approvalSpenders[spender];
    }

    function isCallSelectorAllowed(address target, bytes4 selector) external view returns (bool) {
        return _callSelectors[target][selector];
    }

    function getAllowedCallTargets() external view returns (address[] memory targets) {
        uint256 count = 0;
        for (uint256 i = 0; i < _callTargetList.length; i++) {
            if (_callTargets[_callTargetList[i]]) {
                count++;
            }
        }
        targets = new address[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < _callTargetList.length; i++) {
            address target = _callTargetList[i];
            if (_callTargets[target]) {
                targets[index] = target;
                index++;
            }
        }
    }

    function getAllowedApprovalSpenders() external view returns (address[] memory spenders) {
        uint256 count = 0;
        for (uint256 i = 0; i < _approvalSpenderList.length; i++) {
            if (_approvalSpenders[_approvalSpenderList[i]]) {
                count++;
            }
        }
        spenders = new address[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < _approvalSpenderList.length; i++) {
            address spender = _approvalSpenderList[i];
            if (_approvalSpenders[spender]) {
                spenders[index] = spender;
                index++;
            }
        }
    }

    function getAllowedCallSelectors(address target) external view returns (bytes4[] memory selectors) {
        uint256 count = 0;
        for (uint256 i = 0; i < _callSelectorList[target].length; i++) {
            if (_callSelectors[target][_callSelectorList[target][i]]) {
                count++;
            }
        }
        selectors = new bytes4[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < _callSelectorList[target].length; i++) {
            bytes4 selector = _callSelectorList[target][i];
            if (_callSelectors[target][selector]) {
                selectors[index] = selector;
                index++;
            }
        }
    }

    function _executeAggregatorCall(
        IERC20Pool pool,
        uint256 quoteAmountDue,
        address swapRouter,
        AggregatorSwapDetails memory details
    ) private {
        IERC20 srcToken = IERC20(details.srcToken);
        IERC20 dstToken = IERC20(details.dstToken);
        uint256 sourceBalanceBefore = srcToken.balanceOf(address(this));
        if (sourceBalanceBefore != details.amountInTokenUnits) {
            revert UnexpectedSourceBalance();
        }

        uint256 quoteBalanceBefore = dstToken.balanceOf(address(this));
        _safeApproveWithReset(srcToken, details.approvalSpender, details.amountInTokenUnits);
        _callAggregatorTarget(swapRouter, details.callData);
        _safeApproveWithReset(srcToken, details.approvalSpender, 0);

        uint256 quoteReceived = dstToken.balanceOf(address(this)) - quoteBalanceBefore;
        uint256 quoteAmountDueCeiling = TakerTakeScaling.quoteAmountDueCeiling(pool, quoteAmountDue);
        uint256 requiredQuoteReceived = details.amountOutMinimum > quoteAmountDueCeiling
            ? details.amountOutMinimum
            : quoteAmountDueCeiling;
        if (quoteReceived < requiredQuoteReceived) {
            revert InsufficientQuoteReceived();
        }

        _emitAggregatorSwapExecuted(
            pool.collateralAddress(),
            pool.quoteTokenAddress(),
            swapRouter,
            details.amountInTokenUnits,
            quoteReceived
        );
    }

    function _callAggregatorTarget(address swapRouter, bytes memory callData) private {
        (bool success, bytes memory returnData) = swapRouter.call(callData);
        if (success) {
            return;
        }
        if (returnData.length > 0) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
        revert SwapFailed();
    }

    function _validateSwapDetails(
        IERC20Pool pool,
        address swapRouter,
        AggregatorSwapDetails memory details
    ) private view {
        if (
            swapRouter == address(0) ||
            details.approvalSpender == address(0) ||
            details.srcToken != pool.collateralAddress() ||
            details.dstToken != pool.quoteTokenAddress() ||
            details.dstReceiver != address(this) ||
            details.amountInTokenUnits == 0 ||
            details.amountOutMinimum == 0 ||
            details.callData.length < 4
        ) {
            revert InvalidSwapDetails();
        }
        if (!_callTargets[swapRouter]) revert CallTargetNotAllowed();
        // A low-level call to an address with no code returns success with empty
        // return data, so a misconfigured (or self-destructed) allowlisted target
        // would no-op rather than swap. Defense-in-depth alongside the off-chain
        // preflight code-existence check: fail closed before the call is made.
        if (swapRouter.code.length == 0) revert CallTargetHasNoCode();
        if (!_approvalSpenders[details.approvalSpender]) revert ApprovalSpenderNotAllowed();
        if (!_callSelectors[swapRouter][_selector(details.callData)]) revert SelectorNotAllowed();
    }

    function _selector(bytes memory callData) private pure returns (bytes4 selector) {
        assembly {
            selector := mload(add(callData, 32))
        }
    }
}
