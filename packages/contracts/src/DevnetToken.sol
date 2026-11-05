// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// A plain ERC-20 for the frame-transaction devnet, where nobody outside the devnet operators can mint USDC.
/// Only the deployer mints. The UI labels it as a devnet test token.
contract DevnetToken is ERC20 {
    address public immutable minter;

    error NotMinter();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_, decimals_) {
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
