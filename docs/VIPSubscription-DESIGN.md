# VIPSubscription — Contract Design Doc

**Status:** Pre-implementation design.
**Companion to:** `docs/AGENT-MARKETPLACE-DELTA.md` (decision context), `docs/LSHTierLib-DESIGN.md` (the holdings-tier library used by trade-fee consumers, NOT by this contract directly).
**Supersedes (in part):** `docs/VIPRegistry-DESIGN.md` (split into `LSHTierLib` + this contract).
**Target release:** v0.3 mainnet (companion to LST v2, BCF agent envelopes, EnglishAuction).

---

## Purpose

Two purposes, one contract:

1. **Paid subscription tier** — Bronze / Silver / Gold / Platinum, purchasable in $LAZY. Drives agent framework limits (daily budget caps, agent slots, priority lane) and any future premium features. Independent of trade-fee discounts (those come from `LSHTierLib`).
2. **$LAZY sink** — every subscription purchase burns a configurable percentage of the payment; the remainder retained by LGS (treasury). Primary driver of $LAZY demand from the agent ecosystem.

Trade fees remain holding-based (`LSHTierLib`). Subscription gates only NEW features. LSH holders get a one-time purchase discount when buying a subscription, but they don't have to subscribe to keep their existing free trades.

---

## Tier model

```solidity
enum Tier { Free, Bronze, Silver, Gold, Platinum }
```

| Tier | Source | Notes |
|---|---|---|
| Free | Default | Pre-agent-era behavior. No subscription needed. |
| Bronze | Purchased | Entry-level VIP. Smallest discount on holdings; smallest premium-feature allocation. |
| Silver | Purchased | |
| Gold | Purchased | |
| Platinum | Purchased | Top tier. Maximum agent slots, daily budget, priority lane. |

