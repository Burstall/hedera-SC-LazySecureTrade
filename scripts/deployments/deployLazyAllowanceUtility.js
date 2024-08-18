const {
	Client,
	AccountId,
	PrivateKey,
} = require('@hashgraph/sdk');
const fs = require('fs');
const readlineSync = require('readline-sync');
const { contractDeployFunction } = require('../../utils/solidityHelpers');

require('dotenv').config();

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
const lazyAllowanceUtilName = 'LazyAllowanceUtility';

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

	console.log('\n-Using ENIVRONMENT:', env);

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
	// deploy the contract
	console.log('\n-Using Operator:', operatorId.toString());

	const lazyJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${lazyAllowanceUtilName}.sol/${lazyAllowanceUtilName}.json`,
		),
	);

	const proceed = readlineSync.keyInYNStrict('Do you want to deploy the Lazy Allowance Utility?');

	if (!proceed) {
		console.log('Aborting');
		return;
	}

	const gasLimit = 1_800_000;
	console.log(
		'\n- Deploying contract...',
		lazyAllowanceUtilName,
		'\n\tgas@',
		gasLimit,
	);

	const lazyBytecode = lazyJson.bytecode;


	const [lazyUtilId] = await contractDeployFunction(
		client,
		lazyBytecode,
		gasLimit,
	);

	console.log(
		`Lazy Allowance Utility contract created with ID: ${lazyUtilId} / ${lazyUtilId.toSolidityAddress()}`,
	);
};


main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
