# Agent Marketplace — Pickup Document

> **✅ SUPERSEDED** (2026-05-27). All six pickup items below have shipped.
> This doc is preserved for historical context — it captures the
> design-time open questions and how they were eventually resolved.
> For current state and next steps see `docs/v0.3-WORKING-PLAN.md`.
>
> Mapping to live state:
>
> | Pickup item | Status | Lives at |
> |---|---|---|
> | #1 Per-agent envelope contract | ✅ Shipped | `contracts/BidderContract.sol` + `contracts/libraries/AgentEnvelopeLib.sol`. Option B (envelopes on stash) won the bytecode probe. |
> | #3 HTS royalty handling for EA | ✅ Shipped | `contracts/EnglishAuction.sol` `_payRoyalties()` — manual royalty pulled from token's HTS fee schedule on settle. |
> | #4 `agentReasoningTopicId` on BCF events | ✅ Shipped | `BidCreated` / `BidCancelled` / `BidExecuted` / `ArbitrageExecuted` all carry the field. SDK `AgentAuth` tuple wraps `(agentKey, reasoningTopicId)`. |
> | #5 Marketplace SDK | ✅ Shipped | Published as `@lazysuperheroes/marketplace-sdk@0.1.0` on npm. Source at `packages/sdk/`. |
> | #6 VIP tier → agent allocation | ✅ Shipped | Locked table in `docs/v0.3-WORKING-PLAN.md` "Locked default tier table". Wired via `scripts/interactions/wireAgentTierLimits.js`. |
>
> Pickup item #2 (no record found in this file — likely numbered around earlier draft).

**Purpose (historical):** This was the resume-from-here doc for the agent-marketplace contract work. Each section below was a discrete continuation thread with enough context that a fresh Claude session could pick it up cleanly without re-reading the entire history.

**As of:** 2026-05-17 baseline. BCF v0.3 test rework + four design docs + this pickup doc committed; ready to begin implementation.

---

## Baseline (committed)

What's in the repo as of the baseline commit:

- **Design docs (`docs/`):**
  - `AGENT-MARKETPLACE-DELTA.md` (v3) — full architectural delta analysis + 16-row decisions table
  - `LSHTierLib-DESIGN.md` — statically-linked tier library (includes staking, EIP-1153 noted-but-unused)
  - `VIPSubscription-DESIGN.md` — paid subscription with holdings-based purchase discount + 14-day serial cooldown
  - `EnglishAuction-DESIGN.md` — timed auction primitive
  - `BCF-StashInitiatedListing-DESIGN.md` — closing the `createTradeOnBehalf` integration gap (P5.8)
  - `VIPRegistry-DESIGN.md` — supersede note pointing to the split docs

- **Test rework (`test/BidderContractFactory.test.js`):**
  - All v0.3 BCF surface tested: stash deployment, fund management, bid lifecycle, trade execution, arbitrage, rescue paths, governance timelock, pagination, extended coverage
  - Methodology: typed `expectRevertNamed` for negatives, mirror-first reads, `MIRROR_DELAY` sleeps, .env-gated account/contract reuse, explicit Clean-up describe

- **`.env.example`** — overhauled with the full account / contract / scanner / SCOOP env vars; `LST_CONTRACT_ID` ↔ `LAZY_SECURE_TRADE_CONTRACT_ID` naming unified in `deployBidderContractFactory.js`; scanner contract variable separated into `SECURE_TRADE_CONTRACT_ID`

- **Helper additions (`utils/`):**
  - `hederaHelpers.js`: `mintAdditionalSerial`
  - `hederaMirrorHelpers.js`: `findLastEventByName`, `getDecodedEventsFromMirror`

---

## Pickup item 1 — Per-agent budget envelope contract design doc

**Status:** Pending. Lynchpin for "Auto" autonomy tier. Explicitly deferred until the bytecode probe (Option A vs B) resolves, but the contract surface is mostly common across both options.

**What's decided:**
- Stash-as-session-key model (vs per-agent multisig or off-chain custody — see `AGENT-MARKETPLACE-DELTA.md` Section 5)
- Per-agent envelope struct: `{budgetLazy, budgetHbar, spentLazy, spentHbar, perTxLazyCap, perTxHbarCap, windowStart, windowSeconds, paused}`
- Owner can `setAgentEnvelope`, `pauseAgent`, `pauseAllAgents` — kill switch on the stash itself
- `spendForAgent(agentKey, hbarAmount, lazyAmount)` is the choke point in any factory-routed action drawing funds in an agent's name
- BCF events should tag `agentKey` in `ArbitrageExecuted`, `BidExecuted`, and `TradeCreatedFromStash`

**What's still open:**
- Option A (envelopes in BCF) vs Option B (envelopes in stash with `AgentEnvelopeLib` static linking) — needs bytecode probe before commitment
- Whether to support the `agentKey` tag on existing v0.3 events (BidCreated, BidCancelled, BidExpired) for consistency
- Rolling-window semantics: calendar-day vs sliding-window-from-windowStart
- Should the envelope support per-agent token allowlist (agent X can only spend on token Y)?
- VIP tier → agent slot count + daily budget mapping (see pickup item 6)

