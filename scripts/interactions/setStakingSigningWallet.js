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
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');

// Get operator from .env file
let operatorKey;
let operatorId;
let signingKey;
try {
	operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	// EDCSA key - ED25519 key is not supported
	signingKey = PrivateKey.fromStringECDSA(process.env.SIGNING_KEY);
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
}

const contractName = 'LazyNFTStaking';

const env = process.env.ENVIRONMENT ?? null;

let client;

const main = async () => {
	// configure the client object
	if (
		operatorKey === undefined ||
		operatorKey == null ||
		operatorId === undefined ||
		operatorId == null ||
		signingKey === undefined ||
		signingKey == null
	) {
		console.log(
			'Environment required, please specify PRIVATE_KEY & ACCOUNT_ID & SIGNING_KEY in the .env file',
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
	if (args.length != 1 || getArgFlag('h')) {
		console.log('Usage: setStakingSigningWallet.js 0.0.SSS');
		console.log('		0.0.SSS is the LazyNFTStaking contract to update');
		console.log('		expect SIGNING_KEY to be set in .env');
		return;
	}

	const contractId = ContractId.fromString(args[0]);

	console.log('\n-**SETTING STAKING BURN PERCENTAGE**');

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Using new signing key: ', signingKey.publicKey.toEvmAddress(), '(Public key!)');

	// import ABI
	const lnsJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lnsIface = new ethers.Interface(lnsJSON.abi);

	// get the old systemWallet from Mirror Node
	const encodedCommand = lnsIface.encodeFunctionData(
		'systemWallet',
		[],
	);

	const osw = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
	);

	const oldSystemWallet = lnsIface.decodeFunctionResult('burnPercentage', osw);

	console.log('\n-Old System Wallet (signing public key):', oldSystemWallet[0].toString());


	const proceed = readlineSync.keyInYNStrict('Do you want to update the System Signing Wallet?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}


	const result = await contractExecuteFunction(
		contractId,
		lnsIface,
		client,
		null,
		'setSystemWallet',
		[signingKey.publicKey.toEvmAddress()],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error setting new system wallet:', result);
		return;
	}

	console.log('System Wallet updated. Transaction ID:', result[2]?.transactionId?.toString());

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
