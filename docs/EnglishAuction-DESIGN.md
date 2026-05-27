# EnglishAuction — Contract Design Doc

> **✅ IMPLEMENTED** (2026-05-27). Live at `contracts/EnglishAuction.sol`
> (testnet: `0.0.9052454`). The auction lifecycle, anti-snipe extension,
> bundle support (up to 10 mixed NFT+FT items), buy-now collapse,
> reserve price, manual royalty payment, beneficial-owner resolution,
> pull-payment queues, and 48h timelock on high-blast-radius admin
> functions all match this design. See `test/EnglishAuction.test.js`
> for the 20/20 acceptance suite.

**Status:** ✅ Implemented (was: pre-implementation design).
**Companion to:** `docs/AGENT-MARKETPLACE-DELTA.md` (decision context), `docs/LSHTierLib-DESIGN.md` (trade-fee tier), `docs/VIPSubscription-DESIGN.md` (paid tier).
**Target release:** v0.3.x shipped.

---

## Purpose

A timed English-auction primitive for HTS NFTs on Hedera. Distinct from `BidderContractFactory` (which is a CLOB for standing bids, not a timed auction). Required for the design's "Auctions" tab — close time, min-step bidding, automatic settlement, anti-snipe extension.

The CLOB model in BCF answers "I want to buy any of these for X." English auction answers "everyone bid for this one specific NFT until close time; highest bid wins."

Reuses the same `TokenStakerV2` 2-step transfer pattern as LST/BCF for Hedera royalty compliance.

---

## Auction lifecycle

```
                  ┌────────────────────────────────────────────┐
                  │              CREATED (storage)              │
                  └─────────────────┬──────────────────────────┘
                                    │ createAuction(...)
                                    │
                                    ▼
                  ┌────────────────────────────────────────────┐
                  │  OPEN — accepting bids until closeAt       │
                  └─────────────────┬──────────────────────────┘
                                    │
                  bidder calls placeBid(amount)
                  - amount ≥ currentHigh + minStep (or ≥ reserve if first)
                  - escrows funds (HBAR or LAZY)
                  - refunds previous high bidder
                  - emits BidPlaced
                  - if within antiSnipeWindow → extends closeAt
                                    │
                                    │ block.timestamp >= closeAt
                                    │
                                    ▼
                  ┌────────────────────────────────────────────┐
                  │              CLOSED                         │
                  └─────────────────┬──────────────────────────┘
                                    │
                    anyone calls settle(auctionId)
                                    │
                    ┌───────────────┴──────────────┐
                    │                               │
                  RESERVE MET                  RESERVE NOT MET
                    │                               │
                    ▼                               ▼
        Transfer NFT to winner            Refund highBidder
        Pay seller (minus fee)            Return NFT to seller
        Pay protocol fee                  Emit AuctionFailed
        Pay royalty
        Mark SETTLED                      Mark SETTLED (failed)
```

States: `None` / `Open` / `Settled` / `Failed`. Failed = closed but reserve not met. Settled = closed and resolved (winner paid, NFT delivered, OR refunded if failed).

Seller may NOT cancel an auction once a bid is placed (standard English auction property). May cancel only if zero bids.

---

## Storage layout

```solidity
enum AuctionState { None, Open, Settled, Failed }
enum PaymentToken { HBAR, LAZY }

struct Auction {
    address seller;
    address token;           // HTS NFT token address
    uint256 serial;
    PaymentToken payment;
    uint128 reservePrice;    // in tinybar (HBAR) or smallest LAZY unit
    uint128 startPrice;      // first bid must be ≥ this
    uint64  closeAt;         // unix; extended by anti-snipe
    uint64  originalCloseAt; // for fee/audit; never changes
    uint16  minStepBps;      // each bid must beat prior by this fraction (e.g. 200 = 2%)
    uint32  antiSnipeWindow; // seconds before close; bids within this window extend
    uint32  antiSnipeExtension; // seconds added on snipe
    uint128 highBid;         // current high bid amount
    address highBidder;      // current high bidder
    AuctionState state;
}

// State:
mapping(bytes32 auctionId => Auction) public auctions;
mapping(address user => uint256) public claimableHbar;   // refund queue (HBAR)
mapping(address user => uint256) public claimableLazy;   // refund queue (LAZY)

// Config (owner-tunable):
uint16 public protocolFeeBpsBase;        // e.g. 100 = 1% (matches LST base)
uint128 public minReservePrice;          // dust floor, e.g. 1000 tinybar
uint32 public minDuration;               // e.g. 600 = 10 minutes
uint32 public maxDuration;               // e.g. 30 days
uint16 public defaultMinStepBps;         // e.g. 200 = 2%
uint32 public defaultAntiSnipeWindow;    // e.g. 300 = 5 minutes
uint32 public defaultAntiSnipeExtension; // e.g. 600 = 10 minutes
uint16 public settlementBountyBps;       // e.g. 25 = 0.25% — to whoever calls settle

// Immutables:
address public immutable LAZY_TOKEN;
address public immutable LAZY_GAS_STATION;
address public immutable LSH_GEN1;
address public immutable LSH_MUTANT;
address public immutable LSH_GEN2;
address public immutable LAZY_DELEGATE_REGISTRY;
address public immutable LAZY_NFT_STAKING;
address public vipSubscription;          // optional, owner-tunable post-deploy
```

