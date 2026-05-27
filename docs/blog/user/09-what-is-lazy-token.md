# What is $LAZY, and why are LAZY trades fee-free?

> **Audience:** Anyone wondering why $LAZY exists, what it does
> in the ecosystem, and why the marketplace treats it
> differently from HBAR.
> **Read time:** ~6 minutes.
> **Last updated:** 2026-05-27.

If you've spent any time around LazySuperheroes — the NFT
collections, the staking system, the lotto, now the marketplace
— you've seen $LAZY mentioned constantly. It's the utility
token that ties the ecosystem together. But what does it
actually do, and why is the marketplace built so that LAZY
trades are completely fee-free?

## What $LAZY is

$LAZY is an HTS fungible token on Hedera. Standard
ERC-20-equivalent shape (with HTS-native characteristics: each
account has to associate before receiving, no infinite
approvals, network-level transfer tracking).

It launched alongside the LazySuperheroes NFT collections as
the spendable currency of the ecosystem. Not a meme coin, not
a governance token — a utility token with concrete uses.

What you can do with $LAZY:

- **Stake it** for rewards (in the LazyNFTStaking system)
- **Spend it on marketplace trades** (fee-free, more on this
  below)
- **Buy a VIP subscription** (the only fiat-equivalent payment
  path for the subscription gate)
- **Pay listing fees on open-market trades** (waived if you're
  an LSH holder)
- **Bid on auctions denominated in $LAZY** (some auctions are
  HBAR; others are LAZY)
- **Win it in LazyLotto** (the lotto pays out in LAZY)

The token is the spendable layer. HBAR is the network fee
substrate (you always need a bit for transaction costs); $LAZY
is the ecosystem-native value medium.

## The fee-free trade path

LazySecureTrade charges a 1% platform fee on HBAR-denominated
trades (less if you're an LSH holder — see
[What is LazySecureTrade?](01-what-is-lazysecuretrade.md)).

But **$LAZY trades are fee-free.** Always. Regardless of
whether you hold any LSH.

Why? It's a deliberate tokenomic choice. The marketplace's
design treats $LAZY as a first-class trading currency, not
just an "alternative payment" with the same friction as HBAR.
The mechanism:

- HBAR trades: 1% fee, minus tier discount → 0-1% effective
- LAZY trades: 0% fee, period

This means a Gen 1 holder (100% discount) pays the same fee in
HBAR as in LAZY (zero). But a non-LSH holder pays 0% in LAZY
versus 1% in HBAR. The LAZY path is the cheaper trade for
anyone who doesn't have LSH benefits.

## Why fee-free LAZY trades exist

Three reasons.

### 1. Drive $LAZY demand from marketplace activity

The most direct: making LAZY trades fee-free incentivizes
buyers + sellers to use LAZY as the payment medium for NFT
trades. Sellers list in LAZY; buyers acquire LAZY to bid; LAZY
flows through the marketplace.

This creates utility demand for the token. Not speculative
demand (price-pump pressure), but actual transactional demand
(people need LAZY to participate in something they want to
participate in).

For long-term tokenomic health, transactional demand is more
durable than speculation. People who hold LAZY because they
trade with it have a stickier relationship with the token than
people who hold for the chart.

### 2. Match $LAZY's purpose in the ecosystem

The LazySuperheroes ecosystem has multiple LAZY-burning paths:

- **Subscription purchases** burn LAZY at the configured rate
  (currently 50%).
- **Open-market trade listings** charge LAZY (waived for LSH
  holders).
- **Some lotto entries** consume LAZY.

But the marketplace TRADES themselves don't burn LAZY — they
just route it between buyer and seller. The fee-free LAZY
trade path keeps friction low so LAZY can flow as a payment
currency, with the burns happening on the periphery
(subscriptions, listing fees, lotto) rather than on every
trade.

