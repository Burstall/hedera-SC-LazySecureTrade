/**
 * Core type definitions for the marketplace SDK.
 *
 * Enum numeric values must stay byte-identical to their Solidity
 * counterparts — they are the canonical wire format for ABI decoding.
 * Reordering or inserting variants here without coordinating with the
 * Solidity source will silently mis-decode every mirror read.
 *
 * Struct shapes mirror the interfaces under contracts/interfaces/. Field
 * order matches Solidity packing where it's load-bearing (e.g.
 * AgentEnvelope) — see the Solidity dev comments before reordering.
 */

import type { AgentAuth } from '../helpers/agentAuth';

export type { AgentAuth };

/**
 * Lifecycle state of a CLOB bid.
 *
 * Source: contracts/interfaces/IBidderContractFactory.sol
 *
 * Bids are hard-deleted on close — `_closeBid` does
 * `delete bidRegistry[bidId]`. Storage reads after close return a zero
 * struct (BidStatus.None). Terminal states (Cancelled/Executed/Expired)
 * survive only in event logs.
 */
export enum BidStatus {
    None = 0,
    Active = 1,
    Cancelled = 2,
    Executed = 3,
    Expired = 4,
}

/**
 * Result code from `isBidValid(bidId)` pre-flight checks.
 *
 * Source: contracts/BidderContractFactory.sol
 *
 * `NotActive` is kept for ABI stability but unreachable post-hard-delete.
 */
export enum BidValidityCode {
    Valid = 0,
    NotFound = 1,
    NotActive = 2,
    Expired = 3,
    InsufficientHbar = 4,
    InsufficientLazy = 5,
}

/**
 * Auction lifecycle state.
 *
 * Source: contracts/interfaces/IEnglishAuction.sol
 *
 * Only `None` and `Open` ever appear in storage — terminal states are
 * event-only because closed auctions hard-delete.
 */
export enum AuctionState {
    None = 0,
    Open = 1,
    Settled = 2,
    Failed = 3,
    Cancelled = 4,
}

/** Auction payment rail. Source: contracts/interfaces/IEnglishAuction.sol */
export enum PaymentToken {
    HBAR = 0,
    LAZY = 1,
}

/**
 * Action verbs an agent envelope can authorize. Used both as
 * `ActionType` enum values and as bit positions in the
 * `allowedActions` bitmap (`1 << uint(action)`).
 *
 * Source: contracts/interfaces/IAgentEnvelope.sol
 *
 * Order is load-bearing — new actions append; never renumber.
 */
export enum ActionType {
    BidCreate = 0,
    BidCancel = 1,
    TradeExecute = 2,
    TradeList = 3,
    TradeCancel = 4,
    Arbitrage = 5,
    AuctionCreate = 6,
    AuctionBid = 7,
    AuctionBuyNow = 8,
}

/**
 * Result of the `canAuthorize` pre-flight view on a stash.
 *
 * Source: contracts/interfaces/IAgentEnvelope.sol
 *
 * `Ok` is the only success value; every other variant maps 1:1 to a
 * revert in the corresponding write path.
 */
export enum AuthFailCode {
    Ok = 0,
    NotFound = 1,
    Paused = 2,
    AllAgentsPaused = 3,
    Expired = 4,
    ActionNotAllowed = 5,
    HbarDailyCapExceeded = 6,
    LazyDailyCapExceeded = 7,
    HbarPerTxCapExceeded = 8,
    LazyPerTxCapExceeded = 9,
}

/**
 * VIPSubscription tier — used for agent slot count + envelope budget caps.
 *
 * Source: contracts/interfaces/IVIPSubscription.sol
 *
 * NOT the same enum as {@link LshTier}. Bronze is a VIP-only tier with no
 * LSH-holdings equivalent.
 */
export enum VipTier {
    Free = 0,
    Bronze = 1,
    Silver = 2,
    Gold = 3,
    Platinum = 4,
}

/**
 * LSH-holdings tier — used for marketplace trade fee discount.
 *
 * Source: contracts/libraries/LSHTierLib.sol
 *
 * NOT the same enum as {@link VipTier}. Silver here = 1, but in VipTier
 * Silver = 2. Never cross-cast.
 */
export enum LshTier {
    Free = 0,
    Silver = 1,
    Gold = 2,
    Platinum = 3,
}

