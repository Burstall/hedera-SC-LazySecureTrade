# hedera-SC-LazySecureTrade
Decentralized NFT Trading without time constraint using Solidity EVM on Hedera via the LazySecureTrade (LST) contract.

This is the building block to a full decentralized marketplace #HelloFuture

**Version 0.3 (includes all v0.2 features)** - Individual trades, atomic batch trades, non-atomic multiple trades, and CLOB-style resting bids with per-user stash contracts, seller-executed bid matching, and third-party arbitrage.

## Quick Reference: Trade Types

| Trade Type | Method | Max Items | Execution | Gas Risk | Use Case |
|------------|--------|-----------|-----------|----------|----------|
| **Individual** | `createTrade()` | 1 NFT | Single | 🟢 Low | Simple trades |
| **Batch (Atomic)** | `createBatchTrade()` | 22 NFTs | All-or-nothing | 🔴 High | Bundle sales |
| **Multiple Execution** | `executeTrades()` | 5 trades | All-or-nothing | 🟡 Medium | Bulk buying |
| **Bid (Resting)** | `createBid()` | 1 NFT/bid | Seller-matched or arbitraged | 🟢 Low | CLOB-style buy orders |

Key: 🔴 High gas risk requires careful planning • 🟡 Medium risk manageable • 🟢 Low risk straightforward

# Testing
create .env:
ENVIRONMENT=test
ACCOUNT_ID=
PRIVATE_KEY=

```yarn```
```yarn run test-trade```

# Platform Fee System (v0.2)

**LazySecureTrade now features a sophisticated tiered platform fee system:**

## Fee Structure (HBAR Trades Only)
- **Base Rate**: 1% (100 basis points) for users without LSH tokens
- **LSH Gen2 Holders**: 50% discount → **0.5% effective fee**
- **LSH Mutant Holders**: 75% discount → **0.25% effective fee** 
- **LSH Gen1 Holders**: 100% discount → **FREE TRADES** 🎉

## Key Features
- ✅ **LAZY Trades Excluded**: $LAZY trades remain **completely fee-free** (gives $LAZY additional utility)
- ✅ **Delegation Support**: Delegated LSH tokens count towards fee discounts
- ✅ **Lifetime Analytics**: Contract tracks total HBAR/LAZY volume processed
- ✅ **Owner Withdrawals**: Platform fees withdrawable via `withdrawPlatformFees()`
- ✅ **Mathematical Safety**: 100% discount calculations protected against edge cases

## Fee Calculation Example (1000 tinybar trade)
- **No LSH**: Pays 10 tinybar fee, seller receives 990 tinybar
- **LSH Gen2**: Pays 5 tinybar fee, seller receives 995 tinybar  
- **LSH Mutant**: Pays 2.5 tinybar fee, seller receives 997.5 tinybar
- **LSH Gen1**: Pays 0 tinybar fee, seller receives 1000 tinybar (**FREE!**)

*Note: Contract sunset mechanism has been removed - no more time constraints!*

# Create Trade
- User sets an allowance for the NFT (per serial of all serials) to the LST
- User creates a Trade:
	- Specifies price in HBAR (tinybar), $LAZY (if applicable), token, serial, expirytime (0 = never)
	- **Gas Planning**: Check association status via `isTokenAssociated(address)` and add ~1 million gas per new token association
	- If specific buyer specified, service is *FREE* to use
	- If <any> buyer specified (address(0)) then there is a cost of [x] $LAZY **ensure allowance to Lazy Gas Station (LGS)** *unless user owns/has delegated LSH Gen 1 / 2 tokens*
	- creating a trade will iterate a users existing trades and prune them [could be gas heavy if there is massive usage]

## Platform Fee Application (v0.2)
**Trade Creation**: No fees applied during trade creation (same as before)
**Trade Execution**: Platform fees are automatically deducted during trade execution:
- **HBAR Trades**: Subject to tiered platform fees based on seller's LSH token ownership
- **$LAZY Trades**: Completely fee-free (enhances $LAZY token utility)
- **Mixed Pricing**: Individual pricing per NFT - HBAR portions incur fees, $LAZY portions remain free

