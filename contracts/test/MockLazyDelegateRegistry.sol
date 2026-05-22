// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

/// @title MockLazyDelegateRegistry
/// @notice Test-only LDR that implements just `getSerialsDelegatedTo`.
///         Configurable per-(delegate, token) serial list + a global
///         "always revert" flag for the LST-style resilience tests.
/// @dev    Library functions wrap LDR calls in try/catch and treat any
///         revert as "no delegation" — toggling `revertAll` lets us
///         exercise that path without deploying a separately-malformed
///         contract.
contract MockLazyDelegateRegistry {
    error MockLdrRevert();

    bool public revertAll;
    mapping(address => mapping(address => uint256[])) private _delegated;

    function setRevertAll(bool flag) external {
        revertAll = flag;
    }

    function setDelegated(
        address delegate,
        address token,
        uint256[] calldata serials
    ) external {
        delete _delegated[delegate][token];
        for (uint256 i; i < serials.length; ++i) {
            _delegated[delegate][token].push(serials[i]);
        }
    }

    function getSerialsDelegatedTo(
        address delegate,
        address token
    ) external view returns (uint256[] memory) {
        if (revertAll) revert MockLdrRevert();
        return _delegated[delegate][token];
    }
}
