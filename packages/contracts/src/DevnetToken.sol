// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// A plain ERC-20 for the frame-transaction devnet, where nobody outside the devnet operators can mint USDC.
/// Anyone may mint up to FAUCET_AMOUNT per call, so a fresh wallet can try a swap. The deployer mints any amount
/// (pool liquidity). The UI labels it as a devnet test token with no value.
contract DevnetToken is ERC20 {
    address public immutable minter;
    uint256 public immutable FAUCET_AMOUNT;

    error NotMinter();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetAmount_)
        ERC20(name_, symbol_, decimals_)
    {
        minter = msg.sender;
        FAUCET_AMOUNT = faucetAmount_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }

    /// Devnet faucet: FAUCET_AMOUNT to `to`.
    function faucet(address to) external {
        _mint(to, FAUCET_AMOUNT);
    }
}
