// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IERC20Pool, PoolDeployer } from "../AjnaInterfaces.sol";
import { IERC20 } from "../OneInchInterfaces.sol";
import { IAjnaKeeperTaker } from "../interfaces/IAjnaKeeperTaker.sol";

/// @notice LI.FI same-chain implementation for Ajna keeper factory takes.
/// @dev Executes one allowlisted LI.FI transaction target during the Ajna callback and trusts only token balance deltas.
contract LifiKeeperTaker is IAjnaKeeperTaker, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LifiSwapDetails {
        address approvalSpender;
        address srcToken;
        address dstToken;
        address dstReceiver;
        uint256 amountInTokenUnits;
        uint256 amountOutMinimum;
        bytes callData;
    }

    bytes32 public constant ERC20_NON_SUBSET_HASH = keccak256("ERC20_NON_SUBSET_HASH");

    address public immutable owner;
    PoolDeployer public immutable poolFactory;
    address public immutable authorizedFactory;

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
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, address indexed target, uint256 amountIn, uint256 amountOut);

    error Unauthorized();
    error InvalidPool();
    error UnsupportedSource();
    error InvalidSwapDetails();
    error CallTargetNotAllowed();
    error CallTargetHasNoCode();
    error ApprovalSpenderNotAllowed();
    error SelectorNotAllowed();
    error StaleSourceBalance();
    error UnexpectedSourceBalance();
    error SourceNotConsumed();
    error SwapFailed();
    error InsufficientQuoteReceived();
    error UnexpectedCallback();

    constructor(PoolDeployer ajnaErc20PoolFactory, address _authorizedFactory) {
        if (address(ajnaErc20PoolFactory) == address(0) || _authorizedFactory == address(0)) {
            revert InvalidSwapDetails();
        }
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
        if (source != LiquiditySource.Lifi) revert UnsupportedSource();
        if (!_validatePool(pool)) revert InvalidPool();

        LifiSwapDetails memory details = abi.decode(swapDetails, (LifiSwapDetails));
        _validateSwapDetails(pool, swapRouter, details);
        if (IERC20(details.srcToken).balanceOf(address(this)) != 0) {
            revert StaleSourceBalance();
        }
        if (_activeCallbackPool != address(0)) {
            revert UnexpectedCallback();
        }

        bytes memory data = abi.encode(details, swapRouter);
        uint256 approvalAmount = Math.ceilDiv(_ceilWmul(maxAmount, auctionPrice), pool.quoteTokenScale());
        _safeApproveWithReset(IERC20(pool.quoteTokenAddress()), address(pool), approvalAmount);

        _activeCallbackPool = address(pool);
        _activeCallbackDataHash = keccak256(data);
        pool.take(borrowerAddress, maxAmount, address(this), data);
        _activeCallbackPool = address(0);
        _activeCallbackDataHash = bytes32(0);

        _safeApproveWithReset(IERC20(pool.quoteTokenAddress()), address(pool), 0);
        _recoverToken(IERC20(pool.quoteTokenAddress()));

        if (IERC20(details.srcToken).balanceOf(address(this)) != 0) {
            revert SourceNotConsumed();
        }
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

        (LifiSwapDetails memory details, address swapRouter) = abi.decode(data, (LifiSwapDetails, address));
        _validateSwapDetails(pool, swapRouter, details);
        _executeLifiCall(pool, quoteAmountDue, swapRouter, details);
    }

    /// @inheritdoc IAjnaKeeperTaker
    function recover(IERC20 token) external onlyOwnerOrFactory {
        _recoverToken(token);
    }

    /// @inheritdoc IAjnaKeeperTaker
    function getSupportedSources() external pure returns (LiquiditySource[] memory sources) {
        sources = new LiquiditySource[](1);
        sources[0] = LiquiditySource.Lifi;
    }

    /// @inheritdoc IAjnaKeeperTaker
    function isSourceSupported(LiquiditySource source) external pure returns (bool supported) {
        return source == LiquiditySource.Lifi;
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

    function _executeLifiCall(
        IERC20Pool pool,
        uint256 quoteAmountDue,
        address swapRouter,
        LifiSwapDetails memory details
    ) private {
        IERC20 srcToken = IERC20(details.srcToken);
        IERC20 dstToken = IERC20(details.dstToken);
        uint256 sourceBalanceBefore = srcToken.balanceOf(address(this));
        if (sourceBalanceBefore != details.amountInTokenUnits) {
            revert UnexpectedSourceBalance();
        }

        uint256 quoteBalanceBefore = dstToken.balanceOf(address(this));
        _safeApproveWithReset(srcToken, details.approvalSpender, details.amountInTokenUnits);
        _callLifiTarget(swapRouter, details.callData);
        _safeApproveWithReset(srcToken, details.approvalSpender, 0);

        uint256 quoteReceived = dstToken.balanceOf(address(this)) - quoteBalanceBefore;
        uint256 requiredQuoteReceived = details.amountOutMinimum > quoteAmountDue
            ? details.amountOutMinimum
            : quoteAmountDue;
        if (quoteReceived < requiredQuoteReceived) {
            revert InsufficientQuoteReceived();
        }
        if (srcToken.balanceOf(address(this)) != 0) {
            revert SourceNotConsumed();
        }

        emit SwapExecuted(pool.collateralAddress(), pool.quoteTokenAddress(), swapRouter, details.amountInTokenUnits, quoteReceived);
    }

    function _callLifiTarget(address swapRouter, bytes memory callData) private {
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
        LifiSwapDetails memory details
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

    function _recoverToken(IERC20 token) private {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(owner, balance);
        }
    }

    function _validatePool(IERC20Pool pool) private view returns (bool) {
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

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrFactory() {
        if (msg.sender != owner && msg.sender != authorizedFactory) revert Unauthorized();
        _;
    }
}
