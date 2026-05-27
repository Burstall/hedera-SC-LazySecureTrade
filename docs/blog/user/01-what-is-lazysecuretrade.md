# What is LazySecureTrade?

> **Audience:** Anyone curious about trading NFTs on Hedera.
> **Read time:** ~5 minutes.
> **Last updated:** 2026-05-27.

LazySecureTrade (LST) is a marketplace for NFTs that live on Hedera
— specifically the ones minted through Hedera Token Service (HTS).
It does the same job as OpenSea or Magic Eden does on Ethereum
chains, but with two big differences:

1. **It runs on Hedera.** Fees are tiny, settlements are
   sub-second, and the network has no "front-running" the way
   Ethereum does. A trade you submit goes through in the order it
   reached consensus — not whoever bribed the validators harder.
2. **It assumes you might want a robot trading for you.** The
   contracts are wired to let your agents (think: AI bots, sniper
   scripts) act on your behalf inside guardrails you control. We'll
   come back to that.

Most marketplaces glue a single trade type into a single contract.
LST is three trade surfaces stitched into one ecosystem:

## The three surfaces

**Direct trades** are what you'd expect. You list an NFT for a
fixed price; someone buys it. Open market (any buyer) or directed
(only this wallet can buy). You can list one NFT or a batch of up
to 22 in one atomic transaction.

**Bids** flip the direction. Instead of a seller saying "I want X
for this," a buyer says "I'd pay X for any serial of this
collection" — and the bid sits there, ready to match whenever
someone has an NFT they're willing to sell. Each user has their
own little vault contract (we call it a **stash**) holding the
funds backing those bids. The market becomes a real order book.

**Auctions** are timed. You list an NFT (or a bundle of up to 10
items mixing NFTs and tokens), set a duration, optional reserve
price, optional buy-now price. Bidders snipe each other until the
clock runs out. Anti-snipe extension keeps the close window honest
— a last-second bid pushes the deadline so the auction doesn't end
mid-bidding-war.

Each surface uses the same NFT royalty machinery, the same fee
tiers, the same security model. You don't have to learn three
mental models — once you understand one, the others are
variations.

## Fees and discounts

LST charges a small platform fee on each trade — 1% by default,
HBAR-only. Trades paid in $LAZY (the ecosystem token) are
**always** fee-free. That's intentional: $LAZY is the utility
token that ties this ecosystem together, and we want trades
denominated in it to feel like a first-class path.

If you hold an LSH NFT (the LazySuperheroes collection has Gen 1,
Mutant, and Gen 2 series), you get fee discounts on every trade:

| You hold | Fee discount | Effective fee |
|---|---|---|
| Nothing | — | 1% |
| LSH Gen 2 | 50% off | 0.5% |
| LSH Mutant | 75% off | 0.25% |
| LSH Gen 1 | 100% off | 0% |

These discounts apply automatically — you don't have to claim or
opt in. The contract checks your wallet at trade time and rates
you accordingly. Same if you delegated or staked your LSH (we
honor those, not just direct ownership).

There's also a second fee-free path: **if the NFT you're selling
IS an LSH (Gen 1, Mutant, or Gen 2), the trade is fee-free
regardless of your wallet's tier.** The exemption is on the
item, not the seller — anyone selling an LSH NFT pays 0% on
that trade. This is independent of and stacked alongside the
seller-tier discount above.

## Subscriptions (separate from trade fees)

There's also a paid subscription tier — Bronze through Platinum —
that you can buy with $LAZY. **Subscription tier does NOT change
your trade fee discount.** That stays tied to LSH holdings.

What subscriptions unlock is the **agent system**: how many
trading bots you can authorize, what their daily HBAR/LAZY budget
caps are, and how aggressive their per-transaction caps can go.
More on that in [Agent envelopes — your AI trader, your rules](03-agent-envelopes-plain-english.md).

| Tier | Agent slots | Daily HBAR budget |
|---|---|---|
| Free | 0 | — |
| Bronze | 1 | 500 |
| Silver | 2 | 1,500 |
| Gold | 3 | 3,500 |
| Platinum | 5 | 10,000 |

Free users can still trade everything — the only thing they can't
do is delegate trading authority to a bot. If you're not running
an agent, you don't need to subscribe.

## Where it lives today

As of 2026-05-27, LST + the bidding stack + auctions are all live
on **Hedera testnet**. We haven't shipped to mainnet yet — when we
do, every address you see in the SDK or in the docs will get a
mainnet sibling. The test suite is ~225 tests across 6 suites and
green; the architecture has been through a couple of multi-agent
design reviews; we're in the pre-mainnet hardening phase.

You don't need to know any of that to use the marketplace through
the frontend (when it launches). But it might matter to you that
the people building this are not vibe-coding a smart contract for
the hype — there's a working plan, a security model, and a
roadmap.

## What you can do right now

- **Read more.** [Your stash, explained](02-your-stash-explained.md)
  is the next-best post if you want to understand the bid/auction
  side, where your funds actually live.
- **Build something.** [Building a SNIPER agent in 80 lines](../technical/01-building-a-sniper-agent.md)
  walks through the agent integration if you're a developer.
- **Wait for mainnet.** If you're a user, the frontend launches
  when the mainnet deploy is done. Sign up for whatever
  announcement channel we have (Twitter, Discord, your choice of
  the moment) and we'll point you at it.

That's the elevator pitch. The rest of the blog goes deeper on
each piece.
