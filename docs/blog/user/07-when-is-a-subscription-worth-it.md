# When is a subscription worth it? Tier-by-tier breakdown

> **Audience:** Active traders deciding whether to subscribe,
> and which tier makes sense for their use case.
> **Read time:** ~7 minutes.
> **Last updated:** 2026-05-27.

LazySecureTrade subscriptions cost $LAZY and unlock agent-
running capabilities. If you're trading manually, you don't
need one — Free tier handles everything except automation. If
you want a bot to trade on your behalf inside guarded budgets,
you have to pick a tier.

This post is the honest economic breakdown. Real numbers, real
trade-offs, what each tier is actually for.

## The shape of the subscription gate

Subscriptions don't change trade fees. Those stay tied to LSH
holdings (Gen 1 = 100% off, Mutant = 75%, Gen 2 = 50%, none =
1%). What subscriptions change is **how many agents you can
authorize and what they can spend per day**.

| Tier | Agent slots | Daily HBAR cap | Daily LAZY cap | Per-tx HBAR | Per-tx LAZY |
|---|---|---|---|---|---|
| Free | 0 | — | — | — | — |
| Bronze | 1 | 500 | 5,000 | 200 | 2,000 |
| Silver | 2 | 1,500 | 15,000 | 500 | 5,000 |
| Gold | 3 | 3,500 | 35,000 | 1,000 | 10,000 |
| Platinum | 5 | 10,000 | 100,000 | 2,500 | 25,000 |

A few patterns to notice:

- **Free has 0 slots.** You can't run an agent at all without
  subscribing. (LSH holders may get 1 free slot off-chain — UX
  rule, not enforced on-chain.)
- **Per-tx is a fraction of daily.** Bronze caps a single bid
  at 200 HBAR (40% of the daily 500). The per-tx cap is the
  "don't let one runaway transaction spend the day's budget"
  guardrail.
- **Tiers scale faster than agent slots.** Going from Bronze
  to Platinum is 5x slots but 20x daily HBAR. The implicit
  message: more slots are useful, but the daily budget per
  user is the bigger unlock.

## What each tier is actually for

### Free — manual traders only

If you're not running an agent, this is you. You can:

- List NFTs, accept bids, place bids, win auctions
- Hold an LSH NFT for fee discounts
- Use $LAZY for fee-free trades

You can't:

- Authorize any agent

There's no reason to subscribe if you're trading manually.
Save your $LAZY for trades.

### Bronze — single-purpose bot

The entry tier. One agent slot. The daily cap (500 HBAR) is
enough for a focused bot:

- **A SNIPER on a single auction.** Watching the close window,
  bidding when threatened. 200 HBAR per-tx is enough for
  most auction sizes.
- **A targeted bidder.** Standing bid on one collection, max
  ~200 HBAR per acquisition. Daily 500 lets you snipe maybe
  2-3 NFTs.
- **A test rig.** Trying out the agent system on testnet-
  equivalent volumes before scaling.

**Worth it for:** anyone running their first bot. Cheap to
try. If you outgrow it, upgrade in-place (the existing
subscription's time is forfeited but the contract handles
the migration smoothly).

**Not worth it for:** traders who'll consistently want to
exceed 200 HBAR per bid, or who want multiple bots
simultaneously.

### Silver — two-vector trading

Two slots. Daily caps double (1,500 HBAR, 15,000 LAZY). Per-tx
goes to 500 HBAR.

Pattern this serves:

- **One sniper + one bidder.** Sniper handles auctions
  passively; bidder maintains a resting bid on a collection
  you actively want. Independent budgets.
- **HBAR bot + LAZY bot.** One bidding in HBAR-denominated
  auctions, one bidding LAZY-denominated. Different markets,
  different liquidity.
- **Day-trader + arbitrageur.** One bot for the markets you
  actively trade; one arbitrage bot hunting BCF/LST spreads.

**Worth it for:** traders who want simultaneous strategies
across more than one collection or surface.

**Not worth it for:** anyone who could consolidate into a
single bot. The second slot is wasted if you're only
running one strategy.

### Gold — serious arbitrageur or multi-strategy trader

Three slots. Daily 3,500 HBAR, 35,000 LAZY. Per-tx 1,000 HBAR.

This is the tier where the economics start favoring serious
trading. The 1,000 HBAR per-tx cap covers most non-flagship
auctions. The daily 3,500 HBAR supports ~3-7 acquisitions per
day, plus bidding capacity.

Pattern this serves:

- **Three-vector trader.** Auction sniper + CLOB bidder +
  arbitrageur, each on its own slot.
- **Multi-collection coverage.** Different bots for different
  collection-families you trade.
