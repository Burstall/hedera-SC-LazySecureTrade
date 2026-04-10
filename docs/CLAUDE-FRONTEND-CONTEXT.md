# Claude Frontend Context -- LazySecureTrade v0.3

This file gives Claude Code the full context needed to build a frontend DApp for LazySecureTrade v0.3. It covers the contract architecture, complete API surface, state machine, events, read/write patterns, Hedera constraints, security model, and error reference.

---

## Architecture Summary

### Three-Contract Stack

```
LazySecureTrade (LST)
  Inheritance: Ownable, ReentrancyGuard, TokenStakerV2, ILazySecureTrade
  Role: NFT marketplace -- trade creation, execution, batch trades, platform fees, royalty-compliant transfers
  Deployed: one instance per environment

BidderContractFactory (Factory)
  Inheritance: Ownable, ReentrancyGuard
  Role: central router -- stash deployment, bid registry, arbitrage engine, discovery views
  Deployed: one instance per environment

BidderContract (Stash)
  Inheritance: TokenStakerV2, ReentrancyGuard
  Role: per-user fund vault -- holds HBAR/$LAZY/NFTs, creates bids, executes trades
  Deployed: one clone per user via CREATE2 (Clones.cloneDeterministic)
```

### CREATE2 Addressing

Each stash lives at a deterministic address derived from:
- Factory address
- Implementation address (immutable on factory)
- Salt: `keccak256(abi.encodePacked("LST_STASH_v1", userAddress))`

Off-chain prediction uses the OpenZeppelin `Clones.predictDeterministicAddress` formula. The factory exposes `getStashAddress(user)` as an on-chain view.

### Inheritance Chain

```
TokenStakerV2 -> HederaTokenService (HTS precompile wrapper)
  Fields: lazyToken, lazyGasStation, lazyDelegateRegistry
  Key functions: moveNFTs, batchMoveNFTs, tokenAssociate, batchTokenAssociate
  Constant: CUSTODY_HOP_TINYBAR = 1 (int64)
  Error: HTSCallFailed(int256 code, bytes4 op)
```

Both LST and BidderContract inherit from TokenStakerV2. This shared base is what enables Hedera-compliant 2-step NFT transfers across the entire stack.

---

## Complete API Surface

### BidderContractFactory -- Deployment & Registry

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `deployStash()` | external | -- | `address stash` | Deploy stash for msg.sender |
| `deployStashFor(address user)` | external | user address | `address stash` | Permissionless; owner is always `user` |
| `getStashAddress(address user)` | public view | user address | `address` | CREATE2 prediction (works pre-deployment) |
| `getStashOf(address user)` | external view | user address | `address` | O(1) mapping; returns address(0) if not deployed |
| `verifyStash(address stash)` | external view | stash address | `bool` | Re-derives CREATE2 and compares |
| `getAllStashes()` | external view | -- | `address[]` | All deployed stash addresses |
| `getStashCount()` | external view | -- | `uint256` | Count of deployed stashes |

### BidderContractFactory -- Bid Management

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `createBid(BidDetails memory)` | external | BidDetails struct | `bytes32 bidId` | Called by stash, not user directly |
| `cancelBid(bytes32 bidId)` | external | bid ID | -- | Caller must be bid.user or bid.stash |
| `cleanupExpiredBids(bytes32[] memory bidIds)` | external | bid IDs to check | `uint256 cleanedCount` | Permissionless cleanup |

### BidderContractFactory -- Trade Execution

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `executeAgainstBid(bytes32 bidId, address nftToken, uint256 serial)` | external | bid ID, NFT token, serial | `bytes32 tradeId` | Seller-initiated; creates trade + executes in one tx |
| `createTradeOnBehalfOfStash(address seller, address token, address buyer, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime)` | external | seller, trade params | `bytes32 tradeId` | Called by stash to list NFTs held inside it |

### BidderContractFactory -- Arbitrage

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `executeArbitrage(bytes32 bidId, bytes32 existingTradeId, uint256 minProfit)` | external | bid ID, LST trade ID, min profit | `uint256 spread` | Third-party arbitrage |
| `claimArbProfit()` | external | -- | -- | Arbitrageur pulls accrued HBAR |
| `withdrawProtocolProfit(address payable to, uint256 amount)` | external | destination, amount | -- | onlyOwner |
| `setArbitragePayoutBps(uint256 newBps)` | external | new bps (0-10000) | -- | onlyOwner; starts 48h timelock |
| `executeArbPayoutBpsChange()` | external | -- | -- | Permissionless after timelock ETA |

