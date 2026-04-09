// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ILazySecureTrade} from "./interfaces/ILazySecureTrade.sol";
import {BidderContract} from "./BidderContract.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BidderContractFactory
 * @notice Central router for CLOB-style bidding on NFTs on Hedera.
 * @dev Deploys one "stash" (BidderContract clone) per user via
 *      `Clones.cloneDeterministic` so each user's stash lives at a
 *      predictable address derived from their EVM address. Off-chain clients
 *      (wallets, indexers, MCP agents) can compute the stash address without
 *      an RPC call and then query the mirror node for balances/NFTs directly.
 *
 *      Naming note: the per-user contract is still the `BidderContract` class
 *      internally (unchanged for this branch), but all factory-facing surface
 *      uses "stash" terminology. A user has exactly one stash. "Stash" and
 *      "BidderContract" refer to the same thing.
 */
contract BidderContractFactory is Ownable, ReentrancyGuard {
    // ============================================
    // State Variables
    // ============================================

    /// @notice LazySecureTrade contract for trade execution
    ILazySecureTrade public immutable LAZY_SECURE_TRADE;

    /// @notice $LAZY token address
    address public immutable LAZY_TOKEN;

    /// @notice LazyGasStation address for gas refills
    address public immutable LAZY_GAS_STATION;

    /// @notice LazyDelegateRegistry address for NFT delegation
    address public immutable LAZY_DELEGATE_REGISTRY;

    /// @notice Implementation contract for CREATE2 clones.
    /// @dev MUST remain immutable — any change shifts every predicted stash
    ///      address. If the implementation ever needs to change, a new factory
    ///      must be deployed and users manually migrate by withdrawing from
    ///      the old stash and deploying a fresh one under the new factory.
    address public immutable BIDDER_CONTRACT_IMPLEMENTATION;

    /// @notice User → their deployed stash (BidderContract clone). Address is
    ///         ALSO derivable via `getStashAddress(user)` without an RPC call;
    ///         this mapping is populated on deploy so lookups are O(1) and
    ///         doubles as a "has been deployed" check.
    mapping(address => address) public userToStash;

    /// @notice Token-based bid discovery (CLOB efficiency)
    mapping(address => bytes32[]) public tokenToBids;

    /// @notice User's active bids
    mapping(address => bytes32[]) public userToBids;

    /// @notice Core bid registry
    mapping(bytes32 => BidDetails) public bidRegistry;

    /// @notice Track valid stashes deployed by this factory
    mapping(address => bool) public isValidStash;

    /// @notice All deployed stashes
    address[] public allStashes;

    /// @notice Total bid counter for analytics
    uint256 public totalBidCount;

    /// @notice Salt version tag for deterministic stash derivation. Change
    ///         this ONLY via a new factory deployment — bumping it on a live
    ///         factory would shift every predicted address.
    bytes12 internal constant STASH_SALT_VERSION = "LST_STASH_v1";

    // ============================================
    // Structs
    // ============================================

    struct BidDetails {
        address user; // Original bidder (owner of the stash)
        address stash; // The user's stash (BidderContract clone) address
        uint256 hbarAmount; // HBAR bid amount (in tinybars)
        uint256 lazyAmount; // $LAZY bid amount
        uint256 expiry; // Block timestamp expiry (0 = no expiry)
        address token; // Target NFT collection
        uint256[] serials; // Empty array = any serial, specific serials = exact match
        uint256 stashNonce; // Stash internal nonce for uniqueness
        uint256 createdAt; // Creation timestamp
    }

    // ============================================
    // Events
    // ============================================

    /// @notice Emitted when a user's stash is deployed. The `deployer` is
    ///         the tx sender — normally equal to `user`, but can differ when
    ///         a third party pays gas to bootstrap a stash via deployStashFor().
    event StashDeployed(
        address indexed user,
        address indexed stash,
        address indexed deployer
    );
    event BidCreated(
        bytes32 indexed bidId,
        address indexed user,
        address indexed token,
        BidDetails details
    );
    event BidCancelled(bytes32 indexed bidId, address indexed user);
    event BidExecuted(
        bytes32 indexed bidId,
        address indexed executor,
        bytes32 tradeId,
        uint256 arbitrageProfit
    );
    event BidExpired(bytes32 indexed bidId, address indexed user);
    event ExpiredBidsCleanup(address indexed cleaner, uint256 cleanedCount);
    event TradeCreatedFromStash(
        bytes32 indexed tradeId,
        address indexed stash,
        address indexed seller,
        address token,
        uint256 serial
    );

    // ============================================
    // Errors
    // ============================================

    error StashAlreadyExists();
    error NoStashForUser();
    error InvalidBidDetails();
    error BidNotFound();
    error BidHasExpired();
    error InsufficientFunds();
    error UnauthorizedCaller();
    error InvalidStash();
    error TradeExecutionFailed();
    error EmptyBidArray();
    error InvalidAddress();
    // NOTE: ArbitrageNotImplemented is kept until Phase 3 rips out the stub.
    error ArbitrageNotImplemented();

    // ============================================
    // Constructor
    // ============================================

    /**
     * @notice Initialize the factory with required contract addresses
     * @param _lazySecureTrade Address of LazySecureTrade contract
     * @param _lazyToken Address of $LAZY token
     * @param _lazyGasStation Address of LazyGasStation contract
     * @param _lazyDelegateRegistry Address of LazyDelegateRegistry contract
     * @param _bidderContractImplementation Address of BidderContract implementation to clone
     */
    constructor(
        address _lazySecureTrade,
        address _lazyToken,
        address _lazyGasStation,
        address _lazyDelegateRegistry,
        address _bidderContractImplementation
    ) {
        if (_lazySecureTrade == address(0)) revert InvalidAddress();
        if (_lazyToken == address(0)) revert InvalidAddress();
        if (_lazyGasStation == address(0)) revert InvalidAddress();
        if (_lazyDelegateRegistry == address(0)) revert InvalidAddress();
        if (_bidderContractImplementation == address(0))
            revert InvalidAddress();

        LAZY_SECURE_TRADE = ILazySecureTrade(_lazySecureTrade);
        LAZY_TOKEN = _lazyToken;
        LAZY_GAS_STATION = _lazyGasStation;
        LAZY_DELEGATE_REGISTRY = _lazyDelegateRegistry;

        // Store implementation contract address for cloning
        BIDDER_CONTRACT_IMPLEMENTATION = _bidderContractImplementation;
    }

    // ============================================
    // Deployment & Registry Functions
    // ============================================

    /**
     * @notice Deploy a stash for the caller (one per user).
     * @dev Convenience wrapper — equivalent to `deployStashFor(msg.sender)`.
     * @return stash Address of the deployed stash.
     */
    function deployStash() external nonReentrant returns (address stash) {
        return _deployStashFor(msg.sender);
    }

    /**
     * @notice Permissionlessly deploy a stash for any user.
     * @dev The owner of the stash is always `user`, never `msg.sender`, so
     *      this cannot be used to hijack a stash. The caller simply pays gas
     *      to bootstrap someone else's account — useful for onboarding flows,
     *      gasless-style relays, or agent-initiated setup.
     *
     *      The CREATE2 salt is derived solely from `user` (plus the version
     *      tag), so calling this for an already-deployed user will revert
     *      with `StashAlreadyExists`.
     * @param user The address that will own the stash.
     * @return stash Address of the deployed stash.
     */
    function deployStashFor(
        address user
    ) external nonReentrant returns (address stash) {
        if (user == address(0)) revert InvalidAddress();
        return _deployStashFor(user);
    }

    /**
     * @notice Predict the deterministic address at which `user`'s stash
     *         either already lives or will live when deployed.
     * @dev Pure CREATE2 derivation — computable off-chain given the factory
     *      address, implementation address, and user address, with no RPC
     *      call needed. Off-chain consumers (wallets, indexers, MCP agents)
     *      should prefer this pattern over `userToStash(user)` RPC lookups.
     * @param user The address whose stash address should be predicted.
     * @return The address at which the stash lives (or will live).
     */
    function getStashAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddress(
                BIDDER_CONTRACT_IMPLEMENTATION,
                _stashSalt(user),
                address(this)
            );
    }

    /**
     * @notice Check whether an address is a legitimate stash deployed by
     *         this factory for its claimed owner.
     * @dev Unlike the `isValidStash` mapping (which only records factory
     *      deployments), this re-derives the expected address from the
     *      owner recorded inside the stash itself and compares it to the
     *      input. A forged contract cannot pass this check because it
     *      cannot reproduce the CREATE2 derivation for an arbitrary owner
     *      without going through this factory's implementation.
     * @param stash Address to verify.
     * @return True iff `stash` is non-zero, is registered in `isValidStash`,
     *         AND lives at the CREATE2-predicted address for its owner.
     */
    function verifyStash(address stash) external view returns (bool) {
        if (stash == address(0) || !isValidStash[stash]) {
            return false;
        }
        address owner_ = BidderContract(payable(stash)).owner();
        return getStashAddress(owner_) == stash;
    }

    /**
     * @notice Get user's stash address (O(1) mapping read).
     * @dev Returns address(0) if no stash has been deployed yet. Off-chain
     *      callers can alternatively use `getStashAddress(user)` to compute
     *      the address without touching storage, but that returns the
     *      predicted address even before deployment. Prefer this function
     *      if you need to know whether the stash has been deployed.
     * @param user User address to query.
     * @return Stash address (address(0) if none).
     */
    function getStashOf(address user) external view returns (address) {
        return userToStash[user];
    }

    /**
     * @notice Get all deployed stashes.
     * @return Array of stash addresses.
     */
    function getAllStashes() external view returns (address[] memory) {
        return allStashes;
    }

    /**
     * @notice Get total number of deployed stashes.
     * @return Count of stashes.
     */
    function getStashCount() external view returns (uint256) {
        return allStashes.length;
    }

    // ============================================
    // Internal CREATE2 deployment helpers
    // ============================================

    /// @dev Deterministic salt derivation. The version tag is a constant so
    ///      any change requires a new factory deployment — protecting the
    ///      predicted-address invariant for existing users.
    function _stashSalt(address user) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(STASH_SALT_VERSION, user));
    }

    /// @dev Shared deploy-and-initialize path used by both `deployStash()`
    ///      and `deployStashFor(user)`. The clone is deployed at the exact
    ///      address returned by `getStashAddress(user)`, and `initialize()`
    ///      fires atomically so there is no front-run window on the new
    ///      clone (the implementation itself is locked via its constructor).
    function _deployStashFor(
        address user
    ) internal returns (address stash) {
        if (userToStash[user] != address(0)) {
            revert StashAlreadyExists();
        }

        stash = Clones.cloneDeterministic(
            BIDDER_CONTRACT_IMPLEMENTATION,
            _stashSalt(user)
        );

        BidderContract(payable(stash)).initialize(
            user,
            address(this),
            LAZY_TOKEN,
            address(LAZY_SECURE_TRADE),
            LAZY_GAS_STATION,
            LAZY_DELEGATE_REGISTRY
        );

        userToStash[user] = stash;
        isValidStash[stash] = true;
        allStashes.push(stash);

        emit StashDeployed(user, stash, msg.sender);
    }

    // ============================================
    // Bid Management Functions
    // ============================================

    /**
     * @notice Create a bid (called by BidderContract)
     * @param bidDetails Bid details struct
     * @return bidId Unique bid identifier
     */
    function createBid(
        BidDetails memory bidDetails
    ) external nonReentrant returns (bytes32 bidId) {
        // Validate caller is a valid BidderContract
        if (!isValidStash[msg.sender]) {
            revert InvalidStash();
        }

        // Validate bid details
        if (bidDetails.token == address(0)) {
            revert InvalidBidDetails();
        }
        if (bidDetails.hbarAmount == 0 && bidDetails.lazyAmount == 0) {
            revert InvalidBidDetails();
        }
        if (bidDetails.expiry != 0 && bidDetails.expiry <= block.timestamp) {
            revert InvalidBidDetails();
        }

        // Generate unique bid ID
        bidId = keccak256(
            abi.encodePacked(
                bidDetails.user,
                bidDetails.token,
                bidDetails.serials,
                bidDetails.stashNonce,
                block.timestamp
            )
        );

        // Store bid details
        bidDetails.createdAt = block.timestamp;
        bidRegistry[bidId] = bidDetails;

        // Add to discovery mappings
        tokenToBids[bidDetails.token].push(bidId);
        userToBids[bidDetails.user].push(bidId);

        // Increment counter
        totalBidCount++;

        emit BidCreated(bidId, bidDetails.user, bidDetails.token, bidDetails);
    }

    /**
     * @notice Cancel a bid
     * @param bidId Bid identifier to cancel
     */
    function cancelBid(bytes32 bidId) external nonReentrant {
        BidDetails memory bid = bidRegistry[bidId];

        if (bid.user == address(0)) {
            revert BidNotFound();
        }

        // Only bid owner or their BidderContract can cancel
        if (msg.sender != bid.user && msg.sender != bid.stash) {
            revert UnauthorizedCaller();
        }

        // Remove bid from registry
        _removeBidFromRegistry(bidId);

        emit BidCancelled(bidId, bid.user);
    }

    // ============================================
    // Discovery & Analytics Functions
    // ============================================

    /**
     * @notice Get all bids for a specific token
     * @param token Token address to query
     * @return Array of bid IDs
     */
    function getBidsForToken(
        address token
    ) external view returns (bytes32[] memory) {
        return tokenToBids[token];
    }

    /**
     * @notice Get all bids for a specific token (paginated)
     * @param token Token address to query
     * @param offset Starting index
     * @param limit Maximum number of results
     * @return Array of bid IDs
     */
    function getBidsForTokenPaginated(
        address token,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory) {
        bytes32[] memory allBids = tokenToBids[token];

        if (offset >= allBids.length) {
            return new bytes32[](0);
        }

        uint256 end = offset + limit;
        if (end > allBids.length) {
            end = allBids.length;
        }

        uint256 resultLength = end - offset;
        bytes32[] memory result = new bytes32[](resultLength);

        for (uint256 i = 0; i < resultLength; i++) {
            result[i] = allBids[offset + i];
        }

        return result;
    }

    /**
     * @notice Get all bids for a specific token/serial combination
     * @param token Token address
     * @param serial Serial number
     * @return Array of matching bid IDs
     */
    function getBidsForTokenSerial(
        address token,
        uint256 serial
    ) external view returns (bytes32[] memory) {
        bytes32[] memory tokenBids = tokenToBids[token];
        uint256 matchCount = 0;

        // First pass: count matches
        for (uint256 i = 0; i < tokenBids.length; i++) {
            if (_bidMatchesSerial(tokenBids[i], serial)) {
                matchCount++;
            }
        }

        // Second pass: populate result
        bytes32[] memory result = new bytes32[](matchCount);
        uint256 resultIndex = 0;

        for (uint256 i = 0; i < tokenBids.length; i++) {
            if (_bidMatchesSerial(tokenBids[i], serial)) {
                result[resultIndex] = tokenBids[i];
                resultIndex++;
            }
        }

        return result;
    }

    /**
     * @notice Get user's active bids
     * @param user User address
     * @return Array of bid IDs
     */
    function getUserBids(
        address user
    ) external view returns (bytes32[] memory) {
        return userToBids[user];
    }

    /**
     * @notice Get total bid count
     * @return Total number of bids ever created
     */
    function getTotalBidCount() external view returns (uint256) {
        return totalBidCount;
    }

    /**
     * @notice Get current active bid count for a token
     * @param token Token address
     * @return Number of active bids
     */
    function getTokenBidCount(address token) external view returns (uint256) {
        return tokenToBids[token].length;
    }

    // ============================================
    // Bid Validation Functions
    // ============================================

    /**
     * @notice Check if a bid is valid (not expired, sufficient funds)
     * @param bidId Bid identifier
     * @return valid Whether the bid is valid
     * @return reason Reason if invalid
     */
    function isBidValid(
        bytes32 bidId
    ) public view returns (bool valid, string memory reason) {
        BidDetails memory bid = bidRegistry[bidId];

        // Check if bid exists
        if (bid.user == address(0)) {
            return (false, "Bid not found");
        }

        // Check expiry first (cheapest check)
        if (bid.expiry != 0 && block.timestamp > bid.expiry) {
            return (false, "Bid expired");
        }

        // Check HBAR balance
        if (bid.hbarAmount > 0) {
            uint256 hbarBalance = bid.stash.balance;
            if (hbarBalance < bid.hbarAmount) {
                return (false, "Insufficient HBAR");
            }
        }

        // Check $LAZY balance if needed
        if (bid.lazyAmount > 0) {
            if (
                IERC20(LAZY_TOKEN).balanceOf(bid.stash) < bid.lazyAmount
            ) {
                return (false, "Insufficient $LAZY");
            }
        }

        return (true, "Valid");
    }

    /**
     * @notice Validate multiple bids at once
     * @param bidIds Array of bid IDs
     * @return validBids Boolean array of validity
     * @return reasons String array of reasons
     */
    function validateBids(
        bytes32[] memory bidIds
    ) external view returns (bool[] memory validBids, string[] memory reasons) {
        validBids = new bool[](bidIds.length);
        reasons = new string[](bidIds.length);

        for (uint256 i = 0; i < bidIds.length; i++) {
            (validBids[i], reasons[i]) = isBidValid(bidIds[i]);
        }
    }

    // ============================================
    // Internal Helper Functions
    // ============================================

    /**
     * @notice Remove bid from all registries
     * @param bidId Bid identifier
     */
    function _removeBidFromRegistry(bytes32 bidId) internal {
        BidDetails memory bid = bidRegistry[bidId];

        // Remove from tokenToBids
        _removeFromArray(tokenToBids[bid.token], bidId);

        // Remove from userToBids
        _removeFromArray(userToBids[bid.user], bidId);

        // Delete from main registry
        delete bidRegistry[bidId];
    }

    /**
     * @notice Remove an element from a bytes32 array
     * @param array Storage reference to array
     * @param element Element to remove
     */
    function _removeFromArray(
        bytes32[] storage array,
        bytes32 element
    ) internal {
        for (uint256 i = 0; i < array.length; i++) {
            if (array[i] == element) {
                // Move last element to this position and pop
                array[i] = array[array.length - 1];
                array.pop();
                break;
            }
        }
    }

    /**
     * @notice Check if bid matches a specific serial
     * @param bidId Bid identifier
     * @param serial Serial number to match
     * @return True if bid matches (empty serials = any serial)
     */
    function _bidMatchesSerial(
        bytes32 bidId,
        uint256 serial
    ) internal view returns (bool) {
        BidDetails memory bid = bidRegistry[bidId];

        // Empty serials array means any serial
        if (bid.serials.length == 0) {
            return true;
        }

        // Check if serial is in the list
        for (uint256 i = 0; i < bid.serials.length; i++) {
            if (bid.serials[i] == serial) {
                return true;
            }
        }

        return false;
    }

    // ============================================
    // Cleanup Functions
    // ============================================

    /**
     * @notice Cleanup expired bids (anyone can call for gas efficiency)
     * @param bidIds Array of bid IDs to check and cleanup
     * @return cleanedCount Number of bids cleaned up
     */
    function cleanupExpiredBids(
        bytes32[] memory bidIds
    ) external nonReentrant returns (uint256 cleanedCount) {
        if (bidIds.length == 0) {
            revert EmptyBidArray();
        }

        for (uint256 i = 0; i < bidIds.length; i++) {
            BidDetails memory bid = bidRegistry[bidIds[i]];

            if (
                bid.user != address(0) &&
                bid.expiry != 0 &&
                block.timestamp > bid.expiry
            ) {
                _removeBidFromRegistry(bidIds[i]);
                emit BidExpired(bidIds[i], bid.user);
                cleanedCount++;
            }
        }

        emit ExpiredBidsCleanup(msg.sender, cleanedCount);
    }

    // ============================================
    // Trade Creation from BidderContract
    // ============================================

    /**
     * @notice Create a trade in LazySecureTrade on behalf of a stash owner.
     * @dev Allows users to list NFTs held inside their stash without first
     *      withdrawing them. The stash itself (msg.sender, validated via
     *      `isValidStash`) is the actual HTS holder of the NFT; `seller` is
     *      recorded in the trade as the human owner (the stash's `owner`)
     *      so fee tiers, listing-fee exemption, and event attribution all
     *      resolve to the real user, not the stash contract.
     * @param seller Address of the seller (owner of the calling stash)
     * @param token NFT token address
     * @param buyer Address of the buyer
     * @param serial NFT serial number
     * @param tinybarPrice HBAR price in tinybars
     * @param lazyPrice $LAZY price
     * @param expiryTime Expiry timestamp (0 = no expiry)
     * @return tradeId Created trade identifier
     */
    function createTradeOnBehalfOfStash(
        address seller,
        address token,
        address buyer,
        uint256 serial,
        uint256 tinybarPrice,
        uint256 lazyPrice,
        uint256 expiryTime
    ) external nonReentrant returns (bytes32 tradeId) {
        // Validate caller is a factory-deployed stash
        if (!isValidStash[msg.sender]) {
            revert InvalidStash();
        }

        // Create trade in LazySecureTrade.
        // The stash (msg.sender) is the actual NFT holder;
        // `seller` is the human owner recorded on the trade.
        tradeId = LAZY_SECURE_TRADE.createTradeOnBehalf(
            seller,
            token,
            buyer,
            serial,
            tinybarPrice,
            lazyPrice,
            expiryTime
        );

        emit TradeCreatedFromStash(
            tradeId,
            msg.sender,
            seller,
            token,
            serial
        );
    }

    // ============================================
    // Trade Execution Functions
    // ============================================

    /**
     * @notice Execute against a bid (seller-initiated)
     * @param bidId Bid identifier
     * @param nftToken NFT token address
     * @param serial Serial number
     * @return tradeId Created trade ID
     */
    function executeAgainstBid(
        bytes32 bidId,
        address nftToken,
        uint256 serial
    ) external nonReentrant returns (bytes32 tradeId) {
        BidDetails memory bid = bidRegistry[bidId];

        // Check if bid exists
        if (bid.user == address(0)) {
            revert BidNotFound();
        }

        // Check if expired
        if (bid.expiry != 0 && block.timestamp > bid.expiry) {
            _removeBidFromRegistry(bidId);
            emit BidExpired(bidId, bid.user);
            revert BidHasExpired();
        }

        // Check HBAR balance if needed
        if (bid.hbarAmount > 0) {
            uint256 hbarBalance = bid.stash.balance;
            if (hbarBalance < bid.hbarAmount) {
                revert InsufficientFunds();
            }
        }

        // Validate serial matches bid requirements
        if (!_bidMatchesSerial(bidId, serial)) {
            revert InvalidBidDetails();
        }

        // Validate token matches
        if (bid.token != nftToken) {
            revert InvalidBidDetails();
        }

        // Create trade in LazySecureTrade on behalf of seller
        // Buyer is the BidderContract address
        tradeId = LAZY_SECURE_TRADE.createTradeOnBehalf(
            msg.sender, // seller (actual NFT owner)
            nftToken, // token address
            bid.stash, // buyer (BidderContract)
            serial, // serial number
            bid.hbarAmount, // tinybar price
            bid.lazyAmount, // lazy price
            0 // no expiry (execute immediately)
        );

        // Execute trade via BidderContract
        BidderContract(payable(bid.stash)).executeTrade(
            tradeId,
            bid.hbarAmount,
            bid.lazyAmount
        );

        // Remove bid from registry (cleanup after successful execution)
        _removeBidFromRegistry(bidId);

        // Emit execution event
        emit BidExecuted(bidId, msg.sender, tradeId, 0);
    }

    /**
     * @notice Execute arbitrage opportunity (third-party initiated)
     * @param bidId Bid identifier
     * @param existingTradeId Existing trade in LazySecureTrade
     * @return success Whether arbitrage was successful
     * @return arbitrageProfit Profit amount extracted
     */
    function executeArbitrage(
        bytes32 bidId,
        bytes32 existingTradeId
    ) external nonReentrant returns (bool, uint256) {
        BidDetails memory bid = bidRegistry[bidId];

        // Check if bid exists
        if (bid.user == address(0)) {
            revert BidNotFound();
        }

        // Check if expired
        if (bid.expiry != 0 && block.timestamp > bid.expiry) {
            revert BidHasExpired();
        }

        // Check HBAR balance if needed
        if (bid.hbarAmount > 0) {
            uint256 hbarBalance = bid.stash.balance;
            if (hbarBalance < bid.hbarAmount) {
                revert InsufficientFunds();
            }
        }

        // Get existing trade details from LazySecureTrade
        // Note: This requires getTrade to be public/external in LazySecureTrade
        // For now, we'll implement the basic structure

        // TODO: Implement arbitrage logic
        // 1. Validate existing trade is compatible with bid
        // 2. Execute trade via BidderContract
        // 3. Calculate arbitrage profit (bid price - trade price - fees)
        // 4. Split profit 50/50 between arbitrageur and factory
        // 5. Extract factory share from BidderContract
        // 6. Transfer arbitrageur share

        // Silence unused variable warnings
        existingTradeId;

        revert ArbitrageNotImplemented();
    }
}
