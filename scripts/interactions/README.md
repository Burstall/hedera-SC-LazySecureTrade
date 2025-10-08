# LazySecureTrade Interaction Scripts

This directory contains comprehensive scripts for interacting with the LazySecureTrade smart contract. These scripts provide both individual and batch trading functionality, administrative tools, and utility functions.

## 📋 Table of Contents

- [Getting Started](#getting-started)
- [Core Trading Scripts](#core-trading-scripts)
  - [Individual Trades](#individual-trades)
  - [Batch Trades](#batch-trades)
  - [Multiple Independent Trades](#multiple-independent-trades)
- [Query & Information Scripts](#query--information-scripts)
- [Administrative Scripts](#administrative-scripts)
- [Utility Scripts](#utility-scripts)
- [LSH Token Benefits](#lsh-token-benefits)
- [Usage Examples](#usage-examples)
- [Environment Setup](#environment-setup)

## 🚀 Getting Started

### Prerequisites
- Node.js installed
- `.env` file configured with:
  ```
  ENVIRONMENT=test|main|preview|local
  ACCOUNT_ID=0.0.XXXXXX
  PRIVATE_KEY=302e020100...
  LAZY_TOKEN_ID=0.0.XXXXXX
  LAZY_GAS_STATION_CONTRACT_ID=0.0.XXXXXX
  LAZY_SECURE_TRADE_CONTRACT_ID=0.0.XXXXXX (optional for reuse)
  ```

### Common Parameters
- `0.0.LST` - LazySecureTrade contract ID
- `-h` - Show help for any script
- `-i` - Interactive mode (where available)

---

## 📦 Core Trading Scripts

### Individual Trades

#### `createTrade.js` - Create Single NFT Trade
Create an individual trade for a single NFT.

**Usage:**
```bash
node createTrade.js 0.0.LST
```

**Features:**
- Interactive NFT selection
- Price setting (HBAR + LAZY)
- Buyer specification (open market or specific buyer)
- Expiry time configuration
- Automatic ownership verification
- LSH benefit checking (free trades for LSH holders)

---

#### `executeTrade.js` - Buy Single NFT
Execute/purchase a single NFT trade.

**Usage:**
```bash
# Interactive mode
node executeTrade.js 0.0.LST -i

# Direct hash mode
node executeTrade.js 0.0.LST <tradeHash>
```

**Features:**
- Trade validation and details display
- Balance checking (HBAR + LAZY)
- Automatic allowance setting
- Token association if needed
- Payment processing

---

#### `cancelTrade.js` - Cancel Single Trade
Cancel an individual trade (seller or buyer only).

**Usage:**
```bash
# Interactive mode
node cancelTrade.js 0.0.LST -i

# Direct hash mode
node cancelTrade.js 0.0.LST <tradeHash>
```

**Features:**
- Trade ownership verification
- Trade details confirmation
- Instant cancellation

---

### Batch Trades

Batch trades are **atomic** - all NFTs must be purchased together or the transaction fails.

#### `createBatchTrade.js` - Create Atomic Batch Trade
Create a batch trade containing multiple NFTs that must be sold together.

**Usage:**
```bash
node createBatchTrade.js 0.0.LST
```

**Features:**
- Interactive guided setup
- Multiple token types support (max 10 different collections)
- Up to 22 total NFTs per batch
- Individual pricing per NFT
- Ownership verification for all NFTs
- Automatic allowance management
- LSH benefit integration

**Batch Trade Benefits:**
- Atomic execution (all NFTs sold together)
- Single transaction reduces gas costs
- Simplified payment process for buyers
- Bundle pricing strategies

---

#### `executeBatchTrade.js` - Buy Complete Batch
Purchase an entire batch trade atomically.

**Usage:**
```bash
node executeBatchTrade.js 0.0.LST <batchId>
```

**Features:**
- Comprehensive batch details display
- Total cost calculation
- Balance and allowance management
- Token association for all NFTs
- Atomic purchase execution

---

#### `cancelBatchTrade.js` - Cancel Batch Trade
Cancel a batch trade (seller only).

**Usage:**
```bash
node cancelBatchTrade.js 0.0.LST <batchId>
```

**Features:**
- Seller-only restriction enforcement
- Batch contents display
- Clean batch removal
- NFTs returned to individual availability

---

### Multiple Independent Trades

Create multiple independent trades in a single transaction - **not atomic** (buyers can purchase individually).

#### `createMultipleTrades.js` - Create Multiple Individual Trades
Create multiple independent trades efficiently.

**Usage:**
```bash
node createMultipleTrades.js 0.0.LST
```

**Features:**
- Up to 50 individual trades per transaction
- Multiple token types support
- Independent pricing per NFT
- Trades can be purchased separately
- Gas-efficient batch creation
- LSH benefit checking

---

#### `cancelTrades.js` - Cancel Multiple Trades
Cancel multiple individual trades in one transaction.

**Usage:**
```bash
# Interactive mode
node cancelTrades.js 0.0.LST -i

# Direct hash mode
node cancelTrades.js 0.0.LST <hash1> <hash2> <hash3>...
```

**Features:**
- Up to 10 trades per cancellation
- Permission verification for each trade
- Batch cancellation efficiency

---

#### `executeTrades.js` - Buy Multiple Individual Trades
Execute multiple individual trades atomically (max 5 per transaction).

**Usage:**
```bash
# Interactive mode
node executeTrades.js 0.0.LST -i

# Direct hash mode
node executeTrades.js 0.0.LST <hash1> <hash2> <hash3>...
```

**Features:**
- Maximum 5 trades per batch (Hedera subcall limits)
- Total cost calculation across all trades
- Atomic execution (all succeed or all fail)
- Automatic allowance and association management
- Excess HBAR refunding

---

## 🔍 Query & Information Scripts

### Trade Information

#### `getTrade.js` - Get Single Trade Details
Query detailed information about a specific trade.

**Usage:**
```bash
node getTrade.js 0.0.LST <tradeHash>
```

---

#### `getBatchTrade.js` - Get Batch Trade Details
Query detailed information about batch trades.

**Usage:**
```bash
# Single batch
node getBatchTrade.js 0.0.LST <batchId>

# Multiple batches
node getBatchTrade.js 0.0.LST <batchId1> <batchId2>...
```

**Features:**
- Comprehensive batch information
- NFT breakdown by collection
- Price analysis
- Status checking (active/expired)
- Batch vs individual comparison

---

#### `getTradesForUser.js` - Get User's Individual Trades
Get all individual trades for a specific user.

**Usage:**
```bash
# Your trades
node getTradesForUser.js 0.0.LST

# Another user's trades
node getTradesForUser.js 0.0.LST 0.0.USERID
```

---

#### `getUserBatchTrades.js` - Get User's Batch Trades
Get all batch trades for a specific user.

**Usage:**
```bash
# Your batch trades
node getUserBatchTrades.js 0.0.LST

# Another user's batch trades
node getUserBatchTrades.js 0.0.LST 0.0.USERID
```

**Features:**
- Complete batch portfolio overview
- Summary statistics
- Active vs expired breakdown
- Total value calculations

---

### Contract Information

#### `getLazySecureTradeInfo.js` - Contract State Information
Get comprehensive contract state and configuration.

#### `isTradeValid.js` - Validate Trade Status
Check if a trade is valid for execution.

#### `getLiveTradesFromEvents.js` - Live Trade Scanner
Scan for active trades using contract events.

---

## ⚙️ Administrative Scripts

#### `setLazyCostForTrade.js` - Set LAZY Cost
Update the LAZY token cost for creating open market trades (owner only).

#### `setLazyBurnPercentage.js` - Set Burn Percentage  
Update the LAZY token burn percentage (owner only).

---

## 🛠️ Utility Scripts

### Allowance Management

#### `checkLiveFTAllowance.js` - Check Single FT Allowance
Check fungible token allowances for the LazySecureTrade contract.

#### `checkLiveFTAllowances.js` - Check Multiple FT Allowances
Check multiple fungible token allowances at once.

#### `checkNFTAllowanceAllSerials.js` - Check NFT Allowances
Check NFT allowances for all serials of a token.

#### `checkMultiNFTAllowanceAllSerials.js` - Check Multiple NFT Allowances
Check NFT allowances across multiple token collections.

### Delegation & Advanced Features

#### `delegateToken.js` - Delegate Token Benefits
Delegate LSH token benefits to another user.

#### `checkDelegatedToForNFTSerial.js` - Check Delegation Status
Check if LSH benefits are delegated for specific NFT serials.

### Contract Interaction

#### `getContractResultFromMirror.js` - Mirror Node Queries
Query contract call results from Hedera Mirror Node.

#### `secureTradeEventScanner.js` - Event Scanner
Comprehensive event scanning and monitoring.

---

## 🎖️ LSH Token Benefits

### `checkLSHBenefits.js` - Analyze LSH Token Benefits
Comprehensive analysis of your LSH token benefits and fee structure.

**Usage:**
```bash
# Check your benefits
node checkLSHBenefits.js 0.0.LST

# Check another user's benefits
node checkLSHBenefits.js 0.0.LST 0.0.USERID
```

**Features:**
- LSH tier identification (0-3)
- Effective fee rate calculation
- Practical fee examples
- Upgrade benefit analysis
- LAZY cost breakdown

### LSH Tier Structure
- **Tier 0**: No LSH tokens (1% fee + LAZY cost)
- **Tier 1**: LSH Gen2 (0.5% fee + free trades)
- **Tier 2**: LSH Mutant (0.25% fee + free trades)
- **Tier 3**: LSH Gen1 (0% fee + free trades)

---

## 📚 Usage Examples

### Create and Execute Individual Trade
```bash
# 1. Create a trade
node createTrade.js 0.0.123456

# 2. Someone executes the trade
node executeTrade.js 0.0.123456 -i
```

### Create and Execute Batch Trade
```bash
# 1. Create batch trade
node createBatchTrade.js 0.0.123456

# 2. Someone buys the entire batch
node executeBatchTrade.js 0.0.123456 <batchId>
```

### Bulk Operations
```bash
# Create 20 individual trades efficiently
node createMultipleTrades.js 0.0.123456

# Buy 5 specific trades at once
node executeTrades.js 0.0.123456 0xhash1... 0xhash2... 0xhash3...

# Cancel multiple trades
node cancelTrades.js 0.0.123456 -i
```

### Portfolio Management
```bash
# Check all your trades
node getTradesForUser.js 0.0.123456

# Check all your batch trades
node getUserBatchTrades.js 0.0.123456

# Analyze your LSH benefits
node checkLSHBenefits.js 0.0.123456
```

---

## 🌐 Environment Setup

### Network Configuration
The scripts automatically detect your environment from the `.env` file:

- **TEST**: Hedera Testnet
- **MAIN**: Hedera Mainnet  
- **PREVIEW**: Hedera Previewnet
- **LOCAL**: Local development network

### Required Environment Variables
```bash
# Network and Account
ENVIRONMENT=test
ACCOUNT_ID=0.0.123456
PRIVATE_KEY=302e020100300506032b657004220420...

# Contract Addresses
LAZY_TOKEN_ID=0.0.234567
LAZY_GAS_STATION_CONTRACT_ID=0.0.345678
LAZY_DELEGATE_REGISTRY_CONTRACT_ID=0.0.456789

# Optional (for contract reuse)
LAZY_SECURE_TRADE_CONTRACT_ID=0.0.567890
```

---

## 🚨 Important Notes

### Gas Limits
- **Individual trades**: ~200-400k gas
- **Batch trades**: ~800k + (50k × NFT count)
- **Multiple trades**: ~500k + (80k × trade count)

### Batch Limits
- **Batch trades**: Max 22 NFTs (atomic)
- **Execute trades**: Max 5 trades (atomic)
- **Multiple trades**: Max 50 trades (independent)
- **Cancel trades**: Max 10 trades

### Fee Structure
- **HBAR trades**: Platform fees apply (reduced by LSH tiers)
- **LAZY trades**: No platform fees
- **Private trades**: No platform fees
- **Open market**: LAZY cost for creation (free with LSH)

### Allowances
All scripts automatically manage required allowances:
- HBAR allowances for payments
- LAZY allowances for payments and gas
- NFT allowances for transfers

---

## 🆘 Troubleshooting

### Common Issues
1. **Insufficient balance**: Scripts check balances before execution
2. **Missing allowances**: Scripts set allowances automatically
3. **Token not associated**: Scripts associate tokens when needed
4. **Expired trades**: Scripts validate expiry times
5. **Permission denied**: Scripts verify ownership/permissions

### Getting Help
- Use `-h` flag with any script for specific help
- Check the `.env` file configuration
- Ensure contract addresses are correct for your network
- Verify account has sufficient HBAR for gas

---

## 🔄 Script Categories Summary

| Category | Scripts | Purpose |
|----------|---------|---------|
| **Individual Trades** | `createTrade.js`, `executeTrade.js`, `cancelTrade.js` | Single NFT trading |
| **Batch Trades** | `createBatchTrade.js`, `executeBatchTrade.js`, `cancelBatchTrade.js` | Atomic multi-NFT bundles |
| **Bulk Operations** | `createMultipleTrades.js`, `executeTrades.js`, `cancelTrades.js` | Efficient bulk trading |
| **Information** | `getTrade.js`, `getBatchTrade.js`, `getUserBatchTrades.js`, etc. | Query trade data |
| **Utilities** | `checkLSHBenefits.js`, allowance scripts, delegation scripts | Helper functions |
| **Admin** | `setLazyCostForTrade.js`, `setLazyBurnPercentage.js` | Contract management |

---

*For the latest updates and contract addresses, check the main project README and `.env.example` file.*