### BidderContractFactory -- Discovery & Validation

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `getBidsForToken(address token)` | external view | token | `bytes32[]` | All bid IDs (unbounded) |
| `getBidsForTokenPaginated(address token, uint256 offset, uint256 limit)` | external view | token, cursor, limit (max 200) | `bytes32[]` | Paginated |
| `getBidsForTokenSerialPaginated(address token, uint256 serial, uint256 offset, uint256 limit)` | external view | token, serial, cursor, limit (max 200) | `(bytes32[] matches, uint256 nextOffset)` | Cursor-based serial filter |
| `getUserBids(address user)` | external view | user | `bytes32[]` | User's active bid IDs |
| `getTotalBidCount()` | external view | -- | `uint256` | Lifetime counter |
| `getTokenBidCount(address token)` | external view | token | `uint256` | Active bids for token |
| `isBidValid(bytes32 bidId)` | public view | bid ID | `(bool valid, BidValidityCode code)` | Structured validity check |
| `validateBids(bytes32[] memory bidIds)` | external view | bid IDs | `(bool[], BidValidityCode[])` | Batch validation |
| `getStashSnapshot(address user)` | external view | user | `(address stash, bool deployed, uint256 hbarBalance, uint256 lazyBalance, bytes32[] activeBidIds)` | Aggregator view |

### BidderContractFactory -- Public State

| Variable | Type | Notes |
|---|---|---|
| `LAZY_SECURE_TRADE` | `ILazySecureTrade` immutable | LST contract |
| `LAZY_TOKEN` | `address` immutable | $LAZY token address |
| `LAZY_GAS_STATION` | `address` immutable | LazyGasStation address |
| `LAZY_DELEGATE_REGISTRY` | `address` immutable | LDR address |
| `BIDDER_CONTRACT_IMPLEMENTATION` | `address` immutable | Clone source |
| `userToStash(address)` | mapping | User -> deployed stash |
| `isValidStash(address)` | mapping | Stash verification |
| `bidRegistry(bytes32)` | mapping | Bid ID -> BidDetails |
| `tokenToBids(address)` | mapping | Token -> bid ID array |
| `userToBids(address)` | mapping | User -> bid ID array |
| `totalBidCount` | uint256 | Lifetime counter |
| `arbitragePayoutBps` | uint256 | Current arb split (default 5000) |
| `pendingArbPayoutBps` | uint256 | Queued bps change |
| `arbPayoutBpsChangeEta` | uint256 | Timelock ETA timestamp |
| `pendingArbProfit(address)` | mapping | Arbitrageur -> unclaimed HBAR |
| `pendingProtocolProfit` | uint256 | Protocol's unclaimed HBAR |
| `MAX_VIEW_PAGINATION` | uint256 constant | 200 |

### BidderContract (Stash) -- Fund Management

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `withdrawHbar(uint256 amount)` | external | tinybars | -- | onlyOwner; keeps 1 HBAR minimum |
| `withdrawLazy(uint256 amount)` | external | amount | -- | onlyOwner |
| `withdrawNFTs(address[] tokens, uint256[][] serials, int64[] hbarAmounts)` | external | arrays | -- | onlyOwner; batch via batchMoveNFTs |
| `withdrawSingleNFT(address token, uint256 serial)` | external | token, serial | -- | onlyOwner; uses CUSTODY_HOP_TINYBAR |

### BidderContract (Stash) -- Sovereignty

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `rescueHbar(address payable to, uint256 amount)` | external | destination, tinybars | -- | onlyOwner; bypasses minimum balance |
| `rescueLazy(address to, uint256 amount)` | external | destination, amount | -- | onlyOwner |
| `rescueNFT(address token, uint256 serial, address to, int64 hbarValue)` | external | token, serial, dest, value | -- | onlyOwner; direct moveNFTs |
| `detachFromFactory()` | external | -- | -- | onlyOwner; irreversible |

