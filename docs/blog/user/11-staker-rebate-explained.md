# The staker rebate — how subscription revenue flows back to LSH stakers

> **Audience:** LSH holders deciding whether to stake, and people
> curious about how the ecosystem closes the loop between
> marketplace activity and token-holder rewards.
> **Read time:** ~7 minutes.
> **Last updated:** 2026-05-27.

When someone pays for a LazySecureTrade subscription, where does
the $LAZY they spent go?

Until v0.3, the answer was: some fraction burned, the rest sits
on LazyGasStation as treasury. Now, with the staker rebate
system live, **a slice of every subscription gets distributed to
LSH holders who are actively staking.** This post walks through
the mechanics in plain English.

## The 3-sink split

Every subscription purchase routes $LAZY across three buckets:

| Slice | Destination | Why |
|---|---|---|
| **Burn** | Permanently removed from supply | Deflationary pressure; long-term value accrual to all LAZY holders |
| **Rebate** | Pool that pays out to active LSH stakers | Rewards the people who lock up their NFTs |
| **Team** | Multisig wallet for operations, LP support, audits | Sustains the protocol |

Each slice is configured as a percentage of the original
subscription amount. The owner can tune the percentages over
time. Initial settings:

- 50% burn
- 10% rebate
- 0% team (held in LGS treasury for now)
- 40% retained on LGS as operational treasury

A 100-LAZY subscription, under these settings, becomes:
- 50 LAZY burned
- 10 LAZY → rebate pool
- 40 LAZY retained on LGS

If the team turns up the rebate or team slice later, the
treasury portion shrinks accordingly.

## How "active staker" is defined

You earn rebate from an epoch if you have an LSH NFT **staked
in LazyNFTStaking during that epoch**, weighted by how long you
were staked.

Two important details:

1. **Time-weighted.** If you stake an NFT on the first day of
   the epoch and unstake on the last day, you get full credit.
   If you stake for only half the epoch, you get half credit.
   The math is per-NFT and pro-rata.
2. **Goes to whoever owns it at epoch close.** If you stake an
   NFT for the first month of a quarter, then transfer the NFT
   to someone else (via withdraw + re-stake under their wallet),
   that someone else inherits the accrued time. They get a
   "free bonus" of your staking time. Good for them; lesson for
   you about transfer timing.

There's also a **minimum stake duration** filter (default 14
days) — if you only staked for a few hours before epoch close,
you don't qualify. Discourages last-second sniping of the
rebate pool.

## The multiplier table

Not all LSH NFTs earn equally. Higher tiers get bigger rebates
per token:

| Token | Units per NFT | Why |
|---|---|---|
| **Gen 1** | 5.0 | Highest-tier prestige |
| **Mutant** | 2.5 | Mid-tier |
| **LSV** (Gen 2 serials 5001-5100) | 2.5 | Special-tagged subset of Gen 2 |
| **Gen 2** (other serials) | 1.0 | Base tier |

If all 100 Gen 1, 100 Mutant, 100 LSV, and 5,000 base Gen 2 NFTs
are staked at maximum, the total "units" in play is:

- Gen 1: 100 × 5 = 500
- Mutant: 100 × 2.5 = 250
- LSV: 100 × 2.5 = 250
- Gen 2: 5,000 × 1 = 5,000
- **Total: 6,000 units**

Your share of the pool = (your units / total units) × pool size.

## A worked example

Quarterly epoch settles. The rebate pool currently holds 6,000
LAZY. (Numbers picked for round math; reality will differ.)

Scenario: Alice has been staking continuously through the whole
quarter. Her stake:
- 2 × Gen 1 = 10 units
- 3 × Gen 2 = 3 units
- Total: 13 units

In this hypothetical universe, total participating units across
all stakers happens to be 600 (10% of the theoretical max — which
is a plausible real-world participation rate).

Alice's share = (13 / 600) × 6,000 LAZY = **130 LAZY** for the
quarter.

If she had Mutants instead of Gen 1, her stake would be
worth 2 × 2.5 + 3 = 8 units instead of 13, and her share
would scale down proportionally.

The actual numbers will vary based on:
- How big the rebate pool grew during the quarter (driven by
  subscription volume × rebate %)
- How many stakers participated (more stakers = smaller per-unit
  share)
- Which tier of NFTs they staked
- How long they stayed staked

## How epochs work

The rebate isn't continuous — it settles in **quarterly epochs**
(roughly; the team may run them ad hoc within the quarter).

The cycle:

1. **Subscription revenue accumulates** in the rebate pool
   contract throughout the quarter.
