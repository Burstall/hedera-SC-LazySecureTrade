# BCF storage strategy — hard-delete, swap-pop, and the events as memory

> **Audience:** Solidity developers who care about storage cost,
> indexers, and the trade-offs of "events as the source of truth"
> patterns.
> **Read time:** ~9 minutes.
> **Last updated:** 2026-05-27.

The BidderContractFactory (BCF) is a CLOB-style bid registry —
users post resting bids, sellers accept them, third parties
arbitrage them against LST listings. The interesting design
question for a contract like this is what to do with the bid
record when the bid closes.

Soft-delete (mark as "Cancelled" but keep the struct) was the
v0.2 default. We replaced it with hard-delete (zero the storage)
plus a richer event schema during a v0.3 design pass. This post
walks through why, what changed in the contract, and how
indexers should consume the result.

## The two patterns

**Soft-delete:**

```solidity
function cancelBid(bytes32 bidId) external {
    BidDetails storage bid = bidRegistry[bidId];
    if (bid.status != BidStatus.Active) revert BidNotActive();
    bid.status = BidStatus.Cancelled;   // mark; storage still consumed
    emit BidCancelled(bidId, ...);
}
```

The bid struct stays in `bidRegistry`. Storage cost: ~10-12
slots per bid (depends on `serials[]` length). Cancelled bids
pile up over time.

**Hard-delete:**

```solidity
function cancelBid(bytes32 bidId) external {
    BidDetails storage bid = bidRegistry[bidId];
    if (bid.status != BidStatus.Active) revert BidNotActive();
    address bidUser = bid.user;
    address bidToken = bid.token;
    _closeBid(bidId);   // delete bidRegistry[bidId] + swap-pop discovery arrays
    emit BidCancelled(bidId, bidUser, bidToken, ...);
}
```

The struct gets `delete`'d. All slots — including the dynamic
`serials[]` array — are zeroed and reclaimable. Discovery arrays
(`tokenToBids`, `userToBids`) get the closed bid removed via
O(1) swap-pop. The event carries enough info (`user`, `token`)
that off-chain consumers can find the closed bid by its event
topic without needing to read storage post-close.

## The math for why we switched

For a hypothetical 10,000-bid mainnet over a year:

| Pattern | On-chain state | Reclaimable | Practical impact |
|---|---|---|---|
| Soft-delete | ~38 MB (`BidDetails` × 10k, ~10 slots/bid + dynamic array slots) | Never | Storage trie balloons; mirror node read costs rise; bid-discovery views OOG |
| Hard-delete | Only live bids; ~5-10% of 10k typically | Continuously | Bounded growth; views stay cheap |

The 38 MB number isn't actually a problem for Hedera per se —
state is paid for at write time, not as ongoing rent — but the
read patterns become brittle. `getAllBids()` becomes
unbounded; `getBidsForToken()` returns half-closed bids that
need client-side filtering; discovery arrays grow without
shrinking.

Hard-delete keeps the on-chain footprint bounded by the *live*
trading volume, not the cumulative historical volume. Closed
bids' history lives in the event stream, where it's cheap to
index and free to read.

## The events that carry the history

The event schema has to be rich enough to reconstruct any
closed bid's terminal state, because the storage struct is gone
the moment it closes.

```solidity
event BidCreated(
    bytes32 indexed bidId,
    address indexed user,
    address indexed token,
    BidDetails bid,                       // the full struct
    bytes32 agentKey,                      // 0 for owner-path
    bytes32 reasoningTopicId
);

event BidCancelled(
    bytes32 indexed bidId,
    address indexed user,
    address indexed token,                 // <-- carried so indexers don't need bidRegistry
    bytes32 agentKey,
    bytes32 reasoningTopicId
);

event BidExecuted(
    bytes32 indexed bidId,
    address indexed user,
    address indexed token,
    uint256 serial,                        // the actual serial that matched
    uint256 hbarPaid,                      // the actual amount transferred
    uint256 lazyPaid,
    address counterparty,
    bytes32 agentKey,
    bytes32 reasoningTopicId
);

event BidExpired(
    bytes32 indexed bidId,
    address indexed user,
    address indexed token,
    uint64 expiredAt
);

event ArbitrageExecuted(
    bytes32 indexed bidId,
    bytes32 indexed tradeId,
    address indexed arbitrageur,
    uint256 spread,                        // the captured profit
    uint256 arbProfit,                     // arbitrageur's share
    uint256 protocolProfit,                // protocol's share
    bytes32 agentKey,
    bytes32 reasoningTopicId
);
```

