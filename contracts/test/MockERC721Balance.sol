// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

/// @title MockERC721Balance
/// @notice Test-only stub that satisfies the `IERC721.balanceOf` shape
///         used by LSHTierLib. Implements ONLY the subset the library
///         consumes (a single per-user balance setter) — not a full
///         ERC-721 implementation.
/// @dev    Lives under `contracts/test/` so production builds don't
///         link it.
contract MockERC721Balance {
    mapping(address => uint256) private _balance;

    function setBalance(address user, uint256 bal) external {
        _balance[user] = bal;
    }

    function balanceOf(address user) external view returns (uint256) {
        return _balance[user];
    }
}
