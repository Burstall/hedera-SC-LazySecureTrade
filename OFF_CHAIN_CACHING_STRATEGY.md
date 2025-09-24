# LazySecureTrade Off-Chain Caching Strategy

## Overview

This document provides a comprehensive guide for building an off-chain cache of the LazySecureTrade contract state using event-driven architecture. The cache enables fast UI rendering while maintaining consistency with on-chain data through real-time event monitoring.

**Reference Implementation**: See `scripts/interactions/secureTradeEventScanner.js` for a complete working example that demonstrates all concepts in this document.

## Prerequisites

- **Ethers.js v6**: All examples use Ethers v6 syntax
- **Hedera Mirror Node**: Primary source for event data via REST API
- **Database**: For persistent caching (examples show both SQL and Directus patterns)
- **Node.js**: Runtime environment for the scanning infrastructure

## Core Principles

### 1. Event-Driven Architecture
- **Primary Source**: Smart contract events are the authoritative source for state changes
- **Real-Time Updates**: Cache responds immediately to emitted events
- **Consistency**: Event ordering ensures cache matches contract state
- **Validation**: Critical operations still validate against live contract data

### 2. Trade Uniqueness
- **Single Trade Per NFT**: Each `keccak256(token + serial)` can have only one active trade
- **Overwrite Behavior**: Creating a new trade for the same NFT overwrites the previous one
- **Automatic Cleanup**: Contract emits proper cancel events when trades are overwritten

## Contract ABI Definitions

For all implementations, you'll need the contract ABI. Here's the essential event definitions:

```javascript
// Ethers v6 Interface setup
const { ethers } = require('ethers');

const lazySecureTradeABI = [
  // v0.1 Core Events
  'event TradeCreated(address indexed seller, address indexed buyer, address indexed token, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime, uint256 nonce)',
  'event TradeCancelled(address indexed seller, address indexed token, uint256 serial, uint256 nonce)', 
  'event TradeCompleted(address indexed seller, address indexed buyer, address indexed token, uint256 serial, uint256 nonce)',
  
  // v0.2 Batch Trade Events
  'event BatchTradeCreated(bytes32 indexed batchId, address indexed seller, address indexed buyer, uint256 itemCount, uint256 totalTinybarPrice, uint256 totalLazyPrice)',
  'event BatchTradeExecuted(bytes32 indexed batchId, address indexed buyer, uint256 itemCount, uint256 totalTinybarPrice, uint256 totalLazyPrice)',
  'event BatchTradeCancelled(bytes32 indexed batchId, address indexed canceller, uint256 itemCount)',
  
  // v0.2 Multiple Operation Events  
  'event MultipleTradesCreated(address indexed seller, address indexed buyer, uint256 successCount, uint256 totalLazyCost)',
  'event MultipleTradesExecuted(address indexed buyer, uint256 executedCount, uint256 failedCount, uint256 totalHbarUsed)',
  'event MultipleTradesCancelled(address indexed canceller, uint256 cancelledCount)',
  
  // v0.2 Token Association Events
  'event TokenAssociationBatch(address[] tokens, uint256 associationCount, uint256 gasCost)'
];

const contractInterface = new ethers.Interface(lazySecureTradeABI);
```

## Hedera Mirror Node Integration

The reference implementation (`secureTradeEventScanner.js`) demonstrates fetching events from Hedera Mirror Node:

