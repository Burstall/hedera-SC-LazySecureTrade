# BCF Stash-Initiated Listing — Design Doc

> **✅ IMPLEMENTED** (2026-05-27). The stash-initiated listing
> flow shipped as `BidderContract.createTrade(...)` → factory
> `createTradeOnBehalfOfStash(...)` → LST `createTradeOnBehalf(...)`.
> The original signature in this doc predates the bug-fix pass
> documented in `docs/BCF-StashAllowances-DESIGN.md` (Bugs 1-5);
> for the as-shipped surface read the allowances doc. The flow /
> use-case framing below remains accurate for the agentic listing
> motivation.

**Status:** ✅ Implemented (was: pre-implementation design).
**Companion to:** `docs/AGENT-MARKETPLACE-DELTA.md`, `docs/v0.3-integration-guide.md`, **`docs/BCF-StashAllowances-DESIGN.md`** (final signatures + cancel flow + NFT/HBAR allowance plumbing — read first).
**Target release:** v0.3 mainnet — shipped (closed the P5.8 gap).

---

## Purpose

Wire the existing LST `createTradeOnBehalf` authorized-factory hook to the BCF stash, so a user's stash can list an NFT for sale at the user's direction. Primary use case: the **DIPLOMAT agent** off-chain-negotiates a deal via HCS-10, then asks the user's stash to list the NFT at the agreed price with the negotiated buyer specified.

The infrastructure already exists on the LST side (`authorizedFactories[factory] = true`, `createTradeOnBehalf(seller, ...)`), but BCF has no path that actually calls it. The v0.3 test rework flagged this (P5.8) — current test only verifies the LST authorization mapping; no stash function exercises the on-behalf listing.

---

## Current state (gap analysis)

**LST side (existing, no changes needed):**
- `authorizedFactories[address factory] = bool` — mapping
- `authorizeFactory(address factory, bool authorized)` — owner-gated setter
- `createTradeOnBehalf(address seller, address buyer, address token, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime)` — callable only by addresses with `authorizedFactories[msg.sender] == true`; bypasses the $LAZY listing cost (since factory presumably handled that off-chain or upstream)
- BCF is already authorized on LST at scaffold time (v0.3 deploy: `lstContractId.authorizeFactory(bidderFactoryId, true)`)

