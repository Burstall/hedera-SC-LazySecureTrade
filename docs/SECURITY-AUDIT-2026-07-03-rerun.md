# LazySecureTrade — Adversarial Audit RE-RUN (2026-07-03)

> Second pass of the `lst-security-audit` multi-agent workflow, run against the
> post-fix source after the 2026-07-01 findings (A-H) were folded in and all 5
> test suites went green. Agents: 100. Raw findings: 44
> (3 confirmed, 2 contested, 39 refuted by both verifiers).
> None of the prior A-H findings reappeared as confirmed. The new findings (F-1/F-2/F-3)
> are all in the v0.3 stash <-> EnglishAuction integration.

---
Verification confirms all three merge-critical facts: `createTradeOnBehalfOfStash` passes `spendForAgent(auth, TradeList, 0, 0)` (BCF:1285-1290), `createAuctionListing` passes `_envelopeVerifyForAuction(auth, AuctionCreate, 0, 0)` (BidderContract:1037), and BidderContract has **no** `.claim(` forwarder to EnglishAuction (only createAuction/placeBid/buyNow calls exist). The two EA-refund findings share one root cause and are merged; the two EA custody-hop findings share one root cause and are merged.

---

# LazySecureTrade Suite — Final Security Audit Report

## 1. Executive Summary

**Scope.** Solidity contract suite for a Hedera HTS NFT marketplace: `LazySecureTrade` (LST), `BidderContract` (per-user "stash") and `BidderContractFactory` (CLOB router), `EnglishAuction`, `VIPSubscription`, `LazyRebatePool`, `TokenStakerV2` (shared HTS transfer base), and the agent-authorization layer (`AgentEnvelopeLib` / `IAgentEnvelope`). Hedera EVM, Solidity 0.8.18, `viaIR`, strict contract-size budget.

**Method.** Multi-agent adversarial review: vuln-class finders followed by **two independent adversarial verifiers per finding**. This report contains only findings that survived that gate — either **CONFIRMED** (both verifiers ruled the issue real) or **CONTESTED** (the verifiers split). Findings that were literally the same root cause seen through different lenses have been merged; every distinct issue is preserved. The lead auditor additionally re-checked the merge-critical code paths against source (`BidderContractFactory.sol:1285-1290`, `BidderContract.sol:1037`, and the absence of any `EnglishAuction.claim` forwarder in `BidderContract.sol`).

**Risk posture — honest.** The suite has **two independent High-severity defects, both localized to the v0.3 stash subsystem and its EnglishAuction integration**, plus one contested liveness defect in the same integration.

- **Anonymous reachability (read this first):**
  - **F-1 (agent NFT alienation) is NOT anonymously reachable** — it requires the stash owner to have first granted an agent envelope carrying the `TradeList` or `AuctionCreate` permission bit. But note the precondition is a *feature the product ships and encourages* (delegating a listing/auction bot), and once granted the damage is done by the **agent key, not the owner** — so a single compromised bot key drains every NFT in the stash. This is a privilege-escalation / under-constrained-authorization defect, not an owner-trust assumption.
  - **F-2 (EA refund lock) reaches its loss state through routine, permissionless activity.** The stash owner/agent only has to *use the auction feature normally*; the loss-triggering event (being outbid) is performed by **any anonymous competing bidder**, and buy-now overpayment / settle-bounty credits arise on the happy path with no third party at all. There is **no recovery path on already-deployed immutable stashes**.
  - **F-3 (EA custody-hop revert) is triggerable by anyone** — `settle()` is permissionless — but the harm is a liveness brick, not attacker gain, and it is recoverable by an owner-only call.

- **Systemic theme:** both High findings stem from the same architectural gap — **the stash was integrated against LST but not fully against EnglishAuction**. The LST path was hardened (per-serial approvals, lazy custody-hop allowance refills, non-zero-price gating); the EA path inherited none of that plumbing (no claim forwarder, no custody-hop allowance, no price floor on agent listings). Any remediation should treat EA integration as a whole, not patch findings one at a time.

No issues were found that let an unprivileged external party steal funds from a stash they have no relationship with; the confirmed thefts require either a granted-then-compromised agent (F-1) or are self-inflicted fund locks surfaced by normal use (F-2).

## 2. Severity-Ordered Findings Table