```javascript
// Mirror Node URLs by environment
function getBaseURL(environment) {
  switch (environment) {
    case 'mainnet': return 'https://mainnet-public.mirrornode.hedera.com';
    case 'testnet': return 'https://testnet.mirrornode.hedera.com'; 
    case 'previewnet': return 'https://previewnet.mirrornode.hedera.com';
    case 'local': return 'http://localhost:5551';
    default: throw new Error(`Unknown environment: ${environment}`);
  }
}

// Fetch events with pagination
async function getEventsFromMirror(contractId, lastTimestamp) {
  const baseUrl = getBaseURL(process.env.HEDERA_NETWORK);
  let url = lastTimestamp 
    ? `${baseUrl}/api/v1/contracts/${contractId}/results/logs?order=asc&limit=100&timestamp=gt:${lastTimestamp}`
    : `${baseUrl}/api/v1/contracts/${contractId}/results/logs?order=asc&limit=100`;
    
  const allEvents = [];
  
  do {
    const response = await axios.get(url);
    const jsonResponse = response.data;
    
    // Process each log entry
    jsonResponse.logs.forEach(log => {
      if (log.data === '0x') return; // Skip empty logs
      
      try {
        const event = contractInterface.parseLog({ 
          topics: log.topics, 
          data: log.data 
        });
        event.timestamp = log.timestamp;
        event.transactionHash = log.transaction_hash;
        allEvents.push(event);
      } catch (error) {
        console.warn('Failed to parse log:', error);
      }
    });
    
    url = jsonResponse.links?.next ? `${baseUrl}${jsonResponse.links.next}` : null;
  } while (url);
  
  return allEvents;
}
```

## Event Categories & Workflows

### 1. Individual Trade Events

#### TradeCreated Event
```solidity
event TradeCreated(
    address indexed seller,
    address indexed buyer,
    address indexed token,
    uint256 serial,
    uint256 tinybarPrice,
    uint256 lazyPrice,
    uint256 expiryTime,
    uint256 nonce
);
```

**When Emitted:**
- Creating a new trade via `createTrade()`
- Creating trades via `createMultipleTrades()` (one event per successful trade)
- **Important**: Also emitted when overwriting existing trades

**Cache Actions:**
```javascript
contract.on('TradeCreated', (seller, buyer, token, serial, tinybarPrice, lazyPrice, expiryTime, nonce) => {
  const tradeId = keccak256(token + serial);
  
  // Upsert trade data
  cache.setTrade(tradeId, {
    seller,
    buyer,
    token,
    serial,
    tinybarPrice,
    lazyPrice,
    expiryTime,
    nonce,
    status: 'active'
  });
  
  // Update discovery indexes
  cache.addToUserTrades(seller, tradeId);
  
  if (buyer !== ZERO_ADDRESS) {
    // Private trade
    cache.addToUserTrades(buyer, tradeId);
    cache.removeFromTokenTrades(token, tradeId); // In case it was open before
  } else {
    // Open market trade
    cache.addToTokenTrades(token, tradeId);
    // Remove from any specific buyer's trades in case it was private before
  }
});
```

#### TradeCancelled Event
```solidity
event TradeCancelled(
    address indexed seller,
    address indexed token,
    uint256 serial,
    uint256 nonce
);
```

**When Emitted:**
- Explicit cancellation via `cancelTrade()` or `cancelMultipleTrades()`
- **Automatic cancellation** when any existing trade is overwritten (price changes, buyer changes, etc.)
- Bulk cancellation operations

**Cache Actions:**
```javascript
contract.on('TradeCancelled', (seller, token, serial, nonce) => {
  const tradeId = keccak256(token + serial);
  
  // Get trade data before removal for cleanup
  const trade = cache.getTrade(tradeId);
  if (!trade) return; // Already removed
  
  // Remove from all indexes
  cache.removeFromUserTrades(trade.seller, tradeId);
  if (trade.buyer !== ZERO_ADDRESS) {
    cache.removeFromUserTrades(trade.buyer, tradeId);
  } else {
    cache.removeFromTokenTrades(trade.token, tradeId);
  }
  
  // Remove trade data
  cache.removeTrade(tradeId);
});
```

#### TradeCompleted Event
```solidity
event TradeCompleted(
    address indexed seller,
    address indexed buyer,
    address indexed token,
    uint256 serial,
    uint256 nonce
);
```

**When Emitted:**
- Successful trade execution via `executeTrade()` or `sweepTrades()`
- Batch trade execution (one event per NFT in batch)

