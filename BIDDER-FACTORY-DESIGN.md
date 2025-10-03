# BidderContractFactory v0.3 - Complete Architecture Design

**Date**: October 2, 2025  
**Status**: Design Phase - Pre-Implementation  
**Foundation**: Built on LazySecureTrade v0.2 proven infrastructure

## 🎯 Core Architecture Overview

### **Design Philosophy**
- **Reuse LazySecureTrade infrastructure** - No reinventing proven patterns
- **Event consistency** - All trades flow through LazySecureTrade for unified event tracking
- **User sovereignty** - Individual BidderContract honeypots with user-controlled extraction
- **Factory administration** - Admin rights for arbitrage profit extraction only
- **Simplicity over complexity** - One bid per executable unit, clean design patterns

### **Component Relationships**
```
EOAs ←→ BidderContractFactory ←→ LazySecureTrade (Trade Creation/Execution)
           ↓                              ↓
    BidderContract[] (Honeypots)     Event Tracking & Fees
           ↓
    TokenStakerV2 (NFT Withdrawal)
```

---

## 🏗️ Detailed Component Design

### **1. BidderContractFactory.sol (Central Router)**

#### **Core Responsibilities**
- **Contract deployment**: Clone BidderContracts via minimal proxy pattern
- **Bid registry**: Central discovery point for CLOB-style bidding
- **Trade orchestration**: Create trades in LazySecureTrade then execute via BidderContract
- **Arbitrage facilitation**: Enable 3rd party arbitrage with profit sharing
- **Event grouping**: Emit factory-level events for unified tracking

#### **Key Mappings & Storage**
```solidity
// User to BidderContract mapping (1:1 relationship)
mapping(address => address) public userToBidderContract;

// Token-based bid discovery (CLOB efficiency)
mapping(address => bytes32[]) public tokenToBids;

// Bid registry (core bid storage)
mapping(bytes32 => BidDetails) public bidRegistry;

// Factory pattern tracking
mapping(address => bool) public isValidBidderContract;
address[] public allBidderContracts;
```

#### **BidDetails Structure**
```solidity
struct BidDetails {
    address user;                    // Original bidder (owner of BidderContract)
    address bidderContract;          // Specific BidderContract address
    uint256 hbarAmount;              // HBAR bid amount
    uint256 lazyAmount;              // $LAZY bid amount  
    uint256 expiry;                  // Block timestamp expiry
    address token;                   // Target NFT collection
    uint256[] serials;               // Empty array = any serial, specific serials = exact match
    uint256 bidderContractNonce;     // BidderContract internal nonce for uniqueness
    uint256 createdAt;               // Creation timestamp
    // Note: No isActive bool - bid existence in registry indicates active status
    // Executed bids are removed from registry for gas efficiency
}
```

#### **Core Functions**

##### **Deployment & Registry**
```solidity
// Deploy user's BidderContract (one per user)
function deployBidderContract() external returns (address bidderContract);

// Check if user has BidderContract
function getUserBidderContract(address user) external view returns (address);
```

##### **Bid Management**
```solidity
// Create bid (called by user via their BidderContract)
function createBid(BidDetails memory bidDetails) external returns (bytes32 bidId);

// Cancel bid
function cancelBid(bytes32 bidId) external;

// Get bids for token (CLOB discovery)
function getBidsForToken(address token) external view returns (bytes32[] memory);

// Validate bid (expiry + fund check)
function isBidValid(bytes32 bidId) external view returns (bool valid, string memory reason);
```

##### **Trade Execution (Core Integration)**
```solidity
// Seller executes against bid (creates trade then executes)
function executeAgainstBid(
    bytes32 bidId,
    address nftToken,
    uint256 serial
    // Note: Removed 'amount' parameter - NFTs are 1:1, not applicable for current design
    // Future FT support would use separate function signatures
) external returns (bytes32 tradeId);

// 3rd party arbitrage execution
function executeArbitrage(
    bytes32 bidId,
    bytes32 existingTradeId
) external returns (bool success, uint256 arbitrageProfit);
```

