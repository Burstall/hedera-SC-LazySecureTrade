# BCF Stash Allowances — Design Doc

**Status:** Pre-implementation design.
**Companion to:** `docs/BCF-StashInitiatedListing-DESIGN.md`, `docs/v0.3-integration-guide.md`.
**Target release:** v0.3 mainnet (blocking — without these, executeAgainstBid / executeArbitrage / stash-listed-trade flows revert with `HTSCallFailed(292, "XFER")`).

---

## TL;DR

Every trade flow that involves a stash hits Hedera's HTS royalty engine, which uses a 2-step transfer pattern with a 1-tinybar custody hop. The custody-hop leg uses `isApproval=true` — meaning HTS pulls 1 tinybar from one side via a **pre-granted allowance**. EOAs handle this via `setHbarAllowance` from the SDK; **contracts can only grant their own allowances by calling the system contract themselves** (HIP-906 `hbarApprove`). The stash currently has no such code path, so all stash-as-buyer and stash-as-seller flows fail with `SPENDER_DOES_NOT_HAVE_ALLOWANCE`.

This doc specifies the minimal contract surface to fix that, scoped tight against the 24,576-byte limit, and analyzes the attack surface each new function exposes.

This doc also covers the **trade lifecycle gap that the stash-as-seller listing model exposes**: when a stash lists an NFT, LST records the stash as `seller`, which means the human owner cannot directly call `LST.cancelTrade` from their EOA. We solve this with a `BCF.cancelTradeFromStash` orchestrator that keeps LST agnostic of BCF internals — symmetric to the existing `createTradeOnBehalf` factory hook. The user-facing UX is uniform: cancel any trade from your EOA.

---

## Background: where the 1 tinybar comes from

`TokenStakerV2.moveNFTs` (shared by LST and BidderContract) emits a single `cryptoTransfer` per batch:

```
STAKING    : NFT seller → contract,  HBAR contract → seller (salePrice)
WITHDRAWAL : NFT contract → buyer,   HBAR buyer → contract (1 tinybar, isApproval=true)
```

The WITHDRAWAL leg's HBAR direction is *receiver-pays* via approval. Why: HTS won't process a 0-value NFT transfer between contracts without triggering the royalty engine's fallback fee (5 HBAR by default on our test collection). The 1-tinybar approval pulls a token-shaped, non-zero counter-transfer that satisfies the engine without disturbing balances.

Whoever the WITHDRAWAL leg's *receiver* is must have granted the *sender* (the contract calling `cryptoTransfer`) an HBAR allowance ≥ 1 tinybar:

| Flow | Calling contract | Receiver of NFT | Allowance required |
|---|---|---|---|
| `LST.executeTrade` (executeAgainstBid, executeArbitrage, normal LST buy) | LST | buyer | **buyer → LST** |
| `BidderContract.rescueNFT` | stash | EOA owner / target | **target → stash** |
| `BidderContract.withdrawNFTs` | stash | EOA owner | **owner → stash** |

For EOA buyers this is the `setHbarAllowance(buyer, LST, X)` step every LST integration already does. For **stash-as-buyer** (executeAgainstBid / executeArbitrage / LAZY-bid execution), the buyer is the stash contract — and a contract can only authorize an outgoing HBAR allowance by calling the system contract itself.

---

## And there's a second, symmetric problem on the listing side

Once `BidderContract.createTrade` (stash-initiated listing) works, the stash becomes the LST trade's `seller`. At trade execution time, LST's STAKING leg does `cryptoTransfer({NFT: stash → LST, HBAR: LST → stash})`. LST initiates the call, so LST is the "spender" of the stash's NFT. For HTS to accept that transfer, **the stash must have granted LST an NFT allowance** (per-serial or all-serials).

This is the same shape as `setNFTAllowanceAll(seller, LST)` that every EOA seller already does. The stash, being a contract, has to grant it itself.

---

## Current bugs surfaced by this analysis

### Bug 1: `createTradeOnBehalfOfStash` passes the wrong seller

`BidderContract.createTrade` (BC.sol:670-679) forwards `owner` (the human) as the `seller` argument. `BCF.createTradeOnBehalfOfStash` passes that straight through to `LST.createTradeOnBehalf`, which calls `_validateNFTOwnershipAndApproval(token, serial, owner)` (LST.sol:1703) — but the NFT lives in the stash, not in `owner`'s wallet. The ownership check returns false → `UserDoesNotOwnOrHasNotApprovedNFT`. The flow is **currently nonfunctional**, masked by the absence of an end-to-end test in P5.8 (only the LST authorization mapping is asserted; no trade is actually listed).

Fix: pass `address(this)` (the stash) as `_seller`. The trade records the stash as the NFT-holding seller; the stash receives the payment; owner withdraws via `withdrawHbar` / `rescueLazy`.

### Bug 2: `seller` parameter on `BCF.createTradeOnBehalfOfStash` is redundant

The companion design doc (`BCF-StashInitiatedListing-DESIGN.md`, lines 119-128) specified the BCF function signature **without** a `seller` parameter — the BCF should always pass `msg.sender` (the validated stash, from `isValidStash[msg.sender]`) as the seller to LST. The implementation drifted from the design and added back a `seller` arg, which is now the vector for Bug 1.

Fix: drop the `seller` parameter. BCF unconditionally uses `msg.sender`. The interface change is breaking but the surface area is internal (only called from BidderContract.createTrade).

This is also a defense-in-depth win: if a future caller miswires `seller` (passes a third-party address), they can't make LST record someone else as the seller. The parameter just shouldn't exist.

### Bug 3: stash-listed trades partially lose LSH fee discounts