# v0.2 Batch Operations

## Batch Trades (Atomic)
Create atomic batch trades where all NFTs transfer together or the entire transaction fails:
- `createBatchTrade()`: Create atomic batch with per-serial pricing
- `executeBatchTrade()`: Execute entire batch atomically
- `cancelBatchTrade()`: Cancel entire batch
- **Max Items**: 22 NFTs per batch (contract enforced)
- **Pricing**: XOR pricing (either HBAR or $LAZY per item, not both)
- **Association Planning**: Check `isTokenAssociated()` for each unique token first

## Multiple Trades & Batch Execution
Create and execute multiple individual trades efficiently:
- `createMultipleTrades()`: Create up to 22 individual trades
- `executeTrades()`: Execute multiple existing trades atomically
- `cancelMultipleTrades()`: Cancel multiple trades in one transaction
- **Atomic Execution**: All requested trades execute or entire transaction reverts
- **Efficient**: Optimized for gas usage with HBAR usage tracking and single refund calculation

# Query Trade(s)
Use the free read-only calls via Mirror Nodes

## Individual Trades
- `getUserTrades(address _user)` -> bytes32[] of trades [user could be buyer or seller]
- `getTokenTrades(address _token)` -> bytes32[] of trades [no buyer specified]
- `getTrade(bytes32)` / `getTrades(bytes32[])` to get the Trade objects
- `isTradeValid(bytes32 _tradeId, address _user)` validate a trade for a user or <any> user

## Batch Trades (v0.2)
- `getUserBatchTrades(address _user)` -> bytes32[] of batch trade IDs
- `getBatchTrade(bytes32 _batchId)` -> BatchTrade object
- `getBatchTrades(bytes32[] _batchIds)` -> BatchTrade[] objects

## Utility Methods
- `getTokens(uint256 offset, uint256 batch)` (use `getTotalTokens()` to get full size)
- `isTokenAssociated(address _token)` -> bool [**CRITICAL for gas planning**]

## Platform Fee Query Methods (v0.2)
- `getPlatformFeeInfo()` -> Returns all fee rates, discounts, collected fees, and lifetime volumes
- `getLSHTokenTier(address _user)` -> Returns LSH tier: 0=none, 1=Gen2, 2=Mutant, 3=Gen1
- `calculateSellerFeeRate(address _seller)` -> Returns effective fee rate in basis points for seller
- `areAdvancedTradesFree(address _user)` -> Returns if user gets free $LAZY trade creation

# Cancel Trade
- cancelTrade(bytes32 _tradeId) only possible when user is noted as seller on the trade
( cancelling the allowance or moving the NFT will implicitly cancel the trade but it could be come live again if
not purged on fresh trade creation and allowance/movement is restablished)

# Execute Trade
Buyer must have a 1 tinybar allowance to LST contract to facilitate the transfer of NFT.
- executeTrade(bytes32)
	- payable function, send hbar as value for the tinybar price
	- Checks trade is valid for msg.sender
	- Ensures msg.sender is not seller per the Trade object
	- Checks value is sufficient, refunds the difference
	- **Platform Fee Deduction (v0.2)**: For HBAR trades, platform fees are automatically deducted based on seller's LSH tier
	- If a $LAZY payment element [buyer must have sufficient $LAZY allowance to LGS] take $LAZY and pay to seller (**NO FEES on $LAZY trades**)
	- Transfer NFT from seller to Smart Contract for hbar value [defaults to 1 tinybar if none set] -- contract pays
	- Transfer NFT from Smart Contract to Buyer for 1 tinybar
	- **Lifetime Volume Tracking**: Contract tracks total HBAR and LAZY volumes for analytics