Three things to notice:

1. **`token` is indexed in every event.** Lets indexers query
   "all bid events for this collection" via a topic filter, no
   table scan needed.
2. **`user` is indexed.** Same for "all events for this trader."
3. **The cancellation event echoes `user` + `token` even though
   those were already in the `BidCreated` event.** This is
   intentional duplication — it lets consumers process
   `BidCancelled` without needing to have seen the
   `BidCreated` (e.g., they joined the indexer after the bid
   was already on chain).

The `agentKey` field is also in every event — set to non-zero
when the action came through the agent envelope path, zero for
owner-initiated actions. That's the off-chain correlation to
HCS-10 reasoning topics if the agent published its reasoning
trace.

## Swap-pop discovery arrays

The other half of "keep state bounded" is the discovery arrays:

```solidity
mapping(address => bytes32[]) public tokenToBids;   // all live bids for a collection
mapping(address => bytes32[]) public userToBids;    // all live bids for a user
mapping(bytes32 => uint256) internal _tokenBidIndex; // 1-based index in tokenToBids
mapping(bytes32 => uint256) internal _userBidIndex;  // 1-based index in userToBids
```

When a bid closes, we need to remove it from those arrays. Naive
remove (shift everything after the index down) is O(N).
Swap-pop is O(1):

```solidity
function _removeFromTokenIndex(bytes32 bidId, address token) internal {
    uint256 idx = _tokenBidIndex[bidId];                // 1-based
    if (idx == 0) return;                                // not in array
    uint256 lastIdx = tokenToBids[token].length;
    if (idx != lastIdx) {
        bytes32 lastBid = tokenToBids[token][lastIdx - 1];
        tokenToBids[token][idx - 1] = lastBid;          // overwrite removed slot
        _tokenBidIndex[lastBid] = idx;                  // update last bid's stored index
    }
    tokenToBids[token].pop();                           // shrink array
    delete _tokenBidIndex[bidId];                       // forget the closed bid
}
```

Cost per close: one storage write to the array's removed slot,
one update to the last bid's index pointer, one array `pop()`.
Three SSTOREs in the typical case. Compared to soft-delete
which adds no work to the discovery arrays, hard-delete pays
a small per-close cost. We accept it for the bounded-growth
property.