### BidderContract (Stash) -- Bidding & Trading

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `createBid(address token, uint256[] serials, uint256 hbarAmount, uint256 lazyAmount, uint256 expiry, uint256 minAcceptablePrice)` | external | bid params | `bytes32 bidId` | onlyOwner |
| `cancelBid(bytes32 bidId)` | external | bid ID | -- | onlyOwner |
| `createTrade(address token, address buyer, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime)` | external | trade params | `bytes32 tradeId` | onlyOwner; lists NFT from stash |
| `executeTrade(bytes32 tradeId, uint256 hbarAmount, uint256 lazyAmount)` | external payable | trade ID, amounts | -- | onlyFactory |
| `arbitrageSettle(bytes32 bidId, bytes32 tradeId, uint256 hbarAmount, uint256 lazyAmount)` | external | IDs, amounts | -- | onlyFactory; ARB_SETTLE_MAX_BPS cap |

### BidderContract (Stash) -- Token Association

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `associateToken(address token)` | external | token address | -- | onlyOwner |
| `batchAssociateTokens(address[] tokens)` | external | token addresses | -- | onlyOwner |
| `isTokenAssociated(address token)` | external view | token address | `bool` | Check association |
| `getAssociatedTokens()` | external view | -- | `address[]` | List associations |

### BidderContract (Stash) -- Public State

| Variable | Type | Notes |
|---|---|---|
| `owner` | address | Stash owner (user) |
| `factory` | address | Factory address (address(0) if detached) |
| `lazySecureTradeAddress` | address | LST contract |
| `nonce` | uint256 | Internal bid nonce |
| `isAssociated(address)` | mapping | Token association tracking |

### LazySecureTrade -- Key Functions for v0.3 Integration

| Function | Visibility | Params | Returns | Notes |
|---|---|---|---|---|
| `createTrade(address token, address buyer, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime)` | external | trade params | `bytes32 tradeId` | Direct user trade creation |
| `createTradeOnBehalf(address seller, address token, address buyer, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime)` | external | seller + trade params | `bytes32 tradeId` | Factory-only (authorizedFactories check) |
| `executeTrade(bytes32 tradeId)` | external payable | trade ID | -- | Execute with HBAR via msg.value |
| `cancelTrade(bytes32 tradeId)` | public | trade ID | -- | Seller or buyer can cancel |
| `cancelTrades(bytes32[] tradeIds)` | external | trade IDs | -- | Batch cancel |
| `getTrade(bytes32 tradeId)` | external view | trade ID | `Trade memory` | Read trade details |
| `getTrades(bytes32[] tradeIds)` | external view | trade IDs | `Trade[]` | Batch read |
| `getUserTrades(address user)` | external view | user address | `bytes32[]` | User's trade IDs |
| `getTokenTrades(address token)` | external view | token address | `bytes32[]` | Token's trade IDs |
| `getLSHTokenTier(address user)` | public view | user address | `uint256 tier` | 0=none, 1=Gen2, 2=Mutant, 3=Gen1 |
| `areAdvancedTradesFree(address user)` | public view | user address | `bool` | LSH holder listing exemption |
| `getPlatformFeeInfo()` | external view | -- | `(baseFeeRate, gen2Discount, mutantDiscount, gen1Discount, totalFees)` | Fee config |
| `authorizeFactory(address factory, bool authorized)` | external | factory, bool | -- | onlyOwner |
| `createBatchTrade(...)` | external | batch params | `bytes32 batchId` | Atomic multi-NFT listing (max 22 items) |
| `executeBatchTrade(bytes32 batchId)` | external payable | batch ID | -- | Atomic batch execution |
| `executeTrades(bytes32[] tradeIds)` | external payable | trade IDs | -- | Multi-trade execution (max ~20) |

---

## BidDetails Struct Layout

```solidity
struct BidDetails {
    address user;              // Original bidder (stash owner)
    address stash;             // BidderContract clone address
    uint256 hbarAmount;        // HBAR bid (tinybars)
    uint256 lazyAmount;        // $LAZY bid amount
    uint256 expiry;            // Unix timestamp (0 = no expiry)
    address token;             // Target NFT collection
    uint256[] serials;         // Empty = any serial, non-empty = exact match
    uint256 stashNonce;        // Stash internal nonce
    uint256 createdAt;         // Creation timestamp (set by factory)
    uint256 minAcceptablePrice; // Arb price floor (tinybars, 0 = accept any)
    BidStatus status;          // Lifecycle state
}
```

