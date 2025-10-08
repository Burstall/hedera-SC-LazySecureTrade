const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');

// Get operator from .env file
let operatorKey;
let operatorId;
try {
	operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
}

const contractName = 'LazySecureTrade';

const env = process.env.ENVIRONMENT ?? null;
let client;

const main = async () => {
	// configure the client object
	if (
		operatorKey === undefined ||
		operatorKey == null ||
		operatorId === undefined ||
		operatorId == null
	) {
		console.log(
			'Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file',
		);
		process.exit(1);
	}

	if (env.toUpperCase() == 'TEST') {
		client = Client.forTestnet();
		console.log('testing in *TESTNET*');
	}
	else if (env.toUpperCase() == 'MAIN') {
		client = Client.forMainnet();
		console.log('testing in *MAINNET*');
	}
	else if (env.toUpperCase() == 'PREVIEW') {
		client = Client.forPreviewnet();
		console.log('testing in *PREVIEWNET*');
	}
	else if (env.toUpperCase() == 'LOCAL') {
		const node = { '127.0.0.1:50211': new AccountId(3) };
		client = Client.forNetwork(node).setMirrorNetwork('127.0.0.1:5600');
		console.log('testing in *LOCAL*');
	}
	else {
		console.log(
			'ERROR: Must specify either MAIN or TEST or LOCAL as environment in .env file',
		);
		return;
	}

	client.setOperator(operatorId, operatorKey);

	const args = process.argv.slice(2);
	if (args.length < 1 || args.length > 2 || getArgFlag('h')) {
		console.log('Usage: checkLSHBenefits.js 0.0.LST [userAddress]');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		userAddress is optional - if not provided, uses operator address');
		console.log('		Example: checkLSHBenefits.js 0.0.123456');
		console.log('		Example: checkLSHBenefits.js 0.0.123456 0.0.654321');
		return;
	}

	// import ABI
	const lstJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lstIface = ethers.Interface.from(lstJSON.abi);
	const contractId = ContractId.fromString(args[0]);

	let userAddress;
	let userDisplayId;
	if (args.length === 2) {
		const userId = AccountId.fromString(args[1]);
		userAddress = userId.toSolidityAddress();
		userDisplayId = userId.toString();
	}
	else {
		userAddress = operatorId.toSolidityAddress();
		userDisplayId = operatorId.toString();
	}

	console.log('\n-Using LST Contract:', contractId.toString());
	console.log('-Checking LSH benefits for user:', userDisplayId);

	// Get LSH tier
	console.log('\n=== LSH Token Tier Analysis ===');
	const eCTier = lstIface.encodeFunctionData('getLSHTokenTier', [userAddress]);
	const cSTier = await readOnlyEVMFromMirrorNode(env, contractId, eCTier, operatorId, false);
	const lshTier = Number(lstIface.decodeFunctionResult('getLSHTokenTier', cSTier)[0]);

	const tierDescriptions = {
		0: 'No LSH tokens (Standard user)',
		1: 'LSH Gen2 holder (50% discount)',
		2: 'LSH Mutant holder (75% discount)',
		3: 'LSH Gen1 holder (100% discount - FREE trades)',
	};

	console.log(`LSH Tier: ${lshTier} - ${tierDescriptions[lshTier] || 'Unknown tier'}`);

	// Check if advanced trades are free
	const eCFree = lstIface.encodeFunctionData('areAdvancedTradesFree', [userAddress]);
	const cSFree = await readOnlyEVMFromMirrorNode(env, contractId, eCFree, operatorId, false);
	const areTradesFree = lstIface.decodeFunctionResult('areAdvancedTradesFree', cSFree)[0];

	console.log(`Advanced trades are FREE: ${areTradesFree ? '✅ YES' : '❌ NO'}`);

	// Get fee configuration
	console.log('\n=== Fee Structure ===');

	const eCBaseFee = lstIface.encodeFunctionData('baseFeeRate', []);
	const cSBaseFee = await readOnlyEVMFromMirrorNode(env, contractId, eCBaseFee, operatorId, false);
	const baseFeeRate = Number(lstIface.decodeFunctionResult('baseFeeRate', cSBaseFee)[0]);

	const eCGen2Discount = lstIface.encodeFunctionData('lshGen2Discount', []);
	const cSGen2Discount = await readOnlyEVMFromMirrorNode(env, contractId, eCGen2Discount, operatorId, false);
	const gen2Discount = Number(lstIface.decodeFunctionResult('lshGen2Discount', cSGen2Discount)[0]);

	const eCMutantDiscount = lstIface.encodeFunctionData('lshMutantDiscount', []);
	const cSMutantDiscount = await readOnlyEVMFromMirrorNode(env, contractId, eCMutantDiscount, operatorId, false);
	const mutantDiscount = Number(lstIface.decodeFunctionResult('lshMutantDiscount', cSMutantDiscount)[0]);

	const eCGen1Discount = lstIface.encodeFunctionData('lshGen1Discount', []);
	const cSGen1Discount = await readOnlyEVMFromMirrorNode(env, contractId, eCGen1Discount, operatorId, false);
	const gen1Discount = Number(lstIface.decodeFunctionResult('lshGen1Discount', cSGen1Discount)[0]);

	console.log(`Base fee rate (non-LSH holders): ${baseFeeRate} basis points (${baseFeeRate / 100}%)`);
	console.log(`LSH Gen2 discount: ${gen2Discount}% (effective fee: ${(baseFeeRate * (100 - gen2Discount)) / 10000}%)`);
	console.log(`LSH Mutant discount: ${mutantDiscount}% (effective fee: ${(baseFeeRate * (100 - mutantDiscount)) / 10000}%)`);
	console.log(`LSH Gen1 discount: ${gen1Discount}% (effective fee: ${(baseFeeRate * (100 - gen1Discount)) / 10000}%)`);

	// Calculate effective fee for this user
	let effectiveFeeRate;
	switch (lshTier) {
	case 0:
		effectiveFeeRate = baseFeeRate;
		break;
	case 1:
		effectiveFeeRate = baseFeeRate * (100 - gen2Discount) / 100;
		break;
	case 2:
		effectiveFeeRate = baseFeeRate * (100 - mutantDiscount) / 100;
		break;
	case 3:
		effectiveFeeRate = baseFeeRate * (100 - gen1Discount) / 100;
		break;
	default:
		effectiveFeeRate = baseFeeRate;
	}

	console.log(`\n🎯 YOUR EFFECTIVE FEE RATE: ${effectiveFeeRate} basis points (${effectiveFeeRate / 100}%)`);

	// Get LAZY cost for trades
	const eCLazyCost = lstIface.encodeFunctionData('lazyCostForTrade', []);
	const cSLazyCost = await readOnlyEVMFromMirrorNode(env, contractId, eCLazyCost, operatorId, false);
	const lazyCostForTrade = Number(lstIface.decodeFunctionResult('lazyCostForTrade', cSLazyCost)[0]);

	console.log('\n=== $LAZY Token Costs ===');
	console.log(`$LAZY cost per open market trade: ${lazyCostForTrade} tokens`);
	console.log(`$LAZY cost applies to: ${areTradesFree ? 'NONE (you have LSH benefits!)' : 'Open market trade creation'}`);

	// Show practical examples
	console.log('\n=== Practical Examples ===');

	// HBAR examples
	const examplePrices = [1, 10, 100];

	console.log('For HBAR trades (open market):');
	for (const price of examplePrices) {
		const feeAmount = (price * effectiveFeeRate) / 10000;
		const netToSeller = price - feeAmount;
		console.log(`  ${price} HBAR sale → Fee: ${feeAmount.toFixed(4)} HBAR, Seller gets: ${netToSeller.toFixed(4)} HBAR`);
	}

	if (!areTradesFree && lazyCostForTrade > 0) {
		console.log(`\nPlus ${lazyCostForTrade} $LAZY tokens per trade creation (burned)`);
	}

	console.log('\nFor $LAZY token trades: NO FEES (seller gets full amount)');
	console.log('For private trades (specific buyer): NO FEES');

	// Show tier upgrade benefits
	if (lshTier < 3) {
		console.log('\n💡 UPGRADE BENEFITS:');
		if (lshTier === 0) {
			console.log('  • Get LSH Gen2 → Save 50% on fees + free trade creation');
			console.log('  • Get LSH Mutant → Save 75% on fees + free trade creation');
			console.log('  • Get LSH Gen1 → FREE trades + free trade creation');
		}
		else if (lshTier === 1) {
			console.log('  • Get LSH Mutant → Save additional 25% on fees');
			console.log('  • Get LSH Gen1 → FREE trades');
		}
		else if (lshTier === 2) {
			console.log('  • Get LSH Gen1 → FREE trades');
		}
	}
	else {
		console.log('\n🎉 You have maximum LSH benefits - all trades are FREE!');
	}
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});