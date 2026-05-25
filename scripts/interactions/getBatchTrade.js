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
		console.log('Usage: getBatchTrade.js 0.0.LST <batchId> [batchId2 ...]');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		batchId is the bytes32 batch trade ID to query');
		console.log('		Multiple batch IDs can be provided for batch query');
		console.log('		Example: getBatchTrade.js 0.0.123456 0xabc123...');
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
	const batchIds = args.slice(1);

	// Validate batch IDs
	for (const batchId of batchIds) {
		if (!isBytes32(batchId)) {
			console.log(`ERROR: Invalid batch ID format: ${batchId}`);
			return;
		}
	}

	console.log('\n-Using LST Contract:', contractId.toString());
	console.log(`-Querying ${batchIds.length} batch trade(s)`);

	if (batchIds.length === 1) {
		// Single batch query
		const batchId = batchIds[0];
		console.log('\n=== Batch Trade Details ===');

		const eC = lstIface.encodeFunctionData('getBatchTrade', [batchId]);
		const cS = await readOnlyEVMFromMirrorNode(env, contractId, eC, operatorId, false);
		const batchDetails = lstIface.decodeFunctionResult('getBatchTrade', cS)[0];

		if (batchDetails[0] == ethers.ZeroAddress) {
			console.log('ERROR: Batch trade does not exist');
			return;
		}

		displayBatchTrade(batchId, batchDetails);
	}
	else {
		// Multiple batch query — loops single-batch reads because
		// the batched `getBatchTrades(bytes32[])` view was removed in
		// v0.3 to free LST bytecode. Mirror-node reads cost the same
		// either way.
		console.log('\n=== Multiple Batch Trades Query ===');

		for (let i = 0; i < batchIds.length; i++) {
			const batchId = batchIds[i];
			const eC = lstIface.encodeFunctionData('getBatchTrade', [batchId]);
			const cS = await readOnlyEVMFromMirrorNode(env, contractId, eC, operatorId, false);
			const batchDetails = lstIface.decodeFunctionResult('getBatchTrade', cS)[0];

			console.log(`\n--- Batch Trade ${i + 1} (ID: ${batchId}) ---`);

			if (batchDetails[0] == ethers.ZeroAddress) {
				console.log('❌ Batch trade does not exist');
				continue;
			}

			displayBatchTrade(batchId, batchDetails);
		}
	}
};

function displayBatchTrade(batchId, batchDetails) {
	const seller = batchDetails[0];
	const buyer = batchDetails[1];
	const expiryTime = Number(batchDetails[2]);
	const totalTinybarPrice = BigInt(batchDetails[3]);
	const totalLazyPrice = BigInt(batchDetails[4]);
	const items = batchDetails[5];

	console.log(`Batch ID: ${batchId}`);
	console.log(`Seller: ${seller}`);
	console.log(`Buyer: ${buyer === ethers.ZeroAddress ? 'Open market (anyone)' : buyer}`);
	console.log(`Status: ${expiryTime !== 0 && Math.floor(Date.now() / 1000) > expiryTime ? '❌ EXPIRED' : '✅ Active'}`);
	console.log(`Expiry: ${expiryTime === 0 ? 'No expiry' : new Date(expiryTime * 1000).toISOString()}`);
	console.log(`Total HBAR Price: ${Number(totalTinybarPrice) / 100_000_000} HBAR`);
	console.log(`Total LAZY Price: ${totalLazyPrice} LAZY`);
	console.log(`Number of NFTs: ${items.length}`);

	if (items.length > 0) {
		console.log('\n📦 NFTs in Batch:');
		const tokenGroups = {};

		// Group by token for better display
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
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

		let itemNum = 1;
		for (const [tokenAddr, tokenItems] of Object.entries(tokenGroups)) {
			const tokenId = TokenId.fromSolidityAddress(tokenAddr);
			console.log(`\n  ${tokenId.toString()}:`);

			for (const item of tokenItems) {
				console.log(`    ${itemNum}. Serial ${item.serial}: ${item.hbarPrice} HBAR + ${item.lazyPrice} LAZY`);
				itemNum++;
			}
		}
	}

	// Calculate individual vs batch savings
	if (items.length > 1) {
		console.log('\n💡 Batch Benefits:');
		console.log(`   • All ${items.length} NFTs must be bought together (atomic)`);
		console.log('   • Single transaction reduces gas costs');
		console.log('   • Single payment simplifies the purchase process');
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