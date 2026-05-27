# Trading without trusting — how royalties work on LST

> **Audience:** Creators selling NFTs they collect royalties on,
> and buyers who want to know what they're actually paying for.
> **Read time:** ~6 minutes.
> **Last updated:** 2026-05-27.

There's a Big Question hanging over NFTs in 2026: do royalties
actually get paid?

On Ethereum, the answer is messy. Royalty enforcement is a
marketplace-level convention, not a chain-level guarantee. Big
marketplaces (OpenSea, Blur, X2Y2) have all at various points
made royalties optional, then mandatory, then optional again,
based on whatever competitive pressure was hottest. Creators
ended up writing nasty bytecode blocking transfers to known
royalty-skipping marketplaces. It's a mess.

On Hedera, royalties are baked into the token service. When a
marketplace transfers an NFT in a way that involves value, the
network sees the value transfer and automatically routes the
royalty cut to the configured recipients. You can't disable it
at the marketplace level; the network does it.

That's the elevator pitch. The interesting question is: how does
LazySecureTrade actually trigger Hedera's royalty engine?

## The royalty engine, simplified

Hedera's token service has a thing called **custom fees**.
When you mint an NFT collection, you can attach a royalty fee
schedule that says "every time this NFT moves against value,
take X% (or fixed amount) and route to wallet Y."

The HTS precompile (the EVM-side adapter for HTS) sees every
NFT transfer that goes through it. If the transfer is "against
value" — meaning HBAR or another token is moving in the
opposite direction in the same atomic transaction — the royalty
engine kicks in and takes its cut.

If the transfer is **NOT** against value (the NFT moves but no
value moves), the royalty engine charges a fallback fee that's
configured on the token. For LazySuperheroes NFTs, that
fallback is 5 HBAR — a deterrent against "moving NFTs around
to dodge royalties."

So the marketplace has two options:
1. Move the NFT against value in one atomic operation (royalty
   pays automatically).
2. Move the NFT NOT against value (fallback fee gets charged,
   and that fallback fee is often big enough to defeat the
   whole flow).

LST uses option 1.

## The 2-step custody hop

Here's the elegant bit. When you buy an NFT on LST, the trade
isn't a simple "seller → buyer." It's actually:

```
Step 1: NFT seller → LST contract,  HBAR LST contract → seller
        (full sale price; this is the value-bearing transfer)
        ← royalty engine fires here, pays royalty out of seller's HBAR

Step 2: NFT LST contract → buyer,   HBAR buyer → LST contract (1 tinybar)
        (1 tinybar is the "custody hop" — a token-shaped marker)
```

Step 1 is the actual sale. The seller gets paid (minus royalty);
the marketplace contract receives the NFT temporarily.