##### **Discovery & Analytics**
```solidity
// Get all bids for specific token (paginated for future-proofing)
function getBidsForToken(address token) external view returns (bytes32[] memory);
function getBidsForToken(address token, uint256 offset, uint256 limit) external view returns (bytes32[] memory);

// Get all bids for specific token/serial combination
function getBidsForTokenSerial(address token, uint256 serial) external view returns (bytes32[] memory);
function getBidsForTokenSerial(address token, uint256 serial, uint256 offset, uint256 limit) external view returns (bytes32[] memory);

// Get all bids across all tokens (admin/analytics function)
function getAllBids() external view returns (bytes32[] memory);
function getAllBids(uint256 offset, uint256 limit) external view returns (bytes32[] memory);

// Get user's active bids
function getUserBids(address user) external view returns (bytes32[] memory);

// Tie-breaking for same price bids using IPRNG
function selectBestBid(bytes32[] memory samePriceBids) internal returns (bytes32);

// Get total bid count for analytics
function getTotalBidCount() external view returns (uint256);
function getTokenBidCount(address token) external view returns (uint256);
```

---

### **2. BidderContract.sol (User Honeypot)**

#### **Core Responsibilities**
- **Fund custody**: Hold user's HBAR and $LAZY for bidding
- **Token association**: Manage associated tokens for NFT reception
- **Trade execution**: Execute trades via LazySecureTrade integration
- **User sovereignty**: Only user can extract NFTs/funds (except factory admin for arbitrage)
- **Nonce management**: Track internal operations for uniqueness

#### **Key Features**
```solidity
contract BidderContract {
    address public owner;                    // User who owns this contract
    address public factory;                  // BidderContractFactory (admin rights)
    uint256 public nonce;                   // Internal nonce for bid uniqueness
    
    // Associated tokens for NFT reception
    address[] public associatedTokens;
    mapping(address => bool) public isAssociated;
    
    // Fund management
    modifier onlyOwner() { require(msg.sender == owner); _; }
    modifier onlyFactory() { require(msg.sender == factory); _; }
    modifier onlyOwnerOrFactory() { require(msg.sender == owner || msg.sender == factory); _; }
}
```

#### **Core Functions**

##### **Fund Management (HTS Native)**
```solidity
// No deposit functions needed - use native HTS transfers to send HBAR/$LAZY to contract

// User withdrawal (full sovereignty)
function withdrawHbar(uint256 amount) external onlyOwner;
function withdrawLazy(uint256 amount) external onlyOwner;

// Factory withdrawal (arbitrage profits only)
function factoryWithdrawHbar(uint256 amount) external onlyFactory;
function factoryWithdrawLazy(uint256 amount) external onlyFactory;
```

##### **Token Association Management (Internal)**
```solidity
// Internal token association (triggered during bid creation if needed)
function _associateTokenIfNeeded(address token) internal;

// Check if token is associated
function isTokenAssociated(address token) external view returns (bool);

// Get all associated tokens (for user reference)
function getAssociatedTokens() external view returns (address[] memory);
```

##### **Bid Creation**
```solidity
// Create bid (validates funds, calls factory)
function createBid(
    address token,
    uint256[] memory serials,  // Empty = any serial
    uint256 hbarAmount,
    uint256 lazyAmount,
    uint256 expiry
) external onlyOwner returns (bytes32 bidId);

// Cancel bid
function cancelBid(bytes32 bidId) external onlyOwner;
```

##### **Trade Execution**
```solidity
// Execute trade (called by factory during arbitrage)
function executeTrade(bytes32 tradeId, uint256 hbarAmount, uint256 lazyAmount) external onlyFactory;
```

##### **NFT Withdrawal (TokenStakerV2 Integration)**
```solidity
// Withdraw NFTs using TokenStakerV2 pattern (avoids refill costs)
// Support multiple tokens and serials in single transaction
function withdrawNFTs(
    address[] memory tokens,
    uint256[][] memory serials  // Array of serial arrays, one per token
) external onlyOwner;

// Events for BidderContract context
event NFTsWithdrawn(address indexed owner, address[] tokens, uint256[][] serials);
event HbarWithdrawn(address indexed owner, uint256 amount);
event LazyWithdrawn(address indexed owner, uint256 amount);
event TokenAssociated(address indexed token);

// Factory event consolidation - emit corresponding events in BidderContractFactory
function _emitFactoryEvent(EventType eventType, bytes memory eventData) internal;
```

---

### **3. LazySecureTrade Integration (Minimal Changes)**

