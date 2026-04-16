// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockPoolDeployer {
    mapping(bytes32 => mapping(address => mapping(address => address))) public deployedPools;

    function setDeployedPool(
        bytes32 subsetHash,
        address collateralAddress,
        address quoteTokenAddress,
        address poolAddress
    ) external {
        deployedPools[subsetHash][collateralAddress][quoteTokenAddress] = poolAddress;
    }
}
