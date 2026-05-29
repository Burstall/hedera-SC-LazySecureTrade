# Agent Marketplace DELTA — reconciliation against live state

> **Purpose:** Item-by-item map of every proposal in
> `docs/AGENT-MARKETPLACE-DELTA.md` (v3, 2026-05-16) to the
> current shipped state on the v0.3 branch. Captures what
> shipped as-designed, what was deliberately reversed during
> implementation, and the small set of items still open or
> awaiting external repos.
>
> **As of:** 2026-05-29, branch tip `630e872`.
>
> **TL;DR:** Contract scope complete. The staker-rebate gap is
> now closed end-to-end — not just the contracts, but the full
> ops loop is testnet-validated (canonical deploy, VIP wire-up,
> compute script implemented, **first epoch settled on-chain**,
> end-to-end purchase tests). Remaining items are all
> operational, not architectural: (1) ~~testnet LST↔BCF grant~~
> **applied 2026-05-29** (`authorizedFactories[BCF]==true`);
> (2) LazyLotto scanner
> cutover code lives in `hedera-SC-lazy-lotto` (handoff prompt
> now shipped); (3) the "richer tier" enum for LazyLotto remains
> an optional product decision. Everything load-bearing for the
> v0.3 mainnet target is shipped + validated.

---

## Section 1 — Constraint-driven architectural decisions (DELTA v3 §"Revisions from operational-constraint review")

| # | DELTA proposal | Live state | Notes |
|---|---|---|---|
| 1 | `VIPMembership` → `VIPRegistry` with cached tier (1 subcall hot-path; refresh-on-write) | **REVERSED** — split into two contracts | `LSHTierLib` (statically-linked, inlined, short-circuits on first positive match) for holdings/staking/delegation tier. `VIPSubscription` (separate contract) for paid tiers. Cache idea dropped — the inlined library is cheaper than a cross-contract cached read. |
| 2 | Per-agent envelopes in BCF | **REVERSED** — envelopes on the stash | Security finding H3 ruled against BCF placement. Envelopes live in `BidderContract` via the statically-linked `AgentEnvelopeLib`. Factory calls back to `stash.spendForAgent` for BCF-mediated flows. |
| 3 | LazyLotto migrates to shared tier registry | **ON TRACK (different target)** | LazyLotto will consume `LSHTierLib` (not `VIPRegistry`). Scanner-side cutover documented in ops runbook §3; code change owned by `hedera-SC-lazy-lotto`. See "External dependencies" below. |
| 4 | Tier resolution adopts signed-proof pattern as optional hot path | **REVERSED** — msg.sender-only auth | Hedera's protocol layer already verifies the agent's tx signature; contract-level signature verification was redundant AND would lock out ED25519 agents (no EVM precompile for Ed25519). The signed-proof hot path was unnecessary once the auth model shifted. |
| 5 | Library composition over satellite contracts when DRY is the driver | **HELD** | `LSHTierLib` and `AgentEnvelopeLib` both inline-library. `VIPSubscription` is a satellite because it holds independent paid-subscription state worth isolating. |

---

## Section 2 — What THIS repo needs to do (DELTA v3 §"What this repo needs to do (in-scope)")

