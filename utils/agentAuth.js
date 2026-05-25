// SPDX-License-Identifier: GPL-3.0
//
// AgentAuth tuple shape for tests + SDK consumers.
//
// Authentication model: msg.sender-only. Hedera's protocol layer
// validates the submitting account's transaction signature (ECDSA or
// ED25519, native to whatever key type the agent's Hedera account
// holds) before the EVM runs. Contracts check `msg.sender == agentKey`
// against the envelope's stored agentKey — no EIP-712 ceremony, no
// ecrecover. This works uniformly for both Hedera key types.
//
// AgentAuth wire form (matches the Solidity struct in IAgentEnvelope.sol):
//
//   struct AgentAuth {
//       address agentKey;            // address(0) = owner path
//       bytes32 reasoningTopicId;    // HCS-10 topic for off-chain trace
//   }

const { ethers } = require('ethers');

// ABI shape used by ethers / contractExecuteFunction.
const AGENT_AUTH_TUPLE_TYPE = '(address agentKey,bytes32 reasoningTopicId)';

// Tuple constant for the legacy / owner path. Pass this wherever a
// function takes `AgentAuth` but the caller is the stash owner /
// direct EOA (not an envelope-mediated agent).
const EMPTY_AUTH = Object.freeze([
    ethers.ZeroAddress,
    '0x0000000000000000000000000000000000000000000000000000000000000000',
]);

/**
 * Build an AgentAuth tuple for an agent-mediated call.
 *
 * @param {string} agentKey         EOA address of the authorized agent
 *                                  (matches the envelope's stored agentKey).
 * @param {string} reasoningTopicId 32-byte HCS-10 topic id for off-chain
 *                                  reasoning correlation, or `bytes32(0)`.
 * @returns {[string, string]}      Calldata-ready tuple.
 */
function buildAgentAuth(agentKey, reasoningTopicId = ethers.ZeroHash) {
    return [agentKey, reasoningTopicId];
}

module.exports = {
    AGENT_AUTH_TUPLE_TYPE,
    EMPTY_AUTH,
    buildAgentAuth,
};
