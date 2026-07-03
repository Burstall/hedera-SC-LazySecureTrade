# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LazySecureTrade (LST)** is a decentralized NFT trading platform for Hedera Token Service (HTS) NFTs, written in Solidity and deployed on Hedera via EVM. v0.2 ships single trades, atomic batch trades, and non-atomic multi-trade execution with a tiered platform fee system tied to LSH token holdings. v0.3 (in progress on the current branch) adds a CLOB-style bidding system via `BidderContractFactory` + per-user `BidderContract` honeypots.

## Commands

All test/build commands go through Hardhat via yarn.

```bash
yarn                              # install
yarn hardhat compile              # compile contracts (runs hardhat-contract-sizer + hardhat-docgen on compile)
yarn test                         # run full hardhat test suite
yarn run test-trade               # run test/LazySecureTrade.test.js only
yarn run test-lazy                # run test/LAZYTokenCreator.test.js
yarn run test-delegate            # run test/LazyDelegateRegistry.test.js
yarn hardhat test test/BidderContractFactory.test.js   # run v0.3 stash/bid/arbitrage tests
npx solhint 'contracts/**/*.sol'  # lint Solidity
node scripts/testing/create2Probe.js                  # validate CREATE2 on Hedera (testnet only)
```

Tests talk to **live Hedera testnet/previewnet** via `@hashgraph/sdk` — they are not local-only unit tests. `.env` must define `ENVIRONMENT` (`test|main|preview|local`), `ACCOUNT_ID`, and `PRIVATE_KEY` (ED25519) before running. Mocha timeouts are set to ~100s in `hardhat.config.js` because each test performs real on-chain calls. Do not assume fast iteration.

Solidity toolchain: **0.8.18**, optimizer enabled (200 runs), `viaIR: true`. Contract size is enforced strictly (`contractSizer.strict: true`) so compilation fails if a contract blows the EVM 24,576-byte limit.

## Architecture

### Core contract stack (inheritance matters)

```
LazySecureTrade
  ├── Ownable, ReentrancyGuard (OZ)
  ├── TokenStakerV2            ← HTS NFT transfer + association + LazyGasStation refills
  │     └── HederaTokenService ← HTS precompile wrapper
  └── ILazySecureTrade

BidderContract                 (proxy-cloned per user)
  └── TokenStakerV2, ReentrancyGuard

BidderContractFactory          (central router / CLOB)
  └── Ownable, ReentrancyGuard
```

`TokenStakerV2` is the critical shared base — it owns the `lazyToken`/`lazyGasStation`/`lazyDelegateRegistry` wiring and performs the **2-step NFT transfer pattern** (seller → contract → buyer) required for Hedera royalty compliance. Any contract that moves HTS NFTs must go through it. It also enforces `MAX_NFTS_PER_TX = 8` and has a `refill` modifier that tops up contract HBAR from `LazyGasStation` when low.

### LazySecureTrade flow (v0.2)

- **Trade ID** = `keccak256(token, serial)` — at most one active trade per (token, serial). Creating a new trade prunes any prior trade for that pair.
- **Pricing** is XOR-per-item for batch trades: each item has either a tinybar price or a LAZY price, not both. `0/0` auto-corrects to 1 tinybar minimum.
- **Open-market trades** (`buyer == address(0)`) cost `lazyCostForTrade` in $LAZY (drawn via `LazyGasStation.drawLazyFrom` with `lazyBurnPercentage` burned). LSH Gen1/Gen2 holders are exempt via `areAdvancedTradesFree()`. Closed trades (specific buyer) are free to list.
- **Platform fees** are HBAR-only and applied at execution, not creation. Tiered discounts via LSH tokens: Gen1 = 100% off (free), Mutant = 75% off, Gen2 = 50% off, none = 1% base. **$LAZY trades are always fee-free** — this is an intentional utility boost for $LAZY and must be preserved.
- **LSH delegation counts** — delegated tokens tracked via `LazyDelegateRegistry` confer the same fee tier as owned tokens.
- **Batch trades** (`createBatchTrade`) are atomic and capped at 22 items. **Multiple trade execution** (`executeTrades`) is also atomic and capped at 5 trades for subcall-limit safety (`createMultipleTrades`, the bulk *creation* API, is capped at 22). These are two *different* APIs — don't conflate them.
- **Authorized factories** (`authorizedFactories[factory] = true`, owner-gated) can call `createTradeOnBehalf()` to list trades on behalf of a seller, bypassing the $LAZY listing cost. This is the v0.3 integration hook for `BidderContractFactory`.

### v0.3 Bidder architecture — stash per user, CLOB-style bidding, arbitrage

Per-user contracts are called **stashes**. Factory code still uses `BidderContract` as the class name; all external surface uses "stash" terminology.

