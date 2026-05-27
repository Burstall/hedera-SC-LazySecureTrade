# Agent-Driven Marketplace — Infrastructure Delta Analysis (v3)

**Date:** 2026-05-16
**Source:** `d:\nft-marketplace` (Claude Design handoff, ~7,700 LOC)
**Target infrastructure:** `LazySecureTrade` (v1 sunsetting on mainnet; v2/v3 never went live; v0.3 branch is next mainnet candidate) + `BidderContractFactory` (v0.3, current branch)
**Sibling projects referenced:**
- `D:\github\hedera-SC-LAZY-Farms` (`LazyNFTStaking`, `Mission`, `MissionFactory`, `BoostManager`)
- `D:\github\hedera-SC-lazy-lotto` (`LazyLotto`, `LazyTradeLotto` — testnet-ready, uses the same LSH-holder check pattern as LST)

**Scope:** what *contract-layer* primitives and what *NPM-package surface* this repo needs to expose so a **separate agentic-layer repo** can build the proposed front end on top.

---

## Revisions from operational-constraint review (read this first)

Three constraints reshape v2's recommendations:

### Constraint 1 — LST v1 is sunsetting, no live successor

The earlier draft worried about preserving the mainnet LST and proposed Path A (clean v0.4) vs Path B (incremental). Both are obsolete given that v1 is winding down and v2/v3 never deployed. **There is no live contract to coordinate a migration around.** The current v0.3 branch becomes the next mainnet deploy, and we have a clean slate to include `VIPRegistry`, `_resolveOwnerOf`, agent envelopes, and tier delegation **in the same release** rather than spreading across v0.4 / v0.5.

Decision implications:
- **All new architecture goes into the v0.3 → mainnet release**, not a future v0.4.
- We can rename internally if we want (`v0.3` → `v2` mainnet) — but the contracts are clean.
- No migration code, no parallel-running contracts, no drain windows to plan.

### Constraint 2 — DRY pressure across four contracts

The LSH-holder check now lives in:
- `LazySecureTrade.getLSHTokenTier` (LST, mainnet)
- `LazyTradeLotto.sol:495-503` (LazyLotto, testnet — confirmed: identical 6-subcall pattern)
- And would be duplicated in `BidderContractFactory`, `EnglishAuction`, `VIPMembership` if we built them naively

Each implementation: 3× ERC721 `balanceOf` + 3× LDR `getSerialsDelegatedTo` = **6 subcalls per tier check**. With Hedera's 50-subcall budget, that's >10% of the budget burned on tier resolution alone, per item, per trade.

This is the single most important architectural constraint and forces the design changes below.

### Constraint 3 — Hedera-native budget math

The 50-subcall limit and 24,576-byte bytecode limit force concrete answers to what was hand-wavy in v2.

**Trade subcall budget (current v0.3 single trade, rough estimate):**

| Step | Subcalls |
|---|---|
| Tier check (LSH balances × 3 + delegation × 3) | 6 |
| LGS $LAZY draw (if open-market listing) | 2-3 |
| HTS 2-step NFT transfer | 4-6 |
| HBAR transfer to seller | 1-2 |
| Royalty distribution | 2-3 |
| **Per-trade total** | **15-20** |

That puts batch trades at 2-3 items before hitting the cap if tier resolution stays inline. The current 22-item batch cap is only achievable because LST holds tier resolution to a small subset of paths (and CLAUDE.md notes `validateTokenAssociations` was removed specifically to save subcalls).