**Cache Actions:**
```javascript
contract.on('TradeCompleted', (seller, buyer, token, serial, nonce) => {
  const tradeId = keccak256(token + serial);
  
  // Same cleanup as TradeCancelled
  const trade = cache.getTrade(tradeId);
  if (!trade) return;
  
  // Update indexes
  cache.removeFromUserTrades(trade.seller, tradeId);
  if (trade.buyer !== ZERO_ADDRESS) {
    cache.removeFromUserTrades(trade.buyer, tradeId);
  } else {
    cache.removeFromTokenTrades(trade.token, tradeId);
  }
  
  // Archive completed trade (optional - for analytics)
  cache.archiveCompletedTrade(tradeId, { ...trade, completedBy: buyer, completedAt: new Date() });
  
  // Remove active trade
  cache.removeTrade(tradeId);
});
```

### 2. Batch Trade Events

#### BatchTradeCreated Event
```solidity
event BatchTradeCreated(
    bytes32 indexed batchId,
    address indexed seller,
    address indexed buyer,
    uint256 itemCount,
    uint256 totalTinybarPrice,
    uint256 totalLazyPrice
);
```

**When Emitted:**
- Creating atomic batch trades via `createBatchTrade()`

**Cache Actions:**
```javascript
contract.on('BatchTradeCreated', (batchId, seller, buyer, itemCount, totalTinybarPrice, totalLazyPrice) => {
  // Store batch trade metadata
  cache.setBatchTrade(batchId, {
    seller,
    buyer,
    itemCount,
    totalTinybarPrice,
    totalLazyPrice,
    status: 'active'
  });
  
  // Update user indexes
  cache.addToUserBatchTrades(seller, batchId);
  if (buyer !== ZERO_ADDRESS) {
    cache.addToUserBatchTrades(buyer, batchId);
  }
  
  // Note: Individual items are retrieved via contract call when needed
  // This reduces event complexity and gas costs
});
```

#### BatchTradeExecuted Event
```solidity
event BatchTradeExecuted(
    bytes32 indexed batchId,
    address indexed buyer,
    uint256 itemCount,
    uint256 totalTinybarPrice,
    uint256 totalLazyPrice
);
```

**Cache Actions:**
```javascript
contract.on('BatchTradeExecuted', (batchId, buyer, itemCount, totalTinybarPrice, totalLazyPrice) => {
  const batchTrade = cache.getBatchTrade(batchId);
  if (!batchTrade) return;
  
  // Clean up indexes
  cache.removeFromUserBatchTrades(batchTrade.seller, batchId);
  if (batchTrade.buyer !== ZERO_ADDRESS) {
    cache.removeFromUserBatchTrades(batchTrade.buyer, batchId);
  }
  
  // Archive and remove
  cache.archiveCompletedBatchTrade(batchId, { ...batchTrade, executedBy: buyer });
  cache.removeBatchTrade(batchId);
});
```

#### BatchTradeCancelled Event
```solidity
event BatchTradeCancelled(
    bytes32 indexed batchId,
    address indexed canceller,
    uint256 itemCount
);
```

**Cache Actions:**
```javascript
contract.on('BatchTradeCancelled', (batchId, canceller, itemCount) => {
  const batchTrade = cache.getBatchTrade(batchId);
  if (!batchTrade) return;
  
  // Same cleanup as BatchTradeExecuted
  cache.removeFromUserBatchTrades(batchTrade.seller, batchId);
  if (batchTrade.buyer !== ZERO_ADDRESS) {
    cache.removeFromUserBatchTrades(batchTrade.buyer, batchId);
  }
  
  cache.removeBatchTrade(batchId);
});
```

### 3. Multiple Operation Events

#### MultipleTradesCreated Event
```solidity
event MultipleTradesCreated(
    address indexed seller,
    address indexed buyer,
    uint256 successCount,
    uint256 totalLazyCost
);
```

