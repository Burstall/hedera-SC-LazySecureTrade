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

	// Optionally register the x402 system wallet now (otherwise run
	// scripts/interactions/setSystemWallet.js later). Accepts a Hedera
	// account id ("0.0.x") or an EVM address ("0x..").
	if (process.env.VIP_SYSTEM_WALLET) {
		const raw = process.env.VIP_SYSTEM_WALLET;
		const systemWalletEvm = raw.startsWith('0x')
			? ethers.getAddress(raw)
			: ethers.getAddress('0x' + AccountId.fromString(raw).toSolidityAddress());
		await contractExecuteFunction(
			vipId, vipIface, client, 200_000, 'setSystemWallet', [systemWalletEvm],
		);
		console.log(`✅ systemWallet set: ${systemWalletEvm}`);
	}

	console.log('\n📝 Add to .env:');
	console.log(`VIP_SUBSCRIPTION_CONTRACT_ID=${vipId.toString()}`);
	console.log('\n📝 Post-deploy wiring (owner must execute):');
	console.log('  setMonthlyPrice(Tier, lazyAmount) for each paid tier');
	console.log('  setDiscount(lshToken, Tier, discountBps, allowedSerials) per (token, tier)');
	console.log('  setSystemWallet(backendWallet) — enables the x402 grant rail');
	console.log('     (skipped here unless VIP_SYSTEM_WALLET is set; or run');
	console.log('      scripts/interactions/setSystemWallet.js)');
	console.log('  Optionally tune: setAnnualPrepayDiscountBps, setMaxCombinedDiscountBps,');
	console.log('                   setBurnPercentage, setCooldownSeconds, setMaxActiveDurationMonths');
	console.log('\n📝 Repoint consumers at the new VIP address (they hold mutable pointers):');
	console.log('  EnglishAuction.setVipSubscription(<new VIP EVM addr>)');
	console.log('  any wired BidderContract stash → setVipSubscription(<new VIP EVM addr>)');

	void vipIface;
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