### BidStatus Enum

| Value | Name | Meaning |
|---|---|---|
| 0 | `None` | Struct default; bid never existed |
| 1 | `Active` | Live; eligible for execution and arbitrage |
| 2 | `Cancelled` | Explicitly cancelled by bidder |
| 3 | `Executed` | Matched via executeAgainstBid or executeArbitrage |
| 4 | `Expired` | Swept by cleanup or marked on execute attempt |

### BidValidityCode Enum

| Value | Name | Meaning |
|---|---|---|
| 0 | `Valid` | Active, unexpired, and funded |
| 1 | `NotFound` | Bid ID does not exist |
| 2 | `NotActive` | Exists but is Cancelled/Executed/Expired |
| 3 | `Expired` | Active but past expiry timestamp |
| 4 | `InsufficientHbar` | Stash HBAR < bid.hbarAmount |
| 5 | `InsufficientLazy` | Stash $LAZY < bid.lazyAmount |

### ILazySecureTrade.Trade Struct

```solidity
struct Trade {
    address seller;
    address buyer;      // address(0) = open market
    address token;
    uint256 serial;
    uint256 tinybarPrice;
    uint256 lazyPrice;
    uint256 expiryTime;
    uint256 nonce;
}
```

---

## State Machine Diagram

```
                    +------------------+
                    |                  |
   createBid ------>    Active (1)    |
                    |                  |
                    +--------+---------+
                             |
              +--------------+---------------+
              |              |               |
        cancelBid    executeAgainstBid  cleanupExpiredBids
        by owner     or executeArbitrage  (anyone, if expired)
              |              |               |
              v              v               v
        +-----------+  +-----------+   +-----------+
        | Cancelled |  | Executed  |   |  Expired  |
        |    (2)    |  |    (3)    |   |    (4)    |
        +-----------+  +-----------+   +-----------+

  All terminal states are soft-deleted:
  - Registry entry retained with updated status
  - Removed from tokenToBids[] and userToBids[] (O(1) swap-pop)
  - Post-mortem queries via bidRegistry[bidId] return historical data

  None (0) = bid ID has never been used
```

---

## Event Catalog

### BidderContractFactory Events

| Event | Signature | Indexed Topics | Data |
|---|---|---|---|
| StashDeployed | `StashDeployed(address indexed user, address indexed stash, address indexed deployer)` | user, stash, deployer | -- |
| BidCreated | `BidCreated(bytes32 indexed bidId, address indexed user, address indexed token, BidDetails details)` | bidId, user, token | full BidDetails struct |
| BidCancelled | `BidCancelled(bytes32 indexed bidId, address indexed user)` | bidId, user | -- |
| BidExecuted | `BidExecuted(bytes32 indexed bidId, address indexed executor, bytes32 tradeId, uint256 arbitrageProfit)` | bidId, executor | tradeId, arbitrageProfit |
| BidExpired | `BidExpired(bytes32 indexed bidId, address indexed user)` | bidId, user | -- |
| ExpiredBidsCleanup | `ExpiredBidsCleanup(address indexed cleaner, uint256 cleanedCount)` | cleaner | cleanedCount |
| TradeCreatedFromStash | `TradeCreatedFromStash(bytes32 indexed tradeId, address indexed stash, address indexed seller, address token, uint256 serial)` | tradeId, stash, seller | token, serial |
| ArbitrageExecuted | `ArbitrageExecuted(bytes32 indexed bidId, bytes32 indexed tradeId, address indexed arbitrageur, uint256 arbCut, uint256 protocolCut)` | bidId, tradeId, arbitrageur | arbCut, protocolCut |
| ArbProfitClaimed | `ArbProfitClaimed(address indexed arbitrageur, uint256 amount)` | arbitrageur | amount |
| ProtocolProfitWithdrawn | `ProtocolProfitWithdrawn(address indexed to, uint256 amount)` | to | amount |
| ArbPayoutBpsChangePending | `ArbPayoutBpsChangePending(uint256 newBps, uint256 eta)` | -- | newBps, eta |
| ArbPayoutBpsChanged | `ArbPayoutBpsChanged(uint256 newBps)` | -- | newBps |