| # | DELTA proposal | Live state | Reference |
|---|---|---|---|
| 1 | `@lazysuperheroes/marketplace-sdk` NPM package — ABIs, ethers Interfaces, TS types, mirror helpers, write-path helpers, event decoders, address registry | **SHIPPED at v0.1.0** | `packages/sdk/` (source), npm scope `@lazysuperheroes`. Published 2026-05-25. v0.1 ships transport primitives (ABIs, addresses, Interfaces, typed enums, AgentAuth); v0.2 will add mirror-node helpers + event decoders if the agent runtime needs them. The "after v0.3 testnet validation" timing recommended by DELTA decision #2 was honored. |
| 2 | `EnglishAuction.sol` — timed auction primitive with reserve, anti-snipe, buy-now, multi-item bundles, manual royalty | **SHIPPED at `0.0.9052454`** | `contracts/EnglishAuction.sol`. 23.849 KiB deployed. 20/20 acceptance tests on Hedera testnet (`test/EnglishAuction.test.js`). Bundle support (up to 10 mixed NFT+FT items), pull-payment refund queues, 48h timelock on high-blast-radius admin functions. |
| 3 | `VIPRegistry.sol` (cached tier resolution + $LAZY subscription sink) | **SHIPPED as the split** | Two contracts replace the single VIPRegistry: `contracts/libraries/LSHTierLib.sol` (holdings/staking/delegation tier — inlined into LST + EA) and `contracts/VIPSubscription.sol` (paid subscription contract at `0.0.9043912`). Cache layer dropped (not needed once the library inlines). |
| 4 | Per-agent budget envelopes — Option A (BCF) vs Option B (stash) | **SHIPPED as Option B** | `contracts/BidderContract.sol` holds envelope storage; `contracts/libraries/AgentEnvelopeLib.sol` holds the verification + budget logic. Statically linked into each clone. 48-test comprehensive acceptance suite (`test/AgentEnvelopeFull.test.js`) — 45 passing + 2 documented skips on Hedera testnet. |
| 5 | SHIM: read-views composing LAZY-Farms state | **SHIPPED via LSHTierLib._stakingTier** | When `LAZY_NFT_STAKING` is non-zero in the `TierSources` struct, the library reads `ILazyNFTStaking.getStakedNFTs(user)` (single subcall) and iterates the returned arrays in memory. Stakers retain their tier as if they still held the NFT. |

---

## Section 3 — Reuse from LAZY-Farms (DELTA v3 §"What to REUSE from LAZY-Farms")

| Component | Plan | Live state |
|---|---|---|
| `LazyNFTStaking` (TREASURER agent + staker tier) | Read via marketplace SDK / via LSHTierLib | **SHIPPED** — `LSHTierLib._stakingTier` reads `ILazyNFTStaking.getStakedNFTs(user)`. Agent runtime should re-export staking SDK from `@lazysuperheroes/farming-sdk` (separate package, sibling repo) when needed. |
| `Mission` / `MissionFactory` (Quests tab) | Out of contract scope; agent-runtime concern | **AS PLANNED** — no contract changes in this repo. Agent runtime + frontend handle UI; mission contracts live in LAZY-Farms. |
| `BoostManager` (template for VIPMembership) | Architectural template | **PATTERN ADOPTED** — `VIPSubscription` mirrors the "stake gem NFTs OR pay $LAZY" pattern as "hold LSH for discount on subscription purchase + pay $LAZY for subscription itself." Burn percentage on the $LAZY purchase routes via LGS exactly as BoostManager does. |

---

## Section 4 — LazyLotto integration (DELTA v3 §"LazyLotto integration — shared VIPRegistry opportunity")

| # | DELTA proposal | Live state |
|---|---|---|
| 1 | LazyLotto migrates to VIPRegistry (now LSHTierLib) before its mainnet deploy | **PENDING IN OTHER REPO** — `hedera-SC-lazy-lotto`. Net delta in LazyLotto: ~6 lines deleted, 1 line added. Required before BCF mainnet activation per ops runbook §3 verification checklist. |
| 2 | Migration via boolean `isAnyHolder(user)` view vs adopt richer enum | **`isAnyHolder` shipped** in LSHTierLib (line 125). LazyLotto can call it directly. Richer-enum adoption is a future product decision for the lotto team. |
| 3 | Scanner change: resolve stash → human via `BCF.stashOwnerOf` for trade attribution | **DOC SHIPPED, CODE PENDING** — ops runbook §3 documents the change with worked pseudocode + pre-mainnet verification checklist. Code change lives in `hedera-SC-lazy-lotto`. |

---

## Section 5 — Tokenomics (DELTA v3 §"Tokenomics: agent fees + $LAZY sinks")