| # | Severity | Contract(s) | Anonymously reachable? | Status |
|---|----------|-------------|------------------------|--------|
| F-1 | **High** | BidderContract / BidderContractFactory (agent envelope) | **No** — requires owner-granted agent with `TradeList`/`AuctionCreate` bit; then exploitable by the (non-owner) agent key | CONFIRMED (High / High) |
| F-2 | **High** | BidderContract + EnglishAuction | **Effectively yes** — loss state reached via routine, permissionless auction activity (any bidder can outbid); precondition is only that the stash bid | CONFIRMED (Medium + High → High) |
| F-3 | **Low** | BidderContract / EnglishAuction / TokenStakerV2 | Trigger is permissionless (`settle()`); harm is a liveness brick, owner-recoverable | CONTESTED (Informational/Low refute vs Low/Medium confirm → **Low**) |

## 3. Detailed Findings

---

### F-1 — Agent-envelope caps do not bound NFT alienation; a granted (compromised) agent can give away every stash NFT for ~0 — **High — CONFIRMED**

**Locations.**
- `BidderContract.sol:979-1006` (`createTrade`, incl. `_approveNFTTo` at ~L995) and `1032-1052` (`createAuctionListing`)
- `BidderContractFactory.sol:1284-1291` — `spendForAgent(auth, ActionType.TradeList, 0, 0)`
- `BidderContract.sol:1037` — `_envelopeVerifyForAuction(auth, ActionType.AuctionCreate, 0, 0)`
- Enabled by `LazySecureTrade.sol:1957` (non-zero price only enforced for **open** trades) and `contracts/libraries/AgentEnvelopeLib.sol:150-177` (`verifyAndConsume`); envelope struct `interfaces/IAgentEnvelope.sol:96-114`

**What & why.** The agent-envelope model is the containment mechanism for a delegated, possibly-compromised agent key: it enforces per-tx and daily **HBAR/LAZY** caps, an expiry, a pause, and an `allowedActions` bitmap in `AgentEnvelopeLib.verifyAndConsume`. Those value caps are only ever evaluated against the `(hbarAmount, lazyAmount)` the dispatcher passes in. The two code paths that **alienate NFTs** pass `(0, 0)`:

- `BidderContract.createTrade` → `BidderContractFactory.createTradeOnBehalfOfStash` calls `spendForAgent(auth, TradeList, 0, 0)` (verified at `BCF:1285-1290`).
- `BidderContract.createAuctionListing` calls `_envelopeVerifyForAuction(auth, AuctionCreate, 0, 0)` (verified at `BidderContract:1037`).

Because the amounts are zero, every per-tx and daily cap passes trivially. The **only** effective gate becomes the single action-permission bit. The envelope struct has **no token allowlist, no minimum-price floor, and no NFT-value cap** (`IAgentEnvelope.sol:96-114`), so an agent holding `TradeList` (or `AuctionCreate`) can list/auction **any** NFT the stash holds at **any** price it chooses. `createTrade` also grants LST the per-serial approval (`_approveNFTTo`, ~L995) with no owner gate before forwarding, and `LazySecureTrade` only requires a non-zero price for **open** trades (`LST:1957`) — a **closed** trade (`buyer != 0`) can be created at `tinybarPrice = 0, lazyPrice = 0`.

**Exploit / impact path.** Alice funds a stash with a valuable NFT and authorizes a listing bot with an envelope granting `TradeList` and deliberately small caps (e.g. 5 HBAR/day), believing that bounds the bot's blast radius. The bot key is compromised. The attacker calls `stash.createTrade(token, buyer = attackerEOA, serial = valuable, tinybarPrice = 0, lazyPrice = 0, expiry = 0, auth)` — a closed trade at price 0. `spendForAgent(TradeList, 0, 0)` passes all caps (only the bit is checked). The attacker's EOA (holding the 1-tinybar custody-hop HBAR allowance to LST) calls `LST.executeTrade{value:0}(tradeId)`; the NFT moves stash → attacker for free. Repeat for every serial in the stash. The `AuctionCreate` path is equivalent: create an auction with `startPrice = 1, buyNow = 1`, then buy-now via a confederate. The caps the owner configured to contain a rogue agent provide **zero** protection against total NFT loss.

**Preconditions (who must act).** The stash **owner** must first authorize an agent envelope carrying the `TradeList` (bit 3) or `AuctionCreate` (bit 6) permission — this is not anonymously reachable. A buy-side-only bot (`BidCreate`/`AuctionBid`) is unaffected. The subsequent theft is performed by whoever holds the agent key (the assumed threat model: a compromised delegated key). Per-serial approval is the only partial mitigation and it does not bound *how many* serials or *at what price*.

