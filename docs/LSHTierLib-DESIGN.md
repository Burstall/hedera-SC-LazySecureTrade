# LSHTierLib — Library Design Doc

**Status:** Pre-implementation design.
**Companion to:** `docs/AGENT-MARKETPLACE-DELTA.md` (decision context), `docs/VIPSubscription-DESIGN.md` (the discount-table consumer of this tier model).
**Supersedes (in part):** `docs/VIPRegistry-DESIGN.md` (split into this library + `VIPSubscription`).
**Target release:** v0.3 mainnet (critical path).

---

## Purpose

Statically-linked Solidity library that computes a user's LSH tier from their on-chain holdings and delegations. Used by every consumer contract that needs trade-fee-discount tiering: LST v2, BCF stash settlement paths, EnglishAuction, LazyLotto.

Single source of truth for the LSH-holder check that currently sits inline in `LazySecureTrade.getLSHTokenTier` AND `LazyTradeLotto.sol:495-503` (6-subcall duplicate). DRY without paying the cross-contract-call subcall cost.

---

## Why a library, not a contract

Decision history (see `AGENT-MARKETPLACE-DELTA.md` v3+):

We considered a `LSHTierRegistry` contract. The tradeoff that closed the decision:

- The LSH set (Gen 1 / Mutant / Gen 2) is treated as **prestige-fixed** for trade-fee purposes. Adding a Gen 3 to free-trade eligibility is an event that already warrants coordinated consumer redeploys (token associations, audit, communication). It's not a hot-path update.
- The fee tier evolution that DOES happen frequently — adding new tokens to the *discount table*, tweaking discount magnitudes — lives in `VIPSubscription`, which is a contract with an admin-tunable discount table.
- Library wins: no per-trade subcall overhead, simpler bytecode footprint per consumer.

Net: free trades are scoped to the canonical LSH trinity (library-fixed); broader purchase-discount mechanics are flexible (VIPSubscription-tunable).

---

## Tier model

```solidity
enum Tier { Free, Silver, Gold, Platinum }
```

| Source | Resulting tier |
|---|---|
| LSH Gen 1 (owned, delegated, or staked) | Platinum |
| LSH Mutant (owned, delegated, or staked) | Gold |
| LSH Gen 2 (owned, delegated, or staked) | Silver |
| None of the above | Free |

Staking is included in v1 — confirmed cheap (1 subcall, returns 2D memory array of all stakes; library iterates in memory). Stakers retain their tier; this delivers the "stakers get free trades for their agents" property without a separate code path.

Note: tier ordering on discount magnitude is **Free < Silver < Gold < Platinum** (Platinum gets the biggest fee discount). This matches the current LST semantic where Gen 1 = 100% off, Mutant = 75% off, Gen 2 = 50% off — just renamed to tiers. Consumers translate tier → fee bps themselves.

The library does NOT include `Bronze` — that's a `VIPSubscription`-only tier (paid, not holding-derived). Free-trade benefits don't extend to Bronze.

---

## Interface

```solidity
library LSHTierLib {

    enum Tier { Free, Silver, Gold, Platinum }

    struct TierSources {
        address lshGen1;
        address lshMutant;
        address lshGen2;
        address lazyDelegateRegistry;
        address lazyNFTStaking;   // optional; address(0) = skip staking check
    }

    /// @notice Returns the user's tier from LSH holdings, delegations, and staking.
    /// @dev Short-circuits on first positive match in tier-priority order.
    /// Subcall budget per case:
    ///   - Gen 1 holder:        1 subcall (best case)
    ///   - Mutant holder:       2 subcalls
    ///   - Gen 2 holder:        3 subcalls
    ///   - Staked only:         4 subcalls (single getStakedNFTs call returns all)
    ///   - Delegated Gen 1:     5 subcalls
    ///   - Delegated Mutant:    6 subcalls
    ///   - Delegated Gen 2:     7 subcalls (worst case)
    ///   - No anything:         7 subcalls
    function getTierFor(address user, TierSources memory sources)
        internal view returns (Tier);

    /// @notice Convenience: is the user any kind of LSH-tier holder?
    /// Same short-circuit cost as getTierFor (returns on first positive).
    /// LazyLotto's primary call site.
    function isAnyHolder(address user, TierSources memory sources)
        internal view returns (bool);
}
```

Library functions are `internal view` because static linking inlines them at compile time. Consumers don't pay a cross-contract-call subcall; they pay the bytecode cost of the inlined functions.