**When Emitted:**
- Bulk individual trade creation via `createMultipleTrades()`

**Cache Actions:**
```javascript
contract.on('MultipleTradesCreated', (seller, buyer, successCount, totalLazyCost) => {
  // This is a summary event - individual TradeCreated events handle the actual cache updates
  // Can be used for analytics or progress tracking
  cache.recordBulkOperation('multiple_trades_created', {
    seller,
    buyer,
    successCount,
    totalLazyCost,
    timestamp: new Date()
  });
});
```

#### MultipleTradesExecuted Event
```solidity
event MultipleTradesExecuted(
    address indexed buyer,
    uint256 executedCount,
    uint256 failedCount,
    uint256 totalHbarUsed
);
```

**Cache Actions:**
```javascript
contract.on('MultipleTradesExecuted', (buyer, executedCount, failedCount, totalHbarUsed) => {
  // Summary event - individual TradeCompleted events handle cache updates
  cache.recordBulkOperation('sweep_executed', {
    buyer,
    executedCount,
    failedCount,
    totalHbarUsed,
    timestamp: new Date()
  });
});
```

#### MultipleTradesCancelled Event
```solidity
event MultipleTradesCancelled(
    address indexed canceller,
    uint256 cancelledCount
);
```

**Cache Actions:**
```javascript
contract.on('MultipleTradesCancelled', (canceller, cancelledCount) => {
  // Summary event - individual TradeCancelled events handle cache updates
  cache.recordBulkOperation('bulk_cancellation', {
    canceller,
    cancelledCount,
    timestamp: new Date()
  });
});
```

## Critical Workflow: Trade Overwriting

**Core Principle**: Any time a trade already exists for an NFT and a new trade is created, the contract ALWAYS emits `TradeCancelled` followed by `TradeCreated`. This ensures perfect off-chain consistency regardless of what changed.

### Scenario 1: Open Market → Private Trade
```javascript
// User changes from open market to private trade (different buyer)
// Events emitted in order:
// 1. TradeCancelled (for old open market trade)
// 2. TradeCreated (for new private trade)
```

### Scenario 2: Private Trade → Open Market  
```javascript
// User changes from private to open market
// Events emitted in order:
// 1. TradeCancelled (for old private trade)
// 2. TradeCreated (for new open market trade)
```

### Scenario 3: Price Change (Same Buyer Type)
```javascript
// User changes price on existing open market trade
// Events emitted in order:
// 1. TradeCancelled (for old trade at old price)
// 2. TradeCreated (for new trade at new price)
```

### Scenario 4: Private Buyer Change
```javascript
// User changes from private trade to User A → private trade to User B
// Events emitted in order:
// 1. TradeCancelled (for old trade to User A)
// 2. TradeCreated (for new trade to User B)
```

**Cache Implementation**: All scenarios are handled identically:
```javascript
contract.on('TradeCancelled', handleTradeCancelled);  // Always removes old trade
contract.on('TradeCreated', handleTradeCreated);      // Always adds new trade
```

## Cache Implementation Strategies

### 1. Database Schema

#### Individual Trades Table
```sql
CREATE TABLE trades (
    trade_id VARCHAR(66) PRIMARY KEY,
    seller VARCHAR(42) NOT NULL,
    buyer VARCHAR(42), -- NULL for open market
    token VARCHAR(42) NOT NULL,
    serial BIGINT NOT NULL,
    tinybar_price BIGINT NOT NULL,
    lazy_price BIGINT NOT NULL,
    expiry_time BIGINT,
    nonce BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(token, serial)
);

-- Indexes for fast discovery
CREATE INDEX idx_trades_seller ON trades(seller);
CREATE INDEX idx_trades_buyer ON trades(buyer) WHERE buyer IS NOT NULL;
CREATE INDEX idx_trades_token_open ON trades(token) WHERE buyer IS NULL;
CREATE INDEX idx_trades_token_serial ON trades(token, serial);
```

