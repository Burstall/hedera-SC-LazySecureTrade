# Your stash, explained

> **Audience:** Active traders who want to understand where their
> bid funds live and why.
> **Read time:** ~7 minutes.
> **Last updated:** 2026-05-27.

When you place a resting bid on LazySecureTrade — "I'd pay 50 HBAR
for any serial of collection X, expires next week" — that 50 HBAR
has to live somewhere. Your wallet can't, because Hedera doesn't
have approval-based pull-from-wallet semantics like Ethereum
ERC-20s do.

So you get a vault.

## What a stash is

A **stash** is a tiny smart contract that lives at an address
derived from your wallet. Each user gets exactly one. It's deployed
the first time you want to bid or auction-bid or list NFTs through
the bidding system. The stash holds:

- **HBAR** — backing your bids and paying for auctions.
- **$LAZY** — same, for LAZY-denominated bids.
- **NFTs** — if you list one via the stash, or if you win a bid
  with an NFT inside it.

The stash is **yours**. You're the owner. You can:

- Top it up at any time (just transfer HBAR/LAZY/NFTs to its address).
- Withdraw from it back to your wallet at any time.
- Cancel any bid you placed through it.
- Cancel any trade you listed through it.

What you cannot do: empty other people's stashes. Each stash is
isolated; there's no "admin" address that can drain it. Even the
team that deployed the marketplace can't touch your funds.

## Why a separate contract per user

Three reasons.

**Isolation.** If something goes wrong with the marketplace —
let's say a bug in the factory contract — your funds aren't pooled
with anyone else's. The blast radius of any single failure stays
contained to the user(s) it affected.

**Composability.** Because your stash is itself a contract, it can
*act*. It can list NFTs, place bids, settle auctions, even execute
arbitrage trades. Other addresses (like your agent's wallet) can be
authorized to make these calls on your behalf, with bounded budgets
you set yourself.

**Deterministic address.** Your stash address is computed before
it's deployed. Anyone who knows your wallet address can compute
your stash address without an RPC call — meaning indexers,
notifiers, and analytics can track activity on your stash *the
moment you announce one is coming*, without waiting for the deploy
transaction to land. This is a Hedera-flavored speedup the EVM
world doesn't usually offer.

## How sovereignty works

There are three categories of action your stash supports:

**Normal trades and bids.** These go through the marketplace
contracts. Bids match against listings, listings settle through
royalty-compliant transfer paths, fees apply. Everything you'd
expect.

**Sovereignty paths.** These are the "I'm done, give me my stuff
back" exits. Your stash exposes them as owner-only functions:

- `withdrawHbar(amount)` — pull HBAR out (leaves 1 HBAR floor for
  custody-hop fees so trades still work; use `rescueHbar` to bypass)
- `withdrawLazy(amount)` — pull $LAZY out
- `withdrawNFTs(tokens, serials, hbarAmounts)` — pull NFTs back
- `rescueHbar(to, amount)` — emergency drain to any address
- `rescueLazy(to, amount)` — same, for LAZY
- `rescueNFT(token, serial, to, hbarValue)` — single-NFT escape hatch
- `detachFromFactory()` — irreversibly cut the link to the
  marketplace factory. The stash becomes a pure vault you control;
  no more bid/trade/arb flows can use it.

The rescue paths exist because *should* the marketplace factory ever
turn out to have a bug, you want a single-call escape that doesn't
depend on any factory code. They bypass the "leave 1 HBAR floor"
guard and let you drain everything.

`detachFromFactory()` is the nuclear option. After detaching, your
stash address is no longer recognized by the marketplace — bids,
trades, and arbitrage paths through the factory all fail. But the
stash still works as a vault: you can withdraw, you can rescue, you
just can't trade through it any more. Use this if you're retiring
the stash or migrating to a new generation.

## Topping up the stash

You can transfer HBAR or $LAZY to your stash address from any
account. The stash's `receive()` function accepts HBAR
unconditionally; $LAZY is associated to the stash at deploy time,
so HTS transfers work directly.

Practically:

- **HBAR**: any wallet's `TransferTransaction` with the stash as
  recipient.
- **$LAZY**: same. The stash is HTS-associated to LAZY at deploy.
- **NFTs**: if you want to list an NFT from your stash, you need
  to first transfer the NFT into the stash. Most collections auto-
  associate to the stash on first encounter (the stash inherits a
  helper that handles this).

## What you don't need to do

A few things that aren't required, despite Ethereum habits saying
they would be:

- **No "approve" calls before bidding.** Funds are inside your
  stash already; bids draw from there.
- **No "associate" calls for your own assets.** The stash handles
  HTS association lazily for any token it encounters.
- **No nonces.** Each bid is uniquely identified by a hash of
  `(user, token, serials, stash nonce, timestamp)` that the
  contract computes for you.

## A worked scenario

Let's say you're an active trader. You want to keep 500 HBAR ready
to snipe bids on three collections.

1. **Deploy your stash** (one-time): call `BCF.deployStash()` from
   your wallet. Costs ~1.5M gas, returns the stash address. Or
   pre-compute the address off-chain — it'll match.
2. **Fund it**: send 500 HBAR from your wallet to the stash address.
3. **Place three bids**: from your wallet, call
   `stash.createBid(token, [], hbarAmount, 0, expiry, 0, EMPTY_AUTH)`
   three times — once per collection. The bids reserve funds
   inside the stash; you can't double-spend.
4. **Wait**: bids sit on chain. When a seller has a matching NFT,
   they call `executeAgainstBid(bidId, token, serial)` and the
   trade happens. Your stash gets the NFT; their wallet gets HBAR.
5. **Settle**: when you're done, withdraw any leftover HBAR with
   `withdrawHbar(amount)`. NFTs you won are still in the stash —
   pull them out with `withdrawNFTs(...)`.

The stash is the vault that makes this whole flow possible without
asking your wallet to approve and re-approve every interaction.

## Stash + agents

Here's where it gets interesting. Because the stash is a real
contract you control, you can grant **another wallet** (an agent's
wallet) the right to place bids on your behalf, capped by a budget
you set.

That's the topic of the next post: [Agent envelopes — your AI trader,
your rules](03-agent-envelopes-plain-english.md).