- **Liquidity-providing arbitrageur.** A bot that places
  standing CLOB bids slightly below LST listing prices, then
  arbitrages when the spread opens.

**Worth it for:** anyone running 3+ bots that each have a
distinct strategy.

**Not worth it for:** traders who don't run multiple bots.
You're paying for 5x the daily of Bronze but getting only 3x
the slots.

### Platinum — institutional / heavy ecosystem participant

Five slots. Daily 10,000 HBAR, 100,000 LAZY. Per-tx 2,500
HBAR.

Pattern this serves:

- **Trading desk operating across the ecosystem.** Snipers
  on every active collection + arbitrageurs across surfaces +
  market-makers placing standing bids.
- **Liquidity provider.** A team running coordinated bots
  that act as marketplace makers, providing standing liquidity
  and arb'ing against external markets.
- **NFT-fund operator.** A treasury that needs multiple
  agents for portfolio management, each with bounded scope.

**Worth it for:** organizations or sophisticated solo traders
who genuinely need 5 simultaneous bots with high daily
budgets.

**Not worth it for:** anyone whose total daily activity fits
in the Silver or Gold cap. The marginal cost over Gold isn't
justified unless you're hitting Gold's caps frequently.

## How to figure out your tier

Rough decision tree:

1. **Are you running any bot at all?** No → Free, done.
2. **Are you running exactly one bot?** Yes → Bronze.
3. **Do you have a clear use case for a second bot?** Yes →
   Silver. If you're "maybe" planning to, start at Bronze
   and upgrade later.
4. **Are you consistently hitting Silver's daily cap of 1,500
   HBAR?** Yes → Gold.
5. **Are you running 4+ bots, or routinely placing single
   bids over 1,000 HBAR?** Yes → Platinum.

The answer to "what tier" should fall out of "what am I
actually doing." Picking a tier higher than your use case is
fine — you're paying for headroom — but it's not Free Money.

## The LSH-holder discount

If you hold an LSH NFT (Gen 1, Mutant, or Gen 2), you get a
one-time discount on subscription purchase. The discount
percentage depends on which collection you hold and which
tier you're buying — see the on-chain discount table.

For LSH Gen 1 holders, the Platinum discount can reach the
combined-discount cap (~90% off purchase price for a year of
Platinum). For Mutant holders, the discount is smaller but
still meaningful. Gen 2 discounts are smallest.

The discount is one-time per (token, serial) per 14-day
cooldown. You can't use the same NFT to discount multiple
subscriptions in a single window — see
[VIPSubscription tier economics](../technical/09-vip-subscription-economics.md)
for the cooldown design.

## When to skip the subscription entirely

A few scenarios where the answer is "don't subscribe":

- **You're not running an agent, full stop.** Free tier is
  perfect.
- **You're an LSH holder running a single agent and the LSH
  free-slot UX rule applies to you.** This is an off-chain
  UX rule, not enforced on-chain — check the frontend for
  whether you qualify.
- **Your bot strategy isn't profitable enough to justify
  subscription cost.** Do the math: subscription_cost_per_day
  vs. expected_bot_profit_per_day. If the bot's edge isn't
  bigger than the sub cost, skip.

## What you DON'T get from a subscription

To be explicit:

- **No trade fee discount.** LSH holdings handle that.
- **No priority access.** All users transact at the same
  network cadence.
- **No exclusive features beyond agent slots.** The
  marketplace surface is the same for everyone.
- **No mainnet alpha access.** When mainnet ships, it ships
  for everyone.

The subscription is exactly what it says it is: agent
authorization budget. Pay for that or don't.

## Practical advice

If you're new to running bots: start with Bronze. The price
is low, the slot count is enough to learn on, and you can
upgrade in-place once you outgrow it.

If you've been running bots elsewhere: estimate your daily
HBAR usage, pick the tier that comfortably covers it with
30-50% headroom.

If you're not sure: start lower than you think and upgrade
when you actually hit the cap. The upgrade-in-place pattern
forfeits the existing subscription's time (intentional design
— see the tier economics post), but the next month's worth
of Platinum is still cheaper than two years' worth of
Bronze.

Talk to me at launch — the subscription prices haven't been
finalized as of this post. The structure (this tier table)
is locked. The dollar prices are still being calibrated
against $LAZY's market.

## Reference

- The tier table is locked in
  [`docs/v0.3-WORKING-PLAN.md`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/docs/v0.3-WORKING-PLAN.md)
  "Locked default tier table."
- The agent envelope mechanics:
  [Agent envelopes — your AI trader, your rules](03-agent-envelopes-plain-english.md).
- Subscription economics deep-dive (for the technically
  curious):
  [VIPSubscription tier economics](../technical/09-vip-subscription-economics.md).
