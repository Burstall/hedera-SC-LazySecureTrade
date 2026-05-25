// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IAgentEnvelope} from "./IAgentEnvelope.sol";
import {IVIPSubscription} from "./IVIPSubscription.sol";

/**
 * @title IBidderContractFactory
 * @notice Interface for factory calls from a user stash (BidderContract clone).
 * @dev The per-user contract is called a "stash" in the factory API. Function
 *      names here reflect that — note `createTradeOnBehalfOfStash` replaces
 *      the earlier `createTradeOnBehalfOfBidderContract` name, and the
 *      BidDetails struct uses `stash` / `stashNonce` field names.
 *
 *      The BidStatus enum and the `status` field inside BidDetails must
 *      stay byte-compatible with the factory's local definitions so
 *      cross-contract struct encoding works. See BidderContractFactory.sol.
 */
interface IBidderContractFactory {
    /// @notice Lifecycle state of a bid. Must match the variant order
    ///         of `BidderContractFactory.BidStatus` exactly.
    enum BidStatus {
        None,
        Active,
        Cancelled,
        Executed,
        Expired
    }

    struct BidDetails {
        address user;
        address stash;
        uint256 hbarAmount;
        uint256 lazyAmount;
        uint256 expiry;
        address token;
        uint256[] serials;
        uint256 stashNonce;
        uint256 createdAt;
        /// @notice Minimum tinybar trade price this bid is willing to be
        ///         matched against in arbitrage flows. Guards against
        ///         surprise-cheap trades routing through the bidder —
        ///         e.g., a junk NFT listed at 1 tinybar under the same
        ///         collection address. Set to 0 to accept any price.
        uint256 minAcceptablePrice;
        /// @notice Lifecycle state. Set to `None` when building the
        ///         struct; the factory overwrites it with `Active` on
        ///         successful createBid. Bids are hard-deleted on close
        ///         (events carry the terminal state for history).
        BidStatus status;
    }

    /**
     * @notice Create a bid in the factory registry.
     * @dev    Called by the user's stash. The factory orchestrates the
     *         agent envelope check (when `auth.signature` is populated)
     *         by composing the EIP-712 struct hash and calling back
     *         `BidderContract.spendForAgent` on `msg.sender` — keeping
     *         the heavy hashing logic off the stash to fit the 24 KiB
     *         bytecode ceiling.
     * @param bidDetails Bid details struct.
     * @param auth       Optional agent envelope authorization. Empty
     *                   signature = owner-initiated path; populated =
     *                   agent path (envelope verification + budget
     *                   consumption against `bidDetails.hbarAmount` and
     *                   `bidDetails.lazyAmount`).
     * @return bidId Unique bid identifier.
     */
    function createBid(
        BidDetails memory bidDetails,
        IAgentEnvelope.AgentAuth calldata auth
    ) external returns (bytes32 bidId);

    /**
     * @notice Cancel a bid in the factory registry.
     * @dev    Same envelope-via-callback model as `createBid`.
     * @param bidId Bid identifier.
     * @param auth  Optional agent envelope authorization.
     */
    function cancelBid(
        bytes32 bidId,
        IAgentEnvelope.AgentAuth calldata auth
    ) external;

    /**
     * @notice Create a trade in LazySecureTrade on behalf of the calling stash.
     * @dev The calling stash (`msg.sender`, validated against `isValidStash`)
     *      is recorded as the LST trade's `seller`. The human owner is
     *      resolved by the factory via its `stashOwnerOf` reverse mapping
     *      and emitted in the `TradeCreatedFromStash` event for off-chain
     *      indexers — but the on-chain `trade.seller` is always the stash,
     *      because the stash is the actual NFT custodian and must be the
     *      address LST pulls the NFT from at execution time.
     *
     *      See `docs/BCF-StashAllowances-DESIGN.md` for the full rationale
     *      on why `seller` is not a parameter (Bug 2 fix).
     * @param token          NFT token address.
     * @param buyer          Address of the buyer (or address(0) for open market).
     * @param serial         NFT serial number.
     * @param tinybarPrice   HBAR price in tinybars.
     * @param lazyPrice      $LAZY price.
     * @param expiryTime     Expiry timestamp (0 = no expiry).
     * @param auth           Optional agent envelope authorization. Same
     *                       callback-to-spendForAgent model as `createBid`.
     * @return tradeId Created trade identifier.
     */
    function createTradeOnBehalfOfStash(
        address token,
        uint256 serial,
        address buyer,
        uint256 tinybarPrice,
        uint256 lazyPrice,
        uint256 expiryTime,
        IAgentEnvelope.AgentAuth calldata auth
    ) external returns (bytes32 tradeId);

    /**
     * @notice Cancel a stash-listed trade from the human owner's EOA
     *         (legacy path) OR from an authorized agent (envelope path).
     * @dev Resolves the trade on LST, verifies (a) the seller is a
     *      registered stash, and (b) the caller has authority over that
     *      stash. The authority check supports two modes:
     *
     *      - Legacy (auth.signature empty): require
     *        `stashOwnerOf[trade.seller] == msg.sender`.
     *      - Agent (auth.signature populated): verify msg.sender ==
     *        auth.agentKey AND auth.stash == trade.seller AND the
     *        envelope authorizes TradeCancel.
     *
     *      Then instructs the stash to perform the cancellation. The
     *      stash revokes its per-serial NFT approval to LST atomically
     *      with the cancellation — closing the dangling-approval leak
     *      surfaced as Bug 5 in `docs/BCF-StashAllowances-DESIGN.md`.
     *
     *      LST is not modified — symmetric with the existing
     *      `createTradeOnBehalf` authorized-factory pattern.
     * @param tradeId Trade identifier on LST.
     * @param auth    Agent envelope authorization (empty = legacy).
     */
    function cancelTradeFromStash(
        bytes32 tradeId,
        IAgentEnvelope.AgentAuth calldata auth
    ) external;

    /**
     * @notice Reverse lookup: stash address → human owner address.
     * @dev    Populated atomically inside `_deployStashFor` and never
     *         re-written, so this mapping is the canonical source of
     *         truth for "which human controls this stash." Returns
     *         `address(0)` for any address that is not a registered
     *         stash — callers should treat that as "not a stash, the
     *         input address IS the beneficial owner."
     *
     *         Consumed by `LazySecureTrade._resolveBeneficialOwner` so
     *         stash-listed trades resolve to the human owner for fee
     *         tier, self-trade gating, volume accounting, and listing
     *         cost — making stash-listed and EOA-listed trades
     *         indistinguishable at the beneficial-owner layer.
     *         See docs/BCF-StashAllowances-DESIGN.md §"Bug 3".
     * @param stash Candidate stash address to resolve.
     * @return owner Human owner, or `address(0)` if `stash` is not a
     *               registered stash.
     */
    function stashOwnerOf(address stash) external view returns (address owner);

    /**
     * @notice Per-tier limits for agent envelope creation. Queried by
     *         stashes inside `createEnvelope` to enforce slot count and
     *         budget caps against the user's current VIPSubscription
     *         tier.
     * @dev    Storage on the factory (centralized, owner-tunable behind
     *         a 48h timelock). Returning a zero-filled struct for any
     *         tier is the legitimate disable signal — stashes must
     *         reject envelope creation when `maxAgents == 0`.
     * @param  tier VIP tier as returned by `IVIPSubscription.getTierFor`.
     * @return limits Per-envelope cap structure (see IAgentEnvelope).
     */
    function getAgentTierLimits(IVIPSubscription.Tier tier)
        external view returns (IAgentEnvelope.TierLimits memory limits);
}
