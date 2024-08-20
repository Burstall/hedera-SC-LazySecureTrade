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
	if (args.length != 2 || getArgFlag('h')) {
		console.log('Usage: cancelTrade.js 0.0.LST [-i | <hash>');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		-i to interactively to enter token/serial to obtain hash');
		console.log('		<hash> is the hash of the trade (token/serial)');
		return;
	}

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());

	// import ABI
	const lstJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lstIface = new ethers.Interface(lstJSON.abi);

	const contractId = ContractId.fromString(args[0]);

	let hash, token, serial;

	if (getArgFlag('i')) {
		// interactively get the token and serial


		// ask the user for the token to sell
		const tokenToCancel = readlineSync.question('Enter the token to cancel: ');
		const serialToCancel = readlineSync.question('Enter the serial number: ');

		token = TokenId.fromString(tokenToCancel);
		serial = parseInt(serialToCancel);

		console.log('\n-Using Token:', token.toString());
		console.log('\n-Using Serial:', serial);

		console.log('\n\t...fetching trade details for token:', token.toString(), 'serial:', serial);

		hash = ethers.solidityPackedKeccak256(['address', 'uint256'], [token.toSolidityAddress(), serial]);
	}
	else {
		hash = args[1];

		if (!isBytes32(hash)) {
			throw new Error('Invalid hash: must be a bytes32 string');
		}
	}

	console.log('\n-Using Hash:', hash);

	const eC = lstIface.encodeFunctionData(
		'getTrade',
		[hash],
	);

	const cS = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		eC,
		operatorId,
		false,
	);

	const tradeDets = lstIface.decodeFunctionResult('getTrade', cS)[0];

	// check if the trade exists [seller <> ZeroAddress]
	if (tradeDets[0] == ethers.ZeroAddress) {
		console.log('Trade does not exist - exiting');
		return;
	}

	console.log('\n-Trade Details:', tradeDets);

	// check if user is seller or buyer
	const isSeller = tradeDets[0].slice(2).toLowerCase() == operatorId.toSolidityAddress();
	const isBuyer = tradeDets[1].slice(2).toLowerCase() == operatorId.toSolidityAddress();

	if (!isSeller && !isBuyer) {
		console.log('ERROR: Operator is not the seller or buyer - unable to cancel - exiting');
		return;
	}


	const proceed = readlineSync.keyInYNStrict('Do you want to cancel the trade?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}


	const gas = 300_000;

	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'cancelTrade',
		[
			hash,
		],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error cancelling trade:', result);
		return;
	}

	console.log('Trade Cancelled. Transaction ID:', result[2]?.transactionId?.toString());
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