| Q | DELTA recommendation | Live state |
|---|---|---|
| Q1 | Agent fees subscription-funded, NOT per-trade | **SHIPPED AS DESIGNED** — no per-trade agent fees. Subscription tier gates agent activity. |
| Q2 | Subscription $LAZY split: 40% burn / 35% staker rebate / 25% treasury, all owner-tunable | **SHIPPED + TESTNET-VALIDATED** — `VIPSubscription` 3-sink split: `burnPercentage` (burn) + `rebateBps`→`rebatePool` (staker rebate) + `teamBps`→`teamWallet` (treasury/team), all owner-tunable. End-to-end tested (V7.1-V7.3) with byte-exact slice assertions. See Gap 1 (closed) below. |
| Q3 | Layering: HBAR platform fee (tiered by LSH) + $LAZY listing cost (tiered) + subscription (new sink) + EA cut + mission fees | **SHIPPED AS DESIGNED** — all five sinks exist in the live contracts. Trade fees tier through LSHTierLib; subscription tiers through VIPSubscription; auction protocol fee tiers via `_resolveSellerTier`; mission fees are LAZY-Farms scope. |
| Q4 | "Stakers trade free for their agents" via `_resolveOwnerOf` shim | **SHIPPED AS `_resolveBeneficialOwner`** in LST + EA + BCF. Pattern: stash address → human address via `BCF.stashOwnerOf`. The function is the cross-cutting concern documented in [`docs/blog/technical/11-beneficial-owner-resolution.md`](blog/technical/11-beneficial-owner-resolution.md). |

---

## Section 6 — Decision table (DELTA v3 §"Decisions to make together")

| # | Decision | Recommended | Live state |
|---|---|---|---|
| 1 | Agent runtime in this repo or separate? | Separate (`agent-marketplace-runtime`) | **DONE** — separate repo bootstrapped (`lazy-agent-runtime`). See `docs/AGENT-RUNTIME-BOOTSTRAP.md`. |
| 2 | SDK now or after v0.3? | After v0.3 testnet validation | **DONE** — `@lazysuperheroes/marketplace-sdk@0.1.0` published 2026-05-25 against the testnet-validated v0.3 surface. |
| 3 | Auction ship same release or later? | Together if possible | **DONE** — EnglishAuction shipped in the same v0.3 window. |
| 4 | VIPRegistry same release? | Same release | **DONE** — split version (LSHTierLib + VIPSubscription) shipped. |
| 5 | LSH tier migration timing? | All-at-once in v0.3 | **DONE** — clean slate, no v1 successor coordination. |
| 6 | Per-agent envelopes same release as registry? | Same release, pending Option A/B verification | **DONE** — envelopes shipped alongside the registry split. |
| 6a | Envelopes location: BCF or stash? | Stash (B) with library; verify size first | **DONE — Option B as recommended.** Library probe passed; AgentEnvelopeLib statically linked; stash impl 23.260 KiB (under ceiling). |
| 7 | Agent fee model: per-trade or subscription? | Subscription | **DONE** — subscription-funded. |
| 8 | Subscription split 40/35/25? | Yes with owner-tunable knobs | **DONE** — 3-sink split shipped + testnet-validated. `setBurnPercentage` / `setRebateBps` / `setTeamBps` + `setRebatePool` / `setTeamWallet`. See Gap 1 (closed). |
| 9 | "Stakers trade free for agents" via `_resolveOwnerOf` shim? | Yes | **DONE** — shipped as `_resolveBeneficialOwner`. |
| 10 | BCF events emit `agentReasoningTopicId`? | Yes | **DONE** — `BidCreated` / `BidCancelled` / `BidExecuted` / `ArbitrageExecuted` all carry the field. |
| 11 | EA reserve + anti-snipe? | Yes to both | **DONE** — `reservePrice` + `antiSnipeWindow` + `antiSnipeExtension` + `maxCloseAt` all implemented. |
| 12 | Subscription duration: month / quarter / year? | Monthly with annual-prepay discount | **DONE** — `purchaseSubscription(tier, months, proofs)` with pro-rated `annualPrepayDiscountBps` (default 2000 bps, capped via `maxCombinedDiscountBps`). |
| 13 | Cache freshness strict vs lenient? | Per-consumer choice | **N/A** — no cache layer because the split rendered caching unnecessary. The inlined library reads holdings/staking/delegation directly on each call. |
| 14 | Signed-tier-proof pattern? | Yes as optional hot path | **REVERSED** — see Section 1 item 4. msg.sender-only auth replaces this entirely. |
| 15 | LazyLotto migrate before its mainnet? | Yes if timing allows | **PENDING IN OTHER REPO** — see Section 4. |
| 16 | Hedera EVM EIP-1153 support? | Yes (resolved); not used | **AS DOCUMENTED** — not used. Gas is cheap; OZ ReentrancyGuard preferred for consistency. |

---

## Section 7 — Suggested ordering (DELTA v3 §"What this means for the v0.3 roadmap")