### BidderContract (Stash) Events

| Event | Signature | Indexed Topics | Data |
|---|---|---|---|
| FactoryDetached | `FactoryDetached(address indexed owner, address indexed formerFactory)` | owner, formerFactory | -- |
| StashArbSettled | `StashArbSettled(bytes32 indexed bidId, bytes32 indexed tradeId, uint256 hbarAmount, uint256 lazyAmount)` | bidId, tradeId | hbarAmount, lazyAmount |

### LazySecureTrade Events

| Event | Signature | Indexed Topics | Data |
|---|---|---|---|
| TradeCreated | `TradeCreated(address indexed seller, address indexed buyer, address indexed token, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime, uint256 nonce)` | seller, buyer, token | serial, prices, expiry, nonce |
| TradeCompleted | `TradeCompleted(address indexed seller, address indexed buyer, address indexed token, uint256 serial, uint256 nonce)` | seller, buyer, token | serial, nonce |
| TradeCancelled | `TradeCancelled(address indexed seller, address indexed token, uint256 serial, uint256 nonce)` | seller, token | serial, nonce |
| BatchTradeCreated | `BatchTradeCreated(bytes32 indexed batchId, address indexed seller, address indexed buyer, uint256 itemCount, uint256 totalTinybarPrice, uint256 totalLazyPrice)` | batchId, seller, buyer | itemCount, prices |
| BatchTradeExecuted | `BatchTradeExecuted(bytes32 indexed batchId, address indexed buyer, uint256 itemCount, uint256 totalTinybarPrice, uint256 totalLazyPrice)` | batchId, buyer | itemCount, prices |
| BatchTradeCancelled | `BatchTradeCancelled(bytes32 indexed batchId, address indexed canceller, uint256 itemCount)` | batchId, canceller | itemCount |
| TokenAssociated | `TokenAssociated(address indexed token, address indexed account)` | token, account | -- |
| PlatformFeeCollected | `PlatformFeeCollected(address indexed seller, address indexed buyer, uint256 hbarFee, uint256 effectiveFeeRate)` | seller, buyer | hbarFee, effectiveFeeRate |
| FeeRatesUpdated | `FeeRatesUpdated(uint256 baseFeeRate, uint256 lshGen2Discount, uint256 lshMutantDiscount, uint256 lshGen1Discount)` | -- | all rates |
| FeesWithdrawn | `FeesWithdrawn(address indexed recipient, uint256 hbarAmount)` | recipient | hbarAmount |
| FactoryAuthorized | `FactoryAuthorized(address indexed factory, bool authorized)` | factory | authorized |

---

## Read Patterns

### Mirror Node vs Consensus

| Data Need | Pattern | Latency |
|---|---|---|
| Stash HBAR balance | Mirror node: `GET /api/v1/contracts/{evmAddress}` | ~5s after tx |
| Stash NFT holdings | Mirror node: `GET /api/v1/accounts/{accountId}/nfts` | ~5s after tx |
| Stash $LAZY balance | Mirror node: `GET /api/v1/tokens/{lazyTokenId}/balances?account.id={accountId}` | ~5s after tx |
| Bid validity check | Consensus: `factory.isBidValid(bidId)` | Real-time |
| Bid details | Consensus: `factory.bidRegistry(bidId)` | Real-time |
| Stash snapshot | Consensus: `factory.getStashSnapshot(user)` | Real-time |
| Trade details | Consensus: `lst.getTrade(tradeId)` | Real-time |
| Event history | Mirror node: `GET /api/v1/contracts/{contractId}/results/logs` | ~5s after tx |

### Off-Chain Stash Address Prediction

No RPC call needed. Compute locally:

```
salt = keccak256(abi.encodePacked("LST_STASH_v1", userAddress))
initCodeHash = keccak256(minimalProxyBytecode(implementationAddress))
stashAddress = CREATE2(factoryAddress, salt, initCodeHash)
```

Use `getStashOf(user)` (returns address(0) if not deployed) to distinguish between predicted and deployed.

### getStashSnapshot Aggregator

