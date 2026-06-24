/**
 * Pre-built ethers `Interface` instances per marketplace contract.
 *
 * Consumers use these for:
 *   - calldata encoding (`iface.encodeFunctionData(...)`),
 *   - mirror-node return-data decoding (`iface.decodeFunctionResult(...)`),
 *   - event topic computation (`iface.getEvent(...).topicHash`),
 *   - log decoding (`iface.parseLog({ topics, data })`).
 *
 * Instances are constructed lazily so consumers who only need one
 * contract don't pay the parsing cost for all seven.
 */

import { Interface } from 'ethers';
import {
    LazySecureTradeAbi,
    BidderContractFactoryAbi,
    BidderContractAbi,
    EnglishAuctionAbi,
    VIPSubscriptionAbi,
    LazyRebatePoolAbi,
    LSHRebateMultipliersAbi,
    LazyGasStationAbi,
} from '../abi';

let _lst: Interface | null = null;
let _bcf: Interface | null = null;
let _stash: Interface | null = null;
let _ea: Interface | null = null;
let _vip: Interface | null = null;
let _rebatePool: Interface | null = null;
let _rebateMultipliers: Interface | null = null;
let _gasStation: Interface | null = null;

export function lazySecureTradeInterface(): Interface {
    if (!_lst) _lst = new Interface(LazySecureTradeAbi as never);
    return _lst;
}

export function bidderContractFactoryInterface(): Interface {
    if (!_bcf) _bcf = new Interface(BidderContractFactoryAbi as never);
    return _bcf;
}

export function bidderContractInterface(): Interface {
    if (!_stash) _stash = new Interface(BidderContractAbi as never);
    return _stash;
}

export function englishAuctionInterface(): Interface {
    if (!_ea) _ea = new Interface(EnglishAuctionAbi as never);
    return _ea;
}

export function vipSubscriptionInterface(): Interface {
    if (!_vip) _vip = new Interface(VIPSubscriptionAbi as never);
    return _vip;
}

export function lazyRebatePoolInterface(): Interface {
    if (!_rebatePool) _rebatePool = new Interface(LazyRebatePoolAbi as never);
    return _rebatePool;
}

export function lshRebateMultipliersInterface(): Interface {
    if (!_rebateMultipliers) {
        _rebateMultipliers = new Interface(LSHRebateMultipliersAbi as never);
    }
    return _rebateMultipliers;
}

/**
 * Shared-dependency Interface. LazyGasStation is not a marketplace contract,
 * but LST/factory flows fan into it (drawLazyFrom, refills) and a revert
 * there bubbles up a LazyGasStation custom error. Use this to decode such
 * reverts: `lazyGasStationInterface().parseError(revertData)` resolves names
 * like `InsufficientAllowance` / `PayoutFailed` that the marketplace ABIs
 * alone cannot.
 */
export function lazyGasStationInterface(): Interface {
    if (!_gasStation) _gasStation = new Interface(LazyGasStationAbi as never);
    return _gasStation;
}

export const INTERFACES = {
    LazySecureTrade: lazySecureTradeInterface,
    BidderContractFactory: bidderContractFactoryInterface,
    BidderContract: bidderContractInterface,
    EnglishAuction: englishAuctionInterface,
    VIPSubscription: vipSubscriptionInterface,
    LazyRebatePool: lazyRebatePoolInterface,
    LSHRebateMultipliers: lshRebateMultipliersInterface,
    LazyGasStation: lazyGasStationInterface,
} as const;
