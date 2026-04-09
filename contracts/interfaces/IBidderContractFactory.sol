// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

/**
 * @title IBidderContractFactory
 * @notice Interface for factory calls from a user stash (BidderContract clone).
 * @dev The per-user contract is called a "stash" in the factory API. Function
 *      names here reflect that — note `createTradeOnBehalfOfStash` replaces
 *      the earlier `createTradeOnBehalfOfBidderContract` name, and the
 *      BidDetails struct uses `stash` / `stashNonce` field names.
 */
interface IBidderContractFactory {
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
     * @notice Create a trade in LazySecureTrade on behalf of a stash owner.
     * @dev Lets a user list NFTs held inside their stash without first
     *      withdrawing them. The calling stash (msg.sender) is the actual
     *      HTS holder; `seller` is the recorded human owner.
     * @param seller Address of the seller (the stash's human owner).
     * @param token NFT token address.
     * @param buyer Address of the buyer (or address(0) for open market).
     * @param serial NFT serial number.
     * @param tinybarPrice HBAR price in tinybars.
     * @param lazyPrice $LAZY price.
     * @param expiryTime Expiry timestamp (0 = no expiry).
     * @return tradeId Created trade identifier.
     */
    function createTradeOnBehalfOfStash(
        address seller,
        address token,
        address buyer,
        uint256 serial,
        uint256 tinybarPrice,
        uint256 lazyPrice,
        uint256 expiryTime
    ) external returns (bytes32 tradeId);
}
