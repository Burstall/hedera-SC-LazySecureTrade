const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');
const readlineSync = require('readline-sync');

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

const contractName = 'MissionFactory';

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
	if (args.length != 4 || getArgFlag('h')) {
		console.log('Usage: transferFundsFromMissionFactory.js 0.0.MMMM 0.0.TTTT [hbar|lazy] <amount>');
		console.log('       MMMM is the mission factory address');
		console.log('       TTTT is the receiver address');
		console.log('       hbar or lazy is the transfer type');
		console.log('       amount is the amount to transfer in hbar or lazy');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
	const recAddress = AccountId.fromString(args[1]);
	let method;
	let amount;
	if (args[2].toLowerCase() == 'hbar') {
		method = 'transferHbar';
		amount = new Hbar(parseInt(args[3]), HbarUnit.Hbar).toTinybars();
	}
	else if (args[2].toLowerCase() == 'lazy') {
		method = 'retrieveLazy';
		amount = Math.floor(parseInt(args[3]) * Math.pow(10, LAZY_DECIMALS));
	}
	else {
		console.log('Usage: transferFundsFromMissionFactory.js 0.0.MMMM 0.0.TTTT [hbar|lazy] <amount>');
		console.log(args[2], 'is not a valid action');
		return;
	}


	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Receiver:', recAddress.toString());
	console.log('\n-Amount:', parseInt(args[3]));
	console.log('\n-Action:', method);

	const proceed = readlineSync.keyInYNStrict('Do you want to transfer funds?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	// import ABI
	const missionJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const missionFactoryIface = new ethers.Interface(missionJSON.abi);


	// deployMission
	const result = await contractExecuteFunction(
		contractId,
		missionFactoryIface,
		client,
		null,
		method,
		[
			recAddress.toSolidityAddress(),
			amount,
		],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.error('ERROR: Transaction failed', result);
		return;
	}

	console.log('Transfer Executed - Tx Id:', result[2].transactionId.toString());

};


main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