Estimated bytecode: **~10-14 KiB** — substantive contract with auction flow + bid escrow + refund queue + settlement. Verify with `hardhat-contract-sizer`.

Auction ID generation: `keccak256(seller, token, serial, nonce)` where `nonce` increments per-seller. Allows the same seller to re-auction the same serial after a prior auction settles.

---

## Interface

### Seller-facing

```solidity
/// @notice Create an auction for an NFT you own.
/// Caller must have approved this contract for the NFT (NFT escrows immediately).
/// Caller must have approved HBAR allowance for the 1-tinybar custody hop.
function createAuction(
    address token,
    uint256 serial,
    PaymentToken payment,
    uint128 reservePrice,
    uint128 startPrice,
    uint64  duration,           // seconds from now; bounded by min/max
    uint16  minStepBps,         // 0 = use default
    uint32  antiSnipeWindow,    // 0 = use default
    uint32  antiSnipeExtension  // 0 = use default
) external returns (bytes32 auctionId);

/// @notice Cancel an auction. Only seller, only if zero bids placed.
function cancelAuction(bytes32 auctionId) external;
```

Subcall cost for `createAuction`: HTS NFT transfer in (4-6) + tier read (1-7 from library) + writes = ~5-13 subcalls. Comfortable.

### Bidder-facing

```solidity
/// @notice Place a bid on an open auction.
/// For HBAR auctions, send msg.value == amount.
/// For LAZY auctions, msg.sender must have approved this contract for LAZY.
function placeBid(bytes32 auctionId, uint128 amount) external payable;
```

Bid validation:
1. Auction is `Open` and `block.timestamp < closeAt`
2. `amount >= startPrice` (if first bid) OR `amount >= highBid + (highBid * minStepBps / 10000)`
3. Bidder is not the seller
4. For HBAR: `msg.value == amount`; for LAZY: `msg.value == 0`

If valid:
- Move previous high bidder's escrowed funds to `claimable*` queue (pull-payment refund)
- Update `highBid` and `highBidder`
- If `block.timestamp >= closeAt - antiSnipeWindow`: extend `closeAt += antiSnipeExtension`
- Emit `BidPlaced` and (if snipe) `AuctionExtended`

Subcall cost for HBAR bid: ~2-3 (escrow + maybe LAZY claimable update). For LAZY bid: ~3-4 (transferFrom + escrow logic).

### Anyone-callable

```solidity
/// @notice Settle a closed auction. Anyone can call.
/// Caller receives settlementBountyBps of the final price as gas reimbursement.
function settle(bytes32 auctionId) external;

/// @notice Pull any HBAR refunds owed to the caller.
function claimHbar() external returns (uint256);

/// @notice Pull any LAZY refunds owed to the caller.
function claimLazy() external returns (uint256);
```

### Views

```solidity
function getAuction(bytes32 auctionId) external view returns (Auction memory);
function isOpen(bytes32 auctionId) external view returns (bool);
function timeRemaining(bytes32 auctionId) external view returns (uint256);
function minimumNextBid(bytes32 auctionId) external view returns (uint128);
function getActiveAuctionsForToken(address token, uint256 offset, uint256 limit)
    external view returns (bytes32[] memory);
```

### Admin (onlyOwner)

