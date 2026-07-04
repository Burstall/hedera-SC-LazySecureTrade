# LazySecureTrade Suite -- Security Audit (2026-07-04, post-EA-rework re-audit)

> **Meta.** Automated multi-agent adversarial audit (`lst-security-audit` workflow,
> `.claude/workflows/lst-security-audit.js`). This run re-audited the tree at
> commit **af2e8fa** ("EA settle-liveness pull-claim (Findings 1/3/4/5) +
> externalize size-libs to link"), to confirm the EA pull-claim rework and the
> LSHTierLib/AgentEnvelopeLib externalization introduced no regressions and that
> the prior findings stayed closed.
>
> - **Run:** `wf_51f3fe46-18c` (first pass hit the account session limit mid-run;
>   resumed after the 11:50 Europe/London reset -- cached agents replayed, failed
>   finders/verifiers + synthesis re-ran to completion).
> - **Agents:** 98 - **Subagent tokens:** ~5.47M.
> - **Result:** 43 raw findings -> **1 confirmed (Low)**,
>   **1 contested (Low)**, 41 refuted by both verifiers.
> - **Rework surfaces = clean.** Neither surviving finding is a regression from
>   this rework. Both are pre-existing Low defects on code paths this rework did
>   not change (EA fungible-item escrow/release symmetry; BCF bid-discovery views).
>   The prior findings closed by af2e8fa (settle-liveness / pull-claim F1, tier F3,
>   royalty-cap F5) did **not** resurface, and the recipient-funded custody hop
>   (F4) was re-examined and rated Informational / no-impact (recoverable), matching
>   the audit's own prior verdict.
>
> - **Remediation (2026-07-04, same day).** Both surviving Lows were fixed in the
>   follow-up commit and re-validated on live testnet (EA 20/0, BCF 80/0):
>   - **NEW-1 (EnglishAuction)** — `_persistItemsAndEscrow` now rejects fungible
>     bundle items whose token carries a fixed/fractional custom fee (fail-fast at
>     create), so a fee-on-transfer FT can no longer strand a settled bundle. Fee-
>     free fungibles (e.g. $LAZY) are unaffected and still bundle.
>   - **NEW-2 (BidderContractFactory)** — the three discovery views now window-read
>     the storage array over `[offset, offset+limit)` (no whole-array copy), the
>     serial view is a bounded-window scan (resume via `nextOffset`), and a new
>     `MAX_BID_SERIALS` cap bounds `_bidMatchesSerial` per-entry cost. Bid
>     discovery can no longer be bricked by array bloat.
>
> This is an internal automated review, **not** a substitute for a formal
> third-party audit -- see the Caveats section.

---
I've verified both findings against the live source. The code claims check out: EnglishAuction FT escrow/release at 915-924 / 986-992 with no `balanceOf` delta check, and the whole-array `tokenToBids[token]` copy at lines 805, 854, and 917 in BidderContractFactory. Here is the final report.

---

# LazySecureTrade Suite — Final Security Audit Report

## 1. Executive Summary

**Scope.** Adversarial security review of the LazySecureTrade (LST) Hedera HTS NFT marketplace suite: `LazySecureTrade`, `BidderContract`/`BidderContractFactory` (per-user "stash" CLOB + arbitrage), `EnglishAuction`, `VIPSubscription`, `LazyRebatePool`, and the shared `TokenStakerV2` base. Contracts target Solidity 0.8.18 (`viaIR`, optimizer 200) and execute against live Hedera via the HTS precompile.

**Method.** Multi-agent adversarial review: independent finders enumerated candidate issues by vulnerability class, and each candidate was then adjudicated by two independent verifiers who attempted to *refute* it from an external entry point. This report contains only issues that survived that gate: **confirmed** (both verifiers ruled the issue real) and **contested** (the two verifiers split). Every distinct surviving issue is preserved below; nothing was dropped for being "only" an edge case.

**Risk posture (honest).** No confirmed loss-of-principal-at-scale or privilege-escalation bug survived verification. The two surviving issues are both **Low severity** and both are **anonymously reachable — no owner, factory, or other privileged role is required to trigger either one:**

- **A confirmed permanent fund-lock in `EnglishAuction`** where an auction seller can bundle a fractional-fee ("fee-on-transfer") HTS fungible token that, once escrowed, can never be released — permanently stranding the *entire* won bundle (including any valuable NFTs in it) after the winner has already paid. Any account acting as a seller can construct such a bundle; the victim is the winning bidder. **CONFIRMED, Low.**
- **A contested denial-of-service / state-bloat vector in `BidderContractFactory`** where any account can spam permanently-unprunable dust bids against a targeted collection, and the "paginated" discovery views copy the *entire* per-token bid array into memory before slicing — so the intended pagination bound does not actually bound execution cost, and off-chain/RPC bid discovery for that collection can be bricked. Both verifiers agreed the mechanism is real; they split on whether the impact rises above informational. **CONTESTED, adjudicated Low.**

Both issues are real code-level defects with concrete, permissionless trigger paths. Neither lets an attacker directly steal escrowed funds, but the first causes a genuine, unrecoverable loss to a paying counterparty and the second degrades a core product surface (the CLOB) for a targeted collection.

## 2. Severity-Ordered Issue Table

| # | Severity | Contract | Anonymously reachable | Status |
|---|----------|----------|-----------------------|--------|
| 1 | Low | `EnglishAuction` | Yes — any seller (victim = winning bidder) | CONFIRMED |
| 2 | Low (contested; finder Medium, one verifier Informational) | `BidderContractFactory` | Yes — any account can deploy a stash and spam bids | CONTESTED |

## 3. Detailed Findings

---

### Finding 1 — Fee-on-transfer HTS fungible bundle item permanently locks the entire settled auction bundle (winner loses paid bid) — **CONFIRMED, Low**

**Contract / location.**
- `contracts/EnglishAuction.sol:915-924` — `_persistItemsAndEscrow`, fungible-item escrow branch.
- `contracts/EnglishAuction.sol:986-992` — `_releaseBundle`, fungible-item payout branch.
- Feature surface: `IEnglishAuction` (fungible bundle items, `AuctionItem.isNFT == false`, `serialOrAmount == amount`).

**What & why.** An auction bundle may contain fungible HTS items (an intended, documented feature — the only create-time validation in `_persistItemsAndEscrow` is `token != 0` and `serialOrAmount != 0`, at lines 870-871). When escrowing a fungible item, the contract pulls `serialOrAmount` from the seller and checks **only the HTS int64 response code**, never how many tokens actually landed:

```solidity
// EnglishAuction.sol:917-923  (escrow-in)
int256 rc = HederaTokenService.transferToken(
    item.token, seller, address(this),
    SafeCast.toInt64(int256(item.serialOrAmount))
);
if (rc != HederaResponseCodes.SUCCESS) revert HTSCallFailed(rc, "FTIN");
```

Hedera fungible tokens can carry **fractional custom fees**. With `net_of_transfers == false`, the fee is deducted from the transferred amount, so the contract ends up holding **fewer than `serialOrAmount`** tokens — yet a full `SUCCESS` response code is returned. `transferToken` returning `SUCCESS` does **not** mean the contract received the requested amount, and there is no `balanceOf` before/after delta check to detect the shortfall.

At delivery, `_releaseBundle` transfers the *full* `serialOrAmount` back out (and may be charged another fee on the outbound leg):

```solidity
// EnglishAuction.sol:986-992  (release-out)
int256 rc = HederaTokenService.transferToken(
    item.token, address(this), to,
    SafeCast.toInt64(int256(item.serialOrAmount))
);
if (rc != HederaResponseCodes.SUCCESS) revert HTSCallFailed(rc, "FTOU");
```

Because the escrowed balance is short, this outbound transfer reverts. `_releaseBundle` is **all-or-nothing** (a single loop over all bundle items; any revert aborts the whole loop), and `claimAuctionNFT` hard-deletes the auction only on a *successful* claim. So the claim reverts on **every** retry, and the entire bundle — including any genuinely valuable NFTs bundled alongside the fungible item — is permanently stranded in the contract.

**Exploit / impact path.**
1. Seller creates an auction whose bundle contains a legitimate NFT plus a fractional-fee HTS fungible token (`net_of_transfers == false`).
2. Escrow-in succeeds (response code `SUCCESS`), but the contract silently receives `serialOrAmount − fee` of the fungible token.
3. A bidder wins and pays `winningBid`. `settle()` (Finding-1 pull-claim model) distributes proceeds to seller/royalties/bounty — the *seller is paid*.
4. The winner calls `claimAuctionNFT`; `_releaseBundle`'s fungible outbound transfer of the full `serialOrAmount` reverts on the shortfall.
5. Every retry reverts. The winner has paid, the seller has been paid, and the winner can **never** receive the bundle. Net: winner loses their bid amount and the bundle is locked forever.

**Preconditions / who must act.** No privileged role. Any account acting as an auction seller constructs the bundle. The only external precondition is the existence of a fractional-fee HTS fungible token used as a non-NFT bundle item — a normal, supported Hedera token configuration. The harmed party is the winning bidder.

**Why it settled at Low (verifier consensus).** Both verifiers confirmed the path is reachable from an external entry with no trusted-role gate and could not refute it. Severity is bounded to Low rather than higher because: (a) it requires a specific token configuration (fractional fee, `net_of_transfers == false`) that a careful seller/frontend would not normally include; (b) the Finding-1 pull-claim settlement model means settlement/fund-distribution itself is **not** bricked — only the deferred *delivery* is blocked — so this is a stranded-delivery lock rather than a settlement DoS; and (c) it is closer to a griefing/foot-gun than a direct theft primitive (the attacker-seller does not profit from the lock beyond having been paid for goods never delivered). None of the existing guards close the lock: the escrow check inspects only the response code, and there is no `balanceOf` delta anywhere on the FT path.

**Code-level fix (any one closes it; (1) is recommended).**
1. **Measure actual receipt.** In the escrow branch, record `balanceOf(address(this))` for `item.token` before and after the pull, store the *delta* as the deliverable amount for that item, and have `_releaseBundle` transfer the stored delta rather than the requested `serialOrAmount`. This makes escrow and release symmetric even under fractional fees.
2. **Reject fee-bearing fungibles at create time.** In `_persistItemsAndEscrow`, for `!item.isNFT` items call `getTokenCustomFees`/`getTokenInfo` and `revert InvalidBundleItem(i)` if the token carries any fractional/fixed custom fee.
3. **Per-item delivery.** Split `_releaseBundle` into independent per-item claims so one unreleasable fungible item cannot brick delivery of the remaining (valuable) items in the bundle.

Prefer (1) + (3) together: (1) prevents the shortfall lock and (3) contains any residual per-item failure so it can never strand the rest of the bundle.

---

### Finding 2 — Uncapped, permanently-unprunable dust bids + whole-array copy in "paginated" views can brick bid discovery for a targeted collection — **CONTESTED, adjudicated Low** (finder Medium; one verifier Low, one Informational)

**Contract / location.**
- `contracts/BidderContractFactory.sol:626-695` — `createBid` (no per-user/per-token active-bid cap; O(1) push to `tokenToBids[token]` at line 679).
- `contracts/BidderContractFactory.sol:755-769` — `pruneUnfundedBid` (funded test `bid.stash.balance < bid.hbarAmount` at 760-763).
- `contracts/BidderContractFactory.sol:805` — `getBidsForTokenPaginated`: `bytes32[] memory allBids = tokenToBids[token];`
- `contracts/BidderContractFactory.sol:854` — `getBidsForTokenSerialPaginated`: `bytes32[] memory tokenBids = tokenToBids[token];`
- `contracts/BidderContractFactory.sol:917` — `getBestBidForToken`: `bytes32[] memory allBids = tokenToBids[token];`

**What & why.** Two reinforcing defects:

*(a) Unbounded, unprunable state growth.* `createBid` enforces **no** per-user or per-token cap on active bids and pushes every bid to `tokenToBids[token]` (line 679). The only removal paths are `cleanupExpiredBids` (expired bids only) and `pruneUnfundedBid`, whose funded test is per-bid — `bid.stash.balance < bid.hbarAmount` (760-763). A bid with `hbarAmount == 1` tinybar and `expiry == 0` therefore **never expires** and is **permanently unprunable** as long as its stash holds ≥ 1 tinybar. No other actor can reclaim that state.

*(b) Pagination does not actually bound execution cost.* All three discovery views that are supposed to be bounded by `MAX_VIEW_PAGINATION` first copy the **entire** storage array into memory before slicing (lines 805, 854, 917). The `limit` parameter only trims the *returned slice* — it does not bound the O(n) SLOAD + memcopy of the full `tokenToBids[token]`. `getBidsForTokenSerialPaginated` additionally runs `_bidMatchesSerial` per scanned bid (a loop over each bid's `serials` array, itself uncapped), compounding the cost.

**Exploit / impact path.**
1. Attacker calls `deployStash`, funds it with 1 tinybar, associates the target collection once.
2. In a loop across many transactions: `createBid(token = targetCollection, hbarAmount = 1, lazyAmount = 0, expiry = 0, serials = [])`. Each bid is `Active`, never expires, and always passes `pruneUnfundedBid`'s funded check (balance `1` ≥ `hbarAmount` `1`) — so neither `cleanupExpiredBids` nor `pruneUnfundedBid` can remove it.
3. `tokenToBids[target]` grows without bound and cannot be reclaimed by anyone.
4. Once the array reaches a few thousand entries, `getBidsForTokenPaginated` / `getBidsForTokenSerialPaginated` / `getBestBidForToken` each copy the full array on every call and exceed the `eth_call`/RPC gas ceiling → they revert. On-chain and RPC bid discovery, best-bid, and floor-price computation for that collection are bricked for RPC consumers, permanently.

**Preconditions / who must act.** No privileged role. Any account can `deployStash`, fund it with dust, and spam `createBid`. Anonymously reachable.

**The split, explained honestly.** Both verifiers agreed every technical claim is accurate and the path is fully reachable by any user. They agreed on the facts and split on **impact classification**:

- **Verifier A → Real, Low.** Confirmed the state bloat is permanent and unprunable and that the views copy the whole array. Key mitigating observation: **every on-chain write/settlement path** (`createBid` push, `_closeBid` swap-pop, `executeArbitrage`, `cancelBid`, `pruneUnfundedBid`, `cleanupExpiredBids`) is O(1) or bounded by a caller-supplied array with respect to `tokenToBids` size — so array bloat does **not** impair trading or settlement. The damage is confined to the read/discovery layer (view functions and RPC consumers), which is a real but bounded harm → Low.
- **Verifier B → Not real, Informational.** Accepted the same mechanism as factually correct but refuted the finder's Medium rating: all fund-flow / trade-execution paths use direct `bidId` mapping lookups (`executeArbitrage` at 1635 with `_bidMatchesSerial(bidId, …)` at 1656; `executeAgainstBid` at 1476/1487; O(1) `createBid` push; `cancelBid`), never full array scans. Since no funds are at risk and core trading is unaffected, they classify the degraded off-chain discovery UX as informational rather than a vulnerability.

**Adjudication.** Both verifiers concur on the facts and on the crucial point that funds and on-chain settlement are **not** at risk — the disagreement is purely whether a permissionless, permanent DoS of a *core product surface* (CLOB discovery / best-bid / floor price for a targeted collection via RPC) is Low or Informational. Because the trigger is anonymous and permissionless, the state bloat is **irreversible by any party**, and the affected surface is a primary product feature, this report adjudicates it **Low** (not Informational, and not the finder's Medium — Medium overstates it given no funds/settlement impact). Reported here so it is not lost behind the split.

**Code-level fix (apply all four; (1) is the highest-leverage and mandatory).**
1. **Window-read the views.** Make `getBidsForTokenPaginated`, `getBidsForTokenSerialPaginated`, and `getBestBidForToken` index directly into `tokenToBids[token]` over `[offset, offset+limit)` in the loop instead of `bytes32[] memory allBids = tokenToBids[token];`. This alone restores the intended pagination bound regardless of array size and neutralizes the DoS on discovery.
2. **Cap concurrent active bids** per `(user, token)` and/or globally per token, so state growth is bounded.
3. **Prune dust / no-expiry bids.** Extend `pruneUnfundedBid` (or add a permissionless prune) to remove no-expiry bids below a dust floor, and/or require a minimum bid size or a small non-refundable creation deposit so spamming is not free.
4. **Cap `bid.serials` length** in `BidderContract.createBid` and factory `createBid` to bound `_bidMatchesSerial` per-scan cost.

---

## 4. Caveats

- **This is an automated, multi-agent adversarial review, not a formal audit.** Findings were produced and cross-verified by AI agents reasoning over source; there was no on-chain fuzzing, no symbolic execution, and no formal verification.
- **Absence of higher-severity findings here is not proof of their absence.** This report is scoped to issues that survived verification in this pass. Verifier consensus (and the contested split) reflect the agents' reasoning, not a guarantee of completeness.
- **Hedera-specific behaviors are load-bearing** in both findings (HTS custom-fee netting on `transferToken`; the 50-subcall / RPC gas ceilings). Any fix should be validated against a live Hedera testnet with the exact token configurations described (fractional-fee FTs; large `tokenToBids` arrays), since HTS precompile semantics are not fully reproducible on a generic EVM.
- **Recommended before mainnet:** an independent human security audit, property-based fuzzing of the auction escrow/release symmetry and the bid-array growth paths, and formal verification (or at minimum invariant testing) of the "escrowed amount == deliverable amount" and "view gas is bounded by `limit`, not by array length" invariants.