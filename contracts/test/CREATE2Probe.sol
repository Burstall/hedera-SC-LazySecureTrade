// SPDX-License-Identifier: ISC
pragma solidity >=0.8.12 <0.9.0;

/// @title CREATE2Probe
/// @notice Minimal implementation contract used to empirically validate
///         Clones.cloneDeterministic semantics on Hedera EVM before
///         committing the production stash architecture (Phase 2) to CREATE2.
/// @dev Deployed once as the implementation; cloned by CREATE2ProbeFactory
///      using deterministic salts derived from a user address. Each clone is
///      delegatecall-style minimal proxy pointing at this implementation.
///
///      This contract is PRODUCTION-IRRELEVANT — it exists solely to answer
///      six yes/no questions about Hedera EVM's CREATE2 support and mirror
///      node indexing of the deployed clones. See scripts/testing/create2Probe.js.
contract CREATE2Probe {
    /// @notice Initialization guard — set once, on the clone, by the factory.
    bool private initialized;

    /// @notice Owner recorded during initialize() — proves clone-state isolation.
    address public probeOwner;

    /// @notice Monotonic counter — proves clone-state mutation works independently
    ///         across multiple deployed clones pointing at the same implementation.
    uint256 public bumpCount;

    error AlreadyInitialized();
    error NotInitialized();

    /// @notice Lock the implementation contract itself against being initialized.
    ///         This is the Hedera equivalent of OZ's _disableInitializers() — it
    ///         ensures the implementation at its own address can never be hijacked
    ///         by a late initialize() call from an attacker.
    ///         Clones set their own `initialized=true` inside initialize() below.
    constructor() {
        initialized = true;
    }

    /// @notice Called by CREATE2ProbeFactory immediately after cloneDeterministic().
    /// @param _probeOwner The address recorded as the owner of this clone.
    function initialize(address _probeOwner) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        probeOwner = _probeOwner;
    }

    /// @notice Pure view — returns the clone's recorded owner.
    function getOwner() external view returns (address) {
        return probeOwner;
    }

    /// @notice Mutator — increments the per-clone counter so the test script
    ///         can verify that mutations on one clone don't bleed into another.
    function bump() external {
        if (!initialized) revert NotInitialized();
        unchecked {
            bumpCount++;
        }
    }

    /// @notice Pure view for the initialization guard (debugging only).
    function isInitialized() external view returns (bool) {
        return initialized;
    }
}
