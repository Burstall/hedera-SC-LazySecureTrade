# LazySecureTrade — Adversarial Audit POST-FIX (2026-07-03, 2nd re-run)

> Third pass of lst-security-audit, run AFTER the F-1/F-2/F-3 fixes landed + tested green.
> Agents: 102. Raw: 45 (3 confirmed, 3 contested, 39 refuted).
> Result: risk posture dropped from 2 High (prior re-run) to 0 Critical/High. F-2 + F-3 (stash) closed.
> Remaining: 1 gap in F-1 (executeAgainstBid), 1 pre-existing EA settle-liveness Medium, plus Low/Informational.

---
# LazySecureTrade Suite — Final Security Audit Report

**Scope:** LazySecureTrade (LST), BidderContract / BidderContractFactory (per-user "stash" + CLOB bidding + arbitrage), EnglishAuction, VIPSubscription, LazyRebatePool, and the shared `TokenStakerV2` HTS base.
**Target chain:** Hedera (EVM via HTS precompiles).
**Date:** 2026-06-28.

---

## 1. Executive Summary

This report consolidates only findings that survived adversarial cross-verification. Each candidate issue was independently re-checked by two verifiers against contract source. Findings are labelled **CONFIRMED** (both verifiers ruled the issue real) or **CONTESTED** (the verifiers split on whether it is real / on its severity). Every distinct issue is preserved; nothing is dropped for being role-gated.

**Headline risk posture: no CONFIRMED Critical or High issues.** The most serious confirmed problems are two **Medium** issues, plus one **Low** economic-consistency bug. Three further items are **Contested** (Low / Informational).

**Anonymously reachable — read this first.** One confirmed issue is reachable by any account with no special role:

- **Finding 1 (Medium, EnglishAuction):** *any* account can place the winning bid from an account that is **not associated** with the auctioned NFT token. Because the only exit from a bid-carrying, closed auction is `settle()`, and `settle()` hard-requires delivering the NFT to that winner, an unassociated winner makes settlement revert **forever**. The seller's escrowed NFT and the winner's escrowed bid are then permanently locked. This works with zero privileges and is a griefing vector (though the griefer's own bid is trapped alongside the victim's NFT — a mutual-assured-lock that caps the economic incentive, see the severity split).

The dominant theme across the confirmed and contested set is **EnglishAuction settlement liveness**: four of the six distinct issues live in `EnglishAuction`, and three of them are *independent* ways the deferred-settle path (`_settleInternal` → `_releaseBundle`) can revert permanently on Hedera (unassociated recipient; missing custody-hop HBAR allowance for direct-EOA recipients; royalty-collector subcall fan-out). EnglishAuction has **no owner rescue hatch** and `cancelAuction` is blocked once a bid exists, so any of these reverts that becomes reachable strands both the NFT and the escrowed funds with no on-chain recovery. This structural fragility — a single mandatory delivery step with no fallback — is the report's central recommendation area even though only one instance is fully confirmed.

The remaining confirmed issues are an authorization gap on the agent path of `executeAgainstBid` (an owner-granted agent can sell the principal's approved NFT below the owner's configured floor — Medium, role-gated) and an LSH fee-tier snapshot bug that silently overcharges stash-mediated auction listers (Low, self-inflicted value loss).

---

## 2. Findings Overview (severity-ordered)

| # | Severity (final) | Contract | Anonymously reachable | Status |
|---|------------------|----------|-----------------------|--------|
| 1 | **Medium** | EnglishAuction | **Yes** — any bidder from an unassociated account | CONFIRMED |
| 2 | **Medium** | BidderContractFactory | No — requires owner-granted `TradeExecute` agent + colluding bidder | CONFIRMED |
| 3 | **Low** | EnglishAuction | No — self-inflicted value loss (stash lister) | CONFIRMED |
| 4 | **Low** | EnglishAuction (root: TokenStakerV2) | Yes — any direct-EOA auction path | CONTESTED |
| 5 | **Low** | EnglishAuction | No — requires seller-crafted high-royalty bundle | CONTESTED |
| 6 | **Informational** | LazySecureTrade | No — event data only, cancel is owner-only | CONTESTED |

