/**
 * @lazysuperheroes/marketplace-sdk
 *
 * TypeScript SDK for the LazySecureTrade marketplace on Hedera:
 * LazySecureTrade (LST), BidderContractFactory + BidderContract (stash),
 * EnglishAuction, VIPSubscription.
 *
 * v0.1 — transport primitives only (ABIs, addresses, ethers Interfaces,
 * typed enums + structs, AgentAuth helper). Write-path TransactionRequest
 * builders and mirror-node read helpers land in v0.2 alongside the
 * agent runtime — see README for the full deferred list.
 *
 * @example
 * ```typescript
 * import {
 *     getAddresses,
 *     bidderContractFactoryInterface,
 *     EMPTY_AUTH,
 *     buildAgentAuth,
 *     BidStatus,
 * } from '@lazysuperheroes/marketplace-sdk';
 *
 * const { bidderFactory } = getAddresses('testnet');
 * const iface = bidderContractFactoryInterface();
 * const calldata = iface.encodeFunctionData('cancelBid', [bidId, EMPTY_AUTH]);
 * ```
 */

// ABIs
export {
    ABIS,
    LazySecureTradeAbi,
    BidderContractFactoryAbi,
    BidderContractAbi,
    EnglishAuctionAbi,
    VIPSubscriptionAbi,
} from './abi';
export type { ContractName } from './abi';

// Contract addresses
export {
    ADDRESSES,
    getAddresses,
    hederaIdToEvmAddress,
} from './contracts/addresses';
export type {
    HederaNetwork,
    ContractAddress,
    MarketplaceAddresses,
} from './contracts/addresses';

// Ethers Interfaces
export {
    INTERFACES,
    lazySecureTradeInterface,
    bidderContractFactoryInterface,
    bidderContractInterface,
    englishAuctionInterface,
    vipSubscriptionInterface,
} from './contracts/interfaces';

// AgentAuth helpers
export {
    AGENT_AUTH_TUPLE_TYPE,
    EMPTY_AUTH,
    buildAgentAuth,
} from './helpers/agentAuth';

// Types + enums
export {
    BidStatus,
    BidValidityCode,
    AuctionState,
    PaymentToken,
    ActionType,
    AuthFailCode,
    VipTier,
    LshTier,
} from './types';
export type {
    AgentAuth,
    BidDetails,
    AgentEnvelope,
    EnvelopeParams,
    TierLimits,
    Trade,
    TokenSerialPrice,
    AuctionItem,
    RoyaltyInfo,
    AuctionSnapshot,
    AuctionParams,
} from './types';