/**
 * Bid record stored in the factory bid registry.
 *
 * Source: contracts/interfaces/IBidderContractFactory.sol#BidDetails
 *
 * Wire shape used by `createBid` and returned by `getBid(bidId)`.
 * Use bigint for the uint256 / uint96 fields when decoding via ethers v6.
 */
export interface BidDetails {
    user: string;
    stash: string;
    hbarAmount: bigint;
    lazyAmount: bigint;
    expiry: bigint;
    token: string;
    serials: bigint[];
    stashNonce: bigint;
    createdAt: bigint;
    minAcceptablePrice: bigint;
    status: BidStatus;
}

/**
 * Per-(stash, agentKey) authorization record. Storage on the stash.
 *
 * Source: contracts/interfaces/IAgentEnvelope.sol#AgentEnvelope
 *
 * Slot layout is documented in the Solidity source — see the slot
 * comments before reordering or renaming any field.
 */
export interface AgentEnvelope {
    agentKey: string;
    expiresAt: bigint;
    allowedActions: number;
    dailyHbarCap: bigint;
    consumedHbarToday: bigint;
    lastResetDay: bigint;
    dailyLazyCap: bigint;
    consumedLazyToday: bigint;
    perTxHbarCap: bigint;
    perTxLazyCap: bigint;
    flags: number;
    reasoningTopicId: string;
}

/** Creation params for `createEnvelope`. Struct-wrapped on-chain to
 *  avoid stack-too-deep — mirror that shape here. */
export interface EnvelopeParams {
    agentKey: string;
    dailyHbarCap: bigint;
    dailyLazyCap: bigint;
    perTxHbarCap: bigint;
    perTxLazyCap: bigint;
    expiresAt: bigint;
    allowedActions: number;
    reasoningTopicId: string;
}

/**
 * Per-VIP-tier limits enforced at envelope-creation time by the stash.
 *
 * Source: contracts/interfaces/IAgentEnvelope.sol#TierLimits
 *
 * Stored on BCF (owner-tunable behind a 48h timelock). `maxAgents == 0`
 * is the legitimate disable signal.
 */
export interface TierLimits {
    maxAgents: number;
    dailyHbarCap: bigint;
    dailyLazyCap: bigint;
    perTxHbarCap: bigint;
    perTxLazyCap: bigint;
    maxExpiryWindow: bigint;
}

/**
 * LST single-trade record. Source: contracts/interfaces/ILazySecureTrade.sol
 */
export interface Trade {
    seller: string;
    buyer: string;
    token: string;
    serial: bigint;
    tinybarPrice: bigint;
    lazyPrice: bigint;
    expiryTime: bigint;
    nonce: bigint;
}

/**
 * LST batch-trade item. Source: contracts/LazySecureTrade.sol
 */
export interface TokenSerialPrice {
    token: string;
    serial: bigint;
    tinybarPrice: bigint;
    lazyPrice: bigint;
}

/** Auction bundle item — NFT (serialOrAmount = serial) or fungible
 *  (serialOrAmount = amount). Source: IEnglishAuction.sol */
export interface AuctionItem {
    token: string;
    isNFT: boolean;
    serialOrAmount: bigint;
}

/** Royalty snapshot frozen at auction creation. One entry per unique
 *  NFT token in the bundle. Source: IEnglishAuction.sol */
export interface RoyaltyInfo {
    token: string;
    collector: string;
    bps: number;
}

/**
 * Aggregated auction read returned by `getAuctionSnapshot`. Source:
 * IEnglishAuction.sol#AuctionSnapshot
 */
export interface AuctionSnapshot {
    seller: string;
    state: AuctionState;
    payment: PaymentToken;
    sellerTierAtCreate: number;
    minStepBps: number;
    antiSnipeWindow: number;
    antiSnipeExtension: number;
    closeAt: bigint;
    maxCloseAt: bigint;
    reservePrice: bigint;
    startPrice: bigint;
    buyNowPrice: bigint;
    highBid: bigint;
    highBidder: string;
    nonce: bigint;
    items: AuctionItem[];
    royalties: RoyaltyInfo[];
    nextMinimumBid: bigint;
    timeRemaining: bigint;
}

/** Auction creation params. Source: IEnglishAuction.sol#AuctionParams */
export interface AuctionParams {
    items: AuctionItem[];
    payment: PaymentToken;
    reservePrice: bigint;
    startPrice: bigint;
    buyNowPrice: bigint;
    duration: bigint;
    minStepBps: number;
    antiSnipeWindow: number;
    antiSnipeExtension: number;
}
