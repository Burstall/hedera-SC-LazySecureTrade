/**
 * @lazysuperheroes/marketplace-sdk
 *
 * TypeScript SDK for the LazySecureTrade marketplace on Hedera:
 * LazySecureTrade (LST), BidderContractFactory + BidderContract (stash),
 * EnglishAuction, VIPSubscription.
 *
 * v0.2 — transport primitives only (ABIs, addresses, ethers Interfaces,
 * typed enums + structs, AgentAuth helper), now spanning the full v0.3
 * contract surface including the staker-rebate stack (LazyRebatePool +
 * LSHRebateMultipliers). Write-path TransactionRequest builders and
 * mirror-node read helpers land in a later release alongside the agent
 * runtime — see README for the full deferred list.
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
    LazyRebatePoolAbi,
    LSHRebateMultipliersAbi,
    LazyGasStationAbi,
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
    lazyRebatePoolInterface,
    lshRebateMultipliersInterface,
    lazyGasStationInterface,
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
    RebateEpoch,
} from './types';
