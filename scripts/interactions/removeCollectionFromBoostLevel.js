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
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');
const { getLevel, lookupLevel } = require('../../utils/LazyFarmingHelper');

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

const contractName = 'BoostManager';

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
	if (args.length != 3 || getArgFlag('h')) {
		console.log('Usage: removeCollectionToBoostLevel.js 0.0.BBB <rank> 0.0.GGGG1,0.0.GGGG2,0.0.GGGG3');
		console.log('		0.0.BBB is the BoostManager contract to update');
		console.log('		<rank> is the boost level (0 - 5 or C|R|SR|UR|LR|SPE)');
		console.log('		0.0.GGGG is the collection to add to the boost level');
		return;
	}

	const tokenList = args[2].split(',').map((t) => TokenId.fromString(t));

	const contractId = ContractId.fromString(args[0]);
	let rank;
	try {
		rank = getLevel(args[1]);
		// validate rank is 0-5
		if (rank < 0 || rank > 5) {
			throw new Error('Invalid rank');
		}
	}
	catch (err) {
		console.log('ERROR: Must specify a number for amount and percentage', err);
		return;
	}

	console.log('\n-**REMOVING COLLECTION TO BOOST LEVEL**');
	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Rank:', rank, '(', lookupLevel(rank), ')');
	console.log('\n-Collection(s):', tokenList.map((t) => t.toString()).join(', '));

	// import ABI
	const boostManagerJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const boostManagerIface = new ethers.Interface(boostManagerJSON.abi);


	const proceed = readlineSync.keyInYNStrict('Do you want to update the Gem Collections?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	// for each token in the list, add it to the boost level
	for (const token of tokenList) {
		const result = await contractExecuteFunction(
			contractId,
			boostManagerIface,
			client,
			300_000,
			'removeCollectionFromBoostLevel',
			[rank, token.toSolidityAddress()],
		);

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('Error adding:', token.toString(), result);
			return;
		}

		console.log(`Gem ${token.toString()} added to Level ${getLevel(rank)}. Transaction ID:`, result[2]?.transactionId?.toString());
	}
};

main()
	.then(() => {
		// eslint-disable-next-line no-useless-escape
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
