// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ILazyGasStation} from "./interfaces/ILazyGasStation.sol";
import {IVIPSubscription} from "./interfaces/IVIPSubscription.sol";

/**
 * @title VIPSubscription
 * @notice Paid 4-tier subscription contract for the agent marketplace.
 *         Drives agent framework limits + premium features. NOT used
 *         by trade-fee math (LST + LazyTradeLotto stay tied to
 *         `LSHTierLib` holdings tier).
 *
 *         Two purposes, one contract:
 *           1. Paid tier resolution (Bronze / Silver / Gold / Platinum)
 *              consumed by agent envelopes + frontend.
 *           2. $LAZY sink — every purchase routes payment through
 *              `LazyGasStation.drawLazyFrom` which burns a configurable
 *              percentage and retains the remainder.
 *
 *         Holdings discount comes from a per-(token, tier) admin-tunable
 *         table. Loaner-abuse is mitigated by a 14-day per-serial
 *         cooldown applied at purchase. Annual-prepay discount is
 *         pro-rated and capped against a combined-discount ceiling.
 *
 *         See `docs/VIPSubscription-DESIGN.md` for the full design
 *         and `docs/AGENT-MARKETPLACE-DELTA.md` for the architectural
 *         context (split from the original VIPRegistry into this
 *         contract + LSHTierLib).
 */