Step 2 is the handoff to the buyer. The buyer "pays" 1 tinybar
(0.00000001 HBAR — effectively dust) for the NFT in the
marketplace contract's custody. The reason for this 1-tinybar
custody hop is that HTS won't move an NFT between two contracts
without ANY value transfer; the engine would charge the fallback
fee. The 1 tinybar is enough to convince HTS this is a
value-bearing transfer (it's not zero), so the fallback doesn't
fire — but it's also small enough that the royalty engine's
percentage calculation rounds to zero. No double royalty.

Net effect: seller pays royalty once (on the real sale), buyer
gets the NFT, marketplace is the temporary custodian, royalty
recipient gets their cut, and nobody pays the fallback.

## Why 1 tinybar specifically

A few constraints converged here:

- It has to be > 0 (or the engine charges the fallback).
- It has to be small enough that royalty calculation rounds to
  zero (so we're not double-charging on the custody hop).
- It has to be paid by the eventual receiver (the buyer), via
  HBAR allowance (the buyer pre-approved the marketplace
  contract to pull 1 tinybar at trade time).

Hence "the 1-tinybar custody hop." It's a contract-pattern
artifact rather than a meaningful economic transfer.

If you look at your buyer-side transaction receipt after a
trade, you'll see two HBAR transfers:

- The big one: your full purchase amount, minus the platform
  fee, minus the royalty cut, going to the seller.
- The 1-tinybar one: from your wallet to the marketplace
  contract.

That tinybar is the "I'm willing to accept custody of this
NFT" signal that satisfies the royalty engine.

## What this means in practice

For buyers:

- **You pay the full price you saw.** The platform fee + royalty
  come out of the seller's side; you don't see a separate
  royalty line item. (Two cases where the platform fee is 0%:
  the seller is a 100%-discount LSH Gen 1 holder, OR the NFT
  being sold is itself an LSH Gen 1/Mutant/Gen 2. Both routes
  exempt the trade from platform fees independently.)
- **You need to grant a small HBAR allowance to the marketplace
  contract** so it can pull the 1 tinybar. The frontend
  handles this; HashPack might ask you to approve it the first
  time. Once granted, it's good for as much as you authorized
  (we recommend a generous allowance — 1 HBAR is enough for
  billions of trades).

For sellers:

- **Your sale price includes the royalty.** When you list at
  100 HBAR, you're saying "the buyer pays 100 HBAR." The
  royalty engine takes its slice out of what you would have
  received; you end up with `100 - royalty - platform fee`.
- **You can't disable royalty by listing through LST.** The
  network enforces it. This is intentional, by us and by
  Hedera.

For creators (you minted the collection):

- **Royalty is paid every time.** No marketplace toggle, no
  optional-vs-mandatory. If your collection's royalty schedule
  says 5%, you get 5% on every LST trade.
- **You configure the schedule at mint.** It's part of the HTS
  token creation. You can't change it after-the-fact, which is
  a feature (no creators rugpulling royalty rates upward
  surprise-style).

## Auctions and bids — same idea

The bid system (BCF) and auction system (EnglishAuction) use
the same 2-step custody pattern. When a bid is accepted, the
NFT moves from seller to the bidder's stash via the same
seller→contract→stash flow. The custody hop is still a
1-tinybar pull from the eventual receiver (the stash, in this
case).

Auctions are slightly more complex because the bids escrow in
the contract for a while before settling. EnglishAuction's
`settle()` function does the royalty math manually at
settlement time — the HBAR has been sitting in the contract
since the winning bid landed, but the NFT only moves on settle,
so the royalty engine doesn't auto-fire. Instead the contract
reads the token's HTS fee schedule and pays each royalty
recipient explicitly. Same net effect; just a different code
path because of when the value transfer happens.

## Why this design matters

The Ethereum NFT space watched creator royalties collapse from
~75% enforced to ~10% enforced over 18 months in 2023-2024.
That ratchet was driven by marketplaces competing on
"creator-unfriendly" UX — lower fees mean more trades mean more
volume mean more revenue.

Hedera's design moves the enforcement point from the marketplace
to the network. You can build an LST competitor, but if your
competitor doesn't use the 2-step custody pattern, the network
charges its fallback fee on every trade (5 HBAR for LSH
collections, configurable per-collection). That fallback
deterrent is the chain-level enforcement; marketplace cooperation
is the cooperative path that avoids the deterrent.

Net: LST + HTS + the custody hop is a system where creator
royalties get paid, the marketplace isn't the bottleneck, and
the buyer experience is one tx with a transparent receipt.

That's a meaningful improvement over the Ethereum status quo,
and it's part of why we're building on Hedera.

## Reference

For the technical mechanics:

- [`docs/blog/technical/04-50-subcall-ceiling.md`](../technical/04-50-subcall-ceiling.md)
  covers the subcall budgeting that makes the 2-step pattern
  economical.
- The custody-hop pattern is implemented in
  [`contracts/TokenStakerV2.sol`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/contracts/TokenStakerV2.sol)
  — specifically `moveNFTs` and its `WITHDRAWAL` mode.
- The 1-tinybar value lives at
  `TokenStakerV2.CUSTODY_HOP_TINYBAR = 1`. It's a constant
  because changing it changes nothing useful.