**Why verifiers confirmed (both High).** Both verifiers traced every step to reachable source and both noted the "mitigations" (the permission bit, the per-serial approval) are reactive and do not bound the loss. The envelope simply lacks any NFT-value dimension, so no configuration the owner can choose limits the damage.

**Fix (code-level).** Treat NFT alienation as a **budget event**, not a zero-cost action:
1. Add an owner-set **minimum-price floor** to the envelope for `TradeList`/`AuctionCreate` (absolute floor and/or a per-collection floor), and reject agent-originated listings/auctions below it.
2. Charge the notional/floor value against the envelope's per-tx and daily caps so the caps actually bind the NFT paths (pass the floor, not `0`, into `spendForAgent`/`_envelopeVerifyForAuction`).
3. Optionally gate agent listings to an owner-approved `(token, serial)` allowlist in the envelope.
4. At minimum, **forbid the agent path from creating price-0 closed trades** and require a non-trivial price floor for all agent-originated listings/auctions — mirror `LST:1957`'s non-zero-price rule for closed trades on the agent path.

---

### F-2 — Stash cannot recover EnglishAuction pull-payment refunds; outbid / buy-now-excess / settle-bounty funds are permanently locked — **High — CONFIRMED**

*(Merged: this is the single root cause behind the two separately-reported findings "Stash-queued EnglishAuction refunds are unrecoverable — no path for a stash to call `EnglishAuction.claim`" [rated Medium] and "Stash cannot withdraw EnglishAuction pull-payment refunds — permanent fund lock" [rated High]. Same defect — a missing `claim()` forwarder on the stash — reported at two scopes. Final severity **High**, per the broader analysis: the lock spans outbid, buy-now overpayment, settle bounty, and failed-settle winner refund, and being outbid is the *normal* outcome for most auction bids, making the loss systematic rather than edge-case.)*

**Locations.**
- `BidderContract.sol:1059-1079` (`placeAuctionBid`), `1086-1106` (`buyNowAuction`) — forward stash value into EA so the **stash is the recorded bidder**; **no** `claim` forwarder exists anywhere in `BidderContract` (verified — the only EA calls are `createAuction`/`placeBid`/`buyNow`)
- `EnglishAuction.sol:566` (outbid → `_queueRefund`), `559` (buy-now excess), `670`/`681` (settle bounty / failed-settle winner refund), `995-1002` (`_queueRefund` is a pure pull-queue, no push attempt), `696-719` (`claim(PaymentToken)` credits `msg.sender` only, no on-behalf variant)

**What & why.** EnglishAuction refunds are strictly pull-payment. When a bidder is outbid, `_queueRefund(prevBidder, …)` credits `claimableHbar[bidder]` / `claimableLazy[bidder]` and never attempts a transfer (`EA:995-1002`). The same pure-pull path handles buy-now overpayment (`EA:559`), the settle bounty to the settler (`EA:670`), and the winner refund on a failed settle (`EA:681`). The only retrieval path is `EnglishAuction.claim(payment)` (`EA:696-719`), which pays `msg.sender` and has **no** claim-on-behalf variant.

A stash bids via `BidderContract.placeAuctionBid`/`buyNowAuction`, which call `IEnglishAuction(englishAuction).placeBid{value: amount}(…)` — so from EA's perspective the **stash address** is `msg.sender` and becomes the queued recipient. But `BidderContract` exposes **no function that calls `EnglishAuction.claim`** (confirmed by source grep: the contract only ever calls `createAuction`/`placeBid`/`buyNow`), and it has no generic external-call capability. `withdrawHbar`/`withdrawLazy`/`rescueHbar`/`rescueLazy` and `detachFromFactory` only move the stash's **own already-held** balance — they cannot reach funds sitting in EA's claim ledger under the stash's address. Because the stash is an immutable CREATE2-locked minimal-proxy clone (implementation fixed forever to preserve deterministic addresses), a claim forwarder **cannot be retrofitted onto already-deployed stashes**.

**Exploit / impact path.** Alice funds her stash with 10 HBAR and calls `placeAuctionBid(auctionId, 10 HBAR)`. Bob (anonymous, permissionless) outbids at 11 HBAR. EA runs `_queueRefund(aliceStash, HBAR, 10)` (`EA:566`), crediting `claimableHbar[aliceStash] = 10 HBAR`. The only way to retrieve it is `EA.claim()` called **by** the stash — and the stash has no function that calls it. The 10 HBAR is stranded permanently. Identical locks occur on buy-now overpayment (`EA:559`) and on the settle bounty when the stash is the settler (`EA:670`). Being outbid is the normal outcome for the majority of auction bids, so this is systematic loss across ordinary use.