#### Batch Trades Table
```sql
CREATE TABLE batch_trades (
    batch_id VARCHAR(66) PRIMARY KEY,
    seller VARCHAR(42) NOT NULL,
    buyer VARCHAR(42), -- NULL for open market
    item_count INTEGER NOT NULL,
    total_tinybar_price BIGINT NOT NULL,
    total_lazy_price BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_batch_trades_seller ON batch_trades(seller);
CREATE INDEX idx_batch_trades_buyer ON batch_trades(buyer) WHERE buyer IS NOT NULL;
```

### 2. In-Memory Cache (Redis/Similar)

```javascript
class LazySecureTradeCache {
  // Core data structures
  trades = new Map();           // tradeId -> trade data
  batchTrades = new Map();      // batchId -> batch data
  
  // Discovery indexes
  userTrades = new Map();       // userAddress -> Set(tradeIds)
  tokenTrades = new Map();      // tokenAddress -> Set(tradeIds) (open market only)
  userBatchTrades = new Map();  // userAddress -> Set(batchIds)
  
  // Event handlers
  async handleTradeCreated(event) {
    const { seller, buyer, token, serial, tinybarPrice, lazyPrice, expiryTime, nonce } = event.args;
    const tradeId = keccak256(abiCoder.encode(['address', 'uint256'], [token, serial]));
    
    // Update core data
    this.trades.set(tradeId, {
      seller, buyer, token, serial,
      tinybarPrice: tinybarPrice.toString(),
      lazyPrice: lazyPrice.toString(),
      expiryTime: expiryTime.toString(),
      nonce: nonce.toString(),
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash
    });
    
    // Update indexes
    this.addToUserTrades(seller, tradeId);
    
    if (buyer !== ZERO_ADDRESS) {
      this.addToUserTrades(buyer, tradeId);
      this.removeFromTokenTrades(token, tradeId); // Clean up in case it was open
    } else {
      this.addToTokenTrades(token, tradeId);
    }
  }
  
  async handleTradeCancelled(event) {
    const { seller, token, serial, nonce } = event.args;
    const tradeId = keccak256(abiCoder.encode(['address', 'uint256'], [token, serial]));
    
    const trade = this.trades.get(tradeId);
    if (!trade) return;
    
    // Clean up indexes
    this.removeFromUserTrades(trade.seller, tradeId);
    if (trade.buyer !== ZERO_ADDRESS) {
      this.removeFromUserTrades(trade.buyer, tradeId);
    } else {
      this.removeFromTokenTrades(trade.token, tradeId);
    }
    
    // Remove trade data
    this.trades.delete(tradeId);
  }
  
  // Helper methods
  addToUserTrades(user, tradeId) {
    if (!this.userTrades.has(user)) {
      this.userTrades.set(user, new Set());
    }
    this.userTrades.get(user).add(tradeId);
  }
  
  removeFromUserTrades(user, tradeId) {
    const userTradeSet = this.userTrades.get(user);
    if (userTradeSet) {
      userTradeSet.delete(tradeId);
      if (userTradeSet.size === 0) {
        this.userTrades.delete(user);
      }
    }
  }
  
  addToTokenTrades(token, tradeId) {
    if (!this.tokenTrades.has(token)) {
      this.tokenTrades.set(token, new Set());
    }
    this.tokenTrades.get(token).add(tradeId);
  }
  
  removeFromTokenTrades(token, tradeId) {
    const tokenTradeSet = this.tokenTrades.get(token);
    if (tokenTradeSet) {
      tokenTradeSet.delete(tradeId);
      if (tokenTradeSet.size === 0) {
        this.tokenTrades.delete(token);
      }
    }
  }
}
```

## Query Patterns

### 1. Get Open Market Trades for Token
```javascript
async function getOpenMarketTrades(tokenAddress) {
  const tradeIds = cache.tokenTrades.get(tokenAddress) || new Set();
  return Array.from(tradeIds).map(tradeId => cache.trades.get(tradeId));
}
```