```solidity
function setProtocolFeeBps(uint16 bps) external;
function setMinReservePrice(uint128 price) external;
function setMinDuration(uint32 seconds_) external;
function setMaxDuration(uint32 seconds_) external;
function setDefaultMinStepBps(uint16 bps) external;
function setDefaultAntiSnipeWindow(uint32 seconds_) external;
function setDefaultAntiSnipeExtension(uint32 seconds_) external;
function setSettlementBountyBps(uint16 bps) external;
function setVIPSubscription(address vip) external;  // 0 = disable VIP integration
```

### Events

```solidity
event AuctionCreated(
    bytes32 indexed auctionId,
    address indexed seller,
    address indexed token,
    uint256 serial,
    PaymentToken payment,
    uint128 reservePrice,
    uint128 startPrice,
    uint64 closeAt
);
event BidPlaced(
    bytes32 indexed auctionId,
    address indexed bidder,
    uint128 amount,
    uint128 previousHigh,
    address previousBidder
);
event AuctionExtended(bytes32 indexed auctionId, uint64 newCloseAt, uint32 by);
event AuctionSettled(
    bytes32 indexed auctionId,
    address indexed winner,
    uint128 winningBid,
    uint128 protocolFee,
    uint128 royaltyPaid,
    uint128 sellerProceeds,
    address indexed settler,
    uint128 settlementBounty
);
event AuctionFailed(bytes32 indexed auctionId, uint128 highBid, address highBidder);
event AuctionCancelled(bytes32 indexed auctionId);
event RefundClaimed(address indexed user, PaymentToken payment, uint256 amount);
```

### Custom errors

```solidity
error AuctionNotOpen(bytes32 auctionId, AuctionState currentState);
error AuctionAlreadyClosed(bytes32 auctionId, uint64 closeAt, uint64 nowTs);
error AuctionStillOpen(bytes32 auctionId, uint64 closeAt);
error BidBelowMinimum(uint128 attempted, uint128 minimum);
error BidderIsSeller();
error SellerNotOwner(address token, uint256 serial, address actualOwner);
error WrongPaymentValue(uint256 sent, uint128 expected);
error NoRefundOwed();
error CannotCancelWithBids();
error NotSeller();
error DurationOutOfBounds(uint64 duration, uint32 min, uint32 max);
error InvalidReservePrice(uint128 reserve, uint128 minReserve);
error InvalidConfigBps(uint16 bps);
```

---

## Settlement flow

Walkthrough of `settle(auctionId)` on a successful HBAR auction at 100 HBAR with Platinum-tier seller:

```
1. Validation
   - Auction is Open and block.timestamp >= closeAt
   - Mark state = Settled BEFORE external calls (checks-effects-interactions)

2. Reserve check
   - if highBid < reservePrice OR highBid == 0:
       - Refund highBidder (push to claimable queue)
       - Return NFT to seller (HTS 2-step transfer)
       - State = Failed
       - Emit AuctionFailed
       - return

3. Tier resolution
   - sellerTier = LSHTierLib.getTierFor(seller, sources)  // 1-7 subcalls
   - if vipSubscription != address(0):
       subTier = vip.getTierFor(seller)                    // +1 subcall
       sellerTier = max(sellerTier, subTier)
   - feeBps = _feeBpsForTier(sellerTier)
       Platinum → 0 bps (100% off base fee)
       Gold     → 25 bps (75% off base, base=100bps)
       Silver   → 50 bps (50% off base)
       Bronze   → 75 bps (25% off base) — VIPSubscription-only
       Free     → 100 bps (base 1%)

4. Fee + bounty math
   - protocolFee = highBid * feeBps / 10000
   - settlementBounty = highBid * settlementBountyBps / 10000
   - royalty = computeRoyalty(token, serial, highBid)  // future: from HTS royalty fee schedule
   - sellerProceeds = highBid - protocolFee - settlementBounty - royalty

5. Distribute funds
   - HBAR path:
       - Address.sendValue(msg.sender, settlementBounty)     // gas-reimbursement
       - Address.sendValue(royaltyCollector, royalty)        // creator royalty
       - Address.sendValue(seller, sellerProceeds)
       - Protocol fee stays in contract (treasury withdraw is separate)
   - LAZY path:
       - HTS transferFrom this → msg.sender (bounty)
       - HTS transferFrom this → royaltyCollector
       - HTS transferFrom this → seller

6. Transfer NFT
   - TokenStakerV2.moveNFT(token, serial, winner)  // 2-step transfer for royalty compliance

7. Emit AuctionSettled with full breakdown
```

