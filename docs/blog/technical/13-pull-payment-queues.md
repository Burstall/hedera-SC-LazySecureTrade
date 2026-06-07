# Pull-payment queues — why we don't push refunds

> **Audience:** Solidity developers designing systems with
> outbound HBAR or token transfers, especially auction or
> bidding flows with multiple refund paths.
> **Read time:** ~7 minutes.
> **Last updated:** 2026-05-27.

EnglishAuction has a pull-payment model: when a bidder gets
outbid, their refund goes into a queue (`claimableHbar[user]`
or `claimableLazy[user]`) that they have to actively pull from
via `claim()`. The contract never pushes refunds back to the
bidder's wallet.

This is a well-known smart-contract pattern, but the reasons
specific to LST + Hedera are worth documenting. This post
covers why we landed there, what failure modes pull-payment
prevents, and what trade-off we're accepting in exchange.

## The push pattern and its failure modes

The naive auction contract would refund outbid bidders
inline:

```solidity
function placeBid(bytes32 auctionId, uint96 amount) external payable {
    AuctionStorage storage a = auctions[auctionId];
    // ... validate bid ...
    if (a.highBidder != address(0)) {
        // PUSH refund to previous high bidder
        payable(a.highBidder).transfer(a.highBid);    // <-- danger zone
    }
    a.highBidder = msg.sender;
    a.highBid = amount;
}
```

This works for an EOA bidder with a wallet that accepts HBAR
quietly. It breaks for several real cases:

### Failure 1: The previous bidder was a contract without a `receive()`

If `a.highBidder` is a contract that doesn't have a payable
`receive()` or `fallback()`, the `transfer` reverts (transfer
forwards 2300 gas; a contract trying to do anything
non-trivial on receive will out-of-gas). The whole `placeBid`
reverts. **The new bidder can't bid.** The auction is stuck.

### Failure 2: The previous bidder's wallet refuses the transfer

Some custodial wallets or paranoid setups have contract-level
HBAR receive guards. If the receive guard reverts (e.g.,
custom whitelist that doesn't include EA's address), same
result: `placeBid` reverts.

### Failure 3: The previous bidder was deleted or sold

On Hedera, accounts can be deleted (`AccountDeleteTransaction`).
A bidder who deletes their account mid-auction creates an
unrecoverable refund target. Push transfer to a deleted
account reverts.

### Failure 4: Gas griefing

A malicious bidder could deliberately deploy a contract that
consumes max gas on receive (just before reverting). They bid;
they wait for a higher bid; the higher bid's `placeBid` runs
their gas-griefing receive code as part of the refund and runs
out of gas. **Every subsequent bid fails until they're
manually refunded.** Auction grinds to a halt.

Any of these failures DoS the auction. Push refunds make a
single bad actor (or unlucky bidder) able to block all
subsequent bids.

## The pull pattern

EnglishAuction queues refunds in storage:

```solidity
mapping(address => uint256) public claimableHbar;
mapping(address => uint256) public claimableLazy;

function placeBid(bytes32 auctionId, uint96 amount) external payable {
    AuctionStorage storage a = auctions[auctionId];
    // ... validate bid ...
    if (a.highBidder != address(0)) {
        // QUEUE refund — does NOT touch external state
        if (a.payment == PaymentToken.HBAR) {
            claimableHbar[a.highBidder] += a.highBid;
        } else {
            claimableLazy[a.highBidder] += a.highBid;
        }
        emit BidRefundQueued(auctionId, a.highBidder, a.highBid);
    }
    a.highBidder = msg.sender;
    a.highBid = amount;
}

function claim(PaymentToken pt) external nonReentrant {
    uint256 amount;
    if (pt == PaymentToken.HBAR) {
        amount = claimableHbar[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimableHbar[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    } else {
        amount = claimableLazy[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimableLazy[msg.sender] = 0;
        bool ok = IERC20(LAZY_TOKEN).transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
    }
    emit Claimed(msg.sender, pt, amount);
}
```

The refund moves from "outbound transfer in `placeBid`" to
"storage update + later opt-in pull via `claim`." The bidder
asks for their money when they want it; the auction never
blocks waiting for them to receive it.

## What this buys you

**`placeBid` is no longer susceptible to refund-failure DoS.**
A bidder who's a gas-griefing contract, a deleted account, a
paranoid wallet, or anything else — they don't block new bids.
Their refund piles up in the queue.

**Refunds can batch.** A bidder who places 10 bids on the
same auction (incrementing each time) accumulates 9 outbid
refunds in their queue. They can pull all 9 in a single
`claim()` call. Saves them gas; saves us subcalls.

**Refunds survive auction churn.** Even after the auction
settles, the outbid refunds stay queued. The bidder can
claim weeks later if they want.

**Auction events are simpler.** `BidRefundQueued` is a clean
notification; no need to handle "refund failed, what now?"

## What it costs

Three things to accept in trade.

### 1. UX friction — claim is an extra step