### 2. Get User's Active Trades
```javascript
async function getUserTrades(userAddress) {
  const tradeIds = cache.userTrades.get(userAddress) || new Set();
  return Array.from(tradeIds).map(tradeId => cache.trades.get(tradeId));
}
```

### 3. Get Specific Trade
```javascript
async function getTrade(tokenAddress, serial) {
  const tradeId = keccak256(abiCoder.encode(['address', 'uint256'], [tokenAddress, serial]));
  return cache.trades.get(tradeId);
}
```

## Error Handling & Recovery

### 1. Missing Events
```javascript
async function validateCacheConsistency() {
  // Periodically validate critical trades against live contract
  const randomTradeIds = cache.getRandomSample(100);
  
  for (const tradeId of randomTradeIds) {
    const cached = cache.trades.get(tradeId);
    const live = await contract.getTrade(tradeId);
    
    if (live.seller === ZERO_ADDRESS && cached) {
      // Trade was cancelled but we missed the event
      console.warn(`Missing cancel event for trade ${tradeId}`);
      await handleTradeCancelled({ args: { token: cached.token, serial: cached.serial }});
    } else if (live.seller !== ZERO_ADDRESS && !cached) {
      // Trade exists but we missed the creation
      console.warn(`Missing creation event for trade ${tradeId}`);
      // Re-sync this trade
    }
  }
}
```

### 2. Chain Reorganization
```javascript
async function handleReorg(oldBlocks, newBlocks) {
  // Remove events from old blocks
  for (const block of oldBlocks) {
    await removeEventsFromBlock(block.number);
  }
  
  // Re-process events from new blocks
  for (const block of newBlocks) {
    await processEventsFromBlock(block.number);
  }
}
```

## Performance Considerations

### 1. Event Filtering
```javascript
// Use specific event signatures for faster filtering
const tradeCreatedFilter = contract.filters.TradeCreated();
const tradeCancelledFilter = contract.filters.TradeCancelled();
const tradeCompletedFilter = contract.filters.TradeCompleted();
```

### 2. Batch Processing
```javascript
async function processPendingEvents() {
  const events = await contract.queryFilter(allFilters, lastProcessedBlock + 1, 'latest');
  
  // Group events by type for efficient processing
  const groupedEvents = events.reduce((acc, event) => {
    acc[event.event] = acc[event.event] || [];
    acc[event.event].push(event);
    return acc;
  }, {});
  
  // Process in dependency order
  await Promise.all([
    groupedEvents.TradeCancelled?.map(handleTradeCancelled),
    groupedEvents.TradeCreated?.map(handleTradeCreated),
    groupedEvents.TradeCompleted?.map(handleTradeCompleted)
  ]);
}
```

## Address Mapping for Hedera

When working with Hedera, you'll need to convert between EVM addresses and Hedera account IDs:

```javascript
// Example from secureTradeEventScanner.js
const evmToHederaMap = new Map();
evmToHederaMap.set(ethers.ZeroAddress, '0.0.0');

async function convertEvmToHedera(evmAddress) {
  if (evmToHederaMap.has(evmAddress)) {
    return evmToHederaMap.get(evmAddress);
  }
  
  const mirrorUrl = getBaseURL();
  const url = `${mirrorUrl}/api/v1/accounts/${evmAddress}`;
  
  try {
    const response = await axios.get(url);
    const hederaAccount = response.data.account;
    evmToHederaMap.set(evmAddress, hederaAccount);
    return hederaAccount;
  } catch (error) {
    console.error('Failed to convert EVM address:', evmAddress, error);
    throw error;
  }
}

// Convert token addresses to Hedera token IDs
function convertTokenAddress(evmAddress) {
  return TokenId.fromSolidityAddress(evmAddress).toString();
}
```

## Production Considerations

### 1. Database Schema for v0.2
The reference implementation uses Directus, but here's the recommended SQL schema:

