# LazyRebatePool — Design Doc

> **Status:** ✅ Implemented (2026-05-27). Live at
> `contracts/LazyRebatePool.sol` + `contracts/LSHRebateMultipliers.sol`
> + the 3-sink split patch on `contracts/VIPSubscription.sol`. Test
> coverage at `test/RebateStack.test.js`. Off-chain epoch compute
> skeleton at `scripts/ops/computeRebateEpoch.js`.

**Companion to:** `docs/VIPSubscription-DESIGN.md` (the upstream
revenue source), `docs/AGENT-MARKETPLACE-DELTA.md` (the original
Q2 tokenomic proposal), `docs/AGENT-MARKETPLACE-RECONCILIATION.md`
(the gap-closure context).

**Target release:** v0.3 mainnet — shipped.

---

## Purpose

Close the loop: **stake LSH → earn $LAZY from marketplace subscription
revenue → spend $LAZY back into the system.** A portion of every
subscription purchase flows into a rebate pool that's distributed to
active LSH stakers quarterly (or ad hoc) via Merkle-proof claims.

## What gets rebated

VIPSubscription's `purchaseSubscription` does a 3-sink split via LGS:

- **Burn slice** (`burnPercentage`, default 50%) — LGS burns this
  fraction of the user's payment.
- **Rebate slice** (`rebateBps`, default 1000 bps = 10%) — LGS
  pays out this amount to `LazyRebatePool` from its treasury.
- **Team slice** (`teamBps`, default 0) — LGS pays out to a
  multisig/team operations wallet from treasury.
- **Residual** — stays on LGS as protocol treasury.

The split is configured as **percentages of the original 100**,
not the post-burn remainder. If `burn + rebate + team > 100%`,
LGS dips into its existing treasury to cover the difference (LGS
is well-funded; this is operationally fine).

Worked example: 100 LAZY subscription fee, 50% burn, 25% rebate,
50% team:
- 50 LAZY burnt (LGS handles)
- 25 LAZY → rebate pool (paid from LGS treasury)
- 50 LAZY → team wallet (paid from LGS treasury)
- LGS net change: +50 (from user, post-burn) - 75 (paid out) = -25
- The -25 comes from LGS's existing treasury balance.

Owner controls all three knobs:
- `setRebateBps(uint16)` — capped at MAX_REBATE_BPS (50%)
- `setTeamBps(uint16)` — capped at MAX_TEAM_BPS (50%)
- `setBurnPercentage(uint256)` — existing setter, capped at 100%
- `setRebatePool(address)` — `address(0)` disables rebate flow
- `setTeamWallet(address)` — `address(0)` disables team flow

## How "active staker" is determined

**Off-chain.** The contract does NOT know about staking. The
audit trail is the off-chain computation in
`scripts/ops/computeRebateEpoch.js`.

The team's compute process:

1. Read all `Staked` / `Unstaked` events from LazyNFTStaking for
   the epoch window via mirror node.
2. Reconstruct per-NFT timeline: for each (token, serial), the
   sequence of (owner, stake-period) tuples during the window.
3. For each timeline, compute the time-weighted stake contribution:
   `(period_seconds / epoch_seconds) × token_multiplier`.
4. Sum per-user across all their staked NFTs.
5. Apply minimum-stake-duration filter (default 14 days).
6. Allocate pool LAZY pro-rata of total user units.
7. Build Merkle tree over `keccak256(user, amount)` leaves.
8. Publish root to LazyRebatePool via `settleEpoch`.
9. Frontend reads root + audit JSON; users present proofs to
   claim.

**Rebate goes to whoever owns the NFT at epoch close.** If Alice
staked the NFT for the first half of the epoch and transferred to
Bob (via stash withdraw + re-stake) for the second half, Bob —
the current owner — earns Alice's accrued time-weighted units
plus his own. (Good for Bob; Alice forfeited by transferring.)

## Token multipliers

Hardcoded in `LSHRebateMultipliers.sol` (immutable per deploy).
Scaled by 10 for integer math:

| NFT | Scaled weight | Raw units | Max tokens | Max units |
|---|---|---|---|---|
| Gen 1 | 50 | 5.0 | 100 | 5,000 |
| Mutant | 25 | 2.5 | 100 | 2,500 |
| LSV (Gen 2 serials 5001-5100) | 25 | 2.5 | 100 | 2,500 |
| Gen 2 (other serials) | 10 | 1.0 | 5,000 | 50,000 |
| **Total** | | | | **60,000 scaled units** |

If every eligible NFT is staked, the minimum per-unit value is
`poolBalance / 60_000`. In practice fewer NFTs are staked, so
actual per-unit value is higher.

