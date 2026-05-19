// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

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
     * @param bidDetails Bid details struct.
     * @return bidId Unique bid identifier.
     */
    function createBid(
        BidDetails memory bidDetails
    ) external returns (bytes32 bidId);

    /**
     * @notice Cancel a bid in the factory registry.
     * @param bidId Bid identifier.
     */
    function cancelBid(bytes32 bidId) external;

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
     * @param token NFT token address.
     * @param buyer Address of the buyer (or address(0) for open market).
     * @param serial NFT serial number.
     * @param tinybarPrice HBAR price in tinybars.
     * @param lazyPrice $LAZY price.
     * @param expiryTime Expiry timestamp (0 = no expiry).
     * @param agentKey Optional agent identifier for envelope tracking + event
     *                 tagging. Pass `bytes32(0)` for owner-initiated listings;
     *                 non-zero values are reserved for the per-agent envelope
     *                 flow (not enforced on-chain in v0.3 — carried in events
     *                 only for off-chain correlation).
     * @return tradeId Created trade identifier.
     */
    function createTradeOnBehalfOfStash(
        address token,
        uint256 serial,
        address buyer,
        uint256 tinybarPrice,
        uint256 lazyPrice,
        uint256 expiryTime,
        bytes32 agentKey
    ) external returns (bytes32 tradeId);

    /**
     * @notice Cancel a stash-listed trade from the human owner's EOA.
     * @dev Resolves the trade on LST, verifies (a) the seller is a registered
     *      stash and (b) the caller is that stash's owner via `stashOwnerOf`,
     *      then instructs the stash to perform the cancellation. The stash
     *      revokes its per-serial NFT approval to LST atomically with the
     *      cancellation — closing the dangling-approval leak surfaced as
     *      Bug 5 in `docs/BCF-StashAllowances-DESIGN.md`.
     *
     *      LST is not modified — symmetric with the existing
     *      `createTradeOnBehalf` authorized-factory pattern.
     * @param tradeId Trade identifier on LST.
     */
    function cancelTradeFromStash(bytes32 tradeId) external;
}