#### **Required Enhancements (Space-Constrained)**
```solidity
// Add factory integration (minimal addition)
mapping(address => bool) public authorizedFactories;

// Allow factory to create trades on behalf of users
function createTradeOnBehalf(
    address seller,
    address buyer,  // BidderContract address
    // ... existing trade parameters
) external returns (bytes32 tradeId) {
    require(authorizedFactories[msg.sender], "Unauthorized factory");
    // Create trade with seller = actual seller, buyer = BidderContract
    // Rest of logic identical to existing createTrade
}

// Factory authorization management
function authorizeFactory(address factory, bool authorized) external onlyOwner;
```

---

## 🔄 Complete Execution Flows

### **Flow 1: User Creates Bid**
1. **User calls** `BidderContract.createBid(token, serials, hbarAmount, lazyAmount, expiry)`
2. **BidderContract validates** sufficient funds and token association
3. **BidderContract calls** `BidderContractFactory.createBid(bidDetails)`
4. **Factory creates** bid hash and stores in `bidRegistry`
5. **Factory adds** bid to `tokenToBids[token]` for discovery
6. **Factory emits** `BidCreated` event for off-chain indexing

### **Flow 2: Seller Executes Against Bid**
1. **Seller calls** `BidderContractFactory.executeAgainstBid(bidId, nftToken, serial)`
2. **Factory validates** bid (includes automatic cleanup if expired)
3. **Factory calls** `LazySecureTrade.createTradeOnBehalf(seller, bidderContract, ...)`
4. **Factory calls** `BidderContract.executeTrade(tradeId, hbarAmount, lazyAmount)`
5. **BidderContract calls** `LazySecureTrade.executeTrade(tradeId)`
6. **Trade executes** with all existing LazySecureTrade logic (fees, events, etc.)
7. **Factory removes bid** from registry (cleanup executed bid)
8. **Factory emits** `BidExecuted` event
9. **BidderContract emits** local event and triggers factory consolidation event

### **Flow 3: Third-Party Arbitrage**
1. **Arbitrageur identifies** profitable bid + existing trade combination
2. **Arbitrageur calls** `BidderContractFactory.executeArbitrage(bidId, existingTradeId)`
3. **Factory validates** both bid and trade compatibility
4. **Factory executes** trade via BidderContract (same as Flow 2)
5. **Factory calculates** arbitrage profit = (bid price - trade price - fees)
6. **Factory splits profit** 50% to arbitrageur, 50% retained by factory
7. **Factory calls** `BidderContract.factoryWithdrawHbar(factoryShare)`
8. **Factory transfers** arbitrageur share directly

---

## 📊 Scaling & Discovery Strategy

### **On-Chain Registry (Active Bids)**
```solidity
// Primary discovery mechanisms
mapping(address => bytes32[]) tokenToBids;        // Token-based lookup
mapping(address => bytes32[]) userToBids;         // User's active bids
mapping(bytes32 => BidDetails) bidRegistry;       // Complete bid details
```

### **Event-Driven Discovery (Off-Chain Indexing)**
```solidity
// Factory events for comprehensive tracking
event BidCreated(bytes32 indexed bidId, address indexed user, address indexed token, BidDetails details);
event BidCancelled(bytes32 indexed bidId, address indexed user);
event BidExecuted(bytes32 indexed bidId, address indexed executor, uint256 arbitrageProfit);
event BidExpired(bytes32 indexed bidId, address indexed user);
event BidderContractDeployed(address indexed user, address indexed bidderContract);

// Cleanup and maintenance events
event ExpiredBidsCleanup(address indexed cleaner, uint256 cleanedCount);
event UserExpiredBidsCleanup(address indexed user, uint256 cleanedCount);

// BidderContract events (emitted in their own context)
event BidderNFTsWithdrawn(address indexed owner, address[] tokens, uint256[][] serials);
event BidderHbarWithdrawn(address indexed owner, uint256 amount);
event BidderLazyWithdrawn(address indexed owner, uint256 amount);
event BidderTokenAssociated(address indexed token);

// Factory consolidation events (mirror BidderContract events for unified tracking)
event ConsolidatedNFTWithdrawal(address indexed bidderContract, address indexed owner, address[] tokens, uint256[][] serials);
event ConsolidatedHbarWithdrawal(address indexed bidderContract, address indexed owner, uint256 amount);
event ConsolidatedLazyWithdrawal(address indexed bidderContract, address indexed owner, uint256 amount);

// Integration events (from LazySecureTrade - no changes needed)
event TradeCreated(...);  // Existing event, no changes needed
event TradeExecuted(...); // Existing event, no changes needed
```

