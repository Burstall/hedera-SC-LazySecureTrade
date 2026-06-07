# Auction anti-snipe math — why the last 10 minutes are different

> **Audience:** Developers building auction primitives, plus
> anyone curious why English auctions on chain look the way
> they do.
> **Read time:** ~7 minutes.
> **Last updated:** 2026-05-27.

A traditional English auction in a physical room has a natural
"going once, going twice, sold" rhythm — the auctioneer pauses
for bids, and bidders sense each other's intent. Online auctions
don't have that. Without intervention, online auctions end in a
sniping war: bidders hold their fire until the last second, hoping
to land a bid the previous high bidder can't react to.

EnglishAuction implements anti-snipe extension as a chain-level
mitigation. This post walks through the math, the trade-offs we
made, and the edge cases we found while testing.

## The mechanism

Each auction has three configurable parameters that govern
sniping:

```solidity
struct AuctionStorage {
    // ... other fields
    uint16 antiSnipeWindow;     // seconds before closeAt
    uint16 antiSnipeExtension;  // seconds to add if a bid lands in the window
    uint64 maxCloseAt;          // ceiling — extensions stop here
}
```

A bid lands. The contract checks:

```solidity
function _maybeExtendCloseAt(AuctionStorage storage a, uint64 nowTs) internal returns (uint64 newCloseAt) {
    uint64 oldCloseAt = a.closeAt;
    if (oldCloseAt - nowTs > a.antiSnipeWindow) return oldCloseAt;   // not in the window
    newCloseAt = nowTs + a.antiSnipeExtension;
    if (a.maxCloseAt != 0 && newCloseAt > a.maxCloseAt) newCloseAt = a.maxCloseAt;
    a.closeAt = newCloseAt;
    emit AuctionExtended(auctionId, newCloseAt);
}
```

In English: if the bid lands within `antiSnipeWindow` seconds
of closing, the close time gets pushed to `now +
antiSnipeExtension`. Capped at `maxCloseAt` so the auction
can't extend forever.

EnglishAuction's defaults:

| Parameter | Default | Rationale |
|---|---|---|
| `antiSnipeWindow` | 600s (10 min) | Long enough that human bidders can react; short enough that auctions feel scheduled |
| `antiSnipeExtension` | 600s (10 min) | Symmetric — every late bid extends by one window |
| `maxCloseAt` | 0 (no cap) | Sellers can set if they care; most don't |

A seller can override at create time per-auction.

## The math, illustrated

Say an auction is scheduled to close at 12:00 PM with a 10-min
window, 10-min extension.

```
11:30 — bid A. Time-to-close: 30 min. Not in window. closeAt stays 12:00.
11:51 — bid B. Time-to-close: 9 min. IN window. Extends to 12:01 (11:51 + 10 min).
11:55 — bid C. Time-to-close: 6 min. IN window. Extends to 12:05.
12:03 — bid D. Time-to-close: 2 min. IN window. Extends to 12:13.
12:13 — no more bids. Auction closes.
```

Each late bid resets the 10-min clock. The auction can't end
until 10 minutes pass without a bid landing.

The behavior is a form of cooperative dynamics — sniping no
longer works because there's no "last second" anymore; whatever
second you bid in, the auction extends. To win, you have to
out-bid in the open, watching for the other side to give up.

## The edge cases that bit us

### "Bid lands exactly at closeAt"

What if the consensus timestamp of the bid is exactly
`closeAt`? Is that "before close" or "after close"?

We resolved it by reading `closeAt` strictly: the auction is
`Open` while `block.timestamp < closeAt`. A bid landing at
`block.timestamp == closeAt` is rejected (`AuctionNotOpen`),
because the auction transitions to `Closed` at that moment.

This is the easy case philosophically — "if you wanted to bid
during the auction, you had to bid before the second the clock
turned." Strict inequality keeps the math clean.

### "Extension lands but the bid is invalid"

Suppose a bidder submits a bid that's the right side of the
clock but the wrong side of the minimum-step requirement
(`newBid < currentHigh + minStep`). The bid is rejected,
because it's not a valid bid — but does it still trigger an
extension?

No. Extension fires only on a *successful* `placeBid`. A
rejected bid leaves `closeAt` unchanged. This was a real
question during the design pass: we considered allowing
invalid-bid-pings to extend (so a hostile bidder couldn't
end the auction by spam-bidding-just-below-min-step). We
decided against it — the gas cost of a rejected bid is the
deterrent.

