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
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
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
	if (args.length < 1 || args.length > 2 || getArgFlag('h')) {
		console.log('Usage: getUserBatchTrades.js 0.0.LST [userAddress]');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		userAddress is optional - if not provided, uses operator address');
		console.log('		Example: getUserBatchTrades.js 0.0.123456');
		console.log('		Example: getUserBatchTrades.js 0.0.123456 0.0.654321');
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

	let userAddress;
	if (args.length === 2) {
		const userId = AccountId.fromString(args[1]);
		userAddress = userId.toSolidityAddress();
	}
	else {
		userAddress = operatorId.toSolidityAddress();
	}

	console.log('\n-Using LST Contract:', contractId.toString());
	console.log('-Querying batch trades for user:', userAddress);

	// Get user's batch trades
	console.log('\n=== Fetching User Batch Trades ===');
	const eC = lstIface.encodeFunctionData('getUserBatchTrades', [userAddress]);
	const cS = await readOnlyEVMFromMirrorNode(env, contractId, eC, operatorId, false);
	const batchTrades = lstIface.decodeFunctionResult('getUserBatchTrades', cS)[0];

	if (batchTrades.length === 0) {
		console.log('No batch trades found for this user');
		return;
	}

	console.log(`Found ${batchTrades.length} batch trade(s)`);

	// Display each batch trade
	for (let i = 0; i < batchTrades.length; i++) {
		const batch = batchTrades[i];
		const batchId = batch[0];
		const batchDetails = batch[1];

		console.log(`\n${'='.repeat(60)}`);
		console.log(`BATCH TRADE ${i + 1} of ${batchTrades.length}`);
		console.log(`${'='.repeat(60)}`);

		displayBatchTrade(batchId, batchDetails);
	}

	// Summary
	console.log(`\n${'='.repeat(60)}`);
	console.log('SUMMARY');
	console.log(`${'='.repeat(60)}`);

	let totalNFTs = 0;
	let totalHbarValue = 0n;
	let totalLazyValue = 0n;
	let activeBatches = 0;
	let expiredBatches = 0;

	for (const batch of batchTrades) {
		const batchDetails = batch[1];
		const expiryTime = Number(batchDetails[2]);
		const totalTinybarPrice = BigInt(batchDetails[3]);
		const totalLazyPrice = BigInt(batchDetails[4]);
		const items = batchDetails[5];

		totalNFTs += items.length;
		totalHbarValue += totalTinybarPrice;
		totalLazyValue += totalLazyPrice;

		if (expiryTime !== 0 && Math.floor(Date.now() / 1000) > expiryTime) {
			expiredBatches++;
		}
		else {
			activeBatches++;
		}
	}

	console.log(`Total Batch Trades: ${batchTrades.length}`);
	console.log(`Active Batches: ${activeBatches}`);
	console.log(`Expired Batches: ${expiredBatches}`);
	console.log(`Total NFTs Listed: ${totalNFTs}`);
	console.log(`Total HBAR Value: ${Number(totalHbarValue) / 100_000_000} HBAR`);
	console.log(`Total LAZY Value: ${totalLazyValue} LAZY`);
};

function displayBatchTrade(batchId, batchDetails) {
	const seller = batchDetails[0];
	const buyer = batchDetails[1];
	const expiryTime = Number(batchDetails[2]);
	const totalTinybarPrice = BigInt(batchDetails[3]);
	const totalLazyPrice = BigInt(batchDetails[4]);
	const items = batchDetails[5];

	const isExpired = expiryTime !== 0 && Math.floor(Date.now() / 1000) > expiryTime;
	const statusIcon = isExpired ? '❌' : '✅';
	const statusText = isExpired ? 'EXPIRED' : 'Active';

	console.log(`Batch ID: ${batchId}`);
	console.log(`Status: ${statusIcon} ${statusText}`);
	console.log(`Seller: ${seller}`);
	console.log(`Buyer: ${buyer === ethers.ZeroAddress ? 'Open market (anyone can buy)' : buyer}`);
	console.log(`Expiry: ${expiryTime === 0 ? 'No expiry' : new Date(expiryTime * 1000).toISOString()}`);
	console.log(`Total Price: ${Number(totalTinybarPrice) / 100_000_000} HBAR + ${totalLazyPrice} LAZY`);
	console.log(`NFT Count: ${items.length}`);

	if (items.length > 0) {
		console.log('\n📦 NFTs in this batch:');
		const tokenGroups = {};

		// Group by token for better display
		for (const item of items) {
			const tokenAddr = item[0];
			const serial = Number(item[1]);
			const tinybarPrice = BigInt(item[2]);
			const lazyPrice = BigInt(item[3]);

			if (!tokenGroups[tokenAddr]) {
				tokenGroups[tokenAddr] = [];
			}

			tokenGroups[tokenAddr].push({
				serial,
				hbarPrice: Number(tinybarPrice) / 100_000_000,
				lazyPrice: Number(lazyPrice),
			});
		}

		for (const [tokenAddr, tokenItems] of Object.entries(tokenGroups)) {
			const tokenId = TokenId.fromSolidityAddress(tokenAddr);
			console.log(`\n  📄 ${tokenId.toString()}:`);

			for (const item of tokenItems) {
				console.log(`     Serial #${item.serial}: ${item.hbarPrice} HBAR + ${item.lazyPrice} LAZY`);
			}
		}
	}
}

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});