2. **At epoch close**, the team runs a script that reads
   mirror-node staking events, reconstructs who-staked-what-when,
   computes time-weighted units per user, and publishes a
   **Merkle root** of the per-user allocations on-chain.
3. **You see "Rebate Available"** in the frontend with the
   amount you're owed.
4. **You click claim**, the frontend computes your Merkle
   proof, you submit one transaction, and the LAZY transfers to
   your wallet.

You have **1 year** to claim each epoch's rebate. After 1 year,
unclaimed amounts roll back into the pool for the next epoch's
distribution. So you can ignore the rebate for months and claim
when convenient — it doesn't expire quickly.

## What this means in practice

For LSH holders:

- **Staking now pays in two ways.** Existing LazyNFTStaking
  rewards (the staking contract's normal $LAZY yield) PLUS the
  rebate from subscription revenue.
- **Quality matters.** A Gen 1 NFT is worth 5x a base Gen 2
  for rebate purposes. The tier hierarchy reflected in trade
  fees also reflects in rebate weighting.
- **Stake-and-forget is best.** Long-duration stakes capture
  full credit. Hopping in/out costs you proportional credit.
- **The first few epochs may have small rebates.** The pool
  grows with subscription volume; early epochs have less to
  distribute. As the marketplace matures, the per-epoch rebate
  grows.

For non-stakers:

- **You don't earn rebate.** Holding LSH in your wallet (not
  staked) doesn't qualify. The "active staker" filter is the
  load-bearing definition.
- **The pool still benefits you indirectly.** Burned $LAZY
  reduces supply, which benefits all holders. The rebate
  doesn't take from your bag; it's a separate slice from a
  different pool.

For the protocol:

- **More subscriptions = bigger rebates.** This creates a
  positive feedback loop: stakers earn from marketplace
  activity, which incentivizes them to participate (subscribe
  themselves, recommend the marketplace, etc.).
- **More stakers = more LSH locked up.** Reduces circulating
  LSH supply, supports the LSH floor.

## What you NEED to do

Almost nothing. The team handles:

- Subscription revenue routing (automatic via VIPSubscription)
- Quarterly epoch compute + Merkle root publishing
- Audit JSON publication so anyone can verify the allocations

You handle:

- **Stake your LSH** if you haven't already (in the existing
  LazyNFTStaking contract).
- **Stay staked** through the epochs you want to earn from.
- **Claim your rebate** when the frontend shows you have one
  (within a year of each epoch settling).

The first epoch will settle some time after BCF mainnet
activation. We'll announce the schedule.

## What the team can audit

The off-chain compute is **open-source and audit-able**:

- The script that processes mirror-node events lives at
  `scripts/ops/computeRebateEpoch.js` in the contracts repo.
- The team publishes the **audit JSON** for each epoch
  containing: input parameters, per-user weights, per-user
  allocations, Merkle proofs.
- Anyone can replay the computation independently — read the
  same mirror events, apply the same multiplier table, get the
  same allocations. Disagreements get raised publicly.

This is the trust model: trust the team to publish honestly,
but verify is always possible.

## Where to read more

- Technical deep-dive: [VIPSubscription tier economics](../technical/09-vip-subscription-economics.md)
- Subscription overview: [When is a subscription worth it?](07-when-is-a-subscription-worth-it.md)
- $LAZY token role: [What is $LAZY?](09-what-is-lazy-token.md)
- Design doc: `docs/LazyRebatePool-DESIGN.md` (in-repo)

## Open questions you might have

**Will the multiplier table change?**
Not in v0.3. The multiplier contract is immutable per deploy. If
the product team decides to retune weights later, that requires
a new multiplier contract deploy. Off-chain scripts would need
to be updated to match. Not anticipated in the near term.

**Why is LSV at 2.5 units? Isn't it just Gen 2?**
LSV (serials 5001-5100 of the Gen 2 token) is a special
collectible subset. Treating them as a Mutant-equivalent
acknowledges their rarity within the Gen 2 collection. There's
only 100 of them by design.

**Can the team change the rebate percentage?**
Yes, within bounds. Hard cap is 50% rebate, 50% team. Both
are owner-tunable. Starting at 10% rebate, 0% team. Future
adjustments will be announced.

**What if I stake AFTER the epoch starts?**
You earn time-weighted from the moment you stake until epoch
close, subject to the minimum-stake-duration filter. So staking
1 month into a 3-month epoch gets you ~67% credit for that NFT
in that epoch — minus the duration filter if applicable.

**Can someone game this by staking just before close?**
The minimum-stake-duration filter is the primary defense.
Default 14 days at epoch close. Stake-and-immediately-unstake
strategies fail the filter. Time-weighting also dilutes them
naturally — a 1-day stake in a 90-day epoch is ~1% credit.