**Suggested agent prompt for next session:**

> Draft `docs/AgentEnvelope-DESIGN.md`. Context: the per-agent budget envelope is the security-critical mechanism that lets the agentic layer act autonomously on behalf of users without unbounded fund access. Read `docs/AGENT-MARKETPLACE-DELTA.md` Section 5 + the per-agent envelope subsection. Read `docs/BCF-StashInitiatedListing-DESIGN.md` for how `agentKey` threads through stash-initiated paths. The contract surface should support both Option A (envelopes in BCF) and Option B (envelopes in stash via `AgentEnvelopeLib`); call out the bytecode probe needed to commit. Match the depth and structure of `docs/VIPSubscription-DESIGN.md`. Cover: storage layout, interface (per-agent setters, `spendForAgent` choke point, owner kill switches), subcall budget per common path, rolling-window math, integration callouts for BCF arbitrage / BidExecution / stash-initiated listing, test plan outline, pre-implementation probe checklist. Open with the same "Status / Companion to / Target release" frontmatter as the other design docs.

---

## Pickup item 3 — HTS royalty handling probe for EnglishAuction settlement

**Status:** Probe needed before EnglishAuction implementation can finalize the settlement flow.

**What's known (from user):**
- HTS royalty fires automatically when an NFT moves **against value** in the same atomic operation
- If the value has been transferred separately (e.g. funds escrowed earlier, NFT moves later), royalty does NOT auto-fire — must be paid manually
- EnglishAuction has this exact pattern: bids escrow on `placeBid`; NFT + final payment settle in `settle()` — value and NFT are separated in time

**Implication:** auction settlement must compute + pay royalty manually, same pattern as LST's existing handling. Cannot rely on HTS auto-royalty.

**What's still open:**
- Read HTS royalty fee schedule on-chain (need to verify which interface — likely `getTokenCustomFees` or similar on HTS precompile)
- Royalty receiver address: read from token's HTS fee schedule, not hardcoded
- Whether to split royalty across multiple receivers if HTS schedule has multiple fee items
- Caching the royalty schedule per token to save subcalls on repeat settlements
- Reusable: extract LST's royalty computation into a shared `HTSRoyaltyLib` to avoid duplicating in EnglishAuction

**Suggested agent prompt for next session:**

> Resolve the HTS royalty handling question for `docs/EnglishAuction-DESIGN.md` (Section "Pre-implementation probe checklist", item 3). Confirmed by user: HTS only auto-fires royalty when NFT moves against value in the same operation. Auctions separate the value transfer (escrow on bid) from the NFT transfer (settlement), so royalty must be paid manually. Read `contracts/LazySecureTrade.sol` to find LST's existing royalty computation pattern. Decide: (a) factor into a shared `HTSRoyaltyLib` for EnglishAuction + future contracts to reuse, or (b) inline in EnglishAuction. Then update the `EnglishAuction-DESIGN.md` settlement flow section to specify the manual royalty path with subcall counts. Probe HTS precompile interface for reading royalty fee schedules (`getTokenCustomFees` or equivalent).

---

## Pickup item 4 — Add `agentReasoningTopicId` to BCF events

**Status:** Pending. Approved by user. Should be added before v0.3 mainnet deploy.

**What's decided:**
- Add `bytes32 agentReasoningTopicId` field to BCF events: `BidExecuted`, `ArbitrageExecuted`, possibly `BidCreated` and `BidCancelled` for consistency
- Lets the agentic layer correlate on-chain actions to HCS-10 topic IDs where agent reasoning was logged
- Cheap to add now (event schema change), expensive to add later (breaking event consumers)
- Zero value (`bytes32(0)`) = "no agent reasoning topic provided" — owner-initiated actions

**What's still open:**
- Exact event list to extend (security: BidCreated/BidCancelled probably worth it; BidExpired maybe)
- Where the topic ID comes from on the call: a new parameter on `executeArbitrage`, `cancelBid`, `createBid`? Probably yes
- Should this be the SAME parameter shape as the `agentKey` field from per-agent envelopes (might collide)?

**Suggested agent prompt for next session:**

> Implement the agent reasoning topic ID addition to BCF events for v0.3 mainnet. Context: lets the agentic layer correlate on-chain actions to HCS-10 topic IDs. Read `docs/AGENT-MARKETPLACE-DELTA.md` decisions table item 10 + the corresponding section. Read `contracts/BidderContractFactory.sol` and identify the events that need the field: at minimum `BidExecuted` and `ArbitrageExecuted`. Decide whether to also add to `BidCreated` and `BidCancelled` for consistency. Add a new parameter (e.g. `bytes32 agentReasoningTopicId`) to the corresponding function signatures (`createBid`, `cancelBid`, `executeAgainstBid`, `executeArbitrage`) with `bytes32(0)` as the "no topic" sentinel. Coordinate with the per-agent envelope `agentKey` field design (`docs/AgentEnvelope-DESIGN.md` if drafted by then) — likely two separate fields, not one. Update BCF test rework (`test/BidderContractFactory.test.js`) to pass and assert on the new field. Verify bytecode size stays within budget after the change.