**Preconditions (who must act).** The stash owner/agent must have placed an auction bid or buy-now (the normal, intended feature). The loss-triggering event — being outbid — is performed by any anonymous third party, or arises with no third party at all (buy-now overpayment, self-settle bounty). No attacker privilege is required; the harm falls on the stash that used the feature.

**Why verifiers confirmed.** Both verifiers attempted refutation and every link held: EA records the stash as bidder; refunds route exclusively through the pure pull-queue; `claim` is `msg.sender`-only with no on-behalf form; and the stash's sovereignty escape hatches provably operate only on its own balance, never on EA's `claimable*` mapping. The severity split (Medium vs High) reflected scope only — the narrower framing counted outbid refunds; the broader framing counted the full set (outbid + excess + bounty + failed-settle) and the systematic frequency. High is adopted.

**Fix (code-level).**
- **Primary (pre-deployment):** add an owner/agent-gated forwarder to `BidderContract`:
  ```solidity
  function claimFromAuction(IEnglishAuction.PaymentToken p)
      external onlyOwner nonReentrant
  {
      IEnglishAuction(englishAuction).claim(p);
  }
  ```
  so queued HBAR/LAZY returns to the stash balance (then withdrawable/rescuable). Because the stash implementation is immutable, this **must** ship before any stash is deployed.
- **Defense-in-depth for any already-deployed immutable stash:** add a permissionless `claimFor(address recipient)` to `EnglishAuction` that pays `recipient`'s queued balance **to `recipient`** (not to `msg.sender`), so a stranded stash can be swept by anyone without a stash-side entry point.

---

### F-3 — EnglishAuction NFT delivery reverts by default for stash winners/sellers; the custody-hop HBAR allowance to EA is never granted — **Low — CONTESTED**

*(Merged: this is the single root cause behind the two separately-reported findings "Stash cannot receive EnglishAuction winnings — settle reverts" [finder Medium] and "EnglishAuction NFT delivery reverts by default for stash winners/sellers — custody-hop HBAR allowance to EA is never granted" [finder High]. Both describe the identical `moveNFTs` WITHDRAWAL custody-hop allowance gap on the EA path; one framed it from the winner side, the other from winner + seller-on-cancel/reserve-miss. Same defect, same fix.)*

**Locations.**
- `TokenStakerV2.sol:122-146` — WITHDRAWAL leg builds the 1-tinybar `CUSTODY_HOP_TINYBAR` consideration as a **debit from the recipient** with `isApproval = true` (the delivering contract must hold a HIP-906 HBAR allowance **from** the recipient)
- `EnglishAuction.sol:916-941` (`_releaseBundle` → `moveNFTs` WITHDRAWAL to `to = winner`/seller), `627-689` (`_settleInternal`, atomic delete+release), `469-490` (`cancelAuction`, blocked once there are bids)
- `BidderContract.sol:1032-1052`/`1059-1106` — the stash EA entry points (`createAuctionListing`/`placeAuctionBid`/`buyNowAuction`) grant EA **no** HBAR allowance; `_ensureHbarAllowanceForCustodyHop` is wired **only** to LST (`executeTrade`, ~L879)
- Recovery lever: `BidderContract.approveHbarTo(spender, amount)` — `onlyOwner` (`BidderContract.sol:440-446`)

**What & why.** Every NFT leaving EA moves through `TokenStakerV2.moveNFTs` in the WITHDRAWAL direction, which sets `isApproval = true` and constructs the 1-tinybar leg as `-CUSTODY_HOP_TINYBAR` debited from `receiverAddress` — i.e. the recipient's 1 tinybar is pulled via an HBAR allowance the recipient must have previously granted to **EA**. `settle()` is permissionless, so the recipient is not the transaction signer and cannot satisfy the debit by signature — the allowance is mandatory. LST handles this by lazily calling `_ensureHbarAllowanceForCustodyHop(LST)` inside `executeTrade`, but **EnglishAuction has no equivalent**, and the stash-side EA entry points grant EA no allowance. When a stash wins (or is the seller on reserve-miss/cancel), `_releaseBundle` → `moveNFTs` tries to pull the stash's 1 tinybar via a never-granted allowance; HTS returns `SPENDER_DOES_NOT_HAVE_ALLOWANCE` and the transfer reverts with `HTSCallFailed(code, "XFER")`. Since delete+release is atomic, the whole settlement unwinds: buy-now from a stash always reverts, and a competitive stash win cannot be settled (and `cancelAuction` is blocked once bids exist), leaving the winning HBAR and the seller's escrowed NFT stuck until someone provisions the allowance.

