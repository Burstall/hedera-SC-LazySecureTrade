// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

/// @title MockRevertingBCF
/// @notice Test-only contract that satisfies the `stashOwnerOf` ABI used
///         by `LazySecureTrade._resolveBeneficialOwner` but always
///         reverts. Used to validate the try/catch graceful-degrade path:
///         `setBcf(mockReverter)` followed by a trade execution must
///         succeed at the base (no-resolution) fee tier — proving a
///         buggy or hostile BCF v2 can't brick LST trades.
/// @dev    Not deployed in production. Lives under `contracts/test/`
///         alongside the CREATE2 probe contracts so the production
///         build doesn't accidentally pick it up.
contract MockRevertingBCF {
    error AlwaysReverts();

    /// @notice Always reverts with `AlwaysReverts()`. The signature
    ///         matches `IBidderContractFactory.stashOwnerOf` so any
    ///         caller that wraps the call in try/catch (LST does) will
    ///         hit the catch branch.
    function stashOwnerOf(address) external pure returns (address) {
        revert AlwaysReverts();
    }
}