### **Scaling Strategy (10K → 500K Users)**
- **On-chain validation**: Quick bid validity and fund checking
- **Off-chain discovery**: Complex queries via event indexing
- **Hybrid approach**: Critical data on-chain, analytics off-chain
- **Registry cleanup**: Automatic cleanup of executed/expired bids

---

## 🎲 Tie-Breaking & Advanced Features

### **IPRNG Tie-Breaking**
```solidity
// Fair selection for identical price bids
function selectBestBid(bytes32[] memory samePriceBids) internal returns (bytes32) {
    if (samePriceBids.length == 1) return samePriceBids[0];
    
    uint256 randomIndex = getPseudorandomNumber() % samePriceBids.length;
    return samePriceBids[randomIndex];
}
```

### **Bid Validation Logic (Gas-Optimized)**
```solidity
function isBidValid(bytes32 bidId) external view returns (bool valid, string memory reason) {
    BidDetails memory bid = bidRegistry[bidId];
    
    // Check if bid exists (removed bids return default struct)
    if (bid.user == address(0)) return (false, "Bid not found");
    
    // Check expiry first (cheapest check)
    if (block.timestamp > bid.expiry) return (false, "Bid expired");
    
    // Fund checks involve subcalls - use sparingly
    // Check BidderContract HBAR balance
    uint256 hbarBalance = bid.bidderContract.balance;
    if (hbarBalance < bid.hbarAmount) return (false, "Insufficient HBAR");
    
    // Check $LAZY balance (subcall - expensive)
    if (bid.lazyAmount > 0) {
        uint256 lazyBalance = IERC20(lazyToken).balanceOf(bid.bidderContract);
        if (lazyBalance < bid.lazyAmount) return (false, "Insufficient LAZY");
    }
    
    return (true, "Valid");
}

// Batch validation for multiple bids (gas-optimized)
function validateBids(bytes32[] memory bidIds) external view returns (bool[] memory validBids, string[] memory reasons) {
    validBids = new bool[](bidIds.length);
    reasons = new string[](bidIds.length);
    
    for (uint256 i = 0; i < bidIds.length; i++) {
        (validBids[i], reasons[i]) = this.isBidValid(bidIds[i]);
    }
}
```

### **Expired Bid Cleanup Strategy**

#### **Lazy Cleanup Approach (Gas-Efficient)**
```solidity
// No automatic cleanup to avoid excessive gas costs
// Cleanup happens during natural operations:

// 1. During bid validation (when checking if bid is valid for execution)
function _cleanupExpiredBid(bytes32 bidId) internal {
    BidDetails memory bid = bidRegistry[bidId];
    if (block.timestamp > bid.expiry) {
        _removeBidFromRegistry(bidId);
        emit BidExpired(bidId, bid.user);
    }
}

// 2. Manual cleanup function (user/admin initiated)
function cleanupExpiredBids(bytes32[] memory bidIds) external {
    uint256 cleanedCount = 0;
    for (uint256 i = 0; i < bidIds.length; i++) {
        BidDetails memory bid = bidRegistry[bidIds[i]];
        if (bid.user != address(0) && block.timestamp > bid.expiry) {
            _removeBidFromRegistry(bidIds[i]);
            cleanedCount++;
        }
    }
    emit ExpiredBidsCleanup(msg.sender, cleanedCount);
}

// 3. Cleanup during execution attempts
function executeAgainstBid(bytes32 bidId, address nftToken, uint256 serial) external returns (bytes32 tradeId) {
    // Validate bid and cleanup if expired
    (bool valid, string memory reason) = this.isBidValid(bidId);
    if (!valid) {
        if (keccak256(bytes(reason)) == keccak256(bytes("Bid expired"))) {
            _cleanupExpiredBid(bidId);
        }
        revert(reason);
    }
    // ... rest of execution logic
}

// 4. User-initiated cleanup of their own expired bids
function cleanupMyExpiredBids() external {
    bytes32[] memory userBids = userToBids[msg.sender];
    uint256 cleanedCount = 0;
    
    for (uint256 i = 0; i < userBids.length; i++) {
        BidDetails memory bid = bidRegistry[userBids[i]];
        if (block.timestamp > bid.expiry) {
            _removeBidFromRegistry(userBids[i]);
            cleanedCount++;
        }
    }
    emit UserExpiredBidsCleanup(msg.sender, cleanedCount);
}
```