---

## Pickup item 5 — Draft `@lazysuperheroes/marketplace-sdk` package outline

**Status:** Pending. Approved. Unblocks the agentic-layer repo to start design in parallel.

**What's decided:**
- Pattern matches `@lazysuperheroes/farming-sdk` in `D:\github\hedera-SC-LAZY-Farms\packages\sdk`
- Package name: `@lazysuperheroes/marketplace-sdk`
- TS-first; `tsup` build matching the existing sibling SDK
- Exports: ABIs, ethers Interfaces, TS types, mirror-node read helpers, write-path helpers returning `TransactionRequest`, event decoders, contract ID registry per network

**What's still open:**
- Whether the SDK ships before or after v0.3 mainnet (suggested: shortly after, to package the actual deployed addresses)
- Whether to include thin agent-context helpers (e.g. resolveTierForStashOwner) or keep it purely transport
- Whether mirror helpers should be re-exported from a deeper utility package or stay first-party
- Versioning strategy aligned with contract releases

**Suggested agent prompt for next session:**

> Draft `docs/MARKETPLACE-SDK-DESIGN.md`. Context: the `@lazysuperheroes/marketplace-sdk` is the NPM-package surface that the separate agentic-layer repo will consume to interact with LST v2, BCF, EnglishAuction, VIPSubscription, and stash contracts. Reference the existing `D:\github\hedera-SC-LAZY-Farms\packages\sdk\package.json` for the precedent (exports field, tsup build, abi/ subpath). Cover: package metadata (name, exports, peer deps), folder layout (`src/abi`, `src/types`, `src/mirror`, `src/contracts`), the public API by contract (typed contract bindings, read helpers that wrap `readOnlyEVMFromMirrorNode`, write-path helpers that return populated TransactionRequest objects for signing in the agentic layer), event decoder API based on `findLastEventByName`, contract ID registry per network (testnet/mainnet), TypeScript type generation strategy (typechain vs hand-rolled vs ABI-derived). Pre-implementation probe: confirm whether to add a `packages/sdk` subdirectory to the LST repo (matching LAZY-Farms structure) or publish from a separate repo.

---

## Pickup item 6 — VIP tier → agent slot / daily budget mapping

**Status:** Pending. Product call needed before per-agent envelope contract can be specced concretely.

**What's known:**
- `VIPSubscription` returns a tier (Bronze/Silver/Gold/Platinum); consumers translate tier → benefits
- Frontend (`d:\nft-marketplace\project\profile.jsx:269-292`) hints at VIP tier limits: "5 agent slots, 35,000 LAZY daily budget, 8,000 LAZY auto-bid cap, priority lane"
- Per-agent envelope contract needs concrete numbers per tier to enforce limits

**What's still open (all product calls):**
- Agent slots per tier: Free = 0? Bronze = 1? Silver = 2? Gold = 3? Platinum = 5?
- Daily budget per tier (in $LAZY equivalent)
- Per-tx cap per tier
- Whether "priority lane" maps to anything on-chain (probably purely UX / agentic-layer)
- Whether limits are per-stash (one user, all their agents) or per-(stash, agent)

**Suggested agent prompt for next session:**

> Coordinate with the user on concrete VIP tier → agent allocation numbers. Read `docs/VIPSubscription-DESIGN.md` open-product-decisions section + `docs/AGENT-MARKETPLACE-DELTA.md` decisions table item 12 area. Reference the frontend hints in `d:\nft-marketplace\project\profile.jsx` lines 269-292 for design-team intent. Propose a starter table (agent slots / daily $LAZY budget / per-tx $LAZY cap, per tier) with rationale anchored on subscription economics (the higher tiers should pay enough to justify the higher allocation). After user confirms numbers, update `docs/AgentEnvelope-DESIGN.md` (if it exists yet) with the concrete limits as constructor defaults.

---

## Notes for any continuation session

- The user's testing methodology (mandatory): typed error names via `expectRevertNamed`, mirror-first reads, 5-second `MIRROR_DELAY` sleeps after writes, .env-gated reuse, explicit Clean-up describe. See `feedback-test-methodology` memory.
- Gas on Hedera is cheap + static-priced — do not optimize at the cost of readability. EIP-1153 transient storage is supported but not used.
- Hedera subcall ceiling is 50 per tx — every cross-contract call counts. Be deliberate about wrappers and abstractions.
- 24,576-byte bytecode limit per contract enforced strictly (`contractSizer.strict: true`). Profile with `hardhat-contract-sizer` before committing to any non-trivial contract surface.
- LST v1 sunsetting; v0.3 branch is the next mainnet release. Clean slate — no migration coordination needed.
- LSH set is prestige-fixed (Gen 1 / Mutant / Gen 2) for trade fees; extensions go via VIPSubscription's admin-tunable discount table or coordinated consumer redeploys for free-trade extension.

---

*This document should be updated as each pickup item is resolved. Items that ship to mainnet move to a "Completed" section; new follow-ups get added at the bottom.*
