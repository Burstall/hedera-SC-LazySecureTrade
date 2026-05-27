// Deploy LSHRebateMultipliers — pure-view reference contract for the
// staker rebate weight table.
//
// Requires the three LSH token addresses in .env:
//   LSH_GEN1_TOKEN_ID            — Gen 1 token id
//   LSH_GEN1_MUTANT_TOKEN_ID     — Mutant token id
//   LSH_GEN2_TOKEN_ID            — Gen 2 token id (LSV is serials 5001-5100 of this)
//
// Constructor bakes the addresses as immutables — a new deploy is
// required to change any of them.
//
// Usage:
//   node scripts/deployments/deployLshRebateMultipliers.js

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	TokenId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const { contractDeployFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { sleep } = require('../../utils/nodeHelpers');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5500;

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	// Required token IDs
	const requiredKeys = ['LSH_GEN1_TOKEN_ID', 'LSH_GEN1_MUTANT_TOKEN_ID', 'LSH_GEN2_TOKEN_ID'];
	const missing = requiredKeys.filter((k) => !process.env[k]);
	if (missing.length) {
		console.error(`Missing required .env keys: ${missing.join(', ')}`);
		console.error('LSHRebateMultipliers bakes these as immutables. Populate and re-run.');
		process.exit(1);
	}

	const lshGen1 = TokenId.fromString(process.env.LSH_GEN1_TOKEN_ID);
	const lshMutant = TokenId.fromString(process.env.LSH_GEN1_MUTANT_TOKEN_ID);
	const lshGen2 = TokenId.fromString(process.env.LSH_GEN2_TOKEN_ID);

	console.log('--- LSHRebateMultipliers deploy ---');
	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('LSH Gen1:  ', lshGen1.toString());
	console.log('LSH Mutant:', lshMutant.toString());
	console.log('LSH Gen2:  ', lshGen2.toString());

	const mJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/LSHRebateMultipliers.sol/LSHRebateMultipliers.json', 'utf8',
	));
	const mIface = new ethers.Interface(mJson.abi);

	const params = new ContractFunctionParameters()
		.addAddress(lshGen1.toSolidityAddress())
		.addAddress(lshMutant.toSolidityAddress())
		.addAddress(lshGen2.toSolidityAddress());

	const [mId, mAddr] = await contractDeployFunction(
		client, mJson.bytecode, 800_000, params,
	);
	console.log(`\nLSHRebateMultipliers deployed: ${mId.toString()} / ${mAddr}`);

	await sleep(MIRROR_DELAY);

	// Sanity-check the immutables landed correctly via mirror.
	const verify = async (fcn) => {
		const enc = mIface.encodeFunctionData(fcn, []);
		const raw = await readOnlyEVMFromMirrorNode(env, mId, enc, operatorId, false);
		return mIface.decodeFunctionResult(fcn, raw)[0];
	};

	const onChainGen1 = await verify('LSH_GEN1');
	const onChainMutant = await verify('LSH_MUTANT');
	const onChainGen2 = await verify('LSH_GEN2');

	const expectedGen1 = '0x' + lshGen1.toSolidityAddress();
	const expectedMutant = '0x' + lshMutant.toSolidityAddress();
	const expectedGen2 = '0x' + lshGen2.toSolidityAddress();

	console.log('\nImmutable verification:');
	console.log('  LSH_GEN1  ', onChainGen1.toLowerCase() === expectedGen1.toLowerCase() ? 'OK' : `MISMATCH ${onChainGen1} vs ${expectedGen1}`);
	console.log('  LSH_MUTANT', onChainMutant.toLowerCase() === expectedMutant.toLowerCase() ? 'OK' : `MISMATCH ${onChainMutant} vs ${expectedMutant}`);
	console.log('  LSH_GEN2  ', onChainGen2.toLowerCase() === expectedGen2.toLowerCase() ? 'OK' : `MISMATCH ${onChainGen2} vs ${expectedGen2}`);

	// Smoke-test the multiplier table
	const gen1Mult = mIface.decodeFunctionResult(
		'getMultiplier',
		await readOnlyEVMFromMirrorNode(env, mId, mIface.encodeFunctionData('getMultiplier', [expectedGen1, 1]), operatorId, false),
	)[0];
	const lsvMult = mIface.decodeFunctionResult(
		'getMultiplier',
		await readOnlyEVMFromMirrorNode(env, mId, mIface.encodeFunctionData('getMultiplier', [expectedGen2, 5050]), operatorId, false),
	)[0];
	const gen2BaseMult = mIface.decodeFunctionResult(
		'getMultiplier',
		await readOnlyEVMFromMirrorNode(env, mId, mIface.encodeFunctionData('getMultiplier', [expectedGen2, 100]), operatorId, false),
	)[0];

	console.log('\nMultiplier smoke test:');
	console.log(`  Gen1 serial 1   = ${gen1Mult} (expected 50)`);
	console.log(`  Gen2 serial 5050= ${lsvMult} (expected 25 — LSV range)`);
	console.log(`  Gen2 serial 100 = ${gen2BaseMult} (expected 10 — base)`);

	console.log('\nAdd to .env:');
	console.log(`LSH_REBATE_MULTIPLIERS_CONTRACT_ID=${mId.toString()}`);

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
