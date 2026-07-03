# LazySecureTrade Suite — Final Security Audit Report

## 1. Executive Summary

**Scope.** Solidity contracts of the LazySecureTrade (LST) marketplace suite deployed on Hedera via EVM:
- `LazySecureTrade` (single/batch/multi trade execution)
- `BidderContractFactory` + per-user `BidderContract` stashes (v0.3 CLOB bidding + arbitrage)
- `EnglishAuction` (bundle auctions)
- `VIPSubscription` (tiered subscriptions)
- `LazyRebatePool` (Merkle rebate distribution)
- `TokenStakerV2` (shared HTS transfer base / 2-step NFT custody hop)

**Method.** Automated multi-agent review with adversarial two-verifier confirmation. Every candidate finding was independently ruled on by two verifiers using opposing lenses (exploit-tracing vs. mitigation/refutation). A finding is **CONFIRMED** only when *both* verifiers ruled it real against source; **CONTESTED** when the two verifiers split. Findings below are de-duplicated: several finders flagged the same root cause through different lenses; those are merged into one issue with all locations preserved.

**Risk posture — honest.** The suite has **two anonymously-reachable, no-special-role fund/asset-loss defects that are CONFIRMED by both verifiers:**

1. **`LazySecureTrade` batch and multi-trade execution accept payment of zero.** `executeTrades` and `executeBatchTrade` never verify that `msg.value` covers the sellers' payouts. Because sellers are paid out of the *contract's own* HBAR balance (accumulated platform fees + LazyGasStation refills) via the STAKING transfer leg, **any anonymous caller can acquire listed NFTs for free and drain the protocol's HBAR reserve.** One verifier rated this Critical. This is the single most urgent issue.

2. **`EnglishAuction` settlement can be permanently bricked.** When a bundle's summed royalties + protocol fee + bounty exceed the winning bid, the seller-proceeds subtraction underflows and reverts *forever*. `cancelAuction` is blocked after the first bid and `claimAuctionNFT` is a revert-only stub, so **the winner's escrowed HBAR/LAZY and the seller's NFTs are locked with no recovery path.** Reachable by any ordinary seller (maliciously or accidentally with high-royalty art) plus any bidder.

Additionally, the **v0.3 flagship arbitrage feature is non-functional** for normally-funded stashes (`arbitrageSettle` cap math bug — CONFIRMED, Medium, availability only), and a **launch-window free-mint** exists in `VIPSubscription` (CONFIRMED, Low, anonymous).

Contested issues cluster around **privileged over-reach** (`EnglishAuction.withdrawProtocolFee` can drain commingled user escrow), **operational accounting** (`LazyRebatePool` cross-epoch over-allocation), and **griefing/availability** (unfunded no-expiry bid bloat; settlement stuck on an unassociated recipient). These are reported with their preconditions.

**Bottom line:** Not mainnet-ready. Fix the two confirmed anonymously-reachable issues before any further deployment; resolve the arbitrage-cap bug for feature viability; and adopt the accounting-segregation fixes to close the contested owner-overreach and rebate-insolvency vectors.

---

## 2. Severity-Ordered Issue Table

| # | Severity (verifier-adjusted) | Contract | Anon-reachable | Status |
|---|------------------------------|----------|----------------|--------|
| A | **High** (one lens: Critical) | LazySecureTrade | **Yes** | CONFIRMED |
| B | **High** (some lenses: Medium/Low) | EnglishAuction | **Yes** | CONFIRMED |
| E | **Medium** (real-side split High/Medium) | EnglishAuction | No (owner) | CONTESTED |
| C | **Medium** | BidderContract / BidderContractFactory | **Yes** | CONFIRMED (one adversarial lens dissented) |
| F | **Low–Medium** | LazyRebatePool | No (signer); harm hits anon claimers | CONTESTED |
| B2 | **Low** (design-contested) | EnglishAuction | Yes | CONFIRMED root cause, impact disputed |
| D | **Low** | VIPSubscription | **Yes** (launch window) | CONFIRMED |
| H | **Low** | BidderContractFactory / BidderContract | **Yes** | CONTESTED |
| I | **Low** | EnglishAuction | **Yes** (participant) | CONTESTED |
| G | **Informational** | VIPSubscription | Partial (owner config gates leak) | CONTESTED |