Because the LST trade now records `seller = stash`, LST's `areAdvancedTradesFree(stash)` and `getLSHTokenTier(stash)` checks fire against the stash address — which does not (and should not) hold the user's LSH tokens.

**Narrowing per security review:** the LSH-token *itemAddress* exemption (`LST.sol:1416`) is keyed on the **token being traded**, not on the seller. So when the NFT being sold is itself an LSH token, the exemption still applies regardless of seller — the stash gets full LSH exemption when selling an LSH NFT via stash.

The actual regression: **non-LSH collections sold by an LSH-holding owner via stash lose the LSH-holder fee discount.** This is the long tail of LSH benefit, not the core case (which is selling LSH itself). Direct-EOA LST trades are unaffected.

Out of scope for this doc to fix (would require LST changes — adding a `beneficiary` field separate from `seller`, or an LSH-tier resolver hook callable from LST during fee calculation). Documented here as a known v0.3 regression for the long-tail case. Frontend should warn LSH-holding users about the discount loss when listing *non-LSH* NFTs via stash.

### Bug 4: Cancel lockout (introduced by Bug 1's fix)

Fixing Bug 1 by recording the stash as `trade.seller` creates a follow-on problem: **`LST.cancelTrade` requires `msg.sender == trade.seller`** (LST.sol:368-381). The human owner cannot call cancel from their EOA on a stash-listed trade — only the stash contract can. There is currently no path for the owner to cancel.

