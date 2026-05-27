# What to expect at mainnet launch

> **Audience:** Anyone planning to use LazySecureTrade when it
> goes live on Hedera mainnet — collectors, traders, creators,
> developers.
> **Read time:** ~6 minutes.
> **Last updated:** 2026-05-27.

LST is currently live on Hedera testnet. The contract stack is
hardened, the test suite is green (~225 tests across 6 suites,
including the comprehensive agent envelope coverage), and we're
in pre-mainnet wind-up.

This post is a "what to expect" guide for the launch — what
will work day one, what's gated, what's outside our timeline,
and what you should set up in advance.

## What's live day one

Three trading surfaces:

- **Direct trades.** List an NFT for a fixed HBAR or $LAZY
  price. Open market (any buyer) or directed (specific buyer).
  Single trades or atomic batches up to 22 items.
- **CLOB bidding.** Place resting bids against NFT collections
  (any serial) or specific serials. Sellers accept; arbitrageurs
  match against listings. Each user has their own stash for
  bid backing.
- **English auctions.** Timed auctions with reserve, buy-now,
  anti-snipe extension, mixed-item bundles up to 10 items.

All three integrate with the same fee tier system tied to LSH
holdings (Gen 1 = 100% discount, Mutant = 75%, Gen 2 = 50%).
A second fee-free path: selling an LSH NFT itself is also
exempt, regardless of the seller's tier. $LAZY-denominated
trades are always fee-free.

## What's behind the subscription gate

Agent envelopes — the feature that lets a wallet authorize a
bot or AI agent to trade on the user's behalf within bounded
budgets — requires a paid subscription. Tier mapping:

| Tier | Slots | Daily HBAR | Daily LAZY |
|---|---|---|---|
| Free | 0 | — | — |
| Bronze | 1 | 500 | 5,000 |
| Silver | 2 | 1,500 | 15,000 |
| Gold | 3 | 3,500 | 35,000 |
| Platinum | 5 | 10,000 | 100,000 |

Subscription prices will be announced near launch. They're
denominated in $LAZY, with discounts for LSH holders and a
prepay discount for buying 12 months upfront.

If you don't run agents, you don't need to subscribe — Free
tier covers all manual trading.

## What you should set up in advance

**Wallet.** HashPack is the most-used Hedera wallet. Blade and
Kabila also work. Hardware-wallet support via HashConnect.

**HBAR balance.** Hedera fees are small (fractions of a cent
typically), but you'll need HBAR for:

- Stash deployment (one-time, ~1.5M gas)
- Token associations (~1M gas each — the marketplace handles
  most of these automatically, but exotic collections might
  ask you to associate manually)
- Trade execution (~3-5M gas per trade)
- HBAR allowance to LST for the 1-tinybar custody hop (one
  grant covers many trades — see [Trading without trusting](05-trading-without-trusting-royalties.md))

Plan for ~10-20 HBAR as headroom for active trading.

**LAZY balance.** Only if you plan to:

- Buy a VIP subscription
- Place LAZY-denominated bids
- Use LAZY for fee-free trades
- Pay the listing fee for open-market trades (LSH holders get this free)

**Token associations.** Most NFT collections you care about
will already be associated to your wallet if you're an existing
Hedera user. New ones get auto-associated when you receive an
NFT for the first time (Hedera handles the association silently
on most wallet-to-wallet transfers from associated parties).

**LSH holdings.** Holding any LSH NFT (Gen 1, Mutant, or Gen 2)
gives you trade-fee discounts AND a one-time discount on
subscription purchase. Worth confirming you're holding what
you think you're holding before launch.

## What's not in scope for launch

Some features we want but aren't shipping in v1:

- **Trait-floor indexer.** Listing the cheapest "rare green
  background" of a collection requires trait-level indexing,
  which is in flight but not part of the contract launch.
- **Cross-collection arbitrage.** Profit-hunting across
  different but related collections (e.g., the same artist's
  output across collections). Possible in theory; not exposed
  in v1 UI.
- **Limit orders that cross protocols.** "Buy any LSH on LST or
  HashAxis under 100 HBAR" — would need cross-marketplace
  bridging that doesn't exist yet.
- **Mobile app.** Web frontend works on mobile browsers via
  HashPack mobile, but a dedicated app isn't in v1 scope.

## What's coming after launch

The roadmap, roughly ordered:

1. **Agent runtime (separate repo, in progress).** A reference
   SNIPER agent that watches auctions and bids inside an
   envelope. Will be open-sourced; users can run their own or
   subscribe to a hosted version.
2. **HCS-10 reasoning topics.** Agents log their reasoning to
   Hedera's consensus service; users can audit "why did my
   bot do that?" via mirror node.
3. **Frontend trait filtering + cross-marketplace floor view.**
   Once the trait indexer ships.
4. **BCF v2 if needed.** The contract upgrade path is
   documented (Strategy A clean cut vs Strategy B absorb).
   Likely not needed in the first year unless a bug forces it.

## How to follow along

The contracts repo is open source: `Burstall/hedera-SC-LazySecureTrade`
on GitHub. The `v0.3` branch is the mainnet candidate; the
working plan (`docs/v0.3-WORKING-PLAN.md`) tracks the live
state.

For traders not interested in the code, the official
LazySecureTrade Twitter / Discord / whatever-channel-of-the-
moment will announce mainnet launch and post the contract
addresses + frontend link.

## Pre-launch checklist (TL;DR)

- [ ] Wallet ready (HashPack or equivalent)
- [ ] At least 10-20 HBAR in your wallet
- [ ] Token associations for collections you care about (most
      auto-handled)
- [ ] LSH holdings confirmed if you want fee discounts
- [ ] $LAZY balance if you plan to subscribe or use $LAZY trades
- [ ] Bookmark the contracts repo for transparency / audit
      curiosity

That's it. The system is built to be approachable; you don't
need a CS degree to use it. The deep technical posts on this
blog are there for builders; users just need a wallet and a
bit of HBAR.

See you at launch.

## Reference

- Live state: [`docs/v0.3-WORKING-PLAN.md`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/docs/v0.3-WORKING-PLAN.md)
- Marketplace overview for newcomers: [What is LazySecureTrade?](01-what-is-lazysecuretrade.md)
- For developers wanting to build on it:
  [Building a SNIPER agent in ~80 lines](../technical/01-building-a-sniper-agent.md)
