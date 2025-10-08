const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	HbarUnit,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag, isBytes32 } = require('../../utils/nodeHelpers');
const { checkMirrorBalance, checkMirrorHbarBalance } = require('../../utils/hederaMirrorHelpers');
const { setFTAllowance, setHbarAllowance, associateTokenToAccount } = require('../../utils/hederaHelpers');

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
const LAZY_TOKEN_ID = process.env.LAZY_TOKEN_ID;

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

	if (!LAZY_TOKEN_ID) {
		console.log('ERROR: Must specify LAZY_TOKEN_ID in the .env file');
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
		console.log('Usage: executeBatchTrade.js 0.0.LST <batchId>');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		batchId is the bytes32 batch trade ID to execute');
		console.log('		Example: executeBatchTrade.js 0.0.123456 0xabc123...');
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
	const uniqueTokens = new Set();
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const tokenAddr = item[0];
		const serial = Number(item[1]);
		const tinybarPrice = BigInt(item[2]);
		const lazyPrice = BigInt(item[3]);

		const tokenId = TokenId.fromSolidityAddress(tokenAddr);
		uniqueTokens.add(tokenAddr);

		console.log(`${i + 1}. Token: ${tokenId.toString()}, Serial: ${serial}, Price: ${Number(tinybarPrice) / 100_000_000} HBAR + ${lazyPrice} LAZY`);
	}

	// Check if user can execute
	const isBuyer = buyer.slice(2).toLowerCase() == operatorId.toSolidityAddress();
	const isOpenTrade = buyer == ethers.ZeroAddress;

	if (!isBuyer && !isOpenTrade) {
		console.log('ERROR: You are not the buyer for this batch trade and it\'s not an open trade');
		return;
	}

	// Check expiry
	if (expiryTime !== 0 && Math.floor(Date.now() / 1000) > expiryTime) {
		console.log('ERROR: Batch trade has expired');
		return;
	}

	console.log('\n=== Checking Balances and Setting Allowances ===');

	// Check HBAR balance and set allowance
	if (totalTinybarPrice > 0) {
		const hbarBalance = await checkMirrorHbarBalance(operatorId.toString());
		console.log(`Current HBAR balance: ${hbarBalance / 100_000_000} HBAR`);

		if (BigInt(hbarBalance) < totalTinybarPrice) {
			console.log('ERROR: Insufficient HBAR balance');
			return;
		}

		const hbarAllowanceNeeded = Number(totalTinybarPrice) / 100_000_000;
		console.log(`Setting HBAR allowance for ${hbarAllowanceNeeded} HBAR...`);

		await setHbarAllowance(client, operatorId, contractId, hbarAllowanceNeeded, HbarUnit.Hbar);
		console.log('✓ HBAR allowance set');
	}

	// Check LAZY balance and set allowance
	if (totalLazyPrice > 0) {
		const lazyBalance = await checkMirrorBalance(operatorId.toString(), LAZY_TOKEN_ID);
		console.log(`Current LAZY balance: ${lazyBalance} LAZY`);

		if (BigInt(lazyBalance) < totalLazyPrice) {
			console.log('ERROR: Insufficient LAZY balance');
			return;
		}

		console.log(`Setting LAZY allowance for ${totalLazyPrice} LAZY...`);
		await setFTAllowance(client, TokenId.fromString(LAZY_TOKEN_ID), operatorId, contractId, Number(totalLazyPrice));
		console.log('✓ LAZY allowance set');
	}

	// Associate tokens
	console.log('\n=== Associating Tokens ===');
	for (const tokenAddr of uniqueTokens) {
		try {
			const tokenId = TokenId.fromSolidityAddress(tokenAddr);
			console.log(`Associating token ${tokenId.toString()}...`);
			await associateTokenToAccount(client, operatorId, operatorKey, [tokenId]);
			console.log(`✓ Token ${tokenId.toString()} associated`);
		}
		catch (error) {
			console.log(`Note: Token association may have failed (probably already associated): ${error.message}`);
		}
	}

	console.log('\n=== Final Summary ===');
	console.log(`You will receive ${items.length} NFTs from ${uniqueTokens.size} different collections`);
	console.log(`Total cost: ${Number(totalTinybarPrice) / 100_000_000} HBAR + ${totalLazyPrice} LAZY`);

	const proceed = readlineSync.keyInYNStrict('Do you want to execute this batch trade?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	const gas = 1_000_000 + (items.length * 80_000);
	console.log(`\nUsing gas limit: ${gas}`);

	console.log('\n=== Executing Batch Trade ===');
	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'executeBatchTrade',
		[batchId],
		Number(totalTinybarPrice),
		HbarUnit.Tinybar,
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error executing batch trade:', result);
		return;
	}

	console.log('✓ Batch trade executed successfully!');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
	console.log(`You received ${items.length} NFTs for ${Number(totalTinybarPrice) / 100_000_000} HBAR + ${totalLazyPrice} LAZY`);
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});