**BCF side (what's missing):**
- No public function lets a stash say "list serial X at price Y for buyer Z via the authorized hook"
- The TradeCreatedFromStash event is declared in `IBidderContractFactory` (per CLAUDE.md / event enumeration) but never emitted

**Stash (BidderContract) side (what's missing):**
- No `createTrade` / `listForSale` function exposed to owner
- No agent-permission gating (waiting on the per-agent envelope work — but the design needs to anticipate it)

---

## Flow

```
DIPLOMAT (off-chain)            Stash (BidderContract)           BCF                LST
   │                                 │                              │                  │
   │  Negotiates with buyer 0.0.X via HCS-10                       │                  │
   │  Agreed: serial 42 for 5000 HBAR                              │                  │
   │                                 │                              │                  │
   ├──instruct stash via agentic────►│                              │                  │
   │  layer (signs as owner OR                                     │                  │
   │  uses agent envelope)                                          │                  │
   │                                 │                              │                  │
   │                                 ├──createTradeOnBehalfOfStash─►│                  │
   │                                 │  (token, serial, buyer,      │                  │
   │                                 │   hbarPrice, lazyPrice,      │                  │
   │                                 │   expiry, agentKey?)         │                  │
   │                                 │                              │                  │
   │                                 │                              ├──verify msg.sender == stash[user]
   │                                 │                              ├──verify stash owns NFT
   │                                 │                              ├──createTradeOnBehalf─►│
   │                                 │                              │  (stash, buyer,      │
   │                                 │                              │   token, serial,     │
   │                                 │                              │   ...)               │
   │                                 │                              │                      │
   │                                 │                              │  ◄─emits TradeCreated│
   │                                 │                              │                      │
   │                                 │                              ◄─emits TradeCreatedFromStash
   │                                 │                              │                      │
   │  Buyer (or buyer's agent)                                                            │
   │  later calls LST.executeTrade───────────────────────────────────────────────────────►│
   │  → NFT transfers stash → LST (escrow) → buyer (2-step royalty-compliant)            │
```

---

## Surface additions

### BidderContract (the stash)

```solidity
/// @notice List a stash-held NFT for sale via the LST authorized-factory path.
/// Used for off-market negotiated deals (typically DIPLOMAT agent flow).
/// @param token NFT collection address
/// @param serial Specific serial held by this stash
/// @param buyer Closed-trade buyer (must be set; open-market listings should use the user's direct LST path)
/// @param hbarPrice Tinybar price (set to 0 for LAZY-only trade)
/// @param lazyPrice $LAZY price in smallest unit (set to 0 for HBAR-only trade)
/// @param expiryTime Unix timestamp; 0 = no expiry
/// @param agentKey Optional agent identifier for envelope tracking + event tagging.
///        bytes32(0) = owner-initiated (no envelope check); non-zero = agent-initiated.
function createTradeFromStash(
    address token,
    uint256 serial,
    address buyer,
    uint256 hbarPrice,
    uint256 lazyPrice,
    uint256 expiryTime,
    bytes32 agentKey
) external;
```

Access control:
- If `agentKey == bytes32(0)`: only owner (existing `onlyOwner` modifier)
- If `agentKey != bytes32(0)`: owner OR the per-agent envelope (when shipped) — uses the same `_spendForAgent` path with a zero $LAZY/HBAR draw (listing has no immediate cost; agent budget isn't consumed but agent identity is recorded)

Pre-call checks before the BCF cross-call:
- Caller passes the standard `onlyOwner` / agent-permission gate
- Stash must actually hold the NFT (`IERC721(token).ownerOf(serial) == address(this)`) — 1 subcall
- Buyer must not be zero address (this is the closed-trade variant; open-market listings should use the user's direct LST path)

Then invokes BCF:

```solidity
IBidderContractFactory(factory).createTradeOnBehalfOfStash(
    token, serial, buyer, hbarPrice, lazyPrice, expiryTime, agentKey
);
```

### BidderContractFactory

```solidity
/// @notice Stash-initiated listing on LST via the authorized-factory hook.
/// Callable only by a verified-deployed stash (msg.sender ∈ stashes).
/// @param agentKey Forwarded for event tagging; envelope enforcement happens in the stash itself.
function createTradeOnBehalfOfStash(
    address token,
    uint256 serial,
    address buyer,
    uint256 hbarPrice,
    uint256 lazyPrice,
    uint256 expiryTime,
    bytes32 agentKey
) external returns (bytes32 tradeId);
```

Implementation:

```solidity
function createTradeOnBehalfOfStash(
    address token,
    uint256 serial,
    address buyer,
    uint256 hbarPrice,
    uint256 lazyPrice,
    uint256 expiryTime,
    bytes32 agentKey
) external returns (bytes32 tradeId) {
    // Verify msg.sender is a registered stash
    address stashOwner = stashOwnerOf[msg.sender];
    if (stashOwner == address(0)) revert InvalidStash();

    // Forward to LST. LST's createTradeOnBehalf will verify
    // authorizedFactories[address(this)] == true (already true since v0.3 scaffold).
    tradeId = ILazySecureTrade(lazySecureTrade).createTradeOnBehalf(
        msg.sender,    // seller is the stash (NFT custody holder)
        buyer,
        token,
        serial,
        hbarPrice,
        lazyPrice,
        expiryTime
    );

    emit TradeCreatedFromStash(tradeId, msg.sender, stashOwner, token, serial, agentKey);
}
```

New mapping needed if not present: `mapping(address stash => address owner) public stashOwnerOf` — the reverse of `stashOf[user]`. Could derive on demand by iterating `stashOf`, but a direct lookup is much cheaper. Pre-populate at stash deployment.

### Events

Already declared in `IBidderContractFactory` per the v0.3 event enumeration:

```solidity
event TradeCreatedFromStash(
    bytes32 indexed tradeId,
    address indexed stash,
    address indexed seller,    // stash owner
    address token,
    uint256 serial,
    bytes32 agentKey            // bytes32(0) if owner-initiated
);
```

The `agentKey` addition is new (relative to the original v0.3 event signature). If we're adding it, we should confirm the event isn't already emitted elsewhere with a different shape — quick grep before finalizing.

### Custom errors

```solidity
error InvalidStash();                      // already exists in BCF
error StashDoesNotOwnSerial();             // new — stash must hold the NFT before listing
error BuyerCannotBeZero();                 // new — closed-trade variant requires explicit buyer
error InvalidPrice();                      // new — at least one of hbarPrice/lazyPrice must be non-zero
```

---

## Subcall budget

`createTradeFromStash` flow from caller to LST:

| Step | Subcalls |
|---|---|
| Stash → BCF (xcall) | 1 |
| BCF → stash ownerOf check (skipped if BCF doesn't re-verify — left to LST) | 0 |
| BCF → LST.createTradeOnBehalf | 1 |
| LST internal: NFT transfer-from-stash-to-LST-escrow (2-step) | 4-6 |
| LST internal: store trade, emit events | 0-1 |
| **Total** | **6-9** |

Well within budget. Single-tx operation.

Note: the LST createTradeOnBehalf bypasses the $LAZY listing cost (since the factory model presumes the factory has handled that responsibility upstream). For stash-initiated closed-trade listings, this is correct — no $LAZY burn for closed listings, matching v0.2 behavior.

---

## Why closed-trade only (no open-market via stash)

The `createTradeOnBehalf` flow is designed for closed trades (specific buyer). Two reasons not to extend it to open-market via stash:

1. **Open-market listings need the $LAZY listing cost.** That's a fee path the user pays from their own wallet, not the stash. Routing through the stash would either skip the cost (bad — circumvents tokenomics) or require the stash to pay (complicates the stash's $LAZY accounting).

2. **Open-market listings can be done directly by the user.** They have full control over their NFT pre-listing; no agent intermediation needed. The stash-initiated path is specifically for cases where the agent is brokering a deal.

If open-market stash listings become a product requirement, that's a separate design — likely involves the stash paying the $LAZY cost from its own balance.

---

## Open implementation questions

1. **Should BCF verify stash actually holds the NFT before forwarding?**
   - Pro: clearer error if stash doesn't own
   - Con: 1 extra subcall (`ownerOf`)
   - LST will catch it on the transfer attempt regardless
   - **Recommend: skip in BCF, let LST surface the failure on execution attempt.** Saves a subcall on the listing path; the deferred error is acceptable.

2. **Should the stash transfer the NFT to LST escrow at listing time?**
   - This is how v0.2 LST works for direct trades: NFT escrows on `createTrade`.
   - For stash flow, the NFT stays in the stash until execution, then the standard 2-step transfer fires.
   - Need to verify LST.createTradeOnBehalf expects pre-escrow vs lazy-escrow semantics. Likely the latter (since the factory might list NFTs the seller hasn't pre-escrowed).
   - **Action: read LST.createTradeOnBehalf source carefully during implementation; confirm escrow timing.**

3. **`agentKey` field — is bytes32 right?**
   - Matches the same `agentKey` field design in per-agent envelopes work
   - Lets the agentic layer correlate listing → HCS-10 topic → settlement via off-chain index
   - Use the same encoding scheme as agent envelopes (TBD)

4. **Should this emit an LST-side event too?**
   - LST.createTradeOnBehalf will emit its standard `TradeCreated` event with the stash as `seller`
   - The agentic layer can join on `tradeId` between the LST event and BCF's `TradeCreatedFromStash`
   - No additional LST changes needed

5. **Per-agent envelope integration — couple now or later?**
   - The `agentKey` parameter is a forward-compat hook; for v0.3 mainnet, accept `bytes32(0)` only (owner-initiated)
   - When envelope work ships, enable non-zero `agentKey` and route through `_spendForAgent` (with zero-amount draw — listing doesn't consume budget, just records identity)
   - **Recommend: ship the parameter from day one as `bytes32` (cheap), enforce zero-only until envelope shipped**

---

## Test plan additions

Add to `test/BidderContractFactory.test.js` (replacing or extending the existing P5.8 placeholder test):

- **Happy path:** stash owner calls `createTradeFromStash(token, serial, buyer, hbarPrice, 0, expiry, bytes32(0))` → emits `TradeCreatedFromStash` + LST's `TradeCreated`; verify trade exists on LST via mirror
- **Buyer executes the listed trade:** the listed trade is executable via standard LST `executeTrade(tradeId)` path; NFT moves stash → LST escrow → buyer; seller receives payment
- **Access control:** non-owner caller → reverts `OnlyOwner`
- **Stash doesn't own NFT:** revert (deferred to LST's transfer attempt; acceptable)
- **Zero buyer:** revert `BuyerCannotBeZero`
- **Both prices zero:** revert `InvalidPrice`
- **Authorized-factory invariant:** if LST's `authorizedFactories[BCF]` is somehow false → LST reverts; stash flow propagates the failure

All tests use typed `expectRevertNamed`, mirror-first reads, `MIRROR_DELAY` sleeps.

---

## Pre-implementation checklist

- [ ] Read `LST.createTradeOnBehalf` source carefully: confirm expected escrow timing and parameter shape
- [ ] Verify `stashOf[user]` already exists in BCF; add `stashOwnerOf[stash]` reverse mapping at deploy
- [ ] Confirm `TradeCreatedFromStash` event signature in `IBidderContractFactory` — add `agentKey` field if missing
- [ ] Confirm BCF + BidderContract bytecode have headroom for ~50-100 lines of additions each
- [ ] Add the new custom errors to existing error catalogs

---

## Effort estimate

- BidderContract changes: ~30-50 lines (function + access control)
- BCF changes: ~40-60 lines (function + mapping)
- Tests: ~150 lines (3-4 test cases following the established methodology)
- Total: ~250 lines + 1 day audit pass

Small enough to fit in the v0.3 mainnet release without disrupting other work.

---

*Out of scope: open-market stash listings (would require new $LAZY cost path), HCS-10 negotiation protocol on the off-chain side (agentic-layer concern), trade execution path (unchanged from v0.2 LST).*