**Subcall budget for HBAR settlement (Free-tier seller, no VIP):**
- Tier resolution: ~7 (worst case for no-LSH user)
- HBAR sends: 3 (bounty + royalty + seller)
- NFT transfer: 4-6
- **Total: ~14-16 subcalls** — within budget. Acceptable for one-off settlement.

For Platinum/Gen 1 seller: 1 + 3 + 4-6 = 8-10 subcalls. Plenty of headroom.

---

## Anti-snipe mechanic

Standard "Foundation-style" extension:
- `antiSnipeWindow` (default 5 min): if a bid lands within this window of `closeAt`, extend `closeAt += antiSnipeExtension`
- `antiSnipeExtension` (default 10 min): how much to extend by

Worked example with 5-min window, 10-min extension:
- Auction created with `closeAt = T`
- Bid at T - 4 min → close extends to T + 6 min
- Bid at T + 5 min (within new 5-min window of T + 6) → close extends to T + 15 min
- No bid in last 5 min → auction closes at T + 15 min
- `settle` callable from T + 15 min onward

`originalCloseAt` is preserved in storage for audit/fee purposes; never modified. Only `closeAt` extends.

Bounds: extensions are uncapped per auction (could theoretically run indefinitely if bids keep coming, but practically the bid increments and reserve price create economic friction).

---

## Refund model: pull-payment

When a new high bid arrives, the prior high bidder's escrowed funds go into a `claimable*` mapping rather than being pushed back immediately. Two reasons:

1. **Reentrancy safety** — pushing HBAR to an arbitrary `previousBidder` address could re-enter via a fallback function. Pull-payment is the standard mitigation.
2. **Subcall budget** — pushing HBAR is a subcall; if previousBidder is a contract that has logic in its fallback, it could blow up subcall count. Pull-payment defers all that to the user's own claim call.

Users call `claimHbar()` or `claimLazy()` when convenient. Frontend can subscribe to events to surface "you have pending refunds" prompts.

---

## Tier resolution + VIPSubscription integration

Same architectural pattern as LST v2 and BCF settlement:

```solidity
function _resolveSellerFeeTier(address seller) internal view returns (LSHTierLib.Tier) {
    LSHTierLib.Tier holdingsTier = LSHTierLib.getTierFor(seller, _tierSources());

    if (vipSubscription != address(0)) {
        IVIPSubscription.Tier subTier = IVIPSubscription(vipSubscription).getTierFor(seller);
        // Translate VIP tier to LSH tier comparison
        return _maxTier(holdingsTier, _vipToLshTier(subTier));
    }

    return holdingsTier;
}
```

If VIP integration is enabled (`vipSubscription != address(0)`), a paid Bronze subscriber with no LSH gets Bronze-equivalent trade fees (rough mapping: Bronze ≈ Silver, Silver ≈ Silver, Gold ≈ Gold, Platinum ≈ Platinum — needs product confirmation).

If disabled, auction fees are holdings-only. Owner-tunable post-deploy via `setVIPSubscription(address)`.

---

## Stash integration — agent-initiated bidding (SNIPER)

For the SNIPER agent UX, BCF stashes need to place bids autonomously. Pattern:

```solidity
// In BidderContract (the stash):
function placeBidViaAuction(bytes32 auctionId, uint128 amount) external {
    // Caller is the factory or an agent-routed call (existing access control)
    // Stash holds HBAR/LAZY, escrows via auction contract
    EnglishAuction(payable(auctionAddress)).placeBid{value: amount}(auctionId, amount);
}
```

When the stash wins, the NFT settles into the stash address (because the stash placed the bid → stash is `highBidder`). Stash sovereignty paths (`rescueNFT`, `rescueHbar`) work as expected for any winnings.

Tier resolution for stash-as-bidder: bids don't trigger seller-side fee discount logic, so the stash's tier doesn't matter at bid time. At settlement, only the seller's tier matters.

For agent-initiated bids, the per-agent budget envelope work (BCF stash extension) gates the amount the stash can commit.

---

## Settlement bounty

`settlementBountyBps` (default suggested 25 = 0.25%) is paid to whoever calls `settle()`. Two purposes:

