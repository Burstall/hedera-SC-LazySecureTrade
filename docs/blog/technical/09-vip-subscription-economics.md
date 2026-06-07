# VIPSubscription tier economics — discounts, cooldowns, and the loaner problem

> **Audience:** Developers + product folks designing tokenomic
> systems with holdings-based discounts.
> **Read time:** ~9 minutes.
> **Last updated:** 2026-05-27.

VIPSubscription is the paid-tier contract for LazySecureTrade.
Users buy a Bronze/Silver/Gold/Platinum subscription in $LAZY;
the tier gates how many agent slots they have and what daily
budgets those agents can spend. Holders of certain LSH NFTs get
a one-time discount on subscription purchase.

The interesting design questions weren't around the pricing
table — those are tuning knobs that can be adjusted later.
They were around the **loaner attack** on holdings-based
discounts, the **prepay discount cap** that prevents pricing
collapse, and the **upgrade-in-place** semantics that govern
mid-subscription tier changes.

This post walks through each.

## The loaner attack and how the 14-day cooldown defeats it

The setup: a user wants to buy a Platinum subscription. Platinum
discount table says "5,000 LAZY off if you hold an LSH Gen 1
NFT at purchase time."

Naive design: at purchase, the user passes their LSH Gen 1
serial as proof; the contract verifies they own it via
`balanceOf` / `ownerOf`; if yes, apply discount.

The attack: a Discord group buys ONE LSH Gen 1 NFT, then passes
it serial-by-serial to each member of the group around the time
they each want to subscribe. Each member temporarily owns the
NFT during their `purchaseSubscription` call, gets the
discount, then transfers it to the next person.

The fix is a **per-serial cooldown** on the discount:

```solidity
mapping(address token => mapping(uint256 serial => uint64 lockedUntil)) public lockedSerials;

uint32 public cooldownSeconds = 14 days;
```

When a user uses serial S for a discount, `lockedSerials[token][S]`
gets set to `block.timestamp + 14 days`. Anyone else trying to
use the same serial during that window fails the discount-proof
check.

Implementation in `purchaseSubscription`:

```solidity
for (uint256 i; i < proofs.length; ) {
    DiscountProof memory p = proofs[i];
    if (lockedSerials[p.token][p.serial] > block.timestamp) {
        revert SerialCooldownActive(p.token, p.serial, lockedSerials[p.token][p.serial]);
    }
    // ... verify ownership ...
    lockedSerials[p.token][p.serial] = uint64(block.timestamp) + cooldownSeconds;
    emit SerialLockedForDiscount(p.token, p.serial, lockedUntil);
    unchecked { ++i; }
}
```

Effect: the loaner attack is rate-limited. A single LSH Gen 1
NFT can unlock the discount once every 14 days, not once per
hour. A coordinated group of 26 people would need 26 NFTs (or
to wait a year). The economics no longer favor the attack.

The 14-day window is configurable by the owner via
`setCooldownSeconds(uint32)`, bounded to `[7 days, 90 days]` to
prevent the cooldown from being trivially short or absurdly
long.

## Why we don't burn discount eligibility entirely

A more aggressive design would be "once an NFT is used for a
subscription discount, mark it permanently used." That's harder
to coordinate around — there's no rotating window.

We rejected it because it punishes legitimate use cases:

1. **A user upgrades their tier.** They bought Bronze 6 months
   ago using NFT serial S for discount. Now they want to
   upgrade to Gold. They'd be denied the Gold discount because
   S was burned by the earlier Bronze purchase.
2. **A user lets their subscription lapse and re-subscribes.**
   Permanent burn means they pay full price forever despite
   still holding the same NFT.

Cooldown gives users their NFT's discount value back on a clock,
without enabling spam abuse.

## The combined-discount cap

Subscriptions can stack two kinds of discounts:

- **Holdings discount** (from LSH NFT proof) — admin-tunable
  per (token, tier).
- **Prepay discount** — pro-rated by months purchased.
  `annualPrepayDiscountBps * months / 12`. Default 2000 bps
  for a 12-month purchase, or ~166 bps for a 1-month purchase
  (`2000 / 12`).

Without a cap, a Platinum holder buying 12 months would stack
the maximum holdings discount + maximum prepay discount:

- Holdings discount on a tier: up to 100% (admin-set)
- Prepay discount on 12 months: 20% (default 2000 bps)

= 120% total, which is nonsensical (and the contract would
underflow). Even capping at 100%, a free Platinum subscription
isn't viable economically — there has to be at least some
LAZY flowing into the burn pool for tokenomics.

The cap:

```solidity
uint16 public maxCombinedDiscountBps = 9_000;   // 90% cap
uint16 internal constant MAX_ALLOWED_COMBINED_DISCOUNT_BPS = 5_000;
```

`maxCombinedDiscountBps` is owner-tunable; `MAX_ALLOWED_...` is
the hard ceiling (50%) enforced in the setter. Even a
compromised owner can't push the cap above 50%.

The effective discount formula:

```
finalBps = min(holdingsBps + prepayBps, maxCombinedDiscountBps)
```

In English: stack the discounts, but cap the total. For users
who hold LSH AND prepay a year, they get 90% off (the soft
cap) — generous but not catastrophic.

## Tier upgrade semantics

Users can change tiers mid-subscription. The rules:

