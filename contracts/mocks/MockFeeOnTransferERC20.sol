// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A fee-on-transfer ERC20: every transfer (not mint/burn) burns `feeBps` of the
/// amount, so the recipient receives strictly less than was sent. Used to
/// exercise the keeper's exact-fill backstop against fee-on-transfer tokens — a
/// swap/repayment with such a token under-delivers, which the take must reject
/// rather than under-repay the pool.
contract MockFeeOnTransferERC20 is ERC20 {
    uint8 private immutable _tokenDecimals;
    uint256 public immutable feeBps; // basis points, e.g. 200 == 2%

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBps_
    ) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
        feeBps = feeBps_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // Only transfers (not mints) route through _transfer, so the fee applies
    // exactly to peer-to-peer movement: the recipient receives less than sent.
    function _transfer(address from, address to, uint256 amount) internal override {
        if (feeBps > 0) {
            uint256 fee = (amount * feeBps) / 10_000;
            if (fee > 0) {
                super._transfer(from, to, amount - fee); // recipient receives net
                super._burn(from, fee); // fee burned from sender
                return;
            }
        }
        super._transfer(from, to, amount);
    }
}
