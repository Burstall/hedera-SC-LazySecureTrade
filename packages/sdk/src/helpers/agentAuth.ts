/**
 * AgentAuth tuple shape for agent-mediated calls into the marketplace.
 *
 * Authentication model: msg.sender-only. Hedera's protocol layer validates
 * the submitting account's transaction signature (ECDSA secp256k1 OR
 * ED25519, native to whatever key type the agent's Hedera account holds)
 * before the EVM runs. Contracts check `msg.sender == envelope.agentKey`
 * against the envelope's stored agentKey — no EIP-712 ceremony, no
 * ecrecover, no nonce. Works uniformly for both Hedera key types.
 *
 * Wire form (matches the Solidity struct in IAgentEnvelope.sol):
 *
 *   struct AgentAuth {
 *       address agentKey;            // address(0) = owner path
 *       bytes32 reasoningTopicId;    // HCS-10 topic for off-chain trace
 *   }
 */

import { ZeroAddress, ZeroHash } from 'ethers';

/** ABI shape used by ethers / contractExecuteFunction. */
export const AGENT_AUTH_TUPLE_TYPE =
    '(address agentKey,bytes32 reasoningTopicId)' as const;

/** Calldata-ready tuple for the AgentAuth struct. */
export type AgentAuth = readonly [agentKey: string, reasoningTopicId: string];

/**
 * Tuple constant for the legacy / owner path. Pass this wherever a
 * function takes AgentAuth but the caller is the stash owner / direct
 * EOA (not an envelope-mediated agent).
 */
export const EMPTY_AUTH: AgentAuth = Object.freeze([
    ZeroAddress,
    ZeroHash,
]) as AgentAuth;

/**
 * Build an AgentAuth tuple for an agent-mediated call.
 *
 * @param agentKey         EOA address of the authorized agent (matches the
 *                         envelope's stored agentKey).
 * @param reasoningTopicId 32-byte HCS-10 topic id for off-chain reasoning
 *                         correlation, or `bytes32(0)`.
 */
export function buildAgentAuth(
    agentKey: string,
    reasoningTopicId: string = ZeroHash,
): AgentAuth {
    return [agentKey, reasoningTopicId] as const;
}
