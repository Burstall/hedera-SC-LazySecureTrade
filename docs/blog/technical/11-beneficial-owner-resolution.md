# Beneficial-owner resolution — what stash addresses really represent

> **Audience:** Developers integrating LST or related ecosystems
> (LazyTradeLotto, future agent runtimes). Anyone wondering how
> fee discounts apply to stash-listed trades.
> **Read time:** ~9 minutes.
> **Last updated:** 2026-05-27.

LST has a quiet design problem: when a stash lists an NFT,
LST records the **stash address** as the seller. The stash is
a contract; the contract doesn't hold any LSH NFTs (and
shouldn't); the contract isn't a "user" in any meaningful
sense. But the stash IS the entity that owns the trade.

If LST naively does `getLSHTokenTier(trade.seller)`, the answer
is always `Free` for stash-listed trades. The human owner of
the stash loses their LSH-holder fee discount because the
contract code looked at the wrong address.

That's Bug 3 in the v0.3 design review. The fix — and the
broader concept it surfaces — is **beneficial-owner
resolution**.

## The concept

Beneficial-owner resolution is the function
`_resolveBeneficialOwner(address possiblyStash) → address actualHuman`.

It looks up the input address in `BCF.stashOwnerOf`. If the
address is a known stash, it returns the stash's human owner.
If it's NOT a stash (i.e., an EOA or external contract), it
returns the address unchanged.

```solidity
function _resolveBeneficialOwner(address candidate) internal view returns (address) {
    if (address(bcf) == address(0)) return candidate;            // BCF unset → no resolution
    try IBidderContractFactory(bcf).stashOwnerOf(candidate)
        returns (address owner)
    {
        return owner != address(0) ? owner : candidate;
    } catch {
        return candidate;                                          // BCF reverted → degraded fallback
    }
}
```

Two failure modes are handled gracefully:

1. **BCF unset** — happens at deploy time before `setBcf` runs.
   The function returns the candidate unchanged; the system
   behaves as if no stashes exist.
2. **BCF reverts** — could happen during a v2 migration or if
   BCF is being upgraded. Wrapped in try/catch so a BCF outage
   doesn't brick LST trades. Degraded fallback: candidate
   passes through unchanged.

The degraded path is conservative. If BCF is broken, stash-
listed trades temporarily lose their LSH discount (same as
the pre-fix state). That's acceptable — losing a discount is
"buggy but safe," whereas reverting trade execution would be
"buggy AND broken."

## Where it's called

Three places in the contracts:

### 1. Fee tier calculation (LST)

When LST calculates platform fees:

```solidity
function calculateSellerFeeRate(address seller) public view returns (uint256) {
    // ... base rate check ...
    address effective = _resolveBeneficialOwner(seller);
    uint256 tier = getLSHTokenTier(effective);
    // ... apply discount based on tier ...
}
```

Without the resolution, a Gen-1-holding human listing through
their stash would pay full 1% instead of 0%. With it, the
human's tier is read from the right address.

Note: there's a parallel item-side exemption that fires
independently of the tier check. If the NFT being sold IS
an LSH (Gen 1, Mutant, or Gen 2), the trade is fee-free
regardless of seller tier — `LazySecureTrade.sol:1655-1661`.
Stash-listed LSH items still get the item-side exemption (it's
not affected by beneficial-owner resolution; it keys on
`itemAddress`, not seller). The tier-side fix described in
this post addresses the non-LSH-item, LSH-holder-seller case
where the item-side exemption doesn't apply.

### 2. Self-trade block (LST)

LST forbids self-trades (`msg.sender == trade.seller`). But on
the agent path, msg.sender is the AGENT, not the user. So the
check needs to resolve both sides:

```solidity
address sellerHuman = _resolveBeneficialOwner(trade.seller);
address buyerHuman = _resolveBeneficialOwner(msg.sender);
if (sellerHuman == buyerHuman) revert SellerCannotBeBuyer();
```

If both resolve to the same human (e.g., Alice's stash lists,
Alice's agent buys via Alice's other stash), the trade reverts.
Without resolution, a user could circumvent self-trade by
routing through different stashes — which would let them
manipulate trade history or pump volume.

### 3. Arbitrage self-arb guard (BCF)

`BCF.executeArbitrage` has a 3-condition guard:

```solidity
address bidOwner = _resolveBeneficialOwner(bid.user);
address sellerOwner = _resolveBeneficialOwner(trade.seller);
if (
    effectiveCaller == bidOwner ||
    effectiveCaller == sellerOwner ||
    bidOwner == sellerOwner
) {
    revert SelfTradeBlocked();
}
```

`effectiveCaller` is the BENEFICIAL OWNER of msg.sender (the
arbitrageur), not the literal msg.sender. Without that
resolution, a user could arb their own trade by routing the
call through their stash (msg.sender = stash, beneficial owner
= them).

The three conditions catch all the self-trade-via-arbitrage
permutations:

1. **Caller is the bidder** — Bob created a bid; Bob's own
   account tries to arb it.
2. **Caller is the seller** — Alice listed; Alice's own
   account tries to arb against it.
3. **Bidder == seller** — same human is on both sides of the
   trade (Alice's bid against Alice's listing), arbitrageur
   is a third party.

All three resolve through beneficial-owner to the human level.

## Why this matters for LazyTradeLotto

LazyTradeLotto credits users for trades they participated in.
Pre-v0.3, "user" meant the address on the trade. Post-v0.3,
the address could be a stash — and crediting a stash for a
trade doesn't help the human (stashes don't have a path to
call `rollLotto`).

