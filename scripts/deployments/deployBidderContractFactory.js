const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');
const { contractDeployFunction } = require('../../utils/solidityHelpers');
require('dotenv').config();

async function main() {
	// Get operator from .env file
	let operatorKey;
	let operatorId;
	try {
		operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
		operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	}
	catch (err) {
		console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
		process.exit(1);
	}

	// Get required contract addresses from .env.
	// Canonical names match the rest of the repo (LAZY_*_CONTRACT_ID).
	// Legacy short-form names (LST_CONTRACT_ID / LGS_CONTRACT_ID / LDR_CONTRACT_ID)
	// are still accepted as fallbacks with a deprecation notice.
	function readEnvWithFallback(canonical, legacy, label) {
		if (process.env[canonical]) {
			return process.env[canonical];
		}
		if (process.env[legacy]) {
			console.log(`WARN: ${legacy} is deprecated — please rename to ${canonical} in your .env (used for ${label})`);
			return process.env[legacy];
		}
		return null;
	}

	const lstRaw = readEnvWithFallback('LAZY_SECURE_TRADE_CONTRACT_ID', 'LST_CONTRACT_ID', 'LazySecureTrade');
	const lgsRaw = readEnvWithFallback('LAZY_GAS_STATION_CONTRACT_ID', 'LGS_CONTRACT_ID', 'LazyGasStation');
	const ldrRaw = readEnvWithFallback('LAZY_DELEGATE_REGISTRY_CONTRACT_ID', 'LDR_CONTRACT_ID', 'LazyDelegateRegistry');

	const lstContractId = lstRaw ? ContractId.fromString(lstRaw) : null;
	const lazyTokenId = process.env.LAZY_TOKEN_ID ? TokenId.fromString(process.env.LAZY_TOKEN_ID) : null;
	const lazyGasStationId = lgsRaw ? ContractId.fromString(lgsRaw) : null;
	const lazyDelegateRegistryId = ldrRaw ? ContractId.fromString(ldrRaw) : null;

	if (!lstContractId || !lazyTokenId || !lazyGasStationId) {
		console.log('ERROR: Must specify LAZY_SECURE_TRADE_CONTRACT_ID, LAZY_TOKEN_ID, and LAZY_GAS_STATION_CONTRACT_ID in .env file');
		process.exit(1);
	}

	// LazyDelegateRegistry is optional (use placeholder if not provided)
	const ldrAddress = lazyDelegateRegistryId
		? lazyDelegateRegistryId.toSolidityAddress()
		: '0x0000000000000000000000000000000000000167';

	// Honour ENVIRONMENT so this never silently misdeploys to testnet on a mainnet run.
	const env = process.env.ENVIRONMENT ?? null;
	if (!env) {
		console.log('ERROR: ENVIRONMENT must be set (test|main|preview|local) in .env');
		process.exit(1);
	}

	let client;
	if (env.toUpperCase() === 'TEST') {
		client = Client.forTestnet();
	}
	else if (env.toUpperCase() === 'MAIN') {
		client = Client.forMainnet();
	}
	else if (env.toUpperCase() === 'PREVIEW') {
		client = Client.forPreviewnet();
	}
	else if (env.toUpperCase() === 'LOCAL') {
		const node = { '127.0.0.1:50211': new AccountId(3) };
		client = Client.forNetwork(node).setMirrorNetwork('127.0.0.1:5600');
	}
	else {
		console.log(`ERROR: Invalid ENVIRONMENT '${env}'. Must be one of test|main|preview|local.`);
		process.exit(1);
	}
	client.setOperator(operatorId, operatorKey);

	console.log('\n=== Deploying BidderContract Implementation ===');
	console.log('Network:', env.toUpperCase());
	console.log('Operator:', operatorId.toString());
	console.log('LazySecureTrade:', lstContractId.toString());
	console.log('$LAZY Token:', lazyTokenId.toString());
	console.log('LazyGasStation:', lazyGasStationId.toString());
	console.log('LazyDelegateRegistry:', lazyDelegateRegistryId ? lazyDelegateRegistryId.toString() : 'Placeholder');

	// Deploy BidderContract implementation
	console.log('\n--- Deploying BidderContract Implementation ---');
	const bidderContractJson = JSON.parse(
		fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json', 'utf8'),
	);
	const bidderContractByteCode = bidderContractJson.bytecode;

	const bidderContractImplId = await contractDeployFunction(
		client,
		bidderContractByteCode,
		1500000,
		new ContractFunctionParameters(),
	);

	console.log('✅ BidderContract Implementation deployed:', bidderContractImplId.toString());

	// Deploy BidderContractFactory
	console.log('\n--- Deploying BidderContractFactory ---');
	const factoryJson = JSON.parse(
		fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8'),
	);
	const factoryByteCode = factoryJson.bytecode;

	const constructorParams = new ContractFunctionParameters()
		.addAddress(lstContractId.toSolidityAddress())
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(lazyGasStationId.toSolidityAddress())
		.addAddress(ldrAddress)
		.addAddress(bidderContractImplId.toSolidityAddress());

	const factoryContractId = await contractDeployFunction(
		client,
		factoryByteCode,
		1500000,
		constructorParams,
	);

	console.log('✅ BidderContractFactory deployed:', factoryContractId.toString());

	// Summary
	console.log('\n=== Deployment Complete ===');
	console.log('BidderContract Implementation:', bidderContractImplId.toString());
	console.log('BidderContractFactory:', factoryContractId.toString());
	console.log('\n📝 Add to your .env file:');
	console.log(`BIDDER_CONTRACT_IMPL_ID=${bidderContractImplId.toString()}`);
	console.log(`BIDDER_FACTORY_CONTRACT_ID=${factoryContractId.toString()}`);

	// Post-deploy wiring reminder. These calls must be made by the LST
	// owner — this script can't make them blindly because LST ownership
	// may live on a multisig.
	console.log('\n📝 Post-deploy wiring (LST owner must execute):');
	console.log(`  LST.authorizeFactory(${factoryContractId.toString()}, true)`);
	console.log(`  LST.setBcf(${factoryContractId.toString()})  // Phase 1: enables beneficial-owner resolution`);
	console.log(`  LazyGasStation.addContractUser(${factoryContractId.toString()})`);
	console.log('\nWithout setBcf, stash-listed trades silently fall back to');
	console.log('charging the stash\'s zero LSH tier (Bug 3). Don\'t skip it.');

	// Agent envelope tier table — first-call-per-tier is INSTANT, so a
	// fresh deploy can wire all 5 tiers in one operator session before
	// users begin creating envelopes. Every subsequent setAgentTierLimits
	// call is 48h-timelocked (apply via executeAgentTierLimitsChange).
	//
	// Defaults locked in docs/v0.3-WORKING-PLAN.md "Agent envelopes on BCF":
	//   - Free:      no envelopes (zero-filled, left at storage default)
	//   - Bronze:    1 agent, 500 HBAR / 5K LAZY daily, 200/2K per-tx
	//   - Silver:    2 agents, 1500/15K daily, 500/5K per-tx
	//   - Gold:      3 agents, 3500/35K daily, 1000/10K per-tx
	//   - Platinum:  5 agents, 10K/100K daily, 2500/25K per-tx
	console.log('\n📝 Agent envelope tier table (factory OWNER must execute):');
	console.log('  BCF.setAgentTierLimits(Tier, TierLimits) — once per tier (instant first call).');
	console.log('  See docs/v0.3-OPS-RUNBOOK.md §9 for the default table + adjustment runbook.');

	await client.close();
	process.exit(0);
}

main()
	.then(() => {
		console.log('\n✅ Deployment script completed successfully');
	})
	.catch((error) => {
		console.error('\n❌ Deployment failed:', error);
		process.exit(1);
	});