Returns in one call: stash address, deployment status, HBAR balance, $LAZY balance, and active bid IDs (capped at 200). If not deployed, returns the predicted address with zero balances and empty bids.

---

## Write Patterns Per User Action

### Deploy Stash

| Step | Account Signs | Contract | Function | Allowances | Expected Events |
|---|---|---|---|---|---|
| 1 | User (or sponsor) | Factory | `deployStash()` or `deployStashFor(user)` | None | `StashDeployed` |

### Fund Stash

| Step | Account Signs | Method | Notes |
|---|---|---|---|
| HBAR | User | `TransferTransaction` to stash address | Standard Hedera crypto transfer |
| $LAZY | User | ERC-20 `transfer()` to stash address | Stash auto-associated on init |

### Create Bid

| Step | Account Signs | Contract | Function | Allowances | Expected Events |
|---|---|---|---|---|---|
| 1 | User (stash owner) | Stash | `createBid(token, serials, hbar, lazy, expiry, minPrice)` | None (stash auto-associates NFT collection) | `BidCreated` on Factory |

### Cancel Bid

| Step | Account Signs | Contract | Function | Expected Events |
|---|---|---|---|---|
| 1 | User (stash owner) | Stash | `cancelBid(bidId)` | `BidCancelled` on Factory |

### Seller Accepts Bid (executeAgainstBid)

| Step | Account Signs | Contract | Function | Allowances | Expected Events |
|---|---|---|---|---|---|
| Pre | Seller | HTS | Approve NFT allowance to LST contract | NFT allowance on LST | -- |
| 1 | Seller | Factory | `executeAgainstBid(bidId, nftToken, serial)` | NFT allowance already set | `TradeCreated` on LST, `TradeCompleted` on LST, `BidExecuted` on Factory |

### List NFT from Stash

| Step | Account Signs | Contract | Function | Allowances | Expected Events |
|---|---|---|---|---|---|
| 1 | User (stash owner) | Stash | `createTrade(token, buyer, serial, hbarPrice, lazyPrice, expiry)` | None (stash owns the NFT) | `TradeCreatedFromStash` on Factory, `TradeCreated` on LST |

### Execute Arbitrage

| Step | Account Signs | Contract | Function | Allowances | Expected Events |
|---|---|---|---|---|---|
| 1 | Arbitrageur | Factory | `executeArbitrage(bidId, existingTradeId, minProfit)` | None | `TradeCompleted` on LST, `StashArbSettled` on Stash, `ArbitrageExecuted` on Factory |

### Claim Arbitrage Profit

| Step | Account Signs | Contract | Function | Expected Events |
|---|---|---|---|---|
| 1 | Arbitrageur | Factory | `claimArbProfit()` | `ArbProfitClaimed` |

### Withdraw from Stash

| Step | Account Signs | Contract | Function | Notes |
|---|---|---|---|---|
| HBAR | User | Stash | `withdrawHbar(amount)` | Keeps 1 HBAR minimum |
| $LAZY | User | Stash | `withdrawLazy(amount)` | -- |
| NFT | User | Stash | `withdrawSingleNFT(token, serial)` | User must be associated with the NFT collection |
| Batch NFT | User | Stash | `withdrawNFTs(tokens, serials, hbarAmounts)` | Max 8 serials per token |

### Detach from Factory

| Step | Account Signs | Contract | Function | Expected Events |
|---|---|---|---|---|
| 1 | User | Stash | `detachFromFactory()` | `FactoryDetached` |

---

## Hedera Constraints