| # | Step | Live state |
|---|---|---|
| 1 | Empirical probes (envelope library size, registry storage, EIP-1153) | **DONE** — CREATE2 probe at `scripts/testing/create2Probe.js`; AgentEnvelopeLib size verified in `hardhat-contract-sizer` output; EIP-1153 confirmed supported but not adopted. |
| 2 | VIPRegistry v0.1 (standalone, no dependencies) | **DONE** as the LSHTierLib + VIPSubscription split. |
| 3 | v0.3 mainnet release (BCF + stash + envelopes + registry + agentReasoningTopicId + audit) | **TESTNET-VALIDATED**; awaiting mainnet activation. BCF↔LST testnet grant **applied 2026-05-29**. Outstanding gates: LazyLotto scanner cutover; final pre-mainnet checklist (working plan). |
| 4 | Marketplace SDK v0.1 | **DONE** at v0.1.0 on npm. |
| 5 | EnglishAuction contract | **DONE** — shipped alongside v0.3. |
| 6 | LazyLotto migration to registry | **PENDING IN OTHER REPO** — lotto code change owned by `hedera-SC-lazy-lotto`. |

---

## Gaps (in this repo)

Two items from the DELTA proposal are not implemented and worth
explicit acknowledgment. Both are minor relative to the
shipped scope but warrant a v0.4 or follow-up release.

### ~~Gap 1 — Subscription split: staker-rebate flow missing~~ — **CLOSED 2026-05-27**

**Was:** Binary split via `burnPercentage`; no staker-rebate.

**Now shipped:** Full 3-sink split with off-chain epoch-based
distribution. Lives at:
- `contracts/LazyRebatePool.sol` — Merkle-airdrop-style claim
  contract receiving the rebate slice, with quarterly epochs
  and 1-year claim windows.
- `contracts/LSHRebateMultipliers.sol` — pure-view reference
  for the per-NFT weight table (Gen1=50, Mutant=25, LSV=25,
  Gen2=10, max 60,000 scaled units).
- `contracts/VIPSubscription.sol` — patched with `rebateBps`,
  `teamBps`, `rebatePool`, `teamWallet` knobs + the 3-call
  LGS routing in `purchaseSubscription`.
- `scripts/ops/computeRebateEpoch.js` — off-chain
  audit-trail-producing tool. Reads mirror-node stake history,
  computes TWAPs, builds Merkle tree, settles on-chain.
- `test/RebateStack.test.js` — acceptance suite.
- Design doc: `docs/LazyRebatePool-DESIGN.md`.

The shipped design defers the LazyNFTStaking-side coupling. Rebate
distribution happens off-chain via mirror-node event scan +
TWAP compute; on-chain side is generic Merkle airdrop. No
cross-repo changes needed.

**Testnet rollout — DONE 2026-05-29.** The full ops loop is
deployed, wired, and validated end-to-end:
- `LSHRebateMultipliers` deployed `0.0.9077153` (immutables +
  multiplier table verified via mirror).
- `LazyRebatePool` deployed `0.0.9077172`, `associateLazy()`
  called (LAZY-associated, signer = operator for testnet).
- Fresh `VIPSubscription` `0.0.9077208` (supersedes the
  pre-rebate `0.0.9043912`), wired via
  `scripts/interactions/wireVipRebate.js`:
  `setRebatePool` + `setRebateBps(1000)` (10%) +
  `setTeamWallet(operator)` + `setTeamBps(0)`.
- `scripts/ops/computeRebateEpoch.js` implemented + validated
  against real staking history (`0.0.8019442`): 31 events /
  155 NFTs / 2 eligible users.
- **First epoch settled on-chain** — `currentEpoch=1`, Merkle
  root byte-exact match, `totalAllocated=999` confirmed via
  mirror. `scripts/interactions/fundRebatePool.js` is the
  operator top-up path.
- `test/VIPSubscription.test.js` V7.1-V7.3 — 3-sink purchase
  flow end-to-end, byte-exact slice assertions, 19/19.

**Mainnet rollout — PENDING.** Re-run the same deploy + wire
scripts against mainnet; rotate the rebate-pool **signer key off
operator** before go-live (testnet uses operator as signer for
convenience). Tracked in working plan pre-mainnet checklist.

### Gap 2 — Richer tier enum adoption in LazyLotto

**DELTA proposal:** LazyLotto adopts the Bronze/Silver/Gold/Platinum
tier enum as a "future product enhancement" — could offer
tiered odds / pot sizes.