```sql
-- Individual Trades (v0.1 + v0.2)
CREATE TABLE secure_trades_cache (
    id SERIAL PRIMARY KEY,
    trade_contract VARCHAR(20) NOT NULL, -- Hedera contract ID
    hash VARCHAR(66) NOT NULL,           -- keccak256(token + serial)
    seller VARCHAR(20) NOT NULL,         -- Hedera account ID
    buyer VARCHAR(20),                   -- NULL for open market
    token VARCHAR(20) NOT NULL,          -- Hedera token ID
    serial BIGINT NOT NULL,
    tinybar_price BIGINT NOT NULL,
    lazy_price BIGINT NOT NULL,
    expiry_time BIGINT,
    nonce BIGINT NOT NULL,
    environment VARCHAR(20) NOT NULL,    -- mainnet/testnet/previewnet
    completed BOOLEAN DEFAULT FALSE,
    cancelled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(trade_contract, environment, token, serial)
);

-- v0.2 NEW: Batch Trades
CREATE TABLE batch_trades_cache (
    id SERIAL PRIMARY KEY,
    trade_contract VARCHAR(20) NOT NULL,
    batch_id VARCHAR(66) NOT NULL,
    seller VARCHAR(20) NOT NULL,
    buyer VARCHAR(20),
    item_count INTEGER NOT NULL,
    total_tinybar_price BIGINT NOT NULL,
    total_lazy_price BIGINT NOT NULL,
    environment VARCHAR(20) NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    cancelled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- v0.2 NEW: Event Processing Status
CREATE TABLE secure_trade_events (
    id SERIAL PRIMARY KEY,
    trade_contract VARCHAR(20) NOT NULL,
    environment VARCHAR(20) NOT NULL,
    last_timestamp BIGINT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(trade_contract, environment)
);
```

### 2. Environment Configuration
```javascript
// Environment setup (from .env file)
const config = {
  SECURE_TRADE_ENV: process.env.SECURE_TRADE_ENV, // mainnet/testnet/previewnet
  LAZY_SECURE_TRADE_CONTRACT_ID: process.env.LAZY_SECURE_TRADE_CONTRACT_ID,
  DIRECTUS_DB_URL: process.env.DIRECTUS_DB_URL,
  DIRECTUS_TOKEN: process.env.DIRECTUS_TOKEN,
  SECURE_TRADE_EVENTS_TABLE: process.env.SECURE_TRADE_EVENTS_TABLE || 'secureTradeEvents',
  SECURE_TRADE_CACHE_TABLE: process.env.SECURE_TRADE_CACHE_TABLE || 'SecureTradesCache'
};
```

### 3. Complete Working Example
See `scripts/interactions/secureTradeEventScanner.js` for a production-ready implementation that includes:

- ✅ All v0.2 event types with proper ABI definitions
- ✅ Incremental scanning with timestamp persistence
- ✅ Batch processing for database operations
- ✅ Error handling and retry logic
- ✅ EVM to Hedera address conversion
- ✅ Environment-specific configuration
- ✅ Trade overwrite detection and cleanup
- ✅ Comprehensive logging with suppression options

## Summary

This event-driven caching strategy provides:

1. **Real-time Consistency**: Cache updates immediately as events are emitted
2. **Complete Coverage**: All contract state changes are captured through events
3. **Efficient Discovery**: Indexed data structures enable fast queries
4. **Trade Overwrite Handling**: Automatic cleanup ensures cache consistency when trades are overwritten
5. **Scalable Architecture**: Can handle high-volume trading with proper indexing
6. **Production Ready**: Reference implementation handles all edge cases and environments

The key insight is that the contract's event system is designed specifically to support this caching pattern, with automatic `TradeCancelled` events ensuring off-chain systems never have stale data when trades are overwritten.

**Next Steps**: 
1. Use the reference scanner as a starting point
2. Adapt the database schema to your preferred database system  
3. Implement the cache query patterns for your UI needs
4. Set up monitoring and alerting for the scanning process