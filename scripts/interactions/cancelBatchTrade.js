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
		console.log('Usage: cancelBatchTrade.js 0.0.LST <batchId>');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		batchId is the bytes32 batch trade ID to cancel');
		console.log('		Example: cancelBatchTrade.js 0.0.123456 0xabc123...');
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
	const batchId = args[1];

	if (!isBytes32(batchId)) {
		console.log('ERROR: Invalid batch ID format - must be bytes32');
		return;
	}

	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using LST Contract:', contractId.toString());
	console.log('\n-Batch ID:', batchId);

	// Get batch trade details
	console.log('\n=== Fetching Batch Trade Details ===');
	const eC = lstIface.encodeFunctionData('getBatchTrade', [batchId]);
	const cS = await readOnlyEVMFromMirrorNode(env, contractId, eC, operatorId, false);
	const batchDetails = lstIface.decodeFunctionResult('getBatchTrade', cS)[0];

	// Check if batch exists
	if (batchDetails[0] == ethers.ZeroAddress) {
		console.log('ERROR: Batch trade does not exist');
		return;
	}

	const seller = batchDetails[0];
	const buyer = batchDetails[1];
	const expiryTime = Number(batchDetails[2]);
	const totalTinybarPrice = BigInt(batchDetails[3]);
	const totalLazyPrice = BigInt(batchDetails[4]);
	const items = batchDetails[5];

	console.log('\n=== Batch Trade Details ===');
	console.log(`Seller: ${seller}`);
	console.log(`Buyer: ${buyer}`);
	console.log(`Expiry: ${expiryTime === 0 ? 'No expiry' : new Date(expiryTime * 1000).toISOString()}`);
	console.log(`Total HBAR Price: ${Number(totalTinybarPrice) / 100_000_000} HBAR`);
	console.log(`Total LAZY Price: ${totalLazyPrice} LAZY`);
	console.log(`Number of NFTs: ${items.length}`);

	// Show items details
	console.log('\n=== NFTs in Batch ===');
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const tokenAddr = item[0];
		const serial = Number(item[1]);
		const tinybarPrice = BigInt(item[2]);
		const lazyPrice = BigInt(item[3]);

		const tokenId = TokenId.fromSolidityAddress(tokenAddr);

		console.log(`${i + 1}. Token: ${tokenId.toString()}, Serial: ${serial}, Price: ${Number(tinybarPrice) / 100_000_000} HBAR + ${lazyPrice} LAZY`);
	}

	// Check if user can cancel (only seller can cancel batch trades)
	const isSeller = seller.slice(2).toLowerCase() == operatorId.toSolidityAddress();

	if (!isSeller) {
		console.log('ERROR: Only the seller can cancel a batch trade');
		console.log(`You are: ${operatorId.toSolidityAddress()}`);
		console.log(`Seller is: ${seller}`);
		return;
	}

	console.log('✓ You are the seller - can cancel this batch trade');

	const proceed = readlineSync.keyInYNStrict(`Do you want to cancel this batch trade with ${items.length} NFTs?`);
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	const gas = 400_000 + (items.length * 20_000);

	console.log('\n=== Cancelling Batch Trade ===');
	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'cancelBatchTrade',
		[batchId],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error cancelling batch trade:', result);
		return;
	}

	console.log('✓ Batch trade cancelled successfully!');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
	console.log(`${items.length} NFTs are now available for individual trading or new batch trades`);
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});