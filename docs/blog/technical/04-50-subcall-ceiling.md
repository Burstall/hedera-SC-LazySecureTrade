# Hedera's 50-subcall ceiling — how it shapes batch operations

> **Audience:** Solidity developers porting Ethereum patterns to
> Hedera, especially ones who deal with batch operations or
> precompile-heavy flows.
> **Read time:** ~9 minutes.
> **Last updated:** 2026-05-27.

Hedera has a constraint Ethereum doesn't: **each transaction
can make at most 50 cross-contract calls (subcalls)**. The
limit applies to every `CALL` opcode plus every interaction
with a Hedera precompile (HTS, HCS, HASC). Burn through 50
and the transaction reverts.

This is a foundational design constraint for LazySecureTrade
and probably the single most important Hedera-specific thing to
internalize. Once you have it in your head, the rest of LST's
batch sizing decisions stop looking arbitrary.

## Where the budget goes

For a single LST trade — one NFT, one buyer, one seller — here's
roughly how the subcalls allocate:

| Step | Subcalls |
|---|---|
| LSH tier check (`balanceOf` × 3, `LDR.getSerialsDelegatedTo` × 0-3 in degraded path) | 1-6 |
| LAZY listing-fee draw (open-market trades, via LGS) | 2-3 |
| HTS 2-step NFT transfer (cryptoTransfer + transferFrom) | 4-6 |
| HBAR payment to seller (low-level call) | 1-2 |
| Royalty distribution (cryptoTransfer to royalty recipient) | 2-3 |
| **Per-trade total** | **~15-20** |

For a 22-item batch trade (the current `BATCH_SIZE_LIMIT`),
that's at the edge of the budget — and we got there only by
aggressive trimming. Two big wins shaped LST:

1. **Tier-check caching.** The LSH tier resolution used to fire
   per-item; now it's cached frame-locally via `LSHTierLib`'s
   short-circuit-on-first-positive pattern. Gen 1 holders pay 1
   subcall for tier, not 6.
2. **Removed `validateTokenAssociations`** (v0.2 cleanup). The
   helper was sprinkled into batch loops to defensively verify
   tokens were associated. We replaced it with a pre-flight view
   (`isTokenAssociated`) that consumers call once before the
   batch — saves N × (1 subcall) where N is batch size.

## Why 50?

Hedera's consensus model includes a per-transaction work cap as
a DoS defense. The 50-subcall ceiling is the gas-equivalent
limit for cross-contract calls specifically — distinct from gas
limits, which are also enforced but rarely the binding
constraint for marketplace-style contracts (most marketplace
operations hit the subcall ceiling first).

You can't raise the limit. It's a network parameter, not a
contract-level one. So either your design fits in 50 or your
batch sizes get smaller.

## What counts as a subcall

The trap is that "subcall" is broader than you'd guess from
Ethereum experience.

**Counts as a subcall:**
- Every `CALL` opcode, including library function calls if the
  library is NOT statically linked.
- Every interaction with the HTS precompile at `0x167` — even a
  read like `IERC20.balanceOf()` if the token is HTS-native.
- Every interaction with the HCS precompile (`0x167`+, varies),
  HASC (`0x16a`), and other Hedera-specific precompiles.
