// SPDX-License-Identifier: GPL-3.0
//
// EIP-712 signing helpers for agent envelopes.
//
// The factory + stash verify agent-initiated actions by recovering an
// ECDSA signature against a domain pinned to (chainId, stash address).
// This module produces both the empty `AgentAuth` placeholder used for
// owner-path tests and the per-action signed `AgentAuth` payloads used
// for envelope flows.
//
// The per-action TYPEHASH strings here MUST stay in lock-step with the
// constants declared inside `BidderContract.sol` (stash-mediated paths)
// and `BidderContractFactory.sol` (factory-mediated paths). Any change
// to a typehash or its field order is a breaking change to all signed
// in-flight actions.

const { ethers } = require('ethers');

// Domain shape declared in `AgentEnvelopeLib.sol` — name "LSTAgentEnvelope",
// version "1", chainId bound by the verifying network, verifyingContract
// = the stash address.
const DOMAIN_NAME = 'LSTAgentEnvelope';
const DOMAIN_VERSION = '1';

// ABI shape of `IAgentEnvelope.AgentAuth` (matches the Solidity struct
// ordering). Used to produce calldata-compatible tuples for tests that
// pass auth through `contractExecuteFunction`.
const AGENT_AUTH_TUPLE_TYPE =
    '(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 reasoningTopicId,bytes signature)';

// Empty `AgentAuth` placeholder. Used by every contractExecuteFunction
// call that needs to invoke the legacy / owner path of a function that
// was threaded with the new `AgentAuth calldata auth` tail parameter.
// `signature.length == 0` is the on-chain marker for "no agent path".
const EMPTY_AUTH = Object.freeze([
    ethers.ZeroAddress,                                              // agentKey
    ethers.ZeroAddress,                                              // stash
    0,                                                               // nonce
    0,                                                               // deadline
    '0x0000000000000000000000000000000000000000000000000000000000000000', // reasoningTopicId
    '0x',                                                            // signature (empty = owner path)
]);

// Map from human-friendly action name → EIP-712 type schema (used by
// ethers `Wallet.signTypedData`). Field order must match the
// corresponding `_*StructHash` composer in the contract — getting the
// order wrong yields a digest the contract cannot recover from.
const ACTION_TYPES = {
    BidCreate: [
        { name: 'agentKey', type: 'address' },
        { name: 'stash', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'token', type: 'address' },
        { name: 'serials', type: 'uint256[]' },
        { name: 'hbarAmount', type: 'uint256' },
        { name: 'lazyAmount', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'minAcceptablePrice', type: 'uint256' },
        { name: 'reasoningTopicId', type: 'bytes32' },
    ],
    BidCancel: [
        { name: 'agentKey', type: 'address' },
        { name: 'stash', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'bidId', type: 'bytes32' },
        { name: 'reasoningTopicId', type: 'bytes32' },
    ],
    CreateTrade: [
        { name: 'agentKey', type: 'address' },
        { name: 'stash', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'token', type: 'address' },
        { name: 'buyer', type: 'address' },
        { name: 'serial', type: 'uint256' },
        { name: 'tinybarPrice', type: 'uint256' },
        { name: 'lazyPrice', type: 'uint256' },
        { name: 'expiryTime', type: 'uint256' },
        { name: 'reasoningTopicId', type: 'bytes32' },
    ],
    CancelTrade: [
        { name: 'agentKey', type: 'address' },
        { name: 'stash', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'tradeId', type: 'bytes32' },
        { name: 'reasoningTopicId', type: 'bytes32' },
    ],
    Arbitrage: [
        { name: 'agentKey', type: 'address' },
        { name: 'stash', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'bidId', type: 'bytes32' },
        { name: 'tradeId', type: 'bytes32' },
        { name: 'minProfit', type: 'uint256' },
        { name: 'reasoningTopicId', type: 'bytes32' },
    ],
    ExecuteAgainstBid: [
        { name: 'agentKey', type: 'address' },
        { name: 'stash', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
        { name: 'bidId', type: 'bytes32' },
        { name: 'nftToken', type: 'address' },
        { name: 'serial', type: 'uint256' },
        { name: 'reasoningTopicId', type: 'bytes32' },
    ],
};

/**
 * Compose the EIP-712 domain for a given stash.
 *
 * @param {number|bigint} chainId      Numeric chain id (Hedera testnet = 296, mainnet = 295).
 * @param {string}        stashAddress Stash EVM address (verifyingContract).
 * @returns {object} ethers-compatible domain object for signTypedData.
 */
function buildEnvelopeDomain(chainId, stashAddress) {
    return {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId,
        verifyingContract: stashAddress,
    };
}

/**
 * Sign an action payload as an authorized agent. Returns a populated
 * AgentAuth tuple suitable for direct use with `contractExecuteFunction`.
 *
 * @param {ethers.Wallet} signer           Ethers wallet for the agent key.
 * @param {number|bigint} chainId          Numeric chain id.
 * @param {string}        stashAddress     Stash being acted upon.
 * @param {string}        action           Action name from ACTION_TYPES.
 * @param {object}        message          Field map matching ACTION_TYPES[action].
 *                                          MUST contain `agentKey`, `stash`,
 *                                          `nonce`, `deadline`, `reasoningTopicId`
 *                                          plus the action-specific fields.
 * @returns {Promise<Array>} Calldata-shaped AgentAuth tuple.
 */
async function signAgentAuth(signer, chainId, stashAddress, action, message) {
    const types = ACTION_TYPES[action];
    if (!types) throw new Error(`Unknown action type: ${action}`);
    const domain = buildEnvelopeDomain(chainId, stashAddress);
    const signature = await signer.signTypedData(domain, { [action]: types }, message);
    return [
        message.agentKey,
        message.stash,
        message.nonce,
        message.deadline,
        message.reasoningTopicId,
        signature,
    ];
}

/**
 * Derive the agent's EVM address from an ethers Wallet — the address
 * that the on-chain envelope stores as `agentKey`.
 */
function agentAddress(signer) {
    return signer.address;
}

module.exports = {
    DOMAIN_NAME,
    DOMAIN_VERSION,
    AGENT_AUTH_TUPLE_TYPE,
    EMPTY_AUTH,
    ACTION_TYPES,
    buildEnvelopeDomain,
    signAgentAuth,
    agentAddress,
};