Adding a naive `VIPRegistry.getTierFor(user)` call would push this further: 1 cross-contract call + whatever VIPRegistry internally calls (potentially 6 more subcalls if it doesn't cache).

The architecture has to be designed with **subcall-per-trade-item = 1 (for tier)** as a hard target.

### Resulting architectural decisions

> **⚠️ Outcome annotations (2026-05-27)**: items #1, #2, and #4 below
> were REVERSED during implementation. The v3 doc reasoning is
> preserved for historical context, but the live implementation went
> a different direction. See per-item annotations.

These superseded the corresponding sections below at design time:

1. ~~**`VIPMembership` → `VIPRegistry` with cached tier.**~~ Single cross-contract call per trade. Internal cache, refresh-on-write, frame-local memoization for batch ops. Detailed below in [Revised: VIPRegistry](#revised-vipregistry-cached-tier-resolution).
   > **REVERSED** — `VIPRegistry` was split into two contracts during
   > the design pass: `LSHTierLib` (statically-linked, inlined,
   > zero-subcall when caller has the lib) for holdings-tier
   > resolution; `VIPSubscription` (independent contract) for paid
   > tiers. The cache idea was dropped — the library inlines the
   > 6-subcall chain at each call site, but short-circuits on the
   > first positive match (1 subcall for Gen 1 holders). See
   > `docs/LSHTierLib-DESIGN.md` and `docs/VIPSubscription-DESIGN.md`.

2. ~~**Per-agent envelopes live in BCF, not in the stash bytecode.**~~ Trades subcall savings + smaller stash impl. Documented trust note. Detailed below in [Revised: per-agent envelopes](#revised-per-agent-envelopes-location-decision).
   > **REVERSED** — Security finding H3 ruled against BCF placement.
   > Envelopes live on each per-user stash (`BidderContract` clone)
   > via the statically-linked `AgentEnvelopeLib`. The factory calls
   > back to `stash.spendForAgent` for envelope verification during
   > BCF-mediated flows; EnglishAuction-mediated flows verify
   > directly on the stash side. See `contracts/BidderContract.sol`
   > and `contracts/libraries/AgentEnvelopeLib.sol`.

3. **LazyLotto migrates to `VIPRegistry` as part of its mainnet deploy.** Eliminates duplicate LSH check; same release-shape as the v0.3 marketplace work. Detailed below in [LazyLotto integration](#lazylotto-integration-shared-vipregistry-opportunity).
   > **ON TRACK** (different target) — LazyLotto will consume
   > `LSHTierLib` directly when it migrates. The scanner-side cutover
   > work also tracks against `BCF.stashOwnerOf` resolution — see
   > `docs/v0.3-OPS-RUNBOOK.md` §3.

4. ~~**Tier resolution adopts the signed-proof pattern from `LazyStakingSignatureVerifier` as an OPTIONAL hot path.**~~ Zero subcalls when used. Off-chain signer (the agentic layer or a system wallet) signs `(user, tier, validUntil)`; trade contract verifies via `ecrecover` (precompile, not a subcall). Used by power-users / agents; fallback to cached cross-contract call for everyone else.
   > **REVERSED** — Auth model went msg.sender-only (no EIP-712, no
   > ecrecover) once Hedera's protocol-layer signature verification
   > was confirmed sufficient. Removes a trust assumption (off-chain
   > signer compromise) and works uniformly for ECDSA + ED25519
   > Hedera key types. See `contracts/interfaces/IAgentEnvelope.sol`
   > "Authentication model" NatSpec.

5. **No new wrapper/abstraction contracts that add subcalls without payback.** Library composition (statically linked, bytecode-inlined) preferred over satellite contracts when DRY is the only driver. Cross-contract calls reserved for cases where the called contract holds independent state worth isolating.
   > **HELD** — `LSHTierLib` and `AgentEnvelopeLib` both went the
   > inline-library route; `VIPSubscription` stayed a satellite
   > contract because it holds independent paid-subscription state
   > worth isolating (and pays its bytecode in a different consumer).

The rest of the doc retains its structure. Annotations like the
above flag where v3-era reasoning was overtaken by later decisions.

---

## Scope correction (vs v1 of this doc)

The previous version of this analysis treated agent runtime concerns (LLM integration, approval queue service, notification fan-out, HCS topic provisioning) as in-scope for this repo. That was wrong. The right framing:

- **This repo (`hedera-SC-LazySecureTrade`)** ships contracts + a published `@lazysuperheroes/marketplace-sdk` NPM package with ABIs, ethers Interfaces, TS types, and thin SDK helpers. Like LAZY-Farms's existing `@lazysuperheroes/farming-sdk`.
- **The agentic-layer repo (separate, not yet created)** consumes the NPM package and builds the agent runtime, approval queue, notification dispatcher, HCS topic management, LLM integration.
- **LAZY-Farms (sibling repo)** provides staking + missions + boost — reused, not rebuilt.

What this repo needs to provide is therefore much narrower than v1 implied. This version replaces that doc in full.

---

## Three-repo architecture (proposed)

```
┌──────────────────────────────────────────────────────────────────────┐
│  hedera-SC-LazySecureTrade  (this repo)                              │
│  ├─ Contracts: LST, BCF + stash, NEW Auction, NEW VIPMembership      │
│  └─ Publishes: @lazysuperheroes/marketplace-sdk                      │
│       └─ ABIs · ethers Interfaces · TS types · thin client helpers   │
└──────────────────────────────────────────────────────────────────────┘
                              ▲          ▲
                              │          │ consumes
                              │          │
┌─────────────────────────────┴───┐  ┌───┴──────────────────────────────┐
│  hedera-SC-LAZY-Farms (sibling) │  │  agent-marketplace-runtime       │
│  ├─ LazyNFTStaking              │  │  (separate, not yet created)     │
│  ├─ Mission / MissionFactory    │  │  ├─ Agent decision loops         │
│  ├─ BoostManager                │  │  ├─ HCS-10 topics per agent      │
│  └─ Publishes:                  │  │  ├─ Approval queue + TTL         │
│     @lazysuperheroes/farming-sdk│  │  ├─ Notification fan-out         │
└─────────────────────────────────┘  │  ├─ LLM (Anthropic API)          │
            ▲                        │  └─ Trait-floor indexer          │
            │                        └──────────────────────────────────┘
            │ also consumes                       ▲
            └──────────────────────────┬──────────┘
                                       │
                              ┌────────┴─────────┐
                              │  Frontend (web)   │
                              │  (separate repo)  │
                              └───────────────────┘
```

**Trust boundary:** contracts enforce what an agent *can* do (per-agent budget envelopes in the stash). The agentic-layer repo is a sophisticated decision engine, but it cannot exceed the on-chain limits even if compromised. This is the right way to scope autonomy.

---

## What THIS repo needs to do (in-scope)

Ranked by priority. None of these are blockers for shipping the *contract* roadmap as a standalone v0.3; they're the additions needed before the agentic layer can be built against this foundation.

### 1. NPM package: `@lazysuperheroes/marketplace-sdk`

Pattern matches `@lazysuperheroes/farming-sdk` (`d:\github\hedera-SC-LAZY-Farms\packages\sdk\package.json`). The marketplace SDK should export:

- **ABIs** (`./abi/*` — already cleanly emitted to `abi/` in this repo)
- **ethers Interface instances** pre-built per contract (the same pattern `utils/solidityHelpers.js` uses internally)
- **TypeScript types** for `BidDetails`, `TradeDetails`, `BidStatus`, `BidValidityCode`, `LSHTier`, all custom errors
- **Mirror-node read helpers** wrapped per common query (`getTrade`, `getUserBids`, `isBidValid`, `getStashSnapshot`) so the agentic layer doesn't reimplement `readOnlyEVMFromMirrorNode` against each call site
- **Write-path helpers** that return populated `TransactionRequest` objects (the agentic layer attaches its own signer)
- **Event decoder** wrapping `findLastEventByName` + `getDecodedEventsFromMirror` (the helpers I added in the v0.3 test rework)
- **Contract ID registry** per network (testnet / mainnet / previewnet)

What it should NOT export: SDK-level "agent" concepts. The marketplace SDK is plumbing; the agent layer builds on it.

**Effort:** 1-2 weeks. Most of the surface already exists internally (`utils/solidityHelpers.js`, `utils/hederaMirrorHelpers.js`); package it, add TS types, set up `tsup` build matching LAZY-Farms.

### 2. NEW contract: `EnglishAuction.sol`

The design's "Auctions" tab assumes a timed auction primitive — close time, min-step bidding, automatic settlement, refund of losing bids. BCF's CLOB is *not* this; CLOB bids don't close on a timer, they're matched manually via `executeAgainstBid` or `executeArbitrage`.

Sketch:

- `createAuction(token, serial, startPrice, minStep, closeTimestamp, paymentToken)` — paymentToken in {HBAR, $LAZY}
- `placeBid(auctionId, amount)` — must beat current high by ≥ `minStep`; auto-refunds previous bidder; extends close time by N seconds if bid lands within last N seconds (anti-snipe)
- `settle(auctionId)` — anyone can call after close; transfers NFT to winner, refunds-final settlement, takes platform fee
- Uses `TokenStakerV2` for the 2-step NFT transfer (Hedera royalty compliance)
- Fee resolution via `VIPMembership.getTierFor(seller)` — same tier logic as LST/BCF
- Auctions can be settled via a stash-initiated path so agents can autonomously bid (SNIPER use case from the design)

Open design questions:
- Reserve price? (probably yes)
- Bid in $LAZY *or* HBAR but not both per auction (mirror LST pricing model)
- Anti-snipe extension window (Foundation-style 15-min extensions on last-minute bids)
- Settlement gas reimbursement? Currently anyone can call `settle` — incentivize callers with a small fee share?

**Effort:** 2-3 weeks including tests. Reuses `TokenStakerV2` + fee tier infra. Watch the 24,576-byte limit — this should be a standalone contract, not added to LST.

<a id="revised-vipregistry-cached-tier-resolution"></a>
### 3. NEW contract: `VIPRegistry.sol` (was `VIPMembership.sol` in v2)

Three purposes that should live in one place:
1. **Single source of truth for user tier** — replaces the per-contract LSH check duplicated across LST, LazyLotto, and (would-be) BCF/Auction. Six subcalls of work per check, deduplicated to one cross-contract read per consumer.
2. **$LAZY sink for subscriptions** — the design's "VIP" tier (5 agent slots, 35,000 LAZY daily budget, 8,000 LAZY auto-bid cap, priority lane) purchasable in $LAZY.
3. **Subcall budget guardian** — by caching tier on-chain and exposing a 1-subcall read, it makes the marketplace's 50-subcall ceiling workable for batch operations.

#### Cached tier resolution (the subcall-budget answer)

The naive "compute on every call" design would blow the subcall budget. The cached design:

```solidity
struct CachedTier {
    Tier tier;
    uint64 computedAt;
    uint64 sources;     // bitmask: bit 0 = held Gen1, 1 = held Gen2, 2 = held Mutant,
                        // 3 = delegated, 4 = staked, 5 = paid subscription
}
mapping(address user => CachedTier) public cache;
uint32 public cacheTTL;          // owner-set, e.g. 86400 (1 day)

// HOT PATH — 1 subcall (single SLOAD via xchain call).
function getTierFor(address user) external view returns (Tier);

// REFRESH — 6 subcalls, called occasionally.
// Anyone can call for any user; gas paid by caller.
// Auto-invoked as a side effect of subscription purchase, staking rewards
// claim, etc., so most active users have fresh cache without explicit refresh.
function refreshTier(address user) external returns (Tier newTier);

// Frame-local hint for batch ops — caller passes a tier proof from a prior
// read in the same tx; contract verifies it matches storage (1 SLOAD) and
// uses it without recomputation. Saves subcalls in batch trades.
function getTierWithHint(address user, Tier hint, uint64 cachedAt)
    external view returns (Tier);

// OPTIONAL signed-proof path — 0 subcalls. Signed by system wallet off-chain.
// Same pattern as LazyStakingSignatureVerifier in LazyNFTStaking.
function getTierFromProof(address user, Tier tier, uint64 validUntil, bytes sig)
    external view returns (Tier);

function purchaseSubscription(Tier tier, uint16 monthsDuration) external;
// $LAZY payment routes via LazyGasStation; configurable burn / treasury / staker-rebate split.
```

**Tier resolution priority (highest wins, computed during refresh):**

1. Paid subscription that's currently active
2. Holds LSH Gen1 → Platinum
3. Holds LSH Gen2 → Gold
4. Holds LSH Mutant → Silver
5. Has any LSH staked in `LazyNFTStaking` → matches held-tier
6. Delegated tokens via `LazyDelegateRegistry` → matches held-tier
7. Else Free

**Cache freshness strategy.** Owner sets `cacheTTL` (suggest 86400 = 1 day initially; can shorten if needed). When a hot-path read finds a stale entry, two behavior options:
- **Strict:** revert with `TierCacheStale(user)` — caller must refresh first. Predictable subcall cost.
- **Lenient:** return cached value with a `StaleTierUsed` event — slightly wrong tier briefly possible, but no UX friction.

Recommend strict for high-value calls (auctions), lenient for low-value (trade fee). Behavior is per-consumer's choice (they pick which getter to call).

**Frame-local memoization for batch ops.** In a batch trade processing N items, the contract reads tier ONCE at the start, then passes the tier value as a memory variable across all N items. Zero additional subcalls per item beyond the first. This is the design pattern that makes batches scale.

If Hedera supports EIP-1153 transient storage (`tload`/`tstore`), we use that for cross-function memoization within a tx. Worth verifying with a probe contract before committing.

#### LST tier-logic migration — RESOLVED

The earlier draft proposed Path A vs Path B. With LST v1 sunsetting and v2/v3 never deployed, **the v0.3 mainnet release IS the migration.** All new contracts (LST v2 = current v0.3 branch, BCF, EnglishAuction, optionally LazyLotto) reference `VIPRegistry` from day one. No drain windows, no compatibility shims.

Single open question: do we ship `VIPRegistry` in the same release as v0.3 mainnet, or as a follow-up? Strong recommend **same release** — the alternative is shipping v0.3 with hardcoded tier logic that has to be replaced almost immediately, which is the worst of both worlds.

**Effort:** 2-3 weeks including tests. Modeled after `BoostManager` pattern (stake-OR-pay-$LAZY).

<a id="revised-per-agent-envelopes-location-decision"></a>
### 4. Per-agent budget envelopes — location decision

(Was "EXTEND BCF stash: per-agent budget envelopes" in v2 — title generalized because location is now an open architectural choice.)

This is the lynchpin for the design's "Auto" autonomy tier. Without on-chain per-agent caps, all agent activity has to be approved by the user (effectively "Approve" mode only). With on-chain caps, the user sets a budget per agent once, and the agent operates within it.

The current `BidderContract` has the stash-as-vault model (owner controls; factory mediates). Add a third role: agents.

Sketch (added to `BidderContract`):

```
struct AgentEnvelope {
    uint256 budgetLazy;        // total $LAZY the agent can pull from stash
    uint256 budgetHbar;        // total HBAR
    uint256 spentLazy;         // cumulative
    uint256 spentHbar;
    uint256 perTxLazyCap;      // per-action ceiling
    uint256 perTxHbarCap;
    uint64  windowStart;       // rolling-window epoch
    uint64  windowSeconds;     // e.g. 86400 for daily
    bool    paused;
}

mapping(bytes32 agentKey => AgentEnvelope) public agents;

function setAgentEnvelope(bytes32 agentKey, AgentEnvelope calldata env) external onlyOwner;
function pauseAgent(bytes32 agentKey) external onlyOwner;
function pauseAllAgents() external onlyOwner;  // implements "Pause all" from Security tab
function spendForAgent(bytes32 agentKey, uint256 hbarAmount, uint256 lazyAmount)
    internal returns (bool ok);
```

`spendForAgent` is the choke point: any factory-routed action that wants to draw funds in an agent's name must call it. If it returns false, the action reverts. Window auto-rolls; spent counters reset.

BCF `executeArbitrage` and `executeAgainstBid` (when agent-initiated) thread `agentKey` through and call `spendForAgent` on the stash before settlement.

**Two options, decision needed before implementation:**

| | **Option A: Envelopes in BCF (factory)** | **Option B: Envelopes in stash (BidderContract)** |
|---|---|---|
| Bytecode impact | BCF grows ~1-2 KiB; stash impl unchanged. BCF has more headroom than stash. | Stash impl grows ~1-2 KiB; clones unchanged (clones are tiny proxies). Stash impl is closer to the size limit. |
| Subcalls per agent-action | BCF reads its own storage (0 extra subcalls) → calls stash to settle (1 subcall, existing path) | Factory routes to stash (1 subcall, existing) → stash checks envelope from its own storage (0 extra) |
| Trust model | "Factory enforces envelopes; stash trusts factory." Anyone with factory upgrade rights can theoretically bypass. | "Stash enforces its own limits independent of factory." Factory cannot cause overspend even if compromised/upgraded. |
| Per-user customization | All users share envelope ABI; per-stash via mapping (`stash → agent → envelope`). | Each clone has its own storage layout; trivially per-stash. |
| Owner kill-switch ("Pause all") | Owner calls `BCF.pauseAllAgentsFor(stash)` — touches BCF storage. | Owner calls `stash.pauseAllAgents()` — touches stash storage. Works post-`detachFromFactory` too. |
| DRY | One implementation across all users. | One implementation in the impl contract; clones reuse. Equally DRY. |

**Recommendation: Option B (stash) with envelope logic factored into a statically-linked library** to manage bytecode. Reasons:

1. **Security model matters more than ~1 KiB of bytecode.** The whole point of the v0.3 stash design is that funds live behind owner-controlled bytecode; the factory is a mediator, not a custodian. Putting agent envelopes in BCF inverts that trust direction.
2. **`detachFromFactory` should not disable agent envelopes.** A detached stash should still respect the owner's "max 1000 LAZY/day for the SCOUT agent" rule — that's the owner's settings, not the factory's. Option A breaks this.
3. **Library composition keeps DRY intact.** `AgentEnvelopeLib.sol` with all envelope logic; stash imports + uses it. Bytecode is inlined per-deploy (one cost, paid by the stash impl), but logic lives in one source file.

If size profiling after Option B prototype shows we're over the limit even with library composition, we have a fallback: factor the stash itself into a minimal proxy + a satellite "agent control" contract per stash. More plumbing, more subcalls — but only invoked when the path needs envelope enforcement.

**Verify before committing:** compile a prototype of `BidderContract` with `AgentEnvelopeLib` inlined; measure bytecode via `hardhat-contract-sizer`. If under ~23 KiB (allowing some headroom for future), proceed with Option B. If over, escalate to satellite-contract design.

**Effort:** 3-4 weeks including library extraction, tests, and a size-budget verification pass. Security-critical — needs an audit before mainnet deploy. Good news: the trust model is sound — stash owner retains ultimate control via `rescueHbar` / `rescueLazy` / `pauseAllAgents` / `detachFromFactory`.

### 5. SHIM: read-views that compose LAZY-Farms state

For the marketplace SDK to surface "staker = free trader" UX, the marketplace contracts need a cheap way to query staking state. Options:

- **Cross-contract call** — `VIPMembership` calls `LazyNFTStaking.getStakedNFTs(user)` and counts LSH tokens. Cost: ~5,000-10,000 gas per query. Acceptable for view; less ideal in a transaction path.
- **Cached tier snapshot** — `VIPMembership.refreshTier(user)` writes the user's tier to its own storage; user calls it periodically (or on-claim from staking). Trade computation reads cached tier (cheap). Slightly stale.
- **Off-chain resolver** — the marketplace SDK reads staking via mirror and computes tier off-chain. Contract just trusts a signed tier snapshot from the system wallet (the same pattern `LazyNFTStaking` uses for reward proofs via `LazyStakingSignatureVerifier`).

I'd recommend cross-contract call for v1 (simplest, deterministic). Move to cached tier if gas becomes a problem.

**Effort:** 1 week including the `getStakedNFTs`-aware tier resolution.

---

## What to REUSE from LAZY-Farms

The earlier draft of this doc treated quests and staking as missing. Both are in LAZY-Farms already. Side-by-side:

### `LazyNFTStaking.sol` ↔ frontend's "TREASURER" agent & "staker tier"

| Frontend assumption | What LazyNFTStaking provides | Fit / gap |
|---|---|---|
| "Staking positions across LAZY pools" (`data.jsx:144`) | One contract supports multiple stakeable collections (`stakeableCollections`); each collection has its own `maxBaseRate` | **Good fit**, but "pools" in the UX = "collections" in the contract. Adjust the UX language or build a thin abstraction. |
| "Rebalances when gas/yield ratio favorable" | `claimRewards()` is open to anyone for themselves; `unstake` + restake into different collection works | **Fit.** Agent-initiated rebalance = unstake from A + stake into B in sequence. |
| "Compounds rewards" | `claimRewards()` only pays out; doesn't auto-restake into LSH | **Gap.** Compounding $LAZY rewards into staking requires holding LSH (the staked asset), not $LAZY. The frontend's "Compounded rewards · +182 LAZY/d" is genuinely auto-claim, not auto-stake. UX language is misleading. |
| "Pool A vs Pool B" — implies tiered APR/risk | All stake in one contract; different collections have different `maxBaseRate`s; epoch halvening reduces rate over supply growth | **Mostly fit.** "Pool A/B" maps to "collection X/Y with different reward rates". |
| "+128 LAZY/d compounding" with "10.7 HBAR/mo" equivalent | `calculateRewards(user)` returns expected $LAZY per period | **Fit.** SDK needs to expose this cleanly. |
| HODL bonus (multi-month staking) | `hodlBonusRate` (25% per `periodForBonus`, default 30d, capped at 8 months) | **Bonus feature** the frontend doesn't show but should — strong incentive to stake longer. |
| Reward halvening | `checkHalvening()` triggers on every staking action when supply crosses 50M boundaries | **Good** — long-term tokenomic feature; should be surfaced in the UI somewhere (e.g. portfolio: "next halvening at supply X"). |

**Verdict:** `LazyNFTStaking` covers the staking side of the frontend completely. No new staking contract needed. Marketplace SDK should re-export the relevant read methods (or just point the agentic layer at `@lazysuperheroes/farming-sdk` for staking concerns).

### `Mission.sol` + `MissionFactory.sol` ↔ frontend's "Quests" tab

The design's quests (`missions.jsx`, `data.jsx:212-240`) — time-limited challenges, $LAZY rewards, agents assigned to specific quests, progress tracking — map closely to LAZY-Farms's Mission contract.

Side-by-side:

| Frontend assumption | What Mission/MissionFactory provides | Fit / gap |
|---|---|---|
| "Limited · 4 days" or "Recurring · Daily" | `missionDuration` + `lastEntryTimestamp` + slot decrement | **Fit** for time-limited. Recurring missions would need a new mission instance per cycle (factory pattern handles this). |
| "Acquire and stake 5 Lazy Heroes with Cosmic Void background" | Mission has `MissionRequirements` (specific serials, limited or open set) | **Fit** for the staking side. The acquisition side (buying 5 NFTs that meet a trait spec) is a marketplace concern, not a mission concern. The mission contract only knows: "did you stake these N NFTs for the required duration?" |
| Multi-agent assignment (CURATOR + SCOUT) | Mission doesn't know about agents — purely about NFT staking | **Out of contract scope** — agent assignment is a UI concern in the agentic-layer repo. The mission contract just sees stakes. |
| Progress: "3 / 5 complete" | Mission tracks user participation by entry timestamp; "completion" = staked for full duration | **Adapt.** Frontend's "progress" maps to "this many of the N required NFTs are currently staked". |
| Rewards: "4,200 $LAZY" | Mission has `nbOfRewards` and routes via LGS | **Fit.** |
| Entry fee with decreasing cost over time | `entryFee` + `decrementAmount` + `decrementInterval` | **Bonus** — frontend doesn't show this but it's a nice gamification hook ($LAZY sink + FOMO). |

**Verdict:** Mission/MissionFactory covers quests. Marketplace SDK can re-export or alias. The "agent that auto-bids until quest complete" lives in the agentic-layer repo and uses both marketplace SDK (for the buy) and farming SDK (for the stake-to-complete).

### `BoostManager.sol` ↔ template for `VIPMembership.sol`

BoostManager's "stake gem NFTs OR pay $LAZY for a flat boost" pattern is **exactly** the model I'm proposing for VIPMembership. Direct architectural template:

| BoostManager primitive | VIPMembership equivalent |
|---|---|
| `GemCardBoost` (rarity → boost%) | `LSHTierMapping` (Gen1/Gen2/Mutant → Platinum/Gold/Silver) |
| Stake gem NFT for mission duration | Hold LSH NFT (or stake in `LazyNFTStaking`) → automatic tier |
| Pay $LAZY for flat boost | `purchaseSubscription(tier, months)` consumes $LAZY |
| Boost is mission-scoped | Subscription is time-bound (renews) |
| Burn percentage on $LAZY purchase | Burn/treasury/staker-rebate split on subscription $LAZY |

**Verdict:** the VIPMembership contract should be specifically modeled after BoostManager — same author, same architecture, fits the ecosystem cohesively. Reuse the patterns; reuse `TokenStaker` base; reuse the LGS payment routing.

---

<a id="lazylotto-integration-shared-vipregistry-opportunity"></a>
## LazyLotto integration — shared VIPRegistry opportunity

`D:\github\hedera-SC-lazy-lotto` is testnet-ready (not yet on mainnet). `LazyTradeLotto.sol:495-503` does the **exact same 6-subcall LSH-holder check** as LST's `getLSHTokenTier`. Verbatim pattern:

```solidity
IERC721(LSH_GEN1).balanceOf(_user) > 0 ||
IERC721(LSH_GEN2).balanceOf(_user) > 0 ||
IERC721(LSH_GEN1_MUTANT).balanceOf(_user) > 0 ||
lazyDelegateRegistry.getSerialsDelegatedTo(_user, LSH_GEN1).length > 0 ||
lazyDelegateRegistry.getSerialsDelegatedTo(_user, LSH_GEN2).length > 0 ||
lazyDelegateRegistry.getSerialsDelegatedTo(_user, LSH_GEN1_MUTANT).length > 0
```

This is the DRY violation that VIPRegistry directly solves. Two questions:

### Should LazyLotto migrate now, before its mainnet deploy?

**Yes, if release timing allows.** The benefit is concrete: LazyLotto becomes the third consumer of VIPRegistry, validating the shared-registry pattern across three independent contract surfaces (LST, BCF, Lotto) before mainnet calcifies any of them with hardcoded duplicates.

The downside is coordination: LazyLotto's release is currently independent of LST/BCF. Migration adds a dependency: it now needs VIPRegistry deployed first.

**Practical proposal:**
1. Ship `VIPRegistry` as a standalone contract first (it has no dependencies beyond LDR, LGS, LSH tokens — all of which exist).
2. LazyLotto's next testnet iteration replaces the inline check with `vipRegistry.getTierFor(user)`. Net delta in LazyLotto: 6 lines deleted, 1 line added, ~5 KiB bytecode saved (the inline ERC721 + LDR calls and imports are heavier than a single getter call).
3. LST v2 (current v0.3 branch) ships from day one against VIPRegistry.
4. Future contracts (Auction, etc.) reference it directly.

### Should LazyLotto's tier semantics differ from LST's?

Today they're identical (Free vs. LSH-holder, boolean). VIPRegistry's richer tier enum (Free/Bronze/Silver/Gold/Platinum) is strictly more expressive. LazyLotto can either:
- Use the boolean `isAnyLSHHolder(user)` view (a one-liner derived from `getTierFor(user) >= Silver` or similar).
- Adopt the full tier and offer tiered odds / pot sizes in the lotto (genuine product win — but a tokenomics design conversation, not a migration concern).

Recommend the boolean view as the migration path, full-tier adoption as a future enhancement decided by LazyLotto's product owner.

### Knock-on effect: VIPRegistry's release becomes higher-priority

If LazyLotto wants to migrate before its own mainnet deploy, VIPRegistry needs to ship sooner. If LazyLotto's mainnet timeline doesn't permit waiting, ship LazyLotto with the inline check and migrate it in a v1.1. Either is defensible; the question is who's blocking whom on release date.

### Other LazyLotto-shaped opportunities

- `LazyLottoPoolManager.sol` — pool management pattern; doesn't intersect marketplace concerns directly but worth scanning for shared-contract opportunities.
- `LazyTradeLotto.sol` — implies trades trigger lotto entries. If the marketplace wants to integrate (trade → free lotto entry), VIPRegistry tier could gate entry odds. Product question.

---

## What's OUT of scope (agentic-layer repo concerns)

Explicit list so nobody accidentally builds these here:

- **Agent runtime / worker** — the loop that scans, evaluates candidates, calls LLM, signs transactions
- **HCS-10 topic provisioning** — creating + managing per-agent topics on Hedera Consensus Service
- **HCS-10 message routing** — DIPLOMAT's "negotiate via HCS-10" flows
- **LLM integration** — `window.claude.complete` in the design must be a server-side Anthropic API call
- **Approval queue service** — TTL, retry, deduplication, audit log
- **Notification dispatcher** — Discord bot, Telegram bot, email, SMS
- **Trait-floor indexer** — aggregating mirror data into per-trait floors
- **Sparkline / price-history rollup** — extending the Directus event scanner with views
- **OAuth integrations** — for the connections in Profile
- **Hedera Names Service resolution** — handle ↔ account mapping
- **Frontend itself** — already a separate concern

For each: **the contract layer doesn't need to know about these.** Properly designed, the agentic layer reads events from this repo's contracts, calls write paths via the SDK, and respects the on-chain caps. We expose primitives; they compose them.

The one gray area: **HCS audit trails for on-chain agent actions.** The frontend leans heavily on "agent reasoning is on HCS topic 0.0.X". If we want this to be cryptographically tied to on-chain actions, we could have the BCF emit an `agentReasoningTopicId` field in `ArbitrageExecuted` and similar events. Cheap to add; massive UX win. Recommend including.

---

## Tokenomics: agent fees + $LAZY sinks

You asked for suggestions here specifically. Two questions to answer in order:

### Q1: Should agent fees be per-trade or subscription-funded?

The design shows per-trade fees (`trade-overlay.jsx`: 40 LAZY split across 4 agents on a 3,028 LAZY trade — ~1.3% effective). The VIP membership shows a separate daily budget. These two cost structures coexist awkwardly.

**Recommendation: Subscription-funded, with per-trade *attribution* (not per-trade fees).**

Reasoning:
- Per-trade fees on $LAZY trades violate the stated "$LAZY trades are always fee-free" policy. Subscription model preserves it.
- Per-trade fees with N agents create perverse incentives (the more agents, the more fees; nothing rewards efficient single-agent execution).
- Subscription is a cleaner $LAZY sink — predictable burn rate, easier to communicate.
- The frontend's "fee: 10 LAZY · paid to 4 agents" line can become "executed by 4 agents · within your monthly budget" — same narrative, no per-trade tax.

**Model:** VIP subscription tier covers all agent activity within the tier's limits. Higher tiers = higher daily/monthly budgets. Agents do not have separate fees from the user's perspective.

For multi-agent trades, what gets *recorded* is which agents contributed; the operator of the agentic-layer infrastructure gets compensated from the protocol-wide treasury (funded by subscriptions), not from per-trade extractions.

### Q2: How is subscription $LAZY split?

Three sinks deserve a share. Proposed split:

| Destination | Split | Why |
|---|---|---|
| **Burn** | 40% | Deflationary pressure on $LAZY supply. Long-term value accrual to holders. |
| **Staking rebate pool** | 35% | Rebated to active LSH stakers proportional to stake. Closes the loop: "stake LSH → earn $LAZY from subscriptions → spend $LAZY on subscriptions or trade fees → recycle". |
| **Protocol treasury** | 25% | Operations: agentic-layer infrastructure cost, audits, future development. Owned by the multisig (`FACTORY_MULTISIG_ACCOUNT_ID`). |

The burn and rebate sinks together (75%) push hard on $LAZY scarcity + holder incentives. The 25% treasury gives the project operational runway without external funding.

### Q3: How does this layer on the existing fees?

The existing model (worth preserving):
- LST: HBAR-only platform fee at execution, tiered by LSH (1% base, 50% off / 75% off / 100% off)
- LST: $LAZY listing cost (`lazyCostForTrade = 500 LAZY`, partial burn, free for LSH holders) — this is the existing $LAZY sink

Stacking proposal:
- **HBAR platform fee on HBAR-priced trades** → unchanged, tiered through VIPMembership
- **$LAZY listing cost** → unchanged, tiered through VIPMembership (lower-tier subscribers get reduced cost, top tiers get free)
- **Subscription** → new $LAZY sink on top, gates agent autonomy / budgets / priority
- **Auction-specific** → percentage of winning bid, paid by winner, same tiered discount
- **Mission entry fees** (LAZY-Farms feature, already exists) → existing $LAZY sink, separate flow

Net for $LAZY: existing sinks remain + subscription becomes the largest predictable burn. The "trade for free if you stake" promise is satisfied by tier resolution checking staked LSH.

### Q4: "Stakers trade free for their agents" — implementation

The design promise: humans hold (or stake) LSH → they get free trades → their agents inherit the benefit.

Implementation:
1. User's LSH-derived tier resolved via `VIPMembership.getTierFor(user)` (checks holdings, delegation, staking).
2. When the user's stash executes a trade, the LST fee resolver climbs from stash → `stash.owner()` and queries the owner's tier.
3. Agent acting through the stash automatically inherits the owner's tier — no separate agent identity is needed for fee purposes.

The only LST code change needed: `_resolveOwnerOf(msg.sender)` — if `msg.sender` is a registered stash, return its owner; else return `msg.sender`. Adds one cross-contract call to BCF (`getStashOwner(address)`); tiny gas cost.

This is the cleanest version of the promise. It does **not** require per-agent tier — agents are just operating on behalf of the owner, and the owner's tier applies.

---

## Decisions to make together

In suggested order of dependency:

| # | Decision | My recommendation | Why it matters |
|---|---|---|---|
| 1 | Is agent runtime in this repo or separate? | **Separate repo** (`agent-marketplace-runtime` or similar) | Already your stated intent. Confirms scope. |
| 2 | Do we publish a marketplace SDK NPM package now or after v0.3? | **After v0.3 testnet validation; package work during the v0.3 → mainnet finalization.** | Don't lock the SDK surface before the contracts are settled. |
| 3 | Auction contract: ship in v0.3 mainnet release or as parallel later? | **Separate contract, can ship together or shortly after** | Doesn't touch LST/BCF; independent shipping unit. Same VIPRegistry consumer either way. |
| 4 | `VIPRegistry`: in v0.3 mainnet release or follow-up? | **Same release as v0.3 mainnet** | Shipping v0.3 with hardcoded tier logic that needs replacing right away is the worst of both worlds. Constraint-driven change from v2. |
| 5 | LSH tier logic migration: when? | **All-at-once in v0.3 mainnet release** (no live LST v2/3 to coordinate with) | Resolved: LST v1 is sunsetting, v2/v3 never deployed. Clean slate. |
| 6 | Per-agent budget envelopes: same release as VIPRegistry or earlier? | **Same release (v0.3 mainnet).** Pending Option A vs B size verification. | They're co-dependent: VIPRegistry defines tier-driven limits, stash enforces per-agent. Need both. |
| 6a | **Per-agent envelopes location: BCF or stash?** | **Stash (Option B) with `AgentEnvelopeLib` static linking. Verify bytecode first.** | Security model: funds live behind owner-controlled bytecode, factory is mediator not custodian. Justifies the size cost. |
| 7 | Agent fee model: per-trade or subscription? | **Subscription** | See Q1 in tokenomics section. Per-trade fees on $LAZY trades break the fee-free policy. |
| 8 | Subscription split: 40/35/25 burn/rebate/treasury? | **Yes, with explicit owner-tunable knobs** | The exact percentages need owner discretion; the 3-sink structure is what matters. |
| 9 | "Stakers trade free for agents" — via `_resolveOwnerOf` shim? | **Yes** | Smallest code change, cleanest semantics. |
| 10 | Should BCF events emit `agentReasoningTopicId`? | **Yes — small addition, big UX/audit win** | Lets the frontend show "see why agent did this" linking to HCS. |
| 11 | English-auction reserve price + anti-snipe extension? | **Yes to both** | Standard auction features; cheap to implement. |
| 12 | Subscription duration: month, quarter, year? | **Month with annual prepay discount** (e.g. 12-month prepay at 20% off) | Predictable cadence; renewal incentive drives sticky $LAZY burn. |
| 13 | **Cache freshness strategy for VIPRegistry: strict vs lenient?** | **Strict for high-value (auctions); lenient for low-value (trade fees).** Per-consumer choice via different getters. | Strict revert = predictable subcall cost; lenient = no UX friction. Different consumers have different needs. |
| 14 | **Should we adopt the signed-tier-proof pattern from `LazyStakingSignatureVerifier`?** | **Yes, as an optional hot path** for power users / agents. Zero subcalls. | Same pattern the staking contract already uses. Lets agentic-layer batch operations operate near the subcall ceiling without burning budget on tier reads. |
| 15 | **LazyLotto migration to VIPRegistry: before or after its mainnet deploy?** | **Before, if release timing allows** — validates the shared-registry pattern across 3+ consumers. | Otherwise migrate in LazyLotto v1.1. Coordination question, not technical. |
| 16 | ~~**Does Hedera EVM support EIP-1153 transient storage?**~~ | **RESOLVED: yes — all Cancun opcodes supported on Hedera.** Not used in any v0.3 design: gas on Hedera is cheap + static-priced, so micro-optimization at the cost of readability isn't a win. Stick with OZ `ReentrancyGuard` for consistency with existing LST/BCF stack. | Documented for future reference only. |

---

## What this means for the v0.3 roadmap

The constraint-driven revisions move several items **into** the v0.3 mainnet release rather than deferring them. Given LST v1 is sunsetting (no live successor to coordinate with), this is the only sane sequencing — shipping v0.3 with hardcoded tier logic then immediately replacing it would be wasted effort.

Cross-reference `docs/v0.3-REMAINING-ITEMS.md` (the existing to-mainnet checklist) with the additions below before committing to a release plan.

**Suggested ordering (revised):**

1. **Empirical probes (parallelizable, ~1 week total).**
   - Compile prototype `BidderContract` + `AgentEnvelopeLib` static-link → measure bytecode. Decides Option A vs B for envelopes.
   - Compile prototype `VIPRegistry` → measure storage layout cost + read-path subcall count.
   - Probe contract: does Hedera EVM support EIP-1153 transient storage (`tload`/`tstore`)? Affects frame-local memoization design.

2. **`VIPRegistry` v0.1** — standalone, no dependencies on the rest of v0.3. Can be developed in parallel with v0.3 finalization. 2-3 weeks.

3. **v0.3 mainnet release** — includes:
   - BCF + stash (current branch work, almost done)
   - Per-agent envelopes in stash (Option A or B per probe result) with `_resolveOwnerOf` shim
   - VIPRegistry as a hard dependency
   - BCF events emitting `agentReasoningTopicId`
   - Audit pass on the agent-envelope security model
   Estimated 4-6 weeks from current branch state.

4. **`@lazysuperheroes/marketplace-sdk` v0.1** — package the v0.3 mainnet surface (LST v2 + BCF + VIPRegistry). 1-2 weeks after #3 stabilizes. Unblocks agentic-layer repo.

5. **`EnglishAuction` contract** — can ship together with #3 if timeline permits, or as v0.3.1 within ~1 month after. Same VIPRegistry consumer. 2-3 weeks.

6. **LazyLotto migration to VIPRegistry** — coordinate with LazyLotto release schedule. Either before its mainnet deploy (ideal) or as a v1.1 follow-up. Effort in LazyLotto: trivial (net negative LOC).

**Critical path:** #1 (probes) → #2 (VIPRegistry) → #3 (v0.3 mainnet). Everything else is parallel or follows.

**Agentic-layer repo can start design work now**; first useful integration target is the `@lazysuperheroes/marketplace-sdk` v0.1 in step #4.

---

## File-by-file reference (for the handoff bundle)

| File | Lines | What it tells the *agentic-layer* team |
|---|---|---|
| `project/data.jsx` | 296 | Data shape they need: agents, approvals, briefs, missions, collections, filter facets. |
| `project/agents.jsx` | 505 | Agent runtime requirements: HCS-10 topics, autonomy modes, brief storage, LLM chat patterns. |
| `project/market.jsx` | 545 | Listings + sidebar + approval queue UX expectations. |
| `project/trade-overlay.jsx` | 317 | Multi-agent narrative — single trade with attribution to multiple agents. |
| `project/portfolio.jsx` | 293 | Holdings + agent positions + history. Maps cleanly to existing contracts. |
| `project/profile.jsx` | 394 | Connections, notifications, security. **Big chunk of agentic-layer scope.** |
| `project/nft-detail.jsx` | 168 | Per-NFT view — needs trait floor (agentic-layer indexer). |
| `project/collection.jsx` | 250 | Per-collection grid with trait filters. |
| `project/missions.jsx` | 86 | Quest UX — backed by Mission/MissionFactory in LAZY-Farms. |
| `project/app.jsx` | 165 | Routing. Trivial. |
| `project/tweaks-panel.jsx` | 568 | Design-system controls. Not relevant. |
| `project/{primitives,header,footer}.jsx` | ~510 | UI scaffolding. Not relevant. |
| `project/app.css` | 3571 | Styles. Not relevant. |

---

*This is a diagnostic and architectural-direction document. Concrete contract specs (interface signatures, error definitions, event payloads) should be drafted as separate per-contract design docs before implementation begins.*