Bidders who get outbid don't see their money come back
automatically. They have to remember to call `claim()`. The
frontend should surface this prominently ("You have 50 HBAR
in queued refunds. Claim?") but it's still an explicit user
action.

We accept this because the alternative is auction
unreliability. Better to ask users to click a button than to
ship a contract that occasionally goes silent.

### 2. Storage cost

Each queued refund is one slot per (user, payment-token) pair.
Cleaned up only when the user claims (back to zero, which on
Hedera is just a `SSTORE` of zero — slot stays allocated but
returns to "default" semantics).

For most users this is one or two slots ever. For habitual
bidders who never claim, it could be more. We don't try to
clean up — the slot footprint per user is small and storage
on Hedera isn't rent-priced.

### 3. Stale claims

A user who loses interest in the platform leaves their
refunds queued indefinitely. The contract holds the HBAR
(it was paid in by their original bid). If the user is
truly gone, the HBAR is functionally stranded.

We considered adding a "sweep stale claims to treasury after
N years" path. Decided against it — it would introduce
admin-controlled fund movement that we don't want as part of
the contract surface, and there's no clean "stale" definition
that doesn't risk taking from active users.

## CEI ordering inside `claim`

The `claim` function follows the Checks-Effects-Interactions
pattern strictly:

```solidity
function claim(PaymentToken pt) external nonReentrant {
    // CHECK
    uint256 amount = pt == PaymentToken.HBAR
        ? claimableHbar[msg.sender]
        : claimableLazy[msg.sender];
    if (amount == 0) revert NothingToClaim();

    // EFFECT — clear state BEFORE external call
    if (pt == PaymentToken.HBAR) {
        claimableHbar[msg.sender] = 0;
    } else {
        claimableLazy[msg.sender] = 0;
    }

    // INTERACTION — external call last
    if (pt == PaymentToken.HBAR) {
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    } else {
        if (!IERC20(LAZY_TOKEN).transfer(msg.sender, amount)) revert TransferFailed();
    }
    emit Claimed(msg.sender, pt, amount);
}
```

The clear-then-send order is non-negotiable. Reverse it (send
then clear) and a malicious recipient contract can reenter:

1. EA calls `recipient.receive()` with 50 HBAR.
2. Inside `receive`, recipient calls `claim()` again.
3. EA checks `claimableHbar[msg.sender]` — still 50, because
   we haven't cleared yet.
4. EA sends another 50 HBAR.
5. Repeat until EA's HBAR balance hits zero.

`nonReentrant` would catch this (OpenZeppelin's
`ReentrancyGuard` blocks re-entry into the same modifier
chain), but the CEI ordering removes the attack surface
entirely. Belt + braces.

## Pull-payment in arbitrage too

BCF's arbitrage payout uses the same pattern:

```solidity
mapping(address => uint256) public pendingArbProfit;
mapping(address => uint256) public pendingArbLazyProfit;

function executeArbitrage(...) external nonReentrant {
    // ... compute spread ...
    pendingArbProfit[msg.sender] += arbShare;
    pendingProtocolProfit += protocolShare;
    // No outbound transfer here
}

function claimArbProfit() external nonReentrant {
    uint256 amount = pendingArbProfit[msg.sender];
    if (amount == 0) revert NothingToClaim();
    pendingArbProfit[msg.sender] = 0;
    (bool ok, ) = payable(msg.sender).call{value: amount}("");
    if (!ok) revert TransferFailed();
}
```

Same shape, same reasoning. Arbitrageurs accumulate profit
in the pending queue, claim when they want.

## When push IS correct

Pull payment isn't always right. Some cases where push makes
more sense:

- **Single, known recipient.** If you're paying out to a
  hard-coded address you control (e.g., the protocol fee
  receiver), push is fine. There's no "what if they revert
  on receive" — you wouldn't have coded the contract that
  way.
- **Settlement bounty.** EA's settlement bounty IS pushed
  directly to `msg.sender` (the caller of `settle`). The
  recipient is whoever called settle — they're a willing
  participant in this exact second and have already paid
  gas. If their receive griefs the call, they're the only
  one harmed; everyone else's settlement still works.
- **Royalty payments.** Royalty recipients are paid inline
  during settle. Same logic: if a single royalty recipient
  griefs receive, the settle reverts and everyone in this
  particular auction has to wait. That's painful but bounded
  — it's not the open-bidding scenario where every future
  bidder is blocked.

Pull is for "n+1 random recipients I don't control"; push is
for "specific recipients in specific contexts."

## Reference

- The pull-payment queues live in
  [`contracts/EnglishAuction.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/EnglishAuction.sol).
  Search for `claimableHbar` / `claimableLazy` / `function
  claim`.
- The arbitrage profit queue:
  [`contracts/BidderContractFactory.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/BidderContractFactory.sol).
  Search for `pendingArbProfit` / `claimArbProfit`.
- The CEI pattern is OpenZeppelin's standard guidance; their
  [`ReentrancyGuard`](https://docs.openzeppelin.com/contracts/4.x/api/security#ReentrancyGuard)
  is the inheritance we use.