**Token addresses are passed via struct**, not stored in the library. Consumers store their own LSH token addresses (typically as immutables from constructor) and construct the `TierSources` struct at call time. Keeps the library stateless. The struct shape also future-proofs against adding a 4th LSH token (just adds a field — consumers update independently).

---

## Short-circuit algorithm

```solidity
function getTierFor(address user, TierSources memory s)
    internal view returns (Tier)
{
    // Holdings first — cheapest path
    if (IERC721(s.lshGen1).balanceOf(user) > 0)   return Tier.Platinum;  // 1 subcall
    if (IERC721(s.lshMutant).balanceOf(user) > 0) return Tier.Gold;       // 2 subcalls
    if (IERC721(s.lshGen2).balanceOf(user) > 0)   return Tier.Silver;     // 3 subcalls

    // Staking — one call returns all stakes across collections, iterate in memory
    if (s.lazyNFTStaking != address(0)) {
        (address[] memory cols, ) = ILazyNFTStaking(s.lazyNFTStaking).getStakedNFTs(user);
        // 4 subcalls. The staking call returns memory arrays; subsequent
        // iteration is pure in-memory and costs no additional subcalls.
        Tier stakedTier = Tier.Free;
        for (uint i = 0; i < cols.length; i++) {
            if (cols[i] == s.lshGen1)   return Tier.Platinum;  // can short-circuit
            if (cols[i] == s.lshMutant && stakedTier < Tier.Gold)   stakedTier = Tier.Gold;
            if (cols[i] == s.lshGen2   && stakedTier < Tier.Silver) stakedTier = Tier.Silver;
        }
        if (stakedTier != Tier.Free) return stakedTier;
    }

    // Delegations — same priority order, wrapped in try/catch for LDR resilience
    if (_safeDelegatedLength(s.lazyDelegateRegistry, user, s.lshGen1) > 0)   return Tier.Platinum;  // 5 subcalls
    if (_safeDelegatedLength(s.lazyDelegateRegistry, user, s.lshMutant) > 0) return Tier.Gold;       // 6 subcalls
    if (_safeDelegatedLength(s.lazyDelegateRegistry, user, s.lshGen2) > 0)   return Tier.Silver;     // 7 subcalls

    return Tier.Free;
}
```

Critical: tier ordering is hard-coded by check sequence. Platinum (Gen 1) checked first; first positive match wins. Cannot be reordered without breaking the highest-tier-wins semantic.

Staking check is placed between holdings and delegations: most staking users still hold an LSH NFT directly (so they short-circuit at the holdings checks), and the staking call is a single subcall returning all data, so it's a good single-source check before falling through to per-token delegation queries.

`isAnyHolder` is the same shape but returns `bool` on first positive.

---

## LDR resilience (carried from LST's existing handling)

Per `CLAUDE.md`: `LazyDelegateRegistry` is immutable and has known bugs. LST currently wraps LDR calls in try/catch via `_safeGetDelegatedLength` to prevent an LDR revert from bricking trade execution. The library must do the same:

```solidity
function _safeDelegatedLength(
    address ldr,
    address user,
    address token
) private view returns (uint256) {
    try ILazyDelegateRegistry(ldr).getSerialsDelegatedTo(user, token) returns (uint256[] memory serials) {
        return serials.length;
    } catch {
        return 0;  // degrade gracefully — user falls back to non-delegated tier sources
    }
}
```

Each delegation check uses this helper. If LDR reverts, the user just doesn't get a delegation-based tier — the holdings path still works.

This matches the production behavior of LST today; preserving it is non-negotiable for safe deploy.

---

## Bytecode footprint

Estimated per-consumer cost:
- `getTierFor` body: ~600-800 bytes
- `isAnyHolder` body: ~400-500 bytes (if separately implemented; can share with getTierFor)
- Try/catch wrapper: ~200 bytes
- Interface imports + struct shimming: ~300 bytes

**Total per consumer: ~1.5-2 KiB.** Multiplied across LST v2 + BCF + Auction + Lotto: ~6-8 KiB total bytecode cost across the ecosystem.

Verify via `hardhat-contract-sizer` after first compile against a real consumer. If any consumer is already close to the 24 KiB limit (LST historically sits at 22.5-23.9 KiB per CLAUDE.md), bytecode pressure becomes a real consideration.

**Contingency:** if a consumer can't accommodate the inlined library, fall back to a thin `LSHTierResolver` contract that the consumer calls (1 extra subcall, no bytecode pressure). Same source-level interface, different deploy strategy.

