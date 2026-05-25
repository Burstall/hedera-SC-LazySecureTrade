// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IVIPSubscription} from "./IVIPSubscription.sol";

/**
 * @title IAgentEnvelope
 * @notice Public types + read interface for the per-stash agent envelope
 *         subsystem. Stashes (`BidderContract`) hold the envelope storage
 *         and admin entry points; consumers (`BidderContractFactory`,
 *         `EnglishAuction`, future) call `spendForAgent` on the stash to
 *         authorize + consume budget for agent-initiated actions.
 *
 *         **Authentication model:** Hedera-native msg.sender. The agent
 *         submits transactions from its own Hedera account (either ECDSA
 *         secp256k1 OR ED25519 — both supported); Hedera's consensus
 *         layer verifies the tx signature before the EVM runs; `msg.sender`
 *         arrives at the contract pre-authenticated. The on-chain check
 *         is `msg.sender == envelope.agentKey`. We do NOT re-verify a
 *         contract-level signature (no ecrecover, no EIP-712) — that
 *         would be redundant AND would lock out ED25519 agents (no EVM
 *         precompile for ED25519 verification on Hedera). Agent keys
 *         MUST be EOA addresses; contract addresses are rejected at
 *         envelope creation.
 *
 *         Trade-fee tier resolution stays with `LSHTierLib` (LSH holdings);
 *         envelope slot-count + per-envelope budget limits come from
 *         `IVIPSubscription` (paid tier). The two axes are deliberately
 *         independent — see docs/AGENT-MARKETPLACE-DELTA.md.
 *
 * @dev    Storage layout for `AgentEnvelope` is load-bearing: 5 slots,
 *         packed as documented in `BidderContract`. Reordering fields
 *         silently corrupts every deployed stash's envelope state.
 */
interface IAgentEnvelope {
    // ============================================
    // Enums
    // ============================================

    /// @notice Action verbs an envelope can authorize. Used as bit
    ///         positions in the `allowedActions` bitmap (1 << uint(action))
    ///         and as the `action` argument to `canAuthorize` / events.
    ///         Order is load-bearing — adding new actions appends; never
    ///         renumber.
    enum ActionType {
        BidCreate,        // 0 — BCF.createBid
        BidCancel,        // 1 — BCF.cancelBid
        TradeExecute,     // 2 — BCF.executeAgainstBid + stash.executeTrade
        TradeList,        // 3 — BCF.createTradeOnBehalfOfStash
        TradeCancel,      // 4 — BCF.cancelTradeFromStash
        Arbitrage,        // 5 — BCF.executeArbitrage
        AuctionCreate,    // 6 — EnglishAuction.createAuction
        AuctionBid,       // 7 — EnglishAuction.placeBid
        AuctionBuyNow     // 8 — EnglishAuction.buyNow
    }

    /// @notice Typed result of the `canAuthorize` pre-flight view.
    ///         Mirrors the revert reasons of `spendForAgent` but as a
    ///         stable programmatic surface (no string allocations,
    ///         no try/catch needed). `Ok` is the only success value;
    ///         all others map 1:1 to a revert in the write path.
    enum AuthFailCode {
        Ok,
        NotFound,
        Paused,
        AllAgentsPaused,
        Expired,
        ActionNotAllowed,
        HbarDailyCapExceeded,
        LazyDailyCapExceeded,
        HbarPerTxCapExceeded,
        LazyPerTxCapExceeded
    }

    // ============================================
    // Structs
    // ============================================

    /// @notice Per-(stash, agentKey) authorization record. Stored on the
    ///         stash; documented here so consumers can decode mirror reads
    ///         + index events without re-deriving the layout.
    ///
    /// @dev    Slot layout (5 slots, packed where possible):
    ///         Slot 0: agentKey(20) + expiresAt(8) + allowedActions(4)
    ///         Slot 1: dailyHbarCap(12) + consumedHbarToday(12) + lastResetDay(8)
    ///         Slot 2: dailyLazyCap(12) + consumedLazyToday(12) + 8 free
    ///         Slot 3: perTxHbarCap(12) + perTxLazyCap(12) + flags(1) + 7 free
    ///         Slot 4: reasoningTopicId(32)
    ///
    ///         `flags` bit layout:
    ///           bit 0 = paused (set by `pauseAgent`)
    ///           bit 1 = active (zero = uninitialized slot vs deliberately
    ///                   cancelled — used by `cancelEnvelope` to distinguish
    ///                   "never existed" from "cancelled and tombstoned")
    ///           bits 2-7 = reserved
    struct AgentEnvelope {
        // Slot 0
        address agentKey;            // EOA address — msg.sender comparator
        uint64  expiresAt;           // unix seconds; 0 = no expiry (capped via tier)
        uint32  allowedActions;      // bitmap over ActionType
        // Slot 1
        uint96  dailyHbarCap;        // tinybars per UTC day
        uint96  consumedHbarToday;   // resets when lastResetDay advances
        uint64  lastResetDay;        // block.timestamp / 86400
        // Slot 2
        uint96  dailyLazyCap;        // LAZY base units per UTC day
        uint96  consumedLazyToday;
        // Slot 3
        uint96  perTxHbarCap;        // tinybars per single action
        uint96  perTxLazyCap;        // LAZY base units per single action
        uint8   flags;               // bit 0 paused, bit 1 active
        // Slot 4
        bytes32 reasoningTopicId;    // HCS-10 topic; bytes32(0) = unset
    }

