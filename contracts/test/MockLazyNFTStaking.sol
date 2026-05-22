// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

/// @title MockLazyNFTStaking
/// @notice Test-only stub for the `getStakedNFTs` shape consumed by
///         LSHTierLib. Lets tests configure a per-user stake set and
///         toggle a revert-all flag for resilience tests.
contract MockLazyNFTStaking {
    error MockStakingRevert();

    bool public revertAll;
    mapping(address => address[]) private _collections;
    mapping(address => uint256[][]) private _serials;

    function setRevertAll(bool flag) external {
        revertAll = flag;
    }

    /// @notice Configure a user's staked set. Replaces any prior state
    ///         for that user.
    function setStakedFor(
        address user,
        address[] calldata collections,
        uint256[][] calldata serials
    ) external {
        delete _collections[user];
        delete _serials[user];
        for (uint256 i; i < collections.length; ++i) {
            _collections[user].push(collections[i]);
            _serials[user].push();
            for (uint256 j; j < serials[i].length; ++j) {
                _serials[user][i].push(serials[i][j]);
            }
        }
    }

    function getStakedNFTs(address user)
        external
        view
        returns (address[] memory collections, uint256[][] memory serials)
    {
        if (revertAll) revert MockStakingRevert();
        return (_collections[user], _serials[user]);
    }
}