---

## 3. Detailed Findings

---

### Finding 1 — EnglishAuction settlement permanently locks the seller's NFT (and winner's funds) if the winning bidder is not associated with the bundle token
**Final severity: Medium** — CONFIRMED
**Verifier split (severity):** one verifier Low, one verifier Medium — both ruled it *real*. Adjudicated **Medium**: the impact is a permanent, unrecoverable lock of the seller's asset and the winner's funds, which is a Medium-grade liveness failure. The Low argument is legitimate and preserved: to reach the success branch the griefer must be the standing high bidder at `closeAt`, and their winning bid stays trapped in the contract alongside the victim's NFT (no withdrawal path exists for a stuck-but-Open auction) — a "mutual assured lock" that removes any profit motive and bounds this to griefing / accidental-abandonment rather than theft. It is nonetheless anonymously reachable and unrecoverable, which is why Medium is retained.

**Location:**
- `contracts/EnglishAuction.sol:627-689` — `_settleInternal`, success branch at **:672** `_releaseBundle(itemsCopy, winner)`
- `contracts/EnglishAuction.sol:519-606` — `_placeBid` (validates payment only; never NFT association)
- `contracts/EnglishAuction.sol:469-490` — `cancelAuction` guard at **:476** (`a.highBidder != address(0)` blocks cancel)
- `contracts/EnglishAuction.sol:916-941` — `_releaseBundle` → `moveNFTs(WITHDRAWAL,...)`
- Revert origin: `TokenStakerV2` HTS response-code check on a non-SUCCESS `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.

**What & why:** Once an auction has a winning bid and passes `closeAt`, the only exit from the Open state is `settle()`. On the success branch (`success = winner != address(0) && winningBid >= reservePrice`, line 638; with an unset/zero reserve any bid qualifies), `_settleInternal` hard-requires delivering the bundle to the winner via `_releaseBundle(itemsCopy, winner)`. On Hedera, an NFT transfer to an account not associated with that token returns a non-SUCCESS code and `moveNFTs` reverts, unwinding the entire `settle()` (the `delete auctions[auctionId]` at line 642 is rolled back — this is the intended "re-call settle after associating" recovery, audit finding I). But `_placeBid` never checks association, so a bidder can *win* without ever being associated. If the winner never associates (abandons, loses keys, or maliciously griefs), settle reverts forever. There is **no fallback**: `cancelAuction` reverts once `highBidder != 0`, the removed `claimAuctionNFT` queue no longer exists (finding I), and EnglishAuction exposes **no owner rescue** (unlike the stash's `rescueNFT`).

**Exploit / impact path:** Mallory bids the reserve on Alice's auction from an account not associated with the collection. The auction closes with Mallory as winner. Any caller invokes `settle()` → `_releaseBundle(winner=Mallory)` reverts (`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`) → whole `settle()` reverts. Mallory never associates. Alice's NFT is escrowed forever; Mallory's winning bid (held in-contract, not queued) is also locked. An honest winner who simply loses access produces the identical permanent lock. `buyNow` is safe because it settles atomically in the same tx (an unassociated buyer just reverts before committing); only the deferred-settle-via-resting-bid path is exposed.

**Preconditions (who must act):** Any account (no role). The griefer must (a) be the standing high bidder at `closeAt` and (b) forgo their own escrowed bid, which is trapped by the same lock.

**Fix (code-level):** Add a delivery-failure fallback in the success branch of `_settleInternal`: if `_releaseBundle` to the winner fails, refund the winner via the pull-payment claim queue and return the bundle to the seller (fail the auction). Alternatively, reinstate a per-recipient NFT claim queue so an undeliverable NFT can be pulled later without bricking settlement, **or** add an owner-gated `rescueAuctionNFT` escape hatch. Do not make winner cooperation the sole resolution path for a bid-carrying auction.

---

### Finding 2 — Agent path of `executeAgainstBid` bypasses the F-1 listing floor, letting a compromised agent alienate the principal's approved NFT below the owner-set floor
**Final severity: Medium** — CONFIRMED
**Verifier split (severity):** one verifier Medium, one verifier Low — both ruled it *real* and reachable. Adjudicated **Medium**: it is a genuine, unmitigated alienation of the principal's asset below the owner's explicitly configured floor, defeating exactly the control (F-1) that was added to bound agent NFT give-aways. The Low view is preserved: the blast radius is limited to serials the principal has *already approved* to LST, and a distinct colluding bidder is required (the self-trade gate blocks the principal bidding on themselves).

**Location:**
- `contracts/BidderContractFactory.sol:1476-1564` — `executeAgainstBid` (no `_assertListingFloor` call)
- Price check present is `bid.hbarAmount >= bid.minAcceptablePrice` (**:1519**) — a *bidder*-set floor, not the seller/owner floor
- Agent envelope resolved with budget 0/0 via `_resolveAgentOrOwner` (**:1498**, helper at **:1935**); seller passed as `effectiveCaller = stashOwnerOf[callerStash]` (**:1529**)
- Self-trade gate at **:1509** (`effectiveCaller != _resolveBeneficialOwner(bid.user)`)
- Contrast — floor **is** enforced on the other two agent alienation paths: `createTradeOnBehalfOfStash` (**:1361-1377**, floor at 1368-1376) and `assertAgentAuctionAllowed` (**:1316-1326**, 1324-1325)

**What & why:** Audit finding F-1 introduced per-stash `AgentListingFloor` price floors specifically to bound NFT *alienation* on agent-originated paths — the agent envelope's HBAR/LAZY value caps are *spend* limits and cannot bound how cheaply an agent gives an NFT away (list/execute dispatches pass 0/0 budget). The floor is enforced in `createTradeOnBehalfOfStash` and the auction path, but **not** in `executeAgainstBid`, which is itself an alienation path: it creates and immediately executes a *closed* trade selling the principal's NFT into a resting bid at `bid.hbarAmount`. It performs only the envelope check (budget 0/0) and the bidder-protecting `bid.hbarAmount >= bid.minAcceptablePrice` check. It never calls `_assertListingFloor`. Consequently an agent holding `TradeExecute` can match the principal's already-approved NFT against an arbitrarily low resting bid, below the owner's configured floor (or on a rail the owner disabled).

**Exploit / impact path:** Alice authorizes agent A with `TradeExecute` and sets an HBAR agent-listing floor of 100 HBAR. Alice has an NFT listed on LST (approved to LST). Compromised/malicious agent A calls `executeAgainstBid` matching a colluder's resting 1-HBAR bid for that collection/serial. No floor check runs; LST pulls Alice's approved NFT and delivers it to the colluder's stash for ~1 HBAR — far below Alice's 100-HBAR floor. Partial mitigations present but insufficient: the self-trade gate (1509) is checked against the *bidder's* beneficial owner, so a distinct colluding bidder passes; and `bid.minAcceptablePrice` protects the bidder, not the seller.

**Preconditions (who must act):** The principal must have granted agent A the `TradeExecute` permission, and A must be compromised/malicious; a distinct colluding bidder is required. **Not anonymously reachable** — but the whole point of the agent envelope is to survive a compromised agent, and this path defeats that guarantee for approved serials.

**Fix (code-level):** Enforce the F-1 floor on the agent path of `executeAgainstBid`. When `auth.agentKey != address(0)`, call `_assertListingFloor(<principal's stash>, isLazy, bid.hbarAmount / bid.lazyAmount)` (mirroring `createTradeOnBehalfOfStash:1368-1376`), reverting when the matched bid price is below the owner's rail floor or the rail is disabled.

---

### Finding 3 — EnglishAuction snapshots the raw seller's LSH tier instead of the beneficial owner's, so stash-listed auctions silently lose their LSH fee discount
**Final severity: Low** — CONFIRMED
**Verifier split:** none — both verifiers ruled it real and Low.

**Location:**
- `contracts/EnglishAuction.sol:435` — `a.sellerTierAtCreate = uint8(_resolveSellerTier(seller))` with `seller` = the stash address
- `contracts/EnglishAuction.sol:964-972` — `_resolveSellerTier` (forwards the raw address into the LSH tier lib)
- `contracts/EnglishAuction.sol:333-340` — `_resolveBeneficialOwner` exists and is applied for self-bid gating (473, 531) and cancel-auth (473) but **not** to the tier snapshot
- Stash entry: `contracts/BidderContract.sol:1032/1070` — `createAuctionListing` forwards to `EA.createAuction` with `msg.sender = stash`
- Contrast: `LazySecureTrade.sol:1788` — `calculateSellerFeeRate(_resolveBeneficialOwner(trade.seller))` ("Bug 3" fix)

**What & why:** When an auction is created through a stash, `_createAuctionFor` records `a.sellerTierAtCreate = _resolveSellerTier(seller)` where `seller` is the stash address. The stash holds no LSH tokens (they live in the human owner's wallet), so `_resolveSellerTier` returns the Free tier and the seller is charged the full `protocolFeeBps`. EnglishAuction already resolves the beneficial owner elsewhere but fails to apply it to the tier snapshot — inconsistent with LST, which explicitly resolves the beneficial owner for fee-tier purposes.

**Exploit / impact path:** Not an attack — a value-loss / consistency bug. Bob holds LSH Gen1 (entitled to 0% protocol fee) but lists an auction through his stash. At settle, `_computeProtocolFee` uses the snapshotted Free tier and deducts the full ~1% from his proceeds into `protocolFeesAccrued`. Bob overpays relative to listing the identical item directly from his EOA.

**Preconditions (who must act):** The affected party is the stash-listing seller themselves; **self-inflicted, no attacker**. Affects every LSH-holding user who lists via a stash.

**Fix (code-level):** Resolve the beneficial owner before snapshotting the tier:
`a.sellerTierAtCreate = uint8(_resolveSellerTier(_resolveBeneficialOwner(seller)));`
This mirrors LST and preserves the LSH discount for stash-mediated listings while keeping the settle-time snapshot that prevents "sell-LSH-before-settle" gaming.

---

### Finding 4 — EnglishAuction NFT delivery/return can revert for direct-EOA users because the recipient never granted the custody-hop HBAR allowance
**Final severity: Low** — CONTESTED
**Verifier split (real / severity):** Verifier A: **real, Low**. Verifier B: **not real, Informational**. Both agree the *code mechanics* are accurate; they split on impact. Verifier B classifies this as the repo's already-adjudicated **F-3** finding (`docs/SECURITY-AUDIT-2026-07-03-rerun.md`) whose stash-side fix (`_ensureHbarAllowanceForCustodyHop`) was deemed the intended resolution, and argues the direct-EOA path is not a supported/first-class flow → Informational. Verifier A accepts the mechanism as reachable for direct-EOA callers but downgrades the finder's original **High** to **Low** because settlement is *atomic and idempotent*: the failing `settle()` unwinds `delete auctions[auctionId]` (EA:642), leaving the auction Open, so once the recipient grants the allowance out-of-band, a permissionless `settle()` / `cancelAuction` can simply be re-called — no permanent brick. **Adjudicated Low** and kept as CONTESTED: it is a real, reachable liveness/UX hazard on the direct-EOA path but is recoverable (unlike Finding 1's association case, which has no recovery), and it overlaps a previously-adjudicated finding.

**Location:**
- Root cause: `contracts/TokenStakerV2.sol:125-146` — WITHDRAWAL leg builds `transfers[0] = {accountID: receiver, amount: -CUSTODY_HOP_TINYBAR, isApproval: true}`, i.e. the 1-tinybar hop is **debited from the recipient via an HBAR allowance the recipient must have granted to EnglishAuction**
- `contracts/EnglishAuction.sol:916-941` — `_releaseBundle`; `:672` (winner delivery) & `:683` (reserve-not-met seller return); `:614-619` — permissionless `settle()`; `:487` — `cancelAuction` seller return
- Stash-side compensation that does *not* cover direct EOAs: `BidderContract.sol:1056/1094/1126` — `_ensureHbarAllowanceForCustodyHop` before forwarding (F-3 fix); failure-mode comment at `BidderContract.sol:875-876`

**What & why:** Every NFT leaving EnglishAuction goes through `moveNFTs` WITHDRAWAL, which debits the *recipient* one tinybar with `isApproval=true`. HTS rejects that debit with `SPENDER_DOES_NOT_HAVE_ALLOWANCE` when no allowance exists. Stash-mediated paths pre-grant the allowance (F-3). But EnglishAuction exposes public `createAuction`/`placeBid`/`buyNow`, and `_resolveBeneficialOwner` returns EOAs unchanged, so direct-EOA participation is a supported path — yet nothing in EnglishAuction ever grants the custody-hop allowance for a direct-EOA winner or seller. Because `settle()` is permissionless, the winner is typically not the tx signer, so the allowance is strictly required and absent. The same defect hits the seller-return paths (`cancelAuction`, reserve-not-met branch): a direct-EOA seller who never granted the allowance cannot reclaim an unsold/cancelled NFT until they grant it.

**Exploit / impact path:** Alice (EOA) lists directly (escrow works — STAKING leg debits the *contract*). Bob (EOA) bids via `placeBid` and wins. Anyone calls permissionless `settle()` → `_releaseBundle(items, Bob)` → WITHDRAWAL debits Bob 1 tinybar `isApproval=true` → `SPENDER_DOES_NOT_HAVE_ALLOWANCE` → revert. Bob's bid and Alice's NFT stay escrowed until Bob independently grants EnglishAuction an HBAR allowance out-of-band, after which `settle()` can be re-called. Parallel case: Alice's `cancelAuction` on a zero-bid listing reverts for the same reason until she grants the allowance.

**Preconditions (who must act):** Any direct-EOA winner/seller who has not granted EnglishAuction a HIP-906 HBAR allowance. Recovery requires the affected recipient to grant the allowance (there is no dedicated on-chain function for it), then re-call the permissionless `settle()`/`cancelAuction`. **Reachable via normal usage; recoverable.**

**Fix (code-level):** Do not require the NFT recipient to pre-fund the custody hop on EnglishAuction's delivery/return path. Preferred: restructure the WITHDRAWAL custody hop so the **contract** (already the payer on the STAKING leg and seedable) bears the 1 tinybar — debit `address(this)` for the bookkeeping hop instead of the receiver. If `moveNFTs` must stay shared with LST unchanged, add an EA-internal delivery that pays the custody-hop tinybar from EA's own balance, or auto-grant / require the allowance for direct callers analogous to F-3. At minimum document the hard prerequisite and add tests: a direct-EOA winner's permissionless `settle()` succeeds, and a direct-EOA seller can cancel a zero-bid auction.

---

### Finding 5 — EnglishAuction settlement can exceed Hedera's 50-subcall limit via royalty-collector fan-out, locking the auction
**Final severity: Low** — CONTESTED
**Verifier split (real / severity):** Verifier A: **not real, Informational** — argues the reachable permanent lock fails on multiple grounds, chiefly the finding-B royalty clamp (`EA:656-657 if (amt > sellerProceeds) amt = sellerProceeds`) plus the `amount==0` short-circuit in `_payOrQueue` (line 1010): once the running remainder is exhausted, further royalties compute `amt=0` and emit **no** subcall, neutralising the fan-out for the realistic bid range. Verifier B: **real, Low** — the clamp bounds the payout *sum* but **not the count**; many small-bps collectors can each still compute a non-zero `amt` and fire a subcall (per-collector `.call` for HBAR, `IERC20.transfer` for LAZY), and nothing hard-caps the royalty entry count (`_snapshotRoyalty:904` has no aggregate cap; items capped at 10 but Hedera allows up to ~10 custom fees/token → up to ~100 entries). **Adjudicated Low** and kept CONTESTED: the mechanism is real and not fully closed by a hard guard, but reachability depends on an adversarial/degenerate bundle configuration and is substantially blunted by the finding-B remainder clamp, so the practical likelihood is low.

**Location:**
- `contracts/EnglishAuction.sol:892-912` — `_snapshotRoyalty` (unbounded `push` per fee; no aggregate cap, line 904)
- `contracts/EnglishAuction.sol:644-689` — `_settleInternal` royalty loop (654-663) + bundle release
- `contracts/EnglishAuction.sol:1004-1021` — `_payOrQueue`: HBAR `payable(collector).call` (1012) / LAZY `transfer` (1015) — one subcall per collector; `amount==0` short-circuit at 1010
- `contracts/EnglishAuction.sol:916-941` — `_releaseBundle` (up to 10 `cryptoTransfer` subcalls)
- Item cap: `_createAuctionFor` caps items at 10 (411) but not royalty entries

**What & why:** At create time `_snapshotRoyalty` pushes one `RoyaltyInfo` per royalty fee on every unique NFT token in the bundle, uncapped. A bundle may hold up to 10 tokens, each carrying multiple royalty collectors. At settlement, each non-zero payout is one `_payOrQueue` subcall; combined with up to 10 `_releaseBundle` transfers, the seller payout, and STAKING/refund legs, a high-collector bundle can exceed Hedera's hard 50-subcall ceiling. Since `settle()` reverts entirely (no gas refund on Hedera) and there is no admin/rescue path (`cancelAuction` reverts once a bid exists), such an auction can never settle — the winner's escrowed bid and the seller's NFTs are stranded, and no refund is queued (the refund path lives inside the same reverting `settle`). The finding-B fix addressed royalty *underflow*, not subcall *count*.

**Exploit / impact path:** A seller lists a bundle of NFTs from collections that collectively define enough small-bps collectors that clearing all non-zero payouts (bid large enough that the finding-B remainder is not exhausted) plus the bundle transfers exceeds 50 subcalls. A winning bid is escrowed; after `closeAt`, every `settle()` reverts on the subcall ceiling, locking the NFTs and the bidder's funds with no on-chain recovery.

**Preconditions (who must act):** A seller must construct (or a collection creator must define) a bundle whose aggregate royalty-collector count pushes settlement past ~50 subcalls, *and* a bid high enough to keep the per-collector `amt` non-zero after the finding-B clamp. Requires a bidder to fund escrow. **Not anonymously reachable** — depends on a seller-crafted / degenerate-royalty bundle.

**Fix (code-level):** Cap the total number of royalty collectors snapshotted per auction (reject bundles whose aggregate royalty-collector count would push settlement past a safe subcall budget), **or** move royalty payouts entirely into the pull-payment (`claimable*`) queue so settlement performs O(1) subcalls and collectors pull separately. Bound the settlement subcall cost independently of bundle royalty configuration. (This structurally hardens Findings 1, 4, and 5 at once by removing mandatory push-delivery from `settle`.)

---

### Finding 6 — `cancelBatchTrade` emits `BatchTradeCancelled` with `itemCount` always 0 (storage read after delete)
**Final severity: Informational** — CONTESTED
**Verifier split (real):** Verifier A: **not real** — technically accurate but not a security vulnerability; the authoritative `itemCount` is recoverable off-chain from `BatchTradeCreated`/`BatchTradeExecuted` (both carry the correct count and index `batchId`). Verifier B: **real, Informational** — the defect is accurate and unmitigated (no require/cap/try-catch touches the emitted count), but it is event-data quality, not a fund/logic risk. **Both agree on Informational severity**; they split only on the "is it a vulnerability" label. Adjudicated **Informational**, kept CONTESTED per the real/not-real split.

**Location:**
- `contracts/LazySecureTrade.sol:600-615` — `cancelBatchTrade`: binds `BatchTrade storage batchTrade` (601), calls `_cleanupBatchTrade(_batchId, batchTrade)` (612), then emits `BatchTradeCancelled(_batchId, msg.sender, batchTrade.items.length)` (614)
- `contracts/LazySecureTrade.sol:1886-1910` — `_cleanupBatchTrade` ends with `delete batchTradesMap[_batchId]` (1909), recursively zeroing the `TokenSerialPrice[] items` array
- Contrast: `LazySecureTrade.sol:1193-1203` — `executeBatchTrade` deliberately emits **before** cleanup ("Last step else storage variables get cleaned up")

**What & why:** `cancelBatchTrade` holds `batchTrade` as a storage pointer into the slot it just deleted, so `batchTrade.items.length` reads 0 at emit time. Every cancellation reports `itemCount = 0` — a use-after-delete storage read — inconsistent with `executeBatchTrade`, which emits before cleanup. No funds are affected.

**Exploit / impact path:** Alice cancels a 10-item batch trade; the `BatchTradeCancelled` event carries `itemCount = 0`. An off-chain indexer trusting the event under-counts cancelled items or mis-reconciles open inventory (recoverable by cross-referencing the create/execute events, which is why this is Informational).

**Preconditions (who must act):** The batch-trade owner cancelling their own batch. **Not an attack surface.**

**Fix (code-level):** Capture the length into a local before cleanup, or reorder to emit before cleanup (as `executeBatchTrade` does):
`uint256 n = batchTrade.items.length; _cleanupBatchTrade(_batchId, batchTrade); emit BatchTradeCancelled(_batchId, msg.sender, n);`

---

## 4. Caveats

- **This was an automated, multi-agent adversarial review**, not a formal audit. Findings were generated by finder agents and re-checked by two verifier agents each against source; severities are verifier-adjusted consensus, not the product of manual expert sign-off.
- **It is not a substitute for a professional security audit, fuzzing, or formal verification.** In particular, the EnglishAuction settlement-liveness cluster (Findings 1, 4, 5) and the Hedera 50-subcall / HTS-allowance semantics warrant targeted differential/fuzz testing on a live testnet before any mainnet deployment, since these behaviours are Hedera-precompile-specific and not captured by standard EVM reasoning.
- **Contested findings reflect a genuine split** and should be re-evaluated with the additional context noted (e.g., Finding 4's overlap with the repo's F-3 adjudication; Finding 5's dependence on degenerate royalty configurations). They are reported at the adjudicated severity but not asserted as settled.
- **No claim of completeness.** Absence of a Critical/High confirmed finding here does not imply the suite is free of them; it reflects only what this pass surfaced and what survived cross-verification. VIPSubscription, LazyRebatePool, and the arbitrage profit-accounting paths produced no surviving findings in this pass but were not exhaustively modelled.
- **Recommended structural remediation:** the single highest-leverage fix is to remove mandatory push-delivery from EnglishAuction `settle()` (move NFT delivery and royalty/seller payouts to pull-based claim queues with a per-recipient fallback). This closes Finding 1 outright and de-risks Findings 4 and 5 simultaneously, and gives EnglishAuction the settlement liveness that the stash sovereignty model (`rescueNFT`) already enjoys.