---

## Integration: consumer-by-consumer

### LST v2 (current v0.3 branch → mainnet)

Replaces internal `getLSHTokenTier(user)`:

```solidity
import { LSHTierLib } from "./libraries/LSHTierLib.sol";

contract LazySecureTrade {
    address public immutable LSH_GEN1;
    address public immutable LSH_MUTANT;
    address public immutable LSH_GEN2;
    address public immutable LDR;

    function _resolveFeeTier(address user) internal view returns (LSHTierLib.Tier) {
        return LSHTierLib.getTierFor(user, LSH_GEN1, LSH_MUTANT, LSH_GEN2, LDR);
    }

    function _resolveFeeBps(LSHTierLib.Tier tier) internal pure returns (uint16) {
        if (tier == LSHTierLib.Tier.Platinum) return 0;       // 100% off
        if (tier == LSHTierLib.Tier.Gold)     return 25;      // 75% off (1% × 25%)
        if (tier == LSHTierLib.Tier.Silver)   return 50;      // 50% off
        return 100;  // Free tier — base 1% fee
    }
}
```

Subcall cost per trade: 1-6 subcalls in the library call (was 6 inline). Net saving for Gen 1 holders (most common cohort): 5 subcalls per trade.

For batch trades: resolve tier ONCE per batch, pass through memory across items. Zero additional subcalls per item beyond the first.

### BCF stash settlement path

When a stash-mediated trade routes through LST or directly settles a bid, the stash needs the OWNER's tier (not the stash's, which is always Free):

```solidity
function _resolveOwnerTier() internal view returns (LSHTierLib.Tier) {
    return LSHTierLib.getTierFor(owner, LSH_GEN1, LSH_MUTANT, LSH_GEN2, LDR);
}
```

Same library call, just with `owner` instead of `msg.sender`. Honors the design promise that "stakers/holders get free trades for their agents" — agents acting through the stash inherit the owner's tier.

### EnglishAuction (when shipped)

Same pattern as LST v2. Resolves tier for both seller (listing fee discount) and bidder (no fee impact in standard model but reserved).

```solidity
function settle(uint256 auctionId) external {
    Auction storage auction = auctions[auctionId];
    LSHTierLib.Tier sellerTier = LSHTierLib.getTierFor(
        auction.seller, LSH_GEN1, LSH_MUTANT, LSH_GEN2, LDR
    );
    // ... apply tier-based discount on settlement fee
}
```

### LazyLotto

Two integration points, depending on lotto product design:

**(a) Boolean-only (matches current `LazyTradeLotto.sol:495-503` behavior):**

```solidity
import { LSHTierLib } from "./libraries/LSHTierLib.sol";

bool isHolder = LSHTierLib.isAnyHolder(user, LSH_GEN1, LSH_MUTANT, LSH_GEN2, LDR);
// Net delta in LazyTradeLotto: ~6 lines deleted (the inline check),
// 1 line added. ~3-5 KiB bytecode saved (loses three IERC721 ABI imports
// and the inline delegation calls). Library adds ~1.5-2 KiB back.
// Net bytecode: roughly neutral, but logic is now centrally maintained.
```

**(b) Tiered odds / pot sizing (future enhancement):**

```solidity
LSHTierLib.Tier tier = LSHTierLib.getTierFor(user, LSH_GEN1, LSH_MUTANT, LSH_GEN2, LDR);
uint256 oddsMultiplier = _oddsForTier(tier);
```

LazyLotto's product owner can pick (a) for the migration MVP and (b) later if tiered lotto mechanics ship.

### Future consumers

Any contract that needs LSH-tier semantics for trade fees follows the same pattern. The library has no dependencies beyond the three LSH token addresses + LDR address.

---

## Adding a new LSH collection — process

If/when a "Gen 3" or new LSH-prestige token launches:

1. Decide whether it grants **free-trade benefits** or **only purchase-discount benefits**:
   - Free trades → requires library update + coordinated consumer redeploy (next major release)
   - Purchase discount only → just add it to `VIPSubscription.setDiscount(...)` — no redeploys needed

2. For free-trade extension:
   - Add the new collection's token address as an immutable to each consumer (constructor parameter)
   - Update `LSHTierLib.getTierFor` signature to accept the new token + map it to a tier (likely top — but a product call)
   - Coordinate testnet → mainnet deploy across all consumers
   - Bytecode cost: +200-400 bytes per consumer for the new check