### "Extension takes the auction past maxCloseAt"

If the seller configured `maxCloseAt` (a hard ceiling), the
extension caps to that value. The auction extends only up to
the ceiling:

```solidity
newCloseAt = nowTs + a.antiSnipeExtension;
if (a.maxCloseAt != 0 && newCloseAt > a.maxCloseAt) {
    newCloseAt = a.maxCloseAt;
}
```

A bid at `maxCloseAt - 1 second` triggers an extension to
`maxCloseAt`, which is just 1 second later. Effectively the
auction is forced to close at the ceiling.

This is intentional — sellers who configure a ceiling are
saying "I won't let this drag past X." It's an escape hatch
for sellers who care about auction-finality timing more than
maximum bid extraction.

### "Buy-now during anti-snipe window"

If a bidder hits `buyNow` (collapsing the auction at the buy-now
price) inside the anti-snipe window, what happens?

`buyNow` collapses the auction immediately to `Closed`, regardless
of the window. The extension logic doesn't apply because the
auction state machine transitions directly: `Open → Closed`,
with the buy-now price as the final settlement price. The
auction doesn't extend; it ends.

This is consistent: extensions are for late bids that *would
have lost* without the extension. Buy-now is a unilateral
"I'm willing to pay the seller's number to end this now,"
which by definition wins the auction without need for further
bidding.

## Why these defaults

The 10-minute window + 10-minute extension came from a few
observations.

1. **Foundation-style auctions (the OpenSea / Foundation
   English auction model) used a 15-minute window/extension.**
   We considered matching but landed on 10 — Hedera's
   sub-second confirmation makes a tighter window feel
   responsive.
2. **Symmetric window and extension is a design choice, not
   a forced one.** You could have a 10-min window and 30-min
   extension (any bid in the last 10 min pushes the close out
   by 30 min). We chose symmetric for predictability:
   "if you can see a bid land, you have at least
   antiSnipeExtension seconds to respond."
3. **No `maxCloseAt` by default.** Most sellers want the
   auction to find its natural close (no bids for 10 min).
   Configuring `maxCloseAt` is opt-in — when you have a
   product-launch tie-in and absolutely cannot let the
   auction extend past 9 PM.

## What it means for bidders

If you're a bidder, the implication is straightforward: there's
no advantage to sniping. Submit your bid when you want to win.
If you bid early, you're committing to that price (subject to
being out-bid). If you bid late, the auction extends to let
the previous high bidder respond.

The optimal strategy is something like: bid your max once,
maybe re-bid if you're outbid, and accept the outcome. Trying
to land a single last-second bid won't work.

This is closer to a sealed-bid auction's truth-revealing
dynamics than a traditional English auction's "wait for the
other shoe." The math says bidders are better off bidding
their true valuation.

## What it means for sellers

If you're a seller, anti-snipe extension is a feature: it makes
your auction's final price reflect *all* the willing bidders'
valuations, not just the one who happens to react fastest.

Practical implications:

- **Schedule auctions with a known close-time floor, not a
  hard ceiling.** "Auction closes around 12:00 PM but might
  extend if there's late activity." Buyers should expect this.
- **Use `maxCloseAt` if you have a product reason to cap.**
  E.g., the auction is tied to a marketing event that ends at
  9 PM; you don't want it extending past 9.
- **Long anti-snipe windows are for high-value auctions.**
  10 minutes is generous; if your auction is for a low-value
  item, consider 60 seconds. (Configurable per auction.)

## The events stream

For indexers, two events matter for anti-snipe analytics:

- `BidPlaced(auctionId, bidder, amount, newCloseAt, ...)` —
  carries the post-extension closeAt
- `AuctionExtended(auctionId, newCloseAt)` — emitted alongside
  `BidPlaced` only when extension actually fires

The dual emission is so indexers can count "how many extensions
fired" without filtering all `BidPlaced` events. A heat-map of
extensions per auction can surface the sniping-war auctions
worth showing in marketing.

## Reference

- The anti-snipe logic is at
  [`contracts/EnglishAuction.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/EnglishAuction.sol).
  Search for `_maybeExtendCloseAt`.
- Tests covering window edge cases are in
  [`test/EnglishAuction.test.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/test/EnglishAuction.test.js).
- The design discussion is in
  [`docs/EnglishAuction-DESIGN.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/docs/EnglishAuction-DESIGN.md)
  — search for "anti-snipe."