**Live state:** LazyLotto's migration path is the boolean
`LSHTierLib.isAnyHolder(user)` shim. The richer tier enum is
available (LazyLotto could call `LSHTierLib.getTierFor(user)`
directly) but unused.

**Why deferred:** Product decision for the lotto team. Not a
v0.3 mainnet blocker.

### External — LazyLotto scanner cutover

**DELTA proposal + ops runbook §3:** scanner resolves stash → human
via `BCF.stashOwnerOf` so lotto credits route to the beneficial
owner, not the stash address.

**Live state:** documentation complete (`docs/v0.3-OPS-RUNBOOK.md` §3
includes worked pseudocode + pre-mainnet verification checklist),
**plus a self-contained handoff prompt**
(`docs/LOTTO-SCANNER-CUTOVER-PROMPT.md`) to drop into
`hedera-SC-lazy-lotto` as `CLAUDE.md` — a cold Claude session can
make the change from it. The handoff corrected a stale event-shape
note: `TradeCompleted` is `(seller, buyer, token, serial, nonce)` —
no `tradeId`/`hbarPaid`/`lazyPaid`. Code change lives in
`hedera-SC-lazy-lotto`. Required before BCF mainnet activation per
the verification checklist.

**Status:** doc-ready + handoff-prompt-ready; code-pending.

---

## Operational dependency

One outstanding item from the v0.3 push-to-mainnet path:

### LST↔BCF authorization timelock — ✅ APPLIED (testnet)

**Status (applied + verified on-chain 2026-05-29 via
`scripts/testing/diagAuthorizeFactory.js`):** the 48h-timelocked
grant was executed —
`LST.executeFactoryAuthorization(0x...8a48c9)` returned SUCCESS.
Post-state confirmed: `authorizedFactories[BCF] == true`,
`pendingFactoryAuthEta[BCF] == 0` (cleared). Stash-initiated trade
listings on testnet are now unblocked.

For **mainnet**: the same grant must be performed on the mainnet
LST↔BCF pair. Fresh LST first-time authorization is INSTANT (no
timelock); only subsequent re-authorizations are 48h-timelocked.
See ops runbook §1 post-deploy wiring order.

---

## Summary

**Complete on the contract surface.** All DELTA v3 in-scope items
shipped (or intentionally reversed for better outcomes during
implementation). The previously-flagged staker-rebate gap is now
closed end-to-end — contracts + ops scripts + first-epoch on-chain
settle + 19/19 end-to-end tests, all testnet-validated as of
2026-05-29. Remaining items are operational:
- ~~LST↔BCF testnet grant~~ **APPLIED 2026-05-29** —
  `authorizedFactories[BCF]==true`, pending ETA cleared.
- **Scanner cutover** in `hedera-SC-lazy-lotto` — doc + handoff
  prompt ready; code pending.
- **Rebate mainnet rollout** — re-run deploy/wire scripts on
  mainnet + rotate signer key off operator.
- **Mainnet activation** itself — fresh deploys + the pre-mainnet
  checklist sign-off (working plan).

The "Decisions to make together" table is fully resolved —
every numbered decision has a corresponding live-state entry,
and where the design adapted during implementation (decisions
1, 2, 4 in Section 1) the reasoning is documented inline in
the DELTA doc itself with `> REVERSED` annotations.

The v0.3 mainnet release is **ready when the operational
checklist** (see `docs/v0.3-WORKING-PLAN.md` "Pre-mainnet
readiness checklist") **is signed off.** The DELTA architectural
scope is no longer the blocker.

---

## Cross-references

- **DELTA source doc:** `docs/AGENT-MARKETPLACE-DELTA.md`
- **Live state plan:** `docs/v0.3-WORKING-PLAN.md`
- **Operations:** `docs/v0.3-OPS-RUNBOOK.md`
- **Integration guide:** `docs/v0.3-integration-guide.md`
- **Frontend dev context:** `docs/CLAUDE-FRONTEND-CONTEXT.md`
- **Runtime bootstrap:** `docs/AGENT-RUNTIME-BOOTSTRAP.md`
- **Security model:** `SECURITY.md`
- **Pre-mainnet readiness checklist:**
  `docs/v0.3-WORKING-PLAN.md` "Pre-mainnet readiness checklist
  (internal)" section