3. For purchase-discount-only extension:
   - VIPSubscription admin call: `setDiscount(newToken, tier, discountBps, allowedSerials)`
   - Zero contract changes; immediate effect

Most evolutionary additions go (3). (2) is reserved for prestige-defining additions.

---

## Test plan outline

Following `feedback_test_methodology.md`:

- **Tier resolution correctness:**
  - Gen 1 holder only → Platinum
  - Mutant holder only → Gold
  - Gen 2 holder only → Silver
  - Multiple holdings → highest tier wins (Gen 1 + Mutant → Platinum)
  - Delegated Gen 1 only → Platinum
  - Held Mutant + Delegated Gen 1 → Platinum (max across sources)
  - No holdings/delegation → Free
- **LDR resilience:**
  - Mock LDR reverting on `getSerialsDelegatedTo` → tier falls back to holdings only
  - Mock LDR returning empty → equivalent to "no delegation"
- **Short-circuit cost:**
  - Empirically measure subcall count via gas trace for each tier-result path
  - Confirm Gen 1 holder path = 1 subcall, no-holder path = 6 subcalls
- **Batch tier memoization (consumer-side):**
  - Single batch of 22 items: tier resolved 1 time, used 22 times
  - Confirm total subcalls for batch = `single_trade_subcalls + (21 × per_item_subcalls_excluding_tier)`
- **Integration smoke tests:**
  - LST v2 trade with Gen 1 holder → fee = 0
  - BCF stash trade via owner with Mutant → fee = 25 bps (Gold tier)
  - LazyLotto migration test → `isAnyHolder` returns true for any LSH holder

---

## Pre-implementation probe checklist

- [ ] Compile a stub consumer with `LSHTierLib` inlined → measure bytecode delta. Confirms ~1.5-2 KiB estimate.
- [ ] Probe LDR behavior on `getSerialsDelegatedTo` for an address with zero delegations (returns empty array vs reverts). Verifies the try/catch path is needed.
- [ ] Measure actual subcall counts via Hedera transaction record for each tier-resolution path against a testnet consumer.

---

## EIP-1153 transient storage — available, not used

Hedera supports the Cancun opcode set including `TLOAD`/`TSTORE`. The library could memoize the tier result in transient storage so subsequent calls in the same tx return without recomputation. **Not adopted in v1** because:

- The common case (one consumer resolving tier for a batch) is handled by frame-local memory variables — zero extra subcalls per item beyond the first
- Memoization would require making the library non-view (`tstore` is a write), which restricts callable contexts
- Cross-consumer memoization (LST + Auction both resolving the same user in one tx) is rare in practice

If a real demand surfaces for cross-call memoization, add a parallel non-view `getTierForMemoized` function later without breaking the existing pure-view surface.

## Out of scope (for this library)

- Subscription tier (paid VIP) — `VIPSubscription`'s concern.
- Staking-based tier — currently NOT included in this library. Consumers wanting "stakers trade free for their agents" semantic should consult `LazyNFTStaking.getStakedNFTs(user)` separately, OR we extend the library signature in a future version.
- Cache layer — explicitly dropped; direct check is always fresh.
- Signed-proof off-chain attestation — dropped.

---

## Resolved: staking included in v1

`LazyNFTStaking.getStakedNFTs(user)` confirmed cheap (1 subcall, returns memory arrays — no internal fan-out). Staking is included from day one. Library signature reflects this; no v0.3.1 patch needed.

## Open question — VIP subscription as a tier source

Pending architectural decision: should consumers also consult `VIPSubscription.getTierFor(user)` and take the max with the library result? Implications:

- **If yes:** consumers get one more subcall per trade (~1) but paid Bronze+ subscribers automatically receive trade-fee discounts. Loaner attack on subscription becomes a soft path to free trades for the sub duration (mitigated by 14-day serial cooldown + sub purchase cost).
- **If no:** trade fees stay strictly tied to live LSH holdings/delegation/staking. Subscriptions only gate agent framework + premium features. Cleaner segregation; preserves the original loaner-attack guarantee for trade fees.

Consumer-side code is symmetric either way — they call `LSHTierLib.getTierFor(user, sources)`, then optionally `vip.getTierFor(user)` and take the max. The library itself doesn't change; the question is whether consumers wire up the VIP check.

Pending confirmation in `AGENT-MARKETPLACE-DELTA.md` decisions table.

---

*Companion doc: `VIPSubscription-DESIGN.md` for the paid-tier discount and subscription flow.*
