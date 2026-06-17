// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoolDeployer } from "../AjnaInterfaces.sol";

/// @notice Test-only stand-in for old deployed standalone 1inch takers.
/// @dev It intentionally omits authorizedRouter() and isSourceSupported() so
///      TakerRouter exercises its legacy-incompatibility branch.
contract MockLegacyDirectOneInchTaker {
    address public immutable owner;
    PoolDeployer public immutable poolFactory;

    constructor(PoolDeployer poolFactory_) {
        owner = msg.sender;
        poolFactory = poolFactory_;
    }
}
