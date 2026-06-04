'use strict';

/**
 * hedera-verify config for LazySecureTrade.
 *
 * Maps each contract to the .env var(s) that may hold its deployed Hedera ID
 * (first present wins). Read by the harness — `node scripts/testing/verifyHarness.js`,
 * `yarn verify-harness`, and `npx hedera-verify harness|list`. `env` is taken
 * from ENVIRONMENT in .env unless overridden here or with --env.
 *
 * Run `npx hedera-verify list-artifacts` to see every compiled contract name +
 * sourceName when adding entries.
 */

module.exports = {
	registry: [
		{ contractName: 'LazySecureTrade', envVars: ['LAZY_SECURE_TRADE_CONTRACT_ID', 'LST_CONTRACT_ID'] },
		{ contractName: 'BidderContractFactory', envVars: ['BIDDER_FACTORY_CONTRACT_ID'] },
		{ contractName: 'BidderContract', envVars: ['BIDDER_IMPL_CONTRACT_ID', 'BIDDER_CONTRACT_IMPL_ID'] },
		{ contractName: 'LazyGasStation', envVars: ['LAZY_GAS_STATION_CONTRACT_ID', 'LGS_CONTRACT_ID'] },
		{ contractName: 'LazyDelegateRegistry', envVars: ['LAZY_DELEGATE_REGISTRY_CONTRACT_ID', 'LDR_CONTRACT_ID'] },
		{
			contractName: 'LAZYTokenCreator',
			envVars: ['LAZY_SCT_CONTRACT_ID'],
			sourceName: 'contracts/legacy/LAZYTokenCreator.sol',
		},
	],
};