# Scripts
Plenty of scripts to allow easy usage from the command line. Highlights below.
 scripts/deployments
  -> deployLazySecureTrade.js : interactive. allows component reuse via .env file
  -> extractABI.js : helper to get the ABI post compile
 scripts/interactions
  -> cancelTrade.js
  -> createTrade.js
  -> executeTrade.js
  -> getLazySecureTradeLogs.js [writes the emitted events to log file]
  -> getTokenTrades.js [a list of hashes for trades]
  -> getTrade.js [get the trade details from a hash]
  -> getTradesForUser.js
  -> isTradeValid.js [checks validity of trade based on specified buyer, allowances and expiry if set]

# v0.3 — CLOB-Style Bidding with Per-User Stash Contracts

v0.3 adds a resting-bid system to LazySecureTrade. Each user gets a **stash** — a dedicated contract (deployed as a minimal proxy clone at a deterministic CREATE2 address) that holds their HBAR, $LAZY, and any NFTs received from executed bids. Bids are resting buy orders registered in a central factory (BidderContractFactory), which sellers can match directly via `executeAgainstBid`. Third parties can also capture bid/ask spread via `executeArbitrage`, with profit splitting between the arbitrageur and the protocol. Every stash owner retains full sovereignty over their funds through escape hatches (`rescueHbar`, `rescueLazy`, `rescueNFT`) and a one-way `detachFromFactory` severance that converts the stash into a pure self-custody vault.

All v0.2 functionality (individual trades, batch trades, multiple trade execution, platform fees, LSH tier discounts) remains fully operational and unchanged.

## Stash (Per-User Contract)

- **One stash per user**, deployed via the factory's `deployStash()` or `deployStashFor(user)` (permissionless — anyone can pay gas to bootstrap another user's stash)
- Each stash lives at a **deterministic CREATE2 address** derived from `keccak256("LST_STASH_v1", userAddress)` — predictable off-chain given the factory address and implementation address, with no RPC call needed
- Holds **HBAR + $LAZY + received NFTs** in user-sovereign custody
- The stash owner can deposit, withdraw, create bids, cancel bids, and list NFTs held in the stash for sale — all without going through the factory owner
- CREATE2 addresses are locked to the specific factory address + implementation contract — if either changes, a new factory must be deployed and users deploy fresh stashes under it

```solidity
// Predict a user's stash address off-chain (pure CREATE2 derivation)
function getStashAddress(address user) public view returns (address)

// Deploy a stash for the caller
function deployStash() external returns (address stash)

// Deploy a stash for any user (permissionless, owner is always `user`)
function deployStashFor(address user) external returns (address stash)

// Verify a stash was deployed by this factory for its claimed owner
function verifyStash(address stash) external view returns (bool)
```

## Bid System

Bids are resting buy orders for specific NFT collections (optionally targeting specific serials).

### Creating a Bid

```solidity
// Called on the user's stash — validates funds, then registers with the factory
function createBid(
    address token,          // NFT collection address
    uint256[] memory serials, // specific serials (empty = any serial in collection)
    uint256 hbarAmount,     // HBAR bid amount in tinybars
    uint256 lazyAmount,     // $LAZY bid amount
    uint256 expiry,         // expiry timestamp (0 = no expiry)
    uint256 minAcceptablePrice // floor for arbitrage matching (0 = accept any)
) external returns (bytes32 bidId)
```

- The stash must hold sufficient HBAR and/or $LAZY at bid creation time
- `minAcceptablePrice` guards against surprise-cheap arbitrage matches (e.g., a junk NFT listed at 1 tinybar under the same collection). Cannot exceed `hbarAmount`
- Token association for NFT reception is handled automatically during bid creation

### Bid Lifecycle

Bids follow an explicit state machine via the `BidStatus` enum:

| Status | Value | Meaning |
|--------|-------|---------|
| `None` | 0 | Bid ID has never existed |
| `Active` | 1 | Live — eligible for execution and arbitrage |
| `Cancelled` | 2 | Explicitly cancelled by the bidder |
| `Executed` | 3 | Matched via `executeAgainstBid` or `executeArbitrage` |
| `Expired` | 4 | Swept by `cleanupExpiredBids` or marked expired on an execute attempt |

