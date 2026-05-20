// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TokenStakerV2} from "./TokenStakerV2.sol";
import {HederaResponseCodes} from "./HederaResponseCodes.sol";
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

    /// @notice Reserved storage slots for forward compatibility.
    /// @dev    BidderContract is deployed as deterministic CREATE2 clones
    ///         from a single immutable implementation. Stash address is
    ///         a function of (factory, impl, user) — changing the impl
    ///         address invalidates every predicted stash address in the
    ///         ecosystem, which is unacceptable. So new storage fields
    ///         cannot be added to a deployed impl; they must come from
    ///         this reserved gap.
    ///
    ///         To add a new field: (1) declare it IMMEDIATELY BEFORE the
    ///         `__gap` line below, AND (2) decrement the gap length by
    ///         the number of slots the new field consumes (1 for a value
    ///         type / mapping pointer; longer for static arrays). The
    ///         new field thus occupies the slot the gap used to start
    ///         from, preserving every existing slot index. Never reorder
    ///         existing fields, never delete from the gap, and never
    ///         insert above an existing field — only the slot range
    ///         currently inside `__gap` is safe to consume.
    ///
    ///         Sized at 20 slots — enough for agent envelope mappings
    ///         (planned in docs/AGENT-MARKETPLACE-DELTA.md) plus a
    ///         comfortable headroom for VIPSubscription / EnglishAuction
    ///         integration without a redeploy.
    uint256[20] private __gap;

    /// @notice Maximum percentage of stash HBAR balance that can be
    ///         pulled by the factory in a single `arbitrageSettle`
    ///         call, expressed in basis points (10_000 = 100%).
    ///         Defense-in-depth: even if the factory has a bug and
    ///         computes an incorrect settlement amount, this cap
    ///         limits the per-tx blast radius. Hardcoded so no admin
    ///         key can weaken it.
    uint256 public constant ARB_SETTLE_MAX_BPS = 7500; // 75%

    /// @notice Lazy-refill ceiling for the stash → LST HBAR allowance
    ///         that covers the custody-hop tinybar on `executeTrade`.
    ///         Re-granted automatically inside `executeTrade` when the
    ///         current allowance drops below `CUSTODY_HOP_ALLOWANCE_FLOOR`.
    ///         Bounded (not max(int256)) so a compromised LST drains
    ///         at most this much before the owner can intervene.
    ///         10 HBAR ≈ 10 billion custody hops — effectively "set
    ///         once per stash, ever" in practice.
    uint256 public constant CUSTODY_HOP_ALLOWANCE_REFILL = 1_000_000_000; // 10 HBAR

    /// @notice Allowance refill is triggered when current allowance
    ///         drops below this floor. 1 HBAR gives ample headroom
    ///         (1 billion custody hops at 1 tinybar each) so refills
    ///         are rare in steady state.
    uint256 public constant CUSTODY_HOP_ALLOWANCE_FLOOR = 100_000_000; // 1 HBAR

    /// @notice Minimum HBAR balance the stash keeps when its owner
    ///         calls `withdrawHbar`. Ensures the stash has enough HBAR
    ///         to pay the 1-tinybar custody hops on future trade
    ///         executions. Numerically equal to
    ///         `CUSTODY_HOP_ALLOWANCE_FLOOR` (1 HBAR) but conceptually
    ///         distinct — the floor here is on the *balance*, not on
    ///         the *allowance to LST*. Owner can override this floor
    ///         via `rescueHbar` (drains the stash completely; future
    ///         trades will fail until refunded).
    uint256 public constant WITHDRAW_MIN_BALANCE_FLOOR = 100_000_000; // 1 HBAR

    /// @notice Basis-points denominator (100% = 10_000 bp).
    ///         Co-located with `ARB_SETTLE_MAX_BPS` so the BPS math
    ///         in `arbitrageSettle` reads in named units instead of
    ///         the bare `/ 10_000` literal.
    uint256 internal constant MAX_BPS = 10_000;

    /// @notice Hedera Account Service system contract address (HIP-906).
    ///         Symmetric with the HTS precompile at 0x167. The HASC
    ///         exposes `hbarApprove(owner, spender, amount)` and
    ///         `hbarAllowance(owner, spender)` callable from any
    ///         contract with the owner identity passed explicitly.
    address internal constant HEDERA_ACCOUNT_SERVICE = address(0x16a);

    /// @notice Synthetic `HbarAllowanceFailed` code for "low-level
    ///         call to HASC returned ok=false." Distinct from real
    ///         Hedera response codes (which are positive). Carried
    ///         in the error so ops can disambiguate from the
    ///         "precompile responded but with a non-success code"
    ///         path. Range-safe against HederaResponseCodes (positive).
    int64 internal constant HBAR_APPROVE_CALL_FAILED = -1;

    /// @notice Synthetic `HbarAllowanceFailed` code for "HASC call
    ///         succeeded but returned empty or short data."
    ///         Indicates either the precompile is not at 0x16a on
    ///         this network OR the calldata shape has drifted from
    ///         the HIP-906 spec.
    int64 internal constant HBAR_APPROVE_MALFORMED_RETURN = -2;

    // ============================================
    // Events
    // ============================================

    // Note: bid lifecycle events are emitted only by the router (the
    // BidderContractFactory). Users monitor the factory + their stash
    // address directly via mirror node. The events declared here are
    // for sovereignty actions that originate at the stash itself and
    // have no factory-side equivalent.

    /// @notice Emitted when a stash owner permanently severs the factory
    ///         link via `detachFromFactory()`. The stash remains fully
    ///         controlled by the owner but can no longer participate in
    ///         bidding via the factory.
    event FactoryDetached(
        address indexed owner,
        address indexed formerFactory
    );

    /// @notice Emitted when the factory pulls funds from this stash as
    ///         arbitrage settlement. Off-chain consumers can subscribe
    ///         to this event on a specific stash's deterministic
    ///         address to track arbitrage events affecting that user.
    ///         Dual-context with `BidderContractFactory.ArbitrageExecuted`.
    event StashArbSettled(
        bytes32 indexed bidId,
        bytes32 indexed tradeId,
        uint256 hbarAmount,
        uint256 lazyAmount
    );

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
    /// @notice Thrown when detachFromFactory is called on a stash whose
    ///         factory link has already been severed.
    error AlreadyDetached();
    /// @notice HIP-906 hbarApprove system contract call did not return
    ///         SUCCESS. Code 0 means the call itself failed (system
    ///         contract missing or returned malformed data); any other
    ///         value is the HederaResponseCode the system contract
    ///         surfaced.
    error HbarAllowanceFailed(int64 responseCode);
    /// @notice The trade looked up on LST does not exist (seller == 0).
    ///         Mirrors LST's own error for the cancel path so callers
    ///         see a uniform shape.
    error TradeNotFoundOrInvalid();

    /// @notice The trade resolved from `LST.getTrade(tradeId)` has a
    ///         seller other than this stash. Closes the spoof vector
    ///         where a compromised factory could pass a foreign
    ///         `tradeId` to revoke this stash's approval for an
    ///         unrelated serial. See `cancelLstTrade`.
    error NotMyTrade();

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
     * @dev Keeps `WITHDRAW_MIN_BALANCE_FLOOR` (1 HBAR) in the stash so
     *      future trade executions have enough HBAR for the custody-hop
     *      tinybars. To override, use `rescueHbar` (sovereignty escape).
     */
    function withdrawHbar(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();

        uint256 contractBalance = address(this).balance;

        if (contractBalance < amount + WITHDRAW_MIN_BALANCE_FLOOR)
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
     * @notice Scoped settlement path for arbitrage — called by the
     *         factory during `executeArbitrage` to pull the spread
     *         out of this stash.
     * @dev Replaces the removed `factoryWithdrawHbar` / `factoryWithdrawLazy`
     *      blanket-drain paths. The factory is only allowed to pull
     *      funds from this stash in the context of a specific
     *      (bidId, tradeId) arbitrage settlement, with bounded amounts
     *      computed by `executeArbitrage` from the verified spread.
     *      The stash cannot verify the factory's computation without
     *      querying the bid + trade itself (which would add subcalls
     *      and is redundant with the factory's own verification), so
     *      the trust model is: the factory is trusted to compute
     *      correct settlement amounts, and both sides emit events so
     *      any discrepancy is publicly auditable.
     *
     *      Emitting from the stash side (not just the factory) is an
     *      intentional design choice — with deterministic CREATE2
     *      stash addresses, off-chain consumers can subscribe to
     *      `StashArbSettled` on a specific user's stash address to
     *      track arbitrage events affecting that user.
     * @param bidId The bid being settled.
     * @param tradeId The LST trade being arbitraged against.
     * @param hbarAmount HBAR to transfer to the factory.
     * @param lazyAmount $LAZY to transfer to the factory (currently always 0
     *                   because LAZY trades are fee-free, but the parameter
     *                   exists for forward compatibility).
     */
    function arbitrageSettle(
        bytes32 bidId,
        bytes32 tradeId,
        uint256 hbarAmount,
        uint256 lazyAmount
    ) external onlyFactory nonReentrant {
        if (hbarAmount > 0) {
            // Defense-in-depth: reject if the factory tries to pull
            // more than 75% of the stash's current HBAR balance in a
            // single call. A legitimate arbitrage of a 100 HBAR bid
            // against a 50 HBAR trade produces a 50 HBAR spread — at
            // most ~50% of the pre-trade balance. The 75% cap gives
            // headroom for edge cases while limiting blast radius.
            uint256 cap = (address(this).balance * ARB_SETTLE_MAX_BPS) / MAX_BPS;
            if (hbarAmount > cap) revert InsufficientBalance();
            (bool ok, ) = payable(factory).call{value: hbarAmount}("");
            if (!ok) revert TransferFailed();
        }

        if (lazyAmount > 0) {
            // Same BPS cap as HBAR — prevents full LAZY drain in a single
            // call if the factory ever routes LAZY through arbitrage.
            uint256 lazyCap = (IERC20(lazyToken).balanceOf(address(this)) * ARB_SETTLE_MAX_BPS) / MAX_BPS;
            if (lazyAmount > lazyCap) revert InsufficientBalance();
            bool ok = IERC20(lazyToken).transfer(factory, lazyAmount);
            if (!ok) revert TransferFailed();
        }

        emit StashArbSettled(bidId, tradeId, hbarAmount, lazyAmount);
    }

    // ============================================
    // Allowance Management (HBAR + NFT)
    // ============================================
    //
    // Stash custody flows in v0.3 require allowances in three directions:
    //
    //   (1) Stash → LST (HBAR) — covers the 1-tinybar custody hop on
    //       executeTrade when this stash is the buyer. Set lazily inside
    //       executeTrade via `_ensureHbarAllowanceForCustodyHop`.
    //   (2) Stash → LST (NFT, per-serial) — granted at listing time so
    //       LST can pull the listed NFT at execution. Revoked atomically
    //       on cancel.
    //   (3) EOA → stash (HBAR) — symmetric to (1) but on the reverse
    //       direction (stash sending NFT to EOA). Set by the EOA via the
    //       Hedera SDK; not exposed here.
    //
    // The HBAR allowances rely on HIP-906's `hbarApprove` / `hbarAllowance`
    // system contract intercept at the contract's own address.
    //
    // See docs/BCF-StashAllowances-DESIGN.md for the full rationale,
    // security analysis, and rejected alternatives.

    /**
     * @notice Set this stash's HBAR allowance to `spender` to `amount`.
     * @dev Owner-only. Pass `amount = 0` to revoke. Owner is sovereign —
     *      no on-chain cap on `amount`. Frontend must validate user input;
     *      a max-allowance mistake is recoverable via a subsequent
     *      `approveHbarTo(spender, 0)` call.
     * @param spender Address authorized to spend.
     * @param amount Tinybar allowance amount (use 0 to revoke).
     */
    function approveHbarTo(
        address spender,
        int256 amount
    ) external onlyOwner {
        if (spender == address(0)) revert InvalidAddress();
        _hbarApprove(spender, amount);
    }

    /**
     * @notice Read this stash's current HBAR allowance to `spender`.
     * @dev View call to the HIP-906 system contract. Returns 0 on any
     *      failure (call reverted, system contract missing, malformed
     *      return) — safer than reverting in a view path that the lazy
     *      refill check depends on.
     */
    function hbarAllowanceTo(
        address spender
    ) external view returns (int256) {
        return _hbarAllowanceTo(spender);
    }

    /**
     * @notice Set a per-serial NFT approval from this stash to `spender`.
     * @dev `public` (not `external`) so `createTrade` can call it as an
     *      internal jump without paying for a self-external call.
     *      Owner-only — when invoked from inside `createTrade`, the
     *      modifier passes because msg.sender carries through internal
     *      calls.
     *
     *      Per-serial granularity is deliberate. We do NOT expose
     *      `setApprovalForAll` because:
     *        - Per-serial approvals are auto-consumed on transfer, so
     *          the blast radius on a healthy stash is "currently listed
     *          serials" not "every serial of that collection."
     *        - Per-serial grants are revocable individually — required
     *          for the atomic revoke-on-cancel path in `cancelLstTrade`.
     *      See docs/BCF-StashAllowances-DESIGN.md §Security #1.
     *
     *      To revoke, pass `spender = address(0)` (ERC-721 / HIP-336 idiom).
     *
     *      Routed through the IERC721 facade at the token's own address
     *      rather than the HTS precompile at 0x167 — Hedera testnet's
     *      precompile path reverts with no data when a contract is the
     *      NFT owner (empirically confirmed in P5.8-probe), while the
     *      ERC-721 facade works for both EOA and contract owners.
     */
    function approveNFTTo(
        address token,
        address spender,
        uint256 serial
    ) public onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        IERC721(token).approve(spender, serial);
    }

    /**
     * @dev Lazy-refill the stash → LST HBAR allowance if it has dropped
     *      below the floor. Called from `executeTrade` so steady-state
     *      execution doesn't require the owner to think about allowances.
     *      Spender is the immutable LST address — cannot be steered by
     *      any caller. See attack surface table in design doc.
     */
    function _ensureHbarAllowanceForCustodyHop(address spender) internal {
        int256 current = _hbarAllowanceTo(spender);
        if (current >= int256(CUSTODY_HOP_ALLOWANCE_FLOOR)) return;
        _hbarApprove(spender, int256(CUSTODY_HOP_ALLOWANCE_REFILL));
    }

    /**
     * @dev HIP-906 `hbarApprove` invocation via the Hedera Account
     *      Service system contract at 0x16a. Symmetric with the HTS
     *      pattern used by `HederaTokenService.approveNFT` against
     *      0x167. The HASC signature takes the OWNER explicitly:
     *      `hbarApprove(address owner, address spender, int256 amount)`.
     *      Response is encoded as int32 (promoted to int64 in our
     *      error type for forward compatibility).
     *
     *      Reverts `HbarAllowanceFailed` on:
     *        - low-level call failure (system contract missing on this
     *          Hedera version)
     *        - malformed return (length < 32 bytes)
     *        - response code != SUCCESS
     *
     *      Safe under `nonReentrant` because the system contract is not
     *      user code and does not reenter.
     */
    function _hbarApprove(address spender, int256 amount) internal {
        (bool ok, bytes memory ret) = HEDERA_ACCOUNT_SERVICE.call(
            abi.encodeWithSignature(
                "hbarApprove(address,address,int256)",
                address(this),
                spender,
                amount
            )
        );
        // Disambiguate three failure modes for ops:
        //   HBAR_APPROVE_CALL_FAILED       (-1) — call returned ok=false
        //   HBAR_APPROVE_MALFORMED_RETURN  (-2) — empty/short ret data
        //   rc (positive)                       — HederaResponseCode
        if (!ok) revert HbarAllowanceFailed(HBAR_APPROVE_CALL_FAILED);
        if (ret.length < 32)
            revert HbarAllowanceFailed(HBAR_APPROVE_MALFORMED_RETURN);
        int32 rc = abi.decode(ret, (int32));
        if (rc != HederaResponseCodes.SUCCESS)
            revert HbarAllowanceFailed(int64(rc));
    }

    /**
     * @dev View-side of HIP-906 via 0x16a. Returns 0 on any failure so
     *      the caller (the lazy refill check) treats the unknown state
     *      as "no allowance" and re-grants — safer than reverting in a
     *      view function on the hot path.
     */
    function _hbarAllowanceTo(
        address spender
    ) internal view returns (int256) {
        (bool ok, bytes memory ret) = HEDERA_ACCOUNT_SERVICE.staticcall(
            abi.encodeWithSignature(
                "hbarAllowance(address,address)",
                address(this),
                spender
            )
        );
        if (!ok || ret.length < 64) return 0;
        (int32 rc, int256 amount) = abi.decode(ret, (int32, int256));
        return rc == HederaResponseCodes.SUCCESS ? amount : int256(0);
    }

    // ============================================
    // Sovereignty / Emergency Escape Hatches
    // ============================================

    /**
     * @notice Emergency HBAR rescue to any address.
     * @dev Unconditional escape hatch — bypasses `withdrawHbar`'s
     *      keep-1-HBAR minimum balance guard and allows sending to an
     *      arbitrary destination, not just `owner`. No HTS interaction,
     *      no royalty machinery, no dependency on TokenStakerV2 — just a
     *      raw native value call. The only prerequisite is that `to` is a
     *      valid Hedera account (i.e. exists on the network).
     *
     *      Use when:
     *      - The normal `withdrawHbar` path is revert-blocked for any
     *        reason (bug, validation, exhausted 1-HBAR floor)
     *      - The user wants to migrate HBAR to a new stash or a fresh
     *        address without going via `owner`
     *      - The factory has been detached or is otherwise inert and
     *        the user needs to drain the stash
     * @param to Destination address (must already exist on Hedera)
     * @param amount Amount to rescue in tinybars
     */
    function rescueHbar(
        address payable to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (address(this).balance < amount) revert InsufficientBalance();

        (bool success, ) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /**
     * @notice Emergency $LAZY rescue to any address.
     * @dev Unconditional escape hatch — raw ERC-20 transfer with no
     *      royalty machinery (LAZY is a fungible HTS token with no
     *      royalty). Equivalent in reliability to `rescueHbar`.
     *      Allows sending to an arbitrary destination, not just `owner`.
     * @param to Destination address (must be associated with $LAZY)
     * @param amount Amount to rescue
     */
    function rescueLazy(
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        bool success = IERC20(lazyToken).transfer(to, amount);
        if (!success) revert TransferFailed();
    }

    /**
     * @notice Emergency single-NFT rescue via direct moveNFTs call.
     * @dev Calls `TokenStakerV2.moveNFTs` directly, skipping the outer
     *      `withdrawNFTs` argument-array validation and the
     *      `batchMoveNFTs` batching loop. The rescue target is the full
     *      TokenStakerV2 capability — including the 2-step custody-hop
     *      pattern required to move royalty-bearing NFTs on Hedera.
     *
     *      `moveNFTs` is well-tested infrastructure used across the
     *      LazySuperheroes ecosystem (staking, swaps, all royalty NFT
     *      movements). The rescue function exists to provide a fallback
     *      if a bug is ever found in the OUTER wrapping code — NOT
     *      because the base transfer is a risk surface we consider
     *      fragile.
     *
     *      Caveat: if `moveNFTs` itself is somehow broken (e.g., a
     *      future breaking Hedera HIP changes the royalty engine's
     *      interaction with the 1-tinybar custody hop), royalty-bearing
     *      NFTs cannot be rescued via this function. In that scenario
     *      the only escape is off-chain (contacting the NFT collection
     *      admin, if one exists). See SECURITY.md for the full framing.
     * @param token NFT token address
     * @param serial NFT serial number
     * @param to Destination address (must be associated with `token`)
     * @param hbarValue Tinybar value to declare to the royalty engine.
     *                  For standard collections this should be
     *                  CUSTODY_HOP_TINYBAR (1). Set higher only if the
     *                  target collection has a fixed-fee royalty that
     *                  requires a larger consideration.
     */
    function rescueNFT(
        address token,
        uint256 serial,
        address to,
        int64 hbarValue
    ) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert InvalidAddress();

        uint256[] memory serials = new uint256[](1);
        serials[0] = serial;

        moveNFTs(
            TransferDirection.WITHDRAWAL,
            token,
            serials,
            to,
            false, // no delegation
            hbarValue
        );
    }

    /**
     * @notice Permanently sever this stash's relationship with its
     *         factory.
     * @dev After calling this function:
     *      - `factory` is set to address(0)
     *      - `onlyFactory` functions revert permanently (including any
     *        future factory-initiated trade execution or arbitrage
     *        settlement)
     *      - `createBid` / `cancelBid` / `createTrade` fail because the
     *        stash can no longer reach the factory
     *      - `withdrawHbar`, `withdrawLazy`, `withdrawNFTs`,
     *        `rescueHbar`, `rescueLazy`, `rescueNFT` continue to work
     *        normally — the stash becomes a pure vault under the owner's
     *        control
     *
     *      Use when the factory is being retired (a new factory is
     *      deployed and the user wants the old stash to be inert), or
     *      when the user simply wants to opt out of factory-mediated
     *      flows while keeping custody of their assets.
     *
     *      IRREVERSIBLE. If you detach, you cannot re-attach; you must
     *      deploy a fresh stash under a factory to participate in
     *      bidding again. Note that the new stash will be at a
     *      different address because the CREATE2 salt includes the
     *      factory address.
     */
    function detachFromFactory() external onlyOwner {
        if (factory == address(0)) revert AlreadyDetached();
        address formerFactory = factory;
        factory = address(0);
        emit FactoryDetached(owner, formerFactory);
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
     * @param minAcceptablePrice Minimum tinybar trade price the bid will
     *        match in arbitrage. 0 = accept any price. Set this to guard
     *        against surprise-cheap matches (e.g., a junk NFT listed at
     *        1 tinybar in the same collection).
     * @return bidId Unique bid identifier
     */
    function createBid(
        address token,
        uint256[] memory serials,
        uint256 hbarAmount,
        uint256 lazyAmount,
        uint256 expiry,
        uint256 minAcceptablePrice
    ) external onlyOwner nonReentrant returns (bytes32 bidId) {
        // Validate parameters
        if (token == address(0)) revert InvalidBidParameters();
        if (hbarAmount == 0 && lazyAmount == 0) revert InvalidBidParameters();
        if (expiry != 0 && expiry <= block.timestamp)
            revert InvalidBidParameters();
        // minAcceptablePrice above the bid itself is nonsensical — it
        // would mean the bid can never be arbitraged because the spread
        // would be negative. Reject at creation time rather than letting
        // it create an unreachable bid.
        if (minAcceptablePrice > hbarAmount) revert InvalidBidParameters();

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

        // Create bid details. The factory sets `createdAt` and
        // `status` on its side, so we pass placeholder values here.
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
                createdAt: 0, // factory sets
                minAcceptablePrice: minAcceptablePrice,
                status: IBidderContractFactory.BidStatus.None // factory sets
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
        // Ensure LST has at least CUSTODY_HOP_ALLOWANCE_FLOOR worth of
        // HBAR allowance from this stash. Required for the 1-tinybar
        // custody hop in moveNFTs WITHDRAWAL leg — without it, HTS
        // reverts with SPENDER_DOES_NOT_HAVE_ALLOWANCE (code 292).
        // Hardcoded spender (immutable lazySecureTradeAddress) — no
        // surface for caller manipulation.
        _ensureHbarAllowanceForCustodyHop(lazySecureTradeAddress);

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
     * @notice Create a trade in LazySecureTrade for NFTs held in this stash.
     * @dev Allows users to list NFTs sitting in their stash without first
     *      withdrawing them. The LST trade records THIS STASH (address(this))
     *      as the seller — not the human owner — because the stash is the
     *      actual NFT custodian and is the address LST must pull from at
     *      execution time. Payment from the buyer goes to the stash; the
     *      human owner withdraws via `withdrawHbar` / `withdrawLazy`.
     *
     *      Granting LST a per-serial NFT approval is a hard prerequisite
     *      for trade execution — done atomically here. Revoked atomically
     *      on cancel via `cancelLstTrade`. See docs/BCF-StashAllowances-DESIGN.md.
     * @param token NFT token address.
     * @param buyer Buyer address (or address(0) for open market).
     * @param serial NFT serial number — must be held by this stash.
     * @param tinybarPrice HBAR price in tinybars.
     * @param lazyPrice $LAZY price.
     * @param expiryTime Expiry timestamp (0 = no expiry).
     * @param agentKey Optional agent identifier for envelope tracking +
     *                 event tagging. Pass `bytes32(0)` for owner-initiated.
     * @return tradeId Created trade identifier.
     */
    function createTrade(
        address token,
        address buyer,
        uint256 serial,
        uint256 tinybarPrice,
        uint256 lazyPrice,
        uint256 expiryTime,
        bytes32 agentKey
    ) external onlyOwner nonReentrant returns (bytes32 tradeId) {
        // Grant LST per-serial NFT approval so it can pull this serial at
        // execution. Per-serial (not setApprovalForAll) bounds the blast
        // radius if LST is ever compromised AND lets `cancelLstTrade`
        // revoke atomically. Internal call inherits msg.sender (the owner),
        // so the `onlyOwner` modifier on `approveNFTTo` passes.
        approveNFTTo(token, lazySecureTradeAddress, serial);

        // BCF hard-codes msg.sender (this stash, validated against
        // isValidStash) as the LST trade.seller — no spoofable `seller`
        // param. See docs/BCF-StashAllowances-DESIGN.md Bug 2.
        tradeId = IBidderContractFactory(factory).createTradeOnBehalfOfStash(
            token,
            serial,
            buyer,
            tinybarPrice,
            lazyPrice,
            expiryTime,
            agentKey
        );
    }

    /**
     * @notice Cancel a stash-listed LST trade and atomically revoke the
     *         per-serial NFT approval granted at listing time.
     * @dev Normally invoked via `BCF.cancelTradeFromStash` (which gates
     *      on `stashOwnerOf[stash] == msg.sender` before forwarding here).
     *      Also callable by the owner directly — primary use case is
     *      post-`detachFromFactory` when the BCF orchestrator path is dead.
     *
     *      Takes ONLY `tradeId`. `(token, serial)` are re-derived from
     *      `LST.getTrade(tradeId)` rather than trusted from the caller —
     *      a compromised factory could otherwise pass spoofed params to
     *      revoke approval on an unrelated NFT before LST rejects the
     *      mismatched cancellation. Costs 1 extra view subcall; closes
     *      the spoof vector cleanly. See design doc §Security #1.
     *
     *      Order: explicit `seller == address(this)` guard first, then
     *      LST.cancelTrade, then approval revoke. EVM atomicity makes
     *      this ordering academic (any revert rolls back the whole tx),
     *      but it removes the dependence on LST's seller-check for
     *      correctness — the guard here closes the foreign-tradeId
     *      spoof vector even if LST is ever compromised. Phase 2.
     */
    function cancelLstTrade(
        bytes32 tradeId
    ) external onlyOwnerOrFactory nonReentrant {
        ILazySecureTrade.Trade memory trade = ILazySecureTrade(
            lazySecureTradeAddress
        ).getTrade(tradeId);
        if (trade.seller == address(0)) revert TradeNotFoundOrInvalid();

        // Spoof-vector guard: a compromised factory could otherwise
        // pass a foreign tradeId (where trade.seller is a *different*
        // stash's address) to make this stash revoke approval for a
        // serial it still has listed elsewhere. Reject before doing
        // anything else.
        if (trade.seller != address(this)) revert NotMyTrade();

        // Cancel on LST first. If LST reverts for any other reason
        // (e.g., the trade was executed in a racing tx), the whole
        // tx unwinds before we touch the approval. Defensive ordering
        // — atomicity would unwind anyway, but cancel-first matches
        // the mental model "revoke approval AFTER the listing is
        // gone, not before."
        ILazySecureTrade(lazySecureTradeAddress).cancelTrade(tradeId);

        // Revoke the per-serial approval via the IERC721 facade (HTS
        // precompile reverts for contract owners on testnet — see
        // approveNFTTo). spender = address(0) is the standard ERC-721
        // revocation idiom.
        IERC721(trade.token).approve(address(0), trade.serial);
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