**Exploit / impact path.** A stash wins an HBAR auction (its HBAR now escrowed in EA). After `closeAt`, any bounty hunter calls `settle(auctionId)`; `_releaseBundle` delivers the NFT to the stash via `moveNFTs` WITHDRAWAL, which reverts because the stash granted EA no custody-hop allowance. Every settle attempt reverts and `cancelAuction` is blocked — seller unpaid, winner's HBAR and the NFT frozen — until the stash owner calls `approveHbarTo(englishAuction, ≥ 1 tinybar)` and someone re-settles. The same brick hits `cancelAuction`/failed-reserve settle when the seller is a stash.

**Preconditions (who must act).** A stash must be the auction winner (or a stash-seller on reserve-miss/cancel). `settle()` is permissionless, so anyone can trip the revert. Recovery requires the stash **owner** to call the `onlyOwner` `approveHbarTo(englishAuction, …)` and then re-settle.

**The split (why CONTESTED, final Low).** All four verifiers agree the **mechanism is real and code-accurate** — the WITHDRAWAL custody-hop debits the recipient via an allowance EA is never granted, and no stash EA entry point provisions it.
- **Refuting side (real=false → Informational; real=false → Low):** the funds are **not permanently locked**. `approveHbarTo(englishAuction, amount)` is an owner-sovereign standing lever available before or after a failed settle; `_settleInternal` reverts **atomically** (the `delete auctions[auctionId]` is unwound), so the auction stays `Open` and `settle()` — being permissionless and idempotent — can simply be re-called once the allowance exists. On that view it is a documentation/UX provisioning gap, not a fund-loss vulnerability.
- **Confirming side (real=true → Low; real=true → Medium):** the settlement **happy path is bricked by default** for the flagship v0.3 stash flow — nothing in the code or docs sets up the allowance, so the primary flow fails until the owner discovers an undocumented manual step; buy-now from a stash always reverts; EOA participants are also affected unless they `hbarApprove` EA out-of-band.

Weighing recoverability (an `onlyOwner` standing fix exists and settlement is atomic + re-callable) against the default-bricked happy path and poor discoverability, the adjudicated severity is **Low**: a real liveness/DoS-by-default defect that is owner-recoverable and causes no unrecoverable loss.

**Fix (code-level).** Mirror the LST custody-hop pattern for EA:
1. Have `BidderContract` lazily ensure the custody-hop allowance to EA — call `_ensureHbarAllowanceForCustodyHop(englishAuction)` inside `placeAuctionBid`/`buyNowAuction`/`createAuctionListing` (or grant it once in `setEnglishAuction`).
2. **Preferred, and covers EOA participants too:** change `EnglishAuction._releaseBundle` so **EA funds the 1-tinybar custody hop itself** (declare the hop as an EA-sourced debit rather than a recipient-approval debit), so delivery never depends on any recipient pre-approving EA.
3. Defense-in-depth: add an NFT claim-queue fallback so a failed delivery does not brick `settle()` and strand seller proceeds.

---

## 4. Caveats

- This report is the product of an **automated multi-agent adversarial review** (vuln-class finders + two verifiers per finding), with lead-auditor spot-checks of the merge-critical code paths. It is **not** a substitute for a formal manual audit, property-based **fuzzing**, or **formal verification**, all of which are recommended before mainnet deployment.
- Coverage is finding-driven and does not assert the absence of other issues; areas not surfaced here (e.g. `LazyRebatePool` epoch accounting under adversarial timing, `VIPSubscription` pricing edge cases, HTS precompile response-code handling across all `moveNFTs` directions, reentrancy across the factory↔stash↔EA/LST call graph) were only exercised insofar as findings pointed at them and warrant dedicated review.
- Hedera-specific execution constraints (50 subcalls/tx, ~1M gas per association, no gas refunds on revert, timestamp-ordered consensus / no mempool) shape both the exploitability and the fixes above; any remediation should be re-validated on **live testnet**, since these contracts execute real HTS precompile calls, not local EVM stubs.
- The two High findings (F-1, F-2) both concern **immutable, CREATE2-locked stash clones** — fixes that change `BidderContract` storage or add functions **cannot be retrofitted onto already-deployed stashes** and must land before stash deployment; for any stash already live, apply the EnglishAuction-side defense-in-depth variants (`claimFor`, EA-funded custody hop) instead.