Transitions are one-way: Active → Cancelled, Active → Executed, Active → Expired. Closed bids are **hard-deleted** from `bidRegistry` via `delete bidRegistry[bidId]` inside `_closeBid` — reading the registry after close returns a zeroed struct. The bid lifecycle events (`BidCreated`/`BidCancelled`/`BidExecuted`/`BidExpired`/`ArbitrageExecuted`) are the canonical history layer for off-chain consumers. Active bids are removed from discovery indexes via O(1) swap-pop.

### Bid Validation

```solidity
// Returns (valid, reasonCode) — no string allocations
function isBidValid(bytes32 bidId) public view returns (bool valid, BidValidityCode code)
```

`BidValidityCode` enum: `Valid` (0), `NotFound` (1), `NotActive` (2), `Expired` (3), `InsufficientHbar` (4), `InsufficientLazy` (5).

## Trade Execution

### Seller-Initiated: executeAgainstBid

A seller who sees a resting bid can match it directly — no intermediary needed:

```solidity
function executeAgainstBid(
    bytes32 bidId,
    address nftToken,
    uint256 serial
) external returns (bytes32 tradeId)
```

Execution flow:
1. Factory validates the bid is Active, unexpired, and funded
2. Factory calls `LazySecureTrade.createTradeOnBehalf()` listing the NFT with the stash as buyer
3. Factory calls `stash.executeTrade()` which sends HBAR/$LAZY to LST and receives the NFT via the standard 2-step internal custody hop (seller → LST → stash)
4. Bid transitions to `Executed`, removed from discovery indexes
5. Platform fees apply normally (HBAR trades subject to LSH tier discounts; $LAZY trades remain fee-free)

### Stash-Initiated: createTrade

Users can list NFTs held in their stash for sale without withdrawing first:

```solidity
// Called on the stash — routes through Factory → LST.createTradeOnBehalf()
function createTrade(
    address token, address buyer, uint256 serial,
    uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime
) external returns (bytes32 tradeId)
```

## Arbitrage

Third parties can capture spread between a resting bid and an existing LST ask (open-market trade):

```solidity
function executeArbitrage(
    bytes32 bidId,         // the resting bid (higher price)
    bytes32 existingTradeId, // the LST ask (lower price)
    uint256 minProfit      // minimum acceptable HBAR spread
) external returns (uint256 spread)
```

**Self-arbitrage is blocked** at three points: the caller cannot be the bidder, the caller cannot be the seller, and the bidder cannot equal the seller. This closes the wash-trading loophole.

**Price floor**: the trade's tinybar price must be at or above the bid's `minAcceptablePrice`, protecting bidders from surprise-cheap matches.

**Profit split**: the spread (bid price minus trade price) is split between the arbitrageur and the protocol based on `arbitragePayoutBps` (default: 50/50). Changes to the split are subject to a **48-hour timelock** via `setArbitragePayoutBps` + `executeArbPayoutBpsChange`.

**Claim ledger**: arbitrage profits accrue to `pendingArbProfit[arbitrageur]` and are pulled via `claimArbProfit()` in a separate transaction. Protocol profits accrue to `pendingProtocolProfit` and are withdrawn by the factory owner via `withdrawProtocolProfit()`.

## Sovereignty & Escape Hatches

Every stash owner retains unconditional control over their assets:

| Function | Purpose |
|----------|---------|
| `rescueHbar(to, amount)` | Emergency HBAR withdrawal to any address — bypasses the normal 1 HBAR minimum balance guard |
| `rescueLazy(to, amount)` | Emergency $LAZY withdrawal to any address |
| `rescueNFT(token, serial, to, hbarValue)` | Emergency single-NFT withdrawal via TokenStakerV2 (handles Hedera royalties) |
| `detachFromFactory()` | **Irreversible** one-way severance — sets factory to `address(0)`, converting the stash into a pure vault. All withdrawal/rescue functions continue to work; only factory-mediated flows (bidding, arbitrage settlement) stop. |

For full sovereignty framing and migration procedures, see `SECURITY.md`.

## Query Methods (v0.3)