**Concrete attack** (relevant once the agent envelope path ships, per `BCF-StashInitiatedListing-DESIGN.md`): compromise of just the agent layer (not the owner key) lets an attacker list a serial at 1 tinybar to a buyer they control. The owner sees the listing on mirror, tries `LST.cancelTrade` from their EOA — reverts. Their only recourse is racing the executeTrade in sub-second Hedera consensus, or revoking the per-serial NFT approval (which only helps if Bug 5's fix is in).

**Fix: BCF orchestrator pattern (no LST changes).** `BCF.cancelTradeFromStash(tradeId)` is the single canonical cancel entry point for stash-listed trades. It reads the trade from LST, verifies the caller owns the stash (`stashOwnerOf[trade.seller] == msg.sender`), then instructs the stash to cancel via the factory-gated `stash.cancelLstTrade`. The stash revokes the per-serial NFT approval (closing Bug 5) and then calls `LST.cancelTrade` — which passes because `msg.sender == stash == trade.seller`.

LST learns nothing new. Symmetric with the existing `createTradeOnBehalf` pattern: factory-mediated create has a factory-mediated cancel. Frontend reads `trade.seller`, checks `BCF.isValidStash[seller]`, and routes to either `LST.cancelTrade` directly (EOA-listed) or `BCF.cancelTradeFromStash` (stash-listed). User signs from their EOA in both cases — the routing is invisible.

### Bug 5: NFT allowance leaks on cancellation

Traced via security review: **`LST.cancelTrade` → `removeTradeFromState` (LST.sol:1615-1628) does only mapping cleanup. It never calls `approveNFT(token, address(0), serial)`.** Per-serial HTS approvals on Hedera persist until the next *transfer* of that serial — `approveNFT` is consumed by `cryptoTransfer`, not by trade cancellation. So `list → cancel` leaves the stash with a **permanent dangling NFT allowance** against LST for that serial.

**Lifetime blast radius without this fix:** every serial that the stash has ever listed and not subsequently traded. The "blast radius = one serial" assumption in the original draft of this doc was wrong across the stash's lifetime.

**Fix:** `stash.cancelLstTrade` (called via the Bug 4 orchestrator) calls `HederaTokenService.approveNFT(token, address(0), serial)` **before** `LST.cancelTrade`. If `LST.cancelTrade` reverts, the whole tx reverts and the approval state is restored — atomicity preserved.

This is why we use per-serial NFT approval (not `setApprovalForAll`): granular grants are the unit of revocation. With `setApprovalForAll`, there's no per-trade-cancel revoke story — you'd have to track all listed serials and revoke each individually, which defeats the gas argument for `setApprovalForAll` in the first place.

---

## Allowance matrix (final state)

| Direction | Who needs allowance | When granted | Lifetime | Granularity |
|---|---|---|---|---|
| Stash → LST (HBAR) | Stash itself | Lazy: on first executeTrade after balance dips below threshold | Refilled in batches | Single value, tinybars |
| Stash → LST (NFT) | Stash itself | At listing time (inside `createTrade`) | Per-serial, consumed on transfer | One serial per listing |
| EOA → Stash (HBAR) | EOA owner | Once, off-chain via SDK | User-set; can revoke | Single value, tinybars |

---

## Surface additions

### `BidderContract` (the stash)

```solidity
// HBAR allowance management (owner-sovereign)
function approveHbarTo(address spender, int256 amount) external onlyOwner;
function hbarAllowanceTo(address spender) external view returns (int256);

// NFT allowance management (per-serial only; setApprovalForAll deliberately omitted — see Security)
// `public` not `external` so createTrade can call it as an internal jump.
function approveNFTTo(address token, address spender, uint256 serial) public onlyOwner;

// Trade lifecycle (called via BCF.cancelTradeFromStash, OR by owner directly post-detach).
// Note: takes ONLY tradeId — token/serial are re-derived from LST.getTrade(tradeId)
// to eliminate the spoofable-param surface a compromised factory could exploit
// to revoke approvals on unrelated NFTs.
function cancelLstTrade(bytes32 tradeId) external onlyOwnerOrFactory nonReentrant;

// Internal — lazy-refill helper called automatically inside executeTrade
function _ensureHbarAllowanceForCustodyHop(address spender) internal;
```

#### `_ensureHbarAllowanceForCustodyHop` — lazy refill in `executeTrade`

```solidity
uint256 internal constant CUSTODY_HOP_ALLOWANCE_REFILL = 1_000_000_000; // 10 HBAR worth
uint256 internal constant CUSTODY_HOP_ALLOWANCE_FLOOR  = 100_000_000;   //  1 HBAR worth

function _ensureHbarAllowanceForCustodyHop(address spender) internal {
    int256 current = _hbarAllowanceTo(spender);
    if (current >= int256(CUSTODY_HOP_ALLOWANCE_FLOOR)) return;
    _hbarApprove(spender, int256(CUSTODY_HOP_ALLOWANCE_REFILL));
}
```

Refill numbers are large in *allowance* terms but trivially small in HBAR (1 HBAR floor, 10 HBAR refill ceiling). The actual amount spent per trade is **1 tinybar**, so a 10 HBAR allowance budget covers ~10 billion custody hops before refill. The refill cadence is therefore effectively "once per stash, ever, in practice" — but the design accommodates re-granting if LST is ever rotated.

Why not perpetual max-allowance: bounds the blast radius if LST is ever compromised. With max(int256) allowance, a compromised LST drains the stash. With a 10 HBAR allowance, the same compromise is bounded to 10 HBAR per refill cycle, and the refill check sees the drained allowance on next executeTrade and re-grants — but the *owner* can pause that by calling `approveHbarTo(LST, 0)` between refills.

#### Wire-in to `executeTrade`

```solidity
function executeTrade(bytes32 tradeId, uint256 hbarAmount, uint256 lazyAmount)
    external payable onlyFactory nonReentrant
{
    _ensureHbarAllowanceForCustodyHop(lazySecureTradeAddress);

    if (lazyAmount > 0) {
        IERC20(lazyToken).approve(address(lazyGasStation), lazyAmount);
    }

    ILazySecureTrade(lazySecureTradeAddress).executeTrade{value: hbarAmount}(tradeId);
}
```

#### Wire-in to `createTrade` (stash-listed listing path)

```solidity
function createTrade(
    address token, address buyer, uint256 serial,
    uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime,
    bytes32 agentKey  // forward-compat: bytes32(0) for owner-initiated
) external onlyOwner nonReentrant returns (bytes32 tradeId) {
    // Grant LST per-serial NFT allowance so LST can pull this serial
    // when the trade executes. Per-serial (not setApprovalForAll) bounds
    // the blast radius if LST is ever compromised AND lets us atomically
    // revoke on cancel — see Security and Bug 5.
    approveNFTTo(token, lazySecureTradeAddress, serial);

    tradeId = IBidderContractFactory(factory).createTradeOnBehalfOfStash(
        token, serial, buyer, tinybarPrice, lazyPrice, expiryTime, agentKey
        // Note: no `seller` arg — see Bug 2 / BCF signature change below
    );
}
```

#### `cancelLstTrade` implementation

```solidity
function cancelLstTrade(bytes32 tradeId)
    external onlyOwnerOrFactory nonReentrant
{
    // Re-derive (token, serial) from LST itself rather than trusting caller
    // input. A compromised factory could otherwise pass spoofed (token, serial)
    // to make us revoke approval on an unrelated NFT before LST rejects the
    // mismatched cancellation. Re-fetching costs 1 view subcall and closes
    // that vector cleanly.
    ILazySecureTrade.Trade memory trade =
        ILazySecureTrade(lazySecureTradeAddress).getTrade(tradeId);
    if (trade.seller == address(0)) revert TradeNotFoundOrInvalid();

    // Revoke the per-serial NFT approval to LST FIRST so the dangling
    // allowance is gone even if LST.cancelTrade subsequently fails.
    // (If cancelTrade reverts, the whole tx reverts and the approval
    // state is restored — so this ordering is safe under nonReentrant.)
    int256 rc = HederaTokenService.approveNFT(trade.token, address(0), trade.serial);
    if (rc != HederaResponseCodes.SUCCESS) revert NFTAllowanceFailed(rc);

    // LST.cancelTrade checks `msg.sender == trade.seller`. If this stash
    // isn't the seller (e.g., factory passed a tradeId for someone else's
    // listing), LST reverts with TradeNotFoundOrInvalid and the whole tx
    // reverts — including the approveNFT revoke above. No leak.
    ILazySecureTrade(lazySecureTradeAddress).cancelTrade(tradeId);
}
```

The signature takes ONLY `tradeId` — `(token, serial)` are derived inside, not trusted from caller. The 1 extra subcall (LST.getTrade view call) is a deliberate trade for eliminating the spoofable-param surface.

### `BidderContractFactory`

**Final signature for `createTradeOnBehalfOfStash`** (this doc supersedes the signature spec in `BCF-StashInitiatedListing-DESIGN.md`):

```solidity
function createTradeOnBehalfOfStash(
    address token,
    uint256 serial,
    address buyer,
    uint256 hbarPrice,
    uint256 lazyPrice,
    uint256 expiryTime,
    bytes32 agentKey   // bytes32(0) for owner-initiated; non-zero for agent-mediated
) external nonReentrant returns (bytes32 tradeId) {
    if (!isValidStash[msg.sender]) revert InvalidStash();

    tradeId = LAZY_SECURE_TRADE.createTradeOnBehalf(
        msg.sender,  // seller = the stash itself (NFT custody holder)
        token, buyer, serial, hbarPrice, lazyPrice, expiryTime
    );

    emit TradeCreatedFromStash(
        tradeId, msg.sender, stashOwnerOf[msg.sender], token, serial, agentKey
    );
}
```

Changes from current implementation:
1. **`seller` parameter dropped** (Bug 2 fix). The function hard-codes `msg.sender` (validated via `isValidStash`) as the seller — no caller can spoof seller identity.
2. **`agentKey` parameter retained** from `BCF-StashInitiatedListing-DESIGN.md` for envelope-flow forward compatibility. Carried into the event for off-chain correlation; not enforced on-chain in v0.3 (envelope work will gate on it).

`stashOwnerOf[stash] → user` reverse mapping required for the event payload (so off-chain consumers can index by user, not just stash). Populated at deploy.

**New cancel orchestrator (Bug 4 fix):**

```solidity
function cancelTradeFromStash(bytes32 tradeId) external nonReentrant {
    ILazySecureTrade.Trade memory trade = LAZY_SECURE_TRADE.getTrade(tradeId);
    if (trade.seller == address(0)) revert TradeNotFoundOrInvalid();
    if (!isValidStash[trade.seller]) revert NotStashListed();
    if (stashOwnerOf[trade.seller] != msg.sender) revert UnauthorizedCaller();

    // Instruct the stash to cancel. The stash re-fetches the trade from
    // LST itself to derive (token, serial) — no spoofable params forwarded.
    // The stash will (a) revoke its per-serial NFT approval to LST and
    // (b) call LST.cancelTrade, which passes because the stash IS trade.seller.
    BidderContract(payable(trade.seller)).cancelLstTrade(tradeId);

    emit TradeCancelledFromStash(tradeId, trade.seller, msg.sender);
}
```

Frontend routing: read `trade.seller`, check `isValidStash[seller]` on BCF, route to either `LST.cancelTrade` (EOA-listed) or `BCF.cancelTradeFromStash` (stash-listed). The user calls one or the other from their EOA in both cases.

### Custom errors

```solidity
// BidderContract
error HbarAllowanceFailed(int64 responseCode);  // HIP-906 hbarApprove non-success
error NFTAllowanceFailed(int256 responseCode);  // HTS approveNFT non-success
error TradeNotFoundOrInvalid();                  // mirror of LST error for the cancel path

// BidderContractFactory
error TradeNotFoundOrInvalid();   // mirror of LST error for the cancel path
error NotStashListed();           // trade.seller is not a registered stash
error UnauthorizedCaller();       // already exists; reused for stashOwnerOf mismatch
```

Reuse existing `OnlyOwner` / `OnlyFactory` / `InvalidAddress` for gating violations.

### Events

```solidity
// BidderContractFactory — existing event, agentKey field is new
event TradeCreatedFromStash(
    bytes32 indexed tradeId,
    address indexed stash,
    address indexed seller,     // stash owner (from stashOwnerOf)
    address token,
    uint256 serial,
    bytes32 agentKey            // bytes32(0) for owner-initiated; non-zero for agent
);

// BidderContractFactory — new
event TradeCancelledFromStash(
    bytes32 indexed tradeId,
    address indexed stash,
    address indexed canceller   // the EOA that called BCF.cancelTradeFromStash
);
```

LST's own `TradeCreated` / `TradeCancelled` events still fire (with `seller = stash`). The BCF events add the human-owner identity for off-chain indexers that want to correlate without a separate `stashOwnerOf` lookup.

---

## Implementation: calling HIP-906 `hbarApprove`

There's no Solidity-level wrapper for HIP-906 in this codebase (no IHRC632 import). To avoid pulling in a new interface file and bloating bytecode, use a low-level call:

```solidity
function _hbarApprove(address spender, int256 amount) internal {
    (bool ok, bytes memory ret) = address(this).call(
        abi.encodeWithSignature("hbarApprove(address,int256)", spender, amount)
    );
    if (!ok) revert HbarAllowanceFailed(0);
    // Defensive: a successful call with a malformed return (system contract
    // disagrees with the ABI we expect) would panic inside abi.decode.
    // Guard so we surface HbarAllowanceFailed rather than a generic panic.
    if (ret.length < 32) revert HbarAllowanceFailed(0);
    int64 rc = abi.decode(ret, (int64));
    if (rc != int64(HederaResponseCodes.SUCCESS)) revert HbarAllowanceFailed(rc);
}

function _hbarAllowanceTo(address spender) internal view returns (int256) {
    (bool ok, bytes memory ret) = address(this).staticcall(
        abi.encodeWithSignature("hbarAllowance(address,address)", address(this), spender)
    );
    // Defensive decode: any failure (call reverted, system contract missing,
    // malformed return) collapses to "treat as zero allowance" — the refill
    // path will then re-grant. Safer than reverting in a view function that
    // the lazy-refill check depends on.
    if (!ok || ret.length < 64) return 0;
    (int64 rc, int256 amount) = abi.decode(ret, (int64, int256));
    return rc == int64(HederaResponseCodes.SUCCESS) ? amount : int256(0);
}
```

`address(this).call(hbarApprove)` is the HIP-906 idiom — the system contract intercepts calls to *the calling account's own address* with these selectors. This is also why `_hbarApprove` is safe inside `nonReentrant`: the system contract doesn't reenter user code.

NFT allowances go through the existing `HederaTokenService.approveNFT` helper already inherited via `TokenStakerV2`:

```solidity
// `public` (not `external`) so createTrade can call it as an internal jump
// without paying for a self-external call. onlyOwner gates the EOA-direct
// path; the createTrade internal call inherits the same msg.sender so the
// modifier passes when the owner invokes createTrade.
function approveNFTTo(address token, address spender, uint256 serial)
    public onlyOwner
{
    int256 rc = HederaTokenService.approveNFT(token, spender, serial);
    if (rc != HederaResponseCodes.SUCCESS) revert NFTAllowanceFailed(rc);
}
```

To revoke an existing approval, the owner calls `approveNFTTo(token, address(0), serial)` — passing `address(0)` as spender is HIP-336's idiom for revocation. (Consistent with the HBAR revocation idiom of `approveHbarTo(spender, 0)`.)

(`setApprovalForAll` is also available in the HTS precompile but deliberately omitted — see Security.)

---

## Security analysis

The principle: **every new function should be defensible against the question "what does this let an attacker do if they own one of these privileges?"**

### Attack surface table

| New function | Caller required | Worst-case if compromised | Mitigation |
|---|---|---|---|
| `approveHbarTo(spender, amount)` | **owner only** | Owner sets a huge allowance to a malicious spender by mistake (e.g., buggy frontend) → LST exploit (if/when one exists) drains the stash up to `amount` | Owner is sovereign by design — see "Owner sovereignty over allowances" below. Frontend must validate user input. No on-chain cap. |
| `approveNFTTo(token, spender, serial)` | **owner only** | Owner grants per-serial pull rights to a malicious spender | Per-serial grants are auto-consumed on transfer. Listing path goes through `createTrade` which sets this internally with `spender = LST` — no parameter-steering surface there. Direct external use is owner-discretionary. |
| `cancelLstTrade(tradeId)` | owner OR factory | Compromised factory cancels stash's active listings (DoS on listings; no funds movement) | Cancel is non-destructive — NFT stays in stash, allowance is revoked. Owner can re-list. Same factory-trust surface as other factory-mediated paths. Owner-direct path is the post-detach escape hatch. **Note: signature deliberately takes only `tradeId`; `(token, serial)` are re-derived from `LST.getTrade(tradeId)` so a malicious factory cannot pass spoofed values to revoke approval on an unrelated NFT.** |
| `_ensureHbarAllowanceForCustodyHop(spender)` | internal, called from `executeTrade` only | None — hardcoded spender (`lazySecureTradeAddress` from immutable init) | Spender comes from immutable storage set in `initialize`; can't be steered by caller input. |
| `BCF.cancelTradeFromStash(tradeId)` | anyone (auth in body) | Caller cancels a stash-listed trade not owned by them | `stashOwnerOf[trade.seller] != msg.sender` check rejects. Only the stash's true owner can route through this entry point. |

### Specific concerns considered and resolved

**1. Why not `setApprovalForAll(token, LST, true)` for NFTs?**
   It's tempting — one call grants pull rights for every serial of that token, vs. one call *per listing*. But the blast radius if LST is ever compromised is *every NFT of that collection sitting in the stash*. With per-serial, the blast radius on a healthy stash is *only the serials currently listed and not yet executed*. Crucially, per-serial also lets us **revoke on cancel** (Bug 5 fix): the `cancelLstTrade` path calls `approveNFT(token, address(0), serial)` atomically with cancellation. `setApprovalForAll` has no symmetric per-trade revocation story — you'd have to track all listed serials and revoke each individually, which defeats the gas argument for `setApprovalForAll` in the first place. **Per-serial only.**

**2. Owner sovereignty over HBAR allowances (no on-chain cap).**
   The security agent argued for a soft cap (~1000 HBAR) on `approveHbarTo` to defend against frontend bugs (e.g., JS `Number` overflow producing `type(int256).max`). Rejected — by policy, the owner is sovereign. A user who wants to bid large amounts should be able to authorize a correspondingly large HBAR allowance without contract-imposed friction. The frontend bug class exists for *any* approval primitive (ERC-20 `approve` has the same shape); the contract should not paternalize at the cost of legitimate large-bid flows.

   Mitigations live at the application layer:
   - Frontends should validate user-entered amounts client-side and warn on suspicious orders of magnitude.
   - Owner can immediately revoke a mistaken approval via `approveHbarTo(spender, 0)`.
   - Lazy-refill in `executeTrade` is bounded by the hardcoded `CUSTODY_HOP_ALLOWANCE_REFILL` (~10 HBAR), so the *automatic* allowance can never exceed that — only deliberate owner action can grant larger.

   Net: owner mistakes are owner risks; the contract's job is to expose the primitive safely, not to bound the operator.

**3. Factory has no parameterized allowance surface.**
   `approveHbarTo` and `approveNFTTo` are **owner-only** external functions. The factory can only influence allowance state via the internal `_ensureHbarAllowanceForCustodyHop`, which is gated by being called inside `onlyFactory executeTrade` and uses the immutable `lazySecureTradeAddress` as the spender — no parameter manipulation possible. Even a fully compromised factory cannot grant a stash allowance to an arbitrary address.

**4. Detached stash interaction.**
   After `detachFromFactory()`, `factory = address(0)` and `onlyFactory` paths fail. `executeTrade` won't run, so the lazy refill is dead. But the existing perpetual allowance to LST persists. **Owner should call `approveHbarTo(LST, 0)` after detach** if they want to fully sever — document in v0.3-integration-guide. Also note: `cancelLstTrade`'s `onlyOwnerOrFactory` modifier means the owner can still cancel old listings post-detach by calling the stash directly.

   Detach race: two concurrent txs (detach + executeArbitrage from a third party) are interleavable on Hedera even without MEV. Bound is the `CUSTODY_HOP_ALLOWANCE_REFILL` ceiling (~10 HBAR), so worst-case impact is bounded. Worth documenting.

**5. Stale allowances if LST is rotated.**
   If LST is ever redeployed, the immutable `lazySecureTradeAddress` in existing stashes still points at the old contract — the allowance is granted to a now-irrelevant address. New stashes deployed after the rotation get the new LST. **This is the existing v0.3 design constraint** (the stash binds to LST at initialize) and not introduced here. Worth flagging in the LST migration runbook (when one exists): users with pre-rotation stashes must call `approveHbarTo(oldLST, 0)` before the old contract can be considered fully decommissioned.

**6. Re-entrancy via system contract.**
   `address(this).call(hbarApprove)` and `HederaTokenService.approveNFT` both invoke the Hedera system contract, which is not user code and does not reenter. Safe under `nonReentrant`. Verified by inspection of the precompile semantics. Defensive decode guards (see Implementation section) protect against malformed returns from a missing or upgraded system contract.

**7. Allowance front-running.**
   On Hedera there is no MEV (consensus timestamp ordering per CLAUDE.md). The classic "allowance double-spend via front-run" doesn't apply.

**8. `BCF.cancelTradeFromStash` authorization tightness.**
   The auth check is `stashOwnerOf[trade.seller] != msg.sender`. Could an attacker manipulate `stashOwnerOf` to mismap a stash to themselves? `stashOwnerOf` is written exclusively in the stash deploy path (`deployStash` / `deployStashFor`) and never re-written. The reverse mapping cannot be retargeted. Auth is sound.

**9. Listing-then-cancel NFT allowance atomicity.**
   `cancelLstTrade` calls `approveNFT(token, address(0), serial)` *before* `LST.cancelTrade(tradeId)`. If `LST.cancelTrade` reverts (e.g., trade was already executed in a racing tx), the whole tx reverts and the approval state is restored — atomicity preserved. The order matters: revoking *after* cancel would leave a window where a re-entry could exploit the cancelled-but-still-approved state. Locked by the explicit ordering comment in the implementation.

**10. `executeArbitrage` drift-check invariant.**
   `executeArbitrage` (BCF.sol:1199-1294) hashes `keccak256(abi.encode(bidRegistry[bidId]))` pre-call and post-call. `_closeBid` runs at BCF.sol:1286 *after* the post-snapshot — moving `_closeBid` before the snapshot would cause the post-hash to mismatch (false positive `RegistryDriftDetected`). The drift check assumes `bidRegistry[bidId]` is unwritten between `_validateBidForExecution` and the post-snapshot. **Lock this with an explicit code comment**; any future work that adds storage writes to `bidRegistry[bidId]` inside the executeTrade nested call breaks the invariant.

### Final surface (post-security-review)

```solidity
// In BidderContract:
function approveHbarTo(address spender, int256 amount) external onlyOwner;
function hbarAllowanceTo(address spender) external view returns (int256);
function approveNFTTo(address token, address spender, uint256 serial) public onlyOwner;
function cancelLstTrade(bytes32 tradeId) external onlyOwnerOrFactory nonReentrant;
// _ensureHbarAllowanceForCustodyHop, _hbarApprove, _hbarAllowanceTo are internal

// In BidderContractFactory:
function createTradeOnBehalfOfStash(token, serial, buyer, hbarPrice, lazyPrice, expiryTime, agentKey)
    external nonReentrant returns (bytes32 tradeId);  // seller param dropped
function cancelTradeFromStash(bytes32 tradeId) external nonReentrant;  // new orchestrator
```

Net: **three owner-only external mutators + one owner/factory mutator on the stash; one signature change + one new orchestrator on BCF.** No factory-callable allowance setters. The factory path uses only the internal hardcoded-target refill. The cancel orchestrator does its own auth before instructing the stash.

---

## Subcall budget

Per executeTrade (stash as buyer):

| Step | Subcalls |
|---|---|
| `_hbarAllowanceTo(LST)` (staticcall to system contract) | 1 |
| `_hbarApprove(LST, ...)` if refill triggered | 0–1 |
| `IERC20(lazy).approve(LGS, ...)` if LAZY trade | 0–1 |
| `LST.executeTrade` (existing) | 1 |
| → LST internal: payment + 2-step NFT (existing) | 4–6 |
| **Total** | **6–10** |

Refill is amortized — once granted, subsequent executeTrades only pay the 1 subcall for the allowance check, not the refill. So steady-state is **6–8 subcalls per executeTrade**, well within the 50-subcall budget.

Per createTrade (stash-initiated listing):

| Step | Subcalls |
|---|---|
| `approveNFTTo(token, LST, serial)` | 1 |
| `BCF.createTradeOnBehalfOfStash` (xcall) | 1 |
| `LST.createTradeOnBehalf` (internal validation + storage) | 1 |
| **Total** | **3** |

Plus whatever the buyer's later executeTrade consumes (separate transaction).

Per cancelTradeFromStash (stash-listed trade cancellation):

| Step | Subcalls |
|---|---|
| BCF: `LST.getTrade(tradeId)` (view) | 1 |
| BCF → stash: `cancelLstTrade(tradeId)` (xcall) | 1 |
| Stash: `LST.getTrade(tradeId)` (view, re-derives token/serial — anti-spoof) | 1 |
| Stash: `HederaTokenService.approveNFT(token, 0, serial)` (revoke) | 1 |
| Stash → LST: `cancelTrade(tradeId)` (state update + event) | 1 |
| **Total** | **5** |

The two `getTrade` calls (one in BCF for auth, one in stash for anti-spoof) are deliberate. The alternative — BCF forwarding `(token, serial)` to the stash — would save 1 subcall but reopens the spoofable-param surface described in Bug 5's mitigation. 5 subcalls is well within the 50 budget; not worth trading away the security property.

---

## Bytecode budget

The contract currently sits around 23–23.8 KiB depending on optimizer settings. New code estimate:

### BidderContract

| Addition | Bytecode |
|---|---|
| `approveHbarTo` external | ~80 bytes |
| `hbarAllowanceTo` view | ~60 bytes |
| `approveNFTTo` external | ~100 bytes |
| `cancelLstTrade` external (incl. anti-spoof getTrade + revoke) | ~140 bytes |
| `_ensureHbarAllowanceForCustodyHop` internal | ~80 bytes |
| `_hbarApprove` internal (with defensive decode) | ~170 bytes |
| `_hbarAllowanceTo` internal (with defensive decode) | ~140 bytes |
| Constants + errors + storage layout | ~60 bytes |
| **Subtotal** | **~810 bytes** |

### BidderContractFactory

| Addition | Bytecode |
|---|---|
| `stashOwnerOf` reverse mapping (storage layout) | minimal |
| `createTradeOnBehalfOfStash` signature change + `agentKey` event field | ~30 bytes |
| `cancelTradeFromStash` orchestrator | ~180 bytes |
| `TradeCancelledFromStash` event + custom errors | ~40 bytes |
| **Subtotal** | **~250 bytes** |

Stash currently has more headroom than BCF. Both will need a recompile + size check after implementation. If we blow the 24,576-byte limit on BidderContract:

- First optimization: combine `_hbarApprove` and `_hbarAllowanceTo` via a shared `_hbarSystemCall(selector, params, expectedRetLen)` helper. Saves ~120 bytes (defensive-decode code shared).
- Second optimization: drop `hbarAllowanceTo` external view — mirror nodes can read storage directly. Saves ~60 bytes.
- Third optimization: move HIP-906 plumbing into a linked library (changes deploy story; last resort).

BCF is closer to its limit — the `cancelTradeFromStash` is non-trivial. If BCF blows the limit:
- First optimization: inline the LST `getTrade` call (skip allocating `Trade memory`, use individual field accessors). Saves ~50 bytes.
- Second optimization: move the auth check into a shared `_assertStashOwner(stash)` helper used by multiple paths. Saves ~30 bytes.

---

## Open implementation questions

1. **Should `approveNFTTo` accept a serial of `0` to mean "all serials" (auto-route to `setApprovalForAll`)?**
   No. Make the granularity choice explicit — never let a single-serial parameter quietly escalate to all-collection privilege. If we ever need all-serials, add a separate function with a deliberately distinct name and an explicit comment about the blast radius.

2. **Should the listing flow's `approveNFTTo` be wrapped in a try/catch so a stale-but-already-set approval doesn't waste a subcall?**
   Probably not — HTS `approveNFT` is idempotent (re-granting the same approval succeeds without side effect) and the subcall cost is 1. Not worth the complexity.

3. **`stashOwnerOf` storage cost — is it worth adding?**
   The reverse-lookup mapping is needed for the `TradeCreatedFromStash` event payload AND for the `cancelTradeFromStash` auth check. Cost: 1 SSTORE at deploy, ~20K gas. Definitively worth it.

4. **Should we expose an `approveHbarBatch(spenders[], amounts[])` for setting multiple in one tx?**
   Probably not — adds bytecode for a use case that doesn't exist yet (the stash only ever needs to approve LST). Defer until we have a second-spender scenario.

5. **Should the cancel orchestrator emit a separate `TradeCancelledFromStash` event, or is LST's `TradeCancelled` enough?**
   Emit both. LST emits `TradeCancelled(seller=stash, ...)` which is informative but lacks the *owner* identity. BCF's event includes `(tradeId, stash, owner)` so indexers can correlate the cancellation back to the human without a `stashOwnerOf` lookup.

6. **HIP-906 system contract subcall count — 1 or 2?**
   Agent flagged this as needing empirical verification. The HIP spec describes `hbarApprove` as a single system contract call, but the system contract may internally call back into EVM for the response on some Hedera versions. **Action: smoke test on testnet during pre-implementation. If 2, the steady-state executeTrade is 7–11 subcalls instead of 6–10 — still safe.**

---

## Test plan

Add to `test/BidderContractFactory.test.js`:

### Allowance plumbing (new)
- **`approveHbarTo` happy path:** owner grants 1 HBAR allowance to a third party; verify via mirror read of `hbarAllowanceTo`
- **`approveHbarTo` access control:** non-owner reverts `OnlyOwner`
- **`approveHbarTo(spender, 0)` revokes:** verify subsequent allowance read returns 0
- **`approveNFTTo` happy path:** owner grants per-serial approval to a third party; verify via mirror read of HTS allowance
- **`approveNFTTo` access control:** non-owner reverts `OnlyOwner`

### Stash-as-buyer flows (currently failing P5.9, P5.10, executeAgainstBid, executeArbitrage)
- **executeAgainstBid HBAR:** verify the lazy refill kicks in on first execute; second execute consumes only the existing allowance
- **executeAgainstBid $LAZY:** as P5.9, end-to-end
- **executeArbitrage:** as failure 2 in the current run; should now pass
- **Allowance balance after N executes:** verify allowance drains by ≤ 1 tinybar per execute; refill threshold triggers re-grant exactly when expected

### Stash-as-seller flow (new — replaces P5.8 placeholder)
- **createTrade from stash, closed-trade:** stash owns serial, lists for Carol at 5 HBAR; verify NFT allowance granted to LST; Carol executes; NFT moves stash → Carol; HBAR moves Carol → stash (minus royalty); owner withdraws HBAR via `withdrawHbar`
- **createTrade from stash, listing then cancellation via BCF orchestrator (Bug 4 fix):** owner calls `BCF.cancelTradeFromStash(tradeId)` from EOA; verify (a) `LST.cancelTrade` succeeds (stash IS the seller), (b) `TradeCancelled` event from LST + `TradeCancelledFromStash` event from BCF, (c) NFT remains in stash, (d) **per-serial NFT allowance to LST is revoked** (Bug 5 fix — read via HTS mirror endpoint to confirm allowance = 0)
- **Cancel auth rejection:** Carol calls `BCF.cancelTradeFromStash(bobStashTradeId)` → revert `UnauthorizedCaller`
- **Cancel for non-stash trade:** anyone calls `BCF.cancelTradeFromStash(aliceDirectListedTradeId)` → revert `NotStashListed`
- **Cancel for non-existent trade:** call `BCF.cancelTradeFromStash` with a tradeId LST has no record of → revert `TradeNotFoundOrInvalid`
- **Cancel cross-stash spoof attempt:** call `bobStash.cancelLstTrade(carolStashTradeId)` directly (where the tradeId belongs to Carol's stash) → reverts at `LST.cancelTrade` because Bob's stash isn't trade.seller. Confirm Bob's NFT approvals for Carol's serial are unchanged (defensive: nothing got revoked).
- **Post-detach cancel:** owner detaches stash, then calls `stash.cancelLstTrade` directly (skipping BCF) → succeeds; verify allowance revoked
- **Bug 1 regression test:** call `BCF.createTradeOnBehalfOfStash` from a stash that doesn't hold the serial → revert with `UserDoesNotOwnOrHasNotApprovedNFT` (deferred to LST)
- **Bug 5 leak regression:** if Bug 5 fix were absent, a list → cancel → mirror-read of NFT allowance would show LST still approved. Test asserts the allowance IS revoked (positive test).

### Stash-as-NFT-sender (rescueNFT/withdrawNFTs)
- **rescueNFT with EOA HBAR allowance:** owner sets `setHbarAllowance(eoa, stash, 1 HBAR)`, then `rescueNFT` succeeds (already added in current iteration)
- **rescueNFT without EOA HBAR allowance:** reverts `HTSCallFailed(292, "XFER")` — document for frontend

### Detach interaction
- **Post-detach revoke:** owner detaches stash, calls `approveHbarTo(LST, 0)`, verifies allowance is 0
- **Pre-detach perpetual:** verify that a stash WITHOUT post-detach revoke still has the old allowance (negative test — surfaces the documented behavior)

All tests follow the established methodology: typed `expectRevertNamed`, mirror-first reads, `MIRROR_DELAY` sleeps, Clean-up describe sweeps.

---

## Pre-implementation checklist

- [ ] Confirm HIP-906 `hbarApprove` / `hbarAllowance` are deployed on Hedera testnet at the expected selectors (live test: small script that calls `address.call(hbarApprove(...))` against a fresh account)
- [ ] Verify the HederaTokenService `approveNFT` precompile is functional on Hedera testnet (smoke test from a throwaway contract)
- [ ] Compile current BidderContract + BCF, capture bytecode size baseline
- [ ] After implementation, recompile and confirm both under 24,576 bytes
- [ ] Update `docs/v0.3-integration-guide.md` with the EOA → stash HBAR allowance step (frontend prerequisite for any NFT withdrawal flow)
- [ ] Update `docs/CLAUDE-FRONTEND-CONTEXT.md` with the new approval functions
- [ ] Add `ARB_SETTLE_MAX_BPS`-style public constants for `CUSTODY_HOP_ALLOWANCE_REFILL` and `CUSTODY_HOP_ALLOWANCE_FLOOR` so the frontend can read them

---

## Effort estimate

- BidderContract changes: ~120-160 lines (4 external functions + 3 internal helpers + constants + errors + defensive decode guards)
- BidderContractFactory changes: ~60 lines (drop `seller` param, add `stashOwnerOf`, add `cancelTradeFromStash` orchestrator, add `TradeCancelledFromStash` event)
- BidderContract.createTrade fix (Bug 1 + 2): ~10 lines
- Tests: ~500 lines (allowance plumbing + stash-flow tests + cancel orchestrator + edge cases)
- Total: ~700 lines + 1 day audit pass + 1 day mainnet validation against a fresh deploy

Critical path for v0.3 mainnet. Without this, every stash-mediated trade flow is broken and stash-listed trades cannot be cancelled.

## Reconciliation with `BCF-StashInitiatedListing-DESIGN.md`

The companion doc covers the listing flow at the agentic-layer level (DIPLOMAT use case, agent envelopes, $LAZY cost bypass). This doc supersedes it on three points:

1. **Final `createTradeOnBehalfOfStash` signature** lives here. The companion doc's signature is correct in spirit but predates the Bug 1/Bug 2 analysis. Single canonical signature: `(token, serial, buyer, hbarPrice, lazyPrice, expiryTime, agentKey)` — no `seller` parameter.
2. **The cancel flow** (not covered in the companion doc) is specified here. `BCF.cancelTradeFromStash(tradeId)` is the EOA-callable cancel entry point.
3. **NFT allowance management** (also not covered there) — the listing flow now sets per-serial NFT allowance to LST inside `BidderContract.createTrade`; cancel revokes atomically.

The companion doc gets a top-of-file cross-reference pointing here for the final signature spec.

---

## Out of scope

- Open-market stash listings (would require new $LAZY listing-cost path through the stash, separate design)
- LSH fee discount preservation for stash-listed trades (Bug 3 — requires LST contract change to add a `beneficiary` field or LSH-tier resolver hook; deferred to post-v0.3)
- Multi-spender HBAR allowance batching (no current use case)
- All-serials NFT approval (`setApprovalForAll`) — deliberately omitted on security grounds
- HIP-906 fallback if the system contract isn't available (Hedera mainnet has it; defensive paths add bytecode without buying anything)

---

*Cross-references: `SECURITY.md` "Royalty Handling" section; `CLAUDE.md` "Hedera gas model" section; `BCF-StashInitiatedListing-DESIGN.md` (the listing-flow design this document layers on top of).*
