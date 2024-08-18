const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
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

const contractName = 'Mission';

const env = process.env.ENVIRONMENT ?? null;
const LAZY_DECIMALS = process.env.LAZY_DECIMALS ?? 1;
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
	if (args.length != 5 || getArgFlag('h')) {
		console.log('Usage: setDecreasingEntryFee.js 0.0.MMMM <start> <min> <decrement> <interval>');
		console.log('		MMM is the mission address');
		console.log('		<start> is the start timestamps');
		console.log('		<min> is the minimum fee in $LAZY');
		console.log('		<decrement> is the decrement amount');
		console.log('		<interval> is the decrement interval (seconds)');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
	const startTimestamp = parseInt(args[1]);
	const minFee = parseInt(args[2]);
	const decrement = parseInt(args[3]);
	const interval = parseInt(args[4]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Using Start:', startTimestamp, '->', new Date(startTimestamp * 1000).toISOString());
	console.log('\n-Using Min:', minFee / 10 ** LAZY_DECIMALS, '$LAZY');
	console.log('\n-Using Decrement:', decrement / 10 ** LAZY_DECIMALS, '$LAZY');
	console.log('\n-Using Interval:', interval, 'seconds / ', interval / 60, 'minutes / ', interval / 60 / 60, 'hours / ', interval / 60 / 60 / 24, 'days');

	// import ABI
	const missionJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const missionIface = new ethers.Interface(missionJSON.abi);


	const proceed = readlineSync.keyInYNStrict('Do you want to add decreasing entry cost to the mission?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	const result = await contractExecuteFunction(
		contractId,
		missionIface,
		client,
		500_000,
		'setDecreasingEntryFee',
		[startTimestamp, minFee, decrement, interval],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error setting up dutch auction:', result);
		return;
	}

	console.log('Dutch Auction Engaged. Transaction ID:', result[2]?.transactionId?.toString());
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