| Constraint | Value | Impact on Frontend |
|---|---|---|
| **No MEV** | Consensus timestamp ordering | No slippage warnings, no frontrun protection needed. Transactions execute in the order they arrive at consensus. |
| **50 subcalls per transaction** | Hard ceiling | Limits batch sizes. executeAgainstBid uses ~10 subcalls. Don't combine multiple complex operations in one tx. |
| **~1M gas per new token association** | Per collection | Budget gas estimates for first-time interactions with a new NFT collection. Show a "first-time association" note in the UI. |
| **5-second mirror node lag** | After consensus | Poll mirror node with retries. Show "confirming..." state for 5-8 seconds after tx receipt. |
| **Token association required** | Before receiving tokens | Stash auto-associates on bid creation. User accounts need manual association to receive NFTs on withdrawal. |
| **1 tinybar custody hop** | On contract-to-user NFT transfers | Not visible in UI. This is internal royalty plumbing. The real sale royalty is paid on the first transfer leg. |
| **CREATE2 cannot pre-fund** | On Hedera (unlike Ethereum) | Must deploy stash before funding. Cannot send HBAR to predicted address pre-deployment. |
| **No gas refunds on revert** | Unlike Ethereum | Users pay for consumed gas even on failed txs. Validate inputs client-side before submitting. Prefer `isBidValid()` checks before execution attempts. |
| **ED25519 keys** | Hedera native | Use `PrivateKey.fromStringED25519` (not ECDSA) for standard Hedera accounts. Contract interactions use EVM-compatible calls. |

---

## Security Model

### Multisig & Timelock

- Factory owner should be a Hedera native threshold multisig.
- `setArbitragePayoutBps` has a 48-hour inline timelock: owner proposes, anyone can apply after ETA.
- `withdrawProtocolProfit` is onlyOwner, expected to be behind multisig.

### ARB_SETTLE_MAX_BPS

Hardcoded at 7500 (75%) in BidderContract. No admin key can weaken it. Even a buggy factory cannot drain more than 75% of a stash's HBAR balance in a single `arbitrageSettle` call.

### Detach (Factory Severance)

`detachFromFactory()` is irreversible. Sets factory to address(0). All onlyFactory functions revert permanently. Withdrawals continue to work. The stash becomes a pure vault.

### Implementation Lock

BidderContract constructor sets `initialized = true`. The implementation contract itself cannot be hijacked via `initialize()`. Only clones (with fresh storage) can be initialized.

### Self-Arbitrage Block

Three checks in `executeArbitrage`:
1. `msg.sender != bid.user` (caller is not the bidder)
2. `msg.sender != trade.seller` (caller is not the seller)
3. `bid.user != trade.seller` (bidder is not the seller)

### Registry Drift Detection

`executeArbitrage` takes a keccak256 snapshot of `bidRegistry[bidId]` before execution and compares after. Any cross-contract reentrancy that mutates the bid entry causes revert with `RegistryDriftDetected`.

### Custody Hop (Not Royalty Defeat)

The 1-tinybar value in NFT transfers is `CUSTODY_HOP_TINYBAR` -- an internal custody-hop marker for the 2-step transfer pattern (seller -> contract -> buyer). Creator royalties are paid in full on leg 1 (the real sale). Leg 2 is bookkeeping. Do not refer to this as "royalty defeat" in UI copy.

---

## Error Reference

### BidderContractFactory Errors

| Error | Signature | When |
|---|---|---|
| `StashAlreadyExists()` | `0x...` | deployStash/deployStashFor for user who already has one |
| `NoStashForUser()` | `0x...` | (reserved) |
| `InvalidBidDetails()` | `0x...` | Bid params fail validation (zero token, zero amounts, expiry in past) |
| `BidNotFound()` | `0x...` | Bid ID has BidStatus.None |
| `BidNotActive()` | `0x...` | Bid exists but is not in Active state |
| `BidHasExpired()` | `0x...` | Active bid past its expiry timestamp |
| `InsufficientFunds()` | `0x...` | Stash balance < bid amount |
| `UnauthorizedCaller()` | `0x...` | Caller is not bid.user or bid.stash |
| `InvalidStash()` | `0x...` | msg.sender is not a factory-deployed stash |
| `TradeExecutionFailed()` | `0x...` | HBAR transfer failed during claim/withdraw |
| `EmptyBidArray()` | `0x...` | cleanupExpiredBids called with empty array |
| `InvalidAddress()` | `0x...` | Zero address passed to deploy/withdraw functions |
| `ArbitrageTradeInvalid()` | `0x...` | Trade does not exist, is not open-market, wrong token, or serial mismatch |
| `ArbitrageProfitInsufficient()` | `0x...` | Spread < minProfit, bid < trade price, or trade price < minAcceptablePrice |
| `SelfArbitrageBlocked()` | `0x...` | Caller is bidder/seller or bidder == seller |
| `RegistryDriftDetected()` | `0x...` | Bid registry entry changed during execution (reentrancy) |
| `InvalidBps()` | `0x...` | newBps > 10000 |
| `NoPendingBpsChange()` | `0x...` | executeArbPayoutBpsChange with no pending change |
| `TimelockNotElapsed()` | `0x...` | executeArbPayoutBpsChange before ETA |
| `NothingToClaim()` | `0x...` | claimArbProfit with zero balance, or withdrawProtocolProfit with 0/over |
| `PaginationLimitTooLarge()` | `0x...` | limit == 0 or limit > 200 |

