// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ILazySecureTrade} from "./interfaces/ILazySecureTrade.sol";
import {IBidderContractFactory} from "./interfaces/IBidderContractFactory.sol";
import {IAgentEnvelope} from "./interfaces/IAgentEnvelope.sol";
import {IVIPSubscription} from "./interfaces/IVIPSubscription.sol";
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
contract BidderContractFactory is Ownable, ReentrancyGuard, IBidderContractFactory {
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

    /// @notice Reverse of `userToStash`: stash address → human owner.
    ///         Populated at deploy, never re-written. Used by:
    ///           - `TradeCreatedFromStash` / `TradeCancelledFromStash` events
    ///             for off-chain consumers that want to index by owner
    ///             without a second lookup.
    ///           - `cancelTradeFromStash` authorization: confirms the EOA
    ///             calling cancel actually owns the stash that listed
    ///             the trade.
    mapping(address => address) public stashOwnerOf;

    /// @notice Token-based bid discovery (CLOB efficiency)
    mapping(address => bytes32[]) public tokenToBids;

    /// @notice User's active bids. Hard-deleted on bid close (swap-pop).
    ///         Use BidCreated / BidCancelled / BidExecuted / BidExpired
    ///         event history for closed-bid lookups.
    mapping(address => bytes32[]) public userToBids;

    /// @notice Core bid registry. Hard-deleted on bid close
    ///         (`delete bidRegistry[bidId]` inside `_closeBid`) — see
    ///         `BidStatus` for the state machine. The bid lifecycle
    ///         events (BidCreated / BidCancelled / BidExecuted /
    ///         BidExpired / ArbitrageExecuted) are the canonical history
    ///         layer; reading `bidRegistry[bidId]` after close returns
    ///         a zeroed struct.
    mapping(bytes32 => BidDetails) public bidRegistry;

    /// @notice Index of a bid inside `tokenToBids[token]`. Enables
    ///         O(1) swap-pop removal without scanning the array.
    mapping(bytes32 => uint256) internal _tokenBidIndex;

    /// @notice Index of a bid inside `userToBids[user]`. Same
    ///         purpose as `_tokenBidIndex`.
    mapping(bytes32 => uint256) internal _userBidIndex;

    /// @notice Maximum allowed `limit` on paginated view calls.
    ///         Enforced so a single caller can't accidentally blow
    ///         the view gas ceiling on a popular collection.
    uint256 public constant MAX_VIEW_PAGINATION = 200;

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
    // Arbitrage State
    // ============================================

    /// @notice Basis points of the arbitrage spread paid to the
    ///         arbitrageur. Default 5000 = 50%. The remainder goes to the
    ///         protocol. Changes are subject to a 48h timelock via
    ///         setArbitragePayoutBps + executeArbPayoutBpsChange.
    uint256 public arbitragePayoutBps = 5000;

    /// @notice Pending arbitrage payout bps change — zero when no change
    ///         is queued.
    uint256 public pendingArbPayoutBps;

    /// @notice Unix timestamp at which the pending bps change can be
    ///         applied. Zero when no change is queued.
    uint256 public arbPayoutBpsChangeEta;

    /// @notice Timelock delay for arbitrage parameter changes.
    uint256 internal constant ARB_PAYOUT_TIMELOCK = 48 hours;

    /// @notice Maximum arbitrage payout bps (100%) — above this the
    ///         protocol receives a negative share which is nonsensical.
    uint256 internal constant MAX_BPS = 10_000;

    /// @notice Per-arbitrageur HBAR profit ledger. Arbitrageurs call
    ///         claimArbProfit() to pull their accumulated profit.
    ///         Accrual is separated from payout so reentrancy during
    ///         the arbitrage execution path cannot race a payout.
    mapping(address => uint256) public pendingArbProfit;

    /// @notice Accumulated protocol share of arbitrage profits (HBAR).
    ///         Withdrawn by the factory owner via withdrawProtocolProfit.
    uint256 public pendingProtocolProfit;

    // ============================================
    // Factory-only enums (BidStatus + BidDetails inherited from IBidderContractFactory)
    // ============================================

    /// @notice Reason code returned by `isBidValid`. Factory-only — not
    ///         part of the cross-contract interface because only the factory
    ///         exposes bid validation views.
    enum BidValidityCode {
        Valid, // 0
        NotFound, // 1
        NotActive, // 2 — kept for ABI stability; unreachable after hard-delete
        Expired, // 3 — active but past expiry timestamp
        InsufficientHbar, // 4 — stash has less HBAR than bid.hbarAmount
        InsufficientLazy // 5 — stash has less $LAZY than bid.lazyAmount
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
    /// @notice Emitted when a bid is created.
    /// @dev    `agentKey` + `agentReasoningTopicId` are reserved for the
    ///         agent marketplace flow (per docs/AGENT-MARKETPLACE-DELTA.md).
    ///         In v0.3 they always emit as `bytes32(0)`; consumers should
    ///         treat any non-zero value as agent-originated.
    event BidCreated(
        bytes32 indexed bidId,
        address indexed user,
        address indexed token,
        BidDetails details,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );

    /// @notice Emitted when a bid is cancelled.
    /// @dev    Carries `token` for indexer cold-start (bids are
    ///         hard-deleted from `bidRegistry`, so registry lookups
    ///         post-cancel return zero). `agentKey`/`agentReasoningTopicId`
    ///         are placeholders — see BidCreated.
    event BidCancelled(
        bytes32 indexed bidId,
        address indexed user,
        address indexed token,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );

    /// @notice Emitted when a bid is matched against a trade (seller-
    ///         initiated `executeAgainstBid` flow; for arbitrage see
    ///         `ArbitrageExecuted`).
    /// @dev    Carries full bid metadata (user, token, hbarAmount,
    ///         lazyAmount) so a cold-start indexer can reconstruct a
    ///         closed bid without backfilling `BidCreated`. Bids are
    ///         hard-deleted on close. `agentKey`/`agentReasoningTopicId`
    ///         are placeholders.
    event BidExecuted(
        bytes32 indexed bidId,
        address indexed executor,
        bytes32 tradeId,
        uint256 arbitrageProfit,
        address user,
        address token,
        uint256 hbarAmount,
        uint256 lazyAmount,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );

    /// @notice Emitted when a bid expires.
    /// @dev    Fires from `cleanupExpiredBids` (explicit sweep) and from
    ///         `_validateBidForExecution` (inline sweep on execute attempt).
    ///         Carries `token` for indexer cold-start.
    event BidExpired(
        bytes32 indexed bidId,
        address indexed user,
        address indexed token,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );
    event ExpiredBidsCleanup(address indexed cleaner, uint256 cleanedCount);
    event TradeCreatedFromStash(
        bytes32 indexed tradeId,
        address indexed stash,
        address indexed seller,
        address token,
        uint256 serial,
        bytes32 agentKey,
        bytes32 reasoningTopic
    );

    /// @notice Emitted when a stash-listed LST trade is cancelled via
    ///         `cancelTradeFromStash`. Pairs with LST's own
    ///         `TradeCancelled` (seller=stash) — this event additionally
    ///         carries the human canceller identity so off-chain
    ///         consumers don't need a separate `stashOwnerOf` lookup.
    event TradeCancelledFromStash(
        bytes32 indexed tradeId,
        address indexed stash,
        address indexed canceller,
        bytes32 agentKey,
        bytes32 reasoningTopic
    );

    // ===== Arbitrage events =====

    /// @notice Emitted on a successful arbitrage match. The arbitrageur's
    ///         cut accrues to `pendingArbProfit[arbitrageur]`; the
    ///         protocol's share accrues to `pendingProtocolProfit`.
    /// @dev    Carries full bid metadata for cold-start indexer recovery
    ///         (bids are hard-deleted on close). `agentKey` +
    ///         `agentReasoningTopicId` are reserved for the agent
    ///         marketplace flow — always `bytes32(0)` in v0.3.
    event ArbitrageExecuted(
        bytes32 indexed bidId,
        bytes32 indexed tradeId,
        address indexed arbitrageur,
        uint256 arbCut,
        uint256 protocolCut,
        address user,
        address token,
        uint256 hbarAmount,
        uint256 lazyAmount,
        bytes32 agentKey,
        bytes32 agentReasoningTopicId
    );

    /// @notice Emitted when an arbitrageur claims their accrued profit.
    event ArbProfitClaimed(address indexed arbitrageur, uint256 amount);

    /// @notice Emitted when the factory owner withdraws accrued protocol
    ///         profit.
    event ProtocolProfitWithdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when a payoutBps change is proposed by the owner.
    ///         `eta` is the earliest timestamp at which the change can
    ///         be applied via executeArbPayoutBpsChange.
    event ArbPayoutBpsChangePending(uint256 newBps, uint256 eta);

    /// @notice Emitted when a pending payoutBps change is applied.
    event ArbPayoutBpsChanged(uint256 newBps);

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

    /// @notice The trade looked up on LST does not exist (seller == 0).
    error TradeNotFoundOrInvalid();

    /// @notice The trade's seller is not a registered stash. Used by
    ///         `cancelTradeFromStash` to reject cancellation routing for
    ///         EOA-listed trades (which should go directly to LST).
    error NotStashListed();

    // ===== Arbitrage errors =====

    /// @notice The referenced trade cannot be arbitraged against this bid —
    ///         it does not exist, is not open-market, targets a different
    ///         token, or targets a serial not matched by the bid.
    error ArbitrageTradeInvalid();

    /// @notice The spread between the bid and trade is insufficient — the
    ///         trade price is below the bid's minAcceptablePrice floor,
    ///         the bid is smaller than the trade, or the realized spread
    ///         is less than the caller's minProfit parameter.
    error ArbitrageProfitInsufficient();

    /// @notice The execution call would trigger a wash trade — the
    ///         caller (resolved to beneficial owner) is either the
    ///         bidder or the trade seller, OR the bidder and trade
    ///         seller are the same beneficial owner.
    /// @dev    Renamed from `SelfArbitrageBlocked` in the Phase 1
    ///         beneficial-owner unification — the gate now covers
    ///         `executeAgainstBid` (seller-initiated) as well as
    ///         `executeArbitrage`, and resolves both sides via
    ///         `_resolveBeneficialOwner` so cross-vector self-trade
    ///         (Alice via EOA matching Alice via stash) is blocked
    ///         identically to direct self-trade.
    error SelfTradeBlocked();

    /// @notice The bid registry snapshot for `bidId` drifted between
    ///         the pre-call and post-call checks — likely a
    ///         cross-contract reentrancy attempt during execution.
    error RegistryDriftDetected();

    /// @notice An invalid basis-points value was supplied (> MAX_BPS).
    error InvalidBps();

    /// @notice The requested timelock operation has no pending change.
    error NoPendingBpsChange();

    /// @notice The timelock delay has not yet elapsed for the pending change.
    error TimelockNotElapsed();

    /// @notice Nothing to claim / withdraw.
    error NothingToClaim();

    /// @notice A paginated view call was supplied with a `limit`
    ///         greater than `MAX_VIEW_PAGINATION`.
    error PaginationLimitTooLarge();

    /// @notice A bid state transition was attempted from the wrong
    ///         source status (e.g., trying to execute an already-
    ///         cancelled bid).
    error BidNotActive();

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

    /**
     * @notice Get a page of deployed stash addresses.
     * @dev Bounded by MAX_VIEW_PAGINATION to prevent view OOG.
     *      `getAllStashes()` is retained for small collections but
     *      callers should prefer this for production use.
     * @param offset Starting index.
     * @param limit Max results; in (0, 200].
     * @return Array of stash addresses.
     */
    function getStashesPaginated(
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory) {
        if (limit == 0 || limit > MAX_VIEW_PAGINATION) {
            revert PaginationLimitTooLarge();
        }
        if (offset >= allStashes.length) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > allStashes.length) {
            end = allStashes.length;
        }
        uint256 resultLength = end - offset;
        address[] memory result = new address[](resultLength);
        for (uint256 i = 0; i < resultLength; ) {
            result[i] = allStashes[offset + i];
            unchecked {
                ++i;
            }
        }
        return result;
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
        stashOwnerOf[stash] = user;
        isValidStash[stash] = true;
        allStashes.push(stash);

        emit StashDeployed(user, stash, msg.sender);
    }

    // ============================================
    // Bid Management Functions
    // ============================================

    /**
     * @notice Create a bid (called by a user's stash).
     * @dev The stash constructs the BidDetails struct and passes it
     *      here. This function validates the caller is a factory-
     *      deployed stash, sanity-checks the parameters, assigns an
     *      Active status, and populates the lookup indexes used for
     *      O(1) removal later.
     * @param bidDetails Bid details struct (status field is set here,
     *                   not by the caller).
     * @return bidId Unique bid identifier.
     */
    function createBid(
        BidDetails memory bidDetails,
        IAgentEnvelope.AgentAuth calldata auth
    ) external nonReentrant returns (bytes32 bidId) {
        // Validate caller is a factory-deployed stash
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

        // Agent envelope check (when auth populated). Composes the
        // EIP-712 struct hash here so the heavy keccak machinery stays
        // off the stash bytecode; calls back `spendForAgent` on the
        // stash (which performs signature recovery + budget decrement
        // against the stash's own storage).
        if (auth.signature.length != 0) {
            BidderContract(payable(msg.sender)).spendForAgent(
                auth,
                IAgentEnvelope.ActionType.BidCreate,
                keccak256(abi.encode(
                    TYPEHASH_BID_CREATE,
                    auth.agentKey,
                    auth.stash,
                    auth.nonce,
                    auth.deadline,
                    bidDetails.token,
                    keccak256(abi.encodePacked(bidDetails.serials)),
                    bidDetails.hbarAmount,
                    bidDetails.lazyAmount,
                    bidDetails.expiry,
                    bidDetails.minAcceptablePrice,
                    auth.reasoningTopicId
                )),
                uint96(bidDetails.hbarAmount),
                uint96(bidDetails.lazyAmount)
            );
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

        // Populate the fields the factory owns (createdAt + initial status).
        // The caller-provided `status` is intentionally overwritten — only
        // the factory can mint a bid into Active state.
        bidDetails.createdAt = block.timestamp;
        bidDetails.status = BidStatus.Active;
        bidRegistry[bidId] = bidDetails;

        // Add to discovery arrays and record each bid's index for
        // O(1) swap-pop removal later.
        _tokenBidIndex[bidId] = tokenToBids[bidDetails.token].length;
        tokenToBids[bidDetails.token].push(bidId);

        _userBidIndex[bidId] = userToBids[bidDetails.user].length;
        userToBids[bidDetails.user].push(bidId);

        // Increment counter
        totalBidCount++;

        emit BidCreated(
            bidId,
            bidDetails.user,
            bidDetails.token,
            bidDetails,
            bytes32(uint256(uint160(auth.agentKey))),
            auth.reasoningTopicId
        );
    }

    /**
     * @notice Cancel a bid.
     * @dev Removes the bid from the discovery indexes via O(1) swap-pop
     *      and hard-deletes the registry entry. A `BidCancelled` event
     *      preserves the post-mortem record — reading `bidRegistry[bidId]`
     *      after cancellation returns a zeroed struct.
     * @param bidId Bid identifier to cancel.
     */
    function cancelBid(
        bytes32 bidId,
        IAgentEnvelope.AgentAuth calldata auth
    ) external nonReentrant {
        BidDetails storage bid = bidRegistry[bidId];

        if (bid.status == BidStatus.None) {
            revert BidNotFound();
        }
        if (bid.status != BidStatus.Active) {
            revert BidNotActive();
        }

        // Only bid owner or their stash can cancel.
        if (msg.sender != bid.user && msg.sender != bid.stash) {
            revert UnauthorizedCaller();
        }

        // Agent envelope check (when auth populated). Budget = 0/0:
        // cancellation doesn't commit new spend.
        if (auth.signature.length != 0) {
            BidderContract(payable(bid.stash)).spendForAgent(
                auth,
                IAgentEnvelope.ActionType.BidCancel,
                keccak256(abi.encode(
                    TYPEHASH_BID_CANCEL,
                    auth.agentKey,
                    auth.stash,
                    auth.nonce,
                    auth.deadline,
                    bidId,
                    auth.reasoningTopicId
                )),
                0,
                0
            );
        }

        // Save before _closeBid hard-deletes the storage struct
        address bidUser = bid.user;
        address bidToken = bid.token;
        _closeBid(bidId);
        emit BidCancelled(
            bidId,
            bidUser,
            bidToken,
            bytes32(uint256(uint160(auth.agentKey))),
            auth.reasoningTopicId
        );
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
     * @notice Get a page of active bids for a specific token.
     * @dev Enforces `limit <= MAX_VIEW_PAGINATION` to prevent
     *      unbounded view calls that could hit the eth_call gas ceiling
     *      on popular collections. For truly global scans, callers must
     *      page through multiple calls.
     * @param token Token address to query.
     * @param offset Starting index into `tokenToBids[token]`.
     * @param limit Maximum number of results; must be in (0, 200].
     * @return Array of bid IDs (may be shorter than `limit` near the end).
     */
    function getBidsForTokenPaginated(
        address token,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory) {
        if (limit == 0 || limit > MAX_VIEW_PAGINATION) {
            revert PaginationLimitTooLarge();
        }
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
     * @notice Get a page of bids for a specific (token, serial)
     *         combination.
     * @dev Paginated rewrite of the previous unbounded O(n²) version.
     *      Scans `tokenToBids[token]` starting at `offset`, testing
     *      each candidate with `_bidMatchesSerial`, and collects up to
     *      `limit` matches. Returns the matches plus `nextOffset` so
     *      callers can resume paging after the window.
     * @param token Token address.
     * @param serial Serial number to match against bid filters.
     * @param offset Starting index into `tokenToBids[token]`.
     * @param limit Maximum number of matches to return; in (0, 200].
     * @return matches Array of matching bid IDs (up to `limit`).
     * @return nextOffset Index into `tokenToBids[token]` after the last
     *                    scanned element. Pass this as the `offset` of
     *                    the next call to continue paging; a value
     *                    equal to `tokenToBids[token].length` means the
     *                    scan is exhausted.
     */
    function getBidsForTokenSerialPaginated(
        address token,
        uint256 serial,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory matches, uint256 nextOffset) {
        if (limit == 0 || limit > MAX_VIEW_PAGINATION) {
            revert PaginationLimitTooLarge();
        }
        bytes32[] memory tokenBids = tokenToBids[token];
        if (offset >= tokenBids.length) {
            return (new bytes32[](0), tokenBids.length);
        }

        bytes32[] memory buffer = new bytes32[](limit);
        uint256 found = 0;
        uint256 i = offset;
        while (i < tokenBids.length && found < limit) {
            if (_bidMatchesSerial(tokenBids[i], serial)) {
                buffer[found] = tokenBids[i];
                unchecked {
                    ++found;
                }
            }
            unchecked {
                ++i;
            }
        }

        // Trim to the actual number of matches found
        matches = new bytes32[](found);
        for (uint256 j = 0; j < found; ) {
            matches[j] = buffer[j];
            unchecked {
                ++j;
            }
        }
        nextOffset = i;
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
     * @notice Find the highest HBAR bid for a token (best bid / floor price).
     * @dev Iterates `tokenToBids[token]` up to `MAX_VIEW_PAGINATION`
     *      entries. For collections with more active bids, the caller
     *      should page via `getBidsForTokenPaginated` and compute the
     *      best bid off-chain.
     * @param token NFT collection address.
     * @return bestBidId The bid ID with the highest hbarAmount (or 0x0 if none).
     * @return bestHbar The highest HBAR amount (or 0).
     */
    function getBestBidForToken(
        address token
    ) external view returns (bytes32 bestBidId, uint256 bestHbar) {
        bytes32[] memory allBids = tokenToBids[token];
        uint256 scanLimit = allBids.length > MAX_VIEW_PAGINATION
            ? MAX_VIEW_PAGINATION
            : allBids.length;

        for (uint256 i = 0; i < scanLimit; ) {
            BidDetails memory bid = bidRegistry[allBids[i]];
            if (bid.hbarAmount > bestHbar) {
                bestHbar = bid.hbarAmount;
                bestBidId = allBids[i];
            }
            unchecked {
                ++i;
            }
        }
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
     * @notice Check whether a bid is currently valid and, if not, why.
     * @dev Returns a `(bool, BidValidityCode)` pair instead of the
     *      previous `(bool, string)` shape. The enum is stable,
     *      programmatically comparable, and drops all string heap
     *      allocations from view calls — meaningful bytecode savings.
     * @param bidId Bid identifier.
     * @return valid True iff the bid is Active, unexpired, and backed
     *               by sufficient stash funds.
     * @return code  Structured reason code — see BidValidityCode.
     */
    function isBidValid(
        bytes32 bidId
    ) public view returns (bool valid, BidValidityCode code) {
        BidDetails memory bid = bidRegistry[bidId];

        // Never existed
        if (bid.status == BidStatus.None) {
            return (false, BidValidityCode.NotFound);
        }

        // Was closed (cancelled / executed / expired)
        if (bid.status != BidStatus.Active) {
            return (false, BidValidityCode.NotActive);
        }

        // Active but past expiry
        if (bid.expiry != 0 && block.timestamp > bid.expiry) {
            return (false, BidValidityCode.Expired);
        }

        // Stash must hold enough HBAR
        if (bid.hbarAmount > 0 && bid.stash.balance < bid.hbarAmount) {
            return (false, BidValidityCode.InsufficientHbar);
        }

        // Stash must hold enough $LAZY
        if (
            bid.lazyAmount > 0 &&
            IERC20(LAZY_TOKEN).balanceOf(bid.stash) < bid.lazyAmount
        ) {
            return (false, BidValidityCode.InsufficientLazy);
        }

        return (true, BidValidityCode.Valid);
    }

    /**
     * @notice Validate multiple bids in one call.
     * @param bidIds Array of bid IDs.
     * @return validBids Parallel bool array.
     * @return codes Parallel reason-code array.
     */
    function validateBids(
        bytes32[] memory bidIds
    )
        external
        view
        returns (bool[] memory validBids, BidValidityCode[] memory codes)
    {
        uint256 n = bidIds.length;
        validBids = new bool[](n);
        codes = new BidValidityCode[](n);

        for (uint256 i = 0; i < n; ) {
            (validBids[i], codes[i]) = isBidValid(bidIds[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Aggregated snapshot of a user's stash state for wallets,
     *         MCP agents, and indexers.
     * @dev One view call returns everything a front-end needs to
     *      render a "your stash" dashboard: the deterministic stash
     *      address, its HBAR and $LAZY balances, and the user's
     *      active bid IDs (which can then be looked up via
     *      `bidRegistry`). Replaces 5+ scattered RPC calls with one.
     *
     *      If the stash has not been deployed yet, `stash` returns
     *      the predicted CREATE2 address (from `getStashAddress`),
     *      balances are 0, and `activeBidIds` is empty.
     * @param user Owner address to query.
     * @return stash The stash address (deployed or predicted).
     * @return deployed True if the stash clone has been deployed.
     * @return hbarBalance Current HBAR balance of the stash (0 if
     *                      not deployed).
     * @return lazyBalance Current $LAZY balance of the stash (0 if
     *                      not deployed).
     * @return activeBidIds Snapshot of the user's active bid IDs,
     *                      capped at MAX_VIEW_PAGINATION. If the
     *                      user has more, caller should page via
     *                      the `userToBids` array getter directly.
     */
    function getStashSnapshot(
        address user
    )
        external
        view
        returns (
            address stash,
            bool deployed,
            uint256 hbarBalance,
            uint256 lazyBalance,
            bytes32[] memory activeBidIds
        )
    {
        address stored = userToStash[user];
        deployed = stored != address(0);
        stash = deployed ? stored : getStashAddress(user);

        if (deployed) {
            hbarBalance = stash.balance;
            lazyBalance = IERC20(LAZY_TOKEN).balanceOf(stash);
        }

        bytes32[] storage userArr = userToBids[user];
        uint256 n = userArr.length;
        if (n > MAX_VIEW_PAGINATION) {
            n = MAX_VIEW_PAGINATION;
        }
        activeBidIds = new bytes32[](n);
        for (uint256 i = 0; i < n; ) {
            activeBidIds[i] = userArr[i];
            unchecked {
                ++i;
            }
        }
    }

    // ============================================
    // Internal Helper Functions
    // ============================================

    /**
     * @notice Resolve an address to its beneficial owner — if it's a
     *         registered stash, return the human owner; otherwise
     *         return the address unchanged.
     * @dev    BCF-internal version of LST's `_resolveBeneficialOwner`.
     *         Reads `stashOwnerOf` directly (no cross-contract call)
     *         so the cost is one SLOAD. Used to gate self-trade /
     *         self-arbitrage attempts across the EOA-vs-stash boundary.
     * @param addr Address to resolve.
     * @return The beneficial owner, or `addr` if not a registered stash.
     */
    function _resolveBeneficialOwner(
        address addr
    ) internal view returns (address) {
        address owner = stashOwnerOf[addr];
        return owner != address(0) ? owner : addr;
    }

    /**
     * @notice Shared validation for bid execution paths. Checks that the
     *         bid exists, is Active, has not expired, and that the stash
     *         holds sufficient HBAR. Expired bids are swept (hard-deleted
     *         + event emitted) before reverting.
     * @param bidId Bid identifier.
     * @return bid Memory copy of the BidDetails (safe to use after
     *             _closeBid since it's a memory copy, not a storage ref).
     */
    function _validateBidForExecution(
        bytes32 bidId
    ) internal returns (BidDetails memory bid) {
        bid = bidRegistry[bidId];

        // Must exist and be Active
        if (bid.status == BidStatus.None) revert BidNotFound();
        if (bid.status != BidStatus.Active) revert BidNotActive();

        // Expired? — sweep and revert
        if (bid.expiry != 0 && block.timestamp > bid.expiry) {
            emit BidExpired(
                bidId,
                bid.user,
                bid.token,
                bytes32(0), // agentKey reserved
                bytes32(0)  // agentReasoningTopicId reserved
            );
            _closeBid(bidId);
            revert BidHasExpired();
        }

        // Stash must hold enough HBAR for the bid
        if (bid.hbarAmount > 0 && bid.stash.balance < bid.hbarAmount) {
            revert InsufficientFunds();
        }
    }

    /**
     * @notice Close a bid: remove from discovery arrays and hard-delete
     *         the registry entry.
     * @dev Events carry the terminal state (BidCancelled / BidExecuted /
     *      BidExpired) — on-chain storage is for live state only. Callers
     *      MUST save any needed fields into local/memory variables before
     *      calling this, because the storage struct is zeroed.
     * @param bidId Bid identifier.
     */
    function _closeBid(bytes32 bidId) internal {
        BidDetails storage bid = bidRegistry[bidId];

        // Swap-pop removal from tokenToBids (O(1))
        _swapPopIndexed(tokenToBids[bid.token], _tokenBidIndex, bidId);
        // Swap-pop removal from userToBids (O(1))
        _swapPopIndexed(userToBids[bid.user], _userBidIndex, bidId);

        // Hard-delete the struct — reclaims all storage slots including
        // the dynamic serials array. Event logs are the history layer.
        delete bidRegistry[bidId];
    }

    /**
     * @notice O(1) swap-pop remove of `bidId` from a bytes32 array,
     *         keeping the companion index mapping in sync.
     * @dev When the removed element is not the last element, the last
     *      element is moved into its slot AND its own index entry is
     *      rewritten to reflect the new position. Failing to rewrite
     *      that index would corrupt future removals of the moved bid.
     * @param array Storage array reference.
     * @param indexOf Mapping from bidId to its position in `array`.
     * @param bidId The element being removed.
     */
    function _swapPopIndexed(
        bytes32[] storage array,
        mapping(bytes32 => uint256) storage indexOf,
        bytes32 bidId
    ) internal {
        uint256 idx = indexOf[bidId];
        uint256 lastIdx = array.length - 1;
        if (idx != lastIdx) {
            bytes32 moved = array[lastIdx];
            array[idx] = moved;
            indexOf[moved] = idx;
        }
        array.pop();
        delete indexOf[bidId];
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

        for (uint256 i = 0; i < bidIds.length; ) {
            BidDetails storage bid = bidRegistry[bidIds[i]];

            if (
                bid.status == BidStatus.Active &&
                bid.expiry != 0 &&
                block.timestamp > bid.expiry
            ) {
                address bidUser = bid.user;
                address bidToken = bid.token;
                _closeBid(bidIds[i]);
                emit BidExpired(
                    bidIds[i],
                    bidUser,
                    bidToken,
                    bytes32(0), // agentKey reserved
                    bytes32(0)  // agentReasoningTopicId reserved
                );
                unchecked {
                    ++cleanedCount;
                }
            }

            unchecked {
                ++i;
            }
        }

        emit ExpiredBidsCleanup(msg.sender, cleanedCount);
    }

    // ============================================
    // Trade Creation from BidderContract
    // ============================================

    /**
     * @notice Create a trade in LazySecureTrade on behalf of the calling stash.
     * @dev The stash itself (`msg.sender`, validated via `isValidStash`) is
     *      recorded as the LST trade's `seller`. This is the address that
     *      LST will pull the NFT from at execution time — the stash IS the
     *      NFT custodian, so it must be the recorded seller. The human
     *      owner is resolved via `stashOwnerOf[msg.sender]` and emitted in
     *      the event for off-chain indexing.
     *
     *      No `seller` parameter — the function hard-codes `msg.sender`,
     *      so callers cannot spoof seller identity. See Bug 2 in
     *      `docs/BCF-StashAllowances-DESIGN.md`.
     * @param token NFT token address.
     * @param serial NFT serial number.
     * @param buyer Address of the buyer (or address(0) for open market).
     * @param tinybarPrice HBAR price in tinybars.
     * @param lazyPrice $LAZY price.
     * @param expiryTime Expiry timestamp (0 = no expiry).
     * @param auth Optional agent envelope authorization. Empty signature
     *             = owner-initiated; populated = agent path with envelope
     *             verification + budget check (budget = 0/0 since listing
     *             only escrows via approval).
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
    ) external nonReentrant returns (bytes32 tradeId) {
        // Validate caller is a factory-deployed stash
        if (!isValidStash[msg.sender]) {
            revert InvalidStash();
        }

        // Agent envelope check (when auth populated). Budget = 0/0:
        // listing escrows via NFT approval, no new fund commitment.
        if (auth.signature.length != 0) {
            BidderContract(payable(msg.sender)).spendForAgent(
                auth,
                IAgentEnvelope.ActionType.TradeList,
                keccak256(abi.encode(
                    TYPEHASH_CREATE_TRADE,
                    auth.agentKey,
                    auth.stash,
                    auth.nonce,
                    auth.deadline,
                    token,
                    buyer,
                    serial,
                    tinybarPrice,
                    lazyPrice,
                    expiryTime,
                    auth.reasoningTopicId
                )),
                0,
                0
            );
        }

        // The stash (msg.sender) is recorded as both NFT holder AND
        // seller on the LST side. LST pulls the NFT from the stash at
        // execution; the stash receives payment; owner withdraws from
        // the stash via withdrawHbar / withdrawLazy.
        tradeId = LAZY_SECURE_TRADE.createTradeOnBehalf(
            msg.sender,
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
            stashOwnerOf[msg.sender],
            token,
            serial,
            bytes32(uint256(uint160(auth.agentKey))),
            auth.reasoningTopicId
        );
    }

    /**
     * @notice Cancel a stash-listed LST trade from the human owner's EOA.
     * @dev Resolves the trade from LST, verifies (a) the seller is a
     *      registered stash (b) the caller owns that stash, then instructs
     *      the stash to perform the cancellation. The stash atomically
     *      revokes its per-serial NFT approval to LST and calls
     *      `LST.cancelTrade` — see `BidderContract.cancelLstTrade`.
     *
     *      Frontend routing: read `trade.seller`, check `isValidStash`;
     *      route here for stash-listed trades, route directly to
     *      `LST.cancelTrade` for EOA-listed trades. User signs from their
     *      EOA in both cases. See Bug 4 in `docs/BCF-StashAllowances-DESIGN.md`.
     */
    function cancelTradeFromStash(
        bytes32 tradeId,
        IAgentEnvelope.AgentAuth calldata auth
    ) external nonReentrant {
        ILazySecureTrade.Trade memory trade = LAZY_SECURE_TRADE.getTrade(
            tradeId
        );
        if (trade.seller == address(0)) revert TradeNotFoundOrInvalid();
        if (!isValidStash[trade.seller]) revert NotStashListed();

        // Agent dispatch — both legacy and agent paths resolve to a
        // beneficial owner that must match the stash's owner. Envelope
        // budget consumed = 0/0 (cancellation doesn't commit new spend).
        (address effectiveCaller, address agentKeyForEvent, bytes32 reasoningTopic)
            = _resolveAgentOrOwner(
                auth,
                IAgentEnvelope.ActionType.TradeCancel,
                _cancelTradeStructHash(auth, tradeId),
                0,
                0
            );
        if (effectiveCaller != stashOwnerOf[trade.seller])
            revert UnauthorizedCaller();
        // Defensive: on the agent path, auth.stash must match the trade's
        // seller stash. Without this an agent for stashA could try to
        // cancel a trade owned by stashA — caught above by the owner
        // mismatch — but if stashA and stashB share an owner (impossible
        // by design but cheap to enforce), this closes the door.
        if (auth.signature.length != 0 && auth.stash != trade.seller) {
            revert UnauthorizedCaller();
        }

        // Instruct the stash to cancel. The stash re-derives (token, serial)
        // from LST itself — no spoofable params forwarded. The stash
        // revokes its per-serial NFT approval to LST and then calls
        // LST.cancelTrade, which passes because the stash IS trade.seller.
        BidderContract(payable(trade.seller)).cancelLstTrade(tradeId);

        emit TradeCancelledFromStash(
            tradeId,
            trade.seller,
            effectiveCaller,
            bytes32(uint256(uint160(agentKeyForEvent))),
            reasoningTopic
        );
    }

    /// @dev keccak256("CancelTrade(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 tradeId,bytes32 reasoningTopicId)")
    bytes32 internal constant TYPEHASH_CANCEL_TRADE = keccak256(
        "CancelTrade(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 tradeId,bytes32 reasoningTopicId)"
    );

    function _cancelTradeStructHash(
        IAgentEnvelope.AgentAuth calldata auth,
        bytes32 tradeId
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH_CANCEL_TRADE,
                auth.agentKey,
                auth.stash,
                auth.nonce,
                auth.deadline,
                tradeId,
                auth.reasoningTopicId
            )
        );
    }

    // ============================================
    // Trade Execution Functions
    // ============================================

    /**
     * @notice Execute against a bid (seller-initiated). The caller is
     *         the NFT seller; the bidder's stash buys at the bid price.
     * @param bidId Bid identifier
     * @param nftToken NFT token address
     * @param serial Serial number
     * @param auth Optional agent envelope authorization. Empty auth =
     *             legacy EOA path; populated auth = agent acting on
     *             behalf of the stash owner at `auth.stash`. Profit is
     *             not generated on this path (the executor sells their
     *             own NFT), but agent attribution still threads through
     *             events + envelope nonce/permission.
     * @return tradeId Created trade ID
     */
    function executeAgainstBid(
        bytes32 bidId,
        address nftToken,
        uint256 serial,
        IAgentEnvelope.AgentAuth calldata auth
    ) external nonReentrant returns (bytes32 tradeId) {
        // Shared validation: exists, Active, not expired, stash funded
        BidDetails memory bid = _validateBidForExecution(bidId);

        // Serial + token match (specific to seller-initiated flow)
        if (!_bidMatchesSerial(bidId, serial)) {
            revert InvalidBidDetails();
        }
        if (bid.token != nftToken) {
            revert InvalidBidDetails();
        }

        // Agent dispatch — envelope budget = 0/0 (no new commitment;
        // the seller's NFT is the value flowing, not new stash funds).
        (address effectiveCaller, address agentKeyForEvent, bytes32 reasoningTopic)
            = _resolveAgentOrOwner(
                auth,
                IAgentEnvelope.ActionType.TradeExecute,
                _executeAgainstBidStructHash(auth, bidId, nftToken, serial),
                0,
                0
            );

        // Self-trade gate: caller (resolved) must not match the
        // bidder's beneficial owner. Wash-trade closed.
        if (effectiveCaller == _resolveBeneficialOwner(bid.user)) {
            revert SelfTradeBlocked();
        }

        // Honor the bidder's price floor. The bid amount IS the trade
        // price on this path (no spread), so `minAcceptablePrice` is
        // satisfied only when `hbarAmount >= minAcceptablePrice` —
        // which `createBid` already enforces. Re-check defensively so
        // a future relaxation of `createBid` validation can't slip a
        // sub-floor bid through this entry point. See Bug 5 / Phase 1.
        if (bid.hbarAmount < bid.minAcceptablePrice) {
            revert ArbitrageProfitInsufficient();
        }

        // Create trade in LazySecureTrade on behalf of the seller. On
        // the agent path the actual NFT custodian is `effectiveCaller`'s
        // stash (the agent's user); on the legacy path it's `msg.sender`.
        // LST pulls the NFT from the seller address via the per-serial
        // approval the seller granted when listing.
        tradeId = LAZY_SECURE_TRADE.createTradeOnBehalf(
            agentKeyForEvent == address(0) ? msg.sender : effectiveCaller,
            nftToken,
            bid.stash,
            serial,
            bid.hbarAmount,
            bid.lazyAmount,
            0
        );

        // Execute trade via BidderContract
        BidderContract(payable(bid.stash)).executeTrade(
            tradeId,
            bid.hbarAmount,
            bid.lazyAmount
        );

        // Transition the bid to Executed: remove from discovery indexes
        // via O(1) swap-pop AND hard-delete the registry entry. The bid
        // is captured in `bid` (memory) above, so we can still read its
        // fields for the event payload after deletion.
        _closeBid(bidId);

        // Emit execution event with full metadata for cold-start indexers.
        emit BidExecuted(
            bidId,
            effectiveCaller,
            tradeId,
            0,
            bid.user,
            bid.token,
            bid.hbarAmount,
            bid.lazyAmount,
            bytes32(uint256(uint160(agentKeyForEvent))),
            reasoningTopic
        );
    }

    /// @dev keccak256("ExecuteAgainstBid(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 bidId,address nftToken,uint256 serial,bytes32 reasoningTopicId)")
    bytes32 internal constant TYPEHASH_EXECUTE_AGAINST_BID = keccak256(
        "ExecuteAgainstBid(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 bidId,address nftToken,uint256 serial,bytes32 reasoningTopicId)"
    );

    function _executeAgainstBidStructHash(
        IAgentEnvelope.AgentAuth calldata auth,
        bytes32 bidId,
        address nftToken,
        uint256 serial
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH_EXECUTE_AGAINST_BID,
                auth.agentKey,
                auth.stash,
                auth.nonce,
                auth.deadline,
                bidId,
                nftToken,
                serial,
                auth.reasoningTopicId
            )
        );
    }

    // ============================================
    // Arbitrage
    // ============================================

    /**
     * @notice Execute an arbitrage against an existing LST trade.
     * @dev Finds a mispriced trade (ask) sitting below a live bid,
     *      routes the purchase through the bidder's stash at the trade
     *      price, and captures the spread as arbitrage profit split
     *      between the caller and the protocol.
     *
     *      Economic model: the bidder's stash spends the full
     *      bid.hbarAmount (matching the user's budget), but only
     *      trade.tinybarPrice flows to the seller via LST. The
     *      remainder (spread = bid.hbarAmount - trade.tinybarPrice) is
     *      pulled from the stash via `arbitrageSettle` and split by
     *      `arbitragePayoutBps` — arbCut to the arbitrageur, rest to
     *      the protocol treasury. The stash still ends up with the NFT,
     *      so the bidder gets what they wanted; the economic rent from
     *      the bid/ask mismatch goes to the arbitrageur and protocol,
     *      not back to the bidder.
     *
     *      Self-arbitrage is blocked at three points: caller cannot be
     *      the bidder, caller cannot be the seller, and bidder cannot
     *      equal seller. This closes the wash-trading loophole where a
     *      single actor would otherwise extract value from their own
     *      bid against their own ask.
     *
     *      Hedera has no MEV (consensus timestamp ordering), so no
     *      commit-reveal or sandwich-defense mechanics are needed.
     *
     *      A pre/post registry snapshot of `bidRegistry[bidId]` is
     *      used to detect cross-contract reentrancy — if the bid
     *      entry changes during execution, the tx reverts with
     *      `RegistryDriftDetected`.
     *
     * @param bidId The bid to arbitrage against.
     * @param existingTradeId An open-market LST trade whose price is
     *                        at or below the bid's effective price.
     * @param minProfit Minimum acceptable HBAR spread for the caller.
     *                  Reverts cheaply with `ArbitrageProfitInsufficient`
     *                  if the realized spread is below this threshold.
     * @param auth Optional agent envelope authorization. Pass an empty
     *                  AgentAuth (zero fields, empty signature) for the
     *                  legacy EOA path — msg.sender is then the actor and
     *                  profit credits to msg.sender's beneficial owner.
     *                  Populated AgentAuth routes profit to the stash
     *                  owner of `auth.stash` and consumes envelope state.
     * @return spread The HBAR spread captured, pre-split.
     */
    function executeArbitrage(
        bytes32 bidId,
        bytes32 existingTradeId,
        uint256 minProfit,
        IAgentEnvelope.AgentAuth calldata auth
    ) external nonReentrant returns (uint256 spread) {
        // Shared validation: exists, Active, not expired, stash funded
        BidDetails memory bid = _validateBidForExecution(bidId);

        // Fetch the trade from LST
        ILazySecureTrade.Trade memory trade = LAZY_SECURE_TRADE.getTrade(
            existingTradeId
        );

        // Trade must exist, be open-market, target the same token, and
        // match the bid's serial filter
        if (
            trade.seller == address(0) ||
            trade.buyer != address(0) ||
            trade.token != bid.token ||
            !_bidMatchesSerial(bidId, trade.serial)
        ) {
            revert ArbitrageTradeInvalid();
        }

        // Agent dispatch. effectiveCaller is msg.sender's beneficial
        // owner on the legacy path, or the stash owner on the agent path.
        // Envelope budget consumed: 0/0 — arbitrage doesn't commit new
        // spend; it routes already-committed bid funds. The envelope
        // still enforces signature, nonce, permission, expiry, paused.
        (address effectiveCaller, address agentKeyForEvent, bytes32 reasoningTopic)
            = _resolveAgentOrOwner(
                auth,
                IAgentEnvelope.ActionType.Arbitrage,
                _arbitrageStructHash(auth, bidId, existingTradeId, minProfit),
                0,
                0
            );

        // Self-arb / wash-trade guard. Resolve both other legs to their
        // beneficial owners so the EOA-vs-stash boundary doesn't open
        // a backdoor (e.g., Alice bids via her stash, lists via her
        // EOA, then "arbs" via a second EOA she controls — but the
        // chain only sees three distinct addresses for the same human).
        // `effectiveCaller` is already at the beneficial-owner layer.
        address bidOwner = _resolveBeneficialOwner(bid.user);
        address sellerOwner = _resolveBeneficialOwner(trade.seller);
        if (
            effectiveCaller == bidOwner ||
            effectiveCaller == sellerOwner ||
            bidOwner == sellerOwner
        ) {
            revert SelfTradeBlocked();
        }

        // Bid must fully cover the trade price AND respect the bidder's
        // price floor. Consolidated into a single error since all three
        // cases are "the spread isn't profitable enough to arbitrage".
        if (
            bid.hbarAmount < trade.tinybarPrice ||
            trade.tinybarPrice < bid.minAcceptablePrice ||
            bid.lazyAmount < trade.lazyPrice
        ) {
            revert ArbitrageProfitInsufficient();
        }

        spread = bid.hbarAmount - trade.tinybarPrice;
        if (spread < minProfit) revert ArbitrageProfitInsufficient();

        // Stash must actually hold the full bid amount
        if (bid.stash.balance < bid.hbarAmount) revert InsufficientFunds();

        // Snapshot the registry entry for post-call drift detection.
        // Any cross-function reentrancy that mutates this bid's entry
        // will cause the post-call compare to fail.
        bytes32 preSnapshot = keccak256(abi.encode(bidRegistry[bidId]));

        // Step 1: route the trade execution through the stash at the
        // TRADE price (not the bid price). The stash becomes the buyer
        // of the existing trade. LST pays the seller, NFT ends up in
        // the stash.
        BidderContract(payable(bid.stash)).executeTrade(
            existingTradeId,
            trade.tinybarPrice,
            trade.lazyPrice
        );

        // Step 2: pull the HBAR spread from the stash into the factory.
        // This is the scoped replacement for the removed
        // `factoryWithdrawHbar` — bounded to the computed spread for a
        // specific (bid, trade) pair, event-logged on both sides.
        BidderContract(payable(bid.stash)).arbitrageSettle(
            bidId,
            existingTradeId,
            spread,
            0 // LAZY spread not captured — LAZY trades are fee-free
        );

        // Post-call drift check. If the registry entry for this bid
        // changed during execution (a cross-contract reentrancy attempt
        // that somehow modified state), revert.
        if (keccak256(abi.encode(bidRegistry[bidId])) != preSnapshot) {
            revert RegistryDriftDetected();
        }

        // Split the spread between the arbitrageur and the protocol.
        uint256 arbCut = (spread * arbitragePayoutBps) / MAX_BPS;
        uint256 protocolCut = spread - arbCut;

        // Profit credits to the beneficial owner (`effectiveCaller`) so
        // the agent operator never custodies user funds on the agent
        // path. On the legacy path this resolves identically to
        // `_resolveBeneficialOwner(msg.sender)`.
        pendingArbProfit[effectiveCaller] += arbCut;
        pendingProtocolProfit += protocolCut;

        // Transition to Executed and remove from discovery indexes.
        _closeBid(bidId);

        emit ArbitrageExecuted(
            bidId,
            existingTradeId,
            effectiveCaller,
            arbCut,
            protocolCut,
            bid.user,
            bid.token,
            bid.hbarAmount,
            bid.lazyAmount,
            bytes32(uint256(uint160(agentKeyForEvent))),
            reasoningTopic
        );
    }

    /**
     * @notice Claim accrued arbitrage profit as the arbitrageur.
     * @dev Separated from `executeArbitrage` so the payout transfer
     *      happens in a distinct transaction — eliminates any
     *      reentrancy pressure on the execution path. Uses a
     *      checks-effects-interactions pattern within the claim itself.
     */
    function claimArbProfit() external nonReentrant {
        uint256 amount = pendingArbProfit[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingArbProfit[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TradeExecutionFailed();

        emit ArbProfitClaimed(msg.sender, amount);
    }

    /**
     * @notice Withdraw accumulated protocol profit to an arbitrary
     *         address.
     * @dev `onlyOwner`. The factory owner is expected to be a
     *      multisig + timelock at the operational layer — this is
     *      the payout endpoint for that setup.
     * @param to Destination address for the HBAR transfer.
     * @param amount Amount to withdraw, must be <= pendingProtocolProfit.
     */
    function withdrawProtocolProfit(
        address payable to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0 || amount > pendingProtocolProfit) {
            revert NothingToClaim();
        }
        pendingProtocolProfit -= amount;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TradeExecutionFailed();

        emit ProtocolProfitWithdrawn(to, amount);
    }

    /**
     * @notice Propose a change to the arbitrage payout basis points.
     * @dev Enters a 48-hour timelock before the change can be applied
     *      via `executeArbPayoutBpsChange`. Replaces any previously
     *      pending change.
     * @param newBps New payout bps (0-10000 = 0%-100%).
     */
    function setArbitragePayoutBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_BPS) revert InvalidBps();
        pendingArbPayoutBps = newBps;
        arbPayoutBpsChangeEta = block.timestamp + ARB_PAYOUT_TIMELOCK;
        emit ArbPayoutBpsChangePending(newBps, arbPayoutBpsChangeEta);
    }

    /**
     * @notice Apply a pending arbitrage payout bps change once the
     *         timelock has elapsed.
     * @dev Permissionless once the ETA is reached — anyone can apply
     *      the change. This avoids requiring the owner to be live at
     *      the exact ETA.
     */
    function executeArbPayoutBpsChange() external {
        if (arbPayoutBpsChangeEta == 0) revert NoPendingBpsChange();
        if (block.timestamp < arbPayoutBpsChangeEta) {
            revert TimelockNotElapsed();
        }
        uint256 newBps = pendingArbPayoutBps;
        arbitragePayoutBps = newBps;
        pendingArbPayoutBps = 0;
        arbPayoutBpsChangeEta = 0;
        emit ArbPayoutBpsChanged(newBps);
    }

    // ============================================
    // Agent envelope tier table (consumed by stashes)
    // ============================================
    //
    // Per-VIP-tier upper bounds on per-envelope budget caps + max envelope
    // count per user. Read by `BidderContract.createEnvelope` and
    // `BidderContract.updateEnvelopeCaps`. Owner-tunable with a 48h
    // timelock per tier (mirroring `setArbitragePayoutBps`). The first
    // configuration of any given tier is INSTANT; subsequent changes for
    // that same tier are timelocked. Operators can therefore wire all
    // five tiers in one deploy without staging four days of timelock.
    //
    // Default state (storage zero): every tier returns a zero-filled
    // limits struct, which the stash treats as "envelopes disabled."
    // Operators must explicitly call `setAgentTierLimits(tier, ...)` for
    // every tier they want enabled before users can create envelopes.

    /// @notice Per-tier envelope caps. Returned from `getAgentTierLimits`.
    mapping(IVIPSubscription.Tier => IAgentEnvelope.TierLimits) internal _agentTierLimits;

    /// @notice Tracks whether a tier has ever been configured. The first
    ///         `setAgentTierLimits` call for a given tier is instant; all
    ///         subsequent changes queue a 48h timelock.
    mapping(IVIPSubscription.Tier => bool) public agentTierConfigured;

    /// @notice Pending tier-limits change keyed by tier. Zero `eta`
    ///         means "no pending change for this tier."
    mapping(IVIPSubscription.Tier => uint64) public pendingAgentTierEta;
    mapping(IVIPSubscription.Tier => IAgentEnvelope.TierLimits) public pendingAgentTierLimits;

    /// @notice Timelock delay for agent-tier-limits changes.
    uint256 internal constant AGENT_TIER_TIMELOCK = 48 hours;

    event AgentTierLimitsSet(IVIPSubscription.Tier indexed tier, IAgentEnvelope.TierLimits limits);
    event AgentTierLimitsChangePending(
        IVIPSubscription.Tier indexed tier,
        IAgentEnvelope.TierLimits limits,
        uint64 eta
    );
    event AgentTierLimitsChangeCancelled(IVIPSubscription.Tier indexed tier);

    error NoPendingTierChange();

    // ============================================
    // EIP-712 action TYPEHASHes
    // ============================================
    //
    // One typehash per agent-authorizable action. The struct hash is
    // composed inline at each call site; the library binds the EIP-712
    // domain (chainId + stash address) when called via spendForAgent on
    // the stash. Field order must match the corresponding `_*StructHash`
    // composer below.

    /// @dev keccak256("BidCreate(address agentKey,address stash,uint64 nonce,uint64 deadline,address token,uint256[] serials,uint256 hbarAmount,uint256 lazyAmount,uint256 expiry,uint256 minAcceptablePrice,bytes32 reasoningTopicId)")
    bytes32 internal constant TYPEHASH_BID_CREATE = keccak256(
        "BidCreate(address agentKey,address stash,uint64 nonce,uint64 deadline,address token,uint256[] serials,uint256 hbarAmount,uint256 lazyAmount,uint256 expiry,uint256 minAcceptablePrice,bytes32 reasoningTopicId)"
    );

    /// @dev keccak256("BidCancel(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 bidId,bytes32 reasoningTopicId)")
    bytes32 internal constant TYPEHASH_BID_CANCEL = keccak256(
        "BidCancel(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 bidId,bytes32 reasoningTopicId)"
    );

    /// @dev keccak256("CreateTrade(address agentKey,address stash,uint64 nonce,uint64 deadline,address token,address buyer,uint256 serial,uint256 tinybarPrice,uint256 lazyPrice,uint256 expiryTime,bytes32 reasoningTopicId)")
    bytes32 internal constant TYPEHASH_CREATE_TRADE = keccak256(
        "CreateTrade(address agentKey,address stash,uint64 nonce,uint64 deadline,address token,address buyer,uint256 serial,uint256 tinybarPrice,uint256 lazyPrice,uint256 expiryTime,bytes32 reasoningTopicId)"
    );

    /// @dev keccak256("Arbitrage(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 bidId,bytes32 tradeId,uint256 minProfit,bytes32 reasoningTopicId)")
    bytes32 internal constant TYPEHASH_ARBITRAGE = keccak256(
        "Arbitrage(address agentKey,address stash,uint64 nonce,uint64 deadline,bytes32 bidId,bytes32 tradeId,uint256 minProfit,bytes32 reasoningTopicId)"
    );

    function _arbitrageStructHash(
        IAgentEnvelope.AgentAuth calldata auth,
        bytes32 bidId,
        bytes32 tradeId,
        uint256 minProfit
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH_ARBITRAGE,
                auth.agentKey,
                auth.stash,
                auth.nonce,
                auth.deadline,
                bidId,
                tradeId,
                minProfit,
                auth.reasoningTopicId
            )
        );
    }

    /**
     * @dev Single dispatch helper for the AgentAuth-bearing entry points.
     *      `auth.signature.length == 0` is the legacy/owner path — no
     *      envelope state touched, msg.sender is the actor. Otherwise
     *      the agent EOA is calling; we verify msg.sender matches the
     *      claimed agentKey, dispatch to the named stash's spendForAgent
     *      choke point (which verifies the signature + decrements
     *      budget), and resolve the beneficial owner from the stash.
     *
     *      Returns the triple (effective caller, agent key for events,
     *      reasoning topic for events) so the caller can route profit
     *      credits + emit consistent attribution without re-reading state.
     *
     *      Budget amounts here are the SPEND consequences for THIS
     *      action — for arbitrage, the spend was already committed at
     *      bid-creation time, so we pass (0, 0) and the envelope only
     *      enforces signature + nonce + permission. Bid-creation paths
     *      pass the real (hbar, lazy) commitment.
     */
    function _resolveAgentOrOwner(
        IAgentEnvelope.AgentAuth calldata auth,
        IAgentEnvelope.ActionType action,
        bytes32 structHash,
        uint96 hbarAmount,
        uint96 lazyAmount
    ) internal returns (address effectiveCaller, address agentKey, bytes32 topic) {
        if (auth.signature.length == 0) {
            // Legacy / owner path. Beneficial-owner resolution handles
            // the EOA-vs-stash distinction for self-trade gates.
            return (_resolveBeneficialOwner(msg.sender), address(0), bytes32(0));
        }
        if (msg.sender != auth.agentKey) {
            revert IAgentEnvelope.EnvelopeAuthFailed(
                auth.agentKey, IAgentEnvelope.AuthFailCode.BadSignature
            );
        }
        if (!isValidStash[auth.stash]) {
            revert IAgentEnvelope.EnvelopeAuthFailed(
                auth.agentKey, IAgentEnvelope.AuthFailCode.NotFound
            );
        }
        BidderContract(payable(auth.stash)).spendForAgent(
            auth, action, structHash, hbarAmount, lazyAmount
        );
        effectiveCaller = stashOwnerOf[auth.stash];
        if (effectiveCaller == address(0)) effectiveCaller = auth.stash;
        agentKey = auth.agentKey;
        topic = auth.reasoningTopicId;
    }

    /**
     * @notice View consumed by stashes inside `createEnvelope`.
     * @dev    Returns the currently-applied limits for the supplied
     *         tier. A pending (queued, not-yet-executed) change does
     *         NOT take effect via this view until
     *         `executeAgentTierLimitsChange` runs.
     */
    function getAgentTierLimits(IVIPSubscription.Tier tier)
        external view override returns (IAgentEnvelope.TierLimits memory)
    {
        return _agentTierLimits[tier];
    }

    /**
     * @notice Propose tier-limits for a given tier. First call ever for
     *         a tier applies instantly; subsequent calls queue a 48h
     *         timelock and overwrite any previously pending change for
     *         the same tier.
     * @dev    Owner-only. The owner is expected to be a multisig + timelock
     *         at the operational layer; the 48h on-chain timelock is the
     *         user-facing notice window for envelope holders to react if
     *         caps tighten.
     */
    function setAgentTierLimits(
        IVIPSubscription.Tier tier,
        IAgentEnvelope.TierLimits calldata limits
    ) external onlyOwner {
        if (!agentTierConfigured[tier]) {
            _agentTierLimits[tier] = limits;
            agentTierConfigured[tier] = true;
            emit AgentTierLimitsSet(tier, limits);
        } else {
            uint64 eta = uint64(block.timestamp + AGENT_TIER_TIMELOCK);
            pendingAgentTierLimits[tier] = limits;
            pendingAgentTierEta[tier] = eta;
            emit AgentTierLimitsChangePending(tier, limits, eta);
        }
    }

    /**
     * @notice Apply a queued tier-limits change once the 48h timelock has
     *         elapsed. Permissionless so the owner does not have to be
     *         live at the exact ETA.
     */
    function executeAgentTierLimitsChange(IVIPSubscription.Tier tier) external {
        uint64 eta = pendingAgentTierEta[tier];
        if (eta == 0) revert NoPendingTierChange();
        if (block.timestamp < eta) revert TimelockNotElapsed();
        IAgentEnvelope.TierLimits memory limits = pendingAgentTierLimits[tier];
        _agentTierLimits[tier] = limits;
        delete pendingAgentTierLimits[tier];
        pendingAgentTierEta[tier] = 0;
        emit AgentTierLimitsSet(tier, limits);
    }

    /**
     * @notice Abandon a queued tier-limits change before it executes.
     */
    function cancelAgentTierLimitsChange(IVIPSubscription.Tier tier) external onlyOwner {
        if (pendingAgentTierEta[tier] == 0) revert NoPendingTierChange();
        delete pendingAgentTierLimits[tier];
        pendingAgentTierEta[tier] = 0;
        emit AgentTierLimitsChangeCancelled(tier);
    }

    // ============================================
    // HBAR receive — required for arbitrageSettle
    // ============================================

    /// @notice Accept HBAR transfers from registered stashes (arbitrage
    ///         settlement) and to top up protocol HBAR if ever needed.
    /// @dev `arbitrageSettle` on the stash side pulls the spread into
    ///      the factory via `payable(factory).call{value: ...}("")` —
    ///      that requires `receive()` here or the transfer reverts
    ///      `TransferFailed` and arbitrage is broken end-to-end.
    ///
    ///      Stranger HBAR sends are accepted into the factory balance
    ///      but cannot be retrieved beyond `pendingProtocolProfit` (which
    ///      only increments via the explicit arbitrage path). Effectively
    ///      donations — not exploitable, just stuck. Acceptable trade-off
    ///      vs. the complexity of restricting `receive()` to stashes.
    receive() external payable {}
}