1. **Gas reimbursement** — settling a successful HBAR auction is 14-16 subcalls + gas; without incentive, no one calls it and auctions stall.
2. **Keeper market** — anyone running a bot can sweep settled auctions for profit. Decentralizes the settlement step.

Trade-off: takes a small bite out of seller proceeds. At 25 bps on a 100 HBAR auction = 0.25 HBAR (~$0.30 at current rates). Acceptable cost for guaranteed timely settlement.

Owner-tunable. Setting to 0 disables the bounty (sellers / buyers can settle themselves; no keeper market).

---

## Integration with consumer contracts

### Agentic-layer SNIPER bot

Reads auctions via mirror node, computes bid strategy off-chain, calls `BidderContract.placeBidViaAuction` (or equivalent) to bid through the user's stash. The stash's per-agent envelope (when shipped) caps the amount.

### Frontend "Auctions" tab

Reads via mirror:
- `getActiveAuctionsForToken(token, offset, limit)` for lists
- `getAuction(auctionId)` for detail view
- Subscribe to `BidPlaced` / `AuctionExtended` events for real-time updates
- Subscribe to `RefundClaimed` to notify users of pending claimables

### LST/BCF — no integration needed

Auctions are independent of LST trades and BCF bids. The three live as parallel market types.

---

## Test plan outline

Following `feedback_test_methodology.md` (typed-error assertions, mirror-first reads, MIRROR_DELAY sleeps after writes, .env reuse, explicit Clean-up describe):

- **Auction creation:**
  - Valid HBAR auction with all defaults
  - Valid LAZY auction
  - Reject: duration < minDuration → `DurationOutOfBounds`
  - Reject: duration > maxDuration → `DurationOutOfBounds`
  - Reject: reserve < minReservePrice → `InvalidReservePrice`
  - Reject: seller doesn't own NFT → `SellerNotOwner`
  - NFT escrows into contract; verify via `checkNFTOwnership` on mirror

- **Bid placement:**
  - First bid ≥ startPrice succeeds; emits `BidPlaced`
  - First bid < startPrice → `BidBelowMinimum`
  - Subsequent bid ≥ highBid + step succeeds; previous bidder refunded (claimable)
  - Subsequent bid < highBid + step → `BidBelowMinimum`
  - Bid after closeAt → `AuctionAlreadyClosed`
  - Seller bidding own auction → `BidderIsSeller`
  - HBAR auction with msg.value != amount → `WrongPaymentValue`
  - LAZY auction with msg.value > 0 → `WrongPaymentValue`

- **Anti-snipe:**
  - Bid outside window → no extension
  - Bid inside window → close extends; emits `AuctionExtended`
  - Multiple snipes in sequence → close keeps extending

- **Settlement happy path:**
  - HBAR auction → winner gets NFT, seller gets proceeds, royalty paid, fee retained, bounty paid to settler
  - LAZY auction → same with LAZY routing
  - Verify all amounts add up to highBid
  - Emits `AuctionSettled` with full breakdown
  - Verify NFT moved to winner via mirror

- **Settlement failure (reserve not met):**
  - Auction closes with bid < reserve → refund to highBidder (claimable), NFT back to seller
  - Emits `AuctionFailed`
  - Verify NFT returned via mirror

- **Refund queue:**
  - Outbid bidder accumulates claimable balance
  - `claimHbar()` empties the balance; emits `RefundClaimed`
  - `claimLazy()` similarly
  - Calling claim with 0 balance → `NoRefundOwed`

- **Cancellation:**
  - Seller cancels auction with zero bids → succeeds, NFT returned
  - Non-seller cancels → `NotSeller`
  - Seller cancels auction with bids → `CannotCancelWithBids`

- **Tier resolution at settlement:**
  - Platinum seller pays 0 fee
  - Gold seller pays reduced fee
  - Free seller pays base fee
  - With VIPSubscription enabled, paid Bronze seller pays Bronze-equivalent
  - With VIPSubscription disabled (address(0)), only holdings count

- **Subcall budget verification:**
  - Empirically measure subcalls for `settle()` on success: target ≤ 16
  - For Platinum seller: target ≤ 10
  - For `placeBid` HBAR: target ≤ 4
  - For `createAuction`: target ≤ 13

- **Settlement bounty:**
  - Third party calls `settle()` → receives bounty
  - Verify bounty deducted from seller proceeds