---

## 3. Detailed Findings

### A. `LazySecureTrade` batch/multi-trade paths skip payment validation — buyer pays 0, contract pays sellers from its own HBAR — CONFIRMED (High; one verifier Critical)

**Merged from four finder reports** (all the same root cause: the `_checkFunds`/`msg.value` gap in the two multi-item execution paths).

**Locations.**
- `contracts/LazySecureTrade.sol:737-763` — `executeTrades`, calls `_executeTrade(_tradeIds[i], false)` at **:755** (funds check disabled), no aggregate `msg.value` assertion; only `_refundExcessHbar(totalHbarUsed)` at **:762**.
- `contracts/LazySecureTrade.sol:1122-1204` — `executeBatchTrade`, **no `msg.value` comparison anywhere**; only `_refundExcessHbar(totalTinybarPrice)` at **:1191**. Also **omits the beneficial-owner self-trade check** present in `_executeTrade`.
- `contracts/LazySecureTrade.sol:1769-1776` — the only `msg.value` funds gate (`_checkFunds && trade.tinybarPrice > 0 && msg.value < trade.tinybarPrice → revert InsufficientPayment`), reached only by the single-trade path (`executeTrade → _executeTrade(_,true)`, :515).
- `contracts/LazySecureTrade.sol:1644-1681` (`_processHbarPayment`), `1711-1740` (`_execute2StepNFTTransfer`), `1916-1920` (`_refundExcessHbar`, refunds only when `msg.value > used`, never reverts on shortfall).
- `contracts/TokenStakerV2.sol:122-146` (esp. **141-146**) — STAKING leg: `transfers[0] = {address(this), -netAmount, isApproval=false}` (contract debited), `transfers[1] = {seller, +netAmount}`. The `refill` modifier at **:68-74** tops the contract up from LazyGasStation when balance < ~20 tinybar.

**What & why.** The seller is *never* paid directly from the buyer's `msg.value`. The buyer's `msg.value` merely accrues to the contract balance; the actual payout to the seller is drawn from `address(this)` in the STAKING leg. In the single-trade path this is safe only because line 1770-1776 first reverts if `msg.value < tinybarPrice`. Both multi-item paths remove that guarantee — `executeTrades` disables it (`_checkFunds=false`), `executeBatchTrade` never had it. `_refundExcessHbar` is a no-op on underpayment, so any shortfall between buyer-sent value and total payout is **silently absorbed by the contract's resident HBAR** (unwithdrawn platform fees, the kept buffer, and gas-station refills).

**Exploit path (anonymous, no special role).**
1. Attacker grants LST the 1-tinybar HBAR allowance every buyer needs for the custody hop.
2. Attacker selects up to 5 third-party open-market listings (self-trade block only stops the seller; unrelated EOAs pass) and calls `executeTrades([t1..t5])` with `msg.value = 0`.
3. Each STAKING leg pays the respective seller their net amount from the LST contract balance (refilled from LazyGasStation); the WITHDRAWAL leg delivers each NFT to the attacker.
4. Attacker receives the NFTs for free; the protocol's HBAR reserve is drained by `Σ netAmount`. Repeat as fees re-accrue / refills fire, until the balance can't cover the next payout (then `cryptoTransfer` reverts). `executeBatchTrade` yields the same result against a whole batch in one call, and additionally allows cooperating seller/buyer addresses (no self-trade guard).

**Preconditions.** None privileged. Any address that is not the seller; standard buyer allowance. Loss magnitude per tx is bounded by the contract's marshallable HBAR (standing balance + one refill), so the attack is repeated, not one-shot — hence the verifier split between High (bounded, self-limiting) and Critical (direct theft, drains LazyGasStation).

