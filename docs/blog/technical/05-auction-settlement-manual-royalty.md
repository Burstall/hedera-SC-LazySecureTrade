# Auction settlement and the manual royalty pull

> **Audience:** Solidity developers building auction primitives
> on Hedera, especially anyone reusing HTS NFTs with custom
> royalty schedules.
> **Read time:** ~9 minutes.
> **Last updated:** 2026-05-27.

The post on [trading without trusting](../user/05-trading-without-trusting-royalties.md)
explained how LazySecureTrade's fixed-price trades use Hedera's
2-step custody hop to let HTS auto-pay royalties. That pattern
relies on the NFT moving *against value* in a single atomic
operation — the value transfer triggers the royalty engine.

Auctions break this assumption. The winning bid lands seconds,
minutes, or hours before the auction settles. By the time
`settle()` runs, the HBAR has been sitting in the contract for a
while; the NFT moves but no fresh value transfer happens.

So how does EnglishAuction pay royalties? Manually.

This post walks through the design.

## The problem

In LST's direct trade:

```
Buyer's wallet                              Marketplace contract
   │                                           │
   │  executeTrade(tradeId)                   │
   │  ─────payable {hbarAmount}──────────►   │
   │                                           │
   │       (cryptoTransfer: NFT + HBAR move atomically)
   │       (HTS royalty engine fires here)
   │                                           │
   │  ◄─────NFT delivered─────                │
```

The HBAR comes in and the NFT goes out in the same atomic call.
HTS sees both legs and applies the royalty schedule.

In EnglishAuction:

```
T=0:  Auction created — items escrow in EA
T=0:  Bidder places bid — HBAR escrows in EA, no NFT movement yet
T=1:  Another bid lands, refunds previous bidder
...
T=N:  closeAt reached
T=N+k: Someone calls settle() — NFT transfers from EA to winner,
       HBAR transfers from EA to seller. BUT — these are independent
       transfers (not a single cryptoTransfer), and the HBAR
       transfer is "from EA's own balance" not "from buyer's wallet."
       HTS doesn't see this as a value-bearing NFT transfer.
       Royalty engine charges the FALLBACK fee instead (e.g., 5 HBAR
       for LSH collections), which would come out of EA's pocket.
```

That fallback would be catastrophic — every auction settle would
cost the contract 5 HBAR in royalty "fines" that the seller never
opted into. The math falls apart.

## The fix: read the schedule, pay manually

EnglishAuction's settlement does what HTS would have done
automatically, but explicitly. The flow:

1. `settle()` is called after `closeAt`.
2. The contract computes:
   - Winner address
   - Final price
   - Protocol fee (1% to platform)
   - Settlement bounty (0.1% to whoever called `settle`)
   - Per-token royalty (read from HTS fee schedule, paid per
     royalty recipient)
3. The contract pays each leg explicitly:
   - Protocol fee → platform's fee receiver
   - Settlement bounty → `msg.sender` (the keeper that called
     settle)
   - Royalty cuts → each royalty recipient on the token's
     schedule
   - Remaining → the seller
4. NFT transfers from EA to winner via `cryptoTransfer` with a
   1-tinybar custody-hop value (the same trick LST uses). This
   transfer is independent of the value transfers above; royalty
   engine sees the 1-tinybar and rounds the royalty calculation
   to zero — no double-charge.

So at settlement, the contract pulls the royalty schedule once,
splits the payment N ways, then moves the NFT in a separate leg
with the custody-hop value to satisfy HTS's "value-bearing"
requirement.

## Reading the fee schedule

HTS exposes the fee schedule via `getTokenInfo(token)`, which
returns a `TokenInfo` struct including a `royaltyFees[]` array.
Each entry has:

- `amount` (uint32) — percentage in fractional units. For a 5%
  royalty, this would encode "5/100".
- `denominator` (uint32) — the divisor for fractional math.
- `fallbackFee` (FixedFee) — the fee charged when the transfer
  ISN'T against value (the case we're avoiding).
- `feeCollectorAccountId` — the recipient.

The auction contract reads this once at settle time:

```solidity
function _readRoyaltySchedule(address token) internal returns (RoyaltyInfo[] memory) {
    (int256 rc, IHederaTokenService.TokenInfo memory info) =
        HederaTokenService.getTokenInfo(token);
    if (rc != HederaResponseCodes.SUCCESS) revert HTSCallFailed(rc, "INFO");
    // ... parse info.royaltyFees into our own struct shape
}
```

