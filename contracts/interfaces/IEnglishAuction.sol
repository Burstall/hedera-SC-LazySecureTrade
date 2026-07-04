// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IAgentEnvelope} from "./IAgentEnvelope.sol";

/**
 * @title IEnglishAuction
 * @notice Minimal read + write surface for the EnglishAuction contract.
 *         Consumed by the SDK, frontends, and (future) agent runtime.
 *         The full contract surface includes admin paths not declared
 *         here.
 * @dev    Bundle auctions support up to 10 items per auction in any
 *         mixture of NFTs (across collections) and fungible tokens.
 *         Royalty is snapshotted per unique NFT token at create and
 *         paid manually at settle.
 */
interface IEnglishAuction {

    // ============================================
    // Enums
    // ============================================

    /// @notice Lifecycle states. Hard-deleted on Settled / Failed /
    ///         Cancelled — close-event metadata is the canonical
    ///         history layer.
    enum AuctionState {
        None,       // 0 — never created, or hard-deleted post-close
        Open,       // 1 — accepting bids
        Settled,    // 2 — terminal (used only in events, not storage)
        Failed,     // 3 — reserve not met or zero bids (used only in events)
        Cancelled   // 4 — seller cancelled before any bid (used only in events)
    }

    /// @notice Currency rail for bids + settlement.
    enum PaymentToken {
        HBAR,
        LAZY
    }

    // ============================================
    // Structs
    // ============================================

    /// @notice Single item in an auction bundle.
    /// @param token Token contract address (NFT or fungible).
    /// @param serialOrAmount Serial number if NFT, amount (base units)
    ///         if fungible.
    /// @param isNFT True for HTS NFT, false for fungible HTS token.
    struct AuctionItem {
        address token;
        bool isNFT;
        uint256 serialOrAmount;
    }

    /// @notice Royalty snapshot taken at create time, one entry per
    ///         unique NFT token in the bundle. Fungible items don't
    ///         contribute royalty entries.
    struct RoyaltyInfo {
        address token;
        address collector;
        uint16 bps; // 0–10_000
    }

    /// @notice Aggregated auction snapshot for single-call frontend
    ///         hydration. Returned by `getAuctionSnapshot`.
    struct AuctionSnapshot {
        address seller;
        AuctionState state;
        PaymentToken payment;
        uint8 sellerTierAtCreate;       // LSHTierLib.Tier as uint8
        uint16 minStepBps;
        uint16 antiSnipeWindow;          // seconds
        uint16 antiSnipeExtension;       // seconds
        uint64 closeAt;
        uint64 maxCloseAt;
        uint96 reservePrice;
        uint96 startPrice;
        uint96 buyNowPrice;              // 0 if no buy-now
        uint96 highBid;
        address highBidder;
        uint64 nonce;
        AuctionItem[] items;
        RoyaltyInfo[] royalties;
        uint96 nextMinimumBid;           // computed: max(startPrice, highBid + step)
        uint64 timeRemaining;            // computed: max(0, closeAt - now)
    }

    /// @notice Parameters for `createAuction`. Wrapped in a struct to
    ///         keep the function signature under stack-too-deep.
    /// @param items Up to 10 items (NFTs + fungibles).
    /// @param payment HBAR or LAZY rail.
    /// @param reservePrice Minimum acceptable settlement price (in the
    ///         payment token's base units). 0 = no reserve.
    /// @param startPrice Minimum first-bid amount.
    /// @param buyNowPrice Optional fixed-price collapse. 0 = no buy-now.
    /// @param duration Seconds from createAuction to initial closeAt.
    /// @param minStepBps Minimum next-bid increment as bps of current
    ///         high. Set 0 to use protocol default.
    /// @param antiSnipeWindow Seconds before closeAt during which any
    ///         bid extends the auction. 0 = use protocol default.
    /// @param antiSnipeExtension Seconds added on every snipe bid. 0 =
    ///         use protocol default.
    struct AuctionParams {
        AuctionItem[] items;
        PaymentToken payment;
        uint96 reservePrice;
        uint96 startPrice;
        uint96 buyNowPrice;
        uint64 duration;
        uint16 minStepBps;
        uint16 antiSnipeWindow;
        uint16 antiSnipeExtension;
    }