**Fix (code-level).**
- `executeBatchTrade`: `if (msg.value < batchTrade.totalTinybarPrice) revert InsufficientPayment();` before any transfer.
- `executeTrades`: accumulate required tinybars into `totalRequired` and `require(msg.value >= totalRequired)` (or keep `_checkFunds=true` and decrement a running remaining-value counter per trade). Do **not** rely on contract insolvency as the backstop — the contract legitimately holds fee HBAR.
- Add the `_resolveBeneficialOwner` self-trade guard to `executeBatchTrade` to match `_executeTrade`.

---

### B. `EnglishAuction` settlement underflows and permanently locks funds + NFTs when royalty + fee + bounty exceed the winning bid — CONFIRMED (High)

**Merged from five finder reports** (identical root cause: uncapped aggregate deductions at the `sellerProceeds` subtraction).

**Locations.**
- `contracts/EnglishAuction.sol:650` — `uint96 sellerProceeds = winningBid - protocolFee - bounty - totalRoyalty;` (checked Solidity 0.8.18 arithmetic, not in an `unchecked` block).
- `:637-649` — `totalRoyalty` accumulated with `+=`, each entry computed as `winningBid * r.bps / MAX_BPS` (**:643**) on the **full** winning bid.
- `:876-896` (`_snapshotRoyalty`), **:887** — caps each *individual* royalty at `MAX_BPS` (100%) but **never caps the sum**; royalties deduped per unique token at ~:854-857.
- `:53` — `MAX_BUNDLE_ITEMS = 10` (a bundle may hold up to 10 distinct collections; a single token may carry multiple royalty fees).
- `:631` success branch; `:663-665` failure branch (the only place escrow is credited to `claimableHbar/Lazy`) — never reached on the success path.
- `:469` — `cancelAuction` reverts `CannotCancelWithBids` once a bid exists.
- `:704-712` — `claimAuctionNFT` is a pure-revert stub (`BundleNotAwaitingClaim`).
- `:767` protocol fee capped at 10%; `:773` bounty capped at 5% — bounds their contribution but not the royalty sum.

**What & why.** Each collection's royalty is charged against the *entire* bundle price and summed with no cumulative cap. `createAuction` (:386-458) and `_persistItemsAndEscrow` (:802-871) never validate that `protocolFee + bounty + Σroyalty ≤ 100%`. Once that sum exceeds `winningBid`, the checked subtraction at :650 underflows and reverts. Since `settle()`/`buyNow` are the only paths that release escrow once a bid exists, `cancelAuction` is blocked, and `claimAuctionNFT` always reverts, **there is no recovery path** — the winner's escrowed HBAR/LAZY and the seller's NFTs are locked forever.

**Exploit / impact.** A seller bundles two collections at 50% royalty each (or ten at 10%, or a single ~100% fractional-fee token — all permitted by HTS). A bidder wins above reserve. Every `settle()` computes `totalRoyalty ≥ 100%`, adds protocol fee + bounty, and underflows → revert. Auction is stuck `Open` permanently; winner's bid and seller's NFTs unrecoverable. A griefer can weaponize this to trap a victim's winning bid; an honest seller can trigger it accidentally with ordinary high-royalty art.

**Preconditions.** Any user can create the unsettleable auction (permissionless `createAuction`); any bidder becomes the victim. No special role. **Verifier split on severity:** the dedicated analyses rated High (irrecoverable lock of real funds/assets, no escape hatch); dissenting lenses rated Medium/Low because it requires a >100%-cumulative-royalty bundle and checked arithmetic converts it to a revert (no silent theft). Final: **High**, given the permanent, unrecoverable dual lock.

**Fix (code-level).**
- Clamp deductions before subtracting: `uint256 deductions = protocolFee + bounty + totalRoyalty; sellerProceeds = deductions >= winningBid ? 0 : winningBid - uint96(deductions);`
- Apportion each item's royalty against that item's *pro-rata* share of the bundle price (or restrict royalty-bearing auctions to single-NFT bundles), and validate cumulative royalty (+ fee + bounty headroom) at `createAuction`, rejecting fundamentally unsettleable bundles.
- Make `claimAuctionNFT` functional (or add an owner/winner rescue) so escrow is always recoverable if settlement math fails.

---

