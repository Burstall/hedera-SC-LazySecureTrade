// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IAgentEnvelope} from "../interfaces/IAgentEnvelope.sol";

/**
 * @title AgentEnvelopeLib
 * @notice Statically-linked library for per-stash agent envelope logic.
 *         Holds the EIP-712 domain construction, the ECDSA signature
 *         verification (with EIP-2 low-s enforcement), and the
 *         daily-reset + budget-decrement state transitions.
 *
 * @dev    Functions take `IAgentEnvelope.AgentEnvelope storage` references
 *         so consumers (BidderContract today, EnglishAuction tomorrow if
 *         it ever holds its own envelopes) can mutate the storage in
 *         place without the library owning state. The library itself is
 *         stateless and inlined at compile time — no cross-contract-call
 *         penalty. Bytecode cost is paid by the consumer.
 *
 *         The struct hash for a given action is composed at the call site
 *         (BCF, EA) because the action-specific field set differs per
 *         action. The library only consumes the precomputed struct hash;
 *         the typehash discipline (one TYPEHASH constant per action,
 *         declared at the call site, never reordering fields) is the
 *         caller's contract.
 *
 *         EIP-712 domain binds chainId + verifyingContract = stash. That
 *         pair kills both cross-chain replay (testnet → mainnet) and
 *         cross-stash replay (Alice's signature reused on Bob's stash).
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
        uint64 newNonce,
        bytes32 reasoningTopicId
    );

    event EnvelopeDailyReset(
        address indexed owner,
        address indexed agentKey,
        uint64 utcDay
    );

    event EnvelopeExpired(address indexed owner, address indexed agentKey, uint64 expiredAt);

    // ============================================
    // EIP-712 constants
    // ============================================

    /// @dev EIP-712 domain typehash. Evaluated at compile time.
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Domain name "LSTAgentEnvelope". Bumping this name is a
    ///      breaking change for all in-flight agent signatures.
    bytes32 internal constant NAME_HASH = keccak256("LSTAgentEnvelope");

    /// @dev Version "1". Bumping invalidates all prior signed actions.
    bytes32 internal constant VERSION_HASH = keccak256("1");

    /// @dev secp256k1 group order / 2 — EIP-2 low-s upper bound. Signatures
    ///      with s above this are rejected to kill malleability.
    uint256 internal constant LOW_S_THRESHOLD =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint64 internal constant DAY_SECONDS = 86400;

    /// @dev `flags` bits (see IAgentEnvelope.AgentEnvelope NatSpec)
    uint8 internal constant FLAG_PAUSED = 1 << 0;
    uint8 internal constant FLAG_ACTIVE = 1 << 1;

    // ============================================
    // EIP-712 helpers
    // ============================================

    /// @notice Domain separator pinned to (chainId, verifyingContract).
    ///         Called per-action; the gas cost is one keccak256 of 5
    ///         32-byte words — cheaper than caching it through a storage
    ///         immutable across stash impls.
    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                verifyingContract
            )
        );
    }

    /// @notice Compose the EIP-712 typed-data digest from an action's
    ///         struct hash. The caller pre-computes `structHash` from the
    ///         action's TYPEHASH + field hashes; the library binds the
    ///         domain and produces the digest to recover against.
    function digest(bytes32 structHash, address verifyingContract)
        internal view returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(hex"19_01", domainSeparator(verifyingContract), structHash)
        );
    }

    /// @notice Recover the signer of a 65-byte (r, s, v) signature over a
    ///         32-byte digest. Enforces EIP-2 low-s. Reverts (via
    ///         `EnvelopeAuthFailed(BadSignature)`) on any non-recoverable
    ///         signature so callers don't have to remember to check the
    ///         zero address.
    function recover(bytes32 digestHash, bytes calldata signature)
        internal pure returns (address)
    {
        if (signature.length != 65) {
            revert IAgentEnvelope.EnvelopeAuthFailed(address(0), IAgentEnvelope.AuthFailCode.BadSignature);
        }
        bytes32 r;
        bytes32 s;
        uint8 v;
        // calldataload reads 32 bytes; v is the high byte of the third word.
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (uint256(s) > LOW_S_THRESHOLD) {
            revert IAgentEnvelope.EnvelopeAuthFailed(address(0), IAgentEnvelope.AuthFailCode.BadSignature);
        }
        if (v < 27) v += 27;
        address signer = ecrecover(digestHash, v, r, s);
        if (signer == address(0)) {
            revert IAgentEnvelope.EnvelopeAuthFailed(address(0), IAgentEnvelope.AuthFailCode.BadSignature);
        }
        return signer;
    }

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

    /// @notice Verify signature + envelope eligibility + budget, then
    ///         decrement the daily counters and bump the nonce. Atomic:
    ///         any revert leaves the envelope untouched.
    ///
    /// @param env             Storage pointer to the envelope record.
    /// @param owner           Stash owner (for event attribution).
    /// @param auth            Per-action wire form (agentKey, nonce, deadline, sig, topic).
    /// @param action          The action being authorized.
    /// @param structHash      Pre-composed EIP-712 struct hash for this action.
    /// @param hbarAmount      HBAR (tinybars) this action will spend.
    /// @param lazyAmount      LAZY base units this action will spend.
    /// @param verifyingAddr   The stash's own address (EIP-712 domain bind).
    /// @return remHbar        Remaining daily HBAR after decrement.
    /// @return remLazy        Remaining daily LAZY after decrement.
    function verifyAndConsume(
        IAgentEnvelope.AgentEnvelope storage env,
        address owner,
        IAgentEnvelope.AgentAuth calldata auth,
        IAgentEnvelope.ActionType action,
        bytes32 structHash,
        uint96 hbarAmount,
        uint96 lazyAmount,
        address verifyingAddr,
        bool allAgentsPaused
    ) internal returns (uint96 remHbar, uint96 remLazy) {
        // ----- Envelope existence + active state -----
        if (env.agentKey == address(0) || (env.flags & FLAG_ACTIVE) == 0) {
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.NotFound);
        }
        if (env.agentKey != auth.agentKey) {
            // Defensive: caller passed an agentKey that doesn't match the
            // looked-up envelope. Distinct from BadSignature — this is a
            // wiring bug, not a forged signature.
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

        // ----- Deadline -----
        if (auth.deadline < block.timestamp) {
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.DeadlinePassed);
        }

        // ----- Nonce -----
        unchecked {
            if (auth.nonce != env.nonce + 1) {
                revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.NonceMismatch);
            }
        }

        // ----- Signature -----
        bytes32 digestHash = digest(structHash, verifyingAddr);
        address signer = recover(digestHash, auth.signature);
        if (signer != env.agentKey) {
            revert IAgentEnvelope.EnvelopeAuthFailed(auth.agentKey, IAgentEnvelope.AuthFailCode.BadSignature);
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
        unchecked { env.nonce = env.nonce + 1; }

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
            env.nonce,
            auth.reasoningTopicId
        );
    }

    // ============================================
    // Pre-flight view (used by canAuthorize)
    // ============================================

    /// @notice Read-only mirror of `verifyAndConsume`'s revert tree.
    ///         Returns the first failing code (or `Ok`) for the given
    ///         (action, amounts) tuple. Does NOT verify a signature —
    ///         callers pre-flight on the agent runtime side before paying
    ///         gas. Daily reset is simulated, not committed.
    function checkAuthorization(
        IAgentEnvelope.AgentEnvelope storage env,
        IAgentEnvelope.ActionType action,
        uint96 hbarAmount,
        uint96 lazyAmount,
        bool allAgentsPaused
    ) internal view returns (IAgentEnvelope.AuthFailCode) {
        if (env.agentKey == address(0) || (env.flags & FLAG_ACTIVE) == 0) {
            return IAgentEnvelope.AuthFailCode.NotFound;
        }
        if (allAgentsPaused) return IAgentEnvelope.AuthFailCode.AllAgentsPaused;
        if ((env.flags & FLAG_PAUSED) != 0) return IAgentEnvelope.AuthFailCode.Paused;
        if (env.expiresAt != 0 && block.timestamp > env.expiresAt) {
            return IAgentEnvelope.AuthFailCode.Expired;
        }
        uint32 actionBit = uint32(1) << uint32(action);
        if ((env.allowedActions & actionBit) == 0) {
            return IAgentEnvelope.AuthFailCode.ActionNotAllowed;
        }
        if (hbarAmount > env.perTxHbarCap) {
            return IAgentEnvelope.AuthFailCode.HbarPerTxCapExceeded;
        }
        if (lazyAmount > env.perTxLazyCap) {
            return IAgentEnvelope.AuthFailCode.LazyPerTxCapExceeded;
        }
        // Simulated daily reset: if a new day, consumed reverts to 0
        uint64 today = uint64(block.timestamp / DAY_SECONDS);
        uint96 hbarUsed = (today != env.lastResetDay) ? 0 : env.consumedHbarToday;
        uint96 lazyUsed = (today != env.lastResetDay) ? 0 : env.consumedLazyToday;
        if (uint256(hbarUsed) + uint256(hbarAmount) > env.dailyHbarCap) {
            return IAgentEnvelope.AuthFailCode.HbarDailyCapExceeded;
        }
        if (uint256(lazyUsed) + uint256(lazyAmount) > env.dailyLazyCap) {
            return IAgentEnvelope.AuthFailCode.LazyDailyCapExceeded;
        }
        return IAgentEnvelope.AuthFailCode.Ok;
    }

    /// @notice Compute the unix-second timestamp at which the envelope's
    ///         daily window next rolls over. Used by `getRemainingBudget`.
    function nextResetAt(IAgentEnvelope.AgentEnvelope storage env)
        internal view returns (uint64)
    {
        uint64 today = uint64(block.timestamp / DAY_SECONDS);
        uint64 base = (today > env.lastResetDay) ? today : env.lastResetDay;
        return (base + 1) * DAY_SECONDS;
    }
}