Frontend uses `LSHRebateMultipliers.getMultiplier(token, serial)`
or `getMultipliers(tokens[], serials[][])` for batched queries to
display weights.

## Contract surface

### LazyRebatePool

```solidity
contract LazyRebatePool is Ownable, ReentrancyGuard, HederaTokenService {
    address public immutable LAZY_TOKEN;
    address public signer;                       // owner-rotatable
    uint256 public currentEpoch;                  // 1-indexed
    uint64 public epochClaimWindowSeconds;        // 30-1095 days bound
    bool public lazyAssociated;

    struct Epoch {
        bytes32 merkleRoot;
        uint256 totalAllocated;
        uint256 totalClaimed;
        uint64 settledAt;
    }
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bool)) public claimed;

    // Admin
    function associateLazy() external onlyOwner;  // one-shot
    function setSigner(address) external onlyOwner;
    function setEpochClaimWindowSeconds(uint64) external onlyOwner;
    function rescueLazy(address to, uint256 amount) external onlyOwner;

    // Signer-only
    function settleEpoch(bytes32 root, uint256 totalAllocated) external onlySigner;

    // User-facing
    function claim(uint256 epoch, uint256 amount, bytes32[] proof) external;

    // Permissionless after expiry
    function recycleExpiredEpoch(uint256 epoch) external;

    // Views
    function poolBalance() external view returns (uint256);
    function unclaimedInEpoch(uint256 epoch) external view returns (uint256);
    function isEpochExpired(uint256 epoch) external view returns (bool);
    function hasClaimed(uint256 epoch, address user) external view returns (bool);
    function verifyProof(uint256 epoch, address user, uint256 amount, bytes32[] proof)
        external view returns (bool);
}
```

### LSHRebateMultipliers

Pure-view helper. No state mutation. Frontend reference.

```solidity
contract LSHRebateMultipliers {
    address public immutable LSH_GEN1;
    address public immutable LSH_MUTANT;
    address public immutable LSH_GEN2;
    // Constants: WEIGHT_GEN1=50, WEIGHT_MUTANT=25, WEIGHT_LSV=25,
    //            WEIGHT_GEN2=10, WEIGHT_SCALE=10, MAX_UNITS_SCALED=60_000
    //            LSV_MIN_SERIAL=5001, LSV_MAX_SERIAL=5100

    function getMultiplier(address token, uint256 serial) external view returns (uint256);
    function getMultipliers(address[] tokens, uint256[][] serials)
        external view returns (uint256[][]);
    function totalWeightFor(address[] tokens, uint256[][] serials)
        external view returns (uint256 total);
    function minPerUnitValue(uint256 poolAmount) external pure returns (uint256);
}
```

## Operational flow

### Initial deploy

1. Deploy `LSHRebateMultipliers(lshGen1, lshMutant, lshGen2)`.
2. Deploy `LazyRebatePool(lazyToken, signerAddress, 365 days)`.
3. Owner calls `LazyRebatePool.associateLazy()` (one-shot HTS association).
4. Owner calls `VIPSubscription.setRebatePool(rebatePoolAddress)`.
5. Optional: `VIPSubscription.setTeamWallet(teamMultisigAddress)`.
6. Optional: `VIPSubscription.setRebateBps(...)` /
   `setTeamBps(...)` to enable/tune flow (default 10% / 0%).

### Quarterly epoch compute + settle (team-side)

1. Team runs `scripts/ops/computeRebateEpoch.js --start=X --end=Y --pool-balance=Z`.
2. Script reads mirror node for stake history, computes TWAPs,
   builds Merkle tree, emits audit JSON.
3. Team reviews the audit JSON (sanity-checks weights, allocations).
4. Team runs `--execute` to submit `LazyRebatePool.settleEpoch(root, total)`
   with the signer key.
5. `EpochSettled` event fires; frontend reads + indexes.

### User-facing flow

1. User opens frontend; sees "Rebate Available: X LAZY" for any
   epochs where they have an allocation.
2. Frontend reads the audit JSON for that epoch + computes the
   user's proof.
3. User submits `LazyRebatePool.claim(epoch, amount, proof)`.
4. LAZY transfers to the user. `RebateClaimed` event fires.

### Expiry / recycling

- Each epoch has a 1-year claim window (owner-tunable).
- After expiry, anyone calls `recycleExpiredEpoch(epoch)` —
  unclaimed portion is reconciled in the bookkeeping; the LAZY
  stays on the contract and rolls into the pool available for
  the next epoch's allocation.

## Security model

### What's protected

- **Pool can't be over-allocated.** `settleEpoch` reverts if
  `totalAllocated > poolBalance()`. The signer can't allocate more
  LAZY than the contract holds.
