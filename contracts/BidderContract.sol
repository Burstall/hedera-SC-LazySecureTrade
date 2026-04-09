// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TokenStakerV2} from "./TokenStakerV2.sol";
import {ILazySecureTrade} from "./interfaces/ILazySecureTrade.sol";
import {IBidderContractFactory} from "./interfaces/IBidderContractFactory.sol";

/**
 * @title BidderContract
 * @notice User honeypot contract for holding funds and managing bids
 * @dev Deployed via minimal proxy pattern from BidderContractFactory
 * @dev Extends TokenStakerV2 for proper Hedera royalty handling on NFT withdrawals
 */
contract BidderContract is TokenStakerV2, ReentrancyGuard {
    using SafeCast for uint256;
    // ============================================
    // State Variables
    // ============================================

    /// @notice Owner of this BidderContract (user sovereignty)
    address public owner;

    /// @notice Factory address (admin rights for arbitrage only)
    address public factory;

    /// @notice LazySecureTrade address for trade execution
    address public lazySecureTradeAddress;

    /// @notice Internal nonce for bid uniqueness
    uint256 public nonce;

    /// @notice Associated tokens for NFT reception
    address[] public associatedTokens;

    /// @notice Track associated tokens
    mapping(address => bool) public isAssociated;

    /// @notice Initialization guard (for proxy pattern)
    bool private initialized;

    // ============================================
    // Events
    // ============================================

    // Note: No user-level events needed - only router cares about bid lifecycle
    // Users can monitor their BidderContract address for LazySecureTrade events

    // ============================================
    // Errors
    // ============================================

    error AlreadyInitialized();
    error OnlyOwner();
    error OnlyFactory();
    error OnlyOwnerOrFactory();
    error InvalidAddress();
    error InvalidAmount();
    error InsufficientBalance();
    error TransferFailed();
    error TokenAlreadyAssociated();
    error InvalidBidParameters();

    // ============================================
    // Modifiers
    // ============================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    modifier onlyOwnerOrFactory() {
        if (msg.sender != owner && msg.sender != factory)
            revert OnlyOwnerOrFactory();
        _;
    }

    // ============================================
    // Constructor — locks the implementation
    // ============================================

    /**
     * @notice Lock the implementation contract at its own address.
     * @dev This is the Hedera / OZ-style `_disableInitializers()` equivalent.
     *      The BidderContract is deployed once as an implementation and then
     *      cloned deterministically per user by BidderContractFactory. Clones
     *      have their own state (including `initialized = false`) and go
     *      through `initialize()` atomically at deploy time inside the factory.
     *
     *      The implementation contract itself, however, also has state — and
     *      an attacker could call `initialize(attacker, ...)` directly on the
     *      implementation address to claim ownership of it, then use any
     *      onlyOwner/onlyFactory function on that implementation instance.
     *      If the implementation ever accumulated residual HBAR or $LAZY
     *      (e.g., from a misrouted transfer), the attacker could drain it.
     *
     *      Setting `initialized = true` in the constructor means the
     *      implementation's initialize() path will always revert with
     *      AlreadyInitialized, while clones (which start with fresh storage)
     *      remain initializable exactly once via the factory.
     */
    constructor() {
        initialized = true;
    }

    // ============================================
    // Initialization (Proxy Pattern)
    // ============================================

    /**
     * @notice Initialize the BidderContract (called by factory after clone)
     * @param _owner Owner address (user)
     * @param _factory Factory address
     * @param _lazyToken $LAZY token address
     * @param _lazySecureTrade LazySecureTrade contract address
     * @param _lazyGasStation LazyGasStation contract address
     * @param _lazyDelegateRegistry LazyDelegateRegistry contract address
     */
    function initialize(
        address _owner,
        address _factory,
        address _lazyToken,
        address _lazySecureTrade,
        address _lazyGasStation,
        address _lazyDelegateRegistry
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (
            _owner == address(0) ||
            _factory == address(0) ||
            _lazyToken == address(0) ||
            _lazySecureTrade == address(0) ||
            _lazyGasStation == address(0) ||
            _lazyDelegateRegistry == address(0)
        ) {
            revert InvalidAddress();
        }

        owner = _owner;
        factory = _factory;
        lazyToken = _lazyToken;
        lazySecureTradeAddress = _lazySecureTrade;
        initialized = true;

        // Initialize TokenStakerV2 contracts
        initContracts(_lazyToken, _lazyGasStation, _lazyDelegateRegistry);
    }

    // ============================================
    // Fund Management (HTS Native)
    // ============================================

    /**
     * @notice Withdraw HBAR (user sovereignty)
     * @param amount Amount to withdraw in tinybars
     * @dev Keeps 1 HBAR (100_000_000 tinybars) in contract for gas/allowances
     */
    function withdrawHbar(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();

        uint256 minimumBalance = 100_000_000; // 1 HBAR in tinybars
        uint256 contractBalance = address(this).balance;

        // Ensure we're keeping at least 1 HBAR behind
        if (contractBalance < amount + minimumBalance)
            revert InsufficientBalance();

        (bool success, ) = payable(owner).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /**
     * @notice Withdraw $LAZY (user sovereignty)
     * @param amount Amount to withdraw
     */
    function withdrawLazy(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();

        bool success = IERC20(lazyToken).transfer(owner, amount);
        if (!success) revert TransferFailed();
    }

    /**
     * @notice Factory withdrawal for arbitrage profits
     * @param amount Amount to withdraw in tinybars
     */
    function factoryWithdrawHbar(
        uint256 amount
    ) external onlyFactory nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (address(this).balance < amount) revert InsufficientBalance();

        (bool success, ) = payable(factory).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /**
     * @notice Factory withdrawal for arbitrage profits
     * @param amount Amount to withdraw
     */
    function factoryWithdrawLazy(
        uint256 amount
    ) external onlyFactory nonReentrant {
        if (amount == 0) revert InvalidAmount();

        bool success = IERC20(lazyToken).transfer(factory, amount);
        if (!success) revert TransferFailed();
    }

    // ============================================
    // Token Association Management
    // ============================================

    /**
     * @notice Associate token using TokenStakerV2 pattern
     * @param token Token address to associate
     */
    function associateToken(address token) external onlyOwner {
        tokenAssociate(token);
        isAssociated[token] = true;
        associatedTokens.push(token);
    }

    /**
     * @notice Batch associate tokens using TokenStakerV2 pattern
     * @param tokens Array of token addresses to associate
     */
    function batchAssociateTokens(address[] memory tokens) external onlyOwner {
        safeBatchTokenAssociate(tokens);
        for (uint256 i = 0; i < tokens.length; i++) {
            if (!isAssociated[tokens[i]]) {
                isAssociated[tokens[i]] = true;
                associatedTokens.push(tokens[i]);
            }
        }
    }

    /**
     * @notice Check if token is associated
     * @param token Token address
     * @return True if associated
     */
    function isTokenAssociated(address token) external view returns (bool) {
        return isAssociated[token];
    }

    /**
     * @notice Get all associated tokens
     * @return Array of token addresses
     */
    function getAssociatedTokens() external view returns (address[] memory) {
        return associatedTokens;
    }

    // ============================================
    // Bid Creation
    // ============================================

    /**
     * @notice Create a bid (validates funds, calls factory)
     * @param token NFT collection address
     * @param serials Specific serials (empty = any serial)
     * @param hbarAmount HBAR bid amount in tinybars
     * @param lazyAmount $LAZY bid amount
     * @param expiry Expiry timestamp (0 = no expiry)
     * @return bidId Unique bid identifier
     */
    function createBid(
        address token,
        uint256[] memory serials,
        uint256 hbarAmount,
        uint256 lazyAmount,
        uint256 expiry
    ) external onlyOwner nonReentrant returns (bytes32 bidId) {
        // Validate parameters
        if (token == address(0)) revert InvalidBidParameters();
        if (hbarAmount == 0 && lazyAmount == 0) revert InvalidBidParameters();
        if (expiry != 0 && expiry <= block.timestamp)
            revert InvalidBidParameters();

        // Validate sufficient funds
        if (hbarAmount > 0 && address(this).balance < hbarAmount) {
            revert InsufficientBalance();
        }
        if (
            lazyAmount > 0 &&
            IERC20(lazyToken).balanceOf(address(this)) < lazyAmount
        ) {
            revert InsufficientBalance();
        }

        // Associate token if needed for NFT reception
        if (!isAssociated[token]) {
            tokenAssociate(token);
            isAssociated[token] = true;
            associatedTokens.push(token);
        }

        // Increment nonce for uniqueness
        nonce++;

        // Create bid details
        IBidderContractFactory.BidDetails
            memory bidDetails = IBidderContractFactory.BidDetails({
                user: owner,
                stash: address(this),
                hbarAmount: hbarAmount,
                lazyAmount: lazyAmount,
                expiry: expiry,
                token: token,
                serials: serials,
                stashNonce: nonce,
                createdAt: 0 // Factory will set this
            });

        // Call factory to create bid
        bidId = IBidderContractFactory(factory).createBid(bidDetails);
    }

    /**
     * @notice Cancel a bid
     * @param bidId Bid identifier
     */
    function cancelBid(bytes32 bidId) external onlyOwner {
        IBidderContractFactory(factory).cancelBid(bidId);
    }

    // ============================================
    // Trade Execution
    // ============================================

    /**
     * @notice Execute trade (called by factory during bid execution)
     * @param tradeId Trade identifier in LazySecureTrade
     * @param hbarAmount HBAR amount to send
     * @param lazyAmount $LAZY amount to approve (if needed)
     * @dev $LAZY allowance target is LazyGasStation, NOT LazySecureTrade.
     *      LST's _processLazyPayment calls lazyGasStation.drawLazyFromPayTo,
     *      and LGS checks the allowance on itself before the transferFrom —
     *      so the buyer (this contract) must have approved LGS as the spender.
     *      Approving LST would be a silent revert on any LAZY-denominated bid.
     */
    function executeTrade(
        bytes32 tradeId,
        uint256 hbarAmount,
        uint256 lazyAmount
    ) external payable onlyFactory nonReentrant {
        // Approve $LAZY directly to LazyGasStation (LGS is the actual spender
        // that LST delegates LAZY pulls to — see _processLazyPayment in LST).
        if (lazyAmount > 0) {
            IERC20(lazyToken).approve(address(lazyGasStation), lazyAmount);
        }

        // Execute trade in LazySecureTrade
        ILazySecureTrade(lazySecureTradeAddress).executeTrade{
            value: hbarAmount
        }(tradeId);
    }

    // ============================================
    // NFT Withdrawal (TokenStakerV2 Integration)
    // ============================================

    /**
     * @notice Withdraw NFTs using TokenStakerV2 moveNFTs (handles Hedera royalties)
     * @param tokens Array of token addresses
     * @param serials Array of serial arrays (one per token)
     * @param hbarAmounts Array of HBAR amounts per token (for royalties)
     * @dev Uses batchMoveNFTs which handles up to 8 serials per token automatically
     */
    function withdrawNFTs(
        address[] memory tokens,
        uint256[][] memory serials,
        int64[] memory hbarAmounts
    ) external onlyOwner nonReentrant {
        if (tokens.length != serials.length) revert InvalidBidParameters();
        if (tokens.length != hbarAmounts.length) revert InvalidBidParameters();
        if (tokens.length == 0) revert InvalidBidParameters();

        // Use TokenStakerV2.batchMoveNFTs for each token
        for (uint256 i = 0; i < tokens.length; i++) {
            batchMoveNFTs(
                TransferDirection.WITHDRAWAL,
                tokens[i],
                serials[i],
                owner,
                false, // no delegation
                hbarAmounts[i]
            );
        }
    }

    /**
     * @notice Simplified withdrawal for a single NFT back to the stash owner.
     * @dev Uses CUSTODY_HOP_TINYBAR (1) as the consideration — this is an internal
     *      custody hop (contract → user), NOT a sale. The original creator royalty
     *      was paid when the NFT entered the contract via an actual sale. See
     *      TokenStakerV2.CUSTODY_HOP_TINYBAR for full semantics.
     * @param token Token address
     * @param serial Serial number
     */
    function withdrawSingleNFT(
        address token,
        uint256 serial
    ) external onlyOwner nonReentrant {
        uint256[] memory serials = new uint256[](1);
        serials[0] = serial;

        batchMoveNFTs(
            TransferDirection.WITHDRAWAL,
            token,
            serials,
            owner,
            false, // no delegation
            CUSTODY_HOP_TINYBAR // internal custody hop, not a sale
        );
    }

    // ============================================
    // Trade Creation (List from BidderContract)
    // ============================================

    /**
     * @notice Create a trade in LazySecureTrade for NFTs held in this BidderContract
     * @param token NFT token address
     * @param buyer Buyer address
     * @param serial NFT serial number
     * @param tinybarPrice HBAR price in tinybars
     * @param lazyPrice $LAZY price
     * @param expiryTime Expiry timestamp (0 = no expiry)
     * @return tradeId Created trade identifier
     * @dev Allows users to list NFTs they've acquired via bids without withdrawing first
     */
    function createTrade(
        address token,
        address buyer,
        uint256 serial,
        uint256 tinybarPrice,
        uint256 lazyPrice,
        uint256 expiryTime
    ) external onlyOwner nonReentrant returns (bytes32 tradeId) {
        // Call factory to create trade on behalf of this stash
        tradeId = IBidderContractFactory(factory).createTradeOnBehalfOfStash(
            owner, // seller (the stash's human owner)
            token,
            buyer,
            serial,
            tinybarPrice,
            lazyPrice,
            expiryTime
        );
    }

    // ============================================
    // Receive Functions
    // ============================================

    /**
     * @notice Accept HBAR deposits
     */
    receive() external payable {}

    /**
     * @notice Fallback for HBAR deposits
     */
    fallback() external payable {}
}