The full implementation is in
[`contracts/EnglishAuction.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/EnglishAuction.sol)
under `_payRoyalties` and `_resolveRoyaltySchedule`.

## Caching to save subcalls

`getTokenInfo` is a subcall — and for a bundle auction with up to
10 mixed items, calling it N times eats 10 subcalls just to read
schedules. We cache per-auction:

```solidity
struct AuctionStorage {
    // ... other fields
    RoyaltyInfo[] royalties;   // captured at create time
}
```

The royalty schedule is read at `createAuction` and stored in
the auction's storage struct. At settle time, the contract uses
the cached schedule — no `getTokenInfo` subcall needed.

There's a subtle risk: the token's royalty schedule could change
between create and settle (the token's admin key could update it
via `updateTokenInfo`). For most LSH-style collections that's
not configurable (admin key was burned post-mint), but in
principle the cached schedule could go stale.

We accept this risk for two reasons:

1. Most NFT collections that get auctioned have immutable
   royalty schedules (it's a creator-trust signal).
2. The alternative — reading fresh on settle — eats subcalls and
   exposes a new vector where a malicious admin key rotates the
   schedule mid-auction to drain proceeds.

Caching makes the auction's economic outcome predictable at
listing time. If the creator wants to change royalties, future
auctions reflect the change; in-flight ones don't.

## What happens if the schedule is empty

A token with no royalty schedule (`royaltyFees.length == 0`) is
the easy case. The contract skips the royalty-pay step entirely:
seller gets `finalPrice - protocolFee - settlementBounty`.
Nothing to distribute.

This is also the case for non-NFT items in a bundle (HTS
fungibles included via Tier-C bundle support). FTs don't have
royalty schedules; they're transferred at face value.

## The 1-tinybar custody hop on the NFT leg

Even when the royalty schedule has been paid manually, the NFT
transfer leg still needs a custody-hop value to avoid the
fallback fee. EA's NFT transfer at settle:

```solidity
(int256 rc, ) = HederaTokenService.cryptoTransfer(
    TransferList({transfers: [
        // 1 tinybar from winner to EA (custody hop marker)
        AccountAmount({accountID: winner, amount: -1, isApproval: true}),
        AccountAmount({accountID: address(this), amount: 1, isApproval: false}),
    ]}),
    TokenTransferList[] {[
        // NFT from EA to winner
        TokenTransferList({
            token: token,
            transfers: [],
            nftTransfers: [NftTransfer({sender: address(this), receiver: winner, serialNumber: serial, isApproval: false})]
        })
    ]}
);
```

The 1-tinybar value (with `isApproval=true` on the winner's
side) is enough to trigger HTS's "value-bearing" path. The
royalty schedule's percentage calculation on a 1-tinybar value
rounds to 0. No royalty is paid on this leg — the manual
payment above already covered it. No fallback fee fires either,
because the transfer isn't "valueless."

The winner has to have granted EA an HBAR allowance ≥ 1 tinybar
before settle. EA's frontend does this as a one-time setup; for
stash-mediated wins, the stash auto-grants the allowance to EA
via the same HIP-906 pattern LST uses (see
[`docs/BCF-StashAllowances-DESIGN.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/docs/BCF-StashAllowances-DESIGN.md)).

## Edge cases worth knowing

A few odd situations the design has to handle.

### Multiple royalty recipients

Some HTS collections have multi-recipient royalty schedules
(e.g., 4% to creator, 1% to a charity). The contract loops
through `royalties[]` and pays each recipient. Each payment
is a separate `cryptoTransfer` subcall, so this can eat into
the 50-subcall budget for large schedules. We cap bundle items
at 10 partly to keep this controllable.

### Stuck NFT delivery

If the winner's account is somehow unable to receive the NFT
(e.g., they dissociated the token between bid and settle, or
their account got deleted), the NFT transfer reverts and
`settle()` reverts. The HBAR is still escrowed; the auction
stays in `Closed` state pending another settle attempt.

There's a recovery path: the winner can re-associate the
token, then anyone re-calls `settle`. If the winner is
permanently broken (account deleted), the seller is locked out
of their NFT — a known wart in the design. Future work could
add an admin "force-deliver" path; current contract doesn't.

### Auction-cancel between create and first-bid

Sellers can cancel an auction with no bids. Items are returned
to the seller via the same cryptoTransfer + custody-hop pattern.
No royalty paid (no sale happened).

### Refunds to claimable queues

Losing bidders' refunds don't go directly back to them — they
accumulate in `claimableHbar[bidder]` (or `claimableLazy`).
Bidders call `claim()` to pull them. This is a pull-payment
pattern: each refund avoids the failure mode of a contract
trying to send HBAR to an EOA that can't receive (e.g., a
contract with no `receive()` function), and lets bidders batch
multiple refunds into one claim.

## The full subcall budget for settle

For a single-item HBAR auction with one royalty recipient:

| Step | Subcalls |
|---|---|
| Read auction state (storage) | 0 |
| Protocol fee transfer | 1 |
| Settlement bounty transfer | 1 |
| Royalty payment | 1 |
| Seller payout | 1 |
| NFT transfer (cryptoTransfer with custody hop) | 1 |
| Anti-snipe state cleanup | 0 |
| **Total** | **5** |

For a 10-item bundle with multiple royalty recipients per
token: up to ~30 subcalls. Still well within the 50 ceiling.

## Why this matters for the agent runtime

Auctions create one of the more interesting opportunities for
agents: keepers that watch for closed-but-unsettled auctions
and call `settle` to collect the bounty. EA's
`settlementBountyBps` (default 10 bps = 0.1% of settled
amount) is paid to whoever calls `settle`. For a 1000 HBAR
auction, that's 1 HBAR per settle.

A settlement-keeper agent is a different shape than a
SNIPER. It doesn't need an envelope on a user's stash — it just
needs an account with gas money and a mirror-node subscription
to detect auctions in `Closed` state. See
[`docs/AGENT-RUNTIME-BOOTSTRAP.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/docs/AGENT-RUNTIME-BOOTSTRAP.md)
"Open questions" for the discussion of running keepers alongside
user-facing agents.

## Reference

- The settlement implementation is at
  [`contracts/EnglishAuction.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/EnglishAuction.sol)
  — search for `function settle`.
- The 20/20 acceptance suite is at
  [`test/EnglishAuction.test.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/test/EnglishAuction.test.js).
- The royalty-schedule-caching design rationale is in
  [`docs/EnglishAuction-DESIGN.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/docs/EnglishAuction-DESIGN.md)
  "Pre-implementation probe checklist" item 3 (resolved).