    /// @notice Creation params for `createEnvelope`. Struct-wrapped so
    ///         adding fields in a v2 doesn't require a new function or
    ///         risk stack-too-deep.
    struct EnvelopeParams {
        address agentKey;
        uint96  dailyHbarCap;
        uint96  dailyLazyCap;
        uint96  perTxHbarCap;
        uint96  perTxLazyCap;
        uint64  expiresAt;
        uint32  allowedActions;
        bytes32 reasoningTopicId;
    }

    /// @notice Compact wire form passed by callers on every authenticated
    ///         action. `agentKey == address(0)` is the owner-path marker —
    ///         when present, the caller MUST be the stash owner and no
    ///         envelope state is touched.
    ///
    /// @dev    Authentication is msg.sender == agentKey, enforced by the
    ///         contract's `_ownerOrAgentMsgSender`. No signature field
    ///         and no nonce — Hedera's protocol layer already validated
    ///         msg.sender ahead of EVM execution; each tx is unique by
    ///         consensus timestamp so there's no replay vector to guard.
    ///         `reasoningTopicId` is carried into events for off-chain
    ///         agent-reasoning correlation.
    struct AgentAuth {
        address agentKey;            // address(0) for owner path
        bytes32 reasoningTopicId;    // emitted in events
    }

    /// @notice BCF-owned table mapping VIP tier to envelope-creation caps.
    ///         Read by the stash at `createEnvelope` time only. Owner-
    ///         settable on BCF behind a 48h timelock.
    struct TierLimits {
        uint8  maxAgents;            // max envelopes per stash at this tier
        uint96 dailyHbarCap;         // upper bound on per-envelope daily HBAR
        uint96 dailyLazyCap;         // upper bound on per-envelope daily LAZY
        uint96 perTxHbarCap;         // upper bound on per-envelope per-tx HBAR
        uint96 perTxLazyCap;         // upper bound on per-envelope per-tx LAZY
        uint64 maxExpiryWindow;      // upper bound on expiresAt - block.timestamp
    }

    // ============================================
    // Events
    // ============================================

    event EnvelopeCreated(
        address indexed owner,
        address indexed agentKey,
        uint96 dailyHbarCap,
        uint96 dailyLazyCap,
        uint96 perTxHbarCap,
        uint96 perTxLazyCap,
        uint64 expiresAt,
        uint32 allowedActions,
        bytes32 reasoningTopicId
    );

    event EnvelopeUpdated(
        address indexed owner,
        address indexed agentKey,
        uint96 newDailyHbarCap,
        uint96 newDailyLazyCap,
        uint64 newExpiresAt,
        uint32 newAllowedActions
    );

    event EnvelopePaused(address indexed owner, address indexed agentKey, bool paused);

    event AllAgentsPaused(address indexed owner, bool paused);

    event EnvelopeCancelled(address indexed owner, address indexed agentKey, uint8 reason);

    event EnvelopeBudgetConsumed(
        address indexed owner,
        address indexed agentKey,
        ActionType indexed action,
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
    // Errors
    // ============================================

    error EnvelopeAuthFailed(address agent, AuthFailCode reason);
    error BudgetExhausted(uint96 needed, uint96 remaining, bool isLazy);
    error PerTxCapExceeded(uint96 attempted, uint96 cap, bool isLazy);
    error EnvelopeAlreadyExists(address agent);
    error InvalidEnvelopeParams();
    error TierCapExceeded(uint8 attempted, uint8 tierCap);
    error TierDoesNotPermitEnvelopes();
    error AgentKeyIsContract();
    error CallerNotAuthorized();
    error VIPSubscriptionUnavailable();

    // ============================================
    // Read API
    // ============================================

    /// @notice Returns the full envelope record for (owner, agentKey).
    ///         When the envelope does not exist, returns a zeroed struct.
    function getEnvelope(address agent) external view returns (AgentEnvelope memory);

    /// @notice O(1) existence check. False after `cancelEnvelope`.
    function envelopeExists(address agent) external view returns (bool);

    /// @notice Number of active envelopes on the stash. Compared against
    ///         the tier cap inside `createEnvelope`.
    function activeEnvelopeCount() external view returns (uint8);
}
