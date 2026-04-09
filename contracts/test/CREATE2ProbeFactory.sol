// SPDX-License-Identifier: ISC
pragma solidity >=0.8.12 <0.9.0;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CREATE2Probe} from "./CREATE2Probe.sol";

/// @title CREATE2ProbeFactory
/// @notice Deploys CREATE2Probe clones using Clones.cloneDeterministic to
///         validate Hedera EVM's CREATE2 behaviour before the production
///         stash factory adopts the pattern in Phase 2.
/// @dev This contract is TEST-ONLY. It mirrors the shape of the planned
///      BidderContractFactory CREATE2 surface:
///        - predictProbe(user)  → address (pure, off-chain derivable)
///        - deployProbe(user)   → address (permissionless, atomic init)
///
///      The salt uses the exact same scheme Phase 2 will use for stashes,
///      just with a different version tag, so the derivation logic can be
///      validated end-to-end.
contract CREATE2ProbeFactory {
    /// @notice Immutable implementation address — locked at deploy time.
    ///         Any change to this address would shift every predicted clone
    ///         address, which is why the production Factory must also keep
    ///         BIDDER_CONTRACT_IMPLEMENTATION immutable.
    address public immutable PROBE_IMPLEMENTATION;

    /// @notice Deployed probes indexed by user.
    mapping(address => address) public userToProbe;

    /// @notice All deployed probes for enumeration.
    address[] public allProbes;

    event ProbeDeployed(
        address indexed user,
        address indexed probe,
        address indexed deployer
    );

    error ImplementationZero();
    error ProbeAlreadyExists(address existing);

    constructor(address _probeImplementation) {
        if (_probeImplementation == address(0)) revert ImplementationZero();
        PROBE_IMPLEMENTATION = _probeImplementation;
    }

    /// @notice Predict the address a probe will be deployed at for `user`.
    /// @dev Pure CREATE2 derivation — no storage access beyond the immutable
    ///      implementation address. Safe to call off-chain without an RPC.
    /// @param user The address whose probe address should be predicted.
    /// @return The address at which cloneDeterministic will deploy (or has
    ///         already deployed) the probe for this user.
    function predictProbe(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddress(
                PROBE_IMPLEMENTATION,
                _probeSalt(user),
                address(this)
            );
    }

    /// @notice Deploy a probe for `user`. Permissionless — anyone can call.
    /// @dev The caller (msg.sender) is NOT the owner. The recorded owner is
    ///      `user`, matching the production pattern where a third party can
    ///      deploy a stash on behalf of a user without hijacking it.
    /// @param user The address to record as the probe's owner.
    /// @return probe The deployed probe address.
    function deployProbe(address user) external returns (address probe) {
        if (userToProbe[user] != address(0)) {
            revert ProbeAlreadyExists(userToProbe[user]);
        }

        probe = Clones.cloneDeterministic(
            PROBE_IMPLEMENTATION,
            _probeSalt(user)
        );

        CREATE2Probe(probe).initialize(user);

        userToProbe[user] = probe;
        allProbes.push(probe);

        emit ProbeDeployed(user, probe, msg.sender);
    }

    /// @notice Returns the total number of probes deployed.
    function getProbeCount() external view returns (uint256) {
        return allProbes.length;
    }

    /// @notice Returns whether a probe has been deployed at its predicted address.
    ///         Uses extcodesize to distinguish "predicted but not yet deployed"
    ///         from "deployed and live".
    function isProbeDeployed(address user) external view returns (bool) {
        address predicted = predictProbe(user);
        uint256 size;
        assembly {
            size := extcodesize(predicted)
        }
        return size > 0;
    }

    /// @dev Salt derivation — kept identical in shape to the planned
    ///      production stash salt. Version prefix lets us ever migrate by
    ///      bumping the version string rather than redeploying the factory.
    function _probeSalt(address user) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("LST_PROBE_v1", user));
    }
}