- Every `staticcall` to another contract (though `view`
  functions called within your own contract don't count).
- Every event emission to a non-self contract — actually no,
  events don't count. (One of the few non-traps.)

**Does NOT count as a subcall:**
- Calls between functions of the same contract (compiler
  inlines or uses JUMP).
- Statically-linked library calls (the library bytecode is
  inlined at compile time; runtime sees a JUMP, not a CALL).
- `keccak256`, `ecrecover`, and the standard EVM precompiles
  at addresses `0x01-0x09`. These are *EVM* precompiles, not
  Hedera precompiles, and they're treated as opcodes.
- Storage reads/writes to your own contract.
- HBAR transfers via `payable(addr).call{value:x}("")` —
  these are CALLs but they don't trigger code execution at the
  recipient (if it's an EOA), so they're not counted against
  the subcall budget. (Verified empirically; behavior could
  shift in future Hedera versions.)

The big one to internalize: **every `IERC20.balanceOf(user)`
on an HTS token is a subcall.** A naive "loop over 10 tokens and
sum balances" eats 10 subcalls before doing anything else.

## How LSHTierLib threads this needle

The tier check is a great worked example.

Naive pattern would be: "For each tier source, ask LDR if user
has delegated tokens. For each holding source, check balanceOf."
That's 6 subcalls minimum per tier check.

LSHTierLib short-circuits at the first positive match:

```solidity
function getTierFor(address user, TierSources memory sources) internal view returns (Tier) {
    // Holdings first — cheapest path.
    if (IERC721(sources.lshGen1).balanceOf(user) > 0) return Tier.Platinum;  // 1 subcall
    if (IERC721(sources.lshMutant).balanceOf(user) > 0) return Tier.Gold;     // 2 subcalls
    if (IERC721(sources.lshGen2).balanceOf(user) > 0) return Tier.Silver;     // 3 subcalls

    // Staking — single subcall for the entire staked set.
    if (sources.lazyNFTStaking != address(0)) {
        Tier stakedTier = _stakingTier(...);                                    // 4 subcalls
        if (stakedTier == Tier.Platinum) return Tier.Platinum;
        // ... fallback to delegation
    }

    // Delegations — up to 3 subcalls if user has nothing.
    return _delegationTier(sources, user);                                      // 5-7 subcalls
}
```

A Gen 1 holder costs 1 subcall. A non-holder with no staking or
delegation costs 7. That asymmetry matters: most active users
are LSH holders, so the average cost is closer to 2-3 subcalls,
not 7.

Then in the consumers (LST, EA), `LSHTierLib` is **statically
linked** — its bytecode is inlined into the consumer at compile
time. The 1-subcall cost only counts the actual HTS / LDR calls
the library makes; calling into the library itself is a JUMP, not
a CALL.

If we'd built `LSHTierLib` as a separate contract that LST/EA
call into, each tier resolution would cost +1 subcall just for
the library hop. Statically linked we eat the bytecode in LST/EA
(~150 B per consumer) and save the subcall.

## Where LST hit the ceiling

Real-world examples that constrain LST's design:

**Batch trade size cap of 22 items.** With ~15-20 subcalls per
trade, 22 items × 1.5 subcalls/item amortized comes out to ~30
amortized + ~12 setup overhead ≈ 42. Leaves a slim margin.
We picked 22 specifically to keep ~8 subcalls of headroom for
edge cases (unexpected royalty branches, LAZY draws on the path).

**`executeTrades` capped at 5 trades.** Different code path than
`createBatchTrade` — it's a wrapper that calls `executeTrade`
repeatedly, and each inner trade does a full 2-step NFT custody
hop (seller → contract → buyer = 2 transfers) plus an optional
LAZY payment leg and seller ownership/approval checks. That's far
more subcall-dense per item than a batch *listing*, so the cap is
much tighter: 5 trades keeps the worst case comfortably under the
50-subcall ceiling.

**Validated-association removal.** We used to have a helper that
verified the token was associated before each transfer in a
batch loop. That added 1 subcall × N items. Removed in v0.2;
callers now check `isTokenAssociated(token)` once before the
batch.

## Tactics for staying under the ceiling

If you're building on Hedera, here's the toolkit.

**1. Statically link libraries.** OpenZeppelin's `Clones`,
`SafeCast`, `Bits` — all use the `library` keyword and inline
at compile time. Your own utilities should too.

**2. Cache reads in storage.** If you'll read a value multiple
times in one tx, read it once into a local var. HTS balanceOf
called 3 times in a function = 3 subcalls; cached in a memory
var = 1.

**3. Bundle related operations.** HTS's `cryptoTransfer` can
move multiple tokens AND HBAR in a single subcall. Use it
instead of splitting into per-token transfers.

**4. Pre-check, don't loop-check.** If a precondition needs to
be true for an entire batch, check it once before the loop, not
on each iteration.

**5. Document your subcall budget.** In the contract's NatSpec.
Future you (or the next contributor) will thank you. LST's
critical paths have subcall-cost comments and the design docs
break out the budgets per operation.

## When the ceiling pushes back

A few times in v0.3 we wanted a feature but the subcall budget
killed it.

**`LDRDegraded` event.** Proposed as a way for ops to detect
when LDR is misbehaving. Would have added 3 inlined emits per
tier resolution (one per LDR call) — each emit is "free"
subcall-wise, but the bytecode cost combined with the
non-view cascade put LST over the 24 KiB ceiling.

**Per-trade tier override.** Considered letting users pass a
"tier hint" that the contract verifies against storage. Saves
LDR calls if user provides hint, falls back to library if not.
Bytecode cost outweighed the saving for the common case (most
users don't bother with hints).

**Aggregate fee receiver.** "Send all platform fees to one
address" was discussed as a way to save the `Address.sendValue`
subcall on every trade. Turned out the bookkeeping cost
outweighed the saving — and the subcall was small in the first
place.

The lesson: 50 subcalls is not a hard wall, but it's a real
constraint. Every feature has to budget against it, and
sometimes the answer is "we'd love that, but it doesn't fit."

## Cross-reference: gas

Gas is also enforced. The Hedera gas budget is ~15 million per
transaction. For marketplace ops, you usually hit the subcall
ceiling before you hit the gas ceiling, so subcalls are the
binding constraint. But the gas budget matters for setup-heavy
operations like:

- **`deployStash`** — minimal proxy clone deployment costs
  ~1.5M gas. Not a problem normally, but if you're deploying
  multiple stashes in a batch (e.g., `deployStashFor`
  permissionlessly), you can hit the 15M ceiling at ~10
  deployments.
- **First-time HTS token association** — ~1M gas per
  association. The reason we don't auto-associate inside loops.

For most user-initiated single-tx flows, gas is generous.

## Summary

| Pattern | Subcall cost |
|---|---|
| `IHTSToken.balanceOf(user)` | 1 |
| `IHederaTokenService.cryptoTransfer(...)` | 1 |
| Library function (statically linked) | 0 |
| Library function (separate contract) | 1 + lib's internal |
| Same-contract function call | 0 |
| Storage read | 0 |
| Storage write | 0 |
| Event emission | 0 |
| Low-level CALL to EOA | 0 (if recipient is EOA) |
| Low-level CALL to contract | 1 |

Budget your flows against 50 total. Aim for ≤30 to leave
headroom. If you can't fit, split into multiple transactions.

## Reference

- The 50-subcall constraint is documented in Hedera's
  network spec; the value is enforced at the
  network-services layer, not in EVM bytecode.
- LST's per-trade budget is captured in
  [`docs/AGENT-MARKETPLACE-DELTA.md`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/docs/AGENT-MARKETPLACE-DELTA.md)
  "Constraint 3 — Hedera-native budget math."
- The CUSTODY_HOP design is in
  [`contracts/TokenStakerV2.sol`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/contracts/TokenStakerV2.sol)
  — specifically `moveNFTs`.
