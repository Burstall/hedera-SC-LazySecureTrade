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

    // ============================================
    // Errors
    // ============================================

    error InvalidTier();
    error ZeroMonths();
    error ZeroAddress();
    error InvalidConfigBps(uint16 bps);
    error WouldExceedMaxDuration(uint16 currentRemaining, uint16 requested, uint8 max);
    error CannotDowngradeActiveSubscription(Tier current, Tier requested);
    error NoQualifyingDiscount(address token);
    error NotSerialOwner(address user, address token, uint256 serial);
    error SerialNotInAllowList(address token, Tier tier, uint256 serial);
    error SerialCooldownActive(address token, uint256 serial, uint64 lockedUntil);

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

        // Execute payment via LGS
        if (finalPrice > 0) {
            ILazyGasStation(LAZY_GAS_STATION).drawLazyFrom(
                msg.sender,
                finalPrice,
                burnPercentage
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
    // Admin
    // ============================================

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

    function setMonthlyPrice(Tier tier, uint256 lazyAmount) external onlyOwner {
        if (tier == Tier.Free) revert InvalidTier();
        monthlyPriceLazy[tier] = lazyAmount;
        emit PriceChanged(tier, lazyAmount);
    }

    function setAnnualPrepayDiscountBps(uint16 bps) external onlyOwner {
        if (bps > MAX_BPS) revert InvalidConfigBps(bps);
        annualPrepayDiscountBps = bps;
        emit ConfigChanged(CONFIG_KEY_ANNUAL_PREPAY, bps);
    }

    function setMaxCombinedDiscountBps(uint16 bps) external onlyOwner {
        if (bps > MAX_BPS) revert InvalidConfigBps(bps);
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