A user has at most ONE active subscription at a time. Buying a different tier mid-subscription is governed by the [tier-upgrade rules](#tier-upgrade-rules) below.

---

## Storage layout

```solidity
struct Subscription {
    Tier   tier;          // current paid tier
    uint64 expiresAt;     // unix timestamp; zero = no subscription
}

struct DiscountConfig {
    uint16   discountBps;        // 0-10000
    uint256[] allowedSerials;    // empty = all serials of token qualify; non-empty = allowlist
}

struct DiscountProof {
    address token;      // LSH token contract being claimed
    uint256 serial;     // specific serial nominated for discount
}

// State:
mapping(address user => Subscription) public subscriptions;                   // slot 0
mapping(address token => mapping(Tier tier => DiscountConfig)) public discountTable; // slot 1
mapping(address token => mapping(uint256 serial => uint64 lockedUntil)) public lockedSerials; // slot 2
mapping(Tier => uint256) public monthlyPriceLazy;                            // slot 3

// Config (owner-tunable):
uint16 public annualPrepayDiscountBps;     // e.g. 2000 = 20% off if buying 12 months
uint16 public maxCombinedDiscountBps;      // e.g. 9000 = 90% cap on holdings + duration
uint16 public burnPercentageBps;           // e.g. 5000 = 50% of paid $LAZY burned
uint32 public cooldownSeconds;             // e.g. 1_209_600 = 14 days
uint8  public maxActiveDurationMonths;     // e.g. 12

// Immutables:
address public immutable LAZY_TOKEN;
address public immutable LAZY_GAS_STATION;

// Owner: standard OZ Ownable. No multisig requirement at contract level
// (use FACTORY_MULTISIG_ACCOUNT_ID as owner if multisig governance desired).
```

Estimated bytecode: **~5-6 KiB**. Verify with `hardhat-contract-sizer` after first compile.

---

## Interface

### Hot path (trade-time / agent-framework reads)

```solidity
/// @notice Returns the user's active paid tier, or Free if none/expired.
/// Trivial SLOAD + comparison. No cache, no refresh, always fresh.
function getTierFor(address user) external view returns (Tier);

/// @notice Returns the user's subscription struct, even if expired.
function subscriptionOf(address user) external view returns (Subscription memory);

/// @notice Returns the remaining duration in seconds (0 if expired or none).
function remainingDuration(address user) external view returns (uint256);
```

Subcall cost from caller: 1 (xcall) + 0 internal subcalls. The contract has no external dependencies for the read path.

### Purchase path

```solidity
/// @notice Purchase or extend a subscription.
/// @param tier Target tier to buy.
/// @param months Number of months to add.
/// @param proofs Array of (token, serial) pairs the user is nominating
///        for discount. Empty array = no holdings discount.
function purchaseSubscription(
    Tier tier,
    uint16 months,
    DiscountProof[] calldata proofs
) external;

/// @notice Quote the $LAZY cost for a purchase without executing it.
/// Useful for frontend price display before user signs.
function priceFor(
    Tier tier,
    uint16 months,
    DiscountProof[] calldata proofs,
    address payer
) external view returns (uint256 lazyAmount, uint16 effectiveDiscountBps);

/// @notice Check if a specific serial is in cooldown.
function isSerialLocked(address token, uint256 serial)
    external view returns (bool locked, uint64 lockedUntil);
```

### Admin (onlyOwner)

```solidity
/// @notice Configure the discount for a (token, tier) pair.
/// @param allowedSerials Empty = all serials qualify; non-empty = allowlist.
function setDiscount(
    address token,
    Tier tier,
    uint16 discountBps,
    uint256[] calldata allowedSerials
) external onlyOwner;

/// @notice Extend a user's subscription as an admin grant (free to user).
/// No reduction allowed; no cap (admin discretion).
function extendSubscription(address user, uint16 months) external onlyOwner;

function setMonthlyPrice(Tier tier, uint256 lazyAmount) external onlyOwner;
function setAnnualPrepayDiscountBps(uint16 bps) external onlyOwner;
function setMaxCombinedDiscountBps(uint16 bps) external onlyOwner;
function setBurnPercentageBps(uint16 bps) external onlyOwner;
function setCooldownSeconds(uint32 seconds_) external onlyOwner;
function setMaxActiveDurationMonths(uint8 months) external onlyOwner;
```

### Events

```solidity
event SubscriptionPurchased(
    address indexed user,
    Tier indexed tier,
    uint16 monthsAdded,
    uint64 newExpiresAt,
    uint256 lazyPaid,
    uint16 effectiveDiscountBps
);
event SubscriptionExtendedByAdmin(
    address indexed user,
    uint16 monthsAdded,
    uint64 newExpiresAt,
    address indexed grantor
);
event DiscountConfigChanged(
    address indexed token,
    Tier indexed tier,
    uint16 discountBps,
    uint256 allowedSerialsCount
);
event PriceChanged(Tier indexed tier, uint256 newMonthlyLazy);
event SerialLockedForDiscount(address indexed token, uint256 indexed serial, uint64 lockedUntil);
event ConfigChanged(bytes32 indexed key, uint256 value);  // generic for burn / prepay / cap / cooldown / maxDuration
```

### Custom errors

```solidity
error NoQualifyingDiscount(address proofToken);          // proof token has no discount config
error SerialCooldownActive(address token, uint256 serial, uint64 lockedUntil);
error NotSerialOwner(address user, address token, uint256 serial);
error SerialNotInAllowList(address token, Tier tier, uint256 serial);
error WouldExceedMaxDuration(uint16 currentRemaining, uint16 requested, uint8 max);
error InvalidTier();
error ZeroMonths();
error ZeroAddress();
error InsufficientLazyAllowance(uint256 needed, uint256 have);
error InvalidConfigBps(uint16 bps);
error InvalidConfigCombination();  // e.g. burn + treasury split would exceed 10000
```

---

## Purchase flow

Walkthrough of `purchaseSubscription(Tier.Platinum, 6, [{LSH_GEN1, 42}])` for a user with Gen 1 NFT #42:

```
1. Validation
   - Reject if months == 0
   - Reject if tier == Free
   - Compute currentRemainingMonths(user); reject if currentRemaining + months > maxActiveDurationMonths

2. For each proof in proofs (just one in this example):
   - Verify msg.sender owns the serial: IERC721(LSH_GEN1).ownerOf(42) == msg.sender
     → 1 subcall
   - Check serial cooldown: lockedSerials[LSH_GEN1][42] < block.timestamp
     → SLOAD, no subcall
   - If discountTable[LSH_GEN1][Platinum].allowedSerials is non-empty,
     check serial is in the allowlist
     → SLOAD per check (typically small array)
   - Record the discount candidate: 7500 bps (75% from config)

3. Compute effective discount:
   - holdingsDiscountBps = max across all valid proofs = 7500 (just one proof here)
   - durationDiscountBps = annualPrepayDiscountBps × months / 12 = 2000 × 6/12 = 1000
   - totalDiscountBps = min(holdingsDiscountBps + durationDiscountBps, maxCombinedDiscountBps)
                      = min(7500 + 1000, 9000)
                      = 8500 (85% off)

4. Compute price:
   - basePrice = monthlyPriceLazy[Platinum] × months = 1000 × 6 = 6000 LAZY
   - finalPrice = basePrice × (10000 - 8500) / 10000 = 6000 × 0.15 = 900 LAZY

5. Execute payment via LGS:
   - LGS.drawLazyFrom(msg.sender, 900, burnPercentageBps)
     → ~3 subcalls (HTS transferFrom + HTS burn + bookkeeping)
   - Of the 900 paid: 450 burned (50%), 450 retained by LGS (treasury)

6. Lock the nominated serials for cooldown:
   - lockedSerials[LSH_GEN1][42] = block.timestamp + cooldownSeconds
   - 14 days from now
   - Emit SerialLockedForDiscount(LSH_GEN1, 42, lockedUntil)

7. Update subscription:
   - subscriptions[user].tier = Platinum
   - subscriptions[user].expiresAt += months × 30 days
   - Emit SubscriptionPurchased(user, Platinum, 6, newExpiresAt, 900, 8500)
```

**Total subcalls per purchase:** ~4-5 for the common case (1 proof + LGS draw). Comfortably within budget.

---

## Tier-upgrade rules

What happens when a user with an active subscription buys a different tier?

| Existing | Buying | Result |
|---|---|---|
| Free / expired | Any tier | Standard new subscription. expiresAt = now + months × 30 days. |
| Same tier, active | Same tier | Extension: expiresAt += months × 30 days. Subject to maxActiveDurationMonths cap. |
| Lower tier, active | Higher tier | **Upgrade-in-place**: existing time forfeited; new subscription replaces. (Simple math; user loses unused time but gains higher tier.) |
| Higher tier, active | Lower tier | **Reverts**: `error CannotDowngradeActiveSubscription()`. User must wait for current to expire. |

The "upgrade-in-place" choice is deliberate — it keeps the math simple and avoids pro-rata refund complexity. Users buying a higher tier mid-sub are typically getting more value, not feeling cheated. Document this clearly in any user-facing materials.

If pro-rata refund is desired later, it can be added without breaking the contract surface (just adds a refund branch in the upgrade path).

---

## Loaner-abuse mitigation: serial cooldown

The threat: a Gen 1 holder repeatedly lends their NFT to fresh wallets to subsidize multiple discounted subscriptions.

Mitigation: when a serial is used as discount proof, it's globally locked for `cooldownSeconds` (default **14 days**). Any future purchase nominating that serial reverts `SerialCooldownActive`.

Properties:
- Lock is **global to the serial**, not per-user. New owner of the NFT also faces the cooldown.
- Lock is independent of subscription duration. Sub purchased today for 12 months; serial locked for only 14 days. After 14 days, anyone holding the serial can use it for a new discount (their own).
- Lock is checked at purchase, not at trade. Subscriptions are not affected if the serial later moves to another wallet.

Economic ceiling under 14-day cooldown:
- ~26 cycles per year per NFT
- Per-cycle Platinum savings: ~2 HBAR equivalent
- Per-Gen-1 yearly abuse: ~52 HBAR
- Per-Mutant: ~26 HBAR
- Per-Gen-2: ~13 HBAR

Negligible. Acceptable.

Friction for legitimate sales: a new buyer waits 2 weeks before they can use the NFT for purchase discount. Reasonable for a marketplace utility.

Cooldown is admin-tunable via `setCooldownSeconds`. Recommend keeping ≥ 7 days and ≤ 90 days as practical bounds. Owner can adjust if abuse patterns emerge.

---

## Pro-rated annual prepay discount

```
durationDiscountBps = annualPrepayDiscountBps × months / 12
```

With `annualPrepayDiscountBps = 2000` (20%):

| Months | Duration discount |
|---|---|
| 1 | 1.67% |
| 3 | 5% |
| 6 | 10% |
| 12 | 20% |

Combined with holdings discount, capped at `maxCombinedDiscountBps` (recommend 9000 = 90%):

```
totalDiscountBps = min(
    holdingsDiscountBps + durationDiscountBps,
    maxCombinedDiscountBps
);
```

A Gen 1 holder taking the maximum 12-month subscription:
- holdings = 7500 (75%)
- duration = 2000 (20%)
- raw sum = 9500
- capped at 9000 (90%)
- Pays 10% of base price

Still a real $LAZY sink — at example 1000 LAZY/month for Platinum, that's 1200 LAZY for a year (~3.4 HBAR). Token amount, but maintains the sink intent.

---

## Admin extension (free grant)

`extendSubscription(user, months)` is an owner-only operation that lengthens a user's subscription without consuming $LAZY. Use cases:
- Customer service makeups (downtime credit, support resolution gifts)
- Partnership comps (collaborator gets a year of Platinum)
- Promotional grants (early-adopter loyalty)
- Bug bounty rewards in subscription form

Rules:
- **Never reduces** — only adds time
- **No maximum** — admin discretion (the 12-month `maxActiveDurationMonths` cap applies only to USER-initiated purchases)
- **Emits `SubscriptionExtendedByAdmin`** — transparent on-chain audit trail

If you want to cap admin grants too, it's a 1-line addition. Default is unlimited for flexibility.

---

## $LAZY payment flow

```
User                  VIPSubscription                    LazyGasStation                  LazySCT
 │                          │                                  │                            │
 ├─approve(LGS, totalPrice)─┼─────────────────────────────────►│                            │
 │                          │                                  │                            │
 ├─purchaseSubscription(    │                                  │                            │
 │   Platinum, 6,           │                                  │                            │
 │   [{Gen1, 42}])          │                                  │                            │
 │                          │                                  │                            │
 │                          ├──ownerOf(42)───►Gen1 token       │                            │
 │                          │◄──msg.sender─────                │                            │
 │                          │                                  │                            │
 │                          ├──drawLazyFrom(                   │                            │
 │                          │    user, 900, 5000bps)──────────►│                            │
 │                          │                                  ├──HTS transferFrom─────────►│
 │                          │                                  │◄──900 LAZY transferred────│
 │                          │                                  ├──IBurnableHTS.burn(450)──►│ 450 burned
 │                          │                                  │                            │ 450 retained
 │                          │                                  │                            │
 │                          ├──lockedSerials[Gen1][42] = now+14d                            │
 │                          ├──subscriptions[user].expiresAt += 6mo                         │
 │                          ├──emit SubscriptionPurchased,                                  │
 │                          │       SerialLockedForDiscount                                 │
```

LGS already exposes `drawLazyFrom(user, amount, burnPercentageBps)` which handles the draw + burn in one call. The unburned remainder stays in LGS (treasury). No separate transfer-to-treasury subcall needed.

Single $LAZY allowance approval needed by user (LGS as spender). Standard ERC20-style flow.

---

## Integration with consumer contracts

### Agent envelope contracts (primary consumer)

When per-agent budget envelopes ship (BCF stash extension), they consult VIPSubscription for tier-driven limits:

```solidity
import { IVIPSubscription } from "./interfaces/IVIPSubscription.sol";

contract BidderContract {
    IVIPSubscription public immutable vip;

    function _maxAgentSlotsForOwner() internal view returns (uint8) {
        IVIPSubscription.Tier t = vip.getTierFor(owner);
        if (t == IVIPSubscription.Tier.Platinum) return 5;
        if (t == IVIPSubscription.Tier.Gold)     return 3;
        if (t == IVIPSubscription.Tier.Silver)   return 2;
        if (t == IVIPSubscription.Tier.Bronze)   return 1;
        return 0;  // Free users get no agents
    }

    function _maxDailyBudgetForOwner() internal view returns (uint256) {
        IVIPSubscription.Tier t = vip.getTierFor(owner);
        // ... similar mapping
    }
}
```

Subcall cost: 1 per tier resolution. No batch concern (agent setup is per-tx, not per-item).

### Future consumers

Any contract gating "premium features" on subscription tier follows the same pattern. The contract has no external dependencies for the hot-path read.

### Specifically NOT consumers

- `LSHTierLib` and trade-fee paths do NOT call VIPSubscription. Trade fees remain holding-based via `LSHTierLib`. Separation of concerns: free trades = LSH ownership; agent framework = paid subscription.
- LazyLotto's "is holder" check uses `LSHTierLib.isAnyHolder`, not VIPSubscription. If LazyLotto wants tiered odds based on VIP, that's a future product call.

---

## Test plan outline

Following `feedback_test_methodology.md`:

- **Tier resolution:**
  - Free user → `getTierFor` returns Free
  - Active sub → returns purchased tier
  - Expired sub → returns Free (and emits no event — passive expiry)
  - `subscriptionOf` returns the struct even when expired (for post-mortem queries)

- **Purchase flow happy path:**
  - Non-holder purchases Platinum 1 month → pays full price
  - Gen 1 holder with proof → pays 25% of full price (75% off)
  - Mutant holder with proof → pays 50% of full price
  - Gen 2 holder with proof → pays 75% of full price
  - 12-month prepay → additional 20% off (pro-rata for partial year)
  - Combined holdings + duration discount → capped at 90%

- **No-stacking rule:**
  - User nominates both Gen 1 and Gen 2 serials → discount = max(75%, 25%) = 75% (not 100%)
  - User nominates Mutant + Gen 2 → discount = 50% (not 75%)

- **Loaner mitigation:**
  - Alice purchases with serial #42 → cooldown set
  - Alice tries to purchase again with serial #42 → reverts `SerialCooldownActive`
  - Alice transfers #42 to Bob (the new owner)
  - Bob tries to purchase with serial #42 → reverts `SerialCooldownActive` (still within cooldown)
  - After cooldown expires, Bob can purchase with serial #42 → succeeds

- **Ownership verification:**
  - User nominates serial they don't own → reverts `NotSerialOwner`
  - User nominates serial they own but in allowlist that excludes it → reverts `SerialNotInAllowList`
  - User nominates token with no discount config → reverts `NoQualifyingDiscount`

- **Max duration cap:**
  - User with 0 months active purchases 12 months → succeeds
  - User with 6 months remaining purchases 6 more → succeeds (12 total)
  - User with 6 months remaining purchases 7 → reverts `WouldExceedMaxDuration`
  - Admin extends a user beyond 12 months → succeeds (no cap on admin grants)

- **Tier upgrade rules:**
  - Free user buys Bronze → standard purchase
  - Bronze user with 3 months left buys 3 more Bronze → extension (6 months Bronze)
  - Bronze user with 3 months left buys Gold → upgrade in place (3 months Gold, prior 3 months forfeited)
  - Gold user buys Bronze → reverts `CannotDowngradeActiveSubscription`

- **Admin paths:**
  - `setDiscount` updates the table; subsequent purchases use new values
  - `extendSubscription` adds months without $LAZY consumed
  - `extendSubscription` cannot reduce expiresAt (no negative months)
  - Bps configs reject values > 10000

- **$LAZY flow:**
  - Confirm LGS.drawLazyFrom is called with correct amount + burn bps
  - Verify burn portion is destroyed (total supply decreases)
  - Verify treasury portion stays in LGS

- **Subcall budget verification:**
  - Empirically measure subcalls for `purchaseSubscription(tier, 1, [1 proof])` → target ≤ 5
  - Empirically measure for `getTierFor(user)` from a consumer → target = 1 (xcall only)

All tests follow `expectRevertNamed` typed-error pattern; mirror reads for state verification; `MIRROR_DELAY` sleeps after writes.

---

## Pre-implementation probe checklist

- [ ] Compile a stub VIPSubscription → measure bytecode. Confirms ~5-6 KiB estimate.
- [ ] Confirm `LGS.drawLazyFrom` signature matches (3 args: user, amount, burnBps).
- [ ] Confirm `IBurnableHTS.burn` is called internally by LGS, not directly by VIPSubscription.
- [ ] Verify HTS NFT `ownerOf(serial)` call cost from a Solidity contract on Hedera (should be 1 subcall).

---

## Open implementation questions

1. **Should subscription-tier benefits be enforced HERE or in consumers?**
   Recommend consumers — VIPSubscription returns the tier; consumers decide what each tier unlocks (agent slots, daily budget, etc.). Keeps VIPSubscription a pure tier-and-payment contract.

2. **Should `getTierFor` automatically emit a `SubscriptionExpired` event when first observed?**
   Recommend no — silent expiry. Adding an event-emit to a `view`-shaped function would make it stateful. Off-chain consumers (indexers, frontends) can derive expiry from `subscriptionOf(user).expiresAt < block.timestamp`.

3. **Should admin be able to set per-tier max-active-duration differently?**
   E.g. Platinum capped at 12 months, Bronze at 24 months. Probably not for v1 — keep one cap. Add if product demands it.

4. **Should the discount allowlist support EXCLUSION (block specific serials) as well as inclusion?**
   Probably not for v1 — single mode (empty = all, non-empty = allowlist) is simpler. Inclusion-only handles the legendary-serial promo case. Exclusion is a niche use case.

5. **Refund flow if user wants to cancel mid-subscription?**
   Not in v1. Subscriptions are non-refundable. Adds complexity (pro-rata $LAZY return, burn reversal handling). Add later if support tickets demand it.

6. **Multi-token nominate same purchase?**
   Already supported — `proofs` is an array. Maximum-discount-wins (not stacking) handles the math.

---

## Out of scope (for this contract)

- LSH trade-fee tier resolution — lives in `LSHTierLib`, used by LST v2 / BCF / Auction / Lotto directly.
- Per-agent budget envelopes — BCF stash extension, consumes this contract for tier-driven limits.
- Quest reward distribution — handled by `Mission.sol` from LAZY-Farms.
- Off-chain agent runtime concerns — agentic-layer repo.

---

## Open product decisions (deferred to release planning)

- Monthly $LAZY prices per tier (no concrete numbers yet — set via `setMonthlyPrice` at deploy + tuned over time)
- `annualPrepayDiscountBps` starting value (suggest 2000 = 20%)
- `maxCombinedDiscountBps` starting value (suggest 9000 = 90%)
- `burnPercentageBps` starting value (suggest 5000 = 50%)
- `cooldownSeconds` starting value (suggest 1_209_600 = 14 days, per recent decision)
- `maxActiveDurationMonths` starting value (suggest 12)
- Initial discount table entries (per LSH token × per tier — needs concrete numbers)
- Tier-to-benefit mapping (agent slots, daily budgets) — lives in consumer contracts, not here, but needs design

---

*Companion docs: `LSHTierLib-DESIGN.md` for trade-fee tier resolution. `AGENT-MARKETPLACE-DELTA.md` for the broader architecture context.*
