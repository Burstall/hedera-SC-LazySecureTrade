const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag, isBytes32 } = require('../../utils/nodeHelpers');

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
	if (args.length < 2 || getArgFlag('h')) {
		console.log('Usage: cancelTrades.js 0.0.LST [-i | hash1 hash2 ...]');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		-i to interactively enter tokens/serials to obtain hashes');
		console.log('		hash1 hash2 ... are the hashes of the trades to cancel');
		console.log('		Example: cancelTrades.js 0.0.123456 0xabc123... 0xdef456...');
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

	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using LST Contract:', contractId.toString());

	let hashes = [];

	if (getArgFlag('i')) {
		// Interactive mode - get trade hashes from token/serial pairs
		console.log('\n=== Interactive Mode ===');
		const numTrades = parseInt(readlineSync.question('How many trades to cancel? '));

		if (numTrades <= 0 || numTrades > 10) {
			console.log('ERROR: Number of trades must be between 1 and 10');
			return;
		}

		for (let i = 0; i < numTrades; i++) {
			console.log(`\n--- Trade ${i + 1} ---`);
			const tokenToCancel = readlineSync.question('Enter the token address: ');
			const serialToCancel = readlineSync.question('Enter the serial number: ');

			const token = TokenId.fromString(tokenToCancel);
			const serial = parseInt(serialToCancel);

			console.log('-Using Token:', token.toString());
			console.log('-Using Serial:', serial);

			const hash = ethers.solidityPackedKeccak256(['address', 'uint256'], [token.toSolidityAddress(), serial]);
			hashes.push(hash);

			console.log('-Generated Hash:', hash);
		}
	}
	else {
		// Use provided hashes
		hashes = args.slice(1);

		// Validate all hashes
		for (const hash of hashes) {
			if (!isBytes32(hash)) {
				console.log(`ERROR: Invalid hash format: ${hash}`);
				return;
			}
		}
	}

	console.log(`\n-Cancelling ${hashes.length} trades with hashes:`, hashes);

	// Verify all trades exist and user can cancel them
	console.log('\n=== Verifying Trades ===');
	for (let i = 0; i < hashes.length; i++) {
		const hash = hashes[i];
		console.log(`\nChecking trade ${i + 1}: ${hash}`);

		const eC = lstIface.encodeFunctionData('getTrade', [hash]);
		const cS = await readOnlyEVMFromMirrorNode(env, contractId, eC, operatorId, false);
		const tradeDets = lstIface.decodeFunctionResult('getTrade', cS)[0];

		// check if the trade exists [seller <> ZeroAddress]
		if (tradeDets[0] == ethers.ZeroAddress) {
			console.log(`ERROR: Trade ${i + 1} does not exist - exiting`);
			return;
		}

		// check if user is seller or buyer
		const isSeller = tradeDets[0].slice(2).toLowerCase() == operatorId.toSolidityAddress();
		const isBuyer = tradeDets[1].slice(2).toLowerCase() == operatorId.toSolidityAddress();

		if (!isSeller && !isBuyer) {
			console.log(`ERROR: Operator is not the seller or buyer for trade ${i + 1} - unable to cancel - exiting`);
			return;
		}

		console.log(`✓ Trade ${i + 1} verified - can cancel`);
		console.log(`  Seller: ${tradeDets[0]}`);
		console.log(`  Buyer: ${tradeDets[1]}`);
		console.log(`  Token: ${tradeDets[2]}`);
		console.log(`  Serial: ${tradeDets[3]}`);
	}

	const proceed = readlineSync.keyInYNStrict(`Do you want to cancel all ${hashes.length} trades?`);
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	// Base gas + per trade gas
	const gas = 300_000 + (hashes.length * 50_000);

	console.log('\n=== Executing Batch Cancel ===');
	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'cancelTrades',
		[hashes],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error cancelling trades:', result);
		return;
	}

	console.log(`✓ ${hashes.length} trades cancelled successfully!`);
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});