### B2. `EnglishAuction` royalty computed on full bundle price systematically over-charges royalties / under-pays sellers on multi-collection bundles — CONFIRMED root cause, impact CONTESTED (Low)

**Same root cause as B** (line 643: `winningBid * r.bps / MAX_BPS`), but a distinct *impact* on ordinary (non-underflowing) bundles.

**What & why.** Because every collection's royalty is applied to the full bundle value rather than that item's pro-rata share, any multi-collection bundle over-pays royalty collectors and under-pays the seller even when the sum stays below 100% (e.g., two 5% collections on a 100 HBAR bundle pay 10 HBAR royalty instead of ~5 HBAR warranted by the items' shares).

**Split.** One verifier classified this as **NOT a vulnerability** — the single-item formula `sellerProceeds = highBid − protocolFee − bounty − royalty` is the documented intended design (`docs/EnglishAuction-DESIGN.md:305-306`), inherited into the bundle path. The other treated the over-charge as an accounting defect. Both agreed there is no silent theft (0.8.18 checked math). **Reported as Low / design-review item**, resolved by the same pro-rata apportionment fix as B.

---

### E. `EnglishAuction.withdrawProtocolFee` is unbounded and protocol fees are commingled with user escrow — CONTESTED (Medium; real-side split High/Medium)

**Merged from two finder reports.**

**Locations.**
- `contracts/EnglishAuction.sol:779-793` — `withdrawProtocolFee(to, payment, amount)`: `onlyOwner` + `nonReentrant`, raw transfer of an owner-supplied `amount`, **no `amount ≤ accrued` bound**.
- `:638`, `:650` — `_computeProtocolFee` is only subtracted from `sellerProceeds`; the retained fee sits in raw balance. **No `protocolFeesAccrued` accumulator exists** (verified against storage layout ~:102-190).
- `:114-120` — `claimableHbar` / `claimableLazy` pull-queues are backed by the *same* contract balance; live-auction high bids (raw `msg.value` from `placeBid`) also sit there with no claimable-ledger entry until settle.

**What & why.** Protocol fees are never segregated. The contract balance simultaneously holds (a) every open auction's high bid, (b) queued outbid-refunds/seller-proceeds/royalties/bounties, and (c) retained fees. `withdrawProtocolFee` can move an arbitrary amount of that commingled pool, so the owner can withdraw far more than genuinely-earned fees — directly violating the project's own stated invariant (SECURITY.md: owner withdrawals "move owner-side accumulated fees, not user funds"). Unlike `BidderContractFactory.withdrawProtocolProfit` (bounded by `pendingProtocolProfit`), there is no bound and no on-chain timelock.

**Exploit / impact.** With live auctions holding a 100 HBAR high bid and 40 HBAR of queued refunds, a malicious or briefly-compromised owner key calls `withdrawProtocolFee(attacker, HBAR, address(this).balance)` and removes everything. Subsequent `settle()`/`claim()` calls fail on insufficient balance; winners' bids and outbid refunds are lost, and NFTs may be delivered while the seller is never paid.

**Split.** Verifier 1 (refute): `onlyOwner` + documented operational multisig with an off-chain timelock notice window; profit withdrawals are "instant by design"; not attacker-reachable → Informational/NotAVuln. Verifier 2 (confirm): no on-chain accounting bound, no timelock, and the design explicitly promises owner cannot touch user funds; a single compromised owner key drains user escrow → High. **Reported as Medium** (real, privileged-only, high blast radius on key compromise; precondition: owner or compromised owner key).

**Fix.** Add `protocolFeesAccruedHbar` / `protocolFeesAccruedLazy`, increment by `protocolFee` in `_settleInternal` per rail, and require `amount ≤ protocolFeesAccrued[payment]` in `withdrawProtocolFee` (decrement on withdrawal). Never let the owner touch balances backing `claimableHbar/Lazy` or open-auction escrow. Optionally subject the function to the same 48h timelock as other high-blast-radius setters.

---

### C. `arbitrageSettle` 75% cap is evaluated against the *post-purchase* stash balance — profitable arbitrage always reverts for normally-funded stashes — CONFIRMED (Medium; one adversarial lens dissented)

**Merged from three confirmed finder reports plus one contested duplicate** (all the same root cause).

**Locations.**
- `contracts/BidderContract.sol:385-414`, cap at **:398-399** — `cap = address(this).balance * ARB_SETTLE_MAX_BPS / 10000` (7500 bps, const at :109); reverts `InsufficientBalance` if `hbarAmount > cap`.
- `contracts/BidderContract.sol:895-897` — `executeTrade{value: trade.tinybarPrice}` forwards the trade price out of the stash first.
- `contracts/BidderContractFactory.sol:1573` (`spread = bid.hbarAmount - trade.tinybarPrice`), `1588-1592` (step 1: stash buys the ask), `1598-1603` (step 2: `arbitrageSettle` pulls the full spread), `1577` / `1087` (eligibility only requires `stash.balance ≥ bid.hbarAmount`), `1505` (permissionless `executeArbitrage` entry).

**What & why.** `executeArbitrage` first spends `trade.tinybarPrice` from the stash (step 1), *then* pulls `spread` via `arbitrageSettle`, which caps against `address(this).balance` read **after** step 1 already debited the trade price. For a stash funded to exactly the bid amount (the design-endorsed case — validity only checks `balance ≥ bid.hbarAmount`), post-purchase balance == spread, so `cap = 0.75 * spread < spread` and the whole arbitrage reverts. Higher spreads (more profitable) fail harder. The in-code comment reasons about the *pre-trade* balance and is provably wrong: its own "100 HBAR bid vs 50 HBAR trade" example reverts (post-trade balance 50, cap 37.5 < spread 50). To succeed, a stash must be over-funded by ~1.33× the bid — which nothing in the system requires.

**Exploit / impact.** Alice funds her stash with exactly 100 HBAR and bids 100. A 40 HBAR open ask appears; `isBidValid` returns Valid. An arbitrageur (permissionless, e.g. `Carol` in the repo test) calls `executeArbitrage(minProfit=0)`: stash pays 40 (balance → 60), `arbitrageSettle(spread=60)` computes cap = 45 < 60 → revert. On Hedera there is no gas refund, so the arbitrageur loses gas against a bid the contract advertises as valid, and the protocol never collects spread/fees. **The flagship v0.3 arbitrage path is non-functional for the canonical funding case.**

**Preconditions.** None privileged; permissionless caller. No fund loss — bidder funds remain fully recoverable (`cancelBid`, `withdrawHbar`, `rescueHbar`, `detachFromFactory`). This is a **liveness/availability** defect, not theft.

**Dissent (noted for honesty).** One adversarial lens ruled NotAVuln, arguing the exact-exactly-funded case is a degenerate configuration, an over-funding workaround exists, and a repo test passes. The consensus across the dedicated instances is that exact funding is the design-intended common case, so the feature is bricked in practice → **Medium, CONFIRMED**.

**Fix.** Snapshot the stash balance *before* `executeTrade` and cap against that (or cap against `bid.hbarAmount`, since `spread ≤ bid.hbarAmount` by construction). Alternatively exempt the verified spread from the BPS cap. Fix the misleading comment and add a regression test asserting the documented 100/50 example settles.

---

### F. `LazyRebatePool.settleEpoch` has no reserve accounting — overlapping epochs over-commit the balance, stranding later claimers — CONTESTED (Low–Medium)

**Merged from two finder reports.**

**Locations.**
- `contracts/LazyRebatePool.sol:256-276` (`settleEpoch`), **:261-264** — only `if (totalAllocated > balanceOf(this)) revert AllocationExceedsBalance`, against the *instantaneous* gross balance.
- `:297-312` (`claim`), transfer at **:310** — pays out purely against the live balance; per-epoch `totalAllocated/totalClaimed` are never consulted by the solvency check.
- `:322-332` (`recycleExpiredEpoch`) — only reclaims *expired* epochs.
- `:153-157` — `settleEpoch` is `onlySigner`.

**What & why.** The balance check ignores still-unclaimed allocations from prior, not-yet-expired epochs. With quarterly epochs and a default 365-day claim window, ~4 epochs are simultaneously claimable, so the same LAZY backs multiple epochs at once. Total committed `= Σ(totalAllocated − totalClaimed)` can exceed the actual balance, turning claims into first-come-first-served; later claimants with valid Merkle proofs revert at `IERC20.transfer` (:310, `TransferFailed`) and, on Hedera, still pay gas for the reverted attempt. The in-code comment claiming `settleEpoch` prevents "allocating more than what exists" is false across epochs. This arises with an honest signer, because the off-chain allocator computes stake-weighted amounts independent of the prior epoch's unclaimed remainder.

**Exploit / impact.** Balance 100k. Epoch 1 allocates 100k (check passes); 40k claimed, 60k unclaimed but live. 80k new revenue arrives (balance 140k). Epoch 2 allocates 120k (check 120k ≤ 140k passes). Outstanding obligations 60k + 120k = 180k against 140k → insolvent by 40k; the last valid-proof claimers can never redeem.

**Split.** Verifier 1 (refute): `settleEpoch` is signer-gated (trusted), the off-chain allocator is documented as "not protected," `recycleExpiredEpoch` releases expired allocations, no attacker entry → NotAVuln. Verifier 2 (confirm): a *natural* failure mode with an honest signer due to epoch/window overlap; no on-chain reserve accounting; valid-proof claimers stranded → Medium (one instance Low). **Reported as Low–Medium.** Precondition: signer mis-sizes overlapping epochs (no malice required); harm falls on anonymous claimers.

**Fix.** Track `reservedUnclaimed = Σ(totalAllocated − totalClaimed)` over non-recycled epochs: increment on `settleEpoch`, decrement in `claim` (by claimed amount) and in `recycleExpiredEpoch` (by the unclaimed remainder). Require `totalAllocated ≤ balance − reservedUnclaimed` in `settleEpoch`.

---

### D. `VIPSubscription.purchaseSubscription` mints any paid tier for free when that tier's `monthlyPriceLazy` is unset (0) — CONFIRMED (Low)

**Locations.**
- `contracts/VIPSubscription.sol:77` — `monthlyPriceLazy` mapping (default 0 for all tiers).
- `:325-347` — constructor initializes other config but **never** sets prices; no constructor param for it.
- `:494-495` — `basePrice = monthlyPriceLazy[tier] * months`, `finalPrice` computed.
- `:526` — the entire payment + 3-sink split (LGS draw/burn/split) runs **only** inside `if (finalPrice > 0)`.
- `:580-583` — the subscription struct is written regardless.
- `:741-744` — `setMonthlyPrice` enforces `MIN_MONTHLY_PRICE` on explicit sets only, never covering the default-0 state.

**What & why.** With any tier priced at 0 (the default, and the state for any tier the owner forgets to price), the payment block is skipped while the subscription is still granted. There is no "price configured" check on the purchase path.

**Exploit / impact.** Immediately after deployment every tier price is 0. Any address calls `purchaseSubscription(Tier.Platinum, 12, [])`: `basePrice = 0`, `finalPrice = 0`, the LGS draw/burn/split is skipped, `subscriptions[caller] = {Platinum, now + 12mo}` is written, `SubscriptionPurchased` fires with `lazyPaid = 0`. The caller holds 12 months of free Platinum. Same for any single tier left unpriced.

**Preconditions.** None privileged — anonymous. Bounded to the window before the owner prices every paid tier (verifier-adjusted from finder's High to **Low** for that reason), but it *is* live at launch and permanent for any forgotten tier.

**Fix.** In `purchaseSubscription` (and `priceFor`) require `monthlyPriceLazy[tier] > 0`, reverting `NotConfigured`/`PriceBelowFloor`; and/or initialize all paid-tier prices in the constructor; and/or add a one-time "active" flag gating purchases.

---

### H. Unfunded, no-expiry bids permanently bloat the CLOB discovery arrays with no prune path — CONTESTED (Low)

**Locations.**
- `contracts/BidderContract.sol:788-845` (`createBid`), **:804-811** — checks only the instantaneous stash balance, locks/escrows nothing; **:800/620** — `expiry == 0` is allowed (`createBid` only rejects `expiry != 0 && expiry <= now`).
- `contracts/BidderContractFactory.sol:604-673` (`createBid` stores + pushes), **:656-660** — unconditionally pushes to `tokenToBids[token]` and `userToBids[user]`.
- `:1177-1213` (`cleanupExpiredBids`, **:1184-1191**) and `:1074` (inline execution sweep) **both gate on `expiry != 0`**, so a no-expiry bid is prunable only by its owner via `cancelBid`. No admin prune, no per-user cap.
- `:1087` — execution-time balance re-check (`_validateBidForExecution`).

**What & why.** Bids do not escrow. A single balance backs unlimited bids, and the owner can withdraw immediately after creating them while the bids stay `Active`. No-expiry bids can never be removed by anyone but their owner. An attacker can inject unbounded permanent junk into a popular collection's on-chain bid book.

**Exploit / impact.** Attacker deploys a stash (permissionless), funds 1 HBAR, loops `createBid(token=target, expiry=0)` thousands of times (each passes the balance check since no funds move), then withdraws the 1 HBAR. `tokenToBids[target]` holds thousands of Active, unfunded, never-expiring bids nobody can prune. `getBestBidForToken` (capped at 200) hides real bids behind junk; sellers calling `executeAgainstBid` against junk revert at the funding check (:1087), burning gas with no Hedera refund. Price-discovery is degraded and storage grows unbounded.

**Split.** Verifier 1 (confirm): real state-bloat/griefing, no prune path for no-expiry bids → Low. Verifier 2 (refute): the execution-time balance re-check (:1087) prevents any settlement/fund loss and views are paginated, so it's cosmetic griefing → Informational. **Reported as Low, CONTESTED.** Anonymous, no fund loss. Precondition: none privileged.

**Fix.** Escrow bid funds at creation (or a per-bid locked balance) so a withdrawal invalidates the bid; enforce a non-zero maximum expiry so `cleanupExpiredBids` can prune; add a permissionless "cleanup unfunded bid" path that closes any Active bid whose `stash.balance < hbarAmount`; add a per-user active-bid cap.

---

### I. `EnglishAuction` settlement bricks if the NFT recipient is unassociated; claim-NFT fallback is a reverting stub — CONTESTED (Low)

**Locations.**
- `contracts/EnglishAuction.sol:620-672` (`_settleInternal`; `settle()` permissionless at :607), `:900-925` (`_releaseBundle`, `moveNFTs` per NFT at :906-913), winner recipient at :655 / seller recipient at :666.
- `:710-712` — `claimAuctionNFT` reduced to `revert BundleNotAwaitingClaim()` (no partial-claim path).
- `contracts/TokenStakerV2.sol:176-183` — WITHDRAWAL leg issues a single `cryptoTransfer`, reverts `HTSCallFailed` on non-SUCCESS (e.g. `TOKEN_NOT_ASSOCIATED`, code 167); no recipient auto-association.

**What & why.** `_settleInternal` delivers the bundle inline. On Hedera, transferring an NFT to an account not associated with the token reverts, unwinding the entire `settle` — including the seller-proceeds and bidder-refund queue writes that precede delivery. With `claimAuctionNFT` a permanent stub, there is no partial-claim escape hatch.

**Exploit / impact.** A griefer wins an auction (locking the seller's NFT and paying their bid in), then never associates their account with the bundle token. Every `settle()` reverts inside `_releaseBundle`; the seller is never paid and the NFT stays escrowed indefinitely, the griefer forfeiting their own bid to hold the asset hostage. Symmetrically, a seller who de-associates a bundle token mid-auction freezes the reserve-fail refund path (recipient is the seller at :666), trapping the high bidder's funds. No recovery without the blocking party acting.

**Split.** Verifier 1 (confirm): real availability bug; inline delivery unwinds fund distribution; stub blocks recovery → Low. Verifier 2 (refute): CEI atomicity means no misdirected funds, the blocking party forfeits its own bid, and the recipient can simply associate to unblock — self-inflicted → NotAVuln. **Reported as Low, CONTESTED.** Reachable by ordinary participants (bidder/seller), no special role.

**Fix.** Restore a real per-recipient NFT claim queue: on delivery failure record the bundle as awaiting-claim for the intended recipient and let `settle` complete fund distribution, so the recipient pulls their NFTs after associating. At minimum, split bundle delivery from fund settlement so a stuck NFT does not block seller proceeds and bidder refunds.

---

### G. `VIPSubscription` constructor default `maxCombinedDiscountBps` (9000) exceeds the setter's own hard cap (5000) — CONTESTED (Informational)

**Locations.**
- `contracts/VIPSubscription.sol:334` — constructor sets `maxCombinedDiscountBps = 9_000` (90%).
- `:193` — `MAX_ALLOWED_COMBINED_DISCOUNT_BPS = 5_000`, documented as the hard bound that "stops a compromised admin from enabling a 100%-off path."
- `:754-760` — `setMaxCombinedDiscountBps` rejects any value > 5000.
- `:866` (`_capCombined`), `:490-491` (`finalBps`), `:607`/`:826` (owner-gated `setDiscount` / `discountTable`).

**What & why.** The contract launches in a state (`9000`) that its own setter would reject. Until the owner tightens it, `_capCombined` clamps combined holdings + prepay discount at 90%, double the intended 50% ceiling. The owner can only ever lower it afterward.

**Exploit / impact.** Owner sets a promotional holdings discount of 8000 bps for a token/tier (`setDiscount` caps only at `MAX_BPS`). A 12-month buyer: `holdingsBps=8000`, `durationBps=2000`, raw `10000`, capped at `9000` → 90% off, vs. the intended 50%. Revenue leakage.

**Split.** Verifier 1 (refute): no external actor can influence the discount table (owner-gated), so no attacker path → NotAVuln/Informational. Verifier 2 (confirm): genuine constructor/setter invariant violation; a 90% state exists at launch that the setter itself forbids → Informational. **Reported as Informational, CONTESTED.** The buyer-facing leak is permissionless *once* the owner configures a high holdings discount, but the enabling precondition is owner configuration.

**Fix.** Set the constructor default `≤ MAX_ALLOWED_COMBINED_DISCOUNT_BPS` (e.g. 5000), or route the initialization through the same cap check. Add an invariant test asserting `maxCombinedDiscountBps ≤ MAX_ALLOWED_COMBINED_DISCOUNT_BPS` at deploy.

---

## 4. Caveats

- This report is the product of an **automated multi-agent review with adversarial verification**, not a manual line-by-line audit. Confirmed findings were agreed by two independent verifiers against source; contested findings reflect a genuine, documented disagreement and are reported with their split rationale.
- Verifier-adjusted severities reflect exploitability and reachability as assessed by the review agents; they are **not** a substitute for economic modeling of on-chain HBAR balances at deployment time (which materially affects the blast radius of issue A).
- **Not a substitute for a formal audit.** Before mainnet deployment the suite should undergo an independent professional audit, property-based **fuzzing** (especially the `EnglishAuction` royalty/fee arithmetic and the `LazySecureTrade` payment invariants), and ideally **formal verification** of the fund-conservation invariants (buyer-paid ≥ seller-paid on every trade path; `Σ` epoch obligations ≤ pool balance; owner withdrawals bounded by accrued fees).
- Findings were assessed against the current branch source; line numbers correspond to the state read during review and may drift as the code changes. Re-verify each fix against the affected function and add regression tests (notably: batch execution with `msg.value = 0`; a bundle whose cumulative royalty exceeds 100%; the exactly-funded arbitrage case; and a first-block subscription purchase before prices are set).
- All contract file paths referenced are under `D:\github\hedera-SC-LazySecureTrade\contracts\` (`LazySecureTrade.sol`, `TokenStakerV2.sol`, `EnglishAuction.sol`, `BidderContract.sol`, `BidderContractFactory.sol`, `VIPSubscription.sol`, `LazyRebatePool.sol`).