The 1-based index trick is so `_tokenBidIndex[bidId] == 0`
means "not in array" — distinguishing absence from "stored at
position 0." Avoids the need for a separate `mapping(bytes32
=> bool) inArray`.

## What hard-delete buys you as an indexer

If you're building an event scanner against BCF, hard-delete is
a feature, not a chore.

- **Linear event stream.** Every bid has exactly one
  `BidCreated` and exactly one terminal event (`BidCancelled` /
  `BidExecuted` / `BidExpired`). Process them in mirror-node
  order; the bid's state at any timestamp T is the most-recent
  event up to T.
- **No "is this row stale?" check.** Closed bids don't shadow
  themselves in storage. If you missed an event during a
  scanner outage, you can backfill from mirror logs and
  reconcile; there's no contention with a "soft-deleted but
  visible" storage state.
- **`getBidsForToken(token)` returns only live bids.** No
  client-side filtering needed. The view is bounded by live
  trading volume.

The Directus schema in `docs/DIRECTUS-MIGRATION-v0.3.md` is
shaped around this — `bidderBidsCache` holds only live bids,
`bidderStashEvents` holds the append-only event log, and they
join cleanly without "is this still active?" predicates.

## What it costs

There's a real downside: **reading a closed bid's storage
returns a zeroed struct.** If your contract or off-chain code
expects to be able to call `getBid(bidId)` and get back the
closed bid's terminal state, that's broken. You have to read
the event stream instead.

For most flows that's fine. But two specific cases bit us
during the design pass:

- **Race conditions in arbitrage.** If two arbitrageurs race
  to execute the same bid against the same trade, the second
  one sees `BidStatus.None` (zeroed) on its pre-flight check
  and reverts `BidNotFound` rather than the more semantically
  correct "bid was just executed by someone else." Acceptable
  — the second arb still fails, the second arber loses gas,
  no double-spend possible.
- **Post-mortem analysis.** "What were the terms of bid X
  before it closed?" requires querying the event stream rather
  than calling `getBid`. Front-end UI that wants to show
  closed-bid details has to source from the indexer, not from
  on-chain reads. That's a UI architectural choice the user
  has to make, not a code change.

## The `_closeBid` pivot point

All of the above is centralized in `BCF._closeBid(bytes32
bidId)`. It's the single place a bid transitions from `Active`
to "gone":

```solidity
function _closeBid(bytes32 bidId) internal {
    BidDetails memory snapshot = bidRegistry[bidId];   // memory snapshot for events
    _removeFromTokenIndex(bidId, snapshot.token);
    _removeFromUserIndex(bidId, snapshot.user);
    delete bidRegistry[bidId];                          // hard-delete
}
```

The `memory snapshot` is so the calling code can still read
the bid's terminal state to emit it in the event — the storage
struct is gone by the time the emit happens.

Callers (`cancelBid`, `executeAgainstBid`, `cleanupExpiredBids`,
`executeArbitrage`) call `_closeBid` *after* whatever logic
needs to read the storage, then emit the terminal event from
the local snapshot.

## When you'd want soft-delete

For posterity:

- **If on-chain reads of closed-bid state matter for contract
  logic.** A contract that wanted to enforce "you can't cancel
  an already-cancelled bid" via storage check would need
  storage to remember the closed state. We sidestep this by
  emitting events and relying on `BidStatus.None` as the
  "doesn't exist" sentinel.
- **If you don't have an indexer and can't lean on event logs.**
  Some integrations might not run a scanner; for them, storage
  is the only history. We assume integrations either run their
  own indexer or consume an existing one — which is fair for a
  marketplace-scale system.

## Storage cost numbers

For LST specifically: a bid's storage footprint is

- 1 slot — `user`, `stash`, `serials` length packed (loosely)
- 1 slot — `token`, `hbarAmount` packed
- 1 slot — `lazyAmount`, `expiry` packed
- 1 slot — `stashNonce`, `createdAt`, `minAcceptablePrice`,
  `status` packed
- Plus dynamic `serials[]` — 1 slot per serial, plus the array
  length header

~5 slots for a no-specific-serials bid. ~6+ for bids with
serial filters. At Hedera's storage pricing, that's
fractions-of-a-cent per bid — but multiplied by 10k+ historical
bids it's a real footprint. Hard-delete makes the steady-state
on-chain footprint a function of *live volume*, which on a
healthy marketplace is much smaller than cumulative volume.

## Reference

- BCF's `_closeBid`:
  [`contracts/BidderContractFactory.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/contracts/BidderContractFactory.sol).
  Search for `function _closeBid`.
- The design pivot's historical record:
  [`docs/archive/v0.3-REMAINING-ITEMS.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/docs/archive/v0.3-REMAINING-ITEMS.md)
  "State Build-Up — RESOLVED" section.
- The event-stream schema:
  [`contracts/interfaces/IBidderContractFactory.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/contracts/interfaces/IBidderContractFactory.sol).
- Indexer schema:
  [`docs/DIRECTUS-MIGRATION-v0.3.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/docs/DIRECTUS-MIGRATION-v0.3.md).
