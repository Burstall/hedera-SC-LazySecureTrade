/**
 * Deployed contract addresses per Hedera network.
 *
 * Each entry carries both the Hedera account id (string, "0.0.X") for
 * @hashgraph/sdk consumers and the EVM long-zero address (0x...) for
 * ethers consumers.
 *
 * Source of truth for testnet: `.env` cache + `docs/v0.3-WORKING-PLAN.md`.
 * Mainnet is null until the v0.3 deploy lands.
 */

export type HederaNetwork = 'mainnet' | 'testnet' | 'previewnet';

export interface ContractAddress {
    /** Hedera account id, e.g. "0.0.9052246". */
    hederaId: string;
    /** EVM long-zero address, e.g. "0x...008a2056". */
    evmAddress: `0x${string}`;
}

export interface MarketplaceAddresses {
    lazySecureTrade: ContractAddress | null;
    bidderImpl: ContractAddress | null;
    bidderFactory: ContractAddress | null;
    englishAuction: ContractAddress | null;
    vipSubscription: ContractAddress | null;
    /**
     * Staker-rebate stack (v0.3). The pool receives the rebate slice of
     * each subscription purchase; the multipliers contract is a pure-view
     * weight reference. As of SDK 0.2.0 both ship full ABIs + ethers
     * Interfaces (`lazyRebatePoolInterface` / `lshRebateMultipliersInterface`)
     * plus the `RebateEpoch` struct for the frontend claim UI.
     * Subscription-side rebate config lives on `vipSubscription` and is
     * already covered by its ABI.
     */
    lazyRebatePool: ContractAddress | null;
    lshRebateMultipliers: ContractAddress | null;
}

/**
 * Convert a Hedera account id ("0.0.X") to its EVM long-zero address.
 * Only valid for contract accounts; do not use for accounts with
 * ECDSA-derived EVM aliases.
 */
export function hederaIdToEvmAddress(hederaId: string): `0x${string}` {
    const parts = hederaId.split('.');
    if (parts.length !== 3) {
        throw new Error(`Invalid Hedera id: ${hederaId}`);
    }
    const num = Number.parseInt(parts[2]!, 10);
    if (!Number.isFinite(num) || num < 0) {
        throw new Error(`Invalid Hedera id number: ${hederaId}`);
    }
    return `0x${num.toString(16).padStart(40, '0')}` as `0x${string}`;
}

function addr(hederaId: string): ContractAddress {
    return { hederaId, evmAddress: hederaIdToEvmAddress(hederaId) };
}

const TESTNET: MarketplaceAddresses = {
    // Refreshed 2026-06-29 (SDK 0.2.2): full stack redeployed under the
    // refresh operator 0.0.7934339 (the prior stack was 0.0.8891352-owned).
    // VIPSubscription here is the x402-grant build.
    lazySecureTrade: addr('0.0.9367217'),
    bidderImpl: addr('0.0.9367257'),
    bidderFactory: addr('0.0.9367262'),
    englishAuction: addr('0.0.9367272'),
    vipSubscription: addr('0.0.9367578'),
    lazyRebatePool: addr('0.0.9367573'),
    lshRebateMultipliers: addr('0.0.9367358'),
};

const MAINNET: MarketplaceAddresses = {
    lazySecureTrade: null,
    bidderImpl: null,
    bidderFactory: null,
    englishAuction: null,
    vipSubscription: null,
    lazyRebatePool: null,
    lshRebateMultipliers: null,
};

const PREVIEWNET: MarketplaceAddresses = {
    lazySecureTrade: null,
    bidderImpl: null,
    bidderFactory: null,
    englishAuction: null,
    vipSubscription: null,
    lazyRebatePool: null,
    lshRebateMultipliers: null,
};

export const ADDRESSES: Record<HederaNetwork, MarketplaceAddresses> = {
    mainnet: MAINNET,
    testnet: TESTNET,
    previewnet: PREVIEWNET,
};

export function getAddresses(network: HederaNetwork): MarketplaceAddresses {
    return ADDRESSES[network];
}