- **One-shot claims.** Per (epoch, user), the claim flag prevents
  double-spends.
- **Signer can only allocate, not drain.** The signer has no
  rescue function. Worst case from a compromised signer key:
  allocate the existing pool balance to attacker-controlled
  addresses, who then claim.
- **Owner can rotate the signer instantly.** `setSigner(address(0))`
  disables settlements entirely; new signer can be set at any time.
- **Owner has `rescueLazy` for catastrophic-bug scenarios.**
  Emergency escape hatch; mirrors the BidderContract rescue
  pattern.

### What's NOT protected

- **A compromised signer can misallocate the existing pool.**
  Defense: keep the signer key in cold storage / multisig at the
  ops layer; rotate periodically.
- **The off-chain compute could produce wrong allocations.** The
  audit JSON is the only check on this. Defense: publish the JSON
  + script outputs; users can recompute independently and
  challenge.
- **Front-running on claims.** Not a concern — claims are
  per-user and independent. Hedera also has no mempool, so the
  whole class of MEV doesn't apply.

## Why Merkle vs per-claim signatures

Considered both. Merkle won because:

1. **Once the root is published, signer can go offline.** Claims
   don't require ongoing signer availability. Important for
   security: signer key only used for settlement, can stay cold
   between epochs.
2. **Cleanly per-epoch.** Each epoch's allocation set is a
   discrete Merkle tree; no risk of signature replay across
   epochs.
3. **Gas: one storage write per epoch root, ~120 gas per proof
   element on claim.** Reasonable for typical proof depths (~5-7
   elements for small-to-medium user sets).
4. **Standard pattern.** Uniswap-style airdrops, OpenZeppelin's
   MerkleProof library. Well-understood by builders + auditors.

Per-claim signatures would require either tracking nonces (expensive)
or per-(epoch, user) flag anyway (same as Merkle), without the
benefit of one-time root publication.

## Why off-chain compute

The DELTA's Q2 proposal contemplated on-chain rebate accounting.
We rejected this for v0.3:

1. **Time-weighted average stake** is genuinely hard on-chain.
   Would require either iterating over stake events in the staking
   contract (subcall budget pressure) or maintaining a per-NFT
   cumulative-stake-seconds counter (storage pressure).
2. **Off-chain compute is the audit trail anyway.** Even if we
   did on-chain accounting, ops would still need to verify
   correctness against historical events. Letting the off-chain
   process be the source of truth is cleaner.
3. **Flexibility.** Multiplier table, eligibility filters,
   minimum stake duration — all tweakable off-chain without
   contract changes. On-chain versions of these would calcify
   too early.
4. **Cross-repo independence.** LazyNFTStaking lives in
   `hedera-SC-LAZY-Farms` and would need coordinated changes if
   the rebate contract called it directly. Off-chain compute
   reads via mirror, no contract coupling.

The trade-off: trust in the team's off-chain compute. Mitigated
by publishing the audit JSON + open-source script.

## Open follow-ups

Things deferred to post-mainnet:

- **Trustless verifier.** Could publish per-epoch the full
  computation inputs (mirror queries) + outputs (Merkle tree) +
  the script that links them. Anyone could independently
  recompute and challenge. Worth doing once the rebate is live
  and patterns are stable.
- **Per-tier weight knobs.** Currently the multiplier table is
  immutable. If product wants to tune weights, requires a new
  multiplier contract + a VIP pointer update. Could add an
  owner-tunable knob later.
- **HBAR-side rebates.** Currently only LAZY subscription
  revenue feeds the rebate. HBAR platform fees from LST stay
  as treasury accumulation. Could be added later as a parallel
  rebate path if product wants.
- **Cross-collection LSH support.** New LSH-style NFTs would
  require a new multiplier contract. Could be added without
  redeploying the pool.

## Reference

- Live contract: `contracts/LazyRebatePool.sol`
- Multiplier helper: `contracts/LSHRebateMultipliers.sol`
- VIPSubscription patch: `contracts/VIPSubscription.sol` —
  search for `rebateBps`, `teamBps`, `SubscriptionRevenueSplit`.
- Test suite: `test/RebateStack.test.js`
- Compute script: `scripts/ops/computeRebateEpoch.js`
- DELTA's original Q2 proposal (now reconciled):
  `docs/AGENT-MARKETPLACE-DELTA.md` "Tokenomics: agent fees +
  $LAZY sinks" → Q2.
- Reconciliation closure note:
  `docs/AGENT-MARKETPLACE-RECONCILIATION.md` (will be updated
  to mark Gap 1 closed).
