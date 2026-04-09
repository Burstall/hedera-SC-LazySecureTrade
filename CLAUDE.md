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
yarn hardhat test test/BidderContractFactory.test.js   # run a specific suite
npx solhint 'contracts/**/*.sol'  # lint Solidity
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
- **Batch trades** (`createBatchTrade`) are atomic and capped at 22 items. **Multiple trade execution** (`executeTrades`) is also atomic and capped at ~20 trades for subcall-limit safety. These are two *different* APIs — don't conflate them.
- **Authorized factories** (`authorizedFactories[factory] = true`, owner-gated) can call `createTradeOnBehalf()` to list trades on behalf of a seller, bypassing the $LAZY listing cost. This is the v0.3 integration hook for `BidderContractFactory`.

### v0.3 Bidder architecture (work in progress on `v0.3` branch)

- **`BidderContractFactory`** is the central router: deploys one `BidderContract` per user via OpenZeppelin `Clones` (minimal proxy, ~23K gas), maintains `tokenToBids[]` / `userToBids[]` / `bidRegistry`, and mediates trade execution against bids by calling `LazySecureTrade.createTradeOnBehalf()` + `BidderContract.executeTrade()`.
- **`BidderContract`** is a per-user honeypot that holds HBAR + $LAZY + received NFTs. `owner` (the user) has full sovereignty; `factory` has admin rights *only* for arbitrage. Uses a proxy init pattern — `initialized` guards `initialize()`. NFT withdrawals go through `TokenStakerV2` to preserve Hedera royalty handling.
- **Event model**: `BidderContract` does not emit user-level bid events — only the router (`BidderContractFactory`) does. Users monitor their BidderContract address for `LazySecureTrade` events instead. Don't add redundant events.
- **Lazy cleanup**: expired bids are not auto-pruned; callers use `cleanupExpiredBids()`. Don't add gas-heavy automatic sweeps.

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

## Conventions

- **Never introduce $LAZY fees on LAZY-denominated trades** — it's a deliberate tokenomics choice.
- **Always preserve the 2-step NFT transfer** in any new transfer path. Seller → contract → buyer is required for Hedera royalty compliance; a direct seller→buyer transfer silently breaks royalties.
- **Don't add "safety" association checks inside loops** — they consume subcalls and were intentionally removed. Check once, up-front, via `isTokenAssociated()`.
- **Prefer extending existing custom errors** over adding new ones (bytecode pressure).
- **Factory-initiated flows use `createTradeOnBehalf()`**, not `createTrade()`, and must leave `authorizedFactories` gating intact.
- Tests run against real Hedera — they cost HBAR and take minutes. Don't suggest running the full suite casually; point at `yarn run test-trade` or a single `hardhat test <file>` invocation.
