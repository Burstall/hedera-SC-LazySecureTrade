// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IAgentEnvelope} from "../interfaces/IAgentEnvelope.sol";

/**
 * @title AgentEnvelopeLib
 * @notice Statically-linked library for per-stash agent envelope state.
 *         Holds daily-reset + budget-decrement + permission-check logic.
 *
 * @dev    Agent authentication is **msg.sender-only**. Hedera's protocol
 *         layer verifies the agent's transaction signature (ECDSA secp256k1
 *         OR ED25519 Hedera-native) before the EVM runs; by the time this
 *         library executes, `msg.sender` is guaranteed by consensus to be
 *         the account that signed. Re-verifying inside the contract via
 *         ecrecover would be redundant AND would lock out ED25519 accounts
 *         (no EVM precompile for ED25519 on Hedera) — so we don't.
 *
 *         Functions take `IAgentEnvelope.AgentEnvelope storage` references
 *         so consumers (BidderContract, future EnglishAuction integration)
 *         can mutate the storage in place without the library owning
 *         state. The library is stateless and inlined at compile time —
 *         no cross-contract-call penalty. Bytecode cost is paid by the
 *         consumer.
 *
 *         Daily reset is UTC-floor: `block.timestamp / 86400`. First
 *         action of a new day pays one extra SSTORE for the reset; the
 *         rollover is implicit and atomic per tx.
 */
library AgentEnvelopeLib {
    // ============================================
    // Events (signatures mirror IAgentEnvelope — same topic hashes)
    // ============================================
    //
    // Solidity requires that the contract OR library doing the `emit`
    // declares the event itself; interface events can't be emitted by
    // an unrelated type. Declaring them here too is harmless — the
    // signature determines the topic hash, not the declaring contract,
    // so indexers see one logical event stream.

    event EnvelopeBudgetConsumed(
        address indexed owner,
        address indexed agentKey,
        IAgentEnvelope.ActionType indexed action,
        uint96 hbarAmount,
        uint96 lazyAmount,
        uint96 remainingHbar,
        uint96 remainingLazy,
        bytes32 reasoningTopicId
    );

    event EnvelopeDailyReset(
        address indexed owner,
        address indexed agentKey,
        uint64 utcDay
    );

    event EnvelopeExpired(address indexed owner, address indexed agentKey, uint64 expiredAt);

    // ============================================
    // Constants
    // ============================================

    uint64 internal constant DAY_SECONDS = 86400;

    /// @dev `flags` bits (see IAgentEnvelope.AgentEnvelope NatSpec)
    uint8 internal constant FLAG_PAUSED = 1 << 0;
    uint8 internal constant FLAG_ACTIVE = 1 << 1;

    // ============================================
    // State transitions
    // ============================================

    /// @notice Apply the UTC-day rollover if the envelope hasn't seen an
    ///         action today. Emits `EnvelopeDailyReset` so off-chain
    ///         indexers can detect the rollover without polling.
    /// @dev    Returns the post-reset `lastResetDay` so callers can echo
    ///         it into other events without a re-read.
    function resetIfNewDay(
        IAgentEnvelope.AgentEnvelope storage env,
        address owner,
        address agentKey
    ) internal returns (uint64 today) {
        today = uint64(block.timestamp / DAY_SECONDS);
        if (today != env.lastResetDay) {
            env.consumedHbarToday = 0;
            env.consumedLazyToday = 0;
            env.lastResetDay = today;
            emit EnvelopeDailyReset(owner, agentKey, today);
        }
    }

    /// @notice Validate envelope eligibility + budget, then decrement the
    ///         daily counters. Atomic: any revert leaves the envelope
    ///         untouched. The caller's `_ownerOrAgentMsgSender` (or
    ///         equivalent) is responsible for verifying `msg.sender ==
    ///         auth.agentKey` BEFORE calling this — this library trusts
    ///         that the caller chain is already authenticated.
    ///
    /// @param env             Storage pointer to the envelope record.
    /// @param owner           Stash owner (for event attribution).
    /// @param auth            Per-action wire form (agentKey + reasoningTopicId).
    /// @param action          The action being authorized.
    /// @param hbarAmount      HBAR (tinybars) this action will spend.
    /// @param lazyAmount      LAZY base units this action will spend.
    /// @param allAgentsPaused Stash-side global kill switch.
    /// @return remHbar        Remaining daily HBAR after decrement.
    /// @return remLazy        Remaining daily LAZY after decrement.
    function verifyAndConsume(
        IAgentEnvelope.AgentEnvelope storage env,
        address owner,
        IAgentEnvelope.AgentAuth calldata auth,
        IAgentEnvelope.ActionType action,
        uint96 hbarAmount,
        uint96 lazyAmount,
        bool allAgentsPaused
    ) internal returns (uint96 remHbar, uint96 remLazy) {
        // ----- Envelope existence + active state -----
        if (env.agentKey == address(0) || (env.flags & FLAG_ACTIVE) == 0) {
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.NotFound);
        }
        if (env.agentKey != auth.agentKey) {
            // Defensive: caller passed an agentKey that doesn't match the
            // looked-up envelope. Wiring bug.
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.NotFound);
        }

        if (allAgentsPaused) {
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.AllAgentsPaused);
        }
        if ((env.flags & FLAG_PAUSED) != 0) {
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.Paused);
        }

        // ----- Expiry -----
        if (env.expiresAt != 0 && block.timestamp > env.expiresAt) {
            // Emit a one-shot tombstone event so indexers note the natural
            // close. The envelope storage is left as-is; the owner can
            // call `cancelEnvelope` to garbage-collect when convenient.
            emit EnvelopeExpired(owner, auth.agentKey, env.expiresAt);
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.Expired);
        }

        // ----- Action permission -----
        uint32 actionBit = uint32(1) << uint32(action);
        if ((env.allowedActions & actionBit) == 0) {
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.ActionNotAllowed);
        }

        // ----- Per-tx caps (before daily-cap check; cheaper to fail) -----
        if (hbarAmount > env.perTxHbarCap) {
            revert IAgentEnvelope.PerTxCapExceeded(hbarAmount, env.perTxHbarCap, false);
        }
        if (lazyAmount > env.perTxLazyCap) {
            revert IAgentEnvelope.PerTxCapExceeded(lazyAmount, env.perTxLazyCap, true);
        }

        // ----- Daily reset (after all cheap fails; we only mutate from here) -----
        resetIfNewDay(env, owner, auth.agentKey);

        // ----- Daily caps + decrement -----
        uint96 newHbar = env.consumedHbarToday + hbarAmount;
        if (newHbar > env.dailyHbarCap) {
            revert IAgentEnvelope.BudgetExhausted(
                hbarAmount,
                env.dailyHbarCap - env.consumedHbarToday,
                false
            );
        }
        uint96 newLazy = env.consumedLazyToday + lazyAmount;
        if (newLazy > env.dailyLazyCap) {
            revert IAgentEnvelope.BudgetExhausted(
                lazyAmount,
                env.dailyLazyCap - env.consumedLazyToday,
                true
            );
        }
        env.consumedHbarToday = newHbar;
        env.consumedLazyToday = newLazy;

        remHbar = env.dailyHbarCap - newHbar;
        remLazy = env.dailyLazyCap - newLazy;

        emit EnvelopeBudgetConsumed(
            owner,
            auth.agentKey,
            action,
            hbarAmount,
            lazyAmount,
            remHbar,
            remLazy,
            auth.reasoningTopicId
        );
    }
}
