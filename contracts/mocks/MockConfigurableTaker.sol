// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoolDeployer } from "../AjnaInterfaces.sol";

/// @notice Minimal registerable taker for factory tests: passes setTaker
///         validation for a configurable source and reverts recover() in
///         configurable ways to exercise the factory's error bubbling.
contract MockConfigurableTaker {
    address public immutable owner;
    PoolDeployer public immutable poolFactory;
    address public immutable authorizedFactory;
    uint8 public immutable supportedSource;

    /// @dev 0 = succeed, 1 = revert custom error, 2 = revert string, 3 = revert empty
    uint8 public recoverMode;

    error CustomRecoveryError();

    constructor(PoolDeployer poolFactory_, address authorizedFactory_, uint8 supportedSource_) {
        owner = msg.sender;
        poolFactory = poolFactory_;
        authorizedFactory = authorizedFactory_;
        supportedSource = supportedSource_;
    }

    function setRecoverMode(uint8 recoverMode_) external {
        recoverMode = recoverMode_;
    }

    function isSourceSupported(uint8 source) external view returns (bool) {
        return source == supportedSource;
    }

    function recover(address) external view {
        if (recoverMode == 1) revert CustomRecoveryError();
        if (recoverMode == 2) revert("taker recovery reason");
        if (recoverMode == 3) revert();
    }
}