contract VIPSubscription is IVIPSubscription, Ownable, ReentrancyGuard {

    // ============================================
    // Structs
    // ============================================

    /// @notice Per-(token, tier) discount configuration.
    /// @param discountBps 0–10_000 basis points off the base price.
    /// @param allowedSerials Optional allowlist. Empty array = all
    ///         serials of `token` qualify; non-empty = only the listed
    ///         serials qualify (e.g. legendary-trait promotional sets).
    struct DiscountConfig {
        uint16 discountBps;
        uint256[] allowedSerials;
    }

    /// @notice User-provided proof of holdings at purchase time.
    /// @param token The LSH token contract being claimed for discount.
    /// @param serial The specific serial nominated.
    struct DiscountProof {
        address token;
        uint256 serial;
    }

    // ============================================
    // Storage
    // ============================================

    /// @notice Subscription state per user.
    mapping(address => Subscription) public subscriptions;

    /// @notice Discount table — per (LSH token, paid tier) the bps
    ///         discount + optional allowlist.
    mapping(address => mapping(Tier => DiscountConfig)) public discountTable;

    /// @notice Per-(token, serial) cooldown timestamp. A serial is
    ///         "locked" while `lockedSerials[token][serial] >
    ///         block.timestamp`. Locks are global to the serial (next
    ///         owner inherits the remaining cooldown).
    mapping(address => mapping(uint256 => uint64)) public lockedSerials;

    /// @notice Monthly price per paid tier, in LAZY base units.
    mapping(Tier => uint256) public monthlyPriceLazy;

    /// @notice Annual prepay discount in bps, pro-rated by months
    ///         purchased: `durationBps = annualPrepayDiscountBps *
    ///         months / 12`.
    uint16 public annualPrepayDiscountBps;

    /// @notice Hard cap on combined (holdings + duration) discount in
    ///         bps. Prevents the prepay ramp from compounding the
    ///         holdings discount past a floor price.
    uint16 public maxCombinedDiscountBps;

    /// @notice Percentage of paid $LAZY to burn at purchase. Passed
    ///         through to LGS.drawLazyFrom — semantic matches LGS's
    ///         own convention (which the rest of the system uses).
    uint256 public burnPercentage;

    /// @notice Per-serial cooldown duration in seconds. Default 14
    ///         days (1_209_600). Bounded recommendation: ≥7 days,
    ///         ≤90 days.
    uint32 public cooldownSeconds;

    /// @notice Cap on cumulative active subscription duration for
    ///         user-initiated purchases. Admin extensions are NOT
    ///         capped by this value.
    uint8 public maxActiveDurationMonths;

    // ============================================
    // 3-sink revenue split (rebate + team + treasury)
    // ============================================

    /// @notice Basis points of subscription revenue routed to the
    ///         LSH staker rebate pool. Capped at MAX_REBATE_BPS.
    ///         Default 0 (inert) until the rebate pool is wired up;
    ///         flipping to non-zero after deploy enables the rebate
    ///         flow.
    uint16 public rebateBps;

    /// @notice Basis points of subscription revenue routed to the
    ///         team operations wallet. Capped at MAX_TEAM_BPS.
    ///         Funds team operations, LP support, audits, etc.
    uint16 public teamBps;

    /// @notice Address of the `LazyRebatePool` that receives the
    ///         rebate slice. Owner-settable; `address(0)` disables
    ///         the rebate path regardless of `rebateBps`.
    address public rebatePool;

    /// @notice Multisig / team operations wallet that receives the
    ///         team slice. Owner-settable; `address(0)` disables the
    ///         team path regardless of `teamBps`.
    address public teamWallet;

    // ============================================
    // x402 convenience-rail grant
    // ============================================

    /// @notice Limited-privilege backend wallet allowed to grant
    ///         subscriptions WITHOUT $LAZY (the x402 convenience rail —
    ///         payment is settled off-chain in HBAR/USDC, then the tier
    ///         is granted on-chain so `getTierFor`/`subscriptionOf`
    ///         stay the single source of truth). Can ONLY call
    ///         `grantSubscription` — no owner powers, no fund access.
    ///         A leaked key can mint VIP time (capped at
    ///         MAX_GRANT_MONTHS per grant, replay-guarded per `ref`)
    ///         but cannot drain funds. Owner-settable; `address(0)`
    ///         disables the system-grant path entirely.
    address public systemWallet;

    /// @notice Replay / idempotency guard for system grants. The off-
    ///         chain payment reference (`ref`, e.g.
    ///         `keccak256(x402 payment tx id)`) is consumed on first
    ///         use; a second grant with the same `ref` reverts —
    ///         belt-and-braces against a backend retry double-submit.
    mapping(bytes32 => bool) public consumedRefs;

    // ============================================
    // Immutables
    // ============================================

    /// @notice LAZY token (HTS) — payment medium.
    address public immutable LAZY_TOKEN;

    /// @notice LazyGasStation — the draw/burn/retain pipeline for the
    ///         payment. Must already have this contract authorized as
    ///         a contract user (admin op outside this contract).
    address public immutable LAZY_GAS_STATION;

    /// @notice One month in seconds. Match LST's implicit convention.
    uint64 internal constant MONTH_SECONDS = 30 days;

    /// @notice Basis points denominator (100% = 10_000 bp).
    uint16 internal constant MAX_BPS = 10_000;

    // Owner-action caps — security finding C5 from the agent envelope
    // review. Bound the blast radius of an owner-key compromise even if
    // the operational multisig + timelock layer fails. See ops runbook
    // §7 for residual risk.

    /// @notice Maximum months grantable in a single `extendSubscription`
    ///         call. Caps any one admin grant at a year of subscription.
    uint16 internal constant MAX_GRANT_MONTHS = 12;

    /// @notice Floor on per-tier monthly price (LAZY base units).
    ///         Prevents a compromised admin from setting tier pricing
    ///         to zero. The token-decimals-agnostic floor of 1 base
    ///         unit blocks the literal-zero attack; operational
    ///         multisig + timelock at the owner layer is the primary
    ///         guard against the "set to 1 base unit ≈ free" attack
    ///         (which on 8-decimal LAZY would still be effectively
    ///         free; the on-chain floor cannot generalize across
    ///         arbitrary token decimals).
    uint256 internal constant MIN_MONTHLY_PRICE = 1;

    /// @notice Hard upper bound on `maxCombinedDiscountBps`. Stops a
    ///         compromised admin from enabling a 100%-off path.
    uint16 internal constant MAX_ALLOWED_COMBINED_DISCOUNT_BPS = 5_000;

    /// @notice Hard upper bound on `rebateBps`. Caps the rebate slice
    ///         at 50% of subscription revenue.
    uint16 internal constant MAX_REBATE_BPS = 5_000;

    /// @notice Hard upper bound on `teamBps`. Caps the team slice at
    ///         50% of subscription revenue.
    uint16 internal constant MAX_TEAM_BPS = 5_000;

    // ============================================
    // Events
    // ============================================

    /// @notice Emitted on every successful subscription purchase or
    ///         extension. `effectiveDiscountBps` is the final combined
    ///         discount applied after the maxCombined cap.
    event SubscriptionPurchased(
        address indexed user,
        Tier indexed tier,
        uint16 monthsAdded,
        uint64 newExpiresAt,
        uint256 lazyPaid,
        uint16 effectiveDiscountBps
    );

    /// @notice Emitted on owner-granted extension (no $LAZY consumed).
    event SubscriptionExtendedByAdmin(
        address indexed user,
        uint16 monthsAdded,
        uint64 newExpiresAt,
        address indexed grantor
    );

    /// @notice Emitted whenever the discount table changes for a
    ///         (token, tier) pair.
    event DiscountConfigChanged(
        address indexed token,
        Tier indexed tier,
        uint16 discountBps,
        uint256 allowedSerialsCount
    );

    /// @notice Emitted whenever a tier's monthly price is updated.
    event PriceChanged(Tier indexed tier, uint256 newMonthlyLazy);

    /// @notice Emitted when a serial enters cooldown (a purchase
    ///         nominated it for discount).
    event SerialLockedForDiscount(
        address indexed token,
        uint256 indexed serial,
        uint64 lockedUntil
    );

    /// @notice Generic config-changed signal. `key` is one of the
    ///         keccak256 string identifiers below.
    event ConfigChanged(bytes32 indexed key, uint256 value);

    bytes32 internal constant CONFIG_KEY_ANNUAL_PREPAY = keccak256("annualPrepayDiscountBps");
    bytes32 internal constant CONFIG_KEY_MAX_COMBINED = keccak256("maxCombinedDiscountBps");
    bytes32 internal constant CONFIG_KEY_BURN = keccak256("burnPercentage");
    bytes32 internal constant CONFIG_KEY_COOLDOWN = keccak256("cooldownSeconds");
    bytes32 internal constant CONFIG_KEY_MAX_DURATION = keccak256("maxActiveDurationMonths");
    bytes32 internal constant CONFIG_KEY_REBATE_BPS = keccak256("rebateBps");
    bytes32 internal constant CONFIG_KEY_TEAM_BPS = keccak256("teamBps");

    /// @notice Emitted per `purchaseSubscription` with the three split
    ///         amounts in LAZY base units. Indexers use this to track
    ///         the revenue split flows.
    event SubscriptionRevenueSplit(
        address indexed user,
        uint256 finalPrice,
        uint256 burnedAmount,
        uint256 rebateAmount,
        uint256 teamAmount
    );

    /// @notice Emitted when the rebate pool address is updated.
    event RebatePoolChanged(address indexed newPool);

    /// @notice Emitted when the team wallet address is updated.
    event TeamWalletChanged(address indexed newWallet);

    /// @notice Emitted when the system (x402 grant) wallet is updated.
    event SystemWalletChanged(address indexed newWallet);

    /// @notice Emitted on a system/owner tier grant (no $LAZY consumed).
    ///         `ref` correlates to the off-chain payment for
    ///         reconciliation; `grantor` is the caller (owner or
    ///         systemWallet). Because the grant reverts rather than
    ///         downgrades, the granted `tier` is always the tier that
    ///         takes effect.
    event SubscriptionGrantedBySystem(
        address indexed user,
        Tier indexed tier,
        bytes32 indexed ref,
        uint16 monthsAdded,
        uint64 newExpiresAt,
        address grantor
    );

    // ============================================
    // Errors
    // ============================================

    error InvalidTier();
    error ZeroMonths();
    error GrantTooLong(uint16 requested, uint16 cap);
    error PriceBelowFloor(uint256 requested, uint256 floor);
    error CombinedDiscountExceedsCap(uint16 requested, uint16 cap);
    error ZeroAddress();
    error InvalidConfigBps(uint16 bps);
    error WouldExceedMaxDuration(uint16 currentRemaining, uint16 requested, uint8 max);
    error CannotDowngradeActiveSubscription(Tier current, Tier requested);
    error NoQualifyingDiscount(address token);
    error NotSerialOwner(address user, address token, uint256 serial);
    error SerialNotInAllowList(address token, Tier tier, uint256 serial);
    error SerialCooldownActive(address token, uint256 serial, uint64 lockedUntil);
    error RebateBpsExceedsCap(uint16 requested, uint16 cap);
    error TeamBpsExceedsCap(uint16 requested, uint16 cap);
    error NotAuthorizedGrantor(address caller);
    error RefAlreadyConsumed(bytes32 ref);

    // ============================================
    // Constructor
    // ============================================

    /**
     * @param _lazyToken LAZY token contract address.
     * @param _lazyGasStation LazyGasStation contract address. Must
     *         authorize this contract as a contract user post-deploy.
     */
    constructor(address _lazyToken, address _lazyGasStation) {
        if (_lazyToken == address(0) || _lazyGasStation == address(0)) {
            revert ZeroAddress();
        }
        LAZY_TOKEN = _lazyToken;
        LAZY_GAS_STATION = _lazyGasStation;

        // Sensible defaults — owner can tune via setters.
        annualPrepayDiscountBps = 2_000; // 20%
        maxCombinedDiscountBps = 9_000; // 90%
        burnPercentage = 50; // matches LST's convention (LGS interprets)
        cooldownSeconds = 14 days; // 1_209_600
        maxActiveDurationMonths = 12;
        // 3-sink split defaults: 10% rebate, 0% team. The rebate slice
        // is inert until `rebatePool` is set; same for team.
        rebateBps = 1_000;
        teamBps = 0;
        // rebatePool + teamWallet stay address(0) at deploy. Owner
        // sets them post-deploy once the rebate pool contract is up
        // and the team multisig is associated with LAZY.
        // systemWallet stays address(0) — the x402 grant path is
        // disabled until the owner registers the backend wallet.
    }

    // ============================================
    // Modifiers
    // ============================================

    /// @dev Gate for `grantSubscription`: the owner (multisig) or the
    ///      limited x402 backend wallet. `systemWallet == address(0)`
    ///      means only the owner qualifies (system path disabled).
    modifier onlyOwnerOrSystem() {
        if (msg.sender != owner() && msg.sender != systemWallet) {
            revert NotAuthorizedGrantor(msg.sender);
        }
        _;
    }

    // ============================================
    // Read API
    // ============================================

    /// @inheritdoc IVIPSubscription
    function getTierFor(address user) external view returns (Tier) {
        Subscription memory s = subscriptions[user];
        if (s.expiresAt > block.timestamp) return s.tier;
        return Tier.Free;
    }

    /// @inheritdoc IVIPSubscription
    function subscriptionOf(address user) external view returns (Subscription memory) {
        return subscriptions[user];
    }

    /// @inheritdoc IVIPSubscription
    function remainingDuration(address user) external view returns (uint256) {
        uint64 e = subscriptions[user].expiresAt;
        if (e <= block.timestamp) return 0;
        return e - block.timestamp;
    }

    /// @notice True if the serial is currently in cooldown.
    function isSerialLocked(
        address token,
        uint256 serial
    ) external view returns (bool locked, uint64 lockedUntil) {
        lockedUntil = lockedSerials[token][serial];
        locked = lockedUntil > block.timestamp;
    }

    /// @notice Quote the $LAZY cost for a hypothetical purchase
    ///         without executing. Useful for frontend price display.
    ///         Validates ownership and cooldown the same as the real
    ///         path, but does NOT mutate state.
    function priceFor(
        Tier tier,
        uint16 months,
        DiscountProof[] calldata proofs,
        address payer
    ) external view returns (uint256 lazyAmount, uint16 effectiveDiscountBps) {
        if (tier == Tier.Free) revert InvalidTier();
        if (months == 0) revert ZeroMonths();
        if (payer == address(0)) revert ZeroAddress();

        uint16 holdingsBps = _resolveHoldingsDiscount(payer, tier, proofs);
        effectiveDiscountBps = _capCombined(holdingsBps, months);
        uint256 basePrice = monthlyPriceLazy[tier] * months;
        lazyAmount = (basePrice * (MAX_BPS - effectiveDiscountBps)) / MAX_BPS;
    }

    // ============================================
    // Purchase path
    // ============================================

    /**
     * @notice Buy or extend a subscription. Routes the $LAZY payment
     *         through LGS (burn % retained on burn, remainder retained
     *         on LGS as treasury), locks any nominated discount-proof
     *         serials for `cooldownSeconds`, and updates the user's
     *         subscription struct per the tier-upgrade rules.
     *
     * @dev    Tier upgrade rules:
     *           - Free / expired → standard new sub. `expiresAt = now
     *             + months × 30 days`.
     *           - Same tier active → extension. `expiresAt += months
     *             × 30 days`. Subject to `maxActiveDurationMonths`.
     *           - Lower tier active + buying higher → upgrade-in-place
     *             (existing time forfeited; replaced by new sub at
     *             higher tier).
     *           - Higher tier active + buying lower →
     *             `CannotDowngradeActiveSubscription`.
     *
     * @param tier Tier to purchase (Bronze through Platinum).
     * @param months Number of 30-day months to add.
     * @param proofs Holdings nominated for discount. Empty array =
     *         no holdings discount (caller still pays the base price
     *         minus any annual-prepay discount).
     */
    function purchaseSubscription(
        Tier tier,
        uint16 months,
        DiscountProof[] calldata proofs
    ) external nonReentrant {
        if (tier == Tier.Free) revert InvalidTier();
        if (months == 0) revert ZeroMonths();

        Subscription memory existing = subscriptions[msg.sender];
        bool active = existing.expiresAt > block.timestamp;

        // Tier-upgrade rules
        if (active) {
            if (existing.tier > tier) {
                revert CannotDowngradeActiveSubscription(existing.tier, tier);
            }
            // Same-tier extension: enforce max active duration cap.
            // Upgrade-in-place (existing.tier < tier): forfeits existing
            // time, so the new sub is just `months` long (no cap math
            // against existing).
            if (existing.tier == tier) {
                uint256 remainingMonths =
                    (existing.expiresAt - block.timestamp) / MONTH_SECONDS;
                if (remainingMonths + months > maxActiveDurationMonths) {
                    revert WouldExceedMaxDuration(
                        uint16(remainingMonths),
                        months,
                        maxActiveDurationMonths
                    );
                }
            }
            else {
                // Upgrade-in-place: a single purchase still can't
                // exceed the cap (no stacking with forfeited time).
                if (months > maxActiveDurationMonths) {
                    revert WouldExceedMaxDuration(0, months, maxActiveDurationMonths);
                }
            }
        }
        else {
            if (months > maxActiveDurationMonths) {
                revert WouldExceedMaxDuration(0, months, maxActiveDurationMonths);
            }
        }

        // Validate proofs + resolve max-across-tokens holdings discount
        // (the no-stacking rule: max of nominated proofs wins, not sum)
        uint16 holdingsBps = _resolveHoldingsDiscount(msg.sender, tier, proofs);
        uint16 finalBps = _capCombined(holdingsBps, months);

        // Compute price after discount
        uint256 basePrice = monthlyPriceLazy[tier] * months;
        uint256 finalPrice = (basePrice * (MAX_BPS - finalBps)) / MAX_BPS;

        // Lock nominated serials BEFORE the payment so a malicious
        // ERC-721 hook (if any) can't manipulate cooldown state via
        // reentry. (`nonReentrant` already guards re-entry into THIS
        // contract; the lock-first pattern is belt-and-braces against
        // unforeseen token-side hooks.)
        uint64 lockUntil = uint64(block.timestamp) + cooldownSeconds;
        for (uint256 i; i < proofs.length; ) {
            lockedSerials[proofs[i].token][proofs[i].serial] = lockUntil;
            emit SerialLockedForDiscount(
                proofs[i].token,
                proofs[i].serial,
                lockUntil
            );
            unchecked { ++i; }
        }

        // Execute payment via LGS — 3-sink split:
        //   1. burn `burnPercentage`% of the full price via LGS
        //   2. pay out `rebateBps` of full price to `rebatePool` from LGS
        //      (uses LGS treasury — see note below)
        //   3. pay out `teamBps` of full price to `teamWallet` from LGS
        //      (uses LGS treasury)
        //
        // Burn % is on the original 100. Rebate and team bps are also
        // on the original 100. The residual (100 - burn - rebate - team)
        // stays on LGS as protocol treasury. If burn + rebate + team
        // exceeds 100%, LGS dips into its existing treasury to cover —
        // operationally that's fine as long as LGS is well-funded
        // (the team configures the bps with this in mind).
        if (finalPrice > 0) {
            // Step 1: pull from user, burn the burn fraction
            ILazyGasStation(LAZY_GAS_STATION).drawLazyFrom(
                msg.sender,
                finalPrice,
                burnPercentage
            );

            // Step 2: rebate slice — LGS payout to rebatePool
            uint256 rebateAmt;
            if (rebateBps > 0 && rebatePool != address(0)) {
                rebateAmt = (finalPrice * rebateBps) / MAX_BPS;
                if (rebateAmt > 0) {
                    ILazyGasStation(LAZY_GAS_STATION).payoutLazy(
                        rebatePool,
                        rebateAmt,
                        0
                    );
                }
            }

            // Step 3: team slice — LGS payout to teamWallet
            uint256 teamAmt;
            if (teamBps > 0 && teamWallet != address(0)) {
                teamAmt = (finalPrice * teamBps) / MAX_BPS;
                if (teamAmt > 0) {
                    ILazyGasStation(LAZY_GAS_STATION).payoutLazy(
                        teamWallet,
                        teamAmt,
                        0
                    );
                }
            }

            emit SubscriptionRevenueSplit(
                msg.sender,
                finalPrice,
                (finalPrice * burnPercentage) / 100,
                rebateAmt,
                teamAmt
            );
        }

        // Apply subscription state
        uint64 addSeconds = uint64(months) * MONTH_SECONDS;
        uint64 newExpiresAt;
        if (active && existing.tier == tier) {
            // Same-tier extension
            newExpiresAt = existing.expiresAt + addSeconds;
        }
        else {
            // Fresh sub OR upgrade-in-place (forfeits existing time)
            newExpiresAt = uint64(block.timestamp) + addSeconds;
        }
        subscriptions[msg.sender] = Subscription({
            tier: tier,
            expiresAt: newExpiresAt
        });

        emit SubscriptionPurchased(
            msg.sender,
            tier,
            months,
            newExpiresAt,
            finalPrice,
            finalBps
        );
    }

    // ============================================
    // Admin — instant (operational-multisig expected)
    // ============================================
    //
    // Setters here are deliberately instant on-chain. Per the owner
    // administration model (see SECURITY.md), the owner is expected
    // to be a multisig wallet with an operational-layer timelock —
    // that is the user-facing notice window. Price/discount/parameter
    // changes affect only future purchases; `extendSubscription` is a
    // one-way grant (only adds time, never reduces).

    /// @notice Configure the discount for a (token, tier) pair.
    function setDiscount(
        address token,
        Tier tier,
        uint16 discountBps,
        uint256[] calldata allowedSerials
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (tier == Tier.Free) revert InvalidTier();
        if (discountBps > MAX_BPS) revert InvalidConfigBps(discountBps);

        DiscountConfig storage cfg = discountTable[token][tier];
        cfg.discountBps = discountBps;
        delete cfg.allowedSerials;
        for (uint256 i; i < allowedSerials.length; ) {
            cfg.allowedSerials.push(allowedSerials[i]);
            unchecked { ++i; }
        }
        emit DiscountConfigChanged(token, tier, discountBps, allowedSerials.length);
    }

    /// @notice Grant additional subscription time to a user without
    ///         charging $LAZY. Use cases: customer service makeups,
    ///         partnership comps, promo grants, bug bounty rewards.
    ///         Never reduces, no cap on admin discretion (the
    ///         `maxActiveDurationMonths` cap only applies to user-
    ///         initiated purchases).
    function extendSubscription(
        address user,
        uint16 months
    ) external onlyOwner {
        if (user == address(0)) revert ZeroAddress();
        if (months == 0) revert ZeroMonths();
        if (months > MAX_GRANT_MONTHS) revert GrantTooLong(months, MAX_GRANT_MONTHS);

        Subscription memory s = subscriptions[user];
        uint64 base = s.expiresAt > block.timestamp
            ? s.expiresAt
            : uint64(block.timestamp);
        uint64 newExpiresAt = base + uint64(months) * MONTH_SECONDS;
        // Preserve existing tier; if user had no subscription, default
        // to Bronze (the lowest paid tier — admin can re-grant a
        // different tier by buying a 0-cost grant once the discount
        // table supports a 100%-off path, or by setting a higher
        // tier via `setSubscriptionTier` — not in v1 to keep scope
        // tight).
        Tier tier = s.tier == Tier.Free ? Tier.Bronze : s.tier;
        subscriptions[user] = Subscription({
            tier: tier,
            expiresAt: newExpiresAt
        });
        emit SubscriptionExtendedByAdmin(user, months, newExpiresAt, msg.sender);
    }

    /// @notice Register (or rotate) the limited x402 backend wallet
    ///         authorized to call `grantSubscription`. Pass
    ///         `address(0)` to disable the system-grant path (e.g.
    ///         during a key-rotation or incident). Owner-only.
    function setSystemWallet(address wallet) external onlyOwner {
        systemWallet = wallet;
        emit SystemWalletChanged(wallet);
    }

    /**
     * @notice Grant a SPECIFIC tier for `months` without charging $LAZY
     *         — the x402 convenience rail. Payment is verified off-chain
     *         in HBAR/USDC; the $LAZY backing the grant is bought
     *         asynchronously by the treasury and is NOT this contract's
     *         concern (the grant consumes no $LAZY and touches no LGS).
     *         Callable by the owner (multisig) or the registered
     *         `systemWallet` backend.
     *
     * @dev    Tier-transition rules mirror `purchaseSubscription` so the
     *         paid and granted paths agree:
     *           - none / expired     → new sub at `tier`, `now + months`.
     *           - active, same tier  → extension (`expiresAt += months`).
     *           - active, lower tier → upgrade-in-place at `tier`,
     *             `now + months` (existing time forfeited).
     *           - active, higher tier → `CannotDowngradeActiveSubscription`
     *             (never silently downgrade; the backend reads the tier
     *             before accepting a lower-tier payment).
     *
     *         Idempotency: `ref` (e.g. `keccak256(payment tx id)`) is
     *         consumed on first use and replays revert. Capped at
     *         `MAX_GRANT_MONTHS` per call; `maxActiveDurationMonths`
     *         does NOT apply (matching `extendSubscription` — admin/
     *         system grants are not bound by the user-purchase cap).
     *
     * @param user   Beneficiary (non-zero).
     * @param tier   Paid tier (Bronze..Platinum; `Free` reverts).
     * @param months 30-day months to grant (1..MAX_GRANT_MONTHS).
     * @param ref    Opaque correlation id for the off-chain payment.
     *               Must be unique per grant; emitted + consumed for
     *               audit and replay protection.
     */
    function grantSubscription(
        address user,
        Tier tier,
        uint16 months,
        bytes32 ref
    ) external onlyOwnerOrSystem {
        if (user == address(0)) revert ZeroAddress();
        if (tier == Tier.Free) revert InvalidTier();
        if (months == 0) revert ZeroMonths();
        if (months > MAX_GRANT_MONTHS) revert GrantTooLong(months, MAX_GRANT_MONTHS);
        if (consumedRefs[ref]) revert RefAlreadyConsumed(ref);

        consumedRefs[ref] = true;

        Subscription memory s = subscriptions[user];
        bool active = s.expiresAt > block.timestamp;
        uint64 addSeconds = uint64(months) * MONTH_SECONDS;

        uint64 newExpiresAt;
        if (!active) {
            // Fresh / expired → new sub at the granted tier.
            newExpiresAt = uint64(block.timestamp) + addSeconds;
        } else if (s.tier == tier) {
            // Same tier → extend.
            newExpiresAt = s.expiresAt + addSeconds;
        } else if (s.tier < tier) {
            // Lower active + granting higher → upgrade-in-place
            // (existing time forfeited, mirrors purchaseSubscription).
            newExpiresAt = uint64(block.timestamp) + addSeconds;
        } else {
            // Higher active + granting lower → never downgrade.
            revert CannotDowngradeActiveSubscription(s.tier, tier);
        }

        subscriptions[user] = Subscription({ tier: tier, expiresAt: newExpiresAt });
        emit SubscriptionGrantedBySystem(user, tier, ref, months, newExpiresAt, msg.sender);
    }

    function setMonthlyPrice(Tier tier, uint256 lazyAmount) external onlyOwner {
        if (tier == Tier.Free) revert InvalidTier();
        if (lazyAmount < MIN_MONTHLY_PRICE) {
            revert PriceBelowFloor(lazyAmount, MIN_MONTHLY_PRICE);
        }
        monthlyPriceLazy[tier] = lazyAmount;
        emit PriceChanged(tier, lazyAmount);
    }

    function setAnnualPrepayDiscountBps(uint16 bps) external onlyOwner {
        if (bps > MAX_BPS) revert InvalidConfigBps(bps);
        annualPrepayDiscountBps = bps;
        emit ConfigChanged(CONFIG_KEY_ANNUAL_PREPAY, bps);
    }

    function setMaxCombinedDiscountBps(uint16 bps) external onlyOwner {
        if (bps > MAX_ALLOWED_COMBINED_DISCOUNT_BPS) {
            revert CombinedDiscountExceedsCap(bps, MAX_ALLOWED_COMBINED_DISCOUNT_BPS);
        }
        maxCombinedDiscountBps = bps;
        emit ConfigChanged(CONFIG_KEY_MAX_COMBINED, bps);
    }

    function setBurnPercentage(uint256 pct) external onlyOwner {
        burnPercentage = pct;
        emit ConfigChanged(CONFIG_KEY_BURN, pct);
    }

    function setCooldownSeconds(uint32 sec) external onlyOwner {
        cooldownSeconds = sec;
        emit ConfigChanged(CONFIG_KEY_COOLDOWN, sec);
    }

    function setMaxActiveDurationMonths(uint8 m) external onlyOwner {
        maxActiveDurationMonths = m;
        emit ConfigChanged(CONFIG_KEY_MAX_DURATION, m);
    }

    /// @notice Set the rebate slice in basis points. Hard-capped at
    ///         MAX_REBATE_BPS (50%). Pass 0 to disable the rebate
    ///         path entirely.
    function setRebateBps(uint16 bps) external onlyOwner {
        if (bps > MAX_REBATE_BPS) revert RebateBpsExceedsCap(bps, MAX_REBATE_BPS);
        rebateBps = bps;
        emit ConfigChanged(CONFIG_KEY_REBATE_BPS, bps);
    }

    /// @notice Set the team slice in basis points. Hard-capped at
    ///         MAX_TEAM_BPS (50%). Pass 0 to disable the team path
    ///         entirely.
    function setTeamBps(uint16 bps) external onlyOwner {
        if (bps > MAX_TEAM_BPS) revert TeamBpsExceedsCap(bps, MAX_TEAM_BPS);
        teamBps = bps;
        emit ConfigChanged(CONFIG_KEY_TEAM_BPS, bps);
    }

    /// @notice Set the rebate pool address. `address(0)` disables
    ///         the rebate flow regardless of `rebateBps`. Owner-only.
    ///         The target contract must be LAZY-associated before
    ///         LGS can pay it.
    function setRebatePool(address pool) external onlyOwner {
        rebatePool = pool;
        emit RebatePoolChanged(pool);
    }

    /// @notice Set the team wallet address. `address(0)` disables the
    ///         team flow. Owner-only. Wallet must be LAZY-associated.
    function setTeamWallet(address wallet) external onlyOwner {
        teamWallet = wallet;
        emit TeamWalletChanged(wallet);
    }

    // ============================================
    // Internal helpers
    // ============================================

    /// @dev Validates each proof (ownership, cooldown, allowlist) and
    ///      returns the MAX discount across nominated tokens — no
    ///      stacking. Reverts on any invalid proof.
    function _resolveHoldingsDiscount(
        address payer,
        Tier tier,
        DiscountProof[] calldata proofs
    ) internal view returns (uint16 maxBps) {
        uint256 n = proofs.length;
        for (uint256 i; i < n; ) {
            DiscountProof calldata p = proofs[i];
            DiscountConfig storage cfg = discountTable[p.token][tier];
            if (cfg.discountBps == 0) revert NoQualifyingDiscount(p.token);

            // Ownership at purchase time
            address owner_ = IERC721(p.token).ownerOf(p.serial);
            if (owner_ != payer) revert NotSerialOwner(payer, p.token, p.serial);

            // Cooldown
            uint64 lockedUntil = lockedSerials[p.token][p.serial];
            if (lockedUntil > block.timestamp) {
                revert SerialCooldownActive(p.token, p.serial, lockedUntil);
            }

            // Allowlist (if configured)
            if (cfg.allowedSerials.length > 0) {
                bool inList;
                uint256 m = cfg.allowedSerials.length;
                for (uint256 j; j < m; ) {
                    if (cfg.allowedSerials[j] == p.serial) {
                        inList = true;
                        break;
                    }
                    unchecked { ++j; }
                }
                if (!inList) revert SerialNotInAllowList(p.token, tier, p.serial);
            }

            if (cfg.discountBps > maxBps) maxBps = cfg.discountBps;
            unchecked { ++i; }
        }
    }

    /// @dev Combines holdings discount with the prepay-duration ramp,
    ///      capped at `maxCombinedDiscountBps`.
    function _capCombined(
        uint16 holdingsBps,
        uint16 months
    ) internal view returns (uint16) {
        uint256 durationBps = (uint256(annualPrepayDiscountBps) * uint256(months)) / 12;
        uint256 raw = uint256(holdingsBps) + durationBps;
        uint256 capped = raw > maxCombinedDiscountBps ? maxCombinedDiscountBps : raw;
        return uint16(capped);
    }
}