### BidderContract (Stash) Errors

| Error | Signature | When |
|---|---|---|
| `AlreadyInitialized()` | `0x...` | initialize() called twice (or on implementation) |
| `OnlyOwner()` | `0x...` | Non-owner calls onlyOwner function |
| `OnlyFactory()` | `0x...` | Non-factory calls onlyFactory function |
| `OnlyOwnerOrFactory()` | `0x...` | Neither owner nor factory |
| `InvalidAddress()` | `0x...` | Zero address in initialize/rescue |
| `InvalidAmount()` | `0x...` | Zero amount in withdraw/rescue |
| `InsufficientBalance()` | `0x...` | Insufficient HBAR for withdrawal or ARB_SETTLE_MAX_BPS exceeded |
| `TransferFailed()` | `0x...` | HBAR or $LAZY transfer returned false/reverted |
| `TokenAlreadyAssociated()` | `0x...` | (reserved) |
| `InvalidBidParameters()` | `0x...` | Bad params in createBid or withdrawNFTs |
| `AlreadyDetached()` | `0x...` | detachFromFactory on already-detached stash |

### TokenStakerV2 Errors

| Error | Signature | When |
|---|---|---|
| `HTSCallFailed(int256 code, bytes4 op)` | `0x...` | HTS precompile returned non-success code |
| `BadArguments()` | `0x...` | moveNFTs called with > 8 serials |

Operation identifiers for `HTSCallFailed`:
- `"INIT"` (0x494e4954) -- initContracts LAZY token association
- `"XFER"` (0x58464552) -- cryptoTransfer (NFT move + HBAR hop)
- `"ASSC"` (0x41535343) -- single tokenAssociate
- `"BASC"` (0x42415343) -- batch associateTokens

Common HTS response codes:
- 22 = SUCCESS (should not appear in error)
- 167 = TOKEN_NOT_ASSOCIATED_TO_ACCOUNT
- 168 = TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT (tolerated by associate functions)
- 178 = SPENDER_DOES_NOT_HAVE_ALLOWANCE
- 181 = INSUFFICIENT_TOKEN_BALANCE

### LazySecureTrade Errors

| Error | Signature | When |
|---|---|---|
| `TradeNotFoundOrInvalid()` | `0x...` | Trade ID does not exist or is inactive |
| `TradeExpired()` | `0x...` | Trade past its expiry timestamp |
| `UserDoesNotOwnOrHasNotApprovedNFT(address token, uint256 serial)` | `0x...` | Seller lacks ownership or allowance |
| `InsufficientPayment()` | `0x...` | Buyer sent insufficient HBAR or $LAZY |
| `UserNotAuthorized()` | `0x...` | Caller is not the seller or buyer |
| `UserMustApproveNFTFirst()` | `0x...` | NFT allowance not granted to LST |
| `SellerCannotBeBuyer()` | `0x...` | Seller and buyer are the same address |
| `ExpiryTimeInPast()` | `0x...` | Trade expiry is in the past |
| `InvalidFeeRate(uint256 rate)` | `0x...` | Fee rate exceeds maximum |
| `BatchTradeNotFound(bytes32 batchId)` | `0x...` | Batch trade does not exist |
| `BatchSizeExceedsLimit(uint256 provided, uint256 maximum)` | `0x...` | Batch too large |
| `UnauthorizedFactory()` | `0x...` | createTradeOnBehalf from non-authorized factory |
| `InvalidBatchParameters()` | `0x...` | Array length mismatch or empty batch |
| `BadArguments()` | inherited | From TokenStakerV2 |
| `HTSCallFailed(int256 code, bytes4 op)` | inherited | From TokenStakerV2 |