- **Stash integration (if BCF agent-bidding shipped):**
  - Stash places bid via factory-mediated path → bid registered
  - Stash wins → NFT transferred to stash address
  - Verify ownership via mirror

All tests use `expectRevertNamed(result, 'ErrorName')` for negative cases. All state-changing calls followed by `MIRROR_DELAY` sleep before mirror read-back.

---

## Pre-implementation probe checklist

- [ ] Compile stub `EnglishAuction.sol` → measure bytecode. Confirms ~10-14 KiB estimate. Headroom for the audit phase additions.
- [ ] Test `Address.sendValue` reliability for refund payments on Hedera (vs `transfer` / low-level call). Pick the safest pattern.
- [ ] Verify HTS royalty handling: does the 2-step transfer in TokenStakerV2 trigger royalty fee schedule automatically, or do we need to compute + pay it manually like LST does? Affects step 4 of settlement flow.
- [ ] Confirm anti-snipe extension storage update is cheap (single SSTORE), not a full storage rewrite. Otherwise sniped auctions become gas-expensive.

---

## Open implementation questions

1. **Hidden vs visible reserve.** Auction houses (Sotheby's etc.) often hide reserves to encourage early bidding. Easy enough to make reserve private (only seller + contract know) but requires sealed-bid commitment for fairness on the seller side too. v1 recommend public reserve (simple, transparent); add hidden reserve as v2 if there's demand.

2. **Multi-serial auctions.** "Auction this basket of 5 NFTs as a bundle." Adds substantial complexity (need to escrow all 5, transfer all 5 on settlement). Recommend NOT for v1.

3. **Auction extension by seller.** Should seller be able to extend their own auction's close time before any bids? Probably yes (no economic impact, just lengthens the window). After bids: definitely no (would let seller game the close time).

4. **Bidder pull-payment vs push.** Already chose pull. Alternative: push refund to address (`call`); fall back to claimable mapping on failure. Slightly better UX but more code paths to audit. Pure pull is simpler; stick with it.

5. **Concurrent auctions on same serial.** Per the auctionId scheme (`keccak256(seller, token, serial, nonce)`), multiple sellers can have auctions for the SAME serial if they own it. In practice only one seller can hold it at a time, but post-settlement transfers could make this happen. Acceptable — each auction is independent storage.

6. **Royalty source of truth.** Hedera's HTS native royalty schedule (configured at token creation) is the canonical source. The 2-step `TokenStakerV2` transfer should trigger this automatically. But for fungible payment splits (auction-style), we may need to compute royalty separately and pay creator directly. Probe in step 3 above.

7. **VIP-tier mapping for non-LSH paid subscribers.** Does paid Bronze = Silver (LSH Gen 2 equivalent)? Or get its own slot? Product call. My recommendation: paid Bronze = Silver tier discount for fees, but with own designation for premium features (agent slots, etc.).

8. **Auction limit per user.** Should we cap the number of concurrent auctions a single seller can have? Probably not — let the market dictate. But if storage grows unboundedly, future cleanup function may be needed.

---

## Out of scope (for this contract)

- Standing bids / CLOB — that's `BidderContractFactory`'s job. English auctions are a separate market type.
- Dutch auctions (price decreasing over time) — different mechanic; future contract if there's demand.
- Sealed-bid auctions — different mechanic; commitment scheme overhead.
- Reserve-not-met auto-relist — manual seller action; could add as convenience.
- Auction discoverability beyond basic pagination — agentic-layer indexer's job.

---

## Open product decisions (deferred to release planning)

- `protocolFeeBpsBase` starting value (suggest 100 = 1% to match LST base)
- `minReservePrice` starting value (dust prevention; suggest 1000 tinybar or 10 LAZY)
- `minDuration` / `maxDuration` — suggest 10 min / 30 days
- `defaultMinStepBps` — suggest 200 (2%); reasonable for high-velocity auctions
- `defaultAntiSnipeWindow` / `Extension` — suggest 5 min / 10 min (Foundation-style)
- `settlementBountyBps` — suggest 25 (0.25%); enough to incentivize keepers without eating into seller proceeds significantly
- Whether to enable VIP integration at deploy (`vipSubscription` set in constructor or as a follow-up admin call)

---

*Companion docs: `LSHTierLib-DESIGN.md` and `VIPSubscription-DESIGN.md` for the tier resolution + premium-feature surface. `AGENT-MARKETPLACE-DELTA.md` for the broader architecture context.*
