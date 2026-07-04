// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {TokenStakerV2} from "./TokenStakerV2.sol";
import {HederaTokenService} from "./HederaTokenService.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";
import {HederaResponseCodes} from "./HederaResponseCodes.sol";
import {LSHTierLib} from "./libraries/LSHTierLib.sol";
import {IBidderContractFactory} from "./interfaces/IBidderContractFactory.sol";
import {IAgentEnvelope} from "./interfaces/IAgentEnvelope.sol";
import {IEnglishAuction} from "./interfaces/IEnglishAuction.sol";

/**
 * @title EnglishAuction
 * @notice Timed-auction primitive for HTS NFTs + fungible bundles on
 *         Hedera. Supports min-step bidding, Foundation-style anti-snipe
 *         extension (capped), Tier-C bundles (up to 10 items mixing
 *         NFTs and FTs across collections), buy-now collapse, reserve
 *         price, manual per-collection royalty, beneficial-owner
 *         resolution against the BidderContractFactory, and pull-payment
 *         queues for all outbound value (refunds, seller proceeds,
 *         settle bounty, stuck NFT delivery).
 *
 * @dev    Hard-deletes auction structs on close — events carry full
 *         cold-start metadata. Same convention as BCF v0.3.
 *         48h timelock on `setBcf` and the two highest-blast-radius
 *         owner functions (protocol fee, settle bounty). Other admin
 *         setters apply instantly but affect only future auctions.
 */
