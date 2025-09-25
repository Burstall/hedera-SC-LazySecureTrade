# hedera-SC-LazySecureTrade
Decentralized NFT Trading without time constraint using Solidity EVM on Hedera via the LazySecureTrade (LST) contract.

This is the building block to a full decentralized marketplace #HelloFuture

**Version 0.2** - Individual trades, atomic batch trades, and non-atomic multiple trades with advanced gas management.

## Quick Reference: Trade Types

| Trade Type | Method | Max Items | Execution | Gas Risk | Use Case |
|------------|--------|-----------|-----------|----------|----------|
| **Individual** | `createTrade()` | 1 NFT | Single | 🟢 Low | Simple trades |
| **Batch (Atomic)** | `createBatchTrade()` | 32 NFTs | All-or-nothing | 🔴 High | Bundle sales |
| **Multiple Execution** | `executeTrades()` | 20 trades | All-or-nothing | 🟡 Medium | Bulk buying |

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
- **Max Items**: 32 NFTs per batch (contract enforced)
- **Pricing**: XOR pricing (either HBAR or $LAZY per item, not both)
- **Association Planning**: Check `isTokenAssociated()` for each unique token first

## Multiple Trades & Batch Execution
Create and execute multiple individual trades efficiently:
- `createMultipleTrades()`: Create up to 32 individual trades
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
- **Batch Trades**: 32 items maximum (contract enforced)
- **Multiple Trade Creation**: 32 trades maximum (contract enforced)
- **Multiple Trade Execution**: 20 trades maximum (contract enforced for subcall management)

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
- **Current Size**: ~27.6 KiB (includes full platform fee system and batch operations)
- **Previous Size**: 29.14 KiB (before optimizations) → **1.54 KiB saved** through code optimizations
- **EVM Spurious Dragon Limit**: Exceeds 24.576 KiB limit but under continuous optimization
- **Hedera Compatible**: Deploys successfully on Hedera despite size
- **EVM Mainnet**: May not deploy on strict EVM mainnets without further optimization
- **Recent Optimizations**: Removed contract sunset mechanism, consolidated LSH checking logic, removed redundant `transferHbar()` method

### Network Compatibility
- ✅ **Hedera Mainnet/Testnet**: Full compatibility
- ✅ **Hedera EVM**: Full compatibility  
- ⚠️ **Ethereum Mainnet**: Size limit exceeded
- ⚠️ **Other EVM Networks**: Check individual size limits

```