#### **Cleanup Events & Analytics**
```solidity
// Cleanup tracking events
event BidExpired(bytes32 indexed bidId, address indexed user);
event ExpiredBidsCleanup(address indexed cleaner, uint256 cleanedCount);
event UserExpiredBidsCleanup(address indexed user, uint256 cleanedCount);

// Analytics for cleanup efficiency
function getExpiredBidCount() external view returns (uint256) {
    // Note: This function is expensive and should only be used for analytics
    // Implementation would iterate through all bids checking expiry
}

function getExpiredBidsForToken(address token) external view returns (bytes32[] memory) {
    // Returns expired bids for specific token (for targeted cleanup)
}
```

### **Advanced Bid Types**
```solidity
// Flexible serial targeting
// Empty serials array = any serial from collection
// Specific serials = exact serial matching
// Future: Range support (serials[0] = start, serials[1] = end)

function matchesBid(BidDetails memory bid, uint256 serial) internal pure returns (bool) {
    if (bid.serials.length == 0) return true;  // Any serial
    
    for (uint256 i = 0; i < bid.serials.length; i++) {
        if (bid.serials[i] == serial) return true;
    }
    return false;
}
```

---

## 🚀 Implementation Phases

### **Phase 1: Core Factory Pattern (Week 1-2)**
- [ ] BidderContractFactory.sol with minimal proxy deployment
- [ ] Basic BidderContract.sol with fund management
- [ ] Simple bid creation and discovery
- [ ] Integration with existing LazySecureTrade (minimal changes)

### **Phase 2: CLOB Discovery (Week 3-4)**
- [ ] Enhanced bid registry with token-based lookup
- [ ] Event-driven discovery patterns
- [ ] Bid validation and expiry management
- [ ] IPRNG tie-breaking implementation

### **Phase 3: Arbitrage & Advanced Features (Week 5-6)**
- [ ] Third-party arbitrage execution
- [ ] Profit sharing mechanisms
- [ ] Advanced bid types (serial ranges, lists)
- [ ] Analytics and monitoring tools

### **Phase 4: TokenStakerV2 Integration (Week 7-8)**
- [ ] NFT withdrawal optimization
- [ ] Gas-efficient batch operations
- [ ] Token association management
- [ ] User experience enhancements

---

## 🔧 Technical Implementation Notes

### **Factory Pattern Reference**
- **Model**: MissionFactory.sol pattern with event grouping
- **Deployment**: Minimal proxy clones for gas efficiency
- **Registry**: Centralized tracking with event emission

### **Space Constraints (LazySecureTrade Changes)**
- **Minimal additions only**: `authorizedFactories` mapping + `createTradeOnBehalf`
- **No breaking changes**: Maintain all existing functionality
- **Event reuse**: Leverage existing event infrastructure

### **Gas Optimization**
- **Batch operations**: Leverage TokenStakerV2 patterns
- **Event-driven discovery**: Reduce on-chain storage costs
- **Proxy pattern**: Efficient BidderContract deployment
- **Lazy association**: Associate tokens only when needed

---

## 📋 Questions Resolved

1. ✅ **Integration Strategy**: Create trade in LazySecureTrade then execute via BidderContract
2. ✅ **Scaling Approach**: Hybrid on-chain registry + off-chain indexing
3. ✅ **Validation Logic**: HBAR + $LAZY balance checking with expiry
4. ✅ **Tie-Breaking**: IPRNG for fairness
5. ✅ **Factory Pattern**: MissionFactory.sol model with event grouping
6. ✅ **LazySecureTrade Changes**: Minimal `createTradeOnBehalf` addition only
7. ✅ **Bid Granularity**: One bid per executable unit with cleanup
8. ✅ **Token Association**: $LAZY at deployment, others as needed

---

**Status**: 🎯 **DESIGN COMPLETE - READY FOR IMPLEMENTATION**

This architecture provides a robust, scalable bidding infrastructure that seamlessly integrates with your proven LazySecureTrade v0.2 foundation while maintaining event consistency and user sovereignty.