contract EnglishAuction is
    Ownable,
    ReentrancyGuard,
    TokenStakerV2,
    IEnglishAuction
{
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeCast for uint256;
    using Address for address payable;

    // ============================================
    // Constants
    // ============================================

    /// @notice Maximum items per auction bundle. Any mix of NFTs + FTs.
    uint8 public constant MAX_BUNDLE_ITEMS = 10;

    /// @notice Maximum royalty-collector entries snapshotted per auction
    ///         (audit Finding 5). Each is one payout subcall at settle, so an
    ///         uncapped fan-out could push settlement past Hedera's 50-subcall
    ///         ceiling and lock the auction. Rejected at create time.
    uint8 public constant MAX_ROYALTY_ENTRIES = 12;

    /// @notice Basis-points denominator (100% = 10_000 bp).
    uint16 internal constant MAX_BPS = 10_000;

    /// @notice Timelock window for BCF rotation + high-blast-radius
    ///         admin changes. Matches LST's pattern.
    uint256 internal constant TIMELOCK_WINDOW = 48 hours;

    /// @notice Pagination cap on view functions returning active-auction
    ///         lists. Matches BCF's `MAX_VIEW_PAGINATION`.
    uint16 internal constant MAX_VIEW_PAGINATION = 200;

    // ============================================
    // Packed auction storage struct
    // ============================================

    /// @dev    Internal storage representation. Externally exposed via
    ///         `getAuctionSnapshot` (interface struct includes computed
    ///         fields like timeRemaining + nextMinimumBid).
    struct AuctionStorage {
        // slot 0 (29 bytes, 3 free)
        address seller;                // 20
        AuctionState state;            // 1 (enum, packs as uint8)
        PaymentToken payment;          // 1
        uint8 sellerTierAtCreate;      // 1
        uint16 minStepBps;             // 2
        uint16 antiSnipeWindow;        // 2
        uint16 antiSnipeExtension;     // 2

        // slot 1 (28 bytes, 4 free)
        uint64 closeAt;                // 8
        uint64 maxCloseAt;             // 8
        uint96 buyNowPrice;            // 12

        // slot 2 (32 bytes, full)
        address highBidder;            // 20
        uint96 highBid;                // 12

        // slot 3 (32 bytes, full)
        uint96 reservePrice;           // 12
        uint96 startPrice;             // 12
        uint64 nonce;                  // 8

        // Dynamic
        AuctionItem[] items;
        RoyaltyInfo[] royalties;
    }

    // ============================================
    // Storage
    // ============================================

    /// @notice Active + post-create auction state. Hard-deleted on
    ///         settle / fail / cancel.
    mapping(bytes32 => AuctionStorage) internal auctions;

    /// @notice Per-seller monotonic nonce, used in `auctionId =
    ///         keccak256(seller, nonce)`.
    mapping(address => uint64) public sellerNonce;

    /// @notice Per-bidder running balance of refunds owed in HBAR.
    ///         Pulled via `claim(PaymentToken.HBAR)`.
    mapping(address => uint256) public claimableHbar;

    /// @notice Per-bidder running balance of refunds owed in LAZY.
    ///         Pulled via `claim(PaymentToken.LAZY)`.
    mapping(address => uint256) public claimableLazy;

    /// @notice Protocol fees actually retained at settlement, per rail.
    ///         `withdrawProtocolFee` is bounded to these so the owner can
    ///         never withdraw commingled user escrow / queued refunds
    ///         (finding E). Internal to save bytecode; track via the
    ///         AuctionSettled(protocolFee) + ProtocolFeeWithdrawn events.
    mapping(PaymentToken => uint256) internal protocolFeesAccrued;

    /// @notice Tokens this contract has been associated with (lazy
    ///         association on first encounter, mirrors LST pattern).
    EnumerableSet.AddressSet internal associatedTokens;

    // ============================================
    // Admin-tunable config
    // ============================================

    /// @notice Base platform fee in bps. Bounded at 10% via setter
    ///         (intentional alignment with LST's instant-set pattern;
    ///         only `setBcf` is 48h timelocked because BCF rotation
    ///         is the cascading-blast-radius surface).
    uint16 public protocolFeeBps;

    /// @notice Settlement bounty in bps of settled amount. Paid to
    ///         the address that calls `settle(...)`. Bounded at 5%.
    uint16 public settlementBountyBps;

    /// @notice Bounded auction-duration limits, applied to user-created
    ///         auctions. Instant-set (only affects future auctions).
    uint64 public minDuration;
    uint64 public maxDuration;
    uint64 public maxExtensionWindow;

    /// @notice Defaults applied when an `AuctionParams` field is 0.
    uint16 public defaultMinStepBps;
    uint16 public defaultAntiSnipeWindow;
    uint16 public defaultAntiSnipeExtension;

    /// @notice Pause gate. Blocks `createAuction` and `placeBid` /
    ///         `buyNow`. Settle + claim remain callable so funds can
    ///         always exit.
    bool public paused;

    // ============================================
    // Beneficial-owner resolution (mirror LST)
    // ============================================

    /// @notice Canonical BidderContractFactory used for stash → human
    ///         resolution. Owner-settable with the same 48h timelock
    ///         pattern as LST.setBcf. address(0) = opt out.
    IBidderContractFactory public bcf;
    address public pendingBcf;
    uint64 public pendingBcfEta;

    // ============================================
    // Immutables
    // ============================================

    address public immutable LSH_GEN1;
    address public immutable LSH_MUTANT;
    address public immutable LSH_GEN2;
    address public immutable LAZY_NFT_STAKING;
    address public immutable LAZY_TOKEN;

    /// @notice VIPSubscription pointer. Owner-settable post-deploy;
    ///         when set non-zero, the seller's max(LSHTier, VIPTier)
    ///         drives the fee discount. Mutable to support BCF v2-
    ///         style migration. (No 48h timelock — VIP discount is a
    ///         smaller blast radius than BCF resolution.)
    address public vipSubscription;

    // ============================================
    // Forward-compat
    // ============================================

    /// @dev Reserved storage slots for future fields without disturbing
    ///      the existing layout. Same pattern as BidderContract.
    uint256[20] private __gap;

    // ============================================
    // Events (interface) + admin events
    // ============================================

    event BcfChangePending(address indexed newBcf, uint64 eta);
    event BcfRegistered(address indexed oldBcf, address indexed newBcf);
    event BcfChangeCancelled(address indexed cancelledBcf);

    event ProtocolFeeChanged(uint16 newBps);
    event SettlementBountyChanged(uint16 newBps);

    event PausedSet(bool paused);
    event VipSubscriptionSet(address indexed newVip);
    event DefaultsChanged(uint16 minStepBps, uint16 antiSnipeWindow, uint16 antiSnipeExtension);
    event DurationLimitsChanged(uint64 minDuration, uint64 maxDuration, uint64 maxExtensionWindow);
    event ProtocolFeeWithdrawn(address indexed to, PaymentToken indexed payment, uint256 amount);

    // ============================================
    // Errors
    // ============================================

    error InvalidAddress();
    error InvalidBps(uint16 bps);
    error InvalidBundleSize(uint256 count, uint8 max);
    error InvalidBundleItem(uint256 index);
    error InvalidDuration(uint64 given, uint64 min, uint64 max);
    error InvalidStartPrice();
    error InvalidReservePrice();
    error InvalidBuyNowPrice();
    error AuctionNotOpen(bytes32 id, AuctionState state);
    error AuctionAlreadyClosed(bytes32 id, uint64 closeAt);
    error AuctionStillOpen(bytes32 id, uint64 closeAt);
    error CannotCancelWithBids();
    error UserNotAuthorized();
    error BidderIsSeller();
    error BidBelowMinimum(uint96 attempted, uint96 minimum, uint96 currentHigh, uint16 stepBps);
    error WrongPaymentValue(uint256 sent, uint256 expected);
    error NothingToClaim();
    error ExceedsAccruedFees();
    error PaginationLimitTooLarge(uint16 max);
    error PausedExecution();
    error SellerNotOwnerOfNFT(address token, uint256 serial);
    error NoPendingChange();
    error TimelockNotElapsed();
    // HTSCallFailed(int256 code, bytes4 op) is inherited from TokenStakerV2.
    error NotWinner();
    error TooManyRoyalties(uint8 max);
    error AuctionNotSettled(bytes32 id);

    // ============================================
    // Modifiers
    // ============================================

    modifier whenNotPaused() {
        if (paused) revert PausedExecution();
        _;
    }

    // ============================================
    // Constructor
    // ============================================

    constructor(
        address _lazyToken,
        address _lazyGasStation,
        address _lazyDelegateRegistry,
        address _lshGen1,
        address _lshMutant,
        address _lshGen2,
        address _lazyNFTStaking
    ) {
        if (
            _lazyToken == address(0) ||
            _lazyGasStation == address(0) ||
            _lazyDelegateRegistry == address(0)
        ) revert InvalidAddress();

        initContracts(_lazyToken, _lazyGasStation, _lazyDelegateRegistry);

        LSH_GEN1 = _lshGen1;
        LSH_MUTANT = _lshMutant;
        LSH_GEN2 = _lshGen2;
        LAZY_NFT_STAKING = _lazyNFTStaking;
        LAZY_TOKEN = _lazyToken;

        // Sensible defaults — owner can tune via setters.
        protocolFeeBps = 100;            // 1%
        settlementBountyBps = 10;        // 0.1% — paid to anyone who calls settle
        minDuration = 1 hours;
        maxDuration = 7 days;
        maxExtensionWindow = 24 hours;
        defaultMinStepBps = 200;         // 2%
        defaultAntiSnipeWindow = 10 minutes;
        defaultAntiSnipeExtension = 10 minutes;
    }

    // ============================================
    // Beneficial-owner resolution (mirror LST)
    // ============================================

    /// @notice Two-mode setter: initial wire-up applies immediately,
    ///         subsequent rotation is 48h timelocked. Apply via
    ///         `executeBcfChange`; abandon a pending change via
    ///         `cancelBcfChange`.
    function setBcf(address _bcf) external onlyOwner {
        if (address(bcf) == address(0)) {
            bcf = IBidderContractFactory(_bcf);
            emit BcfRegistered(address(0), _bcf);
        } else {
            pendingBcf = _bcf;
            pendingBcfEta = uint64(block.timestamp) + uint64(TIMELOCK_WINDOW);
            emit BcfChangePending(_bcf, pendingBcfEta);
        }
    }

    function executeBcfChange() external {
        if (pendingBcfEta == 0) revert NoPendingChange();
        if (block.timestamp < pendingBcfEta) revert TimelockNotElapsed();
        address old = address(bcf);
        address newBcf = pendingBcf;
        bcf = IBidderContractFactory(newBcf);
        pendingBcf = address(0);
        pendingBcfEta = 0;
        emit BcfRegistered(old, newBcf);
    }

    function cancelBcfChange() external onlyOwner {
        if (pendingBcfEta == 0) revert NoPendingChange();
        address cancelled = pendingBcf;
        pendingBcf = address(0);
        pendingBcfEta = 0;
        emit BcfChangeCancelled(cancelled);
    }

    /// @dev If `bcf` is unset OR the call reverts, returns `addr`
    ///      unchanged — degraded fallback matches LST behavior.
    function _resolveBeneficialOwner(address addr) internal view returns (address) {
        if (address(bcf) == address(0)) return addr;
        try bcf.stashOwnerOf(addr) returns (address owner) {
            return owner == address(0) ? addr : owner;
        } catch {
            return addr;
        }
    }

    // ============================================
    // Read API
    // ============================================

    function currentTimestamp() external view returns (uint64) {
        return uint64(block.timestamp);
    }

    function getClaimable(address user) external view returns (uint256 hbar, uint256 lazy) {
        return (claimableHbar[user], claimableLazy[user]);
    }

    function getAuctionSnapshot(
        bytes32 auctionId
    ) external view returns (AuctionSnapshot memory snap) {
        AuctionStorage storage a = auctions[auctionId];
        snap.seller = a.seller;
        snap.state = a.state;
        snap.payment = a.payment;
        snap.sellerTierAtCreate = a.sellerTierAtCreate;
        snap.minStepBps = a.minStepBps;
        snap.antiSnipeWindow = a.antiSnipeWindow;
        snap.antiSnipeExtension = a.antiSnipeExtension;
        snap.closeAt = a.closeAt;
        snap.maxCloseAt = a.maxCloseAt;
        snap.reservePrice = a.reservePrice;
        snap.startPrice = a.startPrice;
        snap.buyNowPrice = a.buyNowPrice;
        snap.highBid = a.highBid;
        snap.highBidder = a.highBidder;
        snap.nonce = a.nonce;
        snap.items = a.items;
        snap.royalties = a.royalties;

        if (a.state == AuctionState.Open) {
            snap.nextMinimumBid = _minimumNextBid(a);
            if (block.timestamp < a.closeAt) {
                snap.timeRemaining = uint64(a.closeAt - block.timestamp);
            }
        }
    }

    // ============================================
    // Lifecycle: create / cancel
    // ============================================

    /// @notice Create an auction with a bundle of up to MAX_BUNDLE_ITEMS
    ///         items (NFTs + fungibles). NFT items are escrowed into
    ///         this contract; royalty schedules are snapshotted per
    ///         unique NFT token. Seller's LSH tier is snapshotted to
    ///         prevent a sell-LSH-before-settle game.
    function createAuction(
        AuctionParams calldata params,
        IAgentEnvelope.AgentAuth calldata auth
    ) external nonReentrant whenNotPaused returns (bytes32 auctionId) {
        return _createAuctionFor(msg.sender, params, auth);
    }

    /// @dev Internal create path. Used by `createAuction` (msg.sender
    ///      is the seller). For agent-mediated flows, the seller's
    ///      stash exposes a `createAuctionListing` entry point that
    ///      performs envelope verification + forwards here.
    function _createAuctionFor(
        address seller,
        AuctionParams calldata params,
        IAgentEnvelope.AgentAuth calldata auth
    ) internal returns (bytes32 auctionId) {
        // Validate bundle
        uint256 itemCount = params.items.length;
        if (itemCount == 0 || itemCount > MAX_BUNDLE_ITEMS) {
            revert InvalidBundleSize(itemCount, MAX_BUNDLE_ITEMS);
        }
        // Validate prices + duration
        if (params.startPrice == 0) revert InvalidStartPrice();
        if (params.reservePrice > 0 && params.reservePrice < params.startPrice) {
            revert InvalidReservePrice();
        }
        if (params.buyNowPrice > 0 && params.buyNowPrice < params.reservePrice) {
            revert InvalidBuyNowPrice();
        }
        if (params.duration < minDuration || params.duration > maxDuration) {
            revert InvalidDuration(params.duration, minDuration, maxDuration);
        }

        // Generate auctionId from per-seller nonce
        uint64 nonce = sellerNonce[seller]++;
        auctionId = keccak256(abi.encodePacked(seller, nonce));

        // Snapshot tier + escrow bundle
        AuctionStorage storage a = auctions[auctionId];
        a.seller = seller;
        a.state = AuctionState.Open;
        a.payment = params.payment;
        // Finding 3: resolve the beneficial owner before snapshotting the LSH
        // fee tier. For a stash seller the LSH tokens live in the human owner's
        // wallet, so the raw stash resolves to Free tier and voids the
        // discount. Mirrors LST's Bug-3 fix.
        a.sellerTierAtCreate = uint8(_resolveSellerTier(_resolveBeneficialOwner(seller)));
        a.minStepBps = params.minStepBps == 0 ? defaultMinStepBps : params.minStepBps;
        a.antiSnipeWindow = params.antiSnipeWindow == 0
            ? defaultAntiSnipeWindow : params.antiSnipeWindow;
        a.antiSnipeExtension = params.antiSnipeExtension == 0
            ? defaultAntiSnipeExtension : params.antiSnipeExtension;
        a.closeAt = uint64(block.timestamp) + params.duration;
        a.maxCloseAt = a.closeAt + uint64(maxExtensionWindow);
        a.reservePrice = params.reservePrice;
        a.startPrice = params.startPrice;
        a.buyNowPrice = params.buyNowPrice;
        a.nonce = nonce;

        // Persist items + snapshot royalty per unique NFT token + escrow
        _persistItemsAndEscrow(a, seller, params.items);

        emit AuctionCreated(
            auctionId,
            seller,
            params.payment,
            params.items,
            params.reservePrice,
            params.startPrice,
            params.buyNowPrice,
            a.closeAt,
            a.maxCloseAt,
            a.sellerTierAtCreate,
            bytes32(uint256(uint160(auth.agentKey))),
            auth.reasoningTopicId
        );
    }

    /// @notice Cancel a zero-bid auction. Returns escrowed items to
    ///         seller. Reverts after the first bid.
    function cancelAuction(bytes32 auctionId) external nonReentrant {
        AuctionStorage storage a = auctions[auctionId];
        if (a.state != AuctionState.Open) revert AuctionNotOpen(auctionId, a.state);
        // Cross-vector beneficial-owner-resolved seller check
        if (_resolveBeneficialOwner(msg.sender) != _resolveBeneficialOwner(a.seller)) {
            revert UserNotAuthorized();
        }
        if (a.highBidder != address(0)) revert CannotCancelWithBids();

        address seller = a.seller;
        AuctionItem[] memory itemsCopy = a.items;
        // Hard-delete before external interactions (CEI)
        delete auctions[auctionId];

        // Return bundle to seller. If a transfer reverts (e.g., seller
        // de-associated mid-auction), revert the whole tx — seller must
        // re-associate and try again. No claim queue here because
        // no bidder is involved.
        _releaseBundle(itemsCopy, seller);

        emit AuctionCancelled(auctionId, seller);
    }

    // ============================================
    // Lifecycle: bid + buy-now
    // ============================================

    /// @notice Place a bid. If `amount >= buyNowPrice` AND a buy-now
    ///         is configured, the auction immediately settles at the
    ///         buy-now price (excess refunded via claim queue).
    function placeBid(
        bytes32 auctionId,
        uint96 amount,
        IAgentEnvelope.AgentAuth calldata auth
    ) external payable nonReentrant whenNotPaused {
        _placeBid(auctionId, amount, auth, false);
    }

    /// @notice Convenience wrapper: pay exactly buyNowPrice to collapse
    ///         the auction. Same effect as calling placeBid with the
    ///         buy-now price.
    function buyNow(
        bytes32 auctionId,
        IAgentEnvelope.AgentAuth calldata auth
    ) external payable nonReentrant whenNotPaused {
        AuctionStorage storage a = auctions[auctionId];
        if (a.buyNowPrice == 0) revert InvalidBuyNowPrice();
        _placeBid(auctionId, a.buyNowPrice, auth, true);
    }

    function _placeBid(
        bytes32 auctionId,
        uint96 amount,
        IAgentEnvelope.AgentAuth calldata auth,
        bool calledViaBuyNow
    ) internal {
        AuctionStorage storage a = auctions[auctionId];
        if (a.state != AuctionState.Open) revert AuctionNotOpen(auctionId, a.state);
        if (block.timestamp >= a.closeAt) revert AuctionAlreadyClosed(auctionId, a.closeAt);

        // Self-bid block: bidder's beneficial owner must differ from seller's
        if (
            _resolveBeneficialOwner(msg.sender) ==
            _resolveBeneficialOwner(a.seller)
        ) revert BidderIsSeller();

        // Validate bid amount
        uint96 minBid = _minimumNextBid(a);
        if (amount < minBid) {
            revert BidBelowMinimum(amount, minBid, a.highBid, a.minStepBps);
        }

        // Validate payment matches amount
        if (a.payment == PaymentToken.HBAR) {
            if (msg.value != amount) revert WrongPaymentValue(msg.value, amount);
        } else {
            if (msg.value != 0) revert WrongPaymentValue(msg.value, 0);
            // Pull LAZY via allowance
            bool ok = IERC20(LAZY_TOKEN).transferFrom(msg.sender, address(this), amount);
            if (!ok) revert HTSCallFailed(0, "LAZY");
        }

        // Buy-now collapse path
        uint96 buyNow_ = a.buyNowPrice;
        bool triggeredBuyNow = (buyNow_ > 0 && amount >= buyNow_);
        uint96 effectiveBid = triggeredBuyNow ? buyNow_ : amount;

        // Refund excess (buy-now collapsed bid above buy-now price)
        if (triggeredBuyNow && amount > buyNow_) {
            uint256 excess = uint256(amount) - uint256(buyNow_);
            _queueRefund(msg.sender, a.payment, excess);
        }

        // Refund the previous high bidder
        address prevBidder = a.highBidder;
        uint96 prevHigh = a.highBid;
        if (prevBidder != address(0)) {
            _queueRefund(prevBidder, a.payment, prevHigh);
        }

        // Update auction state
        a.highBidder = msg.sender;
        a.highBid = effectiveBid;

        // Anti-snipe extension (only if not buy-now collapse)
        bool extended;
        uint64 prevCloseAt = a.closeAt;
        if (!triggeredBuyNow) {
            uint64 timeLeft = a.closeAt - uint64(block.timestamp);
            if (timeLeft <= a.antiSnipeWindow) {
                uint64 newCloseAt = uint64(block.timestamp) + a.antiSnipeExtension;
                if (newCloseAt > a.maxCloseAt) newCloseAt = a.maxCloseAt;
                if (newCloseAt > a.closeAt) {
                    a.closeAt = newCloseAt;
                    extended = true;
                    emit AuctionExtended(auctionId, prevCloseAt, newCloseAt);
                }
            }
        }

        emit BidCreated(
            auctionId,
            msg.sender,
            effectiveBid,
            prevHigh,
            prevBidder,
            extended,
            a.closeAt,
            triggeredBuyNow,
            bytes32(uint256(uint160(auth.agentKey))),
            auth.reasoningTopicId
        );

        // If buy-now triggered (or called via buyNow), settle immediately
        if (triggeredBuyNow || calledViaBuyNow) {
            _settleInternal(auctionId, msg.sender);
        }
    }

    // ============================================
    // Settlement
    // ============================================

    /// @notice Settle an auction after closeAt. Permissionless after
    ///         expiry. Bounty paid to caller via claim queue.
    function settle(bytes32 auctionId) external nonReentrant {
        AuctionStorage storage a = auctions[auctionId];
        if (a.state != AuctionState.Open) revert AuctionNotOpen(auctionId, a.state);
        if (block.timestamp < a.closeAt) revert AuctionStillOpen(auctionId, a.closeAt);
        _settleInternal(auctionId, msg.sender);
    }

    /// @dev    Atomic CEI: state first, then HBAR/LAZY distribution
    ///         (pull-payment fallback for seller proceeds), then
    ///         bundle delivery. If bundle delivery reverts (e.g.,
    ///         recipient unassociated with one of the bundle tokens),
    ///         the WHOLE tx reverts via EVM atomicity — recipient
    ///         must associate + retry settle. No partial state.
    function _settleInternal(bytes32 auctionId, address settler) internal {
        AuctionStorage storage a = auctions[auctionId];

        address seller = a.seller;
        address winner = a.highBidder;
        uint96 winningBid = a.highBid;
        PaymentToken payment = a.payment;
        uint96 reservePrice = a.reservePrice;
        uint8 sellerTier = a.sellerTierAtCreate;
        RoyaltyInfo[] memory royaltiesCopy = a.royalties;
        bool success = winner != address(0) && winningBid >= reservePrice;

        // Pull-claim (audit Finding 1): settle pays out the PROCEEDS and
        // finalises the record, but does NOT deliver the NFT bundle — that is
        // deferred to `claimAuctionNFT`. The escrowed bundle stays put, so an
        // unassociated / absent recipient can never brick settlement (the
        // grief dissolves: it only blocks the recipient's own later claim).
        // Mark Settled up-front (CEI); `a.items` is intentionally left in
        // storage for the deferred claim.
        a.state = AuctionState.Settled;

        if (success) {
            uint96 protocolFee = _computeProtocolFee(winningBid, sellerTier);
            uint96 bounty = uint96((uint256(winningBid) * settlementBountyBps) / MAX_BPS);
            // Finding B: royalties draw from the pool left after fee + bounty
            // (both < 15% of the bid) and are capped at what remains, so a
            // high-royalty bundle (Σ royalty bps can exceed 100%) can never
            // underflow the seller's cut and brick settlement. sellerProceeds
            // doubles as the running remainder, ending as the seller's take.
            uint96 sellerProceeds = winningBid - protocolFee - bounty;
            uint96 totalRoyalty;
            for (uint256 i; i < royaltiesCopy.length; ) {
                uint96 amt = uint96((uint256(winningBid) * royaltiesCopy[i].bps) / MAX_BPS);
                if (amt > sellerProceeds) amt = sellerProceeds;
                if (amt > 0) {
                    _payOrQueue(royaltiesCopy[i].collector, payment, amt);
                    totalRoyalty += amt;
                    sellerProceeds -= amt;
                }
                unchecked { ++i; }
            }

            // Finding E: track retained protocol fees so withdrawProtocolFee
            // stays bounded and can never touch user escrow.
            protocolFeesAccrued[payment] += protocolFee;

            _payOrQueue(seller, payment, sellerProceeds);
            if (bounty > 0) _queueRefund(settler, payment, bounty);

            // NFT claimant = the winner (a.highBidder already holds it). The
            // bundle is delivered when the winner calls claimAuctionNFT.
            emit AuctionSettled(
                auctionId, seller, winner, true,
                winningBid, protocolFee, totalRoyalty, sellerProceeds,
                settler, bounty, bytes32(0), bytes32(0)
            );
        } else {
            if (winner != address(0)) {
                _queueRefund(winner, payment, winningBid);
            }
            // Auction failed / reserve not met → the SELLER reclaims the
            // bundle. Record them as the NFT claimant so claimAuctionNFT
            // delivers uniformly from `a.highBidder`.
            a.highBidder = seller;
            emit AuctionSettled(
                auctionId, seller, winner, false,
                winningBid, 0, 0, 0, settler, 0, bytes32(0), bytes32(0)
            );
        }
    }

    /**
     * @notice Deliver a settled auction's NFT bundle to its claimant — the
     *         winner on a successful settle, or the seller on a
     *         failed / reserve-not-met settle. Permissionless: the escrowed
     *         bundle always goes to the RECORDED claimant, and EnglishAuction
     *         funds the 1-tinybar custody hop (Finding 4), so the claimant
     *         needs no HBAR allowance. The claimant must be associated with
     *         each bundle token; if not, this reverts and can simply be
     *         re-called after they associate (audit Finding 1 — no lock).
     * @param auctionId The settled auction to claim.
     */
    function claimAuctionNFT(bytes32 auctionId) external nonReentrant {
        AuctionStorage storage a = auctions[auctionId];
        if (a.state != AuctionState.Settled) revert AuctionNotSettled(auctionId);
        address claimant = a.highBidder;
        AuctionItem[] memory itemsCopy = a.items;
        // Hard-delete before the external delivery (CEI).
        delete auctions[auctionId];
        _releaseBundle(itemsCopy, claimant);
        emit AuctionBundleClaimed(auctionId, claimant);
    }

    // ============================================
    // Claim queues
    // ============================================

    /// @notice Pull accumulated HBAR or LAZY refunds.
    function claim(PaymentToken payment) external nonReentrant {
        if (payment == PaymentToken.HBAR) {
            uint256 amount = claimableHbar[msg.sender];
            if (amount == 0) revert NothingToClaim();
            claimableHbar[msg.sender] = 0;
            (bool ok, ) = payable(msg.sender).call{value: amount}("");
            if (!ok) {
                // Restore on push failure — user must fix their wallet
                claimableHbar[msg.sender] = amount;
                revert HTSCallFailed(0, "PULL");
            }
            emit RefundClaimed(msg.sender, payment, amount);
        } else {
            uint256 amount = claimableLazy[msg.sender];
            if (amount == 0) revert NothingToClaim();
            claimableLazy[msg.sender] = 0;
            bool ok = IERC20(LAZY_TOKEN).transfer(msg.sender, amount);
            if (!ok) {
                claimableLazy[msg.sender] = amount;
                revert HTSCallFailed(0, "PULL");
            }
            emit RefundClaimed(msg.sender, payment, amount);
        }
    }

    // NOTE: the claimAuctionNFT stub (a pure revert) was removed to reclaim
    // bytecode. If a recipient's settle reverts (e.g., unassociated with a
    // bundle token), EVM atomicity leaves no partial state — they associate
    // the token and re-call settle. (Audit finding I: non-issue by design.)

    // ============================================
    // Admin (instant)
    // ============================================

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setVipSubscription(address _vip) external onlyOwner {
        vipSubscription = _vip;
        emit VipSubscriptionSet(_vip);
    }

    function setDefaults(
        uint16 _minStepBps,
        uint16 _antiSnipeWindow,
        uint16 _antiSnipeExtension
    ) external onlyOwner {
        if (_minStepBps > MAX_BPS) revert InvalidBps(_minStepBps);
        defaultMinStepBps = _minStepBps;
        defaultAntiSnipeWindow = _antiSnipeWindow;
        defaultAntiSnipeExtension = _antiSnipeExtension;
        emit DefaultsChanged(_minStepBps, _antiSnipeWindow, _antiSnipeExtension);
    }

    function setDurationLimits(
        uint64 _minDuration,
        uint64 _maxDuration,
        uint64 _maxExtensionWindow
    ) external onlyOwner {
        if (_minDuration == 0 || _maxDuration < _minDuration) {
            revert InvalidDuration(_minDuration, 1, _maxDuration);
        }
        minDuration = _minDuration;
        maxDuration = _maxDuration;
        maxExtensionWindow = _maxExtensionWindow;
        emit DurationLimitsChanged(_minDuration, _maxDuration, _maxExtensionWindow);
    }

    // ============================================
    // Admin — instant (operational-multisig expected)
    // ============================================
    //
    // Setters in this section are deliberately instant on-chain. Per
    // the owner administration model (see SECURITY.md), the owner is
    // expected to be a multisig wallet with an operational-layer
    // timelock — that's the user-facing notice window. Bounded by
    // BPS / parameter caps inside each setter. Code-path rotations
    // that DO require an on-chain timelock (`setBcf`) live in the
    // "Beneficial-owner resolution" section further up.

    function setProtocolFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > 1_000) revert InvalidBps(newBps); // cap at 10%
        protocolFeeBps = newBps;
        emit ProtocolFeeChanged(newBps);
    }

    function setSettlementBountyBps(uint16 newBps) external onlyOwner {
        if (newBps > 500) revert InvalidBps(newBps); // cap at 5%
        settlementBountyBps = newBps;
        emit SettlementBountyChanged(newBps);
    }

    /// @notice Withdraw accumulated protocol fees.
    function withdrawProtocolFee(
        address to,
        PaymentToken payment,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        // Finding E: bound to fees actually accrued at settlement and debit
        // before the transfer (CEI) so user escrow can never be withdrawn.
        if (amount > protocolFeesAccrued[payment]) revert ExceedsAccruedFees();
        protocolFeesAccrued[payment] -= amount;
        if (payment == PaymentToken.HBAR) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert HTSCallFailed(0, "WD");
        } else {
            bool ok = IERC20(LAZY_TOKEN).transfer(to, amount);
            if (!ok) revert HTSCallFailed(0, "WD");
        }
        emit ProtocolFeeWithdrawn(to, payment, amount);
    }

    // ============================================
    // Internal helpers — bundle escrow / release
    // ============================================

    /// @dev Validates each item, persists into storage, escrows each
    ///      NFT/FT into the contract, and dedupes royalty schedules
    ///      per unique NFT token.
    function _persistItemsAndEscrow(
        AuctionStorage storage a,
        address seller,
        AuctionItem[] calldata items
    ) internal {
        // Track unique NFT tokens for royalty dedup
        address[] memory uniqueTokens = new address[](items.length);
        uint256 uniqueCount;

        for (uint256 i; i < items.length; ) {
            AuctionItem calldata item = items[i];
            if (item.token == address(0)) revert InvalidBundleItem(i);
            if (item.serialOrAmount == 0) revert InvalidBundleItem(i);

            // Persist into storage
            a.items.push(item);

            // Lazy-associate this contract with the token if needed
            if (!associatedTokens.contains(item.token)) {
                _associateToken(item.token);
                associatedTokens.add(item.token);
            }

            // Escrow
            if (item.isNFT) {
                // Verify seller owns the NFT (catches stale auctions)
                address ownerOfSerial = IERC721(item.token).ownerOf(item.serialOrAmount);
                if (ownerOfSerial != seller) {
                    revert SellerNotOwnerOfNFT(item.token, item.serialOrAmount);
                }

                // Use moveNFTs (STAKING direction, CUSTODY_HOP_TINYBAR).
                // The 1-tinybar HBAR side keeps HTS happy; the real
                // royalty is paid manually at settle via our snapshot.
                uint256[] memory serials = new uint256[](1);
                serials[0] = item.serialOrAmount;
                moveNFTs(
                    TransferDirection.STAKING,
                    item.token,
                    serials,
                    seller,
                    false,
                    CUSTODY_HOP_TINYBAR
                );

                // Snapshot royalty if not already snapshotted for this
                // NFT token. Look it up via HTS getTokenCustomFees.
                bool seen;
                for (uint256 j; j < uniqueCount; ) {
                    if (uniqueTokens[j] == item.token) { seen = true; break; }
                    unchecked { ++j; }
                }
                if (!seen) {
                    uniqueTokens[uniqueCount++] = item.token;
                    _snapshotRoyalty(a, item.token);
                }
            } else {
                // NEW-1 (audit 2026-07-04): reject fungible items whose token
                // carries a custom fee. A fractional/fixed HTS fee is netted
                // from (or charged on top of) every transfer, so the amount
                // escrowed IN and the amount paid OUT diverge — `_releaseBundle`
                // would then revert on the shortfall and, because bundle release
                // is all-or-nothing, permanently lock the ENTIRE settled bundle
                // (NFTs included) after the winner has already paid. Fail fast
                // at create instead. Fee-FREE fungibles (e.g. $LAZY) still
                // bundle fine; NFT creator royalties are the intended fee case
                // and are handled separately (snapshotted here, paid at settle).
                // Fail-safe: an unreadable fee schedule is refused rather than
                // risk a post-payment lock.
                (int256 feeRc, IHederaTokenService.TokenInfo memory ftInfo) =
                    HederaTokenService.getTokenInfo(item.token);
                if (
                    feeRc != HederaResponseCodes.SUCCESS ||
                    ftInfo.fixedFees.length != 0 ||
                    ftInfo.fractionalFees.length != 0
                ) {
                    revert InvalidBundleItem(i);
                }

                // Fungible escrow: pull from seller via allowance
                int256 rc = HederaTokenService.transferToken(
                    item.token,
                    seller,
                    address(this),
                    SafeCast.toInt64(int256(item.serialOrAmount))
                );
                if (rc != HederaResponseCodes.SUCCESS) revert HTSCallFailed(rc, "FTIN");
            }

            unchecked { ++i; }
        }
    }

    /// @dev Reads royalty schedule via HTS precompile and pushes into
    ///      the auction's royalty snapshot. If the call fails or the
    ///      token has no royalty, snapshot is skipped.
    function _snapshotRoyalty(AuctionStorage storage a, address token) internal {
        (int256 rc, IHederaTokenService.TokenInfo memory info) =
            HederaTokenService.getTokenInfo(token);
        if (rc != HederaResponseCodes.SUCCESS) return;
        IHederaTokenService.RoyaltyFee[] memory fees = info.royaltyFees;
        for (uint256 i; i < fees.length; ) {
            IHederaTokenService.RoyaltyFee memory f = fees[i];
            if (f.numerator > 0 && f.denominator > 0) {
                // Finding 5: bound the total royalty-collector count so
                // settlement can never exceed Hedera's 50-subcall ceiling.
                if (a.royalties.length >= MAX_ROYALTY_ENTRIES) {
                    revert TooManyRoyalties(MAX_ROYALTY_ENTRIES);
                }
                // Convert fractional to bps. Cap at MAX_BPS.
                uint256 bps = (uint256(f.numerator) * MAX_BPS)
                    / uint256(f.denominator);
                if (bps > MAX_BPS) bps = MAX_BPS;
                a.royalties.push(RoyaltyInfo({
                    token: token,
                    collector: f.feeCollector,
                    bps: uint16(bps)
                }));
            }
            unchecked { ++i; }
        }
    }

    /// @dev Release a bundle to a recipient. Reverts on any failure
    ///      (caller decides whether to bubble or stash).
    function _releaseBundle(AuctionItem[] memory items, address to) internal {
        for (uint256 i; i < items.length; ) {
            AuctionItem memory item = items[i];
            if (item.isNFT) {
                uint256[] memory serials = new uint256[](1);
                serials[0] = item.serialOrAmount;
                // Recipient-funded custody hop: the recipient (a stash via
                // F-3's `_ensureHbarAllowanceForCustodyHop`, or a direct EOA
                // that granted one) pays the 1-tinybar hop via a HIP-906
                // allowance to this contract. A contract cannot self-fund the
                // hop through the cryptoTransfer precompile (that reverts
                // INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE / code 326), so
                // Finding 4 is instead handled by the pull-claim model: an
                // unallowanced recipient simply grants the allowance and
                // re-calls claimAuctionNFT — no lock (Finding 1).
                moveNFTs(
                    TransferDirection.WITHDRAWAL,
                    item.token,
                    serials,
                    to,
                    false,
                    CUSTODY_HOP_TINYBAR
                );
            } else {
                int256 rc = HederaTokenService.transferToken(
                    item.token,
                    address(this),
                    to,
                    SafeCast.toInt64(int256(item.serialOrAmount))
                );
                if (rc != HederaResponseCodes.SUCCESS) revert HTSCallFailed(rc, "FTOU");
            }
            unchecked { ++i; }
        }
    }

    function _associateToken(address token) internal {
        int256 rc = HederaTokenService.associateToken(address(this), token);
        if (
            rc != HederaResponseCodes.SUCCESS &&
            rc != HederaResponseCodes.TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT
        ) {
            revert HTSCallFailed(rc, "ASSC");
        }
    }

    // ============================================
    // Internal helpers — pricing + tier + payment
    // ============================================

    function _minimumNextBid(AuctionStorage storage a) internal view returns (uint96) {
        if (a.highBid == 0) return a.startPrice;
        uint256 step = (uint256(a.highBid) * a.minStepBps) / MAX_BPS;
        if (step == 0) step = 1; // never zero — see code-critic M4
        return uint96(uint256(a.highBid) + step);
    }

    function _resolveSellerTier(address seller) internal view returns (LSHTierLib.Tier) {
        return LSHTierLib.getTierFor(seller, LSHTierLib.TierSources({
            lshGen1: LSH_GEN1,
            lshMutant: LSH_MUTANT,
            lshGen2: LSH_GEN2,
            lazyDelegateRegistry: address(lazyDelegateRegistry),
            lazyNFTStaking: LAZY_NFT_STAKING
        }));
    }

    function _computeProtocolFee(
        uint96 winningBid,
        uint8 sellerTier
    ) internal view returns (uint96) {
        // Tier discount table mirrors LST:
        //   Platinum (3) → 0% (100% discount)
        //   Gold (2)     → protocolFeeBps × 25 / 100
        //   Silver (1)   → protocolFeeBps × 50 / 100
        //   Free (0)     → protocolFeeBps
        if (sellerTier == uint8(LSHTierLib.Tier.Platinum)) return 0;
        uint16 effectiveBps;
        if (sellerTier == uint8(LSHTierLib.Tier.Gold)) {
            effectiveBps = uint16((uint256(protocolFeeBps) * 25) / 100);
        } else if (sellerTier == uint8(LSHTierLib.Tier.Silver)) {
            effectiveBps = uint16((uint256(protocolFeeBps) * 50) / 100);
        } else {
            effectiveBps = protocolFeeBps;
        }
        return uint96((uint256(winningBid) * effectiveBps) / MAX_BPS);
    }

    function _queueRefund(address recipient, PaymentToken payment, uint256 amount) internal {
        if (amount == 0) return;
        if (payment == PaymentToken.HBAR) {
            claimableHbar[recipient] += amount;
        } else {
            claimableLazy[recipient] += amount;
        }
    }

    /// @dev Try to push, fallback to claim queue on failure.
    function _payOrQueue(
        address recipient,
        PaymentToken payment,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        if (payment == PaymentToken.HBAR) {
            (bool ok, ) = payable(recipient).call{value: amount}("");
            if (!ok) claimableHbar[recipient] += amount;
        } else {
            try IERC20(LAZY_TOKEN).transfer(recipient, amount) returns (bool ok) {
                if (!ok) claimableLazy[recipient] += amount;
            } catch {
                claimableLazy[recipient] += amount;
            }
        }
    }

    // ============================================
    // HBAR receive
    // ============================================

    receive() external payable {}
}