| Method | Returns | Notes |
|--------|---------|-------|
| `getStashAddress(user)` | `address` | Pure CREATE2 derivation — works before deployment |
| `getStashOf(user)` | `address` | O(1) mapping read — returns `address(0)` if not deployed |
| `getStashSnapshot(user)` | `(address, bool, uint256, uint256, bytes32[])` | Aggregated stash state: address, deployed flag, HBAR balance, $LAZY balance, active bid IDs (capped at 200) |
| `getBidsForTokenPaginated(token, offset, limit)` | `bytes32[]` | Paginated bid discovery by collection (limit <= 200) |
| `getBidsForTokenSerialPaginated(token, serial, offset, limit)` | `(bytes32[], uint256)` | Paginated bid discovery by (token, serial), returns matches + nextOffset for cursor paging |
| `isBidValid(bidId)` | `(bool, BidValidityCode)` | Structured validation with enum reason code |
| `validateBids(bidIds)` | `(bool[], BidValidityCode[])` | Batch validation for multiple bids |
| `getUserBids(user)` | `bytes32[]` | All bid IDs for a user |

## v0.3 Scripts

| Script | Location | Purpose |
|--------|----------|---------|
| `deployBidderContractFactory.js` | `scripts/deployments/` | Deploy the BidderContractFactory + BidderContract implementation. Environment-aware (`ENVIRONMENT` env var). |
| `create2Probe.js` | `scripts/testing/` | CREATE2 test harness — validates that deterministic clone deployment, address prediction, and mirror-node indexing work correctly on Hedera. Used to validate the stash architecture before committing to it. |

# Gas Management & UX Best Practices

## Hedera Network Limitations
Understanding Hedera's unique gas model is crucial for building efficient UX:

### Key Limits
- **Subcall Limit**: 50 subcalls per transaction
- **Block Gas Limit**: 15 million gas units
- **No Gas Refunds**: Unlike Ethereum, Hedera charges consumed gas even on reverts

### Token Association Costs
- **~1 million gas per token association** (approximate)
- Each `tokenAssociate()` call consumes precious subcalls
- Associations are permanent once established

## Smart Contract Gas Strategy

### Token Association Management
The contract uses an internal enumerable set (`tokens`) to track associated tokens efficiently:

```javascript
// Check if token is already associated (no subcalls consumed)
const isAssociated = await lazySecureTrade.isTokenAssociated(tokenAddress);

if (!isAssociated) {
    // Factor in ~1M gas for new association
    gasEstimate += 1_000_000;
}
```

### Batch Operation Limits
To prevent gas exhaustion and subcall limit breaches:

**Recommended Limits:**
- **New Token Associations**: 5-8 tokens maximum per transaction
- **Batch Trades**: 22 items maximum (contract enforced)
- **Multiple Trade Creation**: 22 trades maximum (contract enforced)
- **Multiple Trade Execution**: 5 trades maximum (contract enforced for subcall management)

**Conservative Approach:**
- Limit new associations to 5 tokens per batch for safety margin
- Check associations before batching: `isTokenAssociated(address)`
- Consider splitting large operations across multiple transactions

**LAZY Token Considerations:**
- Each LAZY payment in multiple trade execution consumes subcalls
- For batch execution with many LAZY payments: reduce batch size accordingly
- Example: 10 trades with LAZY = ~10 subcalls + other operations
- Balance batch size vs LAZY payment frequency for optimal gas usage

## UX Implementation Guidelines

### Pre-Transaction Planning
1. **Association Check**: Always call `isTokenAssociated()` for each token
2. **Gas Estimation**: Add ~1M gas per new association needed
3. **Batch Sizing**: Limit unassociated tokens to 5-8 per transaction
4. **User Communication**: Warn users about potential gas costs upfront

### Error Handling
Since we removed arbitrary limits, users may encounter natural Hedera errors:
- **Gas Exhaustion**: Transaction runs out of gas
- **Subcall Limit**: 50 subcall limit exceeded  
- **Block Limit**: Rare but possible on complex operations