```
Active subscription at tier T, buying new tier U:
  T == U     →  Extension. expiresAt += months × 30 days.
                Subject to MAX_ACTIVE_DURATION_MONTHS (12).
  T < U      →  Upgrade-in-place. Existing time FORFEITED.
                New expiresAt = block.timestamp + months × 30 days.
                Tier becomes U.
  T > U      →  Reverts CannotDowngradeActiveSubscription.
                User must let current sub expire, then buy U fresh.
```

Three things to notice:

1. **Same-tier extension stacks time.** A Bronze user who buys
   another month of Bronze extends their existing sub. Caps at
   12 months total to prevent prepay-eternity.
2. **Upgrade-in-place forfeits time.** A Bronze user with 5
   months left who buys Gold gets a fresh Gold sub for the
   duration they purchased — they don't get their 5 Bronze
   months credited as 5 Gold months. This is the simpler
   design (no time-credit math) and aligns with the typical
   "upgrade" expectation in SaaS subscriptions.
3. **Downgrade is blocked while a higher tier is active.**
   The user could let Gold expire and then buy Bronze. They
   can't shrink their tier with time remaining — that would
   create ambiguity about what features they currently
   have. Once the higher sub lapses, they're at Free and can
   buy whatever they want.

## The owner-grant path (extendSubscription)

For customer service grants (giveaways, promo, bug bounty),
the owner can extend a user's subscription without payment:

```solidity
function extendSubscription(address user, uint16 months) external onlyOwner {
    if (months > MAX_GRANT_MONTHS) revert GrantTooLong(months, MAX_GRANT_MONTHS);
    Subscription memory s = subscriptions[user];
    uint64 base = s.expiresAt > block.timestamp ? s.expiresAt : uint64(block.timestamp);
    Tier tier = s.tier == Tier.Free ? Tier.Bronze : s.tier;   // default to Bronze for new
    subscriptions[user] = Subscription({ tier: tier, expiresAt: base + months * MONTH_SECONDS });
    emit SubscriptionExtendedByAdmin(user, months, newExpiresAt, msg.sender);
}
```

Two constraints worth noting:

- **`MAX_GRANT_MONTHS = 12`** — owner can grant at most a year
  in one call. Per-call cap, not per-user — a determined owner
  could call repeatedly. The cap exists for ops-friendliness
  (no thousand-year grants from a typo) and as a defense-in-
  depth against compromised owner keys.
- **Existing tier is preserved.** If the user is at Gold,
  `extendSubscription` extends their Gold time. If they're at
  Free (no subscription), the function defaults to Bronze.
  There's no admin path to change tier — only to extend time.

The "admin can't change tier" property is intentional. A
compromised owner key shouldn't be able to demote everyone to
Free in retaliation, nor promote a target to Platinum. Tier
changes go through `purchaseSubscription` and follow the same
upgrade rules.

## The $LAZY sink

Every paid purchase routes through LazyGasStation
(`drawLazyFrom`), which:

1. Pulls LAZY from the user's wallet (allowance pre-granted).
2. Burns a configurable percentage (the `burnPercentage` field,
   default 50%).
3. Routes the remainder to the LGS treasury.

This makes subscriptions a $LAZY sink at the burn rate of
`50% × subscription revenue`. The remaining 50% accumulates in
LGS treasury — usable for staking rewards, marketplace
rebates, or other tokenomic levers.

The `burnPercentage` is owner-tunable. Bounds: `[0, 100]`.
Setting to 100% maximizes deflationary pressure; setting to 0%
maximizes treasury accumulation. The current default (50%) is
a balance.

For ecosystems just starting out, the high-burn approach
matches "discourage hoarding, encourage trading." For mature
ecosystems with stable token supply, lower burn + treasury
buildup makes more sense. The contract supports both stances
without redeploy.

## How the tier table relates to agent envelopes

The whole reason for VIPSubscription is to gate agent slot
allocation and daily budget caps. The agent envelope system
reads `getTierFor(owner)` at envelope creation to enforce the
caps:

| Tier | Slots | Daily HBAR cap | Daily LAZY cap |
|---|---|---|---|
| Free | 0 | — | — |
| Bronze | 1 | 500 | 5,000 |
| Silver | 2 | 1,500 | 15,000 |
| Gold | 3 | 3,500 | 35,000 |
| Platinum | 5 | 10,000 | 100,000 |

Free-tier users have 0 slots — they can't authorize agents at
all. The tier-table is owner-tunable behind a 48h timelock
(`setAgentTierLimits` on the BCF).

Critically, **tier is captured at envelope creation, not at
spend time.** If a user creates an envelope at Platinum and then
their subscription lapses to Free, the existing envelope keeps
working until its `expiresAt` (which is bounded by the
tier-table's `maxExpiryWindow`). New envelope creation at Free
is blocked.

This is the "grandfather" semantic — users don't have to
maintain their VIP just to keep their existing agents running.
They have to renew to AUTHORIZE more or refresh expired ones.

## Reference

- The contract is at
  [`contracts/VIPSubscription.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/VIPSubscription.sol).
- The 16-test acceptance suite:
  [`test/VIPSubscription.test.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/test/VIPSubscription.test.js).
- The original design rationale (including the loaner-attack
  discussion):
  [`docs/VIPSubscription-DESIGN.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/docs/VIPSubscription-DESIGN.md).
- The tier-table → agent slot/cap mapping is locked in
  [`docs/v0.3-WORKING-PLAN.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/docs/v0.3-WORKING-PLAN.md)
  under "Locked default tier table."