    // ============================================
    // Events
    // ============================================

    /// @notice Emitted on every successful `createAuction`. Carries
    ///         full metadata so off-chain consumers don't need a
    ///         storage lookup. `agentKey` reserved for future agent
    ///         envelope flow.
    event AuctionCreated(
        bytes32 indexed auctionId,
        address indexed seller,
        PaymentToken indexed payment,
        AuctionItem[] items,
        uint96 reservePrice,
        uint96 startPrice,
        uint96 buyNowPrice,
        uint64 closeAt,
        uint64 maxCloseAt,
        uint8 sellerTierAtCreate,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );

    /// @notice Emitted on every accepted bid. If the bid was the
    ///         buy-now collapse, `triggeredBuyNow` is true and the
    ///         caller should expect an `AuctionSettled` event in the
    ///         same transaction. `previousHigh` / `previousBidder`
    ///         carry the outbid state so indexers can credit refunds.
    ///         If the bid was inside the anti-snipe window, `extended`
    ///         is true and `newCloseAt` carries the new close.
    event BidCreated(
        bytes32 indexed auctionId,
        address indexed bidder,
        uint96 amount,
        uint96 previousHigh,
        address previousBidder,
        bool extended,
        uint64 newCloseAt,
        bool triggeredBuyNow,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );

    /// @notice Emitted on `settle`, both for successful matches and
    ///         reserve-not-met / no-bid failures. `success` discriminates:
    ///         true = winner paid, NFTs delivered (or queued for claim);
    ///         false = auction failed, items returned (or queued).
    ///         Carries full cold-start metadata.
    event AuctionSettled(
        bytes32 indexed auctionId,
        address indexed seller,
        address indexed winner,
        bool success,
        uint96 winningBid,
        uint96 protocolFee,
        uint96 totalRoyaltyPaid,
        uint96 sellerProceeds,
        address settler,
        uint96 settlementBounty,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );

    /// @notice Emitted when the seller cancels a zero-bid auction.
    event AuctionCancelled(
        bytes32 indexed auctionId,
        address indexed seller
    );

    /// @notice Emitted when a settled auction's NFT bundle is delivered to
    ///         its claimant (winner on success, seller on fail) via the
    ///         pull-based `claimAuctionNFT`. Settlement (funds) is signalled
    ///         separately by `AuctionSettled`; delivery is deferred.
    event AuctionBundleClaimed(
        bytes32 indexed auctionId,
        address indexed claimant
    );

    /// @notice Emitted whenever an auction's `closeAt` is pushed
    ///         forward by an anti-snipe bid. Redundant with
    ///         BidCreated.extended; kept for indexer convenience.
    event AuctionExtended(
        bytes32 indexed auctionId,
        uint64 previousCloseAt,
        uint64 newCloseAt
    );

    /// @notice Emitted when a user pulls accumulated HBAR or LAZY
    ///         from the claim queue (outbid refunds, fallback seller
    ///         proceeds, bounty).
    event RefundClaimed(
        address indexed user,
        PaymentToken indexed payment,
        uint256 amount
    );

    // ============================================
    // Read API
    // ============================================

    function getAuctionSnapshot(
        bytes32 auctionId
    ) external view returns (AuctionSnapshot memory);

    function getClaimable(
        address user
    ) external view returns (uint256 hbar, uint256 lazy);

    function currentTimestamp() external view returns (uint64);

    // ============================================
    // Write API
    // ============================================

    function createAuction(
        AuctionParams calldata params,
        IAgentEnvelope.AgentAuth calldata auth
    ) external returns (bytes32 auctionId);

    function cancelAuction(bytes32 auctionId) external;

    function placeBid(
        bytes32 auctionId,
        uint96 amount,
        IAgentEnvelope.AgentAuth calldata auth
    ) external payable;

    function buyNow(
        bytes32 auctionId,
        IAgentEnvelope.AgentAuth calldata auth
    ) external payable;

    function settle(bytes32 auctionId) external;

    function claim(PaymentToken payment) external;
}