### Example UX Flow
```javascript
// 1. Check associations for all tokens
const tokenAssociations = await Promise.all(
    tokens.map(token => lazySecureTrade.isTokenAssociated(token))
);

// 2. Count new associations needed
const newAssociations = tokenAssociations.filter(associated => !associated).length;

// 3. Warn user and suggest batching if > 5-8 new associations
if (newAssociations > 8) {
    showWarning("Consider splitting into smaller batches for reliability");
}

// 4. Estimate gas (base + associations)
const gasEstimate = baseGas + (newAssociations * 1_000_000);

// 5. Present clear cost breakdown to user
showGasEstimate(gasEstimate, newAssociations);
```

### Batch Trade Considerations
- **Atomic Execution**: Batch trades execute all-or-nothing
- **Gas Planning**: Factor in NFT transfers + token associations
- **Size Strategy**: Prefer multiple smaller batches over large risky ones

### Multiple Trade Execution Considerations  
- **Atomic Execution**: All trades execute or entire transaction reverts
- **All-or-Nothing**: No partial execution - prevents bad user experience
- **Efficient**: Single HBAR refund calculation based on actual usage, optimized internal execution
- **Hedera Optimized**: Two-step NFT transfers for proper royalty system compliance

## Migration Notes (v0.2)
- Removed arbitrary 6-token association limit
- Users now get natural Hedera gas errors instead of custom limits
- `validateTokenAssociations()` removed to save subcalls
- UX must handle gas planning more proactively

## Common Error Patterns & Solutions

### Gas Exhaustion
**Symptoms**: Transaction fails with out-of-gas error
**Solutions**: 
- Reduce batch size
- Check token associations beforehand
- Use conservative gas estimates

### Subcall Limit Exceeded  
**Symptoms**: Transaction fails after consuming ~50 subcalls
**Solutions**:
- Limit new token associations to 5-8 per transaction
- Split large operations across multiple transactions
- Use `isTokenAssociated()` to avoid unnecessary association attempts

### Pricing Validation Errors
**Symptoms**: `InvalidPricing()` error on batch trades
**Solutions**:
- Ensure XOR pricing: either HBAR OR $LAZY per item, never both
- Use 0 for the unused price type
- Remember: 0/0 pricing auto-corrects to 1 tinybar minimum

### Best Practice Checklist
- ✅ Always call `isTokenAssociated()` before operations
- ✅ Limit new associations to 5-8 per transaction  
- ✅ Use conservative gas estimates (+20% buffer)
- ✅ Implement retry logic for failed transactions
- ✅ Provide clear user feedback on gas costs
- ✅ Consider transaction splitting for large operations

## Contract Deployment Notes

### Size Considerations
All contracts compile **under the 24,576-byte (24.576 KiB) EVM contract-size
limit**. This is enforced strictly at compile time (`contractSizer.strict = true`
in `hardhat.config.js` — compilation fails if any contract exceeds it).

Representative deployed sizes (run `npx hardhat size-contracts` for live figures):

| Contract | Deployed size |
|---|---|
| `LazySecureTrade` | ~23.96 KiB |
| `EnglishAuction` | ~23.85 KiB |
| `BidderContract` (stash) | ~23.26 KiB |
| `BidderContractFactory` | ~18.37 KiB |
| `LazyRebatePool` | ~6.91 KiB |
| `LSHRebateMultipliers` | ~1.93 KiB |

`LazySecureTrade` is the tightest against the limit — adding storage, events, or
logic to it will likely break the size gate. Prefer moving new functionality into
`BidderContractFactory` or a helper contract.

### Network Compatibility
- ✅ **Hedera Mainnet / Testnet / Previewnet**: Full compatibility (primary target)
- ✅ **Hedera EVM**: Full compatibility
- ⚠️ **Other EVM networks**: These contracts depend on the Hedera Token Service
  precompile (`0x167`) and HTS-specific semantics (royalties, association). They
  are Hedera-specific and are not intended to deploy on non-Hedera EVM chains.

```
