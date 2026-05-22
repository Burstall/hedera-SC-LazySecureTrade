// Deploy VIPSubscription standalone.
//
// Requires LAZY_TOKEN_ID + LAZY_GAS_STATION_CONTRACT_ID in .env. The
// contract is independent of LST + BCF — no on-chain v0.3 trade-path
// consumers. Reads are intended for the agent runtime + frontend.
//
// Post-deploy:
//   1. LazyGasStation.addContractUser(<vipAddress>) — so the contract
//      can call drawLazyFrom. Operator-only action.
//   2. setMonthlyPrice(tier, lazyAmount) per tier — owner sets initial
//      monthly prices.
//   3. setDiscount(token, tier, bps, allowedSerials) for each LSH token
//      × paid tier discount entry.
//
// Usage:
//   node scripts/deployments/deployVIPSubscription.js

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');
const { contractDeployFunction, contractExecuteFunction } = require('../../utils/solidityHelpers');
const { ethers } = require('ethers');
require('dotenv').config();

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
	const lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);

	console.log('--- VIPSubscription deploy ---');
	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('LAZY Token:', lazyTokenId.toString());
	console.log('LazyGasStation:', lazyGasStationId.toString());

	const vipJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/VIPSubscription.sol/VIPSubscription.json', 'utf8',
	));
	const vipIface = new ethers.Interface(vipJson.abi);
	const params = new ContractFunctionParameters()
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(lazyGasStationId.toSolidityAddress());

	const [vipId, vipAddr] = await contractDeployFunction(client, vipJson.bytecode, 3_500_000, params);
	console.log(`\n✅ VIPSubscription deployed: ${vipId.toString()} / ${vipAddr}`);

	// Authorize VIPSubscription as a contract user on LGS so it can
	// pull LAZY via drawLazyFrom.
	const lgsJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json', 'utf8',
	));
	const lgsIface = new ethers.Interface(lgsJson.abi);
	await contractExecuteFunction(
		lazyGasStationId, lgsIface, client, 200_000,
		'addContractUser', [vipId.toSolidityAddress()],
	);
	console.log('✅ VIPSubscription registered as LGS contract user');

	console.log('\n📝 Add to .env:');
	console.log(`VIP_SUBSCRIPTION_CONTRACT_ID=${vipId.toString()}`);
	console.log('\n📝 Post-deploy wiring (owner must execute):');
	console.log('  setMonthlyPrice(Tier, lazyAmount) for each paid tier');
	console.log('  setDiscount(lshToken, Tier, discountBps, allowedSerials) per (token, tier)');
	console.log('  Optionally tune: setAnnualPrepayDiscountBps, setMaxCombinedDiscountBps,');
	console.log('                   setBurnPercentage, setCooldownSeconds, setMaxActiveDurationMonths');

	void vipIface;
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
