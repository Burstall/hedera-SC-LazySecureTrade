// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {LSHTierLib} from "../libraries/LSHTierLib.sol";

/// @title LSHTierLibProbe
/// @notice Thin external wrapper around `LSHTierLib`. Library functions
///         are `internal view` so they cannot be called directly from
///         outside Solidity — this probe exposes them via external
///         entry points so Hardhat tests can exercise the library
///         against mock LSH / LDR / staking contracts.
/// @dev    Test-only; not deployed in production. Lives under
///         `contracts/test/` to keep it out of the production build.
contract LSHTierLibProbe {
    function tierFor(
        address user,
        LSHTierLib.TierSources calldata sources
    ) external view returns (LSHTierLib.Tier) {
        return LSHTierLib.getTierFor(user, sources);
    }

    function anyHolder(
        address user,
        LSHTierLib.TierSources calldata sources
    ) external view returns (bool) {
        return LSHTierLib.isAnyHolder(user, sources);
    }
}