This separation matters. If every LAZY trade burned 1%, the
token would face constant deflationary pressure on the most
common transaction type — discouraging trading. The current
design has LAZY ROUTE freely through trades (no friction) and
BURN at the system entry points (subscription, listing) where
the user is buying access, not exchanging value.

### 3. Strategic positioning vs the broader Hedera NFT market

Most Hedera NFT marketplaces denominate trades in HBAR by
default. Some support LAZY as an option but charge the same
fee structure on both.

LST's fee-free LAZY path is a differentiator. If you're a
collector who holds LAZY (e.g., from staking rewards), you can
trade NFTs on LST with zero platform fee — vs. paying a 1%
fee on competing marketplaces. This is a competitive moat
that's friendly to the ecosystem's existing LAZY holders.

It's also an onboarding pathway: someone who's LAZY-curious
gets a real reason to acquire and use the token (zero-fee
trading) rather than treating it as an abstract speculative
asset.

## What this means in practice

For a buyer or seller on LST:

- **If you have LAZY**, denominate your trade in LAZY. Pay 0%
  fees regardless of LSH status.
- **If you only have HBAR**, denominate in HBAR. Pay 1% (or
  less if you hold LSH).
- **If you hold LSH Gen 1**, the fee difference between HBAR
  and LAZY is moot — both are 0%.
- **For auctions**, the seller chooses the payment token at
  listing. Pick LAZY if you want to capture fee-free
  settlement; pick HBAR for broader buyer pool.

For active traders, the implication is "acquire some LAZY,
use it as a transactional reserve, save on fees." LAZY's
liquidity on Hedera is decent (DEXes + SaucerSwap + Heliswap
all list it), so converting between HBAR and LAZY is
straightforward.

## What you don't pay $LAZY for

Just to be clear about scope:

- **Network gas.** That's HBAR, always. Every transaction
  has an HBAR cost.
- **Royalties on trades.** Royalties are paid in the trade's
  denomination — if you sold an NFT for 100 LAZY, the royalty
  is paid in LAZY from the seller's proceeds; if for 100
  HBAR, it's in HBAR.
- **Listing fees for LSH holders.** LSH holders get free
  open-market listings; non-LSH holders pay the listing fee
  in LAZY.
- **Subscription costs.** Paid in LAZY; non-negotiable.

LAZY is the spendable layer for ecosystem-specific things;
HBAR is for network-level things.

## The bigger picture

$LAZY is meant to be the **functional currency** of the
LazySuperheroes ecosystem — staking, trading, lotto,
subscriptions all denominate in it. The marketplace is a
high-volume use case for the token (every fee-free trade is a
LAZY transfer), which keeps the token transactionally
relevant rather than just held-for-speculation.

The fee-free trade path is the marketplace's contribution to
that ecosystem fit. Other Hedera marketplaces will charge
platform fees on every payment token; LST treats LAZY
specially because LAZY is special to this ecosystem.

If you're new to LazySuperheroes, the easiest way to
understand $LAZY's role is to think of it as the "credits"
inside the ecosystem. HBAR pays the network; LAZY pays for
the things the ecosystem itself offers.

## Where to acquire $LAZY

The token is listed on Hedera DEXes — SaucerSwap is the most
liquid pair. You can also earn LAZY by staking eligible NFTs
in the LazyNFTStaking system, or win it from LazyLotto.

The marketplace doesn't gate any of this — anyone can acquire
LAZY through normal market channels and use it on LST.

## Reference

- The fee-free LAZY trade path is documented as a "convention"
  in
  [`CLAUDE.md`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/CLAUDE.md):
  "Never introduce $LAZY fees on LAZY-denominated trades —
  it's a deliberate tokenomics choice."
- The LSH-holder listing-fee waiver and the LSH tier discounts
  on HBAR trades are documented at
  [What is LazySecureTrade?](01-what-is-lazysecuretrade.md).
- $LAZY's role in subscriptions:
  [VIPSubscription tier economics](../technical/09-vip-subscription-economics.md).