The fix is a scanner-side beneficial-owner resolution: when
LST emits `TradeCompleted(buyer, seller, ...)`, the
LazyTradeLotto scanner reads `BCF.stashOwnerOf(buyer)` and
`BCF.stashOwnerOf(seller)` and signs eligibility envelopes
addressed to the resolved humans, not the raw addresses.

This is the work documented in `docs/v0.3-OPS-RUNBOOK.md` §3.
The scanner change is required before BCF mainnet activation —
otherwise stash trades produce orphan lotto credits.

The pattern is the same as the on-chain `_resolveBeneficialOwner`:
look up `stashOwnerOf`, fall through to the input address if
not a stash. The implementation just lives off-chain because
the lotto scanner is off-chain.

## What `stashOwnerOf` actually is

The mapping is simple:

```solidity
mapping(address => address) public stashOwnerOf;
```

Populated by `BCF._deployStashFor(user)`:

```solidity
function _deployStashFor(address user) internal returns (address stash) {
    // ... CREATE2 deploy ...
    userToStash[user] = stash;
    stashOwnerOf[stash] = user;
    isValidStash[stash] = true;
    allStashes.push(stash);
    emit StashDeployed(user, stash, msg.sender);
}
```

Bidirectional: `userToStash[human]` gives you the stash;
`stashOwnerOf[stash]` gives you the human. Both are needed.

The mapping is never removed (no `delete stashOwnerOf[stash]`),
even on `detachFromFactory`. Once a stash is registered, the
ownership record persists. This is intentional — if a stash
detached and then someone sent funds to it, the human owner
should still be retrievable for off-chain attribution.

## The cost of cross-cutting concerns

Beneficial-owner resolution is a 1-subcall add to every place
it's called. For LST's `calculateSellerFeeRate`, that's a
~1-subcall overhead per trade. For BCF's `executeArbitrage`,
it's 2 subcalls (bid owner + seller owner). For self-trade
checks, 2 (buyer + seller).

These costs were budgeted against the 50-subcall ceiling. With
the LSH tier check inlined via `LSHTierLib`, the overhead is
absorbed.

If we'd kept the naive (no beneficial-owner) flow, the
contracts would be smaller and faster — but they'd be
semantically wrong on stash flows. The cost is the price of
the right answer.

## What it doesn't do

A few things beneficial-owner resolution explicitly doesn't
solve:

- **It doesn't unify identity across wallets.** If Alice has
  two separate wallets, each with its own stash, those are
  two distinct beneficial owners. The system doesn't try to
  link them. (Doing so would require user-attested mapping,
  which is a UX problem we're not in a hurry to solve.)
- **It doesn't follow contract chains.** If a stash is owned
  by another contract (which would never happen in practice
  but is theoretically possible if someone deploys a "stash
  manager" contract), the resolution returns the manager
  contract, not its ultimate human owner. We don't recurse.
- **It doesn't survive a stash's owner changing.** The
  `stashOwnerOf` mapping is set at deploy and never changed.
  Stashes don't support ownership transfer (a stash + its
  funds are tied to the human who deployed it). If you want
  to move to a new wallet, you deploy a new stash and migrate
  funds out.

## Why a separate factory mapping vs storing the human in the stash

You could imagine storing the owner address ON the stash and
reading it via `IBidderContract(stash).owner()`. That works
too — and the stash DOES expose `owner()` for sovereignty
checks.

So why does BCF maintain its own `stashOwnerOf` mapping?

Three reasons:

1. **Subcall budget.** Reading `stash.owner()` requires the
   stash to exist (i.e., be deployed). The `stashOwnerOf`
   mapping is one storage read on BCF — same cost — but
   returns address(0) for non-stashes instead of reverting.
   Reverts in critical paths cost more (gas-on-revert,
   error decoding overhead).
2. **Pre-deploy resolution.** With deterministic CREATE2
   addresses, you can predict a stash before it exists. If
   lotto attribution tries to resolve a "would-be stash"
   address pre-deploy, calling `.owner()` reverts; reading
   `stashOwnerOf` returns address(0) cleanly. The lotto
   scanner can handle "address resembles a future stash" as
   a separate case from "address is a known stash."
3. **Indexer ergonomics.** A single mapping on BCF is easier
   to enumerate (`getAllStashes()` + iterate) than
   per-contract reads. Indexers can build their own owner
   index from a single source.

The mapping is the cleanest source-of-truth even if other
paths exist.

## Reference

- The `_resolveBeneficialOwner` function lives in both
  [`contracts/LazySecureTrade.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/contracts/LazySecureTrade.sol)
  and
  [`contracts/EnglishAuction.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/contracts/EnglishAuction.sol).
  Both contracts implement the same shape against their own
  `bcf` pointer.
- The `stashOwnerOf` mapping is in
  [`contracts/BidderContractFactory.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/contracts/BidderContractFactory.sol)
  (search for `stashOwnerOf`).
- The original Bug 3 / Bug 4 analysis is in
  [`docs/BCF-StashAllowances-DESIGN.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/docs/BCF-StashAllowances-DESIGN.md)
  "Bug 3: stash-listed trades partially lose LSH fee
  discounts."
- The LazyTradeLotto scanner-side cutover (where this matters
  off-chain) is documented in
  [`docs/v0.3-OPS-RUNBOOK.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/docs/v0.3-OPS-RUNBOOK.md)
  §3.