- **CREATE2 deterministic stash addresses**: `BidderContractFactory` deploys one stash per user via `Clones.cloneDeterministic` with salt `keccak256("LST_STASH_v1", user)`. Off-chain clients compute the stash address without RPC calls, then query the mirror node directly for balances/NFTs. `getStashAddress(user)` is the on-chain prediction view; `getStashOf(user)` is the O(1) mapping confirming deployment.
- **Stash implementation locked**: the implementation contract's constructor sets `initialized = true` so it cannot be hijacked. Only clones (with fresh storage) can be initialized, atomically inside the factory's deploy path.
- **Stash sovereignty**: every stash exposes `rescueHbar`, `rescueLazy`, `rescueNFT` (emergency escape hatches) and `detachFromFactory()` (one-way factory severance). After detach, the stash becomes a pure vault — withdrawals work, factory-mediated flows don't.
- **Arbitrage flow**: `executeArbitrage(bidId, tradeId, minProfit)` matches a resting bid against an open-market LST ask. Self-arbitrage is blocked (`msg.sender ∉ {bid.user, trade.seller}`, `bid.user != trade.seller`). Profit accrues to `pendingArbProfit[arbitrageur]` + `pendingProtocolProfit`, claimable via separate functions. The arb/protocol split (`arbitragePayoutBps`, default 50/50) is adjustable with a 48h inline timelock.
- **No MEV defense needed**: Hedera consensus orders by timestamp — no mempool, no front-running, no sandwich attacks.
- **Scoped factory→stash fund path**: `factoryWithdrawHbar/Lazy` (the old blanket-drain paths) are removed. The only path for the factory to touch stash funds is `arbitrageSettle(bidId, tradeId, amount)`. (The former `ARB_SETTLE_MAX_BPS = 7500` 75% per-tx cap was **removed** — audit finding C: it was evaluated against the *post-trade* stash balance, which equals the spread for a normally-funded stash, so it reverted *every* legitimate arbitrage; and a per-call % cap can't protect against a compromised factory anyway since it's `onlyFactory` code either way. The stash's real backstop against a rogue factory is its `detachFromFactory` + `rescueHbar/Lazy/NFT` sovereignty. See `docs/SECURITY-AUDIT-2026-07-01.md`.)
- **Bid state machine**: `BidStatus` enum (`None/Active/Cancelled/Executed/Expired`) with `_closeBid` transition helper. **Hard-delete on close**: `_closeBid` does `delete bidRegistry[bidId]` so post-close storage reads return a zeroed struct. The bid lifecycle events (`BidCreated`/`BidCancelled`/`BidExecuted`/`BidExpired`/`ArbitrageExecuted`) are the canonical history layer for off-chain consumers. Active bids are removed from discovery arrays via O(1) swap-pop (stored indexes).
- **BidDetails.minAcceptablePrice**: bidder-set floor for arbitrage — protects against surprise-cheap trade matches (e.g., junk NFT at 1 tinybar under the same collection).
- **`isBidValid` returns `(bool, BidValidityCode)` enum** — not strings. Stable programmatic API, no heap allocations.
- **View pagination**: `getBidsForTokenPaginated` enforces `limit <= 200`; `getBidsForTokenSerialPaginated` is the cursor-based replacement for the unbounded O(n²) serial scan.
- **`getStashSnapshot(user)`**: aggregator view returning stash address, deployment status, HBAR+LAZY balances, and active bid IDs in one call.
- **`HTSCallFailed(int256 code, bytes4 op)`**: unified HTS error replacing four separate errors in `TokenStakerV2`. Surfaces the actual precompile response code + a 4-byte operation identifier (`"INIT"`, `"XFER"`, `"ASSC"`, `"BASC"`).
- **Event model**: bid lifecycle events (BidCreated/Cancelled/Executed/Expired, ArbitrageExecuted) are emitted by the factory. The stash emits `StashArbSettled` on arbitrage settlement + `FactoryDetached` on sovereignty detach. Users can subscribe to their deterministic stash address on mirror node for direct balance/transfer monitoring.
- **Lazy cleanup**: expired bids are not auto-pruned; callers use `cleanupExpiredBids()`. Don't add gas-heavy automatic sweeps.
- **Royalty handling (not "royalty defeat")**: the 1-tinybar value in `TokenStakerV2.moveNFTs` is `CUSTODY_HOP_TINYBAR` — an internal custody-hop marker, not royalty evasion. See `SECURITY.md` "Royalty Handling" section. The platform enforces creator royalties at the real sale leg.
- **LazyDelegateRegistry is immutable and buggy**: LDR calls in `getLSHTokenTier` are wrapped in try/catch via `_safeGetDelegatedLength` so an LDR revert doesn't brick trade execution. The degraded fallback is "no delegation" (user gets base fee tier).

### Hedera gas model — non-obvious constraints

These are not standard EVM assumptions and bite any change that touches transfer loops:

- **50 subcalls per transaction** — every HTS precompile call counts. Batch sizes are deliberately conservative because of this, not because of gas alone.
- **~1M gas per new token association**. Use `isTokenAssociated(address)` (backed by an `EnumerableSet`) *before* estimating — it consumes no subcalls. UX should cap new associations at 5–8 per tx.
- **No gas refunds on revert** (unlike Ethereum) — users pay for consumed gas even if the tx fails. Prefer explicit validation over "try it and see".
- `validateTokenAssociations()` was removed in v0.2 to save subcalls — do not re-add blanket association checks inside loops.

### Contract size budget

LST is tight against the 24,576-byte EVM limit. v0.2 sits around 22.5–23.9 KiB depending on optimizations. Adding storage, events, or logic to `LazySecureTrade` will likely push it over — check `artifacts/` output after compile and prefer moving new functionality into `BidderContractFactory` or helper contracts. Size regressions break compile because `contractSizer.strict: true`.

### Custom errors over revert strings

v0.2 migrated to custom errors (see `Custom-Errors-Migration.md`). Several were consolidated (`InsufficientPayment` covers what was previously 4 errors; `UserNotAuthorized` covers seller/buyer checks; `InvalidBatchParameters` covers length-mismatch + empty-batch). When adding new failure paths, extend or reuse existing errors rather than creating granular new ones — it costs bytecode.

## Repo layout

- `contracts/` — Solidity sources. `interfaces/` holds external interfaces, `legacy/` contains older HTS wrappers and `LAZYTokenCreator.sol` used only in tests.
- `test/` — Hardhat+Mocha tests that deploy to a real Hedera environment. `utils/hederaHelpers.js`, `utils/hederaMirrorHelpers.js`, and `utils/solidityHelpers.js` wrap the SDK and mirror-node queries; reuse them rather than calling `@hashgraph/sdk` directly in new tests.
- `scripts/deployments/` — deployment scripts (`deployLazySecureTrade.js` is interactive and reuses pre-existing component addresses from `.env` when set).
- `scripts/interactions/` — one-off CLI helpers for every user-facing contract call (create/cancel/execute trades, LSH benefit checks, mirror log scanning, etc.). These are the canonical reference for "how do I call X" — check here before writing a new interaction.
- `abi/`, `artifacts/`, `cache/` — build output; `extractABI.js` in `scripts/deployments` emits cleaned ABIs after compile.
- `docs/v0.3-integration-guide.md` — human-readable integration guide for v0.3 stash/bid/arbitrage flows.
- `docs/CLAUDE-FRONTEND-CONTEXT.md` — context file for Claude Code sessions building the DApp frontend.
- `contracts/test/` — CREATE2 probe contracts for empirical Hedera EVM validation (not production code).

## Security audit (2026-07-01) — applied fixes

A multi-agent adversarial audit (`docs/SECURITY-AUDIT-2026-07-01.md`; re-run via the
`lst-security-audit` workflow in `.claude/workflows/`) surfaced these, all now fixed:

- **A (Critical, LST):** `executeTrades` / `executeBatchTrade` skipped the `msg.value`
  check (they pass `_checkFunds=false`), so a buyer could take NFTs while the contract
  paid sellers from its own HBAR. Fixed: `_refundExcessHbar` now reverts on shortfall.
- **B (High, EnglishAuction):** settlement underflowed (`sellerProceeds = bid − fee −
  bounty − Σroyalty`) when a bundle's royalties exceeded the bid → permanent lock. Fixed:
  royalties are capped at the funds remaining after fee+bounty.
- **C (Med, BidderContract):** the `ARB_SETTLE_MAX_BPS` 75% cap was measured on the
  *post-trade* balance and reverted every arbitrage. Removed (see the v0.3 note above).
- **D (Low, VIPSubscription):** `purchaseSubscription`/`priceFor` now reject a tier whose
  `monthlyPriceLazy` is unset (0) — closes a pre-pricing free-mint.
- **E (Med, EnglishAuction):** `withdrawProtocolFee` is now bounded to
  `protocolFeesAccrued` per rail so it can't reach user escrow.
- **F (Med, LazyRebatePool):** `settleEpoch` now reserves prior epochs' unclaimed
  allocations (`totalOutstanding`) so overlapping epochs can't over-commit the pool.
- **G (VIPSubscription):** `MAX_ALLOWED_COMBINED_DISCOUNT_BPS` raised 5000→9000 to match
  the constructor default (they contradicted).
- **H (Low, BidderContractFactory):** added permissionless `pruneUnfundedBid` so unfunded
  no-expiry bids can't bloat the discovery arrays forever.
- **I:** non-issue (auction `settle` is re-callable after an unassociated-recipient
  revert — the recovery path is re-settling, not the removed `claimAuctionNFT` stub).

## Conventions

- **Never introduce $LAZY fees on LAZY-denominated trades** — it's a deliberate tokenomics choice.
- **Always preserve the 2-step NFT transfer** in any new transfer path. Seller → contract → buyer is required for Hedera royalty compliance; a direct seller→buyer transfer silently breaks royalties.
- **Don't add "safety" association checks inside loops** — they consume subcalls and were intentionally removed. Check once, up-front, via `isTokenAssociated()`.
- **Prefer extending existing custom errors** over adding new ones (bytecode pressure).
- **Factory-initiated flows use `createTradeOnBehalf()`**, not `createTrade()`, and must leave `authorizedFactories` gating intact.
- Tests run against real Hedera — they cost HBAR and take minutes. Don't suggest running the full suite casually; point at `yarn run test-trade` or a single `hardhat test <file>` invocation.
